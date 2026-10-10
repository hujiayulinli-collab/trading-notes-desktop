import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { newTrade } from '../lib/journal.ts';
import { renderReport } from '../server/report-html.mjs';
import {
  reportWeek,
  reportRecords,
  validateReportRecords,
  reportCategoryStats,
} from '../lib/journal-report.ts';
import { JournalStore, digest } from '../server/storage.mjs';
import { createApp } from '../server/index.mjs';
import { CloudJournalClient } from '../lib/journal-cloud.ts';
import {
  createReport,
  loadReport,
  listReports,
  completeReport,
  downloadReport,
  reportDirectory,
  acquireReportLock,
  archiveReport,
  deleteReport,
  getReport,
} from '../server/reports.mjs';

const scope = { from: '2026-09-07', to: '2026-09-13', category: 'all' };
const trade = (patch = {}) => ({
  ...newTrade(),
  symbol: 'TEST',
  date: '2026-09-07',
  time: '09:00',
  category: 'live',
  status: 'closed',
  resultR: 1,
  riskPercent: 1,
  ...patch,
});
const image = (format) =>
  sharp({ create: { width: 6, height: 4, channels: 3, background: '#325c49' } })
    .toFormat(format)
    .toBuffer();
const fixture = async () => {
  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  const root = await fs.mkdtemp(path.resolve('test-results/reports-'));
  return { root, store: await new JournalStore(root).init() };
};
const analysisFor = (snapshot) => ({
  snapshotId: snapshot.id,
  summary: '合成测试：只根据已选记录核对执行过程，不推断长期表现。',
  strengths: [
    {
      text: '这笔记录提供了可以核对的依据。',
      tradeIds: [snapshot.records[0].id],
    },
  ],
  problems: [],
  nextWeek: ['开仓前记录触发条件，复盘时检查是否一致。'],
  questions: ['这些入场条件是否足以支持这笔交易？'],
  trades: snapshot.records.map((t) => ({
    id: t.id,
    observation: '记录中给出了入场信息。',
    assessment: '这里只是用于验证报告生成的合成分析。',
    improvement: '补全执行过程后再作判断。',
  })),
  reviewedScreenshotIds: [],
  limitations: '测试数据；未对任何真实交易作出分析。',
});
const prepare = (root, store, records, patch = {}) =>
  createReport(root, store, {
    ...scope,
    title: '测试周总结',
    source: 'local',
    revision: store.library.revision,
    recordIds: records.map((t) => t.id),
    ...patch,
  });

await test('报告日期包含首尾、类别互斥，周范围按 UTC+8 跨周和跨年计算', () => {
  const rows = [
    trade(),
    trade({ date: '2026-09-13', category: 'review' }),
    trade({ date: '2026-09-14' }),
    trade({ category: undefined }),
  ];
  assert.equal(reportRecords(rows, scope).length, 3);
  assert.equal(reportRecords(rows, { ...scope, category: 'live' }).length, 1);
  assert.equal(
    reportRecords(rows, { ...scope, category: 'unclassified' }).length,
    1,
  );
  assert.equal(reportRecords(rows, { ...scope, to: '2026-09-07' }).length, 2);
  assert.throws(
    () => reportRecords(rows, { ...scope, from: '2026-02-30' }),
    /日期/,
  );
  assert.throws(
    () => reportRecords(rows, { ...scope, to: '2026-09-01' }),
    /日期/,
  );
  assert.throws(() => validateReportRecords([], scope), /1–100/);
  assert.throws(
    () =>
      validateReportRecords(
        Array.from({ length: 101 }, () => trade()),
        scope,
      ),
    /1–100/,
  );
  assert.deepEqual(reportWeek(new Date('2026-09-13T15:59:59Z')), {
    from: '2026-09-07',
    to: '2026-09-13',
  });
  assert.deepEqual(reportWeek(new Date('2026-09-13T16:00:00Z')), {
    from: '2026-09-14',
    to: '2026-09-20',
  });
  assert.deepEqual(reportWeek(new Date('2025-12-31T16:00:00Z')), {
    from: '2025-12-29',
    to: '2026-01-04',
  });
  assert.deepEqual(reportWeek(new Date('2026-09-13T16:00:00Z'), -1), {
    from: '2026-09-07',
    to: '2026-09-13',
  });
});

