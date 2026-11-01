// Lord Alto: Baroda Grand Prix - game server.
// One Node process: static file server for ./dist + WebSocket rooms on /ws.
// Protocol: JSON messages {t: ...}, version 1. See CONTRACT.md (net.js section).

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { TRACKS, LAPS, TIMES, CARS, DEFAULT_MODS, SPOILERS, STICKERS, MAX_RACERS } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '..', 'dist'));
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';

const PROTOCOL_VERSION = 1;
const MAX_PLAYERS = Math.min(8, MAX_RACERS || 8);
const MAX_MSG_BYTES = 4096;
const MAX_AVATAR_BYTES = 14_000;   // small JPEG selfie as a data URL (only the 'avatar' message may be this big)
const STATE_TICK_MS = 50;          // car states are batched and sent to each room at 20 Hz
const RATE_PER_SEC = 40;          // token bucket refill rate
const RATE_BURST = 60;            // bucket size
const ABUSE_DROPS = 400;          // dropped msgs within ABUSE_WINDOW -> kick
const ABUSE_WINDOW_MS = 10_000;
const SEAT_HOLD_MS = 60_000;      // disconnected players keep their seat this long
const ROOM_IDLE_MS = 30 * 60_000; // idle rooms expire
const HEARTBEAT_MS = 15_000;
const LOAD_TIMEOUT_MS = 8_000;    // max wait for everyone to load the track
const COUNTDOWN_MS = 4_500;       // startAt = now + this once everyone is loaded
const RESULTS_AFTER_FIRST_MS = 60_000;
const RACE_MAX_MS = 25 * 60_000;  // hard cap so a stuck race can't hold a room forever
const MAX_CONNECTIONS = 4000;

const TRACK_IDS = new Set(TRACKS.map((t) => t.id));
const CAR_IDS = new Set(CARS.map((c) => c.id));
const LAP_SET = new Set(LAPS);
const TIME_SET = new Set(TIMES);
const SPOILER_SET = new Set(SPOILERS);
const STICKER_SET = new Set(STICKERS);

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const isHex = (s) => typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

