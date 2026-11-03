// Real-photo checkpoint buildings for SCHOOL SE GHAR TAK (track 'brightday'):
// Shangri La, ADDA (Rose Wood Residency), Vidhi Collection, Bright Day School and Petal Trillium.
//
// Each landmark is real low-poly geometry with roughly the real proportions; the user's photos (processed by
// assets-src/process_photos.py into public/photos/: rectified, cleaned, colour graded to the game palette,
// painterly-smoothed) are used only where they belong: sign boards, sign walls, shopfronts, facade panels.
// Surrounding geometry uses colours sampled from the processed photos so the photo edges blend, and planters,
// hedges, trees, steps and frames hide the photo borders.
//
// API (see the report in the header of buildPhotoLandmark):
//   PHOTO_LANDMARKS            Set of landmark ids handled here
//   PHOTO_FOOTPRINT[id]        { width, depth, setback }  -> world: this._placeSide(lm, width, depth, setback)
//   buildPhotoLandmark(id,ctx) -> { id, group, width, depth, setback, trees, triangles, drawCalls, dispose() }
//   preloadPhotoTextures(ids?) -> Promise (optional: start fetching the photos early)
//   disposePhotoTextures()     frees every cached photo texture (they reload on demand)
import * as THREE from 'three';

export const PHOTO_LANDMARKS = new Set(['shangrila', 'adda', 'vidhi', 'brightday', 'petals']);

// footprint along the road (width, local x) and away from it (depth, local z); setback = gap road edge -> front
// (setback must stay >= 5.6: _placeSide only accepts a footprint whose every point is >= hw + 5.6 from the road)
export const PHOTO_FOOTPRINT = {
  shangrila: { width: 46, depth: 40, setback: 6.0 },
  adda: { width: 40, depth: 32, setback: 6.0 },
  vidhi: { width: 30, depth: 22, setback: 6.0 },
  brightday: { width: 66, depth: 30, setback: 6.0 },
  petals: { width: 58, depth: 48, setback: 6.0 },
};

const BASE = ((typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || '/') + 'photos/';

// photo files per landmark ({ tile: metres per repeat } for tiling materials)
const FILES = {
  shangrila: ['shangrila-wall.jpg', 'shangrila-granite.jpg'],
  adda: ['adda-sign.jpg', 'adda-balcony.jpg', 'adda-cabin.jpg', 'adda-brick.jpg'],
  vidhi: ['vidhi-front.jpg', 'vidhi-board.jpg', 'vidhi-apollo.jpg'],
  brightday: ['brightday-facade.jpg', 'brightday-sign.jpg'],
  petals: ['petals-letters.webp', 'petals-market.jpg', 'petals-canopy.jpg', 'petals-glass.jpg'],
};
const TILING = new Set(['shangrila-granite.jpg', 'adda-brick.jpg', 'petals-canopy.jpg']);
// average colour of each photo, used until it has loaded (and to colour the geometry around it)
const AVG = {
  'shangrila-wall.jpg': '#868783', 'shangrila-granite.jpg': '#8f9493', 'adda-sign.jpg': '#a08a76', 'adda-balcony.jpg': '#8a8a60',
  'adda-cabin.jpg': '#9a978d', 'adda-brick.jpg': '#dd9271', 'vidhi-front.jpg': '#7e7a6c', 'vidhi-board.jpg': '#bea9b0',
  'vidhi-apollo.jpg': '#3a9a9a', 'brightday-facade.jpg': '#a9aaa2', 'brightday-sign.jpg': '#b5b2a8', 'petals-letters.webp': '#ece4c0',
  'petals-market.jpg': '#e0d8d6', 'petals-canopy.jpg': '#4f4832', 'petals-glass.jpg': '#343936',
};

// ---------------------------------------------------------------- texture cache
const TEX = new Map(); // file -> { tex, ready, waiters: [] }
let ANISO = 4;
function photo(file) {
  let e = TEX.get(file);
  if (e) return e;
  e = { tex: null, ready: false, waiters: [] };
  TEX.set(file, e);
  const loader = new THREE.TextureLoader();
  e.tex = loader.load(BASE + file, (t) => {
    e.ready = true;
    t.needsUpdate = true;
    for (const fn of e.waiters.splice(0)) fn(t);
  }, undefined, (err) => console.warn('[photoLandmarks] cannot load', file, err));
  const t = e.tex;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = ANISO;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  if (TILING.has(file)) { t.wrapS = t.wrapT = THREE.RepeatWrapping; } else { t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; }
  return e;
}

export function preloadPhotoTextures(ids = [...PHOTO_LANDMARKS]) {
  const ps = [];
  for (const id of ids) for (const f of FILES[id] || []) {
    const e = photo(f);
    ps.push(e.ready ? Promise.resolve() : new Promise((res) => { e.waiters.push(res); setTimeout(res, 15000); }));
  }
  return Promise.all(ps);
}

export function disposePhotoTextures() {
  for (const e of TEX.values()) e.tex?.dispose();
  TEX.clear();
}

// ---------------------------------------------------------------- merge kit
const C = new Map();
const col = (c) => {
  if (c instanceof THREE.Color) return c;
  let v = C.get(c);
  if (!v) {
    // keep albedo <= ~0.85 (sRGB) so big pale surfaces don't bloom out under the game's grade
    v = new THREE.Color(c);
    const mx = Math.max(v.r, v.g, v.b);
    if (mx > 0.62) v.multiplyScalar(0.62 / mx);
    C.set(c, v);
  }
  return v;
};
// photo quads carry white vertex colours, which col() clamps to 0.62; this material gain brings the photo back to
// x0.86 of its texel values so its brightest whites stay below the bloom threshold
const PHOTO_GAIN = 0.86 / 0.62;
const UV01 = [[0, 0], [1, 0], [1, 1], [0, 1]];
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _n = new THREE.Vector3(), _m = new THREE.Matrix4();
const GEO = {};
const geoCache = (k, make) => GEO[k] || (GEO[k] = ((g) => { if (!g.index) return g; const n = g.toNonIndexed(); g.dispose(); return n; })(make()));

class Kit {
  constructor() {
    this.B = new Map();
    this.M = new THREE.Matrix4();
    this.stack = [];
    this.tris = 0;
  }
  buf(name) {
    let b = this.B.get(name);
    if (!b) { b = { p: [], n: [], c: [], u: [] }; this.B.set(name, b); }
    return b;
  }
  push(m) { this.stack.push(this.M.clone()); this.M.multiply(m); return this; }
  pop() { this.M.copy(this.stack.pop()); return this; }
  at(x, y, z, ry = 0, s = 1) {
    return this.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(s, s, s)));
  }
  // triangle in the current frame (points as [x,y,z]); flat normal
  tri(name, a, b, c, color, ua = [0, 0], ub = [0, 0], uc = [0, 0]) {
    const B = this.buf(name);
    _a.fromArray(a).applyMatrix4(this.M); _b.fromArray(b).applyMatrix4(this.M); _c.fromArray(c).applyMatrix4(this.M);
    _n.crossVectors(_e1.subVectors(_b, _a), _e2.subVectors(_c, _a)).normalize();
    const k = col(color);
    for (const [v, uv] of [[_a, ua], [_b, ub], [_c, uc]]) {
      B.p.push(v.x, v.y, v.z); B.n.push(_n.x, _n.y, _n.z); B.c.push(k.r, k.g, k.b); B.u.push(uv[0], uv[1]);
    }
    this.tris++;
  }
  // quad a,b,c,d counter-clockwise seen from the front (BL, BR, TR, TL); optional per-corner colours
  quad(name, a, b, c, d, color, uv = UV01, cols = null) {
    if (cols) {
      this.tri(name, a, b, c, cols[0], uv[0], uv[1], uv[2]);
      this.tri(name, a, c, d, cols[0], uv[0], uv[2], uv[3]);
      const B = this.buf(name), n = B.c.length;
      // per-vertex colours: a b c / a c d
      const ks = [cols[0], cols[1], cols[2], cols[0], cols[2], cols[3]].map(col);
      for (let i = 0; i < 6; i++) { B.c[n - 18 + i * 3] = ks[i].r; B.c[n - 18 + i * 3 + 1] = ks[i].g; B.c[n - 18 + i * 3 + 2] = ks[i].b; }
      return;
    }
    this.tri(name, a, b, c, color, uv[0], uv[1], uv[2]);
    this.tri(name, a, c, d, color, uv[0], uv[2], uv[3]);
  }
  // vertical rectangle facing +z at depth z: x0..x1, y0..y1, uv rect [u0,v0,u1,v1]
  face(name, x0, x1, y0, y1, z, color = '#ffffff', uv = [0, 0, 1, 1], cols = null) {
    const [u0, v0, u1, v1] = uv;
    this.quad(name, [x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], color, [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], cols);
  }
  // axis-aligned box: centre x/z, bottom y. o.skip: letters of faces to leave out (f b l r t d), default 'd' for boxes on the ground.
  // o.tile = metres per texture repeat (planar uv per face); o.top / o.side colours; o.ry yaw about its centre.
  box(name, x, y, z, w, h, d, color, o = {}) {
    const skip = o.skip ?? (y > 0.05 ? '' : 'd'); // raised boxes keep their underside (seen from the low chase cam)
    if (o.ry) { this.at(x, y, z, o.ry); this.box(name, 0, 0, 0, w, h, d, color, { ...o, ry: 0, skip: o.skip ?? (y > 0.05 ? '' : 'd') }); this.pop(); return; }
    const x0 = x - w / 2, x1 = x + w / 2, y0 = y, y1 = y + h, z0 = z - d / 2, z1 = z + d / 2;
    const t = o.tile || 0;
    const uv = (pu0, pv0, pu1, pv1) => (t ? [[pu0 / t, pv0 / t], [pu1 / t, pv0 / t], [pu1 / t, pv1 / t], [pu0 / t, pv1 / t]] : UV01);
    const cs = o.side || color, ct = o.top || color;
    if (!skip.includes('f')) this.quad(name, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], color, uv(x0, y0, x1, y1));
    if (!skip.includes('b')) this.quad(name, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], cs, uv(-x1, y0, -x0, y1));
    if (!skip.includes('r')) this.quad(name, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], cs, uv(-z1, y0, -z0, y1));
    if (!skip.includes('l')) this.quad(name, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], cs, uv(z0, y0, z1, y1));
    if (!skip.includes('t')) this.quad(name, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], ct, uv(x0, -z1, x1, -z0));
    if (!skip.includes('d')) this.quad(name, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], cs, uv(x0, z0, x1, z1));
  }
  // any three.js geometry (positions, normals, uvs) placed by matrix m in the current frame
  geo(name, g, m, color) {
    const B = this.buf(name);
    const full = _m.multiplyMatrices(this.M, m);
    const nm = new THREE.Matrix3().getNormalMatrix(full);
    const src = g.index ? g.toNonIndexed() : g;
    const P = src.attributes.position, N = src.attributes.normal, U = src.attributes.uv;
    const k = col(color);
    for (let i = 0; i < P.count; i++) {
      _a.fromBufferAttribute(P, i).applyMatrix4(full);
      _n.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
      B.p.push(_a.x, _a.y, _a.z); B.n.push(_n.x, _n.y, _n.z); B.c.push(k.r, k.g, k.b);
      B.u.push(U ? U.getX(i) : 0, U ? U.getY(i) : 0);
    }
    this.tris += P.count / 3;
    if (src !== g) src.dispose();
  }
  // cylinder between two points; taper = top radius / bottom radius
  beam(name, a, b, r, color, seg = 6, taper = 1) {
    const g = geoCache(`cyl${seg}_${taper.toFixed(3)}`, () => new THREE.CylinderGeometry(taper, 1, 1, seg, 1, false).translate(0, 0.5, 0));
    _a.fromArray(a); _b.fromArray(b);
    const len = _a.distanceTo(_b) || 0.001;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), _c.subVectors(_b, _a).normalize());
    this.geo(name, g, new THREE.Matrix4().compose(_a.clone(), q, new THREE.Vector3(r, len, r)), color);
  }
  cyl(name, x, y, z, r, h, color, seg = 10) { this.beam(name, [x, y, z], [x, y + h, z], r, color, seg); }
  blob(name, x, y, z, r, color, sy = 0.8, detail = 0) {
    const g = geoCache('ico' + detail, () => new THREE.IcosahedronGeometry(1, detail));
    this.geo(name, g, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, x * 1.7 + z, 0)), new THREE.Vector3(r, r * sy, r)), color);
  }
  ellipse(name, x, y, z, a, b, color = '#ffffff', seg = 40) {
    const g = geoCache('circ' + seg, () => new THREE.CircleGeometry(1, seg));
    this.geo(name, g, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(a, b, 1)), color);
  }
}

