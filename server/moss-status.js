/** Readiness only. This never starts, updates or switches an engine. */
import { config as defaultConfig } from "./config.js";
import { CATALOG } from "./models.js";
import { modelBases } from "./modelpick.js";
import { scanBases, modelLeaf, findShelfModel, modelName } from "./localmodels.js";
import { engine as defaultEngine } from "./engine/client.js";
import { MOSS_IMAGE_ENGINE, MOSS_IMAGE_FILES, mossImageGraph } from "./moss-image.js";

export async function mossImageStatus({ options = {}, config = defaultConfig,
  engine = defaultEngine, scan = scanBases, bases = modelBases, catalog = CATALOG } = {}) {
  const out = { ready: false, filesReady: false, runtimeReady: false, missingFiles: [], missingNodes: [], error: null };
  const cap = catalog.find(row => row.id === MOSS_IMAGE_ENGINE);
  out.totalBytes = (cap?.files || []).reduce((n, f) => n + f.bytes, 0);
  let graph;
  try {
    const selected = Object.fromEntries(Object.entries(MOSS_IMAGE_FILES).map(([key, file]) => [key, options[key] || config.modelOverrides?.[file] || file]));
    graph = mossImageGraph({ prompt: "readiness check", ...options, ...selected });
  } catch (err) { out.error = err.message; return out; }
  const results = await Promise.allSettled([bases(config).then(dirs => scan(dirs)), engine.objectInfo()]);
  const shelf = results[0].status === "fulfilled" ? results[0].value : [];
  const info = results[1].status === "fulfilled" ? results[1].value : null;
  out.missingNodes = info ? [...new Set(Object.values(graph).map(n => n.class_type))].filter(name => !info[name]) : [];
  // The older engine already has the generic nodes, but cannot load MOSS's
  // tokenizer/model. Checking only class names would incorrectly say ready.
  const clipTypes = info?.CLIPLoader?.input?.required?.type?.[0];
  out.mossClipType = Array.isArray(clipTypes) && clipTypes.includes("moss_image");
  out.runtimeReady = !!info && !out.missingNodes.length && out.mossClipType;
  const files = [
    { name: graph[1].inputs.unet_name, folder: "diffusion_models", node: "UNETLoader", input: "unet_name" },
    { name: graph[2].inputs.clip_name, folder: "text_encoders", node: "CLIPLoader", input: "clip_name" },
    { name: graph[3].inputs.vae_name, folder: "vae", node: "VAELoader", input: "vae_name" },
  ];
  const errors = [];
  for (const file of files) {
    const expected = cap?.files.find(f => modelLeaf(f.dest) === modelLeaf(file.name))?.bytes;
    let found;
    try { found = findShelfModel(shelf, file.folder, file.name); } catch (err) { errors.push(err.message); }
    const available = info?.[file.node]?.input?.required?.[file.input]?.[0];
    if (!expected || !found || found.bytes !== expected
      || (Array.isArray(available) && !available.some(n => typeof n === "string" && modelName(n) === modelName(found.name)))) out.missingFiles.push(file.name);
  }
  out.filesReady = !out.missingFiles.length && !errors.length;
  out.ready = out.filesReady && out.runtimeReady;
  if (out.missingFiles.length) errors.push("Missing or incomplete MOSS-Image files: " + out.missingFiles.join(", ") + ". Open Models.");
  if (results[0].status === "rejected") errors.push("Cannot inspect the model shelf: " + results[0].reason.message + ".");
  if (results[1].status === "rejected") errors.push("Cannot verify the ComfyUI runtime: " + results[1].reason.message + ".");
  else if (!out.runtimeReady) errors.push("This engine needs native MOSS-Image support (including CLIPLoader moss_image). Use a compatible separate engine; the current engine was not changed.");
  out.error = errors.length ? errors.join(" ") : null;
  return out;
}
