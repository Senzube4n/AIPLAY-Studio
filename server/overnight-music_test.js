import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { BatchRunner, plannedPaidSongs } from "./batch.js";
import { cleanMusicItem } from "./batch-music.js";
import { MUSIC_BATCH_FIELDS, musicBatchIdea } from "../web/music-batch-spec.js";
import { TOOLS } from "./mcp.js";
import { config } from "./config.js";

const lyrics = "\r\n[Verse]\r\nSing these words  \r\n\r\n[Chorus]\r\nKeep this take \r\n ";
const abc = "X:1\nT:Exact score\nM:4/4\nK:C\nC2 D2 E4 |  \n";
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");

function musicForm(spec, engine = spec.engine) {
  const fields = { btnToOvernight: {}, ovAdd: {}, caption: { focus() {} }, ctaNote: {}, ovEst: {},
    yAbcUse: { checked: !!spec.abc }, yAbc: { value: abc } };
  const context = vm.createContext({
    musicBatchIdea, currentSpec: () => spec, state: { musicEngine: engine, musicYue2Checkpoint: "chosen.safetensors" },
    captionValue: () => spec.caption, $: id => fields[id], ov: { kind: "music", ideas: [] }, ovRender() {},
  });
  const start = app.indexOf("function ovMusicIdea() {");
  const end = app.indexOf('$("btnCreate").onclick', start);
  vm.runInContext(app.slice(start, end), context);
  const second = app.indexOf('$("ovAdd").onclick = () => {');
  vm.runInContext(app.slice(second, app.indexOf('$("ovClear").onclick', second)), context);
  fields.btnToOvernight.onclick(); fields.ovAdd.onclick();
  return JSON.parse(JSON.stringify(context.ov.ideas));
}

class FakeJobs extends EventEmitter {
  constructor() { super(); this.queue = []; this.history = []; this.submitted = []; this.cancelled = []; }
  enqueue(spec) {
    const job = { ...spec, id: `job-${this.submitted.length}`, state: "queued" };
    this.submitted.push(job); this.queue.push(job); this.emit("update", this.snapshot()); return job;
  }
  finish(job, state = "done") {
    this.queue = this.queue.filter(j => j.id !== job.id);
    job.state = state; if (state === "done") job.file = `${job.id}.flac`;
    this.history.unshift(job); this.emit("update", this.snapshot());
  }
  cancelById(id) { this.cancelled.push(id); const job = this.queue.find(j => j.id === id); if (job) this.finish(job, "cancelled"); }
  snapshot() { return { queue: this.queue, current: null, history: this.history }; }
}
async function fixture(t, enqueue) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiplay-overnight-music-"));
  const jobs = new FakeJobs();
  const runner = new BatchRunner(jobs, { stateFile: path.join(dir, "batch.json"), keepAwake() {},
    enqueueMusic: enqueue ? spec => enqueue(spec, jobs) : spec => jobs.enqueue(spec) });
  t.after(async () => { runner.stop(); await tick(); await new Promise(resolve => setTimeout(resolve, 20)); await rm(dir, { recursive: true, force: true }); });
  return { jobs, runner, dir };
}
const idea = (engine = "yue2-comfy") => ({ engine, caption: "Warm synth pop", lyrics, instrumental: false, cot: "full", narSteps: 32 });

test("both UI Add handlers preserve Comfy score, exact lyrics, selected model and advanced controls", () => {
  const source = { ...idea(), abc: abc.trim(), temperature: .73, topP: .9, topK: 64, repetitionPenalty: 1.1,
    lora: "", loraClip: "planner.safetensors", loraStrength: .8, loraClipStrength: .3,
    maxDuration: 180, seed: 7, preview: false, model: "int8", arCfg: 3, audioRef: "other.latent" };
  const captured = musicForm(source);
  assert.equal(captured.length, 2);
  for (const ui of captured) {
    const stored = cleanMusicItem(ui);
    assert.equal(stored.lyrics, lyrics); assert.equal(stored.abc, abc);
    assert.equal(stored.engine, "yue2-comfy"); assert.equal(stored.checkpoint, "chosen.safetensors");
    assert.equal(stored.lora, ""); assert.equal(stored.loraClip, source.loraClip);
    assert.equal(stored.temperature, .73); assert.equal(stored.topK, 64);
    for (const omitted of ["seed", "preview", "model", "arCfg", "audioRef"]) assert.equal(Object.hasOwn(stored, omitted), false);
  }
});

