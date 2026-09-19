/**
 * The catalogue's own gate: the rules that make it trustworthy rather than
 * merely present.
 *
 * ui_test.js proves the two surfaces read ONE document. This proves the
 * document is honest:
 *
 *   · every screen admits something it cannot do (the About page's own rule —
 *     "an app that only tells you what it does well is advertising" — made
 *     executable, because a welcome screen is where that temptation peaks);
 *   · every number and every licence sentence is READ, not typed, so the day
 *     config.js changes a size or models.js re-reads a clause, this page
 *     changes with it;
 *   · the showcase is real files or an honest absence, never a placeholder.
 *
 * The showcase half runs against whatever this machine actually holds, so it
 * passes on a fresh install (empty panels, each with a reason) and on a full
 * one (every item resolvable to a file). What it cannot do is pass with
 * invented content, which is the only failure mode that matters.
 */
import { stat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalogue, TABS, WELCOME_VERSION, resolveNeeds, screenFor, needState, NEED_STATES } from "./catalogue.js";
import { showcase } from "./showcase.js";
import { config } from "../config.js";
import { CATALOG, MODEL_TO_CAPABILITY, isPictureModel } from "../models.js";
/* The two sources the numeral census checks the prose against. Imported rather
 * than retyped, which is the whole point of the census. */
import { LAYER_TYPES } from "../vfx/store.js";
import { commitSigma } from "../videolab/catalog.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const c = catalogue();

/* ── shape ──────────────────────────────────────────────────────────────── */
ok(`the catalogue builds (version ${WELCOME_VERSION})`, !!c.identity && !!c.tabs?.length);
ok("every tab is in a declared group",
  TABS.every((t) => c.groups.some((g) => g.id === t.group)),
  TABS.filter((t) => !c.groups.some((g) => g.id === t.group)).map((t) => t.id).join(", "));

/* ── THE HONESTY RULE ───────────────────────────────────────────────────── */
const thin = TABS.filter((t) => !t.cant || t.cant.length < 60);
ok(`every screen states a real limit (${TABS.length} screens)`, thin.length === 0,
  thin.map((t) => t.id).join(", ")
    + " — a screen with no `cant`, or a one-liner standing in for one. The About page's "
    + "rule: an app that only tells you what it does well is advertising.");
const noMakes = TABS.filter((t) => !t.makes?.length || !t.lead || !t.start);
ok("every screen says what it makes and where to start", noMakes.length === 0,
  noMakes.map((t) => t.id).join(", "));

/* ── numbers are read, not typed ────────────────────────────────────────── */
/**
 * The failure this guards against is the one the fork's own size-list fix was
 * about: a list that promises a size the renderer will not produce. If the
 * catalogue's sizes are the config's sizes by identity, it cannot happen.
 */
for (const [id, eng] of Object.entries(config.video.engines)) {
  const mine = c.video.engines.find((e) => e.id === id);
  ok(`${id}: the size ladder is config's, not a copy`,
    !!mine && mine.sizes.length === eng.sizes.length
      && mine.sizes.every((s, i) => s.w === eng.sizes[i].w && s.h === eng.sizes[i].h
        && s.label === eng.sizes[i].label),
    "a size list retyped here is a size list that will promise something the engine will not make");
  ok(`${id}: native size comes from config`,
    mine?.native === `${eng.width} x ${eng.height}`);
}
ok("the turbo threshold is read from config, not asserted",
  c.video.quality.some((q) => q.body.includes(String(config.video.engines.h3.turboMaxSteps))),
  "the step count at which the distillation stops applying must come from config.video.engines.h3.turboMaxSteps");
ok("every measured claim carries where it was measured",
  c.video.quality.every((q) => q.source && q.source.length > 20),
  "a number on a welcome screen with no provenance is exactly what this app refuses elsewhere");

