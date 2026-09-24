/**
 * The engine door's runtime proof. No server, no GPU, no ComfyUI — and no
 * writes anywhere near the real ledger: every append in here goes through the
 * REAL provenance module into a temp directory, so the hash chain, the actor
 * normalisation and the rights stamp are all genuinely exercised while the
 * install's own `library.jsonl` is never opened.
 *
 * What it pins, and why each pin exists:
 *
 *   · LEDGER-BEFORE-POST, TWICE. Once by index in the source, once by counting
 *     fetches with a ledger that throws. The second is the one that matters: a
 *     proof you can only make by grepping is a proof about a file, not about a
 *     program. If `dispatch()` ever grows a `.catch()` on that append — the
 *     single most natural "fix" for a flaky write, and the pattern every OTHER
 *     seam in this app is told to use — both halves fail.
 *
 *   · THE RECORD IS COMPLETE. Every field §3.2 promises, asserted on the
 *     runtime record built from three real graph shapes rather than on a grep
 *     of the builder. A field silently dropped fails the build.
 *
 *   · THE RECORD IS HONEST. Two samplers hoist nothing; an unwalkable graph
 *     claims no prompt and still keeps every text; an unknown checkpoint leaves
 *     `model` null so no licence is invented. These are the checks that stop
 *     the record becoming confident, which is the only way it could become
 *     dangerous.
 *
 *   · NOTHING ADVERTISES THE PORT. Asserted on the runtime `status()` and
 *     `identity()` objects: in ephemeral mode the number appears nowhere in the
 *     JSON. In pinned or revealed mode it does, because then it is already
 *     discoverable and hiding it helps nobody.
 *
 *   · EVERY WAIT IS BOUNDED. A dead engine, a vanished prompt and a job past
 *     its deadline each terminate, each write their completion event, and each
 *     say which of those happened. Silence must never be the symptom.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as provenance from "../provenance.js";
import { createEngineClient } from "./client.js";
import { createStore } from "./store.js";
import { buildRecord, RECORD_FIELDS, graphProblems } from "./record.js";
import {
  LTX_VIDEO_GRAPH, FLUX_IMAGE_GRAPH, TEXT_JUDGE_GRAPH,
  TWO_SAMPLER_GRAPH, UNWALKABLE_GRAPH, UI_FORMAT_GRAPH,
} from "./fixtures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "engine-test-"));
const ledgerDir = path.join(tmp, "ledger");
const outDir = path.join(tmp, "out");
const { mkdirSync } = await import("node:fs");
mkdirSync(ledgerDir, { recursive: true });
mkdirSync(path.join(outDir, "gate"), { recursive: true });

/* A real file for the output hasher to read, so "outputs are hashed" is a fact
 * about bytes rather than about a code path. */
const OUTPUT_BYTES = Buffer.from("not really an mp4, but it is really some bytes");
writeFileSync(path.join(outDir, "gate", "arm3_00001.mp4"), OUTPUT_BYTES);

/** The real ledger machinery, pointed at a temp directory. */
const ledger = (dir) => ({
  append: (_scope, evt) => provenance.append({ dir }, evt),
  read: (_scope, opts) => provenance.read({ dir }, opts),
});

const makeStore = (dir) => createStore({
  graphDir: path.join(dir, "graphs"),
  hashCacheFile: path.join(dir, "model-hashes.json"),
  outputDir: outDir,
  inputDir: path.join(dir, "input"),
  prov: ledger(ledgerDir),
});

const FAST = { POLL_MS: 5, POLL_TIMEOUT_MS: 150, POST_TIMEOUT_MS: 150, MAX_CONSECUTIVE_POLL_FAILURES: 3, MAX_VANISHED_POLLS: 2 };

/**
 * A ComfyUI that is not there. Records every call so "was anything sent" is a
 * number, and lets each test say how the engine behaves this time.
 */
function fakeEngine({ historyAfter = 1, completed = true, rejectPost = false, vanish = false, dead = false, outputs = null, armed = true } = {}) {
  const calls = [];
  let polls = 0;
  const reply = (obj, { ok: isOk = true, status = 200, text = "" } = {}) => ({
    ok: isOk, status,
    json: async () => obj,
    text: async () => text || JSON.stringify(obj),
  });
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || "GET" });
    if (dead) throw new Error("ECONNREFUSED");
    if (u.includes("/prompt")) {
      if (rejectPost) return reply({}, { ok: false, status: 400, text: "Prompt has no outputs" });
      return reply({ prompt_id: "b41cfeed" });
    }
    if (u.includes("/history/")) {
      polls++;
      if (vanish || polls < historyAfter) return reply({});
      return reply({
        b41cfeed: {
          status: completed
            ? { status_str: "success", completed: true }
            : { status_str: "error", completed: false, messages: [["execution_error", { exception_message: "CUDA out of memory" }]] },
          outputs: outputs ?? { 21: { videos: [{ filename: "arm3_00001.mp4", subfolder: "gate", type: "output" }] } },
        },
      });
    }
    if (u.includes("/queue")) return reply({ queue_running: vanish ? [] : [[0, "b41cfeed"]], queue_pending: [] });
    /* The Studio's safety node inside ComfyUI, saying whether it is armed. */
    if (u.includes("/aiplay/safety_status")) return reply({ armed, node: "aiplay_safety_gate" });
    if (u.includes("/system_stats")) {
      return reply({ system: { comfyui_version: "0.33.0", argv: ["D:\\rig\\ComfyUI\\main.py", "--port", "47821", "--listen", "127.0.0.1"] } });
    }
    return reply({});
  };
  return { fetchImpl, calls, posts: () => calls.filter((c) => c.url.includes("/prompt")) };
}

/** A client wired to a fake engine and a temp ledger, with a live "child". */
function clientOn(engineStub, { dir = tmp, prov = ledger(ledgerDir), port = 47821, ...rest } = {}) {
  const c = createEngineClient({
    provenance: prov, fetch: engineStub.fetchImpl, store: makeStore(dir), poll: FAST, port, ...rest,
  });
  c.attachChild({ exitCode: null, signalCode: null });
  return c;
}

/* ── 1. ledger before POST, by index in the source ─────────────────────────
 *
 * The weaker of the two proofs, kept because it names the exact edit that would
 * break the stronger one. Comments are stripped first — this file's own prose
 * says "/prompt" several times, and a gate that reads its own documentation as
 * code teaches people to stop writing documentation. */
