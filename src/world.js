// The visual world: sky, lights, road, scenery, landmarks of Vadodara.
// Everything static is merged per material or instanced, so the whole scene stays ~40-60 draw calls.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BRAND } from './config.js';

const TAU = Math.PI * 2;
const FONT = '"Arial Black", "Segoe UI Black", "Roboto", "Helvetica Neue", Arial, sans-serif';
const FONT2 = '"Segoe UI", "Roboto", "Helvetica Neue", Arial, sans-serif';

// ---------------------------------------------------------------- utils
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash2(x, y, s) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let xf = x - xi, yf = y - yi;
  xf = xf * xf * (3 - 2 * xf); yf = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}
function fbm2(x, y, s, oct = 4) {
  let a = 0.5, f = 1, v = 0;
  for (let i = 0; i < oct; i++) { v += a * vnoise(x * f, y * f, s + i * 17); f *= 2.03; a *= 0.5; }
  return v / (1 - Math.pow(0.5, oct));
}
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length) % arr.length];

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}
function canvasTex(c, { repeat = false, srgb = true, aniso = 1 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}
function grain(g, w, h, amp, rnd, mono = true) {
  const img = g.getImageData(0, 0, w, h), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * amp;
    if (mono) { d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    else { d[i] += n; d[i + 1] += (rnd() - 0.5) * amp; d[i + 2] += (rnd() - 0.5) * amp; }
  }
  g.putImageData(img, 0, 0);
}
function fitText(g, str, x, y, maxW, size, { weight = '900', family = FONT, color = '#fff', align = 'center', baseline = 'middle', stroke = null, strokeW = 0 } = {}) {
  let s = size;
  g.font = `${weight} ${s}px ${family}`;
  const m = g.measureText(str).width;
  if (m > maxW) { s = Math.floor(s * maxW / m); g.font = `${weight} ${s}px ${family}`; }
  g.textAlign = align; g.textBaseline = baseline;
  if (stroke) { g.lineWidth = strokeW; g.strokeStyle = stroke; g.lineJoin = 'round'; g.strokeText(str, x, y); }
  g.fillStyle = color; g.fillText(str, x, y);
  return s;
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
}
function archPath(g, x, yb, w, h) {
  const r = w / 2;
  g.beginPath(); g.moveTo(x, yb); g.lineTo(x, yb - h + r);
  g.arc(x + r, yb - h + r, r, Math.PI, 0); g.lineTo(x + w, yb); g.closePath();
}
function radialTexture(size, stops) {
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) gr.addColorStop(o, col);
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  return canvasTex(c);
}

// ---------------------------------------------------------------- presets
const TOD = {
  day: {
    top: '#3d7fdc', horizon: '#cfe2f0', glow: '#fff1cf', glowAmt: 0.35, sunCol: '#fffbea', sunSize: 0.03,
    elev: 52, azim: 150, clouds: 0.55, cloudLit: '#ffffff', cloudDark: '#b7c5d6', stars: 0, moon: 0,
    light: '#fff1d8', lightI: 3.1, hemiSky: '#c4dcff', hemiGround: '#7a6648', hemiI: 0.62, env: 0.7,
    fog: [160, 950], lamps: 0, windows: 0, signs: 0, glass: 0, gold: 0.0,
  },
  sunset: {
    top: '#34407e', horizon: '#f0a27c', glow: '#ff7a36', glowAmt: 1.25, sunCol: '#ffd9a8', sunSize: 0.05,
    elev: 5, azim: -105, clouds: 0.6, cloudLit: '#ffb98e', cloudDark: '#7d5d80', stars: 0, moon: 0,
    light: '#ffad6b', lightI: 2.8, hemiSky: '#ffb9a0', hemiGround: '#5d4040', hemiI: 0.6, env: 0.55,
    fog: [110, 800], lamps: 0.6, windows: 0.35, signs: 0.2, glass: 0.25, gold: 0.1,
  },
  night: {
    top: '#02061a', horizon: '#18233f', glow: '#7f8fc4', glowAmt: 0.18, sunCol: '#e8eeff', sunSize: 0.0,
    elev: 38, azim: 55, clouds: 0.22, cloudLit: '#3b4870', cloudDark: '#141b30', stars: 1, moon: 1,
    light: '#9db4ff', lightI: 0.4, hemiSky: '#34497e', hemiGround: '#1b1622', hemiI: 0.6, env: 0.3,
    fog: [70, 620], lamps: 1, windows: 0.8, signs: 0.6, glass: 0.8, gold: 0.35,
  },
};
const QUALITY = {
  low: { tex: 0.5, shadows: false, shadowSize: 512, ext: 40, rows: 0.5, scatter: 0.3, trees: 0.4, props: 0.45, lampGap: 44, detail: false, sky: 512 },
  medium: { tex: 1, shadows: true, shadowSize: 1024, ext: 55, rows: 0.8, scatter: 0.7, trees: 0.7, props: 0.75, lampGap: 34, detail: true, sky: 512 },
  high: { tex: 1, shadows: true, shadowSize: 2048, ext: 70, rows: 1, scatter: 1, trees: 1, props: 1, lampGap: 30, detail: true, sky: 1024 },
};

// ---------------------------------------------------------------- sky shader (rendered once into a cube map)
const SKY_VS = /* glsl */`
varying vec3 vDir;
void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SKY_FS = /* glsl */`
uniform vec3 uTop, uHorizon, uGlow, uSunCol, uSunDir, uCloudLit, uCloudDark;
uniform float uGlowAmt, uSunSize, uClouds, uStars, uMoon;
varying vec3 vDir;
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float above = smoothstep(-0.015, 0.09, h);
  vec3 col = mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.48));
  float sd = max(dot(d, uSunDir), 0.0);
  col += uGlow * (pow(sd, 3.0) * 0.25 + pow(sd, 10.0) * 0.6 + pow(sd, 90.0) * 1.2) * uGlowAmt * above;
  // clouds on a virtual plane
  if (uClouds > 0.0 && h > 0.0) {
    vec2 p = d.xz / (h + 0.12);
    float c = fbm(vec3(p * 1.1, 3.7)) * 0.75 + fbm(vec3(p * 3.3, 9.1)) * 0.25;
    c = smoothstep(0.5, 0.78, c) * smoothstep(0.03, 0.3, h) * uClouds;
    vec3 cc = mix(uCloudDark, uCloudLit, 0.45 + 0.55 * pow(sd, 2.0));
    col = mix(col, cc, c);
  }
  // sun disc
  if (uSunSize > 0.0) {
    float disc = smoothstep(cos(uSunSize), cos(uSunSize * 0.8), sd);
    col = mix(col, uSunCol * 1.6, disc * above);
  }
  // stars
  if (uStars > 0.0) {
    vec3 q = d * 230.0; vec3 id = floor(q);
    float r = hash(id * 1.37 + 3.1);
    if (r > 0.991) {
      vec3 cpos = id + 0.5 + (vec3(hash(id + 1.3), hash(id + 2.7), hash(id + 5.1)) - 0.5) * 0.5;
      float b = smoothstep(0.5, 0.05, length(q - cpos)) * (0.35 + 6.0 * (r - 0.991) / 0.009 * 0.25);
      vec3 sc = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.9, 0.75), hash(id + 9.0));
      col += sc * b * uStars * smoothstep(0.03, 0.3, h);
    }
    // faint milky band
    float band = exp(-pow(dot(d, normalize(vec3(0.4, 0.5, -0.75))) * 4.0, 2.0));
    col += vec3(0.05, 0.06, 0.1) * band * fbm(d * 9.0) * uStars * above;
  }
  // moon
  if (uMoon > 0.0) {
    float md = dot(d, uSunDir);
    float disc = smoothstep(cos(0.04), cos(0.036), md);
    float cr = fbm(d * 70.0);
    col = mix(col, vec3(0.92, 0.94, 1.0) * (0.72 + 0.4 * cr), disc * uMoon);
    col += vec3(0.5, 0.58, 0.85) * (pow(max(md, 0.0), 400.0) * 0.4 + pow(max(md, 0.0), 30.0) * 0.06) * uMoon;
  }
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}`;

// ---------------------------------------------------------------- distance field to the track (chamfer)
class Field {
  constructor(track, margin, cell) {
    const { x, z, N } = track;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < N; i++) {
      minX = Math.min(minX, x[i]); maxX = Math.max(maxX, x[i]);
      minZ = Math.min(minZ, z[i]); maxZ = Math.max(maxZ, z[i]);
    }
    this.track = track;
    this.tb = { minX, maxX, minZ, maxZ };
    this.minX = minX - margin; this.minZ = minZ - margin;
    this.cell = cell;
    this.nx = Math.ceil((maxX - minX + 2 * margin) / cell) + 1;
    this.nz = Math.ceil((maxZ - minZ + 2 * margin) / cell) + 1;
    const n = this.nx * this.nz;
    const idx = (this.idx = new Int32Array(n).fill(-1));
    const d2 = new Float32Array(n).fill(Infinity);
    const nx = this.nx, nz = this.nz, c = cell, ox = this.minX, oz = this.minZ;
    for (let i = 0; i < N; i++) {
      const cx = Math.floor((x[i] - ox) / c), cz = Math.floor((z[i] - oz) / c);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const X = cx + a, Z = cz + b;
        if (X < 0 || Z < 0 || X >= nx || Z >= nz) continue;
        const k = Z * nx + X;
        const px = ox + (X + 0.5) * c - x[i], pz = oz + (Z + 0.5) * c - z[i];
        const dd = px * px + pz * pz;
        if (dd < d2[k]) { d2[k] = dd; idx[k] = i; }
      }
    }
    const tryN = (k, X, Z, kk) => {
      const j = idx[kk];
      if (j < 0) return;
      const px = ox + (X + 0.5) * c - x[j], pz = oz + (Z + 0.5) * c - z[j];
      const dd = px * px + pz * pz;
      if (dd < d2[k]) { d2[k] = dd; idx[k] = j; }
    };
    for (let Z = 0; Z < nz; Z++) for (let X = 0; X < nx; X++) {
      const k = Z * nx + X;
      if (X > 0) tryN(k, X, Z, k - 1);
      if (Z > 0) { tryN(k, X, Z, k - nx); if (X > 0) tryN(k, X, Z, k - nx - 1); if (X < nx - 1) tryN(k, X, Z, k - nx + 1); }
    }
    for (let Z = nz - 1; Z >= 0; Z--) for (let X = nx - 1; X >= 0; X--) {
      const k = Z * nx + X;
      if (X < nx - 1) tryN(k, X, Z, k + 1);
      if (Z < nz - 1) { tryN(k, X, Z, k + nx); if (X < nx - 1) tryN(k, X, Z, k + nx + 1); if (X > 0) tryN(k, X, Z, k + nx - 1); }
    }
    // occupancy grid (2 m cells)
    this.oc = 2;
    this.onx = Math.ceil((this.nx * cell) / 2); this.onz = Math.ceil((this.nz * cell) / 2);
    this.occ = new Uint8Array(this.onx * this.onz);
  }
  // distance to the centreline (m) and nearest sample index
  query(px, pz) {
    const T = this.track;
    const X = Math.floor((px - this.minX) / this.cell), Z = Math.floor((pz - this.minZ) / this.cell);
    if (X < 0 || Z < 0 || X >= this.nx || Z >= this.nz) return { d: 1e4, i: 0 };
    let i = this.idx[Z * this.nx + X];
    if (i < 0) return { d: 1e4, i: 0 };
    let best = (px - T.x[i]) ** 2 + (pz - T.z[i]) ** 2;
    for (let dir = -1; dir <= 1; dir += 2) {
      for (let s = 1; s < 12; s++) {
        const j = (i + dir * s + T.N) % T.N;
        const dd = (px - T.x[j]) ** 2 + (pz - T.z[j]) ** 2;
        if (dd < best) { best = dd; i = j; s = 0; } else if (s > 3) break;
      }
    }
    return { d: Math.sqrt(best), i };
  }
  dist(px, pz) { return this.query(px, pz).d; }
  occAt(px, pz) {
    const X = Math.floor((px - this.minX) / 2), Z = Math.floor((pz - this.minZ) / 2);
    if (X < 0 || Z < 0 || X >= this.onx || Z >= this.onz) return 1;
    return this.occ[Z * this.onx + X];
  }
  // rotated rectangle helpers: centre, width (local X), depth (local Z), rotation about Y
  rectFree(cx, cz, w, d, ry, clear) {
    const c = Math.cos(ry), s = Math.sin(ry);
    const nw = Math.max(1, Math.ceil(w / 2)), nd = Math.max(1, Math.ceil(d / 2));
    for (let a = 0; a <= nw; a++) for (let b = 0; b <= nd; b++) {
      const lx = (a / nw - 0.5) * w, lz = (b / nd - 0.5) * d;
      const px = cx + lx * c + lz * s, pz = cz - lx * s + lz * c;
      if (this.occAt(px, pz)) return false;
      if (clear > 0 && this.dist(px, pz) < clear) return false;
    }
    return true;
  }
  mark(cx, cz, w, d, ry, pad = 0.5) {
    const c = Math.cos(ry), s = Math.sin(ry);
    const W = w + pad * 2, D = d + pad * 2;
    const nw = Math.ceil(W / 1), nd = Math.ceil(D / 1);
    for (let a = 0; a <= nw; a++) for (let b = 0; b <= nd; b++) {
      const lx = (a / nw - 0.5) * W, lz = (b / nd - 0.5) * D;
      const px = cx + lx * c + lz * s, pz = cz - lx * s + lz * c;
      const X = Math.floor((px - this.minX) / 2), Z = Math.floor((pz - this.minZ) / 2);
      if (X >= 0 && Z >= 0 && X < this.onx && Z < this.onz) this.occ[Z * this.onx + X] = 1;
    }
  }
}

// ---------------------------------------------------------------- sign atlas (one texture for every text sign)
class Atlas {
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

// ---------------------------------------------------------------- geometry builder (merges parts per material bucket)
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);
function L(x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) {
  _e.set(rx, ry, rz, 'YXZ'); _q.setFromEuler(_e);
  return _m2.compose(_v.set(x, y, z), _q, _s.set(sx, sy, sz));
}

class Builder {
  constructor() { this.lists = {}; this.frame = new THREE.Matrix4(); this._tmp = new THREE.Matrix4(); }
  push(bucket, geo, local, color, keepUV = false) {
    const g = geo.index ? geo.clone() : geo.clone();
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
  // raw non-indexed triangle soup with per-vertex colours and optional uvs
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
    const g = mergeGeometries(list, false);
    for (const x of list) x.dispose();
    this.lists[bucket] = [];
    if (g) g.computeBoundingSphere();
    return g;
  }
}

// triangle-soup helper with automatic winding against a wanted normal
class Soup {
  constructor(withUV = false) { this.p = []; this.n = []; this.c = []; this.uv = withUV ? [] : null; }
  quad(A, B, C, D, n, col, uvA, uvB, uvC, uvD) {
    // A,B,C,D are [x,y,z]; two triangles A,B,C and A,C,D
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

// instance collector
class Inst {
  constructor() { this.m = []; this.c = []; this.a = []; }
  add(matrix, color, extra) {
    for (let k = 0; k < 16; k++) this.m.push(matrix.elements[k]);
    _c.set(color === undefined ? 0xffffff : color);
    this.c.push(_c.r, _c.g, _c.b);
    if (extra) for (const e of extra) this.a.push(e);
  }
  get count() { return this.m.length / 16; }
}

// ---------------------------------------------------------------- window textures for instanced buildings
// 8x8 tiles; tile row 7 (top of the image) = ground-floor shopfronts. R channel of aux = tint mask, G = roughness.
function windowTextures(style, T, rnd) {
  const S = T * 8;
  const ca = makeCanvas(S, S), ce = makeCanvas(S, S), cx = makeCanvas(S, S);
  const a = ca.getContext('2d'), e = ce.getContext('2d'), x = cx.getContext('2d');
  a.fillStyle = '#f2efe8'; a.fillRect(0, 0, S, S);
  e.fillStyle = '#000'; e.fillRect(0, 0, S, S);
  x.fillStyle = 'rgb(255,235,0)'; x.fillRect(0, 0, S, S);
  const litP = style === 'city' ? 0.5 : style === 'heritage' ? 0.42 : 0.36;
  const glass = (X, Y, W, H, lit, warm) => {
    const gr = a.createLinearGradient(X, Y, X + W, Y + H);
    gr.addColorStop(0, '#2c3a4a'); gr.addColorStop(0.55, '#4b6178'); gr.addColorStop(1, '#273443');
    a.fillStyle = gr; a.fillRect(X, Y, W, H);
    x.fillStyle = 'rgb(40,60,0)'; x.fillRect(X, Y, W, H);
    if (lit) {
      const ge = e.createLinearGradient(X, Y, X, Y + H);
      const c1 = warm ? '#ffd38f' : '#d6e8f5', c2 = warm ? '#e8964a' : '#9fc0dc';
      ge.addColorStop(0, c1); ge.addColorStop(1, c2);
      e.fillStyle = ge; e.fillRect(X, Y, W, H);
    }
  };
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const X = c * T, Y = (7 - r) * T; // tile r drawn so that v=r/8 maps to it
    a.save(); e.save(); x.save();
    if (r === 7) {
      // ground-floor shopfront
      a.fillStyle = '#e9e3d6'; a.fillRect(X, Y, T, T);
      const sx = X + T * 0.06, sy = Y + T * 0.32, sw = T * 0.88, sh = T * 0.68;
      if (rnd() < 0.45) { // rolling shutter
        a.fillStyle = '#8f969c'; a.fillRect(sx, sy, sw, sh);
        a.fillStyle = 'rgba(0,0,0,0.25)';
        for (let k = 0; k < sh; k += Math.max(2, T / 20)) a.fillRect(sx, sy + k, sw, 1);
        x.fillStyle = 'rgb(0,120,0)'; x.fillRect(sx, sy, sw, sh);
      } else { // open shop with goods
        a.fillStyle = '#3a2e26'; a.fillRect(sx, sy, sw, sh);
        e.fillStyle = '#c98b4a'; e.fillRect(sx, sy, sw, sh);
        const cols = ['#e63946', '#f4a261', '#2a9d8f', '#e9c46a', '#8ecae6', '#ff66a8', '#6a994e'];
        for (let k = 0; k < 9; k++) {
          const gx = sx + rnd() * sw * 0.85, gy = sy + sh * 0.25 + rnd() * sh * 0.6, gw = T * (0.06 + rnd() * 0.12), gh = T * (0.05 + rnd() * 0.12);
          a.fillStyle = pick(rnd, cols); a.fillRect(gx, gy, gw, gh);
          e.fillStyle = '#ffe0b0'; e.globalAlpha = 0.6; e.fillRect(gx, gy, gw, gh); e.globalAlpha = 1;
        }
        x.fillStyle = 'rgb(0,200,0)'; x.fillRect(sx, sy, sw, sh);
      }
      a.restore(); e.restore(); x.restore();
      continue;
    }
    const lit = rnd() < litP, warm = rnd() < 0.6;
    if (style === 'city') {
      a.fillStyle = '#dad6cf'; a.fillRect(X, Y + T * 0.8, T, T * 0.2);
      glass(X + T * 0.03, Y + T * 0.06, T * 0.94, T * 0.72, lit, warm || rnd() < 0.4);
      a.fillStyle = '#b9c3cc';
      a.fillRect(X + T * 0.49, Y + T * 0.06, Math.max(1, T * 0.03), T * 0.72);
      a.fillRect(X, Y, T, Math.max(1, T * 0.04));
      if (lit) { e.fillStyle = '#000'; e.fillRect(X + T * 0.49, Y + T * 0.06, Math.max(1, T * 0.03), T * 0.72); }
      if (rnd() < 0.2) { a.fillStyle = 'rgba(240,240,230,0.55)'; a.fillRect(X + T * 0.05, Y + T * 0.08, T * 0.4, T * 0.66); } // blinds
    } else if (style === 'heritage') {
      a.fillStyle = 'rgba(0,0,0,0.12)'; a.fillRect(X, Y + T * 0.9, T, T * 0.1);
      a.fillStyle = '#fbf7ef'; a.fillRect(X, Y + T * 0.86, T, T * 0.05);
      x.fillStyle = 'rgb(0,235,0)'; x.fillRect(X, Y + T * 0.86, T, T * 0.05);
      const wx = X + T * 0.27, ww = T * 0.46, wb = Y + T * 0.8, wh = T * 0.6;
      a.fillStyle = '#fbf8f0'; archPath(a, wx - T * 0.05, wb + T * 0.02, ww + T * 0.1, wh + T * 0.07); a.fill();
      x.fillStyle = 'rgb(0,230,0)'; archPath(x, wx - T * 0.05, wb + T * 0.02, ww + T * 0.1, wh + T * 0.07); x.fill();
      const open = rnd() < 0.55;
      if (open) {
        a.fillStyle = '#2a2019'; archPath(a, wx, wb, ww, wh); a.fill();
        if (lit) { e.fillStyle = warm ? '#ffcc85' : '#e0f0ff'; archPath(e, wx, wb, ww, wh); e.fill(); }
        a.fillStyle = '#6b6b6b';
        for (let k = 1; k < 4; k++) a.fillRect(wx + (ww * k) / 4, wb - wh, 1, wh);
      } else {
        a.fillStyle = pick(rnd, ['#2f7f6f', '#3f6fa0', '#7a4a2a', '#2e6e3e', '#8a2f3f', '#2a5a8a']);
        archPath(a, wx, wb, ww, wh); a.fill();
        a.fillStyle = 'rgba(0,0,0,0.3)'; a.fillRect(wx + ww / 2 - 0.5, wb - wh * 0.8, 1, wh * 0.8);
        for (let k = 0; k < 5; k++) a.fillRect(wx, wb - wh * 0.15 - k * wh * 0.14, ww, 1);
        x.fillStyle = 'rgb(0,170,0)'; archPath(x, wx, wb, ww, wh); x.fill();
      }
    } else {
      // suburb apartments: grilled windows, AC units, balconies with laundry
      a.fillStyle = 'rgba(0,0,0,0.1)'; a.fillRect(X, Y + T * 0.94, T, T * 0.06);
      const wx = X + T * 0.2, wy = Y + T * 0.2, ww = T * 0.6, wh = T * 0.48;
      a.fillStyle = '#d8d2c4'; a.fillRect(wx - T * 0.04, wy - T * 0.04, ww + T * 0.08, wh + T * 0.1);
      x.fillStyle = 'rgb(0,230,0)'; x.fillRect(wx - T * 0.04, wy - T * 0.04, ww + T * 0.08, wh + T * 0.1);
      glass(wx, wy, ww, wh, lit, warm);
      a.fillStyle = '#9aa1a8'; e.fillStyle = '#000';
      for (let k = 1; k < 5; k++) { a.fillRect(wx + (ww * k) / 5, wy, 1, wh); if (lit) e.fillRect(wx + (ww * k) / 5, wy, 1, wh); }
      a.fillRect(wx, wy + wh / 2, ww, 1); if (lit) e.fillRect(wx, wy + wh / 2, ww, 1);
      a.fillStyle = 'rgba(0,0,0,0.25)'; a.fillRect(wx - T * 0.05, wy - T * 0.08, ww + T * 0.1, T * 0.04); // chajja shade
      const roll = rnd();
      if (roll < 0.3) { // AC outdoor unit
        a.fillStyle = '#e4e6e8'; a.fillRect(X + T * 0.58, Y + T * 0.72, T * 0.3, T * 0.18);
        a.fillStyle = '#7d8590'; a.beginPath(); a.arc(X + T * 0.69, Y + T * 0.81, T * 0.06, 0, TAU); a.fill();
        x.fillStyle = 'rgb(0,160,0)'; x.fillRect(X + T * 0.58, Y + T * 0.72, T * 0.3, T * 0.18);
      } else if (roll < 0.42) { // laundry line
        a.strokeStyle = '#555'; a.lineWidth = 1; a.beginPath(); a.moveTo(wx, wy + wh + T * 0.1); a.lineTo(wx + ww, wy + wh + T * 0.1); a.stroke();
        for (let k = 0; k < 4; k++) {
          a.fillStyle = pick(rnd, ['#e63946', '#ffb703', '#219ebc', '#ff66a8', '#8ac926', '#ffffff']);
          a.fillRect(wx + k * ww * 0.25 + 1, wy + wh + T * 0.1, ww * 0.18, T * 0.14);
          x.fillStyle = 'rgb(0,240,0)'; x.fillRect(wx + k * ww * 0.25 + 1, wy + wh + T * 0.1, ww * 0.18, T * 0.14);
        }
      }
    }
    a.restore(); e.restore(); x.restore();
  }
  grain(a, S, S, 10, rnd);
  return { alb: ca, em: ce, aux: cx };
}

function buildingMaterial(alb, em, aux, emissiveI) {
  const mat = new THREE.MeshStandardMaterial({
    map: alb, emissiveMap: em, roughnessMap: aux, emissive: 0xffffff, emissiveIntensity: emissiveI,
    roughness: 1, metalness: 0, envMapIntensity: 0.55,
  });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aInfo;\nvarying vec2 vTile;\nvarying vec4 vInfo;\nvarying float vRoof;')
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        {
          vec3 bS = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
          float bW = abs(normal.x) > 0.5 ? bS.z : bS.x;
          vec2 bTiles = vec2(max(1.0, floor(bW / 3.4 + 0.5)), max(1.0, floor(bS.y / 3.2 + 0.5)));
          vTile = uv * bTiles;
          vInfo = aInfo;
          vRoof = normal.y > 0.5 ? 1.0 : 0.0;
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vTile;\nvarying vec4 vInfo;\nvarying float vRoof;')
      .replace('#include <map_fragment>', `
        vec2 bCell = floor(vTile);
        vec2 bF = fract(vTile);
        float bRow = (vInfo.x > 0.5 && bCell.y < 0.5) ? 7.0 : mod(bCell.y + vInfo.z, 7.0);
        float bCol = mod(bCell.x + vInfo.w, 8.0);
        vec2 bUV = (vec2(bCol, bRow) + bF) / 8.0;
        vec2 bDx = dFdx(vTile) / 8.0, bDy = dFdy(vTile) / 8.0;
        vec4 bAlb = textureGrad(map, bUV, bDx, bDy);
        vec4 bAux = textureGrad(roughnessMap, bUV, bDx, bDy);
        diffuseColor *= bAlb;`)
      .replace('#include <color_fragment>', `
        #if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vColor, bAux.r);
          if (vRoof > 0.5) diffuseColor.rgb = mix(vec3(0.36, 0.34, 0.32), vColor * 0.55, 0.35);
        #endif`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vRoof > 0.5 ? 0.95 : roughness * bAux.g;')
      .replace('#include <emissivemap_fragment>', `
        vec4 bEm = textureGrad(emissiveMap, bUV, bDx, bDy);
        totalEmissiveRadiance *= bEm.rgb * (1.0 - vRoof);`);
  };
  mat.customProgramCacheKey = () => 'la-building';
  return mat;
}

