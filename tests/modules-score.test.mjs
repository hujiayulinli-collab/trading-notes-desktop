import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  conditionGroups,
  mergeConditionGroups,
  entryConditionsText,
  selectEntryConditions,
  newTrade,
  validateRecords,
  reviewPrompt,
  MAX_CONDITION_GROUPS,
} from '../lib/journal.ts';
import { JournalStore } from '../server/storage.mjs';
import { inspectCloudBackup } from '../lib/journal-backup.ts';

const fixture = async () => {
  await fs.mkdir('test-results', { recursive: true });
  return fs.mkdtemp(path.resolve('test-results/modules-score-'));
};
const customGroups = () => {
  const groups = conditionGroups();
  groups[0].title = 'OB';
  groups[0].options.push('15m OB');
  groups.push({ id: 'liquidity', title: '流动性', options: ['扫前高'] });
  groups.push({ id: 'volume', title: '成交量', options: ['缩量回踩'] });
  return groups;
};

test('旧四模块稳定升级，改名/排序/新增模块不会遗漏自动依据，手写复盘保留', () => {
  const legacy = conditionGroups().map(({ title, options }) => ({
    title,
    options,
  }));
  assert.deepEqual(conditionGroups(legacy), conditionGroups());
  const groups = customGroups();
  const reordered = conditionGroups([
    groups[5],
    groups[0],
    groups[4],
    groups[3],
    groups[2],
    groups[1],
  ]);
  assert.equal(reordered[1].id, 'condition-fvg');
  const tags = [
    '1m 吞没FVG',
    '15m OB',
    '15m 背离',
    '15m 顺势',
    '扫前高',
    '缩量回踩',
    '旧条件',
  ];
  const text = entryConditionsText(tags, reordered);
  assert.equal(
    text,
    '15m 顺势，15m OB + 15m 背离，1m 吞没FVG，缩量回踩，扫前高，其他：旧条件',
  );
  const trade = newTrade();
  assert.equal(selectEntryConditions(trade, tags, reordered).notes.entry, text);
  const handwritten = {
    ...trade,
    notes: { ...trade.notes, entry: '我手写的判断' },
    entryAutoText: null,
  };
  assert.equal(
    selectEntryConditions(handwritten, tags, reordered).notes,
    undefined,
  );
  const withoutOB = reordered.filter((g) => g.id !== 'condition-fvg');
  assert.ok(
    entryConditionsText(tags, withoutOB).includes('其他：15m OB、旧条件'),
  );
});

test('模块数量、名称、编号和条件仍有边界，按模块身份而非下标合并备份', () => {
  assert.deepEqual(conditionGroups([]), []);
  const many = Array.from({ length: MAX_CONDITION_GROUPS }, (_, i) => ({
    title: `模块${i}`,
    options: [`选项${i}`],
  }));
  assert.equal(conditionGroups(many).length, 20);
  assert.throws(
    () => conditionGroups([...many, { title: '超出', options: [] }]),
    /20/,
  );
  for (const groups of [
    [{ title: '', options: [] }],
    [
      { title: 'A', options: [] },
      { title: 'A', options: [] },
    ],
    [
      { id: 'same', title: 'A', options: [] },
      { id: 'same', title: 'B', options: [] },
    ],
    [
      { title: 'A', options: ['条件'] },
      { title: 'B', options: ['条件'] },
    ],
  ])
    assert.throws(() => conditionGroups(groups));
  const current = customGroups();
  const incoming = conditionGroups().reverse();
  incoming.find((g) => g.id === 'condition-fvg').options.push('新入场位置');
  incoming.push({ id: 'extra', title: '形态', options: ['双底'] });
  const merged = mergeConditionGroups(current, incoming);
  assert.equal(merged[0].title, 'OB');
  assert.ok(merged[0].options.includes('新入场位置'));
  assert.equal(merged.at(-1).title, '形态');
  assert.deepEqual(
    current,
    customGroups(),
    'do not mutate the existing settings',
  );
});

test('入场评分允许留空、0、100和小数，旧手记保持未评分，拒绝非法分值', () => {
  for (const score of [undefined, null, 0, 100, 82.5]) {
    const row = { ...newTrade(), entryScore: score };
    assert.doesNotThrow(() => validateRecords([row]));
    assert.ok(reviewPrompt([row]).includes(`"entryScore": ${score ?? 'null'}`));
  }
  for (const score of [-1, 100.1, '80', NaN, Infinity, true])
    assert.throws(
      () => validateRecords([{ ...newTrade(), entryScore: score }]),
      /入场打分/,
    );
  const legacy = newTrade();
  delete legacy.entryScore;
  validateRecords([legacy]);
  assert.equal(legacy.entryScore, undefined);
  assert.equal(newTrade().entryScore, null);
});

test('模块增删改名与评分可保存重开及完整恢复，空记录配置备份同样有效', async () => {
  const root = await fixture();
  const store = await new JournalStore(root).init();
  const groups = customGroups().filter((g) => g.id !== 'condition-divergence');
  const row = { ...newTrade(), entryScore: 0, tags: ['15m 背离', '15m OB'] };
  await store.save([row], 0, groups);
  const reopened = await new JournalStore(root).init();
  assert.deepEqual(reopened.snapshot().conditionGroups, groups);
  assert.equal(reopened.snapshot().records[0].entryScore, 0);
  assert.deepEqual(reopened.snapshot().records[0].tags, row.tags);
  const backup = await store.exportBackup();
  const target = await new JournalStore(await fixture()).init();
  await target.importBackup(backup, 0);
  assert.deepEqual(
    target.snapshot().conditionGroups,
    groups,
    'do not restore deleted default modules',
  );
  assert.equal(target.snapshot().records[0].entryScore, 0);
  const inspected = await inspectCloudBackup(backup, [], conditionGroups());
  assert.deepEqual(inspected.groups, groups);
  assert.equal(inspected.unique[0].entryScore, 0);
  await target.save([{ ...row, entryScore: null }], 1, []);
  const cleared = await new JournalStore(target.root).init();
  assert.deepEqual(cleared.snapshot().conditionGroups, []);
  assert.equal(cleared.snapshot().records[0].entryScore, null);
  const settingsOnly = { ...backup, records: [] };
  const empty = await new JournalStore(await fixture()).init();
  assert.equal((await empty.importBackup(settingsOnly, 0)).added, 0);
  assert.deepEqual(empty.snapshot().conditionGroups, groups);
});

test('云端下载建库文件与迁移源一致', async () => {
  assert.equal(
    await fs.readFile('supabase/setup.sql', 'utf8'),
    await fs.readFile('public/cloud-setup.sql', 'utf8'),
  );
});
