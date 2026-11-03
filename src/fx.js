// Pooled particle effects, 4 draw calls in total:
//   puffs  (Points, normal blend)  : tyre smoke, off-road dust, wheel-spray mist. Soft lumpy sprites with
//                                    fake sphere lighting (lit top, shaded underside) tinted per time of day.
//   glow   (Points, additive, HDR) : nitro exhaust glow, spark impact flash.
//   hot    (instanced streaks, additive, HDR): nitro flame tongues (blue core -> orange), sparks with trails.
//   drops  (instanced streaks, normal blend) : water droplets thrown by the wheels in rain.
// CPU integrates a ring buffer per pool; GPU builds the sprites. Colours > 1 are intentional: with Post
// enabled they land in the HDR buffer and bloom; without it they simply saturate.
import * as THREE from 'three';

const NOISE = /* glsl */`
float fxHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float fxNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(fxHash(i), fxHash(i + vec2(1.0, 0.0)), f.x), mix(fxHash(i + vec2(0.0, 1.0)), fxHash(i + vec2(1.0, 1.0)), f.x), f.y); }`;

// additive blending: fog must fade the light out, not mix toward the (bright) fog colour
const ADD_FOG = /* glsl */`
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    gl_FragColor.rgb *= 1.0 - fogFactor;
  #endif
  gl_FragColor.a = 1.0;`;

// ---------------------------------------------------------------- point sprites
const POINT_VS = /* glsl */`
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
attribute vec2 aSeed;     // x: random 0..1, y: age 0..1
uniform float uScale;
varying float vAlpha;
varying vec3 vColor;
varying vec2 vSeed;
#include <fog_pars_vertex>
void main() {
  vAlpha = aAlpha; vColor = aColor; vSeed = aSeed;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = clamp(aSize * uScale / max(0.1, -mvPosition.z), 0.0, 256.0);
  if (aAlpha <= 0.001) { gl_PointSize = 0.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }
  #include <fog_vertex>
}`;
const PUFF_FS = /* glsl */`
uniform vec3 uLit;
uniform vec3 uShade;
varying float vAlpha;
varying vec3 vColor;
varying vec2 vSeed;
${NOISE}
#include <fog_pars_fragment>
void main() {
  vec2 p = gl_PointCoord - 0.5; p.y = -p.y;
  float r = length(p) * 2.0;
  if (r > 1.0) discard;
  // slowly rotating lumpy silhouette
  float ang = vSeed.x * 6.2831 + vSeed.y * (vSeed.x - 0.5) * 2.0;
  float cs = cos(ang), sn = sin(ang);
  vec2 q = mat2(cs, -sn, sn, cs) * p;
  float n = fxNoise(q * 4.0 + vSeed.x * 31.0) * 0.6 + fxNoise(q * 9.0 - vSeed.x * 17.0) * 0.4;
  float edge = r + (n - 0.5) * (0.45 + vSeed.y * 0.35);
  float dens = clamp(1.0 - edge, 0.0, 1.0);
  dens = dens * dens * (3.0 - 2.0 * dens);
  float a = dens * vAlpha;
  if (a < 0.004) discard;
  // fake sphere normal, light from above / slightly toward the camera
  vec3 N = normalize(vec3(p * 2.0, sqrt(max(0.0, 1.0 - r * r)) + 0.35));
  float l = clamp(dot(N, vec3(0.32, 0.82, 0.47)) * 0.6 + 0.45, 0.0, 1.0);
  l *= 0.82 + 0.36 * n;
  vec3 col = vColor * mix(uShade, uLit, l);
  gl_FragColor = vec4(col, a);
  #include <fog_fragment>
}`;
const GLOW_FS = /* glsl */`
uniform float uIntensity;
varying float vAlpha;
varying vec3 vColor;
varying vec2 vSeed;
#include <fog_pars_fragment>
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float r = length(p) * 2.0;
  if (r > 1.0) discard;
  float a = (1.0 - r); a = a * a * (0.6 + 0.4 * (1.0 - r));
  gl_FragColor = vec4(vColor * uIntensity * a * vAlpha, 1.0);
  ${ADD_FOG}
}`;

