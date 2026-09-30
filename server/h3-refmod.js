/**
 * Optional community H3 caches. Reads safetensors headers only, never pickle or tensor data.
 * Native graph schemas: Luisacaotica/ComfyUI-MiniMaxH3Mod (MIT), nodes.py, 2026-09-30.
 * Fizgig schema: shootthesound/ComfyUI-Fizgig-H3-Tweaks (MIT), h3tweaks.py.
 * Neither pack is installed here. The engine's actual node definitions are the authority.
 */
import path from "node:path";
import { open, realpath, opendir, lstat } from "node:fs/promises";
import { REFMOD_NODES, FIZGIG_NODE, REFMOD_LIMITS, refModName, boundedNumber, h3OptionalOptions } from "./h3-refmod-options.js";

export const REFMOD_SOURCE = "https://github.com/Luisacaotica/ComfyUI-MiniMaxH3Mod";
export const FIZGIG_SOURCE = "https://github.com/shootthesound/ComfyUI-Fizgig-H3-Tweaks";
const within = (root, file) => { const rel = path.relative(root, file); return !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel); };
const dtypeBytes = { F16: 2, BF16: 2, F32: 4 };
const summary = (value, max = 240) => typeof value === "string" ? value.slice(0, max) : "";

/** Closed, bounded parser for the public v1-v5 RefMod storage format. */
export function inspectRefModHeader(header, payloadBytes, legacyMetadata = null) {
  if (!header || typeof header !== "object" || Array.isArray(header)) throw new Error("Invalid safetensors header.");
  let meta;
  try { meta = header.__metadata__?.refmod_meta || header.__metadata__?.audio_refmod_meta
    ? JSON.parse(header.__metadata__.refmod_meta || header.__metadata__.audio_refmod_meta) : legacyMetadata; }
  catch { throw new Error("This safetensors file has no readable RefMod metadata."); }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("This safetensors file has no readable RefMod metadata.");
  const version = meta._format_version ?? 1;
  if (!Number.isInteger(version) || version < 1 || version > 5) throw new Error("Unsupported RefMod format version.");
  const bundle = meta.kind === "bundle";
  if (bundle && (version !== 5 || !Array.isArray(meta.members) || !meta.members.length || meta.members.length > 32)) throw new Error("RefMod bundle must contain 1 to 32 references in format 5.");
  const members = bundle ? meta.members : [meta];
  const expectedKeys = members.map((_, index) => bundle ? `ref_${index}` : "latent");
  if (Object.keys(header).filter((key) => key !== "__metadata__").some((key) => !expectedKeys.includes(key))) throw new Error("Unexpected tensors in this RefMod file.");
  const ranges = [];
  const references = members.map((member, index) => {
    if (!member || typeof member !== "object" || !["image", "video", "audio"].includes(member.kind)) throw new Error("RefMod kind must be image, video or audio.");
    const tensor = header[expectedKeys[index]];
    if (!tensor || !dtypeBytes[tensor.dtype] || !Array.isArray(tensor.shape) || !tensor.shape.every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("Invalid RefMod latent tensor.");
    const shape = tensor.shape;
    let tokens;
    if (member.kind === "audio") {
      if (shape.length !== 4 || shape[0] !== 1 || shape[1] !== 32 || shape[2] !== 2 || shape[3] > 32768) throw new Error("Invalid H3 audio latent shape.");
      tokens = 2 * shape[3];
      if (member.latent_t !== undefined && member.latent_t !== shape[3]) throw new Error("RefMod metadata differs from its audio tensor.");
    } else {
      if (shape.length !== 5 || shape[0] !== 1 || shape[1] !== 24 || shape[2] > 1024 || shape[3] > 512 || shape[4] > 512 || shape[3] % 2 || shape[4] % 2 || (member.kind === "image" && shape[2] !== 1)) throw new Error("Invalid H3 visual latent shape.");
      tokens = shape[2] * shape[3] * shape[4] / 4;
      if (["latent_t", "latent_h", "latent_w"].some((key, i) => member[key] !== undefined && member[key] !== shape[i + 2])) throw new Error("RefMod metadata differs from its visual tensor.");
    }
    const bytes = shape.reduce((total, n) => total * n, dtypeBytes[tensor.dtype]);
    const offsets = tensor.data_offsets;
    if (!Number.isSafeInteger(bytes) || bytes > REFMOD_LIMITS.fileBytes || !Array.isArray(offsets) || offsets.length !== 2 || !offsets.every((n) => Number.isSafeInteger(n) && n >= 0) || offsets[1] - offsets[0] !== bytes || offsets[1] > payloadBytes) throw new Error("Invalid RefMod tensor offsets.");
    ranges.push(offsets);
    if (tokens > REFMOD_LIMITS.maxTokens) throw new Error(`RefMod exceeds ${REFMOD_LIMITS.maxTokens} tokens.`);
    return { kind: member.kind, shape, dtype: tensor.dtype, tokens, name: summary(member.name, 180),
      concept: summary(member.concept_type, 60), mode: summary(member.mode, 40), description: summary(member.description),
      hasSavedConfig: !!member.refmod_config };
  });
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges[0][0] !== 0 || ranges.some((range, i) => i > 0 && range[0] !== ranges[i - 1][1]) || ranges.at(-1)[1] !== payloadBytes) throw new Error("RefMod tensor data must cover the payload without gaps or overlaps.");
  const tokens = references.reduce((total, ref) => total + ref.tokens, 0);
  if (tokens > REFMOD_LIMITS.maxTokens) throw new Error(`RefMod bundle exceeds ${REFMOD_LIMITS.maxTokens} tokens.`);
  return { version, kind: bundle ? "bundle" : references[0].kind, tokens, references, description: summary(meta.description) };
}

