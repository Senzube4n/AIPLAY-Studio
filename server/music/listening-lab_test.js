import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createListeningLab, createListeningLabRoutes } from "./listening-lab.js";
import { musicListeningLabTools } from "../mcp-music-listening-lab.js";

const HASH = "a".repeat(64), OTHER = "b".repeat(64);
const createBody = () => ({ action: "create", idempotencyKey: "experiment-one", name: "Held-out phrasing", purpose: "Listen for articulation without accompaniment damage",
  adapter: "mine_test.safetensors", checkpoint: "yue2.safetensors", strength: .8,
  trainingSource: { file: "source.flac", startSeconds: 0, seconds: 8 },
  cases: [{ name: "New chorus", caption: "Warm folk", lyrics: "These are different words", seed: 0, maxDuration: 60, narSteps: 32, cot: "full" }] });
async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiplay-listening-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const cap = { engine: "yue2-comfy", ready: true, checkpoints: [{ name: "yue2.safetensors", identity: "sha256:checkpoint" }],
    adapters: [{ name: "mine_test.safetensors", identity: "sha256:adapter", bytes: 100 }] };
  const sources = new Map([["source.flac", { file: "source.flac", seconds: 40, sha256: HASH }]]), jobs = new Map(), queued = [], events = [], cancelled = [];
  const deps = { appData: dir, capabilities: async () => structuredClone(cap), inspectSource: async file => structuredClone(sources.get(file)),
    submitGenerate: async ({ request, actor, requestId }) => { const id = `job${queued.length + 1}`; queued.push({ request, actor, requestId }); jobs.set(id, { id, state: "queued" }); return { job: { id } }; },
    readJob: async id => structuredClone(jobs.get(id)), cancelJob: async id => { cancelled.push(id); jobs.get(id).state = "cancelled"; return { state: "cancelled" }; },
    recordEvent: async event => events.push(event), random: () => 1, ...overrides };
  const store = createListeningLab(deps);
  async function ready(value) {
    for (const [id, job] of jobs) { Object.assign(job, { state: "done", file: `${id}.flac`, seconds: 37.5, sha256: OTHER, runId: `run-${id}` }); sources.set(job.file, { file: job.file, seconds: job.seconds, sha256: job.sha256 }); }
    return (await store.request({ action: "refresh", id: value })).experiment;
  }
  return { store, deps, dir, cap, sources, jobs, queued, events, cancelled, ready,
    async create(body = createBody()) { return (await store.request(body, "agent:test")).experiment; },
    async start(row, idempotencyKey = "submission-one") { return (await store.request({ action: "start", id: row.id, expectedRevision: row.revision, idempotencyKey }, "agent:test")).experiment; } };
}

test("experiment freezes separate source/evaluation material, is idempotent and hides pair identities", async t => {
  const f = await fixture(t), row = await f.create();
  assert.equal(row.state, "planned"); assert.equal(row.trainingSource.evidence, "user_declared"); assert.equal(f.queued.length, 0);
  assert.equal(row.takes[0].label, "A"); assert.equal(row.takes[0].role, undefined); assert.equal(row.takes[0].request, undefined);
  const disk = JSON.parse(await readFile(path.join(f.dir, "music-listening-lab", `${row.id}.json`)));
  assert.equal(disk.takes[0].role, "adapter"); assert.equal(disk.takes[1].role, "base");
  assert.equal(disk.trainingSource.sha256, HASH); assert.equal(row.cases[0].lyrics, "These are different words");
  assert.equal((await f.create()).id, row.id); assert.equal(f.events.length, 1);
  await assert.rejects(f.create({ ...createBody(), purpose: "Changed" }), /different experiment/);
});

test("matching training receipts are distinguished from a user declaration", async t => {
  const f = await fixture(t); f.cap.adapters[0].training = { file: "source.flac", startSeconds: 0, seconds: 8, sourceSha256: HASH, runId: "training-run" };
  const row = await f.create(); assert.equal(row.trainingSource.evidence, "verified_training_receipt"); assert.equal(row.trainingSource.runId, "training-run");
});

