// CPU drivers: follow a lane along the centreline, brake for curvature, drift and use nitro on straights.

export class AIDriver {
  constructor(skill, seed) {
    this.skill = skill; // ~0.85 easy .. 1.05 hard
    this.lane = ((seed % 3) - 1) * 2.6; // preferred lateral offset
    this.rand = mulberry(seed * 9973 + 17);
    this.mistake = 0;
    this.nitroCooldown = 2 + this.rand() * 4;
  }

  // Returns controls for `phys` on `track`. `others` = other CarPhysics to steer around.
  drive(dt, phys, track, others, rubber = 1) {
    const N = track.N;
    const v = Math.max(0, phys.forwardSpeed);
    const look = Math.min(40, 7 + v * 0.55);
    const ti = (phys.index + Math.round(look)) % N;

    // Avoid the car directly ahead by shifting lane
    let lane = this.lane;
    for (const o of others) {
      const dx = o.x - phys.x, dz = o.z - phys.z;
      const ahead = dx * Math.sin(phys.h) + dz * Math.cos(phys.h);
      const side = dx * Math.cos(phys.h) - dz * Math.sin(phys.h);
      if (ahead > 0 && ahead < 14 && Math.abs(side) < 2.4) lane = o.lateral > 0 ? -3 : 3;
    }
    lane = Math.max(-track.halfWidth + 2, Math.min(track.halfWidth - 2, lane));
    const tx = track.tx[ti], tz = track.tz[ti];
    const px = track.x[ti] + tz * lane, pz = track.z[ti] - tx * lane;
    const want = Math.atan2(px - phys.x, pz - phys.z);
    let diff = want - phys.h;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    const steer = clamp(diff * 2.4, -1, 1);

    // Target speed from the sharpest curvature ahead
    let maxCurv = 0;
    const span = Math.min(90, 20 + v * 1.6);
    for (let k = 4; k < span; k += 3) maxCurv = Math.max(maxCurv, Math.abs(track.curv[(phys.index + k) % N]));
    const latMax = 10.5 * this.skill * rubber;
    const vMax = maxCurv > 1e-4 ? Math.sqrt(latMax / maxCurv) : 99;
    const topSpeed = 40 * phys.stats.speed * this.skill * rubber;
    const target = Math.min(vMax, topSpeed);

    // Occasional small mistakes on easier difficulties
    this.mistake -= dt;
    if (this.mistake < -6 && this.rand() < (1.05 - this.skill) * dt * 2) this.mistake = 0.6;
    const slip = this.mistake > 0 ? 0.55 : 1;

    let throttle = v < target * slip ? 1 : 0.15;
    let brake = v > target + 3 ? Math.min(1, (v - target) / 8) : 0;
    if (Math.abs(diff) > 1.2) { throttle = 0.6; brake = 0; } // recovering

    const straight = maxCurv < 0.006;
    this.nitroCooldown -= dt;
    let nitro = false;
    if (straight && phys.nitroTank > 0.25 && this.nitroCooldown < 0 && this.skill > 0.88) {
      nitro = true;
      if (phys.nitroTank < 0.3) this.nitroCooldown = 3 + this.rand() * 5;
    }
    const drift = maxCurv > 0.03 && v > 18 && this.skill > 0.9;
    return { steer, throttle, brake, nitro, drift };
  }
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
