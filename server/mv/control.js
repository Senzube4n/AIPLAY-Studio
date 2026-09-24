/**
 * Video Workflow — STRUCTURAL CONTROL: a real video steers the render.
 *
 * previz.js is the sibling of this file and the two are deliberately opposite,
 * which is the first thing to understand before using either.
 *
 *   PREVIZ    grey boxes, real camera move, marked use:HUMAN-REVIEW. A director
 *             watches it. It is NEVER handed to a model — previz.js says so in
 *             its own header and writes a sidecar beside every clip repeating
 *             it, because LTX's appearance-guide path was measured against
 *             exactly this and is a decisive negative: the arms that appeared
 *             to follow the move did so by handing the grey boxes back.
 *   CONTROL   this file. A real clip on WAN 2.1 VACE's `control_video`, which
 *             is a different mechanism and a measured positive — VACE leaves
 *             the latent as noise and pushes it with a scaled additive residual
 *             (comfy/ldm/wan/model.py:854), and the gate's arm W1 scored CMA
 *             0.924 against a 0.50 floor while staying GENERATED rather than
 *             reconstructed (SSIM_block 0.524 against a 0.736 bar).
 *
 * So "do not feed the previz to the model" and "feed a clip to the model" are
 * both true, about two different paths, and the difference is the node.
 *
 * ── WHAT THIS FILE IS, AND WHAT IT IS NOT ──────────────────────────────────
 *
 * It is the WIRING. server/control/ holds the contract and the two graph
 * builders and executes nothing at all: `vaceGraph()` and `poseGraph()` return
 * plain JSON, `validateControlClip()` measures a file with ffprobe, and that is
 * the whole of it. This file is the only thing that stages files, spends the
 * GPU and writes to a project — and it spends the GPU exactly one way, through
 * `engine.dispatch()`.
 *
 * ⚠ THAT IS NOT A STYLE CHOICE. server/control/control.js used to end with its
 * own small engine client — a `fetch` to the engine's own port and a history
 * poll — written to take one proof render without editing art.js. It is deleted
 * (see the note at the end of that file), and what replaces it is not a smaller
 * client: dispatch() writes the graph, the prompt, the seed, every model file
 * and every reference's SHA-256 to the ledger BEFORE the GPU spends a
 * millisecond, and it records a render that FAILS as well as one that finishes.
 * A control render is therefore in `/api/provenance?prefix=engine/` beside
 * every other render on this machine, and its `references` carry the source
 * clip's digest — which is what makes "which clip steered this" answerable from
 * the record rather than from somebody's memory.
 *
 * ── THE GATE IS THE FEATURE, AND IT RUNS FIRST ─────────────────────────────
 *
 * A control clip must be EXACTLY 1280x704, EXACTLY 24.000 fps and AT LEAST 121
 * frames, and all three fail SILENTLY: the wrong size is bilinear-resampled and
 * CENTRE-CROPPED (nodes_wan.py:319), a short clip is clamped and then padded
 * with flat mid-gray (nodes_images.py:157 + nodes_wan.py:321) so the end of the
 * shot conditions on nothing, and nothing in the path reads fps at all so a
 * 30 fps source is silently retimed. Each produces a finished mp4 that is not
 * the shot you asked for, after the render time is spent — this project has
 * already thrown away a minute of GPU to a 96-frame clip once.
 *
 * So `validateControlClip()` runs BEFORE anything is staged and its refusal is
 * returned VERBATIM, naming which number is wrong and what it has to be. A
 * caller told "frame count is 96, must be at least 121" fixes it in one go; a
 * caller told "out of spec" re-renders twice.
 *
 * ── THE POSE PATH COMPOSES, AND IT IS TWO RENDERS ──────────────────────────
 *
 * mode "pose" is extract-then-steer: DWPose turns the source into a 121-frame
 * skeleton at the same three numbers, and that skeleton is then the control
 * video. The skeleton is validated too — a control clip is a control clip — and
 * the composition is the README's own measured claim: a VACE render fed back
 * through the gate comes out {ok:true, 1280x704, 24, 121}.
 *
 * ⚠ READ POSE_GATE.caveats BEFORE PROMISING ANYBODY A DANCE. The pose gate
 * passed — 33.7 px mean joint error against a 119.9 px frozen-skeleton null —
 * but DWPose found no figure at all in 43 of the 121 output frames (the closest
 * ones), the source is a man at a console with no legs in shot, and the hands
 * are not followed. Every surface here carries those caveats out of the data
 * rather than restating them.
 */
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, unlink, stat } from "node:fs/promises";
import { engine } from "../engine/client.js";
import { config } from "../config.js";
import { CATALOG } from "../models.js";
import { validateControlClip, CONTROL_SPEC } from "../control/control.js";
import { poseGraph, POSE_GATE, DWPOSE_MODELS } from "../control/pose.js";
import { depthGraph, depthModelFor, DEPTH_MODELS, DEPTH_DEFAULT, DEPTH_GATE } from "../control/depth.js";
import { execFile } from "node:child_process";
import { ffmpegPath } from "../clipjoin.js";
import * as prov from "../provenance.js";
import {
  vaceGraph, judgeStrength, VACE_SIZE, VACE_PRESET, VACE_OPERATING_POINT,
  VACE_STRENGTH_LADDER, VACE_LICENCE, VACE_LICENCE_VERIFIED, DEFAULT_NEGATIVE,
} from "../control/vace.js";
import { readProject, updateProject, assetsDir, noteRun } from "./store.js";
import { castContext, castFlags } from "./generate.js";
import { assertSafe } from "../safety/refusal.js";

/**
 * THE THREE MODES, as data, because the page and the tools both read them and a
 * list typed into a page is a list that goes stale.
 *
 * `extract` is separated from `pose` on purpose and it is not a convenience: a
 * skeleton is itself a valid control clip, it costs half a minute rather than
 * half an hour, and it is worth LOOKING AT before spending the render — the
 * pose gate's sharpest caveat is that DWPose cannot see stylised frames, and
 * that is visible in the skeleton long before it is visible in the output.
 */
