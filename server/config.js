/**
 * Ship configuration — every value here was measured, not chosen.
 * See C:\temp\MiniMaxMusicUI\HANDOVER.md §4.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Where the settings a user can change actually live.
 *
 * Three layers, most specific first: an environment variable, then a JSON file
 * written by `setup` or by the Settings screen, then the built-in default. The
 * file layer is what makes this installable by someone who is never going to
 * edit a .js — which is the entire difference between a rig and a product.
 *
 * Read synchronously and defensively: config is imported by everything, and a
 * hand-edited settings file with a trailing comma must not take the app down.
 */
const SETTINGS_FILE = path.join(os.homedir(), ".aiplay-studio", "settings.json");
let saved = {};
try { saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")) || {}; } catch { /* first run */ }

const RIG = process.env.AIPLAY_RIG || saved.rig || "D:\\AI\\aiplay-studio-bench";

/**
 * First of these filenames that is actually on disk, else the last one.
 *
 * Needed because the weights this rig MEASURED and the weights a new install can
 * DOWNLOAD are not the same files — the pure-int4 H3 DiT was pulled from its
 * repo and the two H3 VAEs were cast locally, so `models.js` offers the nearest
 * published equivalents instead. Hard-coding either set breaks the other
 * machine, and silently falling back to a name that does not exist produces a
 * ComfyUI node error at render time rather than "download this first".
 *
 * Order is preference: measured build first, downloadable substitute last.
 */
const pick = (sub, ...names) => {
  const dir = path.join(RIG, "ComfyUI", "models", sub);
  return names.find((n) => { try { return fs.statSync(path.join(dir, n)).size > 0; } catch { return false; } })
    ?? names[names.length - 1];
};

export const config = {
  rig: RIG,
  comfyDir: path.join(RIG, "ComfyUI"),
  python: path.join(RIG, "venv", "Scripts", "python.exe"),
  /* Where finished songs live. Settable, because "my music is on the D: drive"
   * is an ordinary thing to want and the alternative is editing a source file.
   *
   * ⚠ This is also ComfyUI's output directory — the engine is launched with
   * `--output-directory` pointing here, so the two can never drift apart. That
   * coupling is why changing it needs an engine restart rather than taking
   * effect on the next render. */
  outputDir: process.env.AIPLAY_OUTPUT || saved.outputDir || path.join(RIG, "ComfyUI", "output"),
  settingsFile: SETTINGS_FILE,
  // Where `LoadLatent` looks. Its `latent` input is a name RELATIVE to this, so
  // the encoder writes here and the graph refers to the basename only.
  inputDir: path.join(RIG, "ComfyUI", "input"),

  // ONE long-lived ComfyUI process. This is architectural, not a preference:
  // restarting per job discards the AR-stage cache, and with it the ~40% saving
  // that makes re-rolling a mix faster than realtime.
  comfy: {
    port: Number(process.env.AIPLAY_COMFY_PORT || 8266),
    host: "127.0.0.1",
    flags: ["--lowvram", "--async-offload", "4"],
    startupTimeoutMs: 180_000,
  },

  /**
   * Graphics-memory tiers.
   *
   * 🔑 The weights we ship are ALREADY the smallest that exist — int8 DiT (2.33 GB)
   * + pruned int8 text encoder (8.57 GB) + VAE (0.20 GB) = 11.1 GB. Every other
   * file in the repo is larger, so "switch to a smaller model" is not available:
   * the only way to fit a smaller card is to keep less of it resident and stream
   * the rest from system RAM.
   *
   * That is what these tiers do. Flags are read at process start, so changing tier
   * restarts the engine (and clears the AR cache — worth saying in the UI).
   *
   * ⚠ Measured on a 16 GB card plus `--reserve-vram` simulation. Nothing OOM'd even
   * at a 6 GB-equivalent budget, but the proxy is imperfect (peak still reported
   * ~13 GB) and the small tiers are UNPROVEN ON REAL HARDWARE. Do not publish a
   * minimum-VRAM claim from this; the community beta settles it.
   */
  vramTiers: {
    auto:   { label: "Auto", flags: ["--lowvram", "--async-offload", "4"], note: "Detected from your card." },
    high:   { label: "16 GB or more", flags: ["--async-offload", "4"], note: "Keeps the model resident. Fastest." },
    mid:    { label: "12 GB", flags: ["--lowvram", "--async-offload", "4"], note: "Verified bit-identical to the fast path." },
    low:    { label: "8 GB", flags: ["--lowvram", "--async-offload", "2"], note: "More streaming from system RAM. Roughly 2× slower." },
    /* ⚠ `--novram` is INCOMPATIBLE with this model and must never come back.
     * It moves the execution device to CPU, and the AR stage requires CUDA:
     *   ValueError: Expected a cuda device, but got: cpu
     * Measured 2026-08-18 — the tier produced zero audio in 6 seconds. The
     * shipped config offered it as the 6 GB option, so anyone on a small card
     * would have hit a hard failure with no explanation.
     * Streaming harder while staying on the GPU is the only lever we have. */
    minimum:{ label: "6 GB", flags: ["--lowvram", "--async-offload", "1", "--reserve-vram", "1.0"], note: "Streams almost everything from system RAM. Much slower, and still unproven on real 6 GB hardware — tell us how it goes." },
  },

  uiPort: Number(process.env.AIPLAY_UI_PORT || 4173),

  /**
   * The SYSTEM python, for tools that are not the engine.
   *
   * ⚠ Deliberately not the ComfyUI venv. That venv is torch 2.13.0+cu130 and the
   * fused int8 kernels the music model needs exist only on that build; letting
   * pip resolve demucs' or ctranslate2's torch requirement inside it is how you
   * end up with a silently 5x slower app. Verified after installing demucs:
   * system python stayed at 2.5.1+cu121 and the venv at 2.13.0+cu130.
   */
  systemPython: process.env.AIPLAY_SYS_PYTHON
    || path.join(os.homedir(), "AppData", "Local", "Programs", "Python", "Python310", "python.exe"),

  /**
   * Stem separation. OFF by default — it is a deliberate act, not something that
   * should quietly consume the card after every song.
   *
   * `when`: off | all | starred | liked
   *   Starred and liked exist because separating everything is wasteful: most
   *   takes are discarded, and the ones worth pulling apart are exactly the ones
   *   already marked worth keeping.
   */
  stems: {
    when: "off",
    model: "htdemucs_ft",
    // Four stems rather than vocals/no-vocals. The two-stem mode is faster but
    // it is the lyric-alignment use case, not the "remix this" one.
    twoStems: false,
  },

  /**
   * Timed lyrics — two LRC files per song, for visualisers.
   *
   * Same off/all/starred/liked shape as stems, and off by default for the same
   * reason: it is a deliberate act, and it costs a whisper pass over the audio.
   *
   * ⚠ Runs in the RE-TIMING venv (`C:\aiplay-whisper\venv`), which already has
   * stable-whisper, faster-whisper, ctranslate2 and a CUDA torch installed and
   * working. Not the ComfyUI venv — ctranslate2 expects a different torch than
   * the cu130 build the engine depends on.
   *
   * ⚠ Measured honesty: line-level timing is reliable; word-level is approximate
   * on sung vocals, because a word held across two bars has no single onset. The
   * UI must not present the word file as exact.
   */
  lyrics: {
    when: "off",
    model: "large-v3",
    python: process.env.AIPLAY_WHISPER_PYTHON
      || path.join(os.homedir(), "aiplay-whisper", "venv", "Scripts", "python.exe"),
    // Separating the vocal first measurably helps a dense mix. It is skipped
    // when stems already exist for the track, and skipped entirely when the mix
    // is clear enough — a 92.9% match was achieved on the raw mix in testing.
    useVocalStem: true,
  },

  /**
   * Output format.
   *
   * FLAC stays the default because it is lossless and the library recovers
   * lyrics and style by reading tags back out of the file — the file is a real
   * source of truth here, not just a rendering.
   *
   * MP3 exists because size is the honest constraint on an overnight run: a
   * 3-minute track is ~30 MB as FLAC against ~4 MB as V0, so fifty songs is
   * 1.5 GB versus 200 MB. That is the difference between "leave it running" and
   * "watch the disk".
   *
   * ⚠ There is no WAV option and there should not be: no ComfyUI audio writer
   * emits it, so offering it would mean inventing a conversion step for a format
   * that is strictly larger than FLAC and carries no tags.
   */
  output: {
    format: process.env.AIPLAY_FORMAT || "flac",   // flac | mp3 | opus
    mp3Quality: "V0",                              // V0 | 128k | 320k
    opusQuality: "192k",                           // 64k | 96k | 128k | 192k | 320k
  },

  models: {
    // int8 DiT beats fp16 on full songs once the fused kernels exist (cu130).
    dit: "minimax_music3_dit_int8_convrot.safetensors",
    // Offered as an advanced override only. Measured identical to int8 against a
    // converged reference (both 4.2 dB SNR / +10.8 dB NMR) — it is twice the size
    // for the same result, so int8 stays the default.
    ditFp16: "minimax_music3_dit_fp16.safetensors",
    textEncoder: "minimax_music3_text_encoder_pruned_int8_convrot.safetensors",
    // fp32 VAE is deliberate: bf16 measures +23.5 dB NMR (audible in 18.5% of
    // tiles) and fp16 clips 100% of samples outright. Do not "optimise" this.
    //
    // It is enforced by OMISSION — ComfyUI runs the audio VAE at fp32 unless you
    // pass --fp16-vae / --bf16-vae, so those flags must never appear in
    // `comfy.flags` above.
    vae: "minimax_music3_dav.safetensors",

    // ⚠ The repo also publishes `minimax_music3_dit_fp32.safetensors` (9.15 GB),
    // which we have never downloaded and never measured. The int8 ≡ fp16 result
    // was a two-way test against a SAMPLING-convergence reference (euler@300); it
    // says nothing about fp32. Do not describe fp16 as "the highest precision
    // available" anywhere in the UI until this is settled.
    ditFp32: "minimax_music3_dit_fp32.safetensors",
  },

  // Sampling. shift-5 @ 15 steps lands ~2x closer to the converged solution than
  // the stock euler@30 default, in half the sampling time. Chosen by listening.
  sampling: {
    sampler: "euler",
    steps: 15,
    shift: 5.0,
    cfg: 1.7,
    topK: 50,
    // Preview: same conditioning, fewer steps. The AR stage is cached between
    // the two, so committing after a preview costs only the sampling stage.
    previewSteps: 6,
  },

  // Measured on an RTX 4070 Ti SUPER: 135 s of audio in ~207 s => ~1.5x realtime.
  // Refined per machine by the first-run warm-up; this is only the cold estimate.
  speed: { realtimeRatio: 1.53 },

  /**
   * ── H3 video: launch flags and settings worth A/B-ing ──────────────────────
   *
   * Findings from a verified community survey (2026-08-18). NOT applied, because
   * every one of them touches the engine that currently renders music correctly,
   * and this project already shipped one launch flag that was reasoned about
   * rather than measured — `--novram`, which produced zero audio. Measure first.
   *
   *  `--fast-disk`   Real flag (cli_args.py:182), parses on this build: "prefer
   *                  disk-backed dynamic loading and offload over unpinned RAM".
   *                  One report measured ComfyUI RSS 45.4 -> 12.6 GiB on the same
   *                  model set. This box has 32 GB and a ~31 GB video set, which
   *                  is exactly that case — but it trades RAM for disk I/O, so it
   *                  is only a win if D: is fast.
   *  `--lowvram`     Reported a no-op under dynamic VRAM on this exact argv. Our
   *                  tiers are measured for the MUSIC path though, so removing it
   *                  is a music change, not a video one. Leave alone.
   *  `--async-offload 4`  The 4 is unsourced; the default is 2.
   *  `--use-ck-attention` / ModelAttentionBackend node — comfy_kitchen is present
   *                  and int8 attention is available. Ada is untested middle
   *                  ground between "no gain on a 5090" and "20-30% on a 3060".
   *                  ⚠ Vary the seed per run or ComfyUI's cache returns instantly
   *                  and fakes a win.
   *
   * Sampling, from practitioner reports rather than the template defaults:
   *   turbo LoRA at 6-8 steps, strength 0.75, er_sde + beta (4 steps is where the
   *   "metallic audio" complaints come from). Keep BasicGuider — CFGGuider doubles
   *   inference time for nothing here. MiniMaxH3SigmaShift 12/3 for the 8-step
   *   LoRA, 6/3 for the 4-step 768p one.
   *   Do NOT add VAEDecodeTiled: sd.py sets handles_tiling=True and the H3 video
   *   VAE already tiles internally at 256px / 17 frames.
   *   ⚠ Avoid EasyCache on this product: ~50% audio amplitude regression
   *   (ComfyUI issue 15326). A 25% speedup is not worth that in a music tool.
   */

  /**
   * Audio reference — start the render from a real song instead of from noise.
   *
   * Proven 2026-08-17. ComfyUI ships the DAV decoder only and `sd.py:534`
   * refuses to encode, but the encoder weights exist and its 121 decoder tensors
   * are BIT-IDENTICAL to ComfyUI's, so a latent we produce outside the process
   * is one the sampler already understands. Round trip through stock
   * `LoadLatent` -> `VAEDecodeAudio`: +26.26 dB SI-SDR, pearson 0.999.
   *
   * ⚠ WHAT THIS IS NOT. The reference steers the RENDER, not the composition —
   * that still comes from the caption through the free-running AR stage. So it
   * gives "this song's shape, a new sound", not "this song's tune with new
   * words". Extending an uploaded track remains impossible: that needs the AR
   * trajectory, and getting one from audio needs the RVQ tokenizer nobody
   * released.
   */
  audioRef: {
    // See the calibration table in workflow.js. 0.85 is the blend; lower keeps
    // more of the reference and 0.6 is effectively a copy.
    denoise: 0.85,
    /* Encoding is quadratic-ish in memory and a full track OOM'd the card while
     * the music stack was resident. 60 s is plenty to establish structure and
     * fits alongside everything else. */
    maxSeconds: 60,
    // Below this the reference reconstructs badly enough that it is worth
    // saying so — measured 22-25 dB on ordinary material, 6.6 dB on signals the
    // autoencoder has never seen anything like.
    warnBelowSdrDb: 12,
  },

  /**
   * Video clips — MiniMax H3, the 29 GB int4_convrot set.
   *
   * 🔴 LICENCE. The H3 Community Licence grants rights "solely within the
   * Applicable Territory", which EXCLUDES the European Union. Senzu was shown
   * this twice and chose to proceed for LOCAL TESTING ONLY, with a region
   * warning at download. That decision is recorded, not endorsed: nothing may
   * ship to EU users without the lawyer already handling the ToS work.
   * `enabled: false` is the default for exactly that reason.
   *
   * 🔑 int4_convrot is NATIVE on this card, nvfp4 is NOT. Verified by reading the
   * weights (`{"format":"convrot_w4a4"}`, present in `QUANT_ALGOS`) and by
   * `supports_nvfp4_compute` returning false on sm_89. The 12.5 GB nvfp4 DiT is
   * smaller but would run emulated; int4 is smaller AND native.
   *
   * ⚠ `length` must satisfy `n mod 17 == 5` — see `align_frame_count` in
   * comfy_extras/nodes_minimax_h3.py. 2 s at 24 fps = 56 frames. Passing any
   * other value silently gets rounded UP, so a "2 second" clip becomes longer
   * than the caller asked for.
   */
  video: {
    enabled: false,

    /* WHICH ENGINE. Two are supported and they are genuinely different tools.
     *
     * Measured here 2026-08-18, same prompt and seed, comparable resolution:
     *     H3  @ 8 steps  1344x768 x 124f   308 s
     *     H3  @ 20 steps 1344x768 x 124f   660 s
     *     LTX 2.5        1280x704 x 121f   121 s   <- and visibly better
     * LTX wins on both axes because of a two-pass schedule, not a faster model:
     * 8 steps at HALF resolution, a latent x2 upscale, then only 3 steps at full
     * size starting from sigma 0.85. Almost nothing is spent at full resolution.
     *
     * ⚠ They are NOT interchangeable in their settings. Different frame rules,
     * different valid sizes, different cost curves, different licences. Every
     * engine-specific value lives under `engines` below; nothing here is shared
     * except the switches a user thinks of as "video on/off". */
    engine: "ltx",
    engines: {

    /* ── MiniMax H3 ────────────────────────────────────────────────────────
     * Slower and heavier, region-locked, but it is what the shift/steps/native
     * -resolution work was measured on and it stays available. */
    h3: {
    label: "MiniMax H3",
    /* Measured build first, downloadable substitute second — see `pick` above.
     * The int4 DiT and the two cast VAEs exist only on this rig; a fresh install
     * gets the w4a8 DiT and the published fp16/fp32 VAEs from models.js. */
    dit: pick("diffusion_models",
      "minimax_h3_fl2va_pruned_int4_convrot.safetensors",
      "minimax_h3_fl2va_pruned-w4a8_convrot_pruned.safetensors"),
    textEncoder: pick("text_encoders",
      "qwen3vl_32b_minimax_h3-int4_convrot.safetensors"),
    videoVae: pick("vae",
      "minimax_h3_video_vae_int8_convrot.safetensors",
      "minimax_h3_video_vae_fp16.safetensors"),
    audioVae: pick("vae",
      "minimax_h3_audio_vae_bf16.safetensors",
      "minimax_h3_audio_vae_fp32.safetensors"),
    // Full-rank on purpose. The 440 MB resized-rank LoRA saves 1.5 GB and has
    // two independent reports of camera-movement degradation and I2V
    // prompt-following failure.
    /* The 8-step LoRA, matching our 8-step setting.
     *
     * We ran the 4-STEP 768p build at 8 steps, which is off its design point.
     * Both are on disk; `pick` prefers the matching one and falls back to the
     * 4-step build for anyone who only has that. */
    turboLora: pick("loras",
      "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
      "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors"),
    /* Strength of the turbo LoRA. 1.0 is the published default for this build;
     * community reports settle around 0.75-1.0 and lower is where the "metallic"
     * complaints start. Exposed because the LoRA was, until now, not applied at
     * all — so this value has never actually been exercised. */
    loraStrength: 1.0,

    /* When to make a clip automatically: off | all | starred | liked.
     *
     * This field was missing, which made the automatic trigger unreachable: it
     * read `want("video", "off")`, i.e. `"off" === "all"`, so it was false on
     * every path and no song ever got a clip without a hand-written API call.
     * `off` is still the default — 34 GB of weights and ~30 s a clip should not
     * start happening to people — but the setting now exists to be changed.
     */
    when: "off",

    /* 20, not 8.
     *
     * Measured 2026-08-18 at native size and 124 frames, same prompt and seed:
     *     turbo @  8   detail 38.0   308 s   clean but flat
     *     turbo @ 20   detail 88.8   660 s   VISIBLY the best — face, knit,
     *                                        lamp and bedding all resolve
     *     full  @ 30   detail 70.2   963 s   BROKEN: the face is a smear
     *
     * The last row is the useful one. Dropping the LoRA and running 30 steps
     * puts an UNDISTILLED model under BasicGuider, i.e. cfg 1 — and without
     * classifier-free guidance it does not follow the prompt. Testing that
     * properly needs CFGGuider and a negative, which this graph does not have.
     * So "more steps without the LoRA" is not a path we have, and its high
     * high-frequency score was artefact noise, not detail: that metric cannot
     * tell texture from mush, and the frames had to be looked at.
     *
     * 8 remains a good fast setting and the slider still reaches it. */
    steps: 20,
    sampler: "res_multistep",
    scheduler: "simple",

    /* 🔴 NATIVE RESOLUTION AND A TRAINED LENGTH. Both, or neither helps.
     *
     * We shipped 864x480 x 56 frames. The node's own defaults are 1344x768, and
     * its `length` tooltip says the TRAINED RANGE IS ~124-362 FRAMES — so we were
     * asking for 40% of the native pixel count at less than half the shortest
     * length the model has ever seen. That is the "vague, jittery, morphing"
     * report, and it is not a sampler setting.
     *
     * Measured 2026-08-18, same prompt and seed, variance-of-Laplacian detail:
     *     864x480  x  56f   49.1   <- what shipped
     *     864x480  x 124f   41.4   <- longer alone: no help
     *    1344x768  x  56f   48.3   <- bigger alone: no help
     *    1344x768  x 124f  131.2   <- BOTH: 2.7x the detail
     * High-frequency spectral share moved 40.4% -> 51.8% on the same pair.
     *
     * The interaction is the point: neither change on its own does anything.
     * It costs ~300 s a clip instead of ~54 s, which is the honest price of the
     * model working as intended, and the Video panel offers smaller/faster sizes
     * for anyone who would rather have speed. */
    width: 1344,
    height: 768,
    seconds: 5,
    fps: 24,

    /* Render-cost model, fitted to four measured points on this card:
     *   23.2 Mpx-frames -> 54 s | 51.4 -> 97 s | 57.8 -> 103 s | 128 -> 298 s
     * Superlinear because attention is quadratic in token count, so a linear
     * per-pixel rate under-quotes the native size badly. */
    costFixedSeconds: 15,
    costRate: 0.84,
    costExponent: 1.2,

    /* 🔑 shift_video 4, NOT the 12.0 default.
     *
     * Measured here 2026-08-18 across four seeds: shift 4 beat the default on
     * loop closure 4/4 and on flicker 4/4, at identical wall-clock. `ModelSamplingAV`
     * reduces the pair to one ratio (audio_scale = video/audio) and the node that
     * sets it appears in NEITHER official template — so the defaults ship unswept.
     * This is the video analogue of the two-CFG split in the music engine.
     *
     * ⚠ Magnitude is uncertain (+0.68 to +9.89 dB across seeds); the DIRECTION is
     * what four-for-four supports. Do not quote a headline number.
     *
     * 🔴 AND THE WHOLE SWEEP IS NOW SUSPECT. It was measured before the turbo
     * LoRA was wired in — that is, on the BASE model at 8 steps, which we now
     * know produces vague frames that barely follow the prompt. A shift tuned on
     * the undercooked path says little about the distilled one, and the vendor
     * note above recommends 6/3 for this 4-step 768p LoRA. Re-run
     * scripts/h3_sweep.mjs before trusting 4.0. Left at 4.0 rather than swapped
     * on a guess: it is the only value anything here was ever measured on.
     */
    shiftVideo: 4.0,
    shiftAudio: 3.0,

    /* H3 ALWAYS renders audio — there is no video-only path, and moving the
     * audio shift changes its level without changing the time it costs
     * (measured: identical wall-clock, audio RMS -14.1 to -27.6 dBFS). For a clip
     * that sits under a song we already made, that audio is discarded. */
    dropAudio: true,

    /* Frame rule. H3's `align_frame_count` rounds UP to n mod 17 == 5, silently,
     * so an unaligned request returns a longer clip than asked for. */
    frameRule: "mod17plus5",
    /* Sizes that are actually native. 40% of native pixels measured 2.7x worse. */
    sizes: [
      { w: 1344, h: 768, label: "1344 x 768 · native — best quality" },
      { w: 1280, h: 720, label: "1280 x 720 · 720p" },
      { w: 768, h: 1344, label: "768 x 1344 · vertical" },
      { w: 864, h: 480, label: "864 x 480 · fast, noticeably softer" },
    ],
    },

    /* ── LTX 2.5 ───────────────────────────────────────────────────────────
     * Lightricks. 5.5x faster than H3 at 20 steps and better by eye.
     *
     * 🔑 THE SPEED IS THE SCHEDULE, not the model. Two passes: 8 steps at half
     * resolution, LTXVLatentUpsampler x2 in LATENT space, then 3 steps at full
     * size starting at sigma 0.85. Step counts are baked into two literal sigma
     * strings, so there is no single `steps` number — which is exactly why the
     * cost model has to be per-engine.
     *
     * ⚠ LICENCE is a different shape from H3's. No territory restriction, but
     * the LTX-2.x Community Licence requires a paid agreement for entities with
     * annual revenue of $10,000,000 OR MORE, and Attachment A §20 forbids use in
     * a product competing with Lightricks' own offerings (they ship LTX Studio).
     * §6/§19 also forbid removing watermarking or provenance features. The HF
     * repo is access-gated: it needs an accepted licence and a token. */
    ltx: {
    label: "LTX 2.5",
    dit: "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
    textEncoder: "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
    /* ⚠ "-conv-". The vendor template's widget says ltx-2.5-video-vae-bf16 and
     * THAT FILE DOES NOT EXIST in the ComfyUI build of the repo. Copying the
     * template verbatim fails with "value not in list". */
    videoVae: "ltx-2.5-video-vae-conv-bf16.safetensors",
    audioVae: "ltx-2.5-audio-vae-bf16.safetensors",
    upscaler: "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",

    sampler: "euler_ancestral",
    /* The two schedules, verbatim from the vendor template. Pass 2 starts at
     * 0.85 rather than 1.0 — it is a partial re-denoise of an upscaled latent,
     * not a fresh render. */
    sigmasLow: "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0",
    sigmasHigh: "0.85, 0.7250, 0.4219, 0.0",

    /* ⚠ video_cfg MUST equal audio_cfg. nodes_lt.py only takes the cheap
     * single-CFG path when the two are close; differ, and every one of the 11
     * steps costs two forward passes instead of one. */
    videoCfg: 1.0,
    audioCfg: 1.0,
    negative: "pc game, console game, video game, cartoon, childish, ugly",

    seconds: 5,
    fps: 24,
    // LTX renders at HALF and doubles. These are the FINAL sizes; the graph
    // halves them, and both axes must survive //32 flooring or the upscale
    // lands somewhere the user did not ask for.
    width: 1280,
    height: 704,
    frameRule: "fpsPlus1",
    sizes: [
      { w: 1280, h: 704, label: "1280 x 704 · widescreen" },
      { w: 1600, h: 896, label: "1600 x 896 · large (slower)" },
      { w: 704, h: 1280, label: "704 x 1280 · vertical" },
      { w: 960, h: 544, label: "960 x 544 · fast" },
    ],

    /* Cost model, anchored on ONE measured point: 1280x704 x 121 frames = 121 s.
     * Deliberately marked as thin evidence — H3's curve took four points and this
     * has one, so the exponent is borrowed rather than fitted. Re-anchor once
     * there are more renders. */
    costFixedSeconds: 20,
    costRate: 0.31,
    costExponent: 1.2,

    // LTX renders real audio and a standalone clip has nothing underneath it.
    dropAudio: false,
    },

    },
  },

  /**
   * Cover art — FLUX.2 klein 4B, distilled.
   *
   * Chosen over Z-Image-Turbo and Krea-2-Turbo on three counts: it is the
   * smallest DiT of the three (4.07 GB official fp8), it is Apache-2.0 with no
   * content-filtering obligation attached, and ComfyUI 0.33 supports it natively
   * (`class Flux2`, supported_models.py:795) so no custom node is needed.
   *
   * 🔑 DISTILLED means cfg 1 and 4 steps. That is not a speed compromise — the
   * distillation IS the removal of classifier-free guidance, so raising cfg above
   * 1 does not "improve" anything, it drives the model off-distribution. The
   * undistilled base variant is the one that wants cfg 5 / 20 steps.
   *
   * The text encoder is shared with Z-Image-Turbo (both use Qwen3-4B), so adding
   * Z-Image later as an alternate look costs only its 5 GB DiT, not another
   * encoder.
   *
   * ⚠ fp16 encoder chosen deliberately. The 3.85 GB `qwen_3_4b_fp4_flux2` variant
   * is half the size but fp4 has native tensor-core support only on Blackwell
   * (RTX 50-series); this is an Ada card (sm_89), where it would be dequantised on
   * load. A shipped installer should pick precision from GPU ARCHITECTURE, not
   * just VRAM size.
   */
  art: {
    enabled: true,
    dit: "flux-2-klein-4b-fp8.safetensors",
    textEncoder: "qwen_3_4b.safetensors",
    vae: "flux2-vae.safetensors",
    steps: 4,
    cfg: 1,          // see above — 1 is correct for the distilled model
    size: 1024,      // klein's native training resolution
    // What the library list actually loads. The full 1024² is kept for the song
    // panel and the full-screen player, where it is one image rather than fifty.
    thumbSize: 256,
    sampler: "euler",
    /**
     * FIXED look, varying subject. Measured, not guessed — three drafts were
     * rendered across abstract and concrete genres before this one.
     *
     * Fifty covers generated freely per song clash with each other and turn the
     * library into noise, which is precisely what the deterministic gradients
     * already avoid. So the style half never changes; only the subject, drawn
     * from the song's own caption, does.
     *
     * 🔑 TWO failures this wording exists to avoid — do not "tidy" them back in:
     *
     *  1. NEVER say "album cover". That phrase summons the album-cover
     *     CONVENTION, which includes a title, and the model renders garbled
     *     lettering across the top ("DEPMESIIN HOD JISLARK"). Framing it as a
     *     photograph removes the text problem at the source. The explicit
     *     no-text clause is belt-and-braces on top.
     *  2. NEVER stack "minimalist" + "restrained palette" + "generous negative
     *     space" together. Those compound into literal emptiness: on an abstract
     *     caption like "dark synthwave, analog pads" the first draft returned a
     *     black frame with a grey corner and no subject at all. Genre words are
     *     not visual nouns, so the prompt has to DEMAND a tangible object.
     */
    style: "fine art photograph, one tangible object as the subject, tight crop, "
         + "strong directional light, deep shadow, restrained colour palette, "
         + "subtle film grain, no text, no words, no letters, no signage",
  },

  // Community is advertising, not the draw (HANDOVER §1). One anonymous, cached,
  // versioned endpoint; everything else links out to the browser where the user
  // is already signed in.
  community: {
    // Live on DEV as of 2026-08-17 (endpoints/desktop/feed_GET.ts + a routes.ts
    // entry — routes are a manifest, not filesystem discovery). Prod does not
    // have it yet, so point at dev until it ships.
    feedUrl: process.env.AIPLAY_FEED || "https://dev.aiplay.live/_api/desktop/feed",
    /**
     * ⚠ DERIVED from feedUrl, never written out by hand.
     *
     * These were hardcoded to `https://aiplay.live` while the feed pointed at
     * dev, so every Join button sent the user to the PRODUCTION site to open a
     * session id that only exists on dev — a guaranteed 404. Tying both to the
     * feed's own origin means the two can never disagree again: point the feed
     * at prod and the links follow.
     *
     * The feed itself also emits `/session/<id>` (singular), which is not a real
     * route — it is `/sessions/<id>`. That is a bug in the dev endpoint
     * (app/endpoints/desktop/feed_GET.ts); until it is fixed there, the proxy in
     * index.js rewrites it.
     */
    get site() { return new URL(this.feedUrl).origin; },
    get sessions() { return `${new URL(this.feedUrl).origin}/sessions`; },
    refreshMs: 120_000,
  },

  paths: { appData: path.join(os.homedir(), ".aiplay-studio") },
};
