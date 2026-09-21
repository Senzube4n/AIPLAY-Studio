import assert from "node:assert/strict";
import { test } from "node:test";
import { qwenImageGraph, qwenImageRequiredNodes, QWEN_IMAGE_FILES, QWEN_IMAGE_NODES } from "./qwen-image.js";

// Node contracts transcribed from the upstream source revisions cited by the
// builder. This checks every graph edge's declared type and every input name,
// including autogrow flattening, without pretending to execute the GPU model.
const contracts = {
  UNETLoader: { in: { unet_name: "STRING", weight_dtype: "STRING" }, out: ["MODEL"] },
  UnetLoaderGGUF: { in: { unet_name: "STRING" }, out: ["MODEL"] },
  CLIPLoader: { in: { clip_name: "STRING", type: "STRING", device: "STRING" }, out: ["CLIP"] },
  CLIPLoaderGGUF: { in: { clip_name: "STRING", type: "STRING" }, out: ["CLIP"] },
  VAELoader: { in: { vae_name: "STRING" }, out: ["VAE"] },
  TextEncodeQwenImage21: { in: { clip: "CLIP", prompt: "STRING", negative_prompt: "STRING", resolution: "INT" }, optional: { vae: "VAE" }, out: ["CONDITIONING", "CONDITIONING", "LATENT"] },
  EmptyLatentImage: { in: { width: "INT", height: "INT", batch_size: "INT" }, out: ["LATENT"] },
  RepeatLatentBatch: { in: { samples: "LATENT", amount: "INT" }, out: ["LATENT"] },
  KSampler: { in: { model: "MODEL", positive: "CONDITIONING", negative: "CONDITIONING", latent_image: "LATENT", seed: "INT", steps: "INT", cfg: "FLOAT", sampler_name: "STRING", scheduler: "STRING", denoise: "FLOAT" }, out: ["LATENT"] },
  VAEDecode: { in: { samples: "LATENT", vae: "VAE" }, out: ["IMAGE"] },
  SaveImage: { in: { images: "IMAGE", filename_prefix: "STRING" }, out: ["IMAGE"] },
  ImageScale: { in: { image: "IMAGE", upscale_method: "STRING", width: "INT", height: "INT", crop: "STRING" }, out: ["IMAGE"] },
  LoadImage: { in: { image: "STRING" }, out: ["IMAGE", "MASK"] },
  JoinImageWithAlpha: { in: { image: "IMAGE", alpha: "MASK" }, out: ["IMAGE"] },
};
function validateGraph(graph) {
  for (const [id, node] of Object.entries(graph)) {
    const schema = contracts[node.class_type];
    assert.ok(schema, `Unknown node ${node.class_type}`);
    for (const key of Object.keys(schema.in)) assert.ok(key in node.inputs, `${id}.${key} missing`);
    for (const [name, value] of Object.entries(node.inputs)) {
      const type = schema.in[name] || schema.optional?.[name]
        || (node.class_type === "TextEncodeQwenImage21" && /^images\.image_([1-9]|1[0-6])$/.test(name) ? "IMAGE" : null);
      assert.ok(type, `${id}.${name} is not an upstream input`);
      if (Array.isArray(value)) {
        assert.equal(value.length, 2);
        const source = graph[value[0]];
        assert.ok(source, `${id}.${name} source missing`);
        assert.equal(contracts[source.class_type].out[value[1]], type, `${id}.${name} type mismatch`);
      } else if (type === "STRING") assert.equal(typeof value, "string");
      else if (type === "INT") assert.ok(Number.isSafeInteger(value), `${id}.${name} must be an integer`);
      else if (type === "FLOAT") assert.ok(Number.isFinite(value));
      else assert.fail(`${id}.${name} requires a linked ${type}`);
    }
  }
}

test("native recipe uses the correct 2.1 companions and typed graph contract", () => {
  const graph = qwenImageGraph({ prompt: "a lighthouse", seed: 7 });
  validateGraph(graph);
  assert.equal(graph[1].inputs.unet_name, QWEN_IMAGE_FILES.dit);
  assert.equal(graph[2].inputs.clip_name, QWEN_IMAGE_FILES.encoder);
  assert.equal(graph[2].inputs.type, "qwen_image");
  assert.equal(graph[3].inputs.vae_name, QWEN_IMAGE_FILES.vae);
  assert.equal(graph[8].inputs.cfg, 1);
  assert.equal(graph[8].inputs.steps, 25);
  assert.deepEqual(graph[8].inputs.latent_image, ["7", 0]);
  assert.equal(graph[7].class_type, "EmptyLatentImage");
  assert.ok(!("vae" in graph[4].inputs), "generation does not VAE-encode a missing reference");
});

