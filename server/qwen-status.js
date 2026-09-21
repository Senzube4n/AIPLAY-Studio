/** Readiness and input staging for Qwen Image; neither starts nor updates ComfyUI. */
import path from "node:path";
import { stat, readFile, writeFile, mkdir, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { config as defaultConfig } from "./config.js";
import { CATALOG } from "./models.js";
import { modelBases } from "./modelpick.js";
import { scanBases } from "./localmodels.js";
import { engine as defaultEngine } from "./engine/client.js";
import { QWEN_IMAGE_FILES, qwenImageGraph } from "./qwen-image.js";

export const QWEN_IMAGE_ENGINE = "qwen-image-2.1";

/** Stock files must match the catalog's byte count; custom native files must
 * exist on a shelf the active engine exposes. Missing/unreachable runtime is
 * never treated as permission to enqueue an unvalidated graph. */
export async function qwenImageStatus({ options = {}, config = defaultConfig,
  engine = defaultEngine, scan = scanBases, bases = modelBases,
  catalog = CATALOG } = {}) {
  const cap = catalog.find((row) => row.id === QWEN_IMAGE_ENGINE);
  const out = { ready: false, filesReady: false, runtimeReady: false,
    missingFiles: [], missingNodes: [], error: null,
    totalBytes: (cap?.files || []).reduce((sum, file) => sum + file.bytes, 0) };
  let graph;
  try {
    const selected = {};
    for (const [key, name] of Object.entries(QWEN_IMAGE_FILES)) {
      selected[key] = options[key] || config.modelOverrides?.[name] || name;
      if (path.basename(selected[key]) !== selected[key]) throw new Error("Select model filenames from the model shelf, not paths.");
    }
    graph = qwenImageGraph({ prompt: "readiness check", ...options, ...selected });
  } catch (err) { out.error = err.message; return out; }
  const required = [...new Set(Object.values(graph).map((node) => node.class_type))];
  const [shelfResult, runtimeResult] = await Promise.allSettled([
    bases(config).then((dirs) => scan(dirs)), engine.objectInfo(),
  ]);
  const shelf = shelfResult.status === "fulfilled" ? shelfResult.value : [];
  const info = runtimeResult.status === "fulfilled" ? runtimeResult.value : null;
  // An unreachable runtime tells us nothing about which nodes it supports.
  // Keep offline distinct from a successful response proving an older build.
  out.missingNodes = info ? required.filter((name) => !info[name]) : [];
  out.runtimeReady = !!info && out.missingNodes.length === 0;
  const selected = [
    { name: graph[1].inputs.unet_name, folders: ["diffusion_models", "unet"], node: "UNETLoader", input: "unet_name" },
    { name: graph[2].inputs.clip_name, folders: ["text_encoders", "clip"], node: "CLIPLoader", input: "clip_name" },
    { name: graph[3].inputs.vae_name, folders: ["vae"], node: "VAELoader", input: "vae_name" },
  ];
  for (const file of selected) {
    const expected = cap?.files.find((row) => path.basename(row.dest) === file.name)?.bytes;
    const candidates = shelf.filter((row) => row.name === file.name && file.folders.includes(row.folder));
    let present = candidates.some((row) => expected ? row.bytes === expected : row.bytes > 0);
    const available = info?.[file.node]?.input?.required?.[file.input]?.[0];
    if (Array.isArray(available) && !available.includes(file.name)) present = false;
    if (!present) out.missingFiles.push(file.name);
  }
  out.filesReady = out.missingFiles.length === 0;
  out.ready = out.filesReady && out.runtimeReady;
  const problems = [];
  if (!out.filesReady) problems.push(`Missing or incomplete Qwen Image files: ${out.missingFiles.join(", ")}. Choose Download in Models when ready.`);
  if (runtimeResult.status === "rejected") problems.push(`Cannot verify the ComfyUI runtime: ${runtimeResult.reason?.message || "engine unavailable"}.`);
  else if (!out.runtimeReady) problems.push(`ComfyUI is missing ${out.missingNodes.join(", ")}. Qwen Image 2.1 needs a compatible runtime; this check does not update it.`);
  if (shelfResult.status === "rejected") problems.push(`Cannot inspect the model shelf: ${shelfResult.reason?.message || "unavailable"}.`);
  out.error = problems.length ? problems.join(" ") : null;
  return out;
}

/** Preserve order and fail the whole request if any reference is invalid.
 * Uploaded names are checked on disk too; their prefix is not proof of presence. */
export async function stageQwenReferences(names, { inputDir, coverDir, imageDir }) {
  if (!Array.isArray(names) || names.length > 10) throw new Error("Qwen Image accepts up to 10 reference images, including persona references.");
  const valid = names.map((name) => {
    if (typeof name !== "string" || !name || path.basename(name) !== name || !/\.(png|jpe?g|webp)$/i.test(name)) {
      throw new Error("Each reference must be a PNG, JPEG or WebP filename from the image library or an uploaded image.");
    }
    return name;
  });
  // Validate every source before copying any of them.
  const sources = await Promise.all(valid.map(async (name) => {
    const uploaded = /^aiplay_frame_[0-9a-f]{12}\.(png|jpg|webp)$/i.test(name);
    const candidates = uploaded ? [path.join(inputDir, name)] : [path.join(coverDir, name), path.join(imageDir, name)];
    for (const source of candidates) {
      const found = await stat(source).catch(() => null);
      if (found?.isFile() && found.size > 0) {
        const file = await open(source, "r");
        const header = Buffer.alloc(32);
        try { await file.read(header, 0, header.length, 0); } finally { await file.close(); }
        const png = header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && header.toString("ascii", 12, 16) === "IHDR";
        const jpeg = header[0] === 255 && header[1] === 216 && header[2] === 255;
        const webp = header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP";
        if (!png && !jpeg && !webp) throw new Error(`Reference is not a readable PNG, JPEG or WebP image: ${name}.`);
        return { name, source, uploaded };
      }
    }
    throw new Error(`Reference image is missing or empty: ${name}. Upload it again or choose an existing image.`);
  }));
  if (sources.some((row) => !row.uploaded)) await mkdir(inputDir, { recursive: true });
  return Promise.all(sources.map(async ({ name, source, uploaded }) => {
    if (uploaded) return name;
    const staged = `aiplay_frame_${createHash("sha1").update(source).digest("hex").slice(0, 12)}${path.extname(source).toLowerCase().replace(".jpeg", ".jpg")}`;
    await writeFile(path.join(inputDir, staged), await readFile(source));
    return staged;
  }));
}
