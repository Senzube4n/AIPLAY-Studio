/**
 * VFX UI — the parity gate this subsystem never had.
 *
 * The DAW has server/daw/ui_test.js and the MV fork now has server/mv/ui_test.js.
 * VFX is the largest surface in the app — 44 dispatched actions against the
 * DAW's ~24 — and had neither direction checked, which is why the 08-27 audit
 * found most of its one-directional gaps here rather than anywhere else.
 *
 * TWO DIRECTIONS, AND THE SECOND IS THE ONE THAT FINDS THINGS.
 *
 *   1. Every action the PAGE posts must be one the server dispatches. This
 *      catches a gesture that invented its own write path or kept a name the
 *      server renamed — the rarer bug, and the one the DAW's gate was built for.
 *
 *   2. Every action the SERVER dispatches must be reachable by a human. This is
 *      the direction that produced almost every finding in the audit, and the
 *      one that would have caught five agent-only capabilities I shipped into
 *      the image surface on the same day this was written.
 *
 *   3. Every FIELD `set_comp` accepts must be reachable both ways. A name check
 *      cannot see inside an action, and `set_comp` alone carries twelve comp
 *      settings — so an agent-only one arrives on an action all three surfaces
 *      already name, and directions 1 and 2 both pass. Found `seed` on its
 *      first run — and `markers` the day it learned to ask a better question.
 *
 *      THE BETTER QUESTION: on the page a field must have a CONTROL, not a
 *      mention. This check used to grep for `<field>:` anywhere in web/vfx.js,
 *      which passed with the linear-light control DELETED — `linearLight:
 *      c.linearLight` in the duplicate-comp handler is the field copied from
 *      one document to another, and matched. It now asks for a rendered
 *      element wired to a handler that posts the field, and was falsified both
 *      ways before it was believed.
 *
 * EXEMPTIONS GO STALE LOUDLY. An action may sit in NO_UI with a reason, and two
 * things then hold: the name must be a real action, so a rename cannot hide
 * behind a dead entry; and it must still be unreachable, so closing a gap
 * FORCES its exemption to be deleted. Without that second check an exemption
 * list becomes the place gaps go to be forgotten.
 *
 * Runs standalone (`node server/vfx/ui_test.js`) and in the pre-commit hook.
 * Reads web/ and server/vfx/ and touches nothing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = readFileSync(path.join(HERE, "routes.js"), "utf8");
const UI = readFileSync(path.join(HERE, "..", "..", "web", "vfx.js"), "utf8");
const MCP = readFileSync(path.join(HERE, "..", "mcp-vfx.js"), "utf8");

/* The dispatch is a switch on the action, nested well inside the handler, so
 * the cases sit far past column 0. Anchoring on that indent avoids catching a
 * `case` from some unrelated shallower switch. */