test("snapshot supports native GGUF, Python YuE2, ACE and MiniMax without inheriting another engine's controls", () => {
  const native = cleanMusicItem(musicBatchIdea({ ...idea("yue2-gguf"), quantization: "q8_0", cfgScale: 2,
    temperature: .6, topP: .85, planTemperature: .7, planTopP: .8, maxDuration: 240, topK: 64 }));
  assert.equal(native.quantization, "q8_0"); assert.equal(native.planTopP, .8);
  assert.equal(Object.hasOwn(native, "maxDuration"), false); assert.equal(Object.hasOwn(native, "topK"), false);
  const python = cleanMusicItem({ ...idea("yue2"), quantization: "fp8", abc, abcOpen: true,
    coverOf: { file: "song.flac", seconds: 8, stem: "vocals" }, temperature: .9, topK: 64, key: "C", bpm: 120, meter: "4/4" });
  assert.deepEqual(python.coverOf, { file: "song.flac", seconds: 8, stem: "vocals" }); assert.equal(python.abc, abc);
  const aceSource = { engine: "ace-step15", caption: "Dance", lyrics, bpm: 128, keyscale: "C minor", timesignature: "4",
    language: "en", aceSteps: 8, aceCfg: 2.5, aceCodes: false, acePlanTemp: .7, lora: "", loraStrength: 1,
    aceCover: { song: "track.flac" }, seed: 6 };
  const ace = cleanMusicItem(musicBatchIdea(aceSource)); aceSource.aceCover.song = "changed.flac";
  assert.equal(ace.aceCover.song, "track.flac"); assert.equal(ace.aceCodes, false); assert.equal(ace.lora, "");
  const minimax = cleanMusicItem({ engine: "minimax-music3", caption: "Soul", lyrics, model: "fp16", steps: 30,
    arCfg: 1.5, flowCfg: 2.2, maxDuration: 120, audioRef: "take.latent", audioRefDenoise: .4 });
  assert.equal(minimax.lyrics, lyrics); assert.equal(minimax.audioRefDenoise, .4);
});

test("typed snapshots reject unsupported controls, invalid values and unsafe references instead of changing the request", () => {
  for (const raw of [
    { ...idea("yue2-gguf"), maxDuration: 180 }, { ...idea("yue2-gguf"), topK: 20 },
    { ...idea(), cfgScale: 3 }, { ...idea(), abc, planTemperature: .7 },
    { ...idea(), temperature: NaN }, { ...idea(), narSteps: 2 }, { ...idea(), instrumental: "false" },
    { ...idea(), lora: "../other.safetensors" }, { ...idea("yue2"), coverOf: { file: "../track.flac", seconds: 8 } },
    { ...idea("yue2"), narSteps: 24 }, { ...idea("yue2-gguf"), quantization: "fp8" },
    { ...idea("ace-step15"), cot: undefined, narSteps: undefined, aceCover: { upload: "x.wav", song: "x.flac" } },
  ]) assert.throws(() => cleanMusicItem(raw));
  const safe = cleanMusicItem({ ...idea(), actor: "user", batchId: "forged", stages: { video: true }, paidConfirmed: true, seed: 5 });
  for (const field of ["actor", "batchId", "stages", "paidConfirmed", "seed"]) assert.equal(Object.hasOwn(safe, field), false);
});

test("nested Comfy model aliases retain Windows or slash spelling while absolute and traversal paths are refused", () => {
  const item = cleanMusicItem({ ...idea(), checkpoint: "yue2\\model.safetensors", lora: "loras\\mine.safetensors", loraClip: "planner/tune.safetensors" });
  assert.equal(item.checkpoint, "yue2\\model.safetensors"); assert.equal(item.lora, "loras\\mine.safetensors");
  assert.equal(item.loraClip, "planner/tune.safetensors");
  for (const checkpoint of ["C:\\models\\chosen.safetensors", "C:chosen.safetensors", "\\\\server\\chosen.safetensors", "/models/chosen.safetensors", "yue2\\..\\chosen.safetensors", "yue2/../chosen.safetensors", "./chosen.safetensors"]) {
    assert.throws(() => cleanMusicItem({ ...idea(), checkpoint }));
  }
});

test("music MCP schema declares every persisted request field and keeps fresh seeds server-owned", () => {
  const properties = TOOLS.find(t => t.name === "overnight_start").inputSchema.properties.items.items.properties;
  for (const key of new Set(Object.values(MUSIC_BATCH_FIELDS).flat())) assert.ok(properties[key], key);
  assert.equal(properties.seed, undefined); assert.equal(properties.actor, undefined);
  assert.equal(properties.lora.type, "string"); assert.equal(properties.aceCodes.type, "boolean");
});

