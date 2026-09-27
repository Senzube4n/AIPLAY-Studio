import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { compactImageJob, makeImageJob } from "./image-job.js";
import { ffmpegPath, ffprobePath } from "../clipjoin.js";
import { IMAGE_RETURN_BYTES_CAP, checkImageReturn, inspectPng, makeImageReturn,
  measurePng, readImageReturn } from "./image-return.js";

const BORROWER = "a".repeat(32);
const LENDER = "b".repeat(32);
const STRANGER = "c".repeat(32);
const SHA = (bytes) => createHash("sha256").update(bytes).digest("hex");
const CANVAS = { width: 1024, height: 1024 };

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const t = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  checksum.writeUInt32BE(crc(Buffer.concat([t, bytes])));
  return Buffer.concat([length, t, bytes, checksum]);
}
function png(width, height, { alpha = 255, badPixels = false, animated = false } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // eight-bit RGBA
  header[9] = 6;
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * stride + 1 + x * 4;
      raw[i] = 45; raw[i + 1] = 115; raw[i + 2] = 205; raw[i + 3] = alpha;
    }
  }
  const compressed = badPixels ? Buffer.from("bad zlib stream") : deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    ...(animated ? [chunk("acTL", Buffer.alloc(8))] : []),
    chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0)),
  ]);
}
function addTextChunk(bytes, type, keyword, value) {
  // Insert after the complete first IHDR. `chunk` supplies a valid CRC, so a
  // metadata refusal cannot be mistaken for a damaged-file refusal.
  const ihdrEnd = 8 + 12 + 13;
  const payload = type === "iTXt"
    ? Buffer.concat([Buffer.from(`${keyword}\0`, "latin1"), Buffer.from([0, 0, 0, 0]), Buffer.from(value, "utf8")])
    : Buffer.from(`${keyword}\0${value}`, "latin1");
  return Buffer.concat([bytes.subarray(0, ihdrEnd), chunk(type, payload), bytes.subarray(ihdrEnd)]);
}

const order = makeImageJob({ prompt: "A blue moon above a quiet shore", seed: 1729,
  ...CANVAS, returnTo: { fp: BORROWER, nickname: "Borrower" }, now: 1_000_000,
  references: [{ data: png(2, 2), mime: "image/png", safety: { minor: false, sexual: false } }],
});
const record = {
  engine: order.job.engine, model: "Qwen/Qwen-Image-2.1", modelVersion: "native-int8",
  modelSha256: null, modelPolicy: order.job.modelPolicy,
  seed: order.job.seed, width: order.job.width, height: order.job.height,
  steps: order.job.steps, cfg: order.job.cfg, sampler: order.job.sampler,
  scheduler: order.job.scheduler, count: order.job.count, refSizing: order.job.refSizing,
  draft: order.job.draft, transparent: order.job.transparent, negative: order.job.negative,
  referenceSha256s: order.job.references.map((ref) => ref.sha256),
  outputRights: { class: "yours-with-conditions", source: "lender-model-catalogue" },
};
const image = png(CANVAS.width, CANVAS.height);
const fakeMeasure = async () => ({ ...CANVAS, codec: "png", frames: 1, opaque: true,
  decodedBytes: CANVAS.width * CANVAS.height * 4 });
let valid;
async function returned() {
  valid ||= await makeImageReturn({ orderDoc: order, fromFp: LENDER, resultBytes: image,
    record, now: 1_000_100, measure: fakeMeasure });
  return structuredClone(valid);
}
const check = (doc, over = {}) => checkImageReturn({ returnDoc: doc, orderDoc: order,
  orderToFp: LENDER, fromFp: LENDER, toFp: BORROWER, measure: fakeMeasure, ...over });

test("a Qwen image return remains quarantined after exact order and identity checks", async () => {
  const doc = await returned();
  const read = readImageReturn(doc);
  assert.ok(read.bytes.equals(image));
  const verdict = await check(doc);
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  assert.equal(verdict.disposition, "quarantine");
  assert.equal(verdict.measured.decodedBytes, CANVAS.width * CANVAS.height * 4);
  assert.equal(doc.record.modelSha256, null); // unhashed local weights are disclosed, not invented
});

test("a compact orderbook image job verifies and seals the same return", async () => {
  const stored = compactImageJob(order);
  assert.equal(stored.job.references[0].b64, undefined);
  const doc = await makeImageReturn({ orderDoc: stored, fromFp: LENDER,
    resultBytes: image, record, now: 1_000_101, measure: fakeMeasure });
  const verdict = await check(doc, { orderDoc: stored });
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  const changed = structuredClone(stored);
  changed.job.prompt = "Altered after signing";
  assert.equal((await check(doc, { orderDoc: changed })).reason, "stored-image-job-changed");
  const wrongReference = structuredClone(doc);
  wrongReference.record.referenceSha256s[0] = "0".repeat(64);
  assert.equal((await check(wrongReference, { orderDoc: stored })).reason, "record-references");
});

test("a sealed return accepts only the bounded build caption", async () => {
  const stamped = { ...(await returned()), by: { app: "B 26.09.26", commit: "abc1234", protocol: 1 } };
  assert.equal(readImageReturn(stamped).doc.by.protocol, 1);
  assert.equal((await check(stamped)).ok, true);
  assert.throws(() => readImageReturn({ ...stamped, by: { ...stamped.by, path: "secret" } }), { reason: "bad-image-return" });
});

