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
    stats: { speed: 0.95, accel: 1.0, handling: 1.05 }, nitroMul: 1.0, winTitle: '🦖 OG BOSS OF BARODA 😤',
    shape: { gen: 'gen1', length: 3.5, width: 1.49, height: 1.46 }, paint: '#d8dde3' },
  { id: 'altoLxi', name: 'Alto LXi', era: '2005', tagline: 'The balanced daily driver', price: 0,
    stats: { speed: 0.97, accel: 1.0, handling: 1.02 }, nitroMul: 1.0, winTitle: '🛵 DAILY DRIVER DON 😎',
    shape: { gen: 'gen1f', length: 3.5, width: 1.49, height: 1.46 }, paint: '#b3121d' },
  { id: 'alto800', name: 'Alto 800', era: '2012', tagline: 'Cheap, cheerful, grippy', price: 1500,
    stats: { speed: 0.96, accel: 0.98, handling: 1.08 }, nitroMul: 1.0, winTitle: '💸 SASTA NAHI, SOLID HAI 🔥',
    shape: { gen: 'gen2', length: 3.43, width: 1.49, height: 1.47 }, paint: '#f2f2f0' },
  { id: 'k10gen1', name: 'Alto K10', era: '2010', tagline: 'The first pocket rocket', price: 2000,
    stats: { speed: 1.03, accel: 1.08, handling: 0.98 }, nitroMul: 1.0, winTitle: '🚀 POCKET ROCKET RAJA 👑',
    shape: { gen: 'gen2', length: 3.62, width: 1.49, height: 1.46 }, paint: '#1f4fa8' },
  { id: 'alto800bs6', name: 'Alto 800 BS6', era: '2019', tagline: 'Eco tuned, efficient nitro', price: 3000,
    stats: { speed: 0.98, accel: 1.02, handling: 1.04 }, nitroMul: 1.2, winTitle: '🌱 ECO KA BAAP 😤',
    shape: { gen: 'gen2', length: 3.45, width: 1.49, height: 1.47, facelift: true }, paint: '#9aa3ad' },
  { id: 'k10ags', name: 'Alto K10 AGS', era: '2014', tagline: 'Smooth auto box, easy drifts', price: 4000,
    stats: { speed: 1.02, accel: 1.04, handling: 1.06 }, nitroMul: 1.0, winTitle: '🤖 AUTOMATIC AASHIQ 💘',
    shape: { gen: 'gen2', length: 3.55, width: 1.49, height: 1.47, facelift: true }, paint: '#e5601d' },
  { id: 'altoCng', name: 'Alto S-CNG', era: '2016', tagline: 'Slow top end, huge nitro tank', price: 5000,
    stats: { speed: 0.94, accel: 1.0, handling: 1.03 }, nitroMul: 1.5, winTitle: '⛽ CNG KA KING 🔥',
    shape: { gen: 'gen2', length: 3.45, width: 1.49, height: 1.47 }, paint: '#2e8b57' },
  { id: 'k10gen3', name: 'Alto K10 (New)', era: '2022', tagline: 'The best all-rounder', price: 8000,
    stats: { speed: 1.06, accel: 1.08, handling: 1.05 }, nitroMul: 1.0, winTitle: '⚡ NAYA NAWAB 😎',
    shape: { gen: 'gen3', length: 3.53, width: 1.49, height: 1.52 }, paint: '#c8102e' },
];

