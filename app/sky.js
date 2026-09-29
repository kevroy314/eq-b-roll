// The sky: EverQuest's own sky textures (from sky.s3d) on a camera-centred dome.
//
// The old client drew skies as two flattened domes, a far "sky" layer and a nearer cloud layer,
// both tiled and slowly scrolling. We do the same in one shader: each view ray is projected onto
// two virtual ceilings at different heights, which gives the tiling the right foreshortening
// toward the horizon, and the horizon itself fades into the zone's fog colour so distant
// geometry and sky meet without a seam.
//
// Everything that moves reads `time` from the world clock, never the wall clock, so a rendered
// video is identical no matter how long each frame takes.
import * as THREE from './vendor/three.module.js';

// DB `zone.sky` -> [sky layer, cloud layer, celestial]. Hand-matched from which zones use each id
// (1 = Qeynos/Commons, 2 = the Ro deserts, 4 = Kunark/Velious, 6-7 = Luclin, 9 = the Grey, 11+ =
// Planes of Power). Approximate: the client picks layers from sky.wld, which Lantern doesn't export.
export const SKY_PRESETS = {
  normal:  { label: 'Norrath (blue)',     sky: 'normalsky',    cloud: 'normalcloud',    body: 'sun' },
  fluffy:  { label: 'Norrath (fluffy)',   sky: 'cottonysky',   cloud: 'fluffycloud',    body: 'sun' },
  desert:  { label: 'Desert',             sky: 'desertsky',    cloud: 'desertcloud',    body: 'sun' },
  red:     { label: 'Red (Fear, Fire)',   sky: 'redcloud',     cloud: 'redcloud',       body: null },
  luclin:  { label: 'Luclin',             sky: 'luclinsky3',   cloud: 'luclincloud1',   body: 'earthrise' },
  luclinDark: { label: 'Luclin (dark)',   sky: 'luclinsky3',   cloud: 'luclincloud2',   body: 'saturn', dim: 0.45 },
  grey:    { label: 'The Grey',           sky: 'thegreysky',   cloud: 'thegreyclouds',  body: null },
  pofire:  { label: 'Plane of Fire',      sky: 'pofiresky2',   cloud: 'redcloud',       body: null },
  povalor: { label: 'Planes (tranquil)',  sky: 'potranqsky1',  cloud: 'fluffycloud',    body: null },
  poearth: { label: 'Planes (earth)',     sky: 'botsky1',      cloud: 'normalcloud',    body: null },
  postorms:{ label: 'Plane of Storms',    sky: 'postormsky1a', cloud: 'powarclouds1',   body: null },
  poair:   { label: 'Plane of Air',       sky: 'poairpop173',  cloud: 'fluffycloud',    body: 'sun' },
};
const BY_ID = { 0: 'normal', 1: 'normal', 2: 'desert', 3: 'fluffy', 4: 'fluffy', 5: 'red', 6: 'luclin',
                7: 'luclinDark', 8: 'fluffy', 9: 'grey', 11: 'pofire', 12: 'povalor', 13: 'poearth',
                14: 'poearth', 15: 'grey', 16: 'postorms', 17: 'poair' };

export function presetForZone(info) {
  if (info && info.outdoor === false) return 'none';
  return BY_ID[info?.sky] || 'normal';
}

