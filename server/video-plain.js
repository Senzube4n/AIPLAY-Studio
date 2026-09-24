/**
 * THE VIDEO SCREEN IN PLAIN WORDS, AND THE ONE PLAN BEHIND A RENDER.
 *
 * One copy of every sentence the Video screen and make_clip say about a clip
 * before and after it renders, and the one function that decides what a
 * render request becomes (videoPlan). /api/video's `create` renders the plan,
 * its `check` returns it without rendering (the Video screen's Advanced line
 * and make_clip's `check_only` read that), /api/status serves the per-engine
 * sentences, and art.js turns an engine failure into a sentence here. The page
 * shows these words; it never writes its own.
 *
 *   refsIgnored       an engine that takes no reference pictures (FastH3, LTX):
 *                     a clip with any attached is REFUSED, never rendered
 *                     without them (UI_PLAN E4). The reference slots and
 *                     make_clip say the same sentence.
 *   tags              a <Picture n> / <Audio n> the render cannot resolve is
 *                     taken out of the description and said, never sent to the
 *                     engine as plain words.
 *   matched steps     the Fast setting with references runs the reference
 *                     build's own count (workflow.js h3MatchedSteps), and says
 *                     so.
 *   start size        a render that names no size on a smaller card gets the
 *                     card's tier size (h3tier.js h3StartSize), and says so.
 *   frames on FastH3  accepted, and said to be untried (the lab ran FastH3 on
 *                     text only).
 *   not offered       H3 on a card it is not offered on: said, never refused
 *                     silently or rendered silently (the page asks first).
 *   fit, RAM          "this size needs about X GB free; you have Y" and the RAM
 *                     warning, from h3tier.js.
 *   failures          ComfyUI's error JSON becomes a sentence; the raw text
 *                     stays behind Details.
 *
 * Imports only data and pure helpers; no I/O.
 */
import { CLOUD_CARD_PLACE } from "./cloud-switch.js";
import { h3SizeFit, h3StartSize, H3_VRAM_OFFERED_GB, H3_RAM_FLOOR_GB, H3_SOL_ATTN, H3_MORE_MOTION } from "./h3tier.js";
import { h3MatchedSteps, h3SparseFor } from "./workflow.js";

/* ── which engines the card tiers are about ───────────────────────────────── */

const H3_FAMILY = new Set(["h3", "fasth3"]);
/** The engines H3's card tiers, size chips and RAM line apply to. /api/status
 *  sends it per engine (`h3Tiers`), so the page never decides it. */
export const isH3Family = (engineKey) => H3_FAMILY.has(engineKey);

/* ── the Fast chip's note ─────────────────────────────────────────────────── */

/**
 * What the Video screen says under the quality chips about Fast, for H3 (null
 * for an engine without the chips). It follows the disk (stepDefaults.fast is
 * 3 only where the TaoMate build is) and the saved sparse attention, because
 * sol-attn, the default on Fast, makes the picture slightly softer: the chip
 * must not promise "as sharp as the 8-step build" while it runs.
 */
export function fastNote(eng) {
  if (!eng?.stepDefaults || eng.fixedSteps || !eng.solAttn) return null;
  if (Number(eng.stepDefaults.fast) !== 3) {
    return "Install the Fast setting for H3 on the Models screen (a 182 MB file) and Fast drops to 3 steps.";
  }
  return eng.sparse === "sol-attn"
    ? `3 steps on the TaoMate build, a third less time than the 8-step build, with sparse attention on: `
      + `${H3_SOL_ATTN.gain} (Advanced, sparse attention).`
    : "3 steps on the TaoMate build: as sharp as the 8-step build, a third less time.";
}

/* ── references on an engine that takes none ─────────────────────────────── */

const WHY_NO_REFS = {
  fasth3: "it was distilled without them",
  ltx: "the model has no reference input, a model limit and not a setting",
};
/* The substitute an engine really takes: LTX pins a picture as a frame. Not
 * FastH3: the lab ran it on text only, so a frame there is untried and the
 * sentence does not recommend it. */
const FRAME_INSTEAD = new Set(["ltx"]);

/** The sentence for an engine that ignores reference pictures and sounds, or
 *  null for one that takes them (MiniMax H3). */
