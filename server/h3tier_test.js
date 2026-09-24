/**
 * H3 CARD TIERS — the gate on server/h3tier.js and on everything that reads it.
 *
 * Nothing here renders. Every card below is a READING (what nvidia-smi or the
 * Windows adapter registry reports for it), because that is all h3tier.js
 * ever sees, and the machines it is about (a 12 GB, an 8 GB, a 6 GB card)
 * are not the one this is developed on.
 *
 * WHAT IT PINS
 *   1. the tier boundaries, on real readings (a 12 GB card reads 11.99 GB);
 *   2. the lab's VRAM fit: the seven capped TaoMate runs predicted within
 *      161 MiB WITHOUT the margin, and the margin reported separately;
 *   3. the grids: sides to multiples of 32, frames up to 17k + 5, and the frame
 *      rule agreeing with the one the graph builder uses (workflow.js);
 *   4. the RAM floor (16 GB) and warning (under 32 GB), the AMD note, and
 *      what is OFFERED against what is RECOMMENDED;
 *   5. ONE SOURCE: every H3-family catalogue row carries the tier flag and the
 *      same numbers, and gets the same state on the same machine, while
 *      FastH3 and the reference path quote their own evidence;
 *   6. the rank-19 TaoMate is what a new install is recommended, a machine
 *      already holding the 2.48 GB file is not told to fetch the small one,
 *      and nothing unproven (the preview, AMD, under 32 GB of RAM) is picked;
 *   7. the status block, the MCP line and the Auto note are wired.
 *
 * Runs standalone (`node server/h3tier_test.js`) and in the pre-commit hook.
 */
import { readFileSync } from "node:fs";
import {
  H3_TIERS, H3_FIT, H3_RAM_WARNING, H3_AMD_NOTE, H3_VRAM_MIN_GB, H3_VRAM_FULL_GB, H3_VRAM_OFFERED_GB,
  H3_RAM_FLOOR_GB, H3_RAM_MEASURED_GB, H3_LAB_CARD_GB, H3_VAE_CAVEAT, H3_VAE_MEASURED, H3_ASK_A_FRIEND, H3_MV_SCREEN, H3_PATHS,
  RAM_RESERVED_GB, ramBoxGb, gbWithArticle,
  h3TierFor, h3Tokens, h3VramNeedMiB, h3Estimate, snapH3, h3SnapFrames, h3Snap32,
  h3TierTable, h3Status, h3Requires, h3Brief,
} from "./h3tier.js";
import { readMachine, fitFor, recommendFor, FIT_STATES } from "./fit.js";
import { CATALOG } from "./models.js";
import { alignFrames } from "./workflow.js";
import { config } from "./config.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* ── 1. tier boundaries ────────────────────────────────────────────────── */
console.log("\n── the tier a card reading lands in ─────────────────────────────");
const CARDS = [
  ["RTX 4070 Ti SUPER, 16 GB", 16376, "full"],
  ["RTX 4070, 12 GB (reads 11.99)", 12282, "full"],
  ["RTX 2080 Ti, 11 GB", 11264, "small"],
  ["RTX 3080, 10 GB", 10240, "small"],
  ["RTX 3060 Ti, 8 GB", 8188, "small"],
  ["a 7 GB reading", 7168, "preview"],
  ["RTX 2060, 6 GB", 6144, "preview"],
  ["a 6 GB card that reads 5.8", 5939, "preview"],
  ["a 5 GB reading", 5120, "none"],
  ["GTX 1650, 4 GB", 4096, "none"],
  ["no reading", null, "unknown"],
  ["a zero reading", 0, "unknown"],
];
for (const [name, mb, want] of CARDS) {
  const t = h3TierFor({ vramMb: mb, ramGb: 32 });
  ok(`${name} → ${want}`, t.id === want, `got ${t.id} (cardGb ${t.cardGb})`);
}
ok("the tiers run biggest card first and end at 'none'",
  H3_TIERS.map((t) => t.id).join(",") === "full,small,preview,none"
    && H3_TIERS.every((t, i) => i === 0 || t.minGb < H3_TIERS[i - 1].minGb));
ok("each tier carries the fields the Video screen will read",
  H3_TIERS.every((t) => ["id", "label", "plain", "width", "height", "maxSeconds", "measured", "evidence"]
    .every((k) => k in t) && typeof t.evidence === "string" && t.evidence.length > 40));
ok("the lab's sizes: 1344x768 up to 8 s, 960x544 for 5 s, an 832x480 preview for 5 s",
  JSON.stringify(H3_TIERS.slice(0, 3).map((t) => [t.width, t.height, t.maxSeconds]))
    === JSON.stringify([[1344, 768, 8], [960, 544, 5], [832, 480, 5]]));
ok("8 s is said as what was MEASURED, not as a cap (the 16 GB card ran 9.4 s)",
  /measured up to 8 s/.test(H3_TIERS[0].plain) && /9\.4 s/.test(H3_TIERS[0].evidence) && /untested/.test(H3_TIERS[0].evidence)
    && !H3_TIERS.some((t) => /clips up to/.test(t.plain)));
ok("the measured tiers say they were measured on the Fast setting (TaoMate 3-step)",
  /Fast setting/.test(H3_TIERS[0].evidence) && /Fast setting/.test(H3_TIERS[1].evidence));
ok("full and small are measured; the preview is experimental and not",
  H3_TIERS[0].measured && H3_TIERS[1].measured && !H3_TIERS[2].measured && H3_TIERS[2].experimental);
