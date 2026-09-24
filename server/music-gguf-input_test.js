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
// The route marks the required badge over its overlaid rows; the slice below runs the real rule.
const { markRequired, modulesOf } = await import("./models.js");
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
  // No seed asked for: an integer rolled per request, never the old fixed 831001.
  assert.ok(Number.isSafeInteger(job.seed) && job.seed >= 0 && job.seed < 2 ** 32, String(job.seed));
  assert.notEqual(atBoundary(valid()).seed === job.seed && atBoundary(valid()).seed === job.seed, true, "three seedless requests rolled one seed");
  assert.equal(job.narSteps, 32); assert.equal(Object.hasOwn(job, "ggufOptions"), false);
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

await test("Q4_0 and Q8_0 are native choices, never Python BF16/FP8 toggles", () => {
  for (const value of [null, "none", "bf16", "fp8", "q4", "Q4_0", "q8", "", 4, true, {}, []]) {
    refuses(valid({ quantization: value }), /Q4_0|FP8/);
  }
  assert.equal(atBoundary(valid({ quantization: "q4_0" })).quantization, "q4_0");
  assert.equal(atBoundary(valid({ quantization: "q8_0" })).quantization, "q8_0");
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

await test("the Performance and Planner dials pass, by the runtime's names; blank keeps the default", () => {
  const job = atBoundary(valid({ temperature: 0.8, topP: 0.9, planTemperature: 1.1, planTopP: 0.85 }));
  assert.deepEqual(job.ggufOptions, { semantic_temperature: 0.8, semantic_top_p: 0.9, abc_temperature: 1.1, abc_top_p: 0.85 });
  for (const blank of [undefined, null, ""]) assert.equal(Object.hasOwn(atBoundary(valid({ temperature: blank })), "ggufOptions"), false);
  refuses(valid({ temperature: 6 }), /sampler dial/);
  refuses(valid({ topP: 0 }), /sampler dial/);
  refuses(valid({ temperature: "0.8" }), /sampler dial/);
  // The planner does not run under a supplied score: the page's own words, not a silent drop.
  refuses(valid({ abc: "X:1\nK:C\nC|", planTemperature: 0.9 }), /supplied score the planner does not run/);
  refuses(valid({ cot: "off", planTopP: 0.9 }), /Thinking off/);
  assert.equal(atBoundary(valid({ abc: "X:1\nK:C\nC|", temperature: 0.9 })).ggufOptions.semantic_temperature, 0.9);
});

await test("section tags are accepted without any opt-in, and the old flag still works", () => {
  const lyrics = "[Verse]\nSing softly\n[Chorus]\nUnder the moon";
  assert.equal(atBoundary(valid({ lyrics })).lyrics, lyrics);
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
  const setup = { pending: false, ready: true, selected: null, only: null, status: async ({quantization}) => {
    events.push("status"); setup.selected = quantization;
    // Unnamed precision: the kit answers for what is installed (Q4 unless only Q8 is).
    const q = quantization ?? setup.only ?? "q4_0";
    return { quantization: q, ready: setup.ready && (!setup.only || setup.only === q), message: "Fixture unavailable" };
  } };
  const route = runInNewContext(`(async(payload)=>{const req={},res={};const readBody=async()=>payload;
    ${src.slice(bodyStart, end)}\nreturn {unhandled:true};})`, {
    config: app, ggufSetup: setup, prov: { actorFrom: () => "agent:test" },
    prepareGgufJob: (body, actor) => { events.push("validate"); return prepareGgufJob(body, actor); },
    jobs: { enqueue: (spec) => { events.push("enqueue"); return { id: "owned-native", title: spec.title, quantization: spec.quantization }; }, snapshot: () => ({ current: { id: "someone-else" } }) },
    json: (res, status, body) => ({ status, body }),
  }, { timeout: 1000 });
  let response = await route(valid({ engine: "yue2-gguf" }));
  assert.equal(response.status, 200); assert.equal(response.body.job.id, "owned-native");
  assert.deepEqual(events.splice(0), ["validate", "status", "enqueue"]);
  assert.equal(setup.selected, undefined, "an unnamed precision is the kit's to answer");
  assert.equal(response.body.job.quantization, "q4_0");
  setup.only = "q4_0";
  response = await route(valid({ engine: "yue2-gguf", quantization: "q8_0" }));
  assert.equal(response.status, 400); assert.equal(setup.selected, "q8_0");
  assert.deepEqual(events.splice(0), ["validate", "status"], "Q4 installed cannot satisfy a Q8 request");
  setup.only = "q8_0";
  response = await route(valid({ engine: "yue2-gguf", quantization: "q8_0" }));
  assert.equal(response.status, 200); assert.equal(response.body.job.quantization, "q8_0");
  assert.deepEqual(events.splice(0), ["validate", "status", "enqueue"]);
  // A Q8-only kit and no precision named: the job takes Q8 instead of being refused over Q4.
  response = await route(valid({ engine: "yue2-gguf" }));
  assert.equal(response.status, 200); assert.equal(response.body.job.quantization, "q8_0");
  assert.deepEqual(events.splice(0), ["validate", "status", "enqueue"]);
  setup.only = null;
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

await test("Models response preserves catalogue variant rows and exposes separate native readiness", async () => {
  const src = text("./index.js"), routeStart = src.indexOf('if (p === "/api/models" && req.method !== "POST")');
  const start = src.indexOf("const nativeSetup = await ggufSetup.status();", routeStart);
  const end = src.indexOf("\n      return json(res, 200, {", start);
  assert.ok(routeStart >= 0 && start > routeStart && end > start);
  const catalogueVariants = [
    { label: "Q4_0 (default)", bytes: 2933414997, note: "Smaller kit" },
    { label: "Q8_0 (optional)", bytes: 4531969109, note: "Unbenchmarked" },
  ];
  const unrelatedVariants = [{ label: "Unrelated model build", bytes: 12 }];
  const cat = [
    { id: "musicYue2Gguf", nativeSetup: true, note: "Native kit.", variants: catalogueVariants },
    { id: "other", note: "Other kit.", variants: unrelatedVariants },
  ];
  let status;
  const projection = runInNewContext(`(async()=>{${src.slice(start, end)};return capabilities;})`, {
    cat, pkgs: {}, machine: {}, fitFor: () => ({ state: "experimental" }),
    // The Models route now also files each row into a collapsible section.
    modelGroupOf: () => "music",
    ggufSetup: { pending: false, status: async () => status },
    markRequired,
    // Which python modules a row needs (timed lyrics needs two; see server/lrc_test.js).
    modulesOf,
  }, { timeout: 1000 });
  status = { ready: false, variants: { q4_0: { ready: false }, q8_0: { ready: true } },
    message: "Native YuE2 Q4_0 is not installed.", downloadBytes: 2933415003, progress: null };
  const rows = await projection(), native = rows[0];
  assert.equal(Array.isArray(native.variants), true, "Models UI renders variants.length and variants.map");
  assert.equal(native.variants, catalogueVariants, "retain each catalogue label, bytes and explanatory note");
  assert.equal(native.nativeVariants, status.variants, "readiness map uses its own field, not the catalogue array");
  assert.equal(native.ready, true, "Q8-only is a usable native kit");
  assert.match(native.note, /Q8_0/);
  assert.doesNotMatch(native.note, /Q4_0 is not installed|missing Q4|not downloaded/i);
  assert.equal(rows[1].variants, unrelatedVariants);assert.equal(rows[1].nativeVariants, undefined);
  status = { ...status, variants: { q4_0: { ready: true }, q8_0: { ready: true } } };
  const both = (await projection())[0];
  assert.match(both.note, /Q4_0/);assert.match(both.note, /Q8_0/);
  status = { ...status, variants: { q4_0: { ready: false }, q8_0: { ready: false } }, message: "Fixture runtime unavailable" };
  const unavailable = (await projection())[0];
  assert.equal(unavailable.ready, false);assert.match(unavailable.note, /Fixture runtime unavailable/);
  /* THE BADGE IS MARKED AFTER THE OVERLAY. status() cannot see the native kit
   * (the row has no files of its own), so marked before the overlay a set-up
   * native engine would still read "one music engine required". */
  const shipped = config.music.engine;
  try {
    config.music.engine = "yue2-gguf";
    status = { ...status, variants: { q4_0: { ready: false }, q8_0: { ready: true } } };
    const chosen = (await projection())[0];
    assert.equal(chosen.required, true, "the selected native engine, set up, is the required one");
    assert.equal(chosen.requiredGroup, null);
  } finally {
    config.music.engine = shipped;
  }
});

await test("Python YuE2 refuses native Q4/Q8 before its kit, hardware checks or queue", async () => {
  const src = text("./index.js"), routeStart = src.indexOf('if (p === "/api/generate" && req.method === "POST")');
  const start = src.indexOf('if (musicEngine === "yue2") {', routeStart);
  const end = src.indexOf("\n      const job = jobs.enqueue({", start);
  assert.ok(routeStart >= 0 && start > routeStart && end > start);
  const events = [];
  const route = runInNewContext(`(async(body)=>{const musicEngine="yue2",res={};
    ${src.slice(start, end)};return {unhandled:true};})`, {
    json: (res, status, body) => ({ status, body }),
    refuseLyrics: () => events.push("lyrics"),
    yueStatus: async () => { events.push("kit"); return { installed: false, why: ["Fixture unavailable"] }; },
    cudaCapability: async () => { events.push("hardware"); throw Error("No hardware operations allowed"); },
    jobs: { enqueue: () => { events.push("enqueue"); throw Error("No real queue allowed"); } },
  }, { timeout: 1000 });
  for (const quantization of ["q4_0", "q8_0"]) {
    const response = await route(valid({ quantization }));
    assert.equal(response.status, 400);assert.equal(response.body.engine, "yue2");
    assert.equal(response.body.reason, "precision-engine-mismatch");
    assert.match(response.body.error, /native yue2-gguf/);assert.match(response.body.error, /No Python BF16 fallback/);
    assert.deepEqual(events, [], "native precision must be rejected before any Python preflight or enqueue");
  }
  const control = await route(valid({ quantization: "none" }));
  assert.equal(control.body.reason, "kit-missing", "valid Python precision still uses its normal kit gate");
  assert.deepEqual(events, ["lyrics", "kit"]);
});

await test("browser native spec excludes legacy duration/reference knobs; MCP uses the native job ID", () => {
  const browser = text("../web/app.js"), start = browser.indexOf('?.runtime === "audiocpp") {', browser.indexOf("function currentSpec("));
  assert.ok(start >= 0);
  const branch = browser.slice(start, browser.indexOf("\n  return {", start));
  assert.match(branch, /engine: "yue2-gguf"/); assert.match(branch, /quantization: ggufPrecision\(\)/);
  assert.doesNotMatch(branch, /\b(?:maxDuration|wantSeconds|audioRef|audioRefDenoise|mixSeed|offloadAr|queryChunk|maxTokens|scoreSlug|scoreVersion)\s*:/);
  const mcp = text("./mcp.js"), makeSong = mcp.slice(mcp.indexOf('name: "make_song"'), mcp.indexOf('name: "wait_for_song"'));
  assert.match(makeSong, /enum: \["minimax-music3", "yue2", "yue2-comfy", "yue2-gguf", "ace-step15"\]/);
  assert.match(makeSong, /api\("POST", "\/api\/generate"/);
  assert.match(makeSong, /const mine = r\.job;/);
  assert.doesNotMatch(makeSong, /st\.queue\[st\.queue\.length - 1\]/);
});

await test("actual browser currentSpec + generate send only helper-compatible native bodies", async () => {
  const src = text("../web/app.js");
  const specStart = src.indexOf("function currentSpec("), specEnd = src.indexOf("/* The YuE2 rows", specStart);
  const generateStart = src.indexOf("async function generate("), generateEnd = src.indexOf("/* Takes per generation", generateStart);
  assert.ok(specStart >= 0 && specEnd > specStart && generateStart >= 0 && generateEnd > generateStart);
  // The Performance / Planner rows are read on this engine now (a blank one sends nothing).
  const values = { title: "夜の歌", lyrics: "Étoiles, guidez-moi\nこんにちは 🌙", seed: "17", yCot: "full", ySteps: "16", yCfg: "2.5",
    yTemp: "0.8", yTopP: "", yPlanTemp: "" };
  const elements = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]));
  elements.btnCreate = { disabled: false }; elements.btnPreview = { disabled: false };
  elements.yAbcUse = { checked: false }; elements.yAbc = { value: "" }; elements.scoreUse = { checked: false };
  // seedLocked is LOCKED here so the request carries seed 17 and can be asserted.
  // The app's own default is unlocked, which re-rolls the seed on every Create.
  const state = { mode: "lyrics", musicEngine: "yue2-gguf", takes: 2, engineReady: false, seedLocked: true,
    musicEngines: { "yue2-gguf": { runtime: "audiocpp", ready: true } },
    audioRef: { latent: "stale-minimax-input" } };
  const requests = [], alerts = [];
  const helpers = src.slice(src.indexOf("function ggufPrecision()"), src.indexOf("function ggufSetupSelection("));
  const browser = runInNewContext(`let ggufQuantization = "q4_0";\n${helpers}\n${src.slice(specStart, specEnd)}\n${src.slice(generateStart, generateEnd)}\n({ currentSpec, generate });`, {
    state,
    yueEngine: () => true,
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
    assert.deepEqual(prepared.ggufOptions, { semantic_temperature: 0.8 }, "the set dial reaches the runtime; the blank ones stay default");
    assert.equal(Object.hasOwn(body, "topP"), false, "a blank dial is not sent");
    assert.equal(prepared.caption, "Café nocturne — 柔らかなピアノ");
    assert.equal(prepared.lyrics, values.lyrics);
    for (const key of ["reusesConditioning", "maxDuration", "wantSeconds", "mixSeed", "audioRef", "rung", "offloadAr", "maxTokens"]) {
      assert.equal(Object.hasOwn(body, key), false, key);
    }
  }
  assert.equal(requests[0].prepared.seed, 17); assert.match(requests[1].prepared.title, /take 2$/);
  assert.equal(elements.btnCreate.disabled, false, "native readiness, not Comfy readiness, re-enables Create");
  assert.equal(state.lastSpec.engine, "yue2-gguf");
  state.takes = 1;
  elements.yAbcUse.checked = true;
  await browser.generate(false); assert.equal(requests.length, 2); assert.match(alerts.pop(), /Add an ABC/);
  elements.yAbc.value = "X:1\nM:4/4\nK:C\nC D E F|";
  elements.yCot.value = "off";
  await browser.generate(false); assert.equal(requests.length, 2); assert.match(alerts.pop(), /chain of thought/);
  elements.yCot.value = "full"; elements.scoreUse.checked = true;
  await browser.generate(false); assert.equal(requests.length, 3);
  assert.equal(requests[2].prepared.abc, elements.yAbc.value);
  assert.deepEqual(alerts, [], "a hidden Python saved-score checkbox must not block the native ABC draft");
  state.musicEngines[state.musicEngine].score = true;
  await browser.generate(false); assert.equal(requests.length, 3); assert.match(alerts.pop(), /one score/);
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
  assert.deepEqual(Array.from(actual.warnings), []); assert.equal(actual.generation_limits, null);
  const warnings = [{ code: "possible_semantic_limit", message: "Check the ending; truncation is not confirmed.",
    evidence: "duration_near_configured_limit", semanticMaxTokens: 9000, approxMaxAudioSeconds: 360 }];
  const generationLimits = { semanticMaxTokens: 9000, approxMaxAudioSeconds: 360, source: "installed-sidecars" };
  completed = { ...completed, warnings, generationLimits };
  const qualified = await tool.run({ job_id: "native-id", timeout_seconds: 2 });
  assert.deepEqual(qualified.warnings, warnings); assert.deepEqual(qualified.generation_limits, generationLimits);
  assert.match(tool.description, /not confirmed truncation/);
  for (const missing of [undefined, null, NaN, Infinity, -1, 0]) {
    completed = { ...completed, audioSeconds: missing };
    const result = await tool.run({ job_id: "native-id", timeout_seconds: 2 });
    assert.equal(result.seconds, null, "Never substitute render time for unknown audio length");
    assert.equal(result.render_seconds, 22);
  }
});

await test("MCP list_songs retains persisted generation notices without re-inferring old takes", async () => {
  const src = text("./mcp.js"), start = src.indexOf('name: "list_songs"'), end = src.indexOf('name: "make_song"', start);
  const block = src.slice(src.lastIndexOf("  {", start), src.lastIndexOf("  {", end)).trim().replace(/,$/, "");
  const warnings = [{ code: "possible_semantic_limit", evidence: "duration_near_configured_limit", message: "Check the ending." }];
  const generationLimits = { semanticMaxTokens: 9000, approxMaxAudioSeconds: 360, source: "installed-sidecars" };
  const tool = runInNewContext(`(${block})`, { api: async (method, endpoint) => {
    assert.equal(method, "GET"); assert.equal(endpoint, "/api/status");
    return { library: [
      { file: "new.wav", durationSeconds: 360, warnings, generationLimits },
      { file: "old.wav", durationSeconds: 360 },
    ] };
  } }, { timeout: 1000 });
  const rows = await tool.run({});
  assert.deepEqual(rows[0].warnings, warnings); assert.deepEqual(rows[0].generation_limits, generationLimits);
  assert.deepEqual(Array.from(rows[1].warnings), []); assert.equal(rows[1].generation_limits, null);
  assert.equal((await tool.run({ limit: 1 })).length, 1);
});

await test("MCP polling timeout names only the requested job and never invents an ETA", async () => {
  const src = text("./mcp.js"), start = src.indexOf("async function waitForSong("), end = src.indexOf("async function waitForArt(", start);
  let status, reads = 0, now = 0;
  const wait = runInNewContext(`${src.slice(start, end)}; waitForSong`, {
    api: async (method, endpoint) => { assert.equal(method, "GET");
      if (endpoint.startsWith("/api/music-auditions?jobId=")) return { result: null };
      assert.equal(endpoint, "/api/status"); reads++; return status; },
    Date: { now: () => (now += 10) }, sleep: async () => {},
  }, { timeout: 1000 });
  for (const eta of [null, undefined, NaN, Infinity, -1, "10"]) {
    status = { current: { id: "mine", title: "Our take", stageLabel: "Generating audio", etaSeconds: eta } };
    await assert.rejects(wait("mine", 0), (e) => /Our take: Generating audio, ETA unavailable/.test(e.message)
      && /Nothing was cancelled/.test(e.message) && !/nulls|NaNs|undefineds|Infinitys/.test(e.message));
  }
  status = { current: { id: "mine", title: "Other engine take", etaSeconds: 18.4 } };
  await assert.rejects(wait("mine", 0), /about 18s left/);
  status = { current: { id: "other", title: "Someone else's private title", etaSeconds: 12 }, queue: [{ id: "mine" }] };
  await assert.rejects(wait("mine", 0), (e) => /still queued; ETA unavailable/.test(e.message)
    && !/Someone|12s|Still running/.test(e.message));
  status = { history: [{ id: "mine", state: "cancelled" }] };
  await assert.rejects(wait("mine", 100), /was cancelled/);
  status = {}; reads = 0;
  await assert.rejects(wait("missing", 1000), /No job with id/);
  assert.equal(reads, 2, "unknown ID gets one repoll, not a full render wait");
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
  const result = await tool.run({ engine: "yue2-gguf", caption: "Folk", lyrics: "We sing", precision: "q8_0",
    abc: "X:1\nQ:1/4=90", cot: "melody", cfg_scale: 2.5, nar_steps: 16, seed: 7 });
  assert.equal(result.job_id, "owned-native"); assert.equal(result.title, "Our take");
  assert.equal(requests[0].abc, "X:1\nQ:1/4=90"); assert.equal(requests[0].cfgScale, 2.5);
  assert.equal(requests[0].quantization, "q8_0");
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
