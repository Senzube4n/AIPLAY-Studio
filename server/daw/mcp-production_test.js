import assert from "node:assert/strict";
import test from "node:test";
import { dawTools } from "../mcp-daw.js";
import { bounceOptions, loudnessOptions } from "./bounce-options.js";
import { handleMixerAction } from "./mixer.js";

test("export defaults, inheritance and explicit off share one validated contract", () => {
  assert.deepEqual(bounceOptions({}), { format: "flac", bit_depth: 24, target_lufs: null, ceiling_db: -1, max_limit_db: 3 });
  assert.equal(bounceOptions({}, -17).target_lufs, -17);
  assert.equal(bounceOptions({ target_lufs: null }, -17).target_lufs, null);
  for (const body of [{ format: "mp3" }, { bit_depth: 32 }, { bit_depth: "24" },
    { target_lufs: "-17" }, { target_lufs: false }, { target_lufs: -31 }, { target_lufs: -5 },
    { target_lufs: NaN }, { ceiling_db: 1 }, { ceiling_db: -13 }, { max_limit_db: -1 },
    { max_limit_db: 13 }, { ceiling_db: null }]) assert.throws(() => bounceOptions(body));
});

test("MCP bounce forwards every export option and returns download, encoding and origin facts", async () => {
  const input = { slug: "test", format: "wav", bit_depth: 16, target_lufs: -17, ceiling_db: -1.2, max_limit_db: .98 };
  const reply = { file: "master.wav", name: "test_abc.wav", url: "/api/daw/bounce/test/test_abc.wav",
    format: "wav", sr: 48000, channels: 2, dithered: true, bit_depth: 16,
    origin: "composite-synthetic", tagged: { ok: true, class: "composite-synthetic" }, ...input };
  let sent;
  const tool = dawTools(async (method, url, body) => { sent = { method, url, body }; return reply; }, x => x)
    .find(t => t.name === "daw_bounce");
  const result = await tool.run(input);
  assert.deepEqual(sent, { method: "POST", url: "/api/daw", body: { action: "bounce", ...input, by: "agent" } });
  for (const key of ["file", "name", "url", "format", "sr", "channels", "dithered", "origin", "tagged", "bit_depth", "ceiling_db", "max_limit_db"])
    assert.deepEqual(result[key], reply[key], key);
  assert.deepEqual(tool.inputSchema.properties.format.enum, ["flac", "wav"]);
  assert.deepEqual(tool.inputSchema.properties.target_lufs.type, ["number", "null"]);
});

test("MCP stereo import retains storage and source-channel facts", async () => {
  const facts = { channels: 2, format: "wav", peak: 1.2, sr: 48000, source_channels: 2,
    source_sr: 44100, note: "Float headroom retained" };
  const tool = dawTools(async () => facts, x => x).find(t => t.name === "daw_import_audio");
  const result = await tool.run({ slug: "test", track: "t", path: "stem.wav" });
  for (const [key, value] of Object.entries(facts)) assert.equal(result[key], value, key);
});

test("MCP return stems and reconstruction measurements survive fresh and cached replies", async () => {
  const regions = [false, true].map(cached => ({ idx: 0, fromBar: 1, toBar: 4, cached,
    stems: [{ track_id: "t", file: "track.wav" }], returns: [{ return_id: "hall", file: "return.wav" }],
    ...(!cached ? { exported_complete: false, exported_residual_db: -12 } : {}) }));
  const tool = dawTools(async () => ({ regions }), x => x).find(t => t.name === "daw_render_stems");
  const result = await tool.run({ slug: "test" });
  assert.deepEqual(result.regions.map(r => r.returns), regions.map(r => r.returns));
  assert.equal(result.regions[0].exported_complete, false);
  assert.equal(result.regions[0].exported_residual_db, -12);
  assert.match(tool.description, /PLUS the separate shared-return/);
});

test("MCP custom delivery preflight forwards exactly the bounce loudness settings", async () => {
  let sent;
  const tool = dawTools(async (_m, _u, body) => { sent = body; return {}; }, x => x)
    .find(t => t.name === "daw_check_delivery");
  await tool.run({ file: "master.flac", target_lufs: -10, ceiling_db: -1.2, max_limit_db: 3 });
  assert.deepEqual(loudnessOptions(sent), { target_lufs: -10, ceiling_db: -1.2, max_limit_db: 3 });
});

test("shared delivery route passes custom settings to Python and refuses invalid settings before work", async () => {
  let called = 0, seen;
  const ctx = { safe: x => x, runEngineFast: async (_mode, job) => { called++; seen = job; return { results: [] }; } };
  await handleMixerAction("check_delivery", { file: "master.flac", target_lufs: -10, ceiling_db: -1.2, max_limit_db: 2 }, ctx);
  assert.equal(called, 1);
  assert.deepEqual(loudnessOptions(seen), { target_lufs: -10, ceiling_db: -1.2, max_limit_db: 2 });
  await assert.rejects(handleMixerAction("check_delivery", { file: "master.flac", target_lufs: 2 }, ctx), /target_lufs/);
  assert.equal(called, 1);
});