test("ten ordered references independently reach vision and VAE conditioning", () => {
  const refs = Array.from({ length: 10 }, (_, i) => `subject-${i + 1}.png`);
  const graph = qwenImageGraph({ prompt: "a group portrait", refImages: refs });
  validateGraph(graph);
  const inputs = graph[4].inputs;
  assert.deepEqual(inputs.vae, ["3", 0]);
  for (let i = 0; i < refs.length; i++) {
    const join = graph[inputs[`images.image_${i + 1}`][0]];
    assert.equal(join.class_type, "JoinImageWithAlpha");
    assert.deepEqual(join.inputs.alpha, [join.inputs.image[0], 1], "the loader mask is joined without a second inversion");
    assert.equal(graph[join.inputs.image[0]].inputs.image, refs[i]);
  }
  assert.equal(Object.keys(inputs).filter((key) => key.startsWith("images.")).length, 10);
  assert.deepEqual(graph[8].inputs.latent_image, ["4", 2], "edit matches first reference geometry");
  assert.ok(!graph[7], "no independently sized latent silently shifts an edit");
  assert.deepEqual(refs, Array.from({ length: 10 }, (_, i) => `subject-${i + 1}.png`));
});

test("reference batches repeat the correctly sized latent; custom sizing is explicit", () => {
  const graph = qwenImageGraph({ prompt: "edit", refImages: ["reference.png"], count: 3 });
  validateGraph(graph);
  assert.equal(graph[7].class_type, "RepeatLatentBatch");
  assert.deepEqual(graph[7].inputs, { samples: ["4", 2], amount: 3 });
  const custom = qwenImageGraph({ prompt: "compose", refImages: ["ref.png"], refSizing: "custom", width: 1000, height: 700, count: 2 });
  validateGraph(custom);
  assert.deepEqual(custom[7].inputs, { width: 1024, height: 704, batch_size: 2 });
  assert.deepEqual(custom[8].inputs.latent_image, ["7", 0]);
});

test("transparent output reaches PNG directly and thumbnails retain image channels", () => {
  const graph = qwenImageGraph({ prompt: "a dragon sticker", transparent: true, prefix: "images/sticker" });
  validateGraph(graph);
  assert.match(graph[4].inputs.prompt, /RGBA format.*dragon sticker.*alpha channel.*transparent background/);
  const full = graph[QWEN_IMAGE_NODES.full], thumb = graph[QWEN_IMAGE_NODES.thumb];
  assert.equal(full.class_type, "SaveImage");
  assert.deepEqual(full.inputs.images, ["17", 0], "no RGB conversion before PNG saving");
  assert.equal(graph[17].class_type, "VAEDecode");
  assert.deepEqual(graph[14].inputs.image, full.inputs.images);
  assert.deepEqual(thumb.inputs.images, ["14", 0]);
  assert.equal(thumb.inputs.filename_prefix, "images/sticker_thumb");
});

test("parameters are finite, bounded, aligned; ignored negatives and excess references are refused", () => {
  const graph = qwenImageGraph({ prompt: "x", width: 99999, height: -1, steps: 99999, count: 0, refResolution: 1001, cfg: 999 });
  validateGraph(graph);
  assert.deepEqual(graph[7].inputs, { width: 4096, height: 256, batch_size: 1 });
  assert.equal(graph[8].inputs.steps, 50);
  assert.equal(graph[8].inputs.cfg, 10);
  assert.equal(graph[4].inputs.resolution, 1024);
  for (const opts of [{ width: NaN }, { steps: Infinity }, { seed: -1 }, { refImages: Array(11).fill("x.png") }, { refImages: [null] }, { refImages: [""] }, { refImages: "x.png" }, { negative: "blur" }, { refSizing: "stretch" }, { sampler: "unverified" }]) {
    assert.throws(() => qwenImageGraph({ prompt: "x", ...opts }));
  }
  const guided = qwenImageGraph({ prompt: "x", negative: "blur", cfg: 2 });
  assert.equal(guided[4].inputs.negative_prompt, "blur");
  assert.deepEqual(guided[8].inputs.negative, ["4", 1]);
});

test("native filename overrides work; GGUF is refused before enqueue", () => {
  const opts = { prompt: "x", dit: "custom.safetensors", encoder: "custom-encoder.safetensors", vae: "custom-vae.safetensors", refImages: ["x.png"], count: 2 };
  const graph = qwenImageGraph(opts);
  validateGraph(graph);
  assert.equal(graph[1].class_type, "UNETLoader");
  assert.equal(graph[2].class_type, "CLIPLoader");
  assert.equal(graph[3].inputs.vae_name, "custom-vae.safetensors");
  const requirements = qwenImageRequiredNodes(opts);
  for (const name of ["UNETLoader", "CLIPLoader", "TextEncodeQwenImage21", "JoinImageWithAlpha", "RepeatLatentBatch"]) assert.ok(requirements.includes(name));
  assert.ok(!requirements.includes("EmptyLatentImage"));
  assert.ok(!qwenImageRequiredNodes().includes("LoadImage"));
  for (const key of ["dit", "encoder", "vae"]) assert.throws(() => qwenImageGraph({ prompt: "x", [key]: "test.gguf" }), /native.*safetensors/);
});
