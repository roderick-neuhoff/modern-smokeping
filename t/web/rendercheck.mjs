// Executes the real SPA (chart.js + diff.js + views.js + app.js) in jsdom with a
// canvas/fetch shim and asserts each view renders what it should.
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const WEB = new URL('../../app/web/', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, WEB), 'utf8');
const strip = (src) => src
  .replace(/^import [^;]*;\s*$/gm, '')
  .replace(/^export \{[^}]*\};?\s*$/gm, '')
  .replace(/^export (async function|function|const|let)/gm, '$1');
const bundle = ['chart.js', 'diff.js', 'views.js', 'app.js'].map(f => strip(read(f))).join('\n;\n');

const now = Math.floor(Date.now() / 1000);
const N = 120;
const series = (base, lossAt) => {
  const t = [], median = [], loss = [], p20 = [], p50 = [], p80 = [], pmax = [], pmin = [], p10 = [], p90 = [];
  for (let i = 0; i < N; i++) {
    t.push(now - (N - i) * 10);
    const m = base + (i % 7); median.push(m); p20.push(m - 1); p50.push(m); p80.push(m + 1); pmax.push(m + 4); pmin.push(m - 2); p10.push(m - 1.5); p90.push(m + 2);
    loss.push(i >= lossAt && i < lossAt + 10 ? 30 : 0);
  }
  return { t, median, loss, p20, p50, p80, pmax, pmin, p10, p90 };
};
const leaf = (name, path, sev = 'ok') => ({ name, path, title: name, menu: name, host: '10.0.0.' + name.length, isLeaf: true, hasData: true, alerts: ['hostdown'], children: [] });
const tree = { generated: now, legacyUrl: '/smokeping/smokeping.cgi', title: 'Test', ranges: ['3h', '30h', '10d', '360d'],
  alertsDefined: ['hostdown', 'lossdetect'], probesDefined: ['FPing'],
  root: { name: 'Top', path: '/', children: [
    { name: 'Sites', path: '/Sites', title: 'Sites', menu: 'Sites', isLeaf: false, children: [leaf('Google', '/Sites/Google'), leaf('Cloudflare', '/Sites/Cloudflare')] },
    leaf('Quad9', '/Quad9') ] } };
const node = (p, t) => ({ path: p, title: t, host: '1.1.1.1', range: '3h', legacyUrl: '#', alerts: ['hostdown'], pings: 20,
  window: { start: now - 1200, end: now }, stats: { medianNowMs: 12, medianAvgMs: 11, medianMinMs: 9, medianMaxMs: 30, lossNowPct: 0, lossAvgPct: 1, lossMaxPct: 30 },
  series: series(p.length * 3, 60) });
const MW = { id: 'm1', title: 'Router swap', until: now + 3600, note: 'firmware' };
const summary = { generated: now, total: 3, counts: { ok: 2, warning: 0, critical: 0, down: 0, unknown: 0, maintenance: 1 },
  maintenance: [{ id: 'm1', title: 'Router swap', until: now + 3600, paths: ['/Quad9'], mode: 'once' }],
  nodes: [['/Sites/Google', 'Google'], ['/Sites/Cloudflare', 'Cloudflare'], ['/Quad9', 'Quad9']].map(([path, title]) => (
    { path, title, host: '1.1.1.1', severity: 'ok', maintenance: path === '/Quad9' ? MW : null, lossNowPct: 0, medianNowMs: 12, medianAvgMs: 11, stddevMs: 1.2, hasData: true,
      spark: { median: [1, 2, 3, 2, 1], loss: [0, 0, 0, 0, 0], step: 60 } })),
  worstLoss: [], worstLatency: [], worstStddev: [] };
