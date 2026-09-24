/**
 * WILL IT RUN ON MY MACHINE — and if not all of it, WHICH parts.
 *
 * The Models screen has always listed seventeen capabilities, every one of them
 * carrying `requires: {vramMinGb, vramRecGb, ramMinGb, ramRecGb}`, and every one
 * of them leaving the arithmetic to the reader. That is the gap this file
 * closes. A stranger opening that screen sees seventeen rows, one of them 43 GB,
 * and no sentence anywhere saying "for your card, these three". The numbers to
 * say it with were already on disk — nothing here measures anything new. It
 * divides.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NOTHING IN THIS FILE IS TYPED TWICE.
 *
 * Every requirement comes from `requires` in server/models.js. Every licence
 * verdict comes from that entry's `outputRights.class`. Which capability is a
 * video engine comes from `config.video.engines` crossed with
 * MODEL_TO_CAPABILITY — not from a list here, because a third engine added to
 * config.js must appear in the recommendation on the same commit or the
 * recommendation is lying by omission. Which capability is an image engine
 * comes from models.js's isPictureModel() — a POSITIVE rule, reading a field
 * the row carries. It used to be the same map minus video minus the required
 * music engine, and that subtraction called a video ControlNet a picture model
 * the day one was catalogued; see the note over isPictureModel().
 * ══════════════════════════════════════════════════════════════════════════
 *
 * WHY IT IS A SEPARATE MODULE FROM THE ROUTE. The route needs a live machine
 * (nvidia-smi, os.totalmem). This needs a machine-shaped OBJECT. Keeping the
 * arithmetic pure is what makes fit_test.js able to ask "what does Studio say to
 * somebody on an 8 GB card" without owning an 8 GB card — which is the only way
 * that answer ever gets checked, since the rig this is written on is not the rig
 * that struggles.
 */
import path from "node:path";
import { CATALOG, MODEL_TO_CAPABILITY, isPictureModel, rightsRank } from "./models.js";
import { config, prefChosen, prefOrigin } from "./config.js";
import { SETTING_WORDS } from "./lrc.js";
import {
  h3TierFor, h3Status, h3SetSizeByHand, H3_VRAM_OFFERED_GB, H3_VRAM_MIN_GB, H3_VRAM_FULL_GB, H3_RAM_MEASURED_GB,
  H3_RAM_FLOOR_GB, H3_ASK_A_FRIEND, ramBoxGb,
} from "./h3tier.js";
import { musicDefault, yue2ComfyFit } from "./music-default.js";
import { NO_STRONG_CARD, NO_STRONG_CARD_VIDEO_LINE } from "./cloud-switch.js";

/* ── the five answers ──────────────────────────────────────────────────────
 *
 * Deliberately more than two. "Runs" and "does not run" is the split people
 * expect, and it is wrong on this engine: every `--lowvram` tier works by
 * keeping less of the model resident and STREAMING the rest from system RAM,
 * so between comfortable and impossible there is a wide band where the thing
 * genuinely works and is genuinely slower. Collapsing that band into "no"
 * would refuse work most of these cards can do; collapsing it into "yes" is
 * how somebody ends up watching a progress bar for thirteen minutes with no
 * idea that is not normal (which is measured, on Z-Image, in models.js).
 *
 * `smaller` is the H3 family's (server/h3tier.js): a card under full size gets
 * a smaller picture and a shorter clip instead of the same clip slowly.
 * `unknown` is not a euphemism for no.
 *
 * `rank` is served with the rest (/api/models `fitStates`), so the page sorts
 * by the server's order instead of keeping a copy of it: least restrictive
 * first, and the recommendation ranks with the same numbers (FIT_RANK). */
export const FIT_STATES = {
  "fits": {
    tone: "ok",
    chip: "Fits your machine",
    /* "the recommendation", not "the publisher's": H3's is what Studio's own
     * lab measured (12 GB card, 32 GB of RAM), and no publisher wrote it. */
    line: "At or above the recommendation the row states, on both the card and system RAM.",
    rank: 0,
  },
  "streams": {
    tone: "warn",
    chip: "Runs, slower",
    line: "Above the minimum but under the recommendation. It runs by streaming weights "
        + "from system RAM instead of holding them on the card — that works, and it costs time.",
    rank: 1,
  },
  /* H3 ONLY, for now (server/h3tier.js). A card under what full size needs does
   * not have to stream the same clip slowly: H3's memory follows picture size
   * times clip length, so a smaller card gets a smaller clip that fits. That is
   * neither "Runs, slower" nor "Below the minimum", and calling it either told
   * an 8 GB owner something the lab measured to be false. Only MEASURED sizes
   * get this chip; the unproven 6 GB preview is `unknown`. */
  "smaller": {
    tone: "warn",
    chip: "Runs at a smaller size",
    line: "The card is under what full size needs; a smaller picture and a shorter clip were "
        + "measured to fit a card this size. The row names the size, and the Video screen starts "
        + "there.",
    rank: 2,
  },
  "unknown": {
    tone: "unknown",
    chip: "Cannot tell",
    line: "Nothing is claimed either way: the card could not be read, or nobody has run this on a "
        + "card like it yet. The row says which.",
    rank: 3,
  },
  "wont-run": {
    tone: "bad",
    chip: "Below the minimum",
    line: "Under the stated floor. Studio will still download it if you ask; "
        + "it is likely to fail at load or crawl.",
    rank: 4,
  },
};

/**
 * MiB to GB, rounded — and this rounding is load-bearing, not cosmetic.
 *
 * nvidia-smi reports USABLE memory, which is under the number on the box: a
 * 16 GB RTX 4070 Ti SUPER reads 16376 MiB = 15.99 GB, a 12 GB card reads
 * 12282 MiB = 11.99 GB. Every `vramMinGb` in the catalogue is written against
 * the number on the box, because that is the number the publishers write. So a
 * raw `>=` comparison tells the owner of a 16 GB card that MiniMax H3 (minimum
 * 16) is below their minimum, by 0.01 GB, and does it on every card ever made.
 * That was the first thing this function got wrong, and it would have been
 * invisible: the answer is plausible, just always one tier too pessimistic.
 *
 * Rounding to the nearest whole GB is right for the shape of the error — driver
 * reservation is a fraction of a GB, never half of one.
 */
function gb(mb) {
  return Math.round((mb || 0) / 1024);
}

/** The same value, kept honest for display where a decimal is more truthful. */
function exactGb(mb) {
  return Math.round(((mb || 0) / 1024) * 10) / 10;
}

/**
 * The machine, from the two readings the status endpoint already takes.
 *
 * `gpu` is gpuStatus() — null on a machine with no NVIDIA card, which is not an
 * error and not a small population: an Apple laptop, an AMD card and an Intel
 * integrated chip all land here. `ram` is ramStatus(), which never fails.
 *
 * TOTAL VRAM, NOT FREE, decides fit. gpu.js says why in its own header: `used`
 * is what the driver has handed out, and PyTorch's caching allocator keeps
 * blocks it has finished with, so free VRAM reads far lower than it is. A fit
 * computed from it would tell a user their own card cannot run the model that
 * is running on it. Free memory is still reported here — it is the right number
 * for "close Chrome first", just not for "can this machine do it at all".
 */