test("invalid clamps, unavailable engines, and overlapping evaluation audio never queue", async t => {
  const f = await fixture(t);
  for (const patch of [{ maxDuration: 8 }, { maxDuration: 301 }, { narSteps: 7 }, { narSteps: 32.5 }, { seed: -1 }]) {
    const body = createBody(); Object.assign(body.cases[0], patch); await assert.rejects(f.create(body));
  }
  const body = createBody(); body.cases[0].reference = { file: "source.flac", startSeconds: 6, seconds: 8 };
  await assert.rejects(f.create(body), /overlaps the training/);
  body.cases[0].reference.startSeconds = 8; assert.equal((await f.create(body)).cases[0].reference.startSeconds, 8);
  f.cap.engine = "yue2-gguf"; await assert.rejects(f.create({ ...createBody(), idempotencyKey: "other" }), /not ready/);
  assert.equal(f.queued.length, 0);
});

test("paired queue requests share actual settings, disable both saved adapter slots and preserve exact IDs", async t => {
  const f = await fixture(t); let row = await f.create(); row = await f.start(row);
  assert.deepEqual(row.takes.map(t => t.jobId), ["job1", "job2"]);
  const [adapted, base] = f.queued.map(q => q.request);
  assert.equal(adapted.lora, "mine_test.safetensors"); assert.equal(base.lora, "");
  assert.equal(adapted.loraClip, ""); assert.equal(base.loraClip, ""); assert.equal(adapted.seed, 0); assert.equal(adapted.mixSeed, 0);
  const normalized = ({ title, lora, loraStrength, ...rest }) => rest;
  assert.deepEqual(normalized(adapted), normalized(base)); assert.equal(adapted.checkpoint, "yue2.safetensors");
  assert.equal(f.queued[0].actor, "agent:test"); assert.notEqual(f.queued[0].requestId, f.queued[1].requestId);
  await f.start(row); assert.equal(f.queued.length, 2);
  await assert.rejects(f.start(row, "another-submit"), /already has a submission/);
});

test("changed adapter/checkpoint/source refuses before a submission is recorded", async t => {
  const f = await fixture(t), row = await f.create();
  f.cap.adapters[0].identity = "sha256:changed"; await assert.rejects(f.start(row), /changed since review/);
  f.cap.adapters[0].identity = "sha256:adapter"; f.cap.checkpoints[0].identity = "sha256:other"; await assert.rejects(f.start(row), /changed since review/);
  f.cap.checkpoints[0].identity = "sha256:checkpoint"; f.sources.get("source.flac").sha256 = OTHER; await assert.rejects(f.start(row), /recording changed/);
  assert.equal(f.queued.length, 0); assert.equal((await f.store.get(row.id)).experiment.submission, null);
});

test("readiness requires measured fingerprinted audio, and exact-job mismatches cannot attach another take", async t => {
  const f = await fixture(t); const row = await f.start(await f.create());
  f.jobs.set("job1", { id: "other", state: "done", file: "wrong.flac", seconds: 40, sha256: HASH });
  await assert.rejects(f.store.refresh(row.id), /different job/);
  f.jobs.set("job1", { id: "job1", state: "done", file: "raw.flac" });
  assert.equal((await f.store.refresh(row.id)).experiment.takes[0].state, "running");
  const ready = await f.ready(row.id); assert.equal(ready.state, "review"); assert.equal(ready.takes[0].seconds, 37.5);
  f.jobs.get("job1").sha256 = HASH;
  const changed = (await f.store.refresh(row.id)).experiment; assert.equal(changed.takes[0].state, "failed"); assert.match(changed.takes[0].error, /file changed/);
  assert.equal((await f.store.refresh(row.id)).experiment.takes[0].state, "failed", "another refresh cannot silently accept replacement bytes");
});

