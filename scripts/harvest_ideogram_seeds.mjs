/**
 * Ideogram 4 pass-seed harvester.
 *
 * The open Ideogram 4 weights are noise-locked: only a sparse, DETERMINISTIC
 * set of seeds renders; the rest draw the model's trained-in refusal card
 * (measured: 1 pass in 23 probes). ComfyUI's noise is CPU-generated, so the
 * pass-set is the same on every machine — seeds found here work everywhere.
 *
 * Run it while the studio idles (it submits straight to the engine and yields
 * to nothing, so don't race a render batch):
 *
 *   node scripts/harvest_ideogram_seeds.mjs --count 100
 *
 * Passing seeds append to <outputDir>/ideogram_seeds.json, which the image
 * engine reads on every render. Expect a few percent to pass — a night of
 * harvesting buys a couple dozen compositions per prompt.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../server/config.js";

const COUNT = Number(process.argv[process.argv.indexOf("--count") + 1]) || 50;
const base = `http://${config.comfy.host}:${config.comfy.port}`;
const seedsFile = path.join(config.outputDir, "ideogram_seeds.json");
const known = new Set([777]);
try { for (const s of JSON.parse(fs.readFileSync(seedsFile, "utf8"))) known.add(s); } catch { /* fresh */ }

const graph = (seed) => ({
  1: { class_type: "UNETLoader", inputs: { unet_name: "ideogram4_fp8_scaled.safetensors", weight_dtype: "default" } },
  2: { class_type: "UNETLoader", inputs: { unet_name: "ideogram4_unconditional_fp8_scaled.safetensors", weight_dtype: "default" } },
  3: { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_8b_nvfp4.safetensors", type: "ideogram4", device: "default" } },
  /* A HARD probe prompt on purpose. The filter is a (prompt, noise) joint:
   * easy prompts pass ~40% of seeds, hard ones almost none — a seed that
   * renders THIS text-heavy poster (measured: ~13 straight refusals) is a
   * strong seed that will carry difficult prompts, which is the only kind
   * worth shipping. Harvesting on an easy prompt collects weak seeds. */
  4: { class_type: "CLIPTextEncode", inputs: { clip: ["3", 0], text: "a vintage travel poster, bold letters reading VISIT THE WHITE STUDIO, minimalist midcentury design, cream and teal" } },
  5: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },
  6: { class_type: "CFGOverride", inputs: { model: ["1", 0], cfg: 3, start_percent: 0.7, end_percent: 1 } },
  7: { class_type: "DualModelGuider", inputs: { model: ["6", 0], positive: ["4", 0], cfg: 7, model_negative: ["2", 0], negative: ["5", 0] } },
  8: { class_type: "Ideogram4Scheduler", inputs: { steps: 20, width: 1024, height: 1024, mu: 0.0, std: 1.75 } },
  9: { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
  10: { class_type: "RandomNoise", inputs: { noise_seed: seed } },
  11: { class_type: "EmptyFlux2LatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
  12: { class_type: "SamplerCustomAdvanced", inputs: { noise: ["10", 0], guider: ["7", 0], sampler: ["9", 0], sigmas: ["8", 0], latent_image: ["11", 0] } },
  16: { class_type: "VAELoader", inputs: { vae_name: "flux2-vae.safetensors" } },
  17: { class_type: "VAEDecode", inputs: { samples: ["12", 0], vae: ["16", 0] } },
  13: { class_type: "SaveImage", inputs: { images: ["17", 0], filename_prefix: "ideoharvest/probe" } },
});

// same minimal PNG luma-variance reader the app uses to spot the card
import zlib from "node:zlib";
function pngLumaVariance(buf) {
  try {
    if (buf.readUInt32BE(12) !== 0x49484452) return null;
    const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
    if (buf[24] !== 8 || buf[28] !== 0) return null;
    const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[buf[25]];
    if (!channels) return null;
    let off = 8; const idat = [];
    while (off + 12 <= buf.length) {
      const len = buf.readUInt32BE(off), type = buf.toString("ascii", off + 4, off + 8);
      if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
      if (type === "IEND") break;
      off += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const px = Buffer.alloc(stride * height);
    const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
    for (let y = 0; y < height; y++) {
      const f = raw[y * (stride + 1)];
      const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      const out = px.subarray(y * stride, (y + 1) * stride);
      const prev = y ? px.subarray((y - 1) * stride, y * stride) : null;
      for (let x = 0; x < stride; x++) {
        const a = x >= channels ? out[x - channels] : 0, b = prev ? prev[x] : 0;
        const c = x >= channels && prev ? prev[x - channels] : 0;
        let v = row[x];
        if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) v += paeth(a, b, c);
        out[x] = v & 0xff;
      }
    }
    let n = 0, sum = 0, sum2 = 0;
    for (let y = 0; y < height; y += 8) for (let x = 0; x < width; x += 8) {
      const i = y * stride + x * channels;
      const l = channels >= 3 ? (px[i] * 3 + px[i + 1] * 4 + px[i + 2]) >> 3 : px[i];
      n++; sum += l; sum2 += l * l;
    }
    const mean = sum / n;
    return sum2 / n - mean * mean;
  } catch { return null; }
}

const found = [];
for (let i = 0; i < COUNT; i++) {
  const seed = Math.floor(Math.random() * 4294967296);
  if (known.has(seed)) continue;
  const r = await fetch(`${base}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph(seed), client_id: "seed-harvest" }) });
  const { prompt_id } = await r.json();
  let img = null;
  for (;;) {
    await new Promise((s) => setTimeout(s, 2000));
    const h = await (await fetch(`${base}/history/${prompt_id}`)).json();
    const e = h[prompt_id];
    if (!e) continue;
    if (e.status?.status_str === "error") break;
    if (e.status?.completed) { img = e.outputs?.["13"]?.images?.[0]; break; }
  }
  if (!img) continue;
  const buf = fs.readFileSync(path.join(config.outputDir, img.subfolder || "", img.filename));
  const v = pngLumaVariance(buf);
  const pass = v !== null && v >= 120;
  console.log(`${String(i + 1).padStart(4)}/${COUNT} seed ${seed} -> ${pass ? "PASS" : "card"} (var ${v?.toFixed(0)})`);
  if (pass) {
    found.push(seed); known.add(seed);
    fs.writeFileSync(seedsFile, JSON.stringify([...known].filter((s) => s !== 777)));
  }
}
console.log(`done: ${found.length} new passing seeds${found.length ? ` (${found.join(", ")})` : ""} — total known: ${known.size}`);
