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

console.log(`\n  ${pass} passed, ${failures.length} failed`);
console.log(`        (no human control, by name: ${Object.keys(NO_UI).join(", ")})\n`);
process.exit(failures.length ? 1 : 0);
