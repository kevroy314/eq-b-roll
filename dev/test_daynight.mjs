// Day/night maths tests:  node dev/test_daynight.mjs
import assert from 'node:assert/strict';
import { dayState, sunDirection, hourAt, hourLabel } from '../app/daynight.js';
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };
const close = (a, b, eps, m) => assert.ok(Math.abs(a - b) <= eps, `${m}: ${a} vs ${b}`);
const lum = c => (c[0] + c[1] + c[2]) / 3;

test('sun is up by day and down at night', () => {
  assert.ok(sunDirection(12).elev > 60);
  assert.ok(sunDirection(0).elev < -60);
  close(sunDirection(6).elev, 0, 1e-9, 'sunrise on the horizon');
  close(sunDirection(18).elev, 0, 1e-9, 'sunset on the horizon');
});

test('sun rises in the east (-Z) and sets in the west (+Z), noon in the south (+X)', () => {
  assert.ok(sunDirection(6.01).dir[2] < -0.9);
  assert.ok(sunDirection(17.99).dir[2] > 0.9);
  assert.ok(sunDirection(12).dir[0] > 0.3);
});

test('direction is a unit vector all day', () => {
  for (let h = 0; h < 24; h += 0.25) {
    const d = sunDirection(h).dir;
    close(Math.hypot(...d), 1, 1e-9, `|dir| at ${h}`);
  }
});

test('noon is full brightness, midnight is dim but not black', () => {
  close(lum(dayState(12).scene), 1, 1e-9, 'noon');
  const m = lum(dayState(0).scene);
  assert.ok(m > 0.2 && m < 0.45, `midnight ${m}`);
});

test('colours are continuous (no jumps between keyframes or across midnight)', () => {
  let prev = dayState(0);
  for (let h = 0.01; h <= 24.001; h += 0.01) {
    const s = dayState(h);
    for (const k of ['scene', 'sky', 'fog', 'sun'])
      for (let j = 0; j < 3; j++) assert.ok(Math.abs(s[k][j] - prev[k][j]) < 0.02, `${k} jumps at ${h.toFixed(2)}`);
    prev = s;
  }
});

test('stars only at night', () => {
  close(dayState(12).stars, 0, 0, 'noon');
  close(dayState(0).stars, 1, 0, 'midnight');
});

test('time-lapse clock wraps and runs backwards', () => {
  close(hourAt(0, 22, 3600), 22, 1e-9, 'start');
  close(hourAt(3, 22, 3600), 1, 1e-9, 'wraps past midnight');   // 1 game hour per real second
  close(hourAt(2, 1, -3600), 23, 1e-9, 'negative rate wraps');
});

test('labels', () => {
  assert.equal(hourLabel(0), '12:00 am');
  assert.equal(hourLabel(6.5), '6:30 am');
  assert.equal(hourLabel(13.25), '1:15 pm');
});

console.log(`\n${n} passed`);
