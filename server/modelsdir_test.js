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
