import { CARS, DEFAULT_MODS, ECONOMY, UPGRADES, MAX_UPGRADE } from './config.js';

const KEY = 'lordalto.profile';
const VERSION = 1;

function fresh() {
  return {
    v: VERSION,
    points: ECONOMY.startPoints,
    owned: CARS.filter(c => c.price === 0).map(c => c.id),
    selected: CARS[0].id,
    mods: {},
    upgrades: {},
    best: {},
    name: '',
    races: 0, wins: 0, dhadaaks: 0,
    dailyDay: null, dailyStreak: 0,
    settings: { quality: matchMedia('(pointer: coarse)').matches ? 'low' : 'medium', laps: 3, difficulty: 'normal', timeOfDay: null, touch: 'buttons' },
  };
}

function migrate(p) {
  const base = fresh();
  if (!p || typeof p !== 'object') return base;
  const out = { ...base, ...p, settings: { ...base.settings, ...(p.settings || {}) } };
  out.owned = Array.isArray(p.owned) ? p.owned.filter(id => CARS.some(c => c.id === id)) : base.owned;
  for (const c of CARS) if (c.price === 0 && !out.owned.includes(c.id)) out.owned.push(c.id);
  if (!CARS.some(c => c.id === out.selected)) out.selected = base.selected;
  out.points = Number.isFinite(out.points) ? Math.max(0, Math.floor(out.points)) : base.points;
  out.v = VERSION;
  return out;
}

export class Profile {
  constructor() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(KEY)); } catch {}
    this.d = migrate(raw);
  }
  save() { try { localStorage.setItem(KEY, JSON.stringify(this.d)); } catch {} }

  get points() { return this.d.points; }
  add(n) { this.d.points += Math.max(0, Math.round(n)); this.save(); }
  spend(n) { if (this.d.points < n) return false; this.d.points -= n; this.save(); return true; }

  owns(id) { return this.d.owned.includes(id); }
  buy(id) {
    const car = CARS.find(c => c.id === id);
    if (!car || this.owns(id) || !this.spend(car.price)) return false;
    this.d.owned.push(id); this.d.selected = id; this.save(); return true;
  }
  select(id) { if (this.owns(id)) { this.d.selected = id; this.save(); } }

  mods(id) { return { ...DEFAULT_MODS, ...(this.d.mods[id] || {}) }; }
  setMod(id, key, value) { this.d.mods[id] = { ...this.mods(id), [key]: value }; this.save(); }

  levels(id) { return { engine: 0, turbo: 0, tyres: 0, nitro: 0, ...(this.d.upgrades[id] || {}) }; }
  upgradeCost(id, key) {
    const u = UPGRADES[key], lv = this.levels(id)[key];
    return lv >= MAX_UPGRADE ? null : Math.round(u.base * Math.pow(u.growth, lv));
  }
  upgrade(id, key) {
    const cost = this.upgradeCost(id, key);
    if (cost == null || !this.spend(cost)) return false;
    const lv = this.levels(id); lv[key]++; this.d.upgrades[id] = lv; this.save(); return true;
  }
  // Effective multipliers including upgrades
  stats(id) {
    const car = CARS.find(c => c.id === id), lv = this.levels(id);
    const st = { ...car.stats, nitro: 1 };
    for (const [k, u] of Object.entries(UPGRADES)) st[u.stat] = (st[u.stat] || 1) + u.step * lv[k];
    return st;
  }
  maxStats(id) {
    const car = CARS.find(c => c.id === id);
    const st = { ...car.stats, nitro: 1 };
    for (const u of Object.values(UPGRADES)) st[u.stat] = (st[u.stat] || 1) + u.step * MAX_UPGRADE;
    return st;
  }

  best(trackId) { return this.d.best[trackId] ?? null; }
  setBest(trackId, ms) { if (!this.d.best[trackId] || ms < this.d.best[trackId]) { this.d.best[trackId] = ms; this.save(); return true; } return false; }

  static utcDay(d = new Date()) { return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 864e5); }
  dailyOffer() {
    const day = Profile.utcDay();
    if (this.d.dailyDay === day) return null;
    const streak = this.d.dailyDay === day - 1 ? this.d.dailyStreak + 1 : 1;
    const L = ECONOMY.dailyLadder;
    return { day: streak, points: L[Math.min(streak, L.length) - 1] };
  }
  claimDaily() {
    const o = this.dailyOffer();
    if (!o) return null;
    this.d.dailyDay = Profile.utcDay(); this.d.dailyStreak = o.day; this.add(o.points); return o;
  }
}
