/**
 * The one fixed workflow the app injects. Users never see a node.
 *
 * Recovered from ComfyUI's own template
 * (comfyui_workflow_templates_json/templates/audio_minimax_music_3.json, unwrapped
 * from definitions.subgraphs[0]) rather than reconstructed by hand.
 *
 *   CLIPLoader(minimax) -> MiniMaxMusic3TextEncode -+-> KSampler-ish .positive
 *                                                   +-> ConditioningZeroOut -> .negative
 *                                                   +-> [seconds] -> EmptyMiniMaxMusic3LatentAudio
 *   UNETLoader ---------------------------------------> .model
 *   VAELoader -> VAEDecodeAudio <- sampler -> SaveAudio
 *
 * Two structural facts worth keeping in mind when editing this:
 *
 *  - `seconds` is an OUTPUT of the text encoder, not a literal. The model decides
 *    the real length and may finish early, so the duration control is a CEILING.
 *    Song length follows LYRIC length far more than it follows the slider.
 *  - The "text encode" node is not embedding text. It runs the autoregressive
 *    8-codebook RVQ generation and is ~40% of the render. It is also the part
 *    ComfyUI caches when only sampling parameters change, which is what makes
 *    re-rolling a mix cheap.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * Flow-matching shifted sigma schedule: sigma(t) = shift*t / (1 + (shift-1)*t),
 * t linear 1 -> 0. Measured ~2x closer to the converged solution than the stock
 * `simple` schedule at half the steps. shift < 1 is markedly worse, so the
 * direction is causal rather than coincidence.
 */
export function shiftSigmas(steps, shift) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = 1 - i / steps;
    out.push(i === steps ? 0 : (shift * t) / (1 + (shift - 1) * t));
  }
  return out;
}

/**
 * TWO SEEDS, deliberately:
 *
 *   `seed`     conditions the autoregressive stage — the performance itself.
 *   `mixSeed`  is the diffusion noise — the rendering of that performance.
 *
 * They are separate because that is what makes "re-roll the mix" a real feature.
 * Hold `seed` and change `mixSeed`: ComfyUI reuses the cached AR conditioning, so
 * you get the same take rendered differently for ~60% of a full render. Use one
 * seed for both and an identical request is simply cache-hit, returning the very
 * same file in 0.3 s — which is reproducibility, not a re-roll.
 *
 * @param {object} o
 * @param {string} o.caption      style description
 * @param {string} o.lyrics       section-tagged lyrics
 * @param {number} o.seed         conditioning seed (the performance)
 * @param {number} [o.mixSeed]    sampling noise seed (the mix); defaults to seed
 * @param {number} o.maxDuration  CEILING in seconds, not a target
 * @param {number} [o.steps]
 * @param {boolean} [o.preview]   fewer steps, same conditioning (AR is reused)
 * @param {string} [o.prefix]     output filename prefix
 */
export function buildGraph({
  caption,
  lyrics,
  seed,
  mixSeed,
  maxDuration = 240,
  steps,
  cfg,
  arCfg,
  flowCfg,
  model,
  // Absolute path to a captured trajectory npz. Set, and the AR stage replays
  // that song and continues it rather than starting a new one; only the NEW
  // frames come back, so the caller keeps the original audio untouched and
  // crossfades at the seam.
  resumeFrom,
  // Filename (inside ComfyUI's input dir) of a .latent written by
  // scripts/dav_encode.py from a user's audio. Set, and the sampler starts from
  // that song instead of from noise — see audioRefDenoise.
  audioRef,
  // How much of the schedule still runs, so LOW keeps more of the reference.
  // Measured 2026-08-17 at 15 steps / shift 5.0 against a deliberately opposite
  // caption, correlation to the reference vs to a pure text-to-music render:
  //     0.90+  0.31 ref  -- trims less than one step, reference ignored
  //     0.85   0.46 ref / 0.67 text  -- genuine blend. THE cover/remix setting.
  //     0.80   0.72 ref / 0.40 text  -- reference dominates; a variation.
  //     0.60   0.91 ref  -- effectively a copy.
  // The band is narrow and top-loaded because shifted sigmas put the
  // structure-setting steps at high sigma, which is the end being trimmed.
  audioRefDenoise = 0.85,
  preview = false,
  prefix = "aiplay",
}) {
  const s = config.sampling;
  const nSteps = steps ?? (preview ? s.previewSteps : s.steps);
  /* TWO different guidance scales, not one.
   *
   *   cfg_scale on MiniMaxMusic3TextEncode  -> guides the 8B LLM sampling the
   *     token trajectory. This is how hard the caption steers the COMPOSITION.
   *     ComfyUI's own default is 1.5 (ar.py CFG_SCALE).
   *   cfg on SamplerCustom                  -> guides flow-matching denoising.
   *     This is how hard the conditioning steers the RENDER.
   *
   * A single `cfg` used to drive both, which meant every tuning run walked the
   * diagonal arCfg == flowCfg and never sampled the off-diagonal. `cfg` still
   * sets both so nothing changes by default; pass arCfg / flowCfg to separate
   * them. */
  const nCfg = cfg ?? s.cfg;
  const nArCfg = arCfg ?? s.arCfg ?? nCfg;
  const nFlowCfg = flowCfg ?? s.flowCfg ?? nCfg;
  /* Partial denoise for audio reference, done here rather than with a custom
   * node: keeping the TAIL of the schedule is two lines of arithmetic, and doing
   * it in JS means the whole feature needs nothing installed in ComfyUI beyond
   * the stock nodes. Joe never has to know it happened. */
  let sigmaList = shiftSigmas(nSteps, s.shift);
  if (audioRef) {
    const keep = Math.max(1, Math.round(nSteps * audioRefDenoise));
    sigmaList = sigmaList.slice(-(keep + 1));
  }
  const sigmas = sigmaList.map((v) => v.toFixed(6)).join(", ");

  return {
    // --- loaders -----------------------------------------------------------
    1: {
      class_type: "UNETLoader",
      inputs: {
        unet_name: { fp32: config.models.ditFp32, fp16: config.models.ditFp16 }[model]
          || config.models.dit,
        weight_dtype: "default",
      },
    },
    2: {
      class_type: "CLIPLoader",
      inputs: { clip_name: config.models.textEncoder, type: "minimax", device: "default" },
    },
    3: { class_type: "VAELoader", inputs: { vae_name: config.models.vae } },

    // --- conditioning (the expensive, cacheable part) -----------------------
    4: {
      class_type: "MiniMaxMusic3TextEncode",
      inputs: {
        clip: ["2", 0],
        caption,
        lyrics,
        seed,
        max_duration: maxDuration,
        cfg_scale: nArCfg,
        top_k: s.topK,
        resume_from: resumeFrom || "",
      },
    },
    5: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },
    /* The starting point of the flow.
     *
     * Normally zeros. With an audio reference, the encoded latent of a real
     * song — which is the ENTIRE trick, and it needs no custom node: the DAV
     * decoder tensors ComfyUI ships are bit-identical to the encoder half we
     * run outside it, so a latent we write is one ComfyUI already understands.
     * Its length then sets the duration, overriding the model's own estimate,
     * which is what you want: a cover runs as long as what it covers. */
    6: audioRef
      ? { class_type: "LoadLatent", inputs: { latent: audioRef } }
      : {
          class_type: "EmptyMiniMaxMusic3LatentAudio",
          // `seconds` wired from the encoder — the model's decision, not ours.
          inputs: { seconds: ["4", 1], batch_size: 1 },
        },

    // --- sampling ----------------------------------------------------------
    10: { class_type: "KSamplerSelect", inputs: { sampler_name: s.sampler } },
    11: { class_type: "ManualSigmas", inputs: { sigmas } },
    7: {
      class_type: "SamplerCustom",
      inputs: {
        model: ["1", 0],
        add_noise: true,
        // The mix seed, NOT the conditioning seed — see the note above.
        noise_seed: mixSeed ?? seed,
        cfg: nFlowCfg,
        positive: ["4", 0],
        negative: ["5", 0],
        sampler: ["10", 0],
        sigmas: ["11", 0],
        latent_image: ["6", 0],
      },
    },

    // --- decode + write ----------------------------------------------------
    // fp32 VAE by configuration; see config.js for why that is not negotiable.
    8: { class_type: "VAEDecodeAudio", inputs: { samples: ["7", 0], vae: ["3", 0] } },
    9: saveAudioNode(prefix),
  };
}

