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
 *      WHAT THE PAGE HALF ASKS NOW, and it took four goes to stop asking a
 *      smaller question. Each earlier version checked something a DELETION of
 *      the control could survive:
 *
 *        v1  `<field>:` anywhere in web/vfx.js. Passed with the linear-light
 *            control gone, because `linearLight: c.linearLight` in the
 *            duplicate-comp handler copies one document into another and spells
 *            the field while doing it.
 *        v2  `<field>:` inside a real handler's RAW text. Delete the control
 *            outright — `id="vfxLin"` renamed, the whole `$("vfxLin").onchange`
 *            removed — then write `// TODO linearLight: someday` inside the
 *            motion-blur handler, and this file said 18 passed, 0 failed.
 *            Comments, strings and regex literals are BLANKED now (`code()`),
 *            and that attack fails.
 *        v3  a handler that names the field AND reads a control. Two
 *            INDEPENDENT halves — some site spells the field, some site reads
 *            something — so `linearLight: false` pasted into the motion-blur
 *            handler was vouched for by the motion-blur CHECKBOX, and the
 *            linear-light control could still be deleted.
 *        v4  what it does today, and the halves are joined. The field's own
 *            VALUE EXPRESSION — from its `:` to the next comma at that brace
 *            depth, inside the object literal that carries `action: "set_comp"`
 *            — must READ a rendered element: `$("id").value` / `.checked` /
 *            `.valueAsNumber`, or a local THIS handler bound to such a read
 *            (`const pick = $("vfxLin").value`). A control read elsewhere in
 *            the same handler is not a control for this field.
 *
 *      Two spellings survive that, and both bind an element to a field rather
 *      than to a room: the direct one above, and the helper `setC("vfxW",
 *      "width")` — where the field is a string at the call site and the element
 *      id is the argument beside it, and the helper's own body has to prove
 *      which parameter is which. A THIRD, the click, is named field by field in
 *      GESTURE: a button has nothing to read, so its entry names the element
 *      and the pair is verified instead of assumed.
 *
 *      AND A CENSUS THAT SEES NOTHING ACCUSES EVERYTHING, which is the failure
 *      v4 shipped with and the reason the count is in the label. The rule above
 *      was right; `code()` fed it a blanked page. One substitution in the
 *      comp-settings markup carries a block comment, that comment contains the
 *      apostrophe in `store.js's normalise`, and the brace scanner that finds a
 *      `${…}`'s closing `}` stepped over quotes but not COMMENTS — so it opened
 *      a string on that apostrophe and blanked 21,000 characters, every comp
 *      handler among them. The census then reported one post site on a page
 *      that wires eighteen, and named six fields as agent-only that a person
 *      sets with a slider. See `closeBrace`. The floors in the label are what
 *      turned that into two red lines instead of a quiet accusation.
 *
 *      FALSIFIED BOTH WAYS, v4 included, and every one of these was run against
 *      this file as it stands. FAILS: `linearLight: false` pasted into the
 *      motion-blur handler with the linear-light control deleted (the v3 hole);
 *      `const pick = $("vfxLin").value` replaced by `const pick = "on"`;
 *      `// TODO linearLight: someday` in the motion-blur handler (v2); the field
 *      spelled in RENDERED MARKUP — `data-x="linearLight: true"` — with the
 *      control gone; `setC("vfxW", …)` pointed at an id the page never renders;
 *      the shy toggle's id renamed in the markup only. PASSES: the page as it
 *      stands, and the linear-light read moved inside a `${…}` substitution,
 *      which is the half of the blanking fix that had to keep working.
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

/* `name:` at a property position, not `x.name` or `thing.name:`.
 *
 * THIS IS THE MCP DIRECTION ONLY, and that is the whole of what it is for. A
 * tool's SCHEMA is the agent's surface, so naming the field in it is genuinely
 * what an agent needs. The PAGE is not checked this way and has not been since
 * v4 — see the control census below, which asks which element FEEDS the field.
 *
 * It matches CODE ONLY: every caller hands it text that has been through
 * `code()`, because a field name spelled in a comment or inside a string is not
 * a field anything writes. That was a real hole — see `code()`. */
