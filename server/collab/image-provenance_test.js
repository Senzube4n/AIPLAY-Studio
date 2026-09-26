import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { makeImageJob, compactImageJob, readStoredImageJob } from "./image-job.js";

const indexSource = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const artSource = readFileSync(new URL("../art.js", import.meta.url), "utf8");
const sendStart = indexSource.indexOf('if (action === "image_send_back")');
const sendEnd = indexSource.indexOf("/* ── ACCEPT AN ORDER", sendStart);
assert.ok(sendStart > 0 && sendEnd > sendStart, "extract the real image return route");
const sendRoute = indexSource.slice(sendStart, sendEnd);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("strict peer metadata save rolls back before later image saves can snapshot it", async () => {
  const start = indexSource.indexOf("const IMAGE_STORE = ");
  const afterStore = /try \{\r?\n  const raw = JSON\.parse\(await readFile\(IMAGE_STORE/.exec(indexSource.slice(start));
  const end = afterStore ? start + afterStore.index : -1;
  assert.ok(start > 0 && end > start);
  const imageMeta = new Map();
  const published = [];
  let failNext = true, temporary = null;
  const save = vm.runInNewContext(`${indexSource.slice(start, end)}\nsaveImageStore`, {
    path, config: { outputDir: "local-output" }, imageMeta, process: { pid: 123 }, randomUUID,
    mkdir: async () => {}, unlink: async () => {},
    writeFile: async (_file, bytes) => { if (failNext) { failNext = false; throw new Error("disk full"); } temporary = bytes; },
    rename: async () => { published.push(JSON.parse(temporary)); },
  });
  const install = () => {
    const previous = imageMeta.get("peer.png");
    imageMeta.set("peer.png", { model: "Qwen", rights: "friend" });
    return () => previous ? imageMeta.set("peer.png", previous) : imageMeta.delete("peer.png");
  };
  const failed = save({ strict: true, mutate: install });
  const later = save();
  await assert.rejects(failed, /disk full/);
  await later;
  assert.equal(imageMeta.has("peer.png"), false);
  assert.deepEqual(published, [{}], "the later background save must see the rollback");
  await save({ strict: true, mutate: install });
  assert.deepEqual(published.at(-1), { "peer.png": { model: "Qwen", rights: "friend" } });
});

function sendFixture() {
  const smallPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", "base64");
  const refs = [smallPng, smallPng];
  const media = { output: Buffer.from("completed opaque png"), returned: null };
  const names = ["aiplay_frame_aaaaaaaaaaaa.png", "aiplay_frame_bbbbbbbbbbbb.png"];
  const modelFiles = { dit: "qwen-base.safetensors", encoder: "qwen-text.safetensors", vae: "qwen-vae.safetensors" };
  const fullOrder = makeImageJob({ prompt: "A dancer", seed: 42, width: 1024, height: 1024,
    now: 1_000_000, returnTo: { fp: "a".repeat(32), nickname: "Friend" },
    references: refs.map((data) => ({ data, mime: "image/png", safety: { minor: false, sexual: false } })) });
  const settings = fullOrder.job;
  const meta = {
    engine: settings.engine, seed: settings.seed, steps: settings.steps, cfg: settings.cfg,
    sampler: settings.sampler, scheduler: settings.scheduler, count: settings.count,
    requestedWidth: settings.width, requestedHeight: settings.height,
    refSizing: settings.refSizing, transparent: settings.transparent,
    dit: modelFiles.dit, encoder: modelFiles.encoder, vae: modelFiles.vae,
    refImages: [...names], outputSha256: hash(media.output),
  };
  const row = { jobType: "image", state: "queued", imageId: "i123abc",
    from: { fp: "a".repeat(32) }, stagedRefs: [...names],
    imageJob: compactImageJob(fullOrder) };
  const calls = { sealed: 0, record: null, wrote: 0 };
  const context = {
    action: "image_send_back", b: { id: row.imageJob.id }, res: {}, outDir: "out", appData: "app",
    collabImageReturnClaims: new Set(),
    IMAGE_DIR: "images", QWEN_IMAGE_FILES: modelFiles, config: { inputDir: "input" },
    Buffer, Date, String, Array, path, createHash, randomUUID,
    book: {
      findOrder: async () => row,
      transitionOrderState: async ({ from, to, patch = {} }) => {
        assert.equal(row.state, from);
        Object.assign(row, patch, { state: to });
        if (to === "rendered") calls.wrote++;
      },
    },
    readStoredImageJob,
    collabIdentity: async () => ({ fp: "b".repeat(32) }),
    collabRoster: { roster: async () => ({ peers: [{ fp: row.from.fp, verified: true,
      role: "lender", seal: "seal", sign: "sign", nickname: "Friend" }] }) },
    readFile: async (file) => {
      const name = path.basename(file);
      if (name === `${row.imageId}.png`) return media.output;
      if (name === row.imageReturnFile) {
        if (media.returned) return media.returned;
        const error = new Error("not found"); error.code = "ENOENT"; throw error;
      }
      const at = names.indexOf(name);
      if (at >= 0) return refs[at];
      throw new Error("unexpected read");
    },
    imageMeta: { get: () => meta },
    models: { status: async () => [{ id: "qwen-image-2.1", outputRights: { class: "reviewed" } }] },
    makeImageReturn: async ({ record }) => { calls.record = record; return { kind: "job-return" }; },
    collabPrivateKeys: async () => ({ signPrivate: "private" }),
    sealTo: () => { calls.sealed++; return Buffer.from("sealed"); },
    collabStamp: () => ({ app: "Studio", commit: null, protocol: 1 }),
    mkdir: async () => {}, writeFile: async () => {}, stat: async () => null,
    rename: async () => {}, unlink: async () => {},
    json: (_res, status, body) => ({ status, body }),
  };
  context.readSealed = async (file) => {
    try { return { blob: await context.readFile(file) }; }
    catch { return { error: "not found", reason: "no-such-file", status: 404 }; }
  };
  const run = () => vm.runInNewContext(`(async () => { ${sendRoute} })()`, context);
  return { refs, media, names, modelFiles, settings, meta, row, calls, run };
}

test("image return signs recorded Qwen settings, model files and ordered references only", async () => {
  const f = sendFixture();
  const result = await f.run();
  assert.equal(result.status, 200);
  assert.equal(result.body.state, "rendered");
  assert.equal(f.calls.sealed, 1);
  assert.equal(f.calls.wrote, 1);
  assert.match(f.row.imageReturnFile, /^image-return-o_[0-9a-f]{12}-[0-9a-f]{8}\.aiplay$/);
  assert.equal(f.row.imageReturnSha256, hash(Buffer.from("sealed")),
    "the intended signed bytes must be recoverable from the orderbook after a crash");
  assert.equal(f.calls.record.modelVersion, f.modelFiles.dit);
  assert.deepEqual(Array.from(f.calls.record.referenceSha256s), f.refs.map(hash));
  for (const key of ["seed", "steps", "cfg", "sampler", "scheduler", "count", "refSizing", "transparent"])
    assert.equal(f.calls.record[key], f.meta[key], key);
  assert.equal(f.calls.record.width, f.meta.requestedWidth);
  assert.equal(f.calls.record.height, f.meta.requestedHeight);
});

test("interrupted send-back recovers its exact published sealed file without resealing", async () => {
  const f = sendFixture();
  f.row.state = "returning";
  f.row.imageReturnFile = `image-return-${f.row.imageJob.id}-12345678.aiplay`;
  f.media.returned = Buffer.from("already sealed before restart");
  f.row.imageReturnSha256 = hash(f.media.returned);
  const result = await f.run();
  assert.equal(result.status, 200);
  assert.equal(result.body.file, path.join("out", "out", f.row.imageReturnFile));
  assert.equal(f.row.state, "rendered");
  assert.equal(f.calls.sealed, 0, "recovery may not invent different signed bytes");
});

test("interrupted send-back with no published file safely retries sealing", async () => {
  const f = sendFixture();
  f.row.state = "returning";
  f.row.imageReturnFile = `image-return-${f.row.imageJob.id}-12345678.aiplay`;
  f.row.imageReturnSha256 = hash(Buffer.from("unpublished sealed bytes"));
  const result = await f.run();
  assert.equal(result.status, 200);
  assert.equal(f.row.state, "rendered");
  assert.equal(f.calls.sealed, 1);
});

test("a mismatched actual render record refuses sealing for every reproducibility field", async () => {
  const changed = [
    ["seed", (f) => { f.meta.seed++; }],
    ["steps", (f) => { f.meta.steps++; }],
    ["CFG", (f) => { f.meta.cfg++; }],
    ["sampler", (f) => { f.meta.sampler = "dpmpp"; }],
    ["scheduler", (f) => { f.meta.scheduler = "karras"; }],
    ["count", (f) => { f.meta.count = 2; }],
    ["width", (f) => { f.meta.requestedWidth = 768; }],
    ["height", (f) => { f.meta.requestedHeight = 1344; }],
    ["ref sizing", (f) => { f.meta.refSizing = "reference"; }],
    ["transparency", (f) => { f.meta.transparent = true; }],
    ["DiT", (f) => { f.meta.dit = "other.safetensors"; }],
    ["encoder", (f) => { f.meta.encoder = "other.safetensors"; }],
    ["VAE", (f) => { f.meta.vae = "other.safetensors"; }],
    ["reference order", (f) => { f.meta.refImages.reverse(); }],
    ["reference count", (f) => { f.meta.refImages.pop(); }],
    ["source hash", (f) => { f.refs[0] = Buffer.from("changed after acceptance"); }],
  ];
  for (const [label, mutate] of changed) {
    const f = sendFixture(); mutate(f);
    const result = await f.run();
    assert.equal(result.status, 409, label);
    assert.equal(result.body.reason, "render-record-mismatch", label);
    assert.equal(f.calls.sealed, 0, label);
    assert.equal(f.calls.wrote, 0, label);
  }
});

test("the returned PNG must still match the bytes recorded after rendering", async () => {
  for (const [label, mutate] of [
    ["replaced output", (f) => { f.media.output = Buffer.from("a different opaque png"); }],
    ["missing digest", (f) => { delete f.meta.outputSha256; }],
  ]) {
    const f = sendFixture(); mutate(f);
    const result = await f.run();
    assert.equal(result.status, 409, label);
    assert.equal(result.body.reason, "render-output-changed", label);
    assert.equal(f.calls.sealed, 0, label);
    assert.equal(f.calls.wrote, 0, label);
  }
});

test("private peer PNG stripping fails closed on an error or skipped file", async () => {
  const begin = artSource.indexOf("if (job.private) {", artSource.indexOf("const move = async (list, suffix) => {"));
  const end = artSource.indexOf("names.push(name);", begin);
  assert.ok(begin > 0 && end > begin, "extract the actual PNG landing privacy branch");
  const stripBranch = artSource.slice(begin, end);
  const output = Buffer.from("stripped PNG bytes");
  const run = (stripPngText) => {
    const job = { private: true, collabImageBase: true, _imageOptions: {} };
    let reads = 0;
    const result = vm.runInNewContext(`(async () => { ${stripBranch} })()`, {
      job, landed: "image.png", name: "image.png", suffix: "", createHash,
      stripPngText, readFile: async () => { reads++; return output; }, console,
    });
    return { job, result, reads: () => reads };
  };
  const failed = run(async () => { throw new Error("strip failed"); });
  await assert.rejects(failed.result, /strip failed/);
  assert.equal(failed.reads(), 0, "an unstripped PNG must not acquire a trusted digest");
  const skipped = run(async () => ({ skipped: true }));
  await assert.rejects(skipped.result, /not a PNG whose metadata could be stripped/);
  assert.equal(skipped.reads(), 0);
  const passed = run(async () => ({ skipped: false }));
  await assert.doesNotReject(passed.result);
  assert.equal(passed.job._imageOptions.outputSha256, hash(output));
  assert.equal(passed.reads(), 1);
});