test("wrong order, signer, recipient, seed, settings and reference sequence cannot pass", async () => {
  const base = await returned();
  assert.equal((await check({ ...base, orderId: "o_" + "f".repeat(12) })).reason, "return-unknown-order");
  assert.equal((await check({ ...base, from: STRANGER })).reason, "return-not-my-order");
  assert.equal((await check(base, { orderToFp: STRANGER })).reason, "return-not-my-order");
  assert.equal((await check(base, { fromFp: STRANGER })).reason, "return-not-my-order");
  assert.equal((await check({ ...base, to: STRANGER })).reason, "return-not-for-me");
  assert.equal((await check(base, { toFp: STRANGER })).reason, "return-not-for-me");
  assert.equal((await check(base, { orderToFp: null })).reason, "unverified-return-context");
  for (const [field, replacement] of [["seed", 1730], ["steps", 26], ["cfg", 2],
    ["width", 768], ["sampler", "dpmpp"]]) {
    const doc = structuredClone(base);
    doc.record[field] = replacement;
    assert.equal((await check(doc)).reason, "record-settings", field);
  }
  const policy = structuredClone(base);
  policy.record.modelPolicy = "sender-file";
  assert.equal((await check(policy)).reason, "record-model");
  const refs = structuredClone(base);
  refs.record.referenceSha256s = ["d".repeat(64)];
  assert.equal((await check(refs)).reason, "record-references");
});

test("model provenance and rights need a complete bounded record", async () => {
  const base = await returned();
  for (const edit of [
    (doc) => { doc.record.model = ""; },
    (doc) => { doc.record.modelSha256 = "not-a-hash"; },
    (doc) => { doc.record.outputRights = null; },
    (doc) => { doc.record.outputRights = {}; },
    (doc) => { doc.record.modelPath = "C:\\private\\model.gguf"; },
  ]) {
    const doc = structuredClone(base);
    edit(doc);
    assert.equal((await check(doc)).ok, false);
  }
});

test("64 MiB cap, canonical base64, PNG signature and SHA-256 are checked before decode", async () => {
  const base = await returned();
  const tooBig = structuredClone(base);
  tooBig.result.bytes = IMAGE_RETURN_BYTES_CAP + 1;
  assert.equal((await check(tooBig)).reason, "result-metadata");
  const encoded = structuredClone(base);
  encoded.result.b64 += "\n";
  assert.equal((await check(encoded)).reason, "result-bytes");
  const tampered = structuredClone(base);
  tampered.result.b64 = Buffer.from("not png").toString("base64");
  tampered.result.bytes = 7;
  assert.equal((await check(tampered)).reason, "result-hash");
  const badHash = structuredClone(base);
  badHash.result.sha256 = "0".repeat(64);
  assert.equal((await check(badHash)).reason, "result-hash");
  const damaged = Buffer.from(image);
  damaged[damaged.length - 18] ^= 1; // break IDAT checksum
  assert.throws(() => inspectPng(damaged), { reason: "png-integrity" });
  assert.throws(() => inspectPng(png(2, 2, { animated: true })), { reason: "result-animated" });
});

test("a returned PNG refuses graph text metadata before sealing or receiving, while XMP remains readable", async () => {
  for (const type of ["tEXt", "iTXt"]) {
    const withGraph = addTextChunk(image, type, "prompt", '{"nodes":[{"class_type":"KSampler"}]}');
    assert.throws(() => inspectPng(withGraph), { reason: "result-metadata" }, type);
    await assert.rejects(makeImageReturn({ orderDoc: order, fromFp: LENDER, resultBytes: withGraph,
      record, now: 1_000_200, measure: fakeMeasure }), { reason: "result-metadata" }, type);
    const arriving = structuredClone(await returned());
    arriving.result = { mime: "image/png", bytes: withGraph.length,
      sha256: SHA(withGraph), b64: withGraph.toString("base64") };
    assert.throws(() => readImageReturn(arriving), { reason: "result-metadata" }, type);
  }
  const withXmp = addTextChunk(image, "iTXt", "XML:com.adobe.xmp", "<x:xmpmeta/>");
  assert.deepEqual(inspectPng(withXmp), CANVAS);
  const stamped = await makeImageReturn({ orderDoc: order, fromFp: LENDER, resultBytes: withXmp,
    record, now: 1_000_201, measure: fakeMeasure });
  assert.ok(readImageReturn(stamped).bytes.equals(withXmp));
});

const available = [ffprobePath(), ffmpegPath()].every((bin) => spawnSync(bin, ["-version"],
  { windowsHide: true, timeout: 5000, stdio: "ignore" }).status === 0);

test("real ffprobe plus full ffmpeg RGBA decode measures an opaque image", { skip: !available }, async () => {
  const measured = await measurePng(image);
  assert.deepEqual(measured, { ...CANVAS, codec: "png", frames: 1, opaque: true,
    decodedBytes: CANVAS.width * CANVAS.height * 4 });
  const verdict = await check(await returned(), { measure: measurePng });
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
});

test("real decoder rejects valid-chunk bad pixels, transparency and a wrong canvas", { skip: !available }, async () => {
  await assert.rejects(measurePng(png(2, 2, { badPixels: true })),
    (error) => error.reason === "image-decode-failed");
  await assert.rejects(measurePng(png(2, 2, { alpha: 128 })),
    (error) => error.reason === "image-not-opaque");
  const wrong = png(768, 1344);
  const doc = await returned();
  doc.result.b64 = wrong.toString("base64");
  doc.result.bytes = wrong.length;
  doc.result.sha256 = SHA(wrong);
  const verdict = await check(doc, { measure: measurePng });
  assert.equal(verdict.reason, "image-canvas");
  assert.equal(verdict.disposition, "quarantine");
});

test("missing decoder fails closed with a clear reason", async () => {
  await assert.rejects(measurePng(png(2, 2), { ffprobe: "no-such-ffprobe-aiplay" }),
    { reason: "decoder-unavailable" });
});
