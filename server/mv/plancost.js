/**
 * What a planned item will cost, as DATA with citations.
 *
 * ⚠ EVERY NUMBER HERE WAS MEASURED ON THIS RIG AND EVERY ROW NAMES THE FILE IT
 * CAME FROM. That rule is server/videolab/catalog.js's, kept for its reason: a
 * number whose source moved is a number nobody can re-measure, and a cost model
 * nobody can re-measure is a cost model nobody should believe. `plan_test.js`
 * checks that every `cite` is a path that really exists in this repository.
 *
 * WHY A TABLE AND NOT A FORMULA IN config.js. config.js already has a cost
 * curve (exponent 1.2) and it is used for QUEUE arithmetic. This table answers
 * a different question — "what is this list of renders going to cost me
 * tonight" — and it answers it out loud, per row, so a person can disagree with
 * a specific measurement rather than with a black box. The two are deliberately
 * separate; changing the queue's arithmetic mid-render is how you lose a night.
 *
 * ── THE THREE THINGS THIS FILE KNOWS ────────────────────────────────────────
 *
 * 1. STEPS PICK THE MODEL, NOT A QUALITY DIAL. There is no on/off switch for
 *    the turbo distillation: the number of steps selects which file loads, so
 *    4 / 8 / bare are three different models with three different costs and
 *    they do not interpolate. Rows carry a step CLASS, and a row is chosen by
 *    matching that class — never by scaling one class's number into another's.
 *    (DIRECTING.md §4.)
 *
 * 2. COST IS SUPERLINEAR IN BOTH AREA AND LENGTH, and the spec this module was
 *    built to asked for linear scaling. ⚠ IT IS NOT LINEAR, AND THE DIRECTION
 *    MATTERS. docs/RESOLUTION_FOR_FACES.md's H3 sweep — six renders, one seed,
 *    56 frames, only the size varied — fits 1.43 on area and 1.34 on frames,
 *    and says in as many words that the 1.2 exponent config.js uses "under-
 *    quotes exactly where it hurts": +5% at native/56f but −19% at 1920x1088/
 *    124f. Linear is worse again. Checked on the sweep's own endpoints:
 *    1344x768 -> 1920x1088 is 2.02x the pixels and 2.62x the wall clock
 *    (275.6 s -> 721.4 s), i.e. area^1.39. A linear model quotes 558 s for a
 *    render that took 721 — a 23% under-quote at the expensive corner, which is
 *    the corner where a bad quote costs somebody a night. So this module scales
 *    by AREA^1.43 x SECONDS^1.34 and says so here rather than quietly shipping
 *    a number that is wrong in the flattering direction.
 *
 * 3. THE ROWS DISAGREE WITH EACH OTHER, AND THAT IS RECORDED RATHER THAN
 *    AVERAGED AWAY. DIRECTING §4's "H3 guided at 1344x768 = 2259 s for 13.7 s"
 *    is about 2x what the same size and step class predicts from the 124-frame
 *    ladder, and the LTX pair in that same table (519 s two-pass against 965 s
 *    guided) shows why: the GUIDED path costs roughly 1.9x the plain one, and
 *    the two sets were measured on different nights with different guidance.
 *    Fitting one curve through incompatible measurements would produce a number
 *    with no measurement behind it. Instead the row is chosen by engine + step
 *    class, its `cite` travels with the estimate, and `spread` names the known
 *    disagreement so a reader can see the estimate is a bracket, not a promise.
 *
 * Pure data and pure arithmetic. No I/O, no clock, no document.
 */

/** Every path here is checked against the filesystem by plan_test.js. */
import { config, loraStepsOf } from "../config.js";
import { h3TurboLoraFor } from "../workflow.js";

export const COST_DOCS = {
  directing: "DIRECTING.md",
  faces: "docs/RESOLUTION_FOR_FACES.md",
  config: "server/config.js",
  shot: "server/mv/shot.js",
  /* The control path's own measurements: the 31.99-minute proof render, the
   * 33.87-minute pose gate and the 26.4-second extraction all live there, each
   * timed by the engine's own execution_start/execution_success rather than by
   * a stopwatch. */
  control: "server/control/README.md",
  /* The second door's own file: its header states which numbers are measured
   * and which are not, which is the only citation an unmeasured constant may
   * honestly have. */
  mesh: "server/mesh/runner.js",
};

