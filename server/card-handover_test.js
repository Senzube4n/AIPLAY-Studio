/**
 * ONE CARD, HANDED OVER CLEANLY.
 *
 * Reported from a 24 GB Quadro RTX 6000: renders over 15 minutes and a soft
 * crash once VRAM filled. Three things kept models on the card that should have
 * left it: --highvram above 16 GB, a music model nobody unloaded before an
 * image or video job, and a cover queued for a model that was not even there.
 * Plus the refusal that crashed the reply instead of reaching the person.
 * No ComfyUI: these run the pure functions and read the wiring.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { autoVramFlags } from "./comfyargs.js";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("no card size gets --highvram automatically", () => {
  for (const mb of [12282, 16304, 24576, 32768, 49152, 98304]) {
    assert.ok(!autoVramFlags(mb).includes("--highvram"), `${mb} MB`);
    assert.ok(autoVramFlags(mb).includes("--async-offload"));
  }
  assert.ok(autoVramFlags(8192).includes("--lowvram"), "small cards still stream");
});

test("a music model leaves ComfyUI before a picture or clip, and the way back unloads too", () => {
  const art = src("./art.js"), jobs = src("./jobs.js");
  assert.match(art, /if \(this\.jobs\.loaded\) \{[\s\S]{0,200}await this\.jobs\.unloadModels\(\)/);
  assert.match(art, /this\.jobs\.artResident = true;/);
  assert.match(jobs, /\(this\.loaded && this\.loaded\.key !== modelKey\) \|\| this\.artResident/,
    "MiniMax, ACE-Step and YuE2-through-ComfyUI all go through this one switch");
  assert.match(jobs, /this\.loaded = null;\n\s+this\.artResident = false;/, "an unload clears both records");
});

test("an automatic cover is not queued for a model that is not on disk", () => {
  const index = src("./index.js");
  assert.match(index, /if \(\(live \? live\.cover : true\) && await coverCanRun\(\)\) \{/);
  assert.match(index, /async function coverCanRun\(\) \{\n\s+if \(assignedTo\("cover"\) \|\| config\.art\.checkpoint\) return true;/,
    "a custom cover workflow or the person's own checkpoint is still theirs to run");
});

test("a run status is never an HTTP status: the reply carries the sentence instead of crashing", () => {
  const index = src("./index.js");
  const fn = index.match(/function json\(res, code, body\) \{[\s\S]*?\n\}/)[0];
  const calls = [];
  const json = new Function(`${fn}; return json;`)();
  json({ writeHead: (c) => calls.push(c), end() {} }, "rejected", { error: "clip_name not in list" });
  json({ writeHead: (c) => calls.push(c), end() {} }, 404, {});
  assert.deepEqual(calls, [502, 404]);
});

test("MiniMax Music 3 decodes in tiles when the engine can, whole only when it cannot", async () => {
  const { buildGraph, MUSIC_VAE_TILE, MUSIC_VAE_OVERLAP } = await import("./workflow.js");
  const args = { caption: "indie pop", lyrics: "[Verse]\nla", seed: 1, maxDuration: 240, steps: 15 };
  const tiled = buildGraph(args)["8"];
  assert.equal(tiled.class_type, "VAEDecodeAudioTiled", "the default: ComfyUI sized the whole-song decode at tens of GB");
  assert.deepEqual([tiled.inputs.tile_size, tiled.inputs.overlap], [MUSIC_VAE_TILE, MUSIC_VAE_OVERLAP]);
  assert.deepEqual(tiled.inputs.samples, ["7", 0]);
  assert.deepEqual(tiled.inputs.vae, ["3", 0]);
  assert.equal(buildGraph({ ...args, tiledVae: false })["8"].class_type, "VAEDecodeAudio", "an engine without the node keeps the old decode");
  const jobs = src("./jobs.js");
  assert.match(jobs, /tiledVae: await this\.#hasTiledAudioDecode\(\),/);
  assert.match(jobs, /engine\.objectInfo\("VAEDecodeAudioTiled"\)/, "asked of the engine, not assumed");
  assert.match(jobs, /config\.music\?\.tiledVae === false/, "and it can be switched off");
});
