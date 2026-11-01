// Procedural Maruti-Alto-style car models (stylised, no real logos).
// buildCarModel(carId, mods) => THREE.Group, applyMods(group, mods), disposeCarModel(group).
//
// How it works: each generation has a side profile (z forward, y up) with wheel-arch notches.
// The profile is turned into a closed, bevelled shell (walls + rounded edges + caps), then a
// deform() pass adds tumblehome, roof crown, lower tuck and plan-view rounding of the nose/tail.
// Every detail (glass, lamps, grille, plates, stickers) is generated in the same undeformed
// "surface coordinates" and pushed through the same deform(), so it hugs the body exactly.
// Geometry per car type is built once and cached; materials are cached by key and shared.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { CARS, DEFAULT_MODS } from './config.js';

const WHEEL_R = 0.29;
const PIVOT_Y = 0.45; // body roll/pitch pivot height
const PI = Math.PI;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

const GEO = new Map(); // shared geometries
const MAT = new Map(); // shared materials
const TEX = new Map(); // shared textures
const PARTS = new Map(); // per car id: built geometry + layout
const once = (map, key, fn) => {
  let v = map.get(key);
  if (v === undefined) { v = fn(); map.set(key, v); }
  return v;
};

// ---------------------------------------------------------------- generation specs
function makeSpec(car) {
  const sh = car.shape;
  const L = sh.length, W = sh.width, H = sh.height;
  const zF = L / 2, zR = -L / 2;
  const gen = sh.gen;
  let s;
  if (gen === 'gen1' || gen === 'gen1f') {
    const ff = gen === 'gen1f';
    const fo = 0.6 + (L - 3.5) * 0.5, zFA = zF - fo, zRA = zFA - 2.36;
    s = {
      zFA, zRA, ra: 0.335, bt: 0.05, bs: 0.05, roofScale: 0.87, crown: 0.012, tuck: 0.025, belt: [0.93, 0.95],
      pts: {
        rb: [zR + 0.05, 0.25, ff ? 0.08 : 0.06], fb: [zF - 0.04, 0.25, ff ? 0.09 : 0.06], fbumper: [zF, 0.42, ff ? 0.1 : 0.07],
        nose: [zF - 0.03, 0.7, 0.07], bonnet: [zF - 0.15, 0.775, 0.08], wsBase: [zF - 0.85, 0.915, 0.05],
        wsTop: [zF - 1.43, H - 0.012, 0.11], roofRear: [zR + 0.12, H - 0.03, 0.09], hatchBot: [zR + 0.025, 0.94, 0.06],
        rbumper: [zR, 0.5, ff ? 0.09 : 0.06],
      },
      plan: { kzF: ff ? 0.38 : 0.3, kxF: 0.02, kzR: 0.25, kxR: 0.02 },
      bFrac: 0.42, qFrac: 0.8, cLine: null, rearGlassW: 0.6, winMargin: 0.03,
    };
  } else if (gen === 'gen2') {
    const fo = 0.6 + (L - 3.45) * 0.6, zFA = zF - fo, zRA = zFA - 2.36;
    s = {
      zFA, zRA, ra: 0.34, bt: 0.085, bs: 0.075, roofScale: 0.83, crown: 0.02, tuck: 0.035, belt: [0.93, 0.99],
      pts: {
        rb: [zR + 0.08, 0.27, 0.09], fb: [zF - 0.1, 0.25, 0.1], fbumper: [zF, 0.44, 0.16], nose: [zF - 0.07, 0.65, 0.12],
        bonnet: [zF - 0.24, 0.76, 0.16], wsBase: [zF - 1.0, 0.925, 0.06], wsTop: [zF - 1.68, H - 0.02, 0.24],
        roofRear: [zR + 0.24, H - 0.06, 0.18], hatchBot: [zR + 0.07, 0.96, 0.1], rbumper: [zR, 0.58, 0.13],
      },
      plan: { kzF: 0.5, kxF: 0.05, kzR: 0.4, kxR: 0.04 },
      bFrac: 0.45, qFrac: 0, cLine: [0.12, 0.34], rearGlassW: 0.42, winMargin: 0.035,
    };
  } else { // gen3
    const fo = 0.66 + (L - 3.53) * 0.5, zFA = zF - fo, zRA = zFA - 2.38;
    s = {
      zFA, zRA, ra: 0.355, bt: 0.08, bs: 0.08, roofScale: 0.86, crown: 0.02, tuck: 0.03, belt: [0.99, 1.03],
      pts: {
        rb: [zR + 0.06, 0.28, 0.09], fb: [zF - 0.07, 0.27, 0.09], fbumper: [zF, 0.48, 0.16], nose: [zF - 0.05, 0.74, 0.14],
        bonnet: [zF - 0.22, 0.86, 0.16], wsBase: [zF - 0.9, 0.985, 0.07], wsTop: [zF - 1.58, H - 0.02, 0.26],
        roofRear: [zR + 0.16, H - 0.045, 0.16], hatchBot: [zR + 0.045, 1.0, 0.09], rbumper: [zR, 0.6, 0.13],
      },
      plan: { kzF: 0.45, kxF: 0.05, kzR: 0.35, kxR: 0.04 },
      bFrac: 0.45, qFrac: 0, cLine: [0.1, 0.22], rearGlassW: 0.44, winMargin: 0.035,
    };
  }
  Object.assign(s, { gen, L, W, H, zF, zR, facelift: !!sh.facelift, legend: !!sh.legend, archY: 0.3, sill: 0.2, tuckTop: 0.42 });
  s.plan.zf0 = s.zFA + s.ra + 0.03;
  s.plan.zr0 = s.zRA - s.ra - 0.03;
  return s;
}

// ---------------------------------------------------------------- 2D outline
function buildOutlinePts(sp) {
  const raw = [];
  const P = (name) => { const [z, y, r] = sp.pts[name]; raw.push({ z, y, r, name }); };
  const arch = (zc) => {
    const d = (sp.archY - sp.sill) / sp.ra;
    const a0 = PI + Math.asin(d), a1 = -Math.asin(d), n = 12;
    for (let i = 0; i <= n; i++) {
      const a = a0 + (a1 - a0) * (i / n);
      raw.push({ z: zc + sp.ra * Math.cos(a), y: sp.archY + sp.ra * Math.sin(a), r: 0 });
    }
  };
  P('rb'); arch(sp.zRA); arch(sp.zFA);
  for (const k of ['fb', 'fbumper', 'nose', 'bonnet', 'wsBase', 'wsTop', 'roofRear', 'hatchBot', 'rbumper']) P(k);

  const out = [], marks = {};
  const push = (z, y) => {
    const l = out[out.length - 1];
    if (l && Math.hypot(l[0] - z, l[1] - y) < 1e-4) return;
    out.push([z, y]);
  };
  const n = raw.length;
  for (let i = 0; i < n; i++) {
    const c = raw[i], p = raw[(i - 1 + n) % n], q = raw[(i + 1) % n];
    if (!c.r) { if (c.name) marks[c.name] = out.length; push(c.z, c.y); continue; }
    let d1z = p.z - c.z, d1y = p.y - c.y; const l1 = Math.hypot(d1z, d1y); d1z /= l1; d1y /= l1;
    let d2z = q.z - c.z, d2y = q.y - c.y; const l2 = Math.hypot(d2z, d2y); d2z /= l2; d2y /= l2;
    const th = Math.acos(clamp(d1z * d2z + d1y * d2y, -1, 1));
    if (th > PI - 0.01) { marks[c.name] = out.length; push(c.z, c.y); continue; }
    let r = c.r, t = r / Math.tan(th / 2);
    const tMax = 0.48 * Math.min(l1, l2);
    if (t > tMax) { t = tMax; r = t * Math.tan(th / 2); }
    const az = c.z + d1z * t, ay = c.y + d1y * t, bz = c.z + d2z * t, by = c.y + d2y * t;
    let bz2 = d1z + d2z, by2 = d1y + d2y; const lb = Math.hypot(bz2, by2); bz2 /= lb; by2 /= lb;
    const h = r / Math.sin(th / 2), cz = c.z + bz2 * h, cy = c.y + by2 * h;
    const a0 = Math.atan2(ay - cy, az - cz);
    let da = Math.atan2(by - cy, bz - cz) - a0;
    while (da > PI) da -= 2 * PI;
    while (da < -PI) da += 2 * PI;
    const segs = Math.max(2, Math.ceil(Math.abs(da) / 0.22));
    for (let k = 0; k <= segs; k++) {
      if (k === (segs >> 1)) marks[c.name] = out.length;
      const a = a0 + da * (k / segs);
      push(cz + r * Math.cos(a), cy + r * Math.sin(a));
    }
  }
  const f = out[0], l = out[out.length - 1];
  if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-4) out.pop();
  return { pts: out, marks };
}

