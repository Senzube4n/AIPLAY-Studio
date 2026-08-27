/**
 * What IS this file? Architecture detection from a safetensors header alone.
 *
 * Ported from ComfyUI 0.33.0's own comfy/model_detection.py and
 * supported_models.py, so the answer agrees with what ComfyUI will actually do
 * with the file rather than with a filename convention. Filenames lie: two of
 * the checkpoints on this rig announce nothing about their architecture, and
 * one of them ("zimageTurboByStable_2603NVFP4") is a DiT that CheckpointLoader
 * cannot load at all.
 *
 * READ-ONLY, and cheap: only the JSON header is read, never the weights, so a
 * 6 GB file answers in single-digit milliseconds. Nothing here writes.
 */
import fs from "node:fs";
import path from "node:path";

const MAX_HEADER = 100e6;

export async function readHeader(file) {
  const fh = await fs.promises.open(file, "r");
  try {
    const lenBuf = Buffer.alloc(8);
    await fh.read(lenBuf, 0, 8, 0);
    const n = Number(lenBuf.readBigUInt64LE(0));
    if (!(n > 0 && n < MAX_HEADER)) throw new Error(`implausible header length ${n}`);
    const buf = Buffer.alloc(n);
    await fh.read(buf, 0, n, 8);
    const t0 = process.hrtime.bigint();
    const json = JSON.parse(buf.toString("utf8"));
    const parseMs = Number(process.hrtime.bigint() - t0) / 1e6;
    return { json, headerBytes: n, parseMs };
  } finally { await fh.close(); }
}

/**
 * WHICH BASE a LoRA is for — and why getting this wrong is expensive.
 *
 * A LoRA is a low-rank delta keyed by module name and sized to one
 * architecture's dimensions. ComfyUI's LoraLoader matches keys and SKIPS what
 * does not match, so an SDXL LoRA applied to FLUX raises no error and has no
 * effect: the picture renders, the style never arrives, and nothing says why.
 * A silent no-op is the worst failure a creative tool can have, which is why
 * this is worth reading properly rather than guessing from a filename.
 *
 * The method is to strip the LoRA wrapper and reuse the SAME evidence the full
 * models are identified by — a LoRA's module names mirror its base. One
 * detection path, so a new architecture becomes recognisable in both at once.
 */
const loraStrip = (k) => k
  .replace(/^(lora_unet_|lora_te\d*_|lora_te_)/, "")
  .replace(/^(diffusion_model\.|transformer\.|model\.diffusion_model\.)/, "")
  .replace(/\.(lora_down|lora_up|lora_A|lora_B|hada_w1_a|hada_w1_b|hada_w2_a|hada_w2_b|lokr_w1|lokr_w2|alpha|diff|diff_b)(\.weight)?$/, "");

export function loraTarget(allKeys, shapes = {}) {
  const base = [...new Set(allKeys.map(loraStrip))];
  const has = (s) => base.some((k) => k.includes(s));

  if (has("double_blocks") || has("single_blocks")) return { variant: "FLUX", confidence: "certain" };
  if (has("joint_blocks")) return { variant: "SD3", confidence: "certain" };
  if (has("llm_adapter")) return { variant: "Anima", confidence: "certain" };
  if (has("cap_embedder") || has("noise_refiner")) return { variant: "Z-Image / Lumina", confidence: "certain" };
  if (has("video_patch_proj") || has("token_refiner")) return { variant: "MiniMax H3", confidence: "certain" };
  if (has("diffusion_transformer")) return { variant: "MiniMax Music", confidence: "certain" };
  if (has("txt_norm")) return { variant: "Qwen-Image", confidence: "certain" };
  if (has("adaln_single")) return { variant: "LTX", confidence: "certain" };

  if (has("input_blocks") || has("output_blocks") || has("middle_block")) {
    /* SD1.5 and SDXL are BOTH classic UNets and share their module names, so
     * the name alone cannot separate them. The cross-attention context width
     * can: `lora_down` on an attn2 to_k/to_v projects FROM the text encoder's
     * width, which is 768 on SD1.5, 1024 on SD2.x and 2048 on SDXL. */
    let ctx = null;
    for (const key of allKeys) {
      if (!/attn2[._](to_k|to_v)/.test(key)) continue;
      if (!/(lora_down|lora_A)\.weight$/.test(key)) continue;
      const sh = shapes[key];
      if (Array.isArray(sh) && sh.length === 2) { ctx = sh[1]; break; }
    }
    const byCtx = { 768: "SD1.5", 1024: "SD2.x", 2048: "SDXL" }[ctx];
    if (byCtx) return { variant: byCtx, confidence: "certain", contextDim: ctx };
    /* Readable as SD-family and no further. Said plainly rather than guessed:
     * a confident wrong answer would hide a LoRA that actually works. */
    return { variant: "SD-family (1.5 or XL — not narrowable from this file)", confidence: "family" };
  }
  return { variant: "unknown base", confidence: "none" };
}

