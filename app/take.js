// Takes: a camera move you can preview, save, and render frame-perfectly.
//
// A pose is { p:[x,y,z], yaw, pitch, roll, fov } in world metres / radians / degrees.
// Two kinds of take share one interface — sample(seconds) -> pose, plus .duration:
//
//   keyframes  a few poses you placed by hand; the camera moves between them along a centripetal
//              Catmull-Rom spline at CONSTANT speed (arc-length parameterised), with an optional
//              ease-in/out ramp. Constant speed is what makes a spline read as a camera dolly
//              rather than a camera that lurches between widely- and closely-spaced keys.
//   flight     a recording of you flying, sampled every frame, then resampled at render time and
//              optionally Gaussian-smoothed to take the mouse jitter out.
import * as THREE from './vendor/three.module.js';

const TAU = Math.PI * 2;

export function clonePose(q) {
  return { p: [...q.p], yaw: q.yaw, pitch: q.pitch, roll: q.roll, fov: q.fov };
}

// Yaw wraps; interpolating 350° -> 10° must go through 0°, not back round through 180°.
function unwrap(list, key) {
  for (let i = 1; i < list.length; i++) {
    let d = list[i][key] - list[i - 1][key];
    while (d > Math.PI) { list[i][key] -= TAU; d -= TAU; }
    while (d < -Math.PI) { list[i][key] += TAU; d += TAU; }
  }
}

// Uniform Catmull-Rom on a scalar — the angle channels follow the same segment/local-parameter
// as the position spline, so the camera arrives at each key looking exactly where you set it.
function cr(a, b, c, d, s) {
  const s2 = s * s, s3 = s2 * s;
  return 0.5 * ((2 * b) + (-a + c) * s + (2 * a - 5 * b + 4 * c - d) * s2 + (-a + 3 * b - 3 * c + d) * s3);
}

// Trapezoidal velocity profile: accelerate over the first `r` of the take, cruise, decelerate over
// the last `r`. r = 0 is constant speed. Returns the fraction of the path covered at time tau.
export function easeProgress(tau, r) {
  tau = Math.min(1, Math.max(0, tau));
  if (r <= 0) return tau;
  r = Math.min(r, 0.5);
  const v = 1 / (1 - r);
  if (tau < r) return v * tau * tau / (2 * r);
  if (tau > 1 - r) return 1 - v * (1 - tau) * (1 - tau) / (2 * r);
  return v * (tau - r / 2);
}

export class KeyframeTake {
  constructor(keys, opts = {}) {
    this.kind = 'keyframes';
    this.keys = keys.map(clonePose);
    this.ease = opts.ease ?? 0.2;
    this.speed = opts.speed ?? 3;          // world units/s (1 = 10 EQ units), for 'auto' duration
    this.durationMode = opts.durationMode ?? 'auto';
    this.fixedDuration = opts.duration ?? 10;
    this.build();
  }

  build() {
    const k = this.keys.map(clonePose);
    unwrap(k, 'yaw');
    unwrap(k, 'roll');
    this._k = k;
    this.curve = null;
    this.length = 0;
    if (k.length >= 2) {
      this.curve = new THREE.CatmullRomCurve3(k.map(q => new THREE.Vector3(...q.p)), false, 'centripetal');
      this.curve.arcLengthDivisions = Math.max(400, k.length * 200);
      this.length = this.curve.getLength();
    }
    const auto = this.length > 0 ? this.length / Math.max(this.speed, 0.01) : 5;
    this.duration = this.durationMode === 'auto' ? auto : this.fixedDuration;
    // An eased take covers the same ground in the same time, so it must cruise faster.
    this.duration = Math.max(0.5, this.duration);
  }

  sample(time) {
    const k = this._k;
    if (!k.length) return null;
    if (k.length === 1 || !this.curve) return clonePose(k[0]);
    const u = easeProgress(time / this.duration, this.ease);
    const p = this.curve.getPointAt(Math.min(1, Math.max(0, u)));
    const t = this.curve.getUtoTmapping(Math.min(1, Math.max(0, u)));
    const seg = t * (k.length - 1);
    const i = Math.min(Math.floor(seg), k.length - 2);
    const s = seg - i;
    const at = j => k[Math.min(k.length - 1, Math.max(0, j))];
    const a = at(i - 1), b = at(i), c = at(i + 1), d = at(i + 2);
    const ch = key => cr(a[key], b[key], c[key], d[key], s);
    return { p: [p.x, p.y, p.z], yaw: ch('yaw'), pitch: ch('pitch'), roll: ch('roll'), fov: ch('fov') };
  }

