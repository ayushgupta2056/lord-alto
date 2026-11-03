// Procedural Vadodara street architecture.
// - A small shared kit (hashing, canvas text, merge builders) used by world.js and landmarks.js.
// - One facade atlas (albedo 2048 + emissive/aux 1024) holding every wall bay, window, shopfront,
//   shutter, roof and all shop signboards, built once and reused by every track.
// - FSoup: an indexed quad soup with UVs into that atlas. Whole districts are merged into a few
//   spatial chunks, so hundreds of detailed buildings cost ~1 draw call per visible chunk.
// - Streetscape: generators for Indian urban buildings (shops, apartments, pols, offices, sheds,
//   barracks, construction) and street furniture (chai stalls, bus stops, dhabas, petrol pumps,
//   cranes, trucks, cows...).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const TAU = Math.PI * 2;
export const FONT = '"Arial Black", "Segoe UI Black", "Roboto", "Helvetica Neue", Arial, sans-serif';
export const FONT2 = '"Segoe UI", "Roboto", "Helvetica Neue", Arial, sans-serif';
export const FONT_SERIF = 'Georgia, "Times New Roman", "Noto Serif", serif';
export const FONT_GU = '"Nirmala UI", "Shruti", "Gujarati Sangam MN", "Gujarati MT", "Noto Sans Gujarati", "Lohit Gujarati", sans-serif';
export const FONT_HI = '"Nirmala UI", "Mangal", "Kohinoor Devanagari", "Devanagari Sangam MN", "Noto Sans Devanagari", sans-serif';

// ---------------------------------------------------------------- utils
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hash2(x, y, s) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function vnoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let xf = x - xi, yf = y - yi;
  xf = xf * xf * (3 - 2 * xf); yf = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}
export function fbm2(x, y, s, oct = 4) {
  let a = 0.5, f = 1, v = 0;
  for (let i = 0; i < oct; i++) { v += a * vnoise(x * f, y * f, s + i * 17); f *= 2.03; a *= 0.5; }
  return v / (1 - Math.pow(0.5, oct));
}
export const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length) % arr.length];

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}
export function canvasTex(c, { repeat = false, srgb = true, aniso = 1 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}
// film-grain overlay: a cached 128px noise tile drawn as a pattern (stays on the GPU; no getImageData readback)
let _noise = null;
export function grain(g, w, h, amp) {
  if (!_noise) {
    _noise = makeCanvas(128, 128);
    const ng = _noise.getContext('2d'), img = ng.createImageData(128, 128), d = img.data, r = mulberry32(4242);
    for (let i = 0; i < d.length; i += 4) { const v = 128 + (r() - 0.5) * 255; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
    ng.putImageData(img, 0, 0);
  }
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'overlay';
  g.globalAlpha = Math.min(1, amp / 60);
  g.fillStyle = g.createPattern(_noise, 'repeat');
  g.fillRect(0, 0, w, h);
  g.restore();
}
export function fitText(g, str, x, y, maxW, size, { weight = '900', family = FONT, color = '#fff', align = 'center', baseline = 'middle', stroke = null, strokeW = 0 } = {}) {
  let s = size;
  g.font = `${weight} ${s}px ${family}`;
  const m = g.measureText(str).width;
  if (m > maxW) { s = Math.floor(s * maxW / m); g.font = `${weight} ${s}px ${family}`; }
  g.textAlign = align; g.textBaseline = baseline;
  if (stroke) { g.lineWidth = strokeW; g.strokeStyle = stroke; g.lineJoin = 'round'; g.strokeText(str, x, y); }
  g.fillStyle = color; g.fillText(str, x, y);
  return s;
}
export function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
}
// arch outline in canvas space: x,yb = bottom-left, w wide, h tall; pointed = Mughal/Gothic point
export function archPath(g, x, yb, w, h, pointed = 0) {
  const r = w / 2, ys = yb - h + r;
  g.moveTo(x, yb); g.lineTo(x, ys);
  if (!pointed) g.arc(x + r, ys, r, Math.PI, 0);
  else {
    for (let k = 0; k <= 16; k++) {
      const t = k / 16, u = Math.abs(2 * t - 1);
      const yy = ys - r * (Math.sqrt(Math.max(0, 1 - u * u)) * (1 - pointed) + pointed * (1 - u)) * 1.15;
      g.lineTo(x + w * t, yy);
    }
  }
  g.lineTo(x + w, yb); g.closePath();
}
export function radialTexture(size, stops) {
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) gr.addColorStop(o, col);
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  return canvasTex(c);
}
const _cc = new THREE.Color();
export function shade(hex, k) { return _cc.set(hex).multiplyScalar(k).getStyle(); }

// ---------------------------------------------------------------- matrices & merge builders
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _v = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();
export function L(x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) {
  _e.set(rx, ry, rz, 'YXZ'); _q.setFromEuler(_e);
  return _m2.compose(_v.set(x, y, z), _q, _s.set(sx, sy, sz));
}

export class Builder {
  constructor() { this.lists = {}; this.frame = new THREE.Matrix4(); this._tmp = new THREE.Matrix4(); }
  push(bucket, geo, local, color, keepUV = false) {
    const g = geo.clone();
    g.clearGroups();
    const m = this._tmp.multiplyMatrices(this.frame, local);
    g.applyMatrix4(m);
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && !(keepUV && name === 'uv')) g.deleteAttribute(name);
    }
    if (keepUV && !g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (!g.attributes.normal) g.computeVertexNormals();
    const n = g.attributes.position.count;
    const ca = new Float32Array(n * 3);
    _c.set(color);
    for (let i = 0; i < n; i++) { ca[i * 3] = _c.r; ca[i * 3 + 1] = _c.g; ca[i * 3 + 2] = _c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(ca, 3));
    if (!g.index) {
      const idx = new (n > 65535 ? Uint32Array : Uint16Array)(n);
      for (let i = 0; i < n; i++) idx[i] = i;
      g.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    (this.lists[bucket] || (this.lists[bucket] = [])).push(g);
  }
  pushRaw(bucket, pos, nrm, cols, uvs) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    if (uvs) g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    const n = pos.length / 3;
    const idx = new (n > 65535 ? Uint32Array : Uint16Array)(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    (this.lists[bucket] || (this.lists[bucket] = [])).push(g);
  }
  merged(bucket) {
    const list = this.lists[bucket];
    if (!list || !list.length) return null;
    // uv must be present on all or none
    const anyUV = list.some((g) => g.attributes.uv);
    if (anyUV) for (const g of list) if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    const g = mergeGeometries(list, false);
    for (const x of list) x.dispose();
    this.lists[bucket] = [];
    if (g) g.computeBoundingSphere();
    return g;
  }
}

export class Soup {
  constructor(withUV = false) { this.p = []; this.n = []; this.c = []; this.uv = withUV ? [] : null; }
  quad(A, B, C, D, n, col, uvA, uvB, uvC, uvD) {
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
    const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const flip = cx * n[0] + cy * n[1] + cz * n[2] < 0;
    const verts = flip ? [A, C, B, A, D, C] : [A, B, C, A, C, D];
    const uvs = flip ? [uvA, uvC, uvB, uvA, uvD, uvC] : [uvA, uvB, uvC, uvA, uvC, uvD];
    for (let k = 0; k < 6; k++) {
      const v = verts[k];
      this.p.push(v[0], v[1], v[2]); this.n.push(n[0], n[1], n[2]); this.c.push(col.r, col.g, col.b);
      if (this.uv) { const t = uvs[k] || [0, 0]; this.uv.push(t[0], t[1]); }
    }
  }
}

export class Inst {
  constructor() { this.m = []; this.c = []; this.a = []; }
  add(matrix, color, extra) {
    for (let k = 0; k < 16; k++) this.m.push(matrix.elements[k]);
    _c.set(color === undefined ? 0xffffff : color);
    this.c.push(_c.r, _c.g, _c.b);
    if (extra) for (const e of extra) this.a.push(e);
  }
  get count() { return this.m.length / 16; }
}

// per-track sign/landmark atlas (rect packer)
export class Atlas {
  constructor(size) {
    this.size = size; this.scale = size / 2048;
    this.canvas = makeCanvas(size, size);
    this.g = this.canvas.getContext('2d');
    this.g.fillStyle = '#808080'; this.g.fillRect(0, 0, size, size);
    this.x = 4; this.y = 4; this.rowH = 0; this.pad = 6;
    this.cache = new Map();
  }
  add(key, w, h, draw) {
    if (key && this.cache.has(key)) return this.cache.get(key);
    const S = this.size, sc = this.scale;
    w = Math.ceil(w * sc); h = Math.ceil(h * sc);
    if (this.x + w + this.pad > S) { this.x = 4; this.y += this.rowH + this.pad; this.rowH = 0; }
    if (this.y + h > S) { console.warn('atlas full', key); return { u0: 0, v0: 0, u1: 0.001, v1: 0.001 }; }
    const g = this.g;
    g.save(); g.translate(this.x, this.y);
    g.beginPath(); g.rect(0, 0, w, h); g.clip();
    draw(g, w, h);
    g.restore();
    const r = { u0: (this.x + 0.5) / S, u1: (this.x + w - 0.5) / S, v1: 1 - (this.y + 0.5) / S, v0: 1 - (this.y + h - 0.5) / S };
    this.x += w + this.pad; this.rowH = Math.max(this.rowH, h);
    if (key) this.cache.set(key, r);
    return r;
  }
}

// ---------------------------------------------------------------- facade atlas
// Albedo 2048^2; emissive and aux at 1024^2 drawn with the same 2048-space coordinates.
// aux: R = how much the vertex tint colours this texel (painted walls), G = roughness.
const AS = 2048, TS = 128;
const AUX = {
  wall: 'rgb(255,232,0)', paint: 'rgb(0,215,0)', glass: 'rgb(0,28,0)', metal: 'rgb(0,105,0)', sign: 'rgb(0,140,0)',
  rough: 'rgb(0,245,0)', white: 'rgb(255,215,0)', gloss: 'rgb(255,70,0)', wood: 'rgb(0,200,0)',
};

class Painter {
  constructor(a, e, x, ca) { this.a = a; this.e = e; this.x = x; this.ca = ca; }
  F(X, Y, W, H, col, aux, em) {
    if (col) { this.a.fillStyle = col; this.a.fillRect(X, Y, W, H); }
    if (aux) { this.x.fillStyle = aux; this.x.fillRect(X, Y, W, H); }
    if (em) { this.e.fillStyle = em; this.e.fillRect(X, Y, W, H); }
  }
  S(path, col, aux, em) {
    for (const [g, c] of [[this.a, col], [this.x, aux], [this.e, em]]) {
      if (!c) continue;
      g.beginPath(); path(g); g.fillStyle = c; g.fill();
    }
  }
  V(X, Y, W, H, c0, c1) { // vertical gradient on albedo
    const g = this.a.createLinearGradient(0, Y, 0, Y + H);
    g.addColorStop(0, c0); g.addColorStop(1, c1);
    this.a.fillStyle = g; this.a.fillRect(X, Y, W, H);
  }
  H(X, Y, W, H, c0, c1) {
    const g = this.a.createLinearGradient(X, 0, X + W, 0);
    g.addColorStop(0, c0); g.addColorStop(1, c1);
    this.a.fillStyle = g; this.a.fillRect(X, Y, W, H);
  }
  emCopy(X, Y, W, H, dim = 0.4) {
    this.e.drawImage(this.ca, X, Y, W, H, X, Y, W, H);
    if (dim > 0) { this.e.fillStyle = `rgba(0,0,0,${dim})`; this.e.fillRect(X, Y, W, H); }
  }
}

function wallBase(P, X, Y, S, r, dark = 0, base = '#efebe3') {
  const a = P.a;
  a.fillStyle = base; a.fillRect(X, Y, S, S);
  for (let k = 0; k < 7; k++) {
    const cx = X + r() * S, cy = Y + r() * S, rr = S * (0.08 + r() * 0.25);
    const g = a.createRadialGradient(cx, cy, 0, cx, cy, rr);
    const al = 0.05 + r() * 0.1;
    g.addColorStop(0, r() < 0.55 ? `rgba(110,98,82,${al})` : `rgba(255,255,250,${al})`); g.addColorStop(1, 'rgba(0,0,0,0)');
    a.fillStyle = g; a.fillRect(X, Y, S, S);
  }
  for (let k = 0; k < 4; k++) {
    const sx = X + r() * S, sw = 2 + r() * 7, sl = S * (0.2 + r() * 0.6);
    const g = a.createLinearGradient(0, Y, 0, Y + sl);
    g.addColorStop(0, 'rgba(78,70,58,0.22)'); g.addColorStop(1, 'rgba(78,70,58,0)');
    a.fillStyle = g; a.fillRect(sx, Y, sw, sl);
  }
  a.fillStyle = 'rgba(0,0,0,0.08)'; a.fillRect(X, Y, S, 3);
  a.fillStyle = 'rgba(255,255,255,0.12)'; a.fillRect(X, Y + 3, S, 1);
  if (dark) { a.fillStyle = `rgba(0,0,0,${dark})`; a.fillRect(X, Y, S, S); }
}

function glassPane(P, X, Y, W, H, r, { lit = false, warm = true, tint = 0 } = {}) {
  const top = ['#6d8aa3', '#5d8a8a', '#7f97b0'][tint], bot = ['#26323f', '#1f3433', '#2c3442'][tint];
  P.V(X, Y, W, H, top, bot);
  P.F(X, Y, W, H, null, AUX.glass);
  const a = P.a;
  a.save(); a.beginPath(); a.rect(X, Y, W, H); a.clip();
  a.fillStyle = 'rgba(255,255,255,0.13)';
  a.beginPath(); a.moveTo(X + W * 0.15, Y + H); a.lineTo(X + W * 0.45, Y); a.lineTo(X + W * 0.62, Y); a.lineTo(X + W * 0.32, Y + H); a.fill();
  a.restore();
  if (lit) {
    const g = P.e.createLinearGradient(0, Y, 0, Y + H);
    g.addColorStop(0, warm ? '#ffd9a0' : '#e6f0ff'); g.addColorStop(1, warm ? '#e08f45' : '#9fbcdc');
    P.e.fillStyle = g; P.e.fillRect(X, Y, W, H);
  }
}

const RES_WIN = [
  { frame: '#dcdcd6', grill: 1, gcol: '#3b3b3b', curtain: '#c94f4f' },
  { frame: '#f4f4ef', grill: 0, curtain: '#e8c15a', wide: true },
  { frame: '#5b3c22', grill: 2, gcol: '#2f5d50', curtain: null },
  { frame: '#cfd3d4', grill: 3, gcol: '#1f3f6a', curtain: '#7aa6c9' },
  { frame: '#e9e9e4', grill: 1, gcol: '#6b2f2f', curtain: '#f2efe6', wide: true },
  { frame: '#3e5f8a', grill: 0, curtain: '#d98cb3' },
];
function resWindow(P, X, Y, S, r, o, lit) {
  wallBase(P, X, Y, S, r);
  const m = S / 3.2, v = S / 3.1;
  const ww = (o.wide ? 2.0 : 1.5) * m, wh = 1.35 * v, wx = X + (S - ww) / 2, wy = Y + S - 0.95 * v - wh;
  P.V(X, wy - 16, S, 16, 'rgba(0,0,0,0)', 'rgba(0,0,0,0.3)'); // sunshade shadow
  P.F(wx - 4, wy - 4, ww + 8, wh + 8, o.frame, AUX.paint);
  glassPane(P, wx, wy, ww, wh, r, { lit, warm: r() < 0.75 });
  if (o.curtain) {
    const cw = ww * (0.22 + r() * 0.12);
    for (const [cx, w] of [[wx, cw], [wx + ww - cw * 0.8, cw * 0.8]]) {
      P.F(cx, wy, w, wh, o.curtain, AUX.paint, lit ? shade(o.curtain, 0.55) : null);
      for (let k = 2; k < w; k += 4) P.F(cx + k, wy, 1, wh, 'rgba(0,0,0,0.18)');
    }
  }
  P.F(wx + ww / 2 - 1.5, wy, 3, wh, o.frame, AUX.paint, lit ? '#000' : null);
  const gc = o.gcol;
  if (o.grill === 1) for (let k = 4; k < ww; k += 7) P.F(wx + k, wy - 2, 2, wh + 4, gc, AUX.metal, lit ? '#000' : null);
  if (o.grill === 2) {
    for (let k = 5; k < ww; k += 9) P.F(wx + k, wy - 2, 2, wh + 4, gc, AUX.metal, lit ? '#000' : null);
    for (let k = 6; k < wh; k += 12) P.F(wx - 2, wy + k, ww + 4, 2, gc, AUX.metal, lit ? '#000' : null);
  }
  if (o.grill === 3) {
    for (let k = 6; k < ww; k += 10) P.F(wx + k, wy - 2, 2, wh + 4, gc, AUX.metal, lit ? '#000' : null);
    const a = P.a; a.strokeStyle = gc; a.lineWidth = 2;
    for (let k = 11; k < ww - 4; k += 20) { a.beginPath(); a.arc(wx + k, wy + wh * 0.5, 5, 0, TAU); a.stroke(); }
  }
  P.F(wx - 7, wy + wh + 4, ww + 14, 4, '#d1ccc2', AUX.paint);
  P.V(wx - 4, wy + wh + 8, 4, 18, 'rgba(70,60,48,0.3)', 'rgba(70,60,48,0)');
  P.V(wx + ww, wy + wh + 8, 4, 22, 'rgba(70,60,48,0.3)', 'rgba(70,60,48,0)');
}

