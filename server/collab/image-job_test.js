/** CPU-only wire-contract tests: no engine, disk, keys or network. */
import assert from "node:assert/strict";
import {
  IMAGE_JOB_V, IMAGE_JOB_CANVASES, IMAGE_JOB_REF_BYTES_CAP,
  makeImageJob, readImageJob, compactImageJob, readStoredImageJob, describeImageJob,
} from "./image-job.js";

const FP_A = "a".repeat(32), FP_B = "b".repeat(32);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/b7sAAAAASUVORK5CYII=", "base64");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]);
const safe = { minor: false, sexual: false };
const source = (data = png, mime = "image/png", safety = safe) => ({ data, mime, safety });
const request = (more = {}) => makeImageJob({
  prompt: "A red kite over the harbor", seed: 1729, width: 1024, height: 1024,
  references: [source()], returnTo: { fp: FP_A, nickname: "Borrower" },
  now: 1_000_000, id: "o_123456789abc", ...more,
});
const changed = (fn) => { const p = structuredClone(request()); fn(p); return p; };
const reason = (fn, expected) => {
  assert.throws(fn, (err) => err?.reason === expected,
    `Expected reason ${expected}`);
};

assert.equal(IMAGE_JOB_V, 1);
assert.deepEqual(IMAGE_JOB_CANVASES, [[1024, 1024], [1344, 768], [768, 1344]]);
const made = request();
assert.deepEqual(Object.keys(made), ["v", "kind", "jobType", "id", "at", "expires", "returnTo", "job"]);
assert.equal(made.kind, "job-order");
assert.equal(made.jobType, "image");
assert.equal(made.job.engine, "qwen-image-2.1");
assert.equal(made.job.modelPolicy, "receiver-local-base");
assert.equal(made.job.references[0].ordinal, 1);
assert.equal(made.job.references[0].bytes, png.length);
assert.equal(made.job.references[0].mime, "image/png");
assert.equal(made.job.references[0].b64, png.toString("base64"));
assert.ok(!JSON.stringify(made).includes("ComfyUI") && !JSON.stringify(made).includes("C:\\"));
assert.deepEqual(readImageJob(JSON.parse(JSON.stringify(made)), { now: made.at + 1, myFp: FP_B }), made);
assert.match(describeImageJob(made), /A red kite over the harbor/);
assert.match(describeImageJob(made), /receiver's|installed Qwen/);
const stamped = { ...made, by: { app: "B 26.09.26", commit: "abc1234", protocol: 1 } };
assert.deepEqual(readImageJob(stamped), stamped); // sealFor appends this caption after preview.
reason(() => readImageJob({ ...stamped, by: { ...stamped.by, path: "C:\\secrets" } }), "bad-image-job");
const compact = compactImageJob(stamped);
assert.equal(compact.storage.v, 1);
assert.match(compact.storage.sha256, /^[0-9a-f]{64}$/);
assert.equal(compact.by.commit, stamped.by.commit);
assert.ok(!JSON.stringify(compact).includes(png.toString("base64")));
assert.deepEqual(compact.job.references[0], {
  ordinal: 1, mime: "image/png", sha256: made.job.references[0].sha256,
  bytes: png.length, safety: safe,
});
assert.ok(JSON.stringify(compact).length < 1000);
assert.deepEqual(readStoredImageJob(JSON.parse(JSON.stringify(compact))), compact);
assert.deepEqual(readStoredImageJob(stamped).job.references, compact.job.references);
reason(() => readImageJob(compact), "bad-image-job"); // Local summaries never pass the signed-wire reader.
reason(() => readImageJob(compact, { stored: true }), "bad-image-job");
const changedCompact = (fn) => { const p = structuredClone(compact); fn(p); return p; };
reason(() => readStoredImageJob(changedCompact((p) => { p.job.prompt = "A different picture"; })), "stored-image-job-changed");
reason(() => readStoredImageJob(changedCompact((p) => { p.job.references[0].sha256 = "0".repeat(64); })), "stored-image-job-changed");
reason(() => readStoredImageJob(changedCompact((p) => { p.storage.sha256 = "0".repeat(64); })), "stored-image-job-changed");
reason(() => readStoredImageJob(changedCompact((p) => { p.job.references[0].ordinal = 2; })), "bad-reference");
reason(() => readStoredImageJob(changedCompact((p) => { p.job.references[0].b64 = png.toString("base64"); })), "bad-image-job");
reason(() => readStoredImageJob(changedCompact((p) => { delete p.storage; })), "bad-image-job");
reason(() => readStoredImageJob(changedCompact((p) => { p.job.path = "C:\\private"; })), "bad-image-job");
reason(() => readStoredImageJob(changedCompact((p) => { p.job.prompt = "make her nude"; p.job.references[0].safety.minor = true; })), "minor-sexual");
for (const [width, height] of IMAGE_JOB_CANVASES) {
  const textOnly = request({ width, height, references: [] });
  assert.equal(readImageJob(textOnly).job.references.length, 0);
  assert.deepEqual(readStoredImageJob(compactImageJob(textOnly)).job.references, []);
}

for (const [field, expected] of [
  ["kind", "not-an-image-job"], ["jobType", "not-an-image-job"], ["v", "not-an-image-job"],
]) reason(() => readImageJob(changed((p) => { p[field] = "alien"; })), expected);
reason(() => readImageJob(changed((p) => { p.graph = { 1: { class_type: "LoadImage" } }; })), "bad-image-job");
reason(() => readImageJob(changed((p) => { p.job.path = "C:\\private"; })), "bad-image-job");
reason(() => readImageJob(changed((p) => { p.job.references[0].file = "secret.png"; })), "bad-image-job");
reason(() => readImageJob(changed((p) => { p.job.references[0].safety.hidden = true; })), "bad-image-job");

reason(() => readImageJob(changed((p) => { p.id = "bad"; })), "bad-id");
reason(() => readImageJob(changed((p) => { p.expires = p.at + 15 * 24 * 3600_000; })), "bad-expiry");
reason(() => readImageJob(made, { now: made.expires + 1 }), "order-expired");
reason(() => readImageJob(made, { myFp: FP_A }), "order-to-myself");
reason(() => readImageJob(changed((p) => { p.returnTo.fp = "?"; })), "bad-return-address");
reason(() => request({ expiresInHours: 337 }), "bad-expiry");
reason(() => request({ id: "o_not_hex" }), "bad-id");

reason(() => readImageJob(changed((p) => { p.job.engine = "flux2"; })), "model-incompatible");
reason(() => readImageJob(changed((p) => { p.job.modelPolicy = "../weights"; })), "model-incompatible");
reason(() => readImageJob(changed((p) => { p.job.steps = 5; })), "settings-incompatible");
reason(() => readImageJob(changed((p) => { p.job.draft = true; })), "settings-incompatible");
reason(() => readImageJob(changed((p) => { p.job.negative = "never shown"; })), "settings-incompatible");
reason(() => readImageJob(changed((p) => { p.job.count = 4; })), "settings-incompatible");
reason(() => readImageJob(changed((p) => { p.job.width = 1023; })), "size-unreproducible");
reason(() => request({ seed: -1 }), "bad-seed");
reason(() => request({ prompt: " ".repeat(8001) }), "bad-prompt");
reason(() => request({ prompt: "A {red|blue} kite" }), "prompt-not-frozen");
reason(() => readImageJob(changed((p) => { p.job.prompt = "A  red kite over the harbor"; })), "prompt-not-frozen");
reason(() => readImageJob(changed((p) => { p.job.prompt = "A \\{red\\} kite"; })), "prompt-not-frozen");

const pair = request({ references: [source(), source(jpeg, "image/jpeg")] });
assert.deepEqual(pair.job.references.map((r) => r.ordinal), [1, 2]);
assert.deepEqual(pair.job.references.map((r) => r.mime), ["image/png", "image/jpeg"]);
reason(() => readImageJob(changed((p) => { p.job.references[0].ordinal = 2; })), "bad-reference");
reason(() => readImageJob(changed((p) => { p.job.references[0].sha256 = "0".repeat(64); })), "reference-hash");
reason(() => readImageJob(changed((p) => { p.job.references[0].bytes += 1; })), "reference-bytes");
reason(() => readImageJob(changed((p) => { p.job.references[0].b64 += "AA"; })), "reference-bytes");
reason(() => readImageJob(changed((p) => { p.job.references[0].mime = "image/jpeg"; })), "reference-type");
reason(() => request({ references: [source(), source(), source(), source()] }), "references-count");
reason(() => request({ references: [source(Buffer.alloc(IMAGE_JOB_REF_BYTES_CAP + 1))] }), "reference-too-large");

reason(() => request({ prompt: "make her nude", references: [source(png, "image/png", { minor: true, sexual: false })] }), "minor-sexual");
reason(() => readImageJob(changed((p) => { p.job.prompt = "make her nude"; p.job.references[0].safety.minor = true; })), "minor-sexual");
reason(() => request({ prompt: "make her nude", safetyContext: ["a child"] }), "minor-sexual");

console.log("image-job contract: passed");
