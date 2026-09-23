/**
 * THE FIVE-MINUTE WALL, SHOWN RATHER THAN ASSERTED.
 *
 * `node scripts/doorpost_proof.mjs [seconds]` stands up a local server that
 * answers after N seconds and asks it the same question twice — once with
 * fetch(), once with scripts/lib/doorpost.mjs. Past roughly 305 s the first
 * dies and the second does not.
 *
 * It is NOT a gate lane, deliberately: the whole point is a wait longer than
 * five minutes, and a hook that takes five minutes to prove one thing is a hook
 * people start skipping. scripts/lib/doorpost_test.mjs holds the fast half —
 * the behaviour, and the guard that stops a harness drifting back onto fetch.
 *
 * Measured on this machine, 2026-09-23, node v22.15.0 / win32:
 *
 *     fetch()   DIED at 307.3s -> UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error
 *     postJSON  SURVIVED 310.0s -> {"ok":true}
 *
 * WHY IT MATTERS HERE and not in some other repo: a `wait: true` render holds
 * the response open and sends nothing until it finishes, so the HEADERS arrive
 * last. The median H3 clip on this rig is 317 s. The ordinary render is past
 * the line, and the error it produced named headers rather than the render.
 */
import http from "node:http";
import { postJSON } from "./lib/doorpost.mjs";

const SECONDS = Number(process.argv[2] || 310);

const srv = http.createServer((req, res) => {
  setTimeout(() => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  }, SECONDS * 1000);
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
/* ⚠ NOT `/api/engine`. The server above is a stub that answers after N seconds;
 * it is not the door and this file is not a harness. Spelling its path like
 * the door's would put this file in the engine census in server/engine/
 * ui_test.js, which quite correctly demands that anything posting there name
 * an actor and send the prompt action. What is being measured here is the
 * TRANSPORT, and the transport does not care what the path says. */
const url = `http://127.0.0.1:${srv.address().port}/slow`;

console.log(`a door that answers after ${SECONDS}s, asked twice\n`);

for (const [label, ask] of [
  ["fetch()  ", () => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })],
  ["postJSON ", () => postJSON(url, { body: "{}" })],
]) {
  const t0 = Date.now();
  try {
    const r = await ask();
    const j = await r.json();
    console.log(`  ${label} SURVIVED ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${JSON.stringify(j)}`);
  } catch (e) {
    console.log(`  ${label} DIED at ${((Date.now() - t0) / 1000).toFixed(1)}s -> `
      + `${e.cause?.code || e.name}: ${e.cause?.message || e.message}`);
  }
}
srv.close();
