import * as THREE from 'three';

// Road hazards for the competitive tracks: Baroda's famous road-blocking cows and orange-white police
// barricades. Positions are deterministic per track (seeded by the track id), so every player in a
// multiplayer room dodges the same ones. They never move; hitting one costs a big chunk of speed.

function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

const KEEP_CLEAR = 70; // metres after the start line and around each checkpoint gate

export class Hazards {
  // avoid: track indices to keep clear (checkpoint gates)
  constructor(scene, track, opts = {}, avoid = []) {
    this.scene = scene;
    this.track = track;
    this.group = new THREE.Group();
    this.group.name = 'hazards';
    this.items = []; // { x, z, r, index, lateral, kind, obj }
    this.disposables = [];
    const rnd = mulberry(hashStr(track.id + '|hazards'));
    const N = track.N, hw = track.halfWidth;
    const every = opts.every || 120;
    const clear = (i) => i < KEEP_CLEAR || i > N - 40 || avoid.some(a => Math.abs(a - i) < 30 || Math.abs(a - i) > N - 30);
    const kit = this._kit();
    let k = 0;
    for (let i = KEEP_CLEAR + 40; i < N - 60; i += Math.round(every * (0.8 + rnd() * 0.45)), k++) {
      if (clear(i)) continue;
      const kind = k % 3 === 2 ? 'barricade' : 'cow';
      // Leave a gap: hazards sit in one lane, alternating sides with some randomness
      const side = (k % 2 ? 1 : -1) * (rnd() < 0.2 ? -1 : 1);
      const lat = kind === 'cow' ? side * (hw * (0.25 + rnd() * 0.35)) : side * (hw * 0.55);
      this._add(kind, i, lat, kit, rnd);
    }
    scene.add(this.group);
  }

  _kit() {
    const D = (x) => { this.disposables.push(x); return x; };
    const M = (o) => D(new THREE.MeshStandardMaterial(o));
    return {
      hide: M({ color: '#f1ece2', roughness: 0.9 }),
      spot: M({ color: '#4a3b30', roughness: 0.9 }),
      horn: M({ color: '#e9d9b5', roughness: 0.6 }),
      dark: M({ color: '#2a2320', roughness: 0.8 }),
      pink: M({ color: '#d99a8c', roughness: 0.8 }),
      orange: M({ color: '#ff6a13', roughness: 0.5, emissive: new THREE.Color('#ff4a00'), emissiveIntensity: 0.25 }),
      white: M({ color: '#f7f7f2', roughness: 0.5 }),
      red: M({ color: '#ff2a2a', emissive: new THREE.Color('#ff2020'), emissiveIntensity: 2.2 }),
      box: (w, h, d) => D(new THREE.BoxGeometry(w, h, d)),
      cyl: (r1, r2, h, s = 10) => D(new THREE.CylinderGeometry(r1, r2, h, s)),
      sph: (r) => D(new THREE.SphereGeometry(r, 10, 8)),
    };
  }