// ---------------------------------------------------------------- shared props
const GREENS = ['#4f7a2c', '#5c8a32', '#3f6a28', '#62903a', '#46742a'];
function bushRow(K, x0, x1, z, y, h = 1, step = 1.1, seed = 0) {
  for (let x = x0, k = seed; x <= x1 + 1e-6; x += step, k++) {
    const r = 0.62 + ((k * 37) % 7) * 0.05;
    K.blob('std', x, y + r * 0.55 * h, z + ((k * 13) % 5 - 2) * 0.06, r, GREENS[k % GREENS.length], 0.78 * h);
  }
}
function planter(K, x, z, w, d, h, color = '#6f6d68', bush = true, seed = 0) {
  K.box('std', x, 0, z, w, h, d, color, { top: '#5b4a36' });
  if (bush) bushRow(K, x - w / 2 + 0.55, x + w / 2 - 0.55, z, h, 1.05, Math.max(0.8, Math.min(1.2, w / Math.max(1, Math.round(w / 1.1)))), seed);
}
function railing(K, x0, x1, y, z, h = 1.0, color = '#cfd3d6', step = 1.4, name = 'metal') {
  K.box(name, (x0 + x1) / 2, y + h - 0.06, z, x1 - x0, 0.06, 0.06, color);
  K.box(name, (x0 + x1) / 2, y + h * 0.5, z, x1 - x0, 0.04, 0.04, color);
  const n = Math.max(1, Math.round((x1 - x0) / step));
  for (let k = 0; k <= n; k++) K.box(name, x0 + ((x1 - x0) * k) / n, y, z, 0.05, h, 0.05, color, { skip: 'dt' });
}
// own low-poly trees when the world does not supply its instanced ones
function ownTree(K, x, z, type, size) {
  if (type === 'palm') {
    const h = 8 * size;
    K.beam('std', [x, 0, z], [x + 0.25, h, z], 0.18, '#8a7356', 6, 0.7);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      K.beam('std', [x + 0.25, h, z], [x + 0.25 + Math.cos(a) * 3.1 * size, h - 1.1 * size, z + Math.sin(a) * 3.1 * size], 0.22, GREENS[k % 5], 3, 0.25);
    }
    return;
  }
  const th = (type === 'ashoka' ? 1.4 : 3.0) * size;
  K.beam('std', [x, 0, z], [x, th + 0.6, z], 0.22 * size, '#5d4632', 6, 0.7);
  if (type === 'ashoka') {
    for (let k = 0; k < 3; k++) K.blob('std', x, th + 0.8 + k * 1.5 * size, z, (1.3 - k * 0.32) * size, '#386b2f', 1.2);
  } else {
    K.blob('std', x, th + 1.6 * size, z, 3.0 * size, GREENS[Math.abs(Math.round(x * 3 + z)) % 5], 0.75, 1);
  }
}

