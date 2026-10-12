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
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temp = await mkdtemp(path.join(os.tmpdir(), "aiplay-video-fail-"));
process.env.AIPLAY_APPDATA = path.join(temp, "settings");
process.env.AIPLAY_OUTPUT = path.join(temp, "output");
process.env.AIPLAY_RIG = path.join(temp, "rig");
process.env.AIPLAY_MODELS_DIR = path.join(temp, "models");
/* The 8-step speed-up on the temp disk, so an 8-step clip reaches the engine
 * (a speed-up not on disk is refused before it, last test below). */
await mkdir(path.join(temp, "models", "loras"), { recursive: true });
await writeFile(path.join(temp, "models", "loras", "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"), "x");
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
function failedClip(file, how, video = {}) {
  behave = how;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { runner.off("failed", on); reject(new Error(`${file} never failed`)); }, 15_000);
    const on = (e) => { if (e.file !== file) return; clearTimeout(timer); runner.off("failed", on); resolve(e); };
    runner.on("failed", on);
    const job = runner.request({ file, title: file, kind: "video", force: true, seed: 1, actor: "agent:test",
      video: { engine: "h3", prompt: "a lamp on a table", seconds: 2, width: 512, height: 512, steps: 8, ...video } });
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

test("a speed-up not on disk is refused before the engine, whichever door queued the clip", async () => {
  /* The music-video runner and Extend queue through request() like this and
   * never ran /api/video's check: on this disk (the 8-step file alone) a
   * 4-step clip loaded the 8-step file at 4 steps. #clip refuses it now. */
  let reached = 0;
  console.error = () => {};
  const e = await failedClip("clip:mv-brief-4", async () => { reached++; return { status: "error", error: "should not run" }; }, { steps: 4 });
  const cast = await failedClip("clip:mv-cast-4", async () => { reached++; return { status: "error", error: "should not run" }; },
    { steps: 4, refImages: ["cast.png"] });
  console.error = quiet;
  assert.equal(reached, 0, "the engine was never asked");
  assert.match(e.error, /^4 steps needs H3's 4-step speed-up \(1\.96 GB\), which is not downloaded\./);
  assert.equal(e.needsModel, "videoH3Turbo4", "the failure names the row to download");
  const row = rowOf("clip:mv-brief-4");
  assert.equal(row.needsModel, "videoH3Turbo4", "and so does the status row");
  assert.equal(row.errorReason, "speedup-missing");
  assert.equal(cast.needsModel, "videoH3Turbo4", "a cast scene at 4 needs the reference path's 4-step file");
});

/* THE FRESH-ENGINE WAIT THROUGH THE REAL RUNNER (art.js #clip,
 * waitForQuietEngine). "always" so the card this test runs on does not
 * decide; the engine has rendered once, so a restart is due. */
const until = async (cond, ms = 10_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (cond()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return false;
};
async function withBusyEngine(fn) {
  const { config } = await import("./config.js");
  const saved = { mode: config.video.freeBeforeClip, ran: engine.ranSinceStart, queue: engine.queue, status: engine.status,
    interrupt: engine.interrupt, restart: runner.comfy.restart };
  const seen = { interrupts: 0, restarts: 0 };
  config.video.freeBeforeClip = "always";
  engine.ranSinceStart = () => 1;
  engine.interrupt = async () => { seen.interrupts++; return { stopped: true }; };
  runner.comfy.restart = async () => { seen.restarts++; };
  try { return await fn(seen); } finally {
    config.video.freeBeforeClip = saved.mode;
    Object.assign(engine, { ranSinceStart: saved.ran, queue: saved.queue, status: saved.status, interrupt: saved.interrupt });
    runner.comfy.restart = saved.restart;
  }
}

test("a clip waiting for a quiet engine: Stop ends the wait, interrupts nothing, and nothing is restarted", async () => {
  const { STOPPED_ERROR } = await import("./art.js");
  await withBusyEngine(async (seen) => {
    /* Somebody else's run is on ComfyUI the whole time. */
    engine.queue = async () => ({ queue_running: [["theirs"]], queue_pending: [] });
    engine.status = async () => ({ running: [] });
    let reached = 0;
    const failed = failedClip("clip:stop-while-waiting", async () => { reached++; return { status: "error", error: "should not run" }; });
    assert.ok(await until(() => runner.current?.file === "clip:stop-while-waiting" && runner.current.waitingForQuiet), "the clip waits");
    const r = await runner.stopCurrent();
    const e = await failed;
    assert.equal(r.stopping, true, "the row says it is stopping");
    assert.equal(e.cancelled, true, "it ends as stopped, not failed");
    assert.equal(e.error, STOPPED_ERROR);
    assert.equal(seen.interrupts, 0, "the run it waited for was not interrupted");
    assert.equal(seen.restarts, 0, "and the engine under it was not restarted");
    assert.equal(reached, 0, "the clip never reached the engine");
  });
});

test("Battery Safe's stop-everything (stopAll) ends a waiting clip too: no restart for it, and no render after", async () => {
  /* stopAll interrupts and clears ComfyUI's queue, which ended the work the
   * clip waited for; the clip, never marked, then read the card as quiet,
   * restarted the engine and rendered, on battery (review of the port,
   * 2026-10-08). */
  const { STOPPED_ERROR } = await import("./art.js");
  await withBusyEngine(async (seen) => {
    let busy = true;
    engine.queue = async () => ({ queue_running: busy ? [["theirs"]] : [], queue_pending: [] });
    engine.status = async () => ({ running: [] });
    engine.interrupt = async () => { seen.interrupts++; busy = false; return { stopped: true }; };
    const savedClear = engine.clearQueue;
    engine.clearQueue = async () => { busy = false; return { dropped: 0 }; };
    let reached = 0;
    try {
      const failed = failedClip("clip:battery-while-waiting", async () => { reached++; return { status: "error", error: "should not run" }; });
      assert.ok(await until(() => runner.current?.file === "clip:battery-while-waiting" && runner.current.waitingForQuiet), "the clip waits");
      const r = await runner.stopAll();
      const e = await failed;
      assert.equal(r.interrupted, true, "everything else on the card was stopped, as Battery Safe asks");
      assert.equal(e.cancelled, true, "the waiting clip ends as stopped");
      assert.equal(e.error, STOPPED_ERROR);
      assert.equal(seen.restarts, 0, "the engine was not restarted for it");
      assert.equal(reached, 0, "and the clip never reached the engine");
    } finally { engine.clearQueue = savedClear; }
  });
});

test("a run the engine door holds, which ComfyUI's queue does not show, holds the restart until it is gone", async () => {
  await withBusyEngine(async (seen) => {
    let doorBusy = true;
    engine.queue = async () => ({ queue_running: [], queue_pending: [] });
    engine.status = async () => ({ running: doorBusy ? [{ runId: "chat-1", via: "chat" }] : [] });
    let reached = 0;
    console.error = () => {};
    const failed = failedClip("clip:door-run", async () => { reached++; return { status: "error", runId: "r-door", error: "boom", outputs: [] }; });
    assert.ok(await until(() => runner.current?.file === "clip:door-run" && runner.current.waitingForQuiet), "the clip waits");
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(seen.restarts, 0, "not restarted while the door's run is in flight");
    assert.equal(reached, 0);
    doorBusy = false;
    await failed;
    console.error = quiet;
    assert.equal(seen.restarts, 1, "restarted once the card is quiet");
    assert.equal(reached, 1, "then the clip ran");
  });
});

test("a job of several door runs holds the restart between them (engine/client.js hold), through the real door's status", async () => {
  /* A Reactive Paint look: frames are separate door runs, and between two
   * of them the door has nothing in flight and ComfyUI's queue is empty.
   * The hold is what the restart reads there. engine.status is the real one. */
  await withBusyEngine(async (seen) => {
    engine.queue = async () => ({ queue_running: [], queue_pending: [] });
    const release = engine.hold("a Reactive Paint look");
    assert.deepEqual((await engine.status()).held, ["a Reactive Paint look"], "the door names the hold");
    let reached = 0;
    console.error = () => {};
    const failed = failedClip("clip:held", async () => { reached++; return { status: "error", runId: "r-held", error: "boom", outputs: [] }; });
    assert.ok(await until(() => runner.current?.file === "clip:held" && runner.current.waitingForQuiet), "the clip waits");
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(seen.restarts, 0, "not restarted between two frames");
    assert.equal(reached, 0);
    release();
    release();
    assert.deepEqual((await engine.status()).held, [], "released once, and a second release is harmless");
    await failed;
    console.error = quiet;
    assert.equal(seen.restarts, 1, "restarted once the look let go");
    assert.equal(reached, 1, "then the clip ran");
  });
});

test("a hold with idleMs lapses when the door has had no run for that long, so work waiting behind the clip lets it go", async () => {
  const release = engine.hold("a chat turn", { idleMs: 60 });
  try {
    assert.deepEqual((await engine.status()).held, ["a chat turn"], "held while fresh");
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual((await engine.status()).held, [], "lapsed: no door run for longer than idleMs");
  } finally { release(); }
  const plain = engine.hold("a Reactive Motion look");
  try {
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual((await engine.status()).held, ["a Reactive Motion look"], "a hold without idleMs lasts until released");
  } finally { plain(); }
});

test("the jobs made of several door runs take a hold: Paint, Motion and a chat turn on the card", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const index = read("./index.js");
  assert.match(index, /const release = engineDoor\.hold\("a Reactive Paint look"\);\s*try \{\s*return await paintClip\(/, "Paint, around its renderer");
  assert.match(index, /const release = engineDoor\.hold\("a Reactive Motion look"\);\s*try \{\s*return await motionClip\(/, "Motion, around its two runs");
  assert.equal((index.match(/\} finally \{ release\(\); \}/g) || []).length >= 2, true, "each released in a finally");
  const chat = read("./chat/routes.js");
  assert.match(chat, /const release = cloudTurn \? null : engine\.hold\?\.\("a chat turn", \{ idleMs: CHAT_HOLD_IDLE_MS \}\);\s*let out;\s*try \{\s*out = await runTurn\(/,
    "a chat turn on the card holds the door for its model calls");
  assert.match(chat, /\} finally \{ if \(typeof release === "function"\) release\(\); \}/);
});
