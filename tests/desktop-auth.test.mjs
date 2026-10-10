import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AuthStore } from '../desktop/auth.mjs';
import { isAuthSender } from '../desktop/auth-window.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-auth-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

const errorCode = (code) => (error) => error.code === code;

await test('默认无密码；未经初始化的锁不会误报为已关闭', async (t) => {
  const root = await fixture(t);
  const auth = new AuthStore(root);
  assert.equal(auth.enabled, true);
  await assert.rejects(
    () => auth.verify('anything'),
    errorCode('AUTH_NOT_READY'),
  );
  assert.equal(await auth.init(), auth);
  assert.equal(auth.enabled, false);
  assert.equal(await auth.verify(''), true);
  assert.equal(await auth.setPassword('', ''), true);
  assert.equal((await new AuthStore(root).init()).enabled, false);
});

await test('随机盐与 scrypt 验证；错误密码不通过，重启后保留密码锁', async (t) => {
  const root = await fixture(t);
  const auth = await new AuthStore(root).init();
  assert.equal(await auth.setPassword('', 'a safe password 测试'), true);
  assert.equal(auth.enabled, true);
  const raw = await fs.readFile(path.join(root, '.app-lock.json'), 'utf8');
  const config = JSON.parse(raw);
  assert.equal(raw.includes('a safe password'), false);
  assert.equal(config.algorithm, 'scrypt-N32768-r8-p1');
  assert.match(config.salt, /^[a-f0-9]{64}$/);
  assert.match(config.hash, /^[a-f0-9]{128}$/);
  assert.equal(await auth.verify('wrong'), false);
  assert.equal(await auth.verify('a safe password 测试'), true);
  const reopened = await new AuthStore(root).init();
  assert.equal(reopened.enabled, true);
  assert.equal(await reopened.verify('wrong'), false);
  assert.equal(await reopened.verify('a safe password 测试'), true);
  const other = await new AuthStore(await fixture(t)).init();
  await other.setPassword('', 'a safe password 测试');
  await auth.setPassword('a safe password 测试', 'a safe password 测试');
  const rotated = JSON.parse(
    await fs.readFile(path.join(root, '.app-lock.json'), 'utf8'),
  );
  assert.notEqual(config.salt, rotated.salt);
  assert.notEqual(config.hash, rotated.hash);
  if (process.platform !== 'win32') {
    assert.equal(
      (await fs.stat(path.join(root, '.app-lock.json'))).mode & 0o777,
      0o600,
    );
  }
});

await test('改密和关闭密码均要求当前密码；失败不会更改已保存配置', async (t) => {
  const root = await fixture(t);
  const auth = await new AuthStore(root).init();
  await auth.setPassword('', 'old password');
  const before = await fs.readFile(path.join(root, '.app-lock.json'), 'utf8');
  await assert.rejects(
    () => auth.setPassword('wrong', 'new password'),
    errorCode('INVALID_CURRENT_PASSWORD'),
  );
  await assert.rejects(
    () => auth.setPassword('', ''),
    errorCode('INVALID_CURRENT_PASSWORD'),
  );
  assert.equal(
    await fs.readFile(path.join(root, '.app-lock.json'), 'utf8'),
    before,
  );
  await auth.setPassword('old password', 'new password');
  assert.equal(await auth.verify('old password'), false);
  assert.equal(await auth.verify('new password'), true);
  await auth.setPassword('new password', '');
  assert.equal(auth.enabled, false);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(root, '.app-lock.json'), 'utf8')),
    { schemaVersion: 1, enabled: false },
  );
  assert.equal((await new AuthStore(root).init()).enabled, false);
});

await test('密码原样匹配且限制字符数、字节数和参数类型', async (t) => {
  const auth = await new AuthStore(await fixture(t)).init();
  for (const password of [
    '1234567',
    '密'.repeat(342),
    'a'.repeat(1025),
    null,
    {},
    12345678,
  ]) {
    await assert.rejects(
      () => auth.setPassword('', password),
      errorCode('INVALID_PASSWORD'),
    );
  }
  await auth.setPassword('', ' spaced password ');
  assert.equal(await auth.verify('spaced password'), false);
  assert.equal(await auth.verify(' spaced password '), true);
  await assert.rejects(
    () => auth.verify('a'.repeat(1025)),
    errorCode('INVALID_PASSWORD'),
  );
  await assert.rejects(() => auth.verify({}), errorCode('INVALID_PASSWORD'));
});