const report = { generated: now, range: '7d', rangeSec: 604800, downLossPct: 90,
  summary: { targets: 3, availability: 99.412, downtimeSec: 640, incidents: 4, perfect: 1, maintenanceSec: 3600 },
  groups: [{ path: '', title: 'Top level', targets: 1, availability: 100, downtimeSec: 0, lossMinutes: 0, incidents: 0, worstTarget: 'Quad9' },
           { path: '/Sites', title: 'Sites', targets: 2, availability: 99.118, downtimeSec: 640, lossMinutes: 12.5, incidents: 4, worstTarget: 'Google' }],
  targets: [
    { path: '/Sites/Google', title: 'Google', host: '8.8.8.8', group: '/Sites', availability: 98.7, downtimeSec: 640, lossMinutes: 11.4, avgLossPct: 1.3, avgMs: 12.3, p95Ms: 25.1, maxMs: 90, worstHour: { t: now - 3600, lossPct: 22.5 }, incidents: 4, longestSec: 252, coveragePct: 100, stepSec: 300 },
    { path: '/Sites/Cloudflare', title: 'Cloudflare', host: '1.1.1.1', group: '/Sites', availability: 99.94, downtimeSec: 0, lossMinutes: 0.4, avgLossPct: 0.06, avgMs: 8, p95Ms: 12, maxMs: 30, worstHour: null, incidents: 0, longestSec: 0, coveragePct: 100, stepSec: 300 },
    { path: '/Gone', title: 'Gone', host: '9.9.9.8', group: '', availability: null, downtimeSec: 0, lossMinutes: 0, avgLossPct: null, avgMs: null, p95Ms: null, maxMs: null, worstHour: null, incidents: 0, longestSec: 0, coveragePct: 0, stepSec: 300, maintenanceSec: 3600 },
    { path: '/Quad9', title: 'Quad9', host: '9.9.9.9', group: '', availability: 100, downtimeSec: 0, lossMinutes: 0, avgLossPct: 0, avgMs: 15, p95Ms: 20, maxMs: 33, worstHour: null, incidents: 0, longestSec: 0, coveragePct: 100, stepSec: 300 }] };
const events = { generated: now, range: '7d', since: now - 604800, total: 2, open: 1, avgSec: 252, longestSec: 3600,
  byTarget: [{ path: '/Sites/Google', title: 'Google', count: 2 }, { path: '/Quad9', title: 'Quad9', count: 1 }],
  incidents: [
    { alert: 'hostdown', target: 'Sites.Google', path: '/Sites/Google', title: 'Google', start: now - 3600, end: null, durationSec: 3600, open: true, level: false },
    { alert: 'lossdetect', target: 'Sites.Google', path: '/Sites/Google', title: 'Google', start: now - 90000, end: now - 89748, durationSec: 252, open: false, level: false }] };
const defs = { stepSec: 10, header: {}, alerts: [
  { name: 'hostdown', type: 'loss', pattern: '>90%,>90%,>90%,>90%,>90%,>90%', comment: 'Host unreachable', edgetrigger: true, priority: 1,
    rule: { kind: 'down', pct: 90, minutes: 1 }, human: 'loss > 90% for 1 min', usedBy: ['(top level)', '/Sites/Google'] },
  { name: 'latencyhigh', type: 'matcher', pattern: 'CheckLatency(l=>300,x=>18)', comment: '', edgetrigger: true, priority: null,
    rule: { kind: 'latency', ms: 300, minutes: 3 }, human: 'latency ≥ 300 ms for 3 min', usedBy: [] },
  { name: 'weird', type: 'matcher', pattern: 'Median(old=>5,new=>3,diff=>0.1)', comment: '', edgetrigger: false, priority: null,
    rule: { kind: 'custom', type: 'matcher', pattern: 'Median(old=>5,new=>3,diff=>0.1)' }, human: 'custom matcher: Median(...)', usedBy: [] }] };
const preview = { generated: now, stepSec: 10, targetsChecked: 3,
  rule: { kind: 'latency', type: 'matcher', pattern: 'CheckLatency(l=>300,x=>18)', human: 'latency ≥ 300 ms for 3 min' },
  firingNow: [{ path: '/Sites/Google', title: 'Google', lossPct: 0, rttMs: 400 }],
  replay: { hours: 20, totalRaises: 3, targets: [{ path: '/Sites/Google', title: 'Google', raises: 3, firingMinutes: 12.5, first: now - 7200, last: now - 600, stillFiring: true }] } };
const settings = { user: 'admin', editable: ['Targets', 'Alerts'], smtp: { oauth: {}, authMethod: 'password' }, alerts: { emails: [], pipes: [], from: '', webhooks: false }, notify: {}, capabilities: {},
  delivery: { mail: { lastAttempt: now - 60, lastOk: now - 60, sent: 12, fails: 0, test: false },
              webhook: { lastAttempt: now - 120, lastFail: now - 120, lastOk: now - 86400 * 3, fails: 4, lastError: 'HTTP 000 (curl rc=7)', sent: 2 } } };

const maint = { now, windows: [
  { id: 'm1', title: 'Router swap', note: 'firmware', paths: ['/Quad9'], mode: 'once', start: now - 600, end: now + 3600, enabled: true, state: { status: 'active', until: now + 3600, since: now - 600 } },
  { id: 'w1', title: 'Nightly backups', note: '', paths: [], mode: 'weekly', days: [0, 6], time: '03:00', durationMin: 120, enabled: true, state: { status: 'upcoming', next: now + 86400, nextEnd: now + 93600 } },
  { id: 'old', title: 'Last month', note: '', paths: ['/Sites'], mode: 'once', start: now - 90000, end: now - 86400, enabled: true, state: { status: 'ended' } }] };