ok("the preview names the two things a person can do about it",
  /close GPU-heavy apps/i.test(H3_TIERS[2].evidence) && /integrated graphics/.test(H3_TIERS[2].evidence));
ok("under 6 GB points to asking a friend first, and names no paid route",
  /Ask a friend/.test(H3_TIERS[3].evidence) && !/API|credit|paid|cloud/i.test(H3_TIERS[3].evidence));
ok("the 12 GB result's --lowvram caveat is said to a 12 GB card",
  /--lowvram/.test(h3TierFor({ vramMb: 12282 }).evidence) && /untested/.test(h3TierFor({ vramMb: 12282 }).evidence));
ok("...and not to the 16 GB card the lab ran on natively",
  !/--lowvram/.test(h3TierFor({ vramMb: 16376 }).evidence)
  && h3TierFor({ vramMb: 16376 }).evidence === `${H3_TIERS[0].evidence} ${H3_VAE_CAVEAT}`);
/* THE VAE THE LAB HAD (release critic): every figure was measured with the
 * rig's 3.17 GB int8 video VAE; a new install downloads the 5.2 GB fp16 one.
 * Every MEASURED sentence says so; the preview and the predictions do not
 * claim a measurement, so they carry no caveat about one. */
ok("every measured tier's evidence says a new install's video decoder was not measured, in plain words",
  /larger video decoder than the one these sizes were measured with/.test(H3_VAE_CAVEAT) && !/VAE|int8|fp16|bf16/.test(H3_VAE_CAVEAT)
  && [16376, 12282, 8188].every((mb) => h3TierFor({ vramMb: mb }).evidence.endsWith(H3_VAE_CAVEAT))
  && h3TierFor({ vramMb: 8188, path: "refs" }).evidence.endsWith(H3_VAE_CAVEAT));
/* ...and not on a PC that loads the file the lab measured with (the owner's
 * rig: config.js picks the int8 name first; index.js checks its size, since
 * Comfy-Org's own int8 has the same name and is not the measured file). */
ok("a PC loading the measured decoder gets the measured sentences without the caveat",
  [16376, 12282, 8188].every((mb) => !h3TierFor({ vramMb: mb, vaeMeasured: true }).evidence.includes(H3_VAE_CAVEAT))
  && !h3Status({ gpu: { totalMb: 16376, vendor: "nvidia" }, ram: { totalMb: 32659 }, vaeMeasured: true }).tier.evidence.includes(H3_VAE_CAVEAT)
  && h3Status({ gpu: { totalMb: 16376, vendor: "nvidia" }, ram: { totalMb: 32659 } }).tier.evidence.endsWith(H3_VAE_CAVEAT));
ok("the measured file is named by name and size, and the size is not Comfy-Org's int8 (2.81 GB)",
  H3_VAE_MEASURED.file === "minimax_h3_video_vae_int8_convrot.safetensors" && H3_VAE_MEASURED.bytes === 3_171_670_912
  && read("./config.js").includes(`"${H3_VAE_MEASURED.file}"`) && read("./models.js").includes("bytes: 2811065184")
  && /h3VaeMeasured\(\)/.test(read("./index.js")) && /H3_VAE_MEASURED\.bytes/.test(read("./index.js")));
ok("...and an unmeasured size (the preview, a predicted reference-path full size) carries none",
  !h3TierFor({ vramMb: 6144 }).evidence.includes(H3_VAE_CAVEAT)
  && !h3TierFor({ vramMb: 12282, path: "refs" }).evidence.includes(H3_VAE_CAVEAT));
ok("asking a friend names the rail's Music video screen, not the old Workflow",
  H3_MV_SCREEN === "Music video" && H3_ASK_A_FRIEND.includes(`on a scene in ${H3_MV_SCREEN}`) && !/Workflow/.test(H3_ASK_A_FRIEND));
ok("the article helper reads a GB figure aloud: an 8, an 11, an 18, an 80; a 6, a 12, a 16",
  ["an 8 GB", "an 11 GB", "an 18 GB", "an 80 GB", "a 6 GB", "a 12 GB", "a 16 GB"].join("|")
  === [8, 11, 18, 80, 6, 12, 16].map(gbWithArticle).join("|"));

/* ── 2. the fit against the lab ────────────────────────────────────────── */
console.log("\n── the VRAM fit, against the seven capped runs ─────────────────");
/* LAB_REPORT 2026-09-24 §3, second table; results.jsonl `vramPeakDeltaMiB`
 * (device peak minus the desktop before the run), TaoMate 3-step, text only.
 * Copied as data: the lab folder is not part of this tree. */
const LAB = [
  { arm: "L12 (strict)", width: 1344, height: 768, frames: 192, engineMiB: 9123 },
  { arm: "L8a",          width: 1344, height: 768, frames: 192, engineMiB: 9108 },
  { arm: "L8a",          width: 1344, height: 768, frames: 192, engineMiB: 9162 },
  { arm: "L8a_rep",      width: 1344, height: 768, frames: 192, engineMiB: 8970 },
  { arm: "L8b",          width: 960,  height: 544, frames: 124, engineMiB: 4975 },
  { arm: "L6a",          width: 832,  height: 480, frames: 124, engineMiB: 4192 },
  { arm: "L6b",          width: 640,  height: 352, frames: 107, engineMiB: 3575 },
];
ok("seven runs, as the lab says", LAB.length === H3_FIT.runs);
for (const r of LAB) {
  const err = h3VramNeedMiB(r) - r.engineMiB;
  ok(`${r.arm} ${r.width}x${r.height}, ${r.frames} frames: predicted within ${H3_FIT.maxErrorMiB} MiB `
    + `(off by ${err})`, Math.abs(err) <= H3_FIT.maxErrorMiB);
}
ok("1344x768 at 192 frames is 57,456 tokens (the lab's worked example)",
  h3Tokens({ width: 1344, height: 768, frames: 192 }) === 57456);