const loader = new THREE.TextureLoader();
const cache = new Map();
function tex(name) {
  if (!cache.has(name)) {
    const t = loader.load(`/zones/_sky/Textures/${name}.png`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    cache.set(name, t);
  }
  return cache.get(name);
}

export async function skyAvailable() {
  try { return (await fetch('/zones/_sky/Textures/normalsky.png', { method: 'HEAD' })).ok; }
  catch { return false; }
}

export class Sky {
  constructor() {
    this.uniforms = {
      skyTex: { value: null }, cloudTex: { value: null }, bodyTex: { value: null },
      useTex: { value: 0 }, useBody: { value: 0 },
      top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() },
      tint: { value: new THREE.Color(1, 1, 1) },
      time: { value: 0 }, wind: { value: 1 }, cloudAmt: { value: 1 }, stars: { value: 0 },
      bodyDir: { value: new THREE.Vector3(0, 0.6, -0.8).normalize() },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;                        // pinned to the far plane
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D skyTex, cloudTex, bodyTex;
        uniform float useTex, useBody, time, wind, cloudAmt, stars;
        float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        uniform vec3 top, horizon, tint, bodyDir;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          vec3 c;
          if (useTex > 0.5) {
            // project onto two ceilings; +0.08 keeps the horizon from smearing to infinity
            vec2 pSky = d.xz / (d.y + 0.08);
            vec2 pCld = d.xz / (d.y + 0.12);
            vec3 s = texture2D(skyTex, pSky * 0.55 + vec2(time * 0.004, time * 0.002) * wind).rgb;
            vec4 k = texture2D(cloudTex, pCld * 0.9 + vec2(time * 0.011, -time * 0.004) * wind);
            float lum = dot(k.rgb, vec3(0.299, 0.587, 0.114));
            float a = smoothstep(0.55, 0.95, lum) * cloudAmt;
            c = mix(s, k.rgb, a) * tint;
          } else {
            c = mix(horizon, top, pow(clamp(d.y, 0.0, 1.0), 0.6));
          }
          if (stars > 0.001 && d.y > 0.0) {             // night: a fixed star field
            vec3 cell = floor(d * 420.0);
            float h = hash3(cell);
            float twinkle = 0.75 + 0.25 * sin(time * 1.7 + h * 40.0);
            c += vec3(step(0.9965, h) * (h - 0.9965) / 0.0035 * twinkle) * stars * smoothstep(0.02, 0.25, d.y);
          }
          if (useBody > 0.5) {                          // sun / moon / Norrath billboard
            vec3 b = normalize(bodyDir);
            vec3 r = normalize(cross(b, vec3(0.0, 1.0, 0.0)));
            vec3 u = cross(r, b);
            float size = 0.09;
            vec2 q = vec2(dot(d, r), dot(d, u)) / size;
            if (dot(d, b) > 0.0 && abs(q.x) < 1.0 && abs(q.y) < 1.0) {
              vec4 t = texture2D(bodyTex, q * 0.5 + 0.5);
              float ta = max(t.a < 0.99 ? t.a : 0.0, smoothstep(0.08, 0.5, dot(t.rgb, vec3(0.333))));
              c = mix(c, t.rgb, ta);
            }
          }
          // fade into the fog colour at and below the horizon
          float h = smoothstep(-0.02, 0.22, d.y);
          c = mix(horizon, c, h);
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), mat);
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
    this.mesh.onBeforeRender = (r, s, cam) => {
      this.mesh.position.copy(cam.position);
      this.mesh.updateMatrixWorld();
    };
  }

  // preset: key of SKY_PRESETS, 'gradient', or 'none'
  // day: optional { tint:[r,g,b], stars, dir:[x,y,z], body:'sun'|'moon' } from daynight.js; it
  // overrides the static sun position and tints the sky for the time of day.
  set(preset, { top, horizon, tint = '#ffffff', wind = 1, clouds = 1, sunAz = 135, sunEl = 40, textures = true, day = null }) {
    const u = this.uniforms;
    u.top.value.set(top);
    u.horizon.value.set(horizon);
    u.wind.value = wind;
    u.cloudAmt.value = clouds;
    const P = SKY_PRESETS[preset];
    this.mesh.visible = preset !== 'none';
    u.useTex.value = P && textures ? 1 : 0;
    u.useBody.value = 0;
    if (P && textures) {
      u.skyTex.value = tex(P.sky);
      u.cloudTex.value = tex(P.cloud);
      u.tint.value.set(tint).multiplyScalar(P.dim ?? 1);
      if (day) u.tint.value.multiply(new THREE.Color(...day.tint));
      if (P.body) {
        const body = day && P.body === 'sun' ? day.body : P.body;
        u.bodyTex.value = tex(body);
        u.useBody.value = 1;
        if (day) u.bodyDir.value.set(...day.dir);
        else {
          const az = sunAz * Math.PI / 180, el = Math.max(8, sunEl) * Math.PI / 180;
          u.bodyDir.value.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
        }
      }
    }
    // Plain-gradient skies get the time-of-day tint through their colours instead.
    if (day && !(P && textures)) { u.top.value.multiply(new THREE.Color(...day.tint)); }
    u.stars.value = day ? day.stars : 0;
  }

  update(t) { this.uniforms.time.value = t; }
}
