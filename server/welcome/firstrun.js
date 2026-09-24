/**
 * THE FIRST-RUN LINES on Home (UI_PLAN B5): three sentences about THIS PC, in
 * place of the 25-card tour that used to open by itself.
 *
 *   1. what Studio read: the card, its memory, the RAM;
 *   2. music and pictures: the music model the Music screen will run, and the
 *      picture model Studio RECOMMENDS (said as a recommendation, because the
 *      Pictures screen keeps its own engine choice);
 *   3. video clips: whether this PC clears the engine's stated floor and, when
 *      it does not, WHICH half falls short (the card or the RAM), then what
 *      instead in the one order every surface uses (server/cloud-switch.js
 *      NO_STRONG_CARD): a friend's card first (Collab, free), a paid service
 *      on the person's own key second, and Reactive's cut styles as a third,
 *      free way. The owner's order, 2026-09-24: lending by a friend before any
 *      paid API. Left out in the launcher's Music-only and Comfy API modes,
 *      where the Video, Collab and Reactive screens are not in the rail.
 *
 * NOTHING HERE DECIDES ANYTHING. Every verdict is /api/models's: the machine
 * reading (fit.js readMachine), the recommendation and its notes (fit.js
 * recommendFor, the AMD music warning included) and each row's fit, with its
 * own numbers (needVramGb against yourVramGb, needRamGb against yourRamGb).
 * This only puts them into words, once, for the page and for studio_welcome
 * {action:"first_run"} alike, so the strip and an agent cannot describe one
 * machine two ways. What nobody has tried says so ("not yet tried"): an
 * unknown verdict, a card that is not NVIDIA, and lending between two PCs.
 * Pure: a models payload in, lines out; server/welcome/level_test.js feeds it
 * imaginary machines through the real fit.js.
 */
import { config } from "../config.js";
import { MODEL_TO_CAPABILITY } from "../models.js";
import { NO_STRONG_CARD, LENDING_UNTRIED, CLOUD_CARD_PLACE } from "../cloud-switch.js";
import { gbWithArticle, H3_VRAM_OFFERED_GB } from "../h3tier.js";

/* Decimal GB, the unit the Models screen counts in (web/app.js gb(), web/
 * modelfit.js): "about 42.9 GB" here beside "Download 42.91 GB" there, never a
 * GiB figure that reads as a different download. */
const sizeText = (bytes) => (bytes >= 1e9
  ? `about ${(bytes / 1e9).toFixed(1)} GB`
  : `about ${Math.max(1, Math.round(bytes / 1e6))} MB`);
/* "Video clips — MiniMax H3 (quantised)" → "MiniMax H3". The part before the
 * dash names the slot, which the sentence already says. */
const shortName = (label) => String(label || "").split("—").pop().replace(/\s*\([^)]*\)\s*$/, "").trim();
/* A card reading says who made it; only NVIDIA cards have rendered here. */
const VENDOR_WORDS = { amd: "an AMD card", intel: "an Intel card" };

function missingOf(cap) {
  if (!cap) return 0;
  return Math.max(0, (cap.totalBytes || 0) - (cap.haveBytes || 0));
}
const getText = (pick, cap) => {
  if (pick.ready) return "";
  const miss = missingOf(cap);
  return ` once you get it${miss ? ` (${sizeText(miss)})` : ""}`;
};

/* 2a. The music model: the one the Music screen runs, so said plainly. On
 * AMD the YuE2-for-ComfyUI download is the int8 build, which nobody has
 * measured on an AMD card yet (the bf16 build is the one that was): said
 * beside the download, as the Models row's note says it. */
function musicSentence(pick, cap, notes, caps, gpu = null) {
  const name = shortName(pick.label);
  /* fit.js's AMD block names a failure no hardware verdict can: the card is
   * big enough and the renders still come out broken. Its headline, word for
   * word, and the alternative it names (the same lookup fit.js makes). */
  const amd = pick.amdWarning ? notes.find((n) => n.slot === "music-amd") : null;
  if (amd?.headline) {
    const alt = caps.get(MODEL_TO_CAPABILITY["yue2-comfy"]);
    return `${amd.headline}${alt ? ` ${shortName(alt.label)} renders correctly on it: pick it in the music model list.` : ""}`;
  }
  if (pick.fit?.state === "wont-run") return `Music: ${name} is below its minimum on this PC.`;
  if (pick.ready) return `Music on ${name}, already on this PC.`;
  const amdUnmeasured = gpu?.vendor === "amd" && pick.id === MODEL_TO_CAPABILITY["yue2-comfy"]
    ? "; the build it fetches is not yet measured on AMD cards" : "";
  return `Music on ${name}${getText(pick, cap)}${amdUnmeasured}.`;
}

