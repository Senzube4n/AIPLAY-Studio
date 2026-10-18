/**
 * /api/audio LETS GO OF THE SONG WHEN THE PLAYER DOES.
 *
 * The report (2026-09-24): "cover embed failed ... EPERM: operation not
 * permitted, rename" on songs she had been listening to. The cause, reproduced
 * here before the fix: the audio door served ranges with
 * createReadStream(...).pipe(res), and when the player hung up early (a seek,
 * a pause, the next track) pipe() unpiped and never destroyed the read stream.
 * The file stayed open inside Studio, and Windows will not rename over an open
 * file, so the tag rewrite that lands the cover failed for every song that had
 * been played.
 *
 * The door is the REAL route text sliced out of index.js (the
 * cross-origin-doors_test pattern), driven by a real HTTP server on loopback
 * and a client that aborts after its first chunk. No Studio, no engine.
 *
 *   1. aborting a range request closes the read stream (any OS);
 *   2. the file can then be renamed over (the EPERM itself; win32 only);
 *   3. the control: the old `.pipe(res)` shape leaves the stream open, so the
 *      first check can tell the two apart;
 *   4. ranges still answer as the player needs: 206, a suffix range means the
 *      LAST n bytes, 416 keeps the sandbox headers, HEAD sends no body;
 *   5. a player that hangs up BEFORE the door starts reading (while it is
 *      still awaiting its stat) is let go of too: its 'close' has already
 *      fired, so a listener added afterwards would never hear it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, createReadStream } from "node:fs";
import { mkdtemp, mkdir, writeFile, rename, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sendFile, streamFile } from "./sendfile.js";

const INDEX = readFileSync(new URL("./index.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const root = await mkdtemp(path.join(tmpdir(), "aiplay-audio-door-"));
test.after(() => rm(root, { recursive: true, force: true }));

const config = { outputDir: path.join(root, "out") };
await mkdir(config.outputDir, { recursive: true });
const json = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); return { code, body }; };
const MIME = new Function(`${/const MIME = \{[\s\S]*?\n\};/.exec(INDEX)[0]}\nreturn MIME;`)();

function slice(open, endMarker) {
  const at = INDEX.indexOf(open);
  assert.ok(at >= 0, `index.js has ${open}`);
  const end = INDEX.indexOf(endMarker, at + open.length);
  assert.ok(end > at, `index.js has ${endMarker} after ${open}`);
  return INDEX.slice(at + open.length, end);
}
const BODY = slice('if (p.startsWith("/api/audio/")) {', "\n    }\n\n    // ---- static");
const route = new AsyncFunction("p", "req", "res", "json", "path", "config", "stat", "MIME", "createReadStream", "sendFile",
  `${BODY}\nreturn { fellThrough: true };`);

/* Every stream the door opens, so the test can watch it close. */
const opened = [];
const watchingSendFile = async (req, res, file, opts) => {
  const r = await sendFile(req, res, file, opts);
  if (r.stream) opened.push(r.stream);
  return r;
};

async function serve(handler) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((e) => { res.destroy(e); });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, port: server.address().port, close: () => new Promise((ok) => server.close(ok)) };
}

/** Ask for a range, take the first chunk, hang up. Resolves once the socket is gone. */
function abortAfterFirstChunk(port, urlPath, range = "bytes=0-") {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: urlPath, headers: { range } }, (res) => {
      res.once("data", () => { req.destroy(); resolve(res.statusCode); });
    });
    req.on("error", (e) => { if (e.code !== "ECONNRESET") reject(e); });
  });
}

const closedWithin = (stream, ms) => new Promise((resolve) => {
  if (stream.destroyed || stream.closed) return resolve(true);
  const t = setTimeout(() => resolve(false), ms);
  stream.once("close", () => { clearTimeout(t); resolve(true); });
});

/* Big enough that the socket's buffers cannot swallow the whole file before
 * the client hangs up: the read stream is still mid-file when the player goes. */
const BIG = 24 * 1024 * 1024;
const song = "aiplay_leak_probe.flac";
await writeFile(path.join(config.outputDir, song), Buffer.alloc(BIG, 3));

