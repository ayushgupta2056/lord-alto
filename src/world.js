// The visual world: sky, lights, road, Vadodara streets and landmarks.
// Streets come from buildings.js (one facade atlas, chunk-merged quad soups), landmarks from landmarks.js.
// Everything static is merged per material, chunked or instanced, so the scene stays well under ~70 draw calls.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BRAND } from './config.js';
import {
  TAU, FONT, FONT2, hashStr, mulberry32, fbm2, pick, makeCanvas, canvasTex, grain, fitText, roundRect, radialTexture,
  L, Builder, Soup, Inst, Atlas, Streetscape, FSoup, facadeMaterial, PALETTES,
} from './buildings.js';
import { LandmarkMixin, landmarkContext } from './landmarks.js';
import { PHOTO_LANDMARKS, buildPhotoLandmark } from './photoLandmarks.js';

// ---------------------------------------------------------------- presets
const TOD = {
  day: {
    top: '#3d7fdc', horizon: '#cfe2f0', glow: '#fff1cf', glowAmt: 0.35, sunCol: '#fffbea', sunSize: 0.03,
    elev: 52, azim: 150, clouds: 0.55, cover: 0, cloudLit: '#ffffff', cloudDark: '#b7c5d6', stars: 0, moon: 0,
    light: '#fff1d8', lightI: 3.1, hemiSky: '#c4dcff', hemiGround: '#7a6648', hemiI: 0.62, env: 0.7,
    fog: [120, 660], lamps: 0, windows: 0, signs: 0, glass: 0, gold: 0.0,
  },
  sunset: {
    top: '#34407e', horizon: '#f0a27c', glow: '#ff7a36', glowAmt: 1.25, sunCol: '#ffd9a8', sunSize: 0.05,
    elev: 5, azim: -105, clouds: 0.6, cover: 0, cloudLit: '#ffb98e', cloudDark: '#7d5d80', stars: 0, moon: 0,
    light: '#ffad6b', lightI: 2.8, hemiSky: '#ffb9a0', hemiGround: '#5d4040', hemiI: 0.6, env: 0.55,
    fog: [90, 580], lamps: 0.6, windows: 0.45, signs: 0.3, glass: 0.25, gold: 0.1,
  },
  night: {
    top: '#02061a', horizon: '#18233f', glow: '#7f8fc4', glowAmt: 0.18, sunCol: '#e8eeff', sunSize: 0.0,
    elev: 38, azim: 55, clouds: 0.22, cover: 0, cloudLit: '#3b4870', cloudDark: '#141b30', stars: 1, moon: 1,
    light: '#9db4ff', lightI: 0.4, hemiSky: '#34497e', hemiGround: '#1b1622', hemiI: 0.6, env: 0.3,
    fog: [60, 470], lamps: 1, windows: 1.0, signs: 0.85, glass: 0.8, gold: 0.35,
  },
};
// monsoon overrides: overcast grey sky, no sun disc, dim soft light, closer fog, lights on earlier
const RAIN = {
  day: {
    top: '#69737d', horizon: '#a9b1b6', glow: '#d2d6da', glowAmt: 0.12, sunSize: 0, clouds: 1, cover: 1, cloudLit: '#b3bbc2', cloudDark: '#6c757e',
    light: '#e6ecf2', lightI: 0.85, hemiSky: '#b9c3cc', hemiGround: '#55524c', hemiI: 1.0, env: 0.8, fog: [60, 470], lamps: 0.35, windows: 0.35, signs: 0.3, glass: 0.15,
  },
  sunset: {
    top: '#3c4256', horizon: '#8d8389', glow: '#c08a70', glowAmt: 0.35, sunSize: 0, clouds: 1, cover: 1, cloudLit: '#9d8f93', cloudDark: '#4a4652',
    light: '#e0b9a0', lightI: 0.7, hemiSky: '#918d9b', hemiGround: '#3d3a3e', hemiI: 0.9, env: 0.6, fog: [50, 430], lamps: 0.95, windows: 0.65, signs: 0.55, glass: 0.4,
  },
  night: {
    top: '#07090f', horizon: '#1e2430', glow: '#3a4252', glowAmt: 0.1, clouds: 1, cover: 1, cloudLit: '#2c323e', cloudDark: '#0f1219', stars: 0, moon: 0,
    lightI: 0.18, hemiI: 0.55, env: 0.35, fog: [40, 380], lamps: 1, windows: 1.0, signs: 0.9, glass: 0.8,
  },
};
const QUALITY = {
  low: { tex: 0.5, shadows: false, shadowSize: 512, ext: 40, rows: 0.5, scatter: 0.3, trees: 0.4, props: 0.45, detail: false, sky: 512 },
  medium: { tex: 1, shadows: true, shadowSize: 1024, ext: 55, rows: 0.8, scatter: 0.7, trees: 0.7, props: 0.75, detail: true, sky: 512 },
  high: { tex: 1, shadows: true, shadowSize: 2048, ext: 58, rows: 1, scatter: 1, trees: 1, props: 1, detail: true, sky: 1024 },
};

// ---------------------------------------------------------------- sky shader (rendered once into a cube map)
const SKY_VS = /* glsl */`
varying vec3 vDir;
void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SKY_FS = /* glsl */`
uniform vec3 uTop, uHorizon, uGlow, uSunCol, uSunDir, uCloudLit, uCloudDark;
uniform float uGlowAmt, uSunSize, uClouds, uStars, uMoon, uCover;
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
  if (uClouds > 0.0 && h > -0.05) {
    vec2 p = d.xz / (max(h, 0.0) + 0.12);
    float c = fbm(vec3(p * 1.1, 3.7)) * 0.75 + fbm(vec3(p * 3.3, 9.1)) * 0.25;
    float lo = 0.5 - uCover * 0.42, hi = 0.78 - uCover * 0.24;
    float cm = smoothstep(lo, hi, c) * mix(smoothstep(0.03, 0.3, h), 1.0, uCover) * uClouds;
    vec3 cc = mix(uCloudDark, uCloudLit, mix(0.45 + 0.55 * pow(sd, 2.0), c, uCover));
    col = mix(col, cc, cm);
  }
  if (uSunSize > 0.0) {
    float disc = smoothstep(cos(uSunSize), cos(uSunSize * 0.8), sd);
    col = mix(col, uSunCol * 1.6, disc * above);
  }
  if (uStars > 0.0) {
    vec3 q = d * 230.0; vec3 id = floor(q);
    float r = hash(id * 1.37 + 3.1);
    if (r > 0.991) {
      vec3 cpos = id + 0.5 + (vec3(hash(id + 1.3), hash(id + 2.7), hash(id + 5.1)) - 0.5) * 0.5;
      float b = smoothstep(0.5, 0.05, length(q - cpos)) * (0.35 + 6.0 * (r - 0.991) / 0.009 * 0.25);
      vec3 sc = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.9, 0.75), hash(id + 9.0));
      col += sc * b * uStars * smoothstep(0.03, 0.3, h);
    }
    float band = exp(-pow(dot(d, normalize(vec3(0.4, 0.5, -0.75))) * 4.0, 2.0));
    col += vec3(0.05, 0.06, 0.1) * band * fbm(d * 9.0) * uStars * above;
  }
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
    this.oc = 2;
    this.onx = Math.ceil((this.nx * cell) / 2); this.onz = Math.ceil((this.nz * cell) / 2);
    this.occ = new Uint8Array(this.onx * this.onz);
  }
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

// billboards / hoardings (instanced, own small atlas)
const ADS = [
  ['LORD ALTO', 'NITRO EDITION • DRIVE LIKE A KING', '#1d1747', '#ffc533', '#ff9933'], ['GARBA NIGHTS', 'NAVRATRI • 9 NIGHTS OF DANDIYA', '#d00070', '#ffe066', '#ff9933'],
  ['BARODA BHAKARWADI', 'CRUNCH OF THE CITY', '#ff9933', '#3d0c02', '#ffffff'], ['HELMET PEHNO!', 'DRIVE SAFE, BARODA', '#0a9396', '#ffffff', '#ee9b00'],
  ['SEV USAL SPECIAL', 'SPICY • HOT • ₹40 ONLY', '#9d0208', '#ffd60a', '#ffffff'], ['UTTARAYAN KITE SALE', 'UP TO 50% OFF ON PATANG', '#4361ee', '#ffffff', '#ffd60a'],
  ['NEW FLATS IN BHAYLI', '2 & 3 BHK • BOOK NOW', '#2d6a4f', '#ffffff', '#b7e4c7'], ['MASALA CHAI', 'ONE CUP, FULL ENERGY', '#6f1d1b', '#ffe6a7', '#bb9457'],
  ['GUJARAT TOURISM', 'KHUSHBOO GUJARAT KI', '#e85d04', '#ffffff', '#ffd60a'], ['SAYAJI NAGARI', 'VADODARA • SANSKARI NAGARI', '#3a0ca3', '#ffd60a', '#ff9933'],
  ['GIDC PLOTS AVAILABLE', 'MAKARPURA • POR • SAVLI', '#023047', '#ffb703', '#219ebc'], ['JOIN INDIAN ARMY', 'BE THE PRIDE OF THE NATION', '#283618', '#ffffff', '#606c38'],
  ['FAFDA JALEBI', 'SUNDAY MORNING SPECIAL', '#ffb703', '#9d0208', '#fb8500'], ['MONSOON SALE', 'RAINCOATS • UMBRELLAS • 40% OFF', '#1d3557', '#a8dadc', '#457b9d'],
  ['VADODARA MARATHON', 'RUN FOR A UNITED INDIA', '#e63946', '#ffffff', '#1d3557'], ['DIWALI DHAMAKA', 'FIRECRACKERS • SWEETS • GIFTS', '#7b2cbf', '#ffd60a', '#ff006e'],
];

