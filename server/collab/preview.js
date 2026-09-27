/** Frozen outgoing snapshots. Creating a preview reads data and retains it in
 * bounded memory; it does not seal, write an order, transmit or render. */
import { createHash, randomBytes } from "node:crypto";

export const previewHash = (value) => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");

function refuse(reason, message) { const error = new Error(message); error.reason = reason; return error; }

export function previewManifest(packet) {
  if (packet.kind === "job-order" && packet.jobType === "image") {
    return (packet.job?.references || []).map((row) => ({
      file: `Reference ${row.ordinal} (${row.mime})`, ordinal: row.ordinal, bytes: row.bytes,
      sha256: row.sha256, included: true,
    }));
  }
  const included = packet.kind === "order";
  const rows = included ? packet.files || []
    : packet.kind === "project" ? packet.assets || []
    : [...(packet.refs || []), ...(packet.guides || [])];
  return [...new Map(rows.map((row) => {
    const file = row.file || row.name;
    return [file, { file, bytes: row.bytes, sha256: row.sha256, included }];
  })).values()];
}

export function createPreviewStore({ now = Date.now, ttlMs = 15 * 60_000, maxBytes = 64 * 1024 * 1024, maxEntries = 32 } = {}) {
  const entries = new Map();
  let bytes = 0;
  const remove = (id) => { const row = entries.get(id); if (row) bytes -= row.bytes; entries.delete(id); return row; };
  const prune = () => { for (const [id, row] of entries) if (row.expires <= now()) remove(id); };
  return {
    create({ payload, peer, name, slug = null, document = null, describes, note = null }) {
      prune();
      const serialized = JSON.stringify(payload), size = Buffer.byteLength(serialized);
      if (size > maxBytes) throw refuse("preview-too-large", "This outgoing preview exceeds the in-memory limit. Choose a smaller packet.");
      while (entries.size && (bytes + size > maxBytes || entries.size >= maxEntries)) remove(entries.keys().next().value);
      const previewId = `preview_${randomBytes(16).toString("hex")}`;
      const expires = now() + ttlMs;
      const to = { fp: peer.fp, nickname: peer.nickname, role: peer.role };
      const manifest = previewManifest(payload);
      entries.set(previewId, { serialized, bytes: size, expires, peer: { ...to, sign: peer.sign, seal: peer.seal }, name, slug, documentHash: document ? previewHash(document) : null, manifest, describes, note });
      bytes += size;
      const packet = JSON.parse(serialized);
      if (Array.isArray(packet.files)) packet.files = packet.files.map(({ b64, ...row }) => row);
      if (packet.kind === "job-order" && packet.jobType === "image" && Array.isArray(packet.job?.references)) {
        packet.job.references = packet.job.references.map(({ b64, ...row }) => row);
      }
      return { ok: true, previewId, expires, kind: payload.kind, to, describes, packet, manifest,
        payloadBytes: size, includedBytes: manifest.filter((row) => row.included).reduce((sum, row) => sum + (Number(row.bytes) || 0), 0),
        note: note || (payload.kind === "order" || payload.kind === "job-order" ? "These picture bytes and the resolved render settings will be sealed exactly as previewed. The friend must accept before rendering."
          : payload.kind === "resources" ? "Only this hardware/capability snapshot leaves. It is not live availability."
          : "Pictures are listed by size and hash only. Their bytes are not included in this packet.") };
    },
    take(id) {
      const row = remove(String(id || ""));
      if (!row || row.expires <= now()) throw refuse("preview-expired", "This preview expired, was already packed, or belongs to an earlier server session. Preview it again before packing.");
      return { ...row, payload: JSON.parse(row.serialized) };
    },
    get size() { prune(); return entries.size; },
  };
}

/** Rechecked at pack time, after ordinary role/verification checks. */
export async function assertPreviewFresh(preview, { peer, readProject, assetsDir, readAsset }) {
  if (preview.peer.fp !== peer.fp || preview.peer.sign !== peer.sign || preview.peer.seal !== peer.seal) {
    throw refuse("preview-stale", "The recipient's keys changed after this preview. Verify the friend and preview it again.");
  }
  if (preview.documentHash) {
    const document = await readProject(preview.slug).catch(() => null);
    if (!document || previewHash(document) !== preview.documentHash) throw refuse("preview-stale", "The project changed after this preview. Preview the current scene or project again.");
    const directory = assetsDir(preview.slug);
    for (const file of preview.manifest) {
      if (typeof file.file !== "string" || !file.file || file.file === "." || file.file === ".." || /[\\/]/.test(file.file)) throw refuse("preview-stale", "This preview contains an invalid asset filename. Fix the project asset and preview it again.");
      const contents = await readAsset(directory, file.file).catch(() => null);
      if (!contents || contents.length !== file.bytes || previewHash(contents) !== file.sha256) throw refuse("preview-stale", `The asset ${file.file} changed or disappeared after this preview. Preview it again.`);
    }
  }
}
