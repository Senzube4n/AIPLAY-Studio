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
import { config, loraStepsOf } from "./config.js";
/* Data only — the catalogue's `gated` flag and the engine->capability map.
 * models.js imports config.js and nothing else from this tree, so there is
 * no cycle here. */
import { CATALOG, MODEL_TO_CAPABILITY, cardIsAmd } from "./models.js";

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
  // Decode the song in overlapping chunks (VAEDecodeAudioTiled). The caller
  // passes false only when the engine does not have that node.
  tiledVae = true,
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
    /* ⚠ TILED, BECAUSE THE WHOLE-SONG DECODE IS WHAT CRASHED MACHINES.
     * ComfyUI sizes the DAV decode as (frames x 512 x 1400 + 800M) fp32
     * elements (sd.py, MiniMax Music3 DAV): at ~86 latent frames a second a
     * four-minute song asks for tens of GB in one go, and with offload disabled
     * for this VAE that is where 16 and 24 GB cards (a Quadro RTX 6000 among
     * them) spilled into system memory or fell over. The tiled node decodes
     * 512 frames (~6 s) at a time with 64 frames (~0.7 s) of overlap that
     * ComfyUI feathers together, so the peak is one tile's worth whatever the
     * length. ComfyUI's own defaults; not measured here against the plain
     * decode for exactness. */
    8: tiledVae
      ? { class_type: "VAEDecodeAudioTiled", inputs: { samples: ["7", 0], vae: ["3", 0], tile_size: MUSIC_VAE_TILE, overlap: MUSIC_VAE_OVERLAP } }
      : { class_type: "VAEDecodeAudio", inputs: { samples: ["7", 0], vae: ["3", 0] } },
    9: saveAudioNode(prefix),
  };
}

/** VAEDecodeAudioTiled for MiniMax Music 3, in latent frames (512 audio samples each). */
export const MUSIC_VAE_TILE = 512;
export const MUSIC_VAE_OVERLAP = 64;

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

/**
 * YuE2 3B through ComfyUI's own nodes (comfy_extras/nodes_yue2.py).
 *
 * The graph of ComfyUI's "Text to Music (YuE2)" template, flattened: one
 * checkpoint carries the model, the text side and the audio VAE; an optional
 * ABC plan (`cot` "full" or "melody"; "off" skips it) feeds the music tokens;
 * YuE2GenerateMusic reports the length it actually produced, which sizes the
 * latent. Sampler values are the template's (32 steps, cfg 1, dpm_2,
 * sgm_uniform). Node ids line up with STAGE_OF_NODE and saveAudioNode():
 * "8" decodes, "9" saves.
 *
 * A re-roll with a new `mixSeed` changes only the sampler seed, so ComfyUI
 * reuses the cached plan and tokens.
 */
/* The published instrumental planner LoRA (Mothersuperior, CC BY-NC 4.0,
 * catalogued as musicYue2InstrumentalLora): with it on a loras shelf, an
 * instrumental on yue2-comfy patches the planner with it and hands the model
 * the "[instrumental]" sheet its card asks for. Named once, here, so the route
 * that picks it and the catalogue row that fetches it cannot spell it apart. */
export const INSTRUMENTAL_PLANNER_LORA = "ar_lora_inst_v3abc_comfyui.safetensors";

export function buildYue2ComfyGraph({
  caption, lyrics = "", seed = 0, mixSeed, cot = "full", maxDuration = 240, steps, checkpoint,
  lora = null, loraStrength = 1,
  loraClip = null, loraClipStrength = 1,
  /* CONTINUE A RECORDING HERE TOO. A folder holding semantic.npy (what the
   * real-audio tokenizer writes) and how many seconds of it the model hears
   * first. With one, node 5 becomes our own AiplayYuE2Continue, which replays
   * those codes as the sampler's prefix — ComfyUI's stock node has no prefix
   * input, and its token generation is sealed inside the text encoder. */
  codes = null, primeSeconds = 8,
  /* A SUPPLIED SCORE (a hummed melody, a pasted or transcribed one): node 5
   * sings it as written and the planner (node 4) is left out, since it has no
   * score input of its own. Both music nodes take the text as a plain string.
   * The sampler dials override the nodes' defaults: `sampling` node 5's
   * (temperature, top_p, top_k, repetition_penalty), `planSampling` node 4's
   * (temperature, top_p). server/music/yue2-comfy-input.js validates all three. */
  abc = null, sampling = null, planSampling = null,
  prefix = "aiplay",
}) {
  const plan = cot !== "off";
  const score = typeof abc === "string" && abc.trim() !== "" ? abc : null;
  /* The door refuses this with its own sentence; a caller that skipped the
   * door fails here rather than rendering without the score. */
  if (score && !plan) throw new Error("A supplied score needs the chain of thought on (full or melody); nothing was rendered.");
  const pick = (o, k, d) => (o && typeof o[k] === "number" && Number.isFinite(o[k]) ? o[k] : d);
  /* TWO LoRA DOORS, one per half of the model. The audio LoRA rides between
   * the checkpoint and the sampler on the MODEL wire only —
   * LoraLoaderModelOnly, the node H3's turbo LoRAs load through — which
   * patches the NAR, the half ComfyUI exposes as MODEL. The planner's LoRA
   * (`loraClip`) rides on the CLIP wire through LoraLoader with its model
   * strength at 0: ComfyUI holds YuE2's autoregressive composer as CLIP, and
   * a planner LoRA in ComfyUI's format (Mothersuperior's instrumental
   * planner, say: fused qkv / gate_up keys on the language model) matches
   * nothing on the MODEL side and everything on that one. Nodes 2 and 3 are
   * "loading" ids in STAGE_OF_NODE, so progress needs no new stage. With no
   * planner LoRA the text side (clip → nodes 4 and 5) stays the checkpoint's. */
  const useLora = typeof lora === "string" && lora.trim() !== "";
  const strength = Number.isFinite(Number(loraStrength)) ? Number(loraStrength) : 1;
  const useClipLora = typeof loraClip === "string" && loraClip.trim() !== "";
  const useCodes = typeof codes === "string" && codes.trim() !== "";
  const clipStrength = Number.isFinite(Number(loraClipStrength)) ? Number(loraClipStrength) : 1;
  const clipWire = useClipLora ? ["3", 1] : ["1", 1];
  const mode = cot === "melody" ? "melody" : "full";
  const s = Number(seed) || 0;
  const performance = {
    temperature: pick(sampling, "temperature", 1.0), top_p: pick(sampling, "top_p", 0.95),
    top_k: pick(sampling, "top_k", 100), repetition_penalty: pick(sampling, "repetition_penalty", 1.2),
  };
  return {
    1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint } },
    ...(useLora ? {
      2: { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: lora, strength_model: strength } },
    } : {}),
    ...(useClipLora ? {
      3: { class_type: "LoraLoader", inputs: { model: ["1", 0], clip: ["1", 1], lora_name: loraClip, strength_model: 0, strength_clip: clipStrength } },
    } : {}),
    ...(plan && !score ? {
      4: {
        class_type: "YuE2GenerateABC",
        inputs: {
          clip: clipWire, style: caption, lyrics, seed: s, mode,
          max_abc_tokens: 8192, temperature: pick(planSampling, "temperature", 0.7), top_p: pick(planSampling, "top_p", 0.9), top_k: 30,
          repetition_penalty: 1.005, penalty_window: 100,
        },
      },
    } : {}),
    5: useCodes ? {
      /* Same id, so STAGE_OF_NODE and the save node need no change: this is
       * the composing step either way. `new_duration` is how much NEW music is
       * asked for — the replay is extra, and the node's own context check
       * refuses a replay that leaves no room. */
      class_type: "AiplayYuE2Continue",
      inputs: {
        clip: clipWire, style: caption, lyrics, abc: score ?? (plan ? ["4", 0] : ""), seed: s, mode: plan ? mode : "off",
        codes_dir: String(codes), prime_seconds: Number(primeSeconds) || 0,
        new_duration: Number(maxDuration) || 240,
        ...performance,
      },
    } : {
      class_type: "YuE2GenerateMusic",
      inputs: {
        clip: clipWire, style: caption, lyrics, abc: score ?? (plan ? ["4", 0] : ""), seed: s, mode,
        max_duration: Number(maxDuration) || 240,
        ...performance,
      },
    },
    6: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["5", 0] } },
    10: { class_type: "EmptyYuE2LatentAudio", inputs: { seconds: ["5", 1], batch_size: 1 } },
    7: {
      class_type: "KSampler",
      inputs: {
        model: useLora ? ["2", 0] : ["1", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["10", 0],
        seed: Number.isFinite(mixSeed) ? mixSeed : s, steps: Number(steps) || 32, cfg: 1,
        sampler_name: "dpm_2", scheduler: "sgm_uniform", denoise: 1,
      },
    },
    8: { class_type: "VAEDecodeAudio", inputs: { samples: ["7", 0], vae: ["1", 2] } },
    9: saveAudioNode(prefix),
  };
}

/* ── ACE-Step 1.5 ─────────────────────────────────────────────────────────
 *
 * The graph of ComfyUI's "ACE-Step 1.5 (split 4B)" template, flattened: the
 * DiT through ModelSamplingAuraFlow (shift 3), a DualCLIPLoader holding the
 * 0.6B embedder and the planner LM (type "ace"), the ACE 1.5 VAE, and
 * TextEncodeAceStepAudio1.5 carrying style, lyrics, tempo, key, time signature,
 * language and the planner's sampling. Sampler: euler / simple, and the steps
 * and cfg of the template that matches the DiT (turbo 8 at cfg 1; XL base 50
 * at 6; XL sft 50 at 7). Node ids line up with STAGE_OF_NODE and
 * saveAudioNode(): "4" is the planner (composing), "7" the steps, "8" decodes,
 * "9" saves.
 *
 * COVER. With a source song, LoadAudio -> VAEEncodeAudio (the ACE VAE) ->
 * ReferenceTimbreAudio ("Set Reference Audio", marked experimental in
 * ComfyUI) puts its latents on the conditioning. ComfyUI's ACE 1.5 model then
 * treats the render as a cover (model_base.py sets is_covers) and does not use
 * planner codes, so the planner is switched off, as the node's own tooltip
 * says to do when an audio reference is given.
 *
 * A LoRA rides on the MODEL wire (LoraLoaderModelOnly), which is where
 * ComfyUI maps ACE-Step 1.5 LoRA keys (comfy/lora.py). */
export const ACE_DEFAULTS = {
  turbo: { steps: 8, cfg: 1 },
  base: { steps: 50, cfg: 6 },
  sft: { steps: 50, cfg: 7 },
};
export function aceKindOf(dit) {
  const n = String(dit || "").toLowerCase();
  return n.includes("turbo") ? "turbo" : n.includes("sft") ? "sft" : n.includes("base") ? "base" : "turbo";
}
export const ACE_KEYS = ["C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B"]
  .flatMap((r) => [`${r} major`, `${r} minor`]);
export const ACE_METERS = ["2", "3", "4", "6"];
export const ACE_LANGUAGES = ["ar", "az", "bg", "bn", "ca", "cs", "da", "de", "el", "en", "es", "fa", "fi", "fr", "he", "hi",
  "hr", "ht", "hu", "id", "is", "it", "ja", "ko", "la", "lt", "ms", "ne", "nl", "no", "pa", "pl", "pt", "ro", "ru", "sa",
  "sk", "sr", "sv", "sw", "ta", "te", "th", "tl", "tr", "uk", "ur", "vi", "yue", "zh", "unknown"];

/**
 * Tempo, key and time signature for the encoder, which needs all three.
 * Asked-for values win; otherwise they are read out of the style line when it
 * states them ("92 BPM", "F# minor", "3/4" — what the style chips and the
 * Genre Roulette write); otherwise 120 BPM, 4 beats, and a key picked from the
 * seed (so a re-roll keeps it). `from` says which, for the song's record.
 */
