const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ],
  );

export const navigationStyles = `
.trade-navigation{position:fixed;z-index:5;right:8px;top:50%;transform:translateY(-50%);font-size:13px;line-height:1.5}
.trade-nav-panel{width:48px;max-height:min(70vh,680px);max-height:min(70dvh,680px);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;background:#f9fbf7e8;border:1px solid #dce4da;border-radius:10px;padding:5px 0;box-shadow:0 3px 18px #23342c0b}
.trade-nav-list{list-style:none;margin:0;padding:0}.trade-nav-list li+li{margin-top:0}
.trade-nav-link{display:flex;align-items:center;justify-content:center;gap:4px;min-height:30px;padding:4px 3px;text-decoration:none;color:#7d8a80;border-radius:4px;position:relative}
.trade-nav-number{width:17px;text-align:right;font-size:10px;font-variant-numeric:tabular-nums}.trade-nav-mark{width:13px;height:2px;flex:none;border-radius:2px;background:currentColor}.trade-nav-label{display:none}
.trade-nav-link:hover,.trade-nav-link:focus-visible{color:#253f32;background:#e7eee1}.trade-nav-link:focus-visible{outline:2px solid #86ad90;outline-offset:-2px}
.trade-nav-link[aria-current="location"]{color:#315b46;background:#e3ecd9;font-weight:700}.trade-nav-link[aria-current="location"] .trade-nav-mark{height:4px}
.trade-nav-toggle,.trade-nav-heading{display:none}
.trade-nav-tooltip{position:fixed;right:64px;z-index:6;max-width:min(330px,calc(100vw - 88px));padding:9px 13px;background:#253f32;color:#fff;border-radius:7px;box-shadow:0 4px 18px #23342c20;font-size:13px;line-height:1.6;pointer-events:none;overflow-wrap:anywhere}.trade-nav-tooltip[hidden]{display:none}
@media(min-width:901px){body:has(.trade-navigation) .wrap{width:min(1180px,calc(100% - 128px))}}
@media(max-width:900px){
 .trade-navigation{right:16px;top:auto;bottom:max(18px,env(safe-area-inset-bottom));transform:none}
 .trade-nav-toggle{display:flex;align-items:center;gap:8px;min-height:44px;padding:9px 16px;border:1px solid #c7d4c0;border-radius:24px;background:#253f32;color:#fff;box-shadow:0 4px 18px #23342c25;font-size:14px}.trade-nav-toggle span{font-size:12px;opacity:.8}
 .trade-nav-panel{display:none;position:absolute;bottom:56px;right:0;width:min(360px,calc(100vw - 32px));max-height:65vh;max-height:65dvh;padding:10px;background:#fff;box-shadow:0 8px 35px #23342c25;border-radius:12px}
 .trade-navigation[data-open="true"] .trade-nav-panel{display:block}.trade-nav-heading{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:3px 4px 10px;font-weight:600}.trade-nav-close{padding:3px 8px;min-height:36px;background:#f3f5f0;border:1px solid #dce4da;border-radius:6px;color:#315b46;font-size:13px}
 .trade-nav-link{justify-content:flex-start;gap:10px;min-height:48px;padding:8px;border-radius:6px}.trade-nav-number{font-size:12px;width:22px}.trade-nav-mark{width:13px}.trade-nav-label{display:block;font-size:13px;overflow-wrap:anywhere}.trade-nav-tooltip{display:none}
}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.trade-nav-panel{scroll-behavior:auto}}
@media print{.trade-navigation,.trade-nav-tooltip{display:none!important}body:has(.trade-navigation) .wrap{width:100%}}
`;

export function renderTradeNavigation(records) {
  if (!records.length) return '';
  const links = records
    .map((record, index) => {
      const direction = record.direction === 'long' ? '做多' : '做空';
      const description = `手记 ${index + 1} · ${record.date || '未填日期'} ${record.time || ''} · ${record.symbol || '未命名'} · ${direction}`;
      const target = `trade-${record.id}`;
      return `<li><a class="trade-nav-link" href="#${escapeHtml(encodeURIComponent(target))}" data-trade-target="${escapeHtml(target)}" data-trade-label="${escapeHtml(description)}" aria-label="${escapeHtml(description)}"><span class="trade-nav-number" aria-hidden="true">${index + 1}</span><span class="trade-nav-mark" aria-hidden="true"></span><span class="trade-nav-label" aria-hidden="true">${escapeHtml(description)}</span></a></li>`;
    })
    .join('');
  return `<nav class="trade-navigation" aria-label="逐笔手记导航" data-open="false"><button type="button" class="trade-nav-toggle" aria-controls="trade-nav-panel" aria-expanded="false">手记<span>${records.length}</span></button><div class="trade-nav-panel" id="trade-nav-panel"><div class="trade-nav-heading"><span>跳转手记 · ${records.length} 笔</span><button type="button" class="trade-nav-close" aria-label="收起手记目录">收起</button></div><ol class="trade-nav-list">${links}</ol></div></nav><div class="trade-nav-tooltip" aria-hidden="true" hidden></div>`;
}

