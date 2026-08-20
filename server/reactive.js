/**
 * Audio-reactive video, on a SECOND ComfyUI.
 *
 * WHY A SECOND ENGINE. This feature needs ComfyUI_Yvann-Nodes, AnimateDiff-Evolved,
 * Advanced-ControlNet and IPAdapter_plus. Those are GPL-3.0, and Studio is
 * Apache-2.0, so they cannot ship here. They also cannot go in Studio's own
 * ComfyUI without changing what a Studio install is. So they live in a separate
 * instance the user sets up themselves, and Studio talks to it over HTTP — the
 * same arms-length boundary that already applies to ComfyUI itself. Nothing is
 * linked, nothing is bundled, and with no second engine configured this whole
 * feature simply reports itself unavailable.
 *
 * WHAT MAKES IT REACTIVE. `Audio IPAdapter Transitions` emits image_1 with
 * `weights` AND image_2 with `weights_invert`, feeding TWO IPAdapterBatch nodes
 * at once. Every frame is therefore conditioned on a weighted mix of two
 * pictures, and the mix travels with the audio. Measured against our own engine:
 * LTXVAddGuide pins ONE picture at ONE frame index and cannot blend at all, so
 * this is not a thing Studio's LTX path can be talked into doing.
 */
import { config } from "./config.js";

/* Defaults to a second ComfyUI on 8288. Overridable so it can live on another
 * machine — there is no reason the reactive engine has to share this GPU. */
const HOST = config.reactive?.host ?? "127.0.0.1";
const PORT = config.reactive?.port ?? 8288;
export const BASE = `http://${HOST}:${PORT}`;

/** Nodes that must exist, and the pack each comes from — so a missing pack can
 *  be named rather than reported as a generic failure. */
const REQUIRED = [
  ["Audio Analysis", "ComfyUI_Yvann-Nodes"],
  ["Audio Peaks Detection", "ComfyUI_Yvann-Nodes"],
  ["Audio IPAdapter Transitions", "ComfyUI_Yvann-Nodes"],
  ["Load Audio Separation Model", "ComfyUI_Yvann-Nodes"],
  ["IPAdapterUnifiedLoader", "ComfyUI_IPAdapter_plus"],
  ["IPAdapterBatch", "ComfyUI_IPAdapter_plus"],
  ["ADE_UseEvolvedSampling", "ComfyUI-AnimateDiff-Evolved"],
  ["ADE_LoopedUniformContextOptions", "ComfyUI-AnimateDiff-Evolved"],
  ["VHS_LoadVideo", "ComfyUI-VideoHelperSuite"],
];

/**
 * Is the reactive engine there, and does it have what this needs?
 *
 * Returns the missing PACKS rather than the missing nodes: "install
 * ComfyUI-AnimateDiff-Evolved" is actionable, "ADE_UseEvolvedSampling is
 * missing" is a puzzle.
 */
export async function status() {
  let info;
  try {
    const r = await fetch(`${BASE}/object_info`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { ok: false, reachable: false, base: BASE, reason: `engine answered ${r.status}` };
    info = await r.json();
  } catch {
    return { ok: false, reachable: false, base: BASE, reason: "no engine on this address" };
  }
  const missingPacks = [...new Set(REQUIRED.filter(([n]) => !info[n]).map(([, p]) => p))];
  /* ⚠ Only SOME nodes inline their combo options. CheckpointLoaderSimple lists
   * its checkpoints; ADE_LoadAnimateDiffModel reports the bare string "COMBO"
   * and resolves its list lazily. Reading `[0]` and testing `.length` therefore
   * "passed" on the five characters of the word COMBO -- a readiness check that
   * could not fail, which is worse than not checking. Only trust a real array. */
  const asList = (v) => (Array.isArray(v) ? v : null);
  const ckpts = asList(info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]) ?? [];
  const motion = asList(info.ADE_LoadAnimateDiffModel?.input?.required?.model_name?.[0]);
  return {
    /* The motion module cannot be verified from here, so it is not claimed. A
     * missing one fails at sample time with the engine's own message, which is
     * honest; asserting it is present would not be. */
    ok: missingPacks.length === 0 && ckpts.length > 0,
    reachable: true, base: BASE, missingPacks,
    checkpoints: ckpts, motionModels: motion,      // null when the engine will not say
    /* A pack can be present while its weights are not, and that fails at sample
     * time with a stack trace rather than at submit time with a sentence. */
    missingModels: ckpts.length ? [] : ["an SD1.5 checkpoint"],
  };
}