console.log("\n  -- the ledger is written before the engine is touched --");
{
  const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const src = codeOf(readFileSync(path.join(HERE, "client.js"), "utf8"));
  const delegateAt = src.indexOf('type: "delegate"');
  const promptAt = src.indexOf("/prompt");
  ok("client.js appends the delegate event before it names /prompt at all",
    delegateAt > 0 && promptAt > 0 && delegateAt < promptAt, `delegate ${delegateAt}, /prompt ${promptAt}`);

  const appendAt = src.lastIndexOf("prov.append", delegateAt);
  const line = src.slice(src.lastIndexOf("\n", appendAt) + 1, src.indexOf("\n", appendAt));
  ok("...and that append is AWAITED", /await\s+prov\.append/.test(line), line.trim());
  ok("...with no .catch() on it — here, and only here, a ledger failure costs the render",
    !line.includes(".catch("), line.trim());

  /* And the POST is the very next wire call after it — nothing is fetched in
   * between. Matched case-insensitively on purpose: the call site is the
   * INJECTED `doFetch`, and a check that only knew the word `fetch(` would have
   * quietly matched nothing and passed. */
  const wireAt = [...src.matchAll(/[a-zA-Z]*[Ff]etch\s*\(/g)].map((m) => m.index).find((i) => i > delegateAt);
  ok("...and the very next wire call in the file is that POST",
    wireAt !== undefined && wireAt < promptAt && promptAt - wireAt < 60,
    `next call at ${wireAt}, /prompt at ${promptAt}`);
}

/* ── 2. ledger before POST, by counting fetches ────────────────────────────
 *
 * THE PROOF THAT MATTERS. */
console.log("\n  -- a ledger that throws means NOTHING was sent --");
{
  const stub = fakeEngine();
  const c = clientOn(stub, {
    prov: { append: async () => { throw new Error("disk full: the provenance ledger could not be appended"); },
            read: async () => ({ events: [] }) },
  });
  let threw = null;
  try { await c.run({ graph: LTX_VIDEO_GRAPH, actor: "script:gate_run", via: "api" }); }
  catch (e) { threw = e; }
  ok("dispatch throws when the ledger throws", !!threw);
  ok("...and the message names the ledger, not the engine",
    !!threw && /provenance ledger/i.test(threw.message), threw?.message);
  ok("...and the engine was NEVER contacted: zero fetches of any kind",
    stub.calls.length === 0, JSON.stringify(stub.calls));
}

/* ── 3. the two events, in order, on one asset ─────────────────────────── */
console.log("\n  -- one delegate before the POST, one generate after the terminal poll --");
let happyRunId = null;
{
  /* Its own store directory, so this really is the first time this graph has
   * been seen — which is what makes the `cached` assertion below mean
   * something. The throwing-ledger run above stored the same graph. */
  const stub = fakeEngine({ historyAfter: 2 });
  const c = clientOn(stub, { dir: path.join(tmp, "happy") });
  const r = await c.run({
    graph: LTX_VIDEO_GRAPH, actor: "script:gate_run", via: "api",
    label: "gate arm 3 strength 0.30", project: "measure-twice", shot: "s03",
  });
  happyRunId = r.runId;
  ok("the run completes", r.ok === true && r.status === "completed", JSON.stringify({ ok: r.ok, status: r.status, error: r.error }));

  const { events } = await provenance.read({ dir: ledgerDir }, { asset: `engine/${r.runId}` });
  ok("exactly two events, on engine/<runId>", events.length === 2, JSON.stringify(events.map((e) => e.type)));
  ok("...a delegate first, then a generate",
    events[0]?.type === "delegate" && events[1]?.type === "generate");
  ok("...both carrying the harness's own name, not `system`",
    events.every((e) => e.actor === "script:gate_run"), events.map((e) => e.actor).join(","));

  const posts = stub.posts();
  ok("exactly one POST reached the engine", posts.length === 1, JSON.stringify(posts));

  const gen = events[1].data;
  ok("the generate carries the prompt_id the engine answered with", gen.promptId === "b41cfeed");
  ok("...the wall time", typeof gen.elapsedSec === "number" && gen.elapsedSec >= 0);
  ok("...the queued time, measured rather than assumed", gen.queuedSec !== undefined);
  ok("...and whether ComfyUI served it from cache — false, this graph is new here",
    gen.cached === false);
  ok("the output is named, sized and HASHED",
    gen.outputs?.[0]?.file === "arm3_00001.mp4" && gen.outputs[0].bytes === OUTPUT_BYTES.length
    && /^sha256:[0-9a-f]{64}$/.test(gen.outputs[0].sha256 || ""), JSON.stringify(gen.outputs));

  /* The rights stamp travels with the model, and the model came from the
   * GRAPH'S OWN FILES — no caller named it. */
  ok("the licence class is stamped from the model the graph's weights resolve to",
    gen.model === "ltx" && gen.outputRights?.capability === "videoLtx", JSON.stringify(gen.outputRights));

  const del = events[0].data;
  ok("the delegate stored the graph content-addressed",
    /^graphs\/sha256-[0-9a-f]{64}\.json$/.test(del.graphStored || ""), del.graphStored);
  ok("...and the stored graph is the graph that ran",
    JSON.stringify(await makeStore(path.join(tmp, "happy")).getGraph(del.graphHash)) === JSON.stringify(LTX_VIDEO_GRAPH));
  ok("the chain over both events verifies", (await provenance.verify({ dir: ledgerDir })).ok === true);

  /* The SECOND identical run: back in under two seconds, and this graph has now
   * been seen. Two facts, not one — a fast render of a graph nobody has run
   * before is a fast render, not a cache hit. */
  const again = await c.run({ graph: LTX_VIDEO_GRAPH, actor: "script:gate_run", via: "api" });
  const { events: ev2 } = await provenance.read({ dir: ledgerDir }, { asset: `engine/${again.runId}` });
  ok("a second identical run that returns instantly is reported as cache-served",
    ev2[1]?.data.cached === true, JSON.stringify({ cached: ev2[1]?.data.cached, secs: ev2[1]?.data.elapsedSec }));
}

/* ── 4. the record is complete ─────────────────────────────────────────── */
console.log("\n  -- every field the record promises, on three real graph shapes --");
{
  const c = clientOn(fakeEngine());
  for (const [name, graph] of [["LTX video", LTX_VIDEO_GRAPH], ["FLUX image", FLUX_IMAGE_GRAPH], ["the judge (no file output)", TEXT_JUDGE_GRAPH]]) {
    const { record } = await c.dispatch({ graph, actor: "agent:claude", via: "api", dryRun: true, label: name });
    const missing = RECORD_FIELDS.filter((f) => record[f] === undefined);
    ok(`${name}: every promised field is present`, missing.length === 0, missing.join(", "));
    ok(`${name}: the graph is hashed order-independently`, /^sha256:[0-9a-f]{64}$/.test(record.graphHash));
    ok(`${name}: the app version is recorded`, /AIPLAY Studio/.test(record.appVersion || ""), record.appVersion);
    ok(`${name}: the port mode is recorded, as a word`, record.enginePort === "ephemeral", record.enginePort);
  }

  const { record: ltx } = await c.dispatch({ graph: LTX_VIDEO_GRAPH, actor: "user", via: "api", dryRun: true });
  ok("LTX: the seed is found on RandomNoise, where LTX actually keeps it", ltx.seed === 31337);
  ok("LTX: the size and frame count come off the latent", ltx.width === 1280 && ltx.height === 704 && ltx.frames === 121);
  ok("LTX: fps is agreed across three nodes and hoisted once", ltx.fps === 24 && ltx.seconds > 5 && ltx.seconds < 5.1);
  ok("LTX: the positive prompt is walked back through the guide chain",
    /concrete corridor/.test(ltx.prompt || ""), ltx.prompt);
  ok("LTX: ...and the negative is its own text, not the positive again",
    ltx.negative === "blurry, watermark, text, low quality");
  ok("LTX: both prompts are hashed", /^sha256:/.test(ltx.promptHash) && /^sha256:/.test(ltx.negativeHash));
  ok("LTX: every model file is named, with its real size on this machine",
    ltx.engineFiles.length === 4 && ltx.engineFiles.every((f) => typeof f.file === "string"),
    JSON.stringify(ltx.engineFiles.map((f) => [f.file, f.bytes])));
  ok("LTX: the LoRA is recorded separately, with its strength",
    ltx.loras.length === 1 && ltx.loras[0].strength_model === 1);
  ok("LTX: ...and a LoRA never gets to name the model", ltx.model === "ltx");
  ok("LTX: the reference image is listed", ltx.references[0]?.file === "aiplay_ref_9f21.png");
  ok("LTX: the output prefix is recorded", ltx.outputPrefixes[0] === "gate/arm3");
  ok("LTX: no digest of the weights, because hashModels is off by default",
    ltx.engineFiles.every((f) => f.sha256 === null));

  const { record: flux } = await c.dispatch({ graph: FLUX_IMAGE_GRAPH, actor: "user", via: "api", dryRun: true });
  ok("FLUX: steps are found on the scheduler, which is not called a sampler", flux.steps === 4);
  ok("FLUX: a zeroed negative is recorded as EMPTY, not as the positive prompt again",
    flux.negative === "" && flux.prompt !== "", JSON.stringify({ p: flux.prompt?.slice(0, 20), n: flux.negative }));
  ok("FLUX: the model resolves to the catalogue key", flux.model === "flux2");
  ok("FLUX: both save prefixes are recorded", flux.outputPrefixes.length === 2);

  const { record: judge } = await c.dispatch({ graph: TEXT_JUDGE_GRAPH, actor: "user", via: "api", dryRun: true });
  ok("the judge writes no file, and the record says so", judge.outputPrefixes.length === 0 && judge.latents.length === 0);
  ok("...its prompt is still recorded, because it is the graph's only text",
    /sound-effect cues/.test(judge.prompt || "") && judge.promptFrom === "sole-text");
  ok("...and its model is null, so no licence is invented for a text encoder", judge.model === null);
}

/* ── 5. the record is honest ───────────────────────────────────────────── */
console.log("\n  -- what the record refuses to claim --");
{
  const two = buildRecord(TWO_SAMPLER_GRAPH, {});
  ok("two samplers: both are kept", two.samplers.length === 2);
  ok("...and nothing is hoisted, because 'the seed' has two answers here",
    two.seed === null && two.steps === null && two.cfg === null);
  ok("...but every seed is there to be read", two.samplers.map((s) => s.seed).sort().join() === "111,222");

  const un = buildRecord(UNWALKABLE_GRAPH, {});
  ok("an unwalkable graph claims no prompt", un.promptResolved === false && un.prompt === null && un.promptFrom === null);
  ok("...and still keeps every text it found", un.texts.length === 2);

  ok("an unknown checkpoint leaves the model null, so no rights are stamped",
    two.model === null && un.model === null);

  const reordered = Object.fromEntries(Object.entries(LTX_VIDEO_GRAPH).reverse());
  ok("the graph hash is order-independent — one sweep, one stored graph",
    buildRecord(reordered, {}).graphHash === buildRecord(LTX_VIDEO_GRAPH, {}).graphHash);

  const long = { 1: { class_type: "CLIPTextEncode", inputs: { text: "x".repeat(9000) } } };
  const capped = buildRecord(long, {});
  ok("a 9000-character prompt is capped in the line...", capped.prompt.length === 4000 && capped.promptTruncated === true);
  ok("...but hashed WHOLE, or the hash would match nothing",
    capped.promptHash === buildRecord({ 1: { class_type: "CLIPTextEncode", inputs: { text: "x".repeat(9000) } } }, {}).promptHash
    && capped.promptHash !== buildRecord({ 1: { class_type: "CLIPTextEncode", inputs: { text: "x".repeat(4000) } } }, {}).promptHash);
}

/* ── 6. the two save formats ───────────────────────────────────────────── */
console.log("\n  -- the editor save and the API save, told apart before anything is spent --");
{
  const stub = fakeEngine();
  const c = clientOn(stub);
  let threw = null;
  try { await c.run({ graph: UI_FORMAT_GRAPH, actor: "user", via: "api" }); } catch (e) { threw = e; }
  ok("a UI-format save is refused", !!threw);
  ok("...and the message says WHICH format it is and what to do",
    /Save \(API Format\)/.test(threw?.message || "") && /Dev Mode/.test(threw?.message || ""), threw?.message);
  ok("...with nothing sent and nothing written", stub.calls.length === 0);
  ok("a dangling link is named with the node that dangles",
    graphProblems({ 1: { class_type: "A", inputs: { x: ["99", 0] } } })[0]?.includes("node 99"));
}

/* ── 7. the failures each terminate, and each are recorded ─────────────── */
console.log("\n  -- a render that fails leaves a record; before this door it left nothing --");
{
  // The engine refuses the job outright.
  const stub = fakeEngine({ rejectPost: true });
  const c = clientOn(stub);
  let threw = null;
  try { await c.run({ graph: FLUX_IMAGE_GRAPH, actor: "user", via: "art.cover" }); } catch (e) { threw = e; }
  ok("a rejected POST throws", !!threw && threw.status === "rejected");
  const { events } = await provenance.read({ dir: ledgerDir }, { asset: `engine/${threw.runId}` });
  ok("...and the delegate is NOT left dangling: a completion event says rejected",
    events.length === 2 && events[1].data.status === "rejected", JSON.stringify(events.map((e) => e.type)));
  ok("...naming the engine's own complaint", /Prompt has no outputs/.test(events[1].data.error || ""));
}
{
  // The engine reports an error (the OOM this rig actually produces).
  const c = clientOn(fakeEngine({ completed: false }));
  const r = await c.run({ graph: LTX_VIDEO_GRAPH, actor: "user", via: "api" });
  ok("an engine error is a result, not an exception", r.ok === false && r.status === "error");
  ok("...and the OOM message survives into the ledger", /out of memory/i.test(r.error || ""), r.error);
  const { events } = await provenance.read({ dir: ledgerDir }, { asset: `engine/${r.runId}` });
  ok("...as a generate event with status error", events[1]?.data?.status === "error");
}
{
  // The engine stops answering mid-render — the OOM that takes the process.
  const c = clientOn(fakeEngine({ dead: false }), {});
  const stub = fakeEngine();
  let n = 0;
  const dying = createEngineClient({
    provenance: ledger(ledgerDir), store: makeStore(tmp), poll: FAST, port: 47821,
    fetch: async (url, opts) => {
      if (String(url).includes("/history/") && ++n > 0) throw new Error("ECONNRESET");
      return stub.fetchImpl(url, opts);
    },
  });
  dying.attachChild({ exitCode: null, signalCode: null });
  const r = await dying.run({ graph: LTX_VIDEO_GRAPH, actor: "user", via: "api" });
  ok("an engine that stops answering terminates, bounded, instead of hanging",
    r.ok === false && r.status === "error" && /stopped answering/.test(r.error || ""), r.error);
  ok("...after exactly the configured number of consecutive failures", n === FAST.MAX_CONSECUTIVE_POLL_FAILURES, String(n));
  void c;
}
{
  // The prompt is in neither /history nor /queue: a restart discarded it.
  const c = clientOn(fakeEngine({ vanish: true }));
  const r = await c.run({ graph: LTX_VIDEO_GRAPH, actor: "user", via: "api" });
  ok("a vanished prompt is named as GONE, not left pending for ever",
    r.status === "vanished" && /restart discards history/.test(r.error || ""), r.error);
}
{
  // Past its deadline.
  const c = clientOn(fakeEngine({ historyAfter: 10_000 }));
  const r = await c.run({ graph: LTX_VIDEO_GRAPH, actor: "user", via: "api", timeoutMs: 40 });
  ok("a job past its own deadline is abandoned, and says so", r.status === "timeout", r.error);
  ok("...and the caller's deadline is what was used, not a constant",
    r.record.timeoutMs === 40 && r.elapsedSec < 5);
}

/* ── 7b. THE DEADLINE STARTS WHEN THE ENGINE DOES ──────────────────────────
 *
 * The defect these prove is in this app's own ledger. Run `mtm1al5b70067f`:
 * `status: "timeout"`, `elapsedSec: 1800.456`, `queuedSec: 3.685` — and the
 * render finished and wrote its files, while a 32-minute pass held the engine
 * ahead of it. The clock was started at QUEUEING, and `queuedSec` was measured
 * to the moment the prompt appeared in EITHER queue list rather than to the
 * moment ComfyUI started it, so it recorded one poll of waiting instead of half
 * an hour of it. A ledger that is wrong about the expensive thing is worse than
 * no ledger, because it is believed.
 *
 * Both facts here are DURATIONS, so this fake engine is driven by the clock
 * rather than by a poll count: a poll-count fake would go on passing a build
 * that had quietly gone back to counting from t0. */
console.log("\n  -- a job waiting behind another render is not late; a job that stopped is --");
function queueingEngine({ pendingMs = 0, runsForMs = 0, neverFinishes = false } = {}) {
  const born = Date.now();
  const since = () => Date.now() - born;
  const reply = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
  const ID = "q0ffee";
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("/prompt")) return reply({ prompt_id: ID });
    if (u.includes("/history/")) {
      if (neverFinishes || since() < pendingMs + runsForMs) return reply({});
      return reply({
        [ID]: {
          status: { status_str: "success", completed: true },
          outputs: { 21: { videos: [{ filename: "arm3_00001.mp4", subfolder: "gate", type: "output" }] } },
        },
      });
    }
    if (u.includes("/queue")) {
      /* THE TWO LISTS, TOLD APART — which is the whole fix. While the job ahead
       * of it holds the engine, ours is PENDING, and pending is not started. */
      if (since() < pendingMs) return reply({ queue_running: [[0, "the-job-ahead"]], queue_pending: [[1, ID]] });
      if (neverFinishes || since() < pendingMs + runsForMs) return reply({ queue_running: [[1, ID]], queue_pending: [] });
      return reply({ queue_running: [], queue_pending: [] });
    }
    if (u.includes("/system_stats")) return reply({ system: { comfyui_version: "0.33.0", argv: ["D:\\rig\\ComfyUI\\main.py"] } });
    return reply({});
  };
  return { fetchImpl };
}
{
  /* (1) Queued 4 s behind another render, then renders in half a second, with a
   * THREE-second deadline. Under the old rule this is a `timeout` at 3 s flat,
   * recorded against a run that then wrote its file — the ledger row above. */
  const c = clientOn(queueingEngine({ pendingMs: 4000, runsForMs: 500 }), { dir: path.join(tmp, "queued") });
  const r = await c.run({ graph: LTX_VIDEO_GRAPH, actor: "script:gate_run", via: "api", timeoutMs: 3000, pollMs: 50 });
  ok("a job queued 4 s behind another render, with a 3 s deadline, COMPLETES",
    r.ok === true && r.status === "completed", `${r.status}: ${r.error}`);
  ok("...even though the wall clock passed that deadline before it finished",
    r.elapsedSec > 3, `elapsedSec ${r.elapsedSec}`);
  ok("...and the queued time is measured to the moment the ENGINE started it, not to the first poll",
    r.queuedSec > 3.5 && r.queuedSec < 4.8, `queuedSec ${r.queuedSec}`);
  ok("...so the render's own time is the small number it really was",
    r.runningSec !== null && r.runningSec < 3 && r.runningSec < r.elapsedSec,
    `runningSec ${r.runningSec} of elapsed ${r.elapsedSec}`);
  const { events } = await provenance.read({ dir: ledgerDir }, { asset: `engine/${r.runId}` });
  ok("...and the LEDGER says completed, with all three numbers",
    events[1]?.data?.status === "completed"
    && Number.isFinite(events[1].data.elapsedSec)
    && Number.isFinite(events[1].data.queuedSec)
    && Number.isFinite(events[1].data.runningSec),
    JSON.stringify(events[1]?.data && { status: events[1].data.status, e: events[1].data.elapsedSec, q: events[1].data.queuedSec, r: events[1].data.runningSec }));
}
{
  /* (2) THE OTHER HALF, and the reason this is not merely "wait longer": a job
   * the engine really abandons must still time out — at its own deadline,
   * measured from the moment it started. */
  const c = clientOn(queueingEngine({ pendingMs: 500, neverFinishes: true }), { dir: path.join(tmp, "stuck") });
  const t = Date.now();
  const r = await c.run({ graph: LTX_VIDEO_GRAPH, actor: "script:gate_run", via: "api", timeoutMs: 2000, pollMs: 50 });
  const wall = (Date.now() - t) / 1000;
  ok("a job that starts and never finishes still times out", r.status === "timeout", r.error);
  ok("...2 s after it STARTED, not 2 s after it was queued",
    r.runningSec > 1.9 && r.runningSec < 2.6, `runningSec ${r.runningSec}`);
  ok("...which is half a second of queue later on the wall clock",
    wall > 2.4 && r.queuedSec > 0.4 && r.queuedSec < 1.2, `wall ${wall.toFixed(2)}s, queuedSec ${r.queuedSec}`);
  ok("...and the record SAYS that is what happened",
    /STARTED on the engine/.test(r.error || "") && /queue/.test(r.error || ""), r.error);
  const { events } = await provenance.read({ dir: ledgerDir }, { asset: `engine/${r.runId}` });
  ok("...in the ledger, as a timeout that separates the queue from the render",
    events[1]?.data?.status === "timeout" && events[1].data.queuedSec < events[1].data.elapsedSec,
    JSON.stringify(events[1]?.data && { status: events[1].data.status, e: events[1].data.elapsedSec, q: events[1].data.queuedSec }));
}
{
  /* And the LIVE view says which of the two is happening right now, because a
   * panel — and the base repo's harnesses, which poll this to learn when their
   * own job really started — cannot get that out of one elapsed number. */
  const c = clientOn(queueingEngine({ pendingMs: 600, runsForMs: 400 }), { dir: path.join(tmp, "live") });
  const running = c.run({ graph: LTX_VIDEO_GRAPH, actor: "user", via: "api", timeoutMs: 5000, pollMs: 50 });
  await new Promise((res) => setTimeout(res, 250));
  const waiting = (await c.status()).running[0];
  await new Promise((res) => setTimeout(res, 500));
  const live = (await c.status()).running[0];
  await running;
  ok("status() calls a waiting job queued, with no running time yet",
    waiting?.state === "queued" && waiting.queuedSec === null && waiting.runningSec === null, JSON.stringify(waiting));
  ok("...and a started one running, with the queue it sat through beside it",
    live?.state === "running" && live.queuedSec > 0.4 && live.runningSec >= 0, JSON.stringify(live));
}