ok("640x352 at 107 frames is 7,040 tokens (the bottom of the fitted range)",
  h3Tokens({ width: 640, height: 352, frames: 107 }) === 7040);
/* The lab's own predictions for 8 GB with a lighter desktop (LAB_REPORT §4). */
for (const [w, h, f, lab] of [[960, 544, 192, 5968], [1344, 768, 124, 6874], [1152, 640, 192, 7287]]) {
  ok(`${w}x${h}, ${f} frames matches the lab's printed ${lab} MiB within 10`,
    Math.abs(h3VramNeedMiB({ width: w, height: h, frames: f }) - lab) <= 10,
    `got ${h3VramNeedMiB({ width: w, height: h, frames: f })}`);
}
{
  const e = h3Estimate({ width: 1344, height: 768, frames: 192 });
  ok("the margin is reported beside the need, never folded into it",
    e.marginMiB === H3_FIT.marginMiB && e.withMarginMiB === e.needMiB + H3_FIT.marginMiB
      && e.needMiB === h3VramNeedMiB({ width: 1344, height: 768, frames: 192 }));
  ok("an estimate inside the fitted range says so", e.inFittedRange === true);
  ok("...and one past it (1344x768, 15 s) says it is extrapolation",
    h3Estimate({ width: 1344, height: 768, frames: h3SnapFrames(15 * 24) }).inFittedRange === false);
}
ok("an unsnapped side is counted up, never cheaper (720 counts as 736)",
  h3Tokens({ width: 1280, height: 720, frames: 124 }) === h3Tokens({ width: 1280, height: 736, frames: 124 }));
/* The engine renders frames rounded UP to 17k + 5, so an unsnapped frame
 * count must cost what the engine renders, not less (it used to round down:
 * 1344x768 at 180 frames read 554 MiB under the 192 frames that render). */
ok("an unsnapped frame count costs what renders: 120 frames = 124",
  h3VramNeedMiB({ width: 960, height: 544, frames: 120 }) === h3VramNeedMiB({ width: 960, height: 544, frames: 124 }));
ok("...and 180 frames = 192 at full size",
  h3VramNeedMiB({ width: 1344, height: 768, frames: 180 }) === h3VramNeedMiB({ width: 1344, height: 768, frames: 192 }));
{
  const e = h3Estimate({ width: 960, height: 544, frames: 120 });
  ok("the estimate reports the frames and seconds that render (124, 5.17 s), not the request",
    e.frames === 124 && e.seconds === 5.17, JSON.stringify(e));
}
ok("each measured tier's longest clip, with the margin, is under its cap",
  [["full", 12], ["small", 8]].every(([id, cap]) => {
    const t = H3_TIERS.find((x) => x.id === id);
    return h3TierTable(t).at(-1).withMarginMiB < cap * 1024;
  }));

/* ── 3. the grids ──────────────────────────────────────────────────────── */
console.log("\n── snapping to H3's grids ──────────────────────────────────────");
ok("the 17k+5 grid: 124, 141, 158, 175, 192, 209, 226",
  [120, 130, 150, 170, 190, 200, 220].map(h3SnapFrames).join(",") === "124,141,158,175,192,209,226");
ok("frames already on the grid stay put", [124, 192, 226].every((f) => h3SnapFrames(f) === f));
ok("5 s is 124 frames and 8 s is 192 (the lengths the lab measured)",
  snapH3({ width: 960, height: 544, seconds: 5 }).frames === 124 && snapH3({ width: 1344, height: 768, seconds: 8 }).frames === 192);
{
  const disagree = [];
  for (let s = 1; s <= 15; s++) if (h3SnapFrames(s * 24) !== alignFrames(s, 24, "h3")) disagree.push(s);
  ok("the frame rule agrees with workflow.js alignFrames for 1..15 s", disagree.length === 0, `at ${disagree.join(", ")} s`);
}
ok("sides snap to the nearest multiple of 32",
  [[1344, 1344], [960, 960], [545, 544], [1000, 992], [720, 736], [10, 32]].every(([i, o]) => h3Snap32(i) === o));
ok("snapH3 returns a size on both grids",
  JSON.stringify(snapH3({ width: 1000, height: 560, frames: 130 })) === JSON.stringify({ width: 992, height: 576, frames: 141, seconds: 5.88 }));

/* ── 4. RAM and AMD ────────────────────────────────────────────────────── */
console.log("\n── the RAM warning and the AMD note ─────────────────────────────");
ok("16 GB of RAM gets the lab's warning", h3TierFor({ vramMb: 12282, ramGb: 16 }).ramWarning === H3_RAM_WARNING);
/* ONE RAM READER (release critic): the launcher allowed 4 GB for what
 * integrated graphics keeps while Home rounded, so one laptop was "ok" on the
 * launcher and "not recommended" on Home. h3tier.js ramBoxGb is the reader
 * everywhere now, with the launcher's allowance. */