const SHUTTER_COLS = ['#2f7f6f', '#3f6fa0', '#7a4a2a', '#2e6e3e', '#8a2f3f', '#2a5a8a', '#4c8c9c'];
function heritageWindow(P, X, Y, S, r, k) {
  wallBase(P, X, Y, S, r);
  const m = S / 3.2, v = S / 3.1;
  const ww = 1.25 * m, wh = 1.95 * v, wx = X + (S - ww) / 2, wb = Y + S - 0.42 * v;
  P.S((g) => archPath(g, wx - 7, wb + 4, ww + 14, wh + 11), '#f6efe0', AUX.paint);
  P.S((g) => { g.moveTo(wx + ww / 2 - 5, wb - wh - 9); g.lineTo(wx + ww / 2 + 5, wb - wh - 9); g.lineTo(wx + ww / 2 + 3, wb - wh + 2); g.lineTo(wx + ww / 2 - 3, wb - wh + 2); }, '#e6dcc6', AUX.paint);
  const open = k >= 5;
  if (open) {
    const lit = k >= 7;
    P.S((g) => archPath(g, wx, wb, ww, wh), '#2a1f18', AUX.paint, lit ? (k === 9 ? '#d8e8ff' : '#ffc77d') : null);
    const sc = SHUTTER_COLS[k % SHUTTER_COLS.length];
    for (const sx of [wx - ww * 0.5 - 6, wx + ww + 6 - ww * 0.0]) {
      P.F(sx, wb - wh * 0.78, ww * 0.5, wh * 0.78, sc, AUX.paint);
      for (let y = 3; y < wh * 0.78; y += 4) P.F(sx, wb - wh * 0.78 + y, ww * 0.5, 1, 'rgba(0,0,0,0.25)');
    }
    for (let q = 1; q < 4; q++) P.F(wx + (ww * q) / 4, wb - wh * 0.7, 1, wh * 0.7, '#5a5a5a', AUX.metal, lit ? '#000' : null);
  } else {
    const sc = SHUTTER_COLS[k % SHUTTER_COLS.length];
    P.S((g) => archPath(g, wx, wb, ww, wh), sc, AUX.paint);
    const a = P.a;
    a.save(); a.beginPath(); archPath(a, wx, wb, ww, wh); a.clip();
    for (let y = wb - wh; y < wb; y += 4) { a.fillStyle = 'rgba(0,0,0,0.22)'; a.fillRect(wx, y, ww, 1); a.fillStyle = 'rgba(255,255,255,0.1)'; a.fillRect(wx, y + 2, ww, 1); }
    a.fillStyle = 'rgba(0,0,0,0.35)'; a.fillRect(wx + ww / 2 - 1, wb - wh, 2, wh);
    // fanlight
    a.fillStyle = 'rgba(30,40,50,0.85)'; a.beginPath(); a.arc(wx + ww / 2, wb - wh + ww / 2, ww / 2 - 2, Math.PI, 0); a.fill();
    a.strokeStyle = '#efe6d2'; a.lineWidth = 1.5;
    for (let q = 0; q <= 4; q++) { const an = Math.PI + (q / 4) * Math.PI; a.beginPath(); a.moveTo(wx + ww / 2, wb - wh + ww / 2); a.lineTo(wx + ww / 2 + Math.cos(an) * (ww / 2 - 2), wb - wh + ww / 2 + Math.sin(an) * (ww / 2 - 2)); a.stroke(); }
    a.restore();
  }
  P.F(wx - 6, wb - 13, ww + 12, 2, '#222', AUX.metal);
  for (let q = 0; q <= 6; q++) P.F(wx - 6 + (q * (ww + 10)) / 6, wb - 13, 1.5, 13, '#222', AUX.metal);
  P.F(wx - 9, wb + 3, ww + 18, 4, '#e6dcc6', AUX.paint);
}

function cityGlass(P, X, Y, S, r, k) {
  const acp = ['#9aa4ad', '#3d5a80', '#c8ccd0', '#7d2e2e'][k >> 1], lit = k & 1;
  const v = S / 3.4;
  P.F(X, Y, S, S, '#c4c8cb', AUX.paint);
  P.F(X, Y + S - 0.95 * v, S, 0.95 * v, acp, AUX.metal);
  P.F(X, Y + S - 0.95 * v, S, 2, 'rgba(255,255,255,0.35)');
  const gy = Y + 0.3 * v, gh = S - 0.95 * v - 0.3 * v;
  glassPane(P, X, gy, S, gh, r, { lit: false, tint: 1 + (k & 1) });
  if (lit) {
    const g = P.e.createLinearGradient(0, gy, 0, gy + gh);
    g.addColorStop(0, '#f2f6ff'); g.addColorStop(1, '#a9bed6');
    P.e.fillStyle = g; P.e.fillRect(X, gy, S, gh);
    for (let q = 0; q < 3; q++) P.F(X + 10 + q * 40, gy + 4, 22, 2, '#ffffff', null, '#ffffff');
    for (let q = 0; q < 4; q++) P.F(X + 8 + r() * (S - 30), gy + gh - 18, 16 + r() * 10, 18, 'rgba(20,25,30,0.6)', null, 'rgba(0,0,0,0.6)');
  }
  for (const f of [0, 1 / 3, 2 / 3]) P.F(X + S * f - 2, gy, 4, gh, '#d5d9dc', AUX.metal, '#000');
  P.F(X, gy - 3, S, 4, '#d5d9dc', AUX.metal);
}

function shutterPaint(P, X, Y, W, H, col, r) {
  P.F(X, Y, W, H, col, AUX.metal);
  const a = P.a;
  for (let y = Y; y < Y + H; y += 3) { a.fillStyle = 'rgba(255,255,255,0.13)'; a.fillRect(X, y, W, 1); a.fillStyle = 'rgba(0,0,0,0.2)'; a.fillRect(X, y + 1.5, W, 1); }
  P.V(X, Y + H * 0.6, W, H * 0.4, 'rgba(90,70,50,0)', 'rgba(90,70,50,0.35)');
  for (let k = 0; k < 4; k++) { a.fillStyle = `rgba(120,60,30,${0.1 + r() * 0.2})`; a.fillRect(X + r() * W, Y + r() * H, 3 + r() * 8, 2 + r() * 5); }
  P.F(X, Y + H - 5, W, 5, shade(col, 0.55), AUX.metal);
  for (const f of [0.25, 0.75]) P.F(X + W * f - 4, Y + H - 12, 8, 4, '#2a2a2a', AUX.metal);
  P.F(X + W / 2 - 3, Y + H - 11, 6, 7, '#3a3226', AUX.metal);
}

const SHOP_PAL = {
  kirana: ['#e63946', '#f4a261', '#2a9d8f', '#e9c46a', '#8ecae6', '#ff66a8', '#6a994e', '#ffffff', '#ffb703'],
  sweets: ['#f4a261', '#ffd166', '#fffbea', '#e76f51', '#ffe8c2', '#c9813b'],
  medical: ['#ffffff', '#cfe8ff', '#e63946', '#2a9d8f', '#f1faee', '#a8dadc'],
  mobile: ['#1d3557', '#e63946', '#ffffff', '#457b9d', '#ffb703', '#111111'],
  hardware: ['#ff7b00', '#3a86ff', '#8d99ae', '#ffbe0b', '#2b2d42', '#e63946'],
  clothes: ['#d00070', '#ffbe0b', '#3a0ca3', '#06d6a0', '#ef476f', '#ffd6e0', '#118ab2'],
  bakery: ['#c97b3a', '#f2d0a4', '#8a4b20', '#fff1d0', '#e09f3e'],
  generic: ['#e76f51', '#2a9d8f', '#e9c46a', '#264653', '#f4a261', '#ffffff'],
};
function shopInterior(P, OX, OY, OW, OH, r, type) {
  const backs = { kirana: '#efe6cc', sweets: '#f6ead6', medical: '#f2f7f4', mobile: '#e1e9f6', hardware: '#ded8ca', clothes: '#f3e4ec', bakery: '#f7ecd6', generic: '#e8e3d8' };
  const pal = SHOP_PAL[type];
  P.F(OX, OY, OW, OH, backs[type], AUX.paint);
  P.V(OX, OY, OW, OH * 0.3, 'rgba(0,0,0,0.25)', 'rgba(0,0,0,0)');
  for (let row = 0; row < 3; row++) {
    const sy = OY + 10 + row * OH * 0.19 + OH * 0.15;
    P.F(OX + 2, sy, OW - 4, 2, type === 'medical' || type === 'mobile' ? '#c9ced3' : '#8a6a48', AUX.paint);
    for (let xx = OX + 3; xx < OX + OW - 5;) {
      const iw = 2 + r() * 5, ih = 3 + r() * OH * 0.11;
      P.F(xx, sy - ih, iw, ih, pick(r, pal), AUX.paint);
      xx += iw + 0.6 + r() * 1.4;
    }
  }
  const cy = OY + OH * 0.66;
  P.F(OX + 3, cy, OW - 6, OH * 0.34, type === 'sweets' || type === 'mobile' ? '#9fb4bf' : '#b59a72', AUX.paint);
  P.F(OX + 3, cy, OW - 6, 3, '#e8e8e8', AUX.metal);
  if (type === 'sweets' || type === 'bakery' || type === 'mobile' || type === 'medical') {
    for (let q = 0; q < 6; q++) P.F(OX + 6 + q * (OW - 12) / 6, cy + 6, (OW - 12) / 6 - 3, 6, pick(r, pal), AUX.paint);
  }
  if (type === 'kirana' || type === 'generic' || type === 'hardware') {
    for (let s = 0; s < 3; s++) {
      const sx = OX + 6 + r() * (OW - 12);
      for (let q = 0; q < 5; q++) P.F(sx, OY + 8 + q * 7, 6, 6, pick(r, pal), AUX.paint);
    }
  }
  if (type === 'clothes') for (let q = 0; q < 7; q++) P.F(OX + 4 + q * (OW - 8) / 7, OY + 8, (OW - 8) / 7 - 2, OH * 0.45, pick(r, pal), AUX.paint);
  P.emCopy(OX, OY, OW, OH, 0.4);
  P.F(OX + OW * 0.2, OY + 3, OW * 0.6, 3, '#ffffff', AUX.paint, '#ffffff');
}

function farTile(P, X, Y, S, r, kind, k) {
  wallBase(P, X, Y, S, r, 0);
  const half = S / 2;
  for (let q = 0; q < 4; q++) {
    const cx = X + (q % 2) * half, cy = Y + Math.floor(q / 2) * half;
    const lit = r() < 0.45;
    P.F(cx, cy, half, 2, 'rgba(0,0,0,0.12)');
    if (kind === 'city') {
      glassPane(P, cx + 1, cy + 6, half - 2, half - 18, r, { lit, warm: false, tint: 1 });
      P.F(cx, cy + half - 12, half, 12, k ? '#3d5a80' : '#9aa4ad', AUX.metal);
    } else if (kind === 'heritage') {
      const ww = half * 0.42, wh = half * 0.62, wx = cx + (half - ww) / 2, wb = cy + half - 6;
      P.S((g) => archPath(g, wx - 3, wb + 2, ww + 6, wh + 5), '#f6efe0', AUX.paint);
      P.S((g) => archPath(g, wx, wb, ww, wh), lit ? '#2a1f18' : SHUTTER_COLS[(q + k) % 7], AUX.paint, lit ? '#ffc77d' : null);
    } else {
      const ww = half * 0.5, wh = half * 0.42, wx = cx + (half - ww) / 2, wy = cy + half * 0.25;
      P.V(cx, wy - 6, half, 6, 'rgba(0,0,0,0)', 'rgba(0,0,0,0.3)');
      P.F(wx - 2, wy - 2, ww + 4, wh + 4, '#dedcd5', AUX.paint);
      glassPane(P, wx, wy, ww, wh, r, { lit, warm: r() < 0.7 });
      for (let g = 3; g < ww; g += 5) P.F(wx + g, wy, 1, wh, '#3b3b3b', AUX.metal, lit ? '#000' : null);
      if (r() < 0.3) P.F(wx + ww + 3, wy + wh - 6, 9, 7, '#e9eae6', AUX.paint);
    }
  }
}

