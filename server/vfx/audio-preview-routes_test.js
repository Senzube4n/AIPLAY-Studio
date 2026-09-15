/** Actual HTTP routes/store/audio cache with a fake CPU child and tiny fixture WAVs.
 * No real media, Python, GPU, render jobs, user profile, or live Studio server. */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";

const root = await mkdtemp(path.join(os.tmpdir(), "vfx-audio-http-test-"));
process.env.AIPLAY_APPDATA = path.join(root, "profile");
process.env.AIPLAY_OUTPUT = path.join(root, "output");
process.env.AIPLAY_RIG = path.join(root, "no-rig");
const { config } = await import("../config.js");
const { createComp, updateComp, blankLayer, readComp } = await import("./store.js");
const { createVfxRoutes } = await import("./routes.js");
assert.equal(path.resolve(config.outputDir), path.join(root, "output"));
const clips = path.join(root, "clips"), images = path.join(root, "images");
await Promise.all([mkdir(clips, { recursive: true }), mkdir(images), mkdir(config.outputDir, { recursive: true })]);

function wav(frames) {
  const b = Buffer.alloc(44 + frames * 4);
  b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(48000, 24); b.writeUInt32LE(192000, 28);
  b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(frames * 4, 40);
  // Distinct bytes make suffix and open-ended assertions meaningful.
  for (let i = 44; i < b.length; i++) b[i] = i % 251;
  return b;
}
const SOURCE = "fixture-tone.wav";
await writeFile(path.join(config.outputDir, SOURCE), wav(960));
const workers = [], pendingHandlers = new Set(), internalErrors = [];
let nextWorker = "normal";
const handler = createVfxRoutes({ config, CLIP_DIR: clips, IMAGE_DIR: images, art: null,
  readBody: async () => { throw new Error("Real streamed audio requests must use their bounded reader."); },
  json: (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  },
  spawnPython(args) {
    assert.equal(args[1], "audio-preview", "no frame/render/generation process may start");
    const mode = nextWorker; nextWorker = "normal";
    const proc = new EventEmitter(); proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    const rec = { proc, mode, closed: false, kills: 0, job: null };
    const close = code => { if (!rec.closed) { rec.closed = true; proc.emit("close", code); } };
    rec.close = close;
    // No fake PID: this cannot trigger a real OS tree-kill command.
    proc.kill = () => { rec.kills++; if (mode !== "hold") queueMicrotask(() => close(1)); return true; };
    workers.push(rec);
    queueMicrotask(async () => {
      try {
        rec.job = JSON.parse(await readFile(args[2], "utf8"));
        assert.equal(path.resolve(rec.job.comp.layers[0].src), path.join(config.outputDir, SOURCE));
        if (mode === "hold" || rec.closed) return;
        const frames = Math.round((rec.job.to - rec.job.from) * 48000);
        await writeFile(rec.job.out, wav(frames));
        proc.stdout.emit("data", JSON.stringify({ ok: true, hasAudio: true, rate: 48000, frames }) + "\n");
        close(0);
      } catch (err) { internalErrors.push(err); proc.stderr.emit("data", "fixture worker failed"); close(1); }
    });
    return proc;
  },
});
const server = http.createServer((req, res) => {
  const run = (async () => {
    try {
      if (!await handler(req, res, new URL(req.url, "http://127.0.0.1"))) { res.writeHead(404); res.end(); }
    } catch (err) { internalErrors.push(err); res.destroy(); }
  })();
  pendingHandlers.add(run); run.finally(() => pendingHandlers.delete(run));
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const port = server.address().port, host = `127.0.0.1:${port}`;
const baseHeaders = { "Content-Type": "application/json", Origin: `http://${host}` };
const until = async predicate => {
  for (let i = 0; i < 400; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("Bounded fixture wait timed out.");
};
function request(url = "/api/vfx/audio-preview", { method = "POST", body, raw, chunks, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: url, method, agent: false,
      headers: { ...(method === "POST" ? baseHeaders : {}), ...headers } }, res => {
      const parts = []; res.on("data", chunk => parts.push(chunk)); res.on("error", reject);
      res.on("end", () => {
        const bytes = Buffer.concat(parts);
        const type = res.headers["content-type"] || "";
        resolve({ status: res.statusCode, headers: res.headers, bytes, body: type.includes("application/json") ? JSON.parse(bytes.toString()) : null });
      });
    });
    req.on("error", reject); req.setTimeout(5000, () => req.destroy(new Error("HTTP fixture timed out.")));
    if (chunks) { for (const part of chunks) req.write(part); req.end(); }
    else req.end(raw ?? (body === undefined ? undefined : JSON.stringify(body)));
  });
}
async function comp(name) {
  const initial = await createComp(name, { duration: 1, fps: 30 });
  await updateComp(initial.slug, doc => { doc.layers = [{ ...blankLayer(doc, "audio"), src: SOURCE, start: 0, end: 1 }]; });
  return readComp(initial.slug);
}
const bodyFor = doc => ({ slug: doc.slug, expectedRevision: doc.updatedAt, from: 0, to: 0.02 });