ok("31.4 GB (a 32 GB laptop giving some to the iGPU) counts as 32 and is not warned",
  h3TierFor({ vramMb: 12282, ramGb: 31.4 }).ramWarning === null && h3TierFor({ vramMb: 12282, ramGb: 31.4 }).ramGb === 32);
ok("the reader: a reading within RAM_RESERVED_GB under a size RAM is sold in is that size, else rounded",
  RAM_RESERVED_GB === 4 && ramBoxGb(32659) === 32 && ramBoxGb(31.4 * 1024) === 32 && ramBoxGb(28.2 * 1024) === 32
  && ramBoxGb(27.9 * 1024) === 28 && ramBoxGb(15.4 * 1024) === 16 && ramBoxGb(12 * 1024) === 12 && ramBoxGb(0) === null
  && ramBoxGb(null) === null && ramBoxGb(65536) === 64);
/* The floor takes the same allowance, on purpose (h3tier.js says why): a
 * 16 GB box reading 12.1 GB is offered, never recommended; 11.9 GB is a 12 GB box. */
ok("the RAM floor judges with the one reader: 12.1 GB reads as 16 (offered, not recommended), 11.9 GB as 12 (under the floor)",
  ramBoxGb(12.1 * 1024) === 16 && ramBoxGb(11.9 * 1024) === 12
  && h3TierFor({ vramMb: 16376, ramGb: 12.1 }).ramBelowFloor === false && h3TierFor({ vramMb: 16376, ramGb: 12.1 }).recommend === false
  && h3TierFor({ vramMb: 16376, ramGb: 11.9 }).ramBelowFloor === true
  && /THE FLOOR TAKES THE SAME ALLOWANCE, ON PURPOSE/.test(read("./h3tier.js")));
ok("...and reading its own answer back gives the same answer (fit.js passes a judged figure on)",
  [8, 12, 16, 24, 28, 31, 32, 64].every((g) => ramBoxGb(ramBoxGb(g * 1024) * 1024) === ramBoxGb(g * 1024)));
ok("h3TierFor takes the reading in MiB too, the same way", h3TierFor({ vramMb: 12282, ramMb: 15.4 * 1024 }).ramGb === 16);
ok("32 GB, read as 31.9, is not warned", h3TierFor({ vramMb: 12282, ramGb: 31.9 }).ramWarning === null);
ok("64 GB is not warned", h3TierFor({ vramMb: 12282, ramGb: 64 }).ramWarning === null);
ok("the warning names the measured figure and the pagefile",
  /32 GB/.test(H3_RAM_WARNING) && /pagefile/.test(H3_RAM_WARNING));
ok("an AMD card gets the untested note; NVIDIA does not",
  h3TierFor({ vramMb: 16368, ramGb: 32, vendor: "amd" }).amdNote === H3_AMD_NOTE
    && h3TierFor({ vramMb: 16376, ramGb: 32, vendor: "nvidia" }).amdNote === null);
ok("the RAM floor is 16 GB: 12 is under it and not offered, 16 (and a 15.4 reading) is offered with the warning",
  H3_RAM_FLOOR_GB === 16
    && h3TierFor({ vramMb: 16376, ramGb: 12 }).ramBelowFloor === true && h3TierFor({ vramMb: 16376, ramGb: 12 }).offered === false
    && h3TierFor({ vramMb: 16376, ramGb: 15.4 }).offered === true
    && h3TierFor({ vramMb: 16376, ramGb: 16 }).ramBelowFloor === false && h3TierFor({ vramMb: 16376, ramGb: 16 }).offered === true
    && !!h3TierFor({ vramMb: 16376, ramGb: 16 }).ramWarning);
{
  /* OFFERED IS NOT RECOMMENDED: only a measured tier, on NVIDIA, with the RAM
   * the lab had, is put in front of a newcomer as a download. */
  const why = (o) => { const t = h3TierFor(o); return `${t.id}:${t.offered}:${t.recommend}:${t.notRecommendedFor}`; };
  const CASES = [
    ["16 GB card, 32 GB RAM", { vramMb: 16376, ramGb: 32 }, "full:true:true:null"],
    ["8 GB card, 32 GB RAM", { vramMb: 8188, ramGb: 32 }, "small:true:true:null"],
    ["12 GB card, 16 GB RAM", { vramMb: 12282, ramGb: 16 }, "full:true:false:ram"],
    ["6 GB card, 32 GB RAM", { vramMb: 6144, ramGb: 32 }, "preview:true:false:preview"],
    ["AMD 16 GB, 32 GB RAM", { vramMb: 16368, ramGb: 32, vendor: "amd" }, "full:true:false:amd"],
    ["4 GB card", { vramMb: 4096, ramGb: 32 }, "none:false:false:null"],
    ["16 GB card, 8 GB RAM", { vramMb: 16376, ramGb: 8 }, "full:false:false:null"],
    ["no card, 32 GB RAM", { vramMb: null, ramGb: 32 }, "unknown:true:true:null"],
    ["no card, 16 GB RAM", { vramMb: null, ramGb: 16 }, "unknown:true:false:ram"],
  ];
  for (const [name, o, want] of CASES) ok(`${name}: tier:offered:recommended:why-not = ${want}`, why(o) === want, why(o));
  ok("each not-recommended reason has a sentence",
    ["ram", "preview", "amd"].every((k) => {
      const t = h3TierFor(CASES.find(([, , w]) => w.endsWith(`:${k}`))[1]);
      return /^Offered, not recommended/.test(t.notRecommended);
    }));
}

