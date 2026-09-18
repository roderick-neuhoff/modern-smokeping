// Availability report, target comparison, incident history and the alert-rule
// editor. app.js hands over its helpers once via initViews(), so these views
// share the same fetch/auth/toast plumbing without a circular import.
import { drawCompare, attachCompareHover, COMPARE_COLORS, fmtMs } from './chart.js';

let D = null;
export function initViews(deps) { D = deps; }

// --- formatting -------------------------------------------------------------

export function fmtDur(sec) {
  if (sec == null || !isFinite(sec)) return '–';
  sec = Math.round(sec);
  if (sec < 60) return sec + 's';
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  if (sec < 3600) return `${m}m ${String(s).padStart(2, '0')}s`;
  if (sec < 86400) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${d}d ${h}h`;
}

export function fmtAvail(v) {
  if (v == null || !isFinite(v)) return '–';
  if (v >= 99.9995) return '100 %';
  return v.toFixed(v >= 99 ? 3 : 2) + ' %';
}
const availClass = (v) => v == null ? 'unknown' : v >= 99.9 ? 'ok' : v >= 99 ? 'warning' : 'critical';
const stamp = (t) => t ? new Date(t * 1000).toLocaleString() : '–';

function seg(options, current, onPick) {
  const box = D.el('div', { class: 'seg' });
  for (const [k, label] of options) {
    box.append(D.el('button', { class: k === current ? 'on' : '', onclick: () => onPick(k) }, label));
  }
  return box;
}

// ============================================================================
// availability / SLA report
// ============================================================================

const REPORT_RANGES = [['24h', '24 h'], ['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days']];
let reportSearch = '';

export async function renderReport(main, range) {
  const { el, api } = D;
  range = REPORT_RANGES.some(([k]) => k === range) ? range : '7d';
  try { localStorage.setItem('sp.reportRange', range); } catch {}
  main.innerHTML = '<div class="loading">Building report…</div>';
  let r;
  try { r = await api('/report?range=' + range, { timeout: 90_000 }); }
  catch (e) { main.innerHTML = ''; main.append(el('div', { class: 'empty' }, 'Could not build the report: ' + e.message)); return; }

  main.innerHTML = '';
  const label = (REPORT_RANGES.find(([k]) => k === range) || [])[1] || range;
  main.append(el('div', { class: 'page-head' },
    el('h1', {}, 'Availability report'),
    el('span', { class: 'sub' }, `last ${label} · generated ${new Date(r.generated * 1000).toLocaleString()}`),
    el('span', { class: 'spacer' }),
    seg(REPORT_RANGES, range, (k) => { location.hash = '#/report?range=' + k; }),
    el('button', { class: 'chip', title: 'Download this report as CSV', onclick: () => exportReportCsv(r, range) }, 'Export CSV'),
    el('button', { class: 'chip', title: 'Print or save as PDF', onclick: () => window.print() }, 'Print'),
  ));

  const s = r.summary || {};
  const hasGoals = !!(r.goals && r.goals.defined);
  const monthName = r.month ? new Date(r.month.start * 1000).toLocaleString([], { month: 'long', year: 'numeric' }) : '';
  main.append(el('div', { class: 'statgrid' },
    hasGoals && s.goalsTotal ? kpi('Goals met', `${s.goalsMet} / ${s.goalsTotal}`, s.goalsMet === s.goalsTotal ? 'ok' : 'critical', 'targets, in this period') : null,
    hasGoals && s.goalsTotal ? kpi('Budget ' + monthName, s.budgetBreached ? `${s.budgetBreached} breached` : s.budgetAtRisk ? `${s.budgetAtRisk} at risk` : 'on track',
      s.budgetBreached ? 'critical' : s.budgetAtRisk ? 'warning' : 'ok', 'downtime budget, month to date') : null,
    kpi('Overall availability', fmtAvail(s.availability), availClass(s.availability)),
    kpi('Full-outage time', fmtDur(s.downtimeSec), s.downtimeSec ? 'warning' : 'ok', 'summed over all targets'),
    kpi('Incidents', String(s.incidents ?? 0), s.incidents ? 'warning' : 'ok'),
    s.maintenanceSec ? kpi('Maintenance excluded', fmtDur(s.maintenanceSec), null, 'planned windows, summed over targets') : null,
    kpi('Targets', String(s.targets ?? 0)),
    kpi('Perfect', `${s.perfect ?? 0} / ${s.targets ?? 0}`, null, 'no measurable loss'),
  ));

  if ((r.groups || []).length > 1) {
    const rows = r.groups.slice().sort((a, b) => a.availability - b.availability);
    const tbl = el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, ...['Group', 'Targets', 'Availability', ...(hasGoals ? ['Goal', 'Budget this month'] : []), 'Full-outage', 'Incidents', 'Weakest target'].map(h => el('th', {}, h)))));
    const tb = el('tbody');
    for (const g of rows) {
      tb.append(el('tr', {},
        el('td', {}, g.title),
        el('td', { class: 'num' }, String(g.targets)),
        el('td', {}, availCell(g.availability)),
        hasGoals ? el('td', {}, goalCell(g)) : null,
        hasGoals ? el('td', {}, budgetCell(g)) : null,
        el('td', { class: 'num' }, fmtDur(g.downtimeSec)),
        el('td', { class: 'num' }, String(g.incidents)),
        el('td', {}, g.worstTarget || '–')));
    }
    tbl.append(tb);
    main.append(el('div', { class: 'tablecard' }, el('h2', {}, 'By group'), el('div', { class: 'table-scroll' }, tbl)));
  }

  const search = el('input', { type: 'search', placeholder: 'Filter targets', value: reportSearch });
  const holder = el('div', { class: 'table-scroll' });
  const drawRows = () => {
    holder.innerHTML = '';
    const q = reportSearch.toLowerCase();
    const rows = r.targets.filter(t => !q || (t.title + ' ' + t.path + ' ' + (t.host || '')).toLowerCase().includes(q));
    if (!rows.length) { holder.append(el('p', { class: 'note' }, 'No targets match.')); return; }
    const tbl = el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, ...['Target', 'Availability', ...(hasGoals ? ['Goal', 'Budget this month'] : []), 'Full-outage', 'Loss-minutes', 'Avg loss', 'Avg RTT', 'p95 RTT', 'Worst hour', 'Incidents'].map(h => el('th', {}, h)))));
    const tb = el('tbody');
    for (const t of rows) {
      const wh = t.worstHour;
      tb.append(el('tr', {},
        el('td', {}, el('a', { href: '#/node' + t.path }, t.title),
          t.host ? el('div', { class: 'cell-sub' }, t.host) : null),
        el('td', {}, availCell(t.availability),
          t.maintenanceSec ? el('div', { class: 'cell-sub' }, `excludes ${fmtDur(t.maintenanceSec)} maintenance`) : null),
        hasGoals ? el('td', {}, goalCell(t)) : null,
        hasGoals ? el('td', {}, budgetCell(t)) : null,
        el('td', { class: 'num' }, fmtDur(t.downtimeSec)),
        el('td', { class: 'num' }, t.lossMinutes < 0.05 ? '0' : t.lossMinutes.toFixed(1)),
        el('td', { class: 'num' }, D.fmtPct(t.avgLossPct)),
        el('td', { class: 'num' }, fmtMs(t.avgMs)),
        el('td', { class: 'num' }, fmtMs(t.p95Ms)),
        el('td', {}, wh ? el('span', { title: `${wh.lossPct.toFixed(1)} % average loss in that hour` }, stamp(wh.t)) : '–'),
        el('td', { class: 'num' }, String(t.incidents) + (t.longestSec ? ` (longest ${fmtDur(t.longestSec)})` : ''))));
    }
    tbl.append(tb);
    holder.append(tbl);
  };
  main.append(el('div', { class: 'tablecard' },
    el('div', { class: 'tablecard-head' }, el('h2', {}, 'By target'), el('label', { class: 'search' }, search)),
    holder));
  search.addEventListener('input', (e) => { reportSearch = e.target.value; drawRows(); });
  drawRows();

  main.append(el('p', { class: 'note' },
    `Availability is 100 % minus the average packet loss over the period (so 10 % loss for a whole day counts as 10 % unavailable). ` +
    `Full-outage time is the time spent in poll slots with ${r.downLossPct} % or more loss, at the RRD resolution available for that range (${r.targets[0] ? r.targets[0].stepSec + ' s' : 'n/a'} steps). ` +
    `Loss-minutes is the same loss expressed as minutes of total outage. Incidents come from the persistent alert history. Time inside a maintenance window is left out of every figure, and incidents that began during one are not counted.` +
    (hasGoals ? ` Goals are judged on the period above; the downtime budget is always the calendar month to date (${monthName}), i.e. the allowed unavailability of the goal over the whole month, minus what has been used so far. "At risk" means over 75 % used, or on course to exceed the budget by month end.` : '')));
}

function kpi(k, v, cls, hint) {
  return D.el('div', { class: 'stat' + (cls ? ' kpi-' + cls : '') },
    D.el('div', { class: 'k' }, k), D.el('div', { class: 'v' }, v),
    hint ? D.el('div', { class: 'cell-sub' }, hint) : null);
}

function availCell(v) {
  if (v == null) return D.el('span', { class: 'sub' }, 'in maintenance');
  const pct = v == null ? 0 : Math.max(0, Math.min(100, v));
  return D.el('div', { class: 'availbar' },
    D.el('span', { class: 'track' }, D.el('i', { class: availClass(v), style: `width:${pct}%` })),
    D.el('span', { class: 'num' }, fmtAvail(v)));
}

function exportReportCsv(r, range) {
  const rows = r.targets.map(t => [t.path, t.title, t.host, t.availability == null ? '' : t.availability.toFixed(4), t.downtimeSec,
    t.lossMinutes.toFixed(2), t.avgLossPct == null ? '' : t.avgLossPct.toFixed(3), t.avgMs == null ? '' : t.avgMs.toFixed(2), t.p95Ms == null ? '' : t.p95Ms.toFixed(2),
    t.maxMs == null ? '' : t.maxMs.toFixed(2), t.worstHour ? new Date(t.worstHour.t * 1000).toISOString() : '',
    t.worstHour ? t.worstHour.lossPct.toFixed(2) : '', t.incidents, t.longestSec, t.coveragePct.toFixed(1), t.maintenanceSec || 0]);
  D.downloadBlob(D.rowsToCsv(['path', 'title', 'host', 'availability_pct', 'full_outage_sec', 'loss_minutes', 'avg_loss_pct', 'avg_rtt_ms',
    'p95_rtt_ms', 'max_rtt_ms', 'worst_hour', 'worst_hour_loss_pct', 'incidents', 'longest_incident_sec', 'coverage_pct', 'maintenance_sec'], rows),
    `smokeping-availability-${range}.csv`);
}

// ============================================================================
// compare targets on one chart
// ============================================================================

const COMPARE_RANGES = [['3h', '3h'], ['30h', '30h'], ['10d', '10d'], ['360d', '360d']];
const MAX_COMPARE = COMPARE_COLORS.length;
let compareRO = null;

export function compareHash(paths, range) {
  const qs = new URLSearchParams();
  if (paths.length) qs.set('paths', paths.join(','));
  if (range) qs.set('range', range);
  return '#/compare' + (qs.toString() ? '?' + qs.toString() : '');
}

export async function renderCompare(main, route) {
  const { el, api, state } = D;
  if (compareRO) { compareRO.disconnect(); compareRO = null; }
  let paths = (route.paths || []).slice(0, MAX_COMPARE);
  let range = COMPARE_RANGES.some(([k]) => k === route.range) ? route.range : (localStorage.getItem('sp.range') || '3h');
  if (!COMPARE_RANGES.some(([k]) => k === range)) range = '3h';
  let pickerSearch = '';
  let loadId = 0;

  const nodes = (state.summary && state.summary.nodes) || [];
  const titleOf = (p) => (nodes.find(n => n.path === p) || {}).title || p.split('/').pop();

  main.innerHTML = '';
  const head = el('div', { class: 'page-head' });
  const picker = el('div', { class: 'card-plain compare-picker' });
  const out = el('div');
  main.append(head, picker, out);

  const pushHash = () => { try { history.replaceState(null, '', compareHash(paths, range)); } catch {} };

  const drawHead = () => {
    head.innerHTML = '';
    head.append(el('h1', {}, 'Compare targets'),
      el('span', { class: 'sub' }, paths.length ? `${paths.length} of ${MAX_COMPARE} selected` : `pick up to ${MAX_COMPARE} targets`),
      el('span', { class: 'spacer' }),
      seg(COMPARE_RANGES, range, (k) => { range = k; try { localStorage.setItem('sp.range', k); } catch {} pushHash(); drawHead(); load(); }));
  };

  const drawPicker = () => {
    picker.innerHTML = '';
    const chips = el('div', { class: 'compare-chips' });
    paths.forEach((p, i) => chips.append(el('button', {
      class: 'chip on compare-chip', style: `background:${COMPARE_COLORS[i]};border-color:${COMPARE_COLORS[i]}`,
      title: 'Remove ' + p, onclick: () => toggle(p),
    }, titleOf(p) + '  ✕')));
    if (!paths.length) chips.append(el('span', { class: 'sub' }, 'Nothing selected yet.'));
    const search = el('input', { class: 'input', type: 'search', placeholder: 'Search targets to add…', value: pickerSearch, autocomplete: 'off' });
    const list = el('div', { class: 'compare-list' });
    const fill = () => {
      list.innerHTML = '';
      const q = pickerSearch.toLowerCase();
      const cand = nodes.filter(n => !paths.includes(n.path) && (!q || (n.title + ' ' + n.path + ' ' + (n.host || '')).toLowerCase().includes(q)));
      for (const n of cand.slice(0, 60)) {
        list.append(el('button', { class: 'chip', disabled: paths.length >= MAX_COMPARE ? 'disabled' : null, onclick: () => toggle(n.path) },
          '+ ' + n.title));
      }
      if (!cand.length) list.append(el('span', { class: 'sub' }, q ? 'No targets match.' : 'All targets are selected.'));
      if (cand.length > 60) list.append(el('span', { class: 'sub' }, `… ${cand.length - 60} more - refine the search`));
    };
    search.addEventListener('input', (e) => { pickerSearch = e.target.value; fill(); });
    picker.append(chips, search, list);
    fill();
  };

  const toggle = (p) => {
    paths = paths.includes(p) ? paths.filter(x => x !== p) : (paths.length < MAX_COMPARE ? [...paths, p] : paths);
    pushHash(); drawHead(); drawPicker(); load();
  };

  async function load() {
    const my = ++loadId;
    out.innerHTML = '';
    if (!paths.length) { out.append(el('div', { class: 'empty' }, 'Choose two or more targets above to overlay their latency and loss.')); return; }
    out.append(el('div', { class: 'loading' }, 'Loading…'));
    let res;
    try { res = await Promise.all(paths.map(p => api('/node?' + new URLSearchParams({ path: p, range }).toString()))); }
    catch (e) { if (my === loadId) { out.innerHTML = ''; out.append(el('div', { class: 'empty' }, 'Could not load: ' + e.message)); } return; }
    if (my !== loadId) return;                       // a newer selection superseded this one
    out.innerHTML = '';

    const list = res.map((d, i) => ({ label: d.title, color: COMPARE_COLORS[i], path: d.path, t: d.series.t, median: d.series.median, loss: d.series.loss, stats: d.stats }));
    const wrap = el('div', { class: 'chart-wrap', style: 'position:relative' });
    const cv = el('canvas', { class: 'smokechart compare-chart' });
    const tip = el('div', { class: 'chart-tooltip', hidden: 'hidden' });
    const cross = el('div', { class: 'chart-cross', hidden: 'hidden' });
    wrap.append(cv, cross, tip);
    wrap.append(el('div', { class: 'chart-legend' },
      ...list.map(s => el('span', {}, el('i', { style: `background:${s.color}` }), s.label)),
      el('span', { class: 'zoom-hint' }, 'median latency (top) and packet loss (bottom)')));
    out.append(wrap);

    const drawNow = () => { const g = drawCompare(cv, list); attachCompareHover(cv, g, tip, cross); };
    requestAnimationFrame(drawNow);
    compareRO = new ResizeObserver(() => drawNow());
    compareRO.observe(cv);

    const tbl = el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, ...['', 'Target', 'Median now', 'Median avg', 'Median max', 'Loss now', 'Loss avg', 'Loss max'].map(h => el('th', {}, h)))));
    const tb = el('tbody');
    for (const s of list) {
      const st = s.stats || {};
      tb.append(el('tr', {},
        el('td', {}, el('i', { class: 'swatch', style: `background:${s.color}` })),
        el('td', {}, el('a', { href: '#/node' + s.path }, s.label)),
        el('td', { class: 'num' }, fmtMs(st.medianNowMs)), el('td', { class: 'num' }, fmtMs(st.medianAvgMs)),
        el('td', { class: 'num' }, fmtMs(st.medianMaxMs)),
        el('td', { class: 'num' }, D.fmtPct(st.lossNowPct)), el('td', { class: 'num' }, D.fmtPct(st.lossAvgPct)),
        el('td', { class: 'num' }, D.fmtPct(st.lossMaxPct))));
    }
    tbl.append(tb);
    out.append(el('div', { class: 'tablecard' }, el('div', { class: 'table-scroll' }, tbl)));
  }

  drawHead(); drawPicker(); load();
}

// ============================================================================
// persistent incident history
// ============================================================================

const HIST_RANGES = [['24h', '24 h'], ['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days']];
const histCache = new Map();          // url -> { at, data }

// options: { target: '/Sites/Google' (limit to one target), compact, title, range }
export function incidentHistory(opts = {}) {
  const { el, api } = D;
  let range = opts.range || (opts.target ? '30d' : (localStorage.getItem('sp.histRange') || '7d'));
  if (!HIST_RANGES.some(([k]) => k === range)) range = '7d';
  const card = el('div', { class: 'tablecard' });
  const body = el('div');
  const head = el('div', { class: 'tablecard-head' });
  card.append(head, body);
  let last = null;

  const url = () => '/events?range=' + range + (opts.target ? '&target=' + encodeURIComponent(opts.target) : '');

  const drawHead = () => {
    head.innerHTML = '';
    head.append(el('h2', {}, opts.title || 'Incident history'));
    const tools = el('div', { class: 'head-tools' });
    if (!opts.compact) {
      tools.append(seg(HIST_RANGES, range, (k) => {
        range = k;
        if (!opts.target) try { localStorage.setItem('sp.histRange', k); } catch {}
        drawHead(); load();
      }));
    }
    if (last && last.incidents.length) {
      tools.append(el('button', { class: 'chip', title: 'Download as CSV', onclick: () => D.downloadBlob(D.rowsToCsv(
        ['target', 'path', 'alert', 'started', 'ended', 'duration_sec', 'ongoing', 'maintenance'],
        last.incidents.map(i => [i.title, i.path, i.alert, new Date(i.start * 1000).toISOString(),
          i.end ? new Date(i.end * 1000).toISOString() : '', i.durationSec, i.open ? 'yes' : 'no', i.maintenance ? 'yes' : 'no'])),
        `smokeping-incidents-${range}.csv`) }, 'Export CSV'));
    }
    head.append(tools);
  };

  const drawBody = () => {
    body.innerHTML = '';
    if (!last) return;
    if (!last.incidents.length) {
      body.append(el('p', { class: 'note' }, 'No incidents in this period. History is recorded from the moment this version first started, and survives log rotation.'));
      return;
    }
    body.append(el('p', { class: 'note', style: 'padding-bottom:4px' },
      `${last.total} incident${last.total === 1 ? '' : 's'}` + (last.open ? ` · ${last.open} ongoing` : '') +
      (last.avgSec != null ? ` · average ${fmtDur(last.avgSec)}` : '') + (last.longestSec ? ` · longest ${fmtDur(last.longestSec)}` : '')));
    if (!opts.target && !opts.compact && last.byTarget.length > 1) {
      body.append(el('div', { class: 'offenders' }, el('span', { class: 'sub' }, 'Most incidents: '),
        ...last.byTarget.slice(0, 5).map(b => el('a', { class: 'chip', href: '#/node' + b.path }, `${b.title} ×${b.count}`))));
    }
    const tbl = el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, ...[opts.target ? null : 'Target', 'Alert', 'Started', 'Ended', 'Duration'].filter(Boolean).map(h => el('th', {}, h)))));
    const tb = el('tbody');
    for (const i of last.incidents.slice(0, opts.compact ? 10 : 200)) {
      tb.append(el('tr', {},
        opts.target ? null : el('td', {}, el('a', { href: '#/node' + i.path }, i.title)),
        el('td', {}, i.alert, i.maintenance ? el('span', { class: 'statusbadge maintenance', style: 'margin-left:6px', title: 'started during a maintenance window' }, 'planned') : null),
        el('td', {}, stamp(i.start)),
        el('td', {}, i.open ? el('span', { class: 'statusbadge critical' }, el('span', { class: 'dot' }), 'ongoing') : stamp(i.end)),
        el('td', { class: 'num', title: i.level ? 'level-triggered alert: the end is inferred from when it stopped being reported' : '' },
          fmtDur(i.durationSec) + (i.open ? ' so far' : ''))));
    }
    tbl.append(tb);
    body.append(el('div', { class: 'table-scroll' }, tbl));
  };

  async function load() {
    const key = url();
    const cached = histCache.get(key);
    if (cached) { last = cached.data; drawHead(); drawBody(); }
    else body.replaceChildren(el('p', { class: 'note' }, 'Loading…'));
    if (cached && Date.now() - cached.at < 20_000) return;
    try {
      const data = await api(key);
      histCache.set(key, { at: Date.now(), data });
      if (key !== url()) return;                     // range changed meanwhile
      last = data; drawHead(); drawBody();
    } catch (e) {
      if (!cached) body.replaceChildren(el('p', { class: 'note' }, 'Incident history unavailable: ' + e.message));
    }
  }
  drawHead();
  load();
  return card;
}

// ============================================================================
// Settings -> Alert rules
// ============================================================================

const KINDS = [
  ['loss',    'Packet loss (with recovery threshold)'],
  ['down',    'Host down (loss above a level)'],
  ['latency', 'High latency'],
  ['shift',   'Latency shift versus baseline'],
  ['custom',  'Custom pattern (advanced)'],
];

const KIND_DEFAULTS = {
  loss:    { pct: 10, minutes: 3, clearPct: 3, clearMinutes: 6 },
  down:    { pct: 90, minutes: 1 },
  latency: { ms: 300, minutes: 3 },
  shift:   { ratio: 200, currentMinutes: 3, historicMinutes: 10 },
  custom:  { type: 'matcher', pattern: '' },
};

export async function paneRules(pane) {
  const { el } = D;
  let data;
  try { data = await D.api('/alertdefs'); }
  catch (e) { pane.append(el('div', { class: 'empty' }, 'Could not load alert rules: ' + e.message)); return; }

  const listHost = el('div');
  const editorHost = el('div');
  pane.append(listHost, editorHost);

  const openEditor = (mode, def) => {
    editorHost.innerHTML = '';
    editorHost.append(ruleEditor({
      mode, def, stepSec: data.stepSec,
      onClose: () => { editorHost.innerHTML = ''; },
      onSaved: async () => { editorHost.innerHTML = ''; await reload(); },
    }));
    editorHost.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  async function reload() {
    try { data = await D.api('/alertdefs'); } catch (e) { D.toast('Reload failed: ' + e.message, true); return; }
    try { D.state.tree = await D.api('/tree'); D.renderTree(); } catch {}
    drawList();
  }

  function drawList() {
    listHost.innerHTML = '';
    const card = el('div', { class: 'card-plain' });
    card.append(el('div', { class: 'card-top' },
      el('h2', { style: 'margin:0' }, 'Alert rules'),
      el('span', { class: 'spacer', style: 'flex:1' }),
      el('button', { class: 'chip on', onclick: () => openEditor('create', null) }, '+ New rule')));
    card.append(el('p', { class: 'sub' },
      `Write rules in minutes, not poll cycles - your poll step is ${data.stepSec} s, so the form converts for you. ` +
      'Rules are validated with smokeping --check before they are saved. Assign a rule to targets under Targets.'));
    if (!data.alerts.length) card.append(el('p', { class: 'note' }, 'No rules defined yet.'));
    else {
      const tbl = el('table', { class: 'data' },
        el('thead', {}, el('tr', {}, ...['Rule', 'Triggers when', 'Assigned to', 'Notify', ''].map(h => el('th', {}, h)))));
      const tb = el('tbody');
      for (const a of data.alerts) {
        const used = a.usedBy || [];
        tb.append(el('tr', {},
          el('td', {}, el('strong', {}, a.name), a.comment ? el('div', { class: 'cell-sub' }, a.comment) : null),
          el('td', { style: 'white-space:normal;max-width:360px' }, a.human, a.rule.kind === 'custom' ? null : el('div', { class: 'cell-sub pattern-sub' }, a.pattern)),
          el('td', { style: 'white-space:normal' }, used.length
            ? el('span', { title: used.join('\n') }, used.length === 1 ? used[0] : `${used.length} places`)
            : el('span', { class: 'sub' }, 'unused')),
          el('td', {}, a.edgetrigger ? 'on raise + clear' : 'every cycle', a.priority != null ? el('div', { class: 'cell-sub' }, 'priority ' + a.priority) : null),
          el('td', {}, el('div', { class: 'row-actions' },
            el('button', { class: 'chip', onclick: () => openEditor('edit', a) }, 'Edit'),
            el('button', { class: 'chip danger', onclick: () => removeRule(a) }, 'Delete')))));
      }
      tbl.append(tb);
      card.append(el('div', { class: 'table-scroll' }, tbl));
    }
    listHost.append(card);
  }

  async function removeRule(a) {
    if ((a.usedBy || []).length) {
      D.toast(`'${a.name}' is still assigned to ${a.usedBy.join(', ')} - remove it there first.`, true);
      return;
    }
    if (!confirm(`Delete the alert rule '${a.name}'? A .bak copy of the Alerts file is kept.`)) return;
    try { await D.post('/alertdefs/delete', { name: a.name }); D.toast(`Deleted ${a.name}.`); await reload(); }
    catch (e) { D.toast(e.message, true); }
  }

  drawList();
}

// one editor card. def = an entry from GET /alertdefs (edit) or null (create)
function ruleEditor({ mode, def, stepSec, onClose, onSaved }) {
  const { el } = D;
  const edit = mode === 'edit';
  const rule = def ? def.rule : { kind: 'loss', ...KIND_DEFAULTS.loss };
  const v = { ...KIND_DEFAULTS[rule.kind], ...rule };
  const meta = {
    name: def ? def.name : '',
    comment: def && def.comment ? def.comment : '',
    priority: def && def.priority != null ? String(def.priority) : '',
    edge: def ? !!def.edgetrigger : true,
  };

  const card = el('div', { class: 'card-plain rule-editor' });
  const formHost = el('div');
  const preview = el('div', { class: 'rule-preview' });
  const res = D.resultBox();

  const num = (key, opts = {}) => {
    const i = el('input', { class: 'input inline-num', type: 'number', step: opts.step || 'any', min: opts.min ?? '0', value: v[key] ?? '' });
    i.addEventListener('input', () => { v[key] = i.value; schedulePreview(); });
    return i;
  };
  const sentence = (...parts) => el('p', { class: 'rule-sentence' }, ...parts);

  const drawForm = () => {
    formHost.innerHTML = '';
    const kindSel = el('select', { class: 'input' }, ...KINDS.map(([k, l]) => el('option', { value: k }, l)));
    kindSel.value = v.kind;
    kindSel.addEventListener('change', () => {
      const keep = { kind: kindSel.value };
      Object.assign(v, KIND_DEFAULTS[kindSel.value], keep);
      drawForm(); schedulePreview();
    });
    const nameIn = D.input({ placeholder: 'e.g. slowlink', value: meta.name, maxlength: '40', disabled: edit ? 'disabled' : null });
    nameIn.addEventListener('input', () => { meta.name = nameIn.value.trim(); });
    formHost.append(el('div', { class: 'form-grid' },
      D.field('Name', nameIn, edit ? 'names cannot be changed - create a new rule instead' : 'letters, digits and _ , starting with a letter'),
      D.field('Type of rule', kindSel)));

    if (v.kind === 'loss') {
      formHost.append(
        sentence('Raise when packet loss is at least ', num('pct', { min: '1' }), ' % for ', num('minutes'), ' minutes.'),
        sentence('Clear when loss falls below ', num('clearPct'), ' % for ', num('clearMinutes'), ' minutes.'));
    } else if (v.kind === 'down') {
      formHost.append(sentence('Raise when packet loss is above ', num('pct', { min: '1' }), ' % for ', num('minutes'),
        ' minutes. Clears as soon as it is not (use "Packet loss" for a slower recovery).'));
    } else if (v.kind === 'latency') {
      formHost.append(sentence('Raise when median latency is at least ', num('ms', { min: '1' }), ' ms for ', num('minutes'), ' minutes.'));
    } else if (v.kind === 'shift') {
      formHost.append(sentence('Raise when latency over the last ', num('currentMinutes'), ' minutes is more than ', num('ratio', { min: '101' }),
        ' % of the average of the previous ', num('historicMinutes'), ' minutes.'));
    } else {
      const typeSel = el('select', { class: 'input' }, ...['matcher', 'loss', 'rtt'].map(t => el('option', { value: t }, t)));
      typeSel.value = v.type || 'matcher';
      typeSel.addEventListener('change', () => { v.type = typeSel.value; schedulePreview(); });
      const pat = el('textarea', { class: 'input code', rows: '3', spellcheck: 'false' });
      pat.value = v.pattern || '';
      pat.addEventListener('input', () => { v.pattern = pat.value; schedulePreview(); });
      formHost.append(el('div', { class: 'form-grid' }, D.field('Pattern type', typeSel), D.field('Pattern', pat, 'raw SmokePing syntax, e.g. ConsecutiveLoss(...) or >90%,>90%')));
    }

    const comment = D.input({ placeholder: 'Shown in alert mails and on the Alerts page', value: meta.comment, maxlength: '200' });
    comment.addEventListener('input', () => { meta.comment = comment.value; });
    const prio = D.input({ type: 'number', min: '1', max: '99', placeholder: 'optional, lower = more important', value: meta.priority });
    prio.addEventListener('input', () => { meta.priority = prio.value; });
    const edge = el('input', { type: 'checkbox' }); edge.checked = meta.edge;
    edge.addEventListener('change', () => { meta.edge = edge.checked; });
    formHost.append(el('div', { class: 'form-grid' },
      D.field('Comment', comment), D.field('Priority', prio),
      D.field('Notify once per event', el('label', { class: 'switch' }, edge, ' only when it is raised and when it clears (recommended)'))));
  };

  // --- live preview -----------------------------------------------------------
  let timer = null, seq = 0;
  const query = () => {
    const qs = new URLSearchParams({ kind: v.kind });
    const keys = { loss: ['pct', 'minutes', 'clearPct', 'clearMinutes'], down: ['pct', 'minutes'], latency: ['ms', 'minutes'],
                   shift: ['ratio', 'currentMinutes', 'historicMinutes'], custom: ['type', 'pattern'] }[v.kind];
    for (const k of keys) if (v[k] != null && String(v[k]) !== '') qs.set(k, v[k]);
    return qs;
  };
  function schedulePreview() { clearTimeout(timer); timer = setTimeout(runPreview, 450); }
  async function runPreview() {
    const my = ++seq;
    preview.className = 'rule-preview busy';
    let p;
    try { p = await D.api('/alertpreview?' + query().toString(), { timeout: 60_000, retries: 0 }); }
    catch (e) {
      if (my !== seq) return;
      preview.className = 'rule-preview bad';
      preview.replaceChildren(el('div', {}, e.message));
      return;
    }
    if (my !== seq) return;
    preview.className = 'rule-preview';
    preview.innerHTML = '';
    preview.append(el('div', { class: 'preview-rule' }, el('strong', {}, p.rule.human), ' ',
      el('span', { class: 'pattern', title: `${p.rule.type} pattern written to the Alerts file` }, p.rule.pattern)));
    const now = p.firingNow || [];
    preview.append(el('div', { class: 'preview-line' + (now.length ? ' warn' : ' ok') },
      now.length ? `Would be firing right now on ${now.length} of ${p.targetsChecked} targets: ` : `Not firing right now on any of the ${p.targetsChecked} targets.`,
      ...now.slice(0, 8).map(n => el('a', { class: 'chip', href: '#/node' + n.path }, n.title)),
      now.length > 8 ? el('span', { class: 'sub' }, ` +${now.length - 8} more`) : null));
    const rep = p.replay;
    preview.append(el('div', { class: 'preview-line' },
      rep.totalRaises
        ? `Replaying the last ${rep.hours} hours: it would have been raised ${rep.totalRaises} time${rep.totalRaises === 1 ? '' : 's'} on ${rep.targets.length} target${rep.targets.length === 1 ? '' : 's'}.`
        : `Replaying the last ${rep.hours} hours: it would never have fired. If that is unexpected, lower the threshold or the time.`));
    if (rep.targets.length) {
      const tbl = el('table', { class: 'data' },
        el('thead', {}, el('tr', {}, ...['Target', 'Raised', 'Firing for', 'Last raised'].map(h => el('th', {}, h)))));
      const tb = el('tbody');
      for (const t of rep.targets.slice(0, 8)) {
        tb.append(el('tr', {},
          el('td', {}, el('a', { href: '#/node' + t.path }, t.title)),
          el('td', { class: 'num' }, t.raises + '×'),
          el('td', { class: 'num' }, fmtDur(t.firingMinutes * 60)),
          el('td', {}, t.last ? stamp(t.last) : '–')));
      }
      tbl.append(tb);
      preview.append(el('div', { class: 'table-scroll' }, tbl));
      if (rep.targets.length > 8) preview.append(el('p', { class: 'sub' }, `… and ${rep.targets.length - 8} more targets`));
    }
  }

  // --- save ----------------------------------------------------------------
  async function save(btn) {
    btn.disabled = true;
    try {
      const rulePayload = { kind: v.kind };
      for (const k of { loss: ['pct', 'minutes', 'clearPct', 'clearMinutes'], down: ['pct', 'minutes'], latency: ['ms', 'minutes'],
                        shift: ['ratio', 'currentMinutes', 'historicMinutes'], custom: ['type', 'pattern'] }[v.kind]) rulePayload[k] = v[k];
      const r = await D.post('/alertdefs', {
        name: meta.name, create: !edit, rule: rulePayload, comment: meta.comment,
        priority: meta.priority, edgetrigger: meta.edge,
      });
      D.toast(`${edit ? 'Saved' : 'Created'} ${r.name}. SmokePing is reloading.`);
      await onSaved();
    } catch (e) {
      D.showResult(res, { ok: false, error: e.message, ...(e.data || {}) });
      btn.disabled = false;
    }
  }

  card.append(
    el('h2', {}, edit ? `Edit rule: ${def.name}` : 'New alert rule'),
    formHost,
    el('h3', { class: 'preview-title' }, 'What this rule would do on your data'),
    preview,
    el('div', { class: 'modal-actions' },
      el('button', { class: 'chip', onclick: onClose }, 'Cancel'),
      el('button', { class: 'chip on', onclick: (e) => save(e.currentTarget) }, edit ? 'Save rule' : 'Create rule')),
    res);
  drawForm();
  runPreview();
  return card;
}

// ============================================================================
// Settings -> Maintenance
// ============================================================================

const pad2 = (n) => String(n).padStart(2, '0');
const toLocalInput = (ts) => { const d = new Date(ts * 1000); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const fromLocalInput = (v) => Math.floor(new Date(v).getTime() / 1000);
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// "14:30" today, otherwise date + time
export function fmtUntil(ts) {
  if (!ts) return '?';
  const d = new Date(ts * 1000), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function describeWhen(w) {
  if (w.mode === 'weekly') {
    return `${(w.days || []).map(d => DAY_NAMES[d]).join(', ')} at ${w.time} for ${fmtDur((w.durationMin || 0) * 60)}`;
  }
  return `${stamp(w.start)} → ${stamp(w.end)}`;
}

function describeScope(w) {
  const p = w.paths || [];
  if (!p.length) return 'All targets';
  return p.map(x => x.split('/').filter(Boolean).pop()).join(', ');
}

// flat [{path, label, depth, isLeaf}] of the whole target tree
function flatTree() {
  const out = [];
  const walk = (node, depth) => {
    for (const c of (node.children || [])) {
      out.push({ path: c.path, label: c.menu || c.name, depth, isLeaf: !!c.isLeaf });
      walk(c, depth + 1);
    }
  };
  if (D.state.tree) walk(D.state.tree.root, 0);
  return out;
}

export async function paneMaintenance(pane) {
  const { el } = D;
  let data;
  try { data = await D.api('/maintenance'); }
  catch (e) { pane.append(el('div', { class: 'empty' }, 'Could not load maintenance windows: ' + e.message)); return; }

  const listHost = el('div');
  const editorHost = el('div');
  pane.append(listHost, editorHost);

  const openEditor = (w, preset) => {
    editorHost.innerHTML = '';
    editorHost.append(maintenanceEditor({
      w, preset,
      onClose: () => { editorHost.innerHTML = ''; },
      onSaved: async () => { editorHost.innerHTML = ''; await reload(); },
    }));
    editorHost.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  async function reload() {
    try { data = await D.api('/maintenance'); } catch (e) { D.toast('Reload failed: ' + e.message, true); return; }
    drawList();
  }

  const statusCell = (w) => {
    const st = w.state || {};
    if (w.enabled === false) return el('span', { class: 'sub' }, 'disabled');
    if (st.status === 'active') return el('span', { class: 'statusbadge warning' }, el('span', { class: 'dot' }), 'Active until ' + fmtUntil(st.until));
    if (st.status === 'upcoming') return el('span', { class: 'sub' }, (w.mode === 'weekly' ? 'Next: ' : 'Starts ') + fmtUntil(st.next));
    return el('span', { class: 'sub' }, 'Ended');
  };

  function drawList() {
    listHost.innerHTML = '';
    const card = el('div', { class: 'card-plain' });
    card.append(el('div', { class: 'card-top' },
      el('h2', { style: 'margin:0' }, 'Maintenance windows'),
      el('span', { style: 'flex:1' }),
      el('button', { class: 'chip on', onclick: () => openEditor(null) }, '+ New window')));
    card.append(el('p', { class: 'sub' },
      'While a window covers a target its alert e-mails and webhooks are not sent, it shows as "maintenance" instead of a problem, and its downtime is left out of the availability report. ' +
      'SmokePing keeps measuring as usual. Weekly windows use the server’s time zone.'));
    const wins = (data.windows || []).slice().sort((a, b) => {
      const rank = (w) => ({ active: 0, upcoming: 1, ended: 2 }[(w.state || {}).status] ?? 3);
      return rank(a) - rank(b) || ((a.state || {}).next || 0) - ((b.state || {}).next || 0);
    });
    if (!wins.length) card.append(el('p', { class: 'note' }, 'No maintenance windows. Planning work on a router? Add one so it does not page anybody or count against your uptime.'));
    else {
      const tbl = el('table', { class: 'data' },
        el('thead', {}, el('tr', {}, ...['Window', 'Covers', 'When', 'Status', ''].map(h => el('th', {}, h)))));
      const tb = el('tbody');
      for (const w of wins) {
        const st = w.state || {};
        const actions = el('div', { class: 'row-actions' },
          el('button', { class: 'chip', onclick: () => openEditor(w) }, 'Edit'));
        if (st.status === 'active' && w.mode === 'once') {
          actions.append(el('button', { class: 'chip', title: 'Finish the window right now', onclick: () => endNow(w) }, 'End now'));
        }
        actions.append(el('button', { class: 'chip danger', onclick: () => remove(w) }, 'Delete'));
        tb.append(el('tr', { class: st.status === 'ended' ? 'row-muted' : '' },
          el('td', {}, el('strong', {}, w.title), w.note ? el('div', { class: 'cell-sub' }, w.note) : null),
          el('td', { style: 'white-space:normal;max-width:220px' }, describeScope(w)),
          el('td', { style: 'white-space:normal' }, describeWhen(w)),
          el('td', {}, statusCell(w)),
          el('td', {}, actions)));
      }
      tbl.append(tb);
      card.append(el('div', { class: 'table-scroll' }, tbl));
    }
    listHost.append(card);
  }

  async function endNow(w) {
    try {
      await D.post('/maintenance', { id: w.id, title: w.title, note: w.note, paths: w.paths, mode: 'once', start: w.start, end: Math.floor(Date.now() / 1000), enabled: w.enabled });
      D.toast('Maintenance ended.'); await reload();
    } catch (e) { D.toast(e.message, true); }
  }
  async function remove(w) {
    if (!confirm(`Delete the maintenance window '${w.title}'?`)) return;
    try { await D.post('/maintenance/delete', { id: w.id }); D.toast('Deleted.'); await reload(); }
    catch (e) { D.toast(e.message, true); }
  }

  drawList();
  // deep link from a target page: #/settings/maintenance?path=/WAN/Quad9
  const q = new URLSearchParams((location.hash.split('?')[1]) || '');
  if (q.get('path')) openEditor(null, { path: q.get('path') });
}

function maintenanceEditor({ w, preset, onClose, onSaved }) {
  const { el } = D;
  const edit = !!w;
  const now = Math.floor(Date.now() / 1000);
  const m = {
    id: w ? w.id : undefined,
    title: w ? w.title : '',
    note: w ? (w.note || '') : '',
    all: w ? !(w.paths || []).length : !(preset && preset.path),
    paths: new Set(w ? (w.paths || []) : (preset && preset.path ? [preset.path] : [])),
    mode: w ? w.mode : 'once',
    start: toLocalInput(w && w.mode === 'once' ? w.start : now),
    end: toLocalInput(w && w.mode === 'once' ? w.end : now + 7200),
    days: new Set(w && w.mode === 'weekly' ? w.days : [6]),
    time: w && w.mode === 'weekly' ? w.time : '03:00',
    hours: w && w.mode === 'weekly' ? (w.durationMin / 60) : 2,
    enabled: w ? w.enabled !== false : true,
  };
  const tree = flatTree();
  const nodes = (D.state.summary && D.state.summary.nodes) || [];

  const card = el('div', { class: 'card-plain rule-editor' });
  const formHost = el('div');
  const summary = el('p', { class: 'sub maint-summary' });
  const res = D.resultBox();

  const covered = () => nodes.filter(n => m.all || [...m.paths].some(p => n.path === p || n.path.startsWith(p + '/'))).length;
  const drawSummary = () => {
    const n = covered();
    summary.textContent = `Silences alerts, e-mail and webhooks for ${n} target${n === 1 ? '' : 's'} and leaves their downtime out of the availability report.`;
  };

  const draw = () => {
    formHost.innerHTML = '';
    const title = D.input({ placeholder: 'e.g. Router firmware upgrade', value: m.title, maxlength: '80' });
    title.addEventListener('input', () => { m.title = title.value; });
    const note = D.input({ placeholder: 'optional - shown on the dashboard', value: m.note, maxlength: '300' });
    note.addEventListener('input', () => { m.note = note.value; });
    formHost.append(el('div', { class: 'form-grid' }, D.field('Title', title), D.field('Note', note)));

    // scope
    const allRadio = el('input', { type: 'radio', name: 'maint-scope' }); allRadio.checked = m.all;
    const selRadio = el('input', { type: 'radio', name: 'maint-scope' }); selRadio.checked = !m.all;
    const picker = el('div', { class: 'maint-tree', hidden: m.all ? 'hidden' : null });
    for (const t of tree) {
      const cb = el('input', { type: 'checkbox' }); cb.checked = m.paths.has(t.path);
      cb.addEventListener('change', () => { cb.checked ? m.paths.add(t.path) : m.paths.delete(t.path); drawSummary(); });
      picker.append(el('label', { class: 'maint-node', style: `padding-left:${t.depth * 18 + 4}px` }, cb, ' ', t.isLeaf ? t.label : el('strong', {}, t.label + '  (whole group)')));
    }
    if (!tree.length) picker.append(el('span', { class: 'sub' }, 'No targets loaded.'));
    allRadio.addEventListener('change', () => { m.all = true; picker.hidden = true; drawSummary(); });
    selRadio.addEventListener('change', () => { m.all = false; picker.hidden = false; drawSummary(); });
    formHost.append(D.field('Covers',
      el('div', {},
        el('label', { class: 'switch' }, allRadio, ' every target'), el('br'),
        el('label', { class: 'switch' }, selRadio, ' only the targets / groups I tick'),
        picker)));

    // when
    const modeSel = el('select', { class: 'input' },
      el('option', { value: 'once' }, 'One time'), el('option', { value: 'weekly' }, 'Repeats every week'));
    modeSel.value = m.mode;
    modeSel.addEventListener('change', () => { m.mode = modeSel.value; draw(); });
    formHost.append(D.field('Schedule', modeSel));

    if (m.mode === 'once') {
      const s = el('input', { class: 'input', type: 'datetime-local', value: m.start });
      const e = el('input', { class: 'input', type: 'datetime-local', value: m.end });
      s.addEventListener('input', () => { m.start = s.value; });
      e.addEventListener('input', () => { m.end = e.value; });
      const quick = el('div', { class: 'seg', style: 'flex-wrap:wrap' }, el('span', { class: 'seg-label' }, 'Start now for'),
        ...[1, 2, 4, 8, 24].map(h => el('button', { onclick: () => {
          const t = Math.floor(Date.now() / 1000);
          m.start = toLocalInput(t); m.end = toLocalInput(t + h * 3600); s.value = m.start; e.value = m.end;
        } }, h + ' h')));
      formHost.append(el('div', { class: 'form-grid' }, D.field('From', s), D.field('Until', e)), quick);
    } else {
      const days = el('div', { class: 'alert-checks' }, ...DAY_NAMES.map((n, i) => {
        const cb = el('input', { type: 'checkbox' }); cb.checked = m.days.has(i);
        cb.addEventListener('change', () => { cb.checked ? m.days.add(i) : m.days.delete(i); });
        return el('label', { class: 'alert-check' }, cb, ' ', n);
      }));
      const time = el('input', { class: 'input', type: 'time', value: m.time });
      time.addEventListener('input', () => { m.time = time.value; });
      const hrs = el('input', { class: 'input', type: 'number', min: '0.25', max: '48', step: '0.25', value: m.hours });
      hrs.addEventListener('input', () => { m.hours = hrs.value; });
      formHost.append(D.field('On', days), el('div', { class: 'form-grid' },
        D.field('Starting at', time, 'server time zone'), D.field('Lasting (hours)', hrs, 'up to 48; may run past midnight')));
    }
    const en = el('input', { type: 'checkbox' }); en.checked = m.enabled;
    en.addEventListener('change', () => { m.enabled = en.checked; });
    formHost.append(el('label', { class: 'switch' }, en, ' enabled'));
    drawSummary();
  };

  async function save(btn) {
    btn.disabled = true;
    try {
      if (!m.all && !m.paths.size) throw new Error('Tick at least one target or group, or choose "every target".');
      const body = { id: m.id, title: m.title, note: m.note, paths: m.all ? [] : [...m.paths], mode: m.mode, enabled: m.enabled };
      if (m.mode === 'once') {
        body.start = fromLocalInput(m.start); body.end = fromLocalInput(m.end);
        if (!isFinite(body.start) || !isFinite(body.end)) throw new Error('Pick a start and an end time.');
      } else {
        body.days = [...m.days]; body.time = m.time; body.durationMin = Math.round(parseFloat(m.hours) * 60);
      }
      await D.post('/maintenance', body);
      D.toast(edit ? 'Maintenance window saved.' : 'Maintenance window created.');
      await onSaved();
    } catch (e) {
      D.showResult(res, { ok: false, error: e.message, ...(e.data || {}) });
      btn.disabled = false;
    }
  }

  card.append(el('h2', {}, edit ? `Edit: ${w.title}` : 'New maintenance window'), formHost, summary,
    el('div', { class: 'modal-actions' },
      el('button', { class: 'chip', onclick: onClose }, 'Cancel'),
      el('button', { class: 'chip on', onclick: (e) => save(e.currentTarget) }, edit ? 'Save window' : 'Create window')),
    res);
  draw();
  return card;
}

// ============================================================================
// Settings -> Uptime goals
// ============================================================================

const GOAL_PRESETS = [99, 99.5, 99.9, 99.95, 99.99];
const allowedDowntime = (target) => 30 * 86400 * (100 - target) / 100;
const scopeLabel = (p) => (!p || p === '/') ? 'Everything (default)' : p;

export async function paneGoals(pane) {
  const { el } = D;
  let data;
  try { data = await D.api('/goals'); }
  catch (e) { pane.append(el('div', { class: 'empty' }, 'Could not load goals: ' + e.message)); return; }

  const listHost = el('div');
  const formHost = el('div');
  pane.append(listHost, formHost);

  const drawList = () => {
    listHost.innerHTML = '';
    const card = el('div', { class: 'card-plain' });
    card.append(el('h2', {}, 'Uptime goals'),
      el('p', { class: 'sub' },
        'Set the availability each group or target should reach. The Availability report then shows pass / fail and how much of this month’s downtime budget is left. ' +
        'A target follows the most specific goal that covers it: its own, else its group’s, else the default.'));
    if (!data.goals.length) card.append(el('p', { class: 'note' }, 'No goals yet - add one below (99.9 % is a common start).'));
    else {
      const tbl = el('table', { class: 'data' },
        el('thead', {}, el('tr', {}, ...['Applies to', 'Goal', 'Allowed downtime', 'Note', ''].map(h => el('th', {}, h)))));
      const tb = el('tbody');
      for (const g of data.goals) {
        tb.append(el('tr', {},
          el('td', {}, el('strong', {}, scopeLabel(g.path))),
          el('td', { class: 'num' }, g.target + ' %'),
          el('td', { class: 'num' }, fmtDur(g.allowedPerMonthSec) + ' / 30 days'),
          el('td', {}, g.note || ''),
          el('td', {}, el('div', { class: 'row-actions' },
            el('button', { class: 'chip', onclick: () => drawForm(g) }, 'Edit'),
            el('button', { class: 'chip danger', onclick: () => remove(g) }, 'Delete')))));
      }
      tbl.append(tb);
      card.append(el('div', { class: 'table-scroll' }, tbl));
    }
    listHost.append(card);
  };

  async function remove(g) {
    if (!confirm(`Remove the goal for ${scopeLabel(g.path)}?`)) return;
    try { data = await D.post('/goals/delete', { path: g.path }); D.toast('Goal removed.'); drawList(); }
    catch (e) { D.toast(e.message, true); }
  }

  const drawForm = (g) => {
    formHost.innerHTML = '';
    const tree = flatTree();
    const scope = el('select', { class: 'input' },
      el('option', { value: '/' }, 'Everything (default)'),
      ...tree.map(t => el('option', { value: t.path }, `${'  '.repeat(t.depth)}${t.label}${t.isLeaf ? '' : '  (group)'}`)));
    scope.value = g ? g.path : '/';
    const target = D.input({ type: 'number', step: '0.001', min: '50', max: '99.9999', value: g ? g.target : 99.9 });
    const note = D.input({ placeholder: 'optional, e.g. "customer SLA"', value: g && g.note ? g.note : '', maxlength: '200' });
    const hint = el('span', { class: 'field-help' });
    const upd = () => {
      const t = parseFloat(target.value);
      hint.textContent = isFinite(t) && t >= 50 && t < 100 ? `Allows about ${fmtDur(allowedDowntime(t))} of downtime per 30-day month.` : 'Enter a percentage between 50 and 99.9999.';
    };
    target.addEventListener('input', upd);
    const presets = el('div', { class: 'seg', style: 'flex-wrap:wrap' },
      ...GOAL_PRESETS.map(p => el('button', { onclick: () => { target.value = p; upd(); } }, p + ' %')));
    const res = D.resultBox();
    formHost.append(el('div', { class: 'card-plain rule-editor' },
      el('h2', {}, g ? 'Edit goal' : 'Add a goal'),
      el('div', { class: 'form-grid' },
        D.field('Applies to', scope, 'a group covers every target below it'),
        D.field('Availability goal (%)', el('div', {}, target, hint)),
        D.field('Note', note)),
      presets,
      el('div', { class: 'modal-actions' },
        el('button', { class: 'chip', onclick: () => { formHost.innerHTML = ''; } }, 'Cancel'),
        el('button', { class: 'chip on', onclick: async (e) => {
          const btn = e.currentTarget; btn.disabled = true;
          try {
            data = await D.post('/goals', { path: scope.value, target: target.value, note: note.value });
            D.toast('Goal saved.'); formHost.innerHTML = ''; drawList();
          } catch (err) { D.showResult(res, { ok: false, error: err.message, ...(err.data || {}) }); btn.disabled = false; }
        } }, 'Save goal')),
      res));
    upd();
  };

  drawList();
  drawForm(null);
}

// report cells -------------------------------------------------------------------

function goalCell(row) {
  const { el } = D;
  if (row.goal == null) return el('span', { class: 'sub' }, '–');
  const badge = row.meets == null ? null
    : el('span', { class: 'statusbadge ' + (row.meets ? 'ok' : 'critical') }, el('span', { class: 'dot' }), row.meets ? 'Meets' : 'Misses');
  return el('div', {}, el('span', { class: 'num', style: 'margin-right:6px' }, row.goal + ' %'), badge);
}

function budgetCell(row) {
  const { el } = D;
  const b = row.budget;
  if (!b) return el('span', { class: 'sub' }, row.goal == null ? '–' : 'no data yet');
  const cls = b.status === 'breached' ? 'critical' : b.status === 'at_risk' ? 'warning' : 'ok';
  const pct = Math.max(0, Math.min(100, b.usedPct));
  const text = b.remainingSec >= 0 ? `${fmtDur(b.remainingSec)} left of ${fmtDur(b.budgetSec)}` : `over budget by ${fmtDur(-b.remainingSec)}`;
  const tip = `used ${fmtDur(b.usedSec)} of ${fmtDur(b.budgetSec)}; at this pace the month ends at ${fmtDur(b.projectedSec)}`;
  return el('div', { class: 'availbar', title: tip },
    el('span', { class: 'track' }, el('i', { class: cls, style: `width:${pct}%` })),
    el('span', { class: 'budget-text' }, text));
}

// ============================================================================
// Settings -> Backup
// ============================================================================

const BACKUP_GROUPS = [
  ['config', 'Configuration', 'Targets, Alerts, Probes, Database, General, Presentation, Slaves, pathnames - validated with smokeping --check first'],
  ['state', 'Acknowledgements, maintenance windows, uptime goals', ''],
  ['history', 'Incident history', 'replaces the current history'],
  ['secrets', 'Credentials', 'mail passwords / OAuth secrets and webhook URLs'],
];

const stampName = () => {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
};
const fmtBytes = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';

export function paneBackup(pane) {
  const { el } = D;

  // --- download ------------------------------------------------------------
  const secrets = el('input', { type: 'checkbox' });
  const dres = D.resultBox();
  pane.append(el('div', { class: 'card-plain' },
    el('h2', {}, 'Download a backup'),
    el('p', { class: 'sub' },
      'One file with your SmokePing configuration, acknowledgements, maintenance windows, uptime goals and the incident history. ' +
      'It does not include the measurement data (the RRD files in /data - back that folder up separately), logs or the login password.'),
    el('label', { class: 'switch' }, secrets, ' include credentials (mail passwords, OAuth secrets, webhook URLs)'),
    el('p', { class: 'field-help' }, 'Leave this off unless you need a full disaster-recovery copy. A backup with credentials must be kept as safe as the passwords themselves.'),
    el('div', { class: 'modal-actions', style: 'justify-content:flex-start' },
      el('button', { class: 'chip on', onclick: async (e) => {
        const btn = e.currentTarget; btn.disabled = true;
        try {
          const arch = await D.api('/backup?secrets=' + (secrets.checked ? '1' : '0'), { timeout: 90_000 });
          D.downloadBlob(JSON.stringify(arch, null, 1), `modern-smokeping-backup-${stampName()}.json`, 'application/json');
          D.showResult(dres, { ok: true }, `Downloaded ${arch.files.length} files (${fmtBytes(arch.files.reduce((n, f) => n + f.bytes, 0))}).`);
        } catch (err) { D.showResult(dres, { ok: false, error: err.message }); }
        btn.disabled = false;
      } }, 'Download backup')),
    dres));

  // --- restore -------------------------------------------------------------
  const fileIn = el('input', { type: 'file', accept: '.json,application/json', class: 'input' });
  const preview = el('div');
  pane.append(el('div', { class: 'card-plain danger' },
    el('h2', {}, 'Restore from a backup'),
    el('p', { class: 'sub' },
      'Pick a backup file to see exactly what would change before anything is written. Configuration is validated first and a .bak copy of every replaced file is kept.'),
    fileIn, preview));

  let archive = null;
  fileIn.addEventListener('change', async () => {
    preview.innerHTML = ''; archive = null;
    const f = fileIn.files && fileIn.files[0];
    if (!f) return;
    let info;
    try {
      archive = JSON.parse(await f.text());
      info = await D.post('/backup/restore', { archive, dryRun: true });
    } catch (err) {
      preview.append(el('pre', { class: 'result bad' }, 'Cannot use that file: ' + (err.message || err)));
      archive = null; return;
    }
    drawPreview(info);
  });

  function drawPreview(info) {
    preview.innerHTML = '';
    const groupsPresent = new Set(info.files.map(f => f.group));
    const chosen = new Set(BACKUP_GROUPS.filter(([g]) => g !== 'secrets' && groupsPresent.has(g) && info.files.some(f => f.group === g && f.status !== 'same')).map(([g]) => g));
    preview.append(el('p', { class: 'sub', style: 'margin-top:12px' },
      `Backup from ${info.host || 'unknown host'}, ${info.created ? new Date(info.created * 1000).toLocaleString() : ''}` +
      (info.appVersion ? `, version ${info.appVersion}` : '') + (info.includesSecrets ? ' - contains credentials' : '') + '.'));
    const tbl = el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, ...['File', 'Part', 'Size', 'Compared to now'].map(h => el('th', {}, h)))));
    const tb = el('tbody');
    for (const f of info.files) {
      tb.append(el('tr', { class: f.status === 'same' ? 'row-muted' : '' },
        el('td', {}, f.name, f.secret ? el('span', { class: 'statusbadge warning', style: 'margin-left:6px' }, 'credentials') : null),
        el('td', {}, f.group), el('td', { class: 'num' }, fmtBytes(f.bytes)),
        el('td', {}, el('span', { class: 'statusbadge ' + (f.status === 'same' ? 'ok' : f.status === 'new' ? 'unknown' : 'warning') }, f.status))));
    }
    tbl.append(tb);
    preview.append(el('div', { class: 'table-scroll' }, tbl));

    const boxes = BACKUP_GROUPS.filter(([g]) => groupsPresent.has(g)).map(([g, label, help]) => {
      const cb = el('input', { type: 'checkbox' }); cb.checked = chosen.has(g);
      cb.addEventListener('change', () => { cb.checked ? chosen.add(g) : chosen.delete(g); });
      return el('label', { class: 'alert-check', title: help }, cb, ' ', label);
    });
    const pw = D.input({ type: 'password', placeholder: 'Settings password', autocomplete: 'current-password' });
    const res = D.resultBox();
    preview.append(D.field('Restore these parts', el('div', { class: 'alert-checks' }, ...boxes)),
      D.field('Confirm with your password', pw, 'restoring overwrites the live configuration'),
      el('div', { class: 'modal-actions' },
        el('button', { class: 'chip danger', onclick: async (e) => {
          const btn = e.currentTarget;
          if (!chosen.size) { D.showResult(res, { ok: false, error: 'Tick at least one part to restore.' }); return; }
          if (!confirm('Restore the selected parts now? Current files are kept as .bak copies.')) return;
          btn.disabled = true;
          try {
            const r = await D.post('/backup/restore', { archive, parts: [...chosen], password: pw.value });
            D.showResult(res, { ok: true, ...r }, r.written.length
              ? `Restored ${r.written.join(', ')}.` : 'Nothing needed restoring - everything already matched.');
            try { D.state.tree = await D.api('/tree'); D.renderTree(); } catch {}
          } catch (err) { D.showResult(res, { ok: false, error: err.message, ...(err.data || {}) }); }
          btn.disabled = false;
        } }, 'Restore selected')),
      res);
  }
}