export function aceMeta({ caption = "", bpm, keyscale, timesignature, seed = 0 } = {}) {
  const text = String(caption);
  const from = {};
  let b = Number(bpm);
  if (!(Number.isInteger(b) && b >= 10 && b <= 300)) {
    const m = text.match(/\b(\d{2,3})\s*bpm\b/i);
    b = m && +m[1] >= 10 && +m[1] <= 300 ? +m[1] : 120;
    from.bpm = m ? "style" : "default";
  } else from.bpm = "asked";
  let key = ACE_KEYS.includes(keyscale) ? keyscale : null;
  if (key) from.key = "asked";
  else {
    const m = text.match(/\b([A-G])\s*(#|♯|b|♭)?\s*(major|minor|maj|min)\b/i);
    if (m) {
      const acc = m[2] === "♯" ? "#" : m[2] === "♭" ? "b" : (m[2] || "");
      const cand = `${m[1].toUpperCase()}${acc} ${/^min/i.test(m[3]) ? "minor" : "major"}`;
      if (ACE_KEYS.includes(cand)) { key = cand; from.key = "style"; }
    }
    if (!key) {
      const quality = /\bminor\b/i.test(text) ? "minor" : /\bmajor\b/i.test(text) ? "major" : null;
      const pool = ACE_KEYS.filter((k) => !quality || k.endsWith(quality));
      key = pool[Math.abs(Number(seed) || 0) % pool.length];
      from.key = quality ? "style quality, root from the seed" : "seed";
    }
  }
  let meter = ACE_METERS.includes(String(timesignature)) ? String(timesignature) : null;
  if (meter) from.meter = "asked";
  else {
    const m = text.match(/\b([2346])\s*\/\s*(4|8)\b/);
    meter = m ? m[1] : "4";
    from.meter = m ? "style" : "default";
  }
  return { bpm: b, keyscale: key, timesignature: meter, from };
}

export function buildAceStep15Graph({
  caption, lyrics = "", seed = 0, mixSeed, duration = 120, bpm = 120, keyscale = "C major", timesignature = "4",
  language = "en", steps, cfg, dit, lm, lora = null, loraStrength = 1, codes = true, planTemperature,
  cover = null, prefix = "aiplay",
}) {
  const kind = aceKindOf(dit);
  const useLora = typeof lora === "string" && lora.trim() !== "";
  const useCover = typeof cover === "string" && cover.trim() !== "";
  const s = Number(seed) || 0;
  const secs = Math.min(Math.max(Number(duration) || 120, 1), 600);
  const temp = Number(planTemperature);
  return {
    1: { class_type: "UNETLoader", inputs: { unet_name: dit, weight_dtype: "default" } },
    ...(useLora ? {
      2: { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: lora, strength_model: Number.isFinite(Number(loraStrength)) ? Number(loraStrength) : 1 } },
    } : {}),
    11: { class_type: "ModelSamplingAuraFlow", inputs: { model: useLora ? ["2", 0] : ["1", 0], shift: 3 } },
    3: { class_type: "DualCLIPLoader", inputs: { clip_name1: "qwen_0.6b_ace15.safetensors", clip_name2: lm, type: "ace", device: "default" } },
    12: { class_type: "VAELoader", inputs: { vae_name: "ace_1.5_vae.safetensors" } },
    4: {
      class_type: "TextEncodeAceStepAudio1.5",
      inputs: {
        clip: ["3", 0], tags: caption, lyrics, seed: s, bpm: Number(bpm) || 120, duration: secs,
        timesignature: ACE_METERS.includes(String(timesignature)) ? String(timesignature) : "4",
        language: ACE_LANGUAGES.includes(language) ? language : "en",
        keyscale: ACE_KEYS.includes(keyscale) ? keyscale : "C major",
        generate_audio_codes: useCover ? false : codes !== false,
        cfg_scale: 2, temperature: Number.isFinite(temp) && temp >= 0 && temp <= 2 ? temp : 0.85,
        top_p: 0.9, top_k: 0, min_p: 0,
      },
    },
    ...(useCover ? {
      13: { class_type: "LoadAudio", inputs: { audio: cover } },
      14: { class_type: "VAEEncodeAudio", inputs: { audio: ["13", 0], vae: ["12", 0] } },
      5: { class_type: "ReferenceTimbreAudio", inputs: { conditioning: ["4", 0], latent: ["14", 0] } },
    } : {}),
    6: { class_type: "ConditioningZeroOut", inputs: { conditioning: useCover ? ["5", 0] : ["4", 0] } },
    10: { class_type: "EmptyAceStep1.5LatentAudio", inputs: { seconds: secs, batch_size: 1 } },
    7: {
      class_type: "KSampler",
      inputs: {
        model: ["11", 0], positive: useCover ? ["5", 0] : ["4", 0], negative: ["6", 0], latent_image: ["10", 0],
        seed: Number.isFinite(mixSeed) ? mixSeed : s,
        steps: Number(steps) > 0 ? Math.min(Math.round(Number(steps)), 100) : ACE_DEFAULTS[kind].steps,
        cfg: Number.isFinite(Number(cfg)) && Number(cfg) > 0 ? Math.min(Number(cfg), 20) : ACE_DEFAULTS[kind].cfg,
        sampler_name: "euler", scheduler: "simple", denoise: 1,
      },
    },
    8: { class_type: "VAEDecodeAudio", inputs: { samples: ["7", 0], vae: ["12", 0] } },
    9: saveAudioNode(prefix),
  };
}

/** File extension the current format produces. Several places need to find "the
 *  newest output" and would otherwise keep looking for .flac forever. */
export const OUTPUT_EXT = () => ({ mp3: ".mp3", opus: ".opus" }[config.output.format] || ".flac");

/* ── GGUF weights ──────────────────────────────────────────────────────────
 *
 * A quantised .gguf transformer or text encoder is not readable by ComfyUI's
 * own UNETLoader and CLIPLoader — those are safetensors loaders, and handing
 * one a .gguf fails inside the node. The ComfyUI-GGUF pack exists for exactly
 * this and ships two drop-in replacements taking the same inputs.
 *
 * The shelves have listed .gguf encoders since the picker was written, so the
 * app was offering files it then loaded with the wrong node: pick one and the
 * render died. The FILE decides its loader, the way a picked checkpoint
 * decides its own in server/modelpick.js — nobody should have to know which
 * node reads which extension.
 *
 * The pack is not bundled (it is not ours to ship); /api/image checks the
 * engine has the node before queueing and says so by name if it does not.
 */
export const isGguf = (name) => /\.gguf$/i.test(String(name || ""));
export const GGUF_NODES = { unet: "UnetLoaderGGUF", clip: "CLIPLoaderGGUF" };

/** UNETLoader, or the GGUF pack's loader when the file is quantised. */
export function unetNode(name) {
  return isGguf(name)
    ? { class_type: GGUF_NODES.unet, inputs: { unet_name: name } }
    : { class_type: "UNETLoader", inputs: { unet_name: name, weight_dtype: "default" } };
}

/** CLIPLoader, same bargain. `type` still decides how the weights are READ. */
export function clipNode(name, type) {
  return isGguf(name)
    ? { class_type: GGUF_NODES.clip, inputs: { clip_name: name, type } }
    : { class_type: "CLIPLoader", inputs: { clip_name: name, type, device: "default" } };
}

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
  /* REFERENCE IMAGES — FLUX.2's in-context editing, straight from the vendor's
   * own klein image-edit template. Each reference is VAE-encoded and chained
   * through BOTH the positive and the zeroed negative conditioning with a
   * ReferenceLatent node pair; the prompt then talks about "image 1",
   * "image 2" in order. Measured on this card before wiring: 1 ref 12 s,
   * 2 refs 8 s (warm), ~4 s per reference past the second, coherent to at
   * least ten — a character re-posed into a new scene keeps its material and
   * colour. This is what makes iterating a character sheet toward a target
   * possible at all; without it the image engine only ever starts from noise. */
  refImages = [],
  prefix = "cover",
  /* A FLUX.2 transformer the user supplied instead of the catalogue's, and
   * the halves it cannot run without. Null means the catalogue's own — the
   * normal case, and the only one before a person says otherwise. */
  dit = null,
  encoder = null,
  vae = null,
}) {
  const a = config.art;
  const w = width ?? a.size;
  const h = height ?? a.size;
  const refs = (Array.isArray(refImages) ? refImages : []).filter(Boolean).slice(0, 10);

  /* One block per reference, threading both conditioning chains. The node ids
   * start at 40 and stride 10 so they can never collide with the fixed ids
   * below, however many references arrive. */
  const refNodes = {};
  let pos = ["4", 0], neg = ["5", 0];
  refs.forEach((name, i) => {
    const L = 40 + i * 10, E = L + 1, RP = L + 2, RN = L + 3;
    refNodes[L] = { class_type: "LoadImage", inputs: { image: name } };
    refNodes[E] = { class_type: "VAEEncode", inputs: { pixels: [String(L), 0], vae: ["3", 0] } };
    refNodes[RP] = { class_type: "ReferenceLatent", inputs: { conditioning: pos, latent: [String(E), 0] } };
    refNodes[RN] = { class_type: "ReferenceLatent", inputs: { conditioning: neg, latent: [String(E), 0] } };
    pos = [String(RP), 0]; neg = [String(RN), 0];
  });

  return {
    ...refNodes,
    /* `dit` is a FLUX.2 transformer of the user's own (models/diffusion_models);
     * the catalogue's encoder and VAE still drive it. */
    1: unetNode(dit || a.dit),
    // `type: "flux2"` selects the Qwen3 tokenizer/encoder path. Wrong type here
    // loads the weights fine and produces garbage conditioning.
    2: clipNode(encoder || a.textEncoder, "flux2"),
    3: { class_type: "VAELoader", inputs: { vae_name: vae || a.vae } },

    4: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: prompt } },
    5: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },
    6: {
      class_type: "CFGGuider",
      inputs: { model: ["1", 0], positive: pos, negative: neg, cfg: a.cfg },
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
 * Ideogram 4 (open 9B release) — text to image on a different engine.
 *
 * Wiring is the vendor's own blueprint ("Text to Image (Ideogram v4)"): a
 * DUAL-MODEL guider — the conditional DiT plus a separate unconditional DiT —
 * with a CFGOverride that raises cfg late in the schedule, Ideogram's own
 * scheduler (mu/std presets), a Qwen3-VL 8B text encoder, and FLUX.2's latent
 * space and VAE. Presets from the blueprint: Default 20 steps (mu .5,
 * std 1.75), Quality 48 steps (mu 0, std 1.5). No reference-image input —
 * that stays FLUX's trick.
 *
 * ⚠ Licence: Ideogram Non-Commercial Model Agreement — see models.js.
 */
/**
 * ⚠ THE OPEN IDEOGRAM 4 IS NOISE-LOCKED — measured, not speculated: 23 seeds
 * tested, exactly one (777) renders, everything else draws the model's
 * trained-in "blocked by safety filter" card, deterministically, at every mu
 * and both shapes tried. The refusal is keyed on the initial NOISE, and
 * ComfyUI's CPU noise makes the pass-set machine-independent — so passing
 * seeds are shipped as data and a harvester can find more
 * (scripts/harvest_ideogram_seeds.mjs appends to ideogram_seeds.json in the
 * output folder). The hosted service presumably issues licensed noise; the
 * open weights without it are exactly as generous as the licence implies.
 */
export const IDEOGRAM_PASS_SEEDS = [777];

export function ideogramPassSeeds() {
  try {
    const extra = JSON.parse(fs.readFileSync(path.join(config.outputDir, "ideogram_seeds.json"), "utf8"));
    if (Array.isArray(extra)) return [...new Set([...IDEOGRAM_PASS_SEEDS, ...extra.filter(Number.isFinite)])];
  } catch { /* no harvest yet */ }
  return IDEOGRAM_PASS_SEEDS;
}

/**
 * The next pass-seed to try, given the ones this job has already burned.
 *
 * ⚠ THIS EXISTS BECAUSE THE OLD RETRY COULD NOT RETRY. art.js re-picked with
 * `ladder[attempt % ladder.length]`, and on a machine that has never run the
 * harvester the ladder is exactly one entry — so `ladder[1 % 1]` is
 * `ladder[0]`, the seed that just drew the card. Renders are deterministic:
 * the "retry" re-submitted a byte-identical graph, ComfyUI answered from its
 * node cache with the filenames the first attempt had already renamed away,
 * and the job died on a rename ENOENT instead of the honest refusal — which
 * ALSO skipped the cleanup, which is how a refusal card ended up sitting in
 * the library. (Observed in the wild: "ENOENT … rename 'cover_00002_.png' ->
 * 'images/imtar5jya.png'".)
 *
 * So the question is never "how many attempts have I made" but "which seeds
 * are still untried". `undefined` means the ladder is exhausted — and with a
 * one-entry ladder it is exhausted after the FIRST render, which is the truth
 * the failure message has to tell.
 */
export function nextIdeogramSeed(tried = [], ladder = ideogramPassSeeds(), want) {
  const burned = new Set(Array.isArray(tried) ? tried : []);
  const free = ladder.filter((s) => !burned.has(s));
  if (!free.length) return undefined;                 // the ladder is exhausted
  /* `want` is the seed the caller ASKED for — a rolled one, or a cover's seed
   * mixed with its filename. It cannot be used (the model would draw the card)
   * but it can choose WHICH pass-seed is used, and that is the difference
   * between a library where every Ideogram picture is the same noise and one
   * where they are not. Before this, the first untried entry was always
   * returned, and the first entry is always 777 — so 777 painted every
   * Ideogram image and every Ideogram cover ever rendered, whatever seed was
   * typed. Same argument as mixSeed() in art.js: one seed across a whole
   * library must not paint the same art on every song.
   *
   * Indexed into the UNTRIED subset, never the whole ladder — which is what
   * keeps the retry honest no matter what arrives here. */
  if (!Number.isFinite(want)) return free[0];
  return free[Math.abs(Math.trunc(want)) % free.length];
}

/**
 * What a refusal card looks like, in numbers.
 *
 * MEASURED on this machine over 116 cards and 101 real renders, not guessed.
 * The card is a flat NEUTRAL MID-GREY field with one line of white text, and
 * all three of those words are load-bearing:
 *
 *                      variance      flat    modal luma   modal chroma
 *   116 refusal cards   77 – 127   90 – 99%   108 – 111      1.0 – 2.0
 *   101 real renders   183 – 8179    0 – 96%     2 – 250      1.3 – 98
 *
 * WHY THREE SIGNALS AND NOT ONE.
 *
 *  - Variance alone MISSES 27 of the 116 cards: card variance straddles the
 *    old 120 cut (measured up to 127), so the cut is not a detector. Every
 *    one of those would have been filed in the library as a picture.
 *  - Flatness alone has a FALSE POSITIVE that matters: "a vintage travel
 *    poster, minimalist midcentury design, cream and teal" came back as a
 *    flat green field with cream lettering — 96% flat, and a flat-only rule
 *    DELETED it. Minimalist flat-colour design is the thing this engine is
 *    best at; a detector that eats posters is worse than the bug.
 *  - So the flat shade must also be the card's own colour: neutral (chroma
 *    ≤ 12 against the green poster's 98) and mid-grey (luma 100-130 against
 *    a white-background poster's 250). With that gate, all 116 cards are
 *    caught and not one of the 101 real renders is — zero disagreements.
 *
 * A false positive costs one re-render AND can throw away a picture the user
 * wanted; a false negative sells a grey rectangle as a result. Neither is
 * free, which is why this is measured rather than tuned by feel.
 */
export const IDEOGRAM_CARD = { maxVariance: 120, minFlat: 0.9, maxChroma: 12, luma: [100, 130] };

export function isRefusalCard(stats) {
  if (!stats || !Number.isFinite(stats.variance)) return { isCard: false, why: "unreadable" };
  const knowsColour = Number.isFinite(stats.modalChroma) && Number.isFinite(stats.modalLuma);
  const grey = knowsColour
    && stats.modalChroma <= IDEOGRAM_CARD.maxChroma
    && stats.modalLuma >= IDEOGRAM_CARD.luma[0]
    && stats.modalLuma <= IDEOGRAM_CARD.luma[1];
  if (grey && stats.flat >= IDEOGRAM_CARD.minFlat) {
    return { isCard: true, why: `${(stats.flat * 100).toFixed(0)}% of pixels one neutral grey` };
  }
  // The original rule, kept — but no longer able to delete a flat COLOURED
  // design, because the card is never one.
  if (stats.variance < IDEOGRAM_CARD.maxVariance && (grey || !knowsColour)) {
    return { isCard: true, why: `variance ${stats.variance.toFixed(0)} < ${IDEOGRAM_CARD.maxVariance}` };
  }
  return { isCard: false, why: `variance ${stats.variance.toFixed(0)}` };
}

/**
 * What to say when Ideogram will not draw the prompt.
 *
 * The old message ("refused on every known-good seed") was true and useless:
 * on a machine that has never harvested there is exactly ONE known-good seed,
 * so "every" is one, and nothing in the sentence told the owner that the
 * ladder is the thing that is short or how to lengthen it. Both facts belong
 * in the failure, because both are actionable.
 */
export function ideogramRefusalMessage(ladderLength, tried) {
  const one = ladderLength === 1;
  return `Ideogram refused this prompt on ${tried === 1 ? "the only seed it was given" : `all ${tried} seeds tried`}. `
    + `The open weights are NOISE-LOCKED: the refusal card is keyed on the initial noise, so only a sparse set of `
    + `seeds renders anything at all, and this machine's pass-seed ladder has ${ladderLength} `
    + `${one ? "entry" : "entries"}${one ? " — there is no second seed to retry on" : ""}. `
    + `Grow it with \`node scripts/harvest_ideogram_seeds.mjs --count 100\` (passing seeds append to `
    + `ideogram_seeds.json in the output folder and are picked up on the next render), or render this one with `
    + `FLUX.2 / a checkpoint instead.`;
}

/* In the models folder or one of the extra ones (config.modelsAlso): the
 * engine loads from all of them. */
const onDisk = (sub, file) => [config.modelsDir, ...(config.modelsAlso || [])]
  .some((b) => { try { return fs.statSync(path.join(b, sub, file)).size > 0; } catch { return false; } });

/* nvfp4 is NVIDIA-only, so an AMD card gets the vendor's fp8 build of the same
 * encoder (models.js downloads it there), and ONLY that: ROCm has no kernel for
 * nvfp4 (models.js fp4Blocked), so an nvfp4 file that is on disk (an NVIDIA
 * machine's folder added as an extra) is never named, and a machine without the
 * fp8 is told to fetch it. On NVIDIA, whichever is on disk wins. */
function ideogramEncoder() {
  const order = cardIsAmd()
    ? ["qwen3vl_8b_fp8_scaled.safetensors"]
    : ["qwen3vl_8b_nvfp4.safetensors", "qwen3vl_8b_fp8_scaled.safetensors"];
  return order.find((n) => onDisk("text_encoders", n)) || order[0];
}

export function ideogramGraph({ prompt, seed, width, height, quality = "default", count = 1, prefix = "image" }) {
  const snap = (v, d) => Math.max(256, Math.floor(((v ?? d) + 15) / 16) * 16);
  const w = snap(width, 1024), h = snap(height, 1024);
  // vendor presets, verbatim from the blueprint's preset table
  const P = quality === "quality" ? { steps: 48, mu: 0.0, std: 1.5 }
    : quality === "turbo" ? { steps: 12, mu: 0.5, std: 1.75 }
    : { steps: 20, mu: 0.0, std: 1.75 };
  return {
    1: { class_type: "UNETLoader", inputs: { unet_name: "ideogram4_fp8_scaled.safetensors", weight_dtype: "default" } },
    2: { class_type: "UNETLoader", inputs: { unet_name: "ideogram4_unconditional_fp8_scaled.safetensors", weight_dtype: "default" } },
    3: { class_type: "CLIPLoader", inputs: { clip_name: ideogramEncoder(), type: "ideogram4", device: "default" } },
    4: { class_type: "CLIPTextEncode", inputs: { clip: ["3", 0], text: prompt } },
    5: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },
    6: { class_type: "CFGOverride", inputs: { model: ["1", 0], cfg: 3, start_percent: 0.7, end_percent: 1 } },
    7: { class_type: "DualModelGuider",
         inputs: { model: ["6", 0], positive: ["4", 0], cfg: 7, model_negative: ["2", 0], negative: ["5", 0] } },
    8: { class_type: "Ideogram4Scheduler", inputs: { steps: P.steps, width: w, height: h, mu: P.mu, std: P.std } },
    9: { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    10: { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    11: { class_type: "EmptyFlux2LatentImage", inputs: { width: w, height: h, batch_size: Math.max(1, count) } },
    12: { class_type: "SamplerCustomAdvanced",
          inputs: { noise: ["10", 0], guider: ["7", 0], sampler: ["9", 0], sigmas: ["8", 0], latent_image: ["11", 0] } },
    16: { class_type: "VAELoader", inputs: { vae_name: "flux2-vae.safetensors" } },
    17: { class_type: "VAEDecode", inputs: { samples: ["12", 0], vae: ["16", 0] } },
    13: { class_type: "SaveImage", inputs: { images: ["17", 0], filename_prefix: prefix } },
    14: { class_type: "ImageScale",
          inputs: { image: ["17", 0], upscale_method: "lanczos",
                    width: config.art.thumbSize, height: config.art.thumbSize, crop: "center" } },
    15: { class_type: "SaveImage", inputs: { images: ["14", 0], filename_prefix: `${prefix}_thumb` } },
  };
}

/**
 * Bring-your-own checkpoint — the classic SD graph on ANY .safetensors the
 * user drops into ComfyUI/models/checkpoints. This is the actual "switch out
 * models" feature: the app curates nothing and endorses nothing; whatever the
 * checkpoint's licence and content policy say is between the user and its
 * author. Negative prompt and cfg exist here because SD-class models use them.
 */
export function checkpointGraph({ ckpt, prompt, negative, seed, width, height, steps, cfg,
                                  clipSkip, sampler, scheduler, loras, count = 1, prefix = "image" }) {
  /* CLIP SKIP stops the text encoder early, which is a real dial on the SD
   * family and meaningless everywhere else (FLUX, Z-Image and Anima have no
   * CLIP encoder at all). 1 is "use the whole encoder" and inserts no node, so
   * the default graph is byte-identical to the one before this existed.
   *
   * Pony and Illustrious are SDXL underneath and effectively REQUIRE 2 — and
   * nothing in the tensors can tell such a merge from any other SDXL, which is
   * why this is a control rather than something detection sets. */
  const skip = Number(clipSkip) > 1 ? Math.min(Math.round(Number(clipSkip)), 12) : 1;

  /* LoRAs CHAIN. Each one takes the model and clip the previous produced, which
   * is what makes stacking several the normal case rather than a special one —
   * a style plus a character plus a lighting LoRA is how these are actually
   * used. Ids start at 100 so the fixed nodes above keep the numbers art.js and
   * COVER_NODES read outputs by.
   *
   * ORDER: checkpoint -> LoRAs -> CLIPSetLastLayer -> text encode. A LoRA can
   * carry text-encoder weights of its own, so skipping layers BEFORE it applies
   * would drop the very layers it wants to modify. ComfyUI's own templates put
   * them in this order for the same reason. */
  const chain = {};
  let modelSrc = ["1", 0];
  let clipSrc = ["1", 1];
  const stack = Array.isArray(loras) ? loras.slice(0, 8) : [];
  stack.forEach((lo, i) => {
    const id = String(100 + i);
    chain[id] = {
      class_type: "LoraLoader",
      inputs: {
        model: modelSrc, clip: clipSrc,
        lora_name: lo.name,
        /* Two strengths, because they are genuinely different dials: a style
         * LoRA often wants its text-encoder half lower than its unet half.
         * clip defaults to the model strength, which is what people expect. */
        strength_model: Number.isFinite(lo.strength) ? lo.strength : 1,
        strength_clip: Number.isFinite(lo.clipStrength) ? lo.clipStrength
          : (Number.isFinite(lo.strength) ? lo.strength : 1),
      },
    };
    modelSrc = [id, 0];
    clipSrc = [id, 1];
  });
  if (skip > 1) {
    chain[18] = { class_type: "CLIPSetLastLayer", inputs: { clip: clipSrc, stop_at_clip_layer: -skip } };
    clipSrc = ["18", 0];
  }

  return {
    1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ckpt } },
    ...chain,
    2: { class_type: "CLIPTextEncode", inputs: { clip: clipSrc, text: prompt } },
    3: { class_type: "CLIPTextEncode", inputs: { clip: clipSrc, text: String(negative || "") } },
    4: { class_type: "EmptyLatentImage", inputs: { width: width ?? 1024, height: height ?? 1024, batch_size: Math.max(1, count) } },
    5: { class_type: "KSampler",
         inputs: { model: modelSrc, positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0],
                   seed, steps: steps ?? 28, cfg: cfg ?? 6,
                   /* dpmpp_2m/karras is a good default and was the ONLY option:
                    * the sampler is the dial people reach for after steps, and
                    * a hard-coded one made every other choice unreachable. The
                    * names are ComfyUI's own and are validated against its live
                    * /object_info before a render, so a typo fails with a list
                    * rather than a stack trace. */
                   sampler_name: sampler || "dpmpp_2m", scheduler: scheduler || "karras", denoise: 1 } },
    17: { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    13: { class_type: "SaveImage", inputs: { images: ["17", 0], filename_prefix: prefix } },
    14: { class_type: "ImageScale",
          inputs: { image: ["17", 0], upscale_method: "lanczos",
                    width: config.art.thumbSize, height: config.art.thumbSize, crop: "center" } },
    15: { class_type: "SaveImage", inputs: { images: ["14", 0], filename_prefix: `${prefix}_thumb` } },
  };
}

