/**
 * consistency_run.mjs — THE CROSS-CLIP CONSISTENCY EXPERIMENT, end to end.
 *
 * THE QUESTION. The camera gate (gate_run.mjs, vace_run.mjs) asked whether ONE
 * clip follows a blocked camera move. It got a decisive answer: LTX appearance
 * guides no, WAN VACE at strength 1.00 yes. That answer is about a single shot.
 * The thing a film needs and a single shot cannot show is whether TWO shots of
 * the SAME action, conditioned on the SAME geometry from DIFFERENT cameras, put
 * the same people in the same places — and whether a second take of the same
 * shot puts them there twice.
 *
 * So this harness renders three clips and scores them against a ground truth
 * that knows, analytically, where every neck and every hip is in world metres
 * and what pixel each one projects to under each camera:
 *
 *   C1S1  camera 1 (orbit),        seed 70117
 *   C2S1  camera 2 (static side),  seed 70117   — the SAME action, another camera
 *   C1S2  camera 1 (orbit),        seed 31337   — the SAME shot, another take
 *
 * Everything else is frozen and identical across the three: model, VACE strength
 * 1.00, 1280x704, 24 fps, 121 frames, sampler, steps, cfg, prompt, negative.
 * C1S1-vs-C2S1 isolates the camera. C1S1-vs-C1S2 isolates the seed. Nothing else
 * moves in either comparison, which is the only reason either number means
 * anything.
 *
 * WHAT IS BORROWED AND WHY IT IS BORROWED RATHER THAN RETYPED.
 *   - The graph is vace_run.mjs's W1 arm — the arm that PASSED the camera gate —
 *     with exactly one thing changed: the positive prompt names two figures
 *     instead of "a lone figure". Retyping the graph would mean this experiment
 *     could drift from the arm whose verdict it is building on, and the drift
 *     would be invisible: every number would still look plausible.
 *   - The dispatcher, the identity check and the camera-word guard come from
 *     gate_lib.mjs, so this script reaches the GPU the same way everything else
 *     in this repo does — through the app's engine door, with an actor header,
 *     and with a provenance record written before the card spends a millisecond.
 *
 * ⚠ adopt:false, and it is not a preference. consistency_score.py globs the raw
 * ComfyUI output tree (output/consistency/<clip>/*.mp4). Adoption MOVES a
 * finished clip into the app's library the instant it lands, and the glob would
 * then find nothing — silently. Same reasoning, same three-word answer, as
 * gate_run.mjs and vace_run.mjs.
 *
 * ⚠ 90 MINUTES PER RENDER, NOT 45. A WAN VACE arm at this contract measured
 * 32–35 min on this card in the camera gate. A 45-minute cap once abandoned a
 * batch of renders that then went on to finish; the deadline is the one number
 * in this file that must never be tightened to "save time".
 *
 * USAGE
 *   node scripts/consistency_run.mjs --plan          build + validate, post nothing
 *   node scripts/consistency_run.mjs --run           render, pose, score
 *   node scripts/consistency_run.mjs --pose          pose + score only (renders exist)
 *   node scripts/consistency_run.mjs --score         score only
 *   node scripts/consistency_run.mjs --ground-truth  re-render both blocking clips
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { config } from "../server/config.js";
import {
  assertNoCameraWords, probeClip, assertThreeNumbers, fileFacts,
  engineIdentity, structuralProblems, pixelLeaks, POLL,
} from "./gate_lib.mjs";

const BASE = process.env.AIPLAY_URL || "http://127.0.0.1:4173";
const ACTOR = process.env.AIPLAY_ACTOR || "script:consistency_run";
const INPUT = config.inputDir;
const OUTPUT = config.outputDir;
const GATE_OUT = path.join(OUTPUT, "gate");
const PY = "D:\\AI\\aiplay-studio-bench\\venv\\Scripts\\python.exe";
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };
const RUN = has("--run");
const POSE_ONLY = has("--pose");
const SCORE_ONLY = has("--score");
const GROUND_TRUTH = has("--ground-truth");

/**
 * --strength <v>   THE VACE STRENGTH FOR THIS PASS. Default 1.00, unchanged.
 *
 * The first pass of this experiment ran only at 1.00 — the operating point the
 * camera gate declared GREEN — and VACE reproduced the two-figure blockout AS
 * SLABS: DWPose found people in 1 frame out of 363 across three clips, so every
 * pose number came back empty. The gate's usable window is 0.5–1.0, and a LOWER
 * strength is exactly where the text conditioning ("two figures in dark coats")
 * can get a say against the gray boxes it is being handed. That is the one
 * variable worth moving, so it is the one this flag moves — and NOTHING else in
 * this file changes with it: same prompt, same seed, same graph, same size, same
 * sampler, same 121 frames.
 *
 * A non-default strength renders into its OWN subdirectory
 * (consistency/s050/<clip>/), stages its pose source under its own name and
 * carries the strength in its ledger label. All three matter: without them the
 * resume check would find the 1.00 render, call this arm "already rendered", and
 * a sweep would silently report the number it was run to question.
 *
 * --only C1S1[,C2S1]   render/pose/score a SUBSET of the three clips. A strength
 * sweep asks one question — do people appear — and asks it on one camera first;
 * rendering the other two arms at every strength costs an hour each to answer a
 * question nobody asked yet.
 */