// ================================================================ SHANGRI LA
// Granite sign wall with the chrome "Shangri La" script (photo), an open frame on top with palms behind it,
// planters in front, and the grey/white apartment towers of Alchemy Shangri La behind.
function shangrila(K, T) {
  const D = 40;
  const F = D / 2;
  const granite = '#8b8f8c', graniteDark = '#6f716d';
  // lawn & driveway
  K.box('std', 0, 0, 0, 46, 0.05, D, '#6f9440');
  K.box('std', 15.5, 0.01, 3, 7, 0.06, D - 6, '#a59d8e');
  // ---- sign wall (centre x = -5, front face z = 15.6)
  const wx = -5, wz = 15.1, th = 1.0, base = 0.35;
  const PW = 16.0, PH = PW * (384 / 1024);               // photo panel 16 x 6 m
  const ext = 2.6, WL = PW + 2 * ext, WH = base + PH;
  K.at(wx, 0, wz);
  // plinth
  K.box('std', 0, 0, 0.12, WL + 0.4, base, th + 0.5, '#7c7b76', { top: '#8a8984' });
  // body: textured front (photo) + granite tile everywhere else
  K.face(T.wall, -PW / 2, PW / 2, base, base + PH, th / 2 + 0.002);
  K.box(T.granite, 0, base, 0, WL, PH, th, granite, { skip: 'fd', tile: 1.6 });
  for (const s of [-1, 1]) K.face(T.granite, s < 0 ? -WL / 2 : PW / 2, s < 0 ? -PW / 2 : WL / 2, base, base + PH, th / 2 + 0.002, '#ffffff', [s < 0 ? -WL / 2 / 1.6 : PW / 2 / 1.6, base / 1.6, s < 0 ? -PW / 2 / 1.6 : WL / 2 / 1.6, (base + PH) / 1.6]);
  // open frame on top: posts + beam (the openings show the palms planted behind)
  const fy = base + PH, fh = 2.0;
  for (const px of [-WL / 2 + 0.35, -5.6, 1.4, WL / 2 - 0.35]) K.box(T.granite, px, fy, 0, 0.7, fh, th, granite, { skip: 'd', tile: 1.6 });
  K.box(T.granite, 0, fy + fh, 0, WL, 0.55, th + 0.1, granite, { tile: 1.6, skip: '' });
  K.box(T.granite, 0, fy, 0, WL, 0.12, th + 0.06, graniteDark, { tile: 1.6 });
  // planter in front (hides the bottom of the photo) with shrubs, fan palms at the left end
  planter(K, 0, th / 2 + 0.75, WL - 1.2, 1.2, 0.85, '#7a7975', true, 3);
  for (const [x, r] of [[-WL / 2 - 0.8, 1.2], [-WL / 2 + 0.6, 1.0], [WL / 2 + 0.8, 1.05]]) K.blob('std', x, r * 0.75, 1.6, r, '#4c7a30', 0.95);
  // dark granite band continues round the ends (matches the band in the photo)
  K.pop();
  // compound wall either side + gate posts with a boom barrier at the driveway
  const cz = F - 0.4;
  K.box('std', -18.5, 0, cz, 9, 1.4, 0.35, '#c9c4ba', { top: '#a19c92' });
  K.box('std', 19.6, 0, cz, 6.8, 1.4, 0.35, '#c9c4ba', { top: '#a19c92' });
  for (const x of [12.2, 18.8]) K.box(T.granite, x, 0, cz, 0.9, 2.6, 0.9, granite, { tile: 1.6, skip: 'd' });
  K.box('std', 15.5, 1.05, cz, 6.0, 0.12, 0.12, '#d63a2a');
  for (let k = 0; k < 5; k++) K.box('std', 13.1 + k * 1.2, 1.05, cz, 0.5, 0.125, 0.13, '#f4f4f0', { skip: 'd' });
  K.box('std', 18.0, 0, cz - 1.8, 1.8, 2.5, 1.8, '#e9e5dc', { top: '#8f8b84' }); // guard cabin
  K.box('glass', 18.0, 1.0, cz - 0.88, 1.2, 0.9, 0.04, '#2a3440');
  // ---- towers (stone-clad grey with white slab bands, window bands, balcony slots with AC units)
  const tower = (x, z, w, d, floors, body, band, slot) => {
    const fh = 3.1, H = floors * fh + 1.2;
    K.box('std', x, 0, z, w, H, d, body, { top: '#b9b4ac' });
    K.box('std', x, H, z, w * 0.4, 2.6, d * 0.4, body, { top: '#a8a39b' }); // stair/lift head room
    for (let f = 1; f <= floors; f++) {
      const y = f * fh;
      K.box('std', x, y - 0.12, z, w + 0.3, 0.24, d + 0.3, band, { skip: 'd' });
      // window bands on the three visible faces
      const gw = slot ? w * 0.5 : w - 1.6, gx = x - (slot ? w * 0.18 : 0);
      K.box('glass', gx, y - 2.15, z + d / 2 + 0.02, gw, 1.4, 0.06, '#5f7486', { skip: 'db' });
      K.box('glass', x - w / 2 - 0.02, y - 2.15, z, 0.06, 1.4, d - 2.4, '#5f7486', { skip: 'dr' });
      K.box('glass', x + w / 2 + 0.02, y - 2.15, z, 0.06, 1.4, d - 2.4, '#5f7486', { skip: 'dl' });
      const np = Math.round(gw / 2.6);
      for (let k = 1; k < np; k++) K.box('std', gx - gw / 2 + (gw * k) / np, y - 2.15, z + d / 2 + 0.06, 0.45, 1.4, 0.08, body, { skip: 'db' });
      if (slot) {
        // recessed balcony slot with white railing and an AC unit
        const sx = x + w * 0.3, sw = w * 0.22;
        K.box('std', sx, y - fh + 0.24, z + d / 2 + 0.03, sw, fh - 0.48, 0.05, '#5f6670', { skip: 'db' });
        K.box('std', sx, y - fh + 0.1, z + d / 2 + 0.25, sw, 1.05, 0.08, '#eeeeea', { skip: 'd' });
        K.box('std', sx + sw * 0.25, y - fh + 1.2, z + d / 2 + 0.25, 0.8, 0.55, 0.4, '#f2f2ef');
      }
    }
  };
  tower(-2, -7, 16, 14, 15, '#c9c5bd', '#ecebe6', true);
  tower(14.5, -3, 12, 12, 12, '#d6d2ca', '#f1f0ec', true);
  tower(-16.5, -2, 11, 13, 13, '#d9d5cc', '#f3f1ec', false);
  // trees: palms behind the frame openings, neem trees around
  return [
    { x: -12.5, z: 13.3, type: 'palm', size: 1.0 }, { x: -7.8, z: 12.9, type: 'palm', size: 1.15 }, { x: -1.8, z: 13.4, type: 'palm', size: 0.95 },
    { x: 2.4, z: 12.8, type: 'palm', size: 1.1 }, { x: -20, z: 15.5, type: 'neem', size: 1.0 }, { x: 21, z: 10, type: 'neem', size: 1.0 },
    { x: 8.5, z: 16.5, type: 'bush', size: 1.1 },
  ];
}

