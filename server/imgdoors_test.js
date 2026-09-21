/**
 * FIVE DOORS THAT WERE BUILT, WORKING, AND UNREACHABLE.
 *
 * Every feature pinned here already existed as a function. The matte was
 * resolved on every edit and thrown away; `frame_stages` was inlined inside
 * apply_edit so nothing else could resolve a selection in the same coordinate
 * system; imgtext folded its telemetry into a `notes` list nobody passed;
 * imgtext.measure_text and imgpath.check_figure had catalog entries, test
 * suites and CLI docstrings written for a spawn shape that no route used; and
 * imgdoc could store and edit a document that no route reached. What was wired
 * on 2026-09-21 is the SEAM, and a seam is the one thing that regresses in
 * silence: the engine goes on being right while nothing can ask it anything.
 *
 * ⚠ SO WHAT THIS SUITE GUARDS IS THE WIRE, NOT THE ENGINE. Each door is held
 * at every link it has previously shipped without — the module's CLI mode, the
 * route that spawns it, the tool that posts the route, and the page control
 * that sends it — because every one of those failures answers 200 and looks
 * like a working feature from the other side.
 *
 * ⚠ AND A CHECK THAT CANNOT FAIL IS NOT A CHECK. Every source pin below runs
 * TWICE: once against the file as it is, and once against a copy of that same
 * text with the exact thing it claims to watch removed, renamed or moved. If
 * the second run still passes, the expression has quietly stopped matching
 * anything in particular and the first run's green line means nothing. The
 * mutation is asserted to have CHANGED the text as well, because a `replace`
 * whose needle has drifted is a no-op that proves a pin honest by proving
 * nothing at all.
 *
 * Sections 1-5 read source text and need no python, no engine and no GPU.
 * Section 6 RUNS the two new CLI modes on the engine's venv python, because a
 * regular expression cannot tell a diagnosis from a constant: it feeds
 * imgpath.check a figure that is wrong and one that is right and requires the
 * two answers to DIFFER, and it asks imgtext.measure for a font that is not on
 * this rig and one that is. It skips itself loudly, naming the interpreter,
 * where that python is absent.
 */
