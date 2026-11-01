// Shared game data. Every module reads from here; keep it free of three.js imports.

export const BRAND = {
  title: 'LORD ALTO',
  subtitle: 'BARODA GRAND PRIX',
  tagline: 'Race India’s favourite small car through the streets of Vadodara',
};

// Stats are multipliers around 1.0. `shape` drives the procedural model in carModel.js.
// shape.gen: 'gen1' (2000 tall boxy), 'gen1f' (2005 facelift), 'gen2' (2010-2019 800/K10), 'gen3' (2022 rounded)
export const CARS = [
  { id: 'alto2000', name: 'Alto Classic', era: '2000', tagline: 'The OG. Light, tall and twitchy', price: 0,
    stats: { speed: 0.95, accel: 1.0, handling: 1.05 }, nitroMul: 1.0,
    shape: { gen: 'gen1', length: 3.5, width: 1.49, height: 1.46 }, paint: '#d8dde3' },
  { id: 'altoLxi', name: 'Alto LXi', era: '2005', tagline: 'The balanced daily driver', price: 0,
    stats: { speed: 0.97, accel: 1.0, handling: 1.02 }, nitroMul: 1.0,
    shape: { gen: 'gen1f', length: 3.5, width: 1.49, height: 1.46 }, paint: '#b3121d' },
  { id: 'alto800', name: 'Alto 800', era: '2012', tagline: 'Cheap, cheerful, grippy', price: 1500,
    stats: { speed: 0.96, accel: 0.98, handling: 1.08 }, nitroMul: 1.0,
    shape: { gen: 'gen2', length: 3.43, width: 1.49, height: 1.47 }, paint: '#f2f2f0' },
  { id: 'k10gen1', name: 'Alto K10', era: '2010', tagline: 'The first pocket rocket', price: 2000,
    stats: { speed: 1.03, accel: 1.08, handling: 0.98 }, nitroMul: 1.0,
    shape: { gen: 'gen2', length: 3.62, width: 1.49, height: 1.46 }, paint: '#1f4fa8' },
  { id: 'alto800bs6', name: 'Alto 800 BS6', era: '2019', tagline: 'Eco tuned, efficient nitro', price: 3000,
    stats: { speed: 0.98, accel: 1.02, handling: 1.04 }, nitroMul: 1.2,
    shape: { gen: 'gen2', length: 3.45, width: 1.49, height: 1.47, facelift: true }, paint: '#9aa3ad' },
  { id: 'k10ags', name: 'Alto K10 AGS', era: '2014', tagline: 'Smooth auto box, easy drifts', price: 4000,
    stats: { speed: 1.02, accel: 1.04, handling: 1.06 }, nitroMul: 1.0,
    shape: { gen: 'gen2', length: 3.55, width: 1.49, height: 1.47, facelift: true }, paint: '#e5601d' },
  { id: 'altoCng', name: 'Alto S-CNG', era: '2016', tagline: 'Slow top end, huge nitro tank', price: 5000,
    stats: { speed: 0.94, accel: 1.0, handling: 1.03 }, nitroMul: 1.5,
    shape: { gen: 'gen2', length: 3.45, width: 1.49, height: 1.47 }, paint: '#2e8b57' },
  { id: 'k10gen3', name: 'Alto K10 (New)', era: '2022', tagline: 'The best all-rounder', price: 8000,
    stats: { speed: 1.06, accel: 1.08, handling: 1.05 }, nitroMul: 1.0,
    shape: { gen: 'gen3', length: 3.53, width: 1.49, height: 1.52 }, paint: '#c8102e' },
  { id: 'lordAlto', name: 'LORD ALTO', era: 'Legend', tagline: 'Gold chrome. Glowing halo. Bow down.', price: 25000,
    stats: { speed: 1.12, accel: 1.15, handling: 1.12 }, nitroMul: 1.3,
    shape: { gen: 'gen3', length: 3.53, width: 1.49, height: 1.52, legend: true }, paint: '#d4af37' },
];

export const PAINTS = ['#d8dde3', '#f2f2f0', '#1b1b1f', '#b3121d', '#c8102e', '#1f4fa8', '#2e8b57', '#e5601d', '#f6c62a', '#7b2cbf', '#ff4f9a', '#00b4d8', '#9aa3ad', '#d4af37'];
export const RIMS = ['#c0c4c8', '#1b1b1f', '#d4af37', '#e5601d', '#00b4d8', '#ffffff'];
export const UNDERGLOWS = [null, '#00e5ff', '#ff2bd6', '#39ff14', '#ff9f1c', '#ffffff'];
export const SPOILERS = ['none', 'lip', 'wing'];
export const STICKERS = [null, 'stripes', 'flames', 'jai_mataji', 'baroda'];

export const DEFAULT_MODS = { paint: null, rim: '#c0c4c8', spoiler: 'none', underglow: null, tint: 0.4, sticker: null, plate: 'GJ 06 LA 0001' };