/** The frame rate every measurement below was taken at (config.video.fps). */
export const FPS = 24;

/**
 * The scaling exponents, from docs/RESOLUTION_FOR_FACES.md's fit. Exported so a
 * test can re-derive them from the document's own table rather than trusting
 * the two numbers typed here.
 */
export const AREA_EXP = 1.43;
export const SECONDS_EXP = 1.34;

/** The step count a turbo LoRA was distilled for, read off its file name
 *  (`_8step_`), or null for a name that does not say. config.js owns the
 *  reader, because its H3 step defaults and /api/status ask the same thing
 *  and three copies of one regex is how a file name gets read two ways. */
export const loraSteps = loraStepsOf;

/**
 * The distillation the graph would ACTUALLY load for this request, as its
 * step count — the same pick videoGraphH3 makes (h3TurboLoraFor), read off
 * this machine's config, so the plan and the render cannot disagree about
 * which file runs. Null on the bare path, where nothing loads.
 */
export function loadedLoraSteps(steps, { refs = true } = {}) {
  const eng = { ...config.video, ...(config.video?.engines?.h3 ?? {}) };
  return loraSteps(h3TurboLoraFor(eng, { steps, refs }).lora);
}

/**
 * STEP CLASS — which model file a step count actually loads.
 *
 * ⚠ THE 5-12 BAND IS THE FILE THAT LOADS, AND SINCE 2026-09-12 THAT DEPENDS
 * ON THE DISK. This used to say the reference path had no 8-step build, so
 * every reference render between 5 and 12 steps loaded the 4-step file and
 * overran it — true when written, and the reason 8 was banned from the
 * dropdown. The ref2v 8-step v1.0 768p distillation exists now and
 * `refTurboLora` picks it first, so on a rig that has it, 8 steps with
 * references loads an 8-step file at its design point. On a rig without it
 * the 4-step file still loads and the old reading still holds. `loaded` is
 * that pick's step count; the class is the row it was measured on, and
 * `trapBand` says when the count OVERRUNS the file — the same file at three
 * times its steps costs roughly three times as much, so the estimate is a
 * FLOOR. (DIRECTING.md §4.)
 */
export function stepClassOf(steps, { refs = true, loaded = loadedLoraSteps(steps, { refs }) } = {}) {
  const n = Number(steps);
  if (!Number.isFinite(n) || n <= 0) return "bare";   // null = the project default
  if (n <= 4) return "4";
  if (n >= 13) return "bare";
  return loaded === 8 ? "8" : "4";
}

/** True where the step count OVERRUNS the distillation that loads — a 4-step
 *  file at 8, an 8-step file at 12 — so the estimate for such an item is a
 *  floor, not a figure. 5-12 only; 13+ is the bare model and loads nothing. */
export const trapBand = (steps, { refs = true, loaded = loadedLoraSteps(steps, { refs }) } = {}) => {
  const n = Number(steps);
  return Number.isFinite(n) && n >= 5 && n <= 12 && loaded != null && n > loaded;
};

/**
 * The measurements. `seconds` is the CLIP length the row was measured at and
 * `wall` is its wall clock in seconds; everything else scales off those two.
 */