await test('损坏、截断、类型错误、过大或非文件配置均阻止启动且不覆盖', async (t) => {
  const invalid = [
    '',
    '{',
    'null',
    '[]',
    '{}',
    '{"schemaVersion":1,"enabled":"false"}',
    '{"schemaVersion":9,"enabled":false}',
    '{"schemaVersion":1,"enabled":false,"hash":"leftover"}',
    '{"schemaVersion":1,"enabled":true}',
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      algorithm: 'scrypt-N32768-r8-p1',
      salt: '0'.repeat(64),
      hash: 'z'.repeat(128),
    }),
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      algorithm: 'scrypt-N999999999-r8-p1',
      salt: '0'.repeat(64),
      hash: '0'.repeat(128),
    }),
    ' '.repeat(8193),
  ];
  for (const contents of invalid) {
    const root = await fixture(t);
    const filename = path.join(root, '.app-lock.json');
    await fs.writeFile(filename, contents);
    const auth = new AuthStore(root);
    await assert.rejects(() => auth.init(), errorCode('AUTH_CONFIG_INVALID'));
    assert.equal(auth.enabled, true);
    await assert.rejects(() => auth.verify(''), errorCode('AUTH_NOT_READY'));
    await assert.rejects(
      () => auth.setPassword('', ''),
      errorCode('AUTH_NOT_READY'),
    );
    assert.equal(await fs.readFile(filename, 'utf8'), contents);
  }
  const root = await fixture(t);
  await fs.mkdir(path.join(root, '.app-lock.json'));
  await assert.rejects(
    () => new AuthStore(root).init(),
    errorCode('AUTH_CONFIG_INVALID'),
  );
});

await test('写入失败保留内存中的密码要求并清理临时文件', async (t) => {
  const root = await fixture(t);
  const auth = await new AuthStore(root).init();
  await auth.setPassword('', 'old password');
  const filename = path.join(root, '.app-lock.json');
  await fs.rename(filename, filename + '.saved');
  await fs.mkdir(filename);
  await assert.rejects(
    () => auth.setPassword('old password', ''),
    errorCode('AUTH_WRITE_FAILED'),
  );
  assert.equal(auth.enabled, true);
  assert.equal(await auth.verify('old password'), true);
  assert.deepEqual((await fs.readdir(root)).sort(), [
    '.app-lock.json',
    '.app-lock.json.saved',
  ]);
});

await test('并发改密按顺序验证，旧密码不可重复改密；scrypt 不阻塞事件循环', async (t) => {
  const auth = await new AuthStore(await fixture(t)).init();
  let immediateRan = false;
  const immediate = new Promise((resolve) =>
    setImmediate(() => {
      immediateRan = true;
      resolve();
    }),
  );
  await auth.setPassword('', 'first password');
  assert.equal(immediateRan, true);
  await immediate;
  const first = auth.setPassword('first password', 'second password');
  const second = auth.setPassword('first password', 'third password');
  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'INVALID_CURRENT_PASSWORD');
  assert.equal(await auth.verify('second password'), true);
});

await test('连续错误后短暂退避，等待后可以正确解锁', async (t) => {
  const auth = await new AuthStore(await fixture(t)).init();
  await auth.setPassword('', 'correct password');
  for (let i = 0; i < 3; i++) assert.equal(await auth.verify('wrong'), false);
  await assert.rejects(
    () => auth.verify('correct password'),
    (error) =>
      error.code === 'AUTH_RETRY_LATER' &&
      error.retryAfterMs > 0 &&
      error.retryAfterMs <= 1000,
  );
  await assert.rejects(
    () => auth.setPassword('correct password', ''),
    errorCode('AUTH_RETRY_LATER'),
  );
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.equal(await auth.verify('correct password'), true);
  assert.equal(await auth.verify('correct password'), true);
});

await test('应用锁 IPC 仅接受指定窗口及指定文件的主 frame', () => {
  const url = 'file:///app/desktop/auth.html';
  const frame = { url };
  const contents = { mainFrame: frame };
  const window = { webContents: contents, isDestroyed: () => false };
  const event = { sender: contents, senderFrame: frame };
  assert.equal(isAuthSender(event, window, url), true);
  assert.equal(isAuthSender({ ...event, sender: {} }, window, url), false);
  assert.equal(
    isAuthSender({ ...event, senderFrame: { url } }, window, url),
    false,
  );
  assert.equal(
    isAuthSender(event, { ...window, isDestroyed: () => true }, url),
    false,
  );
  assert.equal(isAuthSender(event, undefined, url), false);
  frame.url = 'https://evil.example';
  assert.equal(isAuthSender(event, window, url), false);
  frame.url = url + '?injected=1';
  assert.equal(isAuthSender(event, window, url), false);
});

await test('密码页仅允许哈希匹配的本地脚本样式并明确提示未加密', async () => {
  const html = await fs.readFile(
    new URL('../desktop/auth.html', import.meta.url),
    'utf8',
  );
  const policy = html.match(
    /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/,
  )[1];
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /connect-src 'none'/);
  assert.equal(policy.includes('unsafe-inline'), false);
  for (const tag of ['script', 'style']) {
    const content = html.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))[1];
    const hash = createHash('sha256').update(content).digest('base64');
    assert.equal(
      policy.includes(`'sha256-${hash}'`),
      true,
      `${tag} hash must match after edits`,
    );
  }
  assert.match(html, /不会加密资料/);
  assert.match(html, /JSON\s+交易记录、截图、周报和备份仍以明文/);
  assert.match(html, /绕过应用锁/);
});
