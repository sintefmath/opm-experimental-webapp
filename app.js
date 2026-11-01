/* global fflate, plotLines */
'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  files: new Map(),   // relative path -> Uint8Array
  caseName: '',
  worker: null,
  previewWorker: null,
  summary: null,
  outputs: [],
};

// ---------------------------------------------------------------- case input

function setCase(name, files, deck) {
  state.files = files;
  state.caseName = name;
  // likely decks first: upper-case .DATA, then shallow paths
  const depth = (p) => p.split('/').length;
  const decks = [...files.keys()].filter((p) => /\.data$/i.test(p)).sort((a, b) =>
    (/\.DATA$/.test(b) - /\.DATA$/.test(a)) || (depth(a) - depth(b)) || a.localeCompare(b));
  const sel = $('deck-select');
  sel.replaceChildren(...decks.map((d) => new Option(d, d)));
  if (deck && decks.includes(deck)) sel.value = deck;
  $('deck-row').hidden = false;
  let bytes = 0;
  for (const f of files.values()) bytes += f.byteLength;
  $('case-info').textContent = `${name}: ${files.size} file(s), ${(bytes / 1e6).toFixed(1)} MB`;
  $('run').disabled = decks.length === 0;
  setStatus(decks.length ? 'Ready to run.' : 'No .DATA deck found in the uploaded case.');
  previewGrid();
}

// The 3D view is an ES module (three.js); if it failed to load, say so instead of hiding it
function call3d(fn, m) {
  if (window.view3d) { window.view3d[fn](m); return; }
  if (state.warned3d) return;
  state.warned3d = true;
  $('v3d-card').hidden = false;
  $('v3d').textContent = '3D view could not be loaded: view3d.js, viewer.js or lib/three.module.min.js ' +
    'is missing or blocked on this server (see the browser console).';
}

// ---------------------------------------------------------------- simulator build

// Up to four simulator builds: wasm32/wasm64 (MEMORY64, up to 16 GB, needs browser support,
// slower), each single-threaded or multi-threaded (OpenMP; needs a cross-origin isolated page).
// The directory names match package-web.sh and worker.js.
const BUILDS = { st32: '', st64: 'wasm64/', mt32: 'mt32/', mt64: 'mt64/' };
const MEM64_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 0]);
const available = new Set();

async function setupBuildSelect() {
  const mem64 = WebAssembly.validate(MEM64_PROBE);
  await Promise.all(Object.entries(BUILDS).map(async ([id, dir]) => {
    if (id.endsWith('64') && !mem64) return;
    if (id.startsWith('mt') && !self.crossOriginIsolated) return;
    try { if ((await fetch(dir + 'flow.js', { method: 'HEAD' })).ok) available.add(id); } catch (e) { /* missing */ }
  }));
  const opt64 = $('build-select').querySelector('option[value="64"]');
  if (!available.has('st64') && !available.has('mt64')) {
    opt64.disabled = true;
    opt64.textContent += mem64 ? ' — not included in this build' : ' — not supported by this browser';
  }
  const sel = $('threads-select');
  const cores = navigator.hardwareConcurrency || 1;
  const mt = available.has('mt32') || available.has('mt64');
  const counts = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32].filter((n) => n < cores);
  for (const n of [...counts, Math.min(cores, 64)]) sel.append(new Option(String(n), n));
  if (mt) sel.value = String([...sel.options].map((o) => +o.value).filter((n) => n <= Math.max(1, cores / 2)).pop());
  else {
    sel.disabled = true;
    $('threads-note').textContent = self.crossOriginIsolated ? '(no multi-threaded build here)'
      : '(multi-threading needs a cross-origin isolated page)';
  }
}
const buildsReady = setupBuildSelect();

