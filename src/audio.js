// Procedural Web Audio for Lord Alto. No audio files: every sound is synthesised.
// Safe to call any method before unlock(): they simply do nothing until the AudioContext exists.
//
// Mix (gains in dB, see dB()):  master (volume / mute) -> glue compressor -> brick-wall limiter -> out
//   engBus  : engine tone + intake + whine/turbo + lift-off pops  (ducked under crashes)
//   sfx     : skid, impacts, UI, stingers
//   musicBus: menu garba loop
//
// Engine model (Maruti Alto, 3-cylinder 4-stroke, 5-speed):
//   rpm is simulated here from speed01 + throttle (gears, upshift cut, downshift blip, launch slip,
//   idle wobble, slew limited). One 4-stroke cycle = 2 crank turns = 3 firings, so the oscillators run
//   at the CYCLE rate (rpm / 120) with a PeriodicWave built from 3 slightly uneven exhaust pulses per
//   period: the firing rate (rpm / 60 * 1.5) and its harmonics dominate, the cycle-rate sub-harmonics
//   give the lopey 3-pot thrum. Graph (12 nodes, all persistent):
//     oscA + oscB(detuned) -> drive -> soft-clip -> lowpass -> engOut -> engBus
//     noise -> intake bandpass -> AM (by oscB, pulses with each firing) -> intakeLvl -> engOut
//     whine sine (gearbox, road speed; slides up into a turbo whistle on nitro) -> whineGain -> engBus

const MUTE_KEY = 'lordalto.muted';
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v || 0);
const lerp = (a, b, k) => a + (b - a) * k;
const dB = (db) => Math.pow(10, db / 20);
const MUSIC_SCREENS = new Set(['menu', 'tracks', 'garage', 'mp', 'lobby', 'results']);
const ENGINE_SCREENS = new Set(['race', 'pause']);

// ---- engine tuning
const IDLE_RPM = 900;
const RED_RPM = 6800;
const UPSHIFT_RPM = 6500;
const MAX_RPM = 7000;
// speed01 at which each gear would reach RED_RPM (short first gear, long fifth: 5th never hits the limiter)
const GEAR_TOP = [0.13, 0.27, 0.45, 0.68, 1.05];
const GEAR_CURVE = 1.2; // >1 widens each gear's rpm span (shift drops land ~2,700-4,000 rpm)
const SHIFT_CUT = 0.08; // s of throttle cut on an upshift
const SHIFT_GAP = 0.28; // min s between shifts
const rpmInGear = (g, s) => RED_RPM * Math.pow(s / GEAR_TOP[g - 1], GEAR_CURVE);

let _silentUrl = null;
/** A tiny looping-safe silent WAV (0.25 s, 8 kHz, 8-bit mono), built once as a blob URL. */
function silentWavUrl() {
  if (_silentUrl) return _silentUrl;
  const n = 2000, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  _silentUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  return _silentUrl;
}

function readMuted() { try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; } }
const nowS = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

export class GameAudio {
  constructor() {
    this.ctx = null;
    this._muted = readMuted();
    this.volume = 0.9;
    this._musicVol = 0.5;
    this._musicWanted = false;
    this._screen = null;
    // engine simulation state (readable for debugging: _rpm, _gear)
    this._gear = 1;
    this._rpm = IDLE_RPM;
    this._nit = 0;
    this._cutUntil = 0;
    this._blipUntil = 0;
    this._lastShift = 0;
    this._engLast = 0;
    this._onTime = 0;
    this._engG = 0;
    this._lpF = 400;
    if (typeof window !== 'undefined') {
      window.addEventListener('lordalto:music', (e) => this.setMusicVolume(e.detail?.volume));
      window.addEventListener('ui:screen', (e) => {
        this._screen = e.detail?.screen || null;
        this.music(MUSIC_SCREENS.has(this._screen));
      });
      this._installLifecycle();
    }
  }

