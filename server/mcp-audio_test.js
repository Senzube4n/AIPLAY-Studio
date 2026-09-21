/**
 * THE AUDIO-FINISHING SURFACE — what each tool actually puts on the wire.
 *
 * ── the failures this lane is aimed at ──────────────────────────────────────
 *
 * 1. DECLARED AND DROPPED. `additionalProperties: false` means a client trusts
 *    the schema absolutely: an undeclared key is REFUSED, so every key a caller
 *    can send is one this file promised to honour. A property that is declared
 *    and never read gives a call that validates, returns 200, and silently does
 *    something other than what was asked. That has happened three times in this
 *    repository this week — eleven working ops then `save_selection`, then
 *    image_to_svg's paint parameters. The sweep below is the same one
 *    mcp-vfx_test.js runs, extended to the NESTED op objects, because
 *    audio_edit_song's real parameters live one level down and a top-level-only
 *    sweep would report full coverage while checking two properties out of
 *    thirteen.
 *
 * 2. A RENAME THAT ONLY HALF HAPPENED. Three keys change spelling between the
 *    schema and the wire — fade_in/fade_out become `in`/`out`, and `with_file`
 *    becomes `with` as an absolute path. A rename is the one shape the sweep in
 *    (1) cannot judge, since the schema name appears in run() either way. So
 *    each one is asserted on the BODY, by driving the tool and reading what it
 *    posted.
 *
 * 3. THE ROUTING DECISION GOING STALE. server/chat/router.js classes all five
 *    writing tools as costing rather than DESTROYING, and the whole basis for
 *    that is that /api/edit and /api/merge write a new file and never touch
 *    their sources. That is a fact about server/index.js, not about this file,
 *    and it would stop being true silently. It is read out of index.js here.
 *
 * Every assertion is on the tool as an MCP client gets it: the factory is
 * called with a recording `api`, the tools are driven, and the recorded body is
 * what is judged. Nothing here reaches the network, the card or the library.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { audioTools } from "./mcp-audio.js";
import { ROUTABLE, WITHHELD, COST_TEXT } from "./chat/router.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(HERE, rel), "utf8");

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

/* ────────────────────────────────────────────────────────── the harness */

const OUTPUT_DIR = "D:\\AI\\rig\\ComfyUI\\output";

/**
 * A recording `api`, answering each route with the shape the real one does.
 *
 * The replies are thin on purpose — this lane judges what goes OUT. The one
 * field that has to be right is /api/status's `config.paths.outputDir`, because
 * that is where join and replace get the folder they resolve `with_file`
 * against, and a tool that silently posted an unresolved name would splice
 * nothing and say it worked.
 */
function harness() {
  const calls = [];
  const api = async (method, route, body) => {
    calls.push({ method, route, body });
    if (route === "/api/status") return { config: { paths: { outputDir: OUTPUT_DIR } } };
    if (route === "/api/export/formats") return { mp3: { qualities: ["V0", "128k", "320k"], lossy: true } };
    if (route === "/api/edit") return { file: "edit_1.flac", seconds: 4, rate: 44100 };
    if (route === "/api/merge") return { file: "merge_1.flac", seconds: 9, rate: 44100, merged: 2 };
    if (route === "/api/export") return { file: "x.mp3", subfolder: "exports", seconds: 3, runId: "r1", provenance: "tags" };
    if (route === "/api/timeline/render") {
      return { name: "mv_x.mp4", out: "D:\\x\\mv_x.mp4", total: 1.5, w: 320, h: 200, fps: 24,
               clips: 2, missing: [], song: false, encoder: "h264_nvenc", bytes: 7062 };
    }
    return {};
  };
  /* The same rule server/mcp.js applies, handed in the same way. It is
   * reimplemented rather than imported because mcp.js does not export it and
   * importing mcp.js to get at it would build all 302 tools for one function —
   * so the pin below reads mcp.js's own definition and this copy side by side,
   * and fails if they stop agreeing. */
  const safeName = (name, what = "file") => {
    const s = String(name || "");
    if (!s || s.includes("..") || s.includes("/") || s.includes("\\")) {
      throw new Error(`Bad ${what} name: ${JSON.stringify(s)}`);
    }
    return s;
  };
  return { calls, tools: audioTools(api, safeName), last: () => calls[calls.length - 1] };
}

const { tools } = harness();
const byName = new Map(tools.map((t) => [t.name, t]));
const sourceOf = (fn) => String(fn) + (fn?.unwrappedRun ? String(fn.unwrappedRun) : "");

