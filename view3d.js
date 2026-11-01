// 3D view panel: wires the GridViewer to the page controls and to simulator data.
/* global indexRestart, readRestartStep */
import { GridViewer, colormapCss } from './viewer.js';

const $ = (id) => document.getElementById(id);
const FIXED_RANGE = /^(S(WAT|OIL|GAS)|.*KR|SGMAX|SOMAX)$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const st = {
  dims: null,          // [nx, ny, nz, nactive]
  init: {},            // static properties
  steps: [],           // [{seqnum, date, data?, entry?}]
  unrst: null,         // Uint8Array of the UNRST output, once the run is finished
  stepIdx: -1,
  live: true,
  values: null,
  userPicked: false,
};

const viewer = new GridViewer($('v3d'), (hit) => {
  if (!hit) { $('v-info').textContent = ''; return; }
  const v = hit.value === undefined ? '' : ` · ${$('v-prop').value} = ${fmt(hit.value)}`;
  $('v-info').textContent = `Cell (${hit.i}, ${hit.j}, ${hit.k})${v}`;
});

function fmt(v) {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  return a !== 0 && (a >= 1e5 || a < 1e-3) ? v.toExponential(3) : (+v.toPrecision(5)).toString();
}

function themeBackground() {
  viewer.setBackground(getComputedStyle(document.documentElement).getPropertyValue('--plot-bg').trim() || '#fff');
}
themeBackground();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeBackground);

// ------------------------------------------------------------------ controls

function setupAxis(axis, n) {
  const lo = $(`v-${axis}min`), hi = $(`v-${axis}max`);
  for (const el of [lo, hi]) { el.min = 1; el.max = n; }
  lo.value = 1; hi.value = n;
  updateAxisLabel(axis);
}

function updateAxisLabel(axis) {
  const lo = $(`v-${axis}min`), hi = $(`v-${axis}max`);
  if (+lo.value > +hi.value) {
    if (document.activeElement === lo) hi.value = lo.value; else lo.value = hi.value;
  }
  $(`v-${axis}lab`).textContent = `${axis.toUpperCase()} ${lo.value}–${hi.value}`;
}

function applyFilter() {
  for (const a of ['i', 'j', 'k']) updateAxisLabel(a);
  const thr = $('v-thr').checked ? [parseFloat($('v-lo').value), parseFloat($('v-hi').value)] : null;
  viewer.setFilter({
    imin: $('v-imin').value - 1, imax: $('v-imax').value - 1,
    jmin: $('v-jmin').value - 1, jmax: $('v-jmax').value - 1,
    kmin: $('v-kmin').value - 1, kmax: $('v-kmax').value - 1,
    threshold: thr && Number.isFinite(thr[0]) && Number.isFinite(thr[1]) ? thr : null,
  });
  $('v-count').textContent = `${viewer.visibleCells} of ${st.dims[3]} cells shown`;
}

for (const a of ['i', 'j', 'k']) {
  for (const m of ['min', 'max']) $(`v-${a}${m}`).addEventListener('input', applyFilter);
}
for (const id of ['v-thr', 'v-lo', 'v-hi']) $(id).addEventListener('input', applyFilter);
$('v-edges').addEventListener('change', () => viewer.setShowEdges($('v-edges').checked));
$('v-reset').addEventListener('click', () => viewer.resetView());
$('v-zs').addEventListener('input', () => {
  $('v-zslab').textContent = `×${$('v-zs').value}`;
  viewer.setZScale(+$('v-zs').value);
});
$('v-prop').addEventListener('change', () => { st.userPicked = true; showProperty(true); });
$('v-step').addEventListener('input', () => {
  st.live = false;
  $('v-live').checked = false;
  selectStep(+$('v-step').value);
});
$('v-live').addEventListener('change', () => {
  st.live = $('v-live').checked;
  if (st.live && st.steps.length) selectStep(st.steps.length - 1);
});

// ------------------------------------------------------------------ data

function dynamicNames() {
  const s = st.steps[st.stepIdx];
  return s && s.data ? Object.keys(s.data) : (st.steps.length && st.steps[0].names) || [];
}

function refreshPropertyList() {
  const sel = $('v-prop');
  const cur = sel.value;
  const dyn = dynamicNames();
  const stat = Object.keys(st.init);
  const sig = dyn.join(',') + '|' + stat.join(',');
  if (sel.dataset.sig === sig) return;
  sel.dataset.sig = sig;
  sel.replaceChildren();
  const group = (label, names) => {
    if (!names.length) return;
    const g = document.createElement('optgroup');
    g.label = label;
    for (const n of names) g.append(new Option(n, n));
    sel.append(g);
  };
  const order = ['PRESSURE', 'SWAT', 'SOIL', 'SGAS', 'RS', 'RV'];
  group('Dynamic (restart)', [...order.filter((n) => dyn.includes(n)), ...dyn.filter((n) => !order.includes(n)).sort()]);
  group('Static (INIT)', stat);
  const names = [...dyn, ...stat];
  if (names.includes(cur) && (st.userPicked || !dyn.length || dyn.includes(cur))) sel.value = cur;
  else sel.value = dyn.includes('PRESSURE') ? 'PRESSURE' : (stat.includes('PORO') ? 'PORO' : names[0] || '');
}

function currentValues(name) {
  if (st.init[name]) return st.init[name];
  const s = st.steps[st.stepIdx];
  if (!s) return null;
  if (!s.data && st.unrst && s.entry) s.data = readRestartStep(st.unrst, s.entry, st.dims[3]);
  return s.data ? s.data[name] || null : null;
}

