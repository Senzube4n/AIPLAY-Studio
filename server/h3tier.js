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
 * THE VIDEO SCREEN STARTS AT THE TIER (2026-09-24). Its size chips and its
 * first size come from h3Status() (web/vidfit.js shows them), and /api/video
 * gives a render that names no size the tier's size (h3StartSize). Every other
 * size stays under Advanced. The Workflow screen's scenes render at the
 * project's own size, which a NEW music video starts at from this table too
 * (server/mv/sizes.js sizeChoices, the brief's size control), and a project
 * keeps what it stored. So the sentences below speak of the Video screen only:
 * h3SetSizeByHand (the name kept for its importers), h3TierSummary(), fit.js's
 * FIT_STATES.smaller line, the models_for_this_machine description and Home's
 * first-run video line (server/welcome/firstrun.js, "smaller").
 *
 * h3SizeFit() is the "this size needs about X GB free; you have Y" line the
 * Video screen's Advanced size row and make_clip's check read: the fit above,
 * for whatever size and length is asked, snapped to the grids the engine works
 * on. The page never compares the two numbers itself.
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
/** The pixel grid H3 works on: a side counts in steps of this (w/32 in the token count). */
export const H3_GRID = 32;

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

/**
 * SYSTEM RAM, READ ONCE, THE SAME WAY EVERYWHERE. os.totalmem() and Windows
 * report USABLE memory: a 32 GB laptop whose integrated graphics keeps a
 * slice reads 31.4 GB, a 16 GB one 15.4 GB, an APU that keeps 4 GB reads 28.
 * Rounding (fit.js's rule for VRAM, where the driver keeps a fraction of a GB)
 * turned 31.4 into "31 GB, under the 32 H3 was measured with" on Home while
 * the launcher allowed 4 GB for exactly this and said "ok", and 15.4 into
 * "under the 16 GB floor" while the launcher only said "slow". One reader
 * now: a reading within RAM_RESERVED_GB under a size RAM is sold in counts as
 * that size, for the floor and the recommendation alike, and anything else is
 * rounded. server/fit.js (every row's RAM verdict, Home, Models), the Video
 * and music-video screens (h3Status, server/mv/sizes.js) and the launcher's
 * RAM line (launcher/checks.mjs) all call it. The lab's own machine read
 * 31.9 GB.
 *
 * THE FLOOR TAKES THE SAME ALLOWANCE, ON PURPOSE. A 16 GB box whose
 * integrated graphics keeps up to 4 GB reads as little as 12.1 GB and is
 * judged a 16 GB machine, so H3 is offered there (never recommended: under the
 * 32 GB it was measured with, with the paging warning). The floor is itself a
 * judgement, not a measurement (nothing under 32 GB was tried), and a second,
 * stricter reader would bring back two answers for one machine. A reading of
 * 11.9 GB is a 12 GB box: under the floor. h3tier_test.js pins both.
 */
export const RAM_RESERVED_GB = 4;
const RAM_SIZES_GB = Object.freeze([2, 4, 6, 8, 12, 16, 20, 24, 32, 36, 40, 48, 64, 96, 128, 192, 256, 384, 512]);

/** System RAM in MiB (ramStatus().totalMb) to the whole GB Studio judges it as. Null when unread. */
export function ramBoxGb(totalMb) {
  const mb = Number(totalMb);
  if (!Number.isFinite(mb) || mb <= 0) return null;
  const gb = mb / 1024;
  /* Strictly under the allowance, so a value this returns reads back as itself. */
  const size = RAM_SIZES_GB.find((s) => s >= gb - 1e-9);
  return size !== undefined && size - gb < RAM_RESERVED_GB ? size : Math.round(gb);
}

/** "an 8 GB", "a 12 GB": a GB figure with the article it takes read aloud. */
export function gbWithArticle(n) {
  return `${/^(8|11|18|8\d)(\D|$)/.test(String(n)) ? "an" : "a"} ${n} GB`;
}

/** The rail's name for the music-video screen: the one copy. server/collab/
 *  lending.js (WORKFLOW_SCREEN) and server/cloud-switch.js read it from here,
 *  and lending_test.js pins it to the rail's own label. */
export const H3_MV_SCREEN = "Music video";

/** Lending is built and has passed its tests on one machine; a render between
 *  two PCs has not been tried. Every surface that offers it says so, in these
 *  words: Home, Explore, the Video and music-video screens, the Models notes
 *  and H3 rows, Settings and the launcher. Kept here because this file imports
 *  nothing and its friend sentence below needs it; server/cloud-switch.js
 *  re-exports it for everything else. */
export const LENDING_UNTRIED = "built, not yet tried between two PCs";

/* What someone under the floor can do instead: a friend's card first, never a
 * paid route by default (the owner's rule, 2026-09-24). */
export const H3_ASK_A_FRIEND = `Ask a friend with a bigger machine to render it (Collab, free; ${LENDING_UNTRIED}): `
  + `Ask friend on the Video screen, or on a scene in ${H3_MV_SCREEN}, prepares the recipe for their card.`;

/**
 * THE VIDEO VAE THE LAB HAD IS NOT THE ONE A NEW INSTALL GETS. Every measured
 * figure below was taken with the rig's own 3.17 GB int8 video VAE (config.js
 * loads it first when it is there). The Models screen downloads the 5.2 GB
 * fp16 one: the int8 file Comfy-Org published is 2.81 GB, is not the file
 * the rig measured, and was never rendered here (server/models.js, the H3
 * row's variants). Decoding is part of the peak and the VAE is not shrunk by
 * headroom, so the measured sizes carry this sentence until the fp16 VAE is
 * measured at them, on every PC that does not load the measured file.
 * H3_VAE_MEASURED names that file by name and size; index.js asks whether the
 * VAE config.js loads is it (the name alone is not enough: Comfy-Org's int8
 * has the same name) and passes `vaeMeasured` in, so this file stays pure.
 * The sentence is for the screens, so it says "video decoder", not VAE.
 */
export const H3_VAE_MEASURED = Object.freeze({ file: "minimax_h3_video_vae_int8_convrot.safetensors", bytes: 3_171_670_912 });
export const H3_VAE_CAVEAT = "A new install downloads a larger video decoder than the one these sizes were "
  + "measured with, so a card near the edge may need a shorter clip.";

/**
 * THE LAB'S OTHER TWO VERDICTS, one copy each: config.js (h3.solAttn,
 * fasth3.advanced), the Video screen's tooltips, the Video Lab's row and
 * make_clip's descriptions all read these, so no second copy of a number or a
 * sentence can drift from the lab (mcp.js imports this file and not config.js).
 *
 * Sol-attn (arm A3 against A: 1344x768, 8 s, one 16 GB card, TaoMate 3-step,
 * text to video): ComfyUI 0.36's own BlockSparseAttention after the sigma
 * shift, tau 1.3, dense for the first 20% of the schedule, only above 12,288
 * video tokens. Step 1 stays dense, steps 2 and 3 run 1.54x faster, so the
 * sampler is 1.26x and the whole clip 1.15x faster, for a slightly softer,
 * paler picture. NOT tried: other sizes (960x544 included), the rank-19
 * TaoMate file, the 4- and 8-step builds, the reference path, continuations
 * and video-to-video. The graph gives it to the Fast setting's plain path only
 * (workflow.js h3SparseFor); the size and the file are said, not refused.
 */
export const H3_SOL_ATTN = (() => {
  const r = { method: "sol-attn", tau: 1.3, startPercent: 0.2, endPercent: 1,
    minTokens: 12288, extraTokens: 256, sinkConditioning: "exact_kv_and_rows" };
  /* What it was measured at: a render at another size is said to be untried. */
  const at = { width: 1344, height: 768, seconds: 8 };
  const gain = "about 1.15x faster per clip, slightly softer picture";
  return Object.freeze({
    ...r,
    measuredAt: Object.freeze(at),
    gain,
    note: `Sol-attn sparse attention on the Fast setting: ${gain}; measured on a ${H3_LAB_CARD_GB} GB card at `
      + `${at.width}x${at.height} for ${at.seconds} s, not yet tried at other sizes or with the 0.18 GB TaoMate `
      + "file. Standard, Best, references, continuations and video-to-video always run dense attention.",
    /* The recipe in words, for the Video Lab's row, from the numbers above. */
    recipe: `ComfyUI's own BlockSparseAttention in ${r.method} mode, after the sigma shift: tau ${r.tau}, dense for `
      + `the first ${Math.round(r.startPercent * 100)}% of the schedule, only above ${r.minTokens.toLocaleString("en-US")} `
      + `video tokens. The H3 lab (2026-09-24) measured the sampler 1.26x and the whole clip 1.15x faster at `
      + `${at.width}x${at.height}, ${at.seconds} s (22.5 s saved on a 172 s clip).`,
  });
})();

/**
 * MINIMAX H3 BLOCK CACHE (T8), an experimental custom node
 * (github.com/T8mars/comfyui-minimax-h3-blockcache-T8, Apache-2.0, class
 * MiniMaxH3BlockCacheT8). It recomputes H3's first block every step and skips
 * the rest when both the audio and the video residual barely moved, reusing
 * the cached result. Its author measured 1.09x to 1.20x on 20 steps at 256x160
 * on an RTX 4060 Ti; nothing is measured on the 3 to 8 step builds or on AMD.
 * The recipe is the node's own defaults. It refuses to run beside
 * BlockSparseAttention, so workflow.js never puts both in one graph.
 */
export const H3_BLOCK_CACHE = Object.freeze({
  node: "MiniMaxH3BlockCacheT8",
  threshold: 0.12, startPercent: 0.08, endPercent: 0.95, maxConsecutiveHits: 2,
  cacheDevice: "cpu", metricStride: 8,
  repo: "https://github.com/T8mars/comfyui-minimax-h3-blockcache-T8",
});

/** FastH3's label and caveat wherever it is offered. The name is older than
 *  the wording: it was an Advanced "More motion" switch until 2026-09-25.
 *  FastH3 is a model of its own (FastVideo's 8-step distillation of H3), and
 *  it is not a motion setting. So it is a choice in the engine list, named
 *  as the model, with the measured caveat. */
export const H3_MORE_MOTION = Object.freeze({
  label: "FastH3 (experimental)",
  note: "A distilled H3 model, 8 steps. About 1.4x the wait of Fast. Can change the subject's colour or add a white blob; "
    + "check the take.",
  /* The lab ran FastH3 on text prompts only. Frames are accepted and said. */
  framesUntried: "FastH3 was only tried on text to video: an opening or closing picture is accepted, but not "
    + "yet tried with it, so check the take.",
});

/** Where a tier's size is set: the Video screen starts at it (see the header).
 *  The name is older than the wiring and kept for its importers. */
export function h3SetSizeByHand(tier) {
  return `The Video screen starts H3 clips at ${tier.width}x${tier.height}, ${tier.maxSeconds} s or under, `
    + "on this card; every other size stays under Advanced.";
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
    /* The Video screen's chip for this tier (web/vidfit.js shows it as sent). */
    chip: "Full · 1344x768",
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
    chip: "Smaller card · 960x544, 5 s",
    width: 960, height: 544, maxSeconds: 5, measured: true, experimental: false,
    evidence: "Measured with the Fast setting (TaoMate 3-step) under an 8 GB cap on a 16 GB card: 960x544 "
      + "for 5 s fit, about 100 s a clip there, and 1344x768 for 8 s did not. The 8-step Standard setting "
      + "was not timed at this size. A real 8 GB card is a slower GPU, so expect longer.",
  }),
  Object.freeze({
    id: "preview", minGb: 6, label: "Preview",
    plain: "Preview only: 832x480, 5 s (experimental, not proven)",
    chip: "Preview · 832x480, experimental",
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
 * Fast setting's evidence ("none" does not depend on the path; the reference
 * path's preview says it was not run there, and what a picture adds).
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
      + "8 GB cap on a 16 GB card: 960x544 for 5 s fit with only 314 MiB to spare, 137.8 s a clip there. "
      + "A real 8 GB card is slower." },
    /* Not run at the preview size at all: the Fast setting's text-only run is
     * the only evidence there, and the reference picture costs on top of it. */
    preview: { measured: false, evidence: "Experimental, not proven: the reference path was not run at 832x480, and "
      + "one reference picture added about 240 MiB at 960x544. Text to video alone went over a 6 GB cap by 631 MiB "
      + "at this size with a 2.6 GB desktop counted. Close GPU-heavy apps or plug the monitor into the integrated "
      + "graphics." },
  }),
});