export const COST_ROWS = [
  /* ── LTX, DIRECTING §4's "same 13.7 s scene at 1920x1088 on a 16 GB card" ── */
  { id: "ltx-two", engine: "ltx", stepClass: "bare", pass: "two",
    w: 1920, h: 1088, seconds: 13.7, wall: 519,
    what: "LTX two-pass — half base, x2 latent upscale. The fast path, and what LTX is for.",
    cite: COST_DOCS.directing },
  { id: "ltx-guided", engine: "ltx", stepClass: "bare", pass: "guided",
    w: 1920, h: 1088, seconds: 13.7, wall: 965,
    what: "LTX guided at full size, single pass. 1.9x the two-pass — the size of the guidance tax.",
    cite: COST_DOCS.directing },

  /* ── H3 at native, 124 frames, one prompt and seed, only the steps varied.
   * The cleanest triple in the corpus: same conditions, three model files.
   * DIRECTING §4's step table; the 8-step figure is independently recorded in
   * server/config.js's own engine note ("H3 @ 8 steps 1344x768 x 124f 308 s"). */
  { id: "h3-4-native", engine: "h3", stepClass: "4",
    w: 1344, h: 768, seconds: 124 / FPS, wall: 157,
    what: "the 4-step distillation at H3's native size. 2 m 37 s, and it matched.",
    cite: COST_DOCS.directing },
  { id: "h3-8-native", engine: "h3", stepClass: "8",
    w: 1344, h: 768, seconds: 124 / FPS, wall: 308,
    what: "the 8-step distillation. 5 m 08 s — clean but flat.",
    cite: COST_DOCS.directing },
  /* EACH CLAIM WITH ITS SCOPE (server/config.js, the `steps` note). The 660 s
   * was measured with the turbo LoRA loaded at 20 steps; 20 steps is 20
   * forward passes on either path, so it prices the bare model too. The
   * "visibly the best" said beside it was that LoRA-at-20 render, not this
   * path, and the only A/B of the bare model against a turbo build is
   * docs/H3_REFERENCE_BLEED.md arm H vs C: about equal to the ref2v 8-step at
   * 2.4x the time. So this row claims the time and nothing else. */
  { id: "h3-bare-native", engine: "h3", stepClass: "bare",
    w: 1344, h: 768, seconds: 124 / FPS, wall: 660,
    what: "no LoRA, the bare model at 20 steps. 11 m 00 s: a 20-step time, which holds on either path. "
      + "The one A/B against a turbo build (arm H vs C) found it about equal to the ref2v 8-step, at 2.4x the time.",
    cite: COST_DOCS.directing },

  /* ── H3 above native, 5-second scene. THE ROW THE FILMS WERE MADE ON. Both
   * Bone Waffle films rendered at 1920x1088 / 4 steps / ~11 min per 5 s scene
   * on a 16 GB card. It is the row the quality line quotes, so it is the row
   * that has to reproduce exactly. */
  { id: "h3-4-1080", engine: "h3", stepClass: "4",
    w: 1920, h: 1088, seconds: 5, wall: 660,
    what: "4-step turbo above native. 11 min per 5 s — the two shipped films are this row.",
    cite: COST_DOCS.directing },
  { id: "h3-bare-1080", engine: "h3", stepClass: "bare",
    w: 1920, h: 1088, seconds: 5, wall: 3000,
    what: "the bare model above native. 50 min per 5 s, 4.5x the turbo for near-indistinguishable output.",
    cite: COST_DOCS.directing },
];

/**
 * THE DISAGREEMENT, NAMED. DIRECTING §4's other H3 figure — 2259 s for a 13.7 s
 * scene at 1344x768, guided, on a 16 GB card — is about twice what the 124-frame
 * ladder predicts for the same size and class. The LTX pair in the same table
 * puts a number on why (guided is 1.9x plain), and the two sets are different
 * nights. Reported as a bracket rather than folded into an average nobody
 * measured.
 */
export const COST_SPREAD = {
  factor: 1.9,
  why: "A guided render costs about 1.9x a plain one — DIRECTING §4's own LTX pair, 519 s "
    + "two-pass against 965 s guided at the same size and length. The H3 rows here were not all "
    + "measured on the same night or with the same guidance, so a per-item estimate is a bracket: "
    + "the number, and up to about twice it if the scene is guided the way the 2259 s row was.",
  cite: COST_DOCS.directing,
};

/**
 * H3 above 16 GB. Kept as its own fact rather than a row, because it is not a
 * cost — it is a render that does not happen. Both films shipped from that size
 * at 4 steps, so it is a warning about the bare path, not about the size.
 */
export const H3_OOM = {
  engine: "h3", w: 1920, h: 1088,
  note: "H3 at 1920x1088 measured OUT OF MEMORY on a 16 GB card. The two Bone Waffle films "
    + "rendered there anyway, at 4 steps — so the size works, on the turbo path, and the bare "
    + "model at this size is the thing that ran out.",
  cite: COST_DOCS.directing,
};

