import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import sharp from 'sharp';
import { createApp } from '../server/index.mjs';
import { newTrade } from '../lib/journal.ts';

const TOKEN = 'synthetic-desktop-session-0123456789';
const WRONG_TOKEN = 'synthetic-desktop-session-9876543210';
const interfaces = [{ address: '192.168.20.5', netmask: '255.255.255.0' }];
const scope = { from: '2026-09-07', to: '2026-09-13', category: 'all' };
const trade = () => ({
  ...newTrade(),
  symbol: 'SYNTHETIC',
  date: '2026-09-08',
  category: 'live',
  status: 'closed',
  resultR: 1,
  riskPercent: 1,
});

async function fixture(t) {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), 'journal-desktop-'),
  );
  const root = path.join(temporary, 'installation');
  const settingsRoot = path.join(temporary, 'settings');
  const apps = [];
  await fs.mkdir(path.join(root, 'dist', 'client'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'dist', 'client', 'index.html'),
    '<h1>Desktop UI</h1>',
  );
  await fs.writeFile(
    path.join(root, 'dist', 'client', 'app.js'),
    '/* desktop asset */',
  );
  t.after(async () => {
    for (const app of apps) {
      if (app.server.listening)
        await new Promise((resolve) => {
          app.server.close(resolve);
          app.server.closeAllConnections();
        });
      await app.drain();
      await app.store.unlock();
    }
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const start = async (options = {}) => {
    const app = await createApp({ root, ...options });
    apps.push(app);
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    return app;
  };
  return { temporary, root, settingsRoot, start };
}

function call(
  app,
  endpoint,
  { method = 'GET', token, headers = {}, body } = {},
) {
  return new Promise((resolve, reject) => {
    const rawBody =
      body === undefined
        ? undefined
        : typeof body === 'string'
          ? body
          : JSON.stringify(body);
    const request = http.request(
      {
        hostname: '127.0.0.1',
        agent: false,
        port: app.server.address().port,
        path: endpoint,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(rawBody === undefined
            ? {}
            : { 'Content-Length': Buffer.byteLength(rawBody) }),
          ...(token === undefined ? {} : { 'x-journal-desktop-token': token }),
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const bytes = Buffer.concat(chunks);
          const text = bytes.toString('utf8');
          resolve({
            status: response.statusCode,
            headers: response.headers,
            bytes,
            text,
            data:
              text &&
              response.headers['content-type']?.includes('application/json')
                ? JSON.parse(text)
                : undefined,
          });
        });
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.end(rawBody);
  });
}

async function prepare(app, row, token = TOKEN) {
  const response = await call(app, '/api/reports', {
    token,
    method: 'POST',
    body: {
      ...scope,
      title: 'Synthetic desktop report',
      source: 'local',
      revision: app.store.library.revision,
      recordIds: [row.id],
    },
  });
  assert.equal(response.status, 201, response.text);
  return response.data;
}

function mockAnalysis(calls) {
  return async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(options.body);
    calls.push(body.text.format.name);
    const properties = body.text.format.schema.properties;
    const value =
      body.text.format.name === 'weekly_trade_batch'
        ? {
            trades: properties.trades.items.properties.id.enum.map((id) => ({
              id,
              observation: 'Synthetic observation.',
              assessment: 'Synthetic assessment.',
              improvement: 'Record the process.',
            })),
            reviewedScreenshotIds: [],
            limitations: 'Synthetic test data only.',
          }
        : {
            summary: 'Synthetic summary.',
            strengths: [],
            problems: [],
            nextWeek: ['Record the process.'],
            questions: ['What information is missing?'],
            limitations: 'Synthetic test data only.',
          };
    return Response.json({
      status: 'completed',
      output: [
        { content: [{ type: 'output_text', text: JSON.stringify(value) }] },
      ],
    });
  };
}

async function waitForReport(app, id) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await call(app, `/api/reports/${id}`, { token: TOKEN });
    assert.equal(result.status, 200, result.text);
    if (result.data.status !== 'running') {
      assert.equal(result.data.status, 'ready', result.text);
      return result.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Synthetic report analysis did not finish');
}

await test('desktop credentials fail closed for invalid configuration before creating data', async (t) => {
  const { temporary } = await fixture(t);
  const root = path.join(temporary, 'unused');
  for (const sessionToken of [
    '',
    null,
    false,
    12,
    {},
    [],
    'with space',
    'with\nnewline',
    'x'.repeat(1025),
  ])
    await assert.rejects(createApp({ root, sessionToken }), /桌面会话凭证无效/);
  await assert.rejects(fs.stat(root), { code: 'ENOENT' });
});