// The two free starters, shown first in the garage. Balanced against each other:
// Lord Alto = quicker and grippier, Omni E = punchier launch, bigger nitro, loves to slide (driftiness > 1).
CARS.unshift(
  { id: 'lordAlto', name: 'LORD ALTO', era: 'Legend', tagline: 'Gold chrome. Glowing halo. Bow down.', price: 0, starter: true,
    stats: { speed: 1.03, accel: 1.0, handling: 1.05 }, nitroMul: 1.1, driftiness: 0.88, winTitle: '👑 TRU LORD 😎',
    shape: { gen: 'gen3', length: 3.53, width: 1.49, height: 1.52, legend: true }, paint: '#d4af37' },
  { id: 'omniE', name: 'OMNI E', era: '1984–2019', tagline: 'Sliding doors, zero fear. The van everyone knows.', price: 0, starter: true,
    stats: { speed: 0.99, accel: 1.05, handling: 0.98 }, nitroMul: 1.2, driftiness: 1.3, winTitle: '🚐 CERTIFIED KIDNAPER 💀',
    shape: { gen: 'omni', length: 3.37, width: 1.40, height: 1.64 }, paint: '#f4f4f0' },
  // Two-wheeler: instant electric torque, slips through gaps, but light, so it gets shoved around in a crash
  { id: 'evBike', name: 'EV BIKE', era: 'Electric', tagline: 'Silent, zippy, squeezes through any gap', price: 0, starter: true,
    stats: { speed: 0.96, accel: 1.14, handling: 1.12 }, nitroMul: 1.3, driftiness: 1.1, winTitle: '⚡ SILENT KILLER 🛵',
    bike: true, mass: 0.45, shape: { gen: 'scooter', length: 1.85, width: 0.7, height: 1.12 }, paint: '#d81e22' },
);

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
    id: 'brightday', name: 'SCHOOL SE GHAR TAK', short: 'School Se Ghar Tak', city: 'Vadodara',
    tagline: 'Petals → Shangri La → ADDA → Vidhi Collection → Bright Day School → back to Petals, on the real Vasna-Bhayli roads',
    targetLength: 3300, halfWidth: 6.5, timeOfDay: 'day', style: 'suburb',
    // Competitive tuning: a narrower, twistier road, faster rivals, and cows + police barricades to dodge
    wiggle: { every: 105, amp: 0.1, max: 34 }, aiBoost: 1.1, hazards: { every: 120 },
    // Ordered checkpoints: cross them in this order every lap; Petals is the finish line (sample 0).
    // msg = the in-joke bubble shown above a few Lord Altos / Omni Es when they pass it.
    checkpoints: [
      { id: 'shangrila', photo: 'full-shangrila.jpg', name: 'Shangri La', msg: 'Chinese Samosa 🥟' },
      { id: 'adda', photo: 'full-adda.jpg', name: 'ADDA 🫂', msg: 'Chalo Terrace Pe 😎' },
      { id: 'vidhi', photo: 'full-vidhi.jpg', name: 'Vidhi Collection', msg: null },
      { id: 'brightday', photo: 'full-brightday.jpg', name: 'Bright Day School CBSE', msg: 'Sabse Pyara School Hamara 🏫❤️' },
      { id: 'petals', photo: 'full-petals.jpg', name: 'Petals 🚬', msg: 'Fukte Hai Chalo 💀🚬', finish: true },
    ],
    // Approximate real positions: Petal Trillium on the 24 m High Tension Road (Bhayli, before Navrachana),
    // Alchemy Shangri La in Subhanpura, Bright Day School on Vasna-Bhayli Road (OSM). ADDA and Vidhi Collection
    // are not on public maps, so they sit on the Vasna side of the loop as reasonable approximations.
    waypoints: [
      [22.29500, 73.12250, { mark: 'start', landmark: 'petals', label: 'PETALS' }],
      [22.30500, 73.13000, { label: 'HIGH TENSION ROAD' }],
      [22.31300, 73.14200],
      [22.32139, 73.15498, { landmark: 'shangrila', label: 'SUBHANPURA' }],
      [22.31200, 73.15300],
      [22.30600, 73.15000, { landmark: 'adda', label: 'VASNA' }],
      [22.29485, 73.14554, { label: 'VASNA ROAD' }],
      [22.29250, 73.14000, { landmark: 'vidhi', label: 'VASNA-BHAYLI ROAD' }],
      [22.29079, 73.13373, { landmark: 'brightday', label: 'BRIGHT DAY SCHOOL' }],
      [22.28950, 73.12700, { label: 'BHAYLI' }],
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

// More circuits, laid out the same way from OpenStreetMap coordinates.
TRACKS.push(
  {
    id: 'eme', name: 'EME TEMPLE – FATEHGUNJ', short: 'EME Temple', city: 'Vadodara',
    tagline: 'Kala Ghoda Circle, the MSU Faculty of Arts dome, Nizampura, the aluminium EME Temple and Fatehgunj',
    targetLength: 2600, halfWidth: 8, timeOfDay: 'day', style: 'cantonment',
    waypoints: [
      [22.30894, 73.18808, { mark: 'start', landmark: 'circle', label: 'KALA GHODA CIRCLE' }],
      [22.30991, 73.18546, { landmark: 'msu', label: 'MSU FACULTY OF ARTS' }],
      [22.32000, 73.18150],
      [22.32886, 73.18257, { label: 'NIZAMPURA' }],
      [22.33161, 73.19170, { landmark: 'eme', label: 'EME TEMPLE' }],
      [22.32395, 73.18854, { label: 'FATEHGUNJ' }],
      [22.31600, 73.19000],
    ],
  },
  {
    id: 'harni', name: 'SAMA – HARNI AIRPORT', short: 'Harni Airport', city: 'Vadodara',
    tagline: 'Amit Nagar Circle, past Vadodara Airport, round Harni Motnath lake, through Sama and Karelibaug',
    targetLength: 3000, halfWidth: 9, timeOfDay: 'sunset', style: 'outskirts',
    waypoints: [
      [22.32748, 73.20748, { mark: 'start', landmark: 'circle', label: 'AMIT NAGAR CIRCLE' }],
      [22.33661, 73.21752, { label: 'HARNI' }],
      [22.33675, 73.22710, { landmark: 'airport', label: 'VADODARA AIRPORT' }],
      [22.34446, 73.21921, { landmark: 'harnilake', label: 'HARNI MOTNATH LAKE' }],
      [22.34252, 73.20203, { label: 'SAMA' }],
      [22.31831, 73.20152, { label: 'KARELIBAUG' }],
    ],
  },
  {
    id: 'makarpura', name: 'MAKARPURA – MANJALPUR', short: 'Makarpura', city: 'Vadodara',
    tagline: 'Susen Circle, Tarsali, Manjalpur, Makarpura Palace and the GIDC factories, at night',
    targetLength: 2700, halfWidth: 8, timeOfDay: 'night', style: 'industrial',
    waypoints: [
      [22.25731, 73.19911, { mark: 'start', landmark: 'circle', label: 'SUSEN CIRCLE' }],
      [22.25648, 73.20788, { label: 'TARSALI' }],
      [22.27000, 73.20800],
      [22.27587, 73.18793, { label: 'MANJALPUR' }],
      [22.26600, 73.19000, { landmark: 'makarpura', label: 'MAKARPURA PALACE' }],
      [22.25878, 73.18963, { label: 'MAKARPURA GIDC' }],
    ],
  },
);

export const LAPS = [1, 3, 5];
export const WEATHERS = ['clear', 'rain'];
export const DIFFICULTY = { easy: 0.86, normal: 0.95, hard: 1.03 };
export const MAX_RACERS = 8;
export const TIMES = ['day', 'sunset', 'night'];