/** Drive one tool on a fresh harness and hand back what it posted. */
async function drive(name, args) {
  const h = harness();
  const tool = h.tools.find((t) => t.name === name);
  const result = await tool.run(args);
  return { result, calls: h.calls, posted: h.calls.filter((c) => c.method === "POST") };
}
/**
 * A pin on somebody else's source, checked TWICE — once on the real text and
 * once on a copy with its subject taken out.
 *
 * ⚠ A SOURCE PIN IS THE EASIEST KIND OF CHECK TO WRITE WRONG. A regular
 * expression over a 9,000-line file passes for reasons that have nothing to do
 * with what it claims to be reading: an over-broad pattern, a slice that
 * happened to include the wrong route, a `.test()` on text the reader never
 * actually loaded. The one way to know it is reading what it says is to remove
 * that thing and watch it go red, so every pin below does exactly that in the
 * same breath — the rule server/imgdoors_test.js already runs under, where it
 * caught six of its own pins passing on a broken tree on their first run.
 *
 * `breakIt` must genuinely change the text; a no-op damage is reported as its
 * own failure, because a break that breaks nothing proves nothing.
 */
function sourcePin(label, text, test, whatBroke, breakIt) {
  ok(label, test(text), "not found in the source this pin claims to read");
  const broken = breakIt(text);
  ok(`...and it FAILS with ${whatBroke}`, broken !== text && !test(broken),
    broken === text
      ? "the damage changed nothing — this is not a break, so the pin above is unproven"
      : "the pin still matched after its subject was removed: it is not reading what it claims to");
}

/** Drive one tool expecting a refusal, and hand back the sentence. */
async function refuse(name, args) {
  const h = harness();
  const tool = h.tools.find((t) => t.name === name);
  try {
    await tool.run(args);
    return { refused: false, message: "", posted: h.calls.filter((c) => c.method === "POST") };
  } catch (err) {
    return { refused: true, message: String(err.message), posted: h.calls.filter((c) => c.method === "POST") };
  }
}

/* ─────────────────────────────────────────────────────── §1 well formed */

console.log("\n§1  the tool list is well formed");

ok("every tool has a name, a description, a schema and a run",
  tools.every((t) => t.name && t.description && t.inputSchema && typeof t.run === "function"));

const names = tools.map((t) => t.name);
ok(`no duplicate tool names (${names.length} tools)`, new Set(names).size === names.length,
  names.filter((n, i) => names.indexOf(n) !== i).join(", "));

ok("every name is prefixed audio_, so the family is one thing on a 302-tool surface",
  names.every((n) => n.startsWith("audio_")), names.filter((n) => !n.startsWith("audio_")).join(", "));

ok("every required parameter is also declared",
  tools.every((t) => (t.inputSchema.required || []).every((r) => t.inputSchema.properties?.[r])),
  tools.filter((t) => (t.inputSchema.required || []).some((r) => !t.inputSchema.properties?.[r]))
    .map((t) => t.name).join(", "));

/* ⚠ THE LINE THAT MAKES §2 MEAN ANYTHING. Without additionalProperties:false an
 * undeclared key is IGNORED rather than refused, and a caller's typo becomes
 * silence instead of an error — which is the exact failure mode every schema in
 * this repository is written to refuse. */
const leaky = tools.filter((t) => t.inputSchema.additionalProperties !== false).map((t) => t.name);
ok("every schema refuses an undeclared key", leaky.length === 0, leaky.join(", "));

const opItems = byName.get("audio_edit_song").inputSchema.properties.ops.items;
ok("...including the nested op object, where the real parameters are",
  opItems.additionalProperties === false);

/* ───────────────────────────────────────────── §2 nothing declared is dropped */

console.log("\n§2  nothing is advertised and then dropped");

/**
 * Parameters a tool takes and does not name in the code that forwards it, on
 * purpose. Empty, and it should stay that way: every parameter on this surface
 * is forwarded by name. An entry here is a decision somebody has to write down.
 */
const IGNORED = {};

/**
 * THE TEXT THIS SWEEP IS ALLOWED TO SEARCH, and getting it wrong in either
 * direction makes the lane worthless.
 *
 * Too narrow and it lies the accusing way: audio_edit_song's thirteen op
 * parameters are translated by `wireOp`, a helper the run() calls, so reading
 * String(tool.run) alone reports every one of them as dropped. The same shape
 * as server/mcp-routes_test.js following a wrapper to the route it posts to.
 *
 * ⚠ TOO WIDE AND IT LIES THE OTHER WAY, WHICH IS WORSE AND WAS NEARLY SHIPPED.
 * The obvious widening — read the whole module — CANNOT FAIL, because the
 * schemas are in that same file: every property name appears in the file by
 * definition, so the search finds itself and every tool passes for ever. So the
 * region stops at `return [`, which is where the tool list and its schemas
 * begin, and it starts at the factory, which leaves the OPS description
 * constant out — that string names every key in prose and would pass a
 * parameter that no code touches.
 *
 * Comments are blanked for the third form of the same mistake: a key mentioned
 * only in a note about it is not a key anything forwards.
 */
const blankComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + " ".repeat(m.length - p.length));

const moduleSrc = read("mcp-audio.js");
const HELPERS = blankComments(moduleSrc.slice(
  moduleSrc.indexOf("export function audioTools("),
  moduleSrc.indexOf("\n  return ["),
));
ok("the helper region excludes the schemas, or this sweep could not fail",
  HELPERS.length > 500 && !HELPERS.includes("inputSchema") && !HELPERS.includes("additionalProperties"),
  `${HELPERS.length} chars; it must hold wireOp and libraryPath and NOT the tool list`);
ok("...and excludes the prose op table, which names every key without forwarding one",
  !HELPERS.includes("APPLIED IN THE ORDER GIVEN"));

/** Every declared parameter, top level and one level into an array's items. */
function declaredParams(tool) {
  const out = [];
  for (const [k, spec] of Object.entries(tool.inputSchema.properties || {})) {
    out.push({ label: k, name: k });
    for (const ik of Object.keys(spec?.items?.properties || {})) out.push({ label: `${k}[].${ik}`, name: ik });
  }
  return out;
}

/**
 * The sweep itself, as a function so it can be pointed at a planted defect.
 *
 * ⚠ WHAT IT CANNOT SEE, said rather than left to be found. It asks whether a
 * NAME appears, so a key forwarded on one branch and forgotten on another still
 * passes here: dropping `from` from the replace branch was MEASURED on
 * 2026-09-21 to leave this green, because the join branch still names it. That
 * is the case §4 is for — it reads the body each branch really posted — and the
 * two together are the check. This one catches the whole-parameter class, which
 * is the one that has actually shipped.
 */
function sweep(toolList) {
  const missing = [];
  for (const t of toolList) {
    const src = blankComments(sourceOf(t.run)) + HELPERS;
    const ignored = new Set(IGNORED[t.name] || []);
    for (const { label, name } of declaredParams(t)) {
      if (ignored.has(name)) continue;
      // snake_case in the schema becomes camelCase on the wire; either
      // spelling appearing means the parameter was not forgotten.
      const camel = name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (!src.includes(name) && !src.includes(camel)) missing.push(`${t.name}.${label}`);
    }
  }
  return missing;
}

ok("every declared parameter is named in the code that forwards it", sweep(tools).length === 0,
  `${sweep(tools).join(", ")}\n          Either forward it, or add it to IGNORED with a reason.`);

/* THE SWEEP'S OWN PIN, and it is a real one rather than a count. The loop above
 * passes just as loudly over a schema it cannot see as over one it can, so it
 * is pointed at a tool with a property nobody forwards — once at the top level
 * and once inside the ops, since those are two different walks — and it has to
 * name both. A sweep that reports nothing here is reporting nothing at all. */
{
  const planted = JSON.parse(JSON.stringify(byName.get("audio_edit_song").inputSchema));
  planted.properties.flugelhorn = { type: "string" };
  planted.properties.ops.items.properties.sousaphone = { type: "number" };
  const found = sweep([{ name: "planted", inputSchema: planted, run: byName.get("audio_edit_song").run }]);
  ok("...and the sweep catches a parameter nobody forwards, at BOTH levels",
    found.includes("planted.flugelhorn") && found.includes("planted.ops[].sousaphone"),
    `it found ${JSON.stringify(found)} — if this is empty the sweep above proves nothing`);
}

const swept = tools.reduce((n, t) => n + declaredParams(t).length, 0);
ok(`the sweep weighed every parameter on the surface (${swept})`, swept >= 25,
  "it is passing because it is checking almost nothing — the items walk has stopped working");

/* ───────────────────────────────────────────────────── §3 the doors */

console.log("\n§3  every tool reaches the door it claims, and no other");

const DOORS = {
  audio_edit_song: "/api/edit",
  audio_trim_song: "/api/edit",
  audio_merge_takes: "/api/merge",
  audio_export_song: "/api/export",
  audio_render_timeline: "/api/timeline/render",
};
for (const [name, route] of Object.entries(DOORS)) {
  ok(`${name} names ${route} and nothing else`,
    sourceOf(byName.get(name).run).includes(`"${route}"`),
    `run() does not mention ${route}`);
}
ok("audio_export_formats reads GET /api/export/formats",
  sourceOf(byName.get("audio_export_formats").run).includes("/api/export/formats"));