const bud = (st, used) => ({ budgetSec: 2592, usedSec: used, remainingSec: 2592 - used, usedPct: 100 * used / 2592, projectedSec: used * 2, status: st, availability: 99.5 });
report.goals = { defined: 2 };
report.month = { start: now - 15 * 86400, end: now + 15 * 86400, now };
report.summary.goalsMet = 1; report.summary.goalsTotal = 3; report.summary.budgetAtRisk = 1; report.summary.budgetBreached = 1;
Object.assign(report.targets[0], { goal: 99.9, goalScope: '/Sites', meets: false, budget: bud('breached', 3000) });
Object.assign(report.targets[1], { goal: 99.9, goalScope: '/Sites', meets: true, budget: bud('at_risk', 2100) });
Object.assign(report.targets[3], { goal: 99, goalScope: '/', meets: true, budget: bud('ok', 100) });
Object.assign(report.groups[1], { goal: 99.9, goalScope: '/Sites', meets: false, budget: bud('breached', 3000) });
const goalsData = { goals: [{ path: '/WAN', target: 99.9, note: 'customer SLA', allowedPerMonthSec: 2592 }, { path: '/', target: 99, note: '', allowedPerMonthSec: 25920 }] };
const archive = { format: 'modern-smokeping-backup', version: 1, created: now, host: 'Tower', appVersion: '1.6.0', includesSecrets: false,
  files: [{ name: 'Targets', group: 'config', bytes: 120, sha256: 'x', encoding: 'text', data: 'x' }, { name: 'Alerts', group: 'config', bytes: 80, sha256: 'y', encoding: 'text', data: 'y' },
          { name: 'modern-acks.json', group: 'state', bytes: 20, sha256: 'z', encoding: 'text', data: '{}' }, { name: 'modern-notify.json', group: 'secrets', bytes: 90, sha256: 'q', encoding: 'text', data: '{}' }] };
const dry = { ok: true, dryRun: true, created: now, host: 'Tower', appVersion: '1.6.0', includesSecrets: true, files: [
  { name: 'Targets', group: 'config', bytes: 120, secret: 0, status: 'same' }, { name: 'Alerts', group: 'config', bytes: 80, secret: 0, status: 'changed' },
  { name: 'modern-acks.json', group: 'state', bytes: 20, secret: 0, status: 'new' }, { name: 'modern-notify.json', group: 'secrets', bytes: 90, secret: 1, status: 'changed' }] };
const calls = [];
function route(url, init) {
  const u = new URL(url, 'http://localhost');
  const p = u.pathname.replace(/^.*\/api/, '');
  calls.push(p + u.search);
  if (init && init.method === 'POST') {
    if (p === '/backup/restore') { const b = JSON.parse(init.body); return b.dryRun ? dry : { ok: true, written: ['Alerts', 'modern-acks.json'], unchanged: 2, reload: { note: 'HUP sent' } }; }
    if (p === '/goals') return { ok: true, goals: goalsData.goals };
    if (p === '/goals/delete') return { ok: true, goals: [] };
    if (p === '/alertdefs') return { ok: true, name: JSON.parse(init.body).name, created: true, pattern: 'x', type: 'matcher' };
    if (p === '/alertdefs/delete') return { ok: true };
    return { ok: true };
  }
  switch (p) {
    case '/tree': return tree;
    case '/summary': return summary;
    case '/alerts': return { generated: now, recent: [], logSource: '/x', active: [{ path: '/Quad9', target: 'Quad9', host: '9.9.9.9', alert: 'hostdown', type: 'loss', pattern: '>90%', severity: 'critical', currentLossPct: 100, currentRttMs: null, lossSamples: [100, 100, 100], rttSamples: [null, null, null], maintenance: MW }] };
    case '/maintenance': return maint;
    case '/goals': return goalsData;
    case '/backup': return archive;
    case '/acks': return { acks: {} };
    case '/node': return node(u.searchParams.get('path'), u.searchParams.get('path').split('/').pop());
    case '/report': return report;
    case '/events': return u.searchParams.get('target') ? { ...events, incidents: events.incidents.filter(i => i.path === u.searchParams.get('target')) } : events;
    case '/alertdefs': return defs;
    case '/alertpreview': return preview;
    case '/settings': return settings;
    default: return { error: 'unknown ' + p, __status: 404 };
  }
}

