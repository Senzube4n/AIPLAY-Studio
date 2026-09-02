/**
 * The camera-control gate, SECOND MECHANISM — WAN 2.1 VACE structural residual.
 *
 *   node scripts/vace_run.mjs                 # DRY RUN (the default), builds + validates only
 *   node scripts/vace_run.mjs --preflight     # are the weights there, is 8266 answering
 *   node scripts/vace_run.mjs --run           # actually POST to ComfyUI
 *   node scripts/vace_run.mjs --run --only W0,W9    # stage 1
 *   node scripts/vace_run.mjs --run                 # ... later: stage 2, KEEPING stage 1
 *   node scripts/vace_run.mjs --run --force         # rebuild and re-render everything
 *
 * ⚠⚠ RESUMABLE, AND THAT IS NOT A CONVENIENCE. ⚠⚠
 *
 * This run is meant to be STAGED — `--run --only W0,W9` first, because whether
 * any other arm is readable at all hangs on what those two score — and staging
 * only works if stage 2 does not destroy stage 1.
 *
 * It used to. `rm(GRAPH_DIR, {recursive:true, force:true})` ran on EVERY
 * invocation, and gate_score.py reads `_graphs/<arm>_s*.json` for two things it
 * can get nowhere else: the OPERATING POINT it prints under a verdict, and the
 * DERIVED ZERO-STRENGTH BAR that keeps the null arm from being announced as the
 * answer. A second `--run` therefore deleted the record of the first.
 *
 * scripts/film_run.mjs learned the same lesson in a different shape ("two hours
 * of renders WILL be interrupted at some point") and its header is worth
 * reading — including the trap that the SaveVideo prefix is a FILENAME prefix
 * and not a directory, which is how a resume check can look like it works while
 * doing nothing.
 *
 * Here it is that rule plus one obligation, because THE WIPE EXISTED FOR A
 * REASON: a stale graph must never be quoted as a run's operating point. So
 * instead of deleting indiscriminately:
 *
 *   1. every graph directory carries `_run.json`, a stamp over the FROZEN
 *      CONDITIONS — resolution, fps, length, prompts, seeds, the whole ARMS
 *      table, the control/degenerate/disqualified declaration, the weights and
 *      the staged clip's sha256. An invocation whose stamp differs is REFUSED,
 *      by field and by value, rather than allowed to mix its graphs in.
 *   2. a graph already on disk is never overwritten with different bytes. Under
 *      one stamp a rebuild is identical, so a difference is a hole in (1) and is
 *      reported instead of applied.
 *   3. an arm whose output already exists is SKIPPED unless --force. It is still
 *      built, validated and fingerprinted — the sampler-path certification is a
 *      claim about the whole run and must not quietly shrink to the part being
 *      re-rendered — but it is not re-dispatched, and its graph is left exactly
 *      as the run that produced the output wrote it.
 *
 * `--force` is the way back to the old behaviour: it wipes the graph directory
 * and re-renders every selected arm. It is the only thing here that may destroy
 * another stage's record, and it has to be typed.
 *
 * WHY THIS EXISTS. The LTX gate (scripts/gate_run.mjs) returned a DECISIVE
 * NEGATIVE: across strengths 0.15–0.70 and densities 1/8/16 guides there was no
 * setting where the camera followed the blocked move AND the output was anything
 * but the gray boxes. A4 (dense, 0.70) reached CMA 0.918 against a 0.982
 * reconstruction anchor while sitting at SSIM 0.914 to the blockout — it got the
 * move by handing back the source. Every arm that actually restyled had MR
 * 0.03–0.16, i.e. no camera motion at all.
 *
 * The scope caveat stamped into every one of those artefacts says that is a
 * negative about SPARSE APPEARANCE GUIDES, not about control video. This run
 * tests the other half.
 *
 * ⚠⚠ WHAT THE CODE ACTUALLY SAYS, WHICH IS NOT QUITE WHAT THE BRIEF ASSUMED. ⚠⚠
 *
 * The brief for this arm said VACE is "STRUCTURAL conditioning — the mechanism
 * objection that killed LTX does not apply". Read `WanVaceToVideo.execute`
 * (comfy_extras/nodes_wan.py:316) and that is half right, in a way that matters
 * enough to be written down before any number is produced:
 *
 *   control_video = control_video - 0.5
 *   inactive = (control_video * (1 - mask)) + 0.5      # mask is ALL ONES here
 *   reactive = (control_video * mask) + 0.5            # -> reactive IS the clip
 *   inactive = vae.encode(inactive[:, :, :, :3])
 *   reactive = vae.encode(reactive[:, :, :, :3])
 *
 * VACE **ALSO VAE-ENCODES LITERAL SOURCE PIXELS**. With no `control_masks` the
 * mask is ones, so `inactive` degenerates to a constant 0.5 gray plate and every
 * bit of information rides in `reactive`, which is the control clip itself. There
 * is no depth field, no pose, no structure/appearance separation in this path
 * either. Anyone who reads "VACE = structural" and stops there has the mechanism
 * wrong.
 *
 * WHAT IS GENUINELY DIFFERENT IS WHERE THE ENCODED PIXELS GO:
 *
 *   LTXVAddGuide   writes the encoded frames INTO the denoising latent, replacing
 *                  noise at those frame indices. The model starts from the boxes.
 *   VACE           routes them through a SEPARATE patch embedding into a parallel
 *                  stack of vace_blocks, and adds the result as a residual:
 *                    x += c_skip * vace_strength[iii]
 *                  (comfy/ldm/wan/model.py:854, inside VaceWanModel.forward_orig).
 *                  The denoising latent is never overwritten; the model starts
 *                  from pure noise and is PUSHED, at a strength the graph names.
 *
 * So the honest statement of what this run tests is: **a scaled additive residual
 * carrying VAE-encoded control frames**, not "structural conditioning". The
 * mechanism objection that killed LTX is WEAKENED — the boxes are no longer the
 * model's own starting state, and there is a continuous knob between "ignored"
 * and "dominant" where LTX had a hard overwrite — but it is not eliminated. It is
 * still an appearance signal. That sentence is in `SCOPE` below and is written
 * verbatim into every artefact this script produces.
 *
 * ⚠⚠ A W ARM MUST NEVER BE COMPARED AGAINST A0. ⚠⚠
 *
 * A0 is the LTX text-only control. Criterion (2) of the pass rule is
 * "CMA >= control + margin" — and a WAN arm beating an LTX control proves nothing
 * about conditioning; it is a MODEL comparison wearing a conditioning
 * comparison's clothes. So this run has its own same-model, same-prompt,
 * same-seed text-only control, W0, and it is enforced three ways rather than
 * remembered:
 *
 *   1. this run writes into its OWN root (`<output>/vace`), so gate_score.py
 *      globbing `<root>/＊/gate_score.json` physically cannot see an A arm;
 *   2. it drops `gate_controls.json` in that root NAMING W0 as the criterion-2
 *      baseline and W9 as the degeneracy calibrator, which gate_score.py reads
 *      and obeys — a `--control` flag that disagrees with it is a hard error;
 *   3. gate_score.py derives the family from the arm ids present and refuses a
 *      root that mixes them, and refuses a control from another family.
 *
 * ⚠ THE ASPECT DECISION, MADE DELIBERATELY AND STATED. See `WHY 1280x704` below.
 *
 * ⚠ DRY RUN IS THE DEFAULT. An accidental `node scripts/vace_run.mjs` must not
 * start fifteen renders. Dispatch requires `--run` and a live server.
 *
 * WHAT IS SHARED WITH gate_run.mjs AND WHAT IS NOT. The model-agnostic half —
 * PyAV probe, file hashing, the three-numbers assertion, `/system_stats` engine
 * identity, the bounded poll loop, the generic graph walks (links/arities/
 * orphans/cycles), the no-pixel-path proof, and the frozen positive prompt with
 * its camera-word guard — moved to `scripts/gate_lib.mjs` and both scripts
 * import it. gate_run.mjs's dry run and its emitted graphs are byte-identical
 * before and after that extraction. Nothing model-specific was generalised: LTX
 * latent arithmetic, LTX graph surgery and the LTX fingerprint stayed in
 * gate_run.mjs, and the WAN equivalents are written here from the node source.
 */
import { mkdir, copyFile, writeFile, readFile, readdir, rm, open as fsOpen } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { config } from "../server/config.js";
import {
  isLink, findByClass, oneByClass, sortedJSON, structuralProblems, pixelLeaks,
  assertNoCameraWords, POSITIVE_PROMPT, probeClip, assertThreeNumbers, fileFacts,
  engineIdentity as engineIdentityOf, makeDispatcher,
} from "./gate_lib.mjs";

const BASE = `http://${config.comfy.host}:${config.comfy.port}`;   // 8266 on this rig, not stock 8188
const INPUT = config.inputDir;

/* ⚠ ITS OWN ROOT, and that is enforcement, not tidiness. gate_score.py's
 * --report globs `<root>/＊/gate_score.json`. Writing W arms into the LTX gate's
 * root would put A0 and W1 in the same glob and one careless invocation would
 * score a WAN arm against an LTX control. Separate roots make that impossible
 * rather than discouraged. */
const VACE_OUT = path.join(config.outputDir, "vace");

/* The staged name is what `LoadVideo` is given, and it is the SAME FILE the LTX
 * gate conditioned on — same bytes, same hash. It has to be: gate_score.py's
 * ground truth (gate_block_flow.npz) is analytic for THAT render of the blocking
 * scene, and `source_consistency()` compares the blocking clip's sha256 across
 * every artefact. A different blockout here would score against the wrong
 * geometry and the mixture would be silent. */
const STAGED = "gate_block.mp4";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d = null) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const RUN = has("--run") || has("--go");
const PREFLIGHT = has("--preflight");
const FORCE = has("--force");   // wipe the graph dir and re-render everything selected
const ONLY = (val("--only") || "").split(",").map((s) => s.trim()).filter(Boolean);

/* A dispatch and a dry run do NOT share a graph directory — the same reasoning
 * as gate_run.mjs. gate_score.py reads `_graphs/<arm>_s*.json` to print the
 * OPERATING POINT under a GREEN verdict, so a dry run fired while a dispatch is
 * still rendering must not delete the live run's graphs out from under it. */
const GRAPH_DIR = path.join(VACE_OUT, RUN ? "_graphs" : "_graphs_dry");

/* ───────────────────────── the frozen conditions ─────────────────────────── */

/* ⚠⚠ WHY 1280x704 AND NOT WAN'S NATIVE 832x480. ⚠⚠
 *
 * The blocking clip is 1280x704, ratio 20:11 exactly (1.8182). WAN 1.3B's common
 * native is 832x480, ratio 26:15 (1.7333). Those are NOT the same aspect, and
 * the brief flagged the mismatch as a real risk. It is worse than it looks, and
 * the code says so in three places:
 *
 *   1. gate_score.py:654 —
 *        if int(meta["width"]) != WIDTH or int(meta["height"]) != HEIGHT:
 *            raise SystemExit(...)
 *      The scorer HARD-REFUSES any arm clip that is not exactly 1280x704. It is
 *      not a preference; a 832x480 render cannot be scored by this instrument at
 *      all. `ssim_series(full, block_full)` also compares full-resolution arrays
 *      elementwise, which needs identical shapes.
 *   2. gate_score.py `small_stack()` resizes whatever it is given to 320x176 with
 *      no aspect protection. An 832x480 arm would be scaled x*0.385, y*0.367 —
 *      a 4.7% ANISOTROPIC stretch — before DIS ever ran, so the flow error would
 *      land on the ruler instead of on the model.
 *   3. `WanVaceToVideo.execute` resizes the control video with
 *        comfy.utils.common_upscale(..., width, height, "bilinear", "center")
 *      and `crop="center"` CENTER-CROPS (comfy/utils.py:1075-1086). Feeding this
 *      1280x704 clip to an 832x480 VACE would silently narrow it by
 *      round((1280 - 1280*(1.7333/1.8182))/2) = 30 px on each side — a 4.7%
 *      field-of-view change against a ground truth computed for the full frame.
 *      At 1280x704 the same call is an exact NO-OP: same aspect means x=y=0 so
 *      nothing is cropped, and same size means the interpolate is the identity.
 *      The control video reaches the VAE untouched.
 *
 * So: 1280x704, off native, on purpose. The cost is real and is stated rather
 * than hidden — see `tokenBudget()`, which prints it. The reason it is the right
 * trade is that the off-native penalty is IDENTICAL in W0 and in every W arm, so
 * it cancels in the W0-vs-W1 margin, which is the claim. An aspect change would
 * not cancel: it would move the ground truth under every W number at once.
 *
 * The alternative the brief offered — re-render the blockout and its analytic
 * ground truth at the WAN aspect — is a NEW INSTRUMENT: different WIDTH/HEIGHT,
 * different AW/AH, a regenerated gate_block_flow.npz, a re-measured
 * reconstruction anchor, and A-arm numbers that are no longer comparable to
 * anything. That is a bigger change than the one it avoids. */
const WIDTH = 1280, HEIGHT = 704;
const FPS = 24;

/* 121 frames = the LTX gate's length, and it is legal for WanVaceToVideo:
 * `length` is min 1 / step 4 (nodes_wan.py:298), and 121 = 1 + 4*30. Keeping it
 * at 121 is what lets gate_score.py score these arms UNCHANGED — ARM_FRAMES is
 * 121 and an arm with a different frame count is nearest-in-time resampled and
 * marked INVALID past half a frame period. */
