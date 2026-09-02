/**
 * The camera-control gate — build and dispatch the arms.
 *
 *   node scripts/gate_run.mjs                 # DRY RUN (the default), builds + validates only
 *   node scripts/gate_run.mjs --preflight     # are the weights there, is 8266 answering
 *   node scripts/gate_run.mjs --run           # actually POST to ComfyUI
 *
 * THE QUESTION. Does a gray-box blocking clip actually steer the local video
 * model's camera, or does the model paint whatever it likes over the boxes?
 * `NEXT_VFX_AND_3D.md` puts this first, before any Blender bridge exists,
 * because the expensive failure is building the bridge and then finding out.
 *
 * ⚠⚠ THE MECHANISM UNDER TEST, AND THE SCOPE OF ANY ANSWER. ⚠⚠
 *
 * The only conditioning path this gate exercises is `LTXVAddGuide`, and what
 * that node does is VAE-ENCODE LITERAL SOURCE FRAMES into the latent
 * (nodes_lt.py `LTXVAddGuide.encode` -> `vae.encode(pixels)` -> `append_keyframe`).
 * It is an APPEARANCE guide. There is no structure/appearance separation in it
 * anywhere — the model is handed pictures of gray boxes, not a depth field or a
 * pose. A depth/pose ControlNet, and WAN VACE, condition on STRUCTURE and are a
 * DIFFERENT MECHANISM. They are not tested here for the plainest possible
 * reason: they have zero bytes on this disk.
 *
 * So the answer reads narrowly, in BOTH directions:
 *
 *   a NEGATIVE means  "sparse APPEARANCE guides cannot carry gray-box blocking"
 *                     and NOT "control video does not work locally".
 *   a POSITIVE means  "sparse appearance guides carry it at these strengths"
 *                     and does NOT transfer to VACE-style structural conditioning.
 *
 * That caveat lives in `SCOPE` below and is written verbatim into dispatch.json,
 * so a write-up assembled from the artefacts alone cannot make the broad claim.
 * The 11.3 GB VACE decision hangs on this distinction; do not let it evaporate
 * between the run and the write-up.
 *
 * WHAT THIS FILE IS AND IS NOT. It builds the graphs and dispatches them. It
 * does not measure anything — the measurement is a separate script, and it is
 * separate on purpose: the reference flow is computed ANALYTICALLY from the
 * blocking scene's known geometry (every face is a planar quad, so frame t to
 * t+1 is exactly a homography through its four projected corners), never
 * estimated. A flow estimator on the reference side would be ill-posed in
 * exactly the large smooth regions that carry the camera move — a flat gray
 * wall has no texture, and the aperture problem would eat the measurement.
 * Ground truth on one side, estimate on the other, is the entire reason the
 * number is worth anything.
 *
 * ⚠ THE THREE NUMBERS, and why they are asserted rather than assumed.
 * The source clip must be EXACTLY 1280x704, EXACTLY 24.000 fps, and at least
 * 121 frames. Each has a specific silent failure behind it:
 *
 *   fps    `restyleGraph()` does `const rate = fps ?? v.fps` and its only real
 *          caller (server/art.js:1110) passes no `fps`. So the render is ALWAYS
 *          24 and the SOURCE's own rate is never read. Guides index the source
 *          by ABSOLUTE FRAME NUMBER, so a 30 fps source pulls every guide ~25%
 *          early and the error compounds down the clip. No warning is printed
 *          because nothing ever compares the two rates.
 *   length `ImageFromBatch` CLAMPS an out-of-range index to the last frame. It
 *          does not raise. A short source therefore freezes on its final frame
 *          for the rest of the clip and the run still reports success.
 *   size   `ImageScale` runs with `crop: "disabled"`, which STRETCHES to the
 *          target rather than fitting it. At exactly 1280x704 the node is a
 *          no-op; at anything else it silently changes the geometry we are
 *          about to measure the camera move out of.
 *
 * ⚠ DRY RUN IS THE DEFAULT. An accidental `node scripts/gate_run.mjs` must not
 * start thirteen renders. Dispatch requires `--run` and a live server.
 */
import { mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { config } from "../server/config.js";
import { restyleGraph, videoReady, alignFrames } from "../server/workflow.js";
/* The model-agnostic half — probe/hash the clip, prove the engine on this port
 * is this rig's, the bounded poll loop, the generic graph walks, and the shared
 * camera-word guard. Extracted to scripts/gate_lib.mjs when vace_run.mjs needed
 * the same four hundred lines; see that file's header for what stayed here and
 * why. Nothing about LTX moved. */
import {
  isLink, findByClass, oneByClass, sortedJSON, structuralProblems, pixelLeaks,
  assertNoCameraWords, POSITIVE_PROMPT, probeClip, assertThreeNumbers, fileFacts,
  engineIdentity as engineIdentityOf, makeDispatcher,
} from "./gate_lib.mjs";

const BASE = `http://${config.comfy.host}:${config.comfy.port}`;   // 8266 on this rig, not stock 8188
const INPUT = config.inputDir;
const GATE_OUT = path.join(config.outputDir, "gate");

/* The staged name is what `LoadVideo` is given. LoadVideo reads ComfyUI's input
 * directory and nothing else, so the clip has to be copied there whatever it is
 * called on disk. */
const STAGED = "gate_block.mp4";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d = null) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const RUN = has("--run") || has("--go");

/* A dispatch and a dry run do NOT share a graph directory.
 *
 * gate_score.py globs the real one to print the OPERATING POINT under a GREEN
 * verdict — the guide spacing and strength step 2 of the brief inherits. That
 * directory used to be shared and never cleared, so any later invocation
 * silently overwrote the graphs the scored renders actually came from; a
 * reviewer tripped exactly that. Clearing it on each build fixes the stale
 * case but would introduce a worse one: a dry run fired while a dispatch is
 * still rendering would delete the live run's graphs out from under it. So a
 * dry run gets its own scratch directory and never touches the real one. Only
 * a dispatch writes `_graphs`, and it starts by emptying it. */
const GRAPH_DIR = path.join(GATE_OUT, RUN ? "_graphs" : "_graphs_dry");
const PREFLIGHT = has("--preflight");
const ONLY = (val("--only") || "").split(",").map((s) => s.trim()).filter(Boolean);

/* ───────────────────────── the frozen conditions ─────────────────────────── */

const WIDTH = 1280, HEIGHT = 704;
const FPS = 24;
const SECONDS = 5;                              // alignFrames -> 24*5+1 = 121
const LENGTH = alignFrames(SECONDS, FPS, "ltx");
const MIN_SOURCE_FRAMES = 121;                  // render 144, use the first 121

/* The scope sentence, carried into dispatch.json so it survives the session.
 * See the ⚠⚠ block at the top of this file — this is the same statement, in a
 * form a script can read. */
const SCOPE = {
  path_tested: "LTXVAddGuide — VAE-encoded literal source frames, an APPEARANCE guide with no structure/appearance separation",
  paths_not_tested: [
    "WAN VACE (structural conditioning) — 0 bytes on this disk",
    "depth / pose ControlNet — the estimators are zero-byte placeholders here",
    "MiniMax H3 — no guide-strength input at all",
  ],
  a_negative_means: "sparse APPEARANCE guides cannot carry gray-box blocking — NOT that control video does not work locally",
  a_positive_means: "sparse appearance guides carry it at these strengths — it does NOT transfer to VACE-style structural conditioning",
};

/* ── LTX latent arithmetic, replicated from the node source rather than guessed.
 *
 * The causal VAE's temporal factor is 8: `EmptyLTXVLatentVideo` builds
 * ((length-1)//8)+1 latent frames (nodes_lt.py:82), and `LTXVAddGuide` asserts
 * `latent_idx + t.shape[2] <= latent_length` (nodes_lt.py:473). Nothing in this
 * harness may emit a guide that fails that assertion — see `guideLatentSpan()`. */
