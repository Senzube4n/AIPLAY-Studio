/**
 * THE PLAN OBJECT — the guard suite. No server, no python, no GPU.
 *
 * What each section is actually guarding, because a check whose reason is not
 * written down is a check somebody deletes:
 *
 *  · BIT TRANSPARENCY. A document without a plan must behave EXACTLY as it does
 *    today. The migration is one additive line in the shape `previz` and `runs`
 *    already use, and the round trip below proves it changes nothing else — not
 *    a value, not a key, not an order. A feature that quietly rewrites every
 *    project document on read is not additive whatever its diff says.
 *
 *  · NOTHING DERIVABLE IS STORED. The whole design rests on this: a stored
 *    minutes figure is wrong the instant brief.qualityMode changes, and a stored
 *    engine is exactly the disagreement crimeBoard's "one builder" note is
 *    about. So a persisted plan is grepped for a number, and planView's engine
 *    is checked against resolveShot's on the same document.
 *
 *  · APPROVAL BINDS TO ARGUMENTS. Edit an approved item and it falls back; the
 *    runner then does not execute it. This is the one property that makes the
 *    object worth having — an approval that survived a change would launder an
 *    unread decision into a ledger entry saying a human chose.
 *
 *  · THE RUNNER CALLS TOOLS, NOT ROUTES. Checked statically, because it is a
 *    property of the SOURCE: a second execution path would pass every dynamic
 *    test in this file and still be the bug.
 *
 *  · ABSENT IS REPORTED AS ABSENT. An item nothing can price yields null, the
 *    total says so, and the headline never presents an incomplete number as a
 *    complete one.
 *
 * Runs standalone (`node server/mv/plan_test.js`) and in the pre-commit hook.
 * Writes only into a temp directory, which it removes.
 */
import os from "node:os";
import path from "node:path";
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/* The output dir MUST be decided before config.js is first imported, and static
 * imports hoist — so every import below is dynamic. Same discipline as
 * server/daw/arrange_test.js, for the same reason. */
const OUT = path.join(os.tmpdir(), `mv-plan-test-${process.pid}-${Date.now().toString(36)}`);
process.env.AIPLAY_OUTPUT = OUT;
process.env.AIPLAY_APPDATA = path.join(OUT, "appdata");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");

const store = await import("./store.js");
const plan = await import("./plan.js");
const cost = await import("./plancost.js");
const { config } = await import("../config.js");
const planrun = await import("./planrun.js");
const { resolveShot } = await import("./shot.js");
const { renderSize } = await import("./generate.js");
const { videoSizeFor } = await import("../workflow.js");
const { foldOrigin, EVENT_TYPES } = await import("../provenance.js");
const prov = await import("../provenance.js");
/* The dispatch as text, for the two checks that pin a table against the switch
 * it is a table OF. Everything else in this file drives the real functions. */
const ROUTES = readFileSync(path.join(HERE, "routes.js"), "utf8");

const {
  makePlan, planView, healPlan, addPlan, livePlan, findPlan, applyItemOp,
  decideItems, setPolicy, plannableTools, qualityLine, seedItems, spendMeter,
  LIVE_STATES, ITEM_STATES, RESUME_NOTE, PLAN_LIMIT,
} = plan;

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const threw = async (fn, re) => {
  try { await fn(); return false; } catch (err) { return re ? re.test(String(err.message)) : true; }
};

/* ── fixtures ──────────────────────────────────────────────────────────────
 * Hand-built rather than read out of the corpus, for shot_test.js's reason:
 * the corpus changes under this file and a test that read it would fail for
 * reasons that are not bugs. Kaya has a sheet; Marek is declared and has none —
 * he is the silent drop, and he is why scene 2 cannot be approved quietly. */
const TOOLS = [
  "mv_generate_clip", "mv_regen_clip", "mv_generate_asset", "mv_blender_sheet",
  "mv_previz_shot", "mv_shot", "mv_lint", "mv_set_shot", "mv_pick_take",
  "mv_crime_board", "mv_build_timeline", "mv_regen_stale", "mv_previz_moves",
];

const baseDoc = () => ({
  v: 1, kind: "mv", id: "d1", slug: "neon", title: "Neon",
  createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
  song: { file: "neon.flac", durationSeconds: 30 },
  brief: {
    medium: null, tone: null, narrative: null,
    aspectRatio: "16:9", resolution: "1280x720", qualityMode: "high",
    freeText: null, directionSummary: "a night bus film",
    videoEngine: "h3", baseScale: "auto", videoSteps: 4, boardRef: false,
    imageEngine: null, imageCheckpoint: null, storyboardStyle: "sketch",
  },
  lyricLines: [], totalDurationSec: 30, beats: null,
  story: { logline: "a night bus", synopsis: "s", arc: [] },
  styleBible: "Grainy 16mm night", lookBible: null, youtube: null,
  segments: [
    { id: "s1_0", index: 0, startSec: 0, endSec: 5, durationSec: 5, kind: "lyrical", mode: "generate", thesisLine: "the last bus goes" },
    { id: "s1_1", index: 1, startSec: 5, endSec: 10, durationSec: 5, kind: "lyrical", mode: "generate", thesisLine: "he waits" },
    { id: "s1_2", index: 2, startSec: 10, endSec: 15, durationSec: 5, kind: "instrumental", mode: "generate", thesisLine: null },
  ],
  characters: [
    { id: "c1", name: "Kaya", imageFile: "kaya.png", takes: [{ file: "kaya.png", at: 100 }] },
    { id: "c2", name: "Marek", imageFile: null, takes: [] },
  ],
  backgrounds: [{ id: "g1", name: "Underpass", imageFile: "under.png", takes: [{ file: "under.png", at: 100 }] }],
  props: [{ id: "p1", name: "NightBus", imageFile: "bus.png", takes: [{ file: "bus.png", at: 100 }] }],
  boards: [
    { id: "bd1", segmentId: "s1_0", segmentIndex: 0, grade: "cold cyan",
      shots: [{ shotType: "wide", angle: "low", action: "she runs" }],
      characterRefs: ["Kaya"], backgroundRefs: ["Underpass"], propRefs: ["NightBus"],
      refProminence: { Kaya: 0.9, Underpass: 0.4, NightBus: 0.6 },
      imageFile: "board1.png", takes: [] },
    { id: "bd2", segmentId: "s1_1", segmentIndex: 1, grade: "cold cyan",
      shots: [{ shotType: "medium", angle: "eye", action: "he waits" }],
      characterRefs: ["Kaya", "Marek"], backgroundRefs: [], propRefs: [],
      refProminence: { Kaya: 0.9, Marek: 0.8 },
      imageFile: "board2.png", takes: [] },
    { id: "bd3", segmentId: "s1_2", segmentIndex: 2, grade: "cold cyan",
      shots: [{ shotType: "wide", angle: "high", action: "the bus leaves" }],
      characterRefs: [], backgroundRefs: ["Underpass"], propRefs: ["NightBus"],
      refProminence: {}, imageFile: "board3.png", takes: [] },
  ],
  clips: [], previz: [], plans: [], runs: [], timelineProject: null,
});

const items3 = () => ([
  { tool: "mv_generate_clip", args: { slug: "neon", segment: "s1_0" }, why: "board exists, no take" },
  { tool: "mv_generate_clip", args: { slug: "neon", segment: "s1_1" }, why: "board exists, no take" },
  { tool: "mv_generate_clip", args: { slug: "neon", segment: "s1_2" }, why: "board exists, no take" },
]);

const mk = (items = items3(), by = "agent:mcp") =>
  makePlan({ title: "Render the three scenes", intent: "the cut needs footage before it is a cut",
             createdBy: by, items }, { tools: TOOLS, now: 1_700_000_100_000 });

/* ══════════════════════════════════════════════════════════════════════════
 * 1. THE STORE, AND BIT TRANSPARENCY
 * ══════════════════════════════════════════════════════════════════════════ */
console.log("\n  -- the store: a document without a plan behaves exactly as today --");

ok("blankProject carries plans: []", Array.isArray(store.blankProject("x").plans)
  && store.blankProject("x").plans.length === 0);
ok("...on an audiobook too, so migrate() is one line and not two",
  Array.isArray(store.blankProject("x", "audiobook").plans));
ok("DOC_VERSION is NOT bumped — an empty-array default reads both directions",
  store.DOC_VERSION === 1,
  "bumping would make an older build refuse a document it can read perfectly");