const writesField = (src, f) =>
  new RegExp(String.raw`(^|[^\w.])` + f + String.raw`\s*:`, "m").test(src);

/**
 * The same text with comments, string literals and regex literals blanked out.
 *
 * WHY, and it is the second time this census has been fooled by its own regex.
 * `writesField` ran over the RAW handler slice, so anything that merely SPELLS
 * the field inside that slice satisfied it. Deleting the linear-light control
 * completely — the `id="vfxLin"` renamed in the markup AND the whole
 * `$("vfxLin").onchange` handler removed — and then adding one line inside the
 * motion-blur handler:
 *
 *     // TODO linearLight: someday
 *
 * gave 18 passed, 0 failed. A comment is not a control. Neither is a tooltip,
 * and neither is a field name inside a template literal.
 *
 * A TEMPLATE LITERAL IS NOT ONE THING, which this got wrong twice, once in each
 * direction, and the second one is why the census reported a page with no
 * controls on it.
 *
 *   Too much. The first version blanked from the opening backtick to the
 *   closing one (`skipString` finds that by stepping OVER `${…}`), so every
 *   substitution went with it — and the page's markup is template literals, so
 *   that blanked real code: the `paintTimeline` row builders, every `${…}` guard
 *   inside a class list, the lot.
 *
 *   Too little, and in the wrong place. The fix scanned each `${…}` as code but
 *   found its closing `}` with a brace counter that skipped quotes only. A
 *   substitution containing a COMMENT — web/vfx.js has one, five lines of it,
 *   with an apostrophe in `store.js's` — ran that counter straight past the
 *   brace and blanked the rest of the function. Finding the `}` is now
 *   `closeBrace`, which steps over whole tokens, comments included.
 *
 * So: the literal TEXT is blanked, each substitution is scanned as what it is,
 * code, and its delimiters are left in place so brace depth still balances for
 * everything downstream that counts them.
 *
 * Blanked, not deleted, and newlines are kept: the result is the same length
 * and the same shape as the input, so an offset into one is an offset into the
 * other and nothing downstream has to care which it is holding. The control
 * census leans on that hard — it finds a read in the CODE text and then reads
 * the element's id back out of the RAW text at the same offset.
 */
function code(src) {
  const out = src.split("");
  const blank = (from, to) => {
    for (let j = from; j <= to && j < src.length; j++) out[j] = src[j] === "\n" ? "\n" : " ";
  };
  /* From the opening backtick at `start`: blank the literal runs, leave every
   * `${…}` (delimiters included, so brace depth still balances) as code. */
  const template = (start) => {
    const end = skipString(src, start);         // the backtick that closes it
    let run = start;                            // literal text awaiting blanking
    for (let j = start + 1; j < end; j++) {
      if (src[j] === "\\") { j++; continue; }
      if (src[j] === "$" && src[j + 1] === "{") {
        const close = closeBrace(src, j + 2);   // the `}` that closed it
        blank(run, j - 1);                      // …the text before it, and nothing else
        scan(j + 2, close);
        run = close + 1; j = close;
      }
    }
    blank(run, end);
    return end;
  };
  const scan = (from, to) => {
    for (let i = from; i < to; i++) {
      const ch = src[i];
      if (ch === "`") { i = template(i); continue; }
      if (ch === '"' || ch === "'") {
        const end = skipString(src, i);
        blank(i, end); i = end; continue;
      }
      if (ch === "/" && src[i + 1] === "/") {
        const nl = src.indexOf("\n", i);
        const end = Math.min(nl < 0 ? src.length - 1 : nl - 1, to - 1);
        blank(i, end); i = end; continue;
      }
      if (ch === "/" && src[i + 1] === "*") {
        const close = src.indexOf("*/", i);
        const end = Math.min(close < 0 ? src.length - 1 : close + 1, to - 1);
        blank(i, end); i = end; continue;
      }
      if (ch === "/" && isRegexStart(src, i)) {
        const end = skipRegex(src, i);
        /* skipRegex hands back the same index when the `/` turned out to be a
         * division after all. Blanking that one character would eat an operator
         * and could join two identifiers into one. */
        if (end > i) { blank(i, end); i = end; }
      }
    }
  };
  scan(0, src.length);
  return out.join("");
}