test("ratings save listener observations before explicit reveal and survive restart without queue history", async t => {
  const f = await fixture(t); let row = await f.start(await f.create()); row = await f.ready(row.id);
  const rate = r => ({ action: "rate", id: r.id, expectedRevision: r.revision, caseId: "case1", preference: "B", ratings: { A: 2, B: 4 }, unwantedChanges: { A: "duller consonants", B: "" }, notes: "My listening notes" });
  row = (await f.store.request(rate(row), "user")).experiment;
  assert.equal(row.revealed, false); assert.equal(row.ratings[0].blinded, true); assert.equal(row.ratings[0].preference, "B");
  assert.equal(row.quality, undefined); assert.equal(row.takes[0].role, undefined);
  await assert.rejects(f.store.request({ ...rate(row), expectedRevision: 1 }, "user"), /changed/);
  f.jobs.clear(); const restarted = createListeningLab(f.deps);
  row = (await restarted.request(rate(row), "user")).experiment; assert.equal(row.ratings.length, 2);
  row = (await restarted.request({ action: "reveal", id: row.id, expectedRevision: row.revision }, "user")).experiment;
  assert.equal(row.takes[0].role, "adapter"); assert.equal(row.takes[1].role, "base");
  row = (await restarted.request(rate(row), "user")).experiment; assert.equal(row.ratings[2].blinded, false);
  assert.equal(f.events.filter(e => e.data.op === "listening-lab-rating").length, 3);
});

test("changed candidate bytes block rating and provenance failures do not save an observation", async t => {
  const f = await fixture(t); let row = await f.start(await f.create()); row = await f.ready(row.id);
  const rating = { action: "rate", id: row.id, expectedRevision: row.revision, caseId: "case1", preference: "tie", ratings: { A: 3, B: 3 } };
  f.sources.get("job1.flac").sha256 = HASH; await assert.rejects(f.store.request(rating, "user"), /missing or changed/);
  f.sources.get("job1.flac").sha256 = OTHER;
  const failing = createListeningLab({ ...f.deps, recordEvent: async () => { throw new Error("ledger unavailable"); } });
  await assert.rejects(failing.request(rating, "user"), /ledger unavailable/);
  assert.equal((await failing.get(row.id)).experiment.ratings.length, 0);
});

test("uncertain submission stops remaining jobs and idempotent retry never spends the queue again", async t => {
  let calls = 0; const f = await fixture(t, { submitGenerate: async () => { calls++; throw new Error("connection lost after submit"); } });
  let row = await f.start(await f.create()); assert.equal(row.takes[0].state, "submission_unknown"); assert.equal(row.takes[1].state, "cancelled");
  const restarted = createListeningLab(f.deps);
  row = (await restarted.request({ action: "start", id: row.id, expectedRevision: row.revision, idempotencyKey: "submission-one" }, "user")).experiment;
  assert.equal(calls, 1); assert.equal(row.state, "attention");
});

test("cancellation during an in-flight receipt keeps refused live jobs visible and cancels unsubmitted peers", async t => {
  let release, entered; const gate = new Promise(r => release = r), submitted = new Promise(r => entered = r); let calls = 0;
  const f = await fixture(t, { submitGenerate: async () => { calls++; entered(); await gate; return { job: { id: "live-job" } }; }, cancelJob: async () => { throw new Error("engine did not confirm"); } });
  let row = await f.create(), pending = f.start(row); await submitted;
  row = (await f.store.get(row.id)).experiment;
  await f.store.request({ action: "cancel", id: row.id, expectedRevision: row.revision }, "user"); release(); row = await pending;
  assert.equal(calls, 1); assert.equal(row.takes[0].state, "queued"); assert.match(row.takes[0].cancelError, /may still be running/);
  assert.equal(row.takes[1].state, "cancelled"); assert.equal(row.takes[0].jobId, "live-job");
});