// ---------------------------------------------------------------- velocity streaks (instanced quads)
const STREAK_VS = /* glsl */`
attribute vec2 aCorner;   // x: -1..1 across, y: 0 tail .. 1 head
attribute vec3 iPos;
attribute vec3 iAxis;     // world-space trail vector (head - tail), metres
attribute float iSize;
attribute float iAlpha;
attribute vec3 iColor;
varying vec2 vUv;
varying float vAlpha;
varying vec3 vColor;
varying float vCap;       // end-cap length as a fraction of the quad length (for round capsule ends)
#include <fog_pars_vertex>
void main() {
  vec4 hv = modelViewMatrix * vec4(iPos, 1.0);
  vec4 tv = modelViewMatrix * vec4(iPos - iAxis, 1.0);
  // build the quad in the view plane so streaks seen head-on become round blobs, not slivers
  vec2 ax = hv.xy / max(0.1, -hv.z) - tv.xy / max(0.1, -tv.z);
  float L = length(ax);
  vec2 dir = L > 1e-5 ? ax / L : vec2(0.0, 1.0);
  vec2 side = vec2(-dir.y, dir.x);
  float w = iSize * 0.5;
  vec3 head = hv.xyz + vec3(dir * w, 0.0);
  vec3 tail = tv.xyz - vec3(dir * w, 0.0);
  vec4 mvPosition = vec4(mix(tail, head, aCorner.y) + vec3(side * aCorner.x * w, 0.0), 1.0);
  gl_Position = projectionMatrix * mvPosition;
  if (iAlpha <= 0.001) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vUv = aCorner; vAlpha = iAlpha; vColor = iColor;
  vCap = w / (length(hv.xy - tv.xy) + 2.0 * w);
  #include <fog_vertex>
}`;
const CAPSULE = /* glsl */`
varying float vCap;
// 1 at the streak's spine, 0 at its rounded outline
float capsule() {
  float dy = max(0.0, max(vCap - vUv.y, vUv.y - (1.0 - vCap))) / max(vCap, 1e-4);
  float r = length(vec2(vUv.x, dy));
  return 1.0 - smoothstep(0.35, 1.0, r);
}`;
const HOT_FS = /* glsl */`
uniform float uIntensity;
varying vec2 vUv;
varying float vAlpha;
varying vec3 vColor;
${CAPSULE}
#include <fog_pars_fragment>
void main() {
  float across = capsule();
  float along = 0.25 + 0.75 * smoothstep(0.0, 0.7, vUv.y);
  float core = smoothstep(0.6, 1.0, across) * smoothstep(0.4, 0.95, vUv.y);
  vec3 col = vColor * (0.55 + 0.45 * along + core * 0.6) + vec3(core * 0.18);
  gl_FragColor = vec4(col * uIntensity * across * along * vAlpha, 1.0);
  ${ADD_FOG}
}`;
const DROP_FS = /* glsl */`
uniform vec3 uLit;
varying vec2 vUv;
varying float vAlpha;
varying vec3 vColor;
${CAPSULE}
#include <fog_pars_fragment>
void main() {
  float across = capsule();
  float along = smoothstep(0.0, 0.5, vUv.y);
  float a = across * along * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * uLit * (0.8 + 0.4 * vUv.y), a);
  #include <fog_fragment>
}`;