await test('desktop token guards every route and method before parsing any request body', async (t) => {
  const { start } = await fixture(t);
  let networkChecks = 0;
  const app = await start({
    sessionToken: TOKEN,
    networkInterfaces: () => {
      networkChecks++;
      return interfaces;
    },
  });
  const routes = [
    ['GET', '/api/health'],
    ['GET', '/api/journal'],
    ['PUT', '/api/journal'],
    ['GET', '/api/backup'],
    ['POST', '/api/import'],
    ['POST', '/api/import/preview'],
    ['POST', '/api/directory'],
    ['POST', '/api/analyze'],
    ['POST', '/api/screenshots'],
    ['GET', '/api/screenshots/missing'],
    ['GET', '/api/reports'],
    ['POST', '/api/reports'],
    ['GET', '/api/reports/missing'],
    ['PATCH', '/api/reports/missing'],
    ['DELETE', '/api/reports/missing'],
    ['POST', '/api/reports/missing/analyze'],
    ['GET', '/api/reports/missing/download'],
    ['GET', '/'],
    ['HEAD', '/'],
    ['GET', '/app.js'],
    ['GET', '/missing'],
    ['OPTIONS', '/api/health'],
    ['POST', '/'],
    ['GET', '/%invalid'],
  ];
  for (const token of [undefined, WRONG_TOKEN]) {
    for (const [method, endpoint] of routes) {
      const response = await call(app, endpoint, {
        method,
        token,
        headers: { 'Content-Type': 'text/plain' },
        body: '{not-json',
      });
      assert.equal(response.status, 403, `${method} ${endpoint}`);
      assert.ok(!response.text.includes(TOKEN));
      if (method !== 'HEAD')
        assert.match(response.data.error, /桌面会话凭证无效/);
    }
  }
  assert.equal(
    networkChecks,
    0,
    'authentication must precede even network inspection',
  );
  assert.equal(app.store.library.revision, 0);
  assert.deepEqual(app.store.library.records, []);
  const health = await call(app, '/api/health', { token: TOKEN });
  assert.equal(health.status, 200);
  assert.equal(
    networkChecks,
    0,
    'desktop mode must not enumerate LAN interfaces',
  );
  assert.equal(health.data.networkMode, 'local');
  assert.deepEqual(health.data.lanUrls, []);
});

