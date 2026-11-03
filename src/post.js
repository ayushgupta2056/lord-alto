// Post-processing stack: HDR scene -> half-res bloom -> one "grade" pass that does tone mapping,
// warm cinematic colour grading, vignette, film grain and (nitro only) radial blur + chromatic
// aberration -> optional FXAA. Designed for iOS Safari WebGL2: render targets are HalfFloat only
// when the device can really render to them (framebuffer completeness is tested), else RGBA8.
//
// Tone mapping (ACES) + sRGB output are done inside the grade pass, so there is no separate
// OutputPass (saves one full-screen pass on phones). The renderer's own toneMapping/outputColorSpace
// are only used by the fallback path (enabled = false -> renderer.render()).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

// ---------------------------------------------------------------- looks per time of day
// lift/gamma/gain operate on display-referred (sRGB) colour after ACES.
// shadowTint/highTint = split toning (cool violet shadows, warm highlights, the "golden hour" look).
const LOOKS = {
  day: {
    exposure: 1.0, contrast: 1.07, saturation: 1.14,
    lift: [0.0, 0.0, 0.012], gamma: [1.0, 1.0, 1.02], gain: [1.035, 1.0, 0.955],
    shadowTint: [-0.01, 0.0, 0.03], highTint: [0.03, 0.015, -0.02],
    vignette: 0.28, grain: 0.022,
    bloom: { strength: 0.32, radius: 0.55, threshold: 1.05 },
  },
  sunset: {
    exposure: 1.04, contrast: 1.09, saturation: 1.18,
    lift: [0.015, 0.0, 0.032], gamma: [0.98, 1.0, 1.03], gain: [1.08, 0.985, 0.88],
    shadowTint: [0.015, -0.01, 0.05], highTint: [0.05, 0.015, -0.035],
    vignette: 0.36, grain: 0.028,
    bloom: { strength: 0.55, radius: 0.62, threshold: 0.85 },
  },
  night: {
    exposure: 1.12, contrast: 1.1, saturation: 1.12,
    lift: [0.004, 0.004, 0.026], gamma: [1.0, 1.0, 1.04], gain: [1.06, 0.99, 0.9],
    shadowTint: [0.0, 0.005, 0.045], highTint: [0.05, 0.02, -0.03],
    vignette: 0.42, grain: 0.035,
    bloom: { strength: 0.75, radius: 0.6, threshold: 0.62 },
  },
};
// Rain: cooler, flatter, a touch more glare.
const RAIN = { saturation: 0.86, contrast: 0.97, gain: [0.97, 0.99, 1.04], lift: [0.0, 0.006, 0.02], bloomStrength: 1.2, bloomThreshold: 0.88, haze: 0.08 };