class Outline {
  constructor(pts) {
    const n = pts.length;
    this.p = pts; this.n = n;
    this.cum = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      this.cum[i + 1] = this.cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    this.len = this.cum[n];
    const en = [];
    for (let i = 0; i < n; i++) { // outward normal of edge i (CCW in z,y)
      const a = pts[i], b = pts[(i + 1) % n];
      const dz = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dz, dy) || 1;
      en.push([dy / l, -dz / l]);
    }
    this.vn = []; this.mt = [];
    for (let i = 0; i < n; i++) {
      const e0 = en[(i - 1 + n) % n], e1 = en[i];
      const sz = e0[0] + e1[0], sy = e0[1] + e1[1], ls = Math.hypot(sz, sy) || 1;
      this.vn.push([sz / ls, sy / ls]);
      const dot = e0[0] * e1[0] + e0[1] * e1[1];
      let mz = sz / (1 + dot), my = sy / (1 + dot);
      const ml = Math.hypot(mz, my);
      if (ml > 2.5) { mz *= 2.5 / ml; my *= 2.5 / ml; }
      this.mt.push([mz, my]);
    }
  }
  at(s) {
    const len = this.len;
    s = ((s % len) + len) % len;
    let lo = 0, hi = this.n - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.cum[mid] <= s) lo = mid; else hi = mid - 1; }
    const i = lo, j = (i + 1) % this.n;
    const t = (s - this.cum[i]) / ((this.cum[i + 1] - this.cum[i]) || 1);
    const a = this.p[i], b = this.p[j], na = this.vn[i], nb = this.vn[j], ma = this.mt[i], mb = this.mt[j];
    let nz = lerp(na[0], nb[0], t), ny = lerp(na[1], nb[1], t);
    const nl = Math.hypot(nz, ny) || 1; nz /= nl; ny /= nl;
    return { z: lerp(a[0], b[0], t), y: lerp(a[1], b[1], t), nz, ny, mz: lerp(ma[0], mb[0], t), my: lerp(ma[1], mb[1], t) };
  }
  // first s in [s0,s1] where component `key` of at(s) crosses `target`
  cross(s0, s1, key, target) {
    const N = Math.max(8, Math.ceil((s1 - s0) / 0.004));
    let ps = s0, pv = this.at(s0)[key] - target, best = s0, bestV = Math.abs(pv);
    for (let k = 1; k <= N; k++) {
      const s = s0 + (s1 - s0) * (k / N), v = this.at(s)[key] - target;
      if (pv === 0) return ps;
      if (pv * v <= 0) return ps + (s - ps) * (pv / (pv - v));
      if (Math.abs(v) < bestV) { bestV = Math.abs(v); best = s; }
      ps = s; pv = v;
    }
    return best;
  }
}

// ---------------------------------------------------------------- body frame (deform + surface mapping)
class Frame {
  constructor(sp) {
    this.sp = sp;
    this.bt = sp.bt; this.bs = sp.bs;
    this.hd = sp.W / 2 - sp.bt;
    this.arc = (PI / 2) * Math.sqrt((sp.bt * sp.bt + sp.bs * sp.bs) / 2);
    this.WE = this.hd + this.arc; // lateral surface coordinate where the flat side begins
    const { pts, marks } = buildOutlinePts(sp);
    this.ol = new Outline(pts);
    this.S = {};
    for (const k in marks) this.S[k] = this.ol.cum[marks[k]];
    this.P = sp.pts;
    this.len = this.ol.len;
  }
  beltAt(z) {
    const a = this.P.wsBase[0], b = this.P.hatchBot[0];
    return lerp(this.sp.belt[0], this.sp.belt[1], clamp((a - z) / (a - b), 0, 1));
  }
  deform(x, y, z) {
    const sp = this.sp, P = sp.plan;
    const xn = clamp(x / (this.hd + this.bt), -1, 1);
    const b = this.beltAt(z);
    const tb = clamp((y - b) / (sp.H - b), 0, 1);
    const yy = y + sp.crown * tb * tb * (1 - xn * xn);
    let sx = 1 - (1 - sp.roofScale) * tb;
    const tk = clamp((sp.tuckTop - y) / (sp.tuckTop - sp.sill), 0, 1);
    sx *= 1 - sp.tuck * tk * tk;
    let zz = z;
    if (z > P.zf0) {
      const t = (z - P.zf0) / (sp.zF - P.zf0);
      zz = P.zf0 + (z - P.zf0) * (1 - P.kzF * xn * xn);
      sx *= 1 - P.kxF * t * t;
    } else if (z < P.zr0) {
      const t = (P.zr0 - z) / (P.zr0 - sp.zR);
      zz = P.zr0 + (z - P.zr0) * (1 - P.kzR * xn * xn);
      sx *= 1 - P.kxR * t * t;
    }
    return new THREE.Vector3(x * sx, yy, zz);
  }
  // s: arc length along the profile, w: lateral surface coordinate (0 = centreline), off: offset along the normal
  surf(s, w, off = 0, capN = null) {
    const o = this.ol.at(s);
    const aw = Math.abs(w), sg = w < 0 ? -1 : 1, { hd, bt, bs, arc } = this;
    let x, y, z;
    if (aw <= hd) { x = w; y = o.y + o.ny * off; z = o.z + o.nz * off; }
    else if (aw <= hd + arc) {
      const psi = ((aw - hd) / arc) * (PI / 2), sn = Math.sin(psi), cs = Math.cos(psi);
      x = sg * (hd + (bt + off) * sn);
      const ins = bs * (1 - cs) - off * cs;
      y = o.y - o.ny * ins; z = o.z - o.nz * ins;
    } else {
      x = sg * (hd + bt + off);
      const e = aw - hd - arc, cz = capN ? capN[0] : o.nz, cy = capN ? capN[1] : o.ny;
      y = o.y - o.ny * bs - cy * e; z = o.z - o.nz * bs - cz * e;
    }
    return this.deform(x, y, z);
  }
  side(z, y, sg, off = 0) { return this.deform(sg * (this.hd + this.bt + off), y, z); }
  fy(y) { return this.ol.cross(this.S.fb, this.S.wsBase, 'y', y); } // front face
  ry(y) { return this.ol.cross(this.S.roofRear, this.len + this.S.rb, 'y', y); } // rear face
  wy(y) { return this.ol.cross(this.S.wsBase, this.S.roofRear, 'y', y); } // windscreen
  roofS(z) { return this.ol.cross(this.S.wsTop, this.S.roofRear + 0.2, 'z', z); }
}

// ---------------------------------------------------------------- geometry helpers
function pip(poly, z, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > y) !== (b[1] > y) && z < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function segDist(poly, z, y) {
  let m = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i], dz = b[0] - a[0], dy = b[1] - a[1];
    const t = clamp(((z - a[0]) * dz + (y - a[1]) * dy) / (dz * dz + dy * dy || 1), 0, 1);
    m = Math.min(m, Math.hypot(z - a[0] - dz * t, y - a[1] - dy * t));
  }
  return m;
}
// earcut with interior Steiner points so non-linear deforms stay smooth
function triangulate(contour, spacing, extra = []) {
  let z0 = Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of contour) { z0 = Math.min(z0, p[0]); z1 = Math.max(z1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  const st = [];
  for (const p of extra) if (pip(contour, p[0], p[1]) && segDist(contour, p[0], p[1]) > 0.025) st.push(p);
  const nEx = st.length;
  for (let z = z0 + spacing * 0.5; z < z1; z += spacing) {
    for (let y = y0 + spacing * 0.5; y < y1; y += spacing) {
      if (!pip(contour, z, y) || segDist(contour, z, y) < spacing * 0.35) continue;
      let ok = true;
      for (let k = 0; k < nEx; k++) if (Math.hypot(st[k][0] - z, st[k][1] - y) < spacing * 0.4) { ok = false; break; }
      if (ok) st.push([z, y]);
    }
  }
  const faces = THREE.ShapeUtils.triangulateShape(
    contour.map((p) => new THREE.Vector2(p[0], p[1])),
    st.map((p) => [new THREE.Vector2(p[0], p[1])]),
  );
  return { verts: contour.concat(st), faces };
}
function triNormal(a, b, c) { return new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)); }
function flipIndex(idx) { for (let k = 0; k < idx.length; k += 3) { const t = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = t; } }
function indexedGeo(pos, idx, uv) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
// make every triangle face away from `inside` point-test: expectedFn(p) returns desired normal at p
function orient(pos, idx, expectedFn) {
  // vote over a few triangles (robust to degenerate ones)
  let vote = 0;
  const step = Math.max(3, Math.floor(idx.length / 3 / 12) * 3);
  const v = (i) => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
  for (let k = 0; k < idx.length; k += step) {
    const a = v(idx[k]), b = v(idx[k + 1]), c = v(idx[k + 2]);
    const n = triNormal(a, b, c);
    if (n.lengthSq() < 1e-12) continue;
    const ctr = a.add(b).add(c).multiplyScalar(1 / 3);
    vote += Math.sign(n.dot(expectedFn(ctr)));
  }
  if (vote < 0) flipIndex(idx);
}
function clean(g, keepUv) {
  const geo = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') geo.deleteAttribute(k);
  if (!geo.attributes.normal) geo.computeVertexNormals();
  if (!keepUv && geo.attributes.uv) geo.deleteAttribute('uv');
  if (keepUv && !geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
  return geo;
}
function merge(list, keepUv = false) {
  const gs = list.filter(Boolean).map((g) => clean(g, keepUv));
  if (!gs.length) return null;
  const m = gs.length === 1 ? gs[0] : mergeGeometries(gs, false);
  m.computeBoundingSphere();
  m.computeBoundingBox();
  return m;
}
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _one = new THREE.Vector3(1, 1, 1);
function place(g, x, y, z, rx = 0, ry = 0, rz = 0) {
  _q.setFromEuler(_e.set(rx, ry, rz));
  g.applyMatrix4(_m4.compose(new THREE.Vector3(x, y, z), _q, _one));
  return g;
}
const box = (w, h, d, x, y, z, rx, ry, rz, r = 0) =>
  place(r ? new RoundedBoxGeometry(w, h, d, 2, r) : new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz);

function superB(a, b, round) {
  if (!round) return b;
  const p = 2 + (1 - round) * 10;
  const f = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(2 * a - 1) * 0.97, p)), 1 / p);
  return 0.5 + (b - 0.5) * f;
}

