import test from "node:test";
import assert from "node:assert/strict";
import { makeVideoJob, readVideoJob, compactVideoJob, readStoredVideoJob } from "./video-job.js";
import { makeVideoReturn, readVideoReturn, checkVideoReturn } from "./video-return.js";
import { alignFrames, videoGraphH3 } from "../workflow.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { landOrderRow, transitionOrderState, findOrder } from "./orderbook.js";

const borrower = "a".repeat(32), lender = "b".repeat(32);
const now = 1_800_000_000_000;
function fixture() {
  return makeVideoJob({ prompt: "An adult dancer in a blue studio.", seed: 42,
    width: 256, height: 256, seconds: 1, steps: 20, guidance: 1, keepAudio: false,
    returnTo: { fp: borrower, nickname: "Borrower" }, now });
}
const changed = (doc, edit) => { const next = structuredClone(doc); edit(next); return next; };
const reason = (fn, wanted) => assert.throws(fn, (error) => error.reason === wanted);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 12]), Buffer.from("ftypisom")]);
const measured = { width: 256, height: 256, fps: 24, frames: 39, seconds: 39 / 24,
  videoStreams: 1, audioStreams: 0 };
const measure = async () => measured;
function record(doc) {
  const { type: _type, ...settings } = doc.job;
  return { ...settings, model: "minimax-h3", modelVersion: "minimax-h3-base.safetensors",
    modelSha256: null, outputRights: { class: "unknown", why: "Receiver-local model" } };
}

test("H3 video job has an exact signed wire schema and tamper-evident compact order", () => {
  const doc = fixture();
  assert.equal(readVideoJob(doc, { now }).job.prompt, doc.job.prompt);
  const stored = compactVideoJob(doc);
  assert.match(stored.storage.sha256, /^[0-9a-f]{64}$/);
  assert.equal(readStoredVideoJob(stored).storage.sha256, stored.storage.sha256);
  reason(() => readStoredVideoJob(changed(stored, (x) => { x.job.seed++; })), "stored-video-job-changed");
  reason(() => readStoredVideoJob(changed(stored, (x) => { x.job.width = 512; })), "stored-video-job-changed");
  reason(() => readVideoJob(changed(doc, (x) => { x.job.path = "C:\\secret.mp4"; })), "bad-video-job");
  reason(() => readVideoJob(changed(doc, (x) => { x.project = "made-up"; })), "bad-video-job");
  reason(() => readVideoJob(changed(doc, (x) => { x.job.references = ["source.png"]; })), "references-unsupported");
  reason(() => readVideoJob(changed(doc, (x) => { x.job.negative = "blur"; })), "settings-incompatible");
  reason(() => readVideoJob(changed(doc, (x) => { x.job.sparse = "sol-attn"; })), "settings-incompatible");
  reason(() => readVideoJob(changed(doc, (x) => { x.job.blockCache = true; })), "settings-incompatible");
  reason(() => readVideoJob(changed(doc, (x) => { x.job.steps = 4; })), "settings-incompatible");
  reason(() => readVideoJob(changed(doc, (x) => { x.job.guidance = 3; })), "settings-incompatible");
  assert.equal(readVideoJob(changed(doc, (x) => { x.job.attention = "ck"; })).job.attention, "ck");
  reason(() => readVideoJob(changed(doc, (x) => { x.job.width = 257; })), "size-unreproducible");
  reason(() => readVideoJob(doc, { now: doc.expires + 1 }), "order-expired");
});

test("signed return binds the original settings, sender, hash and measured H3 output", async () => {
  const stored = compactVideoJob(fixture());
  const doc = await makeVideoReturn({ orderDoc: stored, fromFp: lender,
    resultBytes: mp4, record: record(stored), now, measure });
  assert.equal(readVideoReturn(doc).bytes.toString("hex"), mp4.toString("hex"));
  const check = (ret, context = {}, probe = measure) => checkVideoReturn({
    returnDoc: ret, orderDoc: stored, orderToFp: lender, fromFp: lender,
    toFp: borrower, measure: probe, ...context });
  assert.equal((await check(doc)).ok, true);
  assert.equal((await check(changed(doc, (x) => { x.record.seed++; }))).reason, "record-settings");
  assert.equal((await check(changed(doc, (x) => { x.result.sha256 = "0".repeat(64); }))).reason, "result-hash");
  assert.equal((await check(doc, { fromFp: "c".repeat(32) })).reason, "return-association");
  assert.equal((await check(doc, {}, async () => ({ ...measured, frames: 40 }))).reason, "video-measure-disagrees");
  assert.equal((await check(doc, {}, async () => ({ ...measured, audioStreams: 1 }))).reason, "video-measure-disagrees");
  assert.equal((await check(doc, {}, async () => ({ ...measured, fps: 30 }))).reason, "video-measure-disagrees");
});

test("the built-in H3 graph encodes the exact frame/fps/audio contract checked on return", () => {
  for (const keepAudio of [false, true]) {
    const graph = videoGraphH3({ prompt: "An adult dancer", seed: 42, seconds: 1,
      width: 256, height: 256, steps: 20, keepAudio, bridge: "off",
      bridgeAlpha: 0, attention: "pytorch", sparse: "off", prefix: "clips/clip" });
    assert.equal(graph["5"].class_type, "MiniMaxH3ImageToVideo");
    assert.equal(graph["5"].inputs.length, alignFrames(1, 24, "h3"));
    assert.equal(graph["14"].class_type, "CreateVideo");
    assert.deepEqual(graph["14"].inputs.images, ["12", 0],
      "standalone H3 uses the full decoded image batch, not a trimmed continuation");
    assert.equal(graph["14"].inputs.fps, 24);
    assert.equal(Object.hasOwn(graph["14"].inputs, "audio"), keepAudio);
    assert.equal(graph["15"].class_type, "SaveVideo");
    assert.deepEqual(graph["15"].inputs.video, ["14", 0]);
    assert.equal(Object.values(graph).some((node) => /LoraLoader/i.test(node.class_type)), false,
      "20-step H3 graph is base-only and loads no automatic turbo LoRA");
  }
  const turbo = videoGraphH3({ prompt: "An adult dancer", seed: 42, seconds: 1,
    width: 256, height: 256, steps: 4, keepAudio: false });
  assert.equal(Object.values(turbo).some((node) => /LoraLoader/i.test(node.class_type)), true,
    "a 4-step graph uses a different turbo LoRA and must not be called base-only");
});

test("two render presses cannot claim the same accepted video order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiplay-video-render-lock-"));
  try {
    const order = compactVideoJob(fixture());
    await landOrderRow({ outDir: root, row: { id: order.id, at: order.at, jobType: "video",
      videoJob: order, state: "landed" } });
    const attempts = await Promise.allSettled([1, 2].map(() => transitionOrderState({
      outDir: root, id: order.id, from: "landed", to: "rendering" })));
    assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((item) => item.status === "rejected")[0].reason.reason, "order-state-changed");
    assert.equal((await findOrder({ outDir: root, id: order.id, side: "in" })).state, "rendering");
  } finally { await rm(root, { recursive: true, force: true }); }
});
