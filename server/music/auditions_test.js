import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAuditions, createAuditionRoutes, createAuditionSourceInspector, exactJobReceipt, finishReplacement, audioHash } from "./auditions.js";
import { auditionPlaybackWindow } from "../../web/music-auditions.js";
import { Library } from "../library.js";

const HASH = "a".repeat(64);
const request = { source: "song.flac", fromSeconds: 10, toSeconds: 20, seeds: [101, 102] };
async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiplay-auditions-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let source = { available: true, sha256: HASH, seconds: 40, engine: "yue2", title: "Original", caption: "warm folk", lyrics: "whole words" };
  const queued = [], cancelled = [], choices = [];
  let store;
  const deps = { dir, inspectSource: async () => ({ ...source }),
    enqueueReplacement: async (b, actor) => { const id = `job${queued.length + 1}`; queued.push({ id, ...b, actor }); await store.result(id, { state: "queued" }); return { job: { id } }; },
    cancelJob: async id => { cancelled.push(id); return { state: "cancelled" }; },
    recordChoice: async (b, actor) => { choices.push({ ...b, actor }); }, verifyCandidate: async () => true, ...options };
  store = createAuditions(deps);
  return { store, deps, dir, source, queued, cancelled, choices,
    async ready(id, shortfallSeconds = 0) { await store.result(id, { state: "ready", file: `${id}.flac`, rawFile: `raw_${id}.flac`,
      seconds: 40 - shortfallSeconds, effectiveTo: 20 - shortfallSeconds, requestedTo: 20,
      shortfallSeconds, sha256: HASH, runId: `run_${id}` }); } };
}