// Generic grid panel: map(a,b,off) -> Vector3 ; expected outward = map(a,b,off+δ)-map(a,b,off)
function gridPanel(map, { nu = 8, nv = 3, off = 0.004, thick = 0, uv = null }) {
  const pos = [], uvs = [], idx = [];
  const top = off + thick;
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    const a = i / nu, b = j / nv, p = map(a, b, top);
    pos.push(p.x, p.y, p.z);
    const t = uv ? uv(a, b) : [a, b];
    uvs.push(t[0], t[1]);
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
    idx.push(a, b, d, a, d, c);
  }
  // orientation from the middle of the panel
  const pm = map(0.5, 0.5, top), pn = map(0.5, 0.5, top + 0.01).sub(pm);
  const n = triNormal(pm, map(0.52, 0.5, top), map(0.52, 0.52, top));
  if (n.dot(pn) < 0) flipIndex(idx);
  const geos = [indexedGeo(pos, idx, uvs)];
  if (thick > 0) {
    const loop = [];
    for (let i = 0; i <= nu; i++) loop.push([i / nu, 0]);
    for (let j = 1; j <= nv; j++) loop.push([1, j / nv]);
    for (let i = nu - 1; i >= 0; i--) loop.push([i / nu, 1]);
    for (let j = nv - 1; j >= 1; j--) loop.push([0, j / nv]);
    const ctr = map(0.5, 0.5, off + thick * 0.5);
    const ep = [];
    for (let k = 0; k < loop.length; k++) {
      const [a0, b0] = loop[k], [a1, b1] = loop[(k + 1) % loop.length];
      const A = map(a0, b0, top), B = map(a1, b1, top), C = map(a1, b1, off), D = map(a0, b0, off);
      let tri = [A, B, C, A, C, D];
      const nn = triNormal(A, B, C);
      if (nn.lengthSq() < 1e-14) { const n2 = triNormal(A, C, D); if (n2.lengthSq() < 1e-14) continue; nn.copy(n2); }
      const mid = A.clone().add(C).multiplyScalar(0.5).sub(ctr);
      if (nn.dot(mid) < 0) tri = [A, C, B, A, D, C];
      for (const p of tri) ep.push(p.x, p.y, p.z);
    }
    if (ep.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(ep, 3));
      g.computeVertexNormals();
      geos.push(g);
    }
  }
  return geos;
}

// ---------------------------------------------------------------- car parts (cached per car id)
function getParts(car) {
  return once(PARTS, car.id, () => buildParts(car));
}

