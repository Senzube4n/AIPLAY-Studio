/**
 * Does FLUX.2 klein respond to an image reference?
 *
 *   node scripts/styleref_probe.mjs
 *
 * This is the experiment that decides whether the restyle look is reachable at
 * all. Six parameter variants of the feedback renderer all converged to graphic
 * collage, and the diagnosis was that text conditioning cannot hold a chain to a
 * visual style — what it needs is a style REFERENCE IMAGE, which I had assumed
 * meant IPAdapter and therefore meant "not available here".
 *
 * `ReferenceLatent` is FLUX's own image-conditioning path and needs no extra
 * model at all: encode a picture, hand it to the conditioning, done. Whether
 * the 4B klein distillation actually honours it is a different question from
 * whether the node exists, so this renders the same source frame four ways and
 * MEASURES how far each lands from the style reference rather than asking me to
 * squint at them:
 *
 *   A  text prompt only, no reference          (the current behaviour)
 *   B  reference only, empty-ish prompt        (does the image alone steer it?)
 *   C  reference + prompt                      (the combination we would ship)
 *   D  reference + prompt, higher denoise      (does more freedom help or hurt?)
 *
 * The measurement is colour-histogram distance in LAB against the reference. It
 * is crude, but "did the palette move towards the reference" is exactly the
 * question, and a number settles it where an opinion would not.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../server/config.js";

const BASE = `http://${config.comfy.host}:${config.comfy.port}`;
const W = 1024, H = 576, STEPS = 16;

const SRC = "aiplay_src2/s_0001.png";
// The liquid-paint still from the Images screen — the look we are trying to reach.
const REF = "aiplay_ref/style.png";

const PROMPT = "the dancing figure formed out of thick flowing liquid paint, "
  + "molten enamel and marbled ink, glossy wet, saturated magenta cyan and gold";

function graph({ useRef, text, denoise, prefix }) {
  const a = config.art;
  const g = {
    1: { class_type: "UNETLoader", inputs: { unet_name: a.dit, weight_dtype: "default" } },
    2: { class_type: "CLIPLoader", inputs: { clip_name: a.textEncoder, type: "flux2", device: "default" } },
    3: { class_type: "VAELoader", inputs: { vae_name: a.vae } },
    4: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text } },

    20: { class_type: "LoadImage", inputs: { image: SRC } },
    21: { class_type: "ImageScale", inputs: { image: ["20", 0], upscale_method: "lanczos", width: W, height: H, crop: "disabled" } },
    22: { class_type: "VAEEncode", inputs: { pixels: ["21", 0], vae: ["3", 0] } },

    7: { class_type: "Flux2Scheduler", inputs: { steps: STEPS, width: W, height: H } },
    8: { class_type: "SplitSigmasDenoise", inputs: { sigmas: ["7", 0], denoise } },
    9: { class_type: "KSamplerSelect", inputs: { sampler_name: a.sampler } },
    10: { class_type: "RandomNoise", inputs: { noise_seed: 4242 } },
  };

  let cond = ["4", 0];
  if (useRef) {
    /* The reference is encoded exactly like any other picture and handed to the
     * conditioning. No adapter, no CLIP-vision tower, no second checkpoint —
     * which is the whole reason this is worth testing before reaching for one. */
    g[30] = { class_type: "LoadImage", inputs: { image: REF } };
    g[31] = { class_type: "ImageScale", inputs: { image: ["30", 0], upscale_method: "lanczos", width: W, height: H, crop: "disabled" } };
    g[32] = { class_type: "VAEEncode", inputs: { pixels: ["31", 0], vae: ["3", 0] } };
    g[33] = { class_type: "ReferenceLatent", inputs: { conditioning: cond, latent: ["32", 0] } };
    cond = ["33", 0];
  }

  g[5] = { class_type: "ConditioningZeroOut", inputs: { conditioning: cond } };
  g[6] = { class_type: "CFGGuider", inputs: { model: ["1", 0], positive: cond, negative: ["5", 0], cfg: a.cfg } };
  g[41] = {
    class_type: "SamplerCustomAdvanced",
    inputs: { noise: ["10", 0], guider: ["6", 0], sampler: ["9", 0], sigmas: ["8", 1], latent_image: ["22", 0] },
  };
  g[42] = { class_type: "VAEDecode", inputs: { samples: ["41", 0], vae: ["3", 0] } };
  g[60] = { class_type: "SaveImage", inputs: { images: ["42", 0], filename_prefix: `styleref/${prefix}` } };
  return g;
}

async function run(spec) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/prompt`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph(spec) }),
  });
  if (!r.ok) throw new Error((await r.text()).slice(0, 500));
  const { prompt_id } = await r.json();
  for (;;) {
    await new Promise((s) => setTimeout(s, 300));
    const h = await (await fetch(`${BASE}/history/${prompt_id}`)).json();
    const e = h[prompt_id];
    if (!e) continue;
    if (e.status?.status_str === "error") throw new Error(JSON.stringify(e.status.messages || "").slice(0, 500));
    if (e.status?.completed) {
      const o = Object.values(e.outputs || {}).flatMap((x) => x.images || [])[0];
      return { file: path.join(config.outputDir, o.subfolder || "", o.filename), seconds: (Date.now() - t0) / 1000 };
    }
  }
}

const CASES = [
  { key: "A_text_only", useRef: false, text: PROMPT, denoise: 0.5, prefix: "A" },
  { key: "B_ref_only", useRef: true, text: "a photograph", denoise: 0.5, prefix: "B" },
  { key: "C_ref_plus_text", useRef: true, text: PROMPT, denoise: 0.5, prefix: "C" },
  { key: "D_ref_deeper", useRef: true, text: PROMPT, denoise: 0.6875, prefix: "D" },
];

const out = [];
for (const c of CASES) {
  try {
    const r = await run(c);
    console.log(`  ${c.key.padEnd(18)} ${r.seconds.toFixed(1)}s  ${r.file}`);
    out.push({ ...c, ...r });
  } catch (err) {
    console.log(`  ${c.key.padEnd(18)} FAILED: ${String(err.message).slice(0, 300)}`);
  }
}
await writeFile(path.join(config.outputDir, "styleref", "cases.json"), JSON.stringify(out, null, 1));
console.log("\nwrote cases.json");
