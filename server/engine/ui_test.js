/**
 * THE ENGINE DOOR'S GATE — the bypass census, and the parity census.
 *
 * ── WHAT THIS FILE IS FOR, IN ONE PARAGRAPH ───────────────────────────────
 *
 * On 2026-09-02 the rig's output folder held 426 files written since the
 * previous noon. 424 of them had no ledger entry of any kind. Not because the
 * ledger failed — because three harnesses in the other repo posted straight at
 * `http://127.0.0.1:8266/prompt`, which is a constant somebody once copied and
 * everybody since has copied from them. Eighty-five of those files landed in
 * `clips/`, the exact folder `/api/clips` scans, so the app LISTED them and
 * could say nothing whatever about them: no model, no prompt, no seed, no
 * elapsed, no actor.
 *
 * `server/engine/client.js` is now the only thing in this tree that knows where
 * the engine is. That sentence is not a convention — a convention survives
 * about a fortnight — so this file makes it a build failure. Every file in
 * `server/`, `web/` and `scripts/` that is not the client is read, and naming
 * the port, the old constant, `comfy.base`, or fetching one of the engine's own
 * routes fails the commit.
 *
 * ── TWO TABLES, AND THEY MEAN DIFFERENT THINGS ────────────────────────────
 *
 * `ALLOWED` is permanent and principled: the client itself, the two suites that
 * carry the patterns in order to check for them, the SECOND engine (8288,
 * user-installed, its own door a named follow-up), and the adoption-guard test
 * that has to be able to bind a port to stage the collision it proves.
 *
 * `NOT_YET` is a DEBT LIST with names on it. Every entry is a file that still
 * bypasses, is owned by a strand that was live while this pass ran, and has a
 * one-line fix written beside it. It is not an exemption: a hit in a file in
 * NEITHER table fails immediately, an entry that stops matching fails (so
 * closing a bypass FORCES its line to be deleted), and the count is pinned, so
 * the list can only ever get shorter. Run with `AIPLAY_ENGINE_GATE_STRICT=1`
 * and the debt is fatal too — which is what the day this pass finishes looks
 * like.
 *
 * ── WHY A CENSUS AND NOT A CODE REVIEW ────────────────────────────────────
 *
 * Because the bypass is not written by a stranger. It is written by whoever is
 * here at 2 a.m. with a script from the other repo that used to work, and the
 * only thing that stops that person is a commit that will not go through.
 * ComfyUI ships no authentication of any kind (docs/ENGINE_DOOR.md §"what
 * ComfyUI can and cannot do"), so an unpublished port plus this file is the
 * whole of the enforcement, and the residual — a determined local process can
 * still find the port with `netstat` — is stated out loud rather than implied.
 *
 * ── AND THE PARITY CENSUS ─────────────────────────────────────────────────
 *
 * The same bargain every other surface in this repo holds: everything is
 * MCP-controllable AND completely human-adjustable, one route behind both. The
 * engine surface shipped with NO exemptions in either direction, and there is a
 * check below asserting the exemption tables are empty — because the day one
 * earns its place, somebody has to write the reason down.
 *
 * Runs standalone (`node server/engine/ui_test.js`) and in the pre-commit hook.
 * Reads the tree and touches nothing.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
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
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join("/");

/* CODE ONLY, not the prose around it.
 *
 * Same helper and the same argument as `server/videolab/ui_test.js`: the first
 * version of that gate failed on a comment EXPLAINING why a literal had been
 * removed, which is a check punishing the documentation of its own finding and
 * the fastest way to teach somebody to stop writing comments. Prose about the
 * port is fine — this file's own header is full of it. What matters is whether
 * a file ACTS on the port.
 *
 * `//` is only a comment when it is not preceded by a colon, so `http://` and
 * `/api/…` survive. */
const codeOf = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/* ══════════════════════════════════════════════════════════════════════════
 * A. THE BYPASS CENSUS
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n  -- A. the bypass census: one file knows where the engine is --");

/**
 * The patterns, each with the way it is actually written when somebody
 * bypasses. They are kept in a table rather than inline because the SELF-TEST
 * at the end of this section runs them over synthetic sources — a census whose
 * patterns have quietly stopped matching passes everything, and that is the one
 * failure mode a gate cannot report on itself.
 */
const PATTERNS = [
  {
    id: "config.comfy.port/host",
    hit: (code) => /\bconfig\.comfy\.(port|host)\b/.test(code),
    plant: "const base = `http://${config.comfy.host}:${config.comfy.port}`;",
    why: "the address built out of config, which is how every caller in this tree used to do it",
  },
  {
    id: "8266",
    hit: (code) => /\b8266\b/.test(code),
    plant: 'const BASE = "http://127.0.0.1:8266";',
    why: "the constant itself. It appeared verbatim in fifteen scripts here and three in the "
      + "other repo, and copying it is how the bypass reproduces",
  },
  {
    id: "comfy.base",
    hit: (code) => /\bcomfy\.base\b/.test(code),
    plant: "const r = await fetch(comfy.base + \"/history/\" + id);",
    why: "the supervisor's old accessor. It is deleted; naming it is a merge that went backwards",
  },
  {
    id: "fetch near an engine route",
    hit: (code) => nearFetch(code).length > 0,
    plant: 'await fetch(`${b}/prompt`, { method: "POST" });',
    why: "the wire call itself, wherever the address came from",
  },
  {
    id: "ws:// that is not the app's own /live",
    hit: (code) => engineSockets(code).length > 0,
    plant: 'new WebSocket(`ws://127.0.0.1:${port}/ws?clientId=${id}`);',
    why: "ComfyUI's progress socket. The app's own socket is /live and is exempt by its PATH, "
      + "not by the name of the file it is in",
  },
];