await test('新报告冻结基础 R；修改资料库不影响报告，旧快照重建保留原始 R', async () => {
  const { root, store } = await fixture();
  const row = trade({ resultR: -1, riskPercent: 2, entryScore: 0 });
  await store.save([row], 0, undefined, 0.5);
  const report = await prepare(root, store, [row]);
  const snapshot = await loadReport(root, report.id);
  assert.equal(snapshot.baseRiskPercent, 0.5);
  assert.equal(snapshot.records[0].entryScore, 0);
  assert.match(
    await fs.readFile(path.join(report.directory, '复盘说明.md'), 'utf8'),
    /基础 1R = 0.5%/,
  );
  await store.save([row], 1, undefined, 2);
  await completeReport(root, report.id, analysisFor(snapshot));
  const html = (await downloadReport(root, report.id)).html.toString();
  assert.match(html, /基础 1R = 0.5%/);
  assert.match(html, /换算收益 -4.00 R/);
  assert.match(html, /原始结果 -1.00 R/);
  assert.match(html, /入场打分 0 \/ 100 分/);
  const oldSnapshot = structuredClone(snapshot);
  delete oldSnapshot.baseRiskPercent;
  const oldHtml = renderReport(
    oldSnapshot,
    analysisFor(oldSnapshot),
    new Map(),
  );
  assert.match(oldHtml, /历史报告沿用原始结果 R/);
  assert.ok(!oldHtml.includes('-4.00 R'));
  assert.ok(oldHtml.includes('-1.00 R'));
});

await test('报告归档和恢复会持久保存，不改快照、指令路径和可下载 HTML', async () => {
  const { root, store } = await fixture();
  const row = trade();
  await store.save([row], 0);
  const report = await prepare(root, store, [row]);
  assert.equal(report.archived, false);
  const snapshot = await loadReport(root, report.id);
  await completeReport(root, report.id, analysisFor(snapshot));
  const originalSnapshot = await fs.readFile(
    path.join(report.directory, 'journal-snapshot.json'),
  );
  const originalHash = await fs.readFile(
    path.join(report.directory, 'snapshot.sha256'),
  );
  const originalHtml = (await downloadReport(root, report.id)).html;
  const archived = await archiveReport(root, report.id, true);
  assert.equal(archived.archived, true);
  assert.ok(archived.archivedAt);
  assert.equal(archived.directory, report.directory);
  assert.equal(archived.prompt, report.prompt);
  assert.equal((await listReports(root))[0].archived, true);
  assert.deepEqual((await downloadReport(root, report.id)).html, originalHtml);
  await assert.rejects(() => archiveReport(root, report.id, 'yes'), /归档/);
  const restored = await archiveReport(root, report.id, false);
  assert.equal(restored.archived, false);
  assert.equal(restored.archivedAt, null);
  assert.deepEqual(
    await fs.readFile(path.join(report.directory, 'journal-snapshot.json')),
    originalSnapshot,
  );
  assert.deepEqual(
    await fs.readFile(path.join(report.directory, 'snapshot.sha256')),
    originalHash,
  );
});

await test('删除只清理选中的报告及副本，源库、原图、其他报告和手工报告全部保留', async () => {
  const { root, store } = await fixture();
  const bytes = await image('png');
  const shot = await store.upload({
    name: 'source.png',
    mime: 'image/png',
    data: bytes.toString('base64'),
  });
  const row = trade({ screenshots: [shot] });
  await store.save([row], 0);
  const first = await prepare(root, store, [row]);
  const second = await prepare(root, store, [row]);
  const manual = path.join(root, 'weekly-reviews', 'legacy-report.html');
  await fs.writeFile(manual, 'KEEP-LEGACY');
  const source = await fs.readFile(path.join(store.directory, 'journal.json'));
  const secondSnapshot = await fs.readFile(
    path.join(second.directory, 'journal-snapshot.json'),
  );
  await archiveReport(root, first.id, true);
  await deleteReport(root, first.id);
  await assert.rejects(() => fs.stat(first.directory), { code: 'ENOENT' });
  await assert.rejects(() => getReport(root, first.id));
  await assert.rejects(() => downloadReport(root, first.id));
  assert.deepEqual(
    (await listReports(root)).map((r) => r.id),
    [second.id],
  );
  assert.deepEqual(
    await fs.readFile(path.join(store.directory, 'journal.json')),
    source,
  );
  assert.deepEqual(await fs.readFile(store.assetPath(shot)), bytes);
  assert.deepEqual(
    await fs.readFile(path.join(second.directory, 'journal-snapshot.json')),
    secondSnapshot,
  );
  assert.equal(await fs.readFile(manual, 'utf8'), 'KEEP-LEGACY');
  await assert.rejects(() => deleteReport(root, '../data'), /编号无效/);
});