ok(`the census sees what set_comp accepts (${compFields.length} fields)`,
  compFields.length >= 8, compFields.join(", "));

/* ── a control that FEEDS the field ──────────────────────────────────────── */
/**
 * THE THIRD TIME THIS WAS A NAME CHECK, and the smallest layer it hid in.
 * v3 asked `postSites.some((s) => writesField(s.code, f) && readsControl(s))`,
 * and those two conjuncts never met: it asked whether SOME handler spells the
 * field AND that same handler reads SOME control — not that the control read
 * is what the field is set FROM. Paste `linearLight: false` into the
 * motion-blur handler and the motion-blur checkbox vouches for it; the
 * linear-light select can then be deleted and this file stays green.
 *
 * So the unit is no longer the handler. It is the PROPERTY: the field's `:`
 * inside an object literal that carries `action: "set_comp"`, and the value
 * expression that runs from there to the next comma at that brace depth. That
 * expression has to read a rendered element — `$("id").value`, `.checked`,
 * `.valueAsNumber`, `.files` — or a local the same handler bound to such a
 * read, which is how the linear-light select posts (`const pick =
 * $("vfxLin").value`, then `linearLight: pick === "on"`) and how the background
 * pair folds a hex field and an alpha field into one array.
 *
 * `$("vfxBg")` names its element with a STRING, and `code()` blanks strings —
 * so the read is found in the blanked text (where a comment or a tooltip cannot
 * fake one) and the id is then read back out of the RAW text at the same
 * offset, which `code()` keeps aligned. Both halves, or neither.
 */
const UI_CODE = code(UI);
const uiIds = new Set([...UI.matchAll(/\bid="([A-Za-z][\w-]*)"/g)].map((m) => m[1]));

/** The end of the statement starting at `from`: the first `;` at bracket depth
 *  zero, with every literal and comment stepped over by `skipToken` — the same
 *  one `code()` and `closeBrace` use, so the three cannot disagree about where a
 *  string ends. Each of those cases is load-bearing: a `(` inside a tooltip
 *  would swallow the rest of the file, and `/[&<>"']/g` in `esc` did exactly
 *  that on the first run — the quote inside the character class opened a string
 *  that ran to the end of web/vfx.js, handing this census one 314,000-character
 *  "handler" that named every field and passed everything. */
function endOfStatement(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const end = skipToken(src, i);
    if (end > i) { i = end; continue; }
    const ch = src[i];
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
    if (q === "`" && src[j] === "$" && src[j + 1] === "{") j = closeBrace(src, j + 2);
  }
  return src.length;
}

/** The last index of the string, template literal, comment or regex literal
 *  that STARTS at `i` — or `i` itself when none does. */
function skipToken(src, i) {
  const ch = src[i];
  if (ch === '"' || ch === "'" || ch === "`") return skipString(src, i);
  if (ch === "/" && src[i + 1] === "/") {
    const nl = src.indexOf("\n", i);
    return nl < 0 ? src.length - 1 : nl - 1;
  }
  if (ch === "/" && src[i + 1] === "*") {
    const close = src.indexOf("*/", i);
    return close < 0 ? src.length - 1 : close + 1;
  }
  if (ch === "/" && isRegexStart(src, i)) return skipRegex(src, i);
  return i;
}

