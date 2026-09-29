// EQ B-Roll — the app. Flight controls, take editing, preview, and the render button.
import * as THREE from './vendor/three.module.js';
import { loadZone, buildMaterials, setLighting, animateTextures, raycastZone,
         eqToWorld, worldToEq } from './zone.js';
import { KeyframeTake, FlightTake, takeFromJSON, clonePose } from './take.js';
import { renderTake, webCodecsAvailable } from './render.js';
import { loadDoors } from './actors.js';
import { NPCs } from './npcs.js';
import { Sky, SKY_PRESETS, presetForZone, skyAvailable } from './sky.js';
import { dayState, hourAt, hourLabel } from './daynight.js';
import { Stage, PLAYER_RACES, ARMOUR } from './staging.js';

const $ = id => document.getElementById(id);
const DEG = Math.PI / 180;

// ─── renderer / scene ──────────────────────────────────────────────────────────────────────────

const canvas = $('view');
// preserveDrawingBuffer: the encoder reads the canvas after render() returns.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true,
                                           powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
// Scale: the world is in Lantern's nominal metres, i.e. 10 EQ units each. EQ people are only
// ~6 units tall and dungeon ceilings can be 14 units up, so the near plane has to be small.
const U = 0.1;                               // one EQ unit, in world units
const EYE = 6 * U;                           // standing eye height
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 4000);
camera.rotation.order = 'YXZ';
const sky = new Sky();
scene.add(sky.mesh);
let haveSkyTextures = false;

// World clock: drives clouds, NPCs and anything else that moves. Free-running while you fly;
// during preview and render it is pinned to the take's own time, so every render of a take is
// identical and the preview shows exactly what will render.
let worldT = 0;
const tickers = [t => sky.update(t), t => zone && animateTextures(zone.animated, t),
                 t => zone?.npcs?.update(t, camera.position), t => zone?.stage?.update(t),
                 t => applyDay(t)];
function setWorldTime(t) { worldT = t; for (const f of tickers) f(t); }
const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2);
const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
scene.add(hemi, sun, sun.target);
const helpers = new THREE.Group();          // path line + key markers; never rendered to video
scene.add(helpers);

let zoneInfo = {};
let zone = null;
let zoneKey = null;

// ─── settings (persisted per browser; a take also carries its own copy of the look) ───────────