const STRENGTH = (() => {
  const raw = val("--strength");
  if (raw === null) return 1.00;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0 || v > 1) {
    throw new Error(`--strength ${raw}: WanVaceToVideo accepts 0–1000, but every arm of this `
      + `experiment lives in the camera gate's window of 0.5–1.0. Refusing a value outside (0, 1].`);
  }
  return v;
})();
/* The tag is null at 1.00 so the original run's paths, labels and report are
 * byte-for-byte what they were. */
const TAG = STRENGTH === 1.00 ? null : `s${String(Math.round(STRENGTH * 100)).padStart(3, "0")}`;
const OUT = TAG ? path.join(OUTPUT, "consistency", TAG) : path.join(OUTPUT, "consistency");
const ONLY = (val("--only") || "").split(",").map((s) => s.trim()).filter(Boolean);

/* ───────────────────────── the frozen conditions ─────────────────────────── */

const WIDTH = 1280, HEIGHT = 704, FPS = 24, LENGTH = 121;

/* Every one of these is vace_run.mjs's, unchanged. They are repeated as
 * constants rather than imported because vace_run.mjs does not export them;
 * `--plan` diffs the built graph against that file's own W1 graph so a drift
 * here fails loudly instead of quietly. */
const WEIGHTS = {
  diffusion_models: "wan2.1_vace_1.3B_fp16.safetensors",
  text_encoders: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
  vae: "wan_2.1_vae.safetensors",
};
const SHIFT = 5.0, STEPS = 20, CFG = 6.0, SAMPLER = "uni_pc", SCHEDULER = "simple";
/* STRENGTH is the ONE frozen condition this file will let a flag move; it is
 * declared with the other flags above, defaults to 1.00 — the operating point the
 * camera gate declared GREEN — and is printed in every plan, label and report so
 * a clip can never be read at the wrong one. */

/* THE PROMPT. vace_run.mjs's frozen positive said "a lone figure"; a clip whose
 * control video contains two people and whose prompt names one is asking the
 * model to disagree with its own conditioning, and any missing actor would then
 * be unattributable. Two figures, named, and NOTHING ELSE about the sentence
 * changes — same corridor, same lights, same floor, same haze, same 35mm.
 *
 * It goes through assertNoCameraWords() for the same reason the gate's does: a
 * prompt that describes the camera hands the model the answer through text. It
 * matters MORE here, not less: the cross-camera null (score clip 1 against clip
 * 2's projection, which must fail) is only meaningful if the two clips differ by
 * their control video and by nothing a text encoder could have read. */
const POSITIVE =
  "A long concrete corridor lit by cold overhead strip lights, two figures in dark "
  + "coats, one standing and one walking away from camera down the centre, wet floor "
  + "reflecting the lights, volumetric haze, cinematic, shot on 35mm.";

const NEGATIVE =
  config.video.engines.ltx.negative
  + ", static camera, still frame, flat gray, untextured, clay render, watermark, text";

/* Both seeds are vace_run.mjs's own: SEED and EXTRA_SEEDS[0]. Reusing them means
 * the take-vs-take number here is on the same two draws the camera gate already
 * used for its own three-seed arms, so a weird seed would already have shown up
 * there rather than being discovered as a surprise in this run. */
const SEED_A = 70117;
const SEED_B = 31337;

/* The three clips. `control` is the basename staged into the engine's input
 * directory: LoadVideo.file is a COMBO over that directory, so a path will not
 * resolve. */
const CLIPS = [
  { id: "C1S1", camera: 1, seed: SEED_A, control: "gate_block_f2c1.mp4",
    why: "the reference clip: orbit camera, first seed" },
  { id: "C2S1", camera: 2, seed: SEED_A, control: "gate_block_f2c2.mp4",
    why: "same action, same seed, DIFFERENT camera — isolates the camera" },
  { id: "C1S2", camera: 1, seed: SEED_B, control: "gate_block_f2c1.mp4",
    why: "same camera, same control clip, DIFFERENT seed — isolates the take" },
];

const GT = {
  1: { mp4: path.join(GATE_OUT, "gate_block_f2c1.mp4"),
       cam: path.join(GATE_OUT, "gate_block_f2c1_cam.json") },
  2: { mp4: path.join(GATE_OUT, "gate_block_f2c2.mp4"),
       cam: path.join(GATE_OUT, "gate_block_f2c2_cam.json") },
};

/* ─────────────────────────────── the graph ───────────────────────────────── */

