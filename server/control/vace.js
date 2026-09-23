/**
 * WAN 2.1 VACE 1.3B — the graph that carries a blocked camera move.
 *
 * THE FINDING THIS FILE IS BUILT ON, and it is a measured one.
 *
 * D:\AI\aiplay-studio-bench\ComfyUI\output\vace\gate_report.json, run
 * 2026-09-02..03: ten arms of WAN 2.1 VACE 1.3B against a flat-gray Blender
 * playblast, scored on camera-motion agreement (CMA), motion ratio (MR) and
 * block SSIM. Arm W1 — control_video wired, residual strength 1.00, NO
 * control_masks — passed all five criteria: CMA 0.924 against a 0.50 floor and
 * against its own TIME-SHIFT null of 0.402, MR 0.82 inside [0.4, 2.5], and
 * SSIM_block 0.524 against a 0.736 bar. That last number is the one that
 * matters: it is BELOW the bar, which is what "generated, not reconstructed"
 * means. The reconstruction anchor is 0.982 and the degeneracy calibrator W9
 * (control_masks all zeros, which tells VACE to hand the footage back) sat at
 * 0.975. W1 is nowhere near either.
 *
 * The strength ladder, from the same run: 0.50 also passes; 2.00 reconstructs;
 * 0.25 does nothing. So 1.00 is the shipped default and the ladder either side
 * of it is documented rather than guessed.
 *
 * WHY NOT THE OTHER TWO PATHS. LTX's sparse appearance guides were tested on
 * the same blockout in a separate run and are a DECISIVE NEGATIVE — they write
 * pixels into the denoising latent and the camera does not follow. H3 has no
 * structural input at all. VACE leaves the latent as noise and PUSHES it with a
 * scaled additive residual (comfy/ldm/wan/model.py:854, `x += c_skip *
 * vace_strength`), and that is the mechanism that steers the camera.
 *
 * THE GRAPH IS DATA. Nothing here executes anything. vaceGraph() returns the
 * same JSON object shape ComfyUI's own prompt endpoint accepts, and the caller
 * posts it — server/mv/control.js does, through engine.dispatch(), which is the
 * one door. This module is byte-for-byte reproducing the shape of
 * D:\AI\...\output\vace\_graphs\W1_s70117.json, which is the graph that
 * actually scored 0.924, and vace_test.js compares against that shape rather
 * than against a description of it.
 *
 * LICENCE. See VACE_LICENCE below. As of 2026-09-03 it is settled: the text was
 * read, diffed against canonical Apache-2.0, and the model is catalogued.
 */
/* Deliberately importless beyond this line: a graph builder is DATA, and this
 * module must be safe to import from anywhere — a test, a route, an MCP tool —
 * without dragging config or a network client behind it. There is no engine
 * client anywhere in this directory now: the one that used to sit at the end of
 * control.js is deleted, along with extractPose, the only caller that needed it.
 * Every render goes through server/engine/client.js. See README.md, "The
 * wiring". */

