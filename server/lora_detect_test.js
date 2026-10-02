/**
 * The LoRA shelf reads tensors, not filenames — Krea 2, 2026-09-17.
 *
 * Nine Krea 2 style LoRAs sat on this rig's shelf as "unknown base": their
 * keys use the diffusers spelling (transformer.text_fusion.layerwise_blocks…,
 * transformer.transformer_blocks…) while the checkpoint predicate reads
 * ComfyUI's (txtfusion.projector), and the Krea 2 DiT answered with a family
 * but no variant, so loraFits had nothing to compare. Pinned here: the LoRA
 * rule on the tower that no other family has, the variant on the checkpoint,
 * a yes between them, and that a `for=` name is looked up in the bare-DiT
 * folders too, which is where that checkpoint actually lives. No weights are
 * read — the keys below are the real file's names, copied.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loraTarget, detect, loraFits, probeModel, yue2LoraParts } from "./detect.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);

console.log("\n§1  a Krea 2 LoRA, under the diffusers spelling it is published in");
const krea = [
  "transformer.final_layer.linear.lora_A.weight", "transformer.final_layer.linear.lora_B.weight",
  "transformer.img_in.lora_A.weight", "transformer.img_in.lora_B.weight",
  "transformer.text_fusion.layerwise_blocks.0.attn.to_q.lora_A.weight",
  "transformer.text_fusion.layerwise_blocks.0.attn.to_q.lora_B.weight",
  "transformer.text_fusion.refiner_blocks.0.ff.gate.lora_A.weight",
  "transformer.text_fusion.projector.lora_A.weight",
  "transformer.time_mod_proj.lora_A.weight",
  "transformer.transformer_blocks.0.attn.to_k.lora_A.weight",
  "transformer.transformer_blocks.0.ff.up.lora_B.weight",
  "transformer.txt_in.linear_1.lora_A.weight",
];
{
  const t = loraTarget(krea);
  eq("the tower names it", t.variant, "Krea 2");
  eq("...with certainty", t.confidence, "certain");
  const viaDetect = detect(new Set(krea), {});
  eq("through detect() it is a LoRA", viaDetect.family, "lora");
  eq("...for Krea 2", viaDetect.variant, "Krea 2");
  const comfySpelling = ["diffusion_model.txtfusion.projector.lora_down.weight", "diffusion_model.txtfusion.projector.lora_up.weight"];
  eq("ComfyUI's own spelling of the tower is Krea 2 too", loraTarget(comfySpelling).variant, "Krea 2");
  const qwen = ["transformer.transformer_blocks.0.attn.to_q.lora_A.weight", "transformer.txt_norm.lora_A.weight"];
  ok("plain transformer_blocks with Qwen's txt_norm stay Qwen-Image", loraTarget(qwen).variant === "Qwen-Image", loraTarget(qwen).variant);
  ok("plain transformer_blocks alone are not claimed", loraTarget(["transformer.transformer_blocks.0.attn.to_q.lora_A.weight"]).variant !== "Krea 2");
}

console.log("\n§2  the Krea 2 DiT carries a variant, so the two can be compared");
{
  const ck = detect(new Set([
    "model.diffusion_model.txtfusion.projector.weight",
    "model.diffusion_model.transformer_blocks.0.attn.to_q.weight",
    "model.diffusion_model.img_in.weight",
  ]), {});
  eq("family krea2", ck.family, "krea2");
  eq("variant Krea 2", ck.variant, "Krea 2");
  eq("a Krea 2 LoRA fits it", loraFits("Krea 2", ck.variant).fit, "yes");
  eq("a FLUX LoRA does not", loraFits("FLUX", ck.variant).fit, "no");
  eq("...nor an H3 one", loraFits("MiniMax H3", ck.variant).fit, "no");
}

console.log("\n§3  /api/loras judges `for=` against a bare DiT as well as a checkpoint");
{
  const index = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  ok("the lookup reads checkpoints, diffusion_models and unet",
    /const ck = findShelfModel\(shelf, \["checkpoints", "diffusion_models", "unet"\], forName\);/.test(index));
  const mcp = fs.readFileSync(new URL("./mcp.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  ok("list_loras says so", /`for` may also name a file in models\/diffusion_models or unet/.test(mcp));
}

console.log("\n§4  YuE2 discovery separates the audio and planner tensor namespaces");
{
  const audio = ["diffusion_model.model.layers.0.self_attn.qkv_proj.lora_down.weight",
    "diffusion_model.model.layers.0.self_attn.qkv_proj.lora_up.weight"];
  const planner = ["text_encoders.model.layers.0.mlp.gate_up_proj.lora_down.weight",
    "text_encoders.model.layers.0.mlp.gate_up_proj.lora_up.weight"];
  const fused = [...audio, ...planner];
  eq("both halves stay YuE2 even without latent bridge deltas", loraTarget(fused).variant, "YuE2");
  eq("the probe exposes both branches", detect(new Set(fused), {}).loraParts, { audio: true, planner: true, fused: true });
  eq("audio-only remains an ordinary adapter", yue2LoraParts(audio), { audio: true, planner: false, fused: false });
  eq("planner-only is detected from its own native namespace", loraTarget(planner).variant, "YuE2");
  eq("planner-only is not a fused style", yue2LoraParts(planner), { audio: false, planner: true, fused: false });
  const qwen = ["text_encoders.qwen3.transformer.model.layers.0.self_attn.qkv_proj.lora_down.weight"];
  ok("Qwen's text encoder is not identified as the YuE2 planner", loraTarget(qwen).variant !== "YuE2");
  eq("Qwen alongside an audio adapter cannot invent a planner half", yue2LoraParts([...audio, ...qwen]), { audio: true, planner: false, fused: false });
  eq("full checkpoint tensors cannot count as LoRA branches", yue2LoraParts(fused.map(key => key.replace(/\.lora_(?:down|up)\.weight$/, ".weight"))), { audio: false, planner: false, fused: false });
  eq("an unidentified architecture stays unverified, not disabled", loraFits("unknown base", "YuE2").fit, "unknown");
  eq("a verified wrong architecture remains refused", loraFits("FLUX", "YuE2").fit, "no");

  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), "aiplay-yue2-discovery-"));
  try {
    // A valid small safetensors fixture exercises the same header reader as the shelf.
    const tensors = Object.fromEntries(fused.map((key, i) => [key, { dtype: "F32", shape: [1, 1], data_offsets: [i * 4, (i + 1) * 4] }]));
    const header = Buffer.from(JSON.stringify({ __metadata__: { name: "New local voice", trigger: "voice" }, ...tensors }));
    const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(header.length));
    const file = path.join(temporary, "renamed-unlisted.safetensors");
    await fs.promises.writeFile(file, Buffer.concat([length, header, Buffer.alloc(fused.length * 4)]));
    const probe = await probeModel(file);
    eq("an unlisted filename probes as a LoRA", probe.family, "lora");
    eq("its tensor architecture, not name, is YuE2", probe.variant, "YuE2");
    eq("its separate parts survive probeModel", probe.loraParts, { audio: true, planner: true, fused: true });
    eq("explicit trigger metadata remains available for discovery", probe.metadata.trigger, "voice");
  } finally {
    if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir())) throw new Error("Unexpected discovery fixture path");
    await fs.promises.rm(temporary, { recursive: true, force: true });
  }
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
