/**
 * THE MODEL DOWNLOADER: CANCEL THAT WORKS, A STALL THAT ENDS, A RESUME THAT HOLDS.
 *
 * Reported with MiniMax H3 (40+ GB): the download did not move, Cancel did not
 * go away, and the app was unusable. Two causes, both here: the file was
 * written without waiting for the disk (every chunk the network outran it with
 * piled up in memory), and Cancel was a flag read between chunks, which a
 * connection that had stopped sending never delivered.
 *
 * A local HTTP server plays the publisher: it sends part of a file and then
 * goes silent. No internet, no model, a few hundred kilobytes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AIPLAY_DOWNLOAD_STALL_MS = "1500";
const { ModelManager, CATALOG } = await import("./models.js");

const SIZE = 300_000;
const BODY = Buffer.alloc(SIZE, 7);
for (let i = 0; i < SIZE; i++) BODY[i] = i % 251;
const SHA = createHash("sha256").update(BODY).digest("hex");

/** Sends the first `cut` bytes, then nothing, until `release` is set. Honours Range. */
function server({ cut }) {
  const s = { release: false, requests: [] };
  s.http = http.createServer((req, res) => {
    const m = /bytes=(\d+)-/.exec(req.headers.range || "");
    const from = m ? Number(m[1]) : 0;
    s.requests.push(from);
    if (from >= SIZE) { res.writeHead(416); return res.end(); }
    res.writeHead(m ? 206 : 200, { "Content-Length": SIZE - from });
    if (s.release) return res.end(BODY.subarray(from));
    res.write(BODY.subarray(from, Math.max(from, cut)));   // then silence
    s.hung = res;
  });
  return new Promise((r) => s.http.listen(0, "127.0.0.1", () => { s.url = `http://127.0.0.1:${s.http.address().port}/f.bin`; r(s); }));
}

async function row(dir, url) {
  const id = `test-${Math.random().toString(36).slice(2)}`;
  CATALOG.push({ id, label: "Test model", files: [{ url, dest: path.join(dir, "f.bin"), bytes: SIZE, sha256: SHA }] });
  return id;
}
const drop = (id) => { const i = CATALOG.findIndex((c) => c.id === id); if (i >= 0) CATALOG.splice(i, 1); };

test("Cancel on a connection that stopped sending ends it at once and clears the row", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aiplay-dl-"));
  const s = await server({ cut: 100_000 });
  const id = await row(dir, s.url);
  const m = new ModelManager();
  try {
    const running = m.download(id);
    await new Promise((r) => setTimeout(r, 400));          // mid-silence
    assert.equal(m.progress.has(id), true);
    const t0 = Date.now();
    m.cancel(id);
    assert.equal(m.progress.has(id), false, "the row stops saying 'downloading' the moment Cancel is pressed");
    const r = await running;
    assert.deepEqual(r, { cancelled: true });
    assert.ok(Date.now() - t0 < 1000, `it did not wait for the stall timer (${Date.now() - t0} ms)`);
    assert.ok(existsSync(path.join(dir, "f.bin.part")), "what arrived is kept for a resume");
  } finally { drop(id); s.hung?.destroy(); s.http.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a server that goes silent is given up on, and Download resumes from the bytes kept", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aiplay-dl-"));
  const s = await server({ cut: 120_000 });
  const id = await row(dir, s.url);
  const m = new ModelManager();
  try {
    await assert.rejects(m.download(id), /sent nothing for 1\.5 s[\s\S]*press Download again/);
    assert.equal(m.progress.get(id)?.state, "failed", "a stall is a failure the row explains");
    const kept = (await stat(path.join(dir, "f.bin.part"))).size;
    assert.equal(kept, 120_000);

    s.release = true;
    s.hung?.destroy();
    assert.deepEqual(await m.download(id), { ok: true });
    assert.equal(s.requests.at(-1), 120_000, "the second request asked only for what was missing (Range)");
    const got = await readFile(path.join(dir, "f.bin"));
    assert.equal(createHash("sha256").update(got).digest("hex"), SHA, "and the joined file is the right one");
    assert.equal(m.progress.has(id), false);
  } finally { drop(id); s.http.close(); await rm(dir, { recursive: true, force: true }); }
});

test("the file is written at the disk's pace, and the checksum can be cancelled too", () => {
  const src = readFileSync(new URL("./models.js", import.meta.url), "utf8");
  assert.match(src, /if \(!out\.write\(chunk\)\) await once\(out, "drain"\);/, "backpressure: no unbounded buffering in memory");
  assert.doesNotMatch(src, /\n\s+out\.write\(chunk\);\n/, "no bare write left");
  assert.match(src, /await sha256Of\(part, \(\) => this\.cancelled\.has\(id\)\)/);
  assert.match(src, /this\.#aborts\.get\(id\)\?\.abort\(\);/);
});

test("the model window asks for H3's territory confirmation, as the Models screen does", () => {
  const pick = readFileSync(new URL("../web/modelpick.js", import.meta.url), "utf8");
  assert.match(pick, /c\.region && !c\.ready \? `<label class="mp-region"><input type="checkbox" data-ack=/);
  assert.match(pick, /if \(ack && !ack\.checked\) \{ say\("Tick the licence box/);
  assert.match(pick, /acceptRegion: !!ack\?\.checked/);
});

test("a failed row does not block Download again", () => {
  const src = readFileSync(new URL("./models.js", import.meta.url), "utf8");
  assert.match(src, /if \(this\.progress\.has\(id\) && this\.progress\.get\(id\)\.state !== "failed"\) return \{ alreadyRunning: true \};/);
});

test("two simultaneous starts write a capability only once", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aiplay-dl-"));
  const s = await server({ cut: SIZE }); s.release = true;
  const id = await row(dir, s.url);
  const m = new ModelManager();
  try {
    const results = await Promise.all([m.download(id), m.download(id)]);
    assert.deepEqual(results, [{ ok: true }, { alreadyRunning: true }]);
    assert.deepEqual(s.requests, [0]);
  } finally { drop(id); s.http.close(); await rm(dir, { recursive: true, force: true }); }
});

test("cancel during checksum and immediate retry waits for the old file handle and reuses the complete partial", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aiplay-dl-"));
  const s = await server({ cut: SIZE }); s.release = true;
  const id = await row(dir, s.url);
  const m = new ModelManager();
  let retried = false, retry;
  m.on("update", () => {
    if (!retried && m.progress.get(id)?.state === "checking") {
      retried = true;
      m.cancel(id);
      retry = m.download(id);
      retry.catch(() => {});
    }
  });
  try {
    assert.deepEqual(await m.download(id), { cancelled: true });
    assert.ok(retried, "the cancel happened while verifying the downloaded bytes");
    assert.deepEqual(await retry, { ok: true });
    assert.deepEqual(s.requests, [0], "a complete partial needs a checksum, not an invalid Range request");
    assert.deepEqual(await readFile(path.join(dir, "f.bin")), BODY);
    assert.equal(m.progress.has(id), false);
  } finally { await retry?.catch(() => {}); drop(id); s.http.close(); await rm(dir, { recursive: true, force: true }); }
});