// ---------------------------------------------------------------- signboards
// [name, sub, bg, fg, style, gujarati]
const SIGN_SHOPS = [
  ['SHREE GANESH SWEETS', 'PENDA • BARFI • FARSAN', '#ffcc00', '#b3001b', 'guj', 'શ્રી ગણેશ સ્વીટ્સ'],
  ['JALARAM MEDICAL', '24 HOURS CHEMIST & DRUGGIST', '#0b7a43', '#ffffff', 'guj', 'જલારામ મેડિકલ'],
  ['PATEL HARDWARE', 'PAINTS • PLUMBING • TOOLS', '#1d4e89', '#ffd60a', 'guj', 'પટેલ હાર્ડવેર'],
  ['BARODA MOBILE ZONE', 'RECHARGE • REPAIR • ACCESSORIES', '#e00034', '#ffffff', 'flex'],
  ['KHAMAN HOUSE', 'KHAMAN • DHOKLA • SEV KHAMANI', '#ffd60a', '#7a1414', 'guj', 'ખમણ હાઉસ'],
  ['SHREE KRISHNA KIRANA STORES', 'GROCERY • DAILY NEEDS', '#f77f00', '#ffffff', 'board'],
  ['JAY AMBE ELECTRICALS', 'FANS • LIGHTS • WIRING', '#ffffff', '#c1121f', 'guj', 'જય અંબે ઈલેક્ટ્રિકલ્સ'],
  ['OM SAI XEROX', 'PRINT • LAMINATION • SPIRAL', '#03045e', '#ffffff', 'flex'],
  ['KHODIYAR AUTO PARTS', 'ALL 2 & 4 WHEELER PARTS', '#212529', '#ffd60a', 'board'],
  ['LAXMI SAREE CENTRE', 'BANDHANI • PATOLA • CHANIYA CHOLI', '#9d0208', '#ffd166', 'flex'],
  ['NAVRANG TAILORS', 'GENTS & LADIES', '#00b4d8', '#03045e', 'board'],
  ['SAYAJI CYCLE MART', 'SALES & SERVICE', '#2b9348', '#ffffff', 'board'],
  ['RAJ BAKERY', 'CAKES • KHARI • PUFF', '#6f1d1b', '#ffe6a7', 'flex'],
  ['AMBIKA PAN CENTRE', 'MEETHA PAN SPECIAL', '#2d6a4f', '#fff3b0', 'board'],
  ['VISHAL OPTICIANS', 'EYE TESTING FREE', '#ffffff', '#1d3557', 'flex'],
  ['GURUKRUPA JEWELLERS', 'HALLMARK GOLD • SILVER', '#5a0b2c', '#ffd166', 'flex'],
  ['SHIV SHAKTI STEEL', 'UTENSILS • KITCHENWARE', '#c0c4c8', '#111111', 'board'],
  ['UMIYA FOOTWEAR', 'CHAPPAL • SHOES • SANDALS', '#ff5d8f', '#ffffff', 'flex'],
  ['NEW INDIA PHOTO STUDIO', 'PASSPORT PHOTO IN 5 MIN', '#3a0ca3', '#ffd60a', 'board'],
  ["DR. MEHTA'S CLINIC", 'OPD 10 TO 1 • 5 TO 8', '#ffffff', '#0b6e4f', 'board'],
  ['HARI OM HAIR SALON', 'AC • UNISEX', '#111111', '#ff9f1c', 'flex'],
  ['SIDDHI VINAYAK TYRES', 'ALIGNMENT • BALANCING', '#ffb703', '#023047', 'board'],
  ['RADHE KRISHNA DAIRY', 'MILK • GHEE • PANEER', '#caf0f8', '#0077b6', 'guj', 'રાધે કૃષ્ણ ડેરી'],
  ['BHAGYODAY RESTAURANT', 'PURE VEG • GUJARATI THALI', '#e85d04', '#ffffff', 'guj', 'ભાગ્યોદય'],
  ['GAYATRI BOOK STALL', 'SCHOOL BOOKS • STATIONERY', '#ffd60a', '#1b4332', 'board'],
  ['SURTI LOCHO HOUSE', 'HOT • FRESH • TASTY', '#ff006e', '#ffffff', 'flex'],
];
const SIGN_APTS = [
  ['SHIV KRUPA APARTMENT', '', '#7a1f1f', '#ffd27a', 'apt'], ['GOKUL DHAM SOCIETY', '', '#f2eee4', '#1d3557', 'apt'],
  ['AKSHAR RESIDENCY', '', '#1d3557', '#ffffff', 'apt'], ['SURYA COMPLEX', '', '#f2eee4', '#9d0208', 'apt'],
  ['SAMARPAN FLATS', '', '#2d6a4f', '#ffffff', 'apt'], ['SHANTI NIKETAN', '', '#f2eee4', '#5a3e1b', 'apt'],
  ['RAJ PLAZA', '', '#111111', '#ffd60a', 'apt'], ['SHREEJI ARCADE', '', '#f2eee4', '#3a0ca3', 'apt'],
];
const SIGN_IND = [
  ['SHREE GANESH ENGINEERING WORKS', 'GIDC MAKARPURA • VADODARA', '#0b4f9c', '#ffffff', 'factory'],
  ['BARODA FORGINGS PVT. LTD.', 'PLOT NO. 412, GIDC', '#ffffff', '#0b4f9c', 'factory'],
  ['MAHAVIR PLASTICS', 'INJECTION MOULDING', '#c1121f', '#ffffff', 'factory'],
  ['GUJARAT CHEMICALS LTD.', 'SAFETY FIRST', '#ffffff', '#2b9348', 'factory'],
  ['PATEL TRANSPORT CO.', 'DAILY SERVICE • ALL GUJARAT', '#ffb703', '#111111', 'factory'],
  ['GIDC MAKARPURA', 'GUJARAT INDUSTRIAL DEVELOPMENT CORPORATION', '#0b6e4f', '#ffffff', 'factory'],
];
const SIGN_ROAD = [
  ['PUNJABI DHABA', 'PURE VEG • 24 HRS • FAMILY ROOM', '#c1121f', '#ffd60a', 'flex'],
  ['CITY FUEL STATION', 'PETROL • DIESEL • CNG', '#ffffff', '#0b4f9c', 'factory'],
  ['INDIAN ARMY', 'EME CENTRE • VADODARA', '#24361c', '#ffd23f', 'army'],
  ['MILITARY AREA', 'DRIVE SLOWLY • NO PHOTOGRAPHY', '#24361c', '#ffffff', 'army'],
  ['AUTO STAND', 'VADODARA MAHANAGAR SEVA SADAN', '#0b4f9c', '#ffffff', 'muni'],
  ['BUS STOP', 'VADODARA CITY BUS SERVICE', '#0b6e4f', '#ffffff', 'muni'],
  ['CHAI', 'KADAK MASALA CHAI ₹10', '#f77f00', '#ffffff', 'guj', 'ચા'],
  ['HORN OK PLEASE', 'USE DIPPER AT NIGHT', '#ffd400', '#c1121f', 'truck'],
];

function drawSign(P, X, Y, W, H, sp, r, lit) {
  const [name, sub, bg, fg, style, gu] = sp;
  const a = P.a;
  P.F(X, Y, W, H, bg, AUX.sign);
  if (style === 'flex') {
    P.H(X, Y, W, H, 'rgba(255,255,255,0.12)', 'rgba(0,0,0,0.28)');
    a.fillStyle = 'rgba(255,255,255,0.14)'; a.beginPath(); a.arc(X + W * 0.92, Y + H * 0.2, H * 0.9, 0, TAU); a.fill();
    const ex = X + H * 0.55, ey = Y + H * 0.48, er = H * 0.36;
    a.fillStyle = fg; a.beginPath(); a.arc(ex, ey, er, 0, TAU); a.fill();
    fitText(a, name[0], ex, ey + 1, er * 1.4, er * 1.3, { color: bg });
    fitText(a, name, X + W * 0.56, Y + H * 0.38, W * 0.76, H * 0.5, { color: fg, stroke: 'rgba(0,0,0,0.35)', strokeW: 3 });
    P.F(X, Y + H * 0.7, W, H * 0.3, 'rgba(0,0,0,0.3)');
    fitText(a, sub, X + W * 0.56, Y + H * 0.85, W * 0.76, H * 0.22, { color: '#ffffff', weight: '800', family: FONT2 });
  } else if (style === 'guj') {
    a.strokeStyle = fg; a.lineWidth = 2; a.strokeRect(X + 4, Y + 4, W - 8, H - 8);
    fitText(a, gu, X + W / 2, Y + H * 0.36, W * 0.88, H * 0.42, { color: fg, weight: '700', family: FONT_GU });
    fitText(a, name, X + W / 2, Y + H * 0.76, W * 0.8, H * 0.28, { color: fg });
  } else if (style === 'apt') {
    a.strokeStyle = fg; a.lineWidth = 2; a.strokeRect(X + 6, Y + 6, W - 12, H - 12);
    fitText(a, name, X + W / 2, Y + H * 0.54, W * 0.88, H * 0.56, { color: fg, weight: '700', family: FONT_SERIF });
  } else if (style === 'army') {
    for (let k = 0; k < 6; k++) { P.F(X + k * 10, Y, 5, H, k % 2 ? '#ffd23f' : '#c1121f'); P.F(X + W - 6 - k * 10, Y, 5, H, k % 2 ? '#ffd23f' : '#c1121f'); }
    P.F(X + 62, Y, W - 124, H, bg);
    fitText(a, name, X + W / 2, Y + H * 0.4, W * 0.7, H * 0.48, { color: fg });
    fitText(a, sub, X + W / 2, Y + H * 0.8, W * 0.7, H * 0.2, { color: '#ffffff', weight: '800', family: FONT2 });
  } else if (style === 'muni') {
    a.strokeStyle = '#ffffff'; a.lineWidth = 3; roundRect(a, X + 5, Y + 5, W - 10, H - 10, 6); a.stroke();
    fitText(a, name, X + W / 2, Y + H * 0.42, W * 0.8, H * 0.46, { color: fg });
    fitText(a, sub, X + W / 2, Y + H * 0.78, W * 0.8, H * 0.18, { color: fg, weight: '700', family: FONT2 });
  } else if (style === 'truck') {
    for (let k = 0; k < 14; k++) { a.fillStyle = pick(r, ['#c1121f', '#2b9348', '#1d4e89', '#ff006e']); a.beginPath(); a.arc(X + 10 + k * (W - 20) / 13, Y + 8, 4, 0, TAU); a.fill(); a.beginPath(); a.arc(X + 10 + k * (W - 20) / 13, Y + H - 8, 4, 0, TAU); a.fill(); }
    fitText(a, name, X + W / 2, Y + H * 0.45, W * 0.86, H * 0.42, { color: fg, stroke: '#ffffff', strokeW: 3 });
    fitText(a, sub, X + W / 2, Y + H * 0.74, W * 0.6, H * 0.14, { color: '#1b1b1b', weight: '800', family: FONT2 });
  } else if (style === 'factory') {
    P.F(X, Y + H - 9, W, 5, fg === '#ffffff' ? '#ffd60a' : '#c1121f');
    fitText(a, name, X + W / 2, Y + H * 0.4, W * 0.92, H * 0.46, { color: fg });
    fitText(a, sub, X + W / 2, Y + H * 0.72, W * 0.8, H * 0.18, { color: fg, weight: '700', family: FONT2 });
  } else { // board
    a.strokeStyle = fg; a.lineWidth = 3; a.strokeRect(X + 5, Y + 5, W - 10, H - 10);
    a.lineWidth = 1; a.strokeRect(X + 10, Y + 10, W - 20, H - 20);
    fitText(a, name, X + W / 2, Y + H * 0.43, W * 0.86, H * 0.42, { color: fg });
    fitText(a, sub, X + W / 2, Y + H * 0.74, W * 0.7, H * 0.17, { color: fg, weight: '700', family: FONT2 });
  }
  P.V(X, Y, W, H, 'rgba(255,255,255,0.06)', 'rgba(60,40,20,0.14)');
  if (lit) P.emCopy(X, Y, W, H, 0.12);
}

