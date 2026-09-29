// Staged fight tests:  node dev/test_fight.mjs
import assert from 'node:assert/strict';
import { planFight, fightAt } from '../app/fight.js';
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

const human = { p01: 3, l01: 1.2, l02: 0.8, c01: 1.0, c02: 1.2, c05: 0.9, d01: 0.5, d02: 0.6, d05: 1.5 };
const wisp = { p01: 2, c05: 0.7, o01: 1 };            // no run, no hurt, no death clips

test('before the start both idle', () => {
  const P = planFight({ start: 2, runDist: 6, a: human, b: human });
  const f = fightAt(1, P);
  assert.equal(f.phase, 'before'); assert.equal(f.a.clip, 'p01'); assert.equal(f.b.clip, 'p01');
});

test('the opponent runs in, covering the distance at run speed', () => {
  const P = planFight({ start: 0, runDist: 6, runSpeed: 3, a: human, b: human });
  const f = fightAt(1, P);
  assert.equal(f.phase, 'approach'); assert.equal(f.b.clip, 'l02');
  assert.ok(Math.abs(f.approach - 0.5) < 1e-9);
  assert.equal(fightAt(2.01, P).phase, 'exchange');
});

test('attacker alternates each round and the defender flinches mid-swing', () => {
  const P = planFight({ start: 0, runDist: 0, round: 2, a: human, b: human });
  const r0 = fightAt(0.1, P);
  assert.equal(r0.attacker, 'b'); assert.equal(r0.b.clip, 'c01'); assert.equal(r0.a.clip, 'p01');
  const hit = fightAt(0.5, P);                       // hit at 0.45 * 1.0s swing
  assert.equal(hit.a.clip, 'd01');
  const r1 = fightAt(2.1, P);
  assert.equal(r1.attacker, 'a'); assert.equal(r1.a.clip, 'c01'); assert.equal(r1.b.clip, 'p01');
  assert.equal(fightAt(4.1, P).b.clip, 'c02', 'next swing uses the next attack');
});

test('after the swing finishes the attacker returns to idle', () => {
  const P = planFight({ start: 0, runDist: 0, round: 2, a: human, b: human });
  assert.equal(fightAt(1.5, P).b.clip, 'p01');
});

test('the loser dies and stays down; the winner idles', () => {
  const P = planFight({ start: 0, runDist: 0, duration: 10, winner: 'a', a: human, b: human });
  const e = fightAt(11, P);
  assert.equal(e.phase, 'end'); assert.equal(e.b.clip, 'd05'); assert.equal(e.b.loop, false);
  assert.equal(e.a.clip, 'p01');
  assert.equal(fightAt(100, P).b.time, 90, 'death holds (non-looping, time keeps rising)');
});

test("winner 'none' fights forever", () => {
  const P = planFight({ start: 0, runDist: 0, duration: 5, winner: 'none', a: human, b: human });
  assert.equal(fightAt(500, P).phase, 'exchange');
});

test('creatures missing clips still work (idle fallbacks)', () => {
  const P = planFight({ start: 0, runDist: 3, duration: 4, winner: 'a', a: human, b: wisp });
  assert.equal(fightAt(0.5, P).b.clip, 'p01', 'no run clip: glides in idle');
  const hit = fightAt(1 + 2 * 1.8 + 0.5, P);         // after approach, round 2 = b attacks... any state
  assert.ok(hit.b.clip);
  assert.equal(fightAt(1 + 1.8 + 0.5, P).b.clip, 'p01', 'no hurt clip: stays idle when hit');
  assert.equal(fightAt(100, P).b.clip, 'p01', 'no death clip: stays idle at the end');
});

test('same time, same answer (deterministic)', () => {
  const P = planFight({ start: 1, runDist: 4, a: human, b: human });
  for (const t of [0, 1.3, 2.7, 9.99, 30]) assert.deepEqual(fightAt(t, P), fightAt(t, P));
});

console.log(`\n${n} passed`);