  // Dense polyline for drawing the path in the viewport.
  polyline(n = 400) {
    if (!this.curve) return [];
    return this.curve.getSpacedPoints(n);
  }

  toJSON() {
    return { kind: this.kind, keys: this.keys, ease: this.ease, speed: this.speed,
             durationMode: this.durationMode, duration: this.duration };
  }
}

export class FlightTake {
  constructor(samples, opts = {}) {
    this.kind = 'flight';
    this.samples = samples;                 // [{t, p, yaw, pitch, roll, fov}]
    this.smooth = opts.smooth ?? 0.25;      // Gaussian sigma, seconds
    this.build();
  }

  build() {
    const src = this.samples.map(s => ({ t: s.t, ...clonePose(s) }));
    unwrap(src, 'yaw');
    unwrap(src, 'roll');
    this.duration = src.length ? Math.max(0.5, src[src.length - 1].t) : 0.5;
    const sig = this.smooth;
    if (sig <= 0 || src.length < 3) { this._s = src; return; }
    // Gaussian smoothing in TIME, not in sample index — frame times during recording are uneven.
    // Near the ends the window SHRINKS symmetrically rather than being cut off on one side: a
    // one-sided window drags the first frame toward where you went next (by ~1 s of travel at
    // default settings), whereas a symmetric one leaves the take starting and stopping exactly
    // where you did, and leaves steady motion unbiased everywhere.
    const out = [];
    const tFirst = src[0].t, tLast = src[src.length - 1].t;
    for (let i = 0; i < src.length; i++) {
      const t0 = src[i].t;
      const h = Math.min(3 * sig, t0 - tFirst, tLast - t0);
      if (h <= 1e-6) { out.push(src[i]); continue; }
      const s2 = 2 * (h / 3) ** 2;
      let lo = i, hi = i;
      while (lo > 0 && src[lo - 1].t >= t0 - h) lo--;
      while (hi < src.length - 1 && src[hi + 1].t <= t0 + h) hi++;
      let w = 0, x = 0, y = 0, z = 0, yaw = 0, pitch = 0, roll = 0, fov = 0;
      for (let j = lo; j <= hi; j++) {
        const q = src[j], g = Math.exp(-((q.t - t0) ** 2) / s2);
        w += g; x += g * q.p[0]; y += g * q.p[1]; z += g * q.p[2];
        yaw += g * q.yaw; pitch += g * q.pitch; roll += g * q.roll; fov += g * q.fov;
      }
      out.push({ t: t0, p: [x / w, y / w, z / w], yaw: yaw / w, pitch: pitch / w, roll: roll / w, fov: fov / w });
    }
    this._s = out;
  }

  sample(time) {
    const s = this._s;
    if (!s.length) return null;
    if (time <= s[0].t) return clonePose(s[0]);
    if (time >= s[s.length - 1].t) return clonePose(s[s.length - 1]);
    let lo = 0, hi = s.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m].t <= time) lo = m; else hi = m; }
    const a = s[lo], b = s[hi], f = (time - a.t) / Math.max(1e-6, b.t - a.t);
    const L = (x, y) => x + (y - x) * f;
    return { p: [L(a.p[0], b.p[0]), L(a.p[1], b.p[1]), L(a.p[2], b.p[2])],
             yaw: L(a.yaw, b.yaw), pitch: L(a.pitch, b.pitch), roll: L(a.roll, b.roll), fov: L(a.fov, b.fov) };
  }

  polyline() {
    const s = this._s, step = Math.max(1, Math.floor(s.length / 600));
    const pts = [];
    for (let i = 0; i < s.length; i += step) pts.push(new THREE.Vector3(...s[i].p));
    return pts;
  }

  toJSON() {
    // Round to keep saved takes a sensible size — millimetres and ~0.006° are far below visible.
    const r = (x, n) => Math.round(x * n) / n;
    return { kind: this.kind, smooth: this.smooth, duration: this.duration,
             samples: this.samples.map(q => ({ t: r(q.t, 1e4), p: q.p.map(v => r(v, 1e3)),
               yaw: r(q.yaw, 1e4), pitch: r(q.pitch, 1e4), roll: r(q.roll, 1e4), fov: r(q.fov, 100) })) };
  }
}

export function takeFromJSON(d) {
  if (d.kind === 'flight') return new FlightTake(d.samples || [], { smooth: d.smooth });
  return new KeyframeTake(d.keys || [], d);
}