/** Shared head: checkpoint, audio analysis, peak detection. */
function audioHead(g, { ckpt, audio, frames, fps, band, threshold, minGap }) {
  g[1] = { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ckpt } };
  g[2] = { class_type: "LoadAudio", inputs: { audio } };
  g[3] = { class_type: "Load Audio Separation Model", inputs: { model: "Hybrid Demucs" } };
  g[4] = { class_type: "Audio Analysis", inputs: {
    audio_sep_model: ["3", 0], batch_size: frames, fps, audio: ["2", 0],
    analysis_mode: band, threshold: 0.5, multiply: 1.0 } };
  g[5] = { class_type: "Audio Peaks Detection", inputs: {
    audio_weights: ["4", 2], peaks_threshold: threshold, min_peaks_distance: minGap } };
}

/** Shared tail: IPAdapter pair, AnimateDiff, sampler, save. */
function styleAndSample(g, { images, latentNode, denoise, motionModel, prompt, negative, seed, steps, fps, transition }) {
  // pictures -> one batch (ImageBatch takes two at a time)
  images.forEach((n, i) => { g[10 + i] = { class_type: "LoadImage", inputs: { image: n } }; });
  let batch = ["10", 0];
  for (let i = 1; i < images.length; i++) {
    const id = 20 + i;
    g[id] = { class_type: "ImageBatch", inputs: { image1: batch, image2: [String(10 + i), 0] } };
    batch = [String(id), 0];
  }
  /* THE REACTIVE STEP. Two image streams with complementary per-frame weights,
   * both live at once — this is the blend, and it is the part our own engine
   * has no equivalent for. */
  g[30] = { class_type: "Audio IPAdapter Transitions", inputs: {
    images: batch, peaks_weights: ["5", 0], transition_mode: "linear",
    transition_length: transition, min_IPA_weight: 0.0, max_IPA_weight: 1.0 } };
  g[40] = { class_type: "IPAdapterUnifiedLoader", inputs: { model: ["1", 0], preset: "PLUS (high strength)" } };
  g[41] = { class_type: "IPAdapterBatch", inputs: {
    model: ["40", 0], ipadapter: ["40", 1], image: ["30", 0], weight: ["30", 1],
    weight_type: "linear", start_at: 0.0, end_at: 1.0, embeds_scaling: "V only", encode_batch_size: 0 } };
  g[42] = { class_type: "IPAdapterBatch", inputs: {
    model: ["41", 0], ipadapter: ["40", 1], image: ["30", 2], weight: ["30", 3],
    weight_type: "linear", start_at: 0.0, end_at: 1.0, embeds_scaling: "V only", encode_batch_size: 0 } };

  g[50] = { class_type: "ADE_LoadAnimateDiffModel", inputs: { model_name: motionModel } };
  g[51] = { class_type: "ADE_ApplyAnimateDiffModelSimple", inputs: { motion_model: ["50", 0] } };
  /* MANDATORY above 32 frames. v3_sd15_mm refuses outright without it:
   * "upper limit of 32 frames, but received 96 latents". */
  g[53] = { class_type: "ADE_LoopedUniformContextOptions", inputs: {
    context_length: 16, context_stride: 1, context_overlap: 4, closed_loop: false,
    fuse_method: "pyramid", use_on_equal_length: false, start_percent: 0.0, guarantee_steps: 1 } };
  g[52] = { class_type: "ADE_UseEvolvedSampling", inputs: {
    model: ["42", 0], beta_schedule: "autoselect", m_models: ["51", 0], context_options: ["53", 0] } };

  g[60] = { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: prompt } };
  g[61] = { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: negative } };
  g[63] = { class_type: "KSampler", inputs: {
    model: ["52", 0], positive: ["60", 0], negative: ["61", 0], latent_image: latentNode,
    seed, steps, cfg: 7.0, sampler_name: "euler", scheduler: "normal", denoise } };
  g[64] = { class_type: "VAEDecode", inputs: { samples: ["63", 0], vae: ["1", 2] } };
  g[65] = { class_type: "SaveAnimatedWEBP", inputs: {
    images: ["64", 0], filename_prefix: "reactive/r", fps, lossless: false, quality: 90, method: "default" } };
}