/* ── the predicate list ─────────────────────────────────────────────────── */

export function detect(keys, shapes) {
  const has = (k) => keys.has(k);
  const hasAny = (...ks) => ks.some(has);
  // find the denoiser prefix the way ComfyUI does
  /* The denoiser is not always at the root. ComfyUI strips
   * "model.diffusion_model." ; Anima's own releases nest everything under
   * "net." instead, and without that prefix here every Anima checkpoint fell
   * through the whole predicate list to "unknown" — including one on this rig
   * that carries NO __metadata__ at all, so the tensors are the only evidence
   * there is. Longest first: a prefix that is a prefix of another must not win. */
  let P = "";
  for (const cand of ["model.diffusion_model.", "net."]) {
    if ([...keys].some((k) => k.startsWith(cand))) { P = cand; break; }
  }
  const k = (s) => P + s;
  const shape = (s) => shapes[P + s] || shapes[s] || null;
  const count = (prefix) => {           // count_blocks
    let i = 0;
    for (;;) {
      const pfx = `${P}${prefix}${i}.`;
      if (![...keys].some((x) => x.startsWith(pfx))) return i;
      i++;
    }
  };

  const companions = {
    vae: [...keys].some((x) => x.startsWith("first_stage_model.") || x.startsWith("vae.")),
    te: [...keys].some((x) => x.startsWith("cond_stage_model.") || x.startsWith("conditioner.embedders.")
                              || x.startsWith("text_encoders.")),
  };

  // --- companion-only files -------------------------------------------------
  const allKeys = [...keys];
  if (allKeys.some((x) => /\.lora_(up|down)\.weight$/.test(x) || /\.lora_[AB]\.weight$/.test(x)
                          || /\.hada_w1_a$/.test(x) || /\.lokr_w1$/.test(x))) {
    return { family: "lora", ...loraTarget(allKeys, shapes), companions };
  }
  // VAE-only: an encoder/decoder pair and no denoiser anywhere
  if (!has(k("input_blocks.0.0.weight")) && !P
      && allKeys.some((x) => x.startsWith("decoder.")) && allKeys.some((x) => x.startsWith("encoder."))
      && !allKeys.some((x) => /(double_blocks|joint_blocks|transformer_blocks|layers\.0\.attention)/.test(x))) {
    const q = shapes["decoder.conv_in.weight"] || shapes["decoder.conv_in.conv.weight"];
    const lat = q ? q[1] : null;
    const guess = { 4: "SD1.5/SDXL", 16: "SD3/FLUX.1", 32: "FLUX.2" }[lat] || "?";
    return { family: "vae", variant: `${lat ?? "?"} latent ch (${guess})`, confidence: "certain", companions };
  }
  if (has(k("encoder.lyric_encoder.layers.0.input_layernorm.weight")))
    return { family: "minimax-music3", confidence: "certain", companions };
  if (allKeys.some((x) => /^model\.layers\.0\./.test(x))) {
    const w = shapes["model.layers.0.post_attention_layernorm.weight"];
    const d = w ? w[0] : null;
    const name = { 2560: "Qwen3-4B", 2048: "Qwen3-2B", 4096: "Qwen3-8B", 1024: "Qwen3-0.6B", 5120: "Mistral-24B-class" }[d];
    return { family: "text-encoder", variant: name || `hidden ${d}`, confidence: "certain", companions };
  }
  if (allKeys.some((x) => x.startsWith("text_model."))) {
    return { family: "text-encoder", variant: "CLIP", confidence: "certain", companions };
  }

  // --- the denoiser ---------------------------------------------------------
  if (has(k("joint_blocks.0.context_block.attn.qkv.weight"))) {
    const xe = shape("x_embedder.proj.weight");
    return { family: "sd3", variant: `in_channels ${xe ? xe[1] : "?"}, depth ${count("joint_blocks.")}`,
             confidence: "certain", companions };
  }
  if (has(k("clf.1.weight"))) return { family: "stable-cascade", confidence: "certain", companions };
  if (has(k("transformer.rotary_pos_emb.inv_freq"))) return { family: "stable-audio", confidence: "certain", companions };
  if (has(k("double_layers.0.attn.w1q.weight"))) return { family: "auraflow", confidence: "certain", companions };
  if (has(k("mlp_t5.0.weight"))) return { family: "hunyuan-dit", confidence: "certain", companions };
  if (has(k("txt_in.individual_token_refiner.blocks.0.norm1.weight")))
    return { family: "hunyuan-video", confidence: "certain", companions };

  // FLUX family gate
  if (hasAny(k("double_blocks.0.img_attn.norm.key_norm.weight"), k("double_blocks.0.img_attn.norm.key_norm.scale"))
      && (has(k("img_in.weight")) || hasAny(k("distilled_guidance_layer.norms.0.weight"), k("distilled_guidance_layer.norms.0.scale")))) {
    const depth = count("double_blocks."), single = count("single_blocks.");
    if (has(k("double_stream_modulation_img.lin.weight"))) {
      const w = shape("img_in.weight");
      return { family: "flux2", variant: `depth ${depth}/${single}, hidden ${w ? w[0] : "?"}, in_ch ${w ? w[1] : "?"}`,
               confidence: "certain", companions };
    }
    if (hasAny(k("distilled_guidance_layer.0.norms.0.weight"), k("distilled_guidance_layer.norms.0.weight"),
               k("distilled_guidance_layer.0.norms.0.scale"), k("distilled_guidance_layer.norms.0.scale"))) {
      return { family: hasAny(k("nerf_blocks.0.norm.weight"), k("nerf_blocks.0.norm.scale")) ? "chroma-radiance" : "chroma",
               variant: `depth ${depth}/${single}`, confidence: "certain", companions };
    }
    const w = shape("img_in.weight");
    const inCh = w ? w[1] / 4 : null;
    const guidance = has(k("guidance_in.in_layer.weight"));
    const flavour = inCh === 96 ? "Fill (inpaint)" : inCh === 32 ? "Depth/Canny" : guidance ? "dev" : "schnell";
    return { family: "flux1", variant: `${flavour}, in_ch ${inCh}, depth ${depth}/${single}`,
             confidence: "certain", companions };
  }

  if (has(k("t_block.1.weight"))) return { family: "pixart", confidence: "certain", companions };
  if (has(k("video_patch_proj.weight")) && has(k("audio_patch_proj.weight")))
    return { family: "minimax-h3", confidence: "certain", companions };
  if (has(k("adaln_single.emb.timestep_embedder.linear_1.bias")))
    return { family: has(k("audio_adaln_single.linear.weight")) ? "ltx-av" : "ltx-video", confidence: "certain", companions };
  if (has(k("genre_embedder.weight"))) return { family: "ace-step", confidence: "certain", companions };
  if (has(k("head.modulation"))) return { family: "wan2.x", confidence: "certain", companions };
  if (has(k("caption_projection.0.linear.weight"))) return { family: "hidream", confidence: "certain", companions };
  if (has(k("embed_image_indicator.weight"))) return { family: "ideogram4", confidence: "certain", companions };
  if (has(k("txtfusion.projector.weight"))) return { family: "krea2", confidence: "certain", companions };
  if (has(k("core.pixel_embedder.proj.weight"))) return { family: "pixeldit-t2i", confidence: "certain", companions };

  if (has(k("blocks.0.mlp.layer1.weight"))) {
    if (has(k("llm_adapter.blocks.0.cross_attn.q_proj.weight")))
      return { family: "anima", confidence: "certain", companions };
    return { family: "cosmos-predict2", confidence: "certain", companions };
  }

  if (has(k("cap_embedder.1.weight")) && has(k("noise_refiner.0.attention.k_norm.weight"))) {
    const w = shape("cap_embedder.1.weight");
    const dim = w ? w[0] : null;
    if (dim === 3840) {
      return { family: has(k("dec_net.cond_embed.weight")) ? "zimage-pixel" : "zimage",
               variant: `dim ${dim}, layers ${count("layers.")}`, confidence: "certain", companions };
    }
    return { family: "lumina2", variant: `dim ${dim}`, confidence: "certain", companions };
  }

  if (has(k("txt_norm.weight"))) {
    const tn = shape("txt_norm.weight"), po = shape("proj_out.weight");
    if (tn && po && tn[0] === 2560 && po[0] === 128) return { family: "mage-flow", confidence: "certain", companions };
    return { family: "qwen-image", confidence: "certain", companions };
  }

  // classic UNet
  if (has(k("input_blocks.0.0.weight"))) {
    const w = shape("input_blocks.0.0.weight");
    const modelChannels = w[0], inChannels = w[1];
    const adm = shape("label_emb.0.0.weight");
    const admIn = adm ? adm[1] : null;
    // context_dim: first cross-attention's k projection
    let contextDim = null;
    for (const key of keys) {
      const m = key.match(/input_blocks\.\d+\.1\.transformer_blocks\.0\.attn2\.to_k\.weight$/);
      if (m) { contextDim = shapes[key][1]; break; }
    }
    let variant = "unknown UNet";
    if (modelChannels === 384 && admIn === 2560) variant = "SDXL refiner";
    else if (admIn === 2816 && contextDim === 2048) variant = "SDXL";
    else if (admIn === null && contextDim === 1024) variant = "SD2.x";
    else if (admIn === null && contextDim === 768) variant = "SD1.5";
    const extras = [];
    if (inChannels === 9) extras.push("INPAINT (9ch)");
    if (inChannels === 8) extras.push("instructpix2pix (8ch)");
    if (has("v_pred")) extras.push("V-PREDICTION");
    if (has("ztsnr")) extras.push("ztsnr");
    if (has("edm_vpred.sigma_max")) extras.push("EDM v-pred");
    return {
      family: "unet", variant,
      detail: `mc ${modelChannels}, in_ch ${inChannels}, ctx ${contextDim}, adm ${admIn}${extras.length ? " | " + extras.join(", ") : ""}`,
      confidence: variant === "SDXL" ? "family-only (flavour unknowable)" : "certain",
      companions,
    };
  }

  return { family: "unknown", confidence: "none", companions };
}