test.after(async () => {
  server.closeAllConnections();
  for (const worker of workers) worker.close(1);
  await Promise.allSettled([...pendingHandlers]);
  await new Promise(resolve => server.close(resolve));
  // runJob unlinks its temporary JSON in a finally handler; wait for that owned cleanup.
  await until(async () => !(await readdir(path.join(config.outputDir, "vfx"))).some(n => n.startsWith(".job_")));
  const exact = path.resolve(root);
  assert.equal(path.dirname(exact), path.resolve(os.tmpdir()));
  assert.ok(path.basename(exact).startsWith("vfx-audio-http-test-"));
  await rm(exact, { recursive: true, force: true });
  assert.deepEqual(internalErrors.map(e => e.message), []);
});

test("POST rejects wrong content type, malformed bodies, extra fields and missing revision before CPU", async () => {
  const doc = await comp("validation"); const body = bodyFor(doc), start = workers.length;
  assert.equal((await request(undefined, { body, headers: { "Content-Type": "text/plain" } })).status, 415);
  for (const raw of ["{broken", "[]", "null", "{}"]) assert.equal((await request(undefined, { raw })).status, 400);
  for (const invalid of [{ ...body, expectedRevision: undefined }, { ...body, from: "0" }, { ...body, src: "private.wav" }, { ...body, to: 2 }]) {
    assert.equal((await request(undefined, { body: invalid })).status, 400);
  }
  assert.equal(workers.length, start);
});
test("POST enforces declared and streamed 4 KiB byte bounds, including chunked JSON whitespace", async () => {
  const doc = await comp("body bounds"), body = bodyFor(doc), start = workers.length;
  const raw = JSON.stringify(body);
  assert.equal((await request(undefined, { raw: " ".repeat(4097), headers: { "Content-Length": "4097" } })).status, 413);
  assert.equal((await request(undefined, { chunks: [raw, " ".repeat(4096)] })).status, 413);
  assert.equal((await request(undefined, { chunks: [raw, " ".repeat(2000), " ".repeat(2100)] })).status, 413);
  assert.equal(workers.length, start);
  const boundary = await request(undefined, { chunks: [raw, " ".repeat(4096 - Buffer.byteLength(raw))] });
  assert.equal(boundary.status, 200); assert.equal(boundary.body.hasAudio, true);
});
test("POST refuses cross-origin and DNS-rebinding Host/Origin while allowing explicit loopback", async () => {
  const doc = await comp("origin guard"), body = bodyFor(doc), start = workers.length;
  assert.equal((await request(undefined, { body, headers: { Origin: "https://attacker.invalid" } })).status, 403);
  assert.equal((await request(undefined, { body, headers: { Host: "rebind.invalid", Origin: "http://rebind.invalid" } })).status, 403);
  assert.equal((await request(undefined, { body, headers: { Origin: "null" } })).status, 403);
  assert.equal(workers.length, start);
  assert.equal((await request(undefined, { body })).status, 200);
});
test("successful preparation returns an exact managed WAV and does not create render jobs", async () => {
  const doc = await comp("exact bytes"), before = await readComp(doc.slug);
  const ready = await request(undefined, { body: bodyFor(doc) });
  assert.equal(ready.status, 200); assert.equal(ready.body.ok, true); assert.equal(ready.body.revision, doc.updatedAt);
  assert.match(ready.body.url, /^\/api\/vfx\/audio-preview\/[a-zA-Z0-9_-]+\/[a-f0-9]{64}\.wav$/);
  const full = await request(ready.body.url, { method: "GET" });
  assert.equal(full.status, 200); assert.equal(full.headers["content-type"], "audio/wav");
  assert.equal(full.headers["cache-control"], "no-store"); assert.equal(full.headers["accept-ranges"], "bytes");
  assert.deepEqual(full.bytes, wav(960));
  assert.deepEqual(await readComp(doc.slug), before);
  assert.deepEqual(await readdir(clips), []);
});
test("Range supports fixed, suffix and open-ended seeking with correct 206 bytes", async () => {
  const doc = await comp("byte seeking");
  const ready = await request(undefined, { body: bodyFor(doc) }); const expected = wav(960), size = expected.length;
  for (const [range, start, end] of [["bytes=0-43", 0, 43], ["bytes=-20", size - 20, size - 1],
    ["bytes=44-", 44, size - 1], ["bytes=3830-999999", 3830, size - 1]]) {
    const result = await request(ready.body.url, { method: "GET", headers: { Range: range } });
    assert.equal(result.status, 206); assert.equal(result.headers["content-range"], `bytes ${start}-${end}/${size}`);
    assert.equal(Number(result.headers["content-length"]), end - start + 1);
    assert.deepEqual(result.bytes, expected.subarray(start, end + 1));
  }
});
test("invalid/multiple/out-of-bounds byte ranges return 416 without serving audio", async () => {
  const doc = await comp("bad ranges"); const ready = await request(undefined, { body: bodyFor(doc) });
  for (const range of ["bytes=", "bytes=-", "bytes=-0", "bytes=0-3,8-10", "bytes=999999-", "bytes=10-1", "items=0-1", "bytes=9007199254740993-"]) {
    const result = await request(ready.body.url, { method: "GET", headers: { Range: range } });
    assert.equal(result.status, 416, range); assert.equal(result.headers["content-range"], `bytes */${wav(960).length}`);
    assert.ok(result.body.error); assert.notEqual(result.headers["content-type"], "audio/wav");
  }
});
test("unknown cache tokens return 404; stale prepare and stale audio URLs return 409", async () => {
  const doc = await comp("revision invalidation"), body = bodyFor(doc);
  const unknown = await request(`/api/vfx/audio-preview/${doc.slug}/${"0".repeat(64)}.wav`, { method: "GET" });
  assert.equal(unknown.status, 404); assert.equal(unknown.body.code, "audio_preview_expired");
  const ready = await request(undefined, { body }); const start = workers.length;
  await updateComp(doc.slug, current => { current.name = "changed after preparation"; });
  const stale = await request(undefined, { body });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, "comp_conflict");
  const oldFile = await request(ready.body.url, { method: "GET" });
  assert.equal(oldFile.status, 409); assert.equal(oldFile.body.code, "comp_conflict");
  assert.equal(workers.length, start);
});
test("disconnect aborts only its owned CPU worker and keeps busy barrier until child close", async () => {
  const doc = await comp("disconnect"), body = bodyFor(doc), start = workers.length;
  nextWorker = "hold";
  const client = http.request({ host: "127.0.0.1", port, path: "/api/vfx/audio-preview", method: "POST", agent: false, headers: baseHeaders });
  client.on("error", () => {}); client.end(JSON.stringify(body));
  await until(() => workers.length === start + 1 && workers.at(-1).job);
  const held = workers.at(-1); client.destroy();
  await until(() => held.kills === 1);
  assert.equal(held.closed, false, "abort alone cannot release CPU ownership before close");
  const busy = await request(undefined, { body });
  assert.equal(busy.status, 409); assert.equal(busy.body.code, "audio_preview_busy");
  assert.equal(workers.length, start + 1);
  held.close(1);
  await until(() => pendingHandlers.size === 0);
  const retry = await request(undefined, { body });
  assert.equal(retry.status, 200); assert.equal(retry.body.hasAudio, true);
  assert.equal(workers.length, start + 2); assert.equal(held.kills, 1);
  assert.ok(workers.slice(0, -2).every(worker => worker.kills === 0), "other completed fixture workers were not killed");
});
