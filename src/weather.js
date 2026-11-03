// Weather: rain streaks that follow the camera (one draw call, all motion on the GPU), splash
// ripples on the road around the car (one instanced draw), wet-road material patch, fog closing in,
// and occasional distant lightning at night. Clear weather costs nothing (meshes hidden).
import * as THREE from 'three';

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();

// ---------------------------------------------------------------- rain streaks
const RAIN_VS = /* glsl */`
attribute vec3 aSeed;     // 0..1 position inside the rain box
attribute vec2 aCorner;   // x: -1..1 across, y: 0 = tail, 1 = head
uniform vec3 uCam;        // camera position (box centre)
uniform vec3 uBox;        // box size
uniform float uFall;      // accumulated fall distance (m)
uniform vec3 uDrift;      // accumulated wind drift (m)
uniform vec3 uVel;        // rain velocity relative to the camera (m/s): streak direction & length
uniform float uLen;       // streak exposure time (s)
uniform float uWidth;
uniform float uDensity;   // 0..1 fraction of drops visible
varying float vAlpha;
varying vec2 vUv;
#include <fog_pars_vertex>
void main() {
  // wrap each drop inside a box centred on the camera so rain is infinite and costs nothing on CPU
  vec3 p = aSeed * uBox + vec3(uDrift.x, -uFall, uDrift.z);
  p = mod(p - (uCam - uBox * 0.5), uBox) + (uCam - uBox * 0.5);
  float on = step(aSeed.x * 0.37 + aSeed.z * 0.63, uDensity) * step(0.0, p.y); // density + nothing below ground
  vec3 head = p;
  vec3 tail = p - uVel * uLen;
  vec4 hv = modelViewMatrix * vec4(head, 1.0);
  vec4 tv = modelViewMatrix * vec4(tail, 1.0);
  vec3 axis = hv.xyz - tv.xyz;
  vec3 side = normalize(cross(axis, hv.xyz) + vec3(1e-5, 0.0, 0.0));
  vec4 mvPosition = mix(tv, hv, aCorner.y);
  float distFade = smoothstep(0.6, 2.5, -mvPosition.z) * (1.0 - smoothstep(uBox.z * 0.35, uBox.z * 0.5, length(mvPosition.xyz)));
  mvPosition.xyz += side * aCorner.x * uWidth * (1.0 + -mvPosition.z * 0.04);
  gl_Position = projectionMatrix * mvPosition;
  vAlpha = on * distFade * (0.55 + 0.45 * fract(aSeed.y * 31.7));
  vUv = aCorner;
  #include <fog_vertex>
}`;
const RAIN_FS = /* glsl */`
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
varying vec2 vUv;
#include <fog_pars_fragment>
void main() {
  float across = 1.0 - abs(vUv.x);
  float along = smoothstep(0.0, 0.35, vUv.y) * (1.0 - smoothstep(0.85, 1.0, vUv.y) * 0.5);
  float a = across * across * along * vAlpha * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
  #include <fog_fragment>
}`;

