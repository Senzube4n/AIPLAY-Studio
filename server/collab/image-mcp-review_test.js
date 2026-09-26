import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { collabTools } from "../mcp-collab.js";

const from = "a".repeat(32);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/b7sAAAAASUVORK5CYII=", "base64");
const sha256 = createHash("sha256").update(png).digest("hex");
const file = `peer_${from}_o_0123456789ab_${sha256}.png`;
const response = { ok: true, from, file, mime: "image/png", sha256, b64: png.toString("base64") };
const toolFor = (api) => collabTools(api, (value) => value).find((tool) => tool.name === "collab_image_review_return");

test("MCP review returns a checked quarantined PNG as native image content, without text base64", async () => {
  const calls = [];
  const tool = toolFor(async (...args) => { calls.push(args); return response; });
  assert.ok(tool, "typed review tool is registered");
  assert.deepEqual(tool.inputSchema.required, ["from", "file"]);
  assert.match(tool.description, /read-only/);
  const got = await tool.run({ from, file });
  assert.deepEqual(calls, [["POST", "/api/collab", { action: "image_review_return", from, file }]]);
  assert.deepEqual(got._images, [{ data: response.b64, mimeType: "image/png" }]);
  assert.equal(got.b64, undefined);
  assert.deepEqual({ ...got, _images: undefined }, { ok: true, from, file, mime: "image/png", sha256, _images: undefined });
  assert.ok(!JSON.stringify({ ...got, _images: undefined }).includes(response.b64));
});

test("MCP review rejects mismatched identity, MIME, hash and noncanonical bytes before display", async () => {
  for (const bad of [
    { from: "b".repeat(32) },
    { file: "other.png" },
    { mime: "image/svg+xml" },
    { sha256: "0".repeat(64) },
    { b64: response.b64 + "\n" },
    { b64: Buffer.from("not a PNG").toString("base64"), sha256: createHash("sha256").update("not a PNG").digest("hex") },
  ]) {
    const tool = toolFor(async () => ({ ...response, ...bad }));
    await assert.rejects(tool.run({ from, file }), /checked image review/, JSON.stringify(bad));
  }
  const tool = toolFor(async () => ({ error: "Image has not passed quarantine checks" }));
  await assert.rejects(tool.run({ from, file }), /has not passed quarantine checks/);
});

test("MCP job review exposes the HTTP 409 consent card and native reference picture", async () => {
  const reviewDigest = "d".repeat(64);
  const reference = { ordinal: 1, mime: "image/png", bytes: png.length, sha256 };
  const refusal = { reason: "not-seen", error: "Review this image job first", reviewDigest,
    imageJob: { id: "o_0123456789ab", job: { prompt: "A pink-haired dancer", references: [reference] } },
    pictures: [{ ...reference, dataUrl: `data:image/png;base64,${png.toString("base64")}` }] };
  const api = async () => { throw new Error(refusal.error, { cause: { status: 409, refusal } }); };
  const tool = collabTools(api, (value) => value).find((entry) => entry.name === "collab_image_accept");
  const got = await tool.run({ file: "incoming.aiplay", seen: false });
  assert.equal(got.reviewDigest, reviewDigest);
  assert.equal(got.imageJob.job.prompt, "A pink-haired dancer");
  assert.deepEqual(got.pictures, [reference]);
  assert.deepEqual(got._images, [{ data: png.toString("base64"), mimeType: "image/png" }]);
  assert.ok(!JSON.stringify({ ...got, _images: undefined }).includes(png.toString("base64")),
    "private reference bytes must not be duplicated in the text response");
});

test("MCP job review rejects altered reference bytes and does not swallow other 409 refusals", async () => {
  const reference = { ordinal: 1, mime: "image/png", bytes: png.length, sha256 };
  const base = { reason: "not-seen", reviewDigest: "d".repeat(64),
    imageJob: { job: { references: [reference] } },
    pictures: [{ ...reference, dataUrl: `data:image/png;base64,${png.toString("base64")}` }] };
  const toolForReview = (refusal) => collabTools(async () => {
    throw new Error("HTTP 409", { cause: { status: 409, refusal } });
  }, (value) => value).find((entry) => entry.name === "collab_image_accept");
  await assert.rejects(toolForReview({ ...base, pictures: [{ ...base.pictures[0], sha256: "0".repeat(64) }] })
    .run({ file: "incoming.aiplay", seen: false }), /disagrees with the signed image job review/);
  await assert.rejects(toolForReview({ reason: "review-changed", error: "File changed" })
    .run({ file: "incoming.aiplay", seen: false }), /HTTP 409/);
});
