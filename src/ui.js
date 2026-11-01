// DOM overlay UI for Lord Alto. Screens live in index.html; this class wires them to game handlers.
// All user-provided text is rendered with textContent (never innerHTML).
import {
  CARS, TRACKS, PAINTS, RIMS, SPOILERS, UNDERGLOWS, STICKERS, UPGRADES, MAX_UPGRADE,
  LAPS, DIFFICULTY, TIMES, MAX_RACERS, BRAND,
} from './config.js';

const SCREENS = ['loading', 'menu', 'tracks', 'garage', 'mp', 'lobby', 'race', 'pause', 'results'];
const SVGNS = 'http://www.w3.org/2000/svg';
const UI_PREFS_KEY = 'lordalto.ui';
const POPUP_MAX = 3;

const PAINT_NAMES = {
  '#d8dde3': 'Silky silver', '#f2f2f0': 'Superior white', '#1b1b1f': 'Midnight black', '#b3121d': 'Blazing red',
  '#c8102e': 'Sizzling red', '#1f4fa8': 'Cerulean blue', '#2e8b57': 'Mojito green', '#e5601d': 'Granite orange',
  '#f6c62a': 'Marigold yellow', '#7b2cbf': 'Navratri purple', '#ff4f9a': 'Bandhani pink', '#00b4d8': 'Sky cyan',
  '#9aa3ad': 'Granite grey', '#d4af37': 'Royal gold', '#c0c4c8': 'Silver', '#d4af37 ': 'Gold', '#ffffff': 'White',
  '#00e5ff': 'Cyan', '#ff2bd6': 'Magenta', '#39ff14': 'Lime', '#ff9f1c': 'Amber',
};
const STICKER_NAMES = { stripes: 'Racing stripes', flames: 'Flames', jai_mataji: 'Jai Mataji', baroda: 'Baroda' };
const SPOILER_NAMES = { none: 'NONE', lip: 'LIP', wing: 'WING' };
const TIME_NAMES = { day: 'DAY', sunset: 'SUNSET', night: 'NIGHT' };
const TIME_ICON = { day: 'i-sun', sunset: 'i-sunset', night: 'i-moon', auto: 'i-auto' };
const STAT_NAMES = { speed: 'SPEED', accel: 'ACCEL', handling: 'HANDLING', nitro: 'NITRO' };
const TIPS = [
  'Tip: hold DRIFT through Genda Circle to fill your nitro tank.',
  'Tip: ram a rival at speed for a DHADAAAKK bonus!',
  'Tip: the Mandvi Gate is narrow. Aim for the middle arch.',
  'Tip: claim your daily reward every day for bigger points.',
  'Tip: upgrades stay with each car. Pick a favourite!',
  'Tip: press H to honk like a true Barodian.',
];

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}
function svgEl(tag, attrs) {
  const e = document.createElementNS(SVGNS, tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
function icon(id, cls) {
  const s = svgEl('svg', { 'aria-hidden': 'true' });
  if (cls) s.setAttribute('class', cls);
  const u = svgEl('use');
  u.setAttribute('href', '#' + id);
  s.appendChild(u);
  return s;
}
function button(cls, text, attrs) {
  const b = el('button', cls, text);
  b.type = 'button';
  if (attrs) for (const k in attrs) b.setAttribute(k, attrs[k]);
  return b;
}
const pad2 = (n) => String(n).padStart(2, '0');
/** seconds -> "m:ss.cc" */
export function fmtTime(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return '--:--.--';
  const cs = Math.floor(sec * 100 + 1e-6);
  return `${Math.floor(cs / 6000)}:${pad2(Math.floor(cs / 100) % 60)}.${pad2(cs % 100)}`;
}
export function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
}
const fmtNum = (n) => Math.round(n || 0).toLocaleString('en-IN');
export function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const s = words.length > 1 ? [...words[0]][0] + [...words[words.length - 1]][0] : [...words[0]].slice(0, 2).join('');
  return s.toUpperCase();
}
function inkFor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const l = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return l > 0.62 ? '#1d1747' : '#ffffff';
}
const isImageDataUrl = (s) => typeof s === 'string' && s.startsWith('data:image/') && s.length < 3_000_000;
const isTyping = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
function loadPrefs() { try { return JSON.parse(localStorage.getItem(UI_PREFS_KEY)) || {}; } catch { return {}; } }
function savePrefs(p) { try { localStorage.setItem(UI_PREFS_KEY, JSON.stringify(p)); } catch { /* private mode */ } }

// Global best-case stat (fully upgraded best car) so bars compare across cars.
const STAT_LO = 0.75;
const STAT_HI = (() => {
  const hi = { speed: 1, accel: 1, handling: 1, nitro: 1 };
  for (const c of CARS) for (const [k, u] of Object.entries(UPGRADES)) {
    const base = u.stat === 'nitro' ? 1 : (c.stats[u.stat] || 1);
    hi[u.stat] = Math.max(hi[u.stat], base + u.step * MAX_UPGRADE);
  }
  return hi;
})();
const statPct = (stat, v) => Math.max(4, Math.min(100, ((v - STAT_LO) / ((STAT_HI[stat] || 1.3) - STAT_LO)) * 100));

/** Projects lat/lon waypoints into a smoothed closed SVG path (north up). */
function routeGeometry(waypoints, w = 200, h = 100, padding = 8) {
  const pts = (waypoints || []).map((p) => (Array.isArray(p) ? [p[1], p[0], p[2]] : [p.x, p.z, p]));
  if (pts.length < 3) return null;
  const lat0 = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const xy = pts.map((p) => [p[0] * k, -p[1], p[2]]);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of xy) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const s = Math.min((w - padding * 2) / (maxX - minX || 1), (h - padding * 2) / (maxY - minY || 1));
  const ox = (w - (maxX - minX) * s) / 2, oy = (h - (maxY - minY) * s) / 2;
  const P = xy.map(([x, y, m]) => [ox + (x - minX) * s, oy + (y - minY) * s, m]);
  const n = P.length;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const m0 = mid(P[n - 1], P[0]);
  let d = `M${m0[0].toFixed(1)},${m0[1].toFixed(1)}`;
  const onCurve = [];
  for (let i = 0; i < n; i++) {
    const a = P[i], b = mid(P[i], P[(i + 1) % n]), pm = mid(P[(i + n - 1) % n], P[i]);
    d += ` Q${a[0].toFixed(1)},${a[1].toFixed(1)} ${b[0].toFixed(1)},${b[1].toFixed(1)}`;
    onCurve.push({ x: 0.25 * pm[0] + 0.5 * a[0] + 0.25 * b[0], y: 0.25 * pm[1] + 0.5 * a[1] + 0.25 * b[1], meta: a[2] });
  }
  return { d: d + ' Z', points: onCurve };
}

// ---------- UI ----------
export class UI {
  constructor(handlers = {}) {
    this.h = handlers;
    this.screen = 'loading';
    this.points = 0;
    this._shownPoints = 0;
    this.settings = { muted: false, touch: 'buttons', ...loadPrefs() };
    this.trackSel = { track: TRACKS[0]?.id, laps: 3, difficulty: 'normal', timeOfDay: null };
    this.tracks = TRACKS;
    this.garage = null;
    this.room = null;
    this.mePid = null;
    this.inRoom = false;
    this._hud = {};
    this._timers = {};
    this._mm = { key: null, w: 0, h: 0 };

    this.app = $('app') || document.body;
    this.sections = {};
    for (const s of SCREENS) this.sections[s] = $('screen-' + s);

    this._buildStatic();
    this._bind();
    this._applySettings();
    const tip = $('loadTip');
    if (tip) tip.textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
    this.show('loading');
  }