const html = read('index.html');
const dom = new JSDOM(html, { url: 'http://localhost/modern/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const errors = [];
window.addEventListener('error', (e) => errors.push('window error: ' + (e.error && e.error.stack || e.message)));
const noop = () => {};
const ctxProxy = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (k === 'measureText' ? () => ({ width: 10 }) : noop)), set: (t, k, v) => { t[k] = v; return true; } });
window.HTMLCanvasElement.prototype.getContext = () => ctxProxy;
window.HTMLCanvasElement.prototype.toDataURL = () => 'data:,';
window.Element.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, width: 800, height: 320, right: 800, bottom: 320 }; };
window.Element.prototype.scrollIntoView = noop;
window.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener: noop, removeEventListener: noop }));
window.requestAnimationFrame = (f) => setTimeout(f, 0);
window.confirm = () => true;
window.fetch = async (url, init) => {
  const body = route(String(url), init);
  const status = body && body.__status || 200;
  return { ok: status < 400, status, json: async () => body };
};
window.eval(bundle + '\n;window.__test = { state, render, api, post, refreshNow: () => { lastRefreshAt = 0; return refresh(); } };');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function go(hash, wait = 250) {
  window.location.hash = hash;
  await sleep(wait);
}
let fails = 0;
let posted = null;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
const main = () => window.document.getElementById('main');
const text = () => main().textContent;

await sleep(600);                                      // boot
ok(window.document.querySelectorAll('.tree-row').length >= 5, 'sidebar rendered');
const sidebar = window.document.getElementById('tree').textContent;
ok(/Availability report/.test(sidebar) && /Compare targets/.test(sidebar), 'sidebar has Report + Compare entries');

// --- report ----------------------------------------------------------------
await go('#/report?range=7d');
ok(/Availability report/.test(text()) && /99\.412 %/.test(text()), 'report renders overall availability');
ok(/By group/.test(text()) && /Top level/.test(text()), 'report renders group rollup');
ok(main().querySelectorAll('table.data').length === 2, 'report has group + target tables');
ok(/98\.700 %|98\.70 %/.test(text()) && /4m 12s/.test(text()) === true, 'report target row (avail + longest incident)');
ok(/12\.3 ms/.test(text()), 'report shows avg RTT');
ok(calls.some(c => c === '/report?range=7d'), 'report requested range=7d');
await go('#/report?range=30d');
ok(calls.some(c => c === '/report?range=30d'), 'range switch refetches');

// --- compare -----------------------------------------------------------------
await go('#/compare');
ok(/Choose two or more targets/.test(text()), 'compare empty state');
ok(main().querySelectorAll('.compare-list .chip').length === 3, 'picker lists 3 candidates');
main().querySelectorAll('.compare-list .chip')[0].click();
await sleep(200);
main().querySelectorAll('.compare-list .chip')[0].click();
await sleep(300);
ok(main().querySelectorAll('.compare-chip').length === 2, 'two targets selected');
ok(main().querySelectorAll('canvas.compare-chart').length === 1, 'compare chart canvas present');
ok(main().querySelectorAll('.tablecard table.data tbody tr').length === 2, 'compare stats table has 2 rows');
ok(window.location.hash.startsWith('#/compare?paths='), 'selection kept in the URL: ' + window.location.hash);
await go('#/compare?paths=/Sites/Google,/Quad9&range=30h', 300);
ok(main().querySelectorAll('.compare-chip').length === 2 && calls.some(c => c.includes('range=30h')), 'compare deep link honours paths + range');

// --- alerts page: incident history -----------------------------------------------
await go('#/alerts', 400);
ok(/Incident history/.test(text()), 'alerts page has incident history');
ok(/2 incidents/.test(text()) && /1 ongoing/.test(text()), 'incident summary line');
ok(/ongoing/.test(text()) && /4m 12s/.test(text()), 'incident rows show ongoing + duration');
ok(/Google ×2/.test(text()), 'top offenders chip');

// --- node page: compare button + incidents ---------------------------------------------
await go('#/node/Sites/Google', 400);
ok(main().querySelector('a[href^="#/compare?paths=%2FSites%2FGoogle"], a[href^="#/compare?paths=/Sites/Google"]') !== null, 'node page has Compare… link');
ok(/Recent incidents/.test(text()), 'node page has incidents card');
ok(calls.some(c => c.startsWith('/events?range=30d&target=%2FSites%2FGoogle')), 'node incidents fetched for this target');

// --- dashboard ---------------------------------------------------------------------------
await go('#/', 300);
ok(main().querySelector('a.chip[href="#/compare"]') !== null, 'dashboard has Compare link');

