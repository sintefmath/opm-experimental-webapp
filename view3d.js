// 3D view panel: wires the GridViewer to the page controls and to simulator data.
/* global indexRestart, readRestartStep, readRestartWells */
import { GridViewer, colormapCss, WELL_COLORS, WELL_TYPES } from './viewer.js';

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
  deckWells: [],       // wells read from the deck, shown until restart data exists
  trange: null,        // {lo, hi, log}: range covered by the threshold sliders
  thrExact: null,      // threshold set by the sliders (the text fields show it rounded)
};

const viewer = new GridViewer($('v3d'), (hit) => {
  if (!hit) { $('v-info').textContent = ''; return; }
  if (hit.well) {
    const w = hit.well;
    const c = hit.conn ? ` · connection (${hit.conn[0]}, ${hit.conn[1]}, ${hit.conn[2]})${hit.conn[3] ? '' : ' shut'}` : '';
    $('v-info').textContent = `Well ${w.name} · ${WELL_TYPES[w.type] || 'no type'}${w.open ? '' : ' · shut'}${c}`;
    return;
  }
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
  const thr = !$('v-thr').checked ? null
    : st.thrExact || [parseFloat($('v-lo').value), parseFloat($('v-hi').value)];
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
$('v-thr').addEventListener('input', applyFilter);
for (const id of ['v-lo', 'v-hi']) {
  $(id).addEventListener('input', () => { st.thrExact = null; syncThresholdSliders(); applyFilter(); });
}

// Threshold sliders: 0..1000 across the property's range (log scale for permeabilities)
function sliderToValue(t) {
  const r = st.trange;
  if (!r) return NaN;
  const f = t / 1000;
  return r.log ? 10 ** (Math.log10(r.lo) + f * (Math.log10(r.hi) - Math.log10(r.lo))) : r.lo + f * (r.hi - r.lo);
}

function valueToSlider(v) {
  const r = st.trange;
  if (!r || !Number.isFinite(v)) return 0;
  const f = r.log ? (Math.log10(Math.max(v, r.lo)) - Math.log10(r.lo)) / (Math.log10(r.hi) - Math.log10(r.lo))
    : (v - r.lo) / (r.hi - r.lo);
  return Math.round(1000 * Math.min(1, Math.max(0, Number.isFinite(f) ? f : 0)));
}

function syncThresholdSliders() {
  $('v-tlo').value = valueToSlider(parseFloat($('v-lo').value));
  $('v-thi').value = valueToSlider(parseFloat($('v-hi').value));
}

for (const id of ['v-tlo', 'v-thi']) {
  $(id).addEventListener('input', () => {
    const lo = $('v-tlo'), hi = $('v-thi');
    if (+lo.value > +hi.value) { if (id === 'v-tlo') hi.value = lo.value; else lo.value = hi.value; }
    // the ends of the sliders are the exact data range, so no cell is lost to rounding
    const vlo = +lo.value === 0 ? st.trange.min : sliderToValue(+lo.value);
    const vhi = +hi.value === 1000 ? st.trange.max : sliderToValue(+hi.value);
    st.thrExact = [vlo, vhi];
    $('v-lo').value = fmt(vlo);
    $('v-hi').value = fmt(vhi);
    $('v-thr').checked = true;
    applyFilter();
  });
}
$('v-edges').addEventListener('change', () => viewer.setShowEdges($('v-edges').checked));
$('v-wells').addEventListener('change', () => { viewer.setShowWells($('v-wells').checked); $('v-wellnames').disabled = !$('v-wells').checked; });
$('v-wellnames').addEventListener('change', () => viewer.setShowWellNames($('v-wellnames').checked));
$('v-reset').addEventListener('click', () => viewer.resetView());
$('v-2d').addEventListener('change', () => viewer.setMode($('v-2d').checked ? '2d' : '3d'));
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
  const dataLo = lo, dataHi = hi;   // the threshold covers all values, also zeros on the log scale
  if (resetThreshold) { $('v-lo').value = fmt(lo); $('v-hi').value = fmt(hi); }
  // permeabilities span orders of magnitude: color them on a log scale
  if (/^PERM/.test(name) && vals) {
    let pos = Infinity;
    for (const v of vals) if (v > 0 && v < pos) pos = v;
    if (Number.isFinite(pos)) lo = Math.max(lo, pos);
  }
  const log = /^PERM/.test(name) && lo > 0 && hi / lo > 100;
  st.trange = vals && hi > lo ? { lo, hi, log, min: dataLo, max: dataHi } : null;
  for (const id of ['v-tlo', 'v-thi']) $(id).disabled = !st.trange;
  if (resetThreshold) {
    st.thrExact = [dataLo, dataHi];
    $('v-tlo').value = 0;
    $('v-thi').value = 1000;
  } else {
    syncThresholdSliders();
  }
  viewer.setValues(vals, [lo, hi], log);
  applyFilter();
  // legend
  const stops = Array.from({ length: 11 }, (_, i) => colormapCss(i / 10)).join(',');
  $('v-legend-bar').style.background = `linear-gradient(to right, ${stops})`;
  $('v-legend-lo').textContent = vals ? fmt(lo) : '';
  $('v-legend-hi').textContent = vals ? fmt(hi) : '';
  $('v-legend-name').textContent = vals ? name + (log ? ' (log scale)' : '') : 'no property';
}

// Wells shown in the view: the selected restart step's, or the deck's before there is restart data
function showWells(wells, source) {
  viewer.setWells(wells);
  const legend = $('v-well-legend');
  legend.replaceChildren();
  if (!wells.length) {
    legend.textContent = source === 'restart' ? 'No wells at this report step' : '';
    return;
  }
  const kinds = new Set(wells.map((w) => (w.open ? String(w.type) : 'shut')));
  const label = { ...WELL_TYPES, shut: 'shut' };
  for (const k of ['1', '3', '4', '2', '0', 'shut']) {
    if (!kinds.has(k)) continue;
    const item = document.createElement('span');
    const dot = document.createElement('i');
    dot.style.background = WELL_COLORS[k];
    item.append(dot, label[k]);
    legend.append(item);
  }
  const note = document.createElement('span');
  note.className = 'muted';
  note.textContent = source === 'restart' ? `${wells.length} wells at this step` : `${wells.length} wells in the schedule`;
  legend.append(note);
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
  if (s && !s.wells && st.unrst && s.entry) s.wells = readRestartWells(st.unrst, s.entry);
  if (s && s.wells) showWells(s.wells, 'restart');
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
      $('v-2d-row').hidden = !viewer.grid.flat;
      $('v-2d').checked = viewer.is2D();
      setupAxis('i', g.nx); setupAxis('j', g.ny); setupAxis('k', g.nz);
      $('v-zs').value = viewer.zscale;
      $('v-zslab').textContent = `×${viewer.zscale}`;
      $('v-thr').checked = false;
      $('v-dims').textContent = `${g.nx} × ${g.ny} × ${g.nz} grid, ${m.nactive} active cells`;
    }
    refreshPropertyList();
    showProperty(!same);
    showWells(st.deckWells, 'deck');
  },

  // wells read from the deck (shown until the simulation reports wells per report step)
  setDeckWells(wells) {
    st.deckWells = wells || [];
    if (st.dims && !st.steps.length) showWells(st.deckWells, 'deck');
  },

  // live restart data from the running simulation: {seqnum, date, data, wells}
  addLiveStep(m) {
    if (!st.dims) return;
    // keep arrays only for the newest step to bound memory; older ones are re-read at the end
    for (const s of st.steps) if (s.data) { s.names = Object.keys(s.data); s.data = null; }
    st.steps.push({ seqnum: m.seqnum, date: m.date, data: m.data, wells: m.wells });
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
