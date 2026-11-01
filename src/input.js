// Unified input: keyboard, Gamepad API, on-screen touch buttons and optional tilt steering.
// read() is called once per frame and returns a fresh snapshot.

const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  ShiftLeft: 'drift', ShiftRight: 'drift',
  Space: 'nitro', KeyN: 'nitro',
  KeyH: 'horn',
  Escape: 'pause', KeyP: 'pause',
  KeyR: 'respawn',
};
const EDGE = new Set(['pause', 'respawn']);
const STEER_RAMP = 1 / 0.045; // full lock in ~45 ms (snappy but not a digital jerk)
const STEER_RETURN = 1 / 0.03; // centre even faster
const PAD_DEAD = 0.15;
const TILT_RANGE = 24; // degrees for full lock

const isTyping = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function approach(cur, target, dt) {
  const returning = target === 0 || Math.sign(target) !== Math.sign(cur);
  const rate = (returning && cur !== 0 ? STEER_RETURN : STEER_RAMP) * dt;
  if (Math.abs(target - cur) <= rate) return target;
  return cur + Math.sign(target - cur) * rate;
}

// Double-chevron glyphs, drawn pointing right and rotated per button. A dark offset copy gives a crisp drop
// shadow; the top copy is stroked with the shared saffron->pink gradient defined once in #touch.
const CHEV = 'M5.2 5.6L11.6 12l-6.4 6.4M12.4 5.6L18.8 12l-6.4 6.4';
const chevron = (rot) => `<svg class="tbtn-ico" viewBox="0 0 24 24" aria-hidden="true"><g transform="rotate(${rot} 12 12)">`
  + `<path d="${CHEV}" class="chev-shadow" transform="translate(0 1.1)"/><path d="${CHEV}" class="chev"/></g></svg>`;
const SVG_DEFS = '<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>'
  + '<linearGradient id="la-chev" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb347"/><stop offset=".5" stop-color="#ff7a4d"/><stop offset="1" stop-color="#ff4f9a"/></linearGradient>'
  + '<linearGradient id="la-nos" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7df3ff"/><stop offset="1" stop-color="#29b6ff"/></linearGradient>'
  + '</defs></svg>';
const NOS_RING = '<svg class="nos-ring" viewBox="0 0 100 100" aria-hidden="true">'
  + '<circle class="nos-track" cx="50" cy="50" r="45"/><circle class="nos-fill" cx="50" cy="50" r="45" pathLength="100"/></svg>';
const TOUCH_KEYS = ['left', 'right', 'gas', 'brake', 'nitro', 'drift'];

export class Input {
  constructor() {
    this.keys = Object.create(null);
    this._edges = Object.create(null);
    this.touch = Object.create(null);
    this._touchSteer = 0;
    this._kSteer = 0;
    this._last = performance.now();
    this._pads = [];
    this._padPrev = Object.create(null);
    this.tilt = false;
    this._tiltSteer = 0;
    this._tiltSeen = false;
    this.touchVisible = false;
    this.isTouchDevice = (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) || 'ontouchstart' in window;

    this._onKeyDown = (e) => {
      if (isTyping(e.target)) return;
      const k = KEYMAP[e.code] || (e.key === 'Escape' ? 'pause' : null);
      if (!k) return;
      if (k === 'pause' && document.querySelector('dialog[open]')) return; // Esc closes the settings modal instead
      if (!e.repeat && EDGE.has(k)) this._edges[k] = true;
      if (!e.repeat && k === 'horn') this._edges.horn = true;
      this.keys[k] = true;
      // Only swallow game keys during the race, so menus keep native Space/arrow behaviour.
      if (document.body.dataset.screen === 'race' && k !== 'pause') e.preventDefault();
    };
    this._onKeyUp = (e) => {
      const k = KEYMAP[e.code] || (e.key === 'Escape' ? 'pause' : null);
      if (k) this.keys[k] = false;
    };
    this._clear = () => {
      for (const k in this.keys) this.keys[k] = false;
      for (const k in this.touch) this.touch[k] = false;
      this._pointers?.clear();
      this._syncTouchClasses?.();
    };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._clear);
    document.addEventListener('visibilitychange', () => { if (document.hidden) this._clear(); });
    window.addEventListener('touchstart', () => { this.isTouchDevice = true; }, { once: true, passive: true });
    // Block pinch-zoom / double-tap zoom gestures on iOS Safari
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('dblclick', (e) => { if (e.target.closest?.('#touch, #game')) e.preventDefault(); });