/* ── 8. submit(): returns early, records anyway ────────────────────────── */
console.log("\n  -- wait:false returns after the POST, and the app still finishes the record --");
{
  const stub = fakeEngine({ historyAfter: 3 });
  const c = clientOn(stub);
  const r = await c.submit({ graph: FLUX_IMAGE_GRAPH, actor: "agent:mcp", via: "jobs.music", claim: "covers/x.png" });
  ok("submit returns a runId immediately, with the job still running",
    r.status === "running" && !!r.runId && !!r.promptId);
  const early = await provenance.read({ dir: ledgerDir }, { asset: `engine/${r.runId}` });
  ok("...the delegate is already written", early.events.length === 1 && early.events[0].type === "delegate");
  for (let i = 0; i < 100 && (await provenance.read({ dir: ledgerDir }, { asset: `engine/${r.runId}` })).events.length < 2; i++) {
    await new Promise((s) => setTimeout(s, 10));
  }
  const late = await provenance.read({ dir: ledgerDir }, { asset: `engine/${r.runId}` });
  ok("...and the completion lands without the caller ever coming back",
    late.events.length === 2 && late.events[1].data.status === "completed", JSON.stringify(late.events.map((e) => e.type)));
  ok("a claimed output is filed under the caller's own name, not adopted twice",
    late.events[1].data.outputs[0]?.adoptedAs === "covers/x.png");
}

