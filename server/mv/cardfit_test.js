/**
 * THE MUSIC VIDEO SCREENS FOLLOW THE CARD — the lane.
 *
 * What it pins, each against the code that acts on it rather than a copy:
 *
 *   1. ONE SIZE LIST. The brief's sizes are server/mv/sizes.js, whose three
 *      card tiers are server/h3tier.js's own rows; renderSize, the collab
 *      packet, the order that inverts it, set_brief's validation, the MCP enum
 *      and the page all read it. Every size and shape renders what it says.
 *   2. ONLY THE SHAPES THAT RENDER. 16:9 and 9:16; 1:1, 4:3 and 21:9 are
 *      refused at the door and never offered, and a project that stored one
 *      says it renders 16:9.
 *   3. A NEW VIDEO STARTS AT ITS CARD'S SIZE (none where H3 is not offered,
 *      the RAM included), and the longest scene follows the brief: 8 s at full
 *      size, 5 s at the smaller sizes and High, 15 s for an LTX project, each
 *      with where the number comes from.
 *   4. DEFAULT STEPS ARE THE MATCHED COUNT for the files on disk, sent and
 *      priced the same way and worded from the disk; a friend's render never
 *      takes the owner's disk's count.
 *   5. HYBRID SENDS A CAST-LESS SCENE TO LTX ONLY WHEN LTX IS HERE, and says so.
 *   6. STOP: the plan card's Stop cancels its clip on the engine and in the
 *      app's queue, the plan stays stopped, and its note says what was really
 *      reached; the rail's Stop (and only it) PAUSES a running plan and keeps
 *      every approval.
 *   7. A CLIP PAST THE WAIT IS FILED WHEN IT LANDS, a job taken off the queue
 *      is noticed at once, and a refused request says why.
 *   9. THE CUT LEAVES NO SUNG SECOND WITHOUT A PICTURE at any longest scene,
 *      on real songs' line timings and on a ballad with breaths.
 *
 * No server, no port, no GPU: the routes run in process into a temp folder,
 * with a stand-in art queue and a stand-in engine door, so nothing here can
 * reach a real render. Runs standalone (`node server/mv/cardfit_test.js`) and
 * in the pre-commit hook.
 */
import os from "node:os";
import path from "node:path";
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

/* The output dir is decided before config.js is first imported (static imports
 * hoist), exactly as plan_test.js does. */
const OUT = path.join(os.tmpdir(), `mv-cardfit-test-${process.pid}-${Date.now().toString(36)}`);
process.env.AIPLAY_OUTPUT = OUT;
process.env.AIPLAY_APPDATA = path.join(OUT, "appdata");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
/* Source with comments removed, so a check about CODE is not tripped by prose. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const sizes = await import("./sizes.js");
const { H3_TIERS } = await import("../h3tier.js");
const { renderSize, generateClip, awaitArt } = await import("./generate.js");
const { config } = await import("../config.js");
const clipsteps = await import("./clipsteps.js");
const shot = await import("./shot.js");
const plan = await import("./plan.js");
const planrun = await import("./planrun.js");
const store = await import("./store.js");
const orderM = await import("../collab/order.js");
const errandM = await import("../collab/errand.js");
const { mvTools } = await import("../mcp-mv.js");

const tier = (id) => H3_TIERS.find((t) => t.id === id);

/* REAL-SHAPED LYRICS: the line timings (seconds, no words) of two songs in
 * this Studio's own library, as their lyric alignment produced them, and a
 * ballad with breaths between its lines. Real alignments butt each line
 * against the next, and some lines run past 5 s: the case a shorter longest
 * scene used to cut the tail off. The ballad is the breath case. */
const TIMED = {
  "night-train-girl": { total: 169, lines: [[15.42, 19.86], [19.86, 22.83], [22.83, 27.44], [27.44, 32.58], [32.58, 37.26], [37.26, 44.6], [44.6, 47.52], [47.52, 52.77], [52.77, 55.32], [55.32, 57.56], [57.56, 62.96], [62.96, 67.8], [67.8, 72.47], [72.47, 77.64], [77.64, 81.64], [81.64, 87.38], [87.38, 94], [94, 96.96], [96.96, 102.24], [102.24, 104.75], [104.75, 107.17], [107.17, 112.6], [112.6, 117.38], [117.38, 122], [122, 127.64], [127.64, 133.66], [133.66, 136.46], [136.46, 141.74], [141.74, 144.24], [144.24, 146.7], [146.7, 150.2]] },
  "hex-appeal": { total: 208.224, lines: [[12.24, 16.2], [16.2, 20.56], [20.56, 24.1], [24.1, 27.68], [27.68, 29.18], [29.18, 31.12], [31.12, 32.96], [32.96, 34.74], [34.74, 37.66], [37.66, 38.24], [38.24, 38.68], [38.68, 39.08], [39.08, 42.56], [42.56, 44.34], [44.34, 46.64], [46.64, 48.98], [48.98, 50.36], [50.36, 56], [56, 58.08], [58.08, 59.69], [59.69, 61.62], [61.62, 67.45], [67.45, 73.64], [73.64, 74.8], [74.8, 76.8], [76.8, 78.5], [78.5, 79.78], [79.78, 80.78], [80.78, 83.14], [83.14, 83.98], [83.98, 84.44], [84.44, 87.78], [87.78, 88.4], [88.4, 88.84], [88.84, 89.24], [89.24, 92.74], [92.74, 94.64], [94.64, 96.71], [96.71, 99.18], [99.18, 100.48], [100.48, 105.8], [105.8, 108.34], [108.34, 109.66], [109.66, 111.52], [111.52, 118.64], [118.64, 120.56], [120.56, 122.86], [122.86, 123.5], [123.5, 124.7], [124.7, 127.08], [127.08, 129.46], [129.46, 131.83], [131.83, 134.21], [134.21, 136.59], [136.59, 137.34], [137.34, 139.7], [139.7, 141.1], [141.1, 143.34], [143.34, 144.74], [144.74, 146.92], [146.92, 150.78], [150.78, 153.1], [153.1, 155.42], [155.42, 157.74], [157.74, 160.06], [160.06, 162.38], [162.38, 164.7], [164.7, 166.26], [166.26, 168.43], [168.43, 170.92], [170.92, 172.18], [172.18, 175.29], [175.29, 179.68], [179.68, 181.34], [181.34, 183.8], [183.8, 187.42], [187.42, 188.14], [188.14, 188.66], [188.66, 189.72], [189.72, 193.2], [193.2, 196.7]] },
};
{
  let t = 6; const lens = [4.2, 6.1, 3.5, 7.2, 5.4, 4.8, 6.6, 3.9, 5.9, 7.4, 4.1, 5.2], gaps = [0.4, 0.8, 0.3, 1.2, 0.6, 0.5];
  const lines = [];
  for (let i = 0; t < 170; i++) {
    if (i === 12 || i === 24) t += 8;
    const d = lens[i % lens.length];
    lines.push([Math.round(t * 100) / 100, Math.round((t + d) * 100) / 100]);
    t += d + gaps[i % gaps.length];
  }
  TIMED.ballad = { total: 180, lines };
}
const lyricLinesOf = (name) => TIMED[name].lines.map(([startSec, endSec], index) => ({ index, text: `line ${index + 1}`, startSec, endSec }));

