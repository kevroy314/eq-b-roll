// Path-math tests. No browser needed:  node dev/test_take.mjs
import assert from 'node:assert/strict';
import { KeyframeTake, FlightTake, takeFromJSON, easeProgress } from '../app/take.js';

const pose = (x, y, z, yaw = 0, pitch = 0, fov = 60) => ({ p: [x, y, z], yaw, pitch, roll: 0, fov });
const dist = (a, b) => Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]);
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

test('keyframe take starts and ends exactly on the first and last key', () => {
  const k = [pose(0, 0, 0, 0.1), pose(10, 2, 0, 0.5), pose(20, 0, 5, 1.0, 0.2, 40)];
  const t = new KeyframeTake(k, { speed: 2, ease: 0.2 });
  close(dist(t.sample(0), k[0]), 0, 1e-6, 'start');
  close(dist(t.sample(t.duration), k[2]), 0, 1e-6, 'end');
  close(t.sample(t.duration).fov, 40, 1e-6, 'end fov');
  close(t.sample(t.duration).pitch, 0.2, 1e-6, 'end pitch');
});

test('auto duration = path length / speed', () => {
  const t = new KeyframeTake([pose(0, 0, 0), pose(30, 0, 0)], { speed: 3, ease: 0 });
  close(t.duration, 10, 1e-3, 'duration');
});

test('with no easing the camera moves at constant speed, however unevenly keys are spaced', () => {
  const t = new KeyframeTake([pose(0, 0, 0), pose(1, 0, 0), pose(2, 0, 0), pose(40, 0, 10)], { speed: 5, ease: 0 });
  const steps = [];
  for (let i = 1; i <= 120; i++) steps.push(dist(t.sample((i - 1) / 120 * t.duration), t.sample(i / 120 * t.duration)));
  const mean = steps.reduce((a, b) => a + b) / steps.length;
  for (const s of steps) close(s / mean, 1, 0.03, 'step ratio');
});

test('ease ramps speed up from and down to zero', () => {
  const t = new KeyframeTake([pose(0, 0, 0), pose(100, 0, 0)], { speed: 10, ease: 0.25 });
  const v = (a, b) => dist(t.sample(a), t.sample(b)) / (b - a);
  assert.ok(v(0, 0.05) < 0.1 * v(4.9, 5.0), 'slow start');
  assert.ok(v(9.95, 10) < 0.1 * v(4.9, 5.0), 'slow end');
  close(t.sample(5).p[0], 50, 1e-3, 'symmetric midpoint');
});

test('easeProgress is monotonic and hits 0 and 1', () => {
  for (const r of [0, 0.1, 0.3, 0.5]) {
    let prev = -1;
    for (let i = 0; i <= 100; i++) { const u = easeProgress(i / 100, r); assert.ok(u >= prev - 1e-12); prev = u; }
    close(easeProgress(0, r), 0, 1e-12, 'zero');
    close(easeProgress(1, r), 1, 1e-12, 'one');
  }
});

test('yaw turns the short way across ±180°', () => {
  const t = new KeyframeTake([pose(0, 0, 0, 3.0), pose(10, 0, 0, -3.0)], { speed: 1, ease: 0 });
  const mid = t.sample(t.duration / 2).yaw;
  close(Math.abs(Math.cos(mid) + 1), 0, 0.01, 'midpoint faces ~180°, not 0°');
});

test('a single key is a locked-off shot', () => {
  const t = new KeyframeTake([pose(1, 2, 3, 0.4)], {});
  close(dist(t.sample(2), pose(1, 2, 3)), 0, 0, 'static');
});

test('flight smoothing removes jitter but keeps the ends', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  const raw = [];
  for (let i = 0; i <= 300; i++) {           // 5 s at 60 Hz with uneven frame times and shaky aim
    const t = i / 60 + rnd() * 0.004;
    raw.push({ t: Math.max(0, t), p: [t * 4, 1, 0], yaw: 0.5 * t + rnd() * 0.05, pitch: rnd() * 0.05, roll: 0, fov: 60 });
  }
  raw[0].t = 0;
  const jitter = take => {
    let s = 0;
    for (let i = 1; i < 299; i++) {
      const a = take.sample((i - 1) / 60).yaw, b = take.sample(i / 60).yaw, c = take.sample((i + 1) / 60).yaw;
      s += (a - 2 * b + c) ** 2;
    }
    return s;
  };
  const rough = new FlightTake(raw, { smooth: 0 }), smooth = new FlightTake(raw, { smooth: 0.3 });
  assert.ok(jitter(smooth) < jitter(rough) / 50, `jitter ${jitter(smooth)} vs ${jitter(rough)}`);
  close(smooth.sample(0).p[0], raw[0].p[0], 1e-9, 'starts exactly where the recording started');
  close(smooth.sample(smooth.duration).p[0], raw[raw.length - 1].p[0], 1e-9, 'ends exactly where it ended');
  close(smooth.sample(2.5).p[0], 10, 0.05, 'steady motion is not biased');
  close(smooth.duration, raw[raw.length - 1].t, 1e-9, 'duration');
});

test('takes survive a save/load round trip', () => {
  const k = new KeyframeTake([pose(0, 0, 0), pose(5, 1, 2, 1), pose(9, 0, 4, 2)], { speed: 2, ease: 0.3 });
  const k2 = takeFromJSON(JSON.parse(JSON.stringify(k.toJSON())));
  for (const t of [0, 1.3, k.duration]) close(dist(k.sample(t), k2.sample(t)), 0, 1e-9, 'keyframes');
  const f = new FlightTake([{ t: 0, ...pose(0, 0, 0) }, { t: 1, ...pose(1, 0, 0, 1) }, { t: 2, ...pose(3, 0, 0, 2) }], { smooth: 0.2 });
  const f2 = takeFromJSON(JSON.parse(JSON.stringify(f.toJSON())));
  for (const t of [0, 0.7, 2]) close(dist(f.sample(t), f2.sample(t)), 0, 1e-3, 'flight');
});

console.log(`\n${n} passed`);