/* ── 9. the door refuses what it cannot attribute ──────────────────────── */
console.log("\n  -- what dispatch will not do --");
{
  const stub = fakeEngine();
  const c = clientOn(stub);
  let threw = null;
  try { await c.run({ graph: LTX_VIDEO_GRAPH, actor: "user" }); } catch (e) { threw = e; }
  ok("a dispatch with no `via` is refused", !!threw && /needs `via`/.test(threw.message));
  ok("...and it names the callers that exist, so the id is not invented",
    /art\.cover/.test(threw?.message || "") && /mv\.sfx_judge/.test(threw?.message || ""));

  const orphan = createEngineClient({ provenance: ledger(ledgerDir), store: makeStore(tmp), poll: FAST, port: 47821, fetch: stub.fetchImpl });
  threw = null;
  try { await orphan.run({ graph: LTX_VIDEO_GRAPH, actor: "user", via: "api" }); } catch (e) { threw = e; }
  ok("a dispatch with no live child of OUR OWN is refused — a port is not an identity",
    !!threw && /not alive/.test(threw.message), threw?.message);
  ok("...and still nothing was sent", stub.posts().length === 0);

  ok("an unattributable actor becomes system, never user",
    provenance.normalizeActor("totally-a-human") === "system");
}

/* ── 10. nothing advertises the port ───────────────────────────────────── */
console.log("\n  -- the port is not an interface --");
{
  const stub = fakeEngine();
  const c = clientOn(stub, { port: 47821 });
  const st = await c.status();
  const id = await c.identity();
  const hay = JSON.stringify(st) + JSON.stringify(id);
  ok("ephemeral: status() and identity() contain the port nowhere at all",
    !hay.includes("47821") && st.port === null && id.port === null, hay.slice(0, 300));
  ok("...but they DO say which mode it is in, which is the useful half",
    st.mode === "ephemeral" && st.pinned === false && st.revealed === false);
  ok("identity answers from the engine's own argv, not from a port",
    id.version === "0.33.0" && /main\.py$/.test(id.mainPy || ""));
  ok("...and names the mismatch when the engine is another install's",
    id.problems.length > 0 && /--output-directory/.test(id.problems.join(" ")), JSON.stringify(id.problems));

  /* THE MINORS BACKSTOP GATES THE REVEAL: an engine whose safety node is not
   * armed does not get its port handed out, and nothing is recorded. */
  {
    const unarmed = clientOn(fakeEngine({ armed: false }), { port: 47822 });
    let threw = null;
    try { await unarmed.reveal({ actor: "user" }); } catch (e) { threw = e; }
    const st0 = await unarmed.status();
    ok("an engine whose safety backstop is not armed does not get its port revealed",
      threw?.reason === "backstop-not-armed" && /safety check/.test(threw.message) && st0.port === null && st0.revealed === false,
      threw?.message);
  }
  await c.reveal({ actor: "user" });
  const st2 = await c.status();
  ok("revealed: the number IS returned, because now it is already discoverable",
    st2.port === 47821 && st2.mode === "revealed");
  const revealed = await provenance.read({ dir: ledgerDir }, { asset: "engine" });
  ok("...and revealing it left a dated line in the ledger",
    revealed.events.some((e) => e.type === "choice" && e.data.op === "reveal_engine_port"));

  const pinnedClient = clientOn(fakeEngine());
  pinnedClient.pinPort(8266, "AIPLAY_COMFY_PORT");
  const st3 = await pinnedClient.status();
  ok("pinned: the same, and the mode says why", st3.port === 8266 && st3.mode === "pinned");
  await pinnedClient.announcePort();
  const announced = await provenance.read({ dir: ledgerDir }, { asset: "engine" });
  const pin = announced.events.filter((e) => e.data?.op === "engine_port").pop();
  ok("a pinned session says out loud, in the ledger, what it costs",
    pin?.data.mode === "pinned" && /will not appear here/.test(pin?.data.note || ""), JSON.stringify(pin?.data));
}

