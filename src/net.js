// Multiplayer client for Lord Alto. Talks to server/server.mjs over WebSocket (/ws), protocol v1.
//
// Usage:
//   const net = new Net();
//   net.on('room', (room) => ui.setLobby(room, net.me));
//   const room = await net.create('Ayush', 'k10gen3', mods);       // or net.join('1234', ...)
//   net.on('prepare', (p) => { if (p.startAt == null) { loadTrack(p.track); net.loaded(); } else countdownTo(p.startAt); });
//
// Race start: 'prepare' fires ONCE per race with { track, laps, timeOfDay, grid, startAt: null }.
// Build the track, then call net.loaded(). When everyone has loaded (or after 8 s) the server schedules the
// green light: the SAME prepare object gets .startAt set (server ms) and a 'go' event fires ({ startAt }).
// (When resuming mid-race, 'prepare' arrives with startAt already set, followed by 'go'.)
// Compare startAt against net.now(), never Date.now().
// Other events: 'finish' ({pid,time} ms), 'results' ({rows:[{pid,name,time,best,place}]}, also iterable as the rows),
// 'state' (pid, d), 'crash' ({by,victim,d}), 'horn' (pid), 'left' (pid, reason), 'kicked', 'error' (Error .code),
// 'status' ('online'|'offline'|'connecting'), 'room' (room | null when you left / lost the seat).

const PROTOCOL_VERSION = 1;
const SEAT_KEY = 'lordalto.seat';
const REQUEST_TIMEOUT_MS = 8000;
const SEAT_TTL_MS = 60_000;          // server keeps a dropped seat this long
const PING_INTERVAL_MS = 2000;
const CLOCK_SAMPLES = 10;
const STATE_MIN_INTERVAL_MS = 1000 / 20; // hard cap on outgoing state rate
const MAX_BUFFERED = 32 * 1024;

const FRIENDLY = {
  timeout: 'The race server is not answering. Check your connection and try again.',
  offline: 'Could not reach the race server. Check your connection and try again.',
  bad_pin: 'Room PINs are 4 digits.',
  no_room: 'No room with that PIN. Check the number with your host.',
  room_full: 'That room is full (8 racers max).',
  in_race: 'That room is mid-race. Try again when the race finishes.',
  not_host: 'Only the host can do that.',
  seat_lost: 'Your seat in the room was lost. Please join again.',
  bad_token: 'Your seat in the room was lost. Please join again.',
  expired: 'The room expired after 30 minutes of inactivity.',
  rate_limited: 'Too many messages. You were disconnected.',
  version: 'Your game is out of date. Please refresh the page.',
  server_full: 'The server is full right now. Try again in a minute.',
  bad_track: 'Unknown track.',
  bad_laps: 'Invalid lap count.',
  bad_time: 'Invalid time of day.',
};

function netError(code, msg) {
  const e = new Error(FRIENDLY[code] || msg || 'Something went wrong.');
  e.code = code;
  if (msg) e.serverMessage = msg;
  return e;
}

const localNow = () =>
  (typeof performance !== 'undefined' && performance.timeOrigin ? performance.timeOrigin + performance.now() : Date.now());

function storage() {
  try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch { return null; }
}

function loadSeat() {
  try {
    const raw = storage()?.getItem(SEAT_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || typeof s.pin !== 'string' || typeof s.pid !== 'string' || typeof s.token !== 'string') return null;
    if (s.at && Date.now() - s.at > SEAT_TTL_MS * 30) return null; // stale (the server will reject anyway)
    return s;
  } catch { return null; }
}

function saveSeat(seat) {
  try {
    if (seat) storage()?.setItem(SEAT_KEY, JSON.stringify({ ...seat, at: Date.now() }));
    else storage()?.removeItem(SEAT_KEY);
  } catch { /* storage blocked: reconnect still works within this page */ }
}

/** Returns the 4-digit PIN from a `?room=1234` deep link, or null. */
export function roomFromUrl(href) {
  try {
    const u = new URL(href || (typeof location !== 'undefined' ? location.href : 'http://x/'));
    const pin = (u.searchParams.get('room') || '').trim();
    return /^\d{4}$/.test(pin) ? pin : null;
  } catch { return null; }
}

/** Shareable deep link for a room PIN, e.g. https://host/?room=1234 */
export function roomLink(pin) {
  if (typeof location === 'undefined') return `?room=${pin}`;
  return `${location.origin}${location.pathname}?room=${encodeURIComponent(pin)}`;
}