/**
 * The writer for the configured output format.
 *
 * Three separate node classes rather than `SaveAudioAdvanced`: that node takes a
 * COMFY_DYNAMICCOMBO_V3 whose shape changes with the chosen format, which is
 * awkward to submit over the plain API and buys nothing here — we already know
 * the format at graph-build time.
 */
export function saveAudioNode(prefix) {
  const o = config.output;
  const audio = ["8", 0];
  if (o.format === "mp3") {
    return { class_type: "SaveAudioMP3", inputs: { audio, filename_prefix: prefix, quality: o.mp3Quality } };
  }
  if (o.format === "opus") {
    return { class_type: "SaveAudioOpus", inputs: { audio, filename_prefix: prefix, quality: o.opusQuality } };
  }
  return { class_type: "SaveAudio", inputs: { audio, filename_prefix: prefix } };
}

/** File extension the current format produces. Several places need to find "the
 *  newest output" and would otherwise keep looking for .flac forever. */
export const OUTPUT_EXT = () => ({ mp3: ".mp3", opus: ".opus" }[config.output.format] || ".flac");

/**
 * Cover art — FLUX.2 klein 4B distilled, text to image.
 *
 * Recovered from ComfyUI's own bundled template
 * (comfyui_workflow_templates_json/templates/image_flux2_klein_text_to_image.json,
 * unwrapped from definitions.subgraphs[1] — the DISTILLED one; subgraphs[0] is
 * the base variant and wants cfg 5 / 20 steps instead).
 *
 *   UNETLoader ------------------------------> CFGGuider.model
 *   CLIPLoader -> CLIPTextEncode -+----------> CFGGuider.positive
 *                                 +-> Zero --> CFGGuider.negative
 *   Flux2Scheduler(steps,w,h) ---------------> SamplerCustomAdvanced.sigmas
 *   EmptyFlux2LatentImage -------------------> .latent_image
 *   VAELoader -> VAEDecode <- sampler -> SaveImage
 *
 * Two things worth not "fixing" later:
 *
 *  - `cfg: 1` is correct. The distilled model has classifier-free guidance
 *    trained out of it; the negative branch exists only because CFGGuider
 *    requires the input, and it is a zeroed copy of the positive. Raising cfg
 *    does not sharpen prompt adherence here, it degrades it.
 *  - Flux2Scheduler takes WIDTH AND HEIGHT, not just steps. The sigma schedule is
 *    resolution-dependent, so passing a size to the latent but not the scheduler
 *    silently produces a mismatched schedule.
 */
export function coverGraph({
  prompt,
  seed,
  width,
  height,
  steps,
  // How many variants to draw from ONE text encode. Takes 1-4 of a song share a
  // caption, so they share a prompt, so they should share the encode: at 1024²
  // a single image costs 3.3 s of which ~1.7 s is encoding, and the encode is
  // paid once per GRAPH, not once per image. Four separate graphs cost ~13 s;
  // one graph with count 4 costs ~8 s for the same four pictures.
  count = 1,
  prefix = "cover",
}) {
  const a = config.art;
  const w = width ?? a.size;
  const h = height ?? a.size;
  return {
    1: { class_type: "UNETLoader", inputs: { unet_name: a.dit, weight_dtype: "default" } },
    // `type: "flux2"` selects the Qwen3 tokenizer/encoder path. Wrong type here
    // loads the weights fine and produces garbage conditioning.
    2: { class_type: "CLIPLoader", inputs: { clip_name: a.textEncoder, type: "flux2", device: "default" } },
    3: { class_type: "VAELoader", inputs: { vae_name: a.vae } },

    4: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: prompt } },
    5: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },
    6: {
      class_type: "CFGGuider",
      inputs: { model: ["1", 0], positive: ["4", 0], negative: ["5", 0], cfg: a.cfg },
    },

    7: { class_type: "Flux2Scheduler", inputs: { steps: steps ?? a.steps, width: w, height: h } },
    8: { class_type: "KSamplerSelect", inputs: { sampler_name: a.sampler } },
    9: { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    10: { class_type: "EmptyFlux2LatentImage", inputs: { width: w, height: h, batch_size: Math.max(1, count) } },
    11: {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: ["9", 0], guider: ["6", 0], sampler: ["8", 0],
        sigmas: ["7", 0], latent_image: ["10", 0],
      },
    },

    12: { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["3", 0] } },
    13: { class_type: "SaveImage", inputs: { images: ["12", 0], filename_prefix: prefix } },

    /* A thumbnail, emitted from the SAME graph.
     *
     * 48 covers at 1024² are 81 MB, and the library was decoding every one of
     * them to paint a 44px square — the exact shape of the player performance
     * problem this project already fixed once. Scaling here costs nothing
     * measurable (the latents are already on the GPU) and cuts what the list
     * actually loads by ~95%.
     *
     * lanczos because these are photographic and get downscaled 4x; bilinear
     * visibly mushes the fine grain the style prompt deliberately asks for. */
    14: {
      class_type: "ImageScale",
      inputs: {
        image: ["12", 0], upscale_method: "lanczos",
        width: config.art.thumbSize, height: config.art.thumbSize, crop: "center",
      },
    },
    15: { class_type: "SaveImage", inputs: { images: ["14", 0], filename_prefix: `${prefix}_thumb` } },
  };
}

/** Which graph node writes what. Read by art.js so the two SaveImage outputs are
 *  never told apart by array position, which breaks the moment count > 1. */
export const COVER_NODES = { full: "13", thumb: "15" };

/**
 * A short looping video clip — MiniMax H3.
 *
 * Wiring copied from ComfyUI's own bundled template
 * (video_minimax_h3_t2v.json, subgraph "Image to Video (MiniMax H3)") rather
 * than reconstructed, and then proven end to end on this rig before being
 * wired in: 864x480, 56 frames, 8 steps, ~25 s warm.
 *
 * Three things worth not "tidying" later:
 *
 *  - **VAEDecode and VAEDecodeAudio read the SAME latent.** There is no
 *    separate-AV-latent node in the vendor graph and adding one is wrong.
 *  - **`length` must satisfy `n mod 17 == 5`.** `align_frame_count` rounds UP
 *    silently, so an unaligned request quietly returns a longer clip than asked
 *    for. `alignFrames()` below does it explicitly so the caller knows.
 *  - **The shift node is the whole point.** It is absent from both official
 *    templates, so 12.0/3.0 ships unswept; 4.0 measured better on loop closure
 *    and flicker across four seeds at identical cost. See config.video.
 */
/**
 * Frame count for a requested duration — PER ENGINE.
 *
 * ⚠ The two engines disagree, and getting it wrong is silent:
 *   H3  rounds UP to n mod 17 == 5 inside align_frame_count, so an unaligned
 *       request quietly returns a LONGER clip than asked for.
 *   LTX wants fps * seconds + 1, plainly.
 *
 * This has two call sites — the graph builder and the render deadline in
 * art.js — and both must pass the engine, or the watchdog sizes itself from a
 * frame count the graph never renders.
 */
export function alignFrames(seconds, fps, engine = "h3") {
  const raw = Math.max(1, Math.round(seconds * fps));
  if (engine === "ltx") return raw + 1;
  let n = Math.max(5, raw);
  while (n % 17 !== 5) n += 1;
  return n;
}

/** The active engine's settings, or a named one. */
export function videoEngine(name) {
  const v = config.video;
  return v.engines[name || v.engine] || v.engines.h3;
}

/**
 * Dispatch. Two engines, two entirely different graphs — there is no useful
 * shared skeleton between a single-pass H3 render and LTX's half-res-then-
 * upscale-then-refine schedule, so this picks rather than parameterises.
 */
/* Which config field lives in which ComfyUI models sub-directory.
 *
 * Not every engine has every part — LTX has a latent upscaler and H3 has a turbo
 * LoRA — so a field that is absent from an engine is simply not checked. */
const VIDEO_MODEL_DIRS = {
  dit: "diffusion_models",
  textEncoder: "text_encoders",
  videoVae: "vae",
  audioVae: "vae",
  upscaler: "latent_upscale_models",
  turboLora: "loras",
};

