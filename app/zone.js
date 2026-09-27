// Loading a LanternExtractor zone export and turning it into something pleasant to film.
//
// Coordinates: we keep the glTF's own frame (metres, Y up). Lantern stores vertices as
// (eqY, eqZ, eqX) in EQ units and puts a diag(-0.1, 0.1, 0.1) matrix on every node; the negative
// X is not a bug, it converts EQ's left-handed world into glTF's right-handed one. Keeping it means
// the zone is the right way round (signs read correctly, north is where it should be).
//   world = (-eqY, eqZ, eqX) / 10          eqToWorld / worldToEq below
import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { mergeGeometries } from './vendor/BufferGeometryUtils.js';
import { computeBoundsTree, acceleratedRaycast } from './vendor/three-mesh-bvh.module.js';

// BVH raycasting: placing NPCs and walking them over terrain takes tens of thousands of downward
// rays per zone, and a plain raycast tests every one of ~200k triangles.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export const eqToWorld = (x, y, z) => new THREE.Vector3(-y / 10, z / 10, x / 10);
export const worldToEq = v => ({ x: v.z * 10, y: -v.x * 10, z: v.y * 10 });

// LanternExtractor instantiates a handful of objects the game parks at z = -32768 (never shown).
const SENTINEL_Y = -1000;

export async function loadZone(key, onProgress) {
  const gltf = await new GLTFLoader().loadAsync(`/zones/${key}/${key}.gltf`,
    e => e.total && onProgress?.(e.loaded / e.total));
  const root = gltf.scene;
  root.updateMatrixWorld(true);

  // Group every mesh by material and bake its world transform in. ~3,000 draw calls become ~150,
  // which is the difference between smooth flight and not on a streaming PC that is also running
  // OBS and the game.
  const groups = new Map();
  let hidden = 0;
  const box = new THREE.Box3();
  root.traverse(o => {
    if (!o.isMesh) return;
    box.setFromObject(o);
    if (box.max.y < SENTINEL_Y) { hidden++; return; }
    const g = plainGeometry(o.geometry);
    g.applyMatrix4(o.matrixWorld);
    // A mirroring matrix reverses triangle winding; put it back so back-face culling still works.
    if (o.matrixWorld.determinant() < 0) flipWinding(g);
    const sig = o.material.uuid + '|' + Object.keys(g.attributes).sort().join(',');
    if (!groups.has(sig)) groups.set(sig, { mat: o.material, geos: [] });
    groups.get(sig).geos.push(g);
  });

  const zone = new THREE.Group();
  zone.name = key;
  const meshes = [];
  for (const { mat, geos } of groups.values()) {
    const g = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (!g) { console.warn(`could not merge ${geos.length} meshes using ${mat.name}`); continue; }
    g.computeBoundingBox();
    g.computeBoundingSphere();
    g.computeBoundsTree();
    const m = new THREE.Mesh(g, mat);
    m.userData.src = mat;
    m.matrixAutoUpdate = false;
    zone.add(m);
    meshes.push(m);
  }
  zone.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  for (const m of meshes) bounds.union(m.geometry.boundingBox);
  return { key, group: zone, meshes, bounds, hidden, drawCalls: meshes.length };
}

// Lantern writes INTERLEAVED vertex buffers, which mergeGeometries refuses outright (and the merge
// then silently drops the whole material group). Copy just the attributes we draw with into plain,
// separate arrays — raw values, so normalised uint8 colours stay exactly as exported.
// COLOR_0 is deliberately dropped: Lantern's vertex colours are near-black on ~90% of Greater
// Faydark's grass, bark and canopy, so they are not a lighting multiplier we can use as-is.
const KEEP = ['position', 'normal', 'uv'];
function plainGeometry(src) {
  const g = new THREE.BufferGeometry();
  for (const name of KEEP) {
    const a = src.attributes[name];
    if (!a) continue;
    const n = a.count, k = a.itemSize;
    if (a.isInterleavedBufferAttribute) {
      const d = a.data, s = d.stride, o = a.offset, arr = new d.array.constructor(n * k);
      for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) arr[i * k + j] = d.array[i * s + o + j];
      g.setAttribute(name, new THREE.BufferAttribute(arr, k, a.normalized));
    } else {
      g.setAttribute(name, new THREE.BufferAttribute(a.array.slice(0, n * k), k, a.normalized));
    }
  }
  if (src.index) g.setIndex(new THREE.BufferAttribute(src.index.array.slice(0, src.index.count), 1));
  return g.index ? g : indexed(g);
}