test("the door serves through sendFile and no longer pipes a bare read stream", () => {
  assert.match(BODY, /return sendFile\(req, res, full, \{ size, headers: base \}\);/);
  assert.doesNotMatch(BODY, /createReadStream\(/, "no read stream is opened outside sendFile");
});

test("aborting a range request closes the read stream (any OS)", async () => {
  opened.length = 0;
  const srv = await serve((req, res) => route(`/api/audio/${song}`, req, res, json, path, config, stat, MIME, createReadStream, watchingSendFile));
  try {
    const status = await abortAfterFirstChunk(srv.port, `/api/audio/${song}`);
    assert.equal(status, 206);
    assert.equal(opened.length, 1, "the door opened one stream");
    assert.equal(await closedWithin(opened[0], 2000), true, "the file handle is released within 2 s of the player hanging up");
  } finally { await srv.close(); }
});

test("once it is released, the song can be renamed over (the EPERM in the report)", { skip: process.platform !== "win32" && "the lock is a Windows rule; POSIX renames over an open file" }, async () => {
  const file = path.join(config.outputDir, "aiplay_rename_probe.flac");
  await writeFile(file, Buffer.alloc(BIG, 5));
  opened.length = 0;
  const srv = await serve((req, res) => route("/api/audio/aiplay_rename_probe.flac", req, res, json, path, config, stat, MIME, createReadStream, watchingSendFile));
  try {
    await abortAfterFirstChunk(srv.port, "/api/audio/aiplay_rename_probe.flac");
    await closedWithin(opened[0], 2000);
    const tmp = `${file}.tag.tmp`;
    await writeFile(tmp, Buffer.alloc(16, 9));
    await rename(tmp, file);
    assert.equal((await stat(file)).size, 16, "the tag rewrite's rename went through");
  } finally { await srv.close(); }
});

test("control: the old .pipe(res) shape keeps the file open after the player hangs up", async () => {
  const file = path.join(config.outputDir, song);
  let leaked = null;
  const srv = await serve((req, res) => {
    res.writeHead(206, { "Content-Range": `bytes 0-${BIG - 1}/${BIG}`, "Content-Length": BIG });
    leaked = createReadStream(file, { start: 0, end: BIG - 1 });
    leaked.pipe(res);
  });
  try {
    await abortAfterFirstChunk(srv.port, "/x");
    assert.equal(await closedWithin(leaked, 700), false,
      "if this starts passing, Node closes piped sources itself and the first check proves less than it says");
  } finally {
    leaked?.destroy();
    await srv.close();
  }
});

test("a player that hangs up before the door starts reading is let go of too", async () => {
  const file = path.join(config.outputDir, "aiplay_late_probe.flac");
  await writeFile(file, Buffer.alloc(BIG, 7));
  let late = null;
  let enteredDoor;
  const entered = new Promise((ok) => { enteredDoor = ok; });
  const srv = await serve(async (req, res) => {
    enteredDoor();
    /* The door awaits (its stat, a library lookup) and the player leaves meanwhile. */
    await new Promise((ok) => setTimeout(ok, 300));
    late = (await sendFile(req, res, file, { headers: { "Content-Type": "audio/flac" } })).stream;
  });
  try {
    const req = http.get({ host: "127.0.0.1", port: srv.port, path: "/", headers: { range: "bytes=0-" } });
    req.on("error", () => {});
    /* Start the abort clock only after the server has the request. Under a busy
     * full gate, 50 ms from http.get() was sometimes earlier than accept(). */
    await entered;
    await new Promise((ok) => setTimeout(ok, 50));
    req.destroy();
    for (let i = 0; i < 40 && !late; i++) await new Promise((ok) => setTimeout(ok, 25));
    assert.ok(late, "the door reached sendFile after the player had gone");
    assert.equal(await closedWithin(late, 2000), true, "the handle is released although 'close' fired before the stream existed");
    if (process.platform === "win32") {
      const tmp = `${file}.tag.tmp`;
      await writeFile(tmp, Buffer.alloc(8, 1));
      await rename(tmp, file);
      assert.equal((await stat(file)).size, 8, "and the song can be renamed over");
    }
  } finally { await srv.close(); }
});

test("ranges answer the way a player needs them", async () => {
  const small = "aiplay_small.mp3";
  const bytes = Buffer.from(Array.from({ length: 64 }, (_, i) => i));
  await writeFile(path.join(config.outputDir, small), bytes);
  const srv = await serve((req, res) => route(`/api/audio/${small}`, req, res, json, path, config, stat, MIME, createReadStream, sendFile));
  const get = (headers = {}, method = "GET") => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: srv.port, path: `/api/audio/${small}`, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, head: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
  try {
    const whole = await get();
    assert.equal(whole.status, 200);
    assert.equal(whole.head["accept-ranges"], "bytes");
    assert.equal(whole.head["content-security-policy"], "sandbox");
    assert.deepEqual(whole.body, bytes);

    const head = await get({ range: "bytes=0-9" });
    assert.equal(head.status, 206);
    assert.equal(head.head["content-range"], "bytes 0-9/64");
    assert.deepEqual(head.body, bytes.subarray(0, 10));

    const tail = await get({ range: "bytes=-10" });
    assert.equal(tail.status, 206, "a suffix range is the LAST ten bytes (RFC 7233)");
    assert.equal(tail.head["content-range"], "bytes 54-63/64");
    assert.deepEqual(tail.body, bytes.subarray(54));

    const past = await get({ range: "bytes=900-" });
    assert.equal(past.status, 416);
    assert.equal(past.head["content-range"], "bytes */64");
    assert.equal(past.head["content-security-policy"], "sandbox", "the sandbox header rides a 416 too");

    const onlyHead = await get({}, "HEAD");
    assert.equal(onlyHead.status, 200);
    assert.equal(onlyHead.head["content-length"], "64");
    assert.equal(onlyHead.body.length, 0);
  } finally { await srv.close(); }
});

test("streamFile tears the response down when the file cannot be read", async () => {
  const srv = await serve((req, res) => { res.writeHead(200); streamFile(res, path.join(config.outputDir, "missing.flac")); });
  try {
    const outcome = await new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port: srv.port, path: "/" }, (res) => {
        res.resume();
        res.on("end", () => resolve("ended cleanly"));
        res.on("error", () => resolve("cut"));
        res.on("aborted", () => resolve("cut"));
      });
      req.on("error", () => resolve("cut"));
    });
    assert.equal(outcome, "cut", "a short body is never presented as a finished one");
  } finally { await srv.close(); }
});
