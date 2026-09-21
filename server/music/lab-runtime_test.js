import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createListeningLabRuntime, saveTrainingReceipt, completeTrainingReceipt, lookupTrainingReceipt, readTrainingReceipt } from "./lab-runtime.js";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const nodeInfo = () => Object.fromEntries(["CheckpointLoaderSimple", "LoraLoaderModelOnly", "YuE2GenerateABC", "YuE2GenerateMusic", "ConditioningZeroOut", "EmptyYuE2LatentAudio", "KSampler", "VAEDecodeAudio", "SaveAudio"].map(name => [name, {}]));
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "music-lab-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputDir = path.join(directory, "output"), appData = path.join(directory, "data"), models = path.join(directory, "models");
  for (const dir of [outputDir, appData, path.join(models, "checkpoints"), path.join(models, "loras")]) await mkdir(dir, { recursive: true });
  const files = [];
  for (const [folder, name] of [["checkpoints", "base.safetensors"], ["checkpoints", "bare.safetensors"], ["loras", "mine_audio.safetensors"], ["loras", "planner.safetensors"], ["loras", "other.safetensors"]]) {
    const full = path.join(models, folder, name); await writeFile(full, name); files.push({ folder, name, full, bytes: name.length });
  }
  await writeFile(path.join(outputDir, "source.wav"), "source recording");
  const library = { meta: new Map([["source.wav", { title: "My recording", durationSeconds: 999 }]]) };
  let hashCalls = 0, measureCalls = 0, probeCalls = 0, objectCalls = 0;
  const info = nodeInfo(), engine = { status: async () => ({ ready: true }), objectInfo: async () => { objectCalls++; return info; } };
  const config = { outputDir, paths: { appData }, output: { format: "flac" } };
  const options = { config, library, shelf: async () => files, engine,
    hashFile: async file => { hashCalls++; return sha(await readFile(file)); },
    measure: async () => { measureCalls++; return 12.5; },
    probe: async file => { probeCalls++; const name = path.basename(file);
      if (name === "base.safetensors") return { family: "yue2", companions: { vae: true, te: true } };
      if (name === "bare.safetensors") return { family: "yue2", companions: { vae: false, te: false } };
      if (name === "mine_audio.safetensors") return { family: "lora", variant: "YuE2", confidence: "certain", companions: { te: false } };
      if (name === "planner.safetensors") return { family: "lora", variant: "YuE2", confidence: "certain", companions: { te: true }, metadata: { yue2_lora_branch: "ar" } };
      return { family: "lora", variant: "FLUX", confidence: "certain" };
    }, ...overrides };
  return { runtime: createListeningLabRuntime(options), options, directory, files, outputDir, appData, library, engine, info,
    counts: () => ({ hashCalls, measureCalls, probeCalls, objectCalls }) };
}

test("capabilities exclude bare checkpoints, planner and unrelated adapters; hash only selected files", async t => {
  const f = await fixture(t), listed = await f.runtime.capabilities();
  assert.equal(listed.ready, true); assert.equal(f.counts().hashCalls, 0);
  assert.deepEqual(listed.checkpoints.map(x => x.name), ["base.safetensors"]);
  assert.deepEqual(listed.adapters.map(x => x.name), ["mine_audio.safetensors"]);
  assert.equal(listed.adapters[0].identity, undefined);
  const selection = { checkpoint: "base.safetensors", adapter: "mine_audio.safetensors" };
  const first = await f.runtime.capabilities(selection);
  assert.equal(first.adapters[0].identity, `sha256:${sha("mine_audio.safetensors")}`);
  assert.equal(first.adapters[0].training, null); assert.equal(f.counts().hashCalls, 2);
  await f.runtime.capabilities(selection); assert.equal(f.counts().hashCalls, 2);
  assert.ok(!JSON.stringify(first).includes(f.directory), "private shelf paths are not published");
  await writeFile(f.files.find(x => x.name === selection.adapter).full, "changed adapter");
  const updated = await f.runtime.capabilities(selection);
  assert.notEqual(updated.adapters[0].identity, first.adapters[0].identity); assert.equal(f.counts().hashCalls, 3);
});