// ---------------------------------------------------------------- grade shader
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uHasDepth: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uExposure: { value: 1 },
    uContrast: { value: 1 },
    uSaturation: { value: 1 },
    uLift: { value: new THREE.Vector3() },
    uGamma: { value: new THREE.Vector3(1, 1, 1) },
    uGain: { value: new THREE.Vector3(1, 1, 1) },
    uShadowTint: { value: new THREE.Vector3() },
    uHighTint: { value: new THREE.Vector3() },
    uHaze: { value: 0 },
    uHazeColor: { value: new THREE.Vector3(0.75, 0.78, 0.82) },
    uVignette: { value: 0.3 },
    uGrain: { value: 0.02 },
    uSpeed: { value: 0 },   // radial blur + CA strength 0..1 (nitro)
    uFlash: { value: 0 },   // lightning / impact flash 0..1
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform float uHasDepth;
    uniform vec2 uRes;
    uniform float uTime, uExposure, uContrast, uSaturation, uHaze, uVignette, uGrain, uSpeed, uFlash;
    uniform vec3 uLift, uGamma, uGain, uShadowTint, uHighTint, uHazeColor;
    varying vec2 vUv;

    // ACES fitted (Narkowicz/Hill), same curve as three's ACESFilmicToneMapping
    vec3 gradeAcesFit(vec3 v) {
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }
    vec3 aces(vec3 c) {
      const mat3 IN = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
      const mat3 OUT = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
      c = IN * (c / 0.6);
      c = gradeAcesFit(c);
      return clamp(OUT * c, 0.0, 1.0);
    }
    vec3 toSRGB(vec3 c) {
      return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
    }
    float hash(vec2 p) { // stable, highp-safe hash (no big sin args)
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 d = vUv - 0.5;
      vec3 c;
      if (uSpeed > 0.002) {
        // nitro: 6-tap radial (zoom) blur, stronger toward the edges, + chromatic aberration
        float r2 = dot(d, d);
        float k = uSpeed * 0.06 * smoothstep(0.02, 0.35, r2);
        vec3 acc = vec3(0.0);
        for (int i = 0; i < 6; i++) {
          float s = 1.0 - k * float(i) / 5.0;
          acc += texture2D(tDiffuse, 0.5 + d * s).rgb;
        }
        c = acc / 6.0;
        float ca = uSpeed * 0.0035 * smoothstep(0.0, 0.3, r2);
        c.r = mix(c.r, texture2D(tDiffuse, 0.5 + d * (1.0 + ca * 2.0)).r, 0.85);
        c.b = mix(c.b, texture2D(tDiffuse, 0.5 + d * (1.0 - ca * 2.0)).b, 0.85);
      } else {
        c = texture2D(tDiffuse, vUv).rgb;
      }

      // The sky is an sRGB cube that three never tone-maps on screen: keep it untouched here too
      // (depth == far plane), otherwise ACES would wash it out.
      float sky = uHasDepth * step(0.99999, texture2D(tDepth, vUv).r);
      // ACES per channel skews bright saturated lights (tail lamps, neon) toward orange/white;
      // blend in a hue-preserving (luminance-ratio) version so reds stay red.
      vec3 ce = c * uExposure;
      float Le = dot(ce, vec3(0.2126, 0.7152, 0.0722));
      vec3 tmHue = clamp(ce * (aces(vec3(Le)).g / max(Le, 1e-5)), 0.0, 1.0);
      vec3 tm = mix(aces(ce), tmHue, 0.4);
      c = mix(tm, clamp(c, 0.0, 1.0), sky);
      c = toSRGB(c) + uFlash * 0.35 * (0.4 + 0.6 * sky);

      // lift / gamma / gain
      c = c * uGain + uLift * (1.0 - c);
      c = pow(max(c, vec3(0.0)), 1.0 / uGamma);
      // contrast: smooth S-curve (no hard clipping at either end)
      vec3 sc = clamp(c, 0.0, 1.0);
      c = mix(c, sc * sc * (3.0 - 2.0 * sc), (uContrast - 1.0) * 2.5);
      // saturation
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation);
      // split toning
      c += uShadowTint * (1.0 - smoothstep(0.0, 0.55, l)) + uHighTint * smoothstep(0.45, 1.0, l);
      // rain haze: lift + desaturate toward a cool grey, more toward the top of the frame (distance)
      c = mix(c, uHazeColor, uHaze * (0.5 + 0.5 * vUv.y));

      // vignette (aspect-correct, soft)
      vec2 vd = d * vec2(uRes.x / uRes.y, 1.0);
      float vig = smoothstep(0.35, 1.05, length(vd) * (1.0 + uSpeed * 0.15));
      c *= 1.0 - vig * (uVignette + uSpeed * 0.12);

      // film grain (luma-weighted, strongest in mid-tones) + 8-bit dither against banding
      float n = hash(vUv * uRes + fract(uTime * 7.31) * 517.0) - 0.5;
      c += n * uGrain * (0.4 + 0.6 * (1.0 - abs(l * 2.0 - 1.0)));
      c += (hash(vUv * uRes + 71.7) - 0.5) / 255.0;

      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

// ---------------------------------------------------------------- helpers
const lerp = (a, b, t) => a + (b - a) * t;
function testTarget(renderer, opts) {
  // Returns true if the GPU can actually render into a target with these options.
  const gl = renderer.getContext();
  const rt = new THREE.WebGLRenderTarget(4, 4, opts);
  const prev = renderer.getRenderTarget();
  let ok = false;
  try {
    while (gl.getError() !== gl.NO_ERROR) { /* flush old errors */ }
    renderer.setRenderTarget(rt);
    ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    if (ok) { renderer.clear(); ok = gl.getError() === gl.NO_ERROR; }
  } catch (e) { ok = false; }
  renderer.setRenderTarget(prev);
  rt.dispose();
  return ok;
}

export class Post {
  // opts.hdr = false forces 8-bit targets (debug / known-bad devices)
  constructor(renderer, { quality = 'medium', hdr = true } = {}) {
    this.renderer = renderer;
    this.quality = quality;
    this._allowHdr = hdr !== false;
    this.enabled = false;
    this._tod = 'day';
    this._weather = 'clear';
    this._speed = 0; this._nitro = false; this._fxAmt = 0;
    this._flash = 0;
    this._time = 0;
    this._checks = 0;
    this._cur = null;   // current (smoothed) look values
    this._tgt = null;   // target look values
    try {
      this._init();
      this.enabled = true;
    } catch (e) {
      console.warn('[post] disabled:', e);
      this.enabled = false;
      try { this.dispose(); } catch (_) { /* ignore */ }
    }
  }

