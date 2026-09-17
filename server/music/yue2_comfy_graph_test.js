/**
 * YuE2 through ComfyUI takes a LoRA, 2026-09-17.
 *
 * What is pinned: the graph the engine is asked for when a LoRA is named —
 * LoraLoaderModelOnly spliced on the MODEL wire between the checkpoint and the
 * sampler, the text side and the VAE left on the checkpoint's own outputs
 * (ComfyUI holds YuE2's composer as CLIP, and a LoRA in ComfyUI's format
 * carries keys for the NAR only); that a YuE2 LoRA and a YuE2 checkpoint are
 * recognised from their tensor names so the picker can say "fits" rather than
 * "unknown"; the preference validators; and — because the audio reference was
 * dead on arrival for exactly this reason — that every hand the LoRA passes
 * through names it: the route, the job pump's explicit builder list, the queue
 * snapshot, the ledger and library rows, the warm-up, the MCP schema and its
 * forwarding, the Music tab's request and its markup, and the API doc.
 * No card, no ComfyUI, milliseconds.
 */
import fs from "node:fs";
import { buildYue2ComfyGraph, STAGE_OF_NODE } from "../workflow.js";
import { loraTarget, detect, loraFits } from "../detect.js";
import { PREF_PATHS } from "../config.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

console.log("\n§1  the graph: the LoRA sits between the checkpoint and the sampler, on the MODEL wire only");
{
  const base = { caption: "c", lyrics: "l", seed: 7, cot: "full", maxDuration: 60, steps: 32, checkpoint: "yue2_3b_bf16.safetensors" };
  const plain = buildYue2ComfyGraph(base);
  ok("without a LoRA there is no node 2", !("2" in plain));
  eq("...and the sampler reads the checkpoint's model", plain[7].inputs.model, ["1", 0]);

  const g = buildYue2ComfyGraph({ ...base, lora: "my_yue2.safetensors", loraStrength: 0.8 });
  eq("with one, node 2 is LoraLoaderModelOnly", g[2]?.class_type, "LoraLoaderModelOnly");
  eq("...fed by the checkpoint's model", g[2]?.inputs.model, ["1", 0]);
  eq("...naming the file", g[2]?.inputs.lora_name, "my_yue2.safetensors");
  eq("...at the asked strength", g[2]?.inputs.strength_model, 0.8);
  eq("the sampler follows the LoRA", g[7].inputs.model, ["2", 0]);
  eq("the ABC planner still reads the checkpoint's clip", g[4].inputs.clip, ["1", 1]);
  eq("...and so does the music generator", g[5].inputs.clip, ["1", 1]);
  eq("the decoder still reads the checkpoint's VAE", g[8].inputs.vae, ["1", 2]);
  eq("node 2 is a loading stage, so progress needs no new label", STAGE_OF_NODE[2], "loading");

  ok("an empty name is no LoRA", !("2" in buildYue2ComfyGraph({ ...base, lora: "" })));
  ok("...and so is whitespace", !("2" in buildYue2ComfyGraph({ ...base, lora: "   " })));
  ok("...and so is null", !("2" in buildYue2ComfyGraph({ ...base, lora: null, loraStrength: 2 })));
  eq("strength defaults to 1", buildYue2ComfyGraph({ ...base, lora: "x.safetensors" })[2].inputs.strength_model, 1);
  eq("...and an unreadable strength falls back to 1",
    buildYue2ComfyGraph({ ...base, lora: "x.safetensors", loraStrength: "nope" })[2].inputs.strength_model, 1);
  const off = buildYue2ComfyGraph({ ...base, cot: "off", lora: "x.safetensors" });
  ok("with the plan off the LoRA still loads, and there is still no planner",
    off[2]?.class_type === "LoraLoaderModelOnly" && !("4" in off));
}

console.log("\n§2  a YuE2 LoRA and a YuE2 checkpoint are read from their tensors, not their filenames");
{
  /* The layout ComfyUI-YuE2-Trainer's convert.py writes: ComfyUI's native
   * prefix and its fused qkv / gate_up projections. */
  const trained = [
    "diffusion_model.model.layers.0.self_attn.qkv_proj.lora_down.weight",
    "diffusion_model.model.layers.0.self_attn.qkv_proj.lora_up.weight",
    "diffusion_model.model.layers.0.self_attn.qkv_proj.alpha",
    "diffusion_model.model.layers.0.mlp.gate_up_proj.lora_down.weight",
    "diffusion_model.model.layers.0.mlp.gate_up_proj.lora_up.weight",
  ];
  eq("fused NAR layer names read as YuE2", loraTarget(trained).variant, "YuE2");
  eq("...as likely, not certain: the fused names are llama.py's, which Qwen3 shares", loraTarget(trained).confidence, "likely");
  const withBridge = [...trained, "diffusion_model.vae2llm.lora_down.weight", "diffusion_model.vae2llm.lora_up.weight"];
  eq("the latent bridge makes it certain", loraTarget(withBridge).confidence, "certain");
  const qwenTe = ["text_encoders.qwen3.transformer.model.layers.0.self_attn.qkv_proj.lora_down.weight"];
  ok("a text-encoder LoRA with the same fused names is NOT read as YuE2", loraTarget(qwenTe).variant !== "YuE2", loraTarget(qwenTe).variant);

  const asLora = detect(new Set(trained), {});
  eq("through detect() the file is a LoRA", asLora.family, "lora");
  eq("...for YuE2", asLora.variant, "YuE2");

  const ckpt = detect(new Set([
    "model.diffusion_model.vae2llm.weight", "model.diffusion_model.llm2vae.weight",
    "model.diffusion_model.model.layers.0.self_attn.qkv_proj.weight",
    "model.diffusion_model.time_embedder.linear_1.weight",
  ]), {});
  eq("a checkpoint with the NAR's latent bridges is family yue2", ckpt.family, "yue2");
  eq("...variant YuE2", ckpt.variant, "YuE2");
  eq("...and the two fit", loraFits(asLora.variant, ckpt.variant).fit, "yes");
  eq("an H3 LoRA does not fit it", loraFits("MiniMax H3", ckpt.variant).fit, "no");
}

