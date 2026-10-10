import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { networkAccess, lanInterfaces } from '../server/network.mjs';
import { createApp } from '../server/index.mjs';
import { newTrade } from '../lib/journal.ts';

const interfaces = [{ address: '192.168.20.5', netmask: '255.255.255.0' }];
const port = 4319;
const lanHost = `192.168.20.5:${port}`;
const request = (peer, headers = {}) => ({
  socket: { remoteAddress: peer }, headers: { host: lanHost, ...headers },
});
test('局域网仅在开启后接受本机网卡地址及同网段设备，不信任转发头', () => {
  const options = { lan: true, interfaces };
  assert.equal(networkAccess(request('192.168.20.8'), port, options), null);
  assert.equal(networkAccess(request('::ffff:192.168.20.8'), port, options), null);
  assert.ok(networkAccess(request('192.168.20.8'), port, { interfaces }));
  for (const peer of ['192.168.21.8', '10.0.0.8', '203.0.113.1', '::1bad']) {
    assert.ok(networkAccess(request(peer, { 'x-forwarded-for': '192.168.20.8' }), port, options));
  }
  for (const host of ['localhost:4319', '127.0.0.1:4319', 'untrusted.example:4319',
    '192.168.20.8:4319', '192.168.20.5:5173', '192.168.20.5:4319@evil.example']) {
    assert.ok(networkAccess(request('192.168.20.8', { host }), port, options));
  }
  assert.equal(networkAccess(request('127.0.0.1', { host: 'localhost:4319' }), port), null);
});

test('局域网请求需同源，拒绝其他网站、同网段其他端口、null Origin 与跨站请求', () => {
  const options = { lan: true, interfaces };
  assert.equal(networkAccess(request('192.168.20.8', {
    origin: `http://${lanHost}`, 'sec-fetch-site': 'same-origin',
  }), port, options), null);
  for (const origin of ['https://evil.example', 'null', 'http://192.168.20.5:80',
    'http://192.168.20.9:4319', 'http://127.0.0.1:5173']) {
    assert.ok(networkAccess(request('192.168.20.8', { origin }), port, options));
  }
  for (const site of ['cross-site', 'same-site']) {
    assert.ok(networkAccess(request('192.168.20.8', { 'sec-fetch-site': site }), port, options));
  }
  assert.equal(networkAccess(request('127.0.0.1', {
    host: '127.0.0.1:4319', origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-origin',
  }), port), null);
});

test('真实 HTTP 接口接受已授权局域网 Host 并保存到同一资料库，跨源请求不改变数据', async (t) => {
  await fs.mkdir('test-results', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('test-results/lan-'));
  const app = await createApp({ root, lan: true, networkInterfaces: () => interfaces });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const actualPort = app.server.address().port;
  const host = `192.168.20.5:${actualPort}`;
  const call = (endpoint, method = 'GET', data, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: actualPort, path: endpoint, method,
      headers: { Host: host, Origin: `http://${host}`, 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(data === undefined ? undefined : JSON.stringify(data));
  });
  const health = await call('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.networkMode, 'lan');
  assert.deepEqual(health.data.lanUrls, [`http://${host}/`]);
  const trade = { ...newTrade(), title: '局域网测试', symbol: 'TEST' };
  assert.equal((await call('/api/journal', 'PUT', { records: [trade], revision: 0 })).status, 200);
  const saved = await call('/api/journal');
  assert.equal(saved.data.records[0].id, trade.id);
  const blocked = await call('/api/journal', 'PUT', { records: [], revision: 1 }, { Origin: 'http://evil.example' });
  assert.equal(blocked.status, 403);
  assert.equal((await call('/api/journal')).data.records.length, 1);
  assert.equal((await call('/api/journal', 'GET', undefined, { Host: 'evil.example' })).status, 403);
});

test('通过实际网卡连接能读取手记，但不能迁移主机目录或写入本机设置', {
  skip: lanInterfaces().length === 0,
}, async (t) => {
  await fs.mkdir('test-results', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('test-results/lan-directory-'));
  const app = await createApp({ root, lan: true });
  await new Promise((resolve) => app.server.listen(0, '0.0.0.0', resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const base = `http://${lanInterfaces()[0].address}:${app.server.address().port}`;
  assert.equal((await fetch(base + '/api/journal')).status, 200);
  const target = path.join(root, 'must-not-be-created');
  const response = await fetch(base + '/api/directory', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ directory: target, revision: 0 }),
  });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /主机/);
  assert.equal(app.store.directory, path.join(root, 'data'));
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(root, '.local-settings.json')), { code: 'ENOENT' });
});
