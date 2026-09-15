/** Disposable, CPU-only exact-mixer previews. No composition or render-job writes. */
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, readdir, unlink, rename, open } from "node:fs/promises";

export const AUDIO_PREVIEW_LIMITS = Object.freeze({ seconds: 120, rate: 48000,
  files: 8, bytes: 192 * 1024 * 1024, ttlMs: 15 * 60_000, timeoutMs: 90_000,
  sources: 64, sourceBytes: 512 * 1024 * 1024, totalSourceBytes: 1024 * 1024 * 1024 });
const SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/;
const KEY = /^[a-f0-9]{64}$/;
const OWN_FILE = /^[a-f0-9]{64}(?:\.[a-f0-9-]{36}\.part)?\.wav$/;
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const aborted = () => fail(499, "audio_preview_cancelled", "Audio preview cancelled.");
const checkAbort = (signal) => { if (signal?.aborted) throw aborted(); };
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function validateAudioPreviewRequest(body) {
  if (!plain(body) || Object.keys(body).some(k => !["slug", "expectedRevision", "from", "to"].includes(k)) ||
      typeof body.slug !== "string" || !SLUG.test(body.slug) ||
      !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 ||
      typeof body.from !== "number" || !Number.isFinite(body.from) || body.from < 0 ||
      typeof body.to !== "number" || !Number.isFinite(body.to) || body.to <= body.from) {
    throw fail(400, "audio_preview_invalid", "Give a composition, its current revision, and a valid work area.");
  }
  if (body.to - body.from > AUDIO_PREVIEW_LIMITS.seconds) {
    throw fail(422, "audio_preview_limit", "Audio preview supports work areas up to 120 seconds. Shorten the work area first.");
  }
  return { ...body };
}