function buildParts(car) {
  const sp = makeSpec(car);
  const F = new Frame(sp);
  const { hd, bt, bs, WE, P, S } = F;
  const B = {};
  const add = (bucket, g) => { if (!g) return; (B[bucket] ||= []).push(...(Array.isArray(g) ? g : [g])); };
  const val = (v, a) => (typeof v === 'function' ? v(a) : v);

  // wall panel in (s, w) surface coordinates
  const wall = (bucket, o) => {
    const cn = F.ol.at((val(o.s0, 1) + val(o.s1, 1)) / 2), capN = o.capN || [cn.nz, cn.ny];
    const q = o.round ? { ...o, nu: Math.max(o.nu || 8, 14), nv: Math.max(o.nv || 3, 4) } : o;
    const mk = (sgn) => gridPanel((a, b, off) => {
      b = superB(a, b, o.round);
      const w = sgn * lerp(o.w0, o.w1, a);
      return F.surf(lerp(val(o.s0, a), val(o.s1, a), b), w, off, capN);
    }, q);
    add(bucket, mk(1));
    if (o.mirror) add(bucket, mk(-1));
  };
  // side panel in (z, y) on the flat sides
  const side = (bucket, o) => {
    for (const sg of o.sides || [1, -1]) {
      add(bucket, gridPanel((a, b, off) => {
        b = superB(a, b, o.round);
        const z = lerp(o.z0, o.z1, a);
        return F.side(z, lerp(val(o.y0, a), val(o.y1, a), b), sg, off);
      }, { ...o, uv: o.uv ? (a, b) => o.uv(a, b, sg) : null }));
    }
  };
  // polygon on the flat side
  const sidePoly = (bucket, contour, off, spacing = 0.12) => {
    if (!contour || contour.length < 3) return;
    const { verts, faces } = triangulate(contour, spacing);
    for (const sg of [1, -1]) {
      const pos = [], idx = [];
      for (const v of verts) { const p = F.side(v[0], v[1], sg, off); pos.push(p.x, p.y, p.z); }
      for (const f of faces) idx.push(f[0], f[1], f[2]);
      orient(pos, idx, () => new THREE.Vector3(sg, 0, 0));
      add(bucket, indexedGeo(pos, idx));
    }
  };

  // ---- body shell
  add('paint', buildShell(F));

  const zFA = sp.zFA, zRA = sp.zRA, ra = sp.ra, H = sp.H;
  const gen = sp.gen, g1 = gen === 'gen1', g1f = gen === 'gen1f', g2 = gen === 'gen2', g3 = gen === 'gen3';
  const zWs = P.wsBase[0], zHb = P.hatchBot[0];
  const zB = lerp(zWs, zHb, sp.bFrac);
  const zQ = sp.qFrac ? lerp(zWs, zHb, sp.qFrac) : null;
  const beltB = F.beltAt(zB);
  const cLine = sp.cLine ? (y) => {
    const t = clamp((y - F.beltAt(zRA)) / (H - F.beltAt(zRA)), 0, 1);
    return zRA + lerp(sp.cLine[0], sp.cLine[1], t);
  } : null;

  // ---- windscreen + rear glass
  const wsW = hd + F.arc * 0.25;
  wall('trim', { s0: F.wy(P.wsBase[1] + 0.012), s1: F.wy(H - 0.05), w0: -(wsW + 0.03), w1: wsW + 0.03, nu: 10, nv: 4, off: 0.003 });
  wall('glass', { s0: F.wy(P.wsBase[1] + 0.035), s1: F.wy(H - 0.085), w0: -wsW, w1: wsW, nu: 10, nv: 4, off: 0.006 });
  const rgW = Math.min(sp.rearGlassW, hd - 0.03);
  wall('trim', { s0: F.ry(H - 0.07), s1: F.ry(P.hatchBot[1] + 0.012), w0: -(rgW + 0.025), w1: rgW + 0.025, nu: 8, nv: 4, off: 0.003 });
  wall('glass', { s0: F.ry(H - 0.1), s1: F.ry(P.hatchBot[1] + 0.035), w0: -rgW, w1: rgW, nu: 8, nv: 4, off: 0.006 });

  // ---- side windows
  const winPoly = (margin, gap) => {
    const ol = F.ol, d = bs + margin, Q = [];
    const s0 = S.wsBase - 0.2, s1 = S.hatchBot + 0.2;
    for (let s = s0; s <= s1; s += 0.025) {
      const o = ol.at(s);
      Q.push([o.z - o.mz * d, o.y - o.my * d]);
    }
    const yb = (z) => F.beltAt(z) + gap;
    const above = Q.map((q) => q[1] >= yb(q[0]));
    let i0 = above.indexOf(true), i1 = above.lastIndexOf(true);
    if (i0 <= 0 || i1 >= Q.length - 1 || i1 <= i0) return null;
    const inter = (p, q) => {
      const fp = p[1] - yb(p[0]), fq = q[1] - yb(q[0]), t = fp / (fp - fq);
      return [lerp(p[0], q[0], t), lerp(p[1], q[1], t)];
    };
    return [inter(Q[i0 - 1], Q[i0]), ...Q.slice(i0, i1 + 1), inter(Q[i1], Q[i1 + 1])];
  };
  const clip = (poly, f) => { // keep f(p) >= 0
    if (!poly) return null;
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], fa = f(a), fb = f(b);
      if (fa >= 0) out.push(a);
      if ((fa >= 0) !== (fb >= 0)) { const t = fa / (fa - fb); out.push([lerp(a[0], b[0], t), lerp(a[1], b[1], t)]); }
    }
    return out.length >= 3 ? out : null;
  };
  const m = sp.winMargin;
  let frame = winPoly(m - 0.025, 0.004);
  if (cLine) frame = clip(frame, (p) => p[0] - (cLine(p[1]) - 0.025));
  sidePoly('trim', frame, 0.0025, 0.15);
  let glassAll = winPoly(m, 0.025);
  if (cLine) glassAll = clip(glassAll, (p) => p[0] - cLine(p[1]));
  const bw = 0.045;
  sidePoly('glass', clip(glassAll, (p) => p[0] - (zB + bw)), 0.006, 0.15);
  let rear = clip(glassAll, (p) => (zB - bw) - p[0]);
  if (zQ !== null) {
    sidePoly('glass', clip(rear, (p) => p[0] - (zQ + 0.035)), 0.006, 0.15);
    sidePoly('glass', clip(rear, (p) => (zQ - 0.035) - p[0]), 0.006, 0.15);
  } else sidePoly('glass', rear, 0.006, 0.15);

  // ---- door shut lines & handles
  const zDf = Math.min(zWs - 0.08, zFA - ra - 0.03);
  const zDr = zQ !== null ? zQ : Math.max(zRA + ra + 0.05, cLine ? cLine(F.beltAt(zRA)) - 0.02 : zRA + ra + 0.05);
  const yLow = sp.sill + bs + 0.03;
  for (const z of [zDf, zB, zDr]) {
    const top = F.beltAt(z) - 0.005;
    side('trim', { z0: z - 0.004, z1: z + 0.004, y0: z === zDr ? Math.max(yLow, sp.archY + ra + 0.03) : yLow, y1: top, nu: 1, nv: 6, off: 0.0015 });
  }
  if (zDr > zRA + ra + 0.03) side('trim', { z0: zRA + ra + 0.02, z1: zDr, y0: sp.archY + ra + 0.02, y1: sp.archY + ra + 0.028, nu: 3, nv: 1, off: 0.0015 });
  const handle = (z) => {
    const y = F.beltAt(z) - 0.1;
    if (g1 || g1f) side('trim', { z0: z - 0.07, z1: z + 0.07, y0: y - 0.018, y1: y + 0.018, round: 0.4, nu: 6, nv: 2, off: 0.002, thick: 0.008 });
    else {
      side('trim', { z0: z - 0.085, z1: z + 0.085, y0: y - 0.03, y1: y + 0.03, round: 0.6, nu: 8, nv: 3, off: 0.0015 });
      side('paint', { z0: z - 0.075, z1: z + 0.075, y0: y - 0.016, y1: y + 0.016, round: 0.5, nu: 8, nv: 2, off: 0.002, thick: 0.012 });
    }
  };
  handle(zB + 0.12); handle(zDr + 0.12);
  // side repeater
  side('amber', { z0: zFA - 0.33, z1: zFA - 0.25, y0: sp.archY + ra + 0.09, y1: sp.archY + ra + 0.12, round: 1, nu: 6, nv: 2, off: 0.002, thick: 0.004 });
  // rub strip (gen1) / cladding (gen3)
  if (g1 || g1f) side('trim', { z0: zRA + ra + 0.05, z1: zFA - ra - 0.06, y0: 0.47, y1: 0.505, nu: 10, nv: 1, off: 0.002, thick: 0.01 });
  if (g3) {
    side('trim', { z0: zRA + ra + 0.01, z1: zFA - ra - 0.01, y0: sp.sill + 0.01, y1: sp.sill + 0.13, nu: 12, nv: 2, off: 0.004, thick: 0.014 });
    add('trim', archFlares(F));
  }

  // ---- mirrors
  for (const sg of [1, -1]) {
    const zM = zWs - 0.13, yM = F.beltAt(zM) + 0.07;
    const a = F.side(zM, yM, sg, 0);
    add(g1 ? 'trim' : 'paint', box(0.16, 0.1, 0.075, a.x + sg * 0.12, a.y + 0.03, a.z - 0.01, 0, sg * 0.12, 0, 0.03));
    add('trim', box(0.1, 0.035, 0.05, a.x + sg * 0.04, a.y, a.z, 0, 0, 0));
    add('chrome', box(0.13, 0.075, 0.006, a.x + sg * 0.125, a.y + 0.03, a.z - 0.05, 0, sg * 0.12, 0));
  }
  // wipers
  for (const w of [-0.12, 0.5]) {
    const p = F.surf(F.wy(P.wsBase[1] + 0.045), w - 0.25, 0.015), q = F.surf(F.wy(P.wsBase[1] + 0.07), w + 0.2, 0.015);
    const len = p.distanceTo(q);
    const g = new THREE.BoxGeometry(len, 0.012, 0.018);
    const dir = q.clone().sub(p).normalize();
    g.applyMatrix4(_m4.compose(p.clone().add(q).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir), _one));
    add('trim', g);
  }
  // antenna
  if (!g3) {
    const p = F.surf(F.roofS(P.wsTop[0] - 0.12), -0.42, 0);
    add('trim', place(new THREE.CylinderGeometry(0.004, 0.007, 0.32, 5), p.x, p.y + 0.14, p.z - 0.07, -0.5, 0, 0));
  }

  // ---- front end
  const fy = (y) => F.fy(y), ry = (y) => F.ry(y);
  const plateFront = (yc, off) => {
    wall('trim', { s0: fy(yc - 0.068), s1: fy(yc + 0.068), w0: -0.27, w1: 0.27, nu: 6, nv: 2, off, thick: 0.008 });
    wall('plate', { s0: fy(yc - 0.058), s1: fy(yc + 0.058), w0: -0.255, w1: 0.255, nu: 6, nv: 2, off: off + 0.0105, uv: (a, b) => [a, b] });
  };
  const plateRear = (yc, off) => {
    wall('trim', { s0: ry(yc + 0.068), s1: ry(yc - 0.068), w0: -0.27, w1: 0.27, nu: 6, nv: 2, off, thick: 0.008 });
    wall('plate', { s0: ry(yc + 0.058), s1: ry(yc - 0.058), w0: -0.255, w1: 0.255, nu: 6, nv: 2, off: off + 0.0105, uv: (a, b) => [1 - a, 1 - b] });
  };
  const badgeF = (y, off = 0.008) => wall('chrome', { s0: fy(y - 0.035), s1: fy(y + 0.035), w0: -0.042, w1: 0.042, round: 1, nu: 10, nv: 2, off, thick: 0.006 });
  const badgeR = (y, off = 0.004) => wall('chrome', { s0: ry(y + 0.035), s1: ry(y - 0.035), w0: -0.042, w1: 0.042, round: 1, nu: 10, nv: 2, off, thick: 0.006 });
  const shutF = (y) => wall('trim', { s0: fy(y - 0.004), s1: fy(y + 0.004), w0: -(WE + 0.02), w1: WE + 0.02, nu: 24, nv: 1, off: 0.0015 });
  const shutR = (y) => wall('trim', { s0: ry(y + 0.004), s1: ry(y - 0.004), w0: -(WE + 0.02), w1: WE + 0.02, nu: 24, nv: 1, off: 0.0015 });

  if (g1 || g1f) {
    const lr = g1 ? 0.12 : 0.4;
    if (g1) {
      wall('trim', { s0: fy(0.265), s1: fy(0.48), w0: -(WE + 0.2), w1: WE + 0.2, nu: 26, nv: 3, off: 0, thick: 0.028, capN: [1, 0] });
      wall('trim', { s0: fy(0.555), s1: fy(0.665), w0: -0.33, w1: 0.33, nu: 6, nv: 2, off: 0.003 });
      for (const y of [0.59, 0.63]) wall('chrome', { s0: fy(y - 0.006), s1: fy(y + 0.006), w0: -0.31, w1: 0.31, nu: 6, nv: 1, off: 0.006 });
      plateFront(0.375, 0.03);
    } else {
      shutF(0.485);
      wall('trim', { s0: fy(0.27), s1: fy(0.335), w0: -0.44, w1: 0.44, round: 0.5, nu: 14, nv: 3, off: 0.003 });
      wall('trim', { s0: fy(0.55), s1: fy(0.67), w0: -0.3, w1: 0.3, round: 0.55, nu: 12, nv: 3, off: 0.003 });
      wall('chrome', { s0: fy(0.603), s1: fy(0.617), w0: -0.285, w1: 0.285, nu: 8, nv: 1, off: 0.006 });
      plateFront(0.41, 0.004);
    }
    badgeF(0.61);
    wall('chrome', { s0: fy(0.522), s1: fy(0.688), w0: 0.345, w1: 0.695, round: lr, nu: 10, nv: 4, off: 0.002, thick: 0.005, mirror: true });
    wall('lamp', { s0: fy(0.535), s1: fy(0.675), w0: 0.36, w1: 0.68, round: lr, nu: 10, nv: 4, off: 0.007, thick: 0.004, mirror: true });
    wall('amber', { s0: fy(0.54), s1: fy(0.67), w0: 0.7, w1: WE + 0.05, nu: 5, nv: 3, off: 0.004, thick: 0.004, mirror: true });
  } else if (g2) {
    const fl = sp.facelift;
    shutF(0.505);
    wall('trim', { s0: (a) => fy(0.548 + 0.07 * a * a), s1: fy(0.712), w0: 0.255, w1: WE + 0.34, round: 0.25, nu: 16, nv: 4, off: 0.002, thick: 0.004, mirror: true, capN: [0.99, -0.12] });
    wall('lamp', { s0: (a) => fy(0.56 + 0.07 * a * a), s1: fy(0.7), w0: 0.27, w1: WE + 0.32, round: 0.25, nu: 16, nv: 4, off: 0.006, thick: 0.004, mirror: true, capN: [0.99, -0.12] });
    wall('chrome', { s0: (a) => fy(0.585 + 0.07 * a * a), s1: fy(0.65), w0: 0.42, w1: 0.56, round: 0.8, nu: 8, nv: 3, off: 0.0115, mirror: true });
    wall('trim', { s0: fy(fl ? 0.58 : 0.6), s1: fy(fl ? 0.7 : 0.685), w0: -(fl ? 0.25 : 0.23), w1: fl ? 0.25 : 0.23, round: 0.35, nu: 10, nv: 3, off: 0.003 });
    if (fl) wall('chrome', { s0: fy(0.636), s1: fy(0.648), w0: -0.24, w1: 0.24, nu: 6, nv: 1, off: 0.006 });
    badgeF(0.642);
    if (fl) {
      wall('trim', { s0: fy(0.275), s1: fy(0.43), w0: -0.52, w1: 0.52, round: 0.5, nu: 16, nv: 4, off: 0.002, thick: 0.006 });
      wall('lamp', { s0: fy(0.32), s1: fy(0.38), w0: 0.58, w1: 0.68, round: 1, nu: 8, nv: 2, off: 0.003, thick: 0.004, mirror: true });
      plateFront(0.485, 0.004);
    } else {
      wall('trim', { s0: fy(0.295), s1: fy(0.39), w0: -0.44, w1: 0.44, round: 0.7, nu: 16, nv: 3, off: 0.002, thick: 0.004 });
      plateFront(0.465, 0.004);
    }
  } else { // gen3
    wall('trim', { s0: (a) => fy(0.645 + 0.05 * a), s1: fy(0.815), w0: 0.315, w1: WE + 0.26, round: 0.3, nu: 16, nv: 5, off: 0.002, thick: 0.004, mirror: true, capN: [0.99, -0.12] });
    wall('lamp', { s0: (a) => fy(0.66 + 0.05 * a), s1: fy(0.8), w0: 0.33, w1: WE + 0.24, round: 0.3, nu: 16, nv: 5, off: 0.006, thick: 0.004, mirror: true, capN: [0.99, -0.12] });
    wall('chrome', { s0: (a) => fy(0.69 + 0.05 * a), s1: fy(0.76), w0: 0.46, w1: 0.62, round: 0.9, nu: 8, nv: 3, off: 0.0115, mirror: true });
    wall('trim', { s0: fy(0.34), s1: fy(0.63), w0: -0.47, w1: 0.47, round: 0.25, nu: 14, nv: 6, off: 0.003, thick: 0.01 });
    wall('chrome', { s0: fy(0.598), s1: fy(0.61), w0: -0.42, w1: 0.42, nu: 8, nv: 1, off: 0.0145 });
    wall('trim', { s0: fy(0.255), s1: fy(0.33), w0: -(WE + 0.12), w1: WE + 0.12, nu: 26, nv: 2, off: 0.002, thick: 0.014, capN: [1, 0] });
    wall('amber', { s0: fy(0.36), s1: fy(0.42), w0: 0.54, w1: 0.66, round: 0.6, nu: 8, nv: 2, off: 0.003, thick: 0.004, mirror: true });
    badgeF(0.555, 0.015);
    plateFront(0.43, 0.013);
  }

  // ---- rear end
  if (g1 || g1f) {
    if (g1) wall('trim', { s0: ry(0.5), s1: ry(0.27), w0: -(WE + 0.18), w1: WE + 0.18, nu: 26, nv: 3, off: 0, thick: 0.028, capN: [-1, 0] });
    else { shutR(0.52); wall('trim', { s0: ry(0.33), s1: ry(0.27), w0: -(WE + 0.1), w1: WE + 0.1, nu: 22, nv: 1, off: 0.002, thick: 0.008, capN: [-1, 0] }); }
    wall('tail', { s0: ry(0.9), s1: ry(0.68), w0: 0.48, w1: WE + 0.05, round: g1 ? 0.1 : 0.25, nu: 6, nv: 4, off: 0.005, thick: 0.008, mirror: true, capN: [-1, 0] });
    wall('amber', { s0: ry(0.68), s1: ry(0.61), w0: 0.48, w1: WE + 0.05, nu: 6, nv: 2, off: 0.005, thick: 0.008, mirror: true, capN: [-1, 0] });
    wall('chrome', { s0: ry(0.79), s1: ry(0.775), w0: -0.2, w1: 0.2, nu: 4, nv: 1, off: 0.004, thick: 0.006 });
    plateRear(0.67, 0.003);
    badgeR(0.84);
  } else if (g2) {
    shutR(0.55);
    wall('trim', { s0: (a) => ry(1.0 - 0.02 * a), s1: ry(0.62), w0: 0.455, w1: WE + 0.15, round: 0.3, nu: 10, nv: 5, off: 0.002, thick: 0.004, mirror: true });
    wall('tail', { s0: (a) => ry(0.985 - 0.02 * a), s1: ry(0.635), w0: 0.47, w1: WE + 0.14, round: 0.3, nu: 10, nv: 5, off: 0.006, thick: 0.006, mirror: true });
    wall('amber', { s0: ry(0.75), s1: ry(0.71), w0: 0.5, w1: WE + 0.1, nu: 8, nv: 1, off: 0.0125, mirror: true, capN: [-1, 0] });
    wall('trim', { s0: ry(0.36), s1: ry(0.275), w0: -(WE + 0.05), w1: WE + 0.05, nu: 22, nv: 2, off: 0.002, thick: 0.01, capN: [-1, 0] });
    wall('tail', { s0: ry(0.46), s1: ry(0.43), w0: 0.55, w1: 0.68, nu: 4, nv: 1, off: 0.003, mirror: true });
    wall('chrome', { s0: ry(0.82), s1: ry(0.805), w0: -0.24, w1: 0.24, nu: 4, nv: 1, off: 0.004, thick: 0.006 });
    plateRear(0.69, 0.003);
    badgeR(0.87);
  } else {
    wall('trim', { s0: ry(1.075), s1: ry(0.655), w0: 0.445, w1: WE + 0.13, round: 0.3, nu: 10, nv: 6, off: 0.002, thick: 0.004, mirror: true });
    wall('tail', { s0: ry(1.06), s1: ry(0.67), w0: 0.46, w1: WE + 0.12, round: 0.3, nu: 10, nv: 6, off: 0.006, thick: 0.006, mirror: true });
    wall('chrome', { s0: ry(0.9), s1: ry(0.82), w0: 0.5, w1: 0.62, round: 0.8, nu: 6, nv: 3, off: 0.0125, mirror: true });
    wall('trim', { s0: ry(0.4), s1: ry(0.28), w0: -(WE + 0.08), w1: WE + 0.08, nu: 26, nv: 2, off: 0.002, thick: 0.014, capN: [-1, 0] });
    wall('trim', { s0: ry(0.8), s1: ry(0.785), w0: -0.42, w1: 0.42, nu: 6, nv: 1, off: 0.003, thick: 0.004 });
    shutR(0.6);
    plateRear(0.49, 0.003);
    badgeR(0.88);
  }

  // ---- underbody, arch liners, exhaust
  add('trim', box(1.06, 0.44, zFA - zRA + 2 * ra - 0.1, 0, 0.38, (zFA + zRA) / 2));
  add('trim', archLiners(F));
  const ex = { x: -0.42, y: 0.205, z: sp.zR - 0.035 };
  add('chrome', place(new THREE.CylinderGeometry(0.03, 0.03, 0.22, 12, 1, true), ex.x, ex.y, ex.z + 0.11, PI / 2, 0, 0));
  add('trim', place(new THREE.CircleGeometry(0.029, 12), ex.x, ex.y, ex.z + 0.01, 0, PI, 0));

  // ---- interior (visible through the glass)
  const yb = F.beltAt(zB), zDash = zWs - 0.06, zBack = zHb + 0.14;
  add('interior', box(2 * (hd - 0.06), yb - 0.34, zDash - zBack, 0, (yb + 0.32) / 2 - 0.01, (zDash + zBack) / 2));
  const zRoofF = P.wsTop[0] - 0.05, zRoofR = P.roofRear[0] + 0.08;
  add('interior', box(2 * ((hd + bt) * sp.roofScale - 0.08), 0.02, zRoofF - zRoofR, 0, H - 0.08, (zRoofF + zRoofR) / 2));
  add('interior', box(2 * (hd - 0.08), 0.12, 0.3, 0, yb + 0.02, zDash - 0.2));
  for (const x of [-0.31, 0.31]) {
    add('interior', box(0.44, 0.5, 0.11, x, yb + 0.03, zB - 0.12, -0.12, 0, 0));
    add('interior', box(0.25, 0.15, 0.09, x, yb + 0.35, zB - 0.17, -0.12, 0, 0));
  }
  const zRs = lerp(zB, zBack, 0.7);
  add('interior', box(1.12, 0.46, 0.11, 0, yb + 0.02, zRs, -0.15, 0, 0));
  for (const x of [-0.33, 0.33]) add('interior', box(0.24, 0.14, 0.09, x, yb + 0.31, zRs - 0.05, -0.15, 0, 0));
  add('trim', place(new THREE.TorusGeometry(0.16, 0.02, 6, 18), -0.33, yb + 0.12, zDash - 0.4, -0.45, 0, 0));

  // ---- merge buckets
  const geos = {};
  for (const k in B) geos[k] = merge(B[k], k === 'plate');

  // layout info
  const roofZ = P.roofRear[0] + 0.14;
  const roofTop = F.surf(F.roofS(roofZ), 0, 0);
  const roofMid = F.surf(F.roofS((P.wsTop[0] + P.roofRear[0]) / 2), 0, 0);
  const info = {
    sp, F,
    wheels: [[0.63, zFA], [-0.63, zFA], [0.63, zRA], [-0.63, zRA]],
    exhaust: [ex.x, ex.y, ex.z - 0.02],
    roofTop, roofMid,
    roofHalf: (hd + bt) * sp.roofScale,
    zB, zDr, zDf,
  };
  return { geos, info, stickers: {} };
}

