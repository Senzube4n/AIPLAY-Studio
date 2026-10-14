/** Dataset and training controller for the ACE-Step 1.5 HTTP API. */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, mkdir, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { containedFile, jsonStore, readJSON } from "../engine/remote-common.js";

const AUDIO = /\.(mp3|wav|flac|ogg|opus)$/i;
const MAX_AUDIO = 512 * 1024 * 1024;

const cleanName = value => String(value || "").trim().replace(/\.[^.]*$/, "")
  .replace(/[^A-Za-z0-9 _-]/g, "").replace(/\s+/g, "_").slice(0, 48);
const modelId = value => {
  const id = String(value || "");
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid custom model ID.");
  return id;
};
const clamp = (value, min, max, fallback) => {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

export async function createAceTraining({ rootDir, lorasDir, aceURL = "http://127.0.0.1:8001", fetchFn = fetch }) {
  const base = new URL(aceURL);
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) {
    throw new Error("ACE-Step must be on the same machine as the AIPLAY service.");
  }
  const stateFile = path.join(rootDir, "models.json");
  const state = await readJSON(stateFile, { models: {} });
  const save = jsonStore(stateFile);
  await mkdir(rootDir, { recursive: true });
  await save(state);
  const request = async (route, init = {}) => {
    let response;
    try {
      response = await fetchFn(`${base.href.replace(/\/+$/, "")}${route}`, {
        ...init, redirect: "error", signal: init.signal || AbortSignal.timeout(30_000),
      });
    } catch (error) { throw new Error(`ACE-Step is not reachable: ${error.message || error}`); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) throw new Error(String(body.detail || body.error || `ACE-Step returned HTTP ${response.status}.`).slice(0, 1000));
    return body.data ?? body;
  };
  const post = (route, body, timeout = 30_000) => request(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  const row = id => {
    const found = state.models[modelId(id)];
    if (!found) throw new Error("Unknown custom model.");
    return found;
  };
  const paths = item => {
    const dir = path.join(rootDir, item.id);
    return { dir, audio: path.join(dir, "audio"), tensors: path.join(dir, "tensors"), output: path.join(dir, "output") };
  };
  const publicRow = item => ({ ...item, paths: undefined });
  async function available() {
    try {
      await request("/health", { signal: AbortSignal.timeout(3000) });
      if (!state.aceSeen) { state.aceSeen = true; await save(state); }
      return true;
    } catch { return false; }
  }
  async function list() {
    return { available: await available(), models: Object.values(state.models).map(publicRow).sort((a, b) => b.createdAt - a.createdAt) };
  }
  async function activity() {
    if (!await available()) return { known: !state.aceSeen, busy: !!state.aceSeen };
    try {
      // Completion/adoption must progress on the worker even after the desktop
      // has closed. A stale persisted "training" flag is not evidence of work.
      for (const item of Object.values(state.models)) if (["preparing", "training", "finishing"].includes(item.stage)) await check(item.id);
      const status = await request("/v1/training/status");
      if (typeof status.is_training !== "boolean") return { known: false, busy: true };
      return { known: true, busy: status.is_training || Object.values(state.models).some(m => ["preparing", "training", "finishing"].includes(m.stage)) };
    } catch { return { known: false, busy: true }; }
  }
  async function create({ name, style = "", instrumental = false } = {}) {
    const stem = cleanName(name);
    if (!stem) throw new Error("Give the custom model a name.");
    const id = randomUUID();
    const item = { id, name: stem.replaceAll("_", " "), adapter: `mine_${stem}.safetensors`, style: String(style || "").trim().slice(0, 1000),
      instrumental: !!instrumental, files: [], stage: "draft", createdAt: Date.now(), updatedAt: Date.now(), error: null };
    state.models[id] = item;
    const p = paths(item); await Promise.all([p.audio, p.tensors, p.output].map(dir => mkdir(dir, { recursive: true })));
    await save(state); return publicRow(item);
  }
  async function receive(item, name, stream) {
    const suppliedName = String(name || "");
    const filename = path.basename(suppliedName);
    if (!filename || filename !== suppliedName || /[\\/]/.test(suppliedName)) throw new Error("Invalid audio filename.");
    if (!AUDIO.test(filename)) throw new Error("Use MP3, WAV, FLAC, OGG or Opus audio.");
    const p = paths(item), ext = path.extname(filename).toLowerCase();
    const baseName = cleanName(path.basename(filename, ext)) || `track_${item.files.length + 1}`;
    const unique = `${String(item.files.length + 1).padStart(2, "0")}_${baseName}${ext}`;
    const target = path.join(p.audio, unique), temp = `${target}.${randomUUID()}.part`;
    let bytes = 0;
    try {
      await pipeline(stream, new Transform({ transform(chunk, enc, callback) {
        bytes += chunk.length;
        callback(bytes > MAX_AUDIO ? new Error("An audio file exceeds 512 MiB.") : null, chunk);
      } }), createWriteStream(temp, { flags: "wx" }));
      if (!bytes) throw new Error("The audio file is empty.");
      await rename(temp, target);
    } finally { await unlink(temp).catch(() => {}); }
    await writeFile(`${target}.caption.txt`, item.style || item.name, "utf8");
    await writeFile(`${target}.lyrics.txt`, item.instrumental ? "[Instrumental]" : "", "utf8");
    item.files.push({ name: unique, source: filename, bytes }); item.updatedAt = Date.now(); item.stage = "draft"; item.error = null;
    await save(state); return publicRow(item);
  }
  async function upload(id, name, stream) { return receive(row(id), name, stream); }
  async function addLibrary(id, files, sourceRoot) {
    const item = row(id);
    for (const relative of [...new Set(Array.isArray(files) ? files : [])].slice(0, 100)) {
      const source = await containedFile(sourceRoot, relative);
      const info = await stat(source);
      if (!info.isFile() || !AUDIO.test(source)) throw new Error(`Unsupported library song: ${path.basename(relative)}`);
      await receive(item, path.basename(relative), createReadStream(source));
    }
    return publicRow(item);
  }
  async function prepare(id) {
    const item = row(id), p = paths(item);
    if (!item.files.length) throw new Error("Add at least one song before preparing the dataset.");
    await post("/v1/dataset/scan", { audio_dir: p.audio, dataset_name: item.name, custom_tag: item.name, tag_position: "append", all_instrumental: item.instrumental });
    const task = await post("/v1/dataset/preprocess_async", { output_dir: p.tensors, skip_existing: true });
    item.preprocessTaskId = task.task_id || task.id || null; item.stage = "preparing"; item.error = null; item.updatedAt = Date.now();
    await save(state); return { model: publicRow(item), task };
  }
  async function adopt(item) {
    const p = paths(item), found = [];
    async function walk(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && entry.name.endsWith(".safetensors")) found.push({ full, info: await stat(full) });
      }
    }
    await walk(p.output); found.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
    if (!found[0]) return null;
    await mkdir(lorasDir, { recursive: true });
    const target = path.join(lorasDir, item.adapter); await cp(found[0].full, target);
    item.result = { name: item.adapter, bytes: found[0].info.size, at: Date.now() }; item.stage = "complete"; item.updatedAt = Date.now();
    await save(state); return item.result;
  }
  async function check(id) {
    const item = row(id); let upstream = null;
    if (item.stage === "preparing") {
      const suffix = item.preprocessTaskId ? `/${encodeURIComponent(item.preprocessTaskId)}` : "";
      upstream = await request(`/v1/dataset/preprocess_status${suffix}`);
      const status = String(upstream.status || "").toLowerCase();
      if (["completed", "complete", "success", "succeeded"].includes(status)) item.stage = "ready";
      if (["failed", "error"].includes(status)) { item.stage = "failed"; item.error = upstream.error || upstream.message || "Dataset preparation failed."; }
    } else if (item.stage === "training") {
      upstream = await request("/v1/training/status");
      if (!upstream.is_training) {
        const status = String(upstream.status || "").toLowerCase();
        if (upstream.error || status.includes("fail") || status.includes("error")) { item.stage = "failed"; item.error = upstream.error || upstream.status; }
        else if (!await adopt(item)) item.stage = status === "idle" ? "ready" : "finishing";
      }
    } else if (item.stage === "finishing") await adopt(item);
    item.updatedAt = Date.now(); await save(state);
    return { model: publicRow(item), upstream };
  }
  async function start(id, settings = {}) {
    const item = row(id), p = paths(item);
    if (item.stage !== "ready" && item.stage !== "failed") throw new Error("Prepare the dataset before training.");
    const epochs = clamp(settings.epochs, 1, 2000, 800), rank = clamp(settings.rank, 1, 256, 64);
    const body = { tensor_dir: p.tensors, lora_rank: rank, lora_alpha: Math.min(512, rank * 2), lora_dropout: 0.1,
      learning_rate: 0.0001, train_epochs: epochs, train_batch_size: 1, gradient_accumulation: 4,
      save_every_n_epochs: Math.max(1, Math.min(50, Math.round(epochs / 10))), training_shift: 3,
      training_seed: 42, lora_output_dir: p.output, use_fp8: false, gradient_checkpointing: !!settings.gradientCheckpointing };
    const upstream = await post("/v1/training/start", body);
    item.stage = "training"; item.settings = { epochs, rank, gradientCheckpointing: !!settings.gradientCheckpointing };
    item.error = null; item.updatedAt = Date.now(); await save(state);
    return { model: publicRow(item), upstream };
  }
  async function stop(id) {
    const item = row(id); const upstream = await post("/v1/training/stop", {});
    item.stage = "stopped"; item.updatedAt = Date.now(); await save(state); return { model: publicRow(item), upstream };
  }
  async function remove(id) {
    const item = row(id);
    if (["preparing", "training"].includes(item.stage)) throw new Error("Stop this model before deleting it.");
    await rm(paths(item).dir, { recursive: true, force: true });
    delete state.models[item.id]; await save(state); return { ok: true };
  }
  return { list, create, upload, addLibrary, prepare, check, start, stop, remove, available, activity };
}