test("creation persists distinct seeds and exact receipts without choosing a take", async t => {
  const f = await fixture(t); const s = await f.store.create(request, "agent:test");
  assert.equal(s.state, "working"); assert.equal(s.chosen, null);
  assert.deepEqual(s.takes.map(x => x.jobId), ["job1", "job2"]);
  assert.deepEqual(f.queued.map(x => x.seed), [101, 102]);
  assert.equal(f.queued[0].file, request.source); assert.equal(f.queued[0].actor, "agent:test");
  assert.equal(f.queued[0].lyrics, "whole words");
  const saved = JSON.parse(await readFile(path.join(f.dir, "auditions.json")));
  assert.equal(saved.sessions[s.id].sourceHash, HASH); assert.equal(f.choices.length, 0);
  assert.equal(exactJobReceipt({ id: "mine" }, { current: { id: "other" }, queue: [{ id: "mine", state: "queued" }] }).id, "mine");
  assert.deepEqual(exactJobReceipt({ id: "mine", state: "done", proc: {} }, {}), { id: "mine", state: "done" });
});
test("unsupported sources and silently clamped regions never enqueue", async t => {
  const f = await fixture(t);
  for (const patch of [{ fromSeconds: 0 }, { toSeconds: 41 }, { fromSeconds: 39.5 }, { count: 4 }, { seeds: [1, 1] }, { contextSeconds: 20 }])
    await assert.rejects(f.store.create({ ...request, ...patch }, "user"));
  f.source.available = false; f.source.reason = "Native GGUF has no replay data.";
  await assert.rejects(f.store.create(request, "user"), /GGUF/);
  assert.equal(f.queued.length, 0);
});
test("completion before enqueue returns is attached to the right take", async t => {
  let f;
  f = await fixture(t, { enqueueReplacement: async b => { const id = `seed${b.seed}`;
    await f.ready(id); return { job: { id } }; } });
  const s = await f.store.create(request, "user");
  assert.deepEqual(s.takes.map(x => x.state), ["ready", "ready"]);
  assert.equal(s.takes[1].file, "seed102.flac");
});
test("raw done means composing; only a measured composed result can be kept", async t => {
  const f = await fixture(t); let s = await f.store.create(request, "user");
  await f.store.observe({ history: [{ id: "job1", state: "done", file: "raw.flac" }] });
  s = await f.store.read(s.id); assert.equal(s.takes[0].state, "composing");
  await assert.rejects(f.store.keep({ id: s.id, revision: s.revision, takeId: "take1" }, "user"), /fully composed/);
  await assert.rejects(f.store.result("job1", { state: "ready", file: "candidate.flac" }), /measured duration/);
  await f.ready("job1"); await f.store.observe({ history: [{ id: "job1", state: "done", file: "raw.flac" }] });
  assert.equal((await f.store.read(s.id)).takes[0].state, "ready");
});
test("short takes require explicit acknowledgement and choice has provenance", async t => {
  const f = await fixture(t); const created = await f.store.create(request, "user"); await f.ready("job1", 2.25);
  const s = await f.store.read(created.id), b = { id: s.id, revision: s.revision, takeId: "take1" };
  await assert.rejects(f.store.keep(b, "agent:chooser"), /ending returns earlier/);
  const chosen = await f.store.keep({ ...b, acknowledgeShort: true }, "agent:chooser");
  assert.equal(chosen.chosen, "take1"); assert.equal(f.choices[0].candidate, "job1.flac");
  assert.equal(f.choices[0].source, "song.flac"); assert.equal(f.choices[0].shortfallSeconds, 2.25);
  assert.equal(f.choices[0].actor, "agent:chooser");
  await f.store.keep({ ...b, revision: chosen.revision, acknowledgeShort: true }, "agent:chooser");
  assert.equal(f.choices.length, 1);
});
test("stale concurrent choices, changed original and changed candidate are refused", async t => {
  const f = await fixture(t); const created = await f.store.create(request, "user"); await f.ready("job1"); await f.ready("job2");
  const s = await f.store.read(created.id);
  const out = await Promise.allSettled(["take1", "take2"].map(takeId => f.store.keep({ id: s.id, revision: s.revision, takeId }, "user")));
  assert.deepEqual(out.map(x => x.status), ["fulfilled", "rejected"]); assert.match(out[1].reason.message, /changed/);
  f.source.sha256 = "b".repeat(64); const changed = await f.store.read(s.id);
  await assert.rejects(f.store.keep({ id: s.id, revision: changed.revision, takeId: "take2" }, "user"), /original source changed/);
  const g = await fixture(t, { verifyCandidate: async () => false }); const gs = await g.store.create(request, "user"); await g.ready("job1");
  await assert.rejects(g.store.keep({ id: gs.id, revision: (await g.store.read(gs.id)).revision, takeId: "take1" }, "user"), /candidate file/);
});
test("a provenance failure does not claim a choice", async t => {
  const f = await fixture(t, { recordChoice: async () => { throw new Error("ledger offline"); } });
  const s = await f.store.create(request, "user"); await f.ready("job1");
  await assert.rejects(f.store.keep({ id: s.id, revision: (await f.store.read(s.id)).revision, takeId: "take1" }, "user"), /ledger/);
  assert.equal((await f.store.read(s.id)).chosen, null);
});
test("cancel touches only session jobs and discard retains all files", async t => {
  const f = await fixture(t); const s = await f.store.create(request, "user"); await f.ready("job1");
  const cancelled = await f.store.cancel({ id: s.id, revision: (await f.store.read(s.id)).revision });
  assert.deepEqual(f.cancelled, ["job2"]); assert.equal(cancelled.takes[0].file, "job1.flac");
  const dismissed = await f.store.discard({ id: s.id, revision: cancelled.revision });
  assert.equal(dismissed.state, "discarded"); assert.equal(dismissed.takes[0].file, "job1.flac");
});
test("cancellation racing an enqueue refusal does not mark the still-live job failed", async t => {
  let release, entered, f;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  f = await fixture(t, { enqueueReplacement: async () => { await f.store.result("job1", { state: "queued" }); entered(); await gate; return { job: { id: "job1" } }; },
    cancelJob: async () => { throw new Error("engine refused"); } });
  const pending = f.store.create(request, "user"); await waiting;
  const [s] = (await f.store.list()).sessions; await f.store.cancel({ id: s.id, revision: s.revision });
  release(); const out = await pending;
  assert.equal(out.takes[0].jobId, "job1"); assert.equal(out.takes[0].state, "queued");
  assert.match(out.takes[0].cancelError, /may still be running/); assert.equal(out.takes[1].state, "cancelled");
  await f.ready("job1"); assert.equal((await f.store.read(s.id)).takes[0].state, "ready");
});
test("Library.save is a real barrier for remember's background write and preserves snapshot order", async () => {
  const writes = []; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const library = new Library({ saveMetadata: async text => { writes.push(JSON.parse(text)); if (writes.length === 1) await gate; } });
  library.remember("raw.flac", { title: "raw" });
  let settled = false; const waiting = library.save().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  library.remember("candidate.flac", { title: "candidate" }); const last = library.save();
  assert.equal(writes.length, 1); release(); await waiting; await last;
  assert.equal(writes.length, 2); assert.deepEqual(Object.keys(writes[1].meta), ["raw.flac", "candidate.flac"]);
});
test("Library metadata write failure reaches explicit waiters and remains retryable", async () => {
  let broken = true; const writes = [];
  const library = new Library({ saveMetadata: async text => { if (broken) throw new Error("disk full"); writes.push(JSON.parse(text)); } });
  library.remember("candidate.flac", { title: "candidate" });
  await assert.rejects(library.save(), /disk full/); assert.equal(library.dirty, true);
  broken = false; await library.save(); assert.equal(writes[0].meta["candidate.flac"].title, "candidate");
});
test("real Library autosaves cannot let the compositor publish ready before metadata is written", async t => {
  const f = await fixture(t); await f.store.create(request, "user"); let release, written = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const library = new Library({ saveMetadata: async () => { await gate; written++; } });
  library.replaceSection = async () => ({ file: "candidate.flac", seconds: 40, effectiveTo: 20, shortfallSeconds: 0 });
  const pending = finishReplacement({ job: { id: "job1", extendedFrom: "song.flac", resumeFrames: 250, replaceTo: 20 },
    receipt: { file: "raw.flac" }, library, store: f.store, append: async () => {}, hashFile: async () => HASH, modelName: "MiniMax-Music3" });
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(written, 0); assert.equal((await f.store.jobResult("job1")).state, "composing");
  release(); assert.equal((await pending).state, "ready"); assert.equal(written, 2);
});
test("restart keeps completed files and fails pending requests without resubmission", async t => {
  const f = await fixture(t); const s = await f.store.create(request, "user"); await f.ready("job1");
  const restarted = createAuditions(f.deps); const loaded = await restarted.read(s.id);
  assert.equal(loaded.takes[0].state, "ready"); assert.equal(loaded.takes[1].state, "failed");
  assert.match(loaded.takes[1].error, /restarted/); assert.equal(f.queued.length, 2);
});
test("a corrupt store is refused without overwriting it", async t => {
  const f = await fixture(t); await f.store.list(); const file = path.join(f.dir, "auditions.json");
  await writeFile(file, "broken{"); const restarted = createAuditions(f.deps);
  await assert.rejects(restarted.list(), /not overwritten/); assert.equal(await readFile(file, "utf8"), "broken{");
});
test("source inspector validates replay artifacts and does not substitute another model", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiplay-replay-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const run = path.join(dir, "run"); await mkdir(run); await writeFile(path.join(dir, "song.flac"), "original");
  const meta = new Map([["song.flac", { durationSeconds: 40, engine: "yue2", yueDir: run }]]);
  const inspect = createAuditionSourceInspector({ library: { meta }, outputDir: dir, yueReady: async () => ({ installed: true }), minimaxReady: async () => true, apiEnabled: () => false });
  assert.equal((await inspect("song.flac")).available, false);
  for (const name of ["result.json", "semantic.npy", "plan.json", "plan_manifest.json", "prefix.npy"]) await writeFile(path.join(run, name), "fixture");
  const source = await inspect("song.flac", { hash: true }); assert.equal(source.available, true); assert.equal(source.sha256, await audioHash(path.join(dir, "song.flac")));
  meta.set("song.flac", { engine: "yue2-gguf", durationSeconds: 40 });
  assert.equal((await inspect("song.flac")).available, false);
  await assert.rejects(inspect("../song.flac"));
});
test("finish writes raw and composed provenance, measured timing, and only then ready", async t => {
  const f = await fixture(t); const s = await f.store.create(request, "agent:render");
  const events = [], metadata = new Map(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const library = { remember: (file, data) => metadata.set(file, data), save: async () => {},
    replaceSection: async (...args) => { assert.deepEqual(args, ["song.flac", "raw.flac", 10, 20, { from: 10, report: true }]); await gate;
      return { file: "candidate.flac", seconds: 38, sourceSeconds: 40, requestedFrom: 10, requestedTo: 20, effectiveTo: 18, shortfallSeconds: 2 }; } };
  const pending = finishReplacement({ job: { id: "job1", engine: "yue2", fromSeconds: 10, replaceTo: 20, extendedFrom: "song.flac", actor: "agent:render", runId: "run1", yue: { dir: "run" } },
    receipt: { file: "raw.flac", seed: 101, title: "Song · extended", audioSeconds: 26 }, library, store: f.store,
    modelName: "yue2", append: async event => events.push(event), hashFile: async () => HASH });
  await new Promise(resolve => setImmediate(resolve)); assert.equal((await f.store.jobResult("job1")).state, "composing");
  release(); const done = await pending;
  assert.equal(done.state, "ready"); assert.equal(done.rawFile, "raw.flac"); assert.equal(done.effectiveTo, 18); assert.match(done.warnings[0], /earlier/);
  assert.equal(metadata.get("candidate.flac").durationSeconds, 38); assert.equal(metadata.get("candidate.flac").yueDir, undefined);
  assert.equal(metadata.get("raw.flac").yueDir, "run"); assert.deepEqual(events.map(x => x.type), ["generate", "edit"]);
  assert.equal(events[1].data.original, "song.flac"); assert.equal(events[1].data.derivedFrom, "raw.flac");
  assert.equal((await f.store.read(s.id)).takes[0].file, "candidate.flac");
});
test("composition errors preserve the raw render and expose failure", async t => {
  const f = await fixture(t); await f.store.create(request, "user"); const kept = [];
  const result = await finishReplacement({ job: { id: "job1", extendedFrom: "song.flac", resumeFrames: 250, replaceTo: 20 }, receipt: { file: "raw.flac" },
    library: { remember: f => kept.push(f), save: async () => {}, replaceSection: async () => { throw new Error("rate mismatch"); } },
    store: f.store, append: async () => {}, hashFile: async () => HASH, modelName: "MiniMax-Music3" });
  assert.equal(result.state, "failed"); assert.match(result.error, /rate mismatch/); assert.equal(result.rawFile, "raw.flac"); assert.deepEqual(kept, ["raw.flac"]);
});
test("missing or cached raw outputs fail instead of sticking in composing", async t => {
  const f = await fixture(t); await f.store.create(request, "user");
  await f.store.observe({ history: [{ id: "job1", state: "done" }, { id: "job2", state: "done", file: "old.flac", cached: true }] });
  assert.equal((await f.store.jobResult("job1")).state, "failed"); assert.match((await f.store.jobResult("job2")).error, /cached/);
});
test("playback uses each take's actual outgoing seam, retaining original comparison", () => {
  const s = { source: "song.flac", fromSeconds: 10, toSeconds: 20, sourceSeconds: 40, contextSeconds: 3 };
  const take = { file: "short.flac", seconds: 38, effectiveTo: 18 };
  assert.deepEqual(auditionPlaybackWindow(s, take, "out"), { file: "short.flac", from: 15, to: 21 });
  assert.deepEqual(auditionPlaybackWindow(s, null, "out"), { file: "song.flac", from: 17, to: 23 });
  assert.deepEqual(auditionPlaybackWindow(s, take), { file: "short.flac", from: 7, to: 21 });
});
test("HTTP routes keep state and actor handling on the shared store", async t => {
  const f = await fixture(t); let reply;
  const route = createAuditionRoutes({ store: f.store, readBody: async req => req.body,
    json: (_, status, body) => { reply = { status, body }; }, actorFrom: req => req.actor });
  const url = new URL("http://local/api/music-auditions");
  assert.equal(await route({ method: "POST", actor: "agent:http", body: { action: "create", ...request } }, {}, url), true);
  assert.equal(reply.status, 200); assert.equal(reply.body.session.actor, "agent:http");
  await route({ method: "GET" }, {}, new URL(`${url}?jobId=job1`)); assert.equal(reply.body.result.jobId, "job1");
  await route({ method: "POST", body: { action: "invented" } }, {}, url); assert.equal(reply.status, 400);
});