// closed bevelled shell from the profile
function buildShell(F) {
  const ol = F.ol, n = ol.n, { hd, bt, bs } = F, sp = F.sp;
  const SEG = 3, STEPS = 5;
  const rings = [];
  for (let k = 0; k <= SEG; k++) { const psi = (PI / 2) * (1 - k / SEG); rings.push([hd + bt * Math.sin(psi), bs * (1 - Math.cos(psi))]); }
  for (let k = 1; k < STEPS; k++) rings.push([hd - (2 * hd * k) / STEPS, 0]);
  for (let k = 0; k <= SEG; k++) { const psi = (PI / 2) * (k / SEG); rings.push([-(hd + bt * Math.sin(psi)), bs * (1 - Math.cos(psi))]); }
  const R = rings.length, pos = [], idx = [];
  for (let i = 0; i < n; i++) {
    const p = ol.p[i], mt = ol.mt[i];
    for (let r = 0; r < R; r++) {
      const [x, ins] = rings[r];
      const v = F.deform(x, p[1] - mt[1] * ins, p[0] - mt[0] * ins);
      pos.push(v.x, v.y, v.z);
    }
  }
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    for (let r = 0; r < R - 1; r++) {
      const a = i * R + r, b = i2 * R + r, c = b + 1, d = a + 1;
      idx.push(a, b, c, a, c, d);
    }
  }
  // orientation: roof quad must face up
  let iTop = 0;
  for (let i = 0; i < n; i++) if (ol.p[i][1] > ol.p[iTop][1]) iTop = i;
  {
    const r = R >> 1, a = iTop * R + r, b = ((iTop + 1) % n) * R + r, c = b + 1;
    const v = (k) => new THREE.Vector3(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]);
    if (triNormal(v(a), v(b), v(c)).y < 0) flipIndex(idx);
  }
  const walls = indexedGeo(pos, idx);
  // caps
  const contour = ol.p.map((p, i) => [p[0] - ol.mt[i][0] * bs, p[1] - ol.mt[i][1] * bs]);
  const extra = [];
  for (let z = sp.zR + 0.05; z < sp.zF; z += 0.09) extra.push([z, F.beltAt(z) + 0.002]);
  const { verts, faces } = triangulate(contour, 0.11, extra);
  const caps = [walls];
  for (const sg of [1, -1]) {
    const cp = [], ci = [];
    for (const v of verts) { const q = F.deform(sg * (hd + bt), v[1], v[0]); cp.push(q.x, q.y, q.z); }
    for (const f of faces) ci.push(f[0], f[1], f[2]);
    orient(cp, ci, () => new THREE.Vector3(sg, 0, 0));
    caps.push(indexedGeo(cp, ci));
  }
  return caps;
}