export const navigationScript = `
(() => {
  const navigation = document.querySelector('.trade-navigation');
  if (!navigation) return;
  const panel = navigation.querySelector('.trade-nav-panel');
  const toggle = navigation.querySelector('.trade-nav-toggle');
  const tooltip = document.querySelector('.trade-nav-tooltip');
  const links = Array.from(navigation.querySelectorAll('[data-trade-target]'));
  const entries = links.map(link => ({ link, article: document.getElementById(link.dataset.tradeTarget) })).filter(entry => entry.article);
  const mobile = window.matchMedia('(max-width: 900px)');
  let activeLink = null;
  let framePending = false;
  let tooltipLink = null;

  const hideTooltip = () => { tooltip.hidden = true; tooltipLink = null; };
  const showTooltip = (link) => {
    if (mobile.matches) return;
    tooltipLink = link;
    tooltip.textContent = link.dataset.tradeLabel;
    tooltip.hidden = false;
    const rect = link.getBoundingClientRect();
    tooltip.style.top = Math.max(8, Math.min(rect.top + rect.height / 2 - tooltip.offsetHeight / 2, window.innerHeight - tooltip.offsetHeight - 8)) + 'px';
  };
  const revealLink = (link) => {
    if (!link || (mobile.matches && navigation.dataset.open !== 'true')) return;
    const containerRect = panel.getBoundingClientRect();
    const linkRect = link.getBoundingClientRect();
    if (linkRect.top < containerRect.top + 8) panel.scrollTop += linkRect.top - containerRect.top - 8;
    else if (linkRect.bottom > containerRect.bottom - 8) panel.scrollTop += linkRect.bottom - containerRect.bottom + 8;
  };
  const updateActive = () => {
    framePending = false;
    const reportNavigation = document.querySelector('.navigation');
    const threshold = (reportNavigation ? reportNavigation.getBoundingClientRect().height : 56) + 36;
    let current = null;
    for (const entry of entries) {
      if (entry.article.getBoundingClientRect().top <= threshold) current = entry.link;
      else break;
    }
    if (current !== activeLink) {
      if (activeLink) activeLink.removeAttribute('aria-current');
      activeLink = current;
      if (activeLink) { activeLink.setAttribute('aria-current', 'location'); revealLink(activeLink); }
    }
    if (tooltipLink) showTooltip(tooltipLink);
  };
  const scheduleUpdate = () => {
    if (framePending) return;
    framePending = true;
    window.requestAnimationFrame(updateActive);
  };
  const setOpen = (open, returnFocus = false) => {
    navigation.dataset.open = String(open);
    toggle.setAttribute('aria-expanded', String(open));
    hideTooltip();
    if (open) {
      const destination = activeLink || links[0];
      if (destination) { destination.focus({ preventScroll: true }); revealLink(destination); }
    } else if (returnFocus) toggle.focus({ preventScroll: true });
  };
  toggle.addEventListener('click', () => setOpen(navigation.dataset.open !== 'true'));
  navigation.querySelector('.trade-nav-close').addEventListener('click', () => setOpen(false, true));
  links.forEach((link, index) => {
    link.addEventListener('mouseenter', () => showTooltip(link));
    link.addEventListener('mouseleave', hideTooltip);
    link.addEventListener('focus', () => showTooltip(link));
    link.addEventListener('blur', hideTooltip);
    link.addEventListener('click', event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      setOpen(false);
      const article = document.getElementById(link.dataset.tradeTarget);
      if (article) {
        article.setAttribute('tabindex', '-1');
        article.focus({ preventScroll: true });
      }
      scheduleUpdate();
    });
    link.addEventListener('keydown', event => {
      let destination = null;
      if (event.key === 'ArrowDown') destination = links[Math.min(index + 1, links.length - 1)];
      else if (event.key === 'ArrowUp') destination = links[Math.max(index - 1, 0)];
      else if (event.key === 'Home') destination = links[0];
      else if (event.key === 'End') destination = links[links.length - 1];
      if (destination) { event.preventDefault(); destination.focus({ preventScroll: true }); revealLink(destination); }
    });
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && navigation.dataset.open === 'true') { event.preventDefault(); setOpen(false, true); }
  });
  document.addEventListener('click', event => {
    if (navigation.dataset.open === 'true' && !navigation.contains(event.target)) setOpen(false);
  });
  panel.addEventListener('scroll', () => { if (tooltipLink) showTooltip(tooltipLink); }, { passive: true });
  window.addEventListener('scroll', scheduleUpdate, { passive: true });
  window.addEventListener('resize', scheduleUpdate, { passive: true });
  window.addEventListener('hashchange', scheduleUpdate);
  document.addEventListener('load', scheduleUpdate, true);
  mobile.addEventListener('change', () => { setOpen(false); scheduleUpdate(); });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(scheduleUpdate).observe(document.body);
  updateActive();
})();
`;