/** From `from` — the character after a `${` — the index of the `}` that closes
 *  it.
 *
 *  IT HAS TO STEP OVER WHOLE TOKENS, not just quotes, and this file said "1
 *  handlers" for a week because it did not. web/vfx.js builds the comp-settings
 *  bar out of one template literal, and the `<select id="vfxLin">` substitution
 *  inside it carries a block comment that spells BOTH hazards in five lines: a
 *  backtick pair around `undefined`, and the apostrophe in `store.js's
 *  normalise`. A brace counter that only skipped quotes opened a string on that
 *  apostrophe, ran straight past the closing brace, and handed code() a
 *  21,000-character "substitution" — so every handler from the comp picker down
 *  to the render button came back blanked, `action: "set_comp"` with it, and the
 *  control census found ONE post site on a page that wires eighteen. A census
 *  that sees nothing accuses everything, which is exactly what it did. */
function closeBrace(src, from) {
  let depth = 1;
  for (let j = from; j < src.length; j++) {
    const end = skipToken(src, j);
    if (end > j) { j = end; continue; }
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return j;
  }
  return src.length;
}

/* ── reading structure off the blanked text ──────────────────────────────── */
/* All four of these run over UI_CODE, where every string, comment and regex is
 * spaces — so a bracket is a bracket, and nothing in a tooltip counts. */

/** Forward from the opening bracket at `at`, the index of the one that closes it. */
function matchBracket(text, at) {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const ch = text[i];
    if ("({[".includes(ch)) depth++;
    else if (")}]".includes(ch)) { depth--; if (depth === 0) return i; }
  }
  return text.length;
}

/** Backwards from `at`, the `{` that opens the object literal containing it —
 *  or -1 when the nearest enclosing bracket is not a brace, which means `at` is
 *  not sitting in an object literal at all. */
function objectOpen(text, at) {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const ch = text[i];
    if (")}]".includes(ch)) depth++;
    else if ("({[".includes(ch)) {
      if (depth === 0) return ch === "{" ? i : -1;
      depth--;
    }
  }
  return -1;
}

/** The top-level properties of the object literal spanning (open, close), as
 *  { key, name, from, to } — `from`/`to` bound the VALUE EXPRESSION, which is
 *  the thing a control has to feed. `key` is the raw key text (`[key]` for a
 *  computed one), `name` only the plain-identifier spelling.
 *
 *  The `inValue` flag is not decoration: `linearLight: pick === "inherit" ?
 *  null : pick === "on"` puts a ternary's `:` at the object's own brace depth,
 *  and reading that as the start of another property would cut the value
 *  expression in half. */
function properties(text, open, close) {
  const out = [];
  let depth = 0, keyAt = open + 1, key = null, name = null, from = 0, inValue = false;
  const flush = (to) => { if (inValue) out.push({ key, name, from, to }); inValue = false; };
  for (let i = open + 1; i < close; i++) {
    const ch = text[i];
    if ("({[".includes(ch)) { depth++; continue; }
    if (")}]".includes(ch)) { depth--; continue; }
    if (depth !== 0) continue;
    if (ch === ":" && !inValue) {
      key = text.slice(keyAt, i).trim();
      name = /^[A-Za-z_$][\w$]*$/.test(key) ? key : null;
      from = i + 1; inValue = true;
      continue;
    }
    if (ch === ",") { flush(i); keyAt = i + 1; }
  }
  flush(close);
  return out;
}

/** `name` used as an identifier, not as a property of something else. */
const mentions = (text, name) =>
  new RegExp(String.raw`(^|[^\w.$])` + name + String.raw`\b`).test(text);

/** The rendered element ids that the span [from, to) reads a value off.
 *
 *  In UI_CODE `$("vfxBg").value` reads as `$(        ).value` — the quotes go
 *  with the string — so the shape is matched there and the id is fetched from
 *  UI at the same offset. A read spelled inside a comment or a string is all
 *  spaces in UI_CODE and matches nothing, which is the point. */