// ---------------------------------------------------------------- CPU simulation pool
class Sim {
  constructor(max) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.base = new Float32Array(max * 3);   // inherited carrier velocity (streak axis is relative to it)
    this.life = new Float32Array(max);
    this.total = new Float32Array(max);
    this.s0 = new Float32Array(max); this.s1 = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.drag = new Float32Array(max); this.grav = new Float32Array(max);
    this.trail = new Float32Array(max);
    this.c0 = new Float32Array(max * 3); this.c1 = new Float32Array(max * 3);
    this.seed = new Float32Array(max);
    this.next = 0; this.dirty = false;
  }
  // o: { x,y,z, vx,vy,vz, life, s0, s1, a, c0, c1, drag, grav, trail, bx,by,bz }
  spawn(x, y, z, vx, vy, vz, life, s0, s1, a0, c0, c1, drag = 0, grav = 0, trail = 0, bx = 0, by = 0, bz = 0) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    const k = i * 3;
    this.pos[k] = x; this.pos[k + 1] = y; this.pos[k + 2] = z;
    this.vel[k] = vx; this.vel[k + 1] = vy; this.vel[k + 2] = vz;
    this.base[k] = bx; this.base[k + 1] = by; this.base[k + 2] = bz;
    this.life[i] = life; this.total[i] = life;
    this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = a0;
    this.c0[k] = c0.r; this.c0[k + 1] = c0.g; this.c0[k + 2] = c0.b;
    this.c1[k] = c1.r; this.c1[k + 1] = c1.g; this.c1[k + 2] = c1.b;
    this.drag[i] = drag; this.grav[i] = grav; this.trail[i] = trail;
    this.seed[i] = Math.random();
    this.dirty = true;
    return i;
  }
  // integrate; calls write(i, t) for live particles, kill(i) once for dead ones
  step(dt) {
    if (!this.dirty) return false;
    let any = false;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        if (this.alpha[i] !== 0) { this.alpha[i] = 0; }
        continue;
      }
      any = true;
      this.life[i] -= dt;
      const k = i * 3;
      const t = 1 - Math.max(0, this.life[i]) / this.total[i];
      const dr = Math.max(0, 1 - this.drag[i] * dt);
      // drag acts on the velocity relative to the carrier, so inherited motion is kept
      const bx = this.base[k], by = this.base[k + 1], bz = this.base[k + 2];
      this.vel[k] = bx + (this.vel[k] - bx) * dr;
      this.vel[k + 1] = by + (this.vel[k + 1] - by) * dr - this.grav[i] * dt;
      this.vel[k + 2] = bz + (this.vel[k + 2] - bz) * dr;
      this.pos[k] += this.vel[k] * dt; this.pos[k + 1] += this.vel[k + 1] * dt; this.pos[k + 2] += this.vel[k + 2] * dt;
      if (this.pos[k + 1] < 0.03) {
        this.pos[k + 1] = 0.03;
        if (this.vel[k + 1] < 0) { this.vel[k + 1] *= -0.35; this.vel[k] *= 0.7; this.vel[k + 2] *= 0.7; }
      }
      this.write(i, t, k);
    }
    if (!any) this.dirty = false;
    return true;
  }
}

class PointPool extends Sim {
  constructor(scene, max, { additive, fragment, uniforms = {}, renderOrder }) {
    super(max);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.col = new Float32Array(max * 3);
    this.sa = new Float32Array(max * 2);
    const g = new THREE.BufferGeometry();
    const dyn = (arr, n) => new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    this.attrs = [dyn(this.pos, 3), dyn(this.size, 1), dyn(this.alpha, 1), dyn(this.col, 3), dyn(this.sa, 2)];
    ['position', 'aSize', 'aAlpha', 'aColor', 'aSeed'].forEach((n, j) => g.setAttribute(n, this.attrs[j]));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: POINT_VS, fragmentShader: fragment, transparent: true, depthWrite: false, fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uScale: { value: 400 }, ...uniforms }]),
    });
    this.obj = new THREE.Points(g, this.mat);
    this.obj.frustumCulled = false;
    this.obj.renderOrder = renderOrder;
    this.obj.userData.disposeWithScene = true; // World.load() frees it when the scene is rebuilt
    this.obj.onBeforeRender = (renderer, sc, camera) => {
      const h = renderer.getRenderTarget() ? renderer.getRenderTarget().height : renderer.getDrawingBufferSize(_v2).y;
      const f = camera.isPerspectiveCamera ? 1 / Math.tan((camera.fov * Math.PI) / 360) : 1;
      this.mat.uniforms.uScale.value = h * 0.5 * f;
    };
    scene.add(this.obj);
  }
  write(i, t, k) {
    this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * (1 - (1 - t) * (1 - t)); // ease-out growth
    this.alpha[i] = this.life[i] > 0 ? this.a0[i] * Math.min(1, t * 10) * (1 - t) * (1 - t * 0.3) : 0;
    this.col[k] = this.c0[k] + (this.c1[k] - this.c0[k]) * t;
    this.col[k + 1] = this.c0[k + 1] + (this.c1[k + 1] - this.c0[k + 1]) * t;
    this.col[k + 2] = this.c0[k + 2] + (this.c1[k + 2] - this.c0[k + 2]) * t;
    this.sa[i * 2] = this.seed[i]; this.sa[i * 2 + 1] = t;
  }
  update(dt) { if (this.step(dt)) for (const a of this.attrs) a.needsUpdate = true; }
  dispose() { this.obj.parent?.remove(this.obj); this.obj.geometry.dispose(); this.mat.dispose(); }
}