const store = {
  get(k, d) { try { const v = localStorage.getItem('broll.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('broll.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const look = {};                             // the current zone's look, see defaultLook()
const cam = {                                // flight-controller tuning
  moveSmooth: 0.35, lookSmooth: 0.12, sens: 1, invertY: false, speed: 3.5, boost: 4, ...store.get('cam', {}),
};

function hex(rgb) { return '#' + rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join(''); }
function mixHex(a, b, t) {
  const ca = new THREE.Color(a), cb = new THREE.Color(b);
  return '#' + ca.lerp(cb, t).getHexString();
}

function defaultLook(key) {
  const z = zoneInfo[key] || {};
  const fogRGB = z.fog && z.fog.some(v => v > 0) ? z.fog : [120, 130, 150];
  const horizon = hex(fogRGB);
  const outdoor = z.outdoor ?? true;
  return {
    lighting: 'classic', exposure: 1.2, tone: 'linear',
    fog: outdoor ? 0.45 : 0.3,
    skyTop: outdoor ? mixHex(horizon, '#2f5f9e', 0.65) : mixHex(horizon, '#000000', 0.5),
    skyHorizon: horizon, sunAz: 135, sunEl: 40, fov: 60,
    sky: 'auto', clouds: 1, wind: 1, npcs: true,
    dayOn: false, hour: 12, timelapse: 0,
  };
}

// Fog slider 0..1 -> far distance, log scale: 50 units of dungeon murk .. no fog at all.
const fogFar = v => v >= 0.995 ? Infinity : 5 * Math.pow(1000, v);

// Speeds, in EQ units/s, on a log slider (0..1000) so walking pace and a cross-zone fly-by are
// both easy to dial in. 1 u/s .. 20,000 u/s; the world moves in units of U (10 EQ units).
const SPEED_MIN = 1, SPEED_MAX = 20000;
const speedFromSlider = x => SPEED_MIN * Math.pow(SPEED_MAX / SPEED_MIN, x / 1000);
const sliderFromSpeed = u => 1000 * Math.log(Math.min(SPEED_MAX, Math.max(SPEED_MIN, u)) / SPEED_MIN) / Math.log(SPEED_MAX / SPEED_MIN);
const fmtSpeed = u => u >= 1000 ? `${(u / 1000).toFixed(u >= 10000 ? 0 : 1)}k u/s` : `${u < 10 ? u.toFixed(1) : Math.round(u)} u/s`;
const PRESETS = [12, 35, 90, 300, 1500, 8000];

function setSpeed(u) {
  cam.speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, u)) * U;
  store.set('cam', cam);
  $('speed')._sync?.();
}

// ── day/night ──
// Tints every lit material (fire and other additive glows are skipped, so they still burn at
// night), the fog/background and the sky, all from the world clock. Materials are gathered once
// per scene change and their original colour kept, so tinting never accumulates.
let tintMats = null, lastDayKey = '', sunDirNow = null;
function invalidateTint() { tintMats = null; lastDayKey = ''; }
function tintTargets() {
  if (tintMats) return tintMats;
  const set = new Set();
  const add = m => {
    for (const k of ['classic', 'sun']) {
      const mm = m.userData?.[k];
      if (mm && mm.blending !== THREE.AdditiveBlending) set.add(mm);
    }
  };
  zone?.meshes.forEach(add);
  zone?.npcs?.meshes().forEach(add);
  zone?.stage?.meshes().forEach(add);
  for (const m of set) if (!m.userData.baseColor) m.userData.baseColor = m.color.clone();
  return (tintMats = [...set]);
}

function applyDay(t = worldT) {
  if (!zoneKey) return;
  const day = look.dayOn ? dayState(hourAt(t, look.hour, look.timelapse * 60)) : null;
  const key = day ? day.hour.toFixed(3) : 'off';
  if (key === lastDayKey) return;
  lastDayKey = key;
  const preset = look.sky === 'auto' ? presetForZone(zoneInfo[zoneKey]) : look.sky;
  const horizon = new THREE.Color(look.skyHorizon);
  if (day) horizon.multiply(new THREE.Color(...day.fog));
  const up = day && day.sunElev > -3;
  sky.set(preset, { top: look.skyTop, horizon: '#' + horizon.getHexString(), wind: look.wind, clouds: look.clouds,
                    sunAz: look.sunAz, sunEl: look.sunEl, textures: haveSkyTextures,
                    day: day && { tint: day.sky, stars: day.stars, dir: up ? day.sunDir : day.moonDir, body: up ? 'sun' : 'moon' } });
  if (scene.fog) scene.fog.color.copy(horizon);
  scene.background = horizon;
  const tint = day ? new THREE.Color(...day.scene) : new THREE.Color(1, 1, 1);
  for (const m of tintTargets()) m.color.copy(m.userData.baseColor).multiply(tint);
  if (day) {
    sunDirNow = new THREE.Vector3(...(up ? day.sunDir : day.moonDir));
    sun.color.setRGB(...day.sun);
    sun.intensity = day.sunIntensity;
    hemi.intensity = 1.2 * (day.scene[0] + day.scene[1] + day.scene[2]) / 3;
  } else {
    sunDirNow = null;
    sun.color.set(0xfff1dc); sun.intensity = 2.2; hemi.intensity = 1.2;
  }
  $('hourOut').textContent = day ? hourLabel(day.hour) : '';
}

function applyLook() {
  if (zone) {
    setLighting(zone.meshes, look.lighting);
    if (zone.npcs) { setLighting(zone.npcs.meshes(), look.lighting); zone.npcs.group.visible = look.npcs; }
    if (zone.stage) setLighting(zone.stage.meshes(), look.lighting);
  }
  // "Linear" still needs a tone mapper: NoToneMapping would ignore the brightness slider.
  renderer.toneMapping = { aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping }[look.tone]
                         ?? THREE.LinearToneMapping;
  renderer.toneMappingExposure = look.exposure;
  const far = fogFar(look.fog);
  scene.fog = isFinite(far) ? new THREE.Fog(look.skyHorizon, far * 0.15, far) : null;
  hemi.color.set(look.skyTop).lerp(new THREE.Color(1, 1, 1), 0.5);
  hemi.groundColor.set(look.skyHorizon).multiplyScalar(0.4);
  const az = look.sunAz * DEG, el = look.sunEl * DEG;
  sun.position.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).multiplyScalar(1000);
  sun.position.add(camera.position);
  sun.target.position.copy(camera.position);
  $('sunRows').hidden = look.lighting !== 'sun' || look.dayOn;
  $('dayRows').hidden = !look.dayOn;
  lastDayKey = '';
  applyDay();
  hemi.visible = sun.visible = look.lighting === 'sun';
  store.set('look.' + zoneKey, look);
  syncLookUI();
}

// ─── flight controller ────────────────────────────────────────────────────────────────────────

const ctl = {
  pos: new THREE.Vector3(), vel: new THREE.Vector3(),
  yaw: 0, pitch: 0, roll: 0, fov: 60,       // smoothed (what the camera shows)
  tYaw: 0, tPitch: 0, tRoll: 0, tFov: 60,   // targets (what the mouse / keys asked for)
};
const keys = new Set();

function setPose(q, snap = true) {
  ctl.pos.set(...q.p);
  ctl.yaw = ctl.tYaw = q.yaw; ctl.pitch = ctl.tPitch = q.pitch;
  ctl.roll = ctl.tRoll = q.roll; ctl.fov = ctl.tFov = q.fov;
  if (snap) ctl.vel.set(0, 0, 0);
  applyPose(q);
}

function currentPose() {
  return { p: ctl.pos.toArray(), yaw: ctl.yaw, pitch: ctl.pitch, roll: ctl.roll, fov: ctl.fov };
}

function applyPose(q) {
  camera.position.set(...q.p);
  camera.rotation.set(q.pitch, q.yaw, q.roll, 'YXZ');
  if (camera.fov !== q.fov) { camera.fov = q.fov; camera.updateProjectionMatrix(); }
  camera.updateMatrixWorld();
}

function stepFlight(dt) {
  const k = tau => tau <= 0.001 ? 1 : 1 - Math.exp(-dt / tau);
  // roll and zoom are held keys, so they move the TARGET; smoothing does the rest
  if (keys.has('KeyZ')) ctl.tRoll += 40 * DEG * dt;
  if (keys.has('KeyX')) ctl.tRoll -= 40 * DEG * dt;
  if (keys.has('BracketLeft')) ctl.tFov = Math.max(10, ctl.tFov * Math.pow(0.6, dt));
  if (keys.has('BracketRight')) ctl.tFov = Math.min(120, ctl.tFov / Math.pow(0.6, dt));
  const lk = k(cam.lookSmooth);
  ctl.yaw += (ctl.tYaw - ctl.yaw) * lk;
  ctl.pitch += (ctl.tPitch - ctl.pitch) * lk;
  ctl.roll += (ctl.tRoll - ctl.roll) * k(Math.max(cam.lookSmooth, 0.15));
  ctl.fov += (ctl.tFov - ctl.fov) * k(0.15);

  const fwd = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(ctl.pitch, ctl.yaw, 0, 'YXZ'));
  const right = new THREE.Vector3(Math.cos(ctl.yaw), 0, -Math.sin(ctl.yaw));
  const dir = new THREE.Vector3();
  if (keys.has('KeyW')) dir.add(fwd);
  if (keys.has('KeyS')) dir.sub(fwd);
  if (keys.has('KeyD')) dir.add(right);
  if (keys.has('KeyA')) dir.sub(right);
  if (keys.has('KeyE') || keys.has('Space')) dir.y += 1;
  if (keys.has('KeyQ') || keys.has('KeyC')) dir.y -= 1;
  const boost = keys.has('ShiftLeft') || keys.has('ShiftRight') ? cam.boost : 1;
  const want = dir.lengthSq() ? dir.normalize().multiplyScalar(cam.speed * boost) : dir;
  ctl.vel.lerp(want, k(cam.moveSmooth));
  ctl.pos.addScaledVector(ctl.vel, dt);
  applyPose(currentPose());
}

canvas.addEventListener('click', () => {
  if (document.pointerLockElement !== canvas && !rendering) canvas.requestPointerLock?.();
});
document.addEventListener('pointerlockchange', () => {
  $('stage').classList.toggle('locked', document.pointerLockElement === canvas);
});
document.addEventListener('mousemove', e => {
  if (document.pointerLockElement !== canvas || playing) return;
  // Scale by FOV so zoomed-in shots aim finely instead of whipping around.
  const s = 0.0022 * cam.sens * (ctl.tFov / 60);
  ctl.tYaw -= e.movementX * s;
  ctl.tPitch -= e.movementY * s * (cam.invertY ? -1 : 1);
  ctl.tPitch = Math.max(-89 * DEG, Math.min(89 * DEG, ctl.tPitch));
});
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  setSpeed(cam.speed / U * Math.pow(1.15, -Math.sign(e.deltaY)));
}, { passive: false });

