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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
