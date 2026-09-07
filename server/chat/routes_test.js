/**
 * CHAT v1 — the route, mounted for real on a throwaway port.
 *
 * server/chat/ui_test.js proves the SHAPE of this surface — that every path the
 * page fetches is served and every path served is reachable. This file proves
 * it actually answers, by starting a real http server, mounting the real
 * handler on it, and driving it exactly the way web/chat.js does: POST
 * /api/chat, read the SSE frames off the body, then GET /api/chat/sessions.
 *
 * Costs no GPU and touches nothing the owner owns. The model is a stub, the
 * tools are stubs, and the sessions are written into a fresh temp directory —
 * because a route test that writes into the real app-data folder leaves a
 * conversation behind every time somebody commits.
 *
 * THREE THINGS THAT ONLY SHOW UP WHEN IT IS REALLY MOUNTED, and each of them
 * fails in a way the structural census cannot see:
 *
 *   - THE EVENT STREAM. This route writes its own head and ends its own
 *     response, which no other route in this app does. A `json()` call after it
 *     returns would be a "headers already sent" crash on a live server and
 *     nothing at all in a static read.
 *   - THE JSONL. One object per line, appended as the turn happens, so a
 *     conversation survives the tab being closed mid-render — and the `raw`
 *     event deliberately NOT written, because the turns already carry it and
 *     the model's whole reply twice over is the biggest thing on the line.
 *   - THE ATTRIBUTION GATE. Same rule as the engine door: a browser is known by
 *     its Origin, everything else must say who it is, and a request nobody will
 *     own is refused rather than filed under a name that means nothing.
 *
 * Runs standalone (`node server/chat/routes_test.js`) and in the pre-commit hook.
 */
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createChatRoutes } from "./routes.js";
import { createChatTools } from "./tools.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const dir = await mkdtemp(path.join(os.tmpdir(), "aiplay-chatroutes-"));

/* Stubs, all three. The tools answer from a fixed /api/status; the model reads
 * its replies off a list; the engine is always idle so the busy gate cannot
 * fire and turn every assertion below into a vacuous pass. */
const tools = createChatTools({
  api: async () => ({ library: [{ file: "a.flac", title: "A", durationSeconds: 100 }], queue: [], history: [], current: null }),
});
const answers = ['{"tool":"list_library","args":{}}', '{"say":"you have one track, A"}'];
const model = async () => answers.shift() ?? '{"say":"done"}';
const engine = { status: async () => ({ ready: true, queue: { running: 0, pending: 0 }, running: [] }) };

/* server/index.js's own two helpers, verbatim in behaviour — the route takes
 * them as dependencies precisely so this file can mount it without one. */
const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(s) });
  res.end(s);
};
const readBody = async (req) => {
  const c = []; for await (const x of req) c.push(x);
  return c.length ? JSON.parse(Buffer.concat(c).toString()) : {};
};

const handle = createChatRoutes({
  json, readBody, config: { uiPort: 4173, paths: { appData: dir } }, engine, tools, model, dir,
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (await handle(req, res, url)) return;
  json(res, 404, { error: "not found" });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const A = { "x-aiplay-actor": "script:chat_routes_test", "content-type": "application/json" };

/** Read a whole event stream into the list of events it carried. */
async function stream(body) {
  const r = await fetch(`${BASE}/api/chat`, { method: "POST", headers: A, body: JSON.stringify(body) });
  const text = await r.text();
  const events = [];
  for (const frame of text.split("\n\n")) {
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) events.push(JSON.parse(line.slice(5).trim()));
    }
  }
  return { r, events };
}

/* ══ the attribution gate ═════════════════════════════════════════════════ */
console.log("\nTHE ATTRIBUTION GATE");

