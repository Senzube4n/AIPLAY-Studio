/**
 * THE MUSIC VIDEO'S SIZE FOLLOWS THE CARD. The one list of sizes a project
 * can render at, the two shapes it can render in, and the longest scene the
 * cut makes by default. Everything that sizes a music-video clip reads this
 * file: renderSize() in generate.js (the generator and the export), the
 * collab packet and the order that inverts it, set_brief's validation,
 * mv_set_brief's enum, and the Workflow brief's size control.
 *
 * ONE LIST, NOT A SECOND COPY OF THE TIER TABLE. The brief has always stored
 * the size as `qualityMode` (budget / recommended / high). The card tiers the
 * H3 lab measured live in server/h3tier.js. The three tier sizes are read
 * from there (never retyped here), labels included, so the brief names a size
 * the way the Models and Video screens do. The two older values stay beside
 * them, because projects and agents already use them:
 *
 *   recommended  Full size       H3_TIERS "full"     1344x768
 *   small        Smaller size    H3_TIERS "small"    960x544
 *   preview      Preview         H3_TIERS "preview"  832x480, experimental
 *   budget       Draft           864x480, the vendor's 0.4-megapixel default
 *   high         High            1920x1088, above H3's native size
 *
 * THE REFERENCE PATH'S EVIDENCE, NOT THE FAST SETTING'S. A music video's
 * scenes render with the cast's pictures on H3's 8-step reference build, and
 * the lab measured that path only at 960x544 with ONE picture (314 MiB to
 * spare under an 8 GB cap); full size there is predicted, the preview size was
 * not run at all, and several pictures were never capped. So every note and
 * "Studio's pick" sentence here quotes h3tier.js H3_PATHS.refs, never the
 * TaoMate text-to-video runs the Video screen's tiers were measured with as
 * if they were its own (the preview's says the text-only run is all there is).
 *
 * PURE. No I/O. It imports only h3tier.js, which is pure too, so the MCP
 * process (server/mcp-mv.js) can read the list without loading the server.
 * The card reading comes in as an argument, the way h3tier.js takes it.
 */
import { H3_TIERS, H3_PATHS, H3_LAB_CARD_GB, H3_RAM_FLOOR_GB, H3_VAE_CAVEAT, h3TierFor, gbWithArticle } from "../h3tier.js";

const tier = (id) => H3_TIERS.find((t) => t.id === id);
const FULL = tier("full");
const SMALL = tier("small");
const PREVIEW = tier("preview");

/** "an 8 GB card", "a 12 GB card": h3tier.js's article helper, the one copy. */
const an = (n) => gbWithArticle(n).split(" ")[0];
/* The reference path's evidence per tier (h3tier.js H3_PATHS.refs): what a
 * music video's scenes really render on. */
const REFS = H3_PATHS.refs;
const MORE_PICTURES = "A cast with more than one picture was not measured at this size.";

/* The two sizes that are not a card tier, typed once, here. */
const DRAFT = Object.freeze({ width: 864, height: 480 });
const HIGH = Object.freeze({ width: 1920, height: 1088 });
const HD720 = Object.freeze({ width: 1280, height: 720 });
/* The scene length the two shipped High films were cut to: both Bone Waffle
 * films rendered 1920x1088 in 5 s scenes on the lab's 16 GB card (plancost.js
 * COST_ROWS "h3-4-1080" prices that row). */
const HIGH_FILM_SCENE_SEC = 5;

/**
 * THE LONGEST SCENE ONE CLIP MAY RUN, the renderer's own clamp
 * (generate.js sends at most this many seconds) and the cap a scene retimed by
 * hand is held to (segmentation.js resnapSegment). Never a default: the cut's
 * default is each size's `cutSec` below, or LTX_CUT_SEC.
 */
export const MV_CLIP_CEILING_SEC = 15;

/**
 * The website segmenter's own longest scene, kept for a project that renders
 * on LTX: the H3 lab's lengths are H3 measurements and say nothing about LTX,
 * and every LTX project in this library was cut at 15 s.
 */
export const LTX_CUT_SEC = MV_CLIP_CEILING_SEC;