const LENGTH = 121;
const MIN_SOURCE_FRAMES = 121;                  // gate_block.py renders 144, we use the first 121

/* WAN 2.1's VAE is temporal-factor 4, not LTX's 8: `latent_length =
 * ((length - 1) // 4) + 1` (nodes_wan.py:317). The empty latent the node returns
 * is [batch, 16, latent_length, height//8, width//8] (nodes_wan.py:370). */
const TIME_SCALE = 4;
const LATENT_LENGTH = Math.floor((LENGTH - 1) / TIME_SCALE) + 1;   // 31

/* WAN 2.1 VACE weights. There is no `wan` entry in config.video.engines, so
 * these are named here and checked by `wanReady()` rather than by videoReady(). */
const WEIGHTS = {
  diffusion_models: "wan2.1_vace_1.3B_fp16.safetensors",
  text_encoders: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
  vae: "wan_2.1_vae.safetensors",
};

/* Sampler settings taken from the install's own worked reference —
 * blueprints/"Video Inpainting (Wan2.1 VACE).json", the NON-CausVid branch of
 * its switches (node 300 PrimitiveBoolean drives three ComfySwitchNodes; with
 * the CausVid LoRA dropped we take every `on_false` input): ModelSamplingSD3
 * shift 5, KSampler 20 steps, cfg 6, uni_pc / simple, denoise 1.
 *
 * The CausVid LoRA (Wan21_CausVid_14B_T2V_lora_rank32.safetensors) and the SAM3
 * segmentation node in that blueprint are deliberately NOT used: a plain
 * control-video graph needs neither, and neither is installed. */
const SHIFT = 5.0;
const STEPS = 20;
const CFG = 6.0;
const SAMPLER = "uni_pc";
const SCHEDULER = "simple";

/* ─────────────────────────────── the scope ───────────────────────────────── */

/* Carried into dispatch.json AND into gate_controls.json, so a write-up
 * assembled from the artefacts alone cannot make a claim wider than the run.
 * See the ⚠⚠ block at the top of this file — this is the same statement, in a
 * form a script can read. */
const SCOPE = {
  path_tested:
    "WanVaceToVideo -> VaceWanModel — the control clip is VAE-ENCODED (nodes_wan.py:341-343, "
    + "with control_masks absent the mask is ones so `reactive` IS the clip and `inactive` is a "
    + "constant gray plate) and injected as a SCALED ADDITIVE RESIDUAL through a parallel "
    + "vace_block stack: x += c_skip * vace_strength (comfy/ldm/wan/model.py:854)",
  what_is_actually_different_from_ltx:
    "NOT structure-vs-appearance. Both paths VAE-encode literal pixels. LTXVAddGuide writes them "
    + "INTO the denoising latent so the model starts from the boxes; VACE leaves the latent as pure "
    + "noise and PUSHES it with a residual at a strength the graph names. The LTX mechanism "
    + "objection is WEAKENED (no hard overwrite, and a continuous knob exists) but NOT eliminated: "
    + "this is still an appearance signal, not a depth field or a pose.",
  paths_not_tested: [
    "depth / pose ControlNet — the estimators are zero-byte placeholders on this disk",
    "VACE INPAINTING (a PARTIAL control_mask, some of the frame reactive and some inactive) — the "
      + "only mask anywhere in this run is W9's, which is all zeros, and W9 is the degeneracy "
      + "calibrator and is disqualified from passing. Every arm UNDER TEST leaves control_masks "
      + "absent, i.e. mask = ones, full-frame generation",
    "VACE with reference_image — unused here, so trim_latent is provably 0",
    "MiniMax H3 — no strength input at all",
    "WAN 14B VACE — only the 1.3B is on this disk",
  ],
  a_negative_means:
    "a scaled additive residual carrying VAE-encoded gray-box blocking does not steer this model's "
    + "camera at any strength sampled — NOT that structural conditioning (depth/pose) fails",
  a_positive_means:
    "the residual carries it at these strengths ON WAN 1.3B AT 1280x704 — it does not transfer to "
    + "LTX, to the 14B, or to a different aspect",
  resolution_note:
    "rendered at 1280x704 (ratio 20:11), off WAN 1.3B's 832x480 native. gate_score.py:654 refuses "
    + "any other size; at 1280x704 WanVaceToVideo's own common_upscale of the control video is an "
    + "exact no-op, and the off-native penalty is identical in W0 and every W arm so it cancels in "
    + "the margin that carries the claim.",
  cross_family:
    "W arms may NOT be compared against A0/A4. Those are LTX. Criterion (2)'s baseline for this run "
    + "is W0 and criterion (5)'s calibrator is W9, both declared in gate_controls.json.",
  degenerate_anchor:
    "W9 — control_masks ALL ZEROS at strength 1.00. Degenerate by TRAINED BEHAVIOUR, not by "
    + "out-of-range gain: mask 0 makes `inactive` the clip and `reactive` a constant "
    + "(nodes_wan.py:341-343), which is VACE's own vocabulary for 'preserve this footage' — the "
    + "polarity ComfyUI's outpainting template uses, where the ORIGINAL frame area is mask 0 and "
    + "only the new border is mask 1. A large `strength` cannot do the same job: see "
    + "scripts/vace_saturation.py.",
};

/* ────────────────────────────────── arms ─────────────────────────────────── */

/* ⚠ THE STRENGTH AXIS IS LOGARITHMIC, BECAUSE THE NODE'S RANGE SAYS NOTHING.
 *
 * `io.Float.Input("strength", default=1.0, min=0.0, max=1000.0, step=0.01)`
 * (nodes_wan.py:301). The brief's reconstruction of that line is CORRECT — it
 * really is 0 to 1000 — which means the bound carries no information about where
 * the useful band is. A linear sweep of 0.15/0.30/0.45/0.60/0.70, the shape the
 * LTX gate used, would be sampling a 0.07% slice of the declared range and
 * calling it a sweep.
 *
 * What the CODE does tell us is where the meaningful centre is. `x += c_skip *
 * vace_strength[iii]` is a plain scalar on a residual, and the node's default is
 * 1.0 — the value the model was trained with. So 1.0 is the reference point and
 * the sweep is multiplicative around it: x2 steps through the plausible region,
 * x4 beyond it. 0.0 is included and is not decoration — at strength 0.0 the
 * residual is exactly zero, so the VACE branch becomes a mathematical no-op
 * while every node, every link and every tensor shape stays identical. That is
 * the tightest possible null, and it brackets the sweep from below by
 * construction: there is nothing under 0.
 *
 * ⚠ W0 vs W1 IS THE CLAIM, and they differ by EXACTLY ONE WIRE. Both run
 * WanVaceToVideo at strength 1.00; W1 has `control_video` connected and W0 does
 * not. Nothing else — not a node, not a widget, not the seed — differs. With
 * `control_video` absent the node substitutes `torch.ones(...) * 0.5`
 * (nodes_wan.py:322), i.e. a uniform mid-gray plate carrying zero structure, so
 * W0 exercises the identical code path with the identical strength and no
 * information. That is a far tighter control than "a different graph with the
 * conditioning removed", which is what A0 had to be. */
const ARMS = [
  { id: "W0", kind: "control", strength: 1.00,
    note: "TEXT-ONLY CONTROL — no control_video wire; criterion (2) baseline" },
  { id: "W1", kind: "guided", strength: 1.00,
    note: "PRIMARY ARM — the node's trained default; ONE WIRE different from W0" },
  { id: "W2", kind: "guided", strength: 0.50, note: "" },
  { id: "W3", kind: "guided", strength: 0.25, note: "" },
  { id: "W4", kind: "guided", strength: 2.00, note: "" },
  { id: "W5", kind: "guided", strength: 4.00, note: "" },
  /* ⚠⚠ THE SATURATION PROBE — WHAT THE DEGENERATE ANCHOR USED TO BE, AND WHY
   * IT IS NOT THAT ANY MORE. ⚠⚠
   *
   * W6 and W7 were the degenerate anchor: strength 16 and 64, on the reasoning
   * that a big enough multiplier on the residual must eventually make the output
   * reproduce the control clip. comfy/ldm/wan/model.py says it cannot, and the
   * reasoning is short enough to check:
   *
   *   1. x is a PURE RESIDUAL STREAM and every consumer normalises it.
   *      WanAttentionBlock reads norm1(x)/norm2(x) (LayerNorm, elementwise_affine
   *      FALSE, model.py:207/218) and norm3(x); Head reads norm(x) (model.py:365,
   *      also affine-free). LayerNorm(λ·x) == LayerNorm(x), so scaling x up does
   *      not scale what anything READS from it — it only shrinks each block's own
   *      O(1) contribution relative to x.
   *   2. THE VACE STREAM NEVER SEES THE AMPLIFIED x. model.py:853 passes
   *      `x=x_orig` — the patch-embedded input, fixed before block 0 — and
   *      VaceWanAttentionBlock uses that x only at block_id 0. So every c_skip is
   *      a CONSTANT with respect to strength, which appears exactly once, at
   *      model.py:854.
   *
   * Together: out(s) → head(LN(Σ c_skip)) as s → ∞. A FIXED LIMIT, and nothing in
   * the code makes that limit the control clip. `scripts/vace_saturation.py`
   * replicates the arithmetic and measures it: at strength 16 the output is
   * already within 19% of the s→∞ limit (cos 0.982) and at 64 within 5%
   * (cos 0.999). Strength is a knob between "ignored" and one fixed point.
   *
   * THAT PREDICTION IS WORTH A RENDER, SO BOTH ARMS STAY. It is a re-derivation
   * from source plus a random-weight simulation, not a measurement of THIS
   * checkpoint: the real weights set where on that curve strength 16 lands. W6
   * and W7 are 4x apart, so if the prediction holds they come back nearly
   * identical, and if it fails they diverge and the file above is wrong. Either
   * way it costs two renders that were already budgeted. Both remain
   * DISQUALIFIED — a saturated residual is not a reconstruction and must never be
   * read as one. */
  { id: "W6", kind: "guided", strength: 16.00,
    note: "SATURATION PROBE — disqualified; predicted ≈ W7 (vace_saturation.py)" },
  { id: "W7", kind: "guided", strength: 64.00,
    note: "SATURATION PROBE — disqualified; 4x W6, predicted nearly identical" },
  /* THE ZERO-STRENGTH NULL, and it is a different control from W0.
   *
   * W8 has the control_video wire CONNECTED and strength 0.00, so
   * `x += c_skip * 0.0` contributes exactly nothing: the VACE branch still runs,
   * still costs the VAE encode, and is arithmetically inert. It closes the one
   * confound W0 cannot: W0's gray plate is structureless but it is not NOTHING,
   * and at strength 1.0 a uniform mid-gray residual could itself be flattening
   * the output. W0 vs W8 says whether that happened. If they agree, either is a
   * clean baseline; if they disagree, W0 is not a null and the report must say
   * so before any margin is read off it. One render. */
  { id: "W8", kind: "guided", strength: 0.00,
    note: "ZERO-STRENGTH NULL — wire connected, residual multiplied by exactly 0" },
  /* ⚠⚠ THE DEGENERATE ANCHOR. IT HAS TO EXIST, IT IS RUN TO FAIL, AND IT IS
   * DEGENERATE BY TRAINED BEHAVIOUR RATHER THAN BY OUT-OF-RANGE GAIN. ⚠⚠
   *
   * Run 1 of the LTX gate returned NO RESULT for exactly one reason: its
   * calibration arm could not demonstrate that transport works, so the verdict
   * could not tell "the pixels reach the latent and generation discards them"
   * from "the instrument is blind". gate_score.py's (b)/(c)/(g) split turns
   * entirely on this arm. A W run without a working one produces the same
   * expensive nothing — and W6/W7 above are now predicted NOT to be it.
   *
   * WHAT THE NODE ACTUALLY OFFERS, read at nodes_wan.py:337-343:
   *
   *     if control_masks is None:  mask = torch.ones(...)
   *     control_video = control_video - 0.5
   *     inactive = (control_video * (1 - mask)) + 0.5
   *     reactive = (control_video * mask)       + 0.5
   *
   *   mask = 1  ->  inactive = 0.5 (a constant plate),  reactive = THE CLIP
   *   mask = 0  ->  inactive = THE CLIP,                reactive = 0.5
   *
   * Both go to the model, channel-concatenated, and the MASK ITSELF goes with
   * them: comfy/model_base.py:1729 appends it as 64 more channels (8x8
   * pixel-unshuffled), which is why vace_patch_embedding takes 96 = 32 + 64. So
   * the model is told, per token, which stream is which.
   *
   * WHICH POLARITY MEANS "KEEP THIS FOOTAGE"? Not a guess — ComfyUI's own
   * template says it. video_wan_vace_outpainting.json wires
   * ImagePadForOutpaint's mask straight into control_masks, and that node
   * (nodes.py:2031-2039) builds `mask = ones(padded canvas)` and then writes
   * ZEROS over the region occupied by the ORIGINAL IMAGE. The preserved footage
   * is mask 0; the area to invent is mask 1. The v2v template
   * (video_wan_vace_14B_v2v.json) leaves control_masks unconnected — mask ones,
   * generate everywhere, control = the Canny edges. Two templates, opposite
   * ends, same reading.
   *
   * SO: control_masks all zeros over all 121 frames, at the node's TRAINED
   * strength of 1.00, is "preserve this clip" written in the vocabulary the
   * model was trained on. It needs no out-of-range number and no saturation.
   *
   * THE ONE HONEST RESERVATION. An all-zero mask is the LIMIT of the
   * preserve/regenerate task rather than a sample from its interior — during
   * training some region is always reactive. The reason to expect it to hold
   * anyway is that the instruction is PER TOKEN: every token here carries
   * exactly the (mask 0, inactive = footage) pair that every preserved token in
   * every inpainting and outpainting sample carried. There is no separate global
   * "nothing to do" signal for the model to be confused by. If W9 nonetheless
   * comes back not reconstructing, gate_score.py says NO RESULT via branch (g)
   * and names the remedy — a PARTIAL mask (most of the frame zero, a strip of
   * ones), which is interior to the training distribution — rather than blaming
   * the metric.
   *
   * It carries the extra seeds for the same reason W6 used to: gate_score.py
   * routes the WHOLE run to NO RESULT if the calibrator is absent or invalid,
   * and one odd render must not cost a night of GPU. */
  { id: "W9", kind: "guided", strength: 1.00, masks: "zeros",
    note: "DEGENERATE ANCHOR — control_masks ALL ZEROS (VACE for 'keep this footage'); "
        + "disqualified on purpose; criterion (5) calibrator" },
];