{
  const r = await fetch(`${BASE}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hi" }),
  });
  const b = await r.json();
  ok("a request with no actor and no Origin is refused, the way the engine door refuses one",
    r.status === 400 && /x-aiplay-actor/.test(b.error), `${r.status} ${JSON.stringify(b)}`);
}
{
  const r = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:4173" },
    body: JSON.stringify({ message: "hi" }),
  });
  ok("...and a same-origin browser needs nothing, because Origin is what browsers send and curl does not",
    r.status === 200, String(r.status));
  await r.text();
  answers.push('{"say":"you have one track, A"}');   // that turn consumed two
}
{
  const r = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:41730" },
    body: JSON.stringify({ message: "hi" }),
  });
  ok("...and a LOOKALIKE origin is not this app — 41730 is not 4173", r.status === 400, String(r.status));
}
/* ⚠ THE ONE THE ORIGIN TESTS ABOVE CANNOT SEE, and the bug it was written for.
 * A browser sends `Origin` on a POST and OMITS IT on a same-origin GET, so the
 * page's own sessions read arrived with neither header this gate knew about and
 * was refused 400 in a real Chrome — measured, on the real page, 2026-09-05.
 * Every other test in this file sends `x-aiplay-actor`, which is exactly why
 * none of them walked the path the browser actually walks. These three do. */
{
  const r = await fetch(`${BASE}/api/chat/sessions?limit=5`, {
    headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" },
  });
  ok("the page's own GET /api/chat/sessions is served — a browser omits Origin on a same-origin GET",
    r.status === 200, String(r.status));
}
{
  const r = await fetch(`${BASE}/api/chat/sessions?limit=5`, { headers: { "sec-fetch-site": "cross-site" } });
  ok("...but a CROSS-SITE fetch is still refused, because that is what the header is for",
    r.status === 400, String(r.status));
}
{
  const r = await fetch(`${BASE}/api/chat/sessions?limit=5`);
  ok("...and a bare GET with neither header must still name itself",
    r.status === 400, String(r.status));
}
{
  ok("GET /api/chat says what to POST instead of 404ing",
    (await fetch(`${BASE}/api/chat`, { method: "GET", headers: A })).status === 405);
  ok("an empty message is refused before the card is touched",
    (await fetch(`${BASE}/api/chat`, { method: "POST", headers: A, body: JSON.stringify({}) })).status === 400);
  ok("a session id that walks out of the folder is refused",
    (await fetch(`${BASE}/api/chat`, { method: "POST", headers: A, body: JSON.stringify({ message: "x", session: "../etc" }) })).status === 400);
}

/* ══ the event stream ═════════════════════════════════════════════════════ */
console.log("\nTHE EVENT STREAM");

answers.length = 0;
answers.push('{"tool":"list_library","args":{}}', '{"say":"you have one track, A"}');
const { r: streamRes, events } = await stream({ message: "what's in my library?" });
const types = events.map((e) => e.type);
const sessionId = events.find((e) => e.type === "open")?.session ?? null;

ok("POST /api/chat answers 200 with content-type text/event-stream",
  streamRes.status === 200 && /text\/event-stream/.test(streamRes.headers.get("content-type") || ""),
  `${streamRes.status} ${streamRes.headers.get("content-type")}`);
ok("...and asks not to be buffered, because a proxy that buffers an event stream turns it back "
   + "into the spinner this route exists to replace",
  (streamRes.headers.get("x-accel-buffering") || "") === "no");
ok("it opens with a session id", !!sessionId, types.join(", "));
ok(`...carries the phases in order (${types.join(", ")})`,
  types.indexOf("thinking") < types.indexOf("tool_call")
  && types.indexOf("tool_call") < types.indexOf("tool_result")
  && types.indexOf("tool_result") < types.indexOf("say"));
ok("...and closes with done then end, so a reader always knows the turn is over",
  types.at(-2) === "done" && types.at(-1) === "end");
ok("the answer on the wire is the one the loop produced",
  events.find((e) => e.type === "say")?.text === "you have one track, A");

/* ══ the JSONL ════════════════════════════════════════════════════════════ */
console.log("\nTHE SESSION FILE");

{
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  ok("one file per conversation, named for the session",
    files.includes(`${sessionId}.jsonl`), files.join(", "));
  const lines = (await readFile(path.join(dir, `${sessionId}.jsonl`), "utf8")).trim().split("\n");
  ok(`...one JSON object per line, every one of them parseable (${lines.length} lines)`,
    lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
  ok("...and the person's own message is the first line, written before anything could fail",
    JSON.parse(lines[0]).role === "user" && JSON.parse(lines[0]).text === "what's in my library?");
  ok("...the `raw` event is deliberately NOT written — the turns already carry the model's reply "
     + "and writing it twice makes the model's own words the biggest thing in the file",
    !lines.some((l) => JSON.parse(l).type === "raw"));
  ok("...and the answer IS", lines.some((l) => { const o = JSON.parse(l); return o.type === "say" && /one track/.test(o.text || ""); }));
}

/* ══ reading it back ══════════════════════════════════════════════════════ */
console.log("\nREADING IT BACK");

{
  const b = await (await fetch(`${BASE}/api/chat/sessions`, { headers: A })).json();
  const mine = (b.sessions || []).find((s) => s.id === sessionId);
  ok("GET /api/chat/sessions lists the conversation", !!mine, JSON.stringify(b).slice(0, 300));
  ok("...with the line it was opened with, which is what a person recognises it by",
    mine?.opened_with === "what's in my library?");
  const one = await (await fetch(`${BASE}/api/chat/sessions?id=${sessionId}`, { headers: A })).json();
  ok("...and ?id= returns its turns", Array.isArray(one.turns) && one.turns.length > 3, `${one.turns?.length} turns`);
  ok("...a path-walking id is refused rather than read",
    (await fetch(`${BASE}/api/chat/sessions?id=../../etc`, { headers: A })).status === 400);
  ok("...and an id that is not there is 404, not a 500",
    (await fetch(`${BASE}/api/chat/sessions?id=nosuchsession`, { headers: A })).status === 404);
}

/* ══ a second turn ════════════════════════════════════════════════════════ */
console.log("\nA SECOND TURN");

{
  answers.push('{"say":"still one track"}');
  const { events: e2 } = await stream({ message: "and now?", session: sessionId });
  ok("a second message with the same id continues the same conversation",
    e2.find((e) => e.type === "open")?.session === sessionId);
  const files = (await readdir(dir)).filter((f) => f === `${sessionId}.jsonl`);
  ok("...appending to the same file rather than making a second", files.length === 1);
  const lines = (await readFile(path.join(dir, files[0]), "utf8")).trim().split("\n");
  ok("...and both of the person's messages are in it",
    lines.filter((l) => JSON.parse(l).role === "user").length === 2);
}

/* ══ REOPENING IT IN A NEW PROCESS ════════════════════════════════════════
 *
 * ⚠ MEASURED, 2026-09-05, adversarial re-check. The second turn above kept its
 * session in the `live` map, so it never exercised the path that matters: a
 * person coming back after the app restarted and picking the conversation out
 * of the Earlier menu. On THAT path the turns are rebuilt from the JSONL, and
 * the JSONL is written in the STREAM's shape (role "event") while the loop
 * reads the LOOP's shape (role "say" / "tool_call" / "tool_result"). Untranslated,
 * every answer and every tool result was dropped and the model was handed a
 * column of PERSON lines — a person asking follow-up questions about things it
 * had never been told. The page read the same rows correctly, so the feature
 * looked like it worked.
 *
 * This mounts a SECOND, cold handler over the same directory and reads the
 * prompt the model is actually given.
 */
console.log("\nREOPENING IT IN A NEW PROCESS");

{
  const prompts = [];
  const coldModel = async (p) => { prompts.push(p); return '{"say":"it is nine seconds long"}'; };
  const cold = createChatRoutes({ json, readBody, engine, tools, model: coldModel, dir });
  const srv2 = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (!(await cold(req, res, url))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => srv2.listen(0, "127.0.0.1", r));
  const B2 = `http://127.0.0.1:${srv2.address().port}`;

  const res2 = await fetch(`${B2}/api/chat`, {
    method: "POST", headers: A,
    body: JSON.stringify({ message: "and how long is that one?", session: sessionId }),
  });
  const body2 = await res2.text();
  const ev = body2.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5).trim()));
  ok("a cold handler reopens the conversation by id", ev.find((e) => e.type === "open")?.session === sessionId);

  const seen = prompts.at(-1) || "";
  const transcript = seen.split("THE CONVERSATION SO FAR:")[1]?.split("Reply now with")[0]?.trim() ?? "";
  ok("...and the model is given the person's ORIGINAL question", /PERSON: what's in my library\?/.test(transcript), transcript);
  ok("...the tool the loop called for it", /YOU: \{"tool":"list_library"/.test(transcript), transcript);
  ok("...what that tool answered", /TOOL list_library RESULT:/.test(transcript), transcript);
  ok("...and the answer the person was given, which is the half that was lost",
    /YOU: \{"say": "you have one track, A"\}/.test(transcript), transcript);
  ok("...while the progress rows are not replayed as conversation",
    !/thinking/.test(transcript) && !/"type":"done"/.test(transcript), transcript);

  srv2.close();
}

server.close();
await rm(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