// ---------------------------------------------------------------- splash ripples
const RIPPLE_VS = /* glsl */`
attribute vec4 aData;   // x, z, birth time, size
attribute float aY;
uniform float uTime;
uniform float uLife;
varying vec2 vUv;
varying float vT;
#include <fog_pars_vertex>
void main() {
  float t = (uTime - aData.z) / uLife;
  vT = t;
  vUv = position.xz * 2.0;  // plane in -0.5..0.5 -> -1..1
  vec3 p = vec3(aData.x + position.x * aData.w, aY, aData.y + position.z * aData.w);
  if (t < 0.0 || t > 1.0) p = vec3(0.0, -1000.0, 0.0);
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const RIPPLE_FS = /* glsl */`
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
varying float vT;
#include <fog_pars_fragment>
void main() {
  float r = length(vUv);
  float R = 0.15 + vT * 0.85;                   // ring grows
  float w = 0.06 + vT * 0.08;
  float ring = 1.0 - smoothstep(0.0, w, abs(r - R));
  float ring2 = 1.0 - smoothstep(0.0, w * 0.8, abs(r - R * 0.55));   // inner echo ring
  float centre = (1.0 - smoothstep(0.0, 0.18, r)) * (1.0 - smoothstep(0.0, 0.25, vT)); // initial impact dot
  float a = (ring + ring2 * 0.45 * step(0.2, vT) + centre) * (1.0 - vT) * (1.0 - vT) * uOpacity;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
  #include <fog_fragment>
}`;

// ---------------------------------------------------------------- wet surfaces
// Patch a MeshStandardMaterial so it darkens, turns glossy and grows puddles as `wet` rises.
// Shared uniform: every patched material follows the same weather.
const WET = { value: 0 };
const WET_PATCHED = new WeakSet();
export function makeWettable(material) {
  if (!material || !material.isMeshStandardMaterial || WET_PATCHED.has(material)) return material;
  WET_PATCHED.add(material);
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    shader.uniforms.uWet = WET;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWetPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWetPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uWet;
        varying vec3 vWetPos;
        float wetN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
          float b = fract(sin(dot(i + vec2(1, 0), vec2(127.1, 311.7))) * 43758.5453);
          float c = fract(sin(dot(i + vec2(0, 1), vec2(127.1, 311.7))) * 43758.5453);
          float d = fract(sin(dot(i + vec2(1, 1), vec2(127.1, 311.7))) * 43758.5453);
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        float wetPuddle = 0.0;
        if (uWet > 0.001) {
          vec2 wp = vWetPos.xz;
          float n = wetN(wp * 0.11) * 0.65 + wetN(wp * 0.43) * 0.35;
          wetPuddle = smoothstep(0.56, 0.66, n) * uWet;
          float wetAmt = uWet * (0.75 + 0.25 * n);
          diffuseColor.rgb *= mix(1.0, 0.5, wetAmt) * (1.0 - wetPuddle * 0.3);
          roughnessFactor = mix(roughnessFactor, 0.42, wetAmt);
          roughnessFactor = mix(roughnessFactor, 0.08, wetPuddle);
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        // puddles are flat mirrors: drop any normal-map detail toward the geometric normal
        normal = normalize(mix(normal, nonPerturbedNormal, wetPuddle));`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        reflectedLight.indirectSpecular *= 1.0 + uWet * 0.25 + wetPuddle * 0.5;`);
  };
  const key = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => (key ? key() : '') + '|wet';
  material.needsUpdate = true;
  return material;
}

export class Weather {
  // opts.timeOfDay: 'day'|'sunset'|'night' (lightning only at night); can also be set via setTimeOfDay
  constructor(scene, quality = 'medium', opts = {}) {
    this.scene = scene;
    this.quality = quality;
    this.kind = 'clear';
    this.intensity = 0;     // eased 0..1
    this.target = 0;
    this.time = 0;
    this.fall = 0;
    this.drift = new THREE.Vector3();
    this.wind = new THREE.Vector3(1.2, 0, 0.6);
    this.tod = opts.timeOfDay || 'day';
    this.lightning = 0;     // 0..1 flash envelope (read this to drive Post.flash / thunder audio)
    this.onLightning = null; // callback(distance01) when a bolt happens -> play thunder
    this._nextBolt = 6 + Math.random() * 10;
    this._prevCam = new THREE.Vector3();
    this._camVel = new THREE.Vector3();
    this._hasPrev = false;
    this._fog = null;

    const q = quality === 'low' ? 0 : quality === 'high' ? 2 : 1;
    this._build([1400, 2800, 4800][q], [90, 160, 240][q]);
    this._autoWet(scene);
  }

  _build(drops, ripples) {
    // rain: N quads (4 verts / 6 indices each) sharing a per-drop seed
    const seed = new Float32Array(drops * 4 * 3);
    const corner = new Float32Array(drops * 4 * 2);
    const idx = new Uint32Array(drops * 6);
    const C = [[-1, 0], [1, 0], [1, 1], [-1, 1]];
    for (let i = 0; i < drops; i++) {
      const sx = Math.random(), sy = Math.random(), sz = Math.random();
      for (let k = 0; k < 4; k++) {
        const v = i * 4 + k;
        seed[v * 3] = sx; seed[v * 3 + 1] = sy; seed[v * 3 + 2] = sz;
        corner[v * 2] = C[k][0]; corner[v * 2 + 1] = C[k][1];
      }
      const b = i * 4;
      idx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(drops * 4 * 3), 3)); // unused, required
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
    g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.rainMat = new THREE.ShaderMaterial({
      vertexShader: RAIN_VS, fragmentShader: RAIN_FS,
      transparent: true, depthWrite: false, fog: true, side: THREE.DoubleSide, // quad winding follows the streak
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uCam: { value: new THREE.Vector3() }, uBox: { value: new THREE.Vector3(36, 22, 36) },
        uFall: { value: 0 }, uDrift: { value: new THREE.Vector3() }, uVel: { value: new THREE.Vector3(0, -14, 0) },
        uLen: { value: 0.045 }, uWidth: { value: 0.012 }, uDensity: { value: 0 },
        uColor: { value: new THREE.Color('#c9d6e8') }, uOpacity: { value: 0.5 },
      }]),
    });
    this.rain = new THREE.Mesh(g, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 8;
    this.rain.visible = false;
    this.rain.userData.disposeWithScene = true;
    this.scene.add(this.rain);

    // ripples: instanced flat quads
    const pg = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const ig = new THREE.InstancedBufferGeometry();
    ig.index = pg.index; ig.setAttribute('position', pg.getAttribute('position'));
    this.rData = new Float32Array(ripples * 4).fill(-1e4);
    this.rY = new Float32Array(ripples);
    this.aData = new THREE.InstancedBufferAttribute(this.rData, 4).setUsage(THREE.DynamicDrawUsage);
    this.aY = new THREE.InstancedBufferAttribute(this.rY, 1).setUsage(THREE.DynamicDrawUsage);
    ig.setAttribute('aData', this.aData);
    ig.setAttribute('aY', this.aY);
    ig.instanceCount = ripples;
    this.rippleMax = ripples; this.rippleNext = 0; this.rippleAcc = 0;
    this.rippleMat = new THREE.ShaderMaterial({
      vertexShader: RIPPLE_VS, fragmentShader: RIPPLE_FS,
      transparent: true, depthWrite: false, fog: true,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uTime: { value: 0 }, uLife: { value: 0.55 }, uColor: { value: new THREE.Color('#dfe8f4') }, uOpacity: { value: 0.45 },
      }]),
    });
    this.ripples = new THREE.Mesh(ig, this.rippleMat);
    this.ripples.frustumCulled = false;
    this.ripples.renderOrder = 4;
    this.ripples.visible = false;
    this.ripples.userData.disposeWithScene = true;
    this.scene.add(this.ripples);

    // lightning briefly boosts the scene's existing hemisphere light (adding a light would force
    // every material to recompile); the sky/screen flash comes from Post.flash(weather.lightning)
    this.scene.traverse((o) => { if (!this.hemi && o.isHemisphereLight) this.hemi = o; });
  }

  // Patch road-like materials. World can flag any material with material.userData.wettable = true;
  // otherwise the heuristic picks rough, textured, polygon-offset ground materials (road + markings).
  _autoWet(scene) {
    const flagged = [], guess = [];
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m || !m.isMeshStandardMaterial) continue;
        if (m.userData?.wettable) flagged.push(m);
        else if (m.map && m.polygonOffset && m.roughness >= 0.85 && m.metalness < 0.2) guess.push(m);
      }
    });
    for (const m of flagged.length ? flagged : guess) makeWettable(m);
  }
  // Explicitly make a material react to rain (call for any material created after construction).
  wetten(material) { return makeWettable(material); }

  setTimeOfDay(tod) { this.tod = tod; }

  set(kind) {
    this.kind = kind === 'rain' ? 'rain' : 'clear';
    this.target = this.kind === 'rain' ? 1 : 0;
    if (this.kind === 'rain') { this.rain.visible = true; this.ripples.visible = true; }
  }

  // dt seconds; camera: THREE.Camera; carSpeed m/s (forward); focus (optional): car position for ripples
  update(dt, camera, carSpeed = 0, focus = null) {
    const d = Math.min(0.1, Math.max(0, dt || 0));
    this.time += d;
    const prevI = this.intensity;
    this.intensity += (this.target - this.intensity) * (1 - Math.exp(-d * 0.8));
    if (Math.abs(this.target - this.intensity) < 0.002) this.intensity = this.target;
    const I = this.intensity;
    WET.value = Math.min(1, I * 1.15);
    this._updateFog(I);

    if (I <= 0.001) {
      if (prevI > 0.001 || this.rain.visible) { this.rain.visible = false; this.ripples.visible = false; }
      this._endBolt();
      this._hasPrev = false;
      return;
    }
    this.rain.visible = true; this.ripples.visible = true;

    // camera velocity (for streak stretch)
    camera.getWorldPosition(_v);
    if (this._hasPrev && d > 0) {
      const cv = _v.clone().sub(this._prevCam).divideScalar(d);
      if (cv.lengthSq() > 80 * 80) cv.setLength(80); // teleports / respawns
      this._camVel.lerp(cv, 1 - Math.exp(-d * 8));
    }
    this._prevCam.copy(_v); this._hasPrev = true;

    // rain uniforms
    const fallSpeed = 13;
    this.fall += fallSpeed * d;
    this.drift.addScaledVector(this.wind, d);
    if (this.fall > 1e4) this.fall -= 1e4;
    const u = this.rainMat.uniforms;
    u.uCam.value.copy(_v);
    u.uFall.value = this.fall;
    u.uDrift.value.copy(this.drift);
    u.uVel.value.set(this.wind.x - this._camVel.x, -fallSpeed, this.wind.z - this._camVel.z);
    u.uDensity.value = I;
    u.uOpacity.value = this.tod === 'night' ? 0.32 : 0.5;
    u.uColor.value.set(this.tod === 'night' ? '#a9b8d8' : this.tod === 'sunset' ? '#e6d4c8' : '#c9d6e8');
    // length: base ~4.5 cm exposure, a little longer with speed so the screen feels fast
    u.uLen.value = 0.04 + Math.min(1, Math.abs(carSpeed) / 50) * 0.02;

    // ripples near the car (or in front of the camera)
    this.rippleMat.uniforms.uTime.value = this.time;
    this.rippleMat.uniforms.uOpacity.value = this.tod === 'night' ? 0.3 : 0.42;
    camera.getWorldDirection(_fwd); _fwd.y = 0; _fwd.normalize();
    const cx = focus ? focus.x : _v.x + _fwd.x * 10, cz = focus ? focus.z : _v.z + _fwd.z * 10;
    const gy = (focus ? focus.y : 0) + 0.03;
    this.rippleAcc += d * this.rippleMax * 2.2 * I; // ~ each ring lives 0.55 s
    let dirty = false;
    while (this.rippleAcc >= 1) {
      this.rippleAcc -= 1;
      const a = Math.random() * Math.PI * 2, rr = 1.5 + Math.sqrt(Math.random()) * 16;
      // bias ahead of the car where the camera is looking
      const x = cx + Math.cos(a) * rr + _fwd.x * 6, z = cz + Math.sin(a) * rr + _fwd.z * 6;
      const i = this.rippleNext; this.rippleNext = (i + 1) % this.rippleMax;
      this.rData[i * 4] = x; this.rData[i * 4 + 1] = z;
      this.rData[i * 4 + 2] = this.time - Math.random() * 0.03;
      this.rData[i * 4 + 3] = 0.35 + Math.random() * 0.35;
      this.rY[i] = gy;
      dirty = true;
    }
    if (dirty) { this.aData.needsUpdate = true; this.aY.needsUpdate = true; }

    // lightning (night storms only)
    if (this.tod === 'night' && I > 0.6) {
      this._nextBolt -= d;
      if (this._nextBolt <= 0) {
        this._nextBolt = 7 + Math.random() * 14;
        this._endBolt();
        this._bolt = { t: 0, dist: Math.random(), base: this.hemi ? this.hemi.intensity : 0 };
        this.onLightning?.(this._bolt.dist);
      }
    }
    if (this._bolt) {
      const b = this._bolt; b.t += d;
      // double flicker envelope
      const f = Math.exp(-b.t * 9) + (b.t > 0.12 ? 0.7 * Math.exp(-(b.t - 0.12) * 7) : 0);
      this.lightning = Math.min(1, f) * (1 - b.dist * 0.6);
      if (this.hemi) this.hemi.intensity = b.base + this.lightning * 1.6;
      if (b.t > 0.9) this._endBolt();
    }
  }

  _endBolt() {
    if (this._bolt && this.hemi) this.hemi.intensity = this._bolt.base;
    this._bolt = null; this.lightning = 0;
  }

  _updateFog(I) {
    const fog = this.scene.fog;
    if (!fog || !fog.isFog) return;
    if (!this._fog) this._fog = { near: fog.near, far: fog.far, color: fog.color.clone() };
    const f = this._fog;
    fog.near = f.near * (1 - 0.55 * I);
    fog.far = f.far * (1 - 0.4 * I);
    _rainFog.copy(f.color).lerp(_grey, 0.35 * I);
    fog.color.copy(_rainFog);
  }

  dispose() {
    if (this._fog && this.scene.fog?.isFog) {
      this.scene.fog.near = this._fog.near; this.scene.fog.far = this._fog.far; this.scene.fog.color.copy(this._fog.color);
    }
    WET.value = 0;
    this._endBolt();
    for (const o of [this.rain, this.ripples]) o.parent?.remove(o);
    this.rain.geometry.dispose(); this.rainMat.dispose();
    this.ripples.geometry.dispose(); this.rippleMat.dispose();
  }
}
const _grey = new THREE.Color('#7d8794');
const _rainFog = new THREE.Color();
