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
const STEER_RAMP = 1 / 0.12; // full lock in ~0.12 s
const STEER_RETURN = 1 / 0.06; // centre twice as fast
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

const SVG_LEFT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 4.5L6.5 12l9 7.5z" fill="currentColor"/></svg>';
const SVG_RIGHT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 4.5l9 7.5-9 7.5z" fill="currentColor"/></svg>';

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

  _buildTouch() {
    if (this._touchEl) return;
    const root = document.createElement('div');
    root.id = 'touch';
    root.className = 'touch' + (this.tilt ? ' tilt' : '');
    root.setAttribute('aria-hidden', 'true');
    const mk = (cls, key, html, label) => {
      const b = document.createElement('div'); // not a <button>: no focus, no click synthesis, no text selection
      b.className = 'tbtn ' + cls;
      b.dataset.k = key;
      if (html) b.innerHTML = html; // static markup only
      else b.textContent = label;
      return b;
    };
    const left = document.createElement('div');
    left.className = 'touch-pad touch-left';
    const tiltHint = document.createElement('div');
    tiltHint.className = 'tilt-hint';
    tiltHint.textContent = 'TILT TO STEER';
    left.append(mk('tbtn-steer', 'left', SVG_LEFT), mk('tbtn-steer', 'right', SVG_RIGHT), tiltHint);
    const right = document.createElement('div');
    right.className = 'touch-pad touch-right';
    const c1 = document.createElement('div'); c1.className = 'touch-col';
    c1.append(mk('tbtn-drift', 'drift', null, 'DRIFT'), mk('tbtn-brake', 'brake', null, 'BRAKE'));
    const c2 = document.createElement('div'); c2.className = 'touch-col';
    c2.append(mk('tbtn-nitro', 'nitro', null, 'NITRO'), mk('tbtn-gas', 'gas', null, 'GAS'));
    right.append(c1, c2);
    const horn = mk('tbtn-horn', 'horn', null, 'HORN');
    root.append(left, right, horn);
    (document.getElementById('app') || document.body).appendChild(root);
    this._touchEl = root;
    this._btns = [...root.querySelectorAll('.tbtn')];

    // Multi-touch: each pointer maps to whichever button it is over (fingers can slide between buttons)
    this._pointers = new Map();
    const hit = (x, y) => {
      for (const b of this._btns) {
        if (b.offsetParent === null) continue;
        const r = b.getBoundingClientRect();
        const pad = 10;
        if (x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad) return b.dataset.k;
      }
      return null;
    };
    const update = () => {
      const prev = { ...this.touch };
      for (const k of ['left', 'right', 'gas', 'brake', 'nitro', 'drift', 'horn']) this.touch[k] = false;
      for (const k of this._pointers.values()) if (k) this.touch[k] = true;
      if (this.touch.horn && !prev.horn) this._edges.horn = true;
      for (const k in this.touch) if (this.touch[k] && !prev[k] && navigator.vibrate) { try { navigator.vibrate(8); } catch { /* ignore */ } break; }
      this._syncTouchClasses();
    };
    this._syncTouchClasses = () => { for (const b of this._btns) b.classList.toggle('down', !!this.touch[b.dataset.k]); };
    const down = (e) => {
      if (this.tilt && !this._tiltGranted) this.setTilt(true); // iOS: permission prompt needs a gesture
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