test("paid-night estimate counts only hosted MiniMax takes reached before the round-robin cap", () => {
  const items = [ { engine: "yue2", caption: "Local", maxDuration: 600 },
    { engine: "minimax-music3", caption: "Hosted", maxDuration: 120 },
    { engine: "ace-step15", caption: "Local ACE", maxDuration: 300 } ];
  assert.deepEqual(plannedPaidSongs({ items, takes: 4, cap: 7 }), { songs: 2, longestSeconds: 120 });
  assert.deepEqual(plannedPaidSongs({ items, takes: 4, cap: 1 }), { songs: 0, longestSeconds: 0 });
  assert.deepEqual(plannedPaidSongs({ items: [{ caption: "Old idea" }], takes: 2, defaultEngine: "yue2-gguf" }), { songs: 0, longestSeconds: 0 });
  assert.deepEqual(plannedPaidSongs({ items: [{ caption: "Old idea" }], takes: 2 }), { songs: 2, longestSeconds: 240 });
  const forty = Array.from({ length: 45 }, () => ({ engine: "minimax-music3", caption: "Style", maxDuration: 999 }));
  assert.deepEqual(plannedPaidSongs({ items: forty, takes: 999, cap: 999 }), { songs: 200, longestSeconds: 300 });
});

test("each take passes its frozen engine and advanced controls to the shared song door with exact text", async t => {
  const { runner, jobs } = await fixture(t);
  const source = { ...idea("yue2-gguf"), quantization: "q8_0", temperature: .75, topP: .88, planTemperature: .6 };
  runner.start({ items: [source], takes: 2, actor: "agent:overnight-test", stages: { cover: false, lrc: true }, paidConfirmed: true });
  source.lyrics = "changed"; source.temperature = 4;
  await tick();
  assert.equal(jobs.submitted.length, 1);
  const first = jobs.submitted[0];
  assert.equal(first.engine, "yue2-gguf"); assert.equal(first.lyrics, lyrics); assert.equal(first.temperature, .75);
  assert.equal(first.quantization, "q8_0"); assert.equal(first.actor, "agent:overnight-test");
  assert.equal(first.paidConfirmed, true); assert.deepEqual(first.stages, { cover: false, lrc: true, stems: false, video: false, enhance: false });
  assert.ok(Number.isInteger(first.seed) && first.seed >= 0 && first.seed < 2 ** 32);
  jobs.finish(first); await tick();
  assert.equal(jobs.submitted.length, 2); assert.equal(jobs.submitted[1].lyrics, lyrics);
  assert.equal(jobs.submitted[1].temperature, .75);
  jobs.finish(jobs.submitted[1]); await tick();
  assert.equal(runner.run.state, "done"); assert.equal(runner.run.done, 2);
  await new Promise(resolve => setTimeout(resolve, 30));
  const saved = JSON.parse(await readFile(path.join(runner.stateFile), "utf8"));
  assert.equal(saved.run.items[0].lyrics, lyrics); assert.equal(saved.run.items[0].engine, "yue2-gguf");
});

test("pause and resume during preparation never enqueue a second take", async t => {
  const waiting = deferred(); let calls = 0;
  const { runner, jobs } = await fixture(t, async (spec, queue) => { calls++; if (calls === 1) await waiting.promise; return queue.enqueue(spec); });
  runner.start({ items: [idea()], takes: 2 }); await tick();
  runner.pause(); runner.resume(); runner.pause();
  assert.equal(calls, 1);
  waiting.resolve(); await tick(); assert.equal(jobs.submitted.length, 1);
  jobs.finish(jobs.submitted[0]); await tick();
  assert.equal(runner.run.done, 1); assert.equal(calls, 1); assert.equal(runner.pendingJobId, null);
  runner.resume(); await tick(); assert.equal(calls, 2);
  jobs.finish(jobs.submitted[1]);
  assert.equal(runner.run.done, 2);
});

test("receipt after Stop is cancelled by ID without disturbing the replacement run", async t => {
  const waiting = deferred(); let calls = 0;
  const { runner, jobs } = await fixture(t, async (spec, queue) => { calls++; if (calls === 1) await waiting.promise; return queue.enqueue(spec); });
  runner.start({ items: [idea()], takes: 2 }); await tick();
  const old = runner.run;
  runner.stop(); runner.start({ items: [{ ...idea(), title: "Replacement" }], takes: 1 });
  assert.equal(calls, 1);
  waiting.resolve(); await tick(); await tick();
  assert.deepEqual(jobs.cancelled, ["job-0"]); assert.equal(old.state, "stopped"); assert.equal(old.done, 0);
  assert.equal(calls, 2); assert.equal(runner.pendingJobId, "job-1");
  jobs.finish(jobs.submitted[1]); assert.equal(runner.run.done, 1); assert.equal(runner.run.state, "done");
});