/* No arm here may be reported as a pass, whatever it scores. gate_score.py now
 * READS THIS LIST out of gate_controls.json and excludes every id in it from
 * `passers` — it used to write the list and ignore it, which is how W8, the
 * zero-strength null, was eligible to be declared GREEN. gate_score.py ALSO
 * bars any arm whose strength is exactly 0.00 on its own, derived from the
 * dispatched graph, so W8 stays barred even if this list is edited. */
const DISQUALIFIED = new Set(["W6", "W7", "W9"]);

/* The two arms gate_score.py is told to calibrate on. Written into
 * gate_controls.json; see `writeControls()`. */
const CONTROL_ARM = "W0";
const DEGENERATE_ARM = "W9";

/* ⚠⚠ THE ARM SET CHECKS ITSELF, BECAUSE validate() CANNOT. ⚠⚠
 *
 * validate() compares each built graph against what THAT ARM DECLARED — so
 * adding `masks: "zeros"` to W2 makes W2 an all-zero-mask arm and validate()
 * agrees, quietly, and the table prints a mask in a row nobody would look
 * twice at. The mask inverts the instruction (mask 0 = preserve, mask 1 =
 * generate), so a masked arm sitting in the swept band is running the
 * calibrator's experiment while every column says it is running the sweep.
 *
 * The invariant that catches that cannot live inside a per-graph check: it is a
 * property OF THE SET. Exactly one arm may carry a mask, and it must be the arm
 * gate_controls.json names as the degeneracy calibrator, and that arm must be
 * disqualified. Checked here, once, at definition time, so it holds under
 * `--only` too. */
const ARM_SET_PROBLEMS = (() => {
  const bad = [];
  const ids = ARMS.map((a) => a.id);
  const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
  if (dup.length) bad.push(`duplicate arm id(s): ${[...new Set(dup)].join(", ")}`);

  const masked = ARMS.filter((a) => a.masks).map((a) => a.id);
  if (masked.join(",") !== DEGENERATE_ARM) {
    bad.push(`arms carrying control_masks are [${masked.join(", ") || "none"}] but the ONLY arm allowed `
      + `one is the declared degeneracy calibrator ${DEGENERATE_ARM}. A mask INVERTS what the node is `
      + "asked to do (mask 0 = preserve the clip, mask 1 = generate over it), so a masked arm inside "
      + "the swept band is a different experiment wearing the sweep's labels.");
  }
  const degen = ARMS.find((a) => a.id === DEGENERATE_ARM);
  if (!degen) bad.push(`the declared degenerate arm ${DEGENERATE_ARM} is not in ARMS`);
  else {
    if (degen.masks !== "zeros") bad.push(`${DEGENERATE_ARM} is the degeneracy calibrator but its masks field is `
      + `${JSON.stringify(degen.masks ?? null)}, not "zeros" — an unmasked calibrator is just another guided arm`);
    if (degen.kind === "control") bad.push(`${DEGENERATE_ARM} has kind "control", so it has no control_video wire `
      + "and cannot reconstruct anything");
  }
  if (!DISQUALIFIED.has(DEGENERATE_ARM)) {
    bad.push(`${DEGENERATE_ARM} calibrates criterion (5) but is not in DISQUALIFIED — it must never be `
      + "reportable as a pass");
  }
  const ctrl = ARMS.find((a) => a.id === CONTROL_ARM);
  if (!ctrl) bad.push(`the declared control arm ${CONTROL_ARM} is not in ARMS`);
  else if (ctrl.kind !== "control") bad.push(`${CONTROL_ARM} is the criterion-(2) baseline but its kind is `
    + `"${ctrl.kind}" — the baseline must be the arm with NO control_video wire`);
  if (DISQUALIFIED.has(CONTROL_ARM)) bad.push(`${CONTROL_ARM} is both the criterion-(2) baseline and disqualified`);
  for (const id of DISQUALIFIED) if (!ids.includes(id)) bad.push(`DISQUALIFIED names ${id}, which is not in ARMS`);
  return bad;
})();

/* One seed shared by every arm, plus two more where a single render cannot be
 * allowed to decide anything. W0-vs-W1 IS the claim and cannot be read off one
 * seed each; W9 joins them because gate_score.py's verdict tree routes the WHOLE
 * run to NO RESULT if the degeneracy calibrator is absent or invalid, and one
 * odd render should not cost a night of GPU. Same reasoning, same three-arm
 * choice, as A0/A1/A4 in the LTX gate.
 *
 * W6 dropped off this list when it stopped being the calibrator: it and W7 are
 * now a saturation PROBE, and a probe whose whole content is "do these two
 * differ?" needs them on ONE shared seed, not three. That pays for W9's three. */
const SEED = 70117;
const EXTRA_SEEDS = [31337, 90210];
const EXTRA_ARMS = new Set(["W0", "W1", "W9"]);

/* ─────────────────────────── prompts ─────────────────────────────────────── */

/* The positive is the SHARED frozen prompt (gate_lib.mjs), byte-identical to the
 * one the LTX gate used, and `assertNoCameraWords` runs on it below. */
const POSITIVE = POSITIVE_PROMPT;

/* ⚠ THE NEGATIVE IS THE LTX GATE'S, NOT WAN'S VENDOR DEFAULT, AND THAT IS
 * DELIBERATE. The install's VACE blueprint ships a Chinese negative
 * ("过曝，静态，细节模糊不清，字幕，风格，作品，画作，画..."). Using it here would
 * mean the two gates differ in prompt text as well as in model and conditioning
 * path — three variables where the whole design is built on isolating one. The
 * negative's job in this experiment is to discourage a frozen shot and gray-clay
 * copying EQUALLY IN EVERY ARM, and it does that whatever language it is in.
 * Within a family the negative is a constant, so it cannot affect the W0-vs-W1
 * margin at all; across families nothing is comparable anyway. */
const NEGATIVE =
  config.video.engines.ltx.negative
  + ", static camera, still frame, flat gray, untextured, clay render, watermark, text";

/* ─────────────────────── graph structure knowledge ───────────────────────── */

/* Output arity per class, declared here because ComfyUI is deliberately not
 * running while graphs are built — and `--preflight` cross-checks every one
 * against /object_info when it can, so the table cannot quietly rot.
 *
 * The one that matters and is easy to get wrong:
 *   WanVaceToVideo   [0] positive, [1] negative, [2] latent, [3] trim_latent
 * FOUR outputs, not three (nodes_wan.py:305-310). Reading [2] as trim_latent
 * would hand KSampler an INT where a LATENT belongs.
 *
 * LoadVideo / GetVideoComponents / ImageFromBatch carry the values gate_run.mjs
 * verified against this rig's live /object_info: GetVideoComponents is 4 on
 * ComfyUI 0.33.0 (["images","audio","fps","bit_depth"], bit_depth APPENDED so
 * slots 0/1/2 kept their meanings). This graph reads slot 0 only. */
const OUT_SLOTS = {
  UNETLoader: 1, CLIPLoader: 1, VAELoader: 1, CLIPTextEncode: 1,
  ModelSamplingSD3: 1,
  LoadVideo: 1, GetVideoComponents: 4, ImageFromBatch: 1,
  EmptyImage: 1, ImageToMask: 1,
  WanVaceToVideo: 4,
  KSampler: 1, TrimVideoLatent: 1,
  VAEDecode: 1, CreateVideo: 1, SaveVideo: 1,
};
const OUTPUT_CLASSES = new Set(["SaveVideo", "SaveImage", "SaveAudio", "PreviewImage"]);

/* The chain that carries pixels into the conditioning node, in order:
 * LoadVideo -> GetVideoComponents -> ImageFromBatch -> WanVaceToVideo.control_video */
const PIXEL_SOURCES = new Set(["LoadVideo", "GetVideoComponents", "ImageFromBatch", "LoadImage"]);
const PIXEL_CHAIN = ["LoadVideo", "GetVideoComponents", "ImageFromBatch"];

/* The chain that carries the ALL-ZERO MASK into the conditioning node, for W9
 * only: EmptyImage -> ImageToMask -> WanVaceToVideo.control_masks. Deliberately
 * NOT in PIXEL_SOURCES: EmptyImage is a constant, it carries no information from
 * the clip and no frame of it could reach a sampler as content. (W0's no-pixel
 * proof is unaffected either way — W0 has neither node.) */
const MASK_CHAIN = ["EmptyImage", "ImageToMask"];

/* ──────────────────────────── the graph builder ──────────────────────────── */

/**
 * One WAN 2.1 VACE graph.
 *
 * Modelled on the install's own worked reference —
 * blueprints/"Video Inpainting (Wan2.1 VACE).json" — read as a graph and reduced
 * to the parts a plain control-video run needs. Dropped from it: the CausVid
 * LoRA (not installed, and it changes steps/cfg), the SAM3 segmentation node and
 * everything downstream of it (not installed; this run wants no mask), the three
 * ComfySwitchNodes that select between the CausVid and plain branches, the
 * ResizeImageMaskNode / ComfyMathExpression / GetImageSize sizing chain (the
 * size is frozen here, not derived from the clip), and the preview nodes.
 *
 * KEPT from it, because they are the reference's own choices and not guesses:
 * ModelSamplingSD3 shift 5, KSampler 20 / cfg 6 / uni_pc / simple / denoise 1,
 * the WanVaceToVideo -> KSampler -> TrimVideoLatent -> VAEDecode -> CreateVideo
 * -> SaveVideo spine, and CLIPLoader type "wan".
 *
 * ⚠ TrimVideoLatent IS A PROVEN NO-OP HERE and is kept anyway. `trim_latent` is
 * returned as 0 unless `reference_image` is supplied (nodes_wan.py:363-368), and
 * this run never supplies one — `validate()` asserts that. It stays because the
 * reference topology is the thing a future edit will diff against, and because
 * if anyone later adds a reference image the trim is already correct rather than
 * silently missing.
 *
 * ⚠ THERE IS NO ImageScale IN THE PIXEL CHAIN, unlike the LTX graph, and that is
 * on purpose. WanVaceToVideo resizes the control video itself with
 * common_upscale(..., width, height, "bilinear", "center") (nodes_wan.py:319).
 * At the frozen 1280x704 that call is an exact no-op — see the WHY 1280x704
 * block — so adding a resize node would insert a second, redundant resample
 * whose crop mode ("disabled" in the LTX graph, i.e. STRETCH) differs from the
 * node's own ("center", i.e. CROP). One resize, done by the node whose contract
 * we read, is the honest arrangement.
 *
 * ⚠ ImageFromBatch IS KEPT even though the node would truncate anyway
 * (`control_video[:length]`, nodes_wan.py:319). It makes "which 121 of the 144
 * source frames" answerable from the graph rather than from node internals, and
 * `validate()` checks batch_index + length against the probed frame count so the
 * ImageFromBatch clamp — which freezes on the last frame rather than raising —
 * cannot fire unnoticed.
 */
/* ⚠ THE ALL-ZERO MASK, AND WHY IT IS BUILT AT THE FULL 1280x704.
 *
 * `EmptyImage(1280, 704, batch_size=121, color=0)` is a batch of black frames
 * (nodes.py:1992-1998 splits `color` into r/g/b, and 0 is 0/0/0); `ImageToMask`
 * takes channel red (nodes_mask.py:148) giving a [121, 704, 1280] mask of exact
 * zeros. That is the shape WanVaceToVideo wants: ndim 3, one entry per frame.
 *
 * FULL SIZE, NOT A SMALL TILE THE NODE WOULD UPSCALE. A 16x16 EmptyImage would
 * cost ~93 KB instead of ~1.3 GB of CPU RAM and would still resolve to all
 * zeros (any resize of an all-zero tensor is all-zero). It is built at the
 * frozen size anyway so that NOTHING in the conditioning path is resampled —
 * the same property the WHY 1280x704 block establishes for control_video, and
 * the same property `validate()` asserts there. One rule, no exceptions, is
 * worth 1.3 GB of host RAM.
 *
 * THE FRAME COUNT IS LOAD-BEARING AND FAILS SILENTLY IF WRONG. nodes_wan.py:344
 * pads a short mask with `value=1.0` — so a 1-frame mask (what SolidMask would
 * give) becomes "preserve frame 0, REGENERATE the other 120", the exact opposite
 * instruction, with no error anywhere. batch_size is LENGTH and `validate()`
 * checks it. */