/**
 * Are this engine's weights actually on disk?
 *
 * `config.video.enabled` is a PREFERENCE — a switch in Settings that defaults to
 * off because 34 GB of weights should not start downloading themselves. Whether
 * the weights are present is a FACT. The two were conflated, so an overnight run
 * that explicitly ticked "video" was dropped on a machine holding every model,
 * and the only symptom was a stage that said "waiting" until morning.
 *
 * Cheap enough to call per song: a handful of `statSync`s, no hashing.
 *
 * @returns {{ready: boolean, missing: string[]}}
 */
export function videoReady(name) {
  const e = videoEngine(name);
  const missing = [];
  for (const [key, sub] of Object.entries(VIDEO_MODEL_DIRS)) {
    const file = e[key];
    if (!file) continue;
    try {
      if (fs.statSync(path.join(config.rig, "ComfyUI", "models", sub, file)).size > 0) continue;
    } catch { /* falls through to missing */ }
    missing.push(file);
  }
  return { ready: missing.length === 0, missing };
}

/**
 * Restyle an existing video, keeping its motion.
 *
 * THE PROBLEM THIS SOLVES, and why the obvious approach does not. Preserving a
 * pose by using a LOW denoise forces a choice between two failures: measured on
 * FLUX.2 klein, one img2img pass at denoise 0.75 destroys the figure and 0.50
 * barely touches it. There is no value that both restyles and preserves.
 *
 * The way round it is not a better denoise. It is to run at FULL denoise and
 * constrain the motion by another route entirely — which is what
 * ComfyUI_Yvann-Nodes' own video-to-video workflow does with ControlNet, and
 * what `LTXVAddGuide` does here without needing one. A guide writes a real image
 * into the latent at a chosen frame index and rewrites the conditioning around
 * it. Our clip graph already uses exactly two, for the first and last frame of a
 * loop. Nothing said it had to be two.
 *
 * So: a guide every Nth frame from the source, and the model free to invent the
 * style in between. Measured on a 121-frame clip:
 *
 *     every  8 frames @ strength 0.70  ->  perfect motion, ZERO restyle
 *                                          (the guides simply reconstruct it)
 *     every 16 frames @ strength 0.30  ->  the look, motion still followed
 *     every 24 frames @ strength 0.15  ->  the look, looser
 *
 * ⚠ THE AUDIO DRIVES GUIDE STRENGTH, and that is the whole trick for making it
 * react. A weaker guide gives the model more freedom, so a loud passage restyles
 * harder and a quiet one stays closer to the source. It is the same idea as
 * driving denoise, except it survives: denoise on `SplitSigmasDenoise` is
 * quantised to 1/steps and a small range silently collapses to a two-level
 * square wave, whereas guide strength is a genuine float.
 *
 * ⚠ A guided run STOPS after one pass — no latent upscaler — so it renders at
 * full size directly. That is the vendor's template, not a choice.
 *
 * ⚠ The source video is read INSIDE ComfyUI — `LoadVideo` ->
 * `GetVideoComponents` -> `ImageFromBatch` picks any frame by index. No frame
 * extraction, no temp directory of PNGs, and above all no ffmpeg: this app
 * installs one npm dependency and shells out to nothing, and a feature that
 * quietly required ffmpeg on the user's PATH would break that promise for
 * everyone who does not have it.
 *
 * @param {object} o
 * @param {string} o.file          source video, relative to ComfyUI's input dir
 * @param {number[]} [o.strengths] one per guide; falls back to a flat value
 */
export function restyleGraph({
  file, prompt, negative, seed, width, height, fps,
  guideEvery = 16, guideStrength = 0.3, strengths = null,
  textureImage = null, texturePositions = null, textureStrength = 0.22,
  seconds, prefix = "restyle/r",
}) {
  const v = { ...config.video, ...config.video.engines.ltx };
  const w = width ?? v.width, h = height ?? v.height;
  const rate = fps ?? v.fps;
  const length = alignFrames(seconds ?? v.seconds, rate, "ltx");
  if (!file) throw new Error("restyleGraph needs a source video");

  const g = {
    1: { class_type: "UNETLoader", inputs: { unet_name: v.dit, weight_dtype: "default" } },
    2: { class_type: "CLIPLoader", inputs: { clip_name: v.textEncoder, type: "ltxv", device: "default" } },
    3: { class_type: "VAELoader", inputs: { vae_name: v.videoVae } },
    4: { class_type: "VAELoader", inputs: { vae_name: v.audioVae } },
    6: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: prompt } },
    /* LTX has REAL CFG — `LTXVDualCFGGuider` takes video_cfg and audio_cfg — so
     * unlike the distilled image model a negative prompt actually does
     * something here. It is the cheapest control in the whole graph. */
    7: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: negative ?? v.negative } },
    8: { class_type: "LTXVConditioning", inputs: { positive: ["6", 0], negative: ["7", 0], frame_rate: rate } },
    9: { class_type: "EmptyLTXVLatentVideo", inputs: { width: w, height: h, length, batch_size: 1 } },

    // The source, decoded once. Every guide indexes into this one batch.
    30: { class_type: "LoadVideo", inputs: { file } },
    31: { class_type: "GetVideoComponents", inputs: { video: ["30", 0] } },
  };

  /* Chain the guides. Each takes the previous one's rewritten conditioning and
   * latent — outputs are [0] positive, [1] negative, [2] latent — so they
   * compose rather than replace one another. */
  let pos = ["8", 0], neg = ["8", 1], lat = ["9", 0];
  let n = 100, used = 0;
  for (let i = 0; i < length; i += guideEvery) {
    const st = strengths?.[used] ?? guideStrength;
    /* Frame i of the source. `length: 1` matters — ImageFromBatch returns a
     * BATCH, and handing a multi-frame batch to a guide is not an error, it
     * just silently guides with the wrong picture. */
    g[n] = { class_type: "ImageFromBatch", inputs: { image: ["31", 0], batch_index: i, length: 1 } };
    g[n + 1] = { class_type: "ImageScale", inputs: { image: [String(n), 0], upscale_method: "lanczos", width: w, height: h, crop: "disabled" } };
    // img_compression 18 is the vendor's number — it is what a guide expects.
    g[n + 2] = { class_type: "LTXVPreprocess", inputs: { image: [String(n + 1), 0], img_compression: 18 } };
    g[n + 3] = {
      class_type: "LTXVAddGuide",
      inputs: { positive: pos, negative: neg, vae: ["3", 0], latent: lat,
                image: [String(n + 2), 0], frame_idx: i,
                strength: Math.min(1, Math.max(0.02, st)) },
    };
    pos = [String(n + 3), 0]; neg = [String(n + 3), 1]; lat = [String(n + 3), 2];
    n += 10; used++;
  }

  /* ── The texture guide, and why it is here ──────────────────────────────
   *
   * Reading ComfyUI_Yvann-Nodes' flagship graph, almost none of its look comes
   * from text — its positive prompt is the six words "4k, beautiful, high
   * quality, highly detailled, art". The look comes from IMAGES: four reference
   * pictures crossfaded per frame by IPAdapter, and the same pictures injected
   * as RGB hints AT THE PEAK FRAMES by SparseCtrl.
   *
   * We have neither node, and no CLIP-vision model to run IPAdapter with. But
   * `LTXVAddGuide` documents its input as "Image or video to condition the
   * latent video on" — nothing requires that image to come from the source. So
   * a texture guide at chosen frames is SparseCtrl's mechanism with the tool we
   * actually have, and putting those frames on the beat is what Yvann does with
   * `peaks_index`.
   *
   * ⚠ Deliberately WEAKER than a source guide (0.22 against ~0.3). It is
   * tinting the render, not pinning a frame — at source-guide strength the
   * texture simply replaces the dancer at every position it occupies, which is
   * a slideshow of paint with a person occasionally visible.
   */
  if (textureImage && texturePositions?.length) {
    let tn = 500;
    for (const idx of texturePositions) {
      const at = Math.max(0, Math.min(length - 1, Math.round(idx)));
      g[tn] = { class_type: "LoadImage", inputs: { image: textureImage } };
      g[tn + 1] = { class_type: "ImageScale", inputs: { image: [String(tn), 0], upscale_method: "lanczos", width: w, height: h, crop: "disabled" } };
      g[tn + 2] = { class_type: "LTXVPreprocess", inputs: { image: [String(tn + 1), 0], img_compression: 18 } };
      g[tn + 3] = {
        class_type: "LTXVAddGuide",
        inputs: { positive: pos, negative: neg, vae: ["3", 0], latent: lat,
                  image: [String(tn + 2), 0], frame_idx: at,
                  strength: Math.min(1, Math.max(0.02, textureStrength)) },
      };
      pos = [String(tn + 3), 0]; neg = [String(tn + 3), 1]; lat = [String(tn + 3), 2];
      tn += 10;
    }
  }

  Object.assign(g, {
    10: { class_type: "LTXVEmptyLatentAudio", inputs: { frames_number: length, frame_rate: rate, batch_size: 1, audio_vae: ["4", 0] } },
    11: { class_type: "LTXVConcatAVLatent", inputs: { video_latent: lat, audio_latent: ["10", 0] } },
    12: { class_type: "RandomNoise", inputs: { noise_seed: seed ?? 0 } },
    13: { class_type: "KSamplerSelect", inputs: { sampler_name: v.sampler } },
    14: { class_type: "ManualSigmas", inputs: { sigmas: v.sigmasLow } },
    15: { class_type: "LTXVDualCFGGuider", inputs: { model: ["1", 0], positive: pos, negative: neg,
          video_cfg: v.videoCfg, audio_cfg: v.audioCfg } },
    16: { class_type: "SamplerCustomAdvanced", inputs: { noise: ["12", 0], guider: ["15", 0], sampler: ["13", 0], sigmas: ["14", 0], latent_image: ["11", 0] } },
    // ⚠ A guided run reads the DENOISED output, index 1, not index 0.
    17: { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["16", 1] } },
    // Strips the pinned frames; leave them in and each guide visibly stutters.
    18: { class_type: "LTXVCropGuides", inputs: { positive: pos, negative: neg, latent: ["17", 0] } },
    19: { class_type: "VAEDecodeTiled", inputs: { samples: ["18", 2], vae: ["3", 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 16 } },
    20: { class_type: "CreateVideo", inputs: { images: ["19", 0], fps: rate } },
    21: { class_type: "SaveVideo", inputs: { video: ["20", 0], filename_prefix: prefix, format: "auto", codec: "auto" } },
  });
  return { graph: g, guides: used, length, fps: rate };
}

