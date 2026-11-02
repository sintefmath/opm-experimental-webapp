// 3D viewer for corner-point grids with per-cell coloring, IJK clipping and thresholding.
import * as THREE from 'three';
import { OrbitControls } from './lib/OrbitControls.js';

// Viridis-like colormap stops
const CMAP = [
  [0.267, 0.005, 0.329], [0.283, 0.141, 0.458], [0.254, 0.265, 0.530], [0.207, 0.372, 0.553],
  [0.164, 0.471, 0.558], [0.128, 0.567, 0.551], [0.135, 0.659, 0.518], [0.267, 0.749, 0.441],
  [0.478, 0.821, 0.318], [0.741, 0.873, 0.150], [0.993, 0.906, 0.144],
];

export function colormap(t, out, o) {
  if (!(t >= 0)) t = 0; else if (t > 1) t = 1;
  const x = t * (CMAP.length - 1);
  const i = Math.min(CMAP.length - 2, Math.floor(x));
  const f = x - i;
  for (let c = 0; c < 3; c++) out[o + c] = CMAP[i][c] * (1 - f) + CMAP[i + 1][c] * f;
}

export function colormapCss(t) {
  const c = [0, 0, 0];
  colormap(t, c, 0);
  return `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
}

// Well colors by OPM's IWEL type code (1 producer, 2 oil, 3 water, 4 gas injector); shut wells grey
export const WELL_COLORS = { 0: '#9ca3af', 1: '#16a34a', 2: '#f59e0b', 3: '#2563eb', 4: '#dc2626', shut: '#9ca3af' };
export const WELL_TYPES = { 0: 'no type', 1: 'producer', 2: 'oil injector', 3: 'water injector', 4: 'gas injector' };

// Corner order within a cell: bit0 = +I, bit1 = +J, bit2 = bottom (+K)
const FACES = [
  { corners: [0, 2, 6, 4], dir: 0, side: 0 },  // -I
  { corners: [1, 5, 7, 3], dir: 0, side: 1 },  // +I
  { corners: [0, 4, 5, 1], dir: 1, side: 0 },  // -J
  { corners: [2, 3, 7, 6], dir: 1, side: 1 },  // +J
  { corners: [0, 1, 3, 2], dir: 2, side: 0 },  // top
  { corners: [4, 6, 7, 5], dir: 2, side: 1 },  // bottom
];

export class GridViewer {
  constructor(container, onHover) {
    this.container = container;
    this.onHover = onHover;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 1e7);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener('change', () => this.render());
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(0.4, 1, 0.6);
    this.camera.add(sun);
    this.scene.add(this.camera);
    this.material = new THREE.MeshLambertMaterial({
      vertexColors: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    this.edgeMaterial = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 });
    this.mesh = null;
    this.edges = null;
    this.grid = null;
    this.values = null;
    this.range = [0, 1];
    this.filter = null;
    this.zscale = 1;
    this.showEdges = true;
    this.wells = [];
    this.wellGroup = null;
    this.showWells = true;
    this.showWellNames = true;
    this.wellMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.connMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
    // overlays: well name labels and a compass that follows the camera
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'v3d-labels';
    container.appendChild(this.labelLayer);
    this.compass = document.createElement('div');
    this.compass.className = 'v3d-compass';
    this.compass.title = 'North';
    this.compass.innerHTML = `<svg viewBox="-50 -50 100 100" aria-hidden="true">
      <circle r="46" class="ring"/>
      <path d="M0 -29 L9 0 L-9 0 Z" class="north"/><path d="M0 29 L9 0 L-9 0 Z" class="south"/>
      <text y="-32" class="lbl">N</text><text y="44" class="lbl">S</text></svg>`;
    container.appendChild(this.compass);
    this.north = new THREE.Vector3(0, 0, -1);
    this.raycaster = new THREE.Raycaster();
    new ResizeObserver(() => this.resize()).observe(container);
    this.renderer.domElement.addEventListener('pointermove', (e) => this.pick(e));
    this.resize();
  }

  setBackground(css) {
    this.scene.background = new THREE.Color(css);
    this.render();
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
    this.updateCompass();
    this.updateLabels();
  }

  // Rotate the compass so N points along the projection of the grid's north on the screen,
  // tilted like the ground plane
  updateCompass() {
    const q = this.camera.quaternion;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    // the horizontal direction that appears as "up" on screen
    const screenUp = up.y < 0.999 ? up.setY(0) : fwd.setY(0);
    if (screenUp.lengthSq() < 1e-12) return;
    screenUp.normalize();
    const angle = Math.atan2(this.north.dot(right), this.north.dot(screenUp));
    // only a hint of the ground plane's tilt, so the letters stay readable
    const tilt = 0.5 * Math.min(this.controls.getPolarAngle(), 1.2);
    this.compass.style.transform = `perspective(240px) rotateX(${tilt}rad) rotate(${angle}rad)`;
  }

  updateLabels() {
    if (!this.wellLabels) return;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const v = new THREE.Vector3();
    for (const { el, pos } of this.wellLabels) {
      v.copy(pos).project(this.camera);
      const show = this.showWells && this.showWellNames && v.z < 1 && Math.abs(v.x) <= 1.05 && Math.abs(v.y) <= 1.05;
      el.style.display = show ? '' : 'none';
      if (show) el.style.transform = `translate(${(v.x + 1) / 2 * w}px, ${(1 - v.y) / 2 * h}px) translate(-50%, -100%)`;
    }
  }

  // grid: {nx, ny, nz, coord, zcorn, actnum}
  setGrid(grid) {
    const { nx, ny, nz, coord, zcorn, actnum } = grid;
    const n = nx * ny * nz;
    const g2a = new Int32Array(n).fill(-1);
    let nact = 0;
    for (let g = 0; g < n; g++) if (actnum[g] > 0) g2a[g] = nact++;
    const ijk = new Int32Array(nact * 3);
    const corners = new Float64Array(nact * 24);
    const nb = new Int32Array(nact * 6).fill(-1);       // neighbour active index per face
    const conform = new Uint8Array(nact * 6);           // neighbour shares the face geometry

    const zc = (i, j, k, c) => zcorn[2 * i + (c & 1) + 2 * nx * (2 * j + ((c >> 1) & 1)) +
                                     4 * nx * ny * (2 * k + (c >> 2))];
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const a = g2a[i + nx * (j + ny * k)];
      if (a < 0) continue;
      ijk[3 * a] = i; ijk[3 * a + 1] = j; ijk[3 * a + 2] = k;
      for (let c = 0; c < 8; c++) {
        const p = 6 * ((i + (c & 1)) + (nx + 1) * (j + ((c >> 1) & 1)));
        const z = zc(i, j, k, c);
        const x1 = coord[p], y1 = coord[p + 1], z1 = coord[p + 2];
        const x2 = coord[p + 3], y2 = coord[p + 4], z2 = coord[p + 5];
        const t = z2 !== z1 ? (z - z1) / (z2 - z1) : 0;
        corners[24 * a + 3 * c] = x1 + t * (x2 - x1);
        corners[24 * a + 3 * c + 1] = y1 + t * (y2 - y1);
        corners[24 * a + 3 * c + 2] = z;
      }
      // neighbours in -/+ I, J, K
      const d = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];
      for (let f = 0; f < 6; f++) {
        const ii = i + d[f][0], jj = j + d[f][1], kk = k + d[f][2];
        if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) continue;
        const b = g2a[ii + nx * (jj + ny * kk)];
        if (b < 0) continue;
        nb[6 * a + f] = b;
        // compare the shared corners' depths to detect faults / gaps
        const face = FACES[f];
        let same = true;
        for (const c of face.corners) {
          const bit = 1 << face.dir;
          const cn = c ^ bit;   // matching corner on the neighbour's opposite face
          if (Math.abs(zc(i, j, k, c) - zc(ii, jj, kk, cn)) > 1e-3) { same = false; break; }
        }
        conform[6 * a + f] = same ? 1 : 0;
      }
    }
    // centre coordinates for float32 precision
    let cx = 0, cy = 0, cz = 0;
    for (let a = 0; a < nact; a++) { cx += corners[24 * a]; cy += corners[24 * a + 1]; cz += corners[24 * a + 2]; }
    cx /= nact || 1; cy /= nact || 1; cz /= nact || 1;
    const c32 = new Float32Array(nact * 24);
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity, zmin = Infinity, zmax = -Infinity;
    for (let a = 0; a < nact * 8; a++) {
      const x = corners[3 * a] - cx, y = corners[3 * a + 1] - cy, z = corners[3 * a + 2] - cz;
      c32[3 * a] = x; c32[3 * a + 1] = y; c32[3 * a + 2] = z;
      xmin = Math.min(xmin, x); xmax = Math.max(xmax, x);
      ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
      zmin = Math.min(zmin, z); zmax = Math.max(zmax, z);
    }
    const horiz = Math.max(xmax - xmin, ymax - ymin), vert = Math.max(zmax - zmin, 1e-6);
    this.grid = { nx, ny, nz, nact, ijk, g2a, corners: c32, nb, conform, horiz, vert, zmin };
    // North in grid coordinates: MAPAXES [x1, y1, x0, y0, x2, y2] maps grid x/y axes to map coordinates
    let nxg = 0, nyg = 1;
    const m = grid.mapaxes;
    if (m && m.length === 6) {
      const ex = [m[4] - m[2], m[5] - m[3]], ey = [m[0] - m[2], m[1] - m[3]];
      const det = ex[0] * ey[1] - ey[0] * ex[1];
      if (Math.abs(det) > 1e-12) { nxg = -ey[0] / det; nyg = ex[0] / det; }
    }
    this.north = new THREE.Vector3(nxg, 0, -nyg).normalize();   // world Z = -grid y
    this.autoZScale = Math.max(1, Math.round(0.25 * horiz / vert));
    this.zscale = this.autoZScale;
    this.filter = null;
    this.values = null;
    this.rebuild();
    this.buildWells();
    this.resetView();
  }

  // log: color by log10 of the value (range given in raw values)
  setValues(values, range, log = false) {
    this.values = values;
    this.range = range;
    this.log = log && range[0] > 0;
    this.rebuild();
  }

  // {imin, imax, jmin, jmax, kmin, kmax (0-based inclusive), threshold: [lo, hi] | null}
  setFilter(filter) { this.filter = filter; this.rebuild(); }

  setZScale(s) { this.zscale = s; this.rebuild(); this.buildWells(); this.resetView(); }

  setShowEdges(on) { this.showEdges = on; if (this.edges) this.edges.visible = on; this.render(); }

  // wells: [{name, type, open, head: [i, j], conns: [[i, j, k, open], ...]}] with 1-based indices
  setWells(wells) { this.wells = wells || []; this.buildWells(); this.render(); }

  setShowWells(on) { this.showWells = on; if (this.wellGroup) this.wellGroup.visible = on; this.render(); }

  setShowWellNames(on) { this.showWellNames = on; this.render(); }

  // Centre of an active cell in unscaled grid coordinates [x, y, depth]
  cellCentre(a) {
    const c = this.grid.corners, p = [0, 0, 0];
    for (let n = 0; n < 8; n++) for (let d = 0; d < 3; d++) p[d] += c[24 * a + 3 * n + d] / 8;
    return p;
  }

  activeIndex(i, j, k) {
    const g = this.grid;
    if (i < 0 || j < 0 || k < 0 || i >= g.nx || j >= g.ny || k >= g.nz) return -1;
    return g.g2a[i + g.nx * (j + g.ny * k)];
  }

  // Well pipes (from above the reservoir down the head column, then through the connected cells),
  // a marker per connection, and a name label at the top
  buildWells() {
    if (this.wellGroup) {
      this.scene.remove(this.wellGroup);
      this.wellGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      this.wellGroup = null;
    }
    this.labelLayer.replaceChildren();
    this.wellLabels = [];
    this.wellPicks = null;
    this.wellMarkers = null;
    const g = this.grid;
    if (!g || !this.wells.length) return;
    const zs = this.zscale;
    const world = (p) => new THREE.Vector3(p[0], -p[2] * zs, -p[1]);
    const cell = Math.min(g.horiz / Math.max(g.nx, g.ny), g.horiz);
    const radius = Math.min(Math.max(0.18 * cell, 0.002 * g.horiz), 0.01 * g.horiz);
    const top = -g.zmin * zs + Math.max(0.06 * g.horiz, 0.15 * g.vert * zs);
    const tubes = [];         // [{a, b, color, well}]
    const markers = [];       // [{p, color, well, conn}]
    this.wells.forEach((w, wi) => {
      const conns = [];
      for (const c of w.conns) {
        const a = this.activeIndex(c[0] - 1, c[1] - 1, c[2] - 1);
        if (a >= 0) conns.push({ p: this.cellCentre(a), c });
      }
      // head column: top of its first active cell, else above the first connection
      let headTop = null;
      for (let k = 0; k < g.nz && !headTop; k++) {
        const a = this.activeIndex(w.head[0] - 1, w.head[1] - 1, k);
        if (a >= 0) {
          const p = this.cellCentre(a);
          let d = Infinity;
          for (let n = 0; n < 4; n++) d = Math.min(d, g.corners[24 * a + 3 * n + 2]);
          headTop = [p[0], p[1], d];
        }
      }
      if (!headTop && conns.length) headTop = [conns[0].p[0], conns[0].p[1], conns[0].p[2]];
      if (!headTop) return;
      // order connections along the well: nearest neighbour, starting closest to the head
      const path = [];
      let cur = headTop;
      const left = conns.slice();
      while (left.length) {
        let best = 0, bd = Infinity;
        left.forEach((q, n) => {
          const d = (q.p[0] - cur[0]) ** 2 + (q.p[1] - cur[1]) ** 2 + (q.p[2] - cur[2]) ** 2;
          if (d < bd) { bd = d; best = n; }
        });
        cur = left[best].p;
        path.push(left.splice(best, 1)[0]);
      }
      const color = new THREE.Color(w.open ? WELL_COLORS[w.type] || WELL_COLORS[0] : WELL_COLORS.shut);
      const pts = [new THREE.Vector3(headTop[0], top, -headTop[1]), world(headTop), ...path.map((q) => world(q.p))];
      for (let n = 0; n + 1 < pts.length; n++) tubes.push({ a: pts[n], b: pts[n + 1], color, well: wi });
      for (const q of path) {
        markers.push({ p: world(q.p), color: q.c[3] && w.open ? color : new THREE.Color(WELL_COLORS.shut), well: wi, conn: q.c });
      }
      const el = document.createElement('div');
      el.className = 'v3d-well-label';
      el.textContent = w.name;
      el.style.borderColor = '#' + color.getHexString();
      this.labelLayer.appendChild(el);
      this.wellLabels.push({ el, pos: pts[0] });
    });
    this.wellGroup = new THREE.Group();
    this.wellGroup.visible = this.showWells;
    if (tubes.length) this.wellGroup.add(this.tubeMesh(tubes, radius));
    if (markers.length) {
      const m = new THREE.InstancedMesh(new THREE.SphereGeometry(radius * 1.7, 12, 8), this.connMaterial, markers.length);
      const mat = new THREE.Matrix4();
      markers.forEach((q, n) => { m.setMatrixAt(n, mat.makeTranslation(q.p.x, q.p.y, q.p.z)); m.setColorAt(n, q.color); });
      this.wellGroup.add(m);
      this.wellMarkers = { mesh: m, markers };
    }
    this.scene.add(this.wellGroup);
  }

  // One mesh of open cylinders for all pipe segments, with the well index per triangle for picking
  tubeMesh(tubes, r) {
    const sides = 10;
    const pos = new Float32Array(tubes.length * sides * 6 * 3);
    const nrm = new Float32Array(pos.length);
    const col = new Float32Array(pos.length);
    const faceWell = new Int32Array(tubes.length * sides * 2);
    const axis = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3(), n0 = new THREE.Vector3();
    let q = 0, f = 0;
    for (const t of tubes) {
      axis.subVectors(t.b, t.a);
      if (axis.lengthSq() === 0) continue;
      axis.normalize();
      u.set(Math.abs(axis.y) < 0.9 ? 0 : 1, Math.abs(axis.y) < 0.9 ? 1 : 0, 0).cross(axis).normalize();
      v.crossVectors(axis, u);
      const ring = (s) => n0.copy(u).multiplyScalar(Math.cos(2 * Math.PI * s / sides))
        .addScaledVector(v, Math.sin(2 * Math.PI * s / sides)).clone();
      for (let s = 0; s < sides; s++) {
        const d0 = ring(s), d1 = ring(s + 1);
        const quad = [[t.a, d0], [t.b, d0], [t.b, d1], [t.a, d0], [t.b, d1], [t.a, d1]];
        for (const [p, d] of quad) {
          pos[3 * q] = p.x + r * d.x; pos[3 * q + 1] = p.y + r * d.y; pos[3 * q + 2] = p.z + r * d.z;
          nrm[3 * q] = d.x; nrm[3 * q + 1] = d.y; nrm[3 * q + 2] = d.z;
          col[3 * q] = t.color.r; col[3 * q + 1] = t.color.g; col[3 * q + 2] = t.color.b;
          q++;
        }
        faceWell[f++] = t.well; faceWell[f++] = t.well;
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, 3 * q), 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(nrm.subarray(0, 3 * q), 3));
    geom.setAttribute('color', new THREE.BufferAttribute(col.subarray(0, 3 * q), 3));
    const mesh = new THREE.Mesh(geom, this.wellMaterial);
    this.wellPicks = { mesh, faceWell };
    return mesh;
  }

  cellVisible(a) {
    const g = this.grid, f = this.filter;
    if (f) {
      const i = g.ijk[3 * a], j = g.ijk[3 * a + 1], k = g.ijk[3 * a + 2];
      if (i < f.imin || i > f.imax || j < f.jmin || j > f.jmax || k < f.kmin || k > f.kmax) return false;
      if (f.threshold && this.values) {
        const v = this.values[a];
        if (!(v >= f.threshold[0] && v <= f.threshold[1])) return false;
      }
    }
    return true;
  }

  rebuild() {
    const g = this.grid;
    if (!g) return;
    const vis = new Uint8Array(g.nact);
    for (let a = 0; a < g.nact; a++) vis[a] = this.cellVisible(a) ? 1 : 0;
    let nf = 0;
    for (let a = 0; a < g.nact; a++) {
      if (!vis[a]) continue;
      for (let f = 0; f < 6; f++) {
        const b = g.nb[6 * a + f];
        if (b < 0 || !vis[b] || !g.conform[6 * a + f]) nf++;
      }
    }
    const pos = new Float32Array(nf * 18);
    const col = new Float32Array(nf * 18);
    const epos = new Float32Array(nf * 24);
    const faceCell = new Int32Array(nf * 2);
    const vals = this.values;
    const log = this.log;
    const lo = log ? Math.log10(this.range[0]) : this.range[0];
    const hi = log ? Math.log10(this.range[1]) : this.range[1];
    const inv = hi > lo ? 1 / (hi - lo) : 0;
    const rgb = [0, 0, 0];
    const zs = this.zscale;
    // world: X = east, Y = up (-depth), Z = -north
    const put = (arr, o, a, c) => {
      const p = 24 * a + 3 * c;
      arr[o] = g.corners[p];
      arr[o + 1] = -g.corners[p + 2] * zs;
      arr[o + 2] = -g.corners[p + 1];
    };
    let q = 0;
    for (let a = 0; a < g.nact; a++) {
      if (!vis[a]) continue;
      if (vals) {
        const v = vals[a];
        if (Number.isFinite(v)) colormap(((log ? Math.log10(v) : v) - lo) * inv, rgb, 0);
        else { rgb[0] = rgb[1] = rgb[2] = 0.6; }
      } else { rgb[0] = 0.55; rgb[1] = 0.65; rgb[2] = 0.78; }
      for (let f = 0; f < 6; f++) {
        const b = g.nb[6 * a + f];
        if (!(b < 0 || !vis[b] || !g.conform[6 * a + f])) continue;
        const c = FACES[f].corners;
        const tri = [c[0], c[1], c[2], c[0], c[2], c[3]];
        for (let t = 0; t < 6; t++) {
          put(pos, q * 18 + 3 * t, a, tri[t]);
          col[q * 18 + 3 * t] = rgb[0]; col[q * 18 + 3 * t + 1] = rgb[1]; col[q * 18 + 3 * t + 2] = rgb[2];
        }
        const e = [c[0], c[1], c[1], c[2], c[2], c[3], c[3], c[0]];
        for (let t = 0; t < 8; t++) put(epos, q * 24 + 3 * t, a, e[t]);
        faceCell[2 * q] = faceCell[2 * q + 1] = a;
        q++;
      }
    }
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); }
    if (this.edges) { this.scene.remove(this.edges); this.edges.geometry.dispose(); }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geom.computeVertexNormals();
    this.mesh = new THREE.Mesh(geom, this.material);
    this.faceCell = faceCell;
    this.scene.add(this.mesh);
    const egeom = new THREE.BufferGeometry();
    egeom.setAttribute('position', new THREE.BufferAttribute(epos, 3));
    this.edges = new THREE.LineSegments(egeom, this.edgeMaterial);
    this.edges.visible = this.showEdges;
    this.scene.add(this.edges);
    this.visibleCells = vis.reduce((s, v) => s + v, 0);
    this.render();
  }

  resetView() {
    const g = this.grid;
    if (!g) return;
    const box = new THREE.Box3();
    const p = g.corners;
    for (let i = 0; i < p.length; i += 3) {
      box.expandByPoint(new THREE.Vector3(p[i], -p[i + 2] * this.zscale, -p[i + 1]));
    }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    this.controls.target.copy(center);
    // fit the bounding sphere for both the vertical and horizontal field of view
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const dist = 0.5 * size / Math.tan(fov / 2) * Math.max(1, 1 / this.camera.aspect);
    this.camera.position.copy(center).add(new THREE.Vector3(0.6, 0.55, 0.9).normalize().multiplyScalar(dist));
    this.camera.near = size / 1000;
    this.camera.far = size * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.render();
  }

  pick(e) {
    if (!this.mesh || !this.onHover) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    const m = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(m, this.camera);
    const targets = [this.mesh];
    if (this.wellGroup && this.showWells) targets.push(...this.wellGroup.children);
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    if (!hit) { this.onHover(null); return; }
    if (this.wellPicks && hit.object === this.wellPicks.mesh) {
      this.onHover({ well: this.wells[this.wellPicks.faceWell[hit.faceIndex]] });
      return;
    }
    if (this.wellMarkers && hit.object === this.wellMarkers.mesh) {
      const q = this.wellMarkers.markers[hit.instanceId];
      this.onHover({ well: this.wells[q.well], conn: q.conn });
      return;
    }
    const a = this.faceCell[hit.faceIndex];
    const g = this.grid;
    this.onHover({ cell: a, i: g.ijk[3 * a] + 1, j: g.ijk[3 * a + 1] + 1, k: g.ijk[3 * a + 2] + 1,
                   value: this.values ? this.values[a] : undefined });
  }
}