/**
 * The sizes, in the order the brief offers them. `width` x `height` is the
 * LANDSCAPE pair; 9:16 swaps them. `tier` names the h3tier.js row a size is,
 * or null for the two sizes the lab did not measure as a card tier.
 *
 * `cutSec` is the longest scene the cut makes by default at this size on H3,
 * and `cutWhy` says where that number comes from, honestly: measured, not
 * proven, or not measured at all.
 */
export const MV_SIZES = Object.freeze([
  Object.freeze({
    id: "recommended", tier: "full", label: FULL.label,
    width: FULL.width, height: FULL.height, experimental: false,
    note: `H3's own size. ${REFS.full.at16.evidence} ${MORE_PICTURES}`,
    cutSec: FULL.maxSeconds,
    cutWhy: `measured up to ${FULL.maxSeconds} s at ${FULL.width}x${FULL.height} under ${an(FULL.minGb)} `
      + `${FULL.minGb} GB memory cap on the lab's ${H3_LAB_CARD_GB} GB card (text to video, the Fast setting); `
      + "longer is untested",
  }),
  /* 720P, the first pick on a full-size AMD or Intel card (the owner's call,
   * 2026-09-25; config.js prefers720p). Below H3's trained size, so the
   * full-size evidence covers it; an LTX project floors it to 1280x704. */
  Object.freeze({
    id: "hd720", tier: null, label: "720p",
    width: HD720.width, height: HD720.height, experimental: false,
    note: `1280x720, below H3's trained ${FULL.width}x${FULL.height}. Studio's first pick on AMD and Intel cards. `
      + "An LTX project renders it at 1280x704.",
    cutSec: FULL.maxSeconds,
    cutWhy: `smaller than full size's ${FULL.width}x${FULL.height}, so it takes full size's ${FULL.maxSeconds} s`,
  }),
  Object.freeze({
    id: "small", tier: "small", label: SMALL.label,
    width: SMALL.width, height: SMALL.height, experimental: false,
    note: `${REFS.small.evidence} ${MORE_PICTURES} ${H3_VAE_CAVEAT}`,
    cutSec: SMALL.maxSeconds,
    cutWhy: `measured at ${SMALL.maxSeconds} s at ${SMALL.width}x${SMALL.height} under ${an(SMALL.minGb)} `
      + `${SMALL.minGb} GB memory cap on the lab's ${H3_LAB_CARD_GB} GB card, with one reference picture as well; `
      + "longer is untested",
  }),
  Object.freeze({
    id: "preview", tier: "preview", label: PREVIEW.label,
    width: PREVIEW.width, height: PREVIEW.height, experimental: true,
    note: REFS.preview.evidence,
    cutSec: PREVIEW.maxSeconds,
    cutWhy: `not proven at any length: ${PREVIEW.width}x${PREVIEW.height} for ${PREVIEW.maxSeconds} s was tried `
      + `under ${an(PREVIEW.minGb)} ${PREVIEW.minGb} GB memory cap and went over`,
  }),
  Object.freeze({
    id: "budget", tier: null, label: "Draft",
    width: DRAFT.width, height: DRAFT.height, experimental: false,
    note: "The video vendor's own 0.4-megapixel default: the cheapest size here, with soft faces. "
      + `Not one of the sizes the H3 lab measured; close to ${PREVIEW.label} (${PREVIEW.width}x${PREVIEW.height}).`,
    cutSec: FULL.maxSeconds,
    cutWhy: `not measured at ${DRAFT.width}x${DRAFT.height}; it takes full size's ${FULL.maxSeconds} s, `
      + "and this picture is smaller than full size's",
  }),
  Object.freeze({
    id: "high", tier: null, label: "High",
    width: HIGH.width, height: HIGH.height, experimental: false,
    note: `Above H3's native ${FULL.width}x${FULL.height}, which it was not trained at. On H3 about 11 min `
      + `per 5 s scene at 4 steps, only ever rendered on a ${H3_LAB_CARD_GB} GB card (the two Bone Waffle `
      + "films). 1088, not 1080: LTX floors each side to a multiple of 64.",
    cutSec: HIGH_FILM_SCENE_SEC,
    cutWhy: `not measured by the lab at ${HIGH.width}x${HIGH.height}; the two Bone Waffle films rendered it `
      + `in ${HIGH_FILM_SCENE_SEC} s scenes on a ${H3_LAB_CARD_GB} GB card; longer was not tried, and ${FULL.maxSeconds} s `
      + "at this size is outside the range h3tier's memory estimate was fitted on",
  }),
]);