const TIME_SCALE = 8;
const latentFrames = (pixelFrames) => Math.floor((pixelFrames - 1) / TIME_SCALE) + 1;
const LATENT_LENGTH = latentFrames(LENGTH);     // 121 pixel frames -> 16 latent frames

/**
 * What `LTXVAddGuide` will ACTUALLY do with a guide of `span` source frames
 * placed at `frameIdx` — replicated from nodes_lt.py so the harness can predict
 * the node's own assertion instead of discovering it after a model load.
 *
 *   execute()           :449  keep = ((n-1)//8)*8 + 1
 *                       :454  causal = frame_idx == 0 or keep == 1
 *                       :457  if not causal, a throwaway first frame is PREPENDED
 *   encode()            :304  images = images[:(n-1)//8*8 + 1]      (crops again)
 *                             the causal VAE turns m pixel frames into (m-1)/8+1
 *   execute()           :462  if not causal, the first latent frame is stripped
 *   get_latent_index()  :344  guide_length > 1 and frame_idx != 0
 *                             -> frame_idx = (frame_idx-1)//8*8 + 1  ROUNDS DOWN
 *                       :346  latent_idx = (frame_idx + 7)//8
 *   execute()           :471  assert latent_idx + t.shape[2] <= latent_length
 *
 * Returns the guide as the NODE will see it, not as we asked for it. `frameIdx`
 * coming back different from what went in is the silent-drift bug, made visible.
 */
function guideLatentSpan(frameIdx, span) {
  const keep = Math.floor((span - 1) / TIME_SCALE) * TIME_SCALE + 1;
  const causal = frameIdx === 0 || keep === 1;
  let latents, guideLength;
  if (causal) {
    latents = latentFrames(keep);
    guideLength = keep;
  } else {
    // prepend one frame, re-crop, encode, then drop the first latent frame
    const m = Math.floor(span / TIME_SCALE) * TIME_SCALE + 1;
    latents = latentFrames(m) - 1;
    guideLength = m - 1;
  }
  const effective = (guideLength > 1 && frameIdx !== 0)
    ? Math.floor((frameIdx - 1) / TIME_SCALE) * TIME_SCALE + 1
    : frameIdx;
  const latentIdx = Math.floor((effective + TIME_SCALE - 1) / TIME_SCALE);
  return { requested: frameIdx, effective, drift: effective - frameIdx, span,
           pixels: guideLength, latents, latentIdx, end: latentIdx + latents,
           multiFrame: guideLength > 1 };
}

/* THE POSITIVE PROMPT lives in gate_lib.mjs, shared with vace_run.mjs.
 *
 * It contains no camera-move words and must not; `assertNoCameraWords` below is
 * the executable form of that sentence. It moved out of this file when the WAN
 * VACE gate needed the SAME shot description: two copies would drift, and a
 * drifted copy is undetectable in the artefacts because every number stays
 * plausible. See gate_lib.mjs for the full argument. */
const POSITIVE = POSITIVE_PROMPT;

/* The negative is the LTX default plus the failure modes this particular source
 * invites. "static camera, still frame" is a camera term in the NEGATIVE, which
 * is fine and deliberate: it discourages a frozen shot in every arm equally. It
 * cannot leak the orbit, because it does not describe one. "flat gray,
 * untextured, clay render" exist because the source IS flat gray untextured
 * clay and the model will happily copy that instead of restyling it. */
const NEGATIVE =
  config.video.engines.ltx.negative
  + ", static camera, still frame, flat gray, untextured, clay render, watermark, text";

/* One seed shared by every arm, plus two more on A0 and A1 only.
 *
 * A0-vs-A1 IS the claim. One seed each cannot tell a real margin from seed
 * noise, and three arms' worth of extra renders is a great deal cheaper than
 * publishing a number that was a coin flip. The other arms are shape-finding,
 * not claim-making, so they get the shared seed only. */
const SEED = 70117;
const EXTRA_SEEDS = [31337, 90210];
/* A0 and A1 carry the margin that IS the claim, so neither can be read off one
 * seed. A4 joins them for a different reason, found in review: gate_score's
 * verdict tree leans on it harder than a mere calibration arm should be leaned
 * on. Branch (d) routes the WHOLE run to NO RESULT if A4 is absent or invalid,
 * and branches (b)/(c) use A4's CMA to separate a publishable decisive negative
 * from a broken instrument. On one seed, a single odd A4 render turns an entire
 * night of GPU into "no result". Three renders is the cheapest insurance there
 * is against that. */
const EXTRA_ARMS = new Set(["A0", "A1", "A4"]);

/* ⚠ THE STRENGTH AXIS MUST BRACKET THE BAND FROM BOTH SIDES.
 *
 * The grid used to run 0.30 / 0.45 / 0.60 / 0.70 with NOTHING below 0.30 — which
 * is both the floor of the sample and the shipped default. That is the wrong
 * shape for the failure this source invites. On a flat gray source the known
 * failure is two-ended: HIGH strength reconstructs the boxes (that is A4, run on
 * purpose), LOW strength loses the move. If a workable band exists it sits
 * between them, and on an appearance guide carrying almost no texture it could
 * easily be BELOW 0.30 — exactly where the old grid never looked. A clean sweep
 * of failures over 0.30–0.70 would then have been reported as "guides do not
 * carry the move" without the experiment ever having visited the corner where
 * the answer most plausibly lives.
 *
 * A7/A8 cost one render each on the shared seed (130–235 s measured), and
 * without them a negative result is not defensible. The report must print the
 * sampled extent — strengths 0.15–0.70, densities 1/8/16 guides — so the
 * coverage claim lives on the artefact and not in someone's memory. */
const ARMS = [
  { id: "A0", kind: "control", note: "text-only control (restyleGraph, stripped)" },
  { id: "A1", kind: "guided", every: 16, strength: 0.30, note: "shipped default — PRIMARY ARM" },
  { id: "A2", kind: "guided", every: 16, strength: 0.45, note: "" },
  { id: "A3", kind: "guided", every: 16, strength: 0.60, note: "" },
  { id: "A4", kind: "guided", every: 8, strength: 0.70, note: "DEGENERATE ANCHOR — disqualified on purpose" },
  { id: "A5", kind: "guided", every: 8, strength: 0.30, note: "" },
  { id: "A6", kind: "dense", strength: 0.30, note: "" },
  { id: "A7", kind: "guided", every: 16, strength: 0.22, note: "BELOW the default — brackets the band from underneath" },
  { id: "A8", kind: "guided", every: 16, strength: 0.15, note: "lowest strength sampled — the 'guides too weak' end" },
  /* THE FRAMING-ONLY CONTROL, and it is a control rather than a candidate.
   * every >= LENGTH means restyleGraph's `for (i = 0; i < length; i += every)`
   * runs exactly once, so this arm gets ONE guide, at frame 0, at A1's own
   * strength. It exists to close a confound that would otherwise sit under a
   * positive result: if A1 beats A0, is that because the guides carried the
   * camera MOVE, or merely because guide 0 pinned the opening framing and a
   * plausible shot unrolled from there? A1 minus A9 is the part attributable to
   * the move; A9 minus A0 is the part attributable to framing alone. Without
   * this row, the headline margin cannot be decomposed and the strongest claim
   * the gate can make is weaker than it looks. One render. */
  { id: "A9", kind: "guided", every: 121, strength: 0.30, note: "FRAMING-ONLY CONTROL — one guide at frame 0; isolates framing from motion" },
];

