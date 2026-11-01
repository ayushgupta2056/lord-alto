// Procedural Web Audio for Lord Alto. No audio files: every sound is synthesised.
// Safe to call any method before unlock(): they simply do nothing until the AudioContext exists.

const MUTE_KEY = 'lordalto.muted';
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v || 0);
// Gear bands as fractions of top speed (5-speed Alto)
const GEARS = [0, 0.15, 0.32, 0.52, 0.74, 1.01];
const MUSIC_SCREENS = new Set(['menu', 'tracks', 'garage', 'mp', 'lobby', 'results']);
const ENGINE_SCREENS = new Set(['race', 'pause']);

function readMuted() { try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; } }

export class GameAudio {
  constructor() {
    this.ctx = null;
    this._muted = readMuted();
    this.volume = 0.9;
    this._musicVol = 0.5;
    this._musicWanted = false;
    this._screen = null;
    this._gear = 1;
    this._dipUntil = 0;
    if (typeof window !== 'undefined') {
      window.addEventListener('lordalto:music', (e) => this.setMusicVolume(e.detail?.volume));
      window.addEventListener('ui:screen', (e) => {
        this._screen = e.detail?.screen || null;
        this.music(MUSIC_SCREENS.has(this._screen));
      });
      document.addEventListener('visibilitychange', () => {
        if (!this.ctx) return;
        if (document.hidden) this.ctx.suspend().catch(() => {});
        else this.ctx.resume().catch(() => {});
      });
    }
  }

