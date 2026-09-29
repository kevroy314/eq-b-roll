// The stage: a player character and an opponent you place yourself, optionally fighting. Like the
// zone NPCs, everything here is a function of the world clock, so fights preview and render
// identically. The stage is saved inside takes.
import * as THREE from './vendor/three.module.js';
import { showClip } from './characters.js';
import { planFight, fightAt, IDLE } from './fight.js';
import { faceYaw } from './npcs.js';

// The clips a staged actor may need (see fight.js); others aren't bound, to keep mixers cheap.
const CLIPS = ['p01', 'l01', 'l02', 'd01', 'd02', 'd04', 'd05',
               'c01', 'c02', 'c03', 'c04', 'c05', 'c06', 'c07', 'c08', 'c09', 'c10', 'c11'];

export const PLAYER_RACES = [[1, 'Human'], [2, 'Barbarian'], [3, 'Erudite'], [4, 'Wood Elf'],
  [5, 'High Elf'], [6, 'Dark Elf'], [7, 'Half Elf'], [8, 'Dwarf'], [9, 'Troll'], [10, 'Ogre'],
  [11, 'Halfling'], [12, 'Gnome'], [128, 'Iksar'], [130, 'Vah Shir']];
export const ARMOUR = [[0, 'Cloth'], [1, 'Leather'], [2, 'Chain'], [3, 'Plate']];

const lookAt = (from, to) => faceYaw(Math.atan2(to.x - from.x, to.z - from.z));

export class Stage {
  constructor(factory, groundAt) {
    this.factory = factory;
    this.groundAt = groundAt;
    this.group = new THREE.Group();
    this.group.name = 'stage';
    this.slots = { a: null, b: null };     // a = player, b = opponent
    this.fight = null;                     // { start, duration, winner }
    this.plan = null;
  }

  // Place (or replace) an actor. pos is a THREE.Vector3 on the ground.
  async place(role, spec, pos, yaw = 0) {
    const tpl = await this.factory.template(spec);
    if (!tpl) throw new Error('No model for that race in this zone.');
    this.remove(role);
    const actor = this.factory.instance(tpl, spec, CLIPS);
    actor.holder.position.copy(pos);
    actor.holder.rotation.y = yaw;
    this.group.add(actor.holder);
    this.slots[role] = { spec, p: pos.clone(), yaw, actor };
    this._replan();
    return actor;
  }

  remove(role) {
    const s = this.slots[role];
    if (s) s.actor.holder.removeFromParent();
    this.slots[role] = null;
    this._replan();
  }

  clear() { this.remove('a'); this.remove('b'); this.fight = null; this.plan = null; }

  setFight(f) { this.fight = f; this._replan(); }

  // Reach: how far apart two fighters stand, from their measured heights.
  reach() {
    const { a, b } = this.slots;
    return 0.35 * (a.actor.height + b.actor.height) / 2 + 0.25;
  }

  _replan() {
    const { a, b } = this.slots;
    if (!this.fight || !a || !b) { this.plan = null; return; }
    const durs = act => Object.fromEntries(Object.entries(act.clips).map(([k, c]) => [k, c.duration]));
    const dist = Math.hypot(b.p.x - a.p.x, b.p.z - a.p.z);
    const reach = this.reach();
    this._from = b.p.clone();
    const dir = new THREE.Vector3(a.p.x - b.p.x, 0, a.p.z - b.p.z).normalize();
    this._to = a.p.clone().addScaledVector(dir, -reach);
    this.plan = planFight({ ...this.fight, runDist: Math.max(0, dist - reach), runSpeed: 2.6,
                            a: durs(a.actor), b: durs(b.actor) });
  }

  update(t) {
    const { a, b } = this.slots;
    if (this.plan && a && b) {
      const f = fightAt(t, this.plan);
      const bp = b.actor.holder.position;
      bp.lerpVectors(this._from, this._to, f.approach);
      const y = this.groundAt([bp.x, bp.y, bp.z], 2);
      if (y !== null) bp.y = y;
      a.actor.holder.rotation.y = lookAt(a.actor.holder.position, bp);
      b.actor.holder.rotation.y = lookAt(bp, a.actor.holder.position);
      showClip(a.actor, f.a.clip || IDLE, f.a.time, f.a.loop);
      showClip(b.actor, f.b.clip || IDLE, f.b.time, f.b.loop);
      return;
    }
    for (const s of [a, b]) {
      if (!s) continue;
      s.actor.holder.position.copy(s.p);
      if (a && b) s.actor.holder.rotation.y = lookAt(s.p, (s === a ? b : a).p);
      showClip(s.actor, IDLE, t);
    }
  }

  meshes() { return [this.slots.a, this.slots.b].filter(Boolean).flatMap(s => s.actor.meshes); }

  toJSON() {
    const slot = s => s && { spec: s.spec, p: s.p.toArray(), yaw: s.yaw };
    return { a: slot(this.slots.a), b: slot(this.slots.b), fight: this.fight };
  }

  async fromJSON(d) {
    this.clear();
    if (!d) return;
    for (const role of ['a', 'b']) {
      const s = d[role];
      if (s) await this.place(role, s.spec, new THREE.Vector3(...s.p), s.yaw);
    }
    if (d.fight) this.setFight(d.fight);
  }
}
