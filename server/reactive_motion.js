/**
 * Reactive "Motion" — AnimateDiff v3 as a look, 2026-09-19.
 *
 * WHAT IT MAKES. The clip in the slots repainted by SD1.5 under an AnimateDiff
 * motion module: the whole piece sampled as one batch through sliding
 * 16-frame windows (no flicker, the motion module's job), the dancer held by
 * depth and line art (the control path's depth estimator, by licence), and
 * the LOOK changing on the drum-stem bars — one prompt per bar, blended
 * across the bar line by our own per-frame schedule node. This is Yvann's
 * VideoToVideo shape on the pieces whose licences let it ship
 * (server/animatediff.js says which, and which are missing and why).
 *
 * MEASURED 2026-09-19 on the generated high-heels dance clip, 60 frames at
 * 768x432: 199 s. With depth 0.3 / line art 0.5 the result is a colour-graded
 * photograph whose palette travels on the bars; with depth 0.2 / line art
 * 0.25, cfg 8 and paint-heavy prompts it is a painted figure in a
 * paint-smeared room, the drips and the palette moving with the music —
 * the closest thing here to the reference workflow's texture. Those are the
 * defaults below.
 *
 * NVIDIA only, a few seconds a frame, and the piece is one batch: twelve
 * seconds at 12 fps is 144 frames and about eight minutes.
 */