// ================================================================ ADDA (Rose Wood Residency)
// White 4-storey society block on stilts: red-brick pilasters carrying the oval "Rose Wood Residency" board,
// a porch on brick columns, a balcony full of plants, compound wall, sliding gate and the security cabin.
function adda(K, T, O) {
  const D = 32, F = D / 2;
  const white = '#e4e0d6', whiteShade = '#d2cdc2', brick = '#c8735a';
  K.box('std', 0, 0, 0, 40, 0.05, D, '#a49a88');
  K.box('std', 4, 0.01, 8.5, 9, 0.06, 13, '#b7aa98'); // paved drive under the porch
  // ---- block: x -14..14, front z = 2, back z = -14
  const bx0 = -14, bx1 = 14, fz = 2, bz = -14, g = 3.0, fl = 3.1, top = g + 3 * fl;
  // stilt floor: dark parking interior + columns
  K.box('std', 0, 0, (fz + bz) / 2 - 0.6, bx1 - bx0 - 0.6, g, fz - bz - 1.2, '#5a5752', { skip: 'dt' });
  for (let x = bx0 + 0.3; x <= bx1 - 0.2; x += 4.6) K.box('std', x, 0, fz - 0.3, 0.5, g, 0.5, whiteShade);
  K.box('std', 0, g, (fz + bz) / 2, bx1 - bx0, top - g, fz - bz, white, { skip: 'd', side: whiteShade });
  K.box('std', 0, g - 0.3, (fz + bz) / 2, bx1 - bx0 + 0.3, 0.3, fz - bz + 0.3, whiteShade);
  // parapet + water tank + stair head
  K.box('std', 0, top, (fz + bz) / 2, bx1 - bx0, 1.0, fz - bz, white, { skip: 'd', top: '#c9c4b8' });
  K.box('std', -8, top + 1.0, -9, 4, 2.8, 4, white, { top: '#bdb7aa' });
  K.box('std', -8, top + 3.8, -9, 3.2, 1.4, 2.4, '#3a6ea8');
  // windows (dark with white frames) and balconies
  for (let f = 0; f < 3; f++) {
    const y = g + f * fl;
    for (const x of [-11.5, -6.5, -2.0]) {
      K.box('std', x, y + 0.8, fz + 0.04, 2.1, 1.55, 0.08, '#f8f8f4', { skip: 'db' });
      K.box('glass', x, y + 0.88, fz + 0.09, 1.9, 1.4, 0.04, '#55687a', { skip: 'db' });
      K.box('std', x, y + 0.88, fz + 0.12, 0.08, 1.4, 0.04, '#f8f8f4', { skip: 'db' });
      K.box('std', x, y + 0.72, fz + 0.2, 2.3, 0.1, 0.35, '#c9c3b6');
      K.box('std', x, y + 2.42, fz + 0.3, 2.4, 0.08, 0.6, '#c9c3b6');
    }
    // floor band, AC units, projecting balcony with railing and potted plants on the left half
    K.box('std', 0, y + fl - 0.2, fz + 0.06, bx1 - bx0, 0.22, 0.12, '#d6d1c5', { skip: 'db' });
    K.box('std', -11.5, y + 0.25, fz + 0.25, 0.9, 0.55, 0.45, '#f4f4f0');
    K.box('std', -2.0, y + 0.25, fz + 0.25, 0.9, 0.55, 0.45, '#f4f4f0');
    K.box('std', -9, y - 0.05, fz + 0.75, 4.2, 0.2, 1.5, whiteShade);
    railing(K, -11.1, -6.9, y + 0.15, fz + 1.45, 0.95, '#6b4f3a', 0.5);
    for (let k = 0; k < 3; k++) K.blob('std', -10.6 + k * 1.6 + f * 0.3, y + 0.5, fz + 1.0, 0.42, GREENS[(k + f) % 5], 1.1);
    // side windows
    for (const z of [-3, -9]) {
      K.box('glass', bx0 - 0.02, y + 0.9, z, 0.05, 1.3, 1.6, '#2d3640', { skip: 'dr' });
      K.box('glass', bx1 + 0.02, y + 0.9, z, 0.05, 1.3, 1.6, '#2d3640', { skip: 'dl' });
    }
  }
  // the planted balcony (photo) on the first floor, beside the porch: recessed frame around it
  const by = g + 0.05, bw = 4.4, bh = bw * (352 / 512);
  K.box('std', 3.0, by - 0.25, fz + 0.65, bw + 0.5, 0.3, 1.3, whiteShade);
  K.face(T.balcony, 3.0 - bw / 2, 3.0 + bw / 2, by, by + bh, fz + 0.04);
  K.box('std', 3.0 - bw / 2 - 0.15, by, fz + 0.4, 0.3, bh, 0.8, white);
  K.box('std', 3.0 + bw / 2 + 0.15, by, fz + 0.4, 0.3, bh, 0.8, white);
  for (let f = 1; f < 3; f++) {
    const y = g + f * fl;
    K.box('std', 3.0, y + 0.85, fz + 0.04, 2.0, 1.45, 0.08, '#f8f8f4', { skip: 'db' });
    K.box('glass', 3.0, y + 0.92, fz + 0.09, 1.8, 1.3, 0.04, '#55687a', { skip: 'db' });
  }
  // ---- red brick pilasters (full height) carrying the oval board
  const pil = [[7.6, 1.5], [11.6, 1.7]];
  for (const [x, w] of pil) K.box(T.brick, x, 0, fz + 0.35, w, top + 1.6, 0.9, brick, { tile: 1.2, skip: 'd' });
  // the board hangs on two short steel arms off the pilasters
  for (const x of [7.6, 11.6]) K.box('metal', x, 6.6, fz + 0.9, 0.12, 0.12, 0.3, '#3b3b3b');
  // porch: white slab on two brick columns, sloping fascia
  const pz0 = fz, pz1 = fz + 6.0, py = g + 0.05;
  K.box('std', 1.6, py, (pz0 + pz1) / 2, 9.8, 0.38, pz1 - pz0, '#f1efe9', { side: '#e2ded5' });
  K.box('std', 1.6, py - 0.2, pz1 - 0.12, 10.0, 0.62, 0.24, '#f4f2ec');
  for (const x of [-2.6, 5.4]) K.box(T.brick, x, 0, pz1 - 0.7, 0.55, py, 0.55, brick, { tile: 1.2, skip: 'd' });
  // the oval board "Rose Wood Residency" (photo) on the pilasters, with a dark wooden rim
  const sx = 9.7, sy = 5.75, sa = 4.3, sb = sa * (392 / 1024);
  K.at(sx, 0, fz + 1.1, -O.side * 0.2);
  K.ellipse('std', 0, sy, -0.04, sa + 0.14, sb + 0.14, '#4a3426');
  K.ellipse(T.sign, 0, sy, 0, sa, sb);
  // back face of the board (plain wood) so it reads from the side
  K.at(0, sy, -0.06, Math.PI); K.ellipse('std', 0, 0, 0, sa + 0.14, sb + 0.14, '#4a3426'); K.pop();
  K.pop();
  // ---- compound wall with a sliding brown gate and the security cabin by the road
  const cz = F - 0.5;
  K.box('std', -10, 0, cz, 20, 1.5, 0.3, '#e3dfd6', { top: '#b9b4a8' });
  K.box('std', 14.5, 0, cz, 11, 1.5, 0.3, '#e3dfd6', { top: '#b9b4a8' });
  for (const x of [0, 8.6]) K.box(T.brick, x, 0, cz, 0.7, 2.2, 0.7, brick, { tile: 1.2, skip: 'd' });
  // gate: half open, vertical bars
  K.box('metal', 2.4, 0.15, cz + 0.2, 4.6, 0.08, 0.06, '#6b4433');
  K.box('metal', 2.4, 1.75, cz + 0.2, 4.6, 0.08, 0.06, '#6b4433');
  for (let k = 0; k <= 14; k++) K.box('metal', 0.15 + k * 0.32, 0.15, cz + 0.2, 0.045, 1.68, 0.045, '#6b4433', { skip: 'dt' });
  // security cabin (photo front)
  const cx = 11.6, cw = 2.6, ch = cw * (448 / 384), cd = 2.8, czc = cz - 1.7;
  K.face(T.cabin, cx - cw / 2, cx + cw / 2, 0, ch, czc + cd / 2 + 0.002);
  K.box('std', cx, 0, czc, cw, ch, cd, '#c9c6bc', { skip: 'fd', top: '#8f8a80' });
  K.box('std', cx, ch, czc, cw + 0.5, 0.18, cd + 0.5, '#9a958a');
  return [
    { x: -16.5, z: 11.5, type: 'neem', size: 1.05 }, { x: -11, z: 12.5, type: 'neem', size: 0.95 }, { x: -5.5, z: 13.2, type: 'ashoka', size: 0.9 },
    { x: 17.5, z: 9, type: 'neem', size: 1.0 }, { x: -18, z: -6, type: 'neem', size: 1.0 },
  ];
}