/**
 * ── WHERE A CONTROL CLIP COMES FROM, AND WHY THE BLOCKOUT IS NOT IN THE
 *    CLIPS LIBRARY ──────────────────────────────────────────────────────────
 *
 * The blockout previz_shot renders is a legal control clip — 1280x704, 24.000
 * fps, 121 frames, proven by ffprobe like any other. So it needed a door, and
 * there were exactly two designs. This is the one the code already suggested,
 * and the argument is worth writing down because the other one is the obvious
 * one.
 *
 * THE ONE NOT TAKEN: adopt the blockout into the CLIPS LIBRARY with a
 * kind:"blockout" tag, and let it be picked by name like any other source.
 * That library is `<output>/clips` and it is SHARED — Studio's timeline, the
 * compositor, the video lab and `/api/clips` all read it, and `import_clip`
 * offers everything in it as a scene's TAKE. Putting a grey-box clip on that
 * shelf makes "the boxes ended up in the finished film" a single mis-click,
 * and previz.js writes to `assetsDir` rather than there for exactly that
 * reason. A `kind` tag does not fix it: the tag is in a sidecar map, and the
 * pickers list names.
 *
 * THE ONE TAKEN: the route resolves it. And this is not a new pattern here —
 * it is the pattern this very function ALREADY uses for `reference`, twenty
 * lines below. A reference is a project ASSET, named by the caller, resolved
 * by the server under `assetsDir(slug)`, refused with a sentence when it is
 * not one of this project's. A blockout is the same kind of thing: project-
 * owned, produced by this project's own previz path, meaningless anywhere
 * else. And it honours the stated reason `clip` is a library name and not a
 * path — "the browser cannot hand a server one and neither should an agent" —
 * because the caller still names a RECORD and the server still resolves the
 * path.
 *
 * So: one discriminator, `source`, and the blockout is resolved from the
 * project's own previz rows by segment. It is data rather than prose for the
 * same reason CONTROL_MODES is: the page builds its picker from this.
 */
export const CONTROL_SOURCES = [
  { source: "clip", needs: "clip",
    what: "A video NAME from the clips library — a render, an import, or a skeleton.",
    where: "the clips library" },
  { source: "blockout", needs: "a blockout on this shot",
    what: "This shot's own blockout: the grey-box control clip previz_shot renders at the "
      + "contract, staged from a blocking spec, with the per-frame projected position of "
      + "every figure in its sidecar.",
    where: "this project's assets" },
];

export const CONTROL_MODES = [
  /* ⚠ `check` SPENDS NOTHING AND EXISTS FOR THAT REASON. It measures the clip
   * with ffprobe and stops. A person choosing a source clip finds out whether
   * it is 1280x704 at 24.000 fps with 121 frames BEFORE they press a button
   * that costs half an hour — which is the same refusal the render itself
   * makes, moved to where it is free. It is the same action and the same code
   * path, so the answer the card shows and the answer the render gives cannot
   * disagree. */
  { mode: "check", renders: 0,
    what: "Measure the clip against the three numbers and say so. No staging, no GPU.",
    costMinutes: 0 },
  { mode: "camera", renders: 1,
    what: "VACE on the clip exactly as given. This is the measured path — arm W1, CMA 0.924.",
    costMinutes: 32 },
  { mode: "pose", renders: 2,
    what: "DWPose the clip into a skeleton, then VACE on the skeleton. The performance path.",
    costMinutes: 34.5 },
  { mode: "extract", renders: 1,
    what: "The skeleton alone, adopted into the clip library. Look at it, then use it as the "
      + "source of a camera render — a skeleton passes the same gate any control clip does.",
    costMinutes: 0.5 },
  /* THE THIRD DOOR: DEPTH. Where everything is and how far, with nothing said
   * about what it looks like — the structure a video-to-video restyle keeps
   * while the prompt and a reference picture supply the look. Depth Anything
   * V2 Small by default (Apache-2.0); Large is a named, non-commercial choice.
   * ⚠ Unscored: no depth arm has been measured (server/control/depth.js,
   * DEPTH_GATE). Costed as the pose path's shape — one extraction, one render. */
  { mode: "depth", renders: 2,
    what: "Depth Anything V2 reads the clip into a depth video, then VACE on that. The structure "
      + "path: the person, the room and the move survive; the prompt and a reference supply the "
      + "look. ⚠ Unscored — watched, not measured.",
    costMinutes: 33 },
  { mode: "extract_depth", renders: 1,
    what: "The depth video alone, adopted into the clip library. Look at it, then use it as the "
      + "source of a camera render — it passes the same gate any control clip does.",
    costMinutes: 0.5 },
  /* CONFORM SPENDS NO GPU AND EXISTS FOR A FAILING CHECK. The gate refuses a
   * 720p or 30 fps clip by number and says what the numbers must be; this is
   * the mode that makes them so — scale to COVER (never letterbox: the model
   * would paint the bars), centre-crop, retime to 24, drop the sound — and
   * writes a NEW clip into the library that passes. Nothing silent: the
   * original is untouched and the new name says what it is. */
  { mode: "conform", renders: 0,
    what: "Fit any video to the contract: the 121 frames (5.04 s) from `start` seconds in, scaled "
      + "to cover 1280x704 and centre-cropped, retimed to 24 fps, sound dropped, written to the "
      + "clip library as a new clip that passes the gate. ffmpeg on the CPU, no GPU.",
    costMinutes: 0.1 },
];

/** Which files may be a control clip. The same list import_clip enforces, for
 *  the same reason: a scene's take must be a video and so must a control. */
const VIDEO_RE = /\.(mp4|webm|mov|mkv|m4v)$/i;
/** And which may be a reference. WanVaceToVideo's reference_image is an IMAGE
 *  (read off the live node, 2026-09-03), so LoadImage feeds it and a clip does
 *  not. */
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

