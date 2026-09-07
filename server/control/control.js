/**
 * THE THREE NUMBERS, and the gate in front of them.
 *
 * A control clip that conditions WAN 2.1 VACE must be EXACTLY 1280x704, EXACTLY
 * 24.000 fps, and AT LEAST 121 frames. Every one of those three fails SILENTLY
 * when it is wrong — that is the whole reason this file exists. Not one of them
 * produces an error, a warning, or a red node. Each one produces a finished mp4
 * that is not the shot you asked for, after the render time is already spent.
 *
 * Here is what actually happens, read out of the engine on this disk rather
 * than reasoned about:
 *
 *  WRONG SIZE. comfy_extras/nodes_wan.py:319 —
 *      control_video = comfy.utils.common_upscale(
 *          control_video[:length].movedim(-1, 1), width, height, "bilinear", "center")
 *    A bilinear resample with a CENTRE CROP. Hand it 1920x1080 and it does not
 *    complain; it throws away the sides of your frame and stretches what is
 *    left. The framing you blocked in Blender is not the framing that
 *    conditions the render, and nothing anywhere says so.
 *
 *  WRONG FRAME COUNT. Two silent behaviours compound. First
 *    comfy_extras/nodes_images.py:157 —
 *      length = min(s_in.shape[0] - batch_index, length)
 *    ImageFromBatch CLAMPS: ask 121 of a 96-frame clip and you get 96, quietly.
 *    Then nodes_wan.py:321 pads the deficit —
 *      torch.nn.functional.pad(control_video, (...), value=0.5)
 *    — with 0.5, a flat mid-gray plate. So the last 25 frames of that render are
 *    conditioned on nothing at all, and the camera lets go at the end of the
 *    shot. This one has already cost a minute of render on this project once,
 *    which is why server/mv/previz.js enforces the floor before it spawns
 *    anything, and why it is enforced here again on the far side.
 *
 *  WRONG FRAME RATE. Nothing in this path reads fps. LoadVideo ->
 *    GetVideoComponents -> ImageFromBatch counts FRAMES, and the output
 *    CreateVideo is hard-set to 24. So a 30 fps source's 121 frames are 4.03
 *    seconds of blocked motion replayed over 5.04 seconds: the move is right,
 *    the pacing is 25% slow, and the file is perfectly valid. This is the one
 *    people argue with, because the clip looks fine.
 *
 * So the gate is: probe it, and refuse it by name and by number BEFORE the GPU
 * is asked for anything. The refusal names WHICH number is wrong and what it
 * has to be — a caller who is told "frame count is 96, must be at least 121"
 * fixes it in one go; a caller told "out of spec" re-renders twice.
 *
 * ffprobe. This app ships WITHOUT ffmpeg by promise (server/mv/routes.js says
 * so where it declines to probe a clip's length). So the absence of ffprobe is
 * a first-class answer here, not a crash: validateControlClip returns ok:false
 * with a `why` that says the probe could not be made and how to make it
 * possible. It never guesses, and it never passes a clip it could not measure.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * THE THREE NUMBERS. Kept as data so the sentences, the tests and any surface
 * that explains the rule all read from one place.
 *
 * These are not this file's numbers. 1280x704 and 24 fps are what the Blender
 * toolkit writes and verifies on its own side of a licence boundary; 121 is its
 * CONTROL_MIN_FRAMES.
 *
 * ⚠ THERE USED TO BE THREE COPIES OF 121: here, the toolkit, and a bare
 * `FRAMES_MIN` in server/mv/previz.js. Two of the three were too many, and the
 * near end is the one this repository owns — so previz.js now IMPORTS
 * `CONTROL_SPEC.minFrames` from here rather than restating it. The toolkit's
 * copy stays because it is across a licence boundary and is the authority; what
 * is gone is the second copy on this side, which could drift silently.
 */
export const CONTROL_SPEC = {
  width: 1280,
  height: 704,
  fps: 24,
  minFrames: 121,
};

/** fps comparison tolerance. A container writes 24/1 exactly; 24000/1001 is
 *  23.976, a different number, and it is meant to fail. */
const FPS_EPS = 1e-6;

