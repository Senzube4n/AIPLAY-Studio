/**
 * WELCOME UI — the parity gate, in the shape server/vfx/ui_test.js established.
 *
 * A welcome window is the easiest place in the app to break the binding rule
 * without noticing, because it looks like documentation rather than like a
 * feature. It is not: it opens, it closes, it remembers that it opened, and
 * "remembers" is state. State only one of the two hands can see is exactly what
 * this repo forbids — so `dismiss` and `reopen` are actions on a route, checked
 * here in both directions, rather than a localStorage key nobody could audit.
 *
 * TWO DIRECTIONS, and as everywhere else the second is the one that finds things:
 *
 *   1. Every action the PAGE posts must be one the server dispatches.
 *   2. Every action the SERVER dispatches must be reachable by a human — AND,
 *      for this surface specifically, by an agent. Both, with no exemption list,
 *      because there are four actions and every one of them is something the
 *      owner explicitly asked to be available on both surfaces. The moment that
 *      stops being affordable, add NO_UI here the way vfx/ui_test.js has it —
 *      but do it on purpose, not by drifting.
 *
 * IT ALSO GUARDS THE ONE-DOCUMENT RULE. web/welcome.js must not grow prose: the
 * whole point is that the window and `studio_capabilities` read one catalogue.
 * A long sentence appearing in the page's own source is the first symptom of a
 * second description of the studio, so this counts them.
 *
 * Runs standalone (`node server/welcome/ui_test.js`) and in the pre-commit hook.
 * Reads web/ and server/ and touches nothing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
/* The readiness vocabulary itself, not a copy of its keys. It is imported for
 * one check — that web/info.js knows none of these words — and importing it is
 * the only way that check can still be true after a tenth state is added. */
import { NEED_STATES } from "./catalogue.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = readFileSync(path.join(HERE, "routes.js"), "utf8");
const CATALOGUE = readFileSync(path.join(HERE, "catalogue.js"), "utf8");
const UI = readFileSync(path.join(HERE, "..", "..", "web", "welcome.js"), "utf8");
const CSS = readFileSync(path.join(HERE, "..", "..", "web", "welcome.css"), "utf8");
/* The second human surface on this route. web/welcome.js is the tour; web/info.js
 * is the ⓘ on every screen, and it posts to the same dispatch — so every check
 * below that says "the page" has to mean both of them or the newer one is
 * unguarded. */
const INFO = readFileSync(path.join(HERE, "..", "..", "web", "info.js"), "utf8");
/* The third: web/level.js, the Simple / Advanced level (UI_PLAN E1). It posts
 * `level` to the same dispatch, so "the page" means it as well. */
const LEVELJS = readFileSync(path.join(HERE, "..", "..", "web", "level.js"), "utf8");
const INFOCSS = readFileSync(path.join(HERE, "..", "..", "web", "info.css"), "utf8");
const MCP = readFileSync(path.join(HERE, "..", "mcp-welcome.js"), "utf8");
const INDEX = readFileSync(path.join(HERE, "..", "index.js"), "utf8");
const MCPMAIN = readFileSync(path.join(HERE, "..", "mcp.js"), "utf8");
const HTML = readFileSync(path.join(HERE, "..", "..", "web", "index.html"), "utf8");
const APP = readFileSync(path.join(HERE, "..", "..", "web", "app.js"), "utf8");
/* SOME SCREENS ARE THEIR OWN PAGE, AND EACH IS A SECOND MOUNT SOURCE. The DAW
 * has its own document (web/daw.html) and its own module (web/daw.js), which is
 * exactly why it carried a NO_MOUNT exemption for as long as it did; Avatars
 * arrived with the same shape. The exemption is gone, so the scrape below reads
 * every one of them: the ⓘ census is a census of SCREENS, and a screen that
 * lives in its own file is still a screen.
 *
 * THIS IS A TABLE RATHER THAN TWO CONSTANTS because the next own-page screen is
 * the one that will be forgotten. Add its row and every check below covers it —
 * the mount scrape, the import check and the stylesheet check — instead of two
 * of the three silently skipping it. `rail` is the entry's data-page, which is
 * also its catalogue id and the view name it must mount under. */
const PAGES = [
  { rail: "daw", js: "web/daw.js", html: "web/daw.html" },
].map((p) => ({ ...p,
  src: readFileSync(path.join(HERE, "..", "..", ...p.js.split("/")), "utf8"),
  doc: readFileSync(path.join(HERE, "..", "..", ...p.html.split("/")), "utf8") }));