/**
 * Guide strength per guide, from the music.
 *
 * INVERTED on purpose, and this is the part that is easy to get backwards: a
 * WEAKER guide gives the model more freedom, so loud music must LOWER the
 * strength for the picture to react more. Driving it the intuitive way round
 * produces a video that goes flat exactly when the track gets big.
 *
 * @param {object} beats  the output of scripts/beats.py
 * @param {number} count  how many guides
 */
export function guideStrengths(beats, count, {
    /* ⚠ The band is narrow ON PURPOSE and its floor is high.
   *
   * Measured on a 121-frame clip: at guide strength 0.70 the motion is followed
   * perfectly and NOTHING is restyled — the guides simply reconstruct the
   * source. Below about 0.25 the opposite happens: the model stops following
   * the choreography and invents its own shot, which looks fine in isolation
   * and is not the video you gave it. The usable band is roughly 0.26 to 0.46,
   * and it is narrow enough that a "reasonable" wider range silently costs you
   * the motion at one end or the effect at the other. */
  band = "bass", start = 0, fps = 24, every = 16, min = 0.26, max = 0.46,
} = {}) {
  const v = beats?.bands?.[band];
  if (!v?.length) return Array.from({ length: count }, () => (min + max) / 2);
  const efps = beats.envFps || 30;

  // Percentiles over the RENDERED WINDOW, never the whole song — normalising
  // against a three-minute track and then reading five seconds out of it pins
  // the value flat, which reads as "the audio is not connected".
  const i0 = Math.max(0, Math.round(start * efps));
  const i1 = Math.min(v.length, Math.round((start + (count * every) / fps) * efps));
  const win = v.slice(i0, Math.max(i0 + 2, i1)).sort((a, b) => a - b);
  const lo = win[Math.floor(win.length * 0.10)];
  const hi = Math.max(lo + 0.05, win[Math.floor(win.length * 0.92)]);

  return Array.from({ length: count }, (_, k) => {
    const t = start + (k * every) / fps;
    const raw = Math.min(1, Math.max(0, (v[Math.min(v.length - 1, Math.round(t * efps))] - lo) / (hi - lo)));
    return max - (max - min) * raw;          // loud -> weaker guide -> more restyle
  });
}

/**
 * Morph between reference images, on the beat. No source video.
 *
 * THIS IS WHAT AUDIO-REACTIVE USUALLY MEANS. Eleven example videos from
 * ComfyUI_Yvann-Nodes were studied and almost none of them restyle footage —
 * they are abstract morphs: ink blots, neon forms, painterly shapes, flowing
 * continuously and pulsing with the music. Their flagship workflow is called
 * ImagesToVideo, you feed it four pictures, and the "video" is invented between
 * them. Restyling a real clip is their *unusual* case.
 *
 * How they do it: IPAdapter crossfades between the reference images per frame
 * for the continuous look, and SparseCtrl injects the same images as RGB hints
 * AT THE PEAK FRAMES for the punctuation. Their text prompt is six generic
 * words — essentially all of the look comes from the pictures.
 *
 * We have neither node and no CLIP-vision model. `LTXVAddGuide` replaces both:
 * put image A at frame 0, image B at the next beat, image C at the one after,
 * and the model has to invent a continuous path between them. That path IS the
 * morph, and the beat grid decides when each new picture arrives.
 *
 * ⚠ The images want to be *related*. Four pictures with nothing in common give
 * four hard cuts with mush in between, because there is no plausible continuous
 * path from one to the next — which is a statement about the pictures, not a
 * failure of the model.
 *
 * @param {string[]} images     input-relative names, cycled if fewer than positions
 * @param {number[]} positions  frame indices where each image lands
 * @param {number[]} [strengths] per position; a weaker guide is a softer arrival
 */
export function morphGraph({
  images, positions, strengths = null, prompt, negative, seed,
  width, height, fps, seconds, guideStrength = 0.55, prefix = "morph/m",
}) {
  const v = { ...config.video, ...config.video.engines.ltx };
  const w = width ?? v.width, h = height ?? v.height;
  const rate = fps ?? v.fps;
  const length = alignFrames(seconds ?? v.seconds, rate, "ltx");
  if (!images?.length) throw new Error("morphGraph needs at least one image");

  const g = {
    1: { class_type: "UNETLoader", inputs: { unet_name: v.dit, weight_dtype: "default" } },
    2: { class_type: "CLIPLoader", inputs: { clip_name: v.textEncoder, type: "ltxv", device: "default" } },
    3: { class_type: "VAELoader", inputs: { vae_name: v.videoVae } },
    4: { class_type: "VAELoader", inputs: { vae_name: v.audioVae } },
    6: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: prompt } },
    7: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: negative ?? v.negative } },
    8: { class_type: "LTXVConditioning", inputs: { positive: ["6", 0], negative: ["7", 0], frame_rate: rate } },
    9: { class_type: "EmptyLTXVLatentVideo", inputs: { width: w, height: h, length, batch_size: 1 } },
  };

  /* Frame 0 always gets a guide, whatever the beat grid says. Without one the
   * clip opens on whatever the model invents from noise and only finds the
   * reference a beat later, which reads as a mistake rather than a start. */
  const pts = [...new Set([0, ...positions.map((p) => Math.max(0, Math.min(length - 1, Math.round(p))))])]
    .sort((a, b) => a - b);

  let pos = ["8", 0], neg = ["8", 1], lat = ["9", 0];
  let n = 100;
  pts.forEach((idx, k) => {
    const img = images[k % images.length];
    const st = strengths?.[k] ?? guideStrength;
    g[n] = { class_type: "LoadImage", inputs: { image: img } };
    g[n + 1] = { class_type: "ImageScale", inputs: { image: [String(n), 0], upscale_method: "lanczos", width: w, height: h, crop: "disabled" } };
    g[n + 2] = { class_type: "LTXVPreprocess", inputs: { image: [String(n + 1), 0], img_compression: 18 } };
    g[n + 3] = {
      class_type: "LTXVAddGuide",
      inputs: { positive: pos, negative: neg, vae: ["3", 0], latent: lat,
                image: [String(n + 2), 0], frame_idx: idx,
                strength: Math.min(1, Math.max(0.05, st)) },
    };
    pos = [String(n + 3), 0]; neg = [String(n + 3), 1]; lat = [String(n + 3), 2];
    n += 10;
  });

  Object.assign(g, {
    10: { class_type: "LTXVEmptyLatentAudio", inputs: { frames_number: length, frame_rate: rate, batch_size: 1, audio_vae: ["4", 0] } },
    11: { class_type: "LTXVConcatAVLatent", inputs: { video_latent: lat, audio_latent: ["10", 0] } },
    12: { class_type: "RandomNoise", inputs: { noise_seed: seed ?? 0 } },
    13: { class_type: "KSamplerSelect", inputs: { sampler_name: v.sampler } },
    14: { class_type: "ManualSigmas", inputs: { sigmas: v.sigmasLow } },
    15: { class_type: "LTXVDualCFGGuider", inputs: { model: ["1", 0], positive: pos, negative: neg,
          video_cfg: v.videoCfg, audio_cfg: v.audioCfg } },
    16: { class_type: "SamplerCustomAdvanced", inputs: { noise: ["12", 0], guider: ["15", 0], sampler: ["13", 0], sigmas: ["14", 0], latent_image: ["11", 0] } },
    17: { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["16", 1] } },
    18: { class_type: "LTXVCropGuides", inputs: { positive: pos, negative: neg, latent: ["17", 0] } },
    19: { class_type: "VAEDecodeTiled", inputs: { samples: ["18", 2], vae: ["3", 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 16 } },
    20: { class_type: "CreateVideo", inputs: { images: ["19", 0], fps: rate } },
    21: { class_type: "SaveVideo", inputs: { video: ["20", 0], filename_prefix: prefix, format: "auto", codec: "auto" } },
  });
  return { graph: g, guides: pts.length, positions: pts, length, fps: rate };
}

