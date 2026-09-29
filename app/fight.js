// A staged (mocked) fight, as a pure function of time. No physics, no randomness: given the world
// clock it says which animation each fighter shows and where the charging one is, so the preview
// and every render show the same fight. Tested in dev/test_fight.mjs.
//
// Roles: `a` is the one standing its ground (the player), `b` charges in from where it was placed.
//   before start   both idle
//   approach       b runs toward a until they are in reach
//   exchange       rounds of `round` seconds; b swings on even rounds, a on odd ones. The blow lands
//                  mid-swing and the defender flinches.
//   end            after `duration` seconds of exchange the loser plays its death and stays down;
//                  winner = 'none' means they keep fighting forever.

export const IDLE = 'p01';
const RUN = ['l02', 'l01'];
const HURT = ['d01', 'd02'];
const DEATH = ['d05', 'd04'];
const ATTACK_ORDER = ['c01', 'c02', 'c03', 'c05', 'c09', 'c10', 'c11', 'c04', 'c06', 'c07', 'c08'];

const first = (names, have) => names.find(n => have[n] !== undefined) ?? null;

// clips: { name: durationSeconds } for one fighter. Returns which clip to use for each role.
export function fighterClips(clips) {
  const attacks = ATTACK_ORDER.filter(n => clips[n] !== undefined);
  return {
    idle: clips[IDLE] !== undefined ? IDLE : null,
    run: first(RUN, clips),
    hurt: HURT.filter(n => clips[n] !== undefined),
    death: first(DEATH, clips),
    attacks,
    dur: clips,
  };
}

export function planFight({ start = 1, duration = 15, winner = 'a', runDist = 0, runSpeed = 3,
                            round = 1.8, a, b }) {
  return { start, duration, winner, runDist: Math.max(0, runDist), runSpeed: Math.max(0.1, runSpeed),
           round, a: fighterClips(a), b: fighterClips(b) };
}

const idle = (f, t) => ({ clip: f.idle, time: t, loop: true });

export function fightAt(t, P) {
  const u = t - P.start;
  if (u < 0) return { a: idle(P.a, t), b: idle(P.b, t), approach: 0, phase: 'before' };

  const tRun = P.runDist / P.runSpeed;
  if (u < tRun) {
    return { a: idle(P.a, t), b: { clip: P.b.run || P.b.idle, time: u, loop: true },
             approach: u / tRun, phase: 'approach' };
  }
  const x = u - tRun;
  if (P.winner !== 'none' && x >= P.duration) {
    const dead = P.winner === 'a' ? 'b' : 'a', live = P.winner;
    const d = P[dead];
    const out = { approach: 1, phase: 'end' };
    out[live] = idle(P[live], t);
    out[dead] = d.death ? { clip: d.death, time: x - P.duration, loop: false } : idle(d, t);
    return out;
  }

  const k = Math.floor(x / P.round), r = x - k * P.round;
  const atkRole = k % 2 === 0 ? 'b' : 'a', defRole = atkRole === 'a' ? 'b' : 'a';
  const atk = P[atkRole], def = P[defRole];
  const out = { approach: 1, phase: 'exchange', round: k, attacker: atkRole };
  const swing = atk.attacks.length ? atk.attacks[Math.floor(k / 2) % atk.attacks.length] : null;
  const swingDur = swing ? atk.dur[swing] : 0;
  out[atkRole] = swing && r < swingDur ? { clip: swing, time: r, loop: false } : idle(atk, t);
  // the blow lands a little before the middle of the swing
  const hitAt = swing ? Math.min(swingDur * 0.45, P.round * 0.5) : P.round * 0.4;
  const hurt = def.hurt.length ? def.hurt[k % def.hurt.length] : null;
  const hurtDur = hurt ? def.dur[hurt] : 0;
  out[defRole] = hurt && r >= hitAt && r < hitAt + hurtDur
    ? { clip: hurt, time: r - hitAt, loop: false } : idle(def, t);
  out.hit = r >= hitAt && r < hitAt + 0.1;
  return out;
}