import assert from "node:assert";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0, failed = 0, skipped = 0;
const ok = (what, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ok    ${what}`); }
  else { failed++; console.log(`  FAIL  ${what}${extra ? `\n        ${extra}` : ""}`); }
};
const skip = (what, why) => { skipped++; console.log(`  SKIP  ${what}\n        ${why}`); };

/* ⚠ NORMALISE THE LINE ENDINGS BEFORE MATCHING ANYTHING. The system gitconfig
 * on this machine has autocrlf=true, so a FRESH worktree checks these files out
 * with CRLF while the one they were written in has LF. Several pins below match
 * across a newline, and a pin that passes here and fails on somebody's clone is
 * the same as no pin. Normalising is safe precisely because this suite reads
 * text and never hashes bytes. */
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const tools = src("./imagetools.py");   // the edit pipeline, and frame_stages
const index = src("./index.js");        // the routes
const mcp = src("./mcp.js");            // the tools
const imgdoc = src("./imgdoc.py");      // the document shelf
const imgtext = src("./imgtext.py");    // measure
const imgpath = src("./imgpath.py");    // check
const app = src("../web/app.js");       // the editor page

/* ── the two-sided pin ──────────────────────────────────────────────────────
 * `both` asserts the claim against the real text AND against a copy with the
 * claim's subject broken on purpose. `how` is printed, so a reader can see what
 * the negative actually did rather than trusting that it did something. */
const both = (what, test, text, breakIt, how, extra = "") => {
  ok(what, test(text), extra);
  let broken;
  try { broken = breakIt(text); } catch (e) { broken = text; }
  ok(`  └ negative: fails when ${how}`, broken !== text && !test(broken),
    broken === text
      ? "THE MUTATION CHANGED NOTHING — the negative proves nothing, and the positive above is therefore unverified"
      : "THE PIN PASSED ON A BROKEN TREE — rewrite it, because it is not watching what it says it is");
};
const has = (re) => (t) => re.test(t);
const cut = (needle) => (t) => t.replace(needle, "");
const swap = (a, b) => (t) => t.replace(a, b);
/* ⚠ AND SOMETIMES EVERY OCCURRENCE. `swap` breaks the FIRST one, which is
 * exactly wrong for a claim about a line that appears three times: the pin goes
 * on matching one of the survivors and reports the negative as a pass on a
 * broken tree. This suite's own first run did that, twice. */
const swapAll = (a, b) => (t) => t.split(a).join(b);
/* Mutate the FIRST occurrence at or after `anchor`, so a pin about one of two
 * identical-looking call sites can be broken at ITS OWN site rather than at
 * whichever one happens to come first in the file. */
const editAfter = (anchor, from, to) => (t) => {
  const i = t.indexOf(anchor);
  if (i < 0) return t;
  const tail = t.slice(i);
  if (!tail.includes(from)) return t;
  return t.slice(0, i) + tail.replace(from, to);
};
/* An ORDER claim: `a` must appear before `b`, and both must appear. */
const before = (a, b) => (t) => {
  const i = t.indexOf(a), j = t.indexOf(b);
  return i >= 0 && j >= 0 && i < j;
};

/* One route handler, sliced out of index.js: from its own `if (p === ...)` to
 * the next route test at the same indent. Every pin about a route is run
 * against ITS OWN block, so a string that happens to exist elsewhere in a
 * 9 600-line file cannot satisfy it. */
const routeBlock = (needle) => {
  const i = index.indexOf(needle);
  if (i < 0) return "";
  const j = index.indexOf("\n    if (p ", i + needle.length);
  return index.slice(i, j < 0 ? index.length : j);
};
/* One tool object, sliced out of mcp.js the same way — the tool list writes
 * every tool's name at exactly four spaces of indent. */
const toolBlock = (name) => {
  const i = mcp.indexOf(`    name: "${name}",`);
  if (i < 0) return "";
  const j = mcp.indexOf('\n    name: "', i + 8);
  return mcp.slice(i, j < 0 ? mcp.length : j);
};

console.log("\nFIVE DOORS: THE MATTE, THE FRAME, THE TELEMETRY, THE TWO MEASURES, THE SHELF");

/* ══ 1. THE BAKED SELECTION MATTE ═══════════════════════════════════════════
 * imgdoc.py refuses a wand, a colorRange or a path inside a document mask and
 * tells the caller, in its own words, to "bake the result into a library image
 * and use mask.src". Nothing baked. The kinds worth baking are exactly the ones
 * that cannot be written back down: a rect is JSON, but a wand seed with a
 * tolerance somebody tuned blind is computed FROM PIXELS and used to live for
 * the length of one call. */
console.log("\n1. THE SELECTION, KEPT AS A PICTURE");

const applyEdit = tools.slice(tools.indexOf("def apply_edit(job):"),
                              tools.indexOf("def describe_selection(job):"));
ok("apply_edit and describe_selection both slice out of imagetools.py",
  applyEdit.length > 2000 && tools.includes("def describe_selection(job):"),
  "the slices below are meaningless if these anchors have moved");

/* ⚠ THE PLATE IS WRITTEN AFTER THE RESIZE. Stage 4 resolves the selection
 * against the post-geometry image; `ops.resize` runs at the very end. A plate
 * written at the stage-4 size does not register against `out` — and nothing
 * downstream would say so, because a mask of the wrong size is still a legal
 * grayscale picture. It would simply mask the wrong pixels, forever. */
const MASK_BLOCK = '    if job.get("maskOut"):';
const THUMB_BLOCK = '    if job.get("thumbOut"):';
const RESIZE_STMT = "        im = im.resize((min(8192";
both("apply_edit writes the maskOut plate AFTER ops.resize, not before it",
  before(RESIZE_STMT, MASK_BLOCK), tools,
  (t) => {
    const a = t.indexOf(MASK_BLOCK), b = t.indexOf(THUMB_BLOCK);
    if (a < 0 || b < 0 || b <= a) return t;
    const block = t.slice(a, b);
    const rest = t.slice(0, a) + t.slice(b);
    const r = rest.indexOf('    rs = ops.get("resize")');
    return r < 0 ? rest : rest.slice(0, r) + block + rest.slice(r);
  },
  "the whole maskOut block is moved above the resize",
  "a plate at the stage-4 size does not register against `out`, and no reader can tell");

both("...and resamples the plate when the two sizes differ anyway",
  has(/_img\.size != \(im\.width, im\.height\):[\s\S]{0,140}_img = _img\.resize\(\(im\.width, im\.height\)/),
  tools, cut("        _img = _img.resize((im.width, im.height), Image.LANCZOS)\n"),
  "the resample line is deleted");

/* ⚠ NO SELECTION IS EVERYTHING, NOT NOTHING. `_mask` is None when the job
 * carried no selection, and imgselect treats an all-zero mask as a legitimate
 * no-op — so the two states are genuinely different. Skipping the write when
 * there is no selection would produce NO FILE for a request that succeeded,
 * which every caller on the other end reads as a failure. */
const WHITE_PLATE = "_plate = np.ones((im.height, im.width), np.float32) if _mask is None else _mask";
both("the no-selection branch writes SOLID WHITE rather than skipping the file",
  has(/_plate = np\.ones\(\(im\.height, im\.width\), np\.float32\) if _mask is None else _mask/),
  tools, swap(WHITE_PLATE, "_plate = _mask"),
  "the branch stops producing a white plate for the whole frame");
both("...and says which of the two it did, so the reply's sentence can be true",
  has(/"everything": _mask is None/), tools,
  swap('"everything": _mask is None', '"everything": False'),
  "`everything` is hard-coded instead of read from the mask");

const bake = routeBlock('if (p === "/api/images/bake-selection" && req.method === "POST")');
ok("/api/images/bake-selection is a route in index.js",
  bake.length > 800 && /bake-selection/.test(bake),
  "everything below reads this block, so a missing route makes the rest vacuous");
both("...and it files the plate into imageMeta with a maskOf parent",
  has(/imageMeta\.set\(outName, \{ maskOf: name/), bake,
  swap("imageMeta.set(outName, { maskOf: name", "imageMeta.set(outName, { editedFrom: name"),
  "the parent link is filed under some other key");
both("...and saves the store, or the row is gone at the next restart",
  has(/imageMeta\.set\(outName[\s\S]{0,400}saveImageStore\(\)/), bake,
  cut("        saveImageStore();\n"), "saveImageStore() is dropped");

/* ⚠ apply_edit ALWAYS WRITES `out`. There is no matte-only path through it, and
 * inventing one would mean a SECOND piece of code resolving selections, which
 * is how two answers to "what did the wand catch" start. So the bake route
 * sends `out` to a dot-prefixed scratch file and unlinks it: asking for a matte
 * must not quietly leave an untouched duplicate of the picture in the gallery,
 * where nothing marks it as an accident and nobody knows to delete it. */
both("the throwaway `out` is a dot-prefixed scratch file, not a library name",
  has(/const scratch = path\.join\(IMAGE_DIR, `\.bake_\$\{tag\}\.png`\)[\s\S]{0,1400}out: scratch,/),
  bake, swap("out: scratch,", "out: path.join(IMAGE_DIR, `${stem}_b${tag}.png`),"),
  "the scratch output is given a real library name");
both("...and it is UNLINKED, so a matte request leaves no duplicate picture behind",
  has(/unlink\(scratch\)\.catch\(/), bake, cut("        unlink(scratch).catch(() => {});\n"),
  "the unlink is dropped from the finally block");

/* ⚠ THE LINEAGE WALK HAS TWO HALVES AND THEY FAIL SEPARATELY. The `via` ladder
 * names the step and the `cur =` chain takes the next one. Dropping `maskOf`
 * from the ladder leaves a matte in the chain with a null verb; dropping it
 * from the chain stops the walk dead at the matte, so a baked plate is an
 * ORPHAN and "back to the original" cannot be offered on it. Neither half is
 * evidence for the other. */
const lineage = routeBlock('if (p.startsWith("/api/images/lineage/"))');
ok("the lineage walk slices out of index.js", lineage.length > 300 && /const chain = \[\]/.test(lineage));
both("the lineage walk NAMES a baked matte's step",
  has(/m\.maskOf \? "selection"/), lineage, cut(': m.maskOf ? "selection"'),
  "the maskOf arm is removed from the `via` ladder");
both("...and FOLLOWS it to the picture it was cut from",
  has(/cur = [^\n]*\|\| m\.maskOf \|\|/), lineage, swap("|| m.maskOf ||", "||"),
  "maskOf is removed from the parent chain, which orphans every matte");

/* ⚠ THE TOOL SCHEMA IS A GATE, NOT A SUGGESTION. image_adjust declares
 * `additionalProperties: false`, so an UNDECLARED save_selection is refused
 * outright — and a `saveSelection` that survives the destructure into `...ops`
 * is the mirror failure: the pipeline drops keys it does not know, so it
 * reaches the engine, is ignored, and reports success with no matte. Both of
 * those look exactly like a working call from where the caller sits. */
const adjust = toolBlock("image_adjust");
ok("image_adjust slices out of mcp.js",
  adjust.length > 2000 && /save_selection/.test(adjust) && !/\n    name: "/.test(adjust));
both("image_adjust's schema is CLOSED, which is what makes the next pin matter",
  has(/\n      additionalProperties: false,/), adjust,
  swap("\n      additionalProperties: false,", "\n      additionalProperties: true,"),
  "the schema is opened, so an undeclared key would ride through instead of being refused");
both("image_adjust DECLARES save_selection, or a closed schema refuses the call",
  has(/save_selection: \{ type: "boolean",/), adjust,
  swap('save_selection: { type: "boolean",', '_unused_selection: { type: "boolean",'),
  "the declaration is renamed away");
both("...and DESTRUCTURES it out before the rest is spread into ops",
  has(/const \{[^}]*\bsave_selection\b[^}]*\.\.\.ops \} = a;/), adjust,
  swap("grain_seed, save_selection, ...ops", "grain_seed, ...ops"),
  "save_selection is left inside ...ops, where the engine ignores it and answers ok");
both("...and posts saveSelection as a SIBLING of ops rather than inside it",
  before("saveSelection: save_selection === true", "ops: { ...ops,"), adjust,
  swap("        saveSelection: save_selection === true,\n        ops: { ...ops,",
       "        ops: { saveSelection: save_selection === true, ...ops,"),
  "saveSelection is moved inside the ops object");

/* And the far end of that wire: /api/images/edit has to turn the flag into a
 * maskOut path and file the plate, or the tool's whole argument lands nowhere. */
const editRoute = routeBlock('if (p === "/api/images/edit" && req.method === "POST")');
both("/api/images/edit turns saveSelection into a maskOut path for the engine",
  has(/const bakeName = b\.saveSelection === true[\s\S]{0,600}maskOut: bakeName \? path\.join\(IMAGE_DIR, bakeName\) : null,/),
  editRoute, swap("maskOut: bakeName ? path.join(IMAGE_DIR, bakeName) : null,", "maskOut: null,"),
  "the job stops carrying maskOut, so the flag is accepted and does nothing");
both("...and files the resulting plate under a maskOf parent too",
  has(/imageMeta\.set\(bakeName, \{ maskOf: name/), editRoute,
  swap("imageMeta.set(bakeName, { maskOf: name", "imageMeta.set(bakeName, { editedFrom: name"),
  "the plate's parent link is filed under some other key");

both("there is a bake_selection tool, because a person and an assistant get the same doors",
  has(/\n    name: "bake_selection",/), mcp, swap('\n    name: "bake_selection",', '\n    name: "bake_sel",'),
  "the tool is renamed");
both("...and it posts the route rather than re-implementing it",
  has(/api\("POST", "\/api\/images\/bake-selection"/), toolBlock("bake_selection"),
  swap('"/api/images/bake-selection"', '"/api/images/edit"'), "the tool is repointed at another route");

/* ══ 2. THE FRAME A SELECTION'S COORDINATES ARE WRITTEN IN ══════════════════
 * EVERY selection in this system is written post-canvas, post-crop,
 * post-rotate: imagetools resolves one at stage 4, web/app.js's iedSrcToStage()
 * writes its shapes there, and IMAGE_SPEC §3 says "pixels AFTER any
 * crop/rotate/flip in the same call". A caller that resolves a selection
 * against the RAW source is not slightly off — it is answering confidently
 * about a DIFFERENT PICTURE, with the right numbers and no error on either
 * side. describe_selection did exactly that until frame_stages was lifted out
 * of apply_edit. */
console.log("\n2. ONE COORDINATE SYSTEM, IN ONE PLACE");

/* ⚠ ONCE. A second copy of a coordinate system is the same bug with a delay on
 * it: it starts correct and drifts the first time one of the two is edited. */
both("imagetools.py defines frame_stages EXACTLY ONCE",
  (t) => (t.match(/^def frame_stages\(/gm) || []).length === 1, tools,
  (t) => `${t}\n\ndef frame_stages(im, ops, notes):\n    return im\n`,
  "a second definition is appended to the module");
both("apply_edit resolves the frame through it",
  has(/im = frame_stages\(im, ops, _notes\)/), applyEdit,
  cut("    im = frame_stages(im, ops, _notes)"), "apply_edit stops calling it");
both("...and so does describe_selection, in the SAME call",
  has(/im = frame_stages\(im, job\.get\("frame"\) or \{\}, _notes\)/),
  tools.slice(tools.indexOf("def describe_selection(job):")),
  cut('    im = frame_stages(im, job.get("frame") or {}, _notes)'),
  "describe_selection stops calling it and goes back to measuring the raw source");

/* ⚠ ONLY THE STAGES THAT MOVE A COORDINATE TRAVEL. `ops` also carries the
 * twenty-five adjustments and the 93 effects, and none of those move a pixel's
 * address: running them here would cost real time on a file the bake route
 * unlinks, and an alpha-changing effect would quietly change what a `channel`
 * selection catches. So the six keys are whitelisted BY NAME — and a key
 * missing from that list is dropped in silence, which is how a rotation written
 * as geometry.rotate would vanish on its way to the engine. */
const FRAME_KEYS = /\["canvas", "crop", "geometry", "rotate", "flipH", "flipV"\]/;
const describe = routeBlock('if (p === "/api/images/describe-selection" && req.method === "POST")');
both("/api/images/describe-selection whitelists all six frame keys",
  has(FRAME_KEYS), describe, swap('"geometry", ', ""),
  "geometry is dropped from the whitelist, and an arbitrary-angle rotate silently stops travelling");
both("...and passes the frame into the job it writes",
  has(/frame: dframe,/), describe, swap("frame: dframe,", ""),
  "the job stops carrying the frame");
both("/api/images/bake-selection whitelists all six frame keys too",
  has(FRAME_KEYS), bake, swap('"geometry", ', ""), "geometry is dropped from the whitelist");
both("...and spreads them into the ops it sends",
  has(/ops: \{ \.\.\.frame, selection: b\.selection \|\| \{\} \},/), bake,
  swap("ops: { ...frame, selection: b.selection || {} },", "ops: { selection: b.selection || {} },"),
  "the frame is collected and then not sent — the exact shape of a silent drop");

/* ⚠ AND THE TOOLS HAVE TO DECLARE IT. Both schemas are closed, so a `frame`
 * that is not in `properties` is REFUSED — not ignored. An assistant holding
 * the right numbers cannot hand them over at all. */
for (const [tool, route] of [["describe_selection", "/api/images/describe-selection"],
                             ["bake_selection", "/api/images/bake-selection"]]) {
  const blk = toolBlock(tool);
  ok(`${tool} slices out of mcp.js`, blk.length > 500 && !/\n    name: "/.test(blk));
  /* ⚠ THE WORD BOUNDARY IS THE PIN. Without `\b` this expression also matches
   * `_frame:` and `maskFrame:`, so renaming the property — which is precisely
   * how a closed schema starts refusing the argument — left it green. Its own
   * negative caught that on the first run. */
  both(`${tool} DECLARES frame in its inputSchema`,
    has(/\bframe: \{ type: "object", description:/), blk,
    swap('frame: { type: "object", description:', '_frame: { type: "object", description:'),
    "the property is renamed, which a closed schema turns into a refusal");
  both(`...and ${tool}'s run() actually forwards it to ${route}`,
    has(/frame: a\.frame \|\| \{\},/), blk, swap("frame: a.frame || {},", ""),
    "run() collects the argument and drops it before the POST");
}

