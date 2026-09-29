// Day/night: an emulation of Norrath's day, close enough for b-roll rather than a reproduction of
// the client's lighting. Pure maths, no three.js, so it can be unit-tested (dev/test_daynight.mjs).
//
// Everything is a function of the hour (0-24). The hour itself is a function of the world clock:
// hour = start + rate * t, so a time-lapse renders identically every time, like everything else.
//
// Directions use the app's world frame: north is -X and EQ's +x (west) is +Z, so the sun rises in
// the east (-Z), culminates in the south (+X) and sets in the west (+Z).

const MAX_ELEVATION = 65;          // degrees at noon

export function hourAt(t, start, rate) {
  return (((start + rate * t / 3600) % 24) + 24) % 24;   // rate: game hours per real hour
}

// Unit vector toward the sun, plus its elevation in degrees (negative = below the horizon).
export function sunDirection(hour) {
  const a = (hour - 6) / 12 * Math.PI;                    // 0 at 6:00, pi at 18:00
  const elev = Math.sin(a) * MAX_ELEVATION;
  const e = elev * Math.PI / 180;
  // azimuth sweeps east (-Z) -> south (+X) -> west (+Z) during the day, and on round at night
  const x = Math.sin(a), z = -Math.cos(a);
  const h = Math.hypot(x, z) || 1;
  return { dir: [Math.cos(e) * x / h, Math.sin(e), Math.cos(e) * z / h], elev };
}

// Colour keyframes. `scene` multiplies every lit surface (fire and other additive glows are
// exempt, so torches still burn at night), `sky` multiplies the sky textures, `fog` the horizon /
// fog colour, `sun` is the directional light colour, `stars` their opacity.
const KEYS = [
  { h: 0,    scene: [0.26, 0.30, 0.48], sky: [0.10, 0.12, 0.26], fog: [0.18, 0.20, 0.34], sun: [0.35, 0.40, 0.65], stars: 1 },
  { h: 4.5,  scene: [0.28, 0.31, 0.48], sky: [0.12, 0.14, 0.30], fog: [0.20, 0.22, 0.36], sun: [0.35, 0.40, 0.65], stars: 1 },
  { h: 6,    scene: [0.72, 0.56, 0.52], sky: [0.70, 0.46, 0.46], fog: [0.85, 0.58, 0.50], sun: [1.00, 0.62, 0.40], stars: 0.2 },
  { h: 7.5,  scene: [0.95, 0.88, 0.80], sky: [0.95, 0.88, 0.82], fog: [0.98, 0.90, 0.82], sun: [1.00, 0.88, 0.72], stars: 0 },
  { h: 9,    scene: [1, 1, 1],          sky: [1, 1, 1],          fog: [1, 1, 1],          sun: [1.00, 0.97, 0.90], stars: 0 },
  { h: 16,   scene: [1, 1, 1],          sky: [1, 1, 1],          fog: [1, 1, 1],          sun: [1.00, 0.95, 0.86], stars: 0 },
  { h: 17.5, scene: [0.96, 0.82, 0.70], sky: [0.98, 0.78, 0.66], fog: [1.00, 0.80, 0.64], sun: [1.00, 0.72, 0.48], stars: 0 },
  { h: 18.5, scene: [0.78, 0.52, 0.46], sky: [0.82, 0.44, 0.40], fog: [0.92, 0.52, 0.42], sun: [1.00, 0.50, 0.30], stars: 0.15 },
  { h: 20,   scene: [0.36, 0.36, 0.54], sky: [0.20, 0.20, 0.40], fog: [0.28, 0.28, 0.44], sun: [0.40, 0.42, 0.68], stars: 0.8 },
  { h: 24,   scene: [0.26, 0.30, 0.48], sky: [0.10, 0.12, 0.26], fog: [0.18, 0.20, 0.34], sun: [0.35, 0.40, 0.65], stars: 1 },
];

function smooth(f) { return f * f * (3 - 2 * f); }

export function dayState(hour) {
  hour = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].h <= hour) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const f = smooth((hour - a.h) / (b.h - a.h));
  const mix = k => a[k].map((v, j) => v + (b[k][j] - v) * f);
  const { dir, elev } = sunDirection(hour);
  return {
    hour, scene: mix('scene'), sky: mix('sky'), fog: mix('fog'), sun: mix('sun'),
    stars: a.stars + (b.stars - a.stars) * f,
    sunDir: dir, sunElev: elev,
    // The moon rides opposite the sun, so there is always one body in the sky to film.
    moonDir: dir.map(v => -v),
    // Directional light strength: full by day, a faint moonlight at night.
    sunIntensity: elev > 0 ? 0.5 + 1.7 * Math.min(1, elev / 25) : 0.35,
  };
}

// "6:30 am" style label for the UI.
export function hourLabel(h) {
  const hh = Math.floor(h) % 24, mm = Math.floor((h - Math.floor(h)) * 60);
  const ap = hh < 12 ? 'am' : 'pm', h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${ap}`;
}