const serverActions = [...new Set(
  [...ROUTES.matchAll(/^\s{6,}case "([a-z0-9_]+)":/gm)].map((m) => m[1]),
)].sort();
const uiActions = new Set([...UI.matchAll(/action:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));
const mcpActions = new Set([...MCP.matchAll(/action:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));

/* A regex that matches nothing passes everything, so prove the extraction found
 * a plausible surface before trusting a word it says. */
ok(`the census sees the VFX dispatch at all (${serverActions.length} actions)`,
  serverActions.length >= 35, serverActions.join(", "));
ok(`...and the page's own posts (${uiActions.size})`, uiActions.size >= 30);
ok(`...and the MCP layer's (${mcpActions.size})`, mcpActions.size >= 30);

/* ── direction 1: did a gesture invent a write path? ─────────────────────── */
/**
 * SPECULATIVE posts: an action the page tries OPTIMISTICALLY and handles the
 * failure of. duplicateComp() is the honest example and its own comment says
 * so — there is no comp-level `duplicate` on the route, so it asks, and on a
 * refusal rebuilds the same result out of `create` plus layer copies.
 *
 * Listing it is not a hole, because the entry has to earn itself twice: the
 * action must still be undispatched (the moment the server grows it, this stops
 * being speculative and the entry must go), and the call must sit inside a
 * try/catch. A speculative post with no fallback is just a broken button.
 */
const SPECULATIVE = {
  duplicate:
    "duplicateComp() asks for a comp-level duplicate the route does not define, then falls back to "
    + "create + copy the layers. Documented in web/vfx.js above the function.",
};
const orphanGestures = [...uiActions].filter((a) => !serverActions.includes(a));
const unhandled = orphanGestures.filter((a) => !(a in SPECULATIVE));
ok("every action the page posts is one the server dispatches, or a declared fallback",
  unhandled.length === 0,
  unhandled.join(", ") + " — posted by web/vfx.js and dispatched by nothing");
ok("every speculative post really is undispatched",
  Object.keys(SPECULATIVE).every((a) => !serverActions.includes(a)),
  Object.keys(SPECULATIVE).filter((a) => serverActions.includes(a)).join(", ")
    + " — the route defines it now, so it is not speculative; delete the entry");
ok("...and every speculative post has a fallback around it",
  Object.keys(SPECULATIVE).every((a) => {
    /* The post, then a catch somewhere after it and before the function ends.
     * Crude on purpose: this asks whether a failure is HANDLED at all, which is
     * the difference between a probe and a dead button. */
    const at = UI.indexOf(`action: "${a}"`);
    return at > 0 && UI.slice(at, at + 900).includes("catch");
  }),
  "a speculative post with no catch is a button that silently does nothing");

/* ── direction 2: can a human reach it? ──────────────────────────────────── */
/**
 * Actions with no human control, each with the reason it is acceptable TODAY.
 * Every entry is a to-do with a name on it, not a decision.
 */
const NO_UI = {
  export_studio:
    "OPEN GAP. The VFX-to-Studio half of the bridge. An agent can push a comp onto the "
    + "Studio timeline and a person cannot, which is drift rather than design — the fx-preset "
    + "shelf beside it is fully wired on both surfaces.",
  import_studio:
    "OPEN GAP. The other half: pull a Studio timeline into a comp. Same story.",
  add_shape_preset:
    "OPEN GAP. Shape presets can be applied from the page and only saved by an agent, so a "
    + "shape you built by hand cannot be kept by hand.",
  prewarm_cancel:
    "OPEN GAP. Prewarm can be started from the page and stopped only by an agent — the one "
    + "direction of a pair, which is how a render ends up unstoppable from the screen.",
  audio_notes:
    "OPEN GAP. Audio-to-notes transcription. A real action with an MCP tool and no control "
    + "anywhere under web/ — `grep audio_notes web/` returns nothing.",
  instrument_rig:
    "OPEN GAP. The fretboard/instrument rig, same story as audio_notes: built, tooled, and "
    + "unreachable by the person whose recording it is.",
};

const unreachable = serverActions.filter((a) => !uiActions.has(a));
const undeclared = unreachable.filter((a) => !(a in NO_UI));
ok(`every action the server dispatches is reachable by a human (${serverActions.length} actions)`,
  undeclared.length === 0,
  undeclared.length
    ? `NO HUMAN CONTROL and no exemption: ${undeclared.join(", ")}\n          `
      + "Add the control, or add a named entry to NO_UI saying why an agent may keep it to itself."
    : "");
ok("every exemption names an action that really exists",
  Object.keys(NO_UI).every((a) => serverActions.includes(a)),
  Object.keys(NO_UI).filter((a) => !serverActions.includes(a)).join(", "));
ok("...and no exemption is stale — a gap that was closed must come off the list",
  Object.keys(NO_UI).every((a) => !uiActions.has(a)),
  Object.keys(NO_UI).filter((a) => uiActions.has(a)).join(", ")
    + " — now reachable; delete the NO_UI entry so the next gap cannot hide behind it");

/* ── reachable by neither ────────────────────────────────────────────────── */
/* Worse than a one-directional gap: a route that is dispatched, maintained and
 * called by nothing reads as a feature to whoever greps for it next. VFX has
 * none today, and this asserts it stays that way. */
const orphans = serverActions.filter((a) => !uiActions.has(a) && !mcpActions.has(a));
ok("no VFX action is reachable by neither a human nor an agent",
  orphans.length === 0,
  orphans.join(", ") + " — implemented and called by nothing; expose or delete");

/* ── the FIELDS inside an action, not just the action's name ─────────────── */
/**
 * ADDED AFTER THIS GATE PASSED A ONE-DIRECTIONAL COMP FIELD. Everything above
 * matches on ACTION NAMES, and `set_comp` alone writes a dozen different
 * fields: an agent-only comp setting rides in on an action all three surfaces
 * already name, so every check above goes green while half the setting is
 * missing. Linear light was added this way and would have shipped that way.
 *
 * So: every field `set_comp` accepts must be written by web/vfx.js AND by
 * server/mcp-vfx.js. Extracted from the `b.<field> !== undefined` guards the
 * handler is built out of, so a field added without a guard is not a field the
 * route accepts either, and a renamed field breaks this the same day.
 *
 * On the first run it found `seed`, below. That is the check working.
 */
const setCompBlock = (() => {
  const at = ROUTES.indexOf(`case "set_comp": {`);
  return at < 0 ? "" : ROUTES.slice(at, ROUTES.indexOf(`case "add_layer"`, at));
})();
const compFields = [...new Set(
  [...setCompBlock.matchAll(/\bb\.([A-Za-z][A-Za-z0-9]*)\s*!==\s*undefined/g)].map((m) => m[1]),
)].sort();
/* `name:` at a property position, not `x.name` or `thing.name:` — the field is
 * being WRITTEN into a request body here, never read off a document. Good
 * enough for the MCP direction below, where a tool's SCHEMA is the surface and
 * naming the field is the whole of what an agent needs. NOT good enough for
 * the page — see the control census under it. */
const writesField = (src, f) =>
  new RegExp(String.raw`(^|[^\w.])` + f + String.raw`\s*:`, "m").test(src);

ok(`the census sees what set_comp accepts (${compFields.length} fields)`,
  compFields.length >= 8, compFields.join(", "));

/* ── a CONTROL, not a mention ────────────────────────────────────────────── */
/**
 * WHAT THIS USED TO ASK, and what was wrong with it: `writesField(UI, field)`
 * looked for `<field>:` anywhere in web/vfx.js. The linear-light control was
 * deleted from the page — the checkbox id renamed, the read removed, no way
 * left for a person to set it — and this file still reported 17 passed / 0
 * failed, because `linearLight: c.linearLight` in the duplicate-comp handler
 * matched. That line copies one document into another; it is the field NAMED,
 * not a control. The check's message said "can be set from the page" and what
 * it verified was "is spelled on the page".
 *
 * So it now looks for a CONTROL: an element the page RENDERS (`id="…"` in its
 * own markup), wired to a handler, whose body posts `set_comp` carrying the
 * field. Two spellings, because the page has two:
 *
 *   DIRECT   `$("vfxLin").onchange = () => mutate({ action: "set_comp", …,
 *            linearLight: … })` — the handler names the field itself. A
 *            const-bound arrow counts as a body too (`const bgWrite = () => …`),
 *            since that is how the bg pair posts, and it qualifies by READING a
 *            rendered element: `$("vfxBg").value`.
 *   HELPER   `const setC = (id, key) => { const el = $(id); el.onchange = …
 *            mutate({ …, [key]: cast(el.value) }) }` called as
 *            `setC("vfxW", "width")`. The field is a STRING at the call site
 *            and the control is the id beside it, so the PAIR is what matches —
 *            which is also why width/height/fps/duration were passing here for
 *            the wrong reason: the only literal `width:` on the page is in the
 *            duplicate handler.
 *
 * FALSIFIED BEFORE IT WAS TRUSTED. Renaming the linear select's id in the
 * markup fails it; deleting the `linearLight:` line from its handler fails it;
 * the duplicate-comp copy on its own does not satisfy it. Each was tried.
 */
const uiIds = new Set([...UI.matchAll(/\bid="([A-Za-z][\w-]*)"/g)].map((m) => m[1]));

/** The end of the statement starting at `from`: the first `;` at bracket depth
 *  zero, with strings, template substitutions, comments and REGEX LITERALS
 *  stepped over. Every one of those is load-bearing: a `(` inside a tooltip
 *  would swallow the rest of the file, and `/[&<>"']/g` in `esc` did exactly
 *  that on the first run — the quote inside the character class opened a string
 *  that ran to the end of web/vfx.js, handing this census one 314,000-character
 *  "handler" that named every field and passed everything. */
function endOfStatement(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") { i = skipString(src, i); continue; }
    if (ch === "/" && isRegexStart(src, i)) { i = skipRegex(src, i); continue; }
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      if (nl < 0) return src.length;
      i = nl; continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i);
      if (close < 0) return src.length;
      i = close + 1; continue;
    }
    if ("({[".includes(ch)) depth++;
    else if (")}]".includes(ch)) depth--;
    else if (ch === ";" && depth <= 0) return i;
  }
  return src.length;
}