await test('valid tokens serve UI, journal and images; URL, cookie and duplicate tokens cannot authenticate', async (t) => {
  const { start } = await fixture(t);
  const app = await start({ sessionToken: TOKEN });
  const bytes = await sharp({
    create: { width: 2, height: 2, channels: 3, background: '#345678' },
  })
    .png()
    .toBuffer();
  const screenshot = await app.store.upload({
    name: 'Synthetic.png',
    mime: 'image/png',
    data: bytes.toString('base64'),
  });
  const row = { ...trade(), screenshots: [screenshot] };
  const saved = await call(app, '/api/journal', {
    token: TOKEN,
    method: 'PUT',
    body: { records: [row], revision: 0 },
  });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(
    (await call(app, '/api/journal', { token: TOKEN })).data.records[0].id,
    row.id,
  );
  assert.equal(
    (await call(app, '/', { token: TOKEN })).text,
    '<h1>Desktop UI</h1>',
  );
  assert.equal(
    (await call(app, '/', { token: TOKEN, method: 'HEAD' })).text,
    '',
  );
  assert.equal(
    (await call(app, '/app.js', { token: TOKEN })).text,
    '/* desktop asset */',
  );
  assert.deepEqual(
    (await call(app, `/api/screenshots/${screenshot.id}`, { token: TOKEN }))
      .bytes,
    bytes,
  );
  assert.equal(
    (await call(app, `/api/screenshots/${screenshot.id}`)).status,
    403,
  );
  assert.equal(
    (await call(app, `/?x-journal-desktop-token=${TOKEN}`)).status,
    403,
  );
  assert.equal(
    (
      await call(app, '/', {
        headers: { Cookie: `x-journal-desktop-token=${TOKEN}` },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(app, '/', {
        headers: { 'x-journal-desktop-token': [TOKEN, TOKEN] },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(app, '/', {
        token: TOKEN,
        headers: { Origin: 'https://untrusted.example' },
      })
    ).status,
    403,
  );
});

await test('two desktop instances reject each other’s session token', async (t) => {
  const { start, temporary } = await fixture(t);
  const first = await start({
    sessionToken: TOKEN,
    settingsRoot: path.join(temporary, 'first'),
  });
  const second = await start({
    sessionToken: WRONG_TOKEN,
    settingsRoot: path.join(temporary, 'second'),
  });
  assert.equal(
    (await call(first, '/api/journal', { token: TOKEN })).status,
    200,
  );
  assert.equal(
    (await call(second, '/api/journal', { token: WRONG_TOKEN })).status,
    200,
  );
  assert.equal(
    (await call(first, '/api/journal', { token: WRONG_TOKEN })).status,
    403,
  );
  assert.equal(
    (await call(second, '/api/journal', { token: TOKEN })).status,
    403,
  );
  assert.notEqual(first.store.directory, second.store.directory);
});

function expectRequest(app, expect, token) {
  return new Promise((resolve, reject) => {
    const interim = [];
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port: app.server.address().port,
        path: '/api/import/preview',
        method: 'POST',
        headers: {
          Expect: expect,
          'Content-Type': 'application/json',
          'Content-Length': 2,
          ...(token === undefined ? {} : { 'x-journal-desktop-token': token }),
        },
      },
      (response) => {
        response.resume();
        response.on('end', () => {
          request.destroy();
          resolve({ status: response.statusCode, interim });
        });
      },
    );
    request.on('information', (response) => interim.push(response.statusCode));
    request.on('continue', () => request.end('{}'));
    request.on('error', reject);
    request.setTimeout(2000, () =>
      request.destroy(new Error('Expect request timed out')),
    );
    request.flushHeaders();
  });
}

await test('Expect requests authenticate before any automatic 100 or 417 response and before receiving a body', async (t) => {
  const { start } = await fixture(t);
  const app = await start({ sessionToken: TOKEN });
  for (const token of [undefined, WRONG_TOKEN]) {
    for (const expect of ['100-continue', 'unrecognized-expectation'])
      assert.deepEqual(await expectRequest(app, expect, token), {
        status: 403,
        interim: [],
      });
  }
  assert.deepEqual(await expectRequest(app, '100-continue', TOKEN), {
    status: 400,
    interim: [100],
  });
  assert.deepEqual(
    await expectRequest(app, 'unrecognized-expectation', TOKEN),
    { status: 417, interim: [] },
  );
});

await test('locking immediately gates every route, file and Expect response until unlocked', async (t) => {
  const { start } = await fixture(t);
  let locked = false;
  const app = await start({ sessionToken: TOKEN, isLocked: () => locked });
  assert.equal((await call(app, '/api/health', { token: TOKEN })).status, 200);
  const before = app.store.snapshot();
  locked = true;
  const routes = [
    ['GET', '/'],
    ['HEAD', '/'],
    ['GET', '/app.js'],
    ['POST', '/'],
    ['GET', '/api/health'],
    ['GET', '/api/journal'],
    ['PUT', '/api/journal'],
    ['GET', '/api/backup'],
    ['POST', '/api/screenshots'],
    ['GET', '/api/screenshots/missing'],
    ['GET', '/api/reports'],
    ['POST', '/api/reports'],
    ['GET', '/api/reports/missing'],
    ['PATCH', '/api/reports/missing'],
    ['DELETE', '/api/reports/missing'],
    ['POST', '/api/reports/missing/analyze'],
    ['GET', '/api/reports/missing/download'],
    ['POST', '/api/directory'],
    ['POST', '/api/analyze'],
    ['POST', '/api/import'],
    ['POST', '/api/import/preview'],
    ['OPTIONS', '/api/health'],
    ['GET', '/%invalid'],
  ];
  for (const [method, endpoint] of routes) {
    const response = await call(app, endpoint, {
      token: TOKEN,
      method,
      body: '{invalid-json',
    });
    assert.equal(response.status, 423, `${method} ${endpoint}`);
    if (method !== 'HEAD') assert.match(response.data.error, /已锁定/);
  }
  assert.equal(
    (await call(app, '/api/health')).status,
    403,
    'missing token must not disclose lock state',
  );
  assert.deepEqual(await expectRequest(app, '100-continue', TOKEN), {
    status: 423,
    interim: [],
  });
  assert.deepEqual(await expectRequest(app, 'unsupported', TOKEN), {
    status: 423,
    interim: [],
  });
  assert.deepEqual(app.store.snapshot(), before);
  locked = false;
  assert.equal((await call(app, '/api/health', { token: TOKEN })).status, 200);
  assert.equal(
    (await call(app, '/', { token: TOKEN })).text,
    '<h1>Desktop UI</h1>',
  );
  assert.equal(
    (
      await call(app, '/api/journal', {
        token: TOKEN,
        method: 'PUT',
        body: { records: [trade()], revision: 0 },
      })
    ).status,
    200,
  );
  locked = true;
  assert.equal((await call(app, '/api/journal', { token: TOKEN })).status, 423);
});

await test('lock callback also guards Expect requests when no desktop token was configured', async (t) => {
  const { start } = await fixture(t);
  let locked = true;
  const app = await start({ isLocked: () => locked });
  assert.equal((await call(app, '/api/health')).status, 423);
  assert.deepEqual(await expectRequest(app, '100-continue'), {
    status: 423,
    interim: [],
  });
  assert.deepEqual(await expectRequest(app, 'unsupported'), {
    status: 423,
    interim: [],
  });
  locked = false;
  assert.equal((await call(app, '/api/health')).status, 200);
  assert.deepEqual(await expectRequest(app, '100-continue'), {
    status: 400,
    interim: [100],
  });
});

await test('desktop mode rejects LAN hosts and remote peers even with a valid token and lan: true', async (t) => {
  const { start } = await fixture(t);
  const app = await start({
    sessionToken: TOKEN,
    lan: true,
    networkInterfaces: () => interfaces,
  });
  const port = app.server.address().port;
  const health = await call(app, '/api/health', { token: TOKEN });
  assert.equal(health.data.networkMode, 'local');
  assert.deepEqual(health.data.lanUrls, []);
  assert.equal(
    (
      await call(app, '/api/health', {
        token: TOKEN,
        headers: { Host: `192.168.20.5:${port}` },
      })
    ).status,
    403,
  );
  for (const peer of ['192.168.20.8', '::ffff:192.168.20.8', '203.0.113.8']) {
    let status, response;
    await app.server.listeners('request')[0](
      {
        method: 'GET',
        url: '/api/journal',
        socket: { remoteAddress: peer },
        headers: {
          host: `127.0.0.1:${port}`,
          'x-journal-desktop-token': TOKEN,
          'x-forwarded-for': '127.0.0.1',
        },
      },
      {
        writeHead(code) {
          status = code;
        },
        end(body) {
          response = JSON.parse(body);
        },
      },
    );
    assert.equal(status, 403, peer);
    assert.match(response.error, /仅允许/);
  }
});

await test('settings and directory migration stay outside the installation and survive restart', async (t) => {
  const { root, settingsRoot, temporary, start } = await fixture(t);
  const decoy = path.join(temporary, 'must-not-load');
  await fs.writeFile(
    path.join(root, '.local-settings.json'),
    JSON.stringify({ directory: decoy }),
  );
  const app = await start({ sessionToken: TOKEN, settingsRoot });
  assert.equal(app.store.root, settingsRoot);
  assert.equal(app.store.directory, path.join(settingsRoot, 'data'));
  assert.equal(
    (await call(app, '/', { token: TOKEN })).text,
    '<h1>Desktop UI</h1>',
  );
  await app.store.save([trade()], 0);
  const source = app.store.directory;
  const directory = path.join(temporary, 'selected-data');
  const migrated = await call(app, '/api/directory', {
    token: TOKEN,
    method: 'POST',
    body: { directory, revision: 1 },
  });
  assert.equal(migrated.status, 200, migrated.text);
  assert.equal(migrated.data.directory, directory);
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(
        path.join(settingsRoot, '.local-settings.json'),
        'utf8',
      ),
    ),
    { directory },
  );
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(path.join(root, '.local-settings.json'), 'utf8'),
    ),
    { directory: decoy },
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(source, 'journal.json'), 'utf8'))
      .records.length,
    1,
  );
  await assert.rejects(fs.stat(decoy), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(root, 'data')), { code: 'ENOENT' });
  const restarted = await start({ sessionToken: TOKEN, settingsRoot });
  assert.equal(restarted.store.directory, directory);
  assert.equal(restarted.store.library.records.length, 1);
});