/**
 * THE LICENCE LINE. It used to be an admission; as of 2026-09-03 it is a grant,
 * and the admission it replaces is kept below because the SHAPE of the mistake
 * is the useful part.
 *
 * WHAT IT SAID BEFORE. "Publisher states Apache-2.0 in README frontmatter; the
 * licence TEXT has not been read or normalised on this rig, and there is no
 * entry for this model in server/models.js — so this is a pointer, not a
 * settled grant." That was correct when it was written: the weights were
 * fetched onto the bench rig for the gate and catalogued nowhere, so nothing
 * travelled with them and NOTICE, which is generated from the catalogue, listed
 * neither this model nor its encoder, its VAE or the DWPose pair.
 *
 * WHAT WAS DONE. The three steps README.md set out, in that order: the
 * catalogue entry (server/models.js, id `videoControl`, with outputRights
 * quoting Apache-2.0 §2), `node scripts/gen_notice.mjs`, and then this flag.
 *
 * WHAT THE VERIFICATION ACTUALLY FOUND, including the part that was not
 * expected. The document is real and it is clean: Wan-AI/Wan2.1-VACE-1.3B's
 * LICENSE.txt at revision 574e6a7 is 11,357 bytes and 1,581 words, and a
 * word-normalised diff against canonical Apache-2.0 fetched from apache.org
 * gives similarity 1.000000 with ZERO differing runs across the whole file,
 * appendix included. No addendum, no acceptable-use annexe, no revenue ceiling,
 * no territory clause.
 *
 * ⚠ But the FILES ON THIS RIG ARE NOT FROM THAT REPOSITORY. All three are
 * Comfy-Org's ComfyUI repackage, proven by sha256 against that repository's own
 * published LFS records (the DiT is
 * 640ccc0577e6a5d4bb15cd91b11b699ef914fc55f126c5a1c544e152130784f2), and
 * Wan-AI's repo publishes a diffusers layout that does not contain these
 * filenames at all. The repackage ships no LICENSE file — only a frontmatter
 * tag, the very thing this comment used to refuse. So the grant below cites
 * Wan-AI's text and says plainly that the bytes came from a conversion, which
 * is an inference from Comfy-Org's own `base_model` declaration rather than
 * something proven by hash. Stated, not smoothed over: it is the residual gap.
 *
 * ⚠ AND THE POSE HALF IS STILL UNREAD. This flag speaks for the WAN weights
 * only. The DWPose estimator that draws the skeletons is catalogued as
 * `posePreprocess` with `outputRights.class === "unknown"` — its redistributor
 * ships a 28-byte model card and no LICENSE file — so a surface that shows one
 * settled claim for the whole control path would be overstating it.
 */
export const VACE_LICENCE =
  "WAN 2.1 VACE 1.3B, Apache-2.0 — VERIFIED, not a badge. Wan-AI/Wan2.1-VACE-1.3B's LICENSE.txt at "
  + "revision 574e6a7 (11,357 bytes, 1,581 words) was diffed word by word against canonical "
  + "Apache-2.0 from apache.org: similarity 1.000000, zero differences across the whole file "
  + "including the appendix, no addendum, no revenue ceiling and no territory clause. §2 grants the "
  + "usual rights over the Work and says nothing whatever about generated material, and WAN's README "
  + "says the same in its own words — \"We claim no rights over the your generated contents\" (typo "
  + "theirs). Clips rendered here are yours to sell. Catalogued in server/models.js as `videoControl`, "
  + "which is where the quote, the clause and the URL live, and NOTICE is generated from it. "
  + "⚠ Two things this sentence does NOT cover: the weights on disk are Comfy-Org's repackage "
  + "(sha256-matched to their published records) rather than Wan-AI's own files, and that the "
  + "repackage is a conversion of them is an inference from its `base_model` declaration; and the "
  + "DWPose estimator that draws the skeletons has no readable licence at all — see `posePreprocess`.";

/** Whether the licence claim above has been verified against a licence text on
 *  this rig. It has been, for the WAN weights: the document was fetched at a
 *  pinned revision and normalised against canonical Apache-2.0 with zero
 *  differences. ⚠ It says nothing about the DWPose estimator, which is
 *  catalogued as `unknown` and is a separate answer — a surface must read
 *  server/models.js for that one rather than generalising this flag. */
export const VACE_LICENCE_VERIFIED = true;

/**
 * The three weight files, exactly as W1 named them. These are ComfyUI-relative
 * filenames, resolved by the engine inside its own models/ tree — not paths.
 */
export const VACE_WEIGHTS = {
  diffusion_models: "wan2.1_vace_1.3B_fp16.safetensors",
  text_encoders: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
  vae: "wan_2.1_vae.safetensors",
};

/**
 * Sampler settings, frozen from the install's own worked reference —
 * blueprints/"Video Inpainting (Wan2.1 VACE).json", taking the NON-CausVid
 * branch of its three switches. These are the numbers W1 ran at, so changing
 * one makes gate_report.json's 0.924 a claim about a different graph.
 *
 * The CausVid LoRA and the SAM3 segmentation node in that blueprint are
 * deliberately absent: a plain control-video graph needs neither, and neither
 * is installed on this rig.
 */
export const VACE_PRESET = {
  shift: 5.0,
  steps: 20,
  cfg: 6.0,
  sampler: "uni_pc",
  scheduler: "simple",
  denoise: 1.0,
  fps: 24,
};