/**
 * What a given architecture actually wants.
 *
 * The app knew the ENGINE ("checkpoint") and nothing about the model behind it,
 * so a 4-step FLUX default and a 1024 canvas were offered for an SD1.5
 * checkpoint that wants 28 steps at 512 — which produces a soft, washed-out
 * picture that looks like a VAE fault and is simply undersampling. The detector
 * already reads the architecture from the header; this is the table that turns
 * that into numbers the screen can offer.
 *
 * `sizes` are the buckets each family was TRAINED on. SDXL off its buckets
 * duplicates limbs and heads; SD1.5 above 512 does the same. They are offered
 * rather than enforced — a custom size stays available, because a rule the app
 * cannot explain should not be a rule the app imposes.
 */
export const ARCH_PRESETS = {
  "SD1.5": {
    steps: 28, cfg: 7, native: 512, clipSkip: true,
    sizes: [[512, 512], [512, 768], [768, 512], [576, 832], [832, 576], [640, 960], [960, 640]],
    note: "Trained at 512. Much above it and the composition repeats — two heads, three arms.",
  },
  "SD2.x": {
    steps: 28, cfg: 7, native: 768, clipSkip: true,
    sizes: [[768, 768], [768, 512], [512, 768], [896, 640], [640, 896]],
    note: "Trained at 768. ⚠ A DISTILLED build (SD-Turbo is one) wants 1-4 steps at cfg 1, "
      + "and the tensors cannot tell it from a base model — same blind spot as Pony under SDXL. "
      + "The preset is what a BASE model wants; a turbo build needs its step count lowered by hand.",
  },
  SDXL: {
    steps: 28, cfg: 6, native: 1024, clipSkip: true,
    sizes: [[1024, 1024], [1152, 896], [896, 1152], [1216, 832], [832, 1216],
            [1344, 768], [768, 1344], [1536, 640], [640, 1536]],
    note: "The nine buckets SDXL was trained on. Off them, it repeats limbs. "
      + "Pony and Illustrious are SDXL underneath and effectively require CLIP skip 2 — "
      + "which is why the control is offered rather than pinned: the tensors cannot tell "
      + "a Pony merge from any other SDXL.",
  },
  "SDXL refiner": { steps: 20, cfg: 6, native: 1024, clipSkip: true, sizes: [[1024, 1024]], note: "A refiner, not a base model." },
};

