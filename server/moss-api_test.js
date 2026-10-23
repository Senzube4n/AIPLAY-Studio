/** Run the actual HTTP image handler, with an isolated queue/runtime seam. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mossImageOptions, MOSS_IMAGE_ENGINE, MOSS_IMAGE_PRESET } from "./moss-image.js";
import { QWEN_IMAGE_ENGINE } from "./qwen-status.js";
import { QWEN_DRAFT } from "./qwen-image.js";
import { applyPersona, personaFits } from "./personas.js";
import { safetyRefusal } from "./safety/refusal.js";

const source = readFileSync(new URL("./index.js", import.meta.url), "utf8");
const start = source.indexOf('if (p === "/api/image" && req.method === "POST")');
const end = source.indexOf('if (p === "/api/', start + 20);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = new AsyncFunction("d", `const { p,req,res,readBody,json,config,path,mossImageOptions,MOSS_IMAGE_ENGINE,MOSS_IMAGE_PRESET,mossImageStatus,QWEN_IMAGE_ENGINE,QWEN_DRAFT,hasWildcards,expand,personas,personaFits,applyPersona,pendingImagePrompt,pendingImagePrivate,pendingImageActor,pendingImageWild,prov,resolveRepeat,imageDupGuard,art,combinations,safetyRefusal,lineage,randomUUID,Math,assignedTo }=d; ${source.slice(start, end)}`);
async function request(body, ready = true, custom = false) {
  const queued = [], checked = [];
  const controlledMath = Object.create(Math); controlledMath.random = () => 0.25;
  const d = {
    p: "/api/image", req: { method: "POST", headers: {} }, res: {}, readBody: async () => ({ action: "create", engine: MOSS_IMAGE_ENGINE, ...body }),
    json: (_, status, result) => ({ status, body: result }), path,
    config: { image: { engine: QWEN_IMAGE_ENGINE }, art: { size: 1024, steps: 4 }, inputDir: "input" },
    mossImageOptions, MOSS_IMAGE_ENGINE, MOSS_IMAGE_PRESET, QWEN_IMAGE_ENGINE, QWEN_DRAFT, assignedTo: () => custom ? "custom-cover" : null,
    mossImageStatus: async ({ options } = {}) => { checked.push(options); return { mossRecipe: "fixture-recipe", ready, missingFiles: [], missingNodes: [], runtimeReady: ready, filesReady: true, error: ready ? null : "Native MOSS runtime unavailable" }; },
    hasWildcards: () => false, expand: prompt => ({ prompt, choices: [] }), personas: { get: async () => null }, personaFits, applyPersona,
    pendingImagePrompt: new Map(), pendingImagePrivate: new Map(), pendingImageActor: new Map(), pendingImageWild: new Map(), randomUUID,
    prov: { actorFrom: () => "agent:test" }, resolveRepeat: () => ({}), imageDupGuard: { remember() {} },
    art: { request: shot => { queued.push(shot); return { id: "test-job" }; }, status: () => ({}) }, combinations: () => 1,
    safetyRefusal, lineage: () => ({ texts: [], flags: [] }), Math: controlledMath,
  };
  return { ...await run(d), queued, checked };
}
test("MOSS API queues its own exact recipe and preserves explicit and random seeds", async () => {
  const result = await request({ prompt: "A lighthouse", seed: 8 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const shot = result.queued[0];
  assert.equal(shot.video.engine, MOSS_IMAGE_ENGINE); assert.equal(shot.seed, 8);
  assert.equal(shot.video.steps, 25); assert.equal(shot.video.cfg, 2.5);
  assert.equal(shot.video.sampler, "er_sde"); assert.equal(shot.video.scheduler, "simple");
  assert.equal(shot.video.vae, "flux2-vae_small.safetensors");
  assert.equal((await request({ prompt: "A lighthouse" })).queued[0].seed, 1073741824, "omitting seed rolls; readiness's seed zero must not leak");
  const full = await request({ prompt: "A lighthouse", steps: 50, cfg: 3, negative: "blur", width: 1536, height: 1024 });
  assert.equal(full.queued[0].video.steps, 50, "no unrelated30-step clamp");
  assert.equal(full.queued[0].video.negative, "blur");
});
test("old runtime and unsupported MOSS requests never enqueue anything", async () => {
  const assigned = await request({ prompt: "A lighthouse" }, true, true);
  assert.equal(assigned.status, 400); assert.equal(assigned.queued.length, 0); assert.equal(assigned.checked.length, 0);
  assert.match(assigned.body.error, /Unassign the custom Cover workflow/);
  const old = await request({ prompt: "A lighthouse" }, false);
  assert.equal(old.status, 400); assert.equal(old.queued.length, 0);
  for (const extra of [{ refImages: ["x.png"] }, { persona: "Alex" }, { transparent: true }, { draft: true },
    { dit: "wrong-sdxl.safetensors" }, { encoder: "wrong-clip-l.safetensors" }, { vae: "wrong-sd15.safetensors" },
    { width: 1025 }, { cfg: 11 }, { steps: 51 }, { sampler: "euler" }, { cfg: 1, negative: "blur" }]) {
    const r = await request({ prompt: "A lighthouse", ...extra });
    assert.equal(r.status, 400, JSON.stringify(extra)); assert.equal(r.queued.length, 0);
  }
});

test("all explicit acceleration recipes survive validation, queueing and the API receipt", async () => {
  for (const [mossPreset, steps, cfg, sampler] of [["standard",25,2.5,"er_sde"],["spectrum-manual-h1",25,2.5,"er_sde"],["spectrum-adaptive-h2",25,2.5,"er_sde"],["turbo-4",4,1,"euler"],["dmd-8",8,1,"euler"],["kromoss-standard",25,2.5,"er_sde"],["kromoss-dmd2-8",8,1,"euler"],["moss-hires-v03",25,4,"er_sde"],["nsfw-uncensored",30,3,"er_sde"]]) {
    const r = await request({ prompt: "A lighthouse", mossPreset });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.queued[0].video.mossPreset, mossPreset); assert.equal(r.checked[0].mossPreset, mossPreset);
    assert.equal(r.queued[0].video.steps, steps); assert.equal(r.queued[0].video.cfg, cfg); assert.equal(r.queued[0].video.sampler, sampler);
    assert.equal(r.body.mossPreset, mossPreset); assert.equal(r.body.mossRecipe, "fixture-recipe");
    if (mossPreset.startsWith("kromoss")) assert.equal(r.queued[0].video.dit,"kromoss_int8_convrot.safetensors");
    if (mossPreset==="moss-hires-v03") { assert.equal(r.queued[0].video.width,2048); assert.equal(r.queued[0].video.height,2048); assert.equal(r.queued[0].video.count,1); }
  }
  for (const extra of [{mossPreset:"unknown"},{mossPreset:"turbo-4",steps:25},{mossPreset:"dmd-8",cfg:2.5},{mossPreset:"turbo-4",width:1536,height:1024},{mossPreset:"turbo-4",negative:"blur"},{engine:"flux2",mossPreset:"standard"},{mossPreset:"kromoss-standard",dit:"moss_image_sft_int8_convrot.safetensors"},{mossPreset:"moss-hires-v03",width:1024},{mossPreset:"moss-hires-v03",count:2}]) {
    const r = await request({prompt:"A lighthouse",...extra}); assert.equal(r.status,400); assert.equal(r.queued.length,0);
  }
  const notReady = await request({prompt:"A lighthouse",mossPreset:"spectrum-manual-h1"},false);
  assert.equal(notReady.queued.length,0);
});