/* A4 is run in order to FAIL, and that is not a contradiction.
 *
 * restyleGraph's own docstring records the measurement: every 8 frames at
 * strength 0.70 gives perfect motion and ZERO restyle — the guides simply
 * reconstruct the source. An arm that copies the source scores a perfect camera
 * match while producing a gray-box clip, so any "did the camera survive" metric
 * that ranks A4 top is measuring reconstruction, not control. A4 is the
 * calibration point for the anti-degeneracy guard: whatever the scorer is, A4
 * must be caught by it. Removing A4 removes the only evidence that the guard
 * works. */
const DISQUALIFIED = new Set(["A4"]);

/* ─────────────────────── graph structure knowledge ───────────────────────── */

/* Output arity per class. ComfyUI is deliberately not running in this phase, so
 * these are declared here rather than read from /object_info — and `--preflight`
 * cross-checks every one of them against the live server when it can, so the
 * table cannot quietly rot. The three that matter and are easy to get wrong:
 *   SamplerCustomAdvanced  [0] output, [1] DENOISED output   <- guided runs use 1
 *   LTXVAddGuide           [0] positive, [1] negative, [2] latent
 *   LTXVCropGuides         [0] positive, [1] negative, [2] latent */
const OUT_SLOTS = {
  UNETLoader: 1, CLIPLoader: 1, VAELoader: 1, CLIPTextEncode: 1,
  LTXVConditioning: 2, EmptyLTXVLatentVideo: 1,
  /* GetVideoComponents is 4 on ComfyUI 0.33.0, not 3: the live server reports
   * ["images","audio","fps","bit_depth"] and bit_depth was APPENDED, so slots
   * 0/1/2 kept their meanings. Verified against /object_info before the first
   * dispatch, because a shifted slot here would have meant the guides silently
   * conditioning on the wrong thing. The gate reads slot 0 only. Left at the
   * true value so preflight's cross-check stays quiet and a future reader is
   * not told the graphs are wrong when they are right. */
  LoadVideo: 1, GetVideoComponents: 4, LoadImage: 2,
  ImageFromBatch: 1, ImageScale: 1, LTXVPreprocess: 1,
  LTXVAddGuide: 3, LTXVEmptyLatentAudio: 1, LTXVConcatAVLatent: 1,
  RandomNoise: 1, KSamplerSelect: 1, ManualSigmas: 1, LTXVDualCFGGuider: 1,
  SamplerCustomAdvanced: 2, LTXVSeparateAVLatent: 2, LTXVCropGuides: 3,
  /* SaveVideo is 1 on this build, not 0. Nothing references its output — it is
   * a terminal node — so this only ever mattered to the cross-check. */
  VAEDecodeTiled: 1, CreateVideo: 1, SaveVideo: 1,
};
const OUTPUT_CLASSES = new Set(["SaveVideo", "SaveImage", "SaveAudio", "PreviewImage"]);

/* The chain restyleGraph builds per guide, in order: ImageFromBatch -> ImageScale
 * -> LTXVPreprocess -> LTXVAddGuide. Named as a set so the A0 strip walks the
 * graph by CLASS rather than by node number — the numbers below are asserted,
 * not assumed, and if restyleGraph renumbers, this still finds them. */
const GUIDE_CHAIN = new Set(["ImageFromBatch", "ImageScale", "LTXVPreprocess", "LTXVAddGuide"]);
/* Nothing in A0 may load pixels from anywhere. */
const PIXEL_SOURCES = new Set(["LoadVideo", "GetVideoComponents", "ImageFromBatch", "LoadImage"]);

/* isLink / findByClass / oneByClass now live in gate_lib.mjs — imported above. */

/* ──────────────────────────── graph builders ─────────────────────────────── */

const baseArgs = (extra) => ({
  file: STAGED, prompt: POSITIVE, negative: NEGATIVE,
  width: WIDTH, height: HEIGHT, seconds: SECONDS,
  ...extra,
});

/**
 * A0 — the text-only control, built by STRIPPING A1 rather than by writing a
 * new graph.
 *
 * WHY NOT `videoGraphLtx()`. It is the obvious move and it is wrong. The
 * un-guided LTX path is TWO passes: 8 steps at half size, `LTXVLatentUpsampler`
 * x2 in latent space, then 3 more steps at full size (see workflow.js — the
 * `guided ? {} : { 18: LTXVLatentUpsampler ... }` branch). The guided path stops
 * after one pass at full size. A control carrying an extra sampler pass and a
 * different sigma schedule confounds the comparison with a rendering difference
 * that has nothing to do with conditioning.
 *
 * So A0 starts as A1's graph and has its conditioning removed surgically:
 * everything else — model, text encodes, empty latent, audio latent, noise,
 * sampler, sigmas, both CFGs, the decode, CreateVideo's fps — stays byte for
 * byte identical. `fingerprint()` proves that afterwards rather than trusting it.
 */
function buildControl() {
  const built = restyleGraph(baseArgs({ guideEvery: 16, guideStrength: 0.30, prefix: "x" }));
  const g = structuredClone(built.graph);

  const cond = oneByClass(g, "LTXVConditioning");          // node 8 in today's builder
  const empty = oneByClass(g, "EmptyLTXVLatentVideo");     // node 9
  const vid = oneByClass(g, "LoadVideo");                  // node 30
  const gvc = oneByClass(g, "GetVideoComponents");         // node 31
  const crop = oneByClass(g, "LTXVCropGuides");            // node 18

  /* Walk FORWARD from GetVideoComponents, but only through guide-chain classes.
   * That stops cleanly at LTXVConcatAVLatent / LTXVDualCFGGuider / LTXVCropGuides,
   * which consume the chain's output but are not part of it and must survive. */
  const doomed = new Set([vid, gvc]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [id, node] of Object.entries(g)) {
      if (doomed.has(id) || !GUIDE_CHAIN.has(node.class_type)) continue;
      const feeds = Object.values(node.inputs).some((v) => isLink(v) && doomed.has(v[0]));
      if (feeds) { doomed.add(id); grew = true; }
    }
  }

  /* Repair every surviving link that pointed into the deleted chain. Only
   * LTXVAddGuide is ever referenced from outside it, and its three outputs map
   * back to exactly the sources restyleGraph would have used with zero guides:
   * conditioning[0]/[1] for the prompt pair, the empty latent for the video.
   *
   * ⚠ KEYED ON CLASS **AND** SLOT, never slot alone. Slot alone happens to work
   * today only because LTXVAddGuide is the sole deleted class read from outside
   * the chain. The obvious future edit — wiring `GetVideoComponents[2]`, the
   * source's OWN frame rate, into CreateVideo or LTXVConditioning, which is the
   * natural fix for the fps hazard this whole gate is built around — would be
   * silently rewritten by a slot-keyed map into `EmptyLTXVLatentVideo[0]`. A
   * link array is not the number 24, so `validate()` would only catch that by
   * luck. An unnamed class/slot pair throws instead. */
  const doomedClass = new Map([...doomed].map((id) => [id, g[id].class_type]));
  const unguided = {
    "LTXVAddGuide[0]": [cond, 0],   // rewritten positive -> the un-rewritten one
    "LTXVAddGuide[1]": [cond, 1],   // rewritten negative -> the un-rewritten one
    "LTXVAddGuide[2]": [empty, 0],  // guided latent      -> the empty latent
  };
  for (const id of doomed) delete g[id];
  for (const [nid, node] of Object.entries(g)) {
    for (const [k, v] of Object.entries(node.inputs)) {
      if (!isLink(v) || g[v[0]]) continue;
      const cls = doomedClass.get(v[0]) ?? "(unknown node)";
      const repl = unguided[`${cls}[${v[1]}]`];
      if (!repl) {
        throw new Error(
          `A0: ${nid}.${k} reads ${cls}[${v[1]}], which the strip deletes and this map does not name.\n`
          + "  Refusing to guess a replacement. Add an explicit entry to `unguided` saying what the\n"
          + "  un-guided graph should read instead — silently substituting by slot index is how a\n"
          + "  frame-rate link becomes a latent link with no error anywhere.");
      }
      node.inputs[k] = [...repl];
    }
  }

  /* Bypass LTXVCropGuides. With no guides there is nothing pinned to crop out,
   * and leaving the node in would make A0 structurally different from "the same
   * graph without conditioning". Each of its outputs is replaced by its own
   * matching input, which is what a bypass is. */
  const passthrough = { 0: g[crop].inputs.positive, 1: g[crop].inputs.negative, 2: g[crop].inputs.latent };
  delete g[crop];
  for (const node of Object.values(g)) {
    for (const [k, v] of Object.entries(node.inputs)) {
      if (isLink(v) && v[0] === crop) node.inputs[k] = [...passthrough[v[1]]];
    }
  }

  return { graph: g, guides: 0, length: built.length, fps: built.fps,
           stripped: [...doomed, crop].sort((a, b) => Number(a) - Number(b)) };
}