/**
 * THE ONLY SIZE v1 WILL BUILD, and why it is not a taste.
 *
 * 1280x704 is OFF WAN 1.3B's 832x480 native, on purpose: it is the size the
 * blocking clip is rendered at, so the control video reaches the VAE uncropped
 * and unresampled. There is no ImageScale anywhere in this pixel chain — unlike
 * the LTX restyle path, which stretches — and that absence is what makes "the
 * conditioning is the source frames" answerable from the graph rather than from
 * node internals.
 *
 * 121 frames is 4n+1, which WanVaceToVideo's `length` step of 4 requires, and
 * it is the frame count every gate number was measured at.
 *
 * A different size is not forbidden by the model. It is forbidden by the
 * evidence: nothing has been measured off this operating point, and a size knob
 * that silently moves off a proven point is how a green gate becomes folklore.
 */
export const VACE_SIZE = { width: 1280, height: 704, frames: 121 };

/**
 * The operating point W1 passed at, kept as data so a caller can print it and
 * a test can compare against it.
 */
export const VACE_OPERATING_POINT = {
  strength: 1.0,
  masks: "ones",
  width: 1280,
  height: 704,
  frames: 121,
  arm: "W1",
  CMA: 0.923682689666748,
  /* The two numbers that make the CMA above mean something. A score with no
   * bar and no null is decoration: 0.50 is the gate's own pass floor, and 0.402
   * is W1's OWN NULL.
   *
   * ⚠ THIS COMMENT USED TO SAY 0.402 WAS "arm W0 — the SAME graph at strength
   * 0.00", and that was wrong twice over. It is neither W0 nor a strength-zero
   * arm; it is a per-arm quantity computed from W1's own footage. Read out of
   * gate_report.json's rows rather than remembered:
   *
   *   the NULL (`rows[].null`) is CMA recomputed with THIS arm's own estimated
   *   flow circularly shifted in time — the max over 20 fixed-seed shifts, each
   *   at least 12 frames from zero.
   *
   *   ⚠ AND THE HARNESS THAT COMPUTED IT IS NOT PUBLISHED. This used to cite
   *   `scripts/gate_score.py:660` and then name a directory on the author's own
   *   laptop as where to find it, which is worth nothing to anybody reading
   *   this repository: a path that resolves on exactly one machine is a
   *   citation to a file nobody else has, and it reads as a stale link rather
   *   than as a missing tool. So the DEFINITION above is the citation - shift
   *   this arm's own estimated flow circularly in time by at least 12 frames,
   *   take the max CMA over 20 fixed seeds, and the number comes back out of
   *   the footage without any of our code.)
   *   Every arm has one: W0 0.041, W1 0.402, W2 0.292, W4 0.320. It answers
   *   "how well would this render's own motion match the control if the timing
   *   were destroyed", which is the null that catches a render that moves
   *   plausibly but not IN STEP. The gate's own verdict line says it in as many
   *   words: "CMA 0.924 (floor 0.50), W0 + margin, > its own NULL 0.402".
   *
   *   THE STRENGTH-ZERO ARM IS W8, and it scored CMA -0.056 — not 0.402. It is
   *   barred from passing by construction, because `x += c_skip * 0.00`
   *   contributes nothing, so it cannot be carrying the control video whatever
   *   it scored.
   *
   *   THE TEXT-ONLY CONTROL ARM IS W0, at CMA -0.019: the same model with no
   *   control_video wire at all, so WanVaceToVideo substitutes a uniform gray
   *   plate. That is the arm the margin criterion compares against.
   *
   * Why the mislabel mattered: "0.924 against a zero-strength null of 0.402"
   * reads as "turning the control off still scores 0.402", which makes the
   * control look worth 0.52 of agreement. Turning it off really scores about
   * ZERO (-0.056 at strength 0, -0.019 with no wire), and 0.402 is a harder,
   * different bar — a timing null on W1's own motion. Both numbers are here so
   * neither has to be remembered. */
  CMA_floor: 0.50,
  /** W1's own time-shift null. NOT a strength-zero arm — see above. */
  CMA_null: 0.402,
  CMA_null_kind: "time-shift",
  CMA_null_what: "CMA recomputed with W1's own estimated flow circularly shifted in time, "
    + "max over 20 fixed-seed shifts of at least 12 frames. The harness that measured it is "
    + "not published, so the definition is the citation: recomputable from the footage",
  /** The arms that really are the controls, with what they really scored. */
  CMA_zero_strength: -0.056,
  CMA_zero_strength_arm: "W8",
  CMA_text_only: -0.019,
  CMA_text_only_arm: "W0",
  MR: 0.82,
  SSIM_block: 0.524,
  ssim_bar: 0.7359418295207665,
  reconstruction_anchor: 0.9815188050270081,
  report: "D:\\AI\\aiplay-studio-bench\\ComfyUI\\output\\vace\\gate_report.json",
  graph: "D:\\AI\\aiplay-studio-bench\\ComfyUI\\output\\vace\\_graphs\\W1_s70117.json",
};

