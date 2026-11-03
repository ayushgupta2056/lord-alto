import * as THREE from 'three';

// Tyre marks left while drifting: one ring buffer of quads in a single draw call.
// Each (car, wheel) keeps its last point; a new quad is laid every ~0.45 m between the previous and current point.
const MAX = 1400;          // quads kept on the road (oldest are overwritten)
const STEP = 0.45;         // metres between segments
const HALF_W = 0.13;       // half the tyre-mark width
const Y = 0.035;

export class SkidMarks {
  constructor(scene) {
    this.scene = scene;
    this.pos = new Float32Array(MAX * 6 * 3);
    this.col = new Float32Array(MAX * 6 * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.geo = g;
    this.mat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    this.head = 0; this.count = 0;
    this.last = new Map(); // key -> {x, z}
  }

  // Add a point for one rear wheel of car `c` (side = -1/+1 offset); strength 0..1 = how hard it is sliding
  add(c, side, x, z, h, strength) {
    const key = c.pid + (side < 0 ? 'L' : 'R');
    const prev = this.last.get(key);
    if (!prev) { this.last.set(key, { x, z }); return; }
    const dx = x - prev.x, dz = z - prev.z, d = Math.hypot(dx, dz);
    if (d < STEP) return;
    if (d > 4) { this.last.set(key, { x, z }); return; } // teleport / respawn: start a new trail
    // perpendicular to the segment
    const nx = -dz / d * HALF_W, nz = dx / d * HALF_W;
    const q = this.head, p = this.pos, cl = this.col, o = q * 18, co = q * 24;
    const a = 0.32 + 0.4 * strength;
    const v = [
      prev.x - nx, Y, prev.z - nz, prev.x + nx, Y, prev.z + nz, x + nx, Y, z + nz,
      prev.x - nx, Y, prev.z - nz, x + nx, Y, z + nz, x - nx, Y, z - nz,
    ];
    p.set(v, o);
    for (let k = 0; k < 6; k++) { cl[co + k * 4] = 0.05; cl[co + k * 4 + 1] = 0.045; cl[co + k * 4 + 2] = 0.05; cl[co + k * 4 + 3] = a; }
    this.head = (this.head + 1) % MAX;
    this.count = Math.min(MAX, this.count + 1);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.setDrawRange(0, this.count * 6);
    this.last.set(key, { x, z });
  }

  // Wheels stopped sliding: break the trail so the next drift starts fresh
  lift(c) { this.last.delete(c.pid + 'L'); this.last.delete(c.pid + 'R'); }

  dispose() { this.scene.remove(this.mesh); this.geo.dispose(); this.mat.dispose(); }
}
