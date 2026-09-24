/** Exercise the actual /api/image handler with a stub queue and runtime. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { qwenImageGraph, QWEN_IMAGE_PRESET, QWEN_DRAFT, qwenImageSettings } from "./qwen-image.js";
import { QWEN_IMAGE_ENGINE } from "./qwen-status.js";
import { applyPersona, personaFits } from "./personas.js";
import { jobIdentity } from "./wildcards.js";
import { safetyRefusal } from "./safety/refusal.js";

const source = readFileSync(new URL("./index.js", import.meta.url), "utf8");
const start = source.indexOf('if (p === "/api/image" && req.method === "POST")');
const end = source.indexOf('if (p === "/api/', start + 20);
assert.ok(start > 0 && end > start);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = new AsyncFunction("deps", `const { p,req,res,readBody,json,config,path,qwenImageGraph,QWEN_IMAGE_PRESET,QWEN_DRAFT,qwenImageSettings,QWEN_IMAGE_ENGINE,qwenImageStatus,hasWildcards,expand,personas,personaFits,stageQwenReferences,COVER_DIR,IMAGE_DIR,applyPersona,pendingImagePrompt,pendingImageActor,pendingImageWild,prov,resolveRepeat,imageDupGuard,art,combinations,imageEditor,safetyRefusal,lineage }=deps; ${source.slice(start, end)}`);

const flattenReferences = async (references) => references.map((row) => row.name);

async function request(body, { ready = true, persona = null, stageError = null, readiness = null } = {}) {
  const queued = [], preflights = [], staged = [], stagedWith = [];
  const deps = {
    p: "/api/image", req: { method: "POST" }, res: {}, readBody: async () => ({ action: "create", ...body }),
    json: (_, status, result) => ({ status, body: result }), path,
    config: { image: { engine: QWEN_IMAGE_ENGINE }, art: { size: 1024, steps: 4 }, inputDir: "input" },
    qwenImageGraph, QWEN_IMAGE_PRESET, QWEN_DRAFT, qwenImageSettings, QWEN_IMAGE_ENGINE,
    qwenImageStatus: async ({ options } = {}) => { preflights.push(options); if (readiness) return readiness(options); return { ready, filesReady: ready, runtimeReady: ready, missingFiles: [], missingNodes: ready ? [] : ["TextEncodeQwenImage21"], error: ready ? null : "Missing runtime" }; },
    hasWildcards: () => false, expand: (prompt) => ({ prompt, choices: [] }),
    personas: { get: async () => persona }, personaFits, applyPersona,
    stageQwenReferences: async (names, options) => { staged.push(names); stagedWith.push(options); if (stageError) throw new Error(stageError); return names.map((name) => `staged-${name}`); },
    COVER_DIR: "covers", IMAGE_DIR: "images",
    pendingImagePrompt: new Map(), pendingImageActor: new Map(), pendingImageWild: new Map(),
    prov: { actorFrom: () => "agent:test" }, resolveRepeat: () => ({}), imageDupGuard: { remember() {} },
    art: { request: (shot) => { queued.push(shot); return { id: "job" }; }, status: () => ({}) }, combinations: () => 1,
    imageEditor: { flattenReferences },
    /* The minors rule (server/safety): the REAL check, and no library lineage. */
    safetyRefusal, lineage: () => ({ texts: [], flags: [] }),
  };
  return { ...await run(deps), queued, preflights, staged, stagedWith };
}

test("omitted engine chooses Qwen, keeps its own preset, and refuses unavailable runtime before queueing", async () => {
  const blocked = await request({ prompt: "a lighthouse" }, { ready: false });
  assert.equal(blocked.status, 400); assert.equal(blocked.queued.length, 0);
  assert.deepEqual(blocked.body.missingNodes, ["TextEncodeQwenImage21"]);
  const ok = await request({ prompt: "a lighthouse", seed: 8 });
  assert.equal(ok.status, 200);
  const shot = ok.queued[0];
  assert.equal(shot.video.engine, "qwen-image-2.1");
  assert.equal(shot.video.steps, 25, "never inherits FLUX's four steps");
  assert.equal(shot.video.cfg, 1);
  assert.equal(shot.actor, "agent:test");
});