export async function inspectRefModFile(root, file) {
  const canonicalRoot = await realpath(root);
  const canonicalFile = await realpath(file);
  if (!within(canonicalRoot, canonicalFile) || path.extname(canonicalFile).toLowerCase() !== ".safetensors") throw new Error("RefMod file is outside its cache folder.");
  const handle = await open(canonicalFile, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 10 || stat.size > REFMOD_LIMITS.fileBytes) throw new Error("RefMod file must be a safetensors cache under 256 MiB.");
    const prefix = Buffer.alloc(8);
    if ((await handle.read(prefix, 0, 8, 0)).bytesRead !== 8) throw new Error("Truncated safetensors header.");
    const bigLength = prefix.readBigUInt64LE();
    if (bigLength < 2n || bigLength > BigInt(REFMOD_LIMITS.headerBytes) || bigLength > BigInt(stat.size - 8)) throw new Error("RefMod header is too large or truncated.");
    const length = Number(bigLength), bytes = Buffer.alloc(length);
    if ((await handle.read(bytes, 0, length, 8)).bytesRead !== length) throw new Error("Truncated safetensors header.");
    let header;
    try { header = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("RefMod header is not JSON."); }
    let legacyMetadata = null;
    if (!header.__metadata__?.refmod_meta && !header.__metadata__?.audio_refmod_meta) {
      let sidecar;
      try {
        const sidecarPath = await realpath(canonicalFile.replace(/\.safetensors$/i, ".json"));
        if (!within(canonicalRoot, sidecarPath)) throw new Error("RefMod sidecar is outside its cache folder.");
        sidecar = await open(sidecarPath, "r");
        const sidecarStat = await sidecar.stat();
        if (!sidecarStat.isFile() || sidecarStat.size > 65536) throw new Error("RefMod JSON sidecar must be under 64 KiB.");
        const sidecarBytes = Buffer.alloc(sidecarStat.size);
        if ((await sidecar.read(sidecarBytes, 0, sidecarBytes.length, 0)).bytesRead !== sidecarBytes.length) throw new Error("Truncated RefMod JSON sidecar.");
        legacyMetadata = JSON.parse(sidecarBytes.toString("utf8"));
      } catch (err) { if (err.code !== "ENOENT") throw err; }
      finally { await sidecar?.close(); }
    }
    const parsed = inspectRefModHeader(header, stat.size - 8 - length, legacyMetadata);
    return { ...parsed, bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
  } finally { await handle.close(); }
}

export function refModRoots(config) {
  return [...new Set([config.modelsDir, ...(config.modelsAlso || []), config.comfyDir ? path.join(config.comfyDir, "models") : null]
    .filter((root) => typeof root === "string" && root).map((root) => path.join(root, "refmods")))];
}

