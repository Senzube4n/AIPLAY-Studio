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
import { stat, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { config } from "./config.js";
import { ffmpegPath } from "./clipjoin.js";
import { animateGraph, scheduleFromBars, ipScheduleFromPeaks, IP_TRANSITION, ANIMATE_SIZES, ANIMATE_PRESET } from "./animatediff.js";

const clamp = (v, lo, hi) => Math.min(Math.max(Number(v) || 0, lo), hi);

/** The three looks a piece travels between when nobody writes their own. */
export const MOTION_LOOKS = [
  "a painting in thick wet liquid paint, everything made of glossy marbled oil with iridescent cells and ink veins, no photograph: a dancer in electric magenta and hot orange, the studio drowned in swirling paint, psychedelic, high quality, art",
  "a painting in thick wet liquid paint, everything made of glossy marbled oil with iridescent cells and ink veins, no photograph: a dancer in deep cyan and electric blue with violet veins, the studio drowned in swirling paint, psychedelic, high quality, art",
  "a painting in thick wet liquid paint, everything made of glossy marbled oil with iridescent cells and ink veins, no photograph: a dancer in acid yellow and lime green with black ink veins, the studio drowned in swirling paint, psychedelic, high quality, art",
];

export const MOTION_DEFAULTS = {
  depth: 0.2, lineart: 0.25, cfg: 8, steps: ANIMATE_PRESET.steps, seed: 424242, fps: ANIMATE_PRESET.fps,
  /* With pictures carrying the look (the reference workflow's way): their
   * weight in every cross-attention layer, the cross-fade length in frames
   * ending on each hit, and the one short prompt the reference keeps. */
  ipWeight: 1.0, transition: IP_TRANSITION.frames,
  lookWithPictures: "4k, beautiful, high quality, highly detailed, art",
};

/** With PICTURES carrying the look, the holds the reference workflow runs:
 *  depth 0.3, line art 0.5, cfg 7. The painted defaults above (0.2 / 0.25 /
 *  cfg 8) were tuned for the PROMPT look, where the prompt has to paint over
 *  the room; the pictures do that by themselves, and the room and the
 *  dancer are better kept. Measured 2026-09-19 on the 60-frame probe with
 *  three pictures on every drum hit: 208 s, the palette on every surface. */
export const MOTION_PICTURE_DIALS = { depth: 0.3, lineart: 0.5, cfg: 7 };

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
export const MOTION_SECONDS_PER_FRAME = 3.4;   // 199 s / 60 frames, measured

/** The dials a caller may move, bounded. A dial the caller leaves out takes
 *  the default — the reference's holds when `pictures` carry the look, the
 *  painted ones otherwise. */
export function motionDials(o = {}, { pictures = false } = {}) {
  const d = { ...MOTION_DEFAULTS, ...(pictures ? MOTION_PICTURE_DIALS : {}), looks: MOTION_LOOKS.slice() };
  if (o.depth !== undefined) d.depth = clamp(o.depth, 0, 1.5);
  if (o.lineart !== undefined) d.lineart = clamp(o.lineart, 0, 1.5);
  if (o.cfg !== undefined) d.cfg = clamp(o.cfg, 1, 15);
  if (o.steps !== undefined) d.steps = Math.round(clamp(o.steps, 4, 40));
  if (o.seed !== undefined) d.seed = Math.round(clamp(o.seed, 0, 2_147_483_647));
  if (o.ipWeight !== undefined) d.ipWeight = clamp(o.ipWeight, 0, 2);
  if (o.transition !== undefined) d.transition = Math.round(clamp(o.transition, 0, 24));
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
export async function motionClip(o, { engine, actor = "user" } = {}) {
  const clip = path.basename(String(o.clip || ""));
  if (!clip) throw new Error("The Motion look repaints a clip: pick one in the Clips grid.");
  if (!engine) throw new Error("The Motion look needs the engine door.");
  const seconds = clamp(o.seconds || 8, 2, 120);
  const start = clamp(o.start || 0, 0, 3600);
  const pictures = (o.pictures || []).map((s) => path.basename(String(s))).filter(Boolean);
  const dials = motionDials(o.dials || {}, { pictures: pictures.length > 0 });
  const [width, height] = ANIMATE_SIZES[o.orientation] || ANIMATE_SIZES.landscape;
  const frames = Math.round(seconds * dials.fps);
  const srcPath = path.join(o.clipDir, clip);
  await stat(srcPath).catch(() => { throw new Error(`${clip} is not in the clips library.`); });
  const id = createHash("sha1").update(JSON.stringify({ clip, start, seconds, dials, width, height })).digest("hex").slice(0, 8);

  /* 1. The source at the working size and frame rate, looped to the piece,
   *    in the engine's input folder (LoadVideo.file is a COMBO over it). */
  const src = `aiplay_motion_src_${id}.mp4`;
  const vf = `fps=${dials.fps},scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height}`;
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
    peaks = peakFrames({ beats: o.beats || [], start, fps: dials.fps, frames, minGap: Math.max(5, dials.transition) });
    ipadapter = { pictures: staged, schedule: ipScheduleFromPeaks({ peaks, frames, pictures: staged.length, transition: dials.transition }), weight: dials.ipWeight };
  }
  const looks = pictures.length && !dials.customLooks ? [dials.lookWithPictures] : dials.looks;
  const schedule = scheduleFromBars({ bars: o.bars || [], start, fps: dials.fps, frames, looks });
  const graph = animateGraph({
    source: src, frames, width, height, schedule, seed: dials.seed, steps: dials.steps, cfg: dials.cfg,
    depth: { strength: dials.depth, start: 0, end: 0.5 }, lineart: { strength: dials.lineart, start: 0, end: 0.7 },
    prefix: `animate/motion_${id}`,
    ipadapter,
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
  const file = path.basename(out.adoptedAs || out.file);
  return { file, frames, seconds: Math.round((Date.now() - t0) / 1000), runId: done.runId, dials, size: [width, height], schedule,
           pictures, peaks, ipadapter: ipadapter ? { weight: ipadapter.weight, transition: dials.transition } : null };
}
