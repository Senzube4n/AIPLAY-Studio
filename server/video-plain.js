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
 *   keeping a         the REWIND A/B (2026-09-24, DIRECTING.md §2): a person
 *   character         stays the same from clip to clip with 1-3 pictures of
 *                     them, the reference build's own step count and, for a
 *                     singer, the song under the clip. `character` says what
 *                     a render keeps (the Video screen's Keep my character
 *                     line and receipt, make_clip's reply); a saved character
 *                     (persona) is bound into the words here; a render with
 *                     references that names no step count runs the reference
 *                     build's own (workflow.js referenceSteps); the `runs`
 *                     note names the build, steps, sampler and decoder. The
 *                     measured setup is a constant (KEEP_MEASURED), apart
 *                     from what this disk can run, so a 4-step-only disk is
 *                     said to run an unmeasured setup; Song under the clip's
 *                     words follow the engine (songUnderSay: lip-sync on H3,
 *                     measured not to follow on LTX).
 *
 * Imports only data and pure helpers; no I/O.
 */
import { CLOUD_CARD_PLACE, LENDING_UNTRIED } from "./cloud-switch.js";
import { h3SizeFit, h3StartSize, H3_VRAM_OFFERED_GB, H3_RAM_FLOOR_GB, H3_SOL_ATTN, H3_MORE_MOTION } from "./h3tier.js";
import { alignFrames, h3MatchedSteps, h3SparseFor, h3SamplerFor, h3TurboLoraFor, referenceSteps } from "./workflow.js";
import { loraStepsOf } from "./config.js";
import { bindPersonaForClip, promptNames } from "./personas.js";

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

/* ── 3 steps without TaoMate ──────────────────────────────────────────────── */

/** The row a 3-step render needs: the 182 MB file new installs are offered. */
export const TAOMATE_ROW = "videoH3Turbo3Small";
/** The one sentence for a 3-step render with no TaoMate file on disk. */
export const taomateNeeded = (steps) => `${steps} steps needs the TaoMate 3-step LoRA (182 MB), which is not `
  + "downloaded. Download it, or pick 4 or more steps.";

/** Each H3 speed-up's own row (models.js, addonFor "video"), by the build it is. */
export const SPEEDUP_ROWS = Object.freeze({ 3: TAOMATE_ROW, 4: "videoH3Turbo4", 8: "videoH3Turbo8" });

/**
 * THE SPEED-UP A STEP COUNT NEEDS, when it is not on disk; null when it is,
 * or when none is needed. Mirrors workflow.js h3TurboLoraFor on the plain
 * path: 3 or fewer loads TaoMate, 4 to turbo4MaxSteps the 4-step file, up to
 * turboMaxSteps the 8-step file, and above that the bare model, which needs
 * nothing. Every speed-up is optional, so a missing one is a download offer,
 * never a quiet swap to another file run at the wrong step count. With
 * references the graph selects the 4-step reference slot for 2–5 steps and
 * the 8-step slot for 6–12 steps. One installed slot cannot satisfy the other:
 * h3TurboLoraFor would otherwise name a file that is absent. `eng.turboBuilds`
 * is config.js's reading of the disk; an engine without it (LTX) or with fixed
 * steps (FastH3) is not judged.
 *
 * ON NVIDIA AND A CARD NOBODY COULD READ, EACH PATH BY THE FILE IT LOADS
 * (perPath below: config.js plainBuilds and refBuilds). turboBuilds' `four`
 * and `eight` are both-path readings, so a disk with the "Video references"
 * row's ref2v 4-step file and no fl2v 4-step one refused Keep my character by
 * default, offering the fl2v file the reference path never loads, and a disk
 * with the 8-step file beside that row refused plain 8-step renders, offering
 * the 8-step file already on it. Now a plain render is checked by the plain
 * path's own file, and one with references by the file the reference path
 * loads in that band (h3TurboLoraFor), the build it offers being the band's.
 *
 * AMD, INTEL AND THE CPU: MAIN'S RULE, EXACTLY (perPath is false there: the
 * per-path readings are null, config.js offNvidia). Bucky's rule, relayed by
 * the owner: "Make it available only for Nvidia. AMD is locked by my tests."
 */
export function speedupNeeded(eng, { steps, refs = false } = {}) {
  const tb = eng?.turboBuilds;
  const n = Number(steps);
  if (!tb || eng.fixedSteps || !Number.isFinite(n) || n > (eng.turboMaxSteps ?? 12)) return null;
  const need = (build) => ({ build, row: SPEEDUP_ROWS[build],
    error: build === 3 ? taomateNeeded(n)
      : `${n} steps needs H3's ${build}-step speed-up (1.96 GB), which is not downloaded. Download it, or pick `
        + "another step count." });
  const band4 = n <= (eng.turbo4MaxSteps ?? 5);
  if (refs) {
    if (!perPath(eng)) return band4 ? (tb.four ? null : need(4)) : (tb.eight ? null : need(8));
    const { turbo, use4, lora } = h3TurboLoraFor(eng, { steps: n, refs: true });
    if (!turbo || !lora) return null;
    if (use4 ? eng.refBuilds.four : eng.refBuilds.eight) return null;
    /* The 8-step band, where the reference path loads a ref2v file made for
     * another count (the "Video references" row's 4-step v0.1, which
     * refTurboLora takes before any fl2v file): the 8-step speed-up row
     * would not change what loads, and it may be on disk already, so it is
     * not offered. The 8-step reference build is the fix, and no Models row
     * fetches it yet. */
    const made = loraStepsOf(lora);
    if (!use4 && /ref2v/i.test(lora) && Number.isFinite(made) && made !== 8) {
      return { build: 8, row: null,
        error: `${n} steps with reference pictures needs the 8-step reference build, which is not on this PC (the Models `
          + `screen does not fetch it yet). The reference build here is made for ${made} steps: pick ${made} steps, or `
          + "leave out the reference pictures." };
    }
    return need(use4 ? 4 : 8);
  }
  const pb = perPath(eng) ? eng.plainBuilds : tb;
  if (n <= (eng.turbo3MaxSteps ?? 3)) return pb.three ? null : need(3);
  if (band4) return pb.four ? null : need(4);
  return pb.eight ? null : need(8);
}

/**
 * WHETHER THIS ENGINE IS JUDGED PER PATH: config.js made both per-path
 * readings (plainBuilds, refBuilds), which it does on NVIDIA and on a card
 * nobody could read, never where the settings name another card (config.js
 * offNvidia: AMD, Intel, the CPU). Where it is false, every rule in this file
 * that has a per-path form keeps main's instead (speedupNeeded, keepFast,
 * qualityChips, speedupNeededAtClip).
 */
export function perPath(eng) {
  return !!(eng?.plainBuilds && eng?.refBuilds);
}

/**
 * THE REFUSAL EVERY DOOR GETS, not only /api/video: what ArtRunner.#clip
 * refuses a clip job for (art.js clipSpeedupNeeded; the music-video runner
 * and Extend never ran videoPlan), and what the lender's accept card warns of
 * first (collab/lending.js speedUpCheck), so a lender is never promised a
 * render the runner then refuses.
 *   - A speed-up the graph would load that is NOT ON DISK is refused on every
 *     card: ComfyUI rejects such a graph anyway, minutes later and in its own
 *     words, so nothing that renders today is lost (a bug fix on every card).
 *   - Where the engine is judged per path (NVIDIA and a card nobody could
 *     read) also a file that IS on disk but made for another count, which
 *     videoPlan refuses there: the 8-step file run at 4 steps.
 * `onDisk(name)` says whether the file the graph would load is there.
 */
export function speedupNeededAtClip(eng, opts = {}, { onDisk = null } = {}) {
  if (perPath(eng)) return speedupNeeded(eng, opts);
  const missing = speedupNeeded(eng, opts);
  if (!missing || typeof onDisk !== "function") return null;
  const { turbo, lora } = h3TurboLoraFor(eng, { steps: Number(opts.steps), refs: !!opts.refs });
  return turbo && lora && !onDisk(lora) ? missing : null;
}

/**
 * THE QUALITY CHIPS, FROM THE SERVER: Fast · Standard · Best, each as {steps,
 * needsModel}, the count a press sets and the Models row it needs first (null
 * when its file is on disk). One copy for the three that show them:
 * /api/status (per engine `chips`), the Video screen, which draws them and
 * keeps no number of its own, and make_clip's `quality`. The page kept its
 * own (Fast always 3, Standard 8 or 4, its own copy of speedupNeeded), and
 * make_clip sent stepDefaults: on H3 alone the Fast chip said 3 (dimmed)
 * while make_clip "fast" ran the bare model at 20.
 *   plain  Fast is TaoMate's 3 (turbo3MaxSteps); Standard the engine's own
 *          default where that is a speed-up count (8 or 4), else the 8-step
 *          file's 8; Best the bare model's 20. The numbers Bucky's page drew.
 *   keep   while a character is kept: Standard is the reference build's own
 *          count (workflow.js referenceSteps), Fast keepFast's (else
 *          Standard's: one chip), Best 20.
 * null for an engine without chips (LTX; FastH3's fixed schedule), and null on
 * AMD, Intel and the CPU (perPath): there the Video screen draws main's chips
 * and make_clip's `quality` sends main's numbers (stepDefaults), exactly as
 * Bucky's tests left them.
 */
export function qualityChips(eng) {
  if (!eng?.stepDefaults || eng.fixedSteps || !perPath(eng)) return null;
  const d = eng.stepDefaults;
  const std = Number(d.standard);
  const chip = (steps, refs = false) => ({ steps, needsModel: speedupNeeded(eng, { steps, refs })?.row ?? null });
  const best = { steps: Number(d.best) || 20, needsModel: null };
  const plain = eng.turboBuilds
    ? { fast: chip(eng.turbo3MaxSteps ?? 3), standard: chip(std <= (eng.turboMaxSteps ?? 12) ? std : 8), best }
    : { fast: chip(Number(d.fast) || std), standard: chip(std), best };
  const keepStd = referenceSteps(eng) ?? std;
  const keep = { fast: chip(keepFast(eng)?.steps ?? keepStd, true), standard: chip(keepStd, true), best };
  return { plain, keep };
}

/**
 * speedupNeeded for every count the speed-ups cover, by path: {plain: {n:
 * row|null}, refs: {n: row|null}} for n = 1 to turboMaxSteps (above that the
 * bare model needs nothing). /api/status sends it (per engine
 * `speedupNeeds`), so the Video screen says a missing speed-up while the
 * slider sits on it, and offers it before a render, without a copy of the
 * rule. On every card: off NVIDIA it is main's rule (perPath), so the page
 * says what it said. null where there is nothing to judge.
 */
export function speedupTable(eng) {
  if (!eng?.turboBuilds || eng.fixedSteps) return null;
  const table = { plain: {}, refs: {} };
  for (let n = 1; n <= (eng.turboMaxSteps ?? 12); n++) {
    table.plain[n] = speedupNeeded(eng, { steps: n })?.row ?? null;
    table.refs[n] = speedupNeeded(eng, { steps: n, refs: true })?.row ?? null;
  }
  return table;
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
 *  where H3 is offered, or where a card was not read (an AMD or Intel card
 *  whose memory Studio could not see: "cannot tell"). A PC with no card at
 *  all (the engine runs on the CPU, h3tier.js H3_NO_CARD) gets it too. */
export function h3NotOfferedLine(h3) {
  if (!h3 || h3.offered || (!h3.card && !h3.noCard)) return null;
  const why = h3.noCard
    ? "this PC has no graphics card for it to render on (Studio's engine runs on the CPU)"
    : h3.ramBelowFloor
      ? `this PC has ${h3.ramGb} GB of RAM, under the ${H3_RAM_FLOOR_GB} GB it needs`
      : `this card has ${h3.card.vramGb} GB of graphics memory, and nothing under ${H3_VRAM_OFFERED_GB} GB was tested`;
  return `H3 video is not offered here: ${why}. Ask a friend with a strong card first (${LENDING_UNTRIED}): Ask `
    + `friend, beside Render clip in Advanced, prepares this clip for their card, free. After that, a paid service `
    + `on your own key (${CLOUD_CARD_PLACE}).`;
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

/* ── keeping a character ──────────────────────────────────────────────────── */

/** The refusal for a saved character that is not on the shelf (reason "persona"). */
export function personaUnknown(name) {
  return `No saved character called "${name}". Pictures → Character… (or list_personas) shows the saved ones.`;
}

/** Which build a render loads, in words: "the 8-step reference build", "the
 *  TaoMate 3-step build", "the bare model" (workflow.js h3TurboLoraFor, the
 *  graph's own rule; the file's count is read off its name). */
function buildWords(eng, { steps, refs }) {
  const { turbo, lora } = h3TurboLoraFor(eng, { steps, refs });
  if (!turbo || !lora) return "the bare model";
  if (!refs && lora === eng.turboLora3) return "the TaoMate 3-step build";
  const made = loraStepsOf(lora);
  const n = Number.isFinite(made) ? `${made}-step ` : "";
  return refs ? `the ${n}reference build` : `the ${n}turbo build`;
}

/** The video decoder a render loads, short: the request's own (Engine
 *  settings, `videoVae`) when it names one, else the engine's. */
function decoderWords(b, eng) {
  const file = b.videoVae && b.videoVae !== "auto" ? String(b.videoVae) : String(eng.videoVae || "");
  const m = /(int8|int4|fp8|fp16|bf16|fp32)/i.exec(file);
  return m ? m[1].toLowerCase() : file.replace(/\.[a-z0-9]+$/i, "") || "the engine's";
}

/* THE MEASURED SETUP for keeping a character (the REWIND A/B, 2026-09-24,
 * DIRECTING.md §2): the ref2v 8-step v1.0 reference build at 8 steps, with
 * res_multistep, the fp16 video decoder and the song under the clip. A
 * constant, apart from workflow.js referenceSteps (the count THIS disk runs):
 * the Models screen's "Video references" fetches only the 4-step v0.1 file,
 * and on that disk keeping a character runs a setup nobody measured, which
 * the words say rather than calling it measured. */
export const KEEP_MEASURED = Object.freeze({
  steps: 8,
  decoder: "fp16",
  file: "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
});

/** Does this disk load the measured reference build at its own count? */
export function measuredBuildHere(eng) {
  const file = String(eng?.refTurboLora || "").split(/[\\/]/).pop();
  return eng?.refTurboSteps === KEEP_MEASURED.steps && file === KEEP_MEASURED.file;
}

/** The sentence for a saved character's pictures that could not be staged
 *  (/api/video create, warning "persona-missing"). */
export function personaMissing(name, lost) {
  return `${lost} of ${name}'s pictures could not be found and ${lost === 1 ? "was" : "were"} left out.`;
}

/**
 * SONG UNDER THE CLIP, per engine: the words beside the label (`meta`) and the
 * line under the picker (`hint`), which the Video screen writes from each
 * check (web/vidfit.js) so the page never promises lip-sync the engine does
 * not give. Lip-sync was measured on H3's reference path, with pictures of the
 * singer (the REWIND A/B, 2026-09-24); on H3's text path it is untested; on
 * LTX mouths were measured not to follow (r +0.034, n = 18,
 * docs/ENGINE_TRAPS.md).
 */
export function songUnderSay(engineKey, { label = engineKey, pictures = 0 } = {}) {
  if (engineKey === "h3") {
    return pictures > 0
      ? { meta: "lip-sync · optional", hint: "The mouth follows this stretch of the song (measured with pictures of the "
          + "singer): it sits under the clip while it renders. Set “start at” to where the sung line begins." }
      : { meta: "lip-sync with pictures · optional", hint: "With pictures of the singer (Keep my character) the mouth "
          + "follows this stretch of the song (measured); from words alone lip-sync is untested. Set “start at” to where "
          + "the sung line begins." };
  }
  if (engineKey === "ltx") {
    return { meta: "optional", hint: "The clip plays this stretch of the song, but mouths do not follow it on LTX (measured "
      + "on 18 clips). Set “start at” to where it should begin." };
  }
  return { meta: "optional", hint: `The clip plays this stretch of the song; lip-sync on ${label} was never measured. `
    + "Set “start at” to where it should begin." };
}

/**
 * THE FAST CHIP WHILE A CHARACTER IS KEPT (/api/status per engine `keepFast`):
 * the count the reference path really runs for Fast (the TaoMate 3-step build
 * is text-only, so a reference render in the Fast band loads the reference
 * build and runs its count, workflow.js h3MatchedSteps) and the chip's words.
 * null where there are no chips.
 */
export function keepFast(eng) {
  if (!eng?.stepDefaults || eng.fixedSteps) return null;
  const fast = Number(eng.stepDefaults.fast);
  const { steps, made } = h3MatchedSteps(eng, { steps: fast, refs: true });
  if (!Number.isFinite(steps)) return null;
  /* Where the engine is judged per path (perPath: NVIDIA and a card nobody
   * could read), null too, so the chip folds into Standard, when Fast would
   * not be a matched render at most Standard's count: its file is not on disk
   * (it was offered, lit, and the server refused it), or the count is above
   * Standard's (referenceSteps) or above what the loaded file was made for
   * (Keep's Fast at 20, the bare model, beside a Standard of 4). AMD, Intel
   * and the CPU keep main's chip exactly. */
  if (perPath(eng)) {
    if (speedupNeeded(eng, { steps, refs: true })) return null;
    const standard = Number(referenceSteps(eng) ?? NaN);
    if (standard > 0 && steps > standard) return null;
    if (Number.isFinite(made) && steps > made) return null;
  }
  return { steps, note: `Fast with a character: ${steps} steps on ${buildWords(eng, { steps, refs: true })}`
    + (fast === 3 ? " (the TaoMate 3-step build takes no pictures)" : "")
    + `. Keeping a character was measured at ${KEEP_MEASURED.steps} steps on the ${KEEP_MEASURED.steps}-step reference build.` };
}

/**
 * What a render keeps of a person, and the one line that says so. One copy of
 * each sentence; the Video screen (web/vidfit.js) and make_clip show them.
 *
 *   receipt  a saved character that rides is named ("keeps Mira: …"); pictures
 *            without one are what they are ("2 reference pictures"), and
 *            pictures the words never name are said ("not named"), because a
 *            picture the words never name barely shapes the clip.
 *   hint     the one line Simple shows, by priority: the person's own pictures
 *            the words never name, then a saved character the words never
 *            name, then the song for a singer; the missing measured build is
 *            said after any of them.
 */
function characterSay({ eng, pictures, own, ownUnnamed, audios, persona, bound, steps, song, prompt, characters }) {
  const keeps = pictures > 0;
  const who = persona && bound?.used > 0 ? persona.name : null;
  const measured = KEEP_MEASURED.steps;
  const here = measuredBuildHere(eng);
  const build = buildWords(eng, { steps, refs: true });
  const s = pictures === 1 ? "" : "s";
  const notNamed = !ownUnnamed.length ? ""
    : who || ownUnnamed.length < own ? `, ${ownUnnamed.length} not named` : ", not named";
  const receipt = keeps
    ? `${who ? `keeps ${who}: ${pictures} picture${s}` : `${pictures} reference picture${s}`}${notNamed} + ${steps} steps`
      + (!here ? ` (measured with ${measured}, not on this PC)` : steps < measured ? ` (measured with ${measured})` : "")
      + (song ? " + song (lip-sync)" : "")
    : `${audios ? "no pictures" : "text only"} · ${steps} steps` + (song ? " · song under the clip" : "");
  const saved = Array.isArray(characters) ? characters.filter((c) => c && c.name) : [];
  const namedHere = !keeps ? saved.find((c) => promptNames(prompt, c.name)) : null;
  const first = ownUnnamed[0];
  const lead = !keeps ? null
    : ownUnnamed.length
      ? `Name ${ownUnnamed.length === 1 ? "the picture" : "each picture"} in the words ("<Picture ${first}> is Mira."), `
        + "then write that name where they act (\"Mira runs…\"): a picture the words never name barely shapes the clip."
    : who && !bound.named
      ? `The words never name ${who}: write ${who} where they act ("${who} runs…") so the pictures attach to that person.`
    : !song ? "If they sing, choose Song under the clip (lip-sync) and where the sung line starts."
    : null;
  const missing = keeps && !here
    ? `Keeping a character was measured on the ${measured}-step reference build, which is not on this PC: this runs ${build}.`
    : null;
  const hint = keeps
    ? [lead, missing].filter(Boolean).join(" ") || null
    : namedHere
      ? `No picture of ${namedHere.name} rides: ${namedHere.name} can look different from clip to clip. Pick `
        + `${namedHere.name} under Keep my character.`
    : song
      ? "Lip-sync was measured with pictures of the singer; without them it is untested, and their face can change "
        + "from clip to clip."
    : saved.length
      ? "No reference picture: a person in this clip can look different from clip to clip. No one in the shot? Text "
        + "only is fine, and so is Fast. To keep someone, pick a saved character or drop 1–3 pictures of them here."
      : "No reference picture: a person in this clip can look different from clip to clip. No one in the shot? Text "
        + "only is fine, and so is Fast. To keep someone, drop 1–3 pictures of them here (tight, one person, a plain "
        + "dark background), or save a character on Pictures.";
  return { keeps, pictures, persona: who, unnamed: ownUnnamed.length, steps, measuredSteps: measured, measuredHere: here,
    song, receipt, hint };
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
 *   persona   a saved character (personas.js row), or {name, missing:true}
 *             for a name the shelf does not have; its pictures ride after
 *             b.refImages, bound in the words (bindPersonaForClip)
 *   characters the saved characters with pictures, [{name, pictures}], only
 *             for the Keep line's hint ("pick X")
 *
 * Returns { refusal, prompt, refImages, width, height, seconds, steps, sparse,
 * sampler, fit, character, songLine, warnings, notes }: `refusal` ({error,
 * reason}) when the request must not render, the values the job carries
 * otherwise (refImages with the character's pictures after the request's),
 * `character` what the render keeps of a person (H3 only, null elsewhere),
 * `songLine` Song under the clip's words for this engine ({meta, hint},
 * songUnderSay), `warnings` [{id, text}]
 * that the reply and the page show, and `notes` [{id, text}], caveats that
 * change nothing (the Advanced line and check_only show them; a render's reply
 * does not repeat them). Nothing in it is silent: every value it changes from
 * the request has a warning saying so.
 */
export function videoPlan(b = {}, { engineKey, eng = {}, h3 = null, framed = false, control = false, persona = null, characters = [] } = {}) {
  const label = eng.label || engineKey;
  const family = isH3Family(engineKey);
  const warnings = [], notes = [];
  const refsRide = engineKey === "h3";

  /* A saved character the shelf does not have: refused by name. */
  if (persona?.missing) {
    return { refusal: { error: personaUnknown(persona.name), reason: "persona" }, warnings, notes, character: null, sampler: null,
      songLine: songUnderSay(engineKey, { label }) };
  }
  /* A saved character's pictures ride after the request's own, each bound in
   * the words as "<Picture N> is Name." (personas.js bindPersonaForClip). */
  const bound = persona && refsRide ? bindPersonaForClip(persona, { prompt: b.prompt, refImages: b.refImages }) : null;
  const refList = bound ? bound.refImages : Array.isArray(b.refImages) ? b.refImages.filter(Boolean) : [];
  const pictures = Math.min(refList.length, 9);
  const audios = Array.isArray(b.refAudios) ? Math.min(b.refAudios.filter(Boolean).length, 3) : 0;
  /* Song under the clip, in this engine's words (the label and the line under it). */
  const songLine = songUnderSay(engineKey, { label, pictures });

  /* References on an engine without them: refused, by the one sentence. A
   * saved character is references, so it is refused the same way. */
  if ((pictures || audios || persona) && !refsRide) {
    return { refusal: { error: refsIgnored(engineKey, label), reason: "refs-ignored" }, warnings, notes, character: null, sampler: null,
      songLine };
  }

  /* Tags nothing answers: out of the words, and said. */
  let prompt = String(bound ? bound.prompt : b.prompt || "").trim();
  const loose = unresolvedRefTags(prompt, { pictures, audios, refsRide });
  if (loose.length) {
    prompt = withoutTags(prompt, loose);
    warnings.push({ id: "tags", text: refTagSentence(loose, { engineLabel: label, refsRide }) });
    if (!prompt) {
      return { refusal: { error: "Describe the clip first: the description held only reference tags that nothing "
        + "attached answers.", reason: "empty" }, warnings, notes, songLine };
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
  if (hasS && seconds !== askedS) {
    warnings.push({ id: "seconds", text: `This direct clip runs ${seconds} s, not the requested ${askedS} s (the direct-clip range is 1–20 s). `
      + "Use Continue clip for another segment instead of expecting a single longer render." });
  }
  if (start) {
    const cut = !hasS && seconds > start.maxSeconds;
    if (cut) seconds = start.maxSeconds;
    const why = start.measured ? "the size this card was measured to fit"
      : "this card's experimental preview size, not yet seen to fit";
    warnings.push({ id: "size", text: `No size was named, so this renders at ${start.width}x${start.height}`
      + `${cut ? ` for ${seconds} s` : ""}, ${why} (${start.chip}). Name a width and height to choose another.` });
  }

  /* Steps: a fixed schedule records its own; a render with references that
   * names no count runs the reference build's own (referenceSteps: 8 where the
   * 8-step reference file is on disk, the REWIND A/B's setting); the reference
   * path in the Fast band runs the loaded file's count when asked for fewer
   * (said). A count the request names is kept, and the notes say when it is
   * under the one keeping a character was measured at. */
  const askedSteps = num(b.steps);
  const refsOn = engineKey === "h3" && !!(pictures || audios || b.refMods?.length);
  const unnamed = eng.steps || 20;
  let steps = eng.fixedSteps || Math.min(Math.max(Number.isFinite(askedSteps) && askedSteps > 0 ? askedSteps
    : (refsOn && referenceSteps(eng)) || unnamed, 2), 40);
  if (refsOn) {
    const m = h3MatchedSteps(eng, { steps, refs: true });
    if (m.raised) {
      warnings.push({ id: "steps", text: `With references this runs ${m.steps} steps, not ${m.asked}: the reference `
        + `build that loads is ${aN(m.made)} ${m.made}-step file, and it runs at its own step count.` });
      steps = m.steps;
    }
  }

  /* What this render keeps of a person (characterSay), H3 only: the Keep my
   * character line and receipt. The song flag is the soundtrack the render
   * carries (`audioTrack`), or `song: true` from the Video screen's check,
   * whose upload lives in the page. The person's own pictures (numbered
   * first) that the words never name are counted: a picture the words never
   * name barely shapes the clip, so the receipt and the Keep line say it (the
   * A/B's winning arm named every picture). */
  const keepSay = () => {
    const song = !!(b.audioTrack?.name || b.song === true);
    const own = Math.min(bound ? refList.length - bound.used : refList.length, 9);
    const ownUnnamed = [];
    for (let i = 1; i <= own; i++) if (!new RegExp(`<\\s*Picture\\s+${i}\\s*>`, "i").test(prompt)) ownUnnamed.push(i);
    return characterSay({ eng, pictures, own, ownUnnamed, audios, persona, bound, steps, song, prompt, characters });
  };

  /* A step count whose speed-up is not on disk: each slot falls back to
   * another build's name (which may not be on disk either), and a build run
   * at another build's step count is a different model used wrongly.
   * Refused, with the download offered (needsModel opens the model window on
   * that row). The speed-ups are optional; Best (20) needs none.
   * The refusal carries the Keep my character line and Song under the clip's
   * words like every other refusal here: without them the Video screen
   * blanked the Keep line and its receipt, and kept the last check's song
   * line, while the slider sat on a missing speed-up (web/vidfit.js paintKeep
   * and paintSong read them from the check). Words only, so on every card. */
  if (engineKey === "h3") {
    const need = speedupNeeded(eng, { steps, refs: refsOn });
    if (need) {
      return { refusal: { error: need.error, reason: need.build === 3 ? "taomate-missing" : "speedup-missing",
        needsModel: need.row }, warnings, notes, character: keepSay(), sampler: null, songLine };
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
    const cfg = h3SparseFor(eng, { steps, refs: refsOn, sparse: sparseWant, control });
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
  if (engineKey === "h3") {
    const frames = alignFrames(seconds, eng.fps || 24, "h3");
    const fitted = Number(eng.costFitMaxMpxFrames);
    if (Number.isFinite(fitted) && fitted > 0 && width * height * frames / 1e6 > fitted) {
      notes.push({ id: "time-extrapolated", text: "The render-time prediction is outside the four measured "
        + "size/length points used to fit it. Long H3 clips can take much longer or run out of memory." });
    }
    if (frames > 362) {
      warnings.push({ id: "length-untrained", text: `This request becomes ${frames} frames, beyond H3's roughly `
        + "124–362-frame trained range. A short clip followed by Continue clip is safer than one long render." });
    }
  }

  /* KEEPING A CHARACTER, on H3 (the only engine with a picture input):
   * keepSay above, and the notes about it. */
  let character = null, sampler = null;
  if (engineKey === "h3") {
    const measured = KEEP_MEASURED.steps;
    sampler = h3SamplerFor(eng, { steps, refs: refsOn });
    character = keepSay();
    if (bound && bound.extra > 0) {
      const total = Number.isFinite(persona.pictures) ? persona.pictures : (persona.refImages || []).filter(Boolean).length;
      warnings.push({ id: "persona-pictures", text: bound.room > 0
        ? `${persona.name} has ${total} pictures; a clip takes the first ${Math.min(bound.room, total)} (the measured setup `
          + "is 1–3 of one character)."
        : `${persona.name}'s pictures do not ride: ${pictures} reference pictures are attached already, the most a clip takes.` });
    }
    const decoder = decoderWords(b, eng);
    notes.push({ id: "runs", text: `Runs: ${buildWords(eng, { steps, refs: refsOn })} · ${steps} steps · ${sampler} sampler · `
      + `${decoder} video decoder.` });
    if (pictures > 3) {
      notes.push({ id: "pictures", text: `${pictures} reference pictures ride. The measured setup is 1–3 per character (face for `
        + "a close-up; body + face for a medium; body + side + face for action); a fourth of one person was never tried, "
        + "and neither was its cost (up to three, each extra picture adds about 9 s at 8 steps, fitted on four clips with "
        + "1–3 pictures on a 16 GB card)." });
    }
    if (bound && bound.used > 0 && !bound.named) {
      notes.push({ id: "persona-unnamed", text: `The description never names ${persona.name}: write ${persona.name} where they `
        + `act ("${persona.name} runs…") so the pictures attach to that person.` });
    }
    if (character.keeps && (steps < measured || !character.measuredHere)) {
      notes.push({ id: "steps-measured", text: `Keeping a character was measured on the ${measured}-step reference build at `
        + `${measured} steps; this runs ${steps} on ${buildWords(eng, { steps, refs: true })}`
        + (character.measuredHere ? "." : `. That file (${KEEP_MEASURED.file}, in models/loras) is not on this PC, and `
          + "the Models screen does not fetch it yet.") });
    }
    if (character.keeps && decoder !== KEEP_MEASURED.decoder) {
      notes.push({ id: "decoder", text: `The measured setup used the ${KEEP_MEASURED.decoder} video decoder; this runs `
        + `${decoder} (the decoder was not isolated in that test). Engine settings → Video VAE can pick an `
        + `${KEEP_MEASURED.decoder} file.` });
    }
    if (audios) {
      notes.push({ id: "audio-ref", text: "A sound reference (<Audio n>) shapes the clip's own sound, and the clip re-sings it "
        + "in its own time; for a mouth that follows your song, use Song under the clip instead." });
    }
  }

  return { refusal: null, prompt, refImages: refList, width, height, seconds, steps, sparse, sampler, fit, character, songLine,
    warnings, notes };
}