/**
 * Build one of the three graphs.
 *
 * The prompt stays near-generic on purpose. Measured repeatedly: a prompt that
 * describes the look leaves the reference images nothing to contribute, and one
 * that names a subject invents that subject instead of using the pictures. The
 * style is supposed to come from the images.
 */
export function buildGraph(mode, o) {
  const {
    audio, images = [], video = null, ckpt, motionModel,
    width = 512, height = 512, frames = 96, fps = 12, seed = 31337, steps = 20,
    band = "Drums Only", threshold = 0.4, minGap = 5, transition = 5,
    denoise = mode === "video" ? 0.62 : 1.0,
    prompt = "4k, beautiful, high quality, highly detailled, art",
    negative = "poorly drawn, bad anatomy, ugly, low quality, low-res, worst quality, "
      + "blurry, cropped, out of frame, jpeg artifacts, watermark, text",
  } = o;

  const g = {};
  audioHead(g, { ckpt, audio, frames, fps, band, threshold, minGap });

  let latentNode;
  if (mode === "video") {
    if (!video) throw new Error("video mode needs a source clip");
    /* Structure AND motion come from the source. Yvann holds them with depth and
     * lineart ControlNets, but those need comfyui_controlnet_aux, whose
     * requirements list torch and torchvision — and a wrong torch build here is
     * a silent 4.9x slowdown. Encoding the frames and denoising PARTIALLY gives
     * the same hold with no new dependency: the picture starts as the video. */
    g[6] = { class_type: "VHS_LoadVideo", inputs: {
      video, force_rate: fps, custom_width: width, custom_height: height,
      frame_load_cap: frames, skip_first_frames: 0, select_every_nth: 1, format: "AnimateDiff" } };
    g[7] = { class_type: "ImageScale", inputs: {
      image: ["6", 0], upscale_method: "lanczos", width, height, crop: "disabled" } };
    g[8] = { class_type: "VAEEncode", inputs: { pixels: ["7", 0], vae: ["1", 2] } };
    latentNode = ["8", 0];
  } else {
    g[9] = { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: frames } };
    latentNode = ["9", 0];
  }

  /* Text mode still needs pictures for the IPAdapter pair — without them there
   * is no blend and nothing to react WITH. What "text" changes is that the
   * prompt, not a source clip, decides the scene. */
  if (!images.length) throw new Error("at least two reference images are needed for the blend");
  styleAndSample(g, { images, latentNode, denoise, motionModel, prompt, negative, seed, steps, fps, transition });
  return g;
}

/** Submit and wait. Returns the produced file's name and subfolder. */
export async function run(graph, { timeoutMs = 30 * 60 * 1000 } = {}) {
  const r = await fetch(`${BASE}/prompt`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph }),
  });
  if (!r.ok) throw new Error(`engine refused the graph: ${(await r.text()).slice(0, 400)}`);
  const { prompt_id } = await r.json();
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for the reactive engine");
    await new Promise((s) => setTimeout(s, 2000));
    let e;
    try {
      const h = await (await fetch(`${BASE}/history/${prompt_id}`)).json();
      e = h[prompt_id];
    } catch { continue; }          // engine restarting mid-render is not fatal to the poll
    if (!e) continue;
    if (e.status?.status_str === "error") {
      const msg = JSON.stringify(e.status.messages || "");
      throw new Error(msg.slice(0, 600));
    }
    if (e.status?.completed) {
      const out = Object.values(e.outputs || {}).flatMap((x) => x.images || x.gifs || x.videos || [])[0];
      if (!out) throw new Error("the engine finished but produced no file");
      return { file: out.filename, subfolder: out.subfolder || "", seconds: Math.round((Date.now() - started) / 1000) };
    }
  }
}