{
  const { posted } = await drive("audio_trim_song", { file: "a.flac", start: 1, end: 5 });
  ok("...and driving one really does post there, once", posted.length === 1 && posted[0].route === "/api/edit",
    JSON.stringify(posted.map((p) => p.route)));
}

/* ──────────────────────────────────────── §4 the seven ops, on the wire */

console.log("\n§4  each of the seven ops becomes the shape edit_audio.py reads");

/* The op table is server/edit_audio.py's docstring, and these are the keys it
 * reads with op.get(). A key this file renames wrongly is not an error there:
 * the Python takes the default and the edit silently does something else. */
{
  const { posted } = await drive("audio_edit_song", {
    file: "a.flac",
    ops: [
      { op: "trim", start: 1, end: 5 },
      { op: "cut", start: 2, end: 3 },
      { op: "fade", fade_in: 0.4, fade_out: 2.5 },
      { op: "reverse" },
      { op: "speed", rate: 1.5 },
    ],
  });
  const ops = posted[0].body.ops;
  ok("the body carries file and ops, and nothing else",
    JSON.stringify(Object.keys(posted[0].body).sort()) === '["file","ops"]',
    JSON.stringify(Object.keys(posted[0].body)));
  ok("the ops arrive IN THE ORDER GIVEN, which is the whole contract",
    ops.map((o) => o.op).join(",") === "trim,cut,fade,reverse,speed", ops.map((o) => o.op).join(","));
  ok("trim carries start and end", ops[0].start === 1 && ops[0].end === 5, JSON.stringify(ops[0]));
  ok("cut carries start and end", ops[1].start === 2 && ops[1].end === 3, JSON.stringify(ops[1]));
  /* ⚠ THE RENAME. The wire spelling is `in` and `out`; the schema says fade_in
   * and fade_out because `in` is a reserved word and reads as nothing. Half a
   * rename is a fade of zero and a caller who cannot tell. */
  ok("fade_in and fade_out reach the wire as `in` and `out`",
    ops[2].in === 0.4 && ops[2].out === 2.5 && ops[2].fade_in === undefined,
    JSON.stringify(ops[2]));
  ok("reverse carries nothing but itself",
    JSON.stringify(ops[3]) === '{"op":"reverse"}', JSON.stringify(ops[3]));
  ok("speed carries rate", ops[4].rate === 1.5, JSON.stringify(ops[4]));
  ok("no op carries a key edit_audio.py does not read",
    ops.every((o) => Object.keys(o).every((k) =>
      ["op", "start", "end", "with", "at", "to", "from", "fade", "in", "out", "rate"].includes(k))),
    JSON.stringify(ops));
}

{
  const { posted } = await drive("audio_edit_song", {
    file: "a.flac",
    ops: [
      { op: "join", with_file: "b.flac", at: 1e9, from: 30, fade: 0.12 },
      { op: "replace", with_file: "c.flac", at: 2, to: 5, from: 1 },
    ],
  });
  const [join, replace] = posted[0].body.ops;
  /* ⚠ THE OTHER RENAME, and the reason this module reads /api/status at all:
   * edit_audio.py opens `with` as a PATH, and /api/edit forwards the ops array
   * verbatim without resolving anything. A bare library name here is a file the
   * Python cannot open. */
  ok("join's with_file becomes `with`, resolved against the Studio's output folder",
    join.with === `${OUTPUT_DIR}\\b.flac` && join.with_file === undefined, JSON.stringify(join));
  ok("...and the separator is the SERVER's, since the Python runs on that side",
    join.with.includes("\\") && !join.with.includes("/"), join.with);
  ok("join keeps at, from and fade", join.at === 1e9 && join.from === 30 && join.fade === 0.12,
    JSON.stringify(join));
  ok("replace resolves its own with_file and keeps at, to and from",
    replace.with === `${OUTPUT_DIR}\\c.flac` && replace.at === 2 && replace.to === 5 && replace.from === 1,
    JSON.stringify(replace));
  ok("an omitted optional is ABSENT rather than sent as undefined — edit_audio.py "
    + "reads op.get(\"fade\", 0.08) and a null would not take the default",
    !("fade" in replace), JSON.stringify(replace));
}

{
  /* The folder is asked for ONCE per process, not once per splice. */
  const h = harness();
  const tool = h.tools.find((t) => t.name === "audio_edit_song");
  await tool.run({ file: "a.flac", ops: [{ op: "join", with_file: "b.flac" }] });
  await tool.run({ file: "a.flac", ops: [{ op: "join", with_file: "c.flac" }] });
  ok("the output folder is read once and remembered, not once per op",
    h.calls.filter((c) => c.route === "/api/status").length === 1,
    `${h.calls.filter((c) => c.route === "/api/status").length} status reads`);
}