function buildGraph({ strength, control, masks, prefix, seed }) {
  const g = {
    1: { class_type: "UNETLoader",
         inputs: { unet_name: WEIGHTS.diffusion_models, weight_dtype: "default" } },
    2: { class_type: "CLIPLoader",
         inputs: { clip_name: WEIGHTS.text_encoders, type: "wan", device: "default" } },
    3: { class_type: "VAELoader", inputs: { vae_name: WEIGHTS.vae } },
    4: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: POSITIVE } },
    5: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: NEGATIVE } },
    6: { class_type: "ModelSamplingSD3", inputs: { model: ["1", 0], shift: SHIFT } },
    7: { class_type: "WanVaceToVideo",
         inputs: {
           positive: ["4", 0], negative: ["5", 0], vae: ["3", 0],
           width: WIDTH, height: HEIGHT, length: LENGTH, batch_size: 1,
           strength,
           /* control_video is added below, and ONLY for a guided arm. Absent, the
            * node substitutes torch.ones(length,H,W,3)*0.5 — a uniform mid-gray
            * plate with no structure. control_masks is supplied on ONE arm only
            * (W9, the degeneracy calibrator, all zeros); on every arm under test
            * it is absent, so the mask defaults to ones = full-frame generation.
            * reference_image is never supplied on any arm, so trim_latent is
            * provably 0. */
         } },
    8: { class_type: "KSampler",
         inputs: { model: ["6", 0], positive: ["7", 0], negative: ["7", 1],
                   latent_image: ["7", 2], seed, steps: STEPS, cfg: CFG,
                   sampler_name: SAMPLER, scheduler: SCHEDULER, denoise: 1.0 } },
    9: { class_type: "TrimVideoLatent", inputs: { samples: ["8", 0], trim_amount: ["7", 3] } },
    10: { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["3", 0] } },
    11: { class_type: "CreateVideo", inputs: { images: ["10", 0], fps: FPS } },
    12: { class_type: "SaveVideo",
          inputs: { video: ["11", 0], filename_prefix: prefix, format: "auto", codec: "auto" } },
  };

  if (control) {
    g[20] = { class_type: "LoadVideo", inputs: { file: STAGED } };
    g[21] = { class_type: "GetVideoComponents", inputs: { video: ["20", 0] } };
    g[22] = { class_type: "ImageFromBatch", inputs: { image: ["21", 0], batch_index: 0, length: LENGTH } };
    g[7].inputs.control_video = ["22", 0];
  }
  if (masks === "zeros") {
    g[30] = { class_type: "EmptyImage",
              inputs: { width: WIDTH, height: HEIGHT, batch_size: LENGTH, color: 0 } };
    g[31] = { class_type: "ImageToMask", inputs: { image: ["30", 0], channel: "red" } };
    g[7].inputs.control_masks = ["31", 0];
  } else if (masks) {
    throw new Error(`unknown mask kind ${JSON.stringify(masks)} — only "zeros" is built here`);
  }
  return g;
}

function buildArm(arm, seed) {
  const prefix = `vace/${arm.id}/${arm.id}_s${seed}`;
  const graph = buildGraph({
    strength: arm.strength,
    control: arm.kind !== "control",
    masks: arm.masks ?? null,
    prefix, seed,
  });
  return { graph, arm: arm.id, seed, prefix, strength: arm.strength, kind: arm.kind,
           masks: arm.masks ?? null };
}

/* ───────────────────────────── validation ────────────────────────────────── */

/**
 * What `WanVaceToVideo` will ACTUALLY build, replicated from nodes_wan.py so the
 * harness predicts the node's own arithmetic instead of discovering it after a
 * model load. Every one of these is a hard shape requirement inside the node:
 *
 *   :298  length  min 1, step 4          -> (length - 1) % 4 == 0
 *   :296  width   min 16, step 16        -> width  % 16 == 0
 *   :297  height  min 16, step 16        -> height % 16 == 0
 *   :317  latent_length = ((length-1)//4)+1
 *   :350  vae_stride = 8; mask.view(length, height//8, 8, width//8, 8)
 *         -> a .view(), so height % 8 and width % 8 must BOTH be 0 or it raises
 *   :370  latent = zeros([batch, 16, latent_length, height//8, width//8])
 *
 * And the token count the transformer actually sees, because it is the number
 * that decides whether this fits on the card: vace_patch_embedding is a Conv3d
 * with patch_size (1,2,2) over the /8 latent grid, so tokens =
 * latent_length * (height/16) * (width/16).
 */
function vaceShape(width, height, length) {
  const bad = [];
  if ((length - 1) % 4 !== 0) bad.push(`length ${length} is not 1 + 4k — WanVaceToVideo declares step 4 from min 1`);
  if (width % 16 !== 0) bad.push(`width ${width} is not a multiple of 16`);
  if (height % 16 !== 0) bad.push(`height ${height} is not a multiple of 16`);
  if (width % 8 !== 0 || height % 8 !== 0) {
    bad.push(`${width}x${height} is not divisible by the VAE stride 8 — nodes_wan.py:350 does a `
      + ".view(length, height//8, 8, width//8, 8) on the mask and would raise");
  }
  const latentLength = Math.floor((length - 1) / 4) + 1;
  const tokens = latentLength * (height / 16) * (width / 16);
  return { latentLength, latentH: height / 8, latentW: width / 8, tokens, problems: bad };
}

/** The off-native cost, printed rather than assumed. */
function tokenBudget() {
  const here = vaceShape(WIDTH, HEIGHT, LENGTH);
  const native = vaceShape(832, 480, 81);      // WAN 1.3B's common native
  return {
    here: here.tokens, native: native.tokens,
    ratio: here.tokens / native.tokens,
    // Full attention is quadratic in sequence length.
    attnRatio: (here.tokens / native.tokens) ** 2,
  };
}

/**
 * The strength, against the node's OWN declared bounds rather than an assumption.
 * `io.Float.Input("strength", default=1.0, min=0.0, max=1000.0, step=0.01)`.
 */
function strengthProblems(s, label) {
  const bad = [];
  if (typeof s !== "number" || !Number.isFinite(s)) { bad.push(`${label}: strength ${s} is not a finite number`); return bad; }
  if (s < 0.0 || s > 1000.0) bad.push(`${label}: strength ${s} is outside the node's declared range 0.0..1000.0`);
  if (Math.abs(Math.round(s * 100) - s * 100) > 1e-9) {
    bad.push(`${label}: strength ${s} is not representable on the node's 0.01 step`);
  }
  return bad;
}

/**
 * Follow `WanVaceToVideo.control_video` back to the file on disk, naming every
 * hop, and refuse anything that is not the exact expected chain.
 *
 * A "complete control_video path" is not "the input is a link". It is: the link
 * lands on ImageFromBatch, whose image lands on GetVideoComponents slot 0, whose
 * video lands on LoadVideo, whose `file` is the clip this run staged and hashed.
 * Any other shape — a stray LoadImage, a preview branch, a resize node someone
 * added, GetVideoComponents slot 2 (the source's own fps) mistaken for slot 0 —
 * is reported with the chain it actually found.
 */
function traceControlPath(g) {
  const vace = findByClass(g, "WanVaceToVideo")[0];
  if (!vace) return { ok: false, chain: [], why: "no WanVaceToVideo in the graph" };
  const link = g[vace].inputs.control_video;
  if (link === undefined) return { ok: false, chain: [], why: "control_video is not connected", absent: true };
  if (!isLink(link)) return { ok: false, chain: [], why: `control_video is a literal (${JSON.stringify(link)}), not a link` };

  const chain = [];
  let cur = link;
  for (let hop = 0; hop < 8 && isLink(cur); hop++) {
    const node = g[cur[0]];
    if (!node) return { ok: false, chain, why: `link -> node ${cur[0]} which does not exist` };
    chain.push({ id: cur[0], cls: node.class_type, slot: cur[1] });
    if (node.class_type === "LoadVideo") break;
    cur = node.inputs.image ?? node.inputs.video;
  }

  const shape = chain.map((c) => `${c.cls}[${c.slot}]`).join(" <- ");
  const want = PIXEL_CHAIN.slice().reverse();          // ImageFromBatch <- GetVideoComponents <- LoadVideo
  const got = chain.map((c) => c.cls);
  if (got.length !== want.length || got.some((c, i) => c !== want[i])) {
    return { ok: false, chain, shape,
             why: `control_video path is ${shape}, expected ${want.join("[0] <- ")}[0]` };
  }
  if (chain[1].slot !== 0) {
    return { ok: false, chain, shape,
             why: `control_video reads GetVideoComponents[${chain[1].slot}], not [0] — `
                  + "slot 1 is AUDIO, slot 2 is the source's own fps, slot 3 is bit_depth. "
                  + "Only slot 0 is the image batch." };
  }
  const ifb = g[chain[0].id].inputs;
  const file = g[chain[2].id].inputs.file;
  return { ok: true, chain, shape, batchIndex: ifb.batch_index, span: ifb.length, file };
}

/**
 * Follow `WanVaceToVideo.control_masks` back and prove it is the ALL-ZERO mask —
 * every widget, not just the shape of the chain.
 *
 * ⚠ THIS IS NOT DECORATION, BECAUSE EVERY WAY OF GETTING IT WRONG IS SILENT.
 *   • channel "green"/"blue" on a black image is still zeros — but on anything
 *     else it is not, so the channel is pinned;
 *   • `color` anything but 0 makes a mask of a CONSTANT NON-ZERO value, which is
 *     a partial blend of preserve and regenerate, not either;
 *   • `batch_size` under LENGTH makes nodes_wan.py:344 pad the remainder with
 *     value 1.0 — "preserve the first N frames, regenerate the rest" — and
 *     nothing raises;
 *   • a size other than WIDTHxHEIGHT makes the node RESIZE the mask, the one
 *     resample this run's whole aspect argument exists to avoid.
 * `fingerprint()` deliberately blanks control_masks so W9 can be certified
 * against W0 on everything else, which means this trace is the ONLY thing
 * standing behind the mask. It has to be exhaustive.
 */
function traceMaskPath(g) {
  const vace = findByClass(g, "WanVaceToVideo")[0];
  if (!vace) return { ok: false, why: "no WanVaceToVideo in the graph" };
  const link = g[vace].inputs.control_masks;
  if (link === undefined) return { ok: false, absent: true, why: "control_masks is not connected" };
  if (!isLink(link)) return { ok: false, why: `control_masks is a literal (${JSON.stringify(link)}), not a link` };

  const toMask = g[link[0]];
  if (!toMask || toMask.class_type !== "ImageToMask") {
    return { ok: false, why: `control_masks <- ${toMask?.class_type ?? `node ${link[0]} (missing)`}, expected ImageToMask` };
  }
  if (link[1] !== 0) return { ok: false, why: `control_masks reads ImageToMask[${link[1]}], not [0]` };
  const img = toMask.inputs.image;
  if (!isLink(img)) return { ok: false, why: `ImageToMask.image is ${JSON.stringify(img)}, not a link` };
  const empty = g[img[0]];
  if (!empty || empty.class_type !== "EmptyImage") {
    return { ok: false, why: `ImageToMask.image <- ${empty?.class_type ?? `node ${img[0]} (missing)`}, expected EmptyImage` };
  }

  const bad = [];
  const e = empty.inputs;
  if (toMask.inputs.channel !== "red") bad.push(`ImageToMask channel is "${toMask.inputs.channel}", not "red"`);
  if (e.color !== 0) bad.push(`EmptyImage color is ${e.color}, not 0 — the mask would be a constant NON-ZERO value, `
    + "which is neither 'preserve' (0) nor 'generate' (1) but a blend of both");
  if (e.batch_size !== LENGTH) bad.push(`EmptyImage batch_size is ${e.batch_size}, not ${LENGTH} — nodes_wan.py:344 `
    + `pads a short mask with value 1.0, so frames ${e.batch_size}..${LENGTH - 1} would be told to REGENERATE, silently`);
  if (e.width !== WIDTH || e.height !== HEIGHT) bad.push(`EmptyImage is ${e.width}x${e.height}, not ${WIDTH}x${HEIGHT} `
    + "— the node would resize the mask, the one resample this run's aspect argument exists to avoid");
  return { ok: bad.length === 0, problems: bad,
           shape: `ImageToMask[0] <- EmptyImage[0] (${e.width}x${e.height} x ${e.batch_size}, color ${e.color})` };
}