class StreakPool extends Sim {
  constructor(scene, max, { additive, fragment, uniforms = {}, renderOrder }) {
    super(max);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.col = new Float32Array(max * 3);
    this.axis = new Float32Array(max * 3);
    this.ipos = new Float32Array(max * 3);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
    g.setAttribute('aCorner', new THREE.Float32BufferAttribute([-1, 0, 1, 0, 1, 1, -1, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const dyn = (arr, n) => new THREE.InstancedBufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    this.attrs = [dyn(this.ipos, 3), dyn(this.axis, 3), dyn(this.size, 1), dyn(this.alpha, 1), dyn(this.col, 3)];
    ['iPos', 'iAxis', 'iSize', 'iAlpha', 'iColor'].forEach((n, j) => g.setAttribute(n, this.attrs[j]));
    g.instanceCount = max;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: STREAK_VS, fragmentShader: fragment, transparent: true, depthWrite: false, fog: true,
      side: THREE.DoubleSide, // quad winding follows the streak direction
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, uniforms]),
    });
    this.obj = new THREE.Mesh(g, this.mat);
    this.obj.frustumCulled = false;
    this.obj.renderOrder = renderOrder;
    this.obj.userData.disposeWithScene = true;
    scene.add(this.obj);
  }
  write(i, t, k) {
    this.ipos[k] = this.pos[k]; this.ipos[k + 1] = this.pos[k + 1]; this.ipos[k + 2] = this.pos[k + 2];
    const tr = this.trail[i];
    this.axis[k] = (this.vel[k] - this.base[k]) * tr;
    this.axis[k + 1] = (this.vel[k + 1] - this.base[k + 1]) * tr;
    this.axis[k + 2] = (this.vel[k + 2] - this.base[k + 2]) * tr;
    this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
    this.alpha[i] = this.life[i] > 0 ? this.a0[i] * Math.min(1, t * 12) * (1 - t * t) : 0;
    this.col[k] = this.c0[k] + (this.c1[k] - this.c0[k]) * t;
    this.col[k + 1] = this.c0[k + 1] + (this.c1[k + 1] - this.c0[k + 1]) * t;
    this.col[k + 2] = this.c0[k + 2] + (this.c1[k + 2] - this.c0[k + 2]) * t;
  }
  update(dt) { if (this.step(dt)) for (const a of this.attrs) a.needsUpdate = true; }
  dispose() { this.obj.parent?.remove(this.obj); this.obj.geometry.dispose(); this.mat.dispose(); }
}

const _v2 = new THREE.Vector2();
const C = (h) => new THREE.Color(h);
const SMOKE0 = C('#e6e6e4'), SMOKE1 = C('#cfcfcc');
const DUST0 = C('#c9a676'), DUST1 = C('#b39a74');
const MIST0 = C('#dfe7ef'), MIST1 = C('#c3ccd6');
const CORE0 = C('#a8caff'), CORE1 = C('#2a4dff');        // blue-white core -> deep blue
const OUTER0 = C('#ffb347'), OUTER1 = C('#ff3a0a');      // yellow -> red-orange
const GLOW_B = C('#4a78ff'), GLOW_O = C('#ff7a2a');
const SPARK0 = C('#fff4c8'), SPARK1 = C('#ff5a10');
const FLASH = C('#ffd9a0');
const DROP0 = C('#eef4fa'), DROP1 = C('#c4d0dc');
const LIGHT = {
  day: { lit: C('#f4f4f4'), shade: C('#7f8794') },
  sunset: { lit: C('#f2d0b6'), shade: C('#5f587a') },
  night: { lit: C('#a9afc2'), shade: C('#2c3142') },
};

export class FX {
  constructor(scene, quality = 'medium') {
    const m = quality === 'low' ? 0.5 : quality === 'high' ? 1.25 : 1;
    this.q = m;
    this.puffs = new PointPool(scene, Math.round(380 * m), {
      additive: false, fragment: PUFF_FS, renderOrder: 5,
      uniforms: { uLit: { value: new THREE.Color(1, 1, 1) }, uShade: { value: new THREE.Color(0.55, 0.57, 0.62) } },
    });
    this.glow = new PointPool(scene, Math.round(64 * m), {
      additive: true, fragment: GLOW_FS, renderOrder: 6, uniforms: { uIntensity: { value: 1.1 } },
    });
    this.hot = new StreakPool(scene, Math.round(360 * m), {
      additive: true, fragment: HOT_FS, renderOrder: 7, uniforms: { uIntensity: { value: 1.7 } },
    });
    this.drops = new StreakPool(scene, Math.round(260 * m), {
      additive: false, fragment: DROP_FS, renderOrder: 5, uniforms: { uLit: { value: new THREE.Color(1, 1, 1) } },
    });
    this._smokeAcc = 0; this._dustAcc = 0; this._sprayAcc = 0; this._mistAcc = 0; this._nitroN = 0;
    this._clock = 0;
    this._emit = []; // nitro emitter tracking -> inherit car velocity
    this.setTimeOfDay('day');
  }