  _call(name, ...args) {
    const fn = this.h[name];
    if (typeof fn !== 'function') return undefined;
    try { return fn(...args); } catch (e) { console.error(`[ui] handler ${name} failed`, e); return undefined; }
  }

  // ======================================================================
  // Screens
  // ======================================================================
  show(name) {
    if (!SCREENS.includes(name)) return;
    const prev = this.screen;
    this.screen = name;
    for (const s of SCREENS) {
      const sec = this.sections[s];
      if (!sec) continue;
      const on = s === name || (name === 'pause' && s === 'race');
      const was = sec.classList.contains('is-active');
      clearTimeout(sec._goneT);
      if (on) {
        if (sec.classList.contains('is-gone')) { sec.classList.remove('is-gone'); void sec.offsetWidth; } // restart the enter fade
      } else if (was) {
        // after the fade, take it out of rendering entirely so nothing can ghost (frozen transitions in background tabs etc.)
        sec._goneT = setTimeout(() => { if (!sec.classList.contains('is-active')) sec.classList.add('is-gone'); }, 450);
      } else sec.classList.add('is-gone');
      sec.classList.toggle('is-active', on);
      if (on) sec.removeAttribute('inert'); else sec.setAttribute('inert', '');
      sec.setAttribute('aria-hidden', on ? 'false' : 'true');
    }
    if (name === 'pause') this.sections.race?.setAttribute('inert', '');
    document.body.dataset.screen = name;
    if (name === 'pause') {
      const note = $('pauseMpNote');
      if (note) note.hidden = !this.inRoom;
      const rs = $('btnRestart');
      if (rs) rs.disabled = this.inRoom;
    }
    if (name === 'race') {
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    } else if (name !== prev && this._kbd) {
      // keyboard users: put focus on the first control of the new screen
      setTimeout(() => {
        const sec = this.sections[name];
        const first = sec && sec.querySelector('.btn-primary:not(:disabled), button:not(:disabled), input');
        first?.focus({ preventScroll: true });
      }, 60);
    }
    if (name === 'menu' || name === 'mp') this.countdown(null);
    if (name !== 'race' && name !== 'pause') {
      const ww = $('hudWrongWay'); if (ww) ww.hidden = true;
      $('hudPopups')?.replaceChildren();
      this._hideIntro();
    }
    this.sections[name]?.scrollTo?.(0, 0);
    try { window.dispatchEvent(new CustomEvent('ui:screen', { detail: { screen: name, prev } })); } catch { /* old browsers */ }
  }

  /** Optional: drive the loading bar (0..1). At 1 a "TAP TO START" button appears (calls handlers.onReady). */
  loading(p, text) {
    const v = Math.max(0, Math.min(1, +p || 0));
    const bar = $('loadBar');
    if (bar) bar.style.width = (v * 100).toFixed(1) + '%';
    $('loadProgress')?.setAttribute('aria-valuenow', String(Math.round(v * 100)));
    if (text) $('loadStatus').textContent = text;
    if (v >= 1) {
      $('loadStatus').textContent = text || 'Ready to race!';
      const b = $('btnTapStart');
      if (b) { b.hidden = false; if (this._kbd) b.focus(); }
    }
  }

  // ======================================================================
  // Points / daily
  // ======================================================================
  setPoints(n) {
    n = Math.max(0, Math.round(+n || 0));
    const from = this._shownPoints;
    this.points = n;
    const nodes = document.querySelectorAll('.js-points');
    cancelAnimationFrame(this._ptsRaf);
    if (from === n || !this._started) {
      this._shownPoints = n;
      nodes.forEach((e) => { e.textContent = fmtNum(n); });
      this._started = true;
    } else {
      const t0 = performance.now(), dur = Math.min(900, 300 + Math.abs(n - from) * 0.5);
      document.querySelectorAll('.points-pill').forEach((p) => { p.classList.remove('bump'); void p.offsetWidth; p.classList.add('bump'); });
      const step = (t) => {
        const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
        this._shownPoints = Math.round(from + (n - from) * e);
        nodes.forEach((x) => { x.textContent = fmtNum(this._shownPoints); });
        if (k < 1) this._ptsRaf = requestAnimationFrame(step);
      };
      this._ptsRaf = requestAnimationFrame(step);
    }
    if (this.garage) this._renderUpgrades();
  }

  daily(offer) {
    this._daily = offer || null;
    const b = $('btnDaily'), t = $('dailyText');
    if (!b) return;
    if (offer) {
      b.disabled = false;
      b.classList.add('has-offer');
      t.textContent = `Day ${offer.day}: +${fmtNum(offer.points)}`;
      b.setAttribute('aria-label', `Claim daily reward: day ${offer.day}, ${offer.points} points`);
    } else {
      b.disabled = true;
      b.classList.remove('has-offer');
      t.textContent = 'come back tomorrow';
      b.setAttribute('aria-label', 'Daily reward claimed, come back tomorrow');
    }
  }

  // ======================================================================
  // Tracks
  // ======================================================================
  setTracks(tracks, selectedId, settings) {
    const list = $('trackList');
    if (tracks && tracks.length) this.tracks = tracks;
    if (selectedId) this.trackSel.track = selectedId;
    if (settings) {
      if (settings.laps != null) this.trackSel.laps = +settings.laps;
      const diff = settings.difficulty ?? settings.rivals;
      if (diff) this.trackSel.difficulty = diff;
      if ('timeOfDay' in settings) this.trackSel.timeOfDay = settings.timeOfDay || null;
    }
    if (!this.tracks.some((t) => t.id === this.trackSel.track)) this.trackSel.track = this.tracks[0]?.id;
    const key = this.tracks.map((t) => t.id).join('|');
    if (this._trackKey !== key) {
      this._trackKey = key;
      list.replaceChildren(...this.tracks.map((t, i) => this._trackCard(t, i)));
    }
    for (const card of list.children) {
      const on = card.dataset.id === this.trackSel.track;
      card.setAttribute('aria-checked', on ? 'true' : 'false');
      card.tabIndex = on ? 0 : -1;
    }
    this._segSet('segLaps', String(this.trackSel.laps));
    this._segSet('segRivals', this.trackSel.difficulty);
    this._segSet('segTime', this.trackSel.timeOfDay || 'auto');
  }