/**
 * judgeClip(measured, spec) -> { ok, why }
 *
 * The pure half: given numbers, decide. Split out from the probe so the exact
 * refusal sentences are testable on a machine with no ffmpeg at all, and so a
 * caller who already measured a clip (a renderer that just wrote it, say) can
 * ask without shelling out.
 *
 * The message format is deliberately the Blender toolkit's own —
 *   CONTROL CLIP OUT OF SPEC: <file>
 *     - <what> is <got>, must be <want> (<why it matters>)
 * — so that a refusal from either side of the boundary reads the same to the
 * person who has to fix it. server/mv/previz.js quotes the far side's version
 * verbatim in its own comments.
 */
export function judgeClip({ file = "clip", width, height, fps, frames } = {}, spec = CONTROL_SPEC) {
  const bad = [];
  if (Number(width) !== spec.width) {
    bad.push(`width is ${fmt(width)}, must be exactly ${spec.width} `
           + `(WanVaceToVideo bilinear-resamples and CENTRE-CROPS anything else, silently — `
           + `nodes_wan.py:319)`);
  }
  if (Number(height) !== spec.height) {
    bad.push(`height is ${fmt(height)}, must be exactly ${spec.height} `
           + `(WanVaceToVideo bilinear-resamples and CENTRE-CROPS anything else, silently — `
           + `nodes_wan.py:319)`);
  }
  if (!(Math.abs(Number(fps) - spec.fps) <= FPS_EPS)) {
    bad.push(`frame rate is ${fmt(fps, 3)} fps, must be exactly ${spec.fps.toFixed(3)} `
           + `(nothing in this path reads fps — the frames are counted and replayed at 24, so a `
           + `wrong rate silently retimes the move)`);
  }
  if (!(Number(frames) >= spec.minFrames)) {
    bad.push(`frame count is ${fmt(frames)}, must be at least ${spec.minFrames} `
           + `(ImageFromBatch clamps to what exists — nodes_images.py:157 — and WanVaceToVideo `
           + `pads the deficit with flat mid-gray, so the end of the shot conditions on nothing)`);
  }
  if (!bad.length) return { ok: true, why: null };
  return {
    ok: false,
    why: `CONTROL CLIP OUT OF SPEC: ${file}\n  - ${bad.join("\n  - ")}`,
  };
}

function fmt(n, dp = 0) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "unreadable";
  return dp ? v.toFixed(dp) : String(v);
}

/**
 * Where ffprobe is, in order of who gets to decide:
 *   1. an explicit argument (a test, or a caller that already knows)
 *   2. AIPLAY_FFPROBE
 *   3. whatever is on PATH — the name alone, let the OS resolve it
 * Nothing is bundled and nothing is downloaded. If none of those runs, that is
 * an answer, not an exception.
 */
export function ffprobePath(explicit = null) {
  if (explicit) return explicit;
  if (process.env.AIPLAY_FFPROBE) return process.env.AIPLAY_FFPROBE;
  return process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
}