/* ── 11. the ephemeral port is real ────────────────────────────────────── */
console.log("\n  -- a number that cannot be copied because it is never the same --");
{
  const c = createEngineClient({ provenance: ledger(ledgerDir), store: makeStore(tmp), poll: FAST });
  const a = await c.reservePort();
  const b = await c.reservePort();
  ok("reservePort binds a real, free, loopback port", Number.isInteger(a) && a > 1024 && a < 65536, String(a));
  ok("...and does not hand out the same one twice in a row", a !== b, `${a} then ${b}`);

  let rebound = 0;
  c.on("rebound", () => { rebound++; });
  await c.reservePort();
  ok("...and tells socket holders when the port moved under them", rebound === 1);

  const announce = await c.announcePort();
  ok("an ephemeral start records the mode and NOT the number",
    announce?.data.mode === "ephemeral" && announce?.data.port === undefined, JSON.stringify(announce?.data));
}

/* ── 12. reading it back ───────────────────────────────────────────────── */
console.log("\n  -- what happened on this machine last night --");
{
  const c = clientOn(fakeEngine());
  const act = await c.activity({ limit: 50 });
  ok("activity joins each run's request and result into one row", act.total >= 4, String(act.total));
  ok("...newest first", act.runs.length > 1 && act.runs[0].t >= act.runs[1].t);
  const byScript = await c.activity({ actor: "script:gate_run" });
  ok("...and can be asked what ONE harness did", byScript.runs.every((r) => r.actor === "script:gate_run") && byScript.total >= 1);
  const one = await c.runRecord(happyRunId, { graph: true });
  ok("one run's complete record comes back with the graph itself",
    one?.request?.graphHash && one?.result?.status === "completed" && Object.keys(one.graph || {}).length === 24);
  ok("...which is what makes the render reproducible rather than merely described",
    JSON.stringify(one.graph) === JSON.stringify(LTX_VIDEO_GRAPH));
}

/* ── 13. LEDGER-BEFORE-POST, THE ASYMMETRY ─────────────────────────────────
 *
 * Section 2 proved that a ledger which throws means nothing was sent. That is
 * the headline, and on its own it is compatible with a much worse design: a
 * client that treats ANY ledger failure as fatal. It is not, and must not be.
 *
 * The bargain in this application is normally the opposite one — provenance.js
 * tells its callers to `.catch()` because a ledger failure must never cost the
 * media. `dispatch()` inverts that in EXACTLY ONE PLACE, the delegate, because
 * there the media is the thing being recorded and nothing has been spent yet.
 * After the POST the inversion would be indefensible: the GPU has already run,
 * the file is already on disk, and throwing would lose a render to protect a
 * record of it.
 *
 * So the proof needs both halves, and a ledger that throws on every call cannot
 * tell them apart. These use a ledger that throws on ONE append and works on
 * the other.
 */
console.log("\n  -- a throwing DELEGATE costs the render; a throwing GENERATE must not --");
{
  /** A real ledger with one append poisoned by its position in the sequence. */
  const poisoned = (nth) => {
    let n = 0;
    return {
      append: async (_scope, evt) => {
        if (++n === nth) throw new Error("disk full: the provenance ledger could not be appended");
        return provenance.append({ dir: ledgerDir }, evt);
      },
      read: (_s, opts) => provenance.read({ dir: ledgerDir }, opts),
    };
  };

  /* (a) THE DELEGATE THROWS. Nothing may be sent — and, unlike section 2, the
   *     ledger here is perfectly healthy for every other write, so this cannot
   *     pass by accident on a client that simply gave up early. */
  {
    const stub = fakeEngine({ historyAfter: 2 });
    const c = clientOn(stub, { dir: path.join(tmp, "poison1"), prov: poisoned(1) });
    let threw = null;
    try { await c.run({ graph: LTX_VIDEO_GRAPH, actor: "script:gate_run", via: "api", label: "delegate poisoned" }); }
    catch (e) { threw = e; }
    ok("the delegate throwing aborts the run", !!threw, "dispatch resolved");
    ok("...naming the ledger rather than the engine",
      !!threw && /provenance ledger/i.test(threw.message), threw?.message);
    ok("...and the engine was never contacted at all: zero calls of any kind",
      stub.calls.length === 0, JSON.stringify(stub.calls));
  }

  /* (b) THE GENERATE THROWS. The POST happened, the render finished, the file
   *     exists. Losing it now to protect a record of it would be the exact
   *     inversion this design is careful NOT to make. */
  {
    const stub = fakeEngine({ historyAfter: 2 });
    const c = clientOn(stub, { dir: path.join(tmp, "poison2"), prov: poisoned(2) });
    let threw = null, r = null;
    try { r = await c.run({ graph: LTX_VIDEO_GRAPH, actor: "script:gate_run", via: "api", label: "generate poisoned" }); }
    catch (e) { threw = e; }
    ok("a completion event that cannot be written does NOT throw", threw === null, threw?.message);
    ok("...the POST still happened", stub.posts().length === 1, JSON.stringify(stub.posts()));
    ok("...and the caller still gets its outputs, hashed",
      r?.status === "completed" && /^sha256:[0-9a-f]{64}$/.test(r?.outputs?.[0]?.sha256 || ""),
      JSON.stringify({ status: r?.status, outputs: r?.outputs }));
    ok("...the delegate is on disk, so the run is not invisible — it is incomplete, "
      + "which is a different and much smaller lie",
      (await provenance.read({ dir: ledgerDir }, { asset: `engine/${r?.runId}` })).events.length === 1);
    ok("...and the chain the app kept is still valid",
      (await provenance.verify({ dir: ledgerDir })).ok === true);
  }

  /* (c) A REJECTION, not an exception. `prov.append` is async, and a rejected
   *     promise is the shape a real disk error actually arrives in — a client
   *     that only guarded a synchronous throw would post anyway. */
  {
    const stub = fakeEngine();
    const c = clientOn(stub, {
      dir: path.join(tmp, "poison3"),
      prov: { append: () => Promise.reject(new Error("EROFS: the provenance ledger is read-only")),
              read: async () => ({ events: [] }) },
    });
    let threw = null;
    try { await c.run({ graph: LTX_VIDEO_GRAPH, actor: "user", via: "api" }); } catch (e) { threw = e; }
    ok("an append that REJECTS is as fatal as one that throws",
      !!threw && /read-only/.test(threw.message) && stub.calls.length === 0,
      `${threw?.message} / ${stub.calls.length} calls`);
  }

  /* (d) AND A DRY RUN WRITES NOTHING EITHER WAY. It is the one path that
   *     deliberately skips the delegate, so it is also the one path where a
   *     mistake would look like a working feature. */
  {
    const stub = fakeEngine();
    let appends = 0;
    const c = clientOn(stub, {
      dir: path.join(tmp, "poison4"),
      prov: { append: async () => { appends++; return { id: "x" }; }, read: async () => ({ events: [] }) },
    });
    const r = await c.dispatch({ graph: LTX_VIDEO_GRAPH, actor: "user", via: "api", dryRun: true });
    ok("a dry run posts nothing and appends nothing",
      r.dryRun === true && stub.calls.length === 0 && appends === 0,
      `calls ${stub.calls.length}, appends ${appends}`);
  }
}

/* ── 14. §11's TABLE, AS A BUILD FAILURE ───────────────────────────────────
 *
 * The spec answers "do we save all the metadata?" with a table of thirty-odd
 * rows, each marked ❌ before and ✅ after. A table in a document is a promise;
 * this is that table as assertions over a REAL record produced by a real
 * dispatch, so a field silently dropped in some later tidy-up fails the commit
 * instead of quietly making a paragraph false.
 *
 * Each row names where the value lives — `d` for the delegate (the request,
 * written before the GPU spends anything) and `g` for the generate (the result)
 * — and every row here is one the LTX clip must be able to answer, because a
 * clip is the expensive thing and the one the library has been unable to
 * describe.
 */