  // ------------------------------------------------------------------ setup
  /**
   * iOS Safari rules this has to live with:
   *  - an AudioContext only starts/resumes inside a real user activation: touchend / pointerup / click / keydown
   *    (NOT touchstart / pointerdown), so we listen to all of them, for the whole session;
   *  - it suspends when the page is hidden and goes 'interrupted' after a call, Siri or an alarm, and it does
   *    not always come back by itself;
   *  - Web Audio is silenced by the ring/silent switch unless the audio session is 'playback'.
   */
  _installLifecycle() {
    const onGesture = () => {
      if (document.hidden) return;
      if (!this.ctx) { this.unlock(); return; }
      if (this.ctx.state !== 'running') this.unlock();
      else this._unlockMediaSession();
    };
    for (const ev of ['touchend', 'pointerup', 'click', 'keydown']) window.addEventListener(ev, onGesture, { capture: true, passive: true });
    const wake = () => { if (!document.hidden) this._resume(); };
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) {
        this._hiddenSuspend = true;
        this.ctx.suspend().catch(() => {});
        this._silentEl?.pause();
      } else {
        this._hiddenSuspend = false;
        wake();
      }
    });
    window.addEventListener('pageshow', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('pagehide', () => { this._silentEl?.pause(); });
  }

  /** Best-effort resume without a gesture (works after interruptions on most iOS versions; else the next tap does it). */
  _resume() {
    const c = this.ctx;
    if (!c || this._hiddenSuspend || c.state === 'running' || c.state === 'closed') return;
    c.resume().catch(() => {});
  }

  /** iOS: route Web Audio through the 'playback' session so the silent switch does not mute the game. */
  _unlockMediaSession() {
    try {
      const s = navigator.audioSession; // Safari 16.4+
      if (s && 'type' in s) {
        if (s.type !== 'playback') s.type = 'playback';
        return;
      }
    } catch { /* ignore */ }
    // Older iOS: keep a silent <audio> element playing; that switches the page to the playback category.
    const isIOS = /iP(hone|od|ad)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    if (!isIOS || document.hidden) return;
    try {
      if (!this._silentEl) {
        const a = document.createElement('audio');
        a.setAttribute('x-webkit-airplay', 'deny');
        a.setAttribute('playsinline', '');
        a.disableRemotePlayback = true;
        a.preload = 'auto';
        a.loop = true;
        a.src = silentWavUrl();
        this._silentEl = a;
      }
      if (this._silentEl.paused) this._silentEl.play().catch(() => {});
    } catch { /* ignore */ }
  }

  unlock() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC({ latencyHint: 'interactive' });
        this._build();
        // 'interrupted' (iOS: call / Siri / alarm) or a suspend we did not ask for: try to come back
        this.ctx.onstatechange = () => {
          const st = this.ctx?.state;
          if (st === 'interrupted' || (st === 'suspended' && !this._hiddenSuspend && !document.hidden)) {
            clearTimeout(this._resumeT);
            this._resumeT = setTimeout(() => this._resume(), 300);
          }
        };
      }
      this._unlockMediaSession();
      if (this.ctx.state !== 'running') {
        // iOS needs a sound started inside the gesture: a 1-sample silent buffer
        const b = this.ctx.createBuffer(1, 1, 22050);
        const s = this.ctx.createBufferSource();
        s.buffer = b; s.connect(this.ctx.destination); s.start(0);
        this._hiddenSuspend = false;
        this.ctx.resume().catch(() => {});
      }
      if (this._musicWanted) this._startMusic();
    } catch (e) {
      console.warn('[audio] unavailable', e);
      this.ctx = null;
    }
  }

  _build() {
    const c = this.ctx;
    this.master = c.createGain();
    this.master.gain.value = this._muted ? 0 : this.volume;
    // glue compressor, then a fast brick-wall limiter as the anti-clip safety net (~ -1 dBFS ceiling)
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 8; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.25;
    const lim = c.createDynamicsCompressor();
    lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.08;
    this.master.connect(comp).connect(lim).connect(c.destination);
    this.sfx = this._gain(1, this.master);
    this.engBus = this._gain(1, this.master);
    this.musicBus = this._gain(this._musicVol * 0.55, this.master);

    // white noise
    const len = c.sampleRate * 2;
    this.noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // small synthetic reverb (decaying stereo noise impulse)
    const irLen = Math.floor(c.sampleRate * 1.6);
    const ir = c.createBuffer(2, irLen, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const x = ir.getChannelData(ch);
      for (let i = 0; i < irLen; i++) x[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 3.2);
    }
    const verb = c.createConvolver();
    verb.buffer = ir;
    this.verbSend = c.createGain();
    this.verbSend.gain.value = 1;
    this.verbSend.connect(verb).connect(this._gain(0.32, this.master));

    // soft-clip shaper for impacts
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; curve[i] = Math.tanh(x * 3.2); }
    this.shaperCurve = curve;

    // shared looping noise (engine intake + tyre squeal)
    this.noiseLoop = c.createBufferSource();
    this.noiseLoop.buffer = this.noiseBuf; this.noiseLoop.loop = true;
    this.noiseLoop.start();

    this._buildEngine();
    this._buildSkid();
    this._buildWind();
  }

  /** Wind + road roar: filtered noise that swells with speed, so going fast sounds fast even when the engine
   *  is just cycling through its gears. Low band = tyre/road rumble, high band = wind rush. */
  _buildWind() {
    const c = this.ctx;
    this.windGain = c.createGain(); this.windGain.gain.value = 0;
    this.windHi = c.createBiquadFilter(); this.windHi.type = 'bandpass'; this.windHi.frequency.value = 900; this.windHi.Q.value = 0.6;
    this.roadLo = c.createBiquadFilter(); this.roadLo.type = 'lowpass'; this.roadLo.frequency.value = 220; this.roadLo.Q.value = 0.9;
    this.roadGain = c.createGain(); this.roadGain.gain.value = 0;
    this.noiseLoop.connect(this.windHi).connect(this.windGain).connect(this.engBus);
    this.noiseLoop.connect(this.roadLo).connect(this.roadGain).connect(this.engBus);
  }

  _wind(t, s, nitro, active) {
    if (!this.windGain) return;
    // quadratic in speed: silent when slow, a real rush near top speed; nitro pushes it further
    // (nitro only brightens it; the turbo layer already adds loudness, so the mix stays out of the limiter)
    const w = active * Math.pow(s, 1.6);
    this.windGain.gain.setTargetAtTime(Math.min(0.2, w * 0.2), t, 0.12);
    this.windHi.frequency.setTargetAtTime(500 + s * 1700 + nitro * 500, t, 0.15);
    this.roadGain.gain.setTargetAtTime(active * Math.min(0.3, s * 0.3), t, 0.12);
    this.roadLo.frequency.setTargetAtTime(120 + s * 260, t, 0.15);
  }

  /** PeriodicWave for one 4-stroke cycle of a 3-cylinder: 3 exhaust pulses, slightly uneven in size and timing. */
  _engineWave(o) {
    const M = 1024, H = 96, TAU = Math.PI * 2;
    const x = new Float32Array(M);
    for (let cyl = 0; cyl < 3; cyl++) {
      const start = cyl / 3 + o.jitter[cyl];
      for (let n = 0; n < M; n++) {
        let ph = n / M - start; ph -= Math.floor(ph);
        const u = ph * 3; // time since this cylinder fired, in firing intervals (0..3)
        const env = (1 - Math.exp(-u / o.attack)) * Math.exp(-u / o.decay);
        x[n] += o.amps[cyl] * env * (Math.sin(TAU * 0.9 * u) + o.ring * Math.sin(TAU * o.ringF * u));
      }
    }
    const cosT = new Float32Array(M), sinT = new Float32Array(M);
    for (let n = 0; n < M; n++) { cosT[n] = Math.cos(TAU * n / M); sinT[n] = Math.sin(TAU * n / M); }
    const re = new Float32Array(H + 1), im = new Float32Array(H + 1);
    for (let k = 1; k <= H; k++) {
      let a = 0, b = 0;
      for (let n = 0, idx = 0; n < M; n++, idx = (idx + k) % M) { a += x[n] * cosT[idx]; b += x[n] * sinT[idx]; }
      const taper = 1 - 0.55 * (k / H); // soften the very top so the raw wave is not fizzy
      re[k] = (a * 2 / M) * taper; im[k] = (b * 2 / M) * taper;
    }
    // normalise the band-limited result ourselves so the two layers can sit at different levels
    let peak = 1e-6;
    for (let n = 0; n < M; n += 2) {
      let v = 0;
      for (let k = 1, idx = 0; k <= H; k++) { idx = (idx + n) % M; v += re[k] * cosT[idx] + im[k] * sinT[idx]; }
      peak = Math.max(peak, Math.abs(v));
    }
    const sc = o.level / peak;
    for (let k = 1; k <= H; k++) { re[k] *= sc; im[k] *= sc; }
    return this.ctx.createPeriodicWave(re, im, { disableNormalization: true });
  }

  _buildEngine() {
    const c = this.ctx;
    // tone: two detuned pulse-train layers -> drive -> asymmetric soft clip -> lowpass -> out
    this.engOut = this._gain(0, this.engBus);
    this.engLP = this._filter('lowpass', 400, 0.9);
    this.engLP.connect(this.engOut);
    this.engShaper = c.createWaveShaper();
    const N = 2048, K = 4, bias = 0.06, sc = new Float32Array(N);
    let mx = 0;
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1;
      sc[i] = Math.tanh(K * (x + bias)) - Math.tanh(K * bias);
      mx = Math.max(mx, Math.abs(sc[i]));
    }
    for (let i = 0; i < N; i++) sc[i] /= mx;
    this.engShaper.curve = sc;
    this.engShaper.oversample = '2x';
    this.engShaper.connect(this.engLP);
    this.engDrive = this._gain(0.1, this.engShaper);
    const mkOsc = (wave, detune) => {
      const o = c.createOscillator();
      o.setPeriodicWave(wave); o.frequency.value = IDLE_RPM / 120; o.detune.value = detune;
      o.connect(this.engDrive); o.start();
      return o;
    };
    // A: round, thumpy main voice. B: rasp layer (shorter, ringier pulses), quieter and detuned for width
    this.eoA = mkOsc(this._engineWave({ amps: [1, 0.86, 0.94], jitter: [0, 0.011, -0.007], attack: 0.012, decay: 0.17, ring: 0.38, ringF: 4.5, level: 1 }), 0);
    this.eoB = mkOsc(this._engineWave({ amps: [0.92, 1, 0.83], jitter: [0, -0.009, 0.013], attack: 0.006, decay: 0.07, ring: 0.75, ringF: 7.2, level: 0.55 }), 7);

    // intake roar: resonant band of noise, amplitude-modulated by the firing pulses (oscB)
    this.intakeBP = this._filter('bandpass', 600, 2.5);
    this.intakeAM = this._gain(0.25, null);
    this.intakeLvl = this._gain(0, this.engOut);
    this.eoB.connect(this.intakeAM.gain);
    this.noiseLoop.connect(this.intakeBP).connect(this.intakeAM).connect(this.intakeLvl);

    // gearbox whine (road speed) that slides into a turbo whistle on nitro
    this.whineGain = this._gain(0, this.engBus);
    this.whine = c.createOscillator(); this.whine.type = 'sine'; this.whine.frequency.value = 600;
    this.whine.connect(this.whineGain); this.whine.start();

    // lift-off pop / crackle one-shot sample (thump + crack, lightly smoothed)
    const sr = c.sampleRate, pl = Math.floor(sr * 0.09);
    this.popBuf = c.createBuffer(1, pl, sr);
    const p = this.popBuf.getChannelData(0);
    let y = 0, pk = 1e-6;
    for (let i = 0; i < pl; i++) {
      const tt = i / sr;
      const body = Math.sin(2 * Math.PI * (85 - 250 * tt) * tt) * Math.exp(-tt / 0.016);
      const crack = (Math.random() * 2 - 1) * Math.exp(-tt / 0.004);
      const tail = Math.random() < 0.12 ? (Math.random() * 2 - 1) * Math.exp(-tt / 0.025) * 0.6 : 0;
      y += (body * 0.9 + crack + tail - y) * 0.5;
      p[i] = y; pk = Math.max(pk, Math.abs(y));
    }
    for (let i = 0; i < pl; i++) p[i] /= pk;
  }

  _buildSkid() {
    const c = this.ctx;
    // tyre squeal: narrow resonant band of noise + a quiet tonal squeal through the same band, plus broadband scrub
    this.skidGain = this._gain(0, this.sfx);
    this.skidBP = this._filter('bandpass', 1000, 7);
    this.skidBP.connect(this.skidGain);
    this.noiseLoop.connect(this.skidBP);
    this.skidScrub = this._filter('bandpass', 2600, 0.9);
    this.noiseLoop.connect(this.skidScrub).connect(this._gain(0.3, this.skidGain));
    this.skidToneG = this._gain(0, this.skidBP);
    this.skidTone = c.createOscillator(); this.skidTone.type = 'sawtooth'; this.skidTone.frequency.value = 1000;
    this.skidTone.connect(this.skidToneG); this.skidTone.start();
  }

  // ------------------------------------------------------------------ mute
  setMuted(b) {
    this._muted = !!b;
    try { localStorage.setItem(MUTE_KEY, this._muted ? '1' : '0'); } catch { /* ignore */ }
    if (this.ctx) this.master.gain.setTargetAtTime(this._muted ? 0 : this.volume, this.ctx.currentTime, 0.03);
  }
  get muted() { return this._muted; }

  _active() { return this._screen == null || ENGINE_SCREENS.has(this._screen) ? 1 : 0; }

  // ------------------------------------------------------------------ continuous
  engine(speed01, throttle, nitro) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const now = nowS();
    let dt = this._engLast ? now - this._engLast : 0;
    this._engLast = now;
    if (!(dt > 0)) dt = 0; else if (dt > 0.1) dt = 0.1;
    const s = clamp01(Math.abs(speed01)), th = clamp01(throttle);
    const nIn = nitro ? (typeof nitro === 'number' ? clamp01(nitro) : 1) : 0;
    const active = this._active();
    this._wind(t, s, nIn, active);

    // turbo spool: quick up, slower down
    this._nit += (nIn - this._nit) * Math.min(1, dt * (nIn > this._nit ? 5 : 2.2));
    const nit = this._nit;

    // ---- gearbox
    let g = this._gear, upshift = false;
    // sudden speed jumps (crash, respawn, dropped frames): skip gears instead of shifting one at a time
    while (g > 1 && rpmInGear(g, s) < 1100) g--;
    while (g < 5 && rpmInGear(g, s) > 8500) g++;
    if (now - this._lastShift > SHIFT_GAP) {
      if (g < 5 && rpmInGear(g, s) > UPSHIFT_RPM) {
        g++; upshift = true;
        this._cutUntil = now + SHIFT_CUT; this._lastShift = now;
      } else if (g > 1 && rpmInGear(g, s) < (th > 0.5 ? 2300 : 1950) && rpmInGear(g - 1, s) < 6000) {
        g--; this._lastShift = now; this._blipUntil = now + 0.12; // rev-matching blip
      }
    }
    this._gear = g;
    const cut = now < this._cutUntil;
    const thE = cut ? 0 : th;

    // ---- rpm target
    let target = Math.max(IDLE_RPM, rpmInGear(g, s));
    if (g === 1) { // clutch slip: free revving at a standstill, launch rpm held (with a slight bite sag) until the gear catches up
      const k = clamp01(s / 0.1);
      target = Math.max(target, (IDLE_RPM + th * 3800) * (1 - 0.15 * k));
    }
    target += nit * 350 * (0.4 + 0.6 * thE);
    const idleK = clamp01((1500 - target) / 600);
    if (idleK > 0) target += (32 * Math.sin(now * 3.9) + 16 * Math.sin(now * 11.3 + 1)) * idleK;
    target = Math.min(MAX_RPM, target);
    // slew limiter: never jumps, except the fast drop through an upshift and the downshift blip
    const up = now < this._blipUntil ? 30000 : 3500 + th * 9000 + nit * 4000;
    const down = cut ? 50000 : 6500;
    const dr = target - this._rpm;
    this._rpm += dr > 0 ? Math.min(dr, up * dt) : Math.max(dr, -down * dt);
    const rpm = this._rpm;
    const rN = clamp01((rpm - IDLE_RPM) / (RED_RPM - IDLE_RPM));

    // ---- tone
    const f0 = rpm / 120; // 4-stroke cycle rate; firing rate = 3 * f0 = rpm / 60 * 1.5
    this.eoA.frequency.setTargetAtTime(f0, t, 0.018);
    this.eoB.frequency.setTargetAtTime(f0, t, 0.018);
    const fast = cut ? 0.012 : 0.03;
    this.engDrive.gain.setTargetAtTime(0.1 + thE * 0.22 + rN * 0.05 + nit * 0.12, t, fast);
    // on throttle: open, bright, a little nasal resonance. off throttle: muffled
    const lpF = lerp(200 + rpm * 0.14, 500 + rpm * 0.62, thE) + nit * 900;
    this.engLP.frequency.setTargetAtTime(lpF, t, lpF > this._lpF ? fast : 0.05);
    this.engLP.Q.setTargetAtTime(0.8 + thE * 1.0 + nit * 0.4, t, 0.05);
    this._lpF = lpF;
    let gEng = lerp(dB(-24 + 6 * rN), dB(-15 + 5 * rN), thE) * (1 + nit * 0.19);
    if (now < this._blipUntil) gEng *= 1.15;
    gEng *= active;
    this.engOut.gain.setTargetAtTime(gEng, t, cut ? 0.012 : gEng > this._engG ? 0.025 : 0.06);
    this._engG = gEng;

    // ---- intake roar (rises with load) -> turbo whoosh on nitro
    const load = thE * (0.35 + 0.65 * rN);
    this.intakeBP.frequency.setTargetAtTime((320 + rpm * 0.3) * (1 + 1.3 * nit), t, 0.04);
    this.intakeBP.Q.setTargetAtTime(2.5 + nit * 2, t, 0.08);
    this.intakeAM.gain.setTargetAtTime(0.25 + nit * 0.5, t, 0.08);
    this.intakeLvl.gain.setTargetAtTime(0.1 + 1.9 * load + nit * 1.2, t, fast);

    // ---- gearbox whine (road speed) / turbo whistle (boost)
    const wf = lerp(420 + s * 2300, 3000 + rN * 2800, nit) * (1 + 0.004 * Math.sin(now * 31));
    this.whine.frequency.setTargetAtTime(wf, t, 0.06);
    const wg = (s > 0.01 ? dB(-50 + 14 * s) : 0) + nit * dB(-30) * (0.5 + 0.5 * thE);
    this.whineGain.gain.setTargetAtTime(wg * active, t, 0.08);

    // ---- pops & crackle: on lift-off after a pull, sometimes on a hard upshift, light overrun burble
    if (active) {
      if (upshift && th > 0.7 && rpm > 5000 && Math.random() < 0.45) this._pop(t + 0.012, 0.6);
      if (th > 0.6) this._onTime += dt;
      else if (th < 0.15) {
        if (this._onTime > 0.3 && rpm > 3200) this._pops(t, 2 + Math.floor(Math.random() * 4), rN);
        this._onTime = 0;
        if (rpm > 3000 && s > 0.2 && Math.random() < dt * 1.5) this._pop(t + 0.01, 0.25 + Math.random() * 0.25);
      }
    }

    clearTimeout(this._engTO);
    this._engTO = setTimeout(() => this._silenceEngine(), 300);
  }

  _pops(t, count, k) {
    let tt = t + 0.03;
    for (let i = 0; i < count; i++) {
      this._pop(tt, (0.35 + Math.random() * 0.5) * (0.6 + 0.4 * k));
      tt += 0.04 + Math.random() * 0.1;
    }
  }

  _pop(t, vol) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.popBuf;
    src.playbackRate.value = 0.75 + Math.random() * 0.6;
    src.connect(this._gain(vol * 0.22, this.engBus));
    src.start(t);
  }

  _silenceEngine() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.engOut.gain.setTargetAtTime(0, t, 0.08);
    this.whineGain.gain.setTargetAtTime(0, t, 0.08);
    this.skidGain.gain.setTargetAtTime(0, t, 0.05);
    if (this.windGain) { this.windGain.gain.setTargetAtTime(0, t, 0.08); this.roadGain.gain.setTargetAtTime(0, t, 0.08); }
    this._engG = 0;
    this._onTime = 0;
  }

  skid(amount01) {
    if (!this.ctx) return;
    const a = clamp01(amount01), t = this.ctx.currentTime, now = nowS();
    const active = this._active();
    // rubber: pitch wobbles (two slow LFOs + jitter) and the level chatters slightly
    const wob = 1 + 0.03 * Math.sin(now * 33.3) + 0.018 * Math.sin(now * 79.1 + 1.3) + (Math.random() - 0.5) * 0.016;
    const f = (820 + a * 520) * wob;
    this.skidBP.frequency.setTargetAtTime(f, t, 0.025);
    this.skidTone.frequency.setTargetAtTime(f * 0.995, t, 0.025);
    this.skidScrub.frequency.setTargetAtTime(2200 + a * 1400, t, 0.05);
    const tone = clamp01((a - 0.25) / 0.75);
    this.skidToneG.gain.setTargetAtTime(0.05 * tone * tone, t, 0.05);
    const chatter = 1 + 0.18 * Math.sin(now * 49.6);
    this.skidGain.gain.setTargetAtTime(a * a * 0.9 * chatter * active, t, 0.035);
    clearTimeout(this._skidTO);
    this._skidTO = setTimeout(() => { if (this.ctx) this.skidGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05); }, 300);
  }

  /** Briefly dip the engine bus so an impact cuts through (sidechain-style ducking). */
  _duck(db, release) {
    const g = this.engBus.gain, t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(dB(db), t, 0.008);
    g.setTargetAtTime(1, t + 0.12, release);
  }

  // ------------------------------------------------------------------ one-shots
  crash(power01) {
    if (!this.ctx) return;
    const p = clamp01(power01 ?? 0.5), t = this.ctx.currentTime + 0.005;
    this._duck(-3 - 5 * p, 0.2);
    const nz = this._noise(t, 0.3);
    const lp = this._filter('lowpass', 2400, 0.7);
    lp.frequency.setValueAtTime(2400, t);
    lp.frequency.exponentialRampToValueAtTime(350, t + 0.25);
    nz.connect(lp).connect(this._env(t, 0.65 * p + 0.1, 0.003, 0.26, this.sfx));
    this._sweep('sine', 120, 42, t, 0.28, 0.8 * p + 0.15, this.sfx);
  }

  dhadaak() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime + 0.01;
    this._duck(-10, 0.45);
    const out = this._gain(0.95, this.sfx);
    const wet = this._gain(0.55, this.verbSend);
    // 1) huge low boom through soft clipping
    const shaper = c.createWaveShaper();
    shaper.curve = this.shaperCurve;
    shaper.connect(out);
    this._sweep('sine', 170, 32, t, 1.1, 1.0, shaper, 0.003, 0.55);
    this._sweep('triangle', 95, 40, t, 0.5, 0.45, shaper, 0.002, 0.3);
    // 2) crunch: noise through a closing lowpass
    const nz = this._noise(t, 0.6);
    const lp = this._filter('lowpass', 6000, 0.9);
    lp.frequency.setValueAtTime(6000, t);
    lp.frequency.exponentialRampToValueAtTime(260, t + 0.5);
    const crunch = this._env(t, 0.85, 0.002, 0.5, out);
    nz.connect(lp).connect(crunch);
    crunch.connect(wet);
    // 3) metal clang: FM bell plus inharmonic partials
    const hp = this._filter('highpass', 260, 0.7);
    hp.connect(out); hp.connect(wet);
    const car = c.createOscillator(); car.type = 'sine'; car.frequency.value = 410;
    const mod = c.createOscillator(); mod.type = 'sine'; mod.frequency.value = 410 * 1.47;
    const modG = c.createGain();
    modG.gain.setValueAtTime(1100, t);
    modG.gain.exponentialRampToValueAtTime(40, t + 0.7);
    mod.connect(modG).connect(car.frequency);
    car.connect(this._env(t, 0.32, 0.002, 1.0, hp));
    car.start(t); mod.start(t); car.stop(t + 1.2); mod.stop(t + 1.2);
    [[587, 0.11, 0.9], [1043, 0.09, 0.75], [1567, 0.07, 0.55], [2389, 0.05, 0.42], [3301, 0.035, 0.3]].forEach(([f, g, dcy]) => {
      this._tone('sine', f * (0.985 + Math.random() * 0.03), t + 0.004, dcy, g, hp, 0.002);
    });
    // 4) debris tinkles
    for (let i = 0; i < 5; i++) {
      const tt = t + 0.1 + Math.random() * 0.4;
      const n2 = this._noise(tt, 0.06);
      const bp = this._filter('bandpass', 4500 + Math.random() * 4000, 9);
      n2.connect(bp).connect(this._env(tt, 0.2 + Math.random() * 0.15, 0.001, 0.05, out));
    }
    // 5) rising comic whoosh
    const wz = this._noise(t + 0.06, 0.7);
    const bp = this._filter('bandpass', 350, 3);
    bp.frequency.setValueAtTime(350, t + 0.06);
    bp.frequency.exponentialRampToValueAtTime(5200, t + 0.62);
    const wg = c.createGain();
    wg.gain.setValueAtTime(0.0001, t + 0.06);
    wg.gain.linearRampToValueAtTime(0.42, t + 0.5);
    wg.gain.linearRampToValueAtTime(0.0001, t + 0.68);
    wz.connect(bp).connect(wg).connect(out);
    wg.connect(wet);
    // 6) a bright "kshh" sting on top
    this._sweep('square', 1800, 3600, t + 0.48, 0.18, 0.05, out, 0.005, 0.15);
  }

  horn() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime + 0.005, dur = 0.42;
    if (this._hornG) { try { this._hornG.gain.cancelScheduledValues(t); this._hornG.gain.setTargetAtTime(0, t, 0.01); } catch { /* ignore */ } }
    const bp = this._filter('bandpass', 1100, 0.8);
    const lp = this._filter('lowpass', 3600, 0.7);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.17, t + 0.012);
    g.gain.setValueAtTime(0.17, t + dur - 0.05);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    bp.connect(lp).connect(g).connect(this.sfx);
    this._hornG = g;
    for (const f of [415, 523]) {
      const o = c.createOscillator();
      o.type = 'square';
      o.frequency.setValueAtTime(f * 0.97, t);
      o.frequency.linearRampToValueAtTime(f, t + 0.03);
      o.connect(bp);
      o.start(t); o.stop(t + dur + 0.02);
    }
  }

  nitroStart() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime + 0.005;
    this._nit = Math.max(this._nit, 0.5); // kick the engine's turbo spool immediately
    // 1) punch: short low thump
    this._sweep('sine', 125, 46, t, 0.26, 0.55, this.sfx, 0.002, 0.18);
    // 2) blow-off "pssh-tu-tu": bright noise with a decaying valve flutter
    const nz = this._noise(t, 0.42);
    const hp = this._filter('highpass', 1600, 0.8);
    const fl = c.createGain(); fl.gain.value = 0.55;
    const lfo = c.createOscillator(); lfo.type = 'square';
    lfo.frequency.setValueAtTime(34, t); lfo.frequency.linearRampToValueAtTime(17, t + 0.32);
    const lfoD = c.createGain();
    lfoD.gain.setValueAtTime(0.45, t); lfoD.gain.exponentialRampToValueAtTime(0.01, t + 0.34);
    lfo.connect(lfoD).connect(fl.gain);
    lfo.start(t); lfo.stop(t + 0.45);
    nz.connect(hp).connect(fl).connect(this._env(t, 0.34, 0.003, 0.32, this.sfx));
    // 3) rising whoosh as the boost comes in
    const t2 = t + 0.03;
    const wz = this._noise(t2, 0.9);
    const bp = this._filter('bandpass', 380, 1.6);
    bp.frequency.setValueAtTime(380, t2);
    bp.frequency.exponentialRampToValueAtTime(3400, t2 + 0.52);
    const wg = c.createGain();
    wg.gain.setValueAtTime(0.0001, t2);
    wg.gain.linearRampToValueAtTime(0.5, t2 + 0.3);
    wg.gain.exponentialRampToValueAtTime(0.0001, t2 + 0.88);
    wz.connect(bp).connect(wg).connect(this.sfx);
    wg.connect(this._gain(0.3, this.verbSend));
    // 4) turbo whistle chirp
    this._sweep('sine', 2400, 5600, t + 0.05, 0.6, 0.035, this.sfx, 0.08, 0.5);
  }

  /** Nitro bottle grabbed: a quick bright rising chime with a little shimmer. */
  pickup() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + 0.003;
    [880, 1318.5, 1760].forEach((f, i) => {
      this._tone('triangle', f, t + i * 0.045, 0.16, 0.13, this.sfx, 0.002);
      this._tone('sine', f * 2, t + i * 0.045, 0.2, 0.04, this.verbSend, 0.002);
    });
    this._sweep('sine', 1200, 3600, t, 0.22, 0.035, this.sfx, 0.01, 0.2);
  }

  countdown(final) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + 0.005;
    const f = final ? 1046.5 : 523.25, dur = final ? 0.55 : 0.17;
    this._tone('sine', f, t, dur, 0.28, this.sfx, 0.004, true);
    this._tone('square', f, t, dur, 0.05, this.sfx, 0.004, true);
    if (final) this._tone('sine', f * 2, t, dur, 0.06, this.verbSend, 0.004, true);
  }

  lapDing() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + 0.005;
    [[1568, 0.2, 1.2], [2352, 0.1, 0.8], [3140, 0.05, 0.5]].forEach(([f, g, d]) => {
      this._tone('sine', f, t, d, g, this.sfx, 0.002);
      this._tone('sine', f, t, d, g * 0.6, this.verbSend, 0.002);
    });
    this._tone('sine', 2093, t + 0.12, 0.9, 0.12, this.sfx, 0.002);
  }

  finish() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + 0.01;
    const lp = this._filter('lowpass', 2800, 0.6);
    lp.connect(this.sfx); lp.connect(this.verbSend);
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => {
      const tt = t + i * 0.11;
      this._tone('square', f, tt, 0.16, 0.08, lp, 0.005, true);
      this._tone('triangle', f * 2, tt, 0.16, 0.06, lp, 0.005, true);
    });
    const tc = t + 0.5;
    [523.25, 659.25, 783.99, 1046.5].forEach((f) => {
      this._tone('square', f, tc, 1.0, 0.05, lp, 0.01, true);
      this._tone('sawtooth', f * 1.003, tc, 1.0, 0.03, lp, 0.01, true);
    });
    this._tone('sine', 130.8, tc, 1.0, 0.25, this.sfx, 0.01, true);
  }

  click() {
    if (!this.ctx) return;
    this._sweep('sine', 1500, 800, this.ctx.currentTime + 0.002, 0.05, 0.07, this.sfx, 0.001, 0.04);
  }

  // ------------------------------------------------------------------ music
  /** Light procedural garba loop: dhol, dandiya clicks, tanpura drone and a Bhupali melody. */
  music(on) {
    this._musicWanted = !!on;
    if (!this.ctx) return;
    if (on) this._startMusic(); else this._stopMusic();
  }

  setMusicVolume(v) {
    if (v == null || !isFinite(v)) return;
    this._musicVol = clamp01(v);
    if (this.ctx) this.musicBus.gain.setTargetAtTime(this._musicVol * 0.55, this.ctx.currentTime, 0.1);
  }

  _startMusic() {
    if (this._musicTimer || !this.ctx) return;
    const c = this.ctx;
    this.musicBus.gain.cancelScheduledValues(c.currentTime);
    this.musicBus.gain.setTargetAtTime(this._musicVol * 0.55, c.currentTime, 0.3);
    this._step = 0;
    this._nextT = c.currentTime + 0.1;
    // drone
    const dg = this._gain(0, this.musicBus);
    dg.gain.setTargetAtTime(0.05, c.currentTime, 1.5);
    const df = this._filter('lowpass', 700, 0.5);
    df.connect(dg);
    this._drone = [146.83, 220, 293.66].map((f, i) => {
      const o = c.createOscillator();
      o.type = i === 1 ? 'sawtooth' : 'triangle';
      o.frequency.value = f;
      o.detune.value = (i - 1) * 4;
      o.connect(df); o.start();
      return o;
    });
    this._droneGain = dg;
    this._musicTimer = setInterval(() => this._schedule(), 30);
  }

  _stopMusic() {
    if (!this._musicTimer || !this.ctx) return;
    clearInterval(this._musicTimer);
    this._musicTimer = 0;
    const t = this.ctx.currentTime;
    this._droneGain?.gain.setTargetAtTime(0, t, 0.2);
    const drone = this._drone;
    setTimeout(() => drone?.forEach((o) => { try { o.stop(); } catch { /* ignore */ } }), 1200);
    this._drone = null;
  }

  _schedule() {
    const c = this.ctx;
    if (!c || c.state !== 'running') return;
    const STEP = 0.155; // ~ 6/8 garba at 129 bpm (dotted-quarter feel)
    const bass = [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1];
    const tak = [0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0];
    const stick = [0, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1, 1];
    // Raag Bhupali (D pentatonic): D E F# A B D'
    const S = { D: 293.66, E: 329.63, F: 369.99, A: 440, B: 493.88, d: 587.33, e: 659.25, x: 0 };
    const mel = 'D.E.F.A..F.E.D.E.F.A.B.A.....A.B.d.e.d.B.A.F.A.F.E.D.....'.split('');
    while (this._nextT < c.currentTime + 0.14) {
      const t = this._nextT, i = this._step;
      const k = i % 12;
      if (bass[k]) { this._sweep('sine', 120, 55, t, 0.26, 0.5, this.musicBus, 0.003, 0.18); }
      if (tak[k]) {
        const nz = this._noise(t, 0.08);
        nz.connect(this._filter('bandpass', 900, 2.5)).connect(this._env(t, 0.32, 0.001, 0.07, this.musicBus));
        this._tone('triangle', 330, t, 0.08, 0.12, this.musicBus, 0.001);
      }
      if (stick[k]) this._tone('square', 1900 + (k % 2) * 300, t, 0.025, 0.035, this.musicBus, 0.0005);
      const note = mel[i % mel.length];
      if (note !== '.' && S[note]) {
        let len = 1;
        while (mel[(i + len) % mel.length] === '.' && len < 6) len++;
        this._lead(S[note], t, len * STEP * 0.95);
      }
      this._step++;
      this._nextT += STEP;
    }
  }

  _lead(f, t, dur) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f * 0.985, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.05); // little meend into the note
    const vib = c.createOscillator(); vib.frequency.value = 5.5;
    const vg = c.createGain(); vg.gain.setValueAtTime(0, t); vg.gain.linearRampToValueAtTime(f * 0.012, t + dur);
    vib.connect(vg).connect(o.frequency);
    const bp = this._filter('bandpass', 1400, 1.4);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.07, t + 0.03);
    g.gain.setValueAtTime(0.06, t + Math.max(0.04, dur - 0.06));
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    o.connect(bp).connect(g).connect(this.musicBus);
    g.connect(this.verbSend);
    o.start(t); vib.start(t); o.stop(t + dur + 0.02); vib.stop(t + dur + 0.02);
  }

  // ------------------------------------------------------------------ helpers
  _gain(v, dest) { const g = this.ctx.createGain(); g.gain.value = v; if (dest) g.connect(dest); return g; }

  _filter(type, f, q) { const b = this.ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }

  _noise(t, dur) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.start(t, Math.random() * 1.2);
    s.stop(t + dur + 0.05);
    return s;
  }

  /** Gain node with an attack + exponential decay envelope, connected to dest. */
  _env(t, peak, attack, decay, dest) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    if (dest) g.connect(dest);
    return g;
  }

  _tone(type, f, t, dur, peak, dest, attack = 0.005, flat = false) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    let g;
    if (flat) {
      g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + attack);
      g.gain.setValueAtTime(peak, t + Math.max(attack, dur - 0.04));
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
      g.connect(dest);
    } else g = this._env(t, peak, attack, dur, dest);
    o.connect(g);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }

  _sweep(type, f0, f1, t, dur, peak, dest, attack = 0.003, sweepTime) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + (sweepTime || dur));
    o.connect(this._env(t, peak, attack, dur, dest));
    o.start(t);
    o.stop(t + attack + dur + 0.05);
    return o;
  }
}
