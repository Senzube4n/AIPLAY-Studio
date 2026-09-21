import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createMusicArtifacts } from "./artifacts.js";
import { REPLAY_RUNTIME, inspectReplaySource, verifyReplayManifest } from "./yue-artifacts.js";
import { musicArtifactTools } from "../mcp-music-artifacts.js";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function fixture(t, changes = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiplay-replay-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const sourceDir = path.join(dir, "source"); await mkdir(sourceDir);
  const request = { style: "folk", lyrics: "whole words", cot: "full", seed: 77, abc: null, cfg_scale: null, id: "source" };
  const config = { runtime_sha256: REPLAY_RUNTIME.sha256, generation: { version: "yue2-native-v1", context: 24576, ode_method: "midpoint", ode_steps: 32, semantic: { max_tokens: 9000 } } };
  const weights = { mot: { files: { "model.safetensors": { sha256: hash("mot"), bytes: 3 } }, config_sha256: hash("motconfig") },
    vae: { files: { "model.safetensors": { sha256: hash("vae"), bytes: 3 } }, config_sha256: hash("vaeconfig") } };
  const bodies = { "audio.flac": "audio", "semantic.npy": "synthetic fixture tokens", "latent.npy": "synthetic fixture latents", "abc_tokens.npy": "abcids", "prefix.npy": "prefix",
    "request.json": JSON.stringify(request), "config.json": JSON.stringify(config), "plan.json": JSON.stringify({ request, abc: null }) };
  bodies["plan_manifest.json"] = JSON.stringify(Object.fromEntries(["plan.json", "abc_tokens.npy", "prefix.npy"].map(n => [n, hash(bodies[n])])));
  for (const [name, body] of Object.entries(bodies)) await writeFile(path.join(sourceDir, name), body);
  const receipt = { status: "complete", identity: hash("source identity"), sample_rate: 48000, audio_seconds: 30, weights, truncated: { abc: false, semantic: false },
    artifacts: Object.fromEntries(Object.entries(bodies).map(([name, body]) => [name, { sha256: hash(body), bytes: Buffer.byteLength(body) }])) };
  await writeFile(path.join(sourceDir, "result.json"), JSON.stringify(receipt));
  const queue = [], jobs = new Map(), cancelled = [], records = [];
  const deps = { appData: dir, resolveSource: async file => ({ file, dir: sourceDir, engine: "yue2", runId: "source-run", sourceHash: hash("library") }),
    runtimeInfo: async () => REPLAY_RUNTIME, modelIdentities: async () => weights,
    submitReplay: async ({ spec, actor }) => { const job = { id: `job${queue.length + 1}`, state: "queued", ...spec, actor }; queue.push(job); jobs.set(job.id, job); return { id: job.id, state: job.state }; },
    readJob: async id => jobs.get(id), cancelJob: async id => { cancelled.push(id); jobs.get(id).state = "cancelled"; return { state: "cancelled" }; },
    record: async (entry, actor) => records.push({ entry, actor }), ...changes };
  return { dir, sourceDir, request, weights, queue, jobs, cancelled, records, deps, store: createMusicArtifacts(deps) };
}
test("inspect verifies saved hashes/runtime/weights and never queues", async t => {
  const f = await fixture(t); const got = await f.store.inspect("song.flac");
  assert.equal(got.audioSeconds, 30); assert.deepEqual(got.stages.latent.run, ["decode"]); assert.equal(f.queue.length, 0);
  await writeFile(path.join(f.sourceDir, "semantic.npy"), "changed");
  await assert.rejects(f.store.inspect("song.flac"), /artifact changed/); assert.equal(f.queue.length, 0);
});
test("model identity and runtime mismatches refuse preparation", async t => {
  const f = await fixture(t);
  await assert.rejects(inspectReplaySource(f.sourceDir, { runtime: { ...REPLAY_RUNTIME, version: "0.1.7" }, weights: f.weights }), /runtime/);
  await assert.rejects(inspectReplaySource(f.sourceDir, { runtime: REPLAY_RUNTIME, weights: { different: true } }), /identities/);
});
test("prepare freezes controls and source; render queues once with the exact receipt", async t => {
  const f = await fixture(t); const p = await f.store.prepare({ source: "song.flac", stage: "semantic", seed: 88, narSteps: 16 }, "agent:test");
  assert.equal(f.queue.length, 0); assert.equal(p.prepared.options.seed, 88); assert.equal(f.records[0].actor, "agent:test");
  const results = await Promise.all([f.store.render(p.prepared.id, "agent:test"), f.store.render(p.prepared.id, "agent:test")]);
  assert.equal(f.queue.length, 1); assert.equal(results[0].job.id, results[1].job.id);
  const spec = f.queue[0]; assert.equal(spec.caption, "folk"); assert.equal(spec.narSteps, 16); assert.equal(spec.artifactReplay.stage, "semantic");
  assert.equal(spec.quantization, "none"); assert.equal(spec.artifactSourceRunId, "source-run");
  const verified = await verifyReplayManifest(spec.artifactReplay, { runtime: REPLAY_RUNTIME, weights: f.weights }); assert.equal(verified.options.seed, 88);
});
test("latent replay refuses meaningless seed/solver controls and prompt editing", async t => {
  const f = await fixture(t);
  for (const extra of [{ seed: 77 }, { narSteps: 16 }, { style: "new style" }, { decoder: "arbitrary" }])
    await assert.rejects(f.store.prepare({ source: "song.flac", stage: "latent", ...extra }));
  const p = await f.store.prepare({ source: "song.flac", stage: "latent" }); assert.equal(p.prepared.options.seed, 77); assert.equal(f.queue.length, 0);
});
test("source changed between preparation and render cannot spend a job", async t => {
  const f = await fixture(t); const p = await f.store.prepare({ source: "song.flac", stage: "plan" });
  await writeFile(path.join(f.sourceDir, "latent.npy"), "corrupt");
  await assert.rejects(f.store.render(p.prepared.id), /changed/); assert.equal(f.queue.length, 0);
});
test("prepared manifest tampering is caught before queueing", async t => {
  const f = await fixture(t); const p = await f.store.prepare({ source: "song.flac", stage: "latent" });
  const file = path.join(f.dir, "music-artifacts", p.prepared.id, "manifest.json");
  const body = JSON.parse(await readFile(file)); body.options.seed = 999; await writeFile(file, JSON.stringify(body));
  await assert.rejects(f.store.render(p.prepared.id), /manifest changed/); assert.equal(f.queue.length, 0);
});
test("restart retains exact id and completion; status never resubmits missing history", async t => {
  const f = await fixture(t); const p = await f.store.prepare({ source: "song.flac", stage: "latent" }); await f.store.render(p.prepared.id);
  const restarted = createMusicArtifacts(f.deps); f.jobs.get("job1").state = "done"; f.jobs.get("job1").file = "new.flac";
  assert.equal((await restarted.status(p.prepared.id)).prepared.job.file, "new.flac");
  f.jobs.clear(); assert.equal((await restarted.status(p.prepared.id)).prepared.jobId, "job1"); assert.equal(f.queue.length, 1);
});
test("cancel targets only the prepared exact job; refusal keeps it live", async t => {
  const f = await fixture(t); const p = await f.store.prepare({ source: "song.flac", stage: "latent" }); await f.store.render(p.prepared.id);
  assert.equal((await f.store.cancel(p.prepared.id)).prepared.state, "cancelled"); assert.deepEqual(f.cancelled, ["job1"]);
  const g = await fixture(t, { cancelJob: async () => { throw new Error("busy"); } });
  const q = await g.store.prepare({ source: "song.flac", stage: "latent" }); await g.store.render(q.prepared.id);
  const out = await g.store.cancel(q.prepared.id); assert.equal(out.prepared.state, "queued"); assert.match(out.prepared.cancelError, /still be running/);
});
test("MCP fields are explicit and render remains separate from preparation", async () => {
  const calls = []; const tools = musicArtifactTools(async (...args) => { calls.push(args); return {}; });
  for (const tool of tools) for (const name of Object.keys(tool.inputSchema.properties)) assert.ok(String(tool.run).includes(name));
  await tools.find(t => t.name === "music_artifact_prepare").run({ source: "song.flac", stage: "semantic", seed: 9, nar_steps: 16, vae_core_frames: 256 });
  assert.deepEqual(calls[0][2], { action: "prepare", source: "song.flac", stage: "semantic", seed: 9, narSteps: 16, vaeCoreFrames: 256 });
  await tools.find(t => t.name === "music_artifact_render").run({ prepared_id: "replay_a" }); assert.equal(calls[1][2].action, "render");
});