/* ── THE KIND THE WALK USED TO MISS ────────────────────────────────────────
 *
 * ComfyUI files a SaveGLB output under `outputs.<node>["3d"]`, and
 * collectOutputs() walked images, videos, audio and gifs. So a graph that wrote
 * a mesh came back through this door with an EMPTY outputs array: the file was
 * on disk, the ledger recorded a completed run that produced nothing, and the
 * two disagreed forever. That is the 424-unledgered-files failure in miniature,
 * inside the very door built to make it impossible.
 *
 * ⚠ AND THE SINGULARISER MUST STAY A NO-OP ON IT. Every other kind here loses a
 * trailing "s" — images → image. "3d" has none, so it must arrive as "3d" and
 * never as "3". That is asserted separately from the collection itself, because
 * a kind that is collected and then renamed is a different bug with the same
 * symptom — nothing downstream matches it — and would pass on the first check. */
console.log("\n  -- 3d outputs: SaveGLB is collected, and its kind survives --");
{
  /* A real file, so `bytes` and `sha256` are measured off bytes rather than
   * coming back null — the same shape the mp4 fixture above uses. A GLB header
   * is enough: nothing in this door parses the container. */
  mkdirSync(path.join(outDir, "mesh"), { recursive: true });
  const GLB_BYTES = Buffer.from("676c5446020000001400000000000000", "hex");
  writeFileSync(path.join(outDir, "mesh", "prop_mesh_00001.glb"), GLB_BYTES);
  const stub = fakeEngine({
    historyAfter: 2,
    outputs: { 30: { "3d": [{ filename: "prop_mesh_00001.glb", subfolder: "mesh", type: "output" }] } },
  });
  const c = clientOn(stub, { dir: path.join(tmp, "mesh3d") });
  const r = await c.run({ graph: LTX_VIDEO_GRAPH, actor: "user", via: "api",
                          label: "a SaveGLB graph", adopt: false });
  ok("a SaveGLB output is collected rather than silently dropped",
    r.outputs.length === 1, JSON.stringify(r.outputs));
  ok("...and its kind is \"3d\", not \"3\" — the trailing-s strip is a no-op here",
    r.outputs[0]?.kind === "3d", String(r.outputs[0]?.kind));
  ok("...and it is hashed and sized like every other output",
    /^sha256:[0-9a-f]{64}$/.test(r.outputs[0]?.sha256 || "") && r.outputs[0]?.bytes >= 0,
    JSON.stringify(r.outputs[0]));
  ok("...and the completion event on disk carries it",
    (await provenance.read({ dir: ledgerDir }, { asset: `engine/${r.runId}` }))
      .events.some((e) => e.data?.outputs?.[0]?.kind === "3d"));
}

/* ── LoadVideo's echo is recorded, never shelved ─────────────────────────
 *
 * ComfyUI 0.36 makes LoadVideo report the file it READ as an output row of
 * type "input", and node-id order puts it FIRST in the enhance graph (load 1,
 * save 9). The adopter resolves every name against the OUTPUT folder, so an
 * echo that reached it would move a same-named file there into the library,
 * and a claim would file the source under the caller's name. */
console.log("\n  -- LoadVideo's input echo: recorded, never adopted or claimed --");
{
  writeFileSync(path.join(outDir, "aiplay_enh_0123456789.mp4"), "a bystander with the staged name");
  const echoFirst = {
    1: { images: [{ filename: "aiplay_enh_0123456789.mp4", subfolder: "", type: "input" }], animated: [true] },
    9: { images: [{ filename: "arm3_00001.mp4", subfolder: "gate", type: "output" }], animated: [true] },
  };
  const adopted = [];
  const spy = async ({ output }) => { adopted.push(output.file); return `clips/${output.file}`; };
  const c = clientOn(fakeEngine({ historyAfter: 2, outputs: echoFirst }), { dir: path.join(tmp, "echo"), adopt: spy });
  const r = await c.run({ graph: LTX_VIDEO_GRAPH, actor: "user", via: "api", label: "an enhance-shaped run" });
  ok("the echo is on the record, first and typed \"input\"",
    r.outputs[0]?.type === "input" && r.outputs[0]?.node === "1" && r.outputs[1]?.type === "output",
    JSON.stringify(r.outputs.map((o) => [o.node, o.type, o.file])));
  ok("...and only the file the graph WROTE reaches the adopter",
    adopted.length === 1 && adopted[0] === "arm3_00001.mp4", JSON.stringify(adopted));
  ok("...so the echo carries no library name", r.outputs[0]?.adoptedAs === null, String(r.outputs[0]?.adoptedAs));

  const claimed = await clientOn(fakeEngine({ historyAfter: 2, outputs: echoFirst }), { dir: path.join(tmp, "echo-claim") })
    .run({ graph: LTX_VIDEO_GRAPH, actor: "user", via: "api", claim: "clips/named.mp4" });
  ok("a claim names the written file, never the echo",
    claimed.outputs[0]?.adoptedAs === null && claimed.outputs[1]?.adoptedAs === "clips/named.mp4",
    JSON.stringify(claimed.outputs.map((o) => [o.type, o.adoptedAs])));
}