/** Structural check. Everything a live /prompt POST would reject, minus the GPU. */
function validate(g, label, expect = {}) {
  // Links, arities, exactly one output node, orphans, cycles — gate_lib.mjs.
  const bad = structuralProblems(g, OUT_SLOTS, OUTPUT_CLASSES);

  const vaceId = findByClass(g, "WanVaceToVideo")[0];
  if (!vaceId) {
    bad.push("no WanVaceToVideo — this graph conditions nothing and is not a VACE arm");
    return bad;
  }
  const v = g[vaceId].inputs;

  // The frozen numbers, as the graph itself states them.
  if (v.width !== WIDTH || v.height !== HEIGHT) bad.push(`WanVaceToVideo is ${v.width}x${v.height}, not ${WIDTH}x${HEIGHT}`);
  if (v.length !== LENGTH) bad.push(`WanVaceToVideo length ${v.length}, not ${LENGTH}`);
  if (v.batch_size !== 1) bad.push(`batch_size ${v.batch_size}, not 1 — SaveVideo would write several clips under one prefix`);
  const cv = g[findByClass(g, "CreateVideo")[0]]?.inputs;
  if (cv?.fps !== FPS) bad.push(`CreateVideo fps ${cv?.fps}, not ${FPS}`);
  bad.push(...vaceShape(v.width, v.height, v.length).problems.map((p) => `${label}: ${p}`));
  bad.push(...strengthProblems(v.strength, label));

  /* reference_image is never supplied, so trim_latent is 0 and TrimVideoLatent is
   * a no-op. If a future edit adds one, this fires — and it must, because
   * `latent_length += reference_image.shape[2]` (nodes_wan.py:365) changes the
   * decoded frame count and gate_score.py would resample it and mark the arm
   * INVALID with a resampling message that names the wrong cause. */
  if (v.reference_image !== undefined) {
    bad.push(`${label}: reference_image is connected. That makes trim_latent non-zero and changes the `
      + "decoded frame count away from 121; gate_score.py would resample and blame the render.");
  }
  /* ⚠ THE MASK IS ALLOWED ON EXACTLY ONE ARM, AND FORBIDDEN ON EVERY OTHER.
   *
   * mask 0 and mask 1 are OPPOSITE INSTRUCTIONS to the same node — 0 makes the
   * clip `inactive`, footage to PRESERVE; 1 makes it `reactive`, the signal to
   * generate over (nodes_wan.py:341-343). An arm under test that quietly picked
   * up a mask would be running the calibrator's experiment while the table said
   * it was running the sweep, and every number would look ordinary. So the
   * expectation is passed in per arm and checked both ways round. */
  const mtrace = traceMaskPath(g);
  if (expect.masks === "zeros") {
    if (mtrace.absent) {
      bad.push(`this arm is the ALL-ZERO-MASK calibrator but control_masks is not connected. `
        + "Without it the mask defaults to ones and the arm silently becomes another strength-1.00 "
        + "guided arm — a duplicate of W1 wearing the calibrator's name.");
    } else if (!mtrace.ok) {
      for (const p of (mtrace.problems ?? [mtrace.why])) bad.push(p);
    }
  } else if (!mtrace.absent) {
    bad.push(`control_masks is connected (${mtrace.shape ?? mtrace.why}). Every arm UNDER TEST `
      + "leaves the mask at ones (full-frame generation); a mask makes `inactive` carry real pixels "
      + "and inverts what the arm is being asked to do. Only the declared calibrator may have one.");
  }
  if (expect.masks !== "zeros") {
    for (const [id, n] of Object.entries(g)) {
      if (MASK_CHAIN.includes(n.class_type)) {
        bad.push(`${n.class_type} ${id} is in the graph but this arm has no mask — an orphan `
          + "mask source is one rewire away from being connected");
      }
    }
  }

  // The prompt pair is frozen and identical everywhere, control included.
  const texts = findByClass(g, "CLIPTextEncode").map((k) => g[k].inputs.text);
  if (!texts.includes(POSITIVE)) bad.push("the frozen positive prompt is not in this graph");
  if (!texts.includes(NEGATIVE)) bad.push("the frozen negative prompt is not in this graph");

  // The conditioning pair and the latent must all come from the SAME VACE node.
  const ks = g[findByClass(g, "KSampler")[0]]?.inputs ?? {};
  for (const [k, slot] of [["positive", 0], ["negative", 1], ["latent_image", 2]]) {
    const link = ks[k];
    if (!isLink(link) || link[0] !== vaceId || link[1] !== slot) {
      bad.push(`KSampler.${k} is ${JSON.stringify(link)}, expected WanVaceToVideo[${slot}]. `
        + "Slot 3 is trim_latent, an INT — reading it as the latent is the easy mistake here.");
    }
  }
  const trim = g[findByClass(g, "TrimVideoLatent")[0]]?.inputs?.trim_amount;
  if (!isLink(trim) || trim[0] !== vaceId || trim[1] !== 3) {
    bad.push(`TrimVideoLatent.trim_amount is ${JSON.stringify(trim)}, expected WanVaceToVideo[3]`);
  }

  const trace = traceControlPath(g);

  if (expect.noPixels) {
    /* ⚠ W0's PROOF THAT NO PIXEL CAN REACH THE SAMPLER. Said three ways, because
     * once is not a proof: (1) no pixel-source node exists anywhere in the graph;
     * (2) nothing upstream of the KSampler is a pixel source — an independent
     * walk, which catches a source wired somewhere the first check's enumeration
     * would still see but a future preview branch might hide; (3) the
     * WanVaceToVideo node has no control_video KEY AT ALL, which is what makes
     * the node substitute its own gray plate rather than reading anything. */
    bad.push(...pixelLeaks(g, PIXEL_SOURCES, "KSampler"));
    if (!trace.absent) {
      bad.push(`CONTROL LEAK: W0's WanVaceToVideo has a control_video input (${trace.shape ?? JSON.stringify(v.control_video)})`);
    }
  } else {
    if (!trace.ok) bad.push(`${label}: ${trace.why}`);
    else {
      if (trace.file !== STAGED) bad.push(`${label}: LoadVideo reads "${trace.file}", not the staged "${STAGED}"`);
      if (trace.span !== LENGTH) bad.push(`${label}: ImageFromBatch length ${trace.span}, not ${LENGTH}`);
      if (trace.batchIndex !== 0) bad.push(`${label}: ImageFromBatch batch_index ${trace.batchIndex}, not 0`);
      /* ImageFromBatch CLAMPS an out-of-range index to the last frame; it does not
       * raise. A short source therefore freezes on its final frame for the rest of
       * the clip and the run still reports success. */
      if (expect.sourceFrames !== undefined && expect.sourceFrames !== null) {
        const last = trace.batchIndex + trace.span - 1;
        if (last >= expect.sourceFrames) {
          bad.push(`${label}: the control reads source frames ${trace.batchIndex}..${last} but the clip has `
            + `${expect.sourceFrames} — ImageFromBatch would CLAMP and freeze on the last frame, silently`);
        }
      }
    }
  }
  return bad;
}

/**
 * "Only the conditioning varies" — as a check, not a hope.
 *
 * TIGHTER THAN THE LTX GATE'S, because the conditioning node survives. In
 * gate_run.mjs the whole guide apparatus had to be deleted before hashing, so
 * the fingerprint could only certify the sampler path around it. Here every arm
 * runs the SAME WanVaceToVideo with the SAME width/height/length/batch_size and
 * the same three upstream links; only `strength` and the presence of
 * `control_video` differ. So those two are blanked and EVERYTHING ELSE on the
 * node is hashed — including the four numbers that define the latent.
 *
 * `control_video` is blanked to a constant whether or not it is present, so W0
 * (no wire) and W1 (wire) fingerprint identically. That is the point: if W0 ever
 * stops matching the W arms, something other than the wire changed.
 *
 * ⚠ `control_masks` AND ITS TWO SOURCE NODES ARE BLANKED THE SAME WAY, and that
 * is a real weakening that has to be said out loud. It is what lets W9 — which
 * has two nodes W0 does not — be certified against the control on the sampler,
 * the model, the prompts and the four latent numbers. The cost is that the
 * fingerprint no longer says ANYTHING about the mask's contents: two different
 * masks fingerprint identically. `traceMaskPath()` is what stands behind the
 * mask instead, and it checks every widget on both nodes rather than the shape
 * of the chain. Do not weaken one without strengthening the other.
 */
function fingerprint(g) {
  const f = structuredClone(g);
  const drop = new Set(Object.keys(f).filter((k) => PIXEL_CHAIN.includes(f[k].class_type)
                                                 || MASK_CHAIN.includes(f[k].class_type)));
  for (const k of drop) delete f[k];
  for (const n of Object.values(f)) {
    if (n.class_type === "WanVaceToVideo") {
      n.inputs.strength = "<swept>";
      n.inputs.control_video = "<cond>";     // set even when absent, so W0 matches
      n.inputs.control_masks = "<cond>";     // ditto — see traceMaskPath()
    }
    if (n.class_type === "KSampler") n.inputs.seed = "<seed>";
    if (n.class_type === "SaveVideo") n.inputs.filename_prefix = "<prefix>";
    for (const [k, v] of Object.entries(n.inputs)) if (isLink(v) && drop.has(v[0])) n.inputs[k] = "<cond>";
  }
  return sortedJSON(f);
}

/**
 * The values `fingerprint()` certifies as constant, read out of a REAL built
 * graph so the manifest records WHAT was held constant and not merely THAT
 * something was. The published claim will be "W1 beat W0 by X and the only
 * difference was one wire"; every quantity that makes that true belongs next to
 * it, recoverable from the artefacts alone six months later.
 */
function certifiedValues(g) {
  const one = (cls) => { const k = findByClass(g, cls)[0]; return k ? g[k].inputs : {}; };
  const v = one("WanVaceToVideo"), ks = one("KSampler");
  const shape = vaceShape(v.width, v.height, v.length);
  return {
    dit: one("UNETLoader").unet_name,
    weightDtype: one("UNETLoader").weight_dtype,
    textEncoder: one("CLIPLoader").clip_name,
    clipType: one("CLIPLoader").type,
    vae: one("VAELoader").vae_name,
    shift: one("ModelSamplingSD3").shift,
    sampler: ks.sampler_name, scheduler: ks.scheduler,
    steps: ks.steps, cfg: ks.cfg, denoise: ks.denoise,
    vace: { width: v.width, height: v.height, length: v.length, batch_size: v.batch_size,
            /* control_masks is NOT certified constant any more — it is blanked in
             * fingerprint() so the masked calibrator can be certified against the
             * control on everything else. Recording this arm's own value here
             * would read as a guarantee about all of them. reference_image still
             * is constant: no arm supplies one. */
            control_masks: "<per-arm; absent on every arm under test, all-zero on the calibrator>",
            reference_image: v.reference_image ?? null },
    latent: { channels: 16, length: shape.latentLength, h: shape.latentH, w: shape.latentW },
    tokens: shape.tokens,
    createVideoFps: one("CreateVideo").fps,
  };
}

/* ────────────────────────────── the weights ──────────────────────────────── */

/**
 * Are the three WAN files actually there — and WHOLE?
 *
 * `videoReady()` cannot be used: there is no `wan` entry in
 * config.video.engines, so there is nothing for it to look up. And a plain
 * existsSync is not enough today, because the weights are being downloaded WHILE
 * this script is being written: a `.part` sibling means the real file is either
 * absent or half-written, and a half-written safetensors fails inside UNETLoader
 * with a header error that reads like a corrupt model rather than an incomplete
 * download.
 */
function wanReady() {
  const missing = [], partial = [];
  for (const [sub, file] of Object.entries(WEIGHTS)) {
    const p = path.join(config.rig, "ComfyUI", "models", sub, file);
    let ok = false;
    try { ok = statSync(p).size > 0; } catch { /* missing */ }
    if (!ok) missing.push(`${sub}/${file}`);
    if (existsSync(`${p}.part`)) partial.push(`${sub}/${file}.part (still downloading)`);
  }
  return { ready: missing.length === 0 && partial.length === 0, missing, partial };
}

/**
 * Read a safetensors HEADER and check the file against it.
 *
 * ⚠ THIS IS A STRONGER COMPLETENESS TEST THAN THE `.part` HEURISTIC, and it is
 * here because these weights were mid-download while this script was being
 * written. A downloader that streams straight to the final name (or that has
 * already removed its `.part`) leaves a file that exists, is enormous, and is
 * truncated. The header states every tensor's byte range, so the largest end
 * offset plus the 8-byte length prefix plus the header is EXACTLY the correct
 * file size — a one-line check that cannot be fooled.
 *
 * ⚠ AND IT VERIFIES THE SHAPES THIS HARNESS'S ARITHMETIC DEPENDS ON, against the
 * real checkpoint rather than against a reading of the Python:
 *
 *   vace_patch_embedding.weight  [dim, 96, 1, 2, 2]
 *        96 in-channels is the 32 (inactive|reactive latents, nodes_wan.py:345)
 *        plus 64 (the reshaped mask, model_base.py:1729) that extra_conds
 *        concatenates. If it were not 96, the control tensor this graph causes
 *        to be built would not fit the model at all.
 *        (1,2,2) is the patch size, which is what makes tokens =
 *        latent_length * (H/16) * (W/16) — the number tokenBudget() prints and
 *        the number the off-native decision was made on.
 *   patch_embedding.weight       [dim, 16, 1, 2, 2]
 *        16 in-channels is the latent depth WanVaceToVideo allocates
 *        (nodes_wan.py:370, `torch.zeros([batch_size, 16, ...])`).
 */