let _FA = null;
export function facadeAtlas(aniso = 4) {
  if (_FA) return _FA;
  const t0 = performance.now();
  const ca = makeCanvas(AS, AS), ce = makeCanvas(AS / 2, AS / 2), cx = makeCanvas(AS / 2, AS / 2);
  const a = ca.getContext('2d'), e = ce.getContext('2d'), x = cx.getContext('2d');
  e.setTransform(0.5, 0, 0, 0.5, 0, 0); x.setTransform(0.5, 0, 0, 0.5, 0, 0);
  a.fillStyle = '#d8d4cc'; a.fillRect(0, 0, AS, AS);
  e.fillStyle = '#000'; e.fillRect(0, 0, AS, AS);
  x.fillStyle = AUX.wall; x.fillRect(0, 0, AS, AS);
  const r = mulberry32(90210);
  const P = new Painter(a, e, x, ca);
  const T = {};
  let slot = 0;
  const uvr = (X, Y, W, H, pad = 3) => ({ u0: (X + pad) / AS, u1: (X + W - pad) / AS, v0: 1 - (Y + H - pad) / AS, v1: 1 - (Y + pad) / AS });
  const tile = (name, n, draw) => {
    T[name] = [];
    for (let k = 0; k < n; k++) {
      const s = slot++;
      const X = (s % 16) * TS, Y = Math.floor(s / 16) * TS;
      for (const g of [a, e, x]) { g.save(); g.beginPath(); g.rect(X, Y, TS, TS); g.clip(); }
      draw(X, Y, TS, k);
      for (const g of [a, e, x]) g.restore();
      T[name].push(uvr(X, Y, TS, TS));
    }
  };
  const S = TS, m = S / 3.2;

  tile('wall', 4, (X, Y, S, k) => {
    wallBase(P, X, Y, S, r);
    if (k === 1) { P.F(X + S * 0.78, Y, 5, S, '#9aa0a3', AUX.paint); for (let y = 10; y < S; y += 30) P.F(X + S * 0.78 - 1, Y + y, 7, 3, '#7d8386', AUX.paint); }
    if (k === 2) { P.F(X + 20, Y + S * 0.45, 26, 30, '#c9c9c4', AUX.paint); P.F(X + 23, Y + S * 0.45 + 4, 20, 10, '#2b2b2b', AUX.paint); P.F(X + 30, Y, 2, S * 0.45, '#222', AUX.metal); }
    if (k === 3) for (let q = 0; q < 5; q++) P.F(X + 6 + r() * (S - 40), Y + S * 0.5 + r() * S * 0.3, 18 + r() * 14, 22 + r() * 10, pick(r, ['#ffd60a', '#e63946', '#ffffff', '#00b4d8', '#ff66a8']), AUX.paint);
  });
  tile('win', 12, (X, Y, S, k) => resWindow(P, X, Y, S, r, RES_WIN[k >> 1], k & 1));
  tile('winH', 10, (X, Y, S, k) => heritageWindow(P, X, Y, S, r, k));
  tile('winC', 8, (X, Y, S, k) => cityGlass(P, X, Y, S, r, k));
  tile('bdoor', 6, (X, Y, S, k) => {
    wallBase(P, X, Y, S, r, 0.12);
    const lit = k & 1, v = S / 3.1;
    const dcol = ['#6b4423', '#d9d9d4', '#2f5d50'][k >> 1];
    const dx = X + 0.35 * m, dw = 0.95 * m, dh = 2.15 * v, dy = Y + S - dh;
    P.F(dx - 3, dy - 3, dw + 6, dh + 3, '#e2ddd2', AUX.paint);
    if (k >> 1 === 1) { glassPane(P, dx, dy, dw, dh, r, { lit }); P.F(dx + dw / 2 - 1, dy, 2, dh, dcol, AUX.metal); }
    else { P.F(dx, dy, dw, dh, dcol, AUX.wood); for (let q = 0; q < 3; q++) P.F(dx + 4, dy + 6 + q * dh / 3, dw - 8, dh / 3 - 10, 'rgba(0,0,0,0.18)'); }
    const wx = X + 1.65 * m, ww = 1.2 * m, wy = Y + S - 2.15 * v, wh = 1.2 * v;
    P.F(wx - 3, wy - 3, ww + 6, wh + 6, '#e2ddd2', AUX.paint);
    glassPane(P, wx, wy, ww, wh, r, { lit, warm: true });
    for (let g = 4; g < ww; g += 6) P.F(wx + g, wy, 2, wh, '#333', AUX.metal, lit ? '#000' : null);
  });
  // balcony parapet bands: 2 tiles x 3 bands (each band ~1 m tall)
  T.balc = [];
  for (let t = 0; t < 2; t++) {
    const s = slot++;
    const X = (s % 16) * TS, Y = Math.floor(s / 16) * TS, bh = TS / 3;
    for (let b = 0; b < 3; b++) {
      const by = Y + b * bh, kind = t * 3 + b;
      for (const g of [a, e, x]) { g.save(); g.beginPath(); g.rect(X, by, TS, bh); g.clip(); }
      if (kind === 1 || kind === 4) { // solid parapet (tinted) with coping
        wallBase(P, X, by - 40, TS, r);
        P.F(X, by, TS, 5, '#f1efe9', AUX.paint);
        P.F(X, by + 5, TS, 2, 'rgba(0,0,0,0.25)');
        if (kind === 4) for (let q = 0; q < 6; q++) P.F(X + 4 + q * 21, by + 12, 14, 14, 'rgba(0,0,0,0.12)');
      } else {
        P.F(X, by, TS, bh, '#4d4842', AUX.paint);
        P.V(X, by, TS, bh, 'rgba(0,0,0,0.25)', 'rgba(0,0,0,0)');
        const gc = ['#2b2b2b', '#2f5d50', '#5a3a22', '#c0c4c8', '#2b2b2b', '#6b2f2f'][kind];
        if (kind === 3) { // steel pipes
          for (const yy of [3, 15, 27]) { P.F(X, by + yy, TS, 3, '#e8ecef', AUX.metal); P.F(X, by + yy, TS, 1, '#ffffff'); }
          for (const xx of [2, 62, 122]) P.F(X + xx, by, 4, bh, '#d0d4d8', AUX.metal);
        } else if (kind === 2) { // wooden balustrade
          P.F(X, by, TS, 5, '#6b4423', AUX.wood); P.F(X, by + bh - 5, TS, 5, '#6b4423', AUX.wood);
          for (let q = 3; q < TS; q += 8) { P.F(X + q, by + 5, 4, bh - 10, '#7c5130', AUX.wood); P.F(X + q + 1, by + bh / 2 - 3, 2, 6, '#5a3a1f'); }
        } else {
          P.F(X, by, TS, 4, gc, AUX.metal); P.F(X, by + bh - 4, TS, 4, gc, AUX.metal);
          for (let q = 2; q < TS; q += 6) P.F(X + q, by, 2, bh, gc, AUX.metal);
          if (kind === 0) { a.strokeStyle = gc; a.lineWidth = 2; for (let q = 8; q < TS; q += 24) { a.beginPath(); a.arc(X + q, by + bh / 2, 7, 0, TAU); a.stroke(); } }
          if (kind === 5) for (let q = 0; q < 6; q++) P.F(X + 4 + q * 20 + r() * 6, by + 3, 12 + r() * 6, 14 + r() * 12, pick(r, ['#e63946', '#ffb703', '#219ebc', '#ff66a8', '#8ac926', '#ffffff', '#7b2cbf']), AUX.paint);
        }
      }
      for (const g of [a, e, x]) g.restore();
      T.balc.push(uvr(X, by, TS, bh, 2));
    }
  }
  const SH_COL = ['#9aa0a4', '#7f8a92', '#3b6ea5', '#2e7d4f', '#8a3b3b'];
  tile('shutter', 5, (X, Y, S, k) => { wallBase(P, X, Y, S, r); P.F(X + 5, Y + 6, S - 10, 8, '#6d7377', AUX.metal); shutterPaint(P, X + 6, Y + 14, S - 12, S - 14, SH_COL[k], r); });
  const OPEN_T = ['kirana', 'sweets', 'medical', 'mobile', 'hardware', 'clothes', 'bakery', 'generic', 'kirana', 'sweets'];
  tile('shopHalf', 3, (X, Y, S, k) => {
    wallBase(P, X, Y, S, r);
    shopInterior(P, X + 6, Y + 10, S - 12, S - 10, r, OPEN_T[k + 2]);
    shutterPaint(P, X + 6, Y + 10, S - 12, S * 0.42, SH_COL[k + 1], r);
  });
  tile('shopOpen', 10, (X, Y, S, k) => {
    wallBase(P, X, Y, S, r);
    P.F(X + 5, Y + 6, S - 10, 5, '#6d7377', AUX.metal);
    shopInterior(P, X + 6, Y + 11, S - 12, S - 11, r, OPEN_T[k]);
    P.F(X + 6, Y + S - 3, S - 12, 3, '#8f8a80', AUX.paint);
  });
  tile('shopGlass', 4, (X, Y, S, k) => {
    wallBase(P, X, Y, S, r);
    const bg = ['#f4f1ea', '#1d1d24', '#f6e9ef', '#e9f1f6'][k];
    P.F(X + 5, Y + 8, S - 10, S - 8, bg, AUX.paint);
    for (let q = 0; q < 4; q++) {
      const mx = X + 16 + q * 28, my = Y + S * 0.4;
      if (k === 1) { P.F(mx - 6, my + 10, 20, 26, pick(r, ['#e63946', '#ffffff', '#00b4d8']), AUX.paint); continue; }
      P.F(mx, my, 10, 40, pick(r, ['#d00070', '#ffbe0b', '#3a0ca3', '#06d6a0', '#ef476f', '#118ab2']), AUX.paint);
      a.fillStyle = '#e8d2b8'; a.beginPath(); a.arc(mx + 5, my - 6, 5, 0, TAU); a.fill();
    }
    P.emCopy(X + 5, Y + 8, S - 10, S - 8, 0.25);
    glassPane(P, X + 5, Y + 8, S - 10, S - 8, r, {});
    P.a.fillStyle = 'rgba(255,240,220,0.25)'; P.a.fillRect(X + 5, Y + 8, S - 10, S - 8);
    for (const f of [0, 0.5, 1]) P.F(X + 4 + (S - 10) * f - 2, Y + 8, 4, S - 8, '#c9ced3', AUX.metal);
    P.F(X + 4, Y + 6, S - 8, 4, '#c9ced3', AUX.metal);
  });
  tile('woodShop', 3, (X, Y, S, k) => {
    wallBase(P, X, Y, S, r);
    if (k < 2) {
      shopInterior(P, X + 22, Y + 12, S - 44, S - 12, r, k ? 'sweets' : 'kirana');
      const wc = ['#7a4a2a', '#2f7f6f'][k];
      for (const sx of [X + 6, X + S - 22]) { P.F(sx, Y + 12, 16, S - 12, wc, AUX.wood); for (let q = 3; q < 16; q += 5) P.F(sx + q, Y + 12, 1, S - 12, 'rgba(0,0,0,0.25)'); }
      P.F(X + 22, Y + S - 22, S - 44, 22, '#6b4423', AUX.wood);
    } else {
      P.F(X + 6, Y + 12, S - 12, S - 12, '#5d6b4a', AUX.wood);
      for (let q = 0; q < S - 12; q += 7) P.F(X + 6 + q, Y + 12, 2, S - 12, 'rgba(0,0,0,0.3)');
      for (const yy of [0.3, 0.7]) P.F(X + 6, Y + 12 + (S - 12) * yy, S - 12, 3, '#2b2b2b', AUX.metal);
    }
    P.F(X + 4, Y + 6, S - 8, 6, '#5a3a22', AUX.wood);
  });
  tile('stair', 2, (X, Y, S, k) => {
    wallBase(P, X, Y, S, r);
    const dx = X + 30, dw = 68;
    P.F(dx, Y + 18, dw, S - 18, '#2c2a27', AUX.paint, k ? '#3a3020' : null);
    for (let q = 0; q < 8; q++) P.F(dx + 4 + q * 3, Y + S - 10 - q * 9, dw - 8, 3, '#55524c', AUX.paint);
    for (let q = 0; q < dw; q += 8) P.F(dx + q, Y + 18, 2, S - 18, '#8d9296', AUX.metal);
    for (let q = 0; q < 2; q++) { a.strokeStyle = '#8d9296'; a.lineWidth = 1.5; for (let z = 0; z < dw; z += 8) { a.beginPath(); a.moveTo(dx + z, Y + 30 + q * 50); a.lineTo(dx + z + 8, Y + 60 + q * 50); a.stroke(); } }
    P.F(X + 4, Y + 40, 20, 34, '#c9c9c4', AUX.paint); P.F(X + 7, Y + 44, 14, 8, '#2b2b2b', AUX.paint);
  });
  tile('stilt', 2, (X, Y, S, k) => {
    P.F(X, Y, S, S, '#3f3c37', AUX.paint);
    P.V(X, Y, S, S, 'rgba(0,0,0,0.45)', 'rgba(0,0,0,0.05)');
    P.F(X, Y + S - 6, S, 6, '#77736b', AUX.paint);
    for (const cx of [X, X + S - 12]) { P.F(cx, Y, 12, S, '#e9e5dd', null); P.F(cx, Y, 12, S, null, AUX.wall); }
    for (let q = 0; q < 2 + k; q++) {
      const sx = X + 20 + q * 34, sy = Y + S - 28;
      const c = pick(r, ['#c8102e', '#1f4fa8', '#f2f2f0', '#1b1b1f', '#9aa3ad']);
      P.F(sx, sy + 6, 24, 12, c, AUX.metal); P.F(sx + 2, sy, 12, 7, '#151515', AUX.paint);
      a.fillStyle = '#111'; a.beginPath(); a.arc(sx + 4, sy + 22, 5, 0, TAU); a.arc(sx + 21, sy + 22, 5, 0, TAU); a.fill();
    }
    P.F(X + 30, Y + 8, 60, 2, '#fff', AUX.paint, '#ffffff');
  });
  tile('houseG', 2, (X, Y, S, k) => {
    wallBase(P, X, Y, S, r);
    const dx = X + 12, dw = 40, dh = 92;
    P.F(dx - 4, Y + S - dh - 4, dw + 8, dh + 4, '#e5dfd2', AUX.paint);
    P.F(dx, Y + S - dh, dw, dh, k ? '#6b4423' : '#7a2e2e', AUX.wood);
    for (let q = 0; q < 4; q++) P.F(dx + 4 + (q % 2) * 18, Y + S - dh + 6 + Math.floor(q / 2) * 42, 14, 36, 'rgba(0,0,0,0.2)');
    resWindowSmall(P, X + 66, Y + 40, 50, 42, r);
    P.F(X, Y + S - 4, S, 4, '#9a958c', AUX.paint);
  });
  tile('farR', 4, (X, Y, S, k) => farTile(P, X, Y, S, r, 'res', k));
  tile('farC', 2, (X, Y, S, k) => farTile(P, X, Y, S, r, 'city', k));
  tile('farH', 2, (X, Y, S, k) => farTile(P, X, Y, S, r, 'heritage', k));
  tile('roof', 2, (X, Y, S, k) => {
    P.F(X, Y, S, S, k ? '#a7a39b' : '#94918a', AUX.rough);
    for (let q = 0; q < 10; q++) {
      const cx = X + r() * S, cy = Y + r() * S, rr = 8 + r() * 30;
      const g = a.createRadialGradient(cx, cy, 0, cx, cy, rr);
      g.addColorStop(0, r() < 0.5 ? 'rgba(240,240,235,0.35)' : 'rgba(40,36,30,0.25)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      a.fillStyle = g; a.fillRect(X, Y, S, S);
    }
    a.strokeStyle = 'rgba(0,0,0,0.12)'; a.lineWidth = 1;
    for (let q = 0; q < S; q += 16) { a.beginPath(); a.moveTo(X + q, Y); a.lineTo(X + q, Y + S); a.stroke(); a.beginPath(); a.moveTo(X, Y + q); a.lineTo(X + S, Y + q); a.stroke(); }
  });
  tile('brick', 1, (X, Y, S) => {
    P.F(X, Y, S, S, '#b9a99a', AUX.rough);
    for (let row = 0; row < S / 6; row++) for (let c = -1; c < S / 14; c++) {
      const bx = X + c * 14 + (row % 2) * 7, by = Y + row * 6;
      P.F(bx + 1, by + 1, 12, 4, pick(r, ['#a5532f', '#9b4a2a', '#b25d36', '#8e4426', '#b8673f']));
    }
  });
  tile('concrete', 1, (X, Y, S) => {
    P.F(X, Y, S, S, '#aaa59b', AUX.rough);
    for (let q = 0; q < S; q += 21) P.F(X, Y + q, S, 1, 'rgba(0,0,0,0.12)');
    for (let q = 0; q < 12; q++) P.F(X + r() * S, Y + r() * S, 2 + r() * 10, 1 + r() * 3, 'rgba(60,55,45,0.2)');
  });
  tile('constr', 2, (X, Y, S, k) => {
    P.F(X, Y, S, S, '#3d3a35', AUX.rough);
    P.V(X, Y, S, S * 0.4, 'rgba(0,0,0,0.4)', 'rgba(0,0,0,0)');
    P.F(X, Y, S, 10, '#aaa59b', AUX.rough);
    P.F(X, Y, 10, S, '#aaa59b', AUX.rough); P.F(X + S - 10, Y, 10, S, '#aaa59b', AUX.rough);
    if (k) { for (let q = 0; q < 5; q++) P.F(X + 10, Y + S - 6 - q * 7, S - 20, 6, '#a5532f'); }
    a.strokeStyle = '#b08850'; a.lineWidth = 2;
    for (let q = 0; q < 3; q++) { a.beginPath(); a.moveTo(X + 14 + q * 36, Y + S); a.lineTo(X + 40 + q * 36, Y + 12); a.stroke(); }
    if (!k) { a.fillStyle = 'rgba(30,110,60,0.55)'; a.fillRect(X + 10, Y + 10, S * 0.45, S - 10); }
  });
  tile('ac', 1, (X, Y, S) => {
    P.F(X, Y, S, S, '#e9eae6', AUX.paint);
    P.V(X, Y, S, S, 'rgba(255,255,255,0.2)', 'rgba(0,0,0,0.12)');
    a.fillStyle = '#3a3d40'; a.beginPath(); a.arc(X + S * 0.4, Y + S / 2, S * 0.33, 0, TAU); a.fill();
    a.strokeStyle = '#8c9196'; a.lineWidth = 2;
    for (let q = 0; q < 8; q++) { const an = q * TAU / 8; a.beginPath(); a.moveTo(X + S * 0.4, Y + S / 2); a.lineTo(X + S * 0.4 + Math.cos(an) * S * 0.3, Y + S / 2 + Math.sin(an) * S * 0.3); a.stroke(); }
    for (let q = 0; q < 4; q++) { a.beginPath(); a.arc(X + S * 0.4, Y + S / 2, S * (0.08 + q * 0.07), 0, TAU); a.stroke(); }
    for (let q = 0; q < 8; q++) P.F(X + S * 0.8, Y + 18 + q * 11, S * 0.14, 4, '#c5c8c4');
  });
  tile('white', 1, (X, Y, S) => P.F(X, Y, S, S, '#ffffff', AUX.white));
  tile('gloss', 1, (X, Y, S) => P.F(X, Y, S, S, '#ffffff', AUX.gloss));
  tile('dark', 1, (X, Y, S) => P.F(X, Y, S, S, '#1e1e1e', AUX.paint));
  tile('door', 2, (X, Y, S, k) => {
    P.F(X, Y, S, S, k ? '#7a2e2e' : '#6b4423', AUX.wood);
    for (let q = 0; q < 4; q++) P.F(X + 10 + (q % 2) * 58, Y + 10 + Math.floor(q / 2) * 60, 50, 50, 'rgba(0,0,0,0.2)');
    P.F(X + S - 18, Y + S / 2, 6, 10, '#d4a937', AUX.metal);
  });
  tile('gate', 1, (X, Y, S) => {
    P.F(X, Y, S, S, '#34322e', AUX.paint);
    for (let q = 2; q < S; q += 9) P.F(X + q, Y, 3, S, '#1f3f2f', AUX.metal);
    for (const yy of [6, S / 2, S - 10]) P.F(X, Y + yy, S, 4, '#1f3f2f', AUX.metal);
    for (let q = 2; q < S; q += 9) { a.fillStyle = '#1f3f2f'; a.beginPath(); a.moveTo(X + q - 2, Y + 6); a.lineTo(X + q + 1.5, Y); a.lineTo(X + q + 5, Y + 6); a.fill(); }
  });
  tile('jali', 1, (X, Y, S) => {
    wallBase(P, X, Y, S, r);
    for (let yy = 8; yy < S - 8; yy += 14) for (let xx = 8; xx < S - 8; xx += 14) { a.fillStyle = '#2a2723'; a.beginPath(); a.arc(X + xx + 5, Y + yy + 5, 5, 0, TAU); a.fill(); }
  });
  tile('awning', 4, (X, Y, S, k) => {
    const c = [['#c1121f', '#ffffff'], ['#1d4e89', '#ffffff'], ['#2b9348', '#ffd60a'], ['#f77f00', '#fff3b0']][k];
    for (let q = 0; q < 8; q++) P.F(X + q * 16, Y, 16, S, c[q % 2], AUX.paint);
    P.V(X, Y, S, S, 'rgba(0,0,0,0.15)', 'rgba(255,255,255,0.08)');
    for (let q = 0; q < 8; q++) { a.fillStyle = 'rgba(0,0,0,0.25)'; a.beginPath(); a.arc(X + q * 16 + 8, Y + S, 8, Math.PI, 0); a.fill(); }
  });
  tile('tarp', 1, (X, Y, S) => {
    P.F(X, Y, S, S, '#1f6fb5', AUX.metal);
    for (let q = 0; q < 9; q++) { a.strokeStyle = `rgba(255,255,255,${0.08 + r() * 0.12})`; a.lineWidth = 2 + r() * 4; a.beginPath(); a.moveTo(X + r() * S, Y); a.lineTo(X + r() * S, Y + S); a.stroke(); }
  });
  tile('corr', 3, (X, Y, S, k) => {
    if (k === 2) { P.F(X, Y, S, S, '#9aa0a4', AUX.metal); shutterPaint(P, X + 4, Y + 4, S - 8, S - 4, '#8d969b', r); return; }
    P.F(X, Y, S, S, '#e2e5e7', null);
    for (let q = 0; q < S; q += 6) { P.F(X + q, Y, 2, S, 'rgba(255,255,255,0.35)'); P.F(X + q + 3, Y, 2, S, 'rgba(0,0,0,0.16)'); }
    for (let q = 0; q < 5; q++) P.V(X + r() * S, Y + r() * S * 0.5, 3 + r() * 5, S * 0.5, 'rgba(140,70,30,0.25)', 'rgba(140,70,30,0)');
    if (k === 1) { P.F(X, Y + S * 0.3, S, S * 0.22, '#7a8a90', AUX.glass); for (let q = 0; q < S; q += 16) P.F(X + q, Y + S * 0.3, 2, S * 0.22, '#3b3f42', AUX.metal); P.F(X, Y + S * 0.3, S, S * 0.22, null, null, '#5b5030'); }
    P.F(X, Y + S - 10, S, 10, '#8e8a82', AUX.rough);
  });
  tile('sheet', 2, (X, Y, S, k) => {
    P.F(X, Y, S, S, k ? '#8a5a3c' : '#8f969b', AUX.metal);
    for (let q = 0; q < S; q += 7) { P.F(X + q, Y, 2, S, 'rgba(255,255,255,0.18)'); P.F(X + q + 4, Y, 2, S, 'rgba(0,0,0,0.2)'); }
    for (let q = 0; q < 8; q++) P.F(X + r() * S, Y + r() * S, 4 + r() * 14, 3 + r() * 20, `rgba(${k ? '60,30,10' : '120,70,40'},${0.15 + r() * 0.2})`);
  });
  tile('tiles', 2, (X, Y, S, k) => {
    P.F(X, Y, S, S, k ? '#9c4a2a' : '#b5562f', AUX.rough);
    for (let row = 0; row < S / 10; row++) {
      for (let c = 0; c < S / 12 + 1; c++) {
        const tx = X + c * 12 + (row % 2) * 6, ty = Y + row * 10;
        a.fillStyle = pick(r, ['#c2643a', '#a9502d', '#b85b33', '#9a4527', '#c97046']);
        a.beginPath(); a.ellipse(tx + 6, ty + 5, 6, 6, 0, 0, Math.PI); a.fill();
      }
      P.F(X, Y + row * 10 + 9, S, 1, 'rgba(0,0,0,0.3)');
    }
    for (let q = 0; q < 6; q++) P.F(X + r() * S, Y + r() * S, 10 + r() * 20, 6 + r() * 10, 'rgba(40,40,30,0.18)');
  });
  tile('barrack', 3, (X, Y, S, k) => {
    wallBase(P, X, Y, S, r, 0, '#f5f3ec');
    P.F(X, Y + S - 22, S, 22, '#4a4a46', AUX.paint);
    P.F(X, Y + S - 24, S, 2, '#2e2e2c', AUX.paint);
    if (k === 2) return;
    const wx = X + 30, ww = 68, wy = Y + 26, wh = k ? 92 : 58;
    P.F(wx - 4, wy - 4, ww + 8, wh + 8, '#ffffff', AUX.paint);
    if (k === 1) { P.F(wx, wy, ww, wh + 10, '#7a2e2e', AUX.wood); P.F(wx + ww / 2 - 1, wy, 2, wh + 10, '#4a1d1d'); }
    else {
      P.F(wx, wy, ww, wh, '#2e5e3a', AUX.wood);
      for (let y = 4; y < wh; y += 5) P.F(wx, wy + y, ww, 1, 'rgba(0,0,0,0.3)');
      P.F(wx + ww / 2 - 1, wy, 2, wh, '#173020');
    }
    P.F(wx - 8, wy - 12, ww + 16, 6, '#e2ded4', AUX.paint);
  });
  tile('lattice', 1, (X, Y, S) => {
    P.F(X, Y, S, S, '#5d646a', AUX.metal);
    a.strokeStyle = '#e8b81f'; a.lineWidth = 6;
    a.strokeRect(X + 3, Y - 4, S - 6, S + 8);
    a.lineWidth = 3;
    for (let q = -S; q < S; q += 32) { a.beginPath(); a.moveTo(X + 3, Y + q); a.lineTo(X + S - 3, Y + q + 32); a.stroke(); a.beginPath(); a.moveTo(X + S - 3, Y + q); a.lineTo(X + 3, Y + q + 32); a.stroke(); }
    P.F(X, Y, 8, S, '#e8b81f', AUX.paint); P.F(X + S - 8, Y, 8, S, '#e8b81f', AUX.paint);
  });
  tile('stall', 2, (X, Y, S, k) => {
    P.F(X, Y, S, S, '#3a2e26', AUX.wood);
    P.F(X, Y + S * 0.55, S, S * 0.45, k ? '#2a6f97' : '#8a5a2b', AUX.wood);
    for (let q = 0; q < 4; q++) P.F(X, Y + S * 0.6 + q * 12, S, 2, 'rgba(0,0,0,0.25)');
    for (let q = 0; q < 3; q++) { a.fillStyle = '#c9ced3'; a.beginPath(); a.ellipse(X + 24 + q * 34, Y + S * 0.45, 12, 15, 0, 0, TAU); a.fill(); P.F(X + 22 + q * 34, Y + S * 0.45 - 22, 4, 8, '#9aa0a6'); }
    for (let q = 0; q < 7; q++) P.F(X + 8 + q * 16, Y + S * 0.3, 8, 12, 'rgba(230,230,220,0.85)');
    for (let q = 0; q < 6; q++) P.F(X + 6 + q * 20, Y + 8, 14, 16, pick(r, ['#ffd166', '#e63946', '#f4a261', '#2a9d8f']), AUX.paint);
    P.emCopy(X, Y, S, S * 0.55, 0.45);
    a.fillStyle = '#fff6d0'; a.beginPath(); a.arc(X + S / 2, Y + 6, 5, 0, TAU); a.fill();
  });
  tile('dispenser', 1, (X, Y, S) => {
    P.F(X, Y, S, S, '#f2f2f0', AUX.paint);
    P.F(X, Y, S, 22, '#0b4f9c', AUX.paint);
    P.F(X, Y + S - 26, S, 8, '#ffd60a', AUX.paint);
    P.F(X + 20, Y + 34, S - 40, 34, '#111111', AUX.glass, '#000');
    for (let q = 0; q < 2; q++) fitText(a, q ? '1.00 L' : '₹ 104.50', X + S / 2, Y + 44 + q * 15, S - 50, 13, { color: '#7dff7a', weight: '700', family: 'monospace' });
    P.emCopy(X + 20, Y + 34, S - 40, 34, 0);
    P.F(X + 10, Y + 76, 14, 30, '#222', AUX.metal); P.F(X + S - 24, Y + 76, 14, 30, '#222', AUX.metal);
  });
  tile('poster', 1, (X, Y, S) => {
    wallBase(P, X, Y, S, r);
    for (let q = 0; q < 6; q++) {
      const pw = 26 + r() * 20, ph = 34 + r() * 14, px = X + r() * (S - pw), py = Y + 20 + r() * (S - ph - 30);
      P.F(px, py, pw, ph, pick(r, ['#ffd60a', '#e63946', '#ffffff', '#00b4d8', '#ff66a8', '#2b9348']), AUX.paint);
      P.F(px + 3, py + 4, pw - 6, ph * 0.4, pick(r, ['#1d3557', '#9d0208', '#3a0ca3', '#111']));
      P.F(px + 3, py + ph * 0.6, pw - 6, 4, 'rgba(0,0,0,0.5)');
    }
  });
  tile('compound', 2, (X, Y, S, k) => {
    wallBase(P, X, Y, S, r);
    P.F(X, Y, S, 10, k ? '#9d3b2a' : '#f1efe9', AUX.paint);
    P.F(X, Y + 10, S, 3, 'rgba(0,0,0,0.2)');
    for (let q = 0; q < S; q += 32) P.F(X + q, Y + 13, 3, S - 13, 'rgba(0,0,0,0.06)');
  });
  tile('glassBlue', 2, (X, Y, S, k) => {
    glassPane(P, X, Y, S, S, r, { tint: 2 });
    for (let q = 0; q <= S; q += S / 4) { P.F(X + q - 2, Y, 3, S, '#c9ced3', AUX.metal, '#000'); P.F(X, Y + q - 2, S, 3, '#c9ced3', AUX.metal, '#000'); }
    if (k) { const g = P.e.createLinearGradient(0, Y, 0, Y + S); g.addColorStop(0, '#fff3d6'); g.addColorStop(1, '#d9a35f'); P.e.fillStyle = g; P.e.fillRect(X, Y, S, S); for (let q = 0; q <= S; q += S / 4) { P.F(X + q - 2, Y, 3, S, null, null, '#000'); } }
  });
  tile('farShed', 1, (X, Y, S) => {
    P.F(X, Y, S, S, '#dfe2e4', null);
    for (let q = 0; q < S; q += 4) { P.F(X + q, Y, 1, S, 'rgba(255,255,255,0.3)'); P.F(X + q + 2, Y, 1, S, 'rgba(0,0,0,0.14)'); }
    P.F(X, Y + S * 0.35, S, S * 0.12, '#6f7d82', AUX.glass);
  });

  // ---- signboards: 512 x 80 cells, 4 per row, starting at y = 1024
  const signs = { shop: [], apt: [], ind: [], road: [] };
  let sk = 0;
  const signCell = (sp, lit) => {
    const X = (sk % 4) * 512, Y = 1024 + Math.floor(sk / 4) * 80; sk++;
    for (const g of [a, e, x]) { g.save(); g.beginPath(); g.rect(X, Y, 512, 80); g.clip(); }
    drawSign(P, X + 2, Y + 2, 508, 76, sp, r, lit);
    for (const g of [a, e, x]) g.restore();
    return uvr(X + 2, Y + 2, 508, 76, 2);
  };
  for (const sp of SIGN_SHOPS) signs.shop.push(signCell(sp, true));
  for (const sp of SIGN_APTS) signs.apt.push(signCell(sp, false));
  for (const sp of SIGN_IND) signs.ind.push(signCell(sp, true));
  for (const sp of SIGN_ROAD) signs.road[sp[0]] = signCell(sp, sp[4] !== 'army' && sp[4] !== 'truck');

  grain(a, AS, AS, 9, mulberry32(77));
  const alb = canvasTex(ca, { aniso });
  const em = canvasTex(ce, { aniso: Math.min(aniso, 4) });
  const aux = canvasTex(cx, { srgb: false, aniso });
  alb.generateMipmaps = true;
  _FA = { alb, em, aux, T, signs, ms: performance.now() - t0 };
  return _FA;
}

function resWindowSmall(P, wx, wy, ww, wh, r) {
  P.F(wx - 3, wy - 3, ww + 6, wh + 6, '#e2ddd2', AUX.paint);
  glassPane(P, wx, wy, ww, wh, r, {});
  for (let g = 4; g < ww; g += 6) P.F(wx + g, wy, 2, wh, '#333', AUX.metal);
}

// material for every merged street mesh: albedo x vertex tint (masked by aux.r), roughness from aux.g
export function facadeMaterial(FA, { emissive = 0, wet = false } = {}) {
  const mat = new THREE.MeshStandardMaterial({
    map: FA.alb, emissiveMap: FA.em, roughnessMap: FA.aux, emissive: 0xffffff, emissiveIntensity: emissive,
    vertexColors: true, roughness: wet ? 0.7 : 1, metalness: 0, envMapIntensity: wet ? 0.9 : 0.55,
  });
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', `
      vec4 fAux = texture2D( roughnessMap, vRoughnessMapUv );
      #if defined( USE_COLOR )
        diffuseColor.rgb *= mix( vec3( 1.0 ), vColor, fAux.r );
      #endif`);
  };
  mat.customProgramCacheKey = () => 'la-facade';
  return mat;
}

