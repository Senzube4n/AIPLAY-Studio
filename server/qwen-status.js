/** Readiness and input staging for Qwen Image; neither starts nor updates ComfyUI. */
import path from "node:path";
import { stat, readFile, writeFile, mkdir, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { config as defaultConfig } from "./config.js";
import { CATALOG } from "./models.js";
import { modelBases } from "./modelpick.js";
import { scanBases } from "./localmodels.js";
import { engine as defaultEngine } from "./engine/client.js";
import { QWEN_IMAGE_FILES, QWEN_DRAFT, qwenImageGraph } from "./qwen-image.js";

export const QWEN_IMAGE_ENGINE = "qwen-image-2.1";

/** Stock files must match the catalog's byte count; custom native files must
 * exist on a shelf the active engine exposes. Missing/unreachable runtime is
 * never treated as permission to enqueue an unvalidated graph. */
export async function qwenImageStatus({ options = {}, config = defaultConfig,
  engine = defaultEngine, scan = scanBases, bases = modelBases,
  catalog = CATALOG } = {}) {
  const cap = catalog.find((row) => row.id === QWEN_IMAGE_ENGINE);
  const draftCap = catalog.find((row) => row.id === QWEN_DRAFT.capability);
  const out = { ready: false, filesReady: false, runtimeReady: false,
    missingFiles: [], missingNodes: [], error: null,
    totalBytes: (cap?.files || []).reduce((sum, file) => sum + file.bytes, 0) };
  /* FAST DRAFT'S OWN ANSWER, given with every check: the page shows its chip
   * only when this is ready, and "Get Fast draft" (the Models row named here)
   * when the LoRA is not on disk. When the request itself is a draft
   * (options.draft), `ready` above requires it too. */
  out.draft = { capability: QWEN_DRAFT.capability, lora: QWEN_DRAFT.lora,
    bytes: (draftCap?.files || []).reduce((sum, file) => sum + file.bytes, 0) || QWEN_DRAFT.bytes,
    ready: false, fileReady: false, runtimeReady: false, missingNodes: [],
    steps: QWEN_DRAFT.steps, cfg: QWEN_DRAFT.cfg, sampler: QWEN_DRAFT.sampler, strength: QWEN_DRAFT.strength,
    maxRefs: QWEN_DRAFT.maxRefs };
  let graph, draftGraph, loraName;
  try {
    const selected = {};
    for (const [key, name] of Object.entries(QWEN_IMAGE_FILES)) {
      selected[key] = options[key] || config.modelOverrides?.[name] || name;
      if (path.basename(selected[key]) !== selected[key]) throw new Error("Select model filenames from the model shelf, not paths.");
    }
    loraName = config.modelOverrides?.[QWEN_DRAFT.lora] || QWEN_DRAFT.lora;
    if (path.basename(loraName) !== loraName) throw new Error("Select model filenames from the model shelf, not paths.");
    /* The plainest draft this selection can make: which nodes and which LoRA
     * a draft needs, whatever else the request asked for. */
    draftGraph = qwenImageGraph({ prompt: "readiness check", ...selected, draft: true, draftLora: loraName });
    graph = qwenImageGraph({ prompt: "readiness check", ...options, ...selected,
      ...(options.draft === true ? { draftLora: loraName } : {}) });
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
  /* Present: on a shelf the engine reads, at the catalogue's byte count for a
   * stock file, and in the loader's own list when the engine answered. */
  const onShelf = (file, row = cap) => {
    const expected = row?.files.find((f) => path.basename(f.dest) === file.name)?.bytes;
    const candidates = shelf.filter((f) => f.name === file.name && file.folders.includes(f.folder));
    let present = candidates.some((f) => expected ? f.bytes === expected : f.bytes > 0);
    const available = info?.[file.node]?.input?.required?.[file.input]?.[0];
    if (Array.isArray(available) && !available.includes(file.name)) present = false;
    return present;
  };
  for (const file of selected) {
    if (!onShelf(file)) out.missingFiles.push(file.name);
  }
  const loraFile = { name: loraName, folders: ["loras"], node: "LoraLoaderModelOnly", input: "lora_name" };
  out.draft.lora = loraName;
  out.draft.fileReady = onShelf(loraFile, draftCap);
  out.draft.missingNodes = info ? [...new Set(Object.values(draftGraph).map((node) => node.class_type))].filter((name) => !info[name]) : [];
  out.draft.runtimeReady = !!info && out.draft.missingNodes.length === 0;
  if (options.draft === true && !out.draft.fileReady) out.missingFiles.push(loraName);
  out.filesReady = out.missingFiles.length === 0;
  out.ready = out.filesReady && out.runtimeReady;
  out.draft.ready = out.draft.fileReady && out.draft.runtimeReady
    && out.missingFiles.filter((name) => name !== loraName).length === 0;
  const problems = [];
  const baseMissing = out.missingFiles.filter((name) => name !== loraName);
  if (baseMissing.length) problems.push(`Missing or incomplete Qwen Image files: ${baseMissing.join(", ")}. Choose Download in Models when ready.`);
  if (options.draft === true && !out.draft.fileReady) problems.push(`Fast draft needs its LoRA (${loraName}, ${(out.draft.bytes / 1e9).toFixed(2)} GB). Download "Fast draft" in Models, or turn Fast draft off.`);
  if (runtimeResult.status === "rejected") problems.push(`Cannot verify the ComfyUI runtime: ${runtimeResult.reason?.message || "engine unavailable"}.`);
  else if (!out.runtimeReady) problems.push(`ComfyUI is missing ${out.missingNodes.join(", ")}. Qwen Image 2.1 needs a compatible runtime; this check does not update it.`);
  if (shelfResult.status === "rejected") problems.push(`Cannot inspect the model shelf: ${shelfResult.reason?.message || "unavailable"}.`);
  out.error = problems.length ? problems.join(" ") : null;
  return out;
}

const UPLOADED = /^aiplay_frame_[0-9a-f]{12}\.(png|jpg|webp)$/i;

/** Where a reference name may live, in lookup order: an upload sits in the
 * engine's input directory, anything else is a cover or a library image. */
export function qwenReferenceCandidates(name, { inputDir, coverDir, imageDir }) {
  return (UPLOADED.test(name) ? [inputDir] : [coverDir, imageDir]).filter(Boolean).map((dir) => path.join(dir, name));
}

/** Whether a file can carry alpha. A PNG keeps it in an alpha colour type or a
 * tRNS chunk, which must come before IDAT; a JPEG never does. A WebP is left
 * to the flattener to open. */
function mayCarryAlpha(bytes) {
  if (bytes[0] === 255 && bytes[1] === 216) return false;
  if (bytes.toString("ascii", 1, 4) !== "PNG") return true;
  if (bytes[25] === 4 || bytes[25] === 6) return true;
  for (let at = 8; at + 8 <= bytes.length; at += 12 + bytes.readUInt32BE(at)) {
    const type = bytes.toString("ascii", at + 4, at + 8);
    if (type === "tRNS") return true;
    if (type === "IDAT") return false;
  }
  return true;
}

/** Preserve order and fail the whole request if any reference is invalid.
 * Uploaded names are checked on disk too; their prefix is not proof of presence.
 *
 * flatten, when given, receives the references that can carry alpha as
 * [{ name, candidates, out }] and answers with one name each: the name itself
 * for an opaque picture, or the basename of out once it has written the
 * picture over white there (flatten_references in server/image_editor.py). */
export async function stageQwenReferences(names, { inputDir, coverDir, imageDir, flatten = null }) {
  if (!Array.isArray(names) || names.length > 10) throw new Error("Qwen Image accepts up to 10 reference images, including persona references.");
  const valid = names.map((name) => {
    if (typeof name !== "string" || !name || path.basename(name) !== name || !/\.(png|jpe?g|webp)$/i.test(name)) {
      throw new Error("Each reference must be a PNG, JPEG or WebP filename from the image library or an uploaded image.");
    }
    return name;
  });
  // Validate every source before copying any of them.
  const sources = await Promise.all(valid.map(async (name) => {
    const uploaded = UPLOADED.test(name);
    for (const source of qwenReferenceCandidates(name, { inputDir, coverDir, imageDir })) {
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
  const flat = new Map();
  if (flatten) {
    // Named apart from the plain copy, so a transparent request for the same
    // source never overwrites what this one staged.
    const references = [];
    for (const { name, source } of sources) {
      if (!mayCarryAlpha(await readFile(source))) continue;
      const out = path.join(inputDir, `aiplay_frame_${createHash("sha1").update(`${source}\0over white`).digest("hex").slice(0, 12)}.png`);
      references.push({ name, candidates: [source], out });
    }
    if (references.length) {
      await mkdir(inputDir, { recursive: true });
      const sent = await flatten(references);
      references.forEach(({ name, out }, i) => { if (sent[i] === path.basename(out)) flat.set(name, sent[i]); });
    }
  }
  return Promise.all(sources.map(async ({ name, source, uploaded }) => {
    if (flat.has(name)) return flat.get(name);
    if (uploaded) return name;
    const staged = `aiplay_frame_${createHash("sha1").update(source).digest("hex").slice(0, 12)}${path.extname(source).toLowerCase().replace(".jpeg", ".jpg")}`;
    await writeFile(path.join(inputDir, staged), await readFile(source));
    return staged;
  }));
}