/**
 * WHAT A SURFACE MAY SAY ABOUT THIS PATH — the whole catalogue, from the data
 * rather than from prose typed into a page.
 *
 * `GET /api/mv/control` returns this, exactly as `GET /api/mv/previz` returns
 * the move vocabulary, so `server/mv/ui_test.js`'s "no literal in the page"
 * rule holds: the three numbers, the ladder, the ~32 minutes and both licence
 * answers reach the card as payload and can only ever be one version of
 * themselves.
 *
 * ⚠ TWO LICENCE ANSWERS, NEVER ONE. WAN's is settled — LICENSE.txt diffed
 * against canonical Apache-2.0 at a pinned revision, similarity 1.000000, no
 * territory clause, so this adds no row to territory_test.js. The DWPose
 * ESTIMATOR's is not: `posePreprocess` ships outputRights.class "unknown" and
 * sellable null because its redistributor's entire model card is 28 bytes. A
 * card that showed one settled claim for the whole control path would be
 * overstating exactly the half that is unread, so both come back and the mode
 * that uses the estimator carries its own answer.
 */
export function controlCatalogue() {
  const pose = CATALOG.find((c) => c.id === "posePreprocess") || null;
  const depth = CATALOG.find((c) => c.id === "depthPreprocess") || null;
  const wan = CATALOG.find((c) => c.id === "videoControl") || null;
  return {
    spec: CONTROL_SPEC,
    size: VACE_SIZE,
    preset: VACE_PRESET,
    modes: CONTROL_MODES,
    sources: CONTROL_SOURCES,
    operatingPoint: VACE_OPERATING_POINT,
    ladder: VACE_STRENGTH_LADDER,
    defaultNegative: DEFAULT_NEGATIVE,
    /* The measured cost, from the two renders that were actually taken on this
     * rig. Named as one render each rather than as an average of many, because
     * that is what they are. */
    cost: {
      vaceMinutes: 31.99,
      poseSeconds: POSE_GATE.extraction_seconds,
      poseVaceMinutes: Math.round((POSE_GATE.render_seconds / 60) * 100) / 100,
      /* null until a depth arm is measured — DEPTH_GATE says so in words. */
      depthSeconds: DEPTH_GATE.extraction_seconds,
      why: "One 1280x704 x 121-frame VACE render measured 31.99 minutes on this rig (README.md, "
        + "the proof render) and the pose gate's measured 33.87. The DWPose extraction measured "
        + "26.4 s. These are single renders on one machine, not a distribution.",
    },
    poseGate: {
      ran: POSE_GATE.ran,
      frames: POSE_GATE.frames, framesScored: POSE_GATE.frames_scored,
      mjePx: POSE_GATE.mje_px, rMean: POSE_GATE.r_mean,
      nullReversed: POSE_GATE.null_reversed, nullStatic: POSE_GATE.null_static,
      identityZ: POSE_GATE.identity_z,
      /* ⚠ CARRIED, NOT SUMMARISED. An agent or a person who reads "33.7 px,
       * r 0.893" and not "43 of 121 frames were unscored and the source has no
       * legs in it" will schedule a full-body dance on this and be wrong. */
      caveats: POSE_GATE.caveats,
    },
    licence: {
      vace: { text: VACE_LICENCE, verified: VACE_LICENCE_VERIFIED,
              class: wan?.outputRights?.class ?? null,
              sellable: wan?.outputRights?.sellable ?? null,
              url: wan?.outputRights?.url ?? null },
      /* The pose half, and it is a different answer. Only the modes that run
       * DWPose are governed by it — which is why the shape is per-model rather
       * than one sentence for the card. */
      pose: { class: pose?.outputRights?.class ?? "unknown",
              sellable: pose?.outputRights?.sellable ?? null,
              url: pose?.outputRights?.url ?? null,
              note: pose?.outputRights?.note ?? null,
              models: DWPOSE_MODELS,
              appliesTo: ["pose", "extract"] },
      /* The depth half: its OWN answer, per model, because the two models the
       * card offers carry different terms — Small is Apache-2.0 by its
       * authors' statement, Large is CC-BY-NC-4.0 — and the card must say
       * which one made a depth video rather than average them. */
      depth: { class: depth?.outputRights?.class ?? "unknown",
               sellable: depth?.outputRights?.sellable ?? null,
               url: depth?.outputRights?.url ?? null,
               note: depth?.outputRights?.note ?? null,
               models: DEPTH_MODELS, default: DEPTH_DEFAULT,
               gate: DEPTH_GATE,
               appliesTo: ["depth", "extract_depth"] },
    },
  };
}

/* ───────────────────────────────────────────────────────────── staging */

/**
 * `LoadVideo.file` and `LoadImage.image` are COMBOs over the ENGINE'S OWN INPUT
 * DIRECTORY. A path does not resolve there — it is a dropdown, and the value
 * has to be a basename that already exists in that folder. So every file this
 * path uses is copied in first and passed by basename.
 *
 * Named from the SOURCE PATH rather than from its bytes, as art.js's enhance
 * path does, so a clip name with anything awkward in it cannot reach the graph;
 * and suffixed PER CALL, which art.js does not need and this path does: two
 * concurrent renders of the same clip would otherwise share one staging file,
 * and the first `finally` to run would unlink it from under the other's LoadVideo.
 * Every copy is removed in a `finally`; the suffix is what makes that safe.
 */
async function stageIn(src, tag) {
  const staged = `aiplay_ctl_${tag}_${createHash("sha1").update(src).digest("hex").slice(0, 10)}_${randomBytes(3).toString("hex")}`
    + path.extname(src).toLowerCase();
  await mkdir(config.inputDir, { recursive: true });
  await writeFile(path.join(config.inputDir, staged), await readFile(src));
  return staged;
}

const unstage = (name) =>
  (name ? unlink(path.join(config.inputDir, name)).catch(() => {}) : Promise.resolve());

/**
 * Where a rendered output really is now.
 *
 * The door ADOPTS a video into the clip library, which MOVES it — so the file
 * is at CLIP_DIR/<name> when `adoptedAs` is set and in the output folder under
 * the engine's own subfolder when it is not. Getting this wrong is how a second
 * render reads the wrong file, and it is the kind of thing that only shows up
 * on the pose path where the first output is the second render's input.
 */
function landedAt(out, CLIP_DIR) {
  if (out.adoptedAs) return path.join(CLIP_DIR, path.basename(out.adoptedAs));
  return path.join(config.outputDir, out.subfolder || "", out.file);
}