// ================================================================ VIDHI COLLECTION
// Ground-floor shop row (photo: Stationery & Jumbo Xerox, Apollo Pharmacy, ATM) under a projecting slab whose
// fascia carries the VIDDHI COLLECTION and Apollo Pharmacy boards; two office floors with glass above.
function vidhi(K, T) {
  const D = 22, F = D / 2;
  const grey = '#8f8a80', greyL = '#b9b3a6', dark = '#4b4944';
  K.box('std', 0, 0, 0, 30, 0.05, D, '#9e9a90');
  const x0 = -12, x1 = 12, fz = 4.0, bz = -10;
  const PW = 11.6, PH = PW * (448 / 1024), py = 0.62;       // shopfront photo 11.6 x 5.07 m
  const gh = py + PH + 0.05;                                // slab bottom
  // steps along the whole front
  for (let k = 0; k < 4; k++) K.box('std', 0, 0, fz + 2.3 - k * 0.55, x1 - x0, 0.16 * (k + 1), 0.6, k % 2 ? '#a7a39a' : '#9c988f', { skip: 'd' });
  // shopfront photo in the middle, framed by grey pillars
  K.face(T.front, -PW / 2, PW / 2, py, py + PH, fz + 0.01);
  K.box('std', 0, py, fz - 0.3, PW, PH, 0.6, '#6e6a62', { skip: 'fd' });
  for (const s of [-1, 1]) K.box('std', s * (PW / 2 + 0.3), 0, fz + 0.1, 0.6, gh, 0.8, grey, { side: '#7d786f' });
  // side bays: glass shopfronts + a half-open rolling shutter
  const bay = (xa, xb, shutter, tint) => {
    const w = xb - xa, xc = (xa + xb) / 2;
    K.box('std', xc, py, fz - 0.4, w, gh - py, 0.6, '#5a5751', { skip: 'd' });
    K.box('glass', xc, py + 0.1, fz - 0.08, w - 0.4, gh - py - 1.0, 0.06, tint);
    for (let k = 0; k <= 3; k++) K.box('metal', xa + 0.2 + ((w - 0.4) * k) / 3, py + 0.1, fz - 0.03, 0.08, gh - py - 1.0, 0.05, '#c4c6c4', { skip: 'd' });
    if (shutter) K.box('std', xc, gh - 1.0 - 1.6, fz - 0.02, w - 0.4, 1.6, 0.08, '#a9aba7');
    K.box('std', xc, gh - 0.9, fz - 0.05, w - 0.3, 0.8, 0.1, '#e8e4d8');
  };
  bay(x0, -PW / 2 - 0.6, false, '#3c5a5c');
  bay(PW / 2 + 0.6, x1, true, '#3a4a5a');
  for (const x of [x0 + 0.3, x1 - 0.3]) K.box('std', x, 0, fz + 0.1, 0.6, gh, 0.8, grey);
  // projecting slab with the fascia boards
  const sz = fz + 2.2;
  K.box('std', 0, gh, (fz + sz) / 2 - 0.3, x1 - x0 + 0.4, 0.45, sz - fz + 0.6, dark, { top: greyL });
  K.box('std', 0, gh - 0.1, sz - 0.15, x1 - x0 + 0.4, 2.6, 0.3, '#3f3d39', { top: '#6b675f' });
  const bw = 9.6, bh = bw * (256 / 1024);
  K.face(T.board, 0.6 - bw / 2, 0.6 + bw / 2, gh + 0.0, gh + bh, sz + 0.005);
  const aw = 5.4, ah = aw * (224 / 512);
  K.face(T.apollo, -8.2 - aw / 2, -8.2 + aw / 2, gh + 0.03, gh + 0.03 + ah, sz + 0.005);
  // right bay: the board's own product lists (left and right thirds of the real VIDDHI board)
  K.face(T.board, 6.0, 8.8, gh + 0.25, gh + 0.25 + 2.0, sz + 0.005, '#ffffff', [0.0, 0, 0.36, 1]);
  K.face(T.board, 8.9, 11.7, gh + 0.25, gh + 0.25 + 2.0, sz + 0.005, '#ffffff', [0.64, 0, 1, 1]);
  // two office floors: grey cladding piers, glass bands, railing on the first floor
  const f1 = gh + 2.5, top = f1 + 2 * 3.4;
  K.box('std', 0, f1, (fz + bz) / 2, x1 - x0, top - f1, fz - bz, greyL, { skip: 'd', side: '#a8a294' });
  K.box('std', 0, gh + 0.45, (fz + bz) / 2 - 0.5, x1 - x0, 1.6, fz - bz - 1, '#7d786e', { skip: 'd' });
  for (let f = 0; f < 2; f++) {
    const y = f1 + f * 3.4;
    K.box('glass', 0, y + 0.5, fz + 0.03, x1 - x0 - 1.2, 2.3, 0.06, '#40607a', { skip: 'db' });
    for (let k = 0; k <= 8; k++) K.box('std', x0 + 0.6 + ((x1 - x0 - 1.2) * k) / 8, y + 0.5, fz + 0.08, 0.22, 2.3, 0.1, '#d5d0c4', { skip: 'db' });
    K.box('std', 0, y + 3.0, fz + 0.15, x1 - x0 + 0.2, 0.4, 0.3, '#ddd8cc', { skip: 'd' });
  }
  railing(K, x0 + 0.4, x1 - 0.4, f1 - 0.05, sz - 0.1, 1.0, '#d9dcdc', 1.2);
  K.box('std', 0, top, (fz + bz) / 2, x1 - x0, 0.9, fz - bz, '#cbc5b8', { skip: 'd', top: '#a39d90' });
  // side and back walls with windows
  for (const s of [-1, 1]) for (let f = 0; f < 2; f++) K.box('glass', s * (x1 + 0.02), f1 + f * 3.4 + 0.8, -3, 0.05, 1.5, 8, '#3b4a58', { skip: s < 0 ? 'dr' : 'dl' });
  // pots and a leafy plant in front (the real photo has one there too), a scooter-free pavement
  K.box('std', 4.4, 0, fz + 2.9, 1.2, 0.75, 1.2, '#8c4a2c');
  K.blob('std', 4.4, 1.6, fz + 2.9, 1.45, '#4f8030', 0.9, 1);
  K.blob('std', 3.7, 2.5, fz + 2.6, 0.9, '#5c8a32', 0.9);
  K.blob('std', 5.3, 2.3, fz + 2.6, 0.85, '#46742a', 0.9);
  K.box('std', -10.8, 0, fz + 3.0, 0.8, 0.6, 0.8, '#8c4a2c');
  K.blob('std', -10.8, 1.1, fz + 3.0, 0.8, '#46742a', 0.9);
  return [{ x: -14.0, z: 8.5, type: 'neem', size: 0.9 }, { x: 13.8, z: 8.8, type: 'ashoka', size: 0.9 }];
}

