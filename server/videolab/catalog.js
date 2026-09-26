/**
 * Video lab — THE DATA. Nothing here renders anything; it is what the Video
 * panel and the MCP tools both read so that neither has to know a number.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * THE BINDING PRINCIPLE (web/daw.js states it, server/videolab/ui_test.js
 * enforces it): everything MCP-controllable AND completely human-adjustable,
 * ONE document behind both. So the comparison configs, the size guidance and
 * the toggles are DATA — three exported lists — and both surfaces render the
 * same rows. A toggle somebody adds next week is a row in KNOBS, not a new
 * control in the HTML and a new field in the tool schema and a third copy of
 * the reason in a comment. That is the owner's ask in one sentence: "every day
 * people put out new workflows", so a new switch must be a row, not a rebuild.
 *
 * WHY THE PROSE IS IN HERE AND NOT IN THE PAGE. Every `effect` string below is
 * shown to a human beside the control it describes, and handed to an agent in
 * the tool description. Writing it once is the only way those two can agree.
 * The rule for the text: say what it does TO THE PICTURE, then what it costs.
 * A control whose sentence is "sets the sigma shift" teaches nobody anything.
 *
 * ⚠ EVERY NUMBER IS CITED. `cite` on a row is a real path in this repo, and the
 * next person is expected to re-measure rather than to trust me. Nothing in
 * this file is an estimate, a round number or a recollection — where a figure
 * was not measured, the row says so in its own words instead of quoting one.
 *
 * The three documents everything here comes from:
 *   docs/RESOLUTION_FOR_FACES.md   six H3 renders, one prompt, one seed, one
 *                                  reference, 56 frames, only the size varied
 *   docs/H3_REFERENCE_BLEED.md     why a reference occupies the opening frames
 *                                  of a 4-step clip, traced from ComfyUI source
 *   server/config.js               the engines themselves: weights, licences,
 *                                  sizes with measured times, the turbo machinery
 */
import { config } from "../config.js";
import { h3SigmaShiftFor, shiftSigmas, videoEngine, videoSizeFor } from "../workflow.js";
/* The licence facts, READ rather than retyped — see ENGINE_LICENCE for what
 * retyping them cost. server/welcome/catalogue.js already reads from here, and
 * this file disagreeing with that one is the failure both are guarding. */
import { CATALOG, MODEL_TO_CAPABILITY } from "../models.js";

/* Where the measurements live, so a citation is one constant rather than a
 * string typed out nine times and mistyped on the tenth. */
export const DOCS = {
  faces: "docs/RESOLUTION_FOR_FACES.md",
  bleed: "docs/H3_REFERENCE_BLEED.md",
  config: "server/config.js",
  directing: "DIRECTING.md",
  shot: "server/mv/shot.js",
  graph: "server/workflow.js",
  stills: "scripts/clipstills.py",
};

/**
 * THE FRAME-LOCKED STILL STRIP — which frames, and why those.
 *
 * Data rather than a number in the page, for the same reason every other figure
 * on this surface is: both hands must ask for the same default, and the day
 * somebody re-measures, one row moves and both surfaces say the new thing.
 *
 *   0   the opening frame, which is where reference bleed lives. A sampler that
 *       politely skips the first few percent — clipframes.py does, correctly,
 *       for its own job — cannot see the finding docs/H3_REFERENCE_BLEED.md is
 *       about, and the 4-step arm is exactly the one it bites.
 *   15  a little over half a second in at 24 fps: past the opening, before any
 *       arm has run out of frames, and the first place the motion has committed
 *       to something.
 *   60  late, and on this app's own clip lengths usually past the end.
 *       Deliberate: the clamp then fires, the strip says which arm is the short
 *       one, and the shortest arm's LAST frame is where a frozen tail hides.
 *
 * Clamped to the SHORTEST arm, never per arm — see scripts/clipstills.py for
 * why a per-arm clamp is a lie with a number on it.
 */
export const STILL_FRAMES = {
  default: [0, 15, 60],
  max: 8,
  why: "The same numbered frames out of every arm, extracted at full resolution. Frame 0 is in "
    + "the set because that is where a reference bleeds into a turbo clip; the last number is "
    + "meant to overshoot, so the strip clamps to the shortest arm and names it.",
  cite: "scripts/clipstills.py",
};

/* ══════════════════════════════════════════════════════════════════════════
 * 1. THE COMMIT POINT — the one piece of arithmetic in this file
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `res_multistep` takes a plain Euler step when sigma_down == 0, so the clip
 * you receive IS the model's x0 prediction at the last sigma it evaluated.
 * That number is the whole story of the turbo path, and it is computable from
 * the two settings the user is looking at — so the panel computes it live
 * instead of quoting a table that only covers four step counts.
 *
 * Reusing `shiftSigmas` rather than restating sigma = shift·t / (1 + (shift-1)·t)
 * is deliberate: it is the schedule the engine actually runs, and a second copy
 * of a formula is a second thing to get wrong. Verified against every row of
 * docs/H3_REFERENCE_BLEED.md's table — shift 12 gives 0.800 / 0.632 / 0.387 /
 * 0.333 at 4 / 8 / 20 / 25 steps, and shift 3 gives 0.500 at 4 steps, which are
 * the exact figures that document reports.
 */
export function commitSigma(steps, shift) {
  const n = Math.max(1, Math.round(Number(steps) || 1));
  const s = Number(shift);
  if (!Number.isFinite(s) || s <= 0) return null;
  const sig = shiftSigmas(n, s);
  return sig[n - 1] ?? null;          // the last EVALUATED sigma; sig[n] is 0
}

/**
 * The commit point in a sentence a person can act on.
 *
 * The threshold words are chosen from the two anchors the bleed document
 * actually establishes — 0.800 is where a reference visibly occupies the
 * opening frames, 0.387 is the 20-step quality path — and everything between
 * them is described by proximity rather than by a claim nobody measured.
 */
