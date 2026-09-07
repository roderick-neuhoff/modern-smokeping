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

  // median line, broken across gaps
  ctx.strokeStyle = css('--median-line');
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  let pen = false;
  for (let i = 0; i < t.length; i++) {
    if (median[i] == null) { pen = false; continue; }
    const x = X(t[i]), y = Y(median[i]);
    if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // loss markers along the bottom
  const lossColor = css('--loss-mark');
  for (let i = 0; i < t.length; i++) {
    const lp = loss[i];
    if (lp == null || lp <= 0) continue;
    const x = X(t[i]);
    const strength = Math.min(1, lp / 100);
    ctx.fillStyle = lossColor;
    ctx.globalAlpha = 0.25 + 0.75 * strength;
    const barH = 3 + strength * 7;
    ctx.fillRect(x - 1.2, pad.t + plotH - barH, 2.4, barH);
  }
  ctx.globalAlpha = 1;

  return { X, Y, t0, spanSec, ymax, pad, plotW, plotH, series };
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
  const vals = (series && series.median) || [];
  const loss = (series && series.loss) || [];
  const t = (series && series.t) || vals.map((_, i) => i);
  if (t.length < 2) {
    ctx.fillStyle = css('--text-faint');
    ctx.font = `11px ${css('--sans') || 'sans-serif'}`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('no data', 2, h / 2);
    return;
  }
  let ymax = 0;
  for (const v of vals) if (v != null && v > ymax) ymax = v;
  ymax = ymax || 1;
  const X = (i) => (i / (t.length - 1)) * (w - 2) + 1;
  const Y = (v) => h - 2 - (v / ymax) * (h - 4);

  // loss shading
  ctx.fillStyle = css('--loss-mark');
  for (let i = 0; i < t.length; i++) {
    if (loss[i] == null || loss[i] <= 0) continue;
    ctx.globalAlpha = 0.15 + 0.6 * Math.min(1, loss[i] / 100);
    ctx.fillRect(X(i) - 1, 1, 2, h - 2);
  }
  ctx.globalAlpha = 1;

  // area + line
  ctx.beginPath();
  let pen = false;
  for (let i = 0; i < t.length; i++) {
    if (vals[i] == null) { pen = false; continue; }
    const x = X(i), y = Y(vals[i]);
    if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = css('--accent');
  ctx.lineWidth = 1.3;
  ctx.stroke();
}

export { fmtMs };
