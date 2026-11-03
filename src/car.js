// Arcade car physics on the XZ plane. Heading h: forward = (sin h, cos h), right = (cos h, -sin h).

const WHEELBASE = 2.36;
export const BASE_TOP = 44; // m/s (~158 km/h) before stat multipliers
const BASE_ACCEL = 14.5;
const BRAKE = 22;
const NITRO_BURN = 0.32; // tank per second
const OFFROAD = 4.8; // the footpath is drivable; the hard wall sits at its outer edge

export class CarPhysics {
  constructor(stats, nitroMul = 1) {
    this.stats = stats; // { speed, accel, handling, nitro }
    this.nitroMul = nitroMul * (stats.nitro || 1);
    this.x = 0; this.z = 0; this.h = 0;
    this.vx = 0; this.vz = 0;
    this.yaw = 0;
    this.kick = 0; // extra body rotation (rad/s) from a knock: a clipped corner twists the car, then grip catches it
    this.steer = 0; // smoothed wheel angle input -1..1
    this.nitroTank = 0.35;
    this.nitroOn = false;
    this.drifting = false;
    this.driftAmount = 0;
    this.driftBlend = 0; // 0 = full grip, 1 = full drift
    this.slipAngle = 0;
    this.driftiness = 1;
    this.offroad = false;
    this.wallHit = 0; // impact speed of a wall hit this step
    this.spin = 0; // seconds of spin-out remaining (after a DHADAAAKK)
    this.index = 0; this.lateral = 0;
    this.throttle = 0; this.brake = 0;
  }

  get speed() { return Math.hypot(this.vx, this.vz); }
  get forwardSpeed() { return this.vx * Math.sin(this.h) + this.vz * Math.cos(this.h); }

  place(x, z, h) {
    this.x = x; this.z = z; this.h = h;
    this.vx = this.vz = this.yaw = this.kick = 0; this.spin = 0; this.driftBlend = 0;
  }

