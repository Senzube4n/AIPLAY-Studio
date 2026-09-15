import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir, unlink } from "node:fs/promises";
import { createAudioPreview, validateAudioPreviewRequest, AUDIO_PREVIEW_LIMITS } from "./audio-preview.js";

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function wav(frames) {
  const b = Buffer.alloc(44 + frames * 4);
  b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(48000, 24); b.writeUInt32LE(192000, 28);
  b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(frames * 4, 40);
  return b;
}
async function fixture(t, render) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vfx-audio-preview-test-"));
  const cacheDir = path.join(tmp, "cache");
  const src = path.join(tmp, "source.wav");
  await writeFile(src, wav(480));
  const state = { doc: { slug: "fixture", updatedAt: 1, duration: 10, layers: [{ type: "audio", src }] }, calls: [], time: 1000 };
  const engine = async (mode, job, options) => {
    state.calls.push({ mode, job, options });
    if (render) return render({ state, mode, job, options });
    const frames = Math.round((job.to - job.from) * 48000);
    await writeFile(job.out, wav(frames));
    return { ok: true, hasAudio: true, frames, rate: 48000 };
  };
  const preview = createAudioPreview({ cacheDir, readComp: async () => structuredClone(state.doc),
    resolveCompTree: async doc => doc, compStamp: async doc => String(doc.updatedAt), runEngine: engine, now: () => state.time });
  t.after(async () => {
    await preview.close();
    const full = path.resolve(tmp);
    assert.equal(path.dirname(full), path.resolve(os.tmpdir()));
    assert.ok(path.basename(full).startsWith("vfx-audio-preview-test-"));
    await rm(full, { recursive: true, force: true });
  });
  return { preview, state, src, cacheDir, body: { slug: "fixture", expectedRevision: 1, from: 0, to: 0.02 } };
}