/* 2b. Pictures: a recommendation, not a promise about what the screen runs. */
function pictureSentence(pick, cap) {
  const name = shortName(pick.label);
  if (pick.ready) return `For pictures Studio recommends ${name}, already on this PC.`;
  const miss = missingOf(cap);
  return `For pictures Studio recommends ${name}${miss ? ` (${sizeText(miss)} to get)` : ""}.`;
}

/* 3a. A video engine Studio would fetch for this PC. */
function videoPickSentence(pick, cap, gpu) {
  const name = `${shortName(pick.label)}${pick.region ? " (its licence leaves out some countries)" : ""}`;
  const head = `Video clips on ${name}${getText(pick, cap)}`;
  const f = pick.fit || {};
  /* Only NVIDIA cards have rendered video here: a clean verdict on any other
   * make is a verdict about memory, and the sentence says so. */
  const untried = gpu?.vendor && VENDOR_WORDS[gpu.vendor];
  if (untried && ["fits", "streams", "smaller"].includes(f.state)) {
    return `${head}: this card clears the stated minimum, but video has not yet been tried on ${untried}.`;
  }
  if (f.state === "fits") return `${head}: this PC is at or above the recommended size.`;
  if (f.state === "streams") return `${head}: this PC is above the minimum and under the recommendation, so they run slower.`;
  /* A size the card was measured to fit (server/h3tier.js): read off the row,
   * never worked out here. The Video screen starts at it (web/vidfit.js,
   * h3tier.js h3StartSize), so the sentence says where it is set. */
  if (f.state === "smaller") {
    const h = f.h3 || {};
    const size = h.width && h.height ? ` (${h.width}x${h.height}${h.maxSeconds ? `, up to ${h.maxSeconds} s` : ""})` : "";
    return `${head}: this card fits a smaller size${size}, and the Video screen starts there.`;
  }
  if (!gpu) return `${head}: Studio could not read the card, so it cannot tell whether they run.`;
  return `${head}: not yet tried on a card like this one.`;
}

/* 3b. No engine Studio can fetch is recommended here: name the half that falls
 * short, from the row's own numbers, for the engine the Video screen runs. */
function videoShortSentence(row, gpu, h3 = null) {
  const name = shortName(row.label);
  const f = row.fit || {};
  const num = (n) => Number.isFinite(n) && n > 0;
  /* THE H3 FAMILY IS JUDGED BY ITS TIER (server/h3tier.js), the answer the
   * Video and music-video screens give, not by the row's printed minimum: a
   * 6 GB card is offered the experimental preview there, so Home says the
   * same rather than "needs an 8 GB card". */
  if (f.h3 && h3?.noCard) return `Video clips: this PC has no graphics card for ${name} to render on.`;
  if (f.h3 && gpu && f.h3.tier === "preview" && !(num(f.needRamGb) && f.yourRamGb < f.needRamGb)) {
    return `Video clips: ${name} is offered on this ${f.yourVramGb} GB card only as an experimental `
      + `${f.h3.width}x${f.h3.height} preview, not yet seen to fit; the Video screen starts there.`;
  }
  if (f.h3 && gpu && f.h3.tier === "none") {
    return `Video clips: ${name} needs at least ${gbWithArticle(H3_VRAM_OFFERED_GB)} card, even for an experimental `
      + `preview, and this one has ${f.yourVramGb} GB.`;
  }
  const vramShort = gpu && num(f.needVramGb) && Number.isFinite(f.yourVramGb) && f.yourVramGb < f.needVramGb;
  const ramShort = num(f.needRamGb) && Number.isFinite(f.yourRamGb) && f.yourRamGb < f.needRamGb;
  if (vramShort && ramShort) {
    return `Video clips: ${name} needs ${gbWithArticle(f.needVramGb)} card and ${f.needRamGb} GB of RAM; this PC has ${f.yourVramGb} GB and ${f.yourRamGb} GB.`;
  }
  if (vramShort) return `Video clips: ${name} needs ${gbWithArticle(f.needVramGb)} card and this one has ${f.yourVramGb} GB.`;
  if (ramShort) {
    return `Video clips: ${name} needs ${f.needRamGb} GB of RAM and this PC has ${f.yourRamGb} GB${gpu ? "; the card is big enough" : ""}.`;
  }
  if (!gpu) return `Video clips: Studio could not read the card, so it cannot tell whether ${name} runs here.`;
  if (f.state === "unknown") return `Video clips: ${name} has not yet been tried on a card like this one.`;
  /* Offered and still not recommended because the RAM is under what the row
   * recommends (for H3, the 32 GB the lab measured with: server/h3tier.js):
   * the RAM is the half that falls short, from the row's own numbers. */
  if (f.recommendable === false && num(f.recRamGb) && Number.isFinite(f.yourRamGb) && f.yourRamGb < f.recRamGb) {
    return `Video clips: ${name} is not recommended with ${f.yourRamGb} GB of RAM `
      + `(it ${f.h3 ? "was measured with" : "recommends"} ${f.recRamGb} GB); `
      + `${f.state === "smaller" ? "the card fits a smaller size" : "the card is big enough"}.`;
  }
  return `Video clips: Studio does not recommend ${name} on this PC yet; Models says why.`;
}

