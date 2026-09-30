import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { refModName, h3OptionalOptions, normalizeRefMods, normalizeH3Tweaks, REFMOD_NODES, FIZGIG_NODE } from "./h3-refmod-options.js";
import { inspectRefModHeader, inspectRefModFile, listRefMods, refModReadiness, refModExtractGraph, createH3RefModService, createH3RefModRoutes } from "./h3-refmod.js";
import { h3RefModTools, h3OptionalMcpBody } from "./mcp-h3-refmods.js";
import { config } from "./config.js";
import { videoGraphH3, videoGraph } from "./workflow.js";

function fixture({ kind = "image", shape = [1, 24, 1, 4, 4], metadata = {}, bundle = false } = {}) {
  const bytes = shape.reduce((n, value) => n * value, 2);
  const member = { _format_version: 4, name: "hero", kind, latent_t: shape[2], latent_h: shape[3], latent_w: shape[4], ...metadata };
  const meta = bundle ? { _format_version: 5, kind: "bundle", members: [member] } : member;
  return { header: { __metadata__: { refmod_meta: JSON.stringify(meta) }, [bundle ? "ref_0" : "latent"]: { dtype: "F16", shape, data_offsets: [0, bytes] } }, bytes };
}
async function saveFixture(file, item = fixture()) {
  const text = Buffer.from(JSON.stringify(item.header));
  const header = Buffer.alloc(Math.ceil(text.length / 8) * 8, 32); text.copy(header);
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(header.length));
  await writeFile(file, Buffer.concat([length, header, Buffer.alloc(item.bytes)]));
}
function nodeFixture(names = ["hero"]) {
  const loader = { show_info: ["BOOLEAN"], max_total_tokens: ["INT"] };
  for (let i = 1; i <= 8; i++) Object.assign(loader, { [`mod_${i}`]: ["COMBO", { options: ["(none)", ...names] }], [`strength_${i}`]: ["FLOAT"], [`copies_${i}`]: ["INT"] });
  const fields = (names) => Object.fromEntries(names.map((name) => [name, ["FLOAT"]]));
  return {
    [REFMOD_NODES.loader]: { output: ["H3_REF_MODS", "STRING"], input: { required: loader } },
    [REFMOD_NODES.apply]: { input: { required: { conditioning: ["COMFY_MATCHTYPE_V3", { template: { allowed_types: "MINIMAX_H3_COND,CONDITIONING", template_id: "cond" } }], mods: ["H3_REF_MODS"], override: ["BOOLEAN"], retention: ["FLOAT"],
      curve_direction: ["COMBO", { options: ["constant", "concept_at_start"] }], curve_shape: [["linear", "ease"]], curve_value: ["FLOAT"], scramble_seed: ["INT"], max_total_tokens: ["INT"] } } },
    [REFMOD_NODES.extract]: { output_node: true, input: { required: { ...fields(["name", "concept_type", "vae", "ref_resolution", "pool_h", "pool_w", "latent_frames", "identity", "merge", "motion_only", "multiplier", "max_tokens", "description", "save", "background_retention"]), mode: ["COMBO", { options: ["encode", "training"] }], budget_policy: [["truncate", "error"]] }, optional: { refs_image: ["AUTOGROW"] } } },
    [FIZGIG_NODE]: { output: ["MODEL"], input: { required: { model: ["MODEL"], high_freq_detail: ["FLOAT"], detail_mode: ["COMBO", { options: ["stable across frames", "per frame"] }], composition: ["FLOAT"], prompt_strength: ["FLOAT"], report: ["BOOLEAN"] } } },
  };
}

test("cache identifiers and numeric controls refuse paths, coercion and unbounded input", () => {
  assert.equal(refModName("characters\\hero.safetensors"), "characters/hero");
  for (const name of ["../secret", "/secret", "C:\\secret", "x/../y", "\\\\server\\share", "CON", "name.", "x//y", "http://example.test/file"]) assert.throws(() => refModName(name));
  for (const strength of ["1", NaN, Infinity, -1, 1.1]) assert.throws(() => normalizeRefMods([{ name: "hero", strength }]));
  assert.throws(() => normalizeRefMods([{ name: "hero", copies: 5 }]));
  assert.throws(() => h3OptionalOptions({ refModOptions: { maxTokens: 0 } }));
  assert.deepEqual(normalizeRefMods([{ name: "hero", strength: 0 }]), []);
  assert.equal(normalizeH3Tweaks({}), null);
  assert.equal(normalizeH3Tweaks({ detail: 0, composition: 0, promptStrength: 0 }), null);
  assert.throws(() => normalizeH3Tweaks({ promptStrength: 3.1 }));
});