/**
 * The strength ladder, measured. Every entry is an arm that really rendered.
 * `pass` is the gate's own verdict for that arm.
 */
export const VACE_STRENGTH_LADDER = [
  { strength: 0.25, arm: "W3", pass: false, reads: "does nothing — the residual is too small to steer" },
  { strength: 0.50, arm: "W2", pass: true, reads: "passes; a softer hold on the move" },
  { strength: 1.00, arm: "W1", pass: true, reads: "the shipped default — carries the move, still generates" },
  { strength: 2.00, arm: "W4", pass: false, reads: "reconstructs — hands the blockout back instead of a shot" },
];

/**
 * vaceSizeFor(width, height, frames) -> { ok, width, height, frames, why }
 *
 * v1 answers for exactly one size and refuses everything else WITH THE REASON.
 * It never silently snaps: videoSizeFor in workflow.js once returned a size the
 * caller had not asked for and the render was wrong in a way nobody could see.
 * A refusal a caller can read beats a size a caller did not choose.
 */
export function vaceSizeFor(width, height, frames) {
  const w = Number(width), h = Number(height), f = Number(frames);
  const bad = [];
  if (w !== VACE_SIZE.width || h !== VACE_SIZE.height) {
    bad.push(`size is ${w}x${h}, must be ${VACE_SIZE.width}x${VACE_SIZE.height}`);
  }
  if (f !== VACE_SIZE.frames) {
    bad.push(`frame count is ${f}, must be ${VACE_SIZE.frames}`);
  }
  if (!bad.length) return { ok: true, width: w, height: h, frames: f, why: null };
  return {
    ok: false, width: w, height: h, frames: f,
    why: `${bad.join("; ")}. v1 builds one operating point only — `
       + `${VACE_SIZE.width}x${VACE_SIZE.height} x ${VACE_SIZE.frames} frames — because that is the `
       + `only size WAN 2.1 VACE has been measured at here (gate_report.json, arm W1, CMA 0.924). `
       + `Nothing has been rendered off it, so a size knob would be a guess wearing a number.`,
  };
}

/** The negative W1 ran with. Kept as the default so a caller who passes only a
 *  prompt gets the graph the gate measured, rather than a bare one. */
export const DEFAULT_NEGATIVE =
  "pc game, console game, video game, cartoon, childish, ugly, static camera, still frame, "
  + "flat gray, untextured, clay render, watermark, text";

/** The mask kinds this builder understands. */
const MASK_KINDS = new Set(["ones"]);

/**
 * vaceGraph(opts) -> a ComfyUI /prompt graph, as plain JSON.
 *
 *   control    filename in the ENGINE'S INPUT DIRECTORY (LoadVideo.file is a
 *              COMBO over that directory — a path will not resolve). Required.
 *   reference  optional filename in the same directory, wired to
 *              reference_image. See the note on node 23 below.
 *   prompt     positive text. Required and non-empty: an empty prompt on this
 *              model renders a gray field that still "succeeds".
 *   negative   negative text, defaulted.
 *   seed       KSampler seed. Required — a hidden random seed makes a render
 *              unreproducible and this whole path exists to be reproducible.
 *   strength   VACE residual strength, default 1.00 (W1's).
 *   masks      "ones" only. See MASKS below.
 *   size       { width, height } — defaults to 1280x704, checked by vaceSizeFor.
 *   frames     defaults to 121, checked by vaceSizeFor.
 *   prefix     SaveVideo filename_prefix, default "control/vace_<seed>".
 *
 * MASKS. "ones" means the control_masks input is ABSENT, because absent IS
 * ones: nodes_wan.py:341-343 substitutes a ones mask when none is supplied, and
 * ones means "generate over the whole clip". This matters and is the opposite
 * of intuition — W9, the arm that supplied an explicit all-ZEROS mask, is the
 * degeneracy calibrator and it reproduces the source footage by construction.
 * So building an explicit ones mask would be a DIFFERENT GRAPH from the one
 * that scored 0.924, and this builder will not do it. Anything but "ones" is
 * refused with that reason.
 *
 * THE FRAME COUNT IS LOAD-BEARING AND FAILS SILENTLY IF WRONG. nodes_wan.py:344
 * pads a short mask with value 1.0, so a wrong-length mask becomes "preserve
 * frame 0, regenerate the other 120" with no error anywhere. v1 supplies no
 * mask, so this cannot bite here — it is written down because the moment
 * someone adds inpainting it can.
 */
