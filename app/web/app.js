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
  acks: {},             // server-side acknowledgements: key -> {until, note, by}
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

async function api(path, { retries = 1, method = 'GET', body = null, timeout = FETCH_TIMEOUT_MS } = {}) {
  let lastErr;
  const write = method !== 'GET';
  if (write) retries = 0;                       // never replay a write
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const headers = { accept: 'application/json' };
      if (write) { headers['content-type'] = 'application/json'; headers['x-requested-with'] = 'modern-smokeping'; }
      const auth = sessionAuth();
      if (auth) headers['authorization'] = 'Basic ' + auth;
      const r = await fetch(API + path, { method, headers, body: body == null ? undefined : JSON.stringify(body), signal: ctrl.signal });
      clearTimeout(timer);
      let data = null;
      try { data = await r.json(); } catch { /* non-JSON error page */ }
      if (!r.ok) {
        const err = new Error((data && data.error) || `${path} -> ${r.status}`);
        err.status = r.status; err.data = data;
        throw err;
      }
      return data;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) await new Promise(res => setTimeout(res, 1200 * (attempt + 1)));
    }
  }
  throw lastErr;
}
const post = (path, body, opts = {}) => api(path, { method: 'POST', body, timeout: 90_000, ...opts });

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
      const [summary, alerts, acks] = await Promise.all([
        api('/summary', { retries: 2 }).catch(e => { throw tag(e, '/api/summary'); }),
        api('/alerts',  { retries: 2 }).catch(e => { throw tag(e, '/api/alerts'); }),
        api('/acks').catch(() => null),          // optional - older API or auth hiccup
      ]);
      state.summary = summary;
      state.alerts = alerts;
      if (acks && acks.acks) state.acks = acks.acks;
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
      render(true);      // re-render current view with fresh data (skipped on Settings)
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
let autoRefresh = localStorage.getItem('sp.auto') !== 'off';
function bumpRefreshClock() { refreshDeadline = Date.now() + REFRESH_MS; }
// auto-refresh is suspended on Settings so it can never wipe a half-filled form
function autoRefreshActive() {
  const r = currentRoute().name;
  if (r === 'wall') return true;          // a wallboard must always be live - the pause button isn't visible there
  return autoRefresh && r !== 'settings';
}
setInterval(() => {
  const left = Math.max(0, Math.round((refreshDeadline - Date.now()) / 1000));
  const rc = document.getElementById('refreshCount');
  const active = autoRefreshActive();
  rc.textContent = !autoRefresh ? 'paused' : (!active ? 'off here' : (left ? left + 's' : ''));
  rc.title = (lastOk ? 'last update ' + ago(lastOk / 1000) : '') + (autoRefresh ? '' : ' · auto-refresh paused');
  if (!active) return;
  // hidden tabs: keep a slow heartbeat so the page never sits on stale state
  const due = left === 0 || (document.hidden && Date.now() - lastOk > 60_000);
  if (due) { bumpRefreshClock(); refresh(); }
}, 1000);

function setAutoRefresh(on, silent) {
  autoRefresh = on;
  try { localStorage.setItem('sp.auto', on ? 'on' : 'off'); } catch {}
  const b = document.getElementById('pauseBtn');
  b.classList.toggle('is-paused', !on);
  b.title = on ? 'Pause auto-refresh' : 'Resume auto-refresh';
  b.setAttribute('aria-pressed', String(!on));
  if (on && !silent) { bumpRefreshClock(); refresh(); }
}
document.getElementById('pauseBtn').addEventListener('click', () => setAutoRefresh(!autoRefresh));
setAutoRefresh(autoRefresh, true);

// Browsers freeze/throttle background tabs (Edge "sleeping tabs", Chromium page
// freezing); an in-flight fetch can be dropped on resume. Refresh on every
// "we are back" signal so a stale banner clears immediately.
for (const ev of ['visibilitychange', 'pageshow', 'focus', 'online', 'resume']) {
  const target = ev === 'resume' || ev === 'visibilitychange' ? document : window;
  target.addEventListener(ev, () => { if (!document.hidden && autoRefreshActive()) { bumpRefreshClock(); refresh(); } });
}

// --- status pills ------------------------------------------------

function renderStatusPills() {
  const host = document.getElementById('statusPills');
  const c = (state.summary && state.summary.counts) || {};
  const alertCount = (state.alerts && state.alerts.active || [])
    .filter(a => !isAcked(a)).length;
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
  host.append(treeRow({ name: 'Wall', path: '#/wall', menu: 'Wall display', _link: '#/wall' }, 0, true));
  host.append(treeRow({ name: 'Settings', path: '#/settings', menu: 'Settings', _link: '#/settings' }, 0, true));
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
    const nav = r.dataset.navlink;
    r.classList.toggle('is-current',
      (cur && r.dataset.path === cur) ||
      (nav && (nav === '#/' ? (location.hash === '' || location.hash === '#/') : location.hash.startsWith(nav))));
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
  if (h.startsWith('#/settings')) return { name: 'settings', tab: (h.split('/')[2] || 'mail').split('?')[0] };
  if (h.startsWith('#/wall')) return { name: 'wall' };
  return { name: 'dashboard' };
}