  // ------------------------------------------------------------------ setup
  unlock() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC({ latencyHint: 'interactive' });
        this._build();
        // iOS needs a sound started inside the gesture
        const b = this.ctx.createBuffer(1, 1, 22050);
        const s = this.ctx.createBufferSource();
        s.buffer = b; s.connect(this.ctx.destination); s.start(0);
      }
      if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
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
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -12; comp.knee.value = 10; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.2;
    this.master.connect(comp).connect(c.destination);
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

    // ---- engine: detuned saw + square (+ harmonic) -> lowpass -> gain
    this.engFilter = c.createBiquadFilter();
    this.engFilter.type = 'lowpass'; this.engFilter.frequency.value = 400; this.engFilter.Q.value = 3.5;
    this.engGain = this._gain(0, this.engBus);
    this.engFilter.connect(this.engGain);
    const mk = (type, f, g) => { const o = c.createOscillator(); o.type = type; o.frequency.value = f; o.connect(this._gain(g, this.engFilter)); o.start(); return o; };
    this.eo1 = mk('sawtooth', 40, 0.5);
    this.eo2 = mk('square', 20, 0.28);
    this.eo3 = mk('sawtooth', 80, 0.16);
    // nitro / gearbox whine
    this.whineGain = this._gain(0, this.engBus);
    const wf = c.createBiquadFilter(); wf.type = 'bandpass'; wf.Q.value = 6; wf.frequency.value = 1500;
    wf.connect(this.whineGain);
    this.whine = c.createOscillator(); this.whine.type = 'sawtooth'; this.whine.frequency.value = 900; this.whine.connect(wf); this.whine.start();
    this.whineFilter = wf;

    // ---- skid: looping noise -> bandpass
    const skidSrc = c.createBufferSource();
    skidSrc.buffer = this.noiseBuf; skidSrc.loop = true;
    this.skidFilter = c.createBiquadFilter();
    this.skidFilter.type = 'bandpass'; this.skidFilter.frequency.value = 2200; this.skidFilter.Q.value = 2.2;
    this.skidGain = this._gain(0, this.sfx);
    skidSrc.connect(this.skidFilter).connect(this.skidGain);
    skidSrc.start();
  }

  // ------------------------------------------------------------------ mute
  setMuted(b) {
    this._muted = !!b;
    try { localStorage.setItem(MUTE_KEY, this._muted ? '1' : '0'); } catch { /* ignore */ }
    if (this.ctx) this.master.gain.setTargetAtTime(this._muted ? 0 : this.volume, this.ctx.currentTime, 0.03);
  }
  get muted() { return this._muted; }

  // ------------------------------------------------------------------ continuous
  engine(speed01, throttle, nitro) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const s = clamp01(Math.abs(speed01)), th = clamp01(throttle);
    const n = nitro ? (typeof nitro === 'number' ? clamp01(nitro) : 1) : 0;
    let g = 1;
    while (g < 5 && s > GEARS[g]) g++;
    const lo = GEARS[g - 1], hi = GEARS[g];
    const frac = Math.min(1, (s - lo) / (hi - lo));
    let rpm = g === 1 ? 0.17 + 0.83 * frac : 0.46 + 0.54 * frac;
    if (s < 0.04) rpm = Math.max(rpm, 0.17 + th * 0.55); // free revving at standstill
    if (g > this._gear) this._dipUntil = t + 0.09; // throttle lift on upshift
    this._gear = g;
    rpm *= 1 + n * 0.08;
    const f = 30 + rpm * 128;
    this.eo1.frequency.setTargetAtTime(f, t, 0.045);
    this.eo2.frequency.setTargetAtTime(f * 0.503, t, 0.045);
    this.eo3.frequency.setTargetAtTime(f * 2.012, t, 0.045);
    this.engFilter.frequency.setTargetAtTime(240 + rpm * 1500 + th * 900 + n * 900, t, 0.05);
    const active = this._screen == null || ENGINE_SCREENS.has(this._screen) ? 1 : 0;
    let gain = (0.06 + th * 0.09 + s * 0.045 + n * 0.03) * active;
    if (t < this._dipUntil) gain *= 0.35;
    this.engGain.gain.setTargetAtTime(gain, t, t < this._dipUntil ? 0.012 : 0.05);
    this.whine.frequency.setTargetAtTime(600 + s * 1900 + n * 700, t, 0.08);
    this.whineFilter.frequency.setTargetAtTime(900 + s * 2200 + n * 900, t, 0.08);
    this.whineGain.gain.setTargetAtTime((0.004 + s * 0.012 + n * 0.06) * active, t, 0.08);
    clearTimeout(this._engTO);
    this._engTO = setTimeout(() => this._silenceEngine(), 300);
  }

  _silenceEngine() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.engGain.gain.setTargetAtTime(0, t, 0.08);
    this.whineGain.gain.setTargetAtTime(0, t, 0.08);
    this.skidGain.gain.setTargetAtTime(0, t, 0.05);
  }

  skid(amount01) {
    if (!this.ctx) return;
    const a = clamp01(amount01), t = this.ctx.currentTime;
    const active = this._screen == null || ENGINE_SCREENS.has(this._screen) ? 1 : 0;
    this.skidGain.gain.setTargetAtTime(a * a * 0.3 * active, t, 0.04);
    this.skidFilter.frequency.setTargetAtTime(1700 + a * 1500, t, 0.05);
    clearTimeout(this._skidTO);
    this._skidTO = setTimeout(() => { if (this.ctx) this.skidGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05); }, 300);
  }

  // ------------------------------------------------------------------ one-shots
  crash(power01) {
    if (!this.ctx) return;
    const p = clamp01(power01 ?? 0.5), t = this.ctx.currentTime + 0.005;
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
    const t = this.ctx.currentTime + 0.005;
    const nz = this._noise(t, 0.8);
    const bp = this._filter('bandpass', 300, 1.3);
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(2800, t + 0.38);
    nz.connect(bp).connect(this._env(t, 0.5, 0.02, 0.7, this.sfx));
    const nz2 = this._noise(t, 0.5);
    nz2.connect(this._filter('highpass', 5000, 0.7)).connect(this._env(t, 0.16, 0.005, 0.45, this.sfx));
    this._sweep('sine', 90, 50, t, 0.3, 0.5, this.sfx);
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
