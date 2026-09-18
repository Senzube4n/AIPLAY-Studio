/**
 * THE ENGINE DOOR — the only file in this tree that knows where ComfyUI is.
 *
 * ── THE MEASUREMENT THIS EXISTS FOR ───────────────────────────────────────
 *
 * On 2026-09-02 the rig's output folder held 426 files written since noon the
 * previous day. 424 of them had no ledger entry of any kind: gate/ 135, film/
 * 70, vace/ 40, previz/ 34, mv/ 31, ressweep/ 15 — and 85 in `clips/`, which
 * the app ALREADY LISTS in its library and can say nothing whatsoever about.
 * No model, no prompt, no seed, no size, no elapsed time, no actor.
 *
 * They were not lost. They were rendered by three scripts in the other repo
 * that POST straight to `http://127.0.0.1:8266/prompt` — a constant copied into
 * fifteen more scripts here — write into this app's output folder, and never
 * open its ledger. The library was not missing the files; it was missing the
 * RECORD.
 *
 * ── WHAT THIS MODULE DOES ABOUT IT ────────────────────────────────────────
 *
 * 1. The port is EPHEMERAL. `reservePort()` binds :0 on loopback, reads the
 *    number the OS gave it, closes, and hands that to the supervisor for
 *    `--port`. A fresh one at every start, including crash-restart and tier
 *    change. A constant is a thing a script bakes in; a number that is
 *    different every run cannot be copied, and that is the only property that
 *    actually removes the temptation. It also makes the collision the owner has
 *    hit twice impossible rather than merely caught.
 *
 * 2. `base` is module-private and is NEVER exported, returned by a route, or
 *    logged. Everything else in the app calls the functions below.
 *
 * 3. `dispatch()` writes the record BEFORE it touches the engine, and a ledger
 *    failure costs the render. That inversion is the whole design — see the
 *    warning at the append itself.
 *
 * ── THE RESIDUAL, STATED RATHER THAN IMPLIED ──────────────────────────────
 *
 * ComfyUI ships no authentication of any kind: no token, no password, nothing
 * to configure. `--listen 127.0.0.1` means nothing OFF this machine can reach
 * it — real, and unchanged. But ON this machine, `Get-NetTCPConnection` finds
 * the port in one command and a curl to it renders. An unpublished port does
 * not change that; what it changes is that nothing can find it by GUESSING,
 * and guessing is exactly what a second copy of this app, a stale script with
 * 8266 baked in, or a person following an old note actually does.
 *
 * So this is a boundary against ACCIDENT and against our own code drifting,
 * not against a determined local process. The adversary is me, at 2 a.m., with
 * a script from the other repo — and against that adversary an unpublished port
 * plus a build-failing bypass census is decisive. Enforcement would need a
 * token-checking proxy (which on one machine just moves the obscurity down a
 * layer, since our own client must carry the token in a readable file) or an
 * OS rule scoped to a process (Windows Firewall does not filter loopback).
 * Neither is worth it today; both are named so nobody has to rediscover that.
 */
import { EventEmitter } from "node:events";
import net from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { config } from "../config.js";
import * as provenance from "../provenance.js";
import { TOOL, normalizeActor } from "../provenance.js";
import { buildRecord, graphProblems, sha256, sortedJSON } from "./record.js";
import { store as defaultStore } from "./store.js";
import { applyModelOverrides } from "../localmodels.js";

/**
 * ⚠ EVERY WAIT IN THE POLL LOOP IS BOUNDED, and these numbers are not fresh
 * ones. They are `scripts/gate_lib.mjs`'s, ported deliberately whole.
 *
 * That loop used to be a bare `for(;;)` whose only exits were "error" and
 * "completed", with `catch { continue; }` swallowing every fetch failure — no
 * deadline, no attempt counter, no AbortSignal. Measured against a stub: after
 * the server was killed, eight further polls over 25 s produced no output and
 * no exit, and a half-open TCP connection would have blocked indefinitely. The
 * failure that hits hardest is the one these renders themselves predict — a
 * hard CUDA OOM that takes the ComfyUI PROCESS with it, leaving an overnight
 * run frozen forever. Silence must never be the symptom.
 *
 * Two copies of a hardened thing decay into one hardened thing and one that
 * looks like it, so this is the copy and gate_lib's becomes a caller.
 */
export const POLL = Object.freeze({
  /** ⚠ THE DEADLINE IS MEASURED FROM THE MOMENT THE ENGINE STARTS THE JOB, not
   *  from the moment it was queued — see watch(). Time spent waiting behind
   *  another render is reported (`queuedSec`) and spends none of this. */
  JOB_DEADLINE_MS: 30 * 60 * 1000,
  POLL_MS: 3000,
  POST_TIMEOUT_MS: 60_000,
  POLL_TIMEOUT_MS: 15_000,
  MAX_CONSECUTIVE_POLL_FAILURES: 8,   // ~24 s of a server that stopped answering
  MAX_VANISHED_POLLS: 3,              // not in /history AND not in /queue
});

/** Sortable and collision-safe: milliseconds in base36, then three random
 *  bytes. Longer than the spec's eight characters on purpose — this id is a
 *  permanent key in a hash chain, and an id that sorts by time is worth more
 *  than an id that is short. */
const newRunId = () => `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The interface the engine binds, and the only place in the tree that says so.
 *
 * Loopback: nothing OFF this machine can reach the engine. That is real, and it
 * is unchanged from before this module existed. It lives HERE rather than in
 * `config.comfy.host` because the supervisor passing `--listen` and this file
 * building `http://…` must agree BY CONSTRUCTION, not because two settings
 * happen to match — and because "where the engine is" is precisely the fact
 * this module exists to own. The census in `ui_test.js` bans
 * `config.comfy.host` everywhere else, which is the same rule said as a build
 * failure.
 */
export const LISTEN_HOST = "127.0.0.1";

/**
 * @param {object} deps  injection points, and only these. `provenance`, `fetch`
 *   and `store` exist so `client_test.js` can prove the ledger-before-POST rule
 *   at RUNTIME rather than by reading the source: it hands in a ledger that
 *   throws and a fetch that records, and asserts the fetch was never called.
 *   A proof that can only be made by grepping is a proof about a file, not
 *   about a program.
 */
