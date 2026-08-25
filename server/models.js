/**
 * Model catalogue and downloader.
 *
 * The point of this file is Joe.
 *
 * Every optional capability in Studio — cover art, stems, timed lyrics — works
 * on this machine only because its weights happen to be sitting in a cache
 * somebody filled by hand. That is not a product. So capabilities do not assume
 * their models exist: they DECLARE them here, the app reports what is missing
 * with an honest size, and one button fetches it. Nothing is downloaded without
 * being asked for, and nothing is silently 4 GB.
 *
 * Design rules this file exists to enforce:
 *
 *  - **Nothing auto-downloads.** A first run must never begin with 12 GB of
 *    traffic the user did not consent to.
 *  - **Sizes are real, and checked.** Every entry carries the exact byte count
 *    from the HuggingFace API, and a file is only "present" if it matches. A
 *    truncated download that merely EXISTS is the failure mode that turns into
 *    "the model is corrupt" bug reports weeks later.
 *  - **Licences are stated where the user chooses**, not buried. Two of these
 *    are Apache-2.0 and one is MIT, which is the whole reason they were picked.
 *  - **Downloads resume.** These are gigabytes over a home connection.
 */
import { createWriteStream } from "node:fs";
import { stat, mkdir, rename, unlink, statfs } from "node:fs/promises";
import { EventEmitter } from "node:events";
import path from "node:path";
import { config } from "./config.js";

const HF = "https://huggingface.co";

/**
 * Where a capability's weights actually come from.
 *
 * DERIVED from the download URLs rather than typed alongside them. A hand-kept
 * second list of links is a list that goes stale the first time a repo moves,
 * and a credit pointing at a 404 is worse than no credit. Every file URL here
 * is a HuggingFace `resolve` path, so the repo page is that path cut at
 * `/resolve/`.
 */
function homeFor(cap) {
  /* Two capabilities have no files of their own -- their libraries fetch into a
   * private cache -- so there is nothing to derive from and the source has to be
   * stated. Everything else derives. */
  if (cap.home) return cap.home;
  const u = (cap.files || []).map((f) => f.url).find((x) => typeof x === "string" && x.includes("/resolve/"));
  if (!u) return cap.gated?.url || cap.region?.url || null;
  return u.split("/resolve/")[0];
}
const M = (p) => path.join(config.comfyDir, "models", p);

/**
 * @typedef {object} ModelFile
 * @property {string} url    direct download
 * @property {string} dest   absolute path on disk
 * @property {number} bytes  exact size, used to verify completeness
 */

/**
 * Capabilities, in the order a user meets them.
 *
 * `engine` is the only required one; everything below it is opt-in and the app
 * is fully usable without any of them.
 */
