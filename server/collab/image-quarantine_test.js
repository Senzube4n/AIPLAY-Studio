import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { compactImageJob, makeImageJob } from "./image-job.js";
import { makeImageReturn } from "./image-return.js";
import { adoptImageReturn, dropImageReturn, imageQuarantineDir, imageQuarantinePicture,
  landImageReturn, listImageQuarantine } from "./image-quarantine.js";

const BORROWER = "a".repeat(32);
const LENDER = "b".repeat(32);
const STRANGER = "c".repeat(32);
const CANVAS = { width: 1024, height: 1024 };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type, data) {
  const t = Buffer.from(type, "ascii"), len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  let c = 0xffffffff;
  for (const byte of Buffer.concat([t, data])) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, t, data, crc]);
}
function png() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(CANVAS.width, 0);
  header.writeUInt32BE(CANVAS.height, 4);
  header[8] = 8; header[9] = 6; // RGBA
  const raw = Buffer.alloc((CANVAS.width * 4 + 1) * CANVAS.height);
  for (let y = 0; y < CANVAS.height; y++) {
    for (let x = 0; x < CANVAS.width; x++) raw[y * (CANVAS.width * 4 + 1) + 1 + x * 4 + 3] = 255;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const measured = { ...CANVAS, codec: "png", frames: 1, opaque: true,
  decodedBytes: CANVAS.width * CANVAS.height * 4 };
const measure = async () => measured;
const image = png();
const order = makeImageJob({ prompt: "Blue harbor at twilight", seed: 123,
  ...CANVAS, returnTo: { fp: BORROWER, nickname: "Borrower" }, now: 1_000_000 });
const record = {
  engine: order.job.engine, model: "Qwen/Qwen-Image-2.1", modelVersion: "local-int8",
  modelSha256: null, modelPolicy: order.job.modelPolicy,
  seed: order.job.seed, width: order.job.width, height: order.job.height,
  steps: order.job.steps, cfg: order.job.cfg, sampler: order.job.sampler,
  scheduler: order.job.scheduler, count: order.job.count, refSizing: order.job.refSizing,
  draft: order.job.draft, transparent: order.job.transparent, negative: order.job.negative,
  referenceSha256s: [], outputRights: { class: "receiver-recorded", source: "lender" },
};
let returned;
async function payload() {
  returned ||= await makeImageReturn({ orderDoc: order, fromFp: LENDER, resultBytes: image,
    record, now: 1_000_100, measure });
  return structuredClone(returned);
}
async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiplay-image-quarantine-test-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return { outDir: path.join(root, "collab"), imageDir: path.join(root, "images"), root };
}
const land = (opts, doc, extra = {}) => landImageReturn({ outDir: opts.outDir, payload: doc,
  orderDoc: order, orderToFp: LENDER, fromFp: LENDER, toFp: BORROWER,
  now: 1_000_200, measure, ...extra });

test("a checked peer image lands outside the image library until explicit adoption", async (t) => {
  const dirs = await workspace(t);
  const row = await land(dirs, await payload());
  assert.equal(row.ok, true);
  assert.equal(row.adopted, false);
  assert.equal(row.bytes, image.length);
  assert.equal(row.sha256, sha(image));
  assert.deepEqual(await readdir(dirs.imageDir).catch(() => []), []);
  assert.deepEqual((await listImageQuarantine({ outDir: dirs.outDir })).map((r) => r.file), [row.file]);
  const preview = await imageQuarantinePicture({ outDir: dirs.outDir, fromFp: LENDER, file: row.file });
  assert.equal(preview.type, "image/png");
  assert.ok((await readFile(preview.file)).equals(image));
  const adopted = await adoptImageReturn({ ...dirs, fromFp: LENDER, file: row.file,
    now: 1_000_300, measure });
  assert.equal(adopted.name, row.file);
  assert.ok((await readFile(adopted.file)).equals(image));
  assert.equal(adopted.metadata.source, "peer-image");
  assert.deepEqual(adopted.metadata.peer, { fp: LENDER, orderId: order.id });
  assert.equal(adopted.metadata.prompt, order.job.prompt);
  assert.equal(adopted.metadata.model, record.model);
  assert.deepEqual(adopted.metadata.outputRights, record.outputRights);
  assert.equal((await listImageQuarantine({ outDir: dirs.outDir }))[0].adopted, true);
  await assert.rejects(adoptImageReturn({ ...dirs, fromFp: LENDER, file: row.file, measure }),
    { reason: "already-adopted" });
});

test("a compact local order verifies before a return enters quarantine", async (t) => {
  const dirs = await workspace(t);
  const stored = compactImageJob(order);
  const changed = structuredClone(stored);
  changed.job.prompt = "Changed local order";
  await assert.rejects(land(dirs, await payload(), { orderDoc: changed }),
    { reason: "stored-image-job-changed" });
  assert.deepEqual(await listImageQuarantine({ outDir: dirs.outDir }), []);
  const landed = await land(dirs, await payload(), { orderDoc: stored });
  assert.equal(landed.ok, true);
  assert.equal(landed.prompt, order.job.prompt);
});

