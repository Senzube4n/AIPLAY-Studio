/**
 * DWPose — turning a clip of a person into the stick figure that will steer one.
 *
 * VACE takes a control_video and pushes the render towards it. A blocked camera
 * move is one thing to push towards; a POSE is the other, and pose is what the
 * performance half of this workflow needs. This module builds the extraction:
 * clip in, a skeleton clip out, at the same three numbers the VACE path
 * demands, so the result can be handed straight to vaceGraph without a resample
 * anywhere in between.
 *
 * WHAT IS PROVEN. comfyui_controlnet_aux is installed on this rig and the
 * DWPreprocessor node is live (its object_info was read from the engine on
 * 2026-09-03 and every value below is quoted from it).
 *
 * THE POSE GATE HAS NOW BEEN RUN, AND IT PASSED. 2026-09-03: 121 frames of
 * output/clips/measure_s01.mp4 extracted through this exact builder, handed to
 * vaceGraph() as control_video at strength 1.00 with a character sheet on
 * reference_image, and DWPose re-run on the RESULT. The render's joints land
 * 33.7 px from the control's with a mean per-joint correlation of 0.893,
 * against a time-reversed null of 157.3 px / -0.020 and a frozen-skeleton null
 * of 119.9 px. POSE_GATE below carries the whole result — its nulls, and the
 * two things it does not cover.
 *
 * READ POSE_GATE.caveats BEFORE QUOTING THE NUMBER. The sharpest one is that
 * DWPose is the instrument AND it cannot see this render: it found no figure at
 * all in 43 of the 121 output frames, every one a flat-shaded anime close-up
 * with a plainly visible person in it, and it found nobody in the anime
 * character sheet either. The score is computed on the 78 frames where the
 * instrument could see both sides, and those are the wider, less stylised ones.
 *
 * TWO SETTINGS THAT ARE NOT PREFERENCES.
 *
 * 1. bbox_detector MUST be "yolox_l.torchscript.pt". The node's own default is
 *    "yolox_l.onnx" — read it back from object_info and you will see the ONNX
 *    file sitting in the default slot. Taking that default loads onnxruntime,
 *    and the onnxruntime in this venv is the CPU build that the DAW's
 *    basic-pitch depends on. So the default is not merely slower here; it drags
 *    a shared dependency into a GPU path and the thing that breaks is the note
 *    transcription in a different half of the app. TorchScript, always.
 *    pose_estimator's default IS already the TorchScript file, and it is still
 *    written out explicitly below: a default that happens to be right today is
 *    not a decision, and this one is.
 *
 * 2. resolution MUST equal the source's short side. DWPreprocessor scales the
 *    short side to `resolution` and takes the long side along proportionally.
 *    Leave it at the node's default of 512 and 1280x704 becomes 931x512 —
 *    931 is ODD, and libx264 refuses an odd width outright, so the extraction
 *    finishes and the ENCODE dies. Set it to 704 and the output is the source
 *    size exactly, which is also the size VACE wants, which is why there is no
 *    scaling node anywhere in either graph.
 *
 * THE GRAPH IS DATA, AND NOW SO IS THE WHOLE MODULE. poseGraph() returns JSON
 * and nothing here talks to a machine at all. `extractPose()` used to, through
 * control.js's temporary engine client, and both are deleted: the extraction is
 * run by server/mv/routes.js's `control_render` case, which posts through
 * engine.dispatch() with the caller's own actor and therefore leaves an
 * `engine/<runId>` record with the source clip's SHA-256 in its references.
 */
import crypto from "node:crypto";
import { CONTROL_SPEC } from "./control.js";

/**
 * The two model files, pinned by name. Both are the TorchScript builds.
 * Quoted from GET /object_info/DWPreprocessor on 2026-09-03, whose combo lists
 * were: bbox_detector [None, yolox_l.torchscript.pt, yolox_l.onnx,
 * yolo_nas_l_fp16.onnx, yolo_nas_m_fp16.onnx, yolo_nas_s_fp16.onnx] with
 * DEFAULT yolox_l.onnx; pose_estimator [dw-ll_ucoco_384_bs5.torchscript.pt,
 * dw-ll_ucoco_384.onnx, dw-ll_ucoco.onnx] with default the first.
 */
export const DWPOSE_MODELS = {
  bbox_detector: "yolox_l.torchscript.pt",
  pose_estimator: "dw-ll_ucoco_384_bs5.torchscript.pt",
};

/** The node's own defaults, kept so a test can assert we are OVERRIDING the
 *  one that matters rather than merely agreeing with it by luck. */
export const DWPOSE_NODE_DEFAULTS = {
  bbox_detector: "yolox_l.onnx",
  pose_estimator: "dw-ll_ucoco_384_bs5.torchscript.pt",
  resolution: 512,
};