{
  /* An op with no with_file must not reach /api/status at all: a tool that
   * asked the server where its library is and THEN refused would be spending a
   * round trip to learn nothing. */
  const { posted } = await drive("audio_edit_song", { file: "a.flac", ops: [{ op: "reverse" }] });
  ok("an op that needs no file never asks where the library is", posted.length === 1);
}

/* ───────────────────────────────────────────────── §5 the flat editor */

console.log("\n§5  audio_trim_song is the flat form of the editor's own two modes");

{
  const { posted, result } = await drive("audio_trim_song",
    { file: "a.flac", start: 1, end: 5, fade_in: 0.4, fade_out: 2.5 });
  const ops = posted[0].body.ops;
  ok("a plain selection becomes trim", ops[0].op === "trim" && ops[0].start === 1 && ops[0].end === 5,
    JSON.stringify(ops));
  /* ⚠ TRIM FIRST, THEN FADE. The other order fades a stretch the trim then
   * throws away, and the result is a hard cut into a sustained note — which is
   * the click the Music page's editor adds this fade to avoid. */
  ok("...and the fade comes AFTER it, on the edges the trim just made",
    ops.length === 2 && ops[1].op === "fade" && ops[1].in === 0.4 && ops[1].out === 2.5,
    JSON.stringify(ops));
  ok("the answer says what was kept", result.kept === "1-5" && result.removed === null,
    JSON.stringify(result));
}
{
  const { posted, result } = await drive("audio_trim_song", { file: "a.flac", start: 2, end: 4, cut: true });
  ok("cut:true becomes the cut op instead, and adds no fade",
    posted[0].body.ops.length === 1 && posted[0].body.ops[0].op === "cut",
    JSON.stringify(posted[0].body.ops));
  ok("...and the answer says what was removed rather than what was kept",
    result.removed === "2-4" && result.kept === null, JSON.stringify(result));
}
{
  const { posted } = await drive("audio_trim_song", { file: "a.flac", start: 1, end: 5 });
  ok("no fade asked for is no fade op — not a fade of zero",
    posted[0].body.ops.length === 1, JSON.stringify(posted[0].body.ops));
}

/* ─────────────────────────────────────────────────── §6 the refusals */

console.log("\n§6  every refusal names the damage, and costs no round trip");

const REFUSALS = [
  ["an op that is not one of the seven", "audio_edit_song",
    { file: "a.flac", ops: [{ op: "stretch" }] }, /not an op/],
  ["cut with no end", "audio_edit_song", { file: "a.flac", ops: [{ op: "cut", start: 2 }] }, /needs `start` and `end`/],
  ["trim with end before start", "audio_edit_song",
    { file: "a.flac", ops: [{ op: "trim", start: 5, end: 2 }] }, /not after start/],
  ["join with no with_file", "audio_edit_song", { file: "a.flac", ops: [{ op: "join", at: 3 }] }, /needs `with_file`/],
  ["replace with no `to`", "audio_edit_song",
    { file: "a.flac", ops: [{ op: "replace", with_file: "b.flac", at: 2 }] }, /needs `at` and `to`/],
  ["fade with neither edge", "audio_edit_song", { file: "a.flac", ops: [{ op: "fade" }] }, /fade_in.*fade_out/],
  ["speed with no rate", "audio_edit_song", { file: "a.flac", ops: [{ op: "speed" }] }, /needs `rate`/],
  ["speed at zero, which would produce no audio", "audio_edit_song",
    { file: "a.flac", ops: [{ op: "speed", rate: 0 }] }, /above zero/],
  ["a start that is not a number", "audio_edit_song",
    { file: "a.flac", ops: [{ op: "trim", start: "one", end: 5 }] }, /needs a number/],
  ["an empty ops list", "audio_edit_song", { file: "a.flac", ops: [] }, /at least one op/],
  ["a zero-length selection", "audio_trim_song", { file: "a.flac", start: 5, end: 5 }, /after `start`/],
  ["one file to merge", "audio_merge_takes", { files: ["a.flac"] }, /at least two/],
  ["a with_file that climbs out of the library", "audio_edit_song",
    { file: "a.flac", ops: [{ op: "join", with_file: "../../etc/passwd" }] }, /Bad library file name/],
  ["a track name that climbs out of the library", "audio_trim_song",
    { file: "../../etc/passwd", start: 1, end: 2 }, /Bad track name/],
  /* ⚠ BOTH HALVES OR NEITHER. The route refuses this too and its sentence is a
   * good one; this refusal is here so the caller learns it without spending a
   * round trip, and so the pair is impossible to get to by accident. */
  ["beat_zoom with no beats_file", "audio_render_timeline",
    { project: "P", beat_zoom: 0.015 }, /needs `beats_file`/],
  ["beats_file with no beat_zoom", "audio_render_timeline",
    { project: "P", beats_file: "b.json" }, /needs `beat_zoom`/],
];
for (const [label, tool, args, shape] of REFUSALS) {
  const r = await refuse(tool, args);
  ok(`refuses ${label}`, r.refused && shape.test(r.message), r.refused ? r.message : "it was ACCEPTED");
  ok(`...and posts nothing when it does`, r.posted.length === 0,
    JSON.stringify(r.posted.map((p) => p.route)));
}