async function inspectSafetensors(p) {
  let fh;
  try {
    fh = await fsOpen(p, "r");
    const size = (await fh.stat()).size;
    const lenBuf = Buffer.alloc(8);
    await fh.read(lenBuf, 0, 8, 0);
    const hdrLen = Number(lenBuf.readBigUInt64LE(0));
    if (!(hdrLen > 0 && hdrLen < 100e6 && 8 + hdrLen <= size)) {
      return { ok: false, why: `header length ${hdrLen} is not sane for a ${size} B file — truncated or not safetensors` };
    }
    const hdrBuf = Buffer.alloc(hdrLen);
    await fh.read(hdrBuf, 0, hdrLen, 8);
    let hdr;
    try { hdr = JSON.parse(hdrBuf.toString("utf8")); }
    catch (e) { return { ok: false, why: `header is not JSON (${e.message}) — truncated or not safetensors` }; }

    let end = 0;
    const shapes = {};
    for (const [k, v] of Object.entries(hdr)) {
      if (k === "__metadata__") continue;
      if (Array.isArray(v?.data_offsets)) end = Math.max(end, v.data_offsets[1]);
      shapes[k.replace(/^model\.diffusion_model\./, "")] = v?.shape;
    }
    const want = 8 + hdrLen + end;
    if (want !== size) {
      return { ok: false, size, want,
               why: `INCOMPLETE — the header declares ${want} B but the file is ${size} B `
                    + `(${((size / want) * 100).toFixed(1)}% downloaded)` };
    }
    return { ok: true, size, tensors: Object.keys(shapes).length, shapes };
  } catch (e) {
    return { ok: false, why: e.message };
  } finally { await fh?.close(); }
}

const shapeEq = (a, b) => Array.isArray(a) && a.length === b.length && b.every((v, i) => v === null || a[i] === v);

/** The three weights, opened and checked — not merely counted. */
async function inspectWeights() {
  const out = [];
  for (const [sub, file] of Object.entries(WEIGHTS)) {
    const p = path.join(config.rig, "ComfyUI", "models", sub, file);
    if (!existsSync(p)) { out.push({ sub, file, ok: false, why: "not on disk" }); continue; }
    const r = await inspectSafetensors(p);
    const notes = [];
    if (r.ok && sub === "diffusion_models") {
      const vpe = r.shapes["vace_patch_embedding.weight"];
      const pe = r.shapes["patch_embedding.weight"];
      if (!vpe) notes.push("NO vace_patch_embedding — this is not a VACE checkpoint, and WanVaceToVideo's conditioning would have nowhere to go");
      else if (!shapeEq(vpe, [null, 96, 1, 2, 2])) notes.push(`vace_patch_embedding.weight is ${JSON.stringify(vpe)}, expected [dim, 96, 1, 2, 2] — 96 = 32 control latents + 64 mask channels, and (1,2,2) is what makes the token count ${vaceShape(WIDTH, HEIGHT, LENGTH).tokens}`);
      if (!pe) notes.push("NO patch_embedding");
      else if (!shapeEq(pe, [null, 16, 1, 2, 2])) notes.push(`patch_embedding.weight is ${JSON.stringify(pe)}, expected [dim, 16, 1, 2, 2] — 16 is the latent depth WanVaceToVideo allocates`);
      const nv = Object.keys(r.shapes).filter((k) => /^vace_blocks\.\d+\./.test(k))
        .reduce((m, k) => Math.max(m, Number(k.split(".")[1]) + 1), 0);
      const nb = Object.keys(r.shapes).filter((k) => /^blocks\.\d+\./.test(k))
        .reduce((m, k) => Math.max(m, Number(k.split(".")[1]) + 1), 0);
      if (vpe) notes.push(`dim ${vpe[0]}, ${nb} blocks, ${nv} vace_blocks`);
    }
    out.push({ sub, file, path: p, ...r, notes });
  }
  return out;
}

/* ──────────────────── engine identity + dispatch (shared) ────────────────── */

const engineIdentity = () => engineIdentityOf(BASE, {
  inputDir: INPUT, outputDir: config.outputDir, port: config.comfy.port });

/* ⚠ A LONGER DEADLINE THAN THE LTX GATE'S 20 MINUTES, AND IT IS NOT CAUTION.
 * This runs at 3.33x WAN 1.3B's native token count (see tokenBudget()), and full
 * attention is quadratic, so a per-arm time an order of magnitude above the LTX
 * gate's measured 130-235 s is the expected case rather than a hang. A deadline
 * set to the wrong scale would abandon healthy jobs and record them as harness
 * failures — which exit 1 and read as "the run is broken". 45 minutes. */
const dispatch = makeDispatcher(BASE, { deadlineMs: 45 * 60 * 1000 });

/* ─────────────────────────────── main ────────────────────────────────────── */

console.log(`vace_run — ${RUN ? "DISPATCH" : PREFLIGHT ? "PREFLIGHT" : "DRY RUN"}   ${BASE}`);
console.log(`  WAN 2.1 VACE 1.3B   ${WIDTH}x${HEIGHT}  ${FPS}.000 fps  ${LENGTH} frames  `
  + `latent ${LATENT_LENGTH}x${HEIGHT / 8}x${WIDTH / 8}  seed ${SEED}`
  + `${EXTRA_SEEDS.length ? ` (+${EXTRA_SEEDS.join(",")} on ${[...EXTRA_ARMS].join("/")})` : ""}`);

/* Grouped by hand. toLocaleString() rendered 109120 as "109.120" under this
 * rig's locale, which reads as a decimal and made an 11x attention cost look
 * like a rounding note. */
const group = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const tb = tokenBudget();
console.log(`  tokens        ${group(tb.here)} (${LATENT_LENGTH} x ${HEIGHT / 16} x ${WIDTH / 16}) `
  + `vs ${group(tb.native)} at WAN's native 832x480x81 — ${tb.ratio.toFixed(2)}x the sequence, `
  + `~${tb.attnRatio.toFixed(0)}x the attention. OFF NATIVE ON PURPOSE (see WHY 1280x704).\n`);

assertNoCameraWords(POSITIVE);
console.log("  prompt guard  ok — no camera-move words in the positive (shared with gate_run.mjs)");
/* The arm-set invariant, before anything is built. It is not a per-graph
 * property, so validate() structurally cannot see it. */
for (const b of ARM_SET_PROBLEMS) console.log(`  ARM SET FAIL  ${b}`);
console.log(`  arm set       ${ARM_SET_PROBLEMS.length ? "BROKEN — see above"
  : `ok — ${ARMS.length} arms, control ${CONTROL_ARM}, calibrator ${DEGENERATE_ARM} (the only masked arm), `
    + `disqualified ${[...DISQUALIFIED].join("/")}`}\n`);

if (PREFLIGHT) {
  const wr = wanReady();
  console.log(`  weights       ${wr.ready ? "present" : "NOT READY"}`);
  for (const m of wr.missing) console.log(`                MISSING  ${m}`);
  for (const p of wr.partial) console.log(`                PARTIAL  ${p}`);
  /* ⚠ AND OPENED, not merely counted. See inspectSafetensors(): the header's own
   * byte ranges give an exact expected file size, and the two patch-embedding
   * shapes are what this harness's token arithmetic and control-tensor layout
   * depend on. Checking them here is the difference between "the file is there"
   * and "the file is the model this graph was built for". */
  for (const r of await inspectWeights()) {
    console.log(`    ${r.ok ? "ok  " : "FAIL"}  ${r.sub}/${r.file}`
      + (r.ok ? `  ${(r.size / 1e9).toFixed(2)} GB, ${r.tensors} tensors, header/size consistent` : `  ${r.why}`));
    for (const n of r.notes ?? []) console.log(`          ${n}`);
  }
  const eng = await engineIdentity();
  console.log(`  ${BASE}  ${eng.up ? `answering (ComfyUI ${eng.version})` : `not answering (${eng.why})`}`);
  if (eng.up) {
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

      /* And the strength bounds, against the server's own schema rather than
       * against this file's reading of nodes_wan.py. If the installed node ever
       * declares a different range, the sweep below is aimed at the wrong axis
       * and the whole run means nothing. */
      const sw = info.WanVaceToVideo?.input?.required?.strength?.[1];
      if (sw) {
        console.log(`  strength      server says min ${sw.min} max ${sw.max} step ${sw.step} default ${sw.default}`
          + `${(sw.min === 0 && sw.max === 1000) ? "   ok — matches nodes_wan.py:301" : "   <- DIFFERS from nodes_wan.py:301 (0..1000)"}`);
      }

      /* ⚠ AND THE INPUT NAMES, WHICH THE ARITY TABLE CANNOT SEE. A misspelled or
       * renamed input key is not a link error and not an arity error — it passes
       * every structural check in this file and is rejected only by the live
       * /prompt POST, one arm at a time, after the model has loaded. Both graph
       * shapes are built here and every key is compared against the node's own
       * declared required+optional set, plus a check that no required input
       * WITHOUT a default has been left out. */
      const schemaBad = [];
      for (const [what, gph] of [["W0 (control)", buildGraph({ strength: 1, control: false, prefix: "x", seed: 1 })],
                                 ["W1 (wired)", buildGraph({ strength: 1, control: true, prefix: "x", seed: 1 })],
                                 /* W9's two extra nodes go through the same check: an undeclared or
                                  * renamed input on EmptyImage/ImageToMask is not a link error and not
                                  * an arity error, and would be caught only by the live POST. */
                                 ["W9 (masked)", buildGraph({ strength: 1, control: true, masks: "zeros", prefix: "x", seed: 1 })]]) {
        for (const [nid, node] of Object.entries(gph)) {
          const def = info[node.class_type];
          if (!def) { schemaBad.push(`${what}: ${node.class_type} does not exist on the server`); continue; }
          const req = Object.keys(def.input?.required ?? {});
          const opt = Object.keys(def.input?.optional ?? {});
          const used = Object.keys(node.inputs);
          const unknown = used.filter((k) => !req.includes(k) && !opt.includes(k));
          if (unknown.length) schemaBad.push(`${what}: ${node.class_type}(${nid}) uses undeclared input(s) ${unknown.join(", ")}`);
          const missing = req.filter((k) => !used.includes(k)
            && !(typeof def.input.required[k]?.at(-1) === "object" && "default" in def.input.required[k].at(-1)));
          if (missing.length) schemaBad.push(`${what}: ${node.class_type}(${nid}) omits required input(s) with no default: ${missing.join(", ")}`);
        }
      }
      console.log(`  input names   ${schemaBad.length ? "WRONG" : "every input on every node is declared by /object_info"}`);
      for (const b of schemaBad) console.log(`                ${b}`);
    } catch (e) { console.log(`  arity table   could not check: ${e.message}`); }
  }
  const stagedPre = path.join(INPUT, STAGED);
  console.log(`  clip          ${existsSync(stagedPre) ? stagedPre : `NOT STAGED (${stagedPre})`}`);
  process.exit(0);
}

/* Stage the clip, and then PROVE the staged file is the one this run put there.
 *
 * The three numbers check the clip's SHAPE, not its IDENTITY. Any 1280x704 /
 * 24-1 / >=121-frame file passes them — including last week's block render, or
 * the synthetic gray placeholder a previous session had to delete by hand from
 * exactly this filename. Fifteen renders against the wrong source produce a
 * complete, plausible, internally consistent set of numbers that are about a
 * different clip, and nothing downstream can detect it.
 *
 * ⚠ AND HERE IT IS SHARPER THAN IN THE LTX GATE. gate_score.py's ground truth
 * (gate_block_flow.npz) is analytic for ONE render of the blocking scene, and
 * `source_consistency()` compares that clip's sha256 across every artefact. If
 * this run conditions on a different blockout than the anchor was measured on,
 * the report refuses to reach a verdict — which is correct, and expensive. */
const CLIP_SRC = val("--clip") || [
  path.join(process.cwd(), "gate", STAGED),
  path.join(config.outputDir, "gate", STAGED),
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
  clipProblems = assertThreeNumbers(probe, {
    width: WIDTH, height: HEIGHT, fps: FPS, minFrames: MIN_SOURCE_FRAMES,
    why: {
      /* Each hazard, in THIS graph's node terms — they are not the LTX ones.  */
      size: 'WanVaceToVideo resizes with common_upscale(..., "bilinear", "center") and '
        + '"center" CROPS (comfy/utils.py:1075). Only at exactly this size is that a no-op; '
        + 'anything else silently changes the field of view. gate_score.py:654 also hard-refuses '
        + 'any arm clip that is not this size',
      fps: "CreateVideo is pinned to 24 and the source's own rate is never read, while the "
        + "control indexes frames by ABSOLUTE number — a 30 fps source pulls every control frame "
        + "~25% early and the error compounds",
      length: "ImageFromBatch CLAMPS past the end and freezes silently on the last frame",
    },
  });
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
      + `                clip's shape, not its identity. Pass --clip <file> to state what this run is\n`
      + `                conditioning on — and it must be the SAME blockout gate_block_flow.npz\n`
      + `                describes, or gate_score.py's source_consistency check will block the verdict.`);
  }
}
for (const p of clipProblems) console.log(`  CLIP FAIL     ${p}`);
console.log("");

/* ─────────────────── the run stamp, and what it is FOR ───────────────────
 *
 * Not provenance for its own sake. gate_score.py quotes `_graphs/<arm>_s*.json`
 * as the operating point of the render it is scoring, and derives the
 * zero-strength bar from it. Two invocations may therefore share a graph
 * directory ONLY IF a graph built by either would be the same graph — which is
 * true exactly when nothing that shapes a graph has moved between them. This
 * hashes all of it. A difference is refused rather than merged, because a
 * merged directory is SILENT: every file in it still parses and still names the
 * arm it belongs to. */