/**
 * A6 — one guide holding the WHOLE batch.
 *
 * `LTXVAddGuide` documents its image input as "Image or video to condition the
 * latent video on", so a multi-frame batch at frame_idx 0 is the node used as
 * documented rather than a trick. It is also the densest possible conditioning
 * and the most likely to run out of memory: 121 frames through LTXVPreprocess
 * and then the VAE, in one go.
 *
 * Hand-built from a one-guide restyleGraph and then RETARGETED, so the rest of
 * the chain is the shipped code's, not a re-typed copy of it.
 *
 * ⚠⚠ THE IMAGEFROMBATCH IS LOAD-BEARING AND MUST NOT BE DELETED. ⚠⚠
 *
 * Deleting it and wiring ImageScale straight to `GetVideoComponents[0]` hands
 * the guide the WHOLE decoded source. The harness demands >= 121 frames and
 * gate_block.py renders 144, so that is 144 frames. `LTXVAddGuide.encode` crops
 * to 8n+1 = 137, the causal VAE turns 137 into 18 latent frames, and the latent
 * from `EmptyLTXVLatentVideo(121)` is only ((121-1)//8)+1 = 16. nodes_lt.py:471
 * then asserts `latent_idx + t.shape[2] <= latent_length` -> 0 + 18 <= 16, which
 * is FALSE. That is a deterministic AssertionError, not the OOM this arm was
 * designed to risk, so the /out of memory/ branch in dispatch() never fires and
 * A6 — the densest arm, the upper bound of the whole sweep — records as a bare
 * FAILED after burning a dispatch slot. It could never have produced a frame.
 *
 * So: KEEP the node, and cap the guide at LENGTH frames. 121 = 8*15+1 is already
 * a legal guide length, batch_index 0 with length 121 ends at source frame 120
 * which is < 144, so the ImageFromBatch clamp cannot fire either, and
 * guideLatentSpan(0, 121) lands exactly on 0 + 16 <= 16.
 *
 * ⚠ If it OOMs, THAT is a RESULT — "the dense arm does not fit on this card" is
 * a finding about the rig, not a broken harness. `--dense-fallback` then runs
 * the 41-frame variant (8n+1, the LTX frame rule) at frame_idx 25, covering the
 * orbit and nothing else.
 *
 * ⚠ WHY 25 AND NOT 24. `get_latent_index` (nodes_lt.py:344) rounds a MULTI-frame
 * guide's index DOWN to (frame_idx-1)//8*8+1, so a requested 24 becomes 17 and
 * source frames 24..64 are written at PIXEL frames 17..57 — seven frames early,
 * silently, with the node's own tooltip as the only warning. gate_score.py
 * compares against analytic ground truth at ABSOLUTE frame indices, and its lag
 * scan is only +-4 wide, so a 7-frame offset reads as the arm ignoring the
 * camera when it in fact followed a correctly-conditioned move placed at the
 * wrong time. 25 is a FIXED POINT of that rounding ((25-1)/8*8+1 = 25), so the
 * guide lands where it is asked to. `assertGuidePlacement()` makes that
 * executable rather than a comment a future edit can walk past.
 */
function buildDense({ fallback = false, strength = 0.30 } = {}) {
  // guideEvery >= length gives exactly one iteration of restyleGraph's loop.
  const built = restyleGraph(baseArgs({ guideEvery: LENGTH, guideStrength: strength, prefix: "x" }));
  const g = structuredClone(built.graph);
  const ifb = oneByClass(g, "ImageFromBatch");
  const guide = oneByClass(g, "LTXVAddGuide");

  // 41 = 8*5+1. Frames 25..65 are the orbit; 25 is a fixed point of the rounding.
  const [at, span] = fallback ? [25, 41] : [0, LENGTH];
  g[ifb].inputs.batch_index = at;
  g[ifb].inputs.length = span;
  g[guide].inputs.frame_idx = at;

  assertGuidePlacement(at, span, `A6${fallback ? " (--dense-fallback)" : ""}`);
  return { graph: g, guides: 1, length: built.length, fps: built.fps, span, at, fallback };
}

function buildArm(arm, seed) {
  const prefix = `gate/${arm.id}/${arm.id}_s${seed}`;
  let out;
  if (arm.kind === "control") out = buildControl();
  else if (arm.kind === "dense") out = buildDense({ fallback: has("--dense-fallback"), strength: arm.strength });
  else out = restyleGraph(baseArgs({ guideEvery: arm.every, guideStrength: arm.strength, prefix }));

  const g = out.graph;
  // Seed and destination are the only two things that differ per dispatch.
  g[oneByClass(g, "RandomNoise")].inputs.noise_seed = seed;
  g[oneByClass(g, "SaveVideo")].inputs.filename_prefix = prefix;
  return { ...out, graph: g, arm: arm.id, seed, prefix };
}

/* ───────────────────────────── validation ────────────────────────────────── */

/**
 * A guide must land WHERE IT WAS ASKED TO, and must FIT inside the latent.
 *
 * Two hazards, both silent on the GPU, both cheap here. The first cost the
 * fallback path a 7-frame offset that would have read as "the arm ignored the
 * camera"; the second is what makes A6 a deterministic AssertionError rather
 * than the OOM the arm was designed to risk. Throwing turns each into a build
 * failure that names its own mechanism.
 */
function assertGuidePlacement(frameIdx, span, label) {
  const s = guideLatentSpan(frameIdx, span);

  if (span > 1 && !(frameIdx === 0 || (frameIdx - 1) % TIME_SCALE === 0)) {
    throw new Error(
      `${label}: a ${span}-frame guide at frame_idx ${frameIdx} is not a legal placement.\n`
      + `  LTXVAddGuide.get_latent_index (nodes_lt.py:344) rounds a MULTI-frame guide DOWN to\n`
      + `  (frame_idx-1)//8*8+1, so ${frameIdx} would become ${s.effective} and the guided frames would be\n`
      + `  written ${Math.abs(s.drift)} frame(s) early with no warning. gate_score.py compares at ABSOLUTE\n`
      + `  indices and its lag scan is only +-4 wide, so the offset would read as the arm\n`
      + `  failing to follow the camera. Use frame_idx 0 or any (8k+1): 1, 9, 17, 25, ...`);
  }
  if (s.drift !== 0) {
    throw new Error(`${label}: guide at ${frameIdx} would be silently relocated to ${s.effective}`);
  }
  if (s.end > LATENT_LENGTH) {
    throw new Error(
      `${label}: a ${span}-frame guide at frame_idx ${frameIdx} occupies latent frames `
      + `${s.latentIdx}..${s.end - 1}, past the ${LATENT_LENGTH}-frame latent.\n`
      + `  nodes_lt.py:471 asserts latent_idx + t.shape[2] <= latent_length -> `
      + `${s.latentIdx} + ${s.latents} <= ${LATENT_LENGTH} is FALSE.\n`
      + `  This is an AssertionError, NOT an OOM, so dispatch()'s /out of memory/ branch would not\n`
      + `  fire and the arm would record as a bare FAILED. Cap the guide at ${LENGTH} source frames.`);
  }
  return s;
}

