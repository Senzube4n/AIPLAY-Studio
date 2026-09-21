/**
 * DAW UI — the static gates the arrangement window stands on.
 *
 * The UI's correctness has three parts. Two of them are ordinary code and
 * are tested here; the third is pixels and is tested by driving the real
 * page (scripts/e2e_dawui.mjs plus a browser).
 *
 *   1. THE PARITY GATE — the binding principle in executable form, and it
 *      runs in THREE directions, not two. Every `action: "…"` the pages post
 *      must be an action routes.js, mixer.js or voicelab.js actually
 *      dispatches; every action they dispatch must be reachable by an AGENT
 *      (a hard gate — a route with no MCP tool fails the commit, exemptions
 *      only by name and with a reason); and what no page surfaces is printed
 *      as a coverage note, because the page is not obliged to carry probe.
 *      The agent direction was missing, and that is exactly how voice_lab,
 *      render_stems and peaks shipped with a route, a panel and no tool
 *      while this file reported 216 passed / 0 failed. The human surface is
 *      read as ALL of this door's pages — web/daw.js AND web/voicelab.js —
 *      for the same reason.
 *
 *   2. THE WIRING GATE — daw.js binds listeners at MODULE TOP LEVEL, so one
 *      id daw.html does not carry is `null.addEventListener`: a TypeError
 *      that kills the WHOLE module, piano roll included, and the browser
 *      swallows it. capture_test.js proves every `$("id")` exists; this file
 *      names the ARRANGEMENT cluster explicitly, so deleting one of these
 *      from the page fails here rather than removing a feature quietly.
 *
 *   3. THE PRIMITIVES — the fader law, the keymap profiles, the catalog-
 *      driven device panel and the live-sync frame. Each has a closed-form
 *      answer, so each is checked against arithmetic rather than itself.
 *
 * Runs standalone (`node server/daw/ui_test.js`) and in the pre-commit hook.
 * Touches no disk beyond reading web/ and server/daw/.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MIXER_CATALOG, MIXER_ACTIONS } from "./mixer.js";
import { stemResultDetails } from "../../web/daw-audio-results.js";
/* THE THIRD DISPATCHER. routes.js mounts server/daw/voicelab.js the way it
 * mounts mixer.js — one call before the switch — and that module OPTIONALLY
 * present is deliberate (routes.js swallows ERR_MODULE_NOT_FOUND for it). So
 * the census imports it the same way: its actions count as dispatched when it
 * is on the tree, and when it is not, a page posting them is an orphan and
 * ought to fail. Either way the gate reads the real dispatch table rather than
 * a list somebody keeps by hand. */
const voicelab = await import("./voicelab.js").catch(() => null);
/* THE FOURTH, on the same argument. server/daw/refprofile.js is the route half
 * of the reference profile (SPEC §7) and mounts the same optional way; the
 * Voice Lab's picker is its human half. Its actions count as dispatched when
 * it is here, and when it is not, the picker is posting into nothing and the
 * orphan check below fails and names them. */
const refprofile = await import("./refprofile.js").catch(() => null);
import { slugOfEvent, frameFor, DEBOUNCE_MS, createDawLive } from "./live.js";
import { PATCHES, normParams } from "./store.js";
/* the agent's tool list, for the parameter-level cross-check of the new
 * action: what daw_arrange_bigroom declares, the dialog must post */
import { dawTools } from "../mcp-daw.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, "..", "..", "web");
const JS = readFileSync(path.join(WEB, "daw.js"), "utf8");
const HTML = readFileSync(path.join(WEB, "daw.html"), "utf8");
const CSS = readFileSync(path.join(WEB, "daw.css"), "utf8");
const STYLES = readFileSync(path.join(WEB, "styles.css"), "utf8");
const ROUTES = readFileSync(path.join(HERE, "routes.js"), "utf8");

/* Strip comments and template/quoted prose before looking for code shapes,
 * so a sentence in a docblock cannot pass or fail a structural check. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const CODE = stripComments(JS);
/* THE HUMAN SURFACE IS MORE THAN ONE FILE. §3's Voice Lab is its own module
 * (web/voicelab.js, mounted the way dawear.js is) and it posts to this same
 * /api/daw door — voice_lab, peaks and set_track. A census that read only
 * daw.js would count `voice_lab` as reachable by no human while a panel was
 * sitting there posting it, which is the same shape of blind spot as the one
 * that let three actions ship with no tool. web/dawear.js is deliberately NOT
 * here: it posts to /api/daw/ear, a different dispatcher, and ear_test.js
 * owns that door. */
const VOICEJS = readFileSync(path.join(WEB, "voicelab.js"), "utf8");
const PAGES = `${CODE}\n${stripComments(VOICEJS)}`;

/** The object literal an `action: "<name>"` sits inside — i.e. the body a page
 *  really posts, read from the call rather than grepped for by field name. */
function callBody(src, action) {
  const i = src.indexOf(`action: "${action}"`);
  if (i < 0) return "";
  const open = src.lastIndexOf("{", i);
  if (open < 0) return "";
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(open, j + 1);
  }
  return "";
}

/** The top-level field NAMES of the body a page posts: every `k:` in the
 *  literal (so a `...(cond ? { k: v } : {})` spread still counts — that is how
 *  voice_lab sends three of its ten), PLUS bare shorthand at the top level.
 *  The shorthand half is not decoration: `post({ action: "x", id })` is
 *  invisible to a `k:` scan, and `profile_delete` posted exactly that — a
 *  field the tool never declared, hidden from a gate that only looked for
 *  colons. Null means the page does not post this action at all. */
function callFields(src, action) {
  const body = callBody(src, action);
  if (!body) return null;
  const named = [...body.matchAll(/([a-z_]+):/g)].map((m) => m[1]);
  const bare = [];
  let depth = 0;
  let tok = "";
  const take = () => {
    const m = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(tok);
    if (m) bare.push(m[1]);
    tok = "";
  };
  for (const ch of body.slice(1, -1)) {
    if ("{[(".includes(ch)) depth++;
    else if ("}])".includes(ch)) depth--;
    if (ch === "," && depth === 0) { take(); continue; }
    tok += ch;
  }
  take();
  return [...new Set([...named, ...bare])].filter((k) => k !== "action");
}

