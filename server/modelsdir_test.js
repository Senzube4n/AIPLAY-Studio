/**
 * CHANGING THE MODELS FOLDER WITHOUT LOSING WHAT IS ALREADY DOWNLOADED.
 *
 * The Models screen can send new downloads to another folder, an empty one on
 * a bigger drive included. The folder being left is remembered (settings
 * `modelsAlso`) and still searched: Studio counts its weights as installed and
 * the engine is told to load from it. Without that, a change of folder offered
 * every model again, hundreds of GB. Temp folders only; no engine.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(tmpdir(), "aiplay-modelsdir-"));
process.env.AIPLAY_APPDATA = path.join(root, "appdata");
process.env.AIPLAY_MODELS_DIR = path.join(root, "new");
const { config } = await import("./config.js");
const { ModelManager, CATALOG } = await import("./models.js");
const { writeModelPathsYaml } = await import("./localmodels.js");

test.after(() => rm(root, { recursive: true, force: true }));

test("a model in the folder that was left still counts as installed", async () => {
  const old = path.join(root, "old");
  await mkdir(path.join(old, "vae"), { recursive: true });
  await mkdir(config.modelsDir, { recursive: true });
  await writeFile(path.join(old, "vae", "thing.safetensors"), Buffer.alloc(1234, 1));
  const id = "modelsdir-test-row";
  CATALOG.push({ id, label: "Thing", files: [{ url: "http://127.0.0.1:9/none", dest: path.join(config.modelsDir, "vae", "thing.safetensors"), bytes: 1234 }] });
  try {
    const m = new ModelManager();
    config.modelsAlso = [];
    assert.equal((await m.status()).find((c) => c.id === id).ready, false, "without the old folder: missing");
    config.modelsAlso = [old];
    assert.equal((await m.status()).find((c) => c.id === id).ready, true, "with it: installed, nothing to download again");
    await writeFile(path.join(old, "vae", "thing.safetensors"), Buffer.alloc(10, 1));
    assert.equal((await m.status()).find((c) => c.id === id).ready, false, "a wrong-sized copy there is not the file");
  } finally {
    CATALOG.splice(CATALOG.findIndex((c) => c.id === id), 1);
    config.modelsAlso = [];
  }
});

test("the engine is told to load from the earlier folders too", async () => {
  const file = await writeModelPathsYaml("D:\\models new", path.join(root, "appdata"), ["E:\\ComfyUI\\models", "F:\\it's old"]);
  const y = await readFile(file, "utf8");
  assert.match(y, /aiplay_models:\n  base_path: 'D:\\models new'\n  is_default: true\n/);
  assert.match(y, /aiplay_models_also_1:\n  base_path: 'E:\\ComfyUI\\models'\n  checkpoints: checkpoints\//, "not the default: downloads go to the new one");
  assert.match(y, /aiplay_models_also_2:\n  base_path: 'F:\\it''s old'/, "YAML-quoted");
  const none = await readFile(await writeModelPathsYaml("D:\\m", path.join(root, "appdata")), "utf8");
  assert.doesNotMatch(none, /also/, "no earlier folders, no extra blocks");
});

test("the route keeps the folder being left, allows an empty or new one, and can stop using one", () => {
  const index = readFileSync(new URL("./index.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(index, /const also = uniqueDirs\(\[\.\.\.\(config\.modelsAlso \|\| \[\]\), \.\.\.\(samePath\(prev, dir\) \? \[\] : \[prev\]\)\]\)/);
  assert.match(index, /await mergeSettings\(\{ modelsDir: dir, modelsDirPinned: true, modelsAlso: also \}\);/);
  assert.match(index, /if \(!files\.length && !b\.force\) \{/, "an empty folder only on purpose");
  assert.match(index, /b\.force && b\.create && !\(await stat\(dir\)/, "a new folder is made only when asked, under a parent that exists");
  assert.match(index, /if \(b\.action === "dropAlso"\) \{/);
  assert.match(index, /\.\.\.\(config\.modelsAlso \|\| \[\]\),/, "the pickers and the on-disk list see the earlier folders");
  assert.match(readFileSync(new URL("./comfy.js", import.meta.url), "utf8"), /writeModelPathsYaml\(config\.modelsDir, config\.paths\.appData, config\.modelsAlso \|\| \[\]\)/);
  const page = readFileSync(new URL("../web/modellocal.js", import.meta.url), "utf8");
  assert.match(page, /action: "setModelsDir", dir: root\.getElementById\("mfPath"\)\.value, force: fresh, create: fresh/);
  assert.match(page, /data-mf-drop=/);
});

test("the launcher's Change… keeps the old folder the same way", () => {
  const l = readFileSync(new URL("../launcher/launcher.mjs", import.meta.url), "utf8");
  assert.match(l, /await saveSettings\(\{ modelsDir: r\.path, modelsDirPinned: true, modelsAlso: also \}\);/);
});

test("a second models folder can be added on purpose, beside the main one", () => {
  const index = readFileSync(new URL("./index.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(index, /if \(b\.action === "addAlso"\) \{/);
  // It decides what the engine loads, so a cross-site no-cors text/plain POST
  // or a rebound DNS name must not reach it: the one guard for such requests.
  assert.match(index, /if \(b\.action === "addAlso"\) \{\n(?:\s*\/?\*[^\n]*\n)*\s+if \(!sameOriginLocalJson\(req\)\) return json\(res, 403,/,
    "the first thing addAlso does is ask whether the request is Studio's own");
  assert.match(index, /const next = uniqueDirs\(\[\.\.\.\(config\.modelsAlso \|\| \[\]\), dir\]\);\n\s+await mergeSettings\(\{ modelsAlso: next \}\);/,
    "added to the extra folders, never made the download folder");
  assert.match(index, /if \(samePath\(dir, config\.modelsDir\)\) return json\(res, 400/, "the main folder is not its own extra");
  const page = readFileSync(new URL("../web/modellocal.js", import.meta.url), "utf8");
  assert.match(page, /data-mf="also" disabled>Add as extra</);
  assert.match(page, /action: "addAlso", dir: root\.getElementById\("mfPath"\)\.value/);
  const conf = readFileSync(new URL("./config.js", import.meta.url), "utf8");
  assert.match(conf, /const bases = \[MODELS_DIR, \.\.\.MODELS_ALSO\];/, "the engine's file choices look in the extra folders too");
  const wf = readFileSync(new URL("./workflow.js", import.meta.url), "utf8");
  assert.match(wf, /if \(onDisk\(sub, file\)\) continue;/, "so does the video ready check");
});

test("an AMD card never downloads an NVIDIA-only fp4 build", async () => {
  const { cardIsAmd, fp4Blocked } = await import("./models.js");
  const { ideogramGraph } = await import("./workflow.js");
  const keep = { t: config.torchBackend, g: config.gpu };
  const names = (id) => CATALOG.find((c) => c.id === id).files.map((f) => path.basename(f.dest));
  try {
    config.torchBackend = "rocm"; config.gpu = { vendor: "amd", totalMb: 16304 };
    assert.equal(cardIsAmd(), true);
    assert.ok(names("video").includes("qwen3vl_32b_minimax_h3_int8_convrot.safetensors"), "H3: the official int8 encoder");
    assert.ok(!names("video").some((n) => /int4|fp4/i.test(n)), names("video").join(", "));
    assert.ok(names("imageIdeogram").includes("qwen3vl_8b_fp8_scaled.safetensors"), "Ideogram: the fp8 encoder");
    for (const c of CATALOG) for (const f of c.files || []) assert.equal(fp4Blocked(f), false, `${c.id} still offers ${f.dest}`);
    assert.equal(fp4Blocked({ dest: "x/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors" }), true, "and the downloader refuses one");
    assert.equal(ideogramGraph({ prompt: "p", seed: 1 })[3].inputs.clip_name, "qwen3vl_8b_fp8_scaled.safetensors");

    config.torchBackend = "cuda"; config.gpu = { vendor: "nvidia", totalMb: 16376 };
    assert.equal(cardIsAmd(), false);
    assert.ok(names("video").includes("qwen3vl_32b_minimax_h3-int4_convrot.safetensors"), "NVIDIA keeps the measured int4");
    assert.ok(names("imageIdeogram").includes("qwen3vl_8b_nvfp4.safetensors"));
    assert.equal(fp4Blocked({ dest: "x/qwen3vl_8b_nvfp4.safetensors" }), false);
  } finally {
    config.torchBackend = keep.t; config.gpu = keep.g;
  }
  const models = readFileSync(new URL("./models.js", import.meta.url), "utf8");
  assert.match(models, /async #one\(id, f, getBase, _setBase\) \{\r?\n\s+if \(fp4Blocked\(f\)\) \{/, "checked before a byte is fetched");
});