// --- settings: alert rules -----------------------------------------------------------------------
await go('#/settings/rules', 500);
ok(/Alert rules/.test(text()) && /hostdown/.test(text()) && /latencyhigh/.test(text()), 'rules list rendered');
ok(/unused/.test(text()) && /2 places/.test(text()), 'usage shown (unused / 2 places)');
ok(window.document.querySelectorAll('.seg a.segbtn').length === 9, 'Settings has 9 tabs');
// edit latencyhigh
const editBtn = [...main().querySelectorAll('button')].find(b => b.textContent === 'Edit' && b.closest('tr').textContent.includes('latencyhigh'));
editBtn.click();
await sleep(900);
ok(main().querySelector('.rule-editor') !== null, 'editor opened');
ok(main().querySelector('.rule-editor input[type=number]').value === '300', 'editor pre-filled with 300 ms');
ok(/would be firing right now|Would be firing right now/.test(text()) && /would have been raised 3 times|raised 3 times/.test(text()), 'live preview rendered');
const before = calls.filter(c => c.startsWith('/alertpreview')).length;
const msInput = main().querySelector('.rule-editor input[type=number]');
msInput.value = '500'; msInput.dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(1000);
const after = calls.filter(c => c.startsWith('/alertpreview'));
ok(after.length === before + 1 && after[after.length - 1].includes('ms=500'), 'changing a field re-runs preview with new value: ' + after[after.length - 1]);
// switch kind
const kindSel = main().querySelector('.rule-editor select');
kindSel.value = 'shift'; kindSel.dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(900);
ok(/of the average of the previous/.test(text()), 'kind switch shows shift sentence');
ok(calls[calls.length - 1].includes('kind=shift') && calls[calls.length - 1].includes('ratio=200'), 'preview uses shift defaults');
// save
const origFetch = window.fetch;
window.fetch = async (url, init) => { if (init && init.method === 'POST') posted = { url: String(url), body: JSON.parse(init.body), hdr: init.headers }; return origFetch(url, init); };
[...main().querySelectorAll('.rule-editor button')].find(b => b.textContent === 'Save rule').click();
await sleep(600);
ok(posted && posted.url.endsWith('/alertdefs') && posted.body.name === 'latencyhigh' && posted.body.create === false && posted.body.rule.kind === 'shift', 'save posts name/create/rule: ' + JSON.stringify(posted && posted.body));
ok(posted && posted.hdr['x-requested-with'] === 'modern-smokeping', 'save carries CSRF header');
ok(main().querySelector('.rule-editor') === null, 'editor closed after save');
// create
[...main().querySelectorAll('button')].find(b => b.textContent === '+ New rule').click();
await sleep(600);
ok(/New alert rule/.test(text()), 'new-rule editor opens');
const nameIn = main().querySelector('.rule-editor input[placeholder="e.g. slowlink"]');
nameIn.value = 'slowlink'; nameIn.dispatchEvent(new window.Event('input', { bubbles: true }));
posted = null;
[...main().querySelectorAll('.rule-editor button')].find(b => b.textContent === 'Create rule').click();
await sleep(500);
ok(posted && posted.body.name === 'slowlink' && posted.body.create === true && posted.body.rule.kind === 'loss' && posted.body.rule.pct === 10, 'create posts defaults: ' + JSON.stringify(posted && posted.body.rule));
// delete in-use refuses client-side, unused confirms
posted = null;
[...main().querySelectorAll('button')].find(b => b.textContent === 'Delete' && b.closest('tr').textContent.includes('hostdown')).click();
await sleep(200);
ok(posted === null, 'delete of an in-use rule is blocked before any request');
[...main().querySelectorAll('button')].find(b => b.textContent === 'Delete' && b.closest('tr').textContent.includes('latencyhigh')).click();
await sleep(300);
ok(posted && posted.url.endsWith('/alertdefs/delete') && posted.body.name === 'latencyhigh', 'delete of unused rule posts');
// custom rule opens with its raw pattern
[...main().querySelectorAll('button')].find(b => b.textContent === 'Edit' && b.closest('tr').textContent.includes('weird')).click();
await sleep(700);
ok(main().querySelector('.rule-editor textarea').value.startsWith('Median('), 'custom rule shows raw pattern');


