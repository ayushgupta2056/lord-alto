// Hero models of Vadodara's landmarks. Installed onto World.prototype (see world.js), so "this" is the World:
// it provides the merge builder (this.B), template geometry (this.G), the per-track sign atlas (this.atlas),
// the facade/streetscape generator (this.SS) and helpers such as box/cyl/onion/chhatri/sign/treeLocal.
// Indo-Saracenic arcades are real extruded walls with pointed-arch holes, trimmed with contrasting voussoirs.
//
// ---------------------------------------------------------------- LANDMARK BUILDER CONVENTION
// Built-in builders are World methods named _lm_<id>(lm). External builders (e.g. photoLandmarks.js) are called as
//   buildPhotoLandmark(id, ctx)  ->  optional THREE.Object3D (added to the world if it has no parent), or nothing
// with ctx = landmarkContext(world, lm) (defined at the bottom of this file):
//   ctx.THREE, ctx.world, ctx.track, ctx.lm ({ id, index, side: -1 left | 1 right of travel, label }) -- index/side may be changed
//   ctx.hw              road half width (m). Keep everything outside lateral hw + 5.4 (the strip up to hw + 4.8 is drivable).
//   ctx.place(W, D, setback = 6.6) -> { m, ry, cx, cz } reserves a W (along road) x D (away from road) footprint beside
//                       lm.index (tries lm.side first) and makes it the CURRENT FRAME: origin = footprint centre on the
//                       ground, local +Z points to the road, +X runs along the road, metres. (May shrink to 0.85/0.72.)
//   ctx.frameSide(i, side, lateral) -> same kind of frame at any track sample (does not reserve space)
//   ctx.useFrame(f)     make f the current frame (f from place/frameSide);  ctx.toWorld(x, y, z) -> THREE.Vector3
//   ctx.box(bucket, x, yBottom, z, w, h, d, color, ry)  ctx.cyl(bucket, x, y, z, r, h, color, seg, rTop)
//   ctx.sphere(bucket, x, y, z, r, color, sy, sx)       ctx.cylBetween(bucket, ax, ay, az, bx, by, bz, r, color)
//   ctx.arcade / ctx.domeL / ctx.chhatri / ctx.kanguras / ctx.balustrade / ctx.pinnacle  (Indo-Saracenic kit, see below)
//                       buckets: 'std' matte, 'gloss', 'metal' (gold), 'alu', 'glass', 'glow' (unlit), 'water';
//                       all of these are merged into one draw call per bucket per landmark (cheap: use freely).
//   ctx.atlas.add(key, w, h, draw(g, w, h)) -> uv rect in the per-track 2048 sign atlas (canvas 2D drawing)
//   ctx.sign(x, yCentre, z, w, h, rect, ry = 0, bucket = 'sign')  textured quad facing local +Z (rotated by ry);
//                       'sign' glows at night, 'deco' is for painted facades/photos (glows faintly)
//   ctx.tree(x, z, type = 'neem'|'ashoka'|'banyan'|'bush'|'palm', size = 1)  in the current frame
//   ctx.add(object3D, { cast = true, receive = true })   add a custom mesh (its geometry/material are disposed on reload)
//   ctx.track(disposable) register a texture/geometry for disposal;  ctx.texture(canvas) -> CanvasTexture (tracked)
//   ctx.materials       shared materials { std, gloss, metal, alu, glass, glow, water, sign, deco, veg, prop }
//   ctx.timeOfDay ('day'|'sunset'|'night'), ctx.weather ('clear'|'rain'), ctx.lightsOn (bool), ctx.rnd() deterministic
//   ctx.lights(x0, y0, z0, x1, y1, z1, n, color)  a row of fairy lights (night only) in the current frame
import * as THREE from 'three';
import { TAU, FONT, FONT2, FONT_GU, FONT_HI, FONT_SERIF, fitText, roundRect, L, shade } from './buildings.js';

// ---------------------------------------------------------------- cached geometry (shared by all tracks)
const GEO = new Map();
const cached = (key, make) => { let g = GEO.get(key); if (!g) { g = make(); GEO.set(key, g); } return g; };

// points of an arch: from (x0,yb) up the left jamb, over the crown, down to (x0+aw,yb)
function archPts(x0, yb, aw, ah, pointed = 0.35, seg = 12) {
  const r = aw / 2;
  let hc = r * (1 + 0.3 * pointed);
  let ys = yb + ah - hc;
  if (ys < yb + ah * 0.32) { ys = yb + ah * 0.32; hc = yb + ah - ys; } // squashed (segmental) arch
  const pts = [[x0, yb]];
  for (let k = 0; k <= seg; k++) {
    const t = k / seg, u = Math.abs(2 * t - 1);
    pts.push([x0 + aw * t, ys + hc * (Math.sqrt(Math.max(0, 1 - u * u)) * (1 - pointed) + pointed * (1 - u))]);
  }
  pts.push([x0 + aw, yb]);
  return pts;
}
const V2 = (p) => new THREE.Vector2(p[0], p[1]);
function arcadeGeo(w, h, n, sill, frac, pointed, depth, pier) {
  return cached(`arc${w.toFixed(2)}_${h.toFixed(2)}_${n}_${sill}_${frac}_${pointed}_${depth}_${pier}`, () => {
    const sh = new THREE.Shape();
    sh.moveTo(-w / 2, -0.3); sh.lineTo(w / 2, -0.3); sh.lineTo(w / 2, h); sh.lineTo(-w / 2, h); sh.closePath();
    const bw = w / n, aw = bw * (1 - pier);
    for (let i = 0; i < n; i++) {
      const x0 = -w / 2 + i * bw + (bw - aw) / 2;
      const pts = archPts(x0, Math.max(sill, -0.2), aw, (h - sill) * frac, pointed);
      sh.holes.push(new THREE.Path(pts.map(V2)));
    }
    const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false, curveSegments: 1 });
    g.translate(0, 0, -depth);
    return g;
  });
}
function ringGeo(w, h, n, sill, frac, pointed, pier, t) {
  return cached(`ring${w.toFixed(2)}_${h.toFixed(2)}_${n}_${sill}_${frac}_${pointed}_${pier}_${t}`, () => {
    const shapes = [];
    const bw = w / n, aw = bw * (1 - pier);
    for (let i = 0; i < n; i++) {
      const x0 = -w / 2 + i * bw + (bw - aw) / 2, ah = (h - sill) * frac, yb = Math.max(sill, -0.2);
      const outer = archPts(x0 - t, yb, aw + 2 * t, ah + t, pointed);
      const inner = archPts(x0, yb, aw, ah, pointed).reverse();
      const sh = new THREE.Shape([...outer, ...inner].map(V2));
      shapes.push(sh);
    }
    const g = new THREE.ExtrudeGeometry(shapes, { depth: 0.14, bevelEnabled: false, curveSegments: 1 });
    return g;
  });
}
function archPanelGeo(aw, ah, pointed) {
  return cached(`panel${aw}_${ah}_${pointed}`, () => new THREE.ShapeGeometry(new THREE.Shape(archPts(-aw / 2, 0, aw, ah, pointed).map(V2))));
}
const LATHE = {
  onion: [[0.78, 0], [0.98, 0.12], [1.06, 0.3], [0.96, 0.5], [0.7, 0.68], [0.38, 0.84], [0.12, 0.95], [0.0, 1.0]],
  gumbaz: [[1, 0], [1.0, 0.1], [0.98, 0.28], [0.92, 0.48], [0.8, 0.66], [0.6, 0.83], [0.33, 0.95], [0, 1]],
  bulb: [[0.62, 0], [0.9, 0.1], [1.04, 0.28], [1.0, 0.46], [0.82, 0.64], [0.52, 0.8], [0.24, 0.92], [0.06, 0.98], [0, 1]],
  shikhara: [[1, 0], [0.99, 0.18], [0.94, 0.4], [0.84, 0.6], [0.68, 0.78], [0.48, 0.92], [0.36, 1]],
  amalaka: [[0, 0], [0.9, 0.05], [1, 0.5], [0.9, 0.95], [0, 1]],
  fountain: [[0, 0], [1, 0], [1, 0.25], [0.88, 0.3], [0.85, 0.12], [0, 0.12]],
};
function lathe(name, seg = 16) {
  return cached(`lathe_${name}_${seg}`, () => new THREE.LatheGeometry(LATHE[name].map(V2), seg));
}
function geodesicHalf(detail = 2) {
  return cached('geo' + detail, () => {
    const ico = new THREE.IcosahedronGeometry(1, detail).toNonIndexed();
    const p = ico.attributes.position, keep = [];
    for (let i = 0; i < p.count; i += 3) {
      const cy = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3;
      if (cy > -0.08) for (let k = 0; k < 3; k++) keep.push(p.getX(i + k), Math.max(p.getY(i + k), -0.02), p.getZ(i + k));
    }
    ico.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(keep, 3));
    g.computeVertexNormals();
    return g;
  });
}
function flipped(g) {
  const f = g.index ? g.toNonIndexed() : g.clone();
  const p = f.attributes.position.array, n = f.attributes.normal?.array;
  for (let i = 0; i < p.length; i += 9) {
    for (let k = 0; k < 3; k++) { const t = p[i + 3 + k]; p[i + 3 + k] = p[i + 6 + k]; p[i + 6 + k] = t; }
    if (n) for (let k = 0; k < 3; k++) { const t = n[i + 3 + k]; n[i + 3 + k] = n[i + 6 + k]; n[i + 6 + k] = t; }
  }
  if (n) for (let i = 0; i < n.length; i++) n[i] = -n[i];
  return f;
}

const _w = new THREE.Vector3();