console.log("\n  -- §11: every row the spec promises, off one real run --");
{
  const stub = fakeEngine({ historyAfter: 2 });
  const c = clientOn(stub, { dir: path.join(tmp, "table") });
  /* The app learns the engine's version and argv ONCE, when the supervisor
   * confirms the child is ready — never from dispatch(), because dispatch must
   * make exactly one wire call before it polls or "the ledger threw, therefore
   * nothing was sent" stops being provable by counting fetches. So a started
   * app has these facts and this test has to start the same way. The case where
   * it has NOT is asserted straight after, because a null there is a real
   * possibility and must stay honest rather than becoming a guess. */
  await c.refreshFacts();
  const r = await c.run({
    graph: LTX_VIDEO_GRAPH, actor: "script:gate_run", via: "api",
    label: "gate arm 3 strength 0.30", note: "the §11 table", project: "measure-twice", shot: "s03",
  });
  const { events } = await provenance.read({ dir: ledgerDir }, { asset: `engine/${r.runId}` });
  const d = events[0]?.data ?? {}, g = events[1]?.data ?? {}, ev = events[0] ?? {};

  const filled = (v) => v !== undefined && v !== null && v !== ""
    && !(Array.isArray(v) && v.length === 0);

  const TABLE = [
    ["Actor, including the fourth class script:<name>", () => ev.actor === "script:gate_run", ev.actor],
    ["Timestamp and hash-chain link", () => !!ev.t && /^sha256:/.test(ev.prev || ""), ev.t],
    ["Output asset name", () => filled(g.outputs?.[0]?.file), g.outputs?.[0]?.file],
    ["Model, as a catalogue key, resolved from the graph's own files", () => d.model === "ltx", d.model],
    ["Output-rights stamp", () => filled(g.outputRights?.capability), g.outputRights?.capability],
    ["Seed, per sampler node", () => filled(d.samplers) && d.samplers.some((s) => s.seed !== undefined), d.seed],
    ["Positive prompt, VERBATIM", () => typeof d.prompt === "string" && d.prompt.length > 0, d.prompt],
    ["...and its hash", () => /^sha256:/.test(d.promptHash || ""), d.promptHash],
    ["Negative prompt", () => typeof d.negative === "string", JSON.stringify(d.negative)],
    /* ⚠ THE ROW THE TABLE GOT WRONG, AND THE FIXTURE CAUGHT IT.
     *
     * §11 says "Steps: songs only → ✅ all". On THIS graph there is no step
     * count to record: LTX 2.5 is driven by an explicit sigma schedule
     * (`ManualSigmas`, six values), and a number invented to fill the column
     * would be worse than the gap. So the honest pair of claims is: steps are
     * hoisted wherever a graph HAS them (FLUX puts 4 on its scheduler, and that
     * is asserted below), and where a graph does not, the schedule that
     * replaces them is kept verbatim in `samplers[]` rather than dropped. */
    ["Steps — hoisted where the graph has one, COUNTED where a sigma schedule replaces it",
      () => d.steps === null && d.samplers.some((s) => s.sigmaSteps === 6),
      `steps=${d.steps} sigmaSteps=${d.samplers.find((s) => s.sigmaSteps)?.sigmaSteps}`],
    ["cfg / sampler / scheduler / denoise, per sampler",
      () => d.samplers.some((s) => s.sampler_name !== undefined || s.cfg !== undefined),
      JSON.stringify(d.samplers?.[0])],
    ["Width / height", () => Number.isFinite(d.width) && Number.isFinite(d.height), `${d.width}x${d.height}`],
    ["Frames / fps / seconds", () => Number.isFinite(d.frames) && Number.isFinite(d.fps) && Number.isFinite(d.seconds),
      `${d.frames}f ${d.fps}fps ${d.seconds}s`],
    ["Graph hash, order-independent", () => /^sha256:[0-9a-f]{64}$/.test(d.graphHash || ""), d.graphHash],
    ["The graph ITSELF, content-addressed", () => /^graphs\/sha256-/.test(d.graphStored || ""), d.graphStored],
    ["Every model-bearing input, as a FILE", () => filled(d.engineFiles) && d.engineFiles.every((f) => filled(f.file)),
      `${d.engineFiles?.length} files`],
    ["LoRA files and their strengths", () => filled(d.loras) && d.loras.every((l) => filled(l.file)),
      JSON.stringify(d.loras)],
    ["Reference images, with SHA-256 and bytes",
      () => filled(d.references) && d.references.every((x) => filled(x.file)), JSON.stringify(d.references)],
    ["Elapsed wall time, in the LEDGER", () => Number.isFinite(g.elapsedSec), g.elapsedSec],
    ["Queued time", () => g.queuedSec !== undefined, g.queuedSec],
    ["Served from ComfyUI's cache", () => typeof g.cached === "boolean", g.cached],
    ["Output file SHA-256", () => /^sha256:[0-9a-f]{64}$/.test(g.outputs?.[0]?.sha256 || ""), g.outputs?.[0]?.sha256],
    ["Output file bytes", () => Number.isFinite(g.outputs?.[0]?.bytes), g.outputs?.[0]?.bytes],
    ["prompt_id", () => filled(g.promptId), g.promptId],
    ["ComfyUI version and launch argv (hashed)",
      () => filled(d.engineVersion) && /^sha256:/.test(d.engineArgvHash || ""), d.engineVersion],
    ["Project / shot, in the ledger", () => d.project === "measure-twice" && d.shot === "s03", `${d.project}/${d.shot}`],
    ["App version", () => /AIPLAY Studio/.test(d.appVersion || ""), d.appVersion],
    ["Engine exposure for the session", () => d.enginePort === "ephemeral", d.enginePort],
  ];

  for (const [row, test, shown] of TABLE) {
    let held = false;
    try { held = test() === true; } catch { held = false; }
    ok(`§11 ${row}`, held, `got: ${String(shown)}`);
  }

  /* THE OTHER HALF OF THE STEPS ROW, on the graph that has one. FLUX puts its
   * step count on a `Flux2Scheduler`, which is not a sampler by name — the
   * spec's "any class ending Sampler" rule would have recorded it blank. */
  const { record: flux } = await c.dispatch({ graph: FLUX_IMAGE_GRAPH, actor: "user", via: "api", dryRun: true });
  ok("§11 Steps — hoisted off a scheduler that is not called a sampler",
    flux.steps === 4, `steps=${flux.steps}`);

  /* AND THE NULL STAYS HONEST. A dispatch before the supervisor ever confirmed
   * a child — an engine that came up in a way the app did not see — records no
   * version rather than a plausible one. */
  const cold = clientOn(fakeEngine({ historyAfter: 2 }), { dir: path.join(tmp, "cold") });
  const { record: coldRec } = await cold.dispatch({ graph: LTX_VIDEO_GRAPH, actor: "user", via: "api", dryRun: true });
  ok("§11 ...and an engine whose facts were never read records null, not a guess",
    coldRec.engineVersion === null && coldRec.engineArgvHash === null,
    JSON.stringify({ v: coldRec.engineVersion, h: coldRec.engineArgvHash }));

  /* The two rows that are about a run NOT going well, which is where the old
   * ledger said nothing at all: before this door a failed render left no trace
   * of any kind, and a script-driven one could not be represented. */
  const bad = fakeEngine({ historyAfter: 2, completed: false });
  const cb = clientOn(bad, { dir: path.join(tmp, "table2") });
  const rb = await cb.run({ graph: LTX_VIDEO_GRAPH, actor: "script:gate_run", via: "api" }).catch((e) => e);
  const { events: be } = await provenance.read({ dir: ledgerDir }, { asset: `engine/${rb.runId}` });
  ok("§11 A RENDER THAT FAILED is recorded — status, error, elapsed",
    be.length === 2 && be[1].data.status === "error"
    && /out of memory/i.test(be[1].data.error || "") && Number.isFinite(be[1].data.elapsedSec),
    JSON.stringify(be[1]?.data && { status: be[1].data.status, error: be[1].data.error }));
  ok("§11 A RENDER DRIVEN BY A SCRIPT is recorded under the harness's own name",
    be.length > 0 && be.every((e) => e.actor === "script:gate_run"), be.map((e) => e.actor).join(","));
}

/* ── 15. A CANCEL IS ADDRESSED AT ONE PROMPT ───────────────────────────────
 *
 * THE DEFECT, MEASURED TWICE ON 2026-09-05: with a chat turn queued behind a
 * song, one press of the app's Stop button left that turn in NEITHER /history
 * NOR /queue (runs mto5iphvf293e7 and mto5ngyxf4893c). It wrote no output file
 * and its ledger row said `vanished` — the status this door reserves for "a
 * ComfyUI restart discarded it". Nothing had restarted. Stop was two calls
 * addressed at the ENGINE rather than at a job: `interrupt()`, which stops
 * whatever the GPU is holding, and `{clear:true}`, which empties the whole
 * pending queue. Every other actor's work went with the song, and the record
 * then blamed the engine for it.
 *
 * So the fake engine below is a QUEUE, not a single prompt: it assigns real
 * prompt ids, keeps one running and the rest pending, promotes the next when
 * one ends, applies `{delete:[id]}` to the PENDING LIST ONLY — which is what
 * ComfyUI's own `delete_queue_item` does — and counts every interrupt and every
 * clear. Three runs go into it, one is cancelled, and the other two have to be
 * exactly where they were.
 */
console.log("\n  -- cancelling one run leaves every other run where it was --");
function queuedEngine({ atomicCancel = true } = {}) {
  let n = 0;
  const running = [], pending = [], done = new Map();
  const seen = { interrupts: 0, deletes: [], clears: 0, jobCancels: [] };
  const reply = (obj, { ok: isOk = true, status = 200 } = {}) =>
    ({ ok: isOk, status, json: async () => obj, text: async () => JSON.stringify(obj) });
  const promote = () => { if (!running.length && pending.length) running.push(pending.shift()); };
  const end = (id, entry) => { done.set(id, entry); promote(); };
  const dequeue = (id) => {
    const at = pending.indexOf(id);
    if (at < 0) return false;
    pending.splice(at, 1);
    return true;
  };
  /* ComfyUI's own interrupt: the prompt lands in /history as an ERROR carrying
   * its interruption message, which is exactly why a cancelled run recorded off
   * that entry would read as a render that failed. */
  const interrupted = () => ({ status: { status_str: "error", completed: false, messages: [["execution_interrupted", {}]] }, outputs: {} });
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (u.includes("/api/jobs/")) {
      const id = decodeURIComponent(u.split("/api/jobs/")[1].replace("/cancel", ""));
      if (!atomicCancel) return reply({ error: "Not Found" }, { ok: false, status: 404 });
      seen.jobCancels.push(id);
      if (running[0] === id) { seen.interrupts++; running.shift(); end(id, interrupted()); return reply({ cancelled: true }); }
      return reply({ cancelled: dequeue(id) });
    }
    if (u.includes("/prompt")) { const id = `p${++n}`; pending.push(id); promote(); return reply({ prompt_id: id }); }
    if (u.includes("/history/")) {
      const id = u.split("/history/")[1];
      return reply(done.has(id) ? { [id]: done.get(id) } : {});
    }
    if (u.includes("/queue")) {
      if ((opts.method || "GET") === "POST") {
        if (body?.clear) { seen.clears++; pending.length = 0; }
        for (const id of body?.delete || []) { seen.deletes.push(id); dequeue(id); }
        return reply({});
      }
      return reply({
        queue_running: running.map((id, i) => [i, id]),
        queue_pending: pending.map((id, i) => [i + 1, id]),
      });
    }
    if (u.includes("/interrupt")) {
      seen.interrupts++;
      const id = running.shift();
      if (id) end(id, interrupted());
      return reply({});
    }
    if (u.includes("/system_stats")) return reply({ system: { comfyui_version: "0.33.0", argv: ["main.py"] } });
    return reply({});
  };
  return {
    fetchImpl, seen,
    state: () => ({ running: [...running], pending: [...pending] }),
    /** The engine finishing the render it is holding, of its own accord. */
    finishRunning() {
      const id = running.shift();
      if (id) {
        end(id, {
          status: { status_str: "success", completed: true },
          outputs: { 21: { videos: [{ filename: "arm3_00001.mp4", subfolder: "gate", type: "output" }] } },
        });
      }
      return id;
    },
  };
}

