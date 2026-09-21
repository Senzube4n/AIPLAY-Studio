/** Local, read-only admission checks for paired YuE2 listening experiments. */
import path from "node:path";
import { mkdir, readFile, readdir, writeFile, rename, rm, realpath, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { probeModel } from "../detect.js";
import { audioHash, audioName } from "./auditions.js";
import { probeTrainAudio } from "./train.js";

const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
const nameOf = value => typeof value === "string" && value.length <= 255 && !/[\\/:\0]|\.\./.test(value) && /\.safetensors$/i.test(value)
  ? value : fail("Choose a model filename from the local shelf.", 400);
const runOf = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : fail("Invalid training run identifier.", 400);
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const stamp = info => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
async function fileState(file) {
  const full = await realpath(file), info = await stat(full, { bigint: true });
  if (!info.isFile() || info.size <= 0n) fail("The selected file is missing or empty.");
  return { full, signature: stamp(info), bytes: Number(info.size) };
}
async function unchanged(file, before) {
  const after = await fileState(file);
  if (!samePath(after.full, before.full) || after.signature !== before.signature) fail("The selected file changed while it was being inspected. Try again.");
}

const receiptDirectory = appData => path.join(appData, "music-training-receipts");
const receiptPath = (appData, runId) => path.join(receiptDirectory(appData), `${runOf(runId)}.json`);
const receiptLocks = new Map();
async function receiptLock(file, work) {
  const previous = receiptLocks.get(file) || Promise.resolve(), pending = previous.catch(() => {}).then(work);
  receiptLocks.set(file, pending);
  try { return await pending; }
  finally { if (receiptLocks.get(file) === pending) receiptLocks.delete(file); }
}
const CONDITIONING = "source-audio-encode-only";
function trainingInput(value) {
  if (!value || typeof value !== "object") fail("Provide the training provenance record.", 400);
  const runId = runOf(value.runId), source = value.source;
  if (!source || !digest(source.sha256) || !Number.isFinite(source.startSeconds) || source.startSeconds < 0
      || !Number.isFinite(source.seconds) || source.seconds <= 0) fail("Training provenance needs the measured source hash and region.", 400);
  audioName(source.file);
  if (/[:\0]/.test(source.file)) fail("Choose a library audio filename.", 400);
  if (value.conditioning !== CONDITIONING) fail("Only source-audio encode-only training can receive this verified receipt.", 400);
  if (typeof value.name !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value.name)) fail("Training provenance needs its safe adapter name.", 400);
  if (typeof value.outputPrefix !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value.outputPrefix)) fail("Training provenance needs its unique output prefix.", 400);
  if (value.outputPrefix !== value.name && !value.outputPrefix.startsWith(`${value.name}_`)) fail("The output prefix must belong to this training adapter.", 400);
  const settings = value.settings;
  if (!settings || !Number.isInteger(settings.steps) || settings.steps < 1 || !Number.isInteger(settings.rank) || settings.rank < 1
      || !Number.isFinite(settings.learningRate) || settings.learningRate <= 0) fail("Training provenance needs steps, rank and learning rate.", 400);
  if (settings.seed !== undefined && (!Number.isSafeInteger(settings.seed) || settings.seed < 0)) fail("Invalid training seed.", 400);
  if (settings.startSeconds !== undefined && settings.startSeconds !== source.startSeconds
      || settings.seconds !== undefined && settings.seconds !== source.seconds) fail("Training settings disagree with the source region.", 400);
  if (value.graphHash !== undefined && !/^sha256:[a-f0-9]{64}$/i.test(value.graphHash)) fail("Invalid training graph hash.", 400);
  return { runId, name: value.name, source: { file: source.file, sha256: source.sha256.toLowerCase(), startSeconds: source.startSeconds, seconds: source.seconds },
    checkpoint: nameOf(value.checkpoint), conditioning: CONDITIONING, outputPrefix: value.outputPrefix,
    settings: { steps: settings.steps, rank: settings.rank, learningRate: settings.learningRate,
      ...(settings.seed !== undefined ? { seed: settings.seed } : {}) },
    ...(value.graphHash ? { graphHash: value.graphHash } : {}) };
}
export async function readTrainingReceipt(appData, runId) {
  const value = JSON.parse(await readFile(receiptPath(appData, runId), "utf8"));
  if (value.v !== 1 || value.runId !== runId) fail("The training receipt is invalid.");
  trainingInput(value); return value;
}
async function replaceReceipt(appData, row) {
  await mkdir(receiptDirectory(appData), { recursive: true });
  const target = receiptPath(appData, row.runId), temp = `${target}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(row, null, 2)); await rename(temp, target); }
  finally { await rm(temp, { force: true }).catch(() => {}); }
}

/** Internal training boundary: the caller supplies a measured, unchanged source
 * and the accepted engine run id. Filenames or safetensors metadata are not proof. */
export async function saveTrainingReceipt(appData, value) {
  const input = trainingInput(value), target = receiptPath(appData, input.runId);
  await mkdir(receiptDirectory(appData), { recursive: true });
  const row = { v: 1, ...input, state: "submitted", createdAt: Date.now() };
  try { await writeFile(target, JSON.stringify(row, null, 2), { flag: "wx" }); return row; }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const old = await readTrainingReceipt(appData, input.runId);
    if (JSON.stringify(trainingInput(old)) !== JSON.stringify(input)) fail("This training run already has different source provenance.");
    return old;
  }
}

/** Call only after the exact engine run completed and its adapter was adopted. */
export async function completeTrainingReceipt(appData, { runId, adapterFullPath, name }) {
  runOf(runId); nameOf(name);
  if (typeof adapterFullPath !== "string" || !path.isAbsolute(adapterFullPath) || path.basename(adapterFullPath) !== name
      || path.basename(path.dirname(adapterFullPath)).toLowerCase() !== "loras") fail("Complete a training receipt with its adopted LoRA shelf file.", 400);
  return receiptLock(receiptPath(appData, runId), async () => {
  const row = await readTrainingReceipt(appData, runId), before = await fileState(adapterFullPath);
  if (name !== `${row.name}.safetensors`) fail("The adopted adapter does not belong to this training receipt.");
  if (!samePath(path.dirname(before.full), await realpath(path.dirname(adapterFullPath)))) fail("The adopted adapter must stay on its LoRA shelf.");
  const sha256 = await audioHash(before.full); await unchanged(adapterFullPath, before);
  if (row.state === "completed") {
    if (row.adapter?.name !== name || row.adapter?.sha256 !== sha256) fail("The completed training adapter changed; its original receipt was kept.");
    return row;
  }
  if (row.state !== "submitted") fail("This training receipt cannot be completed.");
  const completed = { ...row, state: "completed", completedAt: Date.now(), adapter: { name, sha256, bytes: before.bytes } };
  await replaceReceipt(appData, completed); return completed;
  });
}

/** A matching immutable adapter fingerprint is required before source history
 * is called verified. Pending, malformed and unrelated records remain unknown. */
export async function lookupTrainingReceipt(appData, { name, identity }) {
  nameOf(name); const sha256 = String(identity || "").replace(/^sha256:/, "");
  if (!digest(sha256)) return null;
  const names = await readdir(receiptDirectory(appData)).catch(() => []);
  let newest = null;
  for (const file of names.filter(n => /^[A-Za-z0-9_-]{1,100}\.json$/.test(n))) {
    try {
      const row = await readTrainingReceipt(appData, file.slice(0, -5));
      if (row.state !== "completed" || row.adapter?.name !== name || row.adapter.sha256 !== sha256 || row.conditioning !== CONDITIONING) continue;
      if (!newest || row.completedAt > newest.completedAt) newest = row;
    } catch { /* An invalid record is not evidence. */ }
  }
  return newest ? { runId: newest.runId, file: newest.source.file, startSeconds: newest.source.startSeconds,
    seconds: newest.source.seconds, sourceSha256: newest.source.sha256, conditioning: CONDITIONING,
    checkpoint: newest.checkpoint, settings: newest.settings, warnings: [] } : null;
}

export function createListeningLabRuntime({ config, library, shelf, engine, probe = probeModel,
  measure = probeTrainAudio, hashFile = audioHash,
  trainingReceipt = (name, identity) => lookupTrainingReceipt(config.paths?.appData ?? config.dataDir, { name, identity }) }) {
  const cache = new Map();
  async function inspect(file, type, allowedRoot = null) {
    const before = await fileState(file), key = `${type}:${before.full}`, old = cache.get(key);
    if (allowedRoot && !samePath(path.dirname(before.full), allowedRoot)) fail("The recording must stay inside the song library.", 400);
    if (old?.signature === before.signature) return old.value;
    const pending = (async () => {
      const value = type === "probe" ? { ...await probe(before.full), signature: before.signature } : type === "source"
        ? { seconds: await measure(before.full), sha256: await hashFile(before.full), bytes: before.bytes }
        : { identity: `sha256:${await hashFile(before.full)}`, bytes: before.bytes, signature: before.signature };
      await unchanged(file, before); return value;
    })();
    const entry = { signature: before.signature, value: pending }; cache.set(key, entry);
    if (cache.size > 256) cache.delete(cache.keys().next().value);
    try { return await pending; }
    catch (error) { if (cache.get(key) === entry) cache.delete(key); throw error; }
  }
  async function inspectSource(file) {
    audioName(file);
    if (/[:\0]/.test(file)) fail("Choose a library audio filename.", 400);
    const metadata = library.meta.get(file);
    if (!metadata) fail("The recording is no longer in the song library.", 404);
    const root = await realpath(config.outputDir), candidate = path.join(root, file);
    const source = await realpath(candidate).catch(() => fail("The recording is no longer on disk.", 404));
    if (!samePath(path.dirname(source), root)) fail("The recording must stay inside the song library.", 400);
    const result = await inspect(candidate, "source", root);
    if (!(Number.isFinite(result.seconds) && result.seconds > 0) || !digest(result.sha256)) fail("The recording could not be measured and fingerprinted.");
    return { file, title: metadata.title || file, ...result };
  }
  async function capabilities({ adapter, checkpoint } = {}) {
    if (adapter !== undefined) nameOf(adapter);
    if (checkpoint !== undefined) nameOf(checkpoint);
    const checkpoints = [], adapters = [], issues = [], candidates = new Map();
    let files;
    try { files = await shelf(); }
    catch { return { engine: "yue2-comfy", ready: false, reason: "The local model shelves could not be read.", checkpoints, adapters }; }
    for (const file of files.filter(f => ["checkpoints", "loras"].includes(f.folder) && /\.safetensors$/i.test(f.name))) {
      try {
        nameOf(file.name); const full = await realpath(file.full), key = `${file.folder}:${file.name}`;
        const old = candidates.get(key);
        if (old && !samePath(old.full, full)) { old.ambiguous = true; continue; }
        if (!old) candidates.set(key, { ...file, full });
      } catch { /* Removed or unsupported shelf entry. */ }
    }
    for (const file of candidates.values()) {
      if (file.ambiguous) { issues.push(`More than one ${file.name} is installed; use distinct filenames before comparing it.`); continue; }
      try {
        const info = await inspect(file.full, "probe"), row = { name: file.name, bytes: info.bytes ?? file.bytes, signature: info.signature };
        if (file.folder === "checkpoints" && info.family === "yue2" && info.companions?.vae === true && info.companions?.te === true) checkpoints.push({ ...row, full: file.full });
        if (file.folder === "loras" && info.family === "lora" && info.variant === "YuE2" && info.confidence === "certain"
            && info.companions?.te !== true && info.metadata?.yue2_lora_branch !== "ar") adapters.push({ ...row, full: file.full });
      } catch { issues.push(`${file.name} changed or could not be inspected.`); }
    }
    let reason = null, info;
    try {
      if (!(await engine.status())?.ready) reason = "Start the local engine to run a YuE2 listening comparison.";
      else info = await engine.objectInfo();
    } catch { reason = "The local engine is unavailable. Start it before running a listening comparison."; }
    if (info) {
      const saveNode = config.output?.format === "mp3" ? "SaveAudioMP3" : config.output?.format === "opus" ? "SaveAudioOpus" : "SaveAudio";
      const needed = ["CheckpointLoaderSimple", "LoraLoaderModelOnly", "YuE2GenerateABC", "YuE2GenerateMusic", "ConditioningZeroOut", "EmptyYuE2LatentAudio", "KSampler", "VAEDecodeAudio", saveNode];
      const missing = needed.filter(n => !info[n]);
      if (missing.length) reason = `The local engine needs these YuE2 nodes: ${missing.join(", ")}.`;
      for (const [rows, node, input] of [[checkpoints, "CheckpointLoaderSimple", "ckpt_name"], [adapters, "LoraLoaderModelOnly", "lora_name"]]) {
        const names = info[node]?.input?.required?.[input]?.[0] ?? info[node]?.input?.optional?.[input]?.[0];
        if (Array.isArray(names)) for (let i = rows.length - 1; i >= 0; i--) if (!names.includes(rows[i].name)) rows.splice(i, 1);
      }
    }
    if (!reason && !checkpoints.length) reason = "Install a packaged YuE2 checkpoint with its text encoder and audio decoder.";
    if (!reason && !adapters.length) reason = "No compatible YuE2 audio adapter is on a LoRA shelf. Train or adopt one before comparing it.";
    if (!reason && checkpoint && !checkpoints.some(row => row.name === checkpoint)) reason = "The selected YuE2 checkpoint is unavailable or ambiguous.";
    if (!reason && adapter && !adapters.some(row => row.name === adapter)) reason = "The selected YuE2 audio adapter is unavailable or ambiguous.";
    for (const rows of [checkpoints, adapters]) for (const row of rows) {
      try {
        if (!reason && row.name === (rows === checkpoints ? checkpoint : adapter)) {
          const identity = await inspect(row.full, "identity");
          if (identity.signature !== row.signature) fail("The model changed after its architecture was inspected.");
          Object.assign(row, identity);
          if (rows === adapters) row.training = await trainingReceipt(row.name, row.identity);
        }
      } catch { reason = "A selected model changed or could not be fingerprinted. Refresh before creating this comparison."; }
      delete row.full;
      delete row.signature;
    }
    return { engine: "yue2-comfy", ready: !reason, reason, checkpoints, adapters, issues,
      note: "Only selected models are fingerprinted. Training history without a matching completed receipt is unknown; a supplied source region is recorded as your declaration." };
  }
  return { capabilities, inspectSource };
}
