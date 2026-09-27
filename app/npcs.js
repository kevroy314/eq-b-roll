// NPCs at their database spawn points, using the client's own creature models and animations.
//
// Everything here is a pure function of the world clock t, never of frame time: idle animation
// phase, where a patroller is along its path, whether it is walking or paused. That is what lets
// a render reproduce the preview exactly, and two renders of the same take match frame for frame.
import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { clone as skeletonClone } from './vendor/SkeletonUtils.js';
import { buildMaterials } from './zone.js';

const loader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();

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

// d_humch0001 -> {code:'hum', part:'ch', tex:'00', idx:'01'}. EQ texture names encode the body
// part and the armour set; heads encode the face in the first digit of idx.
const TEX_RE = /^(?:[a-z0-9]+_)?([a-z]{3})([a-z]{2})(\d\d)(\d\d)$/;

function variantName(matName, npc) {
  const m = TEX_RE.exec(matName);
  if (!m) return null;
  const [, code, part, tex, idx] = m;
  if (part === 'he') return `${code}he${tex}${npc.face % 10}${idx[1]}`;
  if (npc.tex > 0 && npc.tex < 100) return `${code}${part}${String(npc.tex).padStart(2, '0')}${idx}`;
  return null;
}

// Models the client animates with ANOTHER model's animation set (Kelethin guards use the wood elf
// set, Qeynos citizens the human one...). Lantern exports no clips for those, so we borrow from the
// first playable race whose skeleton contains every one of the model's bones; the mixer binds
// tracks by bone name, so a superset skeleton drives the model correctly.
const DONORS = { m: ['hum', 'elm', 'bam', 'dam', 'ham', 'him', 'erm', 'dwm', 'hom', 'gnm', 'ogm', 'trm'],
                 f: ['huf', 'elf', 'baf', 'daf', 'haf', 'hif', 'erf', 'dwf', 'hof', 'gnf', 'ogf', 'trf'] };

function boneNames(root) {
  const names = new Set();
  root.traverse(o => { if (o.isSkinnedMesh) for (const b of o.skeleton.bones) names.add(b.name); });
  return names;
}

