/** Qwen 2.1 uses a different architecture from the older 20B Qwen family.
 * Header fixtures below copy key names, shapes and dtypes from the official
 * Comfy-Org/Qwen-Image-2.1 INT8 convrot header at revision
 * ace0edeb3791a594ddfa36ed5f41a178a394e921 (74,448 header bytes).
 * Only its header was range-read; these tests need no weights or GPU.
 * Upstream detector: Comfy-Org/ComfyUI comfy/model_detection.py at
 * b0f4b7b294ce482a2e071d9d762c133d38c7aa07, QwenImage21 predicate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { detect, loraFits, probeModel } from "./detect.js";
import { classify, familyFromName, listPickable, resolvePick } from "./modelpick.js";
import { QWEN_IMAGE_PRESET } from "./qwen-image.js";

const evidence = {
  "txt_in.text_norm.weight": { dtype: "BF16", shape: [4096] },
  "modulation.1.weight": { dtype: "BF16", shape: [16384, 4096] },
  "transformer_blocks.0.attn.norm_q.weight": { dtype: "BF16", shape: [128] },
  "img_in.weight": { dtype: "BF16", shape: [4096, 64] },
  "proj_out.weight": { dtype: "BF16", shape: [64, 4096] },
  "transformer_blocks.0.img_mlp.gate_up.weight": { dtype: "I8", shape: [24576, 4096] },
  "transformer_blocks.0.img_mlp.gate_up.weight_scale": { dtype: "F32", shape: [24576, 1] },
};
const fromHeader = (header) => detect(new Set(Object.keys(header)),
  Object.fromEntries(Object.entries(header).map(([k, v]) => [k, v.shape])));
const row = (name = "my-renamed-model.safetensors", folder = "diffusion_models") => ({ name, folder });

test("official fused INT8 tensor layout selects 2.1, including a packaged denoiser prefix", () => {
  for (const prefix of ["", "model.diffusion_model."]) {
    const probe = fromHeader(Object.fromEntries(Object.entries(evidence).map(([k, v]) => [prefix + k, v])));
    assert.equal(probe.family, "qwen-image-2.1");
    assert.equal(probe.variant, "Qwen-Image 2.1");
    assert.match(probe.detail, /hidden 4096, context 4096/);
    const pick = classify(row(), probe);
    assert.equal(pick.engine, "qwen-image-2.1");
    assert.equal(pick.dit, row().name);
    assert.equal(pick.ok, true);
    assert.equal(pick.defaults.steps, QWEN_IMAGE_PRESET.steps);
    assert.equal(pick.defaults.cfg, QWEN_IMAGE_PRESET.cfg);
  }
});

test("unfused export is recognised; incomplete key signatures are not promoted", () => {
  const unfused = { ...evidence, "transformer_blocks.0.img_mlp.proj.weight": { dtype: "BF16", shape: [12288, 4096] } };
  delete unfused["transformer_blocks.0.img_mlp.gate_up.weight"];
  assert.equal(fromHeader(unfused).family, "qwen-image-2.1");
  for (const key of Object.keys(evidence).filter((k) => !k.endsWith("weight_scale"))) {
    const partial = { ...evidence };
    delete partial[key];
    assert.notEqual(fromHeader(partial).family, "qwen-image-2.1", `Missing ${key} must not be claimed`);
  }
});

test("old Qwen and Mage-Flow stay distinct and old adapters do not claim a 2.1 match", () => {
  const old = fromHeader({ "txt_norm.weight": { shape: [3584] }, "proj_out.weight": { shape: [64, 3072] } });
  assert.equal(old.family, "qwen-image");
  assert.equal(classify(row("qwen_image_2.1.safetensors"), old).ok, false, "A renamed old model is still old");
  assert.equal(loraFits("Qwen-Image", "Qwen-Image 2.1").fit, "no");
  assert.equal(fromHeader({ "txt_norm.weight": { shape: [2560] }, "proj_out.weight": { shape: [128, 2560] } }).family, "mage-flow");
});

test("2.1 safetensors requires the transformer shelf; Qwen GGUF cannot fall through to a loadable guess", () => {
  const probe = fromHeader(evidence);
  const wrongFolder = classify(row(undefined, "checkpoints"), probe);
  assert.equal(wrongFolder.ok, false);
  assert.match(wrongFolder.why, /models\/diffusion_models/);
  for (const name of ["Qwen-Image-2.1-Uncensored-Q8_0.gguf", "qwen_image_2_1_Q4.gguf", "QwenImage21-Q8.gguf", "qwen-image-Q8.gguf"]) {
    const family = familyFromName(name);
    assert.match(family, /^qwen-image/);
    const pick = classify(row(name), { family, gguf: true });
    assert.equal(pick.ok, false);
    assert.equal(pick.loadable, false);
    assert.equal(pick.engine, null);
    assert.match(pick.why, /native INT8 safetensors/);
    assert.equal(pick.needsKind, undefined);
  }
  assert.equal(classify(row("renamed.gguf"), probe).ok, false, "An extension cannot bypass the unsupported GGUF guard");
});

test("real shelf scan reads header evidence instead of the filename or author's architecture claim", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "aiplay-qwen-pick-"));
  try {
    const dir = path.join(base, "diffusion_models");
    await mkdir(dir);
    const header = Buffer.from(JSON.stringify({ __metadata__: { "jdx.merge.architecture": "flux2" }, ...evidence }));
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(header.length));
    // Deliberately header-only: probeModel does not load or validate weight bytes.
    await writeFile(path.join(dir, "renamed.safetensors"), Buffer.concat([length, header]));
    await writeFile(path.join(dir, "Qwen-Image-2.1-Q8_0.gguf"), "GGUF");
    const config = { modelsDir: base, comfyDir: base, comfy: { extraArgs: [] } };
    const probe = await probeModel(path.join(dir, "renamed.safetensors"));
    assert.equal(probe.family, "qwen-image-2.1");
    assert.equal(probe.dtype, "I8", "large quantized weights outweigh small BF16 norms and F32 scales");
    const picks = await listPickable(config);
    assert.equal(picks.find((p) => p.name.endsWith(".gguf")).ok, false);
    const pick = await resolvePick("renamed.safetensors", config);
    assert.equal(pick.engine, "qwen-image-2.1");
    assert.equal(pick.author, "flux2", "The author's claim stays separate from tensor evidence");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