const runStamp = () => {
  const fields = {
    width: WIDTH, height: HEIGHT, fps: FPS, length: LENGTH,
    latentLength: LATENT_LENGTH,
    positive: POSITIVE, negative: NEGATIVE,
    seed: SEED, extraSeeds: EXTRA_SEEDS, extraArms: [...EXTRA_ARMS].sort(),
    /* THE WHOLE ARM TABLE, not just the arms this invocation builds. An edited
     * strength on an arm --only is skipping still changes what a graph for that
     * arm WOULD be, which is exactly the stale-operating-point hazard. */
    arms: ARMS.map((a) => ({ id: a.id, kind: a.kind, strength: a.strength,
                             masks: a.masks ?? null })),
    control: CONTROL_ARM, degenerate: DEGENERATE_ARM,
    disqualified: [...DISQUALIFIED].sort(),
    weights: WEIGHTS,
    clip: stagedFacts?.sha256 ?? null,
  };
  return { hash: createHash("sha256").update(sortedJSON(fields)).digest("hex"), fields };
};
const STAMP = runStamp();
const STAMP_FILE = path.join(GRAPH_DIR, "_run.json");

if (FORCE) {
  await rm(GRAPH_DIR, { recursive: true, force: true });
  console.log(`  --force       wiped ${GRAPH_DIR} — every selected arm will be rebuilt and re-rendered`);
}
await mkdir(GRAPH_DIR, { recursive: true });

let stampProblem = null;
const stampWasOnDisk = existsSync(STAMP_FILE);
if (stampWasOnDisk) {
  let prev = null;
  try { prev = JSON.parse(await readFile(STAMP_FILE, "utf8")); }
  catch (e) {
    stampProblem = `${STAMP_FILE} is unreadable (${e.message}), so the graphs already in that\n`
      + `                directory cannot be proven to belong to this run. Re-run with --force.`;
  }
  if (prev && prev.stamp !== STAMP.hash) {
    const diffs = [];
    for (const k of new Set([...Object.keys(prev.fields || {}), ...Object.keys(STAMP.fields)])) {
      const a = JSON.stringify((prev.fields || {})[k]), b = JSON.stringify(STAMP.fields[k]);
      if (a !== b) diffs.push(`                  ${k}\n                    was ${String(a).slice(0, 160)}\n                    now ${String(b).slice(0, 160)}`);
    }
    stampProblem =
      `${GRAPH_DIR} holds graphs from a DIFFERENT run\n`
      + `                (stamp ${String(prev.stamp).slice(0, 12)}… vs this run's ${STAMP.hash.slice(0, 12)}…), and nothing was written.\n`
      + `                Refusing to mix them: gate_score.py quotes these files as the operating point of\n`
      + `                the renders it scores, so one directory holding two runs' graphs would caption\n`
      + `                one run's output with another run's conditions — and every file in it would\n`
      + `                still parse and still name the right arm.\n`
      + `                WHAT MOVED:\n${diffs.join("\n")}\n`
      + `                Keep the existing stage and score it, or re-run with --force to wipe and rebuild.`;
  }
}
if (stampProblem) console.log(`  STAMP FAIL    ${stampProblem}`);

/* ─────────────────────── has this arm already rendered? ───────────────────
 *
 * ⚠ THE PREFIX IS A FILENAME PREFIX, NOT A DIRECTORY — the trap film_run.mjs
 * hit and wrote down. `vace/W0/W0_s70117` puts the file at
 * <output>/vace/W0/W0_s70117_00001_.mp4, so a resume check that looked for a
 * directory named after the job would find nothing, every arm would look
 * unrendered, and the resume would appear to work while doing nothing. It looks
 * for the file, by prefix, in the arm's own directory — which is also the
 * directory gate_score.py globs `*.mp4` out of. */
const rendered = async (armId, seed) => {
  const dir = path.join(VACE_OUT, armId);
  try {
    return (await readdir(dir)).some((f) => f.startsWith(`${armId}_s${seed}_`) && f.endsWith(".mp4"));
  } catch { return false; }        // no directory yet = nothing rendered
};

const jobs = [];
const rows = [];
const skipped = [];
const reconstructedGraphs = [];   // already rendered, but no graph was on disk
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

    const bad = validate(job.graph, `${arm.id} s${seed}`, {
      noPixels: arm.kind === "control",
      masks: arm.masks ?? null,
      sourceFrames: probe?.frames ?? null,
    });

    /* ⚠ THE BASELINE IS THE CONTROL, not whichever arm happened to be built
     * first. `--only W2,W3` must not certify W2 against W3 and then print
     * "identical across all arms" — a guarantee about a subset, worded as a
     * guarantee about the experiment. The claim under test is W0-vs-W1, so if W0
     * was not built the fingerprint certifies nothing about it and must say so. */
    const fp = fingerprint(job.graph);
    fingerprints.push({ id: `${arm.id} s${seed}`, arm: arm.id, fp });
    if (arm.kind === "control" && ref === null) ref = { id: `${arm.id} s${seed}`, fp, control: true };
    if (ref === null && alt === null) alt = { id: `${arm.id} s${seed}`, fp, control: false };
    const base = ref ?? alt;
    if (base && fp !== base.fp) {
      bad.push(`sampler path DIFFERS from ${base.id}`
        + `${base.control ? " (the CONTROL)" : ` (first built — the control ${CONTROL_ARM} is not in this run)`}`
        + " — only `strength` and the presence of the control_video wire may vary");
    }

    if (bad.length) { problems += bad.length; for (const b of bad) console.log(`  INVALID       ${arm.id} s${seed}: ${b}`); }

    /* RESUME. Built, validated and fingerprinted either way — the sampler-path
     * certification is a claim about the whole run and must not shrink to the
     * part being re-rendered — but not re-dispatched. */
    const done = !FORCE && await rendered(arm.id, seed);
    if (done) skipped.push(`${arm.id} s${seed}`);

    /* THE GRAPH ON DISK IS THE RECORD OF WHAT WAS DISPATCHED, so it is never
     * overwritten with different bytes. Under one stamp a rebuild is identical;
     * a difference is a hole in the stamp and is reported rather than applied.
     * Identical bytes are left alone — the file keeps its mtime, which is the
     * only thing on disk that says which stage produced it. */
    const gpath = path.join(GRAPH_DIR, `${arm.id}_s${seed}.json`);
    const text = JSON.stringify(job.graph, null, 1);
    if (stampProblem) {
      /* nothing is written into a directory this run has refused to mix with */
    } else if (existsSync(gpath)) {
      if (await readFile(gpath, "utf8") !== text) {
        console.log(`  GRAPH CONFLICT ${arm.id} s${seed}: ${gpath}`);
        console.log(`                differs from the graph this run builds, and it is the record of what was`);
        console.log(`                dispatched for the ${arm.id} s${seed} render already under ${VACE_OUT}.`);
        console.log(`                Refusing to overwrite it. Re-run with --force to rebuild and re-render.`);
        problems++;
      }
    } else {
      await writeFile(gpath, text);
      /* ⚠ A graph written for an arm that is ALREADY RENDERED is not the file
       * the dispatch wrote — it is a rebuild from the CURRENT arm table, and
       * gate_score.py will quote it as that render's operating point. Under a
       * matching stamp the two are identical by construction, which is the
       * whole point of the stamp; with no stamp on disk at all there is nothing
       * proving it. Either way it is named rather than done quietly. */
      if (done) reconstructedGraphs.push(`${arm.id} s${seed}`);
    }
    jobs.push({ ...job, valid: bad.length === 0, skip: done });

    if (seed === SEED) {
      /* The row is read back off the BUILT graph, never typed — a table pasted
       * into a report must not be able to contradict the graph it describes. */
      const t = traceControlPath(job.graph);
      const m = traceMaskPath(job.graph);
      rows.push({
        id: arm.id,
        cond: t.absent ? "text only (gray plate)" : `control_video @ ${arm.strength.toFixed(2)}`,
        strength: arm.strength,
        wired: !t.absent,
        /* Read back off the BUILT graph like everything else in this row: what
         * the mask IS, never what the arm table meant it to be. "ones" is the
         * node's default when nothing is wired (nodes_wan.py:337). */
        mask: m.absent ? "ones" : (m.ok ? "ZEROS" : "MALFORMED"),
        chain: t.absent ? "-" : (t.shape ?? "MALFORMED"),
        span: t.absent ? "-" : `${t.batchIndex}..${t.batchIndex + (t.span ?? 0) - 1}`,
        nodes: Object.keys(job.graph).length,
        seeds: seeds.length,
        disqualified: DISQUALIFIED.has(arm.id),
        note: (DISQUALIFIED.has(arm.id) ? "DISQUALIFIED — " : "") + arm.note,
      });
    }
  }
}

const w = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(`\n  arm  conditioning              strength  wired  mask   nodes  source frames  seeds  note`);
console.log(`  ---  ------------------------  --------  -----  -----  -----  -------------  -----  ----`);
for (const r of rows) {
  console.log(`  ${w(r.id, 3)}  ${w(r.cond, 24)}  ${w(r.strength.toFixed(2), 8)}  ${w(r.wired ? "yes" : "NO", 5)}  ${w(r.mask, 5)}  ${w(r.nodes, 5)}  ${w(r.span, 13)}  ${w(r.seeds, 5)}  ${r.note}`);
}
console.log(`\n  mask = WanVaceToVideo.control_masks, read back off the built graph. "ones" is the node's`);
console.log(`  default when nothing is wired (nodes_wan.py:337) and means FULL-FRAME GENERATION: the clip`);
console.log(`  is \`reactive\`. "ZEROS" is the opposite instruction — the clip becomes \`inactive\`, footage to`);
console.log(`  PRESERVE — and appears on the degeneracy calibrator ONLY, which is disqualified from passing.`);
const toDispatch = jobs.filter((j) => !j.skip);
console.log(`\n  ${toDispatch.length} dispatch(es) over ${rows.length} arms; graphs in ${GRAPH_DIR}`);
if (skipped.length) {
  console.log(`  resume        ${skipped.length} already rendered, SKIPPED: ${skipped.join(", ")}`);
  console.log(`                Their graphs are left exactly as the run that produced those renders wrote`);
  console.log(`                them — that file is what gate_score.py quotes as their operating point.`);
  console.log(`                Add --force to rebuild and re-render them.`);
}
if (reconstructedGraphs.length) {
  console.log(`  REBUILT GRAPH ${reconstructedGraphs.join(", ")}`);
  console.log(`                is/are already rendered but had NO graph on disk, so one has been written from`);
  console.log(`                the CURRENT arm table. gate_score.py will quote it as that render's operating`);
  console.log(`                point, and it is NOT the file the dispatch wrote.`);
  if (stampWasOnDisk) {
    console.log(`                The run stamp already in this directory matches, so the rebuild is identical`);
    console.log(`                to what that dispatch built — which is exactly what the stamp is for.`);
  } else {
    console.log(`                THIS DIRECTORY CARRIED NO RUN STAMP, so nothing proves the rebuild matches`);
    console.log(`                what produced those renders. If they came from a different arm table, the`);
    console.log(`                operating point printed for them will be wrong — --force and re-render.`);
  }
}

/* The stamp goes down once there are graphs to stamp, and it records which files
 * it covers so a later invocation can say what it is being asked to mix with. */
if (!stampProblem) {
  let covered = [];
  try { covered = (await readdir(GRAPH_DIR)).filter((f) => f.endsWith(".json") && f !== "_run.json").sort(); }
  catch { /* nothing there yet */ }
  await writeFile(STAMP_FILE, JSON.stringify({
    kind: "graph-run-stamp",
    stamp: STAMP.hash,
    fields: STAMP.fields,
    graphs: covered,
    written_by: "scripts/vace_run.mjs",
    mode: RUN ? "dispatch" : "dry",
    at: new Date().toISOString(),
  }, null, 1));
  console.log(`  stamp         ${STAMP.hash.slice(0, 12)}… over ${covered.length} graph(s) -> ${STAMP_FILE}`);
  console.log(`                A later invocation whose frozen conditions differ is REFUSED rather than`);
  console.log(`                allowed to mix its graphs in with these.`);
}

/* The coverage claim goes on the artefact, and it describes the arms ACTUALLY
 * BUILT, so `--only` cannot produce a coverage sentence wider than the run. */
/* ⚠ THE SWEPT BAND IS THE ARMS UNDER TEST, NOT EVERY ARM BUILT. The
 * disqualified ones cannot support a claim — that is what disqualified means —
 * so folding W6 (16.00) and W7 (64.00) into this range would advertise a sweep
 * to 64 that no publishable number came from. They are listed separately, by
 * name and by job. */
const tested = rows.filter((r) => r.wired && !r.disqualified);
const swept = tested.map((r) => r.strength).sort((a, b) => a - b);
const nulls = tested.filter((r) => r.strength === 0).map((r) => r.id);
const gridExtent = {
  strengths: swept,
  arms_in_the_band: tested.map((r) => r.id),
  /* W8 is IN the band -- 0.00 brackets it from below by construction -- but it
   * cannot pass either: gate_score.py bars any arm at strength 0.00 off the
   * dispatched graph. "In the sweep" and "may be the answer" are two different
   * things and the artefact has to say both. */
  zero_strength_nulls: nulls,
  disqualified: rows.filter((r) => r.disqualified)
    .map((r) => `${r.id} @ ${r.strength.toFixed(2)}, mask ${r.mask} — ${r.note}`),
  node_range: [0.0, 1000.0],
  spacing: "logarithmic around the node's trained default of 1.00 (x2 through the plausible band, x4 beyond)",
  reads_as: "a negative licenses no claim outside this box, and the box is a tiny slice of the declared 0..1000",
};
console.log("  grid extent   " + (swept.length
  ? `strength ${swept[0].toFixed(2)}–${swept.at(-1).toFixed(2)} over ${swept.length} wired arms `
    + `(${tested.map((r) => r.id).join(",")}), log-spaced about the node's trained default 1.00. The node `
    + `declares 0..1000, so this samples a narrow band on purpose — a NEGATIVE licenses no claim outside it.`
  : "no wired arm in the band was built — this run establishes nothing about conditioning"));