  // Shade smoke/dust/mist to match the scene's light. tod: 'day' | 'sunset' | 'night'
  setTimeOfDay(tod) {
    const L = LIGHT[tod] || LIGHT.day;
    this.puffs.mat.uniforms.uLit.value.copy(L.lit);
    this.puffs.mat.uniforms.uShade.value.copy(L.shade);
    this.drops.mat.uniforms.uLit.value.copy(L.lit).lerp(L.shade, 0.25);
  }

  // drift / tyre smoke. vel = {x,y,z} (m/s), amount 0..1 (per call; call every step while drifting)
  smoke(pos, vel, amount = 1) {
    const am = Math.max(0, Math.min(1, amount));
    this._smokeAcc += am * 2.2 * this.q;
    const v = vel || { x: 0, y: 0.6, z: 0 };
    const r = Math.random;
    while (this._smokeAcc >= 1) {
      this._smokeAcc -= 1;
      this.puffs.spawn(
        pos.x + (r() - 0.5) * 0.5, pos.y + 0.1, pos.z + (r() - 0.5) * 0.5,
        v.x + (r() - 0.5) * 1.6, (v.y || 0.6) + r() * 0.7, v.z + (r() - 0.5) * 1.6,
        1.3 + r() * 1.1, 0.7 + r() * 0.4, 3.4 + r() * 2.0, 0.26 + am * 0.24, SMOKE0, SMOKE1, 1.3, -0.18,
      );
    }
  }

  // nitro exhaust flame; dir = backwards unit vector {x,y,z}; carVel (optional) = car velocity {x,y,z}.
  // Without carVel the emitter's velocity is estimated from successive calls at the same exhaust.
  nitro(pos, dir, carVel) {
    const d = dir || { x: 0, y: 0, z: -1 };
    const cv = carVel || this._emitterVel(pos);
    const bx = cv.x * 0.92, by = 0, bz = cv.z * 0.92;
    const r = Math.random;
    const dy = d.y || 0;
    // blue core: thin, fast, short
    const nc = 1;
    for (let k = 0; k < nc; k++) {
      const sp = 9 + r() * 5;
      this.hot.spawn(
        pos.x + d.x * 0.05, pos.y + (r() - 0.5) * 0.03, pos.z + d.z * 0.05,
        bx + d.x * sp + (r() - 0.5) * 0.8, dy * sp + (r() - 0.3) * 0.5, bz + d.z * sp + (r() - 0.5) * 0.8,
        0.06 + r() * 0.05, 0.12, 0.05, 0.9, CORE0, CORE1, 3, 0, 0.045, bx, by, bz,
      );
    }
    // orange outer tongue: wider, slower, curls up as it cools
    const sp = 6 + r() * 5;
    this.hot.spawn(
      pos.x + d.x * 0.1, pos.y + (r() - 0.5) * 0.06, pos.z + d.z * 0.1,
      bx + d.x * sp + (r() - 0.5) * 1.6, dy * sp + r() * 0.6, bz + d.z * sp + (r() - 0.5) * 1.6,
      0.1 + r() * 0.09, 0.24, 0.1, 0.55, OUTER0, OUTER1, 4, -1.5, 0.05, bx, by, bz,
    );
    // exhaust glow (every few calls; keeps additive overdraw down)
    if ((this._nitroN++ % 3) === 0) {
      this.glow.spawn(pos.x + d.x * 0.25, pos.y, pos.z + d.z * 0.25, bx, 0, bz,
        0.08, 0.55 + r() * 0.2, 0.75, 0.3, r() < 0.5 ? GLOW_B : GLOW_O, GLOW_O, 0, 0, 0, bx, 0, bz);
    }
  }

  // crash sparks: bright, gravity-bound, with motion trails, plus a brief impact flash
  sparks(pos, count = 20) {
    const n = Math.min(120, Math.round(count * this.q));
    const r = Math.random;
    for (let k = 0; k < n; k++) {
      const a = r() * Math.PI * 2, sp = 3 + r() * 10, up = 1.5 + r() * 6;
      this.hot.spawn(
        pos.x, pos.y, pos.z,
        Math.cos(a) * sp, up, Math.sin(a) * sp,
        0.3 + r() * 0.5, 0.05 + r() * 0.03, 0.025, 1.0, SPARK0, SPARK1, 0.8, 14, 0.035 + r() * 0.03,
      );
    }
    if (count >= 15 || r() < 0.3) {
      this.glow.spawn(pos.x, pos.y, pos.z, 0, 0, 0, 0.1, 0.5 + count * 0.012, 1.0 + count * 0.02, 0.7, FLASH, SPARK1);
    }
  }

