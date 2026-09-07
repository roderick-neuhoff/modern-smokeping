// SmokePing Modern UI - app shell, router and views.
import { drawSmoke, attachSmokeHover, attachSmokeZoom, drawSpark, fmtMs } from './chart.js';

const API = (location.pathname.replace(/\/modern\/?$/, '') || '') + '/api';
const REFRESH_MS = 15_000;
const FETCH_TIMEOUT_MS = 25_000;

const state = {
  tree: null,
  summary: null,
  alerts: null,
  bySeverity: {},      // path -> severity (from summary)
  collapsed: loadSet('sp.collapsed'),
  silenced: loadSet('sp.silenced'),
  filter: '',
  sort: localStorage.getItem('sp.sort') || 'severity',
  online: true,
};

// --- utilities ------------------------------------------------------

function loadSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); }
  catch { return new Set(); }
}
function saveSet(key, set) {
  try { localStorage.setItem(key, JSON.stringify([...set])); } catch {}
}
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid));
  return n;
}
const SEV_LABEL = { ok: 'OK', warning: 'Warning', critical: 'Critical', down: 'Down', unknown: 'No data' };
const SEV_ORDER = { critical: 0, down: 1, warning: 2, unknown: 3, ok: 4 };

function fmtPct(v) { return v == null ? '–' : (v < 0.5 && v > 0 ? v.toFixed(1) : v.toFixed(0)) + ' %'; }
function ago(ts) {
  if (!ts) return '';
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 90) return s + 's ago';
  if (s < 5400) return Math.round(s / 60) + 'm ago';
  if (s < 172800) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