  _trackCard(t, i) {
    const card = button('track-card', null, { role: 'radio', 'aria-checked': 'false', 'data-id': t.id });
    card.style.setProperty('--i', i);
    const art = el('div', 'track-art');
    art.dataset.time = t.timeOfDay || 'day';
    const geo = routeGeometry(t.waypoints || t.points, 200, 100, 10);
    if (geo) {
      const svg = svgEl('svg', { viewBox: '0 0 200 100', preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true' });
      svg.appendChild(svgEl('path', { d: geo.d, class: 'route-under' }));
      svg.appendChild(svgEl('path', { d: geo.d, class: 'route-line' }));
      svg.appendChild(svgEl('path', { d: geo.d, class: 'route-dash' }));
      geo.points.forEach((p, j) => {
        if (j === 0) return;
        if (p.meta && p.meta.landmark) svg.appendChild(svgEl('circle', { cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: 3.6, class: 'route-mark' }));
      });
      const s0 = geo.points[0];
      svg.appendChild(svgEl('rect', { x: (s0.x - 5).toFixed(1), y: (s0.y - 5).toFixed(1), width: 10, height: 10, rx: 2.5, class: 'route-start' }));
      art.appendChild(svg);
    }
    const badge = el('span', 'tod-badge');
    badge.append(icon(TIME_ICON[t.timeOfDay] || 'i-sun'), document.createTextNode(TIME_NAMES[t.timeOfDay] || 'DAY'));
    art.appendChild(badge);
    const info = el('div', 'track-info');
    info.append(el('span', 'track-name', t.name), el('p', 'track-tagline', t.tagline || ''));
    const meta = el('div', 'track-meta');
    if (t.targetLength) meta.appendChild(el('span', null, (t.targetLength / 1000).toFixed(1) + ' km'));
    const marks = (t.waypoints || []).filter((w) => w[2] && w[2].landmark).length;
    if (marks) meta.appendChild(el('span', null, `${marks} landmarks`));
    if (t.style) meta.appendChild(el('span', null, t.style));
    if (t.best != null) meta.appendChild(el('span', null, 'Best ' + fmtTime(t.best > 1000 ? t.best / 1000 : t.best)));
    info.appendChild(meta);
    card.append(art, info);
    card.setAttribute('aria-label', `${t.name}. ${t.tagline || ''}`);
    card.addEventListener('click', () => this._pickTrack(t.id));
    return card;
  }

  _pickTrack(id) {
    if (this.trackSel.track === id) return;
    this.trackSel.track = id;
    this.setTracks(null, id);
    this._call('onTrack', id);
  }

  // ======================================================================
  // Garage
  // ======================================================================
  setGarage(d) {
    if (!d || !d.car) return;
    const prevId = this.garage?.car?.id, prevIdx = this.garage?.index;
    this.garage = d;
    const car = d.car;
    const name = $('carName');
    if (prevId !== car.id) {
      name.classList.remove('swap');
      name.style.setProperty('--dir', (prevIdx != null && d.index < prevIdx && !(prevIdx === d.total - 1 && d.index === 0)) || (prevIdx === 0 && d.index === d.total - 1) ? '-24px' : '24px');
      void name.offsetWidth;
      name.classList.add('swap');
    }
    name.textContent = car.name;
    $('carEra').textContent = /^\d+$/.test(String(car.era)) ? `${car.era} MODEL` : String(car.era).toUpperCase();
    $('carTagline').textContent = car.tagline || '';
    $('carLock').hidden = !!d.owned;
    $('carOwned').hidden = !d.owned || !!d.selected;
    $('carCount').textContent = `${(d.index ?? 0) + 1} / ${d.total ?? CARS.length}`;
    const dots = $('carDots');
    const total = d.total ?? CARS.length;
    if (dots.children.length !== total) dots.replaceChildren(...Array.from({ length: total }, () => el('i')));
    [...dots.children].forEach((x, i) => x.classList.toggle('on', i === d.index));

    const cta = $('btnBuySelect');
    cta.classList.remove('owned-selected');
    if (d.owned) {
      if (d.selected) {
        cta.textContent = '✓ YOUR RIDE';
        cta.classList.add('owned-selected');
        cta.disabled = true;
      } else {
        cta.textContent = 'SELECT';
        cta.disabled = false;
      }
      cta.dataset.action = 'select';
    } else {
      cta.replaceChildren(document.createTextNode(`BUY · ${fmtNum(d.price ?? car.price)}`), el('small', null, d.canAfford ? 'points' : 'not enough points yet'));
      cta.disabled = !d.canAfford;
      cta.dataset.action = 'buy';
    }
    this._renderUpgrades();
    this._renderMods();
  }

  _renderUpgrades() {
    const d = this.garage;
    if (!d) return;
    const list = $('upgradeList');
    if (!list.children.length) {
      for (const [key, u] of Object.entries(UPGRADES)) {
        const row = el('div', 'upg');
        row.dataset.key = key;
        const head = el('div', 'upg-head');
        head.append(el('span', 'upg-stat', STAT_NAMES[u.stat] || u.stat.toUpperCase()), el('span', 'upg-part', u.label));
        const pips = el('span', 'upg-pips');
        for (let i = 0; i < MAX_UPGRADE; i++) pips.appendChild(el('i'));
        head.appendChild(pips);
        const bar = el('div', 'upg-bar');
        bar.append(el('i', 'pot'), el('i', 'cur'));
        bar.setAttribute('role', 'meter');
        bar.setAttribute('aria-label', `${STAT_NAMES[u.stat] || u.stat} stat`);
        const btn = button('btn btn-primary', null);
        btn.addEventListener('click', () => this._call('onUpgrade', key));
        row.append(head, btn, bar);
        list.appendChild(row);
      }
    }
    const ups = d.upgrades || {};
    for (const row of list.children) {
      const key = row.dataset.key, u = UPGRADES[key];
      const info = ups[key] || {};
      const level = typeof info === 'number' ? info : (info.level || 0);
      let cost = typeof info === 'object' && 'cost' in info ? info.cost : Math.round(u.base * Math.pow(u.growth, level));
      if (level >= MAX_UPGRADE) cost = null;
      const stat = u.stat;
      const cur = d.stats?.[stat] ?? (stat === 'nitro' ? 1 : d.car.stats[stat]) ?? 1;
      const max = d.maxStats?.[stat] ?? cur + u.step * (MAX_UPGRADE - level);
      row.querySelector('.cur').style.width = statPct(stat, cur) + '%';
      row.querySelector('.pot').style.width = statPct(stat, max) + '%';
      row.querySelector('.upg-bar').setAttribute('aria-valuenow', cur.toFixed(2));
      [...row.querySelector('.upg-pips').children].forEach((p, i) => p.classList.toggle('on', i < level));
      const btn = row.querySelector('.btn');
      if (cost == null) {
        btn.replaceChildren(document.createTextNode('MAX'));
        btn.disabled = true;
        btn.setAttribute('aria-label', `${u.label} fully upgraded`);
      } else {
        btn.replaceChildren(document.createTextNode('+ ' + fmtNum(cost)), el('small', null, `level ${level + 1}`));
        btn.disabled = !d.owned || this.points < cost;
        btn.setAttribute('aria-label', `Upgrade ${u.label} to level ${level + 1} for ${cost} points`);
      }
    }
    const hint = $('upgradeHint');
    if (hint) hint.textContent = d.owned
      ? 'Upgrades stay with this car. Earn points by racing, drifting and DHADAAAKKing rivals.'
      : 'Buy this Alto to unlock upgrades. Dashed bars show its fully-upgraded potential.';
  }

  _renderMods() {
    const d = this.garage;
    if (!d) return;
    const mods = d.mods || {};
    // stock swatch shows this car's factory paint
    const stock = $('swPaint').querySelector('.stock');
    if (stock) { stock.style.setProperty('--c', d.car.paint); stock.title = 'Factory paint'; }
    this._radioSet('swPaint', mods.paint == null ? '' : mods.paint);
    this._radioSet('swRims', mods.rim || RIMS[0]);
    this._segSet('segSpoiler', mods.spoiler || 'none');
    this._radioSet('swGlow', mods.underglow || '');
    this._radioSet('chipSticker', mods.sticker || '');
    const tint = $('rngTint');
    if (document.activeElement !== tint) { tint.value = mods.tint ?? 0.4; this._rangeFill(tint); }
    const plate = $('plateInput');
    if (document.activeElement !== plate) plate.value = String(mods.plate || '').replace(/^GJ\s*06\s*/i, '');
  }

  // ======================================================================
  // Multiplayer / lobby
  // ======================================================================
  prefillPin(pin) {
    const p = $('mpPin');
    if (p && pin != null) { p.value = String(pin).replace(/\D/g, '').slice(0, 4); }
    const n = $('mpName');
    if (n && !n.value) setTimeout(() => n.focus({ preventScroll: true }), 120);
  }

  prefillName(name) {
    const n = $('mpName');
    if (n && name != null && document.activeElement !== n) n.value = String(name).slice(0, 16);
  }

  setMultiplayer(on) { this.inRoom = !!on; }

  /** Thumbnail on the mp-screen selfie button; dataUrl must be a data:image/ URL, null clears. */
  setSelfie(dataUrl) {
    const btn = $('selfieBtn'), img = $('selfieImg');
    if (!btn || !img) return;
    const ok = isImageDataUrl(dataUrl);
    if (ok) img.src = dataUrl; else img.removeAttribute('src');
    img.hidden = !ok;
    btn.classList.toggle('has-photo', ok);
    btn.setAttribute('aria-label', ok ? 'Change selfie' : 'Add selfie');
  }

  setLobby(room, mePid, avatars) {
    if (avatars instanceof Map) this._avatars = avatars;
    else if (avatars && typeof avatars === 'object') this._avatars = new Map(Object.entries(avatars));
    const avs = this._avatars || new Map();
    this.room = room || null;
    this.mePid = mePid;
    this.inRoom = !!room;
    if (!room) return;
    const isHost = room.host === mePid;
    // PIN
    const pinEl = $('lobbyPin');
    const pin = String(room.pin || '').padStart(4, '-');
    if (pinEl.dataset.pin !== pin) {
      pinEl.dataset.pin = pin;
      pinEl.replaceChildren(...[...pin].map((c, i) => { const s = el('span', null, c); s.style.setProperty('--i', i); return s; }));
      pinEl.setAttribute('aria-label', 'Room PIN ' + [...pin].join(' '));
    }
    $('btnShare').hidden = typeof navigator.share !== 'function';
    // players
    const players = room.players || [];
    const ul = $('lobbyPlayers');
    const items = players.map((p, i) => {
      const car = CARS.find((c) => c.id === p.car);
      const color = (p.mods && p.mods.paint) || car?.paint || '#ff9933';
      const li = el('li', 'player' + (p.pid === mePid ? ' is-me' : ''));
      li.style.animationDelay = i * 40 + 'ms';
      const av = el('span', 'avatar');
      av.style.setProperty('--c', color);
      av.style.setProperty('--ink', inkFor(color));
      const photo = avs.get(p.pid);
      if (isImageDataUrl(photo)) {
        const img = el('img');
        img.src = photo;
        img.alt = p.name || 'Racer';
        img.decoding = 'async';
        av.classList.add('has-img');
        av.appendChild(img);
      } else {
        av.textContent = initials(p.name);
        av.setAttribute('aria-hidden', 'true');
      }
      const text = el('span', 'player-text');
      const nm = el('span', 'player-name', p.name || 'Racer');
      if (p.pid === mePid) nm.appendChild(el('span', 'you', '(you)'));
      text.append(nm, el('span', 'player-car', car ? `${car.name} · ${car.era}` : 'Alto'));
      li.append(av, text);
      if (p.pid === room.host) {
        const c = icon('i-crown', 'crown');
        c.setAttribute('aria-label', 'Host');
        c.setAttribute('role', 'img');
        c.removeAttribute('aria-hidden');
        li.appendChild(c);
      }
      return li;
    });
    const slots = Math.max(0, Math.min(MAX_RACERS, Math.max(players.length + 1, 4)) - players.length);
    for (let i = 0; i < slots && players.length + i < MAX_RACERS; i++) {
      const li = el('li', 'player empty');
      li.append(el('span', 'avatar', '+'), el('span', 'player-text', 'Waiting for a racer…'));
      items.push(li);
    }
    ul.replaceChildren(...items);
    $('lobbyCount').textContent = `${players.length}/${MAX_RACERS}`;
    // settings
    const s = room.settings || {};
    this._lobbySettings = { track: s.track || TRACKS[0].id, laps: s.laps || 3, timeOfDay: s.timeOfDay ?? null };
    this._segSet('segHostTrack', this._lobbySettings.track);
    this._segSet('segHostLaps', String(this._lobbySettings.laps));
    this._segSet('segHostTime', this._lobbySettings.timeOfDay || 'auto');
    for (const id of ['segHostTrack', 'segHostLaps', 'segHostTime']) $(id).querySelectorAll('button').forEach((b) => { b.disabled = !isHost; });
    $('lobbyHostNote').textContent = isHost ? 'you are the host' : 'host decides';
    const racing = room.phase === 'racing';
    $('btnHostStart').hidden = !isHost;
    $('btnHostStart').disabled = racing;
    $('lobbyWaiting').hidden = isHost && !racing;
    const wt = $('lobbyWaiting');
    wt.lastChild.textContent = racing ? 'Race in progress, you will join the next one' : 'Waiting for the host to start';
  }

  _shareUrl() {
    const pin = this.room?.pin;
    const u = new URL(location.href);
    u.search = '';
    u.hash = '';
    if (pin) u.searchParams.set('room', pin);
    return u.toString();
  }

  async _copyLink() {
    const url = this._shareUrl();
    let ok = false;
    try { await navigator.clipboard.writeText(url); ok = true; } catch {
      const t = el('textarea');
      t.value = url;
      t.setAttribute('readonly', '');
      t.style.cssText = 'position:fixed;opacity:0;left:-999px';
      document.body.appendChild(t);
      t.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      t.remove();
    }
    this.toast(ok ? 'Invite link copied!' : `Share this PIN: ${this.room?.pin || ''}`);
  }

  async _share() {
    const pin = this.room?.pin || '';
    try {
      await navigator.share({ title: `${BRAND.title}: ${BRAND.subtitle}`, text: `Race me in Lord Alto! Room PIN ${pin}`, url: this._shareUrl() });
    } catch (e) {
      if (e && e.name !== 'AbortError') this._copyLink();
    }
  }

  // ======================================================================
  // HUD
  // ======================================================================
  hud(d) {
    if (!d) return;
    const H = this._hud;
    const set = (key, val, fn) => { if (H[key] !== val) { H[key] = val; fn(val); } };
    const place = d.place | 0;
    set('place', place, (v) => {
      $('hudPlace').textContent = v || '-';
      $('hudPlaceSuf').textContent = v ? ordinal(v) : '';
      const pos = $('hudPlace').parentElement;
      pos.classList.remove('pop'); void pos.offsetWidth; pos.classList.add('pop');
    });
    set('total', d.total | 0, (v) => { $('hudTotal').textContent = v; });
    set('lap', Math.min(d.lap | 0, d.laps | 0) || 1, (v) => { $('hudLap').textContent = v; });
    set('laps', d.laps | 0, (v) => { $('hudLaps').textContent = v; });
    set('time', fmtTime(d.time ?? 0), (v) => { $('hudTime').textContent = v; });
    set('best', fmtTime(d.best), (v) => { $('hudBest').textContent = v; $('hudBest').closest('.hud-sub').hidden = d.best == null; });
    // compact nitro bar (desktop only: phones use the N2O button ring driven by Input.setNitro)
    const n01 = Math.max(0, Math.min(1, d.nitro01 || 0));
    set('nitro', Math.round(n01 * 200), () => {
      $('hudNitro').style.transform = `scaleX(${n01.toFixed(3)})`;
      $('hudNitroWrap').classList.toggle('full', n01 >= 0.99);
    });
    set('nitroOn', !!d.nitroOn, (v) => { $('hudNitroWrap').classList.toggle('on', v); });
    // drift: metres of the current drift (0 = not drifting); values <= 1 are treated as a 0..1 meter
    const dr = typeof d.drift === 'boolean' ? (d.drift ? 1 : 0) : +d.drift || 0;
    set('drift', Math.round(dr * 10), () => {
      const on = dr > 0;
      $('hudDrift').classList.toggle('on', on);
      if (!on) return;
      const meters = dr > 1;
      $('hudDriftVal').textContent = meters ? `${Math.round(dr)} m` : '';
      $('hudDriftFill').style.transform = `scaleX(${Math.min(1, meters ? dr / 120 : dr).toFixed(3)})`;
    });
    set('wrongWay', !!d.wrongWay, (v) => { $('hudWrongWay').hidden = !v; });
  }

  minimap(points, bounds, cars) {
    const cv = $('minimap');
    if (!cv || !points || points.length < 2) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = this._mm.cssW || cv.clientWidth || 160, ch = this._mm.cssH || cv.clientHeight || 160;
    const W = Math.round(cw * dpr), Hh = Math.round(ch * dpr);
    if (cv.width !== W || cv.height !== Hh) { cv.width = W; cv.height = Hh; this._mm.key = null; }
    if (!this._mmObs && 'ResizeObserver' in window) {
      this._mmObs = new ResizeObserver(([e]) => { this._mm.cssW = e.contentRect.width; this._mm.cssH = e.contentRect.height; });
      this._mmObs.observe(cv);
    }
    const ctx = cv.getContext('2d');
    // cache the projected track path (points array identity + size)
    const b = bounds || boundsOf(points);
    if (this._mm.key !== points || this._mm.w !== W || this._mm.h !== Hh) {
      const pad = 14 * dpr;
      const dx = (b.maxX - b.minX) || 1, dz = (b.maxZ - b.minZ) || 1;
      const s = Math.min((W - pad * 2) / dx, (Hh - pad * 2) / dz);
      const ox = (W - dx * s) / 2 - b.minX * s, oz = (Hh - dz * s) / 2 - b.minZ * s;
      const path = new Path2D();
      points.forEach((p, i) => {
        const x = ox + p[0] * s, y = oz + p[1] * s;
        if (i) path.lineTo(x, y); else path.moveTo(x, y);
      });
      path.closePath();
      this._mm = { ...this._mm, key: points, w: W, h: Hh, s, ox, oz, path, start: [ox + points[0][0] * s, oz + points[0][1] * s] };
    }
    const m = this._mm;
    ctx.clearRect(0, 0, W, Hh);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(10,7,30,0.85)';
    ctx.lineWidth = 9 * dpr;
    ctx.stroke(m.path);
    ctx.strokeStyle = 'rgba(232,201,160,0.95)';
    ctx.lineWidth = 4.5 * dpr;
    ctx.stroke(m.path);
    // start line
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#1d1747';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.rect(m.start[0] - 4 * dpr, m.start[1] - 4 * dpr, 8 * dpr, 8 * dpr);
    ctx.fill(); ctx.stroke();
    if (!cars) return;
    let me = null;
    for (const c of cars) {
      if (c.me) { me = c; continue; }
      ctx.beginPath();
      ctx.arc(m.ox + c.x * m.s, m.oz + c.z * m.s, 4 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = c.color || '#ff9933';
      ctx.fill();
      ctx.lineWidth = 1.6 * dpr;
      ctx.strokeStyle = 'rgba(10,7,30,0.9)';
      ctx.stroke();
    }
    if (me) {
      const x = m.ox + me.x * m.s, y = m.oz + me.z * m.s;
      ctx.beginPath();
      ctx.arc(x, y, 10 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,197,51,0.28)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 6.5 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = me.color || '#ffc533';
      ctx.fill();
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = '#1d1747';
      ctx.beginPath();
      ctx.arc(x, y, 8.3 * dpr, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /**
   * Floating speed readout beside the player's car. Call every frame with screen px (CSS pixels);
   * x or y null hides it. Only writes a transform (no layout) and only when the rounded values change.
   */
  speedTag(x, y, kmh) {
    let t = this._tag;
    if (!t) {
      const root = $('speedTag');
      if (!root) return;
      t = this._tag = { root, num: $('speedTagNum'), vis: false, x: NaN, y: NaN, v: -1 };
    }
    if (x == null || y == null || !isFinite(x) || !isFinite(y)) {
      if (t.vis) { t.vis = false; t.root.classList.remove('on'); }
      return;
    }
    const rx = Math.round(x), ry = Math.round(y);
    if (rx !== t.x || ry !== t.y) {
      t.x = rx; t.y = ry;
      t.root.style.transform = `translate3d(${rx}px,${ry}px,0)`;
    }
    const v = Math.max(0, Math.round(+kmh || 0));
    if (v !== t.v) { t.v = v; t.num.textContent = v; }
    if (!t.vis) { t.vis = true; t.root.classList.add('on'); }
  }

  /** Small reward pill under the minimap, e.g. popup('+50 OVERTAKE', 'good'). kind: 'good' | 'nitro' | 'dhadaak'. */
  popup(text, kind = 'good') {
    const layer = $('hudPopups');
    if (!layer) return;
    text = String(text ?? '').trim();
    if (!text) return;
    const live = [...layer.children].filter((c) => !c.classList.contains('out'));
    for (let i = POPUP_MAX - 1; i < live.length; i++) this._popOut(live[i], true);
    const k = ['good', 'nitro', 'dhadaak'].includes(kind) ? kind : 'good';
    const pill = el('div', 'popup popup-' + k);
    const m = /^([+\-]?\d[\d,]*)\s+(.+)$/.exec(text);
    if (m) pill.append(el('b', 'popup-pts', m[1]), el('span', 'popup-txt', m[2]));
    else pill.append(el('span', 'popup-txt', text));
    layer.prepend(pill); // newest on top
    pill._t = setTimeout(() => this._popOut(pill), k === 'dhadaak' ? 2200 : 1800);
  }

  _popOut(pill, fast) {
    if (!pill || pill.classList.contains('out')) return;
    clearTimeout(pill._t);
    pill.classList.add('out');
    if (fast) pill.classList.add('fast');
    setTimeout(() => pill.remove(), fast ? 160 : 320);
  }

  /** Card shown during the countdown, e.g. raceIntro('RACE · BRIGHT DAY CIRCUIT', 'School run past the palace'). Hides at GO. */
  raceIntro(title, subtitle) {
    const card = $('raceIntro');
    if (!card) return;
    clearTimeout(this._timers.intro);
    if (title == null) { this._hideIntro(); return; }
    $('raceIntroTitle').textContent = String(title);
    const sub = $('raceIntroSub');
    sub.textContent = subtitle ? String(subtitle) : '';
    sub.hidden = !subtitle;
    card.classList.remove('out');
    card.hidden = false;
    card.style.animation = 'none'; void card.offsetWidth; card.style.animation = '';
    this._timers.intro = setTimeout(() => this._hideIntro(), 8000); // safety net if GO never comes
  }

  _hideIntro() {
    const card = $('raceIntro');
    if (!card || card.hidden || card.classList.contains('out')) return;
    clearTimeout(this._timers.intro);
    card.classList.add('out');
    this._timers.introOut = setTimeout(() => { card.hidden = true; card.classList.remove('out'); }, 360);
  }

  // ======================================================================
  // Countdown, banners, toast
  // ======================================================================
  countdown(n) {
    const wrap = $('countdown');
    clearTimeout(this._timers.cd);
    if (n == null) { wrap.hidden = true; this._cd = null; this._hideIntro(); return; }
    if (this._cd === n && !wrap.hidden) return;
    this._cd = n;
    wrap.hidden = false;
    const go = n <= 0;
    if (go) this._hideIntro();
    wrap.classList.toggle('go', go);
    const span = el('span', null, go ? 'CHALO!' : String(n));
    span.id = 'countdownNum';
    wrap.replaceChildren(span);
    this._timers.cd = setTimeout(() => { wrap.hidden = true; this._cd = null; }, go ? 1100 : 1400);
  }

  banner(text, kind = 'info') {
    const layer = $('banners');
    if (kind === 'dhadaak') return this._dhadaak(layer, text);
    text = String(text ?? '');
    const existing = [...layer.querySelectorAll('.banner-info')].find((b) => b.textContent === text);
    if (existing) existing.remove();
    const infos = layer.querySelectorAll('.banner-info');
    if (infos.length >= 3) infos[0].remove();
    const b = el('div', 'banner-info', text);
    const k = kind !== 'info' ? kind : (/WRONG|CRASH|OUT/i.test(text) ? 'warn' : /NITRO/i.test(text) ? 'nitro' : 'info');
    if (k !== 'info') b.classList.add(k);
    const n = layer.querySelectorAll('.banner-info').length;
    if (n) b.classList.add('stack-' + Math.min(2, n));
    layer.appendChild(b);
    setTimeout(() => b.remove(), 1750);
  }

  _dhadaak(layer, text) {
    const word = text && String(text).trim() ? String(text).trim() : 'DHADAAAKK!';
    layer.querySelector('.dhadaak')?.remove();
    const wrap = el('div', 'dhadaak');
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', word);
    wrap.style.setProperty('--rot', (Math.random() * 12 - 8).toFixed(1) + 'deg');
    const svg = svgEl('svg', { viewBox: '-170 -100 340 200', class: 'burst-svg', 'aria-hidden': 'true' });
    const lines = svgEl('g', { class: 'speedlines' });
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + Math.random() * 0.2;
      const r1 = 150 + Math.random() * 10, r2 = r1 + 20 + Math.random() * 25;
      lines.appendChild(svgEl('line', { x1: (Math.cos(a) * r1).toFixed(1), y1: (Math.sin(a) * r1 * 0.6).toFixed(1), x2: (Math.cos(a) * r2).toFixed(1), y2: (Math.sin(a) * r2 * 0.6).toFixed(1) }));
    }
    svg.appendChild(lines);
    svg.appendChild(svgEl('polygon', { points: starburst(22, 168, 118, 98, 0.18), class: 'burst-outer' }));
    svg.appendChild(svgEl('polygon', { points: starburst(18, 142, 104, 84, 0.22), class: 'burst-inner' }));
    svg.appendChild(svgEl('ellipse', { cx: 0, cy: 0, rx: 92, ry: 46, class: 'burst-core', opacity: 0.55 }));
    const txt = el('div', 'burst-text');
    [...word].forEach((ch, i) => {
      const s = el('span', i === 0 ? 'hl' : null, ch);
      s.style.setProperty('--i', i);
      txt.appendChild(s);
    });
    wrap.append(el('div', 'flash'), svg, txt);
    layer.appendChild(wrap);
    setTimeout(() => wrap.remove(), 1600);
    this.shake();
  }

  /** Shakes the whole game container (#app). */
  shake() {
    const a = this.app;
    a.classList.remove('shake');
    void a.offsetWidth;
    a.classList.add('shake');
    clearTimeout(this._timers.shake);
    this._timers.shake = setTimeout(() => a.classList.remove('shake'), 520);
  }

  toast(text) {
    const t = $('toast');
    t.textContent = String(text ?? '');
    t.classList.add('show');
    clearTimeout(this._timers.toast);
    this._timers.toast = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ======================================================================
  // Results
  // ======================================================================
  results(rows, totalPoints, breakdown) {
    rows = [...(rows || [])].sort((a, b) => (a.place || 99) - (b.place || 99));
    const me = rows.find((r) => r.me);
    const place = me?.place || 0;
    const pl = $('resultsPlace');
    pl.replaceChildren(document.createTextNode(place ? String(place) : '-'));
    if (place) pl.appendChild(el('sup', null, ordinal(place)));
    pl.classList.toggle('p1', place === 1);
    pl.style.animation = 'none'; void pl.offsetWidth; pl.style.animation = '';
    const titles = place === 1 ? ['SHABAASH!', 'Pehla number! You own the streets of Baroda.']
      : place === 2 ? ['SO CLOSE!', 'Second place. One more DHADAAAKK next time?']
        : place === 3 ? ['PODIUM!', 'Third place. Not bad at all, boss.']
          : place ? ['RACE OVER', 'Every Alto legend started somewhere. Chalo, again!'] : ['RESULTS', ''];
    $('resultsTitle').textContent = titles[0];
    $('resultsSub').textContent = titles[1];

    const list = $('resultsList');
    list.replaceChildren(...rows.map((r, i) => {
      const li = el('li', r.me ? 'me' : null);
      li.style.setProperty('--i', i);
      const medal = el('span', 'medal' + (r.place <= 3 ? ' m' + r.place : ''), r.place ?? '-');
      const nm = el('span', 'row-name');
      nm.append(el('b', null, (r.name || 'Racer') + (r.me ? ' (you)' : '')), el('small', null, r.car || ''));
      const tm = el('span', 'row-time');
      tm.appendChild(el('b', null, r.time != null ? fmtTime(r.time) : 'DNF'));
      const sub = [];
      if (r.best != null) sub.push('best ' + fmtTime(r.best));
      tm.appendChild(el('small', null, sub.join(' ')));
      if (r.points != null) tm.appendChild(el('span', 'pts', '+' + fmtNum(r.points)));
      li.append(medal, nm, tm);
      return li;
    }));

    const bd = $('resultsBreakdown');
    let items = Array.isArray(breakdown) ? breakdown.map((x) => (Array.isArray(x) ? { label: x[0], points: x[1] } : x)) : [];
    if (!items.length && me?.points != null) items = [{ label: place ? `Finish P${place}` : 'Race', points: me.points }];
    bd.replaceChildren(...items.map((it, i) => {
      const li = el('li');
      li.style.setProperty('--i', i);
      li.append(el('span', null, it.label), el('b', null, '+' + fmtNum(it.points)));
      return li;
    }));
    const earned = totalPoints != null ? totalPoints : items.reduce((s, x) => s + (+x.points || 0), 0);
    const er = $('resultsEarned');
    const t0 = performance.now();
    cancelAnimationFrame(this._earnRaf);
    const step = (t) => {
      const k = Math.min(1, (t - t0 - 500) / 900);
      er.textContent = '+' + fmtNum(Math.max(0, k) * earned);
      if (k < 1) this._earnRaf = requestAnimationFrame(step);
    };
    er.textContent = '+0';
    this._earnRaf = requestAnimationFrame(step);
    $('btnRaceAgain').textContent = this.inRoom ? 'BACK TO LOBBY' : 'RACE AGAIN';
  }

  // ======================================================================
  // Settings
  // ======================================================================
  setSettings(s) {
    if (!s) return;
    Object.assign(this.settings, s);
    if (s.laps != null) this.trackSel.laps = +s.laps;
    if (s.difficulty) this.trackSel.difficulty = s.difficulty;
    if ('timeOfDay' in s) this.trackSel.timeOfDay = s.timeOfDay || null;
    this._applySettings();
  }

  _applySettings() {
    const s = this.settings;
    this._segSet('segSound', s.muted ? 'off' : 'on');
    this._segSet('segTouch', s.touch || 'buttons');
    this._segSet('segFps', s.fps ? 'on' : 'off');
    const m = $('rngMusic');
    if (m && document.activeElement !== m) { m.value = s.music ?? 0.5; this._rangeFill(m); }
    const st = $('rngSteer');
    if (st && document.activeElement !== st) { st.value = s.steerSens ?? 1; this._rangeFill(st); this._steerLabel(); }
    const mute = $('btnMute');
    if (mute) {
      mute.setAttribute('aria-pressed', s.muted ? 'true' : 'false');
      mute.setAttribute('aria-label', s.muted ? 'Unmute sound' : 'Mute sound');
      mute.querySelector('use')?.setAttribute('href', s.muted ? '#i-mute' : '#i-sound');
    }
    this._fpsToggle(!!s.fps);
    window.dispatchEvent(new CustomEvent('lordalto:touchmode', { detail: { mode: s.touch || 'buttons' } }));
    window.dispatchEvent(new CustomEvent('lordalto:music', { detail: { volume: s.music ?? 0.5 } }));
  }

  _changeSetting(key, value) {
    if (this.settings[key] === value) return;
    this.settings[key] = value;
    if (key === 'fps' || key === 'music') savePrefs({ fps: this.settings.fps, music: this.settings.music });
    if (key === 'touch' && value === 'tilt') requestTiltPermission();
    this._applySettings();
    this._call('onSettings', { [key]: value });
  }

  openSettings() {
    const d = $('settingsDialog');
    if (!d || d.open) return;
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  }

  _fpsToggle(on) {
    const f = $('fps');
    if (!f) return;
    f.hidden = !on;
    if (on && !this._fpsRaf) {
      let frames = 0, t0 = performance.now();
      const loop = (t) => {
        frames++;
        if (t - t0 >= 500) { f.textContent = Math.round((frames * 1000) / (t - t0)) + ' FPS'; frames = 0; t0 = t; }
        this._fpsRaf = requestAnimationFrame(loop);
      };
      this._fpsRaf = requestAnimationFrame(loop);
    } else if (!on && this._fpsRaf) {
      cancelAnimationFrame(this._fpsRaf);
      this._fpsRaf = 0;
    }
  }

  // ======================================================================
  // Construction + wiring
  // ======================================================================
  _buildStatic() {
    const lapOpts = LAPS.map((n) => [String(n), String(n)]);
    const diffNames = { easy: 'EASY', normal: 'NORMAL', hard: 'HARD' };
    const diffOpts = Object.keys(DIFFICULTY).map((k) => [k, diffNames[k] || k.toUpperCase()]);
    const timeOpts = [['auto', 'AUTO', TIME_ICON.auto], ...TIMES.map((t) => [t, TIME_NAMES[t] || t.toUpperCase(), TIME_ICON[t]])];

    this._seg('segLaps', lapOpts, (v) => { this.trackSel.laps = +v; });
    this._seg('segRivals', diffOpts, (v) => { this.trackSel.difficulty = v; });
    this._seg('segTime', timeOpts, (v) => { this.trackSel.timeOfDay = v === 'auto' ? null : v; }, true);
    this._seg('segHostTrack', TRACKS.map((t) => [t.id, (t.short || t.name).toUpperCase()]), (v) => this._hostSetting('track', v));
    this._seg('segHostLaps', lapOpts, (v) => this._hostSetting('laps', +v));
    this._seg('segHostTime', timeOpts, (v) => this._hostSetting('timeOfDay', v === 'auto' ? null : v), true);
    this._seg('segSound', [['on', 'ON'], ['off', 'OFF']], (v) => this._changeSetting('muted', v === 'off'));
    this._seg('segTouch', [['buttons', 'BUTTONS'], ['tilt', 'TILT'], ['off', 'OFF']], (v) => this._changeSetting('touch', v));
    this._seg('segFps', [['on', 'ON'], ['off', 'OFF']], (v) => this._changeSetting('fps', v === 'on'));
    this._seg('segSpoiler', SPOILERS.map((s) => [s, SPOILER_NAMES[s] || s.toUpperCase()]), (v) => this._call('onMod', 'spoiler', v));

    // swatches
    const paints = $('swPaint');
    paints.appendChild(this._swatch('', '#d8dde3', 'Factory paint', 'stock', () => this._call('onMod', 'paint', null)));
    PAINTS.forEach((c) => paints.appendChild(this._swatch(c, c, PAINT_NAMES[c] || c, '', () => this._call('onMod', 'paint', c))));
    const rims = $('swRims');
    RIMS.forEach((c) => rims.appendChild(this._swatch(c, c, (PAINT_NAMES[c] || c) + ' rims', '', () => this._call('onMod', 'rim', c))));
    const glow = $('swGlow');
    UNDERGLOWS.forEach((c) => glow.appendChild(this._swatch(c || '', c || 'transparent', c ? (PAINT_NAMES[c] || c) + ' underglow' : 'No underglow', c ? 'glow' : 'none', () => this._call('onMod', 'underglow', c))));
    const chips = $('chipSticker');
    STICKERS.forEach((s) => {
      const b = button('chip', s ? STICKER_NAMES[s] || s : 'None', { role: 'radio', 'aria-checked': 'false', 'data-value': s || '' });
      b.addEventListener('click', () => { this._radioSet('chipSticker', s || ''); this._call('onMod', 'sticker', s); });
      chips.appendChild(b);
    });
  }

  _swatch(value, color, label, extra, onPick) {
    const b = button('swatch' + (extra ? ' ' + extra : ''), null, { role: 'radio', 'aria-checked': 'false', 'aria-label': label, title: label, 'data-value': value });
    b.style.setProperty('--c', color);
    b.addEventListener('click', () => { this._radioSet(b.parentElement.id, value); onPick(); });
    return b;
  }

  _seg(id, options, onPick, icons = false) {
    const root = $(id);
    if (!root) return;
    root.replaceChildren(...options.map(([value, label, ic]) => {
      const b = button(null, null, { role: 'radio', 'aria-checked': 'false', 'data-value': value });
      if (icons && ic) { b.appendChild(icon(ic)); b.appendChild(el('span', 'seg-txt', label)); b.setAttribute('aria-label', label); } else b.textContent = label;
      b.addEventListener('click', () => {
        if (b.disabled) return;
        this._segSet(id, value);
        onPick(value);
      });
      return b;
    }));
  }

  _segSet(id, value) { this._radioSet(id, value); }

  _radioSet(id, value) {
    const root = $(id);
    if (!root) return;
    for (const b of root.querySelectorAll('[role="radio"]')) {
      const on = b.dataset.value === String(value ?? '');
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  _rangeFill(r) { r.style.setProperty('--p', ((r.value - r.min) / (r.max - r.min)) * 100 + '%'); }
  _steerLabel() { const r = $('rngSteer'), o = $('outSteer'); if (r && o) o.textContent = Math.round(r.value * 100) + '%'; }

  _hostSetting(key, value) {
    if (!this.room || this.room.host !== this.mePid) return;
    this._lobbySettings = { ...(this._lobbySettings || {}), [key]: value };
    this._call('onHostSettings', { ...this._lobbySettings });
  }

  _goBack() {
    const from = this.screen;
    this.show('menu');
    if (typeof this.h.onBack === 'function') this._call('onBack', from);
    else if (from !== 'garage' || !this.inRoom) this._call('onQuit');
  }

  _bind() {
    const on = (id, ev, fn) => { const e = $(id); if (e) e.addEventListener(ev, fn); };
    const click = (id, fn) => on(id, 'click', fn);

    // generic button sound hook + keyboard-mode tracking
    document.addEventListener('pointerdown', (e) => {
      this._kbd = false;
      if (e.target.closest && e.target.closest('.ui button, .modal button')) this._call('onClick');
    }, true);

    // loading
    click('btnTapStart', () => { if (typeof this.h.onReady === 'function') this._call('onReady'); else this.show('menu'); });

    // menu
    click('btnRace', () => { this.show('tracks'); this.setTracks(null, this.trackSel.track); this._call('onPlay'); });
    click('btnMulti', () => { this.show('mp'); this._call('onMultiplayer'); });
    click('btnGarage', () => { this.show('garage'); this._call('onGarage'); });
    click('btnDaily', () => this._call('onClaimDaily'));
    click('btnSettings', () => this.openSettings());
    click('btnMute', () => this._changeSetting('muted', !this.settings.muted));
    document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => this._goBack()));

    // tracks
    click('btnStart', () => this._call('onStart', { ...this.trackSel }));
    $('trackList')?.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      const ids = this.tracks.map((t) => t.id);
      const i = ids.indexOf(this.trackSel.track);
      const d = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
      const next = ids[(i + d + ids.length) % ids.length];
      this._pickTrack(next);
      $('trackList').querySelector(`[data-id="${CSS.escape(next)}"]`)?.focus();
      e.preventDefault();
      e.stopPropagation();
    });

    // garage
    click('btnCarPrev', () => this._call('onCarPrev'));
    click('btnCarNext', () => this._call('onCarNext'));
    click('btnBuySelect', (e) => this._call(e.currentTarget.dataset.action === 'buy' ? 'onBuyCar' : 'onSelectCar'));
    const tabs = [['tabPerf', 'panelPerf'], ['tabStyle', 'panelStyle']];
    for (const [t, p] of tabs) click(t, () => {
      for (const [t2, p2] of tabs) {
        $(t2).setAttribute('aria-selected', t2 === t ? 'true' : 'false');
        $(p2).hidden = p2 !== p;
      }
    });
    const tint = $('rngTint');
    tint?.addEventListener('input', () => this._rangeFill(tint));
    tint?.addEventListener('change', () => this._call('onMod', 'tint', +tint.value));
    const plate = $('plateInput');
    plate?.addEventListener('input', () => {
      const v = plate.value.toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s{2,}/g, ' ').slice(0, 7);
      if (v !== plate.value) plate.value = v;
    });
    const commitPlate = () => {
      const v = plate.value.trim();
      const cur = String(this.garage?.mods?.plate || '').replace(/^GJ\s*06\s*/i, '');
      if (v && v !== cur) this._call('onMod', 'plate', 'GJ 06 ' + v);
    };
    plate?.addEventListener('change', commitPlate);
    plate?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); plate.blur(); } });