function sanitizeName(name, fallback) {
  let s = typeof name === 'string' ? name : '';
  s = s.normalize('NFC')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/[<>&"'`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  s = Array.from(s).slice(0, 16).join('').trim();
  return s || fallback;
}

function sanitizeCar(car) {
  return CAR_IDS.has(car) ? car : CARS[0].id;
}

function sanitizeMods(m) {
  const out = { ...DEFAULT_MODS };
  if (!isObj(m)) return out;
  if (m.paint === null || isHex(m.paint)) out.paint = m.paint;
  if (isHex(m.rim)) out.rim = m.rim;
  if (SPOILER_SET.has(m.spoiler)) out.spoiler = m.spoiler;
  if (m.underglow === null || isHex(m.underglow)) out.underglow = m.underglow;
  if (finite(m.tint)) out.tint = Math.max(0, Math.min(1, Math.round(m.tint * 100) / 100));
  if (STICKER_SET.has(m.sticker)) out.sticker = m.sticker;
  if (typeof m.plate === 'string') {
    const p = m.plate.toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 13);
    if (p) out.plate = p;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------
/** @type {Map<string, Room>} */
const rooms = new Map();
let connCount = 0;

const randId = (bytes = 5) => crypto.randomBytes(bytes).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8);
const randToken = () => crypto.randomBytes(18).toString('base64url');

function newPin() {
  for (let i = 0; i < 200; i++) {
    const pin = String(crypto.randomInt(1000, 10000));
    if (!rooms.has(pin)) return pin;
  }
  for (let n = 1000; n < 10000; n++) if (!rooms.has(String(n))) return String(n);
  return null;
}

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

function sendErr(ws, code, msg, rid) {
  const m = { t: 'err', code, msg };
  if (rid !== undefined) m.rid = rid;
  send(ws, m);
}

class Room {
  constructor(pin) {
    this.pin = pin;
    this.host = null;
    this.phase = 'lobby';
    this.settings = { track: TRACKS[0].id, laps: LAPS.includes(3) ? 3 : LAPS[0], timeOfDay: TRACKS[0].timeOfDay || TIMES[0] };
    /** @type {Map<string, Player>} insertion order = join order */
    this.players = new Map();
    this.race = null;
    this.lastActivity = Date.now();
    this.created = Date.now();
  }

  touch() { this.lastActivity = Date.now(); }

  view() {
    return {
      pin: this.pin,
      host: this.host,
      phase: this.phase,
      max: MAX_PLAYERS,
      settings: { ...this.settings },
      players: [...this.players.values()].map((p) => ({
        pid: p.pid, name: p.name, car: p.car, mods: p.mods, ready: p.ready, online: !!p.ws,
      })),
    };
  }

  broadcast(msg, exceptPid = null) {
    const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
    for (const p of this.players.values()) if (p.pid !== exceptPid) send(p.ws, data);
  }

  broadcastRoom() { this.broadcast({ t: 'room', room: this.view() }); }

  pickHost() {
    if (this.host && this.players.has(this.host)) return;
    const list = [...this.players.values()];
    const next = list.find((p) => p.ws) || list[0];
    this.host = next ? next.pid : null;
  }

  clearRaceTimers() {
    const r = this.race;
    if (!r) return;
    clearTimeout(r.loadTimer); clearTimeout(r.resultsTimer); clearTimeout(r.capTimer);
  }

  destroy() {
    this.clearRaceTimers();
    for (const p of this.players.values()) clearTimeout(p.dropTimer);
    rooms.delete(this.pin);
  }
}

class Player {
  constructor(pid, name, car, mods) {
    this.pid = pid;
    this.token = randToken();
    this.name = name;
    this.car = car;
    this.mods = mods;
    this.ready = false;
    this.ws = null;
    this.dropTimer = null;
    this.lastHorn = 0;
    this.avatar = null;    // selfie data URL, kept in memory only and dropped with the seat
    this.lastAvatar = 0;
    this.pendingState = null;
  }
}

// Send every avatar already in the room to one (new or resumed) socket.
function sendAvatars(ws, room, except) {
  for (const p of room.players.values()) if (p.avatar && p !== except) send(ws, { t: 'avatar', p: p.pid, data: p.avatar });
}

function attach(ws, room, player) {
  if (player.ws && player.ws !== ws) {
    // A stale socket still holds this seat; detach it quietly.
    const old = player.ws;
    old.seat = null;
    try { old.close(4001, 'replaced'); } catch { /* ignore */ }
  }
  clearTimeout(player.dropTimer);
  player.dropTimer = null;
  player.ws = ws;
  ws.seat = { room, player };
}

function removePlayer(room, pid, reason) {
  const p = room.players.get(pid);
  if (!p) return;
  clearTimeout(p.dropTimer);
  if (p.ws && p.ws.seat && p.ws.seat.player === p) p.ws.seat = null;
  room.players.delete(pid);
  if (room.players.size === 0) {
    room.destroy();
    log(`room ${room.pin} closed (empty)`);
    return;
  }
  if (room.host === pid) room.host = null;
  room.pickHost();
  room.broadcast({ t: 'left', p: pid, reason });
  if (room.race) {
    const e = room.race.entries.get(pid);
    if (e && !e.finished) e.retired = true;
    checkLoaded(room);
    checkRaceDone(room);
  }
  room.broadcastRoom();
}

// ---------------------------------------------------------------------------
// Race flow:  start -> prepare{startAt:null} (clients load track, send 'loaded')
//             all loaded / 8 s -> prepare{startAt} (countdown) -> finish... -> results -> lobby
// ---------------------------------------------------------------------------
function startRace(room) {
  room.phase = 'racing';
  const grid = [...room.players.values()].map((p) => p.pid);
  const entries = new Map();
  for (const p of room.players.values()) {
    p.ready = false;
    entries.set(p.pid, { pid: p.pid, name: p.name, finished: false, retired: false, time: null, best: null, loaded: false });
  }
  room.race = {
    track: room.settings.track,
    laps: room.settings.laps,
    timeOfDay: room.settings.timeOfDay,
    grid,
    entries,
    startAt: null,
    firstFinishAt: null,
    loadTimer: setTimeout(() => goCountdown(room), LOAD_TIMEOUT_MS),
    resultsTimer: null,
    capTimer: setTimeout(() => finishRace(room, 'timeout'), RACE_MAX_MS),
  };
  room.broadcastRoom();
  room.broadcast(prepareMsg(room));
  log(`room ${room.pin} race start: ${room.race.track} x${room.race.laps}, ${grid.length} cars`);
}

function prepareMsg(room) {
  const r = room.race;
  return { t: 'prepare', track: r.track, laps: r.laps, timeOfDay: r.timeOfDay, grid: r.grid, startAt: r.startAt };
}

function checkLoaded(room) {
  const r = room.race;
  if (!r || r.startAt) return;
  for (const p of room.players.values()) {
    const e = r.entries.get(p.pid);
    if (p.ws && e && !e.loaded) return;
  }
  goCountdown(room);
}

function goCountdown(room) {
  const r = room.race;
  if (!r || r.startAt || rooms.get(room.pin) !== room) return;
  clearTimeout(r.loadTimer);
  r.startAt = Date.now() + COUNTDOWN_MS;
  room.broadcast(prepareMsg(room));
}

function checkRaceDone(room) {
  const r = room.race;
  if (!r) return;
  let online = 0;
  for (const e of r.entries.values()) {
    const p = room.players.get(e.pid);
    if (p && p.ws) online++;
    if (e.finished || e.retired) continue;
    if (p && p.ws) return; // an online racer is still driving
  }
  // If everyone is momentarily offline (network blip), wait for resumes / seat timeouts.
  if (online === 0) return;
  finishRace(room, 'done');
}

function finishRace(room, why) {
  const r = room.race;
  if (!r || rooms.get(room.pin) !== room) return;
  room.clearRaceTimers();
  const all = [...r.entries.values()];
  const fin = all.filter((e) => e.finished).sort((a, b) => a.time - b.time);
  const dnf = all.filter((e) => !e.finished);
  const rows = [...fin, ...dnf].map((e, i) => ({
    pid: e.pid, name: e.name, time: e.finished ? e.time : null, best: e.best, place: i + 1,
  }));
  room.race = null;
  room.phase = 'lobby';
  for (const p of room.players.values()) p.ready = false;
  room.broadcast({ t: 'results', rows });
  room.broadcastRoom();
  log(`room ${room.pin} race over (${why})`);
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------
function leaveCurrent(ws, reason = 'left') {
  const seat = ws.seat;
  if (!seat) return;
  ws.seat = null;
  if (seat.player.ws === ws) seat.player.ws = null;
  removePlayer(seat.room, seat.player.pid, reason);
}

function welcome(ws, room, player, rid) {
  const m = { t: 'welcome', v: PROTOCOL_VERSION, pid: player.pid, token: player.token, room: room.view(), s: Date.now() };
  if (rid !== undefined) m.rid = rid;
  send(ws, m);
}

const handlers = {
  ping(ws, m) {
    send(ws, { t: 'pong', c: finite(m.c) ? m.c : 0, s: Date.now() });
  },

  create(ws, m, rid) {
    leaveCurrent(ws);
    const pin = newPin();
    if (!pin) return sendErr(ws, 'server_full', 'The server is full right now. Try again in a minute.', rid);
    const room = new Room(pin);
    rooms.set(pin, room);
    const player = new Player(randId(), sanitizeName(m.name, 'Racer 1'), sanitizeCar(m.car), sanitizeMods(m.mods));
    room.players.set(player.pid, player);
    room.host = player.pid;
    attach(ws, room, player);
    welcome(ws, room, player, rid);
    log(`room ${pin} created by ${player.name}`);
  },

  join(ws, m, rid) {
    const pin = typeof m.pin === 'string' || typeof m.pin === 'number' ? String(m.pin).trim() : '';
    if (!/^\d{4}$/.test(pin)) return sendErr(ws, 'bad_pin', 'Room PINs are 4 digits.', rid);
    const room = rooms.get(pin);
    if (!room) return sendErr(ws, 'no_room', `No room with PIN ${pin}.`, rid);
    if (ws.seat && ws.seat.room === room) return welcome(ws, room, ws.seat.player, rid);
    if (room.players.size >= MAX_PLAYERS) return sendErr(ws, 'room_full', 'That room is full (8 racers).', rid);
    if (room.phase !== 'lobby') return sendErr(ws, 'in_race', 'That room is mid-race. Try again when it finishes.', rid);
    leaveCurrent(ws);
    const player = new Player(randId(), sanitizeName(m.name, `Racer ${room.players.size + 1}`), sanitizeCar(m.car), sanitizeMods(m.mods));
    room.players.set(player.pid, player);
    attach(ws, room, player);
    room.touch();
    welcome(ws, room, player, rid);
    sendAvatars(ws, room, player);
    room.broadcastRoom();
  },

  resume(ws, m, rid) {
    const room = rooms.get(String(m.pin ?? ''));
    const player = room && typeof m.pid === 'string' ? room.players.get(m.pid) : null;
    if (!room || !player) return sendErr(ws, 'seat_lost', 'Your seat in that room is gone.', rid);
    if (typeof m.token !== 'string' || m.token.length !== player.token.length ||
        !crypto.timingSafeEqual(Buffer.from(m.token), Buffer.from(player.token))) {
      return sendErr(ws, 'bad_token', 'Could not resume that seat.', rid);
    }
    if (ws.seat && ws.seat.player !== player) leaveCurrent(ws);
    attach(ws, room, player);
    room.touch();
    room.pickHost();
    welcome(ws, room, player, rid);
    sendAvatars(ws, room, player);
    if (room.race) send(ws, prepareMsg(room));
    room.broadcastRoom();
  },

  leave(ws) {
    leaveCurrent(ws, 'left');
  },

  car(ws, m, rid, room, player) {
    if (room.phase !== 'lobby') return;
    player.car = sanitizeCar(m.car);
    player.mods = sanitizeMods(m.mods);
    room.broadcastRoom();
  },

  settings(ws, m, rid, room, player) {
    if (room.host !== player.pid) return sendErr(ws, 'not_host', 'Only the host can change race settings.', rid);
    if (room.phase !== 'lobby') return;
    const s = isObj(m.settings) ? m.settings : m;
    if (s.track !== undefined) {
      if (!TRACK_IDS.has(s.track)) return sendErr(ws, 'bad_track', 'Unknown track.', rid);
      room.settings.track = s.track;
    }
    if (s.laps !== undefined) {
      const laps = Number(s.laps);
      if (!LAP_SET.has(laps)) return sendErr(ws, 'bad_laps', 'Invalid lap count.', rid);
      room.settings.laps = laps;
    }
    if (s.timeOfDay !== undefined) {
      if (!TIME_SET.has(s.timeOfDay)) return sendErr(ws, 'bad_time', 'Invalid time of day.', rid);
      room.settings.timeOfDay = s.timeOfDay;
    }
    room.broadcastRoom();
  },

  start(ws, m, rid, room, player) {
    if (room.host !== player.pid) return sendErr(ws, 'not_host', 'Only the host can start the race.', rid);
    if (room.phase !== 'lobby') return sendErr(ws, 'in_race', 'The race has already started.', rid);
    startRace(room);
  },

  loaded(ws, m, rid, room, player) {
    const r = room.race;
    if (!r) return;
    const e = r.entries.get(player.pid);
    if (!e || e.loaded) return;
    e.loaded = true;
    player.ready = true;
    room.broadcastRoom();
    checkLoaded(room);
  },

  s(ws, m, rid, room, player) {
    if (room.phase !== 'racing' || !isObj(m.d)) return;
    // Keep only the latest state; flushStates() batches the whole room into one message per tick,
    // so 8 racers cost each phone 20 messages/s instead of ~100.
    player.pendingState = m.d;
    room.stateDirty = true;
  },

  avatar(ws, m, rid, room, player) {
    const now = Date.now();
    if (now - player.lastAvatar < 2000) return; // no spamming photos
    player.lastAvatar = now;
    const data = m.data;
    if (data === null) { player.avatar = null; room.broadcast({ t: 'avatar', p: player.pid, data: null }, player.pid); return; }
    if (typeof data !== 'string' || data.length > MAX_AVATAR_BYTES || !/^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/=]+$/.test(data)) {
      return sendErr(ws, 'bad_avatar', 'That photo could not be used.', rid);
    }
    player.avatar = data;
    room.broadcast({ t: 'avatar', p: player.pid, data }, player.pid);
  },

  crash(ws, m, rid, room, player) {
    if (room.phase !== 'racing') return;
    if (typeof m.victim !== 'string' || !room.players.has(m.victim) || m.victim === player.pid) return;
    const d = isObj(m.d) ? m.d : {};
    const out = { power: finite(d.power) ? Math.max(0, Math.min(1e4, d.power)) : 0 };
    if (Array.isArray(d.dir) && d.dir.length === 2 && finite(d.dir[0]) && finite(d.dir[1])) out.dir = [d.dir[0], d.dir[1]];
    for (const k of Object.keys(d)) {
      if (!(k in out) && (finite(d[k]) || typeof d[k] === 'boolean')) out[k] = d[k];
    }
    room.broadcast({ t: 'crash', by: player.pid, victim: m.victim, d: out });
  },

  horn(ws, m, rid, room, player) {
    const now = Date.now();
    if (now - player.lastHorn < 250) return;
    player.lastHorn = now;
    room.broadcast({ t: 'horn', p: player.pid }, player.pid);
  },

  finish(ws, m, rid, room, player) {
    const r = room.race;
    if (!r || !r.startAt) return;
    const e = r.entries.get(player.pid);
    if (!e || e.finished) return;
    const elapsed = Date.now() - r.startAt;
    let time = finite(m.time) ? Math.round(m.time) : elapsed;
    if (time <= 0 || time > elapsed + 3000) time = Math.max(1, elapsed); // don't trust impossible times
    e.finished = true;
    e.retired = false;
    e.time = time;
    e.best = finite(m.best) && m.best > 0 && m.best <= time ? Math.round(m.best) : null;
    room.broadcast({ t: 'finish', p: player.pid, time });
    if (!r.firstFinishAt) {
      r.firstFinishAt = Date.now();
      r.resultsTimer = setTimeout(() => finishRace(room, 'cutoff'), RESULTS_AFTER_FIRST_MS);
    }
    checkRaceDone(room);
  },

  kick(ws, m, rid, room, player) {
    if (room.host !== player.pid) return sendErr(ws, 'not_host', 'Only the host can remove players.', rid);
    if (typeof m.pid !== 'string' || m.pid === player.pid) return;
    const target = room.players.get(m.pid);
    if (!target) return;
    const tws = target.ws;
    if (tws) { send(tws, { t: 'kicked' }); tws.seat = null; }
    target.ws = null;
    removePlayer(room, target.pid, 'kicked');
  },
};

const NEEDS_ROOM = new Set(['car', 'settings', 'start', 'loaded', 's', 'crash', 'horn', 'finish', 'kick', 'avatar']);

function flushStates() {
  for (const room of rooms.values()) {
    if (!room.stateDirty || room.phase !== 'racing') continue;
    room.stateDirty = false;
    const l = [];
    for (const p of room.players.values()) if (p.pendingState) { l.push([p.pid, p.pendingState]); p.pendingState = null; }
    if (!l.length) continue;
    const data = JSON.stringify({ t: 'S', l });
    for (const p of room.players.values()) {
      // State is disposable: skip receivers with a backed-up socket (slow phone / bad network).
      if (p.ws && p.ws.readyState === WebSocket.OPEN && p.ws.bufferedAmount < 128 * 1024) p.ws.send(data);
    }
  }
}
const stateTicker = setInterval(flushStates, STATE_TICK_MS);

function onMessage(ws, raw, isBinary) {
  // Rate limiting (token bucket); excess is dropped, sustained abuse is kicked.
  const now = Date.now();
  const b = ws.bucket;
  b.tokens = Math.min(RATE_BURST, b.tokens + ((now - b.last) / 1000) * RATE_PER_SEC);
  b.last = now;
  if (b.tokens < 1) {
    if (now - b.windowStart > ABUSE_WINDOW_MS) { b.windowStart = now; b.drops = 0; }
    if (++b.drops > ABUSE_DROPS) {
      sendErr(ws, 'rate_limited', 'Too many messages - disconnected.');
      ws.close(4008, 'rate limit');
    }
    return;
  }
  b.tokens -= 1;

  if (isBinary || raw.length > MAX_AVATAR_BYTES + 200) return;
  let m;
  try { m = JSON.parse(raw.toString('utf8')); } catch { b.tokens -= 5; return; }
  if (!isObj(m) || typeof m.t !== 'string') return;
  if (m.t !== 'avatar' && raw.length > MAX_MSG_BYTES) return;
  if (m.v !== undefined && m.v !== PROTOCOL_VERSION) {
    return sendErr(ws, 'version', 'Your game is out of date - please refresh the page.', m.rid);
  }
  const h = Object.prototype.hasOwnProperty.call(handlers, m.t) ? handlers[m.t] : null;
  if (!h) return;
  const rid = finite(m.rid) || (typeof m.rid === 'string' && m.rid.length <= 16) ? m.rid : undefined;
  ws.isAlive = true;
  if (NEEDS_ROOM.has(m.t)) {
    const seat = ws.seat;
    if (!seat || rooms.get(seat.room.pin) !== seat.room) return sendErr(ws, 'no_room', 'You are not in a room.', rid);
    if (m.t !== 's') seat.room.touch();
    else seat.room.lastActivity = now;
    try { h(ws, m, rid, seat.room, seat.player); } catch (err) { log('handler error', m.t, err); }
  } else {
    try { h(ws, m, rid); } catch (err) { log('handler error', m.t, err); }
  }
}

function onClose(ws) {
  connCount--;
  const seat = ws.seat;
  ws.seat = null;
  if (!seat) return;
  const { room, player } = seat;
  if (player.ws !== ws) return;
  player.ws = null;
  if (rooms.get(room.pin) !== room) return;
  // Keep the seat for SEAT_HOLD_MS so the client can resume.
  player.dropTimer = setTimeout(() => {
    if (!player.ws && room.players.get(player.pid) === player) removePlayer(room, player.pid, 'timeout');
  }, SEAT_HOLD_MS);
  if (room.race) { checkLoaded(room); checkRaceDone(room); }
  if (rooms.get(room.pin) === room) room.broadcastRoom();
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.map', '.webmanifest', '.svg', '.txt', '.xml', '.gltf', '.ico', '.wasm']);
const gzCache = new Map(); // filePath -> { mtimeMs, buf }

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

async function resolveStatic(urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch { return { status: 400 }; }
  if (rel.includes('\0')) return { status: 400 };
  rel = rel.replace(/\\/g, '/');
  const full = path.resolve(DIST, '.' + path.posix.normalize('/' + rel));
  if (full !== DIST && !full.startsWith(DIST + path.sep)) return { status: 403 };
  try {
    const st = await fsp.stat(full);
    if (st.isFile()) return { file: full, st };
    if (st.isDirectory()) {
      const idx = path.join(full, 'index.html');
      const st2 = await fsp.stat(idx).catch(() => null);
      if (st2 && st2.isFile()) return { file: idx, st: st2 };
    }
  } catch { /* not found */ }
  return { status: 404 };
}

async function serveFile(req, res, file, st, { status = 200 } = {}) {
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const rel = path.relative(DIST, file).replace(/\\/g, '/');
  securityHeaders(res);
  res.setHeader('Content-Type', type);
  if (ext === '.html') res.setHeader('Cache-Control', 'no-cache');
  else if (rel.startsWith('assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  else res.setHeader('Cache-Control', 'public, max-age=3600');
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', new Date(st.mtimeMs).toUTCString());
  if (status === 200 && req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }

  const wantsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  if (COMPRESSIBLE.has(ext) && st.size > 1024 && st.size < 20 * 1024 * 1024) {
    res.setHeader('Vary', 'Accept-Encoding');
    if (wantsGzip) {
      let c = gzCache.get(file);
      if (!c || c.mtimeMs !== st.mtimeMs) {
        const buf = await fsp.readFile(file);
        c = { mtimeMs: st.mtimeMs, buf: zlib.gzipSync(buf, { level: 9 }) };
        gzCache.set(file, c);
      }
      res.writeHead(status, { 'Content-Encoding': 'gzip', 'Content-Length': c.buf.length });
      return res.end(req.method === 'HEAD' ? undefined : c.buf);
    }
  }
  res.writeHead(status, { 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

function plain(res, status, text, extra = {}) {
  securityHeaders(res);
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(text);
}

async function onRequest(req, res) {
  try {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname === '/healthz') return plain(res, 200, 'ok');
    if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    if (url.pathname === '/ws') return plain(res, 426, 'Upgrade required', { Upgrade: 'websocket' });

    const r = await resolveStatic(url.pathname);
    if (r.file) return serveFile(req, res, r.file, r.st);
    if (r.status === 400 || r.status === 403) return plain(res, r.status, r.status === 400 ? 'Bad request' : 'Forbidden');

    // SPA fallback: routes without a file extension (and not under /assets) get index.html.
    const ext = path.posix.extname(url.pathname);
    if (!ext && !url.pathname.startsWith('/assets/')) {
      const idx = path.join(DIST, 'index.html');
      const st = await fsp.stat(idx).catch(() => null);
      if (st) return serveFile(req, res, idx, st);
      return plain(res, 503, 'Game not built yet - run "npm run build".');
    }
    return plain(res, 404, 'Not found');
  } catch (err) {
    log('http error', err);
    if (!res.headersSent) plain(res, 500, 'Server error'); else res.destroy();
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
const server = http.createServer(onRequest);
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_AVATAR_BYTES + 512, perMessageDeflate: false, clientTracking: true });

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url || '/', 'http://x').pathname; } catch { /* bad url */ }
  if (pathname !== '/ws' || connCount >= MAX_CONNECTIONS) {
    socket.write(`HTTP/1.1 ${pathname !== '/ws' ? '404 Not Found' : '503 Service Unavailable'}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  connCount++;
  ws.isAlive = true;
  ws.seat = null;
  ws.bucket = { tokens: RATE_BURST, last: Date.now(), drops: 0, windowStart: Date.now() };
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data, isBinary) => onMessage(ws, data, isBinary));
  ws.on('close', () => onClose(ws));
  ws.on('error', () => { /* close follows */ });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, HEARTBEAT_MS);

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    if (now - room.lastActivity > ROOM_IDLE_MS) {
      for (const p of room.players.values()) {
        if (p.ws) { sendErr(p.ws, 'expired', 'This room expired after 30 minutes of inactivity.'); p.ws.seat = null; }
      }
      room.destroy();
      log(`room ${room.pin} expired`);
    }
  }
}, 60_000);

server.listen(PORT, HOST, () => {
  log(`Lord Alto server on http://${HOST}:${PORT}  (static: ${DIST}${fs.existsSync(DIST) ? '' : ' - not built'}, ws: /ws)`);
});

function shutdown() {
  clearInterval(heartbeat);
  clearInterval(sweeper);
  clearInterval(stateTicker);
  for (const ws of wss.clients) { try { ws.close(1001, 'server restarting'); } catch { /* ignore */ } }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