    // Settings from ui.js (decoupled through window events)
    window.addEventListener('lordalto:touchmode', (e) => this.setTilt(e.detail?.mode === 'tilt'));
    window.addEventListener('lordalto:tiltpermission', (e) => { if (e.detail?.granted && this.tilt) this._listenTilt(); });
  }

  /** Show/hide on-screen controls (they only render on the race screen). */
  setTouch(visible) {
    this.touchVisible = !!visible;
    if (visible) this._buildTouch();
    if (this._touchEl) this._touchEl.classList.toggle('on', this.touchVisible);
    document.body.classList.toggle('touch-on', this.touchVisible);
    if (!visible) { for (const k in this.touch) this.touch[k] = false; this._pointers?.clear(); this._syncTouchClasses?.(); }
  }

  /** Tilt steering on/off. On iOS call from a user gesture so the permission prompt can appear. */
  setTilt(on) {
    this.tilt = !!on;
    if (this._touchEl) this._touchEl.classList.toggle('tilt', this.tilt);
    if (this.tilt) {
      const DOE = window.DeviceOrientationEvent;
      if (DOE && typeof DOE.requestPermission === 'function' && !this._tiltGranted) {
        // Needs a gesture; also retried on the first touch of the controls.
        DOE.requestPermission().then((r) => { if (r === 'granted') { this._tiltGranted = true; this._listenTilt(); } }).catch(() => {});
      } else this._listenTilt();
    } else this._tiltSteer = 0;
  }

  _listenTilt() {
    if (this._tiltListening) return;
    this._tiltListening = true;
    this._tiltGranted = true;
    window.addEventListener('deviceorientation', (e) => {
      if (e.beta == null && e.gamma == null) return;
      this._tiltSeen = true;
      const angle = (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : (window.orientation || 0);
      let deg;
      if (angle === 90) deg = e.beta;
      else if (angle === -90 || angle === 270) deg = -e.beta;
      else if (angle === 180) deg = -e.gamma;
      else deg = e.gamma;
      this._tiltSteer = clamp((deg || 0) / TILT_RANGE, -1, 1);
    });
  }

  /**
   * Drive the N2O button's tank ring. Call every frame; it only touches the DOM when something visibly changes.
   * @param {number} level01 nitro tank 0..1
   * @param {boolean} active nitro currently burning
   */
  setNitro(level01, active) {
    const n = this._nos;
    if (!n) return;
    const lv = Math.round(clamp(+level01 || 0, 0, 1) * 200) / 200; // 0.5% steps
    if (lv !== n.level) {
      n.level = lv;
      n.fill.style.strokeDashoffset = (100 - lv * 100).toFixed(1);
      const full = lv >= 0.995;
      if (full !== n.full) { n.full = full; n.btn.classList.toggle('full', full); }
      const empty = lv <= 0.01;
      if (empty !== n.empty) { n.empty = empty; n.btn.classList.toggle('empty', empty); }
    }
    const on = !!active;
    if (on !== n.active) { n.active = on; n.btn.classList.toggle('active', on); }
  }

  _buildTouch() {
    if (this._touchEl) return;
    const root = document.createElement('div');
    root.id = 'touch';
    root.className = 'touch' + (this.tilt ? ' tilt' : '');
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = SVG_DEFS; // static markup only
    const mk = (cls, key, html) => {
      const b = document.createElement('div'); // not a <button>: no focus, no click synthesis, no text selection
      b.className = 'tbtn ' + cls;
      b.dataset.k = key;
      b.innerHTML = '<span class="tbtn-face">' + html + '</span>'; // static markup only; the face scales, the hit box never moves
      return b;
    };
    const steer = document.createElement('div');
    steer.className = 'touch-pad touch-steer';
    const tiltHint = document.createElement('div');
    tiltHint.className = 'tilt-hint';
    tiltHint.textContent = 'TILT TO STEER';
    steer.append(mk('tbtn-big tbtn-left', 'left', chevron(180)), mk('tbtn-big tbtn-right', 'right', chevron(0)), tiltHint);

    const act = document.createElement('div');
    act.className = 'touch-pad touch-act';
    const drift = mk('tbtn-disc tbtn-drift', 'drift', '<span class="disc-label">DRIFT</span>');
    const nitro = mk('tbtn-disc tbtn-nitro empty', 'nitro', NOS_RING + '<span class="disc-label">N<sub>2</sub>O</span>');
    act.append(drift, nitro, mk('tbtn-big tbtn-brake', 'brake', chevron(90)), mk('tbtn-big tbtn-gas', 'gas', chevron(-90)));
    root.append(steer, act);
    (document.getElementById('app') || document.body).appendChild(root);
    this._touchEl = root;
    this._btns = [...root.querySelectorAll('.tbtn')];
    this._nos = { btn: nitro, fill: nitro.querySelector('.nos-fill'), level: -1, full: false, empty: true, active: false };
    this.setNitro(0, false);

    // Multi-touch: each pointer maps to whichever button it is over (fingers can slide between buttons).
    // Rects are measured on each pointerdown (6 reads, no writes) and reused for moves; only the inner face scales.
    this._pointers = new Map();
    let rects = [];
    const measure = () => {
      rects = [];
      for (const b of this._btns) {
        const r = b.getBoundingClientRect();
        if (r.width > 0) rects.push({ k: b.dataset.k, cx: r.left + r.width / 2, cy: r.top + r.height / 2, rad: r.width / 2 });
      }
    };
    const hit = (x, y) => {
      // round buttons: nearest centre within radius + slop (steer buttons get extra slop so sliding L<->R never drops)
      let best = null, bestD = Infinity;
      for (const r of rects) {
        const d = Math.hypot(x - r.cx, y - r.cy);
        const slop = r.k === 'left' || r.k === 'right' ? 22 : 12;
        if (d <= r.rad + slop && d - r.rad < bestD) { bestD = d - r.rad; best = r.k; }
      }
      return best;
    };
    const update = () => {
      const prev = { ...this.touch };
      for (const k of TOUCH_KEYS) this.touch[k] = false;
      for (const k of this._pointers.values()) if (k) this.touch[k] = true;
      for (const k of TOUCH_KEYS) if (this.touch[k] && !prev[k] && navigator.vibrate) { try { navigator.vibrate(8); } catch { /* ignore */ } break; }
      this._syncTouchClasses();
    };
    this._syncTouchClasses = () => { for (const b of this._btns) b.classList.toggle('down', !!this.touch[b.dataset.k]); };
    const down = (e) => {
      if (this.tilt && !this._tiltGranted) this.setTilt(true); // iOS: permission prompt needs a gesture
      measure();
      const k = hit(e.clientX, e.clientY);
      if (!k) return;
      e.preventDefault();
      try { root.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      this._pointers.set(e.pointerId, k);
      update();
    };
    const move = (e) => {
      if (!this._pointers.has(e.pointerId)) return;
      e.preventDefault();
      const k = hit(e.clientX, e.clientY);
      if (k !== this._pointers.get(e.pointerId)) { this._pointers.set(e.pointerId, k); update(); }
    };
    const up = (e) => {
      if (!this._pointers.has(e.pointerId)) return;
      this._pointers.delete(e.pointerId);
      update();
    };
    root.addEventListener('pointerdown', down);
    root.addEventListener('pointermove', move);
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', up);
    root.addEventListener('lostpointercapture', up);
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    root.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    root.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  }

  _pollPad() {
    const out = { steer: 0, throttle: 0, brake: 0, nitro: false, drift: false, horn: false, pause: false, respawn: false };
    if (!navigator.getGamepads) return out;
    let pads;
    try { pads = navigator.getGamepads(); } catch { return out; }
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const b = (i) => p.buttons[i] || { pressed: false, value: 0 };
      const ax = p.axes[0] || 0;
      let steer = Math.abs(ax) > PAD_DEAD ? Math.sign(ax) * (Math.abs(ax) - PAD_DEAD) / (1 - PAD_DEAD) : 0;
      if (b(14).pressed) steer = -1;
      if (b(15).pressed) steer = 1;
      if (Math.abs(steer) > Math.abs(out.steer)) out.steer = steer;
      out.throttle = Math.max(out.throttle, b(7).value || (b(7).pressed ? 1 : 0), b(12).pressed ? 1 : 0);
      out.brake = Math.max(out.brake, b(6).value || (b(6).pressed ? 1 : 0), b(13).pressed ? 1 : 0);
      out.nitro = out.nitro || b(0).pressed || b(5).pressed;
      out.drift = out.drift || b(1).pressed || b(2).pressed || b(4).pressed;
      const id = p.index;
      const prev = this._padPrev[id] || {};
      const start = b(9).pressed, back = b(8).pressed, y = b(3).pressed;
      if (start && !prev.start) out.pause = true;
      if (back && !prev.back) out.respawn = true;
      out.horn = out.horn || y;
      this._padPrev[id] = { start, back };
    }
    return out;
  }

  read() {
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - this._last) / 1000));
    this._last = now;
    const K = this.keys, T = this.touch;

    const kTarget = (K.right ? 1 : 0) - (K.left ? 1 : 0);
    this._kSteer = approach(this._kSteer, kTarget, dt);
    const tTarget = (T.right ? 1 : 0) - (T.left ? 1 : 0);
    this._touchSteer = approach(this._touchSteer, tTarget, dt);

    const pad = this._pollPad();
    let steer = this._kSteer;
    for (const s of [this._touchSteer, pad.steer, this.tilt && this.touchVisible ? this._tiltSteer : 0]) {
      if (Math.abs(s) > Math.abs(steer)) steer = s;
    }

    const res = {
      steer: clamp(steer, -1, 1),
      throttle: Math.max(K.up ? 1 : 0, T.gas ? 1 : 0, pad.throttle),
      brake: Math.max(K.down ? 1 : 0, T.brake ? 1 : 0, pad.brake),
      nitro: !!(K.nitro || T.nitro || pad.nitro),
      drift: !!(K.drift || T.drift || pad.drift),
      horn: !!(K.horn || T.horn || pad.horn), // held state; main.js edge-detects
      hornPressed: !!this._edges.horn,
      pausePressed: !!(this._edges.pause || pad.pause),
      respawnPressed: !!(this._edges.respawn || pad.respawn),
    };
    this._edges.pause = this._edges.respawn = this._edges.horn = false;
    return res;
  }
}