export function videoGraph(opts = {}) {
  const engine = opts.engine || config.video.engine;
  return engine === "ltx" ? videoGraphLtx(opts) : videoGraphH3(opts);
}

export function videoGraphH3({ prompt, seed, seconds, width, height, steps,
                               firstFrame, lastFrame, loop, keepAudio, prefix = "clip" }) {
  const v = { ...config.video, ...config.video.engines.h3 };
  const w = width ?? v.width, h = height ?? v.height;
  const length = alignFrames(seconds ?? v.seconds, v.fps, "h3");
  /* `first_frame` / `last_frame` are OPTIONAL image inputs on the node, despite
   * the class being called ImageToVideo — with neither, it is text-to-video, and
   * that is how clips-under-songs have been rendered all along.
   *
   * Supplying the song's own cover is the interesting case: the clip then starts
   * from the picture the library already shows, so the two read as one artwork
   * rather than two unrelated images of the same song. Names are relative to
   * ComfyUI's input directory, which is what LoadImage wants. */
  const img = (name, id) => (name ? { [id]: { class_type: "LoadImage", inputs: { image: name } } } : {});
  // Same picture at both ends = a seamless loop. See videoGraphLtx for why.
  if (loop && firstFrame && !lastFrame) lastFrame = firstFrame;
  // Audio is dropped for clips that sit under an existing song, but a clip made
  // on its own has nothing underneath it — so there it is worth keeping.
  const withAudio = keepAudio ?? !v.dropAudio;
  return {
    ...img(firstFrame, 16),
    ...img(lastFrame, 17),
    1: { class_type: "UNETLoader", inputs: { unet_name: v.dit, weight_dtype: "default" } },
    /* 🔴 THE TURBO LoRA. Without it, 8 steps is nowhere near enough.
     *
     * config.video named this file from the start and NOTHING EVER LOADED IT —
     * the graph went straight from UNETLoader to the shift node. So every clip
     * so far ran the base model at 8 steps, which is why they came out vague and
     * only loosely related to the prompt: the whole step/sampler/shift tuning
     * assumes the distilled path, and the distillation was missing.
     *
     * ⚠ Consequence for the shift finding: the 4.0-vs-12.0 sweep recorded in
     * config.js was measured on this same un-LoRA'd graph, so it says nothing
     * about the distilled one. It needs re-running now that the model is
     * actually what it was meant to be. */
    18: {
      class_type: "LoraLoaderModelOnly",
      inputs: { model: ["1", 0], lora_name: v.turboLora, strength_model: v.loraStrength ?? 1.0 },
    },
    // `type: "minimax"` covers BOTH H3 and Music3 — comfy/sd.py auto-detects
    // which by looking for an audio-decoder projection in the checkpoint.
    2: { class_type: "CLIPLoader", inputs: { clip_name: v.textEncoder, type: "minimax", device: "default" } },
    3: { class_type: "VAELoader", inputs: { vae_name: v.videoVae } },
    4: { class_type: "VAELoader", inputs: { vae_name: v.audioVae } },

    5: {
      class_type: "MiniMaxH3ImageToVideo",
      inputs: {
        clip: ["2", 0], vae: ["3", 0], prompt, width: w, height: h, length,
        ...(firstFrame ? { first_frame: ["16", 0] } : {}),
        ...(lastFrame ? { last_frame: ["17", 0] } : {}),
      },
    },
    // The unswept knob. Applied to BOTH the guider and the scheduler, exactly as
    // the node's own docstring describes: the video shift drives the sampler's
    // sigma schedule and both values are handed to the DiT.
    6: {
      class_type: "MiniMaxH3SigmaShift",
      // ["18", 0] — the LoRA'd model, not the raw one from the loader.
      inputs: { model: ["18", 0], shift_video: v.shiftVideo, shift_audio: v.shiftAudio },
    },
    7: { class_type: "BasicGuider", inputs: { model: ["6", 0], conditioning: ["5", 0] } },
    8: { class_type: "BasicScheduler", inputs: { model: ["6", 0], scheduler: v.scheduler, steps: steps ?? v.steps, denoise: 1 } },
    9: { class_type: "KSamplerSelect", inputs: { sampler_name: v.sampler } },
    10: { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    11: {
      class_type: "SamplerCustomAdvanced",
      inputs: { noise: ["10", 0], guider: ["7", 0], sampler: ["9", 0], sigmas: ["8", 0], latent_image: ["5", 1] },
    },

    12: { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["3", 0] } },
    13: { class_type: "VAEDecodeAudio", inputs: { samples: ["11", 0], vae: ["4", 0] } },
    // H3 always renders audio and there is no video-only path. For a clip that
    // sits under a song we already made it is discarded — but it still has to be
    // DECODED, because the sampler produced it either way.
    14: {
      class_type: "CreateVideo",
      inputs: withAudio
        ? { images: ["12", 0], fps: v.fps, audio: ["13", 0] }
        : { images: ["12", 0], fps: v.fps },
    },
    15: { class_type: "SaveVideo", inputs: { video: ["14", 0], filename_prefix: prefix, format: "auto", codec: "auto" } },
  };
}


/**
 * A clip with LTX 2.5 — Lightricks.
 *
 * Resolved from the vendor's own template (video_ltx2_5_t2v.json, unwrapped from
 * definitions.subgraphs[0]) rather than reconstructed, then run end to end here
 * before being wired in: 1280x704, 121 frames, 121 s.
 *
 * THE SHAPE IS THE SPEED. Three stages, and only the last touches full size:
 *
 *   pass 1   8 steps at HALF resolution        <- almost all the sampling
 *   upscale  LTXVLatentUpsampler x2, in LATENT space (no decode/encode round trip)
 *   pass 2   3 steps at full size from sigma 0.85, i.e. a partial re-denoise
 *
 * So "LTX is faster than H3" is really "LTX spends 8 of its 11 steps on a quarter
 * of the pixels". Anything that flattens this into one pass throws the advantage
 * away.
 *
 * Four things not to tidy:
 *
 *  - **The video VAE is `-conv-`.** The template's widget says
 *    `ltx-2.5-video-vae-bf16.safetensors` and THAT FILE DOES NOT EXIST in the
 *    ComfyUI build of the repo. Copying the template verbatim fails validation.
 *  - **video_cfg must equal audio_cfg.** `nodes_lt.py` only takes the cheap
 *    single-CFG path when the two are close. Differ, and all 11 steps cost two
 *    forward passes.
 *  - **The sigmas are literal, not generated.** Step count is baked into the two
 *    strings, so there is no `steps` number to expose — which is why the cost
 *    model is per-engine.
 *  - **The template's prompt enhancer is ON by default** (TextGenerateLTX2Prompt,
 *    a Gemma-4 rewrite). It is deliberately omitted: it is a second inference
 *    pass for a prompt the user already wrote. Output therefore does NOT match
 *    the template run in the editor unless prompt_enhance is switched off there.
 */