export function refsIgnored(engineKey, label = engineKey) {
  if (!engineKey || engineKey === "h3") return null;
  const why = WHY_NO_REFS[engineKey] || "it has no reference input";
  return `${label} ignores reference pictures and sounds (${why}), so a clip with any attached is refused `
    + "rather than rendered without them. "
    + (FRAME_INSTEAD.has(engineKey) ? `On ${label}, a picture can open or close the clip as a frame instead. ` : "")
    + "Switch the engine to MiniMax H3 to use them, or remove them to render from the words alone.";
}

/* ── <Picture n> / <Audio n> ──────────────────────────────────────────────── */

const TAG = /<\s*(Picture|Audio)\s+(\d+)\s*>/gi;

/** Every reference tag in a description, in order. */
export function refTagsIn(prompt) {
  return [...String(prompt || "").matchAll(TAG)].map((m) => ({
    kind: /^p/i.test(m[1]) ? "Picture" : "Audio", n: Number(m[2]), text: m[0],
  }));
}

/** The tags no attached reference answers: a number past what rides with the
 *  render, or any tag at all where no reference rides (refsRide false). */
export function unresolvedRefTags(prompt, { pictures = 0, audios = 0, refsRide = true } = {}) {
  return refTagsIn(prompt).filter((t) => {
    if (!refsRide) return true;
    const have = t.kind === "Picture" ? pictures : audios;
    return t.n < 1 || t.n > have;
  });
}

/** The description with those tags taken out, spacing tidied. */
export function withoutTags(prompt, tags) {
  let out = String(prompt || "");
  for (const t of tags) out = out.split(t.text).join("");
  return out.replace(/[ \t]{2,}/g, " ").replace(/ +([,.;:!?])/g, "$1").trim();
}

/** What was taken out, and why, in one sentence. */
export function refTagSentence(tags, { engineLabel, refsRide = true } = {}) {
  if (!tags.length) return null;
  const list = [...new Set(tags.map((t) => `<${t.kind} ${t.n}>`))].join(", ");
  const was = tags.length > 1 ? "were" : "was";
  return refsRide
    ? `${list} ${was} taken out of the description: no such reference is attached, so the tag would have `
      + "reached the engine as plain words."
    : `${list} ${was} taken out of the description: ${engineLabel} takes no reference pictures or sounds, so `
      + "the tag would have reached it as plain words.";
}

/* ── the card ─────────────────────────────────────────────────────────────── */

/** The Video screen's sentence when H3 is not offered on this machine, friend
 *  first and the person's own key second (owner decision, 2026-09-24). Null
 *  where H3 is offered, or the card could not be read. */
export function h3NotOfferedLine(h3) {
  if (!h3 || h3.offered || !h3.card) return null;
  const why = h3.ramBelowFloor
    ? `this PC has ${h3.ramGb} GB of RAM, under the ${H3_RAM_FLOOR_GB} GB it needs`
    : `this card has ${h3.card.vramGb} GB of graphics memory, and nothing under ${H3_VRAM_OFFERED_GB} GB was tested`;
  return `H3 video is not offered here: ${why}. Ask a friend with a strong card first: Ask friend, beside `
    + `Render clip in Advanced, prepares this clip for their card, free. After that, a paid service on your own `
    + `key (${CLOUD_CARD_PLACE}).`;
}

/* ── engine failures ──────────────────────────────────────────────────────── */

/* The PC's own memory (RAM, the pagefile), before the card's: "not enough
 * memory" is how PyTorch's CPU allocator says it, and a smaller size does not
 * shrink the ~39 GB of weight files H3 loads (the lab: RAM is probably the
 * harder limit for 8 GB owners). */
const RAM_OOM = /DefaultCPUAllocator|not enough memory: you tried to allocate|std::bad_alloc|\bMemoryError\b|paging file is too small|os error 1455/i;
const CARD_OOM = /out of memory|OutOfMemory|Allocation on device|CUDA_ERROR_OUT_OF_MEMORY|CUBLAS_STATUS_ALLOC_FAILED/i;

/**
 * ComfyUI's failure (engine/client.js hands over its JSON, up to 900
 * characters, or its own "ComfyUI rejected the job: ..." when /prompt refused
 * the graph before it ran) as one sentence, with the raw text kept as `detail`
 * for the page's Details and an agent. `reason` names the kind for a caller
 * that acts.
 */