test("preview request is typed, bounded, revision-required, and rejects hidden payload fields", () => {
  const good = { slug: "abc-1", expectedRevision: 5, from: 0, to: 120 };
  assert.deepEqual(validateAudioPreviewRequest(good), good);
  for (const bad of [null, [], { ...good, from: "0" }, { ...good, to: Infinity }, { ...good, from: -1 },
    { ...good, to: 0 }, { ...good, expectedRevision: undefined }, { ...good, expectedRevision: 1.1 },
    { ...good, slug: "../abc" }, { ...good, source: "/private.wav" }, { ...good, out: "/arbitrary.wav" }]) {
    assert.throws(() => validateAudioPreviewRequest(bad), e => e.code === "audio_preview_invalid");
  }
  assert.throws(() => validateAudioPreviewRequest({ ...good, to: 120.001 }), e => e.code === "audio_preview_limit");
});
test("exact engine command, atomic PCM artifact, and cache reuse leave composition untouched", async t => {
  const { preview, state, body } = await fixture(t);
  const original = structuredClone(state.doc);
  const ready = await preview.prepare(body);
  assert.equal(ready.hasAudio, true); assert.equal(ready.duration, 0.02); assert.equal(ready.revision, 1);
  assert.match(ready.url, /^\/api\/vfx\/audio-preview\/fixture\/[a-f0-9]{64}\.wav$/);
  const key = path.basename(ready.url, ".wav");
  const file = await preview.file({ slug: body.slug, key });
  assert.equal(file.bytes, 44 + 960 * 4);
  assert.equal((await readFile(file.path)).toString("ascii", 0, 4), "RIFF");
  assert.deepEqual(await preview.prepare(body), ready);
  assert.equal(state.calls.length, 1); assert.equal(state.calls[0].mode, "audio-preview");
  assert.match(state.calls[0].job.out, /\.part\.wav$/);
  assert.equal(state.calls[0].options.timeoutMs, 90000);
  assert.deepEqual(state.doc, original);
});
test("missing/revised compositions and out-of-composition work areas fail before engine", async t => {
  const { preview, state, body } = await fixture(t);
  await assert.rejects(preview.prepare({ ...body, to: 11 }), e => e.code === "audio_preview_invalid");
  state.doc.updatedAt++;
  await assert.rejects(preview.prepare(body), e => e.code === "comp_conflict");
  state.doc = null;
  await assert.rejects(preview.prepare(body), e => e.code === "audio_preview_missing");
  assert.equal(state.calls.length, 0);
});
test("changed source bytes invalidate old URL even without a composition edit", async t => {
  const { preview, state, body, src } = await fixture(t);
  const ready = await preview.prepare(body);
  await writeFile(src, wav(481));
  await assert.rejects(preview.file({ slug: body.slug, key: path.basename(ready.url, ".wav") }), e => e.code === "comp_conflict");
  const next = await preview.prepare(body);
  assert.notEqual(next.url, ready.url); assert.equal(state.calls.length, 2);
});
test("nested resolved document changes invalidate the receipt", async t => {
  const { preview, state, body } = await fixture(t);
  state.doc.comps = { child: { slug: "child", updatedAt: 1, duration: 1, layers: [] } };
  const first = await preview.prepare(body);
  state.doc.comps.child.updatedAt = 2;
  const second = await preview.prepare(body);
  assert.notEqual(first.url, second.url);
});
test("source or revision changing during mix prevents publication", async t => {
  const { preview, cacheDir, body } = await fixture(t, async ({ state, job }) => {
    await writeFile(job.out, wav(960)); state.doc.updatedAt++;
    return { ok: true, hasAudio: true, rate: 48000, frames: 960 };
  });
  await assert.rejects(preview.prepare(body), e => e.code === "comp_conflict");
  assert.deepEqual(await readdir(cacheDir), []);
});
test("cancellation keeps the one-worker barrier until owned runner closes", async t => {
  const entered = deferred(), closed = deferred();
  const { preview, state, body, cacheDir } = await fixture(t, async ({ options }) => {
    entered.resolve(options.signal); await closed.promise; throw new Error("child closed");
  });
  const controller = new AbortController();
  const pending = preview.prepare(body, { signal: controller.signal });
  const pendingRejected = assert.rejects(pending, e => e.code === "audio_preview_cancelled");
  const workerSignal = await entered.promise;
  controller.abort(); assert.equal(workerSignal.aborted, true);
  await assert.rejects(preview.prepare(body), e => e.code === "audio_preview_busy");
  assert.equal(state.calls.length, 1);
  closed.resolve(); await pendingRejected;
  assert.deepEqual(await readdir(cacheDir), []);
});
test("already-aborted request never invokes Python", async t => {
  const { preview, state, body } = await fixture(t);
  await assert.rejects(preview.prepare(body, { signal: AbortSignal.abort() }), e => e.code === "audio_preview_cancelled");
  assert.equal(state.calls.length, 0);
});
test("silent exact-mixer result has no pretend WAV and is cached", async t => {
  const { preview, state, body, cacheDir } = await fixture(t, async () => ({ ok: true, hasAudio: false, rate: 48000, frames: 0 }));
  const result = await preview.prepare(body);
  assert.equal(result.hasAudio, false); assert.equal(result.url, null);
  assert.deepEqual(await readdir(cacheDir), []);
  await preview.prepare(body); assert.equal(state.calls.length, 1);
});
test("disabled and non-solo unresolved sources do not break a valid silent preview", async t => {
  const { preview, state, body } = await fixture(t, async () => ({ ok: true, hasAudio: false, rate: 48000, frames: 0 }));
  state.doc.layers = [{ type: "audio", src: "missing-disabled.wav", enabled: false }];
  assert.equal((await preview.prepare(body)).hasAudio, false);
  state.doc.updatedAt++;
  state.doc.layers = [{ type: "solid", solo: true }, { type: "audio", src: "missing-nonsolo.wav" }];
  assert.equal((await preview.prepare({ ...body, expectedRevision: 2 })).hasAudio, false);
  assert.equal(state.calls.length, 2);
});
test("malformed PCM output never receives a public cache URL", async t => {
  const { preview, body, cacheDir } = await fixture(t, async ({ job }) => {
    await writeFile(job.out, "not WAV"); return { ok: true, hasAudio: true, frames: 960, rate: 48000 };
  });
  await assert.rejects(preview.prepare(body), e => e.code === "audio_preview_failed");
  assert.deepEqual(await readdir(cacheDir), []);
});
test("cache is count-bounded, expires without timers, and rejects unknown paths", async t => {
  const { preview, state, body, cacheDir } = await fixture(t);
  let last;
  for (let i = 1; i <= AUDIO_PREVIEW_LIMITS.files + 2; i++) {
    state.doc.updatedAt = i; state.time++;
    last = await preview.prepare({ ...body, expectedRevision: i });
  }
  assert.equal((await readdir(cacheDir)).length, AUDIO_PREVIEW_LIMITS.files);
  for (const bad of [{ slug: "../fixture", key: "a".repeat(64) }, { slug: "fixture", key: "../../file" }]) {
    await assert.rejects(preview.file(bad), e => e.code === "audio_preview_invalid");
  }
  state.time += AUDIO_PREVIEW_LIMITS.ttlMs;
  await assert.rejects(preview.file({ slug: "fixture", key: path.basename(last.url, ".wav") }), e => e.code === "audio_preview_expired");
  await preview.prepare({ ...body, expectedRevision: state.doc.updatedAt });
  assert.equal((await readdir(cacheDir)).length, 1);
});
test("startup removes only narrowly owned stale preview files", async t => {
  const { preview, body, cacheDir } = await fixture(t);
  await mkdir(cacheDir);
  await writeFile(path.join(cacheDir, `${"a".repeat(64)}.wav`), "old transient preview");
  await writeFile(path.join(cacheDir, "user.wav"), "preserve unrelated");
  await preview.prepare(body);
  assert.equal(await readFile(path.join(cacheDir, "user.wav"), "utf8"), "preserve unrelated");
  assert.equal((await readdir(cacheDir)).length, 2);
});
test("missing sources fail closed without leaking resolved filesystem paths", async t => {
  const { preview, state, body, src } = await fixture(t);
  await unlink(src);
  await assert.rejects(preview.prepare(body), e => e.code === "audio_preview_source" && !e.message.includes(src));
  assert.equal(state.calls.length, 0);
});
test("closed service cannot start new work", async t => {
  const { preview, state, body } = await fixture(t);
  await preview.close();
  await assert.rejects(preview.prepare(body), e => e.code === "audio_preview_unavailable");
  assert.equal(state.calls.length, 0);
});
