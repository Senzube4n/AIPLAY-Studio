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
import { loraTarget, detect, loraFits } from "./detect.js";

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
    /const ck = shelf\.find\(\(f\) => \["checkpoints", "diffusion_models", "unet"\]\.includes\(f\.folder\) && f\.name === forName\);/.test(index));
  const mcp = fs.readFileSync(new URL("./mcp.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  ok("list_loras says so", /`for` may also name a file in models\/diffusion_models or unet/.test(mcp));
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
