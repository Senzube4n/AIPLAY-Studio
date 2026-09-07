/**
 * Unit tests for the job watchdog's /queue parse.
 *
 * `queuePhase` reads ComfyUI's GET /queue reply, and that reply is positional
 * arrays with the prompt id at index 1 — a shape observed on the wire, not a
 * documented contract. Misread it and every healthy prompt looks "gone", which
 * the watchdog treats as an engine restart and kills the job: the exact
 * overnight-run failure the watchdog exists to prevent. jobs.js imports `ws`
 * and the live config at module level, so the function under test is extracted
 * from the source by name, the same way test_timeline.mjs does it.
 *
 *   node scripts/test_watchdog.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "..", "server", "jobs.js"), "utf8");

/** Extract a top-level `function name(...) {...}` by brace counting. */
function extract(name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`function ${name} not found in jobs.js`);
  let i = src.indexOf("{", at), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// eslint-disable-next-line no-new-func
const queuePhase = new Function(`return ${extract("queuePhase")}`)();

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n          got ${got}, wanted ${want}`); }
}

console.log("\nwatchdog /queue parse\n");

// ComfyUI's entry shape: [number, prompt_id, prompt, extra_data, outputs].
const entry = (id) => [0, id, {}, {}, []];

{
  eq("running prompt reads as running",
     queuePhase({ queue_running: [entry("abc")], queue_pending: [] }, "abc"), "running");
  eq("pending prompt reads as pending",
     queuePhase({ queue_running: [entry("xyz")], queue_pending: [entry("abc")] }, "abc"), "pending");
  eq("absent prompt reads as gone",
     queuePhase({ queue_running: [entry("xyz")], queue_pending: [] }, "abc"), "gone");
}

{
  /* The id lives at INDEX 1. An id anywhere else must not match — this is the
   * assertion that pins the positional shape against a well-meaning rewrite. */
  eq("an id at index 0 does not count",
     queuePhase({ queue_running: [["abc", 0, {}, {}, []]], queue_pending: [] }, "abc"), "gone");
}

{
  /* A malformed reply must degrade to "gone", never to "running": reading
   * garbage as progress would silence the stall timeout indefinitely. */
  eq("empty object is gone", queuePhase({}, "abc"), "gone");
  eq("null reply is gone", queuePhase(null, "abc"), "gone");
  eq("non-array lists are gone",
     queuePhase({ queue_running: "abc", queue_pending: 7 }, "abc"), "gone");
  eq("null entries are skipped, not thrown on",
     queuePhase({ queue_running: [null, entry("abc")], queue_pending: [] }, "abc"), "running");
}

/* ── cancel() stops ONE song, not the engine ───────────────────────────────
 *
 * MEASURED TWICE ON 2026-09-05: with a chat turn queued behind a song, one
 * press of the app's Stop button left that turn in neither /history nor /queue
 * (runs mto5iphvf293e7 and mto5ngyxf4893c). It wrote no output and its ledger
 * row said `vanished`, as though ComfyUI had restarted under it. Nothing had.
 * `cancel()` was `await engine.interrupt()`, and interrupt is addressed at
 * nothing in particular: it stops whatever the GPU is holding, and the Stop
 * button cleared the pending queue behind it.
 *
 * The method is run for real rather than grepped — a proof you can only make by
 * reading the source is a proof about a file, not about a program — with a fake
 * door in place of the engine. Two substitutions make that possible and both
 * are named here: the source is a class METHOD, so it is lifted by brace
 * counting the same way `queuePhase` is, and `this.#pump` becomes `this.$pump`
 * because a private field cannot be parsed outside its class. Nothing else in
 * the body is touched.
 */
function extractMethod(name) {
  const at = src.indexOf(`async ${name}(`);
  if (at < 0) throw new Error(`method ${name} not found in jobs.js`);
  let i = src.indexOf("{", at), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}
const cancelSrc = extractMethod("cancel").replace(/^async\s+/, "").replace(/this\.#pump/g, "this.$pump");
const cancelByIdSrc = extractMethod("cancelById").replace(/^async\s+/, "").replace(/this\.#(pump|markCancelled)/g, "this.$$$1");
const markStart = src.indexOf("  #markCancelled(job)");
const markSrc = src.slice(markStart, src.indexOf("\n  async cancelById(", markStart)).trim()
  .replace(/^#markCancelled/, "function markCancelled").replace(/this\.#pump/g, "this.$pump");
// eslint-disable-next-line no-new-func
const makeCancel = (engine) => {
  const cancel = new Function("engine", `return async function ${cancelSrc}`)(engine);
  const byId = new Function("engine", `return async function ${cancelByIdSrc}`)(engine);
  const mark = new Function("engine", `return ${markSrc}`)(engine);
  return async function () { this.cancelById = byId; this.$markCancelled = mark; return cancel.call(this); };
};

const fakeDoor = () => {
  const calls = [];
  return {
    calls,
    cancelRun: async (a) => { calls.push({ call: "cancelRun", ...a }); return { ok: true, cancelled: true, stopped: true }; },
    interrupt: async () => { calls.push({ call: "interrupt" }); return { stopped: true }; },
    clearQueue: async () => { calls.push({ call: "clearQueue" }); return { dropped: 0 }; },
  };
};
const runnerWith = (current) => ({
  current, queue: [], history: [],
  emit() {}, snapshot() { return {}; }, $pump: async () => {},
});

{
  const door = fakeDoor();
  const runner = runnerWith({ id: "j1", state: "running", promptId: "p-song", runId: "r-song" });
  await makeCancel(door).call(runner);

  eq("cancel() makes exactly one call to the door", door.calls.length, 1);
  eq("...and it is cancelRun, never interrupt", door.calls[0]?.call, "cancelRun");
  eq("...addressed at THIS job's own prompt", door.calls[0]?.promptId, "p-song");
  eq("...and carrying its runId, so the ledger row can say cancelled", door.calls[0]?.runId, "r-song");
  eq("the job still ends as cancelled", runner.history[0]?.state, "cancelled");
  eq("...and the queue is free to pump again", runner.current, null);
}

{
  /* API mode, or a job stopped between #pump and the POST: there is no prompt
   * of ours on the engine, so the engine must not be touched at all. An
   * interrupt here stops whatever ELSE is rendering — which is the whole bug,
   * in the one case where it is easiest to think it does not matter. */
  const door = fakeDoor();
  const runner = runnerWith({ id: "j2", state: "running", promptId: undefined, runId: undefined });
  await makeCancel(door).call(runner);

  eq("a job with no prompt on the engine touches the engine not at all", door.calls.length, 0);
  eq("...and is still cancelled locally", runner.history[0]?.state, "cancelled");
  eq("...and still frees the queue", runner.current, null);
}

{
  // Nothing running: still nothing sent.
  const door = fakeDoor();
  const runner = runnerWith(null);
  await makeCancel(door).call(runner);
  eq("cancel() with nothing running sends nothing", door.calls.length, 0);
  eq("...and invents no history row", runner.history.length, 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