/** A `/` starts a regex when the last meaningful character before it cannot end
 *  an expression — the standard heuristic, and enough for this file. */
function isRegexStart(src, i) {
  if (src[i + 1] === "/" || src[i + 1] === "*") return false;
  let j = i - 1;
  while (j >= 0 && " \t\n\r".includes(src[j])) j--;
  return j < 0 || "(,=:[!&|?{};+-*%~^<>".includes(src[j]);
}

function skipRegex(src, i) {
  let cls = false;
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") { j++; continue; }
    if (src[j] === "\n") return i;              // not a regex after all
    if (src[j] === "[") cls = true;
    else if (src[j] === "]") cls = false;
    else if (src[j] === "/" && !cls) return j;
  }
  return src.length;
}

function skipString(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") { j++; continue; }
    if (src[j] === q) return j;
    if (q === "`" && src[j] === "$" && src[j + 1] === "{") {
      let d = 1; j += 2;
      while (j < src.length && d > 0) {
        if (src[j] === "{") d++;
        else if (src[j] === "}") d--;
        j++;
      }
      j -= 1;
    }
  }
  return src.length;
}

/** Every handler wiring and every const-bound arrow in the page that posts
 *  set_comp, as { id, helper, src } — `id` names the element the handler is
 *  wired to when it is wired to one, `helper` the const it was bound to. */
