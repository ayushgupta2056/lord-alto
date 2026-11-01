# Lord Alto: module contract

Vanilla JS ES modules, Vite, three@0.170 (`import * as THREE from 'three'`; addons from `three/addons/...`).
No TypeScript, no UI framework. All game data lives in `src/config.js` (read it; do not duplicate data).

## World conventions
- Y is up, ground plane y = 0, units are metres.
- A car's heading is `h` (radians). Forward vector = `(sin h, 0, cos h)`. `group.rotation.y = h`.
- Car models face **+Z** in local space, origin on the ground at the car's centre.
- Art style: bright, warm, stylised low-poly with PBR (`MeshStandardMaterial`), good lighting, soft shadows. It must look good, but run at 60 fps on a mid-range phone at quality `low`.
- `quality` is `'low' | 'medium' | 'high'`.

## src/tracks.js (world agent)
```js
export function buildTrack(def /* entry of TRACKS */) => Track
Track = {
  id, def, N,                    // N samples, 1 m apart, closed loop
  x, z, y: Float32Array(N),      // centreline; y = 0 unless a bridge or hump
  tx, tz: Float32Array(N),       // unit tangent (direction of travel)
  curv: Float32Array(N),         // signed curvature (1/m), smoothed
  length, halfWidth,
  nearest(px, pz, hint = -1) => { index, lateral, dist },  // lateral > 0 = right of travel direction; hint = previous index for an O(window) search
  pointAt(s) => { x, y, z, tx, tz },   // s = metres along the loop (wraps)
  grid(slot) => { x, z, h },           // 8 start slots, 2 per row, behind the start line, facing travel
  landmarks: [{ id, index, side /* -1 left, 1 right */, label }],
  labels: [{ text, index }],
}
```

## src/world.js (world agent)
```js
export class World {
  constructor(renderer)              // creates this.scene
  load(track, { timeOfDay, quality }) // clears and builds road, kerbs, ground, buildings, trees, lamps, landmarks, signboards, sky, lights, fog
  update(dt, focus /* THREE.Vector3 */) // moves the shadow camera / sky with the focus point
  minimap()                          // => { points: [[x,z],...] (~200 pts), bounds:{minX,maxX,minZ,maxZ} }
}
```
Landmark ids that must be modelled: `brightday` (school building with big sign "BRIGHT DAY SCHOOL" and "CBSE", gate, flag), `palace` (Laxmi Vilas Palace: long sandstone facade, domes, clock tower), `sursagar` (lake with a tall golden Shiva statue on a pedestal in the middle), `nyaymandir` (Indo-Saracenic white/red building), `mandvi` (Mandvi Gate: arched gateway that **spans the road** so cars drive through it), `circle` (traffic roundabout island with fountain/statue at the road edge), `mall` (big glass mall), `sayajibaug` (garden trees, toy-train track), `station` (railway station building, "VADODARA JN" sign).
Each track also gets a start/finish gantry ("LORD ALTO • BARODA GRAND PRIX") and roadside signboards for `labels`.

## src/fx.js (world agent)
```js
export class FX {
  constructor(scene, quality)
  smoke(pos, vel, amount)    // drift and tyre smoke
  nitro(pos, dir)            // exhaust flame burst
  sparks(pos, count)         // crash sparks
  dust(pos)                  // off-road
  update(dt)
}
```

## src/carModel.js (car agent)
```js
export function buildCarModel(carId, mods) => THREE.Group
// group.userData = {
//   wheels: [fl, fr, rl, rr],   // Object3D; spin via .rotation.x; front pair steer via parent pivot .rotation.y (use wheelPivots)
//   wheelPivots: [fl, fr],      // set .rotation.y = steer angle
//   body: Object3D,             // tilt via .rotation.z (roll) and .rotation.x (pitch)
//   brakeMat: Material,         // set .emissiveIntensity 0.3..2.5
//   exhaust: Object3D,          // world position used for nitro flames
//   radius: 0.29                // wheel radius in m
// }
export function applyMods(group, mods)  // repaint/re-equip an existing model in place
export function disposeCarModel(group)
```
Mods: `{ paint: '#hex' | null (null = car's default paint), rim, spoiler: 'none'|'lip'|'wing', underglow: '#hex'|null, tint: 0..1, sticker: null|'stripes'|'flames'|'jai_mataji'|'baroda', plate: 'GJ 06 XX 1234' }`.
Models must be recognisable as Alto generations (`shape.gen`): gen1 (2000: tall, boxy, flat nose, square lamps), gen1f (2005: same body, smoother bumper and grille), gen2 (2010–2019: rounder, swept-back headlamps, `facelift` = bigger grille), gen3 (2022: tall, rounded, large lamps, plastic cladding). `legend` = gold chrome paint plus a floating glowing halo ring above the roof. No real manufacturer logos. Rear number plate and front plate show `mods.plate` via a canvas texture.