export function commitNote(steps, shift) {
  const s = commitSigma(steps, shift);
  if (s == null) return "";
  const pct = Math.round(s * 100);
  const where = s >= 0.75
    ? `the model invents ${pct}% of the picture in one jump, and the cleanest thing in its field of view is your reference — this is the band where a reference occupies the opening frames`
    : s >= 0.55
      ? `${pct}% of the picture still arrives in the last jump; better than the 0.800 default but not yet a converged render`
      : s >= 0.42
        ? `${pct}% left to invent — past the band where references bleed, short of the quality path`
        : `${pct}% left to invent, which is the converged end of the range`;
  return `commits at sigma ${s.toFixed(3)} — ${where}.`;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. SIZE GUIDANCE — the selector that explains itself
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The owner's ask: "when we gen we want the highest native quality we can use
 * … we can upscale but it loses details. make it easy to select this in your
 * video creator. and explain what happens when. make a user understand it."
 *
 * So every size carries the measured consequence of choosing it, in one
 * sentence, and the list is not limited to what config.js happens to offer —
 * because the size the measurements name as best IS NOT IN THAT LIST. 1792x1008
 * is the knee and H3's `sizes` array does not contain it. A quality selector
 * that cannot select the measured optimum is a decoration, so `EXTRA_SIZES`
 * adds it and says, in the row itself, why it is not upstream.
 */

/**
 * NATIVE, CAPTURED AT IMPORT — and this is not a micro-optimisation, it is a
 * correctness fix the field-contract test caught.
 *
 * `sizesFor` marks native / above / below by comparing each row to the engine's
 * declared width x height. But `set_quality` WRITES those very fields — that is
 * deliberate, because they are the default every render falls back to, so the
 * selection has to live there. The consequence, if native were read live: pick
 * the knee, and 1792x1008 relabels itself "native" while the real native
 * relabels itself "below native". The entire list would rewrite its own meaning
 * to agree with whatever you last clicked.
 *
 * catalog.js is evaluated before store.js (which imports it) and long before
 * any route can write, so these are what server/config.js shipped: the size the
 * model was actually trained at, which is the only thing "native" can mean.
 */
const NATIVE = Object.fromEntries(
  Object.entries(config.video.engines).map(([k, e]) => [k, (e.width || 0) * (e.height || 0)]),
);

/** Sizes the measurements found and the engine's own list does not offer. */
const EXTRA_SIZES = {
  h3: [
    { w: 1792, h: 1008, label: "1792 x 1008 · the knee — measured best for faces" },
  ],
  ltx: [],
};

/**
 * What each size DOES, measured. Keyed "WxH" per engine.
 *
 * Absent from this table means absent from the sweep: the row then says nothing
 * rather than inventing a consequence, and `measured: false` tells the UI to
 * present it as an offered size rather than a known one. Six sizes were
 * measured on H3 and four on LTX; both engines offer more than that.
 */
const SIZE_NOTES = {
  h3: {
    "1344x768":
      "Native, and the floor for faces: a 58 px face whose eyelid crease, lash line and "
      + "nostril are simply absent, and whose mouth is a smear. 275.6 s for 56 frames.",
    "1792x1008":
      "THE KNEE. 84 px face — the first size where a whole class of 1-2 px feature survives "
      + "(lash line, brow hairs, nostril wing, defined nose tip). 591.2 s for 56 frames, and "
      + "1.75x the model's declared canvas, so it renders cleanly but is not trained territory.",
    "1920x1080":
      "Buys nothing over 1792x1008 and costs 22% more: measured at 1920x1088, the face and "
      + "mouth figures come back identical for 721.4 s against 591.2 s.",
    "1536x864":
      "The most useful result in the sweep, and a warning: it cost 36% MORE than native and "
      + "produced the SMALLEST face on the ladder (50 px), because the model chose to frame the "
      + "subject further away. More pixels, smaller face. Size does not control framing.",
    /* ⚠ NOT IN THE SWEEP. This row used to read "measured 2.7x worse on detail
     * when paired with a short clip" and cite docs/RESOLUTION_FOR_FACES.md,
     * which says no such thing: 2.7x is that document's COST span across the
     * size ladder (GPU-hours), not a detail metric, and 864x480 was never
     * rendered — the six sweep sizes were 1344x768, 1536x864, 1664x936,
     * 1792x1008, 1920x1088 and a second seed at native. A cost figure wearing a
     * quality figure's clothes, attached to an unmeasured size, under a
     * citation that made it look checked. The pixel ratio below is arithmetic
     * and stays; the rest is what config.js honestly claims for it. */
    "864x480":
      "40% of native pixels — the smallest size offered. Not in the face sweep, so there is no "
      + "measured face figure for it; config.js calls it fast and noticeably softer, and the "
      + "sweep's finding that detail collapses below native is the reason to believe that.",
  },
  ltx: {
    "1280x704":
      "Native. Two passes — most of the sampling at half size, a latent x2 upscale, then a "
      + "short refine. 121 s for 5 s with sound.",
    "1920x1088": "About 75 s per 2 seconds of clip, measured warm on this rig.",
    "2560x1408": "About 3.5 minutes per 2 seconds of clip, measured warm on this rig.",
    "3840x2112":
      "About 6 minutes per 2 seconds, and it holds: at the same seed this resolves individual "
      + "railing balusters where 1280x704 has only a suggestion of a railing, with no repetition "
      + "or smearing despite being far outside the training size.",
  },
};

/**
 * THE SIZES A RENDER WAS ACTUALLY DONE AT, per engine.
 *
 * Separate from SIZE_NOTES on purpose. `measured` used to be derived from
 * "does this size have a note", which made writing a sentence about a size
 * equivalent to having rendered one — and that is precisely how 864x480 came
 * to carry a face measurement for a clip that was never made. A note is
 * commentary and may be written about anything; this list is a claim about
 * what a GPU did, and it changes only when one does something new.
 *
 * H3: the six-render sweep in docs/RESOLUTION_FOR_FACES.md (1664x936 was in it
 * but is not an offered size, so it never appears in a row).
 * LTX: the sizes carrying measured wall-clocks in server/config.js.
 */
const SWEPT = {
  h3: ["1344x768", "1536x864", "1664x936", "1792x1008", "1920x1088"],
  ltx: ["1280x704", "1920x1088", "2560x1408", "3840x2112"],
};

/**
 * THE THREE THINGS A PERSON HAS TO KNOW BEFORE PICKING A SIZE, and they are not
 * per-size facts, so they sit beside the list rather than inside it.
 *
 * These are shown as prose above the selector. They are the difference between
 * a dropdown and an explanation, and each is the headline finding of a document
 * rather than a summary of one.
 */
export const SIZE_RULES = [
  {
    id: "framing",
    headline: "Framing is the lever. Size is not.",
    body:
      "Set the bar at a mouth you could lip-sync to — about 96 px of face — and NO size on the "
      + "ladder reaches it, 1920x1088 included. What reaches it is the shot: reframe a "
      + "performance chest-up and 1792x1008 clears the bar with margin; stay knees-up and no "
      + "render size rescues it. Write the framing into the prompt before you spend on pixels.",
    cite: DOCS.faces,
  },
  {
    id: "upscale",
    headline: "Upscaling invents detail. It does not recover it.",
    body:
      "An upscaler has nothing to read the lash line off, so it draws a plausible one. Render "
      + "native or above and you keep what the model actually resolved; render small and enlarge "
      + "and you keep a confident guess. Enhance is still worth having for motion — it is not a "
      + "way to buy back a face.",
    cite: DOCS.faces,
  },
  {
    id: "length",
    /* WITHDRAWN AND REPLACED 2026-09-10 — see the same note in
     * server/welcome/catalogue.js. The 56-to-209 frame band this card used to
     * quote was the cost model run over lengths nothing on this rig has
     * rendered, and it is wrong at the top end. */
    headline: "Length is cheap until it isn't, and we never rendered the cliff.",
    body:
      "Inside the measured range, size is the bill: the ladder alone is a 2.7x span and length costs "
      + "almost nothing. Above roughly 331k latent tokens that stops holding — an outside replication "
      + "over 158 renders measured 30% more frames costing 2.6x, with hard out-of-memory failures. "
      + "The largest render behind these numbers is 149k tokens; 1792x1008 at 209 frames is 437k, "
      + "well past the cliff. Cut to the music inside the range we measured, and treat a long clip at "
      + "a large size as unmeasured rather than cheap.",
    cite: DOCS.faces,
  },
];

/**
 * Every size this engine can be asked for, annotated.
 *
 * `native` / `aboveNative` / `belowNative` are computed against the engine's own
 * declared width x height rather than declared per row, so a config edit moves
 * the marks automatically — the alternative is a hand-maintained flag that goes
 * stale the first time somebody changes a default.
 *
 * `delivered` is what the pipeline will REALLY produce. It goes through
 * videoSizeFor, the one place that arithmetic lives, for the reason its own
 * comment gives: this app shipped a "960 x 544" option that rendered 512 for
 * months. ⚠ H3's branch of that function currently quantises NOTHING, while the
 * H3 node builds its latent as height//16 and decodes at latent*16 — measured,
 * 1664x936 requested and 1664x928 delivered. Until that branch models grid 16,
 * a size whose axes are not multiples of 16 will be delivered smaller than this
 * says. `gridWarning` names it rather than papering over it.
 */
export function sizesFor(engineKey) {
  const key = engineKey === "ltx" ? "ltx" : "h3";
  const eng = config.video.engines[key] || {};
  const notes = SIZE_NOTES[key] || {};
  // The SHIPPED size, not the currently selected one — see NATIVE above.
  const nativePx = NATIVE[key] || 0;
  const offered = [...(eng.sizes || []), ...(EXTRA_SIZES[key] || [])];

  return offered.map((z) => {
    const px = z.w * z.h;
    const ratio = nativePx ? px / nativePx : null;
    const delivered = videoSizeFor(key, z.w, z.h);
    /* H3 floors each axis to a multiple of 16 INSIDE the node, which
     * videoSizeFor does not yet model — so the check is done here and reported,
     * not silently corrected. Correcting it here would put the arithmetic in
     * two places, which is the exact failure videoSizeFor exists to prevent. */
    const grid16 = key === "h3" && (z.w % 16 !== 0 || z.h % 16 !== 0);
    return {
      id: `${z.w}x${z.h}`,
      w: z.w, h: z.h, label: z.label,
      // Sizes we added because the sweep named them and config.js does not list them.
      added: (EXTRA_SIZES[key] || []).some((e) => e.w === z.w && e.h === z.h),
      /* NATIVE IS A PIXEL BUDGET, NOT A SHAPE. The node's MAX_PIXELS is
       * 768 x 1344, so the portrait entry is at exactly the same budget as the
       * landscape one and is just as native — which the first version of this
       * got right by accident and reported confusingly, marking two rows
       * "native" with no way to tell them apart. `portrait` carries the
       * difference so the badge can say which, instead of the reader having to
       * work out why the list appears to have two natives in it. */
      native: !!nativePx && px === nativePx,
      portrait: z.h > z.w,
      aboveNative: !!nativePx && px > nativePx,
      belowNative: !!nativePx && px < nativePx,
      ofNative: ratio == null ? null : Math.round(ratio * 100),
      deliveredW: delivered.width, deliveredH: delivered.height,
      gridWarning: grid16
        ? `H3 builds its latent as height//16 and decodes at latent*16, so this will be delivered `
          + `at ${Math.floor(z.w / 16) * 16} x ${Math.floor(z.h / 16) * 16}. Measured: 1664x936 `
          + `requested, 1664x928 received.`
        : null,
      /* WAS `!!notes[...]`, which quietly redefined "measured" as "we wrote a
       * sentence about it" — and 864x480 had a sentence, so an agent reading
       * video_quality was told an unrendered size had been measured. A note is
       * commentary; the sweep is a fact, so the sweep gets its own list. */
      measured: SWEPT[key]?.includes(`${z.w}x${z.h}`) ?? false,
      note: notes[`${z.w}x${z.h}`] || null,
      /* What "above native" means, said once per row that needs it, because
       * "untrained territory that still renders" is a genuinely useful thing to
       * know and nobody reads a footnote. */
      territory: !nativePx ? null
        : px === nativePx ? (z.h > z.w
          ? "Native, rotated. Exactly the model's pixel budget, stood on its end — the same "
            + "cost and the same training territory as the landscape native, and every "
            + "measurement in the sweep was taken landscape."
          : "Native. The size the model was trained at.")
        : px > nativePx
          ? "Above native — untrained territory that still renders. Both over-native H3 sizes "
            + "came back clean, but neither is a supported mode, and there is no H3 upscaler node "
            + "in ComfyUI 0.33.0 to fall back on."
          /* ⚠ This line used to end "measured 2.7x worse on detail when paired
           * with a short clip", which was a misread of the cost span and was
           * shown on rows the same card had just labelled "Not in the sweep".
           * The sweep DID measure a below-native effect — it just measured it
           * upward, from native, and the honest form is the one the document
           * supports: 58 px at native is already the floor. */
          : "Below native. Fewer pixels than the model expects, and native already measures a "
            + "58 px face whose mouth is a smear — so this is below the floor, not merely "
            + "cheaper. No size under native was rendered in the sweep.",
      cite: DOCS.faces,
    };
  });
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. KNOBS — the switchable machinery, as rows
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Each row names a real path into `config`, so setting one is a write to the
 * object the graph builders already read. That is what keeps this from becoming
 * a parallel settings system: there is no lab state that the renderer does not
 * see, because the lab state IS the renderer's state.
 *
 * `effect` is the sentence shown next to the control AND handed to the agent.
 * `cite` is where the claim came from. `applies` is which engine it belongs to,
 * because H3's shift means nothing to LTX and LTX's schedule means nothing to H3.
 *
 * ⚠ TWO ROWS BELOW READ FIELDS THAT DO NOT EXIST IN config.js YET —
 * `turboShiftVideo` / `turboShiftAudio` and `refImageSize`. That is deliberate
 * and it is why server/workflow.js reads them as `v.x ?? <today's literal>`:
 * with the knob unset the graph is byte-identical to what it built before, and
 * setting it is the only thing that changes a render. A knob that ships as a
 * no-op until somebody moves it is the safe way to expose an untested lever.
 *
 * ⚠ ONE VALUE IS NEVER OWNED BY TWO ROWS. `turbo_lora` and `turbo_max_steps`
 * used to write the same field with no memory between them, and the bug that
 * cost was silent: set the threshold to 6, switch the LoRA off and on again,
 * and the 6 came back as a hard-typed 12. So the toggle now PARKS whatever the
 * threshold was in `turboMaxStepsWhenOn` (a `remembers` path — same "field
 * config.js does not have yet" trick as above, and nothing else reads it) and
 * restores exactly that. `turbo_max_steps` owns the live number.
 */

/* What "on" restores when nothing has been parked yet — captured AT IMPORT, so
 * it is the threshold this build of config.js shipped rather than a literal
 * typed here. That distinction is the whole bug: a typed 12 outlives the day
 * somebody re-measures the distillation and changes config.js. */
const TURBO_STEPS_SHIPPED = config.video.engines.h3?.turboMaxSteps;

export const KNOBS = [
  /* ── the 4-step LoRA, which is not a checkbox and has to be honest about it ── */
  {
    id: "turbo_lora",
    label: "4-step turbo LoRA",
    applies: "h3",
    kind: "bool",
    path: ["video", "engines", "h3", "turboMaxSteps"],
    /* THE HONEST MAPPING. There is no on/off switch for the distillation — the
     * step count selects which file loads (`useTurbo = steps <= turboMaxSteps`).
     * So "off" is the threshold nothing can be at or below, and the number that
     * was there is PARKED rather than forgotten: `remembers` names where. The
     * row says all of this, because a checkbox that secretly moves a threshold
     * is worse than no checkbox — and one that secretly RESETS it is worse
     * still, which is exactly what a hard-coded `onValue: 12` did here. */
    offValue: 0,
    remembers: ["video", "engines", "h3", "turboMaxStepsWhenOn"],
    remembersDefault: TURBO_STEPS_SHIPPED,
    effect:
      "There is no on/off for the distillation — the STEP COUNT picks the model, and the "
      + "threshold it is compared against is the row below. This switch moves that threshold to 0 "
      + "and back. Off: the bare model runs at every step count, on its own schedule, which is "
      + "what the vendor's own flows do at 20. On: your threshold comes back — the exact number "
      + "you set, parked in `turboMaxStepsWhenOn` while it was off, or the shipped default if you "
      + "never set one. The LoRA at 20 steps over-shoots into crunchy, sparkling texture and 2-3x "
      + "the inter-frame churn — that is the long-standing 'jittery' report. ⚠ Only the live "
      + "threshold survives a restart, so a lab file saved while this is off comes back off, and "
      + "the first switch-on after that restores the shipped default rather than your number.",
    cite: DOCS.config,
  },
  {
    id: "lora_strength",
    label: "Turbo LoRA strength",
    applies: "h3",
    kind: "number", min: 0, max: 1.5, step: 0.05,
    path: ["video", "engines", "h3", "loraStrength"],
    effect:
      "1.0 is the published default; below about 0.75 is where the 'metallic' reports start. "
      + "Worth a deliberate 1.0-vs-0.0 A/B: the LoRA is merged with the stock LoraLoaderModelOnly "
      + "against an int8 checkpoint, and on a quantised base a low-rank delta can be rounded away "
      + "by requantisation. If the two look alike, the LoRA is barely doing anything and every "
      + "other turbo setting is treating a symptom.",
    cite: DOCS.bleed,
  },
  {
    id: "turbo_max_steps",
    label: "Turbo threshold (steps)",
    applies: "h3",
    kind: "number", min: 0, max: 40, step: 1,
    /* THIS ROW OWNS THE NUMBER. `turbo_lora` above only parks it and puts it
     * back, and it parks it HERE, so setting a threshold also refreshes what
     * the switch will restore. Two rows, one field, and neither can surprise
     * the other. */
    path: ["video", "engines", "h3", "turboMaxSteps"],
    remembers: ["video", "engines", "h3", "turboMaxStepsWhenOn"],
    effect:
      "At or below this many steps a turbo LoRA is loaded; above it the bare model runs. "
      + `${TURBO_STEPS_SHIPPED} is the measured setting — the 8-step distillation run at 20 steps `
      + "over-shoots. Raising this past your step count is how you accidentally put a distillation "
      + "on the quality path. This is the same number the switch above turns off: 0 here IS off, "
      + "and any value above 0 is both the live threshold and the one that switch will restore.",
    cite: DOCS.config,
  },
  {
    id: "turbo4_max_steps",
    label: "4-step build threshold",
    applies: "h3",
    kind: "number", min: 0, max: 20, step: 1,
    path: ["video", "engines", "h3", "turbo4MaxSteps"],
    effect:
      "At or below this, the 4-step distillation loads instead of the 8-step one. Both the "
      + "first/last-frame and reference paths have matching 4-step and 8-step builds. The "
      + "reference path prefers ref2v 8-step v1.0 at 8 steps; when that file is missing it "
      + "can fall back to the 4-step build, so check the loaded filename before comparing. "
      + "Use each build at its published step count for a reproducible baseline.",
    cite: DOCS.directing,
  },
  {
    id: "turbo3_max_steps",
    label: "3-step build threshold",
    applies: "h3",
    kind: "number", min: 0, max: 20, step: 1,
    path: ["video", "engines", "h3", "turbo3MaxSteps"],
    effect:
      "At or below this, the 3-STEP distillation (TaoMate-H3, the ComfyUI conversion) loads on the "
      + "first-last-frame path. Its shift is unmeasured here: the table starts it at the base 12/3. "
      + "Reference renders never take it — it was not trained on ref2va — and without the file on "
      + "disk the 4-step build runs at these steps, as it did before.",
    cite: DOCS.config,
  },

  /* ── the sigma shift, and the finding that makes it worth a control ──────── */
  {
    id: "shift_video",
    label: "Sigma shift (quality path)",
    applies: "h3",
    kind: "number", min: 1, max: 16, step: 0.5,
    path: ["video", "engines", "h3", "shiftVideo"],
    effect:
      "The model's own default is 12, and on the QUALITY path that is the measured answer: the "
      + "bare model at 20 steps with shift 12 was the cleanest arm on both seeds tried. Moving it "
      + "here moves the whole schedule, so the panel shows where the render then commits. ⚠ An "
      + "earlier sweep 'found' shift 4 better and it was retracted — every metric's spread "
      + "between shifts was smaller than the seed-to-seed spread at one shift. Change two seeds "
      + "before you believe anything you see here.",
    cite: DOCS.config,
  },
  {
    id: "turbo_shift_video",
    label: "Sigma shift on the turbo path",
    applies: "h3",
    kind: "number", min: 0, max: 16, step: 0.5,
    path: ["video", "engines", "h3", "turboShiftVideo"],
    /* 0 means unset, which is the only value that leaves the graph exactly as
     * it was. Said in the sentence, because "0" reading as "a shift of zero"
     * would be a reasonable and completely wrong guess. */
    unsetAt: 0,
    effect:
      "An experimental override of the turbo model's trained schedule. With simple scheduling, "
      + "4 steps at shift 12 reach sigma 0.800 before the final step; shift 3 reaches 0.500. "
      + "That changes the sampling trajectory, but is not a demonstrated cure for reference "
      + "bleed or overcooked output. Keep 0 for the baseline: FL2V 4-step v1.0 768p uses 6/3 "
      + "video/audio shifts, while Ref2V 4-step v0.1 uses 12/3. The installed 8-step builds "
      + "use their own table entries. This override applies only when a turbo LoRA loads; "
      + "compare the same prompt and multiple seeds before keeping a change.",
    cite: DOCS.bleed,
  },
  {
    id: "turbo_shift_audio",
    label: "Audio shift on the turbo path",
    applies: "h3",
    kind: "number", min: 0, max: 6, step: 0.25,
    path: ["video", "engines", "h3", "turboShiftAudio"],
    unsetAt: 0,
    effect:
      "Keep the 4:1 ratio with the video shift — 3.0 video pairs with 0.75 audio. Equalising the "
      + "two collapses the audio onto the video schedule, which is a different render, not a "
      + "tidier one. 0 = unset.",
    cite: DOCS.bleed,
  },
  {
    id: "shift_audio",
    label: "Audio shift (quality path)",
    applies: "h3",
    kind: "number", min: 0.5, max: 8, step: 0.25,
    path: ["video", "engines", "h3", "shiftAudio"],
    effect:
      "Moves H3's rendered audio level without changing what the render costs — measured "
      + "identical wall clock across a range that moved audio RMS from -14.1 to -27.6 dBFS. "
      + "Irrelevant to a clip that will sit under a song you already made.",
    cite: DOCS.config,
  },

  /* ── the conditioning bridge: a learned rewrite of the words, off by default ── */
  {
    id: "bridge_adapter",
    label: "Conditioning bridge",
    applies: "h3",
    kind: "enum", options: ["off", "BUNNY_H3_ActionLogic_Bridge_V1.safetensors", "MiniMaxH3_SemanticBridge_v1.safetensors"],
    path: ["video", "engines", "h3", "bridge"],
    effect:
      "A 5120→512→512→5120 MLP that rewrites H3's text conditioning before the transformer and is "
      + "blended back at the strength below (server/comfy_nodes/aiplay_h3_bridge.py, the Studio's "
      + "own node; math verbatim from the publishers'). BUNNY is retrained toward action logic — who "
      + "does what to whom, weapon/object attribution, identity after occlusion; the original "
      + "Semantic Bridge aims at composition, counting, materials, reflection. ⚠ Their own "
      + "figures, not a benchmark: about 6 in 10 renders better, 2 the same, 1 worse. ⚠ The "
      + "original card measured the REFERENCE path worse for singing and lip-sync; the Studio "
      + "wires the bridge on both paths and leaves that choice here. MiniMax H3 Community Licence, "
      + "same territory clause as H3.",
    cite: DOCS.config,
  },
  {
    id: "bridge_alpha",
    label: "Bridge strength",
    applies: "h3",
    kind: "number", min: 0, max: 1, step: 0.01,
    path: ["video", "engines", "h3", "bridgeAlpha"],
    effect:
      "How much of the rewrite is blended in: hybrid = h + alpha·(bridge(h) − h), magnitude "
      + "matched per token. Both publishers recommend 0.10, up to 0.15 for their examples; 0 is a "
      + "bypass (the node is left out of the graph).",
    cite: DOCS.config,
  },

  /* ── references, where the other half of the bleed story lives ───────────── */
  {
    id: "ref_image_size",
    label: "Reference scaling",
    applies: "h3",
    kind: "enum", options: ["match", "max"],
    path: ["video", "engines", "h3", "refImageSize"],
    effect:
      "'match' scales each reference to the GENERATION's pixel area, which lands its tokens on a "
      + "latent grid with coordinates identical to every target frame — closest possible time "
      + "offset plus identical spatial coordinates is precisely the geometry a copy-the-token-"
      + "one-step-back attention head exploits. 'max' gives the reference a finer grid so its "
      + "tokens stop sitting on target patch centres, and the node's own tooltip claims better "
      + "identity fidelity for it. ⚠ Unmeasured here, and it pushes far more tokens through 50 "
      + "blocks of quadratic attention on every step, so it is not free. 'match' was never a "
      + "measured choice either — it was hardcoded.",
    cite: DOCS.bleed,
  },

  /* ── steps and length, which belong to the render rather than the engine ─── */
  /* `formControl`: the Video screen's own control for this value. The Lab shows
   * that control's value and a way to it rather than a second control (UI_PLAN
   * C3: one step control and one audio control on the screen); video_settings
   * still reads and sets the row. */
  {
    id: "steps",
    label: "Steps",
    applies: "h3",
    kind: "number", min: 2, max: 40, step: 1,
    path: ["video", "engines", "h3", "steps"],
    formControl: "vidSteps",
    /* EACH MEASUREMENT WITH ITS SCOPE, as config.js's `steps` note gives them.
     * This used to call 20 on the bare model "11 m 00 s, and visibly the
     * best", but that verdict was the turbo LoRA run AT 20 (2026-08-18); only
     * the time carries over, because 20 steps cost the same on either path.
     * The one bare-against-turbo A/B on file is arm H vs C. And 8 loads an
     * 8-step file only where one is on disk: the Models screen fetches the
     * 4-step builds alone, which is why config.js's default follows the disk. */
    effect:
      "Not a quality dial, a model picker. 4 loads the 4-step distillation (~2 m 37 s at native "
      + "size and 124 frames). 8 loads the 8-step one where that file is on disk (5 m 08 s, clean "
      + "but flat); without it, 8 runs the 4-step file past its design point. 20 loads no LoRA and "
      + "runs the bare model: 11 m 00 s is the time of any 20-step render, measured with the LoRA "
      + "loaded, and the 'visibly the best' once quoted with it was that LoRA-at-20 render. The one "
      + "A/B of the bare model against a turbo build (arm H vs C, one shot, reference path) found it "
      + "about equal to the ref2v 8-step at 2.4x the time. The bands between the builds are the ones "
      + "with no good answer. A clip made on the Video screen follows that screen's own step slider; "
      + "this is the default only for a render that names none (make_clip without quality, the API). "
      + "With reference pictures it is the reference build's own count instead (8 where the 8-step "
      + "reference file is on disk).",
    cite: DOCS.directing,
  },
  {
    id: "sampler",
    label: "Sampler",
    applies: "h3",
    kind: "enum", options: ["auto", "res_multistep", "euler", "euler_ancestral", "dpmpp_2m", "ddim"],
    path: ["video", "engines", "h3", "sampler"],
    effect:
      "Auto uses res_multistep on the reference path (pictures or sounds attached), measured: Hex "
      + "Appeal's final cut and the REWIND A/B's winning arm, 2026-09-24. It uses Euler for the "
      + "first/last-frame LightX2V 4/8-step turbo builds, following their published recipe (not "
      + "measured here), and res_multistep for the bare model and TaoMate 3-step. An explicit "
      + "sampler overrides every path.",
    cite: DOCS.bleed,
  },
  {
    id: "scheduler",
    label: "Scheduler",
    applies: "h3",
    kind: "enum", options: ["simple", "normal", "karras", "beta", "sgm_uniform"],
    path: ["video", "engines", "h3", "scheduler"],
    effect:
      "'simple' spaces the sigmas linearly before the shift is applied, which is the pair the "
      + "commit-point arithmetic assumes. The others reshape the schedule, so the sigma this "
      + "panel reports would no longer be the sigma the render stops at. Unmeasured here.",
    cite: DOCS.config,
  },
  {
    id: "drop_audio",
    label: "Discard H3's own audio",
    applies: "h3",
    kind: "bool", onValue: true, offValue: false,
    path: ["video", "engines", "h3", "dropAudio"],
    formControl: "vidAudio",
    effect:
      "H3 always renders sound whether or not you keep it, so keeping it is free. Discard it for "
      + "clips that sit under a song you already made — that song is the audio. A clip made on the Video "
      + "screen follows its own H3 audio control; this is the default only for a render that names none.",
    cite: DOCS.config,
  },

  /* ── sparse attention, the Fast setting's measured speed-up ──────────────── */
  {
    id: "sparse_attention",
    label: "Sparse attention (Fast setting)",
    applies: "h3",
    kind: "enum", options: ["sol-attn", "off"],
    path: ["video", "engines", "h3", "sparse"],
    formControl: "vidSparse",
    /* Both halves are config's (h3tier.js H3_SOL_ATTN, the one copy): the
     * note the switch's tooltip shows, then the recipe in words. */
    effect: [config.video.engines.h3?.solAttn?.note, config.video.engines.h3?.solAttn?.recipe].filter(Boolean).join(" "),
    cite: DOCS.config,
  },

  {
    id: "free_before_clip",
    label: "Fresh engine before each H3 clip",
    applies: "h3",
    kind: "enum", options: ["auto", "always", "never"],
    path: ["video", "freeBeforeClip"],
    effect: "Restarts the engine before an H3 or FastH3 clip when it has already rendered something. Measured on an "
      + "RX 9060 XT: a second clip in the same engine spilled into shared memory and took about 152 s a step "
      + "instead of 82 s; unloading the models did not help, a restart did (78 s). Auto does it on any card that is "
      + "not NVIDIA. The restart costs about 45 s.",
    cite: DOCS.config,
  },
  {
    id: "sparse_everywhere",
    label: "Sparse attention on every step count (experimental)",
    applies: "h3",
    kind: "bool", onValue: true, offValue: false,
    path: ["video", "engines", "h3", "sparseAll"],
    effect: "Runs sol-attn sparse attention on Standard and Best too, not only on the Fast setting, when the sparse "
      + "attention switch is on. Faster at large sizes, a slightly softer picture. References stay dense. Not "
      + "measured by the H3 lab: check the take.",
    cite: DOCS.config,
  },
  {
    id: "sparse_tau",
    label: "Sparse attention strength (tau)",
    applies: "h3",
    kind: "number", min: 1, max: 2, step: 0.1,
    path: ["video", "engines", "h3", "solAttnTau"],
    effect: "How much attention sol-attn skips. 1.0 keeps about 16% of blocks, 1.5 about 7%, 2.0 about 2.7% "
      + "(ComfyUI's Block Sparse Attention node). Higher is faster and softer. Unset, the lab's 1.3.",
    cite: DOCS.config,
  },
  {
    id: "block_cache",
    label: "Block cache (experimental)",
    applies: "h3",
    kind: "bool", onValue: true, offValue: false,
    path: ["video", "engines", "h3", "blockCache"],
    /* h3tier.js H3_BLOCK_CACHE: the node, its recipe and what was measured. */
    effect: "Skips most of H3's transformer blocks on steps where the picture barely changes (the MiniMax H3 "
      + "Block Cache (T8) custom node, which must be installed in ComfyUI). Plain clips only, and never with sparse "
      + "attention on. Its author measured 1.09x to 1.20x at 20 steps on NVIDIA; untested on the 3 to 8 step "
      + "settings and on AMD: check the take.",
    cite: DOCS.config,
  },

  /* ── LTX, whose schedule IS its speed and is therefore worth showing ─────── */
  {
    id: "ltx_cfg",
    label: "Guidance (both scales)",
    applies: "ltx",
    kind: "number", min: 1, max: 8, step: 0.5,
    /* ONE control for two fields on purpose. nodes_lt.py only takes the cheap
     * single-CFG path when video_cfg and audio_cfg are close; let them differ
     * and every one of the 11 steps costs two forward passes instead of one.
     * Splitting this into two rows would be offering the user a way to double
     * their render time by accident. */
    path: ["video", "engines", "ltx", "videoCfg"],
    alsoPath: ["video", "engines", "ltx", "audioCfg"],
    effect:
      "How literally the prompt is followed. ⚠ Video and audio CFG must stay EQUAL, which is why "
      + "this is one control: nodes_lt.py only takes the cheap single-CFG path when the two are "
      + "close, and differing makes every step cost two forward passes instead of one.",
    cite: DOCS.config,
  },
  {
    id: "ltx_sampler",
    label: "Sampler",
    applies: "ltx",
    kind: "enum", options: ["euler_ancestral", "euler", "res_multistep", "dpmpp_2m"],
    path: ["video", "engines", "ltx", "sampler"],
    effect:
      "euler_ancestral is the vendor template's choice and what every measurement on this rig "
      + "used. The others are offered because they load; none of them has been measured here.",
    cite: DOCS.config,
  },
  {
    id: "ltx_sigmas_low",
    label: "Pass 1 schedule (half size)",
    applies: "ltx",
    kind: "text",
    path: ["video", "engines", "ltx", "sigmasLow"],
    effect:
      "LTX has no step count — the steps ARE this list. Eight sigmas at half resolution, verbatim "
      + "from the vendor template. Almost nothing is spent at full size, and that, not a faster "
      + "model, is why LTX is 5.5x quicker than H3.",
    cite: DOCS.config,
  },
  {
    id: "ltx_sigmas_high",
    label: "Pass 2 schedule (full size)",
    applies: "ltx",
    kind: "text",
    path: ["video", "engines", "ltx", "sigmasHigh"],
    effect:
      "Three sigmas starting at 0.85, not 1.0 — this is a partial re-denoise of a latent that has "
      + "already been upscaled x2, not a fresh render. Start it lower and you keep more of the "
      + "upscale; start it higher and you are paying full-size prices for a second render.",
    cite: DOCS.config,
  },
  {
    id: "ltx_drop_audio",
    label: "Discard LTX's rendered audio",
    applies: "ltx",
    kind: "bool", onValue: true, offValue: false,
    path: ["video", "engines", "ltx", "dropAudio"],
    effect:
      "Off by default, and that is the right default: LTX renders REAL audio and a standalone "
      + "clip has nothing underneath it. Turn it on only for clips that will sit under a song you "
      + "already made — and note that a soundtrack clip keeps its audio regardless, because the "
      + "sound is the entire point of that path.",
    cite: DOCS.config,
  },
  {
    id: "ltx_negative",
    label: "Default negative prompt",
    applies: "ltx",
    kind: "text",
    path: ["video", "engines", "ltx", "negative"],
    effect:
      "LTX has a negative prompt and H3 does not. ⚠ A negative clause BUILDS what it describes "
      + "as readily as a positive one — same model, same seed, same shot. Name what you want "
      + "instead wherever you can.",
    cite: DOCS.directing,
  },
];

/** One knob by id, or undefined. */
export const knobById = (id) => KNOBS.find((k) => k.id === id);

/** Walk a path into `config`. Undefined means the field is not there. */
function readPath(segs) {
  let node = config;
  for (const seg of segs) {
    if (node == null) return undefined;
    node = node[seg];
  }
  return node;
}

/** What the SWITCH that parks into this path calls "off", or undefined. */
function offValueOf(remembers) {
  const key = remembers.join(".");
  return KNOBS.find((k) => k.kind === "bool" && k.remembers?.join(".") === key)?.offValue;
}

/** Read a knob's live value out of `config`. Undefined means unset. */
export function knobValue(knob) {
  const node = readPath(knob.path);
  /* A bool over a REMEMBERED number is on whenever the number is not the off
   * value — there is no second field holding "on", because a second field is a
   * second thing that can disagree with the render. */
  if (knob.kind === "bool") {
    return knob.remembers ? node !== knob.offValue : node === knob.onValue;
  }
  return node;
}

/**
 * The knobs as the UI and MCP both see them: definition plus current value.
 *
 * A single list, not one shaped for the page and another shaped for the tool.
 * That is the whole reason this function exists rather than each surface
 * walking KNOBS itself.
 */
export function knobRows(engineKey) {
  return KNOBS
    .filter((k) => !engineKey || k.applies === engineKey)
    .map((k) => ({
      id: k.id, label: k.label, applies: k.applies, kind: k.kind,
      min: k.min, max: k.max, step: k.step, options: k.options,
      unsetAt: k.unsetAt,
      value: knobValue(k),
      effect: k.effect, cite: k.cite,
      path: k.path.join("."),
      /* The Video screen's own control for this value (UI_PLAN C3), or null:
       * the Lab mirrors that control instead of drawing a second one. */
      formControl: k.formControl || null,
      /* Where a row parks a value it will put back. Null on most rows; a row
       * that has one is a row that touches a field the render does not read,
       * and both hands should be able to see that rather than infer it. */
      remembers: k.remembers ? k.remembers.join(".") : null,
    }));
}

/**
 * Set one knob, with the value checked against its own declaration.
 *
 * Throws rather than clamping. A silently clamped setting is how an agent ends
 * up believing it asked for something it did not get — and this surface's whole
 * claim is that both hands write the same document.
 */
export function setKnob(id, value) {
  const knob = knobById(id);
  if (!knob) throw new Error(`Unknown setting "${id}". Read them with video_settings.`);
  const write = (segs, val) => {
    let node = config;
    for (const seg of segs.slice(0, -1)) node = node[seg];
    node[segs[segs.length - 1]] = val;
  };

  /**
   * A SWITCH OVER A REMEMBERED NUMBER, which is the only kind of bool that can
   * sit on the same field as a number row without stealing from it.
   *
   * Off: whatever the threshold is now goes into the `remembers` path and the
   * live field goes to `offValue`. On: the parked number comes back — not a
   * literal, and not the shipped default unless nothing was ever parked. The
   * old code wrote a hard 12 here, so "set 6, off, on" silently became 12 and
   * every render after it ran a distillation the user had ruled out.
   *
   * Turning it the way it already is does nothing, so a page that repaints a
   * checkbox cannot park a value on top of itself.
   */
  let v = value;
  if (knob.kind === "bool" && knob.remembers) {
    if (typeof v !== "boolean") throw new Error(`${id} takes true or false.`);
    const live = readPath(knob.path);
    if (v === false) {
      if (live !== knob.offValue) write(knob.remembers, live);
      write(knob.path, knob.offValue);
    } else if (live === knob.offValue) {
      const parked = readPath(knob.remembers);
      write(knob.path,
        Number.isFinite(parked) && parked !== knob.offValue ? parked : knob.remembersDefault);
    }
    return { id, value: knobValue(knob) };
  }

  if (knob.kind === "bool") {
    if (typeof v !== "boolean") throw new Error(`${id} takes true or false.`);
    v = v ? knob.onValue : knob.offValue;
  } else if (knob.kind === "number") {
    v = Number(v);
    if (!Number.isFinite(v)) throw new Error(`${id} takes a number.`);
    if (v < knob.min || v > knob.max) {
      throw new Error(`${id} must be between ${knob.min} and ${knob.max} — got ${v}.`);
    }
  } else if (knob.kind === "enum") {
    v = String(v);
    if (!knob.options.includes(v)) {
      throw new Error(`${id} must be one of ${knob.options.join(", ")} — got "${v}".`);
    }
  } else {
    v = String(v);
    if (v.length > 600) throw new Error(`${id} is too long (600 characters).`);
  }
  write(knob.path, v);
  // Paired fields (LTX's two CFG scales) move together or they cost you a pass.
  if (knob.alsoPath) write(knob.alsoPath, v);
  /* A number row that a switch parks for: keep the parked copy current, so the
   * switch restores the threshold somebody actually chose. Never the OFF value
   * — parking that would mean "on" restores nothing — and which value that is
   * belongs to the switch, so it is read off the switch rather than typed here. */
  if (knob.remembers && v !== offValueOf(knob.remembers)) write(knob.remembers, v);
  return { id, value: knobValue(knob) };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. COMPARISON CONFIGS — the same shot, several ways
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The owner's ask: "turbo loras are decent but the video isn't perfect the
 * audio isn't perfect. going without the 4step H3 turbo mode does produce
 * better videos. so it would be nice to gen the same clip multiple times
 * through the different video models we have."
 *
 * Same prompt, same seed, same references. Only the path changes. `why` is what
 * the row is FOR — the question that arm of the comparison answers — because a
 * comparison whose arms nobody can tell apart teaches nothing.
 */
export const COMPARE_CONFIGS = [
  {
    id: "h3_quality",
    label: "H3 · 20 steps, no LoRA",
    engine: "h3",
    steps: 20,
    why:
      "The baseline: 20 steps without the turbo distillation. Compare the same prompt, seed, "
      + "references and size across arms, then inspect detail and motion. The displayed shift "
      + "and commit sigma come from the current settings; historical render times are not "
      + "a prediction for this request.",
    cite: DOCS.directing,
  },
  {
    id: "h3_turbo4",
    label: "H3 · 4-step turbo",
    engine: "h3",
    steps: 4,
    why:
      "Four steps with the configured 4-step distillation for this input path. Inspect the "
      + "opening frames for reference carry-over and the later frames for detail and motion. "
      + "Use the displayed shift and commit sigma: they follow the selected LoRA and any "
      + "explicit overrides, rather than assuming a fixed shift of 12.",
    cite: DOCS.bleed,
  },
  {
    id: "h3_turbo8",
    label: "H3 · 8-step turbo",
    engine: "h3",
    steps: 8,
    why:
      "Eight steps with the configured turbo LoRA for this input path, including the "
      + "reference path's configured LoRA when references are attached. Check the resolved "
      + "LoRA and installed weights before rendering. Compare its detail, motion and measured "
      + "time with the 4-step arm; this description does not establish a quality winner.",
    cite: DOCS.directing,
  },
  {
    id: "ltx",
    label: "LTX 2.5",
    engine: "ltx",
    why:
      "A different tool, not a faster H3: eight steps at half resolution, a latent x2 upscale, "
      + "then three steps at full size from sigma 0.85. 121 s for 5 s at 1280x704 with real "
      + "audio. ⚠ It has NO reference input at all — a comparison carrying references is "
      + "comparing an arm that used them against one that could not.",
    cite: DOCS.config,
  },
  {
    id: "hybrid",
    label: "Hybrid",
    engine: "hybrid",
    why:
      "The fork's routing rule rather than a third model: H3 for a shot carrying named cast "
      + "references, LTX for everything else. In a comparison it resolves the moment you press "
      + "go, and the result row says which engine it became and why — because 'hybrid' once "
      + "quietly meant 'everything on the ten-times-more-expensive engine' and nothing reported "
      + "which engine a clip chose until after it had run.",
    cite: DOCS.shot,
  },
];

/**
 * THE LICENCE, carried on the arm rather than left in a document.
 *
 * A comparison is the one surface that will put a person on an engine they did
 * not choose — five arms, tick them all, press go — so this is exactly where a
 * territory restriction has to be visible. Both sentences are the ones
 * server/config.js and pipeline_guide already give; they are restated here so
 * the arm can carry its own, not re-derived from the licences.
 */
/**
 * THE LICENCE LINE ON EVERY ARM — derived from server/models.js, never typed.
 *
 * ⚠ THIS WAS A HAND-TYPED CONSTANT AND IT WAS WRONG. It read "grants NO rights
 * in the EU, the UK or South Korea" — three territories. MiniMax H3's Applicable
 * Territory excludes FOUR, and the fourth is the United States of America. So
 * the app's own welcome window (which reads models.js) and this card (which did
 * not) gave a reader in the USA opposite answers about the same licence, and
 * this is the card shown at the moment somebody decides to press Render — and
 * the line `video_compare` hands an agent for every arm. The Models screen's
 * download gate reads the real list, so the same user would then be refused the
 * weights by a sentence this one told them did not apply.
 *
 * A licence summary that is retyped is a licence summary that goes stale in
 * silence, which is the whole reason server/welcome/catalogue.js reads instead
 * of paraphrasing. This now does the same: the territory list and the money
 * clause come out of the CATALOG entry for the engine, so correcting models.js
 * corrects every surface at once and no surface can drift on its own.
 */
function engineLicence(engineKey) {
  const cap = CATALOG.find((c) => c.id === MODEL_TO_CAPABILITY[engineKey]);
  if (!cap) return null;
  const bits = [`${cap.label} — ${cap.licence}.`];

  /* Territory first, because it is the only clause here that can make running
   * the arm at all the wrong move, and `excluded` is the same array the
   * downloader refuses on (models.js:1363). Joined from the list rather than
   * summarised, so a fifth territory appears here the day it appears there. */
  if (cap.region?.excluded?.length) {
    bits.push(`⚠ Its grant does not reach ${cap.region.excluded.join(", ")}`
      + " — where that covers you, do not run this arm. LTX carries no territory clause and"
      + " covers everything except named references.");
  } else {
    bits.push("Worldwide grant, no territory clause.");
  }

  if (cap.outputRights?.sellable) {
    bits.push("The licensor claims no rights over what you generate.");
  }
  /* The conditions VERBATIM. The retyped version turned models.js's "at least
   * USD 10,000,000 … Exactly $10M is above the line" into "above $10M annual
   * revenue", which moves the boundary by exactly the case models.js went out
   * of its way to spell out — and dropped §6 (do not strip the provenance
   * markers) altogether, which is the clause that binds anyone shipping a clip. */
  for (const c of cap.outputRights?.conditions ?? []) bits.push(c);
  return bits.join(" ");
}

const ENGINE_LICENCE = {
  h3: engineLicence("h3"),
  ltx: engineLicence("ltx"),
};

/**
 * What `hybrid` resolves to for THIS request.
 *
 * The rule is server/mv/shot.js's, restated for the standalone panel where
 * there is no project brief to read a cast list from: references present means
 * the shot carries identity, which is the only thing H3 can do that LTX cannot.
 * Returned with its reason so the comparison can show it before it costs money.
 */
export function resolveHybrid({ refImages = [], refAudios = [] } = {}) {
  const refs = (refImages?.length || 0) + (refAudios?.length || 0);
  return refs > 0
    ? { engine: "h3", reason: `${refs} reference${refs === 1 ? "" : "s"} attached — H3 is the only engine with a named-reference input, so hybrid routes here.` }
    : { engine: "ltx", reason: "no references attached, so nothing needs H3's reference path — hybrid takes the fast engine." };
}

/**
 * A comparison arm expanded into the exact render it will ask for.
 *
 * Size is per-arm because the engines disagree about what a legal size is:
 * asking LTX for H3's 1344x768 gets you 1280x704 after its halve-then-floor,
 * silently. So an arm renders at ITS engine's native size unless the caller
 * pinned one, and the label says which — a comparison that hid a size change
 * would be comparing two things and reporting one.
 */
export function expandConfig(cfg, { width, height, refImages, refAudios } = {}) {
  const resolved = cfg.engine === "hybrid"
    ? resolveHybrid({ refImages, refAudios })
    : { engine: cfg.engine, reason: null };
  const eng = videoEngine(resolved.engine);
  const w = width || eng.width;
  const h = height || eng.height;
  const size = videoSizeFor(resolved.engine, w, h);
  const steps = resolved.engine === "ltx" ? null : (cfg.steps ?? eng.steps ?? 20);
  return {
    id: cfg.id,
    label: cfg.label,
    engine: resolved.engine,
    declaredEngine: cfg.engine,
    routing: resolved.reason,
    steps,
    width: size.width, height: size.height,
    requestedWidth: w, requestedHeight: h,
    /* The label the result card carries. Engine, size, steps — the three things
     * that differ between arms, in the order a person compares them. */
    sizeLabel: resolved.engine === "ltx"
      ? `${size.width}x${size.height} · schedule fixed, no step count`
      : `${size.width}x${size.height} · ${steps} steps`,
    /* The shift the GRAPH will run, asked of the function the graph asks —
     * panel value, else the loaded LoRA's trained shift, else the base — so
     * the sigma shown here is the sigma that renders. `eng` is the engine
     * block alone; the graph merges it over config.video, and every shift
     * field lives on the engine block, so the answer is the same. */
    commitSigma: resolved.engine === "ltx" ? null
      : commitSigma(steps, h3SigmaShiftFor(eng, { steps,
          refs: (refImages?.length || 0) + (refAudios?.length || 0) > 0 }).video),
    why: cfg.why,
    licence: ENGINE_LICENCE[resolved.engine] || null,
    cite: cfg.cite,
  };
}

export { ENGINE_LICENCE };