const typing = () => ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)
  && document.activeElement.type !== 'range' && document.activeElement.type !== 'checkbox';

addEventListener('keydown', e => {
  if (typing() || rendering) return;
  if (e.code === 'Tab') { e.preventDefault(); $('app').classList.toggle('clean'); layout(); return; }
  if (e.repeat) { keys.add(e.code); return; }
  keys.add(e.code);
  if (['Space', 'KeyQ', 'KeyE'].includes(e.code)) e.preventDefault();
  switch (e.code) {
    case 'KeyK': addKey(); break;
    case 'KeyR': toggleRecord(); break;
    case 'KeyP': togglePlay(); break;
    case 'KeyV': ctl.tRoll = 0; break;
    case 'KeyG': $('thirdsOn').checked = !$('thirdsOn').checked; $('thirds').classList.toggle('on'); break;
    case 'Backslash': ctl.tFov = look.fov; break;
    case 'Slash': $('help').classList.toggle('on'); break;
    case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': case 'Digit5': case 'Digit6':
      setSpeed(PRESETS[+e.code.slice(5) - 1]); flash(`Speed: ${fmtSpeed(cam.speed / U)}`); break;
  }
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

// ─── takes ────────────────────────────────────────────────────────────────────────────────────

let take = new KeyframeTake([], { speed: 3, ease: 0.2 });
let takeMode = 'keyframes';
let playing = false, playT = 0;
let recording = null;                        // { t0, samples } while recording a flight
let showPath = true;

function setTake(t) {
  take = t;
  takeMode = t.kind;
  playT = Math.min(playT, take.duration);
  syncTakeUI();
  drawPath();
  saveWorking();
}

function saveWorking() {
  store.set('working', { zone: zoneKey, name: $('takeName').value, take: take.toJSON(),
                         stage: zone?.stage?.toJSON() ?? null });
}

function addKey() {
  if (takeMode !== 'keyframes') setTake(new KeyframeTake([], { speed: speedFromSlider(+$('kfSpeed').value) * U, ease: +$('kfEase').value }));
  take.keys.push(clonePose(currentPose()));
  take.build();
  setTake(take);
  flash(`Key ${take.keys.length} added`);
}

function toggleRecord() {
  if (playing) stopPlay();
  if (recording) {
    const samples = recording.samples;
    recording = null;
    $('recBtn').classList.remove('on');
    if (samples.length > 5) {
      setTake(new FlightTake(samples, { smooth: +$('flSmooth').value }));
      flash(`Recorded ${take.duration.toFixed(1)} s`);
    }
  } else {
    if (takeMode !== 'flight') { takeMode = 'flight'; syncTakeUI(); }
    recording = { t0: performance.now(), samples: [] };
    $('recBtn').classList.add('on');
    canvas.requestPointerLock?.();
  }
}

function togglePlay() {
  if (recording) toggleRecord();
  if (playing) return stopPlay();
  if (take.duration <= 0 || (take.kind === 'keyframes' && !take.keys.length) ||
      (take.kind === 'flight' && !take.samples.length)) return flash('Nothing to preview yet');
  if (playT >= take.duration - 1e-3) playT = 0;
  playing = true;
  $('play').textContent = '■ Stop  P';
}

function stopPlay() {
  playing = false;
  $('play').innerHTML = '▶ Preview <kbd>P</kbd>';
  // Hand the camera back to flight from wherever the preview stopped — so you can stop on a frame
  // you like and keep flying from exactly there.
  const q = take.sample(playT);
  if (q) setPose(q);
}

function makeOrbit() {
  if (!zone) return;
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const hit = raycastZone(zone, camera.position.clone(), fwd);
  const center = hit ? hit.point : camera.position.clone().addScaledVector(fwd, 200 * U);
  const off = camera.position.clone().sub(center);
  const r = Math.max(10 * U, Math.hypot(off.x, off.z));
  const a0 = Math.atan2(off.x, off.z);
  const sweep = (+$('orbitDeg').value || 120) * DEG;
  const n = Math.max(3, Math.ceil(Math.abs(sweep) / (30 * DEG)) + 1);
  const keysOut = [];
  for (let i = 0; i < n; i++) {
    const a = a0 + sweep * i / (n - 1);
    const p = new THREE.Vector3(center.x + r * Math.sin(a), camera.position.y, center.z + r * Math.cos(a));
    const d = center.clone().sub(p);
    keysOut.push({ p: p.toArray(), yaw: Math.atan2(-d.x, -d.z),
                   pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)), roll: 0, fov: ctl.fov });
  }
  setTake(new KeyframeTake(keysOut, { speed: speedFromSlider(+$('kfSpeed').value) * U, ease: +$('kfEase').value }));
  flash(`Orbit: ${n} keys, radius ${(r / U).toFixed(0)} units`);
}

// Path line + a small marker per key, drawn only in the editor.
function drawPath() {
  for (const c of [...helpers.children]) { helpers.remove(c); c.geometry?.dispose(); c.material?.dispose(); }
  helpers.visible = showPath;
  const pts = take.polyline();
  if (pts.length >= 2) {
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    helpers.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xf0cf82, fog: false,
      depthTest: false, transparent: true, opacity: 0.8 })));
  }
  if (take.kind === 'keyframes') {
    take.keys.forEach((q, i) => {
      const m = new THREE.Mesh(new THREE.ConeGeometry(1.2 * U, 3 * U, 4).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: i === 0 ? 0x46a758 : 0xd9b35b, fog: false, depthTest: false,
                                      transparent: true, opacity: 0.9 }));
      m.position.set(...q.p);
      m.rotation.set(q.pitch, q.yaw, q.roll, 'YXZ');
      m.renderOrder = 10;
      helpers.add(m);
    });
  }
}

// ─── saving / loading takes ───────────────────────────────────────────────────────────────────

function takeDoc() {
  return { app: 'eq-broll', version: 1, name: $('takeName').value.trim() || 'take', zone: zoneKey,
           look: { ...look }, stage: zone?.stage?.toJSON() ?? null, ...take.toJSON() };
}