// ---------------------------------------------------------------- spatial chunks
// Static props/trees are not global InstancedMeshes (one huge bounding sphere = never culled, always in the
// shadow pass). They are collected per 150 m cell and baked into one mesh per cell per material, grouped with
// that cell's facade mesh, so frustum culling, distance culling and the shadow camera all work per cell.
const CELL = 150;
const _cc = new THREE.Color();
class Chunks {
  constructor() { this.map = new Map(); }
  key(x, z) { return Math.floor(x / CELL) + ',' + Math.floor(z / CELL); }
  add(kind, m, color) {
    const e = m.elements, k = this.key(e[12], e[14]);
    let c = this.map.get(k);
    if (!c) { c = {}; this.map.set(k, c); }
    const list = c[kind] || (c[kind] = []);
    for (let i = 0; i < 16; i++) list.push(e[i]);
    _cc.set(color === undefined ? 0xffffff : color);
    list.push(_cc.r, _cc.g, _cc.b);
  }
}
class ChunkInst {
  constructor(ch, kind) { this.ch = ch; this.kind = kind; this.n = 0; }
  add(m, c) { this.ch.add(this.kind, m, c); this.n++; }
  get count() { return this.n; }
}
function tmplOf(geo) {
  const pos = geo.attributes.position.array, vc = geo.attributes.position.count;
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const col = geo.attributes.color ? geo.attributes.color.array : new Float32Array(vc * 3).fill(1);
  let idx = geo.index ? geo.index.array : null;
  if (!idx) { idx = new Uint32Array(vc); for (let i = 0; i < vc; i++) idx[i] = i; }
  return { pos, nrm: geo.attributes.normal.array, col, idx, vc, ic: idx.length };
}
function bakeInstances(parts) {
  let V = 0, I = 0;
  for (const { t, list } of parts) { const n = list.length / 19; V += n * t.vc; I += n * t.ic; }
  if (!V) return null;
  const pos = new Float32Array(V * 3), nrm = new Float32Array(V * 3), col = new Float32Array(V * 3);
  const idx = V > 65535 ? new Uint32Array(I) : new Uint16Array(I);
  let vo = 0, io = 0;
  for (const { t, list } of parts) {
    const P = t.pos, N = t.nrm, C = t.col, X = t.idx, vc = t.vc;
    for (let o = 0; o < list.length; o += 19) {
      const e0 = list[o], e1 = list[o + 1], e2 = list[o + 2], e4 = list[o + 4], e5 = list[o + 5], e6 = list[o + 6];
      const e8 = list[o + 8], e9 = list[o + 9], e10 = list[o + 10], e12 = list[o + 12], e13 = list[o + 13], e14 = list[o + 14];
      const r = list[o + 16], g = list[o + 17], b = list[o + 18];
      for (let v = 0; v < vc; v++) {
        const s = v * 3, k = (vo + v) * 3;
        const x = P[s], y = P[s + 1], z = P[s + 2];
        pos[k] = e0 * x + e4 * y + e8 * z + e12; pos[k + 1] = e1 * x + e5 * y + e9 * z + e13; pos[k + 2] = e2 * x + e6 * y + e10 * z + e14;
        const nx = N[s], ny = N[s + 1], nz = N[s + 2];
        const a = e0 * nx + e4 * ny + e8 * nz, bb = e1 * nx + e5 * ny + e9 * nz, c = e2 * nx + e6 * ny + e10 * nz;
        const l = Math.hypot(a, bb, c) || 1;
        nrm[k] = a / l; nrm[k + 1] = bb / l; nrm[k + 2] = c / l;
        col[k] = C[s] * r; col[k + 1] = C[s + 1] * g; col[k + 2] = C[s + 2] * b;
      }
      for (let i = 0; i < X.length; i++) idx[io + i] = X[i] + vo;
      vo += vc; io += X.length;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}
const VEG = new Set(['trunk', 'band', 'canopy', 'canopyLo', 'ashoka', 'palmTop']);
const CHUNKED = ['jharokha', 'tank', 'misc', 'trunk', 'band', 'canopy', 'canopyLo', 'ashoka', 'palmTop', 'pole', 'auto', 'scooter'];
const VIEW_R = { day: 380, sunset: 350, night: 300 };

const STYLE_GAP = { suburb: 11, heritage: 45, city: 13, cantonment: 8, outskirts: 20, industrial: 26 };
const STYLE_TREES = { suburb: 900, heritage: 220, city: 320, cantonment: 1300, outskirts: 700, industrial: 320 };

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
    this._skyEnv = null;
    this.stats = {};
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug')) { window.__laWorld = this; window.__THREE = THREE; }
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
    if (this._skyEnv) { this._skyEnv.dispose(); this._skyEnv = null; }
    this.scene.environment = this.envTex;
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

  load(track, { timeOfDay, quality, weather } = {}) {
    const t0 = performance.now();
    this._clear();
    const tod = TOD[timeOfDay] ? timeOfDay : (TOD[track.def.timeOfDay] ? track.def.timeOfDay : 'day');
    const q = QUALITY[quality] ? quality : 'medium';
    this.rain = weather === 'rain';
    this.track = track; this.tod = tod; this.q = q;
    this.P = this.rain ? { ...TOD[tod], ...RAIN[tod] } : TOD[tod];
    this.QL = QUALITY[q];
    this.style = track.def.style || 'suburb';
    this.rnd = mulberry32(hashStr(track.id + ':' + tod));
    this.aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy?.() || 1);
    this.root = new THREE.Group();
    this.root.name = 'world';
    this.scene.add(this.root);

    const tq = performance.now();
    this._sky();
    this._lights();
    const tf = performance.now();
    this.field = new Field(track, 360, 4);
    const ta = performance.now();
    this.B = new Builder();
    this.atlas = new Atlas(this.QL.tex < 1 ? 1024 : 2048);
    this.SS = new Streetscape(this);
    this._pre = { clear: Math.round(tq - t0), sky: Math.round(tf - tq), field: Math.round(ta - tf), atlas: Math.round(performance.now() - ta) };
    this.chunks = new Chunks();
    this.I = {};
    for (const k of ['board', 'lampHead', 'pool', 'streak']) this.I[k] = new Inst();
    for (const k of CHUNKED) this.I[k] = new ChunkInst(this.chunks, k);
    this.halos = []; this.fairy = []; this.wires = [];
    this.noFoot = [new Uint8Array(track.N), new Uint8Array(track.N)];
    this.chunkGroups = [];
    this.viewR = VIEW_R[tod] || 360;

    const tm = { ...this._pre }; this.stats = { tm };
    const step = (name, fn) => { const t = performance.now(); fn(); tm[name] = Math.round(performance.now() - t); };
    step('_templates', () => this._templates());
    step('_materials', () => { this.M = this._materials(); });
    step('_initBoards', () => this._initBoards());
    step('_landmarks', () => this._landmarks());
    step('_startGantry', () => this._startGantry());
    step('_labelBoards', () => this._labelBoards());
    step('_road', () => this._road());
    step('_buildings', () => this._buildings());
    step('_poles', () => this._poles());
    if (track.id === 'brightday') step('_htLine', () => this._htLine());
    step('_streetLife', () => this._streetLife());
    step('_trees', () => this._trees());
    step('_props', () => this._props());
    step('_ground', () => this._ground());
    step('_finalize', () => this._finalize());
    this.scene.environmentIntensity = this.P.env;
    this.stats.loadMs = Math.round(performance.now() - t0);
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
    if (focus && this.chunkGroups) {
      const R = this.viewR + CELL * 0.75;
      for (const c of this.chunkGroups) c.g.visible = (c.x - focus.x) ** 2 + (c.z - focus.z) ** 2 < R * R;
    }
    for (const a of this._anims) a(dt || 0, this._time);
  }

  // debug: render a chase-style view at track distance s (no post) and return renderer.info for that frame
  debugView(s, { back = 7, up = 2.6, look = 8, lat = 0, aspect = 4 / 3 } = {}) {
    const T = this.track, r = this.renderer, p = T.pointAt(s);
    const rx = p.tz, rz = -p.tx;
    const cam = new THREE.PerspectiveCamera(62, aspect, 0.1, 2500);
    cam.position.set(p.x - p.tx * back + rx * lat, up, p.z - p.tz * back + rz * lat);
    cam.lookAt(p.x + p.tx * look + rx * lat, 1.0, p.z + p.tz * look + rz * lat);
    cam.updateMatrixWorld();
    this.update(0, new THREE.Vector3(p.x, 0, p.z));
    r.info.autoReset = false; r.info.reset();
    r.render(this.scene, cam);
    const info = { ...r.info.render };
    r.info.autoReset = true;
    return info;
  }

  // ------------------------------------------------------------ materials for merged buckets (created before landmarks)
  _materials() {
    const P = this.P;
    const atlasTex = this._tex(this.atlas.canvas);
    this._atlasTex = atlasTex;
    const M = {
      std: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: this.rain ? 0.7 : 0.85, metalness: 0, envMapIntensity: 0.45 }),
      gloss: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.15, envMapIntensity: 0.9 }),
      metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.28, metalness: 1.0, envMapIntensity: 1.2, emissive: new THREE.Color('#a87a1a'), emissiveIntensity: P.gold }),
      alu: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.85, envMapIntensity: 1.3, flatShading: true, emissive: new THREE.Color('#9fb2c8'), emissiveIntensity: P.gold * 0.5 }),
      glow: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
      glass: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.06, metalness: 0.9, envMapIntensity: 1.1, emissive: new THREE.Color('#ffcf8f'), emissiveIntensity: P.glass * 0.6 }),
      water: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.05, metalness: 0.35, envMapIntensity: 1.0, transparent: true, opacity: 0.88 }),
      sign: new THREE.MeshStandardMaterial({ map: atlasTex, emissiveMap: atlasTex, emissive: 0xffffff, emissiveIntensity: P.signs, roughness: 0.6, envMapIntensity: 0.4 }),
      deco: new THREE.MeshStandardMaterial({ map: atlasTex, emissiveMap: atlasTex, emissive: 0xffffff, emissiveIntensity: P.windows * 0.35, roughness: 0.85, envMapIntensity: 0.4 }),
      kerb: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, envMapIntensity: 0.4 }),
      veg: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true, envMapIntensity: 0.35 }),
      prop: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.1, envMapIntensity: 0.7 }),
    };
    M.kerb.userData.wettable = true;
    for (const m of Object.values(M)) this._track(m);
    return M;
  }
  // turn whatever is in the merge buckets into meshes (called per landmark so each gets its own bounds)
  _flushB() {
    for (const [k, m] of Object.entries(this.M)) {
      if (k === 'veg' || k === 'prop') continue;
      const g = this.B.merged(k);
      if (!g) continue;
      const mesh = new THREE.Mesh(g, m);
      const cast = k !== 'glow' && k !== 'water' && k !== 'sign' && k !== 'kerb' && k !== 'deco';
      mesh.castShadow = cast && this.QL.shadows; mesh.receiveShadow = k !== 'glow';
      this._track(g);
      this.root.add(mesh);
      if (k === 'water') mesh.renderOrder = 1;
    }
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
        uCover: { value: P.cover || 0 },
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
    // in the rain, reflections come from the overcast sky (wet road, glass) instead of the studio environment
    if (this.rain && this.tod !== 'night') {
      const pm = new THREE.PMREMGenerator(this.renderer);
      this._skyEnv = pm.fromCubemap(rt.texture).texture;
      pm.dispose();
      this.scene.environment = this._skyEnv;
    }
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
    sh.radius = this.rain ? 8 : 3;
    sh.intensity = this.rain ? 0.55 : 1;
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
  frameSide(i, side, lat, along = 0, scale = 1) {
    const T = this.track;
    const p = T.pointAt(i * T.ds + along);
    const ox = p.tz * side, oz = -p.tx * side;
    const ry = Math.atan2(-ox, -oz);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(p.x + ox * lat, 0, p.z + oz * lat), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(scale, scale, scale));
    return { m, ry, cx: p.x + ox * lat, cz: p.z + oz * lat, p };
  }
  frameRoad(i) {
    const T = this.track;
    const h = Math.atan2(T.tx[i], T.tz[i]);
    return new THREE.Matrix4().compose(new THREE.Vector3(T.x[i], 0, T.z[i]), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), h), new THREE.Vector3(1, 1, 1));
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
    const dir = new THREE.Vector3(dx / len, dy / len, dz / len);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(ax, ay, az), q, new THREE.Vector3(r, len, r));
    if (!this.G.cyl8_1) this.G.cyl8_1 = new THREE.CylinderGeometry(1, 1, 1, 8).translate(0, 0.5, 0);
    this.B.push(b, this.G.cyl8_1, m, color);
  }
  sign(x, y, z, w, h, rect, ry = 0, bucket = 'sign') {
    const g = this.G.plane;
    const uv = g.attributes.uv;
    const gg = g.clone();
    const u = gg.attributes.uv;
    for (let k = 0; k < u.count; k++) u.setXY(k, rect.u0 + uv.getX(k) * (rect.u1 - rect.u0), rect.v0 + uv.getY(k) * (rect.v1 - rect.v0));
    this.B.push(bucket, gg, L(x, y, z, ry, w, h, 1), 0xffffff, true);
    gg.dispose();
  }
  treeLocal(x, z, type = 'neem', size = 1) {
    const v = new THREE.Vector3(x, 0, z).applyMatrix4(this.B.frame);
    this.addTree(v.x, v.z, type, size);
  }
  addTree(x, z, type = 'neem', size = 1, far = false) {
    const rnd = this.rnd;
    const s = size * (0.8 + rnd() * 0.45);
    const ry = rnd() * TAU;
    const bandP = this.style === 'cantonment' ? 1 : this.style === 'suburb' || this.style === 'city' ? 0.45 : 0.2;
    if (type === 'ashoka') {
      this.I.trunk.add(L(x, 0, z, ry, 0.7 * s, 1.6 * s, 0.7 * s), '#5b4430');
      this.I.ashoka.add(L(x, 1.2 * s, z, ry, 1.5 * s, 6.5 * s, 1.5 * s), pick(rnd, ['#2f5d2a', '#386b2f', '#2a5226']));
    } else if (type === 'bush') {
      this.I.canopy.add(L(x, 0.5 * s, z, ry, 1.1 * s, 0.75 * s, 1.1 * s), pick(rnd, ['#4f7a2c', '#5c8a32', '#3f6a28']));
    } else if (type === 'palm') {
      const h = 8 * size * (0.85 + rnd() * 0.3);
      this.I.trunk.add(L(x, 0, z, ry, 0.9, h, 0.9, 0, (rnd() - 0.5) * 0.06), '#8a7356');
      this.I.palmTop.add(L(x, h, z, ry, size, size, size), pick(rnd, ['#4e7d2e', '#5a8a35', '#43702a']));
    } else {
      const banyan = type === 'banyan';
      const th = (banyan ? 3.6 : 3.2) * s;
      const tw = (banyan ? 1.8 : 1.15) * s;
      this.I.trunk.add(L(x, 0, z, ry, tw, th, tw), pick(rnd, ['#5d4632', '#6b5038', '#4f3b2a']));
      if (!far && rnd() < bandP) this.I.band.add(L(x, 0, z, ry, tw * 1.08, 1, tw * 1.08), 0xffffff);
      const cr = (banyan ? 4.6 : 3.3) * s;
      (far ? this.I.canopyLo : this.I.canopy).add(L(x, th + cr * 0.45, z, ry, cr, cr * (banyan ? 0.62 : 0.78), cr), pick(rnd, ['#4c7a2a', '#5a8a2e', '#3f6e27', '#628f35', '#47722a']));
    }
    this.field.mark(x, z, 1.2, 1.2, 0, 0);
  }

  _templates() {
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

  // ------------------------------------------------------------ hoarding atlas (instanced boards)
  _initBoards() {
    const tq = this.QL.tex;
    const cw = 512 * tq, ch = 160 * tq, rows = Math.ceil(ADS.length / 2);
    const c = makeCanvas(cw * 2, ch * rows), g = c.getContext('2d');
    this.boardRows = rows;
    this.adCells = [];
    const cellUV = (k) => [(k % 2) * 0.5, 1 - (Math.floor(k / 2) + 1) / rows];
    ADS.forEach(([name, sub, bg, fg, ac], k) => {
      const x = (k % 2) * cw, y = Math.floor(k / 2) * ch;
      const gr = g.createLinearGradient(x, y, x + cw, y + ch);
      gr.addColorStop(0, bg); gr.addColorStop(1, ac);
      g.fillStyle = gr; g.fillRect(x, y, cw, ch);
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.beginPath(); g.arc(x + cw * 0.86, y + ch * 0.5, ch * 0.6, 0, TAU); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillRect(x, y, cw, 4 * tq); g.fillRect(x, y + ch - 4 * tq, cw, 4 * tq);
      fitText(g, name, x + cw * 0.46, y + ch * 0.42, cw * 0.84, 62 * tq, { color: fg, stroke: 'rgba(0,0,0,0.35)', strokeW: 4 * tq });
      fitText(g, sub, x + cw * 0.46, y + ch * 0.78, cw * 0.8, 24 * tq, { color: '#ffffff', weight: '800', family: FONT2 });
      this.adCells.push(cellUV(k));
    });
    this.boardTex = this._tex(c);
  }
  addBoard(matrix, w, h, d, cell) {
    const m = new THREE.Matrix4().copy(matrix).multiply(new THREE.Matrix4().makeScale(w, h, d));
    this.I.board.add(m, 0xffffff, cell);
  }

  // ------------------------------------------------------------ landmarks
  _landmarks() {
    const T = this.track;
    for (const lm of T.landmarks) {
      // Petals is the finish line of School Se Ghar Tak: keep it right beside the start/finish gantry
      if (T.id === 'brightday' && lm.id === 'petals') { lm.index = (T.N - 30 + T.N) % T.N; lm.side = 1; }
      const fn = this['_lm_' + lm.id];
      let done = false;
      if (T.id === 'brightday' && PHOTO_LANDMARKS.has(lm.id)) {
        try {
          const obj = buildPhotoLandmark(lm.id, landmarkContext(this, lm));
          if (obj && obj.isObject3D && !obj.parent) this.root.add(obj);
          done = true;
        } catch (e) { this.B.lists = {}; if (!fn) console.warn('photo landmark', lm.id, e); }
        this.B.frame.identity();
      }
      if (!done && fn) {
        try { fn.call(this, lm); } catch (e) { console.warn('landmark', lm.id, e); }
      }
      this._flushB();
      this.B.frame.identity();
    }
  }

  // ------------------------------------------------------------ start / finish
  _startGantry() {
    const T = this.track, hw = T.halfWidth, A = this.atlas;
    this.B.frame.copy(this.frameRoad(0));
    const ind = '#1d1747', saff = '#ff9933';
    const px = hw + 5.7;
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
      const petals = this.track.id === 'brightday';
      const t1 = petals ? 'PETALS' : BRAND.title, t2 = petals ? ' • FINISH' : ' • ' + BRAND.subtitle;
      let size = h * 0.58;
      g.font = `900 ${size}px ${FONT}`;
      const tw = g.measureText(t1 + t2).width, maxW = w - sq * 9;
      if (tw > maxW) { size *= maxW / tw; g.font = `900 ${size}px ${FONT}`; }
      const w1 = g.measureText(t1).width, w2 = g.measureText(t2).width;
      const x = w / 2 - (w1 + w2) / 2;
      g.textBaseline = 'middle'; g.textAlign = 'left';
      g.fillStyle = '#ffc533'; g.fillText(t1, x, h * 0.53);
      g.fillStyle = '#ffffff'; g.fillText(t2, x + w1, h * 0.53);
    });
    const sw = 2 * px - 0.2;
    this.sign(0, 8.0, -0.52, sw, sw * (140 / 1600), gr, Math.PI);
    this.sign(0, 8.0, 0.52, sw, sw * (140 / 1600), gr);
    for (let k = -2; k <= 2; k++) this.cyl('glow', k * 1.1, 6.15, -0.62, 0.32, 0.25, '#ff3030', 10);
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
    this.B.frame.identity();
    for (let s = 0; s < 8; s++) {
      const gp = T.grid(s);
      const ry = gp.h;
      const fx = Math.sin(ry), fz = Math.cos(ry);
      this.box('std', gp.x + fx * 2.2, 0.03, gp.z + fz * 2.2, 2.6, 0.03, 0.22, '#f4f4f4', ry);
      const rx = Math.cos(ry), rz = -Math.sin(ry);
      for (const o of [-1.25, 1.25]) this.box('std', gp.x + rx * o + fx * 0.9, 0.03, gp.z + rz * o + fz * 0.9, 0.16, 0.03, 2.6, '#f4f4f4', ry);
    }
    const p = T.pointAt(0);
    for (const s of [-1, 1]) this.field.mark(p.x + p.tz * s * px, p.z - p.tx * s * px, 3, 3, 0, 0.5);
    for (const di of [-30, 26, 60]) this._bunting((di + T.N) % T.N, 6.6);
  }

  _bunting(i, h) {
    const T = this.track, hw = T.halfWidth;
    this.B.frame.copy(this.frameRoad(i));
    const span = hw + 5.6, n = 28;
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
        const ff = this.frameSide(i, s, hw + 6.4);
        if (this.field.rectFree(ff.cx, ff.cz, 2, 7, ff.ry + Math.PI / 2, hw + 5.4)) { f = ff; side = s; break; }
      }
      if (!f) continue;
      const r = A.add('lbl-' + lb.text, 560, 170, (g, w, h) => {
        g.fillStyle = '#05683b'; g.fillRect(0, 0, w, h);
        g.strokeStyle = '#ffffff'; g.lineWidth = h * 0.045; roundRect(g, h * 0.07, h * 0.07, w - h * 0.14, h - h * 0.14, h * 0.08); g.stroke();
        g.fillStyle = '#fff';
        const ax = h * 0.42, ay = h * 0.5;
        g.beginPath(); g.moveTo(ax, ay - h * 0.28); g.lineTo(ax + h * 0.16, ay - h * 0.08); g.lineTo(ax + h * 0.06, ay - h * 0.08); g.lineTo(ax + h * 0.06, ay + h * 0.26);
        g.lineTo(ax - h * 0.06, ay + h * 0.26); g.lineTo(ax - h * 0.06, ay - h * 0.08); g.lineTo(ax - h * 0.16, ay - h * 0.08); g.closePath(); g.fill();
        fitText(g, lb.text, w * 0.56, h * 0.42, w * 0.7, h * 0.36, { color: '#ffffff', weight: '800', family: FONT2 });
        fitText(g, 'VADODARA', w * 0.56, h * 0.76, w * 0.5, h * 0.17, { color: '#d8f3dc', weight: '700', family: FONT2 });
      });
      this.B.frame.copy(f.m);
      const ry = (Math.PI / 2) * side;
      const bw = 6.2, bh = 1.9;
      for (const z of [-2.2, 2.2]) this.box('std', 0, 0, z, 0.16, 4.6, 0.16, '#9aa0a6');
      this.box('std', 0.08 * side, 2.6, 0, 0.1, bh + 0.1, bw + 0.1, '#7a8086');
      this.sign(0.03 * side, 3.6, 0, bw, bh, r, ry);
      this.B.frame.identity();
      this.field.mark(f.cx, f.cz, 2, 7, f.ry, 0.5);
    }
  }

  // ------------------------------------------------------------ road, kerbs, footpaths, barriers
  _road() {
    const T = this.track, hw = T.halfWidth, N = T.N, ds = T.ds;
    const X = T.x, Z = T.z, TX = T.tx, TZ = T.tz;
    const W = hw + 2.4, RL = 24;
    const tq = this.QL.tex;
    const cw = Math.round(512 * tq), chh = Math.round(512 * tq);
    const c = makeCanvas(cw, chh), g = c.getContext('2d');
    const rnd = mulberry32(hashStr(T.id + 'road'));
    const px = (lat) => ((lat + W) / (2 * W)) * cw;
    const py = (s) => (s / RL) * chh;
    g.fillStyle = '#46474b'; g.fillRect(0, 0, cw, chh);
    for (const s of [-1, 1]) {
      const x0 = px(s * (hw + 0.1)), x1 = px(s * W);
      const gr = g.createLinearGradient(x0, 0, x1, 0);
      gr.addColorStop(0, 'rgba(120,105,80,0)'); gr.addColorStop(0.5, 'rgba(130,112,84,0.55)'); gr.addColorStop(1, 'rgba(150,128,95,0.85)');
      g.fillStyle = gr; g.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), chh);
    }
    for (let k = 0; k < 4; k++) {
      const lat = (rnd() - 0.5) * 2 * hw * 0.8, s = rnd() * RL, w = 1 + rnd() * 2.5, l = 1.5 + rnd() * 3;
      g.fillStyle = rnd() < 0.5 ? 'rgba(30,30,33,0.16)' : 'rgba(110,110,112,0.1)';
      g.fillRect(px(lat), py(s), (w / (2 * W)) * cw, (l / RL) * chh);
    }
    for (const lane of [-hw * 0.75, -hw * 0.25, hw * 0.25, hw * 0.75]) {
      for (const o of [-0.8, 0.8]) {
        const x = px(lane + o);
        const gr = g.createLinearGradient(x - cw * 0.02, 0, x + cw * 0.02, 0);
        gr.addColorStop(0, 'rgba(20,20,22,0)'); gr.addColorStop(0.5, 'rgba(20,20,22,0.22)'); gr.addColorStop(1, 'rgba(20,20,22,0)');
        g.fillStyle = gr; g.fillRect(x - cw * 0.02, 0, cw * 0.04, chh);
      }
    }
    for (let k = 0; k < cw * chh * 0.03; k++) {
      const v = 60 + rnd() * 50;
      g.fillStyle = `rgba(${v},${v},${v + 4},${0.15 + rnd() * 0.25})`;
      g.fillRect(rnd() * cw, rnd() * chh, 1 + rnd() * 1.4, 1 + rnd() * 1.4);
    }
    g.strokeStyle = 'rgba(20,20,20,0.22)'; g.lineWidth = 1;
    for (let k = 0; k < 2; k++) {
      let x = px((rnd() - 0.5) * 2 * hw), y = rnd() * chh;
      g.beginPath(); g.moveTo(x, y);
      for (let j = 0; j < 6; j++) { x += (rnd() - 0.5) * cw * 0.05; y += rnd() * chh * 0.03; g.lineTo(x, y); }
      g.stroke();
    }
    const paint = (lat0, lat1, s0, s1, col) => { g.fillStyle = col; g.fillRect(px(lat0), py(s0), px(lat1) - px(lat0), py(s1) - py(s0)); };
    paint(-hw + 0.25, -hw + 0.45, 0, RL, '#efeee6');
    paint(hw - 0.45, hw - 0.25, 0, RL, '#efeee6');
    if (T.id === 'brightday') {
      paint(-0.75, -0.6, 0, RL, '#f2c94c'); paint(0.6, 0.75, 0, RL, '#f2c94c');
      g.save(); g.beginPath(); g.rect(px(-0.6), 0, px(0.6) - px(-0.6), chh); g.clip(); g.strokeStyle = 'rgba(242,201,76,0.9)'; g.lineWidth = Math.max(2, cw * 0.006);
      for (let s = -2; s < RL + 2; s += 2) { g.beginPath(); g.moveTo(px(-0.6), py(s)); g.lineTo(px(0.6), py(s + 1.2)); g.stroke(); }
      g.restore();
    } else for (let s = 0; s < RL; s += 8) { paint(-0.09, 0.09, s, s + 4, '#f1f0e8'); }
    if (hw >= 7) for (const lane of [-hw / 2, hw / 2]) for (let s = 2; s < RL; s += 8) paint(lane - 0.06, lane + 0.06, s, s + 2.5, 'rgba(240,240,232,0.85)');
    for (let k = 0; k < 900 * tq; k++) { g.fillStyle = `rgba(70,71,75,${0.3 + rnd() * 0.5})`; g.fillRect(rnd() * cw, rnd() * chh, 1.5, 1.5); }
    grain(g, cw, chh, 7, rnd);
    const roadTex = this._tex(c, { repeat: true });
    roadTex.wrapS = THREE.ClampToEdgeWrapping;
    const roadMat = new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.92, metalness: 0, envMapIntensity: 0.4, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    roadMat.userData.wettable = true;
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
      const ux = pos[b * 3] - pos[a * 3], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
      const vx = pos[cc * 3] - pos[a * 3], vz = pos[cc * 3 + 2] - pos[a * 3 + 2];
      const up = uz * vx - ux * vz;
      if (up > 0) idx.push(a, b, cc, b, d, cc); else idx.push(a, cc, b, b, cc, d);
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    rg.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    rg.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    rg.setIndex(idx);
    rg.computeBoundingSphere();
    this._add(new THREE.Mesh(rg, roadMat), false, true);

    // ---- kerbs on curves (red/white), barriers at the wall on the outside of tight corners
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
    const army = this.style === 'cantonment';
    const yel = new THREE.Color(army ? '#f4f4f0' : '#f2c200'), blk = new THREE.Color('#1e1e1e'), grey = new THREE.Color('#9aa0a6');
    const bar = new Soup();
    for (let i = 0; i < N; i += 2) {
      const s = bmask[i];
      if (!s) continue;
      const j = (i + 2) % N, lat = s * (hw + 4.95);
      const mid = P(i, lat, 0);
      if (this.field.dist(mid[0], mid[2]) < hw + 4.5) continue;
      const colr = (i / 2) % 2 ? yel : blk;
      const n = [-TZ[i] * s, 0, TX[i] * s];
      bar.quad(P(i, lat, 0.35), P(i, lat, 0.8), P(j, lat, 0.8), P(j, lat, 0.35), n, colr);
      bar.quad(P(i, lat, 0.8), P(i, lat + s * 0.1, 0.8), P(j, lat + s * 0.1, 0.8), P(j, lat, 0.8), [0, 1, 0], colr);
      if ((i / 2) % 2 === 0) {
        const a = P(i, lat + s * 0.05, 0);
        this.box('std', a[0], 0, a[2], 0.12, 0.85, 0.12, '#8a8f96', Math.atan2(TX[i], TZ[i]));
      }
    }
    if (bar.p.length) this.B.pushRaw('std', bar.p, bar.n, bar.c);

    // ---- footpaths: flat, drivable (only 7 cm high) with a painted kerb strip and paver texture
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
    const foot = new Soup(true);
    const top = new THREE.Color('#ffffff');
    const stripeA = new THREE.Color(army ? '#ffffff' : '#ffd21a').multiplyScalar(1.25), stripeB = new THREE.Color('#2a2a2a');
    const inL = hw + 2.4, outL = hw + 5.0, fh = 0.07, kw = 0.45;
    for (let i = 0; i < N; i += 2) {
      const j = (i + 2) % N;
      const v0 = (i * ds) / 2.6, v1 = ((i + 2) * ds) / 2.6;
      for (const s of [-1, 1]) {
        if (this.noFoot[s > 0 ? 1 : 0][i]) continue;
        const mid = P(i, s * (inL + outL) / 2, 0);
        const q = this.field.query(mid[0], mid[2]);
        if (q.d < inL - 0.5) continue;
        const a0 = s * inL, ak = s * (inL + kw), a1 = s * outL;
        const kc = (i / 2) % 2 ? stripeA : stripeB;
        foot.quad(P(i, a0, fh), P(i, ak, fh), P(j, ak, fh), P(j, a0, fh), [0, 1, 0], kc, [0, 0.02], [0.1, 0.02], [0.1, 0.03], [0, 0.03]);
        foot.quad(P(i, ak, fh), P(i, a1, fh), P(j, a1, fh), P(j, ak, fh), [0, 1, 0], top, [0, v0], [1, v0], [1, v1], [0, v1]);
        foot.quad(P(i, a0, 0), P(i, a0, fh), P(j, a0, fh), P(j, a0, 0), [-TZ[i] * s, 0, TX[i] * s], kc, [0, 0.02], [0, 0.03], [0.1, 0.03], [0.1, 0.02]);
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
      fm.userData.wettable = true;
      this._add(new THREE.Mesh(g2, fm), false, true);
    }
  }

  // ------------------------------------------------------------ buildings (per neighbourhood style)
  _buildings() {
    const T = this.track, hw = T.halfWidth, F = this.field, rnd = this.rnd, QL = this.QL, style = this.style, SS = this.SS;
    const clear = hw + 5.4;
    const vb = T.id === 'brightday';
    const pal = vb ? ['#f4f1ea', '#efe7d6', '#f2ead8', '#ffffff', '#e9e1cf', '#f5e6c8', '#e2d6bf', '#f0c6a0', '#dfe6ea'] : (PALETTES[style] || PALETTES.suburb);
    const signs = SS.signs;
    const frontAt = (s, side, lat) => {
      const p = T.pointAt(s);
      const ox = p.tz * side, oz = -p.tx * side;
      return { x: p.x + ox * lat, z: p.z + oz * lat, ox, oz, ry: Math.atan2(-ox, -oz) };
    };
    // find room for a w x d footprint whose front is `set` metres beyond the lane edge
    const room = (s, side, set, w, d, pad = 0.6) => {
      for (const dd of [d, d * 0.75, d * 0.55]) {
        if (dd < 5) break;
        const f = frontAt(s, side, hw + set), c = frontAt(s, side, hw + set + dd / 2);
        if (F.rectFree(c.x, c.z, w, dd, c.ry, clear)) { F.mark(c.x, c.z, w, dd, c.ry, pad); return { ...f, d: dd }; }
      }
      return null;
    };
    const M4 = new THREE.Matrix4();
    const atWorld = (f, lx, ly, lz, rot = 0) => M4.compose(new THREE.Vector3(f.x + lx * Math.cos(f.ry) + lz * Math.sin(f.ry), ly, f.z - lx * Math.sin(f.ry) + lz * Math.cos(f.ry)), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), f.ry + rot), new THREE.Vector3(1, 1, 1));
    let cranes = 0, pumps = 0;
    const compoundFront = (s, side, w, gate, o = {}) => {
      const f = frontAt(s, side, hw + 6.4);
      const c = frontAt(s, side, hw + 6.4);
      if (!F.rectFree(c.x, c.z, w, 0.6, c.ry, hw + 5.6)) return;
      F.mark(c.x, c.z, w, 0.6, c.ry, 0.2);
      SS.compound(f.x, f.z, f.ry, w, o.h || 1.8, { rnd, tint: o.tint || pick(rnd, pal), gate, gateW: o.gateW || 5, sign: o.sign, red: o.red });
    };

    // plot generators: each returns { w, d, set, gap, make(f) } or null for an open plot
    const G = {
      suburb: () => {
        const r = rnd();
        if (r < 0.3) { const w = 18 + rnd() * 14; return { w, d: 12 + rnd() * 4, set: 10, gap: 3 + rnd() * 6, make: (f) => SS.building(f.x, f.z, f.ry, { w, d: f.d, floors: 2 + Math.floor(rnd() * 2), kind: 'res', ground: 'shop', tint: pick(rnd, pal), rnd, balc: 0.1, name: rnd() < 0.6 ? pick(rnd, signs.apt) : null }) }; }
        if (r < 0.58) {
          const w = 16 + rnd() * 9, s0 = this._s;
          return { w, d: 14 + rnd() * 4, set: 13 + rnd() * 3, gap: 5 + rnd() * 8, make: (f) => {
            SS.building(f.x, f.z, f.ry, { w, d: f.d, floors: vb ? 4 + Math.floor(rnd() * 9) : 5 + Math.floor(rnd() * 5), kind: 'res', ground: 'stilt', tint: pick(rnd, pal), rnd, balc: 0.45, name: pick(rnd, signs.apt) });
            compoundFront(s0 + w / 2, this._side, w + 4, (rnd() - 0.5) * w * 0.5, { tint: pick(rnd, pal) });
          } };
        }
        if (r < 0.66) {
          const w = 18 + rnd() * 8;
          return { w, d: 16 + rnd() * 4, set: 14, gap: 6 + rnd() * 6, make: (f) => {
            const fl = 8 + Math.floor(rnd() * 7);
            const H = SS.construction(f.x, f.z, f.ry, { w, d: f.d, floors: fl, rnd, board: pick(rnd, signs.apt) });
            // Crane behind the site with its jib swung AWAY from the road (± ~35°), so it never hangs over the track
            // (f.ox, f.oz) points away from the road, so "behind the building" is +o; it used to be -o, which put cranes on the track
            if (cranes < 2 && fl >= 10) { cranes++; SS.crane(f.x + f.ox * (f.d + 6), f.z + f.oz * (f.d + 6), Math.atan2(f.ox, f.oz) + (rnd() - 0.5) * 1.2, H + 8, rnd); }
          } };
        }
        if (r < 0.78) {
          const w = 10 + rnd() * 4, s0 = this._s;
          return { w, d: 10 + rnd() * 2, set: 9, gap: 3 + rnd() * 3, make: (f) => {
            SS.building(f.x, f.z, f.ry, { w, d: f.d, floors: 2, kind: 'res', ground: 'house', tint: pick(rnd, pal), rnd, balc: 0.5, roof: rnd() < 0.35 ? 'tile' : 'flat' });
            compoundFront(s0 + w / 2, this._side, w + 2, (rnd() - 0.5) * 3, { gateW: 3.4, h: 1.6 });
          } };
        }
        if (r < 0.86) { const w = 9 + rnd() * 7; return { w, d: 9 + rnd() * 2, set: 7.6, gap: 2 + rnd() * 4, make: (f) => SS.building(f.x, f.z, f.ry, { w, d: f.d, floors: 1 + Math.floor(rnd() * 2), kind: 'res', ground: 'shop', tint: pick(rnd, pal), rnd }) }; }
        return null;
      },
      heritage: () => {
        const w = 4.6 + rnd() * 4.4, lane = rnd() < 0.12;
        return { w, d: 9 + rnd() * 4, set: 6.3, gap: lane ? 2.4 : 0.05, make: (f) => {
          const floors = 2 + Math.floor(rnd() * 2.6);
          const H = SS.building(f.x, f.z, f.ry, { w, d: f.d, floors, kind: 'heritage', ground: rnd() < 0.82 ? 'shop' : 'house', tint: pick(rnd, pal), rnd, party: !lane, roof: rnd() < 0.18 ? 'tile' : 'flat', ac: 0.08 });
          if (rnd() < 0.45 && floors >= 3) {
            const n = w > 7 ? 2 : 1;
            for (let k = 0; k < n; k++) this.I.jharokha.add(atWorld(f, n === 1 ? 0 : (k ? 1 : -1) * w * 0.25, 4.0 + 3.1 * (1 + Math.floor(rnd() * (floors - 2))) + 0.3, 0), pick(rnd, ['#d9b38a', '#8b5a2b', '#f2eee6', '#5fb8b0']));
          }
          return H;
        } };
      },
      city: () => {
        const r = rnd();
        if (r < 0.75) { const w = 16 + rnd() * 14; return { w, d: 14 + rnd() * 6, set: 8.6, gap: 2 + rnd() * 5, make: (f) => {
          const fl = 4 + Math.floor(rnd() * 8);
          const H = SS.building(f.x, f.z, f.ry, { w, d: f.d, floors: fl, kind: 'city', ground: 'shop', tint: pick(rnd, pal), rnd, name: rnd() < 0.5 ? pick(rnd, signs.apt) : null, tankP: 0.4 });
          if (rnd() < 0.35 && H < 40) {
            const bw = Math.min(w * 0.8, 13);
            for (const x of [-bw * 0.3, bw * 0.3]) this.I.misc.add(new THREE.Matrix4().copy(atWorld(f, x, H, -f.d * 0.4)).multiply(new THREE.Matrix4().makeScale(0.3, 1.8, 0.3)), '#555a60');
            this.addBoard(atWorld(f, 0, H + 1.8 + bw * 0.16, -f.d * 0.4), bw, bw * 0.31, 0.3, pick(rnd, this.adCells));
          }
        } }; }
        if (r < 0.95) { const w = 12 + rnd() * 8; return { w, d: 12 + rnd() * 4, set: 8, gap: 2 + rnd() * 4, make: (f) => SS.building(f.x, f.z, f.ry, { w, d: f.d, floors: 3 + Math.floor(rnd() * 3), kind: 'res', ground: 'shop', tint: pick(rnd, PALETTES.suburb), rnd }) }; }
        return null;
      },
      cantonment: () => {
        const r = rnd();
        if (r < 0.45) { const w = 24 + rnd() * 16; return { w, d: 11 + rnd() * 2, set: 16 + rnd() * 10, gap: 25 + rnd() * 35, make: (f) => SS.barrack(f.x, f.z, f.ry, { w, d: f.d, floors: rnd() < 0.3 ? 2 : 1, rnd, tint: pick(rnd, pal) }) }; }
        if (r < 0.55) { const w = 12 + rnd() * 6; return { w, d: 10, set: 12, gap: 20 + rnd() * 30, make: (f) => SS.building(f.x, f.z, f.ry, { w, d: f.d, floors: 2 + Math.floor(rnd() * 2), kind: 'res', ground: 'house', tint: pick(rnd, pal), rnd, balc: 0.2, tankP: 0.3 }) }; }
        return null;
      },
      outskirts: () => {
        const r = rnd();
        if (r < 0.16) return { w: 16, d: 11, set: 7, gap: 10 + rnd() * 20, make: (f) => SS.dhaba(f.x, f.z, f.ry, rnd) };
        if (r < 0.26 && pumps < 2) { pumps++; return { w: 28, d: 24, set: 7, gap: 15 + rnd() * 20, make: (f) => SS.petrolPump(f.x, f.z, f.ry, rnd) }; }
        if (r < 0.48) { const w = 10 + rnd() * 10; return { w, d: 9 + rnd() * 3, set: 8, gap: 3 + rnd() * 10, make: (f) => SS.building(f.x, f.z, f.ry, { w, d: f.d, floors: 1 + Math.floor(rnd() * 2), kind: 'res', ground: 'shop', tint: pick(rnd, pal), rnd, balc: 0.15 }) }; }
        if (r < 0.6) { const w = 10 + rnd() * 4, s0 = this._s; return { w, d: 10, set: 10, gap: 8 + rnd() * 14, make: (f) => { SS.building(f.x, f.z, f.ry, { w, d: f.d, floors: 1 + Math.floor(rnd() * 2), kind: 'res', ground: 'house', tint: pick(rnd, pal), rnd, roof: rnd() < 0.3 ? 'tile' : 'flat' }); compoundFront(s0 + w / 2, this._side, w + 2, 0, { gateW: 3.4, h: 1.5 }); } }; }
        if (r < 0.72) { const w = 12; return { w, d: 3, set: 7, gap: 20 + rnd() * 30, make: (f) => { const S = SS.at(f.x - f.ox * 1.5, f.z - f.oz * 1.5, f.ry + (this._side > 0 ? -0.35 : 0.35)); SS.billboardFrame(S, 12, 4.2, 6.5); this.addBoard(atWorld({ x: f.x - f.ox * 1.5, z: f.z - f.oz * 1.5, ry: f.ry + (this._side > 0 ? -0.35 : 0.35) }, 0, 6.5 + 2.1, -0.15), 12, 4.0, 0.25, pick(rnd, this.adCells)); } }; }
        return null;
      },
      industrial: () => {
        const r = rnd();
        if (r < 0.75) { const w = 30 + rnd() * 26, s0 = this._s; return { w, d: 22 + rnd() * 12, set: 12, gap: 6 + rnd() * 8, make: (f) => {
          SS.shed(f.x - f.ox * 4.6, f.z - f.oz * 4.6, f.ry, { w, d: f.d - 4.6, h: 8 + rnd() * 3, rnd, tint: pick(rnd, pal) });
          compoundFront(s0 + w / 2, this._side, w + 4, (rnd() - 0.5) * w * 0.4, { gateW: 6, h: 2.0, sign: pick(rnd, signs.ind), red: rnd() < 0.5, tint: '#e6e2d8' });
        } }; }
        if (r < 0.88) { const w = 8 + rnd() * 6; return { w, d: 9, set: 7.6, gap: 4 + rnd() * 8, make: (f) => SS.building(f.x, f.z, f.ry, { w, d: f.d, floors: 1 + Math.floor(rnd() * 2), kind: 'res', ground: 'shop', tint: pick(rnd, PALETTES.suburb), rnd }) }; }
        return null;
      },
    };
    const gen = G[style] || G.suburb;
    for (const side of [-1, 1]) {
      this._side = side;
      let s = rnd() * 8;
      while (s < T.length - 4) {
        this._s = s;
        const b = gen();
        if (!b) { s += 14 + rnd() * 22; continue; }
        const f = room(s + b.w / 2, side, b.set, b.w, b.d);
        if (f) { b.make(f); s += b.w + b.gap; } else s += 3;
      }
    }
    // second row (medium detail) and far scatter (low detail)
    const row2 = {
      suburb: { lat: 34, n: () => ({ w: 16 + rnd() * 10, d: 14 + rnd() * 6, floors: 5 + Math.floor(rnd() * 8), kind: 'res', ground: 'stilt' }) },
      heritage: { lat: 20, n: () => ({ w: 6 + rnd() * 6, d: 9 + rnd() * 5, floors: 2 + Math.floor(rnd() * 3), kind: 'heritage', ground: 'shop' }) },
      city: { lat: 40, n: () => ({ w: 18 + rnd() * 12, d: 16 + rnd() * 8, floors: 6 + Math.floor(rnd() * 9), kind: 'city', ground: 'shop' }) },
      cantonment: { lat: 55, n: () => ({ barrack: true, w: 24 + rnd() * 14, d: 11, floors: 1 }) },
      outskirts: { lat: 45, n: () => ({ w: 10 + rnd() * 8, d: 10 + rnd() * 4, floors: 1 + Math.floor(rnd() * 3), kind: 'res', ground: 'house' }) },
      industrial: { lat: 50, n: () => ({ shed: true, w: 30 + rnd() * 26, d: 22 + rnd() * 14, h: 8 + rnd() * 4 }) },
    }[style];
    for (const side of [-1, 1]) {
      let s = rnd() * 10;
      while (s < T.length) {
        const b = row2.n();
        if (rnd() > QL.rows || (style === 'outskirts' && rnd() < 0.5) || (style === 'cantonment' && rnd() < 0.4)) { s += b.w + 8; continue; }
        const f = frontAt(s + b.w / 2, side, hw + row2.lat + rnd() * 6);
        const c = frontAt(s + b.w / 2, side, hw + row2.lat + b.d / 2);
        let ok = F.rectFree(c.x, c.z, b.w, b.d, c.ry, clear);
        if (ok) {
          F.mark(c.x, c.z, b.w, b.d, c.ry, 0.8);
          if (b.barrack) SS.barrack(f.x, f.z, f.ry, { w: b.w, d: b.d, floors: 1, rnd, tint: pick(rnd, pal) });
          else if (b.shed) SS.shed(f.x, f.z, f.ry, { w: b.w, d: b.d, h: b.h, rnd, tint: pick(rnd, pal), detail: 0 });
          else SS.building(f.x, f.z, f.ry, { ...b, tint: pick(rnd, pal), rnd, detail: 1, party: style === 'heritage' });
        }
        s += ok ? b.w + 2 + rnd() * 6 : 4;
      }
    }
    const SC = {
      suburb: { n: 170, min: 60, max: 320, f: () => ({ w: 16 + rnd() * 10, d: 14 + rnd() * 8, floors: 6 + Math.floor(rnd() * 10), kind: 'res' }) },
      heritage: { n: 650, min: 32, max: 210, f: () => ({ w: 6 + rnd() * 6, d: 9 + rnd() * 5, floors: 2 + Math.floor(rnd() * 3), kind: 'heritage' }) },
      city: { n: 180, min: 70, max: 300, f: () => ({ w: 18 + rnd() * 14, d: 16 + rnd() * 10, floors: 6 + Math.floor(rnd() * 12), kind: 'city' }) },
      cantonment: { n: 70, min: 70, max: 300, f: () => ({ w: 20 + rnd() * 14, d: 12, floors: 1 + Math.floor(rnd() * 2), kind: 'res' }) },
      outskirts: { n: 80, min: 90, max: 340, f: () => ({ w: 16 + rnd() * 10, d: 14 + rnd() * 8, floors: 5 + Math.floor(rnd() * 10), kind: 'res' }) },
      industrial: { n: 110, min: 60, max: 300, f: () => ({ shed: true, w: 30 + rnd() * 30, d: 20 + rnd() * 20, h: 8 + rnd() * 5 }) },
    }[style];
    const tb = F.tb;
    const nScatter = Math.round(SC.n * QL.scatter);
    let tries = 0, placed = 0;
    while (placed < nScatter && tries < nScatter * 12) {
      tries++;
      const x = tb.minX - 240 + rnd() * (tb.maxX - tb.minX + 480), z = tb.minZ - 240 + rnd() * (tb.maxZ - tb.minZ + 480);
      const q = F.query(x, z);
      if (q.d < hw + SC.min || q.d > SC.max) continue;
      const b = SC.f();
      const ry = Math.atan2(T.tx[q.i], T.tz[q.i]) + (rnd() < 0.5 ? 0 : Math.PI / 2);
      if (!F.rectFree(x, z, b.w, b.d, ry, clear)) continue;
      F.mark(x, z, b.w, b.d, ry, 0.8);
      // frame origin is the front-centre: shift from the footprint centre
      const fx = x + Math.sin(ry) * b.d / 2, fz = z + Math.cos(ry) * b.d / 2;
      if (b.shed) SS.shed(fx, fz, ry, { w: b.w, d: b.d, h: b.h, rnd, tint: pick(rnd, pal), detail: 0 });
      else SS.building(fx, fz, ry, { ...b, ground: 'house', tint: pick(rnd, pal), rnd, detail: 0, tankP: style === 'city' ? 0.3 : 0.6 });
      placed++;
    }
    if (style === 'industrial') {
      for (let k = 0; k < 4; k++) {
        const x = tb.minX + rnd() * (tb.maxX - tb.minX), z = tb.minZ + rnd() * (tb.maxZ - tb.minZ);
        if (F.dist(x, z) < hw + 25 || F.occAt(x, z)) continue;
        if (k === 0) SS.waterTower(x, z, 18); else SS.chimney(x, z, 22 + rnd() * 14);
        F.mark(x, z, 8, 8, 0, 1);
      }
    }
  }

  // ------------------------------------------------------------ poles: street lights + overhead wires
  _poles() {
    const T = this.track, hw = T.halfWidth, F = this.field, rnd = this.rnd, style = this.style;
    const lat = hw + 5.25;
    const gap = style === 'heritage' ? 26 : style === 'cantonment' ? 34 : style === 'outskirts' ? 36 : 31;
    const wires = style !== 'cantonment';
    const lampsOn = this.P.lamps > 0;
    const fronts = this.SS.fronts;
    const near = (x, z, r) => { let best = null, bd = r * r; for (const f of fronts) { const d = (f[0] - x) ** 2 + (f[1] - z) ** 2; if (d < bd) { bd = d; best = f; } } return best; };
    const sag = (ax, ay, az, bx, by, bz, s, n = 6) => {
      let px = ax, py = ay, pz = az;
      for (let k = 1; k <= n; k++) {
        const t = k / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t, y = ay + (by - ay) * t - Math.sin(t * Math.PI) * s;
        this.wires.push(px, py, pz, x, y, z);
        px = x; py = y; pz = z;
      }
    };
    const poles = [[], []];
    let count = 0;
    for (const side of [-1, 1]) {
      let prev = null;
      for (let s = 8 + (side > 0 ? gap / 2 : 0); s < T.length - 4; s += gap) {
        const p = T.pointAt(s);
        const ox = p.tz * side, oz = -p.tx * side;
        const x = p.x + ox * lat, z = p.z + oz * lat;
        if (F.occAt(x, z) || F.dist(x, z) < lat - 0.6) { prev = null; continue; }
        const ry = Math.atan2(-ox, -oz);
        this.I.pole.add(L(x, 0, z, ry), 0xffffff);
        F.mark(x, z, 0.8, 0.8, 0, 0.2);
        const hx = x - ox * 2.55, hz = z - oz * 2.55;
        this.I.lampHead.add(L(hx, 8.5, hz, ry), 0xffffff);
        if (lampsOn) {
          this.I.pool.add(L(hx - ox * 1.6, 0.06, hz - oz * 1.6, ry, 15, 1, 15), 0xffffff);
          this.halos.push(hx, 8.35, hz);
          if (this.rain) this.I.streak.add(L(hx - ox * 2.4, 0.07, hz - oz * 2.4, Math.atan2(p.tx, p.tz), 1.4, 1, 13), 0xffffff);
        }
        poles[side > 0 ? 1 : 0].push({ s, x, z, ox, oz });
        count++;
        if (wires) {
          const att = (k) => [x - ox * [-0.7, 0, 0.7][k], [8.05, 8.25, 8.05][k], z - oz * [-0.7, 0, 0.7][k]];
          if (prev && s - prev.s < gap * 1.6) for (let k = 0; k < 3; k++) { const a = prev.att(k), b = att(k); sag(a[0], a[1], a[2], b[0], b[1], b[2], 0.55 + k * 0.08); }
          // service drop to a nearby building
          if (rnd() < (style === 'heritage' ? 0.85 : 0.55)) {
            const f = near(x, z, style === 'heritage' ? 14 : 20);
            if (f) sag(x, 7.4, z, f[0], f[2], f[1], 0.35, 4);
          }
          // transformer on twin poles now and then
          if (style !== 'heritage' && rnd() < 0.12) {
            const S = this.SS.at(x - ox * 0.1, z - oz * 0.1, ry);
            const T2 = this.SS.T, g = new THREE.Color('#8f979c');
            S.box(1.9, 0, -0.12, 2.15, 9, 0.12, T2.concrete[0], new THREE.Color('#d8d4cc'), 15);
            S.box(-0.2, 3.6, -0.5, 2.3, 3.75, 0.5, T2.gloss[0], g, 63);
            S.box(0.35, 3.75, -0.45, 1.75, 5.1, 0.45, T2.white[0], g, 63);
            for (const xx of [0.55, 1.05, 1.55]) S.box(xx - 0.06, 5.1, -0.06, xx + 0.06, 5.6, 0.06, T2.white[0], new THREE.Color('#d9c9a8'), 15 | 16);
            F.mark(x + Math.cos(ry) * 1, z - Math.sin(ry) * 1, 2.8, 1.2, ry, 0.2);
          }
          prev = { s, att };
        }
      }
    }
    // cable bundles crossing the street
    if (wires) {
      for (const a of poles[0]) {
        if (rnd() > (style === 'heritage' ? 0.5 : 0.22)) continue;
        let best = null;
        for (const b of poles[1]) if (Math.abs(b.s - a.s) < gap * 0.6 && (!best || Math.abs(b.s - a.s) < Math.abs(best.s - a.s))) best = b;
        if (best) sag(a.x, 7.6, a.z, best.x, 7.6, best.z, 0.9, 10);
      }
    }
    // festive string lights across old-city streets
    if (this.style === 'heritage' || this.P.lamps >= 1) {
      const step = this.style === 'heritage' ? 70 : 150;
      const cols = ['#ff5252', '#ffd740', '#69f0ae', '#40c4ff', '#ff6ec7', '#ffab40'].map((h) => new THREE.Color(h));
      for (let s = 35; s < T.length; s += step) {
        const p = T.pointAt(s);
        const span = hw + 5.4, n = 36;
        for (let j = 0; j <= n; j++) {
          const t = j / n, lt = -span + 2 * span * t, y = 7.6 - Math.sin(t * Math.PI) * 1.6;
          this.fairy.push(p.x + p.tz * lt, y, p.z - p.tx * lt, cols[j % cols.length]);
        }
      }
    }
    this.stats.poles = count;
  }

  // ------------------------------------------------------------ 24 m High Tension Road: lattice transmission towers + conductors
  _htLine() {
    const T = this.track, hw = T.halfWidth, F = this.field, rnd = this.rnd;
    const c = makeCanvas(128, 256), g = c.getContext('2d');
    g.clearRect(0, 0, 128, 256);
    g.strokeStyle = '#8d949a'; g.lineCap = 'square';
    g.lineWidth = 10; g.strokeRect(5, -10, 118, 276);
    g.lineWidth = 5;
    for (let y = -128; y < 256; y += 64) { g.beginPath(); g.moveTo(5, y); g.lineTo(123, y + 64); g.stroke(); g.beginPath(); g.moveTo(123, y); g.lineTo(5, y + 64); g.stroke(); g.beginPath(); g.moveTo(0, y + 64); g.lineTo(128, y + 64); g.stroke(); }
    const tex = this._tex(c, { repeat: true });
    const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.6, envMapIntensity: 0.8 });
    const S = new FSoup(), white = new THREE.Color('#ffffff');
    const shang = T.landmarks.find((l) => l.id === 'shangrila');
    const i1 = shang ? shang.index : Math.floor(T.N * 0.35), i0 = T.N - 300;
    const span = 210, side = -1;
    let prev = null;
    for (let s = i0 * T.ds; s < (T.N + i1) * T.ds; s += span) {
      const p = T.pointAt(s);
      const ox = p.tz * side, oz = -p.tx * side;
      let lat = hw + 24, ok = false;
      for (let k = 0; k < 4 && !ok; k++, lat += 9) ok = F.rectFree(p.x + ox * lat, p.z + oz * lat, 9, 9, 0, hw + 10);
      if (!ok) { prev = null; continue; }
      const x = p.x + ox * lat, z = p.z + oz * lat;
      F.mark(x, z, 8, 8, 0, 0.5);
      S.frame(x, z, Math.atan2(-ox, -oz));
      const b0 = 3.6, b1 = 1.0, h = 27, R = (u, v) => ({ u0: 0, u1: u, v0: 0, v1: v });
      for (const [A, B, Cc, D] of [[[-b0, 0, b0], [b0, 0, b0], [b1, h, b1], [-b1, h, b1]], [[b0, 0, -b0], [-b0, 0, -b0], [-b1, h, -b1], [b1, h, -b1]], [[b0, 0, b0], [b0, 0, -b0], [b1, h, -b1], [b1, h, b1]], [[-b0, 0, -b0], [-b0, 0, b0], [-b1, h, b1], [-b1, h, -b1]]]) S.qa(A, B, Cc, D, R(1, 7), white);
      for (const [A, B, Cc, D] of [[[-b1, h, b1], [b1, h, b1], [0.3, h + 7, 0.3], [-0.3, h + 7, 0.3]], [[b1, h, -b1], [-b1, h, -b1], [-0.3, h + 7, -0.3], [0.3, h + 7, -0.3]]]) S.qa(A, B, Cc, D, R(0.6, 2), white);
      const arms = [[19, 6.5], [23.5, 5.5], [28, 4.5]];
      for (const [y, a] of arms) {
        S.qa([-0.6, y, -a], [0.6, y, -a], [0.6, y, a], [-0.6, y, a], R(0.4, 3), white);
        S.qa([-0.6, y, -a], [-0.6, y, a], [-0.6, y + 1.2, a * 0.3], [-0.6, y + 1.2, -a * 0.3], R(3, 0.4), white);
      }
      const att = [];
      for (const [y, a] of arms) for (const sz of [-1, 1]) att.push([S.wx(0, sz * a), y - 1.6, S.wz(0, sz * a)]);
      att.push([S.wx(0, 0), h + 7, S.wz(0, 0)]);
      if (prev) for (let k = 0; k < att.length; k++) {
        const a = prev[k], b = att[k];
        let ax = a[0], ay = a[1], az = a[2];
        for (let j = 1; j <= 10; j++) {
          const t = j / 10, xx = a[0] + (b[0] - a[0]) * t, zz = a[2] + (b[2] - a[2]) * t, yy = a[1] + (b[1] - a[1]) * t - Math.sin(t * Math.PI) * 4.5;
          this.wires.push(ax, ay, az, xx, yy, zz); ax = xx; ay = yy; az = zz;
        }
      }
      prev = att;
    }
    if (!S.empty) { const m = new THREE.Mesh(S.build(), mat); this._add(m, false, true); } else { mat.dispose(); }
  }

  // ------------------------------------------------------------ chai stalls, bus stops, auto stands, cows, trucks...
  _streetLife() {
    const T = this.track, hw = T.halfWidth, F = this.field, rnd = this.rnd, SS = this.SS, style = this.style;
    const clear = hw + 5.4;
    const spot = (w, d, lat0 = hw + 5.8, tries = 40) => {
      for (let k = 0; k < tries; k++) {
        const s = rnd() * T.length, side = rnd() < 0.5 ? -1 : 1;
        const p = T.pointAt(s);
        const ox = p.tz * side, oz = -p.tx * side;
        const lat = lat0 + rnd() * 1.2;
        const cx = p.x + ox * (lat + d / 2), cz = p.z + oz * (lat + d / 2), ry = Math.atan2(-ox, -oz);
        if (!F.rectFree(cx, cz, w, d, ry, clear)) continue;
        F.mark(cx, cz, w, d, ry, 0.3);
        return { x: p.x + ox * lat, z: p.z + oz * lat, ry, ox, oz, side, h: Math.atan2(p.tx, p.tz) };
      }
      return null;
    };
    const N = {
      suburb: { chai: 5, pan: 3, bus: 2, auto: 2, cow: 3, truck: 1 }, heritage: { chai: 4, pan: 4, bus: 0, auto: 2, cow: 4, truck: 0 },
      city: { chai: 4, pan: 3, bus: 3, auto: 3, cow: 1, truck: 0 }, cantonment: { chai: 1, pan: 0, bus: 2, auto: 0, cow: 0, truck: 2, army: 6 },
      outskirts: { chai: 5, pan: 2, bus: 2, auto: 1, cow: 6, truck: 6 }, industrial: { chai: 6, pan: 2, bus: 1, auto: 1, cow: 2, truck: 9 },
    }[style] || {};
    for (let k = 0; k < (N.chai || 0); k++) { const f = spot(5.2, 2.2); if (f) SS.chaiStall(f.x, f.z, f.ry, rnd); }
    for (let k = 0; k < (N.pan || 0); k++) { const f = spot(2.2, 2.2); if (f) SS.panCabin(f.x - f.ox, f.z - f.oz, f.ry, rnd); }
    for (let k = 0; k < (N.bus || 0); k++) { const f = spot(8.4, 2.4); if (f) SS.busStop(f.x - f.ox * 0.4, f.z - f.oz * 0.4, f.ry); }
    for (let k = 0; k < (N.auto || 0); k++) {
      const f = spot(13, 3.2);
      if (!f) continue;
      SS.autoStandSign(f.x - f.ox * 0.3, f.z - f.oz * 0.3, f.ry + (f.side > 0 ? -0.6 : 0.6));
      for (let j = 0; j < 5; j++) { const a = (j - 2) * 2.1; this.I.auto.add(L(f.x - f.ox * 1.8 + Math.cos(f.ry) * a, 0.02, f.z - f.oz * 1.8 - Math.sin(f.ry) * a, f.ry + 0.12), rnd() < 0.85 ? '#ffffff' : '#e8ffe8'); }
    }
    for (let k = 0; k < (N.cow || 0); k++) { const f = spot(3, 3); if (f) SS.cow(f.x - f.ox * 1.4, f.z - f.oz * 1.4, f.h + (rnd() - 0.5) * 1.2, rnd); }
    for (let k = 0; k < (N.truck || 0); k++) { const f = spot(9, 3.2, hw + 6); if (f) SS.truck(f.x - f.ox * 1.6, f.z - f.oz * 1.6, f.ry + Math.PI / 2 * (rnd() < 0.5 ? 1 : -1), rnd); }
    for (let k = 0; k < (N.army || 0); k++) { const f = spot(3.6, 1); if (f) SS.postSign(f.x - f.ox * 0.4, f.z - f.oz * 0.4, f.ry + (f.side > 0 ? -0.5 : 0.5), SS.signs.road[k % 2 ? 'MILITARY AREA' : 'INDIAN ARMY'], 3.4, 1.0, 1.5); }
    // a few hoardings along most roads
    const nBill = { suburb: 4, city: 2, outskirts: 3, industrial: 3, cantonment: 1, heritage: 0 }[style] || 0;
    for (let k = 0; k < nBill; k++) {
      const f = spot(12, 3, hw + 7);
      if (!f) continue;
      const ry = f.ry + (f.side > 0 ? -0.35 : 0.35), bx = f.x - f.ox * 1.5, bz = f.z - f.oz * 1.5;
      SS.billboardFrame(SS.at(bx, bz, ry), 12, 4.2, 6.5);
      this.addBoard(L(bx + Math.sin(ry) * -0.15, 8.6, bz + Math.cos(ry) * -0.15, ry), 12, 4.0, 0.25, pick(rnd, this.adCells));
    }
  }

  // ------------------------------------------------------------ trees
  _trees() {
    const T = this.track, hw = T.halfWidth, F = this.field, rnd = this.rnd, QL = this.QL, style = this.style;
    const gap = STYLE_GAP[style] || 14;
    const lat0 = hw + 6.6;
    for (const side of [-1, 1]) {
      for (let s = rnd() * gap; s < T.length; s += gap * (0.8 + rnd() * 0.5)) {
        if (rnd() > QL.trees + 0.15) continue;
        const p = T.pointAt(s);
        const lat = lat0 + rnd() * (style === 'cantonment' ? 0.3 : 0.8);
        const x = p.x + p.tz * side * lat, z = p.z - p.tx * side * lat;
        if (!F.rectFree(x, z, 1.5, 1.5, 0, hw + 5.6)) continue;
        this.addTree(x, z, style === 'city' && rnd() < 0.4 ? 'ashoka' : rnd() < (style === 'cantonment' ? 0.3 : 0.12) ? 'banyan' : 'neem', 1);
      }
    }
    const tb = F.tb;
    const n = Math.round((STYLE_TREES[style] || 400) * QL.trees);
    let tries = 0, placed = 0;
    while (placed < n && tries < n * 10) {
      tries++;
      const x = tb.minX - 250 + rnd() * (tb.maxX - tb.minX + 500), z = tb.minZ - 250 + rnd() * (tb.maxZ - tb.minZ + 500);
      const d = F.dist(x, z);
      if (d < hw + 7 || d > 340) continue;
      if (!F.rectFree(x, z, 2, 2, 0, 0)) continue;
      const k = 1 + Math.floor(rnd() * 3);
      for (let j = 0; j < k; j++) {
        const xx = x + (rnd() - 0.5) * 9, zz = z + (rnd() - 0.5) * 9;
        if (j && (F.dist(xx, zz) < hw + 7 || !F.rectFree(xx, zz, 1.5, 1.5, 0, 0))) continue;
        const r = rnd();
        this.addTree(xx, zz, r < 0.15 ? 'banyan' : r < 0.3 ? 'ashoka' : r < 0.45 ? 'bush' : style === 'outskirts' && r < 0.55 ? 'palm' : 'neem', 1, d > hw + 40);
        placed++;
      }
    }
  }

  // ------------------------------------------------------------ parked autos and scooters (behind the poles, off the drivable strip)
  _props() {
    const T = this.track, hw = T.halfWidth, F = this.field, rnd = this.rnd, QL = this.QL;
    const nA = Math.round(({ suburb: 26, heritage: 30, city: 34, cantonment: 4, outskirts: 14, industrial: 12 }[this.style] || 20) * QL.props);
    const nS = Math.round(({ suburb: 40, heritage: 50, city: 50, cantonment: 8, outskirts: 20, industrial: 24 }[this.style] || 30) * QL.props);
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
          inst.add(L(x, 0.02, z, ry), col());
        }
      }
    };
    put(this.I.auto, hw + 6.5, nA, false, () => (rnd() < 0.8 ? '#ffffff' : '#e8ffe8'));
    put(this.I.scooter, hw + 7.4, nS, true, () => pick(rnd, ['#f2f2f0', '#1b1b1f', '#c8102e', '#1f4fa8', '#9aa3ad', '#e5601d', '#2e8b57', '#7b2cbf']));
    for (const lm of T.landmarks) {
      for (let o = -24; o <= 24; o += 3) {
        const i = (lm.index + o + T.N) % T.N;
        for (const s of [-1, 1]) {
          const lat = hw + 5.15;
          const x = T.x[i] + T.tz[i] * s * lat, z = T.z[i] - T.tx[i] * s * lat;
          if (F.dist(x, z) < lat - 0.3 || F.occAt(x, z)) continue;
          this.I.misc.add(L(x, 0, z, 0, 0.28, 0.9, 0.28), (o / 3) % 2 ? (this.style === 'cantonment' ? '#f4f4f0' : '#f2c200') : '#1e1e1e');
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
    const seg = 110;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg).rotateX(-Math.PI / 2).translate(cx, 0, cz);
    const pos = geo.attributes.position, n = pos.count;
    const col = new Float32Array(n * 3);
    const pal = {
      suburb: [['#7b9443', '#93a24c'], ['#b49c62', '#a88e5a'], ['#9c7f58', '#8a7050']],
      heritage: [['#8f9a52', '#a19a5c'], ['#b8a074', '#b09468'], ['#a2876a', '#9a8064']],
      city: [['#7a9248', '#86984f'], ['#a69a78', '#9c9070'], ['#8f8778', '#888070']],
      cantonment: [['#6e9a3c', '#7fa446'], ['#8fa255', '#7f9a4a'], ['#9a8a64', '#8f8060']],
      outskirts: [['#a39a5a', '#b5a466'], ['#c2a676', '#b49868'], ['#a68a62', '#9a7e58']],
      industrial: [['#8c8a62', '#9a9468'], ['#a8a088', '#9c9480'], ['#8a8478', '#7e786c']],
    }[style] || [['#7b9443', '#93a24c'], ['#b49c62', '#a88e5a'], ['#9c7f58', '#8a7050']];
    const C = pal.map((p) => p.map((h) => new THREE.Color(h)));
    const tmp = new THREE.Color(), tmp2 = new THREE.Color();
    const seed = hashStr(T.id) & 0xffff;
    const wet = this.rain ? 0.72 : 1;
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
      col[k * 3] = tmp.r * wet; col[k * 3 + 1] = tmp.g * wet; col[k * 3 + 2] = tmp.b * wet;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
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
    const mat = new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, roughness: this.rain ? 0.75 : 1, metalness: 0, envMapIntensity: 0.3, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
    const mesh = new THREE.Mesh(geo, mat);
    this._add(mesh, false, true);
  }

  // ------------------------------------------------------------ build meshes from collectors
  _finalize() {
    const P = this.P, QL = this.QL;
    const lampsOn = P.lamps > 0;
    const M = this.M;
    if (this._pendingTrain) { this._pendingTrain(); this._pendingTrain = null; }
    this._flushB();
    // streets: chunk-merged facade soups sharing one atlas material, grouped per 150 m cell
    const groups = new Map();
    const groupOf = (key) => {
      let g = groups.get(key);
      if (!g) { g = new THREE.Group(); g.name = 'chunk ' + key; groups.set(key, g); this.root.add(g); }
      return g;
    };
    const fm = facadeMaterial(this.SS.FA, { emissive: P.windows, wet: this.rain });
    fm.color.setScalar(this.tod === 'night' ? 0.5 : this.rain ? 0.85 : 1);
    if (this.tod === 'night') fm.envMapIntensity = 0.3;
    this._track(fm);
    const fmeshes = this.SS.meshes(fm);
    for (const m of fmeshes) { m.castShadow = QL.shadows; m.receiveShadow = true; this._track(m.geometry); groupOf(m.userData.chunk).add(m); }
    this.stats.facadeChunks = fmeshes.length;
    this.stats.facadeTris = this.SS.tris;
    const tmpl = {};
    // overhead wires
    if (this.wires.length) {
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.Float32BufferAttribute(this.wires, 3));
      wg.computeBoundingSphere();
      const wm = new THREE.LineBasicMaterial({ color: this.tod === 'night' ? '#0c0c0e' : '#202022', fog: true });
      this._add(new THREE.LineSegments(wg, wm), false, false);
    }

    const mk = (key, geo, mat, cast = true, attr = null) => {
      const inst = this.I[key];
      if (inst instanceof ChunkInst) { if (inst.count) tmpl[key] = tmplOf(geo); geo.dispose(); mat.dispose(); return null; }
      if (!inst.count) { geo.dispose(); mat.dispose(); return null; }
      const mesh = new THREE.InstancedMesh(geo, mat, inst.count);
      mesh.instanceMatrix.array.set(inst.m);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(inst.c), 3);
      if (attr) geo.setAttribute(attr.name, new THREE.InstancedBufferAttribute(new Float32Array(inst.a), attr.size));
      mesh.computeBoundingSphere();
      this._add(mesh, cast, true);
      return mesh;
    };
    mk('board', new THREE.BoxGeometry(1, 1, 1), boardMaterial(this.boardTex, P.signs + (P.lamps ? 0.35 : 0), this.boardRows), false, { name: 'aCell', size: 2 });
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
    {
      // ribbed black plastic water tank (the ubiquitous rooftop tank)
      const b = new Builder();
      b.push('s', new THREE.CylinderGeometry(0.62, 0.62, 1.25, 8, 1, true).translate(0, 0.62, 0), L(0, 0, 0), '#ffffff');
      b.push('s', new THREE.CylinderGeometry(0.3, 0.62, 0.18, 8, 1, false).translate(0, 1.34, 0), L(0, 0, 0), '#ffffff');
      for (const y of [0.42, 0.84]) b.push('s', new THREE.CylinderGeometry(0.65, 0.65, 0.06, 8, 1, true).translate(0, y, 0), L(0, 0, 0), '#d0d0d0');
      mk('tank', b.merged('s'), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, envMapIntensity: 0.5 }));
    }
    mk('misc', new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ roughness: 0.8, envMapIntensity: 0.4 }));
    mk('trunk', new THREE.CylinderGeometry(0.16, 0.26, 1, 6).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ roughness: 0.95, envMapIntensity: 0.3 }));
    {
      // whitewash band with a red ring at the base of roadside trees
      const b = new Builder();
      b.push('s', new THREE.CylinderGeometry(0.255, 0.27, 1.0, 6).translate(0, 0.5, 0), L(0, 0, 0), '#f4f2ea');
      b.push('s', new THREE.CylinderGeometry(0.262, 0.265, 0.18, 6).translate(0, 1.0, 0), L(0, 0, 0), '#b8322a');
      mk('band', b.merged('s'), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, envMapIntensity: 0.3 }), false);
    }
    {
      const parts = [];
      const r = mulberry32(7);
      parts.push(new THREE.IcosahedronGeometry(1, 1));
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * TAU + r(), rr = 0.5 + r() * 0.25;
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
      const lo = new THREE.IcosahedronGeometry(1, 0); lo.deleteAttribute('uv');
      const lc = new Float32Array(lo.attributes.position.count * 3);
      for (let k = 0; k < lc.length; k += 3) { const v = 0.8 + r() * 0.2; lc[k] = v; lc[k + 1] = v; lc[k + 2] = v * 0.95; }
      lo.setAttribute('color', new THREE.BufferAttribute(lc, 3)); lo.computeVertexNormals();
      mk('canopyLo', lo, new THREE.MeshStandardMaterial());
    }
    {
      const parts = [new THREE.ConeGeometry(0.55, 0.55, 7).translate(0, 0.25, 0), new THREE.ConeGeometry(0.45, 0.5, 7).translate(0, 0.55, 0), new THREE.ConeGeometry(0.3, 0.45, 7).translate(0, 0.8, 0)];
      const ag = mergeGeometries(parts.map((p) => { const q = p.toNonIndexed(); p.dispose(); return q; }));
      ag.computeVertexNormals();
      mk('ashoka', ag, new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true, envMapIntensity: 0.35 }));
    }
    {
      // palm crown: drooping fronds
      const b = new Builder();
      for (let k = 0; k < 9; k++) {
        const a = (k / 9) * TAU;
        b.push('s', new THREE.BoxGeometry(0.5, 0.05, 3.4).translate(0, 0, 1.7), L(0, 0, 0, a, 1, 1, 1, 0.45 + (k % 2) * 0.25), '#ffffff');
      }
      b.push('s', new THREE.SphereGeometry(0.45, 8, 6), L(0, -0.1, 0), '#9a8a5a');
      mk('palmTop', b.merged('s'), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, flatShading: true, envMapIntensity: 0.35, side: THREE.DoubleSide }));
    }
    {
      // concrete pole: black-yellow painted base, cross-arms with insulators, lamp arm reaching over the road (+z)
      const b = new Builder();
      const army = this.style === 'cantonment';
      b.push('s', new THREE.CylinderGeometry(0.1, 0.17, 9.2, 4).rotateY(Math.PI / 4).translate(0, 4.6, 0), L(0, 0, 0), army ? '#e9e7e0' : '#b9b5ad');
      for (let k = 0; k < 4; k++) b.push('s', new THREE.CylinderGeometry(0.172, 0.176, 0.3, 4).rotateY(Math.PI / 4).translate(0, 0.15 + k * 0.3, 0), L(0, 0, 0), k % 2 ? (army ? '#ffffff' : '#f2c200') : '#1e1e1e');
      if (!army) {
        for (const y of [8.0, 7.35]) b.push('s', new THREE.BoxGeometry(0.1, 0.1, 1.7).translate(0, y, 0), L(0, 0, 0), '#6f7377');
        for (const z of [-0.7, 0, 0.7]) b.push('s', new THREE.CylinderGeometry(0.05, 0.06, 0.2, 6).translate(z === 0 ? 0 : 0, z === 0 ? 8.15 : 8.13, z), L(0, 0, 0), '#e8e2d2');
      }
      b.push('s', new THREE.CylinderGeometry(0.045, 0.045, 2.7, 6).rotateX(Math.PI / 2 - 0.12).translate(0, 8.45, 1.3), L(0, 0, 0), '#8d939a');
      b.push('s', new THREE.BoxGeometry(0.4, 0.14, 0.9).translate(0, 8.62, 2.5), L(0, 0, 0), '#5b6168');
      mk('pole', b.merged('s'), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.1, envMapIntensity: 0.6 }), true);
    }
    const headCol = lampsOn ? new THREE.Color('#ffd28a').multiplyScalar(2.2 * P.lamps + 0.4) : new THREE.Color('#d9dde0');
    mk('lampHead', new THREE.BoxGeometry(0.34, 0.06, 0.8), new THREE.MeshBasicMaterial({ color: headCol, toneMapped: false }), false);
    if (lampsOn) {
      const poolTex = this._track(radialTexture(128, [[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,0.55)'], [0.7, 'rgba(255,255,255,0.15)'], [1, 'rgba(255,255,255,0)']]));
      const poolMat = new THREE.MeshBasicMaterial({
        map: poolTex, color: new THREE.Color('#ff9a3c').multiplyScalar(0.7 * P.lamps), transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, fog: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      });
      const pm = mk('pool', new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), poolMat, false);
      if (pm) { pm.renderOrder = 2; pm.receiveShadow = false; }
      if (this.rain) {
        // reflections of the lamps stretched on the wet road
        const sm = new THREE.MeshBasicMaterial({
          map: poolTex, color: new THREE.Color('#ffc070').multiplyScalar(0.55 * P.lamps), transparent: true, depthWrite: false,
          blending: THREE.AdditiveBlending, fog: true, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5,
        });
        const st = mk('streak', new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), sm, false);
        if (st) { st.renderOrder = 2; st.receiveShadow = false; }
      }
      const haloTex = this._track(radialTexture(64, [[0, 'rgba(255,255,255,1)'], [0.2, 'rgba(255,220,170,0.6)'], [1, 'rgba(255,180,90,0)']]));
      if (this.halos.length) {
        const hg = new THREE.BufferGeometry();
        hg.setAttribute('position', new THREE.Float32BufferAttribute(this.halos, 3));
        const hm = new THREE.PointsMaterial({ map: haloTex, color: new THREE.Color('#ffb661').multiplyScalar(P.lamps * (this.rain ? 1.3 : 1)), size: this.rain ? 8 : 6.5, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: true });
        const pts = new THREE.Points(hg, hm); pts.renderOrder = 3;
        this._add(pts, false, false);
      }
      if (this.fairy.length) {
        const pos = [], col = [];
        for (let k = 0; k < this.fairy.length; k += 4) { pos.push(this.fairy[k], this.fairy[k + 1], this.fairy[k + 2]); const c = this.fairy[k + 3]; col.push(c.r, c.g, c.b); }
        const fg = new THREE.BufferGeometry();
        fg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        fg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        const fmat = new THREE.PointsMaterial({ map: haloTex, vertexColors: true, size: 0.9, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
        const pts = new THREE.Points(fg, fmat); pts.renderOrder = 3;
        this._add(pts, false, false);
      }
    }
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
    // bake chunked props/trees: one mesh per cell per material
    let propTris = 0; const kindTris = {}; this.stats.kindTris = kindTris;
    for (const [key, c] of this.chunks.map) {
      const veg = [], prop = [];
      for (const [kind, list] of Object.entries(c)) if (tmpl[kind]) (VEG.has(kind) ? veg : prop).push({ t: tmpl[kind], list });
      for (const [parts, mat] of [[veg, M.veg], [prop, M.prop]]) {
        const g = bakeInstances(parts);
        if (!g) continue;
        propTris += g.index.count / 3;
        for (const p of parts) for (const [kk, t] of Object.entries(tmpl)) if (t === p.t) kindTris[kk] = (kindTris[kk] || 0) + (p.list.length / 19) * t.ic / 3;
        const mesh = new THREE.Mesh(g, mat);
        mesh.castShadow = QL.shadows; mesh.receiveShadow = true;
        this._track(g);
        groupOf(key).add(mesh);
      }
    }
    for (const [key, g] of groups) {
      const [ix, iz] = key.split(',').map(Number);
      this.chunkGroups.push({ g, x: (ix + 0.5) * CELL, z: (iz + 0.5) * CELL });
    }
    this.stats.propTris = propTris;
    this.stats.chunks = groups.size;
    for (const g of Object.values(this.G)) g.dispose();
    this.G = null;
    this.B = null; this.I = null; this.atlas = null; this.SS = null; this.wires = null; this.chunks = null;
  }
}

Object.assign(World.prototype, LandmarkMixin);