let lastRouteName = null;
function render(fromRefresh) {
  const r = currentRoute();
  // a background data refresh must never rebuild Settings (it would wipe the forms)
  if (fromRefresh && r.name === 'settings') return;
  // leaving Settings after a while: pull fresh data once, but only if we were away long enough to matter
  if (!fromRefresh && lastRouteName === 'settings' && r.name !== 'settings' && Date.now() - lastOk > REFRESH_MS) {
    bumpRefreshClock(); refresh();           // refresh() re-enters render(true) with fresh data
  }
  lastRouteName = r.name;
  document.body.classList.toggle('wall-mode', r.name === 'wall');
  if (r.name === 'node') renderNode(r.path);
  else if (r.name === 'alerts') renderAlerts(r.sev);
  else if (r.name === 'settings') renderSettings(r.tab);
  else if (r.name === 'wall') renderWall();
  else renderDashboard();
  decorateTree();
  closeDrawer();
}
// note: not `render` directly - the Event would land in the fromRefresh flag
window.addEventListener('hashchange', () => render(false));

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
      const ack = ackFor(r);
      const cv = el('canvas', { class: 'minispark' });
      sparks.push([cv, r]);
      tb.append(el('tr', { class: ack ? 'row-muted' : '' },
        el('td', {}, el('span', { class: `statusbadge ${r.severity}` }, el('span', { class: 'dot' }), SEV_LABEL[r.severity] || r.severity)),
        el('td', {}, el('a', { href: '#/node' + r.path }, r.target),
          r.comment ? el('div', { style: 'color:var(--text-faint);font-size:12px' }, r.comment) : null,
          ack ? el('div', { style: 'color:var(--text-faint);font-size:12px' },
            `acked by ${ack.by}${ack.until ? ' until ' + new Date(ack.until * 1000).toLocaleString() : ' (no expiry)'}${ack.note ? ' — ' + ack.note : ''}`) : null),
        el('td', {}, r.alert),
        el('td', {}, r.type),
        el('td', { class: 'num' }, fmtPct(r.currentLossPct)),
        el('td', { class: 'num' }, fmtMs(r.currentRttMs)),
        el('td', {}, cv),
        el('td', {}, r.pattern ? el('span', { class: 'pattern' }, r.pattern) : '–'),
        el('td', {}, ack
          ? el('button', { class: 'chip', onclick: () => unack(key).then(() => renderAlerts(sevFilter)) }, 'Un-ack')
          : el('button', { class: 'chip', onclick: () => ackDialog(key, r.target + ' · ' + r.alert).then(ok => ok && renderAlerts(sevFilter)) }, 'Acknowledge')),
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
        el('span', {}, el('strong', {}, ev.alert), ' · ', ev.target,
          ev.count > 1 ? el('span', { class: 'sub', style: 'color:var(--text-faint);margin-left:8px' },
            `×${ev.count}` + (ev.last && ev.time ? ` over ${Math.max(1, Math.round((ev.last - ev.time) / 60))} min` : '')) : null)));
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

// --- acknowledgements (server-side, shared by everyone) --------------

function ackFor(a) {
  const now = Date.now() / 1000;
  const k1 = state.acks[a.path + '::' + a.alert], k2 = state.acks[a.path];
  const live = (x) => x && (!x.until || x.until > now) ? x : null;
  return live(k1) || live(k2);
}
function isAcked(a) { return !!ackFor(a); }

// run a write; on 401 ask for the settings password once and retry
async function authed(fn) {
  try { return await fn(); }
  catch (e) {
    if (e.status !== 401) throw e;
    if (!(await signInDialog())) throw new Error('sign-in cancelled');
    return fn();
  }
}

async function unack(key) {
  try { const r = await authed(() => post('/acks/delete', { key })); state.acks = r.acks || {}; renderStatusPills(); }
  catch (e) { toast('Could not remove ack: ' + e.message, true); }
}

function ackDialog(key, label) {
  return new Promise(resolve => {
    const box = el('div', { class: 'modal-scrim' });
    let hours = 8, note = '';
    const opts = [[1, '1 h'], [8, '8 h'], [24, '24 h'], [168, '7 d'], [0, 'until cleared manually']];
    const seg = el('div', { class: 'seg', style: 'flex-wrap:wrap' }, ...opts.map(([h, l]) => el('button', {
      class: h === hours ? 'on' : '', onclick: (e) => { hours = h; [...seg.children].forEach(b => b.classList.toggle('on', b === e.currentTarget)); },
    }, l)));
    const noteEl = el('input', { type: 'text', placeholder: 'note (optional) — e.g. ISP maintenance', maxlength: '200', oninput: e => note = e.target.value });
    const close = (ok) => { box.remove(); resolve(ok); };
    box.append(el('div', { class: 'modal' },
      el('h3', {}, 'Acknowledge alert'),
      el('p', { class: 'sub' }, label),
      el('label', {}, 'Silence for'), seg,
      noteEl,
      el('div', { class: 'modal-actions' },
        el('button', { class: 'chip', onclick: () => close(false) }, 'Cancel'),
        el('button', { class: 'chip on', onclick: async () => {
          try { const r = await authed(() => post('/acks', { key, hours, note })); state.acks = r.acks || {}; renderStatusPills(); close(true); }
          catch (e) { toast('Ack failed: ' + e.message, true); }
        } }, 'Acknowledge'))));
    document.body.append(box);
    noteEl.focus();
  });
}

function toast(msg, bad) {
  const t = el('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
  document.body.append(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, bad ? 6000 : 3000);
}

// --- sign-in (Basic auth, kept for this browser session only) ------------

function sessionAuth() { try { return sessionStorage.getItem('sp.auth') || ''; } catch { return ''; } }
function setSessionAuth(user, pass) {
  try { sessionStorage.setItem('sp.auth', btoa(unescape(encodeURIComponent(`${user}:${pass}`)))); } catch {}
}
function signOut() { try { sessionStorage.removeItem('sp.auth'); } catch {} }
function isAuthError(e) { return e && (e.status === 401 || e.status === 403 && /auth/i.test(e.message || '')); }

// inline sign-in form; resolves true once /api/me accepts the credentials
function signInForm(target, message) {
  return new Promise(resolve => {
    const user = input({ value: 'admin', autocomplete: 'username', placeholder: 'user' });
    const pass = input({ type: 'password', autocomplete: 'current-password', placeholder: 'password' });
    const err = el('div', { class: 'field-help', style: 'color:var(--crit)' });
    const submit = async (e) => {
      e.preventDefault();
      err.textContent = '';
      setSessionAuth(user.value.trim(), pass.value);
      try { await api('/me'); resolve(true); }
      catch (ex) { signOut(); err.textContent = ex.status === 401 ? 'Wrong user or password.' : ex.message; }
    };
    target.innerHTML = '';
    target.append(el('form', { class: 'card-plain signin', onsubmit: submit },
      el('h2', {}, 'Sign in'),
      el('p', { class: 'sub' }, message || 'This area changes the SmokePing configuration and needs the settings password.'),
      el('div', { class: 'form-grid' }, field('User', user), field('Password', pass)),
      err,
      el('div', { class: 'modal-actions' }, el('button', { class: 'chip on', type: 'submit' }, 'Sign in')),
      el('p', { class: 'sub', style: 'margin:10px 0 0' }, 'Set with WEBUI_USER / WEBUI_PASS; a generated password is in /config/modern-auth/password.txt.')));
    pass.focus();
  });
}

// modal variant for actions elsewhere (e.g. acknowledging an alert)
function signInDialog() {
  return new Promise(resolve => {
    const box = el('div', { class: 'modal-scrim', onclick: (e) => { if (e.target === box) { box.remove(); resolve(false); } } });
    const inner = el('div', { class: 'modal' });
    box.append(inner);
    document.body.append(box);
    signInForm(inner, 'Acknowledging alerts needs the settings password.').then(() => { box.remove(); resolve(true); });
  });
}

// --- settings view --------------------------------------------------

const SETTINGS_TABS = [['mail', 'E-mail'], ['notify', 'Notifications'], ['targets', 'Targets'], ['config', 'Config files'], ['access', 'Access']];
let settingsData = null;

async function renderSettings(tab) {
  const main = document.getElementById('main');
  main.innerHTML = '<div class="loading">Loading settings…</div>';
  try { settingsData = await api('/settings'); }
  catch (e) {
    if (e.status === 401) {
      const holder = el('div', { class: 'settings-pane' });
      main.innerHTML = ''; main.append(el('div', { class: 'page-head' }, el('h1', {}, 'Settings')), holder);
      await signInForm(holder);
      return renderSettings(tab);
    }
    main.innerHTML = `<div class="empty">Settings unavailable: ${e.message}</div>`;
    return;
  }
  main.innerHTML = '';
  main.append(el('div', { class: 'page-head' }, el('h1', {}, 'Settings'),
    settingsData.user ? el('span', { class: 'sub' }, 'signed in as ' + settingsData.user) : null));
  main.append(el('div', { class: 'seg', style: 'margin-bottom:16px' }, ...SETTINGS_TABS.map(([k, l]) =>
    el('a', { class: 'segbtn' + (tab === k ? ' on' : ''), href: '#/settings/' + k }, l))));
  const pane = el('div', { class: 'settings-pane' });
  main.append(pane);
  ({ mail: paneMail, notify: paneNotify, targets: paneTargets, config: paneConfig, access: paneAccess }[tab] || paneMail)(pane);
}

function field(label, input, help) {
  return el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), input,
    help ? el('span', { class: 'field-help' }, help) : null);
}
function input(attrs) { return el('input', { class: 'input', ...attrs }); }
function resultBox() { return el('pre', { class: 'result', hidden: 'hidden' }); }
function showResult(box, r, okText) {
  box.hidden = false;
  const chk = r.check ? `\ncheck: ${r.check.ok ? 'OK' : 'FAILED'}${r.check.output ? '\n' + r.check.output : ''}` : '';
  const rl = r.reload ? `\nreload: ${r.reload.note || (r.reload.ok ? 'ok' : 'failed')}` : '';
  box.className = 'result ' + (r.ok ? 'ok' : 'bad');
  box.textContent = (r.ok ? (okText || 'Saved.') : (r.error || 'Failed.')) + chk + rl + (r.output ? '\n' + r.output : '');
}