export function readMachine(gpu, ram, { cpuOnly = false, vaeMeasured = false } = {}) {
  const haveGpu = !!(gpu && gpu.totalMb);
  return {
    gpu: haveGpu
      ? {
          name: gpu.name,
          vramGb: gb(gpu.totalMb),
          vramExactGb: exactGb(gpu.totalMb),
          vramMb: Number(gpu.totalMb),   // the raw reading, for h3tier.js, which rounds it the same way
          usedGb: Number.isFinite(gpu.usedMb) ? exactGb(gpu.usedMb) : null,   // null: not readable, never "0 used"
          /* Carried because a recommendation that ignores it recommends an
           * engine that is broken on the card in front of it — see
           * AMD_MUSIC_WARNING below. gpu.js reads it from nvidia-smi or, on
           * AMD/Intel, from the display-adapter registry. */
          vendor: gpu.vendor || null,
          note: gpu.note || null,
        }
      : null,
    ram: {
      /* SYSTEM RAM IS NOT ROUNDED LIKE VRAM: Windows keeps up to a few GB of
       * it for hardware and integrated graphics, so a 32 GB laptop reads 31.4.
       * h3tier.js ramBoxGb is the one reader (the launcher's RAM line, the
       * Video and music-video screens and every row here). */
      totalGb: ramBoxGb(ram?.totalMb) ?? 0,
      totalExactGb: exactGb(ram?.totalMb),
      freeGb: exactGb((ram?.totalMb || 0) - (ram?.usedMb || 0)),
      note: ram?.note || null,
    },
    /* Said out loud rather than left as a null. "Cannot tell" with no reason
     * reads like a bug in Studio; naming the tool that was run and the cards it
     * covers turns it into a fact about the machine. */
    reading: haveGpu ? (gpu.source || "nvidia-smi") : "none",
    readingNote: haveGpu
      ? `Read from ${gpu.source || "nvidia-smi"}: ${gpu.name}, ${exactGb(gpu.totalMb)} GB.`
      : "Studio reads graphics memory by running `nvidia-smi`, which only exists for NVIDIA cards. "
        + "It returned nothing here — so this is an AMD, Intel or Apple machine, or the driver is not "
        + "installed. Every VRAM answer below is therefore 'cannot tell' rather than 'no'. ComfyUI "
        + "itself may still run: check what your card is and compare it against the numbers each row states.",
    /* WHAT H3 DOES ON THIS MACHINE: its tier, the need table for the tier's
     * size and the RAM warning, from the same reading as everything above
     * (server/h3tier.js). The Models screen and models_for_this_machine both
     * carry `machine`, so neither has to work a tier out for itself. */
    h3: h3Status({ gpu: haveGpu ? gpu : null, ram, cpuOnly: !haveGpu && !!cpuOnly, vaeMeasured: !!vaeMeasured }),
  };
}

/**
 * H3 AND THE ROWS THAT ONLY RUN WITH IT (TaoMate, the reference build, FastH3).
 *
 * Their rows carry `requires.h3Tiers`, and the verdict is the card's TIER from
 * server/h3tier.js rather than a floor: H3's memory follows picture size times
 * clip length, so an 8 GB card does not "fail at load or crawl", it renders
 * 960x544 for 5 s (measured under a cap). Every H3-family row gets the same
 * answer on one machine, because the tier belongs to the card, not the row:
 * a TaoMate row that disagreed with the model it loads into was the defect.
 *
 * RAM: A FLOOR AT 16 GB, A WARNING UNDER 32. H3 was only ever measured with
 * 32 GB of RAM, and filled it; nobody has run it with less. Under 16 GB it is
 * not offered (the row prints 16 as its minimum, so the printed number is the
 * enforced one). From 16 to 31 GB the verdict carries the lab's sentence, a
 * full-size card is "Runs, slower" instead of "Fits", and it is offered but
 * not recommended.
 *
 * OFFERED IS NOT RECOMMENDED. `recommendable: false` keeps a row out of
 * recommendFor's picks while its chip still says what the card would get:
 * the unproven 6 GB preview, an AMD card (no H3 render tested) and a machine
 * under 32 GB of RAM (h3tier.js decides, `notRecommended` says why). The
 * preview and AMD are "Cannot tell", never a chip that says it runs.
 *
 * `short` is the badge's tail when the generic one would mislead (it would
 * quote a recommendation where the answer is a size); `warning` is the RAM
 * and AMD sentences, which the Models screen shows under the badge. `why`
 * quotes the row's own path's evidence (FastH3 and the reference path were
 * not measured where the Fast setting was), so those rows may differ in
 * words while every H3-family row gets the same state.
 */