function archLiners(F) {
  const sp = F.sp, out = [];
  const d = (sp.archY - sp.sill) / sp.ra, a0 = PI + Math.asin(d), a1 = -Math.asin(d), N = 12, r = sp.ra - 0.006;
  for (const zc of [sp.zFA, sp.zRA]) for (const sg of [1, -1]) {
    const pos = [], idx = [];
    const xs = [sg * 0.52, sg * (F.hd + F.bt - 0.015)];
    for (let k = 0; k <= N; k++) {
      const a = lerp(a0, a1, k / N);
      for (const x of xs) { const v = F.deform(x, sp.archY + r * Math.sin(a), zc + r * Math.cos(a)); pos.push(v.x, v.y, v.z); }
    }
    for (let k = 0; k < N; k++) { const a = k * 2; idx.push(a, a + 2, a + 3, a, a + 3, a + 1); }
    orient(pos, idx, (p) => new THREE.Vector3(0, sp.archY - p.y, zc - p.z));
    out.push(indexedGeo(pos, idx));
  }
  return out;
}

function archFlares(F) {
  const sp = F.sp, out = [];
  const d = (sp.archY - sp.sill) / sp.ra;
  const a0 = PI + Math.asin(d) - 0.02, a1 = -Math.asin(d) + 0.02;
  const r0 = sp.ra - 0.01, r1 = sp.ra + 0.075;
  for (const zc of [sp.zFA, sp.zRA]) {
    const sh = new THREE.Shape();
    sh.absarc(0, 0, r1, a1, a0, false);
    sh.absarc(0, 0, r0, a0, a1, true);
    const g = new THREE.ExtrudeGeometry(sh, { depth: 0.035, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 1, curveSegments: 7 });
    for (const sg of [1, -1]) {
      const c = g.clone(), p = c.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const u = p.getX(i), v = p.getY(i), w = p.getZ(i);
        const q = F.deform(sg * (F.hd + F.bt - 0.03 + w), sp.archY + v, zc + u);
        p.setXYZ(i, q.x, q.y, q.z);
      }
      if (sg > 0) { // mapping (u,v,w)->(w,v,u) mirrors: flip winding
        const arr = p.array;
        for (let i = 0; i < p.count; i += 3) for (let k = 0; k < 3; k++) { const t = arr[(i + 1) * 3 + k]; arr[(i + 1) * 3 + k] = arr[(i + 2) * 3 + k]; arr[(i + 2) * 3 + k] = t; }
      }
      c.deleteAttribute('normal'); c.deleteAttribute('uv');
      out.push(toCreasedNormals(c, 0.7));
    }
    g.dispose();
  }
  return out;
}

// ---------------------------------------------------------------- shared wheel / accessory geometry
const tyreGeo = () => once(GEO, 'tyre', () => {
  const prof = [[0.168, -0.066], [0.232, -0.077], [0.266, -0.075], [0.283, -0.064], [0.29, -0.04], [0.291, 0], [0.29, 0.04], [0.283, 0.064], [0.266, 0.075], [0.232, 0.077], [0.168, 0.066]];
  const lathe = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 24);
  lathe.rotateZ(-PI / 2);
  const disc = new THREE.CircleGeometry(0.2, 16); disc.rotateY(PI / 2); disc.translate(-0.01, 0, 0);
  const disc2 = new THREE.CircleGeometry(0.2, 16); disc2.rotateY(-PI / 2); disc2.translate(-0.05, 0, 0);
  return merge([lathe, disc, disc2]);
});
const rimGeo = () => once(GEO, 'rim', () => {
  const R = 0.17, arcPts = (r, a0, a1, n) => Array.from({ length: n + 1 }, (_, k) => {
    const a = lerp(a0, a1, k / n); return new THREE.Vector2(r * Math.cos(a), r * Math.sin(a));
  });
  const sh = new THREE.Shape(arcPts(R, 0, 2 * PI, 30).slice(0, 30));
  for (let i = 0; i < 5; i++) {
    const a0 = (i * 2 * PI) / 5, a1 = ((i + 1) * 2 * PI) / 5;
    sh.holes.push(new THREE.Path([...arcPts(0.142, a0 + 0.22, a1 - 0.22, 4), ...arcPts(0.07, a1 - 0.45, a0 + 0.45, 2)]));
  }
  const g = new THREE.ExtrudeGeometry(sh, { depth: 0.02, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.006, bevelSegments: 1, curveSegments: 1 });
  g.rotateY(PI / 2); g.translate(0.03, 0, 0);
  const hub = new THREE.CylinderGeometry(0.042, 0.055, 0.03, 10, 1); hub.rotateZ(-PI / 2); hub.translate(0.065, 0, 0);
  const m = merge([g, hub]);
  m.computeVertexNormals();
  return m;
});
const lipGeo = (width) => once(GEO, `lip:${width.toFixed(2)}`, () => {
  const s = new THREE.Shape();
  s.moveTo(0.08, -0.004); s.lineTo(-0.1, -0.004);
  s.quadraticCurveTo(-0.2, 0.0, -0.25, 0.045); s.lineTo(-0.215, 0.055);
  s.quadraticCurveTo(-0.1, 0.034, 0.08, 0.018); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: width - 0.02, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.008, bevelSegments: 2, curveSegments: 8 });
  g.translate(0, 0, -(width - 0.02) / 2); g.rotateY(-PI / 2);
  return toCreasedNormals(g.toNonIndexed(), 0.6);
});
const wingGeo = () => once(GEO, 'wing', () => {
  const s = new THREE.Shape();
  s.moveTo(0.17, 0); s.quadraticCurveTo(0.16, 0.036, 0.05, 0.04); s.quadraticCurveTo(-0.08, 0.036, -0.17, 0.016);
  s.lineTo(-0.17, 0.004); s.quadraticCurveTo(0.0, -0.012, 0.17, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: 1.3, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.004, bevelSegments: 1, curveSegments: 10 });
  g.translate(0, 0, -0.65); g.rotateY(-PI / 2); g.rotateX(0.1);
  return toCreasedNormals(g.toNonIndexed(), 0.6);
});
const wingStandGeo = () => once(GEO, 'wingStand', () => merge([
  box(0.026, 0.2, 0.09, 0.42, -0.1, 0.0, 0.25, 0, 0), box(0.026, 0.2, 0.09, -0.42, -0.1, 0.0, 0.25, 0, 0),
  box(0.016, 0.14, 0.4, 0.66, 0.0, -0.01, 0.1, 0, 0, 0.006), box(0.016, 0.14, 0.4, -0.66, 0.0, -0.01, 0.1, 0, 0, 0.006),
]));
const glowGeo = (L, W) => once(GEO, `glow:${L}:${W}`, () => { const g = new THREE.PlaneGeometry(W * 1.35, L * 1.12); g.rotateX(-PI / 2); return g; });
const haloGeo = () => once(GEO, 'halo', () => { const g = new THREE.TorusGeometry(0.34, 0.032, 10, 48); g.rotateX(PI / 2); return g; });
const haloGlowGeo = () => once(GEO, 'haloGlow', () => { const g = new THREE.RingGeometry(0.2, 0.55, 48, 1); g.rotateX(-PI / 2); return g; });

