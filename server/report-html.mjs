import { createHash } from 'node:crypto';
import {
  categoryLabel,
  formatR,
  outcome,
  returnMethod,
  normalizedResultR,
} from '../lib/journal.ts';
import {
  reportCategoryStats,
  validateReportAnalysis,
} from '../lib/journal-report.ts';
import {
  overviewStyles,
  renderOverviewNumbers,
  renderSettlementSection,
  renderTradeSettlement,
} from './report-overview.mjs';
import {
  navigationStyles,
  navigationScript,
  renderTradeNavigation,
} from './report-navigation.mjs';

export const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c],
  );
const esc = escapeHtml;
const percent = (n) => (n === null ? '—' : `${n.toFixed(1)}%`);
const tone = (n) => (n > 0 ? 'positive' : n < 0 ? 'negative' : '');
const script = `
const viewer = document.querySelector('#image-viewer');
document.querySelectorAll('[data-enlarge]').forEach(button => button.addEventListener('click', () => {
  const source = button.querySelector('img');
  const image = viewer.querySelector('img');
  image.src = source.src; image.alt = source.alt;
  viewer.querySelector('p').textContent = source.alt;
  viewer.showModal();
}));
viewer.querySelector('button').addEventListener('click', () => viewer.close());
viewer.addEventListener('click', event => { if (event.target === viewer) viewer.close(); });
document.querySelector('#print-report').addEventListener('click', () => window.print());
${navigationScript}
`;
const css = `
:root{color-scheme:light;--ink:#23342c;--muted:#6a776d;--line:#dce4da;--green:#315b46;--paper:#fff;--bg:#f3f5f0}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:80px}body{margin:0;color:var(--ink);background:var(--bg);font:16px/1.75 'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif}h1,h2,h3,h4,p{margin:0}h1,h2,h3{line-height:1.4}a{color:var(--green);text-underline-offset:4px}button{font:inherit;cursor:pointer}button:focus-visible,a:focus-visible{outline:3px solid #86ad90;outline-offset:4px}.wrap{width:min(1180px,calc(100% - 48px));margin:auto}.cover{background:#253f32;color:#fff;padding:38px 0;border-top:6px solid #a2b68a}.eyebrow{letter-spacing:2px;font-size:12px}.cover-title{display:flex;align-items:start;justify-content:space-between;gap:20px;margin:12px 0}h1{font-size:clamp(28px,4vw,40px)}.cover p{color:#d5dfd4}.cover button{background:transparent;border:1px solid #78927f;border-radius:6px;color:white;padding:7px 14px;white-space:nowrap}.cover-counts{display:flex;gap:34px;margin-top:22px;flex-wrap:wrap}.cover-counts strong{font-size:28px;margin-right:8px;font-variant-numeric:tabular-nums}.cover-counts span{font-size:14px}.navigation{position:sticky;top:0;z-index:2;background:#fffffff5;border-bottom:1px solid var(--line)}.navigation .wrap{display:flex;gap:22px;padding-block:14px;overflow:auto;white-space:nowrap}.navigation a{text-decoration:none;font-size:14px}.section{padding-top:32px}.section>h2{font-size:25px;margin-bottom:16px}.card{background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:26px;margin-bottom:20px}.prose{white-space:pre-wrap;overflow-wrap:anywhere}.muted{color:var(--muted);font-size:14px}.summary-text{font-size:18px}.columns{display:grid;grid-template-columns:1fr 1fr;gap:20px}.columns .card{margin:0}.card h3{font-size:19px;margin-bottom:14px}ul,ol{padding-left:22px;margin:0}li+li{margin-top:14px}.references{display:flex;gap:9px;flex-wrap:wrap;font-size:13px;margin-top:5px}.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse;white-space:nowrap;font-size:14px}th,td{border-bottom:1px solid var(--line);padding:13px 12px;text-align:right}th:first-child,td:first-child{text-align:left}th{font-weight:500;color:var(--muted)}.positive{color:#226a43}.negative{color:#ad514d}.method{margin-top:16px}.curve{width:100%;height:auto;max-height:250px;margin-top:15px}.record{padding:0;overflow:hidden}.record-heading{display:flex;justify-content:space-between;gap:16px;align-items:start;padding:24px 26px 16px}.record-heading h3{margin:4px 0;font-size:22px}.record-heading b{font-size:25px;white-space:nowrap}.badges{display:flex;flex-wrap:wrap;gap:6px;font-size:12px}.badges span{background:#edf2e9;border-radius:4px;padding:2px 8px}.metadata{display:flex;flex-wrap:wrap;gap:12px 25px;padding:14px 26px;border-block:1px solid #edf0e9;font-size:14px}.notes{padding:20px 26px;display:grid;gap:14px}.note{display:grid;grid-template-columns:100px 1fr;gap:16px}.note h4{font-size:14px;color:var(--muted)}.review{background:#f4f7f0;border-top:1px solid var(--line);padding:22px 26px}.review h4{font-size:15px;margin-bottom:10px}.review dl{margin:0;display:grid;gap:12px}.review dt{font-size:13px;color:var(--muted)}.review dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.shots{padding:4px 26px 26px;display:grid;grid-template-columns:1fr 1fr;gap:18px}.shots.single{grid-template-columns:1fr}figure{margin:0;min-width:0}.image-button{display:block;width:100%;padding:0;border:1px solid var(--line);background:#f0f3ed;border-radius:6px;overflow:hidden;position:relative}.image-button img{width:100%;height:auto;display:block}.image-button span{position:absolute;bottom:8px;right:8px;background:#253f32e6;color:white;font-size:12px;padding:2px 8px;border-radius:4px}figcaption{font-size:12px;color:var(--muted);padding-top:6px;overflow-wrap:anywhere}.missing-image{padding:0 26px 20px}.record-index{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px}.record-index a{padding:3px 10px;background:white;border:1px solid var(--line);border-radius:4px;font-size:13px;text-decoration:none}footer{padding:26px 0 40px;font-size:13px;color:var(--muted)}dialog{max-width:96vw;max-height:94vh;padding:16px;border:0;border-radius:8px;background:#f9fbf7}dialog::backdrop{background:#102016dd}dialog img{display:block;max-width:90vw;max-height:78vh;object-fit:contain}dialog button{display:block;margin-left:auto;margin-bottom:10px;background:white;border:1px solid var(--line);border-radius:5px;padding:5px 12px}dialog p{font-size:13px;margin-top:8px}
@media(max-width:700px){.wrap{width:calc(100% - 28px)}.cover{padding:26px 0}.cover-title{flex-direction:column}.columns,.shots{grid-template-columns:1fr}.card{padding:19px}.record{padding:0}.record-heading,.notes,.review{padding:19px}.shots{padding:0 19px 19px}.metadata{padding:12px 19px}.note{grid-template-columns:1fr;gap:3px}.cover-counts{gap:18px}.navigation .wrap{gap:17px}.record-heading b{font-size:21px}}
@media print{body{background:white;font-size:11pt}.wrap{width:100%}.cover{color:#23342c;background:white;border-top:3px solid #315b46;padding:15px 0}.cover p{color:#536659}.cover button,.navigation,.image-button span,.record-index,dialog{display:none!important}.section{padding-top:20px}.card{box-shadow:none;border-radius:0;padding:16px;margin-bottom:15px}.record{padding:0}.shots{grid-template-columns:1fr}.image-button img{max-height:210mm;object-fit:contain}.record-heading,h2,h3,h4{break-after:avoid}figure,.note,.review dl>div,li,tr{break-inside:avoid}a{color:inherit;text-decoration:none}.table-scroll{overflow:visible}table{font-size:9pt}.columns{display:block}.columns .card{margin-bottom:15px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
${overviewStyles}
${navigationStyles}
`;