/* ──────────────────────────────────────────────────────── Anima (CircleStone)
 *
 * A 2B DiT for anime, illustration and stylised art. Read from ComfyUI's own
 * blueprint (blueprints/"Text to Image (Anima).json") rather than inferred from
 * the model class, and the difference matters twice:
 *
 *  ⚠ THE ENCODER IS QWEN3-0.6B, not the Qwen3-4B this app already holds for
 *    FLUX.2 klein and Z-Image. Same family, same folder, different model. The
 *    tempting reuse fails at the sampler.
 *
 *  ⚠ THE TOKENIZER HAS A T5-XXL SLOT AND THE BLUEPRINT DOES NOT FILL IT.
 *    comfy/text_encoders/anima.py builds AnimaTokenizer from a Qwen3 tokenizer
 *    AND a T5XXL one, so reading the class alone says Anima needs a second
 *    5-10 GB encoder. The vendor graph loads one CLIPLoader. The class says
 *    what it can accept; the blueprint says what it was tested with.
 *
 *  ⚠ THE VAE IS QWEN-IMAGE'S. `supported_models.Anima` declares
 *    latent_format = Wan21, which reads as "fetch the WAN VAE". The blueprint
 *    loads qwen_image_vae.safetensors. Same shape of trap as Z-Image's
 *    CLIPLoader type, and the same lesson: read the graph, not the class.
 *
 * The CLIPLoader `type` is the plain "stable_diffusion" here — Anima's encoder
 * is wrapped by its own AnimaTokenizer on the model side, so no special type
 * name is involved and there is no equivalent of Z-Image's lumina2 footgun.
 */
export const ANIMA_PRESET = { steps: 30, cfg: 4.0, sampler: "er_sde", scheduler: "simple", size: 1024 };
export const ANIMA_ENCODER_FILE = "qwen_3_06b_base.safetensors";
export const ANIMA_VAE_FILE = "qwen_image_vae.safetensors";

export function animaGraph({ dit, prompt, negative, seed, width, height, steps, cfg,
                             sampler, scheduler, count = 1, prefix = "image",
                             /* The encoder and VAE a person chose instead of the catalogue's. */
                             encoder = null, vae = null }) {
  return {
    1: unetNode(dit),
    6: clipNode(encoder || ANIMA_ENCODER_FILE, "stable_diffusion"),
    7: { class_type: "VAELoader", inputs: { vae_name: vae || ANIMA_VAE_FILE } },
    2: { class_type: "CLIPTextEncode", inputs: { clip: ["6", 0], text: prompt } },
    /* A REAL negative branch, unlike the distilled engines: Anima samples at
     * cfg 4.0, where ComfyUI evaluates the unconditional pass, so what you put
     * here is actually read. The blueprint even ships a default one. */
    3: { class_type: "CLIPTextEncode", inputs: { clip: ["6", 0], text: String(negative || "") } },
    4: { class_type: "EmptyLatentImage",
         inputs: { width: width ?? ANIMA_PRESET.size, height: height ?? ANIMA_PRESET.size,
                   batch_size: Math.max(1, count) } },
    5: { class_type: "KSampler",
         inputs: { model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0],
                   seed, steps: steps ?? ANIMA_PRESET.steps, cfg: cfg ?? ANIMA_PRESET.cfg,
                   sampler_name: sampler || ANIMA_PRESET.sampler,
                   scheduler: scheduler || ANIMA_PRESET.scheduler, denoise: 1 } },
    17: { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["7", 0] } },
    13: { class_type: "SaveImage", inputs: { images: ["17", 0], filename_prefix: prefix } },
    14: { class_type: "ImageScale",
          inputs: { image: ["17", 0], upscale_method: "lanczos",
                    width: config.art.thumbSize, height: config.art.thumbSize, crop: "center" } },
    15: { class_type: "SaveImage", inputs: { images: ["14", 0], filename_prefix: `${prefix}_thumb` } },
  };
}

/* ─────────────────────────────────────────────────────────── Z-Image (Tongyi)
 *
 * The two shipped builds, and the ONE place their filenames are written down.
 * Turbo is the 8-step distillation; base is the undistilled model that still
 * has classifier-free guidance in it. Same architecture, same encoder, same
 * VAE — everything that differs between them is in this table and in the
 * preset below, so adding a third build is one line rather than a hunt.
 */
/**
 * Krea 2 Turbo — text to image, ComfyUI's own support (supported_models.Krea2,
 * text_encoders/krea2.py: a Qwen3-VL 4B read through the "krea2" CLIP type,
 * the Qwen image VAE, Wan21 latent format, sampling shift 1.15 built into the
 * model class so no shift node is needed).
 *
 * Wiring from the published local recipe (comfylab.dev, tested on a 3090,
 * 2026-09): UNETLoader → CLIPLoader type krea2 → CLIPTextEncode → KSampler
 * 8 steps, cfg 1.0, euler / simple → VAEDecode. Turbo is DISTILLED at cfg 1,
 * so the negative branch is never evaluated: like Z-Image Turbo, the route
 * refuses a negative rather than showing a box that does nothing. No
 * reference input — that stays FLUX.2's.
 */
export const KREA2_FILES = {
  dit: "krea2_turbo_int8_convrot.safetensors",
  encoder: "qwen3vl_4b_fp8_scaled.safetensors",
  vae: "qwen_image_vae.safetensors",
};
export const KREA2_PRESET = { steps: 8, cfg: 1.0, cfgs: false, sampler: "euler", scheduler: "simple" };

export function krea2Graph({ prompt, seed, width, height, steps, count = 1, prefix = "image",
                              dit = null, encoder = null, vae = null }) {
  const snap = (x, d) => Math.max(256, Math.floor(((x ?? d) + 15) / 16) * 16);
  const w = snap(width, 1024), h = snap(height, 1024);
  return {
    /* `dit` is a Krea 2 transformer of the user's own; encoder and VAE stay the
     * catalogue's, as with Z-Image above. */
    1: unetNode(dit || KREA2_FILES.dit),
    2: clipNode(encoder || KREA2_FILES.encoder, "krea2"),
    3: { class_type: "VAELoader", inputs: { vae_name: vae || KREA2_FILES.vae } },
    4: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: prompt } },
    5: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },
    7: { class_type: "EmptySD3LatentImage", inputs: { width: w, height: h, batch_size: Math.max(1, count) } },
    8: { class_type: "KSampler",
         inputs: { model: ["1", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["7", 0],
                   seed, steps: Math.max(1, Math.round(steps ?? KREA2_PRESET.steps)), cfg: KREA2_PRESET.cfg,
                   sampler_name: KREA2_PRESET.sampler, scheduler: KREA2_PRESET.scheduler, denoise: 1 } },
    17: { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    13: { class_type: "SaveImage", inputs: { images: ["17", 0], filename_prefix: prefix } },
    14: { class_type: "ImageScale",
          inputs: { image: ["17", 0], upscale_method: "lanczos",
                    width: config.art.thumbSize, height: config.art.thumbSize, crop: "center" } },
    15: { class_type: "SaveImage", inputs: { images: ["14", 0], filename_prefix: `${prefix}_thumb` } },
  };
}