/** Brace-match a named function's body out of the source. */
function bodyOf(src, header) {
  const i = src.indexOf(header);
  if (i < 0) return null;
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (ch === "{") { depth++; started = true; }
    else if (ch === "}") { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  return null;
}

/* ══════════════════════════ 1. THE PARITY GATE ══════════════════════════ */

console.log("\n  -- every gesture posts an action the server actually has --");
{
  const routeActions = new Set([...ROUTES.matchAll(/^\s*case "([a-z_]+)": \{/gm)].map((m) => m[1]));
  for (const a of MIXER_ACTIONS) routeActions.add(a);
  for (const a of voicelab?.VOICELAB_ACTIONS || []) routeActions.add(a);
  for (const a of refprofile?.REFPROFILE_ACTIONS || []) routeActions.add(a);
  ok(`routes.js + its three mounts dispatch ${routeActions.size} actions`, routeActions.size > 30);

  const posted = [...new Set([...PAGES.matchAll(/\baction:\s*"([a-z_]+)"/g)].map((m) => m[1]))];
  ok(`the page posts ${posted.length} distinct actions`, posted.length > 20, posted.join(", "));

  const orphans = posted.filter((a) => !routeActions.has(a));
  ok("every action the page posts exists on the server — no parallel write path",
    orphans.length === 0, `orphans: ${orphans.join(", ")}`);

  /* ── DIRECTION 3: CAN AN AGENT REACH IT? A HARD GATE. ──────────────────
   *
   * This census had two directions and needed three. Route→page was checked,
   * route→TOOL was not checked at all, and that is precisely how `voice_lab`,
   * `render_stems` and `peaks` shipped with a route, a panel and no tool —
   * three capabilities a person could reach and an agent could not — while
   * this file printed 216 passed / 0 failed. server/welcome/ui_test.js has
   * had the agent direction as a hard gate since it shipped; the DAW, which
   * is the surface the owner actually asked to be agent-drivable, did not.
   *
   * Read from the tool family's own run() sources — the same evidence
   * mcp-daw_test.js's declared-and-dropped guard uses — so a tool that
   * declares an action in its description and posts a different one does not
   * count. mcp-daw_test.js runs the mirror of this over the WIDER family
   * (it adds ear.js's own dispatcher, whose two subjective actions are
   * exempt there); this one covers the /api/daw door, which is the door this
   * page uses, and had never been covered by either. */
  const toolPosts = new Map();
  for (const t of dawTools(async () => ({}), (x) => x)) {
    for (const m of String(t.run).matchAll(/action:\s*"([a-z0-9_]+)"/g)) {
      if (!toolPosts.has(m[1])) toolPosts.set(m[1], []);
      toolPosts.get(m[1]).push(t.name);
    }
  }
  ok(`the census sees the tool family at all (${toolPosts.size} actions posted by daw_* tools)`,
    toolPosts.size > 30);
  /* Actions deliberately left off the agent surface, WITH the reason. Empty,
   * and it should stay empty: an entry here is a capability one hand has and
   * the other does not, which is the thing this gate exists to prevent. */
  const NO_TOOL = {};
  const agentless = [...routeActions].filter((a) => !toolPosts.has(a) && !(a in NO_TOOL)).sort();
  ok("every action the server dispatches is reachable by an AGENT — a route with "
    + "no tool fails this commit",
    agentless.length === 0,
    agentless.length
      ? `NO MCP TOOL: ${agentless.join(", ")}\n          `
        + "Add the tool (server/mcp-daw.js, or the module's own mcp-*.js spread into "
        + "it), or add the action to NO_TOOL with a named reason."
      : "");
  const staleNoTool = Object.keys(NO_TOOL).filter((a) => toolPosts.has(a) || !routeActions.has(a));
  ok("no stale NO_TOOL exemption", staleNoTool.length === 0, staleNoTool.join(", "));

  /* ── DIRECTION 2: can a HUMAN reach it? A note, and why it is one. ─────
   * The page is not obliged to surface every action — probe and record_status
   * are agent-only by design, and the mastering suite has its own screen. But
   * the surface is read as ALL of the DAW's own pages, not just daw.js:
   * web/voicelab.js is a second human hand on this same door (it posts
   * voice_lab, peaks and set_track), and reading only the first would have
   * let an action be dispatched, called by an agent and reachable by nobody —
   * the hole welcome's census found the expensive way. web/dawear.js is NOT
   * here: it talks to /api/daw/ear, a different dispatcher, and ear_test.js
   * owns that door. Printed so the gap is visible when it grows. */
  const unsurfaced = [...routeActions].filter((a) => !posted.includes(a)).sort();
  console.log(`        (not surfaced in the UI: ${unsurfaced.join(", ") || "none"})`);

  /* Reads, too: the page must only fetch endpoints routes.js serves. */
  const gets = [...new Set([...PAGES.matchAll(/["'`]\/api\/daw\/([a-z0-9.]+)/gi)].map((m) => m[1]))];
  const served = [...new Set([...ROUTES.matchAll(/"\/api\/daw\/([a-z0-9.]+)/gi)].map((m) => m[1]))];
  const badGets = gets.filter((g) => !served.includes(g));
  ok("every /api/daw/… read the page makes is a route routes.js serves",
    badGets.length === 0, `unknown: ${badGets.join(", ")}`);

  /* And the mutating calls carry an actor. The provenance ledger's honesty
   * rests on the page never claiming to be the agent — on EVERY page of it,
   * which is why this reads both human surfaces and not just the big one. */
  ok("each page's POST helper stamps by:\"user\" (and neither claims by:\"agent\")",
    /body:\s*JSON\.stringify\(\{\s*by:\s*"user"/.test(CODE)
    && /body:\s*JSON\.stringify\(\{\s*by:\s*"user"/.test(stripComments(VOICEJS))
    && !/by:\s*"agent"/.test(PAGES));

  /* ── ONE LEVEL DOWN, for the three that had no tool at all ─────────────
   * An action both hands can call is not the same as an action that does the
   * same thing in both hands: the Video lab's gate learned that when the page
   * sent an argument the tool had no way to send, and that argument chose the
   * engine. Same census as arrange_bigroom's below, applied to the Voice Lab's
   * two posts — every field the panel sends must be one the tool declares. */
  const VOICE_UI_OMITS = {
    genre: "the panel measures against the neutral profile; the Ear's own screen is "
      + "where a genre is chosen, and choosing one here would be a second place to "
      + "set the same taste.",
    third_octave: "the panel always draws the 1/3-octave curve — it is the overlay "
      + "the reference profile (TIER 2) lands on, so there is nothing to switch off.",
    stage: "the panel derives the stage from the zoom it is drawing at "
      + "(samples_per_pixel), which is the whole point of the mip-map; forcing one "
      + "is a diagnostic an agent may want and a person cannot use.",
  };
  for (const [action, toolName] of [["voice_lab", "daw_voice_lab"], ["peaks", "daw_peaks"]]) {
    const sent = callFields(stripComments(VOICEJS), action) || [];
    const declared = Object.keys(
      dawTools(async () => ({}), (x) => x).find((t) => t.name === toolName)
        ?.inputSchema.properties || {});
    ok(`${action}: the panel sends ${sent.length} fields (${sent.join(", ")}) and the `
      + `tool declares every one of them`,
    sent.length > 3 && sent.every((k) => declared.includes(k)),
    sent.filter((k) => !declared.includes(k)).join(", "));
    const missing = declared.filter((k) => !sent.includes(k) && !VOICE_UI_OMITS[k]);
    ok(`...and every field ${toolName} declares, the panel can send — or the omission `
      + "is written down with a reason",
    missing.length === 0,
    missing.length ? `${missing.join(", ")} — add the control, or write it into `
      + "VOICE_UI_OMITS with a reason." : "");
  }
  const staleOmit = Object.keys(VOICE_UI_OMITS).filter((k) => {
    const both = `${callBody(stripComments(VOICEJS), "voice_lab")}`
      + `${callBody(stripComments(VOICEJS), "peaks")}`;
    return new RegExp(`\\b${k}:`).test(both);
  });
  ok("no stale VOICE_UI_OMITS entry (a field the panel now sends must lose its excuse)",
    staleOmit.length === 0, staleOmit.join(", "));

  /* ── THE SAME CENSUS, ON THE PROFILE FAMILY (§7) ──────────────────────
   *
   * The loop above covered voice_lab and peaks, and stopped there — so the
   * four profile_* actions had the action-level check and no parameter-level
   * one at all. What that hid, found by reading the two files side by side:
   * the panel posted `profile_get`/`profile_delete` with `id` while
   * daw_profile_get and daw_profile_delete declare `profile`. Nothing was
   * broken (refprofile.js reads `b.profile ?? b.id`), and that is the point —
   * one capability with two names is a divergence that works until the
   * compatibility tail is trimmed by somebody who has no reason to know it is
   * load-bearing. web/voicelab.js now posts `profile`; this gate is what
   * keeps the two spellings from parting again.
   *
   * Keyed by `action.field`, not by field: `id` means "the id to store this
   * profile under" to profile_build and "which profile" to the other two, and
   * one omits table across the family would let an excuse written for one
   * action silently cover another. */
  const PROFILE_UI_OMITS = {
    "profile_build.stem_dir": "the escape hatch for stems separated somewhere else, "
      + "which is an absolute server-local path — a thing an agent can hold and a "
      + "person cannot type into a browser without this panel becoming a file manager.",
    "profile_build.name": "the panel names a profile after the file it measured, which "
      + "is the only name a person has at that moment; renaming is a library job and "
      + "there is no library screen yet.",
    "profile_build.id": "derived from the name by the server, so two builds of the same "
      + "file replace rather than accumulate. Choosing an id by hand is how an agent "
      + "keeps a stable key across runs; a person picks from the list instead.",
    "profile_build.separate": "the panel always allows the separation — refusing to "
      + "queue one is what you want when you meant to profile something already "
      + "separated, which is an agent's precondition, not a button.",
    "profile_build.wait_ms": "the panel does not block on demucs at all: a build that is "
      + "still separating comes back `pending` and the file stays in the box to ask "
      + "again with, so there is no wait to set.",
    "profile_build.sections": "the panel always draws the energy sections — they are one "
      + "of the four pictures, so switching them off would be switching off a pane.",
  };
  const PROFILE_FAMILY = [
    ["profile_build", "daw_profile_build"], ["profile_list", "daw_profile_list"],
    ["profile_get", "daw_profile_get"], ["profile_delete", "daw_profile_delete"],
  ];
  const declaredBy = (toolName) => Object.keys(
    dawTools(async () => ({}), (x) => x).find((t) => t.name === toolName)
      ?.inputSchema.properties || {});
  for (const [action, toolName] of PROFILE_FAMILY) {
    const sent = callFields(stripComments(VOICEJS), action);
    const declared = declaredBy(toolName);
    ok(`${action}: the Voice Lab's picker posts it, so there is a human hand to compare`,
      sent !== null);
    if (sent === null) continue;
    const undeclared = sent.filter((k) => !declared.includes(k));
    ok(`${action}: every field the panel sends (${sent.join(", ") || "none"}) is one `
      + `${toolName} declares`,
    undeclared.length === 0,
    undeclared.length ? `${undeclared.join(", ")} — the panel and the tool are calling `
      + `one capability by two names. Rename the field, or declare it on the tool.` : "");
    const missing = declared.filter((k) => !sent.includes(k)
      && !PROFILE_UI_OMITS[`${action}.${k}`]);
    ok(`...and every parameter ${toolName} declares, the panel can send — or the `
      + "omission is written down with a reason",
    missing.length === 0,
    missing.length ? `${missing.join(", ")} — add the control, or write `
      + `${action}.<field> into PROFILE_UI_OMITS with a reason.` : "");
  }
  /* Both halves of stale: an excuse for a field the panel NOW sends, and an
   * excuse for a field the tool no longer declares. The second is the one a
   * rename leaves behind, and it is exactly what an omits table is for. */
  const staleProfile = Object.keys(PROFILE_UI_OMITS).filter((k) => {
    const [action, field] = k.split(".");
    const pair = PROFILE_FAMILY.find(([a]) => a === action);
    if (!pair) return true;
    const sent = callFields(stripComments(VOICEJS), action);
    return sent === null || sent.includes(field) || !declaredBy(pair[1]).includes(field);
  });
  ok("no stale PROFILE_UI_OMITS entry (an excuse must name a real parameter the panel "
    + "really does not send)", staleProfile.length === 0, staleProfile.join(", "));
}

/* ═══════════ 1b. THE PARITY GATE, ONE LEVEL DOWN: EVERY KNOB ════════════
 * Actions were reachable by both hands; PARAMETERS were not. A patch declares
 * its knobs in patches.json — the one table store.js clamps against, drums.py
 * and synths.py resolve against and daw_patches publishes — and daw_set_track
 * forwards a params object, so an agent could open the lead's filter or
 * shorten the kick while a person had no knob to turn: eight patches, sixty-
 * odd knobs, one hand. This section holds the human hand to the same table:
 * a panel drawn FROM the served row, no knob name hard-coded, writing through
 * set_track with the merged params, and the store keeping every declared
 * knob that panel could send. mcp-daw_test.js holds the agent's hand to it. */

console.log("\n  -- every knob a patch declares is a knob a person can turn --");
{
  const knobbed = Object.entries(PATCHES)
    .filter(([, r]) => r.kind === "builtin" && r.params && Object.keys(r.params).length);
  ok(`patches.json declares knobs on ${knobbed.length} builtin patches`, knobbed.length >= 8,
    knobbed.map(([id]) => id).join(", "));
  const NEW = ["bigroom_lead", "sub_bass", "riser", "impact"];
  ok("the four big-room synths are among them, each with six or more knobs",
    NEW.every((id) => Object.keys(PATCHES[id]?.params || {}).length >= 6),
    NEW.map((id) => `${id}: ${Object.keys(PATCHES[id]?.params || {}).length}`).join(", "));
  ok("hybrid_kick carries the measured `bigroom` preset as data on its row",
    PATCHES.hybrid_kick?.presets?.bigroom?.params?.punch === 1
    && /T60/.test(PATCHES.hybrid_kick.presets.bigroom.doc || ""));

  /* the served row carries the table and the presets (patches.js listPatches) */
  const PJS = readFileSync(path.join(HERE, "patches.js"), "utf8");
  ok("GET /api/daw/patches serves each row's params AND presets, straight from the manifest",
    /params: row\.params \|\| null/.test(PJS) && /presets: row\.presets \|\| null/.test(PJS));

  const draw = bodyOf(CODE, "function drawKnobs()") || "";
  const knob = bodyOf(CODE, "function knobControl(") || "";
  const write = bodyOf(CODE, "function setTrackParams(") || "";
  ok("the instrument column has a knob panel, a knob builder and ONE writer", !!draw && !!knob && !!write);
  const panel = `${draw}\n${knob}\n${write}`;
  ok("the panel draws the SERVED row's params, not a list of its own",
    /const declared = row\?\.params \|\| \{\}/.test(draw) && /Object\.entries\(all\)/.test(draw)
    && /knobControl\(t, pname, pspec\)/.test(draw));

  /* THE REAL GUARD, as for the device strip: no declared knob may appear as
   * a literal in the panel. A knob synths.py grows must render for free. */
  const knobNames = new Set(knobbed.flatMap(([, r]) => Object.keys(r.params)));
  const leaked = [...knobNames].filter((n) =>
    new RegExp(`["'\`]${n}["'\`]`).test(panel) || new RegExp(`\\b${n}\\s*:`).test(panel));
  ok(`none of the ${knobNames.size} declared knobs is hard-coded in the panel`,
    leaked.length === 0, leaked.join(", "));
  ok("a knob's range, default, unit and doc come from the spec",
    ["pspec.min", "pspec.max", "pspec.default", "pspec.unit", "pspec.doc"].every((s) => knob.includes(s)));
  ok("a knob reads the track's own value, falling back to the declared default (defaults are not stored)",
    /t\.instrument\?\.params\?\.\[pname\] \?\? pspec\.default/.test(knob));
  ok("a turn writes through set_track with a params object — the action daw_set_track posts",
    /action: "set_track"/.test(write) && /params: \{ \.\.\.before, \.\.\.patch \}/.test(write));
  ok("...merged onto the track's other knobs first (set_track REPLACES params)",
    /const before = \{ \.\.\.\(t\.instrument\?\.params \|\| \{\}\) \}/.test(write));
  ok("...with the previous params as the inverse (a knob turn is undoable)",
    /params: before \}/.test(write) && /\bact\(/.test(write));
  ok("the knob's release and double-click both go through that one writer",
    (knob.match(/setTrackParams\(/g) || []).length >= 2 && !/action: "/.test(knob));
  ok("the writer addresses the selected track of the open project — slug and track id — as daw_set_track does",
    /slug: S\.slug, track: t\.id, params: \{ \.\.\.before, \.\.\.patch \}/.test(write));
  ok("the panel lives in the browser (instrument) column, under the palette it reads its row from",
    (() => {
      const a = HTML.indexOf('<aside class="d-browser"');
      const z = HTML.indexOf("</aside>", a);
      const k = HTML.indexOf('id="knobs"');
      return a >= 0 && k > a && k < z && HTML.indexOf('id="palette"') < k;
    })());
  ok("the panel names the agent's equivalent (daw_set_track) so a person knows the other hand exists",
    /daw_set_track/.test(draw) && /daw_set_track/.test(HTML));
  ok("the knob's tooltip carries the declared doc, range and default — patches.json's words, not the page's",
    /pspec\.doc/.test(knob) && /pspec\.min\}\.\.\$\{pspec\.max\}/.test(knob));
  ok("presets are buttons that send the row's OWN params (nothing applies one for you)",
    /row\?\.presets/.test(draw) && /setTrackParams\(t, p\.params/.test(draw));
  ok("the panel redraws when the selection, the document or the palette changes",
    /drawKnobs\(\)/.test(bodyOf(CODE, "function selectTrack(") || "")
    && /drawKnobs\(\)/.test(bodyOf(CODE, "async function refreshDoc(") || "")
    && /drawKnobs\(\)/.test(bodyOf(CODE, "async function loadPalette()") || ""));

  /* the two universal keys: the page's table must agree with the store's clamps */
  const tk = JS.match(/const TRACK_KNOBS = \{([\s\S]*?)\n\};/);
  ok("the universal knobs (transpose, gain_db) are one declared table", !!tk);
  const uni = tk ? [...tk[1].matchAll(/^\s{2}([a-z_]+):\s*\{\s*min:\s*(-?[\d.]+),\s*max:\s*(-?[\d.]+),\s*default:\s*(-?[\d.]+)/gm)]
    .map((m) => [m[1], Number(m[2]), Number(m[3]), Number(m[4])]) : [];
  ok("...naming exactly transpose and gain_db", uni.map((u) => u[0]).sort().join(",") === "gain_db,transpose");
  for (const [k, lo, hi, def] of uni) {
    ok(`${k}: the page's ${lo}..${hi} (default ${def}) is the store's own clamp`,
      normParams({ [k]: hi + 1 }, "pluck")[k] === hi && normParams({ [k]: lo - 1 }, "pluck")[k] === lo
      && normParams({ [k]: def }, "pluck")[k] === undefined
      && normParams({ [k]: hi }, "pluck")[k] === hi && normParams({ [k]: lo }, "pluck")[k] === lo);
  }

  /* the store's half of the human path: every knob the panel can send is
   * kept, clamped to its own row, and dropped when it is the default */
  let kept = 0;
  const lost = [];
  for (const [pid, row] of knobbed) {
    for (const [k, s] of Object.entries(row.params)) {
      const at = (v) => (v === s.default ? undefined : v);     // defaults are dropped, by design
      const v = s.min === s.default ? s.max : s.min;
      const good = normParams({ [k]: v }, pid)[k] === v
        && normParams({ [k]: s.max + 1 }, pid)[k] === at(s.max)
        && normParams({ [k]: s.min - 1 }, pid)[k] === at(s.min)
        && normParams({ [k]: s.default }, pid)[k] === undefined;
      if (good) kept++; else lost.push(`${pid}.${k}`);
    }
  }
  ok(`the store keeps every one of the ${kept + lost.length} declared knobs a turn could send, clamped to its row`,
    lost.length === 0, lost.join(", "));
  ok("a knob sent to the WRONG patch is dropped (a knob exists on one row, not everywhere)",
    normParams({ resonance: 0.9 }, "hybrid_kick").resonance === undefined
    && normParams({ punch: 0.9 }, "bigroom_lead").punch === undefined);

  /* the new ACTION, by name, on the human side — the census above catches an
   * orphan; this catches the arranger quietly leaving the page */
  ok("the arranger is a human's button too: the page posts arrange_bigroom",
    /action: "arrange_bigroom"/.test(CODE));
  ok("the palette orders the new families (synth, fx) at the top, not below vocal",
    /const FAMILY_ORDER = \["synth", "fx"/.test(JS));

  /* THE NEW ACTION, AT THE PARAMETER LEVEL. daw_arrange_bigroom declares its
   * parameters in a schema; the dialog posts a body. Every parameter the
   * agent can send, a person can also set from the dialog — or the omission
   * is written down here with its reason. Read from the handler's own api()
   * call, the same evidence the census above uses. */
  const arrangeTool = dawTools(async () => ({}), (x) => x).find((t) => t.name === "daw_arrange_bigroom");
  const handler = bodyOf(CODE, '$("arrRun").addEventListener("click", async () =>') || "";
  const call = handler.match(/api\(\{\s*action: "arrange_bigroom",([\s\S]*?)\}\);/);
  const posted = call ? [...call[1].matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]) : [];
  const UI_OMITS = {
    slug: "the dialog ALWAYS creates a new project (the person names it): the page's project list has no "
      + "'empty project' to point at, and an arrangement dropped onto tracks is refused by the route anyway. "
      + "An agent may lay into an existing EMPTY project by slug.",
  };
  const agentParams = Object.keys(arrangeTool?.inputSchema.properties || {});
  const humanMissing = agentParams.filter((q) => !posted.includes(q) && !UI_OMITS[q]);
  ok(`arrange_bigroom: every parameter the agent's tool declares, the dialog posts (${agentParams.length} declared: `
     + `${agentParams.join(", ")}; posted: ${posted.join(", ")})`,
    agentParams.length >= 6 && humanMissing.length === 0,
    humanMissing.length ? `${humanMissing.join(", ")} — add a field, or write the omission into UI_OMITS with a reason.` : "");
  ok("...and the dialog posts nothing the tool cannot", posted.length > 0 && posted.every((q) => agentParams.includes(q)),
    posted.filter((q) => !agentParams.includes(q)).join(", "));
  ok("...and every written-down omission names a real parameter the page really does not post",
    Object.keys(UI_OMITS).every((q) => agentParams.includes(q) && !posted.includes(q)));
  ok("the form field is parsed into the route's own {type, bars} shape and the SERVER validates it (the page only parses)",
    /function parseForm\(/.test(CODE) && /type: m\[1\]\.toLowerCase\(\), bars: Number\(m\[2\]\)/.test(CODE)
    && /structure: parseForm\(\$\("arrForm"\)\.value\)/.test(CODE) && !/% 4/.test(bodyOf(CODE, "function parseForm(") || "% 4"));
  ok("the dialog's default form is the arranger's own (intro 8 | build 16 | drop 32 | break 16 | build 16 | drop 32 | outro 8)",
    /value="intro 8 \| build 16 \| drop 32 \| break 16 \| build 16 \| drop 32 \| outro 8"/.test(HTML));
}


/* ═══════ 1c. THE PANEL, RUN: EVERY KNOB DRAGGED, EVERY PRESET PRESSED ════
 * Reading the builders proves their shape; running them proves the gesture.
 * The three functions and the universal table are lifted out of daw.js by
 * name and evaluated against a stub DOM and a capturing act(). For every
 * builtin patch that declares knobs, a track is drawn, every knob is dragged
 * to an extreme and released, double-clicked back, and every preset button
 * pressed — and each body that leaves is held to daw_set_track's own shape:
 * set_track, this slug, this track, params carrying the knob at an in-range
 * value the store keeps, the previous params as the inverse. This is the
 * human half of what mcp-daw_test.js executes from the agent's hand. */

console.log("\n  -- the panel, run: every knob dragged, every preset pressed --");
{
  const table = JS.match(/const TRACK_KNOBS = \{[\s\S]*?\n\};/)?.[0] || "";
  const src = [table, bodyOf(CODE, "function drawKnobs()"), bodyOf(CODE, "function knobControl("),
               bodyOf(CODE, "function setTrackParams(")].join("\n");
  const els = {};
  const mk = () => {
    const el = {
      className: "", textContent: "", innerHTML: "", title: "", kids: [], handlers: {},
      style: { setProperty() {} },
      append(...k) { el.kids.push(...k); },
      appendChild(k) { el.kids.push(k); return k; },
      addEventListener(type, fn) { (el.handlers[type] ||= []).push(fn); },
    };
    Object.defineProperty(el, "onclick", {
      set(fn) { (el.handlers.click ||= []).push(fn); }, get() { return el.handlers.click?.[0]; },
    });
    return el;
  };
  const posted = [];
  const env = {
    document: { createElement: () => mk() },
    $: (id) => (els[id] ||= mk()),
    fmt: (v) => String(v),
    S: { slug: "song", dragging: false },
    capturePointer() {}, releasePointer() {},
    PALETTE: { rows: Object.entries(PATCHES).map(([id, r]) => ({ id, label: r.label, params: r.params || null, presets: r.presets || null })) },
    track: null,
  };
  let panel = null;
  try {
    const build = new Function("document", "$", "fmt", "S", "capturePointer", "releasePointer", "PALETTE", "selTrack", "act",
      `${src}\nreturn { drawKnobs, knobControl, setTrackParams, TRACK_KNOBS };`);
    panel = build(env.document, env.$, env.fmt, env.S, env.capturePointer, env.releasePointer, env.PALETTE,
      () => env.track, async (body, inverse, label) => { posted.push({ body, inverse, label }); return {}; });
  } catch (err) { ok("the panel's builders evaluate on their own (they reach nothing but $ / S / act / fmt / the palette)", false, err.message); }

  const knobbed = Object.entries(PATCHES)
    .filter(([, r]) => r.kind === "builtin" && r.params && Object.keys(r.params).length);
  const fire = (el, type, ev) => (el.handlers[type] || []).map((fn) => fn(ev));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  for (const [pid, row] of knobbed) {
    if (!panel) break;
    env.track = { id: `trk_${pid}`, name: pid, instrument: { patch: pid, params: {} } };
    els.knobs = mk();
    posted.length = 0;
    panel.drawKnobs();
    const wraps = els.knobs.kids.filter((k) => k.className === "d-param");
    const names = [...Object.keys(panel.TRACK_KNOBS), ...Object.keys(row.params)];
    ok(`${pid}: the panel draws its ${Object.keys(row.params).length} declared knobs after the 2 universal ones, in the row's order`,
      wraps.length === names.length && wraps.every((w, i) => w.kids[2]?.textContent === names[i].replace(/_/g, " ")),
      `${wraps.length} drawn: ${wraps.map((w) => w.kids[2]?.textContent).join(", ")}`);

    const bad = [];
    for (const [i, pname] of names.entries()) {
      const spec = panel.TRACK_KNOBS[pname] || row.params[pname];
      const k = wraps[i]?.kids[0];                       // wrap.append(k, val, lab)
      if (!k) { bad.push(`${pname}: no knob element`); continue; }
      const want = spec.default === spec.max ? spec.min : spec.max;    // an in-range value that is not the default
      const dy = spec.default === spec.max ? 4000 : -4000;               // far past the throw: clamps at the extreme
      const n0 = posted.length;
      fire(k, "pointerdown", { clientY: 500, pointerId: 1 });
      fire(k, "pointermove", { clientY: 500 + dy, shiftKey: false });
      await Promise.all(fire(k, "pointerup", { pointerId: 1 }));
      const b = posted[n0]?.body;
      const inv = posted[n0]?.inverse;
      const kept = b ? normParams(b.params, pid)[pname] : undefined;
      const dragged = posted.length === n0 + 1 && b.action === "set_track" && b.slug === "song" && b.track === `trk_${pid}`
        && b.params?.[pname] === want && kept === want && inv?.action === "set_track" && same(inv.params, {});
      await Promise.all(fire(k, "dblclick", {}));
      const d = posted[n0 + 1]?.body;
      const reset = posted.length === n0 + 2 && d.action === "set_track" && d.params?.[pname] === spec.default
        && normParams(d.params, pid)[pname] === undefined;
      if (!dragged || !reset) bad.push(`${pname}: ${JSON.stringify({ dragged, reset, sent: b?.params, kept, dbl: d?.params })}`);
    }
    ok(`${pid}: all ${names.length} knobs, dragged to an extreme, post set_track {slug, track, params} the store keeps — and double-click posts the default the store drops`,
      bad.length === 0, bad.join("\n          "));

    /* the panel reads the TRACK's value, not the default, when one is stored */
    const [first, fspec] = Object.entries(row.params)[0];
    const stored = fspec.default === fspec.max ? fspec.min : fspec.max;
    env.track.instrument.params = { [first]: stored };
    els.knobs = mk();
    panel.drawKnobs();
    const w = els.knobs.kids.filter((k) => k.className === "d-param")[Object.keys(panel.TRACK_KNOBS).length];
    ok(`${pid}: a stored ${first} is what the knob shows (${stored}), and a turn of another knob carries it along (set_track replaces params)`,
      String(w?.kids[1]?.textContent || "").startsWith(String(stored))
      && (await (async () => {
        posted.length = 0;
        const other = Object.keys(row.params)[1] || Object.keys(panel.TRACK_KNOBS)[0];
        const idx = names.indexOf(other);
        const k = els.knobs.kids.filter((x) => x.className === "d-param")[idx]?.kids[0];
        fire(k, "pointerdown", { clientY: 0, pointerId: 1 });
        fire(k, "pointermove", { clientY: -4000, shiftKey: false });
        await Promise.all(fire(k, "pointerup", { pointerId: 1 }));
        return posted[0]?.body?.params?.[first] === stored && posted[0].body.params[other] !== undefined
          && same(posted[0].inverse.params, { [first]: stored });
      })()),
      JSON.stringify({ shown: w?.kids[1]?.textContent, posted: posted[0]?.body?.params }));

    /* presets: one button each, sending the row's OWN params */
    env.track.instrument.params = {};
    els.knobs = mk();
    panel.drawKnobs();
    const presets = Object.entries(row.presets || {});
    const pr = els.knobs.kids.find((k) => k.className === "d-presets");
    if (presets.length) {
      posted.length = 0;
      for (const b of pr?.kids || []) await Promise.all(fire(b, "click", {}));
      ok(`${pid}: ${presets.length} preset button(s) — ${presets.map(([n]) => n).join(", ")} — each posts set_track with exactly the row's params for it`,
        pr && pr.kids.length === presets.length
        && presets.every(([n, p], i) => pr.kids[i].textContent === n && same(posted[i]?.body?.params, p.params)
          && posted[i].body.action === "set_track"),
        JSON.stringify(posted.map((x) => x.body.params)));
    } else {
      ok(`${pid}: no presets declared, no preset row drawn`, !pr);
    }
  }
  ok("with no track selected the panel is empty and says how to get one",
    (() => { if (!panel) return false; env.track = null; els.knobs = mk(); panel.drawKnobs();
             return els.knobs.kids.length === 0 && /Select a track/.test(els.knobNote.textContent); })());
}

/* ══════════════════════════ 2. THE WIRING GATE ══════════════════════════ */

console.log("\n  -- the arrangement window is wired to elements that exist --");
{
  const inHtml = new Set([...HTML.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const wanted = [...new Set([...JS.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))];
  const missing = wanted.filter((id) => !inHtml.has(id));
  ok(`every id daw.js reaches for exists in daw.html (${wanted.length} checked)`,
    missing.length === 0, missing.join(", "));

  /* The four zones of the report's chosen metaphor, by name. */
  for (const [zone, ids] of Object.entries({
    transport: ["playBtn", "stopBtn", "recBtn", "loopBtn", "clickChk", "posLbl", "posSec",
                "tBpm", "tBar", "tSet", "mNum", "mDen", "mBar", "mSet", "cpuTxt"],
    browser: ["palette", "palCnt", "presetList", "credits", "credCnt", "logBox", "events"],
    arrangement: ["arrWrap", "arrHeads", "arrCanvas", "tracks", "addTrackBtn", "splitH"],
    editor: ["roll", "rollWrap", "paneRoll", "paneAuto", "autoList", "autoCanvas",
             "modeDraw", "modeSel", "modeErase", "gridSel", "quantBtn", "quantAmt",
             "scaleRoot", "scaleType", "foldChk", "ghostChk", "tabRoll", "tabAuto"],
    mixer: ["mixStrips", "metersBtn", "autoWriteBtn", "returnAddBtn", "meterNote"],
    devices: ["devChain", "devAdd", "devTarget", "devNote"],
    dialogs: ["licDlg", "licBody", "licAccept", "bounceDlg", "bounceRun", "kmDlg", "kmBody"],
    arranger: ["arrBtn", "arrDlg", "arrName", "arrSeed", "arrKey", "arrTempo", "arrForm", "arrBody", "arrRun", "arrClose"],
    knobs: ["knobs", "knobCnt", "knobNote"],
    live: ["liveDot", "liveTxt", "status"],
  })) {
    const gone = ids.filter((id) => !(inHtml.has(id) && JS.includes(`$("${id}")`)));
    ok(`the ${zone} zone carries all ${ids.length} of its controls`, gone.length === 0, gone.join(", "));
  }

  /* The capture cluster survived the rewrite — DAWREC's features are not
   * quietly lost by a UI stage that only cared about the piano roll. */
  const capture = ["recBtn", "cntIn", "recDev", "impBtn", "impFile", "calOpen", "midiDev",
                   "midiRecBtn", "midiQuant", "takes", "calDlg", "calRunMic", "calRunSyn",
                   "calStore", "calResult", "calNote", "calStored"];
  const lost = capture.filter((id) => !(inHtml.has(id) && JS.includes(`$("${id}")`)));
  ok("the [DAWREC] capture cluster is intact after the UI rewrite", lost.length === 0, lost.join(", "));

  ok("daw.html links the Studio's own stylesheet (one palette, not a sixth)",
    /<link[^>]+href="styles\.css"/.test(HTML) && /<link[^>]+href="daw\.css"/.test(HTML));
}

/* ══════════════════════ 3a. THE FADER LAW ═══════════════════════════════
 * A fader whose taper is linear in dB feels wrong to everyone who has
 * touched a console: real travel expands near unity. The law is a piecewise
 * table in daw.js; this section re-implements nothing — it PARSES the table
 * and proves the properties the UI relies on. */

console.log("\n  -- the dB-law fader is a law, not a lerp --");
{
  const src = JS.match(/const FADER_SEGS = \[([\s\S]*?)\];/);
  ok("the fader law is a declared table", !!src);
  const segs = [...src[1].matchAll(/\[\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)\s*\]/g)]
    .map((m) => m.slice(1).map(Number));
  ok(`the table has ${segs.length} segments`, segs.length >= 3);
  ok("it spans the whole throw, 0 → 1", near(segs[0][0], 0) && near(segs[segs.length - 1][1], 1));
  ok("it spans the mixer's dB range, −60 → +12",
    near(segs[0][2], -60) && near(segs[segs.length - 1][3], 12));

  let contiguous = true, monotonic = true;
  for (let i = 1; i < segs.length; i++) {
    if (!near(segs[i][0], segs[i - 1][1]) || !near(segs[i][2], segs[i - 1][3])) contiguous = false;
    if (segs[i][3] <= segs[i][2]) monotonic = false;
  }
  ok("the segments are contiguous in both position and dB", contiguous);
  ok("every segment rises (the law is invertible)", monotonic);

  const posToDb = (p) => {
    const x = Math.max(0, Math.min(1, p));
    for (const [p0, p1, d0, d1] of segs) if (x <= p1 || p1 === 1) return d0 + (d1 - d0) * (x - p0) / (p1 - p0);
    return 12;
  };
  const dbToPos = (db) => {
    const d = Math.max(-60, Math.min(12, db));
    for (const [p0, p1, d0, d1] of segs) if (d <= d1 || d1 === 12) return p0 + (p1 - p0) * (d - d0) / (d1 - d0);
    return 1;
  };
  let roundTrip = true;
  for (let i = 0; i <= 100; i++) if (!near(dbToPos(posToDb(i / 100)), i / 100, 1e-9)) roundTrip = false;
  ok("position → dB → position round-trips exactly at 101 points", roundTrip);

  const unity = dbToPos(0);
  ok(`unity sits at ${(unity * 100).toFixed(0)} % of the throw, not at the top`,
    unity > 0.6 && unity < 0.9);
  /* The expansion property, stated as arithmetic: the top quarter of the
   * throw must carry FEWER dB than the bottom quarter. That is the whole
   * point of a fader taper. */
  const topSpan = posToDb(1) - posToDb(0.75);
  const botSpan = posToDb(0.25) - posToDb(0);
  ok(`the taper expands near unity (top quarter ${topSpan.toFixed(0)} dB < bottom quarter ${botSpan.toFixed(0)} dB)`,
    topSpan < botSpan);
  ok("the fader's dB range matches the mixer's own limits",
    near(posToDb(0), -60) && near(posToDb(1), 12));
}

/* ══════════════════════ 3b. KEYMAP PROFILES ════════════════════════════ */

console.log("\n  -- three keymap profiles over one action table --");
{
  const body = JS.match(/const KM_ACTIONS = \{([\s\S]*?)\n\};/);
  const maps = JS.match(/const KEYMAPS = \{([\s\S]*?)\n\};/);
  ok("both tables are declared", !!body && !!maps);
  const actions = [...body[1].matchAll(/^\s{2}([a-z_]+):\s*\{/gm)].map((m) => m[1]);
  ok(`${actions.length} gestures are bindable`, actions.length >= 12, actions.join(", "));

  const profiles = [...maps[1].matchAll(/^\s{2}([a-z]+):\s*\{/gm)].map((m) => m[1]);
  /* ⚠ STILL AN ORDERED EQUALITY, NOT "any three". The point of this pin is that
   * a profile cannot be silently added or dropped; loosening it while renaming
   * would have quietly thrown that away. The names changed because the old ones
   * were three other companies' products — see NOTICE, TRADEMARKS. */
  ok("the three profiles are ctrl, fkeys and numeric",
    JSON.stringify(profiles) === JSON.stringify(["ctrl", "fkeys", "numeric"]), profiles.join(", "));

  /* One spot-check per profile, on the binding that most distinguishes it.
   * Named by the GESTURE rather than by another company's product — see
   * NOTICE, TRADEMARKS — which is also what the check is really about. */
  const SPOT = {
    ctrl: { says: "the Ctrl profile plays on Space and draws with B",
            test: (k) => k.play_stop === "Space" && k.draw === "B" },
    fkeys: { says: "the function-key profile records on R and draws with P",
             test: (k) => k.record === "R" && k.draw === "P" },
    numeric: { says: "the number-tool profile quantizes on Q and splits on 3",
               test: (k) => k.quantize === "Q" && k.split === "3" },
  };
  const spotted = [];
  for (const p of profiles) {
    const block = maps[1].match(new RegExp(`${p}:\\s*\\{[\\s\\S]*?keys:\\s*\\{([\\s\\S]*?)\\},`));
    const keys = Object.fromEntries([...block[1].matchAll(/([a-z_]+):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
    const missing = actions.filter((a) => !keys[a]);
    ok(`the ${p} profile binds every gesture`, missing.length === 0, missing.join(", "));
    const seen = new Map();
    const clashes = [];
    for (const [a, k] of Object.entries(keys)) {
      if (seen.has(k)) clashes.push(`${k} = ${seen.get(k)} and ${a}`);
      seen.set(k, a);
    }
    ok(`the ${p} profile has no two gestures on one key`, clashes.length === 0, clashes.join("; "));
    /* ⚠ A TABLE, NOT THREE `if (p === "...")` GUARDS. Those were written
     * against the old profile names, and when the names changed the guards
     * simply stopped matching: no failure, no message, three assertions gone
     * and a pass count three lower than the day before. A check that quietly
     * stops checking is the exact thing this suite exists to prevent.
     *
     * Driven off the table below, and the pin after the loop asserts every
     * profile in KEYMAPS has a row — so the next rename fails loudly, naming
     * the profile nobody is spot-checking any more. */
    const spot = SPOT[p];
    if (spot) { spotted.push(p); ok(spot.says, spot.test(keys)); }
  }
  /* ⚠ THE PIN THAT MAKES THE NEXT RENAME LOUD. Without it, a profile with no
   * row in SPOT is simply not spot-checked and nothing says so — which is how
   * three of these went missing in the first place. */
  ok("every profile has a spot-check, so a rename cannot quietly drop one",
    JSON.stringify(spotted) === JSON.stringify(profiles),
    `checked ${spotted.join(", ") || "none"} of ${profiles.join(", ")}`);

  ok("the active binding is written into tooltips (a profile you can see)",
    /const TIP_BINDINGS = \[/.test(JS) && /el\.title = `\$\{base\} — \$\{binding\(act\)/.test(JS));
  ok("typing in a field never fires a gesture",
    /\/\^\(INPUT\|SELECT\|TEXTAREA\)\$\/\.test\(t\.tagName\)/.test(CODE));
}

/* ══════════════════ 3c. THE DEVICE PANEL IS CATALOG-DRIVEN ═════════════ */

console.log("\n  -- the device strip is drawn FROM the served catalog --");
{
  const draw = bodyOf(CODE, "function drawDevices()");
  const param = bodyOf(CODE, "function paramControl(");
  ok("both builders exist", !!draw && !!param);
  ok("the chain iterates the catalog's params, not a list of its own",
    /Object\.entries\(spec\?\.params \|\| \{\}\)/.test(draw));

  /* THE REAL GUARD: no parameter name may appear as a literal inside the
   * control builder. Any device rack.py grows must render for free. */
  const names = new Set();
  for (const d of Object.values(MIXER_CATALOG)) for (const n of Object.keys(d.params)) names.add(n);
  const leaked = [...names].filter((n) => new RegExp(`["'\`]${n}["'\`]`).test(param) || new RegExp(`\\b${n}\\s*:`).test(param));
  ok(`none of the ${names.size} device parameters is hard-coded in the control builder`,
    leaked.length === 0, leaked.join(", "));

  const types = [...param.matchAll(/pspec\.type === "([a-z]+)"/g)].map((m) => m[1]);
  ok("bool, enum and track have explicit branches; number is the fall-through knob",
    ["bool", "enum", "track"].every((t) => types.includes(t))
    && /d-knob/.test(param) && /pspec\.min/.test(param) && /pspec\.max/.test(param),
    types.join(", "));
  const kinds = new Set();
  for (const d of Object.values(MIXER_CATALOG)) for (const s of Object.values(d.params)) kinds.add(s.type);
  const unhandled = [...kinds].filter((k) => k !== "number" && !types.includes(k));
  ok(`every parameter type the catalog uses (${[...kinds].join(", ")}) has a control`,
    unhandled.length === 0, unhandled.join(", "));

  ok("the device list itself comes from GET /api/daw/rack, not a constant",
    /get\("\/api\/daw\/rack"\)/.test(CODE) && /RACK\.devices = r\.catalog\?\.devices/.test(CODE));
  ok("a catalog disagreement is shown, not hidden", /tables_agree/.test(CODE));
}

/* ══════════════════ 3d. AUTOMATION USES THE STORE'S SHAPE ══════════════ */

console.log("\n  -- automation reads and writes the store's own keyframes --");
{
  ok("keys are { t, v } with t in FLOAT BARS, the shape mixer.js stores",
    /\{ t: Math\.max\(1, Number\(k\.t\.toFixed\(4\)\)\)/.test(CODE)
    && /qOfBarFloat|barFloatOfQ/.test(CODE));
  const write = bodyOf(CODE, "async function writeLane(");
  ok("a lane writes through the parameter's OWN action (ref.write), never a special one",
    /ref\.write\(/.test(write) && !/action: "/.test(write));

  const ref = bodyOf(CODE, "function laneRef(");
  for (const [what, act] of [["fader", "mixer_set"], ["pan", "mixer_set"],
                             ["send", "send_set"], ["insert param", "insert_set"]]) {
    ok(`a ${what} lane writes with ${act}`, new RegExp(`action: "${act}"`).test(ref));
  }
  ok("only animatable number params can get a lane (the catalog decides)",
    /spec\.type === "number" && spec\.animatable !== false/.test(CODE));

  /* A ride is thinned into keys and merged — it must not silently drop the
   * keys that were already there outside the ridden span. */
  const ride = bodyOf(CODE, "async function writeRide(");
  ok("a fader ride merges with the keys outside its own span",
    /ref\.keys\(\)\.filter\(/.test(ride));
}

/* ══════════════════ 3e. LIVE SYNC ══════════════════════════════════════ */

console.log("\n  -- live sync: one socket, a frame per document revision --");
{
  ok("only the document wakes the page — not a render, a take or a click bed",
    slugOfEvent("mysong/project.json") === "mysong"
    && slugOfEvent("mysong/cache/reg0_abc123def456.wav") === null
    && slugOfEvent("mysong/audio/tk_abc.flac") === null
    && slugOfEvent("mysong/project.json.tmp-1234") === null
    && slugOfEvent("project.json") === null
    && slugOfEvent(null) === null);
  ok("a path that tries to escape the tree is not a slug",
    slugOfEvent("../evil/project.json") === null && slugOfEvent("a/b/project.json") === null);

  const f = frameFor("song", {
    name: "Song", updatedAt: 1234,
    ledger: [{ at: 9, by: "agent", action: "add_note", detail: "pitch 60 at 1.1.0" }],
  });
  ok("the frame names the revision and WHO changed it",
    f.type === "daw" && f.slug === "song" && f.updatedAt === 1234
    && f.by === "agent" && f.action === "add_note" && f.detail.includes("pitch 60"),
    JSON.stringify(f));
  ok("an unknown actor is never promoted to \"agent\"",
    frameFor("s", { ledger: [{ by: "who?" }] }).by === "user"
    && frameFor("s", {}).by === "user");
  ok("a document with no ledger still produces a legal frame",
    frameFor("s", { updatedAt: 7 }).action === "write");
  ok(`the debounce is short enough to feel live (${DEBOUNCE_MS} ms)`, DEBOUNCE_MS > 0 && DEBOUNCE_MS <= 120);

  const live = createDawLive({ dir: "nowhere", broadcast: () => {} });
  ok("createDawLive exposes start/stop and stopping an unstarted watch is safe",
    typeof live.start === "function" && typeof live.stop === "function"
    && (live.stop(), true));

  ok("the page listens on the studio's EXISTING /live socket",
    /new WebSocket\(`ws:\/\/\$\{location\.host\}\/live`\)/.test(CODE));
  ok("the page acts on type:\"daw\" frames for the project it holds",
    /m\.type !== "daw" \|\| m\.slug !== S\.slug/.test(CODE));
  ok("a frame for a revision the page already has is ignored (no self-echo loop)",
    /m\.updatedAt === S\.proj\.updatedAt/.test(CODE));
  const remote = bodyOf(CODE, "function onRemoteChange(") || "";
  ok("an agent edit re-reads the document AND re-renders in the captured session",
    /await refreshDoc\(session\)/.test(remote)
    && /await renderAndSwap\(undefined, undefined, undefined, session\)/.test(remote)
    && remote.indexOf("await refreshDoc(") < remote.indexOf("await renderAndSwap("));
}

/* ══════════════════ 3f. THE HONESTY SURFACES ═══════════════════════════ */

console.log("\n  -- the things the UI must not quietly stop saying --");
{
  ok("the four generate-this-part rows are shown, refusal and all",
    /row\.kind === "generate"/.test(CODE) && /d-refusal/.test(CODE) && /row\.refusal/.test(CODE));
  ok("a licence is shown BEFORE a byte moves (the route's gate, surfaced)",
    /install_patch/.test(CODE) && /needsAccept/.test(CODE) && /accept_licence: true/.test(CODE));
  ok("attribution-required packs are marked in the palette AND get a credits panel",
    /attribution_required/.test(CODE) && /function drawCredits\(/.test(CODE));
  ok("the bounce dialog prints the attribution lines a human can read",
    /function paintBounceCredits\(/.test(CODE) && /c\.attribution/.test(bodyOf(CODE, "function paintBounceCredits(") || "")
      && /paintBounceCredits\(r\.credits\)/.test(CODE) && /Credits and attribution/.test(HTML));
  ok("per-track meters say they are MEASURED, not live",
    /measured, not live/.test(JS) && /action: "meters"/.test(CODE));
  ok("the master meter says where its numbers come from",
    /live peak from the audio this page is playing/.test(JS));
  ok("the dirty-region renderer's work is shown while it happens",
    /cpu\("re-rendering…", true\)/.test(CODE) && /S\.pending/.test(CODE));
  ok("the session log distinguishes the agent's edits from the human's",
    /d-logrow d-\$\{e\.by === "agent" \? "agent" : "user"\}/.test(CODE));
  ok("the click bed is the engine's, so it cannot drift from the render",
    /\/api\/daw\/click\//.test(CODE));
}

/* ══════════════════ 3g. ONE PALETTE ════════════════════════════════════ */

console.log("\n  -- one palette: daw.css invents no colour --");
{
  ok("no hex colours in daw.css", !/#[0-9a-f]{3,8}\b/i.test(CSS.replace(/\/\*[\s\S]*?\*\//g, "")));
  const rootBlock = STYLES.match(/^:root \{([\s\S]*?)^\}/m)[1];
  const tokenHues = new Set([...rootBlock.matchAll(/hsla?\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%/g)]
    .map((m) => `${m[1]},${m[2]},${m[3]}`));
  const used = [...CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/hsla?\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%/g)]
    .map((m) => `${m[1]},${m[2]},${m[3]}`);
  const strangers = [...new Set(used)].filter((h) => !tokenHues.has(h) && !/^\d+,0,/.test(h));
  ok(`every colour in daw.css is a token or an alpha of one (${used.length} checked)`,
    strangers.length === 0, `strangers: ${strangers.join(" | ")}`);
  ok("canvas ink is read from the same custom properties at runtime",
    /getPropertyValue\(`--\$\{k\}`\)/.test(CODE) && /function tint\(/.test(CODE));
  ok("every class in daw.css is namespaced d- (styles.css already owns .row, .bar, .panel)",
    [...new Set([...CSS.matchAll(/^\.([a-zA-Z][\w-]*)/gm)].map((m) => m[1]))]
      .every((c) => c.startsWith("d-")),
    [...new Set([...CSS.matchAll(/^\.([a-zA-Z][\w-]*)/gm)].map((m) => m[1]))]
      .filter((c) => !c.startsWith("d-")).join(", "));
}

/* ══════════════════ 3h. UNEVEN BARS ════════════════════════════════════
 * The grid must be drawn from the SERVER's timeline rows, never from an
 * assumed 4/4. Structural, because a 7/8 bar being narrower than a 4/4 bar
 * is the feature — and this is the one bug that would look like a rounding
 * error for weeks. */

console.log("\n  -- the grid is derived from the meter map, never assumed --");
{
  ok("no drawing loop assumes four beats in a bar",
    !/for \(let b = 1; b < 4;/.test(CODE) && !/\bnum = 4\b/.test(CODE));
  ok("beat lines come from the row's own numerator", /for \(let b = 1; b < r\.num; b\+\+\)/.test(CODE));
  ok("a beat's width comes from the row's own denominator", /const beatQ = 4 \/ r\.den;/.test(CODE));
  ok("bar positions come from the server's qStart, not from multiplication",
    /r\.qStart \* S\.arrPxq/.test(CODE) && /KEYS_W \+ r\.qStart \* S\.pxq/.test(CODE));
  ok("a meter or tempo change is marked on the ruler",
    /r\.num !== rowOf\(r\.bar - 1\)\?\.num/.test(CODE));
  ok("the quantize grid clamps inside the bar it is in (a 7/8 bar has 7 beats of room)",
    /row\.ticksPerBar - 1/.test(CODE));
}


/* ══════════ 4. §1 THE CLOCK: A WORKER, AND A WINDOW THAT HEALS ══════════
 * Two defects with one measurement between them. `setInterval(schedulerTick,
 * 150)` was commented in this repo as "the 150 ms floor that always runs",
 * and in a hidden tab the gap between wakes measured 1 090 ms against a
 * 0.8 s look-ahead — so a wake could arrive AFTER a region boundary should
 * have started, and scheduleOcc's late branch would then start that buffer
 * part-way in behind a 5 ms fade, clipping the attack on a downbeat in
 * exactly the situation where nobody is watching the window to see why.
 *
 * The fix is two things and this section holds both: the ticker is a Worker
 * (a Blob URL, no second file, with a setTimeout fallback in the same
 * function for hosts that refuse to construct one), and the schedule window
 * is carried rather than recomputed, so a late wake WIDENS it instead of
 * stepping over a boundary. */

console.log("\n  -- the transport's clock is a worker, and its window heals --");
{
  ok("no bare setInterval on the scheduler is left in the page",
    !/setInterval\(\s*schedulerTick/.test(CODE),
    "a page timer is throttled in a background tab; the measured worst gap was 1 090 ms");
  const tick = bodyOf(CODE, "function makeTicker(");
  ok("makeTicker exists and builds its worker from a Blob URL (no second file to serve)",
    !!tick && /new Worker\(/.test(tick) && /createObjectURL\(new Blob\(/.test(tick));
  ok("...with the setTimeout fallback in the SAME function, so the two paths are read together",
    !!tick && /new Worker\(/.test(tick) && /setTimeout\(/.test(tick),
    "a host that refuses a Worker must still get a clock — a throttled page is worth "
    + "more than a page whose transport never wakes");
  ok("...and the ticker can be stopped (a Worker that outlives its transport is a leak)",
    !!tick && /terminate\(\)/.test(tick) && /stop\(\)\s*\{/.test(tick));
  ok("the transport starts the ticker and stop() stops it",
    /S\.ticker = makeTicker\(schedulerTick, TICK_MS\)/.test(CODE) && /S\.ticker\?\.stop\(\)/.test(CODE));

  const sched = bodyOf(CODE, "function schedulerTick(");
  ok("the schedule window is CARRIED, not recomputed from `now` each wake",
    !!sched && /const to = now \+ LOOKAHEAD;/.test(sched)
    && /const from = Math\.min\(S\.lastUpdate \|\| now, to\);/.test(sched)
    && /S\.lastUpdate = to;/.test(sched),
    "a late wake must widen [lastUpdate, now+LOOKAHEAD]; recomputing from `now` drops "
    + "whatever boundary fell in the gap");
  ok("...and the region test uses both ends of that window, not `now` twice",
    !!sched && /at < to && at \+ \(segEnd - segStart\) > from/.test(sched));
  ok("the look-ahead render rides the same clock rather than a second timer",
    !!sched && /S\.tickN\+\+ % AHEAD_EVERY/.test(sched) && /aheadTick\(\)/.test(sched));
  ok("play() opens the window at the audio clock, so the first wake only looks forward",
    /S\.lastUpdate = ctx\.currentTime;/.test(CODE));
}

/* ══════════ 5. §2 THE VELOCITY LANE, RUN ════════════════════════════════
 * The lane had exactly one gesture and it MUTATED the model on every
 * pointermove. These are the four strategies and the two commands that
 * replaced it, lifted out of daw.js by name and evaluated against a stub
 * document — so the ramp's arithmetic is checked against a closed form, the
 * determinism of humanize is checked by running it twice, and "one post per
 * gesture" is checked by counting the posts. */

console.log("\n  -- the velocity lane: computed on read, one post per gesture --");
{
  const src = [
    /const DEFAULT_VEL = [^\n]*\n/.exec(CODE)?.[0],
    /const clampVel = [^\n]*\n/.exec(CODE)?.[0],
    /const velLaneY = [^\n]*\n/.exec(CODE)?.[0],
    /const velOf = [^\n]*\n/.exec(CODE)?.[0],
    /const velScope = [^\n]*\n/.exec(CODE)?.[0],
    bodyOf(CODE, "function VelLine("), bodyOf(CODE, "function VelDraw("),
    bodyOf(CODE, "function VelNode("), bodyOf(CODE, "function VelNumber("),
    bodyOf(CODE, "function VelHumanize("), bodyOf(CODE, "function velJitter("),
    bodyOf(CODE, "function velChanges("), bodyOf(CODE, "async function commitVel("),
    bodyOf(CODE, "function captureSession("), bodyOf(CODE, "function sessionCurrent("),
  ];
  ok("all pieces of the lane and its session guards are declared and liftable",
    src.every(Boolean), src.map((x, i) => (x ? "" : i)).filter((x) => x !== "").join(", "));

  /* Twelve notes, one per quarter, velocity 64 each — the ramp's test bed. */
  const mkNotes = () => Array.from({ length: 12 }, (_, i) => ({
    id: `n${i}`, bar: 1, beat: 1, tick: i * 960, pitch: 60 + i, vel: 64, durTicks: 480,
  }));
  const posted = [];
  let lab = null;
  const env = {
    S: { sel: new Set(), slug: "song", projectEpoch: 1, trackId: "trk_1", velStrategy: null, pxq: 56 },
    notes: mkNotes(),
    VEL_H: 64, KEYS_W: 44,
  };
  let V = null;
  try {
    const build = new Function("S", "selNotes", "posToQ", "velTop", "VEL_H", "KEYS_W",
      "tint", "C", "api", "pushUndo", "refreshDoc", "renderAndSwap", "status", "draw",
      `${src.join("\n")}\nreturn { DEFAULT_VEL, clampVel, velLaneY, velOf, velScope, VelLine, VelDraw,`
      + ` VelNode, VelNumber, VelHumanize, velJitter, velChanges, commitVel };`);
    V = build(env.S, () => env.notes.map((n) => ({ n, c: { id: "c1" } })),
      (bar, beat, tick) => (bar - 1) * 4 + (beat - 1) + tick / 960,
      () => 100, env.VEL_H, env.KEYS_W,
      () => {}, {},
      async (body) => { posted.push(body); return { undo: { action: "edit_notes", notes: [] }, dirty: [] }; },
      () => {}, async () => {}, () => {}, (m) => { lab = m; }, () => {});
  } catch (err) {
    ok("the lane's strategies evaluate on their own (they reach nothing but S / selNotes / the geometry)",
      false, err.message);
  }

  if (V) {
    /* THE RAMP, AGAINST A CLOSED FORM. Shift-drag from (q=0, v=20) to
     * (q=11, v=120): every note reads 20 + 100·q/11, clamped and rounded. */
    const line = V.VelLine(0, 20);
    line.move(11, 120);
    const want = (q) => Math.max(1, Math.min(127, Math.round(20 + (120 - 20) * q / 11)));
    const got = env.notes.map((n) => line.read(n));
    ok("VelLine is a straight line: all 12 notes match 20 + 100·q/11 exactly",
      got.every((v, i) => v === want(i)), `${got.join(",")} vs ${env.notes.map((_, i) => want(i)).join(",")}`);
    ok("...and its endpoints and midpoint are the drag's own values (20, 70, 120)",
      got[0] === 20 && got[11] === 120 && want(5.5) === 70);
    ok("...and a note outside the drag's span keeps its stored velocity",
      V.VelLine(2, 10).read(env.notes[9]) === 64);

    /* NOTHING IS WRITTEN WHILE THE GESTURE IS LIVE. */
    ok("reading through a live strategy does not touch the notes",
      env.notes.every((n) => n.vel === 64));

    /* ONE POST FOR THE WHOLE GESTURE. */
    posted.length = 0;
    env.S.velStrategy = line;
    await V.commitVel(line, "ramp");
    ok("a 12-note ramp posts EXACTLY ONE body",
      posted.length === 1, `${posted.length} posted`);
    ok("...and it is edit_notes carrying all twelve, with the slug and track on it",
      posted[0]?.action === "edit_notes" && posted[0].notes.length === 12
      && posted[0].slug === "song" && posted[0].track === "trk_1"
      && posted[0].notes.every((e) => e.note && Number.isInteger(e.vel)),
      JSON.stringify(posted[0]).slice(0, 200));
    ok("...and the strategy is cleared, so the next paint reads the document again",
      env.S.velStrategy === null);

    /* A GESTURE THAT CHANGED NOTHING POSTS NOTHING — the route refuses an
     * entry that names no change, and it is right to. */
    posted.length = 0;
    const flat = V.VelLine(0, 64);
    flat.move(11, 64);
    env.S.velStrategy = flat;
    await V.commitVel(flat, "flat");
    ok("a ramp that lands on every note's existing value posts ZERO bodies",
      posted.length === 0 && /nothing changed/.test(lab || ""));

    /* CANCEL. The Escape path is a listener, so it is read rather than run —
     * and what must be true of it is that nothing leaves the page. */
    const esc = /window\.addEventListener\("keydown", \(e\) => \{[\s\S]*?\n\}\);/.exec(
      CODE.slice(CODE.indexOf("function commitVel") > 0 ? 0 : 0));
    const escBody = CODE.match(/if \(e\.key !== "Escape" \|\| !S\.velStrategy\) return;[\s\S]{0,400}?\n\}\);/)?.[0] || "";
    ok("Escape cancels a live gesture, and the cancel path posts nothing at all",
      escBody.length > 0 && /S\.velStrategy = null/.test(escBody) && !/api\(/.test(escBody),
      "a cancelled gesture must never reach the server — that is the whole point of "
      + "computing on read");

    /* VelNode: a RELATIVE move over a selection, so a chord keeps its shape. */
    env.notes = mkNotes();
    env.notes[0].vel = 40; env.notes[1].vel = 80; env.notes[2].vel = 120;
    env.S.sel = new Set(["n0", "n1", "n2"]);
    const node = V.VelNode(env.notes[1]);
    node.move(1, 90);                                    // the anchor 80 → 90, so +10
    ok("VelNode moves the whole selection by the anchor's DELTA (40→50, 80→90, 120→127 clamped)",
      node.read(env.notes[0]) === 50 && node.read(env.notes[1]) === 90
      && node.read(env.notes[2]) === 127);
    ok("...and leaves a note outside the selection alone", node.read(env.notes[5]) === 64);
    env.S.sel = new Set();
    const solo = V.VelNode(env.notes[3]);
    solo.move(3, 111);
    ok("...and with NO selection it is the old single-note gesture, exactly",
      solo.read(env.notes[3]) === 111 && solo.read(env.notes[4]) === 64);

    /* VelDraw paints columns; outside the stroke a note keeps its own value. */
    env.notes = mkNotes();
    const drw = V.VelDraw();
    drw.move(2, 30); drw.move(2.5, 35); drw.move(3, 40);
    ok("VelDraw paints only the columns the stroke crossed",
      drw.read(env.notes[2]) === 30 && drw.read(env.notes[3]) === 40
      && drw.read(env.notes[0]) === 64 && drw.read(env.notes[8]) === 64);
    const rst = V.VelDraw(V.DEFAULT_VEL);
    rst.move(0, 12); rst.move(1, 99);
    ok(`right-drag resets to the page's own default velocity (${V.DEFAULT_VEL}), whatever the pointer's y says`,
      rst.read(env.notes[0]) === V.DEFAULT_VEL && rst.read(env.notes[1]) === V.DEFAULT_VEL);

    /* The number box: set / + / ×, over the same read() the drags use. */
    env.notes = mkNotes();
    env.S.sel = new Set(env.notes.map((n) => n.id));
    ok("the number box's three modes are set, + and ×, and they compose with the same read()",
      V.VelNumber("set", 100).read(env.notes[0]) === 100
      && V.VelNumber("add", -20).read(env.notes[0]) === 44
      && V.VelNumber("add", 999).read(env.notes[0]) === 127
      && V.VelNumber("mul", 150).read(env.notes[0]) === 96
      && V.VelNumber("mul", 1).read(env.notes[0]) === 1);

    /* HUMANIZE IS DETERMINISTIC. This is not a nicety: a random scatter
     * writes different velocities on every press, so a humanized part would
     * re-render differently every time anybody touched it and the region
     * hash — the thing that makes the monitor the bounce — would move. */
    const h1 = env.notes.map((n) => V.VelHumanize(8).read(n));
    const h2 = env.notes.map((n) => V.VelHumanize(8).read(n));
    ok("humanize gives the same velocities twice on the same notes",
      h1.join(",") === h2.join(","), `${h1.join(",")}\n          ${h2.join(",")}`);
    ok("...and it really scatters them (not every note landed on its own value)",
      h1.some((v, i) => v !== env.notes[i].vel));
    ok("...within the ± amount it was asked for, and never outside 1…127",
      h1.every((v, i) => Math.abs(v - env.notes[i].vel) <= 8 && v >= 1 && v <= 127));
    ok("...and a note's number follows its IDENTITY: change the pitch, change the jitter",
      V.velJitter("trk_1", env.notes[0]) !== V.velJitter("trk_1", { ...env.notes[0], pitch: 61 })
      && V.velJitter("trk_1", env.notes[0]) === V.velJitter("trk_1", { ...env.notes[0] }));
    ok("...and it is a hash, not Math.random — the page's source says so and never calls it",
      !/Math\.random\(/.test(bodyOf(CODE, "function velJitter(") || "x")
      && !/Math\.random\(/.test(bodyOf(CODE, "function VelHumanize(") || "x"));

    /* These toolbar commands require an explicit selection. The freehand
     * gestures above retain their own spatial targets. */
    env.S.sel.clear();
    posted.length = 0;
    const emptyNumber = V.VelNumber("set", 100);
    ok("a number command with no selection leaves every velocity alone",
      env.notes.every((n) => emptyNumber.read(n) === n.vel));
    await V.commitVel(emptyNumber, "no selected number edits");
    ok("...and sends no number edit to the server", posted.length === 0);
    const emptyHumanize = V.VelHumanize(8);
    ok("humanize with no selection leaves every velocity alone",
      env.notes.every((n) => emptyHumanize.read(n) === n.vel));
    await V.commitVel(emptyHumanize, "no selected humanize edits");
    ok("...and sends no humanize edit to the server", posted.length === 0);

    env.S.sel = new Set(["n0", "n3", "n9"]);
    const selectedNumber = V.VelNumber("set", 100);
    ok("the number command changes only the explicitly selected notes",
      env.notes.every((n) => selectedNumber.read(n) === (env.S.sel.has(n.id) ? 100 : n.vel)));
    await V.commitVel(selectedNumber, "selected number edits");
    ok("...and posts exactly those selected note identities in one edit",
      posted.length === 1 && posted[0].notes.map((n) => n.note).sort().join(",") === "n0,n3,n9");
    posted.length = 0;
    const selectedHumanize = V.VelHumanize(8);
    ok("humanize changes selected notes while leaving every unselected note alone",
      env.notes.filter((n) => !env.S.sel.has(n.id)).every((n) => selectedHumanize.read(n) === n.vel)
      && env.notes.filter((n) => env.S.sel.has(n.id)).some((n) => selectedHumanize.read(n) !== n.vel));
    await V.commitVel(selectedHumanize, "selected humanize edits");
    ok("...and its one edit contains only changed, selected note identities",
      posted.length === 1 && posted[0].notes.length > 0
      && posted[0].notes.every((n) => env.S.sel.has(n.note)));
  }

  /* The paint reads THROUGH the strategy, and the pointermove writes nothing. */
  const drawFn = bodyOf(CODE, "function draw()") || "";
  ok("the roll paints velocities through velOf(), so the ramp is visible with zero traffic",
    /const shown = velOf\(n\);/.test(drawFn) && /S\.velStrategy\.paint\(g\)/.test(drawFn));
  const moveHandler = CODE.match(/if \(d\.mode === "vel"\) \{[\s\S]{0,240}?\n  \}/)?.[0] || "";
  ok("pointermove hands the strategy the pointer and assigns to no note",
    /d\.strat\.move\(/.test(moveHandler) && !/\.vel\s*=/.test(moveHandler),
    "the old code did `d.note.vel = velFromY(py)` on every move — a live mutation "
    + "that then needed a rollback path when the write failed");
}

/* ══════════ 6. THE N-ROUND-TRIP COMMITS ARE GONE ════════════════════════
 * Dragging a 24-note chord used to be 24 awaited move_note calls: 24 document
 * writes, 24 ledger rows and 24 renders for one gesture. edit_notes takes the
 * array, so every multi-note edit on this page is one post. */

console.log("\n  -- no gesture posts one note at a time any more --");
{
  ok("there is no `await api({ action: \"move_note\"` inside a loop anywhere in the page",
    !/for\s*\([\s\S]{0,400}?await api\(\{\s*action: "move_note"/.test(CODE),
    "the multi-note commit, quantize and split each used to do exactly this");
  ok("the move/resize commit posts ONE edit_notes carrying every note the drag really moved",
    /action: "edit_notes", slug: S\.slug, track: S\.trackId,\s*\n\s*notes: moved\.map/.test(CODE)
    && /const moved = d\.notes\.filter\(/.test(CODE),
    "and a note the drag put back where it started is filtered out here rather than "
    + "refused by the route, which would take the whole gesture down with it");
  ok("quantize posts one edit_notes, not one move_note per note",
    /const body = \{ action: "edit_notes", slug: S\.slug, track: S\.trackId, notes: moves \};/.test(CODE));
  ok("split trims every head in one edit_notes and only the ADDS stay per-note "
     + "(an add mints an id, so it cannot be batched)",
    /await api\(\{ action: "edit_notes", slug: session\.slug, track, notes: heads \}\)/.test(CODE)
    && /for \(const t of tails\)/.test(CODE)
    && /(?:const|,)\s+track = S\.trackId/.test(bodyOf(CODE, "async function splitSelection(") || ""));
  ok("the undo for a batched gesture is the ROUTE's own inverse body, posted straight back",
    /pushUndo\(\{ label: `quantize \$\{moves\.length\}`, body: last\.undo, forward: body \}\)/.test(CODE)
    && /if \(r\.undo\) pushUndo\(\{ body: r\.undo, forward: body, label \}\)/.test(CODE));
}

/* ══════════ 7. §1 THE READINESS BADGE ═══════════════════════════════════
 * The one item in this tier whose honest answer is partly "no". A chained
 * project cannot monitor in real time past about bar 80 on this machine, so
 * the window says which regions will arrive late, before they do, with the
 * bars named — and it says it from the server's own verdict table rather than
 * from a threshold this file invented. */

console.log("\n  -- the look-ahead says the unwelcome thing, in the server's own numbers --");
{
  ok("the badge exists in the page and in the stylesheet, in three states",
    /id="aheadBox"/.test(HTML) && /id="aheadTxt"/.test(HTML)
    && /\.d-ahead\.d-ok/.test(CSS) && /\.d-ahead\.d-tight/.test(CSS) && /\.d-ahead\.d-late/.test(CSS));
  const paint = bodyOf(CODE, "function paintAhead()") || "";
  ok("its three states are ready / tight / late, and the LATE one names the bars",
    /ahead ✓/.test(paint) && /ahead ⏱/.test(paint)
    && /ahead ✗ bars \$\{late\.fromBar\}-\$\{late\.toBar\} · will arrive late/.test(paint));
  ok("the verdict is the SERVER's, never a threshold this page invented",
    /rows\.find\(\(r\) => r\.verdict === "late"\)/.test(paint)
    && /rows\.find\(\(r\) => r\.verdict === "tight"\)/.test(paint)
    && !/estimatedMs >/.test(paint),
    "regionVerdict lives in routes.js and ahead_test.js holds it to the model; a second "
    + "comparison here would be a second opinion about the same measurement");
  ok("the tight state prints BOTH numbers — the render and the audio it has to cover",
    /estimatedMs \/ 1000\)\.toFixed\(1\)\} s for \$\{\(tight\.deadlineMs \/ 1000\)\.toFixed\(1\)\} s/.test(paint));
  ok("the badge says whether the cost model was fitted on THIS machine or is the shipped line",
    /plan\.calibration\?\.calibrated/.test(paint) && /shipped line/.test(paint));
  ok("asking for the verdict renders nothing (render_plan), and the page says so",
    /action: "render_plan"/.test(CODE) && /render_plan renders nothing/.test(JS));
  const tick = bodyOf(CODE, "async function aheadTick()") || "";
  ok("the look-ahead renders ONE region and only when its hash is not already in hand",
    /action: "render_ahead"/.test(tick)
    && /S\.buffers\.get\(target\.idx\)\?\.hash === target\.hash/.test(tick));
  ok("...and the lead is the region's own estimate, not a guessed constant",
    /\(here\?\.estimatedMs \?\? 0\) \/ 1000/.test(tick));
  ok("...and it never runs two at once, so a slow region cannot stack up renders",
    /S\.ahead\.busy/.test(tick));
  ok("a region that arrived late is recorded APART from an edit, so the p95 keeps its meaning",
    /S\.sw\.push\(\{ ahead: true/.test(CODE) && /S\.sw\.filter\(\(r\) => !r\.ahead\)/.test(CODE));
  const render = bodyOf(CODE, "function renderAndSwap(") || "";
  ok("every buffer this page plays enters through ONE door",
    !!bodyOf(CODE, "async function swapRegion(")
    && /swapRegion\(g, session, request\)/.test(render)
    && /swapRegion\(r\.region, session, renderRequest\)/.test(tick)
    && !/decodeAudioData\(/.test(render + tick),
    "renderAndSwap and the look-ahead both fetch/decode/swap; two copies of that is two "
    + "chances for the browser to play something the server did not make");
}

/* ══════════ 8. §4 PER-TRACK WAVEFORM LANES ══════════════════════════════ */

console.log("\n  -- the stem lanes are lazy, and say what they are not --");
{
  const refresh = bodyOf(CODE, "async function refreshWaveLanes(") || "";
  const toggle = bodyOf(CODE, "function toggleWaveLane(") || "";
  ok("a lane is opened per track and pays for itself when it opens",
    !!toggle && /S\.wave\.open\.add\(trackId\)/.test(toggle) && /refreshWaveLanes\(true\)/.test(toggle));
  ok("...and only the OPEN tracks are asked for, so a closed lane costs nothing",
    /tracks: \[\.\.\.S\.wave\.open\]/.test(refresh));
  ok("the audio comes from render_stems — the same graph pass the mix comes from",
    /action: "render_stems"/.test(CODE));
  ok("the picture comes from the mip-map route, not from decoding a wav in the browser",
    /action: "peaks"/.test(CODE) && /samples_per_pixel/.test(CODE));
  ok("BOTH channels are drawn (a mono fold would hide every width knob)",
    /for \(const ch of pk\.data\)/.test(CODE) && /ch\.channel === 0/.test(CODE));
  ok("min AND max per peak, not a rectified envelope",
    /ch\.min\[j\]/.test(CODE) && /ch\.max\[j\]/.test(CODE));
  const stemProject = { tracks: [{ id: "t" }], returns: [{ id: "hall" }] };
  const stemDetails = stemResultDetails({ tracks: [{ id: "t" }], regions: [{
    stems: [{ track_id: "t" }], returns: [{ return_id: "hall" }],
    exported_complete: true, exported_residual_db: -123.4, master_delta_db: -8.5,
  }] }, stemProject);
  ok("track stems PLUS returns reconstruct pre-master; the visible lane labels exclude master processing",
    /stemResultDetails\(r, S\.proj\)/.test(refresh) && /S\.wave\.note = details\.note/.test(refresh)
    && stemDetails.complete && /track stems plus effect returns/.test(stemDetails.summary)
    && /Master processing and the master fader are excluded/.test(stemDetails.summary));
  ok("the measured exported residual is shown; a master difference signal is never presented as gain",
    /residual: -123\.4 dB/.test(stemDetails.summary) && !/8\.5|on top/.test(stemDetails.summary)
    && /stemResultDetails\(S\.wave\.result, S\.proj\)\.summary/.test(JS));
  ok("the cost is stated when it is paid (a stem render is a second full graph pass)",
    /second audio pass/.test(refresh));
  ok("a track that is silent in the window is NAMED rather than drawn as an empty lane",
    /silent here: \$\{silent\.join\(", "\)\}/.test(JS));
  ok("the 16-region ceiling the route enforces is the ceiling the page asks inside",
    /const WAVE_REGION_CAP = 16;/.test(CODE) && /slice\(0, WAVE_REGION_CAP\)/.test(CODE));
}

/* ══════════ 9. §5 THE DAW ⓘ ═════════════════════════════════════════════ */

console.log("\n  -- the DAW has an ⓘ, and it writes none of its own copy --");
{
  ok("the page mounts web/info.js's panel, by import and by call",
    /import \{ mountInfo \} from "\.\/info\.js";/.test(JS)
    && /mountInfo\("daw", "#dawInfoHost"\);/.test(CODE));
  ok("the host element exists in daw.html",
    /id="dawInfoHost"/.test(HTML));
  ok("daw.html loads the two stylesheets the panel is dressed by",
    /href="info\.css"/.test(HTML) && /href="modelfit\.css"/.test(HTML));
  ok("the panel is docked out of the transport bar's flow, and nothing else about it is restyled",
    /\.d-infohost > \.infopanel \{/.test(CSS)
    && (CSS.match(/^\.d-infohost/gm) || []).length <= 3,
    "three scoped rules; the panel's own bound, badges and copy stay web/info.css's");
  ok("this page writes no copy for that panel — every word comes from /api/welcome",
    !/needsNote|needStates|fitStates/.test(CODE),
    "server/welcome/ui_test.js holds web/info.js to the same rule; a sentence about the "
    + "DAW written HERE would be a second description of the same screen");
}

console.log("\n  -- project startup and the explicit selection toolbar --");
{
  ok("ordinary roll redraws refresh the selection count and enabled commands",
    /paintSelInfo\(\)/.test(bodyOf(CODE, "function draw(") || ""));
  ok("New starts disabled while the project list is being loaded",
    /<button\b[^>]*\bid="newProj"[^>]*\bdisabled(?:\s|>)/.test(HTML));

  const boot = bodyOf(CODE, "async function boot(");
  for (const failList of [false, true]) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const nodes = new Map(), messages = [];
    const node = (id) => {
      if (!nodes.has(id)) nodes.set(id, { disabled: id === "newProj", hidden: true,
        value: "480", style: { setProperty() {} }, addEventListener() {}, appendChild() {} });
      return nodes.get(id);
    };
    const deps = { $: node, HEAD_W: 140, S: { aud: {} },
      localStorage: { getItem: () => null },
      loadRack: () => gate, loadPalette: async () => {},
      get: async () => { if (failList) throw new Error("project list unavailable"); return { projects: [] }; },
      status: (message) => messages.push(message),
    };
    for (const name of ["readTokens", "applyKeymap", "setMixNarrow", "setMode", "showDock",
      "drawHistory", "paintLoopLabel", "drawPresets", "connectLive", "calShowStored"]) deps[name] = () => {};
    try {
      const run = new Function(...Object.keys(deps), `${boot}\nreturn boot();`);
      const pending = run(...Object.values(deps));
      ok(`New stays disabled until boot settles (${failList ? "failure" : "success"} path)`, node("newProj").disabled);
      release(); await pending;
      ok(`boot enables New after ${failList ? "a project-list failure" : "loading an empty project list"}`,
        !node("newProj").disabled);
      if (failList) ok("a failed project list also exposes Retry and the concrete error",
        !node("retryProjects").hidden && messages.some((m) => m.includes("project list unavailable")));
    } catch (err) {
      ok("the actual boot function runs with an isolated project-list response", false, err.message);
    }
  }
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.log("  failed:\n   " + failures.join("\n   ") + "\n");
  process.exit(1);
}