test("completion before submission resolves is reconciled and a refused take advances without wedging", async t => {
  let calls = 0;
  const { runner } = await fixture(t, async (spec, jobs) => {
    calls++; if (calls === 1) throw Object.assign(new Error("Selected checkpoint is unavailable."), { definitelyNotQueued: true });
    const job = jobs.enqueue(spec); jobs.finish(job); return job;
  });
  runner.start({ items: [idea()], takes: 3 });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(calls, 3); assert.equal(runner.run.state, "done");
  assert.equal(runner.run.failed, 1); assert.equal(runner.run.done, 2);
  assert.equal(runner.pendingMusic, null); assert.equal(runner.pendingJobId, null);
});

test("uncertain submission acknowledgement pauses on the same take without queueing a replacement", async t => {
  let calls = 0;
  const { runner } = await fixture(t, async () => { calls++; throw new Error("Connection closed before the acknowledgement."); });
  runner.start({ items: [idea()], takes: 3 });
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(calls, 1); assert.equal(runner.run.state, "paused");
  assert.equal(runner.run.cursor, 0); assert.equal(runner.run.failed, 0);
  assert.equal(runner.pendingMusic, null); assert.match(runner.run.note, /Check the queue before resuming/);
});

test("archived song stage receipts survive a new run and terminal live/archive copies count only once", async t => {
  const { runner, jobs } = await fixture(t);
  runner.start({ items: [idea()], takes: 1, stages: { cover: false, lrc: true, stems: true } });
  await tick(); jobs.finish(jobs.submitted[0]); await tick();
  const finishedId = runner.run.id;
  assert.deepEqual(runner.outstanding(), { waiting: 2, failed: 0 });
  assert.equal(runner.runs[0].songs[0].file, "job-0.flac");
  assert.equal(runner.wantsStage("job-0.flac", "stems"), true);
  runner.start({ items: [idea()], takes: 1, stages: { cover: false } }); await tick();
  assert.deepEqual(runner.outstanding(), { waiting: 2, failed: 0 });
  assert.equal(runner.noteStage("job-0.flac", "lrc", "done"), true);
  assert.equal(runner.noteStage("job-0.flac", "stems", "failed"), true);
  assert.deepEqual(runner.outstanding(), { waiting: 0, failed: 1 });
  const archived = runner.runs.find(run => run.id === finishedId);
  assert.deepEqual(archived.songs[0].stages, { lrc: "done", stems: "failed" });
});

test("legacy disk plans resume on MiniMax while a new omitted engine captures the current picker", async t => {
  const { runner, jobs } = await fixture(t);
  const legacyItem = { title: "Legacy take", caption: "Soul", lyrics, instrumental: false, maxDuration: 180,
    audioRef: "old.latent", audioRefDenoise: .5 };
  const legacy = { id: "legacy", name: "Old night", items: [legacyItem], takes: 1, cap: 1,
    plan: [{ item: 0, take: 0 }], cursor: 0, done: 0, failed: 0, files: [], stages: { cover: false },
    state: "running", startedAt: Date.now(), actor: "agent:legacy" };
  await writeFile(runner.stateFile, JSON.stringify({ run: legacy, runs: [] }));
  const previous = config.music.engine;
  try {
    config.music.engine = "yue2-gguf";
    await runner.load();
    assert.equal(runner.run.state, "paused"); assert.equal(runner.run.items[0].engine, "minimax-music3");
    assert.equal(JSON.parse(await readFile(runner.stateFile, "utf8")).run.items[0].engine, "minimax-music3");
    runner.resume(); await tick();
    assert.equal(jobs.submitted[0].engine, "minimax-music3"); assert.equal(jobs.submitted[0].audioRef, "old.latent");
    assert.equal(jobs.submitted[0].lyrics, lyrics);
    jobs.finish(jobs.submitted[0]); await tick();
    runner.start({ items: [{ caption: "A new vocal song", lyrics }], takes: 1 }); await tick();
    assert.equal(jobs.submitted[1].engine, "yue2-gguf");
  } finally { config.music.engine = previous; }
});
