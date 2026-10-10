import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { compareArchivedTrainingPair } from "./train-archive.js";
import { compareTrainingTakes } from "./train.js";
import { buildYue2ComfyGraph } from "../workflow.js";
import { sha256, sortedJSON } from "../engine/record.js";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "yue-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appData = path.join(root, "app"), outputDir = path.join(root, "audio");
  await mkdir(path.join(appData, "music-listening-lab"), { recursive: true });
  await mkdir(outputDir);
  const before = "base.flac", after = "adapter.flac";
  const bytes = [Buffer.from("finished baseline audio"), Buffer.from("finished adapter audio")];
  await Promise.all([before, after].map((name, i) => writeFile(path.join(outputDir, name), bytes[i])));
  const request = { engine: "yue2-comfy", checkpoint: "yue2.safetensors", caption: "piano song",
    lyrics: "One new line", seed: 123, mixSeed: 123, maxDuration: 30, narSteps: 16,
    cot: "melody", instrumental: false, loraClip: "", loraClipStrength: 0 };
  const lab = { v: 1, id: `lab-${"a".repeat(24)}`, checkpoint: { name: request.checkpoint },
    adapter: { name: "mine_song.safetensors" }, strength: .8,
    takes: [
      { file: before, role: "base", caseId: "case1", state: "ready", cached: false,
        runId: "run-base", sha256: hash(bytes[0]), request: { ...request, lora: "", loraStrength: 0, title: "A" } },
      { file: after, role: "adapter", caseId: "case1", state: "ready", cached: false,
        runId: "run-adapter", sha256: hash(bytes[1]), request: { ...request, lora: "mine_song.safetensors", loraStrength: .8, title: "B" } },
    ] };
  const graphs = [buildYue2ComfyGraph({ caption: request.caption, lyrics: request.lyrics, seed: request.seed,
    mixSeed: request.mixSeed, cot: request.cot, maxDuration: request.maxDuration,
    steps: request.narSteps, checkpoint: request.checkpoint }),
  buildYue2ComfyGraph({ caption: request.caption, lyrics: request.lyrics, seed: request.seed,
    mixSeed: request.mixSeed, cot: request.cot, maxDuration: request.maxDuration,
    steps: request.narSteps, checkpoint: request.checkpoint, lora: lab.adapter.name, loraStrength: lab.strength })];
  const runs = lab.takes.map((take, i) => {
    const graphHash = sha256(sortedJSON(graphs[i]));
    return { runId: take.runId, graph: graphs[i],
      request: { runId: take.runId, via: "jobs.music", graphHash },
      result: { runId: take.runId, via: "jobs.music", status: "completed", cached: false,
        graphHash, outputs: [{ kind: "audio", file: take.file }] } };
  });
  const songEvent = (take, i) => ({ type: "generate", asset: take.file,
    data: { runId: take.runId, seed: request.seed, mixSeed: request.mixSeed,
      params: { runtime: "comfy", checkpoint: request.checkpoint,
        lora: i ? lab.adapter.name : null, loraStrength: i ? lab.strength : null } } });
  const events = [
    { type: "delegate", asset: "engine/run-base", data: runs[0].request }, songEvent(lab.takes[0], 0),
    { type: "delegate", asset: "engine/run-adapter", data: runs[1].request },
    { type: "generate", asset: "engine/run-base", data: runs[0].result },
    songEvent(lab.takes[1], 1), { type: "generate", asset: "engine/run-adapter", data: runs[1].result },
  ];
  const baseline = { file: before, engine: "yue2-comfy", lora: null };
  const adapterTake = { file: after, engine: "yue2-comfy", lora: lab.adapter.name, loraStrength: lab.strength };
  const prior = compareTrainingTakes(baseline, adapterTake);
  const writeLab = () => writeFile(path.join(appData, "music-listening-lab", `${lab.id}.json`), JSON.stringify(lab));
  const writeLedger = async () => {
    await mkdir(path.join(appData, "provenance"), { recursive: true });
    const lines = [];
    for (const event of events) {
      event.prev = lines.length ? sha256(lines.at(-1)) : "genesis";
      lines.push(JSON.stringify(event));
    }
    await writeFile(path.join(appData, "provenance", "library.jsonl"), lines.join("\n") + "\n");
  };
  await writeLab(); await writeLedger();
  const call = ({ ledger = { ok: true }, record = async id => runs.find(run => run.runId === id) } = {}) => compareArchivedTrainingPair({ appData, outputDir, before, after, baseline, adapterTake, prior,
    runRecord: record,
    readProvenance: async () => ({ events, corrupt: 0 }),
    verifyProvenance: async () => ledger });
  return { root, appData, outputDir, before, after, baseline, adapterTake, prior,
    lab, graphs, runs, events, writeLab, writeLedger, call };
}