function readIds(from, to) {
  const ids = [];
  const re = /\$\(\s*\)\s*\.\s*(?:value|valueAsNumber|checked|files)\b/g;
  const seg = UI_CODE.slice(from, to);
  let m;
  while ((m = re.exec(seg))) {
    const raw = /^\$\(\s*"([A-Za-z][\w-]*)"\s*\)/.exec(UI.slice(from + m.index));
    if (raw && uiIds.has(raw[1])) ids.push(raw[1]);
  }
  return ids;
}

/** Locals declared in [from, to) whose value comes from a control read.
 *
 *  The linear-light select needs one hop (`const pick = $("vfxLin").value`) and
 *  the background pair needs two (`hx` from the colour field, `rgb` from `hx`),
 *  so this is a fixpoint rather than a single lookup. FUNCTIONS are excluded on
 *  purpose: a helper that reads a control is not a value read off one, and
 *  merely NAMING such a helper in a value expression would otherwise vouch for
 *  the field. */
function boundLocals(from, to) {
  const decls = [];
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=)/g;
  const seg = UI_CODE.slice(from, to);
  let m;
  while ((m = re.exec(seg))) {
    const at = from + m.index + m[0].length;
    const init = UI_CODE.slice(at, Math.min(to, endOfStatement(UI, at)));
    if (/^\s*(?:async\s+)?function\b/.test(init)
      || /^\s*(?:async\s*)?\([^)]*\)\s*=>/.test(init)
      || /^\s*(?:async\s*)?[A-Za-z_$][\w$]*\s*=>/.test(init)) continue;
    decls.push({ name: m[1], at, init });
  }
  const bound = new Set();
  for (let round = 0; round <= decls.length; round++) {
    let grew = false;
    for (const d of decls) {
      if (bound.has(d.name)) continue;
      const at = d.at;
      if (readIds(at, at + d.init.length).length
        || [...bound].some((b) => mentions(d.init, b))) { bound.add(d.name); grew = true; }
    }
    if (!grew) break;
  }
  return bound;
}

/** The set_comp POST BODIES inside [from, to): each object literal that carries
 *  `action: "set_comp"`, as { open, close }. The RAW text says which action it
 *  is (code() blanks the string that names it) and the CODE text says it is
 *  code at all — an `action: "set_comp"` inside a comment leaves `action`
 *  blanked, and this drops it. */
function setCompBodies(from, to) {
  const out = [];
  const re = /\baction\s*:\s*"set_comp"/g;
  re.lastIndex = from;
  let m;
  while ((m = re.exec(UI)) && m.index < to) {
    if (!/^action\s*:/.test(UI_CODE.slice(m.index, m.index + m[0].length))) continue;
    const open = objectOpen(UI_CODE, m.index);
    if (open < from) continue;
    out.push({ open, close: Math.min(matchBracket(UI_CODE, open), to) });
  }
  return out;
}

/** The literal arguments of every call to `name`, one array per call site.
 *  Scanned on the raw text (the arguments ARE strings and their contents are
 *  the whole point), but only where UI_CODE agrees the name is code. */
function callArgs(name) {
  const out = [];
  const re = new RegExp(String.raw`(^|[^\w.$])` + name + String.raw`\s*\(`, "g");
  let m;
  while ((m = re.exec(UI))) {
    const at = m.index + m[0].length - name.length - 1 + name.length;  // the `(`
    const nameAt = at - name.length;
    if (!UI_CODE.startsWith(name, nameAt)) continue;
    const args = [];
    let depth = 0, start = at + 1;
    for (let i = at; i < UI.length; i++) {
      const ch = UI[i];
      if (ch === '"' || ch === "'" || ch === "`") { i = skipString(UI, i); continue; }
      if ("({[".includes(ch)) { depth++; continue; }
      if (")}]".includes(ch)) {
        depth--;
        if (depth === 0) { args.push(UI.slice(start, i)); break; }
        continue;
      }
      if (ch === "," && depth === 1) { args.push(UI.slice(start, i)); start = i + 1; }
    }
    out.push(args.map((a) => a.trim()));
  }
  return out;
}

