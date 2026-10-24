/** Curated, authenticated model installs for the RunPod worker.
 *
 * The desktop may select only bundle IDs defined here. It never supplies a URL,
 * destination path or checksum, so the worker cannot become a remote shell or
 * arbitrary file downloader.
 */
import path from "node:path";
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink, link, statfs, realpath, lstat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { hashFile, readJSON, jsonStore } from "../server/engine/remote-common.js";
import { resolveCatalogFile, fetchModelFile, MODEL_FOLDERS } from '../server/engine/model-catalog.js';

import { MODEL_BUNDLES } from '../shared/model-bundles.js';
export { MODEL_BUNDLES };

const exists = async (file) => stat(file).catch(() => null);
const publicBundle = (id, bundle, live = {}) => ({
  id, label: bundle.label, description: bundle.description, licenseUrl: bundle.licenseUrl,
  totalBytes: bundle.totalBytes, requiresToken: !!bundle.requiresToken, state: live.state || "missing",
  downloadedBytes: live.downloadedBytes || 0, error: live.error || null, external: !!bundle.external,
});

export async function createModelManager({ modelsDir, fetchFn = fetch, bundles = MODEL_BUNDLES }) {
  if (!path.isAbsolute(modelsDir)) throw new Error("The worker models directory must be absolute.");
  await mkdir(modelsDir, { recursive: true });
  bundles = Object.assign(Object.create(null), bundles);
  const manifest = path.join(modelsDir, '.aiplay-catalog.json');
  const saved = await readJSON(manifest, {});
  for (const [id, b] of Object.entries(saved).slice(0,1000)) {
    const f = b?.files?.[0];
    if (/^catalog-[a-f0-9]{32}$/.test(id) && b.external === true && b.files.length === 1 && f && /^[a-f0-9]{64}$/.test(f.sha256 || '')
      && MODEL_FOLDERS.some(folder => f.relative?.startsWith(`${folder}/aiplay_${f.sha256.slice(0,12)}_`))
      && !/[\\\x00-\x1f]/.test(f.relative) && !f.relative.split('/').includes('..') && f.relative.split('/').length === 2
      && Number.isSafeInteger(f.bytes) && f.bytes > 0 && f.bytes <= 100e9) bundles[id] = b;
  }
  const live = new Map();
  let active = null, preparing = false, preparationCancelled = false;

  async function valid(file, spec) {
    const info = await exists(file);
    return !!info && info.isFile() && Math.abs(info.size - spec.bytes) <= (spec.tolerance || 0) && await hashFile(file) === spec.sha256;
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
      if (bundle.external) {
        const base = await realpath(modelsDir), parent = await realpath(path.dirname(finalFile));
        const rel = path.relative(base, parent);
        if (rel.startsWith('..') || path.isAbsolute(rel)) throw Error('The selected model folder is outside saved storage.');
        for (const f of [finalFile, `${finalFile}.aiplay-part`]) if ((await lstat(f).catch(e => { if (e.code !== 'ENOENT') throw e; }))?.isSymbolicLink()) throw Error('Model destination cannot be a symbolic link.');
      }
      if (await valid(finalFile, spec) || !bundle.external && await adoptKnownCandidate(finalFile, spec)) {
        complete += spec.bytes;
        live.set(id, { state: "downloading", downloadedBytes: complete });
        continue;
      }
      if (bundle.external && await exists(finalFile)) throw Error('A different file already exists here; it was kept.');
      const part = `${finalFile}.aiplay-part`;
      if (bundle.external && await valid(part, spec)) { await link(part, finalFile); await unlink(part); complete += spec.bytes; continue; }
      let offset = (await exists(part))?.size || 0;
      if (offset >= spec.bytes + (spec.tolerance || 0)) { await unlink(part).catch(() => {}); offset = 0; }
      const request = { headers: { ...(offset ? { Range: `bytes=${offset}-` } : {}),
        ...((bundle.external && modelToken || bundle.requiresToken) ? { Authorization: `Bearer ${modelToken}` } : {}) },
        redirect: 'follow', signal: bundle.external ? AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60000)]) : controller.signal };
      const response = bundle.external ? await fetchModelFile(spec.url, request, fetchFn) : await fetchFn(spec.url, request);
      if (!response.ok || !response.body) throw new Error(`Model host returned HTTP ${response.status}.`);
      const contentRange = response.headers.get("content-range") || "";
      const append = offset > 0 && response.status === 206 && contentRange.startsWith(`bytes ${offset}-`);
      if (offset > 0 && response.status === 206 && !append) throw new Error("Model host returned an invalid resume range.");
      if (!append) offset = 0;
      let received = offset;
      live.set(id, { state: "downloading", downloadedBytes: complete + received });
      const meter = new Transform({ transform(chunk, encoding, callback) {
        received += chunk.length;
        if (received > spec.bytes + (spec.tolerance || 0)) return callback(new Error("Model download exceeded its verified size."));
        live.set(id, { state: "downloading", downloadedBytes: complete + received });
        callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(part, { flags: append ? "a" : "w" }));
      live.set(id, { state: 'verifying', downloadedBytes: complete + received });
      if (!await valid(part, spec)) {
        await unlink(part).catch(() => {});
        throw new Error("Downloaded model failed its size or SHA-256 verification; the invalid temporary file was removed.");
      }
      live.set(id, { state: 'installing', downloadedBytes: complete + received });
      if (bundle.external) { await link(part, finalFile); await unlink(part); }
      else { await unlink(finalFile).catch(() => {}); await rename(part, finalFile); }
      complete += spec.bytes;
    }
    live.set(id, { state: "ready", downloadedBytes: bundle.totalBytes });
  }

  function snapshot() {
    return { version: 1, catalogVersion: 1, active: active?.id || (preparing ? 'catalog-review' : null),
      bundles: Object.entries(bundles).map(([id, bundle]) => publicBundle(id, bundle, live.get(id))) };
  }

  async function install(id, accepted, modelToken, catalog = false) {
    const bundle = bundles[id];
    if (!bundle) throw new Error("Unknown model bundle.");
    if (bundle.external && !catalog) throw Error('Review this file in the model browser before downloading.');
    if (accepted !== true) throw new Error("Review and accept the model repository terms before installing.");
    if (active || preparing && !catalog) throw new Error('Another model download is being prepared or is running.');
    if (await inspect(id)) return snapshot();
    if (catalog && preparationCancelled) throw Error('Download preparation cancelled.');
    if (bundle.requiresToken && (typeof modelToken !== 'string' || !/^hf_[A-Za-z0-9]{10,490}$/.test(modelToken)))
      throw new Error('Accept access on the model page and enter a Hugging Face read token.');
    const controller = new AbortController();
    active = { id, controller };
    live.set(id, { state: "downloading", downloadedBytes: 0 });
    download(id, bundle, controller, modelToken).catch((error) => {
      live.set(id, { state: controller.signal.aborted ? "paused" : "failed",
        downloadedBytes: live.get(id)?.downloadedBytes || 0,
        error: controller.signal.aborted ? null : bundle.external ? 'Download failed. Check provider access and storage, then retry this file.' : String(error.message || error).slice(0, 500) });
    }).finally(() => { active = null; });
    return snapshot();
  }

  function cancel() {
    if (preparing) preparationCancelled = true;
    if (active) active.controller.abort();
    return snapshot();
  }

  async function installCatalog(input, accepted, expected, token) {
    if (accepted !== true) throw Error('Review and accept the model terms before downloading.');
    if (active || preparing) throw Error('Another model download is running.');
    preparing = true; preparationCancelled = false;
    try {
      const bundle = await resolveCatalogFile(input, { token, fetchFn });
      if (preparationCancelled) throw Error('Download preparation cancelled.');
      if (bundle.files[0].sha256 !== expected?.sha256 || bundle.totalBytes !== expected?.bytes) throw Error('The provider file changed. Review it again.');
      const disk = await statfs(modelsDir);
      if (disk.bavail * disk.bsize < bundle.totalBytes + 256e6) throw Error('There is not enough free storage for this download.');
      bundles[bundle.id] = bundle;
      await jsonStore(manifest)(Object.fromEntries(Object.entries(bundles).filter(([, b]) => b.external)));
      return await install(bundle.id, true, token, true);
    } finally { preparing = false; }
  }

  for (const id of Object.keys(bundles)) await inspect(id);
  return { status: snapshot, install, installCatalog, cancel, inspect,
    fileRemoved: relative => { for (const [id,b] of Object.entries(bundles)) if (b.files.some(f => f.relative === relative)) live.set(id,{state:'missing',downloadedBytes:0,error:null}); } };
}
