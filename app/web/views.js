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
  main.append(el('div', { class: 'statgrid' },
    kpi('Overall availability', fmtAvail(s.availability), availClass(s.availability)),
    kpi('Full-outage time', fmtDur(s.downtimeSec), s.downtimeSec ? 'warning' : 'ok', 'summed over all targets'),
    kpi('Incidents', String(s.incidents ?? 0), s.incidents ? 'warning' : 'ok'),
    kpi('Targets', String(s.targets ?? 0)),
    kpi('Perfect', `${s.perfect ?? 0} / ${s.targets ?? 0}`, null, 'no measurable loss'),
  ));

  if ((r.groups || []).length > 1) {
    const rows = r.groups.slice().sort((a, b) => a.availability - b.availability);
    const tbl = el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, ...['Group', 'Targets', 'Availability', 'Full-outage', 'Incidents', 'Weakest target'].map(h => el('th', {}, h)))));
    const tb = el('tbody');
    for (const g of rows) {
      tb.append(el('tr', {},
        el('td', {}, g.title),
        el('td', { class: 'num' }, String(g.targets)),
        el('td', {}, availCell(g.availability)),
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
      el('thead', {}, el('tr', {}, ...['Target', 'Availability', 'Full-outage', 'Loss-minutes', 'Avg loss', 'Avg RTT', 'p95 RTT', 'Worst hour', 'Incidents'].map(h => el('th', {}, h)))));
    const tb = el('tbody');
    for (const t of rows) {
      const wh = t.worstHour;
      tb.append(el('tr', {},
        el('td', {}, el('a', { href: '#/node' + t.path }, t.title),
          t.host ? el('div', { class: 'cell-sub' }, t.host) : null),
        el('td', {}, availCell(t.availability)),
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
    `Loss-minutes is the same loss expressed as minutes of total outage. Incidents come from the persistent alert history.`));
}

function kpi(k, v, cls, hint) {
  return D.el('div', { class: 'stat' + (cls ? ' kpi-' + cls : '') },
    D.el('div', { class: 'k' }, k), D.el('div', { class: 'v' }, v),
    hint ? D.el('div', { class: 'cell-sub' }, hint) : null);
}

function availCell(v) {
  const pct = v == null ? 0 : Math.max(0, Math.min(100, v));
  return D.el('div', { class: 'availbar' },
    D.el('span', { class: 'track' }, D.el('i', { class: availClass(v), style: `width:${pct}%` })),
    D.el('span', { class: 'num' }, fmtAvail(v)));
}

function exportReportCsv(r, range) {
  const rows = r.targets.map(t => [t.path, t.title, t.host, t.availability == null ? '' : t.availability.toFixed(4), t.downtimeSec,
    t.lossMinutes.toFixed(2), t.avgLossPct.toFixed(3), t.avgMs == null ? '' : t.avgMs.toFixed(2), t.p95Ms == null ? '' : t.p95Ms.toFixed(2),
    t.maxMs == null ? '' : t.maxMs.toFixed(2), t.worstHour ? new Date(t.worstHour.t * 1000).toISOString() : '',
    t.worstHour ? t.worstHour.lossPct.toFixed(2) : '', t.incidents, t.longestSec, t.coveragePct.toFixed(1)]);
  D.downloadBlob(D.rowsToCsv(['path', 'title', 'host', 'availability_pct', 'full_outage_sec', 'loss_minutes', 'avg_loss_pct', 'avg_rtt_ms',
    'p95_rtt_ms', 'max_rtt_ms', 'worst_hour', 'worst_hour_loss_pct', 'incidents', 'longest_incident_sec', 'coverage_pct'], rows),
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
        ['target', 'path', 'alert', 'started', 'ended', 'duration_sec', 'ongoing'],
        last.incidents.map(i => [i.title, i.path, i.alert, new Date(i.start * 1000).toISOString(),
          i.end ? new Date(i.end * 1000).toISOString() : '', i.durationSec, i.open ? 'yes' : 'no'])),
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
        el('td', {}, i.alert),
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
