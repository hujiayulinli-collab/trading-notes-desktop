import test from 'node:test';
import assert from 'node:assert/strict';
import { newTrade } from '../lib/journal.ts';
import { renderReport } from '../server/report-html.mjs';
import {
  renderOverviewNumbers,
  renderTradeSettlement,
} from '../server/report-overview.mjs';

const makeSnapshot = (records) => ({
  id: crypto.randomUUID(),
  title: '周总结',
  from: '2026-09-14',
  to: '2026-09-20',
  createdAt: '2026-09-19T00:00:00Z',
  baseRiskPercent: 0.5,
  records,
  assets: [],
});
const makeTrade = (patch) => ({
  ...newTrade(),
  category: 'live',
  symbol: 'GC',
  status: 'closed',
  resultR: 1,
  riskPercent: 0.2,
  ...patch,
});
const makeAnalysis = (snapshot) => ({
  snapshotId: snapshot.id,
  summary: '测试复盘',
  strengths: [],
  problems: [],
  nextWeek: ['记录订单'],
  questions: ['如何核对？'],
  trades: snapshot.records.map((t) => ({
    id: t.id,
    observation: '事实',
    assessment: '判断',
    improvement: '改进',
  })),
  reviewedScreenshotIds: [],
  limitations: '测试资料',
});

await test('卡片主收益按基础风险换算，原始结果仍保留；纪律只展示未遵守数量', () => {
  const snapshot = makeSnapshot([
    makeTrade({ discipline: 'no' }),
    makeTrade({
      symbol: 'NQ',
      riskPercent: 0.4,
      resultR: -1,
      discipline: 'yes',
    }),
    makeTrade({ riskPercent: null, resultR: 2 }),
  ]);
  const html = renderReport(snapshot, makeAnalysis(snapshot), new Map());
  const returns = [
    ...html.matchAll(/<div class="record-return">(.*?)<\/div>/g),
  ].map((m) => m[1]);
  assert.match(returns[0], /\+0.40 R/);
  assert.match(returns[1], /-0.80 R/);
  assert.match(returns[2], /—/);
  assert.match(html, /原始结果 \+1.00 R/);
  assert.match(html, /未遵守纪律/);
  assert.match(html, />1 笔<\/td>/);
  assert.doesNotMatch(html, /守纪律率|纪律 遵守|纪律 未评价/);
});

await test('当周胜率按各品种手记笔数加权，交割仅补充金额且不重复扣费', () => {
  const snapshot = makeSnapshot([
    makeTrade({ symbol: 'GBPUSD', resultR: 7, riskPercent: 0.5 }),
    makeTrade({ symbol: 'AUDUSD', resultR: -1, riskPercent: 0 }),
    makeTrade({ symbol: 'AUDUSD', resultR: 0, riskPercent: null }),
    makeTrade({ symbol: 'AUDUSD', resultR: -1, riskPercent: null }),
    makeTrade({ symbol: 'AUDUSD', status: 'open', resultR: 10 }),
  ]);
  const data = {
    orders: [
      {
        id: 'a',
        symbol: 'GBPUSD',
        netProfit: null,
        profitText: '+100…',
        commission: -5,
      },
      {
        id: 'b',
        symbol: 'GBPUSD',
        netProfit: null,
        profitText: '+200…',
        commission: -7,
      },
      { id: 'c', symbol: 'AUDUSD', netProfit: -20, commission: -20 },
    ],
    aggregateGroups: [{ orderIds: ['a', 'b'], netProfit: 320.45 }],
    sources: [],
  };
  const html = renderOverviewNumbers(snapshot, { data });
  assert.match(
    html,
    /当周胜率 · 手记记录<\/p><strong class="metric-value">25.00%<\/strong>/,
  );
  assert.match(html, /1 盈 \/ 2 亏 \/ 1 保本 · 4 笔有效平仓/);
  assert.doesNotMatch(html, /66.67%|50.00%/);
  assert.match(html, /\+7.00 R/);
  assert.match(html, /\+\$300.45/);
  assert.match(html, /\+\$320.45/);
  assert.doesNotMatch(html, /\+\$268.45/);
  assert.match(html, /交割订单不参与当周胜率计算/);
  const row = {
    ...data.orders[0],
    tradeIds: [snapshot.records[0].id],
    direction: 'short',
    openedAt: '2026-09-15 11:15',
    closedAt: '2026-09-15 15:06',
    openPrice: 1.3,
    closePrice: 1.2,
    lots: 1,
    match: 'candidate',
    note: '<img onerror=alert(1)>',
  };
  const card = renderTradeSettlement(snapshot.records[0], {
    data: { orders: [row] },
  });
  assert.match(card, /单笔金额截断，见品种合计/);
  assert.match(card, /候选对应/);
  assert.match(card, /&lt;img onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(card, /<img /);
});

await test('无交割资料时不推算金额，实盘复盘类别分别统计', () => {
  const snapshot = makeSnapshot([
    makeTrade({ resultR: 2, riskPercent: 0.5 }),
    makeTrade({ category: 'review', resultR: -10, riskPercent: 0.5 }),
  ]);
  const html = renderOverviewNumbers(snapshot);
  assert.match(html, /实盘/);
  assert.match(html, /复盘/);
  assert.match(html, /\+2.00 R/);
  assert.match(html, /-10.00 R/);
  assert.doesNotMatch(html, /-8.00 R/);
  assert.match(html, /未提供/);
});