function indexed(g) {
  const n = g.attributes.position.count;
  const idx = new (n > 65535 ? Uint32Array : Uint16Array)(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

function flipWinding(g) {
  if (!g.index) indexed(g);
  const a = g.index.array;
  for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
  g.index.needsUpdate = true;
}

// ─── looks ──────────────────────────────────────────────────────────────────────────────────────

// EQ's shader type is encoded in the material-name prefix Lantern writes (d_ diffuse, tm_ masked,
// t25_/t50_/t75_ translucent, ta_/tau_ additive, i_ invisible...). The glTF alpha settings are not
// trustworthy on their own: Lantern bakes a flat 50% alpha into t50_ textures and then marks the
// material MASK with cutoff 0.5 — 128/255 passes that test, so every pane of water and glass comes
// out fully OPAQUE. We rebuild each material from the prefix instead.
function shaderOf(name = '') {
  const pre = name.split('_')[0];
  if (pre === 't25') return { kind: 'blend', alpha: 0.25 };
  if (pre === 't50') return { kind: 'blend', alpha: 0.5 };
  if (pre === 't75') return { kind: 'blend', alpha: 0.75 };
  if (pre === 'ta' || pre === 'tau') return { kind: 'add' };
  if (pre === 'tm') return { kind: 'mask' };
  if (name === 'Invis' || pre === 'i') return { kind: 'invisible' };
  return { kind: 'opaque' };
}

const texLoader = new THREE.TextureLoader();
function frameTexture(url, like, maxAniso) {
  const t = texLoader.load(url);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  if (like) { t.wrapS = like.wrapS; t.wrapT = like.wrapT; t.flipY = like.flipY; }
  return t;
}

// Two lighting models. "classic" is full-bright texture with no dynamic lights, which is close to
// how the old client drew most zones. "sun" adds a directional light and sky fill on top, which
// gives outdoor zones shape they never had in 1999 — nice for b-roll, wrong for nostalgia.
//
// `anim` is materials.json from extraction: { materialName: { frames: [...], delay: ms } }.
// Returns the animated materials so the world clock can flip their frames.
export function buildMaterials(meshes, { maxAniso = 8, anim = {}, texBase = '' } = {}) {
  const animated = [];
  for (const m of meshes) {
    const src = m.userData.src;
    const sh = shaderOf(src.name);
    if (sh.kind === 'invisible') { m.visible = false; m.userData.invisible = true; }
    const common = {
      map: src.map || null, color: src.color?.clone() ?? new THREE.Color(1, 1, 1),
      side: src.side, transparent: false, opacity: 1, alphaTest: 0, depthWrite: true,
    };
    if (sh.kind === 'mask') common.alphaTest = 0.5;
    if (sh.kind === 'blend') Object.assign(common, { transparent: true, depthWrite: false });
    if (sh.kind === 'add') Object.assign(common, { transparent: true, depthWrite: false,
                                                    blending: THREE.AdditiveBlending });
    if (common.map) {
      common.map.colorSpace = THREE.SRGBColorSpace;
      common.map.anisotropy = maxAniso;     // EQ's 256px ground textures smear badly without it
      common.map.needsUpdate = true;
    }
    const a = anim[src.name];
    let frames = null;
    if (a && a.frames.length > 1 && texBase) {
      // Frames are the raw textures (no baked alpha), so translucency comes from opacity instead.
      frames = a.frames.map(f => frameTexture(`${texBase}/${f}.png`, common.map, maxAniso));
      common.map = frames[0];
      if (sh.kind === 'blend') common.opacity = sh.alpha;
    }
    // Additive fire/glow stays unlit in both modes, as it should.
    const unlit = src.type === 'MeshBasicMaterial' || sh.kind === 'add';
    m.userData.classic = new THREE.MeshBasicMaterial(common);
    m.userData.sun = unlit ? m.userData.classic : new THREE.MeshLambertMaterial(common);
    m.material = m.userData.classic;
    // Blended surfaces (water, glass) draw after opaque ones.
    if (common.transparent) m.renderOrder = 1;
    if (frames) animated.push({ mats: [...new Set([m.userData.classic, m.userData.sun])], frames, delay: a.delay || 200 });
  }
  return animated;
}

// World-clock tick for animated textures (water, lava, fire, waterfalls).
export function animateTextures(animated, t) {
  for (const a of animated) {
    const f = a.frames[Math.floor(t * 1000 / a.delay) % a.frames.length];
    for (const m of a.mats) if (m.map !== f) m.map = f;
  }
}

export function setLighting(meshes, mode) {
  for (const m of meshes) if (m.userData.classic) m.material = m.userData[mode] || m.userData.classic;
}

export function raycastZone(zone, origin, dir, far = 5000) {
  const rc = new THREE.Raycaster(origin, dir, 0, far);
  const hit = rc.intersectObjects(zone.meshes, false)
    .find(h => h.object.visible && !h.object.material.transparent);
  return hit || null;
}
