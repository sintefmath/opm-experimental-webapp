// Tiny SVG line plot: plotLines(container, {x, series:[{name, y, color}], xlabel, ylabel})
/* exported plotLines */

const PLOT_COLORS = ['#2a9d4b', '#1f6feb', '#d1462f', '#b07d00', '#8a4fd8', '#0f9fa8'];

function niceTicks(lo, hi, n) {
  if (!(hi > lo)) { hi = lo + 1; }
  const span = hi - lo;
  const step0 = Math.pow(10, Math.floor(Math.log10(span / n)));
  const err = span / n / step0;
  const step = step0 * (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1);
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) ticks.push(+v.toPrecision(12));
  return ticks;
}

function fmtNum(v) {
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-2)) return v.toExponential(1);
  return +v.toPrecision(6) + '';
}

function plotLines(el, opts) {
  const W = el.clientWidth || 500, H = el.clientHeight || 280;
  const m = { l: 64, r: 12, t: 10, b: 40 };
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const add = (tag, attrs, text) => {
    const e = document.createElementNS(ns, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text !== undefined) e.textContent = text;
    svg.appendChild(e);
    return e;
  };
  el.replaceChildren(svg);

  const x = opts.x || [];
  const series = (opts.series || []).filter((s) => s.y && s.y.length);
  if (!x.length || !series.length) {
    add('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'empty' }, opts.empty || 'No data yet');
    return;
  }
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const v of x) { xmin = Math.min(xmin, v); xmax = Math.max(xmax, v); }
  for (const s of series) for (const v of s.y) { if (isFinite(v)) { ymin = Math.min(ymin, v); ymax = Math.max(ymax, v); } }
  if (ymin > 0 && ymin < 0.5 * ymax) ymin = 0;
  if (ymax === ymin) { ymax += Math.abs(ymax) * 0.1 || 1; ymin -= Math.abs(ymin) * 0.1; }
  if (xmax === xmin) xmax = xmin + 1;
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const sx = (v) => m.l + (v - xmin) / (xmax - xmin) * pw;
  const sy = (v) => m.t + ph - (v - ymin) / (ymax - ymin) * ph;

  const grid = getComputedStyle(document.documentElement).getPropertyValue('--grid').trim() || '#ddd';
  const muted = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#777';
  for (const t of niceTicks(ymin, ymax, 5)) {
    add('line', { x1: m.l, x2: W - m.r, y1: sy(t), y2: sy(t), stroke: grid });
    add('text', { x: m.l - 6, y: sy(t) + 4, 'text-anchor': 'end', 'font-size': 11, fill: muted }, fmtNum(t));
  }
  for (const t of niceTicks(xmin, xmax, Math.max(2, Math.floor(pw / 80)))) {
    add('line', { x1: sx(t), x2: sx(t), y1: m.t, y2: m.t + ph, stroke: grid });
    add('text', { x: sx(t), y: H - m.b + 15, 'text-anchor': 'middle', 'font-size': 11, fill: muted }, fmtNum(t));
  }
  add('text', { x: m.l + pw / 2, y: H - 6, 'text-anchor': 'middle', 'font-size': 12, fill: muted }, opts.xlabel || '');
  if (opts.ylabel) {
    add('text', { x: 12, y: m.t + ph / 2, 'text-anchor': 'middle', 'font-size': 12, fill: muted,
                  transform: `rotate(-90 12 ${m.t + ph / 2})` }, opts.ylabel);
  }
  series.forEach((s, i) => {
    let d = '';
    for (let k = 0; k < x.length; k++) d += (k ? 'L' : 'M') + sx(x[k]).toFixed(1) + ',' + sy(s.y[k]).toFixed(1);
    add('path', { d, fill: 'none', stroke: s.color || PLOT_COLORS[i % PLOT_COLORS.length], 'stroke-width': 2,
                  'stroke-linejoin': 'round' });
  });
  // legend
  let lx = m.l + 8;
  series.forEach((s, i) => {
    const c = s.color || PLOT_COLORS[i % PLOT_COLORS.length];
    add('rect', { x: lx, y: m.t + 6, width: 12, height: 3, fill: c });
    const t = add('text', { x: lx + 16, y: m.t + 11, 'font-size': 11, fill: muted }, s.name);
    lx += 24 + (t.getComputedTextLength ? t.getComputedTextLength() : s.name.length * 6);
  });
}