export function createEngineClient(deps = {}) {
  const prov = deps.provenance ?? provenance;
  const doFetch = deps.fetch ?? ((...a) => globalThis.fetch(...a));
  const store = deps.store ?? defaultStore;
  const poll = { ...POLL, ...(deps.poll || {}) };
  const Socket = deps.WebSocket ?? WebSocket;

  /**
   * WHO FILES AN OUTPUT INTO THE LIBRARY, registered rather than injected.
   *
   * Adoption needs `CLIP_DIR`, `IMAGE_DIR` and the `rememberClip` closure that
   * index.js hands every other clip maker — none of which exist yet when this
   * module is imported, because the app's one client is a module-level
   * singleton and index.js is what builds those. So the mount registers it
   * (`server/engine/routes.js` owns the implementation and index.js passes it
   * here in one line), and until something does, an adopted output honestly
   * records `adoptedAs: null` rather than claiming a shelf it never reached.
   */
  let adopter = deps.adopt ?? null;
  const setAdopter = (fn) => { adopter = typeof fn === "function" ? fn : null; return !!adopter; };

  const bus = new EventEmitter();
  bus.setMaxListeners(50);

  /* ── the port, and who owns it ─────────────────────────────────────────── */

  let PORT = deps.port ?? null;
  let pinned = false;
  let pinnedWhy = null;
  let revealed = false;
  let child = null;
  let facts = { version: null, argv: null, argvHash: null, at: null };

  /** ⚠ NEVER EXPORTED, never returned by a route, never logged. */
  const base = () => `http://${LISTEN_HOST}:${PORT}`;

  const portMode = () => (pinned ? "pinned" : revealed ? "revealed" : "ephemeral");
  /** The number is only ever disclosed once it is already discoverable — a
   *  pinned port was published by the person who pinned it, and a revealed one
   *  left a dated line in the ledger saying so. */
  const disclosablePort = () => (pinned || revealed ? PORT : null);

  function setPort(n, { pin = false, why = null } = {}) {
    const changed = PORT !== null && PORT !== n;
    PORT = n;
    pinned = pin;
    pinnedWhy = why;
    revealed = false;
    facts = { version: null, argv: null, argvHash: null, at: null };
    if (changed) bus.emit("rebound", { mode: portMode() });
    return n;
  }

  /**
   * A port nothing can guess, chosen fresh at every spawn.
   *
   * ⚠ TOCTOU IS REAL AND IS ALREADY HANDLED. Something can take this port
   * between our close and ComfyUI's bind. The window is milliseconds, and
   * comfy.js's adoption guard — probe before spawn, then re-check the child is
   * alive after the port answers — was written for exactly this case after an
   * evening's renders landed in another install's library. An ephemeral port
   * makes that guard RARE, not unnecessary. It stays.
   */
  async function reservePort() {
    const p = await new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const got = srv.address().port;
        srv.close(() => resolve(got));
      });
    });
    return setPort(p, { pin: false });
  }

  /**
   * The compatibility path, honoured LOUDLY.
   *
   * Not ignored: an install that pinned the port did so because of a real
   * collision, and taking it away breaks them. Not silently honoured either: a
   * discoverable port is the hole this module exists to close, so it says what
   * it costs, in the log and in the ledger and on the panel.
   */
  function pinPort(n, why = "AIPLAY_COMFY_PORT") {
    const p = Number(n);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`not a port: ${n}`);
    setPort(p, { pin: true, why });
    console.warn(
      `[engine] ${why}=${p} — the engine is pinned to a published port.\n`
      + "         Anything else on this machine can drive it directly, and those renders will\n"
      + "         not appear in the ledger, the clip library or any project. Unset it to let\n"
      + "         the app pick an unpublished port at every start.",
    );
    return p;
  }

  /**
   * Is this session pinned, and to what?
   *
   * Reads `config.comfy.pinnedPort`, which is NULL unless somebody really set
   * `AIPLAY_COMFY_PORT`. That distinction is why the key changed shape on
   * 2026-09-03: the old `port: Number(env || 8266)` resolved to 8266 for
   * everybody, so no reader could tell a pin from a default, and this function
   * had to go behind config's back to the raw variable to find out. One place
   * decides now, and it is the place that reads like a decision.
   *
   * Returns the port when pinned — having said what it costs — and null
   * otherwise, so the supervisor reads `pinFromEnv() ?? await reservePort()`.
   * A variable set to something that is not a port is ignored rather than
   * obeyed: `AIPLAY_COMFY_PORT=yes` must not become port NaN.
   */
  function pinFromEnv() {
    const pin = config.comfy?.pinnedPort ?? null;
    if (pin === null || !Number.isFinite(Number(pin))) return null;
    return pinPort(Number(pin), "AIPLAY_COMFY_PORT");
  }

  /** Identity, not a port: THIS child owns the engine. */
  function attachChild(proc) { child = proc || null; return child; }
  function detachChild() { child = null; }
  const isOurs = () => !!child && child.exitCode === null && child.signalCode === null;

  /**
   * The panel's Reveal control. Gives a developer ComfyUI's own web UI and
   * leaves a dated line saying so — which is the entire difference between an
   * invisible bypass and a visible one. After this the ledger can honestly say
   * "at 02:14 the port was revealed; renders after that may have bypassed."
   */
  async function reveal({ actor = "user" } = {}) {
    /* ⚠ RECORDED FIRST, AND A THROW ABORTS — the same inversion `dispatch()`
     * makes, for the same reason. Revealing the port is acceptable precisely
     * BECAUSE the ledger can afterwards say "at 02:14 this was revealed;
     * renders after that may have bypassed". A reveal whose record failed to
     * write is an invisible bypass, which is the thing this module exists to
     * prevent — so it does not happen. */
    await prov.append("library", {
      actor: normalizeActor(actor), type: "choice", asset: "engine",
      data: { op: "reveal_engine_port", port: PORT,
              note: "from here on, anything on this machine that was told this number can drive "
                + "the engine directly; renders that do will not appear in this ledger" },
    });
    revealed = true;
    return { port: PORT, mode: portMode() };
  }

  /** One `choice` per start, so `/api/provenance?asset=engine` is the whole
   *  history of how exposed this install has been. */
  async function announcePort() {
    const data = pinned
      ? { op: "engine_port", mode: "pinned", port: PORT, why: pinnedWhy,
          note: "anything on this machine can drive this engine directly; those renders will not appear here" }
      : { op: "engine_port", mode: "ephemeral" };
    return prov.append("library", { actor: "system", type: "choice", asset: "engine", data })
      .catch((e) => { console.warn(`  [engine] start not recorded: ${e.message}`); return null; });
  }

  async function announceTier(tier) {
    return prov.append("library", {
      actor: "system", type: "choice", asset: "engine",
      data: { op: "engine_tier", tier: String(tier ?? "") },
    }).catch(() => null);
  }

  /* ── the wire ──────────────────────────────────────────────────────────── */

  const ready = () => PORT !== null;

  async function getJSON(pathname, timeoutMs = poll.POLL_TIMEOUT_MS) {
    const r = await doFetch(`${base()}${pathname}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${pathname}`);
    return r.json();
  }

  /** Identity-blind: does ANYTHING answer here? The adoption guard's probe, and
   *  the reason it may only ever gate and never confirm — a 200 can be a
   *  neighbour's instance as easily as our child. */
  async function probePort() {
    if (!ready()) return false;
    try {
      const r = await doFetch(`${base()}/system_stats`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch { return false; }
  }

  const systemStats = (timeoutMs = 2000) => getJSON("/system_stats", timeoutMs);
  const history = (promptId) => getJSON(promptId ? `/history/${promptId}` : "/history");
  const queue = () => getJSON("/queue");
  const objectInfo = (cls) => getJSON(cls ? `/object_info/${encodeURIComponent(cls)}` : "/object_info", 30_000);

  async function interrupt() {
    try { await doFetch(`${base()}/interrupt`, { method: "POST", signal: AbortSignal.timeout(5000) }); return { stopped: true }; }
    catch (e) { return { stopped: false, error: e.message }; }
  }

  async function clearQueue() {
    try {
      const before = await queue().catch(() => null);
      const dropped = before ? (before.queue_pending || []).length : null;
      await doFetch(`${base()}/queue`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clear: true }), signal: AbortSignal.timeout(5000),
      });
      return { dropped };
    } catch (e) { return { dropped: 0, error: e.message }; }
  }

  /**
   * Give the frames back. `POST /free` with `free_memory` drops ComfyUI's
   * execution cache without evicting the weights.
   *
   * ⚠ MEASURED, and the reason this is a first-class call rather than a stray
   * fetch in art.js: after a 2x upscale ComfyUI sat at 14.95 GB resident with
   * an EMPTY queue — its execution cache still holding the frame batch — and
   * the 6 GB left was little enough that the browser's own renderer locked up.
   * `free_memory` alone took it to 0.37 GB.
   *
   * `unload_models` defaults OFF and should stay off for that caller: it would
   * evict the music engine too, and this app exists around ONE long-lived warm
   * process. Best effort by design — a finished job must never fail over
   * cleanup — so this reports rather than throws.
   */
  async function freeMemory({ unloadModels = false } = {}) {
    try {
      await doFetch(`${base()}/free`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ free_memory: true, unload_models: !!unloadModels }),
        signal: AbortSignal.timeout(10_000),
      });
      return { freed: true };
    } catch (e) { return { freed: false, error: e.message }; }
  }

  /** The ONE websocket to the engine in this tree. Holders must drop and
   *  relisten on "rebound": after a restart the old port is somebody else's
   *  problem, or nobody's. */
  function socket(clientId) {
    return new Socket(`ws://${LISTEN_HOST}:${PORT}/ws?clientId=${encodeURIComponent(String(clientId ?? ""))}`);
  }

  /**
   * Read the engine's own launch flags and cache them.
   *
   * ⚠ CALLED AT STARTUP, NEVER FROM `dispatch()`. dispatch must make exactly
   * ONE wire call before it polls — the POST — so that "the ledger threw,
   * therefore nothing was sent" is provable by counting fetches rather than by
   * reading the code. A cached null version in a record is a smaller loss than
   * a hole in that proof.
   */
  async function refreshFacts() {
    try {
      const s = await systemStats(2500);
      const argv = Array.isArray(s?.system?.argv) ? s.system.argv : null;
      facts = {
        version: s?.system?.comfyui_version ?? null,
        argv,
        argvHash: argv ? sha256(sortedJSON(argv)) : null,
        at: Date.now(),
      };
    } catch { /* an engine that is not up yet has no facts; the record says null */ }
    return facts;
  }

  const norm = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  const same = (a, b) => Boolean(a && b) && norm(a) === norm(b);

  /**
   * WHICH ComfyUI is this, from its own argv — the check that stops renders
   * landing in another install's library.
   *
   * A PORT IS NOT AN IDENTITY. `/system_stats` returns `system.argv` verbatim,
   * which carries the launched `--port`, `--input-directory` and
   * `--output-directory`; when a flag is absent ComfyUI falls back to
   * <rig>/input and <rig>/output, and the rig is recoverable from argv[0],
   * which is that instance's own main.py. Ported from gate_lib.mjs, which
   * learned it the same way this repo did.
   */
  async function identity() {
    await refreshFacts();
    const argv = facts.argv;
    const out = {
      version: facts.version, mainPy: null, inputDirectory: null, outputDirectory: null,
      matchesThisStudio: false, mode: portMode(), port: disclosablePort(), problems: [],
    };
    if (!argv) {
      out.problems.push(
        "/system_stats returned no system.argv, so this engine's --input-directory and "
        + "--output-directory cannot be verified. Nothing is claimed about which install this is.");
      return out;
    }
    const flag = (name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
    const rig = argv[0] && /main\.py$/i.test(String(argv[0])) ? path.dirname(path.resolve(String(argv[0]))) : null;
    out.mainPy = argv[0] ?? null;
    out.inputDirectory = flag("--input-directory") ?? (rig ? path.join(rig, "input") : null);
    out.outputDirectory = flag("--output-directory") ?? (rig ? path.join(rig, "output") : null);
    if (!same(out.inputDirectory, config.inputDir)) {
      out.problems.push(`its --input-directory is ${out.inputDirectory ?? "(not resolvable from argv)"}, but this Studio stages references to ${config.inputDir}`);
    }
    if (!same(out.outputDirectory, config.outputDir)) {
      out.problems.push(`its --output-directory is ${out.outputDirectory ?? "(not resolvable from argv)"}, but this Studio's library reads ${config.outputDir}`);
    }
    out.matchesThisStudio = out.problems.length === 0 && isOurs();
    return out;
  }

  /**
   * What the panel and the tools may say about the engine.
   *
   * ⚠ NO PORT unless it is already discoverable. In ephemeral mode this object
   * contains the STRING "ephemeral" and no number anywhere — asserted at
   * runtime, on this exact response, by client_test.js. In pinned or revealed
   * mode it carries the number, because hiding a number that `netstat` prints
   * helps nobody and pretending otherwise would be the dishonest half.
   */
  async function status() {
    const s = await store.readSettings();
    const g = await store.graphStoreBytes();
    let q = null;
    try {
      const raw = await queue();
      q = { running: (raw.queue_running || []).length, pending: (raw.queue_pending || []).length };
    } catch { /* not up */ }
    return {
      ready: ready() && isOurs(),
      ours: isOurs(),
      mode: portMode(),
      pinned, revealed,
      port: disclosablePort(),
      version: facts.version,
      queue: q,
      /* QUEUED AND RUNNING ARE DIFFERENT FACTS, and this row says which. A job
       * behind a 32-minute render is not slow, it is waiting; `elapsedSec`
       * alone cannot tell those apart, and the deadline in watch() now counts
       * only the running half — so anything reading this (the panel, and the
       * base repo's harnesses, which poll this to learn when their own job
       * really started) gets the same split the ledger records. */
      running: [...inFlight.values()].map((r) => ({
        runId: r.runId, label: r.label, via: r.via,
        elapsedSec: (Date.now() - r.t0) / 1000,
        state: r.startedAt ? "running" : "queued",
        queuedSec: r.startedAt ? (r.startedAt - r.t0) / 1000 : null,
        runningSec: r.startedAt ? (Date.now() - r.startedAt) / 1000 : null,
      })),
      hashModels: s.hashModels === true,
      graphStore: g,
    };
  }

  /* ── the door ──────────────────────────────────────────────────────────── */

  /** Runs the app knows about right now, for `status()` and the panel. */
  const inFlight = new Map();

  /** Prompt ids this app has asked the engine to drop, held only until their
   *  own watcher ends. It is what makes "we stopped it" and "the engine lost
   *  it" different facts in the ledger rather than the same guess — see
   *  cancelRun() and the check it feeds in watch(). */
  const cancelling = new Map();

  /**
   * THE DOOR. Nothing in this application may reach the engine any other way.
   *
   * Source order below IS the design, and `client_test.js` proves it twice —
   * once by index in this file, once at runtime with a ledger that throws:
   *
   *   1. validate the graph, and say which of the two ComfyUI save formats
   *      this is when it is the wrong one
   *   2. build the record — pure
   *   3. store the graph under its own hash
   *   4. AWAIT the delegate event, AND LET A THROW ABORT
   *   5. POST /prompt
   *   6. poll to a terminal state, every wait bounded
   *   7. hash the outputs
   *   8. AWAIT the generate event
   *
   * ⚠ STEP 4 IS THE ONE PLACE IN THIS APPLICATION WHERE A LEDGER FAILURE MUST
   * COST THE RENDER. Everywhere else the bargain is the opposite — provenance.js
   * tells its callers to `.catch()` because a ledger failure must never cost the
   * media. Here the media IS the thing being recorded, and "nothing runs
   * unrecorded" is the entire design. There is no `.catch()` on that line and
   * none may be added.
   */
  async function dispatch(spec = {}) {
    /* Local stand-ins chosen on the Models screen, applied BEFORE the record is
     * built so the ledger names the file that actually rendered. */
    const graph = applyModelOverrides(spec.graph, config.modelOverrides);
    const problems = graphProblems(graph);
    if (problems.length) {
      const err = new Error(`this graph cannot be run: ${problems[0]}`);
      err.problems = problems;
      throw err;
    }
    const via = String(spec.via ?? "").trim();
    if (!via) {
      throw new Error(
        "engine.dispatch needs `via`: a short caller id (art.cover, jobs.music, mv.sfx_judge, "
        + "imagetools, export.audio, api). It is what lets the ledger answer 'which part of the "
        + "app spent those 32 minutes'.");
    }

    const actor = normalizeActor(spec.actor);
    const runId = newRunId();
    const wait = spec.wait !== false;
    const adopt = spec.adopt !== false;
    const timeoutMs = Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0
      ? Math.round(spec.timeoutMs) : poll.JOB_DEADLINE_MS;
    /* HOW OFTEN TO ASK, which is not one number for every job this app runs.
     *
     * The default 3 s is right for a 32-minute VACE pass and wrong for a cover:
     * a FLUX.2 klein image is about three seconds end to end, so a 3 s cadence
     * would roughly double its latency for nothing. art.js already chose 400 ms
     * for images, 500 for sfx and 1000 for clips, from measurement; the door
     * carries those numbers rather than overriding them.
     *
     * Every BOUND below is stated in milliseconds rather than in polls for
     * exactly this reason — see watch(). Floored at 100 ms so no caller can
     * turn the poll loop into a busy wait against its own engine. */
    const pollMs = Number.isFinite(spec.pollMs) && spec.pollMs >= 100
      ? Math.round(spec.pollMs) : poll.POLL_MS;

    const record = buildRecord(graph, {
      runId, via, actor,
      label: spec.label ?? null, note: spec.note ?? null,
      project: spec.project ?? null, shot: spec.shot ?? null,
      enginePort: portMode(),
      engineVersion: facts.version, engineArgvHash: facts.argvHash,
      adopt, wait, timeoutMs, appVersion: TOOL,
    });

    const settings = await store.readSettings();
    await store.resolveRecordFiles(record, { hashModels: settings.hashModels === true });

    /* The record that WOULD be written, and nothing spent. This is the cheapest
     * way for an agent to find out it was about to spend half an hour on the
     * wrong checkpoint — it returns the model files, the step count, the size
     * and the seed, and deliberately does not fabricate a cost estimate for an
     * arbitrary graph. A made-up number is worse than none.
     *
     * It stores nothing, which is why it sits above `putGraph`: a graph filed
     * under its own hash by a run that never happened would make the NEXT run
     * of it look like a repeat, and "have we run this before" is half of the
     * cache-hit answer below. */
    if (spec.dryRun) return { ok: true, dryRun: true, runId, status: "not-run", record, problems: [] };

    /* THE IDENTITY RULE AT THE JOB DOOR, inherited from comfy.submit(): if OUR
     * child is not alive, whatever is answering (if anything) is somebody
     * else's engine, and a job posted to it renders into somebody else's
     * library. */
    if (!ready() || !isOurs()) {
      throw new Error(
        "the engine is not running (this Studio's ComfyUI child is not alive) — refusing to "
        + "submit, because whatever else might answer would render into another install's library.");
    }

    const stored = await store.putGraph(record.graphHash, graph);
    record.graphStored = stored.path;

    const t0 = Date.now();

    // ⚠ STEP 4. Awaited. No .catch(). A throw here means nothing was sent.
    const delegate = await prov.append("library", {
      actor, type: "delegate", asset: `engine/${runId}`, data: record,
    });

    /* After the append, never before: a run the ledger refused never started,
     * and a phantom row in `status()` that nothing will ever clear is exactly
     * the kind of small lie this panel must not tell. */
    inFlight.set(runId, { runId, label: spec.label ?? null, via, t0, startedAt: null });

    let res;
    try {
      res = await doFetch(`${base()}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: graph, client_id: spec.clientId ?? `aiplay-${runId}` }),
        signal: AbortSignal.timeout(poll.POST_TIMEOUT_MS),
      });
    } catch (e) {
      return finishNow({ runId, record, actor, t0, delegate, status: "rejected", error: `POST /prompt failed: ${e.message}`, throws: true });
    }
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.text()).slice(0, 700); } catch { /* nothing to add */ }
      return finishNow({ runId, record, actor, t0, delegate, status: "rejected", error: `ComfyUI rejected the job: ${detail}`, throws: true });
    }

    let promptId = null;
    try { ({ prompt_id: promptId } = await res.json()); } catch { /* handled next */ }
    if (!promptId) {
      return finishNow({ runId, record, actor, t0, delegate, status: "rejected", error: "/prompt returned no prompt_id", throws: true });
    }
    /* THE HANDLE A SURGICAL CANCEL NEEDS, and it exists only from here on. A
     * run with no prompt id is not addressable on the engine, and cancelRun()
     * refuses to touch the engine for one rather than falling back to the
     * engine-wide interrupt that took other people's renders with it. */
    { const f = inFlight.get(runId); if (f) f.promptId = promptId; }

    const running = watch({ runId, promptId, record, actor, spec, t0, delegate, timeoutMs, pollMs, cachedCandidate: stored.existed })
      .catch((e) => {
        inFlight.delete(runId);
        console.error(`  [engine] ${runId} watcher failed: ${e.message}`);
        return { ok: false, runId, promptId, status: "error", error: e.message, outputs: [], record };
      });

    /* `submit()` returns here. The completion event is still written by this
     * process even if the caller never comes back — which is what makes the
     * "watch your own websocket" callers (music, art) unable to land on a path
     * that skips the ledger. */
    if (!wait) {
      running.then(() => {}, () => {});
      return { ok: true, runId, promptId, status: "running", record, ledger: { delegate, generate: null }, outputs: [] };
    }
    return running;
  }

  /** A run that never reached the queue still gets its completion event, so the
   *  delegate is never left dangling — a request with no answer looks exactly
   *  like a crashed app. */
  async function finishNow({ runId, record, actor, t0, delegate, status, error, throws }) {
    inFlight.delete(runId);
    const data = {
      runId, promptId: null, status, error,
      elapsedSec: (Date.now() - t0) / 1000, queuedSec: null, runningSec: null, cached: false,
      outputs: [], graphHash: record.graphHash, model: record.model,
      via: record.via, label: record.label, project: record.project, shot: record.shot,
    };
    const generate = await prov.append("library", { actor, type: "generate", asset: `engine/${runId}`, data })
      .catch((e) => { console.error(`  [engine] ${runId} completion not recorded: ${e.message}`); return null; });
    if (throws) {
      const err = new Error(error);
      err.runId = runId; err.status = status; err.ledger = { delegate, generate };
      throw err;
    }
    return { ok: false, runId, status, error, outputs: [], record, ledger: { delegate, generate } };
  }

  /**
   * WHERE IN THE ENGINE'S OWN QUEUE THIS PROMPT IS — and the distinction the
   * two lists make is the whole of the deadline fix below.
   *
   * `queue_running` is what ComfyUI has STARTED; `queue_pending` is what is
   * still waiting behind it. Asking only "is it in either list" (which is what
   * this function used to answer) conflates a job the GPU is working on with a
   * job that has not been touched yet, and that conflation is what made
   * `mtm1al5b70067f` — queued behind a 32-minute render, then rendered to
   * completion and wrote its files — arrive in the ledger as a `timeout` with
   * `elapsedSec 1800.456` and `queuedSec 3.685`.
   *
   * Returns "running" | "pending" | "gone", or null when the queue could not be
   * read at all — which is UNKNOWN, and must never be read as "gone": a restart
   * discards history, so "absent from history" alone cannot tell running from
   * gone either.
   */
  async function queuePlace(promptId) {
    try {
      const q = await queue();
      if ((q.queue_running || []).some((it) => it?.[1] === promptId)) return "running";
      if ((q.queue_pending || []).some((it) => it?.[1] === promptId)) return "pending";
      return "gone";
    } catch { return null; }   // unknown, not "gone"
  }

  /**
   * CANCEL ONE RUN, AND ONLY THAT RUN.
   *
   * ⚠ MEASURED TWICE ON 2026-09-05. With a chat turn queued behind a song, one
   * press of the app's Stop button left the chat's prompt in neither /history
   * nor /queue (runs mto5iphvf293e7 and mto5ngyxf4893c): it wrote no output,
   * and its ledger row said `vanished` — the status this door reserves for "a
   * ComfyUI restart discarded it". Nothing had restarted. Stop was two engine-
   * wide calls: `interrupt()`, which is addressed at nothing in particular and
   * stops whatever the GPU is holding, and `clearQueue()`, whose `{clear:true}`
   * wipes the WHOLE pending list. Every other actor's work went with the song,
   * and the record then blamed the engine for it.
   *
   * So a cancel is addressed at a PROMPT. Two ways, in order:
   *
   *   1. `POST /api/jobs/<promptId>/cancel` — this engine's own per-job cancel,
   *      which dequeues a pending prompt and, for a running one, calls
   *      `interrupt_if_running(prompt_id)` UNDER THE QUEUE MUTEX. That
   *      atomicity is worth reaching for rather than reimplementing: it is the
   *      one thing a client cannot do, because between our own "is it running?"
   *      and our own POST /interrupt the prompt can finish and the NEXT one —
   *      somebody else's — can start, and the interrupt lands on that instead.
   *      Exactly the bug being fixed, one layer down.
   *
   *   2. Older engines have no such route, so: `{delete:[id]}`, which ComfyUI
   *      applies to the PENDING list only and therefore cannot touch what is
   *      rendering — ours or anyone's — and then `interrupt()` ONLY if a fresh
   *      read of /queue says the thing rendering is this very prompt. The read
   *      is taken AFTER the delete on purpose; a queue that cannot be read at
   *      all is UNKNOWN, never "running", and no interrupt is sent, because
   *      guessing here spends somebody else's half hour.
   *
   * A run with no prompt id — API mode, or cancelled in the gap between the
   * ledger append and the POST — reaches the engine NOT AT ALL. There is
   * nothing of its own to stop, and the only thing an interrupt could stop then
   * belongs to somebody else.
   */
  async function cancelRun({ runId = null, promptId = null } = {}) {
    const row = runId ? inFlight.get(runId)
      : [...inFlight.values()].find((r) => r.promptId && r.promptId === promptId);
    const id = promptId ?? row?.promptId ?? null;
    if (!id) {
      return {
        ok: false, cancelled: false, runId: runId ?? null, atomic: false,
        stopped: false, place: null, interrupted: false,
        error: "this run has no prompt on the engine, so it has nothing of its own to cancel "
          + "(interrupting anyway would stop whatever else is rendering)",
      };
    }
    /* Before the wire call, so the run's own watcher cannot poll in the gap and
     * record the disappearance as something the engine did. */
    if (row) cancelling.set(id, { runId: row.runId, at: Date.now() });
    /* And an id whose watcher ended in the instant before that set has nobody
     * left to clear it. One deadline is longer than any run this door allows,
     * so anything older than that is debris, not a pending cancel. */
    for (const [k, v] of cancelling) {
      if (Date.now() - v.at > poll.JOB_DEADLINE_MS) cancelling.delete(k);
    }

    let error = null;
    try {
      const r = await doFetch(`${base()}/api/jobs/${encodeURIComponent(id)}/cancel`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        /* `{cancelled:false}` is not a failure: the engine is telling us the id
         * is already finished or already gone, which is the outcome asked for. */
        let said = null;
        try { ({ cancelled: said } = await r.json()); } catch { /* 200 is enough */ }
        return {
          ok: true, cancelled: true, runId: row?.runId ?? runId ?? null, atomic: true,
          stopped: said !== false, place: null, interrupted: false, error: null,
        };
      }
      if (r.status !== 404) error = `HTTP ${r.status} from the engine's per-job cancel`;
    } catch (e) { error = e.message; }

    /* ── the fallback, for an engine without that route ────────────────── */
    try {
      await doFetch(`${base()}/queue`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delete: [id] }), signal: AbortSignal.timeout(5000),
      });
      error = null;
    } catch (e) { error = e.message; }

    const place = await queuePlace(id);
    let interrupted = false;
    if (place === "running") {
      const r = await interrupt();
      interrupted = r.stopped === true;
      if (!interrupted && !error) error = r.error ?? null;
    }
    const stopped = interrupted || place === "gone";
    if (!row) cancelling.delete(id);   // nobody is watching it; do not hold the id for ever
    return {
      ok: stopped, cancelled: true, runId: row?.runId ?? runId ?? null, atomic: false,
      stopped, place, interrupted, error,
    };
  }

  /** A deadline stated the way the person reading the ledger row would say it. */
  const humanMs = (ms) => (ms < 90_000
    ? `${(ms / 1000).toFixed(ms < 2000 ? 2 : 0)} s`
    : `${Math.round(ms / 60000)} min`);

  async function watch({ runId, promptId, record, actor, spec, t0, delegate, timeoutMs, pollMs = poll.POLL_MS, cachedCandidate }) {
    let fails = 0, vanished = 0, startedAt = null;
    let status = "error", error = null, entry = null;

    /** The engine has taken this job. Recorded once, and published on the
     *  in-flight row so `status()` can say "queued 4 min, running 2 min"
     *  rather than one number that means neither. */
    const started = () => {
      if (startedAt !== null) return;
      startedAt = Date.now();
      const f = inFlight.get(runId);
      if (f) f.startedAt = startedAt;
    };

    /* ⚠ THE BOUNDS ARE DURATIONS, NOT COUNTS, and that is what lets a caller
     * choose its own cadence without quietly weakening them.
     *
     * gate_lib.mjs's hardened numbers are 8 consecutive failures and 3 vanished
     * polls AT A 3 s CADENCE — which is 24 s of a server that stopped answering
     * and 9 s of a prompt in neither list. Kept as durations, they mean the same
     * thing at 3 s and still mean it at 400 ms; kept as counts, an image
     * caller's fast poll would have failed a healthy render after 3.2 s of one
     * hiccup. At the default cadence the arithmetic is exact — `fails * POLL_MS
     * >= MAX * POLL_MS` is `fails >= MAX` — so the ported loop is unchanged
     * where it was measured. */
    const failWindowMs = poll.MAX_CONSECUTIVE_POLL_FAILURES * poll.POLL_MS;
    const vanishWindowMs = poll.MAX_VANISHED_POLLS * poll.POLL_MS;

    for (;;) {
      await sleep(pollMs);

      /* ⚠⚠ THE DEADLINE RUNS FROM THE MOMENT THE ENGINE STARTED THIS JOB, AND
       * A JOB THAT HAS NOT STARTED CANNOT BE LATE. ⚠⚠
       *
       * This used to be `Date.now() - t0 > timeoutMs`, which is the clock
       * starting at QUEUEING. One measured consequence, in this app's own
       * ledger: run `mtm1al5b70067f` was posted while a 32-minute render still
       * held the engine, sat in `queue_pending` for most of the half hour, then
       * ran and wrote its files — and was recorded `status: "timeout"`,
       * `elapsedSec: 1800.456`. The record said the render failed. The files on
       * disk said it did not. A ledger that is wrong about the expensive thing
       * is worse than no ledger, because it is believed.
       *
       * So the bound is on the ENGINE'S time, not on the wall's: `queuedSec`
       * stays reported (and is now measured properly — see queuePlace), and a
       * job still sitting in `queue_pending` when this deadline would have
       * expired is simply not late yet.
       *
       * ⚠ THE RESIDUAL, STATED RATHER THAN IMPLIED: a job that never starts is
       * not bounded by this deadline. What bounds it is everything below —
       * MAX_CONSECUTIVE_POLL_FAILURES if the engine goes away (the OOM that
       * takes the process), MAX_VANISHED_POLLS if the queue loses it (a restart
       * discards it). What is left is the one case where waiting is CORRECT: a
       * live engine that is answering, with our job genuinely behind another
       * one. That wait is the thing being fixed, not an oversight. */
      if (startedAt !== null && Date.now() - startedAt > timeoutMs) {
        status = "timeout";
        error = `no terminal status ${humanMs(timeoutMs)} after this job STARTED on the engine`
          + (startedAt > t0 + pollMs
            ? ` (it waited ${((startedAt - t0) / 1000).toFixed(1)} s in the queue first, which does not count against the deadline)`
            : "")
          + ` — abandoning ${promptId} rather than holding this caller open for ever`;
        break;
      }

      let h;
      try {
        h = await history(promptId);
        fails = 0;
      } catch (e) {
        fails++;
        /* NEVER SILENT. gate_lib writes a "!" to stdout here; a server writes a
         * line, because the thing this counter catches is an OOM that took the
         * whole engine process with it. */
        console.warn(`  [engine] ${runId}: poll failed ${fails}x over ${((fails * pollMs) / 1000).toFixed(1)}s `
          + `of ${(failWindowMs / 1000).toFixed(0)}s (${e.message})`);
        if (fails * pollMs >= failWindowMs) {
          status = "error";
          error = `ComfyUI stopped answering after ${((Date.now() - t0) / 1000).toFixed(0)} s `
            + `(${fails} consecutive poll failures, last: ${e.message}). An OOM that takes the `
            + "process with it lands here rather than in the engine's own error branch.";
          break;
        }
        continue;
      }

      entry = h?.[promptId];

      /* ⚠ CANCELLED BY THIS APP — AND THAT IS A DIFFERENT FACT FROM EVERY
       * OTHER WAY A RUN CAN END, which is why this sits above both the vanished
       * counter and the error branch.
       *
       * A prompt withdrawn from the pending queue is never written to /history
       * at all, so the loop below would call it `vanished` — "a ComfyUI restart
       * discarded it" — which is precisely the lie the ledger told about the
       * chat turn a Stop click destroyed. A RUNNING prompt that was interrupted
       * does reach /history, as an error carrying ComfyUI's own interruption
       * message, which reads as a render that failed. Neither is what happened:
       * somebody pressed Stop.
       *
       * A run that had already COMPLETED keeps its completion. Cancelling
       * something that finished a moment earlier must not throw away the record
       * of the outputs it wrote. */
      if (cancelling.has(promptId) && !entry?.status?.completed) {
        status = "cancelled";
        error = "cancelled from the app: this run's prompt was withdrawn from the engine "
          + "(no other queued run was touched)";
        break;
      }

      if (!entry) {
        const place = await queuePlace(promptId);
        /* "running" only. "pending" is the engine holding it behind something
         * else, which is exactly what must NOT start the clock. */
        if (place === "running") started();
        if (place === "gone") {
          vanished++;
          if (vanished * pollMs >= vanishWindowMs) {
            status = "vanished";
            error = `${promptId} is in neither /history nor /queue after ${((Date.now() - t0) / 1000).toFixed(0)} s. `
              + "A ComfyUI restart discards history, so the job is GONE rather than pending.";
            break;
          }
        } else { vanished = 0; }
        continue;
      }
      vanished = 0;
      /* An entry in /history means the engine has taken it, whatever the queue
       * said a moment ago — a job short enough to finish between two polls is
       * never seen in `queue_running` at all, and calling that one "never
       * started" would make its queuedSec its whole wall time. */
      started();

      if (entry.status?.status_str === "error") {
        status = "error";
        error = JSON.stringify(entry.status.messages || "").slice(0, 900);
        break;
      }
      if (entry.status?.completed) { status = "completed"; error = null; break; }
    }

    const elapsedSec = (Date.now() - t0) / 1000;
    /* THREE NUMBERS, NOT ONE. `elapsedSec` is what the caller waited,
     * `queuedSec` is what the engine spent on somebody else's job first, and
     * `runningSec` — elapsed minus queued — is the only one of the three that
     * is about THIS render. The deadline above is measured against the third. */
    const queuedSec = startedAt ? (startedAt - t0) / 1000 : null;
    const runningSec = startedAt ? (Date.now() - startedAt) / 1000 : null;
    const outputs = status === "completed" ? await collectOutputs(entry, { runId, record, actor, spec }) : [];

    const data = {
      runId, promptId, status, error,
      elapsedSec, queuedSec, runningSec,
      /* ComfyUI serves an identical graph from its own node cache — measured
       * 258 s -> 0.3 s on the music model. Two facts, not one: it came back
       * implausibly fast AND we have run this exact graph before. Measured on
       * the RUNNING half: a cache hit that waited twenty minutes behind another
       * render is still a cache hit, and `elapsedSec` would call it a slow one. */
      cached: status === "completed" && (runningSec ?? elapsedSec) < 2 && cachedCandidate === true,
      outputs,
      graphHash: record.graphHash, model: record.model,
      via: record.via, label: record.label, project: record.project, shot: record.shot,
    };

    inFlight.delete(runId);
    cancelling.delete(promptId);
    const generate = await prov.append("library", { actor, type: "generate", asset: `engine/${runId}`, data })
      .catch((e) => { console.error(`  [engine] ${runId} completion not recorded: ${e.message}`); return null; });

    return {
      ok: status === "completed", runId, promptId, status, error,
      elapsedSec: data.elapsedSec, queuedSec: data.queuedSec, runningSec: data.runningSec,
      cached: data.cached,
      outputs,
      /* ⚠ THE TERMINAL HISTORY ENTRY, IN MEMORY, FOR THE CALLER — because not
       * every output ComfyUI produces is a file.
       *
       * `mv/sfxcue.js`'s judge is a CLIPLoader + TextGenerate + PreviewAny with
       * no SaveAnything in it at all: its answer arrives as `outputs.3.text[0]`
       * and there is nothing to hash or adopt. Without this the caller would
       * have to ask /history a second time, and an engine restart in that gap
       * would return an empty string that judgeCues reads as "judge
       * unavailable" — a silent wrong answer, which is the worst kind.
       *
       * It is data, never an address: nothing in here says where the engine is. */
      entry: entry ?? null,
      record, ledger: { delegate, generate },
    };
  }

  /**
   * Everything the graph wrote, sized and hashed.
   *
   * The output digest is the field that makes a ledger entry point at a
   * particular FILE rather than at a filename — the 85 unledgered clips this
   * door exists for are all "a name in a folder" and nothing more.
   */
  async function collectOutputs(entry, { runId, record, actor, spec }) {
    const out = [];
    for (const [node, byKind] of Object.entries(entry?.outputs || {})) {
      /* ⚠ `3d` IS ONE OF THESE AND WAS MISSING. ComfyUI's SaveGLB files its
       * output under `outputs.<node>["3d"]`, not under images — so a graph that
       * wrote a mesh came back through this door with an EMPTY outputs array,
       * and the ledger recorded a completed run that produced nothing. That is
       * the 424-unledgered-files failure in miniature: the file is on disk, the
       * record says there is no file, and the two disagree forever.
       *
       * ⚠ AND THE SINGULARISER BELOW IS A NO-OP ON IT, which is the right
       * answer rather than a lucky one: `kind.replace(/s$/, "")` turns "images"
       * into "image" and leaves "3d" exactly as it is. "3" is not a kind.
       * Nothing downstream may start assuming every kind here loses a letter. */
      for (const kind of ["images", "videos", "audio", "gifs", "3d"]) {
        for (const o of byKind?.[kind] || []) {
          if (!o?.filename) continue;
          const facts_ = await store.outputFacts(o);
          const row = {
            node, kind: kind.replace(/s$/, ""), file: o.filename, subfolder: o.subfolder || "",
            /* ComfyUI 0.36 makes LoadVideo echo its INPUT file as an output row (type "input"); the kind is kept so a reader can tell the echo from what the graph wrote. */
            type: o.type || "output",
            bytes: facts_.bytes, sha256: facts_.sha256, adoptedAs: null,
          };
          /* `claim` means the caller files this asset itself under its own name
           * (art.js registers a clip; jobs.js a song). Adopting it again here
           * would write a second library entry for one file. */
          if (spec.claim) row.adoptedAs = String(spec.claim);
          else if (spec.adopt !== false && adopter) {
            try { row.adoptedAs = (await adopter({ runId, record, output: row, actor, spec })) ?? null; }
            catch (e) { console.warn(`  [engine] ${runId}: could not adopt ${o.filename}: ${e.message}`); }
          }
          out.push(row);
        }
      }
    }
    return out;
  }

  const run = (spec) => dispatch({ ...spec, wait: true });
  const submit = (spec) => dispatch({ ...spec, wait: false });

  /* ── reading back ──────────────────────────────────────────────────────── */

  /**
   * Every prompt this engine has been asked to run, newest first, joined from
   * the delegate/generate pair on each `engine/<runId>` asset.
   *
   * Because the door is the only way in, the ABSENCE of a row means the render
   * did not happen — rather than that it happened unrecorded, which is what
   * absence meant before.
   */
  async function activity({ limit = 50, actor = null, since = null, project = null, statusOf = null, via = null } = {}) {
    const { events } = await prov.read("library", { assetPrefix: "engine/" });
    const runs = new Map();
    for (const e of events) {
      const id = String(e.asset || "").slice("engine/".length);
      if (!id) continue;
      const row = runs.get(id) || { runId: id, t: e.t, actor: e.actor, request: null, result: null };
      if (e.type === "delegate") { row.request = e.data; row.t = e.t; row.actor = e.actor; }
      if (e.type === "generate") row.result = e.data;
      runs.set(id, row);
    }
    let rows = [...runs.values()].map((r) => ({
      runId: r.runId, t: r.t, actor: r.actor,
      via: r.request?.via ?? r.result?.via ?? null,
      label: r.request?.label ?? null,
      model: r.request?.model ?? null,
      width: r.request?.width ?? null, height: r.request?.height ?? null,
      steps: r.request?.steps ?? null, seed: r.request?.seed ?? null,
      project: r.request?.project ?? null, shot: r.request?.shot ?? null,
      status: r.result?.status ?? (r.request ? "running" : null),
      elapsedSec: r.result?.elapsedSec ?? null,
      cached: r.result?.cached ?? null,
      outputs: r.result?.outputs ?? [],
    }));
    if (actor) rows = rows.filter((r) => r.actor === actor);
    if (via) rows = rows.filter((r) => r.via === via);
    if (project) rows = rows.filter((r) => r.project === project);
    if (statusOf) rows = rows.filter((r) => r.status === statusOf);
    if (since) rows = rows.filter((r) => Date.parse(r.t) >= Date.parse(since));
    rows.sort((a, b) => String(b.t).localeCompare(String(a.t)));
    const total = rows.length;
    return { runs: rows.slice(0, Math.max(1, Math.min(500, limit))), total };
  }

  /** One run's complete record, and the graph itself when asked — which is what
   *  makes a render reproducible rather than merely described. */
  async function runRecord(runId, { graph = false } = {}) {
    const { events } = await prov.read("library", { asset: `engine/${runId}` });
    if (!events.length) return null;
    const request = events.find((e) => e.type === "delegate")?.data ?? null;
    const result = events.find((e) => e.type === "generate")?.data ?? null;
    const out = { runId, request, result, graph: null };
    if (graph && request?.graphHash) out.graph = await store.getGraph(request.graphHash);
    return out;
  }

  return {
    // lifecycle — only the supervisor calls these
    reservePort, pinPort, pinFromEnv, attachChild, detachChild, isOurs, announcePort, announceTier,
    setAdopter,
    listenHost: LISTEN_HOST,
    // wire — everyone else
    dispatch, run, submit, socket, cancelRun, interrupt, clearQueue, freeMemory,
    history, queue, objectInfo, systemStats, identity, probePort, refreshFacts,
    status, activity, runRecord, reveal,
    // events
    on: (...a) => bus.on(...a), off: (...a) => bus.off(...a), once: (...a) => bus.once(...a),
    // for the supervisor's spawn line only; never for building a URL
    get portForSpawn() { return PORT; },
    get mode() { return portMode(); },
    store,
  };
}

/** The app's one engine client. */
export const engine = createEngineClient();
export default engine;
