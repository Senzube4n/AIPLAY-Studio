/** H3 ControlNet compatibility from bounded metadata/table reads, never model loading. */
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { readHeader } from "./detect.js";
import { videoGraphH3 } from "./workflow.js";
import { applyModelOverrides, resolveGraphModels, findShelfModel } from "./localmodels.js";

const error = (text) => Object.assign(new Error(text), { reason: "control-compatibility", status: 400 });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
export const FULL_H3_CONTROL_BYTES = 6806843904;
// Canonical JSON of the publisher's 74-tensor header, checked at immutable
// revision 4d670e9e8f1c96b001a8b8ddec0a269de448a1b0 (only 8184 header bytes).
export const FULL_H3_CONTROL_HEADER_SHA256 = "77b01d27c474b39ae4a29d68883be22e763a4b6f580c5c4abb55979bdebdafc4";
export function validateFullH3ControlRawHeader(raw) {
  if (raw.length !== 8184 || hash(raw) !== "ab8de96d38ff73976782ae000949079863b69939949746d5237e1c70460a1194")
    throw error("The full-width H3 control header bytes do not match the pinned original v1 file.");
}
export function validateFullH3ControlHeader(header, headerBytes, fileBytes) {
  if (fileBytes !== FULL_H3_CONTROL_BYTES || headerBytes !== 8184 || hash(JSON.stringify(sorted(header))) !== FULL_H3_CONTROL_HEADER_SHA256)
    throw error("The full-width H3 control patch does not match the supported original v1 tensor layout. Get the pinned full-width patch on the Models screen.");
}
// Separately identified stock tables. Equal width alone does not identify a
// basis: the published FL2VA and REF2VA tables themselves have different bytes.
export const H3_CONTROL_STOCK_TABLES = Object.freeze({
  ac8727cdec52137c73878d004de5bd2a0e19227e8311e29ab3b68f328310e34e: "official-fl2va",
  c02a6c11888297688c1e6278185ea1f947023acfc69f9003bbcdcec9a229a8e7: "official-ref2va",
});

const shape = (tensor, wanted) => Array.isArray(tensor?.shape) && tensor.shape.length === wanted.length && tensor.shape.every((n, i) => n === wanted[i]);
function normalized(header) {
  const out = Object.create(null);
  for (const [name, value] of Object.entries(header)) {
    const key = name.replace(/^(?:model\.)?diffusion_model\./, "");
    if (Object.hasOwn(out, key)) throw error("The selected H3 file has ambiguous tensor names.");
    out[key] = value;
  }
  return out;
}

/** Build the same checkpoint selector as rendering, then apply the door's one-hop overrides. */
export function h3ControlCheckpointSelection(request, { models = null, refImages, refAudios, width, height, frames, fps = 24 } = {}) {
  const graph = videoGraphH3({ ...request, prompt: "", seed: 0, seconds: frames / fps, width, height, models,
    refImages: refImages ?? request.refImages, refAudios: refAudios ?? request.refAudios,
    engine: "h3", bridge: "off", bridgeAlpha: 0, sparse: "off", blockCache: false,
    refMods: null, h3Tweaks: null, controlVideo: null, controlPatch: null });
  const file = graph[1]?.inputs?.unet_name;
  if (typeof file !== "string") throw error("The H3 checkpoint selection could not be identified.");
  return { file, reference: graph.h3CheckpointChoice?.reference === true };
}

export function effectiveH3ControlCheckpoint(file, overrides, shelf) {
  const graph = { 1: { class_type: "UNETLoader", inputs: { unet_name: file } } };
  const overridden = applyModelOverrides(graph, overrides)[1].inputs.unet_name;
  const resolved = resolveGraphModels(applyModelOverrides(graph, overrides), shelf)[1].inputs.unet_name;
  const row = findShelfModel(shelf, ["diffusion_models", "unet"], resolved);
  if (!row?.full) throw error("The selected H3 checkpoint is missing or ambiguous in the configured model shelves.");
  return { requested: file, overridden, name: row.name, file: row.full };
}