/* ══════════════════════════════════════════════════════ 1. one size list */
console.log("\n  -- 1. one size list, read from the card tiers --");
{
  const ids = sizes.MV_SIZES.map((s) => s.id);
  ok("the list is the three card tiers and the two older sizes",
    JSON.stringify(ids) === JSON.stringify(["recommended", "small", "preview", "budget", "high"]), ids.join(","));
  for (const [id, t] of [["recommended", "full"], ["small", "small"], ["preview", "preview"]]) {
    const s = sizes.sizeById(id);
    ok(`${id} IS h3tier's "${t}" row (${tier(t).width}x${tier(t).height}, "${tier(t).label}"), not a copy of it`,
      s.tier === t && s.width === tier(t).width && s.height === tier(t).height && s.label === tier(t).label);
  }
  ok("the preview says it is experimental", sizes.sizeById("preview").experimental === true);
  /* The numbers a person reads in a sentence are fine; a number the CODE uses
   * is what must come from h3tier.js. So strings go too, not only comments. */
  const src = code(read("server/mv/sizes.js")).replace(/`[^`]*`/g, "``").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  ok("sizes.js types none of the tier sizes itself",
    !/\b(1344|960|544|832)\b/.test(src), (src.match(/\b(1344|960|544|832)\b/g) || []).join(","));
  ok("...and no card threshold either", !/\bminGb:\s*\d|>=\s*\d+\s*\)/.test(src));

  /* renderSize (the generator AND the export) honours every size and shape. */
  const wrong = [];
  for (const s of sizes.MV_SIZES) {
    for (const aspect of sizes.MV_ASPECTS) {
      const got = renderSize({ brief: { qualityMode: s.id, aspectRatio: aspect } });
      const want = aspect === "9:16" ? [s.height, s.width] : [s.width, s.height];
      if (got[0] !== want[0] || got[1] !== want[1]) wrong.push(`${s.id} ${aspect}: ${got}`);
    }
  }
  ok("renderSize renders every size in both shapes", !wrong.length, wrong.join("; "));
  ok("a brief naming no size renders full size",
    renderSize({ brief: {} }).join("x") === `${tier("full").width}x${tier("full").height}`);

  /* Every size an order can name inverts back into a brief that renders it. */
  const bad = [];
  for (const s of sizes.MV_SIZES) {
    for (const aspect of sizes.MV_ASPECTS) {
      const [w, h] = sizes.renderSizeOf({ qualityMode: s.id, aspectRatio: aspect });
      const shotP = { v: 1, kind: "shot", segmentId: "s1_0", prompt: "x", width: w, height: h, seconds: 5, refs: [], guides: [], baseScale: null };
      const ord = orderM.makeOrder({ shot: shotP, files: [], order: { segmentId: "s1_0", seed: 1, steps: 8, engineMode: "h3" }, returnTo: { fp: "a".repeat(32) }, now: Date.now() });
      const got = renderSize(errandM.errandDoc({ orderDoc: ord, from: { fp: "a".repeat(32) }, staged: [], now: 1 }));
      if (got[0] !== w || got[1] !== h) bad.push(`${w}x${h} -> ${got}`);
    }
  }
  ok("every size a friend's order can carry (the card tiers too) renders at that size", !bad.length, bad.join("; "));

  /* ONE LIST EVERYWHERE, checked where it is read. */
  const routes = read("server/mv/routes.js");
  ok("set_brief validates qualityMode and aspectRatio from sizes.js",
    /qualityMode: MV_SIZE_IDS,/.test(routes) && /aspectRatio: MV_ASPECTS,/.test(routes));
  const packet = code(read("server/collab/packet.js"));
  ok("the collab packet keeps no second size table", !/\[480, 864\]|\[1920, 1088\]/.test(packet) && /renderSizeOf/.test(packet));
  const order = code(read("server/collab/order.js"));
  ok("...nor does the order's inversion", !/\[864, 480, "budget"/.test(order) && /MV_SIZES/.test(order));
  const tools = mvTools(async () => ({}), (x) => x);
  const brief = tools.find((t) => t.name === "mv_set_brief").inputSchema.properties;
  ok("mv_set_brief's quality enum is the list",
    JSON.stringify(brief.quality.enum) === JSON.stringify([...sizes.MV_SIZE_IDS]), JSON.stringify(brief.quality.enum));
  ok("...and its description names each size from it",
    sizes.MV_SIZES.every((s) => brief.quality.description.includes(`${s.width}x${s.height}`)));
}

/* ══════════════════════════════════════════ 2. only the shapes that render */
console.log("\n  -- 2. only the shapes renderSize makes --");
{
  ok("the shapes are 16:9 and 9:16", JSON.stringify([...sizes.MV_ASPECTS]) === '["16:9","9:16"]');
  const tools = mvTools(async () => ({}), (x) => x);
  const brief = tools.find((t) => t.name === "mv_set_brief").inputSchema.properties;
  ok("mv_set_brief offers only those two", JSON.stringify(brief.aspect_ratio.enum) === '["16:9","9:16"]');
  const page = read("web/mv.js");
  /* (The Blender sheet's "panel shape" select offers 4:3 for a picture; that
   * is a different control and not a video shape.) */
  ok("the brief's shape select never offers 1:1, 4:3 or 21:9",
    !/\["16:9", "9:16", "1:1", "4:3", "21:9"\]/.test(page) && !/"1:1"|"21:9"/.test(page)
    && /const aspectOpts = aspects\.length\s*\? aspects\.map/.test(page) && /<select id="wfAspect"[\s\S]{0,200}\$\{aspectOpts\}/.test(page));
  ok("...and its shape list comes from the server's cardFit, with no copy kept on the page",
    /fit\?\.sizes\?\.aspects \|\| \[\];/.test(page) && !/\["16:9", "9:16"\]/.test(page));
  const legacy = { qualityMode: "recommended", aspectRatio: "1:1" };
  ok("a project that stored 1:1 renders 16:9, and the brief says so rather than rendering it silently",
    renderSize({ brief: legacy }).join("x") === "1344x768" && /does not render: its clips render 16:9/.test(sizes.aspectNote(legacy) || ""));
  ok("...while 16:9 and 9:16 carry no note", sizes.aspectNote({ aspectRatio: "9:16" }) === null);
}

/* ═══════════════════════════════════════════ 3. the card picks the start */
console.log("\n  -- 3. a new video starts at its card's size, and the cut follows it --");
{
  const card = (mb) => sizes.sizeChoices({ gpu: mb ? { totalMb: mb, vendor: "nvidia" } : null, ram: { totalMb: 32768 } });
  const picks = [null, 4096, 6144, 8188, 12282, 16376].map((mb) => card(mb).cardPick);
  ok("no reading, 4 GB, 6, 8, 12, 16 GB pick nothing, nothing, preview, small, full, full",
    JSON.stringify(picks) === JSON.stringify([null, null, "preview", "small", "recommended", "recommended"]), JSON.stringify(picks));
  const eight = card(8188);
  ok("on 8 GB, full size says the card it needs, from the tier",
    eight.choices.find((c) => c.id === "recommended").fits === false
    && eight.choices.find((c) => c.id === "recommended").line.includes(`${tier("full").minGb} GB`));
  ok("...every size this card does not reach says why in a sentence",
    eight.choices.filter((c) => c.fits === false).every((c) => c.line));
  ok("...and the pick is said in words, with the Models screen's label for the size",
    /Studio's pick for this 8 GB card: Smaller size, 960x544/.test(eight.why), eight.why);
  /* THE REFERENCE PATH (release critic): a music video's scenes render with
   * the cast's pictures on the 8-step reference build, which the lab measured
   * at 960x544 with ONE picture, 314 MiB to spare. The pick quotes that, not
   * the text-only Fast setting, and says a bigger cast was not measured. */
  const { H3_PATHS } = await import("../h3tier.js");
  ok("...and quotes the reference path's own measurement (one picture, 314 MiB to spare), not the Fast setting's",
    eight.why.includes(H3_PATHS.refs.small.evidence) && /314 MiB to spare/.test(eight.why)
    && /more than one picture was not measured/.test(eight.why) && !/TaoMate 3-step/.test(eight.why), eight.why);
  ok("...and on 12 GB full size is said to be PREDICTED for the reference path",
    /PREDICTED/.test(card(12282).why) && /reference path/.test(card(12282).why), card(12282).why);
  ok("...the size notes are the reference path's too",
    sizes.MV_SIZES.find((s) => s.id === "small").note.startsWith(H3_PATHS.refs.small.evidence)
    && sizes.MV_SIZES.find((s) => s.id === "recommended").note.includes(H3_PATHS.refs.full.at16.evidence));
  ok("...and \"an 8 GB card\", not \"a 8 GB card\"",
    card(6144).choices.some((c) => /Needs an 8 GB card/.test(c.line || "")) && !card(6144).choices.some((c) => /\ba 8 GB/.test(c.line || "")));
  ok("an unread card is said, and picks nothing", card(null).tier === "unknown" && /could not be read/.test(card(null).why));
  /* NO CARD AT ALL (release critic): the CPU-only engine. The Video screen
   * said "not offered: this PC has no graphics card" while the music video
   * said the card's memory could not be read. One answer now. */
  const cpu = sizes.sizeChoices({ gpu: null, ram: { totalMb: 32768 }, cpuOnly: true });
  ok("a PC whose engine runs on the CPU: not offered, no pick, and never 'could not be read'",
    cpu.cardPick === null && cpu.offered === false && /not offered on this PC/.test(cpu.why) && /no graphics card/.test(cpu.why)
    && !/could not be read/.test(cpu.why) && !/null GB/.test(cpu.why), cpu.why);
  const routes = read("server/mv/routes.js"), index = read("server/index.js");
  ok("...and the server hands the music video that reading (cpuOnly and the decoder), as the Video screen gets it",
    /cardReading: \(\) => \(\{ gpu: gpuStatus\(\), ram: ramStatus\(\), cpuOnly: cpuOnlyEngine\(\), vaeMeasured: h3VaeMeasured\(\) \}\)/.test(index)
    && /cpuOnly: config\.torchBackend === "cpu"/.test(routes), "index.js createMvRoutes deps / routes.js default reading");
  /* THE PREVIEW ON THE REFERENCE PATH (release critic): the pick quoted the
   * text-only run; the reference path was never run at 832x480. */
  const six = card(6144);
  ok("a 6 GB card's pick says the reference path was not run at 832x480 and what one picture adds",
    six.cardPick === "preview" && /reference path was not run at 832x480/.test(six.why) && /240 MiB/.test(six.why)
    && six.choices.find((c) => c.id === "preview").note === H3_PATHS.refs.preview.evidence, six.why);
  /* The 8 GB pick said "several pictures were never capped" and then "a cast
   * with more than one picture was not measured": once now. */
  ok("the 8 GB pick says the bigger-cast caveat once", (card(8188).why.match(/picture was not measured|pictures were never capped/g) || []).length === 1, card(8188).why);
  ok("...and a PC loading the measured decoder gets no decoder caveat in the pick",
    !sizes.sizeChoices({ gpu: { totalMb: 8188, vendor: "nvidia" }, ram: { totalMb: 32768 }, vaeMeasured: true }).why.includes("video decoder")
    && card(8188).why.includes("video decoder"));
  /* RAM counts: under h3tier's floor H3 is not offered at all, so nothing is
   * Studio's pick, and the sentence says why. */
  const lowRam = sizes.sizeChoices({ gpu: { totalMb: 8188, vendor: "nvidia" }, ram: { totalMb: 8192 } });
  ok("an 8 GB card with 8 GB of RAM gets no pick, and is told H3 is not offered because of the RAM",
    lowRam.cardPick === null && lowRam.offered === false && /not offered on this machine: it has 8 GB of RAM/.test(lowRam.why)
    && !/Studio's pick/.test(lowRam.why) && lowRam.ramWarning === null, lowRam.why);
  const someRam = sizes.sizeChoices({ gpu: { totalMb: 16376, vendor: "nvidia" }, ram: { totalMb: 24576 } });
  ok("under the RAM H3 was measured with, the pick stands and h3tier's RAM warning comes with it",
    someRam.cardPick === "recommended" && typeof someRam.ramWarning === "string" && someRam.ramWarning.length > 20);
  const page = read("web/mv.js");
  ok("...and the brief shows that warning", /fit\?\.sizes\?\.ramWarning \? `<p class="hint warnhint">/.test(page));

  /* THE LONGEST SCENE, per size and engine, and where each number comes from. */
  const cutOf = (q, e) => sizes.sceneCutFor({ qualityMode: q, videoEngine: e });
  ok("the longest scene follows the size: full 8 s, the smaller tiers 5 s, from h3tier",
    cutOf("recommended").maxClipSec === tier("full").maxSeconds
    && cutOf("small").maxClipSec === tier("small").maxSeconds
    && cutOf("preview").maxClipSec === tier("preview").maxSeconds
    && tier("full").maxSeconds === 8 && tier("small").maxSeconds === 5);
  ok("...each says honestly where it comes from: measured, not proven, or not measured",
    /measured up to 8 s at 1344x768/.test(cutOf("recommended").why)
    && /measured at 5 s at 960x544/.test(cutOf("small").why)
    && /not proven at any length/.test(cutOf("preview").why) && !/measured at/.test(cutOf("preview").why)
    && /not measured at 864x480/.test(cutOf("budget").why), JSON.stringify([cutOf("preview").why, cutOf("budget").why]));
  ok("High takes the 5 s its two shipped films were cut to, not full size's 8 s",
    cutOf("high").maxClipSec === 5 && /Bone Waffle films rendered it in 5 s scenes/.test(cutOf("high").why), cutOf("high").why);
  ok("an LTX project keeps the website's 15 s: the H3 lab's lengths are not LTX's",
    cutOf("high", "ltx").maxClipSec === 15 && cutOf("small", "ltx").maxClipSec === 15 && /do not apply to LTX/.test(cutOf("high", "ltx").why));
  ok("hybrid and an unset engine take the H3 length", cutOf("high", "hybrid").maxClipSec === 5 && cutOf("recommended", null).maxClipSec === 8);
  ok("the knob stops calling 15 \"not a taste choice\", prints the server's default and its reason, and keeps no number of its own",
    !/not a taste choice/.test(page) && /const cut = wf\.cardFit\?\.cut \|\| null;/.test(page) && /esc\(cut\.why/.test(page)
    && !/maxClipSec\) \|\| 8/.test(page) && !/hardCeilingSec\) \|\| 15/.test(page));
  ok("...and no longer claims the cut follows a size changed after it",
    !/so it follows the size in the brief/.test(page) && /a size changed later keeps the cut it has until you cut again/.test(page));
}

