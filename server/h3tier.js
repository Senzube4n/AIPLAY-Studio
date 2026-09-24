/**
 * H3 CARD TIERS: which size and length MiniMax H3 is offered at, from the
 * card's memory. The ONE source for these numbers. The Models screen's H3 rows
 * (server/fit.js), their requirement lines (server/models.js), the status the
 * page polls (/api/status config.video.h3), models_for_this_machine and
 * studio_status all read this file; nothing else may type a tier threshold.
 *
 * PURE. No I/O, no imports: a card reading and a RAM figure go in, a tier and
 * an estimate come out. The card reading is the one the rest of Studio
 * already takes (server/gpu.js gpuStatus(), which falls back to the
 * settings.json `gpu` block that comfyargs.js autoVramFlags() reads). This
 * file never probes a card itself.
 *
 * WHERE THE NUMBERS COME FROM. The H3 lab of 2026-09-24 (one 16 GB card,
 * 16,376 MiB, 32 GB of RAM, ComfyUI 0.36 with comfy-aimdo, the int8 DiT, CK
 * attention, TaoMate 3-step = the Video screen's Fast setting, text to video).
 * The 12, 8 and 6 GB results were memory CAPS on that card, not real smaller
 * cards: a cap limits memory, not speed, so a real smaller card is slower than
 * the times quoted here.
 *
 *   16 GB       1344x768 up to 9.4 s.
 *   12 GB cap   1344x768, 8 s: frames bit-identical to the 16 GB render, same
 *               172 s wall. Run with --lowvram; the Auto memory setting gives a
 *               12 GB card ComfyUI's normal mode, which was not tested.
 *   8 GB cap    960x544, 5 s fit (7,425 of 8,192 MiB with a 2.45 GB desktop),
 *               99.4 s wall. 1344x768, 8 s did not fit (the engine alone ~9 GB).
 *               FastH3 (121.6 s) and the one-picture reference path (137.8 s,
 *               314 MiB to spare) fit there too.
 *   6 GB cap    nothing fit with this machine's 2.6-2.8 GB desktop: 832x480,
 *               5 s went over by 631 MiB, 640x352, 4.5 s by 220 MiB. The engine
 *               itself needed 4,192 and 3,575 MiB.
 *   under 6 GB  not tested; no run anywhere used under 3.6 GB of engine memory.
 *   RAM         every run filled 32 GB; nothing with less was tried.
 *
 * WHAT IS RECOMMENDED, NOT ONLY OFFERED. A tier says what the card can be
 * given; `recommend` says whether Studio should put a 40 GB download in front
 * of a newcomer for it. Only what was measured is recommended: a measured tier
 * (full, small), on NVIDIA, with the 32 GB of RAM the lab had. The preview,
 * an AMD card and a machine under 32 GB of RAM are offered with their reason
 * and never recommended (INSTALLER_PLAN step 12 makes the same cut).
 *
 * THE VRAM RULE. Size times length is the only lever. A fit over the seven
 * capped TaoMate runs: engine MiB = 2,764 + 0.110 per video token, every run
 * within 161 MiB; tokens = (5 * floor((frames - 5) / 17) + 2) * (w/32) * (h/32).
 * Allow about 0.5 GB of margin on top (the desktop's own use drifted by up to
 * 250 MiB during runs), reported separately so nobody mistakes it for the fit.
 * The fit covers 7,040 to 57,456 tokens; longer clips at full size are
 * extrapolation, and the estimate says so (`inFittedRange`).
 *
 * NOTHING PICKS THE SIZE YET. The Video and Workflow screens still start at
 * 1344x768; wiring them to the tier is the next change. Until it lands every
 * sentence here that names a smaller size says how to set it by hand
 * (h3SetSizeByHand), and none claims Studio does it. When the wiring lands,
 * that function, h3TierSummary(), fit.js's FIT_STATES.smaller line and the
 * models_for_this_machine description are the four places to reword.
 */

/** The fitted line, and the one number added on top of it. */
export const H3_FIT = Object.freeze({
  baseMiB: 2764,
  perTokenMiB: 0.110,
  marginMiB: 512,
  maxErrorMiB: 161,
  fittedTokens: Object.freeze([7040, 57456]),
  runs: 7,
});

/** H3's frame rate. The frame grid (17k + 5) is counted in these. */
export const H3_FPS = 24;

/** The only system RAM H3 was ever measured with. Every run filled it. The
 *  rows print it as the recommended RAM, and only it earns a recommendation. */