export function renderReport(
  snapshot,
  analysis,
  images,
  generatedAt = new Date().toISOString(),
  settlement = null,
) {
  validateReportAnalysis(analysis, snapshot);
  const records = snapshot.records;
  const index = new Map(records.map((trade, i) => [trade.id, i + 1]));
  const link = (id) => `<a href="#trade-${esc(id)}">手记 ${index.get(id)}</a>`;
  const findings = (items) =>
    items.length
      ? `<ul>${items.map((f) => `<li><p class="prose">${esc(f.text)}</p><div class="references">${f.tradeIds.map(link).join('')}</div></li>`).join('')}</ul>`
      : '<p class="muted">这份资料暂未形成有充分依据的结论。</p>';
  const base = snapshot.baseRiskPercent ?? null;
  const groups = reportCategoryStats(records, base);
  const groupRows = groups
    .map(
      (g) =>
        `<tr><td>${esc(categoryLabel({ category: g.category === 'unclassified' ? undefined : g.category }))}</td><td>${g.total}</td><td>${g.closed}</td><td>${g.returnCount}</td><td>${g.wins} / ${g.losses} / ${g.flats}</td><td class="${tone(g.sumR)}">${g.returnCount ? `${formatR(g.sumR, 2)} R` : '—'}</td><td>${percent(g.winRate)}</td><td>${g.expectancy === null ? '—' : `${formatR(g.expectancy, 2)} R`}</td><td>${g.returnCount ? `${g.maxDrawdown.toFixed(2)} R` : '—'}</td><td>${g.rated - g.disciplined} 笔</td></tr>`,
    )
    .join('');
  const chartGroup = groups.find((g) => g.category === 'live') || groups[0];
  let curve = '';
  if (chartGroup?.returnCount) {
    const values = [0, ...chartGroup.curve.map((p) => p.total)];
    const low = Math.min(0, ...values),
      high = Math.max(1, ...values);
    const y = (n) => 175 - ((n - low) / (high - low)) * 145;
    const points = values
      .map((n, i) => `${35 + (i / (values.length - 1)) * 830},${y(n)}`)
      .join(' ');
    curve = `<h3>${esc(categoryLabel({ category: chartGroup.category === 'unclassified' ? undefined : chartGroup.category }))}累计 R</h3><svg class="curve" viewBox="0 0 900 210" role="img" aria-label="按入场时间排序的累计 R 曲线"><line x1="35" x2="865" y1="${y(0)}" y2="${y(0)}" stroke="#dce4da"/><polyline points="${points}" fill="none" stroke="#315b46" stroke-width="3"/><text x="35" y="202" font-size="12" fill="#6a776d">起点 0 R</text><text x="865" y="202" text-anchor="end" font-size="12" fill="#6a776d">${formatR(chartGroup.sumR, 2)} R</text></svg>`;
  }
  const reviews = new Map(analysis.trades.map((t) => [t.id, t]));
  const viewed = new Set(analysis.reviewedScreenshotIds);
  const articles = records
    .map((t) => {
      const r = reviews.get(t.id);
      const result =
        t.status === 'closed' && t.resultR !== null
          ? `${formatR(t.resultR, 2)} R`
          : outcome(t);
      const converted = normalizedResultR(t, base);
      const headlineResult =
        converted === null ? '—' : `${formatR(converted, 2)} R`;
      const noteLabels = {
        entry: '进场依据',
        execution: '执行过程',
        lessons: '做对与做错',
        improvement: '下次改进',
      };
      const notes = Object.entries(noteLabels)
        .map(
          ([key, label]) =>
            `<div class="note"><h4>${label}</h4><p class="prose">${esc(t.notes[key] || '未填写')}</p></div>`,
        )
        .join('');
      const imagesHtml = t.screenshots
        .map((shot, i) => {
          const image = images.get(shot.id);
          if (!image || image.mime !== shot.mime)
            throw new Error(`报告缺少截图：${shot.name}`);
          const alt = `手记 ${index.get(t.id)} · ${t.date} ${t.time} · ${t.symbol || '未命名'} · ${shot.stage}图 ${i + 1}`;
          const dimensions =
            Number.isInteger(image.width) &&
            Number.isInteger(image.height) &&
            image.width > 0 &&
            image.height > 0
              ? ` width="${image.width}" height="${image.height}"`
              : '';
          return `<figure><button type="button" class="image-button" data-enlarge aria-label="放大${esc(alt)}"><img src="data:${image.mime};base64,${image.data}" alt="${esc(alt)}"${dimensions} loading="lazy" decoding="async"><span>放大查看</span></button><figcaption>${esc(shot.stage)} · ${esc(shot.name)} · ${viewed.has(shot.id) ? '已查看此截图' : '附图留存，未作图表核对'}</figcaption></figure>`;
        })
        .join('');
      const metadata = [
        `入场打分 ${t.entryScore === undefined || t.entryScore === null ? '未评分' : `${t.entryScore} / 100 分`}`,
        `周期 ${t.timeframe}`,
        `时段 ${t.session || '未标记'}`,
        ...(base === null
          ? []
          : [
              `原始结果 ${result}`,
              `换算收益 ${normalizedResultR(t, base) === null ? '暂不可换算' : `${formatR(normalizedResultR(t, base), 2)} R`}`,
            ]),
        `风险 ${t.riskPercent === null ? '未填写' : `${t.riskPercent}%`}`,
        ...(t.discipline === 'no' ? ['纪律 未遵守'] : []),
        ...[
          ['入场价', t.entryPrice],
          ['止损价', t.stopPrice],
          ['离场价', t.exitPrice],
          ['入场次数', t.entryAttempt],
        ]
          .filter(([, value]) => value !== null)
          .map(([label, value]) => `${label} ${value}`),
      ];
      return `<article class="card record" id="trade-${esc(t.id)}"><header class="record-heading"><div><p class="muted">手记 ${index.get(t.id)} · ${esc(t.date)} ${esc(t.time)}</p><h3>${esc(t.symbol || '未命名')} · ${t.direction === 'long' ? '做多' : '做空'}</h3>${t.title ? `<p>${esc(t.title)}</p>` : ''}<div class="badges"><span>${esc(categoryLabel(t))}</span>${t.tags.map((tag) => `<span>${esc(tag)}</span>`).join('')}</div></div><div class="record-return"><small>${base === null ? '历史原始结果' : '换算收益'}</small><b class="${tone(converted)}">${esc(headlineResult)}</b></div></header><div class="metadata">${metadata.map((value) => `<span>${esc(value)}</span>`).join('')}</div>${renderTradeSettlement(t, settlement)}<div class="notes">${notes}</div>${imagesHtml ? `<div class="shots ${t.screenshots.length === 1 ? 'single' : ''}">${imagesHtml}</div>` : '<p class="missing-image muted">本笔未附截图，无法核对图表结构。</p>'}<section class="review"><h4>AI 辅助复盘</h4><dl><div><dt>记录与观察</dt><dd>${esc(r.observation)}</dd></div><div><dt>分析判断</dt><dd>${esc(r.assessment)}</dd></div><div><dt>可执行改进</dt><dd>${esc(r.improvement)}</dd></div></dl></section></article>`;
    })
    .join('');
  const hash = createHash('sha256').update(script).digest('base64');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>${esc(snapshot.title)} · 盘口手记</title><style>${css}</style></head><body>
<header class="cover"><div class="wrap"><span class="eyebrow">盘口手记 / WEEKLY REVIEW</span><div class="cover-title"><h1>${esc(snapshot.title)}</h1><button id="print-report" type="button">打印 / 保存 PDF</button></div><p>${esc(snapshot.from)} — ${esc(snapshot.to)} · AI 辅助复盘 · 提交老师点评</p><div class="cover-counts"><span><strong>${records.length}</strong>笔手记</span><span><strong>${records.reduce((n, t) => n + t.screenshots.length, 0)}</strong>张附图</span><span><strong>${new Set(records.map((t) => t.date)).size}</strong>个记录日</span></div></div></header>
<nav class="navigation" aria-label="报告目录"><div class="wrap"><a href="#overview">本周总结</a><a href="#statistics">分类统计</a><a href="#actions">下周改进</a><a href="#trades">逐笔手记与截图</a><a href="#questions">请老师点评</a></div></nav>
<main class="wrap"><section class="section" id="overview"><h2>本周总结</h2>${renderOverviewNumbers(snapshot, settlement)}<div class="card"><p class="prose summary-text">${esc(analysis.summary)}</p></div>${renderSettlementSection(settlement, records)}<div class="columns"><div class="card"><h3>做得好的地方</h3>${findings(analysis.strengths)}</div><div class="card"><h3>需要改进的问题</h3>${findings(analysis.problems)}</div></div></section>
<section class="section" id="statistics"><h2>分类统计</h2><div class="card"><div class="table-scroll"><table><thead><tr><th>类别</th><th>手记</th><th>有效平仓</th><th>收益可换算</th><th>盈 / 亏 / 平</th><th>累计 R</th><th>胜率</th><th>平均每笔</th><th>最大回撤</th><th>未遵守纪律</th></tr></thead><tbody>${groupRows}</tbody></table></div><p class="muted method">仅统计本次选中的手记。${esc(returnMethod(base))}实盘、复盘、未分类各自计算；持仓、观察和未填写 R 的平仓记录不计入盈亏，保本计入胜率分母。纪律仅展示明确标记为未遵守的已平仓笔数。曲线和回撤按入场时间排列，不代表账户净值或实际平仓顺序。</p>${curve}</div></section>
<section class="section" id="actions"><h2>下周的执行计划</h2><div class="card"><ol>${analysis.nextWeek.map((s) => `<li class="prose">${esc(s)}</li>`).join('')}</ol></div></section>
<section class="section" id="trades"><h2>逐笔手记与截图</h2><div class="record-index">${records.map((t) => link(t.id)).join('')}</div>${articles}</section>
<section class="section" id="questions"><h2>请老师点评</h2><div class="card"><ol>${analysis.questions.map((s) => `<li class="prose">${esc(s)}</li>`).join('')}</ol></div><div class="card"><h3>分析依据与局限</h3><p class="prose">${esc(analysis.limitations)}</p><p class="muted method">图表核对：已查看 ${viewed.size} / ${snapshot.assets.length} 张不同截图。原始笔记是记录者当时的描述，AI 判断是复盘意见。</p></div></section></main>${renderTradeNavigation(records)}
<footer class="wrap">资料快照：${esc(snapshot.createdAt)} · 报告生成：${esc(generatedAt)}<br>截图和样式已包含在本文件中，可离线阅读。报告基于所选记录，不代表完整账户流水。</footer><dialog id="image-viewer" aria-label="放大截图"><button type="button">关闭 ×</button><img alt=""><p></p></dialog><script>${script}</script></body></html>`;
}