import path from "node:path";
import { execFile } from "node:child_process";
import { stat, copyFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { config } from "./config.js";
import { ffmpegPath } from "./clipjoin.js";
import * as prov from "./provenance.js";
import { animateGraph, smoothGraph, scheduleFromBars, ipScheduleFromPeaks, IP_TRANSITION, ANIMATE_SIZES, ANIMATE_SIZES_HIRES, HIRES_DEFAULTS, ANIMATE_PRESET } from "./animatediff.js";

const clamp = (v, lo, hi) => Math.min(Math.max(Number(v) || 0, lo), hi);

/** The three looks a piece travels between when nobody writes their own. */
export const MOTION_LOOKS = [
  "a painting in thick wet liquid paint, everything made of glossy marbled oil with iridescent cells and ink veins, no photograph: a dancer in electric magenta and hot orange, the studio drowned in swirling paint, psychedelic, high quality, art",
  "a painting in thick wet liquid paint, everything made of glossy marbled oil with iridescent cells and ink veins, no photograph: a dancer in deep cyan and electric blue with violet veins, the studio drowned in swirling paint, psychedelic, high quality, art",
  "a painting in thick wet liquid paint, everything made of glossy marbled oil with iridescent cells and ink veins, no photograph: a dancer in acid yellow and lime green with black ink veins, the studio drowned in swirling paint, psychedelic, high quality, art",
];

export const MOTION_DEFAULTS = {
  depth: 0.2, lineart: 0.25, cfg: 8, steps: ANIMATE_PRESET.steps, seed: 424242, fps: ANIMATE_PRESET.fps,
  /* How far through each pass the holds stay on (the reference's 0.5 / 0.7). */
  depthEnd: 0.5, lineartEnd: 0.7,
  /* The SOURCE on the hits: SparseCtrl keyframes at the hit frames, strength
   * and how far through each pass they hold (the reference's 1.0 to 0.5).
   * OFF until asked for, with prompts and with pictures alike: measured on
   * 2026-09-20 (the same 2.5 s dance piece, six pictures, three hits, on
   * against off) the anchoring at 1.0 flattened the paint to one red wash and
   * defined the dancer LESS, the opposite of what the reference's hits do —
   * its dark stage is what the keyframes anchor to. The dial stays; the
   * cause is not found yet. */
  sourceHold: 0, sourceHoldEnd: 0.5,
  /* With pictures carrying the look (the reference workflow's way): their
   * weight in every cross-attention layer, the cross-fade length in frames
   * ending on each hit, and the one short prompt the reference keeps. */
  ipWeight: 1.0, transition: IP_TRANSITION.frames,
  lookWithPictures: "4k, beautiful, high quality, highly detailed, art",
  /* The reference workflow's second pass (2x, denoise 0.55) and its frame
   * rate: the render is 12 fps, the piece 24 by motion interpolation. */
  hires: true, hiresDenoise: HIRES_DEFAULTS.denoise, smooth: true,
  /* Which hits the pictures switch on: every drum-stem beat at least `hitGap`
   * frames apart (the reference's min distance 5), or the bars only. At 128
   * bpm and 12 fps beats are 5.6 frames apart, so every frame is a blend;
   * a longer gap or the bars make the switches cut. */
  hitsOn: "beats", hitGap: 5,
  /* How hard the picture moves between frames (AnimateDiff's own motion scale).
   * 1 is the module's, and the graph at 1 is the graph every earlier piece
   * rendered. Raised only on request; what it looks like above 1.5 is not
   * measured here. */
  motionScale: 1,
  /* The reference's black circle, growing on the bass. 0 is off, which is what
   * every earlier piece had. It is a COMPOSITOR shape over the finished frames,
   * not something the diffusion knows about. */
  iris: 0,
  /* ⚠ HOW MUCH THE DEPTH AND LINE-ART PREPROCESSORS ARE ALLOWED TO SEE, and it
   * is the answer to "the shape of the dancer is more visible" in the reference.
   * A dance clip shot on a black stage puts the figure in the bottom five per
   * cent of the range — measured on frame 24 of aiplay_zoom_s1_24.mp4, 83.5% of
   * the frame under luminance 0.05, the figure's own column averaging 0.068 —
   * and an estimator reading that is not weak, it is blind. Raising ONLY the
   * hint branch by 1/gamma multiplies the edge energy inside the figure by 2.2
   * at 2.2. The frames the sampler paints are untouched. 1 is off and renders
   * the graph every earlier piece had; see aiplay_hint_lift.py for the sweep
   * and for why a global stretch does nothing here. */
  hintLift: 1,
  /* Bring your own: nothing shipped, nothing listed in the catalogue. */
  motionModel: "", motionLora: "", motionLoraStrength: 1, modelLora: "", modelLoraStrength: 1, sampler: "", scheduler: "",
};
export const HITS_ON = ["beats", "bars"];
export const MOTION_SAMPLERS = ["dpmpp_2m", "dpmpp_2m_sde", "euler", "euler_ancestral", "lcm", "ddim", "uni_pc"];
export const MOTION_SCHEDULERS = ["karras", "sgm_uniform", "normal", "simple", "exponential", "beta"];

/** With PICTURES carrying the look, the holds the reference workflow runs:
 *  depth 0.3, line art 0.5, cfg 7. The painted defaults above (0.2 / 0.25 /
 *  cfg 8) were tuned for the PROMPT look, where the prompt has to paint over
 *  the room; the pictures do that by themselves, and the room and the
 *  dancer are better kept. Measured 2026-09-19 on the 60-frame probe with
 *  three pictures on every drum hit: 208 s, the palette on every surface. */
/* ⚠ AND THE LIFT IS ON BY DEFAULT ON THIS PATH ONLY. The pictures path is the
 * one the owner's dance pieces take, and it is the one that comes back with the
 * dancer as a dark blob — the reference's figure reads and ours does not. The
 * plain path keeps 1 so that anything rendered before 2026-09-20 can still be
 * reproduced exactly by not passing dials at all. */
export const MOTION_PICTURE_DIALS = { depth: 0.4, depthEnd: 0.6, lineart: 0.5, lineartEnd: 0.7, cfg: 7, hintLift: 2.2 };
/* The reference runs depth 0.3 to 0.5; with the pictures painting over the
 * figure the user asked for a little more of her shape (2026-09-19), so with
 * pictures depth holds at 0.4 until 0.6 of each pass. */

/** The hits the pictures switch on: the drum-stem beats inside the piece, at
 *  least `minGap` frames apart (the reference's min_peaks_distance 5). The
 *  onset track is normalised over the whole song and a quiet entry shows
 *  nothing above threshold, while a four-on-the-floor track's hits ARE its
 *  beats — measured on this library's 128 bpm dance track. */
export function peakFrames({ beats = [], start = 0, fps, frames, minGap = 5 }) {
  const out = [];
  let last = -Infinity;
  for (const b of beats) {
    const f = Math.round((Number(b) - start) * fps);
    if (f < 0 || f >= frames) continue;
    if (f - last >= minGap) { out.push(f); last = f; }
  }
  return out;
}
export const MOTION_SECONDS_PER_FRAME = 3.4;   // 199 s / 60 frames, measured, one pass at 768x432
export const MOTION_SECONDS_PER_FRAME_HIRES = 7; // 380 s / 48 frames measured 2026-09-19 (512x288 + 2x at 0.55, smoothed)

/** The dials a caller may move, bounded. A dial the caller leaves out takes
 *  the default — the reference's holds when `pictures` carry the look, the
 *  painted ones otherwise. */
export function motionDials(o = {}, { pictures = false } = {}) {
  const d = { ...MOTION_DEFAULTS, ...(pictures ? MOTION_PICTURE_DIALS : {}), looks: MOTION_LOOKS.slice() };
  if (o.depth !== undefined) d.depth = clamp(o.depth, 0, 1.5);
  if (o.lineart !== undefined) d.lineart = clamp(o.lineart, 0, 1.5);
  if (o.depthEnd !== undefined) d.depthEnd = clamp(o.depthEnd, 0.1, 1);
  if (o.motionScale !== undefined) d.motionScale = clamp(o.motionScale, 0.1, 3);
  if (o.iris !== undefined) d.iris = clamp(o.iris, 0, 1);
  if (o.hintLift !== undefined) d.hintLift = clamp(o.hintLift, 1, 4);
  if (o.sourceHold !== undefined) d.sourceHold = clamp(o.sourceHold, 0, 2);
  if (o.sourceHoldEnd !== undefined) d.sourceHoldEnd = clamp(o.sourceHoldEnd, 0.1, 1);
  if (o.lineartEnd !== undefined) d.lineartEnd = clamp(o.lineartEnd, 0.1, 1);
  if (o.cfg !== undefined) d.cfg = clamp(o.cfg, 1, 15);
  if (o.steps !== undefined) d.steps = Math.round(clamp(o.steps, 4, 40));
  if (o.seed !== undefined) d.seed = Math.round(clamp(o.seed, 0, 2_147_483_647));
  if (o.ipWeight !== undefined) d.ipWeight = clamp(o.ipWeight, 0, 2);
  if (o.transition !== undefined) d.transition = Math.round(clamp(o.transition, 0, 24));
  if (HITS_ON.includes(o.hitsOn)) d.hitsOn = o.hitsOn;
  if (o.hitGap !== undefined) d.hitGap = Math.round(clamp(o.hitGap, 1, 120));
  const name = (v) => String(v || "").trim().replace(/[\\/]+/g, "").slice(0, 200);
  if (o.motionModel !== undefined) d.motionModel = name(o.motionModel);
  if (o.motionLora !== undefined) d.motionLora = name(o.motionLora);
  if (o.motionLoraStrength !== undefined) d.motionLoraStrength = clamp(o.motionLoraStrength, 0, 2);
  if (o.modelLora !== undefined) d.modelLora = name(o.modelLora);
  if (o.modelLoraStrength !== undefined) d.modelLoraStrength = clamp(o.modelLoraStrength, 0, 2);
  if (o.sampler !== undefined) d.sampler = MOTION_SAMPLERS.includes(o.sampler) ? o.sampler : "";
  if (o.scheduler !== undefined) d.scheduler = MOTION_SCHEDULERS.includes(o.scheduler) ? o.scheduler : "";
  if (o.hires !== undefined) d.hires = !!o.hires;
  if (o.hiresDenoise !== undefined) d.hiresDenoise = clamp(o.hiresDenoise, 0.2, 0.9);
  if (o.smooth !== undefined) d.smooth = !!o.smooth;
  if (typeof o.lookWithPictures === "string" && o.lookWithPictures.trim()) d.lookWithPictures = o.lookWithPictures.trim().slice(0, 300);
  d.customLooks = Array.isArray(o.looks) && o.looks.some((s) => String(s || "").trim());
  if (Array.isArray(o.looks)) {
    const looks = o.looks.map((s) => String(s || "").trim().slice(0, 600)).filter(Boolean);
    if (looks.length) d.looks = looks;
  }
  return d;
}

function run(bin, args, { timeoutMs = 600_000 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 << 20, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

/**
 * motionChoices(engine) -> { motionModels, motionLoras, loras, samplers, schedulers }
 *
 * What the engine's own folders hold, read off its node definitions — so the
 * page's Bring-your-own selects list a person's files by name and the app
 * never has to know which they are. Empty lists when the pack is missing.
 */
export async function motionChoices(engine) {
  const combo = async (cls, field) => {
    try {
      const info = await engine.objectInfo(cls);
      const spec = info?.[cls]?.input?.required?.[field] ?? info?.[cls]?.input?.optional?.[field];
      const opts = Array.isArray(spec) ? (Array.isArray(spec[0]) ? spec[0] : spec[1]?.options) : null;
      return Array.isArray(opts) ? opts.map(String) : [];
    } catch { return []; }
  };
  return {
    motionModels: await combo("ADE_LoadAnimateDiffModel", "model_name"),
    motionLoras: await combo("ADE_AnimateDiffLoRALoader", "name"),
    loras: await combo("LoraLoaderModelOnly", "lora_name"),
    samplers: MOTION_SAMPLERS, schedulers: MOTION_SCHEDULERS,
  };
}

/**
 * motionClip(o, deps) -> { file, frames, seconds, runId, dials, size, schedule }
 *
 *   clip, clipDir   the source clip in the clips library
 *   start, seconds  the piece's window of the song
 *   bars            the song's bar times (from the analysis; the drum stem's when asked)
 *   beats           the song's beat times — the hits the pictures switch on
 *   pictures        image names from the images library: the LOOK, in order (optional)
 *   imageDir        the images library folder
 *   orientation     landscape | portrait | square
 *   dials           see motionDials
 *   deps.engine     the Studio's engine door (server/engine/client.js)
 *   deps.actor      who asked
 */
/* ⚠ `system`, not `user` — see the note on paintClip. An unattributable render
 * is unattributable, not the person's. */
export async function motionClip(o, { engine, actor = "system" } = {}) {
  const clip = path.basename(String(o.clip || ""));
  if (!clip) throw new Error("The Motion look repaints a clip: pick one in the Clips grid.");
  if (!engine) throw new Error("The Motion look needs the engine door.");
  const seconds = clamp(o.seconds || 8, 2, 120);
  const start = clamp(o.start || 0, 0, 3600);
  const pictures = (o.pictures || []).map((s) => path.basename(String(s))).filter(Boolean);
  const dials = motionDials(o.dials || {}, { pictures: pictures.length > 0 });
  /* With the detail pass the first pass is small and the SOURCE is staged at
   * the second pass's size, so depth and line art are read sharp. */
  const sizes = dials.hires ? ANIMATE_SIZES_HIRES : ANIMATE_SIZES;
  const [width, height] = sizes[o.orientation] || sizes.landscape;
  const scale = dials.hires ? HIRES_DEFAULTS.scale : 1;
  const [srcW, srcH] = [width * scale, height * scale];
  const frames = Math.round(seconds * dials.fps);
  const srcPath = path.join(o.clipDir, clip);
  await stat(srcPath).catch(() => { throw new Error(`${clip} is not in the clips library.`); });
  const id = createHash("sha1").update(JSON.stringify({ clip, start, seconds, dials, width, height })).digest("hex").slice(0, 8);

  /* 1. The source at the working size and frame rate, looped to the piece,
   *    in the engine's input folder (LoadVideo.file is a COMBO over it). */
  const src = `aiplay_motion_src_${id}.mp4`;
  const vf = `fps=${dials.fps},scale=${srcW}:${srcH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${srcW}:${srcH}`;
  const ex = await run(ffmpegPath(), ["-y", "-hide_banner", "-loglevel", "error", "-stream_loop", "-1", "-i", srcPath,
    "-t", String(seconds), "-vf", vf, "-frames:v", String(frames), "-an", "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p",
    path.join(config.inputDir, src)]);
  if (ex.err) {
    throw new Error(ex.err.code === "ENOENT"
      ? `ffmpeg was not found (tried ${ffmpegPath()}); install it or point AIPLAY_FFMPEG at a binary.`
      : `ffmpeg could not read ${clip}: ${ex.stderr.trim().split("\n").pop() || ex.err.message}`);
  }

  /* 2. The look on the bars, then the graph. */
  /* 2b. The pictures, when given: staged where LoadImage can see them, one
   *     or two live per frame, switching on the drum-stem beats with the
   *     reference's cross-fade. The prompt is then the reference's six words
   *     unless the caller wrote looks of their own. */
  let ipadapter = null;
  let peaks = [];
  /* The hits: the drum-stem beats (or the bars) inside the piece — the
   * pictures switch on them and the source anchors on them. */
  const hits = () => peakFrames({ beats: dials.hitsOn === "bars" ? (o.bars || []) : (o.beats || []), start, fps: dials.fps, frames, minGap: Math.max(dials.hitGap, dials.transition) });
  if (dials.sourceHold > 0) peaks = hits();
  if (pictures.length) {
    if (!o.imageDir) throw new Error("The Motion look needs the images library to read the pictures from.");
    const staged = [];
    for (const p of pictures) {
      const from = path.join(o.imageDir, p);
      await stat(from).catch(() => { throw new Error(`${p} is not in the Images library.`); });
      const name = `aiplay_motion_pic_${p.replace(/[^A-Za-z0-9_.-]+/g, "_")}`;
      await copyFile(from, path.join(config.inputDir, name));
      staged.push(name);
    }
    peaks = hits();
    ipadapter = { pictures: staged, schedule: ipScheduleFromPeaks({ peaks, frames, pictures: staged.length, transition: dials.transition }), weight: dials.ipWeight };
  }
  const looks = pictures.length && !dials.customLooks ? [dials.lookWithPictures] : dials.looks;
  const schedule = scheduleFromBars({ bars: o.bars || [], start, fps: dials.fps, frames, looks });
  const graph = animateGraph({
    source: src, frames, width, height, schedule, seed: dials.seed, steps: dials.steps, cfg: dials.cfg,
    depth: { strength: dials.depth, start: 0, end: dials.depthEnd }, lineart: { strength: dials.lineart, start: 0, end: dials.lineartEnd },
    prefix: `animate/motion_${id}`,
    motionScale: dials.motionScale, hintLift: dials.hintLift,
    ipadapter,
    hires: dials.hires ? { scale, denoise: dials.hiresDenoise } : null,
    sparse: dials.sourceHold > 0 ? { keyframes: peaks.length ? peaks : [0], strength: dials.sourceHold, start: 0, end: dials.sourceHoldEnd } : null,
    own: {
      motionModel: dials.motionModel || null,
      motionLora: dials.motionLora ? { name: dials.motionLora, strength: dials.motionLoraStrength } : null,
      modelLora: dials.modelLora ? { name: dials.modelLora, strength: dials.modelLoraStrength } : null,
      sampler: dials.sampler || null, scheduler: dials.scheduler || null,
    },
  });

  /* 3. Through the one door, adopted into the clips library. */
  const t0 = Date.now();
  const done = await engine.run({
    graph, actor, via: "reactive.motion", clientId: "aiplay-reactive",
    label: `motion look — ${clip}`, project: "reactive", shot: null,
    adopt: true, timeoutMs: 60 * 60_000, pollMs: 3_000,
  });
  if (done.status !== "completed") throw new Error(done.error || `the motion render did not finish (${done.status})`);
  /* Not LoadVideo's echo of its input (type "input") — what the graph wrote. */
  const out = (done.outputs || []).filter((r) => (r.type || "output") !== "input").find((r) => /\.(mp4|webm|mov|mkv)$/i.test(r.file || ""));
  if (!out) throw new Error("the motion render finished but saved no clip this could find.");
  const engineFile = path.basename(out.adoptedAs || out.file);
  let file = engineFile;
  let fps = dials.fps;
  /* 4. Smooth: the 12 fps render becomes a 24 fps clip — the reference's
   *    output rate. RIFE 4.26 through the engine first (the enhancer's
   *    model, MIT, on the card, clean on limbs); when the interpolation pack
   *    or its model is not there, ffmpeg's motion compensation on the CPU,
   *    and the ledger says which. */
  let smoothedBy = null;
  if (dials.smooth) {
    const staged = `aiplay_motion_smooth_${id}.mp4`;
    await copyFile(path.join(o.clipDir, engineFile), path.join(config.inputDir, staged));
    try {
      const sm = await engine.run({
        graph: smoothGraph({ file: staged, fps: dials.fps, multiplier: 2, prefix: `animate/motion_${id}_24` }),
        actor, via: "reactive.motion.smooth", clientId: "aiplay-reactive",
        label: `smooth to 24 fps — ${engineFile}`, project: "reactive", shot: null,
        adopt: true, timeoutMs: 20 * 60_000, pollMs: 2_000,
      });
      const row = sm.status === "completed"
        ? (sm.outputs || []).filter((r) => (r.type || "output") !== "input").find((r) => /\.(mp4|webm|mov|mkv)$/i.test(r.file || "")) : null;
      if (!row) throw new Error(sm.error || `the smoothing render did not finish (${sm.status})`);
      file = path.basename(row.adoptedAs || row.file);
      smoothedBy = "rife";
    } catch (e) {
      console.warn(`  [reactive motion] RIFE smoothing unavailable (${String(e.message || e).slice(0, 160)}); ffmpeg instead`);
      const smoothed = `aiplay_motion_${id}.mp4`;
      const sm = await run(ffmpegPath(), ["-y", "-hide_banner", "-loglevel", "error", "-i", path.join(o.clipDir, engineFile),
        "-vf", "minterpolate=fps=24:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1", "-an",
        "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path.join(o.clipDir, smoothed)], { timeoutMs: 1_800_000 });
      if (sm.err) throw new Error(`the motion clip could not be smoothed to 24 fps: ${sm.stderr.trim().split("\n").pop() || sm.err.message}`);
      await prov.append("library", {
        actor, type: "edit", asset: `clips/${smoothed}`,
        data: { op: "motion-smooth", source: `clips/${engineFile}`, fps: 24, from_fps: dials.fps, filter: "minterpolate mci/aobmc/bidir",
                note: "the AnimateDiff render (12 fps) motion-interpolated to 24 fps by ffmpeg because RIFE was not available; the render itself is the source clip" },
      }).catch((err) => console.error(`  [provenance] event lost (edit/clips/${smoothed}): ${err.message}`));
      file = smoothed;
      smoothedBy = "ffmpeg";
    } finally {
      await rm(path.join(config.inputDir, staged), { force: true }).catch(() => {});
    }
    fps = 24;
  }
  return { file, engineFile, fps, smoothedBy, frames, seconds: Math.round((Date.now() - t0) / 1000), runId: done.runId, dials,
           size: [width * scale, height * scale], firstPass: [width, height], hires: dials.hires ? { scale, denoise: dials.hiresDenoise } : null, schedule,
           pictures, peaks, ipadapter: ipadapter ? { weight: ipadapter.weight, transition: dials.transition } : null,
           motionScale: dials.motionScale, hintLift: dials.hintLift,
           sourceHold: dials.sourceHold > 0 ? { strength: dials.sourceHold, end: dials.sourceHoldEnd, keyframes: peaks.length } : null };
}