export const CATALOG = [
  {
    id: "engine",
    label: "Music engine — MiniMax Music 3",
    why: "Required. This is what writes and renders the music.",
    licence: "MiniMax Music3 Community Licence",
    required: true,
    files: [
      { url: `${HF}/Comfy-Org/MiniMax-Music-3/resolve/main/diffusion_models/minimax_music3_dit_int8_convrot.safetensors`,
        dest: M("diffusion_models/minimax_music3_dit_int8_convrot.safetensors"), bytes: 2502161682 },
      { url: `${HF}/Comfy-Org/MiniMax-Music-3/resolve/main/text_encoders/minimax_music3_text_encoder_pruned_int8_convrot.safetensors`,
        dest: M("text_encoders/minimax_music3_text_encoder_pruned_int8_convrot.safetensors"), bytes: 9196611886 },
      { url: `${HF}/Comfy-Org/MiniMax-Music-3/resolve/main/vae/minimax_music3_dav.safetensors`,
        dest: M("vae/minimax_music3_dav.safetensors"), bytes: 216696128 },
    ],
    // These are already the SMALLEST published variants — see config.js. "Use a
    // smaller model" is not an option that exists; the low-VRAM tiers work by
    // streaming, not by shrinking.
    note: "The smallest published weights. Lower-VRAM machines stream these from system RAM rather than using different files.",
    requires: {
      // Measured on this rig, not guessed: the music stack sits at ~14.1 GB
      // resident (DiT fp16 4.91 + text encoder int8 9.20).
      vramMinGb: 6, vramRecGb: 12, ramMinGb: 16, ramRecGb: 32,
      note: "Runs on less by streaming weights from system RAM — that is what the graphics-memory tiers do. The 6 GB tier is UNPROVEN on real hardware.",
    },
    variants: [
      { label: "DiT int8 convrot (shipped)", bytes: 2502161682, note: "Measured identical to fp16 against a converged reference." },
      { label: "DiT fp16", bytes: 4914197682, note: "Twice the size for the same measured result." },
      { label: "DiT fp32", bytes: 9828345396, note: "Never measured here." },
      { label: "Encoder pruned int8 convrot (shipped)", bytes: 9196611886 },
      { label: "Encoder pruned bf16", bytes: 16706629398 },
      { label: "Encoder bf16", bytes: 18472478038 },
    ],
  },
  {
    id: "audioRef",
    label: "Audio reference — MiniMax Music 3 DAV encoder",
    why: "Starts a render from a real song instead of from silence.",

    /* ⚠ LICENCE, stated carefully because the repo itself states none.
     *
     * SimpleTuner/MiniMax-Music-3-Encoder publishes no licence field. These are
     * the ENCODER half of MiniMax Music 3's DAV autoencoder, and the engine
     * entry above already fetches the decoder half of the same autoencoder, so
     * the Music 3 Community Licence is what governs them. Studio links to the
     * publisher and hosts nothing, exactly as everywhere else in this file. */
    licence: "MiniMax Music3 Community Licence",
    files: [
      { url: `${HF}/SimpleTuner/MiniMax-Music-3-Encoder/resolve/main/audio_vae/diffusion_pytorch_model.safetensors`,
        dest: M("vae/minimax_music3_dav_encoder.safetensors"), bytes: 306466152 },
    ],

    /* ComfyUI never loads this file. `comfy/sd.py` refuses to encode audio at
     * all, so `scripts/dav_encode.py` loads these weights itself, outside the
     * engine, and writes a .latent that stock `LoadLatent` then reads. It still
     * belongs under models/vae: that is what it is, and one place for weights
     * beats two. The encoder finds it here, in the HuggingFace cache, or via
     * AIPLAY_DAV_ENCODER — see find_ckpt() in that script. */
    needsPackage: "av",
    note: "ComfyUI ships the DAV decoder only — sd.py refuses to encode audio — so this is the missing half, and it runs outside ComfyUI. Its decoder tensors are bit-identical to the copy the engine already uses, which is what makes the latent it produces one the sampler understands: the round trip measures +26.26 dB SI-SDR. Encoding is capped at 60 seconds, enough to establish structure and short of the out-of-memory a full track hit while the music stack was resident. The publisher states no licence; these are Music 3 weights, so treat them as the engine's. Needs numpy, torch and PyAV in the system Python — INSTALL.md has the one pip line.",
    requires: {
      vramMinGb: 4, vramRecGb: 6, ramMinGb: 8, ramRecGb: 16,
      note: "Falls back to the CPU when there is no CUDA, several times slower. These figures follow from the 60-second cap rather than a per-tier measurement: a 2-minute stereo decode allocates over 4 GB and did OOM alongside the resident music stack, which is why the cap exists.",
    },
  },
  {
    id: "coverArt",
    label: "Cover art — FLUX.2 klein 4B",
    why: "Draws a cover for each song while nothing is generating.",
    licence: "Apache-2.0",
    files: [
      { url: `${HF}/black-forest-labs/FLUX.2-klein-4b-fp8/resolve/main/flux-2-klein-4b-fp8.safetensors`,
        dest: M("diffusion_models/flux-2-klein-4b-fp8.safetensors"), bytes: 4070624520 },
      { url: `${HF}/Comfy-Org/flux2-klein-4B/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors`,
        dest: M("text_encoders/qwen_3_4b.safetensors"), bytes: 8044982048 },
      { url: `${HF}/Comfy-Org/flux2-klein-4B/resolve/main/split_files/vae/flux2-vae.safetensors`,
        dest: M("vae/flux2-vae.safetensors"), bytes: 336211292 },
    ],
    note: "Roughly 3 seconds a cover once loaded. The text encoder is shared with other image models, so a second one later costs only its own weights.",
    requires: {
      vramMinGb: 8, vramRecGb: 12, ramMinGb: 16, ramRecGb: 32,
      note: "Cannot be resident alongside the music engine on a 16 GB card, so covers are drawn only while nothing is generating.",
    },
    variants: [
      { label: "DiT fp8 (shipped)", bytes: 4070624520, note: "fp8 is native on Ada and Blackwell." },
      { label: "DiT bf16", bytes: 7751105712, note: "Nearly twice the size; no measured gain at 4 steps." },
      { label: "Encoder Qwen3-4B fp16 (shipped)", bytes: 8044982048 },
      { label: "Encoder Qwen3-4B fp4", bytes: 3848213998, note: "Half the size, but fp4 tensor cores are Blackwell-only — emulated on this Ada card." },
    ],
  },
  {
    id: "stems",
    home: "https://github.com/adefossez/demucs",   // torchaudio pulls HTDemucs itself
    label: "Stem separation — HTDemucs (fine-tuned)",
    why: "Splits a finished track into drums, bass, vocals and other.",
    licence: "MIT",
    /* ⚠ NO files listed on purpose.
     *
     * The HuggingFace mirror (adefossez/HTDemucs-ft) publishes .safetensors, but
     * demucs does not read those — it fetches its own .th bundles from
     * dl.fbaipublicfiles.com into the torch hub cache on first run. Downloading
     * the HF copies ourselves would put 336 MB on disk that the tool then
     * ignores while it downloads its own. Verified: the first separation pulled
     * the weights unprompted and completed. */
    files: [],
    viaPackage: "demucs",
    approxBytes: 336101760,
    // Four models run in sequence and averaged — that IS the "-ft" variant, and
    // why it is four times the size of plain htdemucs.
    note: "Four fine-tuned models averaged together — the highest-quality Demucs variant. Measured here at about 12 s for a 30 s track, and the four stems come to roughly 4 MB as FLAC.",
    needsPackage: "demucs",
    requires: {
      vramMinGb: 4, vramRecGb: 6, ramMinGb: 8, ramRecGb: 16,
      note: "Runs on the CPU too, several times slower. Never runs while music is generating.",
    },
    variants: [
      { label: "htdemucs_ft (shipped)", bytes: 336101760, note: "Four models averaged — best quality, ~4x the time." },
      { label: "htdemucs", bytes: 84025440, note: "One model. Noticeably faster, slightly worse separation." },
    ],
  },
  {
    id: "video",
    label: "Video clips — MiniMax H3 (quantised)",
    why: "Renders a short looping clip to sit under a finished song.",
    licence: "MiniMax H3 Community Licence",

    /* 🔴 THE ONE ENTRY THAT IS REGION-LOCKED.
     *
     * H3's Community Licence grants rights "solely within the Applicable
     * Territory", which EXCLUDES the European Union, the United Kingdom and
     * South Korea. Everything else in this catalogue is Apache-2.0 or MIT and
     * carries no such condition.
     *
     * Studio does not host, redistribute or bundle any weights — this is a
     * direct link to the publisher, exactly as ComfyUI Manager works — so the
     * obligation is the USER's and they have to be able to see it before they
     * choose. That is the whole reason `region` exists as a field rather than a
     * sentence buried in `note`: the UI is required to surface it as a blocking
     * acknowledgement, and `download()` refuses without one. */
    region: {
      excluded: ["European Union", "United Kingdom", "South Korea"],
      text: "MiniMax grants H3 rights only inside its Applicable Territory, which excludes the EU, the UK and South Korea. If you are in one of those places you may not use these weights. AIPLAY Studio does not host them — the download goes straight to the publisher, and the licence is between you and MiniMax.",
      url: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
    },

    /* OFFICIAL FILES — superseding the third-party hunt of 08-17.
     *
     * When this catalogue was first written, no official quantised H3 existed:
     * the DiT measured here was Abiray's int4 build (later pulled from its
     * repo) and the VAEs were cast locally. Comfy-Org has since published the
     * complete official set — the same filenames the ComfyUI templates use —
     * so that is what a fresh install gets.
     *
     * The official pruned int8 DiT is also simply BETTER: measured 08-24, same
     * seed/flow/prompt against the local int4 prune, it produced a
     * prompt-following photographic close-up where the int4 gave a distant
     * figure, at ~15% more wall clock. config.js prefers it when present. */
    files: [
      { url: `${HF}/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors`,
        dest: M("diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors"), bytes: 20970379616,
        alt: ["minimax_h3_fl2va_pruned_int4_convrot.safetensors", "minimax_h3_fl2va_pruned-w4a8_convrot_pruned.safetensors", "MiniMax_H3_FL2VA_pruned_mixed_int4_int8_convrot.safetensors"] },
      { url: `${HF}/Winnougan/MiniMax-H3-INT4_Convrot_ComfyUI/resolve/main/qwen3vl_32b_minimax_h3-int4_convrot.safetensors`,
        dest: M("text_encoders/qwen3vl_32b_minimax_h3-int4_convrot.safetensors"), bytes: 14173709116 },
      { url: `${HF}/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors`,
        dest: M("vae/minimax_h3_video_vae_fp16.safetensors"), bytes: 5207808496,
        alt: ["minimax_h3_video_vae_int8_convrot.safetensors"] },
      { url: `${HF}/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors`,
        dest: M("vae/minimax_h3_audio_vae_fp32.safetensors"), bytes: 605254808,
        alt: ["minimax_h3_audio_vae_bf16.safetensors"] },
      // Full-rank turbo LoRA on purpose — the 440 MB resized-rank one has two
      // independent reports of camera-movement and prompt-following damage.
      { url: `${HF}/Comfy-Org/MiniMax-H3/resolve/main/loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors`,
        dest: M("loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors"), bytes: 1956192992 },
    ],
    note: "43 GB — by far the largest thing here, and entirely optional. H3 always renders audio even when you only want pictures; Studio discards it, because the song already exists. Measured on this rig at roughly 15 s fixed cost plus 1.7 s per step.",
    requires: {
      vramMinGb: 16, vramRecGb: 24, ramMinGb: 32, ramRecGb: 64,
      note: "The heaviest capability in Studio by a wide margin. Never runs while music is generating.",
    },
    variants: [
      { label: "DiT FL2VA pruned int8 convrot, official (offered)", bytes: 20970379616, note: "Measured 08-24: a class above the third-party int4 prune — real prompt-following close-ups — at ~15% more render time." },
      { label: "DiT FL2VA pruned int4 convrot (third-party)", bytes: 11337536848, note: "What this rig originally measured. Visibly worse than the official int8; kept as a fallback for small disks." },
      { label: "DiT FL2VA pruned fp8 scaled, official", bytes: 20956702112, note: "Same size as int8; not measured here." },
      { label: "DiT FL2VA pruned bf16, official (unquantised)", bytes: 40225724176, note: "Twice the download; not measured here." },
      { label: "Text encoder Qwen3-VL-32B int4 convrot (offered)", bytes: 14173709116 },
      { label: "Text encoder nvfp4 awq, official", bytes: 15690000000, note: "What the ComfyUI templates name. Blackwell-native; not measured here." },
      { label: "Text encoder int8 convrot, official", bytes: 27141342152, note: "Nearly twice the size." },
      { label: "Video VAE fp16, official (offered)", bytes: 5207808496 },
      { label: "Audio VAE fp32, official (offered)", bytes: 605254808 },
    ],
  },
  {
    id: "videoRefs",
    label: "Video references — MiniMax H3 ref2va",
    why: "The checkpoint BUILT for reference conditioning — pictures and audio the prompt calls by name (<Picture 1>, <Audio 1>). Without it, references still work on the fl2va checkpoint; this is the vendor's own model for the job, plus its turbo distillation for fast renders.",
    licence: "MiniMax H3 Community Licence",
    // Same licence, same territory condition as the video capability above.
    region: {
      excluded: ["European Union", "United Kingdom", "South Korea"],
      text: "MiniMax grants H3 rights only inside its Applicable Territory, which excludes the EU, the UK and South Korea. If you are in one of those places you may not use these weights. AIPLAY Studio does not host them — the download goes straight to the publisher, and the licence is between you and MiniMax.",
      url: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
    },
    files: [
      { url: `${HF}/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors`,
        dest: M("diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors"), bytes: 20970379616 },
      { url: `${HF}/Comfy-Org/MiniMax-H3/resolve/main/loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors`,
        dest: M("loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors"), bytes: 1956193000 },
    ],
    note: "23 GB, optional. Shares the text encoder and VAEs with the video capability, so install that first.",
    requires: {
      vramMinGb: 16, vramRecGb: 24, ramMinGb: 32, ramRecGb: 64,
      note: "Same weight class as the H3 video capability; the two never load together.",
    },
  },
  {
    id: "imageIdeogram",
    label: "Images — Ideogram 4 (open 9B)",
    why: "A second image engine with a different eye: Ideogram's open release, strong at typography, posters and graphic layouts where FLUX paints. Dual-model CFG, 20-step Default or 48-step Quality. No reference-image input — iterating on refs stays with FLUX.2.",
    licence: "Ideogram Non-Commercial Model Agreement — personal and research use ONLY, no commercial use of the model or its outputs. The original ideogram-ai repo is gated behind accepting the agreement; the Comfy-Org repackage mirrors the same terms. If this studio makes money for you, render with FLUX.2 (Apache-2.0) instead.",
    files: [
      { url: `${HF}/Comfy-Org/Ideogram-4/resolve/main/diffusion_models/ideogram4_fp8_scaled.safetensors`,
        dest: M("diffusion_models/ideogram4_fp8_scaled.safetensors"), bytes: 9280741285 },
      { url: `${HF}/Comfy-Org/Ideogram-4/resolve/main/diffusion_models/ideogram4_unconditional_fp8_scaled.safetensors`,
        dest: M("diffusion_models/ideogram4_unconditional_fp8_scaled.safetensors"), bytes: 9280741293 },
      { url: `${HF}/Comfy-Org/Ideogram-4/resolve/main/text_encoders/qwen3vl_8b_nvfp4.safetensors`,
        dest: M("text_encoders/qwen3vl_8b_nvfp4.safetensors"), bytes: 6305221764 },
      { url: `${HF}/Comfy-Org/Ideogram-4/resolve/main/vae/flux2-vae.safetensors`,
        dest: M("vae/flux2-vae.safetensors"), bytes: 336211292 },
    ],
    note: "25.2 GB (the VAE is shared with FLUX.2 and is usually already present). ⚠ fp8_scaled ON PURPOSE: the int8_convrot conversions of this model are BROKEN — the conversion damages the conditioning head and every render comes back as the model's trained-in 'blocked by safety filter' card (measured; the vendor's own fp8 renders perfectly). The card is also SEED-dependent on good weights — innocent prompts occasionally draw it — so the app detects the near-uniform card and retries up to two fresh seeds automatically. Hunyuan Image 3.0 was evaluated and rejected: 48 GB of weights even at NF4, physically over this machine's memory.",
    requires: { vramMinGb: 12, vramRecGb: 16, ramMinGb: 32, ramRecGb: 32 },
  },
  {
    id: "videoLtx",
    label: "Video clips — LTX 2.5 (quantised)",
    why: "Renders a short clip with sound. Much faster than H3 and, here, better.",
    licence: "LTX-2.x Community Licence",

    /* 🔴 GATED. Unlike everything else in this catalogue, these files 401 to an
     * anonymous request: Lightricks requires you to accept the licence on the
     * model page and authenticate. The downloader below has no credential path
     * and MUST NOT grow one — a token belongs in the user's own keychain, not in
     * this app's config. `scripts/fetch_ltx25.py` does the fetch instead, reading
     * the token the hf CLI stored, and never printing or copying it.
     *
     * The command here is `hf auth login`, NOT `huggingface-cli login`. The
     * latter is dead as of huggingface_hub 1.x -- it refuses outright rather
     * than warning and continuing -- and this text told people to run it, so
     * the very first step failed with an error that looked nothing like a
     * licence problem. Anyone following it could not get past step one. */
    gated: {
      url: "https://huggingface.co/Lightricks/LTX-2.5",
      how: "Accept the licence on the model page, then in the ComfyUI python environment run `hf auth login` followed by `python scripts/fetch_ltx25.py`. About 40 GB.",
    },

    /* ⚠ DELIBERATELY NO `region` FIELD.
     *
     * This is not H3. The LTX-2.x Community Licence has no Applicable Territory
     * clause, so reusing H3's entry would region-block LTX in the EU, the UK and
     * South Korea for no legal reason at all. Its restrictions are a different
     * shape and belong in `note`: a paid agreement at $10M annual revenue OR
     * MORE (§2.1 — exactly $10M is above the line), and Attachment A §20 forbids
     * use in a product that competes with Lightricks' own offerings. */
    files: [
      { url: `${HF}/Lightricks/LTX-2.5/resolve/main/diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors`,
        dest: M("diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors"), bytes: 21504034224 },
      { url: `${HF}/Lightricks/LTX-2.5/resolve/main/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors`,
        dest: M("text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors"), bytes: 15372969374 },
      { url: `${HF}/Lightricks/LTX-2.5/resolve/main/vae/ltx-2.5-video-vae-conv-bf16.safetensors`,
        dest: M("vae/ltx-2.5-video-vae-conv-bf16.safetensors"), bytes: 1452269922 },
      { url: `${HF}/Lightricks/LTX-2.5/resolve/main/vae/ltx-2.5-audio-vae-bf16.safetensors`,
        dest: M("vae/ltx-2.5-audio-vae-bf16.safetensors"), bytes: 364866540 },
      // Not optional. The whole speed advantage is sampling at half size and
      // upscaling the LATENT — without this there is no second pass.
      { url: `${HF}/Lightricks/LTX-2.5/resolve/main/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors`,
        dest: M("latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"), bytes: 995778752 },
    ],
    note: "39.69 GB. Measured here at 121 s for a 5-second 1280x704 clip with audio — against 308 s for MiniMax H3 at 8 steps and 660 s at 20, and better by eye. The speed is the schedule, not the model: 8 steps at half resolution, a latent upscale, then 3 steps at full size. ⚠ Free below $10M annual revenue; at or above that Lightricks require a paid agreement, and their licence forbids use in a product competing with their own.",
    requires: {
      vramMinGb: 16, vramRecGb: 16, ramMinGb: 32, ramRecGb: 32,
      note: "16 GB is the published minimum and what this was measured on. Community GGUF builds go lower.",
    },
    variants: [
      { label: "DiT distilled int8 convrot (offered)", bytes: 21504034224, note: "4-6 steps by design. int8_convrot is native on Ada; nvfp4 is smaller but emulated." },
      { label: "DiT distilled nvfp4", bytes: 18719999999, note: "2.8 GB smaller, Blackwell only — emulated and slower below compute 10." },
      { label: "DiT distilled bf16", bytes: 42020000000, note: "Twice the download." },
      { label: "DiT dev (not distilled)", bytes: 21500000000, note: "20-30 steps. For training LoRAs, not for generating." },
      { label: "Text encoder Gemma 4 12B int8 convrot (offered)", bytes: 15372969374 },
      { label: "Text encoder bf16", bytes: 26260000000 },
      { label: "Temporal upscaler x2", bytes: 260000000, note: "Not used by the shipped graph; for frame-rate interpolation." },
    ],
  },
  {
    id: "lyrics",
    home: "https://github.com/openai/whisper",   // faster-whisper fetches into its own cache
    label: "Timed lyrics — Whisper large-v3",
    why: "Produces word-level and line-level LRC files for visualisers.",
    licence: "MIT",
    files: [],                 // fetched by faster-whisper into its own cache
    viaPackage: "faster_whisper",
    approxBytes: 3090000000,
    note: "We already know the words, so this is alignment rather than transcription — the model supplies timing and the known lyrics supply the text. Measured 97.9% of words timed by direct match on a real track.",
    needsPackage: "faster_whisper",
    requires: {
      vramMinGb: 4, vramRecGb: 6, ramMinGb: 8, ramRecGb: 16,
      note: "About 36 s for a 2.5-minute song at int8_float16. Line timing is reliable; word timing is approximate on sung vocals.",
    },
    variants: [
      { label: "large-v3 (shipped)", bytes: 3090000000, note: "Best accuracy on sung vocals." },
      { label: "medium", bytes: 1530000000, note: "Faster, more misheard words — reconciliation fixes the text, not the timing." },
      { label: "base", bytes: 141000000, note: "Fast but unreliable on singing." },
    ],
  },
  {
    id: "interpolate",
    label: "Smooth motion — RIFE 4.26",
    why: "Doubles a clip's frame rate, or turns it into slow motion.",
    licence: "MIT",
    files: [
      { url: `${HF}/Comfy-Org/frame_interpolation/resolve/main/frame_interpolation/rife_v4.26.safetensors`,
        dest: M("frame_interpolation/rife_v4.26.safetensors"), bytes: 22674688 },
    ],
    /* This is the one capability where the best-quality answer and the
     * cheapest-to-install answer are the SAME answer, which is rare enough to
     * say out loud. 22 MB, first-party Comfy-Org repo, core loader. */
    note: "22 MB — the smallest thing in this list by a factor of a thousand. Generated clips are short and their weak point is motion, so this earns its place more than its size suggests. Same model does slow motion: keep the new frames, leave the frame rate alone, and the clip runs at half speed with no stutter.",
    requires: {
      vramMinGb: 4, vramRecGb: 6, ramMinGb: 8, ramRecGb: 16,
      note: "Roughly real time on this card. Runs only while nothing is generating.",
    },
    variants: [
      { label: "RIFE 4.26 (shipped)", bytes: 22674688, note: "The default everywhere. Fast and stable." },
      { label: "RIFE 4.26 heavy", bytes: 22908216, note: "Slightly better on fast motion, slightly slower." },
      { label: "RIFE 4.25 lite", bytes: 22506384, note: "For weaker cards." },
      { label: "FILM fp16", bytes: 68882302, note: "Handles very large motion between frames better than RIFE, and is three times the size and slower. Worth it for big camera moves." },
    ],
  },
  {
    id: "upscale",
    label: "Upscale — Real-ESRGAN 2x",
    why: "Enlarges a finished clip or cover without it going soft.",
    licence: "BSD-3-Clause",
    files: [
      { url: `${HF}/ai-forever/Real-ESRGAN/resolve/main/RealESRGAN_x2.pth`,
        dest: M("upscale_models/RealESRGAN_x2.pth"), bytes: 67061725 },
    ],
    /* ⚠ Stated plainly because it is a real limitation, not a detail.
     *
     * `ImageUpscaleWithModel` loads ESRGAN-architecture weights only, and those
     * models see ONE FRAME AT A TIME. Fine detail invented independently per
     * frame can shimmer between frames — the exact artifact that video-native
     * upscalers (SeedVR2, FlashVSR) exist to prevent. Those need custom node
     * packs, which is why they are not here yet rather than not here at all. */
    note: "Per-frame, so it does not know a clip is a clip: on fine texture the invented detail can shimmer slightly between frames. 2x is the default for that reason as well as for memory — at 4x a 5-second 1280x704 clip becomes 5120x2816 and needs about 20 GB of system RAM to hold. Video-native upscalers that avoid the shimmer entirely need extra ComfyUI nodes; this one works with a stock install.",
    requires: {
      vramMinGb: 4, vramRecGb: 8, ramMinGb: 16, ramRecGb: 32,
      note: "Tiles automatically and backs off on its own if VRAM runs short. System RAM is the real limit, not VRAM — every frame is held at full size.",
    },
    variants: [
      { label: "Real-ESRGAN 2x (shipped)", bytes: 67061725, note: "The safe default. 4x the pixels." },
      { label: "Real-ESRGAN 4x", bytes: 67040989, note: "16x the pixels. Watch system RAM on anything longer than a few seconds." },
      { label: "4x-UltraSharp", bytes: 66961958, note: "A community favourite for stills — crisper than Real-ESRGAN, and that crispness is exactly what shimmers most on video. Good for covers." },
    ],
  },
];