export function videoGraphLtx({ prompt, negative, seed, seconds, width, height,
                                firstFrame, lastFrame, loop, keepAudio,
                                guidance, guideStrength, prefix = "clip" }) {
  const v = config.video.engines.ltx;
  const fps = v.fps;
  const frames = alignFrames(seconds ?? v.seconds, fps, "ltx");

  /* Pass 1 runs at half the final size, and the upsampler doubles it back.
   * Both axes are floored to a multiple of 32 first: the latent grid is 32px,
   * so an odd request silently lands somewhere else. Doing it here means the UI
   * can show the size the user will actually get. */
  const q = (n) => Math.max(32, Math.floor(n / 2 / 32) * 32);
  const lowW = q(width ?? v.width), lowH = q(height ?? v.height);

  /* IMAGES: two mechanisms, because the vendor uses two.
   *
   *   FIRST FRAME ONLY -> LTXVImgToVideoInplace writes the picture into the
   *     starting latent. It has NO frame index; it is frame 0 by construction.
   *     This keeps the fast two-pass schedule.
   *
   *   FIRST **AND** LAST -> LTXVAddGuide at frame_idx 0 and -1, strength 0.7,
   *     then LTXVCropGuides before the decode. Guides also rewrite the
   *     CONDITIONING — which is why that node returns positive and negative as
   *     well as a latent, and why both have to be threaded onward.
   *
   * ⚠ The vendor's first/last template is SINGLE PASS, with no upscaler at all.
   * So asking for a loop changes the graph's shape rather than adding a node,
   * and it gives up the two-pass speed advantage. An earlier version of this
   * guessed instead, and invented a `frame_idx` input on the in-place node that
   * does not exist.
   */
  const endFrame = loop ? (lastFrame || firstFrame) : lastFrame;
  const guided = !!endFrame;          // first+last => the guide path

  /* Load each distinct picture once. When both ends are the same file — which is
   * what a loop IS — node 30 is reused rather than decoding the same image twice. */
  const img = {
    ...(firstFrame ? { 30: { class_type: "LoadImage", inputs: { image: firstFrame } } } : {}),
    ...(endFrame && endFrame !== firstFrame
      ? { 31: { class_type: "LoadImage", inputs: { image: endFrame } } } : {}),
  };
  const endNode = endFrame ? (endFrame === firstFrame ? "30" : "31") : null;
  return {
    ...img,
    1: { class_type: "UNETLoader", inputs: { unet_name: v.dit, weight_dtype: "default" } },
    2: { class_type: "CLIPLoader", inputs: { clip_name: v.textEncoder, type: "ltxv", device: "default" } },
    3: { class_type: "VAELoader", inputs: { vae_name: v.videoVae } },
    4: { class_type: "VAELoader", inputs: { vae_name: v.audioVae } },
    5: { class_type: "LatentUpscaleModelLoader", inputs: { model_name: v.upscaler } },

    6: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: prompt } },
    7: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: negative ?? v.negative } },
    // Carries the frame rate into conditioning. Must agree with the audio latent
    // and CreateVideo below, or the clip and its sound disagree about time.
    8: { class_type: "LTXVConditioning", inputs: { positive: ["6", 0], negative: ["7", 0], frame_rate: fps } },

    // A guided run samples at FULL size (single pass); a two-pass run starts half
    // size and the upsampler doubles it.
    9: { class_type: "EmptyLTXVLatentVideo", inputs: {
      width: guided ? (width ?? v.width) : lowW,
      height: guided ? (height ?? v.height) : lowH,
      length: frames, batch_size: 1 } },

    // i2v: the opening picture, written straight into the latent.
    ...(firstFrame && !guided ? {
      32: { class_type: "LTXVImgToVideoInplace", inputs: {
        latent: ["9", 0], image: ["30", 0], vae: ["3", 0], strength: 1.0, bypass: false } },
    } : {}),

    /* Loop / first+last. img_compression 18 and strength 0.7 are the vendor's
     * own numbers: a guide at 1.0 pins the frame so hard the motion stutters
     * into it at each end. */
    ...(guided ? {
      34: { class_type: "LTXVPreprocess", inputs: { image: ["30", 0], img_compression: 18 } },
      35: { class_type: "LTXVAddGuide", inputs: {
        positive: ["8", 0], negative: ["8", 1], vae: ["3", 0], latent: ["9", 0],
        image: ["34", 0], frame_idx: 0, strength: guideStrength ?? 0.7 } },
      36: { class_type: "LTXVPreprocess", inputs: { image: [endNode, 0], img_compression: 18 } },
      37: { class_type: "LTXVAddGuide", inputs: {
        positive: ["35", 0], negative: ["35", 1], vae: ["3", 0], latent: ["35", 2],
        // -1 is the last frame. The same picture at both ends is the loop.
        image: ["36", 0], frame_idx: -1, strength: guideStrength ?? 0.7 } },
    } : {}),
    10: { class_type: "LTXVEmptyLatentAudio", inputs: { frames_number: frames, frame_rate: fps, batch_size: 1, audio_vae: ["4", 0] } },
    11: { class_type: "LTXVConcatAVLatent", inputs: {
      video_latent: guided ? ["37", 2] : [firstFrame ? "32" : "9", 0], audio_latent: ["10", 0] } },

    // ---- pass 1: 8 steps at half size ------------------------------------
    12: { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    13: { class_type: "KSamplerSelect", inputs: { sampler_name: v.sampler } },
    14: { class_type: "ManualSigmas", inputs: { sigmas: v.sigmasLow } },
    15: { class_type: "LTXVDualCFGGuider", inputs: { model: ["1", 0],
      // Guided runs must use the conditioning the guides rewrote, not the raw pair.
      positive: guided ? ["37", 0] : ["8", 0],
      negative: guided ? ["37", 1] : ["8", 1],
      /* ONE number drives both, deliberately. nodes_lt.py only takes the cheap
       * single-CFG path when the two are close; let a user set them apart and
       * every step silently costs two forward passes instead of one. Exposing
       * them separately would be exposing a performance trap. */
      video_cfg: guidance ?? v.videoCfg, audio_cfg: guidance ?? v.audioCfg } },
    16: { class_type: "SamplerCustomAdvanced", inputs: { noise: ["12", 0], guider: ["15", 0], sampler: ["13", 0], sigmas: ["14", 0], latent_image: ["11", 0] } },

    // ---- upscale in latent space -----------------------------------------
    /* A guided run STOPS after one pass — the vendor's first/last template has no
     * upscaler at all. LTXVCropGuides strips the pinned frames out of the latent
     * before decoding; leave them and each end visibly stutters. */
    /* Order matters and I had it backwards. Per the vendor's flf2v template:
     *   sampler[1] (the DENOISED output, not [0]) -> LTXVSeparateAVLatent
     *   separate[0] (the VIDEO latent)            -> LTXVCropGuides.latent
     *   crop[2]                                   -> VAEDecodeTiled
     * Feeding CropGuides the concatenated A/V latent throws
     * "NestedTensor object has no attribute clone" — it only understands a plain
     * video latent, which exists only after the split. */
    17: { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: guided ? ["16", 1] : ["16", 0] } },
    ...(guided ? {
      38: { class_type: "LTXVCropGuides", inputs: { positive: ["37", 0], negative: ["37", 1], latent: ["17", 0] } },
    } : {}),
    ...(guided ? {} : {
      18: { class_type: "LTXVLatentUpsampler", inputs: { samples: ["17", 0], upscale_model: ["5", 0], vae: ["3", 0] } },
      19: { class_type: "LTXVConcatAVLatent", inputs: { video_latent: ["18", 0], audio_latent: ["17", 1] } },
    }),

    // ---- pass 2: 3 steps at full size, starting from 0.85 -----------------
    ...(guided ? {} : {
      20: { class_type: "RandomNoise", inputs: { noise_seed: (seed ?? 0) + 1 } },
      21: { class_type: "KSamplerSelect", inputs: { sampler_name: v.sampler } },
      22: { class_type: "ManualSigmas", inputs: { sigmas: v.sigmasHigh } },
      23: { class_type: "LTXVDualCFGGuider", inputs: { model: ["1", 0], positive: ["8", 0], negative: ["8", 1], video_cfg: guidance ?? v.videoCfg, audio_cfg: guidance ?? v.audioCfg } },
      24: { class_type: "SamplerCustomAdvanced", inputs: { noise: ["20", 0], guider: ["23", 0], sampler: ["21", 0], sigmas: ["22", 0], latent_image: ["19", 0] } },
      25: { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["24", 0] } },
    }),

    // ---- decode ----------------------------------------------------------
    // (node 25 lives in the pass-2 block above — a guided run has no pass 2, and
    //  a duplicate here would resurrect it and dangle a link to node 24.)
    26: { class_type: "VAEDecodeTiled", inputs: { samples: guided ? ["38", 2] : ["25", 0], vae: ["3", 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 16 } },
    27: { class_type: "LTXVAudioVAEDecode", inputs: { samples: [guided ? "17" : "25", 1], audio_vae: ["4", 0] } },
    // LTX renders real audio. A clip under an existing song discards it; a
    // standalone one keeps it, because otherwise it has no sound at all.
    28: {
      class_type: "CreateVideo",
      inputs: (keepAudio ?? !v.dropAudio)
        ? { images: ["26", 0], audio: ["27", 0], fps }
        : { images: ["26", 0], fps },
    },
    29: { class_type: "SaveVideo", inputs: { video: ["28", 0], filename_prefix: prefix, format: "auto", codec: "auto" } },
  };
}

