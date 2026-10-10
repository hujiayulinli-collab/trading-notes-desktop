import test from 'node:test';
import assert from 'node:assert/strict';
import {
  categoryLabel,
  conditionGroups,
  defaultTradeCategory,
  entryConditionsText,
  filterByCategory,
  newTrade,
  reviewPrompt,
  selectEntryConditions,
  stats,
  validateRecords,
} from '../lib/journal.ts';

void test('新建类别以 UTC+8 周末为界，与设备时区或交易日期无关', () => {
  const cases = [
    ['2026-09-04T15:59:59.999Z', 'live'],
    ['2026-09-04T16:00:00.000Z', 'review'],
    ['2026-09-06T15:59:59.999Z', 'review'],
    ['2026-09-06T16:00:00.000Z', 'live'],
    ['2026-09-04T09:00:00-07:00', 'review'],
    ['2026-09-07T01:00:00+09:00', 'live'],
  ];
  for (const [time, expected] of cases) {
    assert.equal(defaultTradeCategory(new Date(time)), expected, time);
    assert.equal(newTrade(new Date(time)).category, expected, time);
  }
  const trade = newTrade(new Date('2026-09-06T01:00:00Z'));
  trade.date = '2026-09-04';
  assert.equal(trade.category, 'review');
  trade.category = 'live';
  validateRecords([trade]);
  assert.equal(trade.category, 'live');
});

void test('进场依据按真实分组排序，合并 FVG 与背离，兼容自定义、多选与空组', () => {
  const groups = conditionGroups();
  groups[3].options.push('4H 看涨');
  groups[2].options.push('等待确认');
  const tags = [
    '1m 吞没FVG',
    '30m FVG',
    '15m 背离',
    '15m 顺势',
    '15m FVG',
    '15m 顺势',
  ];
  assert.equal(
    entryConditionsText(tags, groups),
    '15m 顺势，15m FVG、30m FVG + 15m 背离，1m 吞没FVG',
  );
  assert.equal(
    entryConditionsText(['等待确认', '4H 看涨'], groups),
    '4H 看涨，等待确认',
  );
  assert.equal(entryConditionsText(['1m 吞没FVG'], groups), '1m 吞没FVG');
  assert.equal(
    entryConditionsText(['30m 背离', '旧条件'], groups),
    '30m 背离，其他：旧条件',
  );
  assert.equal(entryConditionsText([], groups), '');
});

void test('连续勾选/取消会更新自动依据，手写补充、主动清空和旧笔记不会被覆盖', () => {
  const groups = conditionGroups();
  let trade = newTrade();
  for (const tags of [
    ['15m FVG'],
    ['15m FVG', '15m 顺势'],
    ['15m 顺势', '15m FVG', '15m 背离', '1m 吞没FVG'],
  ]) {
    trade = { ...trade, ...selectEntryConditions(trade, tags, groups) };
    assert.equal(trade.notes.entry, entryConditionsText(tags, groups));
    assert.equal(trade.entryAutoText, trade.notes.entry);
  }
  const restored = structuredClone(trade);
  const deselected = {
    ...restored,
    ...selectEntryConditions(restored, ['15m 顺势'], groups),
  };
  assert.equal(deselected.notes.entry, '15m 顺势');
  assert.equal(selectEntryConditions(deselected, [], groups).notes.entry, '');
  const handwritten = {
    ...trade,
    entryAutoText: null,
    notes: {
      ...trade.notes,
      entry: trade.notes.entry + '\n等待纽约开盘后确认。',
    },
  };
  const preserved = {
    ...handwritten,
    ...selectEntryConditions(handwritten, ['30m FVG'], groups),
  };
  assert.equal(preserved.notes.entry, handwritten.notes.entry);
  const intentionallyEmpty = {
    ...handwritten,
    notes: { ...handwritten.notes, entry: '' },
  };
  assert.equal(
    selectEntryConditions(intentionallyEmpty, ['15m FVG'], groups).notes,
    undefined,
  );
  const legacy = { ...trade };
  delete legacy.entryAutoText;
  assert.equal(
    selectEntryConditions(legacy, ['15m 顺势'], groups).notes,
    undefined,
  );
  legacy.notes = { ...legacy.notes, entry: '' };
  assert.equal(
    selectEntryConditions(legacy, ['15m 顺势'], groups).notes.entry,
    '15m 顺势',
  );
  const externallyEdited = {
    ...trade,
    notes: { ...trade.notes, entry: '旧客户端补充的进场分析' },
  };
  assert.equal(
    selectEntryConditions(externallyEdited, [], groups).notes,
    undefined,
  );
});

void test('旧记录未分类，类别筛选隔离统计，GPT 资料包含类别且不包含自动标记', () => {
  const live = {
    ...newTrade(),
    category: 'live',
    status: 'closed',
    resultR: 2,
    riskPercent: 1,
  };
  const review = {
    ...newTrade(),
    category: 'review',
    status: 'closed',
    resultR: -1,
    riskPercent: 1,
  };
  const legacy = { ...newTrade(), status: 'closed', resultR: 5 };
  delete legacy.category;
  delete legacy.entryAutoText;
  const records = [live, review, legacy];
  validateRecords(records);
  assert.equal(categoryLabel(legacy), '未分类');
  assert.deepEqual(filterByCategory(records, 'unclassified'), [legacy]);
  assert.equal(stats(filterByCategory(records, 'live')).sumR, 2);
  assert.equal(stats(filterByCategory(records, 'review')).sumR, -1);
  assert.equal(filterByCategory(records, 'all').length, 3);
  const prompt = reviewPrompt(records);
  for (const label of ['实盘', '复盘', '未分类'])
    assert.ok(prompt.includes(`"category": "${label}"`));
  assert.equal(prompt.includes('entryAutoText'), false);
  assert.throws(
    () => validateRecords([{ ...live, category: 'paper' }]),
    /记录类别/,
  );
  assert.throws(
    () => validateRecords([{ ...live, entryAutoText: true }]),
    /自动进场依据/,
  );
});
