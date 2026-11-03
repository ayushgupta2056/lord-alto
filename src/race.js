import * as THREE from 'three';
import { CARS, ECONOMY } from './config.js';
import { CarPhysics } from './car.js';
import { AIDriver } from './ai.js';
import { buildCarModel, disposeCarModel } from './carModel.js';
import { SkidMarks } from './skids.js';
import { CheckpointGates } from './gates.js';

// Small deterministic hash (FNV-1a) so every client picks the same cars for checkpoint jokes
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
const JOKE_CARS = new Set(['lordAlto', 'omniE']);
const BUBBLE_LIFE = 2.6;

// Comic speech bubble state; main.js draws it as a crisp DOM bubble projected above the car's roof
// (DOM text stays sharp and is unaffected by bloom/post-processing).
function makeBubble(text) { return { text, t: 0, pos: { x: 0, y: 0, z: 0 }, pop: 0, opacity: 0, el: null }; }
function disposeBubble(scene, b) { if (b.el) b.el.remove(); b.el = null; }

const RIVAL_NAMES = ['Jignesh', 'Hetal', 'Bhavin', 'Kinjal', 'Parth', 'Dhruvi', 'Chirag', 'Nirali', 'Mihir', 'Foram'];
const CAR_RADIUS = 0.8; // two circles per car, 0.9 m ahead/behind the centre
const DHADAAK_MIN_CLOSING = 5; // m/s closing speed needed with nitro on
const tmpV = new THREE.Vector3();
const ECONOMY_OVERTAKE = 25; // points per place gained

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  const s = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] || '?').slice(0, 2);
  return s.toUpperCase();
}

// Small round badge above a car: the driver's selfie if they shared one, otherwise their initials,
// ringed in their car colour. Drawn on a canvas and shown as a sprite.
function drawTag(cv, name, color, img) {
  const S = cv.width, g = cv.getContext('2d');
  g.clearRect(0, 0, S, S);
  g.save();
  g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 8, 0, Math.PI * 2); g.closePath();
  g.fillStyle = 'rgba(20,16,56,0.78)'; g.fill();
  if (img) { g.clip(); g.drawImage(img, 8, 8, S - 16, S - 16); }
  g.restore();
  g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 8, 0, Math.PI * 2);
  g.lineWidth = 9; g.strokeStyle = color || '#ff9933'; g.stroke();
  if (!img) {
    g.fillStyle = '#ffffff';
    g.font = '800 54px "Bungee", "Baloo 2", system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(initials(name), S / 2, S / 2 + 3);
  }
}

function makeNameTag(name, color, avatar) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  drawTag(cv, name, color, null);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, fog: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(0.95, 0.95, 1);
  sp.renderOrder = 10;
  sp.userData = { name, color, canvas: cv };
  if (avatar) setTagAvatar(sp, avatar);
  return sp;
}