async function saveTake() {
  const doc = takeDoc();
  const name = doc.name.replace(/[^A-Za-z0-9_.\- ]/g, '_');
  const r = await fetch(`/api/takes/${encodeURIComponent(name)}`, { method: 'POST', body: JSON.stringify(doc, null, 1) });
  flash(r.ok ? `Saved takes/${name}.json` : 'Save failed');
  listTakes();
}

async function openTake(doc) {
  if (doc.zone && doc.zone !== zoneKey) {
    if (!zones.includes(doc.zone)) return flash(`That take is in ${doc.zone}, which isn't exported yet: pick it in the Zone list first.`);
    await selectZone(doc.zone, { keepTake: true });
  }
  if (doc.look) { Object.assign(look, doc.look); applyLook(); }
  if (zone?.stage) { await zone.stage.fromJSON(doc.stage); stageChanged(); }
  $('takeName').value = doc.name || 'take';
  playT = 0;
  setTake(takeFromJSON(doc));
  const q = take.sample(0);
  if (q) setPose(q);
}

async function listTakes() {
  const ul = $('takes');
  ul.innerHTML = '';
  try {
    const { takes } = await (await fetch('/api/takes')).json();
    for (const t of takes) {
      const li = document.createElement('li');
      li.innerHTML = `<span></span><small></small><button>Open</button>`;
      li.querySelector('span').textContent = t.name;
      li.querySelector('small').textContent = `${t.zone} · ${(t.duration ?? 0).toFixed(1)}s`;
      li.querySelector('button').onclick = async () =>
        openTake(await (await fetch(`/takes/${encodeURIComponent(t.name)}.json`)).json());
      ul.appendChild(li);
    }
  } catch { /* server without takes support */ }
}

// ─── zones ────────────────────────────────────────────────────────────────────────────────────

let zones = [];

async function selectZone(key, { keepTake = false } = {}) {
  if (key === zoneKey) return;
  if (playing) stopPlay();
  if (recording) toggleRecord();
  msg(`Loading ${zoneInfo[key]?.name || key}…`);
  if (zone) {
    scene.remove(zone.group);
    for (const m of zone.meshes) {
      m.geometry.dispose();
      for (const mat of new Set([m.userData.classic, m.userData.sun])) { mat.map?.dispose(); mat.dispose(); }
    }
    zone = null;
  }
  try {
    const z = await loadZone(key, f => msg(`Loading ${zoneInfo[key]?.name || key}… ${Math.round(f * 100)}%`));
    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    const getJSON = async (url, fallback) => { try { const r = await fetch(url); return r.ok ? await r.json() : fallback; } catch { return fallback; } };
    // materials.json: animated textures, written at extraction. zonedata: baked from the server DB.
    const [anim, data] = await Promise.all([getJSON(`/zones/${key}/materials.json`, {}),
                                            getJSON(`zonedata/${key}.json`, { spawns: [], grids: {}, doors: [] })]);
    z.animated = buildMaterials(z.meshes, { maxAniso, anim, texBase: `/zones/${key}/Textures` });
    z.data = data;
    msg(`Placing doors in ${zoneInfo[key]?.name || key}…`);
    const doors = await loadDoors(key, data.doors, { maxAniso, anim });
    z.group.add(doors.group);
    z.meshes.push(...doors.meshes);
    z.animated.push(...doors.animated);
    z.doors = doors;

    // NPCs: stand them on the walkable surface nearest their DB height (which is only roughly at
    // the feet). "Nearest", not "first hit below": under a Kelethin platform the first hit from
    // above is the platform, and on a hill the ground can be well above the expected height.
    const ground = z.meshes.filter(m => m.geometry.boundsTree);
    const rc = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    const groundAt = (p, reach = 5) => {
      rc.set(new THREE.Vector3(p[0], p[1] + reach, p[2]), down);
      rc.far = reach + 8;
      let best = null;
      for (const h of rc.intersectObjects(ground, false)) {
        if (!h.object.visible || h.object.material.transparent) continue;
        if (best === null || Math.abs(h.point.y - p[1]) < Math.abs(best - p[1])) best = h.point.y;
      }
      return best;
    };
    const [raceModels, raceSize, listing] = await Promise.all([
      getJSON('race_models.json', {}), getJSON('zonedata/_races.json', {}),
      getJSON(`/api/characters/${key}`, { zone: { models: [], textures: [] }, global: { models: [], textures: [] } })]);
    z.npcs = new NPCs();
    await z.npcs.load(key, data, { raceModels, raceSize, listing, groundAt, maxAniso,
      onProgress: f => msg(`Placing NPCs in ${zoneInfo[key]?.name || key}… ${Math.round(f * 100)}%`) });
    z.group.add(z.npcs.group);
    z.stage = new Stage(z.npcs.factory, groundAt);
    z.group.add(z.stage.group);
    z.groundAt = groundAt;
    zone = z;
    invalidateTint();
    fillStageUI();
    zoneKey = key;
    scene.add(z.group);
    $('zone').value = key;
    Object.keys(look).forEach(k => delete look[k]);
    Object.assign(look, defaultLook(key), store.get('look.' + key, {}));
    applyLook();
    const s = z.bounds.getSize(new THREE.Vector3());
    $('zoneStats').textContent = `${(s.x / U).toFixed(0)} × ${(s.z / U).toFixed(0)} units · ${z.drawCalls} draw calls` +
                                 ` · ${z.doors.placed} doors · ${z.npcs.stats.placed} NPCs` + (z.hidden ? ` · ${z.hidden} unplaced objects hidden` : '');
    store.set('zone', key);
    msg('');
    if (!keepTake) {
      const w = store.get('working', null);
      if (w && w.zone === key) {
        $('takeName').value = w.name || 'take1';
        setTake(takeFromJSON(w.take));
        if (w.stage) { try { await z.stage.fromJSON(w.stage); stageChanged(); } catch { /* model gone */ } }
      } else setTake(new KeyframeTake([], { speed: speedFromSlider(+$('kfSpeed').value) * U, ease: +$('kfEase').value }));
      goSafe();
    }
  } catch (err) {
    console.error(err);
    msg(`Could not load ${key}: ${err.message || err}`);
  }
}

function goSafe() {
  const z = zoneInfo[zoneKey];
  const p = z ? eqToWorld(...z.safe) : zone.bounds.getCenter(new THREE.Vector3());
  p.y += EYE;
  setPose({ p: p.toArray(), yaw: 0, pitch: -5 * DEG, roll: 0, fov: look.fov || 60 });
}

