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
  // or a rebound DNS name must not reach it: the one guard for such requests,
  // at the top of the whole handler, because setModelsDir, dropAlso, override
  // and scanFolder sit in the same POST (cross-origin-doors_test runs it).
  assert.match(index, /if \(p === "\/api\/models" && req\.method === "POST"\) \{\n(?:\s*\/?\*[^\n]*\n)*\s+if \(!sameOriginLocalJson\(req\)\) return json\(res, 403,[^\n]*\n\s+const b = await readBody\(req\);/,
    "the first thing the models POST does, for every action, is ask whether the request is Studio's own");
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
    /* AMD is a light machine (config.js isLightH3): the int4 encoder every
     * card gets (measured on an RX 9060 XT: faster than int8, half the RAM),
     * the w4a8 DiT and the int8 video VAE. Never an fp4 build. */
    assert.ok(names("video").includes("qwen3vl_32b_minimax_h3-int4_convrot.safetensors"), "H3: the int4 encoder");
    assert.ok(names("video").includes("minimax_h3_fl2va_pruned-w4a8_convrot_pruned.safetensors"), "H3: the w4a8 DiT");
    assert.ok(names("video").includes("minimax_h3_video_vae_int8_convrot.safetensors"), "H3: the int8 video VAE");
    assert.ok(!names("video").some((n) => /fp4/i.test(n)), names("video").join(", "));
    assert.ok(names("imageIdeogram").includes("qwen3vl_8b_fp8_scaled.safetensors"), "Ideogram: the fp8 encoder");
    for (const c of CATALOG) for (const f of c.files || []) assert.equal(fp4Blocked(f), false, `${c.id} still offers ${f.dest}`);
    assert.equal(fp4Blocked({ dest: "x/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors" }), true, "and the downloader refuses one");
    assert.equal(ideogramGraph({ prompt: "p", seed: 1 })[3].inputs.clip_name, "qwen3vl_8b_fp8_scaled.safetensors");

    config.torchBackend = "cuda"; config.gpu = { vendor: "nvidia", totalMb: 16376 };
    assert.equal(cardIsAmd(), false);
    assert.ok(names("video").includes("qwen3vl_32b_minimax_h3-int4_convrot.safetensors"), "NVIDIA keeps the measured int4");
    /* A 16 GB NVIDIA card on a PC with 32 GB or more keeps the official set
     * the H3 lab measured; the RAM is the machine's own, so it is passed in. */
    const { isLightH3 } = await import("./config.js");
    if (!isLightH3(config)) {
      /* This test machine has 32 GB or more: the catalogue itself follows. */
      assert.ok(names("video").includes("minimax_h3_fl2va_pruned_int8_convrot.safetensors"), "the official int8 DiT");
      assert.ok(names("video").includes("minimax_h3_video_vae_fp16.safetensors"), "and the fp16 VAE the lab measured");
    }
    assert.equal(isLightH3({ gpu: { vendor: "nvidia", totalMb: 16376 }, torchBackend: "cuda" }, 64 * 2 ** 30), false);
    assert.equal(isLightH3({ gpu: { vendor: "nvidia", totalMb: 12282 }, torchBackend: "cuda" }, 64 * 2 ** 30), true, "under 16 GB of VRAM: light");
    assert.equal(isLightH3({ gpu: { vendor: "nvidia", totalMb: 16376 }, torchBackend: "cuda" }, 16 * 2 ** 30), true, "under 32 GB of RAM: light");
    assert.equal(isLightH3({ gpu: { vendor: "intel", totalMb: 16000 } }, 64 * 2 ** 30), true, "Intel: light");
    assert.ok(names("imageIdeogram").includes("qwen3vl_8b_nvfp4.safetensors"));
    assert.equal(fp4Blocked({ dest: "x/qwen3vl_8b_nvfp4.safetensors" }), false);
  } finally {
    config.torchBackend = keep.t; config.gpu = keep.g;
  }
  const models = readFileSync(new URL("./models.js", import.meta.url), "utf8");
  assert.match(models, /async #one\(id, f, getBase, _setBase\) \{\r?\n\s+if \(fp4Blocked\(f\)\) \{/, "checked before a byte is fetched");
});

