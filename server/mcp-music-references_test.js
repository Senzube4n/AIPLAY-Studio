import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { musicReferenceTools } from "./mcp-music-references.js";
import { workspaceTools } from "./mcp-workspace.js";

test("reference tools expose distinct GPU actions and forward only to the shared API", async () => {
  const calls = [], tools = musicReferenceTools(async (...args) => { calls.push(args); return { ok: true }; });
  assert.equal(tools.length, 9); assert.equal(new Set(tools.map(t => t.name)).size, 9);
  assert.ok(tools.find(t => t.name === "music_reference_analyze_visual"));
  assert.ok(tools.find(t => t.name === "music_reference_transcribe"));
  const values = { referenceId: "mr_fixture", expectedRevision: 2, reviewed: true,
    kind: "video", file: "clip.mp4", location: "clips", startSeconds: 0, seconds: 8, maxFrames: 4,
    preview: false, model: "qwen3vl_4b.safetensors", mode: "melody", abc: "score",
    brief: { style: "Piano", lyrics: "", notes: "Reviewed" }, engine: "yue2-gguf", cot: "full",
    seed: 0, useScore: false, instrumental: false, allowSectionLabels: false };
  const actions = ["capabilities", "list", "prepare", "get", "analyze_visual", "transcribe", "update_brief", "update_score", "prepare_request"];
  for (const tool of tools) {
    const args = Object.fromEntries(Object.keys(tool.inputSchema.properties).map(key => [key, values[key]]));
    await tool.run({ ...args, action: "wrong_action", unexpected: "not forwarded" });
    const [method, url, body] = calls.at(-1); assert.equal(method, "POST"); assert.equal(url, "/api/music-references");
    assert.deepEqual(body, { action: actions[tools.indexOf(tool)], ...args });
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
});

test("MCP preserves explicit region, review, instrumental and native backend choices", async () => {
  let body; const tools = musicReferenceTools(async (_m, _p, b) => { body = b; return b; });
  await tools.find(t => t.name === "music_reference_prepare").run({ kind: "video", file: "clip.mp4", startSeconds: 12.5, seconds: 8, maxFrames: 4 });
  assert.equal(body.startSeconds, 12.5); assert.equal(body.maxFrames, 4);
  await tools.find(t => t.name === "music_reference_prepare").run({ kind: "audio", location: "clips", file: "import_voice.wav" });
  assert.equal(body.location, "clips"); assert.equal(body.kind, "audio");
  await tools.find(t => t.name === "music_reference_prepare_request").run({ referenceId: "mr_fixture", expectedRevision: 4, reviewed: true, engine: "yue2-gguf", seed: 0, instrumental: false, useScore: true });
  assert.equal(body.seed, 0); assert.equal(body.instrumental, false); assert.equal(body.useScore, true); assert.equal(body.engine, "yue2-gguf");
});

test("omitted optional arguments stay omitted and partial brief edits retain empty lyrics", async () => {
  let body; const tools = musicReferenceTools(async (_m, _p, b) => { body = b; return b; });
  await tools.find(t => t.name === "music_reference_prepare").run({ kind: "audio", file: "song.wav" });
  assert.deepEqual(body, { action: "prepare", kind: "audio", file: "song.wav" });
  await tools.find(t => t.name === "music_reference_prepare_request").run({ referenceId: "mr_fixture", expectedRevision: 0, reviewed: true });
  assert.deepEqual(body, { action: "prepare_request", referenceId: "mr_fixture", expectedRevision: 0, reviewed: true });
  await tools.find(t => t.name === "music_reference_update_brief").run({ referenceId: "mr_fixture", expectedRevision: 0, brief: { lyrics: "", unsupported: "not forwarded" } });
  assert.deepEqual(body, { action: "update_brief", referenceId: "mr_fixture", expectedRevision: 0, brief: { lyrics: "" } });
});

test("MCP imports local audio into the clip bin and prepares that returned name", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "music-reference-mcp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "my voice.wav");
  await writeFile(source, Buffer.from("RIFF0000WAVEaudio"));
  const calls = [];
  const api = async (method, route, body, _timeout, media) => {
    calls.push({ method, route, body, media });
    return route === "/api/studio/import" ? { ok: true, name: "import_my_voice_123.wav", kind: "audio" } : { ok: true };
  };
  const imported = await workspaceTools(api, x => x).find(x => x.name === "import_local_media")
    .run({ path: source, destination: "studio" });
  await musicReferenceTools(api).find(x => x.name === "music_reference_prepare")
    .run({ kind: "audio", location: "clips", file: imported.name, seconds: 12 });
  assert.equal(calls[0].route, "/api/studio/import");
  assert.deepEqual(calls[0].body, Buffer.from("RIFF0000WAVEaudio"));
  assert.deepEqual(calls[1].body, { action: "prepare", kind: "audio", location: "clips", file: imported.name, seconds: 12 });
});
