// Arcade car physics on the XZ plane. Heading h: forward = (sin h, cos h), right = (cos h, -sin h).

const WHEELBASE = 2.36;
export const BASE_TOP = 44; // m/s (~158 km/h) before stat multipliers
const BASE_ACCEL = 14.5;
const BRAKE = 22;
const NITRO_BURN = 0.32; // tank per second
const OFFROAD = 2.2; // extra metres before the hard wall

export class CarPhysics {
  constructor(stats, nitroMul = 1) {
    this.stats = stats; // { speed, accel, handling, nitro }
    this.nitroMul = nitroMul * (stats.nitro || 1);
    this.x = 0; this.z = 0; this.h = 0;
    this.vx = 0; this.vz = 0;
    this.yaw = 0;
    this.steer = 0; // smoothed wheel angle input -1..1
    this.nitroTank = 0.35;
    this.nitroOn = false;
    this.drifting = false;
    this.driftAmount = 0;
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
    this.vx = this.vz = this.yaw = 0; this.spin = 0;
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

    const top = BASE_TOP * s.speed * (this.nitroOn ? 1.28 : 1) * (this.offroad ? 0.55 : 1);
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
    vF -= vF * (0.12 + (this.offroad ? 1.1 : 0)) * dt;
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

    // Drift: handbrake-style. Grip drops so the tail slides; nitro refills from drift.
    this.drifting = !!ctl.drift && speedAbs > 11 && !spinning;
    const grip = spinning ? 0.8 : this.drifting ? 2.2 : 9 * s.handling * (this.offroad ? 0.6 : 1);
    vR *= Math.exp(-grip * dt);

    let yawTarget = vF * Math.tan(wheel) / WHEELBASE;
    if (this.drifting) yawTarget *= 1.55;
    if (spinning) this.yaw += (Math.sign(this.yaw || 1) * 7 - this.yaw) * Math.min(1, 3 * dt);
    else this.yaw += (yawTarget - this.yaw) * Math.min(1, (this.drifting ? 9 : 28) * dt);
    this.h += this.yaw * dt;

    this.driftAmount = Math.abs(vR);
    if (this.drifting && this.driftAmount > 2) this.nitroTank = Math.min(1, this.nitroTank + this.driftAmount * 0.012 * dt * this.nitroMul);

    // Recompose velocity in the new heading frame
    const nfx = Math.sin(this.h), nfz = Math.cos(this.h);
    const nrx = Math.cos(this.h), nrz = -Math.sin(this.h);
    this.vx = nfx * vF + nrx * vR;
    this.vz = nfz * vF + nrz * vR;
    this.x += this.vx * dt;
    this.z += this.vz * dt;

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
        this.vx *= 0.93; this.vz *= 0.93;
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