/* ── 5. one source: the catalogue rows and their verdicts ──────────────── */
console.log("\n── the H3 rows read the tiers, all of them the same way ─────────");
const FAMILY = ["video", "videoRefs", "videoH3Turbo3", "videoH3Turbo3Small", "videoFastH3"];
const rows = FAMILY.map((id) => CATALOG.find((c) => c.id === id));
ok("the five H3-family rows exist", rows.every(Boolean), FAMILY.filter((_, i) => !rows[i]).join(", "));
ok("every one carries the tier flag and the tier numbers, from h3tier.js",
  rows.every((r) => r.requires?.h3Tiers === true
    && r.requires.vramMinGb === H3_VRAM_MIN_GB && r.requires.vramRecGb === H3_VRAM_FULL_GB
    && r.requires.ramMinGb === H3_RAM_FLOOR_GB && r.requires.ramRecGb === H3_RAM_MEASURED_GB),
  rows.map((r) => `${r.id}: ${JSON.stringify({ ...r.requires, note: undefined })}`).join(" | "));
ok("the printed minimum is the smallest MEASURED card (8 GB), not the unproven 6 GB preview",
  H3_VRAM_MIN_GB === 8 && H3_VRAM_OFFERED_GB === 6 && rows.every((r) => r.requires.vramMinGb === 8));
ok("the printed RAM is the enforced floor (16) and the measured amount (32), not an unmeasured 64",
  rows.every((r) => r.requires.ramMinGb === 16 && r.requires.ramRecGb === 32));
{
  const nums = (r) => JSON.stringify({ ...r.requires, note: undefined });
  ok("the TaoMate rows ask for exactly what H3 asks for (they cannot disagree with the model they load into)",
    nums(rows[2]) === nums(rows[0]) && nums(rows[3]) === nums(rows[0]));
}
ok("FastH3 and the reference build quote their own path's evidence; H3 and TaoMate the Fast setting's",
  rows[4].requires.h3Path === "fasth3" && rows[1].requires.h3Path === "refs"
    && [rows[0], rows[2], rows[3]].every((r) => r.requires.h3Path === null));
ok("no H3-family row still says 16 GB minimum", rows.every((r) => r.requires.vramMinGb !== 16));
ok("the row note spells every tier out, from the table", rows.every((r) => r.requires.note.startsWith(h3Requires().note)));
ok("...saying the Video screen starts at the card's size (it does now), and no more than that",
  !/Picks its size/.test(h3Requires().note) && /the Video screen starts at it/.test(h3Requires().note)
    && /an experimental 832x480/.test(h3Requires().note) && !/ a 832/.test(h3Requires().note));
ok("H3 and FastH3 say no AMD render has been tested",
  rows[0].note.includes(H3_AMD_NOTE) && rows[4].note.includes(H3_AMD_NOTE));
ok("FastH3 is marked experimental and carries the measured result, not 'not measured here'",
  /experimental/.test(rows[4].label) && /1\.4x/.test(rows[4].note) && /1 of 3/.test(rows[4].note)
    && /white blob/.test(rows[4].note) && /1\.45x/.test(rows[4].note) && !/not measured here/.test(rows[4].note));
ok("the rank-19 TaoMate states its measured result",
  /same speed/.test(rows[3].why) && /two judges/.test(rows[3].why) && !/Unmeasured/.test(rows[3].why));
ok("both TaoMate notes carry the result and the right size (182 MB, not 191)",
  /182 MB/.test(rows[2].note) && /182 MB/.test(rows[3].note) && !/191 MB/.test(rows[2].note + rows[3].note + rows[3].why));
ok("the small TaoMate's label is plain words a newcomer reads in the headline, not 'rank-19 average'",
  /Fast setting for H3/.test(rows[3].label) && /182 MB/.test(rows[3].label) && !/rank-19/.test(rows[3].label));
{
  const fun = CATALOG.find((c) => c.id === "videoH3FunControl");
  ok("the Fun ControlNet row keeps full size's floor, from h3tier.js, and says why it differs from H3",
    fun.requires.vramMinGb === H3_VRAM_FULL_GB && fun.requires.vramRecGb === H3_LAB_CARD_GB
      && fun.requires.ramMinGb === H3_RAM_FLOOR_GB && fun.requires.ramRecGb === H3_RAM_MEASURED_GB
      && /although H3 itself offers 960x544/.test(fun.requires.note) && !fun.requires.h3Tiers);
}

const reading = (name, mb, ramMb, vendor = null) =>
  readMachine({ name, totalMb: mb, usedMb: 0, vendor }, { totalMb: ramMb, usedMb: 0 });
const MACHINES = {
  "16 GB / 32 GB": reading("RTX 4070 Ti SUPER", 16376, 32659),
  "12 GB / 32 GB": reading("RTX 4070", 12282, 32659),
  "12 GB / 16 GB": reading("RTX 4070", 12282, 16310),
  "12 GB / 8 GB": reading("RTX 4070", 12282, 8192),
  "8 GB / 32 GB": reading("RTX 3060 Ti", 8188, 32659),
  "8 GB / 16 GB": reading("RTX 3060 Ti", 8188, 16310),
  "6 GB / 32 GB": reading("RTX 2060", 6144, 32659),
  "4 GB / 16 GB": reading("GTX 1650", 4096, 16310),
  "AMD 16 GB / 32 GB": reading("AMD Radeon RX 9060 XT", 16368, 32659, "amd"),
  "no card": readMachine(null, { totalMb: 32659, usedMb: 0 }),
  "no card / 16 GB": readMachine(null, { totalMb: 16310, usedMb: 0 }),
  "no card / 8 GB": readMachine(null, { totalMb: 8192, usedMb: 0 }),
};
/* [state, recommendable]. Only a measured size, on NVIDIA, with 32 GB of RAM,
 * is recommended; everything else is offered with its reason, or refused. */