/* assertNoCameraWords now lives in gate_lib.mjs — the word list is SHARED with
 * vace_run.mjs on purpose, because the frozen prompt is shared: a camera-move
 * word that invalidates one gate's text-only control invalidates the other's,
 * and one list cannot drift out of step with itself. */

/**
 * Every `LTXVAddGuide` in a graph, as the NODE will see it: where it is placed,
 * how many SOURCE frames it actually pulls, and what that costs in the latent.
 *
 * ⚠ THE SPAN COMES FROM THE GRAPH, NEVER FROM AN ASSUMPTION. The previous
 * version returned `LENGTH` whenever the chain had no ImageFromBatch — and that
 * is precisely the case where the guide reads the WHOLE decoded batch, so the
 * one arm capable of overrunning the latent was the one arm the check could not
 * see. With no ImageFromBatch the span IS the decoded frame count; if the clip
 * has not been probed, that count is unknown and this says so rather than guess.
 */
function describeGuides(g, decodedFrames = null) {
  return findByClass(g, "LTXVAddGuide").map((k) => {
    const im = g[k].inputs.image;                    // -> LTXVPreprocess
    const pre = g[im?.[0]]?.inputs.image;            // -> ImageScale
    const src = g[pre?.[0]]?.inputs.image;           // -> ImageFromBatch | GetVideoComponents | LoadImage
    const n = g[src?.[0]];
    const frameIdx = g[k].inputs.frame_idx;
    if (n?.class_type === "ImageFromBatch") {
      return { id: k, frameIdx, span: n.inputs.length, batchIndex: n.inputs.batch_index, from: "ImageFromBatch" };
    }
    if (n?.class_type === "GetVideoComponents") {
      return { id: k, frameIdx, span: decodedFrames, batchIndex: 0, from: "the WHOLE decoded batch" };
    }
    if (n?.class_type === "LoadImage") return { id: k, frameIdx, span: 1, batchIndex: null, from: "LoadImage" };
    return { id: k, frameIdx, span: null, batchIndex: null, from: n?.class_type ?? "an untraceable source" };
  });
}

/** Structural check. Everything a live /prompt POST would reject, minus the GPU. */
function validate(g, label, expect = {}) {
  // Links, arities, exactly one output node, orphans, cycles — gate_lib.mjs.
  const bad = structuralProblems(g, OUT_SLOTS, OUTPUT_CLASSES);

  // The three numbers, as the graph itself states them.
  const el = g[findByClass(g, "EmptyLTXVLatentVideo")[0]]?.inputs;
  if (el?.width !== WIDTH || el?.height !== HEIGHT) bad.push(`latent is ${el?.width}x${el?.height}, not ${WIDTH}x${HEIGHT}`);
  if (el?.length !== LENGTH) bad.push(`latent length ${el?.length}, not ${LENGTH}`);
  const cv = g[findByClass(g, "CreateVideo")[0]]?.inputs;
  if (cv?.fps !== FPS) bad.push(`CreateVideo fps ${cv?.fps}, not ${FPS}`);
  const cond = g[findByClass(g, "LTXVConditioning")[0]]?.inputs;
  if (cond?.frame_rate !== FPS) bad.push(`LTXVConditioning frame_rate ${cond?.frame_rate}, not ${FPS}`);

  // The prompt pair is frozen and identical everywhere, control included.
  const texts = findByClass(g, "CLIPTextEncode").map((k) => g[k].inputs.text);
  if (!texts.includes(POSITIVE)) bad.push("the frozen positive prompt is not in this graph");
  if (!texts.includes(NEGATIVE)) bad.push("the frozen negative prompt is not in this graph");

  if (expect.noPixels) {
    // Said twice — no pixel source anywhere, AND none upstream of the sampler.
    bad.push(...pixelLeaks(g, PIXEL_SOURCES, "SamplerCustomAdvanced"));
    if (findByClass(g, "LTXVAddGuide").length) bad.push("CONTROL LEAK: an LTXVAddGuide survived the strip");
    if (findByClass(g, "LTXVCropGuides").length) bad.push("CONTROL: LTXVCropGuides was not bypassed");
  }

  if (expect.guides !== undefined) {
    const n = findByClass(g, "LTXVAddGuide").length;
    if (n !== expect.guides) bad.push(`${n} guides, expected ${expect.guides}`);
  }
  if (expect.maxIndex !== undefined && expect.sourceFrames) {
    // The ImageFromBatch clamp again: an index past the end freezes, silently.
    if (expect.maxIndex >= expect.sourceFrames) {
      bad.push(`guide index ${expect.maxIndex} >= ${expect.sourceFrames} source frames — ImageFromBatch would CLAMP`);
    }
  }

  /* Every guide, against the node's OWN assertion. This is the check that makes
   * a 144-frame guide into a build failure instead of a dispatch slot spent on a
   * deterministic AssertionError. */
  for (const gd of expect.guideList ?? []) {
    if (gd.span === null || gd.span === undefined) {
      bad.push(`guide ${gd.id} reads ${gd.from} and its frame span is unknown — `
        + "the ImageFromBatch clamp and the latent bound cannot be checked (is the clip staged and probed?)");
      continue;
    }
    try {
      assertGuidePlacement(gd.frameIdx, gd.span, `${label} guide ${gd.id}`);
    } catch (e) {
      bad.push(e.message.replace(/\n\s+/g, " "));
    }
  }
  return bad;
}

/**
 * "Only the conditioning varies" — as a check, not a hope.
 *
 * Deletes the conditioning apparatus, blanks the four seams where it joins the
 * rest of the graph, blanks the two fields that legitimately differ per
 * dispatch, and hashes what is left. Every arm must produce the same string. If
 * an edit ever changes a sigma, a CFG, the decode tiling or the frame rate on
 * one path only, this is what catches it.
 */
function fingerprint(g) {
  const f = structuredClone(g);
  const drop = new Set(Object.keys(f).filter((k) =>
    GUIDE_CHAIN.has(f[k].class_type) || ["LoadVideo", "GetVideoComponents", "LTXVCropGuides"].includes(f[k].class_type)));
  for (const k of drop) delete f[k];
  for (const n of Object.values(f)) {
    // The four seams: where conditioning meets the shared machinery.
    if (n.class_type === "LTXVConcatAVLatent") n.inputs.video_latent = "<cond>";
    if (n.class_type === "LTXVDualCFGGuider") { n.inputs.positive = "<cond>"; n.inputs.negative = "<cond>"; }
    if (n.class_type === "VAEDecodeTiled") n.inputs.samples = "<cond>";
    // Per-dispatch, not per-arm.
    if (n.class_type === "RandomNoise") n.inputs.noise_seed = "<seed>";
    if (n.class_type === "SaveVideo") n.inputs.filename_prefix = "<prefix>";
    for (const [k, v] of Object.entries(n.inputs)) if (isLink(v) && drop.has(v[0])) n.inputs[k] = "<cond>";
  }
  return sortedJSON(f);
}

/**
 * The values `fingerprint()` certifies as constant, read out of a REAL built
 * graph so the manifest records WHAT was held constant and not merely THAT
 * something was.
 *
 * The published claim is "A1 beat A0 by X and the only difference was
 * conditioning". Every quantity that makes that true — sampler, sigmas, both
 * CFGs, the decode tiling, the three model filenames — was read live from
 * `config.video.engines.ltx` at build time and then written down nowhere, and
 * `config.js` resolves several of those filenames with `pick()`, which returns
 * its last candidate whether or not the file exists. Six months from now the
 * check that makes the claim true has to be recoverable from the artefacts.
 */