/* ── reading a source file as CODE rather than as text ─────────────────────
 *
 * WHY THIS EXISTS. "The info panel is loaded by web/app.js" was
 * `APP.includes("mountInfo") && APP.includes("mountAllInfo()")`, and it was
 * proven hollow: both `mountAllInfo();` statements were deleted and the gate
 * went on passing — on the import, on the function's own declaration, and on a
 * comment that mentions it by name. A substring cannot tell a call from a
 * mention of one, and in this repo the mentions outnumber the calls, because the
 * comments are long on purpose. Every check in this file that claims one file
 * CALLS another now goes through here.
 *
 * Two passes, because they answer different questions. `noComments` keeps the
 * strings — a module specifier and a CSS class are strings, and an import check
 * needs to see them. `code` blanks them as well, so `mountAllInfo()` written
 * inside a sentence, a template or a class attribute cannot be mistaken for the
 * statement that runs it.
 *
 * The scanner is small on purpose: line and block comments, the three quote
 * characters with backslash escapes, and regex literals recognised the usual
 * cheap way — a `/` in a position where a value may begin. It does not parse
 * JavaScript and does not need to. Getting a regex literal wrong here costs a
 * check that fails loudly on correct code; it can never cost one that passes on
 * broken code, which is the only direction that matters in a gate.
 */
const VALUE_MAY_START = "(,=:[!&|?{};+-*%~^<>\n";
function scan(src, blankStrings) {
  let out = "";
  let prev = "\n";
  for (let i = 0; i < src.length;) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") {
      i += 2;
      /* Newlines are kept so line structure — and so a top-level statement's
       * column zero — survives a block comment. */
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") out += "\n"; i++; }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c, start = i;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        i++;
      }
      out += blankStrings ? q + q : src.slice(start, i);
      prev = q;
      continue;
    }
    if (c === "/" && VALUE_MAY_START.includes(prev)) {
      i++;
      let inClass = false;
      while (i < src.length && src[i] !== "\n") {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) { i++; break; }
        i++;
      }
      out += "RE";
      prev = "E";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}
const noComments = (src) => scan(src, false);
const code = (src) => scan(src, true);

/** Is there a call expression `name(` in this source's CODE? */
const calls = (src, name) => new RegExp(`\\b${name}\\s*\\(`).test(src);