test("reference/alpha settings and persona ordering reach the queue; missing refs do not", async () => {
  const result = await request({ prompt: "Alex in a forest", persona: "Alex", refImages: ["scene.png"], refSizing: "custom", refResolution: 1536, transparent: true, width: 1536, height: 1024, negative: "blur", cfg: 2 }, { persona: { name: "Alex", fragment: "red coat", refImages: ["face.png"] } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.staged[0], ["face.png", "scene.png"]);
  const video = result.queued[0].video;
  assert.deepEqual(video.refImages, ["staged-face.png", "staged-scene.png"]);
  assert.equal(video.refSizing, "custom"); assert.equal(video.refResolution, 1536); assert.equal(video.transparent, true);
  const graph = qwenImageGraph({ ...video, seed: result.queued[0].seed });
  assert.deepEqual(graph[7].inputs, { width: 1536, height: 1024, batch_size: 1 });
  assert.equal(result.preflights.at(-1).refImages.length, 2);
  const missing = await request({ prompt: "x", refImages: ["gone.png"] }, { stageError: "Reference image is missing" });
  assert.equal(missing.status, 400); assert.equal(missing.queued.length, 0);
});

test("a reference reaches Qwen over white unless transparency is asked for or the caller keeps its own", async () => {
  const flattenWith = async (body) => {
    const result = await request({ prompt: "x", persona: "Alex", refImages: ["cut.png"], ...body }, { persona: { name: "Alex", fragment: "red coat", refImages: ["face.png"] } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.staged[0], ["face.png", "cut.png"], "persona references go through the same staging");
    return result.stagedWith[0].flatten;
  };
  assert.equal(await flattenWith({}), flattenReferences, "an opaque request sends what the vision tower sees");
  assert.equal(await flattenWith({ transparent: true }), null, "a transparent request keeps its references as they are");
  assert.equal(await flattenWith({ refAlpha: "keep" }), null);
  assert.equal(await flattenWith({ transparent: true, refAlpha: "white" }), flattenReferences);
  for (const refAlpha of ["none", true, ""]) {
    const refused = await request({ prompt: "x", refImages: ["cut.png"], refAlpha });
    assert.equal(refused.status, 400); assert.equal(refused.queued.length, 0); assert.equal(refused.staged.length, 0);
  }
  // The editor flattens its extra references itself; its frozen source keeps
  // the alpha a masked edit composites through.
  const editor = source.slice(source.indexOf("const imageEditor = createImageEditor("), source.indexOf("async register(name, metadata, actor)"));
  assert.match(editor, /body: JSON\.stringify\(\{ \.\.\.body, refAlpha: "keep" \}\)/);
});

test("invalid native options never reach the queue and Qwen image identities include edit settings", async () => {
  for (const extra of [{ engine: "unknown" }, { dit: "qwen.gguf" }, { negative: "blur" }, { refImages: Array(11).fill("x.png") }, { refImages: "x.png" }, { sampler: "wrong" }, { transparent: "true" }]) {
    const result = await request({ prompt: "x", ...extra });
    assert.equal(result.status, 400); assert.equal(result.queued.length, 0);
  }
  const job = { engine: "qwen-image-2.1", prompt: "x", seed: 1 };
  const base = jobIdentity(job);
  for (const extra of [{ transparent: true }, { refSizing: "custom" }, { refResolution: 2048 }, { dit: "other.safetensors" }]) assert.notEqual(jobIdentity({ ...job, ...extra }), base);
});

test("Fast draft: queued with its flag, 5 steps and CFG 1; refused with a sentence off Qwen and on every base-only case", async () => {
  const R = QWEN_DRAFT.refusals;
  const ok = await request({ prompt: "a storyboard frame", seed: 5, draft: true, steps: 5, cfg: 1, sampler: "euler", scheduler: "simple" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const video = ok.queued[0].video;
  assert.equal(video.draft, true);
  assert.equal(video.steps, 5, "the route records what the graph samples, not the base's 25");
  assert.equal(video.cfg, 1);
  assert.equal(ok.body.draft, true, "the answer says it was a draft");
  assert.equal(ok.preflights.at(-1).draft, true, "readiness is asked for a draft, so the LoRA is checked");
  const graph = qwenImageGraph({ ...video, seed: ok.queued[0].seed });
  assert.equal(graph[8].class_type, "SamplerCustomAdvanced");
  assert.equal(qwenImageSettings(graph).lora, QWEN_DRAFT.lora);

  const plain = await request({ prompt: "a storyboard frame", seed: 5 });
  assert.equal(plain.status, 200);
  assert.ok(!("draft" in plain.queued[0].video), "a full render's job is unchanged");
  assert.equal(plain.body.draft, undefined);
  const off = await request({ prompt: "x", draft: false });
  assert.equal(off.status, 200); assert.ok(!("draft" in off.queued[0].video));

  const refusals = [
    [{ engine: "flux2", draft: true }, R.engine],
    [{ engine: "zimage", draft: true }, R.engine],
    [{ engine: "checkpoint", checkpoint: "", draft: true }, R.engine],
    [{ draft: "true" }, R.type],
    [{ draft: true, transparent: true }, R.transparent],
    [{ draft: true, refImages: ["1.png", "2.png", "3.png", "4.png"] }, R.refs],
    [{ draft: true, cfg: 2, negative: "blur" }, R.cfg],
    [{ draft: true, negative: "blur" }, R.negative],
    [{ draft: true, steps: 25 }, R.steps],
  ];
  for (const [body, sentence] of refusals) {
    const refused = await request({ prompt: "x", ...body });
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.equal(refused.body.error, sentence, JSON.stringify(body));
    assert.equal(refused.queued.length, 0);
    assert.equal(refused.staged.length, 0, "refused before anything is copied");
  }
  // A character's pictures count toward the three, and the refusal comes first.
  const persona = { name: "Alex", fragment: "red coat", refImages: ["face.png", "side.png"] };
  const crowded = await request({ prompt: "Alex", persona: "Alex", refImages: ["a.png", "b.png"], draft: true }, { persona });
  assert.equal(crowded.status, 400); assert.equal(crowded.body.error, R.refs);
  assert.equal(crowded.staged.length, 0); assert.equal(crowded.queued.length, 0);
  const fits = await request({ prompt: "Alex", persona: "Alex", refImages: ["a.png"], draft: true }, { persona });
  assert.equal(fits.status, 200, JSON.stringify(fits.body));
  assert.deepEqual(fits.queued[0].video.refImages, ["staged-face.png", "staged-side.png", "staged-a.png"], "the character first, three in all");
  assert.equal(fits.preflights.at(-1).refImages.length, 3);
});

test("a draft is its own identity for the repeat guard, and a full render's key is unchanged", () => {
  const job = { engine: "qwen-image-2.1", prompt: "x", seed: 1, steps: 5, cfg: 1 };
  assert.notEqual(jobIdentity({ ...job, draft: true }), jobIdentity(job));
  assert.equal(jobIdentity({ ...job, draft: false }), jobIdentity(job));
  const route = source.slice(start, end);
  assert.match(route, /dit: b\.dit, encoder: b\.encoder, vae: b\.vae, draft: b\.draft === true \}/, "the route hands it to the guard");
});

test("a draft missing only its LoRA points at the Fast draft row, not the installed Qwen one", async () => {
  const lora = QWEN_DRAFT.lora;
  const answer = (missingFiles) => () => ({ ready: false, filesReady: false, runtimeReady: true, missingFiles, missingNodes: [],
    error: "missing", draft: { lora, fileReady: !missingFiles.includes(lora) } });
  const onlyLora = await request({ prompt: "x", draft: true }, { readiness: answer([lora]) });
  assert.equal(onlyLora.status, 400); assert.equal(onlyLora.queued.length, 0);
  assert.equal(onlyLora.body.needsModel, QWEN_DRAFT.capability);
  const both = await request({ prompt: "x", draft: true }, { readiness: answer(["qwen_image_2.1_vae_bf16.safetensors", lora]) });
  assert.equal(both.body.needsModel, QWEN_IMAGE_ENGINE, "the model itself first");
  const base = await request({ prompt: "x" }, { readiness: answer(["qwen_image_2.1_vae_bf16.safetensors"]) });
  assert.equal(base.body.needsModel, QWEN_IMAGE_ENGINE);
  const stand = await request({ prompt: "x", draft: true }, { readiness: () => ({ ...answer(["my-turbo.safetensors"])(), draft: { lora: "my-turbo.safetensors", fileReady: false } }) });
  assert.equal(stand.body.needsModel, QWEN_DRAFT.capability, "a stand-in chosen in Models is still the draft's file");
});

test("Fast draft refuses a canvas past the measured ~2 MP, and a null reference size is the base's 1024", async () => {
  const R = QWEN_DRAFT.refusals;
  for (const body of [{ width: 2048, height: 2048 }, { width: 4096, height: 4096 }, { refImages: ["a.png"], refResolution: 2048 }]) {
    const refused = await request({ prompt: "x", draft: true, ...body });
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.equal(refused.body.error, R.size, JSON.stringify(body));
    assert.equal(refused.queued.length, 0); assert.equal(refused.staged.length, 0);
  }
  for (const body of [{ width: 1920, height: 1088 }, { width: 2048, height: 1024 }, { refImages: ["a.png"], refResolution: 1440 }, { refImages: ["a.png"], refResolution: null }]) {
    const ok = await request({ prompt: "x", draft: true, ...body });
    assert.equal(ok.status, 200, `${JSON.stringify(body)} ${JSON.stringify(ok.body)}`);
  }
  const full = await request({ prompt: "x", width: 4096, height: 4096 });
  assert.equal(full.status, 200, "the full render keeps its 4096 range");
});