/* THE CATALOGUE AND THE ENGINE AGREE ON AN AMD CARD, with the files a real AMD
 * machine holds: the int4 H3 encoder Studio itself downloaded before the amd
 * entry existed, and an nvfp4 Ideogram encoder that came with an NVIDIA
 * machine's folder added as an extra. config.js reads the card ONCE at load
 * (AMD_CARD), so this runs in its own process with an AMD settings file; the
 * in-process test above flips config.gpu after load and cannot see pick().
 * Before the fix, pick() loaded the int4 while the Models screen called H3 not
 * installed (27.1 GB missing) and /api/video refused to switch to it, and
 * Ideogram's graph named the nvfp4 that ROCm has no kernel for. */
/* Since 2026-09-25 every card's slot is the int4 encoder, so the case that
 * matters is the other way round: an AMD machine still holding the int8 its
 * Studio downloaded before. It must count as installed and load. */
test("an AMD card holding the older int8 H3 encoder: the Models screen and the graph agree, and Ideogram never names nvfp4", async () => {
  const { execFileSync } = await import("node:child_process");
  const box = path.join(root, "amd");
  const appdata = path.join(box, "appdata"), main = path.join(box, "main"), extra = path.join(box, "extra");
  const INT4 = "qwen3vl_32b_minimax_h3-int4_convrot.safetensors", INT8 = "qwen3vl_32b_minimax_h3_int8_convrot.safetensors";
  await mkdir(appdata, { recursive: true });
  await mkdir(main, { recursive: true });
  await mkdir(path.join(extra, "text_encoders"), { recursive: true });
  await writeFile(path.join(extra, "text_encoders", INT8), Buffer.alloc(16, 1));
  await writeFile(path.join(extra, "text_encoders", "qwen3vl_8b_nvfp4.safetensors"), Buffer.alloc(16, 1));
  await writeFile(path.join(appdata, "settings.json"), JSON.stringify({
    gpu: { vendor: "amd", totalMb: 16304 }, torchBackend: "rocm", rig: path.join(box, "rig"), modelsDir: main, modelsAlso: [extra],
  }));
  const here = (f) => new URL(`./${f}`, import.meta.url).href;
  const child = `
    const { config } = await import(${JSON.stringify(here("config.js"))});
    const { ModelManager, cardIsAmd } = await import(${JSON.stringify(here("models.js"))});
    const { videoReady, videoGraph, ideogramGraph } = await import(${JSON.stringify(here("workflow.js"))});
    const st = await new ModelManager().status();
    const slot = (id) => (st.find((c) => c.id === id)?.files || []).find((f) => /qwen3vl_32b_minimax_h3/.test(f.dest));
    const g = videoGraph({ engine: "h3", prompt: "p", seed: 1, seconds: 2 });
    console.log(JSON.stringify({
      amd: cardIsAmd(), te: config.video.engines.h3.textEncoder,
      graphTe: Object.values(g).find((n) => /CLIPLoader/.test(n.class_type))?.inputs?.clip_name,
      missing: videoReady("h3").missing,
      video: slot("video") && { dest: slot("video").dest.split(/[\\\\/]/).pop(), present: slot("video").present },
      fast: slot("videoFastH3") && { present: slot("videoFastH3").present },
      ideogram: ideogramGraph({ prompt: "p", seed: 1 })[3].inputs.clip_name,
    }));
    process.exit(0);`;
  const env = { ...process.env, AIPLAY_APPDATA: appdata };
  delete env.AIPLAY_MODELS_DIR;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", child], { env, encoding: "utf8", timeout: 60_000 });
  const r = JSON.parse(out.trim().split(/\r?\n/).pop());
  assert.equal(r.amd, true, "the child really is on an AMD card");
  assert.equal(r.te, INT8, "pick() takes the int8 that is on disk");
  assert.equal(r.graphTe, INT8, "and the H3 graph loads it");
  assert.ok(!r.missing.includes(INT8), "the engine calls the encoder present");
  assert.equal(r.video?.dest, INT4, "every card's catalogue slot is the int4 build now");
  assert.equal(r.video?.present, true, "and the int8 already there fills it: no 14 GB download asked for");
  assert.equal(r.fast?.present, true, "FastH3's row shares the slot");
  assert.equal(r.ideogram, "qwen3vl_8b_fp8_scaled.safetensors", "Ideogram never names nvfp4 on AMD, even with one on disk");
});