export const H3_RAM_MEASURED_GB = 32;
/* The RAM floor: under it H3 is not offered. Nobody has run H3 with less than
 * 32 GB, so this is a judgement, stated as one: under half of what the lab
 * filled, the 21 GB DiT alone does not fit in RAM. The rows print it as the
 * minimum, and fit.js refuses under it, so the printed number is the enforced
 * one. The Fun ControlNet and TaoMate rows asked for 16 before the lab. */
export const H3_RAM_FLOOR_GB = 16;
/** The lab's own card. Smaller cards were memory caps on it, not real cards. */
export const H3_LAB_CARD_GB = 16;

export const H3_RAM_WARNING = `H3 was only measured with ${H3_RAM_MEASURED_GB} GB of RAM and filled it; `
  + "with less, expect heavy paging - set a large pagefile.";

export const H3_AMD_NOTE = "No H3 render has been tested on an AMD card yet.";

/* What someone under the floor can do instead: a friend's card first, never a
 * paid route by default (the owner's rule, 2026-09-24). */
export const H3_ASK_A_FRIEND = "Ask a friend with a bigger machine to render it: Ask friend on the Video screen, "
  + "or on a scene in Workflow, prepares the recipe for their card.";

/** How to set a tier's size until the Video screen does it (see the header). */
export function h3SetSizeByHand(tier) {
  return `Studio does not pick this size for you yet: on the Video screen choose size "custom…", `
    + `type ${tier.width} x ${tier.height}, and keep the length at ${tier.maxSeconds} s or under.`;
}

/**
 * The tiers, biggest card first. `minGb` is the card's memory rounded to the
 * nearest whole GB, the number on the box (server/fit.js explains why a
 * 12 GB card that reads 11.99 must count as 12). `maxSeconds` is the longest
 * clip MEASURED to fit at the tier's smallest card, not a cap: longer is
 * untested, not forbidden. `evidence` is for the Fast setting (TaoMate
 * 3-step), the path the lab measured; H3_PATHS qualifies it for the others.
 */
export const H3_TIERS = Object.freeze([
  Object.freeze({
    id: "full", minGb: 12, label: "Full size",
    plain: "Full quality: 1344x768, measured up to 8 s",
    width: 1344, height: 768, maxSeconds: 8, measured: true, experimental: false,
    evidence: "Measured with the Fast setting (TaoMate 3-step): up to 9.4 s on a 16 GB card, and under a "
      + "12 GB cap, where 1344x768 for 8 s came out bit-identical to the 16 GB render in the same 172 s. "
      + "Longer clips are untested.",
    /* Said to cards under the lab's own 16 GB only (h3TierFor): on those, the
     * capped run is the evidence, and it was not run the way Auto runs them. */
    caveat: "That capped run used --lowvram; the Auto memory setting gives a 12 GB card normal mode, "
      + "which is untested at 12 GB.",
  }),
  Object.freeze({
    id: "small", minGb: 8, label: "Smaller size",
    plain: "Smaller size: 960x544, 5 s",
    width: 960, height: 544, maxSeconds: 5, measured: true, experimental: false,
    evidence: "Measured with the Fast setting (TaoMate 3-step) under an 8 GB cap on a 16 GB card: 960x544 "
      + "for 5 s fit, about 100 s a clip there, and 1344x768 for 8 s did not. The 8-step Standard setting "
      + "was not timed at this size. A real 8 GB card is a slower GPU, so expect longer.",
  }),
  Object.freeze({
    id: "preview", minGb: 6, label: "Preview",
    plain: "Preview only: 832x480, 5 s (experimental, not proven)",
    width: 832, height: 480, maxSeconds: 5, measured: false, experimental: true,
    evidence: "Experimental, not proven: under a 6 GB cap 832x480 for 5 s went over by 631 MiB with a "
      + "2.6 GB desktop counted, and should fit with less running on the card. Close GPU-heavy apps or "
      + "plug the monitor into the integrated graphics.",
  }),
  Object.freeze({
    id: "none", minGb: 0, label: "Not offered",
    plain: "H3 is not offered on this card",
    width: null, height: null, maxSeconds: 0, measured: false, experimental: false,
    evidence: "No H3 run anywhere used less than 3.6 GB of engine memory, and nothing under 6 GB was "
      + `tested. ${H3_ASK_A_FRIEND}`,
  }),
]);

const tierById = (id) => H3_TIERS.find((t) => t.id === id);

