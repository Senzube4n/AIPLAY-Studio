/** Shared wire/storage primitives. No application config or credentials here. */
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";

export const PROTOCOL = 1;
export const MAX_JSON = 2 * 1024 * 1024;
export const MAX_ASSET = 512 * 1024 * 1024;
export const TERMINAL = new Set(["completed", "failed", "cancelled", "uncertain"]);
export const MEDIA_EXT = /\.(png|jpe?g|webp|gif|mp4|webm|mov|mkv|m4v|wav|flac|mp3|ogg|opus|latent|safetensors|glb|gltf|obj|json|npy|npz)$/i;

export function endpoint(value) {
  const u = new URL(String(value || "").trim());
  if (u.username || u.password || u.search || u.hash) throw new Error("Use a worker URL without credentials, query parameters or fragments.");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))) {
    throw new Error("The worker requires HTTPS (HTTP is allowed only on loopback for tests or an SSH tunnel).");
  }
  return u.href.replace(/\/+$/, "");
}

export function jobId(value) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(String(value || ""))) throw new Error("Invalid job ID.");
  return value;
}

export function relativeFile(value) {
  if (typeof value !== "string" || !value || value.length > 500 || /[\\:*?"<>|\x00-\x1f]/.test(value)
      || value.startsWith("/") || value.split("/").some(p => !p || p === "." || p === ".." || /[. ]$/.test(p)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
    throw new Error("Invalid relative file path.");
  }
  return value;
}

export async function containedFile(root, relative) {
  const base = await realpath(root);
  const full = await realpath(path.join(base, relativeFile(relative)));
  const rel = path.relative(base, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("File is outside its storage directory.");
  return full;
}

export async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export async function readJSON(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return fallback; throw e; }
}

export function jsonStore(file) {
  let writes = Promise.resolve();
  return (value) => {
    const data = JSON.stringify(value, null, 2);
    const save = async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${randomUUID()}.tmp`;
      try { await writeFile(tmp, data, { mode: 0o600 }); await rename(tmp, file); }
      finally { await unlink(tmp).catch(() => {}); }
    };
    const done = writes.then(save, save);
    writes = done.catch(() => {});
    return done;
  };
}

export async function readBody(req, limit = MAX_JSON) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("Request exceeds the size limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function sendJSON(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(body));
}

/** Accept both ComfyUI's legacy list choices and its 0.37+ COMBO descriptor. */
export function inputChoices(spec) {
  if (!Array.isArray(spec)) return null;
  if (Array.isArray(spec[0])) return spec[0];
  if (spec[0] === "COMBO" && Array.isArray(spec[1]?.options)) return spec[1].options;
  return null;
}

export function validateGraph(graph, info) {
  if (!graph || Array.isArray(graph) || typeof graph !== "object" || !Object.keys(graph).length || Object.keys(graph).length > 500) {
    throw new Error("Choose a ComfyUI workflow exported in API format (1–500 nodes).");
  }
  for (const [id, node] of Object.entries(graph)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id) || !node || typeof node.class_type !== "string" || !node.inputs || typeof node.inputs !== "object" || Array.isArray(node.inputs)) {
      throw new Error("Invalid API workflow node.");
    }
    if (!info) continue;
    const def = info[node.class_type];
    if (!def) throw new Error(`Worker is missing node ${node.class_type}.`);
    const required = def.input?.required || {};
    for (const name of Object.keys(required)) {
      if (!(name in node.inputs)) throw new Error(`Node ${id} (${node.class_type}) needs ${name}.`);
    }
    for (const [name, value] of Object.entries(node.inputs)) {
      const choices = inputChoices(required[name] || def.input?.optional?.[name]);
      if (Array.isArray(value)) {
        if (value.length !== 2 || !graph[String(value[0])] || !Number.isInteger(value[1]) || value[1] < 0) throw new Error(`Invalid link at node ${id}.${name}.`);
      } else if (Array.isArray(choices) && !choices.includes(value)) {
        throw new Error(`Worker does not offer ${name} = ${String(value).slice(0, 160)} at node ${id}. Check the installed models and workflow.`);
      }
    }
  }
}