export class NPCs {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'npcs';
    this.list = [];
    this.stats = { placed: 0, skipped: 0, unmapped: new Map(), borrowed: new Map() };
  }

  async load(zoneKey, data, { raceModels, raceSize, listing, groundAt, maxAniso, onProgress }) {
    const has = (where, name) => listing[where].models.includes(name);
    const hasTex = (where, name) => listing[where].textures.includes(name);
    const pick = (code, helm) => {
      // Zone-local models win (a zone's orcs are that zone's orcs); playable races come from global.
      for (const where of ['zone', 'global']) {
        if (helm > 0 && has(where, `${code}_${String(helm).padStart(2, '0')}`))
          return { where, file: `${code}_${String(helm).padStart(2, '0')}` };
        if (has(where, code)) return { where, file: code };
      }
      return null;
    };

    // One template per distinct look; instances are skeleton clones of it.
    const want = new Map();
    for (const [i, s] of data.spawns.entries()) {
      const g = raceModels[s.race];
      const code = g && (g[s.gender] ?? g[0] ?? g[2]);
      if (!code) { this.stats.skipped++; this.stats.unmapped.set(s.race, (this.stats.unmapped.get(s.race) || 0) + 1); continue; }
      const src = pick(code.toLowerCase(), s.helm);
      if (!src) { this.stats.skipped++; this.stats.unmapped.set(`${s.race}:${code}`, (this.stats.unmapped.get(`${s.race}:${code}`) || 0) + 1); continue; }
      const key = `${src.where}/${src.file}|${s.tex}|${s.face}`;
      if (!want.has(key)) want.set(key, { ...src, npc: s, spawns: [] });
      want.get(key).spawns.push(i);
    }

    const gltfCache = new Map();
    const getGltf = (where, file) => {
      const url = where === 'zone' ? `/zones/${zoneKey}/Characters/${file}.gltf` : `/zones/_global/Characters/${file}.gltf`;
      if (!gltfCache.has(url)) gltfCache.set(url, loader.loadAsync(url).catch(() => null));
      return gltfCache.get(url);
    };

    let done = 0;
    for (const [, t] of want) {
      const gltf = await getGltf(t.where, t.file);
      onProgress?.(++done / want.size);
      if (!gltf) { this.stats.skipped += t.spawns.length; continue; }
      const texBase = t.where === 'zone' ? `/zones/${zoneKey}/Characters/Textures` : '/zones/_global/Characters/Textures';
      const template = skeletonClone(gltf.scene);
      const meshes = [];
      template.traverse(o => {
        if (!o.isMesh) return;
        let mat = o.material;
        const v = variantName(mat.name, t.npc);
        if (v && hasTex(t.where, v) && mat.map) {
          const tex = texLoader.load(`${texBase}/${v}.png`);
          Object.assign(tex, { flipY: mat.map.flipY, wrapS: mat.map.wrapS, wrapT: mat.map.wrapT });
          mat = mat.clone();
          mat.map = tex;
        }
        o.userData.src = mat;
        o.frustumCulled = false;       // skinned bounds are bind-pose only; we distance-cull instead
        meshes.push(o);
      });
      buildMaterials(meshes, { maxAniso });
      let anims = gltf.animations;
      if (!anims.length) {
        const need = boneNames(gltf.scene);
        const order = t.npc.gender === 1 ? [...DONORS.f, ...DONORS.m] : [...DONORS.m, ...DONORS.f];
        for (const d of order) {
          if (!need.size || !has('global', d)) continue;
          const dg = await getGltf('global', d);
          if (!dg || !dg.animations.length) continue;
          const got = boneNames(dg.scene);
          if ([...need].every(n => got.has(n))) { anims = dg.animations; this.stats.borrowed.set(t.file, d); break; }
        }
      }
      const clips = Object.fromEntries(anims.map(c => [c.name, c]));
      const idleClip = clips.p01 || clips.o01 || anims[0];
      const walkClip = clips.l01 || idleClip;

      // Feet: measure the idle pose once, so instances stand on the ground rather than sink into it.
      const probe = skeletonClone(template);
      if (idleClip) { const m = new THREE.AnimationMixer(probe); m.clipAction(idleClip).play(); m.setTime(0); }
      probe.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(probe, true);
      const footY = isFinite(box.min.y) ? box.min.y : 0;

      for (const i of t.spawns) {
        const s = data.spawns[i];
        const inst = skeletonClone(template);
        const a = [], b = [];
        template.traverse(o => a.push(o)); inst.traverse(o => b.push(o));
        a.forEach((o, j) => { if (o.isMesh) { b[j].userData = { classic: o.userData.classic, sun: o.userData.sun, src: o.userData.src }; b[j].material = o.material; b[j].visible = o.visible; } });
        const normal = raceSize[s.race] || s.size || 1;
        const k = 0.1 * (s.size > 0 ? s.size / normal : 1);
        const holder = new THREE.Group();
        holder.add(inst);
        inst.scale.setScalar(k);
        inst.position.y = -footY * k;
        const mixer = idleClip ? new THREE.AnimationMixer(inst) : null;
        const idle = mixer && mixer.clipAction(idleClip);
        const walk = mixer && walkClip !== idleClip ? mixer.clipAction(walkClip) : null;
        idle?.play(); walk?.play();
        const npc = { s, holder, mixer, idle, walk, phase: hash01(i) * 10, path: null,
                      meshes: b.filter(o => o.isMesh) };
        const g = s.grid && data.grids[s.grid];
        if (g && g.wp.length > 1) npc.path = this._timeline(g, s, groundAt, i);
        const ground = groundAt(s.p);
        holder.position.set(s.p[0], ground ?? s.p[1], s.p[2]);
        holder.rotation.y = faceYaw(headingBeta(s.h));
        this.group.add(holder);
        this.list.push(npc);
        this.stats.placed++;
      }
    }
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
      if (n.mixer) {
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