function certifiedValues(g) {
  const one = (cls) => { const k = findByClass(g, cls)[0]; return k ? g[k].inputs : {}; };
  const dec = one("VAEDecodeTiled"), lat = one("EmptyLTXVLatentVideo"), cfg = one("LTXVDualCFGGuider");
  return {
    dit: one("UNETLoader").unet_name,
    textEncoder: one("CLIPLoader").clip_name,
    vaes: findByClass(g, "VAELoader").map((k) => g[k].inputs.vae_name),
    sampler: one("KSamplerSelect").sampler_name,
    sigmasLow: one("ManualSigmas").sigmas,
    videoCfg: cfg.video_cfg, audioCfg: cfg.audio_cfg,
    decodeTiling: { tile_size: dec.tile_size, overlap: dec.overlap,
                    temporal_size: dec.temporal_size, temporal_overlap: dec.temporal_overlap },
    latent: { width: lat.width, height: lat.height, length: lat.length },
    createVideoFps: one("CreateVideo").fps,
    conditioningFrameRate: one("LTXVConditioning").frame_rate,
  };
}

/* ─────────────────────────── the source clip ─────────────────────────────── */

/* probeClip (PyAV, frames COUNTED not read off a header) and the three-numbers
 * assertion live in gate_lib.mjs. The three `why` strings stay HERE, because
 * each names the mechanism in LTX's own node terms and vace_run's are different
 * nodes with different silent failures. */
const THREE_NUMBERS = {
  width: WIDTH, height: HEIGHT, fps: FPS, minFrames: MIN_SOURCE_FRAMES,
  why: {
    size: 'ImageScale has crop:"disabled" and STRETCHES',
    fps: "the render is ALWAYS 24 and never reads the source's rate",
    length: "ImageFromBatch CLAMPS past the end and freezes silently",
  },
};

/* ─────────────────────────────── dispatch ────────────────────────────────── */

/* engineIdentity (a port is not an identity: /system_stats -> system.argv ->
 * the launched --input-directory / --output-directory / --port) and the bounded
 * poll loop both live in gate_lib.mjs now. The deadline stays HERE because it is
 * a per-gate number: LTX arms measured 130-235 s. */
const engineIdentity = () => engineIdentityOf(BASE, {
  inputDir: INPUT, outputDir: config.outputDir, port: config.comfy.port });
const dispatch = makeDispatcher(BASE, { deadlineMs: 20 * 60 * 1000 });

/* ─────────────────────────────── main ────────────────────────────────────── */

console.log(`gate_run — ${RUN ? "DISPATCH" : PREFLIGHT ? "PREFLIGHT" : "DRY RUN"}   ${BASE}`);
console.log(`  ${WIDTH}x${HEIGHT}  ${FPS}.000 fps  ${LENGTH} frames  seed ${SEED}${EXTRA_SEEDS.length ? ` (+${EXTRA_SEEDS.join(",")} on ${[...EXTRA_ARMS].join("/")})` : ""}\n`);

assertNoCameraWords(POSITIVE);
console.log("  prompt guard  ok — no camera-move words in the positive\n");

if (PREFLIGHT) {
  const vr = videoReady("ltx");
  console.log(`  weights       ${vr.ready ? "ready" : `MISSING ${vr.missing.join(", ")}`}`);
  const eng = await engineIdentity();
  console.log(`  ${BASE}  ${eng.up ? `answering (ComfyUI ${eng.version})` : `not answering (${eng.why})`}`);
  if (eng.up) {
    /* The operator gets to SEE the engine's own argv before committing a night
     * to it — the input and output directories especially, because a mismatch
     * there renders every arm successfully into a library nothing will read. */
    console.log(`  argv          ${eng.argv ? eng.argv.join(" ") : "(absent from /system_stats)"}`);
    console.log(`  input dir     ${eng.inputDir ?? "?"}${eng.problems.some((p) => p.includes("--input-directory")) ? "   <- MISMATCH" : "   ok"}`);
    console.log(`  output dir    ${eng.outputDir ?? "?"}${eng.problems.some((p) => p.includes("--output-directory")) ? "   <- MISMATCH" : "   ok"}`);
    for (const p of eng.problems) console.log(`  ENGINE FAIL   ${p}`);

    // Only chance to prove the arity table against the real node definitions.
    try {
      const info = await (await fetch(`${BASE}/object_info`, { signal: AbortSignal.timeout(30_000) })).json();
      const wrong = Object.entries(OUT_SLOTS)
        .filter(([c, n]) => info[c] && (info[c].output?.length ?? 0) !== n)
        .map(([c, n]) => `${c}: table says ${n}, server says ${info[c].output.length}`);
      const absent = Object.keys(OUT_SLOTS).filter((c) => !info[c]);
      console.log(`  arity table   ${wrong.length ? `WRONG — ${wrong.join("; ")}` : "matches /object_info"}`);
      if (absent.length) console.log(`  absent nodes  ${absent.join(", ")}`);
    } catch (e) { console.log(`  arity table   could not check: ${e.message}`); }
  }
  const stagedPre = path.join(INPUT, STAGED);
  console.log(`  clip          ${existsSync(stagedPre) ? stagedPre : `NOT STAGED (${stagedPre})`}`);
  process.exit(0);
}

/* Stage the clip. LoadVideo reads ComfyUI's input directory and nowhere else.
 *
 * ⚠⚠ AND THEN PROVE THE STAGED FILE IS THE ONE THIS RUN PUT THERE. ⚠⚠
 *
 * The three numbers check the clip's SHAPE, not its IDENTITY. Any 1280x704 /
 * 24-1 / >=121-frame file passes them — including last week's block render, or
 * the synthetic gray placeholder a previous session had to delete by hand from
 * exactly this filename. Thirteen renders against the wrong source produce a
 * complete, plausible, internally consistent set of numbers that are about a
 * different clip, and nothing downstream can detect it, because dispatch.json
 * recorded the probe's dimensions and never the file's identity. So: hash it,
 * compare it to the source, write the hash into the manifest, and refuse when
 * there is no source to compare against. */
const CLIP_SRC = val("--clip") || [
  path.join(process.cwd(), "gate", STAGED),
  path.join(GATE_OUT, STAGED),
  path.join(config.outputDir, STAGED),
].find(existsSync) || null;

await mkdir(INPUT, { recursive: true });
const staged = path.join(INPUT, STAGED);
if (CLIP_SRC && path.resolve(CLIP_SRC) !== path.resolve(staged)) {
  await copyFile(CLIP_SRC, staged);
  console.log(`  staged        ${CLIP_SRC}\n             -> ${staged}`);
}

let probe = null, srcFacts = null, stagedFacts = null;
let clipProblems = ["the clip is not staged"];
if (existsSync(staged)) {
  stagedFacts = await fileFacts(staged);
  probe = await probeClip(staged);
  clipProblems = assertThreeNumbers(probe, THREE_NUMBERS);
  console.log(`  clip          ${probe.error ? probe.error : `${probe.w}x${probe.h}  ${probe.fps_num}/${probe.fps_den} fps  ${probe.frames} frames  ${probe.codec}  ${(stagedFacts.size / 1e6).toFixed(1)} MB`}`);
  console.log(`  identity      sha256 ${stagedFacts.sha256.slice(0, 16)}…  ${stagedFacts.size} B  mtime ${stagedFacts.mtime}`);

  if (CLIP_SRC) {
    srcFacts = await fileFacts(CLIP_SRC);
    if (srcFacts.sha256 !== stagedFacts.sha256) {
      clipProblems.push(
        `the staged clip is NOT the source this run resolved.\n`
        + `                source ${srcFacts.path}\n`
        + `                       sha256 ${srcFacts.sha256.slice(0, 16)}…  ${srcFacts.size} B  ${srcFacts.mtime}\n`
        + `                staged ${stagedFacts.path}\n`
        + `                       sha256 ${stagedFacts.sha256.slice(0, 16)}…  ${stagedFacts.size} B  ${stagedFacts.mtime}\n`
        + `                Refusing to condition on a file this run did not put there.`);
    }
  } else {
    clipProblems.push(
      `no source clip resolved, so ${staged} is whatever was already in ComfyUI's\n`
      + `                input directory and its provenance is UNKNOWN. The three numbers check the\n`
      + `                clip's shape, not its identity — a stale or synthetic block clip passes all\n`
      + `                three and yields a full set of numbers about a different clip. Pass\n`
      + `                --clip <file> to state what this run is conditioning on.`);
  }
}
for (const p of clipProblems) console.log(`  CLIP FAIL     ${p}`);
console.log("");

