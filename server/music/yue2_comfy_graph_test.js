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
  ok("the library row records it — BOTH doors, the planner's included",
    /lora: job\.lora \|\| null, loraStrength: job\.lora \? \(job\.loraStrength \?\? 1\) : null,/.test(index)
    && /loraClip: job\.loraClip \|\| null, loraClipStrength: job\.loraClip \? \(job\.loraClipStrength \?\? 1\) : null,\n\s+rights: songRights\(\{ engine: "yue2-comfy", lora: job\.lora, loraClip: job\.loraClip \}\)\.label,/.test(index)
    && /loraClip: j\.loraClip \?\? null, loraClipStrength: j\.loraClip \? \(j\.loraClipStrength \?\? 1\) : null,/.test(src("../jobs.js")));
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
  ok("the picker lives under Melody & score, ComfyUI-tagged",
    /id="yMusicPlan">[\s\S]*?<select id="yLora" class="sel2">/.test(html) && /<div class="params" data-comfy-yue hidden>/.test(html));
  ok("...with a strength control", /<input id="yLoraStrength" type="range" min="0" max="200"/.test(html));
  ok("the API doc says how to name one and what a wrong name gets",
    /"lora": "<file in models\/loras>"/.test(api) && /reason: "lora-missing"/.test(api));
}

