/** ACE-Step 1.5 through ComfyUI: the catalogue row, the graph (text, cover,
 *  LoRA, per-model defaults), tempo/key/meter from the style line, LoRA
 *  recognition, the job and route wiring, the Music tab and MCP. No engine,
 *  no network, no render. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(os.tmpdir(), "aiplay-ace-test-"));
process.env.AIPLAY_APPDATA = tmp;
process.env.AIPLAY_RIG = path.join(tmp, "rig");
process.env.AIPLAY_OUTPUT = path.join(tmp, "out");
const { CATALOG, MODEL_TO_CAPABILITY } = await import("./models.js");
const { config } = await import("./config.js");
const { buildAceStep15Graph, aceMeta, ACE_DEFAULTS } = await import("./workflow.js");
const { loraTarget, loraFits } = await import("./detect.js");
test.after(() => rmSync(tmp, { recursive: true, force: true }));
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("the catalogue row: ComfyUI's split files at a pinned revision, MIT, output unrestricted", () => {
  const row = CATALOG.find((c) => c.id === "musicAceStep15");
  assert.ok(row, "catalogued");
  assert.equal(MODEL_TO_CAPABILITY["ace-step15"], "musicAceStep15", "songs it makes are stamped with this row's rights");
  assert.equal(config.music.engines["ace-step15"].capability, "musicAceStep15");
  const names = row.files.map((f) => path.basename(f.dest));
  assert.deepEqual(names, ["acestep_v1.5_turbo.safetensors", "ace_1.5_vae.safetensors", "qwen_0.6b_ace15.safetensors", "qwen_4b_ace15.safetensors"]);
  for (const f of row.files) {
    assert.match(f.url, /Comfy-Org\/ace_step_1\.5_ComfyUI_files\/resolve\/694a9723ff772285c73f0700caacf944d3f02f8d\//, "a pinned revision, not main");
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.ok(f.bytes > 1e8);
  }
  assert.deepEqual(row.files[3].alt, ["qwen_1.7b_ace15.safetensors"], "the lighter planner counts");
  assert.equal(row.outputRights.class, "unrestricted");
  assert.match(row.licence, /^MIT/);
  assert.match(row.outputRights.url, /github\.com\/ace-step\/ACE-Step-1\.5\/blob\/main\/LICENSE/);
});

test("the graph is ComfyUI's ACE-Step 1.5 template, with its sampler for each model", () => {
  const g = buildAceStep15Graph({ caption: "synthwave", lyrics: "[Verse]\nhi", dit: "acestep_v1.5_turbo.safetensors",
    lm: "qwen_4b_ace15.safetensors", duration: 90, bpm: 100, keyscale: "E minor", timesignature: "4", seed: 7 });
  const types = Object.fromEntries(Object.entries(g).map(([k, n]) => [k, n.class_type]));
  assert.equal(types[3], "DualCLIPLoader"); assert.equal(g[3].inputs.type, "ace");
  assert.equal(g[3].inputs.clip_name1, "qwen_0.6b_ace15.safetensors");
  assert.equal(types[4], "TextEncodeAceStepAudio1.5");
  assert.equal(types[10], "EmptyAceStep1.5LatentAudio"); assert.equal(g[10].inputs.seconds, 90);
  assert.equal(g[11].inputs.shift, 3);
  assert.deepEqual([g[7].inputs.steps, g[7].inputs.cfg, g[7].inputs.sampler_name, g[7].inputs.scheduler], [8, 1, "euler", "simple"]);
  assert.equal(g[4].inputs.generate_audio_codes, true);
  assert.ok(!g[2] && !g[5] && !g[13], "no LoRA, no cover");
  assert.equal(g[8].class_type, "VAEDecodeAudio"); assert.match(g[9].class_type, /^SaveAudio/);
  const sft = buildAceStep15Graph({ dit: "acestep_v1.5_xl_sft_bf16.safetensors", lm: "x" });
  assert.deepEqual([sft[7].inputs.steps, sft[7].inputs.cfg], [ACE_DEFAULTS.sft.steps, ACE_DEFAULTS.sft.cfg]);
  assert.deepEqual([ACE_DEFAULTS.base.steps, ACE_DEFAULTS.base.cfg], [50, 6], "XL base template");
});

test("a cover encodes the song and sets it as the reference, with the planner off", () => {
  const g = buildAceStep15Graph({ caption: "c", dit: "acestep_v1.5_turbo.safetensors", lm: "x", cover: "aiplay_refaud_0123456789ab.wav", codes: true });
  assert.equal(g[13].class_type, "LoadAudio");
  assert.equal(g[14].class_type, "VAEEncodeAudio"); assert.deepEqual(g[14].inputs.vae, ["12", 0]);
  assert.equal(g[5].class_type, "ReferenceTimbreAudio");
  assert.deepEqual(g[7].inputs.positive, ["5", 0]);
  assert.equal(g[4].inputs.generate_audio_codes, false, "ComfyUI's tooltip: off when giving an audio reference");
  const lora = buildAceStep15Graph({ dit: "d", lm: "x", lora: "mine.safetensors", loraStrength: 0.8 });
  assert.equal(lora[2].class_type, "LoraLoaderModelOnly"); assert.deepEqual(lora[11].inputs.model, ["2", 0]);
});

test("tempo, key and meter: asked for, else read from the style, else a stated default", () => {
  assert.deepEqual(aceMeta({ caption: "dark synthwave, 92 BPM, F# minor, 3/4", seed: 1 }).from, { bpm: "style", key: "style", meter: "style" });
  const m = aceMeta({ caption: "dark synthwave, 92 BPM, F# minor, 3/4" });
  assert.deepEqual([m.bpm, m.keyscale, m.timesignature], [92, "F# minor", "3"]);
  const d = aceMeta({ caption: "lofi, minor key", seed: 3 });
  assert.equal(d.bpm, 120); assert.match(d.keyscale, / minor$/); assert.equal(d.timesignature, "4");
  assert.equal(aceMeta({ caption: "x", seed: 3 }).keyscale, aceMeta({ caption: "x", seed: 3 }).keyscale, "a re-roll keeps the key");
  assert.deepEqual([aceMeta({ bpm: 140, keyscale: "A minor", timesignature: "6" }).bpm, aceMeta({ keyscale: "A minor" }).keyscale], [140, "A minor"]);
});

test("ACE-Step 1.5 LoRAs are recognised, and one ComfyUI cannot load is named", () => {
  const ok = loraTarget(["base_model.model.layers.0.cross_attn.k_proj.lora_A.weight", "base_model.model.layers.0.self_attn.q_proj.lora_B.weight"]);
  assert.equal(ok.variant, "ACE-Step 1.5");
  assert.equal(loraFits(ok.variant, "ACE-Step 1.5").fit, "yes");
  const nested = loraTarget(["base_model.model.base_model.model.layers.0.cross_attn.k_proj.lora_A.weight"]);
  assert.match(nested.variant, /cannot load/);
  assert.equal(loraFits(nested.variant, "ACE-Step 1.5").fit, "no", "listed disabled, never silently skipped");
  assert.equal(loraTarget(["model.layers.0.qkv_proj.lora_A.weight"]).variant, "YuE2", "YuE2's rule is untouched");
});

test("the runner, the route and the API switch", () => {
  const jobs = src("./jobs.js"), index = src("./index.js");
  assert.match(jobs, /value === "ace-step15"/);
  assert.match(jobs, /job\.engine === "ace-step15" \? buildAceStep15Graph\(/);
  assert.match(jobs, /if \(config\.api\?\.enabled && \(!job\.engine \|\| job\.engine === "minimax-music3"\)\) return this\.#runApi\(job\);/,
    "only MiniMax has a hosted twin; ACE-Step and YuE2-through-ComfyUI render locally with API mode on");
  assert.match(index, /const ACE_DIT = \/\^acestep/);
  assert.match(index, /reason: "weights-missing", needsModel: "musicAceStep15"/);
  assert.match(index, /const codes = cover \? false : body\.aceCodes === undefined \? !loraName : !!body\.aceCodes;/,
    "a LoRA turns the planner off unless asked, a cover always");
  assert.match(index, /if \(body\.instrumental \|\| !String\(body\.lyrics \|\| ""\)\.trim\(\)\) body\.lyrics = "\[Instrumental\]";/);
  assert.match(index, /if \(ck && ACE_DIT\.test\(ck\.name\)\) against = \{ variant: "ACE-Step 1\.5"/);
  assert.match(index, /const modelName = isAce \? "ace-step15"/, "filed under the name the rights map knows");
});

test("the Music tab panel and MCP", () => {
  const html = src("../web/index.html"), app = src("../web/app.js"), mcp = src("./mcp.js");
  for (const id of ["aceOpts", "aBpm", "aKey", "aMeter", "aLang", "aSteps", "aCfg", "aCodes", "aPlanTemp", "aLm", "aLora", "aLoraStrength", "aCoverSong", "aCoverFile"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /<details class="adv sbox" data-engine="ace" hidden id="aceOpts">/);
  assert.match(app, /lyrics: instrumental \? \(aceEngine\(\) \? "\[Instrumental\]"/);
  assert.match(app, /\.\.\.\(state\.musicEngine === "ace-step15" \? aceSpec\(\) : \{\}\)/);
  assert.match(mcp, /"yue2-gguf", "ace-step15"\]/);
  for (const k of ["language", "ace_steps", "ace_cfg", "planner", "cover_song"]) assert.match(mcp, new RegExp(`${k}: \\{ type:`), k);
});