function goOverview() {
  const b = zone.bounds, c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3());
  const h = Math.max(s.x, s.z) * 0.55;
  setPose({ p: [c.x, b.max.y + h * 0.6, c.z + h], yaw: 0, pitch: -35 * DEG, roll: 0, fov: 60 });
  if (fogFar(look.fog) < h * 1.2) flash('The fog hides the zone from up here — drag Fog to the right to see it all.');
}

function goLoc(text) {
  // /loc prints "Your Location is Y, X, Z" — EQ lists Y first.
  const n = (text.match(/-?\d+(\.\d+)?/g) || []).map(Number);
  if (n.length < 2) return flash('Paste the numbers from /loc, e.g. 123.4, -56.7, 8.9');
  const p = eqToWorld(n[1], n[0], n[2] ?? 0);
  p.y += EYE;
  setPose({ ...currentPose(), p: p.toArray() });
}

// ─── layout: the view is always the output aspect ratio, so what you see is what renders ───────

function outSize() { const [w, h] = $('res').value.split('x').map(Number); return { w, h }; }

function layout() {
  const stage = $('stage').getBoundingClientRect();
  const { w, h } = outSize();
  const s = Math.min(stage.width / w, stage.height / h);
  const cw = Math.floor(w * s), ch = Math.floor(h * s);
  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  const th = $('thirds').style;
  th.width = cw + 'px'; th.height = ch + 'px';
  th.left = (stage.width - cw) / 2 + 'px'; th.top = (stage.height - ch) / 2 + 'px';
  if (!rendering) {
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(cw, ch, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}
addEventListener('resize', layout);

// ─── stage (player + opponent, optional fight) ─────────────────────────────────────────────────

let stageTypes = [];                          // distinct NPC looks in this zone, for the opponent list

function fillStageUI() {
  const F = zone.npcs.factory;
  const race = $('plRace');
  const keep = race.value;
  race.innerHTML = '';
  for (const [id, name] of PLAYER_RACES) {
    const o = new Option(name, id);
    const r = F.resolve({ race: id, gender: 0 });
    o.disabled = !r || !!r.missing;
    if (o.disabled) o.textContent += ' (no model)';
    race.add(o);
  }
  race.value = keep || '1';
  const seen = new Map();
  for (const s of zone.data.spawns) {
    const k = [s.name, s.race, s.gender, s.tex, s.helm, s.size].join('|');
    if (!seen.has(k)) {
      const r = F.resolve(s);
      if (r && !r.missing) seen.set(k, s);
    }
  }
  stageTypes = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.level - b.level);
  $('opType').innerHTML = '';
  stageTypes.forEach((s, i) => $('opType').add(new Option(`${s.name} (level ${s.level})`, i)));
  $('stageNote').textContent = '';
}

// Where the crosshair points, on the ground. Falls back to a spot 20 units ahead.
function crosshairGround() {
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const hit = raycastZone(zone, camera.position.clone(), fwd, 300);
  const p = hit ? hit.point.clone() : camera.position.clone().addScaledVector(fwd, 20 * U);
  const y = zone.groundAt([p.x, p.y, p.z], 3);
  if (y !== null) p.y = y;
  return p;
}

function stageChanged() {
  invalidateTint();
  setLighting(zone.stage.meshes(), look.lighting);
  zone.stage.update(worldT);
  lastDayKey = '';
  applyDay();
  saveWorking();
  const { a, b } = zone.stage.slots;
  $('stageNote').textContent = [a && 'Player placed', b && 'opponent placed',
    zone.stage.fight && `fight: ${zone.stage.fight.duration}s, ${{ a: 'player wins', b: 'opponent wins', none: 'no winner' }[zone.stage.fight.winner]}`]
    .filter(Boolean).join(' · ');
}

async function placeActor(role) {
  if (!zone) return;
  const p = crosshairGround();
  const face = Math.atan2(camera.position.x - p.x, camera.position.z - p.z) - Math.PI / 2;
  const spec = role === 'a'
    ? { race: +$('plRace').value, gender: +$('plGender').value, tex: +$('plTex').value, helm: +$('plHelm').value, face: 0, size: 0 }
    : (() => { const s = stageTypes[+$('opType').value]; return s && { race: s.race, gender: s.gender, tex: s.tex, helm: s.helm, face: s.face, size: s.size }; })();
  if (!spec) return flash('Pick an opponent first');
  try {
    msg('Placing…');
    await zone.stage.place(role, spec, p, face);
    msg('');
    stageChanged();
  } catch (err) { msg(''); flash(err.message || String(err)); }
}

function startFight() {
  const { a, b } = zone?.stage?.slots || {};
  if (!a || !b) return flash('Place a player and an opponent first');
  zone.stage.setFight({ start: 1, duration: +$('fightLen').value, winner: $('fightWinner').value });
  // The fight runs on the world clock; restarting it makes the fight begin a second from now, and
  // previews/renders (which start the clock at 0) show exactly the same fight.
  setWorldTime(0);
  playT = 0;
  stageChanged();
  flash('Fight starts in 1 s. It is saved with the shot, so previews and renders show it too.');
}

// ─── zone picker: everything in the client, exported on first use ──────────────────────────────

let clientZones = [];
let exportState = { current: null, queue: [], done: [], failed: [] };
let pendingZone = null, polling = false;
const zname = z => zoneInfo[z] ? `${zoneInfo[z].name} (${z})` : z;

function buildZoneSelect() {
  const sel = $('zone');
  sel.innerHTML = '';
  const ready = document.createElement('optgroup');
  ready.label = 'Ready';
  for (const z of [...zones].sort((a, b) => zname(a).localeCompare(zname(b)))) ready.appendChild(new Option(zname(z), z));
  sel.appendChild(ready);
  const more = clientZones.filter(z => !zones.includes(z));
  if (more.length) {
    const g = document.createElement('optgroup');
    g.label = 'In your client: exported the first time you pick it (about a minute)';
    for (const z of more.sort((a, b) => zname(a).localeCompare(zname(b)))) {
      const tag = exportState.current === z ? ' - exporting…' : exportState.queue.includes(z) ? ' - queued'
                : exportState.failed.includes(z) ? ' - failed to export' : '';
      g.appendChild(new Option(zname(z) + tag, z));
    }
    sel.appendChild(g);
  }
  sel.value = pendingZone || zoneKey || '';
  $('exportAll').hidden = !more.length || !!exportState.current;
  $('exportAll').textContent = `Export all ${more.length} remaining zones`;
  $('exportCancel').hidden = !(exportState.queue.length);
  const c = exportState.current;
  $('exportNote').textContent = c
    ? `Exporting ${zname(c)}…${exportState.queue.length ? ` ${exportState.queue.length} more queued.` : ''}`
    : exportState.failed.length ? `${exportState.failed.length} zone(s) could not be exported (some Planes of Power zones fail in LanternExtractor).` : '';
}

async function refreshZones() {
  const d = await (await fetch('/api/zones')).json();
  zones = d.zones; clientZones = d.client || []; exportState = d.extract || exportState;
  buildZoneSelect();
  return d;
}

async function pollExports() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      await refreshZones();
      if (pendingZone && zones.includes(pendingZone)) {
        const z = pendingZone; pendingZone = null; msg('');
        await selectZone(z);
      } else if (pendingZone && exportState.failed.includes(pendingZone) && exportState.current !== pendingZone) {
        msg(`Could not export ${zname(pendingZone)} from your client. Try another zone.`);
        pendingZone = null;
      }
      if (!exportState.current && !exportState.queue.length && !pendingZone) break;
      await new Promise(r => setTimeout(r, 2000));
    }
  } finally { polling = false; }
}

