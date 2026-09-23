/**
 * THE DOOR CENSUS — every MCP tool posts to a route that exists, and names an
 * action that route actually handles.
 *
 * ── the failure this exists for ──────────────────────────────────────────────
 *
 * `score_render` shipped posting `{ action: "render" }` to /api/score. That
 * route dispatches sixteen actions and `render` has never been one of them —
 * `git log -p --follow server/score/routes.js` shows no `case "render"` in
 * either commit the file has. So the tool answered
 *
 *   {"error":"Unknown action. Try: list, create, read, adopt, draft, note,
 *    author, current, map, invariants, lineage, sheet, capability, delete,
 *    to_daw, export_midi."}
 *
 * for every input anyone could give it, for its whole existence, while sitting
 * in the catalogue advertising a measured GPU cost. It was not the first:
 * server/score/routes.js:451 carries a comment about `draft`, found the same
 * way on 2026-09-11, and says plainly that "188 assertions passed, because the
 * suite checks what the tool would SEND, not what happens when it arrives".
 *
 * Every existing tool-surface lane checks the tool against ITSELF — that a
 * declared parameter reaches run() (mcp-image_test.js, mcp-daw_test.js,
 * mcp-vfx_test.js), that a description does not name a phantom tool
 * (mcp-guide_test.js). None of them looks at the other end of the wire. This
 * one does, and only that: does the door exist, and does it know the word.
 *
 * ── what it can and cannot see ───────────────────────────────────────────────
 *
 * This is a STATIC read of `String(tool.run)` plus the server source. It cannot
 * run the server and it cannot follow a path computed at run time. So it counts
 * what it managed to analyse, counts what it did not, and prints BOTH — a lane
 * that quietly covers two thirds while reading like it covers all of them is
 * the same lie it was written to catch. A tool it cannot analyse must be named
 * in UNREADABLE below with a reason; the run is FAILED otherwise, so "not got
 * round to" cannot hide inside "not analysable".
 *
 * It resolves three layers of indirection, because the codebase uses all three:
 *
 *   1. a module's own one-line POST wrapper (`const score = async (body) =>
 *      api("POST", "/api/score", body)`), and helpers that call one;
 *   2. a wrapper handed to a sub-module's factory (`...rackTools({ daw, get,
 *      slugOf })`), followed through the import;
 *   3. a run() re-wrapped after the fact — mcp-vfx.js replaces every slug-bear-
 *      ing tool's run with a revision-scoped closure and parks the original on
 *      `run.unwrappedRun`, which it added for exactly this kind of audit.
 *
 * And on the route side, it follows the delegating mounts: server/daw/routes.js
 * hands `action` to voicelab.js and refprofile.js before its own switch, so
 * their cases are the door's cases too.
 *
 * Runs standalone (`node server/mcp-routes_test.js`) and in the pre-commit
 * hook. No server, no GPU, no python.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TOOLS } from "./mcp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
/* CRLF-normalised for the same reason mcp-image_test.js does it: a Windows
 * checkout adds a byte per line, and every offset below is an index into this
 * text. */
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

/* ──────────────────────────────────────────────────────────────────────────
 * THE FILES. Both lists are asserted non-empty and, for the MCP side, checked
 * against the tools actually registered — a file dropped from here would
 * silently shrink the census otherwise.
 * ────────────────────────────────────────────────────────────────────────── */

const MCP_FILES = [
  "server/mcp.js",
  "server/mcp-audio.js",
  "server/mcp-avatars.js", "server/mcp-avatar-appearance.js", "server/mcp-collab.js", "server/mcp-daw.js", "server/mcp-engine.js",
  "server/mcp-guide.js", "server/mcp-models.js", "server/mcp-music-input.js",
  "server/mcp-music-plan.js", "server/mcp-music-score.js", "server/mcp-mv.js",
  "server/mcp-music-auditions.js", "server/mcp-music-kits.js", "server/mcp-music-references.js",
  "server/mcp-music-artifacts.js", "server/mcp-music-listening-lab.js",
  "server/mcp-vfx.js", "server/mcp-videolab.js", "server/mcp-welcome.js", "server/mcp-yue-setup.js", "server/mcp-workspace.js",
  "server/daw/mcp-ear.js", "server/daw/mcp-master.js", "server/daw/mcp-rack.js",
  "server/daw/mcp-refprofile.js", "server/daw/mcp-voicelab.js",
];

/* Everything that answers a /api/ path. index.js serves most of them inline and
 * mounts the rest; these are the mounted ones, from its own import list. */