/** No graphics card at all: Studio's engine runs PyTorch on the CPU (the
 *  launcher's "CPU only" install, settings.json torchBackend "cpu"). Not
 *  offered, the same as a card under the preview floor. An AMD or Intel card
 *  whose memory was not read stays H3_UNKNOWN ("cannot tell"). */
export const H3_NO_CARD = Object.freeze({
  id: "none", minGb: null, label: "Not offered",
  plain: "H3 is not offered without a graphics card",
  width: null, height: null, maxSeconds: 0, measured: false, experimental: false, noCard: true,
  evidence: `This PC's engine runs on the CPU: there is no graphics card for H3 to render on. ${H3_ASK_A_FRIEND}`,
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
 *   ramMb    system RAM in MiB (ramStatus().totalMb), judged by ramBoxGb
 *   ramGb    or system RAM in GB, judged the same way (ramBoxGb(ramGb * 1024))
 *   vendor   "nvidia" | "amd" | "intel" | null
 *   path     null (H3, TaoMate) | "fasth3" | "refs": whose evidence to quote
 *   cpuOnly  no card was read AND the engine runs on the CPU: not offered
 *   vaeMeasured  this PC loads the video decoder the lab measured with
 *            (H3_VAE_MEASURED): the measured sentences drop H3_VAE_CAVEAT
 * Returns the tier's own fields (evidence and `measured` for that path) plus
 * cardGb, ramGb, ramWarning, ramBelowFloor, amdNote, offered, recommend and
 * notRecommended (the sentence saying why not, or null).
 */
export function h3TierFor({ vramMb = null, ramMb = null, ramGb = null, vendor = null, path = null, cpuOnly = false, vaeMeasured = false } = {}) {
  const cardGb = h3CardGb(vramMb);
  const tier = cardGb === null ? (cpuOnly ? H3_NO_CARD : H3_UNKNOWN) : H3_TIERS.find((t) => cardGb >= t.minGb);
  const ramWhole = ramMb !== null && ramMb !== undefined ? ramBoxGb(ramMb)
    : Number(ramGb) > 0 ? ramBoxGb(Number(ramGb) * 1024) : null;
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
  /* A figure the lab measured was measured with its int8 video VAE: said
   * wherever this PC does not load that file. */
  if (measured && !vaeMeasured) evidence = `${evidence} ${H3_VAE_CAVEAT}`;

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
  return `The size that fits depends on the card, and the Video screen starts at it: ${full.minGb} GB and up, ${full.width}x${full.height}, `
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
 * WHAT THIS SIZE NEEDS, AND WHAT THE CARD HAS. The Video screen's Advanced line
 * ("this size needs about X GB free; you have Y") and make_clip's check, for
 * any size and length: snapped to the grids the engine works on (sides to 32,
 * frames up to 17k + 5), then the fit above plus its margin. `over` is the
 * judgement, made here so no page compares the two numbers itself. `vramMb`
 * is the card's total (gpu.js totalMb): the desktop's share is not known, so
 * the sentence says the desktop uses some of it rather than subtracting a guess.
 */
export function h3SizeFit({ width, height, seconds, frames } = {}, { vramMb = null } = {}) {
  const w = Number(width), h = Number(height);
  if (!(w > 0 && h > 0) || (frames == null && !(Number(seconds) > 0))) return null;
  /* Counted the way h3Tokens counts an unsnapped size: each side UP to the
   * 32-pixel grid, so a request never reads as cheaper than it is. */
  const up32 = (px) => Math.max(32, Math.ceil(px / 32) * 32);
  const s = { ...snapH3({ width: w, height: h, frames, seconds }), width: up32(w), height: up32(h) };
  const e = h3Estimate({ width: s.width, height: s.height, frames: s.frames });
  const gb = (mib) => Math.round((mib / 1024) * 10) / 10;
  const cardMb = Number(vramMb) > 0 ? Number(vramMb) : null;
  const over = cardMb !== null && e.withMarginMiB > cardMb;
  const snapped = s.width !== w || s.height !== h;
  const sentence = `This size needs about ${gb(e.withMarginMiB)} GB free on the graphics card`
    + (cardMb !== null ? `; you have ${h3CardGb(cardMb)} GB, and the desktop uses some of it.` : "; the card could not be read.")
    + (over ? " It will not fit here: pick a smaller size or a shorter clip." : "")
    + (snapped ? ` Counted as ${s.width}x${s.height}, on H3's 32-pixel grid.` : "")
    + (e.inFittedRange ? "" : " This size is outside the sizes the fit was measured on, so the figure is a guess.");
  return {
    width: s.width, height: s.height, frames: s.frames, seconds: s.seconds, snapped,
    tokens: e.tokens, needMiB: e.needMiB, withMarginMiB: e.withMarginMiB,
    needGb: gb(e.withMarginMiB), haveGb: cardMb !== null ? h3CardGb(cardMb) : null,
    over, inFittedRange: e.inFittedRange, sentence,
    scope: `The lab's fit over ${H3_FIT.runs} capped runs of the Fast setting, each within ${H3_FIT.maxErrorMiB} MiB, `
      + `plus about ${H3_FIT.marginMiB} MiB of margin; measured on a ${H3_LAB_CARD_GB} GB card.`,
  };
}

/**
 * What a size chip says when it shortens the clip: the tier's length is the
 * longest MEASURED (or, for the preview, offered) there, so a chip that cuts
 * a longer length says so rather than moving the slider in silence.
 */
export function h3LengthLine(t) {
  if (!t?.width || !t?.maxSeconds) return null;
  return t.measured
    ? `The length went down to ${t.maxSeconds} s, the longest measured to fit at ${t.width}x${t.height} on `
      + `${gbWithArticle(t.minGb)} card; a longer clip is untested there, not forbidden.`
    : `The length went down to ${t.maxSeconds} s, the length the experimental ${t.width}x${t.height} preview `
      + "is offered at; it has not been seen to fit yet.";
}

/**
 * The size a render that names none starts at on this card: a SMALLER card's
 * tier size and longest measured length. Null where the engine's own size
 * stands: a full-size card (its default is the person's; the Video Lab sets
 * it), an unread card (no size is chosen), or H3 not offered. The page only
 * applies what it is sent. The Video screen opens on it and /api/video gives
 * it to a render that names no size, and both say so, in words that follow
 * `measured` (the preview has not been seen to fit).
 */
export function h3StartSize(h3) {
  const t = h3?.tier;
  if (!t?.width || !t?.height || !h3?.offered || t.id === "full") return null;
  return { tier: t.id, width: t.width, height: t.height, maxSeconds: t.maxSeconds, chip: t.chip || t.label,
    measured: !!t.measured, lengthSaid: h3LengthLine(t) };
}

/**
 * The block /api/status (config.video.h3) and /api/models (machine.h3) serve,
 * from the same two readings the status bar already takes: gpu.js gpuStatus()
 * and ramStatus(). For the Fast setting's path, the one the Video screen starts on.
 */
export function h3Status({ gpu = null, ram = null, cpuOnly = false, vaeMeasured = false } = {}) {
  const vramMb = Number(gpu?.totalMb) > 0 ? Number(gpu.totalMb) : null;
  const ramMb = Number(ram?.totalMb) > 0 ? Number(ram.totalMb) : null;
  const t = h3TierFor({ vramMb, ramMb, vendor: gpu?.vendor || null, cpuOnly: vramMb === null && !!cpuOnly, vaeMeasured: !!vaeMeasured });
  const {
    cardGb, ramGb: ramWhole, ramWarning, ramBelowFloor, amdNote, offered, recommend, notRecommendedFor,
    notRecommended, caveat, ...tier
  } = t;
  return {
    card: vramMb === null ? null : { vramMb, vramGb: cardGb, name: gpu?.name || null, vendor: gpu?.vendor || null },
    /* No card at all (the engine runs on the CPU): not offered, said as such. */
    noCard: !!tier.noCard,
    /* This PC loads the video decoder the lab measured with (H3_VAE_MEASURED):
     * fit.js's H3 rows read it back, so their sentences match this block's. */
    vaeMeasured: !!vaeMeasured,
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
    /* The Video screen's custom size boxes step on it. */
    grid: H3_GRID,
    table: h3TierTable(tier),
    tiers: H3_TIERS.map(({ evidence, caveat, ...rest }) => rest),
    /* The Video screen's size chips: this card's tier and the smaller ones, the
     * first of them the start size. An unread card gets every tier and no
     * start; a card H3 is not offered on gets none. */
    /* `title` is the chip's tooltip (the tier's plain line, which names the
     * length); `lengthSaid` is what the page shows when the chip shortened
     * the clip. */
    choices: (vramMb === null && !tier.noCard ? H3_TIERS.filter((x) => x.id !== "none")
      : offered ? H3_TIERS.filter((x) => x.id !== "none" && x.minGb <= tier.minGb) : [])
      .map((x) => ({ id: x.id, chip: x.chip || x.label, width: x.width, height: x.height, maxSeconds: x.maxSeconds,
        experimental: x.experimental, measured: x.measured, title: x.plain, lengthSaid: h3LengthLine(x) })),
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
