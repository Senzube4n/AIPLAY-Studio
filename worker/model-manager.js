/** Curated, authenticated model installs for the RunPod worker.
 *
 * The desktop may select only bundle IDs defined here. It never supplies a URL,
 * destination path or checksum, so the worker cannot become a remote shell or
 * arbitrary file downloader.
 */
import path from "node:path";
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { hashFile } from "../server/engine/remote-common.js";

export const MODEL_BUNDLES = Object.freeze({
  "ltx25": Object.freeze({
    label: 'LTX 2.5 video', description: 'The distilled video model and its text encoder, VAEs and upscaler.',
    licenseUrl: 'https://huggingface.co/Lightricks/LTX-2.5', requiresToken: true,
    totalBytes: 39689918812,
    files: Object.freeze([
      ['diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors', 21504034224, 'c4279eeff115cbeaca494bd2183e7d768c38fe85a184dc6afbb7159157c44334'],
      ['text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors', 15372969374, '6ce688a0aa98a5fa36a9f1e6c3f42152a498cc2b53ee8c15674c64244f91487f'],
      ['vae/ltx-2.5-video-vae-conv-bf16.safetensors', 1452269922, '685b06ee3d9b2039647698fc4ea33175112462fc374e2777312c907897dfce8d'],
      ['vae/ltx-2.5-audio-vae-bf16.safetensors', 364866540, 'c52733d37f6a7fb7949c3dc0fb468c6cb2169e4d836983a73babb9f0d54837a5'],
      ['latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors', 995778752, 'eb5a71fe4068ee87ccdb1c3aa635e547ca76bd2d30ae20ae889f2c325c0677e8'],
    ].map(([relative, bytes, sha256]) => Object.freeze({ relative, bytes, sha256,
      url: `https://huggingface.co/Lightricks/LTX-2.5/resolve/49b093a39c19169a8a81721dcc541e07e945232f/${relative}` }))),
  }),
  "sdxl-turbo": Object.freeze({
    label: "SDXL Turbo pictures", description: "A compact picture checkpoint for the standard ComfyUI workflow.",
    licenseUrl: "https://huggingface.co/stabilityai/sdxl-turbo", totalBytes: 6938081905,
    files: Object.freeze([Object.freeze({ relative: "checkpoints/sd_xl_turbo_1.0_fp16.safetensors", bytes: 6938081905,
      sha256: "e869ac7d6942cb327d68d5ed83a40447aadf20e0c3358d98b2cc9e270db0da26",
      url: "https://huggingface.co/stabilityai/sdxl-turbo/resolve/71153311d3dbb46851df1931d3ca6e939de83304/sd_xl_turbo_1.0_fp16.safetensors" })]),
  }),
  "yue2-comfy": Object.freeze({
    label: "YuE2 3B for ComfyUI",
    description: "Text-to-music checkpoint used by AIPLAY's YuE2 ComfyUI workflow.",
    licenseUrl: "https://huggingface.co/Comfy-Org/YuE2",
    totalBytes: 3960938800,
    files: Object.freeze([Object.freeze({
      relative: "checkpoints/yue2_3b_int8_convrot.safetensors",
      bytes: 3960938800,
      sha256: "96fe199377309001ed8cd26a944baeee8cc31a20ba7c36d1d3c0a7e1f4149db6",
      url: "https://huggingface.co/Comfy-Org/YuE2/resolve/8e6fcf0f23252ed188b634bd50d44f4b01fba890/checkpoints/yue2_3b_int8_convrot.safetensors",
    })]),
  }),
});

const exists = async (file) => stat(file).catch(() => null);
const publicBundle = (id, bundle, live = {}) => ({
  id, label: bundle.label, description: bundle.description, licenseUrl: bundle.licenseUrl,
  totalBytes: bundle.totalBytes, requiresToken: !!bundle.requiresToken, state: live.state || "missing",
  downloadedBytes: live.downloadedBytes || 0, error: live.error || null,
});