const WANT = {
  "16 GB / 32 GB": ["fits", true], "12 GB / 32 GB": ["fits", true], "12 GB / 16 GB": ["streams", false],
  "12 GB / 8 GB": ["wont-run", false], "8 GB / 32 GB": ["smaller", true], "8 GB / 16 GB": ["smaller", false],
  "6 GB / 32 GB": ["unknown", false], "4 GB / 16 GB": ["wont-run", false], "AMD 16 GB / 32 GB": ["unknown", false],
  "no card": ["unknown", true], "no card / 16 GB": ["unknown", false], "no card / 8 GB": ["wont-run", false],
};
const SAME_PATH = [0, 2, 3];   // H3 and both TaoMate rows quote the Fast setting's measurement
for (const [name, m] of Object.entries(MACHINES)) {
  const fits = rows.map((r) => fitFor(r.requires, m));
  const [state, recommendable] = WANT[name];
  ok(`${name}: every H3-family row says ${state}, ${recommendable ? "recommended" : "not recommended"}`,
    fits.every((f) => f.state === state && f.recommendable === recommendable),
    fits.map((f, i) => `${FAMILY[i]}=${f.state}/${f.recommendable}`).join(", "));
  ok(`${name}: ...H3 and the TaoMate rows in one sentence`, new Set(SAME_PATH.map((i) => fits[i].why)).size === 1);
  ok(`${name}: the state is one the page has words for`, fits[0].state in FIT_STATES);
}
{
  const eight = fitFor(rows[0].requires, MACHINES["8 GB / 32 GB"]);
  ok("8 GB: the answer is a size, not 'Below the minimum'",
    eight.state === "smaller" && /960x544/.test(eight.why) && !/likely to fail/.test(eight.why) && /960x544, 5 s/.test(eight.short));
  ok("...and it says the Video screen starts at that size, with the others under Advanced",
    /The Video screen starts H3 clips at 960x544, 5 s or under/.test(eight.why) && /under Advanced/.test(eight.why)
      && !/does not pick/.test(eight.why));
  ok("...and that the 100 s was measured on the Fast setting",
    /Fast setting/.test(eight.why) && /Standard setting was not timed/.test(eight.why));
  const six = fitFor(rows[0].requires, MACHINES["6 GB / 32 GB"]);
  ok("6 GB: an experimental preview, 'Cannot tell', never a chip that says it runs",
    six.state === "unknown" && /832x480/.test(six.short) && /experimental/.test(six.short)
      && six.h3.experimental === true && six.recommendable === false && !/fits here/.test(six.why)
      && /not recommended/.test(six.why));
  const thin = fitFor(rows[0].requires, MACHINES["12 GB / 16 GB"]);
  ok("12 GB with 16 GB of RAM: runs full size, carries the RAM warning, is not called 'Fits', and is not recommended",
    thin.state === "streams" && thin.warning === H3_RAM_WARNING && /1344x768/.test(thin.short)
      && thin.recommendable === false && /not recommended/.test(thin.why));
  const starved = fitFor(rows[0].requires, MACHINES["12 GB / 8 GB"]);
  ok("12 GB with 8 GB of RAM: under the 16 GB floor, refused in RAM terms, friend route first",
    starved.state === "wont-run" && /8 GB of RAM/.test(starved.why) && /Ask a friend/.test(starved.why)
      && starved.needRamGb === H3_RAM_FLOOR_GB);
  const four = fitFor(rows[0].requires, MACHINES["4 GB / 16 GB"]);
  ok("4 GB: not offered, with the friend route and no RAM caveat on a render that will not happen",
    /Ask a friend/.test(four.why) && four.warning === null);
  const amd = fitFor(rows[0].requires, MACHINES["AMD 16 GB / 32 GB"]);
  ok("an AMD card is 'Cannot tell', not 'Fits', and is told no AMD H3 render has been tested",
    amd.state === "unknown" && amd.state !== "fits" && amd.warning === H3_AMD_NOTE && /AMD card/.test(amd.why)
      && /no AMD render tested/.test(amd.short));
  ok("...said once in the sentence, not twice", (amd.why.match(/AMD card/g) || []).length <= 2
    && !amd.why.includes(`${H3_AMD_NOTE} ${H3_AMD_NOTE}`) && !amd.why.includes(H3_AMD_NOTE));
  const none = fitFor(rows[0].requires, MACHINES["no card"]);
  ok("no card: 'could not be read', never 'no'", none.state === "unknown" && /could not be read/.test(none.why));
}
{
  /* FastH3 and the reference path were not measured where the Fast setting
   * was: their rows must not quote TaoMate's "bit-identical" as their own. */
  const at = (i, m) => fitFor(rows[i].requires, MACHINES[m]).why;
  ok("FastH3 on a 12 GB card: full size is a PREDICTION there, not TaoMate's measurement",
    /PREDICTED/.test(at(4, "12 GB / 32 GB")) && !/bit-identical/.test(at(4, "12 GB / 32 GB")));
  ok("FastH3 on the 16 GB card: its own measured wait (about 236 s)", /236 s/.test(at(4, "16 GB / 32 GB")));
  ok("FastH3 on 8 GB: its own 121.6 s under the cap", /121\.6 s/.test(at(4, "8 GB / 32 GB")));
  ok("the reference path on 12 GB: predicted and tight", /PREDICTED/.test(at(1, "12 GB / 32 GB")) && /tight/.test(at(1, "12 GB / 32 GB")));
  ok("the reference path on 8 GB: 314 MiB to spare and 137.8 s", /314 MiB/.test(at(1, "8 GB / 32 GB")) && /137\.8 s/.test(at(1, "8 GB / 32 GB")));
  ok("the path changes the words, never the state",
    Object.values(MACHINES).every((m) => new Set(rows.map((r) => fitFor(r.requires, m).state)).size === 1));
}
ok("a row without the flag is judged exactly as before",
  fitFor({ vramMinGb: 16, vramRecGb: 24, ramMinGb: 32, ramRecGb: 64 }, MACHINES["8 GB / 32 GB"]).state === "wont-run");