/** The first video the graph wrote. SaveVideo reports an mp4 under `images`
 *  with animated:true — measured out of this engine's own history — so the kind
 *  is not trusted and the extension is read instead. */
function firstVideo(outputs) {
  /* ⚠ NOT THE INPUT ECHO. On ComfyUI 0.36 LoadVideo reports the clip it READ as
   * an output row of type "input" — node 20, listed before SaveVideo — and the
   * first video row was then the staged source, which is deleted in `finally`:
   * measured 2026-09-18, a finished depth extraction answered CONTROL CLIP
   * MISSING for a file the graph never wrote. What the graph wrote is type
   * "output"; the echo is skipped by kind, not by name. */
  const rows = (outputs || []).filter((o) => (o.type || "output") !== "input");
  return rows.find((o) => VIDEO_RE.test(o.file || "")) || rows[0] || null;
}

/* ─────────────────────────────────────────────────────────── the render */

/**
 * ONE CONTROL RENDER, gate first, door only.
 *
 * @param deps.CLIP_DIR  the clip library folder, injected the way every other
 *                       route dependency is.
 * @param slug           the project. The record, the ledger's `project` field
 *                       and the library row all hang off it.
 * @param clip           a NAME in the clips library. Not a path: the browser
 *                       cannot hand a server one and neither should an agent.
 * @param mode           camera | pose | extract — see CONTROL_MODES.
 * @param actor          provenance.actorFrom(req). NEVER invented here: the
 *                       door refuses a request it cannot attribute, and filing
 *                       renders under a name that means "the app did this on
 *                       its own" is not a smaller lie than no record at all.
 */
/**
 * conformClip(src, name, CLIP_DIR, measured, actor) -> { file, path, seconds, filter }
 *
 * ffmpeg, and the four things it does are the four numbers the gate refuses:
 * scale to COVER the contract size (force_original_aspect_ratio=increase, so a
 * 16:9 clip loses 8 rows top and bottom rather than gaining black bars the
 * model would paint), centre-crop to exactly 1280x704, retime to 24.000 fps,
 * and drop the sound — a control clip is frames. libx264 at crf 14, the same
 * quality the extend path joins at. The frame floor is checked BEFORE ffmpeg
 * runs, because conforming cannot invent frames.
 *
 * EXACTLY 121 FRAMES, FROM `start` SECONDS IN. The render uses the first 121
 * frames and no more, and every graph on this path decodes the WHOLE clip
 * before ImageFromBatch takes its 121 — measured: a 1099-frame conform sat the
 * GPU at 2 % for minutes while LoadVideo decoded 46 s of 1280x704 into RAM. So
 * the window is cut here, once, and `start` is how you choose which five
 * seconds of a longer video steer the shot.
 */
async function conformClip(src, name, CLIP_DIR, measured, actor, start = 0) {
  const W = CONTROL_SPEC.width, H = CONTROL_SPEC.height, FPS = CONTROL_SPEC.fps, N = CONTROL_SPEC.minFrames;
  const fpsIn = Number(measured.fps) || 0, framesIn = Number(measured.frames) || 0;
  const from = Math.max(0, Number(start) || 0);
  const secondsIn = fpsIn > 0 ? framesIn / fpsIn : 0;
  const framesOut = Math.floor(Math.max(0, secondsIn - from) * FPS);
  if (framesOut < N) {
    throw new Error(`${name} is ${framesIn} frames at ${fpsIn.toFixed(3)} fps (${secondsIn.toFixed(2)} s) — `
      + `${from ? `from ${from} s in, ` : ""}${framesOut} frames once retimed to ${FPS}, and the contract `
      + `needs ${N} (${(N / FPS).toFixed(2)} s). Conforming cannot invent frames; `
      + `${from ? "start earlier, or " : ""}use a longer clip.`);
  }
  const base = path.basename(name).replace(/\.[a-z0-9]+$/i, "").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40);
  const tag = createHash("sha1").update(`${name}\u0000${measured.width}x${measured.height}@${fpsIn}@${from}`).digest("hex").slice(0, 6);
  const file = `aiplay_ctl_${base}_${W}x${H}_${from ? `s${String(from).replace(".", "p")}_` : ""}${tag}.mp4`;
  const out = path.join(CLIP_DIR, file);
  const filter = `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},fps=${FPS},format=yuv420p`;
  const args = ["-y", "-hide_banner", "-loglevel", "error",
    ...(from ? ["-ss", String(from)] : []), "-i", src, "-vf", filter, "-an",
    "-frames:v", String(N),
    "-c:v", "libx264", "-preset", "medium", "-crf", "14", "-r", String(FPS), "-movflags", "+faststart", out];
  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    execFile(ffmpegPath(), args, { timeout: 15 * 60_000, maxBuffer: 8 << 20 }, (err, _stdout, stderr) => {
      if (!err) return resolve();
      reject(new Error(err.code === "ENOENT"
        ? `ffmpeg was not found (tried ${ffmpegPath()}). This app ships without ffmpeg by promise: `
          + "install it, or point AIPLAY_FFMPEG at a binary, and ask again."
        : `ffmpeg failed: ${String(stderr || "").trim().split("\n").slice(-2).join(" ") || err.message}`));
    });
  });
  /* On the record: an EDIT of a clip the person supplied, naming the source,
   * the four numbers before and after, and the filter — so the chain of a
   * render steered by this clip reaches the footage it came from. */
  await prov.append("library", {
    actor, type: "edit", asset: `clips/${file}`,
    data: {
      op: "conform", source: `clips/${path.basename(name)}`,
      from: { width: measured.width, height: measured.height, fps: measured.fps, frames: measured.frames },
      to: { width: W, height: H, fps: FPS, frames: N, start: from }, filter, audio: "dropped",
    },
  }).catch((e) => console.error(`  [provenance] event lost (edit/clips/${file}): ${e.message}`));
  return { file, path: out, filter, start: from, seconds: Math.round((Date.now() - t0) / 100) / 10 };
}