const OUT_SLOTS = {
  UNETLoader: 1, CLIPLoader: 1, VAELoader: 1, CLIPTextEncode: 1, ModelSamplingSD3: 1,
  LoadVideo: 1, GetVideoComponents: 4, ImageFromBatch: 1,
  WanVaceToVideo: 4, KSampler: 1, TrimVideoLatent: 1,
  VAEDecode: 1, CreateVideo: 1, SaveVideo: 1,
  DWPreprocessor: 2, SavePoseKpsAsJsonFile: 0,
};
const OUTPUT_CLASSES = new Set(["SaveVideo", "SaveImage", "SaveAudio", "PreviewImage",
                                "SavePoseKpsAsJsonFile"]);
const PIXEL_SOURCES = new Set(["LoadVideo", "GetVideoComponents", "ImageFromBatch", "LoadImage"]);

/** vace_run.mjs's W1 graph, node for node, with `prefix`, `seed` and the control
 *  clip's filename as the only inputs. No reference_image (so trim_latent is
 *  provably 0) and no control_masks (so the mask defaults to ones). */
function vaceGraph({ control, prefix, seed }) {
  return {
    1: { class_type: "UNETLoader",
         inputs: { unet_name: WEIGHTS.diffusion_models, weight_dtype: "default" } },
    2: { class_type: "CLIPLoader",
         inputs: { clip_name: WEIGHTS.text_encoders, type: "wan", device: "default" } },
    3: { class_type: "VAELoader", inputs: { vae_name: WEIGHTS.vae } },
    4: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: POSITIVE } },
    5: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: NEGATIVE } },
    6: { class_type: "ModelSamplingSD3", inputs: { model: ["1", 0], shift: SHIFT } },
    7: { class_type: "WanVaceToVideo",
         inputs: { positive: ["4", 0], negative: ["5", 0], vae: ["3", 0],
                   width: WIDTH, height: HEIGHT, length: LENGTH, batch_size: 1,
                   strength: STRENGTH, control_video: ["22", 0] } },
    8: { class_type: "KSampler",
         inputs: { model: ["6", 0], positive: ["7", 0], negative: ["7", 1],
                   latent_image: ["7", 2], seed, steps: STEPS, cfg: CFG,
                   sampler_name: SAMPLER, scheduler: SCHEDULER, denoise: 1.0 } },
    9: { class_type: "TrimVideoLatent", inputs: { samples: ["8", 0], trim_amount: ["7", 3] } },
    10: { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["3", 0] } },
    11: { class_type: "CreateVideo", inputs: { images: ["10", 0], fps: FPS } },
    12: { class_type: "SaveVideo",
          inputs: { video: ["11", 0], filename_prefix: prefix, format: "auto", codec: "auto" } },
    20: { class_type: "LoadVideo", inputs: { file: control } },
    21: { class_type: "GetVideoComponents", inputs: { video: ["20", 0] } },
    22: { class_type: "ImageFromBatch",
          inputs: { image: ["21", 0], batch_index: 0, length: LENGTH } },
  };
}

/**
 * DWPose over a rendered clip, WITH the keypoints saved as JSON.
 *
 * Modelled on AIPLAYStudioMV's server/control/pose.js poseGraph(), which is the
 * shipped version of this extraction and the place its two non-default choices
 * are argued. Both are reproduced here because both fail SILENTLY if wrong:
 *
 *   bbox_detector "yolox_l.torchscript.pt" — the node's own default is the ONNX
 *   build, and this install's onnxruntime is the CPU package. The ONNX path does
 *   not error; it detects nothing, and an all-empty keypoint file looks exactly
 *   like a render with no people in it.
 *
 *   resolution 704 — the SOURCE's short side. DWPreprocessor scales the short
 *   side to `resolution`; the node's 512 default would rescale 1280x704 to
 *   931x512 and every pixel coordinate coming back would be in that frame
 *   instead of this one, which is a 1.375x error that still looks like a pose.
 *
 * The one node poseGraph() does not have is 26: SavePoseKpsAsJsonFile, which is
 * what this experiment actually reads. The rendered skeleton VIDEO (24/25) is
 * kept as well — not for scoring, but because a number with no picture behind it
 * is the thing nobody can check.
 */
function poseGraph({ source, prefix }) {
  return {
    20: { class_type: "LoadVideo", inputs: { file: source } },
    21: { class_type: "GetVideoComponents", inputs: { video: ["20", 0] } },
    22: { class_type: "ImageFromBatch",
          inputs: { image: ["21", 0], batch_index: 0, length: LENGTH } },
    23: { class_type: "DWPreprocessor",
          inputs: { image: ["22", 0], detect_hand: "enable", detect_body: "enable",
                    detect_face: "enable", resolution: Math.min(WIDTH, HEIGHT),
                    bbox_detector: "yolox_l.torchscript.pt",
                    pose_estimator: "dw-ll_ucoco_384_bs5.torchscript.pt",
                    scale_stick_for_xinsr_cn: "disable" } },
    24: { class_type: "CreateVideo", inputs: { images: ["23", 0], fps: FPS } },
    25: { class_type: "SaveVideo",
          inputs: { video: ["24", 0], filename_prefix: `${prefix}_skel`,
                    format: "auto", codec: "auto" } },
    26: { class_type: "SavePoseKpsAsJsonFile",
          inputs: { pose_kps: ["23", 1], filename_prefix: prefix } },
  };
}