/**
 * A `fetch(` within 200 characters of one of the engine's own routes.
 *
 * ⚠ `[A-Za-z]*[Ff]etch\s*\(` and not `\bfetch\s*\(`. An injected `doFetch(` is
 * still a fetch, and `client.js` — the one file where getting this wrong would
 * matter most — calls its transport exactly that. A census written the narrow
 * way returns -1 on that file and passes vacuously, which happened while this
 * subsystem was being built and was caught by accident.
 *
 * ⚠ `/prompt` is matched with a LOOK-AHEAD. `web/app.js` fetches `/api/prompts`
 * (the prompt-template library) and `/api/prompt/preview` (the cost estimate),
 * three sites between them, and a plain substring scores all three as bypasses.
 * A census that over-reads invents gaps; the cure for an invented gap is
 * usually an exemption, and an exemption is how a gate goes soft. The engine's
 * route is `/prompt` at the END of a path.
 */
const ROUTE_RES = [
  /\/prompt(?=["'`?\s)])/,
  /\/history(?=["'`?/\s)])/,
  /\/object_info(?=["'`?/\s)])/,
  /\/system_stats(?=["'`?\s)])/,
  /\/interrupt(?=["'`?\s)])/,
  /\/queue(?=["'`?\s)])/,
  /\/free(?=["'`?\s)])/,
];
function nearFetch(code) {
  const out = [];
  for (const m of code.matchAll(/[A-Za-z]*[Ff]etch\s*\(/g)) {
    const window = code.slice(m.index, m.index + 200);
    for (const re of ROUTE_RES) {
      const r = window.match(re);
      if (r) out.push(`${m[0]}…${r[0]}`);
    }
  }
  return out;
}

/**
 * A `ws://` that is not the application's own live socket.
 *
 * Exempt by PATH and not by filename, which is the rule the spec asks for: the
 * app's socket is `/live`, ComfyUI's is `/ws`. `scripts/e2e_dawui.mjs` opens
 * `ws://127.0.0.1:${PORT}/live` from node, where `location` cannot exist, so a
 * rule written as "unless it contains location.host" would flag the app talking
 * to itself.
 */
function engineSockets(code) {
  return [...code.matchAll(/ws:\/\/[^\s"'`]*/g)]
    .map((m) => m[0])
    .filter((u) => !u.includes("location.host") && !/\/live\b/.test(u));
}

/** Every file the census governs. Never node_modules, never .md — prose about
 *  the port is fine and a gate that punishes its own documentation teaches
 *  people to stop writing it. */
function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(f);
  }
  return out;
}
const SCANNED = [
  ...walk(path.join(ROOT, "server"), [".js"]),
  ...walk(path.join(ROOT, "web"), [".js"]),
  ...walk(path.join(ROOT, "scripts"), [".mjs"]),
].map(rel).sort();

ok(`the census reads the tree at all (${SCANNED.length} files)`,
  SCANNED.length >= 150
    && SCANNED.includes("server/engine/client.js")
    && SCANNED.includes("web/app.js")
    && SCANNED.includes("scripts/ltx_smoke.mjs"),
  "a walk that finds nothing passes everything — this is the check that the "
  + "check is looking somewhere");

/**
 * PERMANENT, and each entry has to earn itself twice: the file must exist, and
 * it must STILL MATCH one of the patterns. An exemption for a file that no
 * longer bypasses is a line nobody will ever delete, and the next person reads
 * it as permission.
 */
const ALLOWED = {
  "server/engine/client.js":
    "THE CLIENT. The only file in this tree allowed to know the port, hold the socket, or name "
    + "an engine route. Everything else in the application reaches ComfyUI through dispatch().",
  "server/engine/client_test.js":
    "It contains the patterns in order to check for them: the source-order proof reads /prompt "
    + "out of client.js by index, and the pinned-port case names 8266 because that is the number "
    + "an install that pinned it actually has.",
  "server/engine/ui_test.js":
    "This file. It carries every pattern as a literal, and plants each one into a synthetic "
    + "source below to prove the pattern still has teeth.",
  "scripts/test_matrixfix.mjs":
    "Stands up a FAKE ComfyUI on a pinned port to prove the adoption guard refuses it rather "
    + "than adopting somebody else's engine. It has to be able to bind a port and to name the "
    + "patterns it asserts comfy.js no longer contains.",
  "scripts/control_route_proof.mjs":
    "Stands up a FAKE ComfyUI as an injected `fetch` — createEngineClient({fetch}) — to prove "
    + "one control render end to end over real HTTP: the gate refuses a 96-frame clip and "
    + "leaves NO engine record, and a legal one leaves an engine/<runId> whose references "
    + "carry the SOURCE CLIP'S OWN SHA-256. It names the engine's routes because it is "
    + "PRETENDING to be the engine, and it never speaks to a real one: scratch AIPLAY_APPDATA, "
    + "scratch rig, scratch output, and the client it builds is handed that fetch rather than "
    + "a socket. Same class as test_matrixfix.mjs above, and the same argument — a proof that "
    + "stubbed dispatch would be a proof about a stub.",
};

/**
 * THE DEBT. Not exemptions — bypasses that are still open, each owned by a
 * strand that was live while this pass ran, each with the one-line fix.
 *
 * The rules that keep this a list and not a loophole:
 *   · a hit in a file in NEITHER table fails the build immediately;
 *   · an entry that no longer matches fails, so closing a bypass FORCES the
 *     line to be deleted rather than leaving permission behind;
 *   · EACH ENTRY PINS EXACTLY WHICH PATTERNS IT MATCHES. This is the one that
 *     closes the table's own loophole. Without it, an excused file is an open
 *     door: somebody adds a fresh `fetch(`${BASE}/prompt`)` to control.js — a
 *     file already forgiven for naming config.comfy.port — and no commit ever
 *     fails. The entry has to say what it is forgiven FOR;
 *   · the count is pinned below, so this list can only ever get shorter;
 *   · AIPLAY_ENGINE_GATE_STRICT=1 makes every one of them fatal, which is what
 *     the day the last one closes looks like.
 */
const NOT_YET = {
  /* EMPTY, AND IT EMPTIED ITSELF — which is exactly what this table is for.
   *
   * It held five entries in two days and every one of them left with its
   * bypass rather than with an edit to its excuse:
   *
   *   server/config.js            `port: Number(env || 8266)` became
   *                               `pinnedPort: … : null`, so a pin can be told
   *                               from a default.
   *   server/control/control.js   the private engine client whose own header
   *                               called itself "the leftover" — deleted whole,
   *                               along with `extractPose`, the caller that made
   *                               it necessary. That directory now builds graphs
   *                               and validates clips and reaches nothing.
   *   server/control/pose.js      `POSE_GATE.engine = "127.0.0.1:8266"` was a
   *                               RECORD of where the 2026-09-03 gate ran, not a
   *                               call — and still a copyable constant sitting in
   *                               a data structure, which is how the other fifteen
   *                               copies started. It is `engine_run: null` now,
   *                               with the honest sentence that the gate predates
   *                               the door and has no runId to give.
   *   pose_test.js, vace_test.js  `fetch(`${engineBase()}/object_info`)`. The fix
   *                               was the one docs/ENGINE_DOOR.md wrote down: ask
   *                               the APP, `POST {action:"object_info"}` with an
   *                               actor header. Better than deleting them — the
   *                               probes had been silently skipping since the door
   *                               landed, and they now RUN: measured 2026-09-03,
   *                               pose_test 54 -> 57 assertions and vace_test 45 ->
   *                               48, the three extra in each being the live checks
   *                               coming back to life. server/control/live_test_lib.js
   *                               is the one copy of that question.
   *
   * An entry here is a to-do with a name on it, never an exemption. DEBT_BUDGET
   * is 0 below and may never be raised.
   */
};

/** The reason each one is still open, and the one-line fix. Separate from the
 *  pattern pin above so neither can be edited without noticing the other.
 *  Empty, because NOT_YET is: the two are checked against each other below. */
const NOT_YET_WHY = {};
/** How many files may still bypass. It may go DOWN and never up. */
const DEBT_BUDGET = 0;
const STRICT = process.env.AIPLAY_ENGINE_GATE_STRICT === "1";

const hits = new Map();
for (const f of SCANNED) {
  const code = codeOf(read(f));
  const why = PATTERNS.filter((p) => p.hit(code)).map((p) => p.id);
  if (why.length) hits.set(f, why);
}

const unexpected = [...hits.keys()].filter((f) => !(f in ALLOWED) && !(f in NOT_YET));
ok(`no file outside the client module reaches the engine (${hits.size} named, ${unexpected.length} unnamed)`,
  unexpected.length === 0,
  unexpected.map((f) => `${f} — ${hits.get(f).join(", ")}`).join("\n          ")
  + "\n          Route it through server/engine/client.js. Nothing in this application may "
  + "construct an engine URL; dispatch() records the request BEFORE the GPU spends a "
  + "millisecond, and a caller that goes around it is a render that does not exist.");

const staleAllowed = Object.keys(ALLOWED).filter((f) => !hits.has(f));
ok("every permanent exemption is still a file that really bypasses",
  staleAllowed.length === 0,
  staleAllowed.join(", ") + " — no longer matches any pattern. Delete the entry; an exemption "
  + "nobody can trace back to a real line is read as permission by the next person.");

const widened = Object.keys(NOT_YET).filter((f) => {
  const got = (hits.get(f) || []).slice().sort().join("|");
  return got && got !== NOT_YET[f].slice().sort().join("|");
});
ok("no excused file has grown a NEW kind of bypass",
  widened.length === 0,
  widened.map((f) => `${f} — forgiven for [${NOT_YET[f].join(", ")}], now matches [${(hits.get(f) || []).join(", ")}]`)
    .join("\n          ")
  + "\n          A debt entry forgives one named thing. A file on this list that starts fetching "
  + "/prompt as well is a fresh bypass hiding behind an old apology.");

const undescribed = Object.keys(NOT_YET).filter((f) => !NOT_YET_WHY[f]);
ok("every debt entry says why and how to close it", undescribed.length === 0,
  undescribed.join(", ") + " — a to-do with no owner and no fix is an exemption wearing a "
  + "different hat");

const staleDebt = Object.keys(NOT_YET).filter((f) => !hits.has(f));
ok("every debt entry is still a bypass that is really open",
  staleDebt.length === 0,
  staleDebt.join(", ") + " — closed. Delete the line: that is what the list is FOR.");

const missingFiles = [...Object.keys(ALLOWED), ...Object.keys(NOT_YET)]
  .filter((f) => !existsSync(path.join(ROOT, f)));
ok("every named file is in the repository", missingFiles.length === 0, missingFiles.join(", "));

const debtOpen = Object.keys(NOT_YET).filter((f) => hits.has(f));
ok(`the debt list is not growing (${debtOpen.length} of ${DEBT_BUDGET} allowed)`,
  debtOpen.length <= DEBT_BUDGET,
  "lower DEBT_BUDGET when one closes; it may never be raised");

if (STRICT) {
  ok("STRICT: nothing in the tree bypasses at all",
    debtOpen.length === 0,
    debtOpen.map((f) => `${f} — ${hits.get(f).join(", ")}`).join("\n          "));
} else if (debtOpen.length) {
  console.log(`\n        ${debtOpen.length} FILES STILL BYPASS THE DOOR. Not failures here — each is`);
  console.log("        owned by a strand that was live while this pass ran — but every one of them");
  console.log("        is a render that will not be in the ledger. AIPLAY_ENGINE_GATE_STRICT=1");
  console.log("        makes them fatal.\n");
  for (const f of debtOpen) console.log(`          ${f}  [${hits.get(f).join(", ")}]\n            ${NOT_YET_WHY[f]}\n`);
}

/* ── the patterns still have teeth ────────────────────────────────────────
 *
 * The one thing a census cannot report about itself. A regex that has quietly
 * stopped matching — a rename, an escaping mistake, a look-ahead that got too
 * clever — passes every file in the tree and reports a clean bill of health,
 * which is the most expensive way for this file to fail. So each pattern is run
 * against the line somebody actually writes when they bypass, and against a
 * line that must NOT trip it. */
console.log("\n  -- ...and the patterns can still see a bypass when there is one --");
for (const p of PATTERNS) {
  ok(`plant "${p.id}" and the census catches it`, p.hit(p.plant), `${p.plant}\n          ${p.why}`);
}
const INNOCENT = [
  ['the prompt-template library', 'const rows = await fetch("/api/prompts").then((r) => r.json());'],
  ['the cost estimate', 'await fetch("/api/prompt/preview", { method: "POST" });'],
  ["the app's own live socket from node", 'const ws = new WebSocket(`ws://127.0.0.1:${PORT}/live`);'],
  ["the app's own live socket from a page", 'new WebSocket(`ws://${location.host}/live`);'],
  ["the door itself", 'await fetch(`${APP}/api/engine`, { headers: { "x-aiplay-actor": "script:x" } });'],
];
for (const [what, line] of INNOCENT) {
  ok(`...and does not flag ${what}`,
    !PATTERNS.some((p) => p.hit(line)), line
    + "\n          a census that over-reads invents gaps, and the cure for an invented gap is an "
    + "exemption — which is how a gate goes soft");
}

/* ── positive checks, which are stronger than exemptions ──────────────────── */
console.log("\n  -- the supervisor supervises, and nothing else --");

const COMFY = codeOf(read("server", "comfy.js"));
ok("server/comfy.js contains no fetch( at all",
  !/[A-Za-z]*[Ff]etch\s*\(/.test(COMFY),
  "base/submit/interrupt moved to engine/client.js. A supervisor spawns a child, reads its log "
  + "and knows when it died; the moment it also speaks HTTP there are two clients again.");
ok("...and names no address of its own",
  !/\bconfig\.comfy\.(port|host)\b/.test(COMFY) && !/\b8266\b/.test(COMFY) && !/127\.0\.0\.1:/.test(COMFY),
  "the port comes from engine.pinFromEnv() ?? engine.reservePort() at every start — including "
  + "the crash-restart path and setTier — so there is no number here to copy");
ok("...but it still attaches and detaches the child, which is the identity rule",
  /engine\.attachChild\(/.test(COMFY) && /engine\.detachChild\(/.test(COMFY),
  "isOurs() has to go false BEFORE anything downstream can be told the engine died, or a job "
  + "is posted at a port whose owner just exited");
/* THE SUBJECT IS `#portAnswers()`, NOT `probePort`, and that is not pedantry.
 * comfy.js keeps a named private method over the client's probe precisely so
 * `scripts/test_matrixfix.mjs` can pin "start() asks this question before it
 * spawns"; the DEFINITION of that method sits below spawn() in the file, so a
 * check written on `probePort` compares the wrong two indices and fails a
 * guard that is working. Read the CALL. */
ok("...and the adoption guard still asks before it spawns",
  COMFY.indexOf("await this.#portAnswers()") > 0
  && COMFY.indexOf("await this.#portAnswers()") < COMFY.indexOf("spawn("),
  `#portAnswers ${COMFY.indexOf("await this.#portAnswers()")}, spawn ${COMFY.indexOf("spawn(")}\n`
  + "          a live port belongs to somebody else's Studio, and adopting it renders into their "
  + "library — measured: our child died on the bind while the neighbour answered the poll, and "
  + "startup printed 'engine ready'");
ok("...through the client, so there is still only one thing that speaks to a port",
  /#portAnswers\(\)\s*\{\s*return engine\.probePort\(\);/.test(COMFY),
  "an inlined probe here would be a second HTTP call in the supervisor, which is the thing this "
  + "whole pass deleted");

console.log("\n  -- reactive.js is a recipe over our compositor, not an engine client --");
const REACTIVE = codeOf(read("server", "reactive.js"));
ok("server/reactive.js never names config.comfy.*",
  !/\bconfig\.comfy\b/.test(REACTIVE),
  "it used to be the client of a second, user-installed engine and was exempt by name; since "
  + "2026-09-18 it is a recipe that talks to /api/vfx and /api/image by loopback and to no "
  + "engine at all. The day it names ours it needs the door like everything else.");
ok("...and the change of role is written down where the old gap was",
  /reactive\.js/.test(read("docs", "ENGINE_DOOR.md")),
  "docs/ENGINE_DOOR.md must still name it, so the old exemption's history is not lost");

/* ── the harnesses ────────────────────────────────────────────────────────── */
console.log("\n  -- every harness goes through the door, and says who it is --");

const SCRIPTS = walk(path.join(ROOT, "scripts"), [".mjs"]).map(rel).sort();
/* ⚠ CODE, NOT PROSE — this was a raw substring over the whole file and it
 * counted two files that never post anywhere as harnesses that had forgotten
 * their actor. scripts/lib/doorpost.mjs is the shared transport; its docstring
 * explains at length what a `wait: true` call to /api/engine does, and saying so
 * made it a caller. scripts/doorpost_proof.mjs answers its own stub server and
 * mentions the route only to say it is deliberately NOT using that path.
 *
 * The census must be able to survive the tree DISCUSSING the door — the same
 * rule server/licence_test.js is built on, where a substring match for "bpy"
 * would fail on config.js's own explanation of why nothing imports it. Nothing
 * else is relaxed: the census still reaches every .mjs under scripts/,
 * subdirectories included, and still judges what the code does. */
const HARNESS = SCRIPTS.filter((f) => codeOf(read(f)).includes("/api/engine"));
ok(`the fork's render harnesses post to /api/engine (${HARNESS.length})`,
  HARNESS.length >= 16, HARNESS.join(", "));

const wrongActor = HARNESS.filter((f) => {
  const name = path.basename(f, ".mjs");
  return !new RegExp(`"x-aiplay-actor":\\s*"script:${name}"`).test(read(f));
});
ok("...each under its own name",
  wrongActor.length === 0,
  wrongActor.join(", ") + " — the actor must be script:<basename>. `script:` is a fourth actor "
  + "class precisely so the ledger can tell 'an LLM asked for this' from 'a harness ran a "
  + "hundred arms overnight', and a harness borrowing another's name destroys that.");

const notWaiting = HARNESS.filter((f) => !/action:\s*"prompt"/.test(read(f)));
ok("...and each posts the prompt action rather than inventing an envelope",
  notWaiting.length === 0, notWaiting.join(", "));

/* And the direction that matters more: a harness written TOMORROW against the
 * old constant fails here, not in six months when somebody counts the files in
 * the output folder. */
const strayScript = SCRIPTS.filter((f) => !(f in ALLOWED) && !HARNESS.includes(f)
  && PATTERNS.some((p) => p.hit(codeOf(read(f)))));
ok("no script in the tree reaches the engine any other way",
  strayScript.length === 0,
  strayScript.join(", ") + " — a harness that cannot find the app can no longer find the engine "
  + "either, and that refusal IS the enforcement");

/* ══════════════════════════════════════════════════════════════════════════
 * B. THE PARITY CENSUS
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n  -- B. one route behind both hands --");

const ROUTES = read("server", "engine", "routes.js");
const UI = read("web", "engine.js");
const MCP = read("server", "mcp-engine.js");
const UI_CODE = codeOf(UI);
const MCP_CODE = codeOf(MCP);
const HTML = read("web", "index.html");
const APP = read("web", "app.js");

const serverActions = [...new Set(
  [...ROUTES.matchAll(/^\s{6,}case "([a-z0-9_]+)":/gm)].map((m) => m[1]),
)].sort();
const uiActions = new Set([...UI_CODE.matchAll(/action:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));
const mcpActions = new Set([...MCP_CODE.matchAll(/action:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));

ok(`the census sees the dispatch at all (${serverActions.length} actions)`,
  serverActions.length >= 13, serverActions.join(", "));
ok(`...and the page's own posts (${uiActions.size})`, uiActions.size >= 13, [...uiActions].join(", "));
ok(`...and the tools' (${mcpActions.size})`, mcpActions.size >= 13, [...mcpActions].join(", "));

const orphanUi = [...uiActions].filter((a) => !serverActions.includes(a));
ok("every action the page posts is one the route dispatches", orphanUi.length === 0,
  orphanUi.join(", ") + " — posted by web/engine.js and dispatched by nothing");
const orphanMcp = [...mcpActions].filter((a) => !serverActions.includes(a));
ok("every action the tools post is one the route dispatches", orphanMcp.length === 0,
  orphanMcp.join(", ") + " — posted by server/mcp-engine.js and dispatched by nothing");

/**
 * Actions one hand cannot reach. Both tables are EMPTY and there is a check
 * below that says so, because this surface was designed for that: `clientId`,
 * `claim` and `via` are dispatch() options for internal callers and the route
 * never reads them, which is what lets every route parameter really be
 * reachable from both hands with no exemption at all.
 */
const NO_UI = {};
const HUMAN_DEFAULTS = {};

const agentOnly = serverActions.filter((a) => !uiActions.has(a) && !(a in NO_UI));
ok("every action the route dispatches is reachable from the page", agentOnly.length === 0,
  agentOnly.join(", ") + " — an agent can do it and a person cannot");
const humanOnly = serverActions.filter((a) => !mcpActions.has(a) && !(a in HUMAN_DEFAULTS));
ok("every action the route dispatches is reachable from MCP", humanOnly.length === 0,
  humanOnly.join(", ") + " — a person can do it and an agent cannot. `reveal` is the one that "
  + "argues for itself: an agent that wants the port and cannot ask for it does not stop "
  + "wanting it, it reads comfy.log — and that leaves no line in the ledger.");

ok("the engine surface ships with no exemptions at all",
  Object.keys(NO_UI).length === 0 && Object.keys(HUMAN_DEFAULTS).length === 0,
  "delete this line the day a default earns its place — and write the reason beside the entry");

/* ── parameters, which is where the action census lies ─────────────────────
 *
 * An action reachable from both hands is not the same as an action that DOES
 * THE SAME THING in both hands. `pollMs` is this surface's example: the door's
 * 3 s default is right for a 32-minute VACE pass and roughly doubles the wall
 * time of a 3-second cover, so a hand that cannot send it gets a measurably
 * different render for the same request. */
const CASE_BODY = new Map();
for (const m of ROUTES.matchAll(
  /^\s{6,}case "([a-z0-9_]+)":([\s\S]*?)(?=^\s{6,}(?:case "|default:))/gm)) {
  CASE_BODY.set(m[1], m[0]);
}
ok(`the parameter census can read every dispatch body (${CASE_BODY.size})`,
  CASE_BODY.size === serverActions.length,
  serverActions.filter((a) => !CASE_BODY.has(a)).join(", ")
  + " — a case sliced to nothing reads as a route with no parameters and passes every check "
  + "below; the last case in a switch is the classic one");

function routeParams(a) {
  const body = CASE_BODY.get(a) || "";
  const set = new Set([...body.matchAll(/\bb\.([A-Za-z_]\w*)/g)].map((m) => m[1]));
  set.delete("action");
  for (const m of body.matchAll(/\bb\.(\w+)\s*=[^=]/g)) set.delete(m[1]);
  return [...set].sort();
}

/** Every object literal carrying `action: "<a>"`, brace-matched rather than
 *  windowed — a fixed window both truncates a long body and swallows whatever
 *  object happens to follow a short one. */
function bodiesFor(src, a) {
  const out = [];
  for (let at = src.indexOf(`action: "${a}"`); at >= 0; at = src.indexOf(`action: "${a}"`, at + 1)) {
    const s = src.lastIndexOf("{", at);
    if (s < 0) continue;
    let d = 0, e = s;
    for (; e < src.length; e++) {
      if (src[e] === "{") d++;
      else if (src[e] === "}" && --d === 0) break;
    }
    out.push(src.slice(s, Math.min(e + 1, s + 4000)));
  }
  return out;
}

/** Keys at depth 0 of the posted literal, long form AND shorthand — shorthand
 *  is the normal way to write this and an extractor that cannot read it teaches
 *  people to write worse code to satisfy the gate. */
function sentKeys(src, a) {
  const out = new Set();
  for (const body of bodiesFor(src, a)) {
    let d = 0;
    for (let j = 0; j < body.length; j++) {
      const c = body[j];
      if (c === "{" || c === "[" || c === "(") d++;
      else if (c === "}" || c === "]" || c === ")") d--;
      else if (d === 1 && /[A-Za-z_]/.test(c) && !/[\w.$]/.test(body[j - 1] || " ")) {
        const k = body.slice(j).match(/^([A-Za-z_]\w*)\s*(:|,|\})/);
        if (k) out.add(k[1]);
      }
    }
  }
  out.delete("action");
  return out;
}
const uiSends = (a) => sentKeys(UI_CODE, a);
const mcpSends = (a) => sentKeys(MCP_CODE, a);

const PARAM_ACTIONS = serverActions.filter((a) => routeParams(a).length > 0);
const totalParams = PARAM_ACTIONS.reduce((n, a) => n + routeParams(a).length, 0);
ok(`the parameter census reads the route's fields (${PARAM_ACTIONS.length} actions, ${totalParams} parameters)`,
  PARAM_ACTIONS.length >= 8 && totalParams >= 20,
  PARAM_ACTIONS.map((a) => `${a}: ${routeParams(a).join(" ")}`).join("\n          "));

const paramGaps = [];
for (const a of PARAM_ACTIONS) {
  const ui = uiSends(a), mcp = mcpSends(a);
  for (const p of routeParams(a)) {
    if (!ui.has(p)) paramGaps.push(`${a}.${p} — the route reads it, the PAGE cannot send it`);
    if (!mcp.has(p)) paramGaps.push(`${a}.${p} — the route reads it, the TOOLS cannot send it`);
  }
}
ok("every field the route reads is reachable from both hands", paramGaps.length === 0,
  paramGaps.join("\n          ")
  + "\n          The same request must not mean two different renders depending on which hand "
  + "made it. There is no exemption table on this surface and the check above asserts there "
  + "is not one; close the gap instead.");

/* ── and the two options that must NOT be on this surface ────────────────── */
ok("the route never reads clientId or claim off the body, in any action",
  !/\bb\.(clientId|claim)\b/.test(ROUTES),
  "they are dispatch() options for INTERNAL callers — art.js registering the clip it is about "
  + "to rename, jobs.js watching its own socket — and neither means anything over HTTP. Keeping "
  + "them off this surface is exactly what lets the parameter census demand full parity with no "
  + "exemption table at all.");

/**
 * `actor` and `via` ARE read off the body — by `activity`, as FILTERS. Reading
 * a value to narrow a query is the opposite of letting a caller choose it, and
 * a check that could not tell those two apart would be demanding the panel lose
 * its "show me only the harness runs" box, which is one of the few controls
 * this whole subsystem exists to provide.
 *
 * So the rule is scoped to the place where choosing one WOULD be a lie: the run
 * itself. On a run, the actor comes from `prov.actorFrom(req)` — one rule for
 * the whole app, plus the refusal above — and `via` is stamped "api".
 */
const promptCase = CASE_BODY.get("prompt") || "";
const activityCase = CASE_BODY.get("activity") || "";
ok("...and a RUN takes neither its actor nor its `via` from the caller",
  /actor,\s*$/m.test(promptCase) && !/\bb\.actor\b/.test(promptCase)
  && /via:\s*"api"/.test(promptCase) && !/\bb\.via\b/.test(promptCase),
  "a body that could name its own actor would make the refusal above decorative, and a caller "
  + "that can spell its own `via` files a script's overnight sweep as art.cover — after which "
  + "the ledger's answer to 'which part of the app spent those 32 minutes' is fiction");
ok("...while `activity` may still filter by both",
  /\bb\.actor\b/.test(activityCase) && /\bb\.via\b/.test(activityCase),
  "reading a value to narrow a query is not the same as letting a caller choose it, and the "
  + "whole point of the four actor classes is being able to ask for one of them");

/* ══════════════════════════════════════════════════════════════════════════
 * C. THE DOOR'S OWN INVARIANTS, checkable without running it
 * ══════════════════════════════════════════════════════════════════════════ */

console.log("\n  -- C. the door refuses what it cannot attribute --");

const refusalAt = ROUTES.indexOf('x-aiplay-actor');
const bodyAt = ROUTES.indexOf("await readBody(req)");
ok("the actor refusal runs BEFORE the body is read",
  refusalAt > 0 && bodyAt > 0 && refusalAt < bodyAt,
  `refusal ${refusalAt}, readBody ${bodyAt} — a request nobody will own should not get as far `
  + "as being parsed, and a 400 that arrives after a 40 MB graph has been read is a 400 that "
  + "cost something");
ok("...and it is a refusal, not a downgrade to `system`",
  /json\(res,\s*400,\s*\{\s*error:\s*HELP_ACTOR\s*\}\)/.test(ROUTES),
  "filing an unattributed script run as `system` — which means 'the app did this on its own' — "
  + "is not a smaller lie than no record at all; it is a more convincing one");
ok("...and the message teaches both headers that work",
  /script:<name>/.test(ROUTES) && /agent:<name>/.test(ROUTES) && /Origin header/.test(ROUTES),
  "a refusal that does not say what would have worked is a wall");
ok("...and it will not invent an actor",
  /invent an actor for you/.test(ROUTES));
ok("a browser is recognised by an EXACT origin, not a prefix",
  /o === `http:\/\/127\.0\.0\.1:\$\{config\.uiPort\}`/.test(ROUTES)
  && /o === `http:\/\/localhost:\$\{config\.uiPort\}`/.test(ROUTES),
  "`http://127.0.0.1:41730`.startsWith(`http://127.0.0.1:4173`) is true, and that is a page on "
  + "another port passing as this app");
ok("the friendly /api/engine/prompt alias is one rewritten line, not a second dispatch",
  /if \(p === "\/api\/engine\/prompt"\) b\.action = "prompt";/.test(ROUTES),
  "a script author reading INSTALL.md should not have to learn an envelope — and one line here "
  + "means the parity census still sees exactly one dispatch");

console.log("\n  -- ...and the port is not part of the interface --");
ok("no route hands back an engine URL",
  !/base\(\)/.test(ROUTES) && !/http:\/\/127\.0\.0\.1:\$\{(?!config\.uiPort)/.test(ROUTES),
  "`base` is a module-private closure in client.js and is never exported. status() and "
  + "identity() report the MODE — ephemeral, pinned, revealed — and the number only when it is "
  + "already discoverable.");
const CLIENT = read("server", "engine", "client.js");
ok("...and the client does not export it either",
  !/export\s+(const|function)\s+base\b/.test(CLIENT) && !/\bbase,\s*$/m.test(CLIENT),
  "one exported accessor is all it would take for the census above to start passing while the "
  + "tree bypasses through a different name");
ok("web/engine.js contains no address of its own",
  !/127\.0\.0\.1:\d/.test(UI_CODE) && !/\b8266\b/.test(UI_CODE),
  "the panel reads the mode from the route; a page that knew the port would publish it to every "
  + "reader of view-source");

/* ── the panel is really mounted ──────────────────────────────────────────── */
console.log("\n  -- the panel exists, is reachable, and parses --");
ok("index.html has the rail entry", /data-view="engine"/.test(HTML));
ok("index.html has the panel", /id="engine"\s+hidden/.test(HTML));
ok("index.html loads the module", /src="engine\.js"/.test(HTML));
ok("index.html loads its stylesheet", /href="engine\.css"/.test(HTML));
ok("app.js switches the view", /\$\("engine"\)\.hidden = name !== "engine"/.test(APP),
  "a panel the rail cannot show is a surface nobody will find, and it passes every other check "
  + "in this file");
ok("the welcome catalogue describes it",
  /id: "engine"/.test(read("server", "welcome", "catalogue.js")),
  "server/welcome/ui_test.js requires a paragraph for every data-view; a tab with no explanation "
  + "fails there instead, which is a worse place to find out");
ok("web/engine.js is loaded by the parse gate",
  /engine\.js/.test(read("scripts", "trace_load.mjs")),
  "a self-mounting module whose parse failure the browser swallows is exactly what that gate is "
  + "for — the panel would simply not appear, with nothing in the console");

/* A backtick inside emitted markup ENDS the template literal it sits in, and
 * the most natural place to write one is an HTML comment explaining the markup.
 * `node --check` catches the resulting syntax error; this catches the HABIT. */
const htmlComments = (UI.match(/<!--/g) || []).length;
ok("no HTML comments inside the page's templates", htmlComments === 0,
  `${htmlComments} found — a backtick in one terminates the template literal it sits in`);

/* ── the tools an agent reads first ───────────────────────────────────────── */
console.log("\n  -- the map an agent reads before anything else --");
const GUIDE = read("server", "mcp-guide.js");
const toolNames = [...MCP.matchAll(/name:\s*"(engine_[a-z_]+)"/g)].map((m) => m[1]);
ok(`server/mcp-engine.js declares the engine tools (${toolNames.length})`, toolNames.length >= 10,
  toolNames.join(", "));
/**
 * THE GUIDE NAMES THE FAMILY AND THE TWO TOOLS THAT CARRY THE DESIGN — not all
 * eleven, and that is a decision rather than a shortfall.
 *
 * `pipeline_guide` is capped at 15,000 characters by `mcp-guide_test.js` and
 * currently sits at ~14,800. Eleven names and their sentences do not fit, and
 * the honest way to lose an argument with a cap is to say which sentence you
 * dropped. The two that stay are the two that change behaviour: `engine_run_graph`
 * because it is the ONLY way to the GPU, and `engine_activity` because it is the
 * whole record of what this machine rendered. The rest are reached by the family
 * pointer `engine_*` in the header, which is how `mv_*`, `vfx_*` and `image_*`
 * are already introduced, and by the tool list itself.
 *
 * The OTHER direction is the one that catches drift, and mcp-guide_test.js
 * already enforces it globally: every backticked name the guide utters must be a
 * live tool. Restated here scoped to this family so a rename of an engine tool
 * fails in this file too, next to the surface it belongs to.
 */
const LOAD_BEARING = ["engine_run_graph", "engine_activity"];
const missingKey = LOAD_BEARING.filter((t) => !GUIDE.includes(t));
ok("pipeline_guide names the two engine tools that change behaviour", missingKey.length === 0,
  missingKey.join(", ") + " — an agent that does not know engine_run_graph exists will look for "
  + "the port, and there isn't one");
ok("...and introduces the family the way it introduces every other",
  /engine_\*/.test(GUIDE),
  "`engine_* = the raw graph and the record of every render` in the header is what makes the "
  + "other nine discoverable without spending the cap on nine sentences");
const guideNames = [...new Set([...GUIDE.matchAll(/`(engine_[a-z_]+)`/g)].map((m) => m[1]))];
const ghosts = guideNames.filter((t) => !toolNames.includes(t));
ok(`every engine tool the guide names is a live tool (${guideNames.length} named)`,
  ghosts.length === 0,
  ghosts.join(", ") + " — the guide is the first thing an agent reads, and a name in it that "
  + "resolves to nothing costs a round trip and some trust");
ok("...and the door is described as the only way to the GPU",
  /no other way to the GPU/i.test(GUIDE),
  "the guide has to say the thing that is true, or an agent reasons about a port");
ok("...and mcp.js actually mounts them",
  /engineTools/.test(read("server", "mcp.js")),
  "a tool file nothing imports is a file that passes every test and reaches nobody");
ok("the run tool teaches the API-format distinction",
  /API FORMAT/i.test(MCP) && /Save \(API Format\)/.test(MCP),
  "ComfyUI's plain Save writes an editor document that /prompt cannot execute. The two files "
  + "look equally like JSON and fail very differently, and this is the single most common way a "
  + "hand-made graph fails.");
ok("...and states the cost rather than hiding it",
  /2259/.test(MCP) && /dry_run/.test(MCP),
  "a guided 1344x768 H3 clip measured 2259 s on this rig. An agent that is not told cannot "
  + "choose, and dry_run is the cheapest way to find out you were about to spend half an hour "
  + "on the wrong checkpoint.");

/* ── docs ─────────────────────────────────────────────────────────────────── */
console.log("\n  -- the documents that send people here --");
const INSTALL = read("INSTALL.md");
const APIMD = read("API.md");
ok("INSTALL.md says what AIPLAY_COMFY_PORT costs",
  /AIPLAY_COMFY_PORT/.test(INSTALL) && /ledger/.test(INSTALL.slice(INSTALL.indexOf("AIPLAY_COMFY_PORT"), INSTALL.indexOf("AIPLAY_COMFY_PORT") + 1400)),
  "it is a compatibility path with a named cost, not a recommended knob: on a pinned port "
  + "anything on this machine can drive the engine, and those renders will not be in the ledger");
ok("API.md documents /api/engine", /\/api\/engine/.test(APIMD));
ok("...and still says the port is not exposed",
  /expose the port/i.test(APIMD),
  "that sentence is now enforced by this file rather than promised");
ok("docs/ENGINE_DOOR.md exists and states the residual honestly",
  existsSync(path.join(ROOT, "docs", "ENGINE_DOOR.md"))
  && /netstat|no authentication/i.test(read("docs", "ENGINE_DOOR.md")),
  "an unpublished port is a boundary against accident and against our own code drifting, not "
  + "against a determined local process — said out loud so the decision is on the record");

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
