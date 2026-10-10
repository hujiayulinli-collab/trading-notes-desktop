import { validReportDate, type ReportSnapshot } from './journal-report.ts';

export const MAX_SETTLEMENT_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_SETTLEMENT_BYTES = 64 * 1024 * 1024;
export const MAX_SETTLEMENT_ORDERS = 1000;
export const MAX_SETTLEMENT_SOURCES = 20;

export type SettlementOrder = {
  id: string;
  symbol: string;
  direction: 'long' | 'short';
  openedAt: string;
  closedAt: string;
  openPrice: number;
  closePrice: number;
  lots: number;
  commission: number;
  netProfit: number | null;
  profitText: string;
  tradeIds: string[];
  match: 'matched' | 'candidate' | 'unmatched';
  note: string;
};
export type ReportSettlement = {
  snapshotId: string;
  currency: 'USD';
  sourceLabel: string;
  period: { from: string; to: string };
  reportedNetProfit: number;
  daily: { date: string; orderCount: number; netProfit: number }[];
  orders: SettlementOrder[];
  aggregateGroups: { orderIds: string[]; netProfit: number; reason: string }[];
  notes: string[];
  sources: {
    id: string;
    file: string;
    mime: 'image/png';
    sha256: string;
    title: string;
  }[];
};
export type SettlementSymbolStats = {
  symbol: string;
  orderCount: number;
  netProfit: number;
  commission: number;
  wins: number;
  losses: number;
  flats: number;
};
export type SettlementStats = Omit<SettlementSymbolStats, 'symbol'> & {
  winRate: number | null;
  symbols: SettlementSymbolStats[];
};

const text = (value: unknown, max = 6000, empty = false): value is string =>
  typeof value === 'string' &&
  value.length <= max &&
  (empty || value.trim().length > 0);
const object = (value: unknown, keys: string[]) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const boundedArray = (
  value: unknown,
  max: number,
  min = 0,
): value is unknown[] =>
  Array.isArray(value) && value.length >= min && value.length <= max;
const amount = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  Math.abs(value) <= 1_000_000_000 &&
  Math.abs(value * 100 - Math.round(value * 100)) < 0.00001;
const cents = (value: number) => Math.round(value * 100);
const positive = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value > 0 &&
  value <= 1_000_000_000_000;
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d$/.test(value) &&
  validReportDate(value.slice(0, 10));
const rowId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);

