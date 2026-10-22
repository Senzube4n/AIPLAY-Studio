import assert from "node:assert/strict";
import { test } from "node:test";
import { mossImageGraph, mossImageSettings, MOSS_IMAGE_FILES } from "./moss-image.js";
import { detect } from "./detect.js";
import { classify } from "./modelpick.js";
import { CATALOG } from "./models.js";
import { defaultFor, recommendFor } from "./fit.js";

// Native ComfyUI 0.42.1 schemas, not a Qwen latent/conditioning graph.
const contracts = {
  UNETLoader: { inputs: ["unet_name", "weight_dtype"], outputs: ["MODEL"] },
  CLIPLoader: { inputs: ["clip_name", "type", "device"], outputs: ["CLIP"] },
  VAELoader: { inputs: ["vae_name"], outputs: ["VAE"] },
  CLIPTextEncode: { inputs: ["clip", "text"], outputs: ["CONDITIONING"] },
  EmptyFlux2LatentImage: { inputs: ["width", "height", "batch_size"], outputs: ["LATENT"] },
  KSampler: { inputs: ["model", "positive", "negative", "latent_image", "seed", "steps", "cfg", "sampler_name", "scheduler", "denoise"], outputs: ["LATENT"] },
  VAEDecode: { inputs: ["samples", "vae"], outputs: ["IMAGE"] },
  SaveImage: { inputs: ["images", "filename_prefix"], outputs: [] },
  ImageScale: { inputs: ["image", "upscale_method", "width", "height", "crop"], outputs: ["IMAGE"] },
};
const linkedTypes = { clip: "CLIP", model: "MODEL", positive: "CONDITIONING", negative: "CONDITIONING", latent_image: "LATENT", samples: "LATENT", vae: "VAE", images: "IMAGE", image: "IMAGE" };
test("MOSS graph uses native conditioning/Flux2 latent and records raw prompt and exact recipe", () => {
  const prompt = 'A blue cup beside a sign reading "OPEN".';
  const graph = mossImageGraph({ prompt, seed: 9, negative: "blur", width: 1344, height: 768, count: 2 });
  for (const [id, node] of Object.entries(graph)) {
    const schema = contracts[node.class_type]; assert.ok(schema, node.class_type);
    assert.deepEqual(Object.keys(node.inputs).sort(), [...schema.inputs].sort(), id);
    for (const [key, value] of Object.entries(node.inputs)) if (Array.isArray(value)) {
      assert.equal(contracts[graph[value[0]].class_type].outputs[value[1]], linkedTypes[key], id + "." + key);
    }
  }
  assert.equal(graph[2].inputs.type, "moss_image");
  assert.equal(graph[4].inputs.text, prompt);
  assert.equal(graph[5].inputs.text, "blur");
  assert.equal(graph[1].inputs.unet_name, MOSS_IMAGE_FILES.dit);
  assert.equal(graph[3].inputs.vae_name, "flux2-vae_small.safetensors");
  assert.deepEqual(graph[7].inputs, { width: 1344, height: 768, batch_size: 2 });
  assert.deepEqual(mossImageSettings(graph), { steps: 25, cfg: 2.5, sampler: "er_sde", scheduler: "simple", shift: 5, shiftSource: "native-model-default", promptUpsampler: false, skipLayerGuidance: false });
  assert.ok(!Object.values(graph).some(n => /TextGenerate|QwenImage21|SkipLayer/.test(n.class_type)));
});

test("MOSS refuses unsupported inputs and invalid native settings before rendering", () => {
  for (const extra of [{ refImages: ["a.png"] }, { refImages: "a.png" }, { persona: "Alex" }, { transparent: true },
    { draft: true }, { sampler: "euler" }, { scheduler: "normal" }, { cfg: 1, negative: "blur" }, { width: 1025 },
    { height: 4096 }, { count: 5 }, { seed: -1 }, { steps: 51 }, { dit: "moss.gguf" }, { encoder: "encoder.gguf" },
    { dit: "wrong-sdxl.safetensors" }, { encoder: "wrong-clip-l.safetensors" }, { vae: "wrong-sd15.safetensors" },
    { loras: [{ name: "test.safetensors" }] }, { clipSkip: 2 }, { mode: "edit" }, { negative: "x".repeat(2001) }]) {
    assert.throws(() => mossImageGraph({ prompt: "a lighthouse", ...extra }), undefined, JSON.stringify(extra));
  }
});

test("native tensor predicate is specific and BYO Moss does not pretend to load GGUF", () => {
  const keys = new Set(["shared_block_modulation.weight", "layers.0.proj.ffn_up_gate.weight"]);
  const p = detect(keys, {});
  assert.equal(p.family, "moss-image");
  const one = detect(new Set(["shared_block_modulation.weight"]), {});
  assert.notEqual(one.family, "moss-image");
  const picked = classify({ name: "moss_image_sft_int8_convrot.safetensors", folder: "diffusion_models", bytes: 10 }, p);
  assert.equal(classify({ name: "moss_image_base_int8_convrot.safetensors", folder: "diffusion_models", bytes: 10 }, p).loadable, false);
  assert.equal(picked.engine, "moss-image"); assert.equal(picked.loadable, true); assert.equal(picked.defaults.cfg, 2.5);
  assert.equal(classify({ name: "moss-image.gguf", folder: "diffusion_models" }, { family: "moss-image", gguf: true }).loadable, false);
});

test("catalogue pins exact files and experimental MOSS never changes the automatic Qwen default", () => {
  const cap = CATALOG.find(c => c.id === "moss-image");
  assert.equal(cap.files.reduce((n, f) => n + f.bytes, 0), 13006811386);
  assert.ok(cap.files.every(f => /^[0-9a-f]{64}$/.test(f.sha256) && f.url.includes("24147db865fcdc207270f844777587223fed8d6e")));
  const ready = { ...cap, ready: true };
  const qwen = { ...CATALOG.find(c => c.id === "qwen-image-2.1"), ready: true };
  assert.equal(defaultFor("image", { capabilities: [ready, qwen] }).value, "qwen-image-2.1");
  assert.notEqual(defaultFor("image", { capabilities: [ready] }).value, "moss-image");
  assert.ok(!recommendFor({ capabilities: [ready], machine: { gpu: null, ram: { totalGb: 32 } } }).picks.some(p => p.id === "moss-image"));
  assert.equal(defaultFor("image", { saved: "moss-image", capabilities: [ready, qwen] }).value, "moss-image");
});