function h3Fit(req, machine) {
  const g = machine.gpu;
  const t = h3TierFor({
    vramMb: g ? (g.vramMb ?? g.vramGb * 1024) : null,
    ramGb: machine.ram.totalGb,
    vendor: g?.vendor || null,
    path: req.h3Path || null,
    cpuOnly: !g && !!machine.h3?.noCard,
    vaeMeasured: !!machine.h3?.vaeMeasured,
  });
  const warning = [t.ramWarning, t.amdNote].filter(Boolean).join(" ") || null;
  const common = {
    needVramGb: Number(req.vramMinGb ?? 0), recVramGb: Number(req.vramRecGb ?? 0),
    needRamGb: Number(req.ramMinGb ?? 0), recRamGb: Number(req.ramRecGb ?? 0),
    yourVramGb: g ? g.vramGb : null,
    yourRamGb: machine.ram.totalGb,
    note: req.note || null,
    h3: {
      tier: t.id, label: t.label, width: t.width, height: t.height,
      maxSeconds: t.maxSeconds, measured: t.measured, experimental: t.experimental,
      recommend: t.recommend,
    },
    warning,
    short: null,
    recommendable: t.recommend,
  };
  /* The sentence, why it is not recommended, then the warnings — the AMD note
   * only where the AMD sentence has not already said it in other words. */
  const tailOf = (s) => [s, t.notRecommended, t.ramWarning, t.notRecommendedFor === "amd" ? null : t.amdNote]
    .filter(Boolean).join(" ");
  const ramShort = t.ramWarning ? ` · ${machine.ram.totalGb} GB RAM, measured with ${H3_RAM_MEASURED_GB}` : "";
  const size = `${t.width}x${t.height}`;

  /* Decided first, and without the card: RAM this far under what H3 filled is
   * not offered whatever the card is. Not a warning: the refusal is the message. */
  if (t.ramBelowFloor) {
    return {
      ...common, state: "wont-run", warning: null, recommendable: false,
      why: `This machine has ${machine.ram.totalGb} GB of RAM. H3 is offered from ${H3_RAM_FLOOR_GB} GB: it was only `
        + `ever measured with ${H3_RAM_MEASURED_GB} GB, and filled it, and nothing with less was tried. `
        + H3_ASK_A_FRIEND,
    };
  }
  /* No card at all (the engine runs on the CPU): not offered, not "cannot tell". */
  if (!g && t.noCard) {
    return { ...common, state: "wont-run", warning: null, recommendable: false, short: "no graphics card", why: t.evidence };
  }
  if (!g) {
    return {
      ...common, state: "unknown",
      why: tailOf(`${t.evidence} This machine has ${machine.ram.totalGb} GB of RAM.`),
    };
  }
  if (t.id === "none") {
    /* Not offered, so no RAM or AMD caveat: they qualify a render that will not happen. */
    return {
      ...common, state: "wont-run", warning: null, recommendable: false,
      /* The printed minimum (the smallest measured size) and the preview floor, both. */
      short: `needs ${H3_VRAM_MIN_GB} GB of VRAM (${H3_VRAM_OFFERED_GB} for an experimental preview), you have ${t.cardGb}`,
      why: `Your ${g.name} has ${t.cardGb} GB, under the ${H3_VRAM_OFFERED_GB} GB H3 needs even for a preview. `
        + t.evidence,
    };
  }
  /* The tier's size for this card, as the sentence says it. */
  const sizeLine = t.id === "full"
    ? `full size, ${size}, measured up to ${t.maxSeconds} s`
    : `${size} for ${t.maxSeconds} s${t.experimental ? ", as an experimental preview" : ""}`;
  if (t.amdNote) {
    return {
      ...common, state: "unknown",
      short: `${size}${t.experimental ? ", experimental" : ""} · no AMD render tested`,
      why: tailOf(`Your ${g.name} has ${t.cardGb} GB: on an NVIDIA card that size gets H3 at ${sizeLine}. `
        + `Studio cannot tell what an AMD card does with it. ${t.evidence}`),
    };
  }
  if (t.experimental) {
    return {
      ...common, state: "unknown",
      short: `${size}, ${t.maxSeconds} s · experimental preview, not proven${ramShort}`,
      why: tailOf(`Your ${g.name} has ${t.cardGb} GB: H3 is offered here only as an experimental preview, `
        + `${size} for ${t.maxSeconds} s. ${t.evidence} ${h3SetSizeByHand(t)}`),
    };
  }
  if (t.id === "full") {
    const why = tailOf(`Your ${g.name} (${t.cardGb} GB) renders H3 at ${sizeLine}. ${t.evidence}`);
    return t.ramWarning
      ? { ...common, state: "streams", short: `${size}${ramShort}`, why }
      : { ...common, state: "fits", why };
  }
  return {
    ...common, state: "smaller",
    short: `${size}, ${t.maxSeconds} s${ramShort}`,
    why: tailOf(`Your ${g.name} has ${t.cardGb} GB: H3 fits here at a smaller size, ${sizeLine}; full size `
      + `needs ${H3_VRAM_FULL_GB} GB. ${t.evidence} ${h3SetSizeByHand(t)}`),
  };
}

/**
 * One capability against one machine.
 *
 * RAM IS JUDGED THE SAME WAY AS VRAM, not as a footnote to it, and that is the
 * whole reason ramStatus() exists beside gpuStatus(). On the low-VRAM tiers the
 * two are coupled: the card being small is what pushes weights into system RAM,
 * so a machine short of RAM is slow for a completely different reason than one
 * short of VRAM, and a single VRAM verdict cannot tell those apart. Z-Image
 * measured this at its most extreme — the same 25-step picture took 41 s with
 * 16 GB of RAM free and was still going after 13 minutes with 3.8 GB free.
 */
export function fitFor(requires, machine) {
  const req = requires || {};
  if (req.h3Tiers) return h3Fit(req, machine);
  if (req.experimental) return {state:"unknown",why:"Experimental native build: a minimum hardware floor has not been established.",
    note:req.note||null,needVramGb:null,recVramGb:null,needRamGb:null,recRamGb:null,
    yourVramGb:machine.gpu?.vramGb??null,yourRamGb:machine.ram.totalGb};
  const needVram = Number(req.vramMinGb ?? 0);
  const recVram = Number(req.vramRecGb ?? needVram);
  const needRam = Number(req.ramMinGb ?? 0);
  const recRam = Number(req.ramRecGb ?? needRam);
  const ramGb = machine.ram.totalGb;

  const common = {
    needVramGb: needVram, recVramGb: recVram, needRamGb: needRam, recRamGb: recRam,
    yourVramGb: machine.gpu ? machine.gpu.vramGb : null,
    yourRamGb: ramGb,
    /* The publisher's own caveat travels with the verdict. Several of these are
     * the difference between a true number and a useful one — H3's "never runs
     * while music is generating", Z-Image's "the limit here is system RAM". */
    note: req.note || null,
  };

  /* No card reading: answer the RAM half, which IS known, and refuse to guess
   * the other. A capability whose RAM floor this machine misses is below the
   * minimum whatever the card turns out to be, so that much can still be said. */
  if (!machine.gpu) {
    if (needRam && ramGb < needRam) {
      return {
        ...common, state: "wont-run",
        why: `This machine has ${ramGb} GB of system RAM and the minimum is ${needRam} GB. `
           + "That is decided without needing to know the card.",
      };
    }
    return {
      ...common, state: "unknown",
      why: `Needs a ${needVram} GB card (${recVram} GB recommended) and ${needRam} GB of RAM. `
         + `This machine has ${ramGb} GB of RAM, which clears it; the card could not be read.`,
    };
  }

  const vramGb = machine.gpu.vramGb;

  if (vramGb < needVram) {
    return {
      ...common, state: "wont-run",
      why: `Your ${machine.gpu.name} has ${vramGb} GB and this needs at least ${needVram} GB.`,
    };
  }
  if (needRam && ramGb < needRam) {
    return {
      ...common, state: "wont-run",
      why: `The card is big enough (${vramGb} GB against a ${needVram} GB minimum) but this machine has `
         + `${ramGb} GB of system RAM against a ${needRam} GB minimum — and on the low-VRAM tiers RAM is `
         + "where the weights that do not fit on the card are held, so it is not the softer of the two limits.",
    };
  }
  if (vramGb >= recVram && ramGb >= recRam) {
    return {
      ...common, state: "fits",
      why: `Your ${machine.gpu.name} (${vramGb} GB) and ${ramGb} GB of RAM are at or above the `
         + `recommended ${recVram} GB / ${recRam} GB.`,
    };
  }

  /* The wide middle. Which of the two is short changes the sentence, because it
   * changes what the user could do about it — a short card is a purchase, a
   * short RAM figure is often just closing something. */
  const shortCard = vramGb < recVram;
  const shortRam = ramGb < recRam;
  const bits = [];
  if (shortCard) bits.push(`your card has ${vramGb} GB where ${recVram} GB is recommended`);
  if (shortRam) bits.push(`this machine has ${ramGb} GB of RAM where ${recRam} GB is recommended`);
  return {
    ...common, state: "streams",
    why: `Above the ${needVram} GB minimum, so it runs — but ${bits.join(" and ")}. `
       + "Studio's low-VRAM tiers cover the difference by streaming weights from system RAM, "
       + "which works and is slower. Close other GPU apps before a long batch.",
  };
}

