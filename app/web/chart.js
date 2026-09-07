// Canvas renderers for the SmokePing "smoke" graph and small sparklines.
// No external dependencies - all drawing is hand-rolled so the percentile
// bands look like classic SmokePing but stay crisp on HiDPI and both themes.

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function setupHiDPI(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: rect.width, h: rect.height };
}

function niceMax(v) {
  if (!isFinite(v) || v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

function fmtMs(v) {
  if (v == null || !isFinite(v)) return '–';
  if (v < 1) return (v * 1000).toFixed(0) + ' µs';
  if (v < 10) return v.toFixed(2) + ' ms';
  if (v < 100) return v.toFixed(1) + ' ms';
  if (v < 1000) return v.toFixed(0) + ' ms';
  return (v / 1000).toFixed(2) + ' s';
}

function fmtTimeAxis(ts, spanSec) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  if (spanSec <= 36 * 3600) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (spanSec <= 14 * 86400) return `${d.getDate()}/${d.getMonth() + 1} ${p(d.getHours())}h`;
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

// --- main smoke chart --------------------------------------------------

export function drawSmoke(canvas, series, opts = {}) {
  const { ctx, w, h } = setupHiDPI(canvas);
  ctx.clearRect(0, 0, w, h);
  const pad = { l: 54, r: 12, t: 10, b: 24 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const { t, median, loss, p20, p50, p80, pmax } = series;
  if (!t || t.length < 2) {
    ctx.fillStyle = css('--text-faint');
    ctx.font = `13px ${css('--sans') || 'sans-serif'}`;
    ctx.textAlign = 'center';
    ctx.fillText('No data in this range yet', w / 2, h / 2);
    return null;
  }

  const t0 = t[0], t1 = t[t.length - 1];
  const spanSec = t1 - t0;
  let ymax = 0;
  for (const v of pmax) if (v != null && v > ymax) ymax = v;
  for (const v of median) if (v != null && v > ymax) ymax = v;
  ymax = niceMax(ymax * 1.1) || 1;

  const X = (ts) => pad.l + ((ts - t0) / (spanSec || 1)) * plotW;
  const Y = (v) => pad.t + plotH - (v / ymax) * plotH;

  // grid + y labels
  ctx.strokeStyle = css('--grid');
  ctx.fillStyle = css('--text-faint');
  ctx.font = `11px ${css('--mono') || 'monospace'}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  const rows = 4;
  for (let i = 0; i <= rows; i++) {
    const v = (ymax / rows) * i;
    const y = Y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(fmtMs(v), pad.l - 8, y);
  }
  // x labels
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const ticks = Math.min(6, Math.floor(plotW / 90));
  for (let i = 0; i <= ticks; i++) {
    const ts = t0 + (spanSec / ticks) * i;
    const x = X(ts);
    ctx.strokeStyle = css('--grid');
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + plotH); ctx.stroke();
    ctx.fillStyle = css('--text-faint');
    ctx.fillText(fmtTimeAxis(ts, spanSec), x, pad.t + plotH + 6);
  }

  const band = (lo, hi, color) => {
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < t.length; i++) {
      if (hi[i] == null) { started = false; continue; }
      const x = X(t[i]);
      if (!started) { ctx.moveTo(x, Y(hi[i])); started = true; }
      else ctx.lineTo(x, Y(hi[i]));
    }
    for (let i = t.length - 1; i >= 0; i--) {
      if (lo[i] == null) continue;
      ctx.lineTo(X(t[i]), Y(lo[i]));
    }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  band(p20, pmax, css('--smoke-outer'));
  band(p20, p80, css('--smoke-inner'));

  // median line, coloured by packet loss per segment (classic SmokePing look)
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  let prev = null;
  for (let i = 0; i < t.length; i++) {
    if (median[i] == null) { prev = null; continue; }
    const x = X(t[i]), y = Y(median[i]);
    if (prev) {
      ctx.strokeStyle = lossColor(loss[i]);
      ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(x, y); ctx.stroke();
    }
    prev = { x, y };
  }
  // isolated single points (gaps either side) still need a mark
  for (let i = 0; i < t.length; i++) {
    if (median[i] == null) continue;
    const alone = (i === 0 || median[i - 1] == null) && (i === t.length - 1 || median[i + 1] == null);
    if (!alone) continue;
    ctx.fillStyle = lossColor(loss[i]);
    ctx.beginPath(); ctx.arc(X(t[i]), Y(median[i]), 2, 0, Math.PI * 2); ctx.fill();
  }

  // loss ribbon along the x axis: solid colour where loss > 0
  const slotW = Math.max(1, plotW / Math.max(1, t.length - 1));
  const ribbonH = 6;
  const ribbonY = pad.t + plotH - ribbonH;
  for (let i = 0; i < t.length; i++) {
    const lp = loss[i];
    if (lp == null || lp <= 0) continue;
    ctx.fillStyle = lossColor(lp);
    ctx.fillRect(X(t[i]) - slotW / 2, ribbonY, slotW + 0.5, ribbonH);
  }

  return { X, Y, t0, t1, spanSec, ymax, pad, plotW, plotH, series };
}

// loss (%) -> colour ramp. 0 = ok green, then amber, orange, red, purple.
export function lossColor(pct) {
  if (pct == null || pct <= 0) return css('--loss-0') || '#1f9d57';
  if (pct <= 5)   return css('--loss-1') || '#7cb518';
  if (pct <= 15)  return css('--loss-2') || '#c9860b';
  if (pct <= 40)  return css('--loss-3') || '#e8590c';
  if (pct <= 80)  return css('--loss-4') || '#d93a3a';
  return css('--loss-5') || '#8a2be0';
}

// drag-to-zoom on the time axis. onZoom(startSec, endSec) is called on release;
// double-click calls onReset().
export function attachSmokeZoom(canvas, geom, selEl, onZoom, onReset) {
  if (!geom) { canvas.onmousedown = null; canvas.ondblclick = null; return; }
  const { pad, plotW, t0, spanSec } = geom;
  const tsAt = (mx) => t0 + (Math.min(Math.max(mx, pad.l), pad.l + plotW) - pad.l) / plotW * spanSec;
  let anchor = null;

  const show = (a, b) => {
    const l = Math.min(a, b), r = Math.max(a, b);
    selEl.hidden = false;
    selEl.style.left = (canvas.offsetLeft + l) + 'px';
    selEl.style.top = (canvas.offsetTop + pad.t) + 'px';
    selEl.style.width = (r - l) + 'px';
    selEl.style.height = geom.plotH + 'px';
  };
  const px = (e) => (e.touches ? e.touches[0].clientX : e.clientX) - canvas.getBoundingClientRect().left;

  const onMove = (e) => { if (anchor != null) show(anchor, px(e)); };
  const onUp = (e) => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    if (anchor == null) return;
    const end = px(e.changedTouches ? e.changedTouches[0] : e);
    selEl.hidden = true;
    const a = tsAt(anchor), b = tsAt(end);
    const dragPx = Math.abs(end - anchor);
    anchor = null;
    if (dragPx < 4) return;                 // a click, not a drag
    if (Math.abs(b - a) >= 60) onZoom(Math.floor(Math.min(a, b)), Math.ceil(Math.max(a, b)));
  };
  canvas.onmousedown = (e) => {
    if (e.button !== 0) return;
    const mx = px(e);
    if (mx < pad.l || mx > pad.l + plotW) return;
    anchor = mx;
    show(mx, mx);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    e.preventDefault();
  };
  canvas.ondblclick = (e) => { e.preventDefault(); onReset(); };
  canvas.style.cursor = 'crosshair';
}

export function attachSmokeHover(canvas, geom, tooltipEl) {
  if (!geom) { tooltipEl.hidden = true; return; }
  const { X, pad, plotH, t0, spanSec, series } = geom;
  const nearest = (mx) => {
    const ts = t0 + ((mx - pad.l) / geom.plotW) * spanSec;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < series.t.length; i++) {
      const d = Math.abs(series.t[i] - ts);
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  };
  const move = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    if (mx < pad.l || mx > rect.width - geom.pad.r) { tooltipEl.hidden = true; return; }
    const i = nearest(mx);
    const d = new Date(series.t[i] * 1000);
    const lp = series.loss[i];
    tooltipEl.hidden = false;
    tooltipEl.innerHTML =
      `<b>${d.toLocaleString()}</b><br>` +
      `median ${fmtMs(series.median[i])}<br>` +
      `band ${fmtMs(series.p20[i])} – ${fmtMs(series.pmax[i])}<br>` +
      `loss ${lp == null ? '–' : lp.toFixed(0) + ' %'}`;
    const px = Math.min(X(series.t[i]) + 12, rect.width - 160);
    tooltipEl.style.left = (canvas.offsetLeft + Math.max(4, px)) + 'px';
    tooltipEl.style.top = (canvas.offsetTop + 8) + 'px';
  };
  canvas.onmousemove = move;
  canvas.ontouchmove = move;
  canvas.onmouseleave = () => { tooltipEl.hidden = true; };
}

// --- sparkline -------------------------------------------------------

export function drawSpark(canvas, series) {
  const { ctx, w, h } = setupHiDPI(canvas);
  ctx.clearRect(0, 0, w, h);
  let vals = (series && series.median) || [];
  let loss = (series && series.loss) || [];

  // drop the empty run at the start so a young target still fills the width
  let first = vals.findIndex(v => v != null);
  if (first > 0) { vals = vals.slice(first); loss = loss.slice(first); }

  if (vals.filter(v => v != null).length < 2) {
    ctx.fillStyle = css('--text-faint');
    ctx.font = `11px ${css('--sans') || 'sans-serif'}`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('collecting…', 2, h / 2);
    return;
  }
  const n = vals.length;
  let ymax = 0;
  for (const v of vals) if (v != null && v > ymax) ymax = v;
  ymax = ymax || 1;
  const X = (i) => (i / Math.max(1, n - 1)) * (w - 2) + 1;
  const Y = (v) => h - 5 - (v / ymax) * (h - 9);

  // loss ticks along the bottom edge
  const slotW = Math.max(1.5, (w - 2) / Math.max(1, n - 1));
  for (let i = 0; i < n; i++) {
    if (loss[i] == null || loss[i] <= 0) continue;
    ctx.fillStyle = lossColor(loss[i]);
    ctx.fillRect(X(i) - slotW / 2, h - 3, slotW + 0.5, 3);
  }

  // median line coloured by loss per segment
  ctx.lineWidth = 1.4;
  ctx.lineCap = 'round';
  let prev = null;
  for (let i = 0; i < n; i++) {
    if (vals[i] == null) { prev = null; continue; }
    const x = X(i), y = Y(vals[i]);
    if (prev) {
      ctx.strokeStyle = lossColor(loss[i]);
      ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(x, y); ctx.stroke();
    }
    prev = { x, y };
  }
}

export { fmtMs };
