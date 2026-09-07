/**
 * Video lab UI — the parity gate.
 *
 * Same bargain the DAW's, the MV fork's and VFX's gates make, and for the same
 * reason: the binding rule of this repo is that everything is MCP-controllable
 * AND completely human-adjustable, one document behind both, and a rule nobody
 * checks is a rule that drifts within a fortnight.
 *
 * TWO DIRECTIONS, AND THE SECOND IS THE ONE THAT FINDS THINGS.
 *
 *   1. Every action the PAGE posts must be one the route dispatches. Catches a
 *      gesture that invented its own write path, or kept a name the route
 *      renamed.
 *   2. Every action the ROUTE dispatches must be reachable by a HUMAN and by an
 *      AGENT. This is the direction that found things while this surface was
 *      being written: `groups` was an agent-only capability until the page grew
 *      an "older comparisons" button, and `resolve_hybrid` was human-only until
 *      video_compare grew `dry_run`. Both were a minute's work to close and
 *      neither would have been noticed by a person clicking around.
 *
 * AND A THIRD, WHICH IS THIS SURFACE'S OWN PROMISE. The owner asked for it
 * directly — "every day people put out new workflows" — so the toggles, the
 * comparison arms and the size guidance must be DATA the page renders, not
 * controls the page contains. That is checkable: no knob id, no config id and
 * no measured resolution may appear as a literal in web/videolab.js. If one
 * does, adding the next toggle has become an edit to three files, and the
 * promise is already broken.
 *
 * FOURTH: every measurement must still be citable. Each `cite` in catalog.js
 * names a path, and this fails if that path is not in the repository — because
 * a number whose source has been moved or renamed is a number the next person
 * cannot re-measure, which is the only thing that makes it worth quoting.
 *
 * Runs standalone (`node server/videolab/ui_test.js`) and in the pre-commit
 * hook. Reads web/ and server/ and touches nothing.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const read = (...p) => readFileSync(path.join(ROOT, ...p), "utf8");

const ROUTES = read("server", "videolab", "routes.js");
const CATALOG = read("server", "videolab", "catalog.js");
const UI = read("web", "videolab.js");
const CSS = read("web", "videolab.css");
const MCP = read("server", "mcp-videolab.js");
const HTML = read("web", "index.html");
const STILLS = read("server", "videolab", "stills.js");
const PY = read("scripts", "clipstills.py");
const INDEX = read("server", "index.js");

/* CODE ONLY, not the prose around it.
 *
 * The first version of this check scanned the raw file and failed on a comment
 * that EXPLAINED why a literal had been removed — which is a gate punishing the
 * documentation of its own finding, and the fastest way to teach somebody to
 * stop writing comments. What matters is whether the page ACTS on a name, so
 * the block and line comments come out first.
 *
 * `//` is only a comment when it is not preceded by a colon, so a `/api/…` path
 * or an `http://` survives — crude, and sufficient for a file with no regex
 * literals in it. */
const codeOf = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const UI_CODE = codeOf(UI);

/* The dispatch is a switch on the action nested inside the handler, so its
 * cases sit well past column 0. Anchoring on the indent avoids catching a
 * `case` from some unrelated shallower switch. */