function showProperty(resetThreshold) {
  const name = $('v-prop').value;
  const vals = currentValues(name);
  st.values = vals;
  let lo = Infinity, hi = -Infinity;
  if (vals) for (const v of vals) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!(hi >= lo)) { lo = 0; hi = 1; }
  if (FIXED_RANGE.test(name) && lo >= -1e-6 && hi <= 1 + 1e-6) { lo = 0; hi = 1; }
  if (resetThreshold) { $('v-lo').value = fmt(lo); $('v-hi').value = fmt(hi); }
  // permeabilities span orders of magnitude: color them on a log scale
  if (/^PERM/.test(name) && vals) {
    let pos = Infinity;
    for (const v of vals) if (v > 0 && v < pos) pos = v;
    if (Number.isFinite(pos)) lo = Math.max(lo, pos);
  }
  const log = /^PERM/.test(name) && lo > 0 && hi / lo > 100;
  viewer.setValues(vals, [lo, hi], log);
  applyFilter();
  // legend
  const stops = Array.from({ length: 11 }, (_, i) => colormapCss(i / 10)).join(',');
  $('v-legend-bar').style.background = `linear-gradient(to right, ${stops})`;
  $('v-legend-lo').textContent = vals ? fmt(lo) : '';
  $('v-legend-hi').textContent = vals ? fmt(hi) : '';
  $('v-legend-name').textContent = vals ? name + (log ? ' (log scale)' : '') : 'no property';
}

function stepLabel(s) {
  if (!s) return 'no restart data yet';
  const d = s.date ? `${s.date[0]}-${MONTHS[s.date[1] - 1] || s.date[1]}-${s.date[2]}` : '';
  return `Report step ${s.seqnum}${d ? ' · ' + d : ''}`;
}

function selectStep(i) {
  const s = st.steps[i];
  if (s && !s.data && st.unrst && s.entry) s.data = readRestartStep(st.unrst, s.entry, st.dims[3]);
  // drop arrays of the previously shown step (re-read on demand) to bound memory
  const prev = st.steps[st.stepIdx];
  if (prev && prev !== s && prev.entry && st.unrst) prev.data = null;
  st.stepIdx = i;
  $('v-step').value = i;
  $('v-step-label').textContent = stepLabel(st.steps[i]);
  refreshPropertyList();
  showProperty(false);
}

function updateStepSlider() {
  const n = st.steps.length;
  $('v-step').max = Math.max(0, n - 1);
  $('v-step').disabled = n < 2;
}

// ------------------------------------------------------------------ API used by app.js

window.view3d = {
  // {grid: {nx, ny, nz, coord, zcorn, actnum}, init: {NAME: Float32Array}, nactive}
  setGrid(m) {
    const g = m.grid;
    const same = st.dims && st.dims[0] === g.nx && st.dims[1] === g.ny && st.dims[2] === g.nz &&
                 st.dims[3] === m.nactive;
    st.init = m.init || {};
    st.steps = [];
    st.stepIdx = -1;
    st.unrst = null;
    st.live = true;
    $('v-live').checked = true;
    updateStepSlider();
    $('v-step-label').textContent = stepLabel(null);
    $('v3d-card').hidden = false;
    if (!same) {
      st.dims = [g.nx, g.ny, g.nz, m.nactive];
      st.userPicked = false;
      viewer.setGrid(g);
      setupAxis('i', g.nx); setupAxis('j', g.ny); setupAxis('k', g.nz);
      $('v-zs').value = viewer.zscale;
      $('v-zslab').textContent = `×${viewer.zscale}`;
      $('v-thr').checked = false;
      $('v-dims').textContent = `${g.nx} × ${g.ny} × ${g.nz} grid, ${m.nactive} active cells`;
    }
    refreshPropertyList();
    showProperty(!same);
  },

  // live restart data from the running simulation: {seqnum, date, data}
  addLiveStep(m) {
    if (!st.dims) return;
    // keep arrays only for the newest step to bound memory; older ones are re-read at the end
    for (const s of st.steps) if (s.data) { s.names = Object.keys(s.data); s.data = null; }
    st.steps.push({ seqnum: m.seqnum, date: m.date, data: m.data });
    updateStepSlider();
    if (st.live) selectStep(st.steps.length - 1);
    else $('v-step').max = st.steps.length - 1;
  },

  // after the run: index the UNRST output so every step can be inspected
  setOutputs(outputs) {
    const f = outputs.find((o) => /\.UNRST$/i.test(o.path));
    if (!f || !st.dims) return;
    st.unrst = f.data;
    const idx = indexRestart(f.data);
    const latest = st.steps[st.steps.length - 1];
    st.steps = idx.map((e) => ({ seqnum: e.seqnum, date: e.date, entry: e,
                                 names: e.arrays.filter((a) => a.count === st.dims[3]).map((a) => a.name) }));
    // reuse the arrays we already have for the last step
    if (latest && latest.data && st.steps.length && st.steps[st.steps.length - 1].seqnum === latest.seqnum) {
      st.steps[st.steps.length - 1].data = latest.data;
    }
    updateStepSlider();
    const keep = st.live || st.stepIdx < 0 ? st.steps.length - 1
      : Math.max(0, st.steps.findIndex((s) => s.seqnum === (latest && latest.seqnum)));
    if (st.steps.length) selectStep(keep);
  },
};