/** The brief values, for validation and for the MCP enum. */
export const MV_SIZE_IDS = Object.freeze(MV_SIZES.map((s) => s.id));

/** A brief that names no size, or one this list does not know, renders at full size. */
export const MV_SIZE_DEFAULT = "recommended";

/**
 * THE TWO SHAPES renderSize() MAKES. 1:1, 4:3 and 21:9 used to be offered and
 * were rendered as 16:9 1344x768 without a word; they are not offered now.
 * A project that stored one of them still renders 16:9, and says so
 * (aspectNote below).
 */
export const MV_ASPECTS = Object.freeze(["16:9", "9:16"]);

export const sizeById = (id) => MV_SIZES.find((s) => s.id === id) || null;

/** The size row a brief renders at. */
export function sizeOfBrief(brief) {
  return sizeById(brief?.qualityMode) || sizeById(MV_SIZE_DEFAULT);
}

/** [width, height] as rendered: the size's pair, swapped for 9:16. */
export function renderSizeOf(brief) {
  const s = sizeOfBrief(brief);
  return brief?.aspectRatio === "9:16" ? [s.height, s.width] : [s.width, s.height];
}

/** The sentence for a stored shape this build does not render, or null. */
export function aspectNote(brief) {
  const a = brief?.aspectRatio;
  if (!a || MV_ASPECTS.includes(a)) return null;
  const [w, h] = renderSizeOf(brief);
  return `This project was set to ${a}, which Studio does not render: its clips render 16:9 at `
    + `${w}x${h}. Choose 16:9 or 9:16 and save the brief to record what it really is.`;
}

/**
 * THE LONGEST SCENE THE CUT MAKES BY DEFAULT, and where the number comes from.
 *
 *   an LTX project   15 s, the website segmenter's own (LTX_CUT_SEC): the H3
 *                    lab measured H3, not LTX.
 *   anything else    the size's `cutSec` (8 s at full size, 5 s at the two
 *                    smaller tiers and at High), with its `cutWhy`.
 *
 * It is a default, not a cap: the cut's own box takes any number up to the
 * 15 s ceiling. A shorter default never leaves song without a picture: a line
 * longer than it is split into back-to-back scenes (cutfill.js).
 */
export function sceneCutFor(brief) {
  if (brief?.videoEngine === "ltx") {
    return { maxClipSec: LTX_CUT_SEC, engine: "ltx",
      why: `LTX project: the website segmenter's own ${LTX_CUT_SEC} s. The H3 lab's lengths are H3 measurements and do not apply to LTX.` };
  }
  const s = sizeOfBrief(brief);
  return { maxClipSec: s.cutSec, engine: "h3", why: `${s.label}, ${s.width}x${s.height}: ${s.cutWhy}.` };
}

/** The number alone, for the cut itself. */
export function sceneMaxSecFor(brief) {
  return sceneCutFor(brief).maxClipSec;
}

/** The brief value for a card's H3 tier, or null when no size is chosen for it. */
const PICK_FOR_TIER = Object.freeze({ full: "recommended", small: "small", preview: "preview" });

/**
 * WHAT THIS CARD GETS, for the brief's size control and for mv_open_project.
 * Readings in, judgements out; the page only displays them.
 *
 *   gpu  gpuStatus() (totalMb, vendor, name) or null
 *   ram  ramStatus() (totalMb) or null
 *   cpuOnly      no card, and Studio's engine runs on the CPU (index.js
 *                cpuOnlyEngine): not offered, said as such, never "the card's
 *                memory could not be read"
 *   vaeMeasured  this PC loads the video decoder the H3 lab measured with
 *                (h3tier.js H3_VAE_MEASURED): no decoder caveat in the pick
 *
 * `cardPick` is the brief value a new project starts at (null: the card could
 * not be read, or H3 is not offered on this machine, and the project keeps
 * full size). Each choice says whether this card reaches it, and why not in a
 * sentence. `ramWarning` is h3tier's own sentence for a machine with less RAM
 * than H3 was measured with; the brief shows it under the size.
 */