    // multiplayer
    const nameIn = $('mpName'), pinIn = $('mpPin');
    const getName = () => {
      const n = (nameIn.value || '').replace(/\s+/g, ' ').trim().slice(0, 16);
      if (!n) {
        nameIn.classList.remove('invalid'); void nameIn.offsetWidth; nameIn.classList.add('invalid');
        nameIn.focus();
        this.toast('Type your name first');
        return null;
      }
      nameIn.classList.remove('invalid');
      return n;
    };
    pinIn?.addEventListener('input', () => { const v = pinIn.value.replace(/\D/g, '').slice(0, 4); if (v !== pinIn.value) pinIn.value = v; pinIn.classList.remove('invalid'); });
    nameIn?.addEventListener('input', () => nameIn.classList.remove('invalid'));
    click('selfieBtn', () => this._call('onSelfie'));
    click('btnCreateRoom', () => { const n = getName(); if (n) this._call('onCreateRoom', n); });
    const join = () => {
      const n = getName();
      if (!n) return;
      const pin = pinIn.value.replace(/\D/g, '');
      if (pin.length !== 4) {
        pinIn.classList.remove('invalid'); void pinIn.offsetWidth; pinIn.classList.add('invalid');
        pinIn.focus();
        this.toast('Enter the 4-digit room PIN');
        return;
      }
      this._call('onJoinRoom', pin, n);
    };
    click('btnJoinRoom', join);
    pinIn?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); join(); } });
    nameIn?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); (pinIn.value.length === 4 ? join() : pinIn.focus()); } });

    // lobby
    click('btnLeave', () => { this.inRoom = false; this.room = null; this.show('mp'); this._call('onLeaveRoom'); });
    click('btnCopyLink', () => this._copyLink());
    click('btnShare', () => this._share());
    click('btnHostStart', () => this._call('onHostStart'));

    // race HUD pause button: same path as the keyboard pause (Input sees an Escape press)
    click('btnPause', () => {
      if (typeof this.h.onPause === 'function') { this._call('onPause'); return; }
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true })), 30);
    });

    // pause
    click('btnResume', () => { this.show('race'); this._call('onResume'); });
    click('btnRestart', () => { this._call('onRestart'); });
    click('btnPauseSettings', () => this.openSettings());
    click('btnQuit', () => { this.show('menu'); this._call('onQuit'); });

    // results
    click('btnRaceAgain', () => this._call('onRaceAgain'));
    click('btnResultsGarage', () => { this.show('garage'); this._call('onGarage'); });
    click('btnResultsMenu', () => { this.show('menu'); if (typeof this.h.onMenu === 'function') this._call('onMenu'); else this._call('onQuit'); });

    // settings
    const music = $('rngMusic');
    music?.addEventListener('input', () => { this._rangeFill(music); this.settings.music = +music.value; window.dispatchEvent(new CustomEvent('lordalto:music', { detail: { volume: +music.value } })); });
    music?.addEventListener('change', () => { this.settings.music = undefined; this._changeSetting('music', +music.value); });
    const steer = $('rngSteer');
    // Apply while dragging so you can feel it mid-race from the pause menu
    steer?.addEventListener('input', () => { this._rangeFill(steer); this._steerLabel(); this.settings.steerSens = +steer.value; this._call('onSettings', { steerSens: +steer.value }); });
    $('settingsDialog')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

    // keyboard navigation
    window.addEventListener('keydown', (e) => this._onKey(e));
  }

  _onKey(e) {
    if (['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) this._kbd = true;
    const dlg = $('settingsDialog');
    if (dlg?.open) return; // native dialog handles Esc + Tab
    const scr = this.screen;
    if (scr === 'race' || scr === 'pause') return; // Input owns the keys in-race (Esc = pause/resume)
    if (isTyping(e.target)) { if (e.key === 'Escape') e.target.blur(); return; }
    if (e.key === 'Escape' || e.key === 'Backspace') {
      if (scr === 'tracks' || scr === 'garage' || scr === 'mp') { e.preventDefault(); this._goBack(); }
      return;
    }
    if (scr === 'loading' && (e.key === 'Enter' || e.key === ' ') && !$('btnTapStart').hidden) { $('btnTapStart').click(); return; }
    if (scr === 'garage' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && (!document.activeElement || document.activeElement === document.body)) {
      e.preventDefault();
      this._call(e.key === 'ArrowLeft' ? 'onCarPrev' : 'onCarNext');
      return;
    }
    const dirs = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    const dir = dirs[e.key];
    if (!dir) return;
    const sec = this.sections[scr];
    if (!sec) return;
    const focusables = [...sec.querySelectorAll('button:not(:disabled), input:not([type="range"]), [tabindex="0"]')]
      .filter((x) => x.offsetParent !== null && !x.closest('[hidden]'));
    if (!focusables.length) return;
    const cur = document.activeElement;
    e.preventDefault();
    if (!sec.contains(cur)) { (sec.querySelector('.btn-primary:not(:disabled)') || focusables[0]).focus(); return; }
    const r0 = cur.getBoundingClientRect();
    const cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
    let best = null, bestScore = Infinity;
    for (const f of focusables) {
      if (f === cur) continue;
      const r = f.getBoundingClientRect();
      const dx = r.left + r.width / 2 - cx, dy = r.top + r.height / 2 - cy;
      const along = dx * dir[0] + dy * dir[1];
      if (along <= 4) continue;
      const across = Math.abs(dx * dir[1] - dy * dir[0]);
      const score = along + across * 2.2;
      if (score < bestScore) { bestScore = score; best = f; }
    }
    best?.focus();
  }
}

// ---------- misc ----------
function boundsOf(points) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of points) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  return { minX, maxX, minZ, maxZ };
}
/** Jagged comic starburst polygon, squashed to an ellipse. */
function starburst(spikes, rx, rInner, ry, jitter) {
  const pts = [];
  const n = spikes * 2;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const outer = i % 2 === 0;
    const j = 1 + (Math.random() * 2 - 1) * jitter;
    const r = (outer ? 1 : rInner / rx) * j;
    pts.push(`${(Math.cos(a) * rx * r).toFixed(1)},${(Math.sin(a) * ry * r).toFixed(1)}`);
  }
  return pts.join(' ');
}
function requestTiltPermission() {
  try {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      DOE.requestPermission().then((r) => {
        window.dispatchEvent(new CustomEvent('lordalto:tiltpermission', { detail: { granted: r === 'granted' } }));
      }).catch(() => { /* denied or not in a gesture */ });
    }
  } catch { /* ignore */ }
}
