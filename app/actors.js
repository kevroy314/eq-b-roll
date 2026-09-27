// Things the SERVER places, which therefore aren't in the zone export: doors, gates and lifts
// (the `doors` table) and NPCs (spawn points). Positions come pre-converted to world coordinates
// in app/zonedata/<zone>.json (see dev/bake_zonedata.py).
import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { buildMaterials } from './zone.js';

// EQ heading (radians) -> rotation about world Y. Calibrated, not derived: casting rays sideways
// from all 53 Kelethin doors, `yaw = h` seats them in their doorways (mean 0.64 to the jambs)
// while the other seven sign/quarter-turn combinations leave them skewed (0.94 - 2.70).
export const headingToYaw = h => h;

const loader = new GLTFLoader();

async function tryLoad(url) {
  try { return await loader.loadAsync(url); } catch { return null; }
}

// Object3D.clone() deep-copies userData through JSON, which would drop our material references,
// so clones get them copied back by walking both trees in step.
function cloneWithMaterials(src) {
  const dst = src.clone(true);
  const a = [], b = [];
  src.traverse(o => a.push(o));
  dst.traverse(o => b.push(o));
  a.forEach((o, i) => {
    if (!o.isMesh) return;
    b[i].userData.classic = o.userData.classic;
    b[i].userData.sun = o.userData.sun;
    b[i].userData.src = o.userData.src;
    b[i].material = o.material;
    b[i].visible = o.visible;
  });
  return dst;
}

export async function loadDoors(zoneKey, doors, { maxAniso, anim } = {}) {
  const group = new THREE.Group();
  group.name = 'doors';
  const meshes = [], animated = [];
  const names = [...new Set(doors.map(d => d.name))];
  const templates = new Map();
  await Promise.all(names.map(async name => {
    const g = await tryLoad(`/zones/${zoneKey}/Objects/${name}.gltf`);
    if (!g) return;
    const tm = [];
    g.scene.traverse(o => { if (o.isMesh) { o.userData.src = o.material; tm.push(o); } });
    animated.push(...buildMaterials(tm, { maxAniso, anim, texBase: `/zones/${zoneKey}/Objects/Textures` }));
    templates.set(name, g.scene);
  }));
  let placed = 0;
  for (const d of doors) {
    const t = templates.get(d.name);
    if (!t) continue;
    const inst = new THREE.Group();
    inst.position.set(...d.p);
    inst.rotation.y = headingToYaw(d.h);
    inst.scale.setScalar(0.1 * (d.size || 1));        // door models are in EQ units
    const c = cloneWithMaterials(t);
    inst.add(c);
    c.traverse(o => { if (o.isMesh) meshes.push(o); });
    group.add(inst);
    placed++;
  }
  group.updateMatrixWorld(true);
  return { group, meshes, animated, placed, missing: names.filter(n => !templates.has(n)) };
}