// ---------------------------------------------------------------- textures
function canvasTex(w, h, draw, key) {
  const make = () => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  };
  return key ? once(TEX, key, make) : make();
}
const glowTex = () => canvasTex(128, 128, (g, w, h) => {
  const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.45, 'rgba(255,255,255,0.75)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
}, 'glow');
const haloTex = () => canvasTex(128, 128, (g, w, h) => {
  const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  gr.addColorStop(0.36, 'rgba(255,255,255,0)'); gr.addColorStop(0.62, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
}, 'haloGlow');

function drawPlate(ctx, text) {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#f7f7f2';
  const r = 10;
  ctx.beginPath(); ctx.roundRect ? ctx.roundRect(4, 4, w - 8, h - 8, r) : ctx.rect(4, 4, w - 8, h - 8); ctx.fill();
  ctx.strokeStyle = '#111'; ctx.lineWidth = 3; ctx.strokeRect(10, 10, w - 20, h - 20);
  // HSRP style "IND" strip
  ctx.fillStyle = '#1d4fa8'; ctx.font = 'bold 18px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.save(); ctx.translate(30, h / 2); ctx.fillText('IND', 0, 14);
  ctx.beginPath(); ctx.arc(0, -14, 9, 0, 2 * PI); ctx.strokeStyle = '#1d4fa8'; ctx.lineWidth = 2; ctx.stroke(); ctx.restore();
  ctx.fillStyle = '#111';
  let fs = 80;
  ctx.font = `bold ${fs}px "Arial Narrow", Arial, sans-serif`;
  const maxW = w - 80, mw = ctx.measureText(text).width;
  if (mw > maxW) { fs = Math.floor((fs * maxW) / mw); ctx.font = `bold ${fs}px "Arial Narrow", Arial, sans-serif`; }
  ctx.fillText(text, w / 2 + 22, h / 2 + 4);
}

function stickerTex(type) {
  if (type === 'stripes') return canvasTex(64, 4, (g, w, h) => { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.clearRect(Math.round(w * 0.8), 0, 4, h); }, 'st:stripes');
  if (type === 'flames') return canvasTex(512, 128, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, w, 0);
    gr.addColorStop(0, '#fff26b'); gr.addColorStop(0.35, '#ffb000'); gr.addColorStop(0.7, '#ff5a00'); gr.addColorStop(1, '#c41600');
    g.fillStyle = gr; g.strokeStyle = '#6e0a00'; g.lineWidth = 5; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(0, h * 0.06);
    const tongues = [[0.92, 0.18], [0.62, 0.34], [0.98, 0.5], [0.7, 0.66], [0.86, 0.82]];
    let y = h * 0.06;
    for (const [len, ty] of tongues) {
      const tip = w * len, yt = h * ty;
      g.bezierCurveTo(w * 0.25, y, tip * 0.6, yt - h * 0.12, tip, yt - h * 0.05);
      g.bezierCurveTo(tip * 0.7, yt + h * 0.02, w * 0.3, yt + h * 0.04, w * 0.22, yt + h * 0.08);
      y = yt + h * 0.08;
    }
    g.bezierCurveTo(w * 0.2, h * 0.95, w * 0.1, h * 0.95, 0, h * 0.94);
    g.closePath(); g.fill(); g.stroke();
  }, 'st:flames');
  const text = (str, key, font, fill1, fill2, stroke, w = 1024, h = 160) => canvasTex(w, h, (g) => {
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const fs = h * 0.7; g.font = `${font} ${fs}px Impact, "Arial Black", sans-serif`;
    const mw = g.measureText(str).width, sx = Math.min(1.7, (w * 0.92) / mw);
    g.translate(w / 2, h / 2 + 4); g.scale(sx, 1);
    const gr = g.createLinearGradient(0, -h * 0.3, 0, h * 0.3); gr.addColorStop(0, fill1); gr.addColorStop(1, fill2);
    g.lineJoin = 'round'; g.lineWidth = fs * 0.14; g.strokeStyle = stroke; g.strokeText(str, 0, 0);
    g.lineWidth = fs * 0.045; g.strokeStyle = '#fff'; g.strokeText(str, 0, 0);
    g.fillStyle = gr; g.fillText(str, 0, 0);
  }, key);
  if (type === 'jai_mataji') return text('JAI MATAJI', 'st:jai', 'bold', '#fff36b', '#ff7a00', '#a3000f', 1024, 160);
  if (type === 'baroda') return text('BARODA No.1', 'st:baroda', 'italic bold', '#ffd84a', '#ff9933', '#1d1747', 1024, 170);
  return null;
}

// ---------------------------------------------------------------- materials
const paintMat = (hex, legend) => once(MAT, `paint:${hex}:${legend ? 1 : 0}`, () => new THREE.MeshPhysicalMaterial(legend
  ? { color: hex, metalness: 1, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.04 }
  : { color: hex, metalness: 0.35, roughness: 0.42, clearcoat: 1, clearcoatRoughness: 0.06 }));