async function requestZone(z) {
  if (zones.includes(z)) { pendingZone = null; return selectZone(z); }
  pendingZone = z;
  msg(`Exporting ${zname(z)} from your EverQuest client…<br>This takes about a minute the first time; after that it loads instantly.`);
  const r = await fetch('/api/extract', { method: 'POST', body: JSON.stringify({ zones: [z] }) });
  if (!r.ok) { pendingZone = null; msg((await r.json()).error || 'Export failed to start.'); return; }
  pollExports();
}

async function exportAll() {
  const n = clientZones.filter(z => !zones.includes(z)).length;
  if (!confirm(`Export all ${n} remaining zones from your EverQuest client?\n\nRoughly ${Math.max(1, Math.round(n * 0.8 / 60 * 10) / 10)} hours and ${Math.round(n * 0.045)} GB of disk. You can keep using the Studio meanwhile; each zone appears under "Ready" as it finishes.`)) return;
  await fetch('/api/extract', { method: 'POST', body: JSON.stringify({ all: true }) });
  pollExports();
}

// Newer version on GitHub? Just a note in the panel; nothing is changed automatically.
async function checkForUpdate(v) {
  const cmp = (x, y) => {
    const a = x.split('.').map(Number), b = y.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
    return 0;
  };
  try {
    const r = await fetch('https://raw.githubusercontent.com/kevroy314/eq-b-roll/main/VERSION', { cache: 'no-store' });
    const latest = (await r.text()).trim();
    if (/^\d+\.\d+\.\d+$/.test(latest) && cmp(latest, v) > 0) {
      $('updateNote').hidden = false;
      $('updateNote').innerHTML = `Update available: v${latest}. Close the Studio window and run <b>Update.bat</b>.`;
    }
  } catch { /* offline */ }
}

// ─── render ───────────────────────────────────────────────────────────────────────────────────

let rendering = false;
let abortCtl = null;

async function doRender() {
  if (rendering) { abortCtl?.abort(); return; }
  if (!zone) return;
  if (!webCodecsAvailable()) return flash($('renderMsg').textContent);
  if (playing) stopPlay();
  if (recording) toggleRecord();
  const { w, h } = outSize();
  const fps = +$('fps').value;
  rendering = true;
  abortCtl = new AbortController();
  document.exitPointerLock?.();
  $('renderBtn').textContent = 'Cancel render';
  $('prog').hidden = false;
  $('renderMsg').textContent = 'Starting…';
  const saved = currentPose();
  const name = ($('takeName').value.trim() || 'take').replace(/[^A-Za-z0-9_.\- ]/g, '_');
  try {
    const out = await renderTake(take, {
      renderer, scene, camera, applyPose, setTime: setWorldTime,
      setOutputSize(W, H) {
        helpers.visible = false;
        renderer.setPixelRatio(1);
        renderer.setSize(W, H, false);
        camera.aspect = W / H;
        camera.updateProjectionMatrix();
      },
      restore() { helpers.visible = showPath; rendering = false; layout(); setPose(saved); },
    }, {
      width: w, height: h, fps, mbps: +$('mbps').value, blur: +$('blur').value, shutter: 0.5,
      signal: abortCtl.signal,
      onProgress: p => {
        $('prog').value = p.frame / p.frames;
        $('renderMsg').textContent = `Frame ${p.frame} / ${p.frames} · ${Math.ceil(p.eta)} s left`;
      },
    });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const file = `${zoneKey}_${name}_${w}x${h}_${fps}fps_${stamp}.mp4`;
    let where = '';
    try {
      const r = await fetch(`/api/renders/${encodeURIComponent(file)}`, { method: 'POST', body: out.blob });
      if (r.ok) where = `Saved to renders/${file}`;
    } catch { /* offline: download still works */ }
    const url = URL.createObjectURL(out.blob);
    $('videoEl').src = url;
    $('videoDl').href = url;
    $('videoDl').download = file;
    $('videoInfo').textContent = `${where || file} · ${(out.blob.size / 1e6).toFixed(1)} MB · ${out.frames} frames · ${out.codec}`;
    $('video').classList.add('on');
    $('renderMsg').textContent = where || 'Done — use Download to save it.';
  } catch (err) {
    $('renderMsg').textContent = err.name === 'AbortError' ? 'Cancelled.' : `Render failed: ${err.message || err}`;
    if (err.name !== 'AbortError') console.error(err);
  } finally {
    rendering = false;
    $('renderBtn').textContent = 'Render MP4';
    $('prog').hidden = true;
  }
}

// ─── UI wiring ────────────────────────────────────────────────────────────────────────────────

function msg(t) { $('msg').innerHTML = t; }
let flashTimer;
function flash(t) {
  $('msg').textContent = t;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { if ($('msg').textContent === t) msg(''); }, 1800);
}

function bindRange(id, get, set, fmt = v => v) {
  const el = $(id), out = el.parentElement.querySelector('output');
  const show = () => { if (out) out.textContent = fmt(+el.value); };
  el.addEventListener('input', () => { set(+el.value); show(); });
  el._sync = () => { el.value = get(); show(); };
  el._sync();
}

function syncLookUI() {
  for (const id of ['clouds', 'wind', 'exposure', 'fog', 'sunAz', 'sunEl', 'hour', 'timelapse']) $(id)._sync?.();
  $('dayOn').checked = !!look.dayOn;
  $('tone').value = look.tone;
  $('sky').value = look.sky;
  $('npcsOn').checked = look.npcs !== false;
  $('skyTop').value = look.skyTop;
  $('skyHorizon').value = look.skyHorizon;
  for (const b of $('lighting').children) b.classList.toggle('on', b.dataset.v === look.lighting);
}