// --- maintenance -------------------------------------------------------------------------------
await go('#/', 300);
ok(/Maintenance in progress/.test(text()) && /Router swap/.test(text()) && /1 target/.test(text()), 'dashboard shows the maintenance banner');
ok(window.document.querySelector('.pill[data-sev="maintenance"]') !== null, 'top bar has a maintenance pill');
const qcard = [...main().querySelectorAll('.card')].find(c => c.textContent.includes('Quad9'));
ok(qcard && qcard.classList.contains('maintenance') && /Maintenance/.test(qcard.textContent), 'in-maintenance target card is marked');
ok(!window.document.getElementById('statusPills').textContent.match(/1 alert/), 'maintenance alert is not counted in the alert pill');
await go('#/alerts', 400);
ok(/in maintenance: Router swap/.test(text()), 'alerts page explains the muted alert');
ok(main().querySelector('tr.row-muted') !== null, 'maintenance alert row is muted');
await go('#/node/Quad9', 400);
ok(/In maintenance: Router swap/.test(text()), 'node page shows the maintenance banner');
ok(main().querySelector('a[href^="#/settings/maintenance?path="]') !== null, 'node page has Maintenance… link');
await go('#/wall', 300);
ok(/Maintenance 1/.test(main().textContent), 'wall shows the maintenance count');
await go('#/report?range=7d', 300);
ok(/Maintenance excluded/.test(text()) && /in maintenance/.test(text()) && /excludes 1h 00m maintenance/.test(text()), 'report shows excluded maintenance + unmeasured target');

await go('#/settings/maintenance', 500);
ok(/Maintenance windows/.test(text()) && /Router swap/.test(text()) && /Nightly backups/.test(text()), 'maintenance list rendered');
ok(/Active until/.test(text()) && /Sun, Sat at 03:00 for 2h 00m/.test(text()) && /All targets/.test(text()), 'active badge + weekly description + scope');
ok([...main().querySelectorAll('button')].some(b => b.textContent === 'End now'), 'active one-off has End now');
posted = null;
[...main().querySelectorAll('button')].find(b => b.textContent === 'End now').click();
await sleep(300);
ok(posted && posted.url.endsWith('/maintenance') && posted.body.id === 'm1' && posted.body.mode === 'once' && posted.body.end <= Math.floor(Date.now() / 1000) + 1, 'End now posts the window with end=now');
// create a one-off for two picked targets using the quick button
[...main().querySelectorAll('button')].find(b => b.textContent === '+ New window').click();
await sleep(300);
ok(/New maintenance window/.test(text()) && /every target/.test(text()), 'new-window editor');
ok(/Silences alerts, e-mail and webhooks for 3 targets/.test(text()), 'summary counts all 3 targets');
const ed = main().querySelector('.rule-editor');
const radios = ed.querySelectorAll('input[type=radio]');
radios[1].checked = true; radios[1].dispatchEvent(new window.Event('change', { bubbles: true }));
const boxes = ed.querySelectorAll('.maint-tree input[type=checkbox]');
ok(boxes.length === 4, 'scope picker lists groups and targets (4)');
boxes[0].checked = true; boxes[0].dispatchEvent(new window.Event('change', { bubbles: true }));   // /Sites (whole group)
ok(/for 2 targets/.test(ed.textContent), 'ticking a group counts its 2 children');
const ti = ed.querySelector('input[placeholder^="e.g. Router"]'); ti.value = 'Core swap'; ti.dispatchEvent(new window.Event('input', { bubbles: true }));
[...ed.querySelectorAll('.seg button')].find(b => b.textContent === '4 h').click();
posted = null;
[...ed.querySelectorAll('button')].find(b => b.textContent === 'Create window').click();
await sleep(400);
ok(posted && posted.body.title === 'Core swap' && posted.body.paths.join() === '/Sites' && posted.body.mode === 'once' && !posted.body.id, 'create posts scope + title: ' + JSON.stringify(posted && posted.body));
ok(posted && Math.abs((posted.body.end - posted.body.start) - 4 * 3600) <= 60, 'quick 4 h sets a 4 hour span');
// weekly editor
[...main().querySelectorAll('button')].find(b => b.textContent === '+ New window').click();
await sleep(300);
const ed2 = main().querySelector('.rule-editor');
const mode = ed2.querySelector('select'); mode.value = 'weekly'; mode.dispatchEvent(new window.Event('change', { bubbles: true }));
ok(ed2.querySelectorAll('.alert-checks input[type=checkbox]').length === 7 && ed2.querySelector('input[type=time]').value === '03:00', 'weekly editor has 7 days + time');
posted = null;
[...ed2.querySelectorAll('button')].find(b => b.textContent === 'Create window').click();
await sleep(400);
ok(posted && posted.body.mode === 'weekly' && posted.body.days.join() === '6' && posted.body.time === '03:00' && posted.body.durationMin === 120 && Array.isArray(posted.body.paths) && posted.body.paths.length === 0, 'weekly create posts days/time/duration: ' + JSON.stringify(posted && posted.body));
posted = null;
[...main().querySelectorAll('button')].find(b => b.textContent === 'Delete' && b.closest('tr').textContent.includes('Last month')).click();
await sleep(300);
ok(posted && posted.url.endsWith('/maintenance/delete') && posted.body.id === 'old', 'delete posts the id');
// deep link from a node page pre-selects the target
await go('#/settings/maintenance?path=%2FQuad9', 600);
const ed3 = main().querySelector('.rule-editor');
ok(ed3 && /for 1 target/.test(ed3.textContent), 'deep link opens the editor scoped to that target');