async function api(path, { retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(API + path, { headers: { accept: 'application/json' }, signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) throw new Error(`${path} -> ${r.status}`);
      return await r.json();
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) await new Promise(res => setTimeout(res, 1200 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// --- data refresh -------------------------------------------------

let refreshing = null;   // in-flight refresh promise, so overlapping triggers coalesce
let lastRefreshAt = 0;
async function refresh() {
  if (refreshing) return refreshing;
  if (Date.now() - lastRefreshAt < 1500) return;   // burst guard (Retry mashing, focus+visibility together)
  lastRefreshAt = Date.now();
  refreshing = (async () => {
    let failed = null;
    try {
      const [summary, alerts] = await Promise.all([
        api('/summary', { retries: 2 }).catch(e => { throw tag(e, '/api/summary'); }),
        api('/alerts',  { retries: 2 }).catch(e => { throw tag(e, '/api/alerts'); }),
      ]);
      state.summary = summary;
      state.alerts = alerts;
      state.bySeverity = {};
      for (const n of summary.nodes) state.bySeverity[n.path] = n.severity;
      setOnline(true);
    } catch (e) {
      failed = e;
      console.warn('refresh failed', e);
      setOnline(false, e);
    }
    try {
      renderStatusPills();
      decorateTree();
      render();          // re-render current view with fresh data
    } catch (e) {
      console.error('render failed', e);   // never let a render bug kill the poll loop
    }
    bumpRefreshClock();
  })();
  try { await refreshing; } finally { refreshing = null; }
}
function tag(e, where) { e.where = where; return e; }

let lastOk = 0;
let lastErr = null;
function setOnline(ok, err) {
  state.online = ok;
  const b = document.getElementById('offlineBanner');
  if (ok) {
    lastOk = Date.now();
    lastErr = null;
    b.hidden = true;
    return;
  }
  lastErr = { at: Date.now(), where: err?.where || '?', msg: (err && (err.message || String(err))) || 'unknown' };
  try { localStorage.setItem('sp.lastErr', JSON.stringify(lastErr)); } catch {}
  const d = document.getElementById('offlineDetail');
  if (d) d.textContent = `${lastErr.where}: ${lastErr.msg} (${new Date(lastErr.at).toLocaleTimeString()})`
    + (lastOk ? ` · last good update ${ago(lastOk / 1000)}` : '');
  b.hidden = false;
}

let refreshDeadline = 0;
function bumpRefreshClock() { refreshDeadline = Date.now() + REFRESH_MS; }
setInterval(() => {
  const left = Math.max(0, Math.round((refreshDeadline - Date.now()) / 1000));
  const rc = document.getElementById('refreshCount');
  rc.textContent = left ? left + 's' : '';
  rc.title = lastOk ? 'last update ' + ago(lastOk / 1000) : '';
  // hidden tabs: keep a slow heartbeat so the page never sits on stale state
  const due = left === 0 || (document.hidden && Date.now() - lastOk > 60_000);
  if (due) { bumpRefreshClock(); refresh(); }
}, 1000);

// Browsers freeze/throttle background tabs (Edge "sleeping tabs", Chromium page
// freezing); an in-flight fetch can be dropped on resume. Refresh on every
// "we are back" signal so a stale banner clears immediately.
for (const ev of ['visibilitychange', 'pageshow', 'focus', 'online', 'resume']) {
  const target = ev === 'resume' || ev === 'visibilitychange' ? document : window;
  target.addEventListener(ev, () => { if (!document.hidden) { bumpRefreshClock(); refresh(); } });
}

// --- status pills ------------------------------------------------

function renderStatusPills() {
  const host = document.getElementById('statusPills');
  const c = (state.summary && state.summary.counts) || {};
  const alertCount = (state.alerts && state.alerts.active || [])
    .filter(a => !state.silenced.has(a.path + '::' + a.alert)).length;
  host.innerHTML = '';
  const defs = [
    ['ok', c.ok || 0, '#/'],
    ['warning', (c.warning || 0), '#/alerts?sev=warning'],
    ['critical', (c.critical || 0), '#/alerts?sev=critical'],
    ['down', (c.down || 0), '#/alerts'],
  ];
  for (const [sev, n, href] of defs) {
    host.append(el('a', {
      class: 'pill' + (n ? '' : ' zero'), 'data-sev': sev, href,
      'aria-label': `${n} ${SEV_LABEL[sev]}`,
    }, el('span', { class: 'dot' }), `${SEV_LABEL[sev]} ${n}`));
  }
  if (alertCount) {
    host.append(el('a', { class: 'pill', 'data-sev': 'critical', href: '#/alerts', 'aria-live': 'polite' },
      el('span', { class: 'dot' }), `${alertCount} alert${alertCount > 1 ? 's' : ''}`));
  }
}

// --- tree -------------------------------------------------------

function renderTree() {
  const host = document.getElementById('tree');
  host.innerHTML = '';
  if (!state.tree) return;
  host.append(treeRow({ name: 'Dashboard', path: '#/', menu: 'Dashboard', _link: '#/' }, 0, true));
  host.append(treeRow({ name: 'Alerts', path: '#/alerts', menu: 'Alerts', _link: '#/alerts' }, 0, true));
  host.append(el('div', { class: 'tree-children', style: 'margin:6px 0;border:0' },
    ...state.tree.root.children.map(c => treeNode(c, 0))));
  decorateTree();
}

function treeNode(node, depth) {
  const kids = node.children || [];
  const hasKids = kids.length > 0;
  const collapsed = state.collapsed.has(node.path);
  const wrap = el('div', { class: 'tree-item' });

  const row = el('button', {
    class: 'tree-row', 'data-path': node.path,
    onclick: (e) => {
      if (hasKids && e.target.closest('.caret')) return toggleCollapse(node.path);
      if (node.isLeaf === true || node.hasData === true) location.hash = '#/node' + node.path;
      else if (hasKids) toggleCollapse(node.path);
    },
  });
  if (hasKids) {
    row.append(el('span', { class: 'caret' + (collapsed ? ' collapsed' : ''), html: caretSvg() }));
  } else {
    row.append(el('span', { class: 'caret', style: 'visibility:hidden' }));
  }
  row.append(el('span', { class: 'sev sev-unknown', 'data-sevdot': node.path }));
  row.append(el('span', { class: 'label' }, node.menu || node.name));
  wrap.append(row);

  if (hasKids) {
    const childBox = el('div', { class: 'tree-children' + (collapsed ? ' collapsed' : '') },
      ...kids.map(k => treeNode(k, depth + 1)));
    wrap.append(childBox);
  }
  return wrap;
}

function treeRow(node, depth, isLink) {
  return el('button', {
    class: 'tree-row', 'data-navlink': node._link,
    onclick: () => { location.hash = node._link; },
  }, el('span', { class: 'caret', style: 'visibility:hidden' }),
     el('span', { class: 'label', style: 'font-weight:600' }, node.menu));
}

function caretSvg() { return '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M9 6l6 6-6 6"/></svg>'; }

function toggleCollapse(path) {
  if (state.collapsed.has(path)) state.collapsed.delete(path);
  else state.collapsed.add(path);
  saveSet('sp.collapsed', state.collapsed);
  renderTree();
}

// worst severity of a subtree, for the coloured dot on parent rows
function subtreeSeverity(node) {
  if (node.isLeaf === true) return state.bySeverity[node.path] || 'unknown';
  let worst = 'ok';
  const kids = node.children || [];
  if (!kids.length) return 'unknown';
  for (const k of kids) {
    const s = subtreeSeverity(k);
    if (SEV_ORDER[s] < SEV_ORDER[worst]) worst = s;
  }
  return worst;
}

function decorateTree() {
  if (!state.tree) return;
  const walk = (node) => {
    const dot = document.querySelector(`[data-sevdot="${cssEsc(node.path)}"]`);
    if (dot) {
      const sev = subtreeSeverity(node);
      dot.className = 'sev sev-' + sev;
      dot.title = SEV_LABEL[sev];
    }
    (node.children || []).forEach(walk);
  };
  state.tree.root.children.forEach(walk);

  const cur = location.hash.startsWith('#/node/') ? location.hash.slice(6) : null;
  document.querySelectorAll('.tree-row').forEach(r => {
    r.classList.toggle('is-current',
      (cur && r.dataset.path === cur) ||
      (r.dataset.navlink && r.dataset.navlink === location.hash));
  });
}
function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'); }

// --- filter search ------------------------------------------------

document.getElementById('search').addEventListener('input', (e) => {
  state.filter = e.target.value.trim().toLowerCase();
  applyFilter();
  if (currentRoute().name === 'dashboard') renderDashboard();
});
function applyFilter() {
  const f = state.filter;
  document.querySelectorAll('#tree .tree-item').forEach(item => {
    const label = item.querySelector('.label')?.textContent.toLowerCase() || '';
    const path = item.querySelector('.tree-row')?.dataset.path?.toLowerCase() || '';
    const self = !f || label.includes(f) || path.includes(f);
    const kidVisible = [...item.querySelectorAll('.tree-item')].some(k => !k.hidden);
    item.hidden = f ? !(self || kidVisible) : false;
  });
}

// --- router -----------------------------------------------------

function currentRoute() {
  const h = location.hash || '#/';
  if (h.startsWith('#/node/')) return { name: 'node', path: h.slice(6).split('?')[0] };
  if (h.startsWith('#/alerts')) {
    const qs = new URLSearchParams(h.split('?')[1] || '');
    return { name: 'alerts', sev: qs.get('sev') || 'all' };
  }
  return { name: 'dashboard' };
}

function render() {
  const r = currentRoute();
  if (r.name === 'node') renderNode(r.path);
  else if (r.name === 'alerts') renderAlerts(r.sev);
  else renderDashboard();
  decorateTree();
  closeDrawer();
}
window.addEventListener('hashchange', render);

// --- dashboard view --------------------------------------------

function renderDashboard() {
  const main = document.getElementById('main');
  const s = state.summary;
  if (!s) { main.innerHTML = '<div class="loading">Loading dashboard…</div>'; return; }

  let nodes = s.nodes.slice();
  const f = state.filter;
  if (f) nodes = nodes.filter(n =>
    n.title.toLowerCase().includes(f) || n.path.toLowerCase().includes(f) ||
    (n.host || '').toLowerCase().includes(f));

  const sorters = {
    severity: (a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || (b.lossNowPct || 0) - (a.lossNowPct || 0) || a.path.localeCompare(b.path),
    name: (a, b) => a.path.localeCompare(b.path),
    loss: (a, b) => (b.lossNowPct || 0) - (a.lossNowPct || 0),
    latency: (a, b) => (b.medianNowMs || 0) - (a.medianNowMs || 0),
    stddev: (a, b) => (b.stddevMs || 0) - (a.stddevMs || 0),
  };
  nodes.sort(sorters[state.sort] || sorters.severity);

  main.innerHTML = '';
  main.append(el('div', { class: 'page-head' },
    el('h1', {}, 'Dashboard'),
    el('span', { class: 'sub' }, `${s.total} targets · updated ${ago(s.generated)}`),
    el('span', { class: 'spacer' }),
    sortControl(),
  ));

  if (!nodes.length) { main.append(el('div', { class: 'empty' }, 'No targets match your filter.')); return; }

  const grid = el('div', { class: 'grid' });
  const draws = [];
  for (const n of nodes) {
    const c = card(n);
    draws.push([c.querySelector('canvas'), n.spark]);
    grid.append(c);
  }
  main.append(grid);
  requestAnimationFrame(() => {
    for (const [cv, spark] of draws) if (cv && spark) drawSpark(cv, spark);
  });
}

function sortControl() {
  const opts = [['severity', 'Status'], ['name', 'Name'], ['loss', 'Loss'], ['latency', 'Latency'], ['stddev', 'Jitter']];
  return el('div', { class: 'seg' }, ...opts.map(([k, label]) =>
    el('button', {
      class: state.sort === k ? 'on' : '',
      onclick: () => { state.sort = k; localStorage.setItem('sp.sort', k); renderDashboard(); },
    }, label)));
}

function card(n) {
  const sev = n.severity || 'unknown';
  const c = el('a', { class: `card sev-left ${sev}`, href: '#/node' + n.path });
  c.append(el('div', { class: 'card-top' },
    el('span', { class: `statusbadge ${sev}` }, el('span', { class: 'dot' }), SEV_LABEL[sev]),
    el('span', { class: 'card-title' }, n.title),
    n.host ? el('span', { class: 'card-host' }, n.host) : null,
  ));
  const cv = el('canvas', { class: 'spark', 'data-sp': n.path });
  c.append(cv);
  c.append(el('div', { class: 'card-stats' },
    el('span', {}, 'median ', el('b', {}, fmtMs(n.medianNowMs))),
    el('span', {}, 'loss ', el('b', {}, fmtPct(n.lossNowPct))),
    n.stddevMs != null ? el('span', {}, 'jitter ', el('b', {}, fmtMs(n.stddevMs))) : null,
  ));
  return c;
}

// --- node detail view -----------------------------------------

const RANGES = ['3h', '30h', '10d', '360d'];
let nodeRange = localStorage.getItem('sp.range') || '3h';
let nodeRO = null;
// zoom window (epoch seconds) for the node currently on screen; null = preset range
let zoom = { path: null, start: null, end: null };

function nodeQuery(path) {
  const qs = new URLSearchParams({ path, range: nodeRange });
  if (zoom.path === path && zoom.start && zoom.end) {
    qs.set('start', zoom.start); qs.set('end', zoom.end);
  }
  return '/node?' + qs.toString();
}

async function renderNode(path) {
  const main = document.getElementById('main');
  if (nodeRO) { nodeRO.disconnect(); nodeRO = null; }
  if (zoom.path !== path) zoom = { path, start: null, end: null };
  const fresh = !main.querySelector('.smokechart');
  if (fresh) main.innerHTML = '<div class="loading">Loading ' + path + ' …</div>';
  let d;
  try { d = await api(nodeQuery(path)); }
  catch (e) {
    if (fresh) main.innerHTML = `<div class="empty">Could not load <code>${path}</code>.<br>${e.message}</div>`;
    return;
  }

  const zoomed = !!(zoom.start && zoom.end);
  const st = d.stats;
  main.innerHTML = '';
  main.append(el('div', { class: 'page-head' },
    el('h1', {}, d.title),
    d.host ? el('span', { class: 'sub' }, d.host + (d.probe ? ' · ' + d.probe : '')) : null,
    el('span', { class: 'spacer' }),
    zoomed ? el('button', {
      class: 'chip on', title: 'Back to the preset range (or double-click the chart)',
      onclick: () => { zoom = { path, start: null, end: null }; renderNode(path); },
    }, '⟲ Reset zoom') : null,
    el('div', { class: 'seg' }, ...RANGES.map(r => el('button', {
      class: (r === nodeRange && !zoomed) ? 'on' : '',
      onclick: () => { nodeRange = r; localStorage.setItem('sp.range', r); zoom = { path, start: null, end: null }; renderNode(path); },
    }, r))),
  ));

  const wrap = el('div', { class: 'chart-wrap', style: 'position:relative' });
  const cv = el('canvas', { class: 'smokechart' });
  const tip = el('div', { class: 'chart-tooltip', hidden: 'hidden' });
  const sel = el('div', { class: 'zoom-sel', hidden: 'hidden' });
  wrap.append(cv, sel, tip);
  const ramp = el('span', { class: 'legend-ramp' },
    ...[0, 1, 2, 3, 4, 5].map(i => el('i', { style: `background:var(--loss-${i})` })));
  wrap.append(el('div', { class: 'chart-legend' },
    el('span', {}, 'median, coloured by loss: ', ramp, '0 % → 100 %'),
    el('span', {}, el('i', { style: 'background:var(--smoke-inner)' }), 'smoke: p20–p80'),
    el('span', {}, el('i', { style: 'background:var(--smoke-outer)' }), 'p10–p90 / min–max'),
    el('span', { class: 'zoom-hint' }, zoomed
      ? `${new Date(d.window.start * 1000).toLocaleString()} – ${new Date(d.window.end * 1000).toLocaleString()}`
      : 'drag on the chart to zoom · double-click to reset'),
  ));
  main.append(wrap);

  const drawNow = () => {
    const geom = drawSmoke(cv, d.series);
    attachSmokeHover(cv, geom, tip);
    attachSmokeZoom(cv, geom, sel,
      (s, e) => { zoom = { path, start: s, end: e }; renderNode(path); },
      () => { zoom = { path, start: null, end: null }; renderNode(path); });
  };
  requestAnimationFrame(drawNow);
  nodeRO = new ResizeObserver(() => drawNow());
  nodeRO.observe(cv);

  main.append(el('div', { class: 'statgrid' },
    stat('Median now', fmtMs(st.medianNowMs)),
    stat('Median avg', fmtMs(st.medianAvgMs)),
    stat('Median min', fmtMs(st.medianMinMs)),
    stat('Median max', fmtMs(st.medianMaxMs)),
    stat('Loss now', fmtPct(st.lossNowPct)),
    stat('Loss avg', fmtPct(st.lossAvgPct)),
    stat('Loss max', fmtPct(st.lossMaxPct)),
    stat('Pings / cycle', d.pings),
  ));

  const nodeAlerts = (state.alerts && state.alerts.active || []).filter(a => a.path === path);
  if (d.alerts && d.alerts.length) {
    const tc = el('div', { class: 'tablecard' }, el('h2', {}, 'Alerts on this target'));
    const tbl = el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, ...['Alert', 'Type', 'Pattern', 'State'].map(h => el('th', {}, h)))));
    const tb = el('tbody');
    for (const name of d.alerts) {
      const act = nodeAlerts.find(a => a.alert === name);
      tb.append(el('tr', {},
        el('td', {}, name),
        el('td', {}, act ? act.type : '–'),
        el('td', {}, act && act.pattern ? el('span', { class: 'pattern' }, act.pattern) : '–'),
        el('td', {}, act
          ? el('span', { class: `statusbadge ${act.severity}` }, el('span', { class: 'dot' }), 'Active')
          : el('span', { class: 'statusbadge ok' }, el('span', { class: 'dot' }), 'Clear')),
      ));
    }
    tbl.append(tb);
    tc.append(el('div', { class: 'table-scroll' }, tbl));
    main.append(tc);
  }

  main.append(el('p', { class: 'note' },
    el('a', { href: d.legacyUrl, target: '_blank', rel: 'noopener' }, 'Open in classic SmokePing ↗')));
}

function stat(k, v) {
  return el('div', { class: 'stat' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, String(v)));
}

// --- alerts view ---------------------------------------------

function renderAlerts(sevFilter) {
  const main = document.getElementById('main');
  const a = state.alerts;
  if (!a) { main.innerHTML = '<div class="loading">Loading alerts…</div>'; return; }

  main.innerHTML = '';
  const active = a.active.slice();
  const shownSev = sevFilter || 'all';

  main.append(el('div', { class: 'page-head' },
    el('h1', {}, 'Alerts'),
    el('span', { class: 'sub' }, `${active.length} active · checked ${ago(a.generated)}`),
  ));

  const sevChips = ['all', 'critical', 'down', 'warning'];
  main.append(el('div', { class: 'alert-filters' },
    ...sevChips.map(s => el('a', {
      class: 'chip' + (shownSev === s ? ' on' : ''),
      href: s === 'all' ? '#/alerts' : '#/alerts?sev=' + s,
    }, s === 'all' ? 'All' : SEV_LABEL[s] || s)),
    el('span', { class: 'spacer', style: 'flex:1' }),
    el('label', { class: 'search' },
      el('input', { type: 'search', placeholder: 'Search alerts', id: 'alertSearch', value: alertSearch })),
  ));

  let rows = active;
  if (shownSev !== 'all') rows = rows.filter(r => r.severity === shownSev || (shownSev === 'down' && r.severity === 'down'));
  if (alertSearch) {
    const q = alertSearch.toLowerCase();
    rows = rows.filter(r => (r.target + r.path + r.alert + (r.comment || '')).toLowerCase().includes(q));
  }

  if (!rows.length) {
    main.append(el('div', { class: 'empty' },
      active.length ? 'No alerts match this filter.' : '✓ All monitored targets are within their alert thresholds.'));
  } else {
    const tbl = el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, ...['', 'Target', 'Alert', 'Type', 'Loss', 'RTT', 'Trend', 'Pattern', ''].map(h => el('th', {}, h)))));
    const tb = el('tbody');
    const sparks = [];
    rows.forEach((r, i) => {
      const key = r.path + '::' + r.alert;
      const muted = state.silenced.has(key);
      const cv = el('canvas', { class: 'minispark' });
      sparks.push([cv, r]);
      tb.append(el('tr', { class: muted ? 'row-muted' : '' },
        el('td', {}, el('span', { class: `statusbadge ${r.severity}` }, el('span', { class: 'dot' }), SEV_LABEL[r.severity] || r.severity)),
        el('td', {}, el('a', { href: '#/node' + r.path }, r.target),
          r.comment ? el('div', { style: 'color:var(--text-faint);font-size:12px' }, r.comment) : null),
        el('td', {}, r.alert),
        el('td', {}, r.type),
        el('td', { class: 'num' }, fmtPct(r.currentLossPct)),
        el('td', { class: 'num' }, fmtMs(r.currentRttMs)),
        el('td', {}, cv),
        el('td', {}, r.pattern ? el('span', { class: 'pattern' }, r.pattern) : '–'),
        el('td', {}, el('button', {
          class: 'chip', onclick: () => {
            if (muted) state.silenced.delete(key); else state.silenced.add(key);
            saveSet('sp.silenced', state.silenced);
            renderAlerts(sevFilter); renderStatusPills();
          },
        }, muted ? 'Unsilence' : 'Silence')),
      ));
    });
    tbl.append(tb);
    main.append(el('div', { class: 'tablecard' },
      el('h2', {}, 'Active alerts'),
      el('div', { class: 'table-scroll' }, tbl)));

    requestAnimationFrame(() => {
      for (const [cv, r] of sparks) drawSpark(cv, seriesFromSamples(r));
    });
  }

  // history
  const hist = a.recent || [];
  const hc = el('div', { class: 'tablecard' }, el('h2', {}, 'Recent history'));
  if (!a.logSource) {
    hc.append(el('p', { class: 'note' },
      'Alert history is unavailable — SmokePing has no alert database. Mount its log file and set ',
      el('span', { class: 'pattern' }, 'SMOKEPING_LOG'), ' to see raise/clear events here.'));
  } else if (!hist.length) {
    hc.append(el('p', { class: 'note' }, 'No alert events found in the log yet.'));
  } else {
    const ul = el('ul', { class: 'timeline' });
    for (const ev of hist.slice(0, 60)) {
      ul.append(el('li', {},
        el('span', { class: 'when' }, ev.time ? new Date(ev.time * 1000).toLocaleString() : '—'),
        el('span', { class: 'ev ' + ev.event }, ev.event),
        el('span', {}, el('strong', {}, ev.alert), ' · ', ev.target)));
    }
    hc.append(ul);
  }
  main.append(hc);

  const si = document.getElementById('alertSearch');
  if (si) si.addEventListener('input', (e) => {
    alertSearch = e.target.value;
    renderAlerts(sevFilter);
    const n = document.getElementById('alertSearch');
    if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
  });
}
let alertSearch = '';