await test('an explicit data directory still creates the separate settings folder for later migration', async (t) => {
  const { temporary, settingsRoot, start } = await fixture(t);
  const app = await start({
    sessionToken: TOKEN,
    settingsRoot,
    directory: path.join(temporary, 'initial-data'),
  });
  const directory = path.join(temporary, 'new-data');
  const migrated = await call(app, '/api/directory', {
    token: TOKEN,
    method: 'POST',
    body: { directory, revision: 0 },
  });
  assert.equal(migrated.status, 200, migrated.text);
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(
        path.join(settingsRoot, '.local-settings.json'),
        'utf8',
      ),
    ),
    { directory },
  );
});

await test('all report operations use the dynamic data root, including generation and post-migration downloads', async (t) => {
  const { root, temporary, settingsRoot, start } = await fixture(t);
  const calls = [];
  const app = await start({
    sessionToken: TOKEN,
    settingsRoot,
    reportsRoot: (store) => store.directory,
    fetcher: mockAnalysis(calls),
  });
  const row = trade();
  await app.store.save([row], 0);
  const first = await prepare(app, row);
  const source = app.store.directory;
  assert.equal(
    first.directory,
    path.join(source, 'weekly-reviews', 'generated', first.id),
  );
  const started = await call(app, `/api/reports/${first.id}/analyze`, {
    token: TOKEN,
    method: 'POST',
    body: {
      apiKey: 'sk-synthetic-no-network',
      model: 'gpt-test',
      includeImages: false,
    },
  });
  assert.equal(started.status, 202, started.text);
  await waitForReport(app, first.id);
  assert.deepEqual(calls, ['weekly_trade_batch', 'weekly_summary']);
  const downloaded = await call(app, `/api/reports/${first.id}/download`, {
    token: TOKEN,
  });
  assert.equal(downloaded.status, 200, downloaded.text);
  assert.match(downloaded.text, /Synthetic summary/);
  assert.equal(
    (await call(app, `/api/reports/${first.id}/download`)).status,
    403,
  );
  assert.equal(
    (await call(app, '/api/reports', { token: TOKEN })).data.reports[0].id,
    first.id,
  );
  const directory = path.join(temporary, 'migrated-data');
  const migrated = await call(app, '/api/directory', {
    token: TOKEN,
    method: 'POST',
    body: { directory, revision: 1 },
  });
  assert.equal(migrated.status, 200, migrated.text);
  const listed = await call(app, '/api/reports', { token: TOKEN });
  assert.equal(
    listed.data.reports[0].directory,
    path.join(directory, 'weekly-reviews', 'generated', first.id),
  );
  assert.deepEqual(
    (await call(app, `/api/reports/${first.id}/download`, { token: TOKEN }))
      .bytes,
    downloaded.bytes,
  );
  const archived = await call(app, `/api/reports/${first.id}`, {
    token: TOKEN,
    method: 'PATCH',
    body: { archived: true },
  });
  assert.equal(archived.status, 200, archived.text);
  assert.equal(archived.data.archived, true);
  const second = await prepare(app, row);
  assert.equal(
    second.directory,
    path.join(directory, 'weekly-reviews', 'generated', second.id),
  );
  await assert.rejects(
    fs.stat(path.join(source, 'weekly-reviews', 'generated', second.id)),
    { code: 'ENOENT' },
  );
  const removed = await call(app, `/api/reports/${first.id}`, {
    token: TOKEN,
    method: 'DELETE',
  });
  assert.equal(removed.status, 200, removed.text);
  assert.equal(removed.data.deleted, first.id);
  assert.deepEqual(
    (await call(app, '/api/reports', { token: TOKEN })).data.reports.map(
      (entry) => entry.id,
    ),
    [second.id],
  );
  await fs.stat(
    path.join(source, 'weekly-reviews', 'generated', first.id, 'report.html'),
  );
  await assert.rejects(fs.stat(path.join(root, 'weekly-reviews')), {
    code: 'ENOENT',
  });
  await assert.rejects(fs.stat(path.join(root, '.local-settings.json')), {
    code: 'ENOENT',
  });
});