/* ── THE NUMERAL CENSUS ─────────────────────────────────────────────────────
 *
 * WHY THIS BLOCK EXISTS. The VFX paragraph said "ten kinds of layer" while
 * vfx/store.js declared eleven — an audio layer had been added and the sentence
 * had no idea. A count written as a WORD is invisible to every gate this repo
 * has: it is not a size, not a licence, not a path, and it reads perfectly.
 *
 * So every numeral in this file's prose is now one of two things, and this
 * block is the list of which:
 *
 *   DERIVED — interpolated from the source of truth, and the assertion here
 *     recomputes it independently (its own word list, its own filter) so a
 *     mistake in the helper cannot agree with itself.
 *   PINNED — it lives in a COMMENT, or in a file this module cannot import
 *     without starting a server, so the assertion reads the source and fails
 *     when the two drift.
 *
 * The measured figures are the third kind, and they get the strictest check
 * available: the document they cite must actually contain them. A citation to a
 * file that merely EXISTS is how a fabricated "2.7x" survived in this repo for
 * a day — the fix is to read the number out of the document, not the filename.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const SRC = await readFile(path.join(HERE, "catalogue.js"), "utf8");
/* This test's own word list, deliberately not imported from the module it is
 * checking. Two independent spellings of "eleven" is the whole idea. */
const W = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
           "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
           "seventeen", "eighteen", "nineteen", "twenty", "twenty-one", "twenty-two", "twenty-three"];

/* DERIVED — the compositor's vocabulary, the bug this block was written for. */
const vfxLead = TABS.find((t) => t.id === "vfx").lead;
ok(`"${W[LAYER_TYPES.length]} kinds of layer" is counted from vfx/store.js LAYER_TYPES (${LAYER_TYPES.length})`,
  vfxLead.includes(`${W[LAYER_TYPES.length]} kinds of layer`),
  `the VFX paragraph says: ${/(\w+) kinds of layer/.exec(vfxLead)?.[1]} — it must not be typed`);

/* AND THE SECOND COPY OF THAT SENTENCE. The About page in web/index.html says
 * it too — catalogue.js's own header says the tab prose is "lifted in substance
 * from the About page's honesty list" — and it was wrong in BOTH places. The
 * page cannot interpolate, so the count is pinned here rather than left to be
 * found by a reader who counts the layer menu. */
const aboutSays = /After-Effects-class compositor: (\w+) kinds of\s+layer/
  .exec(await readFile(path.join(REPO, "web", "index.html"), "utf8"))?.[1];
ok(`the About page says "${aboutSays}" too, and that is still ${W[LAYER_TYPES.length]}`,
  aboutSays === W[LAYER_TYPES.length],
  "web/index.html and this catalogue are two copies of one sentence; they may not disagree");

/* DERIVED — how many engines the Video screen claims. */
const engineCount = Object.keys(config.video.engines).length;
ok(`"${W[engineCount]} engines are supported" is counted from config.video.engines (${engineCount})`,
  TABS.find((t) => t.id === "video").lead
    .includes(`${W[engineCount][0].toUpperCase()}${W[engineCount].slice(1)} engines are supported`));

/* DERIVED — how many screens sit under the first heading. */
const makeCount = TABS.filter((t) => t.group === "make").length;
ok(`"The ${W[makeCount]} screens" is counted from TABS (${makeCount} in the make group)`,
  c.groups.find((g) => g.id === "make").note.includes(`The ${W[makeCount]} screens`));

/* DERIVED — LTX's "two passes", counted from the sigma strings it declares. */
for (const [id, eng] of Object.entries(config.video.engines)) {
  if (eng.steps) continue;
  const passes = Object.keys(eng).filter((k) => /^sigmas/.test(k)).length;
  ok(`${id}: "${W[passes]} passes" is counted from its sigma strings (${passes})`,
    c.video.engines.find((e) => e.id === id).stepsNote.includes(`${W[passes]} passes`),
    "an engine that grows a third schedule must not be described by a sentence that says two");
}

/* DERIVED — the sigma figures, which are arithmetic and not a remembered table.
 * Recomputed here from the same function the Video lab's panel uses, at the
 * shift config.js actually ships. */
const h3cfg = config.video.engines.h3;
const turboBody = c.video.quality.find((q) => /distillation is applied/.test(q.body))?.body ?? "";
for (const n of [4, 8, h3cfg.steps]) {
  const s = commitSigma(n, h3cfg.shiftVideo)?.toFixed(3);
  ok(`the commit point at ${n} steps is computed, not quoted (sigma ${s})`,
    turboBody.includes(s),
    "server/videolab/catalog.js commitSigma is the one implementation; this page must show its answer");
}
ok(`the sigma shift in the prose is config's (${h3cfg.shiftVideo})`,
  turboBody.includes(`sigma shift of ${h3cfg.shiftVideo}`));