/**
 * Turn a song's style caption into a clip prompt.
 *
 * Reuses the cover-art subject cleaning — the same notation, heading and
 * auto-title traps apply, and for the same reason: "E4 E4 G4 A4" is not a thing
 * to film any more than it was a thing to photograph.
 */
/**
 * Improve a clip that already exists: more frames, more pixels, or both.
 *
 * Both stages are core ComfyUI (`comfy_extras`), which is the reason these two
 * models were chosen over better-scoring alternatives — SeedVR2 and FlashVSR
 * upscale video far better precisely because they see the whole clip instead of
 * one frame, but they need custom node packs, and "stock ComfyUI plus one npm
 * dependency" is a promise worth more than the quality difference.
 *
 * @param {object}  o
 * @param {string}  o.file          name inside ComfyUI's input dir (LoadVideo only reads there)
 * @param {object=} o.interpolate   `{ model, multiplier, slow }` — omit to skip
 * @param {object=} o.upscale       `{ model }` — omit to skip
 * @param {boolean} o.keepAudio     carried through when the timing is unchanged
 * @param {string}  o.prefix        SaveVideo filename prefix
 */
export function enhanceGraph({ file, interpolate, upscale, keepAudio = true, prefix }) {
  if (!interpolate && !upscale) throw new Error("nothing to do");

  const g = {
    1: { class_type: "LoadVideo", inputs: { file } },
    2: { class_type: "GetVideoComponents", inputs: { video: ["1", 0] } },
  };

  // Threaded through the optional stages. Starts as the decoded frames and the
  // source frame rate, and each stage that runs replaces one of them.
  let images = ["2", 0];
  let fps = ["2", 2];
  // Slow motion stretches the picture and not the sound, so there is nothing
  // sensible to keep. Said once, here, rather than checked in three places.
  let audio = keepAudio && !(interpolate && interpolate.slow) ? ["2", 1] : null;

  if (interpolate) {
    const mult = Math.min(Math.max(Math.round(interpolate.multiplier || 2), 2), 16);
    g[3] = { class_type: "FrameInterpolationModelLoader", inputs: { model_name: interpolate.model } };
    g[4] = { class_type: "FrameInterpolate", inputs: { interp_model: ["3", 0], images, multiplier: mult } };
    images = ["4", 0];

    if (!interpolate.slow) {
      /* Same duration, higher frame rate. The multiply is done in-graph so the
       * SOURCE rate is the one being multiplied — probing the file here, or
       * assuming it matches whatever engine setting is current, both go wrong
       * on an imported clip. Clamped because CreateVideo's ceiling is 120 and
       * discovering that after a ten-minute upscale is a waste of ten minutes. */
      g[5] = {
        class_type: "ComfyMathExpression",
        inputs: { expression: "min(a * b, 120.0)", "values.a": fps, "values.b": mult },
      };
      fps = ["5", 0];
    }
  }

  if (upscale) {
    g[6] = { class_type: "UpscaleModelLoader", inputs: { model_name: upscale.model } };
    g[7] = { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["6", 0], image: images } };
    images = ["7", 0];
  }

  g[8] = { class_type: "CreateVideo", inputs: audio ? { images, fps, audio } : { images, fps } };
  g[9] = { class_type: "SaveVideo", inputs: { video: ["8", 0], filename_prefix: prefix, format: "auto", codec: "auto" } };
  return g;
}


/**
 * What enhancing this clip will cost, before committing to it.
 *
 * Upscaling is the one operation here that can fail for a reason the user could
 * have been warned about: every frame is held at full size, so a 5-second
 * 1280x704 clip at 4x is 120 frames of 5120x2816 — about 20 GB of system RAM,
 * and no amount of VRAM tiling helps because the batch itself is the problem.
 * Cheap to compute, so it is computed and shown rather than discovered.
 */
export function enhanceCost({ width, height, seconds, fps = 24, multiplier = 1, scale = 1 }) {
  const frames = Math.max(1, Math.round(seconds * fps)) * Math.max(1, multiplier);
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  return {
    frames, width: w, height: h,
    // float32 RGB, which is how ComfyUI holds an IMAGE batch.
    peakBytes: frames * w * h * 3 * 4,
  };
}


export function videoPrompt({ caption = "", title = "", seed = 0 }) {
  const subject = coverPrompt({ caption, title, seed }).split("evoking ")[1] || "quiet instrumental music";
  return `${config.video.style || "cinematic macro shot, single subject, shallow depth of field, "
    + "strong directional light, restrained colour, subtle grain, slow steady camera move, seamless loop"}, `
    + `evoking ${subject}`;
}

/**
 * A title for a song that was given none.
 *
 * The model has no title input, so this is pure text work on what the user
 * already wrote — which is the point: a derived title should feel like THEIR
 * words, not a label the app invented.
 *
 * "Untitled" is the thing to beat, and the bar is low but the failure modes are
 * specific:
 *
 *  - A section tag is not a title. "[Chorus]" is the single most common first
 *    line in this app and the naive first-line fallback picks it constantly.
 *  - The FIRST line is rarely the best one. A repeated line is a chorus, and a
 *    chorus is what a song is actually called — so repetition is the strongest
 *    signal available without a language model.
 *  - Instrumentals have no words at all, and their caption is a production
 *    brief full of BPM markings and microphone choices. Those must not become
 *    titles.
 *
 * Deterministic given the same inputs: no randomness, so re-rendering the same
 * song twice does not silently rename it.
 */
