/**
 * A FAILED CLIP IN WORDS, THROUGH THE REAL RUNNER (UI_PLAN E4, the H3 lab's
 * build issues).
 *
 * A render fails two ways, and the person used to read ComfyUI's JSON for one
 * of them: engine/client.js THROWS "ComfyUI rejected the job: ..." when /prompt
 * refuses the graph before it runs (a missing file, a value not in a list), and
 * RETURNS a run with status "error" when it fails while rendering. Both now
 * become the sentence (server/video-plain.js plainVideoFailure), with the
 * engine's own text kept beside it: on the job's status row (`detail`, the
 * page's Details), for a waiter (`fullError`), and in the log and lastError.
 *
 * ArtRunner runs for real, with the engine door stubbed: no server, no engine,
 * no GPU, temp folders only.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temp = await mkdtemp(path.join(os.tmpdir(), "aiplay-video-fail-"));
process.env.AIPLAY_APPDATA = path.join(temp, "settings");
process.env.AIPLAY_OUTPUT = path.join(temp, "output");
process.env.AIPLAY_RIG = path.join(temp, "rig");
process.env.AIPLAY_MODELS_DIR = path.join(temp, "models");
const { ArtRunner } = await import("./art.js");
const { engine } = await import("./engine/client.js");
const { plainVideoFailure } = await import("./video-plain.js");

const original = { run: engine.run, socket: engine.socket, objectInfo: engine.objectInfo };
engine.socket = () => Object.assign(new EventEmitter(), { readyState: 1, close() {} });
engine.objectInfo = async () => ({});          // no CK, no sparse node: nothing extra asked of a real engine
let behave = null;
engine.run = async (spec) => behave(spec);
const runner = new ArtRunner({ ready: true }, { current: null, queue: [] });
const quiet = console.error;
after(async () => {
  Object.assign(engine, original);
  console.error = quiet;
  await rm(temp, { recursive: true, force: true });
});

/** Queue one clip the way /api/video does and wait for its `failed` event. */
function failedClip(file, how) {
  behave = how;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { runner.off("failed", on); reject(new Error(`${file} never failed`)); }, 15_000);
    const on = (e) => { if (e.file !== file) return; clearTimeout(timer); runner.off("failed", on); resolve(e); };
    runner.on("failed", on);
    const job = runner.request({ file, title: file, kind: "video", force: true, seed: 1, actor: "agent:test",
      video: { engine: "h3", prompt: "a lamp on a table", seconds: 2, width: 512, height: 512, steps: 8 } });
    assert.ok(job, runner.lastRefusal || "queued");
  });
}
const rowOf = (file) => runner.status().art.recent.find((r) => r.file === file) || {};

test("a submission the engine refused before it ran: the sentence, the engine's text behind it", async () => {
  const raw = 'ComfyUI rejected the job: {"error":{"type":"prompt_outputs_failed_validation"},"node_errors":{"12":'
    + '{"errors":[{"type":"value_not_in_list","details":"lora_name: \'gone.safetensors\' not in []"}]}}}';
  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  const e = await failedClip("clip:rejected", () => { throw Object.assign(new Error(raw), { runId: "r-rejected", status: "rejected" }); });
  console.error = quiet;
  const said = plainVideoFailure(raw);
  assert.equal(said.reason, "refused");
  assert.equal(e.error, said.sentence, "the person reads the sentence, not the JSON");
  assert.equal(e.runId, "r-rejected", "the ledger run is still named");
  const row = rowOf("clip:rejected");
  assert.equal(row.error, said.sentence);
  assert.equal(row.detail, raw, "the page's Details hold the engine's own text");
  assert.equal(row.errorReason, "refused");
  assert.equal(row.fullError, `${said.sentence} Details: ${raw}`.slice(0, 4000), "a waiter gets both");
  assert.match(runner.lastError, /^clip:rejected: The video engine refused this setup before rendering.* Details: ComfyUI rejected the job: /,
    "Settings' last error keeps the raw text beside the sentence");
  assert.ok(logged.some((l) => l.includes("Details: ComfyUI rejected the job")), "and so does the log");
});

test("a render that failed while running: the card's memory and the PC's are two different sentences", async () => {
  const cardOom = JSON.stringify([["execution_error", { exception_type: "torch.OutOfMemoryError",
    exception_message: "Allocation on device 0 would exceed allowed memory. (out of memory)" }]]);
  console.error = () => {};
  const card = await failedClip("clip:card-oom", async () => ({ status: "error", runId: "r-card", error: cardOom, outputs: [] }));
  const ramRaw = "DefaultCPUAllocator: not enough memory: you tried to allocate 1073741824 bytes.";
  const ram = await failedClip("clip:ram-oom", async () => ({ status: "error", runId: "r-ram", error: ramRaw, outputs: [] }));
  console.error = quiet;
  assert.equal(card.error, "The card ran out of memory at this size; pick the smaller size or close GPU-heavy apps.");
  assert.equal(rowOf("clip:card-oom").errorReason, "out-of-memory");
  assert.equal(rowOf("clip:card-oom").detail, cardOom);
  assert.match(ram.error, /^This PC ran out of memory \(RAM, not the graphics card\)/, "a smaller size would not help it");
  assert.equal(rowOf("clip:ram-oom").errorReason, "ram-out-of-memory");
  assert.equal(rowOf("clip:ram-oom").detail, ramRaw);
});

test("a minors refusal is not a failed setup: the engine door's travels unchanged, and the backstop's is the sentence", async () => {
  const { safetyError, REFUSAL, CODE } = await import("./safety/refusal.js");
  console.error = () => {};
  const door = await failedClip("clip:refused-door", () => { throw safetyError({ door: "engine.dispatch" }); });
  const backstop = await failedClip("clip:refused-backstop", async () => ({ status: "error", runId: "r-backstop",
    error: JSON.stringify([["execution_error", { exception_type: "RuntimeError", exception_message: REFUSAL }]]), outputs: [] }));
  console.error = quiet;
  assert.equal(door.error, REFUSAL, "the door's sentence, not \"the video engine refused this setup\"");
  assert.equal(door.code, CODE, "its code, so a waiter answers 422");
  const row = rowOf("clip:refused-door");
  assert.equal(row.detail, undefined, "no Details behind a refusal");
  assert.equal(row.title ?? null, null, "and no title, which is the prompt's first words");
  assert.equal(backstop.error, REFUSAL, "the backstop's refusal is said as itself");
  assert.equal(rowOf("clip:refused-backstop").detail, undefined);
  assert.equal(runner.lastError, `clip:refused-backstop: ${REFUSAL}`);
});
