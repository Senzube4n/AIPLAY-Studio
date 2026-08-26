/**
 * Regression pins for the 2026-08-26 test-matrix findings that live in plain
 * node territory — no server, no python, no engine.
 *
 *   F4  engine adoption on port conflict. Readiness was a bare port poll, so a
 *       NEIGHBOUR ComfyUI on the configured port answered our poll while our
 *       own child died on the bind — "engine ready" over a foreign engine, and
 *       /api/export wrote into the other install's output directory. Proven
 *       here without booting two engines: a fake responder holds the port and
 *       start() must REFUSE it by name, never spawn, never report ready.
 *   F3  wait_for_song spun its full timeout (default 900 s) on a job id the
 *       server had never heard of, then claimed "Still running". The guard is
 *       pinned structurally (the behaviour needs a live server and is part of
 *       the manual smoke).
 *
 * Structural pins read the source on purpose: the private methods they gate
 * (#waitForReady, #childAlive) are not reachable from outside, and the point
 * is to notice the guard being refactored away, not to re-run it.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

let pass = 0;
const fails = [];
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fails.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
};

console.log("\n  -- F4: a foreign instance on the port is refused, not adopted --");

/* A fake ComfyUI: anything that answers 200 on /system_stats. The supervisor
 * must treat it as an occupant to refuse, never as its own child. */
const fake = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ system: { os: "fake" }, devices: [] }));
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const port = fake.address().port;

/* config.js reads the environment at import time, so the port has to be set
 * before the (dynamic) import pulls it in. */
process.env.AIPLAY_COMFY_PORT = String(port);
const { ComfySupervisor } = await import(`file://${path.join(ROOT, "server", "comfy.js").replace(/\\/g, "/")}`);

const sup = new ComfySupervisor();
let refusal = "";
const t0 = Date.now();
try { await sup.start(); } catch (e) { refusal = e.message; }
const tookMs = Date.now() - t0;

ok("start() throws instead of adopting the occupant", refusal !== "", "start() resolved");
ok("...naming the port", refusal.includes(String(port)), refusal);
ok("...and the AIPLAY_COMFY_PORT remedy", /AIPLAY_COMFY_PORT/.test(refusal), refusal);
ok("...without spawning a child", sup.proc === null, `proc = ${sup.proc}`);
ok("...and never reporting ready", sup.ready === false, `ready = ${sup.ready}`);
ok("...in a startup-check moment, not a poll loop", tookMs < 10_000, `${tookMs}ms`);

let submitRefusal = "";
try { await sup.submit({}, "test"); } catch (e) { submitRefusal = e.message; }
ok("submit() with no live child refuses rather than posting to the port",
  /not running|not alive/.test(submitRefusal), submitRefusal || "submit() resolved");

await new Promise((r) => fake.close(r));

console.log("\n  -- F4: the readiness gate, structurally --");
const comfySrc = readFileSync(path.join(ROOT, "server", "comfy.js"), "utf8");

const readySets = [...comfySrc.matchAll(/this\.ready = true/g)];
ok("ready = true is assigned in exactly one place", readySets.length === 1, `${readySets.length} sites`);
ok("...inside #waitForReady, after a child-alive re-check",
  /if \(!this\.#childAlive\(\)\) \{[\s\S]{0,700}?\}\s*this\.ready = true;/.test(comfySrc),
  "the proc-alive gate before `this.ready = true` is gone");
ok("a successful poll waits a beat for a lost bind race to surface",
  /answered[\s\S]{0,400}await sleep\(\d+\);[\s\S]{0,200}#childAlive/.test(comfySrc),
  "the post-poll grace + re-check is gone");
ok("start() probes the port BEFORE spawning",
  comfySrc.indexOf("#portAnswers()") !== -1
    && comfySrc.indexOf("await this.#portAnswers()") < comfySrc.indexOf(".proc = spawn("),
  "the pre-spawn occupancy probe is gone");
ok("stop() waits for the exit to land (a restart's probe must not meet our own ghost)",
  /async stop\(\) \{[\s\S]{0,700}?this\.proc; i\+\+\) await sleep/.test(comfySrc),
  "stop() no longer waits out the exit");

console.log("\n  -- F3: wait_for_song fails fast on an id the server never had --");
const mcpSrc = readFileSync(path.join(ROOT, "server", "mcp.js"), "utf8");
const wfs = mcpSrc.slice(mcpSrc.indexOf("async function waitForSong"),
  mcpSrc.indexOf("async function waitForArt"));
ok("waitForSong exists where the tools expect it", wfs.length > 0);
ok("an unknown id has its own error, apart from the timeout's",
  /No job with id/.test(wfs), "the unknown-id refusal is gone");
ok("...decided against current AND queue AND history, not history alone",
  /st\.current/.test(wfs) && /st\.queue/.test(wfs) && /inHistory/.test(wfs),
  "the three-list membership check is gone");
ok("...after one repoll, so a job mid-hop between lists is not misread",
  /unseen/.test(wfs), "the repoll grace is gone");
ok("the timeout branch still says nothing was cancelled",
  /Nothing was cancelled/.test(wfs), "the timeout wording changed");

console.log(`\n  ${pass} passed, ${fails.length} failed\n`);
if (fails.length) { for (const f of fails) console.log(`   · ${f}`); console.log(""); }
process.exit(fails.length ? 1 : 0);