export function plainVideoFailure(raw) {
  const detail = String(raw ?? "").trim();
  if (RAM_OOM.test(detail)) {
    return { reason: "ram-out-of-memory", detail,
      sentence: "This PC ran out of memory (RAM, not the graphics card) during the render: close memory-heavy "
        + "apps and set a large pagefile. A smaller size does not shrink the model files it loads." };
  }
  if (CARD_OOM.test(detail)) {
    return { reason: "out-of-memory", detail,
      sentence: "The card ran out of memory at this size; pick the smaller size or close GPU-heavy apps." };
  }
  if (/stopped answering/i.test(detail)) {
    return { reason: "engine-gone", detail,
      sentence: "The video engine stopped answering during the render, which often means the card or the "
        + "computer ran out of memory; pick the smaller size or close GPU-heavy apps, then try again." };
  }
  if (/POST \/prompt failed|prompt returned no prompt_id/i.test(detail)) {
    return { reason: "unreachable", detail,
      sentence: "The video engine did not take the clip: it did not answer when the render was sent. "
        + "Check that it is running (the Engine panel), then try again." };
  }
  if (/no terminal status/i.test(detail)) {
    return { reason: "timeout", detail,
      sentence: "The render ran past its time limit and was stopped; a smaller size or a shorter clip "
        + "finishes sooner on this card." };
  }
  if (/cancelled from the app/i.test(detail)) {
    return { reason: "cancelled", detail, sentence: "The render was stopped from the app." };
  }
  if (/rejected the job|value not in list|Required input is missing|failed validation|node_errors|does not exist|not found/i.test(detail)) {
    return { reason: "refused", detail,
      sentence: "The video engine refused this setup before rendering: a file or option it does not have. "
        + "Details say which." };
  }
  return { reason: "error", detail,
    sentence: detail ? "The video engine stopped with an error; Details say what it reported."
      : "The video engine stopped without saying why." };
}

/* ── the plan ─────────────────────────────────────────────────────────────── */

const num = (v) => (v === undefined || v === null || v === "" ? NaN : Number(v));
const aN = (n) => (/^(8|11|18)\b/.test(String(n)) ? "an" : "a");

/**
 * What a render request becomes, before anything is staged or queued.
 *
 *   b         the request body (the Video screen's, make_clip's): prompt,
 *             width, height, seconds, steps, refImages, refAudios, sparse
 *   engineKey the engine that will really render (index.js videoWeightsGate)
 *   eng       config.video.engines[engineKey]
 *   h3        /api/status's config.video.h3 block (h3tier.js h3Status)
 *   framed    an opening or closing picture rides with the render
 *   control   a control video drives it (video-to-video)
 *
 * Returns { refusal, prompt, width, height, seconds, steps, sparse, fit,
 * warnings, notes }: `refusal` ({error, reason}) when the request must not
 * render, the values the job carries otherwise, `warnings` [{id, text}] that
 * the reply and the page show, and `notes` [{id, text}], caveats that change
 * nothing (the Advanced line and check_only show them; a render's reply does
 * not repeat them). Nothing in it is silent: every value it changes from the
 * request has a warning saying so.
 */