// ---------------------------------------------------------------- quad soup in a local building frame
export class FSoup {
  constructor() { this.P = []; this.N = []; this.U = []; this.C = []; this.I = []; this.n = 0; this.cs = 1; this.sn = 0; this.ox = 0; this.oz = 0; this.oy = 0; this.sc = 1; }
  frame(x, z, ry, y = 0, sc = 1) { this.ox = x; this.oz = z; this.oy = y; this.sc = sc; this.cs = Math.cos(ry); this.sn = Math.sin(ry); return this; }
  wx(lx, lz) { return this.ox + (lx * this.cs + lz * this.sn) * this.sc; }
  wz(lx, lz) { return this.oz + (-lx * this.sn + lz * this.cs) * this.sc; }
  _v(x, y, z, nx, ny, nz, u, v, col) {
    const cs = this.cs * this.sc, sn = this.sn * this.sc;
    this.P.push(this.ox + x * cs + z * sn, this.oy + y * this.sc, this.oz - x * sn + z * cs);
    const cs1 = this.cs, sn1 = this.sn;
    this.N.push(nx * cs1 + nz * sn1, ny, -nx * sn1 + nz * cs1);
    this.U.push(u, v);
    this.C.push(col.r, col.g, col.b);
  }
  // a = bottom-left, b = bottom-right, c = top-right, d = top-left, seen from the side the normal points to
  q(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz, r, col, us0 = 0, us1 = 1, vs0 = 0, vs1 = 1) {
    const du = r.u1 - r.u0, dv = r.v1 - r.v0;
    const u0 = r.u0 + du * us0, u1 = r.u0 + du * us1, v0 = r.v0 + dv * vs0, v1 = r.v0 + dv * vs1;
    const n = this.n;
    this._v(ax, ay, az, nx, ny, nz, u0, v0, col);
    this._v(bx, by, bz, nx, ny, nz, u1, v0, col);
    this._v(cx, cy, cz, nx, ny, nz, u1, v1, col);
    this._v(dx, dy, dz, nx, ny, nz, u0, v1, col);
    this.I.push(n, n + 1, n + 2, n, n + 2, n + 3);
    this.n += 4;
  }
  // quad with computed normal (for slopes / gables); d may equal c for a triangle
  qa(A, B, C, D, r, col, us0 = 0, us1 = 1, vs0 = 0, vs1 = 1) {
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
    const vx = D[0] - A[0], vy = D[1] - A[1], vz = D[2] - A[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    this.q(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2], D[0], D[1], D[2], nx, ny, nz, r, col, us0, us1, vs0, vs1);
  }
  // face rectangle of an axis-aligned box: side f/b/r/l, s = along-face coordinate, k = plane coordinate
  fq(side, s0, s1, y0, y1, k, r, col, vs0 = 0, vs1 = 1, us0 = 0, us1 = 1) {
    let ax, az, bx, bz, nx = 0, nz = 0;
    if (side === 'f') { ax = s0; az = k; bx = s1; bz = k; nz = 1; }
    else if (side === 'b') { ax = -s0; az = k; bx = -s1; bz = k; nz = -1; }
    else if (side === 'r') { ax = k; az = -s0; bx = k; bz = -s1; nx = 1; }
    else { ax = k; az = s0; bx = k; bz = s1; nx = -1; }
    this.q(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az, nx, 0, nz, r, col, us0, us1, vs0, vs1);
  }
  // axis-aligned box; faces bitmask f=1 b=2 r=4 l=8 t=16 bottom=32; rf = optional front rect, rt = top rect
  box(x0, y0, z0, x1, y1, z1, r, col, faces = 63, rf = null, rt = null) {
    if (faces & 1) this.fq('f', x0, x1, y0, y1, z1, rf || r, col);
    if (faces & 2) this.fq('b', -x1, -x0, y0, y1, z0, r, col);
    if (faces & 4) this.fq('r', -z1, -z0, y0, y1, x1, r, col);
    if (faces & 8) this.fq('l', z0, z1, y0, y1, x0, r, col);
    if (faces & 16) this.q(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, 0, 1, 0, rt || r, col);
    if (faces & 32) this.q(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, 0, -1, 0, r, col);
  }
  // vertical cylinder (sides + optional top) around local (x,z)
  cyl(x, y0, z, rad, h, seg, r, col, top = true, radTop = rad) {
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * TAU, a1 = ((k + 1) / seg) * TAU;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const am = (a0 + a1) / 2;
      this.q(x + c1 * rad, y0, z + s1 * rad, x + c0 * rad, y0, z + s0 * rad, x + c0 * radTop, y0 + h, z + s0 * radTop, x + c1 * radTop, y0 + h, z + s1 * radTop,
        Math.cos(am), 0, Math.sin(am), r, col, k / seg, (k + 1) / seg, 0, 1);
    }
    if (top) for (let k = 0; k < seg; k += 2) {
      const a0 = (k / seg) * TAU, a1 = ((k + 1) / seg) * TAU, a2 = ((k + 2) / seg) * TAU;
      this.qa([x, y0 + h, z], [x + Math.cos(a2) * radTop, y0 + h, z + Math.sin(a2) * radTop], [x + Math.cos(a1) * radTop, y0 + h, z + Math.sin(a1) * radTop], [x + Math.cos(a0) * radTop, y0 + h, z + Math.sin(a0) * radTop], r, col, 0.4, 0.6, 0.4, 0.6);
    }
  }
  get empty() { return this.n === 0; }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.U, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.I, 1) : new THREE.Uint16BufferAttribute(this.I, 1));
    g.computeBoundingSphere();
    this.P = this.N = this.U = this.C = this.I = null;
    return g;
  }
}

