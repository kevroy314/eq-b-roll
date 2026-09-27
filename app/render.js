// Offline, frame-perfect rendering of a take to MP4.
//
// Nothing here runs in real time. Each output frame is posed from the take at exactly
// frame/fps seconds, rendered at the output resolution, and handed to the browser's hardware
// video encoder (WebCodecs), so a slow PC renders the same clip as a fast one — it just takes
// longer. Motion blur averages several sub-frames spread across a virtual shutter, which is
// what makes 30 fps camera moves look filmed rather than game-captured.
import * as THREE from './vendor/three.module.js';
import { Muxer, ArrayBufferTarget } from './vendor/mp4-muxer.mjs';

// Tried in order; the first one this browser/GPU can encode at the requested size wins.
function codecCandidates(w, h, fps) {
  const px = w * h * fps;
  const avc = px <= 1920 * 1080 * 30 ? ['avc1.640028', 'avc1.64002A', 'avc1.640033']
            : px <= 1920 * 1080 * 60 ? ['avc1.64002A', 'avc1.640033', 'avc1.640034']
            : ['avc1.640033', 'avc1.640034'];
  return [...avc.map(c => ({ codec: c, mux: 'avc' })),
          { codec: 'hev1.1.6.L153.B0', mux: 'hevc' },
          { codec: 'vp09.00.51.08', mux: 'vp9' },
          { codec: 'av01.0.12M.08', mux: 'av1' }];
}

export function webCodecsAvailable() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

async function pickCodec(w, h, fps, bitrate) {
  for (const c of codecCandidates(w, h, fps)) {
    const cfg = { codec: c.codec, width: w, height: h, bitrate, framerate: fps,
                  bitrateMode: 'variable', latencyMode: 'quality' };
    if (c.mux === 'avc') cfg.avc = { format: 'avc' };
    try {
      const s = await VideoEncoder.isConfigSupported(cfg);
      if (s.supported) return { cfg: s.config, mux: c.mux };
    } catch { /* unsupported codec string on this browser */ }
  }
  return null;
}

// Averages sub-frames in a half-float target, then copies to the canvas through a plain
// MeshBasicMaterial so the renderer's own tone mapping + sRGB output conversion still apply.
class Accumulator {
  constructor(renderer, w, h) {
    const opts = { type: THREE.HalfFloatType, depthBuffer: true };
    this.one = new THREE.WebGLRenderTarget(w, h, { ...opts, samples: 4 });
    this.sum = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geo = new THREE.PlaneGeometry(2, 2);
    this.addMat = new THREE.MeshBasicMaterial({ map: this.one.texture, blending: THREE.AdditiveBlending,
      transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    this.addScene = new THREE.Scene();
    this.addScene.add(new THREE.Mesh(geo, this.addMat));
    this.copyScene = new THREE.Scene();
    this.copyScene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: this.sum.texture,
      depthTest: false, depthWrite: false })));
    this.r = renderer;
  }

  // `steps` are sub-frame times; `apply(step)` poses the camera and the world for one of them.
  frame(scene, camera, steps, apply) {
    const r = this.r, prevAuto = r.autoClear;
    const prevColor = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
    r.setRenderTarget(this.sum);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.setClearColor(prevColor, 1);          // sub-frames must be opaque or they add as black
    this.addMat.opacity = 1 / steps.length;
    for (const s of steps) {
      apply(s);
      r.autoClear = true;
      r.setRenderTarget(this.one);
      r.render(scene, camera);
      r.autoClear = false;
      r.setRenderTarget(this.sum);
      r.render(this.addScene, this.cam);
    }
    r.autoClear = prevAuto;
    r.setClearColor(prevColor, prevAlpha);
    r.setRenderTarget(null);
    r.render(this.copyScene, this.cam);
  }

  dispose() { this.one.dispose(); this.sum.dispose(); }
}

/**
 * Render `take` to an MP4 and return it as a Blob.
 *   ctx: { renderer, scene, camera, applyPose(pose), setOutputSize(w,h), restore() }
 *   opts: { width, height, fps, mbps, blur (sub-frames), shutter (0..1), onProgress, signal }
 */
export async function renderTake(take, ctx, opts) {
  if (!webCodecsAvailable()) throw new Error('This browser has no WebCodecs video encoder — use Chrome or Edge.');
  const { width: w, height: h, fps } = opts;
  const bitrate = Math.round(opts.mbps * 1e6);
  const pick = await pickCodec(w, h, fps, bitrate);
  if (!pick) throw new Error(`No video encoder here can do ${w}×${h} @ ${fps} fps. Try a smaller size.`);

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, fastStart: 'in-memory',
    video: { codec: pick.mux, width: w, height: h, frameRate: fps } });
  let encErr = null;
  const enc = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: e => { encErr = e; },
  });
  enc.configure(pick.cfg);

  ctx.setOutputSize(w, h);
  const acc = opts.blur > 1 ? new Accumulator(ctx.renderer, w, h) : null;
  const frames = Math.max(1, Math.round(take.duration * fps));
  const gop = fps * 2;
  const t0 = performance.now();
  try {
    for (let i = 0; i < frames; i++) {
      if (opts.signal?.aborted) throw new DOMException('Render cancelled', 'AbortError');
      if (encErr) throw encErr;
      const t = i / fps;
      if (acc) {
        // Sub-frames are centred on the frame time and spread across the shutter interval
        // (0.5 = a 180° shutter, the film default).
        const n = opts.blur, span = (opts.shutter ?? 0.5) / fps;
        const times = [];
        for (let k = 0; k < n; k++) times.push(Math.min(take.duration, Math.max(0, t + ((k + 0.5) / n - 0.5) * span)));
        acc.frame(ctx.scene, ctx.camera, times, tk => { ctx.setTime?.(tk); ctx.applyPose(take.sample(tk)); });
      } else {
        ctx.setTime?.(t);
        ctx.applyPose(take.sample(t));
        ctx.renderer.render(ctx.scene, ctx.camera);
      }
      const vf = new VideoFrame(ctx.renderer.domElement, { timestamp: Math.round(i * 1e6 / fps),
                                                          duration: Math.round(1e6 / fps) });
      enc.encode(vf, { keyFrame: i % gop === 0 });
      vf.close();
      // Don't outrun the encoder: a deep queue holds every pending frame in GPU memory.
      while (enc.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 2));
      if (i % 4 === 0 || i === frames - 1) {
        const el = (performance.now() - t0) / 1000;
        opts.onProgress?.({ frame: i + 1, frames, elapsed: el, eta: el / (i + 1) * (frames - i - 1) });
        await new Promise(r => setTimeout(r, 0));   // let the progress bar paint
      }
    }
    await enc.flush();
    if (encErr) throw encErr;
    muxer.finalize();
    return { blob: new Blob([target.buffer], { type: 'video/mp4' }), codec: pick.cfg.codec, frames };
  } finally {
    if (enc.state !== 'closed') enc.close();
    acc?.dispose();
    ctx.restore();
  }
}