/* What instead, in NO_STRONG_CARD's order (server/cloud-switch.js): a friend
 * first, then the person's own paid key; then Reactive's cut styles, which
 * run on the compositor alone (catalogue.js, the Reactive card), as a third
 * free way. Lending is built and has passed its tests on one machine; a render
 * between two PCs has not been tried, and the sentence says so rather than
 * promising it (docs/COLLAB.md). */
const WAY_WORDS = {
  friend: `a friend's card (Collab, free; ${LENDING_UNTRIED})`,
  /* The Settings link under the line opens the card; its full name is on it. */
  "own-key": `then your own paid key (${CLOUD_CARD_PLACE.split(" → ")[0]})`,
};
const INSTEAD = `Instead: ${NO_STRONG_CARD.map((w) => WAY_WORDS[w.id]).filter(Boolean).join(", ")}, `
  + "or Reactive's cut styles, free.";
const INSTEAD_LINKS = [
  ...NO_STRONG_CARD.filter((w) => WAY_WORDS[w.id]).map((w) => ({ label: w.where === "Collab" ? "Collab" : "Settings", view: w.view })),
  { label: "Reactive", view: "reactive" },
];

export function firstRunLines(models) {
  const m = models || {};
  const machine = m.machine || null;
  const gpu = machine?.gpu || null;
  const ramGb = machine?.ram?.totalGb ?? null;
  const caps = new Map((m.capabilities || []).map((c) => [c.id, c]));
  const picks = m.recommended?.picks || [];
  const notes = m.recommended?.notes || [];
  const pick = (slot) => picks.find((p) => p.slot === slot) || null;
  const lines = [];
  const links = [];

  /* 1. the machine */
  if (m.unavailable) {
    lines.push("Studio could not read this PC just now, so it says nothing about what fits.");
  } else if (gpu) {
    lines.push(`Studio read your ${gpu.name} (${gpu.vramGb} GB)${ramGb ? ` and ${ramGb} GB of RAM` : ""}.`);
  } else if (machine?.h3?.noCard) {
    /* No card at all (the CPU-only engine): a fact, not "could not read". */
    lines.push(`This PC has no graphics card for Studio${ramGb ? ` (${ramGb} GB of RAM)` : ""}: its engine runs on the CPU, which is slow.`);
  } else {
    lines.push(`Studio could not read a graphics card on this PC${ramGb ? ` (${ramGb} GB of RAM)` : ""}, so it cannot say what fits the card.`);
  }

  /* 2. music and pictures */
  const music = pick("music"), image = pick("image");
  const two = [];
  if (music) two.push(musicSentence(music, caps.get(music.id), notes, caps, gpu));
  if (image) two.push(pictureSentence(image, caps.get(image.id)));
  else if (notes.some((n) => n.slot === "image")) two.push("No picture model clears its minimum here.");
  if (two.length) lines.push(two.join(" "));

  /* 3. video clips, where this mode has a Video screen at all */
  if (!m.unavailable && !config.musicOnly && !config.cloudOnly) {
    const video = pick("video");
    if (video) {
      lines.push(videoPickSentence(video, caps.get(video.id), gpu));
    } else {
      /* The row the Video screen would run, else the first engine this build
       * renders with that has a row: one engine described exactly beats a
       * floor averaged over three. */
      const rows = Object.keys(config.video.engines).map((k) => caps.get(MODEL_TO_CAPABILITY[k])).filter(Boolean);
      const row = caps.get(MODEL_TO_CAPABILITY[config.video.engine]) || rows[0] || null;
      if (row?.fit) {
        lines.push(`${videoShortSentence(row, gpu, machine?.h3)} ${INSTEAD}`);
        links.push(...INSTEAD_LINKS);
      }
    }
  }

  links.push({ label: "Models", view: "models" });
  if (!links.some((k) => k.view === "settings")) links.push({ label: "Settings", view: "settings" });
  return {
    lines,
    links,
    /* Quoted back, so no line is traceable to a reading nobody can see. */
    machine: machine ? { gpu: gpu ? { name: gpu.name, vramGb: gpu.vramGb, vendor: gpu.vendor || null } : null, ramGb } : null,
  };
}