/** Removes ?room= from the address bar (after the deep link was consumed). */
export function clearRoomFromUrl() {
  try {
    const u = new URL(location.href);
    if (!u.searchParams.has('room')) return;
    u.searchParams.delete('room');
    history.replaceState(history.state, '', u.pathname + (u.search ? u.search : '') + u.hash);
  } catch { /* ignore */ }
}

export class Net {
  constructor(url) {
    this.url = url || (typeof location !== 'undefined'
      ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
      : 'ws://localhost:8787/ws');
    this.ws = null;
    this.status = 'offline';
    this._handlers = new Map();
    this._room = null;
    this._pid = null;
    this._seat = loadSeat();
    this._pending = new Map(); // rid -> { resolve, reject, timer }
    this._rid = 0;
    this._openPromise = null;
    this._pingTimer = null;
    this._reconnectTimer = null;
    this._reconnectAttempt = 0;
    this._lostAt = 0;
    this._wantOpen = false;      // true while we hold (or are trying to regain) a seat
    this._samples = [];          // [{ rtt, offset }]
    this._offset = 0;            // serverTime ~= localNow() + offset
    this._rtt = 0;
    this._lastState = 0;
    this._lastPrepare = null;

    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => { if (this._wantOpen && this.status !== 'online') this._reconnectSoon(0); });
      document.addEventListener?.('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this._wantOpen && this.status === 'offline') this._reconnectSoon(0);
      });
    }
  }

  // ---- events ------------------------------------------------------------
  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) { this._handlers.get(event)?.delete(fn); }

  _emit(event, ...args) {
    const set = this._handlers.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(...args); } catch (err) { console.error(`[net] '${event}' handler failed`, err); }
    }
  }

  _setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this._emit('status', s);
  }

  // ---- getters -----------------------------------------------------------
  /** My player id (string) or null. */
  get me() { return this._pid; }
  get pid() { return this._pid; }
  /** My player entry from the room ({pid,name,car,mods,ready,online}) or null. */
  get player() { return this._room?.players.find((p) => p.pid === this._pid) || null; }
  get room() { return this._room; }
  get isHost() { return !!this._room && this._room.host === this._pid; }
  get inRoom() { return !!this._room; }
  get online() { return this.status === 'online'; }
  get rtt() { return this._rtt; }
  /** True when a previous seat is stored (e.g. after a page reload) and resume() may succeed. */
  get hasSeat() { return !!this._seat; }
  /** The last 'prepare' payload of the current race (handy after resume). */
  get prepare() { return this._lastPrepare; }
  /** Server-synchronised clock in ms (comparable to prepare.startAt). */
  now() { return localNow() + this._offset; }

  // ---- connection --------------------------------------------------------
  _open() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this._openPromise) return this._openPromise;
    this._setStatus('connecting');
    this._openPromise = new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(this.url); } catch (err) {
        this._openPromise = null;
        this._setStatus('offline');
        reject(netError('offline'));
        return;
      }
      this.ws = ws;
      const timer = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) { try { ws.close(); } catch { /* ignore */ } fail(); }
      }, REQUEST_TIMEOUT_MS);
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._openPromise = null;
        reject(netError('offline'));
      };
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._openPromise = null;
        this._setStatus('online');
        this._startPing();
        resolve();
      };
      ws.onmessage = (ev) => this._onMessage(ev.data);
      ws.onerror = () => { /* onclose follows */ };
      ws.onclose = (ev) => {
        fail();
        if (this.ws === ws) this._onClose(ev);
      };
    });
    return this._openPromise;
  }

  _onClose(ev) {
    this.ws = null;
    this._stopPing();
    this._setStatus('offline');
    for (const [rid, p] of this._pending) { clearTimeout(p.timer); p.reject(netError('offline')); this._pending.delete(rid); }
    // 4001 = seat taken over by another tab/socket; 4008 = rate limit kick: do not fight it.
    if (ev && (ev.code === 4001 || ev.code === 4008)) {
      if (ev.code === 4008) this._dropSeat('rate_limited');
      else this._wantOpen = false;
      return;
    }
    if (this._wantOpen && this._seat) {
      if (!this._lostAt) this._lostAt = Date.now();
      this._reconnectSoon();
    }
  }

  _reconnectSoon(delay) {
    clearTimeout(this._reconnectTimer);
    if (!this._wantOpen || !this._seat) return;
    if (this._lostAt && Date.now() - this._lostAt > SEAT_TTL_MS) { this._dropSeat('seat_lost'); return; }
    const d = delay ?? Math.min(5000, 400 * 2 ** this._reconnectAttempt) * (0.75 + Math.random() * 0.5);
    this._reconnectAttempt++;
    this._setStatus('connecting');
    this._reconnectTimer = setTimeout(async () => {
      try {
        await this._resumeSeat();
        this._reconnectAttempt = 0;
        this._lostAt = 0;
      } catch (err) {
        if (err.code === 'seat_lost' || err.code === 'bad_token' || err.code === 'version') this._dropSeat(err.code);
        else this._reconnectSoon();
      }
    }, d);
  }

  _dropSeat(code) {
    const hadRoom = !!this._room;
    this._wantOpen = false;
    this._seat = null;
    saveSeat(null);
    this._room = null;
    this._pid = null;
    this._lastPrepare = null;
    clearTimeout(this._reconnectTimer);
    if (hadRoom || code) {
      this._emit('room', null);
      if (code) this._emit('error', netError(code));
    }
  }

  _send(msg) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try { ws.send(JSON.stringify(msg)); return true; } catch { return false; }
  }

  _request(msg) {
    const rid = ++this._rid;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._pending.delete(rid); reject(netError('timeout')); }, REQUEST_TIMEOUT_MS);
      this._pending.set(rid, { resolve, reject, timer });
      if (!this._send({ ...msg, v: PROTOCOL_VERSION, rid })) {
        clearTimeout(timer);
        this._pending.delete(rid);
        reject(netError('offline'));
      }
    });
  }

  // ---- clock sync --------------------------------------------------------
  _startPing() {
    this._stopPing();
    this._samples = [];
    const ping = () => this._send({ t: 'ping', c: localNow() });
    ping();
    setTimeout(ping, 250); // a couple of quick samples so now() is good before the first countdown
    setTimeout(ping, 600);
    this._pingTimer = setInterval(ping, PING_INTERVAL_MS);
  }

  _stopPing() { clearInterval(this._pingTimer); this._pingTimer = null; }

  _onPong(m) {
    if (typeof m.c !== 'number' || typeof m.s !== 'number') return;
    const t = localNow();
    const rtt = t - m.c;
    if (rtt < 0 || rtt > 30_000) return;
    this._samples.push({ rtt, offset: m.s + rtt / 2 - t });
    if (this._samples.length > CLOCK_SAMPLES) this._samples.shift();
    // Use the best-RTT samples (least queueing delay) for the offset estimate.
    const best = [...this._samples].sort((a, b) => a.rtt - b.rtt).slice(0, 3);
    this._offset = best.reduce((acc, s) => acc + s.offset, 0) / best.length;
    this._rtt = best[0].rtt;
  }

  // ---- inbound -----------------------------------------------------------
  _onMessage(raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const pending = m.rid !== undefined ? this._pending.get(m.rid) : null;
    switch (m.t) {
      case 'pong': this._onPong(m); break;
      case 'welcome': {
        this._pid = m.pid;
        this._room = m.room;
        this._seat = { pin: m.room.pin, pid: m.pid, token: m.token };
        this._wantOpen = true;
        saveSeat(this._seat);
        if (pending) { clearTimeout(pending.timer); this._pending.delete(m.rid); pending.resolve(m.room); }
        if (m.room.phase === 'lobby') this._lastPrepare = null;
        if (this._avatar) this._send({ t: 'avatar', data: this._avatar });
        this._emit('room', m.room);
        break;
      }
      case 'room':
        this._room = m.room;
        if (m.room.phase === 'lobby') this._lastPrepare = null;
        this._emit('room', m.room);
        break;
      case 'err': {
        const err = netError(m.code, m.msg);
        if (pending) { clearTimeout(pending.timer); this._pending.delete(m.rid); pending.reject(err); }
        else if (m.code === 'expired') this._dropSeat('expired');
        else this._emit('error', err);
        break;
      }
      case 'prepare': {
        const startAt = m.startAt ?? null;
        const cur = this._lastPrepare;
        if (cur && cur.startAt === null && startAt !== null && cur.track === m.track) {
          // Same race, green light now scheduled: update the object main.js already holds, no second 'prepare'.
          cur.startAt = startAt;
          this._emit('go', { startAt });
          break;
        }
        const p = { track: m.track, laps: m.laps, timeOfDay: m.timeOfDay, grid: m.grid || [], startAt };
        this._lastPrepare = p;
        this._emit('prepare', p);
        if (startAt !== null) this._emit('go', { startAt });
        break;
      }
      case 's': this._emit('state', m.p, m.d); break;
      case 'S': // batched room states: [[pid, d], ...] (includes our own, which we skip)
        if (Array.isArray(m.l)) for (const e of m.l) if (Array.isArray(e) && e[0] !== this._pid) this._emit('state', e[0], e[1]);
        break;
      case 'avatar': this._emit('avatar', m.p, m.data ?? null); break;
      case 'crash': this._emit('crash', { by: m.by, victim: m.victim, d: m.d || {} }); break;
      case 'horn': this._emit('horn', m.p); break;
      case 'finish': this._emit('finish', { pid: m.p, time: m.time }); break;
      case 'results': {
        // Payload is { rows: [{pid,name,time,best,place}] }; it is also an array of the rows, so both
        // `payload.rows` and `payload.forEach(...)` work.
        const rows = Array.isArray(m.rows) ? m.rows : [];
        const payload = Object.assign([...rows], { rows });
        this._lastPrepare = null;
        this._emit('results', payload);
        break;
      }
      case 'left': this._emit('left', m.p, m.reason); break;
      case 'kicked':
        this._wantOpen = false;
        this._seat = null;
        saveSeat(null);
        this._room = null;
        this._pid = null;
        this._lastPrepare = null;
        this._emit('kicked');
        this._emit('room', null);
        break;
      default: break;
    }
  }

  // ---- public API --------------------------------------------------------
  /** Create a room; resolves with the room. Rejects with an Error (.code, friendly .message). */
  async create(name, car, mods) {
    await this._open();
    return this._request({ t: 'create', name, car, mods });
  }

  /** Join a room by 4-digit PIN; resolves with the room. */
  async join(pin, name, car, mods) {
    const p = String(pin ?? '').trim();
    if (!/^\d{4}$/.test(p)) throw netError('bad_pin');
    await this._open();
    return this._request({ t: 'join', pin: p, name, car, mods });
  }

  /** Re-take the seat stored in sessionStorage (e.g. after a reload). Resolves with the room, or null if there is no seat. */
  async resume() {
    if (!this._seat) return null;
    this._wantOpen = true;
    try {
      return await this._resumeSeat();
    } catch (err) {
      if (err.code === 'seat_lost' || err.code === 'bad_token') { this._dropSeat(null); }
      throw err;
    }
  }

  async _resumeSeat() {
    const seat = this._seat;
    if (!seat) throw netError('seat_lost');
    await this._open();
    return this._request({ t: 'resume', pin: seat.pin, pid: seat.pid, token: seat.token });
  }

  leave() {
    this._send({ t: 'leave' });
    this._wantOpen = false;
    this._seat = null;
    saveSeat(null);
    const had = !!this._room;
    this._room = null;
    this._pid = null;
    this._lastPrepare = null;
    clearTimeout(this._reconnectTimer);
    if (had) this._emit('room', null);
  }

  /** Fully close the socket (e.g. when leaving multiplayer). */
  disconnect() {
    this.leave();
    const ws = this.ws;
    this.ws = null;
    this._stopPing();
    if (ws) { try { ws.close(1000, 'bye'); } catch { /* ignore */ } }
    this._setStatus('offline');
  }

  setCar(car, mods) { this._send({ t: 'car', car, mods }); }

  /** Host only. Any subset of { track, laps, timeOfDay }. */
  setSettings(settings) {
    const s = {};
    if (settings?.track !== undefined) s.track = settings.track;
    if (settings?.laps !== undefined) s.laps = settings.laps;
    if (settings?.timeOfDay !== undefined) s.timeOfDay = settings.timeOfDay;
    this._send({ t: 'settings', ...s });
  }

  /** Host only. */
  start() { this._send({ t: 'start' }); }

  /** Call once the track from the first 'prepare' (startAt === null) is built and ready to race. */
  loaded() { this._send({ t: 'loaded' }); }

  /** ~15 Hz: { x, z, h, v, steer, nitro, drift, lap, progress }. Dropped when the socket is backed up. */
  sendState(d) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this._room) return false;
    if (ws.bufferedAmount > MAX_BUFFERED) return false;
    const t = localNow();
    if (t - this._lastState < STATE_MIN_INTERVAL_MS) return false;
    this._lastState = t;
    return this._send({ t: 's', d });
  }

  /** d = { power, dir:[x,z] }; the server relays it to everyone (including you) as a 'crash' event. */
  crash(victimPid, d) { this._send({ t: 'crash', victim: victimPid, d }); }

  horn() { this._send({ t: 'horn' }); }

  /** Share a small selfie (JPEG data URL, ≤ 14 KB) with the room, or null to remove it. Re-sent automatically after (re)joining. */
  setAvatar(dataUrl) {
    this._avatar = dataUrl || null;
    if (this._room) this._send({ t: 'avatar', data: this._avatar });
  }

  finish(timeMs, bestLapMs) { this._send({ t: 'finish', time: timeMs, best: bestLapMs }); }

  /** Host only. */
  kick(pid) { this._send({ t: 'kick', pid }); }
}

export default Net;
