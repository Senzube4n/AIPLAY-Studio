import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createMusicInputService } from "../server/music-input.js";
import { musicInputTools } from "../server/mcp-music-input.js";
import { buildGraph } from "../server/workflow.js";

const temp = await mkdtemp(path.join(os.tmpdir(), "aiplay-music-input-test-"));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const tick = () => new Promise((r) => setImmediate(r));
try {
  const runtimeFile = path.join(temp, "runtime.json");
  const dependency = path.join(temp, "installed.fixture");
  await writeFile(dependency, "recorded test dependency");
  await writeFile(runtimeFile, JSON.stringify({ python: dependency, adapter: dependency,
    rvq_config: dependency, rvq_weights: dependency, dav_weights: dependency,
    encoder_repo: "recorded-fixture", encoder_revision: "test-revision" }));
  const wave = Buffer.alloc(64); wave.write("RIFF"); wave.write("WAVE", 8);
  const input = path.join(temp, "source.wav"); await writeFile(input, wave);
  const cfg = { enabled: false, runtimeFile };
  let pythonCalls = 0, encodeCalls = 0, hold = false, started;
  const renders = new Map(), cancelled = [], submitted = [];
  const options = {
    directory: path.join(temp, "jobs"), libraryDirectory: temp, settings: () => cfg,
    localMode: () => true, resumeSupported: async () => true,
    runPython: async (_python, args, { signal } = {}) => {
      pythonCalls++;
      if (args.includes("--probe")) return { ok: true, missing: [], device: "cpu" };
      encodeCalls++; started?.();
      if (hold) await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled fixture")), { once: true });
      });
      const output = args[args.indexOf("--output")+1], source = args[args.indexOf("--source")+1];
      const codes = Buffer.from("recorded-eight-codebook-result");
      await writeFile(output, codes);
      return { ok: true, frames: 187, codebooks: 8, prefix_seconds: 7.48,
        selected_seconds: 7.5, device: "cpu", source_sha256: sha(await readFile(source)),
        output_sha256: sha(codes), encoder: "recorded-fixture", revision: "test-revision",
        dependency_sha256: { adapter: sha(Buffer.from("fixture")) } };
    },
    enqueue: (spec) => { submitted.push(spec); const job = { id: `render-${submitted.length}`, state: "queued", stage: null, ...spec }; renders.set(job.id, job); return job; },
    getRenderJob: (id) => renders.get(id),
    cancelRenderJob: async (id) => { cancelled.push(id); renders.get(id).state = "cancelled"; },
  };
  const service = createMusicInputService(options);
  const disabled = await service.capabilities();
  assert.equal(disabled.available, false); assert.equal(pythonCalls, 0);
  assert.equal(disabled.modes.inpainting.available, false);
  assert.equal(disabled.modes.latent_refinement.status, "research_only");
  await assert.rejects(service.prepare({ source: { path: input } }, "agent:test"), /not enabled/);
  cfg.enabled = true;
  assert.equal((await service.capabilities()).available, true);
  await assert.rejects(service.prepare({ source: { path: input }, mode: "inpainting" }, "agent:test"), /research-only/);
  await assert.rejects(service.prepare({ source: { path: input }, duration_seconds: 16 }, "agent:test"), /duration_seconds/);
  await assert.rejects(service.prepare({ source: { path: input, library_file: "source.wav" } }, "agent:test"), /exactly one/);
  await assert.rejects(service.prepare({ source: { library_file: "../source.wav" } }, "agent:test"), /Invalid library/);
  await assert.rejects(service.prepare({ source: { data_url: "data:audio/wav;base64,eA==", name: "bad.wav" } }, "agent:test"), /contents/);
  const p = await service.prepare({ source: { path: input }, duration_seconds: 7.5 }, "agent:test");
  assert.equal(p.job.state, "queued");
  let ready;
  for (let i = 0; i < 100; i++) { ready = (await service.status(p.job.id)).job; if (ready.state === "ready") break; await tick(); }
  assert.equal(ready.state, "ready"); assert.equal(ready.encoding.prefix_seconds, 7.48);
  assert.equal(ready.source.sha256, sha(wave));
  const result = await service.continue({ reference_id: ready.reference_id, caption: "Instrumental test", seed: 21, mix_seed: 22, seconds: 7.5 }, "agent:test");
  assert.equal(result.job.id, "render-1");
  assert.equal(submitted[0].actor, "agent:test"); assert.equal(submitted[0].musicInput.experimental, true);
  assert.equal(submitted[0].musicInput.output, "new_segment_only");
  assert.equal(submitted[0].requiresLocal, true);
  assert.equal(submitted[0].audioRef, undefined); assert.equal(submitted[0].extendedFrom, undefined);
  const graph = buildGraph(submitted[0]);
  assert.equal(graph[4].inputs.resume_from, submitted[0].resumeFrom);
  assert.equal(graph[4].inputs.max_duration, 7.5); assert.equal(graph[7].inputs.noise_seed, 22);
  assert.equal(graph[6].class_type, "EmptyMiniMaxMusic3LatentAudio");
  renders.get("render-1").state = "done"; renders.get("render-1").file = "aiplay_test.flac";
  const done = (await service.status("render-1")).job;
  assert.equal(done.file, "aiplay_test.flac"); assert.equal(done.url, "/api/audio/aiplay_test.flac");
  assert.equal(done.path, path.join(temp, "aiplay_test.flac"));
  assert.ok((await service.list()).some((j) => j.reference_id === ready.reference_id && j.state === "ready"));
  const restored = createMusicInputService(options);
  assert.equal((await restored.status(ready.reference_id)).job.state, "ready");
  assert.equal((await restored.status("render-1")).job.file, "aiplay_test.flac");
  const second = await service.continue({ reference_id: ready.reference_id, caption: "Second", seed: 0 }, "agent:test");
  await service.cancel(second.job.id); assert.deepEqual(cancelled, ["render-2"]);
  assert.equal(renders.get("render-1").state, "done");
  hold = true;
  let resolveStarted; const hasStarted = new Promise((r) => { resolveStarted = r; }); started = resolveStarted;
  const active = await service.prepare({ source: { library_file: "source.wav" } }, "user");
  await hasStarted;
  const queued = await service.prepare({ source: { data_url: `data:audio/wav;base64,${wave.toString("base64")}`, name: "upload.wav" } }, "user");
  const encodesBeforeCancel = encodeCalls;
  assert.equal((await service.cancel(queued.job.id)).job.state, "cancelled");
  assert.equal((await service.cancel(active.job.id)).job.state, "cancelled");
  await tick(); await tick(); assert.equal(encodeCalls, encodesBeforeCancel);
  assert.deepEqual(cancelled, ["render-2"], "Preparation cancellation never calls the generation canceller");
  const concurrent = createMusicInputService({ ...options, directory: path.join(temp, "concurrent") });
  const admissions = await Promise.allSettled(Array.from({ length: 8 }, () => concurrent.prepare({ source: { path: input } }, "agent:test")));
  assert.equal(admissions.filter((r) => r.status === "fulfilled").length, 4);
  assert.ok(admissions.filter((r) => r.status === "rejected").every((r) => r.reason.status === 429));
  for (const admission of admissions.filter((r) => r.status === "fulfilled")) await concurrent.cancel(admission.value.job.id);
  await tick(); await tick();
  await assert.rejects(service.cancel("unknown"), /Unknown/);
  await writeFile(submitted[0].resumeFrom, "tampered");
  await assert.rejects(service.continue({ reference_id: ready.reference_id, caption: "Again" }, "user"), /changed/);
  const calls = [];
  const tools = musicInputTools(async (...args) => { calls.push(args); return {}; });
  assert.equal(tools.length, 5);
  for (const t of tools) await t.run({ job_id: "one", reference_id: "ref", caption: "test", source: { path: input } });
  assert.ok(calls.every((c) => c[1] === "/api/music-input"));
  assert.deepEqual(calls.map((c) => c[2]?.action), [undefined, "prepare", "status", "continue", "cancel"]);
  console.log("Music-input service checks passed: disabled setup, validation, real graph wiring, persisted ready references, output filenames, isolated cancellation and MCP parity (recorded encoder stub; no model generation).");
} finally {
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(temp, { recursive: true, force: true });
}
