/* oxlint-disable jsx-a11y/prefer-tag-over-role -- The inline SVG data chart has the accessible image role. */
'use client';
import { useMemo, useState } from 'react';
import { TrendingUp, Copy, ChartNoAxesCombined } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Empty, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { Choice } from '@/components/journal-controls';
import { stats, formatR, returnMethod, type Trade } from '@/lib/journal';

export function Statistics({
  records,
  onPrompt,
  demo,
  scopeLabel,
  baseRiskPercent,
}: {
  records: Trade[];
  onPrompt: (rows: Trade[]) => void;
  demo: boolean;
  scopeLabel: string;
  baseRiskPercent: number;
}) {
  const [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [group, setGroup] = useState('symbol');
  const invalid = !!(from && to && from > to);
  const filtered = useMemo(
    () =>
      records.filter((t) => (!from || t.date >= from) && (!to || t.date <= to)),
    [records, from, to],
  );
  const data = stats(filtered, baseRiskPercent);
  const groups = useMemo(() => {
    const buckets: Record<string, Trade[]> = Object.create(null);
    for (const t of filtered) {
      const keys =
        group === 'tags'
          ? t.tags.length
            ? t.tags
            : ['未标记']
          : [
              group === 'symbol'
                ? t.symbol || '未命名'
                : group === 'session'
                  ? t.session
                  : t.discipline === 'yes'
                    ? '遵守计划'
                    : t.discipline === 'no'
                      ? '违反计划'
                      : '未评价',
            ];
      for (const key of new Set(keys)) {
        (buckets[key] ??= []).push(t);
      }
    }
    return Object.entries(buckets)
      .map(([key, rows]) => ({ key, ...stats(rows, baseRiskPercent) }))
      .sort((a, b) => b.closed - a.closed);
  }, [filtered, group, baseRiskPercent]);
  const values = [0, ...data.curve.map((p) => p.total)],
    low = Math.min(...values, 0),
    high = Math.max(...values, 1),
    range = high - low || 1;
  const y = (n: number) => 190 - ((n - low) / range) * 150;
  const points = values.map(
    (v, i) => `${56 + (i / Math.max(values.length - 1, 1)) * 784},${y(v)}`,
  );
  const path = `M${points.join(' L')}`;
  return (
    <main className="statistics-page">
      <div className="stats-title">
        <div>
          <span className="eyebrow">REVIEW YOUR EDGE</span>
          <h2>统计分析</h2>
          <p>
            当前类别：{scopeLabel}。按同一套口径观察交易记录。
            {demo && <span className="demo-badge">示例数据</span>}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => onPrompt(filtered)}
          disabled={!filtered.length}
        >
          <Copy />
          整理此范围复盘资料
        </Button>
      </div>
      <div className="stats-toolbar">
        <label>
          入场日期
          <input
            type="date"
            aria-label="统计起始日期"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <span>至</span>
        <input
          type="date"
          aria-label="统计结束日期"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        <Button
          variant="ghost"
          onClick={() => {
            setFrom('');
            setTo('');
          }}
        >
          全部时间
        </Button>
        <span className="scope-count">
          当前范围 {filtered.length} 笔 · 有效平仓 {data.closed} 笔 · 收益可换算{' '}
          {data.returnCount} 笔
        </span>
      </div>
      {invalid && <p className="inline-warning">结束日期不能早于开始日期。</p>}
      <div className="stats-summary">
        {[
          ['累计 R', formatR(data.returnCount ? data.sumR : null, 2) + ' R'],
          ['胜率', data.winRate === null ? '—' : data.winRate.toFixed(1) + '%'],
          ['平均每笔', formatR(data.expectancy, 2) + ' R'],
          ['平均盈亏比', data.payoff === null ? '—' : data.payoff.toFixed(2)],
          [
            '最大回撤',
            data.returnCount ? data.maxDrawdown.toFixed(2) + ' R' : '—',
          ],
        ].map(([title, value]) => (
          <div key={title}>
            <span>{title}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="stats-charts">
        <section className="chart-panel">
          <div className="panel-heading">
            <div>
              <h3>
                <TrendingUp size={17} />
                累计 R 曲线
              </h3>
              <p>
                基础 1R = {baseRiskPercent}% · 按入场时间排序 ·
                仅包含可换算收益的平仓交易
              </p>
            </div>
            <b className={data.sumR >= 0 ? 'positive' : 'negative'}>
              {formatR(data.returnCount ? data.sumR : null, 2)} R
            </b>
          </div>
          {data.returnCount ? (
            <svg
              className="equity-chart"
              viewBox="0 0 900 240"
              role="img"
              aria-label={`${data.returnCount} 笔可换算平仓交易，累计 ${data.sumR.toFixed(2)} R，最大回撤 ${data.maxDrawdown.toFixed(2)} R`}
            >
              <defs>
                <linearGradient id="equity-fill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#63956d" stopOpacity=".19" />
                  <stop offset="100%" stopColor="#63956d" stopOpacity="0" />
                </linearGradient>
              </defs>
              {[low, low + range / 2, high].map((v, i) => (
                <g key={i}>
                  <line
                    x1="56"
                    x2="840"
                    y1={y(v)}
                    y2={y(v)}
                    stroke="#e5e9e1"
                    strokeDasharray="4 4"
                  />
                  <text x="10" y={y(v) + 4} fontSize="12" fill="#8a9581">
                    {v.toFixed(1)}R
                  </text>
                </g>
              ))}
              <path d={`${path} L840,208 L56,208 Z`} fill="url(#equity-fill)" />
              <path
                d={path}
                fill="none"
                stroke="#4f805b"
                strokeWidth="2.5"
                strokeLinejoin="round"
              />
              {data.curve.map((p, i) => (
                <circle
                  key={p.id}
                  cx={56 + ((i + 1) / Math.max(values.length - 1, 1)) * 784}
                  cy={y(p.total)}
                  r="3.4"
                  fill="#fff"
                  stroke="#4f805b"
                  strokeWidth="2"
                >
                  <title>
                    {p.date} {p.symbol} · 本笔 {formatR(p.r)} R · 累计{' '}
                    {formatR(p.total)} R
                  </title>
                </circle>
              ))}
              <text x="56" y="234" fontSize="12" fill="#8a9581">
                起点 · 0R
              </text>
              <text
                x="840"
                y="234"
                textAnchor="end"
                fontSize="12"
                fill="#8a9581"
              >
                {data.curve.at(-1)?.date}
              </text>
            </svg>
          ) : (
            <Empty className="chart-empty">
              <ChartNoAxesCombined />
              <EmptyTitle>还没有可统计的平仓记录</EmptyTitle>
              <EmptyDescription>
                将交易标记为已平仓，填写结果 R 和大于 0
                的风险比例，曲线会自动生成。
              </EmptyDescription>
            </Empty>
          )}
        </section>
        <section className="distribution-panel">
          <h3>交易结果分布</h3>
          <div
            className="result-ring"
            style={{
              background: data.closed
                ? `conic-gradient(#538362 0 ${(data.wins / data.closed) * 100}%, #c37a72 ${(data.wins / data.closed) * 100}% ${((data.wins + data.losses) / data.closed) * 100}%, #c4c7b9 ${((data.wins + data.losses) / data.closed) * 100}% 100%)`
                : '#e6eadf',
            }}
          >
            <div>
              <strong>{data.closed}</strong>
              <span>有效平仓</span>
            </div>
          </div>
          <div className="legend">
            <span>
              <i className="win-dot" />
              盈利 <b>{data.wins}</b>
            </span>
            <span>
              <i className="loss-dot" />
              亏损 <b>{data.losses}</b>
            </span>
            <span>
              <i className="flat-dot" />
              保本 <b>{data.flats}</b>
            </span>
          </div>
          <p>
            持仓 {data.open} 笔 · 观察 {data.observing} 笔
            {data.incomplete > 0 && ` · 待补 R ${data.incomplete} 笔`}
          </p>
        </section>
      </div>
      <section className="breakdown-panel">
        <div className="panel-heading">
          <div>
            <h3>分组表现</h3>
            <p>
              {group === 'tags'
                ? '一笔交易可有多个条件标签，各组可能重叠。'
                : '查看不同交易分类的实际结果。'}
            </p>
          </div>
          <Choice
            label="统计分组"
            value={group}
            onChange={setGroup}
            options={[
              { value: 'symbol', label: '按交易品种' },
              { value: 'session', label: '按交易时段' },
              { value: 'tags', label: '按入场条件' },
              { value: 'discipline', label: '按交易纪律' },
            ]}
          />
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              {[
                '分组',
                '有效平仓',
                '收益可换算',
                '胜率',
                '累计 R',
                '平均每笔 R',
                '守纪律率',
              ].map((x) => (
                <TableHead key={x}>{x}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((g) => (
              <TableRow key={g.key}>
                <TableCell className="group-name">{g.key}</TableCell>
                <TableCell>{g.closed}</TableCell>
                <TableCell>{g.returnCount}</TableCell>
                <TableCell>
                  {g.winRate === null ? '—' : g.winRate.toFixed(1) + '%'}
                </TableCell>
                <TableCell className={g.sumR >= 0 ? 'positive' : 'negative'}>
                  {formatR(g.returnCount ? g.sumR : null, 2)}
                </TableCell>
                <TableCell>{formatR(g.expectancy, 2)}</TableCell>
                <TableCell>
                  {g.disciplineRate === null
                    ? '—'
                    : `${g.disciplineRate.toFixed(0)}% (${g.disciplined}/${g.rated})`}
                </TableCell>
              </TableRow>
            ))}
            {!groups.length && (
              <TableRow>
                <TableCell colSpan={7} className="no-rows">
                  此日期范围内没有记录。
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </section>
      <div className="stats-definitions">
        <b>统计口径</b>
        <p>
          {returnMethod(baseRiskPercent)} 当前有 {data.missingRisk}{' '}
          笔平仓记录需补填大于 0 的风险比例。
        </p>
        <p>
          胜率 = 盈利笔数 ÷ 有效平仓笔数，保本计入分母；持仓、观察与缺失结果 R
          的交易不计入收益统计。平均盈亏比 = 平均盈利 R ÷ 平均亏损绝对
          R，无盈利或亏损样本时显示“—”。守纪律率仅统计已平仓且已评价的记录。回撤为按入场时间排序的累计
          R 从峰值的最大下降，不代表账户资金回撤。
        </p>
        <p>
          统计描述已有样本，不代表未来表现。
          {data.incomplete > 0 &&
            `当前有 ${data.incomplete} 笔已平仓记录等待补充 R。`}
        </p>
      </div>
    </main>
  );
}