if (nulls.length) {
  console.log(`                ${nulls.join(",")} is IN that band (0.00 brackets it from below by construction) but`);
  console.log(`                MAY NOT PASS: gate_score.py bars any arm at strength 0.00 off the dispatched graph.`);
}
for (const d of gridExtent.disqualified) console.log(`                not part of that band: ${d}`);

const distinct = new Set(fingerprints.map((f) => f.fp));
const armsBuilt = [...new Set(fingerprints.map((f) => f.arm))];
console.log("  fingerprint   " + (
  !fingerprints.length ? "nothing built"
    : ref
      ? (distinct.size === 1
        ? `identical across ${fingerprints.length} dispatches, baseline = the CONTROL ${ref.id}`
        : `NOT PROVEN — ${distinct.size} distinct sampler paths, see the failures above`)
      : `NOT CERTIFIED AGAINST THE CONTROL — ${CONTROL_ARM} is not in this run (--only ${ONLY.join(",")}). `
        + (distinct.size === 1
          ? `${armsBuilt.join("/")} match EACH OTHER and nothing else.`
          : `and ${armsBuilt.join("/")} do not even match each other.`)));

console.log(`\n  SCOPE  ${SCOPE.path_tested}.`);
console.log(`         ${SCOPE.what_is_actually_different_from_ltx}`);
console.log(`         A negative means: ${SCOPE.a_negative_means}.`);
console.log(`         ${SCOPE.cross_family}`);

/* ⚠ THE CLIP PROBLEMS COUNT TOWARDS THE EXIT CODE. The operational shape is "run
 * dry, confirm clean, then --run", and a green exit with a CLIP FAIL line buried
 * mid-output is exactly how a wrong-rate source reaches fifteen renders. */
problems += clipProblems.length;
problems += ARM_SET_PROBLEMS.length;
if (stampProblem) problems++;

const wr = wanReady();
if (!wr.ready) {
  console.log(`\n  WEIGHTS       NOT READY — ${[...wr.missing.map((m) => `missing ${m}`), ...wr.partial].join("; ")}`);
  console.log(`                This is NOT a dry-run failure: the graphs above are built and validated`);
  console.log(`                without them. It blocks --run only.`);
} else {
  console.log(`\n  weights       all three present under ${path.join(config.rig, "ComfyUI", "models")}`);
}

/* ⚠⚠ THE SCORER HAND-OFF, WRITTEN AS A FILE RATHER THAN REMEMBERED. ⚠⚠
 *
 * gate_score.py's criterion (2) is "CMA >= <control> + margin" and its default
 * control is A0 — an LTX arm. Scoring a W arm against A0 would compare two
 * MODELS while claiming to compare two conditioning paths, and it would look
 * completely normal in the output. So this run declares its own control in a
 * file that gate_score.py reads and obeys, in its own root:
 *
 *   gate_score.py --root <this root> --report
 *
 * needs no flags at all and cannot pick the wrong baseline. A `--control` flag
 * that disagrees with this file is a hard error there, not a silent override. */
const CONTROLS = path.join(VACE_OUT, "gate_controls.json");
async function writeControls() {
  await mkdir(VACE_OUT, { recursive: true });
  await writeFile(CONTROLS, JSON.stringify({
    kind: "controls",
    family: "W",
    family_label: "WAN 2.1 VACE 1.3B — scaled additive residual (WanVaceToVideo)",
    model: WEIGHTS.diffusion_models,
    control: CONTROL_ARM,
    degenerate: DEGENERATE_ARM,
    /* ⚠ READ AND OBEYED, not merely written. gate_score.py's resolve_controls()
     * excludes every id here from `passers`, and separately bars any arm whose
     * strength is 0.00 straight off the dispatched graph. Before that it barred
     * only the degenerate arm, which left W8 — the zero-strength null — eligible
     * to be declared GREEN. */
    disqualified: [...DISQUALIFIED],
    /* `strength` and `masks` per arm, because the scorer derives the
     * zero-strength bar from them when a graph is missing, and because the mask
     * is half of what an arm's operating point MEANS. */
    arms: ARMS.map((a) => ({ id: a.id, strength: a.strength, wired: a.kind !== "control",
                             masks: a.masks ?? null, note: a.note })),
    degenerate_kind: "control_masks all zeros at the trained strength 1.00",
    degenerate_why:
      "degenerate by TRAINED BEHAVIOUR, not by out-of-range gain. mask 0 makes `inactive` the clip "
      + "and `reactive` a constant (nodes_wan.py:341-343) — VACE's own vocabulary for 'preserve this "
      + "footage', the polarity ComfyUI's outpainting template uses. A large `strength` cannot "
      + "substitute: every consumer of x LayerNorms it and the VACE stream is computed from x_orig, "
      + "so the output converges to a fixed limit rather than to the control clip "
      + "(scripts/vace_saturation.py). W6/W7 remain as a probe of exactly that prediction.",
    scope: SCOPE,
    why: "criterion (2)'s baseline for these arms is a WAN arm, never A0. A0 is LTX; a WAN arm "
       + "beating an LTX control is a MODEL comparison wearing a conditioning comparison's clothes.",
    written_by: "scripts/vace_run.mjs",
    at: new Date().toISOString(),
  }, null, 1));
}
await writeControls();
console.log(`\n  scorer        wrote ${CONTROLS}`);
console.log(`                control = ${CONTROL_ARM} (criterion 2), degenerate = ${DEGENERATE_ARM} (criterion 5), family = W`);
console.log(`                may not pass: ${[...DISQUALIFIED].join(", ")} (declared) + any arm at strength 0.00 (derived) = W8`);
console.log(`                score with:  python scripts/gate_score.py --root "${VACE_OUT}" --report \\`);
console.log(`                               --anchor "${path.join(config.outputDir, "gate", "gate_ceiling.json")}"`);
console.log(`                (the anchor is a property of the BLOCKING CLIP and the metric, not of the`);
console.log(`                 model, so the LTX run's --ceiling applies here — and gate_score.py's`);
console.log(`                 source_consistency check proves it was measured on this same blockout.)`);

if (problems) {
  if (clipProblems.length) {
    console.log(`\n  THE SOURCE CLIP DOES NOT MEET THE THREE NUMBERS — see the CLIP FAIL line(s) above.`);
  }
  console.log(`\n  ${problems} problem(s). Nothing was dispatched.`);
  process.exit(1);
}
if (!RUN) {
  console.log(`\n  DRY RUN — nothing posted. Add --run to dispatch (requires the clip to pass, the three`);
  console.log(`  weights to be present and whole, and 8266 to answer as this rig's ComfyUI).`);
  console.log(`  A dry run writes only to ${GRAPH_DIR}; the dispatch directory gate_score.py reads is`);
  console.log(`  never touched by one.`);
  process.exit(0);
}

/* NOTHING LEFT TO DO IS A CLEAN EXIT, and it happens BEFORE the dispatch
 * gates: a stage whose arms are all already rendered must not fail because
 * ComfyUI happens to be down, and has no reason to touch the engine at all. */
if (!toDispatch.length) {
  console.log(`\n  Every selected arm is already rendered under ${VACE_OUT}. Nothing to dispatch.`);
  console.log(`  Add --force to re-render them, or score what is there:`);
  console.log(`    python scripts/gate_score.py --root "${VACE_OUT}" --report`);
  process.exit(0);
}

/* From here on it is real. Every gate must be open. */
if (clipProblems.length) { console.log(`\n  REFUSING TO RUN — the source clip does not meet the three numbers.`); process.exit(1); }
if (!wr.ready) {
  console.log(`\n  REFUSING TO RUN — WAN VACE weights are not ready: `
    + `${[...wr.missing.map((m) => `missing ${m}`), ...wr.partial].join("; ")}`);
  console.log("  A half-downloaded safetensors fails inside UNETLoader with a header error that reads");
  console.log("  like a corrupt model rather than an incomplete download — fifteen times over.");
  process.exit(1);
}

const engine = await engineIdentity();
if (!engine.up) { console.log(`\n  REFUSING TO RUN — nothing is answering at ${BASE} (${engine.why}).`); process.exit(1); }
if (engine.problems.length) {
  console.log(`\n  REFUSING TO RUN — the ComfyUI answering on port ${config.comfy.port} is not this rig's:`);
  for (const p of engine.problems) console.log(`      ${p}`);
  console.log("      A port is not an identity. A foreign engine with a matching input directory but a");
  console.log("      different --output-directory renders every arm successfully and writes them where");
  console.log("      gate_score.py will never look.");
  process.exit(1);
}
console.log(`  engine        ComfyUI ${engine.version} — --input-directory and --output-directory match this rig`);

await mkdir(VACE_OUT, { recursive: true });
const MANIFEST = path.join(VACE_OUT, "dispatch.json");

/* ⚠ THE MANIFEST IS WRITTEN AFTER EVERY JOB, NOT ONCE AT THE END. Fifteen
 * dispatches at this token count are a long window in which a Ctrl-C, a crash or
 * a hang would destroy every result — including the OOM and error findings the
 * manifest exists to carry, which are the most interesting rows and the ones
 * most likely to precede whatever ends the run early. The file is a few KB. */
const certified = jobs.length ? certifiedValues(jobs[0].graph) : null;
const writeManifest = async (results) => writeFile(MANIFEST, JSON.stringify({
  at: new Date().toISOString(),
  complete: results.length === toDispatch.length,
  dispatched: results.length, planned: toDispatch.length,
  /* WHAT THIS INVOCATION DID NOT RE-RENDER, and therefore what it is standing on
   * from an earlier stage. A manifest listing only its own dispatches would
   * describe a two-arm run when the root holds ten. */
  skipped_already_rendered: skipped,
  graph_run_stamp: STAMP.hash,

  /* The scope caveat travels with the numbers, so a write-up built from the
   * files alone cannot make the broad claim — including the correction about
   * what VACE actually does with the control clip. */
  scope: SCOPE,

  family: "W",
  control: CONTROL_ARM, degenerate: DEGENERATE_ARM,
  controls_file: CONTROLS,

  width: WIDTH, height: HEIGHT, fps: FPS, length: LENGTH, latentLength: LATENT_LENGTH,
  tokenBudget: tb,
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

  certified: {
    baseline: ref ? `${ref.id} (the control)` : `NONE — ${CONTROL_ARM} was not built (--only ${ONLY.join(",")})`,
    identicalAcross: distinct.size === 1 ? fingerprints.map((f) => f.id) : null,
    fingerprintSha256: ref ? createHash("sha256").update(ref.fp).digest("hex") : null,
    values: certified,
  },

  results: results.map(({ graph, ...r }) => r),
}, null, 1));

const results = [];
await writeManifest(results);
for (const job of toDispatch) {
  process.stdout.write(`  ${job.arm} s${job.seed} `);
  const r = await dispatch(job);
  results.push(r);
  await writeManifest(results);
  console.log(r.ok
    ? ` ${r.secs.toFixed(0)}s -> ${r.file}`
    : ` ${r.oom ? "OOM (recorded as a result)" : r.serverGone ? "SERVER GONE" : r.timedOut ? "TIMED OUT" : r.vanished ? "VANISHED" : "FAILED"}: ${String(r.why).slice(0, 200)}`);
}
console.log(`\n  ${results.filter((r) => r.ok).length}/${results.length} rendered${skipped.length ? `, ${skipped.length} skipped as already rendered` : ""} — manifest at ${MANIFEST}`);
console.log(`  SCOPE: ${SCOPE.a_negative_means}.`);
console.log(`  SCORE: python scripts/gate_score.py --root "${VACE_OUT}" --report `
  + `--anchor "${path.join(config.outputDir, "gate", "gate_ceiling.json")}"`);

/* ⚠ A RESULT AND A HARNESS FAILURE EXIT DIFFERENTLY. An OOM or a node error is a
 * RESULT about this rig — ComfyUI answered, the answer was "no", and that is a
 * finding the manifest carries. At 3.33x the native token count an OOM is a
 * genuinely likely and genuinely informative outcome here. A job that never got a
 * terminal answer at all establishes nothing and must not read as a completed
 * run to a wrapper or to a tired operator at 3 a.m. */
const unanswered = results.filter((r) => r.serverGone || r.timedOut || r.vanished
  || (!r.ok && !r.oom && String(r.why).startsWith("POST /prompt failed")));
if (unanswered.length) {
  console.log(`\n  ${unanswered.length} job(s) never got an answer from ComfyUI `
    + `(${unanswered.map((r) => `${r.arm} s${r.seed}`).join(", ")}).`);
  console.log("  That is a HARNESS failure, not a result about conditioning — exiting 1.");
  process.exit(1);
}