/**
 * THE POSE GATE, run 2026-09-03, before the engine door existed. One render.
 *
 * Every number here was measured; none was carried over from the camera gate.
 * The camera gate (gate_report.json, arm W1) says VACE carries a blocked CAMERA
 * MOVE. That is a different claim from "VACE carries a PERFORMANCE", and this is
 * the second one, measured on its own.
 *
 * HOW. measure_s01.mp4 -> poseGraph() -> a 121-frame skeleton that passes
 * validateControlClip -> vaceGraph(control: that skeleton, reference: a
 * single-panel character sheet, strength 1.00, masks "ones", 1280x704x121,
 * seed 20260903) -> 33.87 minutes on the engine's own clock -> DWPose re-run on
 * the OUTPUT -> the two keypoint sets compared frame by frame.
 *
 * WHAT `mje_px` IS: the mean distance, in pixels of the 1280x704 frame, between
 * the control's joint and the render's joint, over every (frame, joint) pair
 * where BOTH sides were detected. `r_mean` is the mean over joints and axes of
 * the Pearson correlation of that joint's normalised position across time — it
 * asks whether the joint MOVED THE SAME WAY, which is the dance question, not
 * whether it sat in the same place.
 *
 * THE NULLS ARE THE POINT. A correlation with no null is decoration, and two
 * skeletons of two humans agree somewhat by anatomy alone:
 *   reversed  the control's own trajectories played backwards against the same
 *             render. Identical marginals, destroyed timing. 157.3 px, r -0.020.
 *   static    every control joint frozen at its own median. This is what "the
 *             render ignored the skeleton and they merely share a body layout"
 *             scores: 119.9 px. (Its correlation is undefined, not zero — a
 *             constant series has no variance.)
 * 33.7 px against 119.9 px is the number that says the skeleton was followed.
 */
export const POSE_GATE = {
  ran: "2026-09-03",
  /* WHERE IT RAN, and there is no runId to give. This gate predates the engine
   * door: it was posted straight at ComfyUI's own published port by the
   * temporary client that used to live in control.js, so the app has no record
   * of it and never will. The number itself is DELETED rather than kept as a
   * note — a copyable constant sitting in a data structure is exactly how the
   * other fifteen copies of it started, and it now names a port nothing binds.
   * Every control render since goes through server/engine/client.js and IS a
   * runId; ask /api/provenance?prefix=engine/ for those. */
  engine_run: null,
  source_clip: "D:\\AI\\aiplay-studio-bench\\ComfyUI\\output\\clips\\measure_s01.mp4",
  skeleton: "output/control/dance_pose_measure_s01_00001_.mp4",
  reference: "output/mv/night-train-girl/assets/char_4cf6a2160fb1.png",
  render: "output/control/dance_kaya_20260903_00001_.mp4",
  seed: 20260903,
  strength: 1.0,
  masks: "ones",
  size: { width: 1280, height: 704, frames: 121 },
  extraction_seconds: 26.4,
  render_seconds: 2032.2,

  /* the score, on the 78 frames where DWPose saw a figure on BOTH sides */
  frames: 121,
  frames_scored: 78,
  joint_pairs: 803,
  mje_px: 33.69,
  mje_norm: 0.0365,
  r_mean: 0.893,
  r_median: 0.962,
  null_reversed: { mje_px: 157.34, r_mean: -0.020 },
  null_static: { mje_px: 119.92, r_mean: null },

  /* per-joint, the shape of the result rather than its average */
  best: { joint: "nose", mje_px: 6.8, rx: 0.998, ry: 0.971 },
  worst: { joint: "l_wrist", n: 23, mje_px: 149.9, rx: 0.498, ry: 0.452 },

  /* identity, measured separately — see IDENTITY below */
  identity_measure: "H-S histogram intersection, central-band window, six-sheet null",
  identity_delta: 0.0993,
  identity_z: 2.57,

  caveats: [
    "DWPOSE CANNOT SEE THIS RENDER. No figure was found in 43 of 121 output "
    + "frames — all of them flat-shaded anime close-ups with an obvious person in "
    + "them — and none in the anime character sheet either. The 43 are the CLOSEST "
    + "frames, so the score is measured on the wider 78 and the hardest part of "
    + "the shot is unscored. yolox is trained on photographs.",
    "THE SOURCE IS NOT A DANCE. measure_s01.mp4 is a man at a console with the "
    + "camera pushing in 2.71x (ear-to-ear span 127 -> 345 px). Legs never appear; "
    + "hips are detected on 14 frames of 121, wrists on 10 and 41. So this gate "
    + "measures an upper-body performance under a large scale ramp, and says "
    + "nothing about a full-body dance.",
    "THE HANDS ARE NOT FOLLOWED, and that is where the number is weakest: "
    + "l_wrist 149.9 px, r 0.50/0.45. The raised gloved fists in the render come "
    + "from the PROMPT, not the skeleton — the control has no wrist at all on "
    + "those frames.",
    "ONE RENDER, ONE SEED, ONE SOURCE, ONE REFERENCE. The camera gate ran ten "
    + "arms with a strength ladder and a degeneracy calibrator. This is a single "
    + "point, and no pose arm has been run at strength 0.50 or 2.00.",
  ],
};

/**
 * poseResolution(width, height) -> { ok, resolution, why }
 *
 * The short side, and a refusal with the arithmetic when that would produce an
 * odd long side. This is the rule that turns a silent encoder failure into a
 * sentence somebody can act on.
 */