export async function controlRender(deps, slug, {
  segmentId = null, source = "clip", clip = null, reference = null, mode = "camera",
  prompt = null, negative = null, seed = null,
  strength = VACE_OPERATING_POINT.strength,
  /* Which Depth Anything V2 reads the clip in the depth modes: "small" (the
   * default, Apache-2.0) or "large" (CC-BY-NC-4.0). Judged by name before
   * anything is staged, like every other argument. */
  model = null,
  /* conform only: the second of the source the 121-frame window starts at. */
  start = 0,
  actor = "system",
} = {}) {
  const CLIP_DIR = deps?.CLIP_DIR;
  if (!CLIP_DIR) throw new Error("controlRender needs CLIP_DIR — the clip library it reads and writes.");

  const doc = await readProject(slug);
  if (!doc) throw new Error(`No such project: ${slug}`);
  if (doc.kind === "audiobook") throw new Error("Structural control is for video projects.");

  if (!CONTROL_MODES.some((m) => m.mode === mode)) {
    throw new Error(`No control mode called "${mode}". They are: ${CONTROL_MODES.map((m) => m.mode).join(", ")}.`);
  }
  if (!CONTROL_SOURCES.some((x) => x.source === source)) {
    throw new Error(`No control source called "${source}". They are: `
      + `${CONTROL_SOURCES.map((x) => x.source).join(", ")}.`);
  }

  /* ── WHERE THE FRAMES COME FROM ──────────────────────────────────────────
   * Two doors, one gate. Whichever door the clip came through, `src` is a real
   * path on this machine and everything below it — the measurement, the
   * staging, the graph, the ledger — is identical. That is the property worth
   * protecting: a blockout is not a second, softer path, it is the same path
   * with a different way of naming the file. */
  let src = null, name = null, fromBlockout = null;

  if (source === "blockout") {
    /* NAMED BY THE SHOT, NOT BY THE FILE. `clip` is refused rather than
     * ignored here for `reference`'s reason, forty lines down: silently
     * dropping an argument somebody typed is how a person concludes it "did
     * nothing". */
    if (clip != null && String(clip).trim()) {
      throw new Error(`source "blockout" takes this shot's own blockout, so \`clip\` has nowhere `
        + `to go. Drop it, or use source "clip" to steer with ${String(clip).trim()}.`);
    }
    const want = segmentId ?? null;
    const rows = (doc.previz || []).filter((r) => r.kind === "blockout" && r.clipFile
      && (want === null
        ? (r.segmentId ?? null) === null
        : (r.segmentId === want || r.segmentIndex === want || r.segmentIndex === Number(want))));
    if (!rows.length) {
      const any = (doc.previz || []).filter((r) => r.kind === "blockout").length;
      throw new Error(
        `${want === null ? "This project has" : `Scene ${want} has`} no blockout to steer with. `
        + "Render one first — previz_shot with `blockout: true` and a blocking spec — and it "
        + "lands in this project's assets at the control contract, ready for this button."
        + (any ? ` (${any} blockout${any > 1 ? "s exist" : " exists"} on other shots; a blockout `
                 + "belongs to the shot it was staged for, so it is not offered here.)" : ""));
    }
    /* NEWEST WINS, and every candidate is reported. A shot can carry a
     * blockout per MOVE — previz_shot's row id is per (segment, kind, move) —
     * so "this shot's blockout" can be more than one file. Picking the newest
     * is the only rule a person can predict without reading this code (they
     * just rendered it), and `candidates` on the way out means the surface can
     * say which others were there rather than the choice being invisible. */
    const row = rows.slice().sort((a, b) => (b.at || 0) - (a.at || 0))[0];
    name = row.clipFile;
    src = path.join(assetsDir(slug), path.basename(name));
    try { await stat(src); } catch {
      throw new Error(`${name} is recorded as this shot's blockout but is not on disk any more. `
        + "Re-render it: previz_shot with `blockout: true`.");
    }
    fromBlockout = {
      id: row.id, move: row.move,
      /* WHICH CRANE, not merely "a crane". Once a move can be STEERED —
       * aim_at, rise, climb, degrees, framing — the move NAME stops
       * identifying the shot: the same word covers a camera that holds the
       * idol for 121 frames and one that loses it after 42 (measured, this
       * set, this staging, the two renders differing in nothing else). The
       * project row records the keywords beside the move and so does the
       * sidecar; this is the reader a person meets BEFORE they spend half an
       * hour of WAN on the answer. */
      moveArgs: row.moveArgs ?? null,
      scene: row.scene, frames: row.frames,
      specSha256: row.specSha256 ?? null, specFile: row.specFile ?? null,
      sidecarFile: row.sidecarFile ?? null, figures: row.figures ?? null,
      at: row.at ?? null,
      /* They ride in the candidate list too: two blockouts of one shot that
       * differ ONLY in their move arguments are two different shots, and a
       * list showing both as "crane" makes newest-wins look arbitrary. */
      candidates: rows.map((x) => ({ id: x.id, move: x.move,
                                     moveArgs: x.moveArgs ?? null, at: x.at ?? null })),
    };
  } else {
    name = String(clip || "").trim();
    if (!name) throw new Error("Give `clip`, a name from the clips library — the video that will steer the render.");
    if (!VIDEO_RE.test(name)) {
      throw new Error(`${name} is not a video. A control clip is frames: mp4, webm, mov, mkv or m4v.`);
    }
    src = path.join(CLIP_DIR, path.basename(name));
    try { await stat(src); } catch {
      throw new Error(`${name} is not in the clips library. A control clip is a library name, not a path.`);
    }
  }

  /* ⚠ THE GATE, BEFORE ANYTHING IS STAGED AND LONG BEFORE THE GPU. Its `why`
   * goes back word for word: it names which of the three numbers is wrong, what
   * the number has to be, and which line of the engine silently does the wrong
   * thing with it. This project has already spent a minute of render on a
   * 96-frame clip; the refusal IS the feature. */
  const measured = await validateControlClip(src);
  /* `conform` is the one mode that WANTS a failing measurement: it exists to
   * turn the refused clip into one that passes. Everything else refuses here. */
  if (!measured.ok && mode !== "check" && mode !== "conform") throw new Error(measured.why);

  const wantsPose = mode === "pose" || mode === "extract";
  const wantsDepth = mode === "depth" || mode === "extract_depth";
  const wantsVace = mode === "pose" || mode === "camera" || mode === "depth";
  /* The depth model, judged by name up here for the 96-frame clip's reason:
   * an unknown name must cost nothing, and it must never fall through to the
   * node's own default, which is the non-commercial one. */
  const depthModel = wantsDepth ? depthModelFor(model ?? DEPTH_DEFAULT) : null;
  if (!wantsDepth && model != null && String(model).trim()) {
    throw new Error(`mode "${mode}" runs no depth estimator, so \`model\` has nowhere to go. `
      + "It belongs to mode \"depth\" or \"extract_depth\".");
  }

  /* ⚠ DWPOSE ON A BLOCKOUT IS A HALF-MINUTE OF NOTHING, and it would not fail.
   * A blockout's figures are grey capsules: no face, no hands, no clothing,
   * nothing yolox was trained on. The extraction would run, find no person on
   * any frame, write a skeleton of empty black frames — which passes the
   * control-clip gate, because it is 1280x704 at 24.000 for 121 frames — and
   * then steer a VACE render with a blank. The pose gate already measured the
   * milder version of this: DWPose found no figure in 43 of 121 frames of a
   * finished ANIME render, and those were pictures of actual people.
   *
   * A blockout carries the CAMERA and the STAGING. Its sidecar even states
   * where each figure's neck and hip are on every frame, which is the same
   * information a skeleton would carry and is exact rather than estimated. So
   * the pose modes are refused here by name, before the half minute. */
  if (source === "blockout" && wantsPose) {
    throw new Error(
      `mode "${mode}" runs DWPose, and a blockout's figures are grey capsules — no face, no `
      + "hands, nothing the estimator was trained on. It would find no person on any frame, "
      + "write a skeleton of empty frames that passes the clip gate, and steer the render "
      + "with a blank. Use mode \"camera\": a blockout carries the camera move and the "
      + "staging, and its sidecar already states where every figure is on every frame.");
  }

  /* ⚠ EVERY ARGUMENT THIS CAN JUDGE WITHOUT A MACHINE, JUDGED HERE — above the
   * staging, and a long way above the first dispatch.
   *
   * This block used to hold only the prompt, and the rest were checked where
   * they were USED: the strength inside vaceGraph(), the reference just before
   * it was staged. On `mode: "camera"` that is still before the wire, so it
   * looked fine. On `mode: "pose"` it is not, and that is the whole point of
   * the mode: the VACE graph cannot be built until the skeleton EXISTS, so
   * every check that lived down there ran with a real DWPose render already
   * spent. Measured on the scratch instance 2026-09-03 — strength 5000, a
   * reference with the wrong extension, and a reference this project does not
   * have: three 400s, three POSTs to /prompt before them.
   *
   * That is the 96-frame clip's story with a different number on it, so it gets
   * the same answer. `judgeStrength` is vace.js's own sentence, asked early;
   * `refPath` is resolved here and merely COPIED later. */
  let safetyContext = [];
  let safetyFlags = [];
  if (wantsVace) {
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new Error("A control render needs a `prompt`. WAN renders a gray field from an empty "
        + "one and reports success, which is the worst kind of wrong.");
    }
    const judged = judgeStrength(strength);
    if (!judged.ok) throw new Error(judged.why);
    /* ⚠ THE MINORS RULE, BEFORE ANYTHING IS STAGED. This path goes straight
     * to the engine door and never through the art queue, so this is its
     * early refusal (the door checks the graph again). The reference sheet is
     * a picture; the words behind it are its row's description, and what its
     * adopted take was drawn as is its fingerprint (castFlags). The driving
     * clip is a picture too: a library clip carries its own history
     * (deps.lineage, server/safety/lineage.js); a blockout is grey capsules. */
    const refName = reference && String(reference).trim() ? path.basename(String(reference).trim()) : null;
    const refRow = refName
      ? [...(doc.characters || []), ...(doc.backgrounds || []), ...(doc.props || [])]
        .find((r) => r?.imageFile && path.basename(String(r.imageFile)) === refName)
      : null;
    const drive = source === "clip" && typeof deps?.lineage === "function"
      ? deps.lineage([name]) : { texts: [], flags: [] };
    safetyContext = [...(refRow ? castContext(doc, [refRow.name]) : []), ...(drive.texts || [])];
    safetyFlags = [...(refRow ? castFlags(doc, [refRow.name]) : []), ...(drive.flags || [])];
    assertSafe({ door: "mv.control", via: "mv.control", actor, texts: [prompt], context: safetyContext, flags: safetyFlags });
  }

  /* THE REFERENCE, RESOLVED BEFORE ANYTHING RUNS. Named on a mode that does not
   * use one, it is refused rather than ignored: `extract` writes a skeleton and
   * has nowhere to put a character sheet, and silently dropping an argument
   * somebody typed is how a person concludes the reference "did nothing". */
  let refPath = null;
  if (reference && String(reference).trim()) {
    const refName = path.basename(String(reference).trim());
    if (!wantsVace) {
      throw new Error(`mode "${mode}" renders no image, so it has nowhere to put ${refName}. `
        + "reference_image is WanVaceToVideo's input — use mode \"camera\", \"pose\" or \"depth\".");
    }
    if (!IMAGE_RE.test(refName)) {
      throw new Error(`${refName} is not an image. reference_image is an IMAGE input on `
        + "WanVaceToVideo (read off the live node), so a still is what goes there — a "
        + "single-panel character sheet, not a clip.");
    }
    refPath = path.join(assetsDir(slug), refName);
    try { await stat(refPath); } catch {
      throw new Error(`${refName} is not one of this project's assets. A reference is a sheet `
        + "this project already holds — render one first (mv_generate_asset or mv_blender_sheet).");
    }
  }
  /* MINTED, THEN RETURNED AND RECORDED — never hidden. vaceGraph refuses a
   * missing seed because this path exists to be reproducible; a seed nobody was
   * told is the same thing as no seed. */
  const usedSeed = Number.isFinite(Number(seed)) ? Math.floor(Number(seed))
    : Math.floor(Math.random() * 2_147_483_647);

  let stagedSource = null, stagedSkeleton = null, stagedDepth = null, stagedRef = null;
  const out = {
    slug, mode, source, clip: name, segmentId: segmentId ?? null,
    /* THE BLOCKOUT'S OWN RECORD, when that is where the frames came from.
     * `specSha256` is the staging's identity and `sidecarFile` is where the
     * per-frame projected figure positions live — which together are what
     * makes "was this render consistent with the blocking" a question anybody
     * can answer later, rather than a thing somebody remembers. */
    blockout: fromBlockout,
    /* THE MEASUREMENT ITSELF, always, whichever way the verdict went — a card
     * that says "refused" and not "96 frames, needs 121" sends somebody to
     * re-render blind. `why` is validateControlClip's own sentence, verbatim. */
    ok: measured.ok,
    why: measured.ok ? null : measured.why,
    validation: { width: measured.width, height: measured.height, fps: measured.fps, frames: measured.frames },
    pose: null, depth: null, conformed: null, render: null,
    operatingPoint: null,
  };

  /* THE FREE ANSWER, AND IT IS THE SAME ANSWER. Everything above this line —
   * the project, the mode, the library lookup and the measurement itself — has
   * already run, so a `check` is not a second, weaker validation standing
   * beside the real one. It IS the real one, stopped before it stages a byte.
   * That is why it returns the verdict rather than throwing: a refusal that a
   * card can paint beside the picker is worth more than an exception, and
   * nothing was spent to get it. */
  if (mode === "check") return out;

  /* ── CONFORM: ffmpeg, no staging, no GPU ─────────────────────────────
   * The clip that failed the gate becomes a NEW library clip that passes it,
   * and the new clip is measured by the same gate before it is reported —
   * a conform that wrote something off-contract would be the silent failure
   * this whole path exists to refuse. A blockout is already at the contract. */
  if (mode === "conform") {
    if (source === "blockout") {
      throw new Error("A blockout is rendered at the contract already; conform takes a library clip.");
    }
    if (measured.ok && !(Number(start) > 0)) {
      out.conformed = null;
      out.note = `${name} already passes the gate (${measured.width}x${measured.height}, `
        + `${Number(measured.fps).toFixed(3)} fps, ${measured.frames} frames) — nothing to conform.`;
      return out;
    }
    const made = await conformClip(src, name, CLIP_DIR, measured, actor, start);
    const again = await validateControlClip(made.path);
    if (!again.ok) throw new Error(`the conformed clip still fails the gate: ${again.why}`);
    out.conformed = {
      file: made.file, seconds: made.seconds, audio: "dropped", start: made.start,
      width: again.width, height: again.height, fps: again.fps, frames: again.frames,
      from: { width: measured.width, height: measured.height, fps: measured.fps, frames: measured.frames },
      filter: made.filter,
    };
    await updateProject(slug, (d) => {
      noteRun(d, { tool: "control_render", outcome: `conform: ${name} -> ${made.file}` });
      return d;
    });
    return out;
  }

  try {
    stagedSource = await stageIn(src, "src");

    /* ── 1. the skeleton, when the mode asks for one ───────────────────── */
    let control = stagedSource;
    if (wantsPose) {
      const graph = poseGraph({
        source: stagedSource,
        frames: CONTROL_SPEC.minFrames,
        width: measured.width, height: measured.height,
        prefix: `control/mv_${slug}_pose`,
      });
      /* 20 minutes, not the VACE 90: DWPose is a per-frame forward pass rather
       * than a diffusion sampler, and the gate measured 26.4 s for 121 frames.
       * The door keeps watching past this deadline either way — a run whose
       * caller stopped waiting is still recorded with its wall time. */
      const done = await engine.run({
        graph, actor, via: "mv.control.pose", clientId: "aiplay-mv-control",
        label: `pose skeleton — ${name}`, project: slug, shot: segmentId ?? null,
        adopt: true, timeoutMs: 20 * 60_000, pollMs: 2_000,
      });
      if (done.status !== "completed") {
        throw new Error(done.error || `the pose extraction did not finish (${done.status})`);
      }
      const file = firstVideo(done.outputs);
      if (!file) throw new Error("the extraction finished but saved nothing this could find.");
      const at = landedAt(file, CLIP_DIR);

      /* A SKELETON IS A CONTROL CLIP, so it goes through the same gate. This is
       * the composition README.md claims and it is cheap to check: if DWPose
       * ever wrote something off the three numbers, the VACE render below would
       * be silently centre-cropped or padded instead of failing here. */
      const skel = await validateControlClip(at);
      if (!skel.ok) throw new Error(skel.why);

      out.pose = {
        runId: done.runId, file: path.basename(at), adoptedAs: file.adoptedAs ?? null,
        sha256: file.sha256 ?? null, bytes: file.bytes ?? null,
        seconds: done.elapsedSec ?? null,
        width: skel.width, height: skel.height, fps: skel.fps, frames: skel.frames,
        models: DWPOSE_MODELS,
      };
      if (mode === "extract") {
        await recordRow(slug, out, { seed: null, strength: null });
        return out;
      }
      stagedSkeleton = await stageIn(at, "pose");
      control = stagedSkeleton;
    }

    /* ── 1b. the depth video, when the mode asks for one ─────────────── */
    if (wantsDepth) {
      const graph = depthGraph({
        source: stagedSource,
        frames: CONTROL_SPEC.minFrames,
        width: measured.width, height: measured.height,
        model: depthModel.key,
        prefix: `control/mv_${slug}_depth`,
      });
      /* A per-frame forward pass, like DWPose — the same 20-minute ceiling,
       * and the door records the run whatever the caller does. */
      const done = await engine.run({
        graph, actor, via: "mv.control.depth", clientId: "aiplay-mv-control",
        label: `depth map — ${name}`, project: slug, shot: segmentId ?? null,
        adopt: true, timeoutMs: 20 * 60_000, pollMs: 2_000,
      });
      if (done.status !== "completed") {
        throw new Error(done.error || `the depth extraction did not finish (${done.status})`);
      }
      const file = firstVideo(done.outputs);
      if (!file) throw new Error("the depth extraction finished but saved nothing this could find.");
      const at = landedAt(file, CLIP_DIR);
      /* A DEPTH VIDEO IS A CONTROL CLIP, so it goes through the same gate. */
      const dep = await validateControlClip(at);
      if (!dep.ok) throw new Error(dep.why);
      out.depth = {
        runId: done.runId, file: path.basename(at), adoptedAs: file.adoptedAs ?? null,
        sha256: file.sha256 ?? null, bytes: file.bytes ?? null,
        seconds: done.elapsedSec ?? null,
        width: dep.width, height: dep.height, fps: dep.fps, frames: dep.frames,
        model: { key: depthModel.key, ckpt: depthModel.ckpt, licence: depthModel.licence, commercial: depthModel.commercial },
        gate: DEPTH_GATE,
      };
      if (mode === "extract_depth") {
        await recordRow(slug, out, { seed: null, strength: null });
        return out;
      }
      stagedDepth = await stageIn(at, "depth");
      control = stagedDepth;
    }

    /* ── 2. the reference image ────────────────────────────────────────
     * Nothing is JUDGED here any more — it was judged above, before the pose
     * half could spend anything. All that is left is the copy. */
    if (refPath) stagedRef = await stageIn(refPath, "ref");

    /* ── 3. the render ─────────────────────────────────────────────────── */
    const graph = vaceGraph({
      control, reference: stagedRef, prompt: String(prompt),
      negative: typeof negative === "string" && negative.trim() ? negative : DEFAULT_NEGATIVE,
      seed: usedSeed, strength: Number(strength),
      masks: "ones",
      prefix: `control/mv_${slug}_${usedSeed}`,
    });
    /* 90 minutes, which is the VACE runner's own number and not a guess: a
     * 1280x704 x 121-frame render measured 31.99 minutes here, and 45-minute
     * deadlines abandoned renders that then finished. */
    const done = await engine.run({
      graph, actor, via: "mv.control", clientId: "aiplay-mv-control", safetyContext, safetyFlags,
      label: `${mode} control — ${name}`, project: slug, shot: segmentId ?? null,
      adopt: true, timeoutMs: 90 * 60_000, pollMs: 3_000,
    });
    if (done.status !== "completed") {
      throw new Error(done.error || `the control render did not finish (${done.status})`);
    }
    const file = firstVideo(done.outputs);
    if (!file) throw new Error("the render finished but saved no clip this could find.");

    out.render = {
      runId: done.runId, file: path.basename(landedAt(file, CLIP_DIR)),
      adoptedAs: file.adoptedAs ?? null,
      sha256: file.sha256 ?? null, bytes: file.bytes ?? null,
      seconds: done.elapsedSec ?? null, cached: done.cached ?? null,
    };
    out.operatingPoint = {
      strength: Number(strength), masks: "ones", seed: usedSeed,
      width: VACE_SIZE.width, height: VACE_SIZE.height, frames: VACE_SIZE.frames,
      steps: VACE_PRESET.steps, cfg: VACE_PRESET.cfg,
      reference: stagedRef ? path.basename(String(reference)) : null,
      /* ⚠ ON THE RECORD, and it is the honest half of the operating point. The
       * gate's four-rung ladder is a CAMERA result; the pose gate is one
       * render at strength 1.00 with one seed, one source and one reference. */
      measured: Number(strength) === VACE_OPERATING_POINT.strength && mode === "camera",
    };
    await recordRow(slug, out, { seed: usedSeed, strength: Number(strength) });
    return out;
  } finally {
    /* Best effort, always: a staged copy left behind is a file in the engine's
     * dropdown that nobody put there on purpose. */
    await unstage(stagedSource);
    await unstage(stagedSkeleton);
    await unstage(stagedDepth);
    await unstage(stagedRef);
  }
}