test("header inspection validates exact tensor layouts, offsets, metadata and budget", () => {
  const item = fixture(); assert.equal(inspectRefModHeader(item.header, item.bytes).tokens, 4);
  const bundle = fixture({ bundle: true }); assert.equal(inspectRefModHeader(bundle.header, bundle.bytes).kind, "bundle");
  const sidecar = structuredClone(item.header), meta = JSON.parse(sidecar.__metadata__.refmod_meta); delete sidecar.__metadata__;
  assert.equal(inspectRefModHeader(sidecar, item.bytes, meta).tokens, 4);
  for (const shape of [[1, 16, 1, 4, 4], [1, 24, 1, 3, 4], [1, 24, 2, 4, 4], [2, 24, 1, 4, 4]]) {
    const bad = fixture({ shape }); assert.throws(() => inspectRefModHeader(bad.header, bad.bytes), /shape/);
  }
  const mismatch = fixture({ metadata: { latent_h: 8 } }); assert.throws(() => inspectRefModHeader(mismatch.header, mismatch.bytes), /differs/);
  const badOffsets = fixture(); badOffsets.header.latent.data_offsets = [1, badOffsets.bytes + 1]; assert.throws(() => inspectRefModHeader(badOffsets.header, badOffsets.bytes), /offsets/);
  const extra = fixture(); extra.header.unsafe = extra.header.latent; assert.throws(() => inspectRefModHeader(extra.header, extra.bytes), /Unexpected/);
  const huge = fixture({ kind: "video", shape: [1, 24, 100, 64, 64] }); assert.throws(() => inspectRefModHeader(huge.header, huge.bytes), /tokens/);
  const badVersion = fixture({ metadata: { _format_version: 99 } }); assert.throws(() => inspectRefModHeader(badVersion.header, badVersion.bytes), /version/);
});