/**
 * judgeStrength(strength) -> { ok, strength, why }
 *
 * The pure half of the strength check, split out of the builder for the same
 * reason judgeClip() is split out of validateControlClip(): SOMEBODY HAS TO ASK
 * IT EARLIER THAN THE BUILDER RUNS.
 *
 * ⚠ THE MEASURED INCIDENT. `mode: "pose"` builds its VACE graph only AFTER the
 * DWPose extraction has already been dispatched and finished — the skeleton is
 * the control clip, so it cannot be built before it exists. That meant a
 * strength of 5000, which is a typo this function can see without a machine,
 * was refused with a real render already spent. Measured on the scratch
 * instance 2026-09-03: status 400, and one POST to /prompt before it. That is
 * the same shape as the 96-frame clip that cost a minute of GPU, and the whole
 * argument of this directory is that the refusal comes first.
 *
 * So `server/mv/control.js` asks this BEFORE it stages anything, and
 * `vaceGraph()` below asks it again as its own last line of defence. One
 * sentence, two callers, and neither can drift from the other.
 */
export function judgeStrength(strength) {
  const s = Number(strength);
  if (!Number.isFinite(s) || s < 0 || s > 1000) {
    return { ok: false, strength: s,
             why: `vaceGraph: strength ${strength} is outside WanVaceToVideo's declared 0..1000.` };
  }
  return { ok: true, strength: s, why: null };
}