/* ── which capability is which, derived rather than listed ─────────────────
 *
 * See the header. The one thing worth spelling out: MUSIC is found by
 * `required`, not by id, so the day a second required capability appears it is
 * recommended automatically instead of being silently left out of the total
 * bytes a newcomer is quoted. */
const MUSIC_IDS = CATALOG.filter((c) => c.required).map((c) => c.id);
const VIDEO_IDS = Object.keys(config.video.engines)
  .map((k) => MODEL_TO_CAPABILITY[k])
  .filter(Boolean);
/* IMAGES ARE ASKED, NOT DEDUCED. This was `[...Object.values(
 * MODEL_TO_CAPABILITY)].filter((id) => !VIDEO_IDS.includes(id) &&
 * !MUSIC_IDS.includes(id))` — a subtraction, which has an answer for every
 * capability kind that does not exist yet, and the answer is "picture". The day
 * the control models were bridged into that map it recommended WAN 2.1 VACE to
 * a 16 GB machine as its picture model, with every suite green. The row says
 * what it makes now; a kind nobody has thought of says nothing and is therefore
 * not one. Same five ids, same order, one rule that cannot be wrong by
 * omission. See isPictureModel() in models.js. */
const IMAGE_IDS = CATALOG.filter(isPictureModel).map((c) => c.id);

/**
 * The one defect a hardware verdict cannot express.
 *
 * MEASURED on an AMD rig (RX 9060 XT, ROCm 10.1, torch 2.15): the
 * MiniMax smoke test rendered a 30-second file that is a constant 0 dBFS
 * signal, and the run before it was reported unlistenable. Nothing about the
 * card is too small — it clears every number the catalogue states. Written once
 * here and used by the recommendation; the picker, the Models card and the
 * launcher each carry their own shorter wording.
 */
const AMD_MUSIC_WARNING =
  "MiniMax Music 3 is buggy on AMD: measured on ROCm 10.1, its renders come out broken — "
  + "a 30-second smoke test came back as a constant 0 dBFS signal, and the run before it was "
  + "unlistenable. The card is not the problem; it clears every requirement below. Starting ComfyUI "
  + "with PyTorch attention and CUDA graphs off (--use-pytorch-cross-attention --disable-cuda-graphs, "
  + "Studio's default) fixes it; this launch does not use both.";

/* Least restrictive first: models.js rightsRank, the one ranking (a class it
 * does not know ranks as "unknown"). */
/* From FIT_STATES, so the page and the recommendation rank alike: a known
 * smaller size above "cannot tell", below anything that runs full size. */
const FIT_RANK = Object.fromEntries(Object.entries(FIT_STATES).map(([k, v]) => [k, v.rank]));

/* THE FAST SETTING'S FILE, found by a field on the row (`fastPathFor`), not by
 * id here. Rows that speed up an engine name it; the one marked `newInstalls`
 * is what a machine holding neither gets (the 182 MB rank-19 TaoMate, measured
 * equal to the 2.48 GB conversion). One already on disk always wins, and the
 * newInstalls one first among those: the 2.48 GB row counts the small file as
 * present (its `alt`), so after a new install fetches the small file both
 * rows read ready, and the pick must name the one that was fetched.
 * `fastNote` is the plain sentence the pick shows; the row's `why` keeps the
 * details (rank 19, who made it). */
const FAST_PATHS = CATALOG.filter((c) => c.fastPathFor)
  .map((c) => ({ id: c.id, for: c.fastPathFor, newInstalls: !!c.newInstalls, note: c.fastNote || "" }));

/** The territory sentence a region-locked pick's reason ends with. */
function regionLine(cap) {
  return cap.region
    ? ` ⚠ Licensed only outside ${cap.region.excluded.join(", ")} — the download asks you to `
      + "confirm you are outside those territories, and the licence is between you and the publisher."
    : "";
}

/** One order for "which of these", used by the recommendation and by the
 *  defaults below: on disk, then fit, then the least restrictive licence,
 *  then the smaller download. Rows are {cap, fit}. */
function rankPick(a, b) {
  /* Already downloaded wins outright. Recommending a 25 GB fetch to somebody
   * who is holding an equally good 14 GB one is not advice, it is a bill. */
  if (a.cap.ready !== b.cap.ready) return a.cap.ready ? -1 : 1;
  const f = FIT_RANK[a.fit.state] - FIT_RANK[b.fit.state];
  if (f) return f;
  const r = rightsRank(a.cap.outputRights?.class) - rightsRank(b.cap.outputRights?.class);
  if (r) return r;
  return (a.cap.totalBytes || 0) - (b.cap.totalBytes || 0);
}

/**
 * Bytes for a set of capabilities, counting each FILE once.
 *
 * Not a sum of `totalBytes`, and that is a real 8 GB error rather than a
 * pedantic one: qwen_3_4b.safetensors is 8.04 GB and belongs to THREE entries
 * (FLUX.2 klein, Z-Image Turbo, Z-Image base), flux2-vae.safetensors to two,
 * ae.safetensors to two. A recommendation naming a cover-art model and an image
 * model would quote a newcomer 8 GB of download that does not exist — on the
 * one screen where the number's whole job is to be trusted.
 *
 * Deduped by DESTINATION PATH, which is what "already on disk" means to
 * filePresent() too.
 */
export function bytesFor(caps) {
  const seen = new Set();
  let total = 0;
  let missing = 0;
  let shared = 0;
  for (const cap of caps) {
    for (const f of cap.files || []) {
      /* ⚠ THE PATH, NOT THE BASENAME, and the basename only as a fallback.
       * "The same file" is a question about a path; a name was a proxy for it,
       * and the proxy held only while no two capabilities shared a naming
       * convention. The mesh rows brought the diffusers one — two files called
       * `model.safetensors` in different folders — and under a basename key
       * they would have been counted once, quoting a newcomer a download
       * smaller than the one they get, on the number whose whole job is to be
       * trusted. status() carries `dest` for this; a synthetic row that carries
       * only a `name` still works, which is what the fit fixtures are. */
      const key = (f.dest || f.name || "").split("\\").join("/").toLowerCase();
      if (!key) continue;
      if (seen.has(key)) { shared += f.bytes || 0; continue; }
      seen.add(key);
      total += f.bytes || 0;
      if (!f.present) missing += f.bytes || 0;
    }
    /* Package-fetched capabilities have no files of their own; `totalBytes`
     * carries their approximate size so they are not quoted as free. */
    if (!(cap.files || []).length && cap.totalBytes) {
      total += cap.totalBytes;
      if (!cap.ready) missing += cap.totalBytes;
    }
  }
  /* `sharedBytes` is what the dedupe actually removed on THIS set of picks, not
   * what it could remove in principle. Reported so the sentence about it can be
   * withheld when it is zero — a note explaining a discrepancy that is not there
   * is just a claim the reader cannot check. */
  return { totalBytes: total, missingBytes: missing, sharedBytes: shared };
}