export async function createModelManager({ modelsDir, fetchFn = fetch, bundles = MODEL_BUNDLES }) {
  if (!path.isAbsolute(modelsDir)) throw new Error("The worker models directory must be absolute.");
  const live = new Map();
  let active = null;

  async function valid(file, spec) {
    const info = await exists(file);
    return !!info && info.isFile() && info.size === spec.bytes && await hashFile(file) === spec.sha256;
  }

  async function inspect(id) {
    const bundle = bundles[id];
    if (!bundle) throw new Error("Unknown model bundle.");
    const ready = (await Promise.all(bundle.files.map((spec) => valid(path.join(modelsDir, spec.relative), spec)))).every(Boolean);
    const previous = live.get(id) || {};
    if (!active || active.id !== id) live.set(id, ready
      ? { state: "ready", downloadedBytes: bundle.totalBytes }
      : { state: previous.state === "paused" ? "paused" : "missing", downloadedBytes: 0, error: previous.error || null });
    return ready;
  }

  async function adoptKnownCandidate(finalFile, spec) {
    for (const suffix of [".aiplay-part", ".part", ".fresh"]) {
      const candidate = `${finalFile}${suffix}`;
      const info = await exists(candidate);
      if (!info) continue;
      if (await valid(candidate, spec)) {
        await unlink(finalFile).catch(() => {});
        await rename(candidate, finalFile);
        return true;
      }
      // These names belong only to this curated file. An explicit repair action
      // may remove an invalid one, preventing a repeated multi-gigabyte failure.
      if (suffix !== ".aiplay-part") await unlink(candidate).catch(() => {});
    }
    return false;
  }

  async function download(id, bundle, controller, modelToken) {
    let complete = 0;
    for (const spec of bundle.files) {
      const finalFile = path.join(modelsDir, spec.relative);
      await mkdir(path.dirname(finalFile), { recursive: true });
      if (await valid(finalFile, spec) || await adoptKnownCandidate(finalFile, spec)) {
        complete += spec.bytes;
        live.set(id, { state: "downloading", downloadedBytes: complete });
        continue;
      }
      const part = `${finalFile}.aiplay-part`;
      let offset = (await exists(part))?.size || 0;
      if (offset >= spec.bytes) { await unlink(part).catch(() => {}); offset = 0; }
      const response = await fetchFn(spec.url, { headers: { ...(offset ? { Range: `bytes=${offset}-` } : {}),
        ...(bundle.requiresToken ? { Authorization: `Bearer ${modelToken}` } : {}) },
        redirect: "follow", signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`Model host returned HTTP ${response.status}.`);
      const contentRange = response.headers.get("content-range") || "";
      const append = offset > 0 && response.status === 206 && contentRange.startsWith(`bytes ${offset}-`);
      if (offset > 0 && response.status === 206 && !append) throw new Error("Model host returned an invalid resume range.");
      if (!append) offset = 0;
      let received = offset;
      live.set(id, { state: "downloading", downloadedBytes: complete + received });
      const meter = new Transform({ transform(chunk, encoding, callback) {
        received += chunk.length;
        if (received > spec.bytes) return callback(new Error("Model download exceeded its verified size."));
        live.set(id, { state: "downloading", downloadedBytes: complete + received });
        callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(part, { flags: append ? "a" : "w" }));
      if (!await valid(part, spec)) {
        await unlink(part).catch(() => {});
        throw new Error("Downloaded model failed its size or SHA-256 verification; the invalid temporary file was removed.");
      }
      await unlink(finalFile).catch(() => {});
      await rename(part, finalFile);
      complete += spec.bytes;
    }
    live.set(id, { state: "ready", downloadedBytes: bundle.totalBytes });
  }

  function snapshot() {
    return { version: 1, active: active?.id || null,
      bundles: Object.entries(bundles).map(([id, bundle]) => publicBundle(id, bundle, live.get(id))) };
  }

  async function install(id, accepted, modelToken) {
    const bundle = bundles[id];
    if (!bundle) throw new Error("Unknown model bundle.");
    if (accepted !== true) throw new Error("Review and accept the model repository terms before installing.");
    if (active) throw new Error(`${bundles[active.id].label} is already downloading.`);
    if (await inspect(id)) return snapshot();
    if (bundle.requiresToken && (typeof modelToken !== 'string' || !/^hf_[A-Za-z0-9]{10,490}$/.test(modelToken)))
      throw new Error('Accept access on the model page and enter a Hugging Face read token.');
    const controller = new AbortController();
    active = { id, controller };
    live.set(id, { state: "downloading", downloadedBytes: 0 });
    download(id, bundle, controller, modelToken).catch((error) => {
      live.set(id, { state: controller.signal.aborted ? "paused" : "failed",
        downloadedBytes: live.get(id)?.downloadedBytes || 0,
        error: controller.signal.aborted ? null : String(error.message || error).slice(0, 500) });
    }).finally(() => { active = null; });
    return snapshot();
  }

  function cancel() {
    if (active) active.controller.abort();
    return snapshot();
  }

  for (const id of Object.keys(bundles)) await inspect(id);
  return { status: snapshot, install, cancel, inspect };
}