// Performance upgrades: 5 levels each. cost = base * growth^level. Each level adds `step` to the stat multiplier.
export const UPGRADES = {
  engine: { label: 'Engine', stat: 'speed', base: 400, growth: 1.5, step: 0.02 },
  turbo: { label: 'Turbo', stat: 'accel', base: 350, growth: 1.5, step: 0.025 },
  tyres: { label: 'Tyres', stat: 'handling', base: 300, growth: 1.5, step: 0.025 },
  nitro: { label: 'Nitro tank', stat: 'nitro', base: 300, growth: 1.55, step: 0.1 },
};
export const MAX_UPGRADE = 5;

export const ECONOMY = {
  placePoints: [600, 450, 350, 280, 220, 170, 130, 100],
  driftPerMeter: 0.6,
  dhadaakBonus: 75,
  cleanLapBonus: 50,
  dailyLadder: [100, 150, 200, 300, 400, 500, 1000],
  startPoints: 500,
};

// Tracks are laid out from real OpenStreetMap (Nominatim) coordinates of Vadodara landmarks.
// Waypoints are [lat, lon, meta?]; tracks.js projects them to metres, scales them to `targetLength`
// and smooths them into a closed spline. meta.landmark names a hero model placed beside that point.
export const TRACKS = [
  {
    id: 'brightday', name: 'BRIGHT DAY CIRCUIT', short: 'Bright Day', city: 'Vadodara',
    tagline: 'From the Bright Day School (CBSE) gate on Vasna-Bhayli Road, through Natubhai Circle, Gotri and Sevasi',
    targetLength: 2600, halfWidth: 8, timeOfDay: 'day', style: 'suburb',
    waypoints: [
      [22.29079, 73.13373, { mark: 'start', landmark: 'brightday', label: 'BRIGHT DAY SCHOOL' }],
      [22.29300, 73.13900, { label: 'VASNA-BHAYLI ROAD' }],
      [22.29485, 73.14554, { label: 'VASNA ROAD' }],
      [22.30200, 73.15300],
      [22.30999, 73.15865, { landmark: 'circle', label: 'NATUBHAI CIRCLE' }],
      [22.31424, 73.13881, { label: 'GOTRI', landmark: 'mall' }],
      [22.31842, 73.11937, { label: 'SEVASI' }],
      [22.30500, 73.12100],
      [22.29052, 73.12697, { label: 'BHAYLI' }],
    ],
  },
  {
    id: 'oldcity', name: 'PALACE & OLD CITY', short: 'Old City', city: 'Vadodara',
    tagline: 'Laxmi Vilas Palace, Dandia Bazaar, Sursagar’s Shiva, Nyay Mandir and through Mandvi Gate',
    targetLength: 2200, halfWidth: 7, timeOfDay: 'sunset', style: 'heritage',
    waypoints: [
      [22.29185, 73.18833, { mark: 'start', landmark: 'palace', label: 'LAXMI VILAS PALACE' }],
      [22.29600, 73.19300],
      [22.30012, 73.19809, { label: 'DANDIA BAZAAR' }],
      [22.30060, 73.20180, { landmark: 'sursagar', label: 'SURSAGAR' }],
      [22.29954, 73.20594, { landmark: 'nyaymandir', label: 'NYAY MANDIR' }],
      [22.30015, 73.21066, { landmark: 'mandvi', label: 'MANDVI GATE' }],
      [22.29550, 73.20900],
      [22.29150, 73.20200],
      [22.28900, 73.19500],
    ],
  },
  {
    id: 'alkapuri', name: 'ALKAPURI – SAYAJIGUNJ', short: 'Alkapuri', city: 'Vadodara',
    tagline: 'Akota, Chakli Circle, Genda Circle, Fatehgunj, Sayaji Baug and the railway station',
    targetLength: 2800, halfWidth: 8, timeOfDay: 'night', style: 'city',
    waypoints: [
      [22.29341, 73.17205, { mark: 'start', label: 'AKOTA' }],
      [22.30841, 73.16516, { landmark: 'circle', label: 'CHAKLI CIRCLE' }],
      [22.31862, 73.17082, { landmark: 'circle', label: 'GENDA CIRCLE' }],
      [22.32395, 73.18854, { label: 'FATEHGUNJ' }],
      [22.31378, 73.19144, { landmark: 'sayajibaug', label: 'SAYAJI BAUG' }],
      [22.31107, 73.18080, { landmark: 'station', label: 'VADODARA JN' }],
      [22.31017, 73.17569, { label: 'ALKAPURI' }],
      [22.30100, 73.17500],
    ],
  },
];

export const LAPS = [1, 3, 5];
export const DIFFICULTY = { easy: 0.86, normal: 0.95, hard: 1.03 };
export const MAX_RACERS = 8;
export const TIMES = ['day', 'sunset', 'night'];