/** Does not follow directory links; canonical containment is checked again when reading. */
export async function listRefMods(roots) {
  const found = [], problems = [], counts = { dirs: 0, files: 0, entries: 0 };
  let truncated = false;
  async function visit(root, directory, relative = "", depth = 0) {
    if (depth > 5 || counts.dirs >= REFMOD_LIMITS.dirs || counts.files >= REFMOD_LIMITS.files || counts.entries >= REFMOD_LIMITS.entries) { truncated = true; return; }
    counts.dirs++;
    let entries;
    try { entries = await opendir(directory); } catch (err) { if (err.code !== "ENOENT") problems.push({ name: relative || "cache folder", error: "Could not read cache folder." }); return; }
    for await (const entry of entries) {
      if (counts.files >= REFMOD_LIMITS.files || counts.entries >= REFMOD_LIMITS.entries) { truncated = true; break; }
      counts.entries++;
      if (entry.isSymbolicLink()) continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && !["graph_presets", ".git", "__pycache__"].includes(entry.name)) await visit(root, file, rel, depth + 1);
      else if (entry.isFile() && /\.safetensors$/i.test(entry.name)) {
        counts.files++;
        try { const name = refModName(rel); found.push({ name, ...(await inspectRefModFile(root, file)), root, file }); }
        catch (err) { problems.push({ name: summary(rel, 180), error: err.message }); }
      }
    }
  }
  for (const root of roots) await visit(root, root);
  const duplicates = new Set(found.filter((row, i) => found.findIndex((other) => other.name.toLowerCase() === row.name.toLowerCase()) !== i).map((row) => row.name.toLowerCase()));
  return { entries: found.filter((row) => !duplicates.has(row.name.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name)), problems: [...problems, ...[...duplicates].map((name) => ({ name, error: "Duplicate cache name in model folders. Rename one before using it." }))].slice(0, 32), truncated };
}

function schemaInputs(node) { return { ...(node?.input?.required || {}), ...(node?.input?.optional || {}) }; }
const choicesOf = (schema) => Array.isArray(schema?.[0]) ? schema[0] : Array.isArray(schema?.[1]?.options) ? schema[1].options : [];
const inputIs = (schema, type) => schema?.[0] === type;
const choicesInclude = (schema, value) => choicesOf(schema).includes(value);
function nativeConditioning(schema) {
  return schema?.[0] === "CONDITIONING" || (schema?.[0] === "COMFY_MATCHTYPE_V3" && String(schema?.[1]?.template?.allowed_types || "").split(",").includes("CONDITIONING"));
}
function compatibleSchema(node, names) { const inputs = schemaInputs(node); return !!node && names.every((name) => inputs[name]); }
export function refModReadiness(nodes = {}) {
  const loader = nodes[REFMOD_NODES.loader], apply = nodes[REFMOD_NODES.apply], extract = nodes[REFMOD_NODES.extract];
  const loaderFields = ["show_info", "max_total_tokens", ...Array.from({ length: 8 }, (_, i) => [`mod_${i + 1}`, `strength_${i + 1}`, `copies_${i + 1}`]).flat()];
  const applyFields = ["conditioning", "mods", "override", "retention", "curve_direction", "curve_shape", "curve_value", "scramble_seed", "max_total_tokens"];
  const extractFields = ["name", "mode", "concept_type", "vae", "ref_resolution", "pool_h", "pool_w", "latent_frames", "identity", "merge", "motion_only", "multiplier", "max_tokens", "description", "save", "budget_policy"];
  const loaderInputs = schemaInputs(loader), applyInputs = schemaInputs(apply), tweakInputs = schemaInputs(nodes[FIZGIG_NODE]);
  const canLoad = compatibleSchema(loader, loaderFields) && compatibleSchema(apply, applyFields) && loader?.output?.[0] === "H3_REF_MODS"
    && inputIs(loaderInputs.show_info, "BOOLEAN") && inputIs(loaderInputs.max_total_tokens, "INT")
    && Array.from({ length: 8 }, (_, i) => i + 1).every((slot) => choicesInclude(loaderInputs[`mod_${slot}`], "(none)") && inputIs(loaderInputs[`strength_${slot}`], "FLOAT") && inputIs(loaderInputs[`copies_${slot}`], "INT"))
    && nativeConditioning(applyInputs.conditioning) && inputIs(applyInputs.mods, "H3_REF_MODS")
    && inputIs(applyInputs.override, "BOOLEAN") && inputIs(applyInputs.retention, "FLOAT") && inputIs(applyInputs.max_total_tokens, "INT")
    && inputIs(applyInputs.curve_value, "FLOAT") && inputIs(applyInputs.scramble_seed, "INT")
    && choicesInclude(applyInputs.curve_direction, "constant") && choicesInclude(applyInputs.curve_shape, "linear");
  const canCreate = compatibleSchema(extract, extractFields) && extract?.output_node === true && !!(schemaInputs(extract).refs_image || schemaInputs(extract)["refs_image.ref_image_1"]);
  const choices = choicesOf(schemaInputs(loader).mod_1);
  return { canLoad, canCreate, names: choices.filter((name) => typeof name === "string" && name !== "(none)"),
    fizgig: compatibleSchema(nodes[FIZGIG_NODE], ["model", "high_freq_detail", "detail_mode", "composition", "prompt_strength", "report"])
      && inputIs(tweakInputs.model, "MODEL") && inputIs(tweakInputs.high_freq_detail, "FLOAT") && inputIs(tweakInputs.composition, "FLOAT")
      && inputIs(tweakInputs.prompt_strength, "FLOAT") && inputIs(tweakInputs.report, "BOOLEAN")
      && choicesInclude(tweakInputs.detail_mode, "stable across frames") && choicesInclude(tweakInputs.detail_mode, "per frame") && nodes[FIZGIG_NODE]?.output?.[0] === "MODEL" };
}