const postSites = (() => {
  const out = [];
  const wiring = /(?:\$\("([A-Za-z][\w-]*)"\)|\b[A-Za-z_$][\w$]*)\s*\.\s*on\w+\s*=/g;
  const arrow = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g;
  for (const [re, key] of [[wiring, "id"], [arrow, "helper"]]) {
    let m;
    while ((m = re.exec(UI))) {
      const src = UI.slice(m.index, endOfStatement(UI, m.index + m[0].length));
      /* A control's wiring is a few hundred characters (the four on this page
       * run 142 to 297). Anything longer is a scan that lost its place, and a
       * body that lost its place would name every field in the file and pass
       * everything — so it is DROPPED rather than trusted or truncated, which
       * fails loudly as a missing control instead of quietly as a present one. */
      if (src.length <= 1500 && src.includes(`"set_comp"`)) {
        out.push({ id: null, helper: null, [key]: m[1], src });
      }
    }
  }
  return out;
})();

/** Does this body READ a control — the element it is wired to, or a rendered
 *  element's value/checked? A button's click IS its value, which is why the
 *  wiring alone counts when the id is one the page renders. */
const readsControl = (s) =>
  (s.id !== null && uiIds.has(s.id))
  || [...s.src.matchAll(/\$\("([A-Za-z][\w-]*)"\)\s*\.\s*(?:value|checked|files)\b/g)]
    .some((m) => uiIds.has(m[1]));

/** Helper bodies that post a COMPUTED key and read their own element, with the
 *  (id, field) pairs their call sites hand them. */
const helperFields = new Set();
for (const s of postSites) {
  if (!s.helper || !/\[\s*\w+\s*\]\s*:/.test(s.src) || !/\$\(\s*\w+\s*\)/.test(s.src)) continue;
  const calls = new RegExp(String.raw`(^|[^\w.])` + s.helper
    + String.raw`\(\s*"([A-Za-z][\w-]*)"\s*,\s*"([A-Za-z][\w-]*)"`, "g");
  for (const m of UI.matchAll(calls)) if (uiIds.has(m[2])) helperFields.add(m[3]);
}

const controlFor = (f) =>
  postSites.some((s) => writesField(s.src, f) && readsControl(s)) || helperFields.has(f);

/* Same rule as everywhere else in this file: an extraction that finds nothing
 * passes everything, so prove it found the page before trusting its verdict. */
ok(`the census sees the page's set_comp controls at all (${postSites.length} handlers, `
  + `${uiIds.size} rendered ids)`,
  postSites.length >= 4 && uiIds.size >= 20 && helperFields.size >= 2,
  `${postSites.length} handlers, ${helperFields.size} helper-driven fields`);