/** Dependencies are the route's existing source resolver and one-shot Python runner. */
export function createAudioPreview({ readComp, resolveCompTree, compStamp, runEngine, cacheDir, now = Date.now }) {
  if (!path.isAbsolute(cacheDir)) throw new Error("Audio preview cacheDir must be absolute.");
  const root = path.resolve(cacheDir);
  const records = new Map();
  let active = null, initialization = null, closed = false;
  const ownedPath = (name) => {
    if (!OWN_FILE.test(name)) throw new Error("Invalid managed audio cache name.");
    const full = path.resolve(root, name);
    if (path.dirname(full) !== root) throw new Error("Audio cache path escaped its directory.");
    return full;
  };
  async function initialize() {
    if (!initialization) initialization = (async () => {
      await mkdir(root, { recursive: true });
      const st = await lstat(root);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("Audio preview cache must be a regular directory.");
      // A previous process's previews have no live revision receipt. Only our
      // narrowly named disposable artifacts are removed; unrelated files stay.
      for (const ent of await readdir(root, { withFileTypes: true })) {
        if (ent.isFile() && OWN_FILE.test(ent.name)) await unlink(ownedPath(ent.name));
      }
    })();
    return initialization;
  }
  async function drop(key) {
    const rec = records.get(key);
    records.delete(key);
    if (rec?.hasAudio) await unlink(ownedPath(`${key}.wav`)).catch(e => { if (e.code !== "ENOENT") throw e; });
  }
  async function prune(reserveBytes = 0) {
    for (const [key, rec] of records) if (now() - rec.usedAt >= AUDIO_PREVIEW_LIMITS.ttlMs) await drop(key);
    let bytes = [...records.values()].reduce((n, r) => n + r.bytes, 0);
    const ordered = [...records.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt);
    while (ordered.length && (records.size >= AUDIO_PREVIEW_LIMITS.files || bytes + reserveBytes > AUDIO_PREVIEW_LIMITS.bytes)) {
      const [key, rec] = ordered.shift();
      bytes -= rec.bytes;
      await drop(key);
    }
  }
  async function snapshot(request, signal) {
    checkAbort(signal);
    const doc = await readComp(request.slug);
    if (!doc) throw fail(404, "audio_preview_missing", "The composition no longer exists.");
    if (doc.updatedAt !== request.expectedRevision) throw fail(409, "comp_conflict", "The composition changed. Reload it before playing audio.");
    if (!Number.isFinite(doc.duration) || request.to > doc.duration + 1e-6) {
      throw fail(400, "audio_preview_invalid", "The audio work area extends beyond the composition.");
    }
    const comp = await resolveCompTree(doc);
    const stamp = await compStamp(doc);
    const paths = new Set(), seen = new Set(), frontier = [comp];
    // Mirror the mixer's audible selection, not merely all stored source names:
    // disabled layers intentionally retain unresolved library names. Walk only
    // reachable audible children, including the engine's inline-comp form.
    while (frontier.length) {
      const item = frontier.pop();
      if (!plain(item) || seen.has(item)) continue;
      seen.add(item);
      if (seen.size > 64) throw fail(422, "audio_preview_limit", "Audio preview supports at most 64 nested compositions.");
      const layers = item.layers || [];
      const solo = layers.some(layer => layer.solo);
      for (const layer of layers) {
        if (layer.audio === false || (solo ? !layer.solo : layer.enabled === false)) continue;
        if (["audio", "video"].includes(layer.type) && layer.src) paths.add(layer.src);
        else if (layer.type === "comp") frontier.push(layer.comp || comp.comps?.[layer.src]);
      }
    }
    if (paths.size > AUDIO_PREVIEW_LIMITS.sources) throw fail(422, "audio_preview_limit", "Audio preview supports at most 64 media sources.");
    const sourceStamps = [];
    let bytes = 0n;
    for (const src of [...paths].sort()) {
      checkAbort(signal);
      if (typeof src !== "string" || !path.isAbsolute(src)) throw fail(422, "audio_preview_source", "An audio source could not be resolved.");
      let st;
      try { st = await lstat(src, { bigint: true }); }
      catch { throw fail(422, "audio_preview_source", "An audio preview source is missing or unreadable."); }
      if (!st.isFile() || st.isSymbolicLink()) throw fail(422, "audio_preview_source", "Audio preview requires regular local media files.");
      bytes += st.size;
      if (st.size > BigInt(AUDIO_PREVIEW_LIMITS.sourceBytes) || bytes > BigInt(AUDIO_PREVIEW_LIMITS.totalSourceBytes)) {
        throw fail(422, "audio_preview_limit", "The media sources exceed the bounded audio preview size. Use shorter source files.");
      }
      sourceStamps.push([src, ...[st.size, st.mtimeNs, st.ctimeNs, st.dev, st.ino].map(String)]);
    }
    checkAbort(signal);
    const key = createHash("sha256").update(JSON.stringify({ mixer: "exact-audio-v1", comp, stamp, sourceStamps,
      from: request.from, to: request.to, rate: AUDIO_PREVIEW_LIMITS.rate })).digest("hex");
    return { key, comp };
  }
  const response = (rec) => ({ ok: true, revision: rec.request.expectedRevision, hasAudio: rec.hasAudio,
    url: rec.hasAudio ? `/api/vfx/audio-preview/${rec.request.slug}/${rec.key}.wav` : null,
    from: rec.request.from, to: rec.request.to, duration: rec.request.to - rec.request.from });
  async function verifyWav(file, frames) {
    const st = await lstat(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size !== 44 + frames * 4) throw new Error("Invalid audio preview WAV size.");
    const fh = await open(file, "r");
    try {
      const head = Buffer.alloc(44);
      const { bytesRead } = await fh.read(head, 0, 44, 0);
      if (bytesRead !== 44 || head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 16) !== "WAVEfmt " ||
          head.readUInt32LE(16) !== 16 || head.readUInt16LE(20) !== 1 || head.readUInt16LE(22) !== 2 ||
          head.readUInt32LE(24) !== AUDIO_PREVIEW_LIMITS.rate || head.readUInt16LE(32) !== 4 || head.readUInt16LE(34) !== 16 ||
          head.toString("ascii", 36, 40) !== "data" || head.readUInt32LE(40) !== frames * 4 || head.readUInt32LE(4) !== st.size - 8) {
        throw new Error("Invalid audio preview PCM format.");
      }
    } finally { await fh.close(); }
    return st.size;
  }
  async function prepare(body, { signal } = {}) {
    const request = validateAudioPreviewRequest(body);
    checkAbort(signal);
    if (closed) throw fail(503, "audio_preview_unavailable", "Audio preview is closed.");
    await initialize();
    const before = await snapshot(request, signal);
    if (closed) throw fail(503, "audio_preview_unavailable", "Audio preview is closed.");
    const cached = records.get(before.key);
    if (cached && now() - cached.usedAt < AUDIO_PREVIEW_LIMITS.ttlMs) {
      cached.usedAt = now();
      return response(cached);
    }
    if (active) throw fail(409, "audio_preview_busy", "An audio preview is already being prepared. Try again after it finishes.");
    const controller = new AbortController();
    const ticket = { controller, done: null };
    active = ticket; // reserve before any further await
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, AUDIO_PREVIEW_LIMITS.timeoutMs);
    timer.unref?.();
    const temporary = ownedPath(`${before.key}.${randomUUID()}.part.wav`);
    ticket.done = (async () => {
      try {
        checkAbort(controller.signal);
        await prune(44 + Math.ceil((request.to - request.from) * AUDIO_PREVIEW_LIMITS.rate) * 4);
        const result = await runEngine("audio-preview", { comp: before.comp, from: request.from, to: request.to, out: temporary },
          { signal: controller.signal, timeoutMs: AUDIO_PREVIEW_LIMITS.timeoutMs });
        checkAbort(controller.signal);
        if (result?.ok !== true || typeof result.hasAudio !== "boolean") throw new Error("The audio mixer did not return a valid preview.");
        const after = await snapshot(request, controller.signal);
        if (before.key !== after.key) throw fail(409, "comp_conflict", "The composition or its media changed while preparing audio. Play again.");
        let bytes = 0;
        if (result.hasAudio) {
          const frames = result.frames;
          if (!Number.isSafeInteger(frames) || frames < 1 || result.rate !== AUDIO_PREVIEW_LIMITS.rate ||
              Math.abs(frames - (request.to - request.from) * AUDIO_PREVIEW_LIMITS.rate) > 1) throw new Error("Invalid audio preview duration.");
          bytes = await verifyWav(temporary, frames);
          checkAbort(controller.signal);
          await rename(temporary, ownedPath(`${before.key}.wav`));
        }
        const rec = { key: before.key, request, bytes, hasAudio: result.hasAudio, usedAt: now() };
        records.set(before.key, rec);
        return response(rec);
      } catch (err) {
        if (timedOut) throw fail(504, "audio_preview_timeout", "Audio preview preparation timed out. Use a shorter work area or fewer sources.");
        if (controller.signal.aborted) throw aborted();
        if (err.status) throw err;
        throw fail(422, "audio_preview_failed", `Audio preview could not be prepared: ${String(err.message || "mixer error").slice(0, 400)}`);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        await unlink(temporary).catch(() => {});
        if (active === ticket) active = null; // runner must settle only after owned child close
      }
    })();
    return ticket.done;
  }
  async function file({ slug, key }, { signal } = {}) {
    checkAbort(signal);
    if (typeof slug !== "string" || !SLUG.test(slug) || typeof key !== "string" || !KEY.test(key)) throw fail(400, "audio_preview_invalid", "Invalid audio preview reference.");
    const rec = records.get(key);
    if (closed || !rec?.hasAudio || rec.request.slug !== slug || now() - rec.usedAt >= AUDIO_PREVIEW_LIMITS.ttlMs) throw fail(404, "audio_preview_expired", "Audio preview expired. Press Play to prepare it again.");
    const fresh = await snapshot(rec.request, signal);
    if (fresh.key !== key) throw fail(409, "comp_conflict", "The composition or its media changed. Prepare audio again.");
    const full = ownedPath(`${key}.wav`);
    const st = await lstat(full);
    if (!st.isFile() || st.isSymbolicLink() || st.size !== rec.bytes) throw fail(404, "audio_preview_expired", "Audio preview is no longer available.");
    rec.usedAt = now();
    return { path: full, bytes: rec.bytes };
  }
  async function close() {
    closed = true;
    active?.controller.abort();
    await active?.done?.catch(() => {});
    for (const key of [...records.keys()]) await drop(key);
  }
  return { prepare, file, close };
}
