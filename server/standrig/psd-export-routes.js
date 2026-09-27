import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createStandRigPsdExporter } from "./psd-export.js";

const FILE = /^standrig_[0-9a-f]{32}\.psd$/;
const KEEP_MS = 24 * 60 * 60 * 1000;

function local(req) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket?.remoteAddress)
    && /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(req.headers?.host || "");
}

function leaves(tree) {
  return tree.flatMap(node => node.type === "group" ? leaves(node.children || [])
    : [{ name: node.name, type: node.type, hidden: node.hidden }]);
}

/** Saved layer document -> real PSD file -> one local download URL. */
export function createStandRigPsdRoutes({ json, readBody, sameOriginLocalJson, imageDir, python,
  exporter = createStandRigPsdExporter({ imageDir, python }), onExport = () => {} }) {
  const directory = path.join(imageDir, "_standrig");
  async function prune() {
    for (const name of await readdir(directory).catch(() => [])) {
      if (!FILE.test(name)) continue;
      const file = path.join(directory, name);
      const info = await stat(file).catch(() => null);
      if (info?.isFile() && Date.now() - info.mtimeMs > KEEP_MS) await unlink(file).catch(() => {});
    }
  }
  return async function standRigPsdRoutes(req, res, url) {
    if (!local(req)) return json(res, 403, { error: "PSD export is available on this machine only." });
    if (req.method === "GET") {
      const name = url.pathname.slice("/api/images/standrig-psd/".length);
      if (!FILE.test(name)) return json(res, 404, { error: "No such PSD export." });
      const file = path.join(directory, name);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile() || info.size > 64 * 1024 * 1024 || Date.now() - info.mtimeMs > KEEP_MS)
        return json(res, 404, { error: "This PSD export is unavailable or expired. Export it again." });
      const bytes = await readFile(file);
      res.writeHead(200, { "Content-Type": "image/vnd.adobe.photoshop",
        "Content-Disposition": `attachment; filename="${name}"`, "Content-Length": bytes.length,
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(bytes);
      return;
    }
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed." });
    if (!sameOriginLocalJson(req))
      return json(res, 403, { error: "PSD export requires a same-origin local JSON request." });
    try {
      const body = await readBody(req, 16 * 1024);
      if (!body || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.id !== "string")
        return json(res, 400, { error: "Pass only the saved document id." });
      const made = await exporter(body.id);
      await mkdir(directory, { recursive: true });
      const name = `standrig_${randomUUID().replaceAll("-", "")}.psd`;
      const file = path.join(directory, name), temporary = `${file}.writing`;
      try {
        await writeFile(temporary, made.buffer, { flag: "wx" });
        await rename(temporary, file);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
      await prune();
      const warnings = [...(made.warnings || [])];
      try { await onExport({ name, documentId: made.sourceDocumentId, layers: made.count }, req); }
      catch { warnings.push("PSD saved, but its provenance note could not be written."); }
      return json(res, 200, { ok: true, name,
        downloadUrl: `/api/images/standrig-psd/${name}`,
        width: made.width, height: made.height, layers: leaves(made.layers), warnings });
    } catch (error) {
      return json(res, error?.tooBig ? 413 : error?.status || 400,
        { error: error?.message || "PSD export failed." });
    }
  };
}
