import './style.css';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CARS, TRACKS, DIFFICULTY } from './config.js';
import { buildTrack } from './tracks.js';
import { World } from './world.js';
import { FX } from './fx.js';
import { buildCarModel, applyMods, disposeCarModel } from './carModel.js';
import { Race } from './race.js';
import { Profile } from './save.js';
import { Input } from './input.js';
import { GameAudio } from './audio.js';
import { UI } from './ui.js';
import { Net, roomFromUrl } from './net.js';
import { openSelfie, savedSelfie } from './selfie.js';
import { SpeedLines } from './speedfx.js';
import { Post } from './post.js';
import { Weather } from './weather.js';

const profile = new Profile();
const settings = profile.d.settings;
// Always render at full quality (high-res shadows, dense scenery, antialiasing) on every device
const QUALITY = 'high';
settings.quality = QUALITY;
const canvas = document.getElementById('game');

// ---------- renderer ----------
let renderer;
function makeRenderer() {
  // Post does its own anti-aliasing (MSAA/FXAA), so the default framebuffer skips it (saves memory on iOS)
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
}
makeRenderer();

const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 2500);
const world = new World(renderer);
let fx = null, weather = null;
// Cinematic post-processing: bloom, warm grade, vignette, nitro blur (falls back to plain rendering if unsupported)
const post = new Post(renderer, { quality: QUALITY });