/* ══════════════════════════════════════════════════ 4. the matched steps */
console.log("\n  -- 4. default steps are the matched count for the files on disk --");
{
  const h3 = config.video.engines.h3;
  const saved = { stepDefaults: h3.stepDefaults, refTurboSteps: h3.refTurboSteps, turboBuilds: h3.turboBuilds };
  const disk = (standard, ref, builds = { three: false, four: standard === 4, eight: standard === 8 }) => {
    h3.stepDefaults = { fast: standard, standard, best: 20 }; h3.refTurboSteps = ref; h3.turboBuilds = builds;
  };
  try {
    /* A PC with no speed-up file at all: config.js falls back to 4 (the
     * Models screen's files), and the label says none is here yet instead of
     * calling 4 "matched to the files on this PC". */
    disk(4, null, { three: false, four: false, eight: false });
    const none = clipsteps.stepChoices();
    ok("with no speed-up file on the PC, \"default\" says none is here yet, not that it is matched",
      none.speedUpOnDisk === false && /None is on this PC yet/.test(none.options[0].label)
      && !/matched to the speed-up files on this PC/.test(none.options[0].label), none.options[0].label);
    disk(4, 4);
    const c4 = clipsteps.stepChoices();
    ok("the step times are plancost's measured rows, with the card they were measured on",
      /4: fast build \(about 2\.6 min per 5 s scene at 1344x768, measured on a 16 GB card\)/.test(c4.options[1].label)
      && /20: full model, no speed-up file \(about 11 min per 5 s scene/.test(c4.options[3].label), JSON.stringify(c4.options));
    ok("a 4-step disk (the Models screen's) runs 4, with and without cast pictures, not a literal 8",
      clipsteps.defaultClipSteps({ refs: false }) === 4 && clipsteps.defaultClipSteps({ refs: true }) === 4);
    const c44 = clipsteps.stepChoices();
    ok("...and \"8\" does not call itself the reference build to use",
      !/the one to use with cast references/.test(c44.options.find((o) => o.value === "8").label)
      && /not on this PC/.test(c44.options.find((o) => o.value === "8").label));
    disk(4, 8);
    ok("with the 8-step reference file alone, a scene with cast runs 8 and one without runs 4",
      clipsteps.defaultClipSteps({ refs: true }) === 8 && clipsteps.defaultClipSteps({ refs: false }) === 4);
    disk(8, 8);
    const c88 = clipsteps.stepChoices();
    ok("with both 8-step files, 8 is the matched reference build and says so",
      /matched reference build, the one to use with cast references/.test(c88.options.find((o) => o.value === "8").label)
      && c88.defaultWithRefs === 8 && c88.defaultWithoutRefs === 8);
    ok("a brief that names a count wins", clipsteps.clipStepsFor({ videoSteps: 20 }, { refs: true }) === 20);
    /* ...except below the reference file's own count with cast pictures: the
     * brief's 3 ran Hex Appeal v1 on the 4-step file at three steps, "burned"
     * (the REWIND CONFIGS, 2026-09-24). The shot says so. */
    ok("a brief's 3 with cast pictures runs the 4-step reference file's own 4, and the shot says so",
      clipsteps.clipStepsFor({ videoSteps: 3 }, { refs: true }) === 4
      && /^With cast pictures this scene runs 4 steps, not the brief's 3/.test(clipsteps.clipStepsNote({ videoSteps: 3 }, { refs: true }) || ""));
    ok("...the text path keeps the brief's 3, unsaid",
      clipsteps.clipStepsFor({ videoSteps: 3 }, { refs: false }) === 3 && clipsteps.clipStepsNote({ videoSteps: 3 }, { refs: false }) === null);

    /* The plan prices "default" as what runs, not as the bare 20-step model. */
    disk(4, 4);
    const doc = { brief: { videoEngine: "h3", castRefs: true, videoSteps: null, qualityMode: "recommended", aspectRatio: "16:9" },
      segments: [], clips: [], boards: [], characters: [], backgrounds: [], props: [] };
    const q = plan.qualityLine(doc);
    ok("the plan's quality line prices default steps as the matched count",
      q.steps === 4 && q.stepsSet === null && q.stepClass === "4" && /4 steps \(the default for the files on this PC\)/.test(q.line), q.line);

    /* ⚠ A FRIEND'S RENDER NEVER TAKES THIS DISK'S COUNT. A borrower with no
     * speed-up files works out 4 at home; the lend must still ask for the
     * usual 8, or a lender with the 8-step reference file would run a scene
     * with cast on its 4-step file. The packet is built for real here. */
    disk(4, null, { three: false, four: false, eight: false });
    const { shotPacket } = await import("../collab/packet.js");
    const lendDoc = { brief: { videoEngine: "h3", videoSteps: null }, song: null,
      segments: [{ id: "s1_0", index: 0, startSec: 0, endSec: 5, durationSec: 5, kind: "instrumental", mode: "generate" }],
      boards: [{ id: "b0", segmentId: "s1_0", segmentIndex: 0, shots: [{ action: "the empty platform at night" }],
        characterRefs: [], backgroundRefs: [], propRefs: [] }],
      characters: [], backgrounds: [], props: [], clips: [] };
    let lent = null, lendErr = null;
    try { lent = await shotPacket({ doc: lendDoc, segmentId: "s1_0", assetsDir: OUT }); } catch (e) { lendErr = e; }
    ok("a lend left on default asks for the usual 8, not the borrower's 4",
      lent?.steps === 8 && clipsteps.defaultClipSteps({ refs: false }) === 4, lendErr?.message || `steps ${lent?.steps}`);
    const lent20 = await shotPacket({ doc: { ...lendDoc, brief: { ...lendDoc.brief, videoSteps: 20 } }, segmentId: "s1_0", assetsDir: OUT }).catch(() => null);
    ok("...and a count the brief names travels as it is", lent20?.steps === 20);
  } finally {
    h3.stepDefaults = saved.stepDefaults; h3.refTurboSteps = saved.refTurboSteps; h3.turboBuilds = saved.turboBuilds;
  }
  const gen = code(read("server/mv/generate.js"));
  ok("generate.js sends the matched count, and no literal 8, for a brief on default",
    /steps: clipStepsFor\(doc\.brief, \{ refs: useRefs \}\)/.test(gen) && !/: 8,\s*$/m.test(gen));
  ok("the lender's packet does not read this disk's count", !/clipStepsFor|clipsteps/.test(code(read("server/collab/packet.js"))));
  const routes = code(read("server/mv/routes.js"));
  ok("every shot a route returns carries the steps generate.js sends (withRenderFacts)",
    (routes.match(/shot: withRenderFacts\(doc, shotRecord\(/g) || []).length === 4 && !/shot: shotRecord\(/.test(routes));
}

/* ═══════════════════════════════════════════════ 5. hybrid and LTX here */
console.log("\n  -- 5. hybrid sends a scene with no cast to LTX only when LTX is here --");
{
  const doc = {
    brief: { videoEngine: "hybrid" },
    segments: [
      { id: "s1_0", index: 0, startSec: 0, endSec: 5, durationSec: 5, kind: "instrumental", mode: "generate" },
      { id: "s1_1", index: 1, startSec: 5, endSec: 10, durationSec: 5, kind: "lyrical", mode: "generate", thesisLine: "la" },
    ],
    boards: [
      { id: "b0", segmentId: "s1_0", segmentIndex: 0, shots: [{ action: "the city" }], characterRefs: [], backgroundRefs: [], propRefs: [] },
      { id: "b1", segmentId: "s1_1", segmentIndex: 1, shots: [{ action: "she sings" }], characterRefs: ["Hex"], backgroundRefs: [], propRefs: [] },
    ],
    characters: [{ id: "c1", name: "Hex", imageFile: "hex.png" }], backgrounds: [], props: [], clips: [],
  };
  try {
    shot.setLtxReady(null);
    ok("with no probe (a script, a test) a cast-less scene still goes to LTX", shot.resolveShot(doc, "s1_0").engine === "ltx");
    shot.setLtxReady(() => false);
    const r = shot.resolveShot(doc, "s1_0");
    ok("without LTX on this PC the cast-less scene renders on H3", r.engine === "h3");
    ok("...and the shot says so", r.warnings.some((w) => w.kind === "ltx-not-here" && /LTX is not on this PC/.test(w.why)));
    ok("a scene with cast is H3 either way", shot.resolveShot(doc, "s1_1").engine === "h3");
    ok("an explicit ltx brief is left alone",
      shot.resolveShot({ ...doc, brief: { videoEngine: "ltx" } }, "s1_0").engine === "ltx");
    ok("one call can say LTX is here", shot.resolveShot(doc, "s1_0", { ltxReady: true }).engine === "ltx");
    const q = plan.qualityLine({ ...doc, brief: { videoEngine: "hybrid", qualityMode: "recommended" } });
    ok("the plan's hybrid line says every scene is on H3 here",
      q.traps.some((t) => t.kind === "hybrid-routes-on-cast" && /not, so every scene renders on H3/.test(t.msg)));
    ok("...and its headline stops saying \"LTX elsewhere\"",
      /^hybrid \(LTX is not on this PC, so H3 for every scene\)/.test(q.line) && !/LTX elsewhere/.test(q.line), q.line);
    ok("...and the shot offers only the engine that is here",
      /Choose h3 in the brief/.test(r.warnings.find((w) => w.kind === "ltx-not-here").why)
      && !/Choose ltx/.test(r.warnings.find((w) => w.kind === "ltx-not-here").why));
    shot.setLtxReady(() => true);
    ok("with LTX here the cast-less scene goes to LTX and nothing is said",
      shot.resolveShot(doc, "s1_0").engine === "ltx" && !shot.resolveShot(doc, "s1_0").warnings.some((w) => w.kind === "ltx-not-here"));
    /* LTX floors each side to 64, so a card tier's 960x544 comes out 960x512
     * on LTX: the plan line says so beside H3's size. */
    const qs = plan.qualityLine({ ...doc, brief: { videoEngine: "hybrid", qualityMode: "small" } });
    ok("with LTX here, hybrid at the smaller size names LTX's own 960x512 beside H3's 960x544",
      /960x544 \(LTX scenes 960x512\)/.test(qs.line), qs.line);
  } finally {
    shot.setLtxReady(null);
  }
  ok("index.js hands the routes LTX's own readiness", /ltxReady: \(\) => videoReady\("ltx"\)\.ready,/.test(read("server/index.js")));
  ok("the shot inspector words the new warning as what it is",
    /w\.kind === "ltx-not-here"[\s\S]{0,120}Renders on H3: LTX is not on this PC/.test(read("web/mv.js")));
}

/* ════════════════════════════════════════════════ the routes, in process */
const art = new EventEmitter();
art.setMaxListeners(50);
art.queue = []; art.current = null; art.done = [];
art.requests = [];
art.request = (job) => {
  const j = { id: `j${art.requests.length + 1}`, kind: job.kind, file: job.file, title: job.title, ...(job.video || {}) };
  art.requests.push(j); art.queue.push(j); art.emit("update");
  return j;
};
art.drop = (file) => {
  const before = art.queue.length;
  art.queue = art.queue.filter((j) => j.file !== file);
  const removed = before - art.queue.length;
  if (removed) art.emit("update");
  return { removed, running: art.current?.file === file };
};
art.status = () => ({ art: { current: art.current && { file: art.current.file, title: art.current.title } } });
const door = {
  cancelled: [],
  running: [],
  async status() { return { running: door.running }; },
  async cancelRun({ runId }) { door.cancelled.push(runId); return { stopped: true }; },
};

let reading = { gpu: { totalMb: 8188, vendor: "nvidia" }, ram: { totalMb: 32768 } };
/* The plan's tool: a clip that waits until the test says how it ended. */
let settleClip = null;
const planTools = {
  mv_generate_clip: { run: () => new Promise((resolve, reject) => { settleClip = { resolve, reject }; }) },
  /* A picture item: nothing from a plan's Stop can cancel it. */
  mv_generate_asset: { run: () => new Promise((resolve, reject) => { settleClip = { resolve, reject }; }) },
};
const { createMvRoutes } = await import("./routes.js");
const mv = createMvRoutes({
  json: (res, code, body) => { res.code = code; res.body = body; },
  readBody: async (req) => req.body,
  art, library: { meta: new Map(), remember: () => {} }, beatsFor: async () => null,
  LRC_DIR: OUT, CLIP_DIR: OUT, IMAGE_DIR: OUT, COVER_DIR: OUT,
  outputDir: () => OUT, clipSeconds: () => null, keepAwake: () => {},
  cardReading: () => reading, engineDoor: door, planTools, stopRetryMs: 5,
});
const post = async (body) => {
  const res = { code: 0, body: null };
  await mv.handle("/api/mv", { method: "POST", headers: {}, body }, res, new URL("http://127.0.0.1/api/mv"));
  return res;
};
const get = async (slug) => {
  const res = { code: 0, body: null };
  await mv.handle(`/api/mv/project/${slug}`, { method: "GET", headers: {} }, res, new URL(`http://127.0.0.1/api/mv/project/${slug}`));
  return res;
};
const writeDoc = (slug, doc) => {
  mkdirSync(path.join(OUT, "mv", slug), { recursive: true });
  writeFileSync(path.join(OUT, "mv", slug, "project.json"), JSON.stringify({ ...doc, slug }, null, 2));
};
const readDoc = (slug) => JSON.parse(readFileSync(path.join(OUT, "mv", slug, "project.json"), "utf8"));

console.log("\n  -- 3b. the routes: create, read, brief, cut --");
{
  const small = await post({ action: "create", title: "Eight Gig" });
  ok("an 8 GB card's new video starts at the smaller size", small.body?.project?.brief?.qualityMode === "small",
    JSON.stringify(small.body).slice(0, 200));
  reading = { gpu: { totalMb: 16376, vendor: "nvidia" }, ram: { totalMb: 32768 } };
  const full = await post({ action: "create", title: "Sixteen Gig" });
  ok("a 16 GB card's starts at full size", full.body?.project?.brief?.qualityMode === "recommended");
  reading = { gpu: null, ram: null };
  const none = await post({ action: "create", title: "No Reading" });
  ok("an unread card keeps the blank brief's full size", none.body?.project?.brief?.qualityMode === "recommended");
  const book = await post({ action: "create", title: "A Book", kind: "audiobook" });
  ok("an audiobook is not given a video size", !book.body?.project?.brief?.qualityMode);

  reading = { gpu: { totalMb: 8188, vendor: "nvidia" }, ram: { totalMb: 32768 } };
  const g = await get(small.body.slug);
  const fit = g.body?.cardFit;
  ok("the project read carries cardFit: the sizes, the pick, the cut and its reason, the steps",
    fit && fit.sizes.cardPick === "small" && fit.size === "small" && fit.cut.maxClipSec === tier("small").maxSeconds
    && /measured at 5 s/.test(fit.cut.why) && fit.cut.hardCeilingSec === 15
    && fit.steps.options.length === 4 && typeof fit.ltxReady === "boolean", JSON.stringify(fit).slice(0, 300));
  /* What LTX makes of each size, from videoSizeFor, the function the graph asks. */
  const { videoSizeFor } = await import("../workflow.js");
  const ltxWrong = fit.sizes.choices.filter((c) => {
    const l = videoSizeFor("ltx", c.width, c.height);
    const differs = l.width !== c.width || l.height !== c.height;
    return differs ? !(c.ltx?.width === l.width && c.ltx?.height === l.height && /LTX renders this size at/.test(c.ltxLine || ""))
      : c.ltx !== null;
  });
  ok("each size says what LTX renders it at, where that differs (960x544 is 960x512 on LTX)",
    ltxWrong.length === 0 && fit.sizes.choices.find((c) => c.id === "small").ltx?.height === 512,
    ltxWrong.map((c) => c.id).join(","));

  const refused = await post({ action: "set_brief", slug: small.body.slug, brief: { aspectRatio: "1:1" } });
  ok("set_brief refuses 1:1, and says why", refused.code >= 400 && /Studio renders only these two shapes/.test(JSON.stringify(refused.body)),
    JSON.stringify(refused.body));
  const huge = await post({ action: "set_brief", slug: small.body.slug, brief: { qualityMode: "huge" } });
  ok("...and a size that is not on the list", huge.code >= 400);
  const setBack = await post({ action: "set_brief", slug: small.body.slug, brief: { qualityMode: "recommended", aspectRatio: "9:16" } });
  ok("a size and a shape from the list save", setBack.code === 200 && readDoc(small.body.slug).brief.qualityMode === "recommended");

  /* The cut: 30 s of instrumental song, no lyric lines. */
  const cutDoc = { ...store.blankProject("Cut", "mv"), totalDurationSec: 30, lyricLines: [], brief: { ...store.blankProject("Cut", "mv").brief, qualityMode: "small" } };
  writeDoc("cut", cutDoc);
  const cut = await post({ action: "segment", slug: "cut" });
  const longest = Math.max(...(cut.body?.segments || []).map((s) => s.durationSec));
  ok("the cut's longest scene follows the size (5 s at the smaller size), not 15 s",
    cut.code === 200 && longest <= tier("small").maxSeconds + 1e-6, `longest ${longest}`);
  const cut8 = await post({ action: "segment", slug: "cut", maxClipSec: 8 });
  ok("...and a number sent wins", Math.max(...cut8.body.segments.map((s) => s.durationSec)) > tier("small").maxSeconds);
  const cut20 = await post({ action: "segment", slug: "cut", maxClipSec: 20 });
  ok("a longest scene past the 15 s ceiling is refused, with the reason, not clamped",
    cut20.code === 400 && /from 1 to 15 seconds/.test(cut20.body?.error || ""), JSON.stringify(cut20.body));

  /* A size changed after a cut made at the default: the brief says so. */
  await post({ action: "segment", slug: "cut" });
  ok("the cut records the longest scene it used", readDoc("cut").cutUsed?.maxClipSec === tier("small").maxSeconds
    && readDoc("cut").cutUsed?.chosen === false, JSON.stringify(readDoc("cut").cutUsed));
  await post({ action: "set_brief", slug: "cut", brief: { qualityMode: "recommended" } });
  const moved = (await get("cut")).body?.cardFit?.cut;
  ok("after the size changes, the brief says the scenes were cut at another default and how to follow it",
    moved?.maxClipSec === 8 && /cut with a 5 s longest scene; with this brief the default is 8 s/.test(moved?.note || ""), moved?.note);
  await post({ action: "segment", slug: "cut", maxClipSec: 6 });
  ok("...but a number the person chose is theirs, and draws no such note", (await get("cut")).body?.cardFit?.cut?.note === null);
  await post({ action: "set_brief", slug: "cut", brief: { videoEngine: "ltx" } });
  ok("an LTX brief's default cut is 15 s", (await get("cut")).body?.cardFit?.cut?.maxClipSec === 15);

  /* The route runs the fill: a real song's lines at the smaller size's 5 s. */
  const song = { ...store.blankProject("Night Train", "mv"), totalDurationSec: TIMED["night-train-girl"].total,
    lyricLines: lyricLinesOf("night-train-girl"), brief: { ...store.blankProject("x", "mv").brief, qualityMode: "small" } };
  writeDoc("nighttrain", song);
  const sung = await post({ action: "segment", slug: "nighttrain" });
  const { uncoveredInside } = await import("./cutfill.js");
  const segs = sung.body?.segments || [];
  ok("the route's cut at 5 s leaves no stretch inside the song without a scene (it lost 8.2 s before)",
    sung.code === 200 && segs.length > 0 && uncoveredInside(segs) === 0 && segs.every((s) => s.durationSec <= 5 + 1e-6),
    `inside ${uncoveredInside(segs)}, longest ${Math.max(...segs.map((s) => s.durationSec))}`);
  ok("...its scene ids are unique and in order", new Set(segs.map((s) => s.id)).size === segs.length
    && segs.every((s, i) => s.index === i));
}

/* ═══════════════════════════════════════════════════════ 6. Stop is now */
console.log("\n  -- 6. the plan card's Stop cancels its clip and says what it reached; the rail's Stop pauses --");
{
  const twoScenes = (title) => ({ ...store.blankProject(title, "mv"), totalDurationSec: 10, lyricLines: [],
    segments: [{ id: "s1_0", index: 0, startSec: 0, endSec: 5, durationSec: 5, kind: "instrumental", mode: "generate" },
               { id: "s1_1", index: 1, startSec: 5, endSec: 10, durationSec: 5, kind: "instrumental", mode: "generate" }] });
  const planOn = (slug, tools, items) => {
    const doc = twoScenes(slug);
    const p = plan.makePlan({ title: "a plan", intent: "test the stop", items }, { tools });
    for (const it of p.items) it.status = "approved";
    p.state = "approved";
    doc.plans = [p];
    writeDoc(slug, doc);
    return p;
  };
  const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
  const reset = () => { art.current = null; art.queue = []; door.running = []; door.cancelled = []; };

  /* A. The clip is on the engine and the next one is waiting: both reached. */
  reset();
  const p = planOn("stopme", ["mv_generate_clip"], [
    { tool: "mv_generate_clip", args: { slug: "stopme", segment: "s1_0" } },
    { tool: "mv_generate_clip", args: { slug: "stopme", segment: "s1_1" } }]);
  const start = await post({ action: "plan_run", slug: "stopme", planId: p.id, op: "start" });
  ok("the plan starts", start.code === 200, JSON.stringify(start.body).slice(0, 200));
  await settle(30);
  art.current = { file: "clip:mv_stopme_s1_0_abc", title: "Stop Me · scene 1" };
  art.queue = [{ file: "clip:mv_stopme_s1_1_def" }, { file: "clip:mv_other_s1_1_x" }];
  door.running = [{ runId: "run-art", via: "art.clip" }, { runId: "run-chat", via: "chat.turn" }];
  const stop = await post({ action: "plan_run", slug: "stopme", planId: p.id, op: "stop" });
  ok("Stop answers that the clip it was rendering is cancelled",
    stop.code === 200 && /The clip it was rendering \(Stop Me · scene 1\) is cancelled on the graphics card/.test(stop.body?.note || ""),
    JSON.stringify(stop.body?.note));
  ok("...on the engine, by the art run's id, and nobody else's run", JSON.stringify(door.cancelled) === '["run-art"]', JSON.stringify(door.cancelled));
  ok("...and this project's waiting clip left the app's queue, another project's did not",
    art.queue.length === 1 && art.queue[0].file === "clip:mv_other_s1_1_x" && /Its clip waiting in the queue is taken off it/.test(stop.body?.note || ""),
    JSON.stringify(art.queue));
  settleClip?.reject(new Error("the engine did not finish (interrupted)"));
  await settle();
  const after = readDoc("stopme").plans[0];
  ok("the plan stays STOPPED, not paused, when its cancelled clip fails", after.state === "cancelled", after.state);
  ok("...the running item says it was stopped while it ran", /stopped while it ran/.test(after.items[0].error || ""), after.items[0].error);
  ok("...the next one was never started", after.items[1].status === "skipped");
  ok("...and the saved note, written AFTER, says what was reached",
    /^Stopped\. Everything still approved is skipped\. The clip it was rendering/.test(after.note || ""), after.note);

  /* B. The clip was taken by the app's queue but never reached the engine. */
  reset();
  const pb = planOn("stopmiss", ["mv_generate_clip"], [{ tool: "mv_generate_clip", args: { slug: "stopmiss", segment: "s1_0" } }]);
  await post({ action: "plan_run", slug: "stopmiss", planId: pb.id, op: "start" });
  await settle(30);
  art.current = { file: "clip:mv_stopmiss_s1_0_abc", title: "Stop Miss · scene 1" };
  const miss = await post({ action: "plan_run", slug: "stopmiss", planId: pb.id, op: "stop" });
  ok("a clip that could not be reached on the engine is never called cancelled",
    /could not be reached in time, so it renders to the end/.test(miss.body?.note || "") && !/is cancelled/.test(miss.body?.note || "")
    && door.cancelled.length === 0, miss.body?.note);
  ok("...and the plan's saved note says the same", /could not be reached in time/.test(readDoc("stopmiss").plans[0].note || ""));
  settleClip?.reject(new Error("done elsewhere"));
  await settle();

  /* C. The plan is drawing a picture: nothing here can cancel that. */
  reset();
  const pc = planOn("stoppic", ["mv_generate_asset", "mv_generate_clip"], [
    { tool: "mv_generate_asset", args: { slug: "stoppic", target: "character", id: "c1" } },
    { tool: "mv_generate_clip", args: { slug: "stoppic", segment: "s1_0" } }]);
  await post({ action: "plan_run", slug: "stoppic", planId: pc.id, op: "start" });
  await settle(30);
  const pic = await post({ action: "plan_run", slug: "stoppic", planId: pc.id, op: "stop" });
  ok("a picture item in flight is said to finish, and nothing after it runs",
    /The item it was running \(mv_generate_asset\) is not a clip, so it finishes; nothing after it runs/.test(pic.body?.note || ""), pic.body?.note);
  settleClip?.resolve({ ok: true });
  await settle();
  ok("...and the clip after it was skipped", readDoc("stoppic").plans[0].items[1].status === "skipped");

  /* D. The rail's Stop: it PAUSES the plan and keeps every approval. */
  reset();
  const pd = planOn("pauseme", ["mv_generate_clip"], [
    { tool: "mv_generate_clip", args: { slug: "pauseme", segment: "s1_0" } },
    { tool: "mv_generate_clip", args: { slug: "pauseme", segment: "s1_1" } }]);
  await post({ action: "plan_run", slug: "pauseme", planId: pd.id, op: "start" });
  await settle(30);
  const paused = await mv.pauseRunningPlans();
  ok("the rail's Stop reaches a running plan", paused.length === 1 && paused[0].slug === "pauseme" && paused[0].paused === true,
    JSON.stringify(paused));
  settleClip?.reject(new Error("interrupted"));
  await settle();
  const dp = readDoc("pauseme").plans[0];
  ok("...and PAUSES it, not cancels it", dp.state === "paused", dp.state);
  ok("...the item whose render it cancelled is approved again, so Run renders it",
    dp.items[0].status === "approved" && !dp.items[0].error && dp.items[1].status === "approved",
    JSON.stringify(dp.items.map((i) => [i.status, i.error])));
  ok("...and the note names the item whose render was cancelled, and says to press Run",
    /Paused by the Stop button, which cancelled the render of \S+ \(mv_generate_clip\)\. It is approved again[\s\S]*press Run to carry on/.test(dp.note || ""), dp.note);
  const resumed = await post({ action: "plan_run", slug: "pauseme", planId: pd.id, op: "resume" });
  await settle(30);
  ok("Run carries on from the stopped item", resumed.code === 200 && readDoc("pauseme").plans[0].items[0].status === "running",
    JSON.stringify(resumed.body).slice(0, 200));
  settleClip?.resolve({ ok: true });
  await settle();
  settleClip?.resolve({ ok: true });
  await settle();
  ok("...to the end", readDoc("pauseme").plans[0].state === "done", readDoc("pauseme").plans[0].state);

  const index = read("server/index.js");
  ok("/api/cancel pauses a plan only when asked (?plans=1), and BEFORE it cancels the art",
    /const plansPaused = url\.searchParams\.get\("plans"\) === "1"\s*\? await mvRoutes\.pauseRunningPlans\(\)[\s\S]{0,120}await jobs\.cancel\(\);/.test(index)
    && /artStopped, plansPaused \}/.test(index));
  const app = read("web/app.js");
  ok("only the rail's Stop asks; the Music screen's Cancel and the Chat's Cancel do not",
    /fetch\("\/api\/cancel\?plans=1", \{ method: "POST" \}\)/.test(app)
    && (app.match(/\/api\/cancel\?plans=1/g) || []).length === 1
    && /\$\("btnCancel"\)\.onclick = \(\) => fetch\("\/api\/cancel", \{ method: "POST" \}\);/.test(app));
  ok("the page stops promising the clip finishes", !/there is no cancel path into the renderer from/.test(read("web/mv.js")));
  const tools = mvTools(async () => ({}), (x) => x);
  ok("mv_plan_run's stop says it cancels the clip in flight, and that the Stop button pauses",
    /cancels this project's clip in flight/.test(tools.find((t) => t.name === "mv_plan_run").description)
    && /Stop button pauses a running plan/.test(tools.find((t) => t.name === "mv_plan_run").description));
}

/* ═════════════════════════════════════════ 7. past the wait, and dropped */
console.log("\n  -- 7. a clip past the wait is filed when it lands; a dropped or refused one is said --");
{
  const doc = { ...store.blankProject("Late", "mv"), totalDurationSec: 10, lyricLines: [],
    segments: [{ id: "s1_0", index: 0, startSec: 0, endSec: 5, durationSec: 5, kind: "instrumental", mode: "generate" }] };
  writeDoc("late", doc);
  art.queue = []; art.current = null; art.done = []; art.requests = [];
  const deps = { art, clipWaitMs: 40 };
  let heard = null;
  const waiting = generateClip(deps, "late", { segmentId: "s1_0", seed: 7 }).catch((e) => { heard = e; });
  await new Promise((r) => setTimeout(r, 120));
  await waiting;
  const job = art.requests[art.requests.length - 1];
  ok("a scene left on default steps is requested at the matched count",
    job && job.steps === clipsteps.defaultClipSteps({ refs: false }), `steps ${job?.steps}`);
  /* The job never left the queue here (art.current is not it), so the words
   * are "still waiting in the queue", not "still rendering". */
  ok("past the wait the caller hears it is still waiting, and where, not that it failed",
    /still waiting in the queue after 2 hours\. It has not been dropped/.test(heard?.message || ""), heard?.message);
  ok("...and the project says so in its Activity",
    readDoc("late").runs.some((r) => r.tool === "clip_late" && /still waiting in the queue/.test(r.outcome)));
  /* Now it lands. */
  art.queue = art.queue.filter((j) => j.file !== job.file);
  art.done.unshift(job);
  art.emit("clip", { file: job.file, clip: "late_scene.mp4", seconds: 9000 });
  await new Promise((r) => setTimeout(r, 80));
  const d = readDoc("late");
  const row = d.clips.find((c) => c.segmentId === "s1_0");
  ok("when it lands it is filed onto the scene, a take like any other",
    row?.clipFile === "late_scene.mp4" && row.status === "done" && row.takes.length === 1, JSON.stringify(row).slice(0, 200));
  ok("...and the Activity line says it landed after the wait",
    d.runs.some((r) => r.tool === "generate_clip" && /landed after the 2-hour wait/.test(r.outcome)));

  /* One that is RENDERING past the wait, and then fails: said as lost. */
  art.queue = []; art.current = null; art.done = []; art.requests = [];
  let heard2 = null;
  const late2 = generateClip(deps, "late", { segmentId: "s1_0", seed: 8 }).catch((e) => { heard2 = e; });
  await new Promise((r) => setTimeout(r, 10));
  const job2 = art.requests[art.requests.length - 1];
  art.queue = art.queue.filter((j) => j.file !== job2.file);
  art.current = job2;
  await late2;
  ok("a clip on the engine past the wait is said to be still rendering",
    /Scene 1 is still rendering after 2 hours/.test(heard2?.message || ""), heard2?.message);
  art.done.unshift(job2);
  art.current = null;
  art.emit("failed", { file: job2.file, error: "out of memory" });
  await new Promise((r) => setTimeout(r, 80));
  const lost = readDoc("late").runs.find((r) => r.tool === "clip_late_lost");
  ok("...and when it then fails, the Activity line is its own: lost, not still waiting",
    lost && /was not filed \(out of memory\)/.test(lost.outcome), JSON.stringify(lost));

  /* A job taken off the queue (the rail's Stop drops waiting art) is noticed at once. */
  art.queue = [{ file: "clip:x" }];
  let dropped = null;
  const t0 = Date.now();
  const w = awaitArt(art, "clip:x", ["clip"], 60_000).catch((e) => { dropped = e; });
  art.drop("clip:x");
  await w;
  ok("a job dropped from the queue ends the wait at once", /taken off the queue/.test(dropped?.message || "") && Date.now() - t0 < 1000,
    dropped?.message);
  /* art.stopAll() empties the queue and says nothing: the poll hears it. */
  art.queue = [{ file: "clip:y" }];
  let cleared = null;
  const w3 = awaitArt(art, "clip:y", ["clip"], 60_000, { pollMs: 20 }).catch((e) => { cleared = e; });
  art.queue = [];
  await w3;
  ok("a queue emptied without a word (art.stopAll) is still noticed", /taken off the queue/.test(cleared?.message || ""), cleared?.message);
  const plain = new EventEmitter();
  let settled = false;
  const w2 = awaitArt(plain, "f", ["clip"], 60_000, { pollMs: 10 }).then(() => { settled = true; }, () => { settled = true; });
  plain.emit("update");
  await new Promise((r) => setTimeout(r, 40));
  ok("...while a stand-in runner with no queue is left to its events", settled === false);
  plain.emit("clip", { file: "f" });
  await w2;

  /* A request art.js refuses is said as refused, not as "Stop was pressed". */
  const refusing = new EventEmitter();
  refusing.queue = []; refusing.current = null; refusing.done = [];
  refusing.lastRefusal = null;
  refusing.request = () => { refusing.lastRefusal = "automatic cover art is switched off in Settings"; return null; };
  let refused = null;
  const t1 = Date.now();
  await generateClip({ art: refusing, clipWaitMs: 60_000 }, "late", { segmentId: "s1_0", seed: 9 }).catch((e) => { refused = e; });
  ok("a refused request fails at once with art.js's own reason",
    /refused this render: automatic cover art is switched off in Settings/.test(refused?.message || "")
    && !/Stop was pressed/.test(refused?.message || "") && Date.now() - t1 < 1000, refused?.message);
  /* ...and a minors refusal keeps its own shape: the sentence, the code, 422
   * (server/safety/refusal.js), never wrapped in "the queue refused". */
  const { REFUSAL: MINORS, CODE: MINORS_CODE } = await import("../safety/refusal.js");
  const minors = new EventEmitter();
  minors.queue = []; minors.current = null; minors.done = [];
  minors.lastRefusal = null;
  minors.refusalFor = (f) => (f === minors.asked ? { error: MINORS, code: MINORS_CODE, hint: null } : null);
  minors.request = (j) => { minors.asked = j.file; minors.lastRefusal = MINORS; return null; };
  let safe = null;
  await generateClip({ art: minors, clipWaitMs: 60_000 }, "late", { segmentId: "s1_0", seed: 10 }).catch((e) => { safe = e; });
  ok("a minors refusal is the sentence with its code and 422, not \"the queue refused this render\"",
    safe?.safety === true && safe.status === 422 && safe.code === MINORS_CODE && safe.message === MINORS, safe?.message);
}

/* ═════════════════════════════════════════ 8. the page: B4 and one id each */
console.log("\n  -- 8. the page: no planning-file stages, and every id once --");
{
  const page = read("web/mv.js");
  const html = read("web/index.html");
  /* (No rendered stage text names MV_FORK_PLAN: server/mv/ui_test.js holds that.) */
  ok("Publish and Complete are off the rail until they are built",
    /const MV_UNBUILT = new Set\(\["publish", "complete"\]\)/.test(page) && /const RAIL = railStages\(\);/.test(page));
  ok("...and a finished project opens on Finish & export",
    /case "publish":\s*case "complete": return renderRoughCut\(\);/.test(page));
  ok("Activity shows plain words, with the tool name in the tooltip",
    /import \{ runWords \} from "\.\/runwords\.js";/.test(page) && /<b title="\$\{esc\(w\.title\)\}">\$\{esc\(w\.text\)\}<\/b>/.test(page));
  const { runWords } = await import(new URL("../../web/runwords.js", import.meta.url).href);
  ok("...a late clip reads as words", runWords({ tool: "clip_late", outcome: "scene 4 is still rendering" }).text === "Still waiting on scene 4");
  ok("...and one that was then lost says so, not \"still waiting\"",
    runWords({ tool: "clip_late_lost", outcome: "scene 4: the render ... was not filed" }).text === "Lost the late render of scene 4"
    && /clip_late_lost: "video"/.test(page));

  /* ONE ID, ONE ELEMENT. Every literal id the page's templates write, and every
   * id in index.html, counted: the Workflow view renders into index.html, so a
   * clash across the two is a clash on the page. An id the page writes in two
   * branches that never render together is named, not skipped silently. */
  const ids = (src) => [...src.matchAll(/\bid="([A-Za-z][\w-]*)"/g)].map((m) => m[1]);
  const pageIds = ids(code(page));
  const count = new Map();
  for (const id of pageIds) count.set(id, (count.get(id) || 0) + 1);
  /* Each of these is written once per branch of an either/or, never twice on
   * one screen: wfToStudio by the Video clips stage and by the Rough cut /
   * Finish stage (renderStage paints one stage), planProposeOpen/Host by the
   * plan card's live and empty branches (renderPlanInner paints one). */
  const EITHER_OR = new Set(["wfToStudio", "planProposeOpen", "planProposeHost"]);
  const twice = [...count].filter(([id, n]) => n > 1 && !EITHER_OR.has(id)).map(([id, n]) => `${id} x${n}`);
  ok(`every id the Workflow page writes is written once (${count.size} ids)`, twice.length === 0, twice.join(", "));
  const htmlIds = new Set(ids(html));
  const clash = [...count.keys()].filter((id) => htmlIds.has(id));
  ok("...and none of them is already an id in index.html", clash.length === 0, clash.join(", "));
  ok("the brief's Song under the clip has its own id", /id="wfSongCond"/.test(page) && /\$\("wfSongCond"\)\.value/.test(page));
  ok("new projects put the song under every scene (Hex Appeal's setup; the REWIND A/B, 2026-09-24)",
    store.blankProject("x", "mv").brief.songConditioning === "always"
    && /\["always", "always: every scene hears the song, so a singing mouth follows the words/.test(page));
  ok("the shot inspector says whether the song is under the clip, and its steps",
    /<span><b>song<\/b> \$\{esc\(sh\.songLine \|\| ""\)\}<\/span>/.test(page) && /<span><b>steps<\/b> \$\{esc\(sh\.steps \?\? "\?"\)\}<\/span>/.test(page));
  ok("a lint issue with a fix is one button, posted as the route action it names",
    /data-lintfix="\$\{idx\}">\$\{esc\(i\.fix\.label\)\}<\/button>/.test(page)
    && /await api\(\{ action: i\.fix\.action, slug: wf\.slug, segmentId: i\.fix\.segmentId, refs: i\.fix\.refs, brief: i\.fix\.brief \}\);/.test(page));
  ok("...and the song picker's handler is the only one on wfSong",
    (page.match(/on\("wfSong", /g) || []).length === 1 && !/\$\("wfSong"\)\.value/.test(page));
  ok("the brief has a size control that saves qualityMode", /id="wfQuality"/.test(page) && /qualityMode: \$\("wfQuality"\)/.test(page));
  ok("Script & direction says plainly how to get a script today, and why Chat cannot",
    /How to get one today:/.test(page) && /Studio's own Chat cannot do it/.test(page) && !/Write it here, or ask the agent to draft it/.test(page));
}

/* ═══════════════════════════════ 9. the cut leaves nothing sung in black */
console.log("\n  -- 9. the cut leaves no sung second without a picture, at any longest scene --");
{
  const { segmentSong } = await import("./segmentation.js");
  const { closeCutHoles, uncoveredInside } = await import("./cutfill.js");
  /* Every sung instant (every 0.1 s inside every line) lies inside a scene. */
  const unsung = (segs, lines) => {
    let miss = 0;
    for (const l of lines) {
      for (let t = l.startSec + 0.05; t < l.endSec; t += 0.1) {
        if (!segs.some((s) => s.startSec <= t + 0.051 && s.endSec >= t - 0.051)) miss += 0.1;
      }
    }
    return Math.round(miss * 10) / 10;
  };
  /* Every longest scene a brief can default to, and the website's own 15. */
  const caps = [...new Set([15, ...sizes.MV_SIZES.map((s) => s.cutSec)])].sort((a, b) => b - a);
  let before = 0;
  for (const name of Object.keys(TIMED)) {
    const lines = lyricLinesOf(name);
    const total = TIMED[name].total;
    const raw15 = segmentSong(lines, total, { maxClipSec: 15 });
    for (const cap of caps) {
      const raw = segmentSong(lines, total, { maxClipSec: cap });
      before += uncoveredInside(raw);
      const segs = closeCutHoles(raw, lines, { maxClipSec: cap });
      const bad = [];
      if (uncoveredInside(segs) !== 0) bad.push(`inside ${uncoveredInside(segs)} s`);
      if (uncoveredInside(segs) > uncoveredInside(raw15)) bad.push("more than the website's 15 s cut");
      if (unsung(segs, lines) !== 0) bad.push(`unsung ${unsung(segs, lines)} s`);
      const over = segs.filter((s) => s.durationSec > cap + 1e-6 || s.endSec - s.startSec > cap + 1e-6);
      if (over.length) bad.push(`${over.length} scenes over ${cap} s`);
      if (!segs.every((s, i) => s.index === i && (i === 0 || s.startSec >= segs[i - 1].startSec))) bad.push("order");
      ok(`${name} at a ${cap} s longest scene: no hole inside the song, every sung second in a scene, none over ${cap} s`,
        bad.length === 0, bad.join("; "));
    }
  }
  ok("...and without the fill those same cuts left song in black (so the lane can fail)", before > 20, `${before} s`);

  /* The split, as a person reads it on the scene. */
  const one = [{ index: 0, text: "a line that goes on and on", startSec: 10, endSec: 21.2 }];
  const split = closeCutHoles(segmentSong(one, 30, { maxClipSec: 5 }), one, { maxClipSec: 5 });
  const parts = split.filter((s) => s.kind === "lyrical");
  ok("an 11.2 s line at a 5 s longest scene becomes three back-to-back scenes that cover all of it",
    parts.length === 3 && parts[0].startSec === 10 && parts[2].endSec === 21.2
    && parts.every((s, i) => i === 0 || s.startSec === parts[i - 1].endSec) && parts.every((s) => s.lineIndices[0] === 0),
    JSON.stringify(parts.map((s) => [s.startSec, s.endSec])));
  ok("...and each says so", parts.every((s, i) => new RegExp(`part ${i + 1} of 3\\. The line "a line that goes on and on" runs longer`).test(s.note)),
    parts[0]?.note);
  const breath = [{ index: 0, text: "one", startSec: 0, endSec: 4.5 }, { index: 1, text: "two", startSec: 5.3, endSec: 9.6 }];
  const held = closeCutHoles(segmentSong(breath, 10, { maxClipSec: 5 }), breath, { maxClipSec: 5 });
  /* 0-4.5 and 5.3-9.6 at 5 s: the first is held 0.5 s to its cap, the second
   * starts the remaining 0.3 s early, and they meet at 5.0. */
  ok("a 0.8 s breath is closed within each scene's cap: the first held to 5.0, the second starting at 5.0",
    held.length === 2 && held[0].endSec === 5 && held[1].startSec === 5 && held[1].endSec === 9.6,
    JSON.stringify(held.map((s) => [s.startSec, s.endSec])));
  ok("...and each scene says what it did", /Held 0\.5s past its last line/.test(held[0].note) && /Starts 0\.3s early/.test(held[1].note),
    held.map((s) => s.note).join(" | "));
  const mcp = mvTools(async () => ({}), (x) => x).find((t) => t.name === "mv_segment").description;
  ok("mv_segment stops promising lyric lines are never split, and names the ceiling as refused past",
    !/lyric lines are never split/.test(mcp) && /A line longer than the longest scene is the one thing split/.test(mcp)
    && /from 1 to 15 s \(refused past that/.test(mcp) && /recommended 8 s, small 5 s, preview 5 s, budget 8 s, high 5 s; an LTX project 15 s/.test(mcp), mcp);
}

/* ── done ────────────────────────────────────────────────────────────────── */
rmSync(OUT, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
process.exit(0);