const literal = (arg) => {
  const m = /^"([A-Za-z][\w-]*)"$/.exec(arg || "");
  return m ? m[1] : null;
};

/** Every handler wiring and every const-bound arrow in the page that posts
 *  set_comp, as { id, event, helper, params, from, to, bodies } — `id` names
 *  the element the handler is wired to when it is wired to one, `helper` the
 *  const it was bound to, and `from`/`to` are offsets into BOTH UI and UI_CODE,
 *  which code() keeps aligned. */
const postSites = (() => {
  const out = [];
  const add = (m, extra) => {
    const to = endOfStatement(UI, m.index + m[0].length);
    /* A control's wiring is a few hundred characters (the ones on this page run
     * 142 to 297). Anything longer is a scan that lost its place, and a body
     * that lost its place would name every field in the file and pass
     * everything — so it is DROPPED rather than trusted or truncated, which
     * fails loudly as a missing control instead of quietly as a present one. */
    if (to - m.index > 1500) return;
    const bodies = setCompBodies(m.index, to);
    if (bodies.length) out.push({ id: null, event: null, helper: null, params: [], ...extra, from: m.index, to, bodies });
  };
  const wiring = /(?:\$\("([A-Za-z][\w-]*)"\)|\b[A-Za-z_$][\w$]*)\s*\.\s*on(\w+)\s*=/g;
  let m;
  while ((m = wiring.exec(UI))) add(m, { id: m[1] ?? null, event: m[2] });
  const arrow = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g;
  while ((m = arrow.exec(UI))) {
    add(m, {
      helper: m[1],
      params: m[2].split(",").map((p) => (/^\s*([A-Za-z_$][\w$]*)/.exec(p) || [])[1]).filter(Boolean),
    });
  }
  return out;
})();

const propsOf = (s) => s.bodies.flatMap((b) => properties(UI_CODE, b.open, b.close));

/* ── spelling one: the value expression reads a rendered element ──────────── */
const readFields = new Set();
for (const s of postSites) {
  const locals = boundLocals(s.from, s.to);
  for (const p of propsOf(s)) {
    if (!p.name) continue;
    const expr = UI_CODE.slice(p.from, p.to);
    if (readIds(p.from, p.to).length || [...locals].some((n) => mentions(expr, n))) {
      readFields.add(p.name);
    }
  }
}

/* ── spelling two: the helper, where the field is a string at the call site ── */
/**
 * `const setC = (id, key, cast = num) => { const el = $(id); el.onchange = () =>
 *  mutate({ …, [key]: cast(el.value) }) }` called as `setC("vfxW", "width")`.
 *
 * The pair is what binds the control to the field, and which argument is which
 * is read off the HELPER'S OWN BODY rather than assumed from position: `const
 * el = $(id)` names the element parameter, `[key]:` names the field parameter,
 * and the two only count when they meet — the computed property's value has to
 * read that element. Then each call site is required to hand a rendered id in
 * the element slot before the string in the field slot is believed.
 *
 * This is also why width/height/fps/duration were passing v1 for the wrong
 * reason: the only literal `width:` on the page is in the duplicate handler.
 */
const helperFields = new Set();
for (const s of postSites) {
  if (!s.helper || !s.params.length) continue;
  const elems = new Map();                    // local name -> parameter it was built from
  for (const d of UI_CODE.slice(s.from, s.to).matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\$\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    if (s.params.includes(d[2])) elems.set(d[1], d[2]);
  }
  for (const p of propsOf(s)) {
    const computed = /^\[\s*([A-Za-z_$][\w$]*)\s*\]$/.exec(p.key || "");
    if (!computed || !s.params.includes(computed[1])) continue;
    const expr = UI_CODE.slice(p.from, p.to);
    const read = [...elems].find(([local]) => new RegExp(
      String.raw`(^|[^\w.$])` + local + String.raw`\s*\.\s*(?:value|valueAsNumber|checked|files)\b`,
    ).test(expr));
    if (!read) continue;
    const idAt = s.params.indexOf(read[1]);
    const keyAt = s.params.indexOf(computed[1]);
    for (const args of callArgs(s.helper)) {
      const id = literal(args[idAt]);
      const field = literal(args[keyAt]);
      if (id && field && uiIds.has(id)) helperFields.add(field);
    }
  }
}