{
  /* THREE EXISTING FIXTURE DOCUMENTS, in the three shapes really on disk: a
   * modern mv project, an audiobook, and a legacy doc from before props/previz.
   * Each is written by hand, read through the store, and written back. */
  const fixtures = {
    modern: { ...baseDoc(), slug: "fix-modern" },
    audiobook: { ...store.blankProject("Fix Book", "audiobook"), slug: "fix-book",
                 createdAt: 1, updatedAt: 1 },
    legacy: {
      v: 1, kind: "mv", id: "old", slug: "fix-legacy", title: "Old", createdAt: 1, updatedAt: 1,
      song: { file: "old.flac" }, brief: { aspectRatio: "16:9", qualityMode: "recommended" },
      segments: [], characters: [], backgrounds: [], boards: [],
      clips: [{ id: "cl1", segmentId: "s0", takes: ["old_take.mp4"] }],
      lyricLines: [], totalDurationSec: 0,
    },
  };
  const raws = {};
  for (const [name, doc] of Object.entries(fixtures)) {
    mkdirSync(path.join(OUT, "mv", doc.slug, "assets"), { recursive: true });
    raws[name] = JSON.stringify(doc, null, 2);
    writeFileSync(path.join(OUT, "mv", doc.slug, "project.json"), raws[name], "utf8");
  }

  const back = {};
  for (const [name, doc] of Object.entries(fixtures)) back[name] = await store.readProject(doc.slug);

  ok("every fixture migrates to plans: []",
    Object.values(back).every((d) => Array.isArray(d.plans) && d.plans.length === 0));
  ok("...and planView over a document with no plan is null",
    plan.planView(back.modern, livePlan(back.modern)) === null
    && livePlan(back.legacy) === null);

  /* THE ROUND TRIP. Serialised with the store's own settings, the only textual
   * difference is the keys the migration adds — and for a document already in
   * today's shape there is no difference at all. */
  const reserialise = (d) => JSON.stringify(d, null, 2);
  const added = (before, after) => {
    const b = JSON.parse(before), a = JSON.parse(after);
    return Object.keys(a).filter((k) => !(k in b));
  };
  const lost = (before, after) => {
    const b = JSON.parse(before), a = JSON.parse(after);
    return Object.keys(b).filter((k) => !(k in a) || JSON.stringify(b[k]) !== JSON.stringify(a[k]));
  };

  const modernOut = reserialise(back.modern);
  ok("a document ALREADY in today's shape round-trips BYTE-IDENTICAL",
    modernOut === raws.modern,
    modernOut === raws.modern ? "" : `${modernOut.length} vs ${raws.modern.length} bytes`);

  const bookOut = reserialise(back.audiobook);
  ok("...and so does an audiobook", bookOut === raws.audiobook);

  const legacyOut = reserialise(back.legacy);
  ok("a LEGACY document changes by exactly the additive migrations and nothing else",
    lost(raws.legacy, legacyOut).length === 0,
    `altered or dropped: ${lost(raws.legacy, legacyOut).join(", ")}`);
  ok("...and `plans` is among the keys it gains, alongside the ones migrate already added",
    added(raws.legacy, legacyOut).includes("plans"),
    added(raws.legacy, legacyOut).join(", "));
  ok("...and its clips, takes and every other value survive untouched",
    JSON.stringify(JSON.parse(legacyOut).clips) === JSON.stringify(JSON.parse(raws.legacy).clips));

  /* And a real write back to disk through the store's own writer. */
  await store.updateProject("fix-legacy", (d) => d);
  const onDisk = JSON.parse(await readFile(path.join(OUT, "mv", "fix-legacy", "project.json"), "utf8"));
  ok("a store write-back keeps every legacy value and adds only the migration keys",
    JSON.stringify(onDisk.clips) === JSON.stringify(JSON.parse(raws.legacy).clips)
    && Array.isArray(onDisk.plans) && onDisk.plans.length === 0);
  ok("...and stageOfDoc is untouched — a plan must never move the rail",
    store.stageOfDoc(back.modern) === store.stageOfDoc({ ...back.modern, plans: [mk()] }));
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. NOTHING COSTLY IS STORED
 * ══════════════════════════════════════════════════════════════════════════ */
console.log("\n  -- what a plan does NOT hold --");
{
  const doc = baseDoc();
  const p = mk();
  addPlan(doc, p);
  const view = planView(doc, p);
  const serialised = JSON.stringify(doc.plans);

  ok("the VIEW prices every item", view.items.every((i) => i.estimate && i.estimate.minutes > 0));
  ok("...and the stored plan holds no minutes, no engine, no resolution",
    !/minutes|estimate|"engine"|1920|1088|1344/.test(serialised),
    serialised.slice(0, 240));
  ok("...no warnings either — they are a filter over crimeBoard, not a copy of it",
    !/"warnings"/.test(serialised));
  ok("...and no totals", !/totalMinutes|etaAt|unpriced/.test(serialised));
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. THE ESTIMATOR AGREES WITH THE RENDERER
 * ══════════════════════════════════════════════════════════════════════════ */
console.log("\n  -- the plan and the renderer cannot disagree, because there is one of them --");
{
  const doc = baseDoc();
  const p = mk(); addPlan(doc, p);
  /* The totals are over what will actually RUN, so approve everything before
   * asking whether the headline moves — an unapproved plan honestly totals nil. */
  decideItems(doc, p, { items: "all", status: "approved", acknowledge: true });
  const view = planView(doc, p);

  const agree = view.items.every((i) => {
    const shot = resolveShot(doc, i.args.segment);
    const [w, h] = renderSize(doc);
    const size = videoSizeFor(shot.engine, w, h);
    return i.quality.engine === shot.engine
      && i.quality.width === size.width && i.quality.height === size.height;
  });
  ok("every clip item's engine and size are resolveShot's and videoSizeFor's own answers", agree,
    JSON.stringify(view.items.map((i) => [i.quality.engine, i.quality.width, i.quality.height])));

  /* And they MOVE when the brief moves. A derived number that never changes is
   * indistinguishable from a stored one. */
  const budget = { ...doc, brief: { ...doc.brief, qualityMode: "budget" } };
  const v2 = planView(budget, p);
  ok("...and change when brief.qualityMode does",
    v2.items[0].quality.width !== view.items[0].quality.width
    && v2.totals.totalMinutes < view.totals.totalMinutes,
    `${view.items[0].quality.width} -> ${v2.items[0].quality.width}, `
    + `${view.totals.totalMinutes} -> ${v2.totals.totalMinutes} min`);

  /* THE ENGINE ITSELF MOVES UNDER hybrid, which is the trap DIRECTING §4 names:
   * scene 3 carries no cast, so it is the cheap branch. */
  const hybrid = { ...doc, brief: { ...doc.brief, videoEngine: "hybrid" } };
  const v3 = planView(hybrid, p);
  ok("hybrid routes per scene, and the plan shows which scenes went where",
    v3.items[0].quality.engine === "h3" && v3.items[2].quality.engine === "ltx",
    v3.items.map((i) => `${i.args.segment}:${i.quality.engine}`).join(" "));

  const q = qualityLine(doc);
  ok("the quality line names engine, size, steps and references",
    /H3/.test(q.line) && /1920x1088/.test(q.line) && /4 steps/.test(q.line)
    && /references ON/.test(q.line), q.line);
  ok("...and quotes ~11 min per 5 s clip, the figure both shipped films were made at",
    q.perClipMinutes === 11, String(q.perClipMinutes));
  ok("...and carries DIRECTING §4's above-native trap on the object being approved",
    q.traps.some((t) => t.kind === "above-native"), JSON.stringify(q.traps.map((t) => t.kind)));

  const ltx = qualityLine({ ...doc, brief: { ...doc.brief, videoEngine: "ltx" } });
  ok("an LTX project is told its character sheets are not used at all",
    ltx.traps.some((t) => t.kind === "ltx-drops-references" && /not used/.test(t.msg)));
  /* THE BAND IS JUDGED AGAINST THE FILE THAT LOADS (2026-09-12). With only the
   * 4-step reference build on disk, 8 steps overruns it and is an error; with
   * the 8-step ref2v build named, 8 is a matched setting and 12 is the overrun.
   * Both are pinned by naming the file, so the assertions do not depend on
   * which LoRAs this machine happens to have. */
  const h3cfg = config.video.engines.h3;
  const wasRef = h3cfg.refTurboLora;
  h3cfg.refTurboLora = "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors";
  const band = qualityLine({ ...doc, brief: { ...doc.brief, videoSteps: 8 } });
  ok("with only a 4-step reference build, 8 steps is an ERROR on the card, not a footnote",
    band.traps.some((t) => t.kind === "step-band" && t.level === "error" && /4-step reference/.test(t.msg)),
    JSON.stringify(band.traps.map((t) => t.kind)));
  ok("...and its estimates are marked a floor rather than a figure",
    cost.tableMinutes({ engine: "h3", steps: 8, width: 1920, height: 1088, seconds: 5 }).floor !== null);
  h3cfg.refTurboLora = "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors";
  const matched = qualityLine({ ...doc, brief: { ...doc.brief, videoSteps: 8 } });
  ok("with the 8-step reference build on disk, 8 steps is no trap at all",
    !matched.traps.some((t) => t.kind === "step-band"), JSON.stringify(matched.traps.map((t) => t.kind)));
  ok("...and is costed on the 8-step row rather than the 4-step floor",
    cost.stepClassOf(8, { refs: true }) === "8"
    && cost.tableMinutes({ engine: "h3", steps: 8, width: 1920, height: 1088, seconds: 5 }).floor === null);
  ok("...while 12 steps on that file is still an overrun, and a floor",
    cost.trapBand(12, { refs: true }) && /8-step file/.test(cost.tableMinutes({ engine: "h3", steps: 12, width: 1920, height: 1088, seconds: 5 }).floor));
  ok("...and 5 steps still loads the 4-step file and overruns it",
    cost.trapBand(5, { refs: true }) && cost.stepClassOf(5, { refs: true }) === "4");
  h3cfg.refTurboLora = wasRef;

  /* ── THE LINE IS BUILT OUT OF THE THREE FUNCTIONS, NOT OUT OF LITERALS ────
   *
   * The spec's example reads "H3 · 1920x1088 · 4 steps · references ON — above
   * H3's native 1344x768, ~11 min/clip". What shipped is that shape with the
   * above-native clause moved OUT of the sentence into a trap of its own,
   * carrying a level and a cite — a better home for it, and pinned as a trap
   * three lines above. What is pinned HERE is the half a literal would pass:
   * the numbers in the line are what renderSize, videoSizeFor and resolveShot
   * answer on THIS document, and they move together when the document moves.
   * A hard-coded "1920x1088" satisfies every check above this one. */
  const size = videoSizeFor(q.engineForSize, ...renderSize(doc));
  ok("the quality line's size is videoSizeFor's own answer over renderSize's",
    q.width === size.width && q.height === size.height
    && q.line.includes(`${size.width}x${size.height}`),
    `${q.line} vs ${JSON.stringify(size)}`);
  ok("...in the spec's own shape — engine · size · steps · references — minutes",
    /^H3 · \d+x\d+ · 4 steps · references ON — ~[\d.]+ min per 5 s clip$/.test(q.line), q.line);

  /* MUTATE WHAT renderSize READS and the whole line moves with it — size,
   * minutes, and the trap that only applies above native. */
  const small = { ...doc, brief: { ...doc.brief, qualityMode: "budget" } };
  const qs = qualityLine(small);
  const smallSize = videoSizeFor(qs.engineForSize, ...renderSize(small));
  ok("...change what renderSize reads and every number in the line moves with it",
    qs.width === smallSize.width && qs.width !== q.width
    && qs.line.includes(`${smallSize.width}x${smallSize.height}`)
    && qs.perClipMinutes < q.perClipMinutes
    && !qs.traps.some((t) => t.kind === "above-native"),
    `${q.line}\n          -> ${qs.line}`);

  /* AND THE ENGINE, which resolveShot owns: a line printed from anywhere else
   * would go on saying H3 here. */
  const asLtx = { ...doc, brief: { ...doc.brief, videoEngine: "ltx" } };
  const ql = qualityLine(asLtx);
  ok("...and so does the engine, which resolveShot owns",
    /^LTX · /.test(ql.line) && ql.engine === "ltx"
    && ql.width === videoSizeFor("ltx", ...renderSize(asLtx)).width, ql.line);
  /* The page carries its own copy of this sentence as a FALLBACK (web/mv.js's
   * QUALITY_TRAPS), used when a trap arrives with a kind and no msg. The two
   * are therefore allowed to differ in length — the server's carries the line
   * of code as well — but not in what they SAY, so the page's wording must be
   * exactly how the server's begins. Two sentences that drift is how a person
   * reads one thing on the card and another in the tool's answer. */
  const PAGE_LTX = "references are dropped entirely on LTX — every character sheet "
    + "you built is not used.";
  ok("...carrying the sentence the page prints for an LTX project, word for word",
    ql.traps.some((t) => t.kind === "ltx-drops-references" && t.msg.startsWith(PAGE_LTX))
    && readFileSync(path.join(ROOT, "web", "mv.js"), "utf8").includes(PAGE_LTX),
    JSON.stringify(ql.traps.map((t) => t.msg)));
  ok("...and every item on an LTX plan says the sheets are not carried",
    planView(asLtx, p).items.every((i) => i.quality.useRefs === false),
    JSON.stringify(planView(asLtx, p).items.map((i) => i.quality.useRefs)));
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. UNPRICED IS REPORTED AS UNPRICED
 * ══════════════════════════════════════════════════════════════════════════ */
console.log("\n  -- absent is reported as absent, never as a number --");
{
  const doc = baseDoc();
  const p = mk([
    ...items3(),
    { tool: "mv_build_timeline", args: { slug: "neon" }, why: "assemble" },
    { tool: "mv_previz_moves", args: {}, why: "look at the moves" },
  ].slice(0, 4), "user");
  /* mv_previz_moves is free; add a tool the model genuinely has no row for. */
  p.items.push({ id: "i9", tool: "mv_render_video", args: { slug: "neon" }, why: "bounce",
                 status: "proposed", edits: [], result: null, error: null,
                 startedAt: null, finishedAt: null });
  addPlan(doc, p);
  decideItems(doc, p, { items: "all", status: "approved", acknowledge: true });
  const view = planView(doc, p);

  const unpriced = view.items.filter((i) => i.estimate === null);
  ok("a tool the model cannot price yields estimate: null",
    unpriced.length === 1 && unpriced[0].tool === "mv_render_video",
    view.items.map((i) => `${i.tool}:${i.estimate ? i.estimate.minutes : "null"}`).join(" "));
  ok("...the total counts it as unpriced", view.totals.unpriced === 1);
  ok("...and the headline never presents an incomplete number as complete",
    /^at least .* 1 item unpriced$/.test(view.totals.headline), view.totals.headline);
  ok("a free tool is zero minutes and says so, rather than being unpriced",
    view.items.find((i) => i.tool === "mv_build_timeline").estimate.free === true);

  /* A SCENE THAT WENT AWAY UNDER AN APPROVED ITEM. Re-segmenting orphans a
   * segment id, and the plan must say so rather than throwing on read — the
   * card is exactly what you need when something is wrong with the project. */
  const orphan = mk([{ tool: "mv_generate_clip", args: { slug: "neon", segment: "s9_9" }, why: "gone" }]);
  const doc2 = baseDoc(); addPlan(doc2, orphan);
  const ov = planView(doc2, orphan);
  ok("an item whose scene no longer exists reads back as unpriced, and names why",
    ov.items[0].estimate === null && /No such segment/.test(ov.items[0].quality.error),
    ov.items[0].quality.error);
  ok("...rather than taking the whole card down", ov.totals.unpriced === 0 && ov.totals.items === 1,
    "it is not approved, so it is not in the total — approving it would count it as unpriced");

  /* THE SWEEP IS N CLIPS. Leaving the most expensive thing a plan can hold in
   * the "unpriced" column would put the biggest number where nobody reads it. */
  const stale = baseDoc();
  stale.clips = [
    { id: "cl1", segmentId: "s1_0", clipFile: "a.mp4", status: "stale", takes: [{ clip: "a.mp4", at: 10 }] },
    { id: "cl2", segmentId: "s1_1", clipFile: "b.mp4", status: "stale", takes: [{ clip: "b.mp4", at: 10 }] },
  ];
  const sp = mk([{ tool: "mv_regen_stale", args: { slug: "neon" }, why: "heal it all" }]);
  addPlan(stale, sp);
  decideItems(stale, sp, { items: "all", status: "approved", acknowledge: true });
  const sv = planView(stale, sp);
  ok("a whole-project sweep is priced as N clips, not left unpriced",
    sv.items[0].estimate?.basis === "sweep" && sv.items[0].estimate.clips === 2
    && sv.items[0].estimate.minutes === sv.items[0].estimate.perClipMinutes * 2,
    JSON.stringify(sv.items[0].estimate));
  ok("...and a dry run of it costs nothing, because it renders nothing",
    planView(stale, mk([{ tool: "mv_regen_stale", args: { slug: "neon", dry_run: true }, why: "look" }]))
      .items[0].estimate.free === true);
  ok("etaAt is the one number that matters at bedtime",
    view.totals.etaAt > Date.now(), String(view.totals.etaAt));
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. APPROVAL BINDS TO ARGUMENTS
 * ══════════════════════════════════════════════════════════════════════════ */
console.log("\n  -- an approval is of a SPECIFIC set of arguments --");
{
  const doc = baseDoc();
  const p = mk(); addPlan(doc, p);
  decideItems(doc, p, { items: ["i2"], status: "approved", acknowledge: true });
  ok("i2 is approved", p.items[1].status === "approved");

  const r = applyItemOp(p, { op: "edit", itemId: "i2", args: { seed: 12345 } }, { tools: TOOLS });
  ok("editing its args drops it back to `edited`", p.items[1].status === "edited");
  ok("...loudly, in the response", r.changed.some((c) => /approve it again/.test(c)), r.changed.join(" | "));
  ok("...and the edit is recorded with from and to",
    p.items[1].edits.some((e) => e.field === "args.seed" && e.to === 12345));
  ok("...while the estimate is recomputed under the edit",
    planView(doc, p).items[1].estimate.minutes > 0);

  ok("a running or done item cannot be edited at all",
    (() => { p.items[0].status = "done"; try { applyItemOp(p, { op: "edit", itemId: "i1", args: { seed: 1 } }, { tools: TOOLS }); return false; } catch { return true; } })());
}

/* ══════════════════════════════════════════════════════════════════════════
 * 6-8. THE RUNNER: partial approval, the failure policy, nothing unapproved
 * ══════════════════════════════════════════════════════════════════════════ */
console.log("\n  -- the walk: approved items, in order, one at a time --");

/** A store-backed project plus a stub tool table that records its calls. */
async function bench(name, { items = 5, fail = null } = {}) {
  const slug = `run-${name}`;
  mkdirSync(path.join(OUT, "mv", slug, "assets"), { recursive: true });
  const doc = { ...baseDoc(), slug };
  doc.plans = [];
  writeFileSync(path.join(OUT, "mv", slug, "project.json"), JSON.stringify(doc, null, 2), "utf8");
  const list = [];
  for (let i = 0; i < items; i++) {
    list.push({ tool: "mv_generate_clip", args: { slug, segment: `s1_${i % 3}` }, why: `item ${i + 1}` });
  }
  const p = makePlan({ title: name, intent: "test", createdBy: "user", items: list }, { tools: TOOLS });
  await store.updateProject(slug, (d) => { d.plans = [p]; return d; });

  const calls = [];
  const tools = {
    mv_generate_clip: {
      name: "mv_generate_clip",
      async run(args) {
        calls.push(args);
        if (fail && calls.length === fail) throw new Error("the GPU said no");
        return { clip: { clipFile: `take${calls.length}.mp4` }, takes: [{ clip: `take${calls.length}.mp4` }] };
      },
    },
  };
  const events = [];
  /* A ledger that already holds the `choice` event which approved these items —
   * which is what the route will really have written before Run was pressed.
   * It is here so the JOIN is exercised: a plan_step whose approvedBy is null
   * would leave no contemporaneous record that the render was authorised, which
   * is the whole reason the event type exists. */
  const ledger = [{
    id: "ev_choice_1", actor: "user", type: "choice", t: new Date().toISOString(),
    asset: `mv/${slug}`, data: { surface: "plan", planId: p.id, items: "all", status: "approved" },
  }];
  const runner = planrun.createPlanRunner({
    tools, updateProject: store.updateProject, noteRun: store.noteRun,
    provenance: {
      append: async (_s, e) => { events.push(e); return { id: `e${events.length}` }; },
      read: async (_s, { type }) => ({ events: ledger.filter((e) => !type || e.type === type) }),
    },
  });
  return { slug, planId: p.id, calls, runner, events,
           read: async () => findPlan(await store.readProject(slug), p.id) };
}

{
  const b = await bench("partial");
  await store.updateProject(b.slug, (d) => {
    const p = d.plans[0];
    p.items[0].status = "approved"; p.items[1].status = "skipped";
    p.items[2].status = "approved"; p.items[3].status = "skipped";
    p.items[4].status = "approved";
    p.state = "approved";
    return d;
  });
  const started = await b.runner.start(b.slug, b.planId);
  await started.done;
  const after = await b.read();
  ok("exactly the approved items ran, in array order", b.calls.length === 3,
    `${b.calls.length} calls: ${b.calls.map((c) => c.segment).join(", ")}`);
  ok("...and no skipped item was called",
    after.items.filter((i) => i.status === "skipped").length === 2
    && after.items.filter((i) => i.status === "done").length === 3);
  ok("...the plan finished", after.state === "done" && after.finishedAt > 0);
  ok("...each done item carries what the tool returned",
    after.items[0].result?.clip?.clipFile === "take1.mp4", JSON.stringify(after.items[0].result));
  ok("...and one plan_step event per execution, carrying planId, itemId and the tool",
    b.events.length === 3 && b.events.every((e) => e.type === "plan_step"
      && e.data.planId === b.planId && e.data.itemId && e.data.tool === "mv_generate_clip"),
    JSON.stringify(b.events.map((e) => e.data.itemId)));
  ok("...each naming the asset it produced",
    b.events.every((e) => e.data.asset && /take\d\.mp4/.test(e.data.asset)));
  ok("...and stamped agent:plan, never the human who pressed Run",
    b.events.every((e) => e.actor === "agent:plan"));
  ok("...each naming the `choice` event that authorised it — the join is explicit",
    b.events.every((e) => e.data.approvedBy === "ev_choice_1"),
    JSON.stringify(b.events.map((e) => e.data.approvedBy)));
  ok("...and a fingerprint of the arguments that were REALLY run",
    b.events.every((e) => /^a_[0-9a-f]{8}$/.test(e.data.argsHash)));
  ok("the runner is no longer holding the GPU", !planrun.isRunning(b.slug));
}

{
  const b = await bench("halt", { fail: 2 });
  await store.updateProject(b.slug, (d) => {
    for (const it of d.plans[0].items) it.status = "approved";
    d.plans[0].state = "approved";
    return d;
  });
  await (await b.runner.start(b.slug, b.planId)).done;
  const after = await b.read();
  ok("on a failure with onFailure halt the plan pauses", after.state === "paused", after.state);
  ok("...the failed item is failed and names the error",
    after.items[1].status === "failed" && /GPU said no/.test(after.items[1].error));
  ok("...THE REMAINING APPROVED ITEMS STAY APPROVED — a failure un-approves nothing",
    after.items.slice(2).every((i) => i.status === "approved"),
    after.items.map((i) => i.status).join(", "));
  ok("...and they were NOT called", b.calls.length === 2, String(b.calls.length));
  ok("...the note names the item and the error, and says the rest are still approved",
    /halt|still approved/.test(after.note) && /the GPU said no/.test(after.note), after.note);
  ok("...and a failure is recorded in the activity feed, once",
    (await store.readProject(b.slug)).runs.filter((r) => r.tool === "plan_step").length === 1);

  /* Press Run again — approve-then-start holds on every resumption. */
  await (await b.runner.resume(b.slug, b.planId)).done;
  const done = await b.read();
  ok("pressing Run again carries on from where it stopped",
    b.calls.length === 5 && done.state === "done",
    `${b.calls.length} calls, state ${done.state}`);
  ok("...and the one failure stays on the record", done.items[1].status === "failed");
}

{
  const b = await bench("continue", { fail: 2 });
  await store.updateProject(b.slug, (d) => {
    for (const it of d.plans[0].items) it.status = "approved";
    d.plans[0].policy.onFailure = "continue";
    d.plans[0].state = "approved";
    return d;
  });
  await (await b.runner.start(b.slug, b.planId)).done;
  const after = await b.read();
  ok("onFailure continue steps over the failure and carries on",
    b.calls.length === 5 && after.state === "done", `${b.calls.length} calls, ${after.state}`);
  ok("...with exactly one failure recorded",
    after.items.filter((i) => i.status === "failed").length === 1);
}

{
  const b = await bench("nothing-approved");
  ok("a plan with nothing approved refuses to start",
    await threw(() => b.runner.start(b.slug, b.planId), /Nothing is approved/));
  ok("...naming the fix", await threw(() => b.runner.start(b.slug, b.planId), /mv_plan_decide/));
  ok("...and it called nothing", b.calls.length === 0);
}

{
  /* ONE GPU. A second plan anywhere is refused while one is running. */
  const a = await bench("gpu-a"), c = await bench("gpu-c");
  for (const b of [a, c]) {
    await store.updateProject(b.slug, (d) => { for (const it of d.plans[0].items) it.status = "approved"; return d; });
  }
  /* The gate is built BEFORE the run starts: the walk calls the tool on its own
   * schedule, so a resolver captured from inside the call would not exist yet. */
  let release;
  const gate = new Promise((res) => { release = res; });
  a.runner.tools.mv_generate_clip.run = async () => { await gate; return { clip: { clipFile: "x.mp4" } }; };
  const run = await a.runner.start(a.slug, a.planId);
  ok("a second plan is refused while one is running — there is one GPU",
    await threw(() => c.runner.start(c.slug, c.planId), /one GPU/));
  release();
  await run.done;
  ok("...and once it finishes the next one may start", !planrun.isRunning(a.slug));
}

/* ══════════════════════════════════════════════════════════════════════════
 * 9. THE RUNNER CALLS TOOLS, NOT ROUTES  (static)
 * ══════════════════════════════════════════════════════════════════════════ */
console.log("\n  -- one door: a plan is never a second execution path --");
{
  const src = readFileSync(path.join(HERE, "planrun.js"), "utf8");
  ok("planrun.js resolves the tool table through mvTools()", /import \{ mvTools \} from/.test(src));
  ok("...and executes an item by calling that tool", /tools\[tool\]/.test(src) && /impl\.run\(args\)/.test(src));
  ok("...it dispatches no action of its own", !/case\s+"/.test(src),
    "a plain source match, so it fires on a comment that spells it out too — describe the rule, "
    + "do not quote it");
  ok("...it does not post to /api/mv itself", !/fetch\(\s*["'`]\/api\/mv/.test(src));
  ok("...and holds no literal list of tool names — the whitelist is DERIVED",
    !/\[\s*"(mv|ab)_[a-z_]+"\s*,/.test(src));
  ok("...it never imports the stdio MCP entry point", !/from "\.\.\/mcp\.js"/.test(src));

  const names = plannableTools([...TOOLS, "mv_plan_propose", "mv_create_project", "ab_plan_read"]);
  ok("the whitelist subtracts the plan tools and project creation, and nothing else",
    !names.includes("mv_plan_propose") && !names.includes("ab_plan_read")
    && !names.includes("mv_create_project") && names.length === TOOLS.length,
    names.join(", "));

  /* And the REAL table really contains the tools a plan is written against. */
  const real = planrun.toolTable(async () => ({}));
  const plannable = planrun.plannableFrom(real);
  ok("the real mvTools() table has the five editable tools",
    ["mv_generate_clip", "mv_regen_clip", "mv_generate_asset", "mv_blender_sheet", "mv_previz_shot"]
      .every((n) => plannable.includes(n)));
  ok("...and mv_create_project is not plannable", !plannable.includes("mv_create_project"));
  /* ⚠ THE FINGERPRINT MUST SEE NESTED ARGUMENTS. JSON.stringify's array-replacer
   * form applies its key list at every depth, so `reference: {...}` serialises
   * as `{}` and two different blocked shots hash the same. Sorted recursively
   * instead, and pinned here because the failure is invisible: the ledger would
   * simply record the wrong arguments as identical. */
  const h = planrun.hashArgs;
  ok("the args fingerprint is order-independent",
    h({ a: 1, b: 2 }) === h({ b: 2, a: 1 }));
  ok("...and sees inside a nested object, which the obvious implementation does not",
    h({ reference: { builtin: "dig:artifact" } }) !== h({ reference: { builtin: "room:stack" } }),
    `${h({ reference: { builtin: "dig:artifact" } })} vs ${h({ reference: { builtin: "room:stack" } })}`);

  /* ⚠ AND THIS IS WHY THE SPEND METER IS FED AT THE ROUTE AND NOT HERE. The
   * runner posts every item through this server's own HTTP port, with an
   * `agent:` actor in the header — so a plan's renders are charged by the same
   * line of code that charges a direct MCP call, and stamping the estimate in
   * the runner as well would count one render twice. If this header ever stops
   * being an agent's, plan runs become invisible to the budget. */
  {
    let seenUrl = null, seenHeaders = null;
    const api = planrun.loopbackApi({
      port: 4321,
      fetchImpl: async (u, init) => {
        seenUrl = u; seenHeaders = init.headers;
        return { ok: true, json: async () => ({}) };
      },
    });
    await api("POST", "/api/mv", { action: "lint" }).catch(() => {});
    ok("the runner's transport stamps an agent actor, which is what the meter charges",
      String(seenHeaders?.["x-aiplay-actor"] || "").startsWith("agent:"),
      JSON.stringify(seenHeaders));
    ok("...at this server's own port and route, so the item goes through the door a tool does",
      seenUrl === "http://127.0.0.1:4321/api/mv", String(seenUrl));
  }

  ok("an item naming a tool that does not exist is refused AT PROPOSE TIME",
    (() => { try { makePlan({ title: "t", intent: "i", createdBy: "user",
      items: [{ tool: "mv_make_it_good", args: {} }] }, { tools: plannable }); return false; }
      catch (e) { return /not a tool a plan can run/.test(e.message); } })());
}

/* ══════════════════════════════════════════════════════════════════════════
 * 10. PROVENANCE
 * ══════════════════════════════════════════════════════════════════════════ */
console.log("\n  -- the ledger: a decision is recorded where it was made --");
{
  ok("plan_step is a legal event type", EVENT_TYPES.has("plan_step"));
  const E = (actor, type, data = {}) => ({ actor, type, asset: "mv/neon", data, t: "2026-09-02T00:00:00Z" });
  const withOut = foldOrigin([E("user", "generate", { model: "h3" }), E("user", "edit")]);
  const withIn = foldOrigin([
    E("user", "generate", { model: "h3" }),
    E("agent:plan", "plan_step", { planId: "p1", itemId: "i1", ok: true }),
    E("user", "edit"),
    E("agent:plan", "plan_step", { planId: "p1", itemId: "i2", ok: false }),
  ]);
  ok("...and it changes NO origin class — process evidence, not authorship",
    withIn.class === withOut.class && withIn.editsBy.user === withOut.editsBy.user,
    `${withOut.class} vs ${withIn.class}`);
  ok("...it is counted, so the ledger can still say the run happened",
    withIn.counts.plan_step === 2);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 11. DELEGATION
 * ══════════════════════════════════════════════════════════════════════════ */
console.log("\n  -- a threshold that approves on your behalf is a DELEGATION --");
{
  const p = mk();
  ok("auto_approve_under_minutes with no brief is refused",
    (() => { try { setPolicy(p, { autoApproveUnderMinutes: 5 }); return false; }
      catch (e) { return /brief in their own words/.test(e.message); } })());
  ok("...and nothing was written", p.policy.autoApproveUnderMinutes === null);
  const brief = "keep the night scenes cheap, spend on the two close-ups, wake me if it drifts";
  setPolicy(p, { autoApproveUnderMinutes: 5, delegateBrief: brief, delegateEventId: "ev_1" });
  ok("with a brief it is accepted, and the brief is stored VERBATIM",
    p.policy.delegateBrief === brief, p.policy.delegateBrief);
  ok("...alongside the id of the event that authorised it",
    p.policy.delegateEventId === "ev_1");
  ok("clearing the threshold clears the brief with it",
    (() => { setPolicy(p, { autoApproveUnderMinutes: null });
      return p.policy.delegateBrief === null && p.policy.delegateEventId === null; })());
  /* WHAT THE DELEGATION WOULD ACTUALLY APPROVE. The rule lives here so the
   * route's `judge` event and the flip it records cannot come apart. */
  const doc = baseDoc();
  const dp = mk([
    { tool: "mv_generate_clip", args: { slug: "neon", segment: "s1_0" }, why: "clean, expensive" },
    { tool: "mv_generate_clip", args: { slug: "neon", segment: "s1_1" }, why: "cheap enough but WARNED" },
    { tool: "mv_lint", args: { slug: "neon" }, why: "free" },
    { tool: "mv_lint", args: { slug: "neon" }, why: "unpriced once renamed below" },
  ]);
  /* Renamed AFTER validation, which is the real-world case worth covering: a
   * tool that was legal when the plan was proposed and is not any more. */
  dp.items[3].tool = "mv_render_video";
  addPlan(doc, dp);
  ok("with no delegation set, nothing is auto-approvable", plan.autoApprovable(doc, dp).length === 0);
  setPolicy(dp, { autoApproveUnderMinutes: 5, delegateBrief: "keep it cheap", delegateEventId: "ev_2" });
  const auto = plan.autoApprovable(doc, dp);
  ok("...and with one it takes only the cheap, clean, PRICED items",
    auto.length === 1 && auto[0] === "i3", JSON.stringify(auto));
  ok("...never an unpriced one — absent is not 'under five minutes'", !auto.includes("i4"));
  ok("...and never one carrying a warning a human would have had to acknowledge",
    !auto.includes("i2"), "a delegation is permission to spend, not to skip the speed bump");

  ok("on_failure is a control with two legal values",
    (() => { setPolicy(p, { onFailure: "continue" });
      try { setPolicy(p, { onFailure: "whatever" }); return false; }
      catch { return p.policy.onFailure === "continue"; } })());
}

/* ══════════════════════════════════════════════════════════════════════════
 * 12. RESUME HEALS
 * ══════════════════════════════════════════════════════════════════════════ */
console.log("\n  -- a plan that was running when the process died comes back PAUSED --");
{
  const p = mk();
  p.state = "running";
  p.items[0].status = "done";
  p.items[1].status = "running"; p.items[1].startedAt = 1;
  p.items[2].status = "approved";
  const r = healPlan(p, { live: false });
  ok("it heals to paused", r.healed && p.state === "paused");
  ok("...with batch.js's own sentence", p.note === RESUME_NOTE, p.note);
  ok("...and the item that never finished is approved again, not done",
    p.items[1].status === "approved" && p.items[1].startedAt === null);
  ok("...while the one that DID finish stays done", p.items[0].status === "done");

  const live = mk(); live.state = "running";
  ok("a plan whose runner really is holding the GPU is left alone",
    healPlan(live, { live: true }).healed === false && live.state === "running");
}

/* ══════════════════════════════════════════════════════════════════════════
 * 13. REFUSE RATHER THAN OVERWRITE
 * ══════════════════════════════════════════════════════════════════════════ */
console.log("\n  -- batch.js:152's bug, not repeated --");
{
  const doc = baseDoc();
  const first = mk(); addPlan(doc, first);
  const second = mk();
  let refused = false;
  try { addPlan(doc, second); } catch (e) { refused = /already open/.test(e.message); }
  ok("a second propose over a live plan is REFUSED", refused);
  ok("...and the first plan is untouched",
    doc.plans.length === 1 && doc.plans[0].id === first.id);
  first.state = "done";
  addPlan(doc, second);
  ok("...but a finished plan does not block the next one",
    doc.plans.length === 2 && livePlan(doc).id === second.id);
  ok("the history is newest first and bounded",
    doc.plans[0].id === second.id && PLAN_LIMIT === 10);
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE noSheet SPEED BUMP, and partial approval's shape
 * ══════════════════════════════════════════════════════════════════════════ */
console.log("\n  -- a reference that reaches the render as NOTHING is not approved silently --");
{
  const doc = baseDoc();
  const p = mk(); addPlan(doc, p);
  const view = planView(doc, p);
  const scene2 = view.items[1];
  ok("scene 2 carries a noSheet warning — Marek is declared with no sheet",
    scene2.warnings.some((w) => w.kind === "noSheet" && /Marek/.test(w.msg)),
    JSON.stringify(scene2.warnings.map((w) => w.kind)));
  ok("...taken from crimeBoard's own breaks, not a second lint",
    scene2.warnings.every((w) => w.level && w.kind && w.msg));
  ok("scene 1, whose references all resolve, carries none",
    view.items[0].warnings.length === 0, JSON.stringify(view.items[0].warnings));

  const r = decideItems(doc, p, { items: ["i1", "i2"], status: "approved" });
  ok("approving it without acknowledge is refused, and the refusal NAMES the reference",
    r.rejected.length === 1 && r.rejected[0].id === "i2" && /Marek/.test(r.rejected[0].why),
    JSON.stringify(r.rejected));
  ok("...while the clean item beside it is approved — a refusal is per item",
    p.items[0].status === "approved" && p.items[1].status === "proposed");
  const r2 = decideItems(doc, p, { items: ["i2"], status: "approved", acknowledge: true });
  ok("...and acknowledging it lets it through", p.items[1].status === "approved" && r2.rejected.length === 0);
  ok("the plan's own state follows its items", p.state === "approved");
  decideItems(doc, p, { items: "all", status: "skipped" });
  ok("...and falls back to proposed when nothing is approved", p.state === "proposed");
}

/* ══════════════════════════════════════════════════════════════════════════
 * SEEDS, THE SPEND METER, AND THE CITATIONS
 * ══════════════════════════════════════════════════════════════════════════ */
console.log("\n  -- seeded from what the project already knows --");
{
  const doc = baseDoc();
  const un = seedItems(doc, "unrendered");
  ok("`unrendered` seeds one generate_clip per generate-mode scene with no take",
    un.length === 3 && un.every((i) => i.tool === "mv_generate_clip" && i.why),
    JSON.stringify(un.map((i) => i.args.segment)));
  const ns = seedItems(doc, "nosheet");
  ok("`nosheet` seeds one generate_asset per declared row with no sheet",
    ns.length === 1 && ns[0].args.id === "c2" && /Marek/.test(ns[0].why), JSON.stringify(ns));
  ok("`stale` reuses scanStale — the same scan mv_regen_stale reports from",
    Array.isArray(seedItems(doc, "stale")));
  ok("an unknown seed names the three that exist",
    (() => { try { seedItems(doc, "everything"); return false; }
      catch (e) { return /stale, unrendered, nosheet/.test(e.message); } })());
}

console.log("\n  -- the spend meter ships OFF, with the number visible --");
{
  const doc = baseDoc();
  ok("with no budget set nothing is refused", spendMeter(doc, []).budgetMinutes === null);
  ok("...and with no ledger read the meter is ABSENT, not zero",
    spendMeter(doc, undefined).unattendedMinutesSinceApproval === null);
  const events = [
    { actor: "agent:mcp", type: "generate", t: "2026-09-01T10:00:00Z", data: { estimatedMinutes: 11 } },
    { actor: "user", type: "choice", t: "2026-09-01T11:00:00Z", data: {} },
    { actor: "agent:mcp", type: "generate", t: "2026-09-01T12:00:00Z", data: { estimatedMinutes: 11 } },
    { actor: "agent:mcp", type: "generate", t: "2026-09-01T12:30:00Z", data: { estimatedMinutes: 23 } },
    { actor: "user", type: "generate", t: "2026-09-01T13:00:00Z", data: { estimatedMinutes: 99 } },
  ];
  const m = spendMeter({ ...doc, brief: { ...doc.brief, agentBudgetMinutes: 30 } }, events);
  ok("it counts only AGENT spend, and only since the last human approval",
    m.unattendedMinutesSinceApproval === 34, String(m.unattendedMinutesSinceApproval));
  ok("...and says it is over a budget that is set", m.over === true && m.budgetMinutes === 30);
  ok("...a human's own click never counts against it",
    spendMeter(doc, events).unattendedMinutesSinceApproval === 34);
  ok("the refusal sentence names the fix",
    /mv_plan_propose/.test(plan.budgetRefusal(m)) && /agentBudgetMinutes/.test(plan.budgetRefusal(m)),
    plan.budgetRefusal(m));
}

console.log("\n  -- every number in the cost table names a file that is really here --");
{
  const cites = [...new Set(cost.COST_ROWS.map((r) => r.cite)
    .concat(Object.values(cost.FLAT_TOOLS).map((f) => f.cite))
    .concat([cost.H3_OOM.cite, cost.H3_NATIVE.cite, cost.COST_SPREAD.cite]))];
  const missing = cites.filter((c) => !existsSync(path.join(ROOT, c)));
  ok(`the cost table cites its sources (${cites.length} paths)`, cites.length >= 2, cites.join(", "));
  ok("every cited document is in the repository", missing.length === 0, missing.join(", "));
  ok("every row carries an engine, a step class, a measured size and a wall clock",
    cost.COST_ROWS.every((r) => r.engine && r.stepClass && r.w && r.h && r.seconds && r.wall && r.what));

  /* THE SCALING IS SUPERLINEAR, and this reproduces the document it cites: the
   * faces sweep measured 275.6 s at 1344x768 and 721.4 s at 1920x1088 for the
   * same 56 frames. A linear model quotes 558 s — a 23% under-quote at exactly
   * the expensive corner. */
  const ratio = Math.pow((1920 * 1088) / (1344 * 768), cost.AREA_EXP);
  ok("the area exponent reproduces the sweep in docs/RESOLUTION_FOR_FACES.md",
    Math.abs(ratio - (721.4 / 275.6)) / (721.4 / 275.6) < 0.06,
    `predicted x${ratio.toFixed(2)}, measured x${(721.4 / 275.6).toFixed(2)}`);
  ok("...and a linear model would have under-quoted it by about a quarter",
    (2088960 / 1032192) / (721.4 / 275.6) < 0.8);
  ok("H3's 4-step row at 1920x1088 x 5 s reproduces the 11 minutes both films were made at",
    cost.tableMinutes({ engine: "h3", steps: 4, width: 1920, height: 1088, seconds: 5 }).minutes === 11);
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE MEASURED ESTIMATE IS ABOUT ONE ENGINE, OR IT IS ABOUT NOTHING
 * ══════════════════════════════════════════════════════════════════════════ */
console.log("\n  -- the measured estimate is per ENGINE, and says so when it has none --");
{
  /* felt-hammers, reduced to the shape that produced the finding: a project
   * that rendered its whole first pass on ltx and then had its brief switched
   * to h3. The median of the ltx gaps is a real number about a real render and
   * it is the WRONG number for the render being priced. */
  const nine = (n, engine) => Array.from({ length: n }, (_, i) => ({
    tool: "generate_clip", at: 1_700_000_000_000 + i * 9 * 60e3, engine,
    outcome: `scene ${i + 1} -> c${i}.mp4 (seed 1, ${engine}, 0 refs)`,
  }));
  const ltx = { ...baseDoc(), runs: nine(5, "ltx"),
                brief: { ...baseDoc().brief, videoEngine: "ltx" } };
  const one = [{ tool: "mv_generate_clip", args: { slug: "neon", segment: "s1_0" }, why: "w" }];
  const seen = (doc) => {
    const p = mk(one);
    p.items[0].status = "approved";
    return planView(doc, p).items[0].estimate;
  };
  const onLtx = seen(ltx);
  ok("a project whose renders were all on ltx is priced from its own clock",
    onLtx.basis === "measured" && onLtx.minutes === 9,
    JSON.stringify(onLtx));
  ok("...and the provenance names the engine the measurement is about",
    /ltx renders in this project/.test(onLtx.measuredFrom || ""), onLtx.measuredFrom);

  /* THE BUG, REPRODUCED. The old test was `quality.engine === project.engine`,
   * which is TRUE the moment the brief is switched — h3 === h3 — while the
   * median handed over was still the ltx one. 8.7 minutes quoted against a
   * table that said 50. */
  const h3 = { ...ltx, brief: { ...ltx.brief, videoEngine: "h3" } };
  const onH3 = seen(h3);
  ok("switching the brief to h3 does NOT keep quoting the ltx median",
    onH3.basis !== "measured" && onH3.minutes !== onLtx.minutes,
    JSON.stringify(onH3));
  ok("...it falls back to the cost table and says `basis: table` out loud",
    onH3.basis === "table" && !!onH3.cite, JSON.stringify(onH3));

  /* And once there ARE h3 renders behind it, the measurement comes back — on
   * the h3 gaps alone, with the ltx ones left out of the median. */
  const both = { ...h3, runs: [...nine(5, "ltx"),
    ...Array.from({ length: 3 }, (_, i) => ({ tool: "generate_clip",
      at: 1_700_000_000_000 + (5 * 9 + 40 * (i + 1)) * 60e3, engine: "h3" })) ] };
  const mixed = seen(both);
  ok("...and h3 renders of its own are measured on the h3 gaps, not on all of them",
    mixed.basis === "measured" && mixed.minutes === 40, JSON.stringify(mixed));

  /* The engine off the run entry is new; the whole corpus predates it and
   * carries the word inside the outcome sentence instead. */
  const legacy = { ...ltx, runs: nine(5, "ltx").map(({ engine, ...r }) => r) };
  const old = seen(legacy);
  ok("a document written before runs carried an `engine` field still measures",
    old.basis === "measured" && old.minutes === 9, JSON.stringify(old));
}

console.log("\n  -- an editor that sends every field it knows is not editing all of them --");
{
  const p = mk();
  p.items[0].status = "approved";
  /* `tool: null` is "I did not touch the tool", and it was refused with a
   * message about a name nobody typed. */
  const r = applyItemOp(p, { op: "edit", itemId: p.items[0].id, tool: null,
                             args: { seed: 7 } }, { tools: TOOLS });
  ok("op:edit with tool null is not read as an empty tool name",
    p.items[0].tool === "mv_generate_clip" && p.items[0].args.seed === 7,
    JSON.stringify(r.changed));
  ok("...and a real empty string is still refused, because a plan item must name a tool",
    await threw(() => applyItemOp(p, { op: "edit", itemId: p.items[0].id, tool: "" },
                                  { tools: TOOLS }), /is not a tool a plan can run/));
}

console.log("\n  -- what a request spends is priced by the SAME estimator as the card --");
{
  ok("every action the spend meter prices is one the dispatch really has",
    Object.keys(cost.SPENDING_ACTIONS).every((a) => ROUTES.includes(`case "${a}":`)),
    Object.keys(cost.SPENDING_ACTIONS).filter((a) => !ROUTES.includes(`case "${a}":`)).join(", "));
  ok("...and every tool it names is one this cost table really prices",
    Object.values(cost.SPENDING_ACTIONS).every(({ tool }) =>
      cost.CLIP_TOOLS.has(tool) || tool in cost.FLAT_TOOLS),
    Object.values(cost.SPENDING_ACTIONS).map((r) => r.tool).join(", "));
  const doc = baseDoc();
  const row = cost.SPENDING_ACTIONS.generate_clip;
  const est = plan.estimateOne(doc, { tool: row.tool, args: row.args({ segmentId: "s1_0" }) });
  ok("estimateOne prices one call with no plan in sight",
    est && est.minutes > 0 && est.basis === "table", JSON.stringify(est));
  ok("...and a dry sweep is priced at zero, so a REPORT is never charged as a render",
    plan.estimateOne(doc, { tool: "mv_regen_stale",
      args: cost.SPENDING_ACTIONS.regen_stale.args({ dryRun: true }) }).free === true);
}

console.log("\n  -- a control render is priced, and says where the number came from --");
{
  const doc = baseDoc();
  /* ── THE WHITELIST. plannableTools derives from the LIVE tool names, so the
   * two control tools are plannable the moment they exist — but a plannable tool
   * nothing can price puts the biggest number on the card in the `unpriced`
   * column, which is exactly backwards for the most expensive call on this
   * surface. */
  const names = plannableTools([...TOOLS, "mv_control_render", "mv_pose_extract"]);
  ok("a plan may name mv_control_render and mv_pose_extract",
    names.includes("mv_control_render") && names.includes("mv_pose_extract"));
  ok("...and BOTH are priced rather than landing in the unpriced column",
    [...cost.CONTROL_TOOLS].every((t) => t in cost.FLAT_TOOLS),
    [...cost.CONTROL_TOOLS].join(", "));

  /* ── THE MODE IS THE PRICE. One action, three modes, two orders of magnitude
   * between them. An estimator that ignored the mode would quote half a minute
   * for half an hour or the reverse, and both are how a budget stops meaning
   * anything. */
  const camera = plan.estimateOne(doc, { tool: "mv_control_render", args: { mode: "camera" } });
  const pose = plan.estimateOne(doc, { tool: "mv_control_render", args: { mode: "pose" } });
  const extract = plan.estimateOne(doc, { tool: "mv_pose_extract", args: {} });
  const check = plan.estimateOne(doc, { tool: "mv_control_render", args: { mode: "check" } });
  ok("a camera control render is priced in tens of minutes, from the README's own measurement",
    camera && camera.minutes > 20 && camera.minutes < 60 && camera.renders === 1,
    JSON.stringify(camera));
  ok("...the pose mode is priced as TWO renders and costs more",
    pose && pose.renders === 2 && pose.minutes > camera.minutes, JSON.stringify(pose));
  ok("...an extraction is priced in seconds, not in half-hours",
    extract && extract.minutes < 2 && extract.renders === 1, JSON.stringify(extract));
  ok("...and CHECKING a clip is free, because a check that costs money is a check nobody runs",
    check && check.free === true && check.minutes === 0, JSON.stringify(check));

  /* ── ABSENT IS ABSENT, AND SAID SO. With no run of this kind in the ledger the
   * estimate is the stated constant — a real measurement, but of one night on one
   * rig, not of this install. `unmeasuredHere` is what lets a reader tell those
   * two apart, because `basis` alone cannot: a flat row is flat either way. */
  ok("...and with no ledger behind it, the estimate ADMITS it is a stated constant",
    camera.unmeasuredHere === true && camera.basis === "flat"
    && /stated constant/.test(camera.measuredFrom) && camera.cite === "server/control/README.md",
    JSON.stringify(camera.measuredFrom));

  /* ── AND THE LEDGER WINS WHEN THERE IS ONE. Unlike the clip path there is
   * nothing to scale — VACE builds exactly one size, one step count and one frame
   * count — so a single completed run of that `via` is strictly better than the
   * document's number. */
  const runs = [
    { via: "mv.control", status: "completed", elapsedSec: 2400 },
    { via: "mv.control", status: "completed", elapsedSec: 2700 },
    /* not a render: ComfyUI served an identical graph from its own node cache,
     * measured 258 s -> 0.3 s. Folding it in would quote seconds for half an hour. */
    { via: "mv.control", status: "completed", elapsedSec: 0.3, cached: true },
    /* not a render either: it failed. The door records those too, which is the
     * whole point, and a failure is not a measurement of how long success takes. */
    { via: "mv.control", status: "error", elapsedSec: 12 },
    /* another project entirely, and it still counts: this is a fact about the
     * card, not about the project. */
    { via: "mv.control.pose", status: "completed", elapsedSec: 30 },
  ];
  const measured = {
    [cost.CONTROL_VIA.vace]: cost.controlMeasuredFrom(runs, cost.CONTROL_VIA.vace),
    [cost.CONTROL_VIA.pose]: cost.controlMeasuredFrom(runs, cost.CONTROL_VIA.pose),
  };
  ok("the ledger read drops cache hits and failures, and keeps the two real runs",
    measured[cost.CONTROL_VIA.vace]?.samples === 2
    && measured[cost.CONTROL_VIA.vace]?.minutes === 45,
    JSON.stringify(measured[cost.CONTROL_VIA.vace]));
  const live = plan.estimateOne(doc, { tool: "mv_control_render", args: { mode: "camera" } },
    { controlRuns: measured });
  ok("...and it OUT-MEASURES the constant, saying which of the two it used",
    live.basis === "measured" && live.unmeasuredHere === false && live.minutes === 45
    && /in this install/.test(live.measuredFrom), JSON.stringify(live));
  const livePose = plan.estimateOne(doc, { tool: "mv_control_render", args: { mode: "pose" } },
    { controlRuns: measured });
  ok("...and the pose mode adds the measured extraction to the measured render",
    livePose.minutes === 45.5, JSON.stringify(livePose));

  /* ── AND THE HALF-MEASURED CASE, which is the one that would quietly lie. A
   * ledger with VACE runs and no extractions must not report the pair as
   * measured — half a number from this machine and half from a document is not a
   * measurement of anything. */
  const half = plan.estimateOne(doc,
    { tool: "mv_control_render", args: { mode: "pose" } },
    { controlRuns: { [cost.CONTROL_VIA.vace]: measured[cost.CONTROL_VIA.vace],
                     [cost.CONTROL_VIA.pose]: null } });
  ok("a pose estimate with only half the ledger behind it is NOT called measured",
    half.basis === "flat" && half.unmeasuredHere === true
    && /stated constant/.test(half.measuredFrom) && /in this install/.test(half.measuredFrom),
    JSON.stringify(half.measuredFrom));

  /* ── THE ROUTE TRANSLATION. The meter prices a REQUEST, and a request names an
   * action with the route's own spelling — so the mode has to survive the
   * relabelling or a free check would be charged as a render. */
  const row = cost.SPENDING_ACTIONS.control_render;
  ok("the spend meter carries the MODE through its own vocabulary",
    row.tool === "mv_control_render" && row.args({ mode: "check" }).mode === "check"
    && plan.estimateOne(doc, { tool: row.tool, args: row.args({ mode: "check" }) }).free === true,
    "an agent charged half an hour for measuring a clip stops measuring clips");
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE DISPATCH ITSELF — TWO SURFACES, ONE DOCUMENT
 *
 * Promoted out of the scratch two-surface run, which drove the real stdio MCP
 * process and a real browser body against a real HTTP server on port 4213 and
 * diffed the two documents field by field. What is kept here is everything that
 * did not need the transport: `createMvRoutes` with `json` and `readBody`
 * INJECTED, so the same dispatch, the same validation and the same provenance
 * seam run in process. No server, no port, no child — the promise at the top of
 * this file still holds.
 *
 * What the transport version proved and this one cannot is that the stdio entry
 * stamps its own `agent:` actor. What this one proves, and no static census
 * can, is that the two surfaces produce THE SAME DOCUMENT.
 * ══════════════════════════════════════════════════════════════════════════ */
console.log("\n  -- the dispatch: an agent and a human, one document --");
{
  const { createMvRoutes } = await import("./routes.js");
  const { EventEmitter } = await import("node:events");
  const { copyFileSync, readdirSync } = await import("node:fs");

  /* One picture on disk, which is every file this section needs: stageAsset
   * copies it into the project and names it by its own hash. */
  mkdirSync(path.join(OUT, "images"), { recursive: true });
  writeFileSync(path.join(OUT, "images", "drawn.png"), "a picture, for staging");

  const art = new EventEmitter();
  art.setMaxListeners(50);
  art.request = (job) => {
    setTimeout(() => art.emit("cover", { file: job.file, covers: ["drawn.png"] }), 5);
  };

  const mv = createMvRoutes({
    json: (res, code, body) => { res.code = code; res.body = body; },
    readBody: async (req) => req.body,
    art,
    library: { meta: new Map(), remember: () => {} },
    beatsFor: async () => null,
    LRC_DIR: OUT, CLIP_DIR: OUT, IMAGE_DIR: OUT, COVER_DIR: OUT,
    outputDir: () => OUT, clipSeconds: () => null,
    provenance: prov, keepAwake: () => {},
  });
  /* THE ONLY DIFFERENCE BETWEEN THE TWO SURFACES IS ONE HEADER, which is what a
   * browser and an agent really differ by — provenance.js reads the actor off
   * it and records a non-browser caller claiming "user" as "system", so a test
   * cannot fabricate a human either. */
  const post = async (body, actor = null) => {
    const req = { method: "POST", headers: actor ? { "x-aiplay-actor": actor } : {}, body };
    const res = { code: 0, body: null };
    await mv.handle("/api/mv", req, res, new URL("http://127.0.0.1/api/mv"));
    return res;
  };
  const write = (slug, doc) => {
    mkdirSync(path.join(OUT, "mv", slug), { recursive: true });
    writeFileSync(path.join(OUT, "mv", slug, "project.json"),
                  JSON.stringify({ ...doc, slug }, null, 2));
  };
  const read = (slug) => JSON.parse(readFileSync(path.join(OUT, "mv", slug, "project.json"), "utf8"));
  const ledger = async (slug) =>
    (await prov.read({ dir: path.join(OUT, "mv", slug) }, { asset: "mv/" + slug })).events;
  const spendOf = (events) =>
    events.filter((e) => Number.isFinite(Number(e.data?.[plan.SPEND_FIELD])));

  /* ── the same four writes, twice ─────────────────────────────────────── */
  const boarded = () => {
    const d = baseDoc();
    d.boards[0].takes = [{ file: "board1.png", seed: 1, at: 1000 }];
    d.clips = [{ id: "c_s1_0", segmentId: "s1_0", clipIndex: 0, boardId: "bd1",
                 mode: "generate", clipFile: "c0.mp4", status: "done", takes: [] }];
    return d;
  };
  write("two-agent", boarded());
  write("two-human", boarded());

  const script = (slug) => ([
    { action: "set_brief", slug, brief: { directionSummary: "a night bus film, colder" } },
    { action: "set_shot", slug, segmentId: "s1_0", refs: ["Kaya", "Underpass"] },
    { action: "update_segment", slug, id: "s1_1", mode: "broll" },
    { action: "add_asset", slug, kind: "props", name: "Ticket", description: "a paper stub", role: "support" },
  ]);
  for (const body of script("two-agent")) {
    const r = await post(body, "agent:mcp");
    ok("agent: " + body.action + " lands", r.code === 200, JSON.stringify(r.body).slice(0, 160));
  }
  for (const body of script("two-human")) {
    const r = await post(body);
    ok("human: " + body.action + " lands", r.code === 200, JSON.stringify(r.body).slice(0, 160));
  }

  /* THE DIFF. Ids and timestamps move with the clock, and the run log records
   * WHEN each write happened — everything else must be identical, or the two
   * surfaces are two features that merely look alike. */
  const scrub = (d) => JSON.stringify({
    ...d, slug: null, id: null, createdAt: 0, updatedAt: 0,
    props: (d.props || []).map((x) => ({ ...x, id: null, takes: null })),
    boards: d.boards.map((b) => ({ ...b, updatedAt: 0, refsAt: 0 })),
    runs: (d.runs || []).map((r) => ({ ...r, at: 0 })),
  }, null, 1);
  const A = read("two-agent"), H = read("two-human");
  ok("the agent's document and the human's are identical, field for field",
    scrub(A) === scrub(H),
    (() => {
      const a = JSON.parse(scrub(A)), h = JSON.parse(scrub(H));
      return Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(h[k])).join(", ");
    })());
  ok("...and both really did the work: brief, refs, mode, and a new prop with a VALIDATED role",
    A.brief.directionSummary === "a night bus film, colder"
      && A.boards[0].characterRefs.join() === "Kaya"
      && A.segments[1].mode === "broll"
      && A.props.at(-1).name === "Ticket" && A.props.at(-1).role === "support",
    JSON.stringify({ refs: A.boards[0].characterRefs, mode: A.segments[1].mode }));

  /* ── AND THE FLAG NOTHING COULD ANSWER ───────────────────────────────── */
  ok("attaching a reference marks the board's picture stale, through the route",
    A.boards[0].staleRefs === true && Number.isFinite(A.boards[0].refsAt),
    JSON.stringify({ stale: A.boards[0].staleRefs, refsAt: A.boards[0].refsAt }));

  const drawn = await post({ action: "generate_asset", slug: "two-agent", kind: "boards",
                             id: "bd1", count: 1, refs: false }, "agent:mcp");
  ok("a redraw lands as a TAKE and is not adopted over a picture already chosen",
    drawn.code === 200 && read("two-agent").boards[0].takes.length === 2
      && read("two-agent").boards[0].imageFile === "board1.png",
    JSON.stringify(read("two-agent").boards[0].takes));
  ok("...so the board is still stale, which is TRUE: the new picture is not the one on show",
    read("two-agent").boards[0].staleRefs === true);

  const fresh = read("two-agent").boards[0].takes.find((t) => t.file !== "board1.png").file;
  const picked = await post({ action: "pick_take", slug: "two-agent", kind: "board",
                              id: "bd1", file: fresh }, "agent:mcp");
  ok("ADOPTING the redraw clears staleRefs — the sentence the map prints is answerable at last",
    picked.code === 200 && read("two-agent").boards[0].staleRefs === false
      && read("two-agent").boards[0].imageFile === fresh,
    JSON.stringify(read("two-agent").boards[0]).slice(0, 200));

  /* And it clears only what it can prove. Going BACK to the picture that
   * predates the attach is stale again, because it is. */
  await post({ action: "pick_take", slug: "two-agent", kind: "board", id: "bd1",
               file: "board1.png" }, "agent:mcp");
  ok("...while adopting the OLD picture again does not launder it clean",
    read("two-agent").boards[0].staleRefs === true,
    JSON.stringify(read("two-agent").boards[0].staleRefs));


  /* A SPELLING NOBODY RECOGNISES IS AN ERROR, not a character. */
  const typo = await post({ action: "pick_take", slug: "two-agent", kind: "bord",
                            id: "bd1", file: "board1.png" }, "agent:mcp");
  ok("a mistyped kind is refused rather than silently resolving to the cast list",
    typo.code === 400 && /kind must be/.test(typo.body.error), JSON.stringify(typo.body));
  ok("...and the older spelling still travels: `target` reaches `kind` at the door",
    (await post({ action: "pick_take", slug: "two-agent", target: "board",
                  id: "bd1", file: "board1.png" }, "agent:mcp")).code === 200);

  /* ── §11: THE METER READS A NUMBER, WHICH IT NEVER DID ───────────────── */
  const evA = await ledger("two-agent");
  const spendEvents = spendOf(evA);
  ok("an agent's render writes the field the spend meter reads",
    spendEvents.length >= 1 && spendEvents.every((e) => String(e.actor).startsWith("agent:")),
    JSON.stringify(evA.map((e) => [e.actor, e.type, e.data?.[plan.SPEND_FIELD]])));
  const meter = spendMeter(read("two-agent"), evA);
  ok("...so the meter is NON-ZERO, which is the whole finding",
    meter.unattendedMinutesSinceApproval > 0, JSON.stringify(meter));
  ok("...and only what SPENDS is charged: four free writes wrote nothing",
    spendEvents.length === 1 && Number(spendEvents[0].data[plan.SPEND_FIELD]) > 0,
    JSON.stringify(spendEvents.map((e) => [e.data.tool, e.data[plan.SPEND_FIELD]])));

  const humanDrew = await post({ action: "generate_asset", slug: "two-human", kind: "boards",
                                 id: "bd1", count: 1, refs: false });
  ok("a human's own render is charged to nobody",
    humanDrew.code === 200 && spendOf(await ledger("two-human")).length === 0,
    JSON.stringify((await ledger("two-human")).map((e) => e.actor)));

  /* THE REFUSAL, which had no caller at all. It still ships OFF: this sets the
   * budget on the document by hand, which is what turning it on looks like. */
  const over = read("two-agent");
  over.brief.agentBudgetMinutes = 0.1;
  write("two-agent", over);
  const refused = await post({ action: "generate_asset", slug: "two-agent", kind: "boards",
                               id: "bd1", count: 1, refs: false }, "agent:mcp");
  ok("an agent over the budget is refused, in the sentence plan.js owns",
    refused.code === 400 && /mv_plan_propose/.test(refused.body.error)
      && /agentBudgetMinutes/.test(refused.body.error),
    JSON.stringify(refused.body));
  ok("...the same call from a human is not refused, because a click IS the approval",
    (await post({ action: "generate_asset", slug: "two-human", kind: "boards",
                  id: "bd1", count: 1, refs: false })).code === 200);
  ok("...and the refusal spent nothing: the ledger did not grow",
    spendOf(await ledger("two-agent")).length === spendEvents.length);

  /* ── THE CORPUS, READ-ONLY ──────────────────────────────────────────────
   *
   * The fixtures above are hand-built on purpose (the corpus moves under this
   * file). This is the other half of that argument, promoted out of the scratch
   * bit-transparency run: every project.json really on disk is copied into the
   * temp output dir, read back through the store, and compared — and NO
   * EXISTING VALUE may have changed. SKIPPED, loudly, when the corpus is not on
   * this machine, because a gate that fails on a laptop without a rig is a gate
   * people delete. */
  console.log("\n  -- and the store, over every real document on this machine --");
  const CORPUS = path.join(process.env.AIPLAY_CORPUS
    || "D:/AI/aiplay-studio-bench/ComfyUI/output", "mv");
  const slugs = existsSync(CORPUS)
    ? readdirSync(CORPUS, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(path.join(CORPUS, e.name, "project.json")))
      .map((e) => e.name)
    : [];
  if (!slugs.length) {
    console.log("        skipped: no corpus at " + CORPUS + " (set AIPLAY_CORPUS to point at one)");
  } else {
    const raw = {};
    for (const s of slugs) {
      mkdirSync(path.join(OUT, "mv", "c-" + s), { recursive: true });
      copyFileSync(path.join(CORPUS, s, "project.json"),
                   path.join(OUT, "mv", "c-" + s, "project.json"));
      raw[s] = readFileSync(path.join(OUT, "mv", "c-" + s, "project.json"), "utf8");
    }
    const changed = [];
    const docs = [];
    for (const s of slugs) {
      const back = await store.readProject("c-" + s);
      docs.push(back);
      /* The corpus is not necessarily serialised with the store's own settings,
       * so the honest comparison is key by key against the ORIGINAL object:
       * what is measured is whether READING it changed anything. */
      const before = JSON.parse(raw[s]), after = JSON.parse(JSON.stringify(back));
      const gained = Object.keys(after).filter((k) => !(k in before));
      const altered = Object.keys(before)
        .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      if (gained.length || altered.length) changed.push({ s, gained, altered });
    }
    ok("every real document round-trips with NO existing value altered (" + slugs.length + " documents)",
      changed.every((c) => c.altered.length === 0),
      changed.filter((c) => c.altered.length)
        .map((c) => c.s + ": " + c.altered.join(", ")).join(" | "));
    const ADDITIVE = ["plans", "props", "previz", "runs", "timelineProject", "cast", "slug"];
    ok("...and the only thing any of them GAINS is a migration key that was always additive",
      changed.every((c) => c.gained.every((k) => ADDITIVE.includes(k))),
      changed.flatMap((c) => c.gained).filter((k) => !ADDITIVE.includes(k)).join(", "));
    ok("...and every one reads back with an empty plan list and no live plan",
      docs.every((d) => Array.isArray(d.plans) && d.plans.length === 0 && livePlan(d) === null));
    const railed = (d) => store.stageOfDoc(d) === store.stageOfDoc({ ...d, plans: [
      makePlan({ title: "t", intent: "i", createdBy: "user", items: [] },
               { tools: ["mv_lint"], now: 1 })] });
    ok("...and a plan on any of them moves the stage rail on none",
      docs.every(railed), docs.filter((d) => !railed(d)).map((d) => d.slug).join(", "));
    /* And the card itself has to survive a real document: planView walks
     * crimeBoard and resolveShot over whatever is actually in there. */
    let threwOn = null;
    for (const d of docs) {
      if (d.kind === "audiobook") continue;
      try { planView(d, mk(items3())); }
      catch (err) { threwOn = d.slug + ": " + String(err?.message || err); break; }
    }
    ok("the plan card renders against every real document without throwing (" + docs.length + ")",
      threwOn === null, threwOn || "");

    /* ── AND THE MEASUREMENT IS ATTRIBUTED, ON THE LIBRARY IT WAS FOUND IN.
     *
     * A hand-built fixture cannot exercise this half: every document on this rig
     * predates both the run entry's `engine` field AND the engine inside the
     * outcome sentence, so the attribution has to come off the TAKE the run
     * made. If that lookup ever breaks, every corpus estimate silently reverts
     * to a median blended across engines — which is the defect, back. */
    const { clipRunEngines, measuredMinutesPerClip } = await import("./regen.js");
    const films = docs.filter((d) => d.kind !== "audiobook" && (d.runs || [])
      .some((r) => r.tool === "generate_clip"));
    const unattributed = films.flatMap((d) => clipRunEngines(d)
      .filter((r) => !r.engine).map(() => d.slug));
    ok("every generate_clip entry in the corpus resolves to the engine that made it ("
       + films.reduce((n, d) => n + clipRunEngines(d).length, 0) + " entries)",
      unattributed.length === 0, [...new Set(unattributed)].join(", "));
    ok("...and no document is measured on an engine it never rendered on",
      films.every((d) => ["ltx", "h3"].every((e) => {
        const m = measuredMinutesPerClip(d, e);
        return !m || clipRunEngines(d).filter((r) => r.engine === e).length >= 2;
      })),
      films.map((d) => d.slug).join(", "));
    /* The number in the finding, where the finding was made. felt-hammers
     * rendered its whole first pass on ltx and was then switched to h3; the
     * blended median is the ltx one and there is no h3 measurement at all, so
     * an h3 brief on this project MUST fall back to the table. */
    const fh = films.find((d) => /felt-hammers/.test(d.slug || ""));
    if (fh) {
      ok("felt-hammers still shows the finding: an ltx median and NO h3 renders behind it",
        measuredMinutesPerClip(fh, "ltx") !== null && measuredMinutesPerClip(fh, "h3") === null,
        JSON.stringify([measuredMinutesPerClip(fh, "ltx"), measuredMinutesPerClip(fh, "h3")]));
    } else {
      console.log("        (felt-hammers is not on this machine; the general check above stands)");
    }
  }
}

/* ── done ────────────────────────────────────────────────────────────────── */
if (!process.env.KEEP_PLAN_TEST) rmSync(OUT, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
