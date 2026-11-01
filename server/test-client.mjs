// Smoke test for server/server.mjs. Start the server first (npm run server), then:
//   node server/test-client.mjs [ws://localhost:8787/ws]
import http from 'node:http';
import WebSocket from 'ws';

const WS_URL = process.argv[2] || process.env.WS_URL || 'ws://localhost:8787/ws';
const HTTP_URL = WS_URL.replace(/^ws/, 'http').replace(/\/ws$/, '');

let failures = 0;
function report(name, ok, extra = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
}
async function step(name, fn) {
  try {
    const extra = await fn();
    report(name, true, typeof extra === 'string' ? extra : '');
  } catch (err) {
    report(name, false, err && err.message ? err.message : String(err));
  }
}
const assert = (c, msg) => { if (!c) throw new Error(msg || 'assertion failed'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(label) {
    this.label = label;
    this.msgs = [];
    this.waiters = [];
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_URL);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        this.msgs.push(m);
        for (const w of [...this.waiters]) {
          if (w.pred(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(m); }
        }
      });
      this.ws.on('close', (code) => { this.closed = code; });
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  /** Wait for a message matching pred (checks already-received messages first, consuming them). */
  wait(pred, ms = 3000, what = 'message') {
    if (typeof pred === 'string') { const t = pred; what = t; pred = (m) => m.t === t; }
    const i = this.msgs.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.msgs.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve: (m) => { const k = this.msgs.indexOf(m); if (k >= 0) this.msgs.splice(k, 1); resolve(m); } };
      w.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`${this.label}: timed out waiting for ${what}`));
      }, ms);
      this.waiters.push(w);
    });
  }
  /** Resolves true if no matching message arrives within ms. */
  async none(pred, ms = 400) {
    await sleep(ms);
    return !this.msgs.some(pred);
  }
  clear() { this.msgs = []; }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${HTTP_URL}${path}`, { method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const mods = { paint: '#ff9933', rim: '#d4af37', spoiler: 'wing', underglow: '#00e5ff', tint: 0.5, sticker: 'flames', plate: 'GJ 06 AB 1234' };
const A = new Client('A'), B = new Client('B'), C = new Client('C');
let pin, pidA, pidB, pidC, tokenC, startAt;

await step('GET /healthz -> 200 ok', async () => {
  const r = await httpGet('/healthz');
  assert(r.status === 200 && r.body === 'ok', `got ${r.status} ${r.body}`);
});

await step('static: path traversal blocked', async () => {
  for (const p of ['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/assets/..%5c..%5cpackage.json']) {
    const r = await httpGet(p);
    assert(!r.body.includes('"lord-alto"'), `leaked package.json via ${p}`);
  }
  return 'no leak';
});

await step('static: SPA route answers (index.html or 503 if not built)', async () => {
  const r = await httpGet('/some/route');
  assert(r.status === 200 || r.status === 503, `status ${r.status}`);
  if (r.status === 200) assert(/text\/html/.test(r.headers['content-type']) && r.headers['cache-control'] === 'no-cache', 'bad headers');
  return `status ${r.status}`;
});

await step('3 clients connect', async () => {
  await Promise.all([A.open(), B.open(), C.open()]);
});

await step('ping -> pong with server time', async () => {
  const c = Date.now();
  A.send({ t: 'ping', c });
  const m = await A.wait('pong');
  assert(m.c === c && Math.abs(m.s - Date.now()) < 2000, JSON.stringify(m));
});

await step('A creates room (welcome, 4-digit PIN, host)', async () => {
  A.send({ t: 'create', v: 1, rid: 1, name: '  <b>Lord\u0007 Alto the Great Racer</b> ', car: 'k10gen3', mods });
  const m = await A.wait('welcome');
  pin = m.room.pin; pidA = m.pid;
  assert(/^\d{4}$/.test(pin), `pin ${pin}`);
  assert(m.rid === 1 && m.token && m.room.host === pidA, 'host/rid/token');
  const me = m.room.players[0];
  assert(me.name.length <= 16 && !/[<>]/.test(me.name), `name not sanitised: ${me.name}`);
  assert(me.mods.spoiler === 'wing' && me.car === 'k10gen3', 'car/mods');
  return `PIN ${pin}, name "${me.name}"`;
});

await step('bad PIN -> err no_room / bad_pin', async () => {
  const D = new Client('D');
  await D.open();
  const wrong = pin === '9999' ? '1000' : '9999';
  D.send({ t: 'join', rid: 7, pin: wrong, name: 'D', car: 'alto2000', mods });
  const e1 = await D.wait('err');
  assert(e1.code === 'no_room' && e1.rid === 7, JSON.stringify(e1));
  D.send({ t: 'join', pin: '12a', name: 'D' });
  const e2 = await D.wait('err');
  assert(e2.code === 'bad_pin', JSON.stringify(e2));
  D.close();
  return `${e1.code}: "${e1.msg}"`;
});

await step('B and C join with PIN', async () => {
  B.send({ t: 'join', pin, name: 'Bhavesh', car: 'alto800', mods: { paint: 'red; drop table', tint: 9 } });
  const wb = await B.wait('welcome');
  pidB = wb.pid;
  C.send({ t: 'join', pin: Number(pin), name: 'Chirag', car: 'not-a-car', mods });
  const wc = await C.wait('welcome');
  pidC = wc.pid; tokenC = wc.token;
  assert(wc.room.players.length === 3, `players ${wc.room.players.length}`);
  const pb = wc.room.players.find((p) => p.pid === pidB);
  assert(pb.mods.paint === null && pb.mods.tint === 1, 'mods not sanitised');
  assert(wc.room.players.find((p) => p.pid === pidC).car === 'alto2000', 'car not sanitised');
  await A.wait((m) => m.t === 'room' && m.room.players.length === 3, 3000, 'room with 3 players');
});

await step('non-host settings rejected', async () => {
  B.send({ t: 'settings', track: 'oldcity' });
  const e = await B.wait('err');
  assert(e.code === 'not_host', e.code);
});

await step('host settings validated + applied', async () => {
  A.send({ t: 'settings', track: 'moon' });
  const e = await A.wait('err');
  assert(e.code === 'bad_track', e.code);
  A.send({ t: 'settings', laps: 7 });
  const e2 = await A.wait('err');
  assert(e2.code === 'bad_laps', e2.code);
  A.clear(); B.clear(); C.clear();
  A.send({ t: 'settings', track: 'oldcity', laps: 1, timeOfDay: 'night' });
  const r = await C.wait((m) => m.t === 'room' && m.room.settings.track === 'oldcity', 3000, 'room settings');
  assert(r.room.settings.laps === 1 && r.room.settings.timeOfDay === 'night', JSON.stringify(r.room.settings));
});

await step('state before race is ignored', async () => {
  A.send({ t: 's', d: { x: 1 } });
  assert(await B.none((m) => m.t === 's'), 'state relayed in lobby');
});

await step('host start -> prepare (startAt null) to all', async () => {
  A.clear(); B.clear(); C.clear();
  A.send({ t: 'start' });
  const ps = await Promise.all([A, B, C].map((c) => c.wait('prepare')));
  for (const p of ps) {
    assert(p.track === 'oldcity' && p.laps === 1 && p.timeOfDay === 'night', 'settings');
    assert(p.grid.length === 3 && p.grid[0] === pidA && p.startAt === null, JSON.stringify(p));
  }
  const r = await B.wait((m) => m.t === 'room' && m.room.phase === 'racing', 3000, 'racing room');
  assert(r);
});

await step('join while racing rejected (in_race)', async () => {
  const E = new Client('E');
  await E.open();
  E.send({ t: 'join', pin, name: 'Late' });
  const e = await E.wait('err');
  E.close();
  assert(e.code === 'in_race', e.code);
});

await step('all loaded -> prepare with startAt ~4.5 s ahead', async () => {
  for (const c of [A, B, C]) c.send({ t: 'loaded' });
  const ps = await Promise.all([A, B, C].map((c) => c.wait('prepare')));
  startAt = ps[0].startAt;
  const ahead = startAt - Date.now();
  assert(ps.every((p) => p.startAt === startAt), 'startAt differs');
  assert(ahead > 3500 && ahead <= 4600, `ahead ${ahead}`);
  return `startAt in ${ahead} ms`;
});

await step('state batched to the room at 20 Hz ({t:S,l:[[pid,d]]})', async () => {
  const d = { x: 10.5, z: -3, h: 1.2, v: 22, steer: 0.1, nitro: false, drift: 0, lap: 0, progress: 0.01 };
  A.send({ t: 's', d });
  B.send({ t: 's', d: { ...d, x: 7 } });
  const [mb, mc] = await Promise.all([B.wait('S'), C.wait('S')]);
  const ea = mb.l.find((e) => e[0] === pidA), eb = mc.l.find((e) => e[0] === pidB);
  assert(ea && ea[1].x === 10.5 && eb && eb[1].x === 7, JSON.stringify(mb));
  return `${mb.l.length} states in one message`;
});

await step('selfie avatar relayed to others, oversized/invalid rejected', async () => {
  const tiny = 'data:image/jpeg;base64,' + 'A'.repeat(3000);
  A.send({ t: 'avatar', data: tiny });
  const m = await B.wait('avatar');
  assert(m.p === pidA && m.data === tiny, 'avatar relay');
  await sleep(2100);
  A.clear();
  A.send({ t: 'avatar', data: 'javascript:alert(1)' });
  const e = await A.wait('err');
  assert(e.code === 'bad_avatar', e.code);
});

await step('crash relayed to ALL ({t:crash,by,victim,d})', async () => {
  B.send({ t: 'crash', victim: pidC, d: { power: 0.8, dir: [1, 0], evil: 'x'.repeat(100) } });
  const ms = await Promise.all([A, B, C].map((c) => c.wait('crash')));
  for (const m of ms) assert(m.by === pidB && m.victim === pidC && m.d.power === 0.8 && m.d.dir[0] === 1 && !m.d.evil, JSON.stringify(m));
});

await step('horn relayed to others', async () => {
  C.send({ t: 'horn' });
  const m = await A.wait('horn');
  assert(m.p === pidC);
});

await step('resume after disconnect (seat kept, token checked)', async () => {
  A.clear();
  C.ws.terminate();
  await A.wait((m) => m.t === 'room' && m.room.players.find((p) => p.pid === pidC)?.online === false, 3000, 'C offline');
  const C2 = new Client('C2');
  await C2.open();
  C2.send({ t: 'resume', pin, pid: pidC, token: tokenC.slice(0, -2) + 'xx' });
  const e = await C2.wait('err');
  assert(e.code === 'bad_token', `bad token -> ${e.code}`);
  C2.send({ t: 'resume', pin, pid: pidC, token: tokenC, rid: 'r1' });
  const w = await C2.wait('welcome');
  assert(w.pid === pidC && w.rid === 'r1' && w.room.phase === 'racing', JSON.stringify(w).slice(0, 200));
  const p = await C2.wait('prepare');
  assert(p.startAt === startAt, 'prepare replay');
  await A.wait((m) => m.t === 'room' && m.room.players.find((q) => q.pid === pidC)?.online === true, 3000, 'C online');
  C.ws = C2.ws; C.msgs = C2.msgs; C.waiters = C2.waiters; // keep using "C"
  return 'bad token rejected, good token resumed';
});

await step('rate limit drops excess without killing normal clients', async () => {
  B.clear();
  for (let i = 0; i < 150; i++) B.send({ t: 'ping', c: i });
  await sleep(500);
  const pongs = B.msgs.filter((m) => m.t === 'pong').length;
  assert(pongs < 150 && pongs >= 40, `pongs ${pongs}`);
  assert(B.ws.readyState === WebSocket.OPEN, 'B was kicked');
  B.clear();
  await sleep(300);
  return `${pongs}/150 answered`;
});

await step('finish x3 -> finish broadcasts + results, back to lobby', async () => {
  const wait = startAt - Date.now() + 300;
  if (wait > 0) await sleep(wait);
  A.clear(); B.clear(); C.clear();
  const t0 = Date.now() - startAt;
  B.send({ t: 'finish', time: t0 - 100, best: t0 - 100 });
  A.send({ t: 'finish', time: t0, best: t0 - 200 });
  const f = await C.wait((m) => m.t === 'finish' && m.p === pidB, 3000, 'finish B');
  assert(f.time === t0 - 100, `time ${f.time}`);
  C.send({ t: 'finish', time: 999999999, best: 1 }); // impossible time -> server clamps
  const res = await Promise.all([A, B, C].map((c) => c.wait('results', 3000)));
  const rows = res[0].rows;
  assert(rows.length === 3, `rows ${rows.length}`);
  assert(rows[0].pid === pidB && rows[0].place === 1 && rows[1].pid === pidA && rows[2].pid === pidC, JSON.stringify(rows));
  assert(rows[2].time < 999999999, 'impossible time accepted');
  assert(rows.every((r) => r.name && 'best' in r), 'row fields');
  const r = await A.wait((m) => m.t === 'room' && m.room.phase === 'lobby', 3000, 'lobby room');
  assert(r.room.phase === 'lobby');
  return rows.map((x) => `${x.place}.${x.name} ${x.time}ms`).join(', ');
});

await step('host kick -> target gets kicked, others get left', async () => {
  A.clear(); B.clear();
  A.send({ t: 'kick', pid: pidC });
  await C.wait('kicked');
  const l = await B.wait('left');
  assert(l.p === pidC && l.reason === 'kicked', JSON.stringify(l));
});

await step('host leaves -> host migrates to B', async () => {
  B.clear();
  A.send({ t: 'leave' });
  const l = await B.wait('left');
  assert(l.p === pidA, 'left pid');
  const r = await B.wait((m) => m.t === 'room' && m.room.host === pidB, 3000, 'B host');
  assert(r.room.players.length === 1);
});

await step('oversized message closes socket (15 KB frame limit; 4 KB for non-avatar)', async () => {
  const F = new Client('F');
  await F.open();
  F.send({ t: 'ping', c: 1, pad: 'x'.repeat(5000) });
  assert(await F.none((m) => m.t === 'pong', 300), '5 KB ping answered');
  F.send({ t: 'ping', c: 1, pad: 'x'.repeat(20000) });
  await sleep(400);
  assert(F.ws.readyState !== WebSocket.OPEN, 'still open');
  return `close code ${F.closed}`;
});

await step('room deleted when empty (PIN no longer joinable)', async () => {
  B.send({ t: 'leave' });
  await sleep(200);
  B.send({ t: 'join', pin, name: 'again' });
  const e = await B.wait('err');
  assert(e.code === 'no_room', e.code);
});

for (const c of [A, B, C]) c.close();
console.log(failures ? `\n${failures} step(s) FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