## src/net.js (net agent) and server/server.mjs
Client:
```js
export class Net {
  constructor()                  // URL: `${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`
  on(event, fn)                  // events listed below
  async create(name, car, mods)  // => room
  async join(pin, name, car, mods) // => room
  leave()
  setCar(car, mods)
  setSettings({ track, laps, timeOfDay })   // host only
  start()                        // host only
  sendState(d)                   // ~15 Hz: { x, z, h, v, steer, nitro, drift, lap, progress }
  crash(victimPid, d)            // d = { power, dir:[x,z] }; server relays to all
  finish(timeMs, bestLapMs)
  get me / get room / get isHost / now()  // now() = server-synced clock in ms
}
// events: 'status' (online|offline|connecting), 'room' (room), 'prepare' ({track,laps,timeOfDay,grid:[pid...],startAt}),
// 'state' (pid, d), 'crash' ({by, victim, d}), 'horn' (pid), 'finish' ({pid,time}), 'results' ([{pid,name,time,place}]),
// 'left' (pid), 'kicked', 'error' (Error with .code)
```
room = `{ pin, host, phase: 'lobby'|'racing', settings:{track,laps,timeOfDay}, players:[{pid,name,car,mods,ready}] }`.
Server: one Node process (`PORT` env, default 8787) that serves `dist/` statically (SPA fallback to index.html, correct MIME types, gzip if easy) **and** WebSocket on `/ws` (package `ws`). 4-digit PIN rooms, max 8, host migration, idle room expiry, message rate limit, ping/pong clock sync, reconnect via `{t:'resume', pin, pid, token}` within 60 s. Vite dev proxies `/ws` to `localhost:8787`. Also write `render.yaml` (one web service: build `npm install && npm run build`, start `npm start`, health check `/healthz`).

## src/input.js, src/audio.js, src/ui.js, index.html, src/style.css (UI agent)
```js
export class Input {
  constructor()
  read() => { steer:-1..1, throttle:0..1, brake:0..1, nitro, drift, horn, pausePressed, respawnPressed }  // keyboard (arrows/WASD, Shift drift, Space nitro, H horn, Esc/P pause, R respawn), gamepad, touch
  setTouch(visible)              // on-screen controls for phones
}
export class GameAudio {
  unlock()                       // call on first user gesture
  setMuted(b); get muted
  engine(speed01, throttle, nitro) // continuous, call every frame
  skid(amount01)                 // continuous
  crash(power01); dhadaak(); horn(); nitroStart(); countdown(final); lapDing(); finish(); click()
}
export class UI {
  constructor(handlers)          // handlers: { onPlay, onTrack(id), onGarage, onCarPrev, onCarNext, onBuyCar, onSelectCar,
                                 //   onMod(key,value), onUpgrade(key), onStart(settings), onMultiplayer, onCreateRoom(name),
                                 //   onJoinRoom(pin,name), onLeaveRoom, onHostSettings(settings), onHostStart, onResume,
                                 //   onRestart, onQuit, onRaceAgain, onSettings(settings), onClaimDaily }
  show(screen)                   // 'loading'|'menu'|'tracks'|'garage'|'mp'|'lobby'|'race'|'pause'|'results'
  setPoints(n)
  setGarage({ car, owned, price, canAfford, mods, upgrades, stats, maxStats, index, total })
  setTracks(tracks, selectedId, settings)
  hud({ place, total, lap, laps, time, best, speedKmh, gear, nitro01, drift, wrongWay })
  minimap(points, bounds, cars /* [{x,z,color,me}] */)
  countdown(n)                   // 3,2,1,0 (=GO "CHALO!"), null hides
  banner(text, kind)             // kind 'dhadaak' = huge comic burst "DHADAAAKK!" with shake; 'info' = small
  toast(text)
  setLobby(room, mePid)
  results(rows /* [{place,name,time,best,points,me}] */, totalPoints)
  daily(offer)                   // {day, points} | null
  setSettings(s)
}
```
Screens are DOM overlays above a full-screen `<canvas id="game">`. Look: warm Gujarati palette (saffron #ff9933, deep indigo #1d1747, marigold #ffc533, palace sandstone #e8c9a0), bold playful display font (Google Fonts, e.g. "Baloo 2" / "Bungee"), big touch targets, safe-area insets, works in phone portrait and landscape and on laptops.