export const LandmarkMixin = {
  // ------------------------------------------------------------ placement
  _placeSide(lm, W, D, setback = 6.6) {
    const T = this.track, hw = T.halfWidth;
    const side = lm.side || 1;
    const done = (f, sc, sd) => {
      this.field.mark(f.cx, f.cz, W * sc, D * sc, f.ry, 1);
      this.B.frame.copy(f.m);
      lm.side = sd;
      this._lmF = { cx: f.cx, cz: f.cz, ry: f.ry, sc };
      return f;
    };
    for (const sc of [1, 0.85, 0.72]) {
      for (const sd of [side, -side]) {
        const lat = hw + setback + (D * sc) / 2;
        const f = this.frameSide(lm.index, sd, lat, 0, sc);
        if (this.field.rectFree(f.cx, f.cz, W * sc, D * sc, f.ry, hw + 5.6)) return done(f, sc, sd);
      }
    }
    const f = this.frameSide(lm.index, side, hw + setback + D * 0.36, 0, 0.72);
    return done(f, 0.72, side);
  },
  _lmSoup() { const F = this._lmF; return this.SS.soup(F.cx, F.cz).frame(F.cx, F.cz, F.ry, 0, F.sc); },
  _lights(x0, y0, z0, x1, y1, z1, n, col = '#ffd9a0') {
    if (this.P.lamps <= 0) return;
    const c = new THREE.Color(col);
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      _w.set(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t).applyMatrix4(this.B.frame);
      this.fairy.push(_w.x, _w.y, _w.z, c);
    }
  },

  // ------------------------------------------------------------ architectural kit
  // arcade wall: front face at local z, extruding backwards; optional recess wall + ceiling slab behind
  arcade(b, x, y, z, w, h, n, o = {}) {
    const { col = '#e8d5b0', trim = null, back = null, depth = 0.7, sill = 0, frac = 0.8, pointed = 0.35, pier = 0.3, recess = 2.4, ry = 0, ceil = true, t = 0.32 } = o;
    this.B.push(b, arcadeGeo(w, h, n, sill, frac, pointed, depth, pier), L(x, y, z, ry), col);
    if (trim) {
      this.B.push(b, ringGeo(w, h, n, sill, frac, pointed, pier, t), L(x, y, z, ry), trim);
      if (o.twoSided) this.B.push(b, ringGeo(w, h, n, sill, frac, pointed, pier, t), L(x - Math.sin(ry) * (depth + 0.14), y, z - Math.cos(ry) * (depth + 0.14), ry), trim);
    }
    if (back !== false) {
      const off = depth + recess;
      const s = Math.sin(ry), c = Math.cos(ry);
      this.B.push(b, this.G.box, L(x - s * (off + 0.15), y, z - c * (off + 0.15), ry, w, h, 0.3), back || shade(col, 0.55));
      if (ceil) this.B.push(b, this.G.box, L(x - s * (off / 2), y + h - 0.02, z - c * (off / 2), ry, w, 0.4, off + 0.1), shade(col, 0.8));
      this.B.push(b, this.G.box, L(x - s * (off / 2), y - 0.02, z - c * (off / 2), ry, w, 0.12, off + 0.1), '#cfc6b4');
    }
  },
  blindArch(b, x, y, z, aw, ah, col, ry = 0, pointed = 0.35) {
    this.B.push(b, archPanelGeo(aw, ah, pointed), L(x, y, z, ry), col);
  },
  domeL(b, type, x, y, z, r, h, col, finial = '#d4a937', seg = 16) {
    this.B.push(b, lathe(type, seg), L(x, y, z, 0, r, h, r), col);
    if (finial) {
      this.cyl(b, x, y + h * 0.96, z, Math.max(0.05, r * 0.05), h * 0.22 + 0.3, finial, 6);
      this.sphere(b, x, y + h * 1.08 + 0.2, z, Math.max(0.08, r * 0.08), finial);
    }
  },
  octTower(b, x, y, z, r, h, col, bands = null) {
    this.cyl(b, x, y, z, r, h, col, 8);
    if (bands) for (let yy = y + 4; yy < y + h - 1; yy += 5) this.cyl(b, x, yy, z, r * 1.12, 0.35, bands, 8);
  },
  kanguras(b, x0, x1, y, z, col, s = 0.7, ry = 0) {
    const n = Math.max(1, Math.floor((x1 - x0) / (s * 1.6)));
    const c = Math.cos(ry), sn = Math.sin(ry);
    for (let k = 0; k <= n; k++) {
      const lx = x0 + ((x1 - x0) * k) / n;
      this.B.push(b, this.G.box, L(z * sn + lx * c, y, z * c - lx * sn, ry, s * 0.7, s, s * 0.4), col);
      this.B.push(b, this.G.box, L(z * sn + lx * c, y + s, z * c - lx * sn, ry + Math.PI / 4, s * 0.35, s * 0.35, s * 0.35), col);
    }
  },
  balustrade(b, x0, x1, y, z, col, ry = 0) {
    const c = Math.cos(ry), sn = Math.sin(ry), len = x1 - x0, mx = (x0 + x1) / 2;
    this.B.push(b, this.G.box, L(z * sn + mx * c, y + 0.85, z * c - mx * sn, ry, len, 0.16, 0.4), col);
    this.B.push(b, this.G.box, L(z * sn + mx * c, y, z * c - mx * sn, ry, len, 0.14, 0.4), col);
    const n = Math.floor(len / 0.45);
    for (let k = 0; k <= n; k++) { const lx = x0 + (len * k) / n; this.B.push(b, this.G.box, L(z * sn + lx * c, y + 0.14, z * c - lx * sn, ry, 0.16, 0.71, 0.16), col); }
  },
  pinnacle(b, x, y, z, h, col, dcol) {
    this.cyl(b, x, y, z, 0.32, h, col, 8, 0.24);
    this.domeL(b, 'onion', x, y + h, z, 0.42, 0.9, dcol || col, '#d4a937', 8);
  },
  hipRoofS(S, x, y, z, w, d, h, tile, col) {
    // front edge at z, extends back to z - d; ridge along x (or a pyramid if square)
    const ov = 0.6, x0 = x - w / 2 - ov, x1 = x + w / 2 + ov, zf = z + ov, zb = z - d - ov, zm = z - d / 2;
    const half = Math.min((x1 - x0), (zf - zb)) / 2;
    const rx0 = (x0 + x1) / 2 - Math.max(0, (x1 - x0) / 2 - half), rx1 = (x0 + x1) / 2 + Math.max(0, (x1 - x0) / 2 - half);
    S.qa([x0, y, zf], [x1, y, zf], [rx1, y + h, zm], [rx0, y + h, zm], tile, col);
    S.qa([x1, y, zb], [x0, y, zb], [rx0, y + h, zm], [rx1, y + h, zm], tile, col);
    S.qa([x1, y, zf], [x1, y, zb], [rx1, y + h, zm], [rx1, y + h, zm], tile, col);
    S.qa([x0, y, zb], [x0, y, zf], [rx0, y + h, zm], [rx0, y + h, zm], tile, col);
  },
  // textured window grid from the street atlas on a landmark wall (front face at local z, facing +z)
  winGridS(S, x0, x1, y0, y1, z, tiles, tint, bw = 3.2, fh = 3.4, rnd = this.rnd) {
    const nb = Math.max(1, Math.round((x1 - x0) / bw)), nf = Math.max(1, Math.round((y1 - y0) / fh));
    const c = new THREE.Color(tint);
    for (let i = 0; i < nb; i++) for (let f = 0; f < nf; f++) S.fq('f', x0 + (i * (x1 - x0)) / nb, x0 + ((i + 1) * (x1 - x0)) / nb, y0 + (f * (y1 - y0)) / nf, y0 + ((f + 1) * (y1 - y0)) / nf, z, tiles[Math.floor(rnd() * tiles.length)], c);
  },
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
  },
  _facadeArches(key, w, h, { bg, trim, dark, rows = 2, n = 20, band = null, lit = false, pointed = 0 }) {
    return this.atlas.add(key, w, h, (g, W, H) => {
      g.fillStyle = bg; g.fillRect(0, 0, W, H);
      if (band) { g.fillStyle = band; for (let r = 0; r <= rows; r++) g.fillRect(0, (r / rows) * H - H * 0.025, W, H * 0.05); }
      g.fillStyle = trim; g.fillRect(0, 0, W, H * 0.04); g.fillRect(0, H * 0.96, W, H * 0.04);
      for (let r = 0; r < rows; r++) {
        const y0 = (r / rows) * H, rh = H / rows, aw = W / n;
        for (let k = 0; k < n; k++) {
          const x = k * aw + aw * 0.22, ww = aw * 0.56, yb = y0 + rh * 0.88, ah = rh * 0.64;
          g.fillStyle = trim; g.beginPath(); archP(g, x - aw * 0.07, yb, ww + aw * 0.14, ah + aw * 0.09, pointed); g.fill();
          g.fillStyle = dark; g.beginPath(); archP(g, x, yb, ww, ah, pointed); g.fill();
          if (lit && (k * 7 + r * 3) % 5 < 2) { g.fillStyle = 'rgba(255,190,110,0.6)'; g.beginPath(); archP(g, x, yb, ww, ah, pointed); g.fill(); }
        }
      }
    });
  },
  boardRect(key, w, h, draw) { return this.atlas.add(key, w, h, draw); },
  // simple standing sign (two posts + board in the sign atlas) in the current frame
  standSign(x, z, rect, w, h, y = 1.2, ry = 0, post = '#6b7078') {
    const c = Math.cos(ry), s = Math.sin(ry);
    for (const o of [-w * 0.4, w * 0.4]) this.box('std', x + o * c, 0, z - o * s, 0.14, y + h, 0.14, post, ry);
    this.box('std', x, y - 0.05, z, w + 0.2, h + 0.1, 0.12, '#2a2a2a', ry);
    this.sign(x + s * 0.07, y + h / 2, z + c * 0.07, w, h, rect, ry);
    this.sign(x - s * 0.07, y + h / 2, z - c * 0.07, w, h, rect, ry + Math.PI);
  },
  lawnLamp(x, z, h = 3.2) {
    this.cyl('gloss', x, 0, z, 0.07, h, '#2b2b2b', 6);
    this.sphere('glow', x, h + 0.2, z, 0.25, this.P.lamps > 0 ? '#fff1c4' : '#e8e4da');
    if (this.P.lamps > 0) { _w.set(x, h + 0.2, z).applyMatrix4(this.B.frame); this.halos.push(_w.x, _w.y, _w.z); }
  },
  palm(x, z, h = 8) {
    _w.set(x, 0, z).applyMatrix4(this.B.frame);
    this.addTree(_w.x, _w.z, 'palm', h / 8);
  },

  // ============================================================ landmarks
  _lm_brightday(lm) {
    const A = this.atlas;
    const W = 70, D = 50;
    this._placeSide(lm, W, D, 6.4);
    const F = D / 2;
    const cream = '#f4e8c8', blue = '#1f4f9e', navy = '#14306b', white = '#fbfaf6';
    this.box('std', 0, 0, 0, W, 0.06, D, '#6f9c3e');
    this.box('std', -W * 0.22, 0.02, F - 13, 24, 0.07, 12, '#c9a46a');
    this.box('std', 6, 0.02, F - 6, 12, 0.08, 12, '#9a958c');
    for (const [x0, x1] of [[-W / 2, -6], [6, W / 2]]) {
      const w = x1 - x0;
      this.box('std', (x0 + x1) / 2, 0, F - 0.3, w, 1.7, 0.35, cream);
      this.box('std', (x0 + x1) / 2, 1.7, F - 0.3, w + 0.1, 0.16, 0.5, blue);
      for (let x = x0 + 3; x < x1 - 1; x += 3.5) this.box('std', x, 0, F - 0.3, 0.5, 1.95, 0.5, blue);
    }
    // school name painted along the compound wall
    const wallR = A.add('bd-wall', 900, 90, (g, w, h) => {
      g.fillStyle = '#f4e8c8'; g.fillRect(0, 0, w, h);
      fitText(g, 'BRIGHT DAY SCHOOL • VASNA-BHAYLI • CBSE', w / 2, h * 0.55, w * 0.95, h * 0.6, { color: '#14306b' });
    });
    this.sign(-W / 4 - 1.5, 0.95, F - 0.1, 20, 1.2, wallR);
    this.box('std', -W / 2 + 0.2, 0, 0, 0.35, 1.7, D, cream); this.box('std', W / 2 - 0.2, 0, 0, 0.35, 1.7, D, cream);
    this.box('std', 0, 0, -F + 0.2, W, 1.7, 0.35, cream);
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
    for (const s of [-1, 1]) {
      for (let k = 0; k < 7; k++) this.box('gloss', s * (5.3 - k * 0.12), 0, F - 0.3 - k * 0.55, 0.06, 2.2, 0.06, navy);
      this.box('gloss', s * 4.9, 2.1, F - 2.0, 0.08, 0.08, 3.6, navy, 0.2 * s);
      this.box('gloss', s * 4.9, 0.3, F - 2.0, 0.08, 0.08, 3.6, navy, 0.2 * s);
    }
    // security cabin
    this.box('std', 9.5, 0, F - 2.5, 2.4, 2.6, 2.4, cream); this.box('std', 9.5, 2.6, F - 2.5, 3, 0.25, 3, blue);
    // main building: cream block with blue floor bands and real window bays
    const bz = -F + 14, bd = 13, bw = 54, S = this._lmSoup(), T = this.SS.T;
    this.box('std', 0, 0, bz, bw, 12.6, bd, cream);
    this.winGridS(S, -bw / 2, -7.5, 0, 12.6, bz + bd / 2 + 0.03, [T.winC[2], T.winC[3], T.winC[2]], cream, 3.4, 4.2);
    this.winGridS(S, 7.5, bw / 2, 0, 12.6, bz + bd / 2 + 0.03, [T.winC[2], T.winC[3], T.winC[2]], cream, 3.4, 4.2);
    for (const y of [0, 4.2, 8.4]) this.box('std', 0, y + 3.85, bz + 0.25, bw + 0.3, 0.4, bd + 0.8, blue);
    this.box('std', 0, 12.6, bz, bw + 0.4, 0.6, bd + 0.4, blue);
    for (let k = 0; k <= 8; k++) this.box('std', -bw / 2 + k * (bw / 8), 0, bz + bd / 2 + 0.25, 0.5, 12.6, 0.5, white);
    const tz = bz + 1.5;
    this.box('std', 0, 0, tz, 15, 17.5, bd + 3, cream);
    this.box('std', 0, 17.5, tz, 15.6, 0.7, bd + 3.6, blue);
    for (const x of [-7.2, 7.2]) this.box('std', x, 0, tz + (bd + 3) / 2 - 0.3, 0.9, 17.6, 0.9, blue);
    const bigR = A.add('bd-big', 1100, 340, (g, w, h) => {
      const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#173d8c'); gr.addColorStop(1, '#0d2759');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#ffc533'; g.lineWidth = h * 0.035; g.strokeRect(h * 0.05, h * 0.05, w - h * 0.1, h - h * 0.1);
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
    const pz = tz + (bd + 3) / 2;
    this.box('std', 0, 4.6, pz + 2.6, 12, 0.5, 5.6, white);
    this.box('std', 0, 5.1, pz + 2.6, 12.2, 0.2, 5.8, blue);
    for (const x of [-5.4, -1.8, 1.8, 5.4]) this.cyl('std', x, 0, pz + 5, 0.3, 4.6, white, 10);
    this.box('gloss', 0, 0, pz + 0.02, 4, 3.4, 0.1, '#28486e');
    this.box('std', 0, 0, pz + 3, 10, 0.3, 6, '#d8d2c4');
    // flag
    const fx = -16, fz = F - 7;
    this.box('std', fx, 0, fz, 2.4, 0.5, 2.4, white); this.box('std', fx, 0.5, fz, 1.6, 0.4, 1.6, white);
    this.cyl('gloss', fx, 0.9, fz, 0.09, 12, '#e8e8e8', 8, 0.06);
    this.sphere('metal', fx, 12.95, fz, 0.16, '#d4a937');
    const flagR = this.flagRect();
    for (let k = 0; k < 4; k++) {
      const u0 = k / 4, u1 = (k + 1) / 4;
      const sub = { u0: flagR.u0 + (flagR.u1 - flagR.u0) * u0, u1: flagR.u0 + (flagR.u1 - flagR.u0) * u1, v0: flagR.v0, v1: flagR.v1 };
      const x = fx + 0.1 + (k + 0.5) * 0.78, zz = fz + Math.sin(k * 1.4) * 0.18, rot = Math.cos(k * 1.4) * 0.22;
      this.sign(x, 11.55, zz, 0.8, 2.1, sub, rot);
      this.sign(x, 11.55, zz - 0.005, 0.8, 2.1, { u0: sub.u1, u1: sub.u0, v0: sub.v0, v1: sub.v1 }, rot + Math.PI);
    }
    // school buses
    const busR = A.add('bus', 600, 110, (g, w, h) => {
      g.fillStyle = '#f6c000'; g.fillRect(0, 0, w, h);
      fitText(g, 'SCHOOL BUS', w / 2, h * 0.38, w * 0.9, h * 0.52, { color: '#1b1b1b' });
      fitText(g, 'BRIGHT DAY SCHOOL • VADODARA', w / 2, h * 0.8, w * 0.9, h * 0.22, { color: '#14306b', weight: '800', family: FONT2 });
    });
    for (const [busX, busZ] of [[16, F - 8], [16, F - 12]]) {
      this.box('gloss', busX, 0.55, busZ, 10, 2.5, 2.5, '#f6c000');
      this.box('gloss', busX, 3.05, busZ, 9.8, 0.25, 2.4, '#f2f2f2');
      this.box('gloss', busX - 0.3, 1.85, busZ, 9.0, 0.95, 2.52, '#2b3a48');
      this.box('gloss', busX + 4.98, 1.4, busZ, 0.1, 1.5, 2.2, '#2b3a48');
      this.box('std', busX, 0.45, busZ, 10.2, 0.35, 2.6, '#222222');
      for (const [x, z] of [[busX - 3, busZ - 1.15], [busX - 3, busZ + 1.15], [busX + 3.2, busZ - 1.15], [busX + 3.2, busZ + 1.15]]) this.B.push('std', this.G.boxC, L(x, 0.5, z, 0, 1.0, 1.0, 0.4), '#151515');
      this.sign(busX - 0.5, 1.0, busZ + 1.27, 6.2, 1.1, busR);
      this.sign(busX - 0.5, 1.0, busZ - 1.27, 6.2, 1.1, busR, Math.PI);
    }
    for (let k = 0; k < 7; k++) this.treeLocal(-W / 2 + 4 + k * 4.2, F - 2.6, 'ashoka', 0.9);
    for (let k = 0; k < 5; k++) this.treeLocal(W / 2 - 3.5, F - 4 - k * 6, 'ashoka', 0.95);
    this.treeLocal(-W / 2 + 5, -F + 5, 'banyan', 1.1);
    this.treeLocal(W / 2 - 7, -F + 6, 'neem', 1.1);
  },

  flagRect() {
    return this.atlas.add('flag', 300, 200, (g, w, h) => {
      g.fillStyle = '#ff9933'; g.fillRect(0, 0, w, h / 3);
      g.fillStyle = '#ffffff'; g.fillRect(0, h / 3, w, h / 3);
      g.fillStyle = '#138808'; g.fillRect(0, (2 * h) / 3, w, h / 3);
      const cx = w / 2, cy = h / 2, r = h * 0.14;
      g.strokeStyle = '#000080'; g.lineWidth = Math.max(1, h * 0.015);
      g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.stroke();
      for (let k = 0; k < 24; k++) { const a = (k / 24) * TAU; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); g.stroke(); }
    });
  },

  // ------------------------------------------------------------ Laxmi Vilas Palace
  _lm_palace(lm) {
    const W = 128, D = 76;
    this._placeSide(lm, W, D, 7);
    const F = D / 2;
    const sand = '#c8774c', sand2 = '#b9683f', trim = '#f0dfc0', dome = '#e0ae84', gold = '#d4a937', grey = '#7f8b8e';
    const b = 'std';
    this.box(b, 0, 0, 0, W, 0.06, D, '#5d9a37');
    this.box(b, 4, 0.02, F - 12, 12, 0.07, 24, '#d8c8a2');
    this.cyl(b, 4, 0.02, F - 22, 9, 0.07, '#d8c8a2', 24);
    this.cyl(b, 4, 0.03, F - 22, 6, 0.08, '#4f8f30', 24);
    // boundary: low sandstone wall, railings, gate piers with lanterns
    for (const [x0, x1] of [[-W / 2, -4], [12, W / 2]]) {
      this.box(b, (x0 + x1) / 2, 0, F - 0.4, x1 - x0, 0.9, 0.6, sand2);
      this.box(b, (x0 + x1) / 2, 0.9, F - 0.4, x1 - x0, 0.12, 0.7, trim);
      for (let x = x0 + 0.5; x < x1; x += 0.5) this.box('gloss', x, 1.0, F - 0.4, 0.05, 1.2, 0.05, '#2a2a2a');
      for (let x = x0 + 4; x < x1 - 1; x += 8) { this.box(b, x, 0, F - 0.4, 0.9, 2.4, 0.9, sand); this.box(b, x, 2.4, F - 0.4, 1.1, 0.2, 1.1, trim); }
    }
    for (const x of [-4, 12]) {
      this.box(b, x, 0, F - 0.4, 1.8, 5.5, 1.8, sand); this.box(b, x, 5.5, F - 0.4, 2.2, 0.35, 2.2, trim);
      this.domeL(b, 'onion', x, 5.85, F - 0.4, 0.9, 1.8, dome, gold, 10);
    }
    const gateR = this.atlas.add('lvp-gate', 700, 110, (g, w, h) => {
      g.fillStyle = '#5a1e12'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#e8c36a'; g.lineWidth = 4; g.strokeRect(6, 6, w - 12, h - 12);
      fitText(g, 'LUKSHMI VILAS PALACE', w / 2, h * 0.42, w * 0.88, h * 0.48, { color: '#f4d58a', family: FONT_SERIF, weight: '700' });
      fitText(g, 'VADODARA • 1890', w / 2, h * 0.78, w * 0.6, h * 0.2, { color: '#ffffff', weight: '700', family: FONT2 });
    });
    this.standSign(-14, F - 2, gateR, 7, 1.1, 1.2);

    // ---- main block: three storeys of arcaded verandahs
    const mz = -F + 30, mw = 92;
    this.box(b, 0, 0, mz - 10, mw, 20, 20, sand);
    this.arcade(b, 0, 0, mz + 3.2, mw, 6.6, 16, { col: sand, trim, depth: 0.8, pointed: 0.4, frac: 0.82 });
    this.box(b, 0, 6.55, mz + 1.7, mw + 0.6, 0.55, 3.6, trim);
    this.arcade(b, 0, 7.1, mz + 3.2, mw, 6.0, 16, { col: sand, trim, depth: 0.7, pointed: 0.4, frac: 0.78, sill: 0.9 });
    for (let k = 0; k <= 16; k++) this.box(b, -mw / 2 + (k * mw) / 16, 7.1, mz + 3.25, 0.3, 0.9, 0.3, trim);
    this.box(b, 0, 13.05, mz + 1.7, mw + 0.6, 0.55, 3.6, trim);
    this.balustrade(b, -mw / 2, mw / 2, 13.6, mz + 3.1, trim);
    const up = this._facadeArches('lvp-up', 1200, 110, { bg: sand, trim, dark: '#3b2418', rows: 1, n: 30, pointed: 0.4, lit: this.P.windows > 0.3 });
    this.sign(0, 16.8, mz + 0.04, mw, 6.4, up, 0, 'deco');
    this.box(b, 0, 19.8, mz - 10, mw + 1, 0.6, 21, trim);
    this.box(b, 0, 10, mz - 0.6, mw, 0.35, 0.4, grey);
    this.kanguras(b, -mw / 2, mw / 2, 20.4, mz + 0.2, sand, 0.8);
    for (let x = -mw / 2; x <= mw / 2 + 0.1; x += mw / 8) this.pinnacle(b, x, 13.6, mz + 3.1, 3.4, sand, dome);
    for (const x of [-36, -6, 14, 36]) this.chhatri(b, x, 20.4, mz - 2, 1.3, trim, dome);
    this._lights(-mw / 2, 20.2, mz + 0.3, mw / 2, 20.2, mz + 0.3, 60);
    this._lights(-mw / 2, 13.4, mz + 3.4, mw / 2, 13.4, mz + 3.4, 60);
    this._lights(-mw / 2, 6.9, mz + 3.4, mw / 2, 6.9, mz + 3.4, 60);
    // ---- end pavilions with big onion domes
    for (const s of [-1, 1]) {
      const px = s * (mw / 2 + 7);
      this.box(b, px, 0, mz - 6, 14, 27, 18, sand);
      this.arcade(b, px, 0, mz + 3.2, 14, 6.6, 2, { col: sand, trim, pointed: 0.4 });
      this.arcade(b, px, 7.1, mz + 3.2, 14, 6.0, 2, { col: sand, trim, pointed: 0.4, sill: 0.9 });
      this.arcade(b, px, 13.6, mz + 3.2, 14, 6.0, 3, { col: sand, trim, pointed: 0.4, sill: 0.9 });
      for (const y of [6.55, 13.05, 19.6]) this.box(b, px, y, mz + 1.2, 14.6, 0.55, 4.6, trim);
      this.box(b, px, 26.8, mz - 6, 15, 0.7, 18.6, trim);
      this.kanguras(b, px - 7, px + 7, 27.5, mz + 3.0, sand, 0.7);
      this.cyl(b, px, 27.5, mz - 4, 5.2, 2.6, sand2, 8);
      this.domeL(b, 'onion', px, 30.1, mz - 4, 5.4, 9.5, dome, gold, 16);
      for (const a of [-1, 1]) for (const c of [-1, 1]) this.chhatri(b, px + a * 5.6, 27.5, mz - 4 + c * 6.5, 1.0, trim, dome);
      this._lights(px - 7, 27.4, mz + 3.1, px + 7, 27.4, mz + 3.1, 12);
    }
    // ---- central porte-cochere with a dome above the entrance
    const cx = 4, pz = mz + 3.2;
    this.box(b, cx, 0, pz + 5, 20, 11, 10, sand);
    this.arcade(b, cx, 0, pz + 10.1, 20, 10, 3, { col: sand, trim, pointed: 0.45, frac: 0.86, depth: 1.0, back: false, pier: 0.25, t: 0.45 });
    for (const s of [-1, 1]) this.arcade(b, cx + s * 10.05, 0, pz + 5, 10, 10, 1, { col: sand, trim, pointed: 0.45, frac: 0.86, depth: 0.6, back: false, ry: s * Math.PI / 2, pier: 0.3 });
    this.box(b, cx, 10, pz + 5.2, 21, 0.8, 10.6, trim);
    this.kanguras(b, cx - 10, cx + 10, 10.8, pz + 10.3, sand, 0.7);
    this.arcade(b, cx, 10.8, pz + 4, 12, 6, 3, { col: sand, trim, pointed: 0.4, sill: 0.6 });
    this.box(b, cx, 16.8, pz + 2, 12.6, 0.6, 5, trim);
    this.cyl(b, cx, 17.4, pz + 2, 3.4, 1.6, sand2, 8);
    this.domeL(b, 'onion', cx, 19, pz + 2, 3.6, 6.2, dome, gold);
    for (const s of [-1, 1]) for (const z of [pz + 0.2, pz + 9.6]) this.pinnacle(b, cx + s * 9.8, 10.8, z, 3.2, sand, dome);
    // ---- the clock tower (tallest element of the skyline)
    const tx = -20, tz = mz - 4;
    this.box(b, tx, 0, tz, 10, 46, 10, sand);
    for (const y of [20.4, 27, 33.5, 40]) this.box(b, tx, y, tz, 10.8, 0.6, 10.8, trim);
    for (const [ox, oz, ry] of [[0, 5.02, 0], [5.02, 0, Math.PI / 2], [-5.02, 0, -Math.PI / 2], [0, -5.02, Math.PI]]) {
      this.blindArch(b, tx + ox, 21.4, tz + oz, 3.2, 5, '#3b2418', ry, 0.4);
      this.blindArch(b, tx + ox * 1.002, 28, tz + oz * 1.002, 2.4, 4.5, '#3b2418', ry, 0.4);
    }
    const clockR = this.clockRect();
    for (const [ox, oz, ry] of [[0, 5.06, 0], [5.06, 0, Math.PI / 2], [-5.06, 0, -Math.PI / 2], [0, -5.06, Math.PI]]) this.sign(tx + ox, 37, tz + oz, 5.2, 5.2, clockR, ry, 'deco');
    for (const s of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) this.arcade(b, tx + Math.sin(s) * 5, 40.6, tz + Math.cos(s) * 5, 10, 5.4, 3, { col: sand, trim, back: false, pointed: 0.4, ry: s, depth: 0.5 });
    this.box(b, tx, 40.6, tz, 8.6, 0.3, 8.6, '#3b2418');
    this.box(b, tx, 46, tz, 11, 0.7, 11, trim);
    this.kanguras(b, tx - 5.4, tx + 5.4, 46.7, tz + 5.3, sand, 0.6);
    this.cyl(b, tx, 46.7, tz, 3.8, 2.4, sand2, 8);
    this.domeL(b, 'onion', tx, 49.1, tz, 4.0, 7.6, dome, gold);
    for (const a of [-1, 1]) for (const c of [-1, 1]) this.chhatri(b, tx + a * 4.6, 46.7, tz + c * 4.6, 0.95, trim, dome);
    this._lights(tx - 5.5, 46.6, tz + 5.5, tx + 5.5, 46.6, tz + 5.5, 10);
    this._lights(tx - 5.1, 0.5, tz + 5.2, tx - 5.1, 46, tz + 5.2, 30);
    this._lights(tx + 5.1, 0.5, tz + 5.2, tx + 5.1, 46, tz + 5.2, 30);
    // ---- Durbar Hall dome behind the right half
    const dx = 26, dz = mz - 12;
    this.cyl(b, dx, 20.4, dz, 7.4, 4, sand, 8);
    for (let k = 0; k < 8; k++) { const a = (k + 0.5) * TAU / 8; this.blindArch(b, dx + Math.sin(a) * 7.0, 21, dz + Math.cos(a) * 7.0, 2, 2.6, '#3b2418', a, 0.4); }
    this.domeL(b, 'bulb', dx, 24.4, dz, 7.6, 10.5, dome, gold, 20);
    for (const a of [-1, 1]) for (const c of [-1, 1]) this.chhatri(b, dx + a * 7, 20.4, dz + c * 7, 1.1, trim, dome);
    // ---- grounds
    this.cyl(b, cx, 0, F - 22, 3.4, 0.7, '#e7dcc6', 16);
    this.cyl('water', cx, 0.05, F - 22, 3.1, 0.7, '#4f8fb0', 16);
    this.cone('water', cx, 0.7, F - 22, 0.35, 2.8, '#cfe8f5', 8);
    for (const x of [-56, -46, 48, 56]) this.treeLocal(x, F - 8, 'neem', 1.15);
    for (let x = -54; x <= 56; x += 9) if (Math.abs(x - cx) > 10) this.treeLocal(x, F - 3.4, 'ashoka', 0.9);
    for (const x of [-30, -18, 26, 38]) this.palm(x, F - 14, 9);
    for (let x = -50; x <= 54; x += 12) if (Math.abs(x - cx) > 10) this.lawnLamp(x, F - 6);
  },

  // ------------------------------------------------------------ Sursagar lake + Sarveshwar Mahadev
  _lm_sursagar(lm) {
    const T = this.track, hw = T.halfWidth;
    let R = 40, f = null;
    for (const side of [lm.side, -lm.side]) {
      for (R = 44; R >= 18; R -= 6) {
        const ff = this.frameSide(lm.index, side, hw + 8 + R + 3);
        const q = this.field.query(ff.cx, ff.cz);
        if (q.d > R + hw + 8 && this.field.rectFree(ff.cx, ff.cz, 2 * R, 2 * R, ff.ry, hw + 5.6)) { f = ff; lm.side = side; break; }
      }
      if (f) break;
    }
    if (!f) { R = 18; f = this.frameSide(lm.index, lm.side, hw + 8 + R + 3); }
    this.field.mark(f.cx, f.cz, 2 * R + 8, 2 * R + 8, f.ry, 1);
    this.B.frame.copy(f.m);
    this._lmF = { cx: f.cx, cz: f.cz, ry: f.ry, sc: 1 };
    const stone = '#d9c8a5', b = 'std';
    const prof = [[R + 6, 0.0], [R + 6, 0.75], [R + 4.2, 0.75], [R + 4.2, 0.55], [R + 2.4, 0.55], [R + 2.4, 0.35], [R + 0.6, 0.35], [R + 0.6, 0.1]];
    const lg = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)).reverse(), 56);
    this.B.push(b, lg, L(0, 0, 0), stone); lg.dispose();
    const water = new THREE.CircleGeometry(R + 0.8, 56).rotateX(-Math.PI / 2);
    this.B.push('water', water, L(0, 0.24, 0), '#3d7f94'); water.dispose();
    // promenade railing (white posts, iron rails) + lamps
    const n = Math.floor((TAU * (R + 5.4)) / 2.2);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU;
      this.box(b, Math.cos(a) * (R + 5.4), 0.75, Math.sin(a) * (R + 5.4), 0.22, 1.0, 0.22, '#f2efe8', -a);
    }
    for (const y of [1.3, 1.65]) { const tor = new THREE.TorusGeometry(R + 5.4, 0.045, 4, 96).rotateX(Math.PI / 2); this.B.push('gloss', tor, L(0, y, 0), '#3a3a3a'); tor.dispose(); }
    for (let k = 0; k < 14; k++) { const a = (k / 14) * TAU; this.lawnLamp(Math.cos(a) * (R + 6.6), Math.sin(a) * (R + 6.6), 3.6); }
    // pedestal rising out of the water
    const m = 'metal', gold = '#d6a935', gold2 = '#c39029';
    this.cyl(b, 0, -0.3, 0, 7.2, 2.0, stone, 24);
    this.cyl(b, 0, 1.7, 0, 5.4, 2.4, '#f4efe4', 20);
    this.cyl(b, 0, 3.1, 0, 5.45, 0.4, '#b5452f', 20);
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * TAU;
      this.B.push(m, this.G.sphere, L(Math.cos(a) * 3.9, 4.6, Math.sin(a) * 3.9, -a, 0.75, 0.45, 1.4, 0.55), '#e0b84a');
    }
    this.cyl(m, 0, 4.1, 0, 3.8, 0.7, gold, 20, 3.2);
    const y0 = 4.8;
    // legs and feet (standing pose), tiger-skin dhoti
    for (const s of [-1, 1]) {
      this.B.push(m, this.G.box, L(s * 1.05, y0, 0.5, 0, 1.2, 0.6, 2.2), gold);
      this.cyl(m, s * 1.0, y0 + 0.5, 0.1, 0.85, 10.5, gold, 12, 1.15);
    }
    this.cyl(m, 0, y0 + 6.2, 0, 2.6, 5.6, gold2, 16, 2.05);
    const belt = new THREE.TorusGeometry(2.05, 0.22, 6, 20).rotateX(Math.PI / 2);
    this.B.push(m, belt, L(0, y0 + 11.7, 0, 0, 1, 1, 0.78), '#e8c45a'); belt.dispose();
    // torso
    const torso = new THREE.CylinderGeometry(2.25, 1.75, 6.6, 16).translate(0, 3.3, 0);
    this.B.push(m, torso, L(0, y0 + 11.6, 0, 0, 1, 1, 0.72), gold); torso.dispose();
    this.sphere(m, 0, y0 + 16.4, 0.65, 1.55, gold, 0.75, 1.25);
    for (const s of [-1, 1]) this.sphere(m, s * 2.35, y0 + 17.5, 0, 1.15, gold);
    // neck, head, matted hair top-knot, crescent moon
    this.cyl(m, 0, y0 + 18.0, 0, 0.75, 1.3, gold, 10);
    this.sphere(m, 0, y0 + 20.3, 0.1, 1.5, gold, 1.22);
    this.sphere(m, 0, y0 + 19.7, 1.25, 0.32, gold2); // nose
    for (const s of [-1, 1]) this.sphere(m, s * 1.45, y0 + 19.9, 0, 0.35, '#e8c45a', 1.6);
    this.cone(m, 0, y0 + 21.3, -0.15, 1.15, 2.4, gold2, 12);
    this.sphere(m, 0, y0 + 23.2, -0.15, 0.85, gold2, 0.9);
    this.cone(m, 0, y0 + 23.7, -0.15, 0.62, 1.8, gold2, 10);
    const moon = new THREE.TorusGeometry(0.55, 0.12, 6, 14, Math.PI * 1.2);
    this.B.push(m, moon, L(0.75, y0 + 22.8, 0.2, 0.3, 1, 1, 1, 0, -0.8), '#f6e7b0'); moon.dispose();
    // serpent around the neck with a raised hood, rudraksha mala
    const snake = new THREE.TorusGeometry(1.15, 0.24, 6, 18).rotateX(Math.PI / 2);
    this.B.push(m, snake, L(0, y0 + 18.3, 0.1, 0, 1.05, 1, 0.85), '#b8892a'); snake.dispose();
    this.B.push(m, this.G.sphere, L(1.0, y0 + 19.6, 0.55, 0.2, 0.55, 0.85, 0.22), '#b8892a');
    const mala = new THREE.TorusGeometry(1.7, 0.12, 5, 22).rotateX(Math.PI / 2 - 0.5);
    this.B.push(m, mala, L(0, y0 + 16.2, 0.55, 0, 1, 1, 0.8), '#8a5a1f'); mala.dispose();
    // right arm raised in blessing (abhaya mudra)
    this.cylBetween(m, 2.45, y0 + 17.4, 0, 3.55, y0 + 14.4, 0.7, 0.68, gold);
    this.sphere(m, 3.55, y0 + 14.4, 0.7, 0.62, gold);
    this.cylBetween(m, 3.55, y0 + 14.4, 0.7, 3.75, y0 + 17.6, 1.9, 0.58, gold);
    this.B.push(m, this.G.box, L(3.78, y0 + 17.5, 1.95, 0, 1.0, 1.5, 0.32), gold);
    for (let k = 0; k < 4; k++) this.B.push(m, this.G.box, L(3.42 + k * 0.24, y0 + 19.0, 1.95, 0, 0.2, 0.75, 0.26), gold);
    const bangle = new THREE.TorusGeometry(0.62, 0.12, 5, 12).rotateX(Math.PI / 2);
    this.B.push(m, bangle, L(3.7, y0 + 16.8, 1.6), '#e8c45a');
    // left arm holding the trishul planted beside him
    this.cylBetween(m, -2.45, y0 + 17.4, 0, -3.45, y0 + 14.3, 0.3, 0.68, gold);
    this.sphere(m, -3.45, y0 + 14.3, 0.3, 0.62, gold);
    this.cylBetween(m, -3.45, y0 + 14.3, 0.3, -4.15, y0 + 15.6, 1.3, 0.58, gold);
    this.sphere(m, -4.2, y0 + 15.7, 1.35, 0.6, gold);
    this.B.push(m, bangle, L(-4.0, y0 + 15.3, 1.1, 0, 1, 1, 1, 0.5), '#e8c45a'); bangle.dispose();
    const sx = -4.3, sz = 1.4;
    this.cylBetween(m, sx, 4.8, sz, sx, y0 + 28.5, sz, 0.17, '#e8c45a');
    this.cone(m, sx, y0 + 28.4, sz, 0.26, 2.2, '#f1d36b', 6);
    for (const s of [-1, 1]) {
      this.cylBetween(m, sx, y0 + 28.0, sz, sx + s * 0.95, y0 + 28.3, sz, 0.13, '#f1d36b');
      this.cylBetween(m, sx + s * 0.95, y0 + 28.3, sz, sx + s * 1.0, y0 + 29.8, sz, 0.13, '#f1d36b');
      this.cone(m, sx + s * 1.0, y0 + 29.8, sz, 0.2, 0.9, '#f1d36b', 6);
    }
    this.cone(m, sx, y0 + 25.6, sz, 0.45, 0.55, '#c9962e', 8); this.cone(m, sx, y0 + 26.15, sz, 0.45, -0.55, '#c9962e', 8);
    if (this.P.lamps > 0) for (let k = 0; k < 6; k++) { const a = (k / 6) * TAU + 0.4; this.box('glow', Math.cos(a) * 5.6, 3.9, Math.sin(a) * 5.6, 0.5, 0.3, 0.5, '#fff2c0'); }
    for (let k = 0; k < 18; k++) {
      const a = (k / 18) * TAU;
      if (Math.sin(a) > 0.5) continue;
      this.treeLocal(Math.cos(a) * (R + 10), Math.sin(a) * (R + 10), k % 3 ? 'neem' : 'banyan', 1.05);
    }
    // name board facing the road
    const sr = this.atlas.add('sursagar', 760, 130, (g, w, h) => {
      g.fillStyle = '#7a1414'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#ffd166'; g.lineWidth = 4; g.strokeRect(6, 6, w - 12, h - 12);
      fitText(g, 'સુરસાગર તળાવ', w / 2, h * 0.32, w * 0.8, h * 0.36, { color: '#ffd166', weight: '700', family: FONT_GU });
      fitText(g, 'SURSAGAR LAKE • SARVESHWAR MAHADEV', w / 2, h * 0.72, w * 0.9, h * 0.26, { color: '#ffffff' });
    });
    this.standSign(-R * 0.55, R + 6.4, sr, 6.4, 1.1, 1.3);
  },

  // ------------------------------------------------------------ Nyay Mandir
  _lm_nyaymandir(lm) {
    const W = 78, D = 42;
    this._placeSide(lm, W, D, 6.8);
    const F = D / 2, b = 'std';
    const white = '#f3ede1', red = '#b4442c', redD = '#8e2f1e', dome = '#f6f1e6', gold = '#d4a937';
    this.box(b, 0, 0, 0, W, 0.06, D, '#5d9236');
    this.box(b, 0, 0.02, F - 7, 10, 0.07, 14, '#d6cdb9');
    for (const [x0, x1] of [[-W / 2, -5], [5, W / 2]]) { this.box(b, (x0 + x1) / 2, 0, F - 0.4, x1 - x0, 0.7, 0.5, white); for (let x = x0 + 0.4; x < x1; x += 0.45) this.box('gloss', x, 0.7, F - 0.4, 0.05, 1.1, 0.05, '#222'); }
    const mz = -F + 18, mw = 64;
    this.box(b, 0, 0, mz - 7, mw, 15, 14, white);
    this.arcade(b, 0, 0, mz + 2.8, mw, 7, 16, { col: white, trim: red, depth: 0.7, pointed: 0.22, frac: 0.8, t: 0.4 });
    this.box(b, 0, 6.95, mz + 1.4, mw + 0.5, 0.35, 3.0, red);
    this.box(b, 0, 7.3, mz + 1.4, mw + 0.5, 0.3, 3.0, white);
    this.box(b, 0, 7.6, mz + 1.4, mw + 0.5, 0.25, 3.0, red);
    this.arcade(b, 0, 7.85, mz + 2.8, mw, 6.4, 16, { col: white, trim: red, depth: 0.6, pointed: 0.22, frac: 0.76, sill: 1.0, t: 0.38 });
    this.box(b, 0, 14.2, mz - 5.6, mw + 0.8, 0.5, 17.4, red);
    for (const y of [3, 5, 10.5, 12.3]) this.box(b, 0, y, mz - 14.05, mw, 0.3, 0.1, red);
    this.kanguras(b, -mw / 2, mw / 2, 14.7, mz + 2.6, white, 0.7);
    for (let x = -mw / 2; x <= mw / 2 + 0.1; x += mw / 8) this.pinnacle(b, x, 14.7, mz + 2.6, 2.6, white, dome);
    this._lights(-mw / 2, 14.6, mz + 2.9, mw / 2, 14.6, mz + 2.9, 44);
    // central tower: double-height arch, clock, tall drum and dome
    this.box(b, 0, 0, mz - 2, 16, 23, 12, white);
    this.arcade(b, 0, 0, mz + 5.2, 16, 14.2, 1, { col: white, trim: red, depth: 1.2, pointed: 0.35, frac: 0.86, pier: 0.4, t: 0.6, back: '#5a3a2e' });
    for (const s of [-1, 1]) for (const y of [0, 7.1]) this.arcade(b, s * 8.05, y, mz + 1.5, 7, 7.1, 1, { col: white, trim: red, depth: 0.5, ry: s * Math.PI / 2, back: false, pointed: 0.3 });
    for (const y of [14.2, 18.6, 22.8]) this.box(b, 0, y, mz - 0.6, 16.6, 0.4, 13.6, red);
    const clockR = this.clockRect();
    this.sign(0, 18.6, mz + 5.25, 4.6, 4.6, clockR, 0, 'deco');
    for (const a of [-1, 1]) for (const c of [-1, 1]) { this.octTower(b, a * 7.6, 0, mz - 2 + c * 5.7, 1.1, 27, white, red); this.domeL(b, 'onion', a * 7.6, 27, mz - 2 + c * 5.7, 1.3, 2.4, dome, gold, 10); }
    this.cyl(b, 0, 23.2, mz - 2, 5.0, 3.4, white, 8);
    for (let k = 0; k < 8; k++) { const a = (k + 0.5) * TAU / 8; this.blindArch(b, Math.sin(a) * 4.62, 23.6, mz - 2 + Math.cos(a) * 4.62, 1.6, 2.6, redD, a, 0.3); }
    this.cyl(b, 0, 26.6, mz - 2, 5.3, 0.4, red, 8);
    this.domeL(b, 'bulb', 0, 27, mz - 2, 5.2, 8.2, dome, gold, 20);
    this._lights(-8, 23, mz + 5.4, 8, 23, mz + 5.4, 12);
    // end towers with domes
    for (const s of [-1, 1]) {
      const x = s * (mw / 2 - 2);
      this.box(b, x, 0, mz - 4, 9, 20, 14, white);
      this.arcade(b, x, 0, mz + 3.1, 9, 7, 2, { col: white, trim: red, pointed: 0.22, depth: 0.6 });
      this.arcade(b, x, 7.85, mz + 3.1, 9, 6.4, 2, { col: white, trim: red, pointed: 0.22, depth: 0.6, sill: 1 });
      for (const y of [14.2, 19.6]) this.box(b, x, y, mz - 3.4, 9.6, 0.5, 15.4, red);
      this.cyl(b, x, 20.1, mz - 2, 3.4, 2.0, white, 8);
      this.domeL(b, 'onion', x, 22.1, mz - 2, 3.6, 6.0, dome, gold);
      for (const a of [-1, 1]) this.pinnacle(b, x + a * 4.2, 20.1, mz + 3, 3, white, dome);
    }
    for (let k = 0; k < 4; k++) this.box(b, 0, 0, mz + 6.6 + k * 0.6, 12 - k * 1.4, 0.6 - k * 0.14, 0.6, '#ddd3c2');
    const nr = this.atlas.add('nyay', 760, 130, (g, w, h) => {
      g.fillStyle = '#f3ede1'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#b4442c'; g.lineWidth = 5; g.strokeRect(6, 6, w - 12, h - 12);
      fitText(g, 'ન્યાય મંદિર', w / 2, h * 0.33, w * 0.7, h * 0.38, { color: '#8e2f1e', weight: '700', family: FONT_GU });
      fitText(g, 'NYAY MANDIR', w / 2, h * 0.73, w * 0.8, h * 0.32, { color: '#8e2f1e', family: FONT_SERIF, weight: '700' });
    });
    this.standSign(-14, F - 2.2, nr, 6, 1.0, 1.0);
    for (const x of [-30, -20, 20, 30]) this.treeLocal(x, F - 4, 'ashoka', 0.9);
    this.treeLocal(-W / 2 + 4, F - 7, 'neem', 1.1); this.treeLocal(W / 2 - 4, F - 7, 'neem', 1.1);
  },

  // ------------------------------------------------------------ Mandvi Gate: spans the road, cars drive through
  _lm_mandvi(lm) {
    const T = this.track, hw = T.halfWidth;
    let i = lm.index, best = Infinity;
    for (let o = -90; o <= 90; o += 2) {
      const j = (lm.index + o + T.N) % T.N;
      let mm = 0;
      for (let k = -14; k <= 14; k++) mm = Math.max(mm, Math.abs(T.curv[(j + k + T.N) % T.N]));
      const score = mm + Math.abs(o) * 0.00002;
      if (score < best) { best = score; i = j; }
    }
    lm.index = i;
    this.B.frame.copy(this.frameRoad(i));
    const b = 'std';
    const a = hw + 5.1, pier = 5.2, Dp = 16, hwG = a + pier, H1 = 12.5, H2 = 18.6, H3 = 24.2;
    const ochre = '#e3c58c', trim = '#f8f1df', maroon = '#97452b', dome = '#f6efe2', gold = '#d4a937', dark = '#3b2a1c';
    // ground storey: one wide arch through which the road passes
    const sh = new THREE.Shape();
    sh.moveTo(-hwG, -0.6); sh.lineTo(hwG, -0.6); sh.lineTo(hwG, H1); sh.lineTo(-hwG, H1); sh.closePath();
    sh.holes.push(new THREE.Path(archPts(-a, -0.5, 2 * a, H1 - 2.2, 0.32, 20).map(V2)));
    const ex = new THREE.ExtrudeGeometry(sh, { depth: Dp, bevelEnabled: false, curveSegments: 1 }).translate(0, 0, -Dp / 2);
    this.B.push(b, ex, L(0, 0, 0), ochre); ex.dispose();
    for (const s of [1, -1]) {
      const rg = new THREE.ExtrudeGeometry(new THREE.Shape([...archPts(-a - 0.6, -0.5, 2 * a + 1.2, H1 - 1.6, 0.32, 20), ...archPts(-a, -0.5, 2 * a, H1 - 2.2, 0.32, 20).reverse()].map(V2)), { depth: 0.2, bevelEnabled: false, curveSegments: 1 });
      this.B.push(b, rg, L(0, 0, s * (Dp / 2), s > 0 ? 0 : Math.PI), maroon); rg.dispose();
      // blind arches + niches on the piers
      for (const px of [-1, 1]) {
        this.blindArch(b, px * (a + pier / 2), 1.2, s * (Dp / 2 + 0.03), 2.6, 6.2, dark, s > 0 ? 0 : Math.PI, 0.35);
        this.box(b, px * (a + pier / 2), 0, s * (Dp / 2 + 0.15), pier, 0.9, 0.3, trim);
      }
      this.box(b, 0, H1 - 0.4, s * (Dp / 2 + 0.2), 2 * hwG + 0.6, 0.5, 0.4, trim);
    }
    // cross-street faces: blind arches on the piers
    for (const s of [-1, 1]) for (const zz of [-Dp / 4, Dp / 4]) this.blindArch(b, s * (hwG + 0.03), 1.0, zz, 4.2, 8.5, dark, s * Math.PI / 2, 0.35);
    this.box(b, 0, H1, 0, 2 * hwG + 1.0, 0.6, Dp + 1.0, trim);
    // second storey: arcade of seven arches on both faces (jharokha balconies)
    const w2 = 2 * hwG - 2;
    this.box(b, 0, H1 + 0.6, 0, w2, H2 - H1 - 0.6, Dp - 4, ochre);
    for (const s of [1, -1]) {
      this.arcade(b, 0, H1 + 0.6, s * (Dp / 2 - 0.4), w2, H2 - H1 - 0.6, 7, { col: ochre, trim: maroon, depth: 0.6, pointed: 0.35, sill: 1.0, frac: 0.8, ry: s > 0 ? 0 : Math.PI, recess: 1.3, back: '#4a3426' });
      this.balustrade(b, -w2 / 2, w2 / 2, H1 + 0.6, s * (Dp / 2 - 0.2), trim, s > 0 ? 0 : Math.PI);
    }
    for (const s of [-1, 1]) this.arcade(b, s * (w2 / 2), H1 + 0.6, 0, Dp - 4, H2 - H1 - 0.6, 3, { col: ochre, trim: maroon, depth: 0.5, pointed: 0.35, sill: 1.0, ry: s * Math.PI / 2, back: false });
    this.box(b, 0, H2, 0, w2 + 0.8, 0.5, Dp - 3, trim);
    // third storey
    const w3 = 2 * a + 1;
    this.box(b, 0, H2 + 0.5, 0, w3, H3 - H2 - 0.5, Dp - 6, ochre);
    for (const s of [1, -1]) this.arcade(b, 0, H2 + 0.5, s * (Dp / 2 - 2.2), w3, H3 - H2 - 0.5, 9, { col: ochre, trim: maroon, depth: 0.5, pointed: 0.35, sill: 0.8, frac: 0.75, ry: s > 0 ? 0 : Math.PI, back: '#4a3426', recess: 1.0 });
    this.box(b, 0, H3, 0, w3 + 0.8, 0.5, Dp - 5, trim);
    for (const s of [1, -1]) this.kanguras(b, -w3 / 2, w3 / 2, H3 + 0.5, s * (Dp / 2 - 2.6), trim, 0.6);
    // clock pediment + central pavilion dome
    this.box(b, 0, H3 + 0.5, 0, 9, 5, 6, ochre);
    const clockR = this.clockRect();
    for (const s of [1, -1]) {
      this.sign(0, H3 + 3.0, s * 3.03, 4.0, 4.0, clockR, s > 0 ? 0 : Math.PI, 'deco');
      this.blindArch(b, 0, H3 + 0.7, s * 3.02, 7.2, 4.6, maroon, s > 0 ? 0 : Math.PI, 0.35);
    }
    this.box(b, 0, H3 + 5.5, 0, 9.6, 0.5, 6.6, trim);
    this.domeL(b, 'onion', 0, H3 + 6, 0, 2.8, 4.6, dome, gold);
    // corner turrets (staircase towers)
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const x = sx * (hwG - 1.4), z = sz * (Dp / 2 - 1.4);
      this.octTower(b, x, 0, z, 1.9, H3 + 4, ochre, trim);
      this.chhatri(b, x, H3 + 4, z, 1.5, trim, dome);
    }
    this._lights(-hwG, H1 + 0.2, Dp / 2 + 0.5, hwG, H1 + 0.2, Dp / 2 + 0.5, 24, '#ffe2a8');
    this._lights(-hwG, H1 + 0.2, -Dp / 2 - 0.5, hwG, H1 + 0.2, -Dp / 2 - 0.5, 24, '#ffe2a8');
    this._lights(-w3 / 2, H3 + 0.3, Dp / 2 - 2, w3 / 2, H3 + 0.3, Dp / 2 - 2, 16, '#ffe2a8');
    // keep footpaths and scenery out of the piers
    for (let k = -10; k <= 10; k++) { const j = (i + k + T.N) % T.N; this.noFoot[0][j] = 1; this.noFoot[1][j] = 1; }
    for (const s of [-1, 1]) {
      const p = T.pointAt(i * T.ds);
      const cx = p.x + p.tz * s * (a + pier / 2), cz = p.z - p.tx * s * (a + pier / 2);
      this.field.mark(cx, cz, pier + 3, Dp + 6, Math.atan2(p.tx, p.tz), 1);
    }
  },

  // ------------------------------------------------------------ traffic circles with statues
  _lm_circle(lm) {
    const T = this.track, hw = T.halfWidth;
    const R = 10.5;
    let f = null;
    for (const s of [lm.side, -lm.side]) {
      const ff = this.frameSide(lm.index, s, hw + 5.6 + R);
      if (this.field.rectFree(ff.cx, ff.cz, 2 * R - 2, 2 * R - 2, ff.ry, hw + 5.4)) { f = ff; lm.side = s; break; }
    }
    if (!f) f = this.frameSide(lm.index, lm.side, hw + 5.6 + R);
    this.field.mark(f.cx, f.cz, 2 * R + 2, 2 * R + 2, f.ry, 0.5);
    this.B.frame.copy(f.m);
    this._lmF = { cx: f.cx, cz: f.cz, ry: f.ry, sc: 1 };
    const sideIdx = lm.side > 0 ? 1 : 0;
    for (let k = -16; k <= 16; k++) this.noFoot[sideIdx][(lm.index + k + T.N) % T.N] = 1;
    const b = 'std';
    const n = 40;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU;
      this.box(b, Math.cos(a) * R, 0, Math.sin(a) * R, 0.45, 0.42, (TAU * R) / n + 0.05, k % 2 ? '#1c1c1c' : '#f2c500', -a);
    }
    this.cyl(b, 0, 0, 0, R - 0.1, 0.4, '#5c9a36', 32);
    this.cyl(b, 0, 0.4, 0, R - 1.2, 0.2, '#ff9f1c', 28);
    this.cyl(b, 0, 0.45, 0, R - 2.2, 0.2, '#4f8f30', 28);
    const name = (lm.label || '').toUpperCase();
    const top = 5.0;
    const statue = (kind) => {
      this.box(b, 0, 0.5, 0, 3.2, 4.0, 3.2, '#efe8da');
      this.box(b, 0, 0.5, 0, 3.6, 0.6, 3.6, '#c9bca2');
      this.box(b, 0, 4.5, 0, 3.6, 0.5, 3.6, '#c9bca2');
    };
    if (name.includes('KALA GHODA')) {
      // equestrian statue on a tall pedestal (black horse)
      this.box(b, 0, 0.5, 0, 4.2, 1.2, 6.2, '#c9bca2');
      this.box(b, 0, 1.7, 0, 3.4, 4.2, 5.2, '#efe8da');
      this.box(b, 0, 5.9, 0, 3.8, 0.4, 5.6, '#c9bca2');
      const g = 'gloss', k = '#18181a', y = 6.3;
      this.B.push(g, this.G.sphere, L(0, y + 2.6, 0, 0, 0.95, 0.95, 2.0), k);
      for (const [x, z, rx] of [[-0.45, 1.3, -0.35], [0.45, 1.5, 0.5], [-0.45, -1.4, 0.2], [0.45, -1.3, -0.15]]) this.cylBetween(g, x, y + 2.3, z, x, y, z + Math.sin(rx) * 1.2, 0.2, k);
      this.cylBetween(g, 0, y + 3.1, 1.6, 0, y + 4.6, 2.6, 0.5, k);
      this.B.push(g, this.G.box, L(0, y + 4.3, 2.9, 0, 0.5, 0.6, 1.3, 0.6), k);
      this.cylBetween(g, 0, y + 2.9, -1.9, 0, y + 1.4, -2.6, 0.18, k);
      this.cyl(g, 0, y + 3.2, -0.1, 0.45, 1.6, '#2a2a2c', 8, 0.38);
      this.sphere(g, 0, y + 5.2, -0.05, 0.34, '#2a2a2c');
      this.cyl(g, 0, y + 5.35, -0.05, 0.38, 0.35, '#2a2a2c', 8, 0.3);
      for (const s of [-1, 1]) this.cylBetween(g, s * 0.5, y + 4.6, 0, s * 0.62, y + 3.8, 0.6, 0.13, '#2a2a2c');
      for (const s of [-1, 1]) this.cylBetween(g, s * 0.42, y + 3.3, 0, s * 0.85, y + 2.2, 0.35, 0.16, '#2a2a2c');
    } else if (name.includes('CHAKLI')) {
      statue();
      const br = '#8a5a2b';
      this.sphere('metal', 0, top + 1.6, 0, 1.6, br, 0.85, 1.35);
      this.sphere('metal', 1.6, top + 2.4, 0, 0.9, '#7a4a22');
      this.cone('metal', 2.6, top + 2.35, 0, 0.25, 0.7, '#e0a020', 6);
      this.B.push('metal', this.G.boxC, L(-2.0, top + 2.0, 0, 0, 1.6, 0.25, 0.9, 0, 0.5), '#6e4420');
      this.B.push('metal', this.G.sphere, L(0, top + 2.0, 1.0, 0, 1.2, 0.5, 0.25, 0, 0.3), '#5e3a1a');
      this.B.push('metal', this.G.sphere, L(0, top + 2.0, -1.0, 0, 1.2, 0.5, 0.25, 0, 0.3), '#5e3a1a');
      this.cyl('metal', 0.3, top, 0.4, 0.08, 0.6, '#444', 6); this.cyl('metal', 0.3, top, -0.4, 0.08, 0.6, '#444', 6);
    } else if (name.includes('GENDA')) {
      statue();
      const gr = '#707478';
      this.box('gloss', 0, top + 1.0, 0, 3.6, 1.8, 1.8, gr);
      this.box('gloss', 2.1, top + 1.2, 0, 1.3, 1.2, 1.2, gr);
      this.cone('gloss', 2.7, top + 2.3, 0, 0.25, 0.9, '#d8d0c0', 6);
      for (const [x, z] of [[-1.3, -0.6], [-1.3, 0.6], [1.2, -0.6], [1.2, 0.6]]) this.box('gloss', x, top, z, 0.55, 1.1, 0.55, gr);
      this.box('gloss', 1.8, top + 2.3, 0.45, 0.2, 0.4, 0.1, gr); this.box('gloss', 1.8, top + 2.3, -0.45, 0.2, 0.4, 0.1, gr);
    } else {
      // fountain with a tiered basin and a central pillar (Natubhai / Amit Nagar / Susen)
      this.B.push(b, lathe('fountain', 28), L(0, 0.6, 0, 0, 5.2, 2.4, 5.2), '#ece4d4');
      this.cyl('water', 0, 0.75, 0, 4.7, 0.6, '#4a92b8', 28);
      this.cyl(b, 0, 0.6, 0, 1.2, 3.2, '#f4efe6', 12);
      this.B.push(b, lathe('fountain', 20), L(0, 3.8, 0, 0, 2.6, 1.8, 2.6), '#ece4d4');
      this.cyl('water', 0, 3.9, 0, 2.3, 0.35, '#4a92b8', 20);
      for (let k = 0; k < 10; k++) { const a = (k / 10) * TAU; this.cone('water', Math.cos(a) * 3.4, 1.2, Math.sin(a) * 3.4, 0.16, 2.2, '#d6eef8', 6); }
      this.cone('water', 0, 4.2, 0, 0.3, 3.4, '#d6eef8', 8);
      if (name.includes('NATUBHAI')) { this.cyl('metal', 0, 4.4, 0, 0.12, 2.4, '#7b5a3a', 6); }
    }
    const nm = (lm.label || 'CIRCLE').toUpperCase();
    const r = this.atlas.add('circ-' + nm, 640, 110, (g, w, h) => {
      g.fillStyle = '#0b4f9c'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#ffffff'; g.lineWidth = 4; roundRect(g, 5, 5, w - 10, h - 10, 8); g.stroke();
      fitText(g, nm, w / 2, h * 0.52, w * 0.88, h * 0.56, { color: '#ffffff' });
    });
    this.standSign(0, R - 2.3, r, 4.4, 0.76, 0.6, 0, '#9aa0a6');
    for (let k = 0; k < 8; k++) { const a = (k / 8) * TAU + 0.5; this.treeLocal(Math.cos(a) * (R - 1.6), Math.sin(a) * (R - 1.6), 'bush', 0.55); }
    this._lights(-R, 0.5, 0, R, 0.5, 0, 1);
  },

  // ------------------------------------------------------------ glass mall
  _lm_mall(lm) {
    const W = 86, D = 56;
    this._placeSide(lm, W, D, 6.6);
    const F = D / 2, b = 'std';
    this.box(b, 0, 0, 0, W, 0.07, D, '#8f8d88');
    for (let x = -W / 2 + 4; x < W / 2 - 3; x += 3) { this.box(b, x, 0.07, F - 5.5, 0.12, 0.02, 5, '#f4f4f4'); this.box(b, x, 0.07, F - 13, 0.12, 0.02, 5, '#f4f4f4'); }
    const mz = -F + 15, md = 28, mw = 74;
    const S = this._lmSoup(), T = this.SS.T;
    this.box('glass', 0, 0, mz, mw, 22, md, '#7fa6c0');
    this.winGridS(S, -mw / 2, mw / 2, 1.2, 22, mz + md / 2 + 0.04, [T.glassBlue[0], T.glassBlue[1], T.glassBlue[0]], '#ffffff', 4.2, 4.2);
    this.box(b, 0, 22, mz, mw + 1, 2.6, md + 1, '#ebe7df');
    this.box(b, 0, 0, mz, mw + 1, 1.2, md + 1, '#d8d3ca');
    for (let x = -mw / 2; x <= mw / 2; x += 8) this.box(b, x, 0, mz + md / 2 + 0.25, 0.9, 22, 0.9, '#f2efe8');
    this.box(b, 0, 0, mz + md / 2 + 1.5, 22, 26, 3, '#c4161c');
    this.box(b, 0, 6, mz + md / 2 + 6, 24, 0.6, 9, '#f2efe8');
    for (const x of [-10.5, 10.5]) this.cyl('gloss', x, 0, mz + md / 2 + 10, 0.25, 6, '#c8ccd0', 10);
    const sr = this.atlas.add('mall', 1000, 150, (g, w, h) => {
      g.fillStyle = '#c4161c'; g.fillRect(0, 0, w, h);
      fitText(g, 'GOTRI CENTRAL MALL', w / 2, h * 0.42, w * 0.92, h * 0.5, { color: '#ffffff' });
      fitText(g, 'FOOD COURT • MULTIPLEX • SHOPPING', w / 2, h * 0.8, w * 0.8, h * 0.18, { color: '#ffd8d8', weight: '800', family: FONT2 });
    });
    this.sign(0, 21, mz + md / 2 + 3.05, 20, 3, sr);
    this.sign(-24, 23.3, mz + md / 2 + 0.55, 22, 3.3, sr);
    this.sign(24, 23.3, mz + md / 2 + 0.55, 22, 3.3, sr);
    const mp = this.atlas.add('multiplex', 500, 500, (g, w, h) => {
      const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#2b0f54'); gr.addColorStop(1, '#ab1f65');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      fitText(g, 'NOW SHOWING', w / 2, h * 0.15, w * 0.8, h * 0.1, { color: '#ffd60a' });
      fitText(g, 'DHAADAK 3', w / 2, h * 0.45, w * 0.9, h * 0.2, { color: '#ffffff', stroke: '#000', strokeW: 6 });
      fitText(g, 'IN CINEMAS', w / 2, h * 0.75, w * 0.6, h * 0.08, { color: '#ffffff', weight: '800', family: FONT2 });
    });
    this.sign(mw / 2 - 9, 13, mz + md / 2 + 0.6, 10, 10, mp);
    this.box('glass', 0, 0, mz + md / 2 + 3.0, 12, 5.5, 0.1, '#9cc4dc');
    const cols = ['#c8102e', '#f2f2f0', '#1f4fa8', '#9aa3ad', '#1b1b1f', '#e5601d'];
    for (let k = 0; k < 13; k++) {
      const x = -W / 2 + 6 + k * 6.1 + (k % 3) * 0.4, z = F - (k % 2 ? 5.5 : 13);
      if (Math.abs(x) < 7) continue;
      this.box('gloss', x, 0.25, z, 1.6, 0.75, 3.6, cols[k % cols.length]);
      this.box('gloss', x, 1.0, z - 0.2, 1.45, 0.55, 2.0, '#2a3440');
    }
    for (let x = -W / 2 + 3; x < W / 2; x += 7) this.treeLocal(x, F - 1.5, 'ashoka', 0.85);
  },

  // ------------------------------------------------------------ Sayaji Baug + Baroda Museum, toy train
  _lm_sayajibaug(lm) {
    const W = 100, D = 76;
    const f = this._placeSide(lm, W, D, 6.6);
    const F = D / 2, b = 'std';
    this.box(b, 0, 0, 0, W, 0.06, D, '#5a9a38');
    for (let x = -W / 2; x <= W / 2; x += 2.5) if (Math.abs(x) > 7) this.box(b, x, 0, F - 0.3, 0.18, 1.6, 0.18, '#2d4a2d');
    for (const [x0, x1] of [[-W / 2, -7], [7, W / 2]]) { this.box(b, (x0 + x1) / 2, 1.4, F - 0.3, x1 - x0, 0.12, 0.12, '#2d4a2d'); this.box(b, (x0 + x1) / 2, 0.5, F - 0.3, x1 - x0, 0.12, 0.12, '#2d4a2d'); }
    const maroon = '#6b1a1a', sand = '#e2c08f';
    for (const s of [-1, 1]) { this.box(b, s * 6.5, 0, F - 0.3, 1.6, 6, 1.6, sand); this.domeL(b, 'onion', s * 6.5, 6, F - 0.3, 1.0, 1.8, '#f3e7cf'); }
    this.box(b, 0, 5, F - 0.3, 12, 1.6, 0.9, maroon);
    const gr = this.atlas.add('baug', 800, 120, (g, w, h) => {
      g.fillStyle = '#6b1a1a'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#e2b04a'; g.lineWidth = h * 0.05; g.strokeRect(h * 0.08, h * 0.08, w - h * 0.16, h - h * 0.16);
      fitText(g, 'SAYAJI BAUG', w / 2, h * 0.44, w * 0.9, h * 0.5, { color: '#ffd166' });
      fitText(g, 'KAMATI BAUG • ESTD. 1879', w / 2, h * 0.8, w * 0.7, h * 0.18, { color: '#ffffff', weight: '800', family: FONT2 });
    });
    this.sign(0, 5.8, F + 0.17, 11.6, 1.5, gr);
    this.sign(0, 5.8, F - 0.77, 11.6, 1.5, gr, Math.PI);
    // Baroda Museum & Picture Gallery: red brick Indo-Saracenic with domed corner towers
    const brick = '#a8483a', stone = '#ecdcbc', dome = '#efe3cc', gold = '#d4a937';
    const mx = 22, mz = -F + 14, mw = 40;
    this.box(b, mx, 0, mz - 5, mw, 13, 10, brick);
    this.arcade(b, mx, 0, mz + 2.4, mw, 6.4, 9, { col: brick, trim: stone, pointed: 0.3, depth: 0.6 });
    this.arcade(b, mx, 6.9, mz + 2.4, mw, 5.6, 9, { col: brick, trim: stone, pointed: 0.3, depth: 0.6, sill: 0.9 });
    for (const y of [6.4, 12.5]) this.box(b, mx, y, mz - 1, mw + 0.6, 0.5, 7.6, stone);
    this.kanguras(b, mx - mw / 2, mx + mw / 2, 13, mz + 2.2, stone, 0.6);
    for (const s of [-1, 1]) { this.octTower(b, mx + s * (mw / 2), 0, mz + 2, 2.2, 17, brick, stone); this.domeL(b, 'onion', mx + s * (mw / 2), 17, mz + 2, 2.5, 4.2, dome, gold); }
    this.box(b, mx, 0, mz + 1, 10, 16, 6, brick);
    this.cyl(b, mx, 16, mz + 1, 3.2, 1.4, stone, 8);
    this.domeL(b, 'onion', mx, 17.4, mz + 1, 3.4, 5.6, dome, gold);
    const mr = this.atlas.add('museum', 700, 100, (g, w, h) => {
      g.fillStyle = '#ecdcbc'; g.fillRect(0, 0, w, h);
      fitText(g, 'BARODA MUSEUM & PICTURE GALLERY', w / 2, h * 0.55, w * 0.92, h * 0.5, { color: '#6b1a1a', family: FONT_SERIF, weight: '700' });
    });
    this.sign(mx, 13.6, mz + 4.1, 9, 1.3, mr, 0, 'deco');
    // toy train loop
    const cz = 4, Ls = 34, R = 11, cxo = -16;
    const path = (t) => {
      const per = 2 * Ls + TAU * R;
      let s = (((t % 1) + 1) % 1) * per;
      if (s < Ls) return [cxo - Ls / 2 + s, cz + R, 0];
      s -= Ls;
      if (s < Math.PI * R) { const a2 = s / R; return [cxo + Ls / 2 + Math.sin(a2) * R, cz + Math.cos(a2) * R, -a2]; }
      s -= Math.PI * R;
      if (s < Ls) return [cxo + Ls / 2 - s, cz - R, -Math.PI];
      s -= Ls;
      const a2 = s / R; return [cxo - Ls / 2 - Math.sin(a2) * R, cz - Math.cos(a2) * R, -Math.PI - a2];
    };
    const per = 2 * Ls + TAU * R, segs = Math.floor(per / 1.6);
    for (let k = 0; k < segs; k++) {
      const [x, z, a2] = path(k / segs);
      this.box(b, x, 0.06, z, 2.0, 0.12, 0.32, '#6b4a2e', a2 + Math.PI / 2);
      const nx = Math.sin(a2 + Math.PI / 2), nz = Math.cos(a2 + Math.PI / 2);
      for (const o of [-0.5, 0.5]) this.box('gloss', x + nx * o, 0.18, z + nz * o, 0.08, 0.1, 1.66, '#8a8f96', a2 + Math.PI / 2);
    }
    this.box(b, cxo, 0, cz, 7, 0.6, 7, '#efe6d6');
    this.chhatri(b, cxo, 0.6, cz, 3, '#f8f4ec', '#f8f4ec');
    for (let k = 0; k < 26; k++) {
      const x = (this.rnd() - 0.5) * (W - 8), z = (this.rnd() - 0.5) * (D - 10);
      const inLoop = Math.abs(z - cz) < R + 3 && Math.abs(x - cxo) < Ls / 2 + R + 3;
      if (inLoop && !(Math.abs(z - cz) < R - 4 && Math.abs(x - cxo) < Ls / 2 - 2 && Math.abs(x - cxo) > 6)) continue;
      if (z > F - 6 && Math.abs(x) < 10) continue;
      if (Math.abs(x - mx) < mw / 2 + 4 && z < mz + 8) continue;
      this.treeLocal(x, z, k % 4 === 0 ? 'banyan' : k % 3 === 0 ? 'ashoka' : 'neem', 1.05);
    }
    for (let x = -W / 2 + 4; x < W / 2 - 3; x += 6) if (Math.abs(x) > 9) this.treeLocal(x, F - 3, 'bush', 0.8);
    const frame = f.m.clone();
    const cars = [];
    const mkCar = (engine, color) => {
      const bb = new this.B.constructor();
      const push = (geo, mm, c) => bb.push('std', geo, mm, c);
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
      const g = bb.merged('std');
      const mesh = new THREE.Mesh(g, this.M.std);
      this.root.add(mesh); this._track(g);
      mesh.castShadow = this.QL.shadows;
      return mesh;
    };
    const tmpM = new THREE.Matrix4(), _p = new THREE.Vector3(), _qq = new THREE.Quaternion(), _sc = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
    this._pendingTrain = () => {
      cars.push(mkCar(true), mkCar(false, '#1d4e89'), mkCar(false, '#2b9348'), mkCar(false, '#ffb703'));
      this._anims.push((dt, t) => {
        cars.forEach((c, k) => {
          const [x, z, a2] = path((t * 3.2 - k * 2.8) / per);
          tmpM.compose(_p.set(x, 0.18, z), _qq.setFromAxisAngle(up, a2 + Math.PI / 2), _sc);
          c.matrixAutoUpdate = false;
          c.matrix.multiplyMatrices(frame, tmpM);
          c.matrixWorldNeedsUpdate = true;
        });
      });
    };
  },

  // ------------------------------------------------------------ Vadodara Junction railway station
  stationRect() {
    return this.atlas.add('station', 1000, 300, (g, w, h) => {
      g.fillStyle = '#f7d117'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#111'; g.lineWidth = h * 0.04; g.strokeRect(h * 0.04, h * 0.04, w - h * 0.08, h - h * 0.08);
      fitText(g, 'વડોદરા જં.', w / 2, h * 0.2, w * 0.6, h * 0.22, { color: '#111', weight: '700', family: FONT_GU });
      fitText(g, 'वडोदरा जं.', w / 2, h * 0.46, w * 0.6, h * 0.22, { color: '#111', weight: '700', family: FONT_HI });
      fitText(g, 'VADODARA JN.', w / 2, h * 0.76, w * 0.86, h * 0.3, { color: '#111' });
    });
  },
  _lm_station(lm) {
    const W = 108, D = 46;
    this._placeSide(lm, W, D, 6.6);
    const F = D / 2, b = 'std';
    const cream = '#f0dcae', brown = '#8e2b22', roof = '#9c3b2b';
    this.box(b, 0, 0, 0, W, 0.07, D, '#a7a29a');
    const bx = -14, bz = -F + 11, bw = 64, bd = 14;
    this.box(b, bx, 0, bz, bw, 11, bd, cream);
    this.arcade(b, bx, 0, bz + bd / 2 + 2.4, bw, 4.6, 16, { col: cream, trim: brown, pointed: 0.0, depth: 0.5, frac: 0.82 });
    this.box(b, bx, 4.6, bz + bd / 2 + 1.2, bw + 0.3, 0.5, 2.6, brown);
    this.box(b, bx, 11, bz, bw + 0.6, 0.6, bd + 0.6, brown);
    const fac = this._facadeArches('station-fac', 900, 90, { bg: cream, trim: '#fff7e6', dark: '#3a2a22', rows: 1, n: 20, band: brown, lit: this.P.windows > 0.3 });
    this.sign(bx, 7.9, bz + bd / 2 + 0.04, bw, 5.4, fac, 0, 'deco');
    for (const s of [-1, 1]) this.box(b, bx, 11.4, bz + s * 3.2, bw + 1, 0.3, 7.6, roof);
    this.B.push(b, this.G.box, L(bx, 11.4, bz, 0, bw + 1, 2.2, 0.6), roof);
    const cz = bz + bd / 2 + 2;
    this.box(b, bx, 0, cz - 1, 18, 17, 6, cream);
    this.box(b, bx, 17, cz - 1, 18.8, 0.7, 6.8, brown);
    this.chhatri(b, bx, 17.7, cz - 1, 2.0, cream, '#f7efe0');
    this.box(b, bx, 6, cz + 4, 20, 0.6, 8, brown);
    for (const x of [-9, -3, 3, 9]) this.cyl(b, bx + x, 0, cz + 7.6, 0.35, 6, '#fff7e6', 10);
    const clockR = this.clockRect();
    this.sign(bx, 14.6, cz + 2.04, 3.2, 3.2, clockR, 0, 'deco');
    const st = this.stationRect();
    this.sign(bx, 9.6, cz + 2.04, 12, 3.6, st);
    const big = this.atlas.add('vdr-big', 1200, 120, (g, w, h) => {
      g.fillStyle = '#8e2b22'; g.fillRect(0, 0, w, h);
      fitText(g, 'VADODARA JUNCTION • भारतीय रेल', w / 2, h * 0.55, w * 0.94, h * 0.62, { color: '#ffffff', family: FONT_HI + ', ' + FONT, weight: '800' });
    });
    this.sign(bx, 11.6, bz + bd / 2 + 0.4, 36, 1.8, big);
    for (const px of [bx + 14, bx + 21]) this.box(b, px, 0, F - 3, 0.2, 3.2, 0.2, '#111');
    this.sign(bx + 17.5, 3.6, F - 2.88, 8, 2.4, st);
    this.sign(bx + 17.5, 3.6, F - 3.12, 8, 2.4, st, Math.PI);
    const px = 36;
    this.box(b, px, 0, -2, 30, 1.0, 9, '#bdb6a8');
    this.box(b, px, 1.0, -2 + 4.2, 30, 0.02, 0.4, '#f2c500');
    for (let x = px - 13; x <= px + 13; x += 6.5) this.box('gloss', x, 1, -2, 0.3, 4.2, 0.3, '#2e6b5e');
    this.box('gloss', px, 5.2, -2, 31, 0.3, 8, '#2e6b5e');
    for (let k = 0; k < 2; k++) {
      const z = -9.5, x = px - 7.5 + k * 15;
      this.box('gloss', x, 0.9, z, 14.4, 3.0, 3.1, '#25418a');
      this.box('gloss', x, 2.1, z, 14.42, 0.7, 3.12, '#e8e2d4');
      for (let w = -6; w <= 6; w += 1.5) this.box('gloss', x + w, 2.15, z + 1.57, 0.8, 0.6, 0.04, '#2b2f36');
      this.box(b, x, 3.9, z, 14.2, 0.3, 2.9, '#6b7078');
      this.box(b, x, 0.2, z, 13, 0.7, 2.4, '#222');
    }
    this.box(b, px, 0, -9.5, 34, 0.25, 3.4, '#5a4a3a');
    for (let x = -W / 2 + 4; x < W / 2; x += 9) this.treeLocal(x, F - 1.6, 'neem', 0.9);
    // autos queued at the station entrance (auto stand)
    for (let k = 0; k < 6; k++) { _w.set(bx - 10 + k * 2.0, 0, F - 7).applyMatrix4(this.B.frame); this.I.auto.add(L(_w.x, 0.02, _w.z, this._lmF.ry + Math.PI / 2 + 0.25), '#ffffff'); }
  },

  // ------------------------------------------------------------ MSU Faculty of Arts (the great dome)
  _lm_msu(lm) {
    const W = 112, D = 74;
    this._placeSide(lm, W, D, 7);
    const F = D / 2, b = 'std';
    const brick = '#b0533a', brick2 = '#9c4630', stone = '#ecdcbc', dome = '#8d8278', rib = '#b8ada0', gold = '#d4a937';
    this.box(b, 0, 0, 0, W, 0.06, D, '#5b9637');
    this.box(b, 0, 0.02, F - 10, 9, 0.07, 20, '#cfc2a4');
    for (const [x0, x1] of [[-W / 2, -6], [6, W / 2]]) { this.box(b, (x0 + x1) / 2, 0, F - 0.4, x1 - x0, 1.1, 0.5, brick2); this.box(b, (x0 + x1) / 2, 1.1, F - 0.4, x1 - x0, 0.15, 0.62, stone); }
    for (const x of [-6, 6]) { this.box(b, x, 0, F - 0.4, 1.6, 4.4, 1.6, brick); this.box(b, x, 4.4, F - 0.4, 2, 0.3, 2, stone); this.domeL(b, 'onion', x, 4.7, F - 0.4, 0.8, 1.5, stone, gold, 8); }
    const ur = this.atlas.add('msu-gate', 1100, 150, (g, w, h) => {
      g.fillStyle = '#5a1f14'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#ecdcbc'; g.lineWidth = 4; g.strokeRect(6, 6, w - 12, h - 12);
      fitText(g, 'THE MAHARAJA SAYAJIRAO UNIVERSITY OF BARODA', w / 2, h * 0.38, w * 0.92, h * 0.3, { color: '#ffffff', family: FONT_SERIF, weight: '700' });
      fitText(g, 'FACULTY OF ARTS', w / 2, h * 0.74, w * 0.6, h * 0.3, { color: '#f4d58a' });
    });
    this.box(b, 0, 4.0, F - 0.4, 12.4, 1.8, 0.6, '#5a1f14');
    this.sign(0, 4.9, F - 0.08, 12, 1.65, ur);
    this.sign(0, 4.9, F - 0.72, 12, 1.65, ur, Math.PI);
    const mz = -F + 30, mw = 92;
    // two-storey arcaded front block
    this.box(b, 0, 0, mz - 7, mw, 14, 14, brick);
    this.arcade(b, 0, 0, mz + 2.6, mw, 6.8, 20, { col: brick, trim: stone, pointed: 0.32, depth: 0.7, t: 0.35 });
    this.box(b, 0, 6.8, mz + 1.3, mw + 0.6, 0.55, 3.0, stone);
    this.arcade(b, 0, 7.35, mz + 2.6, mw, 6.3, 20, { col: brick, trim: stone, pointed: 0.32, depth: 0.6, sill: 0.9, t: 0.32 });
    this.box(b, 0, 13.65, mz - 5.6, mw + 0.8, 0.5, 17.2, stone);
    this.kanguras(b, -mw / 2, mw / 2, 14.15, mz + 2.5, stone, 0.6);
    for (const s of [-1, 1]) {
      this.octTower(b, s * mw / 2, 0, mz + 2, 2.6, 19, brick, stone);
      this.domeL(b, 'onion', s * mw / 2, 19, mz + 2, 2.9, 4.6, stone, gold);
      // E-shaped wings running back
      this.box(b, s * (mw / 2 - 7), 0, mz - 30, 14, 13.6, 24, brick);
      this.box(b, s * (mw / 2 - 7), 13.6, mz - 30, 14.6, 0.5, 24.6, stone);
    }
    // central block, porch and the great dome on an octagonal drum
    this.box(b, 0, 0, mz - 9, 32, 21, 26, brick);
    this.box(b, 0, 0, mz + 2.2, 16, 17, 5, brick);
    this.arcade(b, 0, 0, mz + 4.75, 16, 15.5, 1, { col: brick, trim: stone, pointed: 0.35, frac: 0.86, depth: 1.2, pier: 0.36, t: 0.6, back: '#4a2a20' });
    this.box(b, 0, 17, mz + 2.2, 16.8, 0.6, 5.6, stone);
    this.kanguras(b, -8, 8, 17.6, mz + 4.7, stone, 0.6);
    for (const s of [-1, 1]) { this.octTower(b, s * 8.3, 0, mz + 4.6, 1.0, 21, brick, stone); this.domeL(b, 'onion', s * 8.3, 21, mz + 4.6, 1.2, 2.2, stone, gold, 10); }
    this.box(b, 0, 21, mz - 9, 33, 0.6, 27, stone);
    const dz = mz - 9;
    this.cyl(b, 0, 21.6, dz, 12.6, 6.4, brick, 8);
    for (let k = 0; k < 8; k++) {
      const a = (k + 0.5) * TAU / 8;
      this.blindArch(b, Math.sin(a) * 11.68, 22.6, dz + Math.cos(a) * 11.68, 3.2, 4.2, '#3a2a22', a, 0.3);
    }
    this.cyl(b, 0, 27.6, dz, 13.0, 0.6, stone, 8);
    this.kanguras(b, -5, 5, 28.2, dz + 11.6, stone, 0.6);
    this.domeL(b, 'gumbaz', 0, 28.2, dz, 12.2, 13.5, dome, null, 28);
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * TAU, pts = LATHE.gumbaz;
      for (let j = 0; j < pts.length - 1; j++) {
        const [r0, y0] = pts[j], [r1, y1] = pts[j + 1];
        this.cylBetween(b, Math.cos(a) * r0 * 12.3, 28.2 + y0 * 13.6, dz + Math.sin(a) * r0 * 12.3, Math.cos(a) * r1 * 12.3, 28.2 + y1 * 13.6, dz + Math.sin(a) * r1 * 12.3, 0.22, rib);
      }
    }
    this.cyl(b, 0, 41.5, dz, 1.6, 1.8, stone, 8);
    this.domeL(b, 'onion', 0, 43.3, dz, 1.5, 2.6, stone, gold, 10);
    for (const a of [-1, 1]) for (const c of [-1, 1]) { this.octTower(b, a * 14.5, 21.6, dz + c * 11.5, 1.2, 9, brick, stone); this.domeL(b, 'onion', a * 14.5, 30.6, dz + c * 11.5, 1.5, 2.8, stone, gold, 10); }
    this._lights(-mw / 2, 13.9, mz + 2.8, mw / 2, 13.9, mz + 2.8, 50);
    for (let x = -W / 2 + 4; x <= W / 2 - 4; x += 8) if (Math.abs(x) > 9) this.treeLocal(x, F - 4, x % 16 ? 'neem' : 'banyan', 1.05);
    for (const x of [-W / 2 + 4, W / 2 - 4]) for (let z = -F + 6; z < F - 10; z += 10) this.treeLocal(x, z, 'neem', 1.1);
  },

  // ------------------------------------------------------------ EME Temple (aluminium geodesic dome)
  _lm_eme(lm) {
    const W = 78, D = 68;
    this._placeSide(lm, W, D, 7);
    const F = D / 2, b = 'std', al = 'alu';
    const white = '#efebe2', silver = '#cfd3d8', gold = '#e0b03a';
    this.box(b, 0, 0, 0, W, 0.06, D, '#5d9a38');
    this.box(b, 0, 0.02, F - 12, 5, 0.07, 24, '#d8d2c4');
    // whitewashed army kerbs around the lawn
    for (let k = 0; k < 40; k++) this.box(b, -W / 2 + 1 + k * (W - 2) / 39, 0, F - 1.0, (W - 2) / 40 - 0.1, 0.3, 0.35, k % 2 ? '#f4f4f0' : '#1e1e1e');
    const cz = -4;
    // 75 x 75 ft plinth
    this.box(b, 0, 0, cz, 23, 1.8, 23, white);
    for (let k = 0; k < 4; k++) this.box(b, 0, 0, cz + 11.5 + 0.5 + k * 0.6, 8 - k * 0.6, 1.8 - k * 0.45, 0.6, '#e0dbcf');
    // sabhamandap: faceted geodesic dome clad in aluminium
    this.B.push(al, geodesicHalf(2), L(0, 1.8, cz + 1, 0.3, 10.5, 9.2, 10.5), silver);
    this.cyl(b, 0, 1.8, cz + 1, 10.4, 0.5, white, 20);
    // arched entrance portico
    this.box(b, 0, 1.8, cz + 10.5, 6.4, 5.6, 3.4, white);
    this.blindArch(b, 0, 1.8, cz + 12.22, 3.4, 4.4, '#2b2a28', 0, 0.2);
    this.B.push(al, this.G.boxC, L(0, 7.7, cz + 10.5, 0, 7.2, 0.5, 4.2), silver);
    // aluminium shikhara (~21 m) above the sanctum
    const sz = cz - 6;
    this.box(al, 0, 1.8, sz, 7.5, 4.5, 7.5, silver);
    let y = 6.3, r = 4.6;
    for (let k = 0; k < 4; k++) {
      const h = [5.5, 4.6, 3.8, 3.2][k], r2 = r * 0.7;
      this.B.push(al, cached(`frust${k}`, () => new THREE.CylinderGeometry(r2 / r, 1, 1, 8, 1).translate(0, 0.5, 0)), L(0, y, sz, Math.PI / 8, r, h, r), silver);
      this.cyl(al, 0, y + h - 0.2, sz, r2 * 1.06, 0.35, '#e7eaed', 8);
      y += h; r = r2;
    }
    this.cone(al, 0, y, sz, r, 2.8, silver, 8, Math.PI / 8);
    this.B.push('metal', lathe('amalaka', 12), L(0, y + 2.7, sz, 0, 0.9, 0.5, 0.9), gold);
    this.sphere('metal', 0, y + 3.6, sz, 0.45, gold, 1.3);
    this.cone('metal', 0, y + 4.1, sz, 0.12, 1.2, gold, 6);
    this.cylBetween('gloss', 0.4, y + 2.8, sz, 0.4, y + 7.5, sz, 0.05, '#555');
    const fl = this.atlas.add('bhagwa', 128, 96, (g, w, h) => { g.fillStyle = '#ff7a00'; g.beginPath(); g.moveTo(0, 0); g.lineTo(w, h * 0.5); g.lineTo(0, h); g.fill(); g.fillStyle = '#ffb000'; g.beginPath(); g.moveTo(0, h * 0.3); g.lineTo(w * 0.55, h * 0.5); g.lineTo(0, h * 0.7); g.fill(); });
    this.sign(1.2, y + 6.8, sz, 1.6, 1.1, fl, 0.3); this.sign(1.2, y + 6.8, sz - 0.01, 1.6, 1.1, { u0: fl.u1, u1: fl.u0, v0: fl.v0, v1: fl.v1 }, 0.3 + Math.PI);
    // small faceted shrines on the plinth corners (navgraha)
    for (const a of [-1, 1]) for (const c of [-1, 1]) { this.B.push(al, geodesicHalf(1), L(a * 9.2, 1.8, cz + c * 9.2, 0, 1.6, 1.8, 1.6), silver); this.cyl('metal', a * 9.2, 3.5, cz + c * 9.2, 0.12, 0.8, gold, 6); }
    this._lights(-10.5, 1.9, cz + 11.6, 10.5, 1.9, cz + 11.6, 14, '#fff3d0');
    // signboards
    const er = this.atlas.add('eme', 900, 160, (g, w, h) => {
      g.fillStyle = '#24361c'; g.fillRect(0, 0, w, h);
      for (let k = 0; k < 8; k++) { g.fillStyle = k % 2 ? '#ffd23f' : '#c1121f'; g.fillRect(k * 10, 0, 10, h); g.fillRect(w - (k + 1) * 10, 0, 10, h); }
      fitText(g, 'DAKSHINAMURTI TEMPLE', w / 2, h * 0.36, w * 0.76, h * 0.34, { color: '#ffd23f' });
      fitText(g, 'EME TEMPLE • EME CENTRE, VADODARA', w / 2, h * 0.72, w * 0.76, h * 0.2, { color: '#ffffff', weight: '800', family: FONT2 });
    });
    this.standSign(-12, F - 3.2, er, 7.2, 1.3, 1.2, 0, '#f4f4f0');
    // garden sculptures + neat army trees
    for (const [x, z] of [[-24, 10], [24, 10], [-24, -18], [24, -18]]) { this.box(b, x, 0, z, 1.6, 1.2, 1.6, white); this.sphere(al, x, 2.0, z, 0.9, silver); }
    for (let x = -W / 2 + 4; x <= W / 2 - 4; x += 7) if (Math.abs(x) > 6) this.treeLocal(x, F - 4, 'ashoka', 0.95);
    for (const x of [-W / 2 + 4, W / 2 - 4]) for (let z = -F + 6; z < F - 10; z += 9) this.treeLocal(x, z, 'neem', 1.05);
    for (let x = -18; x <= 18; x += 12) this.lawnLamp(x, F - 8);
  },

  // ------------------------------------------------------------ Vadodara Airport (Harni)
  _lm_airport(lm) {
    const W = 172, D = 112;
    this._placeSide(lm, W, D, 7);
    const F = D / 2, b = 'std';
    this.box(b, 0, 0, 0, W, 0.06, D, '#9b9a94');
    this.box(b, 0, 0.02, -F + 17, W, 0.06, 34, '#8a8984');
    for (let x = -W / 2 + 10; x < W / 2; x += 18) this.box(b, x, 0.08, -F + 22, 8, 0.02, 0.3, '#f2c500');
    const Lt = 132, zf = F - 34;
    // landside kerb and lawn strip
    this.box(b, 0, 0, zf + 6, Lt, 0.25, 8, '#c9c4b8');
    this.box(b, 0, 0, F - 3.5, W, 0.12, 7, '#5d9a38');
    // glass curtain wall + mullions
    this.box('glass', 0, 0, zf - 0.3, Lt, 12, 0.6, '#7fa6c0');
    const S = this._lmSoup(), T = this.SS.T;
    this.winGridS(S, -Lt / 2, Lt / 2, 0.2, 12, zf + 0.02, [T.glassBlue[0], T.glassBlue[1]], '#ffffff', 6, 6);
    this.box(b, 0, 0, zf - 22, Lt, 12, 44, '#e8e6e0');
    // the single sweeping arched metal roof
    const R = 70, chord = 60, th = 2 * Math.asin(chord / 2 / R), sag = R * (1 - Math.cos(th / 2)), base = 12.4;
    const roofG = cached('aroof', () => new THREE.CylinderGeometry(R, R, Lt + 10, 40, 1, true, Math.PI / 2 - th / 2, th).rotateZ(Math.PI / 2));
    const rz = zf + 10 - chord / 2;
    this.B.push('alu', roofG, L(0, base - R * Math.cos(th / 2), rz), '#c3c9cf');
    this.B.push(b, cached('aroofU', () => flipped(roofG)), L(0, base - R * Math.cos(th / 2) - 0.25, rz), '#e9eaea');
    for (const s of [-1, 1]) {
      const pts = [];
      for (let k = 0; k <= 20; k++) { const a = -th / 2 + (k / 20) * th; pts.push([Math.sin(a) * R, Math.cos(a) * R - R * Math.cos(th / 2)]); }
      const shp = new THREE.Shape([[pts[0][0], -base], ...pts, [pts[20][0], -base]].map(V2));
      const eg = new THREE.ExtrudeGeometry(shp, { depth: 0.6, bevelEnabled: false, curveSegments: 1 });
      this.B.push('alu', eg, L(s * (Lt / 2 + 5), base, rz, Math.PI / 2), '#b3bac1'); eg.dispose();
    }
    for (let x = -Lt / 2 + 4; x <= Lt / 2 - 4; x += 16) { this.cyl('gloss', x, 0, zf + 8, 0.35, base + 0.6, '#d9dde0', 10); this.cylBetween('gloss', x, 8, zf + 8, x - 3, base + 0.5, zf + 8, 0.15, '#d9dde0'); this.cylBetween('gloss', x, 8, zf + 8, x + 3, base + 0.5, zf + 8, 0.15, '#d9dde0'); }
    const ar = this.atlas.add('airport', 1400, 150, (g, w, h) => {
      g.fillStyle = '#1b2a4a'; g.fillRect(0, 0, w, h);
      fitText(g, 'VADODARA AIRPORT', w * 0.5, h * 0.5, w * 0.9, h * 0.66, { color: '#ffffff' });
    });
    const ah = this.atlas.add('airport-hi', 1200, 150, (g, w, h) => {
      g.fillStyle = '#1b2a4a'; g.fillRect(0, 0, w, h);
      fitText(g, 'वडोदरा हवाई अड्डा  •  વડોદરા હવાઈ મથક', w / 2, h * 0.52, w * 0.92, h * 0.62, { color: '#ffffff', weight: '700', family: FONT_HI + ', ' + FONT_GU });
    });
    this.box(b, 0, 12.2, zf + 9.6, 44, 3.2, 0.5, '#1b2a4a');
    this.sign(0, 13.8, zf + 9.88, 42, 3.0, ar);
    this.sign(0, 9.6, zf + 0.08, 30, 2.4, ah);
    const dep = this.atlas.add('departure', 500, 100, (g, w, h) => { g.fillStyle = '#ffd60a'; g.fillRect(0, 0, w, h); fitText(g, '✈ DEPARTURE • प्रस्थान', w / 2, h * 0.55, w * 0.9, h * 0.6, { color: '#111', family: FONT_HI + ', ' + FONT, weight: '800' }); });
    for (const x of [-30, 30]) this.sign(x, 5.0, zf + 0.1, 10, 1.6, dep);
    // control tower
    const tx = Lt / 2 + 14, tz = -F + 30;
    this.cyl(b, tx, 0, tz, 2.4, 30, '#f2f0ea', 12, 2.0);
    this.cyl(b, tx, 30, tz, 3.4, 1.0, '#d9d6cf', 8);
    this.cyl('glass', tx, 31, tz, 4.2, 3.6, '#5d87a3', 8, 4.6);
    this.cyl(b, tx, 34.6, tz, 4.9, 0.8, '#e9e6de', 8, 4.2);
    this.cylBetween('gloss', tx, 35.4, tz, tx, 41, tz, 0.08, '#c33');
    if (this.P.lamps > 0) this.sphere('glow', tx, 41.2, tz, 0.3, '#ff3b30');
    // parked aircraft on the apron (airside, behind the terminal)
    const plane = (x, z, tail) => {
      const g = 'gloss';
      this.B.push(g, cached('fus', () => new THREE.CylinderGeometry(1.9, 1.9, 1, 16).rotateZ(Math.PI / 2)), L(x, 3.1, z, 0, 30, 1, 1), '#f4f5f6');
      this.B.push(g, this.G.sphere, L(x + 15, 3.1, z, 0, 3.4, 1.9, 1.9), '#f4f5f6');
      this.B.push(g, cached('tailc', () => new THREE.ConeGeometry(1.9, 1, 16).rotateZ(Math.PI / 2)), L(x - 18.5, 3.5, z, 0, 7, 1, 0.9), '#f4f5f6');
      this.box(g, x + 15.6, 3.5, z, 1.4, 0.7, 2.4, '#1d2733');
      for (const s of [-1, 1]) {
        this.B.push(g, this.G.boxC, L(x - 1, 2.4, z + s * 8, -s * 0.35, 5, 0.3, 15), '#e8eaec');
        this.B.push(g, cached('eng', () => new THREE.CylinderGeometry(1, 1, 1, 12).rotateZ(Math.PI / 2)), L(x + 1.4, 1.7, z + s * 5.4, 0, 3.6, 0.85, 0.85), '#c9ced3');
        this.B.push(g, this.G.boxC, L(x - 18, 4.2, z + s * 3.2, -s * 0.3, 2.6, 0.2, 5.5), '#e8eaec');
      }
      this.B.push(g, this.G.boxC, L(x - 18.5, 7.4, z, 0, 4.4, 6.0, 0.3, 0, -0.45), tail);
      for (let k = -12; k <= 12; k += 1.1) this.box(g, x + k, 3.55, z + 1.86, 0.4, 0.42, 0.05, '#1d2733');
      for (const [ox, oz] of [[12, 0], [-2, -2.6], [-2, 2.6]]) this.cyl('std', x + ox, 0, z + oz, 0.45, 1.3, '#222', 10);
    };
    plane(-20, -F + 15, '#1d3f8c');
    plane(34, -F + 15, '#e36414');
    // landside parking and palms
    const cols = ['#c8102e', '#f2f2f0', '#1f4fa8', '#9aa3ad', '#1b1b1f', '#e5601d'];
    for (let k = 0; k < 18; k++) {
      const x = -W / 2 + 8 + k * 9.2, z = F - 10 - (k % 3) * 0.3;
      if (Math.abs(x) < 8) continue;
      this.box('gloss', x, 0.25, z, 1.6, 0.75, 3.6, cols[k % cols.length]);
      this.box('gloss', x, 1.0, z - 0.2, 1.45, 0.55, 2.0, '#2a3440');
    }
    for (let x = -W / 2 + 5; x < W / 2; x += 10) this.palm(x, F - 4, 8.5);
    const mono = this.atlas.add('air-mono', 300, 600, (g, w, h) => {
      g.fillStyle = '#1b2a4a'; g.fillRect(0, 0, w, h);
      fitText(g, '✈', w / 2, h * 0.2, w * 0.5, h * 0.18, { color: '#ffd60a' });
      for (const [k, t] of ['VADODARA', 'AIRPORT', 'HARNI'].entries()) fitText(g, t, w / 2, h * (0.45 + k * 0.16), w * 0.86, h * 0.12, { color: k === 2 ? '#9fb4d8' : '#ffffff' });
    });
    this.box(b, 18, 0, F - 2.5, 3.2, 7, 1.2, '#1b2a4a');
    this.sign(18, 3.6, F - 1.88, 3, 6, mono);
  },

  // ------------------------------------------------------------ Harni Motnath lake & temple
  _lm_harnilake(lm) {
    const W = 96, D = 84;
    this._placeSide(lm, W, D, 7);
    const F = D / 2, b = 'std';
    const cz = -6, R = 26;
    this.box(b, 0, 0, 0, W, 0.06, D, '#6a9a3e');
    const prof = [[R + 4, 0.0], [R + 4, 0.6], [R + 2.6, 0.6], [R + 2.6, 0.42], [R + 1.2, 0.42], [R + 1.2, 0.24], [R + 0.2, 0.24], [R + 0.2, 0.05]];
    const lg = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)).reverse(), 48);
    this.B.push(b, lg, L(0, 0, cz, 0, 1.25, 1, 1), '#cdbf9f'); lg.dispose();
    const water = new THREE.CircleGeometry(R + 0.5, 48).rotateX(-Math.PI / 2);
    this.B.push('water', water, L(0, 0.2, cz, 0, 1.25, 1, 1), '#3f7f8a'); water.dispose();
    const n = 64;
    for (let k = 0; k < n; k++) { const a = (k / n) * TAU; this.box(b, Math.cos(a) * (R + 3.7) * 1.25, 0.6, cz + Math.sin(a) * (R + 3.7), 0.18, 0.9, 0.18, k % 2 ? '#f2f2ee' : '#d35400', -a); }
    // Motnath Mahadev temple on the near bank (white nagara shikhara, saffron flag)
    const tx = -R * 1.25 - 1, tz = cz + 14, cream = '#f3ead6', saffron = '#e87722', gold = '#d4a937';
    this.box(b, tx, 0, tz, 12, 1.4, 12, '#e3d7bd');
    for (let k = 0; k < 3; k++) this.box(b, tx, 0, tz + 6.3 + k * 0.5, 4, 1.4 - k * 0.45, 0.5, '#e3d7bd');
    this.box(b, tx, 1.4, tz + 2.8, 6.4, 4.2, 5.6, cream);
    for (const a of [-1, 1]) for (const c of [-1, 1]) this.box(b, tx + a * 2.9, 1.4, tz + 2.8 + c * 2.5, 0.5, 4.2, 0.5, '#ffffff');
    this.blindArch(b, tx, 1.4, tz + 5.62, 2.2, 3.2, '#3a2a1f', 0, 0.25);
    this.box(b, tx, 5.6, tz + 2.8, 7, 0.4, 6.2, saffron);
    this.domeL(b, 'gumbaz', tx, 6.0, tz + 2.8, 2.6, 2.4, cream, gold, 12);
    this.box(b, tx, 1.4, tz - 2.2, 5.6, 5, 5.6, cream);
    this.B.push(b, lathe('shikhara', 8), L(tx, 6.4, tz - 2.2, Math.PI / 8, 3.3, 9.5, 3.3), cream);
    for (let k = 0; k < 8; k++) { const a = (k / 8) * TAU + Math.PI / 8; this.B.push(b, lathe('shikhara', 6), L(tx + Math.cos(a) * 2.6, 6.4, tz - 2.2 + Math.sin(a) * 2.6, 0, 0.8, 3.6, 0.8), '#efe2c8'); }
    this.B.push('metal', lathe('amalaka', 12), L(tx, 15.6, tz - 2.2, 0, 1.4, 0.7, 1.4), '#e9dcc0');
    this.sphere('metal', tx, 16.7, tz - 2.2, 0.5, gold, 1.3);
    this.cylBetween('gloss', tx + 0.4, 15.6, tz - 2.2, tx + 0.4, 21, tz - 2.2, 0.05, '#555');
    const fl = this.atlas.add('bhagwa', 128, 96, (g, w, h) => { g.fillStyle = '#ff7a00'; g.beginPath(); g.moveTo(0, 0); g.lineTo(w, h * 0.5); g.lineTo(0, h); g.fill(); g.fillStyle = '#ffb000'; g.beginPath(); g.moveTo(0, h * 0.3); g.lineTo(w * 0.55, h * 0.5); g.lineTo(0, h * 0.7); g.fill(); });
    this.sign(tx + 1.3, 20.2, tz - 2.2, 1.8, 1.2, fl, 0.4); this.sign(tx + 1.3, 20.2, tz - 2.21, 1.8, 1.2, { u0: fl.u1, u1: fl.u0, v0: fl.v0, v1: fl.v1 }, 0.4 + Math.PI);
    // ghat steps from the temple to the water
    for (let k = 0; k < 5; k++) this.box(b, tx + 6 + k * 1.0, 0, tz - 4, 1.0, 0.8 - k * 0.15, 8, '#d8ccb0');
    const hr = this.atlas.add('harni', 820, 140, (g, w, h) => {
      g.fillStyle = '#7a1414'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#ffd166'; g.lineWidth = 4; g.strokeRect(6, 6, w - 12, h - 12);
      fitText(g, 'શ્રી મોટનાથ મહાદેવ', w / 2, h * 0.33, w * 0.8, h * 0.36, { color: '#ffd166', weight: '700', family: FONT_GU });
      fitText(g, 'HARNI MOTNATH LAKE', w / 2, h * 0.74, w * 0.84, h * 0.3, { color: '#ffffff' });
    });
    this.standSign(-20, F - 3, hr, 6.4, 1.1, 1.2);
    for (let k = 0; k < 16; k++) { const a = (k / 16) * TAU; if (Math.sin(a) > 0.6 || (Math.cos(a) < -0.7 && Math.sin(a) > -0.2)) continue; this.treeLocal(Math.cos(a) * (R + 9) * 1.25, cz + Math.sin(a) * (R + 9), k % 3 ? 'neem' : 'banyan', 1.05); }
    for (let k = 0; k < 10; k++) { const a = (k / 10) * TAU; this.lawnLamp(Math.cos(a) * (R + 5.4) * 1.25, cz + Math.sin(a) * (R + 5.4), 3.4); }
  },

  // ------------------------------------------------------------ Makarpura Palace (Italian Renaissance, IAF)
  _lm_makarpura(lm) {
    const W = 116, D = 72;
    this._placeSide(lm, W, D, 7);
    const F = D / 2, b = 'std';
    const cream = '#efe1c2', white = '#fbf6ea', stone = '#d9c7a2', gold = '#d4a937';
    this.box(b, 0, 0, 0, W, 0.06, D, '#5d9a38');
    this.box(b, 0, 0.02, F - 10, 10, 0.07, 20, '#d8c9a8');
    this.cyl(b, 0, 0.02, F - 22, 8, 0.07, '#d8c9a8', 24);
    // front wall, gate and IAF board
    for (const [x0, x1] of [[-W / 2, -6], [6, W / 2]]) { this.box(b, (x0 + x1) / 2, 0, F - 0.4, x1 - x0, 1.4, 0.4, white); this.box(b, (x0 + x1) / 2, 1.4, F - 0.4, x1 - x0, 0.15, 0.55, '#3f5d8a'); }
    for (const x of [-6, 6]) { this.box(b, x, 0, F - 0.4, 1.5, 3.6, 1.5, white); this.sphere(b, x, 3.9, F - 0.4, 0.45, '#3f5d8a'); }
    const iaf = this.atlas.add('iaf', 900, 170, (g, w, h) => {
      g.fillStyle = '#16325c'; g.fillRect(0, 0, w, h);
      const cx = h * 0.55, cy = h / 2;
      for (const [r, c] of [[0.36, '#ff9933'], [0.24, '#ffffff'], [0.12, '#138808']]) { g.fillStyle = c; g.beginPath(); g.arc(cx, cy, h * r, 0, TAU); g.fill(); }
      g.fillStyle = '#ffffff';
      fitText(g, 'INDIAN AIR FORCE', w * 0.58, h * 0.36, w * 0.68, h * 0.34, { color: '#ffffff' });
      fitText(g, 'MAKARPURA PALACE • AIR FORCE STATION VADODARA', w * 0.58, h * 0.72, w * 0.7, h * 0.16, { color: '#9fc3ff', weight: '800', family: FONT2 });
    });
    this.box(b, 0, 3.4, F - 0.4, 13, 2.0, 0.6, '#16325c');
    this.sign(0, 4.4, F - 0.08, 12.4, 1.8, iaf);
    this.sign(0, 4.4, F - 0.72, 12.4, 1.8, iaf, Math.PI);
    this.box(b, 9, 0, F - 3, 2, 2.6, 2, white); this.box(b, 9, 2.6, F - 3, 2.6, 0.2, 2.6, '#3f5d8a');
    const S = this._lmSoup(), T = this.SS.T, tl = T.tiles[0], wc = new THREE.Color('#ffffff');
    const mz = -F + 26;
    const wing = (x) => {
      const ww = 32, wd = 16, H = 16;
      this.box(b, x, 0, mz - wd / 2, ww, H, wd, cream);
      this.arcade(b, x, 0, mz + 2.2, ww, 5.4, 7, { col: cream, trim: white, pointed: 0, depth: 0.6, frac: 0.82, recess: 1.6 });
      this.box(b, x, 5.4, mz + 1.0, ww + 0.4, 0.5, 2.6, white);
      this.balustrade(b, x - ww / 2, x + ww / 2, 5.9, mz + 2.1, white);
      this.arcade(b, x, 5.9, mz + 0.04 + 0.6, ww, 5.2, 7, { col: cream, trim: white, pointed: 0, depth: 0.6, sill: 1.2, frac: 0.75, pier: 0.5, back: '#3d3226', recess: 0.6, ceil: false });
      this.box(b, x, 11.1, mz - wd / 2, ww + 0.6, 0.4, wd + 0.6, white);
      this.arcade(b, x, 11.5, mz + 0.04 + 0.5, ww, 4.5, 7, { col: cream, trim: white, pointed: 0, depth: 0.5, sill: 1.0, frac: 0.7, pier: 0.55, back: '#3d3226', recess: 0.5, ceil: false });
      this.box(b, x, 16, mz - wd / 2, ww + 1.2, 0.6, wd + 1.2, white);
      this.hipRoofS(S, x, 16.6, mz + 0.6, ww + 1.2, wd + 1.2, 4.2, tl, wc);
      for (const s of [-1, 1]) this.box(b, x + s * (ww / 2 - 0.5), 0, mz - wd / 2, 1.2, 16, wd + 0.2, white);
      this._lights(x - ww / 2, 16.5, mz + 1.4, x + ww / 2, 16.5, mz + 1.4, 20);
    };
    wing(-26); wing(26);
    // central corridor block and porte-cochere with fountains
    this.box(b, 0, 0, mz - 9, 20, 11, 12, cream);
    this.arcade(b, 0, 0, mz - 2.6, 20, 5.2, 5, { col: cream, trim: white, pointed: 0, depth: 0.5, recess: 1.2 });
    this.arcade(b, 0, 5.6, mz - 2.6, 20, 5, 5, { col: cream, trim: white, pointed: 0, depth: 0.5, sill: 1, frac: 0.75, recess: 0.6, back: '#3d3226', ceil: false });
    this.hipRoofS(S, 0, 11, mz - 2.4, 21, 13.4, 3.4, tl, wc);
    this.box(b, 0, 0, mz + 5, 14, 5.6, 10, cream);
    this.arcade(b, 0, 0, mz + 10.05, 14, 5.6, 3, { col: cream, trim: white, pointed: 0, depth: 0.6, back: false, frac: 0.85 });
    for (const s of [-1, 1]) this.arcade(b, s * 7.05, 0, mz + 5, 10, 5.6, 2, { col: cream, trim: white, pointed: 0, depth: 0.5, ry: s * Math.PI / 2, back: false });
    this.box(b, 0, 5.6, mz + 5, 14.6, 0.5, 10.6, white);
    this.balustrade(b, -7, 7, 6.1, mz + 10.1, white);
    this.B.push(b, lathe('fountain', 24), L(0, 0, F - 22, 0, 4.6, 1.6, 4.6), stone);
    this.cyl('water', 0, 0.1, F - 22, 4.1, 0.3, '#4a92b8', 24);
    for (let k = 0; k < 8; k++) { const a = (k / 8) * TAU; this.cyl(b, Math.cos(a) * 4.2, 0, F - 22 + Math.sin(a) * 4.2, 1.1, 0.4, stone, 10); }
    this.cyl(b, 0, 0, F - 22, 0.6, 2.4, stone, 10);
    this.B.push(b, lathe('fountain', 16), L(0, 2.4, F - 22, 0, 1.6, 0.9, 1.6), stone);
    this.cone('water', 0, 2.6, F - 22, 0.25, 2.2, '#d6eef8', 8);
    for (let x = -W / 2 + 6; x <= W / 2 - 6; x += 10) if (Math.abs(x) > 12) this.palm(x, F - 6, 9);
    for (const x of [-W / 2 + 4, W / 2 - 4]) for (let z = -F + 6; z < F - 10; z += 10) this.treeLocal(x, z, 'neem', 1.1);
    for (let x = -30; x <= 30; x += 15) if (x) this.lawnLamp(x, F - 12);
  },
};

