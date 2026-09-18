/**
 * Reactive "Paint" — the feedback renderer as a look, 2026-09-19.
 *
 * WHAT IT MAKES. A clip repainted frame by frame by the image engine: each
 * frame is made from the previous one (so the paint builds and drifts the way
 * paint does), the source frame is re-imposed every frame (so the dancer's
 * pose survives), your pictures set the look and rotate on the bars, and the
 * bass decides how hard each frame is repainted. This is the Deforum-lineage
 * idea, and the half of Yvann's audio-reactive video-to-video look that a
 * video model steered by depth does not give — measured 2026-09-19 on a
 * generated high-heels dance clip, where the depth-steered VACE render was a
 * clean repaint of the room and this was liquid paint over a kept pose.
 *
 * WHERE THE RENDERING LIVES. scripts/reactive_video.mjs — the measured
 * renderer, kept as the one place its dials are explained. This module
 * prepares its inputs (looped source frames at the working size, the style
 * pictures in the engine's input folder), runs it through the Studio's own
 * engine door (the script posts to /api/engine and every frame is on the
 * ledger as script:reactive_video), and assembles the frames into a library
 * clip the compositor then finishes with the song.
 *
 * NVIDIA ONLY, and slow by nature: one image render per frame, ~6-8 s each at
 * 1024x576 on the 16 GB card, so twelve seconds at 12 fps is about twenty
 * minutes. The page and the tool say so before the button.
 */
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { mkdir, readdir, copyFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { ffmpegPath } from "./clipjoin.js";
import * as prov from "./provenance.js";

/** The dials, with the values that held the figure on 2026-09-19 (four runs,
 *  the last two with the source frame on the conditioning). */
export const PAINT_DEFAULTS = {
  fps: 12, steps: 12,
  denoiseMin: 0.66, denoiseRange: 0.2,
  source: 0.65, colour: 0.4, seed: 77000,
  styleA: "the whole scene made of flowing liquid paint, the figure a form of glossy marbled oil, psychedelic swirling colour on every surface",
  styleB: "everything is wet molten paint, iridescent cells and ink veins swallowing the room, the figure a glossy paint form, high quality",
};
/** Working sizes per shape — the renderer's, not the comp's; the compositor
 *  scales the painted clip to fill the frame. */
export const PAINT_SIZES = { landscape: [1024, 576], portrait: [576, 1024], square: [768, 768] };
export const PAINT_SECONDS_PER_FRAME = 7.5;   // measured 5.6-7.8 s/frame at 1024x576

const clamp = (v, lo, hi) => Math.min(Math.max(Number(v) || 0, lo), hi);

/** The dials a caller may move, bounded. Unknown keys are dropped, not refused. */
export function paintDials(o = {}) {
  const d = { ...PAINT_DEFAULTS };
  if (o.fps !== undefined) d.fps = clamp(o.fps, 6, 24);
  if (o.steps !== undefined) d.steps = Math.round(clamp(o.steps, 4, 30));
  if (o.denoiseMin !== undefined) d.denoiseMin = clamp(o.denoiseMin, 0.2, 0.95);
  if (o.denoiseRange !== undefined) d.denoiseRange = clamp(o.denoiseRange, 0, 0.5);
  if (o.source !== undefined) d.source = clamp(o.source, 0, 1);
  if (o.colour !== undefined) d.colour = clamp(o.colour, 0, 1);
  if (o.seed !== undefined) d.seed = Math.round(clamp(o.seed, 0, 2_147_483_647));
  if (typeof o.styleA === "string" && o.styleA.trim()) d.styleA = o.styleA.trim().slice(0, 500);
  if (typeof o.styleB === "string" && o.styleB.trim()) d.styleB = o.styleB.trim().slice(0, 500);
  return d;
}

/** The renderer's argv — pure, so the lane can pin what is asked of it. */
export function paintArgs({ srcDir, song, start, styles, run, width, height, dials }) {
  const d = dials;
  return [
    "--src", srcDir, "--song", song, "--start", String(start),
    "--style-refs", styles.join(","), "--name", run,
    "--fps", String(d.fps), "--width", String(width), "--height", String(height),
    "--steps", String(d.steps), "--seed", String(d.seed),
    "--source-ref", "1", "--source", String(d.source),
    "--denoise-min", String(d.denoiseMin), "--denoise-range", String(d.denoiseRange),
    "--colour", String(d.colour), "--style-a", d.styleA, "--style-b", d.styleB,
  ];
}

/** The engine has to be up before the first frame is asked for: right after a
 *  Studio start the door answers the renderer's first POST with "starting",
 *  the renderer exits 1, and the piece dies 16 s in (measured 2026-09-19). */
async function waitForEngine({ timeoutMs = 5 * 60_000 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${config.uiPort}/api/status`);
      const j = await r.json();
      if (j?.engine?.ready === true) return;
    } catch { /* not up yet */ }
    if (Date.now() > until) throw new Error("the image engine did not come up within five minutes; the Paint look needs it.");
    await new Promise((res) => setTimeout(res, 3000));
  }
}

function run(bin, args, { timeoutMs = 600_000, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 << 20, cwd, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

/**
 * paintClip(o, { actor, onProgress }) -> { file, frames, seconds, run, dials, size }
 *
 *   clip        a clips-library name (the source that gets repainted)
 *   clipDir     the clips library folder
 *   imageDir    the images library folder (where the style pictures live)
 *   song        a library song file name (the drive)
 *   start       the second of the song the piece begins at
 *   seconds     how long a piece; the source clip loops to fill it
 *   orientation landscape | portrait | square
 *   styles      image names, in order; rotate on the bars
 *   dials       see paintDials
 */
export async function paintClip(o, { actor = "user", onProgress = null } = {}) {
  const clip = path.basename(String(o.clip || ""));
  if (!clip) throw new Error("Paint needs a clip to repaint: pick one in the Clips grid.");
  const styles = (o.styles || []).map((s) => path.basename(String(s))).filter(Boolean);
  if (!styles.length) throw new Error("Paint needs at least one picture for the look — the chain drifts to collage without one.");
  const song = path.basename(String(o.song || ""));
  const start = clamp(o.start || 0, 0, 3600);
  const seconds = clamp(o.seconds || 8, 2, 120);
  const dials = paintDials(o.dials || {});
  const [width, height] = PAINT_SIZES[o.orientation] || PAINT_SIZES.landscape;
  const srcPath = path.join(o.clipDir, clip);
  await stat(srcPath).catch(() => { throw new Error(`${clip} is not in the clips library.`); });

  const id = createHash("sha1").update(JSON.stringify({ clip, song, start, seconds, styles, dials, width, height })).digest("hex").slice(0, 8);
  const runName = `paint_${id}`;
  const srcDir = `aiplay_paint_src_${id}`;
  const srcAbs = path.join(config.inputDir, srcDir);
  const frames = Math.ceil(seconds * dials.fps);
  const t0 = Date.now();
  const cleanup = async () => {
    await rm(srcAbs, { recursive: true, force: true }).catch(() => {});
    await rm(path.join(config.outputDir, runName), { recursive: true, force: true }).catch(() => {});
  };
  try {
  /* 1. The source frames: the clip looped to the length of the piece, at the
   *    working size, covering the frame (never letterboxed). */
  await rm(srcAbs, { recursive: true, force: true }).catch(() => {});
  await mkdir(srcAbs, { recursive: true });
  const vf = `fps=${dials.fps},scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height}`;
  const ex = await run(ffmpegPath(), ["-y", "-hide_banner", "-loglevel", "error", "-stream_loop", "-1", "-i", srcPath,
    "-t", String(seconds), "-vf", vf, "-frames:v", String(frames), path.join(srcAbs, "frame_%05d.png")]);
  if (ex.err) {
    throw new Error(ex.err.code === "ENOENT"
      ? `ffmpeg was not found (tried ${ffmpegPath()}); install it or point AIPLAY_FFMPEG at a binary.`
      : `ffmpeg could not read ${clip}: ${ex.stderr.trim().split("\n").pop() || ex.err.message}`);
  }
  const got = (await readdir(srcAbs)).filter((f) => f.endsWith(".png")).length;
  if (got < 2) throw new Error(`${clip} gave ${got} frames — is it a video?`);

  /* 2. The style pictures, copied where LoadImage can see them. */
  const staged = [];
  for (const s of styles) {
    const from = path.join(o.imageDir, s);
    await stat(from).catch(() => { throw new Error(`${s} is not in the Images library.`); });
    const name = `aiplay_paint_style_${s.replace(/[^A-Za-z0-9_.-]+/g, "_")}`;
    await copyFile(from, path.join(config.inputDir, name));
    staged.push(name);
  }

  /* 3. The renderer, through the Studio's own door. */
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "reactive_video.mjs");
  const args = paintArgs({ srcDir, song, start, styles: staged, run: runName, width, height, dials });
  await rm(path.join(config.outputDir, runName), { recursive: true, force: true }).catch(() => {});
  await waitForEngine();
  await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [script, ...args], {
      cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
      env: { ...process.env, AIPLAY_URL: `http://127.0.0.1:${config.uiPort}` },
      windowsHide: true,
    });
    let err = "", last = "";
    proc.stdout.on("data", (d) => {
      const s = String(d);
      last = s.trim().split("\n").pop() || last;
      const m = s.match(/(\d+)\/(\d+)\s+drive/);
      if (m && onProgress) onProgress({ frame: Number(m[1]), frames: Number(m[2]), line: last });
    });
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", (e) => reject(new Error(`could not start the renderer: ${e.message}`)));
    proc.on("close", (code) => {
      if (code === 0) return resolve();
      /* The FIRST lines of stderr carry the sentence; the last carry the stack. */
      const why = err.trim().split(/\r?\n/).filter((l) => l.trim() && !/^\s+at /.test(l)).slice(0, 3).join(" ") || last;
      reject(new Error(`the paint renderer stopped (${code}): ${why.slice(0, 600)}`));
    });
  });

  /* 4. The frames become a library clip (video only — the compositor puts the
   *    song on the piece), and the ledger says what it was made from. */
  const file = `aiplay_paint_${id}.mp4`;
  const out = path.join(o.clipDir, file);
  const asm = await run(ffmpegPath(), ["-y", "-hide_banner", "-loglevel", "error", "-framerate", String(dials.fps),
    "-i", path.join(config.outputDir, runName, "f_%05d_.png"), "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", out]);
  if (asm.err) throw new Error(`the painted frames could not be assembled: ${asm.stderr.trim().split("\n").pop() || asm.err.message}`);
  await prov.append("library", {
    actor, type: "edit", asset: `clips/${file}`,
    data: { op: "paint", source: `clips/${clip}`, song, start, seconds, styles, dials, width, height, frames, run: runName,
            note: "frames rendered one by one through the engine door as script:reactive_video; assembled here" },
  }).catch((e) => console.error(`  [provenance] event lost (edit/clips/${file}): ${e.message}`));
  return { file, frames, seconds: Math.round((Date.now() - t0) / 1000), run: runName, dials, size: [width, height] };
  } finally {
    /* Staged frames and pictures are files in the engine's dropdown nobody put
     * there on purpose; the run's frames are the clip's now. Gone either way. */
    await cleanup();
  }
}