const serverActions = [...new Set(
  [...ROUTES.matchAll(/^\s{6,}case "([a-z0-9_]+)":/gm)].map((m) => m[1]),
)].sort();
const uiActions = new Set([...UI_CODE.matchAll(/action:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));
const mcpActions = new Set([...MCP.matchAll(/action:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));

/* A regex that matches nothing passes everything, so prove the extraction found
 * a plausible surface before trusting a word it says. */
ok(`the census sees the dispatch at all (${serverActions.length} actions)`,
  serverActions.length >= 6, serverActions.join(", "));
ok(`...and the page's own posts (${uiActions.size})`, uiActions.size >= 5,
  [...uiActions].join(", "));
ok(`...and the MCP layer's (${mcpActions.size})`, mcpActions.size >= 5,
  [...mcpActions].join(", "));

/* ── direction 1: did a gesture invent a write path? ─────────────────────── */
const orphanGestures = [...uiActions].filter((a) => !serverActions.includes(a));
ok("every action the page posts is one the route dispatches",
  orphanGestures.length === 0,
  orphanGestures.join(", ") + " — posted by web/videolab.js and dispatched by nothing");

const orphanTools = [...mcpActions].filter((a) => !serverActions.includes(a));
ok("every action the MCP layer posts is one the route dispatches",
  orphanTools.length === 0,
  orphanTools.join(", ") + " — posted by server/mcp-videolab.js and dispatched by nothing");

/* ── direction 2: can BOTH hands reach it? ───────────────────────────────── */
/**
 * Actions with no control on one surface, each with the reason it is acceptable
 * TODAY. Every entry is a to-do with a name on it, not a decision — and an
 * entry has to earn itself twice, exactly as the VFX gate demands: the name
 * must be a real action, so a rename cannot hide behind a dead exemption, and
 * it must still be unreachable, so closing a gap FORCES the entry to be
 * deleted. Empty is the state this surface shipped in and the state it should
 * stay in.
 */
const NO_UI = {};
const NO_MCP = {};

const agentOnly = serverActions.filter((a) => !uiActions.has(a) && !(a in NO_UI));
ok("every action the route dispatches is reachable from the page",
  agentOnly.length === 0,
  agentOnly.join(", ") + " — an agent can do it and a person cannot");

const humanOnly = serverActions.filter((a) => !mcpActions.has(a) && !(a in NO_MCP));
ok("every action the route dispatches is reachable from MCP",
  humanOnly.length === 0,
  humanOnly.join(", ") + " — a person can do it and an agent cannot");

const staleUi = Object.keys(NO_UI).filter((a) => uiActions.has(a) || !serverActions.includes(a));
ok("no stale NO_UI exemption", staleUi.length === 0,
  staleUi.join(", ") + " — either reachable now or not a real action; delete the entry");
const staleMcp = Object.keys(NO_MCP).filter((a) => mcpActions.has(a) || !serverActions.includes(a));
ok("no stale NO_MCP exemption", staleMcp.length === 0, staleMcp.join(", "));

/* ── direction 2b: PARAMETER parity, which is where the action census lies ──
 *
 * An action reachable from both hands is not the same as an action that DOES
 * THE SAME THING in both hands, and the gap between those two sentences is
 * where this surface was actually broken. `compare` was reachable from the page
 * and from MCP and passed every check above — while the page sent `refAudios`
 * and the tool had no way to. `refAudios` is not decoration: resolveHybrid()
 * counts images AND audio, so an audio reference routes the hybrid arm onto H3.
 * An agent attaching one got the LTX arm, a different licence line and a tenth
 * of the render cost, silently, for the same request a person made.
 *
 * So the census goes one level down: every field the ROUTE reads off the body
 * must be a field BOTH surfaces can send. That is the binding rule at the
 * resolution it is actually broken at.
 *
 * HOW A "SENT" FIELD IS RECOGNISED. Both surfaces talk through one helper
 * (`post({...})` on the page, `lab({...})` in the tool layer), so the check
 * reads the object literal handed to that helper rather than grepping the file
 * — grepping cannot tell a key being SENT from the same word appearing in a
 * sentence, and this file's own first attempt scored `id` as absent because the
 * page sends it as a shorthand property. Shorthand is the normal way to write
 * this, so the extractor has to understand it or the gate teaches people to
 * write worse code to satisfy it.
 */
const callBodies = (src, helper) => {
  const keys = new Set();
  const re = new RegExp(helper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\(\\{", "g");
  for (const m of src.matchAll(re)) {
    // Walk the braces so a nested object inside the body cannot end it early.
    let i = m.index + m[0].length - 1, depth = 0, start = i;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) break; }
    }
    const body = src.slice(start + 1, i);
    /* A key is a bare identifier at depth 0 of this literal followed by `:`
     * (long form) or `,` / end (shorthand). Nested literals are skipped so an
     * inner object's keys are not credited to the outer call. */
    let d = 0;
    for (let j = 0; j < body.length; j++) {
      const c = body[j];
      if (c === "{" || c === "[" || c === "(") d++;
      else if (c === "}" || c === "]" || c === ")") d--;
      else if (d === 0 && /[A-Za-z_]/.test(c) && !/[\w.$]/.test(body[j - 1] || " ")) {
        const rest = body.slice(j);
        const k = rest.match(/^([A-Za-z_]\w*)\s*(:|,|$)/);
        if (k) keys.add(k[1]);
      }
    }
  }
  return keys;
};

const routeParams = [...new Set(
  [...ROUTES.matchAll(/\bb(?:ody)?\.([A-Za-z_]\w*)/g)].map((m) => m[1]),
)].filter((p) => p !== "action").sort();
const uiSends = callBodies(UI_CODE, "post");
const mcpSends = callBodies(codeOf(MCP), "lab");

ok(`the parameter census sees the route's fields (${routeParams.length})`,
  routeParams.length >= 10, routeParams.join(", "));
ok(`...and what the page sends (${uiSends.size})`, uiSends.size >= 8, [...uiSends].join(", "));
ok(`...and what the tools send (${mcpSends.size})`, mcpSends.size >= 8, [...mcpSends].join(", "));

/**
 * Fields one hand cannot send, each with the reason it is acceptable TODAY.
 *
 * Same contract as NO_UI / NO_MCP above and for the same reason: an entry is a
 * to-do with a name on it. It must name a field the route really reads (so a
 * rename cannot hide behind a dead exemption) and that field must still be
 * unreachable (so closing the gap FORCES the entry to be deleted).
 */
const PARAM_NO_UI = {
  timeoutSeconds:
    "Per-arm render budget. An agent needs it because it cannot watch a run and give up; a "
    + "person watching the page can simply stop. Add a control here if the default 3600 s ever "
    + "starts costing somebody an evening.",
};
const PARAM_NO_MCP = {};
/* Fields the route reads that NEITHER hand sends. Not a parity failure — both
 * hands are equally unable — but they are dead parameters with live defaults,
 * and an undocumented one is how a route grows a back door. Named so they are a
 * decision rather than an oversight. */
const PARAM_UNREACHED = {
  audioTrack: "Pass-through to the render route. No arm sets it; a comparison has no soundtrack.",
  fromUpload: "The second name for an opening frame; `fromCover` is the one both surfaces send.",
  keepAudio: "Reads `!== false`, so the default is keep, which is what every arm wants.",
};

const paramAgentOnly = routeParams.filter((p) =>
  mcpSends.has(p) && !uiSends.has(p) && !(p in PARAM_NO_UI) && !(p in PARAM_UNREACHED));
ok("every field the route reads is one a PERSON can send",
  paramAgentOnly.length === 0,
  paramAgentOnly.join(", ") + " — an agent can set it and a person cannot, so the same request "
    + "means two different renders depending on which hand made it");

const paramHumanOnly = routeParams.filter((p) =>
  uiSends.has(p) && !mcpSends.has(p) && !(p in PARAM_NO_MCP) && !(p in PARAM_UNREACHED));
ok("every field the route reads is one an AGENT can send",
  paramHumanOnly.length === 0,
  paramHumanOnly.join(", ") + " — a person can set it and an agent cannot; this is the direction "
    + "that hid the refAudios/hybrid routing split");

const paramDead = routeParams.filter((p) =>
  !uiSends.has(p) && !mcpSends.has(p) && !(p in PARAM_UNREACHED));
ok("no field is read by the route and sent by nobody",
  paramDead.length === 0,
  paramDead.join(", ") + " — dead parameters with live defaults; wire one up or name it in "
    + "PARAM_UNREACHED with the reason");

for (const [table, name, sends] of [
  [PARAM_NO_UI, "PARAM_NO_UI", uiSends], [PARAM_NO_MCP, "PARAM_NO_MCP", mcpSends],
]) {
  const stale = Object.keys(table).filter((p) => sends.has(p) || !routeParams.includes(p));
  ok(`no stale ${name} exemption`, stale.length === 0,
    stale.join(", ") + " — either reachable now or not a field the route reads; delete the entry");
}
const staleUnreached = Object.keys(PARAM_UNREACHED)
  .filter((p) => uiSends.has(p) || mcpSends.has(p) || !routeParams.includes(p));
ok("no stale PARAM_UNREACHED entry", staleUnreached.length === 0, staleUnreached.join(", "));

/* THE KNOB IS THE OTHER PARAMETER, and it has its own way of going one-handed.
 * `set_knob` takes an id and a value, so every knob is reachable by both hands
 * BY CONSTRUCTION — until somebody adds a row of a `kind` the page's renderer
 * has no branch for. The agent could set it that day; the person would never
 * see a control. So the kinds are censused rather than assumed. */
const knobKinds = [...new Set([...CATALOG.matchAll(/^\s{4}kind: "(\w+)"/gm)].map((m) => m[1]))];
ok(`the catalogue declares knob kinds (${knobKinds.join(", ")})`, knobKinds.length >= 3);
/* The renderer is an if/else-if chain ending in a bare `else`, so the final
 * kind needs no branch of its own — but every kind BEFORE that fallback must be
 * named, and there may only be one fallback. */
const uiKinds = [...UI_CODE.matchAll(/k\.kind === "(\w+)"/g)].map((m) => m[1]);
const hasFallback = /\}\s*else\s*\{/.test(UI_CODE.slice(UI_CODE.indexOf("paintKnobs")));
const unrendered = knobKinds.filter((k) => !uiKinds.includes(k));
ok("every knob kind reaches a control on the page",
  unrendered.length === 0 || (hasFallback && unrendered.length === 1),
  unrendered.join(", ") + " — a kind with no branch and no fallback is a setting an agent can "
    + "move and a person cannot see");

/* And the tool must not carry its own copy of the id list. An enum of knob ids
 * in the schema is a second list that goes stale the day a row is added, which
 * is the whole failure this surface was built to avoid. */
ok("the settings tool does not hardcode the knob ids",
  !/id:\s*\{[^}]*enum:/.test(MCP),
  "video_settings pins an enum of ids — a new row in catalog.js would be invisible to agents");

/* ── direction 3: is the surface DATA, or is it controls? ────────────────── */
/**
 * "Every day people put out new workflows", so a new toggle must be a row in
 * catalog.js and nothing else. The check is blunt on purpose: if the page
 * mentions a knob by name, then adding the next one is an edit here too, and
 * the claim this file makes in its own header is no longer true.
 */
const knobIds = [...CATALOG.matchAll(/^\s{4}id: "([a-z0-9_]+)",$/gm)].map((m) => m[1]);
ok(`the catalogue really declares rows (${knobIds.length} ids)`, knobIds.length >= 12,
  knobIds.join(", "));
const leakedIds = knobIds.filter((id) => new RegExp(`["'\`]${id}["'\`]`).test(UI_CODE));
ok("no toggle or configuration is named in web/videolab.js — the page renders rows",
  leakedIds.length === 0,
  leakedIds.join(", ") + " — hardcoded in the page, so the next toggle is a rebuild not a row");

/* The same rule for the measurements. A resolution written into the page is a
 * number that will not move when somebody re-measures, and this repo has
 * already shipped one of those: a "960 x 544" option that rendered 512 for
 * months, directly beneath the comment warning about it. */
const sizeLiterals = [...UI_CODE.matchAll(/\b(\d{3,4})\s*[x×]\s*(\d{3,4})\b/g)].map((m) => m[0]);
ok("no resolution is written into the page", sizeLiterals.length === 0,
  sizeLiterals.join(", ") + " — sizes come from the server, so this one will go stale");

/* And the compare arms. The route's own default is "every configuration", so a
 * page that listed them would be a second list to keep in step. */
const cfgIds = [...CATALOG.matchAll(/^\s{4}id: "(h3_[a-z0-9]+|ltx|hybrid)",$/gm)].map((m) => m[1]);
const leakedCfg = cfgIds.filter((id) => new RegExp(`["'\`]${id}["'\`]`).test(UI_CODE));
ok("no comparison arm is named in the page either", leakedCfg.length === 0, leakedCfg.join(", "));

/* ── direction 4: do the citations still resolve? ────────────────────────── */
const cites = [...new Set([...CATALOG.matchAll(/^\s*(\w+):\s*"((?:docs|server|scripts|web)\/[\w./-]+|[A-Z_]+\.md)",$/gm)]
  .map((m) => m[2]))];
ok(`the catalogue cites its sources (${cites.length} paths)`, cites.length >= 5, cites.join(", "));
const missing = cites.filter((c) => !existsSync(path.join(ROOT, c)));
ok("every cited document is in the repository",
  missing.length === 0,
  missing.join(", ") + " — a number whose source is not here cannot be re-measured, which is "
    + "the only reason it was worth quoting. Copy the document in or correct the path.");

/* ── the four configurations the owner asked for by name ─────────────────── */
/**
 * "it would be nice to gen the same clip multiple times through the different
 * video models we have" — with the quality path, the 4-step turbo path, LTX and
 * the fork's hybrid named as the minimum. Pinned here so a later tidy-up cannot
 * quietly drop one.
 */
for (const want of ["h3_quality", "h3_turbo4", "ltx", "hybrid"]) {
  ok(`the comparison offers ${want}`, new RegExp(`id: "${want}"`).test(CATALOG));
}

/* ── the page is actually mounted ────────────────────────────────────────── */
ok("index.html has the mount point", /id="vlab"/.test(HTML));
ok("index.html loads the module", /src="videolab\.js"/.test(HTML));
ok("index.html loads its stylesheet", /href="videolab\.css"/.test(HTML));
/* The mount has to be INSIDE the Video panel. A div that exists but hangs off
 * the end of the document is a surface nobody will ever find, which passes
 * every other check in this file. */
const panelAt = HTML.indexOf('id="vidPanel"');
const mountAt = HTML.indexOf('id="vlab"');
const panelEnd = HTML.indexOf("</section>", panelAt);
ok("the mount point is inside the Video panel",
  panelAt > 0 && mountAt > panelAt && mountAt < panelEnd,
  "a mount outside #vidPanel is a surface nobody can find");

/* ── the page must not own state the server does not have ────────────────── */
/**
 * The one failure mode this whole family of gates exists for. A control whose
 * value lives in the page is a control an agent cannot read, cannot set, and
 * will disagree with. The signature is a write to a size or a step count that
 * is not followed by a post — checked here in the crudest useful way: every
 * function that touches the shared controls must also post something.
 */
const writesControls = /\$\("vid(?:Size|W|H|Steps)"\)\.value\s*=/.test(UI);
ok("the page writes the existing controls rather than keeping its own size",
  writesControls,
  "the quality selector must drive #vidSize / #vidW / #vidH so the Render button sends what "
    + "this panel shows — a second size would be a second document");
ok("...and records it on the server in the same breath",
  /action: "set_quality"/.test(UI),
  "writing only the DOM leaves an agent reading a different number than the person");

/* app.js owns .oninput / .onchange on the controls this panel reaches into.
 * Assigning one of those properties from here would silently delete its
 * handler — and the first symptom would be the cost estimate going blank,
 * which nobody would connect to this file. */
const propAssign = [...UI_CODE.matchAll(/\$\("vid\w+"\)\??\.on(?:input|change|click)\s*=/g)].map((m) => m[0]);
ok("the panel never assigns an event property on a control app.js owns",
  propAssign.length === 0,
  propAssign.join(", ") + " — use addEventListener; assigning replaces app.js's handler");

/* ── direction 5: THE COMPARISON HAS TO BE VISIBLE ───────────────────────────
 *
 * The failure this section pins was found by looking at the panel rather than
 * at the code, and no check above would ever have caught it. The page argued an
 * 84 px face against a 58 px one beside four videos 260 px wide — where those
 * faces are about 12 px and 11 px on screen. Every action was reachable from
 * both hands, every number was cited, and the surface still could not show the
 * one difference it existed to teach.
 *
 * So these are the invariants that keep a picture a picture. Each is one edit
 * away from being undone by somebody making the page "fit" better.
 */

/* 1. NOTHING DOWNSCALES ON THE WAY OUT. A resize in the extractor would put the
 *    argument back where it started, and it is the kind of line that gets added
 *    to "save space" by someone who has not read the measurement. */
ok("the frame extractor never resizes a frame",
  !/cv2\.resize/.test(PY),
  "scripts/clipstills.py resizes — an 84 px face and a 58 px one are then the same size on "
    + "disk, and click-to-zoom has nothing left to zoom into");

/* 2. NOR ON THE WAY IN. A max-width on the zoomed image makes 1:1 a lie, and a
 *    global img rule elsewhere in the app is exactly how one arrives. */
ok("the zoom shows 1:1 pixels rather than a fitted image",
  /\.vlab-zoom-pane img\s*\{[^}]*max-width:\s*none/.test(CSS),
  "web/videolab.css must pin max-width:none on the zoomed frame, or a stylesheet upstream "
    + "shrinks it back to the panel width and 1:1 stops meaning 1:1");

/* 3. ONE TRANSPORT, NOT FOUR. `controls` on each arm is what the page had, and
 *    it is why no two arms could be seen at the same moment. */
/* UI_CODE, not UI: this file's own header explains why. The comment that
 * RECORDS the finding says the words "<video controls>", and a gate that fails
 * on the documentation of its own catch is a gate that teaches people to stop
 * writing comments. What matters is whether the page emits one. */
const ownTransport = /<video[^>]*\bcontrols\b/.test(UI_CODE);
ok("no arm carries a transport of its own",
  !ownTransport,
  "an arm with its own <video controls> cannot be held at the same moment as its neighbours, "
    + "which is the entire job of a comparison");
ok("...and one shared clock drives every arm",
  /data-armvid/.test(UI) && /currentTime/.test(UI),
  "the group's transport must write every arm's currentTime");

/* 4. THE FRAME NUMBERS ARE SERVER DATA, like every other number on this
 *    surface. Same rule as the resolutions, and the same reason: a default
 *    written into the page will not move when somebody re-measures. */
const defFrames = CATALOG.match(/default:\s*\[([\d,\s]+)\]/)?.[1];
ok("the catalogue declares the default frame numbers", !!defFrames, String(defFrames));
if (defFrames) {
  const nums = defFrames.split(",").map((s) => s.trim());
  const literal = new RegExp(`\\[\\s*${nums.join("\\s*,\\s*")}\\s*\\]`);
  ok("the default frame numbers are not written into the page",
    !literal.test(UI_CODE),
    `${defFrames} is a literal in web/videolab.js — re-measure and the page keeps the old answer`);
}

/* 5. THE STILLS ARE SERVED BY A ROUTE THAT EXISTS.
 *
 * This subsystem is dispatched on `p === "/api/videolab"` and NOTHING else, so
 * it cannot mint a URL of its own however tidy one would look — the stills ride
 * the clip route that is already there. Getting this wrong produces a silent
 * 404 inside a panel that otherwise looks finished, which is the worst kind of
 * wrong to debug and the easiest kind to introduce during a tidy-up. */
const stillUrl = STILLS.match(/STILL_URL\s*=\s*"([^"]+)"/)?.[1];
ok("the still strip declares the prefix it serves from", !!stillUrl, String(stillUrl));
ok("...and server/index.js really dispatches that prefix",
  !!stillUrl && INDEX.includes(`p.startsWith("${stillUrl}")`),
  `${stillUrl} is not a path server/index.js routes — the strip would 404 with no clue why. `
    + "This route is mounted on /api/videolab alone and cannot add one.");
const stillDir = STILLS.match(/STILL_SUBDIR\s*=\s*"([^"]+)"/)?.[1];
ok("the still cache cannot show up in anybody's clip library",
  !!stillDir && stillDir.startsWith("."),
  `${stillDir} sits inside the clip folder; /api/clips lists by media extension, so the cache `
    + "folder must be dot-prefixed and extensionless like .thumbs");