// ================================================================ BRIGHT DAY SCHOOL
// Grey/white and blue facade (photo) with the real portico (crisp BRIGHT DAY SCHOOL sign) and white fins
// projected out of it, side wings, forecourt with trees, compound wall with a signed gate, flag.
function brightday(K, T) {
  // Shallow plot so the photo facade sits ~16 m from the road and reads clearly while driving past
  const D = 30, F = D / 2;
  K.box('std', 0, 0, 0, 66, 0.05, D, '#7a9a46');
  const FW = 27, FH = FW * (680 / 1024), fz = F - 10, bz = fz - 14;
  K.box('std', 0, 0.01, (F + fz) / 2, 40, 0.06, F - fz, '#bba98d'); // forecourt paving
  const X = (px) => (px / 1024) * FW - FW / 2;
  const Y = (py) => FH * (1 - py / 680);
  const UVp = (x, y) => [(x + FW / 2) / FW, y / FH];
  const greyW = '#cdc3b3', blue = '#4f7f99';
  // main block: photo front, plain sides/back in sampled colours
  K.face(T.facade, -FW / 2, FW / 2, 0, FH, fz);
  K.box('std', 0, 0, (fz + bz) / 2, FW, FH, fz - bz - 0.01, greyW, { skip: 'fd', top: '#b9b2a6' });
  K.box('std', 0, FH, (fz + bz) / 2, FW + 0.4, 0.5, fz - bz + 0.4, '#e2ddd3', { skip: '' });
  // blue band block on top centre (from the photo's top band) gets thickness at the roof line
  K.box('std', X(512), FH - 0.01, fz - 0.6, (X(890) - X(185)), 0.6, 1.2, blue, { skip: 'd' });
  // white fins: tapered, projected out of the facade, front faces keep the photo
  const fin = (xa, xb, xc, xd, ya, yb, depth) => {
    // xa..xb at the top (ya), xc..xd at the bottom (yb)
    const z1 = fz + depth;
    const p = [[xc, yb], [xd, yb], [xb, ya], [xa, ya]];
    K.quad(T.facade, [xc, yb, z1], [xd, yb, z1], [xb, ya, z1], [xa, ya, z1], '#ffffff', p.map(([x, y]) => UVp(x, y)));
    const wcol = '#e9e6df';
    K.quad('std', [xd, yb, z1], [xd, yb, fz], [xb, ya, fz], [xb, ya, z1], wcol);
    K.quad('std', [xa, ya, fz], [xc, yb, fz], [xc, yb, z1], [xa, ya, z1], '#dcd8d0');
    K.quad('std', [xa, ya, z1], [xb, ya, z1], [xb, ya, fz], [xa, ya, fz], '#f0eee8');
  };
  fin(X(418), X(495), X(446), X(495), Y(198), Y(456), 1.1);
  fin(X(583), X(657), X(583), X(630), Y(198), Y(456), 1.1);
  // gold bar between the fins
  K.box('metal', X(540), Y(240), fz + 0.5, X(608) - X(472), 0.28, 0.5, '#c9a43a');
  // portico: white box with the crisp sign, slim columns, dark soffit
  const p0 = X(336), p1 = X(744), pc = (p0 + p1) / 2, pw = p1 - p0, pdz = 3.6;
  const sy0 = Y(520), sy1 = Y(455), ty = Y(380);
  const pz = fz + pdz;
  K.face(T.sign, p0, p1, sy0, sy1, pz + 0.003);
  K.box('std', pc, sy0, fz + pdz / 2, pw, sy1 - sy0, pdz, '#e4e1da', { skip: 'fd', side: '#dedad2' });
  K.box('std', pc, sy1, fz + pdz / 2, pw, ty - sy1, pdz, '#f2f0eb', { skip: 'd', side: '#e7e4dd', top: '#d7d3cb' });
  K.box('std', pc, sy0 - 0.2, fz + pdz / 2, pw - 0.2, 0.2, pdz - 0.2, '#8f8a82', { skip: 'tfb' });
  for (const x of [p0 + 0.35, p1 - 0.35]) K.box('std', x, 0, pz - 0.35, 0.45, sy0 - 0.2, 0.45, '#f0eee8');
  // entrance steps
  for (let k = 0; k < 3; k++) K.box('std', pc, 0, fz + 1.6 - k * 0.5 + 1.0, pw - 1.5, 0.15 * (k + 1), 0.5, '#b3aea4', { skip: 'd' });
  // side wings: grey cladding with blue bands, window strips, a yellow accent panel like the photo edges
  const wing = (s) => {
    const wx = s * (FW / 2 + 8.5), ww = 17, wh = 15.6, wz0 = fz - 0.8, wz1 = bz + 1;
    K.box('std', wx, 0, (wz0 + wz1) / 2, ww, wh, wz0 - wz1, '#cbc4b6', { skip: 'd', top: '#b3ada2' });
    for (let f = 0; f < 4; f++) {
      const y = f * 3.75;
      K.box('glass', wx, y + 1.1, wz0 + 0.03, ww - 2.4, 1.6, 0.06, '#566a7a', { skip: 'db' });
      for (let k = 0; k <= 5; k++) K.box('std', wx - (ww - 2.4) / 2 + ((ww - 2.4) * k) / 5, y + 1.1, wz0 + 0.07, 0.18, 1.6, 0.06, '#e6e2da', { skip: 'db' });
      K.box('std', wx, y + 3.45, wz0 + 0.1, ww, 0.3, 0.2, f % 2 ? '#4f7f99' : '#e8e4dc', { skip: 'd' });
    }
    K.box('std', wx - s * (ww / 2 - 1.4), 0, wz0 + 0.06, 2.4, wh, 0.12, '#d9b65a', { skip: 'db' });
    K.box('std', wx, wh, (wz0 + wz1) / 2, ww + 0.3, 0.6, wz0 - wz1 + 0.3, '#e2ddd3');
  };
  wing(-1); wing(1);
  // compound wall + gate with the school sign facing the road
  // the gate sits to one side so the facade stays in view from the road
  const cz = F - 0.4, gw = 9.0, gx = 17;
  for (const [a, b] of [[-33, gx - gw / 2 - 0.6], [gx + gw / 2 + 0.6, 33]]) {
    K.box('std', (a + b) / 2, 0, cz, b - a, 1.7, 0.35, '#f1e9d6', { top: '#4f7f99' });
    for (let x = a + 1.5; x < b - 0.5; x += 3.5) K.box('std', x, 0, cz, 0.5, 1.95, 0.5, '#4f7f99');
  }
  K.at(gx, 0, 0);
  for (const s of [-1, 1]) K.box('std', s * (gw / 2 + 0.3), 0, cz, 1.2, 5.0, 1.2, '#f1e9d6', { top: '#4f7f99' });
  const gs = gw + 2.6, gh = gs * (148 / 1024), gy = 5.0;
  K.box('std', 0, gy, cz, gs + 0.3, gh + 0.4, 1.0, '#e8e5de', { skip: '' });
  K.box('std', 0, gy + gh + 0.4, cz, gs + 0.5, 0.25, 1.2, '#4f7f99');
  K.face(T.sign, -gs / 2, gs / 2, gy + 0.2, gy + 0.2 + gh, cz + 0.505);
  K.at(0, 0, cz - 0.505, Math.PI); K.face(T.sign, -gs / 2, gs / 2, gy + 0.2, gy + 0.2 + gh, 0); K.pop();
  for (const s of [-1, 1]) for (let k = 0; k < 7; k++) K.box('metal', s * (0.4 + k * 0.58), 0.1, cz + 0.05, 0.05, 1.9, 0.05, '#1d3d6b', { skip: 'dt' });
  for (const s of [-1, 1]) K.box('metal', s * 2.15, 1.95, cz + 0.05, 4.1, 0.08, 0.08, '#1d3d6b');
  K.pop();
  K.box('std', gx, 0.02, (cz + fz) / 2 + 2, gw - 1, 0.06, cz - fz - 4, '#a89e8e'); // drive from the gate
  // flag
  const fx = -13, fzz = F - 8;
  K.box('std', fx, 0, fzz, 2.2, 0.5, 2.2, '#f2f0ea'); K.box('std', fx, 0.5, fzz, 1.4, 0.4, 1.4, '#f2f0ea');
  K.beam('metal', [fx, 0.9, fzz], [fx, 12.5, fzz], 0.08, '#e6e6e6', 8, 0.6);
  const flag = [['#ff9933', 11.7], ['#ffffff', 11.2], ['#138808', 10.7]];
  for (const [c, y] of flag) K.box('std', fx + 1.3, y, fzz, 2.4, 0.5, 0.04, c, { skip: 'd' });
  K.cyl('std', fx + 1.3, 11.2, fzz + 0.025, 0.17, 0.5, '#1c2f8a', 10);
  // trees stand where the photo's trees were (in front of the filled-in facade parts) + along the wall
  return [
    { x: X(236) - 0.9, z: fz + 3.2, type: 'neem', size: 1.05 }, { x: X(848) + 0.9, z: fz + 3.2, type: 'neem', size: 1.05 },
    { x: X(38) - 0.6, z: fz + 2.6, type: 'neem', size: 0.95 }, { x: X(1007) + 0.6, z: fz + 2.6, type: 'neem', size: 0.95 },
    { x: -26, z: F - 3, type: 'ashoka', size: 0.95 }, { x: -20.5, z: F - 3, type: 'ashoka', size: 0.95 },
    { x: 26.5, z: F - 3, type: 'ashoka', size: 0.95 }, { x: -29, z: -12, type: 'neem', size: 1.1 }, { x: 29, z: -12, type: 'banyan', size: 1.0 },
  ];
}

