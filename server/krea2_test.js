/**
 * Krea 2 Turbo as an image engine, 2026-09-17.
 *
 * §1 the graph is the vendor's local recipe, node by node. §2 every place an
 * engine is enumerated names krea2 — the config door, the create door, the
 * tool's enum, the page's option and table (8 steps, no negative, the same
 * ceiling as the route) — and the door refuses references and a negative by
 * sentence. §3 the catalogue row carries the three files with the sizes and
 * hashes read off the publisher, is mapped from the engine name for rights
 * stamping, and quotes the licence. No card.
 */
import fs from "node:fs";
import { krea2Graph, KREA2_FILES, KREA2_PRESET } from "./workflow.js";
import { CATALOG, MODEL_TO_CAPABILITY } from "./models.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

console.log("\n§1  the graph");
{
  const g = krea2Graph({ prompt: "a red bicycle", seed: 7, width: 1000, height: 700, prefix: "p" });
  eq("the DiT, through UNETLoader", [g[1].class_type, g[1].inputs.unet_name], ["UNETLoader", "krea2_turbo_int8_convrot.safetensors"]);
  eq("the Qwen3-VL 4B encoder, read as type krea2", [g[2].class_type, g[2].inputs.clip_name, g[2].inputs.type], ["CLIPLoader", "qwen3vl_4b_fp8_scaled.safetensors", "krea2"]);
  eq("the Qwen image VAE", [g[3].class_type, g[3].inputs.vae_name], ["VAELoader", "qwen_image_vae.safetensors"]);
  eq("the prompt, and a zeroed negative (cfg 1 never reads it)", [g[4].inputs.text, g[5].class_type, g[5].inputs.conditioning], ["a red bicycle", "ConditioningZeroOut", ["4", 0]]);
  eq("a 16-channel latent, snapped to 16", [g[7].class_type, g[7].inputs.width, g[7].inputs.height], ["EmptySD3LatentImage", 1008, 704]);
  eq("KSampler: 8 steps, cfg 1, euler / simple, full denoise", [g[8].inputs.steps, g[8].inputs.cfg, g[8].inputs.sampler_name, g[8].inputs.scheduler, g[8].inputs.denoise], [8, 1, "euler", "simple", 1]);
  eq("...on the bare model (the class carries its own shift)", g[8].inputs.model, ["1", 0]);
  eq("decode, save, and a thumbnail", [g[17].class_type, g[13].class_type, g[14].class_type, g[15].inputs.filename_prefix], ["VAEDecode", "SaveImage", "ImageScale", "p_thumb"]);
  eq("a step override is honoured", krea2Graph({ prompt: "x", seed: 1, steps: 12 })[8].inputs.steps, 12);
  eq("the preset the page mirrors", [KREA2_PRESET.steps, KREA2_PRESET.cfgs], [8, false]);
  eq("the files the row must carry", Object.values(KREA2_FILES), ["krea2_turbo_int8_convrot.safetensors", "qwen3vl_4b_fp8_scaled.safetensors", "qwen_image_vae.safetensors"]);
}

console.log("\n§2  every list, and the door's refusals");
{
  const index = src("./index.js"), art = src("./art.js"), mcp = src("./mcp.js"), app = src("../web/app.js"), html = src("../web/index.html");
  ok("the config door lists krea2 and gates it on the row", /"ideogram4", "krea2", "checkpoint"\]\.includes\(b\.engine\)/.test(index) && /if \(b\.engine === "krea2"\) \{\n\s+const cap = \(await models\.status\(\)\)\.find\(\(c\) => c\.id === "imageKrea2"\);/.test(index));
  ok("the create door lists it", /"ideogram4", "krea2", "checkpoint"\]\.includes\(b\.engine\) \? b\.engine : "flux2"/.test(index));
  ok("...refuses references by sentence", /Krea 2 has no reference input — in-context editing is FLUX\.2's trick\./.test(index));
  ok("...and refuses a negative, because cfg 1 never reads it", /Krea 2 Turbo is distilled and samples at cfg 1\.0, where the negative prompt is never evaluated/.test(index));
  ok("the queue builds the graph for it, steps undefined unless asked", /engine === "krea2"\) \{[\s\S]*?graph = krea2Graph\(\{[\s\S]*?steps: standalone \? job\.steps : undefined,/.test(art));
  ok("the tool's enum names it", /enum: \["flux2", "zimage", "zimage-base", "anima", "ideogram4", "krea2", "checkpoint"\]/.test(mcp));
  const engStart = app.indexOf("const IMG_ENGINES = {");
  const block = app.slice(engStart, app.indexOf('$("imgEngine").onchange', engStart));
  const entry = /krea2:\s*\{[^}]*\}/.exec(block)?.[0] || "";
  ok("the page's table: 8 steps, no negative, ceiling 30 (the route's)", /steps:\s*8\b/.test(entry) && /negative:\s*false/.test(entry) && /maxSteps:\s*30\b/.test(entry), entry.slice(0, 120));
  ok("...and the option is offered", /<option value="krea2">Krea 2 Turbo/.test(html));
  ok("...with the refs note naming the engine", /eng === "krea2"\n\s+\? "Krea 2 has no reference input/.test(app));
}

console.log("\n§3  the catalogue row");
{
  const row = CATALOG.find((c) => c.id === "imageKrea2");
  ok("the row exists and makes pictures", !!row && row.makes === "picture");
  if (row) {
    eq("three files", row.files.length, 3);
    const byName = Object.fromEntries(row.files.map((f) => [f.dest.split(/[\\/]/).pop(), f]));
    eq("the DiT: publisher's revision, size, hash", [/Comfy-Org\/Krea-2\/resolve\/6b1d7191d84d5ded74d83a1a98211dad0ac8ae25\/diffusion_models\/krea2_turbo_int8_convrot\.safetensors$/.test(byName["krea2_turbo_int8_convrot.safetensors"]?.url || ""), byName["krea2_turbo_int8_convrot.safetensors"]?.bytes, byName["krea2_turbo_int8_convrot.safetensors"]?.sha256],
      [true, 13492686496, "8e4eeda70dd5037ab1ba2bef6b417f9f901e26093117cf397f741fc1fdaaf3f1"]);
    eq("the encoder: revision, size, hash", [/Comfy-Org\/Krea-2\/resolve\/4aa0eed112bd2780ceea37583edbdcd2df6c2c09\/text_encoders\/qwen3vl_4b_fp8_scaled\.safetensors$/.test(byName["qwen3vl_4b_fp8_scaled.safetensors"]?.url || ""), byName["qwen3vl_4b_fp8_scaled.safetensors"]?.bytes, byName["qwen3vl_4b_fp8_scaled.safetensors"]?.sha256],
      [true, 5242467968, "54bd5144df0bbc25dd6ccadfcb826b521445a1b06ae5a42570bdd2974ca87094"]);
    eq("the VAE is the same file Anima carries", byName["qwen_image_vae.safetensors"]?.bytes, 253806246);
    ok("the licence is named and quoted with its thresholds", /Krea 2 Community Licen[cs]e/.test(row.licence) && /1,?000,?000|1M|1 million/i.test(JSON.stringify(row.outputRights)) && /50/.test(JSON.stringify(row.outputRights)));
    ok("...sellable with conditions", row.outputRights?.class === "yours-with-conditions" && row.outputRights?.sellable === true);
    eq("the engine name maps to the row for rights stamping", MODEL_TO_CAPABILITY?.krea2, "imageKrea2");
  }
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
