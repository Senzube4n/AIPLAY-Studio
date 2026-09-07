import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createMusicInputRoutes } from "../server/music-input.js";

const temp = await mkdtemp(path.join(os.tmpdir(), "aiplay-music-input-http-"));
let enqueued = 0, consumed = 0;
const route = createMusicInputRoutes({
  json: (res, status, body) => Object.assign(res, { status, body }),
  config: { inputDir: temp, outputDir: temp, comfyDir: temp, musicInput: { enabled: false } },
  jobs: { current: null, queue: [], history: [], on() {},
    enqueue() { enqueued++; throw Error("Must not enqueue in HTTP guard test"); }, cancelById() {} },
  provenance: { actorFrom: () => "agent:test" },
});
async function request(headers, body = { action: "status", job_id: "unknown" }, socket) {
  const res = {};
  const req = { method: "POST", socket, headers: { host: "127.0.0.1:4184", "content-type": "application/json", ...headers },
    async *[Symbol.asyncIterator]() { consumed++; yield Buffer.from(JSON.stringify(body)); } };
  await route(req, res, new URL("http://127.0.0.1:4184/api/music-input"));
  return res;
}
try {
  assert.equal((await request({ origin: "https://untrusted.example", "content-type": "text/plain" }, { action: "prepare", source: { path: "C:/guessed.wav" } })).status, 403);
  assert.equal((await request({ origin: "http://127.0.0.1:4173" })).status, 403, "Other local ports are different origins");
  assert.equal((await request({ "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await request({ origin: "null" })).status, 403);
  assert.equal((await request({ origin: "" })).status, 403);
  assert.equal((await request({ origin: "http://127.0.0.1:4184/extra" })).status, 403);
  assert.equal((await request({ origin: "http://user@127.0.0.1:4184" })).status, 403);
  assert.equal((await request({ host: "user@127.0.0.1:4184", origin: "http://127.0.0.1:4184" })).status, 403);
  assert.equal((await request({ host: "127.0.0.1:4184/extra" })).status, 403);
  assert.equal((await request({}, undefined, { localPort: 4173 })).status, 403);
  assert.equal((await request({ origin: "http://untrusted.example:4184", host: "untrusted.example:4184" })).status, 403);
  assert.equal((await request({ "content-type": "text/plain" })).status, 415);
  assert.equal((await request({ "content-length": String(80*1024*1024) })).status, 413);
  assert.equal(consumed, 0, "Every rejected request stops before source/body processing");
  assert.equal(enqueued, 0);
  assert.equal((await request({ origin: "http://127.0.0.1:4184", "sec-fetch-site": "same-origin" })).status, 404,
    "The same-origin JSON request reaches the normal unknown-job check");
  assert.equal((await request({ "x-aiplay-actor": "agent:test" })).status, 404,
    "Origin-free MCP JSON reaches the normal route");
  assert.equal(consumed, 2);
  console.log("Music-input HTTP guards passed: foreign/opaque origins, cross-site requests, wrong type and oversize bodies rejected before processing; same-origin and MCP JSON accepted.");
} finally {
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(temp, { recursive: true, force: true });
}