/* ── spelling three: the click, named one field at a time ─────────────────── */
/**
 * A field can have a real control and no control READ. The timeline's shy
 * toggle posts `hideShy: !V.comp?.hideShy` — a button has nothing to read,
 * because the click IS the value.
 *
 * That is a control, so it is not an exemption; it is also the exact shape a
 * bogus pass would take (a field pasted into some button's handler), so it is
 * not a blanket rule either. Each entry NAMES its element, and the pair is
 * VERIFIED rather than believed: the id must be rendered by the page, the
 * handler wired to THAT id must be a click, and its set_comp body must carry
 * this field at a property position. Delete the button, rename its id, or move
 * the field to another handler and the entry fails.
 */
const GESTURE = {
  hideShy: "vfxHideShy",
};
const gestureFor = (f) => {
  const id = GESTURE[f];
  return !!id && uiIds.has(id) && postSites.some((s) =>
    s.id === id && /click|down|up/.test(s.event || "") && propsOf(s).some((p) => p.name === f));
};

const controlFor = (f) => readFields.has(f) || helperFields.has(f) || gestureFor(f);

/* Same rule as everywhere else in this file: an extraction that finds nothing
 * passes everything, so prove it found the page before trusting its verdict. */
ok(`the census sees the page's set_comp controls at all (${postSites.length} handlers, `
  + `${uiIds.size} rendered ids)`,
  postSites.length >= 4 && uiIds.size >= 20 && readFields.size >= 3 && helperFields.size >= 2,
  `${postSites.length} handlers, ${readFields.size} read-fed fields `
    + `(${[...readFields].join(", ")}), ${helperFields.size} helper-driven `
    + `(${[...helperFields].join(", ")})`);

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
ok("every comp field the route accepts has a CONTROL that FEEDS it — a rendered "
  + "element read inside the field's own value expression",
  fieldGaps.length === 0,
  fieldGaps.length
    ? `NO HUMAN CONTROL and no exemption: ${fieldGaps.join(", ")}\n          `
      + "Add the control, or add a named entry to NO_UI_FIELD saying why an agent may keep it."
    : "");
ok("every click control named in GESTURE is still a rendered element whose handler posts its field",
  Object.keys(GESTURE).every((f) => compFields.includes(f) && gestureFor(f)),
  Object.keys(GESTURE).filter((f) => !compFields.includes(f) || !gestureFor(f))
    .map((f) => `${f} -> ${GESTURE[f]}`).join(", ")
    + " — the element is gone, renamed, no longer a click, or no longer posts the field");
/* Stripped for the same reason the page's handlers are: mcp-vfx.js describes
 * its own tools in prose, and `"...replaced in one call, like markers: to add
 * or move one..."` is a sentence, not a schema. `markers` passes here on the
 * property key at its tool's `markers:` and on `markers: a.markers` in the
 * body, which is what naming a field actually means. */
const MCP_CODE = code(MCP);
ok("...and by an agent",
  compFields.every((f) => writesField(MCP_CODE, f)),
  compFields.filter((f) => !writesField(MCP_CODE, f)).join(", ")
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
console.log(`        (fed by a read: ${[...readFields].sort().join(", ")}; by the setC pair: ${[...helperFields].sort().join(", ")}; by a click: ${Object.keys(GESTURE).join(", ")})`);
console.log(`        (GET shelves checked: ${uiGets.join(", ")})\n`);
process.exit(failures.length ? 1 : 0);