await test('reportsRoot accepts a fixed folder and omitted desktop options preserve legacy behavior', async (t) => {
  const { root, temporary, start } = await fixture(t);
  const legacy = await start({
    lan: true,
    networkInterfaces: () => interfaces,
  });
  assert.equal(legacy.store.directory, path.join(root, 'data'));
  const health = await call(legacy, '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.networkMode, 'lan');
  assert.equal((await call(legacy, '/')).status, 200);
  const row = trade();
  await legacy.store.save([row], 0);
  const original = await prepare(legacy, row, undefined);
  assert.equal(
    original.directory,
    path.join(root, 'weekly-reviews', 'generated', original.id),
  );
  const fixedRoot = path.join(temporary, 'fixed-reports');
  const desktop = await start({ sessionToken: TOKEN, reportsRoot: fixedRoot });
  assert.deepEqual(
    (await call(desktop, '/api/reports', { token: TOKEN })).data.reports,
    [],
  );
  const isolated = await prepare(desktop, row);
  assert.equal(
    isolated.directory,
    path.join(fixedRoot, 'weekly-reviews', 'generated', isolated.id),
  );
  assert.deepEqual(
    (await call(legacy, '/api/reports')).data.reports.map((entry) => entry.id),
    [original.id],
  );
});

await test('directory migration waits for both regular and weekly analysis without changing data or settings', async (t) => {
  for (const kind of ['regular', 'weekly']) {
    await t.test(kind, async (t) => {
      const { start, temporary, settingsRoot } = await fixture(t);
      const started = Promise.withResolvers();
      const release = Promise.withResolvers();
      let locked = false;
      const weeklyReply = mockAnalysis([]);
      const app = await start({
        sessionToken: TOKEN,
        settingsRoot,
        reportsRoot: (store) => store.directory,
        isLocked: () => locked,
        fetcher: async (url, options) => {
          started.resolve();
          await release.promise;
          if (kind === 'weekly') return weeklyReply(url, options);
          return Response.json({
            status: 'completed',
            output: [
              { content: [{ type: 'output_text', text: 'Synthetic review.' }] },
            ],
          });
        },
      });
      const row = trade();
      await app.store.save([row], 0);
      const report = kind === 'weekly' ? await prepare(app, row) : null;
      const pending = call(
        app,
        report ? `/api/reports/${report.id}/analyze` : '/api/analyze',
        {
          token: TOKEN,
          method: 'POST',
          body: {
            apiKey: 'sk-synthetic-no-network',
            model: 'gpt-test',
            includeImages: false,
            records: [row],
          },
        },
      );
      const source = app.store.directory;
      const directory = path.join(temporary, 'selected-data');
      const migrate = () =>
        call(app, '/api/directory', {
          token: TOKEN,
          method: 'POST',
          body: { directory, revision: 1 },
        });
      try {
        await started.promise;
        const blocked = await migrate();
        assert.equal(blocked.status, 409, blocked.text);
        assert.match(blocked.data.error, /复盘正在生成/);
        assert.equal(app.store.directory, source);
        assert.equal(app.store.library.revision, 1);
        await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
        await assert.rejects(
          fs.stat(path.join(settingsRoot, '.local-settings.json')),
          { code: 'ENOENT' },
        );
        locked = true;
        assert.equal(
          (await migrate()).status,
          423,
          'application lock must still take precedence',
        );
      } finally {
        locked = false;
        release.resolve();
        await pending;
      }
      const completed = await pending;
      assert.equal(
        completed.status,
        kind === 'weekly' ? 202 : 200,
        completed.text,
      );
      if (report) await waitForReport(app, report.id);
      const migrated = await migrate();
      assert.equal(migrated.status, 200, migrated.text);
      assert.equal(app.store.directory, directory);
      assert.equal(migrated.data.records[0].id, row.id);
      assert.deepEqual(
        JSON.parse(
          await fs.readFile(
            path.join(settingsRoot, '.local-settings.json'),
            'utf8',
          ),
        ),
        { directory },
      );
      assert.equal(
        JSON.parse(await fs.readFile(path.join(source, 'journal.json'), 'utf8'))
          .records[0].id,
        row.id,
      );
      if (report) {
        const downloaded = await call(
          app,
          `/api/reports/${report.id}/download`,
          { token: TOKEN },
        );
        assert.equal(downloaded.status, 200, downloaded.text);
        assert.match(downloaded.text, /Synthetic summary/);
      }
    });
  }
});

await test('service drain waits for a background report after its HTTP 202 response and server shutdown', async (t) => {
  const { start, settingsRoot } = await fixture(t);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const reply = mockAnalysis([]);
  const app = await start({
    sessionToken: TOKEN,
    settingsRoot,
    reportsRoot: (store) => store.directory,
    fetcher: async (url, options) => {
      started.resolve();
      await release.promise;
      return reply(url, options);
    },
  });
  const row = trade();
  await app.store.save([row], 0);
  const report = await prepare(app, row);
  const response = await call(app, `/api/reports/${report.id}/analyze`, {
    token: TOKEN,
    method: 'POST',
    body: {
      apiKey: 'sk-synthetic-no-network',
      model: 'gpt-test',
      includeImages: false,
    },
  });
  assert.equal(response.status, 202, response.text);
  await started.promise;
  await new Promise((resolve) => app.server.close(resolve));
  assert.equal(app.server.listening, false);
  let drained = false;
  const draining = app.drain().then(() => {
    drained = true;
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      drained,
      false,
      'the finished HTTP request must not hide unfinished report writes',
    );
    assert.equal(
      JSON.parse(
        await fs.readFile(
          path.join(report.directory, 'api-state.json'),
          'utf8',
        ),
      ).status,
      'running',
    );
  } finally {
    release.resolve();
    await draining;
  }
  assert.equal(drained, true);
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(report.directory, 'api-state.json'), 'utf8'),
    ).status,
    'ready',
  );
  assert.match(
    await fs.readFile(path.join(report.directory, 'report.html'), 'utf8'),
    /Synthetic summary/,
  );
  await fs.stat(path.join(report.directory, 'completed.json'));
  await assert.rejects(fs.stat(`${report.directory}.lock`), { code: 'ENOENT' });
  await app.drain();
});