/**
 * H3's native size, and what above it actually buys. Above native is not bad so
 * much as unproven and expensive; below it is the clearly bad move (40% of
 * native pixels measured 2.7x worse). 1792x1008 is the knee — the first size
 * where a 1-2 px feature survives — and 1920x1088 buys nothing over it for 22%
 * more wall clock.
 */
export const H3_NATIVE = { w: 1344, h: 768, knee: { w: 1792, h: 1008 }, cite: COST_DOCS.faces };
export const LTX_NATIVE = { w: 1280, h: 704, cite: COST_DOCS.directing };

/* ─────────────────────────────────────────── what each tool costs to run */

/**
 * FREE. Read-only, or a write to the document with no model behind it. These
 * cost zero GPU-minutes and saying so is the point: a plan whose twelve items
 * are eleven edits and one render should read as one render.
 */
export const FREE_TOOLS = new Set([
  "mv_shot", "mv_lint", "mv_crime_board", "mv_set_shot", "mv_shot_plan",
  "mv_set_board", "mv_set_bible", "mv_bible_spec", "mv_add_asset", "mv_update_asset",
  "mv_pick_take", "mv_import_asset", "mv_import_clip", "mv_import_song",
  "mv_read_timeline", "mv_build_timeline", "mv_open_project", "mv_list_projects",
  "mv_segment", "mv_update_segment", "mv_set_brief", "mv_analyze", "mv_attach_song",
  "mv_previz_moves", "mv_blender_catalogue", "mv_control_catalogue",
  /* ⚠ FREE, AND IT HAS TO BE VISIBLY FREE. mv_control_check runs the SAME
   * validation mv_control_render runs, stopped before it stages a byte —
   * ffprobe and nothing else. An agent that saw it in the unpriced column,
   * or priced anywhere near the render it guards, would stop asking, and
   * the whole point of the free check is that asking is never the
   * expensive option. Same argument mv_regen_stale's dry run gets. */
  "mv_control_check",
  /* ffmpeg on the CPU: scale, crop, retime, no GPU. Free for the same reason
   * the check is — it is the step that makes an off-contract clip legal, and
   * pricing it would teach an agent to skip it and burn the render. */
  "mv_control_conform",
  /* Reads config and stats a few files. Free for the same reason
   * mv_control_check is: it is the call that TELLS an agent the expensive one
   * would refuse, so it must never be the expensive option itself. */
  "mv_mesh_status",
]);

/**
 * THE CLIP TOOLS. ~95% of the cost of a video lives in exactly these two —
 * "Sheets are seconds, boards are minutes, clips are hours" (DIRECTING §4) —
 * which is why they are the only ones that get the size/engine/steps model.
 */
export const CLIP_TOOLS = new Set(["mv_generate_clip", "mv_regen_clip", "mv_regen_stale"]);

/**
 * Everything else that spends the GPU, at a flat rate with its source. Cheap
 * enough that a table would be false precision, expensive enough that zero
 * would be a lie.
 */
