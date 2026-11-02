// Minimal readers for unformatted (binary, big-endian) Eclipse files as written by
// OPM Flow: summary (.SMSPEC/.UNSMRY), grid (.EGRID), init (.INIT), restart (.UNRST).

/* exported scanEclFile, readEclArray, readEclFile, readSummary, readGrid, readInit,
            indexRestart, readRestartStep, readRestartWells */

const ECL_TYPES = {
  INTE: [4, 1000], REAL: [4, 1000], LOGI: [4, 1000], DOUB: [8, 1000], CHAR: [8, 105], MESS: [0, 1],
};

function eclTypeInfo(type) {
  if (ECL_TYPES[type]) return ECL_TYPES[type];
  if (type.startsWith('C0')) return [parseInt(type.slice(1), 10), 105];
  throw new Error('Unknown Eclipse data type ' + type);
}

function toU8(buf) { return buf instanceof Uint8Array ? buf : new Uint8Array(buf); }

// List the arrays in a file without decoding them:
// [{name, type, count, offset, end}] where offset is the first data record.
// Stops quietly at a truncated array (file still being written).
function scanEclFile(buf, start = 0) {
  const u8 = toU8(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const dec = new TextDecoder('latin1');
  const out = [];
  let pos = start;
  while (pos + 24 <= u8.byteLength) {
    if (dv.getInt32(pos, false) !== 16) break;
    const name = dec.decode(u8.subarray(pos + 4, pos + 12)).trim();
    const count = dv.getInt32(pos + 12, false);
    const type = dec.decode(u8.subarray(pos + 16, pos + 20));
    const [elemSize, blockSize] = eclTypeInfo(type);
    const offset = pos + 24;
    let p = offset;
    let left = count;
    let ok = true;
    while (left > 0 && elemSize > 0) {
      if (p + 4 > u8.byteLength) { ok = false; break; }
      const len = dv.getInt32(p, false);
      p += 8 + len;
      if (p > u8.byteLength) { ok = false; break; }
      left -= Math.min(blockSize, left);
    }
    if (!ok) break;
    out.push({ name, type, count, offset, end: p });
    pos = p;
  }
  return out;
}

// Decode one array found by scanEclFile.
function readEclArray(buf, e) {
  const u8 = toU8(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const [elemSize, blockSize] = eclTypeInfo(e.type);
  const t = e.type;
  let data;
  if (t === 'INTE' || t === 'LOGI') data = new Int32Array(e.count);
  else if (t === 'REAL') data = new Float32Array(e.count);
  else if (t === 'DOUB') data = new Float64Array(e.count);
  else data = new Array(e.count);
  const dec = new TextDecoder('latin1');
  let pos = e.offset;
  let read = 0;
  while (read < e.count) {
    const start = pos + 4;
    const n = Math.min(blockSize, e.count - read);
    for (let i = 0; i < n; i++) {
      const off = start + i * elemSize;
      if (t === 'INTE' || t === 'LOGI') data[read + i] = dv.getInt32(off, false);
      else if (t === 'REAL') data[read + i] = dv.getFloat32(off, false);
      else if (t === 'DOUB') data[read + i] = dv.getFloat64(off, false);
      else data[read + i] = dec.decode(u8.subarray(off, off + elemSize)).trim();
    }
    pos = start + dv.getInt32(pos, false) + 4;
    read += n;
  }
  return data;
}

// Parse a whole file into [{name, type, data}].
function readEclFile(buf) {
  return scanEclFile(buf).map((e) => ({ name: e.name, type: e.type, data: readEclArray(buf, e) }));
}

// Combine SMSPEC + UNSMRY into {time: Float64Array (days), vectors: {key: Float64Array}, units}
function readSummary(smspecBuf, unsmryBuf) {
  const spec = readEclFile(smspecBuf);
  const get = (n) => { const r = spec.find((x) => x.name === n); return r ? r.data : null; };
  const keywords = get('KEYWORDS');
  const names = get('NAMES') || get('WGNAMES');
  const nums = get('NUMS');
  const units = get('UNITS');
  if (!keywords) throw new Error('SMSPEC without KEYWORDS');

  const keys = keywords.map((kw, i) => {
    const wg = names ? names[i] : '';
    const num = nums ? nums[i] : 0;
    const c = kw[0];
    if (kw === 'TIME' || kw === 'DAY' || kw === 'MONTH' || kw === 'YEAR' || kw === 'YEARS') return kw;
    if ((c === 'W' || c === 'G') && wg && wg !== ':+:+:+:+') return kw + ':' + wg;
    if ((c === 'B' || c === 'R' || c === 'C') && num > 0) return kw + ':' + (c === 'C' ? wg + ':' : '') + num;
    if (c === 'F') return kw;
    return null;
  });

  const rows = [];
  for (const e of scanEclFile(unsmryBuf)) {
    if (e.name === 'PARAMS') rows.push(readEclArray(unsmryBuf, e));
  }
  const timeIdx = keywords.indexOf('TIME');
  const vectors = {};
  const unitMap = {};
  keys.forEach((k, i) => {
    if (!k || k in vectors) return;
    const v = new Float64Array(rows.length);
    for (let t = 0; t < rows.length; t++) v[t] = rows[t][i];
    vectors[k] = v;
    unitMap[k] = units ? units[i] : '';
  });
  const time = timeIdx >= 0 ? vectors.TIME : Float64Array.from(rows, (_, i) => i);
  return { time, vectors, units: unitMap };
}

// Main grid from an EGRID file: {nx, ny, nz, coord, zcorn, actnum, mapaxes?}
function readGrid(buf) {
  const grid = {};
  for (const e of scanEclFile(buf)) {
    if (e.name === 'ENDGRID') break;   // ignore LGRs
    if (e.name === 'MAPAXES') {
      grid.mapaxes = Array.from(readEclArray(buf, e));
    } else if (e.name === 'GRIDHEAD') {
      const h = readEclArray(buf, e);
      grid.nx = h[1]; grid.ny = h[2]; grid.nz = h[3];
    } else if (e.name === 'COORD' || e.name === 'ZCORN' || e.name === 'ACTNUM') {
      grid[e.name.toLowerCase()] = readEclArray(buf, e);
    }
  }
  if (!grid.coord || !grid.zcorn) throw new Error('EGRID without COORD/ZCORN');
  if (!grid.actnum) grid.actnum = new Int32Array(grid.nx * grid.ny * grid.nz).fill(1);
  return grid;
}

// Per-cell static properties from an INIT file: {NAME: Float32Array(nactive)}
function readInit(buf, nactive, actnum) {
  const props = {};
  const skip = new Set(['TRANX', 'TRANY', 'TRANZ', 'TRANNNC', 'ENDNUM', 'IMBNUM']);
  for (const e of scanEclFile(buf)) {
    if (skip.has(e.name) || e.name.startsWith('MULT') || e.name.startsWith('TAB')) continue;
    if (e.type !== 'REAL' && e.type !== 'DOUB' && e.type !== 'INTE') continue;
    if (e.count === nactive) {
      props[e.name] = Float32Array.from(readEclArray(buf, e));
    } else if (actnum && e.count === actnum.length) {
      const all = readEclArray(buf, e);
      const v = new Float32Array(nactive);
      for (let g = 0, a = 0; g < all.length; g++) if (actnum[g] > 0) v[a++] = all[g];
      props[e.name] = v;
    }
  }
  return props;
}

// Report steps in a UNRST file: [{seqnum, date: [d, m, y], arrays: [entry...], wellArrays: {NAME: entry}}]
function indexRestart(buf, start = 0) {
  const steps = [];
  let cur = null;
  let inSol = false;
  for (const e of scanEclFile(buf, start)) {
    if (e.name === 'SEQNUM') {
      cur = { seqnum: readEclArray(buf, e)[0], start: e.offset - 24, date: null, arrays: [], wellArrays: {},
              complete: false };
      steps.push(cur);
    } else if (!cur) {
      continue;
    } else if (e.name === 'INTEHEAD') {
      const h = readEclArray(buf, e);
      cur.date = [h[64], h[65], h[66]];
      cur.wellArrays.INTEHEAD = e;
    } else if (!inSol && (e.name === 'IWEL' || e.name === 'ZWEL' || e.name === 'ICON')) {
      cur.wellArrays[e.name] = e;
    } else if (e.name === 'STARTSOL') {
      inSol = true;
    } else if (e.name === 'ENDSOL') {
      inSol = false;
      cur.complete = true;
      cur.end = e.end;
    } else if (inSol && (e.type === 'REAL' || e.type === 'DOUB')) {
      cur.arrays.push(e);
    }
  }
  return steps.filter((s) => s.complete);
}

// Solution arrays of one indexed step: {NAME: Float32Array(nactive)}; adds SOIL when possible
function readRestartStep(buf, step, nactive) {
  const out = {};
  for (const e of step.arrays) {
    if (e.count === nactive) out[e.name] = Float32Array.from(readEclArray(buf, e));
  }
  if (!out.SOIL && (out.SWAT || out.SGAS)) {
    const s = new Float32Array(nactive);
    for (let i = 0; i < nactive; i++) s[i] = 1 - (out.SWAT ? out.SWAT[i] : 0) - (out.SGAS ? out.SGAS[i] : 0);
    out.SOIL = s;
  }
  return out;
}

// Wells of one indexed step: [{name, type, open, head: [i, j], conns: [[i, j, k, open], ...]}],
// 1-based indices; type 1 = producer, 2 = oil, 3 = water, 4 = gas injector (OPM's IWEL codes)
function readRestartWells(buf, step) {
  const w = step.wellArrays || {};
  if (!w.INTEHEAD || !w.IWEL || !w.ZWEL || !w.ICON) return [];
  const h = readEclArray(buf, w.INTEHEAD);
  const nwells = h[16], ncwmax = h[17], niwelz = h[24], nzwelz = h[27], niconz = h[32];
  const iwel = readEclArray(buf, w.IWEL), zwel = readEclArray(buf, w.ZWEL), icon = readEclArray(buf, w.ICON);
  const wells = [];
  for (let n = 0; n < nwells; n++) {
    const o = n * niwelz;
    const conns = [];
    for (let c = 0; c < Math.min(iwel[o + 4], ncwmax); c++) {
      const q = (n * ncwmax + c) * niconz;
      if (icon[q + 1] > 0 && icon[q + 2] > 0 && icon[q + 3] > 0) {
        conns.push([icon[q + 1], icon[q + 2], icon[q + 3], icon[q + 5] > 0]);
      }
    }
    // status: 1 open, 3 auto, 0 stop, -1000 shut
    wells.push({ name: zwel[n * nzwelz], type: iwel[o + 6], open: iwel[o + 10] > 0,
                 head: [iwel[o], iwel[o + 1]], conns });
  }
  return wells;
}

if (typeof self !== 'undefined') {
  Object.assign(self, { scanEclFile, readEclArray, readEclFile, readSummary, readGrid, readInit,
                        indexRestart, readRestartStep, readRestartWells });
}