export function deriveTitle({ lyrics = "", caption = "", fallback = "Untitled" } = {}) {
  const clean = (s) => s
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/^[\s"'(\[-]+|[\s"')\].,;:!?-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const lines = String(lyrics).split(/\r?\n/)
    /* Filter on the RAW line, BEFORE cleaning.
     *
     * clean() strips leading brackets, so filtering afterwards let
     * "(rain on the window)" through as a perfectly good-looking title — and it
     * is a stage direction, not something anyone sings. Section tags and
     * parentheticals have to be rejected while they still look like scaffolding.
     * Pure ad-libs are dropped by the next filter. */
    .filter((l) => !/^\s*[\[(]/.test(l))
    .map(clean)
    .filter(Boolean)
    .filter((l) => !/^(mmm+|ooh+|ah+|oh+|la+|na+|yeah+|hey+)[\s.…!,]*$/i.test(l));

  if (lines.length) {
    // Repetition is the chorus, and the chorus is the title. Compared
    // case-insensitively so "Keep the engine running" and "keep the engine
    // running" count as the same line.
    const seen = new Map();
    for (const l of lines) {
      const k = l.toLowerCase();
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    const words = (l) => l.split(" ").filter(Boolean).length;
    const usable = lines.filter((l) => words(l) >= 2 && words(l) <= 7);
    const pool = usable.length ? usable : lines;

    const score = (l) => {
      const n = words(l);
      let s = (seen.get(l.toLowerCase()) || 1) * 10;      // repeated lines win
      s += n >= 3 && n <= 5 ? 3 : 0;                       // title-shaped length
      s -= /[,;:]/.test(l) ? 2 : 0;                        // mid-sentence fragments
      s -= /^(and|but|so|then|when|if|that|which|because)\b/i.test(l) ? 4 : 0;
      return s;
    };
    // Stable: ties break on the earliest line, so the result never wobbles.
    const best = pool.reduce((a, b) => (score(b) > score(a) ? b : a), pool[0]);
    return titleCase(trimTo(best, 48));
  }

  /* No words. Build from the caption — but a caption is a production brief, so
   * strip the parts that describe RECORDING rather than mood. Without this you
   * get titles like "174 Bpm Close-mic Vocal". */
  const junk = /\b(\d+\s*bpm|bpm|hz|khz|db|stereo|mono|mix|master(ed|ing)?|production|recorded|close-mic|room mic|reverb|compression|eq|sidechain|lo-?fi|hi-?fi|vocal|instrumental|track|song|music)\b/gi;
  const words = String(caption)
    .replace(junk, " ")
    .replace(/[^\p{L}\s'-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .filter((w) => !STOP.has(w.toLowerCase()));

  if (words.length >= 2) {
    // Two adjacent surviving words read as a phrase; two distant ones read as a
    // tag list. Prefer the first adjacent pair.
    return titleCase(`${words[0]} ${words[1]}`);
  }
  if (words.length === 1) return titleCase(words[0]);
  return fallback;
}

const STOP = new Set(["the", "and", "with", "for", "from", "into", "over", "very", "some",
  "that", "this", "then", "than", "but", "not", "all", "its", "his", "her", "their",
  "sounds", "sounding", "style", "feel", "feeling", "like", "slow", "fast"]);

function trimTo(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:-]+$/, "");
}

/** Title case that leaves small words alone unless they lead. */
function titleCase(s) {
  const small = new Set(["a", "an", "the", "and", "or", "of", "in", "on", "at", "to", "for", "is"]);
  return s.split(" ").filter(Boolean).map((w, i) =>
    (i > 0 && small.has(w.toLowerCase()))
      ? w.toLowerCase()
      : w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * Turn a song's own style caption into a cover prompt.
 *
 * The style half is fixed (config.art.style) so that a library of fifty covers
 * reads as ONE set rather than fifty unrelated pictures. Only the subject varies.
 * The caption is truncated because it is a music description, not an image brief
 * — past a couple of clauses it starts contributing instrument names that the
 * image model renders literally, and every cover grows a guitar.
 */
export function coverPrompt({ caption = "", title = "", seed = 0 }) {
  /* Drop MUSICAL NOTATION before anything else.
   *
   * Found by looking at the output: captions like "Piano Melody: E4 E4 G4 A4 G4
   * E4, quarter quarter half, rising then falling" produced covers with those
   * exact symbols CARVED INTO the object. The "no text" clause cannot win that
   * argument — the caption was handing the model a string and asking it to evoke
   * it, and a literal engraving is a reasonable reading.
   *
   * Note names and rhythm words describe how a piece is played. They carry no
   * visual meaning whatsoever, so they are removed rather than reworded. */
  const NOTE = /^[A-G][#b♯♭]?\d?$/;
  const RHYTHM = /^(quarter|eighth|sixteenth|half|whole|dotted|triplet|rest|notes?|bars?|beats?)$/i;
  const isNotation = (clause) => {
    const words = clause.split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const junk = words.filter((w) => NOTE.test(w) || RHYTHM.test(w)).length;
    return junk / words.length >= 0.4;     // mostly notation -> not a subject
  };

  /* MiniMax's own Structured Caption format opens with section headings
   * ("Global Metadata", "Vocal Details", "Arrangement", "Production"). Those are
   * document structure, not description — left in, the model illustrates the
   * word "metadata". */
  const HEADING = /^(global\s+metadata|vocal\s+details?|arrangement|production|instrumentation|mix)$/i;

  const subject = String(caption)
    .replace(/\b\d+\s*BPM\b/gi, "")             // "96 BPM"
    .replace(/\bBPM\s+is\s+\d+/gi, "")          // "BPM is 96" — the structured form
    .replace(/\b(piano\s+)?melody\s*:/gi, "")   // the label that introduces notation
    .replace(/\bkey is [A-G][#b]?\b/gi, "")
    .replace(/\bscale is \w+/gi, "")
    .split(/[,.\n;:]/)
    .map((s) => s.trim())
    .filter((s) => s && !HEADING.test(s) && !isNotation(s))
    .slice(0, 4)
    .join(", ");

  /* Falling back to the title is only safe when the title is a real one.
   *
   * ⚠ A track with no stored title gets one DERIVED FROM ITS FILENAME by
   * library.list(): `aiplay_00001.flac` → strip the extension → strip `_00001` →
   * "aiplay". That is a non-empty string, so it sailed past an "is there a title"
   * check and became the image subject — and the model rendered the word
   * "aiplay" as a nondescript rock on all eleven captionless tracks. The rotating
   * pool below never got a chance to fire.
   *
   * So reject the generated ones explicitly: the output-file prefixes, with or
   * without their sequence number. */
  const AUTO_TITLE = /^(aiplay|preview|edit|extend|merge|cover|untitled)(_?\d+)?$/i;
  const tt = String(title || "").trim();
  const usableTitle = tt && !isNotation(tt) && !AUTO_TITLE.test(tt) ? tt : "";

  /* A ROTATING fallback, not a fixed phrase.
   *
   * A single neutral fallback ("quiet instrumental music") made every captionless
   * track resolve to the same idea, and eleven of them came back as eleven nearly
   * identical stones — distinct seeds, one subject. The set read as a bug.
   *
   * These are chosen to sit inside the house style already: single objects,
   * photographable, no lettering, no instrument clichés (an image model handed
   * "guitar" draws a guitar every time). Indexing by seed keeps a track's cover
   * stable across regenerations while spreading the library across the pool. */
  const FALLBACK = [
    "a cracked ceramic bowl", "a coil of brass wire", "a folded paper crane",
    "a weathered brass doorknob", "a single dried flower", "a glass of water on concrete",
    "a length of frayed rope", "a smooth river stone", "an old iron key",
    "a broken mirror shard", "a bare lightbulb", "a rusted hinge",
    "a seashell on dark cloth", "a stack of worn books", "a metal spring",
    "a candle burned to the base",
  ];
  const pick = FALLBACK[Math.abs(Number(seed) || 0) % FALLBACK.length];
  const mood = subject || usableTitle || pick;
  return `${config.art.style}, evoking ${mood}`;
}

/** Node id -> the stage name the user sees. Used to turn ComfyUI's per-node
 *  `executing` events into honest staged progress instead of a spinner. */
export const STAGE_OF_NODE = {
  1: "loading", 2: "loading", 3: "loading",
  4: "composing",   // the autoregressive pass — the bulk of the wait
  5: "composing", 6: "composing",
  10: "arranging", 11: "arranging",
  7: "arranging",  // the diffusion steps
  8: "mixing",
  9: "saving",
};

export const STAGE_LABEL = {
  loading: "Loading the model",
  composing: "Composing",
  arranging: "Arranging",
  mixing: "Mixing down",
  saving: "Saving",
};

/** Rough share of wall-clock per stage, measured. Used for a sane overall
 *  percentage while a stage that reports 0-1 progress is running. */
export const STAGE_WEIGHT = { loading: 0.01, composing: 0.40, arranging: 0.40, mixing: 0.17, saving: 0.02 };