export const FLAT_TOOLS = {
  mv_generate_asset: {
    per: "take", minutes: 0.5, defaultCount: 4,
    why: "Sheets are seconds, boards are minutes. A 4-variant strip is one text encode and "
      + "four samples — the tool's own description says 10-30 s.",
    cite: COST_DOCS.directing,
  },
  mv_blender_sheet: {
    per: "angle", minutes: 0.2, defaultCount: 3,
    why: "One deterministic Blender render per angle, plus a cold launch on a loaded machine. "
      + "The default is the reference-photograph three.",
    cite: COST_DOCS.directing,
  },
  mv_previz_shot: {
    per: "call", minutes: 0.5, defaultCount: 1,
    why: "Blocks a camera move and may render a reference frame after it — the tool's own "
      + "description measures 23 s for 121 frames plus a 512 px panel.",
    cite: COST_DOCS.directing,
  },

  /* ── STRUCTURAL CONTROL, and the two rows are two orders of magnitude apart
   * on purpose: half an hour against half a minute. An agent that priced them
   * the same would either be told a night of skeletons costs a fortnight, or —
   * far worse — be told twelve VACE renders cost six minutes.
   *
   * ⚠ NEITHER IS A MEASUREMENT OF THIS INSTALL. They are single renders from
   * the gate, on one rig, on one night, and `controlMinutes` replaces them with
   * this machine's own ledger the moment it has a run to read. Until then the
   * estimate carries `unmeasuredHere: true`, because a number from a document
   * and a number from this card are both worth having and must not look alike. */
  mv_control_render: {
    per: "call", minutes: 32, defaultCount: 1,
    why: "One 1280x704 x 121-frame WAN 2.1 VACE pass measured 31.99 minutes on this rig, "
      + "engine clock, execution_start to execution_success; the pose gate's second render "
      + "measured 33.87. There is nothing to scale by — VACE builds exactly one size, one "
      + "step count and one frame count — so this is a constant rather than a curve.",
    cite: COST_DOCS.control,
  },
  /* ── THE SECOND DOOR'S TWO TOOLS ─────────────────────────────────────────
   *
   * ⚠ NEITHER NUMBER IS A MEASUREMENT OF ANYTHING. Both were written before
   * the venv existed, and this table's whole discipline is that its figures
   * are timed. They are here anyway because the alternative is worse: an
   * action an agent can call, which spends the one graphics card, and which
   * the §11 budget meter cannot see at all. An unpriced spend is not a
   * cautious estimate — it is a zero.
   *
   * They will be replaced by this install's own ledger the moment it holds a
   * completed mesh run, exactly as controlMinutes() replaces the stated 32
   * for VACE. Until then the shape of the guess is stated so it can be
   * argued with: most of it is loading roughly 7 GB of weights off disk, and
   * the sampling is a fraction of a clip render.
   *
   * `per: "stage"` — a mesh asked to rig itself in the same pass is TWO
   * model loads and two stages, which is the one thing about this cost the
   * arguments can actually say. */
  mv_mesh_from_image: {
    per: "stage", minutes: 4, defaultCount: 1,
    why: "⚠ STATED, NOT MEASURED — nothing here has run TripoSG yet. The shape of the guess: about 7.4 GB of weights loaded off disk, then a rectified-flow sample that is a fraction of a clip render. A rig in the same pass counts as a second stage. The first completed run replaces this.",
    cite: COST_DOCS.mesh,
  },
  mv_mesh_rig: {
    per: "call", minutes: 2, defaultCount: 1,
    why: "⚠ STATED, NOT MEASURED. Smaller than the mesh beside it — it reads a mesh rather than sampling one — and it is the same card, which is why it is priced at all rather than treated as free.",
    cite: COST_DOCS.mesh,
  },
  mv_pose_extract: {
    per: "call", minutes: 0.5, defaultCount: 1,
    why: "DWPose is a per-frame forward pass, not a diffusion sampler: 26.4 s for 121 frames "
      + "at 1280x704, measured by the pose gate. The skeleton it writes is itself a valid "
      + "control clip, which is why looking at one before spending the render is cheap.",
    cite: COST_DOCS.control,
  },
  mv_depth_extract: {
    per: "call", minutes: 0.5, defaultCount: 1,
    why: "⚠ STATED, NOT MEASURED until a depth extraction is in this install's ledger. Depth "
      + "Anything V2 is a per-frame forward pass like DWPose, so the pose extraction's 26.4 s "
      + "for 121 frames is the shape of the guess; controlMinutes() replaces it with the "
      + "ledger's own median the moment one exists.",
    cite: COST_DOCS.control,
  },
};

/**
 * THE TWO HALVES OF A CONTROL RENDER, and the ledger handle for each.
 *
 * `via` is the engine record's field for "which part of the app spent those 32
 * minutes". It is what a control render is findable by — the tool name never
 * reaches the ledger, and the model name cannot tell a camera pass from the
 * VACE half of a pose pass.
 */
export const CONTROL_VIA = {
  vace: "mv.control",
  pose: "mv.control.pose",
  depth: "mv.control.depth",
};

/** The plannable tools this file prices as control renders. */
export const CONTROL_TOOLS = new Set(["mv_control_render", "mv_pose_extract", "mv_depth_extract"]);

/**
 * WHAT ONE MODE ACTUALLY RUNS. The reason an estimate has to read the mode at
 * all: `pose` is TWO renders and `extract` is neither of the expensive one.
 */