ok("the native size in the prose is config's",
  c.video.quality[0].body.includes(`${h3cfg.label}'s native ${h3cfg.width}x${h3cfg.height}`));

/* PINNED — the export formats live in server/index.js, which cannot be
 * imported here (importing it starts a server), so the count is read out of the
 * literal instead. Distinct EXTENSIONS, because jpeg and jpg are one format. */
const indexSrc = await readFile(path.join(REPO, "server", "index.js"), "utf8");
const fmtBlock = /const FORMATS = \{([^}]+)\}/.exec(indexSrc)?.[1] ?? "";
const fmtCount = new Set([...fmtBlock.matchAll(/"([a-z]+)"/g)].map((m) => m[1])).size;
ok(`"${W[fmtCount]} formats" matches server/index.js FORMATS (${fmtCount} distinct extensions)`,
  fmtCount > 0 && TABS.find((t) => t.id === "images").lead.includes(`${W[fmtCount]} formats`),
  `the image export map produces ${fmtCount} extensions: ${[...new Set([...fmtBlock.matchAll(/"([a-z]+)"/g)].map((m) => m[1]))].join(", ")}`);

/* PINNED — two counts that live in a comment, where nothing can interpolate
 * them. They are editorial ("sixteen paragraphs in a row is a wall"), and a
 * comment that miscounts the thing it is justifying is still wrong. */
ok(`the comment's "${W[TABS.length]} paragraphs" matches TABS (${TABS.length})`,
  SRC.includes(`${W[TABS.length]} paragraphs`),
  "the tab count moved and the paragraph justifying the headings did not");
ok(`the comment's "${W[c.groups.length]} headings" matches GROUPS (${c.groups.length})`,
  SRC.includes(`${W[c.groups.length]} headings`));

/* THE MEASURED FIGURES — each one must be IN the document it cites, not merely
 * beside its filename. Normalised for the multiplication sign, which the
 * markdown writes as × and the prose writes as x. */
const FACES = (await readFile(path.join(REPO, "docs", "RESOLUTION_FOR_FACES.md"), "utf8"))
  .replace(/×/g, "x");
const qualityText = c.video.quality.map((q) => `${q.headline} ${q.body} ${q.source}`).join(" ");
const MEASURED = [
  ["58 px of face at native", /58 px/],
  ["84 px at the knee", /\| \*\*84\*\*|84 px/],
  ["96 px as the lip-sync bar", /96 px/],
  ["22% more wall clock at 1920x1088", /22% more wall clock/],
  ["36% more than native at 1536x864", /36% more than native/],
  ["5.73% of frame height", /5\.73%/],
  ["7.55% at native", /7\.55%/],
  ["591 s at 1792x1008", /591\.\d+ s/],
  ["721 s at 1920x1088", /721\.\d+ s/],
  ["a 28% band across the legal clip lengths", /28% band/],
  ["a 2.7x cost span over the size ladder", /2\.7x range/],
  ["56 to 209 frames", /56 to 209 frames/],
];
for (const [claim, re] of MEASURED) {
  const figure = /([\d.]+)/.exec(claim)[1];
  ok(`"${claim}" is in the document it cites, and on the page`,
    re.test(FACES) && qualityText.includes(figure),
    `docs/RESOLUTION_FOR_FACES.md: ${re.test(FACES) ? "has it" : "DOES NOT HAVE IT"}; `
      + `the page: ${qualityText.includes(figure) ? "shows it" : "does not show it"}`);
}
/* The one claim on the page that is ROUNDED rather than quoted. The document
 * measures 16.1–20.6 GPU-hours; the page says "16 to 21". So the check is not
 * "does this string appear" — it is arithmetic: the envelope must CONTAIN the
 * measurement and must not be widened past the nearest whole hour, which is
 * how a real span quietly becomes a rhetorical one. */
const band = /([\d.]+)[–-]([\d.]+) GPU-hours/.exec(FACES);
const claimed = /(\d+) to (\d+) GPU-hours/.exec(qualityText);
const [lo, hi] = [Number(band?.[1]), Number(band?.[2])];
ok(`"${claimed?.[0]}" is the document's own ${lo}–${hi}, rounded to whole hours`,
  !!band && !!claimed
    && Number(claimed[1]) === Math.floor(lo) && Number(claimed[2]) === Math.ceil(hi),
  `docs/RESOLUTION_FOR_FACES.md measures ${lo}–${hi} GPU-hours; the page claims `
    + `${claimed?.[1]} to ${claimed?.[2]} — an envelope must contain the measurement and stop there`);