test("a duplicate queue receipt remains uncertain and can never complete both sides of a pair", async t => {
  let f;
  f = await fixture(t, { submitGenerate: async request => {
    const actualId = `job${f.queued.length + 1}`;
    f.queued.push(request); f.jobs.set(actualId, { id: actualId, state: "queued" });
    // Reproduce the old API: both submissions return the currently active id,
    // although the second submission has really created a different queued job.
    return { job: { id: "job1" } };
  } });
  const body = createBody(); body.cases.push({ ...body.cases[0], name: "Second evaluation", seed: 1 });
  let row = await f.start(await f.create(body));
  assert.equal(f.queued.length, 2, "uncertain receipt stops the remaining pair");
  assert.equal(row.takes[0].jobId, "job1"); assert.equal(row.takes[0].state, "queued");
  assert.equal(row.takes[1].jobId, null); assert.equal(row.takes[1].state, "submission_unknown");
  assert.match(row.takes[1].error, /Duplicate queue receipt: job job1/);
  assert.ok(row.takes.slice(2).every(take => take.state === "cancelled"));
  row = await f.ready(row.id);
  assert.equal(row.takes[0].state, "ready"); assert.equal(row.takes[1].state, "submission_unknown");
  assert.equal(row.state, "attention");
  const restarted = createListeningLab(f.deps);
  row = (await restarted.refresh(row.id)).experiment;
  assert.equal(row.takes.filter(take => take.state === "ready").length, 1);
  assert.equal(row.takes[1].jobId, null, "do not guess the unreceipted queued job");
  await restarted.request({ action: "start", id: row.id, expectedRevision: row.revision, idempotencyKey: "submission-one" });
  assert.equal(f.queued.length, 2, "retry after restart cannot spend another render");
  await assert.rejects(restarted.request({ action: "rate", id: row.id, expectedRevision: row.revision,
    caseId: "case1", preference: "A", ratings: { A: 4, B: 2 } }), /Both takes/);
});

test("restart reports interrupted jobs, refresh can recover exact completion, and corrupt records are retained", async t => {
  const f = await fixture(t); const row = await f.start(await f.create());
  const restarted = createListeningLab(f.deps);
  assert.equal((await restarted.get(row.id)).experiment.takes[0].state, "interrupted"); assert.equal(f.queued.length, 2);
  await f.ready(row.id); assert.equal((await restarted.refresh(row.id)).experiment.state, "review");
  const file = path.join(f.dir, "music-listening-lab", `${row.id}.json`); await writeFile(file, "broken{");
  await assert.rejects(restarted.get(row.id), /not overwritten/);
  assert.equal((await restarted.list()).errors.length, 1); assert.equal(await readFile(file, "utf8"), "broken{");
});

test("typed MCP routes every parameter and separates render consent from planning", async t => {
  const f = await fixture(t); let response;
  const route = createListeningLabRoutes({ ...f.deps, json: (_, status, body) => response = { status, body }, readBody: async req => req.body, actorFrom: req => req.actor });
  const api = async (method, url, body) => { await route({ method, body, actor: "agent:mcp" }, {}, new URL(`http://local${url}`)); if (response.status >= 400) throw new Error(response.body.error); return response.body; };
  const [plan, render] = musicListeningLabTools(api);
  for (const tool of [plan, render]) for (const name of Object.keys(tool.inputSchema.properties)) assert.ok(String(tool.run).includes(name), `${tool.name}.${name}`);
  assert.throws(() => plan.run({ action: "start" }), /requires music_listening_lab_start/);
  const created = await plan.run(createBody()); assert.equal(created.experiment.createdBy, "agent:mcp"); assert.equal(f.queued.length, 0);
  const queued = await render.run({ id: created.experiment.id, expectedRevision: created.experiment.revision, idempotencyKey: "via-mcp" });
  assert.deepEqual(queued.experiment.takes.map(t => t.jobId), ["job1", "job2"]);
  assert.equal(f.queued[0].request.seed, 0); assert.equal(f.queued[0].request.instrumental, false);
  assert.throws(() => render.run({ id: created.experiment.id, invented: true }), /Unsupported/);
});