const ROUTE_FILES = [
  "server/index.js", "server/vfx/routes.js", "server/score/routes.js", "server/daw/routes.js",
  "server/videolab/routes.js", "server/daw/ear.js", "server/engine/routes.js",
  "server/llm/routes.js", "server/mv/routes.js", "server/welcome/routes.js",
  "server/chat/routes.js", "server/prompt-tools.js", "server/music-input.js",
  "server/music-plan.js", "server/mesh/avatar.js",
  "server/music/auditions.js", "server/music/workflows.js", "server/music/identity-kits.js",
  "server/music/artifacts.js", "server/music/listening-lab.js",
];

/* ──────────────────────────────────────────────────────────────────────────
 * TOOLS THIS LANE CANNOT READ. A reason each, and the reason has to be about
 * the SHAPE of the code — "a route computed at run time" is one, "I did not get
 * round to it" is not. An entry naming a tool that no longer exists fails too,
 * so the list cannot rot into a licence for whatever later takes that name.
 * ────────────────────────────────────────────────────────────────────────── */
const UNREADABLE = {
  studio_api_request: "The user chooses an existing local JSON API path and method at runtime. server/mcp-workspace_test.js verifies its /api/ restriction, traversal and external-URL refusal, and method/body limits; typed workflows remain separately censused.",
  yue2_gguf_setup:
    "its run() picks the path from the action it was given — `action: \"cancel\"` posts to "
    + "/api/music-gguf/setup and the other two to /api/music-gguf — so there is no single "
    + "literal to read. Covered instead by server/mcp-yue-setup_test.js, which asserts both "
    + "paths and all three actions against the route source.",
  enhance_style:
    "the three enhance_* tools are built by one factory in server/mcp.js whose `name` is an "
    + "index into a lookup ({ style: \"enhance_style\", ... }[field]), so no source line spells "
    + "the tool's name and this lane cannot find the file that owns it. The factory's single "
    + "run() posts to /api/enhance, which is asserted below as a route that exists.",
  enhance_lyrics: "see enhance_style — the same factory, the same computed name.",
  enhance_description: "see enhance_style — the same factory, the same computed name.",
};

/* ──────────────────────────────────────────────────────────────────────────
 * TOOLS THAT MAKE NO HTTP CALL AT ALL, declared for the same reason as the
 * list above. "Posts nothing" and "this lane could not find what it posts"
 * look identical from here, so leaving the first undeclared hides the second:
 * deleting the `unwrappedRun` read in callsOf() moves 33 vfx tools into this
 * bucket and, without this pin, the run stays green while a third of the
 * catalogue goes unchecked. That was MEASURED by breaking it on purpose.
 * ────────────────────────────────────────────────────────────────────────── */
const ANSWERS_LOCALLY = {
  studio_api_reference: "Reads and searches local API.md as bounded documentation text. It does not execute an example or make an HTTP request.",
  pipeline_guide:
    "reads a table of strings in server/mcp-guide.js and returns one. There is no route "
    + "behind it and there should not be — it is the map of the other tools.",
};

/* ──────────────────────────────────────────────────────────────────────────
 * A tiny reader. Not a parser: it balances brackets while skipping strings,
 * template literals and comments, which is all the shapes below need.
 * ────────────────────────────────────────────────────────────────────────── */
const CLOSERS = { "(": ")", "{": "}", "[": "]" };

/** Index just past the bracket matching the one at `open`. */
function balanced(src, open) {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c; i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === q) break;
        i++;
      }
      i++; continue;
    }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (CLOSERS[c]) { depth++; i++; continue; }
    if (c === ")" || c === "}" || c === "]") { depth--; i++; if (!depth) return i; continue; }
    i++;
  }
  return src.length;
}

/** Blank every comment, keeping byte offsets and line breaks. A route path
 *  quoted in a banner comment — and server/vfx/routes.js opens with one that
 *  shows `p === "/api/vfx"` — is documentation, not a door. */
function blankComments(src) {
  const out = src.split("");
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c; i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") { out[i] = " "; i++; } continue; }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      const stop = e < 0 ? src.length : e + 2;
      for (let j = i; j < stop; j++) if (out[j] !== "\n") out[j] = " ";
      i = stop; continue;
    }
    i++;
  }
  return out.join("");
}

const lineOf = (src, at) => src.slice(0, at).split("\n").length;

/* ──────────────────────────────────────────────────────────────────────────
 * PART 1 — what the server serves.
 * ────────────────────────────────────────────────────────────────────────── */

/* `p === "/api/x"`, `p !== "/api/x"` (the early-return form the mounted route
 * modules use) and `pathname === "/api/x"`. */