/** Comp fields with no human control, each with the reason it is acceptable TODAY. */
const NO_UI_FIELD = {
  seed:
    "OPEN GAP. The comp's noise seed — every wiggle() and random() in every expression "
    + "derives from it, so re-rolling all of them at once is one field away and reachable "
    + "only by an agent. `grep 'seed:' web/vfx.js` returns nothing. A person who wants a "
    + "different wiggle has to edit the expressions.",
  markers:
    "OPEN GAP, and the control census is what found it. The timeline DRAWS comp markers "
    + "(`vfxmarker` in paintTimeline) and nothing on the page ever writes one: an agent can "
    + "place a marker, a person can only look at it.",
  name:
    "Reachable, through a different action. The comp picker swaps for an input and commits "
    + "through `rename` (which moves the slug too); set_comp's `name` is the agent's spelling "
    + "of the same edit. Not a gap — but not a set_comp control either, so it is named here "
    + "rather than silently matched.",
  layers:
    "Not a control and should not be one: it replaces the WHOLE layer stack. A person edits "
    + "layers through add_layer / set_layer / reorder_layer (all covered by the action census "
    + "above); the page posts this field only to RESTORE a snapshot (undo) and to copy a stack "
    + "into a duplicate, both of which spread a saved document rather than read a control.",
};
const fieldGaps = compFields.filter((f) => !controlFor(f) && !(f in NO_UI_FIELD));
ok("every comp field the route accepts has a CONTROL on the page — a rendered "
  + "element whose handler posts it",
  fieldGaps.length === 0,
  fieldGaps.length
    ? `NO HUMAN CONTROL and no exemption: ${fieldGaps.join(", ")}\n          `
      + "Add the control, or add a named entry to NO_UI_FIELD saying why an agent may keep it."
    : "");
ok("...and by an agent",
  compFields.every((f) => writesField(MCP, f)),
  compFields.filter((f) => !writesField(MCP, f)).join(", ")
    + " — accepted by the route and named by no MCP tool");
ok("every comp-field exemption names a field the route really accepts",
  Object.keys(NO_UI_FIELD).every((f) => compFields.includes(f)),
  Object.keys(NO_UI_FIELD).filter((f) => !compFields.includes(f)).join(", "));
ok("...and no comp-field exemption is stale",
  Object.keys(NO_UI_FIELD).every((f) => !controlFor(f)),
  Object.keys(NO_UI_FIELD).filter((f) => controlFor(f)).join(", ")
    + " — now has a control; delete the NO_UI_FIELD entry");

/* ── the SHELVES a gesture reads before it can be used ───────────────────── */
/**
 * ADDED AFTER THIS GATE PASSED A DEAD FEATURE. Everything above matches on
 * ACTION NAMES, and that is blind in a way the camera-move shelf demonstrated
 * exactly: `camera_move` was dispatched by the server, posted by web/vfx.js and
 * described by an MCP tool, so all three directions above went green — while
 * the sheet that posts it opened by fetching GET /api/vfx/camera-moves, which
 * no route defined. The button answered "not found" and no human could build a
 * move at all. Name parity said the feature was reachable; it was not.
 *
 * So: every STATIC /api/vfx GET path the page fetches must be a path the route
 * file actually matches. Only double-quoted literals are extracted, which is
 * the point — the per-comp routes are built from template literals and carry a
 * slug, and a prefix match would be a weaker claim than this one.
 *
 * This does not make the gate sufficient. It closes the one hole that shipped.
 */
const uiGets = [...new Set(
  [...UI.matchAll(/(?:getJson|fetch)\("(\/api\/vfx\/[a-z0-9/-]+)"/g)].map((m) => m[1]),
)].sort();
ok(`the census sees the page's GET shelves at all (${uiGets.length})`, uiGets.length >= 4,
  uiGets.join(", "));

const deadGets = uiGets.filter((g) => !ROUTES.includes(`p === "${g}"`));
ok("every shelf the page fetches is a route the server defines",
  deadGets.length === 0,
  deadGets.join(", ") + " — fetched by web/vfx.js and matched by no route in routes.js; "
    + "the gesture that reads it opens onto an error");

console.log(`\n  ${pass} passed, ${failures.length} failed`);
console.log(`        (no human control, by name: ${Object.keys(NO_UI).join(", ")})`);
console.log(`        (set_comp fields checked: ${compFields.join(", ")}; agent-only: ${Object.keys(NO_UI_FIELD).join(", ")})`);
console.log(`        (GET shelves checked: ${uiGets.join(", ")})\n`);
process.exit(failures.length ? 1 : 0);