/** structuralProblems() insists on exactly ONE output node, which is right for a
 *  render graph and wrong for this one: the pose pass deliberately writes two
 *  artefacts from the same DWPose forward pass — the keypoint JSON that is
 *  scored, and the skeleton video that lets a person check the JSON with their
 *  eyes. So the count is asserted here at TWO rather than the message being
 *  filtered away, and every other structural check still runs unchanged. */
function checkPoseGraph(g, label) {
  const outs = Object.keys(g).filter((k) => OUTPUT_CLASSES.has(g[k].class_type));
  if (outs.length !== 2) {
    throw new Error(`${label}: expected the keypoint JSON and the skeleton video, found `
      + `${outs.length} output node(s)`);
  }
  const bad = structuralProblems(g, OUT_SLOTS, OUTPUT_CLASSES)
    .filter((m) => !/^expected exactly 1 output node/.test(m));
  if (bad.length) throw new Error(`${label}: ${bad.join("; ")}`);
}

/* ──────────────────────────── the door client ────────────────────────────── */

/**
 * ⚠ THIS DOES NOT USE gate_lib.mjs's makeDispatcher, AND THE REASON IS MEASURED.
 *
 * makeDispatcher posts `wait: true` and holds ONE HTTP request open for the
 * whole render. Node's built-in fetch (undici) has a default `headersTimeout` of
 * 300 seconds and there is no per-request option to raise it. A WAN VACE arm at
 * this contract takes 32-35 minutes. Measured here, 2026-09-03 21:13 UTC, on the
 * first dispatch of this experiment:
 *
 *     C1S1: ok=false 306.0 s ... start AIPLAY Studio first — nothing is
 *     answering at http://127.0.0.1:4173 (UND_ERR_HEADERS_TIMEOUT)
 *
 * The message is wrong in the way that matters: the app was fine, the GPU was
 * fine, and the render went on to completion. Only the CLIENT gave up, five
 * minutes into a thirty-five minute job — and because the harness then moved to
 * the next arm, a second render was queued behind a first one it believed had
 * failed. That is the failure mode a 90-minute deadline exists to prevent,
 * arriving through a door the deadline does not reach.
 *
 * So: QUEUE, then POLL. `wait:false` returns as soon as the job is on the queue
 * and the app completes the provenance record itself whether or not anyone comes
 * back (docs/ENGINE_DOOR.md). Every request this file makes is then short, and
 * the 90-minute bound is enforced by this loop, where it can be read.
 *
 * The bounded-poll constants are gate_lib.mjs's POLL, imported rather than
 * re-chosen: they were hardened after a measured incident and a second copy
 * would drift.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* How many consecutive polls the output may sit on disk with no ledger row before
 * the disk is believed instead. See the note in queueAndWait(). */
const OUT_OF_BAND_POLLS = 4;