const PATH_EXACT = /\b(?:p|pathname|url\.pathname|req\.url)\s*(?:===|!==)\s*(["'`])(\/api\/[^"'`${]*)\1/g;
const PATH_PREFIX = /\b(?:p|pathname|url\.pathname)\s*\.startsWith\(\s*(["'`])(\/api\/[^"'`${]*)\1/g;
/* `const voicelab = await import("./voicelab.js")` — a delegating mount's
 * module, bound to a name the door then calls with `action`. The same shape
 * binds an optional TOOL factory in server/mcp-daw.js, so both scans use it. */
const DYN_IMPORT = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\(?\s*await\s+import\(\s*(["'])([^"']+)\2/g;
const STATIC_IMPORT = /\bimport\s*\{([^}]*)\}\s*from\s*(["'])([^"']+)\2/g;
/* The two shapes a delegating mount takes in this codebase:
 * `voicelab?.handleVoiceLabAction?.(action, b, ctx)` through an optional
 * dynamic import, and a plain `handleMixerAction(action, b, ctx)` through a
 * static one. Both mean the same thing — the door answers with whatever the
 * other module returns, so that module's cases ARE this door's actions. */
const DELEGATE_NS = /\b([A-Za-z_$][\w$]*)\s*\??\.\s*(handle[A-Za-z]*Action)\s*\??\.?\(\s*action\b/g;
const DELEGATE_FN = /(?<![.\w$])\b(handle[A-Za-z]*Action)\s*\(\s*action\b/g;
/* A door that validates against an allow-list instead of switching on it:
 * `if (!["save", "open", "list", "delete"].includes(action))`. The one such
 * door here is /api/images/documents, and without this its real action set
 * reads as two rather than four. */
const ALLOW_LIST = /\[([^\]]*)\]\s*\.includes\(\s*(?:b\.|body\.)?action\s*\)|new Set\(\[([^\]]*)\]\)\s*\.has\(\s*(?:b\.|body\.)?action\s*\)/g;

const exactPaths = new Set();
const prefixPaths = new Set();
const actionsByPath = new Map();      // path -> Set(action)
/* Doors that SAY they dispatch on an action — they answer "Unknown action" to
 * one they do not know. If the scan found no actions for one of these, the
 * scan is broken for that door and every tool posting to it is being waved
 * through, which is exactly how the welcome door's five actions were invisible
 * until the switch discriminant was read by balancing. */
const claimsActions = new Set();
const addAction = (p, a) => {
  if (!actionsByPath.has(p)) actionsByPath.set(p, new Set());
  actionsByPath.get(p).add(a);
};

/** Top-level `case "x":` labels of every `switch` whose discriminant mentions
 *  `action`. Nested switches are skipped by brace depth. */
function actionCases(src) {
  const out = [];
  for (const m of src.matchAll(/\bswitch\s*\(/g)) {
    /* The discriminant is read by balancing, not by [^)]*. server/welcome/
     * routes.js:307 switches on `String(b.action || "")`, and a regex that
     * stops at the first ")" misses that door completely — which is how five
     * live welcome actions read as a door that dispatches nothing, and every
     * studio_* tool posting to it went unjudged. */
    const parenAt = m.index + m[0].length - 1;
    const afterParen = balanced(src, parenAt);
    const discriminant = src.slice(parenAt, afterParen);
    if (!/\baction\b/.test(discriminant)) continue;
    let braceAt = afterParen;
    while (/\s/.test(src[braceAt])) braceAt++;
    if (src[braceAt] !== "{") continue;
    const body = src.slice(braceAt + 1, balanced(src, braceAt) - 1);
    let depth = 0;
    const re = /(\{|\}|\bcase\s+(["'])([A-Za-z0-9_]+)\2\s*:)/g;
    let c;
    const cases = [];
    while ((c = re.exec(body))) {
      if (c[1] === "{") depth++;
      else if (c[1] === "}") depth--;
      else if (depth === 0) cases.push(c[3]);
    }
    out.push({ at: m.index, line: lineOf(src, m.index), cases });
  }
  return out;
}

const routeSource = new Map();
for (const f of ROUTE_FILES) routeSource.set(f, blankComments(read(f)));

for (const [f, src] of routeSource) {
  /* The anchors: every route-path literal, grouped by the line it sits on, so
   * a guard naming two paths at once (engine/routes.js:181 tests /api/engine
   * and /api/engine/prompt in one condition) owns the actions for both. */
  const anchors = [];
  const hits = [
    ...[...src.matchAll(PATH_EXACT)].map((m) => ({ at: m.index, p: m[2], exact: true })),
    ...[...src.matchAll(PATH_PREFIX)].map((m) => ({ at: m.index, p: m[2], exact: false })),
  ].sort((a, b) => a.at - b.at);
  for (const h of hits) {
    (h.exact ? exactPaths : prefixPaths).add(h.p);
    const line = lineOf(src, h.at);
    const last = anchors[anchors.length - 1];
    /* Actions are attributed to EXACT paths only. A prefix guard is a
     * path-parameterised GET (/api/mv/asset/<name>); nothing action-dispatched
     * hides behind one, and letting prefixes collect actions made
     * /api/score/file/ look as though it accepted `draft`. */
    if (!h.exact) continue;
    if (last && last.line === line) { last.paths.add(h.p); continue; }
    anchors.push({ line, at: h.at, paths: new Set([h.p]) });
  }
  const nearest = (at) => {
    let best = null;
    for (const a of anchors) { if (a.at < at) best = a; else break; }
    return best;
  };

  /* The if-chain form, which is what server/index.js uses for its own doors:
   * `if (b.action === "start") ...`. Attributed to the nearest door above it,
   * at any distance — a long chain (the collab door runs 300 lines) is still
   * inside the door that opened it. */
  for (const m of src.matchAll(/\b(?:b|body|req)?\.?\baction\s*===\s*(["'])([A-Za-z0-9_]+)\1/g)) {
    const a = nearest(m.index);
    if (a) for (const p of a.paths) addAction(p, m[2]);
  }

  /* The one-action door, written as a refusal rather than a dispatch:
   * `if (b.action !== "trash") return json(res, 400, {error:"Unknown action."})`.
   * server/index.js has six of these. Read only the `===` form and they look
   * like doors that dispatch on a word and accept none of them. */
  for (const m of src.matchAll(/\b(?:b|body|req)?\.?\baction\s*!==\s*(["'])([A-Za-z0-9_]+)\1/g)) {
    const a = nearest(m.index);
    if (a) for (const p of a.paths) addAction(p, m[2]);
  }

  /* The switch form, which is what the mounted route modules use. The window
   * is because a door is often guarded across two or three lines before its
   * switch (a GET arm, then the POST arm, then the dispatch); anything further
   * back than sixty lines is a different door. */
  for (const sw of actionCases(src)) {
    const owners = new Set();
    for (const a of anchors) {
      if (a.at >= sw.at) break;
      if (sw.line - a.line <= 60) for (const p of a.paths) owners.add(p);
    }
    if (!owners.size) { const a = nearest(sw.at); if (a) for (const p of a.paths) owners.add(p); }
    for (const p of owners) for (const act of sw.cases) addAction(p, act);
  }

  /* The door's own confession that it dispatches on a word. */
  for (const m of src.matchAll(/[Uu]nknown (?:setup )?action/g)) {
    const a = nearest(m.index);
    if (a) for (const p of a.paths) claimsActions.add(p);
  }

  /* The allow-list form. */
  for (const m of src.matchAll(ALLOW_LIST)) {
    const list = m[1] ?? m[2] ?? "";
    const a = nearest(m.index);
    if (!a) continue;
    for (const lit of list.matchAll(/(["'])([A-Za-z0-9_]+)\1/g)) for (const p of a.paths) addAction(p, lit[2]);
  }

  /* The delegating mounts. server/daw/routes.js hands `action` to mixer.js at
   * :1624, then to voicelab.js at :1636 and refprofile.js at :1639, answering
   * with whatever they return — so `mixer_set`, `render_stems` and
   * `profile_list` ARE /api/daw actions even though that file's own switch has
   * never heard of them. Followed rather than listed by hand: a table of
   * delegates would go stale the first time one moved, and a stale table here
   * reports fourteen live tools as dead. */
  const imports = new Map();
  for (const m of src.matchAll(DYN_IMPORT)) imports.set(m[1], m[3]);
  for (const m of src.matchAll(STATIC_IMPORT)) {
    for (const n of m[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean)) imports.set(n, m[3]);
  }
  const follow = (bindingName, at) => {
    const rel = imports.get(bindingName);
    if (!rel || !rel.startsWith(".")) return;
    const target = path.posix.join(path.posix.dirname(f), rel.replace(/^\.\//, ""));
    let delegated;
    try { delegated = blankComments(read(target)); } catch { return; }
    const a = nearest(at);
    if (!a) return;
    for (const sw of actionCases(delegated)) for (const p of a.paths) for (const act of sw.cases) addAction(p, act);
  };
  for (const m of src.matchAll(DELEGATE_NS)) follow(m[1], m.index);
  for (const m of src.matchAll(DELEGATE_FN)) follow(m[1], m.index);
}

/* ──────────────────────────────────────────────────────────────────────────
 * PART 2 — what the tools post.
 * ────────────────────────────────────────────────────────────────────────── */

// Factory instances mounted in index.js dispatch in their own modules, rather
// than through an imported namespace. Read their actual comparisons too; a
// mounted URL alone does not prove that its create/accept/etc actions exist.
for (const [route, moduleFile, factory, method] of [
  ["/api/images/ai-edit", "server/image-editor.js", "createImageEditor", "imageEditor.request"],
  ["/api/collab/plan", "server/collab/planning.js", "createCollabPlanningRoutes", "collabPlanningRoutes(req"],
  ["/api/music-kits", "server/music/identity-kits.js", "createMusicWorkflowRoutes", "musicWorkflowRoutes(req"],
  ["/api/music-references", "server/music/references.js", "createMusicWorkflowRoutes", "musicWorkflowRoutes(req"],
  ["/api/music-artifacts", "server/music/artifacts.js", "createMusicArtifactRoutes", "musicArtifactRoutes(req"],
  ["/api/music-listening-lab", "server/music/listening-lab.js", "createListeningLabRoutes", "listeningLabRoutes(req"],
]) {
  const indexSource = routeSource.get("server/index.js");
  const mounted = indexSource.includes(factory) && indexSource.includes(method) && exactPaths.has(route);
  ok(`${route} delegates to its expected factory handler`, mounted);
  if (!mounted) continue;
  const source = blankComments(read(moduleFile));
  for (const m of source.matchAll(/\b(?:body\.)?action\s*===\s*(["'])([A-Za-z0-9_]+)\1/g)) addAction(route, m[2]);
  claimsActions.add(route);
}

/* `api("POST", "/api/score", ...)`, and the template form `api("GET",
 * \`/api/daw/project/${slug}\`)` whose literal head is all we can know. */
const API_LIT = /\bapi\s*\(\s*(["'])(GET|POST|PUT|DELETE|PATCH)\1\s*,\s*(["'`])([^"'`]*?)(?:\3|\$\{)/g;
/* `api("GET", p)` inside a wrapper: the path is the wrapper's own argument, so
 * the literal lives at the CALL site instead. */
const API_VAR = /\bapi\s*\(\s*(["'])(GET|POST|PUT|DELETE|PATCH)\1\s*,\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
const ACTION_LIT = /\baction\s*:\s*(["'])([A-Za-z0-9_]+)\1/g;

/** Every named arrow or function in a file, with its body text. */
function definitions(src) {
  const defs = [];
  /* The optional ternary head is server/daw/mcp-voicelab.js:58 — `const
   * dawSlow = api ? async (body) => {...} : daw`, a wrapper that exists only
   * when the render lane's `api` was handed in. Without it daw_render_stems
   * reads as a tool that posts nothing. */
  const arrow = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\s*\?\s*)?(?:async\s+)?(\(|[A-Za-z_$][\w$]*\s*=>)/g;
  let m;
  while ((m = arrow.exec(src))) {
    let bodyAt;
    if (m[2] === "(") {
      const parenAt = m.index + m[0].length - 1;
      const after = balanced(src, parenAt);
      const tail = src.slice(after, after + 12);
      if (!/^\s*=>/.test(tail)) continue;
      bodyAt = after + tail.indexOf("=>") + 2;
    } else {
      bodyAt = m.index + m[0].length;   // single-parameter arrow: `body => api(...)`
    }
    while (/\s/.test(src[bodyAt])) bodyAt++;
    let end;
    if (src[bodyAt] === "{" || src[bodyAt] === "(") end = balanced(src, bodyAt);
    else { end = src.indexOf(";", bodyAt); if (end < 0) end = bodyAt + 400; }
    defs.push({ name: m[1], body: src.slice(bodyAt, end) });
  }
  const fn = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = fn.exec(src))) {
    const parenAt = m.index + m[0].length - 1;
    let bodyAt = balanced(src, parenAt);
    while (/\s/.test(src[bodyAt])) bodyAt++;
    if (src[bodyAt] !== "{") continue;
    defs.push({ name: m[1], body: src.slice(bodyAt, balanced(src, bodyAt)) });
  }
  return defs;
}

/**
 * The POST/GET wrappers a file defines: name -> the routes calling it reaches.
 * A wrapper is SMALL by construction (four lines: call, throw on error,
 * return). The size cap is what keeps a mis-balanced scan over a 600-line tool
 * body from being read as a wrapper that posts everywhere.
 */
function wrappersIn(src) {
  const table = new Map();
  const bodies = new Map();
  for (const d of definitions(src)) {
    if (d.body.length > 3000) continue;
    bodies.set(d.name, d.body);
    const routes = [...d.body.matchAll(new RegExp(API_LIT.source, "g"))]
      .map((c) => ({ method: c[2], path: c[4], fromArg: false }));
    for (const c of d.body.matchAll(new RegExp(API_VAR.source, "g"))) {
      routes.push({ method: c[2], path: null, fromArg: true });
    }
    if (routes.length) table.set(d.name, { routes });
  }
  /* A helper that calls a wrapper reaches the wrapper's route. Three rounds is
   * more than this codebase needs (readVersion -> score is one hop). */
  for (let round = 0; round < 3; round++) {
    for (const [name, body] of bodies) {
      if (table.has(name)) continue;
      const routes = [];
      for (const [other, v] of table) {
        if (other === name) continue;
        if (new RegExp(`\\b${other}\\s*\\(`).test(body)) routes.push(...v.routes);
      }
      if (routes.length) table.set(name, { routes });
    }
  }
  return table;
}

const mcpSource = new Map();
const wrapperByFile = new Map();
const ownerOf = new Map();
for (const f of MCP_FILES) {
  const src = blankComments(read(f));
  mcpSource.set(f, src);
  wrapperByFile.set(f, wrappersIn(src));
  for (const m of src.matchAll(/\bname\s*:\s*(["'])([a-z0-9_]+)\1/g)) if (!ownerOf.has(m[2])) ownerOf.set(m[2], f);
  // Local typed-tool factories take the literal name as their first argument.
  // Resolve ownership from that call so their HTTP wrappers remain censused.
  for (const m of src.matchAll(/\btool\s*\(\s*(["'])([a-z0-9_]+)\1/g)) if (!ownerOf.has(m[2])) ownerOf.set(m[2], f);
}

/* A sub-module's tools are built by a factory that is HANDED the parent's
 * wrapper — `...rackTools({ daw, get, slugOf })`. Follow the import and copy
 * the parent's entries in under the same names, so daw_insert resolves to
 * POST /api/daw the way the parent's own tools do. Shorthand only, which is
 * the only form used; a renaming call would simply not resolve and the tool
 * would be reported as unreadable rather than wrongly passed. */
for (const [f, src] of mcpSource) {
  const imports = new Map();
  for (const m of src.matchAll(new RegExp(STATIC_IMPORT.source, "g"))) {
    for (const n of m[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean)) {
      imports.set(n, m[3]);
    }
  }
  /* The Voice Lab and the Reference Profile are OPTIONAL modules, imported
   * dynamically so a tree without them has fewer tools rather than a broken
   * tool list (server/mcp-daw.js:62 and :72). The binding is the factory's own
   * name, so the same map serves both import styles. */
  for (const m of src.matchAll(new RegExp(DYN_IMPORT.source, "g"))) imports.set(m[1], m[3]);
  const mine = wrapperByFile.get(f);
  for (const m of src.matchAll(/\.\.\.\(?\s*(?:[A-Za-z_$][\w$]*\s*\?\s*)?([A-Za-z_$][\w$]*)\s*\(/g)) {
    const rel = imports.get(m[1]);
    if (!rel || !rel.startsWith(".")) continue;
    const target = path.posix.join(path.posix.dirname(f), rel.replace(/^\.\//, "")).replace(/\\/g, "/");
    const childTable = wrapperByFile.get(target);
    if (!childTable) continue;
    const args = src.slice(m.index + m[0].length - 1, balanced(src, m.index + m[0].length - 1));
    for (const [name, v] of mine) {
      if (!new RegExp(`\\b${name}\\b`).test(args)) continue;
      if (!childTable.has(name)) childTable.set(name, v);
    }
  }
}

/* What one tool posts. `unwrappedRun` is mcp-vfx.js's own hook for this: it
 * replaces every slug-bearing tool's run with a revision-scoped closure and
 * parks the original there, commented "audit tools inspect BOTH forwarding
 * layers". Reading the wrapper instead would report 33 vfx tools as silent. */
function callsOf(tool) {
  /* Comments blanked here too. score_render's run() now carries a paragraph
   * explaining that it used to post `{ action: "render" }` to the wrong door,
   * and a scan that reads comments would take that sentence for a call. */
  const src = blankComments(
    [String(tool.run), tool.run?.unwrappedRun ? String(tool.run.unwrappedRun) : ""].join("\n"));
  const file = ownerOf.get(tool.name);
  const table = (file && wrapperByFile.get(file)) || new Map();
  const calls = [];
  const at = (openParen) => {
    const args = src.slice(openParen, balanced(src, openParen));
    return { args, actions: [...new Set([...args.matchAll(new RegExp(ACTION_LIT.source, "g"))].map((x) => x[2]))] };
  };
  for (const m of src.matchAll(new RegExp(API_LIT.source, "g"))) {
    const open = src.indexOf("(", m.index);
    calls.push({ method: m[2], path: m[4], ...at(open), via: "api" });
  }
  for (const [name, v] of table) {
    if (name === "api") continue;
    const re = new RegExp(`\\b${name}\\s*\\(`, "g");
    let mm;
    while ((mm = re.exec(src))) {
      const open = mm.index + mm[0].length - 1;
      const { args, actions } = at(open);
      for (const r of v.routes) {
        /* A wrapper whose path came from its own argument (`const get = (p) =>
         * api("GET", p)`) takes the literal head of what the tool passed it. */
        let p = r.path;
        if (r.fromArg) {
          const lit = args.match(/^\(\s*(["'`])([^"'`$]*)/);
          if (!lit) continue;
          p = lit[2];
        }
        calls.push({ method: r.method, path: p, args, actions, via: name });
      }
    }
  }

  /* A literal path often carries the query string with it
   * (`/api/gallery?kind=${...}`). The door is the pathname. */
  for (const c of calls) if (c.path) c.path = c.path.split("?")[0];

  /* THE ENUM IS THE ACTION SET, but only for a tool with ONE door. Four tools
   * forward their own `action` argument rather than naming a literal, and all
   * four declare it as an enum — so the enum is exactly what can arrive at the
   * door and every value of it is checkable. The one-door condition is not
   * fussiness: prompt_gallery declares ["list","save","delete"] and sends
   * "list" down a GET instead, so judging its enum against the POST door would
   * report a working tool as dead. */
  const enumOf = (prop) => {
    const s = tool.inputSchema?.properties?.[prop];
    return Array.isArray(s?.enum) ? s.enum : null;
  };
  if (calls.length === 1 && !calls[0].actions.length) {
    const c = calls[0];
    const plain = c.args.match(/\baction\s*:\s*(?:a|args)\.([A-Za-z_$][\w$]*)/);
    /* And the one template form: `action: ` + backtick + `render_${a.action}` —
     * a fixed head in front of the same enum, which is still a closed set. */
    const tpl = c.args.match(/\baction\s*:\s*`([A-Za-z0-9_]*)\$\{\s*(?:a|args)\.([A-Za-z_$][\w$]*)\s*\}`/);
    const src2 = tpl ? enumOf(tpl[2]) : plain ? enumOf(plain[1]) : null;
    if (src2) {
      c.actions = src2.map((v) => (tpl ? tpl[1] + v : v));
      c.fromEnum = true;
    }
  }
  return { calls, hasSource: !!file };
}

/* ──────────────────────────────────────────────────────────────────────────
 * PART 3 — the assertions.
 * ────────────────────────────────────────────────────────────────────────── */

console.log("\nTHE DOOR CENSUS — the route and the action, from both ends");

ok(`the route source was read (${routeSource.size} files, ${exactPaths.size} paths)`,
  exactPaths.size > 100, "if this is small the path scan is broken and every assertion below is vacuous");
ok(`the doors that dispatch on an action were found (${actionsByPath.size})`,
  actionsByPath.size > 20, "if this is small the action scan is broken and the action assertion is vacuous");
ok("a known door's known action list is intact (/api/score)",
  actionsByPath.get("/api/score")?.has("to_daw") && actionsByPath.get("/api/score")?.has("draft"),
  "the /api/score switch did not parse — every /api/score verdict below is worthless");

/* THE PARSER'S OWN PIN. A door that answers "Unknown action" dispatches on the
 * word by its own admission; if this file found none for it, the action check
 * is silently skipped for every tool that posts there. */
const silentDoors = [...claimsActions].filter((p) => !actionsByPath.get(p)?.size);
ok(`every door that answers "Unknown action" had its actions read (${claimsActions.size} such doors)`,
  silentDoors.length === 0,
  `these say they dispatch on an action and this lane found none:\n          ${silentDoors.join("\n          ")}`
  + "\n          The dispatch shape is one the scan above does not recognise. Teach it the shape —"
  + "\n          do NOT exempt the door, because the tools posting there are the ones going unchecked.");

/* Every registered tool is owned by a file this lane reads. A tool defined in a
 * file missing from MCP_FILES would be counted as "posts nothing" and quietly
 * pass, which is the census failure this whole file exists to refuse. */
const unowned = TOOLS.filter((t) => !ownerOf.has(t.name) && !(t.name in UNREADABLE)).map((t) => t.name);
ok(`every tool is defined in a file this lane reads (${TOOLS.length} tools)`, unowned.length === 0,
  `not found in any of MCP_FILES: ${unowned.join(", ")}\n          `
  + "Add the file to MCP_FILES, or name the tool in UNREADABLE with the reason.");

const analysed = [];
const local = [];
const unreadable = [];
for (const t of TOOLS) {
  if (t.name in UNREADABLE) { unreadable.push(t.name); continue; }
  const { calls } = callsOf(t);
  if (!calls.length) {
    /* A tool with no HTTP call at all is answering out of its own module —
     * pipeline_guide reads a table of strings. Nothing to check, and nothing
     * hidden: it is counted and named in the coverage line. */
    local.push(t.name);
    continue;
  }
  analysed.push({ name: t.name, calls });
}

console.log(`\n  -- coverage: ${TOOLS.length} tools --`);
console.log(`     ${analysed.length} analysed (a route literal was resolved)`);
console.log(`     ${local.length} answer locally and post nothing: ${local.join(", ") || "none"}`);
console.log(`     ${unreadable.length} exempted in UNREADABLE: ${unreadable.join(", ") || "none"}`);

ok("the exemption list is short — it is a confession, not a lid",
  unreadable.length <= 6, `${unreadable.length} exemptions; if this is growing the parser is losing, not the codebase changing`);
const declared = { ...UNREADABLE, ...ANSWERS_LOCALLY };
const ghosts = Object.keys(declared).filter((n) => !TOOLS.some((t) => t.name === n));
ok("every exemption names a tool that exists", ghosts.length === 0,
  `exempted and not registered: ${ghosts.join(", ")}`);
const thin = Object.entries(declared).filter(([, why]) => !why || why.length < 40);
ok("every exemption gives a real reason", thin.length === 0, thin.map(([n]) => n).join(", "));

/* THE COVERAGE PIN. "Posts nothing" is indistinguishable from "this lane could
 * not see what it posts", so every silent tool has to be declared. Without
 * this, a broken resolver reads as a catalogue of local tools and the run
 * stays green. */
const undeclaredLocal = local.filter((n) => !(n in ANSWERS_LOCALLY));
ok(`every tool that posts nothing is declared as a local one (${local.length})`,
  undeclaredLocal.length === 0,
  `${undeclaredLocal.length} tool(s) make no HTTP call and are not in ANSWERS_LOCALLY:\n          `
  + undeclaredLocal.join(", ")
  + "\n\n          Either the tool really answers out of its own module — say so in ANSWERS_LOCALLY"
  + "\n          with the reason — or the resolver above stopped finding its door, which is the"
  + "\n          same as not checking it.");

console.log("\n  -- every route a tool posts to exists in the server source --");

const servesPath = (p) => {
  if (exactPaths.has(p)) return true;
  for (const pre of prefixPaths) if (p.startsWith(pre)) return true;
  /* A template head like "/api/daw/project/" is served by the prefix guard
   * "/api/daw/" as well as by its own; either is a real door. */
  for (const pre of prefixPaths) if (pre.startsWith(p) && p.endsWith("/")) return true;
  return false;
};

const deadRoutes = [];
for (const t of analysed) {
  for (const c of t.calls) {
    if (!c.path || !c.path.startsWith("/api/")) continue;
    if (!servesPath(c.path)) deadRoutes.push(`${t.name} -> ${c.method} ${c.path}`);
  }
}
ok("no tool posts to a route that is not served", deadRoutes.length === 0,
  deadRoutes.join("\n          "));

console.log("\n  -- every action a tool posts is one its door handles --");

const deadActions = [];
const unresolvedActions = [];
let judged = 0;
const toolsJudged = new Set();
for (const t of analysed) {
  for (const c of t.calls) {
    if (!c.path || !actionsByPath.has(c.path)) continue;   // not an action-dispatched door
    const known = actionsByPath.get(c.path);
    if (c.actions.length) { judged += c.actions.length; toolsJudged.add(t.name); }
    if (!c.actions.length) {
      /* The door dispatches on `action` and this call site names none at a
       * literal — either it builds the body elsewhere or it forwards the
       * caller's own word. Counted and printed, never silently passed. */
      if (/\baction\b/.test(c.args)) unresolvedActions.push(`${t.name} -> ${c.path} (action is not a literal here)`);
      continue;
    }
    for (const a of c.actions) {
      if (!known.has(a)) {
        deadActions.push(
          `${t.name} posts { action: "${a}" }${c.fromEnum ? " (one of its declared enum values)" : ""} `
          + `to ${c.method} ${c.path}\n              `
          + `that door handles ${known.size}: ${[...known].sort().join(", ")}`);
      }
    }
  }
}
ok(`no tool posts an action its door does not handle (${unresolvedActions.length} call sites build the action dynamically and were not judged)`,
  deadActions.length === 0,
  deadActions.length
    ? deadActions.join("\n          ")
      + "\n\n          Each of these answers \"Unknown action\" for every input. Fix the action, point"
      + "\n          the tool at the door that has the capability, or remove the tool."
    : "");

/* AND HOW MANY WORDS WERE ACTUALLY WEIGHED. The assertion above passes just as
 * loudly on zero comparisons as on three hundred, so the count is a lane of its
 * own: a resolver that quietly stops matching anything reads as a clean run
 * otherwise. The floor is well under today's number — it is there to catch a
 * collapse, not to freeze the catalogue. */
console.log(`\n     ${judged} posted actions weighed against their door, across ${toolsJudged.size} tools`);
ok(`the action check actually compared something (${judged} posted actions, ${toolsJudged.size} tools)`,
  judged >= 150 && toolsJudged.size >= 120,
  "the action scan has collapsed: it is passing because it is comparing nothing");

if (unresolvedActions.length) {
  console.log(`\n     not judged (${unresolvedActions.length}):`);
  for (const u of unresolvedActions) console.log(`       ${u}`);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
