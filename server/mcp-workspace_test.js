/** CPU-only contract tests: mocked API, no server, files, peer changes or GPU. */
import test from "node:test";
import assert from "node:assert/strict";
import { workspaceTools, studioApiPath } from "./mcp-workspace.js";
import { mkdtemp, mkdir, open, writeFile, unlink, rmdir } from "node:fs/promises";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { collabTools } from "./mcp-collab.js";
import { modelTools } from "./mcp-models.js";
import { TOOLS } from "./mcp.js";
import { adaptTool, ROUTABLE, WITHHELD, index } from "./chat/router.js";

function fixture() {
  const calls = [];
  const api = async (method, path, body, timeout, media) => { calls.push({ method, path, body, ...(media ? { media } : {}) }); return { ok: true, marker: "same-api" }; };
  const safeName = (value) => {
    if (typeof value !== "string" || !value || /\.\.|[/\\]/.test(value)) throw new Error("Bad library name");
    return value;
  };
  const tools = [...workspaceTools(api, safeName), ...collabTools(api, safeName), ...modelTools(api)];
  return { calls, tools, tool: (name) => tools.find(t => t.name === name) };
}

test("every new workflow tool is registered once and classified for local chat", () => {
  for (const t of fixture().tools) {
    assert.equal(TOOLS.filter(x => x.name === t.name).length, 1, t.name);
    /* Classified: routable with a gate, or withheld with a reason (the trust grant, a friend's role and
     * their minutes a day are a person's on the Collab screen: chat/router.js WITHHELD). */
    if (!["download_model", "cancel_download", "studio_api_request"].includes(t.name)) {
      assert.ok(t.name in ROUTABLE || typeof WITHHELD[t.name] === "string", t.name);
    }
  }
});

test("readiness and catalogue tools use their panels' routes without generation", async () => {
  const f = fixture();
  for (const name of ["qwen_image_status", "image_capabilities", "reactive_status", "training_status", "list_trained_loras", "model_inventory"]) await f.tool(name).run({});
  assert.deepEqual(f.calls.map(c => [c.method, c.path, c.body?.action]), [
    ["GET", "/api/images/qwen-status", undefined], ["GET", "/api/images/capabilities", undefined],
    ["GET", "/api/reactive/status", undefined], ["POST", "/api/train", "status"],
    ["POST", "/api/train", "list"], ["GET", "/api/models", undefined],
  ]);
});

test("AI edit forwards source/selection/all generation dials without mutating them", async () => {
  const f = fixture();
  const a = { documentId: "doc1", mode: "inpaint", prompt: "blue hat", refImages: ["look.png"], selection: { kind: "rect", x: 3, y: 4, width: 20, height: 15 }, seed: 0, steps: 25, cfg: 1, refResolution: 0, transparent: false, dit: "native.safetensors", encoder: "vl.safetensors", vae: "vae.safetensors" };
  const before = structuredClone(a);
  assert.deepEqual(await f.tool("image_ai_edit_create").run(a), { ok: true, marker: "same-api" });
  assert.deepEqual(f.calls[0], { method: "POST", path: "/api/images/ai-edit", body: { action: "create", ...a, source: undefined } });
  assert.deepEqual(a, before);
});

test("AI masked reference cap counts target plus generated mask and refuses before API", async () => {
  const f = fixture(), refs = Array.from({ length: 9 }, (_, i) => `${i}.png`);
  await assert.rejects(f.tool("image_ai_edit_create").run({ source: "source.png", mode: "inpaint", prompt: "fix", refImages: refs }), /eight extra references/);
  assert.equal(f.calls.length, 0);
  await f.tool("image_ai_edit_create").run({ source: "source.png", mode: "edit", prompt: "fix", refImages: refs });
  assert.equal(f.calls[0].body.refImages.length, 9);
  await assert.rejects(f.tool("image_ai_edit_create").run({ source: "../escape.png", mode: "edit", prompt: "fix" }), /Bad library name/);
});

test("candidate review actions remain distinct and preserve the job id", async () => {
  const f = fixture();
  for (const action of ["status", "accept", "undo", "discard"]) await f.tool(`image_ai_edit_${action}`).run({ id: "job-A" });
  assert.deepEqual(f.calls.map(c => c.body), ["status", "accept", "undo", "discard"].map(action => ({ action, id: "job-A" })));
  assert.ok(f.calls.every(c => c.path === "/api/images/ai-edit"));
});

test("verification never defaults to a grant or infers a completed word check", async () => {
  const f = fixture(), t = f.tool("collab_verify");
  await assert.rejects(t.run({ fp: "peer" }), /explicitly/);
  await assert.rejects(t.run({ fp: "peer", verified: true }), /word check/);
  assert.equal(f.calls.length, 0);
  await t.run({ fp: "peer", verified: false });
  await t.run({ fp: "peer", verified: true, words_matched: true });
  assert.deepEqual(f.calls.map(c => c.body), [false, true].map(verified => ({ action: "verify_peer", fp: "peer", verified })));
});