// ---------- garage / menu showroom ----------
const showroom = new THREE.Scene();
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  showroom.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  showroom.background = new THREE.Color('#1d1747');
  showroom.fog = new THREE.Fog('#1d1747', 12, 30);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(4.2, 64), new THREE.MeshStandardMaterial({ color: '#2a2366', roughness: 0.35, metalness: 0.2 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; showroom.add(floor);
  const ring = new THREE.Mesh(new THREE.RingGeometry(4.2, 4.45, 64), new THREE.MeshBasicMaterial({ color: '#ff9933' }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.01; showroom.add(ring);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: '#151036', roughness: 0.9 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.01; showroom.add(ground);
  const key = new THREE.SpotLight('#fff1d6', 60, 25, 0.6, 0.5); key.position.set(4, 7, 5); key.castShadow = true; key.shadow.mapSize.set(1024, 1024); showroom.add(key);
  const rim = new THREE.SpotLight('#ff9933', 40, 25, 0.7, 0.6); rim.position.set(-5, 4, -4); showroom.add(rim);
  showroom.add(new THREE.HemisphereLight('#c9c3ff', '#1d1747', 0.6));
}
let showCar = null, showCarId = null, garageIndex = CARS.findIndex(c => c.id === profile.d.selected);
const showCam = new THREE.PerspectiveCamera(40, 1, 0.1, 100);

function setShowCar(id) {
  const mods = profile.mods(id);
  if (showCar && showCarId === id) { applyMods(showCar, mods); return; }
  if (showCar) { showroom.remove(showCar); disposeCarModel(showCar); }
  showCar = buildCarModel(id, mods);
  showCar.traverse(o => { if (o.isMesh) o.castShadow = true; });
  showroom.add(showCar); showCarId = id;
}

// ---------- systems ----------
const input = new Input();
const audio = new GameAudio();
const net = new Net();
let race = null, track = null, screen = 'loading', paused = false;
let raceSettings = { track: TRACKS[0].id, laps: settings.laps || 3, difficulty: settings.difficulty || 'normal', timeOfDay: settings.timeOfDay || null, weather: settings.weather || 'clear' };
let mpRace = false, shake = 0, lastBannerAt = 0;
const avatars = new Map(); // pid -> selfie data URL, for players in the current room
net.setAvatar(savedSelfie());

const ui = new UI({
  onPlay: () => { audio.click(); ui.setTracks(TRACKS, raceSettings.track, raceSettings); go('tracks'); },
  onTrack: id => { raceSettings.track = id; ui.setTracks(TRACKS, id, raceSettings); },
  onGarage: () => { audio.click(); refreshGarage(); go('garage'); },
  onCarPrev: () => { garageIndex = (garageIndex + CARS.length - 1) % CARS.length; refreshGarage(); audio.click(); },
  onCarNext: () => { garageIndex = (garageIndex + 1) % CARS.length; refreshGarage(); audio.click(); },
  onBuyCar: () => {
    const car = CARS[garageIndex];
    if (profile.buy(car.id)) { ui.toast(`${car.name} is yours!`); audio.lapDing(); } else ui.toast('Not enough points');
    refreshGarage();
  },
  onSelectCar: () => { const car = CARS[garageIndex]; profile.select(car.id); ui.toast(`${car.name} selected`); refreshGarage(); if (net.room) net.setCar(car.id, profile.mods(car.id)); },
  onMod: (key, value) => {
    const car = CARS[garageIndex];
    if (!profile.owns(car.id)) { ui.toast('Buy this Alto first'); return; }
    if (key === 'plate') value = sanitizePlate(value);
    profile.setMod(car.id, key, value); refreshGarage(); audio.click();
  },
  onUpgrade: key => {
    const car = CARS[garageIndex];
    if (!profile.owns(car.id)) { ui.toast('Buy this Alto first'); return; }
    if (profile.upgrade(car.id, key)) { audio.lapDing(); ui.toast('Upgraded!'); } else ui.toast(profile.upgradeCost(car.id, key) == null ? 'Maxed out' : 'Not enough points');
    refreshGarage();
  },
  onStart: s => { Object.assign(raceSettings, s || {}); persistRaceSettings(); startSingle(); },
  onMultiplayer: () => { audio.click(); ui.prefillName?.(profile.d.name || ''); ui.setSelfie?.(savedSelfie()); go('mp'); },
  onSelfie: async () => {
    const r = await openSelfie();
    if (r === undefined) return; // cancelled
    net.setAvatar(r);
    if (net.me) { if (r) avatars.set(net.me, r); else avatars.delete(net.me); if (net.room) ui.setLobby(net.room, net.me, avatars); }
    ui.setSelfie?.(r);
    ui.toast(r ? 'Selfie added: friends will see it above your Alto' : 'Selfie removed');
  },
  onCreateRoom: async name => {
    profile.d.name = (name || '').trim().slice(0, 16) || 'Racer'; profile.save();
    try { await net.create(profile.d.name, profile.d.selected, profile.mods(profile.d.selected)); go('lobby'); }
    catch (e) { ui.toast(e.message || 'Could not create room'); }
  },
  onJoinRoom: async (pin, name) => {
    profile.d.name = (name || '').trim().slice(0, 16) || 'Racer'; profile.save();
    try { await net.join(String(pin).trim(), profile.d.name, profile.d.selected, profile.mods(profile.d.selected)); go('lobby'); }
    catch (e) { ui.toast(e.message || 'Could not join'); }
  },
  onLeaveRoom: () => { net.leave(); endRace(); go('menu'); },
  onHostSettings: s => net.setSettings(s),
  onHostStart: () => net.start(),
  onResume: () => { paused = false; go('race'); },
  onRestart: () => { paused = false; if (mpRace) return; startSingle(); },
  onQuit: () => { paused = false; if (mpRace) { net.leave(); } endRace(); go('menu'); },
  onRaceAgain: () => { if (mpRace) { endRace(); go('lobby'); } else startSingle(); },
  onSettings: s => {
    const { quality, ...rest } = s || {}; // graphics are always high; ignore any old quality setting
    Object.assign(settings, rest); profile.save();
    if (s.muted != null) audio.setMuted(s.muted);
    input.setTouch(wantTouch());
  },
  onReady: () => { audio.unlock(); go('menu'); if (pendingPin) { ui.prefillName?.(profile.d.name || ''); go('mp'); ui.prefillPin?.(pendingPin); ui.toast(`Enter your name and join room ${pendingPin}`); } },
  onPause: () => { if (screen === 'race') { paused = !mpRace; go('pause'); } },
  onMenu: () => { if (mpRace) net.leave(); endRace(); go('menu'); },
  onBack: from => { if (from === 'lobby') { net.leave(); endRace(); } go('menu'); },
  onClick: () => audio.click(),
  onClaimDaily: () => {
    const o = profile.claimDaily();
    if (o) { ui.toast(`Day ${o.day} reward: +${o.points} points`); audio.lapDing(); }
    ui.daily(profile.dailyOffer()); ui.setPoints(profile.points);
  },
});

function sanitizePlate(v) {
  const s = String(v || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim().slice(0, 13);
  return s.startsWith('GJ') ? s : ('GJ 06 ' + s).slice(0, 13);
}
function persistRaceSettings() { settings.laps = raceSettings.laps; settings.difficulty = raceSettings.difficulty; settings.timeOfDay = raceSettings.timeOfDay; settings.weather = raceSettings.weather; profile.save(); }
function wantTouch() { return settings.touch !== 'off' && (matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window); }

function refreshGarage() {
  const car = CARS[garageIndex];
  setShowCar(car.id);
  ui.setGarage({
    car, owned: profile.owns(car.id), selected: profile.d.selected === car.id, price: car.price, canAfford: profile.points >= car.price,
    mods: profile.mods(car.id), upgrades: Object.fromEntries(['engine', 'turbo', 'tyres', 'nitro'].map(k => [k, { level: profile.levels(car.id)[k], cost: profile.upgradeCost(car.id, k) }])),
    stats: profile.stats(car.id), maxStats: profile.maxStats(car.id), index: garageIndex, total: CARS.length,
  });
  ui.setPoints(profile.points);
}

function go(s) {
  screen = s; ui.show(s);
  input.setTouch(s === 'race' && wantTouch());
  if (s === 'menu') { garageIndex = CARS.findIndex(c => c.id === profile.d.selected); setShowCar(profile.d.selected); ui.setPoints(profile.points); ui.daily(profile.dailyOffer()); }
}

// ---------- races ----------
let currentWeather = 'clear', currentTime = 'day';
function loadTrack(id, timeOfDay, weatherKind = 'clear') {
  const def = TRACKS.find(t => t.id === id) || TRACKS[0];
  track = buildTrack(def);
  currentWeather = weatherKind === 'rain' ? 'rain' : 'clear';
  currentTime = timeOfDay || def.timeOfDay;
  world.load(track, { timeOfDay: currentTime, quality: QUALITY, weather: currentWeather });
  fx = new FX(world.scene, QUALITY); // world.load() clears the scene, so particles are rebuilt per track
  fx.setTimeOfDay?.(currentTime);
  weather?.dispose();
  weather = new Weather(world.scene, QUALITY, { timeOfDay: currentTime });
  weather.set(currentWeather);
  post.setTimeOfDay(currentTime);
  post.setWeather(currentWeather);
  return def;
}

function playerOpts() {
  const id = profile.d.selected, def = CARS.find(c => c.id === id);
  audio.setEV?.(!!def.bike); // electric motor voice for the EV Bike
  return { carId: id, mods: profile.mods(id), stats: profile.stats(id), nitroMul: def.nitroMul, name: profile.d.name || 'You' };
}

function startSingle() {
  endRace();
  mpRace = false;
  const def = loadTrack(raceSettings.track, raceSettings.timeOfDay, raceSettings.weather);
  race = new Race({ scene: world.scene, track, fx, laps: raceSettings.laps, difficulty: DIFFICULTY[raceSettings.difficulty] || 0.95, player: playerOpts(), rivals: 7, shadows: true, weather: currentWeather, onEvent: onRaceEvent });
  startCamera();
  go('race');
  ui.raceIntro?.('RACE · ' + def.name, def.tagline);
}

function startMulti(p) {
  endRace();
  mpRace = true;
  const def = loadTrack(p.track, p.timeOfDay, p.weather);
  const room = net.room;
  race = new Race({ scene: world.scene, track, fx, laps: p.laps, difficulty: 1, player: playerOpts(), net, grid: p.grid, players: room.players, startAt: p.startAt, avatars, shadows: true, weather: currentWeather, onEvent: onRaceEvent });
  startCamera();
  go('race');
  ui.raceIntro?.('RACE · ' + def.name, def.tagline);
  ui.banner('Waiting for everyone to load…', 'info');
  net.loaded();
}

function endRace() {
  if (race) { race.dispose(); race = null; }
  ui.countdown(null);
}

let lastCount = null;
function onRaceEvent(type, d) {
  switch (type) {
    case 'go':
      ui.countdown(0); ui.raceIntro?.(null); audio.countdown(true); setTimeout(() => ui.countdown(null), 900);
      // Controls reminder (first few races of a session)
      if ((controlsHints = (controlsHints || 0) + 1) <= 3) setTimeout(() => ui.toast(wantTouch()
        ? 'Hold ⌃ to go · hold DRIFT while turning to slide · N₂O to boost'
        : '↑ gas · ← → steer · hold SHIFT (or X) while turning to DRIFT · SPACE nitro'), 1100);
      break;
    case 'nitro': audio.nitroStart(); break;
    case 'lap': ui.banner(d.lap === d.laps ? 'FINAL LAP!' : `LAP ${d.lap}/${d.laps}`, 'info'); audio.lapDing(); break;
    case 'wall': if (d.power > 0.25) { audio.crash(d.power * 0.6); shake = Math.max(shake, d.power * 0.3); } break;
    case 'bump': if (d.mine) { audio.crash(d.power * 0.5); shake = Math.max(shake, d.power * 0.25); } break;
    case 'dhadaak': {
      const near = d.mine || (d.pos && race && Math.hypot(d.pos.x - race.me.phys.x, d.pos.z - race.me.phys.z) < 45);
      if (!near) break;
      const now = performance.now();
      if (now - lastBannerAt > 700) {
        lastBannerAt = now;
        ui.banner('DHADAAAKK!', 'dhadaak');
        if (d.mine) ui.toast(d.byMe ? `You DHADAAAKKed ${d.victim}!` : `${d.attacker} DHADAAAKKed you!`);
      }
      audio.dhadaak(); shake = Math.min(1, shake + (d.mine ? 0.85 : 0.4));
      // Hit-stop: a brief near-freeze sells the impact (single-player only, so online clocks stay in sync)
      if (d.mine && !mpRace) hitStopUntil = performance.now() + 110;
      if (d.pos) { fx.sparks(new THREE.Vector3(d.pos.x, 0.6, d.pos.z), 40); }
      if (d.byMe) { profile.d.dhadaaks++; ui.popup?.('+75 DHADAAAKK', 'dhadaak'); }
      break;
    }
    case 'finish':
      if (d.car.isPlayer) {
        audio.finish();
        ui.banner(d.place === 1 ? 'PEHLA NUMBER!' : `P${d.place}`, 'info');
        setTimeout(() => showResults(), mpRace ? 300 : 1800);
      }
      break;
    case 'respawn': ui.toast('Back on the road'); break;
    case 'overtake': ui.popup?.(`+${d.points} ${d.count > 1 ? (d.count === 2 ? 'DOUBLE ' : 'TRIPLE ') : ''}OVERTAKE`, 'good'); break;
    case 'driftbank': ui.popup?.(`+${d.points} DRIFT${d.combo >= 1.5 ? ' x' + d.combo.toFixed(1) : ''} · ${d.meters} m`, 'nitro'); break;
    case 'checkpoint': ui.cpPhoto({ ...d, final: d.n === d.total && race && race.me.lap >= race.laps }); audio.lapDing(); break;
    case 'pickup': audio.pickup?.(); ui.popup?.(d.tank >= 0.99 ? 'NITRO FULL' : '+NITRO', 'nitro'); break;
    case 'hazard': audio.crash(0.3 + d.power * 0.5); shake = Math.max(shake, 0.2 + d.power * 0.4); if (d.power > 0.25) ui.toast?.(Math.random() < 0.5 ? 'Arre! Dhyan se, boss 😵' : 'Road pe dekh ke chala! 🐄🚧'); break;
  }
}

let resultsShown = false;
// Meme victory title for the winner: every car has its own (TRU LORD, CERTIFIED KIDNAPER, CNG KA KING...)
function winTitle(rows) {
  const w = [...rows].sort((a, b) => (a.place || 99) - (b.place || 99))[0];
  if (!w || w.place !== 1) return null;
  const def = CARS.find(c => c.id === w.carId);
  return { title: def?.winTitle || '🏆 BARODA KA BOSS 😎', name: w.me ? 'You' : w.name, car: def?.name || w.car || 'Alto', me: !!w.me };
}
function showResults(mpRows) {
  if (!race) return;
  if (!resultsShown) {
    resultsShown = true;
    const r = race.rewards();
    profile.add(r.total); profile.d.races++;
    if (race.me.place === 1) profile.d.wins++;
    const best = race.me.bestLap;
    if (isFinite(best) && profile.setBest(track.id, Math.round(best * 1000))) ui.toast('New personal best lap!');
    profile.save();
    race._reward = r;
  }
  const rows = mpRows || race.standings().map(s => ({ ...s, points: s.me ? race._reward.total : null }));
  ui.results(rows, race._reward.total, race._reward.rows, winTitle(rows));
  ui.setPoints(profile.points);
  go('results');
}

// ---------- multiplayer events ----------
net.on('room', room => {
  if (!room) { avatars.clear(); if (screen === 'lobby') go('menu'); return; }
  for (const pid of [...avatars.keys()]) if (!room.players.some(p => p.pid === pid)) avatars.delete(pid);
  const mine = savedSelfie(); if (mine && net.me) avatars.set(net.me, mine);
  if (screen === 'lobby' || screen === 'mp') ui.setLobby(room, net.me, avatars);
});
net.on('avatar', (pid, data) => {
  if (data) avatars.set(pid, data); else avatars.delete(pid);
  race?.setAvatar(pid, data);
  if (net.room && screen === 'lobby') ui.setLobby(net.room, net.me, avatars);
});
net.on('prepare', p => { resultsShown = false; startMulti(p); });
net.on('go', ({ startAt }) => { if (race && mpRace) race.o.startAt = startAt; });
net.on('state', (pid, d) => race?.onRemoteState(pid, d));
net.on('crash', e => race?.onRemoteCrash(e));
net.on('horn', () => audio.horn());
net.on('finish', e => race?.onRemoteFinish({ pid: e.pid ?? e.p, time: e.time / 1000 }));
net.on('results', res => {
  const players = net.room?.players || [];
  const rows = (res.rows || res).map(r => ({ place: r.place, name: r.name, time: r.time != null ? r.time / 1000 : null, best: r.best != null ? r.best / 1000 : null, me: r.pid === net.me, carId: players.find(p => p.pid === r.pid)?.car || (r.pid === net.me ? profile.d.selected : null) }));
  if (race) showResults(rows);
});
net.on('left', pid => race?.onRemoteLeft(pid));
net.on('kicked', () => { endRace(); ui.toast('You were removed from the room'); go('menu'); });
net.on('status', s => { if (s === 'offline' && mpRace && race) ui.toast('Connection lost, reconnecting…'); });
net.on('error', e => ui.toast(e.message || 'Network error'));

// ---------- camera ----------
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
function startCamera() {
  const p = race.me.phys;
  camPos.set(p.x - Math.sin(p.h) * 8, 3.4, p.z - Math.cos(p.h) * 8);
  camLook.set(p.x, 1, p.z);
  camera.position.copy(camPos); camera.lookAt(camLook);
}
let camSpeed = 0, camThrust = 0, camDrift = 0;
function updateCamera(dt) {
  const p = race.me.phys;
  const v = Math.abs(p.forwardSpeed);
  // Low, close chase cam (sells speed). Portrait screens are narrow, so sit a bit further back and higher.
  const portrait = camera.aspect < 1;
  // Thrust: the camera lags back when you accelerate or hit nitro, and settles in when you brake
  const accel = (v - camSpeed) / Math.max(dt, 1e-3); camSpeed = v;
  camThrust += (THREE.MathUtils.clamp(accel * 0.05 + (p.nitroOn ? 0.9 : 0), -0.5, 1.4) - camThrust) * Math.min(1, dt * 3);
  // The EV Bike is half a car's size: sit closer and a bit lower so it fills the frame like a car does
  const sz = race.me.def.bike ? 0.7 : 1;
  const back = ((portrait ? 7.0 : 5.8) + v * 0.035) * sz + camThrust, up = ((portrait ? 2.5 : 1.85) + v * 0.007) * (race.me.def.bike ? 0.85 : 1);
  const fx_ = Math.sin(p.h), fz = Math.cos(p.h);
  const y = track.y ? track.y[p.index] || 0 : 0;
  const tx = p.x - fx_ * back, tz = p.z - fz * back;
  const k = 1 - Math.exp(-dt * 11); // tight follow so turns read instantly
  camPos.x += (tx - camPos.x) * k; camPos.z += (tz - camPos.z) * k; camPos.y += (y + up - camPos.y) * k;
  const ahead = portrait ? 7 : 4.5;
  // During a drift the camera eases out to the side of the slide and looks a touch into the corner
  camDrift += ((p.slipAngle || 0) * (p.driftBlend || 0) - camDrift) * Math.min(1, dt * 4);
  const rx = Math.cos(p.h), rz = -Math.sin(p.h);
  camPos.x += rx * camDrift * 1.2 * k; camPos.z += rz * camDrift * 1.2 * k;
  camLook.set(p.x + fx_ * ahead - rx * camDrift * 1.6, y + (portrait ? 0.55 : 0.95), p.z + fz * ahead - rz * camDrift * 1.6);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
  // Road rumble at high speed: a faint constant buzz on top of impact shake
  if (v > 28) {
    const t = performance.now() / 1000, a = Math.min(1, (v - 28) / 30) * (p.nitroOn ? 0.035 : 0.018);
    camera.position.y += Math.sin(t * 61.7) * a; camera.position.x += Math.sin(t * 47.3 + 1.1) * a;
  }
  if (shake > 0) {
    // Trauma shake: amplitude = trauma^2 (light bumps barely move, DHADAAAKK punches), smooth noise, decays to rest
    const s = shake * shake, t = performance.now() / 1000;
    camera.position.x += Math.sin(t * 37.1) * Math.cos(t * 23.7) * s * 0.55;
    camera.position.y += Math.sin(t * 41.3 + 1.7) * s * 0.35;
    camera.rotation.z += Math.sin(t * 29.9 + 0.4) * s * 0.06;
    shake = Math.max(0, shake - dt * 1.4);
  }
  // FOV opens up with speed and punches out on nitro: the main "going fast" cue
  const fov = (portrait ? 70 : 58) + Math.min(16, Math.max(0, v - 8) * 0.38) + (p.nitroOn ? 11 : 0);
  camera.fov += (fov - camera.fov) * Math.min(1, dt * (fov > camera.fov ? 5 : 2.5)); camera.updateProjectionMatrix();
}

// ---------- menu scene: your Alto parked on the real Vadodara street (outside Bright Day School) ----------
let menuCar = null, menuCarKey = '', menuSpot = null;
const menuCam = new THREE.PerspectiveCamera(42, 1, 0.1, 2500);
function ensureMenuCar() {
  if (!track) return false;
  const id = profile.d.selected, mods = profile.mods(id);
  const key = id + '|' + track.id;
  if (!menuCar || menuCarKey !== key || menuCar.parent !== world.scene) {
    if (menuCar) { menuCar.parent?.remove(menuCar); disposeCarModel(menuCar); }
    menuCar = buildCarModel(id, mods);
    menuCar.traverse(o => { if (o.isMesh) o.castShadow = true; });
    const lm = track.landmarks.find(l => l.id === 'brightday') || track.landmarks[0];
    const i = ((lm ? lm.index : 30) + 52) % track.N; // a little up the road, away from the start gantry
    menuSpot = { x: track.x[i], z: track.z[i], y: track.y[i] || 0, h: Math.atan2(track.tx[i], track.tz[i]) };
    menuCar.position.set(menuSpot.x, menuSpot.y, menuSpot.z);
    menuCar.rotation.y = menuSpot.h;
    world.scene.add(menuCar);
    menuCarKey = key;
  } else applyMods(menuCar, mods);
  return true;
}
function hideMenuCar() { if (menuCar) menuCar.parent?.remove(menuCar); }
function renderMenu(dt, t) {
  if (!ensureMenuCar()) return false;
  const s = menuSpot, portrait = innerWidth < innerHeight;
  const fx_ = Math.sin(s.h), fz = Math.cos(s.h), rx = Math.cos(s.h), rz = -Math.sin(s.h);
  // Front three-quarter view with a gentle drift; on phones frame the car in the gap between title and card
  const sway = Math.sin(t * 0.25) * 0.6;
  const dist = portrait ? 9.5 : 7.2;
  menuCam.position.set(s.x + fx_ * dist + rx * (2.6 + sway), s.y + (portrait ? 2.2 : 1.6), s.z + fz * dist + rz * (2.6 + sway));
  menuCam.lookAt(s.x - rx * (portrait ? 0 : 1.6), s.y + (portrait ? 1.9 : 0.8), s.z - rz * (portrait ? 0 : 1.6));
  menuCam.aspect = innerWidth / innerHeight; menuCam.fov = portrait ? 52 : 40; menuCam.updateProjectionMatrix();
  if (menuCar.userData.halo) menuCar.userData.halo.rotation.y += dt;
  world.update(dt, menuCar.position);
  weather?.update(dt, menuCam, 0, menuCar.position);
  post.render(world.scene, menuCam, dt);
  return true;
}

// ---------- loop ----------
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  post?.setSize(w, h, renderer.getPixelRatio());
  camera.aspect = w / h; camera.updateProjectionMatrix();
  showCam.aspect = w / h;
  // On portrait phones pull the showroom camera back so the whole car fits
  showCam.fov = w < h ? 55 : 40; showCam.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

let last = performance.now(), acc = 0, hudTimer = 0, orbit = 0;
const STEP = 1 / 120;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  const inp = input.read();

  if (screen === 'race' || screen === 'pause' || screen === 'results') {
    if (inp.pausePressed && screen === 'race') { paused = !mpRace; go('pause'); }
    else if (inp.pausePressed && screen === 'pause') { paused = false; go('race'); }
    if (race && !(paused && !mpRace)) {
      const ctl = screen === 'race' ? { steer: -inp.steer, throttle: inp.throttle, brake: inp.brake, nitro: inp.nitro, drift: inp.drift, respawn: inp.respawnPressed, sens: settings.steerSens ?? 1 }
        : { steer: 0, throttle: 0, brake: 0, nitro: false, drift: false };
      if (inp.horn && screen === 'race' && !hornHeld) { audio.horn(); net.room && net.horn?.(); }
      hornHeld = inp.horn;
      acc += performance.now() < hitStopUntil ? dt * 0.06 : dt;
      while (acc >= STEP) { race.update(STEP, ctl); acc -= STEP; ctl.respawn = false; }
      // Countdown beeps
      if (race.phase === 'countdown') {
        const n = Math.ceil(race.countdown);
        if (n !== lastCount && n >= 1 && n <= 3) { ui.countdown(n); audio.countdown(false); }
        lastCount = n;
      } else lastCount = null;
      updateCamera(dt);
      world.update(dt, race.me.model.position);
      const p = race.me.phys;
      audio.engine(Math.min(1, Math.abs(p.forwardSpeed) / 50), ctl.throttle, p.nitroOn);
      audio.skid(p.drifting ? Math.min(1, p.driftAmount / 8) : 0);
      if (weather) {
        weather.update(dt, camera, p.forwardSpeed, race.me.model.position);
        if (weather.lightning) post.flash(weather.lightning * 0.6);
      }
      post.setSpeedFx(Math.min(1, Math.abs(p.forwardSpeed) / 50), p.nitroOn && screen === 'race');
      speedLines.update(dt, screen === 'race' ? Math.abs(p.forwardSpeed) : 0, p.nitroOn && screen === 'race', 0.5, camera.aspect < 1 ? 0.4 : 0.44);
      input.setNitro?.(p.nitroTank, p.nitroOn);
      // Speed number floating beside your car (Auto Rush style), projected from 3D each frame
      if (screen === 'race') {
        const e = camera.matrixWorld.elements; // column 0 = camera right
        tagV.copy(race.me.model.position).addScaledVector(tagR.set(e[0], 0, e[2]).normalize(), -1.75);
        tagV.y += 1.35;
        tagV.project(camera);
        if (tagV.z < 1) ui.speedTag?.((tagV.x + 1) / 2 * innerWidth, (1 - tagV.y) / 2 * innerHeight, Math.round(Math.abs(p.forwardSpeed) * 3.6));
        else ui.speedTag?.(null, null, 0);
      }
      hudTimer -= dt;
      if (hudTimer <= 0 && screen === 'race') {
        hudTimer = 1 / 20;
        const h = race.hud();
        ui.hud(h);
        const mm = world.minimap();
        ui.minimap(mm.points, mm.bounds, race.mapCars());
      }
    }
    post.render(world.scene, camera, dt);
    drawBubbles();
  } else if (screen !== 'garage' && renderMenu(dt, now / 1000)) {
    audio.engine(0, 0, false); audio.skid(0);
    speedLines.clear(); ui.speedTag?.(null, null, 0);
  } else {
    audio.engine(0, 0, false); audio.skid(0);
    speedLines.clear(); ui.speedTag?.(null, null, 0);
    // Garage showroom with a slow orbit
    orbit += dt * (screen === 'garage' ? 0.25 : 0.15);
    // Portrait phones: pull back and aim below the car so it sits in the gap above the bottom panel
    const portrait = innerWidth < innerHeight;
    const r = screen === 'garage' ? (portrait ? 10.5 : 7.2) : (portrait ? 11 : 8.5);
    showCam.position.set(Math.sin(orbit) * r, portrait ? 3.4 : screen === 'garage' ? 2.2 : 2.6, Math.cos(orbit) * r);
    showCam.lookAt(0, portrait ? (screen === 'garage' ? -2.2 : -1.6) : 0.7, 0);
    if (showCar?.userData.halo) showCar.userData.halo.rotation.y += dt;
    renderer.render(showroom, showCam);
  }
}
let hornHeld = false, hitStopUntil = 0, controlsHints = 0;
// Checkpoint joke bubbles: DOM speech bubbles projected above each car's roof
const bubbleLayer = document.createElement('div');
bubbleLayer.className = 'bubble-layer';
canvas.parentElement.insertBefore(bubbleLayer, canvas.nextSibling);
const bubV = new THREE.Vector3();
function drawBubbles() {
  if (!race) return;
  for (const c of race.cars) {
    const bb = c.bubble;
    if (!bb) continue;
    if (!bb.el) {
      bb.el = document.createElement('div');
      bb.el.className = 'speech-bubble';
      bb.el.textContent = bb.text;
      bubbleLayer.appendChild(bb.el);
    }
    bubV.set(bb.pos.x, bb.pos.y, bb.pos.z).project(camera);
    const vis = bubV.z < 1 && Math.abs(bubV.x) < 1.2 && Math.abs(bubV.y) < 1.2 && screen === 'race';
    bb.el.style.display = vis ? '' : 'none';
    if (!vis) continue;
    const x = (bubV.x + 1) / 2 * innerWidth, y = (1 - bubV.y) / 2 * innerHeight;
    // shrink with distance so far-away bubbles don't clutter the view
    const d = camera.position.distanceTo(bubV.set(bb.pos.x, bb.pos.y, bb.pos.z));
    const sc = Math.max(0.55, Math.min(1, 14 / d)) * bb.pop;
    bb.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%) scale(${sc.toFixed(3)})`;
    bb.el.style.opacity = bb.opacity.toFixed(2);
  }
}
const tagV = new THREE.Vector3(), tagR = new THREE.Vector3();
const speedLines = new SpeedLines(canvas.parentElement, canvas);

// ---------- boot ----------
function boot() {
  ui.setSettings({ ...settings, muted: audio.muted });
  setShowCar(profile.d.selected);
  ui.setPoints(profile.points);
  const unlock = () => { audio.unlock(); removeEventListener('pointerdown', unlock); removeEventListener('keydown', unlock); };
  addEventListener('pointerdown', unlock); addEventListener('keydown', unlock);
  pendingPin = roomFromUrl();
  // Warm up: build the first track once so shaders compile before the player taps start
  ui.show('loading');
  ui.loading?.(0.3, 'Building Vadodara…');
  requestAnimationFrame(t => { last = t; frame(t); });
  setTimeout(() => {
    try { loadTrack(TRACKS[0].id, 'sunset'); renderer.compile(world.scene, camera); } catch (e) { console.warn(e); }
    ui.loading?.(1, 'Ready');
  }, 50);
}
let pendingPin = null;
// Testing hook: open the game with ?debug to inspect the running race from the console
if (new URLSearchParams(location.search).has('debug')) window.__la = { get race() { return race; }, profile, net, post, world, renderer, camera, audio, get weather() { return weather; } };
boot();