// ================================================================ PETAL TRILLIUM (finish line)
// U-shaped 4-storey commercial complex round a courtyard open to the road, under a huge sloping canopy roof on
// slanted steel tree-columns with PETAL TRILLIUM letters on its front edge; blue glass curtain walls, shop rows
// with corridor balconies and railings, glass stair tower, spiral stair, TRILLIUM SUPER MARKET board, hedges.
function petals(K, T, O) {
  const D = 48, F = D / 2;
  const cream = '#d8ccae', creamD = '#bfb395', shopCols = ['#7a756c', '#8c877c', '#5f5b55', '#9a8f7c', '#6c665c'];
  const boards = ['#d6b84e', '#a84a3e', '#47689a', '#ece8dc', '#5a8a62', '#c4804a', '#ece8dc'];
  K.box('std', 0, 0, 0, 58, 0.05, D, '#a59e90');
  K.box('std', 0, 0.01, 6, 26, 0.07, 30, '#b8b1a2'); // courtyard paving
  const G = 4.2, FL = 3.6, H = G + 3 * FL;             // 15 m
  const bzF = -10, bzB = -24, wx = 13, wxo = 27, wzF = 14;
  // ---- shop-row floor generator for a facade facing +z (in a local frame), x from a to b at z
  const shopFace = (a, b, z, glassTop, glassTex, seed) => {
    const w = b - a;
    for (let f = 0; f < 3; f++) {
      const y = f === 0 ? 0 : G + (f - 1) * FL;
      const h = f === 0 ? G - 0.4 : FL - 0.5;
      const n = Math.max(1, Math.round(w / 4.2));
      for (let k = 0; k < n; k++) {
        const xa = a + (w * k) / n + 0.25, xb = a + (w * (k + 1)) / n - 0.25, c = shopCols[(k + f * 2 + seed) % shopCols.length];
        if ((k + f + seed) % 3 === 0) K.box('glass', (xa + xb) / 2, y + 0.1, z - 0.02, xb - xa, h - 0.9, 0.06, '#34485a', { skip: 'db' });
        else K.box('std', (xa + xb) / 2, y + 0.1, z - 0.02, xb - xa, h - 0.9, 0.06, c, { skip: 'db' });
        K.box('std', (xa + xb) / 2, y + h - 0.72, z + 0.02, (xb - xa) * 0.62, 0.48, 0.06, boards[(k * 3 + f + seed) % boards.length], { skip: 'db' });
      }
      if (f > 0) {
        // corridor slab + railing
        K.box('std', (a + b) / 2, y - 0.25, z + 0.9, w, 0.3, 1.8, cream, { side: creamD });
        railing(K, a + 0.1, b - 0.1, y + 0.05, z + 1.75, 1.0, '#d4d6d2', 1.3);
      }
    }
    // top floor: blue glass curtain wall (photo on one face) with white mullions
    const y = G + 2 * FL;
    K.box('std', (a + b) / 2, y - 0.25, z + 0.9, w, 0.3, 1.8, cream, { side: creamD });
    railing(K, a + 0.1, b - 0.1, y + 0.05, z + 1.75, 1.0, '#d4d6d2', 1.3);
    if (glassTex) {
      const gw = Math.min(w - 0.6, 10.5), gh = gw * (384 / 640);
      const gx = (a + b) / 2;
      K.face(glassTex, gx - gw / 2, gx + gw / 2, y + 0.15, y + 0.15 + Math.min(gh, FL + 1.6), z + 0.03, '#ffffff', [0, 1 - Math.min(gh, FL + 1.6) / gh, 1, 1]);
      if (w - gw > 0.6) {
        K.box('glass', a + (w - gw) / 4, y + 0.15, z, (w - gw) / 2 - 0.2, FL + 1.4, 0.06, '#1f3f86', { skip: 'db' });
        K.box('glass', b - (w - gw) / 4, y + 0.15, z, (w - gw) / 2 - 0.2, FL + 1.4, 0.06, '#1f3f86', { skip: 'db' });
      }
    } else if (glassTop) {
      K.box('glass', (a + b) / 2, y + 0.15, z, w - 0.4, FL + 1.4, 0.06, '#1f3f86', { skip: 'db' });
      const n = Math.round(w / 1.6);
      for (let k = 0; k <= n; k++) K.box('std', a + 0.2 + ((w - 0.4) * k) / n, y + 0.15, z + 0.05, 0.1, FL + 1.4, 0.08, '#e9e6dc', { skip: 'db' });
      K.box('std', (a + b) / 2, y + 1.9, z + 0.05, w - 0.4, 0.1, 0.08, '#e9e6dc', { skip: 'db' });
    }
  };
  // ---- volumes
  K.box('std', 0, 0, (bzF + bzB) / 2, 2 * wxo, H + 1.4, bzF - bzB, cream, { skip: 'd', top: '#a9a38f', side: creamD });
  for (const s of [-1, 1]) K.box('std', s * (wx + wxo) / 2, 0, (wzF + bzF) / 2, wxo - wx, H + 1.4, wzF - bzF, cream, { skip: 'd', top: '#a9a38f', side: creamD });
  // back block front (courtyard side)
  shopFace(-wx, wx, bzF + 0.01, true, null, 0);
  // wings: inner faces (towards the courtyard) and the end faces towards the road
  K.at(-wx, 0, (wzF + bzF) / 2, Math.PI / 2); shopFace(-(wzF - bzF) / 2, (wzF - bzF) / 2, 0.01, true, null, 1); K.pop();
  K.at(wx, 0, (wzF + bzF) / 2, -Math.PI / 2); shopFace(-(wzF - bzF) / 2, (wzF - bzF) / 2, 0.01, true, null, 2); K.pop();
  shopFace(-wxo, -wx, wzF + 0.01, false, T.glass, 3);
  shopFace(wx, wxo, wzF + 0.01, true, null, 4);
  // glass stair tower in the back block (blue glass, white frame) rising above the roof
  K.box('glass', 0, 0, bzF + 0.6, 3.2, H + 4.0, 1.2, '#2c5fc4', { skip: 'd' });
  for (const s of [-1, 1]) K.box('std', s * 1.75, 0, bzF + 0.6, 0.35, H + 4.2, 1.4, '#efece4');
  K.box('std', 0, H + 4.0, bzF + 0.6, 3.9, 0.35, 1.4, '#efece4');
  // TRILLIUM SUPER MARKET board on the right wing (road face, above the ground-floor shops)
  const mw = 12.0, mh = mw * (160 / 1024);
  K.box('std', (wx + wxo) / 2, G - 0.55, wzF + 1.9, mw + 0.3, mh + 0.25, 0.25, '#d6d8d8', { skip: 'd' });
  K.face(T.market, (wx + wxo) / 2 - mw / 2, (wx + wxo) / 2 + mw / 2, G - 0.43, G - 0.43 + mh, wzF + 2.03);
  // ---- the canopy: one huge sloping roof, higher at the road
  const cx0 = -29.5, cx1 = 29.5, cz0 = -25.5, cz1 = 22.0, yB = H + 4.6, yF = H + 9.4, ct = 0.7;
  const yAt = (z) => yB + ((z - cz0) / (cz1 - cz0)) * (yF - yB);
  const tile = 4.0;
  // underside (photo panel tile, faces down), top (steel), edges (cream fascia)
  const qF = yAt(cz1), qB = yAt(cz0);
  K.quad(T.canopy, [cx0, qB, cz0], [cx1, qB, cz0], [cx1, qF, cz1], [cx0, qF, cz1], '#ffffff',
    [[cx0 / tile, cz0 / tile], [cx1 / tile, cz0 / tile], [cx1 / tile, cz1 / tile], [cx0 / tile, cz1 / tile]]);
  K.quad('metal', [cx0, qB + ct, cz0], [cx0, qF + ct, cz1], [cx1, qF + ct, cz1], [cx1, qB + ct, cz0], '#8e8f8a');
  K.quad('std', [cx0, qF, cz1], [cx1, qF, cz1], [cx1, qF + ct, cz1], [cx0, qF + ct, cz1], '#e6e0cc');
  K.quad('std', [cx1, qB, cz0], [cx0, qB, cz0], [cx0, qB + ct, cz0], [cx1, qB + ct, cz0], '#cfc8b2');
  K.quad('std', [cx1, qF, cz1], [cx1, qB, cz0], [cx1, qB + ct, cz0], [cx1, qF + ct, cz1], '#ddd6c0');
  K.quad('std', [cx0, qB, cz0], [cx0, qF, cz1], [cx0, qF + ct, cz1], [cx0, qB + ct, cz0], '#ddd6c0');
  // steel ribs under the canopy (a few) for depth
  for (const x of [-20, -10, 0, 10, 20]) K.beam('metal', [x, yAt(cz1) - 0.05, cz1 - 0.3], [x, yAt(cz0) - 0.05, cz0 + 0.3], 0.22, '#9d9a8e', 4);
  // slanted tree columns: trunk + V struts up to the roof
  const steel = '#c8c2ae';
  for (const [x, z] of [[-6.5, 4], [6.5, 4], [-6.5, -4.5], [6.5, -4.5]]) {
    const top = [x * 1.08, 11.5, z + 0.8];
    K.beam('metal', [x, 0, z], top, 0.32, steel, 8, 0.8);
    K.cyl('std', x, 0, z, 0.5, 0.5, '#8e8a80', 8);
    for (const [dx, dz] of [[-4, 4.5], [4, 4.5], [-3.5, -4], [3.5, -4]]) {
      const zz = z + dz;
      K.beam('metal', top, [x + dx, yAt(zz) - 0.1, zz], 0.16, steel, 6);
    }
  }
  // struts from the wing roofs
  for (const s of [-1, 1]) for (const z of [-4, 8]) K.beam('metal', [s * 20, H + 1.4, z], [s * 17, yAt(z + 3) - 0.1, z + 3], 0.18, steel, 6);
  // PETAL TRILLIUM letters standing on the front edge of the canopy, facing the road
  // (hung on the front fascia, turned ~6 degrees towards the oncoming cars so they read on the approach to the finish)
  const lw = 30, lh = lw * (192 / 1024), lz = cz1 + 0.35, ly = yAt(cz1) + ct * 0.5 - lh * 0.42;
  K.at(0, 0, lz, -O.side * 0.1);
  K.face(T.letters, -lw / 2, lw / 2, ly, ly + lh, 0);
  K.pop();
  // spiral staircase at the right wing's courtyard corner
  const sx = wx - 2.2, sz = wzF - 1.6, steps = 26;
  K.cyl('metal', sx, 0, sz, 0.12, G + 0.6, '#d9dbd8', 8);
  for (let k = 0; k < steps; k++) {
    const a = (k / steps) * Math.PI * 2.2, y = ((k + 1) / steps) * G;
    K.box('std', sx + Math.cos(a) * 0.75, y - 0.06, sz + Math.sin(a) * 0.75, 1.4, 0.07, 0.42, '#c9ccc9', { ry: -a });
    if (k % 2 === 0) K.beam('metal', [sx + Math.cos(a) * 1.4, y, sz + Math.sin(a) * 1.4], [sx + Math.cos(a) * 1.4, y + 1.0, sz + Math.sin(a) * 1.4], 0.025, '#e6e8e6', 3);
  }
  // front: hedge planters, black-yellow kerb rail, white sign boards on posts, a few parked bikes
  for (let k = 0; k < 7; k++) {
    const x = -21 + k * 7;
    planter(K, x, F - 4.2, 2.6, 1.6, 0.55, '#55534f', false);
    K.blob('std', x, 1.25, F - 4.2, 1.35, GREENS[k % 5], 0.62, 1);
  }
  for (let k = 0; k < 24; k++) K.box('std', -26 + k * 2.2 + 1.1, 0.25, F - 1.6, 2.2, 0.1, 0.1, k % 2 ? '#e8c02a' : '#1e1e1e');
  for (const x of [-24.5, -20.5, -16.5, 5.5]) {
    K.box('metal', x, 0, F - 6.2, 0.08, 1.2, 0.08, '#e8e8e4');
    K.box('std', x, 1.2, F - 6.2, 1.3, 1.9, 0.1, '#f4f4f0');
    K.box('std', x, 1.32, F - 6.14, 1.0, 1.6, 0.04, '#b9b6ae', { skip: 'db' });
  }
  for (let k = 0; k < 6; k++) {
    const x = -6 + k * 1.6, z = F - 8.5;
    const c = ['#1b1b1f', '#c8102e', '#f2f2f0', '#1f4fa8', '#1b1b1f', '#9aa3ad'][k];
    K.box('std', x, 0.32, z, 0.32, 0.5, 1.5, c);
    K.box('std', x, 0.82, z - 0.15, 0.28, 0.12, 0.6, '#151515');
    for (const dz of [-0.62, 0.62]) K.box('std', x, 0, z + dz, 0.1, 0.58, 0.58, '#151515');
  }
  return [
    { x: -27, z: F - 3, type: 'neem', size: 0.9 }, { x: 27.5, z: F - 3, type: 'neem', size: 0.9 },
  ];
}