/**
 * Will this LoRA do anything on this checkpoint?
 *
 * Answered in three states rather than two, because "no" and "cannot tell" are
 * different and pretending otherwise hides working LoRAs. The stakes are
 * asymmetric: a wrong "yes" costs a render that silently ignores the LoRA, a
 * wrong "no" removes a file the user deliberately downloaded.
 */
export function loraFits(loraVariant, ckptVariant) {
  const L = String(loraVariant || ""), C = String(ckptVariant || "");
  if (!L || !C) return { fit: "unknown", why: "one of the two could not be identified" };
  if (L === C) return { fit: "yes", why: `both ${C}` };

  const sdFamily = (v) => v === "SD1.5" || v === "SD2.x" || v === "SDXL" || v === "SDXL refiner";
  if (L.startsWith("SD-family")) {
    return sdFamily(C)
      ? { fit: "unknown", why: "an SD-family LoRA whose exact base this file does not state — try it; if the style never arrives, it was for the other one" }
      : { fit: "no", why: `an SD-family LoRA cannot apply to ${C}` };
  }
  if (sdFamily(L) && sdFamily(C)) {
    /* SD1.5 and SDXL share module NAMES and disagree on every width, so the
     * loader matches nothing and silently changes nothing. */
    return { fit: "no", why: `${L} and ${C} share module names but not their dimensions — the loader would match nothing and change nothing, without an error` };
  }
  if (L === "FLUX" && C === "FLUX") return { fit: "yes", why: "both FLUX" };
  if (L === "FLUX") {
    return { fit: "no", why: `a FLUX LoRA cannot apply to ${C}` };
  }
  return { fit: "no", why: `${L} and ${C} are different architectures` };
}

