/** Readiness only. This never starts, updates or switches an engine. */
import { config as defaultConfig } from "./config.js";
import { CATALOG } from "./models.js";
import { modelBases } from "./modelpick.js";
import { scanBases, modelLeaf, findShelfModel, modelName } from "./localmodels.js";
import { engine as defaultEngine } from "./engine/client.js";
import { MOSS_IMAGE_ENGINE, MOSS_IMAGE_FILES, mossImageGraph } from "./moss-image.js";
import { mossPreset, mossRecipeIdentity } from "./moss-presets.js";
import { mossSpectrumPin } from "./moss-spectrum.js";
import { mossAdapterPin, mossModelPin } from "./moss-adapter.js";

function recipeNodeProblem(node, info) {
  const schema = info?.[node.class_type]?.input?.required;
  if (!schema) return "Missing native input schema for " + node.class_type;
  for (const [key, value] of Object.entries(node.inputs)) {
    const spec = schema[key], type = spec?.[0], limits = spec?.[1];
    if (!spec) return "Missing " + node.class_type + "." + key;
    if (key === "model") { if (type !== "MODEL") return "Invalid MODEL input on " + node.class_type; continue; }
    if (Array.isArray(type) ? !type.includes(value)
      : type === "INT" ? !Number.isSafeInteger(value) : type === "FLOAT" ? typeof value !== "number"
      : type === "BOOLEAN" ? typeof value !== "boolean" : type === "STRING" ? typeof value !== "string" : true) return "Incompatible " + node.class_type + "." + key;
    if (typeof value === "number" && (value < (limits?.min ?? -Infinity) || value > (limits?.max ?? Infinity))) return "Unsupported range for " + node.class_type + "." + key;
  }
  return null;
}

export async function mossImageStatus({ options = {}, config = defaultConfig,
  engine = defaultEngine, scan = scanBases, bases = modelBases, catalog = CATALOG, spectrumPin = mossSpectrumPin, adapterPin = mossAdapterPin, modelPin = mossModelPin } = {}) {
  const out = { ready: false, filesReady: false, runtimeReady: false, missingFiles: [], missingNodes: [], error: null };
  const cap = catalog.find(row => row.id === MOSS_IMAGE_ENGINE);
  out.totalBytes = (cap?.files || []).reduce((n, f) => n + f.bytes, 0);
  let graph, recipe;
  try {
    out.mossPreset = options.mossPreset ?? "standard";
    recipe = mossPreset(out.mossPreset);
    const defaults = { ...MOSS_IMAGE_FILES, ...(recipe.base ? { dit: recipe.base.filename } : {}) };
    const selected = Object.fromEntries(Object.entries(defaults).map(([key, file]) => [key, options[key] || config.modelOverrides?.[file] || file]));
    graph = mossImageGraph({ prompt: "readiness check", ...options, ...selected });
    out.mossRecipe = mossRecipeIdentity(out.mossPreset);
    if (recipe.base && config.modelOverrides?.[recipe.base.filename] && config.modelOverrides[recipe.base.filename] !== recipe.base.filename) throw new Error("The pinned MOSS diffusion model cannot be replaced through model overrides.");
    if (recipe.adapter && config.modelOverrides?.[recipe.adapter.filename] && config.modelOverrides[recipe.adapter.filename] !== recipe.adapter.filename) throw new Error("The pinned MOSS adapter cannot be replaced through model overrides.");
    if (recipe.base) out.totalBytes += recipe.base.bytes - (cap?.files.find(f => modelLeaf(f.dest) === MOSS_IMAGE_FILES.dit)?.bytes || 0);
    if (recipe.adapter) out.totalBytes += recipe.adapter.bytes;
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
  const errors = [];
  if ((graph[6] || recipe.base) && info && !out.missingNodes.length) {
    const problem = graph[6] ? recipeNodeProblem(graph[6], info) : null;
    const samplers = info.KSampler?.input?.required?.sampler_name?.[0];
    const schedulers = info.KSampler?.input?.required?.scheduler?.[0];
    if (problem || !Array.isArray(samplers) || !samplers.includes(recipe.sampler) || !Array.isArray(schedulers) || !schedulers.includes(recipe.scheduler)) {
      out.runtimeReady = false; errors.push(problem || "The runtime does not expose this MOSS sampler and schedule.");
    }
  }
  if (recipe.policy) {
    out.spectrum = await spectrumPin(config);
    if (!out.spectrum.ready) { out.runtimeReady = false; errors.push(out.spectrum.error); }
  }
  const files = [
    { name: graph[1].inputs.unet_name, folder: "diffusion_models", node: "UNETLoader", input: "unet_name", ...(recipe.base ? { bytes: recipe.base.bytes, pin: recipe.base } : {}) },
    { name: graph[2].inputs.clip_name, folder: "text_encoders", node: "CLIPLoader", input: "clip_name" },
    { name: graph[3].inputs.vae_name, folder: "vae", node: "VAELoader", input: "vae_name" },
    ...(recipe.adapter ? [{ name: recipe.adapter.filename, folder: "loras", node: "LoraLoaderModelOnly", input: "lora_name", bytes: recipe.adapter.bytes }] : []),
  ];
  for (const file of files) {
    const expected = file.bytes || cap?.files.find(f => modelLeaf(f.dest) === modelLeaf(file.name))?.bytes;
    let found;
    try { found = findShelfModel(shelf, file.folder, file.name); } catch (err) { errors.push(err.message); }
    const available = info?.[file.node]?.input?.required?.[file.input]?.[0];
    if (!expected || !found || found.bytes !== expected
      || (Array.isArray(available) && !available.some(n => typeof n === "string" && modelName(n) === modelName(found.name)))) out.missingFiles.push(file.name);
    else if (file.pin) {
      out.baseModel = { ...file.pin, ...await modelPin(found, file.pin) };
      if (!out.baseModel.ready) { out.missingFiles.push(file.name); errors.push(out.baseModel.error); }
    } else if (file.folder === "loras") {
      out.adapter = await adapterPin(found, recipe.adapter);
      if (!out.adapter.ready) { out.missingFiles.push(file.name); errors.push(out.adapter.error); }
    }
  }
  out.filesReady = !out.missingFiles.length && results[0].status === "fulfilled";
  out.ready = out.filesReady && out.runtimeReady;
  const missingBase = out.missingFiles.filter(name => name !== recipe.adapter?.filename);
  if (missingBase.length) { out.needsModel = recipe.base && missingBase.every(name => modelLeaf(name) === recipe.base.filename) ? recipe.base.catalogueId : MOSS_IMAGE_ENGINE; errors.push("Missing or incomplete MOSS-Image files: " + missingBase.join(", ") + ". Open Models."); }
  if (recipe.adapter && out.missingFiles.includes(recipe.adapter.filename)) {
    if (!out.needsModel) out.needsModel = recipe.adapter.catalogueId || MOSS_IMAGE_ENGINE + "-" + out.mossPreset;
    errors.push("Missing or incomplete pinned experimental MOSS adapter: " + recipe.adapter.filename + ". Download its addon in Models.");
  }
  if (results[0].status === "rejected") errors.push("Cannot inspect the model shelf: " + results[0].reason.message + ".");
  if (results[1].status === "rejected") errors.push("Cannot verify the ComfyUI runtime: " + results[1].reason.message + ".");
  else if (!out.runtimeReady) errors.push("This engine needs native MOSS-Image support (including CLIPLoader moss_image). Use a compatible separate engine; the current engine was not changed.");
  out.error = errors.length ? errors.join(" ") : null;
  return out;
}