/* ── 6. what a new install is recommended ──────────────────────────────── */
console.log("\n── the Fast setting's file in the recommendation ───────────────");
function fresh(machine, readyIds = []) {
  const capabilities = CATALOG.map((c) => {
    const ready = readyIds.includes(c.id);
    return {
      ...c, ready,
      totalBytes: (c.files || []).reduce((n, f) => n + f.bytes, 0) || c.approxBytes || 0,
      files: (c.files || []).map((f) => ({ ...f, present: ready })),
      packageReady: !c.needsPackage,
      fit: fitFor(c.requires, machine),
    };
  });
  return recommendFor({ capabilities, machine, disk: { freeBytes: 900e9 } });
}
{
  const rec = fresh(MACHINES["16 GB / 32 GB"]);
  const fast = rec.picks.filter((p) => p.slot === "video-fast");
  ok("a new install on 16 GB is recommended the 182 MB rank-19 TaoMate, not the 2.48 GB file",
    fast.length === 1 && fast[0].id === "videoH3Turbo3Small" && fast[0].bytes < 2e8, JSON.stringify(fast.map((p) => p.id)));
  ok("...with its reason and the territory condition", /Fast setting/.test(fast[0].why) && /United States of America/.test(fast[0].why));
  ok("...in plain words: no 'rank-19' in the pick's reason or the headline, and a slot label a person reads",
    !/rank.19/i.test(fast[0].why) && !/rank.19/i.test(rec.headline) && /Fast setting for H3/.test(rec.headline)
      && fast[0].slotLabel === "fast video");
  ok("...and never both TaoMate files", !rec.picks.some((p) => p.id === "videoH3Turbo3"));
  const small = fresh(MACHINES["8 GB / 32 GB"]);
  ok("an 8 GB machine with 32 GB of RAM is now recommended H3, at its smaller size",
    small.picks.find((p) => p.slot === "video")?.id === "video" && /960x544/.test(small.picks.find((p) => p.slot === "video").why));
  ok("...and the same small TaoMate", small.picks.find((p) => p.slot === "video-fast")?.id === "videoH3Turbo3Small");
  const had = fresh(MACHINES["16 GB / 32 GB"], ["videoH3Turbo3"]);
  const kept = had.picks.find((p) => p.slot === "video-fast");
  ok("a machine already holding the 2.48 GB file keeps it and is told to fetch nothing for Fast",
    kept?.id === "videoH3Turbo3" && kept.ready === true && /Already on disk/.test(kept.why));
  /* The 2.48 GB row lists the small file as an `alt`, so once a new install
   * has fetched the small file BOTH rows read ready. The pick must still name
   * the one that was fetched, not the 2.48 GB row the person never downloaded. */
  const both = fresh(MACHINES["16 GB / 32 GB"], ["videoH3Turbo3", "videoH3Turbo3Small"]);
  ok("after a new install fetched the small file (both rows read ready), the pick names the small file",
    both.picks.find((p) => p.slot === "video-fast")?.id === "videoH3Turbo3Small");
  const four = fresh(MACHINES["4 GB / 16 GB"]);
  ok("4 GB: no video and no TaoMate pick", !four.picks.some((p) => p.slot === "video" || p.slot === "video-fast"));
  const note = four.notes.find((n) => n.slot === "video");
  ok("...the note says it once for the H3 family and names the friend route",
    !!note && (note.detail.match(/Ask a friend/g) || []).length === 1, note?.detail);
  /* OFFERED, NOT RECOMMENDED: nothing unproven goes into the download set. */
  for (const [name, reason] of [
    ["8 GB / 16 GB", /under the 32 GB of RAM/], ["12 GB / 16 GB", /under the 32 GB of RAM/],
    ["6 GB / 32 GB", /preview has not been seen to fit/], ["AMD 16 GB / 32 GB", /AMD card/],
    ["12 GB / 8 GB", /8 GB of RAM/], ["no card / 16 GB", /under the 32 GB of RAM/],
  ]) {
    const r = fresh(MACHINES[name]);
    const n = r.notes.find((x) => x.slot === "video");
    ok(`${name}: no H3 in the download set, and the note says why`,
      !r.picks.some((p) => p.slot === "video" || p.slot === "video-fast") && !!n && reason.test(n.detail), n?.detail);
  }
  ok("the 8 GB / 16 GB machine is quoted less to download than the one with 32 GB of RAM",
    fresh(MACHINES["8 GB / 16 GB"]).missingBytes < small.missingBytes);
}