await test('独立进程构建时不能归档、删除或重复构建；释放后可正常删除', async () => {
  const { root, store } = await fixture();
  const row = trade();
  await store.save([row], 0);
  const report = await prepare(root, store, [row]);
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL('./fixtures/report-lock-holder.mjs', import.meta.url),
      ),
      root,
      report.id,
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const exited = once(child, 'exit');
  try {
    const ready = await Promise.race([
      once(child.stdout, 'data'),
      exited.then(() => {
        throw new Error('Lock helper exited before acquiring the lock');
      }),
    ]);
    assert.match(ready[0].toString(), /LOCKED/);
    const snapshot = await loadReport(root, report.id);
    await assert.rejects(() => deleteReport(root, report.id), /正在处理/);
    await assert.rejects(
      () => archiveReport(root, report.id, true),
      /正在处理/,
    );
    await assert.rejects(
      () => completeReport(root, report.id, analysisFor(snapshot)),
      /正在处理/,
    );
  } finally {
    child.stdin.end('release\n');
    await exited;
  }
  await deleteReport(root, report.id);
  assert.equal((await listReports(root)).length, 0);
});

await test('锁文件不被自动抢占，链接目录和嵌套链接不能成为递归删除目标', async () => {
  const { root, store } = await fixture();
  const row = trade();
  await store.save([row], 0);
  const report = await prepare(root, store, [row]);
  const lock = await acquireReportLock(root, report.id);
  try {
    await assert.rejects(() => deleteReport(root, report.id), /正在处理/);
  } finally {
    await lock.release();
  }
  const guard = path.join(root, 'outside-report');
  await fs.mkdir(guard);
  const marker = path.join(guard, 'keep.txt');
  await fs.writeFile(marker, 'DO-NOT-DELETE');
  const aliasId = crypto.randomUUID();
  await fs.symlink(
    guard,
    reportDirectory(root, aliasId),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(() => deleteReport(root, aliasId), /链接/);
  await fs.symlink(
    guard,
    path.join(report.directory, 'external'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(() => deleteReport(root, report.id), /链接/);
  assert.equal(await fs.readFile(marker, 'utf8'), 'DO-NOT-DELETE');
  assert.ok((await fs.stat(report.directory)).isDirectory());
});

await test('报告管理 HTTP 接口支持归档/恢复/删除，跨站请求不得修改报告', async () => {
  const { root } = await fixture();
  const app = await createApp({ root });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const row = trade();
    await app.store.save([row], 0);
    const report = await prepare(root, app.store, [row]);
    const request = (method, data, headers = {}) =>
      fetch(`${url}/api/reports/${report.id}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
    assert.equal(
      (
        await request(
          'PATCH',
          { archived: true },
          { Origin: 'https://untrusted.example' },
        )
      ).status,
      403,
    );
    assert.equal(
      (await request('DELETE', undefined, { 'sec-fetch-site': 'cross-site' }))
        .status,
      403,
    );
    assert.equal(
      (await (await request('PATCH', { archived: true })).json()).archived,
      true,
    );
    assert.equal((await (await request('GET')).json()).archived, true);
    assert.equal(
      (await (await request('PATCH', { archived: false })).json()).archived,
      false,
    );
    assert.equal((await request('DELETE')).status, 200);
    assert.equal(
      (await (await fetch(`${url}/api/reports`)).json()).reports.length,
      0,
    );
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});
await test('分类报告遵循现有盈亏口径，持仓观察和缺 R 不充当保本', () => {
  const groups = reportCategoryStats([
    trade({ resultR: 2, discipline: 'yes' }),
    trade({ resultR: 0 }),
    trade({ resultR: null }),
    trade({ status: 'open', resultR: null }),
    trade({ status: 'observing', resultR: null }),
    trade({ category: 'review', resultR: -5 }),
  ]);
  assert.equal(groups[0].closed, 2);
  assert.equal(groups[0].winRate, 50);
  assert.equal(groups[0].sumR, 2);
  assert.equal(groups[0].disciplineRate, 100);
  assert.equal(groups[1].sumR, -5);
});
await test('所选快照不会包含范围外手记，源记录和截图之后变化不影响报告', async () => {
  const { root, store } = await fixture();
  const png = await image('png');
  const shot = await store.upload({
    name: '合成图.png',
    mime: 'image/png',
    data: png.toString('base64'),
  });
  const selected = trade({
    screenshots: [shot],
    notes: { entry: '原始快照', execution: '', lessons: '', improvement: '' },
  });
  const outside = trade({ symbol: 'PRIVATE-UNSELECTED' });
  await store.save([selected, outside], 0);
  const report = await prepare(root, store, [selected]);
  assert.equal(report.status, 'pending');
  const snapshot = await loadReport(root, report.id);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].id, selected.id);
  assert.equal(snapshot.assets.length, 1);
  assert.ok(!JSON.stringify(snapshot).includes(outside.symbol));
  await store.save([outside], 1);
  await fs.writeFile(store.assetPath(shot), 'changed source');
  const completed = await completeReport(
    root,
    report.id,
    analysisFor(snapshot),
  );
  assert.equal(completed.status, 'ready');
  const { html } = await downloadReport(root, report.id);
  assert.ok(html.includes('原始快照'));
  assert.ok(!html.includes(outside.symbol));
  assert.ok(html.includes(png.toString('base64')));
  assert.equal((await listReports(root))[0].status, 'ready');
  const wrong = { ...analysisFor(snapshot), snapshotId: crypto.randomUUID() };
  await assert.rejects(() => completeReport(root, report.id, wrong), /不属于/);
  await assert.rejects(
    () =>
      completeReport(root, report.id, { ...analysisFor(snapshot), trades: [] }),
    /不能遗漏/,
  );
});
await test('空勾选、重复、已删除、越界、过期版本不生成报告；损坏图片不静默跳过', async () => {
  const { root, store } = await fixture();
  const row = trade();
  await store.save([row], 0);
  for (const patch of [
    { recordIds: [] },
    { recordIds: [row.id, row.id] },
    { recordIds: [crypto.randomUUID()] },
    { category: 'review' },
    { revision: 0 },
  ])
    await assert.rejects(() => prepare(root, store, [row], patch));
  assert.equal((await listReports(root)).length, 0);
  assert.throws(() => reportDirectory(root, '../data'), /编号无效/);
  const png = await image('png');
  const shot = await store.upload({
    name: '损坏.png',
    mime: 'image/png',
    data: png.toString('base64'),
  });
  const withShot = { ...row, screenshots: [shot] };
  await store.save([withShot], 1);
  await fs.writeFile(store.assetPath(shot), 'not a png');
  await assert.rejects(() => prepare(root, store, [withShot]), /格式不符/);
  assert.equal((await listReports(root)).length, 0);
});
await test('PNG/JPEG/WebP 原图内嵌可还原，笔记和 AI 文本不能注入 HTML', async () => {
  const { root, store } = await fixture();
  const originals = [];
  const shots = [];
  for (const [format, mime] of [
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'],
  ]) {
    const bytes = await image(format);
    originals.push(bytes);
    shots.push(
      await store.upload({
        name: `截图<script>.${format}`,
        mime,
        data: bytes.toString('base64'),
      }),
    );
  }
  const row = trade({
    screenshots: shots,
    title: '<img src=x onerror=alert(1)>',
    notes: {
      entry: '<script>alert(1)</script>\n第二行',
      execution: '',
      lessons: '',
      improvement: '',
    },
  });
  await store.save([row], 0);
  const report = await prepare(root, store, [row]);
  const snapshot = await loadReport(root, report.id),
    analysis = analysisFor(snapshot);
  analysis.summary = '<script>steal()</script>';
  analysis.reviewedScreenshotIds = [shots[0].id];
  await completeReport(root, report.id, analysis);
  const html = (await downloadReport(root, report.id)).html.toString();
  assert.match(html, /&lt;script&gt;steal\(\)&lt;\/script&gt;/);
  assert.ok(!html.includes('<script>steal()'));
  assert.ok(!html.includes('/api/screenshots/'));
  assert.ok(!html.includes(root));
  assert.match(html, /图表核对：已查看 1 \/ 3/);
  const embedded = [
    ...html.matchAll(
      /src="data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)"/g,
    ),
  ];
  assert.equal(embedded.length, 3);
  assert.equal(
    (html.match(/width="6" height="4" loading="lazy"/g) || []).length,
    3,
  );
  for (let i = 0; i < embedded.length; i++)
    assert.deepEqual(Buffer.from(embedded[i][1], 'base64'), originals[i]);
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.match(html, /Content-Security-Policy/);
});
await test('云端资料只接受选中记录引用的截图，并核对完整性和校验值', async () => {
  const { root, store } = await fixture();
  const bytes = await image('png');
  const shot = {
    id: crypto.randomUUID(),
    mime: 'image/png',
    name: 'cloud.png',
    stage: '入场',
  };
  const row = trade({ screenshots: [shot] });
  const payload = {
    ...scope,
    title: '云端测试',
    source: 'cloud',
    revision: 8,
    baseRiskPercent: 0.25,
    recordIds: [row.id],
    records: [row],
    assets: [
      {
        id: shot.id,
        mime: shot.mime,
        data: bytes.toString('base64'),
        sha256: digest(bytes),
      },
    ],
  };
  await assert.rejects(
    () => createReport(root, store, { ...payload, records: [row, trade()] }),
    /勾选的手记不一致/,
  );
  for (const assets of [
    [],
    [...payload.assets, { ...payload.assets[0], id: crypto.randomUUID() }],
    [{ ...payload.assets[0], sha256: 'wrong' }],
  ])
    await assert.rejects(() =>
      createReport(root, store, { ...payload, assets }),
    );
  const result = await createReport(root, store, payload);
  const snapshot = await loadReport(root, result.id);
  assert.equal(snapshot.sourceRevision, 8);
  assert.equal(snapshot.baseRiskPercent, 0.25);
  assert.equal(store.library.records.length, 0);
  await fs.writeFile(
    path.join(result.directory, snapshot.assets[0].file),
    'changed',
  );
  await assert.rejects(
    () => completeReport(root, result.id, analysisFor(snapshot)),
    /截图发生变化/,
  );
});
await test('云端截图下载在请求前后验证账号，切换登录后不能返回旧账号图片', async () => {
  const owner = crypto.randomUUID(),
    other = crypto.randomUUID();
  let active = owner;
  const bytes = await image('png');
  const mock = {
    auth: {
      getSession: async () => ({
        data: { session: { user: { id: active } } },
        error: null,
      }),
    },
    storage: {
      from: () => ({
        download: async (file) => {
          assert.ok(file.startsWith(owner + '/'));
          active = other;
          return { data: new Blob([bytes]), error: null };
        },
      }),
    },
  };
  const client = new CloudJournalClient(mock, owner, 'test@example.com');
  await assert.rejects(
    () =>
      client.imageBytes({
        id: crypto.randomUUID(),
        mime: 'image/png',
        name: 'test.png',
        stage: '入场',
      }),
    /登录已失效/,
  );
});
await test('报告文件截断或源快照被修改后，不能继续显示完成或下载错误报告', async () => {
  const { root, store } = await fixture();
  const row = trade();
  await store.save([row], 0);
  const report = await prepare(root, store, [row]);
  const snapshot = await loadReport(root, report.id);
  await completeReport(root, report.id, analysisFor(snapshot));
  await fs.writeFile(path.join(report.directory, 'report.html'), '');
  assert.equal((await listReports(root))[0].status, 'pending');
  await assert.rejects(() => downloadReport(root, report.id), /校验失败/);
  await completeReport(root, report.id, analysisFor(snapshot));
  assert.equal((await listReports(root))[0].status, 'ready');
  snapshot.records[0].notes.entry = 'changed';
  await fs.writeFile(
    path.join(report.directory, 'journal-snapshot.json'),
    JSON.stringify(snapshot),
  );
  await assert.rejects(
    () => completeReport(root, report.id, analysisFor(snapshot)),
    /快照已被修改/,
  );
});
await test('本机报告 API 从准备到下载，保留同源限制且不提前宣称 AI 已完成', async () => {
  const { root } = await fixture();
  const app = await createApp({ root });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  try {
    const row = trade();
    await app.store.save([row], 0);
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const rejected = await fetch(`${url}/api/reports`, {
      headers: { Origin: 'https://untrusted.example' },
    });
    assert.equal(rejected.status, 403);
    const response = await fetch(`${url}/api/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...scope,
        title: 'HTTP 合成测试',
        source: 'local',
        revision: 1,
        recordIds: [row.id],
      }),
    });
    assert.equal(response.status, 201);
    const report = await response.json();
    assert.equal(report.status, 'pending');
    assert.notEqual(
      (await fetch(`${url}/api/reports/${report.id}/download`)).status,
      200,
    );
    const snapshot = await loadReport(root, report.id);
    await completeReport(root, report.id, analysisFor(snapshot));
    const download = await fetch(`${url}/api/reports/${report.id}/download`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /^attachment;/);
    assert.equal(download.headers.get('content-security-policy'), 'sandbox');
    assert.match(await download.text(), /HTTP 合成测试/);
    assert.equal(
      (await (await fetch(`${url}/api/reports`)).json()).reports[0].status,
      'ready',
    );
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});