/**
 * THE OTHER H3 PATHS. The tiers were measured on the Fast setting; FastH3 and
 * the reference path were measured at 960x544 under the 8 GB cap only, so at
 * full size on a card under the lab's 16 GB their answer is a PREDICTION, and
 * a row must not quote TaoMate's "bit-identical" as its own. Per tier id:
 * `below16` / `at16` for full size (a 16 GB card is where the lab ran them
 * natively, or did not), a plain string for the others. `measured` false
 * where the sentence is a prediction. A tier or path not listed keeps the
 * Fast setting's evidence (the preview and "none" do not depend on the path).
 */
export const H3_PATHS = Object.freeze({
  fasth3: Object.freeze({
    full: {
      at16: { measured: true, evidence: "Measured for FastH3 on a 16 GB card: 1344x768 for 8 s in about 236 s, "
        + "1.4x the Fast setting's wait." },
      below16: { measured: false, evidence: "FastH3 was not run under a 12 GB cap: 1344x768 on this card is "
        + "PREDICTED from the Fast setting's measurement (at 960x544 FastH3's memory was within 50 MiB of it), "
        + "not measured." },
    },
    small: { measured: true, evidence: "Measured for FastH3 under an 8 GB cap on a 16 GB card: 960x544 for 5 s "
      + "fit, 121.6 s a clip there against the Fast setting's 99.4 s. A real 8 GB card is slower." },
  }),
  refs: Object.freeze({
    full: {
      at16: { measured: false, evidence: "The lab did not run the reference path at 1344x768: this size is "
        + "predicted from the Fast setting's measurement. One reference picture added about 240 MiB at 960x544." },
      below16: { measured: false, evidence: "The lab did not run the reference path at 1344x768 or under a 12 GB "
        + "cap: this size is PREDICTED from the Fast setting's measurement, and tight, since one reference "
        + "picture added about 240 MiB at 960x544." },
    },
    small: { measured: true, evidence: "Measured for the reference path (8 steps, one reference picture) under an "
      + "8 GB cap on a 16 GB card: 960x544 for 5 s fit with only 314 MiB to spare, 137.8 s a clip there. Several "
      + "pictures were never capped. A real 8 GB card is slower." },
  }),
});

/** No card reading: no size is chosen, and every tier is listed instead. */
export const H3_UNKNOWN = Object.freeze({
  id: "unknown", minGb: null, label: "Card not read",
  plain: "The card could not be read, so no size is chosen for it",
  width: null, height: null, maxSeconds: null, measured: false, experimental: false,
  evidence: (() => {
    const [full, small, preview] = ["full", "small", "preview"].map(tierById);
    return "The card's memory could not be read, so no size is chosen for it: H3 needs "
      + `${full.minGb} GB for full size, ${small.minGb} GB for ${small.width}x${small.height} and `
      + `${preview.minGb} GB for an experimental ${preview.width}x${preview.height} preview.`;
  })(),
});
/** The smallest card H3 is offered on at all: the experimental preview's floor. */
export const H3_VRAM_OFFERED_GB = tierById("preview").minGb;
/** The smallest card a MEASURED tier covers. The rows print it as the minimum;
 *  the 6 GB preview is described in the row's note, not advertised as a floor. */
export const H3_VRAM_MIN_GB = tierById("small").minGb;
/** The smallest card that gets full size. */
export const H3_VRAM_FULL_GB = tierById("full").minGb;

/** Card MiB to whole GB, the way server/fit.js rounds (the number on the box). */
export function h3CardGb(vramMb) {
  const mb = Number(vramMb);
  return Number.isFinite(mb) && mb > 0 ? Math.round(mb / 1024) : null;
}

/**
 * The tier for a card, plus the warnings and the recommendation that go with it.
 *   vramMb   the card's total memory in MiB (gpu.js totalMb), or null
 *   ramGb    system RAM in GB (rounded to whole GB here)
 *   vendor   "nvidia" | "amd" | "intel" | null
 *   path     null (H3, TaoMate) | "fasth3" | "refs": whose evidence to quote
 * Returns the tier's own fields (evidence and `measured` for that path) plus
 * cardGb, ramGb, ramWarning, ramBelowFloor, amdNote, offered, recommend and
 * notRecommended (the sentence saying why not, or null).
 */