async function door(body, { timeoutMs = POLL.POST_TIMEOUT_MS } = {}) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE}/api/engine`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-aiplay-actor": ACTOR },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(d.error || `AIPLAY Studio answered ${r.status}`);
      e.problems = d.problems;
      throw e;
    }
    return d;
  } finally {
    clearTimeout(to);
  }
}

/** An in-flight or finished run with this exact label, if the ledger has one.
 *  This is what makes the harness resumable across a client that died: the
 *  render is the app's now, not this process's, and the ledger is where it
 *  says so. */
async function findRun(label) {
  const d = await door({ action: "activity", limit: 40, actor: ACTOR });
  return (d.runs || []).find((r) => r.label === label) || null;
}

/**
 * Queue one graph and wait for a terminal status, bounded.
 * Returns {ok, status, runId, promptId, secs, outputs, why, attached}.
 */
async function queueAndWait(job, { deadlineMs, pollMs = 15000, expectDir = null, expectRe = /\.mp4$/ } = {}) {
  const t0 = Date.now();
  let runId = null;
  let attached = false;

  const prior = await findRun(job.label);
  if (prior && (prior.status === "running" || prior.status === "completed")) {
    runId = prior.runId;
    attached = true;
    log(`   attached to an existing run in the ledger: ${runId} (${prior.status}, `
        + `queued ${prior.t})`);
  } else {
    /* ⚠ timeoutMs MUST BE SENT EVEN THOUGH THIS IS `wait:false`, AND THAT IS
     * MEASURED, NOT INFERRED. The door applies its own deadline to a queued job
     * whether or not anyone is waiting on it, and the clock starts when the job
     * is QUEUED, not when the GPU picks it up. A one-minute DWPose pass sent
     * behind a 32-minute render was recorded, live on 2026-09-03:
     *
     *     status "timeout", elapsedSec 1800.456, queuedSec 3.685,
     *     "no terminal status after 30 min — abandoning 09fd417a… rather than
     *      holding this caller open for ever"
     *
     * — thirty minutes to the second, spent entirely in the queue. Without this
     * line a VACE render queued behind another one would be marked `timeout` at
     * 30 minutes and finish, unrecorded, at 32. That is the same failure as the
     * 45-minute cap that once abandoned renders which then completed, arriving
     * through the one door that was supposed to be immune to it because nobody
     * was waiting. */
    const q = await door({ action: "prompt", graph: job.graph, wait: false, adopt: false,
                           project: "cross-clip-consistency", label: job.label,
                           timeoutMs: deadlineMs });
    runId = q.runId ?? null;
    if (!runId) {
      return { ok: false, status: "rejected", runId: null, secs: (Date.now() - t0) / 1000,
               why: q.error || "the door queued nothing and returned no runId", outputs: [] };
    }
    log(`   queued: runId ${runId}`);
  }

  let consecutiveFailures = 0;
  let sawOutputOnDisk = 0;
  for (;;) {
    if (Date.now() - t0 > deadlineMs) {
      return { ok: false, status: "timeout", runId, attached,
               secs: (Date.now() - t0) / 1000, outputs: [],
               why: `this harness stopped waiting after ${(deadlineMs / 60000).toFixed(0)} min. `
                    + `The run may still be on the queue — check runId ${runId} in the ledger.` };
    }
    await sleep(pollMs);
    let d;
    try {
      d = await door({ action: "run", runId }, { timeoutMs: POLL.POLL_TIMEOUT_MS });
      consecutiveFailures = 0;
    } catch (e) {
      consecutiveFailures += 1;
      log(`   poll failed (${consecutiveFailures}/${POLL.MAX_CONSECUTIVE_POLL_FAILURES}): ${e.message}`);
      if (consecutiveFailures >= POLL.MAX_CONSECUTIVE_POLL_FAILURES) {
        return { ok: false, status: "server_gone", runId, attached,
                 secs: (Date.now() - t0) / 1000, outputs: [],
                 why: `the app stopped answering for ${consecutiveFailures} consecutive polls` };
      }
      continue;
    }
    const res = d.result;
    if (!res) {
      // THE LEDGER IS THE SOURCE OF TRUTH, AND THE DISK IS THE BACKSTOP.
      // The first dispatch of this experiment died mid-render when Node's fetch
      // gave up at 300 s (see the header). The renders carried on, which is
      // correct - but it leaves a question this loop cannot answer from the
      // ledger alone: if a `wait:true` request's client vanished, does the app
      // still write the terminal `generate` event? If it ever does not, a
      // finished clip would sit on disk while this loop waited out its full 90
      // minutes for a row that is never coming.
      //
      // So the disk is checked too, and the answer SAYS WHICH ONE IT CAME FROM.
      // "completed_from_disk" is a weaker claim than "completed" - no elapsed
      // time, no promptId, no provenance row to quote - and calling it the same
      // thing would hide exactly the failure it exists to survive.
      if (expectDir && fs.existsSync(expectDir)) {
        const hit = fs.readdirSync(expectDir).filter((f) => expectRe.test(f)
                                                          && !f.includes("_skel"));
        sawOutputOnDisk = hit.length ? sawOutputOnDisk + 1 : 0;
        // ⚠ THE BACKSTOP MUST LOSE THE RACE IT IS NOT MEANT TO WIN, and on its
        // first outing it did not. ComfyUI writes the mp4; the app then polls,
        // sees the job finish and writes the terminal `generate` event a few
        // seconds later. A backstop that fires the instant the file appears
        // therefore reports "completed_from_disk" for a run whose provenance row
        // — promptId, elapsed time, output sha256 — was seconds away. Measured:
        // C1S1 was called from-disk at 855.8 s of waiting, and the ledger then
        // recorded it `completed` in 1930.126 s with promptId 59501e49. The
        // from-disk answer was not wrong, it was WORSE, and it was worse
        // silently.
        //
        // So the file must be there for OUT_OF_BAND_POLLS consecutive polls
        // before this path is taken. That is the ledger's window to win, and it
        // wins it in seconds; anything still unrecorded after that window really
        // has been abandoned.
        if (sawOutputOnDisk >= OUT_OF_BAND_POLLS) {
          return { ok: true, status: "completed_from_disk", runId, attached,
                   secs: (Date.now() - t0) / 1000, outputs: [], promptId: null,
                   why: `the ledger still has no terminal event for ${runId} `
                        + `${sawOutputOnDisk} polls after the output appeared on disk `
                        + `(${hit[0]}). Reported as from-disk, which is a WEAKER claim `
                        + `than a provenance-backed completion: no promptId, no elapsed `
                        + `time, no output hash.` };
        }
      }
      continue;                               // still running: no generate event yet
    }
    return { ok: res.status === "completed", status: res.status, runId, attached,
             promptId: res.promptId ?? null,
             secs: res.elapsedSec ?? (Date.now() - t0) / 1000,
             queuedSec: res.queuedSec ?? null, cached: res.cached ?? null,
             outputs: res.outputs || [], why: res.error || null };
  }
}

/* ────────────────────────────── the harness ──────────────────────────────── */

const sha256 = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const log = (...a) => console.log(...a);

function run(cmd, argv, label) {
  return new Promise((res) => {
    const t0 = Date.now();
    const p = spawn(cmd, argv, { stdio: ["ignore", "inherit", "inherit"] });
    p.on("close", (code) => res({ code, secs: (Date.now() - t0) / 1000, label }));
  });
}

async function buildGroundTruth() {
  for (const [cam, spec] of Object.entries(GT)) {
    log(`\n── ground truth: 2 figures, camera ${cam} ─────────────────────────────`);
    const r = await run(PY, [path.join(HERE, "gate_block.py"), "--figures", "2",
                             "--camera", String(cam)], `gt cam${cam}`);
    if (r.code !== 0) throw new Error(`gate_block.py --figures 2 --camera ${cam} exited ${r.code}`);
    log(`  ${path.basename(spec.mp4)}  ${r.secs.toFixed(1)} s`);
  }
}

/** Stage a blocking clip into the engine's input directory, and MEASURE it there
 *  rather than trusting that gate_block.py wrote what it said. The three numbers
 *  each fail silently: a wrong size is centre-cropped by WanVaceToVideo, a wrong
 *  rate is ignored outright, and a short clip is CLAMPED by ImageFromBatch onto
 *  its last frame with no error anywhere. */
async function stage(src) {
  const dst = path.join(INPUT, path.basename(src));
  fs.copyFileSync(src, dst);
  const probe = await probeClip(dst);
  const bad = assertThreeNumbers(probe, {
    width: WIDTH, height: HEIGHT, fps: FPS, minFrames: LENGTH,
    why: { size: "WanVaceToVideo centre-crops a mismatched aspect and says nothing",
           fps: "the restyle rate is always 24 and the source's own fps is never read",
           length: "ImageFromBatch CLAMPS a short clip onto its last frame instead of erroring" },
  });
  if (bad.length) throw new Error(`${path.basename(dst)} fails the control contract: ${bad.join("; ")}`);
  return { staged: path.basename(dst), probe, sha256: sha256(dst) };
}

function checkGraph(g, label) {
  const bad = structuralProblems(g, OUT_SLOTS, OUTPUT_CLASSES);
  if (bad.length) throw new Error(`${label}: ${bad.join("; ")}`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.join(OUT, "_graphs"), { recursive: true });

  log("=".repeat(78));
  log("CROSS-CLIP CONSISTENCY — three renders, one analytic ground truth");
  log("=".repeat(78));

  assertNoCameraWords(POSITIVE, "THE TWO-FIGURE POSITIVE PROMPT");
  log("  prompt guard    : passed (the positive names no camera move)");
  log("  positive        : " + POSITIVE);

  if (GROUND_TRUTH) await buildGroundTruth();

  for (const cam of [1, 2]) {
    for (const f of [GT[cam].mp4, GT[cam].cam]) {
      if (!fs.existsSync(f)) {
        throw new Error(`${f} is missing. Run with --ground-truth first `
          + `(or: python scripts/gate_block.py --figures 2 --camera ${cam}).`);
      }
    }
  }

  const staged = {};
  for (const cam of [1, 2]) staged[cam] = await stage(GT[cam].mp4);
  log("\n  staged control clips (measured in the engine's own input directory):");
  for (const cam of [1, 2]) {
    const s = staged[cam];
    log(`    cam${cam}  ${s.staged}  ${s.probe.w}x${s.probe.h} `
        + `@ ${s.probe.fps_num}/${s.probe.fps_den} fps, ${s.probe.frames} frames  `
        + `sha256 ${s.sha256.slice(0, 16)}`);
  }

  const selected = ONLY.length ? CLIPS.filter((c) => ONLY.includes(c.id)) : CLIPS;
  if (ONLY.length) {
    const unknown = ONLY.filter((id) => !CLIPS.some((c) => c.id === id));
    if (unknown.length) throw new Error(`--only names ${unknown.join(", ")}, which is not one of `
      + `${CLIPS.map((c) => c.id).join(", ")}`);
    log(`\n  --only ${ONLY.join(",")}: ${selected.length} of ${CLIPS.length} clips this pass.`);
  }

  const jobs = selected.map((c) => {
    const prefix = `consistency/${TAG ? `${TAG}/` : ""}${c.id}/${c.id}`;
    const graph = vaceGraph({ control: staged[c.camera].staged, prefix, seed: c.seed });
    checkGraph(graph, `${c.id} graph`);
    const leaks = pixelLeaks(graph, PIXEL_SOURCES, "KSampler");
    // The pixel path is SUPPOSED to reach the sampler here — that is what a
    // guided arm IS. This is not the gate's text-only control, so the check is
    // inverted: the chain must be present, and if it ever vanished the render
    // would silently become a text-only clip that still looks like an arm.
    if (!leaks.length) throw new Error(`${c.id}: the control-video chain does not reach the sampler`);
    fs.writeFileSync(path.join(OUT, "_graphs", `${c.id}.json`), JSON.stringify(graph, null, 1));
    /* THE LABEL CARRIES THE STRENGTH, and that is not cosmetic. queueAndWait()
     * attaches to any ledger run with this exact label, so a sweep arm whose
     * label matched the 1.00 run would attach to it, inherit its runId and its
     * elapsed time, and report a render it never made. */
    return { ...c, prefix, graph,
             label: `consistency ${c.id} cam${c.camera} seed${c.seed}`
                    + (TAG ? ` str${STRENGTH.toFixed(2)}` : "") };
  });

  log("\n  the three clips:");
  for (const j of jobs) {
    log(`    ${j.id}  camera ${j.camera}  seed ${j.seed}  control ${j.control}`);
    log(`          ${j.why}`);
  }
  log(`\n  frozen across all three: strength ${STRENGTH.toFixed(2)}, ${WIDTH}x${HEIGHT}, `
      + `${FPS} fps, ${LENGTH} frames, ${STEPS} steps, cfg ${CFG}, ${SAMPLER}/${SCHEDULER}`);

  if (!RUN && !POSE_ONLY && !SCORE_ONLY) {
    log("\n  --plan: nothing posted. Add --run to render.");
    return;
  }

  const ident = await engineIdentity(BASE, { actor: ACTOR });
  if (!ident.up) throw new Error(ident.why);
  if (ident.matchesThisStudio === false) {
    throw new Error(`the engine at ${BASE} is not this Studio's: ${ident.problems.join("; ")}`);
  }
  log(`\n  engine          : ComfyUI ${ident.version}, ${ident.mode || "?"} port, `
      + `matchesThisStudio=${ident.matchesThisStudio}`);

  // 90 min. See the header. Never lower this: 45 once abandoned renders that
  // then finished.
  const RENDER_DEADLINE_MS = 90 * 60 * 1000;
  const POSE_DEADLINE_MS = 20 * 60 * 1000;

  const dispatched = [];
  if (RUN) {
    for (const j of jobs) {
      const dir = path.join(OUT, j.id);
      const existing = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".mp4")
                                                                        && !f.includes("_skel")) : [];
      if (existing.length) {
        log(`\n── ${j.id}: already rendered (${existing[0]}), skipping ────────────`);
        dispatched.push({ id: j.id, ok: true, resumed: true,
                          file: path.join(dir, existing[0]) });
        continue;
      }
      log(`\n── ${j.id} dispatch ${new Date().toISOString()} ───────────────────────`);
      const r = await queueAndWait(j, { deadlineMs: RENDER_DEADLINE_MS, expectDir: dir });
      const out0 = r.outputs[0];
      log(`   ${j.id}: ${r.status} in ${r.secs.toFixed(1)} s  runId=${r.runId ?? "?"} `
          + `promptId=${r.promptId ?? "?"}`);
      if (out0) log(`         -> ${out0.subfolder || ""}/${out0.file}  ${out0.bytes} bytes`);
      if (r.why) log(`         ${r.why}`);
      dispatched.push({ id: j.id, ok: r.ok, status: r.status, secs: r.secs,
                        promptId: r.promptId ?? null, runId: r.runId ?? null,
                        attached: !!r.attached, queuedSec: r.queuedSec ?? null,
                        cached: r.cached ?? null, outputs: r.outputs, why: r.why ?? null,
                        seed: j.seed, camera: j.camera, control: j.control });
      if (!r.ok) log(`   ${j.id} FAILED — reported as a failure, not substituted.`);
    }
  }
  /* THE LEDGER IS THE RECORD, NOT THIS PROCESS'S MEMORY OF IT.
   * A clip can reach this point three ways: rendered here, attached to a run
   * this harness did not start, or found already on disk by the resume check —
   * and only the first of those leaves this process holding the promptId, the
   * elapsed time and the output hash. So every clip's row is re-read from the
   * ledger by its label at the end, and what the ledger says wins. Without this,
   * a resumed run would be reported with `runId: null` and a report would claim
   * a render nobody can look up. */
  for (const row of dispatched) {
    const j = jobs.find((x) => x.id === row.id);
    if (!j) continue;
    let led = null;
    try { led = await findRun(j.label); } catch (e) { row.ledger_lookup_error = e.message; }
    if (!led) continue;
    row.runId = led.runId ?? row.runId ?? null;
    row.ledger_status = led.status ?? null;
    row.ledger_elapsed_s = led.elapsedSec ?? null;
    row.ledger_queued_at = led.t ?? null;
    row.ledger_outputs = led.outputs || [];
    // `activity` rows carry no promptId, and a clip found on disk by the resume
    // check never had one in this process. Fetch the full record so the report
    // can name the ComfyUI prompt as well as the ledger run - two different ids
    // for two different logs, and a reader chasing a render needs whichever one
    // they are standing in front of.
    if (!row.promptId) {
      try {
        const full = await door({ action: "run", runId: row.runId });
        row.promptId = full?.result?.promptId ?? null;
        row.ledger_queued_s = full?.result?.queuedSec ?? null;
        row.ledger_cached = full?.result?.cached ?? null;
      } catch (e) { row.ledger_record_error = e.message; }
    }
    if (led.status === "completed" && row.status === "completed_from_disk") {
      row.status = "completed";
      row.secs = led.elapsedSec ?? row.secs;
      row.note = "this harness concluded from the output file; the ledger has since "
               + "recorded the run properly and the ledger's numbers are the ones kept.";
    }
  }

  if (dispatched.length) {
    fs.writeFileSync(path.join(OUT, "dispatch.json"),
                     JSON.stringify({ when: new Date().toISOString(), prompt: POSITIVE,
                                      negative: NEGATIVE, strength: STRENGTH,
                                      dispatched }, null, 1));
  }

  /* ---- pose extraction, one pass per rendered clip ---------------------- */
  const poses = [];
  if (RUN || POSE_ONLY) {
    for (const j of jobs) {
      const dir = path.join(OUT, j.id);
      const mp4 = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => f.endsWith(".mp4") && !f.includes("_skel")).sort()[0]
        : null;
      if (!mp4) { log(`\n   ${j.id}: no render to pose — skipped`); continue; }
      const srcAbs = path.join(dir, mp4);
      /* ⚠ THE STAGED NAME CARRIES THE STRENGTH TOO. This copies a render into the
       * engine's single flat input directory under a fixed name; at two
       * strengths that is the SAME name, and the second pass would either pose
       * the first pass's pixels or race a LoadVideo that already has the file
       * open. Nothing would error. */
      const stagedName = `consistency_${TAG ? `${TAG}_` : ""}${j.id}.mp4`;
      fs.copyFileSync(srcAbs, path.join(INPUT, stagedName));
      const g = poseGraph({ source: stagedName,
                            prefix: `consistency/${TAG ? `${TAG}/` : ""}${j.id}/pose_${j.id}` });
      checkPoseGraph(g, `${j.id} pose graph`);
      log(`\n── ${j.id} DWPose ────────────────────────────────────────────────`);
      const r = await queueAndWait({ graph: g, label: `pose ${j.id}${TAG ? ` ${TAG}` : ""}` },
                                   { deadlineMs: POSE_DEADLINE_MS, pollMs: 5000,
                                     expectDir: dir, expectRe: /^pose_.*\.json$/ });
      log(`   ${j.id} pose: ${r.status} in ${r.secs.toFixed(1)} s  runId=${r.runId ?? "?"} `
          + `${r.why || ""}`);
      for (const o of r.outputs) log(`         -> ${o.subfolder || ""}/${o.file}`);
      poses.push({ id: j.id, ok: r.ok, status: r.status, runId: r.runId ?? null,
                   secs: r.secs, outputs: r.outputs, why: r.why ?? null });
    }
  }

  for (const row of poses) {
    let led = null;
    try { led = await findRun(`pose ${row.id}${TAG ? ` ${TAG}` : ""}`); }
    catch (e) { row.ledger_lookup_error = e.message; }
    if (!led) continue;
    row.runId = led.runId ?? row.runId ?? null;
    row.ledger_status = led.status ?? null;
    row.ledger_elapsed_s = led.elapsedSec ?? null;
    row.ledger_outputs = led.outputs || [];
    if (led.status === "completed" && row.status === "completed_from_disk") {
      row.status = "completed";
      row.secs = led.elapsedSec ?? row.secs;
    }
  }

  if (poses.length) {
    fs.writeFileSync(path.join(OUT, "pose.json"),
                     JSON.stringify({ when: new Date().toISOString(), poses }, null, 1));
  }

  /* ---- score ----------------------------------------------------------- */
  /* --always-localise is passed on a strength sweep and ONLY there. The
   * detector-free localisation block was written as a fallback for a pass where
   * DWPose found nothing, so it runs only when a clip has zero detections. On a
   * sweep that is exactly wrong: the question IS whether localisation survives as
   * the strength drops and the boxes turn into people, and it cannot be answered
   * by a measurement that switches itself off the moment they do. */
  const scoreArgs = [path.join(HERE, "consistency_score.py")];
  if (TAG) scoreArgs.push("--subdir", TAG, "--always-localise");
  const r = await run(PY, scoreArgs, "score");
  if (r.code !== 0) throw new Error(`consistency_score.py exited ${r.code}`);
  log(`\n  report: ${path.join(OUT, "report.json")}`);
}

main().catch((e) => { console.error("\nFAILED: " + (e.stack || e.message)); process.exit(1); });
