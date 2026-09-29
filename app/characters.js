// Character factory: turns a spec { race, gender, tex, helm, face, size } into an animated,
// correctly-textured, correctly-sized model standing on its feet. Used for zone NPCs (npcs.js)
// and for staged actors (staging.js), so both get identical models, armour and animation.
import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { clone as skeletonClone } from './vendor/SkeletonUtils.js';
import { buildMaterials } from './zone.js';

const loader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();

// d_humch0001 -> {code:'hum', part:'ch', tex:'00', idx:'01'}. EQ texture names encode the body
// part and the armour set; heads encode the face in the first digit of idx.
const TEX_RE = /^(?:[a-z0-9]+_)?([a-z]{3})([a-z]{2})(\d\d)(\d\d)$/;

function variantName(matName, spec) {
  const m = TEX_RE.exec(matName);
  if (!m) return null;
  const [, code, part, tex, idx] = m;
  if (part === 'he') return `${code}he${tex}${(spec.face || 0) % 10}${idx[1]}`;
  if (spec.tex > 0 && spec.tex < 100) return `${code}${part}${String(spec.tex).padStart(2, '0')}${idx}`;
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

export class CharacterFactory {
  constructor(zoneKey, { raceModels, raceSize, listing, maxAniso }) {
    Object.assign(this, { zoneKey, raceModels, raceSize, listing, maxAniso });
    this.gltfs = new Map();
    this.templates = new Map();
    this.borrowed = new Map();
  }

  has(where, name) { return this.listing[where].models.includes(name); }

  // race + gender (+ helm variant) -> which exported model file, zone-local first.
  resolve(spec) {
    const g = this.raceModels[spec.race];
    const code = g && (g[spec.gender] ?? g[0] ?? g[2]);
    if (!code) return null;
    const c = code.toLowerCase();
    for (const where of ['zone', 'global']) {
      const helmFile = `${c}_${String(spec.helm || 0).padStart(2, '0')}`;
      if (spec.helm > 0 && this.has(where, helmFile)) return { where, file: helmFile, code: c };
      if (this.has(where, c)) return { where, file: c, code: c };
    }
    return { missing: c };
  }

  gltf(where, file) {
    const url = where === 'zone' ? `/zones/${this.zoneKey}/Characters/${file}.gltf`
                                 : `/zones/_global/Characters/${file}.gltf`;
    if (!this.gltfs.has(url)) this.gltfs.set(url, loader.loadAsync(url).catch(() => null));
    return this.gltfs.get(url);
  }

  // One template per distinct look; instances are skeleton clones of it.
  async template(spec) {
    const src = this.resolve(spec);
    if (!src || src.missing) return null;
    const key = `${src.where}/${src.file}|${spec.tex || 0}|${spec.face || 0}`;
    if (this.templates.has(key)) return this.templates.get(key);
    const p = this._build(src, spec);
    this.templates.set(key, p);
    return p;
  }

  async _build(src, spec) {
    const gltf = await this.gltf(src.where, src.file);
    if (!gltf) return null;
    const texBase = src.where === 'zone' ? `/zones/${this.zoneKey}/Characters/Textures`
                                         : '/zones/_global/Characters/Textures';
    const root = skeletonClone(gltf.scene);
    const meshes = [];
    root.traverse(o => {
      if (!o.isMesh) return;
      let mat = o.material;
      const v = variantName(mat.name, spec);
      if (v && this.listing[src.where].textures.includes(v) && mat.map) {
        const tex = texLoader.load(`${texBase}/${v}.png`);
        Object.assign(tex, { flipY: mat.map.flipY, wrapS: mat.map.wrapS, wrapT: mat.map.wrapT });
        mat = mat.clone();
        mat.map = tex;
      }
      o.userData.src = mat;
      o.frustumCulled = false;       // skinned bounds are bind-pose only; callers distance-cull
      meshes.push(o);
    });
    buildMaterials(meshes, { maxAniso: this.maxAniso });

    let anims = gltf.animations;
    if (!anims.length) {
      // Best donor by bone coverage, needing at least 90%. Not "every bone": Lantern's name cleaning
      // occasionally mangles one (Qeynos guards export their right toe as `o_r` where every donor
      // has `to_r`), and demanding a perfect match left those guards frozen in their bind pose.
      // A bone no donor animates just keeps its rest pose.
      const need = boneNames(gltf.scene);
      const order = spec.gender === 1 ? [...DONORS.f, ...DONORS.m] : [...DONORS.m, ...DONORS.f];
      let best = null, bestCover = 0;
      for (const d of order) {
        if (!need.size || !this.has('global', d)) continue;
        const dg = await this.gltf('global', d);
        if (!dg || !dg.animations.length) continue;
        const got = boneNames(dg.scene);
        const cover = [...need].filter(n => got.has(n)).length / need.size;
        if (cover > bestCover) { best = { d, dg }; bestCover = cover; }
        if (cover === 1) break;
      }
      if (best && bestCover >= 0.9) { anims = best.dg.animations; this.borrowed.set(src.file, best.d); }
    }
    const clips = Object.fromEntries(anims.map(c => [c.name, c]));
    const idle = clips.p01 || clips.o01 || anims[0] || null;

    // Feet and height: measure the idle pose once, so instances stand on the ground rather than
    // sink into it, and so fights know how far apart two creatures should stand.
    const probe = skeletonClone(root);
    if (idle) { const m = new THREE.AnimationMixer(probe); m.clipAction(idle).play(); m.setTime(0); }
    probe.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(probe, true);
    const footY = isFinite(box.min.y) ? box.min.y : 0;
    const height = isFinite(box.max.y) ? box.max.y - footY : 6;
    return { root, clips, idle, footY, height, file: src.file };
  }

  // A placed, animatable copy. `clipNames` limits which clips get mixer actions (each action costs
  // a little every frame, and humans have 40+ clips).
  instance(tpl, spec, clipNames = ['p01', 'l01']) {
    const inst = skeletonClone(tpl.root);
    const a = [], b = [];
    tpl.root.traverse(o => a.push(o)); inst.traverse(o => b.push(o));
    a.forEach((o, j) => {
      if (!o.isMesh) return;
      b[j].userData = { classic: o.userData.classic, sun: o.userData.sun, src: o.userData.src };
      b[j].material = o.material;
      b[j].visible = o.visible;
    });
    const normal = this.raceSize[spec.race] || spec.size || 1;
    const k = 0.1 * (spec.size > 0 ? spec.size / normal : 1);
    const holder = new THREE.Group();
    holder.add(inst);
    inst.scale.setScalar(k);
    inst.position.y = -tpl.footY * k;
    const mixer = tpl.idle ? new THREE.AnimationMixer(inst) : null;
    const actions = new Map();
    if (mixer) {
      for (const n of clipNames) {
        const c = tpl.clips[n] || (n === 'p01' ? tpl.idle : null);
        if (c && !actions.has(n)) { const act = mixer.clipAction(c); act.play(); act.setEffectiveWeight(0); actions.set(n, act); }
      }
    }
    return { holder, inst, mixer, actions, height: tpl.height * k,
             meshes: b.filter(o => o.isMesh), clips: tpl.clips };
  }
}

// Show exactly one clip at an explicit time. Everything that animates is a pure function of the
// world clock, so this sets time rather than advancing it. loop=false holds the last frame (deaths).
export function showClip(actor, name, time, loop = true) {
  if (!actor.mixer) return;
  const act = actor.actions.get(name) || actor.actions.get('p01') || actor.actions.values().next().value;
  if (!act) return;
  for (const a of actor.actions.values()) a.setEffectiveWeight(a === act ? 1 : 0);
  const dur = act.getClip().duration || 1;
  act.time = loop ? ((time % dur) + dur) % dur : Math.min(Math.max(time, 0), dur - 1e-3);
  actor.mixer.update(0);
}