export function controlParts(tool, mode) {
  if (tool === "mv_pose_extract" || mode === "extract") return { pose: true, depth: false, vace: false };
  if (tool === "mv_depth_extract" || mode === "extract_depth") return { pose: false, depth: true, vace: false };
  if (mode === "check" || mode === "conform") return { pose: false, depth: false, vace: false };
  if (mode === "pose") return { pose: true, depth: false, vace: true };
  if (mode === "depth") return { pose: false, depth: true, vace: true };
  return { pose: false, depth: false, vace: true };
}

/**
 * THE MEASUREMENT, WHEN THIS INSTALL HAS ONE — out of the engine ledger.
 *
 * ⚠ WHY THIS EXISTS BESIDE A PERFECTLY GOOD CONSTANT. The rows above are real
 * numbers with a document behind them, but they are one night's renders on one
 * rig with nothing else on the card. The ledger knows what a control render
 * costs HERE, today, with this queue — and unlike the clip path there is
 * nothing to scale, because VACE builds exactly one operating point. So a
 * single completed run of that `via` is a better number than the constant.
 *
 * ONE SAMPLE IS ENOUGH, and that is a deliberate difference from regen.js's
 * `measuredMinutesPerClip`, which insists on two. That function infers a
 * render's length from the GAP BETWEEN two rows in a runs list, and one gap is
 * a coincidence — it could be a coffee break. This reads `elapsedSec` off the
 * engine's own terminal event, which is a measurement of the render itself.
 *
 * A CACHED RUN IS NOT A RENDER. ComfyUI serves an identical graph out of its
 * own node cache — measured 258 s -> 0.3 s — and the door flags it. Folding a
 * cache hit into the median would quote half a minute for half an hour of
 * work, so they are dropped.
 *
 * Pure: handed rows, returns a number. Reading the ledger is the route's job,
 * exactly as reading the document is.
 */
export function controlMeasuredFrom(runs, via) {
  const rows = (runs || []).filter((r) => r && r.via === via
    && r.status === "completed" && r.cached !== true
    && Number.isFinite(Number(r.elapsedSec)) && Number(r.elapsedSec) > 0);
  if (!rows.length) return null;
  const mins = rows.map((r) => Number(r.elapsedSec) / 60).sort((a, b) => a - b);
  /* The MEDIAN, not the mean: one run that hit a cold model load or queued
   * behind a song would drag an average a long way, and a plan's headline is
   * what somebody reads at bedtime. */
  return {
    minutes: Math.round(mins[Math.floor(mins.length / 2)] * 10) / 10,
    samples: rows.length,
    fastest: Math.round(mins[0] * 10) / 10,
    slowest: Math.round(mins[mins.length - 1] * 10) / 10,
  };
}

/**
 * Minutes for one control item: this install's own median where the ledger has
 * one, the stated constant where it does not, and the difference SAID OUT LOUD.
 *
 * `unmeasuredHere` is the tag that matters. An estimate taken from a document
 * rather than from this machine is still worth having — it is the difference
 * between "about half an hour" and no number at all — but a reader has to be
 * able to tell the two apart, and `basis` cannot say it on its own because a
 * flat row is legitimately flat either way.
 *
 * @param measured  { [via]: {minutes, samples, fastest, slowest} | null }, from
 *                  controlMeasuredFrom. Absent means nobody looked, which is
 *                  reported as the constant rather than as zero.
 */
