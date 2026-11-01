// Track geometry: real Vadodara waypoints -> smooth closed racing loop sampled every metre.
// Conventions (see CONTRACT.md): Y up, metres, heading h with forward = (sin h, cos h) in (x, z).
// "Right" of travel = (tz, -tx) = (cos h, -sin h), the same convention car.js / ai.js / race.js use.
// curv = d(heading)/ds (1/m), smoothed; its sign follows heading h = atan2(tx, tz).
import * as THREE from 'three';

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320;

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

function polyLength(P) {
  let L = 0;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    L += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return L;
}

function scalePts(P, f) {
  const ox = P[0][0], oz = P[0][1];
  for (const p of P) { p[0] = ox + (p[0] - ox) * f; p[1] = oz + (p[1] - oz) * f; }
}

function makeCurve(P) {
  const c = new THREE.CatmullRomCurve3(P.map((p) => new THREE.Vector3(p[0], 0, p[1])), true, 'centripetal');
  c.arcLengthDivisions = Math.max(2000, P.length * 24);
  return c;
}

// Resample a closed polyline/curve into M evenly spaced points.
function curveToPoly(curve, M) {
  const pts = curve.getSpacedPoints(M);
  pts.pop();
  return pts.map((v) => [v.x, v.z]);
}

// Iteratively relax a closed polyline (spacing ~step m): limit minimum radius and keep
// non-adjacent parts of the loop at least `sep` metres apart.
function relax(Q, step, rMin, sep, iters) {
  const M = Q.length;
  const k = Math.max(2, Math.round(10 / step));
  const minIdxGap = Math.ceil((1.8 * sep) / step);
  let bad = 0;
  for (let it = 0; it < iters; it++) {
    bad = 0;
    // 1) curvature limit (Menger curvature over a wide stencil)
    for (let i = 0; i < M; i++) {
      const a = Q[(i - k + M) % M], b = Q[i], c = Q[(i + k) % M];
      const abx = b[0] - a[0], abz = b[1] - a[1], bcx = c[0] - b[0], bcz = c[1] - b[1];
      const acx = c[0] - a[0], acz = c[1] - a[1];
      const cross = Math.abs(abx * bcz - abz * bcx);
      const den = Math.hypot(abx, abz) * Math.hypot(bcx, bcz) * Math.hypot(acx, acz) + 1e-9;
      const kap = (2 * cross) / den;
      if (kap * rMin > 1) {
        bad++;
        const w = Math.min(0.5, 0.35 * (kap * rMin - 1) + 0.08);
        b[0] += ((a[0] + c[0]) * 0.5 - b[0]) * w;
        b[1] += ((a[1] + c[1]) * 0.5 - b[1]) * w;
      }
    }
    // 2) separation between distant parts of the loop
    for (let i = 0; i < M; i++) {
      const p = Q[i];
      for (let j = i + minIdxGap; j < M; j++) {
        const gap = Math.min(j - i, M - (j - i));
        if (gap < minIdxGap) continue;
        const q = Q[j];
        const dx = q[0] - p[0], dz = q[1] - p[1];
        if (Math.abs(dx) > sep || Math.abs(dz) > sep) continue;
        const d = Math.hypot(dx, dz);
        if (d < sep) {
          bad++;
          const push = ((sep - d) * 0.5 + 0.5) / (d + 1e-6);
          const ux = d > 1e-3 ? dx : 1, uz = d > 1e-3 ? dz : 0;
          // spread the push over neighbours for smoothness
          for (let o = -3; o <= 3; o++) {
            const f = 1 - Math.abs(o) / 4;
            const pi = Q[(i + o + M) % M], qj = Q[(j + o + M) % M];
            pi[0] -= ux * push * 0.5 * f; pi[1] -= uz * push * 0.5 * f;
            qj[0] += ux * push * 0.5 * f; qj[1] += uz * push * 0.5 * f;
          }
        }
      }
    }
    // 3) gentle Laplacian smoothing to remove kinks
    const tmp = Q.map((p) => [p[0], p[1]]);
    for (let i = 0; i < M; i++) {
      const a = tmp[(i - 1 + M) % M], c = tmp[(i + 1) % M];
      Q[i][0] += ((a[0] + c[0]) * 0.5 - Q[i][0]) * 0.12;
      Q[i][1] += ((a[1] + c[1]) * 0.5 - Q[i][1]) * 0.12;
    }
    if (bad === 0 && it > 4) break;
  }
  return bad;
}

