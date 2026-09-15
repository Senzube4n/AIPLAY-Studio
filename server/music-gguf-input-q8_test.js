/** Q8 request-boundary tests: no queue instance, process, GPU, network or owner settings. */
import assert from "node:assert/strict";
import { test, after } from "node:test";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";

const base = path.resolve(os.tmpdir());
const scratch = await mkdtemp(path.join(base, "aiplay-gguf-q8-input-"));
for (const key of Object.keys(process.env)) if (key.startsWith("AIPLAY_")) delete process.env[key];
process.env.AIPLAY_APPDATA = path.join(scratch, "appdata");
process.env.AIPLAY_RIG = path.join(scratch, "rig");
process.env.AIPLAY_OUTPUT = path.join(scratch, "output");
process.env.AIPLAY_YUE_GGUF_ENABLED = "0";
const { prepareGgufJob } = await import("./music-gguf-input.js");

after(async () => {
  assert.equal(path.dirname(path.resolve(scratch)), base);
  assert.ok(path.basename(scratch).startsWith("aiplay-gguf-q8-input-"));
  await rm(scratch, { recursive: true, force: true });
});

const valid = (extra = {}) => ({ caption: "Warm acoustic folk", lyrics: "The river finds the sea\nCarry this song with me", ...extra });
const queued = [];
const boundary = (body) => {
  const job = prepareGgufJob(body, "agent:test");
  queued.push(job);
  return job;
};
const refuses = (body) => {
  const count = queued.length;
  assert.throws(() => boundary(body));
  assert.equal(queued.length, count, "invalid precision/options stop before queue insertion");
};

test("omitted precision remains Q4 with the existing native engine and human model label", () => {
  for (const body of [valid(), valid({ quantization: undefined }), valid({ quantization: "q4_0" })]) {
    const job = boundary(body);
    assert.equal(job.engine, "yue2-gguf"); assert.equal(job.quantization, "q4_0");
    assert.equal(job.model, "YuE2 GGUF Q4"); assert.equal(job.actor, "agent:test");
  }
});

test("explicit Q8 survives preparation without changing the native engine or source request", () => {
  const body = Object.freeze(valid({ engine: "yue2-gguf", quantization: "q8_0", title: "Night river",
    cot: "melody", abc: "X:1\nK:C\nCDEF|", seed: 42, narSteps: 16, cfgScale: 1.5 }));
  const job = boundary(body);
  assert.equal(body.quantization, "q8_0"); assert.equal(job.quantization, "q8_0");
  assert.equal(job.engine, "yue2-gguf"); assert.equal(job.model, "YuE2 GGUF Q8");
  assert.equal(job.title, body.title); assert.equal(job.caption, body.caption); assert.equal(job.lyrics, body.lyrics);
  assert.equal(job.cot, "melody"); assert.equal(job.abc, body.abc); assert.equal(job.seed, 42);
  assert.equal(job.narSteps, 16); assert.equal(job.cfgScale, 1.5); assert.equal(job.experimental, true);
  assert.equal(job.preview, false); assert.equal(job.instrumental, false);
  for (const key of ["rung", "offloadAr", "queryChunk", "maxTokens", "wantSeconds", "modelFile", "modelDir"]) {
    assert.equal(Object.hasOwn(job, key), false, key);
  }
});

test("only exact Q4/Q8 strings are accepted; no null, precision aliases, paths or coercion", () => {
  for (const quantization of [null, "", "q8", "Q8_0", "q8_0 ", "q4", "bf16", "fp8", "none",
    "yue2-3b-q8_0.gguf", "../weights.gguf", "__proto__", "constructor", 8, true, {}, ["q8_0"]]) {
    refuses(valid({ quantization }));
  }
});

test("Q8 does not authorize private model paths, Python knobs, references or duration controls", () => {
  for (const [key, value] of [["modelFile", "other.gguf"], ["modelDir", "C:/weights"], ["backend", "cpu"],
    ["offloadAr", true], ["queryChunk", 256], ["maxTokens", 9000], ["wantSeconds", 180],
    ["duration", 180], ["referenceAudio", "song.wav"], ["musicInput", {}], ["reusesConditioning", "old"],
    ["resumeFrom", "old"], ["runner", "custom"]]) {
    refuses(valid({ quantization: "q8_0", [key]: value }));
  }
});

test("Q8 retains lyric, boolean, score and native numeric validation before queue insertion", () => {
  for (const extra of [{ lyrics: "" }, { lyrics: "--log" }, { instrumental: true }, { preview: true },
    { allowSectionLabels: "false" }, { seed: "42" }, { narSteps: "16" }, { cfgScale: "1.5" },
    { cot: "auto" }, { cot: "off", abc: "X:1\nK:C\nCDEF|" }]) {
    refuses(valid({ quantization: "q8_0", ...extra }));
  }
});