const BUILDERS = { shangrila, adda, vidhi, brightday, petals };
// which photo goes in which slot of each builder
const SLOTS = {
  shangrila: { wall: 'shangrila-wall.jpg', granite: 'shangrila-granite.jpg' },
  adda: { sign: 'adda-sign.jpg', balcony: 'adda-balcony.jpg', cabin: 'adda-cabin.jpg', brick: 'adda-brick.jpg' },
  vidhi: { front: 'vidhi-front.jpg', board: 'vidhi-board.jpg', apollo: 'vidhi-apollo.jpg' },
  brightday: { facade: 'brightday-facade.jpg', sign: 'brightday-sign.jpg' },
  petals: { letters: 'petals-letters.webp', market: 'petals-market.jpg', canopy: 'petals-canopy.jpg', glass: 'petals-glass.jpg' },
};
// extra self-light for surfaces that face away from the sun (canopy underside)
const SELF = { 'petals-canopy.jpg': 0.32, 'adda-cabin.jpg': 0.08 };
const SIGNS = new Set(['adda-sign.jpg', 'vidhi-board.jpg', 'vidhi-apollo.jpg', 'brightday-sign.jpg', 'petals-market.jpg', 'petals-letters.webp', 'shangrila-wall.jpg']);

/**
 * Build one real-photo checkpoint landmark.
 *
 * World mode (ctx = landmarkContext(world, lm) from landmarks.js, i.e. ctx.place exists): reserves the footprint with
 * ctx.place(width, depth, setback), plants world trees with ctx.tree, reads time of day / shadows / anisotropy from
 * ctx.world, adds the group with ctx.add (so its geometries/materials are disposed on reload) and returns the group.
 *
 * Standalone mode (no ctx.place): ctx (all optional) = { P (world time-of-day preset), aniso, shadows, rain,
 * tree(x, z, type, size) in local coords (else simple own trees are built) }; the group is in the local frame
 * (origin = footprint centre on the ground, +Z faces the road, front edge at z = +depth/2, +X along the road);
 * returns { id, group, width, depth, setback, trees, triangles, drawCalls, dispose() }.
 */
export function buildPhotoLandmark(id, ctx = {}) {
  const build = BUILDERS[id];
  if (!build) throw new Error('unknown photo landmark ' + id);
  const W = ctx.world;
  const worldMode = typeof ctx.place === 'function';
  if (worldMode) {
    const fp = PHOTO_FOOTPRINT[id];
    const f = ctx.place(fp.width, fp.depth, fp.setback);
    ctx = { ...ctx, frame: f, P: W && W.P, aniso: W && W.aniso, shadows: W && W.QL && W.QL.shadows, rain: ctx.weather === 'rain' };
  }
  const aniso = ctx.aniso || 4;
  ANISO = Math.max(1, Math.min(8, aniso));
  for (const e of TEX.values()) if (e.tex.anisotropy !== ANISO) { e.tex.anisotropy = ANISO; if (e.ready) e.tex.needsUpdate = true; }
  const P = ctx.P || { signs: 0, windows: 0, glass: 0, lamps: 0 };
  const K = new Kit();
  const slots = {};
  for (const [k, f] of Object.entries(SLOTS[id])) slots[k] = f;
  // O.side: 1 = cars arrive from local -x, -1 = from +x (lets signs turn a little towards oncoming traffic)
  const trees = build(K, slots, { side: ctx.side || (ctx.lm && ctx.lm.side) || 1 }) || [];
  if (!ctx.tree) for (const t of trees) ownTree(K, t.x, t.z, t.type, t.size);
  else for (const t of trees) ctx.tree(t.x, t.z, t.type, t.size);

  const group = new THREE.Group();
  group.name = 'photo-' + id;
  const owned = [];
  const mats = {
    std: () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: ctx.rain ? 0.7 : 0.85, metalness: 0, envMapIntensity: 0.45 }),
    glass: () => new THREE.MeshStandardMaterial({ name: 'nocast', vertexColors: true, roughness: 0.14, metalness: 0.55, envMapIntensity: 1.0, emissive: new THREE.Color('#ffcf8f'), emissiveIntensity: (P.glass || 0) * 0.6 }),
    metal: () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.75, envMapIntensity: 0.9 }),
  };
  let draws = 0;
  for (const [name, B] of K.B) {
    if (!B.p.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(B.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(B.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(B.c, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(B.u, 2));
    g.computeBoundingSphere();
    let m;
    if (mats[name]) m = mats[name]();
    else {
      // a photo material: the photo is lit like everything else, plus a little self-light (it already carries
      // its own soft daylight) so shaded faces don't go muddy; signs glow at dusk/night like the world's signs
      const file = name, sign = SIGNS.has(file), alpha = file.endsWith('.webp');
      const e = photo(file);
      m = new THREE.MeshStandardMaterial({
        vertexColors: true, color: e.ready ? new THREE.Color().setScalar(PHOTO_GAIN) : col(AVG[file] || '#999999'), roughness: 0.88, metalness: 0, envMapIntensity: 0.3,
        emissive: 0xffffff, emissiveIntensity: (sign ? 0.1 + 0.75 * (P.signs || 0) : 0.08 + 0.3 * (P.windows || 0)) + (SELF[file] || 0),
        alphaTest: alpha ? 0.45 : 0, transparent: false, side: alpha ? THREE.DoubleSide : THREE.FrontSide,
      });
      const apply = (t) => { m.map = t; m.emissiveMap = t; m.color.setScalar(PHOTO_GAIN); m.needsUpdate = true; };
      if (e.ready) { m.map = e.tex; m.emissiveMap = e.tex; } else {
        m.emissive.copy(col(AVG[file] || '#999999')).multiplyScalar(0.5);
        if (alpha) m.visible = false;
        e.waiters.push((t) => { apply(t); m.emissive.set(0xffffff); m.visible = true; });
      }
      if (alpha) m.alphaToCoverage = false;
    }
    const mesh = new THREE.Mesh(g, m);
    mesh.name = id + ':' + name;
    mesh.castShadow = !!ctx.shadows && name !== 'glass';
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    owned.push(g, m);
    draws++;
  }
  const fp = PHOTO_FOOTPRINT[id];
  const res = {
    id, group, width: fp.width, depth: fp.depth, setback: fp.setback, trees, triangles: Math.round(K.tris), drawCalls: draws,
    dispose() {
      group.removeFromParent();
      for (const o of owned) o.dispose();
      owned.length = 0;
    },
  };
  group.userData.photoLandmark = { id, triangles: res.triangles, drawCalls: draws };
  if (worldMode) {
    group.applyMatrix4(ctx.frame.m);
    ctx.add(group, { cast: !!ctx.shadows, receive: true });
    group.traverse((n) => { if (n.isMesh && n.material.name === 'nocast') n.castShadow = false; });
    return group;
  }
  return res;
}