  _add(kind, i, lat, kit, rnd) {
    const t = this.track;
    const x = t.x[i] + t.tz[i] * lat, z = t.z[i] - t.tx[i] * lat, y = t.y ? t.y[i] || 0 : 0;
    const head = Math.atan2(t.tx[i], t.tz[i]);
    const g = new THREE.Group();
    g.position.set(x, y, z);
    const m = (geo, mat, px, py, pz) => { const o = new THREE.Mesh(geo, mat); o.position.set(px, py, pz); o.castShadow = true; g.add(o); return o; };
    if (kind === 'cow') {
      // Standing across the road (side-on to traffic), a little turned
      g.rotation.y = head + Math.PI / 2 + (rnd() - 0.5) * 0.7;
      m(kit.box(0.75, 0.72, 1.7), kit.hide, 0, 1.12, 0);
      m(kit.box(0.77, 0.4, 0.5), kit.spot, 0, 1.2, 0.25);
      m(kit.box(0.78, 0.3, 0.35), kit.spot, 0, 1.05, -0.5);
      m(kit.box(0.6, 0.32, 0.45), kit.hide, 0, 1.55, -0.6); // hump (zebu)
      const neck = m(kit.box(0.42, 0.42, 0.55), kit.hide, 0, 1.35, 1.0); neck.rotation.x = -0.5;
      const hd = new THREE.Group(); hd.position.set(0, 1.42, 1.28); g.add(hd);
      const hm = new THREE.Mesh(kit.box(0.4, 0.42, 0.62), kit.hide); hm.position.set(0, 0, 0.18); hm.castShadow = true; hd.add(hm);
      const snout = new THREE.Mesh(kit.box(0.36, 0.26, 0.2), kit.pink); snout.position.set(0, -0.1, 0.52); hd.add(snout);
      for (const s of [-1, 1]) {
        const h = new THREE.Mesh(kit.cyl(0.03, 0.06, 0.38, 6), kit.horn); h.position.set(s * 0.17, 0.3, 0.02); h.rotation.z = -s * 0.5; hd.add(h);
        const ear = new THREE.Mesh(kit.box(0.24, 0.08, 0.14), kit.hide); ear.position.set(s * 0.28, 0.1, 0.04); hd.add(ear);
      }
      for (const sx of [-0.25, 0.25]) for (const sz of [-0.62, 0.62]) {
        m(kit.cyl(0.08, 0.07, 0.8, 6), kit.hide, sx, 0.4, sz);
        m(kit.cyl(0.085, 0.085, 0.1, 6), kit.dark, sx, 0.05, sz);
      }
      const tail = m(kit.cyl(0.03, 0.02, 0.8, 4), kit.hide, 0, 1.0, -0.9); tail.rotation.x = 0.25;
      g.userData.head = hd;
      g.userData.tail = tail;
      g.userData.phase = rnd() * 6.28;
      this.items.push({ kind, x, z, r: 1.35, index: i, lateral: lat, obj: g });
    } else {
      // Police barricade: striped board on legs, with blinking red lamps, angled across one lane
      g.rotation.y = head + Math.PI / 2 + (lat > 0 ? 0.18 : -0.18);
      const W = 3.4;
      for (let s = 0; s < 6; s++) m(kit.box(W / 6, 0.42, 0.08), s % 2 ? kit.white : kit.orange, -W / 2 + W / 12 + s * W / 6, 0.95, 0);
      m(kit.box(W, 0.12, 0.1), kit.white, 0, 0.45, 0);
      for (const sx of [-W / 2 + 0.15, W / 2 - 0.15]) {
        const leg = m(kit.box(0.09, 1.2, 0.09), kit.white, sx, 0.6, 0);
        leg.rotation.x = 0.0;
        m(kit.box(0.1, 0.06, 0.9), kit.dark, sx, 0.03, 0);
        const lamp = m(kit.sph(0.1), kit.red, sx, 1.27, 0);
        lamp.castShadow = false;
      }
      // a few circles cover the long board for collisions
      const ca = Math.cos(g.rotation.y), sa = Math.sin(g.rotation.y);
      for (const off of [-1.2, 0, 1.2]) {
        const cx = x + ca * off, cz = z - sa * off;
        // true lateral offset of this circle from the centreline, so drivers know how far the board reaches
        const cl = (cx - t.x[i]) * t.tz[i] - (cz - t.z[i]) * t.tx[i];
        this.items.push({ kind, x: cx, z: cz, r: 0.75, index: i, lateral: cl, obj: off === 0 ? g : null });
      }
    }
    this.group.add(g);
  }

  // Hazards a car at track index `i` should look at (just behind it to `ahead` metres in front)
  near(i, ahead = 80) {
    const N = this.track.N, out = [];
    for (const h of this.items) {
      let d = h.index - i;
      if (d < -N / 2) d += N; else if (d > N / 2) d -= N;
      if (d > -8 && d < ahead) out.push(h);
    }
    return out;
  }

  // Push a car out of any hazard it touches. Returns the impact speed (m/s) or 0.
  collide(p) {
    let hit = 0;
    for (const h of this.near(p.index, 12)) {
      const dx = p.x - h.x, dz = p.z - h.z, d = Math.hypot(dx, dz), rr = h.r + 0.95;
      if (d >= rr || d < 1e-4) continue;
      const nx = dx / d, nz = dz / d;
      p.x += nx * (rr - d); p.z += nz * (rr - d);
      const into = -(p.vx * nx + p.vz * nz);
      if (into > 0) {
        // kill the inward part, scrub the rest: a solid hit, but you keep rolling
        p.vx += nx * into * 1.15; p.vz += nz * into * 1.15;
        const keep = Math.max(0.35, 1 - into * 0.028);
        p.vx *= keep; p.vz *= keep;
        // twist away from the side that hit
        const side = Math.sign((h.x - p.x) * Math.cos(p.h) - (h.z - p.z) * Math.sin(p.h)) || 1;
        p.kick = (p.kick || 0) - side * Math.min(2.2, into * 0.12);
        hit = Math.max(hit, into);
      }
    }
    return hit;
  }

  update(t) {
    for (const h of this.items) {
      const u = h.obj?.userData;
      if (!u || !u.head) continue;
      u.head.rotation.x = Math.sin(t * 1.3 + u.phase) * 0.18 + 0.15;
      u.head.rotation.y = Math.sin(t * 0.6 + u.phase * 2) * 0.35;
      u.tail.rotation.z = Math.sin(t * 3 + u.phase) * 0.4;
    }
  }

  dispose() {
    this.scene.remove(this.group);
    for (const d of this.disposables) d.dispose();
    this.items = [];
  }
}
