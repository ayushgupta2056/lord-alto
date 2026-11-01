// Screen-space speed lines: white streaks rushing out from the vanishing point toward the screen edges.
// Intensity follows speed (from ~70 km/h) and jumps with nitro. One 2D canvas, a few dozen strokes per frame.

const COUNT = 46;

export class SpeedLines {
  constructor(parent, before) {
    this.cv = document.createElement('canvas');
    this.cv.className = 'speed-lines';
    Object.assign(this.cv.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '1' });
    parent.insertBefore(this.cv, before ? before.nextSibling : parent.firstChild);
    this.g = this.cv.getContext('2d');
    this.lines = Array.from({ length: COUNT }, () => this._spawn({}, true));
    this.level = 0;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = innerWidth; this.h = innerHeight;
    this.cv.width = Math.round(this.w * dpr); this.cv.height = Math.round(this.h * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _spawn(l, anywhere) {
    l.a = Math.random() * Math.PI * 2;
    l.r = anywhere ? 0.25 + Math.random() * 0.75 : 0.22 + Math.random() * 0.12; // fraction of screen half-diagonal
    l.len = 0.08 + Math.random() * 0.16;
    l.speed = 0.9 + Math.random() * 1.2;
    l.w = 1 + Math.random() * 2.2;
    return l;
  }

  // speed in m/s, nitro on/off, dt in s, cx/cy = vanishing point as a fraction of the screen
  update(dt, speed, nitro, cx = 0.5, cy = 0.42) {
    const target = Math.max(0, Math.min(1, (speed - 19) / 22)) * 0.75 + (nitro ? 0.55 : 0);
    this.level += (Math.min(1.2, target) - this.level) * Math.min(1, dt * (target > this.level ? 6 : 3));
    const g = this.g;
    g.clearRect(0, 0, this.w, this.h);
    if (this.level < 0.02) return;
    const ox = this.w * cx, oy = this.h * cy;
    const R = Math.hypot(this.w, this.h) * 0.55;
    g.lineCap = 'round';
    const tint = nitro ? '170,240,255' : '255,255,255';
    for (const l of this.lines) {
      l.r += l.speed * dt * (0.8 + this.level * 1.6);
      if (l.r > 1.05) this._spawn(l, false);
      const r0 = l.r * R, r1 = (l.r + l.len * (0.6 + this.level)) * R;
      const c = Math.cos(l.a), s = Math.sin(l.a);
      // Fade near the centre so the road ahead stays clean
      const edge = Math.min(1, Math.max(0, (l.r - 0.3) / 0.35));
      const alpha = edge * this.level * 0.38;
      if (alpha < 0.01) continue;
      g.strokeStyle = `rgba(${tint},${alpha.toFixed(3)})`;
      g.lineWidth = l.w * (0.7 + this.level * 0.6);
      g.beginPath(); g.moveTo(ox + c * r0, oy + s * r0); g.lineTo(ox + c * r1, oy + s * r1); g.stroke();
    }
  }

  clear() { this.level = 0; this.g.clearRect(0, 0, this.w, this.h); }
}