test("acceptance and adoption keep review and busy/mismatch overrides explicit", async () => {
  const f = fixture();
  await f.tool("collab_accept").run({ file: "order.aiplay", seen: false });
  await f.tool("collab_accept").run({ file: "order.aiplay", seen: true, anyway: true });
  await f.tool("collab_adopt").run({ from: "peer", file: "take.mp4" });
  assert.deepEqual(f.calls.map(c => c.body), [
    { action: "accept", file: "order.aiplay", seen: false, anyway: false },
    { action: "accept", file: "order.aiplay", seen: true, anyway: true },
    { action: "adopt", from: "peer", file: "take.mp4", anyway: false },
  ]);
});

test("planning preserves optimistic revision, clearing values and measured allocation inputs", async () => {
  const f = fixture();
  await f.tool("collab_plan").run({ action: "get", slug: "episode 1" });
  assert.equal(f.calls[0].path, "/api/collab/plan?slug=episode%201");
  const data = { action: "allocate", slug: "episode", expectedRevision: 0, segmentIds: ["s1"], peerIds: ["peer"], policy: "time", capability: "videoH3", minVramMb: 6000, minutesPerTenSeconds: { peer: 7.5 } };
  await f.tool("collab_plan").run(data);
  for (const [key, value] of Object.entries(data)) assert.deepEqual(f.calls[1].body[key], value, key);
  await f.tool("collab_plan").run({ action: "update_shot", slug: "episode", expectedRevision: 1, segmentId: "s1", owner: null, dependsOn: null, pinned: false });
  assert.equal(f.calls[2].body.owner, null); assert.equal(f.calls[2].body.dependsOn, null); assert.equal(f.calls[2].body.pinned, false);
});

test("model scan/use/override share validated API and do not download implicitly", async () => {
  const f = fixture();
  await f.tool("models_folder").run({ action: "scan", dir: "D:\\Models" });
  await f.tool("models_folder").run({ action: "use", dir: "D:\\Models", force: false });
  await f.tool("model_override").run({ file: "native.safetensors", use: null });
  assert.deepEqual(f.calls.map(c => c.body), [{ action: "scanFolder", dir: "D:\\Models" }, { action: "setModelsDir", dir: "D:\\Models", force: false }, { action: "override", file: "native.safetensors", use: null }]);
});

test("local chat JSON bridge actually forwards editor masks, reference arrays and Reactive dials", async () => {
  const f = fixture(), tool = adaptTool(f.tool("image_ai_edit_create"), "gpu");
  assert.equal(tool.args.selection.type, "string"); assert.equal(tool.args.refImages.type, "string");
  await tool.run({ source: "source.png", mode: "inpaint", prompt: "fix", selection: '{"kind":"rect"}', refImages: '["look.png"]' });
  assert.deepEqual(f.calls[0].body.selection, { kind: "rect" }); assert.deepEqual(f.calls[0].body.refImages, ["look.png"]);
  assert.throws(() => tool.run({ selection: "invalid" }), /valid JSON/);
  assert.throws(() => tool.run({ refImages: '{}' }), /decode to array/);
  const reactive = index().find(x => x.tool.name === "reactive_render")?.tool;
  assert.equal(reactive?.args.motion?.type, "string"); assert.equal(reactive?.args.pictures?.type, "string");
  assert.ok(index().some(x => x.tool.name === "collab_set_resources"));
});

test("API refusals propagate; no permission or stale-document refusal is swallowed", async () => {
  const deny = async () => { throw new Error("not-verified or stale revision"); };
  const c = collabTools(deny, x => x), w = workspaceTools(deny, x => x);
  await assert.rejects(c.find(t => t.name === "collab_accept").run({ file: "order", seen: true }), /not-verified/);
  await assert.rejects(w.find(t => t.name === "image_ai_edit_accept").run({ id: "candidate" }), /stale revision/);
});

test("generic API fallback is local-only with explicit methods and bounded JSON", async () => {
  for (const p of ["http://example.com/api/status", "//example.com/api/status", "/api/../secrets", "/api/%2e%2e/secrets", "/api/%252e%252e/secrets", "/api/\\evil", "/api/status#fragment", "/api/%00bad"]) assert.throws(() => studioApiPath(p), /local|traversal/);
  assert.equal(studioApiPath("/api/status?query=a%20b"), "/api/status?query=a%20b");
  const f = fixture(), t = f.tool("studio_api_request");
  await assert.rejects(t.run({ method: "CONNECT", path: "/api/status" }), /method/);
  await assert.rejects(t.run({ method: "GET", path: "/api/status", body: {} }), /GET/);
  await assert.rejects(t.run({ method: "POST", path: "/api/status", body: { x: "x".repeat(2 * 1024 * 1024) } }), /2 MiB/);
  assert.equal(f.calls.length, 0);
  await t.run({ method: "POST", path: "/api/music", body: { action: "engine", engine: "yue2-comfy" } });
  assert.equal(f.calls[0].path, "/api/music"); assert.equal(f.calls[0].body.engine, "yue2-comfy");
  assert.ok(!index().some(x => x.tool.name === "studio_api_request"));
});