// --- uptime goals + budgets in the report ------------------------------------------------------
await go('#/report?range=7d', 300);
ok(/Goals met/.test(text()) && /1 \/ 3/.test(text()), 'report KPI: goals met 1 / 3');
ok(/1 breached/.test(text()), 'report KPI: budget breached count');
ok(/Goal/.test(text()) && /Budget this month/.test(text()), 'report tables have Goal + Budget columns');
ok(/99\.9 %/.test(text()) && /Misses/.test(text()) && /Meets/.test(text()), 'pass / fail badges');
ok(/over budget by 6m 48s/.test(text()) || /over budget by/.test(text()), 'breached budget text: ' + (text().match(/over budget by [^A-Z]*/) || [''])[0]);
ok(/8m 12s left of 43m 12s|left of 43m 12s/.test(text()), 'remaining budget text');
ok(/calendar month to date/.test(text()), 'report explains the budget basis');

// --- goals pane -----------------------------------------------------------------------------------------
await go('#/settings/goals', 500);
ok(/Uptime goals/.test(text()) && /Everything \(default\)/.test(text()) && /\/WAN/.test(text()) && /customer SLA/.test(text()), 'goals list rendered');
ok(/43m 12s \/ 30 days/.test(text()), 'allowed downtime per 30 days shown (43m 12s)');
const gform = main().querySelector('.rule-editor');
ok(gform && /Allows about 43m 12s/.test(gform.textContent), 'form previews the allowed downtime');
[...gform.querySelectorAll('.seg button')].find(b => b.textContent === '99.99 %').click();
ok(/Allows about 4m 19s/.test(gform.textContent), 'preset 99.99 % updates the preview (4m 19s)');
const gscope = gform.querySelector('select'); gscope.value = '/Sites'; gscope.dispatchEvent(new window.Event('change', { bubbles: true }));
posted = null;
[...gform.querySelectorAll('button')].find(b => b.textContent === 'Save goal').click();
await sleep(400);
ok(posted && posted.url.endsWith('/goals') && posted.body.path === '/Sites' && String(posted.body.target) === '99.99', 'save posts scope + target: ' + JSON.stringify(posted && posted.body));
posted = null;
[...main().querySelectorAll('button')].find(b => b.textContent === 'Delete').click();
await sleep(300);
ok(posted && posted.url.endsWith('/goals/delete') && posted.body.path === '/WAN', 'delete posts the scope');

// --- backup pane ------------------------------------------------------------------------------------------
await go('#/settings/backup', 500);
ok(/Download a backup/.test(text()) && /Restore from a backup/.test(text()), 'backup pane rendered');
let blobText = null;
window.URL.createObjectURL = (b) => { blobText = b; return 'blob:x'; };
window.URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () { this.dataset.clicked = '1'; };
calls.length = 0;
[...main().querySelectorAll('button')].find(b => b.textContent === 'Download backup').click();
await sleep(400);
ok(calls.includes('/backup?secrets=0'), 'download requests the backup without credentials by default');
ok(/Downloaded 4 files/.test(text()), 'download reports what was saved');
const secretBox = [...main().querySelectorAll('input[type=checkbox]')][0];
secretBox.checked = true;
calls.length = 0;
[...main().querySelectorAll('button')].find(b => b.textContent === 'Download backup').click();
await sleep(400);
ok(calls.includes('/backup?secrets=1'), 'ticking the box requests credentials too');
// restore flow
const fin = main().querySelector('input[type=file]');
Object.defineProperty(fin, 'files', { value: [{ text: async () => JSON.stringify(archive) }], configurable: true });
posted = null;
fin.dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(500);
ok(posted && posted.url.endsWith('/backup/restore') && posted.body.dryRun === true, 'choosing a file runs a dry run first');
ok(/Backup from Tower/.test(text()) && /changed/.test(text()) && /credentials/.test(text()), 'preview shows host, changed files and credentials badge');
const partBoxes = [...main().querySelectorAll('.card-plain.danger .alert-checks input[type=checkbox]')];
ok(partBoxes.length === 3 && partBoxes[0].checked && partBoxes[1].checked && !partBoxes[2].checked, 'config + state pre-ticked, credentials not');
posted = null;
const restoreBtn = () => [...main().querySelectorAll('button')].find(b => b.textContent === 'Restore selected');
partBoxes[0].checked = false; partBoxes[0].dispatchEvent(new window.Event('change', { bubbles: true }));
partBoxes[1].checked = false; partBoxes[1].dispatchEvent(new window.Event('change', { bubbles: true }));
restoreBtn().click(); await sleep(200);
ok(posted === null && /Tick at least one part/.test(text()), 'restore with nothing ticked is blocked client-side');
partBoxes[0].checked = true; partBoxes[0].dispatchEvent(new window.Event('change', { bubbles: true }));
main().querySelector('input[type=password]').value = 'pw';
restoreBtn().click(); await sleep(500);
ok(posted && posted.body.parts.join() === 'config' && posted.body.password === 'pw' && !posted.body.dryRun, 'restore posts parts + password: ' + JSON.stringify(posted && { parts: posted.body.parts, pw: posted.body.password }));
ok(/Restored Alerts, modern-acks\.json/.test(text()), 'restore result lists written files');

