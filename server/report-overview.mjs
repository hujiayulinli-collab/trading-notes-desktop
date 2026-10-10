import {
  stats,
  categoryLabel,
  filterByCategory,
  formatR,
} from '../lib/journal.ts';
import { reportCategoryStats } from '../lib/journal-report.ts';
import { settlementStats } from '../lib/report-settlement.ts';

const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
const tone = (n) => (n > 0 ? 'positive' : n < 0 ? 'negative' : '');
const money = (n) =>
  n === null
    ? '待核对'
    : `${n > 0 ? '+' : n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const rate = (n) => (n === null ? '—' : `${n.toFixed(2)}%`);
const alias = (symbol) =>
  ({ GC: 'XAUUSD', NQ: 'NDX100' })[symbol.toUpperCase()] ||
  symbol.toUpperCase();
const label = (category) =>
  categoryLabel({
    category: category === 'unclassified' ? undefined : category,
  });

export const overviewStyles = `
.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:20px}.metric{background:#fff;border:1px solid var(--line);border-radius:10px;padding:22px 20px;min-width:0}.metric-label{font-size:14px;color:var(--muted)}.metric-value{display:block;font-size:clamp(25px,2.6vw,35px);font-weight:650;line-height:1.5;font-variant-numeric:tabular-nums;white-space:nowrap}.metric-note{font-size:12px;color:var(--muted);margin-top:5px}.metric-money{border-top:3px solid #6d936e}.metric-heading{margin:0 0 12px;font-size:17px}.overview-scope{font-size:13px;color:var(--muted);margin:0 0 18px}.daily-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:10px;margin:17px 0}.daily-item{padding:12px 14px;background:#f5f8f2;border:1px solid var(--line);border-radius:7px}.daily-item span,.daily-item small{display:block;color:var(--muted);font-size:12px}.daily-item strong{font-size:18px;font-variant-numeric:tabular-nums}.symbol-table td:first-child strong{display:block}.symbol-table td:first-child small{display:block;font-size:11px;color:var(--muted)}.statement-note{border-left:3px solid #acba8e;padding:10px 14px;background:#f5f7f1;font-size:14px;margin-top:15px}.statement-details{margin-top:18px}.statement-details summary{cursor:pointer;color:var(--green);font-weight:600;padding:9px 0}.statement-details table{font-size:12px}.statement-details td:last-child{max-width:290px;min-width:190px;white-space:normal;text-align:left}.statement-sources{display:grid;gap:18px;margin-top:18px}.statement-sources img{max-width:100%;height:auto}.trade-statement{padding:15px 26px;background:#fbfaf4;border-bottom:1px solid #e5e5d9;font-size:13px}.trade-statement h4{font-size:14px;margin:0 0 8px}.trade-statement p+p{margin-top:7px}.trade-statement strong{font-variant-numeric:tabular-nums}.record-return{text-align:right;flex-shrink:0}.record-return small{display:block;color:var(--muted);font-size:12px}.record-return b{display:block}.statement-table-caption{font-size:13px;color:var(--muted);margin:10px 0}.category-block+.category-block{margin-top:22px}
@media(max-width:900px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.metric-value{font-size:29px}}
@media(max-width:480px){.metric{padding:15px 12px}.metric-value{font-size:24px}.metric-note{font-size:11px}.trade-statement{padding:14px 19px}.daily-strip{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media print{.metrics{grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.metric{padding:10px;break-inside:avoid}.metric-value{font-size:20px}.metric-note{font-size:9px}.statement-details{display:block}.statement-sources figure{break-inside:avoid}.daily-strip{grid-template-columns:repeat(5,minmax(0,1fr))}.trade-statement{background:white}.record-return small{font-size:9px}}
`;

const metric = (title, value, note, className = '') =>
  `<div class="metric ${className}"><p class="metric-label">${esc(title)}</p><strong class="metric-value">${value}</strong><p class="metric-note">${esc(note)}</p></div>`;

export function renderOverviewNumbers(snapshot, settlement = null) {
  const groups = reportCategoryStats(
    snapshot.records,
    snapshot.baseRiskPercent ?? null,
  );
  const cash = settlement ? settlementStats(settlement.data) : null;
  const result = groups
    .map((group) => {
      const matchingCash = group.category === 'live' ? cash : null;
      const metrics =
        metric(
          '当周胜率 · 手记记录',
          rate(group.winRate),
          `${group.wins} 盈 / ${group.losses} 亏 / ${group.flats} 保本 · ${group.closed} 笔有效平仓`,
        ) +
        metric(
          '利润 R · 换算收益',
          `<span class="${tone(group.sumR)}">${group.returnCount ? `${formatR(group.sumR, 2)} R` : '—'}</span>`,
          `平均每笔 ${group.expectancy === null ? '—' : `${formatR(group.expectancy, 2)} R`} · ${group.returnCount} 笔可换算`,
        ) +
        metric(
          '收入总额 · 交割净收益',
          `<span class="${tone(matchingCash?.netProfit)}">${matchingCash ? money(matchingCash.netProfit) : '未提供'}</span>`,
          matchingCash
            ? `${matchingCash.orderCount} 条交割记录 · USD · Profit 已含佣金`
            : '需提供交割单；不由 R 数推算金额',
          'metric-money',
        ) +
        metric(
          '未遵守纪律',
          `${group.rated - group.disciplined}<span style="font-size:16px;font-weight:400"> 笔</span>`,
          '仅统计明确标记为未遵守的已平仓手记',
        );
      return `<div class="category-block">${groups.length > 1 ? `<h3 class="metric-heading">${esc(label(group.category))}</h3>` : ''}<div class="metrics">${metrics}</div></div>`;
    })
    .join('');
  return `${result}<p class="overview-scope">当周胜率按所选手记各品种的盈利笔数合计 ÷ 有效平仓笔数合计计算，即按笔数加权，保本计入分母；利润 R 按手记风险换算。${settlement ? '收入采用补充交割单的净收益，已含佣金；交割订单不参与当周胜率计算。' : ''}未评价纪律不视为遵守。</p>${renderSymbolDetails(snapshot, cash)}`;
}

function renderSymbolDetails(snapshot, cash) {
  const groups = reportCategoryStats(
    snapshot.records,
    snapshot.baseRiskPercent ?? null,
  );
  return groups
    .map((group) => {
      const records = filterByCategory(snapshot.records, group.category);
      const symbols = [...new Set(records.map((t) => t.symbol || '未命名'))];
      const usedAliases = new Set();
      const rows = symbols.map((symbol) => {
        const groupStats = stats(
          records.filter((t) => (t.symbol || '未命名') === symbol),
          snapshot.baseRiskPercent ?? null,
        );
        const statementSymbol = alias(symbol);
        const duplicates =
          symbols.filter((s) => alias(s) === statementSymbol).length > 1;
        const amount =
          group.category === 'live' && !duplicates
            ? cash?.symbols.find((s) => s.symbol === statementSymbol)
            : null;
        if (amount) usedAliases.add(statementSymbol);
        return `<tr><td><strong>${esc(symbol)}</strong>${statementSymbol !== symbol ? `<small>交割单 ${esc(statementSymbol)}</small>` : ''}</td><td>${groupStats.total}</td><td>${groupStats.wins} / ${groupStats.losses} / ${groupStats.flats}</td><td>${rate(groupStats.winRate)}</td><td class="${tone(groupStats.sumR)}">${groupStats.returnCount ? `${formatR(groupStats.sumR, 2)} R` : '—'}</td><td>${groupStats.expectancy === null ? '—' : `${formatR(groupStats.expectancy, 2)} R`}</td><td class="${tone(amount?.netProfit)}">${amount ? money(amount.netProfit) : '—'}</td><td>${amount ? amount.orderCount : '—'}</td><td>${amount ? rate(amount.winRate ?? (amount.wins + amount.losses + amount.flats === amount.orderCount ? (amount.wins / amount.orderCount) * 100 : null)) : '—'}</td></tr>`;
      });
      if (group.category === 'live' && cash) {
        for (const amount of cash.symbols.filter(
          (s) => !usedAliases.has(s.symbol),
        )) {
          rows.push(
            `<tr><td><strong>${esc(amount.symbol)}</strong><small>交割单独立统计</small></td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td class="${tone(amount.netProfit)}">${money(amount.netProfit)}</td><td>${amount.orderCount}</td><td>${rate(amount.winRate ?? (amount.wins + amount.losses + amount.flats === amount.orderCount ? (amount.wins / amount.orderCount) * 100 : null))}</td></tr>`,
          );
        }
      }
      return `<div class="card"><h3>${groups.length > 1 ? esc(label(group.category)) + ' · ' : ''}各品种明细</h3><div class="table-scroll"><table class="symbol-table"><thead><tr><th>品种</th><th>手记</th><th>盈 / 亏 / 平</th><th>手记胜率</th><th>利润 R</th><th>平均每笔</th><th>交割净收益 USD</th><th>交割行数</th><th>交割胜率</th></tr></thead><tbody>${rows.join('')}</tbody></table></div><p class="muted method">GC 与 XAUUSD、NQ 与 NDX100 按品种对照展示；图表合约和交割品种的报价可能不同。交割金额包含截图中该品种的全部记录，尚未逐单确认的对应关系见下方核对表。</p></div>`;
    })
    .join('');
}

export function renderSettlementSection(settlement, records) {
  if (!settlement) return '';
  const { data, images } = settlement;
  const index = new Map(records.map((t, i) => [t.id, i + 1]));
  const totals = settlementStats(data);
  const sources = data.sources
    .map((source) => {
      const image = images.get(source.id);
      if (!image) throw new Error('交割来源截图缺失。');
      const dimensions =
        Number.isInteger(image.width) &&
        Number.isInteger(image.height) &&
        image.width > 0 &&
        image.height > 0
          ? ` width="${image.width}" height="${image.height}"`
          : '';
      return `<figure><button type="button" class="image-button" data-enlarge aria-label="放大${esc(source.title)}"><img src="data:${image.mime};base64,${image.data}" alt="${esc(source.title)}"${dimensions} loading="lazy" decoding="async"><span>放大查看</span></button><figcaption>${esc(source.title)} · 用户补充资料</figcaption></figure>`;
    })
    .join('');
  const rows = data.orders
    .map(
      (order) =>
        `<tr><td>${esc(order.id)}</td><td>${esc(order.symbol)} · ${order.direction === 'long' ? '买入' : '卖出'}</td><td>${esc(order.openedAt)}</td><td>${esc(order.closedAt)}</td><td>${esc(order.openPrice)} → ${esc(order.closePrice)}</td><td>${esc(order.lots)}</td><td>${money(order.commission)}</td><td class="${tone(order.netProfit)}">${order.netProfit === null ? `${esc(order.profitText)}（截断）` : money(order.netProfit)}</td><td>${order.tradeIds.map((id) => `<a href="#trade-${esc(id)}">手记 ${index.get(id)}</a>`).join('、') || '无对应手记'}<br>${order.match === 'candidate' ? '候选对应 · ' : ''}${esc(order.note)}</td></tr>`,
    )
    .join('');
  const days = data.daily
    .map(
      (day) =>
        `<div class="daily-item"><span>${esc(day.date)}</span><strong class="${tone(day.netProfit)}">${money(day.netProfit)}</strong><small>${day.orderCount} 条交割记录</small></div>`,
    )
    .join('');
  return `<div class="card" id="settlement"><h3>交割单核对 · USD</h3><p class="muted">${esc(data.sourceLabel)} · ${esc(data.period.from)} — ${esc(data.period.to)}</p><div class="daily-strip">${days}</div><p class="statement-table-caption">${totals.orderCount} 条交割记录合计 <strong class="${tone(totals.netProfit)}">${money(totals.netProfit)}</strong>；佣金合计 ${money(totals.commission)} 已体现在 Profit，未再次扣减。</p><div class="statement-note"><ul>${data.notes.map((note) => `<li>${esc(note)}</li>`).join('')}</ul>${data.aggregateGroups.map((g) => `<p>${esc(g.reason)}：<strong>${money(g.netProfit)}</strong>。</p>`).join('')}</div><details class="statement-details"><summary>查看 ${data.orders.length} 条交割明细与手记对应</summary><div class="table-scroll"><table><thead><tr><th>行号</th><th>品种 / 方向</th><th>开仓时间</th><th>平仓时间</th><th>开仓 → 平仓价</th><th>手数</th><th>佣金（已含）</th><th>净收益 USD</th><th>对应与差异</th></tr></thead><tbody>${rows}</tbody></table></div></details><details class="statement-details"><summary>查看 ${data.sources.length} 张交割来源截图</summary><div class="statement-sources">${sources}</div></details></div>`;
}

export function renderTradeSettlement(trade, settlement) {
  if (!settlement) return '';
  const orders = settlement.data.orders.filter((order) =>
    order.tradeIds.includes(trade.id),
  );
  if (!orders.length) return '';
  return `<aside class="trade-statement"><h4>交割单补充</h4>${orders.map((order) => `<p><strong>${esc(order.symbol)} ${order.direction === 'long' ? '买入' : '卖出'}</strong> · ${esc(order.openedAt)} → ${esc(order.closedAt)} · <strong class="${tone(order.netProfit)}">${order.netProfit === null ? '单笔金额截断，见品种合计' : money(order.netProfit)}</strong><br>成交 ${esc(order.openPrice)} → ${esc(order.closePrice)} · ${esc(order.lots)} 手 · 佣金 ${money(order.commission)}（已含）${order.match === 'candidate' ? '<br>候选对应：' : '<br>'}${esc(order.note)}</p>`).join('')}</aside>`;
}