// ---------------------------------------------------------------- palettes
export const PALETTES = {
  suburb: ['#f2d8a7', '#f4c09a', '#efe7d6', '#f5e19a', '#cfe0b4', '#bcd6ea', '#f0c6c0', '#e6d3b3', '#ffffff', '#e2b07a', '#f7efe2', '#d7e3e8'],
  heritage: ['#5fb8b0', '#e88aa0', '#f0c75e', '#d99b4a', '#b8d46a', '#7fb3e0', '#f2eee6', '#d9b38a', '#c9a0dc', '#ff9f6e', '#e9d8a6', '#8fd1c5', '#f2a7a7'],
  city: ['#d9dde2', '#e8dcc4', '#c9b79c', '#e3e6e8', '#a8c0b8', '#d6c2a8', '#f0ede6', '#c4a88a', '#b9c6d2'],
  cantonment: ['#f5f3ec', '#efe6cf', '#f1eadb', '#e9e4d6'],
  outskirts: ['#f2d8a7', '#f4c09a', '#efe7d6', '#cfe0b4', '#bcd6ea', '#f0c6c0', '#e6d3b3', '#ffffff', '#f5e19a'],
  industrial: ['#d6dbe0', '#bcc8d4', '#9fb8c8', '#c9d3c0', '#e4e2dc', '#a9b7c6', '#d8cfc0'],
};
const CONCRETE = new THREE.Color('#cfcac0');

// ---------------------------------------------------------------- Streetscape: generators
export class Streetscape {
  constructor(world, cell = 150) {
    this.W = world;
    this.FA = facadeAtlas(world.aniso);
    this.T = this.FA.T;
    this.signs = this.FA.signs;
    this.cell = cell;
    this.chunks = new Map();
    this.fronts = []; // points on building fronts that service wires can reach
    this.tris = 0;
  }
  key(x, z) { return Math.floor(x / this.cell) + ',' + Math.floor(z / this.cell); }
  soup(x, z) {
    const k = this.key(x, z);
    let s = this.chunks.get(k);
    if (!s) { s = new FSoup(); this.chunks.set(k, s); }
    return s;
  }
  at(x, z, ry, y = 0) { return this.soup(x, z).frame(x, z, ry, y); }
  tank(S, lx, y, lz, scale = 1) {
    const x = S.wx(lx, lz), z = S.wz(lx, lz);
    this.W.I.tank.add(L(x, y, z, 0, scale, scale, scale), '#232323');
  }
  meshes(mat) {
    const out = [];
    for (const [key, s] of this.chunks) {
      if (s.empty) continue;
      this.tris += s.I.length / 3;
      const m = new THREE.Mesh(s.build(), mat);
      m.userData.chunk = key;
      out.push(m);
    }
    this.chunks.clear();
    return out;
  }

  // ---------------------------------------------------------- the main building generator
  // frame origin = front-centre at ground; building occupies x in [-w/2, w/2], z in [-d, 0]; +z faces the road
  building(cx, cz, ry, o) {
    const S = this.at(cx, cz, ry), T = this.T, rnd = o.rnd;
    const w = o.w, d = o.d, floors = Math.max(1, o.floors), kind = o.kind || 'res';
    const tint = new THREE.Color(o.tint || '#efe7d6');
    const ground = o.ground || 'shop';
    const gh = ground === 'shop' ? 4.0 : kind === 'heritage' ? 3.4 : 3.2;
    const fh = kind === 'city' ? 3.4 : 3.1;
    const H = gh + (floors - 1) * fh;
    const detail = o.detail ?? 2;
    if (detail === 0) return this.farBuilding(S, w, d, H, kind, tint, rnd, o.tankP ?? 0.5);
    const nb = Math.max(1, Math.round(w / 3.2)), bw = w / nb;
    const nd = Math.max(1, Math.round(d / 3.2)), bd = d / nd;
    const wall = T.wall, white = T.white[0];
    const winSet = kind === 'city' ? T.winC : kind === 'heritage' ? T.winH : T.win;
    const design = Math.floor(rnd() * (kind === 'city' ? 4 : kind === 'heritage' ? 5 : 6));
    const design2 = Math.floor(rnd() * (kind === 'city' ? 4 : kind === 'heritage' ? 5 : 6));
    const litP = o.litP ?? 0.45;
    const winTile = (i) => {
      const dd = (i % 3 === 1) ? design2 : design;
      if (kind === 'heritage') return winSet[rnd() < 0.55 ? dd : 5 + Math.floor(rnd() * 5)];
      return winSet[dd * 2 + (rnd() < litP ? 1 : 0)];
    };
    const concrete = CONCRETE.clone().lerp(tint, 0.25);

    // ---- front face
    const shopTiles = kind === 'heritage' ? [...T.woodShop, ...T.shopOpen.slice(0, 4), ...T.shutter.slice(0, 3)] : [...T.shopOpen, ...T.shopOpen, ...T.shutter, ...T.shopHalf, ...(kind === 'city' ? [...T.shopGlass, ...T.shopGlass] : T.shopGlass.slice(0, 1))];
    if (detail === 2) {
      // ground floor
      let i = 0;
      while (i < nb) {
        const x0 = -w / 2 + i * bw;
        if (ground === 'shop') {
          const span = Math.min(nb - i, (rnd() < 0.35 && nb - i >= 2) ? 2 : 1);
          const x1 = x0 + span * bw;
          for (let j = 0; j < span; j++) {
            const t = (i === 0 && nb > 2 && o.stair !== false && j === 0 && rnd() < 0.5) ? pick(rnd, T.stair) : pick(rnd, shopTiles);
            S.fq('f', x0 + j * bw, x0 + (j + 1) * bw, 0, 2.95, 0, t, tint);
          }
          S.fq('f', x0, x1, 2.95, gh, 0, wall[0], tint, 0, (gh - 2.95) / 3.1);
          // signboard
          const sr = o.signs ? pick(rnd, o.signs) : pick(rnd, this.signs.shop);
          const sh = span > 1 ? 1.05 : 0.85;
          S.box(x0 + 0.12, 3.02, 0.02, x1 - 0.12, 3.02 + sh, 0.2, T.dark[0], tint, 1 | 4 | 8 | 16, sr);
          // awning in the old city / sometimes elsewhere
          if (kind === 'heritage' ? rnd() < 0.55 : rnd() < 0.2) {
            const aw = pick(rnd, rnd() < 0.3 ? T.tarp : T.awning);
            S.qa([x0 + 0.1, 2.95, 0.05], [x1 - 0.1, 2.95, 0.05], [x1 - 0.1, 2.35, 1.5], [x0 + 0.1, 2.35, 1.5], aw, tint);
            S.qa([x0 + 0.1, 2.35, 1.5], [x1 - 0.1, 2.35, 1.5], [x1 - 0.1, 2.95, 0.05], [x0 + 0.1, 2.95, 0.05], aw, tint);
          }
          i += span;
        } else {
          const t = ground === 'stilt' ? pick(rnd, T.stilt) : ground === 'house' ? (i === Math.floor(nb / 2) ? T.houseG[0] : pick(rnd, T.win)) : pick(rnd, wall);
          S.fq('f', x0, x0 + bw, 0, gh, 0, t, tint, 0, Math.min(1, gh / 3.1));
          i++;
        }
      }
      // shop chajja (concrete sunshade) right above the shutters
      if (ground === 'shop') S.box(-w / 2, 2.82, 0, w / 2, 2.95, 0.85, white, concrete, 1 | 4 | 8 | 16 | 32);
      // upper floors
      const balcP = o.balc ?? (kind === 'city' ? 0.08 : kind === 'heritage' ? 0.25 : 0.3);
      const acP = o.ac ?? (kind === 'heritage' ? 0.12 : 0.3);
      const balcBand = kind === 'heritage' ? [T.balc[2], T.balc[1], T.balc[0]] : [T.balc[0], T.balc[1], T.balc[3], T.balc[4], T.balc[5]];
      const bandA = pick(rnd, balcBand), bandB = pick(rnd, balcBand);
      const balcCols = new Set();
      for (let i2 = 0; i2 < nb; i2++) if (rnd() < balcP) balcCols.add(i2);
      const fullBalc = kind === 'heritage' && rnd() < 0.45; // continuous wooden balcony on the first floor
      for (let f = 1; f < floors; f++) {
        const y0 = gh + (f - 1) * fh;
        for (let i2 = 0; i2 < nb; i2++) {
          const x0 = -w / 2 + i2 * bw, x1 = x0 + bw;
          const balc = (balcCols.has(i2) && (f + i2) % 3 !== 0) || (fullBalc && f === 1);
          if (balc && kind !== 'heritage') S.fq('f', x0, x1, y0, y0 + fh, 0, pick(rnd, T.bdoor), tint);
          else S.fq('f', x0, x1, y0, y0 + fh, 0, winTile(i2), tint);
          if (balc && !(fullBalc && f === 1)) {
            const band = (i2 + f) % 2 ? bandA : bandB;
            S.box(x0 + 0.08, y0 - 0.02, 0, x1 - 0.08, y0 + 0.14, 1.15, white, concrete, 1 | 4 | 8 | 16 | 32);
            S.box(x0 + 0.08, y0 + 0.14, 1.03, x1 - 0.08, y0 + 1.1, 1.15, band, tint, 1 | 2 | 16, band);
            S.box(x0 + 0.08, y0 + 0.14, 0, x0 + 0.2, y0 + 1.1, 1.03, band, tint, 4 | 8 | 16);
            S.box(x1 - 0.2, y0 + 0.14, 0, x1 - 0.08, y0 + 1.1, 1.03, band, tint, 4 | 8 | 16);
          } else if (!balc && rnd() < acP && kind !== 'heritage') {
            const ax = x0 + bw * (rnd() < 0.5 ? 0.2 : 0.8);
            S.box(ax - 0.42, y0 + 0.25, 0, ax + 0.42, y0 + 0.85, 0.34, white, new THREE.Color('#e4e5e1'), 1 | 4 | 8 | 16 | 32, T.ac[0]);
          }
        }
        if (fullBalc && f === 1) {
          // overhanging wooden balcony with brackets (pol house)
          S.box(-w / 2 + 0.05, y0 - 0.05, 0, w / 2 - 0.05, y0 + 0.12, 1.0, T.door[0], tint, 1 | 4 | 8 | 16 | 32);
          S.box(-w / 2 + 0.05, y0 + 0.12, 0.92, w / 2 - 0.05, y0 + 1.05, 1.0, T.balc[2], tint, 1 | 2 | 16, T.balc[2]);
          for (let x = -w / 2 + 0.4; x < w / 2; x += 1.6) S.qa([x - 0.06, y0 - 0.9, 0.01], [x + 0.06, y0 - 0.9, 0.01], [x + 0.06, y0 - 0.05, 0.85], [x - 0.06, y0 - 0.05, 0.85], T.door[0], tint);
        }
        // sunshade over the windows of this floor
        if (kind !== 'city') S.box(-w / 2, y0 + 2.45, 0, w / 2, y0 + 2.53, kind === 'heritage' ? 0.35 : 0.5, white, concrete, 1 | 4 | 8 | 16 | 32);
        else S.box(-w / 2, y0 - 0.05, 0, w / 2, y0 + 0.2, 0.15, white, concrete, 1 | 16 | 32);
      }
      this.fronts.push([S.wx(0, 0.1), S.wz(0, 0.1), Math.min(H - 0.5, 6.2)]);
    } else {
      // detail 1: windows on a coarse grid, no ground-floor shops
      for (let i = 0; i < nb; i++) {
        const x0 = -w / 2 + i * bw;
        S.fq('f', x0, x0 + bw, 0, gh, 0, ground === 'stilt' ? T.stilt[0] : ground === 'shop' ? pick(rnd, T.shutter) : pick(rnd, wall), tint);
        for (let f = 1; f < floors; f++) S.fq('f', x0, x0 + bw, gh + (f - 1) * fh, gh + f * fh, 0, winTile(i), tint);
      }
    }

    // ---- sides and back
    const sideWin = !o.party && detail === 2;
    for (const side of ['r', 'l']) {
      const k = side === 'r' ? w / 2 : -w / 2;
      const s0 = side === 'r' ? 0 : -d;
      if (!sideWin) {
        S.fq(side, s0, s0 + d, 0, H, k, wall[0], tint, 0, 1, 0, 1);
        continue;
      }
      for (let j = 0; j < nd; j++) {
        const a0 = s0 + j * bd, a1 = a0 + bd;
        S.fq(side, a0, a1, 0, gh, k, pick(rnd, wall), tint, 0, Math.min(1, gh / 3.1));
        for (let f = 1; f < floors; f++) S.fq(side, a0, a1, gh + (f - 1) * fh, gh + f * fh, k, (j + f) % 2 ? winTile(j) : wall[(j + f) % 4 === 0 ? 1 : 0], tint);
      }
    }
    if (detail === 2 && !o.party && o.kind !== 'heritage') {
      for (let i = 0; i < nb; i++) S.fq('b', -w / 2 + i * bw, -w / 2 + (i + 1) * bw, 0, H, -d, wall[0], tint, 0, 1);
    } else S.fq('b', -w / 2, w / 2, 0, H, -d, wall[0], tint, 0, 1);

    // ---- roof
    this.roof(S, w, d, H, o, tint, rnd, detail);
    return H;
  }