/* ── EVERY NEED RESOLVES ────────────────────────────────────────────────────
 *
 * The owner asked each screen to show "what you need for models or other
 * dependencies", and the failure mode of a dependency list is not that it looks
 * wrong — it is that it names something that no longer exists and reads
 * perfectly while doing it. A capability renamed in models.js, an engine key
 * dropped from config.js, a python module the probe stopped checking: every one
 * of those leaves a row on a panel that can never turn green, and nothing else
 * in this repo would notice.
 *
 * So: every need on every screen must resolve, HERE, with no server and no
 * disk. Models and engines against the CATALOG; packages against the set
 * server/index.js actually probes, read out of its source rather than retyped —
 * a need for a module nothing probes is a row whose badge is permanently
 * "cannot tell", which is worse than not listing it.
 */
const INDEX_SRC = await readFile(path.join(REPO, "server", "index.js"), "utf8");
/* The probe list, lifted from the function that defines it. Anchored on the
 * declaration so an `add(...)` elsewhere in that 5,000-line file cannot leak in
 * and make this census look more generous than it is. */
const probeBlock = /const PACKAGE_PROBES = \(\) => \{[\s\S]*?\n\};/.exec(INDEX_SRC)?.[0] || "";
const PROBED = new Set([...probeBlock.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
ok(`the package probe was found and read (${[...PROBED].join(", ") || "nothing"})`,
  PROBED.size >= 4 && PROBED.has("demucs") && PROBED.has("faster_whisper"),
  "server/index.js PACKAGE_PROBES could not be read — every package assertion below would "
    + "pass vacuously, which is the one way this census could lie");

const CAP_IDS = new Set(CATALOG.map((c) => c.id));
const declared = TABS.filter((t) => Array.isArray(t.needs));
ok(`every screen declares what it needs (${TABS.length} screens)`,
  declared.length === TABS.length,
  TABS.filter((t) => !Array.isArray(t.needs)).map((t) => t.id).join(", ")
    + " — `needs` is mandatory and an empty array is a real answer. A screen that omits it "
    + "is a screen nobody decided about, and the panel would show it as needing nothing.");

const unresolved = [];
const unexplained = [];
for (const t of TABS) {
  for (const n of resolveNeeds(t)) {
    const okNeed = n.kind === "package" ? PROBED.has(n.id) : CAP_IDS.has(n.capability);
    if (!okNeed) unresolved.push(`${t.id}: ${n.kind} "${n.id}"`);
    if (!n.for || n.for.length < 12) unexplained.push(`${t.id}: ${n.kind} "${n.id}"`);
  }
}
ok("every need on every screen resolves to a real model or a probed package",
  unresolved.length === 0,
  unresolved.join("\n          ")
    + "\n          A model need must name a row in server/models.js CATALOG (an engine need "
    + "reaches one through MODEL_TO_CAPABILITY); a package need must name a module "
    + "server/index.js PACKAGE_PROBES actually asks about.");
ok("...and every one of them says what it is FOR",
  unexplained.length === 0, unexplained.join(", "),
);

/* THE TWO SETS THAT MUST BE DERIVED, checked the way the size ladder above is
 * checked: by identity against the config, not by counting. A typed list here
 * is the bug the panel exists to avoid — a third video engine landing in
 * config.js and never appearing on the Video screen. */
const videoNeeds = screenFor("video").needs.filter((n) => n.kind === "engine").map((n) => n.id);
ok("the Video screen's engines are config's engines, not a copy",
  JSON.stringify(videoNeeds) === JSON.stringify(Object.keys(config.video.engines)),
  `${videoNeeds.join(", ")} against ${Object.keys(config.video.engines).join(", ")}`);

const VIDEO_CAPS = Object.keys(config.video.engines).map((k) => MODEL_TO_CAPABILITY[k]);
const namedVideoCap = TABS.flatMap((t) => (t.needs || [])
  .filter((n) => n.kind === "model" && VIDEO_CAPS.includes(n.id))
  .map((n) => `${t.id}: ${n.id}`));
ok("no screen names a video engine by its capability id",
  namedVideoCap.length === 0,
  namedVideoCap.join(", ")
    + " — reach it through the engine key so config.js decides which engines exist. "
    + "index.js's own comment: a third engine used to resolve silently to H3's row.");

const imageNeeds = screenFor("images").needs.filter((n) => n.kind === "model").map((n) => n.id);
/* THE THIRD COPY OF A RULE THAT IS NOW ONE RULE. This was the subtraction too
 * — "the engine map's values, minus video, minus the required one" — which is
 * why a test could not catch the day it started including a video ControlNet:
 * the screen, fit.js and this check all derived the same wrong set and agreed.
 * All three ask models.js's isPictureModel() now. */
const derivedImages = CATALOG.filter(isPictureModel).map((c) => c.id);
ok("the Images screen's models are the rows that declare they make pictures",
  derivedImages.length > 0 && derivedImages.every((id) => imageNeeds.includes(id)),
  derivedImages.filter((id) => !imageNeeds.includes(id)).join(", ")
    + " — server/fit.js asks the same predicate; the two must not disagree about "
    + "which capabilities are picture models");
/* The screen carries more than the generators — background removal and the
 * upscaler are on it too — so the check above is one-way on purpose. This is
 * the other direction that matters: nothing that is NOT a picture model may
 * arrive under the "any one picture model will do" line, which is the sentence
 * a control model landed under when the rule was a subtraction. */
const CONTROL_IDS = ["videoControl", "posePreprocess"];
ok("no control capability appears on the Images screen",
  !imageNeeds.some((id) => CONTROL_IDS.includes(id)), imageNeeds.join(", "));
ok("...and the picture-model line is offered for the picture models only",
  screenFor("images").needs
    .filter((n) => n.kind === "model" && /any one picture model/.test(String(n.for)))
    .every((n) => derivedImages.includes(n.id)),
  screenFor("images").needs.filter((n) => /any one picture model/.test(String(n.for))).map((n) => n.id).join(", "));

/* A package typed on a screen that ALREADY names the model which declares it is
 * the same fact written twice, and the model's `needsPackage` is the copy that
 * will change. The narrower rule is the correct one, and it is narrower because
 * of a real case: the compositor imports `av` to read and write video files,
 * which has nothing to do with the audio-reference capability that happens to
 * declare the same module. Two screens needing one module for two unrelated
 * reasons is not duplication — the same screen saying it twice is. */
const typedTwice = [];
for (const t of TABS) {
  const viaModels = new Set(
    (t.needs || [])
      .filter((n) => n.kind !== "package")
      .map((n) => (n.kind === "engine" ? MODEL_TO_CAPABILITY[n.id] : n.id))
      .map((id) => CATALOG.find((c) => c.id === id)?.needsPackage)
      .filter(Boolean));
  for (const n of t.needs || []) {
    if (n.kind === "package" && viaModels.has(n.id)) typedTwice.push(`${t.id}: ${n.id}`);
  }
}
ok("no screen types a package it already gets from a model it names",
  typedTwice.length === 0,
  typedTwice.join(", ")
    + " — needsPackage in server/models.js already says this; name the model and the "
    + "package arrives with it");

/* BIT-TRANSPARENT. Some screens genuinely need nothing, and the panel says so
 * rather than showing an empty box — but only where it is true. A screen with
 * no needs AND no note is claiming self-sufficiency, so at least one must exist
 * (or the claim is never made) and none of them may be a screen that plainly
 * downloads something. */
const nothingNeeded = TABS.filter((t) => !t.needs?.length && !t.needsNote);
ok(`some screens honestly need nothing, and say so (${nothingNeeded.map((t) => t.id).join(", ")})`,
  nothingNeeded.length > 0);
ok("...and the ones that need something outside both indexes say THAT instead",
  TABS.filter((t) => t.needsNote).every((t) => t.needsNote.length > 60),
  "reactive needs a second ComfyUI and mcp needs an assistant — neither is a row or a pip "
    + "install, and an empty list would have read as 'needs nothing beyond the app'");

/* ── the imports nothing probes are NAMED, and this reads the python ──────
 *
 * THE HOLE THIS CLOSES. Two screens run python of their own, and the probe in
 * index.js knows five modules. The compositor's engine imports cv2 and PIL at
 * the top of the file; the DAW's engine, mixer, drum synth and mastering chain
 * import scipy the same way. Keeping them out of `needs` is right — a need this
 * app cannot check is a claim, and the census above only admits needs it can
 * resolve — but the panel then listed two packages for a screen that needs four
 * and read as complete. An honest omission and a dishonest page.
 *
 * So the rule is: in `needs` or in `needsNote`, and this proves it against the
 * source rather than against somebody's memory of it. Add cv2 to the DAW's
 * python tomorrow and this fails until the DAW's note says so.
 *
 * MODULE-LEVEL IMPORTS ONLY, and outside docstrings. That is the honest line to
 * draw: a module-level import is one the file cannot load without, while a lazy
 * import inside a function may be an optional extra the code handles the
 * absence of — server/daw/ear.py imports laion_clap that way, and demanding a
 * sentence about it would be demanding a false one. Imports the two engines
 * make lazily and really do need (scipy in the compositor, soundfile in the
 * DAW) are named in the notes anyway; this census is the floor, not the ceiling.
 */
const PY_ENGINES = { vfx: "vfx", daw: "daw" };

async function pyFilesUnder(dir) {
  const out = [];
  /* A listed directory may not exist — vendor/ does not on this branch — and a
   * census that crashes on an absent tree reports nothing about the present
   * ones. Absent is an empty list, not an error. */
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (e) { if (e.code === "ENOENT") return out; throw e; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await pyFilesUnder(full));
    else if (e.name.endsWith(".py")) out.push(full);
  }
  return out;
}
/* Every python file this repo ships — server/, scripts/ and vendor/ — because
 * those basenames are its OWN modules and `import interp` is not a dependency
 * anybody installs. All three, not just the directory being read: the
 * compositor imports `beats`, which is scripts/beats.py, and a census that
 * looked only under server/ asked the VFX screen to warn its reader about a pip
 * package that does not exist. Read rather than listed, because a list goes
 * stale in exactly the direction that makes this check quieter. */
const ALL_PY = (await Promise.all(["server", "scripts", "vendor"]
  .map((d) => pyFilesUnder(path.join(REPO, d))))).flat();
const LOCAL_PY = new Set(ALL_PY.map((f) => path.basename(f, ".py")));
/* The standard library. A name missing from this set costs a LOUD failure —
 * the census asks for a sentence about `bisect` — never a silent pass, which is
 * the right way round for a list that has to be maintained by hand. */
const STDLIB = new Set([
  "__future__", "abc", "argparse", "array", "ast", "asyncio", "atexit", "base64", "binascii",
  "bisect", "cmath", "collections", "colorsys", "concurrent", "contextlib", "copy", "csv",
  "ctypes", "dataclasses", "datetime", "decimal", "difflib", "enum", "errno", "fractions",
  "functools", "gc", "glob", "gzip", "hashlib", "heapq", "html", "http", "importlib", "inspect",
  "io", "itertools", "json", "logging", "math", "multiprocessing", "operator", "os", "pathlib",
  "pickle", "platform", "pprint", "queue", "random", "re", "secrets", "shlex", "shutil", "signal",
  "socket", "sqlite3", "stat", "statistics", "string", "struct", "subprocess", "sys", "tempfile",
  "textwrap", "threading", "time", "traceback", "typing", "unicodedata", "unittest", "urllib",
  "uuid", "warnings", "wave", "weakref", "zipfile", "zlib",
]);

/** Module-level imports of one .py file, docstrings skipped. */
function moduleLevelImports(src) {
  const roots = new Set();
  let inDoc = null;
  for (const rawLine of src.split(/\r?\n/)) {
    /* Prose at column 0 inside a docstring reads exactly like an import
     * statement — server/vfx/audiokeys.py has a line beginning "import of torch
     * costs" — and outside one it would be a syntax error, so the state of the
     * triple quotes is the whole test. */
    let line = rawLine;
    for (const q of ['"""', "'''"]) {
      let at = line.indexOf(q);
      while (at >= 0) {
        if (inDoc === q) inDoc = null;
        else if (inDoc === null) inDoc = q;
        at = line.indexOf(q, at + 3);
      }
    }
    if (inDoc) continue;
    line = line.replace(/#.*$/, "").trimEnd();
    const from = /^from\s+([A-Za-z_][\w.]*)\s+import\s/.exec(line);
    if (from) { roots.add(from[1].split(".")[0]); continue; }
    const plain = /^import\s+(.+)$/.exec(line);
    if (!plain) continue;
    for (const part of plain[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_][\w.]*$/.test(name)) roots.add(name.split(".")[0]);
    }
  }
  return roots;
}

for (const [tabId, dir] of Object.entries(PY_ENGINES)) {
  const tab = screenFor(tabId);
  const files = (await pyFilesUnder(path.join(REPO, "server", dir)))
    .filter((f) => !path.basename(f).endsWith("_test.py"));
  ok(`${tabId}: its python was found and read (${files.length} files)`, files.length > 0,
    `server/${dir} — with no files this check passes vacuously`);

  const outside = new Set();
  for (const f of files) {
    for (const root of moduleLevelImports(await readFile(f, "utf8"))) {
      if (LOCAL_PY.has(root) || STDLIB.has(root) || PROBED.has(root)) continue;
      outside.add(root);
    }
  }
  /* Named in `needs` — which can only happen for a probed module, so in
   * practice this is the note — or named in the note. Case-insensitively,
   * because the note is prose: it says SciPy and Pillow where the interpreter
   * says scipy and PIL, and it says both on purpose. */
  const declared = new Set(resolveNeeds(tab).map((n) => String(n.id).toLowerCase()));
  const note = (tab.needsNote || "").toLowerCase();
  const unsaid = [...outside].filter((m) => !declared.has(m.toLowerCase()) && !note.includes(m.toLowerCase()));
  ok(`${tabId}: every python package it imports and nobody probes is named in its note`
     + ` (${[...outside].join(", ") || "none"})`,
    unsaid.length === 0,
    `${unsaid.join(", ")} — imported at the top of server/${dir}/*.py, not probed by `
      + "server/index.js, and not mentioned on the screen that needs it. Excluding it from "
      + "`needs` is right; leaving the reader to find out at the first render is not. Put it "
      + "in that tab's needsNote.");
}

/* The badge vocabulary is prose too, and it lives here for the same reason
 * FIT_STATES lives in fit.js. Four tones, because web/modelfit.css dresses
 * exactly four and a fifth would arrive with no colour. */
ok("every readiness state carries a chip and a full sentence",
  Object.values(NEED_STATES).every((s) => s.chip && s.line?.length > 30));
ok("...and every tone is one web/modelfit.css already dresses",
  Object.values(NEED_STATES).every((s) => ["ok", "warn", "bad", "unknown"].includes(s.tone)),
  Object.entries(NEED_STATES).filter(([, s]) => !["ok", "warn", "bad", "unknown"].includes(s.tone))
    .map(([k]) => k).join(", "));

/* ── THE LADDER, BRANCH BY BRANCH ─────────────────────────────────────────
 *
 * This block exists because of a bug that lived in a ternary. The ladder used
 * to be written inline in the join in routes.js, and it consulted `packageReady`
 * only inside the `managedByPackage` branch — so a capability with every file on
 * disk and its python package missing (stems without demucs, timed lyrics
 * without faster-whisper, the audio reference without av) fell through to
 * `ready` and was badged green, "On disk". It is not on disk in the sense that
 * badge means: it cannot run. Proven live by pointing AIPLAY_SYS_PYTHON at an
 * interpreter that does not exist, which is the state a great many machines are
 * actually in.
 *
 * The repair was the SHAPE, not the branch: a pure function beside the words it
 * chooses from, so every path can be walked here with a fabricated capability —
 * no server, no card, no disk, no interpreter. Each row below is one machine
 * somebody is sitting at.
 */
const LADDER = [
  ["a capability /api/models has never heard of", null, "unknown"],
  ["every file here, package fine", { ready: true, packageReady: true }, "ready"],
  ["every file here, package MISSING", { ready: true, packageReady: false }, "ready-no-package"],
  ["every file here, no package declared", { ready: true, packageReady: true }, "ready"],
  ["every file here, an older server that sends no such field", { ready: true }, "ready"],
  ["half a download", { ready: false, haveBytes: 4096 }, "partial"],
  ["nothing fetched yet", { ready: false, haveBytes: 0 }, "missing"],
  ["weights come with the package, package installed",
    { managedByPackage: true, ready: false, packageReady: true }, "via-package"],
  ["weights come with the package, package missing",
    { managedByPackage: true, ready: false, packageReady: false }, "needs-package"],
];
for (const [label, cap, want] of LADDER) {
  const got = needState(cap);
  ok(`${label} → ${want}`, got === want, `got "${got}"`);
}
ok("every word the ladder says is one the vocabulary can dress",
  LADDER.every(([, , want]) => want in NEED_STATES),
  LADDER.map(([, , w]) => w).filter((w) => !(w in NEED_STATES)).join(", ")
    + " — a state with no entry in NEED_STATES renders as no badge at all");
/* The two flags the panel keys on, checked where they are decided. A state that
 * says the fetching is done and also prints "open the Models screen" would be
 * telling somebody to go and download what they already have. */
ok("every state that says there is nothing left to fetch says so out of the same table",
  Object.entries(NEED_STATES).filter(([, s]) => s.nothingToFetch)
    .every(([, s]) => s.tone !== "bad"),
  "a state cannot both mean the files are here and carry the error tone");
ok("...and every state whose sentence must be shown carries a sentence to show",
  Object.values(NEED_STATES).filter((s) => s.inline).every((s) => s.line?.length > 30));

/* ── licences are quoted from the live catalogue ────────────────────────── */
const h3 = c.licences.notable.find((n) => n.id === "video");
const ltx = c.licences.notable.find((n) => n.id === "videoLtx");
ok("H3's territory exclusion is on the page", !!h3?.region?.excluded?.length,
  "the one region-locked entry in the catalogue must be met on day one, not at download");
ok("...and it is the catalogue's own words",
  h3?.region?.text === CATALOG.find((x) => x.id === "video")?.region?.text);
ok("LTX's conditions are on the page", (ltx?.conditions?.length ?? 0) >= 3);
ok("...and they are the catalogue's own words",
  JSON.stringify(ltx?.conditions) === JSON.stringify(
    CATALOG.find((x) => x.id === "videoLtx")?.outputRights?.conditions));
ok("the revenue ceiling is stated in figures",
  ltx?.conditions?.some((x) => /10,000,000|10 ?M/.test(x)));
ok("every licence shown links to the publisher's own text",
  c.licences.notable.every((n) => !!n.url),
  "you read the licence, never our summary — the About page's promise");

/* ── the showcase is real or honestly empty ─────────────────────────────── */
const sc = await showcase();
ok(`the showcase read this machine (${sc.panels.length} panels)`, sc.panels.length === 4);
ok("every empty panel says why it is empty",
  sc.panels.every((p) => p.items.length || (p.empty && p.empty.length > 30)),
  sc.panels.filter((p) => !p.items.length && !p.empty).map((p) => p.id).join(", "));

const resolve = (it) => {
  if (it.kind === "image") return path.join(config.outputDir, "images", it.name);
  if (it.kind === "clip") return path.join(config.outputDir, "clips", it.name);
  if (it.kind === "song") return path.join(config.outputDir, it.name);
  return path.join(config.outputDir, "daw", it.slug, "bounces", it.name);
};
const items = sc.panels.flatMap((p) => p.items);
const missing = [];
for (const it of items) {
  try { if (!(await stat(resolve(it))).size) missing.push(it.name); }
  catch { missing.push(it.name); }
}
ok(`every showcase item is a file that exists (${items.length} shown)`,
  missing.length === 0, missing.join(", ") + " — listed and not on disk");
ok("every showcase item carries the input that produced it",
  items.every((it) => it.prompt || it.caption || it.kind === "bounce"),
  "the prompt beside the result is half the point; an item without one is a screenshot");
/* A bounce has no prompt — it was built bar by bar — so what stands in for one
 * is the shape of the arrangement. Anything less is a filename. */
ok("every bounce carries the shape of its arrangement",
  items.filter((it) => it.kind === "bounce").every((it) => it.bpm || it.bars || it.trackCount));

console.log(`\n  ${pass} passed, ${failures.length} failed`);
console.log(`        (showcase: ${sc.panels.map((p) => `${p.id} ${p.count}`).join(", ")})\n`);
process.exit(failures.length ? 1 : 0);
