import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  newTrade,
  stats,
  normalizedResultR,
  baseRiskPercent,
  reviewPrompt,
} from '../lib/journal.ts';
import { reportCategoryStats } from '../lib/journal-report.ts';
import { JournalStore } from '../server/storage.mjs';
import { createApp } from '../server/index.mjs';

const row = (resultR, riskPercent, i = 1) => ({
  ...newTrade(),
  status: 'closed',
  resultR,
  riskPercent,
  date: `2026-09-${String(i).padStart(2, '0')}`,
});
const fixture = async () => {
  await fs.mkdir('test-results', { recursive: true });
  return fs.mkdtemp(path.resolve('test-results/base-risk-'));
};

test('收益按基础 R 换算，均值/回撤/分组一致，原始结果和胜率不变', () => {
  const records = [
    [2, 0.5],
    [-1, 2],
    [3, 1],
    [0, 1],
    [10, null],
    [-1, 0],
  ].map(([r, risk], i) => row(r, risk, i + 1));
  const original = structuredClone(records);
  const s = stats(records, 1);
  assert.deepEqual(
    s.curve.map((p) => p.r),
    [1, -2, 3, 0],
  );
  assert.equal(s.sumR, 2);
  assert.equal(s.expectancy, 0.5);
  assert.equal(s.maxDrawdown, 2);
  assert.equal(s.closed, 6);
  assert.equal(s.returnCount, 4);
  assert.equal(s.missingRisk, 2);
  assert.equal(s.winRate, 50);
  assert.equal(s.payoff, 1);
  assert.equal(s.profitFactor, 2);
  const half = stats(records, 0.5);
  assert.equal(half.sumR, 4);
  assert.equal(half.expectancy, 1);
  assert.equal(half.maxDrawdown, 4);
  for (const key of ['winRate', 'payoff', 'profitFactor', 'disciplineRate'])
    assert.equal(s[key], half[key]);
  assert.deepEqual(records, original);
  assert.equal(
    reportCategoryStats(records, 0.5).reduce((n, g) => n + g.sumR, 0),
    half.sumR,
  );
  assert.equal(normalizedResultR(row(-1, 2), 1), -2);
  assert.equal(
    stats(records, null).sumR,
    13,
    'historical reports retain original R',
  );
  const prompt = reviewPrompt([row(-1, 2)], 0.5);
  assert.match(prompt, /基础 1R = 0.5%/);
  assert.match(prompt, /累计 R：-4.00/);
  assert.match(prompt, /"resultR": -1/);
});

test('无风险不充当零收益，未平仓/缺结果不统计，非法基准不能进入统计', () => {
  const records = [
    row(2, null),
    row(-1, 0),
    row(0, null),
    row(null, 2),
    { ...row(null, 2), status: 'open' },
    { ...row(null, 2), status: 'observing' },
  ];
  const s = stats(records);
  assert.equal(s.returnCount, 0);
  assert.equal(s.missingRisk, 3);
  assert.equal(s.expectancy, null);
  assert.deepEqual(s.curve, []);
  assert.equal(s.closed, 3);
  assert.equal(s.incomplete, 1);
  assert.equal(s.open, 1);
  assert.equal(s.observing, 1);
  assert.equal(stats([row(0, 1)]).returnCount, 1);
  for (const base of [0, -1, NaN, Infinity, '1', null, 0.00001, 101])
    assert.throws(() => baseRiskPercent(base), /基础 R/);
  assert.throws(() => stats([], 0), /基础 R/);
  assert.equal(baseRiskPercent(), 1);
});

test('旧库默认 1%，设置单独保存，备份/迁移保留；合并导入不改本库基准', async () => {
  const root = await fixture();
  await fs.mkdir(path.join(root, 'data'));
  await fs.writeFile(
    path.join(root, 'data/journal.json'),
    JSON.stringify({ schemaVersion: 1, revision: 0, records: [] }),
  );
  const store = await new JournalStore(root).init();
  assert.equal(store.snapshot().baseRiskPercent, 1);
  const trade = row(-1, 2);
  await store.save([trade], 0, undefined, 0.5);
  await store.save([trade], 1, undefined, 2);
  assert.equal(
    (await new JournalStore(root).init()).snapshot().baseRiskPercent,
    2,
  );
  await assert.rejects(() => store.save([trade], 2, undefined, 0), /基础 R/);
  assert.equal(store.snapshot().revision, 2);
  const backup = await store.exportBackup();
  assert.equal(backup.baseRiskPercent, 2);
  const targetRoot = await fixture();
  const target = await new JournalStore(targetRoot).init();
  await target.importBackup(backup, 0);
  assert.equal(target.snapshot().baseRiskPercent, 2);
  assert.deepEqual(target.snapshot().records[0], trade);
  await target.save(target.snapshot().records, 1, undefined, 0.25);
  await target.importBackup(backup, 2);
  assert.equal(target.snapshot().baseRiskPercent, 0.25);
  assert.equal(target.snapshot().revision, 2);
  const legacyBackup = { ...backup };
  delete legacyBackup.baseRiskPercent;
  const legacyTarget = await new JournalStore(await fixture()).init();
  await legacyTarget.importBackup(legacyBackup, 0);
  assert.equal(legacyTarget.snapshot().baseRiskPercent, 1);
  const moved = await fixture();
  await target.migrate(moved, 2);
  assert.equal(target.snapshot().baseRiskPercent, 0.25);
  const diskPath = path.join(store.directory, 'journal.json');
  const disk = JSON.parse(await fs.readFile(diskPath, 'utf8'));
  disk.baseRiskPercent = 3;
  await fs.writeFile(diskPath, JSON.stringify(disk));
  await assert.rejects(() => store.save([trade], 2), /其他程序修改/);
});

test('页面读写接口保存基础 R，旧客户端省略值时保留，非法值不覆盖', async (t) => {
  const root = await fixture();
  const { store, server } = await createApp({ root });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await store.unlock();
  });
  const url = `http://127.0.0.1:${server.address().port}/api/journal`;
  const put = (data) =>
    fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  assert.equal(
    (
      await (
        await put({ records: [row(-1, 2)], revision: 0, baseRiskPercent: 0.5 })
      ).json()
    ).baseRiskPercent,
    0.5,
  );
  assert.equal(
    (
      await (
        await put({ records: store.snapshot().records, revision: 1 })
      ).json()
    ).baseRiskPercent,
    0.5,
  );
  assert.equal(
    (await put({ records: [], revision: 2, baseRiskPercent: 0 })).ok,
    false,
  );
  const snapshot = await (await fetch(url)).json();
  assert.equal(snapshot.revision, 2);
  assert.equal(snapshot.baseRiskPercent, 0.5);
  assert.equal(snapshot.records[0].resultR, -1);
});