export function validateSettlement(
  input: unknown,
  snapshot: ReportSnapshot,
): asserts input is ReportSettlement {
  const value = input as ReportSettlement;
  if (
    !object(value, [
      'snapshotId',
      'currency',
      'sourceLabel',
      'period',
      'reportedNetProfit',
      'daily',
      'orders',
      'aggregateGroups',
      'notes',
      'sources',
    ]) ||
    value.snapshotId !== snapshot.id ||
    value.currency !== 'USD' ||
    !text(value.sourceLabel, 300)
  )
    throw new Error('交割补充格式、币种或快照引用无效。');
  if (
    !object(value.period, ['from', 'to']) ||
    !validReportDate(value.period.from) ||
    !validReportDate(value.period.to) ||
    value.period.from > value.period.to ||
    Date.parse(value.period.to) - Date.parse(value.period.from) > 365 * 86400000
  )
    throw new Error('交割补充日期范围无效，最多包含 366 天。');
  if (
    !amount(value.reportedNetProfit) ||
    !boundedArray(value.daily, 366, 1) ||
    !boundedArray(value.orders, MAX_SETTLEMENT_ORDERS, 1) ||
    !boundedArray(value.aggregateGroups, MAX_SETTLEMENT_ORDERS) ||
    !boundedArray(value.notes, 30) ||
    value.notes.some((note) => !text(note)) ||
    !boundedArray(value.sources, MAX_SETTLEMENT_SOURCES, 1)
  )
    throw new Error('交割补充金额、说明或项目数量无效。');

  const tradeIds = new Set(snapshot.records.map((trade) => trade.id));
  const orders = new Map<string, SettlementOrder>();
  const dayTotals = new Map<string, { count: number; profit: number }>();
  for (const order of value.orders) {
    if (
      !object(order, [
        'id',
        'symbol',
        'direction',
        'openedAt',
        'closedAt',
        'openPrice',
        'closePrice',
        'lots',
        'commission',
        'netProfit',
        'profitText',
        'tradeIds',
        'match',
        'note',
      ]) ||
      !rowId(order.id) ||
      orders.has(order.id) ||
      !text(order.symbol, 40) ||
      order.symbol !== order.symbol.trim() ||
      !['long', 'short'].includes(order.direction) ||
      !timestamp(order.openedAt) ||
      !timestamp(order.closedAt) ||
      order.closedAt < order.openedAt ||
      order.openedAt.slice(0, 10) < value.period.from ||
      order.openedAt.slice(0, 10) > value.period.to ||
      !positive(order.openPrice) ||
      !positive(order.closePrice) ||
      !positive(order.lots) ||
      !amount(order.commission) ||
      (order.netProfit !== null && !amount(order.netProfit)) ||
      !text(order.profitText, 200, true) ||
      !text(order.note, 6000, true)
    )
      throw new Error('交割订单 ID 重复，或日期、价格、金额等字段无效。');
    if (
      !boundedArray(order.tradeIds, tradeIds.size) ||
      new Set(order.tradeIds).size !== order.tradeIds.length ||
      order.tradeIds.some((id) => !tradeIds.has(id)) ||
      !['matched', 'candidate', 'unmatched'].includes(order.match) ||
      (order.match === 'unmatched'
        ? order.tradeIds.length !== 0
        : !order.tradeIds.length)
    )
      throw new Error('交割订单只能引用本次快照手记，匹配状态须与引用一致。');
    orders.set(order.id, order);
    const date = order.openedAt.slice(0, 10);
    const day = dayTotals.get(date) || { count: 0, profit: 0 };
    day.count++;
    if (order.netProfit !== null) day.profit += cents(order.netProfit);
    dayTotals.set(date, day);
  }

  const grouped = new Set<string>();
  for (const group of value.aggregateGroups) {
    if (
      !object(group, ['orderIds', 'netProfit', 'reason']) ||
      !boundedArray(group.orderIds, value.orders.length, 2) ||
      !amount(group.netProfit) ||
      !text(group.reason)
    )
      throw new Error('裁剪订单聚合组格式或金额无效。');
    let first: SettlementOrder | undefined;
    for (const id of group.orderIds) {
      const order = orders.get(id);
      if (
        !order ||
        order.netProfit !== null ||
        grouped.has(id) ||
        (first &&
          (first.symbol !== order.symbol ||
            first.openedAt.slice(0, 10) !== order.openedAt.slice(0, 10)))
      )
        throw new Error(
          '聚合组只能覆盖同品种、同开仓日期且收益缺失的未重复订单。',
        );
      first ||= order;
      grouped.add(id);
    }
    dayTotals.get(first!.openedAt.slice(0, 10))!.profit += cents(
      group.netProfit,
    );
  }
  if (
    value.orders.some(
      (order) => order.netProfit === null && !grouped.has(order.id),
    )
  )
    throw new Error('收益缺失的订单必须由可核对的聚合组覆盖。');

  const dates = new Set<string>();
  let total = 0;
  for (const day of value.daily) {
    if (
      !object(day, ['date', 'orderCount', 'netProfit']) ||
      !validReportDate(day.date) ||
      day.date < value.period.from ||
      day.date > value.period.to ||
      dates.has(day.date) ||
      !Number.isSafeInteger(day.orderCount) ||
      day.orderCount < 0 ||
      day.orderCount > MAX_SETTLEMENT_ORDERS ||
      !amount(day.netProfit)
    )
      throw new Error('交割日汇总日期重复，或笔数、金额无效。');
    const expected = dayTotals.get(day.date) || { count: 0, profit: 0 };
    if (
      expected.count !== day.orderCount ||
      expected.profit !== cents(day.netProfit)
    )
      throw new Error('交割日汇总与订单笔数或净利润合计不符。');
    dates.add(day.date);
    total += cents(day.netProfit);
  }
  if (
    [...dayTotals.keys()].some((date) => !dates.has(date)) ||
    total !== cents(value.reportedNetProfit)
  )
    throw new Error('交割总计与每日净利润合计不符，或遗漏了订单日期。');

  const sourceIds = new Set<string>();
  for (const source of value.sources) {
    if (
      !object(source, ['id', 'file', 'mime', 'sha256', 'title']) ||
      !/^source-[1-9]\d{0,2}$/.test(source.id) ||
      sourceIds.has(source.id) ||
      source.file !== `settlement/${source.id}.png` ||
      source.mime !== 'image/png' ||
      !/^[a-f0-9]{64}$/.test(source.sha256) ||
      !text(source.title, 300)
    )
      throw new Error('交割原图 ID、路径、格式或 SHA-256 校验值无效。');
    sourceIds.add(source.id);
  }
  if (
    new TextEncoder().encode(JSON.stringify(value)).length >
    MAX_SETTLEMENT_JSON_BYTES
  )
    throw new Error('交割补充数据超过 2 MB。');
}