export function h3TierFor({ vramMb = null, ramGb = null, vendor = null, path = null } = {}) {
  const cardGb = h3CardGb(vramMb);
  const tier = cardGb === null ? H3_UNKNOWN : H3_TIERS.find((t) => cardGb >= t.minGb);
  const ram = Number(ramGb);
  const ramWhole = Number.isFinite(ram) && ram > 0 ? Math.round(ram) : null;
  const ramBelowFloor = ramWhole !== null && ramWhole < H3_RAM_FLOOR_GB;
  const ramShort = ramWhole !== null && ramWhole < H3_RAM_MEASURED_GB;

  let evidence = tier.evidence;
  let measured = tier.measured;
  const alt = H3_PATHS[path]?.[tier.id];
  if (alt) {
    const pick = alt.evidence ? alt : (cardGb >= H3_LAB_CARD_GB ? alt.at16 : alt.below16);
    evidence = pick.evidence;
    measured = pick.measured;
  } else if (tier.caveat && cardGb < H3_LAB_CARD_GB) {
    evidence = `${evidence} ${tier.caveat}`;
  }

  const amd = vendor === "amd";
  const offered = tier.id !== "none" && !ramBelowFloor;
  /* The reasons a machine H3 is offered on is still not recommended it, first
   * one wins. The card tier decides, not the path: every H3-family row gets the
   * same answer on one machine. */
  const notRecommendedFor = !offered ? null
    : tier.experimental ? "preview" : amd ? "amd" : ramShort ? "ram" : null;
  const notRecommended = {
    preview: "Offered, not recommended: the preview has not been seen to fit.",
    amd: "Offered, not recommended: nobody has rendered H3 on an AMD card yet.",
    ram: `Offered, not recommended: under the ${H3_RAM_MEASURED_GB} GB of RAM it was measured with.`,
  }[notRecommendedFor] || null;
  return {
    ...tier,
    evidence,
    measured,
    cardGb,
    ramGb: ramWhole,
    ramWarning: ramShort ? H3_RAM_WARNING : null,
    ramBelowFloor,
    amdNote: amd ? H3_AMD_NOTE : null,
    offered,
    recommend: offered && !notRecommendedFor,
    notRecommendedFor,
    notRecommended,
  };
}

/** A frame count on H3's own grid: rounded UP to 17k + 5, as the engine does. */
export function h3SnapFrames(frames) {
  let n = Math.max(5, Math.round(Number(frames) || 0));
  while (n % 17 !== 5) n += 1;
  return n;
}

/** A side length snapped to the nearest multiple of 32, never below 32. */
export function h3Snap32(px) {
  return Math.max(32, Math.round((Number(px) || 0) / 32) * 32);
}

/**
 * A size and length on H3's grids. Give `frames`, or `seconds` (at 24 fps).
 * Width and height go to multiples of 32; frames go up to 17k + 5 (124, 141,
 * 158, 175, 192, 209, 226, ...), which is what the engine renders anyway.
 */
export function snapH3({ width, height, frames, seconds, fps = H3_FPS } = {}) {
  const f = h3SnapFrames(frames ?? Number(seconds) * fps);
  return { width: h3Snap32(width), height: h3Snap32(height), frames: f, seconds: Math.round((f / fps) * 100) / 100 };
}

/**
 * Video tokens for a size and frame count, counted for what the engine
 * RENDERS: frames go up to the 17k + 5 grid (120 renders as 124) and a side
 * that is not a multiple of 32 is counted up (ceil), so an unsnapped request
 * never reads as cheaper than it is.
 */
export function h3Tokens({ width, height, frames }) {
  const f = h3SnapFrames(frames);
  const lat = 5 * Math.floor((f - 5) / 17) + 2;
  return lat * Math.ceil((Number(width) || 0) / 32) * Math.ceil((Number(height) || 0) / 32);
}

/** The engine's VRAM need in MiB, WITHOUT the margin (H3_FIT.marginMiB). */
export function h3VramNeedMiB({ width, height, frames }) {
  return Math.round(H3_FIT.baseMiB + H3_FIT.perTokenMiB * h3Tokens({ width, height, frames }));
}

/**
 * The need for one size, with the margin beside it and whether the fit covers
 * it. `frames` and `seconds` are what the engine renders (snapped up to the
 * grid), so the estimate describes the clip that comes out, not the request.
 */
