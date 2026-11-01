// Pooled particle effects: one THREE.Points per effect type (4 draw calls total).
// Each pool is a ring buffer; CPU integrates, GPU draws soft round sprites sized in world metres.
import * as THREE from 'three';

const VS = /* glsl */`
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
varying float vAlpha;
varying vec3 vColor;
#include <fog_pars_vertex>
void main() {
  vAlpha = aAlpha; vColor = aColor;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = clamp(aSize * uScale / max(0.1, -mvPosition.z), 0.0, 256.0);
  if (aAlpha <= 0.001) gl_PointSize = 0.0;
  #include <fog_vertex>
}`;
const FS = /* glsl */`
uniform float uSoft;
varying float vAlpha;
varying vec3 vColor;
#include <fog_pars_fragment>
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float r = length(p) * 2.0;
  if (r > 1.0) discard;
  float a = pow(1.0 - r, uSoft) * vAlpha;
  gl_FragColor = vec4(vColor, a);
  #include <fog_fragment>
}`;

class Pool {
  constructor(scene, max, { additive, soft }) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.life = new Float32Array(max);   // remaining
    this.total = new Float32Array(max);  // initial life
    this.s0 = new Float32Array(max); this.s1 = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.drag = new Float32Array(max); this.grav = new Float32Array(max);
    this.c0 = new Float32Array(max * 3); this.c1 = new Float32Array(max * 3);
    this.next = 0; this.alive = 0;
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('aSize', this.aSize);
    g.setAttribute('aAlpha', this.aAlpha);
    g.setAttribute('aColor', this.aCol);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uScale: { value: 400 }, uSoft: { value: soft } }]),
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 6 : 5;
    this.points.userData.disposeWithScene = true; // World.load() frees it when the scene is rebuilt
    this.points.onBeforeRender = (renderer, sc, camera) => {
      const h = renderer.getDrawingBufferSize(_v2).y;
      const f = camera.isPerspectiveCamera ? 1 / Math.tan((camera.fov * Math.PI) / 360) : 1;
      this.mat.uniforms.uScale.value = h * 0.5 * f;
    };
    scene.add(this.points);
  }
  spawn(x, y, z, vx, vy, vz, life, s0, s1, a0, c0, c1, drag = 0, grav = 0) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    const k = i * 3;
    this.pos[k] = x; this.pos[k + 1] = y; this.pos[k + 2] = z;
    this.vel[k] = vx; this.vel[k + 1] = vy; this.vel[k + 2] = vz;
    this.life[i] = life; this.total[i] = life;
    this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = a0;
    this.c0[k] = c0.r; this.c0[k + 1] = c0.g; this.c0[k + 2] = c0.b;
    this.c1[k] = c1.r; this.c1[k + 1] = c1.g; this.c1[k + 2] = c1.b;
    this.drag[i] = drag; this.grav[i] = grav;
    this.dirty = true;
  }
  update(dt) {
    if (!this.dirty) return;
    let any = false;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { if (this.alpha[i] !== 0) this.alpha[i] = 0; continue; }
      any = true;
      this.life[i] -= dt;
      const k = i * 3;
      const t = 1 - Math.max(0, this.life[i]) / this.total[i]; // 0 -> 1
      const dr = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[k] *= dr; this.vel[k + 1] = this.vel[k + 1] * dr - this.grav[i] * dt; this.vel[k + 2] *= dr;
      this.pos[k] += this.vel[k] * dt; this.pos[k + 1] += this.vel[k + 1] * dt; this.pos[k + 2] += this.vel[k + 2] * dt;
      if (this.pos[k + 1] < 0.03) { this.pos[k + 1] = 0.03; if (this.vel[k + 1] < 0) this.vel[k + 1] *= -0.35; }
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      this.alpha[i] = this.life[i] > 0 ? this.a0[i] * Math.min(1, t * 8) * (1 - t) : 0;
      this.col[k] = this.c0[k] + (this.c1[k] - this.c0[k]) * t;
      this.col[k + 1] = this.c0[k + 1] + (this.c1[k + 1] - this.c0[k + 1]) * t;
      this.col[k + 2] = this.c0[k + 2] + (this.c1[k + 2] - this.c0[k + 2]) * t;
    }
    this.aPos.needsUpdate = true; this.aSize.needsUpdate = true; this.aAlpha.needsUpdate = true; this.aCol.needsUpdate = true;
    if (!any) this.dirty = false;
  }
  dispose() {
    this.points.parent?.remove(this.points);
    this.points.geometry.dispose(); this.mat.dispose();
  }
}