console.log("\n§  the planner's LoRA: the other half, on the clip wire");
{
  /* ComfyUI holds YuE2's composer as CLIP. A planner LoRA (Mothersuperior's
   * instrumental planner, fused qkv / gate_up keys on the language model)
   * matches nothing on the MODEL side, so it rides LoraLoader on the clip wire
   * with the model strength at 0, and the two generate nodes read their clip
   * from it. Node 3 is a "loading" id already. */
  const base = { caption: "c", lyrics: "l", seed: 7, cot: "full", maxDuration: 60, steps: 32, checkpoint: "yue2_3b_bf16.safetensors" };
  const index = src("../index.js"), mcp = src("../mcp.js");
  const app = src("../../web/app.js"), html = src("../../web/index.html"), api = src("../../API.md");
  const g = buildYue2ComfyGraph({ ...base, loraClip: "ar_lora_inst_v3abc_comfyui.safetensors", loraClipStrength: 0.9 });
  eq("with a planner LoRA, node 3 is LoraLoader", g[3]?.class_type, "LoraLoader");
  eq("...naming the file", g[3]?.inputs.lora_name, "ar_lora_inst_v3abc_comfyui.safetensors");
  eq("...on the clip wire at the asked strength", g[3]?.inputs.strength_clip, 0.9);
  eq("...and the model strength at 0: the audio half is not touched", g[3]?.inputs.strength_model, 0);
  eq("...fed the checkpoint's clip", JSON.stringify(g[3]?.inputs.clip), '["1",1]');
  eq("the score planner reads its clip from the LoRA", JSON.stringify(g[4]?.inputs.clip), '["3",1]');
  eq("...and so does the token generator", JSON.stringify(g[5]?.inputs.clip), '["3",1]');
  eq("the sampler's model is still the checkpoint's (no audio LoRA named)", JSON.stringify(g[7]?.inputs.model), '["1",0]');
  const both = buildYue2ComfyGraph({ ...base, lora: "nar.safetensors", loraClip: "ar.safetensors" });
  ok("both doors at once: node 2 on the model wire, node 3 on the clip wire",
    both[2]?.class_type === "LoraLoaderModelOnly" && both[3]?.class_type === "LoraLoader"
    && JSON.stringify(both[7].inputs.model) === '["2",0]' && JSON.stringify(both[5].inputs.clip) === '["3",1]');
  const none = buildYue2ComfyGraph({ ...base });
  ok("with none, no node 3 and the clip is the checkpoint's", !("3" in none) && JSON.stringify(none[5].inputs.clip) === '["1",1]');
  ok("an empty or blank name is no planner LoRA",
    !("3" in buildYue2ComfyGraph({ ...base, loraClip: "" })) && !("3" in buildYue2ComfyGraph({ ...base, loraClip: "  " })));
  eq("its strength defaults to 1", buildYue2ComfyGraph({ ...base, loraClip: "x.safetensors" })[3].inputs.strength_clip, 1);
  ok("the instrumental planner LoRA is named once, in the graph module",
    /export const INSTRUMENTAL_PLANNER_LORA = "ar_lora_inst_v3abc_comfyui\.safetensors";/.test(src("../workflow.js")));
  ok("the route reads loraClip the way it reads lora, and refuses a name off the shelf",
    /const askedClip = body\.loraClip === undefined \? config\.music\.yue2LoraClip : body\.loraClip;/.test(index)
    && /The planner LoRA \$\{bareName\(clipName\)\} is not in a loras folder/.test(index));
  /* Not beside a supplied score (Tika R2b): no planner runs then, so nothing
   * is picked; yue2-comfy-input_test §3 runs the route to prove both ways. */
  ok("...picks the instrumental planner LoRA for an instrumental when it is on a shelf, nothing was named and no score was supplied",
    /if \(!clipName && body\.loraClip === undefined && body\.instrumental && !yueComfy\.abc && onShelf\(INSTRUMENTAL_PLANNER_LORA\)\)/.test(index)
    && /if \(body\.instrumental && yueLoraClip === INSTRUMENTAL_PLANNER_LORA\) yueSheet = "\[instrumental\]";/.test(index)
    && /lyrics: yueSheet \?\? \(body\.lyrics \|\| ""\)\.trim\(\),/.test(index));
  ok("...and names it on the job, which the pump hands to the graph",
    /loraClip: yueLoraClip, loraClipStrength: yueLoraClipStrength,/.test(index)
    && /loraClip: job\.loraClip,\n\s+loraClipStrength: job\.loraClipStrength,/.test(src("../jobs.js")));
  ok("the ledger line names the planner LoRA beside the audio one",
    /plannerLora: `\$\{job\.loraClip\} @ \$\{job\.loraClipStrength \?\? 1\}`/.test(index));
  ok("the choice is remembered (config, validators, status) and saved through its own action",
    /yue2LoraClip: null,\n\s+yue2LoraClipStrength: 1,/.test(src("../config.js"))
    && /\["music", "yue2LoraClip",/.test(src("../config.js"))
    && index.split("musicYue2LoraClip: config.music.yue2LoraClip").length - 1 >= 2
    && /if \(b\.action === "planner-lora"\)/.test(index));
  ok("make_song declares lora_clip and lora_clip_strength and forwards them",
    /lora_clip: \{ type: "string", description: "yue2-comfy only: a PLANNER LoRA/.test(mcp)
    && /loraClip: typeof a\.lora_clip === "string" \? \(a\.lora_clip \? safeName\(a\.lora_clip, "LoRA"\) : ""\) : undefined,/.test(mcp));
  ok("the Music tab has the picker and its strength, sends them, and saves through the planner-lora action",
    /<select id="yLoraClip" class="sel2">/.test(html) && /<input id="yLoraClipStrength" type="range" min="0" max="200"/.test(html)
    && /loraClip: \$\("yLoraClip"\)\?\.value \|\| "", loraClipStrength: Number\(\$\("yLoraClipStrength"\)\?\.value \?\? 100\) \/ 100/.test(app)
    && /JSON\.stringify\(\{ action: "planner-lora", value, strength \}\)/.test(app));
  ok("the API doc names the planner door", /"loraClip": "<file in models\/loras>"/.test(api));
}

console.log("\n§  a recording's codes in front of the sampler, through our own node");
{
  /* ComfyUI's YuE2GenerateMusic has no prefix input and its token generation is
   * sealed inside the text encoder, so continuing a recording on this engine
   * takes a node of our own. It keeps node 5's id — the composing step is the
   * composing step — so the stage map and the save node are untouched. */
  const base = { caption: "c", lyrics: "l", seed: 7, cot: "full", maxDuration: 60, steps: 32, checkpoint: "yue2_3b_bf16.safetensors" };
  const g = buildYue2ComfyGraph({ ...base, codes: "D:/out/yue2/tok_abc123", primeSeconds: 8 });
  eq("with codes, node 5 is our own node", g[5]?.class_type, "AiplayYuE2Continue");
  eq("...pointed at the folder the tokenizer wrote", g[5]?.inputs.codes_dir, "D:/out/yue2/tok_abc123");
  eq("...hearing the asked-for seconds of it", g[5]?.inputs.prime_seconds, 8);
  eq("...and asked for NEW music, the replay being extra", g[5]?.inputs.new_duration, 60);
  eq("the decoder still reads node 5's seconds", JSON.stringify(buildYue2ComfyGraph({ ...base, codes: "x" })[10]?.inputs.seconds), '["5",1]');
  eq("without codes it is ComfyUI's own node", buildYue2ComfyGraph(base)[5]?.class_type, "YuE2GenerateMusic");
  ok("an empty or blank folder is no replay",
    buildYue2ComfyGraph({ ...base, codes: "" })[5]?.class_type === "YuE2GenerateMusic"
    && buildYue2ComfyGraph({ ...base, codes: "  " })[5]?.class_type === "YuE2GenerateMusic");
  ok("the node ships with the app and deploys itself at engine boot",
    /NODE_CLASS_MAPPINGS = \{"AiplayYuE2Continue": AiplayYuE2Continue\}/.test(src("../comfy_nodes/aiplay_yue2_continue.py")));
  const node = src("../comfy_nodes/aiplay_yue2_continue.py");
  ok("...it offsets the codec-space codes into the vocabulary, as the sampler's own tokens are",
    /offset_replay = \[t \+ CODEC_OFFSET for t in replay\]/.test(node) && /CODEC_OFFSET = 151853/.test(node));
  ok("...puts the replay on BOTH branches, so guidance compares like with like",
    /prefix = text_prefix \+ offset_replay/.test(node) && /negative = negative \+ offset_replay/.test(node));
  ok("...and hands the acoustic pass the whole sequence with the TEXT prefix's length",
    /whole = offset_replay \+ semantic/.test(node)
    && /_acoustic_conditioning\(text_prefix, whole, dtype\)/.test(node));
  ok("...restoring the method it swapped, whatever happens",
    /finally:\n\s+model\.encode_token_weights = original/.test(node));
  ok("...and refusing a replay that leaves no room rather than truncating it silently",
    /leave no \n?\s*"?f?"?room for new music/.test(node) || /room for new music/.test(node));
}

console.log("\n§  a supplied score is sung as written: no planner, the text on node 5 (Tika R2b, 2026-09-24)");
{
  /* The route used to read `abc` only for the Python kit, and the graph always
   * wired node 4's own plan into node 5, so a hummed score on this engine was
   * accepted and never sung. ComfyUI's YuE2GenerateMusic takes the score as a
   * plain string; so does our AiplayYuE2Continue. */
  const base = { caption: "c", lyrics: "l", seed: 7, cot: "melody", maxDuration: 60, steps: 32, checkpoint: "yue2_3b_bf16.safetensors" };
  const score = "X:1\nT:hum\nM:4/4\nL:1/8\nK:G\nV:1\n|: GABc d2 B2 :|\n";
  const g = buildYue2ComfyGraph({ ...base, abc: score });
  ok("with a score there is no node 4", !("4" in g));
  eq("node 5 is ComfyUI's own music node", g[5]?.class_type, "YuE2GenerateMusic");
  eq("...and its abc is the score's text, not a wire", g[5]?.inputs.abc, score);
  eq("...in the asked mode (melody)", g[5]?.inputs.mode, "melody");
  eq("full stays full", buildYue2ComfyGraph({ ...base, cot: "full", abc: score })[5]?.inputs.mode, "full");
  ok("no input anywhere still points at node 4",
    !JSON.stringify(Object.values(g).map((n) => n.inputs)).includes('["4",'));
  const cont = buildYue2ComfyGraph({ ...base, abc: score, codes: "D:/out/yue2/tok_abc123" });
  ok("the continue node takes the score the same way",
    cont[5]?.class_type === "AiplayYuE2Continue" && cont[5]?.inputs.abc === score && cont[5]?.inputs.mode === "melody" && !("4" in cont));
  const plain = buildYue2ComfyGraph(base);
  eq("without a score node 4 plans, as before", plain[4]?.class_type, "YuE2GenerateABC");
  eq("...and node 5 reads its plan", plain[5]?.inputs.abc, ["4", 0]);
  eq("a blank score is no score", buildYue2ComfyGraph({ ...base, abc: "  \n" })[5]?.inputs.abc, ["4", 0]);
  let threw = null;
  try { buildYue2ComfyGraph({ ...base, cot: "off", abc: score }); } catch (e) { threw = e; }
  ok("a score with the plan off is refused by the builder too, never rendered without it",
    threw && /chain of thought/.test(threw.message), threw ? threw.message : "no throw");
  eq("with the plan off and no score, node 5 gets no abc (unchanged)", buildYue2ComfyGraph({ ...base, cot: "off" })[5]?.inputs.abc, "");
}

console.log("\n§  the sampler dials land on nodes 4 and 5; absent dials keep the vendor defaults");
{
  const base = { caption: "c", lyrics: "l", seed: 7, cot: "full", maxDuration: 60, steps: 32, checkpoint: "yue2_3b_bf16.safetensors" };
  const d = buildYue2ComfyGraph(base);
  eq("node 5 defaults: 1.0 / 0.95 / 100 / 1.2",
    [d[5].inputs.temperature, d[5].inputs.top_p, d[5].inputs.top_k, d[5].inputs.repetition_penalty], [1.0, 0.95, 100, 1.2]);
  eq("node 4 defaults: 0.7 / 0.9 / 30 / 1.005",
    [d[4].inputs.temperature, d[4].inputs.top_p, d[4].inputs.top_k, d[4].inputs.repetition_penalty], [0.7, 0.9, 30, 1.005]);
  const g = buildYue2ComfyGraph({ ...base,
    sampling: { temperature: 0.8, top_p: 0.9, top_k: 50, repetition_penalty: 1.1 },
    planSampling: { temperature: 0.5, top_p: 0.85 } });
  eq("sampling lands on node 5",
    [g[5].inputs.temperature, g[5].inputs.top_p, g[5].inputs.top_k, g[5].inputs.repetition_penalty], [0.8, 0.9, 50, 1.1]);
  eq("planSampling lands on node 4, top_k and the penalty untouched",
    [g[4].inputs.temperature, g[4].inputs.top_p, g[4].inputs.top_k, g[4].inputs.repetition_penalty], [0.5, 0.85, 30, 1.005]);
  const half = buildYue2ComfyGraph({ ...base, sampling: { temperature: 0 } });
  eq("one dial moves one input (temperature 0 is a value, not a default)",
    [half[5].inputs.temperature, half[5].inputs.top_p], [0, 0.95]);
  const cont = buildYue2ComfyGraph({ ...base, codes: "x", sampling: { top_p: 0.5 } });
  eq("the continue node takes the dials too", cont[5].inputs.top_p, 0.5);
}

console.log("\n§  the pump names the score and the dials, or the route's validation reaches nothing");
{
  const jobs = src("../jobs.js");
  ok("jobs.js hands abc, sampling and planSampling to buildYue2ComfyGraph",
    /abc: job\.abc,\n\s+sampling: job\.sampling,\n\s+planSampling: job\.planSampling,\n\s+prefix: "aiplay",\n\s+\}\) : buildGraph\(\{/.test(jobs));
  const index = src("../index.js");
  ok("the route enqueues them from the validator",
    /abc: yueComfy\.abc, sampling: yueComfy\.sampling, planSampling: yueComfy\.planSampling,/.test(index));
  ok("the ledger row says whether a score was supplied, and which dials",
    /runtime: "comfy", checkpoint: job\.yue2Checkpoint \|\| null, cot: job\.cot \|\| "full",\n\s+scoreSupplied: !!job\.abc, sampling: job\.sampling \|\| null, planSampling: job\.planSampling \|\| null,/.test(index));
  ok("the page no longer refuses a score on yue2-comfy when loading a request",
    !/cannot accept a supplied score/.test(src("../../web/app.js")));
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
