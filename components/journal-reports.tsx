'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays,
  Check,
  Copy,
  Download,
  FileText,
  LoaderCircle,
  RefreshCw,
  Archive,
  ArchiveRestore,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Choice } from '@/components/journal-controls';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import {
  categoryLabel,
  formatR,
  outcome,
  type CategoryFilter,
  type Trade,
} from '@/lib/journal';
import { localRequest } from '@/lib/journal-client';
import {
  MAX_REPORT_RECORDS,
  reportRecords,
  reportWeek,
  type ReportInfo,
  type ReportScope,
  type ReportSelection,
} from '@/lib/journal-report';

type Props = {
  active: boolean;
  records: Trade[];
  connected: boolean;
  busy: boolean;
  authorize: () => Promise<void>;
  prepare: (selection: ReportSelection) => Promise<ReportInfo>;
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : '操作失败，请重试。';
export function WeeklyReports({
  active,
  records,
  connected,
  busy,
  authorize,
  prepare,
}: Props) {
  const [range, setRange] = useState(() => reportWeek());
  const [category, setCategory] = useState<CategoryFilter>('live');
  const [title, setTitle] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string> | null>(null);
  const [reports, setReports] = useState<ReportInfo[]>([]);
  const [prepared, setPrepared] = useState<ReportInfo | null>(null);
  const [copied, setCopied] = useState('');
  const [error, setError] = useState('');
  const listVersion = useRef(0);
  const refreshRequest = useRef(0);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [progress, setProgress] = useState('');
  const [historyView, setHistoryView] = useState<'current' | 'archived'>(
    'current',
  );
  const [mutating, setMutating] = useState('');
  const mutationGuard = useRef(false);
  const [deleteTarget, setDeleteTarget] = useState<ReportInfo | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [historyNotice, setHistoryNotice] = useState('');
  const visibleReports = reports.filter(
    (report) => !!report.archived === (historyView === 'archived'),
  );
  const archivedCount = reports.filter((report) => report.archived).length;
  const remember = (report: ReportInfo) => {
    listVersion.current++;
    setReports((previous) =>
      [report, ...previous.filter((r) => r.id !== report.id)].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
    );
  };
  const scope: ReportScope = { ...range, category };
  const selection = useMemo(() => {
    try {
      return {
        records: reportRecords(records, { ...range, category }),
        error: '',
      };
    } catch (e) {
      return { records: [], error: message(e) };
    }
  }, [records, range, category]);
  const selected = selection.records.filter(
    (t) => selectedIds === null || selectedIds.has(t.id),
  );
  const defaultTitle = `交易周总结 · ${range.from} — ${range.to}`;
  const changeRange = (next: { from: string; to: string }) => {
    setRange(next);
  };
  const refresh = useCallback(async () => {
    const version = listVersion.current;
    const requestId = ++refreshRequest.current;
    setLoading(true);
    setError('');
    try {
      await authorize();
      const result = await localRequest<{ reports: ReportInfo[] }>(
        '/api/reports',
      );
      await authorize();
      if (
        version === listVersion.current &&
        requestId === refreshRequest.current
      ) {
        setReports(result.reports);
        setPrepared((previous) =>
          previous
            ? result.reports.find(
                (report) => report.id === previous.id && !report.archived,
              ) || null
            : null,
        );
      }
    } catch (e) {
      if (
        version === listVersion.current &&
        requestId === refreshRequest.current
      )
        setError(
          `无法读取本机报告，请确认已用启动程序打开手记；更新后可重新启动。${message(e)}`,
        );
    } finally {
      if (requestId === refreshRequest.current) setLoading(false);
    }
  }, [authorize]);
  useEffect(() => {
    if (connected && active) void refresh();
  }, [connected, active, refresh]);
  const copy = async (report: ReportInfo) => {
    setPrepared(report);
    setCopied('');
    setError('');
    try {
      await authorize();
      await navigator.clipboard.writeText(report.prompt);
      setCopied(report.id);
    } catch {
      setError('无法自动复制，请在下方选中复盘指令后手动复制。');
    }
  };
  const create = async () => {
    if (creating || mutationGuard.current) return;
    setCreating(true);
    listVersion.current++;
    setError('');
    setProgress('正在保存手记并整理截图…');
    try {
      const result = await prepare({
        ...scope,
        title: title.trim() || defaultTitle,
        recordIds: selected.map((t) => t.id),
      });
      remember(result);
      setHistoryView('current');
      setPrepared(result);
      setCopied('');
      setProgress('资料已准备好。复制下方指令，发给 Codex 开始复盘。');
    } catch (e) {
      setError(message(e));
      setProgress('');
    } finally {
      setCreating(false);
    }
  };
  const changeReport = async (
    report: ReportInfo,
    action: 'archive' | 'restore' | 'delete',
  ) => {
    if (mutationGuard.current || creating) return;
    mutationGuard.current = true;
    setMutating(report.id);
    listVersion.current++;
    setError('');
    setDeleteError('');
    setHistoryNotice('');
    try {
      await authorize();
      if (action === 'delete') {
        await localRequest(`/api/reports/${report.id}`, 'DELETE');
        await authorize();
        listVersion.current++;
        setReports((previous) =>
          previous.filter((entry) => entry.id !== report.id),
        );
        setDeleteTarget(null);
      } else {
        const updated = await localRequest<ReportInfo>(
          `/api/reports/${report.id}`,
          'PATCH',
          { archived: action === 'archive' },
        );
        await authorize();
        remember(updated);
      }
      if (action !== 'restore') {
        setPrepared((previous) =>
          previous?.id === report.id ? null : previous,
        );
        setCopied((previous) => (previous === report.id ? '' : previous));
        setProgress('');
      }
      setHistoryNotice(
        action === 'delete'
          ? '报告资料已删除，原始手记和截图未受影响。'
          : action === 'archive'
            ? '报告已归档，可在“已归档”中查看和恢复。'
            : '报告已恢复到“当前报告”。',
      );
    } catch (e) {
      if (action === 'delete')
        setDeleteError(`${message(e)}请取消后刷新报告状态，核对操作结果。`);
      else setError(`${message(e)}请刷新报告状态核对。`);
    } finally {
      listVersion.current++;
      mutationGuard.current = false;
      setMutating('');
    }
  };
  const download = async (report: ReportInfo) => {
    setError('');
    try {
      await authorize();
      const response = await fetch(`/api/reports/${report.id}/download`);
      if (!response.ok) {
        const result = (await response.json()) as { error?: string };
        throw new Error(result.error || '报告下载失败。');
      }
      const blob = await response.blob();
      await authorize();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `盘口手记-${report.from}-${report.to}.html`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <main className="weekly-page">
      <div className="weekly-heading">
        <div>
          <span className="eyebrow">REVIEW & SHARE</span>
          <h2>周总结</h2>
          <p>挑选手记，交给 Codex 复盘，再把带截图的 HTML 发给老师。</p>
        </div>
        <span className="weekly-format">
          <FileText size={18} />
          单文件 HTML · 可离线阅读
        </span>
      </div>
      <ol className="weekly-steps" aria-label="周总结步骤">
        <li>
          <b>01</b>选择手记
        </li>
        <li>
          <b>02</b>复制指令到 Codex
        </li>
        <li>
          <b>03</b>下载报告发给老师
        </li>
      </ol>
      {error && (
        <p className="weekly-error" role="alert">
          {error}
        </p>
      )}
      <section className="weekly-card" aria-labelledby="weekly-selection-title">
        <div className="weekly-section-heading">
          <h3 id="weekly-selection-title">
            <CalendarDays size={18} />
            选择本次总结范围
          </h3>
          <span>按手记中的入场日期筛选，包含起止两天</span>
        </div>
        <div className="weekly-toolbar">
          <label>
            开始日期
            <input
              type="date"
              aria-label="报告开始日期"
              value={range.from}
              onChange={(e) => changeRange({ ...range, from: e.target.value })}
            />
          </label>
          <label>
            结束日期
            <input
              type="date"
              aria-label="报告结束日期"
              value={range.to}
              onChange={(e) => changeRange({ ...range, to: e.target.value })}
            />
          </label>
          <label>
            记录类别
            <Choice
              label="报告记录类别"
              value={category}
              options={[
                { value: 'live', label: '实盘' },
                { value: 'review', label: '复盘' },
                { value: 'all', label: '全部类别' },
                { value: 'unclassified', label: '未分类' },
              ]}
              onChange={(v) => {
                setCategory(v as CategoryFilter);
              }}
            />
          </label>
          <div className="weekly-shortcuts">
            <Button
              variant="outline"
              size="sm"
              onClick={() => changeRange(reportWeek())}
            >
              本周
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => changeRange(reportWeek(new Date(), -1))}
            >
              上周
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!records.length}
              onClick={() => {
                const dates = records.map((t) => t.date).sort();
                changeRange({ from: dates[0], to: dates.at(-1)! });
              }}
            >
              全部时间
            </Button>
          </div>
        </div>
        {selection.error && (
          <p className="weekly-error" role="alert">
            {selection.error}
          </p>
        )}
        <div className="weekly-selection-bar">
          <span>
            范围内 {selection.records.length} 笔 ·{' '}
            <strong>已选 {selected.length} 笔</strong> ·{' '}
            {selected.reduce((n, t) => n + t.screenshots.length, 0)} 张截图
          </span>
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedIds(null)}
            >
              全选范围
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedIds(new Set())}
            >
              取消全选
            </Button>
          </div>
        </div>
        <div
          className="weekly-records"
          role="region"
          aria-label="选择用于周总结的手记"
          tabIndex={0}
        >
          {selection.records.map((t) => (
            <label className="weekly-record" key={t.id}>
              <Checkbox
                aria-label={`选择 ${t.date} ${t.time} ${t.symbol || '未命名'} ${categoryLabel(t)}`}
                checked={selectedIds === null || selectedIds.has(t.id)}
                onCheckedChange={(checked) =>
                  setSelectedIds((previous) => {
                    const next = new Set(
                      previous ?? selection.records.map((row) => row.id),
                    );
                    if (checked) next.add(t.id);
                    else next.delete(t.id);
                    return next;
                  })
                }
              />
              <span className="weekly-record-date">
                {t.date}
                <small>
                  {t.time} · {t.timeframe}
                </small>
              </span>
              <span className="weekly-record-name">
                <strong>
                  {t.symbol || '未命名'}{' '}
                  <span
                    className={`category-badge category-${t.category ?? 'unclassified'}`}
                  >
                    {categoryLabel(t)}
                  </span>
                </strong>
                <small>{t.title || t.notes.entry || '未填写进场依据'}</small>
              </span>
              <span className="weekly-shot-count">
                {t.screenshots.length} 张图
              </span>
              <span
                className={`weekly-result ${t.resultR && t.resultR > 0 ? 'positive' : t.resultR && t.resultR < 0 ? 'negative' : ''}`}
              >
                {t.status === 'closed' && t.resultR !== null
                  ? `${formatR(t.resultR)} R`
                  : outcome(t)}
              </span>
            </label>
          ))}
          {!selection.records.length && (
            <p className="weekly-empty">
              {selection.error
                ? '请先调整日期。'
                : '这个范围内还没有手记，可以调整日期或类别。'}
            </p>
          )}
        </div>
        <label className="weekly-title-input">
          报告标题
          <input
            aria-label="周总结标题"
            value={title}
            maxLength={120}
            placeholder={defaultTitle}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <div className="weekly-create">
          <p>
            最多 {MAX_REPORT_RECORDS} 笔，含截图的资料不超过 100
            MB。不同类别分别统计。
            <br />
            资料包与报告保存在本机，包含你勾选的原始笔记和截图。
            准备资料无需填写 API 密钥，AI 分析在 Codex 中完成。
          </p>
          <Button
            onClick={() => void create()}
            disabled={
              !connected ||
              busy ||
              creating ||
              !!mutating ||
              !selected.length ||
              !!selection.error ||
              selected.length > MAX_REPORT_RECORDS
            }
          >
            {creating ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <FileText />
            )}
            {creating ? '正在整理资料…' : '准备 Codex 复盘资料'}
          </Button>
        </div>
        {selected.length > MAX_REPORT_RECORDS && (
          <p className="weekly-error" role="alert">
            已超过 {MAX_REPORT_RECORDS} 笔，请缩小范围或取消部分勾选。
          </p>
        )}
        {progress && (
          <p className="weekly-progress" role="status">
            {progress}
          </p>
        )}
      </section>
      {prepared && (
        <section
          className="weekly-card weekly-handoff"
          aria-labelledby="weekly-handoff-title"
        >
          <div className="weekly-section-heading">
            <h3 id="weekly-handoff-title">把这段指令发给 Codex</h3>
            <Button
              variant="outline"
              disabled={
                !connected || !!mutating || prepared.status === 'running'
              }
              onClick={() => void copy(prepared)}
            >
              {copied === prepared.id ? <Check /> : <Copy />}
              {copied === prepared.id ? '已复制' : '复制复盘指令'}
            </Button>
          </div>
          <p>
            在当前项目的 Codex 对话中发送。Codex
            会读取所选手记与截图、分析交易并生成
            HTML；完成后回来刷新报告状态即可下载。
          </p>
          <textarea
            aria-label="发送给 Codex 的复盘指令"
            value={prepared.prompt}
            readOnly
            rows={5}
            onFocus={(e) => e.target.select()}
          />
          <small>资料已保存；发送指令后才会开始 AI 分析。</small>
        </section>
      )}
      <section className="weekly-card" aria-labelledby="weekly-history-title">
        <div className="weekly-section-heading">
          <h3 id="weekly-history-title">本机报告</h3>
          <Button
            variant="outline"
            size="sm"
            disabled={loading || creating || !!mutating || !connected}
            onClick={() => void refresh()}
          >
            <RefreshCw className={loading ? 'animate-spin' : ''} />
            刷新报告状态
          </Button>
        </div>
        <p className="weekly-history-note">
          这里保留本机准备过的资料快照。以后修改原手记，不会改动已准备的报告。
          已准备过的资料可以直接复制复盘指令，无需重新整理。
        </p>
        <div
          className="weekly-history-filter"
          role="group"
          aria-label="报告归档筛选"
        >
          <Button
            variant={historyView === 'current' ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={historyView === 'current'}
            onClick={() => setHistoryView('current')}
          >
            当前报告 {reports.length - archivedCount}
          </Button>
          <Button
            variant={historyView === 'archived' ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={historyView === 'archived'}
            onClick={() => setHistoryView('archived')}
          >
            <Archive size={16} />
            已归档 {archivedCount}
          </Button>
        </div>
        {historyNotice && (
          <p className="weekly-progress" role="status">
            {historyNotice}
          </p>
        )}
        {visibleReports.length ? (
          <div className="weekly-history">
            {visibleReports.map((report) => (
              <article key={report.id}>
                <div>
                  <h4>{report.title}</h4>
                  <p>
                    {report.from} — {report.to} · {report.count} 笔 ·{' '}
                    {report.screenshotCount} 张图
                  </p>
                  <span className={`weekly-status ${report.status}`}>
                    {report.status === 'ready'
                      ? '报告已完成'
                      : report.status === 'running'
                        ? '已有分析正在运行，请稍后刷新'
                        : '待 Codex 复盘'}
                  </span>
                </div>
                <div className="weekly-report-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={
                      !connected || !!mutating || report.status === 'running'
                    }
                    onClick={() => void copy(report)}
                  >
                    {copied === report.id ? <Check /> : <Copy />}
                    {copied === report.id ? '已复制' : '复盘指令'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      !connected || !!mutating || report.status !== 'ready'
                    }
                    onClick={() => void download(report)}
                  >
                    <Download />
                    下载 HTML
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={
                      !connected ||
                      busy ||
                      creating ||
                      !!mutating ||
                      report.status === 'running'
                    }
                    onClick={() =>
                      void changeReport(
                        report,
                        report.archived ? 'restore' : 'archive',
                      )
                    }
                  >
                    {mutating === report.id ? (
                      <LoaderCircle className="animate-spin" />
                    ) : report.archived ? (
                      <ArchiveRestore />
                    ) : (
                      <Archive />
                    )}
                    {report.archived ? '恢复' : '归档'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="weekly-delete-button"
                    disabled={
                      !connected ||
                      busy ||
                      creating ||
                      !!mutating ||
                      report.status === 'running'
                    }
                    onClick={() => {
                      setDeleteError('');
                      setDeleteTarget(report);
                    }}
                  >
                    <Trash2 />
                    删除
                  </Button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="weekly-empty">
            {loading
              ? '正在读取报告…'
              : historyView === 'archived'
                ? '暂无归档报告。归档后的报告仍可下载，也可以恢复。'
                : archivedCount
                  ? '当前没有报告，可在“已归档”中查看，或准备一份新的复盘资料。'
                  : '准备第一份复盘资料后，会显示在这里。'}
          </p>
        )}
      </section>
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !mutationGuard.current) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent className="weekly-delete-dialog">
          <AlertDialogTitle>永久删除这份报告？</AlertDialogTitle>
          <AlertDialogDescription>
            “{deleteTarget?.title}”的
            HTML、分析结果、手记快照及截图副本将从本机删除，无法在页面恢复。原始手记、原图和你已下载到其他位置的文件不受影响。只想收起报告时，请使用归档。
          </AlertDialogDescription>
          {deleteError && (
            <p className="weekly-error" role="alert">
              {deleteError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!mutating}>取消</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={!!mutating || !connected}
              onClick={() => {
                if (deleteTarget) void changeReport(deleteTarget, 'delete');
              }}
            >
              {mutating ? '正在删除…' : '永久删除'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