/* Build every arm, validate, and only then consider posting.
 *
 * _graphs/ is wiped first, and that is not tidiness. gate_score.py globs
 * _graphs/<arm>_s*.json to print the OPERATING POINT under a GREEN verdict —
 * the guide spacing and strength that step 2 of the brief inherits. The
 * directory carried no run identity, so every later invocation of this
 * harness, INCLUDING A DRY RUN, silently overwrote the graphs the scored
 * renders were actually produced from. A reviewer tripped exactly that. Wiping
 * on each build means the graphs on disk always belong to the most recent
 * build, and a stale operating point cannot be quoted for a render that never
 * used it. */
await rm(GRAPH_DIR, { recursive: true, force: true });
await mkdir(GRAPH_DIR, { recursive: true });
const jobs = [];
const rows = [];
let problems = 0;
let ref = null;         // the CONTROL arm's fingerprint — the only valid baseline
let alt = null;         // first-built fallback, used only to word the failure honestly
const fingerprints = [];

for (const arm of ARMS) {
  if (ONLY.length && !ONLY.includes(arm.id)) continue;
  const seeds = [SEED, ...(EXTRA_ARMS.has(arm.id) ? EXTRA_SEEDS : [])];
  for (const seed of seeds) {
    let job;
    try { job = buildArm(arm, seed); }
    catch (e) { console.log(`  BUILD FAIL    ${arm.id} s${seed}: ${e.message}`); problems++; continue; }

    /* Read the guides back out of the BUILT graph — spans included, and spans
     * from the graph rather than from LENGTH. See describeGuides(). */
    const guideList = describeGuides(job.graph, probe?.frames ?? null);
    const idx = guideList.map((gd) => gd.frameIdx);
    const reach = guideList.filter((gd) => gd.span != null && gd.batchIndex != null)
      .map((gd) => gd.batchIndex + gd.span - 1);
    const maxIndex = reach.length ? Math.max(...reach) : -1;

    const bad = validate(job.graph, `${arm.id} s${seed}`, {
      noPixels: arm.kind === "control",
      guides: arm.kind === "control" ? 0 : undefined,
      maxIndex: maxIndex >= 0 ? maxIndex : undefined,
      sourceFrames: probe?.frames,
      guideList,
    });

    /* ⚠ THE BASELINE IS THE CONTROL, not whichever arm happened to be built
     * first. `--only A2,A3` used to certify A2 against A3 and then print
     * "identical across all arms" — a guarantee about a subset, worded as a
     * guarantee about the experiment. The claim under test is A0-vs-A1, so if A0
     * was not built the fingerprint certifies nothing about it and must say so. */
    const fp = fingerprint(job.graph);
    fingerprints.push({ id: `${arm.id} s${seed}`, arm: arm.id, fp });
    if (arm.kind === "control" && ref === null) ref = { id: `${arm.id} s${seed}`, fp, control: true };
    if (ref === null && alt === null) alt = { id: `${arm.id} s${seed}`, fp, control: false };
    const base = ref ?? alt;
    if (base && fp !== base.fp) {
      bad.push(`sampler path DIFFERS from ${base.id}`
        + `${base.control ? " (the CONTROL)" : " (first built — the control A0 is not in this run)"}`
        + " — only the conditioning may vary");
    }

    if (bad.length) { problems += bad.length; for (const b of bad) console.log(`  INVALID       ${arm.id} s${seed}: ${b}`); }

    await writeFile(path.join(GRAPH_DIR, `${arm.id}_s${seed}.json`), JSON.stringify(job.graph, null, 1));
    jobs.push({ ...job, arm: arm.id, valid: bad.length === 0 });
    if (seed === SEED) {
      /* The note for the dense arm is read back off the BUILT graph, not typed.
       * It used to be a static string saying "whole batch as one guide at frame
       * 0" — which under --dense-fallback captioned a 41-frame guide at frame 25
       * as the whole batch at frame 0, in the very table that gets pasted into a
       * report. A row must not contradict itself. */
      const built = arm.kind === "dense"
        ? `${job.span} source frames as ONE guide at frame ${job.at}`
          + (job.fallback ? " (--dense-fallback: the orbit only)" : " (the whole 121-frame window)")
        : arm.note;
      const ends = guideList.filter((gd) => gd.span != null)
        .map((gd) => guideLatentSpan(gd.frameIdx, gd.span).end);
      rows.push({
        id: arm.id,
        cond: arm.kind === "control" ? "text only"
          : arm.kind === "dense" ? `1 x ${job.span}f @ ${arm.strength.toFixed(2)}`
            : `every ${arm.every} @ ${arm.strength.toFixed(2)}`,
        guides: guideList.length,
        strength: arm.strength ?? null,
        every: arm.every ?? null,
        nodes: Object.keys(job.graph).length,
        at: idx.length > 8 ? `${idx[0]}..${idx.at(-1)}` : idx.join(",") || "-",
        lat: ends.length ? `${Math.max(...ends)}/${LATENT_LENGTH}` : `-/${LATENT_LENGTH}`,
        seeds: seeds.length,
        note: (DISQUALIFIED.has(arm.id) ? "DISQUALIFIED — " : "") + built,
      });
    }
  }
}

const w = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(`\n  arm  conditioning          guides nodes  frame_idx        latent  seeds  note`);
console.log(`  ---  --------------------  ------ -----  ---------------  ------  -----  ----`);
for (const r of rows) {
  console.log(`  ${w(r.id, 3)}  ${w(r.cond, 20)}  ${w(r.guides, 6)} ${w(r.nodes, 5)}  ${w(r.at, 15)}  ${w(r.lat, 6)}  ${w(r.seeds, 5)}  ${r.note}`);
}
console.log(`\n  ${jobs.length} dispatches over ${rows.length} arms; graphs written to ${GRAPH_DIR}`);

/* The coverage claim goes on the artefact, not in someone's memory — and it
 * describes the arms ACTUALLY BUILT, not the table, so `--only` cannot produce a
 * coverage sentence wider than the run. */
const gridExtent = {
  strengths: [...new Set(rows.filter((r) => r.strength != null).map((r) => r.strength))].sort((a, b) => a - b),
  guideCounts: [...new Set(rows.map((r) => r.guides))].filter((n) => n > 0).sort((a, b) => a - b),
  reads_as: "a red result licenses no claim outside this box",
};
console.log("  grid extent   " + (gridExtent.strengths.length
  ? `strengths ${gridExtent.strengths[0].toFixed(2)}–${gridExtent.strengths.at(-1).toFixed(2)}`
    + `, densities ${gridExtent.guideCounts.join("/")} guides — a RED result licenses no claim outside that box`
  : "no guided arm was built — this run establishes nothing about conditioning"));