function setTagAvatar(tag, url) {
  const { canvas, name, color } = tag.userData;
  if (!url || !/^data:image\//.test(url)) { drawTag(canvas, name, color, null); tag.material.map.needsUpdate = true; return; }
  const img = new Image();
  img.onload = () => { drawTag(canvas, name, color, img); tag.material.map.needsUpdate = true; };
  img.src = url;
}

function disposeTag(scene, tag) {
  if (!tag) return;
  scene.remove(tag); tag.material.map.dispose(); tag.material.dispose();
}

// One race: local player + CPU rivals, or local player + remote players (multiplayer).
export class Race {
  constructor(opts) {
    this.o = opts; // { scene, track, fx, laps, difficulty, player:{carId,mods,stats,name,nitroMul}, rivals:n, net, grid:[pid], players:[{pid,name,car,mods}], startAt, onEvent }
    this.track = opts.track;
    this.laps = opts.laps;
    this.cars = [];
    this.time = 0; // race clock (s) since green light
    this.phase = 'countdown';
    this.countdown = 3.999;
    this.pairCooldown = new Map();
    this.remoteBuffer = new Map();
    this.sendTimer = 0;
    this.finishOrder = [];
    this.wrongWayTime = 0;

    const mp = !!opts.net;
    const slots = mp ? opts.grid : null;
    const meEntry = this._addCar({
      isPlayer: true, name: opts.player.name || 'You', carId: opts.player.carId, mods: opts.player.mods,
      stats: opts.player.stats, nitroMul: opts.player.nitroMul, pid: mp ? opts.net.me : 'me',
    });
    this.me = meEntry;
    if (mp) {
      for (const p of opts.players) if (p.pid !== opts.net.me) {
        const def = CARS.find(c => c.id === p.car) || CARS[0];
        this._addCar({ isRemote: true, pid: p.pid, name: p.name, carId: def.id, mods: p.mods, stats: { ...def.stats, nitro: 1 }, nitroMul: def.nitroMul });
      }
      // Grid order comes from the server
      for (const c of this.cars) {
        const slot = Math.max(0, slots.indexOf(c.pid));
        const g = this.track.grid(slot);
        c.phys.place(g.x, g.z, g.h);
      }
    } else {
      const n = opts.rivals ?? 7;
      const pool = CARS.filter(c => !c.starter);
      const starters = { 0: 'omniE', 1: 'lordAlto', 4: 'omniE' };
      for (let i = 0; i < n; i++) {
        const def = starters[i] ? CARS.find(c => c.id === starters[i]) : pool[(i * 3 + 1) % pool.length];
        const skill = opts.difficulty * (0.95 + (i / Math.max(1, n - 1)) * 0.09);
        const e = this._addCar({ isAI: true, name: RIVAL_NAMES[i % RIVAL_NAMES.length], carId: def.id,
          mods: { plate: `GJ 06 ${String.fromCharCode(65 + i)}${String.fromCharCode(75 + i)} ${1000 + i * 1111}` },
          stats: { ...def.stats, nitro: 1 }, nitroMul: def.nitroMul, pid: 'ai' + i });
        e.ai = new AIDriver(skill, i + 1);
      }
      // Player starts at the back so there is someone to chase
      const order = [...this.cars.filter(c => !c.isPlayer), this.me];
      order.forEach((c, i) => { const g = this.track.grid(i); c.phys.place(g.x, g.z, g.h); });
    }
    // Ordered checkpoints (School Se Ghar Tak). Intermediate ones sit at their landmark; the last is the finish line.
    this._setupCheckpoints();
    if (this.cps) this.gates = new CheckpointGates(this.o.scene, this.track, this.cps.all.map(cp => cp.finish ? cp : (this.cps.ints.find(x => x.id === cp.id) || cp)));
    this.skids = new SkidMarks(this.o.scene);
    for (const c of this.cars) {
      c.phys.gripMul = opts.weather === 'rain' ? 0.82 : 1;
      c.phys.driftiness = c.def.driftiness ?? 1;
      const n = this.track.nearest(c.phys.x, c.phys.z);
      c.phys.index = n.index; c.lastIndex = n.index; c.cpLast = n.index;
      this._syncModel(c, 0);
    }
  }

  _addCar(o) {
    const def = CARS.find(c => c.id === o.carId) || CARS[0];
    const model = buildCarModel(def.id, o.mods || {});
    if (this.o.shadows !== false) model.traverse(m => { if (m.isMesh) m.castShadow = true; });
    this.o.scene.add(model);
    const e = {
      ...o, def, model,
      phys: new CarPhysics(o.stats || def.stats, o.nitroMul ?? def.nitroMul),
      lap: 0, half: false, lapStart: 0, bestLap: Infinity, lapTimes: [],
      finished: false, finishTime: null, place: 0, progress: 0,
      wheelSpin: 0, driftMeters: 0, dhadaaks: 0, stuck: 0, overtakes: 0, lastPlace: 0,
      cpNext: 0, cpDone: false, cpLaps: 0, driftScore: 0, driftRun: 0, driftRunScore: 0, driftTime: 0,
    };
    if (!o.isPlayer) {
      e.tag = makeNameTag(o.name, (o.mods && o.mods.paint) || def.paint, this.o.avatars?.get(o.pid));
      this.o.scene.add(e.tag);
    } else {
      // Glowing ring on the road under your own car, so you always spot yourself in the pack
      const mat = new THREE.MeshBasicMaterial({ color: '#fff3b0', transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      e.ring = new THREE.Mesh(new THREE.RingGeometry(2.0, 2.12, 72), mat);
      e.ring.rotation.x = -Math.PI / 2;
      e.ring.renderOrder = 2;
      this.o.scene.add(e.ring);
    }
    this.cars.push(e);
    return e;
  }

  dispose() {
    for (const c of this.cars) {
      this.o.scene.remove(c.model); disposeCarModel(c.model); disposeTag(this.o.scene, c.tag);
      if (c.ring) { this.o.scene.remove(c.ring); c.ring.geometry.dispose(); c.ring.material.dispose(); }
      if (c.bubble) disposeBubble(this.o.scene, c.bubble);
    }
    this.skids?.dispose();
    this.gates?.dispose();
    this.cars = [];
  }

  // ---------- multiplayer hooks ----------
  setAvatar(pid, url) {
    const c = this.cars.find(x => x.pid === pid);
    if (c?.tag) setTagAvatar(c.tag, url);
  }
  onRemoteState(pid, d) {
    const c = this.cars.find(x => x.pid === pid);
    if (!c) return;
    let buf = this.remoteBuffer.get(pid);
    if (!buf) this.remoteBuffer.set(pid, buf = []);
    buf.push({ t: d.ts ?? performance.now(), ...d });
    if (buf.length > 30) buf.shift();
    c.lap = d.lap ?? c.lap;
    c.progressRemote = d.progress;
  }
  onRemoteCrash({ by, victim, d }) {
    if (by === this.me.pid) return; // our own hit, already shown when we detected it
    const meHit = victim === this.me.pid;
    const attacker = this.cars.find(c => c.pid === by);
    if (meHit) this._applyDhadaak(this.me, d.dir, d.power);
    this.o.onEvent?.('dhadaak', { attacker: attacker?.name, victim: meHit ? 'you' : this.cars.find(c => c.pid === victim)?.name, mine: meHit, power: d.power, pos: meHit ? this.me.phys : attacker?.phys });
  }
  onRemoteFinish({ pid, time }) {
    const c = this.cars.find(x => x.pid === pid);
    if (c && !c.finished) { c.finished = true; c.finishTime = time; this.finishOrder.push(c); }
  }
  onRemoteLeft(pid) {
    const i = this.cars.findIndex(c => c.pid === pid);
    if (i >= 0) { const [c] = this.cars.splice(i, 1); this.o.scene.remove(c.model); disposeCarModel(c.model); disposeTag(this.o.scene, c.tag); }
  }

  // ---------- main loop ----------
  update(dt, input) {
    const net = this.o.net;
    if (this.phase === 'countdown') {
      // Multiplayer: hold on the grid until the server sets startAt (everyone loaded), then count to the shared clock
      if (net) this.countdown = this.o.startAt ? (this.o.startAt - net.now()) / 1000 : 4;
      else this.countdown -= dt;
      if (this.countdown <= 0) {
        this.phase = 'racing'; this.time = 0;
        for (const c of this.cars) c.lapStart = 0;
        this.o.onEvent?.('go');
      }
    } else if (this.phase === 'racing' || this.phase === 'finished') {
      // Online, everyone's race clock is the server clock, so a phone that stutters or was backgrounded stays in sync
      this.time = net && this.o.startAt ? Math.max(this.time, (net.now() - this.o.startAt) / 1000) : this.time + dt;
    }
    const live = this.phase !== 'countdown';

    for (const c of this.cars) {
      if (c.isRemote) { this._interpolateRemote(c); if (live) this._checkpoints(c); continue; }
      let ctl = { steer: 0, throttle: 0, brake: 0, nitro: false, drift: false };
      if (live && !c.finished) {
        if (c.isPlayer) ctl = input;
        else if (c.ai) ctl = c.ai.drive(dt, c.phys, this.track, this.cars.filter(o => o !== c).map(o => o.phys), this._rubber(c));
      } else if (live && c.finished) {
        ctl = { steer: c.ai ? c.ai.drive(dt, c.phys, this.track, [], 0.7).steer : 0, throttle: 0.2, brake: 0, nitro: false, drift: false };
      }
      if (!live) { c.phys.vx = c.phys.vz = c.phys.yaw = 0; this._syncModel(c, 0); continue; } // parked on the grid until the green light
      const was = c.phys.nitroOn;
      c.phys.step(dt, ctl, this.track);
      if (c.isPlayer && c.phys.nitroOn && !was) this.o.onEvent?.('nitro');
      if (c.isPlayer && c.phys.wallHit > 6) this.o.onEvent?.('wall', { power: Math.min(1, c.phys.wallHit / 25), pos: c.phys });
      const ang = Math.abs(c.phys.slipAngle || 0);
      if (c.phys.drifting && ang > 0.14 && c.phys.speed > 9) {
        const d = c.phys.speed * dt;
        c.driftMeters += d; c.driftRun += d; c.driftTime += dt;
        // angle factor (sweet spot 20-38 deg) x combo for holding it
        c.driftRunScore += d * Math.min(1.3, ang / 0.45) * (1 + Math.min(2, c.driftTime / 1.5));
      } else if (c.driftRun) {
        // A drift just ended: bank it as a popup if it was a proper one
        if (c.isPlayer && c.driftRun > 20) this.o.onEvent?.('driftbank', { meters: Math.round(c.driftRun), points: Math.round(c.driftRunScore * 0.5), combo: Math.min(3, 1 + c.driftTime / 1.5) });
        c.driftScore += c.driftRunScore;
        c.driftRun = 0; c.driftRunScore = 0; c.driftTime = 0;
      }
      this._checkpoints(c);
      this._laps(c);
      this._stuck(c, dt, ctl);
    }

    this._collisions();
    this._positions();
    if (this.gates) { this.gates.setNext(this.me.cpNext); this.gates.update(performance.now() / 1000); }
    for (const c of this.cars) this._syncModel(c, dt);
    this._fx(dt);

    // Wrong-way detection for the player
    const p = this.me.phys;
    const fwd = Math.sin(p.h) * this.track.tx[p.index] + Math.cos(p.h) * this.track.tz[p.index];
    this.wrongWayTime = live && fwd < -0.35 && p.speed > 4 ? this.wrongWayTime + dt : 0;

    // Multiplayer state stream (~15 Hz)
    if (net) {
      this.sendTimer -= dt;
      if (this.sendTimer <= 0) {
        this.sendTimer = 1 / 15;
        net.sendState({ x: +p.x.toFixed(2), z: +p.z.toFixed(2), h: +p.h.toFixed(3), v: +p.forwardSpeed.toFixed(2), steer: +p.steer.toFixed(2),
          nitro: p.nitroOn ? 1 : 0, drift: p.drifting ? 1 : 0, lap: this.me.lap, progress: this.me.progress, ts: net.now() });
      }
    }
  }

  _rubber(c) {
    // Gentle rubber-banding so races stay close
    const gap = (c.progress - this.me.progress) / this.track.N;
    return gap > 0.15 ? 0.95 : gap < -0.15 ? 1.05 : 1;
  }

  _interpolateRemote(c) {
    const buf = this.remoteBuffer.get(c.pid);
    if (!buf || !buf.length) return;
    const t = this.o.net.now() - 120;
    let a = buf[0], b = buf[buf.length - 1];
    for (let i = 0; i < buf.length - 1; i++) if (buf[i].t <= t && buf[i + 1].t >= t) { a = buf[i]; b = buf[i + 1]; break; }
    const span = b.t - a.t;
    const k = span > 0 ? Math.min(1.25, Math.max(0, (t - a.t) / span)) : 1;
    const p = c.phys;
    const nx = a.x + (b.x - a.x) * k, nz = a.z + (b.z - a.z) * k;
    let dh = b.h - a.h; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    const prevX = p.x, prevZ = p.z;
    p.x = nx; p.z = nz; p.h = a.h + dh * k;
    p.vx = (b.x - a.x) / Math.max(0.03, span / 1000); p.vz = (b.z - a.z) / Math.max(0.03, span / 1000);
    p.steer = b.steer; p.nitroOn = !!b.nitro; p.drifting = !!b.drift;
    if (Math.hypot(nx - prevX, nz - prevZ) > 30) { /* teleport (respawn): nothing to smooth */ }
    const n = this.track.nearest(p.x, p.z, p.index); p.index = n.index; p.lateral = n.lateral;
  }

  _setupCheckpoints() {
    const cps = this.track.def && this.track.def.checkpoints;
    this.cps = null;
    if (!cps || !cps.length) return;
    const ints = [];
    for (const cp of cps) {
      if (cp.finish) continue;
      const lm = this.track.landmarks.find(l => l.id === cp.id);
      if (lm) ints.push({ ...cp, index: lm.index });
    }
    ints.sort((a, b) => a.index - b.index);
    this.cps = { all: cps, ints, finish: cps.find(c => c.finish) || null };
    // Same seed on every client: the server's grid order (multiplayer) or a fresh random one (single player)
    this.seed = this.o.grid ? this.o.grid.join(',') : String(Math.random());
  }

  // Ordered checkpoint crossing for any car (also remote cars, so the jokes match on every screen)
  _checkpoints(c) {
    if (!this.cps) return;
    const N = this.track.N, i = c.phys.index, last = c.cpLast ?? i;
    c.cpLast = i;
    const ints = this.cps.ints;
    if (c.cpNext < ints.length) {
      const idx = ints[c.cpNext].index;
      // crossed going forward (ignore big jumps like respawns going backwards)
      if (last < idx && i >= idx && i - last < 250) { this._cpHit(c, ints[c.cpNext]); c.cpNext++; }
    } else if (last > N - 80 && i < 80) {
      // Finish line after every checkpoint
      if (this.cps.finish) this._cpHit(c, this.cps.finish);
      c.cpNext = 0; c.cpDone = true; c.cpLaps++;
    }
  }

  _cpHit(c, cp) {
    if (c.isPlayer) this.o.onEvent?.('checkpoint', { name: cp.name, n: this.cps.all.indexOf(cp) + 1, total: this.cps.all.length });
    if (!cp.msg || !JOKE_CARS.has(c.def.id)) return;
    // Deterministic pick: about half of the eligible cars show the joke each time
    if (hash32(this.seed + '|' + c.pid + '|' + cp.id + '|' + c.cpLaps) % 100 >= 50) return;
    if (c.bubble) disposeBubble(this.o.scene, c.bubble);
    c.bubble = makeBubble(cp.msg);
  }

  _laps(c) {
    const N = this.track.N, i = c.phys.index, last = c.lastIndex;
    if (i > N * 0.4 && i < N * 0.6) c.half = true;
    const crossed = last > N - 80 && i < 80;
    const back = last < 80 && i > N - 80;
    const lapOk = this.cps ? c.cpDone : c.half;
    if (crossed && (lapOk || c.lap === 0)) {
      c.cpDone = false;
      if (c.lap > 0) {
        const lt = this.time - c.lapStart;
        c.lapTimes.push(lt); c.bestLap = Math.min(c.bestLap, lt);
      }
      c.lapStart = this.time; c.half = false; c.lap++;
      if (c.lap > this.laps && !c.finished) {
        c.finished = true; c.finishTime = this.time; this.finishOrder.push(c);
        if (c.isPlayer) { this.phase = 'finished'; this.o.net?.finish(Math.round(this.time * 1000), isFinite(c.bestLap) ? Math.round(c.bestLap * 1000) : null); }
        this.o.onEvent?.('finish', { car: c, place: this.finishOrder.length });
      } else if (c.isPlayer && c.lap > 1) this.o.onEvent?.('lap', { lap: c.lap, laps: this.laps });
    } else if (back && c.lap > 0 && !c.finished) {
      c.lap--; // drove back over the line
    }
    c.lastIndex = i;
    const idx = c.lap === 0 && i > N / 2 ? i - N : i;
    c.progress = c.finished ? 1e9 - this.finishOrder.indexOf(c) : c.lap * N + idx;
  }

  _stuck(c, dt, ctl) {
    const p = c.phys;
    if (this.phase === 'countdown' || c.isRemote) return;
    if (p.speed < 1.5 && (ctl.throttle > 0.5 || c.ai)) c.stuck += dt; else c.stuck = 0;
    const far = Math.abs(p.lateral) > this.track.halfWidth + 9;
    if (c.stuck > (c.ai ? 2.5 : 4) || far || (c.isPlayer && ctl.respawn)) this.respawn(c);
  }

  respawn(c) {
    const i = (c.phys.index + 3) % this.track.N;
    const lane = c.ai ? c.ai.lane * 0.6 : 0;
    const tx = this.track.tx[i], tz = this.track.tz[i];
    c.phys.place(this.track.x[i] + tz * lane, this.track.z[i] - tx * lane, Math.atan2(tx, tz));
    c.phys.index = i; c.stuck = 0;
    if (c.isPlayer) this.o.onEvent?.('respawn');
  }

  _collisions() {
    const cars = this.cars;
    const now = this.time;
    for (let a = 0; a < cars.length; a++) for (let b = a + 1; b < cars.length; b++) {
      const A = cars[a], B = cars[b];
      if (A.isRemote && B.isRemote) continue;
      const pa = A.phys, pb = B.phys;
      if (Math.abs(pa.x - pb.x) > 5 || Math.abs(pa.z - pb.z) > 5) continue;
      // Closest pair of the two circles on each car
      let best = null;
      for (const sa of [-0.9, 0.9]) for (const sb of [-0.9, 0.9]) {
        const ax = pa.x + Math.sin(pa.h) * sa, az = pa.z + Math.cos(pa.h) * sa;
        const bx = pb.x + Math.sin(pb.h) * sb, bz = pb.z + Math.cos(pb.h) * sb;
        const dx = bx - ax, dz = bz - az, d = Math.hypot(dx, dz);
        if (d < CAR_RADIUS * 2 && (!best || d < best.d)) best = { d, nx: dx / (d || 1), nz: dz / (d || 1) };
      }
      if (!best) continue;
      const { nx, nz } = best;
      const overlap = CAR_RADIUS * 2 - best.d;
      const closing = (pa.vx - pb.vx) * nx + (pa.vz - pb.vz) * nz; // > 0 = A moving into B
      // Separate (remote cars are immovable locally; only push the local one)
      const wa = A.isRemote ? 0 : B.isRemote ? 1 : 0.5, wb = 1 - wa;
      pa.x -= nx * overlap * wa; pa.z -= nz * overlap * wa;
      pb.x += nx * overlap * wb; pb.z += nz * overlap * wb;
      if (closing > 0) {
        const j = closing * 0.9;
        if (!A.isRemote) { pa.vx -= nx * j * (B.isRemote ? 1 : 0.5); pa.vz -= nz * j * (B.isRemote ? 1 : 0.5); }
        if (!B.isRemote) { pb.vx += nx * j * (A.isRemote ? 1 : 0.5); pb.vz += nz * j * (A.isRemote ? 1 : 0.5); }
      }
      // DHADAAAKK: ramming another car with nitro on
      const key = A.pid + '|' + B.pid;
      if ((this.pairCooldown.get(key) || -9) > now - 1.5) continue;
      const aFacing = Math.sin(pa.h) * nx + Math.cos(pa.h) * nz;
      const bFacing = -(Math.sin(pb.h) * nx + Math.cos(pb.h) * nz);
      let attacker = null, victim = null, dir = null;
      if (pa.nitroOn && aFacing > 0.4 && closing > DHADAAK_MIN_CLOSING) { attacker = A; victim = B; dir = [nx, nz]; }
      else if (pb.nitroOn && bFacing > 0.4 && closing > DHADAAK_MIN_CLOSING) { attacker = B; victim = A; dir = [-nx, -nz]; }
      if (!attacker) { if (closing > 3) this.o.onEvent?.('bump', { power: Math.min(1, closing / 20), pos: pa, mine: A.isPlayer || B.isPlayer }); continue; }
      // In multiplayer only the attacker's own client decides, so every hit is counted once
      if (attacker.isRemote) continue;
      this.pairCooldown.set(key, now);
      const power = Math.min(1, closing / 25);
      attacker.dhadaaks++;
      if (victim.isRemote) this.o.net?.crash(victim.pid, { power, dir });
      else this._applyDhadaak(victim, dir, power);
      this.o.onEvent?.('dhadaak', { attacker: attacker.isPlayer ? 'you' : attacker.name, victim: victim.isPlayer ? 'you' : victim.name, mine: attacker.isPlayer || victim.isPlayer, byMe: attacker.isPlayer, power, pos: victim.phys });
    }
  }

  _applyDhadaak(victim, dir, power) {
    const p = victim.phys;
    p.vx = p.vx * 0.35 + dir[0] * (8 + power * 10);
    p.vz = p.vz * 0.35 + dir[1] * (8 + power * 10);
    p.yaw = (Math.random() < 0.5 ? -1 : 1) * (5 + power * 4);
    p.spin = 1.1 + power * 0.6;
  }

  _positions() {
    const sorted = [...this.cars].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      const pa = a.isRemote && a.progressRemote != null ? a.progressRemote : a.progress;
      const pb = b.isRemote && b.progressRemote != null ? b.progressRemote : b.progress;
      return pb - pa;
    });
    sorted.forEach((c, i) => { c.place = i + 1; });
    // Overtakes: reward the player for climbing places (after a short settle at the start)
    const me = this.me;
    if (this.phase === 'racing' && this.time > 2 && !me.finished && me.lastPlace && me.place < me.lastPlace) {
      const n = me.lastPlace - me.place;
      me.overtakes += n;
      this.o.onEvent?.('overtake', { count: n, points: n * ECONOMY_OVERTAKE });
    }
    me.lastPlace = me.place;
  }

  _syncModel(c, dt) {
    const p = c.phys, m = c.model, u = m.userData;
    const y = this.track.y ? this.track.y[p.index] || 0 : 0;
    m.position.set(p.x, y, p.z);
    m.rotation.y = p.h;
    const v = p.forwardSpeed;
    c.wheelSpin += v * dt / (u.radius || 0.29);
    if (u.wheels) for (const w of u.wheels) w.rotation.x = c.wheelSpin;
    if (u.wheelPivots) for (const w of u.wheelPivots) w.rotation.y = p.steer * 0.5;
    if (u.body) {
      const rollT = THREE.MathUtils.clamp(-p.yaw * Math.abs(v) * 0.0045, -0.09, 0.09);
      const pitchT = THREE.MathUtils.clamp((p.brake > 0 && v > 1 ? 0.03 : 0) - (p.throttle > 0 ? 0.012 : 0), -0.05, 0.05);
      u.body.rotation.z += (rollT - u.body.rotation.z) * Math.min(1, dt * 8);
      u.body.rotation.x += (pitchT - u.body.rotation.x) * Math.min(1, dt * 6);
    }
    if (u.brakeMat) u.brakeMat.emissiveIntensity = p.brake > 0.1 && v > 0.5 ? 2.5 : 0.35;
    if (u.halo) u.halo.position.y = (u.haloBase ??= u.halo.position.y) + Math.sin(performance.now() / 400) * 0.06;
    if (c.bubble) {
      const bb = c.bubble;
      bb.t += dt;
      const t = bb.t;
      // pop in with a little overshoot, float up gently, fade out
      bb.pop = t < 0.25 ? Math.sin((t / 0.25) * Math.PI * 0.5) * 1.12 : t < 0.4 ? 1.12 - (t - 0.25) / 0.15 * 0.12 : 1;
      bb.pos.x = p.x; bb.pos.y = y + 2.3 + t * 0.35; bb.pos.z = p.z;
      bb.opacity = t > BUBBLE_LIFE - 0.5 ? Math.max(0, (BUBBLE_LIFE - t) / 0.5) : 1;
      if (t > BUBBLE_LIFE) { disposeBubble(this.o.scene, bb); c.bubble = null; }
    }
    if (c.ring) {
      c.ring.position.set(p.x, y + 0.06, p.z);
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 160);
      c.ring.material.color.set(p.nitroOn ? '#7fe9ff' : p.drifting ? '#ffc533' : '#fff3b0');
      c.ring.material.opacity = p.nitroOn ? 0.55 + pulse * 0.25 : 0.32;
      const s = p.nitroOn ? 1.06 + pulse * 0.05 : 1;
      c.ring.scale.set(s, s, s);
    }
    if (c.tag) {
      // Float well above the roof; fade out when close so it never hides the car you are chasing
      c.tag.position.set(p.x, y + 2.75, p.z);
      const me = this.me.phys;
      const d = Math.hypot(p.x - me.x, p.z - me.z);
      const target = d < 7 ? 0 : d < 14 ? (d - 7) / 7 * 0.85 : d > 160 ? 0 : 0.85;
      const mat = c.tag.material;
      mat.opacity += (target - mat.opacity) * Math.min(1, dt * 8 || 1);
      c.tag.visible = mat.opacity > 0.02;
    }
  }

  _fx(dt) {
    const fx = this.o.fx;
    if (!fx) return;
    for (const c of this.cars) {
      const p = c.phys, u = c.model.userData;
      const back = -1.5;
      const bx = p.x + Math.sin(p.h) * back, bz = p.z + Math.cos(p.h) * back;
      if (p.drifting && p.driftAmount > 2.5) {
        for (const s of [-0.65, 0.65]) {
          tmpV.set(bx + Math.cos(p.h) * s, 0.25, bz - Math.sin(p.h) * s);
          fx.smoke(tmpV, { x: -p.vx * 0.05, y: 0.6, z: -p.vz * 0.05 }, Math.min(1, p.driftAmount / 8));
        }
      }
      if (p.drifting && Math.abs(p.slipAngle || 0) > 0.12 && p.speed > 8) {
        for (const side of [-0.62, 0.62]) this.skids.add(c, side, bx + Math.cos(p.h) * side, bz - Math.sin(p.h) * side, p.h, Math.min(1, Math.abs(p.slipAngle) / 0.5));
      } else this.skids.lift(c);
      if (p.nitroOn && u.exhaust) {
        u.exhaust.getWorldPosition(tmpV);
        fx.nitro(tmpV, { x: -Math.sin(p.h), y: 0, z: -Math.cos(p.h) }, { x: p.vx, y: 0, z: p.vz });
      }
      if (p.offroad && p.speed > 8 && Math.random() < 0.5) { tmpV.set(bx, 0.2, bz); fx.dust(tmpV); }
      // Rain: water spray off both rear wheels
      if (this.o.weather === 'rain' && p.speed > 6 && fx.spray) {
        for (const side of [-0.62, 0.62]) {
          tmpV.set(bx + Math.cos(p.h) * side, 0.2, bz - Math.sin(p.h) * side);
          fx.spray(tmpV, { x: p.vx, y: 0, z: p.vz }, Math.min(1, p.speed / 30));
        }
      }
      if (p.wallHit > 6) { tmpV.set(p.x, 0.5, p.z); fx.sparks(tmpV, 10); }
    }
    fx.update(dt);
  }

  hud() {
    const p = this.me.phys;
    return {
      place: this.me.place, total: this.cars.length,
      lap: Math.min(this.laps, Math.max(1, this.me.lap)), laps: this.laps,
      time: this.phase === 'countdown' ? 0 : this.me.finished ? this.me.finishTime : this.time,
      lapTime: this.time - this.me.lapStart,
      best: isFinite(this.me.bestLap) ? this.me.bestLap : null,
      speedKmh: Math.round(Math.abs(p.forwardSpeed) * 3.6),
      nitro01: p.nitroTank, nitroOn: p.nitroOn, driftOn: p.drifting,
      drift: p.drifting ? Math.round(this.me.driftMeters) : 0,
      wrongWay: this.wrongWayTime > 1.2,
      checkpoint: this.cps ? (() => {
        const n = this.me.cpNext, ints = this.cps.ints;
        const next = n < ints.length ? ints[n] : this.cps.finish;
        return next ? { name: next.name, n: Math.min(n + 1, this.cps.all.length), total: this.cps.all.length } : null;
      })() : null,
    };
  }

  mapCars() {
    return this.cars.map(c => ({ x: c.phys.x, z: c.phys.z, color: c.mods?.paint || c.def.paint, me: c.isPlayer }));
  }

  // Points for the player once they finish
  rewards() {
    const me = this.me;
    const place = me.place;
    const rows = [];
    rows.push(['Finish P' + place, ECONOMY.placePoints[Math.min(place, 8) - 1] || 80]);
    const ds = me.driftScore + me.driftRunScore;
    if (me.driftMeters > 10) rows.push(['Drift ' + Math.round(me.driftMeters) + ' m', Math.round(Math.max(me.driftMeters * ECONOMY.driftPerMeter, ds * 0.5))]);
    if (me.dhadaaks) rows.push(['DHADAAAKK x' + me.dhadaaks, me.dhadaaks * ECONOMY.dhadaakBonus]);
    if (me.overtakes) rows.push(['Overtakes x' + me.overtakes, me.overtakes * ECONOMY_OVERTAKE]);
    const total = rows.reduce((s, r) => s + r[1], 0);
    return { rows, total };
  }

  standings() {
    return [...this.cars].sort((a, b) => a.place - b.place).map(c => ({
      place: c.place, name: c.isPlayer ? (c.name || 'You') : c.name, car: c.def.name, carId: c.def.id, pid: c.pid,
      time: c.finished ? c.finishTime : null, best: isFinite(c.bestLap) ? c.bestLap : null, me: c.isPlayer,
    }));
  }
}