export function videoPlan(b = {}, { engineKey, eng = {}, h3 = null, framed = false, control = false } = {}) {
  const label = eng.label || engineKey;
  const family = isH3Family(engineKey);
  const warnings = [], notes = [];
  const pictures = Array.isArray(b.refImages) ? Math.min(b.refImages.filter(Boolean).length, 9) : 0;
  const audios = Array.isArray(b.refAudios) ? Math.min(b.refAudios.filter(Boolean).length, 3) : 0;
  const refsRide = engineKey === "h3";

  /* References on an engine without them: refused, by the one sentence. */
  if ((pictures || audios) && !refsRide) {
    return { refusal: { error: refsIgnored(engineKey, label), reason: "refs-ignored" }, warnings, notes };
  }

  /* Tags nothing answers: out of the words, and said. */
  let prompt = String(b.prompt || "").trim();
  const loose = unresolvedRefTags(prompt, { pictures, audios, refsRide });
  if (loose.length) {
    prompt = withoutTags(prompt, loose);
    warnings.push({ id: "tags", text: refTagSentence(loose, { engineLabel: label, refsRide }) });
    if (!prompt) {
      return { refusal: { error: "Describe the clip first: the description held only reference tags that nothing "
        + "attached answers.", reason: "empty" }, warnings, notes };
    }
  }

  /* H3 on a card it is not offered on: said (the page asked before sending). */
  const notOffered = family ? h3NotOfferedLine(h3) : null;
  if (notOffered) warnings.push({ id: "not-offered", text: notOffered });

  /* FastH3 was only tried on text to video: a frame is accepted, and said. */
  if (engineKey === "fasth3" && framed) warnings.push({ id: "frames-untried", text: H3_MORE_MOTION.framesUntried });

  /* The size: what was asked, else a smaller card's tier size (said), else
   * the engine's own. Each side on its own, as the door always read them; the
   * tier size only when neither was named. The sides are not moved to H3's
   * 32-pixel grid here (a listed 1280x720 stays 720); the fit counts them up
   * to it, and the Video screen's custom boxes step on it. */
  const askedW = num(b.width), askedH = num(b.height);
  const hasW = Number.isFinite(askedW) && askedW > 0, hasH = Number.isFinite(askedH) && askedH > 0;
  /* h3StartSize is null on a full-size card (the default is the person's; the
   * Lab's set_quality writes it), and the tier only ever lowers the size. */
  const tierStart = family && !hasW && !hasH ? h3StartSize(h3) : null;
  const start = tierStart && tierStart.width * tierStart.height < (eng.width || 0) * (eng.height || 0) ? tierStart : null;
  const clampSide = (v) => Math.min(Math.max(Math.round(v), 256), 3840);
  const width = hasW ? clampSide(askedW) : start ? start.width : eng.width;
  const height = hasH ? clampSide(askedH) : start ? start.height : eng.height;
  const askedS = num(b.seconds);
  const hasS = Number.isFinite(askedS) && askedS > 0;
  let seconds = Math.min(Math.max(hasS ? askedS : eng.seconds, 1), 20);
  if (start) {
    const cut = !hasS && seconds > start.maxSeconds;
    if (cut) seconds = start.maxSeconds;
    const why = start.measured ? "the size this card was measured to fit"
      : "this card's experimental preview size, not yet seen to fit";
    warnings.push({ id: "size", text: `No size was named, so this renders at ${start.width}x${start.height}`
      + `${cut ? ` for ${seconds} s` : ""}, ${why} (${start.chip}). Name a width and height to choose another.` });
  }

  /* Steps: a fixed schedule records its own; the reference path in the Fast
   * band runs the loaded file's count when asked for fewer (said). */
  const askedSteps = num(b.steps);
  let steps = eng.fixedSteps || Math.min(Math.max(Number.isFinite(askedSteps) && askedSteps > 0 ? askedSteps : (eng.steps || 20), 2), 40);
  if (engineKey === "h3" && (pictures || audios)) {
    const m = h3MatchedSteps(eng, { steps, refs: true });
    if (m.raised) {
      warnings.push({ id: "steps", text: `With references this runs ${m.steps} steps, not ${m.asked}: the reference `
        + `build that loads is ${aN(m.made)} ${m.made}-step file, and it runs at its own step count.` });
      steps = m.steps;
    }
  }

  /* Sparse attention: the saved setting, or the request's own when it names
   * one. Said only when a render ASKED for sol-attn, differing from the saved
   * setting, and this setting does not take it: the saved default on Standard
   * or Best is not a request, nor is a body that only repeats it (an older
   * page sent the saved value with every render). */
  const sparseWant = b.sparse === "sol-attn" || b.sparse === "off" ? b.sparse : undefined;
  let sparse = null;
  if (engineKey === "h3") {
    const cfg = h3SparseFor(eng, { steps, refs: !!(pictures || audios), sparse: sparseWant, control });
    sparse = cfg ? "sol-attn" : "off";
    if (!cfg && sparseWant === "sol-attn" && (eng.sparse ?? "off") !== "sol-attn") {
      warnings.push({ id: "sparse", text: "Sparse attention runs on the Fast setting (the 3-step build, no "
        + "references, no video-to-video) only; this clip runs dense attention." });
    }
    /* Where it runs at a size the lab never tried it at, the Advanced line
     * says so (a caveat, not a change). */
    const at = cfg?.measuredAt;
    if (at && (width !== at.width || height !== at.height)) {
      notes.push({ id: "sparse-untried", text: `Sparse attention runs on this clip; it was measured at `
        + `${at.width}x${at.height} only, so its speed and look at ${width}x${height} are not yet tried.` });
    }
  }

  /* What this size needs, and the RAM warning, at render time. */
  const fit = family ? h3SizeFit({ width, height, seconds }, { vramMb: h3?.card?.vramMb ?? null }) : null;
  if (fit?.over) warnings.push({ id: "fit", text: fit.sentence });
  if (family && h3?.ramWarning) warnings.push({ id: "ram", text: h3.ramWarning });

  return { refusal: null, prompt, width, height, seconds, steps, sparse, fit, warnings, notes };
}