/* The page's half. The editor holds its shapes in STAGE coordinates already —
 * iedSrcToStage() puts them after the crop and the rotation — so sending them
 * without the crop that defines them asks the server about the uncropped
 * picture. Neither side has anything to complain about. */
both("web/app.js has iedSelFrame()", has(/function iedSelFrame\(\) \{/), app,
  swap("function iedSelFrame() {", "function iedSelFrameUnused() {"), "the helper is renamed");
both("...over the same six keys the routes whitelist", has(FRAME_KEYS), app,
  editAfter("function iedSelFrame()", '"geometry", ', ""),
  "geometry is dropped from the page's copy of the list");
both("...and the shared payload carries it", has(/frame: iedSelFrame\(\),/), app,
  swap("frame: iedSelFrame(),", ""), "the payload builder stops including the frame");
for (const btn of ["iedSelWhat", "iedSelBake"]) {
  both(`the ${btn} button sends that payload rather than a bare selection`,
    has(new RegExp(`\\$\\("${btn}"\\)\\.onclick[\\s\\S]{0,1200}JSON\\.stringify\\(iedSelPayload\\(\\)\\)`)),
    app, editAfter(`$("${btn}").onclick`, "JSON.stringify(iedSelPayload())",
      "JSON.stringify({ name: ied.name, selection: iedSelectionOp() })"),
    "that one button goes back to posting a frameless body");
}

/* ══ 3. THE TYPE TELEMETRY ══════════════════════════════════════════════════
 * imgtext.draw_text folds every compromise it made into a `notes` list — a
 * substituted font, a clamped variation axis, a line that overflowed its box.
 * apply_edit's reply already carries `notes` to the caller. It called draw_text
 * WITHOUT the argument, so the whole channel was silent and the picture came
 * back looking almost right: the wrong typeface, drawn at the size asked for,
 * which is the most plausible-looking failure the type tool has. */
console.log("\n3. THE CHANNEL THAT WAS SILENT");
both("imagetools.py passes its notes list into draw_text",
  has(/imgtext\.draw_text\(rgba, spec, notes=_notes\)/), tools,
  swap("imgtext.draw_text(rgba, spec, notes=_notes)", "imgtext.draw_text(rgba, spec)"),
  "the call drops the argument, exactly as it shipped");
both("...and the reply hands those notes on rather than collecting them for itself",
  has(/if _notes:\n        _reply\["notes"\] = _notes/), tools,
  cut('        _reply["notes"] = _notes\n'), "the reply stops carrying notes");
both("draw_text still takes the argument this call passes",
  has(/def draw_text\([^)]*notes/), imgtext,
  swap("def draw_text(", "def draw_text_renamed("),
  "the function is renamed, which would make the call above a NameError rather than a silent pass");

/* ══ 4. THE MEASURE AND CHECK DOORS ═════════════════════════════════════════
 * Three links each, and each of these has previously shipped with one link
 * missing: the module's CLI mode, the route that spawns it, and the tool that
 * posts the route. A missing mode prints "unknown mode" and exits 1; a missing
 * route is a 404 the page swallows into a status line; a missing tool is a
 * capability no assistant will ever discover. None of the three is visible from
 * either of the others. */
console.log("\n4. WHERE THE TYPE LANDS, AND WHY A LETTER FILLED SOLID");
for (const [mod, text, mode, route, tool, fn] of [
  ["imgtext.py", imgtext, "measure", "/api/images/measure-text", "measure_text", "measure_text"],
  ["imgpath.py", imgpath, "check", "/api/images/check-figure", "check_figure", "check_figure"],
]) {
  both(`${mod} has a \`${mode}\` CLI mode`,
    has(new RegExp(`elif mode == "${mode}":`)), text,
    swap(`elif mode == "${mode}":`, `elif mode == "${mode}_disabled":`),
    "the mode word is renamed, which the module answers with `unknown mode`");
  both(`...and that mode calls ${fn}()`,
    has(new RegExp(`${fn}\\(`)), text.slice(text.indexOf(`elif mode == "${mode}":`)),
    swap(`${fn}(`, "_nothing("), "the mode stops calling the function it exists for");
  const blk = routeBlock(`if (p === "${route}" && req.method === "POST")`);
  ok(`${route} is a route`, blk.length > 400);
  both(`...and it spawns ${mod} in "${mode}" mode`,
    has(new RegExp(`spawn\\(config\\.python, \\[path\\.join\\(__dirname, "${mod.replace(".", "\\.")}"\\), "${mode}", jobPath\\]`)),
    blk, swap(`"${mode}", jobPath`, '"catalog", jobPath'),
    "the spawn asks for a different mode, which returns a perfectly valid answer to another question");
  both(`there is a ${tool} tool`, has(new RegExp(`\\n    name: "${tool}",`)), mcp,
    swap(`\n    name: "${tool}",`, `\n    name: "${tool}_x",`), "the tool is renamed");
  both(`...and ${tool} posts ${route}`,
    has(new RegExp(`api\\("POST", "${route}"`)), toolBlock(tool),
    swap(`"${route}"`, '"/api/images/edit"'), "the tool is repointed at another route");
}
/* ⚠ THE REPORT'S `ok` AND THE ENVELOPE'S `ok` ARE DIFFERENT WORDS. A figure
 * with a backwards hole is a SUCCESSFUL diagnosis, not a failed request, and
 * collapsing the two would make the door refuse exactly the case it exists for
 * — the caller would see an error and learn nothing about the letter. */
both("imgpath's check envelope keeps the report's own verdict separate from the call's",
  has(/print\(_json\.dumps\(\{"ok": True, "report": _rep,/), imgpath,
  swap('{"ok": True, "report": _rep,', '{"ok": _rep["ok"], "report": _rep,'),
  "the envelope adopts the figure's verdict, so a diagnosed figure reads as a failed request");
both("...and the route reads the report out of that envelope rather than the envelope itself",
  has(/const rep = r\.report \|\| \{\};/),
  routeBlock('if (p === "/api/images/check-figure" && req.method === "POST")'),
  swap("const rep = r.report || {};", "const rep = r;"),
  "the route reads the envelope as the report");

/* ══ 5. THE DOCUMENT SHELF ══════════════════════════════════════════════════
 * A layered document had been renderable since imgdoc.py was written, and it
 * lived for exactly one POST: build a twelve-layer comp, render it, and nothing
 * on disk was the comp. Every program that does this has a file for it. */
console.log("\n5. THE DOCUMENT SHELF");
for (const [mode, fn, route, tool] of [
  ["store", "store_job", "/api/images/documents", "image_documents"],
  ["edit", "edit_job", "/api/images/document-edit", "document_edit"],
]) {
  /* ⚠ THE MUTATION HAS TO LAND ON THE DISPATCH, NOT ON THE DEFINITION.
   * `def store_job(job):` contains the substring `store_job(job)`, so a plain
   * first-occurrence swap renamed the function's own header and left the
   * dispatch line — and the pin, reading only the dispatch, stayed green on a
   * tree it was supposed to condemn. Anchoring at the mode word fixes it. */
  both(`imgdoc.py dispatches "${mode}" to ${fn}`,
    has(new RegExp(`if mode == "${mode}":\\n            print\\(json\\.dumps\\(${fn}\\(job\\)\\)\\)`)),
    imgdoc, editAfter(`if mode == "${mode}":`, `${fn}(job)`, "_nothing(job)"),
    "the dispatch stops calling it");
  const blk = routeBlock(`if (p === "${route}" && req.method === "POST")`);
  ok(`${route} is a route`, blk.length > 400);
  both(`...and it spawns imgdoc.py in "${mode}" mode`,
    has(new RegExp(`\\[path\\.join\\(__dirname, "imgdoc\\.py"\\), "${mode}", jobPath\\]`)), blk,
    swap(`"imgdoc.py"), "${mode}", jobPath`, '"imgdoc.py"), "render", jobPath'),
    "the spawn asks imgdoc for a render instead");
  /* ⚠ THE SHELF PATH IS AN ABSOLUTE PATH ON THIS MACHINE. It is useful to the
   * engine and to nobody on the other end of an HTTP reply; shipping it to a
   * browser is how a directory layout leaks, and it leaks on EVERY successful
   * call rather than on some rare error path. */
  both(`...and ${route} DELETES the shelf path before answering`,
    before("delete r.shelf;", "return json(res, 200,"), blk,
    cut("        delete r.shelf;\n"),
    "the delete is removed, so an absolute path on this machine goes to the browser");
  both(`there is a ${tool} tool posting ${route}`,
    has(new RegExp(`api\\("POST", "${route}"`)), toolBlock(tool),
    swap(`"${route}"`, '"/api/images/edit"'), "the tool is repointed at another route");
}
/* ⚠ AND THE DELETE ABOVE IS ONLY LOAD-BEARING BECAUSE THE ENGINE SENDS ONE.
 * If imgdoc stopped returning `shelf`, the two `delete` lines would become
 * decoration and the pins on them would be pinning nothing — so the thing they
 * protect against is asserted at its source as well. */
both("imgdoc.py really does return the shelf path, which is what the deletes are for",
  has(/return \{"ok": True, "shelf": path,/), imgdoc,
  swapAll('return {"ok": True, "shelf": path,', 'return {"ok": True,'),
  "the engine stops sending it, which would make both route-side deletes vacuous");

/* ══ 6. THE DOORS, RUN ══════════════════════════════════════════════════════
 * ⚠ SOURCE-TEXT PINS ROT, AND WORSE THAN THAT, THEY CANNOT TELL A DIAGNOSIS
 * FROM A CONSTANT. Every pin above would stay green against a check_figure that
 * answered "fine" to everything and a measure_text that returned the same box
 * for every string. So both new CLI modes are RUN here, on inputs whose right
 * answer is known before the call, and — the part that makes it a test rather
 * than a demonstration — on the NEGATIVE of each: a figure that is correct
 * beside one that is not, and a font that is on this rig beside one that is
 * not. If the two answers match, the door is not diagnosing anything. */
console.log("\n6. THE TWO DOORS, ACTUALLY RUN");

const HERE = fileURLToPath(new URL(".", import.meta.url));
/* The engine's venv, because both modules import cv2 and the system python on
 * this machine does not have it. Overridable so the lane is not welded to one
 * disk layout, and EXECUTED rather than merely located: on Windows a bare
 * `python3` resolves to the Store's App Execution Alias, so a path test can
 * succeed against something that only knows how to print "Python was not
 * found". */
/* AIPLAY_IMGDOORS_PY, when it is set, is the ONLY candidate: an explicit
 * override that silently fell through to a hard-coded D: drive would mean
 * nobody could ever exercise the skip branch below, and an untested skip branch
 * is how a lane ends up reporting green on a machine where it ran nothing. */
const PY_CANDIDATES = process.env.AIPLAY_IMGDOORS_PY
  ? [process.env.AIPLAY_IMGDOORS_PY]
  : [
    process.env.AIPLAY_RIG ? join(process.env.AIPLAY_RIG, "venv/Scripts/python.exe") : null,
    "D:/AI/aiplay-studio-bench/venv/Scripts/python.exe",
  ].filter(Boolean);
let PY = null;
for (const cand of PY_CANDIDATES) {
  const probe = spawnSync(cand, ["-c", "import cv2, numpy, PIL; print('ok')"],
    { encoding: "utf8", windowsHide: true, timeout: 60000 });
  if (probe.status === 0 && /ok/.test(probe.stdout || "")) { PY = cand; break; }
}

const runJson = (script, mode, job) => {
  const dir = mkdtempSync(join(tmpdir(), "imgdoors-"));
  const p = join(dir, "job.json");
  try {
    writeFileSync(p, JSON.stringify(job), "utf8");
    const r = spawnSync(PY, [join(HERE, script), mode, p],
      { encoding: "utf8", windowsHide: true, timeout: 120000 });
    const line = (r.stdout || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean).pop();
    if (!line) throw new Error(`${script} ${mode} said nothing: ${(r.stderr || "").slice(-300)}`);
    return JSON.parse(line);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

if (!PY) {
  skip("the two doors are not run on this machine",
    `none of these could import cv2/numpy/PIL: ${PY_CANDIDATES.join(", ")} — set AIPLAY_IMGDOORS_PY or AIPLAY_RIG. A SKIP IS UNRUN, NEVER A PASS.`);
} else {
  console.log(`  (running against ${PY})`);
  /* A square with a square counter in it: the letter 'o', in the only two ways
   * anybody hands one over. Same winding is the bug — under nonzero the counter
   * is not cut out and the glyph comes back a solid blob — and it CANNOT RAISE,
   * because a filled square with a filled square on top of it is a figure
   * somebody might genuinely mean. */
  const outer = { points: [[0, 0], [100, 0], [100, 100], [0, 100]], closed: true };
  const sameWound = { points: [[30, 30], [70, 30], [70, 70], [30, 70]], closed: true };
  const counterWound = { points: [[30, 30], [30, 70], [70, 70], [70, 30]], closed: true };

  let wrong = null, right = null;
  try {
    wrong = runJson("imgpath.py", "check", { figure: { paths: [outer, sameWound] } });
    right = runJson("imgpath.py", "check", { figure: { paths: [outer, counterWound] } });
  } catch (e) { ok("imgpath check ran at all", false, e.message); }

  if (wrong && right) {
    const wr = wrong.report || {}, rr = right.report || {};
    ok("a counter wound the SAME way is reported under `solid`",
      wrong.ok === true && Array.isArray(wr.solid) && wr.solid.includes(1),
      `solid was ${JSON.stringify(wr.solid)} — the door answered, but not about the winding`);
    ok("...with a non-empty `problems` naming it, since nothing else ever will",
      Array.isArray(wr.problems) && wr.problems.length > 0
        && /wind|hole|solid/i.test(wr.problems.join(" ")),
      JSON.stringify(wr.problems));
    ok("...and the report's own verdict is false while the CALL still succeeded",
      wr.ok === false && wrong.ok === true,
      "a diagnosed figure must be a successful diagnosis, not a failed request");
    ok("a counter wound the OTHER way is reported under `holes`, with ok:true",
      Array.isArray(rr.holes) && rr.holes.includes(1) && rr.ok === true
        && Array.isArray(rr.problems) && rr.problems.length === 0,
      `holes ${JSON.stringify(rr.holes)}, ok ${rr.ok}, problems ${JSON.stringify(rr.problems)}`);
    /* ⚠ THE NEGATIVE THAT MAKES THE TWO ABOVE REAL. A check_figure that
     * returned the same report for every figure would satisfy one of them and
     * look like a working door. The pin is that the two answers DIFFER. */
    ok("...and the two answers genuinely DIFFER, so the door is diagnosing rather than reciting",
      wr.ok !== rr.ok && JSON.stringify(wr.solid) !== JSON.stringify(rr.solid)
        && JSON.stringify(wr.holes) !== JSON.stringify(rr.holes),
      "both figures got the same verdict: this door is not looking at the winding at all");
  }

  /* ⚠ AN inkBox MUST BE AN OBJECT. Every caller reads `.x`, `.w`, `.h` off it
   * to size a canvas to its type; an array would give each of those `undefined`
   * and the arithmetic downstream produces NaN, which lays out as a frame at
   * position zero of size nothing and raises nothing anywhere. */
  const BOGUS = "NoSuchFontOnThisRig-Zzz";
  let bogus = null, plain = null;
  try {
    bogus = runJson("imgtext.py", "measure", { text: { content: "HEADLINE", size: 72, font: BOGUS } });
    plain = runJson("imgtext.py", "measure", { text: { content: "HEADLINE", size: 72 } });
  } catch (e) { ok("imgtext measure ran at all", false, e.message); }

  if (bogus) {
    const b = bogus.inkBox;
    ok("measure returns an inkBox OBJECT, not an array",
      b !== null && typeof b === "object" && !Array.isArray(b),
      `inkBox was ${Array.isArray(b) ? "an array" : typeof b}`);
    ok("...with finite x, y, w and h on it",
      b && ["x", "y", "w", "h"].every((k) => Number.isFinite(b[k])) && b.w > 0 && b.h > 0,
      JSON.stringify(b));
    ok("a font that is not on this rig sets the fallback marker",
      bogus.font && bogus.font.fallback === true && bogus.font.path === null,
      JSON.stringify(bogus.font));
    ok("...and says so in words, naming the font that was asked for",
      Array.isArray(bogus.warnings) && bogus.warnings.some((w) => String(w).includes(BOGUS)),
      JSON.stringify(bogus.warnings));
  }
  /* ⚠ AND THE NEGATIVE: a marker hard-coded to true would pass every line
   * above. This asks for a face that IS installed and requires the marker to go
   * the other way. On a machine with no default face there is nothing to
   * compare against, so it says so rather than passing. */
  if (plain) {
    if (plain.font && typeof plain.font.path === "string" && plain.font.path) {
      ok("...while a font that IS on this rig does not — the marker is measured, not constant",
        plain.font.fallback === false
          && !(plain.warnings || []).some((w) => /fell back/.test(String(w))),
        JSON.stringify(plain.font));
    } else {
      skip("the fallback marker's negative half",
        `the default face (${plain.font && plain.font.asked}) is not installed here either, so there is nothing that must come back fallback:false. A SKIP IS UNRUN, NEVER A PASS.`);
    }
  }
}

/* ─────────── THE PAGE'S PATH INTO THE TYPE CATALOG, RESOLVED ───────────
 *
 * ⚠ THREE LEVELS OF "text" AND THEY ARE THREE DIFFERENT THINGS: the MODULE
 * (imgtext), the CATALOG it publishes under the key "text", and the OP named
 * "text" inside that catalog. A reader that stops one level early gets a
 * perfectly good object rather than an error — which is how the ENTIRE
 * Character / Paragraph dock came to render nothing, with no console error,
 * for as long as it did. 56 parameter rows in six groups, all absent.
 *
 * ⚠ AND A SOURCE-TEXT PIN ALONE CANNOT CATCH IT. "app.js mentions
 * iedToolsCat.text" was true the whole time it was broken. So this takes the
 * depth the page encodes and RESOLVES it against the catalog imgtext actually
 * publishes. Move either side and the path stops resolving. */
{
  const app = src("../web/app.js");
  const m = app.match(/const iedTypeCat = \(\) => iedToolsCat\?\.([A-Za-z?.]+) \|\|/);
  ok("web/app.js names the type catalog's depth in ONE place",
    !!m,
    "iedTypeCat() is the single home for a chain where every level is spelled "
    + "`text`; without it, three readers each guess the depth separately and two "
    + "of them guessed wrong");

  /* The two spellings that were wrong. Pinned by name because each was a
   * DIFFERENT wrong depth, and fixing one taught nothing about the other. */
  ok("...and no reader reaches for the module's reply as if it were the catalog",
    !/const cat = iedToolsCat\?\.text;/.test(app),
    "`iedToolsCat.text` is {text, groups, names, notes} — it has no `params`, so "
    + "`cat.text.params` is undefined and Object.entries() throws");
  ok("...and the capability gate does not test the catalog for a params it cannot have",
    !/iedToolsCat\?\.text\?\.text\?\.params/.test(app),
    "`iedToolsCat.text.text` is the catalog keyed by OP NAME; asking it for "
    + ".params is always undefined, so the type capability read as dark forever");

  if (PY) {
    /* ⚠ THE FIRST SEGMENT NAMES THE MODULE, NOT A KEY INSIDE IT.
     * `iedToolsCat.text` IS imgtext.catalog() — the tools route keys the reply
     * by module name. So only what follows applies inside the catalog, and a
     * walk that starts at the top over-shoots by exactly one level: the same
     * off-by-one, in the pin written to catch it. */
    const depth = (m ? m[1].replace(/\?/g, "").split(".").filter(Boolean) : []).slice(1);
    const r = spawnSync(PY, ["-c",
      "import sys, json; sys.path.insert(0, 'server'); import imgtext; "
      + "print(json.dumps(imgtext.catalog()))"],
      { encoding: "utf8", cwd: join(HERE, "..") });
    let cat = null;
    try { cat = JSON.parse((r.stdout || "").trim().split("\n").pop()); } catch { /* reported below */ }
    ok("imgtext publishes a catalog this test can read",
      !!cat, (r.stderr || "").slice(-200));
    if (cat) {
      /* Walk the page's own path, then ask for the `text` op's params the way
       * iedCharPaint does. Both halves have to be right for the dock to draw. */
      let node = cat;
      for (const k of depth) node = node && node[k];
      ok(`the page's path (iedToolsCat.text.${depth.join(".")}) resolves against the real catalog`,
        !!node && typeof node === "object",
        `walked ${depth.join(" -> ")} and got ${node === undefined ? "undefined" : typeof node}`);
      ok("...and the `text` op it then reads has the parameters the dock draws",
        !!(node && node.text && node.text.params
           && Object.keys(node.text.params).length > 10),
        `the dock renders one row per parameter; got ${
          node && node.text && node.text.params
            ? Object.keys(node.text.params).length : "nothing"}`);
      ok("...and the nested groups it expands resolve too",
        !!(node && node.text && node.text.params
           && Object.entries(node.text.params)
             .filter(([, d]) => d && d.type === "object")
             .every(([, d]) => node[d.of] && node[d.of].params)),
        "iedCharPaint expands an object-typed parameter by looking its `of` up in "
        + "the same catalog; an `of` with no entry is a group that silently vanishes");
    }
  } else {
    skipped++;
    console.log("  skip  the type catalog's depth (no python — A SKIP IS UNRUN, NEVER A PASS)");
  }
}

/* ── painting a document layer ─────────────────────────────────────────────
 *
 * The door that made a raster layer reachable. The raster layer itself was
 * never missing - an `image` layer's pixels are a library picture - but nothing
 * could paint one, so the standing conclusion was that a whole new layer kind
 * had to be built first. */
{
  const route = index.slice(index.indexOf('p === "/api/images/document-paint"'));
  const body = route.slice(0, 4000);

  both("only an IMAGE layer is painted, because every other kind regenerates",
    has(/found\.type !== "image"/), body, cut(/found\.type !== "image" \|\| /),
    "the kind check is dropped and a stroke goes into a layer that will discard it");

  /* \u26a0 THE ONE THAT WOULD HURT. One library picture can be the source of
   * several layers in several documents; painting in place would rewrite
   * pictures nobody asked about, and the symptom would be somebody ELSE's
   * document changing. */
  both("the paint writes a NEW picture rather than over the layer's source",
    (t) => /_p\$\{stamp\}\.png/.test(t) && !/out:\s*src\b/.test(t),
    body, swap(/const outName = `\$\{path\.basename\(found\.src\)\.replace\(\/\\\.\[\^\.\]\+\$\/, ""\)\}_p\$\{stamp\}\.png`/,
               'const outName = path.basename(found.src)'),
    "the destination becomes the source name, which edits every other layer that shares it");

  both("a locked layer is refused at this door too",
    has(/found\.locked/), body, cut(/if \(found\.locked\) \{/),
    "the lock check is removed and a locked layer paints anyway");

  both("it paints through the worker running apply_edit, not a second rasteriser",
    has(/imgWorker\(\)\.run\("edit"/), body, swap(/imgWorker\(\)\.run\("edit"/, 'somethingElse("edit"'),
    "the shared engine is swapped out, which is the duplicated implementation imgstroke forbids");
}

console.log(`\n  ${passed} passed, ${failed} failed, ${skipped} skipped`);
assert.equal(failed, 0, `${failed} image-door pins failed`);