console.log("\n§3  the preference validators");
{
  const rule = (k) => PREF_PATHS.find(([g, key]) => g === "music" && key === k)?.[2];
  const lora = rule("yue2Lora"), strength = rule("yue2LoraStrength");
  ok("music.yue2Lora is a preference", typeof lora === "function");
  ok("...null clears it", lora?.(null) === true);
  ok("...a .safetensors basename is accepted", lora?.("my_yue2.safetensors") === true);
  ok("...a path is refused", lora?.("../my_yue2.safetensors") === false);
  ok("...and so is another extension", lora?.("my_yue2.ckpt") === false);
  ok("music.yue2LoraStrength is a preference", typeof strength === "function");
  ok("...within −4..4", strength?.(0.5) === true && strength?.(-4) === true && strength?.(4) === true);
  ok("...outside, or as text, refused", strength?.(9) === false && strength?.("1") === false);
}

console.log("\n§4  every hand the LoRA passes through names it");
{
  const index = src("../index.js"), jobs = src("../jobs.js"), mcp = src("../mcp.js");
  const app = src("../../web/app.js"), html = src("../../web/index.html"), api = src("../../API.md");
  ok("the route refuses a name that is on no loras shelf, by reason", /reason: "lora-missing"/.test(index));
  ok("...falls back to the saved choice only when the request is silent",
    /body\.lora === undefined \? config\.music\.yue2Lora : body\.lora/.test(index));
  ok("...clamps the strength", /Math\.min\(Math\.max\(Number\(body\.loraStrength\), -4\), 4\)/.test(index));
  ok("...and enqueues both", /lora: yueLora, loraStrength: yueLoraStrength,/.test(index));
  ok("the job pump hands both to the graph builder — the explicit list the audio reference fell through",
    /lora: job\.lora,\n\s+loraStrength: job\.loraStrength,/.test(jobs));
  ok("the queue snapshot carries the LoRA", /lora: j\.lora \?\? null/.test(jobs));
  ok("the ledger row records it",
    /lora: job\.lora \|\| null, loraStrength: job\.lora \? \(job\.loraStrength \?\? 1\) : null \}/.test(index));
  ok("the library row records it",
    /lora: job\.lora \|\| null, loraStrength: job\.lora \? \(job\.loraStrength \?\? 1\) : null,\n\s+rights: "CC BY-NC 4\.0/.test(index));
  ok("the FLAC tags name it", /\{ lora: `\$\{job\.lora\} @ \$\{job\.loraStrength \?\? 1\}` \}/.test(index));
  ok("the warm-up loads the same LoRA the song will use",
    /prefix: "aiplay_warmup",\n\s+lora: config\.music\.yue2Lora, loraStrength: config\.music\.yue2LoraStrength,/.test(index));
  ok("the Music tab's choice is saved by its own action",
    /b\.action === "lora"/.test(index) && /config\.music\.yue2Lora = name;/.test(index));
  ok("/api/loras lists every base the engine loads from",
    /const shelf = await scanBases\(await modelBases\(\)\);\n\s+const seen = new Set\(\);\n\s+const files = shelf\.filter\(\(f\) => f\.folder === "loras"/.test(index));
  ok("status and models expose the saved choice", index.split("musicYue2Lora: config.music.yue2Lora").length - 1 >= 2);
  ok("make_song declares lora and lora_strength",
    /lora: \{ type: "string", description: "yue2-comfy only/.test(mcp) && /lora_strength: \{ type: "number", minimum: -4, maximum: 4/.test(mcp));
  ok("...and forwards them",
    /loraStrength: Number\.isFinite\(a\.lora_strength\) \? a\.lora_strength : undefined,/.test(mcp) && /safeName\(a\.lora, "LoRA"\)/.test(mcp));
  ok("the Music tab sends the picker's value with a yue2-comfy spec",
    /lora: \$\("yLora"\)\?\.value \|\| "", loraStrength: Number\(\$\("yLoraStrength"\)\?\.value \?\? 100\) \/ 100/.test(app));
  ok("...shows the picker only for the ComfyUI engine",
    /const comfyYue = yueParams && eng\.runtime === "comfy";\n\s+for \(const el of document\.querySelectorAll\('\[data-comfy-yue\]'\)\) el\.hidden = !comfyYue;/.test(app));
  ok("...and paints it from /api/loras judged against the checkpoint",
    /fetch\(`\/api\/loras\$\{ck \? `\?for=\$\{encodeURIComponent\(ck\)\}` : ""\}`\)/.test(app));
  ok("...saving a change through the music action", /JSON\.stringify\(\{ action: "lora", value, strength \}\)/.test(app));
  ok("the picker lives under Advanced Options, ComfyUI-tagged",
    /id="yMusicPlan">[\s\S]*?<select id="yLora" class="sel2">/.test(html) && /<div class="params" data-comfy-yue hidden>/.test(html));
  ok("...with a strength control", /<input id="yLoraStrength" type="range" min="0" max="200"/.test(html));
  ok("the API doc says how to name one and what a wrong name gets",
    /"lora": "<file in models\/loras>"/.test(api) && /reason: "lora-missing"/.test(api));
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
