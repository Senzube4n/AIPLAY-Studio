/** Native browser/MCP request-boundary tests. No queue, GPU, executable,
 * network request, owner settings or provenance append is invoked. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";

const scratch = mkdtempSync(path.join(tmpdir(), "aiplay-gguf-input-test-"));
const previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("AIPLAY_")));
for (const key of Object.keys(previous)) delete process.env[key];
process.env.AIPLAY_APPDATA = path.join(scratch, "appdata");
process.env.AIPLAY_RIG = path.join(scratch, "rig");
process.env.AIPLAY_OUTPUT = path.join(scratch, "output");
process.env.AIPLAY_YUE_GGUF_ENABLED = "0";
try {
// Dynamic imports are intentional: even config's read-only discovery is scoped
// to the empty test rig rather than the owner's configured installation.
const { prepareGgufJob } = await import("./music-gguf-input.js");
const { config } = await import("./config.js");
const valid = (extra = {}) => ({ caption: "Warm acoustic folk", lyrics: "Sing softly\nUnder the moon", ...extra });
const queued = [];
const atBoundary = (body) => { const spec = prepareGgufJob(body, "agent:test"); queued.push(spec); return spec; };
const refuses = (body, expected = undefined) => {
  const before = queued.length;
  assert.throws(() => atBoundary(body), expected);
  assert.equal(queued.length, before, "invalid request must stop before the queue boundary");
};
const text = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");

await test("defaults select native GGUF Q4 without Python duration/rung or API fallbacks", () => {
  const body = Object.freeze(valid()), job = atBoundary(body);
  assert.equal(job.engine, "yue2-gguf"); assert.equal(job.actor, "agent:test");
  assert.equal(job.model, "YuE2 GGUF Q4"); assert.equal(job.experimental, true);
  assert.equal(job.quantization, "q4_0"); assert.equal(job.cot, "full");
  assert.equal(job.seed, 831001); assert.equal(job.narSteps, 32);
  assert.equal(job.cfgScale, undefined); assert.equal(job.abc, undefined);
  assert.equal(job.instrumental, false); assert.equal(job.preview, false); assert.equal(job.allowSectionLabels, false);
  assert.equal(job.title, "Sing softly"); assert.deepEqual(body, valid());
  for (const key of ["maxDuration", "wantSeconds", "offloadAr", "queryChunk", "maxTokens", "rung", "audioRef", "mixSeed", "scoreSlug", "scoreVersion"]) {
    assert.equal(Object.hasOwn(job, key), false, key);
  }
  assert.equal(atBoundary(valid({ engine: "yue2-gguf", quantization: "q4_0" })).engine, "yue2-gguf");
});

await test("trimmed text and ordinary multilingual Unicode reach the job unchanged", () => {
  const caption = "Café nocturne — 柔らかなピアノ 🌙";
  const lyrics = "Étoiles, guidez-moi\nこんにちは、月よ 🌙\nغنّي بهدوء";
  const job = atBoundary({ caption: `  ${caption}  `, lyrics: `\n ${lyrics} \n`, title: "  Nuit — 夜  " });
  assert.equal(job.caption, caption); assert.equal(job.lyrics, lyrics); assert.equal(job.title, "Nuit — 夜");
  assert.equal(atBoundary(valid({ title: "x".repeat(200) })).title.length, 120);
  assert.equal(atBoundary(valid({ title: "  " })).title, "Sing softly");
});

await test("caption, lyrics, title and body types fail before queueing", () => {
  for (const body of [null, undefined, 1, "text", [], {}]) refuses(body);
  for (const value of [undefined, null, "", "  ", 0, false, [], {}, "bad\0style"]) refuses(valid({ caption: value }));
  for (const value of [undefined, null, "", "\n\t", 0, false, [], {}, "bad\0lyrics"]) refuses(valid({ lyrics: value }));
  for (const value of [1, true, [], {}]) refuses(valid({ title: value }), /[Tt]itle/);
  assert.equal(atBoundary(valid({ caption: "s".repeat(2000) })).caption.length, 2000);
  assert.equal(atBoundary(valid({ lyrics: "l".repeat(8000) })).lyrics.length, 8000);
  refuses(valid({ caption: "s".repeat(2001) }), /2000/);
  refuses(valid({ lyrics: "l".repeat(8001) }), /8000/);
  refuses(valid({ lyrics: "--backend" }), /flag/);
});

await test("optional boolean values are not truthy-string coercions; native instrumentals and previews are refused", () => {
  for (const key of ["instrumental", "preview", "allowSectionLabels"]) {
    for (const value of [0, 1, "false", "true", [], {}]) refuses(valid({ [key]: value }));
  }
  const job = atBoundary(valid({ instrumental: false, preview: false, allowSectionLabels: false }));
  assert.equal(job.instrumental, false); assert.equal(job.preview, false);
  refuses(valid({ instrumental: true }), /instrumental|lyrics/i);
  refuses(valid({ instrumental: true, lyrics: "" }), /instrumental|lyrics/i);
  refuses(valid({ preview: true }), /preview/i);
});

await test("Q4_0 is the only accepted precision, never a Python BF16/FP8 toggle", () => {
  for (const value of ["none", "bf16", "fp8", "q4", "Q4_0", "q8_0", "", 4, true, {}, []]) {
    refuses(valid({ quantization: value }), /Q4_0|FP8/);
  }
  assert.equal(atBoundary(valid({ quantization: "q4_0" })).quantization, "q4_0");
});

await test("cot enum and safe-integer seed are validated without numeric-string coercion", () => {
  for (const cot of ["off", "melody", "full"]) assert.equal(atBoundary(valid({ cot })).cot, cot);
  for (const cot of ["FULL", "", "auto", 1, false, [], {}]) refuses(valid({ cot }), /cot/);
  for (const seed of [0, 17, Number.MAX_SAFE_INTEGER]) assert.equal(atBoundary(valid({ seed })).seed, seed);
  for (const seed of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "17", false, {}, []]) {
    refuses(valid({ seed }), /seed/);
  }
});

await test("native NAR-step and guidance bounds are checked before queueing", () => {
  for (const narSteps of [1, 16, 32, 256]) assert.equal(atBoundary(valid({ narSteps })).narSteps, narSteps);
  for (const narSteps of [0, -1, 1.5, 257, NaN, Infinity, "16", false, [], {}]) {
    refuses(valid({ narSteps }), /narSteps/);
  }
  for (const cfgScale of [0, 2.5, 20]) assert.equal(atBoundary(valid({ cfgScale })).cfgScale, cfgScale);
  for (const cfgScale of [-0.1, 20.1, NaN, Infinity, "2.5", false, [], {}]) {
    refuses(valid({ cfgScale }), /cfg_scale/);
  }
  for (const cfgScale of [undefined, null, ""]) assert.equal(atBoundary(valid({ cfgScale })).cfgScale, undefined);
});

await test("ABC is bounded text and cannot be combined with cot off", () => {
  const abc = "X:1\nT:Night\nM:4/4\nK:C\nC D E F|";
  for (const cot of ["full", "melody"]) assert.equal(atBoundary(valid({ cot, abc })).abc, abc);
  refuses(valid({ cot: "off", abc }), /abc|cot/i);
  for (const abc of ["", "  ", 7, false, {}, [], "bad\0score", "a".repeat(65537), "é".repeat(32769)]) {
    refuses(valid({ abc }), /abc/i);
  }
  assert.equal(atBoundary(valid({ abc: "a".repeat(65536) })).abc.length, 65536);
});

await test("bracketed labels require explicit opt-in and retain that provenance intent", () => {
  const lyrics = "[Verse]\nSing softly\n[Chorus]\nUnder the moon";
  refuses(valid({ lyrics }), /label|bracket/i);
  const job = atBoundary(valid({ lyrics, allowSectionLabels: true }));
  assert.equal(job.lyrics, lyrics); assert.equal(job.allowSectionLabels, true);
});

await test("Python duration/offload/token/precision and reference knobs are rejected, not silently dropped", () => {
  const unsupported = {
    duration: 30, durationSeconds: 30, length: 30, maxDuration: 30, max_seconds: 30, wantSeconds: 30,
    audioSeconds: 30, maxTokens: 750, offloadAr: true, offload_ar: true, queryChunk: 512,
    rung: { id: "long" }, precision: "fp8", fp8: true, quantizationType: "bf16",
    audioRef: "source.latent", audioRefDenoise: 0.5, reference_id: "reference", inputAudio: "audio.wav",
    musicInput: { id: "input" }, resumeFrom: "latent", reusesConditioning: true,
    scoreSlug: "score", scoreVersion: "version", model: "python", mixSeed: 19,
    steps: 50, arCfg: 2, flowCfg: 1, cfg_scale: 2, tags: "style alias", unknown: true,
  };
  for (const [key, value] of Object.entries(unsupported)) {
    refuses(valid({ [key]: value }), (error) => error.message.includes(key) && /Nothing was queued/.test(error.message));
    refuses(valid({ [key]: null }), (error) => error.message.includes(key));
  }
  // MCP's optional fields can be undefined before its JSON serializer removes
  // them; they are absent intent, unlike false/null/zero explicit arguments.
  const job = atBoundary(valid({ maxDuration: undefined, audioRef: undefined }));
  assert.equal(Object.hasOwn(job, "maxDuration"), false); assert.equal(Object.hasOwn(job, "audioRef"), false);
});

await test("HTTP native branch validates before status and enqueue; unknown explicit engines do not fall back", async () => {
  const src = text("./index.js"), start = src.indexOf('if (p === "/api/generate" && req.method === "POST")');
  assert.ok(start >= 0);
  const bodyStart = src.indexOf("const body =", start), end = src.indexOf("/* ⚠ REFUSE AN ENGINE THIS DOOR", bodyStart);
  assert.ok(bodyStart > start && end > bodyStart);
  const events = [], app = { musicOnly: false, music: { engine: "minimax-music3", engines: { "minimax-music3": {}, yue2: {}, "yue2-gguf": {} } } };
  const setup = { pending: false, ready: true, status: async () => { events.push("status"); return { ready: setup.ready, message: "Fixture unavailable" }; } };
  const route = runInNewContext(`(async(payload)=>{const req={},res={};const readBody=async()=>payload;
    ${src.slice(bodyStart, end)}\nreturn {unhandled:true};})`, {
    config: app, ggufSetup: setup, prov: { actorFrom: () => "agent:test" },
    prepareGgufJob: (body, actor) => { events.push("validate"); return prepareGgufJob(body, actor); },
    jobs: { enqueue: (spec) => { events.push("enqueue"); return { id: "owned-native", title: spec.title }; }, snapshot: () => ({ current: { id: "someone-else" } }) },
    json: (res, status, body) => ({ status, body }),
  }, { timeout: 1000 });
  let response = await route(valid({ engine: "yue2-gguf" }));
  assert.equal(response.status, 200); assert.equal(response.body.job.id, "owned-native");
  assert.deepEqual(events.splice(0), ["validate", "status", "enqueue"]);
  response = await route(valid({ engine: "yue2-gguf", narSteps: 0 }));
  assert.equal(response.status, 400); assert.deepEqual(events.splice(0), ["validate"]);
  setup.ready = false; response = await route(valid({ engine: "yue2-gguf" }));
  assert.equal(response.status, 400); assert.deepEqual(events.splice(0), ["validate", "status"]);
  setup.ready = true; setup.pending = true; response = await route(valid({ engine: "yue2-gguf" }));
  assert.equal(response.status, 409); assert.deepEqual(events.splice(0), ["validate"]);
  setup.pending = false; response = await route(valid({ engine: "typo-native" }));
  assert.equal(response.status, 400); assert.deepEqual(events, []);
  app.musicOnly = true; response = await route(valid({ engine: "minimax-music3" }));
  assert.equal(response.status, 400); assert.deepEqual(events, []);
});

await test("browser native spec excludes legacy duration/reference knobs; MCP uses the native job ID", () => {
  const browser = text("../web/app.js"), start = browser.indexOf('?.runtime === "audiocpp") {', browser.indexOf("function currentSpec("));
  assert.ok(start >= 0);
  const branch = browser.slice(start, browser.indexOf("\n  return {", start));
  assert.match(branch, /engine: "yue2-gguf"/); assert.match(branch, /quantization: "q4_0"/);
  assert.doesNotMatch(branch, /\b(?:maxDuration|wantSeconds|audioRef|audioRefDenoise|mixSeed|offloadAr|queryChunk|maxTokens|scoreSlug|scoreVersion)\s*:/);
  const mcp = text("./mcp.js"), makeSong = mcp.slice(mcp.indexOf('name: "make_song"'), mcp.indexOf('name: "wait_for_song"'));
  assert.match(makeSong, /enum: \["minimax-music3", "yue2", "yue2-gguf"\]/);
  assert.match(makeSong, /api\("POST", "\/api\/generate"/);
  assert.match(makeSong, /const mine = r\.engine === "yue2-gguf" \? r\.job/);
});

await test("actual browser currentSpec + generate send only helper-compatible native bodies", async () => {
  const src = text("../web/app.js");
  const specStart = src.indexOf("function currentSpec("), specEnd = src.indexOf("/* The YuE2 rows", specStart);
  const generateStart = src.indexOf("async function generate("), generateEnd = src.indexOf("/* Takes per generation", generateStart);
  assert.ok(specStart >= 0 && specEnd > specStart && generateStart >= 0 && generateEnd > generateStart);
  const values = { title: "夜の歌", lyrics: "Étoiles, guidez-moi\nこんにちは 🌙", seed: "17", yCot: "full", ySteps: "16", yCfg: "2.5" };
  const elements = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]));
  elements.btnCreate = { disabled: false }; elements.btnPreview = { disabled: false };
  const state = { mode: "lyrics", musicEngine: "yue2-gguf", takes: 2, engineReady: false,
    musicEngines: { "yue2-gguf": { runtime: "audiocpp", ready: true } },
    audioRef: { latent: "stale-minimax-input" } };
  const requests = [], alerts = [];
  const browser = runInNewContext(`${src.slice(specStart, specEnd)}\n${src.slice(generateStart, generateEnd)}\n({ currentSpec, generate });`, {
    state,
    $: (id) => { assert.ok(elements[id], `unexpected legacy DOM field: ${id}`); return elements[id]; },
    captionValue: () => "Café nocturne — 柔らかなピアノ",
    reusesConditioning: () => { throw Error("Native request must not visit Python/MiniMax conditioning logic"); },
    alert: (message) => alerts.push(message),
    setTimeout: (callback) => { callback(); return 0; },
    fetch: async (url, options) => {
      assert.equal(url, "/api/generate"); assert.equal(options.method, "POST");
      const body = JSON.parse(options.body);
      const prepared = prepareGgufJob(body, "user"); // Real server preflight; never a real queue.
      requests.push({ body, prepared });
      return { json: async () => ({ job: { id: `fake-${requests.length}` }, engine: "yue2-gguf" }) };
    },
  }, { timeout: 1000 });
  await browser.generate(false, undefined);
  assert.equal(requests.length, 2); assert.deepEqual(alerts, []);
  for (const { body, prepared } of requests) {
    assert.equal(body.engine, "yue2-gguf"); assert.equal(body.quantization, "q4_0");
    assert.equal(prepared.cfgScale, 2.5); assert.equal(prepared.narSteps, 16);
    assert.equal(prepared.caption, "Café nocturne — 柔らかなピアノ");
    assert.equal(prepared.lyrics, values.lyrics);
    for (const key of ["reusesConditioning", "maxDuration", "wantSeconds", "mixSeed", "audioRef", "rung", "offloadAr", "maxTokens"]) {
      assert.equal(Object.hasOwn(body, key), false, key);
    }
  }
  assert.equal(requests[0].prepared.seed, 17); assert.match(requests[1].prepared.title, /take 2$/);
  assert.equal(elements.btnCreate.disabled, false, "native readiness, not Comfy readiness, re-enables Create");
  assert.equal(state.lastSpec.engine, "yue2-gguf");
});

await test("MCP completed-song result separates audio duration from generation time", async () => {
  const src = text("./mcp.js"), start = src.indexOf('name: "wait_for_song"');
  const end = src.indexOf('name: "get_beats"', start);
  assert.ok(start >= 0 && end > start);
  const block = src.slice(src.lastIndexOf("  {", start), src.lastIndexOf("  {", end)).trim().replace(/,$/, "");
  let completed;
  const tool = runInNewContext(`(${block})`, {
    waitForSong: async (id, budget) => { assert.equal(id, "native-id"); assert.equal(budget, 2000); return completed; },
  }, { timeout: 1000 });
  completed = { file: "native.wav", title: "Test", engine: "yue2-gguf", audioSeconds: 49.398667, durationSeconds: 22, seed: 831001 };
  const actual = await tool.run({ job_id: "native-id", timeout_seconds: 2 });
  assert.equal(actual.seconds, 49.398667); assert.equal(actual.render_seconds, 22);
  assert.equal(actual.engine, "yue2-gguf"); assert.equal(actual.file, "native.wav");
  for (const missing of [undefined, null, NaN, Infinity, -1, 0]) {
    completed = { ...completed, audioSeconds: missing };
    const result = await tool.run({ job_id: "native-id", timeout_seconds: 2 });
    assert.equal(result.seconds, null, "Never substitute render time for unknown audio length");
    assert.equal(result.render_seconds, 22);
  }
});

await test("real MCP make_song forwards native ABC and guidance and never mistakes a different queued job for its own", async () => {
  const src = text("./mcp.js"), start = src.indexOf('name: "make_song"'), end = src.indexOf('name: "wait_for_song"', start);
  const block = src.slice(src.lastIndexOf("  {", start), src.lastIndexOf("  {", end)).trim().replace(/,$/, "");
  const requests = [];
  const tool = runInNewContext(`(${block})`, { api: async (method, endpoint, body) => {
    if (method === "POST") {
      assert.equal(endpoint, "/api/generate"); requests.push(prepareGgufJob(body, "agent:test"));
      return { engine: "yue2-gguf", job: { id: "owned-native", title: "Our take", engine: "yue2-gguf" } };
    }
    return { current: { id: "someone-else" }, queue: [{ id: "also-someone-else" }] };
  } }, { timeout: 1000 });
  const result = await tool.run({ engine: "yue2-gguf", caption: "Folk", lyrics: "We sing", precision: "q4_0",
    abc: "X:1\nQ:1/4=90", cot: "melody", cfg_scale: 2.5, nar_steps: 16, seed: 7 });
  assert.equal(result.job_id, "owned-native"); assert.equal(result.title, "Our take");
  assert.equal(requests[0].abc, "X:1\nQ:1/4=90"); assert.equal(requests[0].cfgScale, 2.5);
  assert.ok(tool.inputSchema.properties.abc); assert.ok(tool.inputSchema.properties.cfg_scale);
});

await test("tests stayed inside empty isolated appdata/rig and wrote no ledger or runtime artifacts", () => {
  assert.equal(config.rig, path.join(scratch, "rig"));
  assert.equal(config.settingsFile, path.join(scratch, "appdata", "settings.json"));
  assert.equal(config.outputDir, path.join(scratch, "output"));
  assert.equal(config.yueGguf.enabled, false);
  assert.deepEqual(readdirSync(scratch), []);
});
} finally {
  // Explicit lifetime also covers failed imports. Root node:test after hooks
  // can run too early when tests register after asynchronous module loading.
  for (const key of Object.keys(process.env)) if (key.startsWith("AIPLAY_")) delete process.env[key];
  Object.assign(process.env, previous);
  assert.equal(path.dirname(scratch), path.resolve(tmpdir()));
  assert.match(path.basename(scratch), /^aiplay-gguf-input-test-/);
  rmSync(scratch, { recursive: true, force: true });
}