const _v2 = new THREE.Vector2();
const C = (h) => new THREE.Color(h);
const SMOKE0 = C('#ffffff'), SMOKE1 = C('#c4c3c0');
const FLAME0 = C('#cfe6ff'), FLAME1 = C('#ff5a10'), FLAME2 = C('#ffb347');
const SPARK0 = C('#fff6c8'), SPARK1 = C('#ff7a1a');
const DUST0 = C('#c8a878'), DUST1 = C('#a8916c');

export class FX {
  constructor(scene, quality = 'medium') {
    const m = quality === 'low' ? 0.5 : quality === 'high' ? 1.25 : 1;
    this.q = m;
    this.smokePool = new Pool(scene, Math.round(260 * m), { additive: false, soft: 0.9 });
    this.dustPool = new Pool(scene, Math.round(160 * m), { additive: false, soft: 1.6 });
    this.flamePool = new Pool(scene, Math.round(160 * m), { additive: true, soft: 1.2 });
    this.sparkPool = new Pool(scene, Math.round(220 * m), { additive: true, soft: 0.8 });
    this._smokeAcc = 0;
  }
  // drift / tyre smoke. vel = {x,y,z} (m/s), amount 0..1 (per call; call every frame while drifting)
  smoke(pos, vel, amount = 1) {
    this._smokeAcc += Math.max(0, Math.min(1, amount)) * 3 * this.q;
    const v = vel || { x: 0, y: 0.6, z: 0 };
    while (this._smokeAcc >= 1) {
      this._smokeAcc -= 1;
      const r = Math.random;
      this.smokePool.spawn(
        pos.x + (r() - 0.5) * 0.6, pos.y + 0.15, pos.z + (r() - 0.5) * 0.6,
        v.x + (r() - 0.5) * 1.2, (v.y || 0.6) + r() * 0.6, v.z + (r() - 0.5) * 1.2,
        1.1 + r() * 0.9, 0.9 + r() * 0.5, 3.4 + r() * 1.8, 0.55 + amount * 0.3, SMOKE0, SMOKE1, 1.4, -0.15,
      );
    }
  }
  // nitro exhaust flame burst; dir = backwards unit vector {x,y,z}
  nitro(pos, dir) {
    const d = dir || { x: 0, y: 0, z: -1 };
    const n = Math.max(2, Math.round(4 * this.q));
    for (let k = 0; k < n; k++) {
      const r = Math.random, sp = 7 + r() * 6;
      const hot = k === 0;
      this.flamePool.spawn(
        pos.x + d.x * 0.1, pos.y + (r() - 0.5) * 0.06, pos.z + d.z * 0.1,
        d.x * sp + (r() - 0.5) * 1.5, (d.y || 0) * sp + (r() - 0.3) * 1.0, d.z * sp + (r() - 0.5) * 1.5,
        0.12 + r() * 0.14, hot ? 0.55 : 0.45, 0.15, 1.0, hot ? FLAME0 : FLAME2, FLAME1, 2, 0,
      );
    }
  }
  // crash sparks
  sparks(pos, count = 20) {
    const n = Math.min(120, Math.round(count * this.q));
    for (let k = 0; k < n; k++) {
      const r = Math.random, a = r() * Math.PI * 2, sp = 3 + r() * 9;
      this.sparkPool.spawn(
        pos.x, pos.y, pos.z,
        Math.cos(a) * sp, 2 + r() * 6, Math.sin(a) * sp,
        0.35 + r() * 0.5, 0.2 + r() * 0.12, 0.06, 1.0, SPARK0, SPARK1, 0.6, 16,
      );
    }
  }
  // off-road dust puff
  dust(pos) {
    const r = Math.random;
    const n = Math.max(1, Math.round(1.5 * this.q));
    for (let k = 0; k < n; k++) {
      this.dustPool.spawn(
        pos.x + (r() - 0.5) * 0.8, Math.max(0.1, pos.y), pos.z + (r() - 0.5) * 0.8,
        (r() - 0.5) * 1.6, 0.5 + r() * 0.9, (r() - 0.5) * 1.6,
        0.9 + r() * 0.7, 0.7 + r() * 0.4, 2.6 + r() * 1.2, 0.5, DUST0, DUST1, 1.2, -0.05,
      );
    }
  }
  update(dt) {
    const d = Math.min(0.1, dt || 0);
    this.smokePool.update(d); this.dustPool.update(d); this.flamePool.update(d); this.sparkPool.update(d);
  }
  dispose() {
    for (const p of [this.smokePool, this.dustPool, this.flamePool, this.sparkPool]) p.dispose();
  }
}
