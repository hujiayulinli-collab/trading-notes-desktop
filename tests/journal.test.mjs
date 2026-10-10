import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  newTrade,
  stats,
  validateRecords,
  reviewPrompt,
  formatR,
} from '../lib/journal.ts';
import { JournalStore } from '../server/storage.mjs';
import { createApp, analyze } from '../server/index.mjs';
import sharp from 'sharp';

const resultsRoot = path.resolve('test-results');
await fs.mkdir(resultsRoot, { recursive: true });
const fixture = async () => fs.mkdtemp(path.join(resultsRoot, 'journal-'));
const png = await sharp({
  create: { width: 4, height: 4, channels: 3, background: '#345c48' },
})
  .png()
  .toBuffer();
const sample = (r = 1, extra = {}) => ({
  ...newTrade(),
  symbol: 'XAUUSD',
  status: 'closed',
  resultR: r,
  riskPercent: 1,
  ...extra,
});

void test('统计排除持仓/观察/缺 R，保本计入胜率，未评价不默认为守纪律', () => {
  const records = [
    sample(2, { discipline: 'yes' }),
    sample(-1, { discipline: 'no' }),
    sample(0, { discipline: 'yes' }),
    sample(1),
    sample(-1, { discipline: 'yes' }),
    sample(3, { discipline: 'yes' }),
    sample(null, { status: 'open', discipline: 'yes' }),
    sample(null, { status: 'observing' }),
    sample(null),
  ];
  const s = stats(records);
  assert.equal(s.closed, 6);
  assert.equal(s.open, 1);
  assert.equal(s.observing, 1);
  assert.equal(s.incomplete, 1);
  assert.equal(s.winRate, 50);
  assert.equal(s.sumR, 4);
  assert.equal(s.expectancy, 4 / 6);
  assert.equal(s.disciplineRate, 80);
  assert.equal(s.payoff, 2);
  assert.equal(s.profitFactor, 3);
});
void test('空样本、全部保本、全赢、全亏与负零', () => {
  assert.equal(stats([]).winRate, null);
  assert.equal(stats([]).expectancy, null);
  assert.equal(stats([sample(0)]).winRate, 0);
  assert.equal(stats([sample(2)]).payoff, null);
  assert.equal(stats([sample(-1)]).winRate, 0);
  assert.equal(formatR(-0), '0.0');
});
void test('严格拒绝非法日期、重复ID、数字字符串、非有限数字和持仓结果R', () => {
  for (const patch of [
    { date: '2026-02-30' },
    { time: '25:00' },
    { resultR: '' },
    { resultR: Infinity },
    { riskPercent: 101 },
    { entryAttempt: 1.5 },
    { status: 'open', resultR: 2 },
  ])
    assert.throws(() => validateRecords([sample(1, patch)]));
  const one = sample();
  assert.throws(() => validateRecords([one, one]));
  assert.doesNotThrow(() =>
    validateRecords([sample(1, { tags: ['constructor', '__proto__'] })]),
  );
});
void test('本地写入、截图、完整备份及换电脑恢复保持内容；重复导入跳过', async () => {
  const root = await fixture(),
    store = await new JournalStore(root).init();
  const shot = await store.upload({
    name: '进场.png',
    mime: 'image/png',
    data: png.toString('base64'),
  });
  const trade = sample(2, {
    notes: {
      entry: '等待确认',
      execution: '按计划',
      lessons: '没有追价',
      improvement: '记录止损',
    },
    screenshots: [shot],
    review: {
      text: '这是测试复盘。',
      model: 'gpt-test',
      createdAt: new Date().toISOString(),
      sourceUpdatedAt: new Date().toISOString(),
    },
  });
  await store.save([trade], 0);
  const disk = JSON.parse(
    await fs.readFile(path.join(root, 'data/journal.json'), 'utf8'),
  );
  assert.equal(disk.records[0].notes.entry, '等待确认');
  assert.deepEqual(await fs.readFile(store.assetPath(shot)), png);
  const backup = await store.exportBackup();
  assert.equal(backup.assets.length, 1);
  assert.ok(!JSON.stringify(backup).includes('apiKey'));
  const second = await new JournalStore(await fixture()).init();
  const preview = await second.previewBackup(backup);
  assert.equal(preview.added, 1);
  const imported = await second.importBackup(backup, 0);
  assert.equal(imported.records[0].notes.entry, '等待确认');
  assert.equal(imported.records[0].review.text, '这是测试复盘。');
  assert.deepEqual(
    await fs.readFile(second.assetPath(imported.records[0].screenshots[0])),
    png,
  );
  const repeat = await second.importBackup(backup, imported.revision);
  assert.equal(repeat.added, 0);
  assert.equal(repeat.skipped, 1);
  const reopened = await new JournalStore(root).init();
  assert.equal(reopened.snapshot().records[0].id, trade.id);
});
void test('损坏截图/备份、缺失附件不得污染资料库', async () => {
  const store = await new JournalStore(await fixture()).init();
  await assert.rejects(() =>
    store.upload({ name: '假.png', mime: 'image/png', data: 'iVBORw0KGgo=' }),
  );
  await store.save([sample()], 0);
  const before = JSON.stringify(store.snapshot());
  const backup = await store.exportBackup();
  backup.records[0].date = 'bad-date';
  await assert.rejects(() => store.importBackup(backup, 1));
  assert.equal(JSON.stringify(store.snapshot()), before);
  await assert.rejects(() =>
    store.save(
      [
        sample(1, {
          screenshots: [
            {
              id: 'missing',
              name: '缺失.png',
              mime: 'image/png',
              stage: '入场',
            },
          ],
        }),
      ],
      1,
    ),
  );
  assert.equal(JSON.stringify(store.snapshot()), before);
});
void test('截图校验和被篡改时拒绝恢复', async () => {
  const store = await new JournalStore(await fixture()).init();
  const shot = await store.upload({
    name: 'test.png',
    mime: 'image/png',
    data: png.toString('base64'),
  });
  await store.save([sample(1, { screenshots: [shot] })], 0);
  const backup = await store.exportBackup();
  backup.assets[0].sha256 = 'bad';
  await assert.rejects(() => store.previewBackup(backup), /校验失败/);
});
void test('两个窗口同时保存，过期版本不能覆盖已保存记录', async () => {
  const store = await new JournalStore(await fixture()).init();
  const one = sample(1),
    two = sample(2);
  const result = await Promise.allSettled([
    store.save([one], 0),
    store.save([two], 0),
  ]);
  assert.equal(result[0].status, 'fulfilled');
  assert.equal(result[1].status, 'rejected');
  assert.equal(store.library.records[0].id, one.id);
});
void test('目录迁移保留原资料、切换配置、禁止非空目录及递归目标', async () => {
  const root = await fixture(),
    store = await new JournalStore(root).init();
  await store.save([sample()], 0);
  await store.lock();
  const original = store.directory;
  const target = path.join(root, '新资料库');
  await store.migrate(target, 1);
  assert.equal(store.directory, target);
  assert.ok(await fs.stat(path.join(original, 'journal.json')));
  assert.ok(await fs.stat(path.join(target, '.journal.lock')));
  await assert.rejects(() => store.migrate(path.join(target, 'child'), 1));
  await assert.rejects(() => store.migrate(original, 1));
  await store.unlock();
  const reloaded = await new JournalStore(root).init();
  assert.equal(reloaded.directory, target);
  assert.equal(reloaded.library.records.length, 1);
});
void test('主资料文件丢失时，保护已有恢复文件，不创建空库', async () => {
  const root = await fixture();
  const folder = path.join(root, 'data');
  await fs.mkdir(folder);
  const recovery = { schemaVersion: 1, revision: 2, records: [sample()] };
  await fs.writeFile(
    path.join(folder, 'journal.previous.json'),
    JSON.stringify(recovery),
  );
  await assert.rejects(() => new JournalStore(root).init(), /主资料文件丢失/);
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(path.join(folder, 'journal.previous.json'), 'utf8'),
    ),
    recovery,
  );
  await assert.rejects(() => fs.access(path.join(folder, 'journal.json')));
});
void test('资料库进程锁阻止另一个实例同时使用', async () => {
  const root = await fixture();
  const first = await new JournalStore(root).init();
  const second = await new JournalStore(root).init();
  await first.lock();
  await assert.rejects(() => second.lock(), /另一个/);
  await first.unlock();
  await second.lock();
  await second.unlock();
});
void test('磁盘被外部修改时不覆盖', async () => {
  const root = await fixture(),
    store = await new JournalStore(root).init();
  const altered = { schemaVersion: 1, revision: 3, records: [sample(9)] };
  await fs.writeFile(
    path.join(root, 'data/journal.json'),
    JSON.stringify(altered),
  );
  await assert.rejects(() => store.save([sample(2)], 0), /其他程序修改/);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(root, 'data/journal.json'), 'utf8'))
      .records[0].resultR,
    9,
  );
});
void test('HTTP 新建/截图/备份流与来源访问控制', async (t) => {
  const root = await fixture(),
    app = await createApp({ root });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const bad = await fetch(base + '/api/journal', {
    headers: { Origin: 'https://untrusted.example' },
  });
  assert.equal(bad.status, 403);
  const raw = await fetch(base + '/api/journal', { method: 'PUT', body: '{}' });
  assert.equal(raw.status, 415);
  const shotResponse = await fetch(base + '/api/screenshots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '入场.png',
      mime: 'image/png',
      data: png.toString('base64'),
    }),
  });
  assert.equal(shotResponse.status, 201);
  const shot = await shotResponse.json();
  const record = sample(2, { screenshots: [shot] });
  const save = await fetch(base + '/api/journal', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: [record], revision: 0 }),
  });
  assert.equal(save.status, 200);
  const image = await fetch(base + `/api/screenshots/${shot.id}`);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  const backup = await (await fetch(base + '/api/backup')).json();
  assert.equal(backup.records.length, 1);
  assert.equal(backup.assets.length, 1);
});
void test('GPT 请求构造遵守事实范围；密钥只用于认证，关闭响应存储', async () => {
  const store = await new JournalStore(await fixture()).init();
  const shot = await store.upload({
    name: '入场.png',
    mime: 'image/png',
    data: png.toString('base64'),
  });
  const record = sample(1, { screenshots: [shot] });
  let captured;
  const result = await analyze(
    {
      apiKey: 'sk-test-not-a-real-key',
      model: 'gpt-5.4-mini',
      records: [record],
      includeImages: true,
    },
    store,
    async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return new Response(
        JSON.stringify({
          status: 'completed',
          model: 'gpt-5.4-mini',
          output: [
            {
              content: [
                { type: 'output_text', text: '基于测试数据的模拟回复' },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    },
  );
  assert.equal(result.sourceUpdatedAt, record.updatedAt);
  assert.equal(captured.url, 'https://api.openai.com/v1/responses');
  assert.equal(captured.body.store, false);
  assert.equal(
    captured.body.input[0].content.filter((x) => x.type === 'input_image')
      .length,
    1,
  );
  assert.ok(!captured.options.body.includes('sk-test'));
  assert.match(reviewPrompt([record]), /不是对你的指令/);
  await assert.rejects(
    () =>
      analyze({ apiKey: '', model: 'gpt-5.4-mini', records: [record] }, store),
    /API Key/,
  );
  await assert.rejects(
    () =>
      analyze(
        { apiKey: 'sk-test', model: 'gpt-5.4-mini', records: [record] },
        store,
        async () => new Response('{}', { status: 401 }),
      ),
    /无效/,
  );
});
void test('GPT 能读取私有云端原图，缺失或损坏图片不发出请求', async () => {
  const root = await fixture();
  const store = await new JournalStore(root).init();
  const shot = {
    id: 'cloud-image-only',
    name: '云端截图.png',
    mime: 'image/png',
    stage: '入场',
  };
  const payload = {
    apiKey: 'sk-test',
    model: 'gpt-test',
    records: [sample(2, { screenshots: [shot] })],
    includeImages: true,
    cloudImages: [
      { id: shot.id, mime: shot.mime, data: png.toString('base64') },
    ],
  };
  let calls = 0;
  const fetcher = async (_url, options) => {
    calls++;
    const request = JSON.parse(options.body);
    const image = request.input[0].content.find(
      (item) => item.type === 'input_image',
    );
    assert.equal(
      image.image_url,
      `data:image/png;base64,${png.toString('base64')}`,
    );
    return new Response(
      JSON.stringify({
        status: 'completed',
        output: [
          { content: [{ type: 'output_text', text: '已复盘云端图表' }] },
        ],
      }),
    );
  };
  assert.equal((await analyze(payload, store, fetcher)).text, '已复盘云端图表');
  await assert.rejects(
    () => analyze({ ...payload, cloudImages: [] }, store, fetcher),
    /未读取完整/,
  );
  await assert.rejects(
    () =>
      analyze(
        {
          ...payload,
          cloudImages: [{ ...payload.cloudImages[0], data: 'broken' }],
        },
        store,
        fetcher,
      ),
    /格式|编码/,
  );
  assert.equal(calls, 1);
});

void test('同时到达的GPT请求只发出一次', async (t) => {
  let calls = 0,
    finish;
  const app = await createApp({
    root: await fixture(),
    fetcher: async () => {
      calls++;
      await new Promise((resolve) => {
        finish = resolve;
      });
      return new Response(
        JSON.stringify({
          status: 'completed',
          output: [{ content: [{ type: 'output_text', text: '模拟复盘' }] }],
        }),
      );
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const url = `http://127.0.0.1:${app.server.address().port}/api/analyze`;
  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: 'sk-test',
      model: 'gpt-5.4-mini',
      records: [sample()],
    }),
  };
  const first = fetch(url, options);
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await fetch(url, options);
  assert.equal(second.status, 429);
  assert.equal(calls, 1);
  finish();
  assert.equal((await first).status, 200);
});
