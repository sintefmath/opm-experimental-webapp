// Wells from an Eclipse deck's SCHEDULE section (WELSPECS, COMPDAT, WCONPROD/WCONHIST/WCONINJE/
// WCONINJH), so they can be shown with the grid before a run. A lightweight reader, not a parser:
// only these keywords are interpreted; the simulation itself reports the exact wells per step.

/* exported parseDeckWells */

const DECK_SECTIONS = new Set(['RUNSPEC', 'GRID', 'EDIT', 'PROPS', 'REGIONS', 'SOLUTION', 'SUMMARY', 'SCHEDULE']);
const DECK_WELL_KEYWORDS = new Set(['WELSPECS', 'COMPDAT', 'WCONPROD', 'WCONHIST', 'WCONINJE', 'WCONINJH']);
const INJECTOR_TYPE = { WATER: 3, WAT: 3, GAS: 4, OIL: 2 };   // OPM's IWEL well type codes

function deckDir(path) { const i = path.lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i + 1); }

function deckNormalize(path) {
  const out = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return out.join('/');
}

// Index of the first '/' outside quotes, or -1; text after '--' outside quotes is a comment
function deckScan(line) {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === "'" || c === '"') quote = c;
    else if (c === '-' && line[i + 1] === '-') return { slash: -1, end: i };
    else if (c === '/') return { slash: i, end: i };
  }
  return { slash: -1, end: line.length };
}

// Record items with defaults (1*, 3*) expanded to null and repeats (2*0.5) expanded
function deckTokens(text) {
  const out = [];
  for (const m of text.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)) {
    if (m[3] === undefined) { out.push(m[1] ?? m[2]); continue; }
    const r = /^(\d*)\*(.*)$/.exec(m[3]);
    if (!r) { out.push(m[3]); continue; }
    for (let n = 0; n < (r[1] ? +r[1] : 1); n++) out.push(r[2] === '' ? null : r[2]);
  }
  return out;
}

// files: Map(path -> Uint8Array), deckPath: path of the .DATA file in it
// -> [{name, type, open, head: [i, j], conns: [[i, j, k, open], ...]}] (1-based, like readRestartWells)
function parseDeckWells(files, deckPath) {
  const decoder = new TextDecoder('latin1');
  const lower = new Map([...files.keys()].map((p) => [p.toLowerCase(), p]));
  const root = deckDir(deckPath);
  const wells = new Map();
  let section = '';

  const resolve = (name, from) => {
    for (const base of [root, deckDir(from)]) {
      const p = deckNormalize(base + name);
      if (files.has(p)) return p;
      if (lower.has(p.toLowerCase())) return lower.get(p.toLowerCase());
    }
    return null;
  };
  const matching = (pattern) => {
    if (!/[*?]/.test(pattern)) return wells.has(pattern) ? [wells.get(pattern)] : [];
    const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return [...wells.values()].filter((w) => re.test(w.name));
  };
  const record = (kw, t) => {
    if (!t[0]) return;
    if (kw === 'WELSPECS') {
      const w = wells.get(t[0]) || { name: t[0], type: 0, open: true, head: [0, 0], conns: new Map() };
      w.head = [+t[2] || w.head[0], +t[3] || w.head[1]];
      wells.set(t[0], w);
    } else if (kw === 'COMPDAT') {
      for (const w of matching(t[0])) {
        const i = +t[1] || w.head[0], j = +t[2] || w.head[1];
        const k1 = +t[3], k2 = +t[4] || k1;
        if (!(i > 0 && j > 0 && k1 > 0)) continue;
        const open = (t[5] || 'OPEN').toUpperCase() !== 'SHUT';
        for (let k = k1; k <= k2; k++) w.conns.set(`${i},${j},${k}`, [i, j, k, open]);
      }
    } else {
      const injector = kw === 'WCONINJE' || kw === 'WCONINJH';
      const type = injector ? INJECTOR_TYPE[(t[1] || '').toUpperCase()] || 0 : 1;
      for (const w of matching(t[0])) w.type = type;
    }
  };

  const visit = (path, depth) => {
    const text = decoder.decode(files.get(path));
    let kw = null;     // keyword whose records are being read
    let rec = '';
    for (const raw of text.split(/\r?\n/)) {
      const { slash, end } = deckScan(raw);
      const line = raw.slice(0, end);
      if (!kw || !rec.trim()) {
        const m = /^\s*([A-Z][A-Z0-9_]{0,7})\s*$/.exec(line);
        if (m && slash < 0) {
          kw = null;
          if (DECK_SECTIONS.has(m[1])) section = m[1];
          else if (m[1] === 'END') return;
          else if (m[1] === 'INCLUDE' || (section === 'SCHEDULE' && DECK_WELL_KEYWORDS.has(m[1]))) kw = m[1];
          continue;
        }
        if (!kw) continue;
      }
      if (slash < 0) { rec += ' ' + line; continue; }
      const t = deckTokens(rec + ' ' + line);
      rec = '';
      if (kw === 'INCLUDE') {
        kw = null;
        const p = t[0] && resolve(t[0], path);
        // grid and property includes can be large; only schedule includes (or small ones) can hold wells
        if (p && depth < 10 && (section === 'SCHEDULE' || files.get(p).byteLength < 2e6)) visit(p, depth + 1);
      } else if (!t.length) {
        kw = null;   // an empty record ends the keyword
      } else {
        record(kw, t);
      }
    }
  };

  if (files.has(deckPath)) visit(deckPath, 0);
  return [...wells.values()].map((w) => ({ ...w, conns: [...w.conns.values()] }));
}

if (typeof self !== 'undefined') self.parseDeckWells = parseDeckWells;
