/**
 * THE DOOR POST, AND THE GUARD THAT KEEPS NINETEEN HARNESSES OFF fetch().
 *
 * The defect this exists for is not in the app: it is in the nineteen render
 * harnesses in scripts/, every one of which posted `wait: true` to /api/engine
 * over plain fetch(). A `wait: true` call holds the response open for the whole
 * render and sends nothing until it is done, so the headers arrive LAST — and
 * Node's fetch abandons a request about 305 s after it goes out if no headers
 * have come back. The median H3 clip measured for docs/RESOLUTION_FOR_FACES.md
 * is 317 s, so the ordinary render was past the wall:
 *
 *     a door answering after 310 s, over fetch():
 *     DIED at 307.3s -> UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error
 *
 * Three of the nineteen also asked for a `timeoutMs` of twenty or forty
 * minutes. Those numbers could not be honoured by the transport underneath
 * them, so the deadline was decoration and the failure named headers instead of
 * the render — while the engine finished the clip and put it in the library
 * with nothing waiting for it.
 *
 * ⚠ THE SLOW HALF OF THIS PROOF IS NOT HERE, ON PURPOSE. Demonstrating the wall
 * needs a wait longer than five minutes, and a gate lane that costs five
 * minutes to show one thing is a lane people start skipping. It lives in
 * scripts/doorpost_proof.mjs, which anyone can run. What is here is the fast
 * half: that postJSON behaves, that its opt-in deadline really fires, and the
 * REGRESSION GUARD — no harness in scripts/ may go back to fetch() for a
 * `wait: true` call, which is the way this would quietly return.
 */
import http from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { postJSON } from "./doorpost.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, "..");

let pass = 0;
const failures = [];
const ok = (what, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${what}`); }
  else { failures.push(what); console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ""}`); }
};

console.log("\n  -- the door post --");

/** A server that answers after `delayMs`, optionally with a status. */
function slowDoor(delayMs, status = 200, body = '{"ok":true}') {
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => setTimeout(() => {
      const echo = status === 200 && body === "ECHO"
        ? JSON.stringify({ got: Buffer.concat(chunks).toString("utf8"), ua: req.headers["x-aiplay-actor"] || null })
        : body;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(echo);
    }, delayMs));
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, port: srv.address().port })));
}

{
  const { srv, port } = await slowDoor(0, 200, "ECHO");
  const r = await postJSON(`http://127.0.0.1:${port}/api/engine`, {
    body: JSON.stringify({ action: "prompt", wait: true }),
    headers: { "x-aiplay-actor": "script:doorpost_test" },
  });
  const j = await r.json();
  ok("it posts the body it was given, verbatim", j.got === '{"action":"prompt","wait":true}', j.got);
  ok("...and carries the actor header, so the ledger still names the harness",
    j.ua === "script:doorpost_test", String(j.ua));
  ok("...and reports ok and the status the way a Response does", r.ok === true && r.status === 200);
  srv.close();
}

{
  /* A REFUSAL HAS TO STAY READABLE. Several harnesses print "start AIPLAY
   * Studio first" off `e.cause?.code`, which is a fetch-ism; node:http puts the
   * code on the error itself, so both spellings are filled in or those messages
   * turn into "undefined". */
  let err = null;
  try {
    await postJSON("http://127.0.0.1:1/api/engine", { body: "{}" });
  } catch (e) { err = e; }
  ok("a dead port rejects rather than hanging", !!err);
  ok("...and the reason is readable at e.cause.code, where the harnesses look",
    !!err?.cause?.code, JSON.stringify({ code: err?.code, cause: err?.cause?.code }));
}

{
  const { srv, port } = await slowDoor(400, 500, '{"error":"the engine said no"}');
  const r = await postJSON(`http://127.0.0.1:${port}/api/engine`, { body: "{}" });
  ok("a 500 comes back as not-ok with its body intact, not as a throw",
    r.ok === false && r.status === 500 && (await r.json()).error === "the engine said no");
  srv.close();
}

