import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { h3ImageGraph, h3ImageSettings, H3_IMAGE_FILES, H3_IMAGE_PRESET, H3_IMAGE_ENGINE, H3_IMAGE_CAPABILITY, H3_IMAGE_NODES } from "./h3-image.js";
import { CATALOG } from "./models.js";

test("text to image: core nodes, the vendor recipe and a 2048 canvas", () => {
  const g = h3ImageGraph({ prompt: "a red fox in snow", seed: 7 });
  assert.equal(g[1].class_type, "UNETLoader");
  assert.equal(g[1].inputs.unet_name, H3_IMAGE_FILES.dit);
  assert.deepEqual(g[2].inputs, { clip_name: H3_IMAGE_FILES.encoder, type: "minimax", device: "default" });
  assert.equal(g[3].inputs.vae_name, H3_IMAGE_FILES.vae);
  assert.equal(g[4].class_type, "MiniMaxH3ImageConditioning");
  assert.deepEqual(g[4].inputs.vae, ["3", 0], "the VAE anchors references as latents");
  assert.equal(g[4].inputs.width, 2048);
  assert.equal(g[4].inputs.height, 2048);
  assert.equal(g[5].class_type, "ConditioningZeroOut");
  const k = g[8].inputs;
  assert.deepEqual([k.steps, k.cfg, k.sampler_name, k.scheduler, k.denoise, k.seed], [6, 1, "lcm", "simple", 1, 7]);
  assert.deepEqual(k.latent_image, ["4", 1], "the latent comes from the conditioning node");
  assert.equal(g[H3_IMAGE_NODES.full].class_type, "SaveImage");
  assert.equal(g[H3_IMAGE_NODES.thumb].class_type, "SaveImage");
});

test("references become images.image_1..N in order and the canvas follows image_1", () => {
  const g = h3ImageGraph({ prompt: "<Picture 1> wears the jacket from <Picture 2>", refImages: ["a.png", "b.png"] });
  assert.deepEqual(g[4].inputs["images.image_1"], ["40", 0]);
  assert.deepEqual(g[4].inputs["images.image_2"], ["41", 0]);
  assert.equal(g[40].inputs.image, "a.png");
  assert.equal(g[41].inputs.image, "b.png");
  assert.equal(g[4].inputs.width, 0);
  assert.equal(g[4].inputs.height, 0);
  const s = h3ImageSettings(g);
  assert.deepEqual(s.refImages, ["a.png", "b.png"]);
  assert.equal(s.sizeSource, "first-reference");
});

test("an explicit size wins over the reference and snaps to 32", () => {
  const g = h3ImageGraph({ prompt: "x", refImages: ["a.png"], width: 3100, height: 2030 });
  assert.equal(g[4].inputs.width, 3104);
  assert.equal(g[4].inputs.height, 2016);
  assert.equal(h3ImageSettings(g).sizeSource, "requested");
});

test("count repeats the latent; sampler and steps pass through", () => {
  const g = h3ImageGraph({ prompt: "x", count: 3, sampler: "euler", steps: 8 });
  assert.equal(g[7].class_type, "RepeatLatentBatch");
  assert.equal(g[7].inputs.amount, 3);
  assert.deepEqual(g[8].inputs.latent_image, ["7", 0]);
  assert.equal(g[8].inputs.sampler_name, "euler");
  assert.equal(g[8].inputs.steps, 8);
  assert.equal(h3ImageSettings(g).count, 3);
});

test("what the model cannot honour is refused with a sentence", () => {
  assert.throws(() => h3ImageGraph({ prompt: "" }), /needs a prompt/);
  assert.throws(() => h3ImageGraph({ prompt: "x", negative: "blur" }), /negative prompt is never evaluated/);
  assert.throws(() => h3ImageGraph({ prompt: "x", cfg: 4 }), /CFG 1/);
  assert.throws(() => h3ImageGraph({ prompt: "x", refImages: Array.from({ length: 11 }, (_, i) => `${i}.png`) }), /up to 10/);
  assert.throws(() => h3ImageGraph({ prompt: "x", refImages: ["../secret.png"] }), /plain file names/);
  assert.throws(() => h3ImageGraph({ prompt: "x", count: 9 }), /count/);
  assert.throws(() => h3ImageGraph({ prompt: "x", steps: 99 }), /steps/);
  assert.throws(() => h3ImageGraph({ prompt: "x", sampler: "lcm; rm -rf" }), /sampler/);
  assert.doesNotThrow(() => h3ImageGraph({ prompt: "x", cfg: 1, negative: "  " }));
});

test("own files replace the catalogue's", () => {
  const g = h3ImageGraph({ prompt: "x", dit: "mine.safetensors", encoder: "qwen3vl_32b_minimax_h3-int4_convrot.safetensors", vae: "v.safetensors" });
  assert.equal(g[1].inputs.unet_name, "mine.safetensors");
  assert.equal(g[2].inputs.clip_name, "qwen3vl_32b_minimax_h3-int4_convrot.safetensors");
  assert.equal(g[3].inputs.vae_name, "v.safetensors");
});

test("the catalogue row downloads exactly the files the graph loads", () => {
  const row = CATALOG.find((c) => c.id === H3_IMAGE_CAPABILITY);
  assert.ok(row, "imageH3 is in the catalogue");
  assert.equal(row.makes, "picture");
  const names = row.files.map((f) => f.dest.split(/[\\/]/).pop());
  assert.ok(names.includes(H3_IMAGE_FILES.dit));
  assert.ok(names.includes(H3_IMAGE_FILES.vae));
  const enc = row.files.find((f) => /qwen3vl_32b/.test(f.dest));
  const encNames = [enc.dest.split(/[\\/]/).pop(), ...(enc.alt || [])];
  assert.ok(encNames.includes(H3_IMAGE_FILES.encoder), "an int8 encoder on disk counts");
  assert.ok(row.region?.excluded?.length, "the territory notice travels with the row");
});

test("the engine name is registered everywhere a picture engine is listed", () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  for (const [file, needle] of [
    ["./config.js", `"${H3_IMAGE_ENGINE}"`],
    ["./mcp.js", `"${H3_IMAGE_ENGINE}"`],
    ["./models.js", `"${H3_IMAGE_ENGINE}": "${H3_IMAGE_CAPABILITY}"`],
    ["../web/index.html", `value="${H3_IMAGE_ENGINE}"`],
    ["../web/app.js", `"${H3_IMAGE_ENGINE}": {`],
  ]) assert.ok(read(file).includes(needle), `${file} lists ${H3_IMAGE_ENGINE}`);
  assert.equal(H3_IMAGE_PRESET.steps, 6);
});