export function poseResolution(width, height) {
  const w = Number(width), h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { ok: false, resolution: null, why: `pose resolution needs the source's real size, got ${width}x${height}.` };
  }
  const short = Math.min(w, h);
  const long = Math.max(w, h);
  if (long % 2 !== 0 || short % 2 !== 0) {
    return { ok: false, resolution: null, why:
      `source is ${w}x${h} and libx264 encodes even dimensions only — DWPose would hand `
      + `CreateVideo an odd side and the extraction would render, then fail at the encode.` };
  }
  return { ok: true, resolution: short, why: null };
}

/**
 * A stable short name for a given extraction, so re-asking for the same pose
 * from the same clip writes the same file and ComfyUI's execution cache can
 * recognise it. Not security, just identity: 12 hex characters of sha1 over the
 * three inputs that change the output.
 */
export function poseHash({ source, frames, resolution }) {
  return crypto.createHash("sha1")
    .update(`${source}\u0000${frames}\u0000${resolution}`)
    .digest("hex").slice(0, 12);
}

/**
 * poseGraph(opts) -> a ComfyUI /prompt graph, as plain JSON.
 *
 *   source   filename in the ENGINE'S INPUT DIRECTORY. LoadVideo.file is a
 *            COMBO over that directory — a path will not resolve. Required.
 *   frames   how many frames to extract. Defaults to the control floor, 121.
 *   width    source width, default 1280. Used only to pick `resolution`.
 *   height   source height, default 704.
 *   detect   { hand, body, face } booleans, all on by default. Body alone is
 *            enough to drive a figure; hands and face are what make a
 *            performance read, and they cost the same pass.
 *   prefix   SaveVideo filename_prefix. Defaults to control/pose_<hash>.
 *
 * Node ids 20/21/22 are the same ids the VACE graph gives the same three nodes,
 * on purpose: the two graphs are meant to be read side by side, and the pixel
 * chain is literally the same chain. 23/24/25 are this graph's own.
 */
export function poseGraph({
  source,
  frames = CONTROL_SPEC.minFrames,
  width = CONTROL_SPEC.width,
  height = CONTROL_SPEC.height,
  detect = { hand: true, body: true, face: true },
  prefix = null,
} = {}) {
  if (typeof source !== "string" || !source.trim()) {
    throw new Error("poseGraph needs `source`: the clip's filename in the engine's input "
                  + "directory. LoadVideo.file is a COMBO over that directory, so a path will "
                  + "not resolve — stage the clip there and pass its basename.");
  }
  const n = Number(frames);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`poseGraph: frames ${frames} is not a positive whole number of frames.`);
  }
  if (n < CONTROL_SPEC.minFrames) {
    throw new Error(
      `poseGraph: ${n} frames is below the control floor of ${CONTROL_SPEC.minFrames}. `
      + `A pose clip is a control clip — ImageFromBatch clamps a short one and WanVaceToVideo `
      + `pads the rest with flat mid-gray, so a ${n}-frame skeleton conditions the end of the `
      + `shot on nothing. Extract ${CONTROL_SPEC.minFrames} or more, or the render is wasted.`);
  }
  const res = poseResolution(width, height);
  if (!res.ok) throw new Error(`poseGraph: ${res.why}`);

  const hash = poseHash({ source, frames: n, resolution: res.resolution });
  const savePrefix = prefix || `control/pose_${hash}`;
  const on = (v) => (v === false ? "disable" : "enable");

  return {
    20: { class_type: "LoadVideo", inputs: { file: String(source) } },
    21: { class_type: "GetVideoComponents", inputs: { video: ["20", 0] } },
    /* Frames 0..n-1. ImageFromBatch clamps rather than erroring on a short
     * clip, which is why the caller must have run validateControlClip first —
     * this node cannot tell you the clip was too short, it can only quietly
     * give you less than you asked for. */
    22: { class_type: "ImageFromBatch", inputs: { image: ["21", 0], batch_index: 0, length: n } },
    23: { class_type: "DWPreprocessor",
          inputs: {
            image: ["22", 0],
            detect_hand: on(detect?.hand),
            detect_body: on(detect?.body),
            detect_face: on(detect?.face),
            /* The short side. Not the node's 512 default — see the header. */
            resolution: res.resolution,
            /* TorchScript, both. Not the node's ONNX default — see the header. */
            bbox_detector: DWPOSE_MODELS.bbox_detector,
            pose_estimator: DWPOSE_MODELS.pose_estimator,
            scale_stick_for_xinsr_cn: "disable",
          } },
    /* 24 fps, hard, because the control spec is 24 fps and this graph is
     * writing a control clip. The source's own fps is never read — see the
     * frame-rate note in control.js for why that is a rule and not a shortcut. */
    24: { class_type: "CreateVideo", inputs: { images: ["23", 0], fps: CONTROL_SPEC.fps } },
    25: { class_type: "SaveVideo",
          inputs: { video: ["24", 0], filename_prefix: savePrefix, format: "auto", codec: "auto" } },
  };
}