test("portable file catalogue reads embedded and bounded legacy JSON, refuses duplicates and outside files", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "aiplay-refmod-test-"));
  try {
    const root = path.join(temp, "root"), second = path.join(temp, "second"); await mkdir(root); await mkdir(second);
    await saveFixture(path.join(root, "hero.safetensors"));
    const legacy = fixture(), meta = JSON.parse(legacy.header.__metadata__.refmod_meta); delete legacy.header.__metadata__;
    await saveFixture(path.join(root, "legacy.safetensors"), legacy); await writeFile(path.join(root, "legacy.json"), JSON.stringify(meta));
    await writeFile(path.join(root, "bad.safetensors"), Buffer.alloc(10));
    assert.equal((await inspectRefModFile(root, path.join(root, "hero.safetensors"))).tokens, 4);
    assert.equal((await inspectRefModFile(root, path.join(root, "legacy.safetensors"))).tokens, 4);
    const listed = await listRefMods([root]); assert.deepEqual(listed.entries.map((row) => row.name), ["hero", "legacy"]); assert.equal(listed.problems.length, 1);
    await saveFixture(path.join(second, "hero.safetensors"));
    const duplicate = await listRefMods([root, second]); assert.deepEqual(duplicate.entries.map((row) => row.name), ["legacy"]); assert.match(duplicate.problems.at(-1).error, /Duplicate/);
    await assert.rejects(inspectRefModFile(root, path.join(second, "hero.safetensors")), /outside/);
    const overflow = Buffer.alloc(8); overflow.writeBigUInt64LE(1048577n); await writeFile(path.join(root, "oversize.safetensors"), Buffer.concat([overflow, Buffer.alloc(10)]));
    await assert.rejects(inspectRefModFile(root, path.join(root, "oversize.safetensors")), /large or truncated/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("native optional graph uses matched ref2va/Turbo and preserves frame and soundtrack guide order", () => {
  const h3 = config.video.engines.h3, saved = { ...h3 };
  Object.assign(h3, { dit: "fl2va.safetensors", ditRef: "ref2va.safetensors", turboLora: "fl8.safetensors", turboLora4: "fl4.safetensors", refTurboLora: "ref8.safetensors", refTurboLora4: "ref4.safetensors", sparse: "off", bridge: "off", blockCache: false });
  try {
    const base = { prompt: "A singer turns", seed: 7, width: 640, height: 352, seconds: 2, steps: 8, sparse: "off" };
    const native = videoGraphH3(base); assert.deepEqual(videoGraphH3({ ...base, refMods: [], h3Tweaks: {} }), native);
    const g = videoGraphH3({ ...base, refMods: [{ name: "hero", strength: 0.7, copies: 2 }], firstFrame: "opening.png", lastFrame: "closing.png", audioTrack: { name: "song.flac", start: 3 } });
    assert.equal(g[1].inputs.unet_name, "ref2va.safetensors"); assert.equal(g[18].inputs.lora_name, "ref8.safetensors");
    assert.equal(g[5].class_type, "MiniMaxH3ReferenceToVideo"); assert.equal(g[83].class_type, REFMOD_NODES.loader);
    assert.equal(g[83].inputs.mod_1, "hero"); assert.equal(g[83].inputs.copies_1, 2); assert.equal(g[83].inputs.mod_8, "(none)");
    assert.deepEqual(g[84].inputs.conditioning, ["5", 0]); assert.equal(g[84].inputs.max_total_tokens, 8192);
    assert.deepEqual(g[21].inputs.positive, ["84", 0]); assert.deepEqual(g[22].inputs.positive, ["21", 0]); assert.deepEqual(g[23].inputs.positive, ["22", 0]); assert.deepEqual(g[7].inputs.conditioning, ["23", 0]);
    assert.equal(videoGraphH3({ ...base, steps: 4, refMods: [{ name: "hero" }] })[18].inputs.lora_name, "ref4.safetensors");
    assert.equal(videoGraphH3({ ...base, steps: 20, refMods: [{ name: "hero" }] })[18], undefined);
    const off = videoGraphH3({ ...base, refMods: [{ name: "hero" }], refModOptions: { retention: 0 } }); assert.deepEqual(off, native);
    const tweak = videoGraphH3({ ...base, h3Tweaks: { detail: 0.1, promptStrength: 0.2 }, attention: "ck", loras: [{ name: "custom.safetensors", strength: 1 }] });
    assert.deepEqual(tweak[86].inputs.model, ["90", 0]); assert.deepEqual(tweak[85].inputs.model, ["86", 0]); assert.deepEqual(tweak[6].inputs.model, ["85", 0]);
    assert.equal(tweak[86].inputs.prompt_strength, 0.2); assert.equal(tweak[86].inputs.report, false);
    for (const patch of [{ sparse: "sol-attn" }, { blockCache: true }, { bridge: "adapter.safetensors", bridgeAlpha: 0.1 }, { controlVideo: "source.mp4", controlPatch: "patch.safetensors" }, { h3Tweaks: { detail: 0.1 } }]) assert.throws(() => videoGraphH3({ ...base, refMods: [{ name: "hero" }], ...patch }));
    assert.throws(() => videoGraph({ ...base, engine: "ltx", refMods: [{ name: "hero" }] }), /require MiniMax H3/);
    assert.throws(() => videoGraphH3({ ...base, engine: "fasth3", refMods: [{ name: "hero" }] }), /require MiniMax H3/);
  } finally { for (const key of Object.keys(h3)) if (!(key in saved)) delete h3[key]; Object.assign(h3, saved); }
});

test("installed schema and local token budget gate real extraction and render requests without GPU work", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "aiplay-refmod-service-"));
  try {
    await saveFixture(path.join(temp, "hero.safetensors"));
    let nodes = nodeFixture(); const queued = [], staged = [];
    const service = createH3RefModService({ config: { video: { engines: { h3: { videoVae: "h3_vae.safetensors", sparse: "off" } } } }, roots: () => [temp],
      objectInfo: async (name) => ({ [name]: nodes[name] }), stageImage: async (name) => { staged.push(name); return "aiplay_frame_0123456789ab.png"; },
      submit: async (spec) => { queued.push(spec); return { file: "refmod:job", queued: true }; } });
    assert.equal(refModReadiness(nodes).canLoad, true); assert.deepEqual(refModReadiness(nodes).names, ["hero"]);
    assert.equal((await service.checkRender({ refMods: [{ name: "hero", copies: 2 }] })).tokens, 8);
    await assert.rejects(service.checkRender({ refMods: [{ name: "hero", copies: 2 }], refModOptions: { maxTokens: 7 } }), /need 8 tokens/);
    await assert.rejects(service.checkRender({ refMods: [{ name: "absent" }] }), /does not list/);
    const created = await service.create({ name: "new_hero", images: ["library.png"] }, { actor: "agent:test" });
    assert.equal(created.name, "new_hero"); assert.deepEqual(staged, ["library.png"]); assert.equal(queued.length, 1);
    assert.equal(queued[0].actor, "agent:test"); assert.equal(queued[0].adopt, false); assert.equal(queued[0].graph[2].inputs.identity, 0);
    assert.equal(queued[0].graph[2].inputs.budget_policy, "error"); assert.deepEqual(queued[0].graph[2].inputs["refs_image.ref_image_1"], ["10", 0]);
    assert.equal(Object.values(queued[0].graph).some((node) => /UNET|Sampler|CLIP/.test(node.class_type)), false);
    await assert.rejects(service.create({ name: "new_hero", images: ["library.png"] }), /already queued/);
    assert.equal(service.complete("new_hero"), true); await service.create({ name: "new_hero", images: ["library.png"] });
    await assert.rejects(service.create({ name: "hero", images: ["library.png"] }), /already exists/);
    delete nodes[REFMOD_NODES.apply]; await assert.rejects(service.checkRender({ refMods: [{ name: "hero" }] }), /compatible MiniMaxH3Mod/);
    nodes = nodeFixture(); delete nodes[REFMOD_NODES.extract].input.required.budget_policy;
    await assert.rejects(service.create({ name: "other", images: ["library.png"] }), /compatible MiniMaxH3Mod/);
    assert.throws(() => refModExtractGraph({ name: "x", images: ["a.png"], pool: 3 }, { videoVae: "v.safetensors" }), /even/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("same-origin route and MCP share bounded API fields and preserve errors", async () => {
  const replies = [], called = [];
  const route = createH3RefModRoutes({ json: (_, code, body) => replies.push({ code, body }), readBody: async (req) => req.body,
    sameOriginLocalJson: (req) => req.local === true, actorFrom: () => "agent:caller",
    service: { status: async () => ({ ready: false }), create: async (...args) => { called.push(args); return { ok: true }; } } });
  const url = new URL("http://localhost/api/h3-refmods");
  assert.equal(await route({ method: "GET" }, {}, url), true); assert.equal(replies.at(-1).code, 405);
  await route({ method: "POST", body: { action: "create" } }, {}, url); assert.equal(replies.at(-1).code, 403); assert.equal(called.length, 0);
  await route({ method: "POST", body: { action: "create" }, local: true }, {}, url); assert.equal(called[0][1].actor, "agent:caller");
  const requests = [], tools = h3RefModTools(async (...args) => { requests.push(args); return { ready: false }; });
  await tools[0].run({}); await tools[1].run({ name: "hero" }); await tools[2].run({ name: "new", images: ["x.png"], mode: "encode", refinement_steps: 100, max_tokens: 1024 });
  assert.ok(requests.every((args) => args[0] === "POST" && args[1] === "/api/h3-refmods"));
  assert.equal(requests[2][2].refinementSteps, 100); assert.equal(requests[2][2].maxTokens, 1024);
  assert.deepEqual(h3OptionalMcpBody({}, "h3"), {});
  assert.equal(h3OptionalMcpBody({ ref_mods: [{ name: "hero" }], ref_mod_options: { max_tokens: 1024 } }, "h3").refModOptions.maxTokens, 1024);
  assert.equal(h3OptionalMcpBody({ h3_tweaks: { detail: 0.1, prompt_strength: 0.2 } }, "h3").h3Tweaks.promptStrength, 0.2);
  await assert.rejects(h3RefModTools(async () => ({ error: "missing pack" }))[0].run({}), /missing pack/);
});

test("concurrent creation reserves the cache name before staging and releases it on a staging failure", { timeout: 3000 }, async () => {
  let releaseStage, enteredStage;
  const held = new Promise((resolve) => { releaseStage = resolve; });
  const entered = new Promise((resolve) => { enteredStage = resolve; });
  const nodes = nodeFixture([]), submitted = [];
  const service = createH3RefModService({ config: { video: { engines: { h3: { videoVae: "h3.safetensors" } } } }, roots: () => [],
    objectInfo: async (name) => ({ [name]: nodes[name] }), submit: async (spec) => { submitted.push(spec); return { queued: true }; },
    stageImage: async (name) => { if (name === "slow.png") { enteredStage(); await held; } if (name === "missing.png") throw new Error("source missing"); return "staged.png"; } });
  const first = service.create({ name: "race", images: ["slow.png"] });
  await entered;
  await assert.rejects(service.create({ name: "race", images: ["fast.png"] }), /already queued/);
  releaseStage(); await first; assert.equal(submitted.length, 1);
  await assert.rejects(service.create({ name: "retry", images: ["missing.png"] }), /source missing/);
  await service.create({ name: "retry", images: ["fast.png"] }); assert.equal(submitted.length, 2);
  const changed = nodeFixture(); changed[REFMOD_NODES.apply].input.required.conditioning[1].template.allowed_types = "MINIMAX_H3_COND";
  assert.equal(refModReadiness(changed).canLoad, false);
  const old = nodeFixture(); old[REFMOD_NODES.extract].output_node = false; assert.equal(refModReadiness(old).canCreate, false);
});

test("a custom Video workflow refuses active native options before node discovery or file inspection", async () => {
  let assignedReads = 0, nodeReads = 0, fileScans = 0;
  const service = createH3RefModService({ config: { video: { engines: { h3: { bridge: "off", sparse: "off" } } } },
    workflowAssigned: () => { assignedReads++; return "custom-video-workflow"; },
    objectInfo: async () => { nodeReads++; throw new Error("Node discovery must not be reached"); },
    roots: () => { fileScans++; throw new Error("Cache inspection must not be reached"); } });
  for (const body of [{ refMods: [{ name: "singer" }] }, { h3Tweaks: { detail: 0.1 } }]) {
    await assert.rejects(service.checkRender(body, { engine: "h3" }), /native H3 workflow.*Unassign the custom Video workflow/);
  }
  assert.equal(assignedReads, 2);
  assert.equal(nodeReads, 0);
  assert.equal(fileScans, 0);
  const bypass = await service.checkRender({ refMods: [{ name: "singer", strength: 0 }], h3Tweaks: { detail: 0 } }, { engine: "h3" });
  assert.deepEqual(bypass.refMods, []);
  assert.equal(bypass.h3Tweaks, null);
  assert.equal(bypass.tokens, 0);
  assert.equal(assignedReads, 2, "inactive optional controls retain the existing custom workflow behavior");
});

test("inactive cache controls stay text-only and active caches choose the matched reference Fast build", async () => {
  const panel = (await readFile(new URL("../web/h3-refmods.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const app = (await readFile(new URL("../web/app.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const body = /  function spec\(\) \{[\s\S]*?\n  \}/.exec(panel)?.[0];
  assert.ok(body, "exercise the panel's actual submission function");
  const values = { h3CacheRetention: "1", h3CacheBudget: "8192", h3TweakDetail: "0", h3TweakScene: "0", h3TweakPrompt: "0", h3TweakMode: "stable across frames" };
  const rows = [{ name: "singer", strength: 0, copies: 1 }];
  let engine = "h3";
  const spec = new Function("getEngine", "find", "rows", `${body}\nreturn spec;`)(() => engine, (id) => ({ value: values[id] }), rows);
  const keepingLine = /\n  const keeping = [^\n]+;/.exec(app)?.[0];
  assert.ok(keepingLine?.includes("h3RefModPanel"), "the Fast chip reads the active cache selection");
  const keeping = new Function("$", "state", "cur", "h3RefModPanel", `${keepingLine}\nreturn keeping;`);
  const retained = () => keeping(() => null, { refImages: [] }, engine, { spec });
  const qualitySrc = /\nfunction vidQualitySteps\(eng, keeping = false\) \{[\s\S]*?\n\}/.exec(app)?.[0];
  const speedSrc = /\nfunction vidSpeedupNeed\(eng, steps, hasRefs\) \{[\s\S]*?\n\}/.exec(app)?.[0];
  const quality = new Function(`${qualitySrc}\nreturn vidQualitySteps;`)();
  const speed = new Function("VID_SPEEDUP_ROWS", `${speedSrc}\nreturn vidSpeedupNeed;`)({ 3: "three", 4: "four", 8: "eight" });
  const eng = { stepDefaults: { fast: 3, standard: 4, best: 20 }, referenceSteps: 8, keepFast: { steps: 4 }, turboBuilds: { three: true, four: false, eight: false } };
  for (const inactive of [() => { rows[0].strength = 0; values.h3CacheRetention = "1"; },
    () => { rows[0].strength = 1; values.h3CacheRetention = "0"; }]) {
    inactive();
    assert.deepEqual(spec(), {});
    assert.equal(retained(), false);
    assert.deepEqual(h3OptionalOptions(spec()).refMods, []);
    assert.equal(quality(eng, retained()).fast, 3);
    assert.equal(speed(eng, 3, !!spec().refMods?.length), null, "zero cache settings do not require the missing reference 4-step build");
  }
  values.h3CacheRetention = "1";
  assert.equal(retained(), true);
  assert.equal(quality(eng, retained()).fast, 4, "cache-only Fast uses the actual reference checkpoint's matched count");
  assert.equal(quality(eng, retained()).standard, 8);
  assert.deepEqual(speed(eng, 3, !!spec().refMods?.length), { build: 4, row: "four" });
  rows.push({ name: "disabled", strength: 0, copies: 1 });
  assert.equal(spec().refMods.length, 1, "disabled rows stay visible in the controls but do not ride on a render");
  engine = "fasth3";
  assert.deepEqual(spec(), {});
  assert.equal(retained(), false);
});
