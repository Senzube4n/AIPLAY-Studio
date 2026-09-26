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
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
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

/* INSTALLER_PLAN S5: Qwen is no longer waved through. With its files missing
 * every song queued a cover that could only fail ("Qwen Image 2.1 is
 * unavailable"); now the cover row of machineDefaults() (server/fit.js
 * defaultFor "cover") says no, in one sentence, for Qwen as for any engine. */
test("automatic covers skip an engine whose files are missing, Qwen included", async () => {
  const index = src("./index.js");
  assert.ok(/if \(\(live \? live\.cover : true\) && await coverCanRun\(\)\) \{/.test(index));
  const fn = index.match(/async function coverCanRun\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(fn);
  const { defaultFor } = await import("./fit.js");
  const { CATALOG, isPictureModel } = await import("./models.js");
  let saved = "flux2", custom = false, ready = [];
  // What machineDefaults hands coverCanRun: the cover row of fit.js defaultFor, over these rows.
  const machineDefaults = async () => [defaultFor("cover", { saved, custom, machine: null,
    capabilities: CATALOG.filter(isPictureModel).map((c) => ({ ...c, ready: ready.includes(c.id) })) })];
  const check = new Function("machineDefaults", "console", `let coverSkipSaid = false; ${fn}; return coverCanRun;`)(machineDefaults, { log() {} });
  assert.equal(await check(), false, "FLUX chosen and not on disk: no cover job");
  saved = "qwen-image-2.1";
  assert.equal(await check(), false, "Qwen chosen and its files missing: no cover job either");
  ready = ["qwen-image-2.1"];
  assert.equal(await check(), true, "Qwen's files there: its runner still checks the runtime nodes");
  saved = "checkpoint"; custom = true; ready = [];
  assert.equal(await check(), true, "your own model file or cover workflow is yours to answer for");
  saved = null; custom = false;
  assert.equal(await check(), false, "nothing chosen and no picture model on disk: none");
  ready = ["coverArt"];
  assert.equal(await check(), true, "nothing chosen, FLUX.2 klein on disk: covers");
  /* A stale checkpoint name does not bypass another engine's readiness: only
   * the checkpoint ENGINE with a file counts as the person's own. */
  assert.match(index, /custom: !!assignedTo\("cover"\) \|\| \(config\.art\.engine === "checkpoint" && !!config\.art\.checkpoint\),/);
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
  /* Not asked of a RunPod Pod (RunPod GPU mode): the plain decode, which every ComfyUI has. */
  assert.match(jobs, /tiledVae: this\.remote \? false : await this\.#hasTiledAudioDecode\(\),/);
  assert.match(jobs, /engine\.objectInfo\("VAEDecodeAudioTiled"\)/, "asked of the engine, not assumed");
  assert.match(jobs, /config\.music\?\.tiledVae === false/, "and it can be switched off");
});

test("tiled audio capability and resident models follow engine restarts; an explicit opt-out wins", async () => {
  // Real queue/private methods with only its external collaborators replaced.
  // submit deliberately stops at the boundary: no socket, GPU, files or model.
  const source = src("./jobs.js");
  const cls = source.slice(source.indexOf("export class JobRunner")).replace("export class", "class");
  const rebound = [];
  const built = [];
  let available = true, checks = 0;
  const engine = {
    on: (name, fn) => { if (name === "rebound") rebound.push(fn); },
    objectInfo: async (name) => { checks++; assert.equal(name, "VAEDecodeAudioTiled"); return available ? { VAEDecodeAudioTiled: {} } : {}; },
    submit: async ({ graph }) => { built.push(graph); throw new Error("CPU fixture stops before dispatch"); },
  };
  const config = { api: { enabled: false }, music: {}, speed: { realtimeRatio: 1 }, sampling: {} };
  const Runner = new Function("EventEmitter", "config", "engine", "randomUUID", "buildGraph", "STAGE_OF_NODE", "STAGE_LABEL", "STAGE_WEIGHT", "ORDER", "STALL_MS",
    `${cls}; return JobRunner;`)(EventEmitter, config, engine, randomUUID, (graph) => graph, {}, {}, {}, [], 600_000);
  const runner = new Runner({ ready: true, on() {} });
  const song = async () => {
    runner.ws = { readyState: 1, close() {} };
    const finished = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Fixture queue did not finish")), 1000);
      const listener = (state) => {
        if (state.history[0]?.error !== "CPU fixture stops before dispatch") return;
        clearTimeout(timer); runner.off("update", listener); resolve();
      };
      runner.on("update", listener);
    });
    runner.history = [];
    runner.enqueue({ engine: "minimax-music3", caption: "fixture", seed: 1 });
    await finished;
    return built.at(-1).tiledVae;
  };
  assert.equal(await song(), true); assert.equal(checks, 1);
  assert.equal(await song(), true); assert.equal(checks, 1, "positive capability is reused on the same runtime");
  config.music.tiledVae = false;
  assert.equal(await song(), false, "explicit opt-out overrides a cached yes");
  assert.equal(checks, 1);
  config.music.tiledVae = true;
  runner.loaded = { key: "old-runtime-model" }; runner.artResident = true;
  available = false;
  rebound.forEach((fn) => fn());
  assert.equal(runner.loaded, null); assert.equal(runner.artResident, false);
  assert.equal(await song(), false); assert.equal(checks, 2, "new runtime is queried rather than using stale node support");
  available = true;
  assert.equal(await song(), true); assert.equal(checks, 3, "a missing node can become available without a permanent negative cache");
});