/* ──────────────────────────────────────────── §7 the timeline renderer */

console.log("\n§7  the timeline renderer, and the difference it exists for");

{
  const { posted, result } = await drive("audio_render_timeline",
    { project: "Hex Appeal — video", fade: 0.25, beat_zoom: 0.015, beats_file: "beats.json" });
  ok("it posts the route's own snake_case spelling, not camelCase",
    "beat_zoom" in posted[0].body && "beats_file" in posted[0].body,
    JSON.stringify(Object.keys(posted[0].body)));
  ok("the project name goes through UNSLUGGED — the route slugs it, and slugging "
    + "twice would look up a project nobody saved",
    posted[0].body.project === "Hex Appeal — video", posted[0].body.project);
  ok("the answer names the clip, its length and what was missing",
    result.clip === "mv_x.mp4" && result.seconds === 1.5 && Array.isArray(result.missing),
    JSON.stringify(result));
  ok("...and which encoder ran, since nvenc falling back to libx264 is the "
    + "difference between seconds and minutes", result.encoder === "h264_nvenc");
}
{
  const { posted } = await drive("audio_render_timeline", { project: "P" });
  ok("no pulse asked for sends a zero amplitude and no beats file",
    posted[0].body.beat_zoom === 0 && posted[0].body.beats_file === undefined,
    JSON.stringify(posted[0].body));
}