await test('service drain follows queued journal writes added while an earlier write is pending', async (t) => {
  const { start } = await fixture(t);
  const app = await start({ sessionToken: TOKEN });
  await new Promise((resolve) => app.server.close(resolve));
  const firstRelease = Promise.withResolvers();
  const secondRelease = Promise.withResolvers();
  const first = app.store.serialized(() => firstRelease.promise);
  let drained = false;
  const draining = app.drain().then(() => {
    drained = true;
  });
  const second = app.store.serialized(() => secondRelease.promise);
  const row = trade();
  const saving = app.store.save([row], 0);
  try {
    firstRelease.resolve();
    await first;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      drained,
      false,
      'drain must follow the new store queue instead of an old snapshot',
    );
  } finally {
    firstRelease.resolve();
    secondRelease.resolve();
    await Promise.all([first, second, saving, draining]);
  }
  assert.equal(drained, true);
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(app.store.directory, 'journal.json'), 'utf8'),
    ).records[0].id,
    row.id,
  );
});

await test('an in-flight report creation blocks migration until its source-root work has finished', async (t) => {
  const { start, settingsRoot, temporary } = await fixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const app = await start({
    sessionToken: TOKEN,
    settingsRoot,
    reportsRoot: (store) => {
      entered.resolve();
      return store.directory;
    },
  });
  const row = trade();
  await app.store.save([row], 0);
  const source = app.store.directory;
  const directory = path.join(temporary, 'migrated-data');
  const held = app.store.serialized(() => release.promise);
  const creating = prepare(app, row);
  try {
    await entered.promise;
    const blocked = await call(app, '/api/directory', {
      token: TOKEN,
      method: 'POST',
      body: { directory, revision: 1 },
    });
    assert.equal(blocked.status, 409, blocked.text);
    assert.equal(app.store.directory, source);
    await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
    await assert.rejects(
      fs.stat(path.join(settingsRoot, '.local-settings.json')),
      { code: 'ENOENT' },
    );
  } finally {
    release.resolve();
    await Promise.all([held, creating]);
  }
  const report = await creating;
  const invalid = await call(app, '/api/reports', {
    token: TOKEN,
    method: 'POST',
    body: {},
  });
  assert.equal(invalid.status, 400, invalid.text);
  const migrated = await call(app, '/api/directory', {
    token: TOKEN,
    method: 'POST',
    body: { directory, revision: 1 },
  });
  assert.equal(
    migrated.status,
    200,
    'both successful and failed report requests must release their counter',
  );
  const reports = (await call(app, '/api/reports', { token: TOKEN })).data
    .reports;
  assert.equal(reports.length, 1);
  assert.equal(reports[0].id, report.id);
  assert.equal(
    reports[0].directory,
    path.join(directory, 'weekly-reviews', 'generated', report.id),
  );
});