function seriesFromSamples(r) {
  const loss = r.lossSamples || [];
  const rtt = r.rttSamples || [];
  const t = loss.map((_, i) => i);
  return { t, median: rtt, loss, p20: rtt, p50: rtt, p80: rtt, pmax: rtt };
}

// --- drawer / theme -----------------------------------------

function closeDrawer() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('scrim').hidden = true;
  document.getElementById('menuToggle').setAttribute('aria-expanded', 'false');
}
document.getElementById('menuToggle').addEventListener('click', () => {
  const sb = document.getElementById('sidebar');
  const open = sb.classList.toggle('open');
  document.getElementById('scrim').hidden = !open;
  document.getElementById('menuToggle').setAttribute('aria-expanded', String(open));
});
document.getElementById('scrim').addEventListener('click', closeDrawer);
document.getElementById('refreshBtn').addEventListener('click', () => { bumpRefreshClock(); refresh(); });
document.getElementById('offlineRetry').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true; btn.textContent = 'Retrying…';
  try { bumpRefreshClock(); await (booted ? refresh() : boot()); }
  finally { btn.disabled = false; btn.textContent = 'Retry'; }
});

const themeBtn = document.getElementById('themeBtn');
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('sp.theme', t); } catch {}
}
applyTheme(localStorage.getItem('sp.theme') || 'auto');
themeBtn.addEventListener('click', () => {
  const order = ['auto', 'light', 'dark'];
  const next = order[(order.indexOf(document.documentElement.dataset.theme) + 1) % 3];
  applyTheme(next);
  themeBtn.title = 'Theme: ' + next;
  render();
});

// --- boot ---------------------------------------------------

let booted = false;
async function boot() {
  try {
    state.tree = await api('/tree', { retries: 4 });
    document.getElementById('brandOwner').textContent = state.tree.owner || '';
    renderTree();
    setOnline(true);
    booted = true;
  } catch (e) {
    setOnline(false);
    if (!booted) {
      document.getElementById('main').innerHTML =
        `<div class="empty">Waiting for the SmokePing API…<br>` +
        `<code>${API}/tree</code>: ${e.message}<br><br>` +
        `<button class="chip" id="bootRetry">Retry now</button></div>`;
      document.getElementById('bootRetry')?.addEventListener('click', boot);
    }
    setTimeout(boot, 5000);   // keep trying - the container may still be starting
    return;
  }
  await refresh();
  bumpRefreshClock();
}
boot();