/* ⚠ THE SENTENCE THE WHOLE TOOL EXISTS FOR. An agent reading this description
 * has to learn that Studio's Export button is NOT this: it is a real-time
 * MediaRecorder capture that judders. Losing that line is how a caller
 * cheerfully advises somebody to wait 148 seconds for a 148-second video. */
{
  const d = byName.get("audio_render_timeline").description;
  sourcePin("the description says this is not Studio's export button",
    d, (s) => /NOT STUDIO'S EXPORT BUTTON/i.test(s),
    "that sentence softened to \"the export button\"",
    (s) => s.replace(/NOT STUDIO'S EXPORT BUTTON/i, "the export button"));
  sourcePin("...and names the measured judder that is the reason",
    d, (s) => /17 fps/.test(s) && /requested\s+24/.test(s),
    "the measurement replaced by an adjective",
    (s) => s.replace("17 fps", "fewer frames").replace("requested 24", "asked-for rate"));
  sourcePin("...and says it overwrites its own output",
    d, (s) => /OVERWRITES ITS OWN OUTPUT/i.test(s),
    "the overwrite warning dropped",
    (s) => s.replace(/OVERWRITES ITS OWN OUTPUT/i, "writes a file"));
}

/* ─────────────────────────────── §8 the facts the descriptions assert */

console.log("\n§8  the descriptions are pinned to the code they describe");

/* ⚠ PITCH SHIFTS WITH TEMPO, BY DESIGN — and "by design" is the load-bearing
 * half. It reads like a defect, so it is exactly the kind of thing a later hand
 * "fixes" into a phase vocoder. If the Python ever stops being a bare resample,
 * this lane fails and the description has to be rewritten rather than quietly
 * becoming false. MEASURED 2026-09-21 through this same code: a 1000 Hz tone
 * came back at 1999.9 Hz at rate 2.0, 500.0 Hz at rate 0.5 and 1250.3 Hz at
 * rate 1.25 — the pitch scales by the rate to three decimal places. */
{
  const py = read("edit_audio.py");
  const d = byName.get("audio_edit_song").description;
  sourcePin("the speed op is still a bare resample in edit_audio.py",
    py, (s) => /if kind == "speed"/.test(s) && /np\.interp/.test(s),
    "np.interp swapped for something else — a phase vocoder would make the pitch claim false",
    (s) => s.replace("np.interp", "stretch.phase_vocoder"));
  sourcePin("...and edit_audio.py still calls the pitch shift deliberate",
    py, (s) => /pitch shifts with it, by design/i.test(s),
    "\"by design\" taken out of the Python's own docstring",
    (s) => s.replace(/pitch shifts with it, by design/i, "pitch shifts with it"));
  sourcePin("...and the tool description says so where an agent will read it",
    d, (s) => /PITCH SHIFTS WITH TEMPO, BY DESIGN/.test(s),
    "the warning removed from the description",
    (s) => s.replace("PITCH SHIFTS WITH TEMPO, BY DESIGN", "changes the speed"));
  sourcePin("...with the measurement, not an adjective",
    d, (s) => /1999\.9 Hz/.test(s) && /1250\.3 Hz/.test(s),
    "the measured frequencies replaced by \"roughly double\"",
    (s) => s.replace("1999.9 Hz", "roughly double").replace("1250.3 Hz", "a bit higher"));
  sourcePin("...and warns that speeding UP aliases, since there is no anti-alias filter",
    d, (s) => /ALIASES/.test(s) && /FOLDS BACK/.test(s),
    "the aliasing warning dropped",
    (s) => s.replace("ALIASES", "is fine").replace("FOLDS BACK", "moves up"));
}

/* The op names in the description are the op names the Python dispatches on.
 * A description that invents an op is a tool an agent calls and a route that
 * answers "unknown op: ..." from inside a Python traceback. */
{
  const py = read("edit_audio.py");
  const declared = byName.get("audio_edit_song").inputSchema.properties.ops.items.properties.op.enum;
  const missing = declared.filter((o) => !new RegExp(`kind == "${o}"`).test(py));
  ok(`every op in the enum is one edit_audio.py dispatches (${declared.length})`,
    missing.length === 0, `not found in the Python: ${missing.join(", ")}`);
  const pyOps = [...py.matchAll(/kind == "([a-z]+)"/g)].map((m) => m[1]);
  ok(`...and every op the Python has is in the enum (${pyOps.length})`,
    pyOps.every((o) => declared.includes(o)), `missing from the tool: ${pyOps.filter((o) => !declared.includes(o)).join(", ")}`);
}

/* ⚠ THE CLAIM THE ROUTING DECISION RESTS ON. "It writes a NEW file and never
 * touches the original" is why none of these tools is classed "destroys". It is
 * a fact about server/index.js and it would stop being true silently — an
 * in-place edit would make the router's table a lie and the confirm card would
 * never mention the take it was about to overwrite. */
{
  const idx = read("index.js");
  /* ONE ROUTE'S OWN TEXT, bounded by the next route rather than by a character
   * count I guessed. The first draft of this read 2400 characters past the
   * /api/merge marker and stopped forty lines short of the art.request it was
   * looking for — a fixed window is a check that fails on a route's length
   * rather than on its behaviour. */
  const routeText = (marker) => {
    const at = idx.indexOf(marker);
    if (at < 0) return "";
    const next = idx.indexOf('if (p === "/api/', at + marker.length);
    return idx.slice(at, next < 0 ? at + 4000 : next);
  };
  const edit = routeText('p === "/api/edit"');
  const merge = routeText('p === "/api/merge"');
  ok("both route bodies were really found, or every pin below is vacuous",
    edit.length > 400 && merge.length > 400, `edit ${edit.length} chars, merge ${merge.length}`);
  sourcePin("/api/edit still writes to a NEW path, not over its source",
    edit, (s) => /const out = path\.join\(config\.outputDir, `edit_\$\{Date\.now\(\)\}\.flac`\)/.test(s),
    "the route rewritten to write back over `src`",
    (s) => s.replace(/const out = path\.join\(config\.outputDir, `edit_\$\{Date\.now\(\)\}\.flac`\)/, "const out = src"));
  sourcePin("...and the source is only ever read",
    edit, (s) => /const src = path\.join\(config\.outputDir, name\)/.test(s) && !/writeFile\(\s*src/.test(s),
    "a writeFile(src, ...) planted in the route",
    (s) => s.replace("const src = path.join(config.outputDir, name)",
      "const src = path.join(config.outputDir, name); await writeFile(src, buf)"));
  sourcePin("/api/merge still writes merge_<ms>.flac and leaves its sources alone",
    merge, (s) => /const out = `merge_\$\{Date\.now\(\)\}\.flac`/.test(s),
    "the merge writing over its first source instead",
    (s) => s.replace(/const out = `merge_\$\{Date\.now\(\)\}\.flac`/, "const out = first"));
  /* And the one thing that DOES reach the card, which is why the merge tool is
   * gated while the editors are gated only by the table's file-writing line. */
  sourcePin("...and still queues the merged track for cover art, which is the card",
    merge, (s) => /art\.request\(/.test(s),
    "the cover request removed, which would make \"gpu\" the wrong class for audio_merge_takes",
    (s) => s.replace("art.request(", "noop("));
}

/* ─────────────────────────────────────────── §9 the routing decision */

console.log("\n§9  every tool here has a routing decision, and it is the right kind");

for (const t of tools) {
  ok(`${t.name} has a decision on record`, (t.name in ROUTABLE) || (t.name in WITHHELD),
    "server/chat/router.js reaches a tool only if it is in ROUTABLE; absence is refusal, not permission");
}
ok("not one of them is classed `destroys`, because not one of them removes a take",
  Object.keys(DOORS).every((n) => ROUTABLE[n] !== "destroys"),
  Object.keys(DOORS).filter((n) => ROUTABLE[n] === "destroys").join(", "));
ok("the catalogue read is free", ROUTABLE.audio_export_formats === null);
/* \u26a0 THE QUESTION IS WHETHER IT ASKS, NOT WHICH SENTENCE IT USES. This read
 * `=== "gpu"` because "gpu" was the only gate that asked when it was written,
 * and it failed the day a second one existed \u2014 while pointing at something
 * real: two of these were still claiming the graphics card for ffmpeg. */
const ASKS = new Set(["gpu", "writes"]);
ok("everything that writes a file is gated",
  ["audio_edit_song", "audio_trim_song", "audio_merge_takes", "audio_export_song", "audio_render_timeline"]
    .every((n) => ASKS.has(ROUTABLE[n])),
  "a file-writing tool left free is a silent spend — the line the table draws for image_to_svg and apply_lut");
ok("...and the four that never touch the card do not say they do",
  ["audio_edit_song", "audio_trim_song", "audio_export_song", "audio_render_timeline"]
    .every((n) => ROUTABLE[n] === "writes"),
  "numpy and ffmpeg. COST_TEXT.gpu would tell the person it holds the card while it runs");
ok("...while merge alone stays GPU, because /api/merge queues COVER ART on its way out",
  ROUTABLE.audio_merge_takes === "gpu",
  "index.js art.request \u2014 the one of the five that really does reach the engine");
ok("the gate kinds used here are ones the chat has a sentence for",
  Object.keys(DOORS).every((n) => ROUTABLE[n] === null || n in {} || COST_TEXT[ROUTABLE[n]]),
  "a gate with no COST_TEXT shows the person a confirm card with no reason on it");

/* ────────────────────────────────────────── §10 the wiring, statically */

console.log("\n§10  the module is wired in, and the census can see it");

{
  const mcp = read("mcp.js");
  sourcePin("server/mcp.js imports this module",
    mcp, (s) => /import \{ audioTools \} from "\.\/mcp-audio\.js"/.test(s),
    "the import removed",
    (s) => s.replace('import { audioTools } from "./mcp-audio.js";', ""));
  sourcePin("...and spreads it into TOOLS with the safeName guard, not without it",
    mcp, (s) => /\.\.\.audioTools\(api, safeName\)/.test(s),
    "safeName dropped from the call, which would leave every `file` and `with_file` unchecked",
    (s) => s.replace("...audioTools(api, safeName)", "...audioTools(api)"));
  /* The copy of safeName in this file's harness has to keep agreeing with the
   * one the tools are really handed, or §6's escape refusals prove nothing
   * about the shipped surface. */
  const real = mcp.slice(mcp.indexOf("function safeName("), mcp.indexOf("function safeName(") + 400);
  sourcePin("...and mcp.js's safeName still refuses .. and both slashes, as the harness copy does",
    real, (s) => /s\.includes\("\.\."\)/.test(s) && /s\.includes\("\/"\)/.test(s) && /s\.includes\("\\\\"\)/.test(s),
    "the .. clause taken out of the real guard",
    (s) => s.replace('s.includes("..")', "false"));
  /* THE DOOR CENSUS reads a hand-typed list of files. A module missing from it
   * has every one of its tools counted as "posts nothing" and quietly passed —
   * which is the census failure that lane exists to refuse. */
  sourcePin("server/mcp-routes_test.js's MCP_FILES lists this module",
    read("mcp-routes_test.js"), (s) => /"server\/mcp-audio\.js",/.test(s),
    "the entry removed from MCP_FILES",
    (s) => s.replace('"server/mcp-audio.js",', ""));
  ok("(the line above is what keeps the door census honest about these six tools)",
    /"server\/mcp-audio\.js"/.test(read("mcp-routes_test.js")),
    "without it the door census reports these six tools as unowned");
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