function boardMaterial(tex, emissiveI, rows) {
  const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: emissiveI, roughness: 0.6, envMapIntensity: 0.4 });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aCell;')
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        vMapUv = aCell + uv * vec2(0.5, ${(1 / rows).toFixed(6)});
        vEmissiveMapUv = vMapUv;`);
  };
  mat.customProgramCacheKey = () => 'la-board';
  return mat;
}

// ---------------------------------------------------------------- names
const SHOPS = [
  ['SHREE KRISHNA STORES', 'KIRANA • DAILY NEEDS', '#c1121f', '#ffd60a'], ['JALARAM KHAMAN HOUSE', 'PURE VEG • SINCE 1984', '#ffd60a', '#9d0208'],
  ['PATEL MEDICAL', '24 HOURS CHEMIST', '#0b6e4f', '#ffffff'], ['BARODA SWEETS', 'PENDA • BASUNDI • FARSAN', '#ff8fab', '#5a0b2c'],
  ['AMBIKA PAN PARLOUR', 'MEETHA PAN SPECIAL', '#2b9348', '#fff3b0'], ['SAYAJI CYCLE MART', 'SALES & SERVICE', '#1d4e89', '#ffffff'],
  ['MAHAKALI TEA STALL', 'CUTTING CHAI ₹10', '#f77f00', '#1b1b1b'], ['RAJ MOBILE ZONE', 'RECHARGE • ACCESSORIES', '#3a0ca3', '#ffd60a'],
  ['GANESH HARDWARE', 'PAINTS • PLUMBING', '#ffb703', '#023047'], ['LAXMI SAREE CENTRE', 'BANDHANI • PATOLA', '#9d0208', '#ffd166'],
  ['NAVRANG TAILORS', 'GENTS & LADIES', '#00b4d8', '#03045e'], ['OM SAI XEROX', 'PRINT • LAMINATION', '#ffffff', '#d00000'],
  ['KHODIYAR AUTO PARTS', 'ALL MODELS AVAILABLE', '#212529', '#ffd60a'], ['SURTI LOCHO HOUSE', 'HOT • FRESH • TASTY', '#ff5d8f', '#ffffff'],
  ['DUDHWALA DAIRY', 'MILK • GHEE • PANEER', '#caf0f8', '#0077b6'], ['JAY AMBE GARAGE', 'PUNCTURE • SERVICE', '#e85d04', '#ffffff'],
];
const ADS = [
  ['LORD ALTO', 'NITRO EDITION • DRIVE LIKE A KING', '#1d1747', '#ffc533', '#ff9933'], ['GARBA NIGHTS', 'NAVRATRI • 9 NIGHTS OF DANDIYA', '#d00070', '#ffe066', '#ff9933'],
  ['BARODA BHAKARWADI', 'CRUNCH OF THE CITY', '#ff9933', '#3d0c02', '#ffffff'], ['HELMET PEHNO!', 'DRIVE SAFE, BARODA', '#0a9396', '#ffffff', '#ee9b00'],
  ['SEV USAL SPECIAL', 'SPICY • HOT • ₹40 ONLY', '#9d0208', '#ffd60a', '#ffffff'], ['UTTARAYAN KITE SALE', 'UP TO 50% OFF ON PATANG', '#4361ee', '#ffffff', '#ffd60a'],
  ['NEW FLATS IN BHAYLI', '2 & 3 BHK • BOOK NOW', '#2d6a4f', '#ffffff', '#b7e4c7'], ['MASALA CHAI', 'ONE CUP, FULL ENERGY', '#6f1d1b', '#ffe6a7', '#bb9457'],
];

// ---------------------------------------------------------------- the World
export class World {
  constructor(renderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    const pm = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    this.envTex = pm.fromScene(room, 0.04).texture;
    room.dispose?.();
    pm.dispose();
    this.scene.environment = this.envTex;
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    this.sun = new THREE.DirectionalLight(0xffffff, 2);
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.root = null;
    this.track = null;
    this._disp = [];
    this._anims = [];
    this._time = 0;
    this._mm = null;
    this._skyRT = null;
  }

  // ------------------------------------------------------------ lifecycle
  _clear() {
    const keep = new Set([this.hemi, this.sun, this.sun.target]);
    for (const o of this.scene.children.slice()) {
      if (keep.has(o)) continue;
      this.scene.remove(o);
      if (o !== this.root && o.userData && o.userData.disposeWithScene) {
        o.traverse((n) => { n.geometry?.dispose?.(); if (n.material) [].concat(n.material).forEach((m) => m.dispose()); });
      }
    }
    for (const d of this._disp) d.dispose?.();
    this._disp = [];
    this._anims = [];
    if (this._skyRT) { this._skyRT.dispose(); this._skyRT = null; }
    this.scene.background = null;
    this.scene.fog = null;
    this.root = null;
    this._mm = null;
  }

  dispose() { this._clear(); this.envTex?.dispose(); }

  _track(x) { this._disp.push(x); return x; }
  _tex(c, opts) { return this._track(canvasTex(c, { aniso: this.aniso, ...opts })); }
  _add(obj, cast = true, receive = true) {
    obj.castShadow = cast && this.QL.shadows; obj.receiveShadow = receive;
    if (obj.geometry) this._track(obj.geometry);
    if (obj.material) [].concat(obj.material).forEach((m) => this._track(m));
    this.root.add(obj);
    return obj;
  }

  load(track, { timeOfDay, quality } = {}) {
    this._clear();
    const tod = TOD[timeOfDay] ? timeOfDay : (TOD[track.def.timeOfDay] ? track.def.timeOfDay : 'day');
    const q = QUALITY[quality] ? quality : 'medium';
    this.track = track; this.tod = tod; this.q = q;
    this.P = TOD[tod]; this.QL = QUALITY[q];
    this.style = track.def.style || 'suburb';
    this.rnd = mulberry32(hashStr(track.id + ':' + tod));
    this.aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy?.() || 1);
    this.root = new THREE.Group();
    this.root.name = 'world';
    this.scene.add(this.root);

    this._sky();
    this._lights();

    this.field = new Field(track, 340, 4);
    this.B = new Builder();
    this.atlas = new Atlas(this.QL.tex < 1 ? 1024 : 2048);
    this.I = {};
    for (const k of ['bld', 'board', 'balcony', 'jharokha', 'tank', 'misc', 'trunk', 'canopy', 'ashoka', 'lamp', 'lampHead', 'pool', 'auto', 'scooter']) this.I[k] = new Inst();
    this.halos = []; this.fairy = [];
    this.noFoot = [new Uint8Array(track.N), new Uint8Array(track.N)]; // [side -1, side +1]

    this._initShopBoards();
    this._landmarks();
    this._startGantry();
    this._labelBoards();
    this._road();
    this._lamps();
    this._buildings();
    this._trees();
    this._props();
    this._ground();
    this._finalize();
    this.scene.environmentIntensity = this.P.env;
  }

  minimap() {
    if (this._mm) return this._mm;
    const T = this.track;
    if (!T) return { points: [], bounds: { minX: 0, maxX: 1, minZ: 0, maxZ: 1 } };
    const n = 200, pts = [];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let k = 0; k < n; k++) {
      const i = Math.floor((k * T.N) / n);
      pts.push([T.x[i], T.z[i]]);
    }
    for (let i = 0; i < T.N; i++) {
      minX = Math.min(minX, T.x[i]); maxX = Math.max(maxX, T.x[i]);
      minZ = Math.min(minZ, T.z[i]); maxZ = Math.max(maxZ, T.z[i]);
    }
    this._mm = { points: pts, bounds: { minX, maxX, minZ, maxZ } };
    return this._mm;
  }

  update(dt, focus) {
    this._time += dt || 0;
    if (focus && this.root) {
      const ext = this.QL.ext;
      const texel = (2 * ext) / this.QL.shadowSize;
      const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
      this.sun.target.position.set(fx, 0, fz);
      this.sun.position.set(fx + this.sunDir.x * 160, this.sunDir.y * 160, fz + this.sunDir.z * 160);
      this.sun.target.updateMatrixWorld();
    }
    for (const a of this._anims) a(dt || 0, this._time);
  }

  // ------------------------------------------------------------ sky, fog, lights
  _sky() {
    const P = this.P;
    const el = (P.elev * Math.PI) / 180, az = (P.azim * Math.PI) / 180;
    this.sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
    const C = (h) => new THREE.Color(h);
    const mat = new THREE.ShaderMaterial({
      vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false,
      uniforms: {
        uTop: { value: C(P.top) }, uHorizon: { value: C(P.horizon) }, uGlow: { value: C(P.glow) }, uSunCol: { value: C(P.sunCol) },
        uSunDir: { value: this.sunDir.clone() }, uCloudLit: { value: C(P.cloudLit) }, uCloudDark: { value: C(P.cloudDark) },
        uGlowAmt: { value: P.glowAmt }, uSunSize: { value: P.sunSize }, uClouds: { value: P.clouds }, uStars: { value: P.stars }, uMoon: { value: P.moon },
      },
    });
    const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat);
    const sc = new THREE.Scene(); sc.add(box);
    const rt = new THREE.WebGLCubeRenderTarget(this.QL.sky, { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace, generateMipmaps: false });
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    const cam = new THREE.CubeCamera(0.1, 10, rt);
    cam.update(this.renderer, sc);
    box.geometry.dispose(); mat.dispose();
    this._skyRT = rt;
    this.scene.background = rt.texture;
    this.scene.fog = new THREE.Fog(new THREE.Color(P.horizon), P.fog[0], P.fog[1]);
  }

  _lights() {
    const P = this.P, QL = this.QL;
    this.hemi.color.set(P.hemiSky); this.hemi.groundColor.set(P.hemiGround); this.hemi.intensity = P.hemiI;
    this.sun.color.set(P.light); this.sun.intensity = P.lightI;
    this.sun.castShadow = QL.shadows;
    const sh = this.sun.shadow;
    if (sh.map && sh.mapSize.x !== QL.shadowSize) { sh.map.dispose(); sh.map = null; }
    sh.mapSize.set(QL.shadowSize, QL.shadowSize);
    const cam = sh.camera;
    cam.left = -QL.ext; cam.right = QL.ext; cam.top = QL.ext; cam.bottom = -QL.ext;
    cam.near = 1; cam.far = 420; cam.updateProjectionMatrix();
    sh.bias = -0.0004; sh.normalBias = 0.03;
    sh.radius = 3;
    if (QL.shadows && !this.renderer.shadowMap.enabled) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    const T = this.track;
    this.sun.target.position.set(T.x[0], 0, T.z[0]);
    this.sun.position.set(T.x[0] + this.sunDir.x * 160, this.sunDir.y * 160, T.z[0] + this.sunDir.z * 160);
    this.sun.target.updateMatrixWorld();
  }

  // ------------------------------------------------------------ frames & kit
  // local frame beside the road: origin at lateral `lat` on `side`, local +Z faces the road, +X runs along it
  frameSide(i, side, lat, along = 0, scale = 1) {
    const T = this.track;
    const p = T.pointAt(i * T.ds + along);
    const ox = p.tz * side, oz = -p.tx * side;
    const ry = Math.atan2(-ox, -oz);
    const m = new THREE.Matrix4().compose(_v.set(p.x + ox * lat, 0, p.z + oz * lat), _q.setFromAxisAngle(_up, ry), _s.set(scale, scale, scale));
    return { m, ry, cx: p.x + ox * lat, cz: p.z + oz * lat, p };
  }
  // frame across the road: origin on the centreline, local +Z = travel direction, +X = track "right" (tz,-tx)
  frameRoad(i) {
    const T = this.track;
    const h = Math.atan2(T.tx[i], T.tz[i]);
    return new THREE.Matrix4().compose(_v.set(T.x[i], 0, T.z[i]), _q.setFromAxisAngle(_up, h), _s.set(1, 1, 1));
  }
  box(b, x, y, z, w, h, d, color, ry = 0) { this.B.push(b, this.G.box, L(x, y, z, ry, w, h, d), color); }
  cyl(b, x, y, z, r, h, color, seg = 12, rTop = r) {
    const key = `cyl${seg}_${(rTop / r).toFixed(3)}`;
    if (!this.G[key]) this.G[key] = new THREE.CylinderGeometry(rTop / r, 1, 1, seg).translate(0, 0.5, 0);
    this.B.push(b, this.G[key], L(x, y, z, 0, r, h, r), color);
  }
  cone(b, x, y, z, r, h, color, seg = 8, ry = 0) {
    const key = `cone${seg}`;
    if (!this.G[key]) this.G[key] = new THREE.ConeGeometry(1, 1, seg).translate(0, 0.5, 0);
    this.B.push(b, this.G[key], L(x, y, z, ry, r, h, r), color);
  }
  sphere(b, x, y, z, r, color, sy = 1, sx = 1) { this.B.push(b, this.G.sphere, L(x, y, z, 0, r * sx, r * sy, r), color); }
  dome(b, x, y, z, r, color, sy = 1) { this.B.push(b, this.G.hemi, L(x, y, z, 0, r, r * sy, r), color); }
  onion(b, x, y, z, r, h, color, finial = '#d4a937') {
    this.B.push(b, this.G.onion, L(x, y, z, 0, r, h, r), color);
    this.cyl(b, x, y + h * 0.97, z, Math.max(0.05, r * 0.05), h * 0.28, finial, 6);
    this.sphere(b, x, y + h * 1.1, z, Math.max(0.08, r * 0.09), finial);
  }
  chhatri(b, x, y, z, r, colP, colD) {
    const hp = r * 1.6;
    for (const [a, c] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) this.box(b, x + a * r * 0.7, y, z + c * r * 0.7, r * 0.18, hp, r * 0.18, colP);
    this.box(b, x, y + hp, z, r * 1.9, r * 0.18, r * 1.9, colP);
    this.onion(b, x, y + hp + r * 0.18, z, r * 0.85, r * 1.5, colD);
  }
  cylBetween(b, ax, ay, az, bx, by, bz, r, color) {
    const dx = bx - ax, dy = by - ay, dz = bz - az, len = Math.hypot(dx, dy, dz) || 0.001;
    _v2.set(dx / len, dy / len, dz / len);
    _q.setFromUnitVectors(_up, _v2);
    _m2.compose(_v.set(ax, ay, az), _q, _s.set(r, len, r));
    if (!this.G.cyl8_1) this.G.cyl8_1 = new THREE.CylinderGeometry(1, 1, 1, 8).translate(0, 0.5, 0);
    this.B.push(b, this.G.cyl8_1, _m2, color);
  }
  sign(x, y, z, w, h, rect, ry = 0) {
    const g = this.G.plane;
    const uv = g.attributes.uv;
    // write the rect into a fresh copy of the plane's uvs
    const gg = g.clone();
    const u = gg.attributes.uv;
    for (let k = 0; k < u.count; k++) u.setXY(k, rect.u0 + uv.getX(k) * (rect.u1 - rect.u0), rect.v0 + uv.getY(k) * (rect.v1 - rect.v0));
    this.B.push('sign', gg, L(x, y, z, ry, w, h, 1), 0xffffff, true);
    gg.dispose();
  }
  // tree in local landmark coordinates (uses the current frame)
  treeLocal(x, z, type = 'neem', size = 1) {
    _v.set(x, 0, z).applyMatrix4(this.B.frame);
    this.addTree(_v.x, _v.z, type, size);
  }
  addTree(x, z, type = 'neem', size = 1) {
    const rnd = this.rnd;
    const s = size * (0.8 + rnd() * 0.45);
    const ry = rnd() * TAU;
    if (type === 'ashoka') {
      this.I.trunk.add(L(x, 0, z, ry, 0.7 * s, 1.6 * s, 0.7 * s), '#5b4430');
      this.I.ashoka.add(L(x, 1.2 * s, z, ry, 1.5 * s, 6.5 * s, 1.5 * s), pick(rnd, ['#2f5d2a', '#386b2f', '#2a5226']));
    } else if (type === 'bush') {
      this.I.canopy.add(L(x, 0.5 * s, z, ry, 1.1 * s, 0.75 * s, 1.1 * s), pick(rnd, ['#4f7a2c', '#5c8a32', '#3f6a28']));
    } else {
      const banyan = type === 'banyan';
      const th = (banyan ? 3.6 : 3.2) * s;
      this.I.trunk.add(L(x, 0, z, ry, (banyan ? 1.8 : 1.15) * s, th, (banyan ? 1.8 : 1.15) * s), pick(rnd, ['#5d4632', '#6b5038', '#4f3b2a']));
      const cr = (banyan ? 4.6 : 3.3) * s;
      this.I.canopy.add(L(x, th + cr * 0.45, z, ry, cr, cr * (banyan ? 0.62 : 0.78), cr), pick(rnd, ['#4c7a2a', '#5a8a2e', '#3f6e27', '#628f35', '#47722a']));
    }
    this.field.mark(x, z, 1.2, 1.2, 0, 0);
  }

  _templates() {
    if (this.G) return;
    const onionPts = [];
    const prof = [[0.78, 0], [0.98, 0.12], [1.06, 0.3], [0.96, 0.5], [0.7, 0.68], [0.38, 0.84], [0.12, 0.95], [0.0, 1.0]];
    for (const [r, y] of prof) onionPts.push(new THREE.Vector2(r, y));
    this.G = {
      box: new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
      boxC: new THREE.BoxGeometry(1, 1, 1),
      sphere: new THREE.SphereGeometry(1, 14, 10),
      hemi: new THREE.SphereGeometry(1, 14, 7, 0, TAU, 0, Math.PI / 2),
      onion: new THREE.LatheGeometry(onionPts, 14),
      plane: new THREE.PlaneGeometry(1, 1),
      ico: new THREE.IcosahedronGeometry(1, 0),
    };
  }

  // ------------------------------------------------------------ shop board atlas (instanced boards)
  _initShopBoards() {
    const tq = this.QL.tex;
    const cw = 512 * tq, ch = 128 * tq, rows = 12;
    const c = makeCanvas(cw * 2, ch * rows), g = c.getContext('2d');
    this.boardRows = rows;
    this.shopCells = []; this.adCells = [];
    const cellUV = (k) => [(k % 2) * 0.5, 1 - (Math.floor(k / 2) + 1) / rows];
    let k = 0;
    for (const [name, sub, bg, fg] of SHOPS) {
      const x = (k % 2) * cw, y = Math.floor(k / 2) * ch;
      g.fillStyle = bg; g.fillRect(x, y, cw, ch);
      g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(x, y + ch * 0.9, cw, ch * 0.1);
      g.strokeStyle = fg; g.lineWidth = 3 * tq; g.strokeRect(x + 6 * tq, y + 6 * tq, cw - 12 * tq, ch - 12 * tq);
      fitText(g, name, x + cw / 2, y + ch * 0.42, cw * 0.9, 50 * tq, { color: fg });
      fitText(g, sub, x + cw / 2, y + ch * 0.76, cw * 0.8, 20 * tq, { color: fg, weight: '700', family: FONT2 });
      this.shopCells.push(cellUV(k)); k++;
    }
    for (const [name, sub, bg, fg, ac] of ADS) {
      const x = (k % 2) * cw, y = Math.floor(k / 2) * ch;
      const gr = g.createLinearGradient(x, y, x + cw, y + ch);
      gr.addColorStop(0, bg); gr.addColorStop(1, ac);
      g.fillStyle = gr; g.fillRect(x, y, cw, ch);
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.beginPath(); g.arc(x + cw * 0.86, y + ch * 0.5, ch * 0.6, 0, TAU); g.fill();
      fitText(g, name, x + cw * 0.46, y + ch * 0.42, cw * 0.84, 58 * tq, { color: fg, stroke: 'rgba(0,0,0,0.35)', strokeW: 4 * tq });
      fitText(g, sub, x + cw * 0.46, y + ch * 0.78, cw * 0.8, 22 * tq, { color: '#ffffff', weight: '800', family: FONT2 });
      this.adCells.push(cellUV(k)); k++;
    }
    this.boardTex = this._tex(c);
  }
  addBoard(matrix, w, h, d, cell) {
    // matrix positions the board centre; scale by w,h,d
    _m.copy(matrix).multiply(_m2.makeScale(w, h, d));
    this.I.board.add(_m, 0xffffff, cell);
  }

  // ------------------------------------------------------------ landmarks
  _landmarks() {
    this._templates();
    const T = this.track;
    for (const lm of T.landmarks) {
      const fn = this['_lm_' + lm.id];
      if (fn) fn.call(this, lm);
      this.B.frame.identity();
    }
  }

  // place a rectangular landmark beside the road; returns false if it truly cannot fit
  _placeSide(lm, W, D, setback = 6.6) {
    const T = this.track, hw = T.halfWidth;
    let side = lm.side || 1;
    for (const sc of [1, 0.85, 0.7]) {
      for (const sd of [side, -side]) {
        const lat = hw + setback + (D * sc) / 2;
        const f = this.frameSide(lm.index, sd, lat, 0, sc);
        if (this.field.rectFree(f.cx, f.cz, W * sc, D * sc, f.ry, hw + 5.2)) {
          this.field.mark(f.cx, f.cz, W * sc, D * sc, f.ry, 1);
          this.B.frame.copy(f.m);
          lm.side = sd;
          return f;
        }
      }
    }
    const f = this.frameSide(lm.index, side, hw + setback + D * 0.35, 0, 0.7);
    this.field.mark(f.cx, f.cz, W * 0.7, D * 0.7, f.ry, 1);
    this.B.frame.copy(f.m);
    return f;
  }

  _lm_brightday(lm) {
    const A = this.atlas;
    const W = 66, D = 48;
    this._placeSide(lm, W, D, 6.4);
    const F = D / 2;
    const cream = '#f4e8c8', blue = '#1f4f9e', navy = '#14306b', white = '#fbfaf6';
    // campus ground
    this.box('std', 0, 0, 0, W, 0.06, D, '#6f9c3e');
    this.box('std', -W * 0.22, 0.02, F - 13, 24, 0.07, 12, '#c9a46a'); // play ground
    this.box('std', 6, 0.02, F - 6, 12, 0.08, 12, '#9a958c'); // driveway
    // compound wall with blue coping
    for (const [x0, x1] of [[-W / 2, -6], [6, W / 2]]) {
      const w = x1 - x0;
      this.box('std', (x0 + x1) / 2, 0, F - 0.3, w, 1.7, 0.35, cream);
      this.box('std', (x0 + x1) / 2, 1.7, F - 0.3, w + 0.1, 0.16, 0.5, blue);
      for (let x = x0 + 3; x < x1 - 1; x += 3.5) this.box('std', x, 0, F - 0.3, 0.5, 1.95, 0.5, blue);
    }
    this.box('std', -W / 2 + 0.2, 0, 0, 0.35, 1.7, D, cream); this.box('std', W / 2 - 0.2, 0, 0, 0.35, 1.7, D, cream);
    this.box('std', 0, 0, -F + 0.2, W, 1.7, 0.35, cream);
    // gate
    for (const x of [-6, 6]) {
      this.box('std', x, 0, F - 0.3, 1.3, 4.4, 1.3, cream);
      this.box('std', x, 4.4, F - 0.3, 1.6, 0.3, 1.6, blue);
      this.sphere('std', x, 4.95, F - 0.3, 0.32, '#ffc533');
    }
    this.box('std', 0, 4.1, F - 0.3, 13.4, 1.4, 0.7, navy);
    const gateR = A.add('bd-gate', 900, 100, (g, w, h) => {
      g.fillStyle = '#14306b'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#ffc533'; g.lineWidth = h * 0.06; g.strokeRect(h * 0.08, h * 0.08, w - h * 0.16, h - h * 0.16);
      fitText(g, 'BRIGHT DAY SCHOOL', w / 2, h * 0.53, w * 0.9, h * 0.62, { color: '#ffffff' });
    });
    this.sign(0, 4.8, F + 0.06, 12.4, 1.2, gateR);
    this.sign(0, 4.8, F - 0.66, 12.4, 1.2, gateR, Math.PI);
    // gate leaves (open)
    for (const s of [-1, 1]) {
      for (let k = 0; k < 7; k++) this.box('gloss', s * (5.3 - k * 0.12) , 0, F - 0.3 - k * 0.55, 0.06, 2.2, 0.06, navy);
      this.box('gloss', s * 4.9, 2.1, F - 2.0, 0.08, 0.08, 3.6, navy, 0.2 * s);
      this.box('gloss', s * 4.9, 0.3, F - 2.0, 0.08, 0.08, 3.6, navy, 0.2 * s);
    }
    // main building
    const bz = -F + 14, bd = 13, bw = 52;
    this.box('std', 0, 0, bz, bw, 12.6, bd, cream);
    for (const y of [0, 4.2, 8.4]) this.box('std', 0, y + 3.85, bz, bw + 0.3, 0.4, bd + 0.3, blue);
    this.box('std', 0, 12.6, bz, bw + 0.4, 0.6, bd + 0.4, blue);
    for (let f = 0; f < 3; f++) {
      for (let k = 0; k < 16; k++) {
        const x = -bw / 2 + 2.2 + k * ((bw - 4.4) / 15);
        if (Math.abs(x) < 8) continue;
        this.box('gloss', x, f * 4.2 + 1.2, bz + bd / 2 + 0.02, 1.7, 2.0, 0.1, '#365a80');
        this.box('std', x, f * 4.2 + 1.05, bz + bd / 2 + 0.05, 2.0, 0.15, 0.3, white);
      }
      // corridor pillars feel
      for (let k = 0; k <= 8; k++) this.box('std', -bw / 2 + k * (bw / 8), f * 4.2, bz + bd / 2 - 0.1, 0.5, 4.2, 0.5, white);
    }
    // central tower with big sign
    const tz = bz + 1.5;
    this.box('std', 0, 0, tz, 15, 17.5, bd + 3, cream);
    this.box('std', 0, 17.5, tz, 15.6, 0.7, bd + 3.6, blue);
    for (const x of [-7.2, 7.2]) this.box('std', x, 0, tz + (bd + 3) / 2 - 0.3, 0.9, 17.6, 0.9, blue);
    const bigR = A.add('bd-big', 1100, 340, (g, w, h) => {
      const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#173d8c'); gr.addColorStop(1, '#0d2759');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#ffc533'; g.lineWidth = h * 0.035; g.strokeRect(h * 0.05, h * 0.05, w - h * 0.1, h - h * 0.1);
      // sun emblem
      const cx = h * 0.42, cy = h * 0.5, r = h * 0.2;
      g.fillStyle = '#ffc533';
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * TAU;
        g.beginPath(); g.moveTo(cx + Math.cos(a - 0.12) * r * 1.15, cy + Math.sin(a - 0.12) * r * 1.15);
        g.lineTo(cx + Math.cos(a) * r * 1.65, cy + Math.sin(a) * r * 1.65);
        g.lineTo(cx + Math.cos(a + 0.12) * r * 1.15, cy + Math.sin(a + 0.12) * r * 1.15); g.fill();
      }
      g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill();
      g.fillStyle = '#e8641b'; g.beginPath(); g.arc(cx, cy, r * 0.62, 0, TAU); g.fill();
      fitText(g, 'BRIGHT DAY SCHOOL', w * 0.56, h * 0.4, w * 0.74, h * 0.34, { color: '#ffffff' });
      g.fillStyle = '#ffc533'; g.fillRect(w * 0.22, h * 0.62, w * 0.68, h * 0.012);
      fitText(g, 'CBSE', w * 0.56, h * 0.77, w * 0.5, h * 0.2, { color: '#ffc533' });
    });
    this.sign(0, 14.4, tz + (bd + 3) / 2 + 0.05, 13.6, 4.2, bigR);
    // portico
    const pz = tz + (bd + 3) / 2;
    this.box('std', 0, 4.6, pz + 2.6, 12, 0.5, 5.6, white);
    this.box('std', 0, 5.1, pz + 2.6, 12.2, 0.2, 5.8, blue);
    for (const x of [-5.4, -1.8, 1.8, 5.4]) this.cyl('std', x, 0, pz + 5, 0.3, 4.6, white, 10);
    this.box('gloss', 0, 0, pz + 0.02, 4, 3.4, 0.1, '#28486e');
    this.box('std', 0, 0, pz + 3, 10, 0.3, 6, '#d8d2c4');
    // flag pole + Indian flag
    const fx = -16, fz = F - 7;
    this.box('std', fx, 0, fz, 2.4, 0.5, 2.4, white); this.box('std', fx, 0.5, fz, 1.6, 0.4, 1.6, white);
    this.cyl('gloss', fx, 0.9, fz, 0.09, 12, '#e8e8e8', 8, 0.06);
    this.sphere('metal', fx, 12.95, fz, 0.16, '#d4a937');
    const flagR = A.add('flag', 300, 200, (g, w, h) => {
      g.fillStyle = '#ff9933'; g.fillRect(0, 0, w, h / 3);
      g.fillStyle = '#ffffff'; g.fillRect(0, h / 3, w, h / 3);
      g.fillStyle = '#138808'; g.fillRect(0, (2 * h) / 3, w, h / 3);
      const cx = w / 2, cy = h / 2, r = h * 0.14;
      g.strokeStyle = '#000080'; g.lineWidth = Math.max(1, h * 0.015);
      g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.stroke();
      for (let k = 0; k < 24; k++) { const a = (k / 24) * TAU; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); g.stroke(); }
    });
    // waving flag made of 4 slightly angled strips
    for (let k = 0; k < 4; k++) {
      const u0 = k / 4, u1 = (k + 1) / 4;
      const sub = { u0: flagR.u0 + (flagR.u1 - flagR.u0) * u0, u1: flagR.u0 + (flagR.u1 - flagR.u0) * u1, v0: flagR.v0, v1: flagR.v1 };
      const x = fx + 0.1 + (k + 0.5) * 0.78, zz = fz + Math.sin(k * 1.4) * 0.18, rot = Math.cos(k * 1.4) * 0.22;
      this.sign(x, 11.55, zz, 0.8, 2.1, sub, rot);
      this.sign(x, 11.55, zz - 0.005, 0.8, 2.1, { u0: sub.u1, u1: sub.u0, v0: sub.v0, v1: sub.v1 }, rot + Math.PI);
    }
    // school bus
    const busR = A.add('bus', 600, 110, (g, w, h) => {
      g.fillStyle = '#f6c000'; g.fillRect(0, 0, w, h);
      fitText(g, 'SCHOOL BUS', w / 2, h * 0.38, w * 0.9, h * 0.52, { color: '#1b1b1b' });
      fitText(g, 'BRIGHT DAY SCHOOL • VADODARA', w / 2, h * 0.8, w * 0.9, h * 0.22, { color: '#14306b', weight: '800', family: FONT2 });
    });
    const busX = 15, busZ = F - 8;
    this.box('gloss', busX, 0.55, busZ, 10, 2.5, 2.5, '#f6c000');
    this.box('gloss', busX, 3.05, busZ, 9.8, 0.25, 2.4, '#f2f2f2');
    this.box('gloss', busX - 0.3, 1.85, busZ, 9.0, 0.95, 2.52, '#2b3a48');
    this.box('gloss', busX + 4.98, 1.4, busZ, 0.1, 1.5, 2.2, '#2b3a48');
    this.box('std', busX, 0.45, busZ, 10.2, 0.35, 2.6, '#222222');
    this.box('glow', busX + 5.02, 0.9, busZ + 0.9, 0.05, 0.25, 0.35, '#fff6d0'); this.box('glow', busX + 5.02, 0.9, busZ - 0.9, 0.05, 0.25, 0.35, '#fff6d0');
    for (const [x, z] of [[busX - 3, busZ - 1.15], [busX - 3, busZ + 1.15], [busX + 3.2, busZ - 1.15], [busX + 3.2, busZ + 1.15]]) {
      this.B.push('std', this.G.boxC, L(x, 0.5, z, 0, 1.0, 1.0, 0.4), '#151515');
    }
    this.sign(busX - 0.5, 1.0, busZ + 1.27, 6.2, 1.1, busR);
    this.sign(busX - 0.5, 1.0, busZ - 1.27, 6.2, 1.1, busR, Math.PI);
    // trees on campus
    for (let k = 0; k < 7; k++) this.treeLocal(-W / 2 + 4 + k * 4.2, F - 2.6, 'ashoka', 0.9);
    for (let k = 0; k < 5; k++) this.treeLocal(W / 2 - 3.5, F - 4 - k * 6, 'ashoka', 0.95);
    this.treeLocal(-W / 2 + 5, -F + 5, 'banyan', 1.1);
    this.treeLocal(W / 2 - 7, -F + 6, 'neem', 1.1);
    for (let k = 0; k < 6; k++) this.treeLocal(-6 - k * 3.8 + 22, F - 2.4, 'bush', 0.6);
  }

  clockRect() {
    return this.atlas.add('clock', 256, 256, (g, w, h) => {
      g.fillStyle = '#f0d3a6'; g.fillRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2, r = w * 0.44;
      g.fillStyle = '#fbf6ea'; g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill();
      g.strokeStyle = '#3b2a20'; g.lineWidth = w * 0.03; g.stroke();
      for (let k = 0; k < 12; k++) { const a = (k / 12) * TAU; g.beginPath(); g.moveTo(cx + Math.cos(a) * r * 0.78, cy + Math.sin(a) * r * 0.78); g.lineTo(cx + Math.cos(a) * r * 0.92, cy + Math.sin(a) * r * 0.92); g.stroke(); }
      g.lineWidth = w * 0.04; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + r * 0.45 * Math.cos(-2.6), cy + r * 0.45 * Math.sin(-2.6)); g.stroke();
      g.lineWidth = w * 0.025; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + r * 0.7 * Math.cos(-0.5), cy + r * 0.7 * Math.sin(-0.5)); g.stroke();
    });
  }

  _facadeArches(key, w, h, { bg, trim, dark, rows = 2, n = 20, band = null, lit = false }) {
    return this.atlas.add(key, w, h, (g, W, H) => {
      g.fillStyle = bg; g.fillRect(0, 0, W, H);
      if (band) { g.fillStyle = band; for (let r = 0; r <= rows; r++) g.fillRect(0, (r / rows) * H - H * 0.025, W, H * 0.05); }
      g.fillStyle = trim; g.fillRect(0, 0, W, H * 0.04); g.fillRect(0, H * 0.96, W, H * 0.04);
      for (let r = 0; r < rows; r++) {
        const y0 = (r / rows) * H, rh = H / rows;
        const aw = W / n;
        for (let k = 0; k < n; k++) {
          const x = k * aw + aw * 0.18, ww = aw * 0.64, yb = y0 + rh * 0.9, ah = rh * 0.68;
          g.fillStyle = trim; archPath(g, x - aw * 0.06, yb, ww + aw * 0.12, ah + aw * 0.08); g.fill();
          g.fillStyle = dark; archPath(g, x, yb, ww, ah); g.fill();
          if (lit && (k * 7 + r * 3) % 5 < 2) { g.fillStyle = 'rgba(255,190,110,0.55)'; archPath(g, x, yb, ww, ah); g.fill(); }
        }
      }
    });
  }

  _lm_palace() {
    const lm = arguments[0];
    const W = 100, D = 58;
    this._placeSide(lm, W, D, 7);
    const F = D / 2;
    const sand = '#d8a46a', light = '#f0d3a6', dome = '#efe3cc', red = '#b8693c';
    this.box('std', 0, 0, 0, W, 0.06, D, '#5f9437');
    this.box('std', 0, 0.02, F - 10, 10, 0.07, 20, '#cdbb98'); // drive
    // hedges
    for (const x of [-30, 30]) this.box('std', x, 0, F - 1.5, 36, 1.0, 1.2, '#3e6f2a');
    // main block
    const mz = -F + 18, md = 16, mw = 78;
    this.box('std', 0, 0, mz, mw, 13, md, sand);
    const fac = this._facadeArches('palace-fac', 1100, 180, { bg: sand, trim: light, dark: '#3b2a20', rows: 2, n: 26, lit: this.P.windows > 0.3 });
    this.sign(0, 6.5, mz + md / 2 + 0.03, mw, 13, fac);
    this.box('std', 0, 13, mz, mw + 0.6, 0.7, md + 0.6, light);
    this.box('std', 0, 6.3, mz, mw + 0.4, 0.4, md + 0.4, light);
    for (let x = -mw / 2 + 5; x <= mw / 2 - 5; x += 9.5) this.chhatri('std', x, 13.7, mz + md / 2 - 1.5, 1.1, light, dome);
    // wings
    for (const s of [-1, 1]) {
      const wx = s * (mw / 2 + 6);
      this.box('std', wx, 0, mz + 3, 14, 17, 22, sand);
      const wf = this._facadeArches('palace-wing', 300, 360, { bg: sand, trim: light, dark: '#3b2a20', rows: 3, n: 4 });
      this.sign(wx, 8.5, mz + 3 + 11.03, 14, 17, wf);
      this.box('std', wx, 17, mz + 3, 14.6, 0.8, 22.6, light);
      this.onion('std', wx, 17.8, mz + 3, 4.6, 7.5, dome);
      for (const a of [-1, 1]) for (const b of [-1, 1]) this.chhatri('std', wx + a * 5.6, 17.8, mz + 3 + b * 9, 1.0, light, dome);
    }
    // central porch
    this.box('std', 6, 0, mz + md / 2 + 4, 16, 9, 8, sand);
    const arch3 = this._facadeArches('palace-porch', 400, 240, { bg: sand, trim: light, dark: '#2c201a', rows: 1, n: 3 });
    this.sign(6, 4.5, mz + md / 2 + 8.03, 16, 9, arch3);
    this.box('std', 6, 9, mz + md / 2 + 4, 16.6, 0.6, 8.6, light);
    this.onion('std', 6, 9.6, mz + md / 2 + 4, 4.2, 6.5, dome);
    // clock tower
    const tx = -16, tz2 = mz + 2;
    this.box('std', tx, 0, tz2, 10, 34, 10, sand);
    for (let y = 8; y < 34; y += 8.5) this.box('std', tx, y, tz2, 10.6, 0.5, 10.6, light);
    const tf = this._facadeArches('palace-tower', 200, 600, { bg: sand, trim: light, dark: '#3b2a20', rows: 5, n: 2 });
    this.sign(tx, 15, tz2 + 5.03, 10, 26, tf);
    this.box('std', tx, 34, tz2, 8, 7, 8, light);
    const clockR = this.clockRect();
    for (const [ox, oz, ry] of [[0, 4.03, 0], [4.03, 0, Math.PI / 2], [-4.03, 0, -Math.PI / 2]]) this.sign(tx + ox, 37.5, tz2 + oz, 5, 5, clockR, ry);
    this.box('std', tx, 41, tz2, 8.8, 0.6, 8.8, red);
    this.onion('std', tx, 41.6, tz2, 3.6, 7, dome);
    for (const a of [-1, 1]) for (const b of [-1, 1]) this.chhatri('std', tx + a * 3.6, 41.6, tz2 + b * 3.6, 0.8, light, dome);
    // garden fountain and lawn trees
    this.cyl('std', 6, 0, F - 18, 3.2, 0.7, '#e7dcc6', 16);
    this.cyl('water', 6, 0.05, F - 18, 2.9, 0.7, '#4f8fb0', 16);
    this.cone('water', 6, 0.7, F - 18, 0.35, 2.6, '#cfe8f5', 8);
    for (const x of [-44, -36, 40, 46]) this.treeLocal(x, F - 6, 'neem', 1.1);
    for (let x = -40; x <= 40; x += 10) if (Math.abs(x - 6) > 8) this.treeLocal(x, F - 3.2, 'ashoka', 0.9);
  }

  _lm_sursagar(lm) {
    const T = this.track, hw = T.halfWidth;
    let R = 40;
    let f = null;
    for (const side of [lm.side, -lm.side]) {
      for (R = 42; R >= 18; R -= 6) {
        const ff = this.frameSide(lm.index, side, hw + 7.5 + R + 3);
        const q = this.field.query(ff.cx, ff.cz);
        if (q.d > R + hw + 8 && this.field.rectFree(ff.cx, ff.cz, 2 * R, 2 * R, ff.ry, hw + 5.2)) { f = ff; lm.side = side; break; }
      }
      if (f) break;
    }
    if (!f) { R = 18; f = this.frameSide(lm.index, lm.side, hw + 7.5 + R + 3); }
    this.field.mark(f.cx, f.cz, 2 * R + 8, 2 * R + 8, f.ry, 1);
    this.B.frame.copy(f.m);
    const stone = '#d9c8a5';
    // stepped ghats
    const prof = [[R + 5, 0.0], [R + 5, 0.75], [R + 3.4, 0.75], [R + 3.4, 0.55], [R + 1.8, 0.55], [R + 1.8, 0.35], [R + 0.2, 0.35], [R + 0.2, 0.1]];
    const lathe = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)).reverse(), 48);
    this.B.push('std', lathe, L(0, 0, 0), stone); lathe.dispose();
    const water = new THREE.CircleGeometry(R + 0.4, 48).rotateX(-Math.PI / 2);
    this.B.push('water', water, L(0, 0.24, 0), '#3d7f94'); water.dispose();
    // railing
    const n = Math.floor((TAU * (R + 4.6)) / 3);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU;
      this.box('std', Math.cos(a) * (R + 4.6), 0.55, Math.sin(a) * (R + 4.6), 0.18, 0.95, 0.18, k % 2 ? '#ffffff' : '#c0392b', -a);
    }
    const tor = new THREE.TorusGeometry(R + 4.6, 0.05, 4, 72).rotateX(Math.PI / 2);
    this.B.push('std', tor, L(0, 1.4, 0), '#eeeeee'); tor.dispose();
    // pedestal
    this.cyl('std', 0, -0.3, 0, 5.2, 1.6, stone, 20);
    this.cyl('std', 0, 1.3, 0, 3.8, 2.6, '#f4efe4', 16);
    this.cyl('std', 0, 2.3, 0, 3.85, 0.4, '#b5452f', 16);
    this.cyl('metal', 0, 3.9, 0, 3.0, 0.9, '#d4a937', 16, 2.2);
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * TAU;
      this.B.push('metal', this.G.sphere, L(Math.cos(a) * 2.5, 4.9, Math.sin(a) * 2.5, -a, 0.6, 0.35, 1.1, 0.5), '#e0b84a');
    }
    // Shiva (standing, raised trishul)
    const g = 'metal', gold = '#d6a935';
    const b0 = 5.1;
    this.box(g, -0.55, b0, 0.2, 0.6, 0.35, 1.0, gold); this.box(g, 0.55, b0, 0.2, 0.6, 0.35, 1.0, gold);
    const dh = new THREE.CylinderGeometry(1.05, 1.65, 7.2, 14).translate(0, 3.6, 0);
    this.B.push(g, dh, L(0, b0 + 0.3, 0, 0, 1.15, 1, 0.85), gold); dh.dispose();
    const torso = new THREE.CylinderGeometry(1.55, 1.0, 5.0, 14).translate(0, 2.5, 0);
    this.B.push(g, torso, L(0, b0 + 7.4, 0, 0, 1.2, 1, 0.8), gold); torso.dispose();
    this.sphere(g, -1.75, b0 + 12.0, 0, 0.78, gold); this.sphere(g, 1.75, b0 + 12.0, 0, 0.78, gold);
    this.cyl(g, 0, b0 + 12.3, 0, 0.45, 0.9, gold, 10);
    this.sphere(g, 0, b0 + 13.9, 0.05, 1.0, gold, 1.15);
    this.cone(g, 0, b0 + 14.7, -0.1, 0.62, 1.7, gold, 10);
    const moon = new THREE.TorusGeometry(0.35, 0.07, 6, 12, Math.PI);
    this.B.push(g, moon, L(0.35, b0 + 15.2, -0.2, 0, 1, 1, 1, 0, -0.6), '#f4e2a0'); moon.dispose();
    const snake = new THREE.TorusGeometry(1.0, 0.16, 6, 16).rotateX(Math.PI / 2);
    this.B.push(g, snake, L(0, b0 + 12.3, 0.05, 0, 1.05, 1, 0.75), '#b8892a'); snake.dispose();
    // right arm raised with trishul
    this.cylBetween(g, 1.85, b0 + 12.1, 0, 2.6, b0 + 14.3, 0.3, 0.42, gold);
    this.cylBetween(g, 2.6, b0 + 14.3, 0.3, 2.75, b0 + 16.3, 0.55, 0.36, gold);
    this.sphere(g, 2.78, b0 + 16.5, 0.55, 0.45, gold);
    this.cylBetween(g, 2.85, b0 + 3.0, 0.6, 2.85, b0 + 22.0, 0.6, 0.11, '#e8c45a');
    for (const dx of [-0.55, 0, 0.55]) this.cone(g, 2.85 + dx, b0 + (dx === 0 ? 22.0 : 21.6), 0.6, 0.16, dx === 0 ? 1.6 : 1.2, '#f1d36b', 6);
    this.box(g, 2.85, b0 + 21.5, 0.6, 1.3, 0.16, 0.16, '#f1d36b');
    this.cone(g, 2.85, b0 + 19.4, 0.6, 0.35, 0.45, '#c9962e', 8); this.cone(g, 2.85, b0 + 19.9, 0.6, 0.35, -0.45, '#c9962e', 8);
    // left arm: abhaya mudra
    this.cylBetween(g, -1.85, b0 + 12.1, 0, -2.3, b0 + 9.9, 0.4, 0.42, gold);
    this.cylBetween(g, -2.3, b0 + 9.9, 0.4, -2.2, b0 + 11.2, 1.6, 0.36, gold);
    this.box(g, -2.2, b0 + 11.1, 1.65, 0.6, 0.9, 0.22, gold);
    // spotlights at the base
    if (this.P.lamps > 0) for (let k = 0; k < 4; k++) { const a = (k / 4) * TAU + 0.4; this.box('glow', Math.cos(a) * 4.9, 1.3, Math.sin(a) * 4.9, 0.5, 0.3, 0.5, '#fff2c0'); }
    // trees around the lake (not on the road side)
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * TAU;
      if (Math.sin(a) > 0.55) continue; // local +Z faces the road
      this.treeLocal(Math.cos(a) * (R + 9), Math.sin(a) * (R + 9), k % 3 ? 'neem' : 'banyan', 1.0);
    }
  }

  _lm_nyaymandir(lm) {
    const W = 70, D = 36;
    this._placeSide(lm, W, D, 6.6);
    const F = D / 2;
    const white = '#f5f0e6', red = '#b8432c', dome = '#f7f3ea';
    this.box('std', 0, 0, 0, W, 0.06, D, '#5d9236');
    const mz = -F + 9, md = 13, mw = 58;
    this.box('std', 0, 0, mz, mw, 12.5, md, white);
    const fac = this._facadeArches('nyay-fac', 1000, 220, { bg: white, trim: red, dark: '#3a2622', rows: 2, n: 18, band: red, lit: this.P.windows > 0.3 });
    this.sign(0, 6.25, mz + md / 2 + 0.03, mw, 12.5, fac);
    this.box('std', 0, 12.5, mz, mw + 0.6, 0.6, md + 0.6, red);
    for (let x = -mw / 2 + 2; x <= mw / 2 - 2; x += 4) this.box('std', x, 13.1, mz + md / 2 - 0.3, 0.6, 1.1, 0.6, white);
    // central tower
    this.box('std', 0, 0, mz + 1, 11, 23, 11, white);
    for (const a of [-1, 1]) for (const b of [-1, 1]) this.box('std', a * 5.2, 0, mz + 1 + b * 5.2, 1.2, 23.4, 1.2, red);
    const tf = this._facadeArches('nyay-tower', 220, 420, { bg: white, trim: red, dark: '#3a2622', rows: 3, n: 2, band: red });
    this.sign(0, 17.5, mz + 6.53, 9.6, 10.5, tf);
    this.box('std', 0, 23, mz + 1, 11.8, 0.6, 11.8, red);
    this.onion('std', 0, 23.6, mz + 1, 4.6, 8, dome);
    for (const a of [-1, 1]) for (const b of [-1, 1]) this.chhatri('std', a * 4.6, 23.6, mz + 1 + b * 4.6, 0.9, white, dome);
    // side towers
    for (const s of [-1, 1]) {
      const x = s * (mw / 2 - 1);
      this.box('std', x, 0, mz, 7, 17, 7, white);
      this.box('std', x, 17, mz, 7.6, 0.5, 7.6, red);
      this.onion('std', x, 17.5, mz, 3.0, 5.2, dome);
    }
    // porch + steps
    this.box('std', 0, 0, mz + md / 2 + 3, 15, 7.5, 6, white);
    const ar = this._facadeArches('nyay-porch', 380, 200, { bg: white, trim: red, dark: '#2c1d19', rows: 1, n: 3 });
    this.sign(0, 3.75, mz + md / 2 + 6.03, 15, 7.5, ar);
    this.box('std', 0, 7.5, mz + md / 2 + 3, 15.6, 0.5, 6.6, red);
    for (let k = 0; k < 3; k++) this.box('std', 0, 0, mz + md / 2 + 6.5 + k * 0.6, 12 - k * 1.5, 0.6 - k * 0.2, 0.6, '#ddd3c2');
    // garden
    for (const x of [-26, -16, 16, 26]) this.treeLocal(x, F - 4, 'ashoka', 0.9);
    this.treeLocal(-W / 2 + 4, F - 6, 'neem', 1.1); this.treeLocal(W / 2 - 4, F - 6, 'neem', 1.1);
  }

  _lm_mandvi(lm) {
    const T = this.track, hw = T.halfWidth;
    // the gate is straight: move it to the straightest stretch nearby
    let i = lm.index, best = Infinity;
    for (let o = -90; o <= 90; o += 2) {
      const j = (lm.index + o + T.N) % T.N;
      let m = 0;
      for (let k = -12; k <= 12; k++) m = Math.max(m, Math.abs(T.curv[(j + k + T.N) % T.N]));
      const score = m + Math.abs(o) * 0.00002;
      if (score < best) { best = score; i = j; }
    }
    lm.index = i;
    this.B.frame.copy(this.frameRoad(i));
    const a = hw + 2.6, pier = 4.2, Dp = 11, H1 = 15.5, H2 = 21;
    const ochre = '#d6ad6a', trim = '#f3e7cf', dome = '#f4ede0', dark = '#7a5a36';
    // arched block spanning the road
    const sh = new THREE.Shape();
    sh.moveTo(-(a + pier), 0); sh.lineTo(a + pier, 0); sh.lineTo(a + pier, H1); sh.lineTo(-(a + pier), H1); sh.lineTo(-(a + pier), 0);
    const hole = new THREE.Path();
    hole.moveTo(-a, 0); hole.lineTo(-a, 7.2); hole.absellipse(0, 7.2, a, 6.0, Math.PI, 0, true); hole.lineTo(a, 0); hole.lineTo(-a, 0);
    sh.holes.push(hole);
    const ex = new THREE.ExtrudeGeometry(sh, { depth: Dp, bevelEnabled: false, curveSegments: 16 }).translate(0, 0, -Dp / 2);
    this.B.push('std', ex, L(0, 0, 0), ochre); ex.dispose();
    // side arches (cosmetic, on the piers)
    for (const s of [-1, 1]) {
      this.box('std', s * (a + pier / 2), 0, -Dp / 2 - 0.02, pier, 0.8, 0.3, trim);
    }
    // cornices
    this.box('std', 0, H1, 0, 2 * (a + pier) + 1.2, 0.7, Dp + 1.2, trim);
    for (const s of [-1, 1]) for (const zz of [-Dp / 2 - 0.25, Dp / 2 + 0.25]) this.box('std', s * (a + pier / 2), 7.0, zz, pier, 0.4, 0.5, trim);
    // arch outline trims
    for (const zz of [-Dp / 2 - 0.08, Dp / 2 + 0.08]) {
      for (let k = 0; k <= 16; k++) {
        const t = Math.PI - (k / 16) * Math.PI;
        const x = Math.cos(t) * (a + 0.3), y = 7.2 + Math.sin(t) * 6.3;
        this.box('std', x, y - 0.25, zz, 1.2, 0.5, 0.25, trim, 0);
      }
    }
    // upper storey with small arched openings
    const up = this._facadeArches('mandvi-up', 700, 150, { bg: ochre, trim, dark: '#3b2a1c', rows: 1, n: 11, lit: this.P.windows > 0.3 });
    this.box('std', 0, H1 + 0.7, 0, 2 * a + 2, H2 - H1 - 0.7, Dp - 2, ochre);
    this.sign(0, (H1 + 0.7 + H2) / 2, -(Dp - 2) / 2 - 0.03, 2 * a + 2, H2 - H1 - 0.7, up, Math.PI);
    this.sign(0, (H1 + 0.7 + H2) / 2, (Dp - 2) / 2 + 0.03, 2 * a + 2, H2 - H1 - 0.7, up);
    this.box('std', 0, H2, 0, 2 * a + 3, 0.6, Dp - 1, trim);
    for (let x = -a; x <= a; x += 2.2) for (const zz of [-(Dp - 1) / 2, (Dp - 1) / 2]) this.box('std', x, H2 + 0.6, zz, 0.5, 0.8, 0.5, trim);
    // corner minarets
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const x = sx * (a + pier - 0.6), z = sz * (Dp / 2 - 0.4);
      this.cyl('std', x, 0, z, 1.5, H2 + 3, ochre, 8);
      for (const y of [7, H1, H2]) this.cyl('std', x, y, z, 1.9, 0.5, trim, 8);
      this.chhatri('std', x, H2 + 3, z, 1.4, trim, dome);
    }
    // central pavilion + clock
    this.chhatri('std', 0, H2 + 0.6, 0, 2.6, trim, dome);
    const clockR = this.clockRect();
    this.sign(0, H1 + 3, -(Dp - 2) / 2 - 0.06, 3, 3, clockR, Math.PI);
    // dark interior soffit
    // keep the road clear but block the footpath (no footpath through the piers)
    for (let k = -8; k <= 8; k++) { const j = (i + k + T.N) % T.N; this.noFoot[0][j] = 1; this.noFoot[1][j] = 1; }
    for (const s of [-1, 1]) {
      const p = T.pointAt(i * T.ds);
      const cx = p.x + p.tz * s * (a + pier / 2), cz = p.z - p.tx * s * (a + pier / 2);
      this.field.mark(cx, cz, pier + 2, Dp + 4, Math.atan2(p.tx, p.tz), 1);
    }
  }

  _lm_circle(lm) {
    const T = this.track, hw = T.halfWidth;
    const R = 10.5;
    let f = null;
    for (const s of [lm.side, -lm.side]) {
      const ff = this.frameSide(lm.index, s, hw + 2.8 + R);
      if (this.field.rectFree(ff.cx, ff.cz, 2 * R - 2, 2 * R - 2, ff.ry, hw + 2.6)) { f = ff; lm.side = s; break; }
    }
    if (!f) f = this.frameSide(lm.index, lm.side, hw + 2.8 + R);
    this.field.mark(f.cx, f.cz, 2 * R + 2, 2 * R + 2, f.ry, 0.5);
    this.B.frame.copy(f.m);
    const sideIdx = lm.side > 0 ? 1 : 0;
    for (let k = -16; k <= 16; k++) this.noFoot[sideIdx][(lm.index + k + T.N) % T.N] = 1;
    // striped kerb ring
    const n = 36;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU;
      this.box('std', Math.cos(a) * R, 0, Math.sin(a) * R, 0.45, 0.42, (TAU * R) / n + 0.05, k % 2 ? '#1c1c1c' : '#f2c500', -a);
    }
    this.cyl('std', 0, 0, 0, R - 0.1, 0.4, '#5c9a36', 32);
    this.cyl('std', 0, 0.4, 0, R - 1.2, 0.2, '#ff9f1c', 28);
    this.cyl('std', 0, 0.45, 0, R - 2.2, 0.2, '#4f8f30', 28);
    // fountain basin around the pedestal
    this.cyl('std', 0, 0.6, 0, 5, 0.7, '#ece4d4', 24);
    this.cyl('water', 0, 0.65, 0, 4.6, 0.75, '#4a92b8', 24);
    for (let k = 0; k < 8; k++) { const a = (k / 8) * TAU; this.cone('water', Math.cos(a) * 3.4, 1.3, Math.sin(a) * 3.4, 0.18, 1.8, '#d6eef8', 6); }
    // pedestal + statue by circle
    const name = (lm.label || '').toUpperCase();
    this.box('std', 0, 1.3, 0, 2.6, 3.2, 2.6, '#f4efe6');
    this.box('std', 0, 4.5, 0, 3.0, 0.4, 3.0, '#c0392b');
    const top = 4.9, br = '#8a5a2b';
    if (name.includes('CHAKLI')) {
      // sparrow sculpture
      this.sphere('metal', 0, top + 1.6, 0, 1.6, br, 0.85, 1.35);
      this.sphere('metal', 1.6, top + 2.4, 0, 0.9, '#7a4a22');
      this.cone('metal', 2.6, top + 2.35, 0, 0.25, 0.7, '#e0a020', 6);
      this.B.push('metal', this.G.boxC, L(-2.0, top + 2.0, 0, 0, 1.6, 0.25, 0.9, 0, 0.5), '#6e4420');
      this.B.push('metal', this.G.sphere, L(0, top + 2.0, 1.0, 0, 1.2, 0.5, 0.25, 0, 0.3), '#5e3a1a');
      this.B.push('metal', this.G.sphere, L(0, top + 2.0, -1.0, 0, 1.2, 0.5, 0.25, 0, 0.3), '#5e3a1a');
      this.cyl('metal', 0.3, top, 0.4, 0.08, 0.6, '#444', 6); this.cyl('metal', 0.3, top, -0.4, 0.08, 0.6, '#444', 6);
    } else if (name.includes('GENDA')) {
      // rhino (genda)
      const gr = '#707478';
      this.box('metal', 0, top + 1.0, 0, 3.6, 1.8, 1.8, gr);
      this.box('metal', 2.1, top + 1.2, 0, 1.3, 1.2, 1.2, gr);
      this.cone('metal', 2.7, top + 2.3, 0, 0.25, 0.9, '#d8d0c0', 6);
      for (const [x, z] of [[-1.3, -0.6], [-1.3, 0.6], [1.2, -0.6], [1.2, 0.6]]) this.box('metal', x, top, z, 0.55, 1.1, 0.55, gr);
      this.box('metal', 1.8, top + 2.3, 0.45, 0.2, 0.4, 0.1, gr); this.box('metal', 1.8, top + 2.3, -0.45, 0.2, 0.4, 0.1, gr);
    } else {
      // standing leader statue
      const b = '#7b5a3a';
      this.cyl('metal', -0.3, top, 0, 0.32, 2.4, b, 8); this.cyl('metal', 0.3, top, 0, 0.32, 2.4, b, 8);
      this.cyl('metal', 0, top + 2.2, 0, 0.75, 2.4, b, 10, 0.85);
      this.sphere('metal', 0, top + 5.1, 0, 0.5, b);
      this.cylBetween('metal', 0.85, top + 4.3, 0, 1.4, top + 5.6, 0.6, 0.2, b);
      this.cylBetween('metal', -0.85, top + 4.3, 0, -1.0, top + 2.9, 0.2, 0.2, b);
    }
    for (let k = 0; k < 6; k++) { const a = (k / 6) * TAU + 0.5; this.treeLocal(Math.cos(a) * (R - 1.6), Math.sin(a) * (R - 1.6), 'bush', 0.55); }
  }

  _lm_mall(lm) {
    const W = 84, D = 54;
    this._placeSide(lm, W, D, 6.6);
    const F = D / 2;
    this.box('std', 0, 0, 0, W, 0.07, D, '#8f8d88');
    for (let x = -W / 2 + 4; x < W / 2 - 3; x += 3) { this.box('std', x, 0.07, F - 5.5, 0.12, 0.02, 5, '#f4f4f4'); this.box('std', x, 0.07, F - 13, 0.12, 0.02, 5, '#f4f4f4'); }
    const mz = -F + 15, md = 28, mw = 72;
    this.box('glass', 0, 0, mz, mw, 20, md, '#8fb4cc');
    this.box('std', 0, 20, mz, mw + 1, 2.4, md + 1, '#ebe7df');
    this.box('std', 0, 0, mz, mw + 1, 1.2, md + 1, '#d8d3ca');
    for (let x = -mw / 2; x <= mw / 2; x += 8) this.box('std', x, 0, mz + md / 2 + 0.2, 0.8, 20, 0.8, '#f2efe8');
    for (let y = 5; y < 20; y += 5) this.box('std', 0, y, mz + md / 2 + 0.1, mw, 0.4, 0.4, '#f2efe8');
    // entrance block + canopy
    this.box('std', 0, 0, mz + md / 2 + 1.5, 20, 24, 3, '#c4161c');
    this.box('std', 0, 6, mz + md / 2 + 6, 22, 0.6, 8, '#f2efe8');
    for (const x of [-9.5, 9.5]) this.cyl('gloss', x, 0, mz + md / 2 + 9.4, 0.25, 6, '#c8ccd0', 10);
    const sr = this.atlas.add('mall', 1000, 150, (g, w, h) => {
      g.fillStyle = '#c4161c'; g.fillRect(0, 0, w, h);
      fitText(g, 'GOTRI CENTRAL MALL', w / 2, h * 0.42, w * 0.92, h * 0.5, { color: '#ffffff' });
      fitText(g, 'FOOD COURT • MULTIPLEX • SHOPPING', w / 2, h * 0.8, w * 0.8, h * 0.18, { color: '#ffd8d8', weight: '800', family: FONT2 });
    });
    this.sign(0, 19.5, mz + md / 2 + 3.05, 19, 2.85, sr);
    this.sign(-23, 21.2, mz + md / 2 + 0.55, 22, 3.3, sr);
    this.sign(23, 21.2, mz + md / 2 + 0.55, 22, 3.3, sr);
    this.box('glass', 0, 0, mz + md / 2 + 3.0, 12, 5.5, 0.1, '#9cc4dc');
    // parked cars
    const cols = ['#c8102e', '#f2f2f0', '#1f4fa8', '#9aa3ad', '#1b1b1f', '#e5601d'];
    for (let k = 0; k < 12; k++) {
      const x = -W / 2 + 6 + k * 6.1 + (k % 3) * 0.4, z = F - (k % 2 ? 5.5 : 13);
      if (Math.abs(x) < 6) continue;
      this.box('gloss', x, 0.25, z, 1.6, 0.75, 3.6, pick(this.rnd, cols));
      this.box('gloss', x, 1.0, z - 0.2, 1.45, 0.55, 2.0, '#2a3440');
    }
    for (let x = -W / 2 + 3; x < W / 2; x += 7) this.treeLocal(x, F - 1.5, 'ashoka', 0.85);
  }

  _lm_sayajibaug(lm) {
    const W = 96, D = 72;
    const f = this._placeSide(lm, W, D, 6.6);
    const F = D / 2;
    this.box('std', 0, 0, 0, W, 0.06, D, '#5a9a38');
    // fence + gate
    for (let x = -W / 2; x <= W / 2; x += 2.5) if (Math.abs(x) > 7) this.box('std', x, 0, F - 0.3, 0.18, 1.6, 0.18, '#2d4a2d');
    for (const [x0, x1] of [[-W / 2, -7], [7, W / 2]]) { this.box('std', (x0 + x1) / 2, 1.4, F - 0.3, x1 - x0, 0.12, 0.12, '#2d4a2d'); this.box('std', (x0 + x1) / 2, 0.5, F - 0.3, x1 - x0, 0.12, 0.12, '#2d4a2d'); }
    const maroon = '#6b1a1a', sand = '#e2c08f';
    for (const s of [-1, 1]) { this.box('std', s * 6.5, 0, F - 0.3, 1.6, 6, 1.6, sand); this.onion('std', s * 6.5, 6, F - 0.3, 1.0, 1.8, '#f3e7cf'); }
    this.box('std', 0, 5, F - 0.3, 12, 1.6, 0.9, maroon);
    const gr = this.atlas.add('baug', 800, 120, (g, w, h) => {
      g.fillStyle = '#6b1a1a'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#e2b04a'; g.lineWidth = h * 0.05; g.strokeRect(h * 0.08, h * 0.08, w - h * 0.16, h - h * 0.16);
      fitText(g, 'SAYAJI BAUG', w / 2, h * 0.44, w * 0.9, h * 0.5, { color: '#ffd166' });
      fitText(g, 'KAMATI BAUG • ESTD. 1879', w / 2, h * 0.8, w * 0.7, h * 0.18, { color: '#ffffff', weight: '800', family: FONT2 });
    });
    this.sign(0, 5.8, F + 0.17, 11.6, 1.5, gr);
    this.sign(0, 5.8, F - 0.77, 11.6, 1.5, gr, Math.PI);
    // toy train track (stadium loop)
    const cz = -4, Ls = 40, R = 13;
    const path = (t) => { // t in [0,1)
      const per = 2 * Ls + TAU * R;
      let s = (((t % 1) + 1) % 1) * per;
      if (s < Ls) return [-Ls / 2 + s, cz + R, 0];
      s -= Ls;
      if (s < Math.PI * R) { const a = s / R; return [Ls / 2 + Math.sin(a) * R, cz + Math.cos(a) * R, -a]; }
      s -= Math.PI * R;
      if (s < Ls) return [Ls / 2 - s, cz - R, -Math.PI];
      s -= Ls;
      const a = s / R; return [-Ls / 2 - Math.sin(a) * R, cz - Math.cos(a) * R, -Math.PI - a];
    };
    const per = 2 * Ls + TAU * R, segs = Math.floor(per / 1.6);
    for (let k = 0; k < segs; k++) {
      const [x, z, a] = path(k / segs);
      this.box('std', x, 0.06, z, 2.0, 0.12, 0.32, '#6b4a2e', a + Math.PI / 2);
      const nx = Math.sin(a + Math.PI / 2), nz = Math.cos(a + Math.PI / 2);
      for (const o of [-0.5, 0.5]) this.box('gloss', x + nx * o, 0.18, z + nz * o, 0.08, 0.1, 1.66, '#8a8f96', a + Math.PI / 2);
    }
    // bandstand in the middle
    this.box('std', 0, 0, cz, 7, 0.6, 7, '#efe6d6');
    this.chhatri('std', 0, 0.6, cz, 3, '#f8f4ec', '#f8f4ec');
    // trees: lots
    for (let k = 0; k < 26; k++) {
      const x = (this.rnd() - 0.5) * (W - 8), z = (this.rnd() - 0.5) * (D - 10);
      const inLoop = Math.abs(z - cz) < R + 3 && Math.abs(x) < Ls / 2 + R + 3;
      if (inLoop && !(Math.abs(z - cz) < R - 4 && Math.abs(x) < Ls / 2 - 2 && Math.abs(x) > 6)) continue;
      if (z > F - 6 && Math.abs(x) < 10) continue;
      this.treeLocal(x, z, k % 4 === 0 ? 'banyan' : k % 3 === 0 ? 'ashoka' : 'neem', 1.05);
    }
    for (let x = -W / 2 + 4; x < W / 2 - 3; x += 6) if (Math.abs(x) > 9) this.treeLocal(x, F - 3, 'bush', 0.8);
    // the toy train itself (animated, separate small meshes)
    const frame = f.m.clone();
    const cars = [];
    const mkCar = (engine, color) => {
      const b = new Builder();
      const push = (geo, m, c) => b.push('std', geo, m, c);
      if (engine) {
        push(this.G.box, L(0, 0.3, 0, 0, 1.2, 0.5, 2.4), '#c1121f');
        push(new THREE.CylinderGeometry(0.42, 0.42, 1.5, 12).rotateX(Math.PI / 2), L(0, 1.15, 0.3), '#1b1b1b');
        push(this.G.box, L(0, 0.8, -0.75, 0, 1.2, 1.3, 0.9), '#c1121f');
        push(this.G.box, L(0, 2.1, -0.75, 0, 1.4, 0.12, 1.1), '#ffd166');
        push(new THREE.CylinderGeometry(0.12, 0.2, 0.7, 8), L(0, 1.85, 0.75), '#1b1b1b');
      } else {
        push(this.G.box, L(0, 0.3, 0, 0, 1.2, 0.35, 2.2), color);
        push(this.G.box, L(0, 0.65, 0, 0, 1.2, 0.4, 2.2), '#f8f4ec');
        for (const [x, z] of [[-0.5, -0.9], [0.5, -0.9], [-0.5, 0.9], [0.5, 0.9]]) push(this.G.box, L(x, 0.65, z, 0, 0.08, 1.0, 0.08), '#333');
        push(this.G.box, L(0, 1.65, 0, 0, 1.4, 0.1, 2.4), color);
      }
      for (const z of [-0.7, 0.7]) push(new THREE.CylinderGeometry(0.22, 0.22, 1.3, 10).rotateZ(Math.PI / 2), L(0, 0.24, z), '#222');
      const g = b.merged('std');
      const mesh = new THREE.Mesh(g, this.M.std);
      this.root.add(mesh); this._track(g);
      mesh.castShadow = this.QL.shadows;
      return mesh;
    };
    this._pendingTrain = () => {
      cars.push(mkCar(true), mkCar(false, '#1d4e89'), mkCar(false, '#2b9348'), mkCar(false, '#ffb703'));
      const per2 = per;
      const tmpM = new THREE.Matrix4();
      this._anims.push((dt, t) => {
        cars.forEach((c, k) => {
          const [x, z, a] = path((t * 3.2 - k * 2.8) / per2);
          tmpM.compose(_v.set(x, 0.18, z), _q.setFromAxisAngle(_up, a + Math.PI / 2), _s.set(1, 1, 1));
          c.matrixAutoUpdate = false;
          c.matrix.multiplyMatrices(frame, tmpM);
          c.matrixWorldNeedsUpdate = true;
        });
      });
    };
  }

  _lm_station(lm) {
    const W = 104, D = 44;
    this._placeSide(lm, W, D, 6.6);
    const F = D / 2;
    const cream = '#f0dcae', brown = '#8e2b22', roof = '#9c3b2b';
    this.box('std', 0, 0, 0, W, 0.07, D, '#a7a29a');
    // main building
    const bx = -14, bz = -F + 11, bw = 64, bd = 14;
    this.box('std', bx, 0, bz, bw, 11, bd, cream);
    this.box('std', bx, 3.6, bz, bw + 0.3, 0.4, bd + 0.3, brown);
    this.box('std', bx, 11, bz, bw + 0.6, 0.6, bd + 0.6, brown);
    const fac = this._facadeArches('station-fac', 900, 150, { bg: cream, trim: '#fff7e6', dark: '#3a2a22', rows: 2, n: 20, band: brown, lit: this.P.windows > 0.3 });
    this.sign(bx, 5.5, bz + bd / 2 + 0.03, bw, 11, fac);
    // sloped tiled roofs
    for (const s of [-1, 1]) this.box('std', bx, 11.4, bz + s * 3.2, bw + 1, 0.3, 7.6, roof, 0);
    this.B.push('std', this.G.box, L(bx, 11.4, bz, 0, bw + 1, 2.2, 0.6), roof);
    // central block with portico + clock + signs
    const cz = bz + bd / 2 + 2;
    this.box('std', bx, 0, cz - 1, 18, 17, 6, cream);
    this.box('std', bx, 17, cz - 1, 18.8, 0.7, 6.8, brown);
    this.chhatri('std', bx, 17.7, cz - 1, 2.0, cream, '#f7efe0');
    this.box('std', bx, 6, cz + 4, 20, 0.6, 8, brown);
    for (const x of [-9, -3, 3, 9]) this.cyl('std', bx + x, 0, cz + 7.6, 0.35, 6, '#fff7e6', 10);
    const clockR = this.clockRect();
    this.sign(bx, 14.6, cz + 2.04, 3.2, 3.2, clockR);
    const st = this.atlas.add('station', 1000, 260, (g, w, h) => {
      g.fillStyle = '#f7d117'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#111'; g.lineWidth = h * 0.05; g.strokeRect(h * 0.05, h * 0.05, w - h * 0.1, h - h * 0.1);
      fitText(g, 'वडोदरा जंक्शन', w / 2, h * 0.3, w * 0.7, h * 0.26, { color: '#111', weight: '700', family: '"Nirmala UI", "Noto Sans Devanagari", "Mangal", "Kohinoor Devanagari", sans-serif' });
      fitText(g, 'VADODARA JN', w / 2, h * 0.66, w * 0.86, h * 0.38, { color: '#111' });
    });
    this.sign(bx, 9.6, cz + 2.04, 14, 3.6, st);
    // platform board near the road
    this.box('std', bx + 14, 0, F - 3, 0.2, 3.2, 0.2, '#111'); this.box('std', bx + 21, 0, F - 3, 0.2, 3.2, 0.2, '#111');
    this.sign(bx + 17.5, 3.6, F - 2.88, 8, 2.1, st);
    this.sign(bx + 17.5, 3.6, F - 3.12, 8, 2.1, st, Math.PI);
    // platform, canopy and a train on the right
    const px = 34;
    this.box('std', px, 0, -2, 30, 1.0, 9, '#bdb6a8');
    this.box('std', px, 1.0, -2 + 4.2, 30, 0.02, 0.4, '#f2c500');
    for (let x = px - 13; x <= px + 13; x += 6.5) this.box('gloss', x, 1, -2, 0.3, 4.2, 0.3, '#2e6b5e');
    this.box('gloss', px, 5.2, -2, 31, 0.3, 8, '#2e6b5e');
    for (let k = 0; k < 2; k++) {
      const z = -9.5, x = px - 7.5 + k * 15;
      this.box('gloss', x, 0.9, z, 14.4, 3.0, 3.1, '#25418a');
      this.box('gloss', x, 2.1, z, 14.42, 0.7, 3.12, '#e8e2d4');
      for (let w = -6; w <= 6; w += 1.5) this.box('gloss', x + w, 2.15, z + 1.57, 0.8, 0.6, 0.04, '#2b2f36');
      this.box('std', x, 3.9, z, 14.2, 0.3, 2.9, '#6b7078');
      this.box('std', x, 0.2, z, 13, 0.7, 2.4, '#222');
    }
    this.box('std', px, 0, -9.5, 34, 0.25, 3.4, '#5a4a3a');
    for (let x = -W / 2 + 4; x < W / 2; x += 9) this.treeLocal(x, F - 1.6, 'neem', 0.9);
  }

  // ------------------------------------------------------------ start / finish
  _startGantry() {
    const T = this.track, hw = T.halfWidth, A = this.atlas;
    this.B.frame.copy(this.frameRoad(0));
    const ind = '#1d1747', saff = '#ff9933';
    const px = hw + 3.4;
    for (const s of [-1, 1]) {
      this.box('std', s * px, 0, 0, 1.3, 9.2, 1.3, ind);
      for (let y = 1; y < 8; y += 2.2) this.box('std', s * px, y, 0, 1.36, 0.5, 1.36, saff);
      this.box('std', s * px, 0, 0, 2.0, 0.6, 2.0, '#d8d2c4');
    }
    this.box('std', 0, 6.8, 0, 2 * px + 1.4, 2.4, 1.0, ind);
    this.box('std', 0, 9.2, 0, 2 * px + 1.6, 0.25, 1.2, saff);
    const gr = A.add('gantry', 1600, 140, (g, w, h) => {
      const grd = g.createLinearGradient(0, 0, 0, h); grd.addColorStop(0, '#2a2266'); grd.addColorStop(1, '#14103a');
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
      const sq = h / 4;
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
        g.fillStyle = (r + c) % 2 ? '#111' : '#fff';
        g.fillRect(c * sq, r * sq, sq, sq); g.fillRect(w - (c + 1) * sq, r * sq, sq, sq);
      }
      g.fillStyle = '#ff9933'; g.fillRect(sq * 4, 0, w - sq * 8, h * 0.07); g.fillRect(sq * 4, h * 0.93, w - sq * 8, h * 0.07);
      const t1 = BRAND.title, t2 = ' • ' + BRAND.subtitle;
      let size = h * 0.58;
      g.font = `900 ${size}px ${FONT}`;
      const tw = g.measureText(t1 + t2).width, maxW = w - sq * 9;
      if (tw > maxW) { size *= maxW / tw; g.font = `900 ${size}px ${FONT}`; }
      const w1 = g.measureText(t1).width, w2 = g.measureText(t2).width;
      let x = w / 2 - (w1 + w2) / 2;
      g.textBaseline = 'middle'; g.textAlign = 'left';
      g.fillStyle = '#ffc533'; g.fillText(t1, x, h * 0.53);
      g.fillStyle = '#ffffff'; g.fillText(t2, x + w1, h * 0.53);
    });
    const sw = 2 * px - 0.2;
    this.sign(0, 8.0, -0.52, sw, sw * (140 / 1600), gr, Math.PI);
    this.sign(0, 8.0, 0.52, sw, sw * (140 / 1600), gr);
    // start lights
    for (let k = -2; k <= 2; k++) this.cyl('glow', k * 1.1, 6.15, -0.62, 0.32, 0.25, '#ff3030', 10);
    // chequered strip on the road
    const cq = A.add('chequer', 512, 64, (g, w, h) => {
      const n = 16, sq = w / n;
      for (let r = 0; r < 2; r++) for (let c = 0; c < n; c++) { g.fillStyle = (r + c) % 2 ? '#141414' : '#f4f4f4'; g.fillRect(c * sq, r * (h / 2), sq, h / 2); }
    });
    this.B.push('sign', (() => {
      const g = this.G.plane.clone().rotateX(-Math.PI / 2);
      const u = g.attributes.uv;
      for (let k = 0; k < u.count; k++) u.setXY(k, cq.u0 + u.getX(k) * (cq.u1 - cq.u0), cq.v0 + u.getY(k) * (cq.v1 - cq.v0));
      return g;
    })(), L(0, 0.055, 0, 0, 2 * hw, 1, 2.2), 0xffffff, true);
    // grid boxes
    this.B.frame.identity();
    for (let s = 0; s < 8; s++) {
      const gp = T.grid(s);
      const ry = gp.h;
      const fx = Math.sin(ry), fz = Math.cos(ry);
      this.box('std', gp.x + fx * 2.2, 0.03, gp.z + fz * 2.2, 2.6, 0.03, 0.22, '#f4f4f4', ry);
      const rx = Math.cos(ry), rz = -Math.sin(ry);
      for (const o of [-1.25, 1.25]) this.box('std', gp.x + rx * o + fx * 0.9, 0.03, gp.z + rz * o + fz * 0.9, 0.16, 0.03, 2.6, '#f4f4f4', ry);
    }
    // keep scenery off the gantry feet
    const p = T.pointAt(0);
    for (const s of [-1, 1]) this.field.mark(p.x + p.tz * s * px, p.z - p.tx * s * px, 3, 3, 0, 0.5);
    // bunting across the road near the start
    for (const di of [-30, 26, 60]) this._bunting((di + T.N) % T.N, 6.4);
  }

  _bunting(i, h) {
    const T = this.track, hw = T.halfWidth;
    this.B.frame.copy(this.frameRoad(i));
    const span = hw + 4.6, n = 26;
    const cols = ['#ff9933', '#ffffff', '#138808', '#ffc533', '#ff4f9a', '#00b4d8'];
    if (!this.G.tri) {
      const sh = new THREE.Shape(); sh.moveTo(-0.28, 0); sh.lineTo(0.28, 0); sh.lineTo(0, -0.62); sh.lineTo(-0.28, 0);
      this.G.tri = new THREE.ShapeGeometry(sh);
    }
    let prev = null;
    for (let k = 0; k <= n; k++) {
      const t = k / n, x = -span + 2 * span * t, y = h - Math.sin(t * Math.PI) * 1.4;
      if (prev) this.cylBetween('std', prev[0], prev[1], 0, x, y, 0, 0.02, '#333');
      prev = [x, y];
      if (k < n) {
        const c = cols[k % cols.length];
        this.B.push('std', this.G.tri, L(x + span / n, y - Math.sin((t + 0.5 / n) * Math.PI) * 0.05, 0.01), c);
        this.B.push('std', this.G.tri, L(x + span / n, y - Math.sin((t + 0.5 / n) * Math.PI) * 0.05, -0.01, Math.PI), c);
      }
    }
    for (const s of [-1, 1]) this.cyl('std', s * span, 0, 0, 0.1, h + 0.3, '#6b7078', 8);
    this.B.frame.identity();
  }

  _labelBoards() {
    const T = this.track, hw = T.halfWidth, A = this.atlas;
    for (const lb of T.labels) {
      const i = (lb.index - 40 + T.N) % T.N;
      let side = 1;
      if (T.landmarks.some((l) => Math.abs(l.index - lb.index) < 60 && l.side === 1)) side = -1;
      let f = null;
      for (const s of [side, -side]) {
        const ff = this.frameSide(i, s, hw + 6.2);
        if (this.field.rectFree(ff.cx, ff.cz, 2, 7, ff.ry + Math.PI / 2, hw + 1.6)) { f = ff; side = s; break; }
      }
      if (!f) continue;
      const r = A.add('lbl-' + lb.text, 560, 170, (g, w, h) => {
        g.fillStyle = '#05683b'; g.fillRect(0, 0, w, h);
        g.strokeStyle = '#ffffff'; g.lineWidth = h * 0.045; roundRect(g, h * 0.07, h * 0.07, w - h * 0.14, h - h * 0.14, h * 0.08); g.stroke();
        // arrow
        g.fillStyle = '#fff';
        const ax = h * 0.42, ay = h * 0.5;
        g.beginPath(); g.moveTo(ax, ay - h * 0.28); g.lineTo(ax + h * 0.16, ay - h * 0.08); g.lineTo(ax + h * 0.06, ay - h * 0.08); g.lineTo(ax + h * 0.06, ay + h * 0.26);
        g.lineTo(ax - h * 0.06, ay + h * 0.26); g.lineTo(ax - h * 0.06, ay - h * 0.08); g.lineTo(ax - h * 0.16, ay - h * 0.08); g.closePath(); g.fill();
        fitText(g, lb.text, w * 0.56, h * 0.42, w * 0.7, h * 0.36, { color: '#ffffff', weight: '800', family: FONT2 });
        fitText(g, 'VADODARA', w * 0.56, h * 0.76, w * 0.5, h * 0.17, { color: '#d8f3dc', weight: '700', family: FONT2 });
      });
      // board faces oncoming traffic: local frame +Z faces road, so rotate so the board normal faces -travel
      this.B.frame.copy(f.m);
      const back = -side; // local X runs along the road in direction side*t ; facing -t means local -X*side
      const ry = (Math.PI / 2) * back * -1;
      const bw = 6.2, bh = 1.9;
      for (const z of [-2.2, 2.2]) this.box('std', 0, 0, z, 0.16, 4.6, 0.16, '#9aa0a6');
      this.box('std', 0.08 * side, 2.6, 0, 0.1, bh + 0.1, bw + 0.1, '#7a8086');
      this.sign(-0.03 * side * -1, 3.6, 0, bw, bh, r, ry);
      this.B.frame.identity();
      this.field.mark(f.cx, f.cz, 2, 7, f.ry, 0.5);
    }
  }

  // ------------------------------------------------------------ road, kerbs, footpaths, barriers
  _road() {
    const T = this.track, hw = T.halfWidth, N = T.N, ds = T.ds;
    const X = T.x, Z = T.z, TX = T.tx, TZ = T.tz;
    const W = hw + 2.4, RL = 24;
    // ---- asphalt texture
    const tq = this.QL.tex;
    const cw = Math.round(512 * tq), chh = Math.round(512 * tq);
    const c = makeCanvas(cw, chh), g = c.getContext('2d');
    const rnd = mulberry32(hashStr(T.id + 'road'));
    const px = (lat) => ((lat + W) / (2 * W)) * cw; // lateral metres -> px
    const py = (s) => (s / RL) * chh;
    g.fillStyle = '#46474b'; g.fillRect(0, 0, cw, chh);
    // shoulder dust
    for (const s of [-1, 1]) {
      const x0 = px(s * (hw + 0.1)), x1 = px(s * W);
      const gr = g.createLinearGradient(x0, 0, x1, 0);
      gr.addColorStop(0, 'rgba(120,105,80,0)'); gr.addColorStop(0.5, 'rgba(130,112,84,0.55)'); gr.addColorStop(1, 'rgba(150,128,95,0.85)');
      g.fillStyle = gr; g.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), chh);
    }
    // patches
    for (let k = 0; k < 4; k++) {
      const lat = (rnd() - 0.5) * 2 * hw * 0.8, s = rnd() * RL, w = 1 + rnd() * 2.5, l = 1.5 + rnd() * 3;
      g.fillStyle = rnd() < 0.5 ? 'rgba(30,30,33,0.16)' : 'rgba(110,110,112,0.1)';
      g.fillRect(px(lat), py(s), (w / (2 * W)) * cw, (l / RL) * chh);
    }
    // wheel tracks
    for (const lane of [-hw * 0.75, -hw * 0.25, hw * 0.25, hw * 0.75]) {
      for (const o of [-0.8, 0.8]) {
        const x = px(lane + o);
        const gr = g.createLinearGradient(x - cw * 0.02, 0, x + cw * 0.02, 0);
        gr.addColorStop(0, 'rgba(20,20,22,0)'); gr.addColorStop(0.5, 'rgba(20,20,22,0.22)'); gr.addColorStop(1, 'rgba(20,20,22,0)');
        g.fillStyle = gr; g.fillRect(x - cw * 0.02, 0, cw * 0.04, chh);
      }
    }
    // aggregate speckle
    for (let k = 0; k < cw * chh * 0.03; k++) {
      const v = 60 + rnd() * 50;
      g.fillStyle = `rgba(${v},${v},${v + 4},${0.15 + rnd() * 0.25})`;
      g.fillRect(rnd() * cw, rnd() * chh, 1 + rnd() * 1.4, 1 + rnd() * 1.4);
    }
    // cracks
    g.strokeStyle = 'rgba(20,20,20,0.22)'; g.lineWidth = 1;
    for (let k = 0; k < 2; k++) {
      let x = px((rnd() - 0.5) * 2 * hw), y = rnd() * chh;
      g.beginPath(); g.moveTo(x, y);
      for (let j = 0; j < 6; j++) { x += (rnd() - 0.5) * cw * 0.05; y += rnd() * chh * 0.03; g.lineTo(x, y); }
      g.stroke();
    }
    // markings
    const paint = (lat0, lat1, s0, s1, col) => { g.fillStyle = col; g.fillRect(px(lat0), py(s0), px(lat1) - px(lat0), py(s1) - py(s0)); };
    paint(-hw + 0.25, -hw + 0.45, 0, RL, '#efeee6');
    paint(hw - 0.45, hw - 0.25, 0, RL, '#efeee6');
    for (let s = 0; s < RL; s += 8) { paint(-0.09, 0.09, s, s + 4, '#f1f0e8'); }
    if (hw >= 7) for (const lane of [-hw / 2, hw / 2]) for (let s = 2; s < RL; s += 8) paint(lane - 0.06, lane + 0.06, s, s + 2.5, 'rgba(240,240,232,0.85)');
    // worn paint
    for (let k = 0; k < 900 * tq; k++) { g.fillStyle = `rgba(70,71,75,${0.3 + rnd() * 0.5})`; g.fillRect(rnd() * cw, rnd() * chh, 1.5, 1.5); }
    grain(g, cw, chh, 7, rnd);
    const roadTex = this._tex(c, { repeat: true });
    roadTex.wrapS = THREE.ClampToEdgeWrapping;
    const roadMat = new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.92, metalness: 0, envMapIntensity: 0.4, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    // ---- ribbon
    const pos = new Float32Array((N + 1) * 2 * 3), uv = new Float32Array((N + 1) * 2 * 2), nrm = new Float32Array((N + 1) * 2 * 3);
    for (let k = 0; k <= N; k++) {
      const i = k % N, rx = TZ[i], rz = -TX[i];
      pos.set([X[i] - rx * W, 0.03, Z[i] - rz * W, X[i] + rx * W, 0.03, Z[i] + rz * W], k * 6);
      uv.set([0, (k * ds) / RL, 1, (k * ds) / RL], k * 4);
      nrm.set([0, 1, 0, 0, 1, 0], k * 6);
    }
    const idx = [];
    for (let k = 0; k < N; k++) {
      const a = k * 2, b = a + 1, cc = a + 2, d = a + 3;
      // pick winding so the face points up
      const ux = pos[b * 3] - pos[a * 3], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
      const vx = pos[cc * 3] - pos[a * 3], vz = pos[cc * 3 + 2] - pos[a * 3 + 2];
      const up = uz * vx - ux * vz; // y of (u x v)
      if (up > 0) idx.push(a, b, cc, b, d, cc); else idx.push(a, cc, b, b, cc, d);
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    rg.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    rg.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    rg.setIndex(idx);
    rg.computeBoundingSphere();
    this._add(new THREE.Mesh(rg, roadMat), false, true);

    // ---- kerbs on curves (red/white), barriers on the outside of tight corners
    const kmask = new Uint8Array(N), bmask = new Int8Array(N);
    for (let i = 0; i < N; i++) {
      const k = Math.abs(T.curv[i]);
      if (k > 1 / 75) for (let o = -10; o <= 10; o++) kmask[(i + o + N) % N] = 1;
      if (k > 1 / 40) for (let o = -16; o <= 16; o++) bmask[(i + o + N) % N] = T.curv[i] > 0 ? -1 : 1;
    }
    const kerb = new Soup();
    const red = new THREE.Color('#c8202a'), white = new THREE.Color('#f2f2ee');
    const P = (i, lat, y) => [X[i] + TZ[i] * lat, y, Z[i] - TX[i] * lat];
    for (let i = 0; i < N; i += 2) {
      const j = (i + 2) % N;
      if (!kmask[i]) continue;
      const colr = (i / 2) % 2 ? red : white;
      for (const s of [-1, 1]) {
        const a0 = s * (hw - 0.2), a1 = s * (hw + 1.0);
        kerb.quad(P(i, a0, 0.04), P(i, a1, 0.085), P(j, a1, 0.085), P(j, a0, 0.04), [0, 1, 0], colr);
        kerb.quad(P(i, a1, 0.085), P(i, a1, 0.0), P(j, a1, 0.0), P(j, a1, 0.085), [TZ[i] * s, 0, -TX[i] * s], colr);
      }
    }
    if (kerb.p.length) this.B.pushRaw('kerb', kerb.p, kerb.n, kerb.c);
    const yel = new THREE.Color('#f2c200'), blk = new THREE.Color('#1e1e1e'), grey = new THREE.Color('#9aa0a6');
    const bar = new Soup();
    for (let i = 0; i < N; i += 2) {
      const s = bmask[i];
      if (!s) continue;
      const j = (i + 2) % N, lat = s * (hw + 2.55);
      const colr = (i / 2) % 2 ? yel : blk;
      const n = [-TZ[i] * s, 0, TX[i] * s];
      bar.quad(P(i, lat, 0.35), P(i, lat, 0.75), P(j, lat, 0.75), P(j, lat, 0.35), n, colr);
      bar.quad(P(i, lat, 0.75), P(i, lat + s * 0.1, 0.75), P(j, lat + s * 0.1, 0.75), P(j, lat, 0.75), [0, 1, 0], colr);
      if ((i / 2) % 2 === 0) {
        const a = P(i, lat + s * 0.05, 0);
        this.box('std', a[0], 0, a[2], 0.12, 0.8, 0.12, '#8a8f96', Math.atan2(TX[i], TZ[i]));
      }
    }
    if (bar.p.length) this.B.pushRaw('std', bar.p, bar.n, bar.c);

    // ---- footpaths (raised, black/yellow kerb face, paver texture)
    const fc = Math.round(256 * tq), fcv = makeCanvas(fc, fc), fg = fcv.getContext('2d');
    fg.fillStyle = '#b9b3a8'; fg.fillRect(0, 0, fc, fc);
    const tiles = 6, ts = fc / tiles;
    for (let r = 0; r < tiles; r++) for (let q = 0; q < tiles; q++) {
      const v = 165 + rnd() * 30;
      fg.fillStyle = (r + q) % 3 === 0 ? `rgb(${v - 10},${v - 60},${v - 70})` : `rgb(${v},${v - 4},${v - 12})`;
      fg.fillRect(q * ts + 1, r * ts + 1, ts - 2, ts - 2);
    }
    grain(fg, fc, fc, 18, rnd);
    const footTex = this._tex(fcv, { repeat: true });
    this.footTex = footTex;
    const foot = new Soup(true);
    const top = new THREE.Color('#ffffff');
    const inL = hw + 2.4, outL = hw + 5.0, fh = 0.16;
    for (let i = 0; i < N; i += 2) {
      const j = (i + 2) % N;
      const v0 = (i * ds) / 2.6, v1 = ((i + 2) * ds) / 2.6;
      for (const s of [-1, 1]) {
        if (this.noFoot[s > 0 ? 1 : 0][i]) continue;
        // skip if this stretch would sit on another part of the loop
        const mid = P(i, s * (inL + outL) / 2, 0);
        const q = this.field.query(mid[0], mid[2]);
        if (q.d < inL - 0.5) continue;
        const a0 = s * inL, a1 = s * outL;
        foot.quad(P(i, a0, fh), P(i, a1, fh), P(j, a1, fh), P(j, a0, fh), [0, 1, 0], top, [0, v0], [1, v0], [1, v1], [0, v1]);
        const kc = (i / 2) % 2 ? yel : blk;
        foot.quad(P(i, a0, 0), P(i, a0, fh), P(j, a0, fh), P(j, a0, 0), [-TZ[i] * s, 0, TX[i] * s], kc, [0, 0], [0, 0.06], [0.4, 0.06], [0.4, 0]);
        foot.quad(P(i, a1, 0), P(i, a1, fh), P(j, a1, fh), P(j, a1, 0), [TZ[i] * s, 0, -TX[i] * s], grey, [0, 0], [0, 0.06], [0.4, 0.06], [0.4, 0]);
      }
    }
    if (foot.p.length) {
      const g2 = new THREE.BufferGeometry();
      g2.setAttribute('position', new THREE.Float32BufferAttribute(foot.p, 3));
      g2.setAttribute('normal', new THREE.Float32BufferAttribute(foot.n, 3));
      g2.setAttribute('color', new THREE.Float32BufferAttribute(foot.c, 3));
      g2.setAttribute('uv', new THREE.Float32BufferAttribute(foot.uv, 2));
      g2.computeBoundingSphere();
      const fm = new THREE.MeshStandardMaterial({ map: footTex, vertexColors: true, roughness: 0.9, envMapIntensity: 0.4 });
      this._add(new THREE.Mesh(g2, fm), false, true);
    }
  }

  // ------------------------------------------------------------ buildings
  _buildings() {
    const T = this.track, hw = T.halfWidth, F = this.field, rnd = this.rnd, QL = this.QL, style = this.style;
    const B = this.I;
    const clear = hw + 5.4;
    const S = {
      suburb: {
        cols: ['#f2d8a7', '#f4b98a', '#e8a37c', '#f5e19a', '#cfe0b4', '#b9d3e8', '#f0c6c0', '#e6d3b3', '#ffffff', '#d9a066', '#f7efe2'],
        front: () => (rnd() < 0.3
          ? { w: 16 + rnd() * 14, d: 10 + rnd() * 3, f: 1 + (rnd() < 0.4 ? 1 : 0), shop: true, set: 9.5, gap: 2 + rnd() * 4 }
          : rnd() < 0.18 ? null
            : { w: 14 + rnd() * 10, d: 12 + rnd() * 6, f: 4 + Math.floor(rnd() * 5), shop: rnd() < 0.25, set: 12 + rnd() * 3, gap: 6 + rnd() * 8 }),
        row2: () => (rnd() < 0.55 ? { w: 10 + rnd() * 8, d: 10 + rnd() * 6, f: 2 + Math.floor(rnd() * 3), shop: false } : { w: 16 + rnd() * 10, d: 14 + rnd() * 6, f: 4 + Math.floor(rnd() * 6), shop: false }),
        row2Lat: 34, scatterN: 150, scatterMin: 60, tanks: 0.7,
      },
      heritage: {
        cols: ['#5fb8b0', '#e88aa0', '#f0c75e', '#d99b4a', '#b8d46a', '#7fb3e0', '#f2eee6', '#d9b38a', '#c9a0dc', '#ff9f6e', '#e9d8a6', '#8fd1c5'],
        front: () => ({ w: 5 + rnd() * 5, d: 9 + rnd() * 4, f: 2 + Math.floor(rnd() * 2.2), shop: rnd() < 0.75, set: 5.6, gap: rnd() < 0.8 ? 0.15 : 1.5 }),
        row2: () => ({ w: 6 + rnd() * 6, d: 9 + rnd() * 5, f: 2 + Math.floor(rnd() * 3), shop: false }),
        row2Lat: 20, scatterN: 650, scatterMin: 30, tanks: 0.55, scatterMax: 200,
      },
      city: {
        cols: ['#d9dde2', '#b7c4d1', '#e8dcc4', '#9fb3c8', '#c9b79c', '#e3e6e8', '#a8c0b8', '#d6c2a8', '#c4a88a', '#8fa3b8'],
        front: () => ({ w: 16 + rnd() * 16, d: 14 + rnd() * 10, f: 5 + Math.floor(rnd() * 9), shop: rnd() < 0.85, set: 8.6, gap: 3 + rnd() * 6 }),
        row2: () => (rnd() < 0.35 ? { w: 14 + rnd() * 10, d: 14 + rnd() * 8, f: 3 + Math.floor(rnd() * 4), shop: false } : { w: 18 + rnd() * 14, d: 16 + rnd() * 10, f: 7 + Math.floor(rnd() * 11), shop: false }),
        row2Lat: 42, scatterN: 150, scatterMin: 70, tanks: 0.25,
      },
    }[style] || null;
    if (!S) return;
    const place = (cx, cz, ry, w, d, h, shop, col) => {
      if (!F.rectFree(cx, cz, w, d, ry, clear)) return false;
      F.mark(cx, cz, w, d, ry, style === 'heritage' ? 0.05 : 0.8);
      const m = L(cx, 0, cz, ry, w, h, d);
      B.bld.add(m, col, [shop ? 1 : 0, 0, Math.floor(rnd() * 7), Math.floor(rnd() * 8)]);
      this._decorate(cx, cz, ry, w, d, h, shop, col);
      return true;
    };
    const frontAt = (s, side, lat, w) => {
      const p = T.pointAt(s);
      const ox = p.tz * side, oz = -p.tx * side;
      return { cx: p.x + ox * lat, cz: p.z + oz * lat, ry: Math.atan2(-ox, -oz) };
    };
    // front row(s) both sides
    for (const side of [-1, 1]) {
      let s = rnd() * 10;
      while (s < T.length) {
        const b = S.front();
        if (!b) { s += 12 + rnd() * 20; continue; } // open plot
        const h = b.f * 3.2 + (style === 'heritage' ? 0.5 : 0.3);
        let ok = false;
        for (const dd of [b.d, b.d * 0.7]) {
          const f = frontAt(s + b.w / 2, side, hw + b.set + dd / 2, b.w);
          if (place(f.cx, f.cz, f.ry, b.w, dd, h, b.shop, pick(rnd, S.cols))) { ok = true; break; }
        }
        s += ok ? b.w + b.gap : 3;
      }
      // second row
      s = rnd() * 10;
      while (s < T.length) {
        const b = S.row2();
        if (rnd() > QL.rows) { s += b.w + 4; continue; }
        const h = b.f * 3.2 + 0.3;
        const f = frontAt(s + b.w / 2, side, hw + S.row2Lat + b.d / 2 + rnd() * 6, b.w);
        const ok = place(f.cx, f.cz, f.ry, b.w, b.d, h, false, pick(rnd, S.cols));
        s += ok ? b.w + 2 + rnd() * 6 : 4;
      }
    }
    // scatter filler (interior of the loop and beyond)
    const tb = F.tb;
    const nScatter = Math.round(S.scatterN * QL.scatter);
    let tries = 0, placed = 0;
    while (placed < nScatter && tries < nScatter * 12) {
      tries++;
      const x = tb.minX - 220 + rnd() * (tb.maxX - tb.minX + 440), z = tb.minZ - 220 + rnd() * (tb.maxZ - tb.minZ + 440);
      const q = F.query(x, z);
      if (q.d < hw + S.scatterMin || q.d > (S.scatterMax || 300)) continue;
      const b = S.row2();
      const ry = Math.atan2(T.tx[q.i], T.tz[q.i]) + (rnd() < 0.5 ? 0 : Math.PI / 2);
      const far = q.d > 140;
      const h = (far ? b.f * 1.2 : b.f) * 3.2 + 0.3;
      if (place(x, z, ry, b.w, b.d, h, false, pick(rnd, S.cols))) placed++;
    }
  }

  _decorate(cx, cz, ry, w, d, h, shop, col) {
    const rnd = this.rnd, style = this.style, I = this.I, QL = this.QL;
    const M = new THREE.Matrix4().compose(_v.set(cx, 0, cz), _q.setFromAxisAngle(_up, ry), _s.set(1, 1, 1));
    const at = (x, y, z, rot = 0) => new THREE.Matrix4().multiplyMatrices(M, L(x, y, z, rot));
    // shop signboards on the ground-floor front
    if (shop) {
      const n = w > 13 ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const bw = (w / n) * 0.86, x = -w / 2 + (w / n) * (k + 0.5);
        const cell = pick(rnd, this.shopCells);
        this.addBoard(at(x, style === 'heritage' ? 3.45 : 3.55, d / 2 + 0.1), bw, style === 'heritage' ? 0.8 : 1.05, 0.16, cell);
      }
      // little awnings in the old city
      if (style === 'heritage' && QL.detail) I.misc.add(new THREE.Matrix4().multiplyMatrices(M, L(0, 2.85, d / 2 + 0.6, 0, w * 0.9, 0.08, 1.2, 0.25)), pick(rnd, ['#c1121f', '#2a9d8f', '#e9c46a', '#3a86ff', '#f4a261']));
    }
    // balconies
    const floors = Math.round((h - 0.3) / 3.2);
    if ((style === 'heritage' && rnd() < 0.7) || (style === 'suburb' && floors >= 4 && rnd() < 0.35 && QL.detail)) {
      for (let f = 1; f < floors; f++) {
        if (style === 'heritage') I.balcony.add(new THREE.Matrix4().multiplyMatrices(M, L(0, f * 3.2 - 0.05, d / 2, 0, w * 0.78, 1, 1)), col);
        else for (const x of [-w * 0.25, w * 0.25]) I.balcony.add(new THREE.Matrix4().multiplyMatrices(M, L(x, f * 3.2 - 0.05, d / 2, 0, 3.2, 1, 1)), '#f5f5f2');
      }
    }
    // jharokhas
    if (style === 'heritage' && rnd() < (QL.detail ? 0.55 : 0.3)) {
      const n = w > 7 ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const x = n === 1 ? 0 : (k ? 1 : -1) * w * 0.25, f = 1 + Math.floor(rnd() * Math.max(1, floors - 1));
        I.jharokha.add(at(x, f * 3.2 + 0.3, d / 2), pick(rnd, ['#d9b38a', '#8b5a2b', '#f2eee6', col]));
      }
    }
    // roof water tanks / service boxes
    const tankP = { suburb: 0.7, heritage: 0.55, city: 0.3 }[style] || 0.5;
    if (rnd() < tankP) {
      const n = 1 + Math.floor(rnd() * 2);
      for (let k = 0; k < n; k++) I.tank.add(at((rnd() - 0.5) * w * 0.6, h, (rnd() - 0.5) * d * 0.6), '#262626');
    }
    if (style === 'city') {
      if (rnd() < 0.5) I.misc.add(new THREE.Matrix4().multiplyMatrices(M, L((rnd() - 0.5) * w * 0.4, h, (rnd() - 0.5) * d * 0.4, 0, 4 + rnd() * 3, 2.4, 3 + rnd() * 3)), '#c9c9c4');
      if (rnd() < 0.3 && h < 40) {
        const bw = Math.min(w * 0.8, 13);
        for (const x of [-bw * 0.3, bw * 0.3]) I.misc.add(new THREE.Matrix4().multiplyMatrices(M, L(x, h, d / 2 - 1.5, 0, 0.3, 1.6, 0.3)), '#555a60');
        this.addBoard(at(0, h + 1.6 + bw * 0.125, d / 2 - 1.5), bw, bw * 0.25, 0.3, pick(rnd, this.adCells));
      }
    }
  }

  // ------------------------------------------------------------ trees
  _trees() {
    const T = this.track, hw = T.halfWidth, F = this.field, rnd = this.rnd, QL = this.QL, style = this.style;
    const gap = { suburb: 11, heritage: 45, city: 13 }[style] || 14;
    const lat0 = hw + 6.6;
    for (const side of [-1, 1]) {
      for (let s = rnd() * gap; s < T.length; s += gap * (0.8 + rnd() * 0.5)) {
        if (rnd() > QL.trees + 0.15) continue;
        const p = T.pointAt(s);
        const lat = lat0 + rnd() * 0.8;
        const x = p.x + p.tz * side * lat, z = p.z - p.tx * side * lat;
        if (!F.rectFree(x, z, 1.5, 1.5, 0, hw + 5.6)) continue;
        this.addTree(x, z, style === 'city' && rnd() < 0.4 ? 'ashoka' : rnd() < 0.12 ? 'banyan' : 'neem', 1);
      }
    }
    const tb = F.tb;
    const n = Math.round(({ suburb: 900, heritage: 220, city: 320 }[style] || 400) * QL.trees);
    let tries = 0, placed = 0;
    while (placed < n && tries < n * 10) {
      tries++;
      const x = tb.minX - 250 + rnd() * (tb.maxX - tb.minX + 500), z = tb.minZ - 250 + rnd() * (tb.maxZ - tb.minZ + 500);
      const d = F.dist(x, z);
      if (d < hw + 7 || d > 330) continue;
      if (!F.rectFree(x, z, 2, 2, 0, 0)) continue;
      // clumps
      const k = 1 + Math.floor(rnd() * 3);
      for (let j = 0; j < k; j++) {
        const xx = x + (rnd() - 0.5) * 9, zz = z + (rnd() - 0.5) * 9;
        if (j && (F.dist(xx, zz) < hw + 7 || !F.rectFree(xx, zz, 1.5, 1.5, 0, 0))) continue;
        const r = rnd();
        this.addTree(xx, zz, r < 0.15 ? 'banyan' : r < 0.3 ? 'ashoka' : r < 0.45 ? 'bush' : 'neem', 1);
        placed++;
      }
    }
  }

  // ------------------------------------------------------------ street lamps (+ fake light pools)
  _lamps() {
    const T = this.track, hw = T.halfWidth, F = this.field, QL = this.QL;
    const lat = hw + 4.6, gap = QL.lampGap;
    let k = 0;
    for (let s = 6; s < T.length - 4; s += gap) {
      const side = k++ % 2 ? 1 : -1;
      const p = T.pointAt(s);
      const ox = p.tz * side, oz = -p.tx * side;
      const x = p.x + ox * lat, z = p.z + oz * lat;
      if (F.occAt(x, z)) continue;
      if (F.dist(x, z) < lat - 0.6) continue;
      const ry = Math.atan2(-ox, -oz);
      const M = L(x, 0, z, ry);
      this.I.lamp.add(M, 0xffffff);
      const hx = x - ox * 2.35, hz = z - oz * 2.35;
      this.I.lampHead.add(L(hx, 8.45, hz, ry, 1, 1, 1), 0xffffff);
      this.I.pool.add(L(hx - ox * 2.6, 0.06, hz - oz * 2.6, ry, 17, 1, 17), 0xffffff);
      this.halos.push(hx, 8.3, hz);
    }
    // festive string lights across old-city streets
    if (this.style === 'heritage' || this.P.lamps >= 1) {
      const step = this.style === 'heritage' ? 70 : 140;
      const cols = ['#ff5252', '#ffd740', '#69f0ae', '#40c4ff', '#ff6ec7', '#ffab40'].map((h) => new THREE.Color(h));
      for (let s = 35; s < T.length; s += step) {
        const p = T.pointAt(s);
        const span = hw + 5.2, n = 34;
        for (let j = 0; j <= n; j++) {
          const t = j / n, lt = -span + 2 * span * t, y = 7.4 - Math.sin(t * Math.PI) * 1.6;
          this.fairy.push(p.x + p.tz * lt, y, p.z - p.tx * lt, cols[j % cols.length]);
        }
      }
    }
  }

  // ------------------------------------------------------------ parked autos, scooters, bollards
  _props() {
    const T = this.track, hw = T.halfWidth, F = this.field, rnd = this.rnd, QL = this.QL;
    const nA = Math.round(({ suburb: 30, heritage: 46, city: 34 }[this.style] || 30) * QL.props);
    const nS = Math.round(({ suburb: 50, heritage: 80, city: 50 }[this.style] || 50) * QL.props);
    const put = (inst, lat, n, cluster, col) => {
      for (let k = 0; k < n; k++) {
        const s0 = rnd() * T.length, side = rnd() < 0.5 ? -1 : 1;
        const m = cluster ? 1 + Math.floor(rnd() * 4) : 1;
        for (let j = 0; j < m; j++) {
          const p = T.pointAt(s0 + j * (cluster ? 1.1 : 3.2));
          const x = p.x + p.tz * side * lat, z = p.z - p.tx * side * lat;
          if (F.occAt(x, z) || F.dist(x, z) < lat - 0.4) continue;
          const h = Math.atan2(p.tx, p.tz);
          const ry = cluster ? h + side * (Math.PI / 2) + (rnd() - 0.5) * 0.3 : h + (rnd() < 0.5 ? 0 : Math.PI);
          inst.add(L(x, 0.16, z, ry), col());
        }
      }
    };
    put(this.I.auto, hw + 3.75, nA, false, () => (rnd() < 0.8 ? '#ffffff' : '#e8ffe8'));
    put(this.I.scooter, hw + 4.25, nS, true, () => pick(rnd, ['#f2f2f0', '#1b1b1f', '#c8102e', '#1f4fa8', '#9aa3ad', '#e5601d', '#2e8b57', '#7b2cbf']));
    // bollards at kerbed stretches near landmarks
    for (const lm of T.landmarks) {
      for (let o = -24; o <= 24; o += 3) {
        const i = (lm.index + o + T.N) % T.N;
        for (const s of [-1, 1]) {
          const lat = hw + 2.55;
          const x = T.x[i] + T.tz[i] * s * lat, z = T.z[i] - T.tx[i] * s * lat;
          if (F.dist(x, z) < lat - 0.3 || F.occAt(x, z)) continue;
          this.I.misc.add(L(x, 0, z, 0, 0.28, 0.9, 0.28), (o / 3) % 2 ? '#f2c200' : '#1e1e1e');
        }
      }
    }
  }

  // ------------------------------------------------------------ ground
  _ground() {
    const T = this.track, F = this.field, tq = this.QL.tex, style = this.style;
    const tb = F.tb;
    const cx = (tb.minX + tb.maxX) / 2, cz = (tb.minZ + tb.maxZ) / 2;
    const size = Math.max(tb.maxX - tb.minX, tb.maxZ - tb.minZ) + 2600;
    const seg = 100;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg).rotateX(-Math.PI / 2).translate(cx, 0, cz);
    const pos = geo.attributes.position, n = pos.count;
    const col = new Float32Array(n * 3);
    const pal = {
      suburb: [['#7b9443', '#93a24c'], ['#b49c62', '#a88e5a'], ['#9c7f58', '#8a7050']],
      heritage: [['#8f9a52', '#a19a5c'], ['#b8a074', '#b09468'], ['#a2876a', '#9a8064']],
      city: [['#7a9248', '#86984f'], ['#a69a78', '#9c9070'], ['#8f8778', '#888070']],
    }[style] || [['#7b9443', '#93a24c'], ['#b49c62', '#a88e5a'], ['#9c7f58', '#8a7050']];
    const C = pal.map((p) => p.map((h) => new THREE.Color(h)));
    const tmp = new THREE.Color(), tmp2 = new THREE.Color();
    const seed = hashStr(T.id) & 0xffff;
    for (let k = 0; k < n; k++) {
      const x = pos.getX(k), z = pos.getZ(k);
      const a = fbm2(x / 140, z / 140, seed), b = fbm2(x / 45, z / 45, seed + 5, 3);
      const d = F.dist(x, z);
      const near = Math.max(0, 1 - Math.max(0, d - T.halfWidth - 6) / 40);
      tmp.copy(C[0][0]).lerp(C[0][1], b);
      tmp2.copy(C[1][0]).lerp(C[1][1], b);
      tmp.lerp(tmp2, THREE.MathUtils.smoothstep(a, 0.42, 0.62));
      tmp2.copy(C[2][0]).lerp(C[2][1], a);
      tmp.lerp(tmp2, near * 0.7);
      col[k * 3] = tmp.r; col[k * 3 + 1] = tmp.g; col[k * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    // detail texture (neutral, multiplied by vertex colours)
    const cs = Math.round(512 * tq), c = makeCanvas(cs, cs), g = c.getContext('2d');
    const rnd = mulberry32(seed + 99);
    g.fillStyle = '#e4e4dc'; g.fillRect(0, 0, cs, cs);
    for (let k = 0; k < 40; k++) {
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      const x = rnd() * cs, y = rnd() * cs, r = cs * (0.05 + rnd() * 0.15);
      g.save(); g.translate(x, y); g.scale(r, r);
      gr.addColorStop(0, rnd() < 0.5 ? 'rgba(255,248,225,0.35)' : 'rgba(150,160,120,0.3)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 1, 0, TAU); g.fill(); g.restore();
    }
    for (let k = 0; k < cs * cs * 0.02; k++) {
      const x = rnd() * cs, y = rnd() * cs, l = 2 + rnd() * 4 * tq;
      const v = 150 + rnd() * 100;
      g.strokeStyle = `rgba(${v * 0.9},${v},${v * 0.75},0.5)`; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 2, y - l); g.stroke();
    }
    for (let k = 0; k < cs * cs * 0.004; k++) { const v = 120 + rnd() * 80; g.fillStyle = `rgb(${v},${v * 0.95},${v * 0.85})`; g.fillRect(rnd() * cs, rnd() * cs, 2, 2); }
    grain(g, cs, cs, 22, rnd);
    const tex = this._tex(c, { repeat: true });
    tex.repeat.set(size / 18, size / 18);
    const mat = new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, roughness: 1, metalness: 0, envMapIntensity: 0.3, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
    const mesh = new THREE.Mesh(geo, mat);
    this._add(mesh, false, true);
  }

  // ------------------------------------------------------------ build meshes from collectors
  _finalize() {
    const P = this.P, QL = this.QL, tq = QL.tex;
    const lampsOn = P.lamps > 0;
    // materials for merged buckets
    const atlasTex = this._tex(this.atlas.canvas);
    this.M = this.M || {};
    const M = {
      std: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, envMapIntensity: 0.45 }),
      gloss: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.15, envMapIntensity: 0.9 }),
      metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.28, metalness: 1.0, envMapIntensity: 1.2, emissive: new THREE.Color('#a87a1a'), emissiveIntensity: P.gold }),
      glow: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
      glass: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.06, metalness: 0.9, envMapIntensity: 1.1, emissive: new THREE.Color('#ffcf8f'), emissiveIntensity: P.glass * 0.6 }),
      water: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.05, metalness: 0.35, envMapIntensity: 1.0, transparent: true, opacity: 0.88 }),
      sign: new THREE.MeshStandardMaterial({ map: atlasTex, emissiveMap: atlasTex, emissive: 0xffffff, emissiveIntensity: P.signs, roughness: 0.6, envMapIntensity: 0.4 }),
      kerb: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, envMapIntensity: 0.4 }),
    };
    this.M = M;
    // the toy train needs M.std
    if (this._pendingTrain) { this._pendingTrain(); this._pendingTrain = null; }
    for (const [k, m] of Object.entries(M)) {
      const g = this.B.merged(k);
      if (!g) { this._track(m); continue; }
      const mesh = new THREE.Mesh(g, m);
      const cast = k !== 'glow' && k !== 'water' && k !== 'sign' && k !== 'kerb';
      this._add(mesh, cast, k !== 'glow');
      if (k === 'water') mesh.renderOrder = 1;
    }

    // ---- instanced meshes
    const mk = (key, geo, mat, cast = true, attr = null) => {
      const inst = this.I[key];
      if (!inst.count) { geo.dispose(); mat.dispose(); return null; }
      const mesh = new THREE.InstancedMesh(geo, mat, inst.count);
      mesh.instanceMatrix.array.set(inst.m);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(inst.c), 3);
      if (attr) geo.setAttribute(attr.name, new THREE.InstancedBufferAttribute(new Float32Array(inst.a), attr.size));
      mesh.computeBoundingSphere();
      this._add(mesh, cast, true);
      return mesh;
    };
    // buildings
    const wr = mulberry32(hashStr(this.track.id + 'win'));
    const wt = windowTextures(this.style, Math.round(64 * tq), wr);
    const alb = this._tex(wt.alb), em = this._tex(wt.em), aux = this._tex(wt.aux, { srgb: false });
    mk('bld', new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), buildingMaterial(alb, em, aux, P.windows), true, { name: 'aInfo', size: 4 });
    mk('board', new THREE.BoxGeometry(1, 1, 1), boardMaterial(this.boardTex, P.signs + (P.lamps ? 0.25 : 0), this.boardRows), false, { name: 'aCell', size: 2 });
    // balcony: slab + railing (local: hangs off the front face, +Z out)
    {
      const b = new Builder();
      b.push('s', new THREE.BoxGeometry(1, 0.16, 1.1).translate(0, 0.08, 0.55), L(0, 0, 0), '#ffffff');
      b.push('s', new THREE.BoxGeometry(1, 0.95, 0.06).translate(0, 0.55, 1.08), L(0, 0, 0), '#cfcfcf');
      b.push('s', new THREE.BoxGeometry(1, 0.06, 0.12).translate(0, 1.05, 1.08), L(0, 0, 0), '#7a5a3a');
      mk('balcony', b.merged('s'), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, envMapIntensity: 0.4 }));
    }
    // jharokha: bracket + box window + domed roof
    {
      const b = new Builder();
      b.push('s', new THREE.ConeGeometry(0.9, 0.7, 4).rotateY(Math.PI / 4).rotateX(Math.PI).translate(0, -0.35, 0.55), L(0, 0, 0, 0, 1.3, 1, 0.9), '#e8dcc4');
      b.push('s', new THREE.BoxGeometry(2.0, 1.7, 1.1).translate(0, 0.85, 0.55), L(0, 0, 0), '#ffffff');
      b.push('s', new THREE.BoxGeometry(1.5, 1.1, 0.05).translate(0, 0.75, 1.11), L(0, 0, 0), '#3a2a20');
      for (const x of [-0.5, 0, 0.5]) b.push('s', new THREE.BoxGeometry(0.08, 1.1, 0.06).translate(x, 0.75, 1.13), L(0, 0, 0), '#f6f0e4');
      b.push('s', new THREE.ConeGeometry(1, 1, 6, 1, true).translate(0, 0.5, 0), L(0, 1.76, 0.6, 0, 1.25, 0.75, 0.8), '#ffffff');
      b.push('s', new THREE.BoxGeometry(2.3, 0.12, 1.4).translate(0, 1.7, 0.6), L(0, 0, 0), '#ffffff');
      mk('jharokha', b.merged('s'), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, envMapIntensity: 0.4 }));
    }
    mk('tank', new THREE.CylinderGeometry(0.62, 0.62, 1.25, 10).translate(0, 0.62, 0), new THREE.MeshStandardMaterial({ roughness: 0.55, envMapIntensity: 0.5 }));
    mk('misc', new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ roughness: 0.8, envMapIntensity: 0.4 }));
    // trees
    mk('trunk', new THREE.CylinderGeometry(0.16, 0.26, 1, 6).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ roughness: 0.95, envMapIntensity: 0.3 }));
    {
      const parts = [];
      const r = mulberry32(7);
      const main = new THREE.IcosahedronGeometry(1, 1);
      parts.push(main);
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * TAU + r(), rr = 0.45 + r() * 0.25;
        parts.push(new THREE.IcosahedronGeometry(rr, 0).translate(Math.cos(a) * 0.75, (r() - 0.3) * 0.5, Math.sin(a) * 0.75));
      }
      parts.push(new THREE.IcosahedronGeometry(0.6, 0).translate(0, 0.65, 0));
      const ng = parts.map((p) => { const q = p.index ? p.toNonIndexed() : p.clone(); p.dispose(); q.deleteAttribute('uv'); return q; });
      const cg = mergeGeometries(ng); ng.forEach((x) => x.dispose());
      const pp = cg.attributes.position, cc = new Float32Array(pp.count * 3);
      for (let k = 0; k < pp.count; k += 3) {
        const y = (pp.getY(k) + pp.getY(k + 1) + pp.getY(k + 2)) / 3;
        const v = 0.78 + r() * 0.22 + y * 0.12;
        for (let j = 0; j < 3; j++) { cc[(k + j) * 3] = v; cc[(k + j) * 3 + 1] = v; cc[(k + j) * 3 + 2] = v * 0.95; }
      }
      cg.setAttribute('color', new THREE.BufferAttribute(cc, 3));
      cg.computeVertexNormals();
      mk('canopy', cg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true, envMapIntensity: 0.35 }));
    }
    {
      const parts = [new THREE.ConeGeometry(0.55, 0.55, 7).translate(0, 0.25, 0), new THREE.ConeGeometry(0.45, 0.5, 7).translate(0, 0.55, 0), new THREE.ConeGeometry(0.3, 0.45, 7).translate(0, 0.8, 0)];
      const ag = mergeGeometries(parts.map((p) => { const q = p.toNonIndexed(); p.dispose(); return q; }));
      ag.computeVertexNormals();
      mk('ashoka', ag, new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true, envMapIntensity: 0.35 }));
    }
    // lamps
    {
      const b = new Builder();
      b.push('s', new THREE.CylinderGeometry(0.08, 0.13, 8.6, 8).translate(0, 4.3, 0), L(0, 0, 0), '#8d939a');
      b.push('s', new THREE.BoxGeometry(0.34, 0.9, 0.34).translate(0, 0.45, 0), L(0, 0, 0), '#f2c200');
      b.push('s', new THREE.BoxGeometry(0.36, 0.25, 0.36).translate(0, 0.3, 0), L(0, 0, 0), '#1e1e1e');
      b.push('s', new THREE.BoxGeometry(0.08, 0.08, 2.5).translate(0, 8.62, 1.2), L(0, 0, 0), '#8d939a');
      b.push('s', new THREE.BoxGeometry(0.06, 0.6, 0.06).translate(0, 8.3, 0.25).rotateX(0.7), L(0, 0, 0), '#8d939a');
      b.push('s', new THREE.BoxGeometry(0.42, 0.14, 0.95).translate(0, 8.55, 2.35), L(0, 0, 0), '#6b7078');
      mk('lamp', b.merged('s'), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.4, envMapIntensity: 0.7 }), QL.detail);
    }
    const headCol = lampsOn ? new THREE.Color('#ffc46a').multiplyScalar(1.6 * P.lamps + 0.4) : new THREE.Color('#d9dde0');
    mk('lampHead', new THREE.BoxGeometry(0.34, 0.06, 0.8), new THREE.MeshBasicMaterial({ color: headCol, toneMapped: false }), false);
    if (lampsOn) {
      const poolTex = this._track(radialTexture(128, [[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,0.55)'], [0.7, 'rgba(255,255,255,0.15)'], [1, 'rgba(255,255,255,0)']]));
      const poolMat = new THREE.MeshBasicMaterial({
        map: poolTex, color: new THREE.Color('#ff9a3c').multiplyScalar(0.7 * P.lamps), transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, fog: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      });
      const pm = mk('pool', new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), poolMat, false);
      if (pm) { pm.renderOrder = 2; pm.receiveShadow = false; }
      // halos
      const haloTex = this._track(radialTexture(64, [[0, 'rgba(255,255,255,1)'], [0.2, 'rgba(255,220,170,0.6)'], [1, 'rgba(255,180,90,0)']]));
      if (this.halos.length) {
        const hg = new THREE.BufferGeometry();
        hg.setAttribute('position', new THREE.Float32BufferAttribute(this.halos, 3));
        const hm = new THREE.PointsMaterial({ map: haloTex, color: new THREE.Color('#ffb661').multiplyScalar(P.lamps), size: 6.5, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: true });
        const pts = new THREE.Points(hg, hm); pts.renderOrder = 3;
        this._add(pts, false, false);
      }
      if (this.fairy.length) {
        const pos = [], col = [];
        for (let k = 0; k < this.fairy.length; k += 4) { pos.push(this.fairy[k], this.fairy[k + 1], this.fairy[k + 2]); const c = this.fairy[k + 3]; col.push(c.r, c.g, c.b); }
        const fg = new THREE.BufferGeometry();
        fg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        fg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        const fm = new THREE.PointsMaterial({ map: haloTex, vertexColors: true, size: 0.9, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
        const pts = new THREE.Points(fg, fm); pts.renderOrder = 3;
        this._add(pts, false, false);
      }
    } else { this.I.pool = new Inst(); }
    // parked autos and scooters
    {
      const b = new Builder();
      const G = this.G;
      const p = (geo, m, c) => b.push('s', geo, m, c);
      p(G.box, L(0, 0.22, -0.1, 0, 1.25, 0.5, 2.3), '#1f8a3c');
      p(G.box, L(0, 0.55, 0.85, 0, 1.0, 0.75, 0.5), '#1f8a3c');
      p(G.box, L(0, 0.72, -0.55, 0, 1.28, 0.75, 1.2), '#f5c400');
      p(G.box, L(0, 0.72, -0.2, 0, 1.15, 0.45, 0.6), '#1b1b1b');
      p(G.box, L(0, 1.65, -0.15, 0, 1.32, 0.09, 2.0), '#f5c400');
      p(G.box, L(0, 1.0, 0.55, 0, 1.2, 0.68, 0.06), '#9fb4c4');
      for (const x of [-0.6, 0.6]) p(G.box, L(x, 0.7, 0.75, 0, 0.06, 1.0, 0.06), '#1b1b1b');
      p(G.boxC, L(0, 0.24, 1.0, 0, 0.14, 0.44, 0.44), '#151515');
      for (const x of [-0.62, 0.62]) p(G.boxC, L(x, 0.24, -0.75, 0, 0.14, 0.44, 0.44), '#151515');
      p(G.box, L(0, 0.82, 1.12, 0, 0.18, 0.12, 0.05), '#fff3c0');
      mk('auto', b.merged('s'), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.1, envMapIntensity: 0.8 }));
    }
    {
      const b = new Builder();
      const G = this.G;
      const p = (geo, m, c) => b.push('s', geo, m, c);
      p(G.box, L(0, 0.22, -0.1, 0, 0.42, 0.45, 1.25), '#ffffff');
      p(G.box, L(0, 0.67, -0.25, 0, 0.36, 0.12, 0.72), '#141414');
      p(G.box, L(0, 0.2, 0.55, 0, 0.46, 0.75, 0.14), '#ffffff');
      p(G.box, L(0, 0.95, 0.62, 0, 0.66, 0.05, 0.05), '#1b1b1b');
      p(G.box, L(0, 0.85, 0.66, 0, 0.18, 0.16, 0.12), '#ffffff');
      for (const z of [-0.62, 0.66]) p(G.boxC, L(0, 0.24, z, 0, 0.1, 0.46, 0.46), '#151515');
      mk('scooter', b.merged('s'), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.1, envMapIntensity: 0.8 }));
    }
    // release template geometries
    for (const g of Object.values(this.G)) g.dispose();
    this.G = null;
    this.B = null; this.I = null; this.atlas = null;
  }
}