// Pick the build for the chosen memory limit and thread count
function chooseBuild(threads) {
  const mem = $('build-select').value;
  const order = threads > 1 ? [`mt${mem}`, `st${mem}`] : [`st${mem}`, `mt${mem}`];
  return order.find((id) => available.has(id)) || 'st32';
}
function newWorker(threads) {
  const id = chooseBuild(threads);
  const n = id.startsWith('mt') ? threads : 1;
  return { worker: new Worker(`worker.js?dir=${encodeURIComponent(BUILDS[id])}&threads=${n}`), threads: n, id };
}

// Read the grid with a dry run (no time stepping) so it can be shown before simulating
function previewGrid() {
  const deck = $('deck-select').value;
  if (state.previewWorker) state.previewWorker.terminate();
  state.previewWorker = null;
  if (!deck || state.worker) return;
  const files = [...state.files].map(([path, data]) => ({ path, data: data.slice().buffer }));
  const w = newWorker(1).worker;
  state.previewWorker = w;
  setStatus('Reading grid for the 3D view (dry run)…');
  const end = () => { w.terminate(); if (state.previewWorker === w) state.previewWorker = null; };
  w.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'grid') {
      call3d('setGrid', m);
      setStatus('Ready to run.');
    }
    else if (m.type === 'log' && m.err) appendLog(m.text);
    else if (m.type === 'done' || m.type === 'error') {
      if (m.type === 'error' || m.rc !== 0) appendLog('Grid preview failed: ' + (m.text || 'exit code ' + m.rc));
      end();
    }
  };
  w.onerror = end;
  w.postMessage({ type: 'run', files, deck, args: splitArgs($('extra-args').value), preview: true },
                files.map((f) => f.data));
}
$('deck-select').addEventListener('change', previewGrid);
$('build-select').addEventListener('change', previewGrid);

// Remove a common leading directory (e.g. "NORNE/") from all paths
function stripCommonRoot(entries) {
  const paths = entries.map(([p]) => p);
  const first = paths[0] && paths[0].split('/')[0];
  if (first && paths.every((p) => p.startsWith(first + '/'))) {
    return entries.map(([p, d]) => [p.slice(first.length + 1), d]);
  }
  return entries;
}

async function filesFromInput(fileList, useRelativePath) {
  const entries = [];
  for (const f of fileList) {
    const path = (useRelativePath && f.webkitRelativePath) || f.name;
    entries.push([path, new Uint8Array(await f.arrayBuffer())]);
  }
  return new Map(stripCommonRoot(entries));
}

$('upload-folder').addEventListener('change', async (e) => {
  if (!e.target.files.length) return;
  const name = e.target.files[0].webkitRelativePath.split('/')[0] || 'folder';
  setCase(name, await filesFromInput(e.target.files, true));
  e.target.value = '';
});

$('upload-files').addEventListener('change', async (e) => {
  if (!e.target.files.length) return;
  setCase(e.target.files[0].name, await filesFromInput(e.target.files, false));
  e.target.value = '';
});

$('upload-zip').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const raw = fflate.unzipSync(new Uint8Array(await f.arrayBuffer()));
    const entries = Object.entries(raw).filter(([p]) => !p.endsWith('/') && !p.startsWith('__MACOSX/'));
    setCase(f.name, new Map(stripCommonRoot(entries)));
  } catch (err) {
    setStatus('Could not read zip file: ' + err.message);
  }
  e.target.value = '';
});

let examples = [];
fetch('cases/manifest.json').then((r) => r.json()).then((list) => {
  examples = list;
  for (const ex of list) $('example-select').add(new Option(ex.title, ex.id));
}).catch(() => { /* no bundled examples */ });

$('load-example').addEventListener('click', async () => {
  const ex = examples.find((x) => x.id === $('example-select').value);
  if (!ex) return;
  setStatus(`Downloading ${ex.title}…`);
  const files = new Map();
  try {
    await Promise.all(ex.files.map(async (p) => {
      const r = await fetch(`cases/${ex.name}/${p}`);
      if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
      files.set(p, new Uint8Array(await r.arrayBuffer()));
    }));
  } catch (err) {
    setStatus('Could not load example: ' + err.message);
    return;
  }
  if (ex.args) $('extra-args').value = ex.args;
  setCase(ex.title, files, ex.deck);
});