  roof(S, w, d, H, o, tint, rnd, detail) {
    const T = this.T;
    if (o.roof === 'tile') {
      const rh = Math.min(3.2, d * 0.32), ov = 0.5;
      const tr = pick(rnd, T.tiles), col = new THREE.Color('#ffffff');
      S.qa([-w / 2 - 0.2, H, ov], [w / 2 + 0.2, H, ov], [w / 2 + 0.2, H + rh, -d / 2], [-w / 2 - 0.2, H + rh, -d / 2], tr, col);
      S.qa([w / 2 + 0.2, H, -d - ov], [-w / 2 - 0.2, H, -d - ov], [-w / 2 - 0.2, H + rh, -d / 2], [w / 2 + 0.2, H + rh, -d / 2], tr, col);
      S.qa([w / 2, H, 0], [w / 2, H, -d], [w / 2, H + rh, -d / 2], [w / 2, H + rh, -d / 2], T.wall[0], tint, 0, 1, 0, 0.5);
      S.qa([-w / 2, H, -d], [-w / 2, H, 0], [-w / 2, H + rh, -d / 2], [-w / 2, H + rh, -d / 2], T.wall[0], tint, 0, 1, 0, 0.5);
      return;
    }
    S.q(-w / 2, H, 0, w / 2, H, 0, w / 2, H, -d, -w / 2, H, -d, 0, 1, 0, pick(rnd, T.roof), tint);
    if (detail === 0) return;
    // parapet
    const ph = 0.95, t = 0.18, wt = T.wall[0];
    const coping = new THREE.Color('#f1efe9');
    S.box(-w / 2, H, -t, w / 2, H + ph, 0, wt, tint, 1 | 2 | 16, null, T.white[0]);
    S.box(-w / 2, H, -d, w / 2, H + ph, -d + t, wt, tint, 1 | 2 | 16, null, T.white[0]);
    S.box(-w / 2, H, -d + t, -w / 2 + t, H + ph, -t, wt, tint, 4 | 8 | 16);
    S.box(w / 2 - t, H, -d + t, w / 2, H + ph, -t, wt, tint, 4 | 8 | 16);
    S.box(-w / 2 - 0.05, H + ph, -0.1, w / 2 + 0.05, H + ph + 0.08, 0.06, T.white[0], coping, 1 | 16 | 32);
    // stair cabin + tanks
    if (detail === 2 || rnd() < 0.5) {
      const mw = 2.8, md = 2.6, mh = 2.5;
      const mx = (rnd() - 0.5) * Math.max(0, w - mw - 1), mz = -d * (0.35 + rnd() * 0.3);
      if (w > 5 && d > 5) {
        S.box(mx - mw / 2, H, mz - md / 2, mx + mw / 2, H + mh, mz + md / 2, wt, tint, 1 | 2 | 4 | 8, T.door[0]);
        S.box(mx - mw / 2 - 0.1, H + mh, mz - md / 2 - 0.1, mx + mw / 2 + 0.1, H + mh + 0.15, mz + md / 2 + 0.1, T.roof[0], tint, 63);
        if (rnd() < (o.tankP ?? 0.75)) {
          const n = 1 + Math.floor(rnd() * 2);
          for (let k = 0; k < n; k++) this.tank(S, mx + (k - (n - 1) / 2) * 1.35, H + mh + 0.15, mz, 0.85 + rnd() * 0.3);
        }
      }
    }
    if (rnd() < (o.tankP ?? 0.75) * 0.6 && w > 6) this.tank(S, (rnd() - 0.5) * (w - 2), H, -d * (0.2 + rnd() * 0.6), 1);
    // apartment / complex name plate on the front parapet
    if (o.name) S.box(-Math.min(w * 0.36, 5.5), H + 0.12, 0, Math.min(w * 0.36, 5.5), H + 0.9, 0.12, T.dark[0], tint, 1 | 4 | 8 | 16, o.name);
  }

  farBuilding(S, w, d, H, kind, tint, rnd, tankP) {
    const T = this.T;
    const set = kind === 'city' ? T.farC : kind === 'heritage' ? T.farH : kind === 'shed' ? T.farShed : T.farR;
    const cw = 6.4, ch = 6.2;
    const nf = Math.max(1, Math.round(H / ch)), hh = H / nf;
    for (const [side, len, k, s0] of [['f', w, 0, -w / 2], ['b', w, -d, -w / 2], ['r', d, w / 2, 0], ['l', d, -w / 2, -d]]) {
      const n = Math.max(1, Math.round(len / cw)), sw = len / n;
      for (let i = 0; i < n; i++) for (let f = 0; f < nf; f++) S.fq(side, s0 + i * sw, s0 + (i + 1) * sw, f * hh, (f + 1) * hh, k, pick(rnd, set), tint);
    }
    S.q(-w / 2, H, 0, w / 2, H, 0, w / 2, H, -d, -w / 2, H, -d, 0, 1, 0, T.roof[0], tint);
    if (kind !== 'shed') {
      S.box(-w / 2, H, -d, w / 2, H + 0.9, -d + 0.2, T.wall[0], tint, 2 | 16);
      S.box(-w / 2, H, -0.2, w / 2, H + 0.9, 0, T.wall[0], tint, 1 | 16);
      if (rnd() < tankP) this.tank(S, (rnd() - 0.5) * w * 0.5, H, -d * 0.5, 1.1);
    }
    return H;
  }

  // under-construction RCC frame: finished lower floors, open upper floors, columns with rebar
  construction(cx, cz, ry, o) {
    const S = this.at(cx, cz, ry), T = this.T, rnd = o.rnd;
    const w = o.w, d = o.d, floors = o.floors, fh = 3.1;
    const done = Math.floor(floors * (0.2 + rnd() * 0.4));
    const nb = Math.max(2, Math.round(w / 4)), bw = w / nb, nd = Math.max(2, Math.round(d / 4)), bd = d / nd;
    const conc = new THREE.Color('#ffffff'), ct = T.concrete[0];
    for (let f = 0; f < floors; f++) {
      const y0 = f * fh;
      for (const [side, n, ss, k, s0] of [['f', nb, bw, 0, -w / 2], ['b', nb, bw, -d, -w / 2], ['r', nd, bd, w / 2, 0], ['l', nd, bd, -w / 2, -d]]) {
        for (let i = 0; i < n; i++) S.fq(side, s0 + i * ss, s0 + (i + 1) * ss, y0 + 0.25, y0 + fh, k, f < done ? T.brick[0] : pick(rnd, T.constr), conc);
      }
      S.box(-w / 2 - 0.15, y0 + fh - 0.25, -d - 0.15, w / 2 + 0.15, y0 + fh, 0.15, ct, conc, 63);
    }
    for (let i = 0; i <= nb; i++) for (const z of [0, -d]) {
      const x = -w / 2 + i * bw;
      S.box(x - 0.25, 0, z - 0.25, x + 0.25, floors * fh + 1.0, z + 0.25, ct, conc, 15 | 16);
      for (const dx of [-0.12, 0.12]) S.box(x + dx - 0.02, floors * fh + 1.0, z - 0.02, x + dx + 0.02, floors * fh + 1.9, z + 0.02, T.dark[0], conc, 15);
    }
    // green safety net on one face and a builder's board
    S.fq('f', -w / 2 + bw, -w / 2 + bw * 2, done * fh, floors * fh, 0.3, T.constr[0], conc);
    if (o.board) S.box(-3.5, 0.6, 1.5, 3.5, 3.0, 1.62, T.dark[0], conc, 1 | 16, o.board);
    return floors * fh;
  }

  // GIDC factory shed: corrugated walls, gable sheet roof, office block, company board
  shed(cx, cz, ry, o) {
    const S = this.at(cx, cz, ry), T = this.T, rnd = o.rnd;
    const w = o.w, d = o.d, H = o.h || 9.3;
    const tint = new THREE.Color(o.tint || '#bcc8d4');
    const nb = Math.max(2, Math.round(w / 3.2)), bw = w / nb, rows = Math.max(1, Math.round(H / 3.1)), rh = H / rows;
    const nd = Math.max(2, Math.round(d / 3.2)), bd = d / nd;
    const doorAt = new Set([Math.floor(nb * 0.3), Math.floor(nb * 0.3) + 1]);
    for (let i = 0; i < nb; i++) for (let r = 0; r < rows; r++) {
      const t = r === 0 && doorAt.has(i) ? T.corr[2] : r === rows - 1 && o.detail !== 0 ? T.corr[1] : T.corr[0];
      S.fq('f', -w / 2 + i * bw, -w / 2 + (i + 1) * bw, r * rh, (r + 1) * rh, 0, t, tint);
    }
    for (const side of ['r', 'l']) {
      const k = side === 'r' ? w / 2 : -w / 2, s0 = side === 'r' ? 0 : -d;
      for (let j = 0; j < nd; j++) for (let r = 0; r < rows; r++) S.fq(side, s0 + j * bd, s0 + (j + 1) * bd, r * rh, (r + 1) * rh, k, r === rows - 1 ? T.corr[1] : T.corr[0], tint);
    }
    S.fq('b', -w / 2, w / 2, 0, H, -d, T.corr[0], tint, 0, 1, 0, nb);
    // gable roof along the depth (ridge parallel to the road)
    const rr = Math.min(4, w * 0.12), sr = pick(rnd, T.sheet), wc = new THREE.Color('#ffffff');
    S.qa([-w / 2 - 0.4, H, 0.4], [w / 2 + 0.4, H, 0.4], [w / 2 + 0.4, H + rr, -d / 2], [-w / 2 - 0.4, H + rr, -d / 2], sr, wc);
    S.qa([w / 2 + 0.4, H, -d - 0.4], [-w / 2 - 0.4, H, -d - 0.4], [-w / 2 - 0.4, H + rr, -d / 2], [w / 2 + 0.4, H + rr, -d / 2], sr, wc);
    S.qa([w / 2, H, 0], [w / 2, H, -d], [w / 2, H + rr, -d / 2], [w / 2, H + rr, -d / 2], T.corr[0], tint, 0, 1, 0, 0.5);
    S.qa([-w / 2, H, -d], [-w / 2, H, 0], [-w / 2, H + rr, -d / 2], [-w / 2, H + rr, -d / 2], T.corr[0], tint, 0, 1, 0, 0.5);
    // ridge ventilators
    for (let x = -w / 2 + 3; x < w / 2 - 2; x += 6) S.box(x - 0.8, H + rr - 0.1, -d / 2 - 0.6, x + 0.8, H + rr + 0.6, -d / 2 + 0.6, T.sheet[0], wc, 63);
    if (o.detail === 0) return H;
    // company board on the facade
    S.box(-Math.min(w * 0.4, 9), H - 2.6, 0.02, Math.min(w * 0.4, 9), H - 0.8, 0.18, T.dark[0], tint, 1 | 4 | 8 | 16, o.sign || pick(rnd, this.signs.ind));
    this.fronts.push([S.wx(0, 0.1), S.wz(0, 0.1), 6]);
    // office block on the front-right (this re-frames the chunk soup, so it comes last)
    const ow = Math.min(12, w * 0.35);
    this.building(S.wx(w / 2 - ow / 2 - 0.5, 4.2), S.wz(w / 2 - ow / 2 - 0.5, 4.2), Math.atan2(S.sn, S.cs), { w: ow, d: 4, floors: 2, kind: 'city', ground: 'house', tint: '#e8e6e0', rnd, detail: 1, tankP: 0.3, party: true });
    return H;
  }

  // cantonment barrack: whitewashed, verandah, terracotta tiled roof
  barrack(cx, cz, ry, o) {
    const S = this.at(cx, cz, ry), T = this.T, rnd = o.rnd;
    const w = o.w, d = o.d, floors = o.floors || 1, fh = 3.6, H = floors * fh;
    const tint = new THREE.Color(o.tint || '#f5f3ec'), white = new THREE.Color('#ffffff');
    const nb = Math.max(2, Math.round(w / 3.2)), bw = w / nb;
    const vz = -2.6; // the wall sits behind a verandah
    for (let i = 0; i < nb; i++) for (let f = 0; f < floors; f++) S.fq('f', -w / 2 + i * bw, -w / 2 + (i + 1) * bw, f * fh, (f + 1) * fh, vz, T.barrack[(i % 4 === 1) ? 1 : 0], tint, 0, 1.0);
    for (const side of ['r', 'l']) S.fq(side, side === 'r' ? 0 : -d, side === 'r' ? d : 0, 0, H, side === 'r' ? w / 2 : -w / 2, T.barrack[2], tint, 0, 1, 0, Math.round(d / 3.2));
    S.fq('b', -w / 2, w / 2, 0, H, -d, T.barrack[2], tint, 0, 1, 0, nb);
    S.box(-w / 2, 0, vz, w / 2, 0.45, 0, T.concrete[0], white, 1 | 4 | 8 | 16);
    for (let i = 0; i <= nb; i += 1) { const x = -w / 2 + 0.2 + i * (w - 0.4) / nb; S.box(x - 0.2, 0.45, -0.45, x + 0.2, fh, -0.05, T.white[0], white, 15); }
    const tr = pick(rnd, T.tiles);
    S.qa([-w / 2 - 0.3, fh - 0.1, 0.5], [w / 2 + 0.3, fh - 0.1, 0.5], [w / 2 + 0.3, fh + 0.7, vz], [-w / 2 - 0.3, fh + 0.7, vz], tr, white);
    const rr = Math.min(3.2, d * 0.3), H2 = H + 0.2;
    S.qa([-w / 2 - 0.5, H2, vz + 0.6], [w / 2 + 0.5, H2, vz + 0.6], [w / 2 + 0.5, H2 + rr, (vz - d) / 2], [-w / 2 - 0.5, H2 + rr, (vz - d) / 2], tr, white);
    S.qa([w / 2 + 0.5, H2, -d - 0.6], [-w / 2 - 0.5, H2, -d - 0.6], [-w / 2 - 0.5, H2 + rr, (vz - d) / 2], [w / 2 + 0.5, H2 + rr, (vz - d) / 2], tr, white);
    S.qa([w / 2, H, vz], [w / 2, H, -d], [w / 2, H2 + rr, (vz - d) / 2], [w / 2, H2 + rr, (vz - d) / 2], T.barrack[2], tint, 0, 1, 0, 0.6);
    S.qa([-w / 2, H, -d], [-w / 2, H, vz], [-w / 2, H2 + rr, (vz - d) / 2], [-w / 2, H2 + rr, (vz - d) / 2], T.barrack[2], tint, 0, 1, 0, 0.6);
    S.box(-w / 2, H, vz, w / 2, H2, -d, T.white[0], tint, 63);
    return H;
  }

  // ---------------------------------------------------------- walls, signs, props (all in the local frame of `S`)
  compound(cx, cz, ry, len, h, o = {}) {
    const S = this.at(cx, cz, ry), T = this.T, rnd = o.rnd || Math.random;
    const tint = new THREE.Color(o.tint || '#efe7d6');
    const gate = o.gate ?? 0, gw = o.gateW || 5;
    const segs = gate ? [[-len / 2, gate - gw / 2], [gate + gw / 2, len / 2]] : [[-len / 2, len / 2]];
    if (gate) segs[0][1] = gate - gw / 2;
    for (const [a, b] of segs) {
      if (b - a < 0.4) continue;
      const n = Math.max(1, Math.round((b - a) / 3.2));
      for (let i = 0; i < n; i++) {
        const x0 = a + ((b - a) * i) / n, x1 = a + ((b - a) * (i + 1)) / n;
        S.fq('f', x0, x1, 0, h, 0.12, T.compound[o.red ? 1 : 0], tint, 0, h / 3.1);
        S.fq('b', -x1, -x0, 0, h, -0.12, T.compound[0], tint, 0, h / 3.1);
      }
      S.q(a, h, 0.12, b, h, 0.12, b, h, -0.12, a, h, -0.12, 0, 1, 0, T.white[0], tint);
      for (let x = a; x <= b + 0.01; x += Math.max(2.4, (b - a) / Math.ceil((b - a) / 3.2))) S.box(x - 0.22, 0, -0.2, x + 0.22, h + 0.25, 0.2, T.compound[0], tint, 1 | 4 | 8 | 16);
    }
    if (gate) {
      for (const s of [-1, 1]) S.box(gate + s * gw / 2 - 0.35, 0, -0.35, gate + s * gw / 2 + 0.35, h + 0.8, 0.35, T.compound[0], tint, 1 | 4 | 8 | 16);
      S.fq('f', gate - gw / 2 + 0.35, gate - 0.1, 0, h + 0.2, -0.6, T.gate[0], tint, 0, 1);
      S.fq('f', gate + 0.1, gate + gw / 2 - 0.35, 0, h + 0.2, -0.6, T.gate[0], tint, 0, 1);
      if (o.sign) S.box(gate - gw / 2 - 0.3, h + 0.8, -0.1, gate + gw / 2 + 0.3, h + 1.9, 0.1, T.dark[0], tint, 1 | 2 | 16, o.sign);
    }
  }