test("a replay cannot reset adoption, and parallel presses cannot adopt twice", async (t) => {
  const dirs = await workspace(t);
  const doc = await payload();
  const row = await land(dirs, doc);
  const results = await Promise.allSettled([1, 2].map(() => adoptImageReturn({ ...dirs,
    fromFp: LENDER, file: row.file, measure })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected" && r.reason.reason === "already-adopted").length, 1);
  const replay = await land(dirs, doc);
  assert.equal(replay.replay, true);
  assert.equal(replay.adopted, true);
});

test("failed library metadata save leaves a checked image retryable", async (t) => {
  const dirs = await workspace(t);
  const row = await land(dirs, await payload());
  const saved = [];
  await assert.rejects(adoptImageReturn({ ...dirs, fromFp: LENDER, file: row.file, measure,
    now: 1_000_300,
    persistMetadata: async ({ metadata }) => {
      saved.push(metadata);
      throw new Error("metadata disk full");
    } }), /metadata disk full/);
  assert.equal((await listImageQuarantine({ outDir: dirs.outDir }))[0].adopted, false);
  const recovered = await adoptImageReturn({ ...dirs, fromFp: LENDER, file: row.file, measure,
    now: 1_000_300,
    persistMetadata: async ({ metadata }) => { saved.push(metadata); } });
  assert.equal(recovered.row.adopted, true);
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[1], saved[0], "retry keeps the lender's original model and rights record");
});

test("an adopted image can safely retry the later orderbook update", async (t) => {
  const dirs = await workspace(t);
  const row = await land(dirs, await payload());
  const first = await adoptImageReturn({ ...dirs, fromFp: LENDER, file: row.file, measure,
    persistMetadata: async () => {} });
  const again = await adoptImageReturn({ ...dirs, fromFp: LENDER, file: row.file, measure,
    allowAlreadyAdopted: true, persistMetadata: async () => {} });
  assert.equal(again.replay, true);
  assert.equal(again.name, first.name);
  assert.equal(again.metadata.at, first.metadata.at);
  assert.deepEqual(again.metadata.outputRights, first.metadata.outputRights);
  assert.equal((await listImageQuarantine({ outDir: dirs.outDir }))[0].adopted, true);
});

test("changed bytes, collision and an unmeasured return cannot enter the library", async (t) => {
  const dirs = await workspace(t);
  const row = await land(dirs, await payload());
  const picture = path.join(imageQuarantineDir(dirs.outDir, LENDER), row.file);
  await writeFile(picture, Buffer.from("tampered"));
  await assert.rejects(adoptImageReturn({ ...dirs, fromFp: LENDER, file: row.file, measure }),
    { reason: "result-hash" });
  await assert.rejects(land(dirs, await payload()), { reason: "result-hash" });
  assert.deepEqual(await readdir(dirs.imageDir).catch(() => []), []);
  const dirs2 = await workspace(t);
  const failed = await land(dirs2, await payload(), { measure: async () => { throw Object.assign(new Error("no decoder"), { reason: "decoder-unavailable" }); } });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "decoder-unavailable");
  await assert.rejects(adoptImageReturn({ ...dirs2, fromFp: LENDER, file: failed.file, measure }),
    { reason: "return-refused" });
});

test("a library name collision never overwrites existing bytes", async (t) => {
  const dirs = await workspace(t);
  const row = await land(dirs, await payload());
  await mkdir(dirs.imageDir, { recursive: true });
  const dest = path.join(dirs.imageDir, row.file);
  await writeFile(dest, Buffer.from("different"));
  await assert.rejects(adoptImageReturn({ ...dirs, fromFp: LENDER, file: row.file, measure }),
    { reason: "image-library-collision" });
  assert.equal((await readFile(dest)).toString(), "different");
  assert.equal((await listImageQuarantine({ outDir: dirs.outDir }))[0].adopted, false);
});

test("association and path validation happen before any quarantine mutation", async (t) => {
  const dirs = await workspace(t);
  const doc = await payload();
  await assert.rejects(land(dirs, doc, { fromFp: STRANGER }), { reason: "return-association" });
  await assert.rejects(land(dirs, doc, { orderToFp: STRANGER }), { reason: "return-association" });
  await assert.rejects(land(dirs, doc, { toFp: STRANGER }), { reason: "return-association" });
  assert.deepEqual(await listImageQuarantine({ outDir: dirs.outDir }), []);
  const row = await land(dirs, doc);
  for (const malicious of ["../../outside.png", "..\\outside.png", row.file + ".json", "peer_x.png"]) {
    await assert.rejects(dropImageReturn({ outDir: dirs.outDir, fromFp: LENDER, file: malicious }),
      { reason: "bad-arguments" });
    await assert.rejects(imageQuarantinePicture({ outDir: dirs.outDir, fromFp: LENDER, file: malicious }),
      { reason: "bad-arguments" });
  }
  await assert.rejects(dropImageReturn({ outDir: dirs.outDir, fromFp: "../../", file: row.file }),
    { reason: "bad-arguments" });
  assert.equal((await stat(path.join(imageQuarantineDir(dirs.outDir, LENDER), row.file))).size, image.length);
  assert.deepEqual(await dropImageReturn({ outDir: dirs.outDir, fromFp: LENDER, file: row.file }),
    { dropped: row.file });
  assert.deepEqual(await listImageQuarantine({ outDir: dirs.outDir }), []);
});

test("an orphan picture or corrupt review record stays visible but cannot be adopted", async (t) => {
  const dirs = await workspace(t);
  const row = await land(dirs, await payload());
  const sidecar = path.join(imageQuarantineDir(dirs.outDir, LENDER), `${row.file}.json`);
  await rm(sidecar);
  const [orphan] = await listImageQuarantine({ outDir: dirs.outDir });
  assert.equal(orphan.reason, "row-missing");
  await assert.rejects(adoptImageReturn({ ...dirs, fromFp: LENDER, file: row.file, measure }),
    { reason: "no-such-image-return" });
  await writeFile(sidecar, "{not-json");
  const [corrupt] = await listImageQuarantine({ outDir: dirs.outDir });
  assert.equal(corrupt.reason, "image-row-unreadable");
  await assert.rejects(adoptImageReturn({ ...dirs, fromFp: LENDER, file: row.file, measure }),
    { reason: "image-row-unreadable" });
  assert.deepEqual(await readdir(dirs.imageDir).catch(() => []), []);
});