/* ── 7. served, and the neighbours that repeat it ──────────────────────── */
console.log("\n── the status block, the tool, the Auto note ───────────────────");
{
  const s = h3Status({ gpu: { name: "RTX 3060 Ti", totalMb: 8188, vendor: "nvidia" }, ram: { totalMb: 16310 } });
  ok("h3Status: the card, its tier, the RAM warning", s.card.vramGb === 8 && s.tier.id === "small" && s.ramWarning === H3_RAM_WARNING);
  ok("...offered, not recommended, and why", s.offered === true && s.recommend === false && s.notRecommendedFor === "ram"
    && /not recommended/.test(s.notRecommended));
  ok("...the fit's inputs, for the Advanced estimate", s.fit.baseMiB === H3_FIT.baseMiB && s.fit.perTokenMiB === H3_FIT.perTokenMiB && s.fps === 24);
  ok("...and a need table at the tier's size, one row per second up to its longest clip",
    s.table.length === 5 && s.table.every((r) => r.width === 960 && r.height === 544) && s.table.at(-1).frames === 124);
  ok("...every tier listed for 'what a bigger card gets', without the long sentences",
    s.tiers.length === H3_TIERS.length && s.tiers.every((t) => !("evidence" in t)));
  const none = h3Status({ gpu: null, ram: { totalMb: 32659 } });
  ok("no card: no size chosen, no table", none.card === null && none.tier.id === "unknown" && none.table.length === 0);
  /* NO CARD AT ALL (the engine runs on the CPU): not offered, no size chips,
   * where a card that was merely not read stays "cannot tell". */
  const cpu = h3Status({ gpu: null, ram: { totalMb: 32659 }, cpuOnly: true });
  ok("a CPU-only engine: not offered, no chips, and said as no card rather than cannot tell",
    cpu.noCard === true && cpu.offered === false && cpu.choices.length === 0 && cpu.tier.id === "none"
    && /no graphics card for H3/.test(cpu.tier.evidence) && none.noCard === false && none.choices.length === 3);
  ok("...a card that WAS read is never judged CPU-only",
    h3Status({ gpu: { totalMb: 8188 }, ram: { totalMb: 32659 }, cpuOnly: true }).tier.id === "small");
  ok("readMachine carries the same block", JSON.stringify(MACHINES["8 GB / 32 GB"].h3.tier) ===
    JSON.stringify(h3Status({ gpu: { name: "RTX 3060 Ti", totalMb: 8188 }, ram: { totalMb: 32659 } }).tier));
  const b = h3Brief(s);
  ok("studio_status's brief: the tier, size, recommendation and warnings, and none of the table",
    b.tier === "small" && b.width === 960 && b.maxSeconds === 5 && b.recommend === false && b.ramWarning === H3_RAM_WARNING
      && !("table" in b) && !("tiers" in b) && !("fit" in b) && JSON.stringify(b).length < 400, JSON.stringify(b).length);
  ok("...and null when there is no block", h3Brief(null) === null && h3Brief({}) === null);
}
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
ok("/api/status serves it under config.video.h3", /h3: h3Status\(\{ gpu: gpuStatus\(\), ram: ramStatus\(\), cpuOnly: cpuOnlyEngine\(\), vaeMeasured: h3VaeMeasured\(\) \}\)/.test(code(read("./index.js"))));
ok("studio_status returns the brief (no new tool)", /h3_card_tier: h3Brief\(st\.config\?\.video\?\.h3\)/.test(code(read("./mcp.js"))));
ok("models_for_this_machine returns the warning, the size and recommendable per row",
  /warning: c\.fit\?\.warning/.test(read("./mcp-models.js")) && /h3Size: c\.fit\?\.h3/.test(read("./mcp-models.js"))
    && /recommendable: c\.fit\?\.recommendable/.test(read("./mcp-models.js")));
ok("...and its description names the video-fast slot and recommendable",
  /video-fast/.test(read("./mcp-models.js")) && /recommendable: false/.test(read("./mcp-models.js")));
ok("the Models screen shows the warning line", /warnLine\(c\.fit\)/.test(code(read("../web/modelfit.js"))));
{
  const pick = code(read("../web/modelpick.js"));
  ok("the model picker shows the size tail and the warning, and ranks by the server's order (no copy of it)",
    /c\.fit\?\.short/.test(pick) && /c\.fit\?\.warning/.test(pick) && /states\[c\.fit\?\.state\]\?\.rank/.test(pick)
      && !/\{\s*fits:\s*0/.test(pick));
}
ok("FIT_STATES serves the rank, least restrictive first",
  ["fits", "streams", "smaller", "unknown", "wont-run"].every((k, i) => FIT_STATES[k].rank === i));
ok("the Auto note no longer says models stay on the card over 16 GB, and says 12 GB normal mode is untested",
  !/keeps models on the card/.test(config.vramTiers.auto.note) && /untested/.test(config.vramTiers.auto.note));
ok("...and the '16 GB or more' tier, which has the same flags, now says the same (not 'resident')",
  JSON.stringify(config.vramTiers.high.flags) === JSON.stringify(["--async-offload", "4"])
    && !/resident/.test(config.vramTiers.high.note) && /same as Auto on 12 GB and up/.test(config.vramTiers.high.note));
ok("h3tier.js has no imports and no I/O", !/^\s*import\s/m.test(read("./h3tier.js")) && !/\b(fetch|readFileSync|spawn)\(/.test(code(read("./h3tier.js"))));

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) { for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