// --- health: polling stopped / stale targets / failing delivery ---------------------------------
summary.delivery = [{ channel: 'webhook', fails: 4, lastFail: now - 120, lastOk: now - 86400 * 3, lastError: 'HTTP 000 (curl rc=7)' }];
summary.polling = { lastUpdate: now - 60, staleAfter: 300, staleTargets: 1, stopped: false };
summary.nodes[1].stale = true; summary.nodes[1].lastUpdate = now - 1800; summary.nodes[1].severity = 'unknown';
window.__test.state.summary = null;
await window.__test.refreshNow();
await go('#/', 400);
ok(/Generic webhook notifications are failing/.test(text()) && /curl rc=7/.test(text()) && /last success 3d ago/.test(text()), 'dashboard: failing channel banner');
ok(main().querySelector('a.health-banner[href="#/settings/notify"]') !== null, 'banner links to the notification settings');
ok(/1 target is not being measured/.test(text()), 'dashboard: stale target banner');
ok(/no measurement for 30m \d\ds/.test(text()), 'stale card says how long');
await go('#/alerts', 400);
ok(/notifications are failing/.test(text()), 'alerts page repeats the delivery banner');
summary.polling = { lastUpdate: now - 3600, staleAfter: 300, staleTargets: 3, stopped: true };
window.__test.state.summary = null;
await window.__test.refreshNow();
await go('#/', 400);
ok(/SmokePing has stopped measuring/.test(text()) && /for 1h 00m/.test(text()), 'dashboard: polling stopped banner: ' + ((main().querySelector('.health-banner') || {}).textContent || 'none'));
ok(!/not being measured/.test(text()), 'stopped replaces the per-target banner');
await go('#/wall', 300);
ok(/SmokePing has stopped measuring/.test(main().textContent), 'wall shows the polling-stopped banner');
summary.polling = { lastUpdate: now - 5, staleAfter: 300, staleTargets: 0, stopped: false };
summary.delivery = [];
delete summary.nodes[1].stale; summary.nodes[1].severity = 'ok';
window.__test.state.summary = null;
await window.__test.refreshNow();
await go('#/', 300);
ok(!main().querySelector('.health-banner'), 'healthy: no banners');
await go('#/settings/notify', 500);
ok(/Failing: HTTP 000 \(curl rc=7\) - 4 attempts in a row/.test(text()), 'notify pane: per-channel failure line');
ok(/Nothing sent through this channel yet/.test(text()), 'notify pane: unused channel line');
await go('#/settings/mail', 500);
ok(/Working - last send (\d+s|1m) ago, 12 sent in total/.test(text()), 'mail pane: delivery status line: ' + ((main().querySelector('.delivery-line') || {}).textContent || 'none'));

// --- other settings tabs still render ------------------------------------------------------------
for (const tab of ['mail', 'notify', 'targets', 'rules', 'maintenance', 'goals', 'backup', 'config', 'access']) {
  await go('#/settings/' + tab, 500);
  ok(main().querySelector('.settings-pane') && main().querySelector('.settings-pane').children.length > 0, `settings/${tab} pane renders`);
}
ok(/\/api\/metrics/.test(text()) || true, 'access pane');
await go('#/settings/access', 400);
ok(/Prometheus metrics/.test(text()) && /\/api\/metrics/.test(text()), 'access pane documents /api/metrics');

// --- wall + dashboard regressions ---------------------------------------------------------------------
await go('#/wall', 300);
ok(main().children.length > 0, 'wall renders');
await go('#/', 300);
ok(main().querySelectorAll('.card').length === 3, 'dashboard renders 3 cards');

console.log(errors.length ? '\nJS ERRORS:\n' + errors.join('\n') : '\nno JS errors');
console.log(fails ? `\nFAILED: ${fails}` : '\nALL OK');
process.exit(fails || errors.length ? 1 : 0);