/**
 * ONE ROW PER RENDER, kept rather than replaced.
 *
 * previz.js replaces its row on a re-render because a previz is disposable. A
 * control render is half an hour of GPU with a seed and a strength on it, and
 * throwing away the record of an arm you decided against is how a strength
 * ladder becomes folklore. So these accumulate, newest last, with the operating
 * point on each — the same reason takes are kept.
 */
async function recordRow(slug, out, { seed, strength }) {
  await updateProject(slug, (d) => {
    if (!Array.isArray(d.control)) d.control = [];
    d.control.push({
      id: `ctl_${out.render?.runId || out.pose?.runId || out.depth?.runId}`,
      mode: out.mode, segmentId: out.segmentId,
      sourceKind: out.source, source: out.clip, sourceMeasured: out.validation,
      /* THE STAGING THAT PRODUCED THE CONTROL, on the row that spent the GPU.
       * A control render is reproducible from its seed and its strength; it is
       * only EXPLICABLE from what the control clip was, and for a blockout
       * that is a spec hash rather than a filename somebody may overwrite. */
      blockoutId: out.blockout?.id ?? null,
      specSha256: out.blockout?.specSha256 ?? null,
      poseRunId: out.pose?.runId ?? null, poseFile: out.pose?.file ?? null,
      depthRunId: out.depth?.runId ?? null, depthFile: out.depth?.file ?? null,
      depthModel: out.depth?.model?.key ?? null,
      runId: out.render?.runId ?? null, file: out.render?.file ?? null,
      sha256: out.render?.sha256 ?? out.pose?.sha256 ?? out.depth?.sha256 ?? null,
      /* THE OPERATING POINT IS THE EVIDENCE. A row that recorded only "a
       * control render happened" would be a row nobody can reproduce, and
       * reproducibility is the entire argument for pinning the seed. */
      seed, strength, masks: seed === null ? null : "ones",
      seconds: (out.pose?.seconds ?? 0) + (out.depth?.seconds ?? 0) + (out.render?.seconds ?? 0),
      at: Date.now(),
    });
    noteRun(d, {
      tool: "control_render",
      outcome: `${out.mode}: ${out.clip} -> ${out.render?.file || out.pose?.file || out.depth?.file || "(nothing)"}`,
    });
    return d;
  });
}