/**
 * Free space on the drive the models live on.
 *
 * Shown next to the download buttons because these are multi-gigabyte files and
 * "12.45 GB to download" is only half the question — the other half is whether
 * it fits. Running out mid-download leaves a `.part` and a confusing error, and
 * the answer was available all along.
 */
export async function diskFree() {
  try {
    const s = await statfs(config.comfyDir);
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

/**
 * Is this file on disk AND the right size?
 *
 * `alt` names satisfy the same slot without a size check: they are a DIFFERENT
 * build of the same weights (a local int8 cast, or a variant since pulled from
 * its repo), so there is no byte count to compare against. Without this the
 * catalogue tells a machine that already runs H3 that it is missing 18 GB,
 * which would be both wrong and expensive to believe.
 */
async function filePresent(f) {
  try {
    if ((await stat(f.dest)).size === f.bytes) return true;
  } catch { /* fall through to the alternates */ }
  for (const name of f.alt || []) {
    try {
      if ((await stat(path.join(path.dirname(f.dest), name))).size > 0) return true;
    } catch { /* keep looking */ }
  }
  return false;
}

/** Bytes already fetched, for resume and for progress on a partial file. */
async function fileHave(f) {
  try { return (await stat(f.dest)).size; } catch { return 0; }
}

export class ModelManager extends EventEmitter {
  constructor() {
    super();
    /** id -> { received, total, file, state } */
    this.progress = new Map();
    this.cancelled = new Set();
  }

  /** Catalogue with live presence, for the UI. */
  async status() {
    const out = [];
    for (const cap of CATALOG) {
      const files = await Promise.all(cap.files.map(async (f) => ({
        name: path.basename(f.dest),
        bytes: f.bytes,
        present: await filePresent(f),
        have: await fileHave(f),
      })));
      const totalBytes = cap.files.reduce((s, f) => s + f.bytes, 0) || cap.approxBytes || 0;
      const haveBytes = files.reduce((s, f) => s + (f.present ? f.bytes : f.have), 0);
      out.push({
        id: cap.id,
        label: cap.label,
        why: cap.why,
        licence: cap.licence,
        // The publisher's own page, derived from the download URLs. The Thanks
        // page turns each label into a link to it — a credit you cannot follow
        // is only half a credit.
        home: homeFor(cap),
        // Null for every capability but H3. The UI must render this as a
        // blocking acknowledgement, not a footnote — download() rejects without
        // one, so a client that ignores it simply cannot fetch the weights.
        region: cap.region || null,
        // Gated repos cannot be fetched by the built-in downloader at all — the
        // UI must say how to get them rather than offering a button that 401s.
        gated: cap.gated || null,
        note: cap.note,
        required: !!cap.required,
        // What the machine needs, and what else could be used instead. Stated
        // because "4 GB to download" answers a different question from "will it
        // run on my card" — and the second is the one that stops people.
        requires: cap.requires || null,
        variants: cap.variants || null,
        needsPackage: cap.needsPackage || null,
        // A capability with no files of its own (whisper) is reported by whether
        // its python package can be imported, which the server checks separately.
        managedByPackage: !!cap.viaPackage,
        files,
        totalBytes,
        haveBytes,
        ready: cap.files.length > 0 && files.every((f) => f.present),
        downloading: this.progress.has(cap.id),
        progress: this.progress.get(cap.id) || null,
      });
    }
    return out;
  }

  cancel(id) {
    this.cancelled.add(id);
  }

  /**
   * Fetch everything missing for one capability.
   *
   * Resumes with a Range request rather than starting again — these are
   * multi-gigabyte files and a dropped connection three quarters of the way
   * through should not cost the whole download. The partial is written to
   * `.part` and only moved into place once the size matches exactly, so an
   * interrupted run can never leave a truncated file that looks complete.
   */
  async download(id, { acceptRegion = false } = {}) {
    const cap = CATALOG.find((c) => c.id === id);
    if (!cap) throw new Error(`unknown capability: ${id}`);
    /* Enforced at the downloader, not at the button. A region-locked capability
     * cannot be fetched by a client that skipped the warning, by a stale page,
     * or by curl — which is the only version of this that means anything. */
    if (cap.region && !acceptRegion) {
      const e = new Error(`${cap.label} is licensed only outside ${cap.region.excluded.join(", ")}. Confirm you are outside those territories before downloading.`);
      e.needsRegionAck = true;
      e.region = cap.region;
      throw e;
    }
    /* A gated repo needs an accepted licence and a token, and this downloader
     * deliberately has neither. Failing here with instructions beats a 401 that
     * looks like a network error. */
    if (cap.gated) {
      const e = new Error(cap.gated.how);
      e.gated = cap.gated;
      throw e;
    }
    if (this.progress.has(id)) return { alreadyRunning: true };
    if (!cap.files.length) throw new Error(`${cap.label} is fetched by its python package, not by this downloader.`);

    this.cancelled.delete(id);
    const total = cap.files.reduce((s, f) => s + f.bytes, 0);
    let doneBytes = 0;
    for (const f of cap.files) if (await filePresent(f)) doneBytes += f.bytes;

    this.progress.set(id, { received: doneBytes, total, file: null, state: "starting" });
    this.emit("update");

    try {
      for (const f of cap.files) {
        if (this.cancelled.has(id)) throw new Error("cancelled");
        if (await filePresent(f)) continue;
        await this.#one(id, f, () => doneBytes, (n) => { doneBytes = n; });
        doneBytes += f.bytes;
      }
      this.progress.delete(id);
      this.emit("update");
      this.emit("ready", id);
      return { ok: true };
    } catch (err) {
      this.progress.set(id, { received: doneBytes, total, file: null, state: "failed", error: String(err.message || err) });
      this.emit("update");
      // Leave the .part behind on purpose: the next attempt resumes from it.
      setTimeout(() => { if (this.progress.get(id)?.state === "failed") { this.progress.delete(id); this.emit("update"); } }, 15000);
      throw err;
    }
  }

  async #one(id, f, getBase, _setBase) {
    await mkdir(path.dirname(f.dest), { recursive: true });
    const part = `${f.dest}.part`;
    let from = 0;
    try { from = (await stat(part)).size; } catch { /* fresh */ }
    if (from > f.bytes) { await unlink(part).catch(() => {}); from = 0; }

    const res = await fetch(f.url, from ? { headers: { Range: `bytes=${from}-` } } : undefined);
    if (!res.ok && res.status !== 206) throw new Error(`${path.basename(f.dest)}: HTTP ${res.status}`);
    // A server that ignores Range answers 200 with the whole file; restarting is
    // then the only correct thing to do, rather than appending to a partial.
    if (from && res.status !== 206) from = 0;

    const out = createWriteStream(part, { flags: from ? "a" : "w" });
    let received = from;
    const base = getBase();
    for await (const chunk of res.body) {
      if (this.cancelled.has(id)) { out.close(); throw new Error("cancelled"); }
      received += chunk.length;
      out.write(chunk);
      const p = this.progress.get(id);
      if (p) {
        p.received = base + received;
        p.file = path.basename(f.dest);
        p.state = "downloading";
      }
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));

    const got = (await stat(part)).size;
    if (got !== f.bytes) {
      throw new Error(`${path.basename(f.dest)}: expected ${f.bytes} bytes, got ${got}`);
    }
    await rename(part, f.dest);
  }
}