test("offline engine, missing nodes and runtime-invisible choices are distinct readiness failures", async t => {
  const f = await fixture(t);
  f.engine.status = async () => ({ ready: false });
  let cap = await f.runtime.capabilities(); assert.match(cap.reason, /Start the local engine/); assert.equal(f.counts().objectCalls, 0);
  f.engine.status = async () => ({ ready: true }); delete f.info.YuE2GenerateMusic;
  cap = await f.runtime.capabilities(); assert.match(cap.reason, /YuE2GenerateMusic/);
  f.info.YuE2GenerateMusic = {}; f.info.LoraLoaderModelOnly = { input: { required: { lora_name: [[]] } } };
  cap = await f.runtime.capabilities({ adapter: "mine_audio.safetensors" }); assert.equal(cap.ready, false); assert.equal(cap.adapters.length, 0);
  assert.equal(f.counts().hashCalls, 0);
});

test("duplicate shelf filenames are refused rather than fingerprinting the wrong model", async t => {
  const f = await fixture(t), other = path.join(f.directory, "elsewhere"); await mkdir(other);
  const full = path.join(other, "mine_audio.safetensors"); await writeFile(full, "different weights");
  f.files.push({ folder: "loras", name: "mine_audio.safetensors", full });
  const cap = await f.runtime.capabilities({ adapter: "mine_audio.safetensors", checkpoint: "base.safetensors" });
  assert.equal(cap.ready, false); assert.equal(cap.adapters.length, 0); assert.match(cap.issues.join(" "), /More than one/);
});

test("a selected model changed during hashing cannot receive a verified identity", async t => {
  const f = await fixture(t), runtime = createListeningLabRuntime({ ...f.options,
    hashFile: async file => { await writeFile(file, "changed during hashing"); return sha(await readFile(file)); } });
  const cap = await runtime.capabilities({ checkpoint: "base.safetensors", adapter: "mine_audio.safetensors" });
  assert.equal(cap.ready, false); assert.match(cap.reason, /changed|fingerprinted/);
  assert.equal(cap.checkpoints[0].identity, undefined); assert.equal(cap.adapters[0].identity, undefined);
});

test("source identity uses measured duration, caches stable files and invalidates changed recordings", async t => {
  const f = await fixture(t); const first = await f.runtime.inspectSource("source.wav");
  assert.equal(first.seconds, 12.5); assert.equal(first.title, "My recording"); assert.equal(first.sha256, sha("source recording"));
  await f.runtime.inspectSource("source.wav"); assert.equal(f.counts().measureCalls, 1);
  await writeFile(path.join(f.outputDir, "source.wav"), "edited recording");
  const second = await f.runtime.inspectSource("source.wav");
  assert.notEqual(second.sha256, first.sha256); assert.equal(f.counts().measureCalls, 2);
  for (const name of ["../source.wav", "C:source.wav", "source.wav:stream", "https://x/source.wav", "missing.wav"]) await assert.rejects(f.runtime.inspectSource(name));
  await writeFile(path.join(f.outputDir, "unlisted.wav"), "bytes"); await assert.rejects(f.runtime.inspectSource("unlisted.wav"), /song library/);
});

test("a recording changed during probing is refused and its incomplete cache is discarded", async t => {
  const f = await fixture(t); let alter = true;
  const runtime = createListeningLabRuntime({ ...f.options, measure: async file => { if (alter) { alter = false; await writeFile(file, "changed during inspection"); } return 8; } });
  await assert.rejects(runtime.inspectSource("source.wav"), /changed while/);
  assert.equal((await runtime.inspectSource("source.wav")).sha256, sha("changed during inspection"));
});