/** The completion event for a run, however it ended. */
async function settled(runId) {
  for (let i = 0; i < 500; i++) {
    const { events } = await provenance.read({ dir: ledgerDir }, { asset: `engine/${runId}` });
    if (events.length >= 2) return events[1].data;
    await new Promise((s) => setTimeout(s, 10));
  }
  return {};
}

{
  /* C holds the engine; A (the song) and B (the chat turn) are queued behind
   * it. A is cancelled — which is the Stop button — and B is the run that
   * disappeared. */
  const stub = queuedEngine();
  const c = clientOn(stub, { dir: path.join(tmp, "cancel-queued") });
  const C = await c.submit({ graph: LTX_VIDEO_GRAPH, actor: "user", via: "mv.control", label: "a 32-minute VACE pass" });
  const A = await c.submit({ graph: FLUX_IMAGE_GRAPH, actor: "user", via: "jobs.music", label: "the song" });
  const B = await c.submit({ graph: TEXT_JUDGE_GRAPH, actor: "agent:claude", via: "chat", label: "a chat turn" });
  ok("three runs: one holding the engine, two queued behind it",
    stub.state().running[0] === C.promptId && stub.state().pending.join() === [A.promptId, B.promptId].join(),
    JSON.stringify(stub.state()));

  const r = await c.cancelRun({ runId: A.runId });
  ok("cancelling the queued song names exactly one prompt id to the engine",
    stub.seen.jobCancels.length === 1 && stub.seen.jobCancels[0] === A.promptId,
    JSON.stringify(stub.seen.jobCancels));
  ok("...and sends NO interrupt: the engine is not running that prompt",
    stub.seen.interrupts === 0, String(stub.seen.interrupts));
  ok("...and never clears the queue", stub.seen.clears === 0, String(stub.seen.clears));
  ok("...and reports that it was stopped", r.ok === true && r.stopped === true && r.cancelled === true, JSON.stringify(r));

  const after = stub.state();
  ok("THE CHAT TURN KEEPS ITS PLACE IN THE QUEUE",
    after.pending.length === 1 && after.pending[0] === B.promptId, JSON.stringify(after));
  ok("...and the long render is untouched", after.running[0] === C.promptId, JSON.stringify(after));

  const aRow = await settled(A.runId);
  ok("the cancelled run's ledger row says CANCELLED, not vanished",
    aRow.status === "cancelled", `${aRow.status}: ${aRow.error}`);
  ok("...and says who stopped it rather than blaming an engine restart",
    /cancelled from the app/.test(aRow.error || "") && !/restart/.test(aRow.error || ""), aRow.error);

  /* And the queue behind it still works: the engine finishes C of its own
   * accord, B moves up, renders, and lands in the ledger as a completed run —
   * the thing that produced no output file at all before. */
  stub.finishRunning();
  const cRow = await settled(C.runId);
  ok("the render that was running completes normally", cRow.status === "completed", `${cRow.status}: ${cRow.error}`);
  stub.finishRunning();
  const bRow = await settled(B.runId);
  ok("AND THE CHAT TURN QUEUED BEHIND THE CANCELLED SONG RUNS, AND COMPLETES",
    bRow.status === "completed" && bRow.outputs?.length > 0, `${bRow.status}: ${bRow.error}`);
}

{
  /* The other half: cancelling the run that IS rendering. One interrupt, and
   * the two behind it move up rather than disappearing. */
  const stub = queuedEngine();
  const c = clientOn(stub, { dir: path.join(tmp, "cancel-running") });
  const C = await c.submit({ graph: LTX_VIDEO_GRAPH, actor: "user", via: "jobs.music", label: "the song, rendering" });
  const A = await c.submit({ graph: FLUX_IMAGE_GRAPH, actor: "user", via: "art.cover", label: "a cover" });
  const B = await c.submit({ graph: TEXT_JUDGE_GRAPH, actor: "agent:claude", via: "chat", label: "a chat turn" });

  const r = await c.cancelRun({ runId: C.runId });
  ok("cancelling the RUNNING run interrupts — once, and only once",
    stub.seen.interrupts === 1, String(stub.seen.interrupts));
  ok("...and still clears nothing", stub.seen.clears === 0, String(stub.seen.clears));
  ok("...and reports it stopped the run it was given", r.stopped === true && r.runId === C.runId, JSON.stringify(r));
  const after = stub.state();
  ok("the two runs behind it are still there, in the order they were queued",
    after.running[0] === A.promptId && after.pending.join() === [B.promptId].join(), JSON.stringify(after));

  const cRow = await settled(C.runId);
  ok("an INTERRUPTED run is recorded as cancelled, not as a render that failed",
    cRow.status === "cancelled", `${cRow.status}: ${cRow.error}`);

  stub.finishRunning();
  stub.finishRunning();
  const [aRow, bRow] = [await settled(A.runId), await settled(B.runId)];
  ok("...and both of the others then render and complete",
    aRow.status === "completed" && bRow.status === "completed",
    `${aRow.status} / ${bRow.status}`);
}

{
  /* A run with no prompt of its own must reach the engine NOT AT ALL. This is
   * the case jobs.js hits in API mode and in the gap between the ledger append
   * and the POST, and the old code's answer was an engine-wide interrupt — a
   * stop button that stopped a stranger's render because ours had not started. */
  const stub = queuedEngine();
  const c = clientOn(stub, { dir: path.join(tmp, "cancel-nothing") });
  const held = await c.submit({ graph: LTX_VIDEO_GRAPH, actor: "user", via: "chat", label: "somebody else's render" });
  const r = await c.cancelRun({ runId: "a-run-that-never-posted" });
  ok("cancelling a run with no prompt id stops nothing",
    r.cancelled === false && r.ok === false, JSON.stringify(r));
  ok("...sends no interrupt, no delete and no cancel of any kind",
    stub.seen.interrupts === 0 && stub.seen.deletes.length === 0 && stub.seen.jobCancels.length === 0,
    JSON.stringify(stub.seen));
  ok("...and says so, naming the reason rather than reporting success",
    /nothing of its own to cancel/.test(r.error || ""), r.error);
  ok("...and the render that WAS running is still running",
    stub.state().running[0] === held.promptId, JSON.stringify(stub.state()));
  stub.finishRunning();
  ok("...and goes on to complete", (await settled(held.runId)).status === "completed");
}

{
  /* THE FALLBACK, for an engine that has no per-job cancel route: withdraw the
   * one id from the pending list, and interrupt only when a fresh read says the
   * engine is running THIS prompt. Same two outcomes, one more round trip. */
  const stub = queuedEngine({ atomicCancel: false });
  const c = clientOn(stub, { dir: path.join(tmp, "cancel-fallback") });
  const C = await c.submit({ graph: LTX_VIDEO_GRAPH, actor: "user", via: "mv.control", label: "holding the engine" });
  const A = await c.submit({ graph: FLUX_IMAGE_GRAPH, actor: "user", via: "jobs.music", label: "the song" });
  const B = await c.submit({ graph: TEXT_JUDGE_GRAPH, actor: "agent:claude", via: "chat", label: "a chat turn" });

  const rA = await c.cancelRun({ runId: A.runId });
  ok("on an older engine the queued run is withdrawn by id, not by clearing",
    stub.seen.deletes.join() === A.promptId && stub.seen.clears === 0, JSON.stringify(stub.seen));
  ok("...with no interrupt, because the engine is not running that prompt",
    stub.seen.interrupts === 0 && rA.atomic === false && rA.place === "gone", JSON.stringify(rA));
  ok("...and the chat turn is still queued behind the running render",
    stub.state().pending.join() === B.promptId && stub.state().running[0] === C.promptId,
    JSON.stringify(stub.state()));
  ok("...and the ledger still says cancelled", (await settled(A.runId)).status === "cancelled");

  const rC = await c.cancelRun({ runId: C.runId });
  ok("...and cancelling the RUNNING one interrupts exactly once",
    stub.seen.interrupts === 1 && rC.interrupted === true, JSON.stringify({ seen: stub.seen, rC }));
  ok("...leaving the chat turn to move up rather than disappear",
    stub.state().running[0] === B.promptId, JSON.stringify(stub.state()));
  ok("...and the interrupted run is cancelled in the ledger too",
    (await settled(C.runId)).status === "cancelled");
  stub.finishRunning();
  ok("...and the chat turn completes", (await settled(B.runId)).status === "completed");
}

/* ── done ──────────────────────────────────────────────────────────────── */
rmSync(tmp, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