await test('queued migration rejects new report, analysis and overlapping directory requests before reading bodies', async (t) => {
  const { start, settingsRoot, temporary } = await fixture(t);
  const app = await start({
    sessionToken: TOKEN,
    settingsRoot,
    reportsRoot: (store) => store.directory,
  });
  const row = trade();
  await app.store.save([row], 0);
  const existing = await prepare(app, row);
  const snapshot = await fs.readFile(
    path.join(existing.directory, 'journal-snapshot.json'),
  );
  const files = await fs.readdir(existing.directory);
  const source = app.store.directory;
  const directory = path.join(temporary, 'migrated-data');
  const secondDirectory = path.join(temporary, 'must-not-migrate');
  const release = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const originalMigrate = app.store.migrate.bind(app.store);
  app.store.migrate = (...args) => {
    entered.resolve();
    return originalMigrate(...args);
  };
  const held = app.store.serialized(() => release.promise);
  const migrating = call(app, '/api/directory', {
    token: TOKEN,
    method: 'POST',
    body: { directory, revision: 1 },
  });
  try {
    await entered.promise;
    const routes = [
      ['GET', '/api/reports'],
      ['POST', '/api/reports'],
      ['GET', `/api/reports/${existing.id}`],
      ['PATCH', `/api/reports/${existing.id}`],
      ['DELETE', `/api/reports/${existing.id}`],
      ['GET', `/api/reports/${existing.id}/download`],
      ['POST', `/api/reports/${existing.id}/analyze`],
      ['POST', '/api/analyze'],
    ];
    for (const [method, endpoint] of routes) {
      const blocked = await call(app, endpoint, {
        token: TOKEN,
        method,
        headers: { 'Content-Type': 'text/plain' },
        body: '{invalid-json',
      });
      assert.equal(
        blocked.status,
        409,
        `${method} ${endpoint}: ${blocked.text}`,
      );
      assert.match(blocked.data.error, /正在迁移/);
    }
    const overlapping = await call(app, '/api/directory', {
      token: TOKEN,
      method: 'POST',
      body: { directory: secondDirectory, revision: 1 },
    });
    assert.equal(overlapping.status, 409, overlapping.text);
    assert.equal(app.store.directory, source);
    assert.deepEqual(await fs.readdir(existing.directory), files);
    assert.deepEqual(
      await fs.readFile(path.join(existing.directory, 'journal-snapshot.json')),
      snapshot,
    );
    await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
    await assert.rejects(fs.stat(secondDirectory), { code: 'ENOENT' });
  } finally {
    release.resolve();
    await Promise.all([held, migrating]);
  }
  assert.equal((await migrating).status, 200, (await migrating).text);
  assert.equal(app.store.directory, directory);
  const report = (
    await call(app, `/api/reports/${existing.id}`, { token: TOKEN })
  ).data;
  assert.equal(
    report.directory,
    path.join(directory, 'weekly-reviews', 'generated', existing.id),
  );
  assert.deepEqual(
    await fs.readFile(path.join(report.directory, 'journal-snapshot.json')),
    snapshot,
  );
  assert.deepEqual(await fs.readdir(report.directory), files);
  const created = await prepare(app, row);
  assert.equal(
    created.directory,
    path.join(directory, 'weekly-reviews', 'generated', created.id),
  );
  await assert.rejects(
    fs.stat(path.join(source, 'weekly-reviews', 'generated', created.id)),
    { code: 'ENOENT' },
  );
});

await test('failed migration releases its guard so reports remain available', async (t) => {
  const { start, settingsRoot, temporary } = await fixture(t);
  const app = await start({
    sessionToken: TOKEN,
    settingsRoot,
    reportsRoot: (store) => store.directory,
  });
  const row = trade();
  await app.store.save([row], 0);
  const source = app.store.directory;
  const directory = path.join(temporary, 'nonempty');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'keep.txt'), 'keep');
  const failed = await call(app, '/api/directory', {
    token: TOKEN,
    method: 'POST',
    body: { directory, revision: 1 },
  });
  assert.equal(failed.status, 400, failed.text);
  assert.equal(app.store.directory, source);
  const report = await prepare(app, row);
  assert.equal(
    report.directory,
    path.join(source, 'weekly-reviews', 'generated', report.id),
  );
  assert.equal(
    await fs.readFile(path.join(directory, 'keep.txt'), 'utf8'),
    'keep',
  );
});