test("archived lab can prove a legacy pair matched by actual graph and audio fingerprints", async t => {
  const f = await fixture(t);
  assert.equal(f.prior.status, "unverified");
  const result = await f.call();
  assert.equal(result.status, "matched");
  assert.equal(result.evidence.source, "archived-local-graphs");
  assert.ok(result.checks.every(check => check.status === "match"));
  assert.match(result.message, /unsigned/);
  assert.match(result.message, /do not prove improvement/);
});

test("a changed file, graph, run receipt or chain cannot certify old metadata", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.outputDir, f.after), "changed recording");
  assert.equal(await f.call(), null);
  await writeFile(path.join(f.outputDir, f.after), "finished adapter audio");
  f.graphs[1]["7"].inputs.cfg = 1.2;
  assert.equal(await f.call(), null);
  f.graphs[1]["7"].inputs.cfg = 1;
  f.runs[1].result.status = "failed";
  assert.equal(await f.call(), null);
  f.runs[1].result.status = "completed";
  f.runs[1].result.graphHash = "sha256:" + "0".repeat(64);
  assert.equal(await f.call(), null);
  f.runs[1].result.graphHash = f.runs[1].request.graphHash;
  f.events[3].prev = "sha256:" + "f".repeat(64);
  const invalidChain = await f.call({ ledger: { ok: false } });
  assert.equal(invalidChain, null);
});

test("a broken incoming link leaves the saved pair unverified while reporting graph equality", async t => {
  const f = await fixture(t);
  const existing = await (await import("node:fs/promises")).readFile(
    path.join(f.appData, "provenance", "library.jsonl"), "utf8");
  const earlier = JSON.stringify({ type: "edit", asset: "earlier", prev: "genesis" });
  await writeFile(path.join(f.appData, "provenance", "library.jsonl"), earlier + "\n" + existing);
  f.events.unshift(JSON.parse(earlier));
  const result = await f.call({ ledger: { ok: false, brokenAt: 1 } });
  assert.equal(result.status, "unverified");
  assert.equal(result.settingsMatch, true);
  assert.ok(result.checks.some(check => check.status === "unknown"));
  assert.match(result.message, /link into this pair is broken/);
});

test("a broken link elsewhere in the ledger cannot certify an archived pair", async t => {
  const f = await fixture(t);
  const result = await f.call({ ledger: { ok: false, brokenAt: 999 } });
  assert.equal(result.status, "unverified");
  assert.equal(result.settingsMatch, true);
  assert.match(result.message, /gap elsewhere/);
});

test("forged lab linkage, cached take and a known library mismatch remain unverified", async t => {
  const f = await fixture(t);
  f.lab.takes[1].cached = true; await f.writeLab();
  assert.equal(await f.call(), null);
  f.lab.takes[1].cached = false;
  f.lab.takes[1].request.seed = 999; await f.writeLab();
  assert.equal(await f.call(), null);
  f.lab.takes[1].request.seed = 123; await f.writeLab();
  f.runs[0].request.graphHash = "../../private";
  let graphReads = 0;
  const unsafe = await f.call({ record: async (id, options) => {
    if (options?.graph) graphReads++;
    return f.runs.find(run => run.runId === id);
  } });
  assert.equal(unsafe, null);
  assert.equal(graphReads, 0);
  f.runs[0].request.graphHash = sha256(sortedJSON(f.graphs[0]));
  f.lab.takes[0].runId = "../private"; await f.writeLab();
  let runReads = 0;
  assert.equal(await f.call({ record: async () => { runReads++; return null; } }), null);
  assert.equal(runReads, 0);
  f.lab.takes[0].runId = "run-base"; await f.writeLab();
  assert.equal(await compareArchivedTrainingPair({ appData: f.appData, outputDir: f.outputDir,
    before: f.before, after: f.after, baseline: f.baseline,
    adapterTake: { ...f.adapterTake, lora: "different.safetensors" }, prior: f.prior,
    runRecord: async id => f.runs.find(run => run.runId === id),
    readProvenance: async () => ({ events: f.events, corrupt: 0 }),
    verifyProvenance: async () => ({ ok: true }) }), null);
  const knownMismatch = compareTrainingTakes({ ...f.baseline, lora: "wrong.safetensors" }, f.adapterTake);
  assert.equal(knownMismatch.status, "mismatch");
  assert.equal(await compareArchivedTrainingPair({ appData: f.appData, outputDir: f.outputDir,
    before: f.before, after: f.after, baseline: f.baseline, adapterTake: f.adapterTake, prior: knownMismatch }), null);
});