  // off-road dust puff
  dust(pos) {
    const r = Math.random;
    this._dustAcc += 1.4 * this.q;
    while (this._dustAcc >= 1) {
      this._dustAcc -= 1;
      this.puffs.spawn(
        pos.x + (r() - 0.5) * 0.8, Math.max(0.1, pos.y), pos.z + (r() - 0.5) * 0.8,
        (r() - 0.5) * 1.8, 0.5 + r() * 1.0, (r() - 0.5) * 1.8,
        1.0 + r() * 0.8, 0.6 + r() * 0.4, 2.8 + r() * 1.4, 0.55, DUST0, DUST1, 1.2, -0.05,
      );
    }
  }

  // wet-road spray from a wheel. pos = tyre contact point, vel = car velocity {x,y,z} (m/s),
  // amount 0..1 (scale with speed; call every step for each driven/rear wheel while raining)
  spray(pos, vel, amount = 1) {
    const am = Math.max(0, Math.min(1, amount));
    if (am <= 0) return;
    const v = vel || { x: 0, y: 0, z: 0 };
    const r = Math.random;
    const spd = Math.hypot(v.x, v.z);
    // droplets thrown up and back off the tread
    this._sprayAcc += am * 1.6 * this.q;
    while (this._sprayAcc >= 1) {
      this._sprayAcc -= 1;
      const k = 0.25 + r() * 0.35;
      this.drops.spawn(
        pos.x + (r() - 0.5) * 0.25, pos.y + 0.08 + r() * 0.15, pos.z + (r() - 0.5) * 0.25,
        v.x * k + (r() - 0.5) * 2.2, 1.2 + r() * 2.6 + spd * 0.04, v.z * k + (r() - 0.5) * 2.2,
        0.35 + r() * 0.35, 0.035 + r() * 0.03, 0.02, 0.55 * am + 0.15, DROP0, DROP1, 0.6, 9.8, 0.03,
      );
    }
    // fine mist that hangs behind the car
    this._mistAcc += am * 0.35 * this.q;
    while (this._mistAcc >= 1) {
      this._mistAcc -= 1;
      this.puffs.spawn(
        pos.x + (r() - 0.5) * 0.4, pos.y + 0.25, pos.z + (r() - 0.5) * 0.4,
        v.x * 0.55 + (r() - 0.5) * 1.0, 0.35 + r() * 0.5, v.z * 0.55 + (r() - 0.5) * 1.0,
        0.7 + r() * 0.5, 0.6 + r() * 0.3, 2.4 + r() * 1.4, 0.16 + am * 0.14, MIST0, MIST1, 2.2, -0.05,
      );
    }
  }

  update(dt) {
    const d = Math.min(0.1, dt || 0);
    this._clock += d;
    this.puffs.update(d); this.glow.update(d); this.hot.update(d); this.drops.update(d);
  }

  dispose() {
    for (const p of [this.puffs, this.glow, this.hot, this.drops]) p.dispose();
  }

  // ---------------------------------------------------------- internals
  _emitterVel(pos) {
    const now = this._clock;
    let best = null, bd = 9; // 3 m match radius
    for (let i = this._emit.length - 1; i >= 0; i--) {
      const e = this._emit[i];
      if (now - e.t > 0.25) { this._emit.splice(i, 1); continue; }
      const dx = pos.x - e.x, dz = pos.z - e.z, dd = dx * dx + dz * dz;
      if (dd < bd) { bd = dd; best = e; }
    }
    if (!best) {
      best = { x: pos.x, z: pos.z, t: now, vx: 0, vz: 0 };
      this._emit.push(best);
      if (this._emit.length > 16) this._emit.shift();
      return _ev.set(0, 0, 0);
    }
    const dt = now - best.t;
    if (dt > 1e-4) {
      const vx = (pos.x - best.x) / dt, vz = (pos.z - best.z) / dt;
      if (vx * vx + vz * vz < 120 * 120) { best.vx += (vx - best.vx) * 0.6; best.vz += (vz - best.vz) * 0.6; }
      best.x = pos.x; best.z = pos.z; best.t = now;
    }
    return _ev.set(best.vx, 0, best.vz);
  }
}
const _ev = new THREE.Vector3();