export function controlMinutes(tool, { mode = null, measured = null } = {}) {
  if (!CONTROL_TOOLS.has(tool)) return null;
  const parts = controlParts(tool, mode);
  /* ⚠ FREE, AND SAID AS FREE. A `check` measures the clip with ffprobe and
   * renders nothing, so charging it 32 minutes would teach an agent that
   * finding out whether a clip is legal costs the same as the render — which
   * is the fastest way to make it stop checking. Same rule mv_regen_stale's
   * dry run gets, for the same reason. */
  if (!parts.pose && !parts.depth && !parts.vace) {
    return { minutes: 0, free: true, basis: "free", unmeasuredHere: false, renders: 0,
             mode: mode || "check", cite: COST_DOCS.control,
             why: mode === "conform"
               ? "ffmpeg on the CPU — scale, crop, retime — and renders nothing"
               : "measures the clip against the three numbers with ffprobe and renders nothing" };
  }
  const legs = [];
  if (parts.pose) legs.push({ row: "mv_pose_extract", via: CONTROL_VIA.pose, what: "the DWPose extraction" });
  if (parts.depth) legs.push({ row: "mv_depth_extract", via: CONTROL_VIA.depth, what: "the Depth Anything V2 extraction" });
  if (parts.vace) legs.push({ row: "mv_control_render", via: CONTROL_VIA.vace, what: "the VACE render" });

  let minutes = 0;
  const from = [];
  let allMeasured = true;
  for (const leg of legs) {
    const m = measured?.[leg.via] ?? null;
    if (m && Number.isFinite(Number(m.minutes))) {
      minutes += Number(m.minutes);
      from.push(`${leg.what}: ${m.minutes} min, the median of ${m.samples} in this install's `
        + `ledger (${m.fastest}-${m.slowest})`);
    } else {
      allMeasured = false;
      minutes += FLAT_TOOLS[leg.row].minutes;
      from.push(`${leg.what}: ${FLAT_TOOLS[leg.row].minutes} min, the stated constant from `
        + `${FLAT_TOOLS[leg.row].cite} — nothing of this kind is in this install's ledger yet`);
    }
  }
  return {
    minutes: Math.round(minutes * 10) / 10,
    basis: allMeasured ? "measured" : "flat",
    unmeasuredHere: !allMeasured,
    renders: legs.length,
    mode: mode || (parts.vace ? "camera" : "extract"),
    cite: COST_DOCS.control,
    measuredFrom: from.join("; "),
    why: legs.length === 2
      ? "mode \"pose\" is two renders: DWPose first, then VACE on the skeleton."
      : FLAT_TOOLS[legs[0].row].why,
  };
}

/**
 * WHICH ROUTE ACTION SPENDS WHAT — the spend meter's only translation, written
 * down here beside the prices rather than guessed at the door.
 *
 * ⚠ WHY THIS EXISTS AT ALL, since a second table is normally the thing this
 * codebase refuses. The plan prices ITEMS, and an item names an MCP TOOL; the
 * meter has to price a REQUEST, and a request names a route ACTION with the
 * route's own argument spelling. The two vocabularies are real and they differ,
 * so the choice is between one six-line adapter with the names in it and a
 * meter that reads zero forever. It is NOT an execution path — nothing here
 * calls anything; `args` only re-labels a body so the SAME estimator prices it.
 *
 * plan_test.js pins both ends: every action here is one the dispatch really
 * has, and every tool here is one this file really prices.
 */
export const SPENDING_ACTIONS = {
  generate_clip: { tool: "mv_generate_clip", args: (b) => ({ segment: b.segmentId }) },
  regen_clip: { tool: "mv_regen_clip", args: (b) => ({ segment: b.segmentId }) },
  regen_stale: {
    tool: "mv_regen_stale",
    /* The route's default is a DRY RUN, and a dry run spends nothing — the
     * estimator already returns free for one, so the default has to survive
     * the relabelling or every report would be charged as a sweep. */
    args: (b) => ({ limit: b.limit, dry_run: b.dryRun !== false }),
  },
  generate_asset: { tool: "mv_generate_asset", args: (b) => ({ count: b.count }) },
  blender_asset: { tool: "mv_blender_sheet", args: (b) => ({ angles: b.angles }) },
  previz_shot: { tool: "mv_previz_shot", args: () => ({}) },
  /* ONE action, three modes, two prices. The meter has to carry the MODE
   * through, because "extract" is a half-minute skeleton and the other two are
   * half an hour of VACE — and charging the cheap one for the expensive one is
   * how an agent's budget stops meaning anything. */
  control_render: { tool: "mv_control_render", args: (b) => ({ mode: b.mode }) },
  /* THE MESH PAIR. `rig` travels because it is the argument that changes the
   * price — one stage or two — and because a meter that charged a rigged mesh
   * as an unrigged one is a budget that quietly under-reports the expensive
   * choice, which is the direction that costs somebody a night. */
  mesh_asset: { tool: "mv_mesh_from_image", args: (b) => ({ rig: b.rig === true }) },
  mesh_rig: { tool: "mv_mesh_rig", args: () => ({}) },
};