// ---------------------------------------------------------------- running

function setStatus(t) { $('status').textContent = t; }

function setProgress(frac, text) {
  $('progress-bar').style.width = (Math.max(0, Math.min(1, frac)) * 100).toFixed(1) + '%';
  $('progress-text').textContent = text;
}

const logLines = [];
let logDirty = false;
function appendLog(text) {
  logLines.push(text);
  if (logLines.length > 4000) logLines.splice(0, logLines.length - 4000);
  if (!logDirty) {
    logDirty = true;
    requestAnimationFrame(() => {
      logDirty = false;
      const el = $('log');
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
      el.textContent = logLines.join('\n');
      if (atBottom) el.scrollTop = el.scrollHeight;
    });
  }
}

function splitArgs(s) {
  return (s.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []).map((a) => a.replace(/^["']|["']$/g, ''));
}

let startTime = 0;
let timerId = 0;

function runSimulation() {
  const deck = $('deck-select').value;
  if (!deck) return;
  stopWorker();
  if (state.previewWorker) { state.previewWorker.terminate(); state.previewWorker = null; }
  logLines.length = 0;
  appendLog('');
  state.summary = null;
  state.outputs = [];
  renderOutputs();
  renderPlots();
  setProgress(0, '0 %');

  const files = [...state.files].map(([path, data]) => ({ path, data: data.slice().buffer }));
  const { worker: w, threads, id: buildId } = newWorker(+$('threads-select').value);
  state.worker = w;
  appendLog(`Using the ${buildId.endsWith('64') ? '64' : '32'}-bit build with ${threads} thread(s).`);
  $('run').disabled = true;
  $('stop').disabled = false;
  startTime = performance.now();
  let lastProgress = { day: 0, totalDays: 0, step: 0, steps: 0 };
  const elapsed = () => ((performance.now() - startTime) / 1000).toFixed(0) + ' s';
  timerId = setInterval(() => {
    if (lastProgress.totalDays) {
      setStatus(`Report step ${lastProgress.step}/${lastProgress.steps} · day ` +
                `${lastProgress.day.toFixed(0)} of ${lastProgress.totalDays.toFixed(0)} · ${elapsed()}`);
    }
  }, 500);

  w.onmessage = (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'log': appendLog(m.text); break;
      case 'status': setStatus(m.text); break;
      case 'progress': {
        if (m.step) { lastProgress.step = m.step; lastProgress.steps = m.steps; }
        lastProgress.totalDays = m.totalDays;
        lastProgress.day = Math.max(lastProgress.day, m.day);
        const f = lastProgress.day / m.totalDays;
        setProgress(f, `${(f * 100).toFixed(1)} %`);
        break;
      }
      case 'summary':
        state.summary = m.summary;
        renderPlots();
        break;
      case 'grid':
        call3d('setGrid', m);
        break;
      case 'restart':
        call3d('addLiveStep', m);
        break;
      case 'done':
        clearInterval(timerId);
        state.outputs = m.files.map((f) => ({ path: f.path, data: new Uint8Array(f.data) }));
        renderOutputs();
        call3d('setOutputs', state.outputs);
        if (m.rc === 0) {
          setProgress(1, '100 %');
          setStatus(`Finished in ${m.seconds.toFixed(1)} s.`);
        } else {
          const oom = logLines.some((l) => /bad_alloc|Cannot enlarge memory|Out of memory/i.test(l));
          setStatus(oom && $('build-select').value !== '64'
            ? 'Flow ran out of memory (4 GB limit of wasm32). Try "Memory: up to 16 GB" and run again.'
            : `Flow exited with code ${m.rc} after ${m.seconds.toFixed(1)} s — see the log.`);
        }
        finishRun();
        break;
      case 'error':
        clearInterval(timerId);
        appendLog(m.text);
        setStatus('Simulator crashed: ' + m.text.split('\n')[0]);
        finishRun();
        break;
    }
  };
  w.onerror = (e) => {
    clearInterval(timerId);
    setStatus('Worker error: ' + e.message);
    finishRun();
  };
  w.postMessage({ type: 'run', files, deck, threads, args: splitArgs($('extra-args').value) },
                files.map((f) => f.data));
}

function finishRun() {
  $('run').disabled = false;
  $('stop').disabled = true;
  if (state.worker) { state.worker.terminate(); state.worker = null; }
}

function stopWorker() {
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
    clearInterval(timerId);
    setStatus('Stopped.');
  }
  $('run').disabled = !$('deck-select').value;
  $('stop').disabled = true;
}

$('run').addEventListener('click', runSimulation);
$('stop').addEventListener('click', stopWorker);

// ---------------------------------------------------------------- plots

const LIQUID_VECTORS = [['FOPR', '#2a9d4b'], ['FWPR', '#1f6feb'], ['FWIR', '#0f9fa8']];
const GAS_VECTORS = [['FGPR', '#d1462f'], ['FGIR', '#b07d00']];

function plotField(el, s, vectors) {
  const series = vectors.filter(([k]) => s.vectors[k] && s.vectors[k].some((v) => v !== 0))
    .map(([k, color]) => ({ name: k, y: s.vectors[k], color }));
  const unit = series.length ? s.units[series[0].name] : '';
  plotLines(el, { x: s.time, series, xlabel: 'Time (days)', ylabel: unit, empty: 'Not in summary output' });
}

function renderPlots() {
  const s = state.summary;
  if (!s) {
    for (const id of ['plot-field', 'plot-gas', 'plot-custom']) {
      plotLines($(id), { empty: 'Run a simulation to see production curves' });
    }
    return;
  }
  plotField($('plot-field'), s, LIQUID_VECTORS);
  plotField($('plot-gas'), s, GAS_VECTORS);

  // vector selector
  const sel = $('vector-select');
  const keys = Object.keys(s.vectors).filter((k) => k !== 'TIME').sort();
  if (sel.options.length - 1 !== keys.length) {
    const cur = sel.value;
    sel.replaceChildren(new Option('— summary vector —', ''), ...keys.map((k) => new Option(k, k)));
    sel.value = keys.includes(cur) ? cur : (keys.find((k) => k.startsWith('WBHP:')) || keys.find((k) => k === 'FPR') || '');
  }
  const k = sel.value;
  plotLines($('plot-custom'), k
    ? { x: s.time, series: [{ name: k, y: s.vectors[k] }], xlabel: 'Time (days)', ylabel: s.units[k] }
    : { empty: 'Choose a summary vector' });
}
$('vector-select').addEventListener('change', renderPlots);
window.addEventListener('resize', renderPlots);
renderPlots();

// ---------------------------------------------------------------- outputs

function download(name, bytes, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type: type || 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function renderOutputs() {
  const list = $('output-list');
  list.replaceChildren();
  $('output-row').hidden = state.outputs.length === 0;
  let bytes = 0;
  for (const f of state.outputs) {
    bytes += f.data.byteLength;
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = f.path;
    a.addEventListener('click', (e) => { e.preventDefault(); download(f.path.split('/').pop(), f.data); });
    li.append(a, ` (${(f.data.byteLength / 1024).toFixed(0)} kB)`);
    list.append(li);
  }
  $('output-info').textContent = `${state.outputs.length} file(s), ${(bytes / 1e6).toFixed(1)} MB`;
}

$('download-all').addEventListener('click', () => {
  const tree = {};
  for (const f of state.outputs) tree[f.path] = f.data;
  const base = ($('deck-select').value.split('/').pop() || 'output').replace(/\.[^.]*$/, '');
  download(base + '-output.zip', fflate.zipSync(tree, { level: 1 }), 'application/zip');
});