const decal = { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 };
const trimMat = () => once(MAT, 'trim', () => new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.55, metalness: 0.15, ...decal }));
const interiorMat = () => once(MAT, 'interior', () => new THREE.MeshStandardMaterial({ color: 0x36312c, roughness: 0.9, metalness: 0 }));
const chromeMat = () => once(MAT, 'chrome', () => new THREE.MeshStandardMaterial({ color: 0xe6e8ea, metalness: 1, roughness: 0.16, ...decal }));
const lampMat = () => once(MAT, 'lamp', () => new THREE.MeshStandardMaterial({ color: 0xe8eef5, emissive: 0xfff2d8, emissiveIntensity: 0.6, roughness: 0.08, metalness: 0.3, ...decal }));
const amberMat = () => once(MAT, 'amber', () => new THREE.MeshStandardMaterial({ color: 0xff9a1a, emissive: 0xff7a00, emissiveIntensity: 0.25, roughness: 0.2, metalness: 0.1, ...decal }));
const tyreMat = () => once(MAT, 'tyre', () => new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.88, metalness: 0 }));
const rimMat = (hex) => once(MAT, `rim:${hex}`, () => {
  const c = new THREE.Color(hex), dark = c.getHSL({}).l < 0.2;
  return new THREE.MeshStandardMaterial({ color: c, metalness: dark ? 0.5 : 0.85, roughness: dark ? 0.4 : 0.25 });
});
const glassMat = (tint) => {
  const t = Math.round(clamp(+tint || 0, 0, 1) * 10) / 10;
  return once(MAT, `glass:${t}`, () => new THREE.MeshStandardMaterial({
    color: new THREE.Color('#33414d').lerp(new THREE.Color('#040507'), t), roughness: 0.04, metalness: 0.35,
    transparent: true, opacity: lerp(0.45, 0.94, t), envMapIntensity: 1.4, ...decal,
  }));
};
const glowMat = (hex) => once(MAT, `glow:${hex}`, () => new THREE.MeshBasicMaterial({
  color: hex, map: glowTex(), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
}));
const haloMat = () => once(MAT, 'halo', () => new THREE.MeshBasicMaterial({ color: 0xffb81f, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
const haloGlowMat = () => once(MAT, 'haloGlow', () => new THREE.MeshBasicMaterial({ color: 0xff9a00, map: haloTex(), transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
const stickerMat = (type, paintHex) => {
  let key = type, color = 0xffffff;
  if (type === 'stripes') {
    const c = new THREE.Color(paintHex), lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; // linear
    const light = lum > 0.3;
    key = light ? 'stripes:dark' : 'stripes:light'; color = light ? 0x161616 : 0xf6f6f6;
  }
  return once(MAT, `sticker:${key}`, () => new THREE.MeshStandardMaterial({
    color, map: stickerTex(type), transparent: true, depthWrite: false, roughness: 0.35, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));
};
const BRAKE_PROTO = new THREE.MeshStandardMaterial({ color: 0x5a0006, emissive: 0xff1a1a, emissiveIntensity: 0.35, roughness: 0.25, metalness: 0.1, ...decal });

// ---------------------------------------------------------------- sticker geometry (cached per car id + type)
function stickerGeo(parts, type) {
  if (parts.stickers[type] !== undefined) return parts.stickers[type];
  const { F, sp } = parts.info, { S, P } = F, list = [];
  if (type === 'stripes') {
    const mk = (s0, s1, sg) => list.push(...gridPanel((a, b, off) => F.surf(lerp(s0, s1, b), sg * lerp(0.07, 0.22, a), off), { nu: 2, nv: 14, off: 0.009 }));
    for (const sg of [1, -1]) {
      mk(F.fy(P.nose[1] - 0.02), S.wsBase - 0.035, sg);
      mk(S.wsTop - 0.02, S.roofRear + 0.02, sg);
    }
  } else if (type === 'flames' || type === 'baroda') {
    const z0 = sp.zRA + sp.ra + (type === 'flames' ? 0.06 : 0.14), z1 = sp.zFA - sp.ra - (type === 'flames' ? 0.04 : 0.1);
    const [y0, y1] = type === 'flames' ? [0.37, F.beltAt(0) - 0.05] : [0.39, 0.39 + ((z1 - z0) * 170) / 1024];
    for (const sg of [1, -1]) {
      const uv = (a, b) => [type === 'flames' || sg > 0 ? 1 - a : a, b];
      list.push(...gridPanel((a, b, off) => F.side(lerp(z0, z1, a), lerp(y0, y1, b), sg, off), { nu: 10, nv: 3, off: 0.005, uv }));
    }
  } else if (type === 'jai_mataji') {
    const w = Math.min(0.34, Math.min(sp.rearGlassW, F.hd - 0.03) - 0.04);
    const s0 = F.ry(sp.H - 0.105), s1 = s0 + (2 * w * 160) / 1024;
    list.push(...gridPanel((a, b, off) => F.surf(lerp(s0, s1, b), lerp(-w, w, a), off), { nu: 6, nv: 2, off: 0.01, uv: (a, b) => [1 - a, 1 - b] }));
  }
  const g = list.length ? merge(list, true) : null;
  parts.stickers[type] = g;
  return g;
}

// ---------------------------------------------------------------- public API
function normMods(m) {
  const o = { ...DEFAULT_MODS, ...(m || {}) };
  if (!['none', 'lip', 'wing'].includes(o.spoiler)) o.spoiler = 'none';
  o.tint = clamp(Number.isFinite(+o.tint) ? +o.tint : DEFAULT_MODS.tint, 0, 1);
  if (typeof o.plate !== 'string' || !o.plate.trim()) o.plate = DEFAULT_MODS.plate;
  o.plate = o.plate.toUpperCase().slice(0, 16);
  if (!o.rim) o.rim = DEFAULT_MODS.rim;
  return o;
}
const noShadow = (mesh) => { Object.defineProperty(mesh, 'castShadow', { get: () => false, set: () => {} }); return mesh; };

export function buildCarModel(carId, mods) {
  const car = CARS.find((c) => c.id === carId) || CARS[0];
  const parts = getParts(car);
  const { geos, info } = parts, sp = info.sp;

  const group = new THREE.Group();
  group.name = `car:${car.id}`;
  const body = new THREE.Object3D(); body.name = 'body'; body.position.y = PIVOT_Y; group.add(body);
  const inner = new THREE.Object3D(); inner.position.y = -PIVOT_Y; body.add(inner);

  const brakeMat = BRAKE_PROTO.clone();
  const plateCanvas = document.createElement('canvas'); plateCanvas.width = 512; plateCanvas.height = 124;
  const plateTex = new THREE.CanvasTexture(plateCanvas); plateTex.colorSpace = THREE.SRGBColorSpace; plateTex.anisotropy = 4;
  const plateMat = new THREE.MeshStandardMaterial({ map: plateTex, roughness: 0.45, metalness: 0, ...decal });

  const st = { car, parts, inner, paintMeshes: [], rimMeshes: [], glass: null, brakeMat, plateCanvas, plateTex, plateMat, spoiler: [], sticker: null, glow: null, mods: {} };
  const matFor = {
    paint: () => paintMat(car.paint, sp.legend), trim: trimMat, interior: interiorMat, glass: () => glassMat(0.4), chrome: chromeMat,
    lamp: lampMat, amber: amberMat, tail: () => brakeMat, plate: () => plateMat,
  };
  for (const k of ['paint', 'interior', 'trim', 'chrome', 'lamp', 'amber', 'tail', 'plate', 'glass']) {
    if (!geos[k]) continue;
    const mesh = new THREE.Mesh(geos[k], matFor[k]());
    mesh.name = k;
    if (k === 'paint') { mesh.castShadow = true; st.paintMeshes.push(mesh); }
    if (k === 'glass') { mesh.renderOrder = 1; st.glass = mesh; }
    inner.add(mesh);
  }

  // wheels
  const wheels = [], pivots = [];
  info.wheels.forEach(([x, z], i) => {
    const pivot = new THREE.Object3D(); pivot.position.set(x, WHEEL_R, z);
    const wheel = new THREE.Object3D(); pivot.add(wheel);
    const holder = new THREE.Object3D(); if (x < 0) holder.rotation.y = PI; wheel.add(holder);
    const tyre = new THREE.Mesh(tyreGeo(), tyreMat()); tyre.castShadow = true;
    const rim = new THREE.Mesh(rimGeo(), rimMat(DEFAULT_MODS.rim));
    holder.add(tyre, rim); st.rimMeshes.push(rim);
    group.add(pivot);
    wheels.push(wheel);
    if (i < 2) pivots.push(pivot);
  });

  const exhaust = new THREE.Object3D(); exhaust.name = 'exhaust';
  exhaust.position.set(...info.exhaust); inner.add(exhaust);

  // underglow (cheap additive plane, no light)
  const glow = noShadow(new THREE.Mesh(glowGeo(sp.L, sp.W), glowMat('#ffffff')));
  glow.position.y = 0.03; glow.visible = false; glow.renderOrder = 0;
  group.add(glow); st.glow = glow;

  group.userData = { wheels, wheelPivots: pivots, body, brakeMat, exhaust, radius: WHEEL_R, carId: car.id, _alto: st };

  if (sp.legend) {
    const halo = new THREE.Object3D(); halo.name = 'halo';
    halo.position.set(0, info.roofMid.y + 0.4, info.roofMid.z);
    halo.add(noShadow(new THREE.Mesh(haloGeo(), haloMat())));
    const hg = noShadow(new THREE.Mesh(haloGlowGeo(), haloGlowMat())); hg.renderOrder = 2; halo.add(hg);
    inner.add(halo);
    group.userData.halo = halo;
  }

  applyMods(group, mods);
  return group;
}

export function applyMods(group, mods) {
  const st = group?.userData?._alto;
  if (!st) return;
  const m = normMods(mods), prev = st.mods, { car, parts, inner } = st, info = parts.info, sp = info.sp;
  const paintHex = m.paint || car.paint;

  const pm = paintMat(paintHex, sp.legend);
  for (const mesh of st.paintMeshes) mesh.material = pm;
  for (const r of st.rimMeshes) r.material = rimMat(m.rim);
  if (st.glass) st.glass.material = glassMat(m.tint);

  if (m.plate !== prev.plate) { drawPlate(st.plateCanvas.getContext('2d'), m.plate); st.plateTex.needsUpdate = true; }

  if (m.spoiler !== prev.spoiler) {
    for (const s of st.spoiler) { inner.remove(s); const i = st.paintMeshes.indexOf(s); if (i >= 0) st.paintMeshes.splice(i, 1); }
    st.spoiler = [];
    const rt = info.roofTop;
    if (m.spoiler === 'lip') {
      const s = new THREE.Mesh(lipGeo(info.roofHalf * 2 - 0.05), pm);
      s.position.set(0, rt.y - 0.012, rt.z - 0.05); s.castShadow = true;
      st.spoiler.push(s);
    } else if (m.spoiler === 'wing') {
      const w = new THREE.Mesh(wingGeo(), pm);
      w.position.set(0, rt.y + 0.19, rt.z - 0.02); w.castShadow = true;
      const stands = new THREE.Mesh(wingStandGeo(), trimMat());
      stands.position.copy(w.position);
      st.spoiler.push(w, stands);
    }
    for (const s of st.spoiler) { inner.add(s); if (s.material === pm) st.paintMeshes.push(s); }
  }

  const stickerKey = m.sticker ? `${m.sticker}:${m.sticker === 'stripes' ? stickerMat('stripes', paintHex).uuid : ''}` : null;
  if (stickerKey !== st.stickerKey) {
    if (st.sticker) { inner.remove(st.sticker); st.sticker = null; }
    const g = m.sticker ? stickerGeo(parts, m.sticker) : null;
    if (g) {
      st.sticker = new THREE.Mesh(g, stickerMat(m.sticker, paintHex));
      st.sticker.renderOrder = 3;
      inner.add(st.sticker);
    }
    st.stickerKey = stickerKey;
  }

  if (m.underglow) { st.glow.material = glowMat(m.underglow); st.glow.visible = true; }
  else st.glow.visible = false;

  st.mods = m;
}

export function disposeCarModel(group) {
  const st = group?.userData?._alto;
  if (!st || st.disposed) return;
  st.brakeMat.dispose();
  st.plateTex.dispose();
  st.plateMat.dispose();
  st.disposed = true;
}