/* ────────────────────────────────────────────────────── the arithmetic */

/**
 * The row that models this engine at this step class, or null.
 *
 * Preference within a class: the row whose AREA is closest to what is being
 * asked for, in log space. Scaling a measurement a short way is a smaller
 * inference than scaling one a long way, and both rows are equally cited.
 */
export function costRowFor(engine, stepClass, { w, h, pass } = {}) {
  const rows = COST_ROWS.filter((r) => r.engine === engine && r.stepClass === stepClass
    && (!pass || !r.pass || r.pass === pass));
  if (!rows.length) return null;
  const area = Number(w) * Number(h);
  if (!Number.isFinite(area) || area <= 0) return rows[0];
  return rows.reduce((best, r) =>
    Math.abs(Math.log((r.w * r.h) / area)) < Math.abs(Math.log((best.w * best.h) / area)) ? r : best);
}

/**
 * Minutes for one clip render, from the table.
 *
 * Returns null when no row models this engine — an ABSENT estimate is reported
 * as absent, never as a zero and never as a guess. That is the Ear's rule and
 * it is the whole reason `totals.unpriced` exists.
 */
export function tableMinutes({ engine, steps, width, height, seconds, refs = true, pass }) {
  /* ⚠ LTX HAS NO STEP CLASS. Its graph runs two fixed passes (8 steps at half
   * size, then 3 at full — workflow.js videoGraphLtx takes no step count) and
   * every LTX row above is measured as "bare". Classing an LTX scene by the
   * brief's step count found no row for 4 or 8 and called the scene unpriced:
   * a cast-less scene under hybrid, or any errand (its brief always carries the
   * order's steps), read as "about 0 min" wherever a total was printed. The
   * H3 overrun note is about an H3 file and says nothing about LTX either. */
  const ltx = engine === "ltx";
  const stepClass = ltx ? "bare" : stepClassOf(steps, { refs });
  const row = costRowFor(engine, stepClass, { w: width, h: height, pass });
  if (!row) return null;
  const area = Number(width) * Number(height);
  const secs = Number(seconds);
  if (!Number.isFinite(area) || area <= 0 || !Number.isFinite(secs) || secs <= 0) return null;
  const minutes = (row.wall / 60)
    * Math.pow(area / (row.w * row.h), AREA_EXP)
    * Math.pow(secs / row.seconds, SECONDS_EXP);
  return {
    minutes: Math.round(minutes * 10) / 10,
    basis: "table",
    row: row.id,
    stepClass,
    cite: row.cite,
    measuredAt: `${row.w}x${row.h}, ${Math.round(row.seconds * 10) / 10} s, ${row.wall} s wall`,
    /* The bracket, carried per estimate rather than printed once in a footnote
     * nobody reads. See COST_SPREAD. */
    upperMinutes: Math.round(minutes * COST_SPREAD.factor * 10) / 10,
    floor: !ltx && trapBand(steps, { refs })
      ? `${steps} steps overruns the ${loadedLoraSteps(steps, { refs })}-step file that loads — this is a floor, not a figure`
      : null,
  };
}

/** Minutes for a non-clip tool that still spends the GPU, or null if it is not
 *  one of them. `count` is the tool's own multiplier (variants, angles). */
export function flatMinutes(tool, count) {
  const f = FLAT_TOOLS[tool];
  if (!f) return null;
  const n = Number.isFinite(Number(count)) && Number(count) > 0 ? Number(count) : f.defaultCount;
  return {
    minutes: Math.round(f.minutes * n * 10) / 10,
    basis: "flat", per: f.per, count: n, cite: f.cite, why: f.why,
  };
}

/** A human duration. "4 h 10 m", "39 m", "under a minute". */
export function humanMinutes(mins) {
  const m = Number(mins);
  if (!Number.isFinite(m) || m < 0) return null;
  if (m < 1) return "under a minute";
  const h = Math.floor(m / 60), r = Math.round(m % 60);
  return h ? `${h} h ${String(r).padStart(2, "0")} m` : `${Math.round(m)} m`;
}