/* 6. THE CLAMP IS GLOBAL. Clamping per arm would hand back frame 55 of one arm
 *    beside frame 48 of another under one column heading — a lie with a number
 *    on it, and one that looks completely fine on screen. */
ok("the frame clamp is taken from the shortest arm, once",
  /shortest\s*=\s*min\(lengths/.test(PY) && /ceiling\s*=\s*shortest/.test(PY),
  "scripts/clipstills.py must clamp every arm to the same ceiling");
ok("...and says so when it fires",
  /clamped/.test(PY) && /clamped/.test(UI),
  "a clamp nobody is told about is a strip that quietly changed the question");

/* 7. ACTOR HONESTY AT THE VERDICT SEAM.
 *
 * A comparison costs several full renders, and the verdict is the only field on
 * it that costs human attention. An agent has not seen the clips; what it can
 * honestly file is a reading of the numbers. So the two hands write two
 * different words and NEITHER lets its caller choose — the same rule the DAW's
 * critique loop holds where `judge` refuses a user actor and `choice` refuses an
 * agent one, and the same rule the provenance ledger is built on. */
const byInMcp = MCP.match(/by:\s*[`"']([a-z]+)/)?.[1];
const byInUi = UI_CODE.match(/by:\s*[`"']([a-z]+)/)?.[1];
ok("the tool files a verdict as an agent's", byInMcp === "agent", String(byInMcp));
ok("the page files one as a person's", byInUi === "person", String(byInUi));
ok("...and the two words are not the same",
  !!byInMcp && !!byInUi && byInMcp !== byInUi,
  "an agent's reading of the numbers and a person's judgement of the picture must not read "
    + "alike, or the next comparison does not get run");
ok("neither hand lets its caller spell that field",
  !/by:\s*a\.\w/.test(MCP) && !/by:\s*[^"'`]*\.value/.test(UI_CODE),
  "a `by` taken from the caller is a field that can be filled in with the other hand's word");
ok("the route stores the author and the moment with the verdict",
  /verdict\s*=\s*\{\s*armId[^}]*by,\s*at:\s*Date\.now\(\)/.test(ROUTES),
  "a verdict without `by` and `at` is an opinion with nobody's name on it");

/* 8. THE STRIP AND THE VERDICT SURVIVE A RESTART. They are the only fields on a
 *    group that cost human attention rather than GPU time. */
const STORE = read("server", "videolab", "store.js");
ok("a verdict loaded from disk is checked like every other stored value",
  /cleanVerdict/.test(STORE) && /cleanFrames/.test(STORE),
  "videolab.json is untrusted input — the knobs are range-checked for exactly this reason");

/* ── the page must PARSE, and one way of not parsing is easy to write ────── */
/**
 * A backtick inside emitted markup ENDS the template literal it sits in, and
 * the most natural place to write one is an HTML comment explaining the markup
 * — which is exactly how the page broke twice while this surface was being
 * written. `node --check web/videolab.js` in the hook catches the resulting
 * syntax error; this catches the HABIT, which is the thing that keeps
 * producing it. Explanations belong in a JS comment above the template.
 */
const htmlComments = (UI.match(/<!--/g) || []).length;
ok("no HTML comments inside the page's templates", htmlComments === 0,
  `${htmlComments} found — a backtick in one terminates the template literal it sits in`);

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