/* WHERE a package goes. Timed lyrics runs in a venv of its own
 * (config.lyrics.python), and "your SYSTEM Python" is where a first user put
 * faster-whisper, which Studio never runs for timed lyrics: the run died as
 * "alignment failed". Every other package here does run in the system python. */
function packageHome(cap) {
  if (cap.id === "lyrics") {
    return `It goes in ${config.lyrics.python}, the python timed lyrics run in (${SETTING_WORDS} changes it), `
      + "not your system Python and never ComfyUI's.";
  }
  return "It goes in your SYSTEM Python, never ComfyUI's, because installing it there can move "
    + "the torch build the engine depends on.";
}

/**
 * The music default from the catalogue rows, for a caller that did not hand
 * over index.js's answer (the suites, a probe): the person's saved choice if
 * config holds one, else musicDefault() over one choice per music engine,
 * ready when its row is. index.js passes the answer it applied instead, read
 * from the music model list itself, so the two cannot disagree on screen.
 */
function musicFromCaps(capabilities, machine) {
  if (prefChosen("music", "engine")) {
    return { value: config.music.engine, chosenBy: "you", kept: prefOrigin("music", "engine") === "kept",
      paid: !!config.api?.enabled && config.music.engine === "minimax-music3" };
  }
  const byId = new Map((capabilities || []).map((c) => [c.id, c]));
  const choices = Object.keys(config.music.engines || {}).map((engine) => {
    const cap = byId.get(MODEL_TO_CAPABILITY[engine]);
    if (!cap) return null;
    return {
      engine, available: !!cap.ready, label: String(cap.label || engine).split("—").pop().trim(),
      checkpoint: engine === "yue2-comfy" && cap.ready ? (cap.files?.[0]?.name || null) : null,
      precision: engine === "yue2-gguf" ? "q4_0" : null,
    };
  }).filter(Boolean);
  const comfyFit = yue2ComfyFitOn(byId.get(MODEL_TO_CAPABILITY["yue2-comfy"]), machine);
  return musicDefault({
    choices, machine,
    api: { enabled: !!config.api?.enabled, provider: config.api?.provider || null },
    musicOnly: !!config.musicOnly, comfy: !config.musicOnly && !config.cloudOnly,
    comfyFits: comfyFit.fits, comfyShort: comfyFit.short,
  });
}

/**
 * YuE2-through-ComfyUI's own floor on this machine, for the music default's
 * nothing-ready answer: server/music-default.js yue2ComfyFit over the row's
 * `requires` and readMachine's readings (the card in whole GB, RAM as
 * h3tier.js ramBoxGb reads it, 0 when unread, as fitFor takes it). The
 * launcher asks the same function (launcher/checks.mjs yue2ComfyVerdict).
 * { fits, short }: `short` is "card" or "ram", the half that fell short.
 */
export function yue2ComfyFitOn(row, machine) {
  if (!row) return { fits: undefined, short: null };
  return yue2ComfyFit(row.requires, { vramGb: machine?.gpu ? machine.gpu.vramGb : null, ramGb: machine?.ram?.totalGb ?? null });
}

/**
 * WHAT SHOULD THIS PERSON DOWNLOAD.
 *
 * One block, computed once, for a screen and for an agent. The rules, and why
 * each is a rule rather than a preference:
 *
 *   THE MUSIC ENGINE IS NOT A CHOICE. It is `required: true` in the catalogue —
 *     the app does not do its main job without it — so it is picked whatever it
 *     scores, with its fit stated. A recommendation that omitted it because the
 *     machine is small would be describing a different app.
 *
 *   THE VIDEO ENGINE MUST BE ONE STUDIO CAN ACTUALLY FETCH. This is the defect
 *     that motivated the whole block. LTX 2.5 is the better engine here by
 *     measurement (121 s against H3's 308 s, and better by eye) and its repo is
 *     ACCESS-GATED: the built-in downloader deliberately has no token and no
 *     place to keep one, so `gated` entries are excluded from being recommended
 *     and reported separately with the publisher's own hand-fetch steps. A
 *     recommendation is a button somebody presses. Naming a model with no
 *     button is how a newcomer meets their first dead end.
 *
 *   THE IMAGE ENGINE IS SORTED BY LICENCE, NOT BY QUALITY, once fit is equal.
 *     Studio cannot judge which picture is nicer and has no business trying.
 *     What it can read is `outputRights.class`, and the difference between
 *     "nothing in this licence touches what you generate" and "nobody has read
 *     the operative text" is the difference between a picture you can sell and
 *     one you would have to ask a lawyer about. Ideogram 4 loses to Z-Image on
 *     that alone, and the reason says so in those words.
 */