function syncTakeUI() {
  for (const b of $('takeMode').children) b.classList.toggle('on', b.dataset.v === takeMode);
  $('kfUI').hidden = takeMode !== 'keyframes';
  $('flUI').hidden = takeMode !== 'flight';
  const ul = $('keys');
  ul.innerHTML = '';
  if (take.kind === 'keyframes') {
    take.keys.forEach((q, i) => {
      const li = document.createElement('li');
      const e = worldToEq(new THREE.Vector3(...q.p));
      li.innerHTML = `<b>${i + 1}</b><span>${e.y.toFixed(0)}, ${e.x.toFixed(0)}, ${e.z.toFixed(0)} · ${q.fov.toFixed(0)}°</span>`;
      const btn = (label, title, fn) => { const b = document.createElement('button'); b.textContent = label; b.title = title; b.onclick = fn; li.appendChild(b); };
      btn('go', 'Jump the camera to this key', () => setPose(q));
      btn('set', 'Replace this key with the current view', () => { take.keys[i] = clonePose(currentPose()); take.build(); setTake(take); });
      btn('✕', 'Delete this key', () => { take.keys.splice(i, 1); take.build(); setTake(take); });
      ul.appendChild(li);
    });
    $('kfSpeed')._sync?.();
    $('kfEase').value = take.ease; $('kfEase')._sync?.();
  } else if (take.kind === 'flight') {
    $('flSmooth').value = take.smooth; $('flSmooth')._sync?.();
  }
  updateTimeline();
}

function updateTimeline() {
  $('scrub').value = take.duration ? Math.round(playT / take.duration * 1000) : 0;
  $('tcode').textContent = `${playT.toFixed(1)} / ${take.duration.toFixed(1)} s`;
}

function wireUI() {
  $('zone').addEventListener('change', e => requestZone(e.target.value));
  $('exportAll').onclick = exportAll;
  $('exportCancel').onclick = async () => { await fetch('/api/extract/cancel', { method: 'POST', body: '{}' }); refreshZones(); };
  $('loc').addEventListener('keydown', e => { if (e.key === 'Enter') { goLoc(e.target.value); canvas.focus(); } });
  $('toSafe').onclick = goSafe;
  $('toTop').onclick = goOverview;

  for (const b of $('lighting').children) b.onclick = () => { look.lighting = b.dataset.v; applyLook(); };
  bindRange('exposure', () => look.exposure, v => { look.exposure = v; applyLook(); }, v => v.toFixed(2));
  bindRange('fog', () => look.fog, v => { look.fog = v; applyLook(); },
    v => isFinite(fogFar(v)) ? Math.round(fogFar(v) / U / 10) * 10 + ' u' : 'off');
  bindRange('sunAz', () => look.sunAz, v => { look.sunAz = v; applyLook(); }, v => v + '°');
  bindRange('sunEl', () => look.sunEl, v => { look.sunEl = v; applyLook(); }, v => v + '°');
  $('tone').onchange = e => { look.tone = e.target.value; applyLook(); };
  for (const [k, P] of Object.entries(SKY_PRESETS)) $('sky').add(new Option(P.label, k), $('sky').querySelector('[value=gradient]'));
  $('sky').onchange = e => { look.sky = e.target.value; applyLook(); };
  $('npcsOn').onchange = e => { look.npcs = e.target.checked; applyLook(); };
  bindRange('clouds', () => look.clouds, v => { look.clouds = v; applyLook(); }, v => Math.round(v * 100) + '%');
  bindRange('wind', () => look.wind, v => { look.wind = v; applyLook(); }, v => v.toFixed(1) + '×');
  $('skyTop').oninput = e => { look.skyTop = e.target.value; applyLook(); };
  $('skyHorizon').oninput = e => { look.skyHorizon = e.target.value; applyLook(); };
  $('resetLook').onclick = () => { Object.assign(look, defaultLook(zoneKey)); applyLook(); };

  bindRange('fov', () => ctl.tFov, v => { ctl.tFov = v; look.fov = v; }, v => v + '°');
  bindRange('speed', () => sliderFromSpeed(cam.speed / U), v => { cam.speed = speedFromSlider(v) * U; store.set('cam', cam); }, v => fmtSpeed(speedFromSlider(v)));
  for (const b of document.querySelectorAll('.speedPresets button')) b.onclick = () => setSpeed(+b.dataset.u);
  bindRange('boost', () => cam.boost, v => { cam.boost = v; store.set('cam', cam); }, v => v + '×');
  $('dayOn').onchange = e => { look.dayOn = e.target.checked; applyLook(); };
  bindRange('hour', () => look.hour, v => { look.hour = v; lastDayKey = ''; applyDay(); store.set('look.' + zoneKey, look); }, v => hourLabel(v));
  bindRange('timelapse', () => look.timelapse, v => { look.timelapse = v; lastDayKey = ''; applyDay(); store.set('look.' + zoneKey, look); },
    v => v === 0 ? 'off' : `${v > 0 ? '' : '−'}${Math.abs(v)} h/min`);
  for (const [id, name] of ARMOUR) $('plTex').add(new Option(name, id));
  $('placePlayer').onclick = () => placeActor('a');
  $('placeOpp').onclick = () => placeActor('b');
  bindRange('fightLen', () => 15, () => {}, v => v + ' s');
  $('fightBtn').onclick = startFight;
  $('clearStage').onclick = () => { zone?.stage?.clear(); stageChanged(); };
  const saveCam = () => store.set('cam', cam);
  bindRange('moveSmooth', () => cam.moveSmooth, v => { cam.moveSmooth = v; saveCam(); }, v => v.toFixed(2) + 's');
  bindRange('lookSmooth', () => cam.lookSmooth, v => { cam.lookSmooth = v; saveCam(); }, v => v.toFixed(2) + 's');
  bindRange('sens', () => cam.sens, v => { cam.sens = v; saveCam(); }, v => v.toFixed(2) + '×');
  $('invertY').checked = cam.invertY;
  $('invertY').onchange = e => { cam.invertY = e.target.checked; saveCam(); };
  $('thirdsOn').onchange = e => $('thirds').classList.toggle('on', e.target.checked);

  for (const b of $('takeMode').children) b.onclick = () => {
    takeMode = b.dataset.v;
    syncTakeUI();
  };
  $('addKey').onclick = addKey;
  $('clearKeys').onclick = () => {
    if (take.kind === 'keyframes' && take.keys.length > 2 && !confirm(`Delete all ${take.keys.length} keys?`)) return;
    setTake(new KeyframeTake([], { speed: speedFromSlider(+$('kfSpeed').value) * U, ease: +$('kfEase').value }));
  };
  bindRange('kfSpeed', () => sliderFromSpeed((take.speed ?? 3) / U), v => { if (take.kind === 'keyframes') { take.speed = speedFromSlider(v) * U; take.build(); setTake(take); } }, v => fmtSpeed(speedFromSlider(v)));
  bindRange('kfEase', () => take.ease ?? 0.2, v => { if (take.kind === 'keyframes') { take.ease = v; take.build(); setTake(take); } }, v => Math.round(v * 100) + '%');
  $('orbit').onclick = makeOrbit;
  $('recBtn').onclick = toggleRecord;
  bindRange('flSmooth', () => take.smooth ?? 0.3, v => { if (take.kind === 'flight') { take.smooth = v; take.build(); setTake(take); } }, v => v.toFixed(2) + 's');

  $('scrub').addEventListener('input', e => {
    if (playing) { playing = false; $('play').innerHTML = '▶ Preview <kbd>P</kbd>'; }
    playT = +e.target.value / 1000 * take.duration;
    const q = take.sample(playT);
    if (q) setPose(q);
    setWorldTime(playT);
    updateTimeline();
  });
  $('play').onclick = togglePlay;
  $('pathBtn').onclick = () => { showPath = !showPath; helpers.visible = showPath; $('pathBtn').textContent = showPath ? 'Hide path' : 'Show path'; };

  $('takeName').addEventListener('change', saveWorking);
  $('saveTake').onclick = saveTake;
  $('exportTake').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(takeDoc(), null, 1)], { type: 'application/json' }));
    a.download = `${$('takeName').value || 'take'}.json`;
    a.click();
  };
  $('importTake').onclick = () => $('importFile').click();
  $('importFile').onchange = async e => {
    const f = e.target.files[0];
    if (f) { try { await openTake(JSON.parse(await f.text())); } catch { flash('Not a take file'); } }
    e.target.value = '';
  };

  $('res').onchange = layout;
  bindRange('mbps', () => 30, () => {}, v => v + ' Mb/s');
  $('renderBtn').onclick = doRender;
  $('videoClose').onclick = () => { $('video').classList.remove('on'); $('videoEl').pause(); };
  if (!webCodecsAvailable()) {
    // WebCodecs only exists on secure origins; http://localhost counts, http://192.168.x.x does not.
    $('renderMsg').textContent = window.isSecureContext
      ? 'This browser cannot encode video — open this page in Chrome or Edge to render.'
      : `Rendering needs the page opened as http://localhost:${location.port || 80}/ (browsers only allow video encoding there).`;
  }
}

