import {
  filterByCategory,
  stats,
  validateRecords,
  type CategoryFilter,
  type Trade,
} from './journal.ts';

export const MAX_REPORT_RECORDS = 100;
export const MAX_REPORT_BYTES = 100 * 1024 * 1024;
export type ReportScope = {
  from: string;
  to: string;
  category: CategoryFilter;
};
export type ReportSelection = ReportScope & {
  title: string;
  recordIds: string[];
};
export type ReportInfo = ReportScope & {
  id: string;
  title: string;
  createdAt: string;
  count: number;
  screenshotCount: number;
  archived?: boolean;
  archivedAt?: string | null;
  status: 'pending' | 'running' | 'failed' | 'ready';
  progress?: string;
  error?: string;
  model?: string;
  includeImages?: boolean;
  directory: string;
  prompt: string;
};
export type ReportAsset = {
  id: string;
  mime: string;
  file: string;
  sha256: string;
};
export type ReportSnapshot = ReportScope & {
  format: 'pankou-weekly-review';
  schemaVersion: 1;
  id: string;
  title: string;
  createdAt: string;
  source: 'local' | 'cloud';
  sourceRevision: number;
  baseRiskPercent?: number;
  records: Trade[];
  assets: ReportAsset[];
};
export type ReportFinding = { text: string; tradeIds: string[] };
export type ReportAnalysis = {
  snapshotId: string;
  summary: string;
  strengths: ReportFinding[];
  problems: ReportFinding[];
  nextWeek: string[];
  questions: string[];
  trades: {
    id: string;
    observation: string;
    assessment: string;
    improvement: string;
  }[];
  reviewedScreenshotIds: string[];
  limitations: string;
};
export function validReportDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
export function validateReportScope(scope: ReportScope) {
  if (
    !scope ||
    !validReportDate(scope.from) ||
    !validReportDate(scope.to) ||
    scope.from > scope.to
  )
    throw new Error('请选择有效的起止日期，结束日期不能早于开始日期。');
  if (!['all', 'live', 'review', 'unclassified'].includes(scope.category))
    throw new Error('报告类别无效。');
}
export function reportWeek(now = new Date(), offset = 0) {
  const china = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const monday = new Date(
    Date.UTC(china.getUTCFullYear(), china.getUTCMonth(), china.getUTCDate()),
  );
  monday.setUTCDate(
    monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) + offset * 7,
  );
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  return {
    from: monday.toISOString().slice(0, 10),
    to: sunday.toISOString().slice(0, 10),
  };
}
export function reportRecords(records: Trade[], scope: ReportScope): Trade[] {
  validateReportScope(scope);
  return filterByCategory(records, scope.category)
    .filter((t) => t.date >= scope.from && t.date <= scope.to)
    .sort(
      (a, b) =>
        `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`) ||
        a.id.localeCompare(b.id),
    );
}
export function validateReportRecords(
  records: unknown,
  scope: ReportScope,
): asserts records is Trade[] {
  validateRecords(records);
  if (!records.length || records.length > MAX_REPORT_RECORDS)
    throw new Error(`每份报告请选择 1–${MAX_REPORT_RECORDS} 笔手记。`);
  if (reportRecords(records, scope).length !== records.length)
    throw new Error('所选手记与报告日期或类别不符，请重新选择。');
}
export function reportCategoryStats(records: Trade[], base: number | null = 1) {
  return (['live', 'review', 'unclassified'] as const)
    .map((category) => ({
      category,
      ...stats(filterByCategory(records, category), base),
    }))
    .filter((group) => group.total > 0);
}
export function validateReportAnalysis(
  input: unknown,
  snapshot: ReportSnapshot,
): asserts input is ReportAnalysis {
  const value = input as ReportAnalysis;
  const text = (s: unknown, max = 12000) =>
    typeof s === 'string' && s.trim().length > 0 && s.length <= max;
  if (!value || value.snapshotId !== snapshot.id)
    throw new Error('分析结果不属于这份资料快照。');
  if (!text(value.summary) || !text(value.limitations))
    throw new Error('分析结果须包含总结和资料局限说明。');
  const ids = new Set(snapshot.records.map((t) => t.id));
  for (const findings of [value.strengths, value.problems]) {
    if (
      !Array.isArray(findings) ||
      findings.length > 20 ||
      findings.some(
        (f) =>
          !f ||
          !text(f.text) ||
          !Array.isArray(f.tradeIds) ||
          !f.tradeIds.length ||
          f.tradeIds.length > ids.size ||
          new Set(f.tradeIds).size !== f.tradeIds.length ||
          f.tradeIds.some((id) => !ids.has(id)),
      )
    )
      throw new Error('优点和问题必须引用本次选中的交易 ID。');
  }
  for (const [items, max] of [
    [value.nextWeek, 3],
    [value.questions, 10],
  ] as const) {
    if (
      !Array.isArray(items) ||
      !items.length ||
      items.length > max ||
      items.some((s) => !text(s))
    )
      throw new Error('请填写 1–3 项下周改进，以及 1–10 个向老师请教的问题。');
  }
  if (
    !Array.isArray(value.trades) ||
    value.trades.length !== ids.size ||
    new Set(value.trades.map((t) => t?.id)).size !== ids.size ||
    value.trades.some(
      (t) =>
        !t ||
        !ids.has(t.id) ||
        !text(t.observation) ||
        !text(t.assessment) ||
        !text(t.improvement),
    )
  )
    throw new Error(
      '请为每一笔所选手记填写事实、分析和改进，不能遗漏或引用其他交易。',
    );
  const shots = new Set(snapshot.assets.map((a) => a.id));
  if (
    !Array.isArray(value.reviewedScreenshotIds) ||
    new Set(value.reviewedScreenshotIds).size !==
      value.reviewedScreenshotIds.length ||
    value.reviewedScreenshotIds.some((id) => !shots.has(id))
  )
    throw new Error('已查看截图清单与本次资料包不符。');
}