export const ZIMAGE_DITS = {
  turbo: "z_image_turbo_int8_convrot.safetensors",
  base: "z_image_int8_convrot.safetensors",
};

/**
 * Sampler settings PER BUILD, verbatim from ComfyUI's own bundled templates.
 *
 * Sources on this rig, read rather than remembered:
 *   turbo  comfyui_workflow_templates_json/templates/image_z_image_turbo.json
 *          → definitions.subgraphs[0] "Text to Image (Z-Image-Turbo)",
 *            KSampler widgets_values [seed, "randomize", 8, 1, "res_multistep",
 *            "simple", 1]
 *   base   .../image_z_image.json → subgraphs[0] "Text to Image(Z-Image-Base
 *          Int8)", KSampler widgets_values [seed, "randomize", 25, 4,
 *          "res_multistep", "simple", 1]
 *
 * ⚠ `cfgs: false` on turbo is not a style choice, it is arithmetic. ComfyUI
 * skips the unconditional branch entirely when cfg == 1.0 (see
 * comfy/samplers.py), so on turbo the negative conditioning is never evaluated
 * — a negative prompt there would be a text box that does nothing. That is why
 * turbo's negative is a ConditioningZeroOut of the positive (the sampler
 * requires the input, so it gets a zeroed one) and base gets a REAL second
 * CLIPTextEncode. The /api/image route asks `ZIMAGE_PRESET[v].cfgs` rather
 * than re-deriving the rule from the engine name, so a third variant added
 * here is refused or accepted correctly without a second edit. The browser
 * cannot import this file, so web/app.js carries its own copy of the flag in
 * IMG_ENGINES — and server/mcp-image_test.js diffs the two.
 *
 * The base template also carries a MarkdownNote reading "Steps: 30～50, cfg:
 * 3～5". Its own KSampler widget says 25 and 4.0, and the widget is what the
 * template actually renders with, so 25/4.0 is what ships; the note's range is
 * surfaced to the user as the range the slider allows, not as the default.
 */
export const ZIMAGE_PRESET = {
  turbo: { steps: 8, cfg: 1.0, cfgs: false },
  base: { steps: 25, cfg: 4.0, cfgs: true },
};

/**
 * Z-Image (Tongyi-MAI) — text to image, Apache-2.0 the whole way down.
 *
 * Wiring taken from the vendor templates named above rather than
 * reconstructed. A Lumina2-family single-stream DiT (dim 3840, 30 layers), a
 * Qwen3-4B text encoder, and FLUX.1's 16-channel latent space:
 *
 *   UNETLoader -> ModelSamplingAuraFlow(shift 3.0) --> KSampler.model
 *   CLIPLoader(type "lumina2") -> CLIPTextEncode ---> KSampler.positive
 *                              +-> Zero | CLIPTextEncode -> KSampler.negative
 *   EmptySD3LatentImage ---------------------------> KSampler.latent_image
 *   VAELoader(ae.safetensors) -> VAEDecode <- sampler -> SaveImage + thumb
 *
 * 🔴 THE FOOTGUN — READ THIS BEFORE CHANGING `type` ON NODE 2.
 *
 * `qwen_3_4b.safetensors` is ONE file serving TWO different models. ComfyUI
 * identifies the encoder from its own state dict (`detect_te_model` keys on
 * `model.layers.0.post_attention_layernorm.weight`, 2560 = Qwen3-4B) and then
 * branches on the `type` string this graph passes:
 *
 *     elif te_model == TEModel.QWEN3_4B:                    # comfy/sd.py
 *         if clip_type == CLIPType.FLUX or clip_type == CLIPType.FLUX2:
 *             ... flux.klein_te(...)      # FLUX.2 klein's tokenizer/wrapper
 *         else:
 *             ... z_image.te(...)         # Z-Image's
 *
 * So `type: "flux2"` here — the value coverGraph correctly uses two hundred
 * lines up, in the same file, for the SAME encoder file — builds klein's
 * wrapper around Z-Image's encoder. There is no `"z_image"` in CLIPLoader's
 * type list at all: "lumina2" is right precisely BECAUSE it is not FLUX/FLUX2
 * and therefore falls to the else branch. (So would "stable_diffusion", or any
 * other name in that list — only flux/flux2 are wrong. Read the branch, not
 * the label.)
 *
 * WHAT ACTUALLY HAPPENS WHEN YOU GET IT WRONG — measured on this rig
 * 2026-08-27, same prompt, same seed 12345, same 8 steps, one string changed:
 *
 *     "lumina2"  →  a coherent photograph in 4.5 s
 *     "flux2"    →  RuntimeError at the KSampler:
 *                   Given normalized_shape=[2560], expected input with
 *                   shape [*2560], but got input of size [1, 512, 7680]
 *
 * 7680 is 3 x 2560: klein's wrapper concatenates THREE hidden-layer taps,
 * Z-Image's DiT declares `cap_feat_dim` 2560 and takes the penultimate layer
 * only. That mismatch is what LayerNorm catches.
 *
 * ⚠ Note this is LOUDER than the model research predicted ("loads without
 * error and produces garbage conditioning"). It is right about the routing and
 * right that nothing warns you at load time — CLIPLoader and CLIPTextEncode
 * both succeed, and the failure surfaces two nodes later in a message about
 * tensor shapes that names neither the encoder nor the type — but on THIS
 * pairing the wrong wrapper cannot reach the pixels. Do not weaken the comment
 * on the strength of that: the shapes only happen to disagree. A future
 * encoder whose taps line up would fail the silent way instead, and this is
 * the one line that decides it. scripts/test_workflow.mjs pins the string.
 *
 * One more thing worth not "tidying": ModelSamplingAuraFlow is not optional
 * decoration. Z-Image's own model class declares `sampling_settings shift 3.0`
 * (comfy/supported_models.py, class ZImage), but UNETLoader loads a bare
 * diffusion model and the templates patch the shift in explicitly — drop node 6
 * and the schedule silently reverts to the Lumina2 parent's shift 6.0.
 *
 * ⚠ NO REFERENCE-IMAGE INPUT, AND THAT WAS TESTED RATHER THAN ASSUMED.
 *
 * ComfyUI ships `TextEncodeZImageOmni` (comfy_extras/nodes_zimage.py, marked
 * is_experimental) and it takes image1/image2/image3 — a hard cap of three —
 * VAE-encodes them into `reference_latents` and swaps in a vision prompt
 * template. It is tempting: three references, no extra weights, one node
 * substituted for the CLIPTextEncode above.
 *
 * It does not work on the released checkpoints, and it fails in the shape that
 * would have shipped a broken picker. Measured 2026-08-27, same seed 31337,
 * same 8 steps, prompt "the object from image 1, on a beach at sunrise":
 *
 *   no reference   →  a beach at sunrise. The prompt, rendered.
 *   one reference  →  the REFERENCE's own composition, speckled with
 *                     colour noise, and the prompt ignored entirely.
 *
 * So the node runs, the latents reach the model, and the model has no trained
 * path for them — which is consistent with Tongyi-MAI listing Z-Image-Edit and
 * Z-Image-Omni-Base as "to be released". The weights the node was written for
 * do not exist yet. When they do, this is the node and three is the cap;
 * until then the Images screen says so instead of offering a picker.
 */
export function zImageGraph({
  prompt,
  negative,
  seed,
  width,
  height,
  steps,
  cfg,
  /* "turbo" (8 steps, no CFG) or "base" (25 steps, real CFG and a real
   * negative prompt). Anything else falls to turbo rather than throwing: this
   * is reached from a saved settings file and a stale value should cost a
   * different picture, not a dead Images screen. */
  variant = "turbo",
  /* A Z-Image transformer the user supplied instead of the catalogue's, with
   * the encoder and VAE to drive it. Null means the catalogue's own. */
  dit = null,
  encoder = null,
  vae = null,
  count = 1,
  prefix = "image",
}) {
  const v = ZIMAGE_PRESET[variant] ? variant : "turbo";
  const P = ZIMAGE_PRESET[v];
  /* EmptySD3LatentImage declares step 16 on both dimensions (nodes_sd3.py), and
   * the latent is 8x-compressed then 2x-patchified — so 16 is the real grid,
   * not a rounding nicety. Snapped UP, like ideogramGraph, so a requested size
   * is never silently cropped. */
  const snap = (x, d) => Math.max(256, Math.floor(((x ?? d) + 15) / 16) * 16);
  const w = snap(width, 1024), h = snap(height, 1024);

  return {
    /* `dit` is the user's own Z-Image file from models/diffusion_models, when
     * they picked one on the Images screen. The encoder and VAE are still the
     * catalogue's: a community Z-Image is a re-trained transformer, not a
     * different architecture. */
    1: unetNode(dit || ZIMAGE_DITS[v]),
    // 🔴 "lumina2", NEVER "flux2" — see the block comment above. The same file
    // is FLUX.2 klein's encoder and this string is the only thing that decides.
    2: clipNode(encoder || "qwen_3_4b.safetensors", "lumina2"),
    // ae.safetensors is FLUX.1's 16-channel VAE, NOT flux2-vae.safetensors —
    // that one is 32-channel and belongs to FLUX.2. Same family name, different
    // latent space; swapping them decodes noise.
    3: { class_type: "VAELoader", inputs: { vae_name: vae || "ae.safetensors" } },

    4: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: prompt } },
    /* Turbo samples at cfg 1.0, where ComfyUI never runs the uncond pass, so
     * its negative branch is a zeroed copy of the positive and typing into a
     * negative box would change nothing. Base runs real CFG and gets a real
     * encode — an empty string when the caller supplies none, exactly as the
     * vendor template's node 71 does. */
    5: P.cfgs
      ? { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: String(negative || "") } }
      : { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },

    6: { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3.0 } },
    7: { class_type: "EmptySD3LatentImage", inputs: { width: w, height: h, batch_size: Math.max(1, count) } },
    8: { class_type: "KSampler",
         inputs: { model: ["6", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["7", 0],
                   seed,
                   steps: Math.max(1, Math.round(steps ?? P.steps)),
                   // Turbo's cfg is NOT a caller's to raise: above 1.0 it would
                   // switch the uncond pass back on and sample a distilled model
                   // the way it was distilled not to be.
                   cfg: P.cfgs ? (cfg ?? P.cfg) : P.cfg,
                   sampler_name: "res_multistep", scheduler: "simple", denoise: 1 } },

    17: { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    13: { class_type: "SaveImage", inputs: { images: ["17", 0], filename_prefix: prefix } },
    14: { class_type: "ImageScale",
          inputs: { image: ["17", 0], upscale_method: "lanczos",
                    width: config.art.thumbSize, height: config.art.thumbSize, crop: "center" } },
    15: { class_type: "SaveImage", inputs: { images: ["14", 0], filename_prefix: `${prefix}_thumb` } },
  };
}

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
 *   LTX takes fps * seconds + 1 — but its VAE is 8x temporal, so it only
 *       renders counts where (n - 1) is divisible by 8, and it rounds to the
 *       NEAREST such count. Sometimes DOWN.
 *
 * ⚠ AND DOWN IS A BUG, measured on every video made so far. `raw + 1` for a
 * 5.5 s scene at 24 fps asks for 133; 133 is four above 129 and eight below
 * 137, so LTX returns 129 — a 5.375 s clip for a 5.5 s slot. The timeline then
 * has three frames at the end of that slot with no picture in them, and the
 * finished video flashes BLACK at the cut. Measured on The Long Ascent: eight
 * black runs, three frames each, one immediately before every cut. It fired on
 * all 99 clips wherever the arithmetic happened to land short.
 *
 * Rounding UP instead guarantees the clip covers its slot, and the few frames
 * of overshoot are exactly the handle material a crossfade needs — which the
 * handover recorded as impossible at coverage 0.96. It is not impossible; it
 * was being thrown away here.
 *
 * This has two call sites — the graph builder and the render deadline in
 * art.js — and both must pass the engine, or the watchdog sizes itself from a
 * frame count the graph never renders.
 */
export function alignFrames(seconds, fps, engine = "h3") {
  const raw = Math.max(1, Math.round(seconds * fps));
  if (engine === "ltx") {
    let n = raw + 1;
    while ((n - 1) % 8 !== 0) n += 1;
    return n;
  }
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
  /* No turboLora: every H3 speed-up is optional. Without one H3 renders the
   * bare model (20 steps), and a step count whose file is missing is refused
   * with its download offered (video-plain.js videoPlan). */
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
    if (onDisk(sub, file)) continue;
    missing.push(file);
  }
  return { ready: missing.length === 0, missing };
}

/**
 * WHICH VIDEO ENGINE ACTUALLY RUNS ON THIS MACHINE.
 *
 * ┌─ THE BUG THIS EXISTS TO END ───────────────────────────────────────────┐
 * │ The shipped default named LTX 2.5, and LTX 2.5 is the one model in the │
 * │ whole catalogue Studio CANNOT DOWNLOAD. Its repo is access-gated, so   │
 * │ the built-in downloader refuses on purpose and the Models screen shows │
 * │ it with instructions instead of a button. So a fresh install opened    │
 * │ the Video page and met: "LTX 2.5 is not downloaded yet (39.7 GB        │
 * │ missing). Open the Models screen." — where there is no button to       │
 * │ press. A dead end, on the first click, in the default configuration.   │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * THE PREFERENCE IS NOT THE FACT, and conflating them is what made this
 * possible. `config.video.engine` is a SETTING — persisted, chosen by a person,
 * and this function never writes it. What weights are on disk is a fact.
 * Resolution reads the fact and reports the setting alongside it, so the Video
 * page can say "your setting is LTX; you are holding H3; renders will use H3"
 * rather than either lying or refusing.
 *
 * That distinction is exactly the one videoReady() was written for — see its
 * header: a preference that defaults off was being read as "the weights are
 * absent", and an overnight run that explicitly asked for video sat saying
 * "waiting" until morning. This is the same mistake in the other direction.
 *
 * THREE OUTCOMES:
 *
 *   the setting's weights are here      → use them. Nothing to say.
 *   another engine's weights are here   → use those, and SAY SO. Substituting
 *                                         silently would be its own bug; a
 *                                         render is minutes and money and the
 *                                         two engines take different inputs.
 *   nothing is here                     → keep the setting untouched and name
 *                                         the engine that can actually be
 *                                         FETCHED, with its licence condition.
 *                                         Never the gated one: telling someone
 *                                         to download what cannot be downloaded
 *                                         is how this started.
 *
 * @param {string} [preferred] Override the setting (a job carrying its own engine).
 */
