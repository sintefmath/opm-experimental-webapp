// Web Worker running OPM Flow (WebAssembly) so that the UI stays responsive.
/* global createFlow, readSummary, readGrid, readInit, indexRestart, readRestartStep, readRestartWells */
// worker.js?dir=mt64/&threads=4 loads the simulator build in that directory (see BUILDS in app.js)
const params = new URL(self.location.href).searchParams;
const BUILD_DIR = (params.get('dir') || '').replace(/[^\w/]/g, '');
const THREADS = Math.max(1, +params.get('threads') || 1);
// Emscripten starts the OpenMP thread pool from this script's URL; such a worker ("em-pthread")
// only loads the simulator, which then takes over its message handling
const IS_PTHREAD = self.name === 'em-pthread';
importScripts(BUILD_DIR + 'flow.js', ...(IS_PTHREAD ? [] : ['smry.js']));

const CASE_DIR = '/case';
const OUT_DIR = '/output';

let FS = null;
let deckBase = '';
let totalDays = 0;
let lastSummaryPost = 0;
let gridInfo = null;   // {nactive} once the grid has been posted
let rstPos = 0;        // byte offset in UNRST after the last complete report step

function post(msg, transfer) { self.postMessage(msg, transfer || []); }

function mkdirs(path) {
  let cur = '';
  for (const part of path.split('/').filter(Boolean)) {
    cur += '/' + part;
    try { FS.mkdir(cur); } catch (e) { /* exists */ }
  }
}

function listFiles(dir, prefix = '') {
  const out = [];
  for (const name of FS.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const full = dir + '/' + name;
    const st = FS.stat(full);
    if (FS.isDir(st.mode)) out.push(...listFiles(full, prefix + name + '/'));
    else out.push(prefix + name);
  }
  return out;
}

// Send current summary data (parsed here, so the main thread only plots)
function postSummary(force) {
  const now = Date.now();
  if (!force && now - lastSummaryPost < 1000) return;
  lastSummaryPost = now;
  const smspec = `${OUT_DIR}/${deckBase}.SMSPEC`;
  const unsmry = `${OUT_DIR}/${deckBase}.UNSMRY`;
  try {
    if (!FS.analyzePath(smspec).exists || !FS.analyzePath(unsmry).exists) return;
    const a = FS.readFile(smspec), b = FS.readFile(unsmry);
    const s = readSummary(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength),
                          b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    post({ type: 'summary', summary: s });
  } catch (e) {
    // The file may be partially written; try again on the next report step
  }
}

// Bytes of a MEMFS file without copying (falls back to a copy)
function fileBytes(path) {
  if (!FS.analyzePath(path).exists) return null;
  const node = FS.lookupPath(path).node;
  if (node.contents instanceof Uint8Array && typeof node.usedBytes === 'number') {
    return node.contents.subarray(0, node.usedBytes);
  }
  return FS.readFile(path);
}

// Send grid geometry and static INIT properties once they exist
function postGrid() {
  if (gridInfo) return;
  try {
    const egrid = fileBytes(`${OUT_DIR}/${deckBase}.EGRID`);
    if (!egrid) return;
    const grid = readGrid(egrid);
    let nactive = 0;
    for (const v of grid.actnum) if (v > 0) nactive++;
    const initBytes = fileBytes(`${OUT_DIR}/${deckBase}.INIT`);
    const init = initBytes ? readInit(initBytes, nactive, grid.actnum) : {};
    gridInfo = { nactive };
    const transfer = [grid.coord.buffer, grid.zcorn.buffer, grid.actnum.buffer,
                      ...Object.values(init).map((v) => v.buffer)];
    post({ type: 'grid', grid, init, nactive }, transfer);
  } catch (e) {
    post({ type: 'log', text: 'Could not read grid: ' + e, err: true });
  }
}

// Send the newest complete restart step written since the last call
function postRestart() {
  if (!gridInfo) return;
  try {
    const bytes = fileBytes(`${OUT_DIR}/${deckBase}.UNRST`);
    if (!bytes || bytes.length <= rstPos) return;
    const steps = indexRestart(bytes, rstPos);
    if (!steps.length) return;
    const last = steps[steps.length - 1];
    rstPos = last.end;
    const data = readRestartStep(bytes, last, gridInfo.nactive);
    const wells = readRestartWells(bytes, last);
    post({ type: 'restart', seqnum: last.seqnum, date: last.date, data, wells },
         Object.values(data).map((v) => v.buffer));
  } catch (e) {
    // partially written; retry later
  }
}

const reReport = /Report step\s+(\d+)\/(\d+) at day ([-+\d.eE]+)\/([-+\d.eE]+)/;
const reSubstep = /Starting time step\s+\d+, stepsize [-+\d.eE]+ days, at day ([-+\d.eE]+)/;

function onOutput(text) {
  post({ type: 'log', text });
  let m = reReport.exec(text);
  if (m) {
    totalDays = parseFloat(m[4]);
    post({ type: 'progress', step: +m[1], steps: +m[2], day: parseFloat(m[3]), totalDays });
    postSummary(false);
    postGrid();
    postRestart();
    return;
  }
  m = reSubstep.exec(text);
  if (m && totalDays > 0) post({ type: 'progress', day: parseFloat(m[1]), totalDays });
}

if (!IS_PTHREAD) self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type !== 'run') return;
  deckBase = msg.deck.split('/').pop().replace(/\.[^.]*$/, '');
  try {
    post({ type: 'status', text: msg.preview ? 'Reading grid…' : 'Loading simulator…' });
    const mod = await createFlow({
      print: onOutput,
      printErr: (t) => post({ type: 'log', text: t, err: true }),
      noInitialRun: true,
      locateFile: (p) => BUILD_DIR + p,
      // multi-threaded builds: the Web Workers for the OpenMP threads are created before main() runs
      numThreads: THREADS,
    });
    FS = mod.FS;
    mkdirs(CASE_DIR);
    mkdirs(OUT_DIR);
    for (const f of msg.files) {
      const full = CASE_DIR + '/' + f.path;
      mkdirs(full.substring(0, full.lastIndexOf('/')));
      FS.writeFile(full, new Uint8Array(f.data));
    }
    FS.chdir(CASE_DIR + '/' + (msg.deck.includes('/') ? msg.deck.substring(0, msg.deck.lastIndexOf('/')) : ''));
    const args = [
      CASE_DIR + '/' + msg.deck,
      '--output-dir=' + OUT_DIR,
      '--enable-async-ecl-output=false',
      '--threads-per-process=' + THREADS,   // flow's own default is 2
      ...(msg.preview ? ['--enable-dry-run=true'] : []),
      ...msg.args,
    ];
    if (!msg.preview) post({ type: 'status', text: 'Running: flow ' + args.join(' ') });
    const t0 = performance.now();
    let rc;
    try {
      rc = mod.callMain(args);
    } catch (e) {
      if (e && e.name === 'ExitStatus') rc = e.status; else throw e;
    }
    const seconds = (performance.now() - t0) / 1000;
    postGrid();
    if (msg.preview) {
      post({ type: 'done', rc, seconds, files: [], preview: true });
      return;
    }
    postSummary(true);
    postRestart();
    const files = listFiles(OUT_DIR).map((p) => {
      const d = FS.readFile(OUT_DIR + '/' + p);
      return { path: p, data: d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) };
    });
    post({ type: 'done', rc, seconds, files }, files.map((f) => f.data));
  } catch (e) {
    post({ type: 'error', text: String(e && e.stack ? e.stack : e) });
  }
};