function run(bin, args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

/**
 * validateControlClip(file, opts) -> { ok, width, height, fps, frames, why }
 *
 * `file` is a real path on this machine. The three numbers are measured, never
 * assumed, and `why` is null exactly when ok is true.
 *
 * -count_frames is deliberate: nb_frames out of the container header is a claim
 * the muxer made, and a trimmed or re-wrapped clip lies about it. Counting
 * decodes the file — for a 121-frame 1280x704 clip that is well under a second,
 * and it is the difference between a measured number and a hopeful one.
 *
 * r_frame_rate over avg_frame_rate: r_frame_rate is the rational the stream
 * declares, so 24/1 compares exactly. avg_frame_rate is derived from duration
 * and drifts on a short clip.
 */
export async function validateControlClip(file, { ffprobe = null, spec = CONTROL_SPEC, timeoutMs = 60_000 } = {}) {
  const blank = { ok: false, width: null, height: null, fps: null, frames: null };
  if (typeof file !== "string" || !file.trim()) {
    return { ...blank, why: "validateControlClip needs a path to a control clip." };
  }
  const name = path.basename(file);
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { ...blank, why: `CONTROL CLIP UNREADABLE: ${file} is not a file.` };
  } catch {
    return { ...blank, why: `CONTROL CLIP MISSING: ${file} is not on this disk.` };
  }

  const bin = ffprobePath(ffprobe);
  const { err, stdout, stderr } = await run(bin, [
    "-v", "error",
    "-select_streams", "v:0",
    "-count_frames",
    "-show_entries", "stream=width,height,r_frame_rate,nb_read_frames",
    "-of", "json",
    file,
  ], timeoutMs);

  if (err && (err.code === "ENOENT" || /ENOENT/.test(String(err.message)))) {
    return { ...blank, why:
      `CONTROL CLIP NOT MEASURED: ${name} — ffprobe was not found (tried ${bin}), and this app `
      + `ships without ffmpeg by promise. A clip is never passed on trust: install ffmpeg, or `
      + `point AIPLAY_FFPROBE at an ffprobe binary, and ask again.` };
  }
  if (err) {
    return { ...blank, why:
      `CONTROL CLIP NOT MEASURED: ${name} — ffprobe failed (${String(err.message).split("\n")[0]}). `
      + `${stderr.trim().split("\n")[0] || ""}`.trim() };
  }

  let stream;
  try {
    stream = JSON.parse(stdout)?.streams?.[0];
  } catch {
    return { ...blank, why: `CONTROL CLIP NOT MEASURED: ${name} — ffprobe returned output this could not parse.` };
  }
  if (!stream) {
    return { ...blank, why: `CONTROL CLIP HAS NO VIDEO: ${name} has no video stream. A control clip is frames.` };
  }

  const width = Number(stream.width);
  const height = Number(stream.height);
  const fps = ratio(stream.r_frame_rate);
  const frames = Number(stream.nb_read_frames);

  const verdict = judgeClip({ file: name, width, height, fps, frames }, spec);
  return { ok: verdict.ok, width, height, fps, frames, why: verdict.why };
}

/** "24/1" -> 24. A rational, parsed as one, so 24/1 is exactly 24 and
 *  24000/1001 is exactly not. */
function ratio(s) {
  const m = /^(\d+)\/(\d+)$/.exec(String(s || "").trim());
  if (!m) { const v = Number(s); return Number.isFinite(v) ? v : NaN; }
  const den = Number(m[2]);
  return den === 0 ? NaN : Number(m[1]) / den;
}

/* ───────────────────── nothing below this line, on purpose ─────────────────
 *
 * ⚠ THIS FILE USED TO END WITH A SECOND ENGINE CLIENT — `engineBase`,
 * `postGraph`, `waitForPrompt`, `firstOutputFile` — and its own header called
 * itself the leftover. It is gone, and so is `extractPose`, the one caller that
 * made it necessary. Both were deleted rather than exempted.
 *
 * What was there: a `fetch` to `/prompt`, a `/history` poll loop, and a base
 * that resolved to 8266. All three existed only so this directory could take
 * ONE measured proof render (the 31.99-minute W1 VACE arm in README.md) without
 * editing art.js while another strand was live inside it. After the engine door
 * landed, NOTHING LISTENS AT 8266: the app picks an unpublished port at every
 * start and `server/engine/client.js` is the only file in this tree that knows
 * it. So the block had not merely become a duplicate — it had stopped working.
 *
 * What replaced it is not a smaller client. It is `server/mv/routes.js`'s
 * `control_render` case, which stages the clip, validates it, builds these
 * graphs and posts them through `engine.dispatch()` with the CALLER's actor. A
 * control render is therefore in the ledger before the GPU spends a
 * millisecond, its `engine/<runId>` record carries the source clip's SHA-256
 * among its `references`, and its output is adopted into the clip library with
 * that runId on it. None of that was possible from here.
 *
 * THIS MODULE IS NOW PURE except for the one measurement it exists to make:
 * `validateControlClip` shells out to ffprobe. It imports nothing from the app,
 * so a test, a route or an MCP tool can read the contract without dragging a
 * network client behind it — which is the same rule vace.js and pose.js already
 * hold for their graph builders.
 */