test("filesystem links cannot escape the library", async t => {
  const f = await fixture(t), outside = path.join(f.directory, "outside"); await mkdir(outside);
  await writeFile(path.join(outside, "private.wav"), "private bytes");
  // Directory junctions exercise realpath confinement without requiring the
  // Windows privilege needed to create file symlinks.
  const link = path.join(f.outputDir, "link.wav"); await symlink(outside, link, "junction");
  f.library.meta.set("link.wav", { title: "Link" });
  await assert.rejects(f.runtime.inspectSource("link.wav"), /inside the song library/);
  assert.equal(f.counts().hashCalls, 0);
});

test("actual ffprobe measures a WAV without trusting stale library duration", async t => {
  const f = await fixture(t), samples = 8000, wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40); await writeFile(path.join(f.outputDir, "source.wav"), wav);
  const options = { ...f.options }; delete options.measure; delete options.hashFile;
  const result = await createListeningLabRuntime(options).inspectSource("source.wav");
  assert.equal(result.seconds, 1); assert.equal(result.sha256, sha(wav));
});

const receipt = () => ({ runId: "run1", name: "mine_audio", outputPrefix: "mine_audio_unique1", source: { file: "source.wav", sha256: sha("source recording"), startSeconds: 1, seconds: 8 },
  settings: { steps: 50, rank: 4, learningRate: .0002, seed: 0 }, checkpoint: "base.safetensors", conditioning: "source-audio-encode-only" });

test("only completed adapter-hash-matching training receipts supply verified source history", async t => {
  const f = await fixture(t), name = "mine_audio.safetensors", full = f.files.find(x => x.name === name).full;
  const identity = `sha256:${sha(name)}`;
  await saveTrainingReceipt(f.appData, receipt());
  assert.equal((await readTrainingReceipt(f.appData, "run1")).outputPrefix, "mine_audio_unique1");
  assert.equal(await lookupTrainingReceipt(f.appData, { name, identity }), null);
  await completeTrainingReceipt(f.appData, { runId: "run1", name, adapterFullPath: full });
  const evidence = await lookupTrainingReceipt(f.appData, { name, identity });
  assert.equal(evidence.sourceSha256, receipt().source.sha256); assert.equal(evidence.startSeconds, 1); assert.equal(evidence.conditioning, receipt().conditioning);
  assert.equal(await lookupTrainingReceipt(f.appData, { name, identity: `sha256:${sha("other")}` }), null);
  const cap = await f.runtime.capabilities({ adapter: name, checkpoint: "base.safetensors" }); assert.equal(cap.adapters[0].training.runId, "run1");
  await writeFile(full, "overwritten adapter");
  await assert.rejects(completeTrainingReceipt(f.appData, { runId: "run1", name, adapterFullPath: full }), /original receipt was kept/);
  const refreshed = await f.runtime.capabilities({ adapter: name, checkpoint: "base.safetensors" }); assert.equal(refreshed.adapters[0].training, null);
});

test("training receipts reject fabricated conditioning, conflicting source history and concurrent replacement", async t => {
  const f = await fixture(t), input = receipt();
  await assert.rejects(saveTrainingReceipt(f.appData, { ...input, conditioning: "source-plus-generated-tail" }), /encode-only/);
  await assert.rejects(saveTrainingReceipt(f.appData, { ...input, runId: "../escape" }), /identifier/);
  await saveTrainingReceipt(f.appData, input); await saveTrainingReceipt(f.appData, input);
  await assert.rejects(saveTrainingReceipt(f.appData, { ...input, source: { ...input.source, startSeconds: 2 } }), /different source/);
  const first = f.files.find(x => x.name === "mine_audio.safetensors");
  const otherShelf = path.join(f.directory, "another-models", "loras"); await mkdir(otherShelf, { recursive: true });
  const second = { name: first.name, full: path.join(otherShelf, first.name) }; await writeFile(second.full, "different adapter with same name");
  const results = await Promise.allSettled([first, second].map(file => completeTrainingReceipt(f.appData, { runId: "run1", name: file.name, adapterFullPath: file.full })));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(results.filter(r => r.status === "rejected").length, 1);
  assert.equal((await readTrainingReceipt(f.appData, "run1")).adapter.name, first.name);
});