// Cropped decimals may retain an unambiguous sign. Never infer a sign from
// aggregate profit: a positive group can still contain a losing order.
function profitSign(order: SettlementOrder): number | null {
  if (order.netProfit !== null) return Math.sign(cents(order.netProfit));
  const visible = order.profitText.trim().replace(/,/g, '');
  if (!/^[+-]?\d+(?:\.\d*)?(?:…|\.{3}|\?+)?$/.test(visible)) return null;
  const prefix = Number.parseFloat(visible);
  return Number.isFinite(prefix) && prefix !== 0 ? Math.sign(prefix) : null;
}

export function settlementStats(data: ReportSettlement): SettlementStats {
  const symbols = new Map<string, SettlementSymbolStats>();
  let unknown = false;
  for (const order of data.orders) {
    const group = symbols.get(order.symbol) || {
      symbol: order.symbol,
      orderCount: 0,
      netProfit: 0,
      commission: 0,
      wins: 0,
      losses: 0,
      flats: 0,
    };
    group.orderCount++;
    // Profit already includes commission. Keep fees separate; do not deduct twice.
    if (order.netProfit !== null) group.netProfit += cents(order.netProfit);
    group.commission += cents(order.commission);
    const sign = profitSign(order);
    if (sign === null) unknown = true;
    else if (sign > 0) group.wins++;
    else if (sign < 0) group.losses++;
    else group.flats++;
    symbols.set(order.symbol, group);
  }
  const orders = new Map(data.orders.map((order) => [order.id, order]));
  for (const aggregate of data.aggregateGroups) {
    const order = orders.get(aggregate.orderIds[0])!;
    symbols.get(order.symbol)!.netProfit += cents(aggregate.netProfit);
  }
  const result: SettlementStats = {
    orderCount: data.orders.length,
    netProfit: 0,
    commission: 0,
    wins: 0,
    losses: 0,
    flats: 0,
    winRate: null,
    symbols: [],
  };
  for (const group of symbols.values()) {
    result.netProfit += group.netProfit;
    result.commission += group.commission;
    result.wins += group.wins;
    result.losses += group.losses;
    result.flats += group.flats;
    result.symbols.push({
      ...group,
      netProfit: group.netProfit / 100,
      commission: group.commission / 100,
    });
  }
  result.netProfit /= 100;
  result.commission /= 100;
  result.winRate =
    !unknown && result.orderCount
      ? (result.wins / result.orderCount) * 100
      : null;
  return result;
}