export function refModCreateOptions(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Cache creation must be an object.");
  const name = refModName(input.name);
  if (name.includes("/")) throw new Error("New cache name must be a single name, without a folder.");
  if (!Array.isArray(input.images) || !input.images.length || input.images.length > 8 || input.images.some((image) => typeof image !== "string" || !image || image.length > 180 || /[\\/\x00-\x1f:<>"|?*]/.test(image) || !/\.(png|jpe?g|webp)$/i.test(image))) throw new Error("Choose 1 to 8 library PNG, JPEG or WebP filenames.");
  const mode = input.mode ?? "encode";
  if (!["encode", "training"].includes(mode)) throw new Error("RefMod mode must be encode or training.");
  const options = { name, images: input.images, mode, resolution: boundedNumber(input.resolution, 512, 256, 1024, "Reference resolution", true),
    pool: boundedNumber(input.pool, 32, 2, 64, "Reference pool", true),
    refinementSteps: boundedNumber(input.refinementSteps, 0, 0, 500, "Refinement steps", true),
    maxTokens: boundedNumber(input.maxTokens, REFMOD_LIMITS.defaultTokens, 1, REFMOD_LIMITS.maxTokens, "Reference token budget", true),
    description: summary(input.description) };
  if (options.pool % 2 || options.resolution % 64) throw new Error("Pool must be even and resolution must be a multiple of 64.");
  return options;
}

export function refModExtractGraph(input, { videoVae, images = input.images } = {}) {
  const options = refModCreateOptions(input);
  if (options.pool % 2 || options.resolution % 64) throw new Error("Pool must be even and resolution must be a multiple of 64.");
  if (typeof videoVae !== "string" || !videoVae || /[\x00-\x1f]/.test(videoVae)) throw new Error("Choose the installed H3 video VAE first.");
  const graph = { 1: { class_type: "VAELoader", inputs: { vae_name: videoVae } } };
  const refs = {};
  images.forEach((name, i) => { graph[10 + i] = { class_type: "LoadImage", inputs: { image: name } }; refs[`refs_image.ref_image_${i + 1}`] = [String(10 + i), 0]; });
  graph[2] = { class_type: REFMOD_NODES.extract, inputs: { name: options.name, mode: options.mode, concept_type: "generic", vae: ["1", 0],
    ref_resolution: options.resolution, pool_h: options.pool, pool_w: options.pool, latent_frames: 1,
    identity: options.mode === "encode" ? 0 : options.refinementSteps, merge: false, motion_only: false, multiplier: 1,
    max_tokens: options.maxTokens, description: options.description, save: true, background_retention: 0,
    budget_policy: "error", ...refs } };
  return graph;
}

export function createH3RefModService({ config, objectInfo, submit, stageImage, workflowAssigned = () => null, roots = () => refModRoots(config) }) {
  const pending = new Map();
  function complete(name) { try { return pending.delete(refModName(name).toLowerCase()); } catch { return false; } }
  async function nodeDefinitions() {
    const nodes = {}, errors = [];
    await Promise.all([...Object.values(REFMOD_NODES), FIZGIG_NODE].map(async (name) => {
      try { Object.assign(nodes, await objectInfo(name)); } catch { errors.push(name); }
    }));
    return { nodes, reachable: errors.length === 0 };
  }
  async function status() {
    const [catalogue, definitions] = await Promise.all([listRefMods(roots()), nodeDefinitions()]);
    const ready = refModReadiness(definitions.nodes);
    return { ready: ready.canLoad && definitions.reachable, canCreate: ready.canCreate && definitions.reachable,
      fizgigReady: ready.fizgig && definitions.reachable, engineReachable: definitions.reachable,
      entries: catalogue.entries.map(({ root, file, ...entry }) => ({ ...entry, available: ready.names.includes(entry.name) })),
      problems: catalogue.problems, truncated: catalogue.truncated, limits: REFMOD_LIMITS,
      sources: { refmod: REFMOD_SOURCE, fizgig: FIZGIG_SOURCE },
      note: "Caches reuse H3 VAE latents. Compression can lose facial detail; identity and voice transfer are not guaranteed." };
  }
  async function inspect(name) {
    name = refModName(name);
    const catalogue = await listRefMods(roots());
    const found = catalogue.entries.find((row) => row.name === name);
    if (!found) throw new Error(`RefMod cache not found or invalid: ${name}.`);
    const { root, file, ...entry } = found;
    return entry;
  }
  async function checkRender(body, { engine = body.engine || "h3" } = {}) {
    const defaults = config.video?.engines?.h3 || {};
    const options = h3OptionalOptions({ ...body, bridge: body.bridge ?? defaults.bridge, bridgeAlpha: body.bridgeAlpha ?? defaults.bridgeAlpha }, engine);
    if (!options.refMods.length && !options.h3Tweaks) return { ...options, tokens: 0 };
    if (workflowAssigned()) throw new Error("RefMod caches and Fizgig tweaks require Studio's native H3 workflow. Unassign the custom Video workflow first.");
    // Fizgig patches attention. Saved sparse/cache settings count too, never silently fall through.
    if (options.h3Tweaks && ((body.sparse ?? defaults.sparse) === "sol-attn" || (body.blockCache ?? defaults.blockCache) === true)) throw new Error("Turn sparse attention and block cache off for Fizgig.");
    const definitions = await nodeDefinitions(), ready = refModReadiness(definitions.nodes);
    if (!definitions.reachable) throw new Error("The engine is unavailable. Check optional H3 nodes after the engine starts.");
    if (options.h3Tweaks && !ready.fizgig) throw new Error(`Install a compatible Fizgig H3 Tweaks pack and restart the engine: ${FIZGIG_SOURCE}`);
    if (options.refMods.length && !ready.canLoad) throw new Error(`Install a compatible MiniMaxH3Mod pack and restart the engine: ${REFMOD_SOURCE}`);
    let tokens = 0;
    const catalogue = options.refMods.length ? await listRefMods(roots()) : { entries: [] };
    for (const row of options.refMods) {
      if (!ready.names.includes(row.name)) throw new Error(`The engine does not list RefMod ${row.name}. Refresh its nodes or check the cache folder.`);
      const entry = catalogue.entries.find((cache) => cache.name === row.name);
      if (!entry) throw new Error(`RefMod cache not found or invalid: ${row.name}.`);
      if (entry.references.some((ref) => ref.kind === "audio")) throw new Error("This integration accepts visual RefMods only; audio bundles are not validated.");
      tokens += entry.tokens * row.copies;
    }
    if (tokens > options.refModOptions.maxTokens) throw new Error(`RefMod references need ${tokens} tokens; the budget is ${options.refModOptions.maxTokens}.`);
    return { ...options, tokens };
  }
  async function create(body, { actor = "human" } = {}) {
    const options = refModCreateOptions(body);
    const definitions = await nodeDefinitions(), ready = refModReadiness(definitions.nodes);
    if (!definitions.reachable || !ready.canCreate) throw new Error(`Install a compatible MiniMaxH3Mod pack and start the engine: ${REFMOD_SOURCE}`);
    const catalogue = await listRefMods(roots());
    if (catalogue.entries.some((row) => row.name.toLowerCase() === options.name.toLowerCase()) || catalogue.problems.some((row) => row.name.toLowerCase().replace(/\.safetensors$/, "") === options.name.toLowerCase()) || ready.names.some((name) => name.toLowerCase() === options.name.toLowerCase())) throw new Error("That cache name already exists. Choose a new name.");
    if (catalogue.truncated) throw new Error("Cache folder scan reached its limit. Use a smaller cache collection before creating another.");
    for (const root of roots()) {
      try { await lstat(path.join(root, `${options.name}.safetensors`)); throw new Error("That cache file already exists. Choose a new name."); }
      catch (err) { if (err.code !== "ENOENT") throw err; }
    }
    if (pending.has(options.name.toLowerCase())) throw new Error("That cache creation is already queued.");
    if (pending.size >= 128) throw new Error("Too many cache creations are queued. Wait for one to finish.");
    if (typeof stageImage !== "function" || typeof submit !== "function") throw new Error("RefMod creation is unavailable in this install.");
    const graph = refModExtractGraph(options, { videoVae: config.video?.engines?.h3?.videoVae });
    // Dynamic input and every literal are checked against the installed schema before queueing.
    const extractionInputs = schemaInputs(definitions.nodes[REFMOD_NODES.extract]);
    for (const [key, value] of Object.entries(graph[2].inputs)) {
      if (key.startsWith("refs_image.")) continue;
      const schema = extractionInputs[key];
      if (!schema) throw new Error(`Installed RefMod creator does not support ${key}.`);
      const choices = choicesOf(schema);
      if (choices.length && !choices.includes(value)) throw new Error(`Installed RefMod creator does not support ${key}=${value}.`);
    }
    pending.set(options.name.toLowerCase(), Date.now());
    try {
      for (const [index, image] of options.images.entries()) {
        const staged = await stageImage(image);
        if (typeof staged !== "string" || !staged) throw new Error(`Reference image is unavailable: ${image}.`);
        graph[10 + index].inputs.image = staged;
      }
      const run = await submit({ graph, via: "api.h3-refmod.create", actor, label: `RefMod ${options.name}`, adopt: false,
        note: "VAE reference cache creation. No H3 weights are trained.", wait: false });
      return { ok: true, name: options.name, run, mode: options.mode, maxTokens: options.maxTokens };
    } catch (err) { pending.delete(options.name.toLowerCase()); throw err; }
  }
  return { status, inspect, checkRender, create, complete };
}

export function createH3RefModRoutes({ json, readBody, sameOriginLocalJson, service, actorFrom = () => "human" }) {
  return async (req, res, url) => {
    if (url.pathname !== "/api/h3-refmods") return false;
    if (req.method !== "POST") { json(res, 405, { error: "Use POST with status, inspect or create." }); return true; }
    let body;
    try { body = await readBody(req, 8192); }
    catch (err) { json(res, err.tooBig ? 413 : 400, { error: "RefMod request must be JSON under 8 KiB." }); return true; }
    try {
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("RefMod request must be an object.");
      if (body.action === "status") json(res, 200, await service.status());
      else if (body.action === "inspect") json(res, 200, await service.inspect(body.name));
      else if (body.action === "create") {
        if (!sameOriginLocalJson(req)) { json(res, 403, { error: "Creating a RefMod requires a same-origin local JSON request." }); return true; }
        json(res, 200, await service.create(body, { actor: actorFrom(req) }));
      } else json(res, 400, { error: "Unknown RefMod action. Use status, inspect or create." });
    } catch (err) { json(res, 400, { error: err.message }); }
    return true;
  };
}