export function resolveVideoEngine(preferred) {
  const configured = (preferred || config.video.engine);
  const keys = Object.keys(config.video.engines);
  const capOf = (k) => CATALOG.find((c) => c.id === MODEL_TO_CAPABILITY[k]) || null;
  const isFetchable = (k) => !capOf(k)?.gated;
  const labelOf = (k) => config.video.engines[k]?.label || k;

  const state = new Map(keys.map((k) => [k, videoReady(k)]));
  const here = keys.filter((k) => state.get(k)?.ready);

  const base = {
    configured,
    label: labelOf(configured),
    /* Every engine's presence, once, so a caller does not run videoReady()
     * again per engine and get a different answer mid-sentence. */
    present: Object.fromEntries(keys.map((k) => [k, !!state.get(k)?.ready])),
  };

  if (state.get(configured)?.ready) {
    return { ...base, key: configured, substituted: false, ready: true, missing: [], get: null,
      why: `${labelOf(configured)} is the chosen engine and its weights are on disk.` };
  }

  if (here.length) {
    /* Prefer a fetchable one where both are present, purely so the sentence
     * shown to the user names an engine they could re-download if they ever
     * moved machines. With one engine present this is a no-op. */
    const key = here.find(isFetchable) || here[0];
    return {
      ...base, key, substituted: true, ready: true,
      missing: state.get(configured)?.missing || [],
      get: null,
      why: `Your setting is ${labelOf(configured)}, whose weights are not on this machine. `
         + `${labelOf(key)} is, so renders use it. The setting has not been changed — download `
         + `${labelOf(configured)} and it takes over again.`,
    };
  }

  /* Nothing on disk. THIS is the branch that used to produce a refusal naming a
   * model with no button. It now names one with a button — and carries the
   * licence condition attached to it, because H3's downloader refuses without a
   * territory acknowledgement and a suggestion that bounces is not a fix. */
  const fetchable = keys.filter(isFetchable);
  const target = fetchable[0] || keys[0];
  const cap = capOf(target);
  return {
    ...base, key: configured, substituted: false, ready: false,
    missing: state.get(configured)?.missing || [],
    get: target
      ? {
          engine: target, label: labelOf(target), capabilityId: MODEL_TO_CAPABILITY[target] || null,
          bytes: (cap?.files || []).reduce((n, f) => n + (f.bytes || 0), 0),
          region: cap?.region || null,
        }
      : null,
    /* The gated engine is named as an aside, never as the instruction. Someone
     * who wants it should know it exists and how to get it by hand; nobody
     * should be sent there by default. */
    alsoGated: keys.filter((k) => !isFetchable(k)).map((k) => ({
      engine: k, label: labelOf(k), how: capOf(k)?.gated?.how || null, url: capOf(k)?.gated?.url || null,
    })),
    why: `No video weights are on this machine yet. ${labelOf(target)} is the one Studio can `
       + `download for you — the Models screen has the button.`,
  };
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
    1: unetNode(v.dit),
    2: clipNode(v.textEncoder, "ltxv"),
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
    1: unetNode(v.dit),
    2: clipNode(v.textEncoder, "ltxv"),
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

/**
 * THE SIZE A VIDEO ENGINE WILL ACTUALLY RENDER.
 *
 * Exported because the screen has to show it. LTX renders at HALF and upscales
 * back, and both halves are floored to the 32px latent grid first — so the real
 * output is floor(n/64)*64, and asking for 544 quietly returns 512. That is not
 * hypothetical: `960 x 544 · fast` was in this app's own size list promising a
 * height it could not produce, directly under a comment warning that both axes
 * must survive the flooring.
 *
 * H3 samples at the size it is given, so its only rule is the route's clamp.
 * Keeping BOTH answers in one function means the picker cannot disagree with
 * the graph — which is the entire way that 544 survived.
 */
export function videoSizeFor(engine, width, height) {
  const clamp = (n) => Math.min(Math.max(Math.round(Number(n) || 0), 256), 3840);
  const w = clamp(width), h = clamp(height);
  if (engine === "ltx") {
    const q = (n) => Math.max(32, Math.floor(n / 2 / 32) * 32) * 2;
    return { width: q(w), height: q(h), quantised: true, grid: 64 };
  }
  return { width: w, height: h, quantised: false, grid: 1 };
}

/**
 * YOUR OWN VIDEO LoRAs, the Video screen's stack. Cleaned the way the image
 * route cleans its own: at most eight, a bare file name inside models/loras
 * (never a path), a strength clamped to -4..4. Anything else is dropped.
 */
export function videoLoras(list) {
  if (!Array.isArray(list)) return undefined;
  const out = list.slice(0, 8)
    .map((l) => ({
      name: String(l?.name || "").split(/[\\/]/).pop(),
      strength: Number.isFinite(Number(l?.strength)) && l?.strength !== null && l?.strength !== ""
        ? Math.min(Math.max(Number(l.strength), -4), 4) : 1,
    }))
    .filter((l) => l.name && /\.safetensors$/i.test(l.name));
  return out.length ? out : undefined;
}

/**
 * Chains the stack onto a MODEL wire as LoraLoaderModelOnly nodes 90..97, each
 * taking the previous one's model, and returns the wire the rest of the graph
 * should read. Model-only because both video engines load a bare DiT: there is
 * no checkpoint CLIP to patch. No LoRAs leaves the graph byte for byte.
 */
export function chainVideoLoras(g, from, loras) {
  let wire = from;
  (videoLoras(loras) || []).forEach((l, i) => {
    const id = String(90 + i);
    g[id] = { class_type: "LoraLoaderModelOnly", inputs: { model: wire, lora_name: l.name, strength_model: l.strength } };
    wire = [id, 0];
  });
  return wire;
}

export function videoGraph(opts = {}) {
  const engine = opts.engine || config.video.engine;
  // FastH3 is H3's graph with its own settings (config.video.engines.fasth3).
  return engine === "ltx" ? videoGraphLtx(opts) : videoGraphH3({ ...opts, engine });
}

/* How much of a reference audio clip rides into the render. The whole file
 * would work, but every reference token is attended on EVERY sampling step, so
 * a full song as a "voice reference" is mostly a slowdown. Ten seconds is
 * enough to carry a voice or a texture. Trimming happens in the graph
 * (TrimAudioDuration is core ComfyUI), so no audio tooling is needed here. */
const REF_AUDIO_SECONDS = 10;

/**
 * Which turbo LoRA an H3 render loads. One rule, two callers: the graph below
 * and the Video panel's catalog — which used to answer the question on their
 * own and could disagree (the panel once reported a shift of 12 while the
 * graph sent 0; the sigma-shift guard's comment records it).
 *
 * @param {object}  eng        config.video.engines.h3, merged over config.video
 * @param {object}  [o]
 * @param {number}  [o.steps]  sampler steps; the engine's default when unset
 * @param {boolean} [o.refs]   true on the reference (ref2va) path
 * @returns {{turbo:boolean, use4:boolean, use3:boolean, lora:string|null}}
 *          `lora` is null on the quality path, where no distillation loads.
 */
export function h3TurboLoraFor(eng, { steps, refs = false } = {}) {
  const n = Number(steps ?? eng.steps);
  const turbo = n <= (eng.turboMaxSteps ?? 12);
  const use4 = n <= (eng.turbo4MaxSteps ?? 5);
  /* The 3-step build is fl2v-only — TaoMate was trained on those weights — so
   * the reference path never takes it, and a config without one never does. */
  const use3 = !refs && !!eng.turboLora3 && n <= (eng.turbo3MaxSteps ?? 3);
  if (!turbo) return { turbo, use4, use3, lora: null };
  const lora = refs
    ? (use4 ? (eng.refTurboLora4 ?? eng.refTurboLora ?? eng.turboLora)
            : (eng.refTurboLora ?? eng.turboLora))
    : use3 ? eng.turboLora3
    : (use4 ? (eng.turboLora4 ?? eng.turboLora) : eng.turboLora);
  return { turbo, use4, use3, lora: lora ?? null };
}

/**
 * WHICH SPARSE ATTENTION A RENDER CARRIES, if any: the node-81 recipe or null.
 *
 *   FastH3   its own VSA (config `sparseAttention`), always: it was trained
 *            against it.
 *   H3       sol-attn (config `solAttn`, h3tier.js H3_SOL_ATTN) on the Fast
 *            setting's plain path only: the TaoMate 3-step file, text or
 *            frames, where the H3 lab measured it (1.15x on the wall, a
 *            slightly softer picture). Standard, Best, the reference path, a
 *            continuation and video-to-video stay dense: none of them was
 *            measured with it. `sparse` is the per-render choice ("sol-attn"
 *            | "off"); unset reads the saved setting (config `sparse`).
 *   LTX      none.
 *
 * One reader for the graph below and for /api/video's check, so the page says
 * what the graph does.
 */
export function h3SparseFor(eng, { steps, refs = false, sparse, continuation = false, control = false } = {}) {
  if (eng?.sparseAttention) return eng.sparseAttention;
  const want = sparse ?? eng?.sparse ?? "off";
  if (want !== "sol-attn" || !eng?.solAttn || continuation || control) return null;
  const { turbo, use3, lora } = h3TurboLoraFor(eng, { steps, refs });
  /* The strength is the person's (video_settings sparse_tau, 1.0 to 2.0);
   * unset, the lab's recipe stands. */
  const tau = Number(eng.solAttnTau);
  const recipe = Number.isFinite(tau) && tau >= 1 && tau <= 2 && tau !== eng.solAttn.tau
    ? { ...eng.solAttn, tau } : eng.solAttn;
  if (turbo && use3 && !!lora && lora === eng.turboLora3) return recipe;
  /* Every other step count only when the person asked for it (video_settings
   * sparse_everywhere): the lab measured the Fast setting alone. The
   * reference path stays dense either way. */
  return eng.sparseAll === true && !refs ? recipe : null;
}

/**
 * H3's block cache for one render (h3tier.js H3_BLOCK_CACHE), or null.
 * `blockCache` is the render's answer from art.js videoBlockCache(): true only
 * where the setting is on AND the engine has the node. Plain path only: no
 * references, continuation or video-to-video (none measured with it), and
 * never beside sparse attention, which the node refuses.
 */
export function h3BlockCacheFor(eng, { blockCache = false, refs = false, continuation = false, control = false, sparse = null } = {}) {
  if (blockCache !== true || !eng?.blockCacheRecipe || refs || continuation || control || sparse) return null;
  return eng.blockCacheRecipe;
}

/**
 * THE STEP COUNT A REFERENCE RENDER RUNS, matched to the file that loads.
 *
 * The Fast chip is 3 steps, for TaoMate, which is fl2v-only; with references
 * the 4-step reference build loads instead, a distillation made for another
 * count (config.js turboLora4: "a different one used wrongly"). So in the
 * Fast band (at or under turbo4MaxSteps, where that 4-step build is the file
 * that loads) a count BELOW the loaded file's own is raised to it, and the
 * caller says so: the Video screen before the render, /api/video and
 * make_clip in the reply. Nothing else moves: the 6-7 band on the 8-step
 * file and 8 on a 4-step file keep the page's own ⚠, a count at or above
 * the file's is left alone, and the text/frames path is untouched.
 *
 * @returns {{steps:number, asked:number, raised:boolean, lora:string|null, made:number|null}}
 */
export function h3MatchedSteps(eng, { steps, refs = false } = {}) {
  const asked = Number(steps ?? eng?.steps);
  if (!refs || !Number.isFinite(asked)) return { steps: asked, asked, raised: false, lora: null, made: null };
  const { turbo, use4, lora } = h3TurboLoraFor(eng, { steps: asked, refs: true });
  const made = turbo && lora ? loraStepsOf(lora) : null;
  const raised = use4 && Number.isFinite(made) && made > asked;
  return { steps: raised ? made : asked, asked, raised, lora: lora ?? null, made: made ?? null };
}

/**
 * THE STEP COUNT KEEPING A CHARACTER RUNS AT ON THIS DISK: the reference
 * speed-up file's own count (8 or 4, config.js refTurboSteps), else Standard.
 * One answer for /api/status (per engine `referenceSteps`), videoPlan (a
 * render with references that names no count) and the music video's
 * clipsteps.js. The REWIND A/B (2026-09-24, DIRECTING.md §2) kept its
 * character on the 8-step reference build at 8.
 */
export function referenceSteps(eng) {
  if (eng?.refTurboSteps === 8 || eng?.refTurboSteps === 4) return eng.refTurboSteps;
  return eng?.stepDefaults?.standard ?? eng?.steps ?? null;
}

/**
 * The sampler under "auto", per path. A saved explicit sampler always wins.
 *
 *   reference path  res_multistep, measured: Hex Appeal's 31 v2 scenes and the
 *                   REWIND A/B's winning arm (2026-09-24). Euler reached it with
 *                   88056dc (2026-09-21) as the publisher's recipe, never
 *                   measured here.
 *   fl2v turbo      LightX2V's 4/8-step builds: Euler, their published Comfy
 *                   recipe (not measured here).
 *   TaoMate 3-step, the bare model: res_multistep, their measured sampler.
 */
export function h3SamplerFor(eng, opts = {}) {
  if (eng.sampler && eng.sampler !== "auto") return eng.sampler;
  if (opts.refs) return "res_multistep";
  const { turbo, use3, lora } = h3TurboLoraFor(eng, opts);
  const actualThreeStep = use3 && lora !== eng.turboLora4;
  return turbo && !actualThreeStep ? "euler" : "res_multistep";
}

/**
 * The sigma-shift pair a render runs at, and which rule chose it.
 *
 *   panel  an explicit turboShiftVideo/Audio (> 0) — somebody moved the knob
 *   lora   the shift the loaded LoRA was distilled at (config turboShiftByLora)
 *   base   the model's own shiftVideo/shiftAudio — always, on the quality path
 *
 * Video and audio are decided separately, so a panel that set only the video
 * shift still gets the LoRA's audio shift rather than the base one.
 */
export function h3SigmaShiftFor(eng, { steps, refs = false } = {}) {
  const { turbo, lora } = h3TurboLoraFor(eng, { steps, refs });
  const trained = (turbo && lora && eng.turboShiftByLora?.[lora]) || null;
  const choose = (panel, mine, base) => (turbo && panel > 0) ? [panel, "panel"]
    : (trained && mine > 0) ? [mine, "lora"] : [base, "base"];
  const [video, source] = choose(eng.turboShiftVideo, trained?.video, eng.shiftVideo);
  const [audio, sourceAudio] = choose(eng.turboShiftAudio, trained?.audio, eng.shiftAudio);
  return { video, audio, turbo, lora, source, sourceAudio };
}

/**
 * SaveVideo's encode inputs.
 *
 * `codec: "auto"` hands ComfyUI's PyAV writer no CRF, so libx264 uses its
 * default 23 — MEASURED 1.0 Mbit/s on a 1344x768 H3 clip, which is a large
 * part of "blurry" (config.js, saveCrf). The nested inputs are addressed the
 * way ComfyUI's API format addresses a DynamicCombo's children: dotted, parent
 * first (`codec.encoding`, then `codec.encoding.crf` — _io.py's
 * finalize_prefix, the same rule as `ref_images.ref_image_0` below). Only the
 * "re-encode" mode carries a CRF; "auto" would silently drop it. An unset or
 * zero saveCrf keeps the old node byte for byte.
 */
export function saveEncode(eng) {
  const crf = Number(eng?.saveCrf ?? config.video?.saveCrf);
  if (!(crf > 0)) return { format: "auto", codec: "auto" };
  return { format: "auto", codec: "h264", "codec.encoding": "re-encode", "codec.encoding.crf": crf };
}

export function videoGraphH3({ prompt, seed, seconds, width, height, steps,
                               firstFrame, lastFrame, loop, keepAudio,
                               refImages, refAudios, audioTrack, continueFrom = null,
                               bridge = undefined, bridgeAlpha = undefined, prefix = "clip",
                               /* VIDEO-TO-VIDEO. `controlVideo` is a file the engine can
                                * open by name; `controlPatch` is the union patch from the
                                * catalogue (videoH3FunControl). Both or neither — the door
                                * refuses a control video with no patch rather than
                                * rendering as if none had been asked for. */
                               controlVideo = null, controlPatch = null,
                               controlStrength = 1.0, controlStart = 0.0, controlEnd = 1.0,
                               /* The person's own LoRAs, [{name, strength}]: after
                                * the turbo LoRA, before the control patch. */
                               loras = null,
                               /* Files the person named instead of this engine's own
                                * ({dit, ditRef, textEncoder, videoVae, audioVae}). Merged
                                * LAST so one named part replaces one part and the rest of
                                * the engine is untouched — see server/modelpick.js. */
                               models = null,
                               /* Which H3-family engine's settings: "h3" or "fasth3". videoGraph() passes it. */
                               engine = "h3",
                               /* "ck" wraps the model in ModelAttentionBackend (Comfy Kitchen int8), "pytorch"
                                * in the same node set to PyTorch; anything else leaves it out. NOT defaulted from
                                * config: art.js videoAttention() decides (H3 through h3Attention(), "ck" or null;
                                * FastH3 from its per-render picker, always a node); a caller that says nothing
                                * gets no node. */
                               attention = null,
                               /* H3's sparse attention for THIS render: "sol-attn" | "off", or
                                * undefined for the saved setting. Only the Fast setting takes
                                * it (h3SparseFor); art.js videoSparse() turns it into "off"
                                * where the engine lacks the node. FastH3 ignores it. */
                               sparse = undefined,
                               /* H3's block cache for THIS render: true only where the setting is on
                                * and the engine has the node (art.js videoBlockCache). h3BlockCacheFor
                                * decides whether this graph can carry it. */
                               blockCache = false }) {
  const v = { ...config.video, ...(config.video.engines[engine] || config.video.engines.h3), ...(models || {}) };
  /* A distillation with a trained schedule runs at that schedule whatever the
   * slider says: FastH3 is 8 steps, and 20 of them is not a better FastH3. */
  if (v.fixedSteps) steps = v.fixedSteps;
  const w = width ?? v.width, h = height ?? v.height;
  /* A CONTINUATION renders a window of overlap + extension frames: the
   * source's last `overlapFrames` (17k+5) are anchored at frame 0 as a native
   * guide (image batch + its audio), the model carries on for
   * `extensionFrames` (17m), and the overlap is dropped again before the save
   * — so the file that comes back is new frames only, following the source's
   * last frame. server/clipjoin.js owns the arithmetic and the join. */
  const cont = continueFrom && continueFrom.file ? continueFrom : null;
  /* THE CONDITIONING BRIDGE rides between the text conditioning (node 5) and
   * every guide, so the guides anchor into the rewritten words. A render may
   * override the panel's adapter and strength; alpha 0 or "off" leaves the
   * node out of the graph entirely — a bypass, not a no-op node. */
  const bridgeName = bridge !== undefined && bridge !== null ? String(bridge) : String(v.bridge || "off");
  const bridgeA = Number.isFinite(Number(bridgeAlpha)) ? Number(bridgeAlpha) : (Number(v.bridgeAlpha) || 0);
  const bridgeOn = !!bridgeName && bridgeName !== "off" && bridgeA > 0;
  const BASE = bridgeOn ? "77" : "5";
  const bridgeNodes = bridgeOn ? {
    77: { class_type: "AiplayH3ConditioningBridge", inputs: {
      conditioning: ["5", 0], adapter: bridgeName, alpha: Math.min(Math.max(bridgeA, 0), 1), magnitude_match: "per_token" } },
  } : {};
  const length = cont
    ? cont.overlapFrames + cont.extensionFrames
    : alignFrames(seconds ?? v.seconds, v.fps, "h3");
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
  /* SOUNDTRACK — H3's frozen-audio path, the parity twin of the LTX one.
   *
   * Two independent mechanisms, deliberately BOTH applied:
   *
   *   FREEZE — the real segment is encoded through the H3 audio VAE, its
   *   latent noise-masked to ZERO, and swapped into the AV latent through
   *   LTXVConcatAVLatent (the one stock node that emits a nested mask, and
   *   whose own description names MiniMax H3). The sampler's inpaint formula
   *   then reproduces the carried audio exactly — measured r=0.984 waveform
   *   against the VAE round trip. The output PLAYS the chosen track.
   *
   *   ANCHOR — MiniMaxH3AddGuide(audio=…) at frame 0 puts clean cond_audio
   *   rows at timestep 1.0 into the packed sequence, which is what lets the
   *   DiT actually READ the vocal while inventing the picture. Alone it only
   *   conditions (measured r=0.919 — the model re-sings); with the freeze it
   *   is the lip-sync half of the pair.
   *
   * ⚠ THE TRAP, measured before this was wired: applying SetLatentNoiseMask
   * to the already-nested AV latent freezes the VIDEO stream and leaves the
   * audio free — the exact opposite of a soundtrack — because the sampler
   * auto-fills ones for any stream a plain mask does not cover. The mask goes
   * on the PLAIN audio latent, BEFORE the concat, always.
   *
   * ⚠ The trim length is the ALIGNED frame count over fps, not the requested
   * seconds — H3 snaps length to its 17k+5 grid and the audio latent is
   * trimmed or zero-padded to THAT. */
  const sound = audioTrack && audioTrack.name ? audioTrack : null;
  const soundNodes = sound ? {
    60: { class_type: "LoadAudio", inputs: { audio: sound.name } },
    61: { class_type: "TrimAudioDuration", inputs: {
      audio: ["60", 0], start_index: Math.max(0, Number(sound.start) || 0),
      duration: length / v.fps } },
    62: { class_type: "VAEEncodeAudio", inputs: { audio: ["61", 0], vae: ["4", 0] } },
    63: { class_type: "SolidMask", inputs: { value: 0, width: 1024, height: 1024 } },
    64: { class_type: "SetLatentNoiseMask", inputs: { samples: ["62", 0], mask: ["63", 0] } },
    65: { class_type: "LTXVConcatAVLatent", inputs: { video_latent: ["5", 1], audio_latent: ["64", 0] } },
  } : {};
  // What the sampler denoises: the frozen-audio AV latent, or node 5's own.
  const LATENT = sound ? ["65", 0] : ["5", 1];
  // The audio anchor rides the conditioning chain like a frame guide does.
  const soundAnchor = (posFrom, id) => (sound ? {
    [id]: { class_type: "MiniMaxH3AddGuide", inputs: {
      positive: [posFrom, 0], audio_vae: ["4", 0], latent: ["5", 1],
      audio: ["61", 0], frame_idx: 0 } },
  } : {});

  // Audio is dropped for clips that sit under an existing song, but a clip made
  // on its own has nothing underneath it — so there it is worth keeping. A
  // soundtrack clip always defaults to keeping it: the sound is the point.
  const withAudio = keepAudio ?? (sound ? true : !v.dropAudio);
  const contFps = cont ? (Number(cont.fps) || v.fps) : v.fps;
  const contNodes = (posFrom) => (cont ? {
    70: { class_type: "LoadVideo", inputs: { file: cont.file } },
    71: { class_type: "GetVideoComponents", inputs: { video: ["70", 0] } },
    72: { class_type: "ImageFromBatch", inputs: { image: ["71", 0], batch_index: cont.frames - cont.overlapFrames, length: cont.overlapFrames } },
    ...(cont.hasAudio ? {
      73: { class_type: "TrimAudioDuration", inputs: { audio: ["71", 1], start_index: (cont.frames - cont.overlapFrames) / contFps, duration: cont.overlapFrames / contFps } },
    } : {}),
    74: { class_type: "MiniMaxH3AddGuide", inputs: {
      positive: [posFrom, 0], vae: ["3", 0], latent: ["5", 1], image: ["72", 0], frame_idx: 0,
      ...(cont.hasAudio ? { audio_vae: ["4", 0], audio: ["73", 0] } : {}),
    } },
  } : {});
  // After the decode: the window minus its hidden overlap.
  const contTail = cont ? {
    75: { class_type: "ImageFromBatch", inputs: { image: ["12", 0], batch_index: cont.overlapFrames, length: cont.extensionFrames } },
    ...(withAudio ? {
      76: { class_type: "TrimAudioDuration", inputs: { audio: ["13", 0], start_index: cont.overlapFrames / v.fps, duration: cont.extensionFrames / v.fps } },
    } : {}),
  } : {};
  const OUT_IMAGES = cont ? ["75", 0] : ["12", 0];
  const OUT_AUDIO = cont ? ["76", 0] : ["13", 0];
  /* The turbo LoRA is an 8-step distillation; at high step counts it
   * over-shoots into crunchy, flickering texture (measured — see config.js,
   * shiftVideo). Fast renders get it, quality renders run the bare model on
   * its native schedule, which is exactly the vendor's own flow. */
  const useTurbo = h3TurboLoraFor(v, { steps: steps ?? v.steps }).turbo;
  /* MATCH THE LoRA TO THE SCHEDULE. A 4-step distillation run at 8 steps is not
   * a faster model used safely, it is the wrong model — and that is exactly
   * what this did, because the name was fixed at config time before anyone knew
   * the step count. Below turbo4MaxSteps the 4-step build is the correct one. */
  // h3TurboLoraFor() above owns that rule now — one reader for this graph and
  // for the Video panel — and both lora() calls below ask it.
  /* A SEPARATE SIGMA SHIFT FOR THE TURBO PATH, and it is UNSET by default.
   *
   * At 4 steps with shift 12 the committed output IS the model's x0 prediction
   * at sigma 0.800 — res_multistep takes a plain Euler step when sigma_down is
   * 0 — so 80% of the picture arrives in a single jump. The only clean, high-
   * information image in the model's field of view at that noise level is the
   * reference, so it leans on it: measured, the opening frames of a bleeding
   * clip are the reference almost verbatim, handing over by frame 60. Shift 3
   * moves that commit to 0.500 for no extra render time, and the node is
   * already in the graph. docs/H3_REFERENCE_BLEED.md, "Fix 1".
   *
   * ⚠ GATED ON useTurbo deliberately. 12 on the QUALITY path is backed by
   * measurement — the bare model at 20 steps with shift 12 was the cleanest arm
   * on both seeds tried — and must not move with it.
   *
   * ⚠ AND UNSET BY DEFAULT: with no turboShiftVideo in config, these fall
   * through to exactly what this graph built before, so the change is
   * byte-identical until somebody deliberately moves the knob. The Video panel
   * and the video_setting tool expose it; server/videolab/catalog.js carries
   * the reason a person reads before moving it. */
  /* ...AND SINCE 2026-09-12 THE LoRA DECIDES THE REST OF IT. With no panel
   * value the shift is the one the loaded distillation was trained at (config
   * turboShiftByLora) — for the 4-step fl2v build that is 6, not the 12 every
   * fast render here had run at. Which LoRA loads depends on the path, so the
   * reference question is answered here, ahead of the shift, and the branch
   * below reuses these two lists. h3SigmaShiftFor() is the single reader. */
  const refImgs = (Array.isArray(refImages) ? refImages : []).filter(Boolean).slice(0, 9);
  const refAuds = (Array.isArray(refAudios) ? refAudios : [])
    .filter((a) => a && a.name).slice(0, 3);
  const onRefPath = refImgs.length > 0 || refAuds.length > 0;
  const shift = h3SigmaShiftFor(v, { steps: steps ?? v.steps, refs: onRefPath });
  const sampler = h3SamplerFor(v, { steps: steps ?? v.steps, refs: onRefPath });
  const shiftV = shift.video, shiftA = shift.audio;
  /* SPARSE ATTENTION: FastH3's VSA always, H3's sol-attn on the Fast setting only
   * (h3SparseFor, above; config `sparseAttention` / `solAttn`). ComfyUI's templates chain
   * shift -> ModelAttentionBackend -> BlockSparseAttention; here the dense backend is
   * node 85 below, the one H3 uses, before the shift. The shift copies transformer_options
   * through, and BlockSparseAttention wraps whatever override is on the model when it is
   * applied (install_override keeps the previous one as its dense path), so the fallback
   * is the same. 81 MUST follow the shift: it turns start/end_percent into sigmas from the
   * model's model_sampling at patch time. The dense backend is the one the person picked
   * (art.js videoAttention() always names one for FastH3), never the launcher's flag. */
  /* One node 81 per graph: an engine with its own (FastH3) never takes H3's.
   * VSA and SLA take a keep percentage, sol-attn a tau (the node's DynamicCombo
   * children, addressed dotted as ref_images' are). */
  const sparseCfg = h3SparseFor(v, { steps: steps ?? v.steps, refs: onRefPath, sparse,
    continuation: !!cont, control: !!(controlVideo && controlPatch) });
  const sparseNodes = sparseCfg ? {
    81: { class_type: "BlockSparseAttention", inputs: { model: ["6", 0],
      selection: sparseCfg.method,
      ...(sparseCfg.keepPercent != null ? { "selection.keep_percent": sparseCfg.keepPercent } : {}),
      ...(sparseCfg.tau != null ? { "selection.tau": sparseCfg.tau } : {}),
      start_percent: sparseCfg.startPercent, end_percent: sparseCfg.endPercent, dense_blocks: "",
      min_tokens: sparseCfg.minTokens, extra_tokens: sparseCfg.extraTokens,
      sink_conditioning: sparseCfg.sinkConditioning, verbose: false } },
  } : {};
  /* THE BLOCK CACHE sits where 81 would, after the shift (its start/end percent
   * are sampling progress), and only where 81 is absent: the node refuses to
   * run beside BlockSparseAttention. */
  const cacheCfg = h3BlockCacheFor(v, { blockCache, refs: onRefPath, continuation: !!cont,
    control: !!(controlVideo && controlPatch), sparse: sparseCfg });
  const cacheNodes = cacheCfg ? {
    82: { class_type: cacheCfg.node, inputs: { model: ["6", 0],
      residual_diff_threshold: cacheCfg.threshold, start_percent: cacheCfg.startPercent,
      end_percent: cacheCfg.endPercent, max_consecutive_hits: cacheCfg.maxConsecutiveHits,
      cache_device: cacheCfg.cacheDevice, metric_stride: cacheCfg.metricStride, verbose: false } },
  } : {};
  const SAMPLE_MODEL = sparseCfg ? ["81", 0] : cacheCfg ? ["82", 0] : ["6", 0];
  /* ── VIDEO-TO-VIDEO ──────────────────────────────────────────────────────
   *
   * A control video drives the render frame by frame instead of one opening
   * picture: depth, canny, pose, HED or MLSD taken off real footage, so a take
   * can be re-rendered in another style with its motion and blocking kept.
   *
   * The frames are scaled to the render frame with `crop: "center"` rather than
   * stretched — control footage of a different aspect ratio would otherwise
   * arrive skewed, and a skewed depth map steers the picture skewed.
   */
  const useControl = !!(controlVideo && controlPatch);
  const controlNodes = useControl ? {
    30: { class_type: "LoadVideo", inputs: { file: String(controlVideo) } },
    31: { class_type: "GetVideoComponents", inputs: { video: ["30", 0] } },
    32: { class_type: "ImageScale",
          inputs: { image: ["31", 0], upscale_method: "bilinear", width: w, height: h, crop: "center" } },
    33: { class_type: "ModelPatchLoader", inputs: { name: String(controlPatch) } },
  } : {};
  /* Apply the person's LoRAs after turbo distillation (or the bare model on
   * the quality path). Loading the stack at every step count does not prove
   * that an arbitrary adapter is compatible with that sampling recipe. */
  const userLoraNodes = {};
  const BARE_MODEL = chainVideoLoras(userLoraNodes, useTurbo ? ["18", 0] : ["1", 0], loras);
  /* ⚠ THE PATCH GOES BETWEEN THE LoRA AND THE SHIFT. The shift feeds both the
   * guider AND the scheduler, so patching after it leaves the scheduler on an
   * unpatched model; patching before the LoRA puts the distillation on top of
   * the control rather than under it. */
  const controlApply = useControl ? {
    34: { class_type: "MiniMaxH3FunControlNetApply",
          inputs: { model: BARE_MODEL, model_patch: ["33", 0], vae: ["3", 0],
                    strength: Number(controlStrength), start_percent: Number(controlStart),
                    end_percent: Number(controlEnd), control_video: ["32", 0] } },
  } : {};
  /* ⚠ THE ATTENTION NODE WRAPS THE MODEL AFTER EVERYTHING THAT PATCHES IT —
   * turbo LoRA, the person's LoRAs, the Fun-ControlNet — and before the sigma
   * shift, because the shift feeds BOTH the guider and the scheduler; patching
   * after it would leave one of them on the dense-attention model. Node 85:
   * refs take 40-48, audio refs 50+2i, continuation 70-77, FastH3's sparse node 81,
   * user LoRAs 90+.
   *
   * "ck" is Comfy Kitchen; "pytorch" is an EXPLICIT PyTorch node, which only an
   * engine with a per-render picker asks for (FastH3, art.js videoAttention()):
   * without it the dense part runs under whatever attention the launcher
   * started ComfyUI with. h3Attention() never says "pytorch", so H3's graphs,
   * and the cache keys hashed from them, are unchanged. Anything else: no node. */
  const backend = { ck: "comfy kitchen attention", pytorch: "pytorch attention" }[attention] || null;
  const attentionNodes = backend ? {
    85: { class_type: "ModelAttentionBackend",
          inputs: { model: useControl ? ["34", 0] : BARE_MODEL, attention: backend } },
  } : {};
  const MODEL = backend ? ["85", 0] : useControl ? ["34", 0] : BARE_MODEL;
  const lora = (name = h3TurboLoraFor(v, { steps: steps ?? v.steps }).lora) => (useTurbo ? {
    18: {
      class_type: "LoraLoaderModelOnly",
      inputs: { model: ["1", 0], lora_name: name, strength_model: v.loraStrength ?? 1.0 },
    },
  } : {});

  /* REFERENCES — the ref2va path, `MiniMaxH3ReferenceToVideo`.
   *
   * Pictures and audio the prompt can call by name: <Picture 1>, <Audio 2> —
   * ordinals are 1-based per type, in the order given here. Unlike a first
   * frame, a reference is not pinned anywhere: the model is free to put the
   * pictured subject in a new scene, which is the whole point. Verified on the
   * local checkpoint before this was wired: a paint figure from a square cover
   * danced on a beach it had never seen, identity intact (125 s at 864x480).
   *
   * Caps are the node's own: 9 images, 3 audio clips. The dotted input names
   * (`ref_images.ref_image_0`) are how ComfyUI's API format addresses an
   * Autogrow input's children — 0-based, though the PROMPT tags are 1-based.
   *
   * First/last frames still work alongside references, but through a different
   * door: `MiniMaxH3AddGuide` anchors them at a pixel frame (0 and -1) on the
   * conditioning the reference node produced. One consequence worth knowing:
   * on this path the text encoder does not SEE the anchored frames (it does
   * see every reference), so a prompt cannot name the opening frame — it can
   * only name references. */
  if (onRefPath) {
    const g = {
      ...img(firstFrame, 16),
      ...img(lastFrame, 17),
      // The ref2va checkpoint — built for reference conditioning — and its own
      // turbo distillation on the fast path. Both fall back to the fl2va set.
      1: unetNode(v.ditRef ?? v.dit),
      ...lora(h3TurboLoraFor(v, { steps: steps ?? v.steps, refs: true }).lora),
      ...userLoraNodes,
      2: clipNode(v.textEncoder, "minimax"),
      3: { class_type: "VAELoader", inputs: { vae_name: v.videoVae } },
      4: { class_type: "VAELoader", inputs: { vae_name: v.audioVae } },
    };
    const refInputs = {};
    refImgs.forEach((name, i) => {
      g[40 + i] = { class_type: "LoadImage", inputs: { image: name } };
      refInputs[`ref_images.ref_image_${i}`] = [String(40 + i), 0];
    });
    refAuds.forEach((a, i) => {
      g[50 + i * 2] = { class_type: "LoadAudio", inputs: { audio: a.name } };
      g[51 + i * 2] = { class_type: "TrimAudioDuration", inputs: {
        audio: [String(50 + i * 2), 0],
        start_index: Math.max(0, Number(a.start) || 0),
        duration: REF_AUDIO_SECONDS } };
      refInputs[`ref_audios.ref_audio_${i}`] = [String(51 + i * 2), 0];
    });
    g[5] = { class_type: "MiniMaxH3ReferenceToVideo", inputs: {
      clip: ["2", 0], vae: ["3", 0], audio_vae: ["4", 0],
      /* `ref_image_size` was hardcoded to "match" and was never a measured
       * choice. It matters more than it looks: "match" scales each reference to
       * the GENERATION's pixel area, which lands its tokens on a latent grid
       * with coordinates identical to every target frame — and identical
       * spatial coordinates plus the closest possible time offset is exactly
       * the geometry a copy-the-token-one-step-back attention head exploits.
       * The node's own tooltip says "max" gives the best identity fidelity.
       * Exposed as a knob rather than flipped: "max" pushes far more tokens
       * through 50 blocks of quadratic attention on every step, so it is not
       * free, and nothing here has measured it. Default unchanged.
       * docs/H3_REFERENCE_BLEED.md, "Things found along the way". */
      prompt, width: w, height: h, length, ref_image_size: v.refImageSize ?? "match",
      ...refInputs,
    } };
    // Anchor frames on top of the reference conditioning. Each guide takes the
    // previous positive and returns a new one, so they chain; the latent is
    // node 5's either way.
    let pos = "5";
    if (bridgeOn) {
      Object.assign(g, bridgeNodes);
      pos = "77";
    }
    if (firstFrame) {
      g[21] = { class_type: "MiniMaxH3AddGuide", inputs: {
        positive: [pos, 0], vae: ["3", 0], latent: ["5", 1], image: ["16", 0], frame_idx: 0 } };
      pos = "21";
    }
    if (lastFrame) {
      g[22] = { class_type: "MiniMaxH3AddGuide", inputs: {
        positive: [pos, 0], vae: ["3", 0], latent: ["5", 1], image: ["17", 0], frame_idx: -1 } };
      pos = "22";
    }
    if (sound) {
      Object.assign(g, soundNodes, soundAnchor(pos, 23));
      pos = "23";
    }
    if (cont) {
      Object.assign(g, contNodes(pos));
      pos = "74";
    }
    Object.assign(g, controlNodes, controlApply, attentionNodes);
    g[6] = { class_type: "MiniMaxH3SigmaShift",
      inputs: { model: MODEL, shift_video: shiftV, shift_audio: shiftA } };
    Object.assign(g, sparseNodes, cacheNodes);
    g[7] = { class_type: "BasicGuider", inputs: { model: SAMPLE_MODEL, conditioning: [pos, 0] } };
    g[8] = { class_type: "BasicScheduler", inputs: { model: SAMPLE_MODEL, scheduler: v.scheduler, steps: steps ?? v.steps, denoise: 1 } };
    g[9] = { class_type: "KSamplerSelect", inputs: { sampler_name: sampler } };
    g[10] = { class_type: "RandomNoise", inputs: { noise_seed: seed } };
    g[11] = { class_type: "SamplerCustomAdvanced",
      inputs: { noise: ["10", 0], guider: ["7", 0], sampler: ["9", 0], sigmas: ["8", 0], latent_image: LATENT } };
    g[12] = { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["3", 0] } };
    g[13] = { class_type: "VAEDecodeAudio", inputs: { samples: ["11", 0], vae: ["4", 0] } };
    Object.assign(g, contTail);
    g[14] = { class_type: "CreateVideo", inputs: withAudio
      ? { images: OUT_IMAGES, fps: v.fps, audio: OUT_AUDIO }
      : { images: OUT_IMAGES, fps: v.fps } };
    g[15] = { class_type: "SaveVideo", inputs: { video: ["14", 0], filename_prefix: prefix, ...saveEncode(v) } };
    return g;
  }

  return {
    ...img(firstFrame, 16),
    ...img(lastFrame, 17),
    ...controlNodes,
    ...controlApply,
    ...attentionNodes,
    1: unetNode(v.dit),
    /* THE TURBO LoRA — fast path only (see `useTurbo` above). History: it was
     * named in config from day one and never loaded; then loaded always; now
     * loaded only in its 8-step distillation range, because at 20 steps it
     * measurably over-shoots (crunchy texture, 2-3x inter-frame churn) while
     * the bare model on shift 12 — the vendor's own flow — is the clean one. */
    ...lora(),
    ...userLoraNodes,
    // `type: "minimax"` covers BOTH H3 and Music3 — comfy/sd.py auto-detects
    // which by looking for an audio-decoder projection in the checkpoint.
    2: clipNode(v.textEncoder, "minimax"),
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
    // The soundtrack pair — freeze nodes plus the frame-0 anchor on the
    // conditioning. See the block comment above the refs branch.
    ...soundNodes,
    ...bridgeNodes,
    ...soundAnchor(BASE, 23),
    ...contNodes(sound ? "23" : BASE),
    // The unswept knob. Applied to BOTH the guider and the scheduler, exactly as
    // the node's own docstring describes: the video shift drives the sampler's
    // sigma schedule and both values are handed to the DiT.
    6: {
      class_type: "MiniMaxH3SigmaShift",
      // The LoRA'd model on the fast path, the bare one on the quality path.
      inputs: { model: MODEL, shift_video: shiftV, shift_audio: shiftA },
    },
    ...sparseNodes,
    ...cacheNodes,
    7: { class_type: "BasicGuider", inputs: { model: SAMPLE_MODEL, conditioning: [cont ? "74" : sound ? "23" : BASE, 0] } },
    8: { class_type: "BasicScheduler", inputs: { model: SAMPLE_MODEL, scheduler: v.scheduler, steps: steps ?? v.steps, denoise: 1 } },
    9: { class_type: "KSamplerSelect", inputs: { sampler_name: sampler } },
    10: { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    11: {
      class_type: "SamplerCustomAdvanced",
      inputs: { noise: ["10", 0], guider: ["7", 0], sampler: ["9", 0], sigmas: ["8", 0], latent_image: LATENT },
    },

    12: { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["3", 0] } },
    13: { class_type: "VAEDecodeAudio", inputs: { samples: ["11", 0], vae: ["4", 0] } },
    // H3 always renders audio and there is no video-only path. For a clip that
    // sits under a song we already made it is discarded — but it still has to be
    // DECODED, because the sampler produced it either way.
    ...contTail,
    14: {
      class_type: "CreateVideo",
      inputs: withAudio
        ? { images: OUT_IMAGES, fps: v.fps, audio: OUT_AUDIO }
        : { images: OUT_IMAGES, fps: v.fps },
    },
    15: { class_type: "SaveVideo", inputs: { video: ["14", 0], filename_prefix: prefix, ...saveEncode(v) } },
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
                                firstFrame, lastFrame, midFrames, loop, keepAudio,
                                audioTrack, guidance, guideStrength, baseScale, prefix = "clip",
                                /* As videoGraphH3: the parts a person named. */
                                models = null,
                                /* The person's own LoRAs; both passes sample through them. */
                                loras = null }) {
  const v = { ...config.video.engines.ltx, ...(models || {}) };
  const userLoraNodes = {};
  const MODEL = chainVideoLoras(userLoraNodes, ["1", 0], loras);
  const fps = v.fps;
  const frames = alignFrames(seconds ?? v.seconds, fps, "ltx");

  /* SOUNDTRACK — real audio in, video generated ON it (the vendor's ia2v flow).
   *
   * The segment is encoded through the audio VAE and its latent is given to the
   * sampler with a noise mask of ZERO — inpainting semantics: the audio stream
   * is never denoised, it is ground truth the video stream attends to. Both
   * passes freeze against the same clean encoded latent.
   *
   * Measured before wiring (2026-08-24): the render's soundtrack decodes to the
   * round-tripped source segment — mel-spectral r=0.995, waveform r=0.93
   * against the VAE round trip. ⚠ Do not judge this path by raw waveform
   * correlation against the ORIGINAL file: the audio VAE reconstructs phase
   * generatively, so even a perfect round trip scores ~0.09 on waveforms while
   * being the same music (mel r≈0.82 is the round-trip ceiling). */
  const sound = audioTrack && audioTrack.name ? audioTrack : null;
  const soundNodes = sound ? {
    40: { class_type: "LoadAudio", inputs: { audio: sound.name } },
    41: { class_type: "TrimAudioDuration", inputs: {
      audio: ["40", 0], start_index: Math.max(0, Number(sound.start) || 0),
      duration: frames / fps } },
    42: { class_type: "LTXVAudioVAEEncode", inputs: { audio: ["41", 0], audio_vae: ["4", 0] } },
    // The mask geometry is arbitrary — sampling reshapes it to the latent.
    43: { class_type: "SolidMask", inputs: { value: 0, width: 1024, height: 1024 } },
    44: { class_type: "SetLatentNoiseMask", inputs: { samples: ["42", 0], mask: ["43", 0] } },
  } : {};
  // What the concats read as "the audio stream": the frozen real segment, or
  // the empty latent the model fills with its own invented sound.
  const AUD = sound ? ["44", 0] : ["10", 0];

  /* Pass 1 runs at half the final size, and the upsampler doubles it back.
   * Both axes are floored to a multiple of 32 first: the latent grid is 32px,
   * so an odd request silently lands somewhere else. Doing it here means the UI
   * can show the size the user will actually get. */
  const q = (n) => Math.max(32, Math.floor(n / 2 / 32) * 32);
  const lowW = q(width ?? v.width), lowH = q(height ?? v.height);

  /* ⚠ THE UPSCALER IS WHERE FACES GO SOFT, and the two paths through this graph
   * do not agree about whether it runs.
   *
   * LTXVLatentUpsampler is a fixed x2 in latent space, so pass 1 must be exactly
   * half the delivered size — the ratio is not a free parameter. At a 1344x768
   * delivery that means a face in a medium shot is sampled around 40px wide and
   * then doubled, and doubling does not put back identity that was never
   * sampled.
   *
   * The GUIDED path already avoids this entirely: the vendor's first/last
   * template is single pass at full size with no upsampler at all. So a clip
   * pinned between two board frames is not merely better guided, it is rendered
   * at twice the linear resolution — which nothing in this file said out loud,
   * and which means `loop: false` on a board-pinned clip silently halves the
   * sampling resolution while looking like a purely temporal choice.
   *
   * `baseScale: "full"` gives an UNGUIDED clip the same deal: sample once at the
   * delivered size and skip the upscale. Same 8-step schedule the guided path
   * uses, so this is the vendor's own single-pass shape rather than an invention
   * — it costs roughly the two-pass saving and buys the sampled detail. */
  /* (declared just below `guided`, which this depends on) */

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
  // Single pass at the delivered size, no upsampler: always for a guided run,
  // and on request for an unguided one. See the note above lowW.
  const onePass = guided || baseScale === "full";

  /* WAYPOINTS — pictures the clip passes THROUGH, between the two ends.
   *
   * ⚠ These are not style references, and calling them that would mislead.
   * `LTXVAddGuide` pins a picture AT a frame: measured across four strengths,
   * on and off the guide grid, it either replaces that frame or does nothing.
   * There is no partial blend on this path, which is exactly why the Reactive
   * page runs on a different engine.
   *
   * They are also capped. A guide every few frames leaves the sampler no room
   * to move anything and the clip degrades into a crossfade of stills — that is
   * measured too, at 27 guides over 121 frames. Four across a clip is roughly
   * the density the reference implementations use. */
  const mids = (Array.isArray(midFrames) ? midFrames : []).filter(Boolean).slice(0, 4);

  /* Load each distinct picture once. When both ends are the same file — which is
   * what a loop IS — node 30 is reused rather than decoding the same image twice. */
  const img = {
    ...(firstFrame ? { 30: { class_type: "LoadImage", inputs: { image: firstFrame } } } : {}),
    ...(endFrame && endFrame !== firstFrame
      ? { 31: { class_type: "LoadImage", inputs: { image: endFrame } } } : {}),
  };
  const endNode = endFrame ? (endFrame === firstFrame ? "30" : "31") : null;
  /* What the CLOSING guide chains from: the last waypoint if there is one, or
   * the opening guide if there is not. */
  const MID_TAIL = mids.length ? String(300 + (mids.length - 1) * 10 + 2) : "35";
  const midImg = {};
  mids.forEach((name, i) => { midImg[300 + i * 10] = { class_type: "LoadImage", inputs: { image: name } }; });
  return {
    ...img,
    ...(guided ? midImg : {}),
    1: unetNode(v.dit),
    ...userLoraNodes,
    2: clipNode(v.textEncoder, "ltxv"),
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
      width: onePass ? (width ?? v.width) : lowW,
      height: onePass ? (height ?? v.height) : lowH,
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
      /* Evenly spaced strictly BETWEEN the ends, so a waypoint can never land on
       * frame 0 or the last frame and quietly fight the picture already pinned
       * there. Threaded in order: each guide rewrites the conditioning as well
       * as the latent, so all three outputs carry forward. */
      ...Object.fromEntries(mids.flatMap((_, i) => {
        const at = Math.round((frames * (i + 1)) / (mids.length + 1));
        const p = 300 + i * 10, pre = p + 1, g = p + 2;
        const from = i === 0 ? "35" : String(300 + (i - 1) * 10 + 2);
        return [
          [pre, { class_type: "LTXVPreprocess", inputs: { image: [String(p), 0], img_compression: 18 } }],
          [g, { class_type: "LTXVAddGuide", inputs: {
            positive: [from, 0], negative: [from, 1], vae: ["3", 0], latent: [from, 2],
            image: [String(pre), 0], frame_idx: at, strength: guideStrength ?? 0.7 } }],
        ];
      })),
      36: { class_type: "LTXVPreprocess", inputs: { image: [endNode, 0], img_compression: 18 } },
      37: { class_type: "LTXVAddGuide", inputs: {
        positive: [MID_TAIL, 0], negative: [MID_TAIL, 1], vae: ["3", 0], latent: [MID_TAIL, 2],
        // -1 is the last frame. The same picture at both ends is the loop.
        image: ["36", 0], frame_idx: -1, strength: guideStrength ?? 0.7 } },
    } : {}),
    ...(sound ? soundNodes : {
      10: { class_type: "LTXVEmptyLatentAudio", inputs: { frames_number: frames, frame_rate: fps, batch_size: 1, audio_vae: ["4", 0] } },
    }),
    11: { class_type: "LTXVConcatAVLatent", inputs: {
      video_latent: guided ? ["37", 2] : [firstFrame ? "32" : "9", 0], audio_latent: AUD } },

    // ---- pass 1: 8 steps at half size ------------------------------------
    12: { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    13: { class_type: "KSamplerSelect", inputs: { sampler_name: v.sampler } },
    14: { class_type: "ManualSigmas", inputs: { sigmas: v.sigmasLow } },
    15: { class_type: "LTXVDualCFGGuider", inputs: { model: MODEL,
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
    ...(onePass ? {} : {
      18: { class_type: "LTXVLatentUpsampler", inputs: { samples: ["17", 0], upscale_model: ["5", 0], vae: ["3", 0] } },
      // Pass 2's audio: normally pass 1's own output continues denoising; with a
      // soundtrack it re-freezes against the same clean encoded latent, so the
      // second pass cannot drift what the first pass held exact.
      19: { class_type: "LTXVConcatAVLatent", inputs: { video_latent: ["18", 0], audio_latent: sound ? AUD : ["17", 1] } },
    }),

    // ---- pass 2: 3 steps at full size, starting from 0.85 -----------------
    ...(onePass ? {} : {
      20: { class_type: "RandomNoise", inputs: { noise_seed: (seed ?? 0) + 1 } },
      21: { class_type: "KSamplerSelect", inputs: { sampler_name: v.sampler } },
      22: { class_type: "ManualSigmas", inputs: { sigmas: v.sigmasHigh } },
      23: { class_type: "LTXVDualCFGGuider", inputs: { model: MODEL, positive: ["8", 0], negative: ["8", 1], video_cfg: guidance ?? v.videoCfg, audio_cfg: guidance ?? v.audioCfg } },
      24: { class_type: "SamplerCustomAdvanced", inputs: { noise: ["20", 0], guider: ["23", 0], sampler: ["21", 0], sigmas: ["22", 0], latent_image: ["19", 0] } },
      25: { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["24", 0] } },
    }),

    // ---- decode ----------------------------------------------------------
    // (node 25 lives in the pass-2 block above — a guided run has no pass 2, and
    //  a duplicate here would resurrect it and dangle a link to node 24.)
    26: { class_type: "VAEDecodeTiled", inputs: { samples: guided ? ["38", 2] : (onePass ? ["17", 0] : ["25", 0]), vae: ["3", 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 16 } },
    27: { class_type: "LTXVAudioVAEDecode", inputs: { samples: [onePass ? "17" : "25", 1], audio_vae: ["4", 0] } },
    // LTX renders real audio. A clip under an existing song discards it; a
    // standalone one keeps it, because otherwise it has no sound at all. A
    // soundtrack clip ALWAYS keeps it — the sound is the point.
    28: {
      class_type: "CreateVideo",
      inputs: (keepAudio ?? (sound ? true : !v.dropAudio))
        ? { images: ["26", 0], audio: ["27", 0], fps }
        : { images: ["26", 0], fps },
    },
    29: { class_type: "SaveVideo", inputs: { video: ["28", 0], filename_prefix: prefix, ...saveEncode(v) } },
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

/* Words that repeat in every song and say nothing about this one. */
const LYRIC_STOP = new Set(("i me my mine myself you your yours we us our they them their he him his she her it its "
  + "a an the and or but so if of to in on at by for from with into over under up down out off as than then "
  + "is am are was were be been being do does did have has had will would can could should shall may might must "
  + "this that these those there here what when where why how who which all any some no not just only now too very "
  + "oh ooh ah yeah yea hey la na da whoa uh huh mm hmm baby gonna wanna gotta got get let lets cause cos "
  + "im youre were theyre dont cant wont aint thats its ive youve id youll ill").split(" "));

/**
 * THE SONG'S HOOK: the line it repeats most, else the word it repeats most.
 *
 * A cover drawn from the style caption says what the song SOUNDS like; the
 * chorus says what it is ABOUT, and it is the line a listener remembers. So a
 * song with lyrics is illustrated from the line it sings most often (two or
 * more words, sung at least twice), and failing that from its most repeated
 * word that means something (four letters or more, at least twice, not a
 * pronoun or a filler). Section tags ([Chorus], (x2)) and blank lines are not
 * lyrics. An instrumental, or lyrics that repeat nothing, return null and the
 * caption decides as before.
 */
export function lyricHook(lyrics = "") {
  const lines = String(lyrics || "").split(/\r?\n/)
    .map((l) => l.replace(/\[[^\]]*\]|\((?:x\s*\d+|\d+\s*x|repeat[^)]*)\)/gi, "").trim())
    .filter((l) => l && !/^\(?instrumental\)?$/i.test(l));
  const key = (l) => l.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, "").replace(/'/g, "").replace(/\s+/g, " ").trim();

  const lineCount = new Map();
  const firstForm = new Map();
  for (const l of lines) {
    const k = key(l);
    if (k.split(" ").length < 2) continue;
    lineCount.set(k, (lineCount.get(k) || 0) + 1);
    if (!firstForm.has(k)) firstForm.set(k, l.replace(/[.,;:!?…]+$/u, ""));
  }
  let best = null;
  for (const [k, n] of lineCount) {
    // Most repeats wins; a tie goes to the line sung first (Map keeps order).
    if (n >= 2 && (!best || n > best.n)) best = { k, n };
  }
  if (best) return trimTo(firstForm.get(best.k), 80);

  const wordCount = new Map();
  for (const l of lines) {
    for (const w of key(l).split(" ")) {
      if (w.length < 4 || LYRIC_STOP.has(w) || /^\d+$/.test(w)) continue;
      wordCount.set(w, (wordCount.get(w) || 0) + 1);
    }
  }
  let word = null;
  for (const [w, n] of wordCount) if (n >= 2 && (!word || n > word.n)) word = { w, n };
  return word ? word.w : null;
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
export function coverPrompt({ caption = "", title = "", seed = 0, lyrics = "" }) {
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
  /* The hook first: what the song keeps singing is what it is about. The
   * style half stays config.art.style, whose "no text, no words" is what keeps
   * the image model from lettering the line onto the picture. */
  const mood = lyricHook(lyrics) || subject || usableTitle || pick;
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

/* ─────────────────────── STRUCTURAL CONTROL: pose and VACE ─────────────────
 *
 * Re-exports, and nothing else. The builders themselves live in server/control/
 * — control.js (the three-numbers gate and a temporary engine client), pose.js
 * (DWPose extraction) and vace.js (WAN 2.1 VACE) — because they are a coherent
 * subsystem with its own README, its own tests and its own licence problem, and
 * because this file is already 2,200 lines of a different job.
 *
 * They are surfaced HERE so the mv strand can import structural control the
 * same way it imports every other graph builder, without reaching across
 * directories and without this file growing a fourth video engine.
 *
 * WHAT THESE BUILD, in one sentence each:
 *   controlVaceGraph   the graph that carries a Blender-blocked camera move.
 *                      Measured: CMA 0.924, MR 0.82, SSIM_block 0.524 against a
 *                      0.736 reconstruction bar — generated, not copied.
 *                      (output/vace/gate_report.json, arm W1, 2026-09-03.)
 *   controlPoseGraph   the DWPose extraction that turns a performance clip into
 *                      the skeleton a VACE render can be steered by. Measured
 *                      end to end on 2026-09-03: the render's joints land
 *                      33.7 px from the control's at mean per-joint r 0.893,
 *                      against a frozen-skeleton null of 119.9 px and a
 *                      time-reversed null of 157.3 px. POSE_GATE carries that
 *                      result AND its four caveats — read them before quoting
 *                      the number: DWPose could not see 43 of the 121 output
 *                      frames, and the source clip has no legs in it.
 *
 * ⚠ THE LICENCE IS HALF SETTLED, AND THE HALVES ARE DIFFERENT ANSWERS. As of
 * 2026-09-03 both models are catalogued (server/models.js: `videoControl` and
 * `posePreprocess`) and NOTICE is generated from those rows, so a licence does
 * now travel with them — which it did not when this block was written.
 *
 * WAN 2.1 VACE is VERIFIED: VACE_LICENCE_VERIFIED is true, its LICENSE.txt was
 * diffed against canonical Apache-2.0 with zero differences, and a clip is the
 * user's to sell. THE DWPOSE ESTIMATOR IS NOT: `posePreprocess` ships with
 * outputRights.class "unknown" and sellable null, because its redistributor
 * publishes a 28-byte model card and no LICENSE file. So a surface that put
 * both behind one licence sentence would be overstating the pose half. Read the
 * block at the top of server/control/vace.js, and the entry note in
 * server/models.js, before putting these behind a button. */
export {
  validateControlClip, judgeClip, CONTROL_SPEC,
} from "./control/control.js";
export {
  poseGraph as controlPoseGraph, poseResolution as controlPoseResolution,
  DWPOSE_MODELS, POSE_GATE,
} from "./control/pose.js";
export {
  vaceGraph as controlVaceGraph, vaceSizeFor,
  VACE_SIZE, VACE_PRESET, VACE_WEIGHTS, VACE_OPERATING_POINT,
  VACE_STRENGTH_LADDER, VACE_LICENCE, VACE_LICENCE_VERIFIED,
} from "./control/vace.js";