export function buildTrack(def) {
  const hw = def.halfWidth;
  const rnd = mulberry32(hashStr(def.id));

  // ---- project waypoints, start waypoint first ----
  let wps = def.waypoints.slice();
  let si = wps.findIndex((w) => w[2] && w[2].mark === 'start');
  if (si < 0) si = 0;
  wps = wps.slice(si).concat(wps.slice(0, si));
  const lat0 = wps[0][0], lon0 = wps[0][1];
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  let P = wps.map((w) => [(w[1] - lon0) * cosLat * M_PER_DEG_LON, -(w[0] - lat0) * M_PER_DEG_LAT]);

  // pre-scale the raw polygon close to the target length
  scalePts(P, (def.targetLength / polyLength(P)) * 0.92);

  // ---- add gentle extra wiggles between waypoints (deterministic per track) ----
  const C = [];
  const wpC = [];
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    wpC.push(C.length);
    C.push([a[0], a[1]]);
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz);
    const m = Math.floor(L / 130);
    const nx = -dz / (L || 1), nz = dx / (L || 1);
    let sgn = rnd() < 0.5 ? -1 : 1;
    for (let j = 1; j <= m; j++) {
      const t = j / (m + 1);
      const amp = Math.min(L * 0.07, 30) * (0.6 + 0.6 * rnd()) * sgn;
      sgn = -sgn;
      C.push([a[0] + dx * t + nx * amp, a[1] + dz * t + nz * amp]);
    }
  }

  // ---- spline, scale to target ----
  let curve = makeCurve(C);
  let L0 = curve.getLength();
  scalePts(C, def.targetLength / L0);
  curve = makeCurve(C);
  L0 = curve.getLength();

  // waypoint arc positions on the spline
  const lens = curve.getLengths(curve.arcLengthDivisions);
  const wpArc = wpC.map((ci) => lens[Math.round((ci / C.length) * curve.arcLengthDivisions)] / L0);

  // ---- relaxation polyline (~4 m spacing) ----
  const step = 4;
  const M = Math.round(L0 / step);
  let Q = curveToPoly(curve, M);
  const wpQ = wpArc.map((f) => Math.round(f * M) % M);
  const rMin = Math.max(hw * 2.6, 22);
  const sep = hw * 3.2;
  for (let pass = 0; pass < 4; pass++) {
    const bad = relax(Q, step, rMin, sep, 80);
    const f = def.targetLength / polyLength(Q);
    scalePts(Q, f);
    if (bad === 0 && Math.abs(f - 1) < 0.01) break;
  }

  // ---- final spline sampled every ~1 m ----
  const fc = makeCurve(Q);
  fc.arcLengthDivisions = Q.length * 16;
  const length = fc.getLength();
  const N = Math.round(length);
  const ds = length / N;
  const pts = fc.getSpacedPoints(N);
  const x = new Float32Array(N), z = new Float32Array(N), y = new Float32Array(N);
  for (let i = 0; i < N; i++) { x[i] = pts[i].x; z[i] = pts[i].z; }

  const tx = new Float32Array(N), tz = new Float32Array(N), curv = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = (i - 1 + N) % N, b = (i + 1) % N;
    const dx = x[b] - x[a], dz = z[b] - z[a];
    const l = Math.hypot(dx, dz) || 1;
    tx[i] = dx / l; tz[i] = dz / l;
  }
  const head = new Float32Array(N);
  for (let i = 0; i < N; i++) head[i] = Math.atan2(tx[i], tz[i]);
  const raw = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let d = head[(i + 2) % N] - head[(i - 2 + N) % N];
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    raw[i] = d / (4 * ds);
  }
  // smooth: two box passes, radius 8 samples
  let src = raw, dst = curv;
  for (let pass = 0; pass < 2; pass++) {
    const R = 8;
    let acc = 0;
    for (let o = -R; o <= R; o++) acc += src[(o + N) % N];
    for (let i = 0; i < N; i++) {
      dst[i] = acc / (2 * R + 1);
      acc += src[(i + R + 1) % N] - src[(i - R + N) % N];
    }
    if (pass === 0) { src = curv.slice(); dst = curv; }
  }

  // ---- nearest ----
  function nearestFull(px, pz) {
    let best = 1e18, bi = 0;
    for (let i = 0; i < N; i += 4) {
      const dx = px - x[i], dz = pz - z[i];
      const d = dx * dx + dz * dz;
      if (d < best) { best = d; bi = i; }
    }
    for (let o = -4; o <= 4; o++) {
      const i = (bi + o + N) % N;
      const dx = px - x[i], dz = pz - z[i];
      const d = dx * dx + dz * dz;
      if (d < best) { best = d; bi = i; }
    }
    return bi;
  }
  function nearest(px, pz, hint = -1) {
    let bi = -1, best = 1e18;
    if (hint >= 0 && hint < N) {
      const W = 60;
      for (let o = -W; o <= W; o++) {
        const i = (hint + o + N) % N;
        const dx = px - x[i], dz = pz - z[i];
        const d = dx * dx + dz * dz;
        if (d < best) { best = d; bi = i; }
      }
      if (best > hw * hw * 9) bi = -1;
    }
    if (bi < 0) bi = nearestFull(px, pz);
    const dx = px - x[bi], dz = pz - z[bi];
    const lateral = dx * tz[bi] - dz * tx[bi];
    return { index: bi, lateral, dist: Math.abs(lateral) };
  }

  function pointAt(s) {
    let f = (s / ds) % N;
    if (f < 0) f += N;
    const i = Math.floor(f), j = (i + 1) % N, t = f - i;
    let ttx = tx[i] + (tx[j] - tx[i]) * t, ttz = tz[i] + (tz[j] - tz[i]) * t;
    const l = Math.hypot(ttx, ttz) || 1;
    return { x: x[i] + (x[j] - x[i]) * t, y: 0, z: z[i] + (z[j] - z[i]) * t, tx: ttx / l, tz: ttz / l };
  }

  function grid(slot) {
    const row = Math.floor(slot / 2);
    const side = slot % 2 === 0 ? -1 : 1; // pole position on the left
    const p = pointAt(-(10 + row * 8));
    const lat = side * 3;
    return { x: p.x + p.tz * lat, z: p.z - p.tx * lat, h: Math.atan2(p.tx, p.tz) };
  }

  // free lateral space on a side before hitting another part of the loop
  function freeSpace(i, side, maxD = 120) {
    const rx = tz[i] * side, rz = -tx[i] * side;
    for (let d = hw + 4; d <= maxD; d += 4) {
      const px = x[i] + rx * d, pz = z[i] + rz * d;
      const ni = nearestFull(px, pz);
      const gap = Math.min(Math.abs(ni - i), N - Math.abs(ni - i));
      if (gap > 30 && Math.hypot(px - x[ni], pz - z[ni]) < hw + 6) return d - hw;
    }
    return maxD - hw;
  }

  // ---- landmarks and labels ----
  const landmarks = [];
  const labels = [];
  let alt = 1;
  wps.forEach((w, k) => {
    const meta = w[2];
    if (!meta) return;
    // map the waypoint onto the final loop (search near its expected position)
    const qp = Q[wpQ[k]];
    const guess = Math.round((wpQ[k] / M) * N) % N;
    let idx = k === 0 ? 0 : nearest(qp[0], qp[1], guess).index;
    if (meta.label) labels.push({ text: meta.label, index: idx });
    if (meta.landmark) {
      let side = meta.side;
      if (side !== -1 && side !== 1) {
        side = alt; alt = -alt;
        const need = 55;
        const here = freeSpace(idx, side), there = freeSpace(idx, -side);
        if (here < need && there > here) side = -side;
      }
      // keep hero models clear of the start/finish gantry
      if (meta.landmark === 'brightday' && idx < 30) idx = 18; // school gate right beside the start
      else if (idx < 40 || idx > N - 40) idx = 70;
      landmarks.push({ id: meta.landmark, index: idx, side, label: meta.label || '' });
    }
  });

  return {
    id: def.id, def, N,
    x, y, z, tx, tz, curv,
    length, halfWidth: hw, ds,
    nearest, pointAt, grid,
    landmarks, labels,
  };
}