// ─── main loop ────────────────────────────────────────────────────────────────────────────────

let last = performance.now(), fpsAvg = 60;

function frame(now) {
  requestAnimationFrame(frame);
  if (rendering) return;                      // the renderer owns the canvas while encoding
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  fpsAvg += (1 / Math.max(dt, 1e-3) - fpsAvg) * 0.05;

  if (playing) {
    playT += dt;
    if (playT >= take.duration) { playT = take.duration; stopPlay(); }
    const q = take.sample(playT);
    if (q) applyPose(q);
    setWorldTime(playT);
    updateTimeline();
  } else {
    setWorldTime(worldT + dt);
    stepFlight(dt);
    if (recording) {
      recording.samples.push({ t: (now - recording.t0) / 1000, ...currentPose() });
    }
  }
  if (look.lighting === 'sun') {
    sun.target.position.copy(camera.position);
    if (sunDirNow) sun.position.copy(sunDirNow).multiplyScalar(1000).add(camera.position);
    else {
      const az = look.sunAz * DEG, el = look.sunEl * DEG;
      sun.position.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az))
        .multiplyScalar(1000).add(camera.position);
    }
  }
  renderer.render(scene, camera);

  const e = worldToEq(camera.position);
  const heading = ((-camera.rotation.y / DEG) % 360 + 360) % 360;
  $('hud').textContent =
    `/loc ${e.y.toFixed(1)}, ${e.x.toFixed(1)}, ${e.z.toFixed(1)}   heading ${heading.toFixed(0)}°\n` +
    `speed ${fmtSpeed(cam.speed / U)}${keys.has('ShiftLeft') || keys.has('ShiftRight') ? ` ×${cam.boost}` : ''}   fov ${camera.fov.toFixed(0)}°   ${fpsAvg.toFixed(0)} fps`;
  const badge = $('badge');
  if (recording) {
    badge.className = 'rec';
    badge.textContent = `● REC ${((now - recording.t0) / 1000).toFixed(1)}s`;
  } else if (playing) {
    badge.className = 'play';
    badge.textContent = `▶ ${playT.toFixed(1)}s`;
  } else if (badge.className) { badge.className = ''; badge.textContent = ''; }
}

async function main() {
  wireUI();
  layout();
  requestAnimationFrame(frame);
  zoneInfo = await (await fetch('zoneinfo.json')).json();
  haveSkyTextures = await skyAvailable();
  const d = await refreshZones();
  $('version').textContent = d.version ? `v${d.version}` : '';
  if (d.version && d.version !== 'dev') checkForUpdate(d.version);
  if (exportState.current || exportState.queue.length) pollExports();
  listTakes();
  if (!zones.length) {
    return msg(clientZones.length
      ? 'Pick a zone in the Zone list to export it from your EverQuest client.'
      : 'No zones yet, and no EverQuest folder is configured.<br><br>Run <code>Setup.bat</code>, or in a ' +
        'terminal in this folder run<br><code>python broll.py extract gfaydark --eq "C:/path/to/EverQuest"</code><br>then reload.');
  }
  const want = new URLSearchParams(location.search).get('zone');
  await selectZone(zones.includes(want) ? want : zones.includes(store.get('zone')) ? store.get('zone') : zones[0]);
  canvas.focus();
}

// Exposed for scripted testing (dev/smoke.mjs) — not used by the app itself.
window.broll = { THREE, scene, camera, renderer, get zone() { return zone; }, get take() { return take; },
  setPose, currentPose, setTake, selectZone, openTake, KeyframeTake, FlightTake, renderTake, applyPose,
  look, applyLook, applyDay, sky, setWorldTime, setSpeed, placeActor, startFight, requestZone, refreshZones, get worldT() { return worldT; }, tickers, goSafe, goOverview, makeOrbit, doRender };

main();
