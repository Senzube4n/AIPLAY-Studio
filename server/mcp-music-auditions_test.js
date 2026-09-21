import test from "node:test";
import assert from "node:assert/strict";
import { musicAuditionTools } from "./mcp-music-auditions.js";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
test("all audition operations have typed schemas and share the HTTP API", async () => {
  const calls = []; const tools = musicAuditionTools(async (...args) => { calls.push(args); return { ok: true }; });
  assert.equal(new Set(tools.map(t => t.name)).size, 6);
  for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false);
  await tools.find(t => t.name === "music_audition_create").run({ source: "song.flac", from_seconds: 10, to_seconds: 20, count: 3, seeds: [1, 2, 3], context_seconds: 4, abc: "X:1" });
  assert.equal(calls[0][1], "/api/music-auditions"); assert.equal(calls[0][2].action, "create");
  assert.deepEqual(calls[0][2].seeds, [1, 2, 3]); assert.equal(calls[0][2].contextSeconds, 4); assert.equal(calls[0][2].abc, "X:1");
  await tools.find(t => t.name === "music_audition_keep").run({ id: "aud_test", revision: 4, take_id: "take2", acknowledge_short: true });
  assert.deepEqual(calls[1][2], { action: "keep", id: "aud_test", revision: 4, takeId: "take2", acknowledgeShort: true });
  await tools.find(t => t.name === "music_auditions").run({ source: "song & a.flac" }); assert.match(calls[2][1], /song%20%26%20a\.flac/);
  assert.match(tools.find(t => t.name === "music_audition_keep").description, /user chooses/);
});
test("actual MCP wait follows composing to ready and survives pruned job history", async () => {
  const src = readFileSync(new URL("./mcp.js", import.meta.url), "utf8");
  const start = src.indexOf("async function waitForSong("), end = src.indexOf("async function waitForArt(", start);
  let result = { state: "composing", jobId: "mine", rawFile: "raw.flac" }, polls = 0;
  const wait = runInNewContext(`${src.slice(start, end)}; waitForSong`, {
    api: async (_, endpoint) => endpoint === "/api/status" ? { history: polls < 1 ? [{ id: "mine", state: "done", file: "raw.flac", durationSeconds: 50 }] : [] } : { result },
    sleep: async () => { polls++; result = { ...result, state: "ready", file: "composed.flac", seconds: 37.5, shortfallSeconds: 2.5, effectiveTo: 17.5, warnings: ["Ending returns early"] }; },
  });
  const done = await wait("mine", 5000);
  assert.equal(polls, 1); assert.equal(done.file, "composed.flac"); assert.equal(done.rawFile, "raw.flac");
  assert.equal(done.audioSeconds, 37.5); assert.equal(done.replacement.effectiveTo, 17.5);
});
test("actual replace and extend MCP tools use exact HTTP receipts", async () => {
  const src = readFileSync(new URL("./mcp.js", import.meta.url), "utf8");
  for (const name of ["replace_section", "extend_song"]) {
    const start = src.indexOf(`name: "${name}"`), next = src.indexOf('    name:', start + 20);
    const block = src.slice(src.lastIndexOf("  {", start), src.lastIndexOf("  {", next)).trim().replace(/,$/, "");
    let gets = 0;
    const tool = runInNewContext(`(${block})`, { safeName: x => x, api: async method => {
      if (method === "POST") return { job: { id: "ours" }, engine: "yue2" };
      gets++; return { current: { id: "other" }, queue: [{ id: "also-other" }] };
    } });
    assert.equal((await tool.run({ file: "song.flac", from_seconds: 10, to_seconds: 20 })).job_id, "ours"); assert.equal(gets, 0);
  }
});
test("make_song keeps the Python YuE2 receipt and reviewed section-label permission", async () => {
  const src = readFileSync(new URL("./mcp.js", import.meta.url), "utf8");
  const start = src.indexOf('name: "make_song"'), next = src.indexOf('name: "wait_for_song"', start);
  const block = src.slice(src.lastIndexOf("  {", start), src.lastIndexOf("  {", next)).trim().replace(/,$/, "");
  let body;
  const tool = runInNewContext(`(${block})`, { safeName: x => x, api: async (method, _, input) => {
    if (method === "POST") { body = input; return { job: { id: "ours", title: "Our song" }, engine: "yue2" }; }
    return { current: { id: "other" }, queue: [{ id: "ours" }, { id: "later" }] };
  } });
  const out = await tool.run({ caption: "folk", lyrics: "[verse]\nwords", engine: "yue2", allow_section_labels: true });
  assert.equal(out.job_id, "ours"); assert.equal(out.position_in_queue, 1); assert.equal(body.allowSectionLabels, true);
});