export function vaceGraph({
  control,
  reference = null,
  prompt,
  negative = DEFAULT_NEGATIVE,
  seed,
  strength = VACE_OPERATING_POINT.strength,
  masks = "ones",
  size = { width: VACE_SIZE.width, height: VACE_SIZE.height },
  frames = VACE_SIZE.frames,
  prefix = null,
} = {}) {
  if (typeof control !== "string" || !control.trim()) {
    throw new Error("vaceGraph needs `control`: the control clip's filename in the engine's "
                  + "input directory. LoadVideo.file is a COMBO over that directory, so a path "
                  + "will not resolve — stage the clip there and pass its basename.");
  }
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("vaceGraph needs a non-empty `prompt`. WAN renders a gray field from an "
                  + "empty one and reports success, which is the worst kind of wrong.");
  }
  if (!Number.isFinite(Number(seed))) {
    throw new Error("vaceGraph needs a numeric `seed`. This path exists to be reproducible and "
                  + "a hidden random seed removes the only handle on that.");
  }
  if (!MASK_KINDS.has(masks)) {
    throw new Error(`vaceGraph: masks ${JSON.stringify(masks)} is not built here. v1 supplies `
                  + `"ones", which means control_masks is ABSENT — the node substitutes a ones `
                  + `mask (nodes_wan.py:341-343) and ones means "generate over the whole clip". `
                  + `An explicit all-zeros mask is the gate's degeneracy calibrator (arm W9): it `
                  + `hands the source footage back by construction, SSIM_block 0.986 against a `
                  + `0.736 bar, and it is disqualified from passing anything.`);
  }
  const judged = judgeStrength(strength);
  if (!judged.ok) throw new Error(judged.why);
  const s = judged.strength;
  const fit = vaceSizeFor(size?.width, size?.height, frames);
  if (!fit.ok) throw new Error(`vaceGraph: ${fit.why}`);

  const { width, height } = fit;
  const length = fit.frames;
  const savePrefix = prefix || `control/vace_${Number(seed)}`;

  /* Node ids 1-12 and 20-22 are W1's, unchanged and in W1's order, so the two
   * graphs diff cleanly. 23 is the only id this builder adds and it exists only
   * when a reference image is given. */
  const g = {
    1: { class_type: "UNETLoader",
         inputs: { unet_name: VACE_WEIGHTS.diffusion_models, weight_dtype: "default" } },
    2: { class_type: "CLIPLoader",
         inputs: { clip_name: VACE_WEIGHTS.text_encoders, type: "wan", device: "default" } },
    3: { class_type: "VAELoader", inputs: { vae_name: VACE_WEIGHTS.vae } },
    4: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: String(prompt) } },
    5: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: String(negative) } },
    6: { class_type: "ModelSamplingSD3", inputs: { model: ["1", 0], shift: VACE_PRESET.shift } },
    7: { class_type: "WanVaceToVideo",
         inputs: {
           positive: ["4", 0], negative: ["5", 0], vae: ["3", 0],
           width, height, length, batch_size: 1,
           strength: s,
           control_video: ["22", 0],
           /* control_masks: ABSENT on purpose — see MASKS above.
            * reference_image: added below only when asked for. */
         } },
    8: { class_type: "KSampler",
         inputs: { model: ["6", 0], positive: ["7", 0], negative: ["7", 1],
                   latent_image: ["7", 2], seed: Number(seed),
                   steps: VACE_PRESET.steps, cfg: VACE_PRESET.cfg,
                   sampler_name: VACE_PRESET.sampler, scheduler: VACE_PRESET.scheduler,
                   denoise: VACE_PRESET.denoise } },
    /* TrimVideoLatent takes WanVaceToVideo's 4th output (trim_amount). With no
     * reference image that value is 0 and this node is a no-op; with one it is
     * the ONE node that removes the reference frame the encoder prepended. It
     * is wired unconditionally so that adding a reference cannot forget it. */
    9: { class_type: "TrimVideoLatent", inputs: { samples: ["8", 0], trim_amount: ["7", 3] } },
    /* TILED, the one change from W1. A whole-clip WAN VAE decode is sized for
     * every frame at once; on a card that cannot hold it ComfyUI ran out of
     * memory and retried in tiles (AMD), or, on NVIDIA under Windows, the
     * driver spilled into system RAM and the decode crawled with no progress
     * messages. The same failure MiniMax Music 3's whole-song decode had.
     * ComfyUI's own tile defaults; the spatial overlap and the temporal overlap
     * are blended by ComfyUI. vace_test.js allows exactly this difference. */
    10: { class_type: "VAEDecodeTiled", inputs: { samples: ["9", 0], vae: ["3", 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 } },
    11: { class_type: "CreateVideo", inputs: { images: ["10", 0], fps: VACE_PRESET.fps } },
    12: { class_type: "SaveVideo",
          inputs: { video: ["11", 0], filename_prefix: savePrefix, format: "auto", codec: "auto" } },

    /* The pixel chain. No ImageScale, no crop, no resize: the control clip
     * reaches the VAE as the frames the blocking renderer wrote. ImageFromBatch
     * CLAMPS rather than errors when the clip is short — which is exactly why
     * validateControlClip() enforces >= 121 frames BEFORE anything is posted. */
    20: { class_type: "LoadVideo", inputs: { file: String(control) } },
    21: { class_type: "GetVideoComponents", inputs: { video: ["20", 0] } },
    22: { class_type: "ImageFromBatch", inputs: { image: ["21", 0], batch_index: 0, length } },
  };

  /* reference_image, wired when given.
   *
   * Input names and types read from the LIVE engine on 2026-09-03:
   *   GET /object_info/WanVaceToVideo -> optional: control_video IMAGE,
   *   control_masks MASK, reference_image IMAGE.
   * So a reference is an IMAGE, not a VIDEO, and LoadImage is the node that
   * produces one.
   *
   * ⚠ THIS IS UNTESTED BY THE GATE. gate_report.json lists "VACE with a
   * reference_image" under paths_not_tested: no arm ever supplied one, which is
   * why trim_latent was provably 0 for every measured number. The wiring here
   * is correct against the node's declared interface; what a reference does to
   * CMA is unmeasured, and no surface should present it as proven.
   */
  if (reference != null && String(reference).trim()) {
    g[23] = { class_type: "LoadImage", inputs: { image: String(reference) } };
    g[7].inputs.reference_image = ["23", 0];
  }
  return g;
}