  _init() {
    const r = this.renderer;
    const ext = r.extensions;
    const caps = r.capabilities;
    if (!caps.isWebGL2) throw new Error('WebGL2 required');

    // 1. pick a render-target format the device can render to
    const canHalf = this._allowHdr && (ext.has('EXT_color_buffer_half_float') || ext.has('EXT_color_buffer_float'))
      && testTarget(r, { type: THREE.HalfFloatType });
    const type = canHalf ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.hdr = canHalf;

    // 2. anti-aliasing: MSAA on the scene target (cheap on tiled mobile GPUs) or FXAA on low
    let samples = 0;
    const wantMsaa = this.quality !== 'low';
    if (wantMsaa && caps.maxSamples > 0) {
      const s = Math.min(4, caps.maxSamples);
      if (testTarget(r, { type, samples: s })) samples = s;
    }
    this.aa = samples > 0 ? `msaa${samples}` : 'fxaa';

    // 3. depth texture (lets the grade pass leave the sRGB sky untouched); optional
    const withDepth = testTarget(r, { type, samples, depthTexture: new THREE.DepthTexture(4, 4) });
    this.hasDepth = withDepth;

    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const W0 = Math.max(1, size.x), H0 = Math.max(1, size.y);
    const rt = new THREE.WebGLRenderTarget(W0, H0, {
      type, samples, depthBuffer: true, stencilBuffer: false,
      depthTexture: withDepth ? new THREE.DepthTexture(W0, H0) : null,
    });
    rt.texture.name = 'post.scene';
    this.composer = new EffectComposer(r, rt);
    if (withDepth) {
      // RenderTarget.clone() clones the depth texture but shares its Source, i.e. the same GL texture:
      // give the second buffer a truly separate one or the FXAA path forms a feedback loop.
      const rt2 = this.composer.renderTarget2;
      rt2.depthTexture = new THREE.DepthTexture(W0, H0);
    }
    this.composer.setPixelRatio(r.getPixelRatio());

    // 4. passes
    this.renderPass = new RenderPass(null, null);
    this.composer.addPass(this.renderPass);

    const b = LOOKS.day.bloom;
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), b.strength, b.radius, b.threshold);
    if (!canHalf) {
      // UnrealBloomPass hard-codes HalfFloat targets: downgrade before they are ever allocated
      const all = [this.bloom.renderTargetBright, ...this.bloom.renderTargetsHorizontal, ...this.bloom.renderTargetsVertical];
      for (const t of all) t.texture.type = THREE.UnsignedByteType;
    }
    // bloom resolution: UnrealBloomPass already starts at 1/2 res; on low go to 1/4 and use 3 mips
    this._bloomScale = this.quality === 'low' ? 0.5 : 1;
    if (this.quality === 'low') {
      this.bloom.nMips = 3; // the two unused mips are never rendered; _apply() zeroes their tint
    }
    const origSetSize = this.bloom.setSize.bind(this.bloom);
    this.bloom.setSize = (w, h) => origSetSize(Math.max(2, Math.round(w * this._bloomScale)), Math.max(2, Math.round(h * this._bloomScale)));
    this.composer.addPass(this.bloom);

    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);

    if (this.aa === 'fxaa') {
      this.fxaa = new ShaderPass(FXAAShader);
      this.composer.addPass(this.fxaa);
    }

    this._cur = this._look();
    this._tgt = this._look();
    this._apply(1);
    const pr = r.getPixelRatio();
    this.setSize(size.x / pr, size.y / pr, pr);
  }

  // ------------------------------------------------------------ public API
  setSize(w, h, pixelRatio) {
    if (!this.composer) return;
    if (pixelRatio) this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h); // calls pass.setSize(w*pr, h*pr)
    const pr = pixelRatio || this.renderer.getPixelRatio();
    const W = Math.max(1, Math.round(w * pr)), H = Math.max(1, Math.round(h * pr));
    this.grade.uniforms.uRes.value.set(W, H);
    if (this.fxaa) this.fxaa.uniforms.resolution.value.set(1 / W, 1 / H);
  }

  setTimeOfDay(tod) {
    this._tod = LOOKS[tod] ? tod : 'day';
    this._tgt = this._look();
  }

  setWeather(kind) {
    this._weather = kind === 'rain' ? 'rain' : 'clear';
    this._tgt = this._look();
  }

  // speed01: 0..1 of top speed; nitroOn: bool. Radial blur/CA only while nitro is on.
  setSpeedFx(speed01, nitroOn) {
    this._speed = Math.max(0, Math.min(1, speed01 || 0));
    this._nitro = !!nitroOn;
  }

  // Optional: brief full-screen flash (lightning, big crash). v 0..1, decays by itself.
  flash(v = 1) { this._flash = Math.max(this._flash, v); }

  render(scene, camera, dt = 1 / 60) {
    if (!this.enabled) { this.renderer.render(scene, camera); return; }
    try {
      const d = Math.min(0.1, Math.max(0, dt || 0));
      this._time += d;
      // ease look changes over ~1 s; fx ease fast in, slower out
      this._apply(1 - Math.exp(-d * 3));
      const fxT = this._nitro ? 0.35 + 0.65 * this._speed : 0;
      this._fxAmt = lerp(this._fxAmt, fxT, 1 - Math.exp(-d * (fxT > this._fxAmt ? 10 : 4)));
      this._flash = Math.max(0, this._flash - d * 4);
      const u = this.grade.uniforms;
      u.uTime.value = this._time;
      u.uSpeed.value = this._fxAmt < 0.003 ? 0 : this._fxAmt;
      u.uFlash.value = this._flash;
      const depth = this.hasDepth ? this.composer.readBuffer.depthTexture : null;
      u.tDepth.value = depth;
      u.uHasDepth.value = depth ? 1 : 0;
      this.renderPass.scene = scene;
      this.renderPass.camera = camera;
      this.composer.render(d);
      if (this._checks < 3) this._checkPrograms(); // shader compile errors don't throw: verify once
    } catch (e) {
      console.warn('[post] render failed, falling back:', e);
      this.enabled = false;
      this.renderer.setRenderTarget(null);
      this.renderer.render(scene, camera);
    }
  }

  dispose() {
    this.composer?.dispose?.();
    this.composer?.renderTarget1?.dispose();
    this.composer?.renderTarget2?.dispose();
    this.bloom?.dispose();
    this.grade?.material?.dispose();
    this.fxaa?.material?.dispose();
  }

  // ------------------------------------------------------------ internals
  _checkPrograms() {
    this._checks++;
    const mats = [this.grade.material, this.bloom.compositeMaterial, this.bloom.materialHighPassFilter, this.fxaa?.material];
    for (const m of mats) {
      if (!m) continue;
      const prog = this.renderer.properties.get(m).currentProgram;
      if (prog && prog.diagnostics && prog.diagnostics.runnable === false) {
        throw new Error('post shader failed to compile');
      }
    }
  }

  _look() {
    const L = LOOKS[this._tod];
    const rain = this._weather === 'rain';
    const mul3 = (a, m) => a.map((v, i) => v * m[i]);
    const add3 = (a, m) => a.map((v, i) => v + m[i]);
    const thrScale = this.hdr ? 1 : 0.8; // LDR targets clip at 1: bloom needs a lower threshold
    return {
      exposure: L.exposure * (rain ? 0.96 : 1),
      contrast: L.contrast * (rain ? RAIN.contrast : 1),
      saturation: L.saturation * (rain ? RAIN.saturation : 1),
      lift: rain ? add3(L.lift, RAIN.lift) : L.lift.slice(),
      gamma: L.gamma.slice(),
      gain: rain ? mul3(L.gain, RAIN.gain) : L.gain.slice(),
      shadowTint: L.shadowTint.slice(),
      highTint: rain ? L.highTint.map((v) => v * 0.5) : L.highTint.slice(),
      vignette: L.vignette, grain: L.grain * (rain ? 1.15 : 1),
      haze: rain ? (this._tod === 'night' ? RAIN.haze * 0.5 : RAIN.haze) : 0,
      bloomStrength: L.bloom.strength * (rain ? RAIN.bloomStrength : 1),
      bloomRadius: L.bloom.radius,
      bloomThreshold: L.bloom.threshold * (rain ? RAIN.bloomThreshold : 1) * thrScale,
    };
  }

  _apply(t) {
    const c = this._cur, g = this._tgt;
    for (const k in c) {
      if (Array.isArray(c[k])) for (let i = 0; i < 3; i++) c[k][i] = lerp(c[k][i], g[k][i], t);
      else c[k] = lerp(c[k], g[k], t);
    }
    const u = this.grade.uniforms;
    u.uExposure.value = c.exposure * (this.renderer.toneMappingExposure || 1);
    u.uContrast.value = c.contrast;
    u.uSaturation.value = c.saturation;
    u.uLift.value.fromArray(c.lift);
    u.uGamma.value.fromArray(c.gamma);
    u.uGain.value.fromArray(c.gain);
    u.uShadowTint.value.fromArray(c.shadowTint);
    u.uHighTint.value.fromArray(c.highTint);
    u.uVignette.value = c.vignette;
    u.uGrain.value = c.grain;
    u.uHaze.value = c.haze;
    this.bloom.strength = c.bloomStrength;
    this.bloom.radius = c.bloomRadius;
    this.bloom.threshold = c.bloomThreshold;
    if (this.bloom.nMips < 5) {
      // composite uses mix(factor, 1.2 - factor, radius), so zero the tint of the unused mips instead
      const tints = this.bloom.compositeMaterial.uniforms.bloomTintColors.value;
      for (let i = this.bloom.nMips; i < tints.length; i++) tints[i].set(0, 0, 0);
    }
  }
}