export async function h3ControlHeader(file, { patch = false, stockTables = H3_CONTROL_STOCK_TABLES } = {}) {
  const before = await stat(file);
  const { json, headerBytes } = await readHeader(file);
  if (!json || typeof json !== "object" || Array.isArray(json)) throw error("The selected H3 file has no readable tensor header.");
  const tensors = normalized(json), metadata = json.__metadata__ || {};
  let form, tableSha256 = null;
  if (patch) {
    const width = tensors["control_blocks.0.adaln_proj.linear.weight"]?.shape?.[1];
    form = metadata.minimax_h3_fun_controlnet === "adaln_basis" && width === 8 ? "stock-curve" : width === 2688 && !metadata.minimax_h3_fun_controlnet ? "full" : null;
    if (!form || !shape(tensors["control_proj_in.weight"], [5376, 196])) throw error("The selected control patch has an unknown H3 modulation form.");
    if (form === "full") {
      validateFullH3ControlHeader(json, headerBytes, before.size);
      const handle = await open(file, "r");
      try {
        const raw = Buffer.alloc(headerBytes), got = await handle.read(raw, 0, raw.length, 8);
        if (got.bytesRead !== raw.length) throw error("The full-width H3 control header is incomplete.");
        validateFullH3ControlRawHeader(raw);
      } finally { await handle.close(); }
    }
    for (let i = 0; i < 5; i++) {
      if (!shape(tensors[`control_blocks.${i}.adaln_proj.linear.weight`], [96768, width]))
        throw error("The selected H3 control patch has inconsistent AdaLN shapes.");
    }
    const required = form === "full" ? ["control_blocks.0.attn.to_q.weight", "control_blocks.0.attn.to_k.weight", "control_blocks.0.attn.to_v.weight", "control_blocks.0.ff.net.0.proj.weight"]
      : ["control_blocks.0.attn.qkv_proj.weight", "control_blocks.0.mlp.fc1.weight"];
    if (required.some(key => !tensors[key])) throw error("The selected H3 control patch does not have the expected loader layout.");
  } else {
    if (!tensors["video_patch_proj.weight"] || !tensors["blocks.0.attn.qkv_proj.weight"])
      throw error("The selected checkpoint is not a recognized H3 transformer.");
    const table = tensors.adaln_t_table;
    if (table) {
      if (!shape(table, [1025, 8]) || table.dtype !== "F32" || tensors["time_embedder.proj_out.weight"])
        throw error("The selected H3 curve checkpoint has an unsupported table layout.");
      const offsets = table.data_offsets;
      if (!Array.isArray(offsets) || offsets.length !== 2 || !offsets.every(Number.isSafeInteger) || offsets[0] < 0 || offsets[1] - offsets[0] !== 32800 || 8 + headerBytes + offsets[1] > before.size)
        throw error("The selected H3 curve table is truncated or out of bounds.");
      const handle = await open(file, "r");
      try {
        const bytes = Buffer.alloc(32800);
        const got = await handle.read(bytes, 0, bytes.length, 8 + headerBytes + offsets[0]);
        if (got.bytesRead !== bytes.length) throw error("The selected H3 curve table could not be read completely.");
        tableSha256 = hash(bytes);
      } finally { await handle.close(); }
      if (!Object.hasOwn(stockTables, tableSha256)) throw error("This H3 checkpoint has an unverified curve basis. A matching control patch is required; width 8 alone does not establish compatibility.");
      form = "stock-curve";
    } else {
      if (!shape(tensors["time_embedder.proj_in.weight"], [5376, 256]) || !shape(tensors["time_embedder.proj_out.weight"], [2688, 5376]))
        throw error("The selected H3 checkpoint has an unknown full-width timestep layout.");
      form = "full";
    }
    for (let i = 0; i < 50; i++) {
      if (!shape(tensors[`blocks.${i}.adaln_proj.linear.weight`], [96768, form === "full" ? 2688 : 8]))
        throw error("The selected H3 checkpoint has inconsistent AdaLN shapes.");
    }
  }
  const after = await stat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw error("An H3 model changed while its compatibility was checked.");
  return { form, bytes: before.size, mtimeMs: before.mtimeMs, headerSha256: hash(JSON.stringify(json)), ...(tableSha256 ? { tableSha256 } : {}) };
}