/* The fingerprint line must describe what was actually compared. */
const distinct = new Set(fingerprints.map((f) => f.fp));
const armsBuilt = [...new Set(fingerprints.map((f) => f.arm))];
console.log("  fingerprint   " + (
  !fingerprints.length ? "nothing built"
    : ref
      ? (distinct.size === 1
        ? `identical across ${fingerprints.length} dispatches, baseline = the CONTROL ${ref.id}`
        : `NOT PROVEN — ${distinct.size} distinct sampler paths, see the failures above`)
      : `NOT CERTIFIED AGAINST THE CONTROL — A0 is not in this run (--only ${ONLY.join(",")}). `
        + (distinct.size === 1
          ? `${armsBuilt.join("/")} match EACH OTHER and nothing else.`
          : `and ${armsBuilt.join("/")} do not even match each other.`)));

console.log(`\n  SCOPE  ${SCOPE.path_tested}.`);
console.log(`         A negative means: ${SCOPE.a_negative_means}.`);
console.log(`         Untested here: ${SCOPE.paths_not_tested.join("; ")}.`);

/* ⚠ THE CLIP PROBLEMS COUNT TOWARDS THE EXIT CODE.
 *
 * They used to print as CLIP FAIL lines and stop there, so a dry run against a
 * 30 fps source, or a 1280x720 one, printed its diagnosis and then EXITED 0 —
 * two of the three silent failures this file's own header enumerates, waved
 * through by the check written to catch them. The operational shape is "run dry,
 * confirm clean, then --run", and a green exit with a CLIP FAIL line buried
 * mid-output is exactly how a wrong-rate source reaches thirteen renders. The
 * stated contract is "exit 0 on a clean dry run, 1 on any validation problem". */
problems += clipProblems.length;

if (problems) {
  if (clipProblems.length) {
    console.log(`\n  THE SOURCE CLIP DOES NOT MEET THE THREE NUMBERS — see the CLIP FAIL line(s) above.`);
  }
  console.log(`\n  ${problems} problem(s). Nothing was dispatched.`);
  process.exit(1);
}
if (!RUN) {
  console.log(`\n  DRY RUN — nothing posted. Add --run to dispatch (requires the clip to pass and 8266 to answer).`);
  process.exit(0);
}

/* From here on it is real. Every gate must be open.
 *
 * The clip gate is already enforced above, now that clipProblems count towards
 * `problems`. It is repeated here on purpose: a future reordering of the
 * exit-code block must not be able to open it by accident. */
if (clipProblems.length) { console.log(`\n  REFUSING TO RUN — the source clip does not meet the three numbers.`); process.exit(1); }

/* ⚠ videoReady used to run under --preflight ONLY, so a missing or renamed LTX
 * weight let every dispatch go out and fail one at a time on UNETLoader /
 * CLIPLoader / VAELoader node errors. config.js resolves several of those
 * filenames with pick(), which returns its LAST candidate whether or not the
 * file exists — so a moved or half-downloaded weight produced thirteen confusing
 * node errors instead of one "LTX is not installed". The production endpoint
 * (index.js:4652) already gates on videoReady before queueing; so does this. */
const vr = videoReady("ltx");
if (!vr.ready) {
  console.log(`\n  REFUSING TO RUN — LTX weights are missing: ${vr.missing.join(", ")}`);
  process.exit(1);
}

const engine = await engineIdentity();
if (!engine.up) { console.log(`\n  REFUSING TO RUN — nothing is answering at ${BASE} (${engine.why}).`); process.exit(1); }
if (engine.problems.length) {
  console.log(`\n  REFUSING TO RUN — the ComfyUI answering on port ${config.comfy.port} is not this rig's:`);
  for (const p of engine.problems) console.log(`      ${p}`);
  console.log("      A port is not an identity. A foreign engine with a matching input directory but a");
  console.log("      different --output-directory renders every arm successfully and writes them where");
  console.log("      gate_score.py will never look. Close it, or set AIPLAY_COMFY_PORT to a free port.");
  process.exit(1);
}
console.log(`  engine        ComfyUI ${engine.version} — --input-directory and --output-directory match this rig`);

await mkdir(GATE_OUT, { recursive: true });
const MANIFEST = path.join(GATE_OUT, "dispatch.json");

/* ⚠ THE MANIFEST IS WRITTEN AFTER EVERY JOB, NOT ONCE AT THE END. At 130–235 s
 * a render, thirteen dispatches are a 30–50 minute window in which a Ctrl-C, a
 * crash or a hang destroyed every result — including the OOM and error findings
 * the manifest exists to carry, which are the most interesting rows and the ones
 * most likely to precede whatever ends the run early. The file is a few KB. */
const certified = jobs.length ? certifiedValues(jobs[0].graph) : null;
const writeManifest = async (results) => writeFile(MANIFEST, JSON.stringify({
  at: new Date().toISOString(),
  complete: results.length === jobs.length,
  dispatched: results.length, planned: jobs.length,

  /* Decision 3: the scope caveat travels with the numbers, so a write-up built
   * from the files alone cannot make the broad claim. */
  scope: SCOPE,

  width: WIDTH, height: HEIGHT, fps: FPS, length: LENGTH, latentLength: LATENT_LENGTH,
  positive: POSITIVE, negative: NEGATIVE, seed: SEED, extraSeeds: EXTRA_SEEDS,
  disqualified: [...DISQUALIFIED],
  gridExtent,
  arms: rows,

  // What was conditioned on — identity, not just shape.
  source: probe,
  clip: { staged: stagedFacts, resolvedFrom: srcFacts },

  // Which engine actually rendered it.
  engine: { version: engine.version, port: engine.port,
            inputDir: engine.inputDir, outputDir: engine.outputDir, argv: engine.argv },

  /* What fingerprint() certified, and against WHAT. The claim is "A1 beat A0 and
   * the only difference was conditioning"; these are the values that make it
   * true, recorded next to it. */
  certified: {
    baseline: ref ? `${ref.id} (the control)` : `NONE — A0 was not built (--only ${ONLY.join(",")})`,
    identicalAcross: new Set(fingerprints.map((f) => f.fp)).size === 1 ? fingerprints.map((f) => f.id) : null,
    fingerprintSha256: ref ? createHash("sha256").update(ref.fp).digest("hex") : null,
    values: certified,
  },

  results: results.map(({ graph, ...r }) => r),
}, null, 1));

const results = [];
await writeManifest(results);
for (const job of jobs) {
  process.stdout.write(`  ${job.arm} s${job.seed} `);
  const r = await dispatch(job);
  results.push(r);
  await writeManifest(results);
  console.log(r.ok
    ? ` ${r.secs.toFixed(0)}s -> ${r.file}`
    : ` ${r.oom ? "OOM (recorded as a result)" : r.serverGone ? "SERVER GONE" : r.timedOut ? "TIMED OUT" : r.vanished ? "VANISHED" : "FAILED"}: ${String(r.why).slice(0, 200)}`);
}
console.log(`\n  ${results.filter((r) => r.ok).length}/${results.length} rendered — manifest at ${MANIFEST}`);
console.log(`  SCOPE: ${SCOPE.a_negative_means}.`);

/* ⚠ A RESULT AND A HARNESS FAILURE EXIT DIFFERENTLY.
 *
 * An OOM or a node error is a RESULT about this rig — ComfyUI answered, the
 * answer was "no", and that is a finding the manifest carries. A job that never
 * got a terminal answer at all — the server stopped answering, the deadline
 * expired, the prompt vanished from both history and queue, the POST itself
 * failed — establishes nothing and must not read as a completed run to a wrapper
 * or to a tired operator at 3 a.m. */
const unanswered = results.filter((r) => r.serverGone || r.timedOut || r.vanished
  || (!r.ok && !r.oom && String(r.why).startsWith("POST /prompt failed")));
if (unanswered.length) {
  console.log(`\n  ${unanswered.length} job(s) never got an answer from ComfyUI `
    + `(${unanswered.map((r) => `${r.arm} s${r.seed}`).join(", ")}).`);
  console.log("  That is a HARNESS failure, not a result about conditioning — exiting 1.");
  process.exit(1);
}