{
  /* ⚠ THE DEADLINE IS OPT-IN AND IT REALLY FIRES. Two failures are possible
   * here and they look identical from the outside: a timeout that never
   * triggers (the harness hangs forever on a wedged engine) and one that
   * triggers when nobody asked (the five-minute wall, rebuilt by hand). Both
   * directions are checked. */
  const { srv, port } = await slowDoor(3000);
  const t0 = Date.now();
  let err = null;
  try { await postJSON(`http://127.0.0.1:${port}/api/engine`, { body: "{}", timeoutMs: 300 }); }
  catch (e) { err = e; }
  const took = Date.now() - t0;
  ok("an EXPLICIT timeoutMs gives up, and near when it said it would",
    !!err && took < 2000, `${took} ms, ${err?.cause?.code || err?.message}`);
  ok("...and says so in words a harness can print", /did not answer within/.test(err?.message || ""),
    err?.message);
  srv.close();
}

{
  const { srv, port } = await slowDoor(900);
  const t0 = Date.now();
  const r = await postJSON(`http://127.0.0.1:${port}/api/engine`, { body: "{}" });
  ok("...and with NO timeoutMs it simply waits, which is the whole point",
    r.ok && Date.now() - t0 >= 850, `${Date.now() - t0} ms`);
  srv.close();
}

{
  const src = readFileSync(path.join(HERE, "doorpost.mjs"), "utf8");
  ok("it sets no deadline of its own unless one is asked for",
    /if \(Number\.isFinite\(opts\.timeoutMs\) && opts\.timeoutMs > 0\)/.test(src),
    "a default deadline here would be the five-minute wall rebuilt by hand");
  /* Comments stripped first: this module's own docstring is mostly ABOUT
   * fetch, and a substring check would fail on its own explanation. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  ok("...and it is node:http, which is the reason it can wait at all",
    /^import http from "node:http";$/m.test(src) && !/\bfetch\(/.test(code),
    "fetch cannot be configured past its headers deadline without taking undici as a dependency");
}

/* ── THE REGRESSION GUARD ────────────────────────────────────────────────────
 *
 * The fix is nineteen one-word edits, and the way it comes undone is somebody
 * writing the twentieth harness the way the other nineteen used to look. This
 * is the check that catches that, and it is the reason this file is in the
 * hook at all. */
{
  const harnesses = readdirSync(SCRIPTS)
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => ({ name: f, src: readFileSync(path.join(SCRIPTS, f), "utf8") }))
    /* ⚠ doorpost_proof.mjs IS EXEMPT, AND SAYING SO OUT LOUD IS CHEAPER THAN
     * LETTING IT PASS BY LUCK. It is the one file here whose job is to call
     * fetch — it races the two transports against the same slow door — so a
     * guard that forbade fetch everywhere would forbid the demonstration of
     * why the guard exists. It survives today only because it happens to spell
     * the call `() => fetch(...)` rather than `await fetch(`. */
    .filter((f) => f.name !== "doorpost_proof.mjs")
    .filter((f) => /wait: true/.test(f.src));
  ok(`the sweep finds the render harnesses (${harnesses.length})`, harnesses.length >= 15,
    "a sweep that finds nothing passes everything");
  const onFetch = harnesses.filter((f) => /\bawait fetch\(/.test(f.src)).map((f) => f.name);
  ok("no `wait: true` harness posts over fetch()", onFetch.length === 0,
    `${onFetch.join(", ")} — fetch abandons a request ~305 s after it goes out with no headers back, `
    + "and a wait:true render sends its headers last. Post through scripts/lib/doorpost.mjs.");
  const usingIt = harnesses.filter((f) => /doorpost\.mjs/.test(f.src)).length;
  ok(`...and all ${harnesses.length} of them go through the one door (${usingIt})`,
    usingIt === harnesses.length,
    harnesses.filter((f) => !/doorpost\.mjs/.test(f.src)).map((f) => f.name).join(", "));
  /* The three that name a timeoutMs are the ones that made the mismatch
   * visible: twenty and forty minutes, over a transport that stopped at five. */
  const long = harnesses.filter((f) => /timeoutMs: \d+ \* 60_000/.test(f.src)).map((f) => f.name);
  ok(`...including the ones that ask for a deadline past the old wall (${long.length})`,
    long.every((n) => /doorpost\.mjs/.test(harnesses.find((h) => h.name === n).src)),
    long.join(", "));
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
