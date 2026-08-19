/**
 * Can LTX 2.5 restyle a video while following its motion?
 *
 *   node scripts/ltx_v2v_probe.mjs [guideEvery] [strength]
 *
 * THE QUESTION. The feedback renderer preserves a pose by using a LOW denoise,
 * which is why it is stuck choosing between "barely changed" and
 * "unrecognisable" — measured, one pass at 0.75 destroys the figure and 0.50
 * barely touches it. Reading ComfyUI_Yvann-Nodes' own workflows showed the way
 * round it: their video-to-video graph runs at denoise 1.0 — FULL generation —
 * and constrains the pose with ControlNet instead of with denoise.
 *
 * We have no ControlNet models. But `LTXVAddGuide` does the same job by a
 * different route: it writes a real image into the latent at a chosen frame
 * index and rewrites the conditioning around it. Our own LTX graph already uses
 * exactly two of them, for the first and last frame of a loop. Nothing says it
 * has to be two.
 *
 * So: a guide every Nth frame, taken from the source video, and a style prompt
 * doing whatever it likes in between. If it works it beats the feedback chain on
 * every axis — LTX is temporally coherent by construction rather than by our
 * blending, it has REAL CFG so a negative prompt exists, and one 121-frame run
 * costs about what 43 klein frames cost.
 *
 * ⚠ A guided run stops after ONE pass — no latent upscaler — so it renders at
 * full size directly. That is the vendor's own template, not our choice.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { config } from "../server/config.js";
import { alignFrames, videoEngine } from "../server/workflow.js";

const BASE = `http://${config.comfy.host}:${config.comfy.port}`;
const v = videoEngine("ltx");

const SRC_DIR = process.argv[4] || "aiplay_v2v";
const EVERY = Number(process.argv[2]) || 8;
const STRENGTH = Number(process.argv[3]) || 0.7;

const W = 1280, H = 704, FPS = v.fps;
const FRAMES = alignFrames(5, FPS, "ltx");          // 121 for LTX

const PROMPT = "the dancing woman coated in thick flowing liquid paint, molten "
  + "magenta cyan and gold enamel running over her body and trailing behind her, "
  + "glossy wet reflections, dark studio, dramatic rim light";
const NEGATIVE = "illustration, cartoon, drawing, text, watermark, logo, "
  + "cluttered background, floating objects, " + v.negative;

async function build() {
  const all = (await readdir(path.join(config.inputDir, SRC_DIR)))
    .filter((f) => /\.png$/i.test(f)).sort();
  if (!all.length) throw new Error(`no frames in input/${SRC_DIR}`);

  /* Which source frames become guides. Every Nth across the clip, so the model
   * is pinned to the real motion at regular intervals and free to invent the
   * style in between. Too few and it drifts off the choreography; too many and
   * there is no room left for it to restyle anything. That trade is the whole
   * experiment. */
  const idx = [];
  for (let i = 0; i < FRAMES; i += EVERY) idx.push(Math.min(i, all.length - 1));
  if (idx[idx.length - 1] !== FRAMES - 1) idx.push(FRAMES - 1);

  const g = {
    1: { class_type: "UNETLoader", inputs: { unet_name: v.dit, weight_dtype: "default" } },
    2: { class_type: "CLIPLoader", inputs: { clip_name: v.textEncoder, type: "ltxv", device: "default" } },
    3: { class_type: "VAELoader", inputs: { vae_name: v.videoVae } },
    4: { class_type: "VAELoader", inputs: { vae_name: v.audioVae } },
    6: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: PROMPT } },
    7: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: NEGATIVE } },
    8: { class_type: "LTXVConditioning", inputs: { positive: ["6", 0], negative: ["7", 0], frame_rate: FPS } },
    9: { class_type: "EmptyLTXVLatentVideo", inputs: { width: W, height: H, length: FRAMES, batch_size: 1 } },
  };

  /* Chain the guides. Each one takes the previous one's rewritten conditioning
   * and latent — outputs are [0] positive, [1] negative, [2] latent — so they
   * compose rather than overwrite. */
  let pos = ["8", 0], neg = ["8", 1], lat = ["9", 0];
  let n = 100;
  for (let k = 0; k < idx.length; k++) {
    const frameIdx = Math.min(k * EVERY, FRAMES - 1);
    const srcName = all[Math.min(idx[k], all.length - 1)];
    g[n] = { class_type: "LoadImage", inputs: { image: `${SRC_DIR}/${srcName}` } };
    g[n + 1] = { class_type: "ImageScale", inputs: { image: [String(n), 0], upscale_method: "lanczos", width: W, height: H, crop: "disabled" } };
    // img_compression 18 is the vendor's number — it is what a guide expects.
    g[n + 2] = { class_type: "LTXVPreprocess", inputs: { image: [String(n + 1), 0], img_compression: 18 } };
    g[n + 3] = {
      class_type: "LTXVAddGuide",
      inputs: { positive: pos, negative: neg, vae: ["3", 0], latent: lat,
                image: [String(n + 2), 0], frame_idx: frameIdx, strength: STRENGTH },
    };
    pos = [String(n + 3), 0]; neg = [String(n + 3), 1]; lat = [String(n + 3), 2];
    n += 10;
  }

  Object.assign(g, {
    10: { class_type: "LTXVEmptyLatentAudio", inputs: { frames_number: FRAMES, frame_rate: FPS, batch_size: 1, audio_vae: ["4", 0] } },
    11: { class_type: "LTXVConcatAVLatent", inputs: { video_latent: lat, audio_latent: ["10", 0] } },
    12: { class_type: "RandomNoise", inputs: { noise_seed: 555 } },
    13: { class_type: "KSamplerSelect", inputs: { sampler_name: v.sampler } },
    14: { class_type: "ManualSigmas", inputs: { sigmas: v.sigmasLow } },
    /* Full generation. The guides hold the pose, so denoise does not have to —
     * which is exactly the trade that low-denoise img2img cannot make. */
    15: { class_type: "LTXVDualCFGGuider", inputs: { model: ["1", 0], positive: pos, negative: neg,
          video_cfg: v.videoCfg, audio_cfg: v.audioCfg } },
    16: { class_type: "SamplerCustomAdvanced", inputs: { noise: ["12", 0], guider: ["15", 0], sampler: ["13", 0], sigmas: ["14", 0], latent_image: ["11", 0] } },
    // Guided runs read the DENOISED output, index 1.
    17: { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["16", 1] } },
    18: { class_type: "LTXVCropGuides", inputs: { positive: pos, negative: neg, latent: ["17", 0] } },
    19: { class_type: "VAEDecodeTiled", inputs: { samples: ["18", 2], vae: ["3", 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 16 } },
    20: { class_type: "CreateVideo", inputs: { images: ["19", 0], fps: FPS } },
    21: { class_type: "SaveVideo", inputs: { video: ["20", 0], filename_prefix: "v2v/ltx", format: "auto", codec: "auto" } },
  });
  return { g, guides: idx.length };
}

const { g, guides } = await build();
console.log(`LTX v2v — ${FRAMES} frames at ${FPS}fps, ${W}x${H}`);
console.log(`  ${guides} guides (every ${EVERY} frames), strength ${STRENGTH}, full denoise`);

const t0 = Date.now();
const r = await fetch(`${BASE}/prompt`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: g }),
});
if (!r.ok) { console.error("REJECTED:", (await r.text()).slice(0, 900)); process.exit(1); }
const { prompt_id } = await r.json();

for (;;) {
  await new Promise((s) => setTimeout(s, 2000));
  const h = await (await fetch(`${BASE}/history/${prompt_id}`)).json();
  const e = h[prompt_id];
  if (!e) { process.stdout.write("."); continue; }
  if (e.status?.status_str === "error") {
    console.error("\nFAILED:", JSON.stringify(e.status.messages || "").slice(0, 1200));
    process.exit(1);
  }
  if (e.status?.completed) {
    const out = Object.values(e.outputs || {}).flatMap((o) => o.images || o.videos || [])[0];
    console.log(`\n  done in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${out?.subfolder}/${out?.filename}`);
    break;
  }
}