export function recommendFor({ capabilities, machine, disk, music = null } = {}) {
  const byId = new Map(capabilities.map((c) => [c.id, c]));
  const withFit = (id) => {
    const cap = byId.get(id);
    return cap ? { cap, fit: fitFor(cap.requires, machine) } : null;
  };

  const rank = rankPick;

  const picks = [];
  const notes = [];

  /* ── the engine there is no choice about ───────────────────────────────
   * WHICH one is the music default's answer (server/music-default.js): the
   * person's saved choice, else what Studio picks from this disk and card
   * (index.js hands over the answer it applied; a caller that has none gets
   * the same rule from the catalogue rows, musicFromCaps below). Worded by
   * who chose it: a fresh install's YuE2 is Studio's pick, never "your
   * selected music engine". */
  const musicPick = music || musicFromCaps(capabilities, machine);
  const mine = musicPick.chosenBy === "you";
  for (const id of [MODEL_TO_CAPABILITY[musicPick.value] || MUSIC_IDS[0]]) {
    const e = withFit(id);
    if (!e) continue;
    picks.push({
      slot: "music", id, label: e.cap.label, fit: e.fit, ready: e.cap.ready,
      bytes: e.cap.totalBytes, licence: e.cap.licence,
      outputRights: e.cap.outputRights || null, region: e.cap.region || null,
      chosenBy: musicPick.chosenBy || "machine", kept: !!musicPick.kept, paid: !!musicPick.paid,
      why: e.cap.ready
        ? `Already on disk. ${e.fit.why}`
        : mine
          ? `${musicPick.kept ? "Your settings name this music engine" : "You chose this music engine"}; the other music engines are optional. ${e.fit.why}`
          : `Studio picked this music engine for this PC; the other music engines are optional. ${e.fit.why}`
          /* On AMD the download is the int8 build, which nobody has measured
           * there (the row's own note); said beside the pick, as Home says it. */
          + (machine?.gpu?.vendor === "amd" && id === MODEL_TO_CAPABILITY["yue2-comfy"]
            ? " The build it fetches (int8) is not yet measured on AMD cards; the bf16 build is the one measured there." : ""),
    });
  }

  /* ── FIT IS NOT THE ONLY WAY A MODEL FAILS ────────────────────────────
   *
   * Everything above this line answers "is this machine big enough", and on an
   * AMD card that answer is yes for MiniMax Music 3 and the renders are still
   * unusable: MEASURED here on ROCm 10.1 (RX 9060 XT), the smoke test came back
   * as a constant 0 dBFS signal, and the run before it was reported
   * unlistenable. The Models screen, the music picker and the launcher all say
   * so; this block exists because the RECOMMENDATION did not, which made it the
   * one place in Studio still pointing a new AMD owner at the broken engine.
   *
   * It does not silently swap the pick. The pick is the engine the user has
   * selected, and a recommendation that quietly recommended something else
   * would be lying about what is about to run. It names the failure and names
   * the alternative that is measured to work on the same card. */
  /* Only for a MiniMax the person chose (Studio never picks it on AMD without
   * the fix: server/music-default.js), and never for the hosted one, which
   * does not render on this card. */
  const amdMusic = picks.find((p) => p.slot === "music" && p.id === MODEL_TO_CAPABILITY["minimax-music3"]
    && p.chosenBy === "you" && !p.paid);
  // Not when ComfyUI starts with the fix (index.js sets amdMusicFixed from the launch args).
  if (amdMusic && machine.gpu?.vendor === "amd" && !machine.amdMusicFixed) {
    const alt = byId.get(MODEL_TO_CAPABILITY["yue2-comfy"]);
    /* The MODEL half of "Music engine — <model>": the part before the dash is
     * the same words on every music row and names nothing. */
    const modelName = (label) => label.split("—").pop().trim();
    const altLine = alt
      ? ` ${modelName(alt.label)} renders correctly on the same card, through ComfyUI's own YuE2 nodes — pick it in the music model list.`
      : "";
    amdMusic.amdWarning = AMD_MUSIC_WARNING;
    amdMusic.why += ` ⚠ ${AMD_MUSIC_WARNING}${altLine}`;
    notes.push({
      slot: "music-amd", id: amdMusic.id, label: amdMusic.label,
      headline: `${amdMusic.kept ? "Your settings name" : "You chose"} ${modelName(amdMusic.label)}, and it is not usable on this AMD card.`,
      detail: AMD_MUSIC_WARNING + altLine,
    });
  }

  if (config.musicOnly) {
    const c=byId.get('musicYue2Gguf');
    const viaComfy=config.music.engine==='yue2-comfy';
    const total=viaComfy?0:(c?.totalBytes||0), missing=viaComfy||c?.ready?0:total;
    return {machine,headline:viaComfy
        ?'Music-only: YuE2 3B through your ComfyUI, from the checkpoint already on disk. Nothing to download.'
        :'Native music-only setup: install YuE2 GGUF. No other model is required.',picks,notes,
      packages:[],totalBytes:total,missingBytes:missing,sharedBytes:0,
      bytesNote:'Includes the native runtime and weights; allow extra disk space for extraction. Lower-VRAM hardware remains experimental.',
      diskFits:disk?disk.freeBytes>=missing:null,diskFreeBytes:disk?.freeBytes??null};
  }
  /* ── video: the best one with a button ───────────────────────────────── */
  const videos = VIDEO_IDS.map(withFit).filter(Boolean);
  /* Between two video rows that are equally ready and equally fitting, the
   * engine selected in settings wins before size does: FastH3 is 1 GB smaller
   * than H3 but experimental (measured 2026-09-24: slower than H3's Fast
   * setting, good on 1 of 3 prompts), and a fresh install's default is H3. */
  const chosenVideo = MODEL_TO_CAPABILITY[config.video.engine];
  const videoRank = (a, b) => {
    if (a.cap.ready !== b.cap.ready || FIT_RANK[a.fit.state] !== FIT_RANK[b.fit.state]) return rank(a, b);
    if ((a.cap.id === chosenVideo) !== (b.cap.id === chosenVideo)) return a.cap.id === chosenVideo ? -1 : 1;
    return rank(a, b);
  };
  /* `recommendable: false` (the H3 family's unproven preview, AMD, under 32 GB
   * of RAM; see h3Fit) is offered on its row and never picked here. */
  const fetchable = videos
    .filter((v) => !v.cap.gated && v.fit.state !== "wont-run" && v.fit.recommendable !== false)
    .sort(videoRank);
  const gatedOnes = videos.filter((v) => v.cap.gated);

  if (fetchable.length) {
    const best = fetchable[0];
    const others = fetchable.slice(1).map((v) => v.cap.label);
    picks.push({
      slot: "video", id: best.cap.id, label: best.cap.label, fit: best.fit, ready: best.cap.ready,
      bytes: best.cap.totalBytes, licence: best.cap.licence,
      outputRights: best.cap.outputRights || null,
      /* Carried, not summarised. H3 is region-locked and the downloader refuses
       * without an acknowledgement, so a recommendation that mentioned the model
       * and not the territory would be recommending a download that then bounces.
       * The excluded list is the catalogue's, four territories, never retyped. */
      region: best.cap.region || null,
      why: `The video engine Studio can fetch for you${others.length ? ` (over ${others.join(", ")})` : ""}. `
         + best.fit.why
         + regionLine(best.cap),
    });
    /* The file that turns on the Video screen's Fast setting for that engine:
     * the one on disk if either is, else the one marked for new installs. */
    const fast = FAST_PATHS.filter((f) => f.for === best.cap.id)
      .map((f) => ({ ...f, e: withFit(f.id) })).filter((f) => f.e);
    const chosen = fast.find((f) => f.e.cap.ready && f.newInstalls) || fast.find((f) => f.e.cap.ready)
      || fast.find((f) => f.newInstalls) || fast[0];
    if (chosen) {
      const { cap, fit } = chosen.e;
      picks.push({
        /* The slot id stays machine-readable; `slotLabel` is what a person reads. */
        slot: "video-fast", slotLabel: "fast video", id: cap.id, label: cap.label, fit, ready: cap.ready,
        bytes: cap.totalBytes, licence: cap.licence,
        outputRights: cap.outputRights || null, region: cap.region || null,
        why: `${cap.ready ? "Already on disk. " : ""}Turns on the Video screen's Fast setting (three steps) `
           + `for ${best.cap.label.split("—").pop().trim()}.${chosen.note ? ` ${chosen.note}` : ""}${regionLine(cap)}`,
      });
    }
  } else if (videos.length) {
    /* The H3 family shares one verdict (the tier is the card's, not the row's),
     * so it is said once for all of them, not once per row, in the words of
     * the engine selected in settings (else the first). */
    const family = videos.filter((v) => v.fit.h3);
    const voice = family.find((v) => v.cap.id === chosenVideo) || family[0];
    const rest = videos.filter((v) => !v.fit.h3).map((v) => `${v.cap.label}: ${v.fit.why}`);
    notes.push({
      slot: "video",
      headline: "No video engine is recommended for this machine.",
      /* What to do instead, in the owner's order: a friend's card, then a
       * paid service on your own key (server/cloud-switch.js); the paid half
       * makes clips in another launch mode, not a music video's scenes.
       * web/modelfit.js turns `instead` into buttons. The Instead line
       * names the friend, so the H3 sentence drops its own copy. */
      detail: [
        ...(family.length ? [`${family.map((v) => v.cap.label).join(" and ")}: ${voice.fit.why.replace(H3_ASK_A_FRIEND, "").trim()}`] : []),
        ...rest,
        `Instead: ${NO_STRONG_CARD_VIDEO_LINE}`,
      ].join(" "),
      instead: NO_STRONG_CARD.map((w) => ({ id: w.id, title: w.title, where: w.where, view: w.view, paid: w.paid })),
    });
  }

  /* The gated one is reported whatever happens — as the better option somebody
   * with the hardware may want to go and get by hand, or as the explanation for
   * why the fast engine is not being offered. Never as a pick. */
  for (const g of gatedOnes) {
    notes.push({
      slot: "video-gated", id: g.cap.id, label: g.cap.label, fit: g.fit,
      headline: g.fit.state === "wont-run"
        ? `${g.cap.label} would not run on this machine anyway.`
        : `${g.cap.label} would run here, and Studio cannot download it for you.`,
      detail: `${g.fit.why} Its repository is access-gated: the built-in downloader has no token and `
            + `deliberately no place to keep one. ${g.cap.gated.how}`,
      how: g.cap.gated.how,
      url: g.cap.gated.url || null,
    });
  }

  /* ── images: fit first, then the least restrictive licence ───────────── */
  const images = IMAGE_IDS.map(withFit).filter(Boolean);
  const usableImages = images.filter((i) => i.fit.state !== "wont-run").sort(rank);
  if (usableImages.length) {
    const best = usableImages[0];
    const rights = best.cap.outputRights?.class;
    const beaten = usableImages.slice(1)
      .filter((i) => rightsRank(i.cap.outputRights?.class) > rightsRank(rights))
      .map((i) => `${i.cap.label} (${i.cap.outputRights?.class})`);
    picks.push({
      slot: "image", id: best.cap.id, label: best.cap.label, fit: best.fit, ready: best.cap.ready,
      bytes: best.cap.totalBytes, licence: best.cap.licence,
      outputRights: best.cap.outputRights || null, region: best.cap.region || null,
      why: `Pictures, on the most permissive licence that fits: ${best.cap.licence.split("—")[0].trim()}. `
         + `${FIT_STATES[best.fit.state].line} ${best.fit.why}`
         + (beaten.length ? ` Chosen over ${beaten.join(", ")} on output rights, not on quality — Studio does not judge pictures.` : ""),
    });
  } else if (images.length) {
    notes.push({
      slot: "image",
      headline: "No image model clears its minimum on this machine.",
      detail: images.map((i) => `${i.cap.label}: ${i.fit.why}`).join(" "),
    });
  }

  /* ── the pip half, which is not a download at all ─────────────────────── */
  const packages = CATALOG
    .filter((c) => c.needsPackage || c.viaPackage)
    .map((c) => byId.get(c.id))
    .filter(Boolean)
    .map((cap) => ({
      id: cap.id, label: cap.label,
      fit: fitFor(cap.requires, machine),
      packageReady: cap.packageReady !== false,
      needsPackage: cap.needsPackage || null,
      install: cap.packageInstall || null,
      why: cap.packageReady === false
        ? `Needs the ${(cap.packageMissing?.length ? cap.packageMissing : [cap.needsPackage]).map((m) => `\`${m}\``).join(" and ")} `
          + "Python package, which Studio cannot fetch — it is a pip install, not a file. " + packageHome(cap)
        : "The Python side of this is present.",
    }));

  const picked = picks.map((p) => byId.get(p.id)).filter(Boolean);
  const { totalBytes, missingBytes, sharedBytes } = bytesFor(picked);

  /* ── the one line, for the top of the screen ───────────────────────────
   *
   * The owner's complaint in one sentence was that the Models screen "lists
   * everything and recommends nothing". Everything above is the recommendation;
   * this is the recommending. It is generated, never typed, so it cannot
   * survive a change that makes it false.
   *
   * The no-card wording is deliberately not a recommendation at all. Studio
   * genuinely does not know what an AMD or Apple machine will do with these
   * weights, and a confident list on a machine it cannot read would be the
   * worst possible place to start guessing. */
  const need = missingBytes > 0 ? `${(missingBytes / 1e9).toFixed(0)} GB to download` : "all of it already on disk";
  const headline = machine.gpu
    ? (picks.length
        ? `For your ${machine.gpu.name} (${machine.gpu.vramGb} GB) and ${machine.ram.totalGb} GB of RAM: `
          + `${picks.map((p) => p.label.split("—").pop().trim()).join(", ")} — ${need}.`
        : `Your ${machine.gpu.name} (${machine.gpu.vramGb} GB) is under the minimum for everything in the catalogue.`)
    : "Studio could not read a graphics card here — it runs `nvidia-smi`, which only exists for NVIDIA. "
      + "So nothing below is a recommendation yet: it is what each model asks for, beside the one number "
      + `this machine can confirm (${machine.ram.totalGb} GB of system RAM).`;

  return {
    machine,
    headline,
    picks,
    notes,
    packages,
    totalBytes,
    missingBytes,
    sharedBytes,
    /* Withheld when nothing was actually elided. Stated when something was,
     * because a reader who adds the rows up themselves and gets a bigger
     * number deserves to know which of you is wrong. */
    bytesNote: sharedBytes > 0
      ? `${(sharedBytes / 1e9).toFixed(1)} GB of this is files two of these models share `
        + "(the Qwen3-4B text encoder is used by three of them), counted once — so this total is "
        + "smaller than adding the rows."
      : null,
    diskFits: disk ? disk.freeBytes >= missingBytes : null,
    diskFreeBytes: disk ? disk.freeBytes : null,
  };
}

/* ── WHAT RUNS WHEN NOBODY CHOSE ───────────────────────────────────────────
 *
 * A fresh install used to aim music at MiniMax Music 3 and pictures and covers
 * at Qwen Image 2.1, neither of which the recommended download fetches; the
 * first song opened a download for the wrong engine and every cover after it
 * failed. defaultFor() is asked only when a preference is NOT saved, answers
 * from what is on this PC, and is worked out on every read: index.js applies it
 * to the live config without writing it into settings.json (config.js
 * applyMachineDefault), so the day a download finishes the default follows it.
 *
 * A SAVED CHOICE ALWAYS WINS, ready or not, and is reported as the person's —
 * with a sentence when its files are missing, never a silent swap. Nothing
 * here picks a paid API (only a person does that) and the YuE2 Python kit only
 * when it is installed and ready. The config.js literals are the last resort.
 *
 * Pure, like everything else in this file: index.js hands over what it read
 * (the music model choices, the catalogue rows, the machine) and
 * server/defaults_test.js asks the same questions of four imaginary machines. */

/** The one sentence when no picture model can paint a cover. */
export const COVER_NEEDS_MODEL = "Add a picture model to get covers.";

/** The engine names a picture can be made with, read from the same map the
 *  provenance ledger uses, restricted to the rows that make pictures. */
const PICTURE_ENGINES = Object.entries(MODEL_TO_CAPABILITY).filter(([, id]) => IMAGE_IDS.includes(id));

/** "Images — FLUX.2 klein 4B" -> "FLUX.2 klein 4B": the model half of a row label. */
const shortLabel = (label) => String(label || "").split("—").pop().trim();

/* The music answer lives in server/music-default.js (import-free), because the
 * launcher asks the same question on its first screen and may not import this
 * file (config.js computes a whole Studio at import time). */
export { yue2BuildFor } from "./music-default.js";

/* Who a saved value belongs to, in the words every row uses. `kept` is a value
 * an older Studio wrote into settings.json on its own: it wins like a choice,
 * but nobody can say it was chosen. */
const saidBy = (kept) => (kept ? "Saved in your settings:" : "You chose");

function pictureRows(capabilities, machine) {
  const byId = new Map((capabilities || []).map((c) => [c.id, c]));
  return PICTURE_ENGINES.map(([engine, id]) => {
    const cap = byId.get(id);
    return cap ? { engine, cap, fit: fitFor(cap.requires, machine || { gpu: null, ram: { totalGb: 0 } }) } : null;
  }).filter(Boolean);
}

/* A saved picture engine: ready when its row is on disk; "checkpoint" (the
 * person's own model file) is theirs to have put there. */
function savedPicture(saved, capabilities, machine) {
  const row = pictureRows(capabilities, machine).find((r) => r.engine === saved);
  return { ready: row ? !!row.cap.ready : saved === "checkpoint", label: row ? shortLabel(row.cap.label) : saved === "checkpoint" ? "your own model file" : saved };
}

function pictureDefault({ saved = null, kept = false, capabilities = [], machine = null, literal = "qwen-image-2.1" }) {
  const key = "image.engine";
  if (saved) {
    const { ready, label } = savedPicture(saved, capabilities, machine);
    return { key, value: saved, chosenBy: "you", kept: !!kept, ready, label,
      why: `${saidBy(kept)} ${label} for pictures${ready ? "." : ", and it is not on this PC. The Models screen has it; Studio does not switch for you."}` };
  }
  const rows = pictureRows(capabilities, machine);
  const onDisk = rows.filter((r) => r.cap.ready).sort(rankPick)[0];
  if (onDisk) {
    return { key, value: onDisk.engine, chosenBy: "machine", kept: false, ready: true, label: shortLabel(onDisk.cap.label),
      why: `Studio picked ${shortLabel(onDisk.cap.label)} for pictures because it is on this PC.` };
  }
  /* Nothing on disk: the one the recommendation would fetch, so Make picture
   * opens the download for the right model rather than a research-licence one. */
  const best = rows.filter((r) => r.fit.state !== "wont-run").sort(rankPick)[0];
  if (best) {
    return { key, value: best.engine, chosenBy: "machine", kept: false, ready: false, label: shortLabel(best.cap.label),
      why: `No picture model is on this PC yet. ${shortLabel(best.cap.label)} is the one to get (the Models screen has it).` };
  }
  return { key, value: literal, chosenBy: "machine", kept: false, ready: false, label: literal,
    why: "No picture model is on this PC yet. The Models screen has them." };
}

function coverDefault({ saved = null, kept = false, custom = false, capabilities = [], machine = null, literal = "qwen-image-2.1" }) {
  const key = "art.engine";
  if (custom) {
    return { key, value: saved || literal, chosenBy: "you", kept: false, ready: true, canRun: true, label: saved || literal,
      why: "Your own cover workflow or model file paints the covers." };
  }
  if (saved) {
    const { ready, label } = savedPicture(saved, capabilities, machine);
    return { key, value: saved, chosenBy: "you", kept: !!kept, ready, canRun: ready, label,
      why: ready ? `${saidBy(kept)} ${label} for covers.`
        : `${COVER_NEEDS_MODEL} ${kept ? `Your settings name ${label}` : `You chose ${label}`}, and it is not on this PC.` };
  }
  const pic = pictureDefault({ capabilities, machine, literal });
  return { key, value: pic.value, chosenBy: "machine", kept: false, ready: pic.ready, canRun: pic.ready, label: pic.label,
    why: pic.ready ? `Studio picked ${pic.label} for covers because it is on this PC.` : COVER_NEEDS_MODEL };
}

/* `turboBuilds` says which speed-up files config.js found; with none on disk
 * the count is config.js's fallback, and the sentence says so rather than
 * calling it matched. Clips only, for now: music-video clips still render at
 * their own count until the music-video lane reads this one. */
function videoStepsDefault({ engine = "h3", label = "H3", stepDefaults = null, turboBuilds = null }) {
  const value = Number.isFinite(stepDefaults?.standard) ? stepDefaults.standard : null;
  const onDisk = !turboBuilds || Object.values(turboBuilds).some(Boolean);
  return { key: "video.steps", value, chosenBy: "machine", kept: false, ready: value !== null && onDisk, label: `${value ?? "?"} steps`, engine,
    why: value === null ? `No ${label} step count is known on this PC.`
      : onDisk ? `${value} steps for clips: the step count the ${label} speed-up files on this PC were made for.`
      : `${value} steps for clips, the count the ${label} speed-up files the Models screen fetches are made for. None are on this PC yet.` };
}

/**
 * The default for one kind, and who chose it.
 *   "music"      ctx: server/music-default.js musicDefault
 *                     { saved: {engine, checkpoint, kept} | null, session, choices, machine, api, musicOnly, literal }
 *   "image"      ctx: { saved: engine | null, kept, capabilities, machine, literal }
 *   "cover"      ctx: { saved: engine | null, kept, custom, capabilities, machine, literal }
 *   "videoSteps" ctx: { engine, label, stepDefaults, turboBuilds }
 * Always { key, value, chosenBy: "machine" | "you", kept, why, ready, label }.
 * "you" is a saved value, which always wins; `kept` says an older Studio saved
 * it on its own, and its `why` says "Saved in your settings" instead of "You chose".
 */
export function defaultFor(kind, ctx = {}) {
  if (kind === "music") return musicDefault(ctx);
  if (kind === "image") return pictureDefault(ctx);
  if (kind === "cover") return coverDefault(ctx);
  if (kind === "videoSteps") return videoStepsDefault(ctx);
  throw new Error(`defaultFor: unknown kind ${kind}`);
}
