import * as THREE from 'three';

// Collectible nitro bottles on the road (Auto Rush style): drive through one to top up the nitro tank.
// The layout is deterministic per track (same for every player online); each client keeps its own
// pickups, so what you grab on your screen is yours. A taken bottle comes back after RESPAWN seconds.

function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

const RESPAWN = 7;
const REACH = 2.5; // metres from the car's centre
export const PICKUP_FILL = 0.25; // share of the tank per bottle

const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), pos = new THREE.Vector3(), scl = new THREE.Vector3();

export class Pickups {
  // avoid: track indices to keep clear (gates, hazards)
  constructor(scene, track, avoid = []) {
    this.scene = scene;
    this.track = track;
    this.items = []; // { x, y, z, index, taken, back }
    const rnd = mulberry(hashStr(track.id + '|nitro'));
    const N = track.N, hw = track.halfWidth;
    const blocked = (i) => i < 60 || i > N - 30 || avoid.some(a => { const d = Math.abs(a - i); return d < 22 || d > N - 22; });
    let k = 0;
    for (let i = 95; i < N - 40; i += Math.round(140 + rnd() * 60), k++) {
      for (let tries = 0; tries < 4 && blocked(i); tries++) i += 25; // slide forward past a gate or obstacle
      if (blocked(i) || i >= N - 40) continue;
      if (k % 3 === 1) {
        // a line of three in one lane (commit to it to get all of them)
        const lat = (rnd() < 0.5 ? -1 : 1) * hw * 0.42;
        for (let j = 0; j < 3; j++) this._add(i + j * 9, lat);
      } else {
        // a row across the road: whichever lane you pick, there is one for you
        for (const f of [-0.55, 0, 0.55]) this._add(i, f * hw);
      }
    }
    this._build();
  }

  _add(i, lat) {
    const t = this.track, N = t.N;
    i = ((i % N) + N) % N;
    this.items.push({ x: t.x[i] + t.tz[i] * lat, z: t.z[i] - t.tx[i] * lat, y: t.y ? t.y[i] || 0 : 0, index: i, taken: false, back: 0, pop: 1 });
  }

  _build() {
    const n = this.items.length;
    this.disposables = [];
    const D = (x) => { this.disposables.push(x); return x; };
    const bottleGeo = D(new THREE.CylinderGeometry(0.3, 0.3, 0.92, 16));
    const capGeo = D(new THREE.CylinderGeometry(0.15, 0.24, 0.32, 12));
    const ringGeo = D(new THREE.TorusGeometry(0.92, 0.07, 8, 32));
    const discGeo = D(new THREE.CircleGeometry(1.6, 24).rotateX(-Math.PI / 2));
    const bottleMat = D(new THREE.MeshStandardMaterial({ color: '#0a9fe0', emissive: new THREE.Color('#2ad4ff'), emissiveIntensity: 1.6, roughness: 0.25, metalness: 0.3 }));
    const capMat = D(new THREE.MeshStandardMaterial({ color: '#ffffff', metalness: 0.8, roughness: 0.25 }));
    const ringMat = D(new THREE.MeshBasicMaterial({ color: '#8ff0ff', transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    const discMat = D(new THREE.MeshBasicMaterial({ color: '#2ad4ff', transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
    const mk = (g, m) => { const im = new THREE.InstancedMesh(g, m, n); im.frustumCulled = false; this.scene.add(im); this.disposables.push({ dispose: () => { this.scene.remove(im); im.dispose(); } }); return im; };
    this.bottles = mk(bottleGeo, bottleMat);
    this.caps = mk(capGeo, capMat);
    this.rings = mk(ringGeo, ringMat);
    this.discs = mk(discGeo, discMat);
    this.discs.renderOrder = 2;
    this.update(0, 0);
  }

  // Local cars (player + CPU) drive through bottles. Returns the cars that grabbed one this step.
  collect(cars, time) {
    const got = [];
    for (const it of this.items) {
      if (it.taken) { if (time >= it.back) { it.taken = false; it.pop = 0; } continue; }
      for (const c of cars) {
        const p = c.phys;
        if (Math.abs(p.x - it.x) > REACH || Math.abs(p.z - it.z) > REACH) continue;
        if (Math.hypot(p.x - it.x, p.z - it.z) > REACH) continue;
        it.taken = true; it.back = time + RESPAWN;
        p.nitroTank = Math.min(1, p.nitroTank + PICKUP_FILL);
        got.push({ car: c, x: it.x, y: it.y, z: it.z });
        break;
      }
    }
    return got;
  }

  update(t, dt) {
    let i = 0;
    for (const it of this.items) {
      it.pop = Math.min(1, it.pop + dt * 2.5);
      const s = it.taken ? 0 : (it.pop < 1 ? Math.sin(it.pop * Math.PI * 0.5) * (1 + 0.25 * Math.sin(it.pop * Math.PI)) : 1);
      const bob = Math.sin(t * 2.6 + it.index * 0.37) * 0.12;
      const spin = t * 2.2 + it.index;
      scl.setScalar(s);
      // bottle, slightly tilted and spinning
      e.set(0.25, spin, 0); q.setFromEuler(e);
      pos.set(it.x, it.y + 1.25 + bob, it.z);
      m4.compose(pos, q, scl); this.bottles.setMatrixAt(i, m4);
      pos.set(it.x + Math.sin(spin) * 0.6 * Math.sin(0.25) * s, it.y + 1.25 + bob + 0.6 * s, it.z + Math.cos(spin) * 0.6 * Math.sin(0.25) * s);
      m4.compose(pos, q, scl); this.caps.setMatrixAt(i, m4);
      // halo ring spinning the other way, upright
      e.set(0, -spin * 0.8, 0); q.setFromEuler(e);
      pos.set(it.x, it.y + 1.3 + bob, it.z);
      m4.compose(pos, q, scl); this.rings.setMatrixAt(i, m4);
      // glow pool on the tarmac
      e.set(0, 0, 0); q.setFromEuler(e);
      scl.setScalar(s * (0.9 + 0.1 * Math.sin(t * 4 + it.index)));
      pos.set(it.x, it.y + 0.05, it.z);
      m4.compose(pos, q, scl); this.discs.setMatrixAt(i, m4);
      i++;
    }
    for (const im of [this.bottles, this.caps, this.rings, this.discs]) im.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.items = [];
  }
}