  // ctl: { steer, throttle, brake, nitro, drift }
  step(dt, ctl, track) {
    const s = this.stats;
    const fx = Math.sin(this.h), fz = Math.cos(this.h);
    const rx = Math.cos(this.h), rz = -Math.sin(this.h);
    let vF = this.vx * fx + this.vz * fz;
    let vR = this.vx * rx + this.vz * rz;
    const spinning = this.spin > 0;
    if (spinning) this.spin -= dt;

    // Nitro
    const wantNitro = ctl.nitro && this.nitroTank > 0.02 && !spinning;
    if (wantNitro) this.nitroTank = Math.max(0, this.nitroTank - NITRO_BURN / this.nitroMul * dt);
    this.nitroOn = wantNitro;

    const top = BASE_TOP * s.speed * (this.nitroOn ? 1.28 : 1); // no off-road/mud penalty: the verge never slows you
    const accel = BASE_ACCEL * s.accel * (this.nitroOn ? 1.9 : 1);
    this.throttle = spinning ? 0 : ctl.throttle;
    this.brake = spinning ? 0 : ctl.brake;

    // Longitudinal
    if (this.throttle > 0) {
      const room = Math.max(0, 1 - Math.max(0, vF) / top);
      vF += accel * this.throttle * (0.4 + 0.6 * room) * dt;
    }
    if (this.brake > 0) {
      if (vF > 0.5) vF -= BRAKE * this.brake * dt;
      else vF -= BASE_ACCEL * 0.6 * this.brake * dt; // reverse
      vF = Math.max(vF, -9);
    }
    if (this.nitroOn) vF += accel * 0.35 * dt;
    // Drag and rolling resistance
    vF -= vF * 0.12 * dt;
    if (this.throttle === 0 && this.brake === 0) vF -= Math.sign(vF) * Math.min(Math.abs(vF), 1.6 * dt);
    if (vF > top) vF += (top - vF) * Math.min(1, 2.5 * dt);

    // Steering: less lock at speed
    // ctl.sens = player's steering sensitivity (0.5..1.6, default 1): scales both how far and how quickly the wheels turn
    const sens = ctl.sens ?? 1;
    const target = spinning ? 0 : ctl.steer;
    this.steer += (target - this.steer) * Math.min(1, 32 * sens * dt);
    const speedAbs = Math.abs(vF);
    const lock = 0.55 / (1 + speedAbs / 26) * (0.85 + 0.15 * s.handling) * (0.55 + 0.45 * sens);
    const wheel = this.steer * lock;

    // ---- Drift (arcade): hold DRIFT while turning at speed and the tail slides out ----
    // driftBlend eases 0..1 so entering and leaving a drift is smooth instead of an instant grip snap.
    // driftiness is the car's slide character (Omni E slides more, Lord Alto grips more).
    const dfac = this.driftiness ?? 1;
    const wantDrift = !!ctl.drift && speedAbs > 10 && !spinning;
    this.driftBlend += ((wantDrift ? 1 : 0) - this.driftBlend) * Math.min(1, (wantDrift ? 7 : 3.5) * dt);
    this.drifting = this.driftBlend > 0.35 && speedAbs > 8;
    const slip = Math.atan2(vR, Math.max(1, Math.abs(vF)));
    this.slipAngle = slip;
    let grip;
    if (spinning) grip = 0.8;
    else {
      const baseGrip = 9 * s.handling, driftGrip = 2.1 / dfac;
      grip = baseGrip + (driftGrip - baseGrip) * this.driftBlend;
      // Angle limiter: past ~38 degrees the tyres bite back, so a drift never turns into a spin
      const MAX_SLIP = 0.6;
      if (Math.abs(slip) > MAX_SLIP) grip += (Math.abs(slip) - MAX_SLIP) * 30;
      // Counter-steer (steering toward the slide) catches it faster
      if (this.driftBlend > 0.1 && Math.sign(this.steer) === Math.sign(vR) && Math.abs(vR) > 0.5) grip += Math.abs(this.steer) * 6 * this.driftBlend;
    }
    // gripMul: weather (rain = a bit slidier, easier to drift); set by the race
    grip *= this.gripMul ?? 1;
    const vRBefore = vR;
    vR *= Math.exp(-grip * dt);
    // A good drift carries its speed: refill forward speed so a slide only scrubs ~12%/s, never gains speed
    if (this.driftBlend > 0.3 && vF > 0) {
      const before = Math.hypot(vF, vRBefore), want = before * (1 - 0.12 * dt) * this.driftBlend + Math.hypot(vF, vR) * (1 - this.driftBlend);
      const now = Math.hypot(vF, vR);
      if (now < want) vF = Math.min(top, Math.sqrt(Math.max(0, want * want - vR * vR)));
    }

    let yawTarget = vF * Math.tan(wheel) / WHEELBASE;
    yawTarget *= 1 + 0.6 * this.driftBlend * dfac;
    if (spinning) this.yaw += (Math.sign(this.yaw || 1) * 7 - this.yaw) * Math.min(1, 3 * dt);
    else this.yaw += (yawTarget - this.yaw) * Math.min(1, (28 - 18 * this.driftBlend) * dt);
    const hOld = this.h;
    this.h += this.yaw * dt;

    this.driftAmount = Math.abs(vR);
    if (this.drifting && this.driftAmount > 2) this.nitroTank = Math.min(1, this.nitroTank + this.driftAmount * 0.012 * dt * this.nitroMul);

    // Recompose velocity. With grip the velocity turns with the nose (crisp arcade handling); while drifting it
    // only partly follows, so the nose rotates past the direction of travel and the tail genuinely slides out.
    const follow = 1 - 0.8 * this.driftBlend;
    const hf = hOld + (this.h - hOld) * follow;
    const nfx = Math.sin(hf), nfz = Math.cos(hf);
    const nrx = Math.cos(hf), nrz = -Math.sin(hf);
    this.vx = nfx * vF + nrx * vR;
    this.vz = nfz * vF + nrz * vR;
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    // Knock rotation turns the body but not the velocity, so the car ends up a little sideways and the tyres
    // pull it straight again (a natural fishtail instead of an instant snap)
    if (this.kick) {
      this.h += this.kick * dt;
      this.kick *= Math.exp(-6 * dt);
      if (Math.abs(this.kick) < 0.01) this.kick = 0;
    }

    // Track edges
    this.wallHit = 0;
    const n = track.nearest(this.x, this.z, this.index);
    this.index = n.index; this.lateral = n.lateral;
    const edge = track.halfWidth;
    this.offroad = Math.abs(n.lateral) > edge - 0.6;
    const wall = edge + OFFROAD;
    if (Math.abs(n.lateral) > wall) {
      // Push back inside and kill the velocity going into the wall
      const tx = track.tx[n.index], tz = track.tz[n.index];
      const sideX = tz, sideZ = -tx; // right of travel
      const sign = Math.sign(n.lateral);
      const over = Math.abs(n.lateral) - wall;
      this.x -= sideX * sign * over; this.z -= sideZ * sign * over;
      const into = (this.vx * sideX + this.vz * sideZ) * sign;
      if (into > 0) {
        this.vx -= sideX * sign * into * 1.25; this.vz -= sideZ * sign * into * 1.25;
        // Arcade wall: a hard hit costs a chunk of speed once; grinding along the wall only scrapes a little
        const keep = into > 6 ? 1 - Math.min(0.3, into * 0.018) : Math.exp(-0.9 * dt);
        this.vx *= keep; this.vz *= keep;
        this.wallHit = into;
      }
    }
  }
}

export function speedToKmh(v) { return Math.round(Math.abs(v) * 3.6); }

export function gearFor(v, top) {
  const r = Math.abs(v) / top;
  if (v < -0.5) return 'R';
  return String(Math.min(5, 1 + Math.floor(r * 5.2)));
}