export function h3Estimate({ width, height, frames }) {
  const f = h3SnapFrames(frames);
  const tokens = h3Tokens({ width, height, frames: f });
  const needMiB = h3VramNeedMiB({ width, height, frames: f });
  return {
    width, height, frames: f,
    seconds: Math.round((f / H3_FPS) * 100) / 100,
    tokens, needMiB,
    marginMiB: H3_FIT.marginMiB,
    withMarginMiB: needMiB + H3_FIT.marginMiB,
    inFittedRange: tokens >= H3_FIT.fittedTokens[0] && tokens <= H3_FIT.fittedTokens[1],
  };
}

/** The need at a tier's own size for each whole second up to its longest measured clip. */
export function h3TierTable(tier) {
  if (!tier?.width || !tier?.maxSeconds) return [];
  const out = [];
  for (let s = 1; s <= tier.maxSeconds; s++) {
    out.push(h3Estimate({ width: tier.width, height: tier.height, frames: s * H3_FPS }));
  }
  return out;
}

/** One line for a Models row: every tier, from this table. */
export function h3TierSummary() {
  const [full, small, preview] = H3_TIERS;
  return `The size that fits depends on the card; set it on the Video screen: ${full.minGb} GB and up, ${full.width}x${full.height}, `
    + `measured up to ${full.maxSeconds} s; ${small.minGb} to ${full.minGb - 1} GB, `
    + `${small.width}x${small.height} for ${small.maxSeconds} s (measured under a memory cap); `
    + `${preview.minGb} to ${small.minGb - 1} GB, an experimental ${preview.width}x${preview.height} preview `
    + `(not proven, never recommended); under ${preview.minGb} GB, not offered. RAM: only ever measured with `
    + `${H3_RAM_MEASURED_GB} GB, which it filled; under ${H3_RAM_FLOOR_GB} GB it is not offered.`;
}

/**
 * The `requires` block every H3-family row carries: the flag that sends
 * fitFor() here, the path whose evidence the row quotes, and the requirement
 * numbers the row prints, all from above. The printed minimums are the ones
 * fit.js enforces: 8 GB (the smallest measured tier) and 16 GB of RAM (the
 * floor); the recommendation is what the lab measured, 12 GB and 32 GB.
 */
export function h3Requires(note = "", { path = null } = {}) {
  return {
    h3Tiers: true,
    h3Path: path,
    vramMinGb: H3_VRAM_MIN_GB,
    vramRecGb: H3_VRAM_FULL_GB,
    ramMinGb: H3_RAM_FLOOR_GB,
    ramRecGb: H3_RAM_MEASURED_GB,
    note: [h3TierSummary(), note].filter(Boolean).join(" "),
  };
}

/**
 * The block /api/status (config.video.h3) and /api/models (machine.h3) serve,
 * from the same two readings the status bar already takes: gpu.js gpuStatus()
 * and ramStatus(). For the Fast setting's path, the one the Video screen starts on.
 */
export function h3Status({ gpu = null, ram = null } = {}) {
  const vramMb = Number(gpu?.totalMb) > 0 ? Number(gpu.totalMb) : null;
  const ramGb = Number(ram?.totalMb) > 0 ? Number(ram.totalMb) / 1024 : null;
  const t = h3TierFor({ vramMb, ramGb, vendor: gpu?.vendor || null });
  const {
    cardGb, ramGb: ramWhole, ramWarning, ramBelowFloor, amdNote, offered, recommend, notRecommendedFor,
    notRecommended, caveat, ...tier
  } = t;
  return {
    card: vramMb === null ? null : { vramMb, vramGb: cardGb, name: gpu?.name || null, vendor: gpu?.vendor || null },
    ramGb: ramWhole,
    tier,
    offered,
    recommend,
    notRecommendedFor,
    notRecommended,
    ramWarning,
    ramBelowFloor,
    amdNote,
    fit: H3_FIT,
    fps: H3_FPS,
    table: h3TierTable(tier),
    tiers: H3_TIERS.map(({ evidence, caveat, ...rest }) => rest),
  };
}

/**
 * The few fields an agent needs on every studio_status call: which tier, at
 * what size, whether it is recommended, and the warnings. The full block (the
 * need table, the fit's inputs, every tier) stays in /api/status and
 * models_for_this_machine, so a status tool agents call often stays small.
 */
export function h3Brief(h3) {
  if (!h3?.tier) return null;
  const { id, label, width, height, maxSeconds, measured, experimental } = h3.tier;
  return {
    tier: id, label, width, height, maxSeconds, measured, experimental,
    offered: h3.offered ?? null, recommend: h3.recommend ?? null,
    ramWarning: h3.ramWarning ?? null, amdNote: h3.amdNote ?? null,
  };
}