  // free-standing sign on two posts, face toward +z (local)
  postSign(cx, cz, ry, rect, w = 3.2, h = 1.0, y = 1.6) {
    const S = this.at(cx, cz, ry), T = this.T, g = new THREE.Color('#8d939a');
    for (const s of [-1, 1]) S.box(s * w * 0.4 - 0.05, 0, -0.05, s * w * 0.4 + 0.05, y + h, 0.05, T.gloss[0], g, 15);
    S.box(-w / 2, y, -0.04, w / 2, y + h, 0.04, T.dark[0], g, 1 | 2 | 16, rect);
  }

  chaiStall(cx, cz, ry, rnd) {
    const S = this.at(cx, cz, ry), T = this.T, wood = new THREE.Color('#ffffff');
    S.box(-1.3, 0, -0.9, 1.3, 1.05, 0.2, T.wall[0], new THREE.Color('#8a5a2b'), 15 | 16, pick(rnd, T.stall));
    S.box(-1.3, 1.05, 0.05, 1.3, 2.15, 0.2, T.stall[0], wood, 1, T.stall[0]);
    for (const x of [-1.25, 1.25]) for (const z of [-0.85, 0.15]) S.box(x - 0.04, 1.05, z - 0.04, x + 0.04, 2.3, z + 0.04, T.dark[0], wood, 15);
    S.qa([-1.6, 2.2, -1.2], [1.6, 2.2, -1.2], [1.6, 2.45, 0.9], [-1.6, 2.45, 0.9], pick(rnd, [T.tarp[0], ...T.awning]), wood);
    S.qa([-1.6, 2.45, 0.9], [1.6, 2.45, 0.9], [1.6, 2.2, -1.2], [-1.6, 2.2, -1.2], T.dark[0], wood);
    S.box(-1.2, 2.45, 0.6, 1.2, 3.05, 0.7, T.dark[0], wood, 1 | 16, this.signs.road.CHAI);
    // bench
    S.box(1.8, 0.42, -0.3, 3.6, 0.5, 0.3, T.door[0], wood, 63);
    for (const x of [1.9, 3.5]) S.box(x - 0.05, 0, -0.25, x + 0.05, 0.42, 0.25, T.dark[0], wood, 15);
  }

  panCabin(cx, cz, ry, rnd) {
    const S = this.at(cx, cz, ry), T = this.T, c = new THREE.Color(pick(rnd, ['#2a6f97', '#c1121f', '#2b9348', '#e9c46a']));
    S.box(-0.9, 0, -0.9, 0.9, 2.3, 0.9, T.white[0], c, 2 | 4 | 8 | 16, null, T.roof[0]);
    S.fq('f', -0.9, 0.9, 0, 2.3, 0.9, T.stall[1], new THREE.Color('#ffffff'), 0, 1);
    S.box(-1.0, 2.3, -1.0, 1.0, 2.75, 1.0, T.dark[0], c, 1 | 4 | 8 | 16, pick(rnd, this.signs.shop));
  }

  busStop(cx, cz, ry) {
    const S = this.at(cx, cz, ry), T = this.T, g = new THREE.Color('#2b9348'), st = new THREE.Color('#c9ced3');
    for (const x of [-3.6, 0, 3.6]) S.box(x - 0.08, 0, -1.3, x + 0.08, 2.6, -1.14, T.gloss[0], st, 15);
    S.box(-4, 2.6, -1.6, 4, 2.75, 0.6, T.white[0], g, 63);
    S.box(-4, 2.75, -1.25, 4, 3.45, -1.15, T.dark[0], g, 1 | 2 | 16, this.signs.road['BUS STOP']);
    S.box(-3.5, 0.45, -1.2, 3.5, 0.52, -0.75, T.gloss[0], st, 63);
    S.fq('f', -3.6, 3.6, 0.6, 2.5, -1.3, T.poster[0], new THREE.Color('#efe7d6'), 0, 0.8);
  }

  autoStandSign(cx, cz, ry) { this.postSign(cx, cz, ry, this.signs.road['AUTO STAND'], 2.6, 0.75, 1.9); }

  dhaba(cx, cz, ry, rnd) {
    const S = this.at(cx, cz, ry), T = this.T, tint = new THREE.Color(pick(rnd, ['#f4c09a', '#f5e19a', '#efe7d6']));
    const w = 14, d = 7, h = 3.4;
    for (let i = 0; i < 4; i++) S.fq('f', -w / 2 + i * w / 4, -w / 2 + (i + 1) * w / 4, 0, h, -2.5, i === 1 ? T.shopOpen[1] : pick(rnd, [T.wall[3], T.poster[0], T.win[1]]), tint, 0, 1);
    S.fq('r', 2.5, d, 0, h, w / 2, T.wall[0], tint); S.fq('l', -d, -2.5, 0, h, -w / 2, T.wall[0], tint); S.fq('b', -w / 2, w / 2, 0, h, -d, T.wall[0], tint);
    S.q(-w / 2, h, -2.5, w / 2, h, -2.5, w / 2, h, -d, -w / 2, h, -d, 0, 1, 0, T.roof[0], tint);
    // tin verandah roof on bamboo posts
    const sh = pick(rnd, T.sheet), wc = new THREE.Color('#ffffff');
    S.qa([-w / 2 - 0.5, 2.6, 1.4], [w / 2 + 0.5, 2.6, 1.4], [w / 2 + 0.5, 3.3, -2.5], [-w / 2 - 0.5, 3.3, -2.5], sh, wc);
    S.qa([w / 2 + 0.5, 3.3, -2.5], [-w / 2 - 0.5, 3.3, -2.5], [-w / 2 - 0.5, 2.6, 1.4], [w / 2 + 0.5, 2.6, 1.4], sh, wc);
    for (let x = -w / 2; x <= w / 2; x += w / 4) S.box(x - 0.07, 0, 1.2, x + 0.07, 2.6, 1.34, T.door[0], wc, 15);
    S.box(-6, h + 0.2, -2.5, 6, h + 1.9, -2.3, T.dark[0], wc, 1 | 16, this.signs.road['PUNJABI DHABA']);
    for (const s of [-1, 1]) S.box(s * 5.5 - 0.06, h, -2.45, s * 5.5 + 0.06, h + 1.9, -2.35, T.dark[0], wc, 15);
    // charpais (woven cots)
    for (let k = 0; k < 4; k++) {
      const x = -5 + k * 3.2, z = 3.2 + (k % 2) * 0.6;
      S.box(x - 0.5, 0.42, z - 0.95, x + 0.5, 0.5, z + 0.95, T.awning[3], new THREE.Color('#ffffff'), 16 | 1 | 2 | 4 | 8);
      for (const [a2, b2] of [[-0.45, -0.9], [0.45, -0.9], [-0.45, 0.9], [0.45, 0.9]]) S.box(x + a2 - 0.04, 0, z + b2 - 0.04, x + a2 + 0.04, 0.45, z + b2 + 0.04, T.door[0], wc, 15);
    }
    this.fronts.push([S.wx(0, -2.4), S.wz(0, -2.4), 3.2]);
  }

  petrolPump(cx, cz, ry, rnd) {
    const S = this.at(cx, cz, ry), T = this.T, wc = new THREE.Color('#ffffff'), blue = new THREE.Color('#0b4f9c');
    const cw = 18, cd = 11, ch = 5.6, z0 = -2 - cd;
    for (const x of [-cw / 2 + 2, cw / 2 - 2]) for (const z of [-3.5, z0 + 1.5]) S.box(x - 0.3, 0, z - 0.3, x + 0.3, ch, z + 0.3, T.white[0], wc, 15);
    S.box(-cw / 2, ch, z0, cw / 2, ch + 1.1, -2, T.white[0], wc, 2 | 4 | 8 | 16 | 32);
    S.box(-cw / 2, ch, -2.1, cw / 2, ch + 1.1, -2, T.dark[0], wc, 1, this.signs.road['CITY FUEL STATION']);
    S.box(-cw / 2 - 0.02, ch + 0.05, z0 - 0.02, cw / 2 + 0.02, ch + 0.3, -1.98, T.white[0], blue, 1 | 2 | 4 | 8);
    for (const x of [-4, 4]) {
      S.box(x - 1.6, 0, -8.5, x + 1.6, 0.25, -6.5, T.concrete[0], new THREE.Color('#ffd60a'), 63);
      S.box(x - 0.5, 0.25, -7.85, x + 0.5, 2.1, -7.15, T.white[0], wc, 2 | 4 | 8 | 16, T.dispenser[0]);
      S.fq('b', -(x + 0.5), -(x - 0.5), 0.25, 2.1, -7.85, T.dispenser[0], wc, 0, 1);
    }
    // sales office
    S.box(-6, 0, z0 - 6, 6, 3.4, z0 - 0.5, T.wall[0], new THREE.Color('#f2f2f0'), 2 | 4 | 8, T.shopGlass[3], T.roof[0]);
    S.fq('f', -6, 6, 0, 3.4, z0 - 0.5, T.shopGlass[3], wc, 0, 1, 0, 3);
    S.q(-6, 3.4, z0 - 0.5, 6, 3.4, z0 - 0.5, 6, 3.4, z0 - 6, -6, 3.4, z0 - 6, 0, 1, 0, T.roof[0], wc);
    // price totem
    S.box(cw / 2 + 1, 0, -1.4, cw / 2 + 2.4, 7.5, -0.8, T.white[0], blue, 15 | 16);
    S.box(cw / 2 + 0.9, 5.2, -0.8, cw / 2 + 2.5, 7.3, -0.7, T.dispenser[0], wc, 1, T.dispenser[0]);
  }

  // billboard structure (the printed board is an instanced ad cell added by the world)
  billboardFrame(S, w, h, y) {
    const T = this.T, g = new THREE.Color('#6b7078');
    for (const s of [-1, 1]) S.box(s * w * 0.3 - 0.2, 0, -0.6, s * w * 0.3 + 0.2, y, -0.2, T.gloss[0], g, 15);
    S.box(-w / 2, y - 0.3, -0.5, w / 2, y - 0.15, 0.6, T.gloss[0], g, 63);
    S.box(-w / 2 - 0.1, y - 0.1, -0.45, w / 2 + 0.1, y + h + 0.1, -0.25, T.gloss[0], g, 2 | 4 | 8 | 16);
  }

  crane(cx, cz, ry, h, rnd) {
    const S = this.at(cx, cz, ry), T = this.T, y = new THREE.Color('#ffffff'), lt = T.lattice[0];
    S.box(-0.9, 0, -0.9, 0.9, h, 0.9, lt, y, 15);
    S.box(-1.2, h, -1.2, 1.2, h + 2.4, 1.2, T.white[0], new THREE.Color('#e8b81f'), 63);
    S.box(-0.6, h + 2.4, -0.6, 0.6, h + 7.5, 0.6, lt, y, 15);
    const jib = 34 + rnd() * 16;
    S.box(-0.6, h + 2.4, 0, 0.6, h + 3.6, jib, lt, y, 1 | 4 | 8 | 16 | 32);
    S.box(-0.6, h + 2.4, -12, 0.6, h + 3.4, 0, lt, y, 2 | 4 | 8 | 16 | 32);
    S.box(-1.1, h + 0.8, -11, 1.1, h + 2.4, -7.5, T.concrete[0], new THREE.Color('#ffffff'), 63);
    S.box(0.6, h + 1.0, 0.8, 2.4, h + 2.6, 2.6, T.white[0], new THREE.Color('#d9d9d9'), 63, T.glassBlue[0]);
    const hz = jib * (0.4 + rnd() * 0.5);
    S.box(-0.03, h * 0.45, hz - 0.03, 0.03, h + 2.4, hz + 0.03, T.dark[0], y, 15);
    S.box(-0.4, h * 0.45 - 0.6, hz - 0.4, 0.4, h * 0.45, hz + 0.4, T.white[0], new THREE.Color('#e8b81f'), 63);
  }

  truck(cx, cz, ry, rnd) {
    const S = this.at(cx, cz, ry), T = this.T;
    const cab = new THREE.Color(pick(rnd, ['#f77f00', '#e9c46a', '#2a9d8f', '#c1121f', '#1d4e89'])), body = new THREE.Color(pick(rnd, ['#e9c46a', '#f4a261', '#2a9d8f', '#c1121f', '#8ac926']));
    const wc = new THREE.Color('#ffffff');
    // truck along local +z (cab at +z)
    S.box(-1.25, 0.9, -4.6, 1.25, 1.1, 2.4, T.dark[0], wc, 63);
    S.box(-1.25, 1.1, -4.6, 1.25, 3.4, 1.0, T.white[0], body, 15 | 16);
    S.fq('b', -1.25, 1.25, 1.6, 2.6, -4.62, this.signs.road['HORN OK PLEASE'], wc, 0, 1);
    S.box(-1.2, 0.9, 1.1, 1.2, 3.1, 3.2, T.white[0], cab, 2 | 4 | 8 | 16, T.glassBlue[0]);
    S.box(-1.1, 2.0, 3.2, 1.1, 2.95, 3.25, T.glassBlue[0], wc, 1, T.glassBlue[0]);
    S.box(-1.3, 0.55, 3.2, 1.3, 1.0, 3.45, T.gloss[0], new THREE.Color('#c9ced3'), 63);
    for (const z of [-3.5, -2.3, 2.3]) for (const s of [-1, 1]) { const xa = s < 0 ? -1.3 : 0.95; S.box(xa, 0, z - 0.5, xa + 0.35, 1.0, z + 0.5, T.dark[0], wc, 63); }
  }

  cow(cx, cz, ry, rnd) {
    const S = this.at(cx, cz, ry), T = this.T;
    const c = new THREE.Color(pick(rnd, ['#f4f1ea', '#e8e1d4', '#d9cbb5', '#bba58a'])), wc = T.white[0];
    S.box(-0.35, 0.75, -0.75, 0.35, 1.35, 0.75, wc, c, 63);
    S.box(-0.22, 0.95, 0.75, 0.22, 1.45, 1.25, wc, c, 63);
    S.box(-0.16, 1.4, 1.05, 0.16, 1.8, 1.15, wc, c, 63); // hump-ish head
    S.box(-0.28, 1.65, 1.0, 0.28, 1.75, 1.08, wc, new THREE.Color('#5a4630'), 63);
    for (const [x, z] of [[-0.22, -0.6], [0.22, -0.6], [-0.22, 0.6], [0.22, 0.6]]) S.box(x - 0.07, 0, z - 0.07, x + 0.07, 0.78, z + 0.07, wc, c, 15);
    S.box(-0.15, 1.3, 0.1, 0.15, 1.6, 0.5, wc, c, 63); // zebu hump
  }

  waterTower(cx, cz, h) {
    const S = this.at(cx, cz, 0), T = this.T, c = new THREE.Color('#d9d4c8');
    for (const [x, z] of [[-2.5, -2.5], [2.5, -2.5], [-2.5, 2.5], [2.5, 2.5]]) S.box(x - 0.3, 0, z - 0.3, x + 0.3, h, z + 0.3, T.concrete[0], c, 15);
    for (let y = 5; y < h; y += 5) S.box(-2.5, y, -2.5, 2.5, y + 0.3, 2.5, T.concrete[0], c, 15);
    S.cyl(0, h, 0, 5.2, 5, 14, T.concrete[0], c, true, 5.4);
  }

  chimney(cx, cz, h) {
    const S = this.at(cx, cz, 0), T = this.T, c = new THREE.Color('#ffffff');
    S.cyl(0, 0, 0, 1.4, h, 10, T.brick[0], c, true, 0.9);
    S.cyl(0, h - 3, 0, 0.98, 1.0, 10, T.white[0], new THREE.Color('#c1121f'), false, 0.96);
  }
}
