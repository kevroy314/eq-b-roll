// NPCs at their database spawn points, using the client's own creature models and animations.
//
// Everything here is a pure function of the world clock t, never of frame time: idle animation
// phase, where a patroller is along its path, whether it is walking or paused. That is what lets
// a render reproduce the preview exactly, and two renders of the same take match frame for frame.
import * as THREE from './vendor/three.module.js';
import { CharacterFactory } from './characters.js';

// Facing. A world direction is an angle beta = atan2(dx, dz). A model whose local "forward" is at
// angle MODEL_FWD faces beta when rotated by beta - MODEL_FWD. An EQ heading h (0 = north, which
// is world -X) faces beta = -pi/2 + HEADING_SIGN * h. Both are calibrated, not derived:
//   MODEL_FWD    a patroller filmed from straight ahead showed its profile at 0, its face at pi/2.
//   HEADING_SIGN people rarely stand facing a wall. Casting a ray forward from every standing
//                NPC, +1 leaves more room in front than -1 in all three test zones (Befallen 3.5 vs
//                2.0 units; facing a wall within 8 units: 4% vs 22%, gfaydark 3% vs 15%).
const MODEL_FWD = Math.PI / 2;
const HEADING_SIGN = 1;
const faceYaw = beta => beta - MODEL_FWD;
const headingBeta = h => -Math.PI / 2 + HEADING_SIGN * h;
const CULL_DIST = 160;             // world units (1,600 EQ units): beyond this NPCs are hidden
const WALK_MPS = 2.2;              // world units/s per unit of the DB's walkspeed (0.5 -> 11 EQ u/s)
const MAX_PAUSE = 30;              // s; some grids pause for minutes, which reads as "broken"

// Small deterministic hash so every NPC gets its own animation phase, stable across reloads.
function hash01(n) {
  let x = (n + 0x9e3779b9) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b); x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

export class NPCs {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'npcs';
    this.list = [];
    this.stats = { placed: 0, skipped: 0, unmapped: new Map(), borrowed: new Map() };
  }

  async load(zoneKey, data, { raceModels, raceSize, listing, groundAt, maxAniso, onProgress, factory }) {
    this.factory = factory || new CharacterFactory(zoneKey, { raceModels, raceSize, listing, maxAniso });
    const F = this.factory;
    // Group spawns by look so each model/texture combination is built once.
    const want = new Map();
    for (const [i, s] of data.spawns.entries()) {
      const src = F.resolve(s);
      if (!src || src.missing) {
        const k = src ? `${s.race}:${src.missing}` : s.race;
        this.stats.skipped++; this.stats.unmapped.set(k, (this.stats.unmapped.get(k) || 0) + 1);
        continue;
      }
      const key = `${src.where}/${src.file}|${s.tex}|${s.face}`;
      if (!want.has(key)) want.set(key, { spec: s, spawns: [] });
      want.get(key).spawns.push(i);
    }
    let done = 0;
    for (const [, w] of want) {
      const tpl = await F.template(w.spec);
      onProgress?.(++done / want.size);
      if (!tpl) { this.stats.skipped += w.spawns.length; continue; }
      for (const i of w.spawns) {
        const s = data.spawns[i];
        const a = F.instance(tpl, s, ['p01', 'l01']);
        a.idle = a.actions.get('p01') || null;
        a.walk = a.actions.get('l01') || null;
        if (a.idle) a.idle.setEffectiveWeight(1);
        const npc = { s, ...a, phase: hash01(i) * 10, path: null };
        const g = s.grid && data.grids[s.grid];
        if (g && g.wp.length > 1) npc.path = this._timeline(g, s, groundAt, i);
        const ground = groundAt(s.p);
        a.holder.position.set(s.p[0], ground ?? s.p[1], s.p[2]);
        a.holder.rotation.y = faceYaw(headingBeta(s.h));
        this.group.add(a.holder);
        this.list.push(npc);
        this.stats.placed++;
      }
    }
    this.stats.borrowed = F.borrowed;
    return this;
  }

  // Precompute a patrol as a looping schedule of walk segments and pauses, so position(t) is a
  // lookup rather than a simulation.
  _timeline(g, s, groundAt, i) {
    let pts = g.wp.map(p => { const y = groundAt(p); return new THREE.Vector3(p[0], y ?? p[1], p[2]); });
    let pauses = g.pause.slice();
    if (g.type === 3) {                                        // patrol: walk back down the list
      pts = pts.concat(pts.slice(1, -1).reverse());
      pauses = pauses.concat(pauses.slice(1, -1).reverse());
    }
    const speed = WALK_MPS * (s.walk || 0.5);
    const segs = [];
    let T = 0;
    for (let j = 0; j < pts.length; j++) {
      const a = pts[j], b = pts[(j + 1) % pts.length];
      const d = a.distanceTo(b);
      const walkT = d / speed;
      // Ground profile every ~0.5 units so walkers follow hills instead of cutting through them.
      const steps = Math.max(1, Math.ceil(d / 0.5));
      const ys = [];
      for (let k = 0; k <= steps; k++) {
        const f = k / steps, x = a.x + (b.x - a.x) * f, z = a.z + (b.z - a.z) * f, y0 = a.y + (b.y - a.y) * f;
        ys.push(groundAt([x, y0, z]) ?? y0);
      }
      segs.push({ a, b, t0: T, t1: T + walkT, ys, yaw: faceYaw(Math.atan2(b.x - a.x, b.z - a.z)) });
      T += walkT;
      const p = Math.min(MAX_PAUSE, pauses[(j + 1) % pts.length] || 0);
      segs.push({ a: b, b, t0: T, t1: T + p, pause: true });
      T += p;
    }
    return { segs, T: Math.max(T, 0.1), offset: hash01(i + 7777) * T };
  }

  update(t, camPos) {
    for (const n of this.list) {
      const near = n.holder.position.distanceTo(camPos) < CULL_DIST ||
                   (n.path && n.path.segs[0].a.distanceTo(camPos) < CULL_DIST + 60);
      n.holder.visible = near;
      if (!near) continue;
      let walking = false;
      if (n.path) {
        const P = n.path;
        const u = (t + P.offset) % P.T;
        let seg = P.segs[0];
        for (const sg of P.segs) if (u >= sg.t0 && u < sg.t1) { seg = sg; break; }
        const f = seg.t1 > seg.t0 ? (u - seg.t0) / (seg.t1 - seg.t0) : 0;
        n.holder.position.lerpVectors(seg.a, seg.b, f);
        if (seg.ys) {
          const q = f * (seg.ys.length - 1), k = Math.min(Math.floor(q), seg.ys.length - 2);
          n.holder.position.y = seg.ys.length > 1 ? seg.ys[k] + (seg.ys[k + 1] - seg.ys[k]) * (q - k) : seg.ys[0];
        }
        if (!seg.pause) {
          walking = true;
          n.holder.rotation.y = seg.yaw;
        }
      }
      if (n.mixer && n.idle) {
        n.idle.setEffectiveWeight(walking && n.walk ? 0 : 1);
        n.walk?.setEffectiveWeight(walking ? 1 : 0);
        n.mixer.setTime(t + n.phase);
      }
    }
  }

  meshes() { return this.list.flatMap(n => n.meshes); }

  dispose() {
    this.group.removeFromParent();
    this.list = [];
  }
}

export { faceYaw };