function paneMail(pane) {
  const s = settingsData.smtp, a = settingsData.alerts, o = s.oauth || {};
  const method = s.authMethod || 'password';
  const f = {
    method: el('select', { class: 'input' },
      el('option', { value: 'password' }, 'Username + password (or app password)'),
      el('option', { value: 'oauth-google' }, 'OAuth2 — Google / Gmail'),
      el('option', { value: 'oauth-microsoft-app' }, 'OAuth2 — Microsoft 365, app-only (client ID + secret, no sign-in)'),
      el('option', { value: 'oauth-microsoft' }, 'OAuth2 — Microsoft 365, sign in as a user (device code)')),
    host: input({ value: s.host, placeholder: 'smtp.gmail.com' }),
    port: input({ type: 'number', value: s.port, style: 'width:100px' }),
    starttls: el('input', { type: 'checkbox' }), tls: el('input', { type: 'checkbox' }),
    authUser: input({ value: s.authUser || '', placeholder: 'you@example.com', autocomplete: 'off' }),
    oauthUser: input({ value: o.account || s.authUser || '', placeholder: 'alerts@yourdomain.com', autocomplete: 'off' }),
    authPass: input({ type: 'password', placeholder: s.passSet ? '•••••••• (unchanged)' : 'app password', autocomplete: 'new-password' }),
    from: input({ value: a.from, placeholder: 'smokeping@yourdomain' }),
    to: el('textarea', { class: 'input', rows: '3', placeholder: 'one address per line' }),
    webhooks: el('input', { type: 'checkbox' }),
    testTo: input({ value: (a.to && a.to[0]) || '', placeholder: 'send test to…' }),
    // oauth
    clientId: input({ value: o.clientId || '', placeholder: 'client / application ID', autocomplete: 'off' }),
    clientSecret: input({ type: 'password', placeholder: o.clientSecretSet ? '•••••••• (unchanged)' : 'client secret', autocomplete: 'new-password' }),
    refreshToken: input({ type: 'password', placeholder: o.refreshTokenSet ? '•••••••• (unchanged)' : 'paste refresh token', autocomplete: 'off' }),
    tenant: input({ value: o.tenant || 'common', placeholder: 'common, organizations, or your tenant ID' }),
  };
  f.method.value = method;
  f.starttls.checked = s.starttls === true; f.tls.checked = s.tls === true;
  f.to.value = (a.to || []).join('\n'); f.webhooks.checked = a.webhooks === true;
  const res = resultBox(), testRes = resultBox(), oRes = resultBox();

  const isSet = o.configured === true || o.refreshTokenSet === true;
  const connected = isSet
    ? `Configured${o.account ? ' for ' + o.account : ''}${o.connectedAt ? ' · ' + new Date(o.connectedAt * 1000).toLocaleString() : ''} — use "Check token" to verify`
    : 'Not configured yet';
  const status = el('p', { class: 'sub', style: isSet ? 'color:var(--ok)' : 'color:var(--warn)' }, connected);

  const appBox = el('div', {},
    el('p', { class: 'sub' }, el('b', {}, 'No sign-in page: '), 'the app authenticates by itself with its secret. One-time setup by a Microsoft 365 admin:'),
    el('ol', { class: 'sub steps' },
      el('li', {}, 'Entra ID → App registrations → your app → ', el('b', {}, 'API permissions'), ' → Add → ', el('b', {}, 'Office 365 Exchange Online'), ' → ',
        el('b', {}, 'Application permissions'), ' → ', el('span', { class: 'pattern' }, 'SMTP.SendAsApp'), ' → Add. Then consent: either the portal\'s ',
        el('b', {}, 'Grant admin consent'), ' button, or ', el('b', {}, 'Request admin consent'), ' below (opens Microsoft\'s consent page for this app).'),
      el('li', {}, el('b', {}, 'Certificates & secrets'), ' → New client secret → paste it below (the ', el('i', {}, 'Value'), ', not the ID).'),
      el('li', {}, 'Allow the app to send as the mailbox, in Exchange Online PowerShell:',
        el('pre', { class: 'result ok', style: 'display:block;margin:6px 0' },
          'Connect-ExchangeOnline\n' +
          'New-ServicePrincipal -AppId <client ID> -ObjectId <object ID of the Enterprise application>\n' +
          'Add-MailboxPermission -Identity alerts@yourdomain.com -User <client ID> -AccessRights FullAccess\n' +
          'Set-CASMailbox -Identity alerts@yourdomain.com -SmtpClientAuthenticationDisabled $false')),
      el('li', {}, 'Tenant must be your tenant ID or domain (e.g. ', el('span', { class: 'pattern' }, 'contoso.onmicrosoft.com'), '), not "common".')));

  const pwBox = el('div', { class: 'form-grid' },
    field('Username', f.authUser), field('Password', f.authPass, 'leave blank to keep the current one'));

  const googleBox = el('div', {},
    el('p', { class: 'sub' }, el('b', {}, 'Easiest: '), 'Google Cloud Console → enable the Gmail API → create an OAuth client of type ',
      el('b', {}, 'Web application'), ' with redirect URI ', el('span', { class: 'pattern' }, '<public https address>/api/oauth/callback'),
      '. Enter the client ID, secret and that public address below, click ', el('b', {}, 'Sign in with Google'),
      ' — Google shows its login and the permission "Read, compose, send and permanently delete all your email" — click Allow.'),
    el('p', { class: 'sub' }, el('b', {}, 'No public https address? '), 'Use the ',
      el('a', { href: 'https://developers.google.com/oauthplayground/', target: '_blank', rel: 'noopener' }, 'OAuth 2.0 Playground'),
      ' (gear → "Use your own OAuth credentials", scope ', el('span', { class: 'pattern' }, 'https://mail.google.com/'),
      ', authorize, exchange) and paste the refresh token into the field below instead.'));

  // --- "Sign in with …": the provider's own login + permissions screen -----------
  f.publicBase = input({ value: o.publicBase || '', placeholder: 'https://smokeping.yourdomain.com  (optional)', autocomplete: 'off' });
  const signInBtn = el('button', { class: 'chip on', type: 'button' }, 'Sign in with Microsoft');
  const signInRes = el('div', { class: 'result', hidden: 'hidden' });
  const pasteBox = el('div', { hidden: 'hidden' },
    el('p', { class: 'sub', style: 'margin-top:10px' }, 'After you click Accept, Microsoft sends you to a blank page. Copy that page\'s address from the browser bar and paste it here:'),
    el('textarea', { class: 'input code', rows: '3', placeholder: 'https://login.microsoftonline.com/common/oauth2/nativeclient?code=…&state=…' }),
    el('div', { class: 'modal-actions', style: 'justify-content:flex-start' }, el('button', { class: 'chip on', type: 'button' }, 'Finish sign-in')));
  const pasteTa = pasteBox.querySelector('textarea'), pasteBtn = pasteBox.querySelector('button');
  let statusPoll = null;

  const markConnected = (acct) => {
    o.refreshTokenSet = true; o.configured = true;
    status.textContent = `Configured${acct ? ' for ' + acct : ''} — use "Check token" to verify`; status.style.color = 'var(--ok)';
    if (acct && !f.oauthUser.value) f.oauthUser.value = acct;
  };
  signInBtn.addEventListener('click', async () => {
    const provider = f.method.value === 'oauth-google' ? 'google' : 'microsoft';
    signInBtn.disabled = true; signInRes.hidden = false; signInRes.className = 'result'; signInRes.textContent = 'Preparing sign-in…';
    pasteBox.hidden = true; if (statusPoll) { clearInterval(statusPoll); statusPoll = null; }
    try {
      const st = await post('/oauth/authorize', { provider, clientId: f.clientId.value.trim(), tenant: f.tenant.value.trim(),
        clientSecret: f.clientSecret.value, publicBase: f.publicBase.value.trim() });
      window.open(st.url, '_blank', 'noopener');
      const regHint = st.viaCallback
        ? `If Microsoft says "AADSTS500113: No reply address is registered", add ${st.redirectUri} under Authentication → Add a platform → Web, save, and click Sign in again.`
        : `If Microsoft says "AADSTS500113: No reply address is registered", add ${st.redirectUri} under Authentication → Add a platform → Mobile and desktop applications, save, and click Sign in again.`;
      if (st.viaCallback) {
        signInRes.className = 'result ok';
        signInRes.textContent = `Sign-in page opened in a new tab. Sign in, review the permissions, click Accept. You will be sent back to ${st.redirectUri} and this page updates by itself… ${regHint}`;
        const t0 = Date.now();
        statusPoll = setInterval(async () => {
          try {
            const s = await api('/oauth/status');
            if (s.connected && !s.pending) { clearInterval(statusPoll); statusPoll = null; markConnected(s.account); signInRes.textContent = `Connected${s.account ? ' as ' + s.account : ''}. Now click "Save mail settings".`; signInBtn.disabled = false; }
            else if (Date.now() - t0 > 15 * 60_000) { clearInterval(statusPoll); statusPoll = null; signInRes.className = 'result bad'; signInRes.textContent = 'Timed out waiting for the sign-in. Start again.'; signInBtn.disabled = false; }
          } catch { /* keep polling */ }
        }, 3000);
      } else {
        signInRes.className = 'result ok';
        signInRes.textContent = `Sign-in page opened in a new tab. Sign in, review the permissions, click Accept. Because this SmokePing has no public https address, Microsoft lands on its own blank page (${st.redirectUri}) — paste that page's address below. ${regHint}`;
        pasteBox.hidden = false; pasteTa.value = ''; pasteTa.focus(); signInBtn.disabled = false;
      }
    } catch (err) { signInRes.className = 'result bad'; signInRes.textContent = err.message; signInBtn.disabled = false; }
  });
  pasteBtn.addEventListener('click', async () => {
    pasteBtn.disabled = true;
    try {
      const r = await post('/oauth/paste', { url: pasteTa.value.trim() });
      markConnected(r.account); pasteBox.hidden = true;
      signInRes.className = 'result ok'; signInRes.textContent = `Connected${r.account ? ' as ' + r.account : ''}. Now click "Save mail settings".`;
    } catch (err) { signInRes.className = 'result bad'; signInRes.textContent = err.message; }
    pasteBtn.disabled = false;
  });

  // device code stays as the fallback for machines without a browser
  const msBtn = el('button', { class: 'chip', type: 'button' }, 'Use a device code instead');
  const msCode = el('div', { class: 'result ok', hidden: 'hidden' });
  const microsoftBox = el('div', {},
    el('p', { class: 'sub' }, 'Entra ID → App registrations → your app: add the delegated permission ',
      el('span', { class: 'pattern' }, 'https://outlook.office365.com/SMTP.Send'), ' (Office 365 Exchange Online), set "Allow public client flows" = Yes, and under Authentication add the redirect URI shown below. ',
      'Then click Sign in — Microsoft shows its login and a screen listing exactly what SmokePing asks for (send mail as you, keep access) — click Accept.'),
    msCode);

  // the OAuth inputs exist exactly once; labels/visibility change per method
  const oauthFields = el('div', { class: 'form-grid' },
    field('Tenant', f.tenant), field('Client ID', f.clientId), field('Client secret', f.clientSecret),
    field('Refresh token', f.refreshToken), field('Mailbox (user)', f.oauthUser),
    field('Public https address of this SmokePing', f.publicBase,
      'optional. If set, the sign-in returns straight here — register <address>/api/oauth/callback as a Web redirect URI on the app. Blank = Microsoft\'s landing page (register https://login.microsoftonline.com/common/oauth2/nativeclient under "Mobile and desktop applications"); Google requires it.'));
  const [oTenant, oClient, oSecret, oRefresh, oUser, oBase] = [...oauthFields.children];
  // sign-in controls, once, for the two user-delegated methods
  const signInRow = el('div', {},
    el('div', { class: 'modal-actions', style: 'justify-content:flex-start' }, signInBtn, msBtn), signInRes, pasteBox);
  const setLabel = (fieldEl, label, help) => {
    fieldEl.querySelector('.field-label').textContent = label;
    let h = fieldEl.querySelector('.field-help');
    if (help) { if (!h) { h = el('span', { class: 'field-help' }); fieldEl.append(h); } h.textContent = help; }
    else if (h) h.remove();
  };

  msBtn.addEventListener('click', async () => {
    msBtn.disabled = true; msCode.hidden = false; msCode.className = 'result'; msCode.textContent = 'Requesting a sign-in code…';
    try {
      const st = await post('/oauth/microsoft/start', { clientId: f.clientId.value.trim(), tenant: f.tenant.value.trim(), clientSecret: f.clientSecret.value });
      msCode.className = 'result ok';
      msCode.innerHTML = '';
      msCode.append(el('div', {}, 'Open ', el('a', { href: st.verificationUri, target: '_blank', rel: 'noopener' }, st.verificationUri),
        ' and enter the code ', el('b', { style: 'font-size:18px;letter-spacing:.1em' }, st.userCode), '. Waiting for you to finish signing in…'));
      const deadline = Date.now() + (st.expiresIn || 900) * 1000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, Math.max(5, st.interval || 5) * 1000));
        const p = await post('/oauth/microsoft/poll', {});
        if (p.ok) {
          msCode.textContent = `Connected${p.account ? ' as ' + p.account : ''}. Now click "Save mail settings".`;
          if (p.account && !f.oauthUser.value) f.oauthUser.value = p.account;
          o.refreshTokenSet = true; status.textContent = `Connected${p.account ? ' as ' + p.account : ''}`; status.style.color = 'var(--ok)';
          break;
        }
      }
    } catch (err) { msCode.className = 'result bad'; msCode.textContent = err.message; }
    msBtn.disabled = false;
  });

  // Microsoft admin consent: one screen that approves every permission on the app.
  // Must land on a redirect URI registered on the app; Microsoft's own nativeclient
  // page is the https one every app can register.
  const NATIVE_REDIRECT = 'https://login.microsoftonline.com/common/oauth2/nativeclient';
  const consentBtn = el('button', { class: 'chip', type: 'button', title: 'Opens Microsoft\'s admin consent page for this app', onclick: () => {
    const cid = f.clientId.value.trim();
    if (!cid) { toast('Enter the application (client) ID first.', true); return; }
    const tenant = (f.tenant.value.trim() || 'common');
    const u = new URL(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/v2.0/adminconsent`);
    u.searchParams.set('client_id', cid);
    u.searchParams.set('scope', 'https://outlook.office365.com/.default');
    u.searchParams.set('redirect_uri', NATIVE_REDIRECT);
    u.searchParams.set('state', 'modern-smokeping');
    window.open(u.toString(), '_blank', 'noopener');
    oRes.hidden = false; oRes.className = 'result';
    oRes.textContent = 'Admin consent page opened in a new tab. Sign in as a Global/Application admin and click Accept. '
      + 'If Microsoft shows "redirect URI mismatch", add ' + NATIVE_REDIRECT
      + ' under Authentication -> Add a platform -> Mobile and desktop applications, then try again. '
      + 'Afterwards click "Check token" - it should list the role/scope.';
  } }, 'Request admin consent');

  const oauthTools = el('div', { class: 'modal-actions', style: 'justify-content:flex-start' },
    consentBtn,
    el('button', { class: 'chip', type: 'button', onclick: async (e) => {
      e.currentTarget.disabled = true; oRes.hidden = false; oRes.className = 'result'; oRes.textContent = 'Exchanging refresh token…';
      try { showResult(oRes, await post('/oauth/check', {}), 'Token OK — OAuth2 credentials work.'); }
      catch (err) { showResult(oRes, { ok: false, error: err.message, ...(err.data || {}) }); }
      e.currentTarget.disabled = false;
    } }, 'Check token'),
    el('button', { class: 'chip', type: 'button', onclick: async () => {
      if (!confirm('Forget the stored OAuth2 refresh token and client secret?')) return;
      try { await post('/oauth/forget', {}); o.refreshTokenSet = false; status.textContent = 'Not connected yet'; status.style.color = 'var(--warn)'; toast('OAuth2 credentials removed.'); }
      catch (err) { toast(err.message, true); }
    } }, 'Forget OAuth2'));

  const oauthWrap = el('div', {}, status, googleBox, appBox, microsoftBox, oauthFields, signInRow, oauthTools, oRes);
  const applyMethod = () => {
    const m = f.method.value;
    pwBox.hidden = m !== 'password';
    oauthWrap.hidden = !m.startsWith('oauth');
    googleBox.hidden = m !== 'oauth-google';
    appBox.hidden = m !== 'oauth-microsoft-app';
    microsoftBox.hidden = m !== 'oauth-microsoft';
    oTenant.hidden = m === 'oauth-google';
    oRefresh.hidden = m !== 'oauth-google';
    oBase.hidden = m === 'oauth-microsoft-app';
    signInRow.hidden = !(m === 'oauth-google' || m === 'oauth-microsoft');
    msBtn.hidden = m !== 'oauth-microsoft';
    signInBtn.textContent = m === 'oauth-google' ? 'Sign in with Google' : 'Sign in with Microsoft';
    consentBtn.hidden = !m.startsWith('oauth-microsoft');
    if (m === 'oauth-google') {
      setLabel(oClient, 'Client ID'); setLabel(oSecret, 'Client secret');
      setLabel(oRefresh, 'Refresh token', 'from the OAuth 2.0 Playground'); setLabel(oUser, 'Mailbox (user)', 'the Google account you authorized');
    } else if (m === 'oauth-microsoft-app') {
      setLabel(oTenant, 'Tenant ID or domain', 'not "common"'); setLabel(oClient, 'Application (client) ID');
      setLabel(oSecret, 'Client secret', 'the secret Value, not its ID'); setLabel(oUser, 'Send as mailbox (user)', 'the shared/user mailbox the app was granted');
    } else if (m === 'oauth-microsoft') {
      setLabel(oTenant, 'Tenant', '"common" works for most; tenant ID for single-tenant apps'); setLabel(oClient, 'Application (client) ID');
      setLabel(oSecret, 'Client secret', 'only if the app is confidential (usually blank)'); setLabel(oUser, 'Mailbox (user)', 'filled in automatically after connecting');
    }
    if (m === 'oauth-google' && !f.host.value) { f.host.value = 'smtp.gmail.com'; f.port.value = 587; f.starttls.checked = true; f.tls.checked = false; }
    if (m.startsWith('oauth-microsoft') && (!f.host.value || f.host.value === 'smtp.gmail.com')) { f.host.value = 'smtp.office365.com'; f.port.value = 587; f.starttls.checked = true; f.tls.checked = false; }
    if (m === 'oauth-microsoft-app' && (!f.tenant.value || f.tenant.value === 'common')) f.tenant.value = '';
  };
  f.method.addEventListener('change', applyMethod);
  applyMethod();

  pane.append(el('div', { class: 'card-plain' },
    el('h2', {}, 'Outgoing mail (SMTP)'),
    el('p', { class: 'sub' }, 'Alert e-mails are sent through msmtp. Gmail and Microsoft 365 both prefer OAuth2 over passwords; an app password still works for Gmail accounts with 2-step verification.'),
    el('div', { class: 'form-grid' },
      field('Sign-in method', f.method),
      field('Mail server', f.host), field('Port', f.port),
      field('STARTTLS', f.starttls, 'usually on for port 587'), field('TLS (implicit)', f.tls, 'for port 465'),
      field('From address', f.from)),
    pwBox, oauthWrap,
    el('h2', {}, 'Alert recipients'),
    el('div', { class: 'form-grid' },
      field('E-mail alerts to', f.to),
      field('Webhook notifications', f.webhooks, 'also pipe every alert to the Notifications channels')),
    el('div', { class: 'modal-actions' },
      el('button', { class: 'chip on', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          const r = await post('/settings/smtp', {
            authMethod: f.method.value,
            host: f.host.value, port: +f.port.value, starttls: f.starttls.checked, tls: f.tls.checked,
            authUser: f.method.value === 'password' ? f.authUser.value : f.oauthUser.value,
            authPass: f.authPass.value, from: f.from.value,
            oauth: { clientId: f.clientId.value.trim(), clientSecret: f.clientSecret.value, refreshToken: f.refreshToken.value.trim(), tenant: f.tenant.value.trim() },
            to: f.to.value.split(/\n|,/).map(x => x.trim()).filter(Boolean), webhooks: f.webhooks.checked,
          });
          showResult(res, r, 'Saved. SmokePing reloaded.' + (r.sendmailSwitched ? ' Mail now goes through msmtp.' : ''));
          f.authPass.value = ''; f.clientSecret.value = ''; f.refreshToken.value = '';
          settingsData = r.settings || settingsData;
        } catch (err) { showResult(res, { ok: false, error: err.message, ...(err.data || {}) }); }
        e.currentTarget.disabled = false;
      } }, 'Save mail settings')),
    res,
    el('h2', {}, 'Test'),
    el('p', { class: 'sub' }, 'Sends a message formatted like a real SmokePing alert. "Test these settings" uses what is in the form right now, saved or not — for OAuth2 the stored token is used, so connect/save that first.'),
    el('div', { class: 'form-grid' }, field('Send to', f.testTo, 'one address or a comma-separated list')),
    el('div', { class: 'modal-actions', style: 'justify-content:flex-start' },
      el('button', { class: 'chip on', onclick: (e) => runMailTest(e, f.testTo.value, true) }, 'Test these settings'),
      el('button', { class: 'chip', onclick: (e) => runMailTest(e, f.testTo.value, false) }, 'Test saved settings'),
      el('button', { class: 'chip', onclick: (e) => runMailTest(e, 'recipients', false) }, 'Send to all alert recipients')),
    testRes));

  async function runMailTest(e, to, useForm) {
    const btn = e.currentTarget;
    btn.disabled = true; testRes.hidden = false; testRes.className = 'result'; testRes.textContent = 'Sending…';
    const body = { to };
    if (useForm) body.smtp = {
      authMethod: f.method.value, host: f.host.value, port: +f.port.value, starttls: f.starttls.checked, tls: f.tls.checked,
      authUser: f.method.value === 'password' ? f.authUser.value : f.oauthUser.value, authPass: f.authPass.value, from: f.from.value,
    };
    try {
      const r = await post('/test/mail', body);
      showResult(testRes, r, `Accepted by the mail server for ${(r.to || []).join(', ')} (via ${r.engine}). Check the inbox — and the spam folder.`);
    } catch (err) { showResult(testRes, { ok: false, error: err.message, ...(err.data || {}) }); }
    btn.disabled = false;
  }
}

const CHANNELS = [
  ['discord',  'Discord',  [['url', 'Webhook URL', 'https://discord.com/api/webhooks/…']]],
  ['slack',    'Slack',    [['url', 'Incoming webhook URL', 'https://hooks.slack.com/services/…']]],
  ['telegram', 'Telegram', [['token', 'Bot token', '123456:ABC…'], ['chatId', 'Chat ID', '-100123…']]],
  ['ntfy',     'ntfy',     [['url', 'Server', 'https://ntfy.sh'], ['topic', 'Topic', 'smokeping-alerts'], ['token', 'Access token (optional)', '']]],
  ['gotify',   'Gotify',   [['url', 'Server', 'https://gotify.example.com'], ['token', 'App token', ''], ['priority', 'Priority (1-10)', '8']]],
  ['webhook',  'Generic webhook', [['url', 'URL (JSON POST)', 'https://…'], ['secret', 'X-Webhook-Secret header (optional)', '']]],
];

function paneNotify(pane) {
  const n = settingsData.notify || {};
  const res = resultBox();
  const forms = {};
  const cards = CHANNELS.map(([key, label, fields]) => {
    const c = n[key] || {};
    const en = el('input', { type: 'checkbox' }); en.checked = c.enabled === true;
    const inputs = {};
    const tRes = resultBox();
    for (const [fk, fl, ph] of fields) inputs[fk] = input({ value: c[fk] ?? '', placeholder: ph, type: /token|secret/.test(fk) ? 'password' : 'text', autocomplete: 'off' });
    forms[key] = { en, inputs };
    return el('div', { class: 'card-plain' },
      el('div', { class: 'card-top' }, el('h2', { style: 'margin:0' }, label), el('span', { class: 'spacer', style: 'flex:1' }),
        el('label', { class: 'switch' }, en, ' enabled')),
      el('div', { class: 'form-grid' }, ...fields.map(([fk, fl]) => field(fl, inputs[fk]))),
      el('div', { class: 'modal-actions' }, el('button', { class: 'chip', onclick: async (e) => {
        e.currentTarget.disabled = true; tRes.hidden = false; tRes.className = 'result'; tRes.textContent = 'Saving + sending test…';
        try {
          await saveNotify();
          showResult(tRes, await post('/test/notify', { channel: key }), 'Test sent.');
        } catch (err) { showResult(tRes, { ok: false, error: err.message, ...(err.data || {}) }); }
        e.currentTarget.disabled = false;
      } }, 'Save & send test')),
      tRes);
  });
  const saveNotify = async () => {
    const body = {};
    for (const [key] of CHANNELS) {
      const f = forms[key]; const o = { enabled: f.en.checked };
      for (const [fk, v] of Object.entries(f.inputs)) o[fk] = v.value.trim();
      body[key] = o;
    }
    const r = await post('/settings/notify', body);
    settingsData.notify = r.notify;
    return r;
  };
  pane.append(el('p', { class: 'sub' },
    'Alerts are pushed to every enabled channel when "Webhook notifications" is on under E-mail → Alert recipients. ',
    settingsData.alerts.webhooks ? el('b', {}, 'Currently ON.') : el('b', { style: 'color:var(--warn)' }, 'Currently OFF — enable it there.')),
    ...cards,
    el('div', { class: 'modal-actions' }, el('button', { class: 'chip on', onclick: async (e) => {
      e.currentTarget.disabled = true;
      try { showResult(res, await saveNotify(), 'Notification settings saved.'); }
      catch (err) { showResult(res, { ok: false, error: err.message }); }
      e.currentTarget.disabled = false;
    } }, 'Save all channels')), res);
}

function paneTargets(pane) {
  const groups = [];
  const walk = (node, depth) => { for (const c of (node.children || [])) { if (!c.isLeaf) { groups.push(c.path); walk(c, depth + 1); } } };
  if (state.tree) walk(state.tree.root, 0);
  const sel = el('select', { class: 'input' }, el('option', { value: '' }, '(top level)'), ...groups.map(g => el('option', { value: g }, g)));
  const alertNames = ((state.alerts && state.alerts.active) || []).map(a => a.alert);
  const f = {
    parent: sel, key: input({ placeholder: 'MyRouter  (letters, digits, - _)' }),
    menu: input({ placeholder: 'Menu label' }), title: input({ placeholder: 'Title shown on the page' }),
    host: input({ placeholder: '192.168.1.1 or host.example.com' }),
    probe: input({ placeholder: 'FPing (blank = inherit)' }),
    alerts: input({ placeholder: 'hostdown,majorloss,… (blank = inherit)' }),
  };
  const res = resultBox();
  pane.append(el('div', { class: 'card-plain' },
    el('h2', {}, 'Add a target'),
    el('p', { class: 'sub' }, 'Appends a target block to the Targets file, validates it with smokeping --check, then reloads. New targets start collecting within one poll cycle.'),
    el('div', { class: 'form-grid' },
      field('Group', f.parent), field('Key', f.key, 'becomes part of the path and the rrd filename'),
      field('Menu', f.menu), field('Title', f.title), field('Host', f.host),
      field('Probe', f.probe), field('Alerts', f.alerts)),
    el('div', { class: 'modal-actions' }, el('button', { class: 'chip on', onclick: async (e) => {
      e.currentTarget.disabled = true;
      try {
        const r = await post('/targets/add', {
          parent: f.parent.value, key: f.key.value.trim(), menu: f.menu.value.trim(), title: f.title.value.trim(),
          host: f.host.value.trim(), probe: f.probe.value.trim(),
          alerts: f.alerts.value.split(',').map(x => x.trim()).filter(Boolean),
        });
        showResult(res, r, `Added ${r.path}. Reloading tree…`);
        state.tree = await api('/tree'); renderTree();
      } catch (err) { showResult(res, { ok: false, error: err.message, ...(err.data || {}) }); }
      e.currentTarget.disabled = false;
    } }, 'Add target')), res));

  // --- remove ---------------------------------------------------------
  const all = [];
  const walk2 = (node) => { for (const c of (node.children || [])) { all.push([c.path, c.isLeaf ? 'target' : 'group']); walk2(c); } };
  if (state.tree) walk2(state.tree.root);
  const rsel = el('select', { class: 'input' }, el('option', { value: '' }, '— choose —'),
    ...all.map(([p, kind]) => el('option', { value: p }, `${p}  (${kind})`)));
  const rpass = input({ type: 'password', placeholder: 'settings password, again', autocomplete: 'current-password' });
  const rdata = el('input', { type: 'checkbox' });
  const rres = resultBox();
  pane.append(el('div', { class: 'card-plain danger' },
    el('h2', {}, 'Remove a target'),
    el('p', { class: 'sub' }, 'Deletes the target (or a whole group with everything under it) from the Targets file, validates, reloads. Because this is destructive, the password is checked again server-side for this request.'),
    el('div', { class: 'form-grid' },
      field('Target / group', rsel),
      field('Confirm password', rpass, 'required even if you are signed in'),
      field('Also delete collected data', rdata, 'removes the .rrd history files; leave off to keep the graphs recoverable')),
    el('div', { class: 'modal-actions' }, el('button', { class: 'chip danger', onclick: async (e) => {
      const path = rsel.value;
      if (!path) { showResult(rres, { ok: false, error: 'Choose a target first.' }); return; }
      const isGroup = all.find(([p]) => p === path)?.[1] === 'group';
      if (!confirm(`Remove ${path}${isGroup ? ' and every target under it' : ''}${rdata.checked ? ' AND delete its collected data' : ''}?`)) return;
      e.currentTarget.disabled = true;
      try {
        const r = await authed(() => post('/targets/remove', { path, password: rpass.value, deleteData: rdata.checked }));
        showResult(rres, r, `Removed ${r.path} (${r.removedLines} lines${r.removedChildren ? ', ' + r.removedChildren + ' sub-targets' : ''}${r.deletedFiles?.length ? ', ' + r.deletedFiles.length + ' data files deleted' : ''}).`);
        rpass.value = '';
        state.tree = await api('/tree'); renderTree();
        [...rsel.options].find(o => o.value === path)?.remove();
      } catch (err) { showResult(rres, { ok: false, error: err.message, ...(err.data || {}) }); }
      e.currentTarget.disabled = false;
    } }, 'Remove target')), rres));
}

function paneConfig(pane) {
  const files = settingsData.editable || ['Targets', 'Alerts', 'Probes', 'Database', 'General', 'Presentation'];
  const sel = el('select', { class: 'input', style: 'width:auto' }, ...files.map(f => el('option', { value: f }, f)));
  const ta = el('textarea', { class: 'input code', rows: '24', spellcheck: 'false' });
  const meta = el('span', { class: 'sub' });
  const res = resultBox();
  const load = async () => {
    ta.value = 'loading…';
    try { const r = await api('/config/' + sel.value); ta.value = r.text; meta.textContent = r.exists ? 'last modified ' + new Date(r.mtime * 1000).toLocaleString() : 'file does not exist yet'; }
    catch (e) { ta.value = ''; meta.textContent = e.message; }
  };
  sel.addEventListener('change', load);
  pane.append(el('div', { class: 'card-plain' },
    el('div', { class: 'card-top' }, el('h2', { style: 'margin:0' }, 'Config file'), sel, meta),
    el('p', { class: 'sub' }, 'Raw SmokePing config. On save the file is validated with smokeping --check; nothing is written if the check fails. A .bak copy of the previous version is kept next to it.'),
    ta,
    el('div', { class: 'modal-actions' },
      el('button', { class: 'chip', onclick: load }, 'Revert'),
      el('button', { class: 'chip on', onclick: async (e) => {
        e.currentTarget.disabled = true; res.hidden = false; res.className = 'result'; res.textContent = 'Validating…';
        try { showResult(res, await post('/config/' + sel.value, { text: ta.value }), 'Saved and reloaded.'); }
        catch (err) { showResult(res, { ok: false, error: err.message, ...(err.data || {}) }); }
        e.currentTarget.disabled = false;
      } }, 'Validate & save')),
    res));
  load();
}

function paneAccess(pane) {
  pane.append(el('div', { class: 'card-plain' },
    el('h2', {}, 'Login'),
    el('p', {}, settingsData.user ? `You are signed in as ${settingsData.user}.` : 'Login is disabled (WEBUI_AUTH=off).'),
    el('p', { class: 'sub' }, 'Viewing (dashboard, alerts, wall, classic UI) is open. The password guards only what changes things: this Settings page, config files, add-target, test mail/notify, reload and acknowledgements. It is set from the container environment, not from here:'),
    el('pre', { class: 'result ok', style: 'display:block' }, 'WEBUI_AUTH=on        # off disables the login\nWEBUI_USER=admin\nWEBUI_PASS=…          # blank = generated once, see /config/modern-auth/password.txt'),
    el('p', { class: 'sub' }, 'Change the values in .env and restart the container.'),
    el('div', { class: 'modal-actions', style: 'justify-content:flex-start' },
      el('button', { class: 'chip', onclick: () => { signOut(); toast('Signed out for this session.'); location.hash = '#/'; } }, 'Sign out'),
      el('span', { class: 'sub', style: 'margin:0 0 0 8px' }, sessionAuth() ? '' : 'Credentials are currently supplied by the browser, not the app; closing the browser signs out.'))));
}

// --- wall display ---------------------------------------------------

// ancestor group labels for a leaf path, walked from the loaded tree
// (the "Top" root is skipped). The last entry is the immediate parent
// group - in a customer -> connection layout that is the customer name.
function ancestorLabels(path) {
  const root = state.tree && state.tree.root;
  if (!root || !path || path === '/') return [];
  const segs = path.split('/').filter(Boolean);
  const out = [];
  let node = root;
  for (let i = 0; i < segs.length - 1; i++) {
    node = (node.children || []).find(c => c.name === segs[i]);
    if (!node) break;
    out.push(node.menu || node.title || node.name);
  }
  return out;
}

function renderWall() {
  const main = document.getElementById('main');
  const s = state.summary;
  if (!s) { main.innerHTML = '<div class="loading">Loading…</div>'; return; }
  const nodes = s.nodes.slice().sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.path.localeCompare(b.path));
  const worst = nodes.length ? nodes[0].severity : 'unknown';
  main.innerHTML = '';
  main.append(el('div', { class: 'wall-head ' + worst },
    el('span', { class: 'wall-title' }, state.tree && state.tree.title || 'SmokePing'),
    el('span', { class: 'wall-counts' },
      ...['ok', 'warning', 'critical', 'down'].map(k => el('span', { class: 'pill', 'data-sev': k }, el('span', { class: 'dot' }), `${SEV_LABEL[k]} ${s.counts[k] || 0}`))),
    el('span', { class: 'wall-clock' }, new Date().toLocaleTimeString()),
    el('a', { class: 'chip', href: '#/' }, 'exit')));
  const grid = el('div', { class: 'wall-grid' });
  const draws = [];
  for (const n of nodes) {
    const crumbs = ancestorLabels(n.path);
    const customer = crumbs.length ? crumbs[crumbs.length - 1] : '';
    const t = el('a', { class: 'wall-tile ' + n.severity, href: '#/node' + n.path },
      el('div', { class: 'wall-tile-title' }, n.title),
      el('div', { class: 'wall-tile-val' }, fmtMs(n.medianNowMs), el('small', {}, ' ' + fmtPct(n.lossNowPct) + ' loss')));
    const cv = el('canvas', { class: 'spark', style: 'height:38px' });
    t.append(cv);
    if (customer) t.append(el('div', { class: 'wall-tile-cust', title: crumbs.join(' › ') }, customer));
    draws.push([cv, n.spark]); grid.append(t);
  }
  main.append(grid);
  requestAnimationFrame(() => { for (const [cv, sp] of draws) if (sp) drawSpark(cv, sp); });
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
  // refresh() renders via render(true), which deliberately skips Settings -
  // so a direct load / reload of #/settings must be rendered here.
  if (currentRoute().name === 'settings') render(false);
  bumpRefreshClock();
}
boot();