test("local media import forwards bytes and MIME, refuses URLs/directories/unsupported types", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiplay-mcp-media-"));
  const image = path.join(dir, "my picture.png"), bad = path.join(dir, "notes.txt");
  const oversized = path.join(dir, "large.png"), directory = path.join(dir, "directory.png");
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  try {
    await writeFile(image, bytes); await writeFile(bad, "not an image"); await mkdir(directory);
    const large = await open(oversized, "w"); await large.truncate(40 * 1024 * 1024 + 1); await large.close();
    const f = fixture(), t = f.tool("import_local_media");
    await assert.rejects(t.run({ path: "https://example.com/photo.png" }), /local/);
    await assert.rejects(t.run({ path: bad }), /extension/);
    await assert.rejects(t.run({ path: image, destination: "audio_reference" }), /Audio references/);
    await assert.rejects(t.run({ path: directory }), /regular file/);
    await assert.rejects(t.run({ path: oversized }), /40 MiB/);
    assert.equal(f.calls.length, 0);
    await t.run({ path: image });
    assert.equal(f.calls[0].path, "/api/frame"); assert.deepEqual(f.calls[0].body, bytes);
    assert.deepEqual(f.calls[0].media, { contentType: "image/png", name: "my picture.png" });
    await t.run({ path: image, destination: "studio" }); assert.equal(f.calls[1].path, "/api/studio/import");
  } finally { await unlink(image); await unlink(bad); await unlink(oversized); await rmdir(directory); await rmdir(dir); }
});

test("API reference search is bounded and does not execute examples", async () => {
  const f = fixture(), t = f.tool("studio_api_reference");
  assert.ok((await t.run({})).sections.length > 10);
  const hit = await t.run({ query: "YuE2", maxChars: 1000 });
  assert.ok(hit.matchedSections > 0); assert.equal(hit.text.length, 1000); assert.equal(hit.truncated, true);
  assert.equal(f.calls.length, 0);
});

test("stdio transport preserves binary bytes/MIME and forced agent identity on fallback and uploads", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiplay-mcp-wire-"));
  const file = path.join(dir, "source image.png"), bytes = Buffer.from([137, 80, 78, 71, 0, 255, 6]);
  await writeFile(file, bytes);
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    requests.push({ method: req.method, path: req.url, headers: req.headers, bytes: Buffer.concat(chunks) });
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true, name: "mock-frame.png" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const proc = spawn(process.execPath, [fileURLToPath(new URL("./mcp.js", import.meta.url))], {
    env: { ...process.env, AIPLAY_URL: `http://127.0.0.1:${server.address().port}`, AIPLAY_AGENT: "user" }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const replies = new Map(); let buffer = "", serial = 0;
  proc.stdout.on("data", chunk => { buffer += chunk; let cut; while ((cut = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1);
    try { const r = JSON.parse(line); replies.get(r.id)?.(r); } catch { /* only JSON-RPC replies are relevant */ }
  } });
  const call = (name, args) => new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => reject(new Error("MCP fixture timed out")), 10000);
    replies.set(id, reply => { clearTimeout(timer); replies.delete(id); resolve(reply); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
  try {
    const a = await call("studio_api_request", { method: "POST", path: "/api/models", body: { action: "scanFolder", dir: "mock" } });
    const b = await call("import_local_media", { path: file });
    assert.ok(!a.error && !a.result?.isError); assert.ok(!b.error && !b.result?.isError);
    // The existing Video Workflow catalogue also reads /api/mv/previz at startup.
    const posts = requests.filter(r => r.method === "POST");
    assert.equal(posts.length, 2); assert.ok(posts.every(r => r.headers["x-aiplay-actor"] === "agent:user"));
    assert.equal(posts[0].headers["content-type"], "application/json");
    assert.equal(JSON.parse(posts[0].bytes.toString()).action, "scanFolder");
    assert.equal(posts[1].path, "/api/frame"); assert.equal(posts[1].headers["content-type"], "image/png");
    assert.equal(posts[1].headers["x-name"], "source%20image.png"); assert.deepEqual(posts[1].bytes, bytes);
  } finally { proc.kill(); await new Promise(resolve => server.close(resolve)); await unlink(file); await rmdir(dir); }
});