export function sizeChoices({ gpu = null, ram = null, cpuOnly = false, vaeMeasured = false } = {}) {
  const vramMb = Number(gpu?.totalMb) > 0 ? Number(gpu.totalMb) : null;
  const ramMb = Number(ram?.totalMb) > 0 ? Number(ram.totalMb) : null;
  /* path "refs": the scenes render with the cast's pictures (see the header). */
  const t = h3TierFor({ vramMb, ramMb, vendor: gpu?.vendor || null, path: "refs",
    cpuOnly: vramMb === null && !!cpuOnly, vaeMeasured: !!vaeMeasured });
  /* A card H3 is not offered on gets no pick, whether the card or the RAM is
   * why: "Studio's pick for this card" beside "H3 is not offered here" would
   * be two answers to one question. */
  const off = gpu?.vendor === "amd" || gpu?.vendor === "intel";
  /* 720p first on a full-size card that is not NVIDIA (the hd720 row above). */
  const cardPick = t.offered ? (t.id === "full" && off ? "hd720" : PICK_FOR_TIER[t.id] ?? null) : null;
  const cardGb = t.cardGb ?? null;
  const choices = MV_SIZES.map((s) => {
    const needsGb = s.tier ? tier(s.tier).minGb : s.id === "high" ? H3_LAB_CARD_GB : null;
    const fits = cardGb === null || needsGb === null ? null : cardGb >= needsGb;
    const line = fits === false
      ? (s.tier ? `Needs ${an(needsGb)} ${needsGb} GB card for H3; this one has ${cardGb} GB.`
        : `Only ever rendered on ${an(needsGb)} ${needsGb} GB card; this one has ${cardGb} GB.`)
      : !s.tier && s.id !== "high" && s.id !== "hd720"
        ? `Not one of the sizes the H3 lab measured; close to ${PREVIEW.label} (${PREVIEW.width}x${PREVIEW.height}).`
      : null;
    return {
      id: s.id, label: s.label, width: s.width, height: s.height,
      experimental: s.experimental, tier: s.tier, needsGb, fits, line,
      forCard: s.id === cardPick, note: s.note,
    };
  });
  const pick = cardPick ? sizeById(cardPick) : null;
  const why = pick
    ? `Studio's pick for this ${cardGb} GB card: ${pick.label}, ${pick.width}x${pick.height}. `
      + `Scenes render with the cast's pictures: ${t.evidence}`
      + (t.experimental ? "" : ` ${MORE_PICTURES}`)
      + (t.recommend ? "" : ` ${t.notRecommended || ""}`)
    : t.id === "unknown"
      ? `${t.evidence} New projects start at full size.`
      /* No card at all: the Video screen's answer, not "could not be read". */
      : t.noCard
        ? `H3 is not offered on this PC, so no size is picked for it and new projects start at full size. ${t.evidence}`
      : t.ramBelowFloor && t.id !== "none"
        ? `H3 is not offered on this machine: it has ${t.ramGb} GB of RAM, under the ${H3_RAM_FLOOR_GB} GB `
          + "H3 needs, so no size is picked for it and new projects start at full size."
        : `H3 is not offered on this ${cardGb} GB card, so no size is picked for it and new projects `
          + "start at full size. " + (t.evidence || "");
  return {
    choices,
    cardPick,
    cardGb,
    tier: t.id,
    offered: !!t.offered,
    why: why.trim(),
    /* Paging advice is for a machine H3 runs on; where it is not offered the
     * sentence above already says why, and advice to tune it would be noise. */
    ramWarning: t.offered ? t.ramWarning ?? null : null,
    aspects: [...MV_ASPECTS],
  };
}

/** One line for the MCP enum's description, built from the list. */
export function sizeEnumText() {
  return MV_SIZES.map((s) => `${s.id} ${s.width}x${s.height} (${s.label}${s.experimental ? ", experimental" : ""})`).join(", ");
}

/** Which card starts a new project at which size, from h3tier.js's own rows,
 *  so a tool's description never carries a second copy of the thresholds. */
export function cardTierText() {
  return MV_SIZES.filter((s) => s.tier).map((s) =>
    `${s.id} ${s.width}x${s.height} from ${tier(s.tier).minGb} GB${s.experimental ? " (experimental)" : ""}`)
    .join(", ");
}

/** The default longest scene per size, for a tool's description, from the rows. */
export function cutDefaultText() {
  return MV_SIZES.map((s) => `${s.id} ${s.cutSec} s`).join(", ")
    + `; an LTX project ${LTX_CUT_SEC} s`;
}