/**
 * The preset for a probe, or null when the family has no SD-style knobs.
 *
 * A STARTING POINT, never a verdict. Two things are invisible in the tensors
 * and both change the right answer: whether an SDXL checkpoint is a Pony or
 * Illustrious merge (which wants CLIP skip 2), and whether a model is a
 * distilled turbo build (which wants a fraction of the steps). The screen
 * offers these and lets them be overridden, which is the honest shape for a
 * guess that is usually right.
 */
export function presetFor(probe) {
  if (!probe) return null;
  if (probe.family === "unet") return ARCH_PRESETS[probe.variant] || null;
  return null;
}

/* ── the convenience wrapper the app actually calls ───────────────────────
 * Everything the shelf wants to show about a file, from one header read:
 * what it is, how big, when it arrived, what precision it is in, and whatever
 * the author chose to embed. */
export async function probeModel(file) {
  const st = await fs.promises.stat(file);
  const out = {
    name: path.basename(file),
    bytes: st.size,
    /* "Downloaded" is not knowable — a file can be copied, moved, or restored
     * from a backup. mtime is when THIS machine last wrote it, which is the
     * honest thing to show and the one the user actually means. */
    at: st.mtimeMs,
  };
  try {
    const { json, headerBytes } = await readHeader(file);
    out.headerBytes = headerBytes;
    const meta = json.__metadata__ && typeof json.__metadata__ === "object" ? json.__metadata__ : null;
    const keys = new Set(), shapes = {};
    let params = 0;
    const dtypes = new Map();
    for (const [k, v] of Object.entries(json)) {
      if (k === "__metadata__") continue;
      keys.add(k);
      if (v && Array.isArray(v.shape)) {
        shapes[k] = v.shape;
        params += v.shape.reduce((a, b) => a * b, 1);
      }
      if (v && v.dtype) dtypes.set(v.dtype, (dtypes.get(v.dtype) || 0) + 1);
    }
    out.params = params;
    out.dtype = [...dtypes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    /* The author's own words, when there are any. One of the Anima checkpoints
     * here literally carries "jdx.merge.architecture":"anima" — worth showing,
     * and worth NOT trusting over the tensor evidence, which is why it rides
     * beside the detection rather than replacing it. */
    out.metadata = meta;
    Object.assign(out, detect(keys, shapes));
  } catch (err) {
    out.family = "unreadable";
    out.confidence = "none";
    out.error = String(err.message || err).slice(0, 200);
  }
  return out;
}

/* Which of this app's image engines can actually RUN this file?
 * CheckpointLoaderSimple wants a packaged UNet checkpoint with its own VAE and
 * text encoder. A bare DiT (FLUX, Z-Image, Anima, Ideogram) is not that, and
 * dropping one in models/checkpoints produces a load error rather than a
 * picture — which is exactly what happened here with two Anima files and a
 * Z-Image NVFP4 build. Saying so on the shelf beats failing at render time. */
export function loadableAs(probe) {
  const f = probe?.family;
  if (f === "unet") return { engine: "checkpoint", ok: true };
  if (f === "unknown" || f === "unreadable") return { engine: null, ok: false, why: "architecture not recognised" };
  if (["vae", "lora", "text-encoder"].includes(f)) {
    return { engine: null, ok: false, why: `this is a ${f}, not a checkpoint — it belongs in models/${f === "lora" ? "loras" : f === "vae" ? "vae" : "text_encoders"}` };
  }
  return {
    engine: null, ok: false,
    why: `${f} is a bare diffusion transformer, which CheckpointLoader cannot load — it needs its own engine and a matching text encoder and VAE`,
  };
}