/** The braces-balanced body of the first `decl` in a stripped source, or null. */
function bodyOf(src, decl) {
  const at = src.indexOf(decl);
  if (at < 0) return null;
  const open = src.indexOf("{", at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

const APPCODE = code(APP);
const APPSRC = noComments(APP);
/* Comments out, strings IN — and for this file that is not a nicety: the panel
 * renders through template literals, so `info.needsNote` and every state name a
 * row might quote sit inside a string as far as a scanner is concerned. Blank
 * those and there is nothing left of the page to check. */
const INFOSRC = noComments(INFO);

/* The dispatch is a switch on b.action nested inside the POST handler, so the
 * cases sit well past column 0. Anchoring on that indent avoids catching a
 * `case` from some unrelated shallower switch. */
const serverActions = [...new Set(
  [...ROUTES.matchAll(/^\s{6,}case "([a-z0-9_]+)":/gm)].map((m) => m[1]),
)].sort();
/* BOTH human surfaces, as one set. The tour posts `catalogue`, `showcase`,
 * `dismiss` and `reopen`; the info panel posts `screen_info`. Reading only the
 * first would have let an action be dispatched by the server, called by an
 * agent, and reachable by nobody — which is the exact hole direction 2 exists
 * to find. */
const uiActions = new Set([...`${UI}
${INFO}
${LEVELJS}`.matchAll(/action:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));
const mcpActions = new Set([...MCP.matchAll(/action:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));

/* A regex that matches nothing passes everything, so prove the extraction found
 * a real surface before trusting a word it says. */
/* Seven since UI_PLAN B5 and E1: first_run (the three lines Home shows a new
 * install) and level (Simple or Advanced). */
ok(`the census sees the welcome dispatch at all (${serverActions.length} actions)`,
  serverActions.length === 7, serverActions.join(", "));
ok("...and they are the seven this surface is specified to have",
  ["catalogue", "dismiss", "first_run", "level", "reopen", "screen_info", "showcase"].every((a) => serverActions.includes(a)),
  serverActions.join(", "));

/* ── direction 1: did a gesture invent a write path? ─────────────────────── */
ok(`every action the page posts is one the server dispatches (${uiActions.size})`,
  [...uiActions].every((a) => serverActions.includes(a)),
  [...uiActions].filter((a) => !serverActions.includes(a)).join(", ")
    + " — posted by web/welcome.js and dispatched by nothing");

/* ── direction 2: can a human reach it? ──────────────────────────────────── */
const unreachable = serverActions.filter((a) => !uiActions.has(a));
ok("every action the server dispatches is reachable by a human",
  unreachable.length === 0,
  unreachable.length
    ? `NO HUMAN CONTROL: ${unreachable.join(", ")}\n          `
      + "Add the control. This surface has no NO_UI list on purpose — if one becomes "
      + "necessary, add it here with a named reason rather than deleting this check."
    : "");

/* ── direction 3: can an AGENT reach it? ─────────────────────────────────── */
/* The owner's ask was explicit — "MCP controllable so an agent can tab into
 * it" — so agent-reachability is a requirement here rather than a nicety, and
 * the pair that changes state is where it matters: a welcome an agent can turn
 * off and not back on is half a switch. */
const agentless = serverActions.filter((a) => !mcpActions.has(a));
ok("every action the server dispatches is reachable by an agent",
  agentless.length === 0,
  agentless.length ? `NO MCP TOOL: ${agentless.join(", ")}` : "");
ok("the state-changing pair is whole on both surfaces",
  ["dismiss", "reopen"].every((a) => uiActions.has(a) && mcpActions.has(a)),
  "dismiss and reopen must each be reachable from web/welcome.js AND server/mcp-welcome.js");

/* ── one level down: the FIELDS, not just the action names ────────────────
 *
 * An action both hands can call is not the same as an action that does the
 * same thing in both hands. The Video lab's gate learned this the expensive
 * way — `compare` passed every action-level check while the page sent an
 * argument the tool had no way to send, and that argument silently chose the
 * engine. This surface is much smaller, but the rule is the rule, and the
 * census is cheap: every field the route reads off the body must be a field
 * both surfaces can send, or be named below with the reason it need not be.
 *
 * Both surfaces talk through the same `post({...})` helper, so the check reads
 * the object literal handed to it rather than grepping for the word — grep
 * cannot tell a key being sent from the same word in a sentence, and it scores
 * shorthand properties as absent.
 */
const callBodies = (src) => {
  const keys = new Set();
  for (const m of src.matchAll(/post\(\{/g)) {
    let i = m.index + m[0].length - 1, depth = 0;
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) break; }
    }
    const body = src.slice(start + 1, i);
    let d = 0;
    for (let j = 0; j < body.length; j++) {
      const c = body[j];
      if (c === "{" || c === "[" || c === "(") d++;
      else if (c === "}" || c === "]" || c === ")") d--;
      else if (d === 0 && /[A-Za-z_]/.test(c) && !/[\w.$]/.test(body[j - 1] || " ")) {
        const k = body.slice(j).match(/^([A-Za-z_]\w*)\s*(:|,|$)/);
        if (k) keys.add(k[1]);
      }
    }
  }
  return keys;
};

const routeParams = [...new Set([...ROUTES.matchAll(/\bb\.([A-Za-z_]\w*)/g)].map((m) => m[1]))]
  .filter((p) => p !== "action").sort();
const uiSends = new Set([...callBodies(UI), ...callBodies(INFO), ...callBodies(LEVELJS)]);
const mcpSends = callBodies(MCP);
ok(`the parameter census sees the route's fields (${routeParams.join(", ") || "none"})`,
  routeParams.length >= 1);

/**
 * Fields one hand cannot send, with the reason. Same contract as everywhere
 * else in this family: the entry must name a field the route really reads, and
 * that field must still be unreachable — so closing a gap forces a deletion.
 */
const PARAM_NO_UI = {
  showcase:
    "A read-cost flag, not a capability: it only says whether to walk the disk while building "
    + "the catalogue. The window always wants the showcase (it is a whole tab), and an agent "
    + "wants to skip it on a slow drive. Nothing a person can see differs.",
};
const PARAM_NO_MCP = {};

const paramAgentOnly = routeParams.filter((p) =>
  mcpSends.has(p) && !uiSends.has(p) && !(p in PARAM_NO_UI));
ok("every field the route reads is one a person can send",
  paramAgentOnly.length === 0, paramAgentOnly.join(", "));
const paramHumanOnly = routeParams.filter((p) =>
  uiSends.has(p) && !mcpSends.has(p) && !(p in PARAM_NO_MCP));
ok("every field the route reads is one an agent can send",
  paramHumanOnly.length === 0, paramHumanOnly.join(", "));
for (const [table, name, sends] of [
  [PARAM_NO_UI, "PARAM_NO_UI", uiSends], [PARAM_NO_MCP, "PARAM_NO_MCP", mcpSends],
]) {
  const stale = Object.keys(table).filter((p) => sends.has(p) || !routeParams.includes(p));
  ok(`no stale ${name} exemption`, stale.length === 0, stale.join(", "));
}

/* ── the one-document rule ───────────────────────────────────────────────── */
/**
 * The page renders the catalogue; it does not describe the app.
 *
 * Measured as: long string literals in web/welcome.js. Control labels are
 * short ("Refresh", "Show this again next launch"); a sentence about what the
 * VFX tab can do is not. The threshold is generous on purpose — this is a
 * smoke alarm for a second copy of the product description, not a style rule.
 */
const proseIn = (src) => [...src.matchAll(/"([^"\\\n]{75,})"/g)].map((m) => m[1])
  /* Class attributes and template plumbing are markup, not prose. */
  .filter((s) => !/^[\w\s.#>:%-]+$/.test(s));
/* BOTH pages, and the second is the one this rule was written for. web/info.js
 * renders a paragraph, an honest limit, a first move and a dependency list for
 * every screen in the app — four times the temptation web/welcome.js had to
 * write one sentence of its own "just here, it is only a label". */
for (const [name, src] of [["web/welcome.js", UI], ["web/info.js", INFO], ["web/level.js", LEVELJS]]) {
  const longStrings = proseIn(src);
  ok(`${name} writes no product copy of its own`,
    longStrings.length === 0,
    longStrings.map((s) => `"${s.slice(0, 90)}…"`).join("\n          ")
      + "\n          Prose belongs in server/welcome/catalogue.js, which MCP reads too. "
      + "A sentence here is a sentence an agent never sees.");
}

/* And the mirror of it: the catalogue must actually carry prose, or the check
 * above is passing because there is nothing to say. */
ok("...because the catalogue is where the prose lives",
  [...CATALOGUE.matchAll(/"[^"\\\n]{75,}"/g)].length >= 20);

/* ── every rail entry is covered ─────────────────────────────────────────── */
/**
 * A welcome window that misses a tab is worse than no welcome window: the
 * reader now believes they have seen the whole app. Read the rail out of
 * index.html rather than trusting a list, so a NEW tab fails this the day it
 * is added.
 */
const railViews = [...HTML.matchAll(/<a href="#"[^>]*data-view="([a-z]+)"/g)].map((m) => m[1]);
const railPages = [...HTML.matchAll(/<a href="[\w.]+\.html" data-page="([a-z]+)"/g)].map((m) => m[1]);
const rail = [...new Set([...railViews, ...railPages])];
const covered = new Set([...CATALOGUE.matchAll(/^\s*id: "([a-z]+)", icon:/gm)].map((m) => m[1]));
ok(`the rail was found and read (${rail.length} entries)`, rail.length >= 14, rail.join(", "));
ok("every rail entry has a paragraph in the catalogue",
  rail.every((v) => covered.has(v)),
  rail.filter((v) => !covered.has(v)).join(", ")
    + " — in the rail and not in server/welcome/catalogue.js. A tour that skips a tab "
    + "tells the reader they have seen everything.");
ok("...and the catalogue names no screen that does not exist",
  [...covered].every((v) => rail.includes(v)),
  [...covered].filter((v) => !rail.includes(v)).join(", "));
/* ORDER, where the rail's order is the owner's. Since UI_PLAN B1 (approved
 * 2026-09-24) the rail opens Home, then Make: Music, Pictures, Video, Music
 * video, with Chat and the rest folded under More tools (chat/ui_test pins
 * that). THE TOUR IS NOT THE RAIL, ON PURPOSE: it draws the catalogue by its
 * own three groups (make, assemble, run: what you do, not where the link is),
 * so Chat stays in its "make" group second, where it reads as "or just say
 * what you want", and Music video sits under "assemble". The catalogue is not
 * reordered to the rail: its entries are shared by several lanes, and the tour
 * is no longer what a new install sees first (the Home lines are, UI_PLAN B5).
 * So only what a reader would trip on is pinned: it opens on Home, the three
 * make screens it shares with the rail come in the rail's order, and the Comfy
 * API card sits after Music. The rest of the catalogue has older drift from
 * the rail (daw, vfx, settings/mcp, Explore) that this check would fail on
 * without a change having caused it. */
{
  const order = [...CATALOGUE.matchAll(/^\s*id: "([a-z]+)", icon:/gm)].map((m) => m[1]);
  const make = ["create", "images", "video"];
  ok("the catalogue opens on Home, and Music, Pictures and Video come in the rail's order",
    order[0] === "home"
      && make.every((v, i) => i === 0 || order.indexOf(make[i - 1]) < order.indexOf(v))
      && make.every((v, i) => i === 0 || railViews.indexOf(make[i - 1]) < railViews.indexOf(v)),
    `catalogue ${order.slice(0, 7).join(", ")} · rail ${railViews.slice(0, 6).join(", ")}`);
  ok("...and the Comfy API card comes after Music, where its rail link is",
    order.indexOf("router") > order.indexOf("create") && railViews.indexOf("router") > railViews.indexOf("create"),
    `catalogue ${order.indexOf("router")}, rail ${railViews.indexOf("router")}`);
}

/* ── every screen carries an ⓘ ──────────────────────────────────────────────
 *
 * The owner: "for each component we need to show a little Info part which
 * explains the page and shows what you need for models or other dependencies."
 * FOR EACH — so a screen with no ⓘ is not a missing nicety, it is the feature
 * being half-built, and it is exactly the failure nobody notices: fifteen
 * panels work, the sixteenth screen never had one, and the only way to find out
 * is to click every tab.
 *
 * So the mounts are read out of web/app.js and compared against the rail. This
 * is the falsification the map exists for: delete one line from INFO_HOSTS and
 * this block names it. Add a view to the rail without a mount and it names that
 * too.
 */
/* Comments stripped, strings kept: the selectors are strings and this check
 * needs them, but the map must be the real declaration and not one quoted in a
 * comment explaining what the real one should look like. */
const hostBlock = /const INFO_HOSTS = \{[\s\S]*?\n\};/.exec(APPSRC)?.[0] || "";
const mounts = [...hostBlock.matchAll(/^\s{2}([a-z]+):\s*"([^"]+)",/gm)]
  .map((m) => ({ view: m[1], selector: m[2], from: "web/app.js", html: HTML, htmlName: "web/index.html" }));

/* THE OWN-PAGE MOUNTS, READ THE SAME WAY. None of them is a row in INFO_HOSTS
 * because there is no compositor to loop over on those pages — each is one
 * module with one screen, so each calls mountInfo directly. Read as CODE
 * (strings kept, because both arguments ARE strings; comments dropped, because
 * these files' comments name mountInfo repeatedly and a mention is not a call —
 * the same trap that once let both mountAllInfo() statements be deleted with
 * every check still passing). Either quote style, because web/daw.js and
 * web/avatars.js do not agree on one and a census must not care. */
for (const p of PAGES) {
  p.code = noComments(p.src);
  for (const m of p.code.matchAll(/\bmountInfo\s*\(\s*["']([a-z]+)["']\s*,\s*["']([^"']+)["']\s*\)/g)) {
    mounts.push({ view: m[1], selector: m[2], from: p.js, html: p.doc, htmlName: p.html });
  }
}
ok(`the mount map was found and read (${mounts.length} views, from ${
  [...new Set(mounts.map((m) => m.from))].join(" + ")})`,
  mounts.length >= 15 && PAGES.every((p) => mounts.some((m) => m.from === p.js)),
  "web/app.js INFO_HOSTS or an own-page mountInfo call could not be read — every check "
  + "below would pass vacuously");
for (const p of PAGES) {
  ok(`${p.js} imports the panel it mounts (an import is not a mount, and a mount `
     + "without an import is a ReferenceError that kills the whole module)",
    /import\s*\{[^}]*\bmountInfo\b[^}]*\}\s*from\s*["']\.\/info\.js["']/.test(p.code)
    && calls(code(p.src), "mountInfo"),
    `${p.js} must both import mountInfo from ./info.js and call it`);
  ok(`...and ${p.html} loads the two stylesheets that panel is dressed by`,
    /<link[^>]+href="info\.css"/.test(p.doc) && /<link[^>]+href="modelfit\.css"/.test(p.doc),
    "web/info.css dresses the control and the panel; web/modelfit.css owns .fitbadge.fit-<tone>, "
    + `which the panel borrows so ${p.rail} cannot colour a verdict differently from the Models screen`);
}

/* EMPTY, AND THAT IS THE NEWS. This table held one entry for as long as the ⓘ
 * has existed: the DAW, "a data-page, not a data-view — it owns web/daw.html,
 * which this surface does not touch". The reason was true and it was never a
 * good enough one, because the reader does not know which screens are views of
 * web/index.html; they know they clicked fifteen tabs and one of them had
 * nothing to explain. web/daw.js now calls mountInfo itself and the scrape
 * above reads it, so the exemption is gone rather than justified. The stale-
 * exemption check below is what keeps it gone: put a screen back in here while
 * it really is mounted, or name one that is not in the rail, and this fails. */
const NO_MOUNT = {
  home: "the Welcome page is the mark and five buttons, minimal by the owner's ask (2026-09-19); an ⓘ there would explain five buttons",
};
const mounted = new Set(mounts.map((m) => m.view));
const unmounted = rail.filter((v) => !mounted.has(v) && !(v in NO_MOUNT));
ok("every screen in the rail has an ⓘ mounted for it",
  unmounted.length === 0,
  `NO INFO CONTROL: ${unmounted.join(", ")}\n          `
    + "Add it to INFO_HOSTS in web/app.js — or, for a screen that owns its own page, add a "
    + "PAGES row above and call mountInfo from that page's module the way web/daw.js does. "
    + "Every screen gets one — that is the ask, and a screen without one is the reader being "
    + "told this page has nothing to explain.");
ok("...and no mount names a screen that is not in the rail",
  mounts.every((m) => rail.includes(m.view)),
  mounts.filter((m) => !rail.includes(m.view)).map((m) => m.view).join(", "));
ok("...and every mounted screen has a paragraph in the catalogue",
  mounts.every((m) => covered.has(m.view)),
  mounts.filter((m) => !covered.has(m.view)).map((m) => m.view).join(", "));
const stale = Object.keys(NO_MOUNT).filter((v) => mounted.has(v) || !rail.includes(v));
ok("no stale NO_MOUNT exemption", stale.length === 0, stale.join(", "));

/* A selector that resolves to nothing mounts nothing, silently, and the panel
 * is missing for exactly one screen — which is the shape of this feature's
 * worst bug. Every one of them must name an id or a class that is really in
 * web/index.html. */
const deadSelectors = mounts.filter(({ selector, html }) => {
  const id = /^#([\w-]+)$/.exec(selector);
  if (id) return !html.includes(`id="${id[1]}"`);
  const cls = /^\.([\w-]+)$/.exec(selector);
  if (cls) return !new RegExp(`class="[^"]*\\b${cls[1]}\\b`).test(html);
  /* "#id .class": the element with that id, and that class somewhere after it
   * (Images mounts on its form column, whose heading is the page's). */
  const desc = /^#([\w-]+) \.([\w-]+)$/.exec(selector);
  if (desc) {
    const at = html.indexOf(`id="${desc[1]}"`);
    return at < 0 || !new RegExp(`class="[^"]*\\b${desc[2]}\\b`).test(html.slice(at));
  }
  return true;
});
ok("every mount points at an element that exists in the document that mount's page serves",
  deadSelectors.length === 0,
  deadSelectors.map((m) => `${m.view} -> ${m.selector} (looked in ${m.htmlName})`).join(", ")
    + " — a selector that matches nothing mounts nothing and says nothing about it");

/* ── the panel shows the fit, and shows it the Models screen's way ─────────
 *
 * A dependency list without "will it run here" is a list of names. The whole
 * reason `screen_info` costs a round trip to /api/models is the badge, so a
 * panel that dropped it would leave the expensive half of this feature unused
 * and nothing else would fail. */
ok("the panel renders the readiness badge and the machine-fit badge",
  INFO.includes("needStates") && INFO.includes("fitStates"),
  "server/welcome/routes.js sends both tables; a panel that reads only one is answering "
    + "half the question — 'on disk' and 'fits your card' are different answers");
ok("...using the Models screen's own badge, not a second one",
  /fitbadge fit-/.test(INFO),
  "web/modelfit.css already dresses .fitbadge.fit-<tone> for the four verdicts server/fit.js "
    + "sends. A second badge here is a second opinion about the same card.");
ok("...and a screen that needs nothing says so from the server's sentence",
  INFO.includes("needsNothing") && INFO.includes("needsLine"),
  "the bit-transparent line is written in server/welcome/catalogue.js's route, not here");
ok("the panel offers the way on to the Models screen",
  INFO.includes("modelsView"),
  "a row that says 'not downloaded' with no door to the screen that downloads it is a dead end");
ok("...and a screen whose dependency is outside both indexes shows that sentence",
  /\binfo\.needsNote\b/.test(INFOSRC),
  "`needsNote` is how Reactive says it needs a second ComfyUI and how the compositor says it "
    + "needs two packages nothing can probe. A panel that drops it shows a short list and "
    + "reads as complete.");

/* ── the panel knows no readiness state by name ────────────────────────────
 *
 * THE BUG THIS IS FOR, and there were three of it in one function. The row
 * carried `["absent", "needs-package", "unknown"].includes(state)` to decide
 * which sentences to print, `state === "ready"` to decide whether the size
 * meant the whole thing or the remainder, and `state !== "ready" && state !==
 * "via-package"` to decide whether to print a gated repository's hand-fetch
 * steps. Three typed lists of the same vocabulary, and the first was already
 * wrong: `via-package` was not on it, so the one state whose chip says "Ready"
 * while meaning "its package downloads the weights on first run" had a
 * sentence in the table that nothing in this app could render.
 *
 * A page that keeps its own copy of which states are special cannot be right
 * for long, and is wrong SILENTLY — nothing renders differently until somebody
 * reaches the state that was left off. So the states carry their own flags now
 * (`inline`, `nothingToFetch`), and this check is the one that keeps it that
 * way: every key of the real table, in the real file, with the comments taken
 * out so the paragraphs above may still discuss them by name.
 */
const namedStates = Object.keys(NEED_STATES).filter((s) =>
  new RegExp(`["'\`]${s}["'\`]`).test(INFOSRC)
  || (/^[A-Za-z_]\w*$/.test(s) && new RegExp(`\\.\\s*${s}\\b`).test(INFOSRC)));
ok(`web/info.js names no readiness state of its own (${Object.keys(NEED_STATES).length} states)`,
  namedStates.length === 0,
  `${namedStates.join(", ")} — typed into web/info.js. Ask the state instead: put a flag on it `
    + "in server/welcome/catalogue.js NEED_STATES, which is the table the panel is already "
    + "handed and the one an agent reads too.");

/* THE GROUP ANSWER REACHES THE PANEL. Before a music engine is ready the Models
 * screen badges every music row "one music engine required" and no single one
 * `required` (server/models.js markRequired). The join used to carry only
 * `required`, so this panel would have shown the selected engine with no chip
 * at all while the Models screen said one is required. */
ok("a music row's group answer reaches the info panel, in the Models screen's words",
  /requiredGroup: cap\?\.requiredGroup \?\? null,/.test(ROUTES)
  && /n\.requiredGroup === "music" \? '<span class="infoneed">one music engine required<\/span>'/.test(INFO));

/* ── the panel may not push the screen out from under itself ───────────────
 *
 * MEASURED, at 1440x900. This panel is prose about a screen and can run to any
 * length: Music renders 1492 px of it into a column 846 px tall that scrolls
 * its own content, so unbounded it pushed that screen's first control — the
 * Song/Instrumental switch — from y=64 to y=1556, past the bottom of its own
 * column. Images put its prompt box at 1064, Video its search field at 929,
 * Workflow its project picker at 1288, all off a 900 px screen. And open or
 * closed is remembered, so it was not a moment's surprise: it was how those
 * screens looked on every later visit until the reader found the ⓘ again.
 *
 * Three declarations fix it and all three are load-bearing, so all three are
 * checked. `flex: none` is the one that looks optional and is not: several of
 * these hosts are flex columns, a flex item in one shrinks, and with the bound
 * but without it the Music panel collapsed to 30 px — the form stayed put and
 * the panel became the thing that disappeared.
 */
const cssRules = INFOCSS.replace(/\/\*[\s\S]*?\*\//g, "");
const panelRule = /\.infopanel\s*\{([^}]*)\}/.exec(cssRules)?.[1] || "";
ok("the panel's own rule was found in web/info.css", !!panelRule.trim(),
  "every check below would pass vacuously");
ok("the info panel opens at a bounded height, and scrolls its own overflow",
  /max-height\s*:/.test(panelRule) && /overflow-y\s*:\s*auto/.test(panelRule),
  "an unbounded panel pushes the screen's first control below the fold, and the panel "
    + "remembers that it is open");
ok("...and cannot be shrunk to nothing by a flex host",
  /flex\s*:\s*none/.test(panelRule),
  "web/index.html's Create column is a flex column; a flex item in one shrinks to fit, "
    + "so the bound would eat the panel instead of the form");

/* ── the seams, and every one of them is a CALL ───────────────────────────
 *
 * Not a mention. This block was four `includes()` checks, and the one on the
 * mount was proven to pass with both call sites deleted — the word survives in
 * the import, in the declaration and in the comments that explain why the mount
 * runs twice. Each of these now asks the stripped source for a call expression,
 * and the two that also need a string (a route path, a module specifier) ask
 * the comment-stripped source for that separately.
 */
const INDEXSRC = noComments(INDEX);
ok("the route is mounted in server/index.js",
  calls(code(INDEX), "createWelcomeRoutes") && INDEXSRC.includes('"/api/welcome"'),
  "server/welcome/routes.js is not reachable — three lines in index.js, see its header");
ok("the MCP tools are registered in server/mcp.js",
  calls(code(MCPMAIN), "welcomeTools"),
  "server/mcp-welcome.js exports tools nothing spreads into TOOLS");
ok("the page is loaded by web/app.js", calls(APPCODE, "initWelcome"),
  "web/welcome.js exports initWelcome and nothing calls it — no welcome window, ever");

/* ── the ⓘ is actually mounted: the two statements, found as statements ────
 *
 * TWO of them, because the panel's idempotence argument rests on the second.
 * The mount at load gives a view nobody has opened yet its control; the mount
 * on view change gives it back to a screen that rebuilt its own container, and
 * VFX does exactly that (`root.innerHTML =` on first open). Losing either is
 * invisible until somebody clicks the one screen it costs.
 */
ok("web/app.js imports the mount from web/info.js",
  /import\s*\{[^}]*\bmountInfo\b[^}]*\}\s*from\s*["']\.\/info\.js["']/.test(APPSRC),
  "nothing in this app can mount an ⓘ");
const mountBody = bodyOf(APPCODE, "function mountAllInfo(");
ok("...and mountAllInfo is the mount, not a stub",
  !!mountBody && calls(mountBody, "mountInfo"),
  "mountAllInfo exists and never calls mountInfo — every screen would keep its "
    + "button-shaped nothing and every check below would pass");
/* The declaration matches this shape too and is not a call — which is the same
 * mistake one level down, and it would have scored the deleted version 1. */
const mountCalls = [...APPCODE.matchAll(/(function\s+)?\bmountAllInfo\s*\(\s*\)/g)]
  .filter((m) => !m[1]);
ok(`the info panel is mounted by web/app.js (${mountCalls.length} call sites)`,
  mountCalls.length >= 2,
  "web/info.js exports mountInfo and nothing calls it — fifteen screens with no ⓘ. "
    + "This is a call expression in stripped source, not a substring: the previous "
    + "version of this check passed with both call sites deleted.");
ok("...one of them at load, as a top-level statement",
  /^mountAllInfo\s*\(\s*\)\s*;/m.test(APPCODE),
  "a view nobody has opened yet must already carry its control");
const setViewBody = bodyOf(APPCODE, "function setView(");
ok("...and one of them on the view change",
  !!setViewBody && calls(setViewBody, "mountAllInfo"),
  "setView was found but does not re-run the mounts — a screen that rebuilds its own "
    + "container (VFX does) silently loses its ⓘ and keeps it lost");
ok("the stylesheet is linked by web/index.html", HTML.includes("welcome.css"));
ok("the info stylesheet is linked by web/index.html", HTML.includes("info.css"),
  "the panel would render unstyled, which on this app's dark ground is unreadable");
ok("About can re-open the window", HTML.includes('id="welcomeOpen"'),
  "the window must be re-openable from About — a tour you can only ever see once "
  + "is a tour you saw before you knew what to look for");

/* ── the one-palette rule, as in web/daw.css ─────────────────────────────── */
/* Every colour in this sheet must be a token from styles.css. A hex or an
 * hsl() here is a second design starting. */
for (const [name, sheet] of [["web/welcome.css", CSS], ["web/info.css", INFOCSS]]) {
  const rawColour = [...sheet.matchAll(/(?:^|[\s:,(])(#[0-9a-fA-F]{3,8}\b|hsl\(|rgb\()/g)]
    /* The one legal exception, and it is not a palette colour: a plain black
     * drop shadow, which is what every other sheet in the suite uses too. */
    .filter((m) => !sheet.slice(Math.max(0, m.index - 60), m.index).includes("box-shadow"));
  ok(`${name} spells no colour of its own`,
    rawColour.length === 0,
    rawColour.map((m) => m[1]).join(", ") + " — use the var(--…) tokens from styles.css");
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
console.log(`        (actions: ${serverActions.join(", ")})\n`);
process.exit(failures.length ? 1 : 0);