function archP(g, x, yb, w, h, pointed) {
  const r = w / 2, ys = yb - h + r;
  g.moveTo(x, yb); g.lineTo(x, ys);
  if (!pointed) g.arc(x + r, ys, r, Math.PI, 0);
  else for (let k = 0; k <= 12; k++) { const t = k / 12, u = Math.abs(2 * t - 1); g.lineTo(x + w * t, ys - r * (Math.sqrt(Math.max(0, 1 - u * u)) * (1 - pointed) + pointed * (1 - u)) * 1.15); }
  g.lineTo(x + w, yb); g.closePath();
}

export function landmarkContext(world, lm) {
  const W = world;
  return {
    THREE, world: W, track: W.track, lm, hw: W.track.halfWidth,
    place: (w, d, setback = 6.6) => W._placeSide(lm, w, d, setback),
    frameSide: (i, side, lat) => W.frameSide(i, side, lat),
    useFrame: (f) => { W.B.frame.copy(f.m); W._lmF = { cx: f.cx, cz: f.cz, ry: f.ry, sc: 1 }; },
    toWorld: (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(W.B.frame),
    box: (...a) => W.box(...a), cyl: (...a) => W.cyl(...a), sphere: (...a) => W.sphere(...a), cone: (...a) => W.cone(...a),
    cylBetween: (...a) => W.cylBetween(...a), arcade: (...a) => W.arcade(...a), domeL: (...a) => W.domeL(...a),
    chhatri: (...a) => W.chhatri(...a), kanguras: (...a) => W.kanguras(...a), balustrade: (...a) => W.balustrade(...a), pinnacle: (...a) => W.pinnacle(...a),
    atlas: W.atlas, sign: (...a) => W.sign(...a), tree: (x, z, type, size) => W.treeLocal(x, z, type, size),
    add: (obj, { cast = true, receive = true } = {}) => { if (obj.isMesh) return W._add(obj, cast, receive); obj.traverse((n) => { if (n.isMesh) { n.castShadow = cast && W.QL.shadows; n.receiveShadow = receive; if (n.geometry) W._track(n.geometry); [].concat(n.material || []).forEach((m) => W._track(m)); } }); W.root.add(obj); return obj; },
    track: (x) => W._track(x), texture: (c) => W._tex(c),
    materials: W.M, timeOfDay: W.tod, weather: W.rain ? 'rain' : 'clear', lightsOn: W.P.lamps > 0, rnd: W.rnd,
    lights: (...a) => W._lights(...a),
  };
}
