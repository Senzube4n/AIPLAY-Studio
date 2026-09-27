import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compareTrainingTakes } from "./train.js";
import { buildYue2ComfyGraph, yue2ComfySamplingReceipt } from "../workflow.js";

const baseline = () => ({
  file: "aiplay_baseline.flac", comparisonVersion: 1,
  engine: "yue2-comfy", checkpoint: "yue2_3b.safetensors",
  caption: "warm piano ballad", lyrics: "[Verse]\nA clear line", seed: 1234, mixSeed: 1234,
  cot: "full", steps: 32, maxDuration: 120, scoreHash: null,
  sampling: { top_p: .95, temperature: 1, top_k: 100, repetition_penalty: 1.2 },
  planSampling: { temperature: .7, top_p: .9, top_k: 30, repetition_penalty: 1.005, penalty_window: 100 },
  instrumental: false, lora: null, loraStrength: null, loraClip: null, loraClipStrength: null,
});
const adapted = () => ({ ...baseline(), file: "aiplay_adapter.flac", lora: "mine_song.safetensors", loraStrength: .8,
  sampling: { temperature: 1, top_p: .95, top_k: 100, repetition_penalty: 1.2 } });

test("a matched YuE2 baseline and adapter pair is reviewable, not called improved", () => {
  const result = compareTrainingTakes(baseline(), adapted());
  assert.equal(result.status, "matched");
  assert.equal(result.adapter, "mine_song.safetensors");
  assert.equal(result.strength, .8);
  assert.match(result.message, /do not prove improvement/);
  assert.ok(result.checks.every(check => check.status === "match"));
});

test("a mismatched seed, checkpoint, sampler or score is never certified as a LoRA effect", () => {
  for (const [field, value] of [
    ["seed", 1235], ["checkpoint", "different.safetensors"],
    ["sampling", { ...adapted().sampling, top_p: .8 }], ["scoreHash", "a".repeat(64)],
  ]) {
    const changed = { ...adapted(), [field]: value };
    const result = compareTrainingTakes(baseline(), changed);
    assert.equal(result.status, "mismatch", field);
    assert.match(result.message, /Not a controlled pair/);
  }
  assert.equal(compareTrainingTakes(baseline(), { ...adapted(), loraStrength: 0 }).status, "mismatch");
  assert.equal(compareTrainingTakes(baseline(), { ...adapted(), lora: null }).status, "mismatch");
});

test("legacy or incomplete receipts remain unverified even when visible fields match", () => {
  assert.equal(compareTrainingTakes({ ...baseline(), comparisonVersion: undefined }, adapted()).status, "unverified");
  assert.equal(compareTrainingTakes({ ...baseline(), checkpoint: null }, { ...adapted(), checkpoint: null }).status, "unverified");
  const incomplete = adapted(); delete incomplete.planSampling;
  const result = compareTrainingTakes(baseline(), incomplete);
  assert.equal(result.status, "unverified");
  assert.ok(result.checks.some(c => c.field === "planner sampling" && c.status === "unknown"));
  assert.equal(compareTrainingTakes({ ...baseline(), sampling: {} }, { ...adapted(), sampling: {} }).status, "unverified");
});

test("saved effective sampler settings use the graph's actual defaults", () => {
  const receipt = yue2ComfySamplingReceipt();
  const graph = buildYue2ComfyGraph({ caption: "warm piano", checkpoint: "yue2_3b.safetensors" });
  for (const [key, value] of Object.entries(receipt.audio)) assert.equal(graph[5].inputs[key], value);
  for (const [key, value] of Object.entries(receipt.planner)) assert.equal(graph[4].inputs[key], value);
  assert.equal(yue2ComfySamplingReceipt({ cot: "off" }).planner, null);
  assert.equal(yue2ComfySamplingReceipt({ abc: "X:1\nK:C\nC" }).planner, null);
});

test("the compare route checks physical library presence before sidecars and needs no GPU", () => {
  const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const section = index.slice(index.indexOf('if (p === "/api/train"'), index.indexOf('if (action === "status")', index.indexOf('if (p === "/api/train"')));
  assert.match(section, /action === "compare"/);
  assert.ok(section.indexOf("await library.list()") < section.indexOf("library.meta.get(before)"));
  assert.ok(section.indexOf('action === "compare"') < section.indexOf("const g = gpuStatus()"));
  assert.match(section, /train\.compareTrainingTakes\(baseline, adapterTake\)/);
  assert.match(section, /compareArchivedTrainingPair\(/);
  assert.match(section, /runRecord: \(runId, options\) => engineDoor\.runRecord\(runId, options\)/);
  const mcp = readFileSync(new URL("../mcp.js", import.meta.url), "utf8");
  assert.match(mcp, /name: "compare_yue2_lora_takes"/);
  assert.match(mcp, /action: "compare", before: safeName\(a\.before_file, "song"\), after: safeName\(a\.after_file, "song"\)/);
  assert.match(mcp, /A broken provenance link/);
});
