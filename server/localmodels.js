/**
 * WEIGHTS THE USER ALREADY HAS, wherever they keep them.
 *
 * The catalogue in models.js knows exact file names and byte counts, which is
 * right for what Studio downloads and wrong for everything else: a models
 * folder on another drive, an fp16 build where the catalogue names int8, a
 * checkpoint nobody here has heard of. This module is the other half —
 *
 *   - scan the folders ComfyUI will actually load from, and say what is there;
 *   - write the extra_model_paths YAML that makes ComfyUI see a chosen folder;
 *   - let a local file STAND IN for a catalogue file (same model folder), and
 *     rename it in every graph at the engine door, before the ledger records
 *     the graph — so the record names the file that really rendered;
 *   - open a native folder picker, because a browser cannot hand over a path.
 *
 * Nothing here downloads, deletes or moves a file.
 */
import { readdir, stat, readFile, writeFile, mkdir } from "node:fs/promises";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";

/** ComfyUI's model folder names, as listed in its own extra_model_paths
 *  example. Scanned in this order. */
export const MODEL_FOLDERS = [
  "checkpoints", "diffusion_models", "unet", "text_encoders", "clip", "vae", "loras",
  "clip_vision", "controlnet", "upscale_models", "audio_encoders", "embeddings",
  "latent_upscale_models", "model_patches", "style_models", "background_removal",
  "frame_interpolation", "conditioning_bridges",
];

/* Folders ComfyUI treats as one shelf: a loader reading `diffusion_models`
 * also lists `unet`, and `text_encoders` also lists `clip`. */
const ALIASES = [["diffusion_models", "unet"], ["text_encoders", "clip"]];
export const folderGroup = (folder) => ALIASES.find((g) => g.includes(folder)) || [folder];
export const shelfOf = (folder) => folderGroup(folder)[0];

/** Loader inputs name files relative to a shelf, never arbitrary disk paths. */
export const MODEL_INPUT_FOLDERS = {
  unet_name: ["diffusion_models", "unet"], ckpt_name: ["checkpoints"],
  clip_name: ["text_encoders", "clip"], vae_name: ["vae"], lora_name: ["loras"],
  clip_vision: ["clip_vision"], clip_vision_name: ["clip_vision"],
  control_net_name: ["controlnet"], style_model_name: ["style_models"],
  audio_encoder_name: ["audio_encoders"], bg_removal_name: ["background_removal"],
  adapter: ["conditioning_bridges"],
  upscale_model: ["latent_upscale_models"],
  model_name: ["upscale_models", "background_removal", "frame_interpolation", "latent_upscale_models"],
};

/** Accept either separator so selections survive Windows/Linux handoffs. */
export function modelName(value) {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f:*?"<>|]/.test(value)
      || /^[\\/]/.test(value)) return null;
  const parts = value.split(/[\\/]/);
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join(path.sep);
}
export function requireModelName(value) {
  const name = modelName(value);
  if (!name) {
    const error = new Error("Choose a model filename relative to its shelf, not an absolute or parent path.");
    error.status = 400;
    throw error;
  }
  return name;
}
export const modelLeaf = (value) => String(value || "").split(/[\\/]/).pop();
const nameKey = (value) => {
  const name = modelName(value);
  return process.platform === "win32" ? name?.toLowerCase() : name;
};

/** Exact relative paths win. A bare name may locate one nested path, but never
 * choose between different subfolders with the same filename. A loader cannot
 * distinguish the same relative name in multiple physical shelves either. */
export function findShelfModel(files, folder, name, { fallback = true } = {}) {
  const wanted = modelName(name);
  if (!wanted) return null;
  const folders = Array.isArray(folder) ? folder : folderGroup(folder);
  const candidates = files.filter((file) => folders.includes(file.folder));
  const distinct = (rows) => [...new Map(rows.map((file) => [file.full ? key(file.full) : `${file.folder}/${nameKey(file.name)}`, file])).values()];
  const exacts = distinct(candidates.filter((file) => nameKey(file.name) === nameKey(wanted)));
  if (exacts.length > 1) {
    const error = new Error(`${wanted} exists in several configured model folders. Give each copy a distinct relative path or keep one copy.`);
    error.status = 400;
    throw error;
  }
  const exact = exacts[0];
  if (exact || !fallback || wanted !== modelLeaf(wanted)) return exact || null;
  const matches = distinct(candidates.filter((file) => nameKey(modelLeaf(file.name)) === nameKey(wanted)));
  if (matches.length > 1) {
    const error = new Error(`More than one ${wanted} exists. Choose its subfolder in the model picker.`);
    error.status = 400;
    throw error;
  }
  return matches[0] || null;
}

const WEIGHT_RE = /\.(safetensors|sft|gguf|ckpt|pt|pth|bin)$/i;

const key = (p) => {
  const r = path.resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
};
export const samePath = (a, b) => key(a) === key(b);

export function uniqueDirs(dirs) {
  const out = [];
  for (const d of dirs) if (d && !out.some((o) => samePath(o, d))) out.push(path.resolve(d));
  return out;
}

/** `base_path` of every --extra-model-paths-config YAML named in an argv. */
export async function extraBases(args = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--extra-model-paths-config" || !args[i + 1]) continue;
    try {
      const t = await readFile(args[i + 1], "utf-8");
      for (const m of t.matchAll(/^\s*base_path:\s*['"]?([^'"\r\n]+?)['"]?\s*$/gm)) out.push(m[1].trim());
    } catch { /* an unreadable YAML is ComfyUI's to report, in its own log */ }
  }
  return out;
}

/** extraBases, read synchronously: for config.js's picks and workflow.js
 *  videoReady(), which run where nothing can wait (an import, a status poll). */
export function extraBasesSync(args = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--extra-model-paths-config" || !args[i + 1]) continue;
    try {
      const t = readFileSync(args[i + 1], "utf-8");
      for (const m of t.matchAll(/^\s*base_path:\s*['"]?([^'"\r\n]+?)['"]?\s*$/gm)) out.push(m[1].trim());
    } catch { /* an unreadable YAML is ComfyUI's to report, in its own log */ }
  }
  return out;
}

/**
 * EVERY FOLDER THE ENGINE LOADS WEIGHTS FROM, one answer for every reader
 * (setF on 7b241ea): the models folder, the extra ones (modelsAlso), the
 * base_path of each extra_model_paths YAML the engine is launched with, and
 * the install's own ComfyUI/models. The Models screen (models.js), the engine
 * door (engine/client.js) and the Models-screen scan (index.js modelBases)
 * read all four; config.js's file picks and workflow.js videoReady() read only
 * the first two, so a pinned models folder with H3 in the rig's own
 * ComfyUI/models read "installed" on the Models screen and was refused with
 * "Get MiniMax H3 (0.0 GB)" on the Video screen, after a restart too.
 * `cfg` is config's shape: { modelsDir, modelsAlso, comfyDir, comfy: { extraArgs } }.
 */
const basesOf = (cfg, extra) => uniqueDirs([cfg?.modelsDir, ...(cfg?.modelsAlso || []), ...extra,
  cfg?.comfyDir ? path.join(cfg.comfyDir, "models") : null].filter(Boolean));
export const engineBasesSync = (cfg) => basesOf(cfg, extraBasesSync(cfg?.comfy?.extraArgs || []));
export const engineBases = async (cfg) => basesOf(cfg, await extraBases(cfg?.comfy?.extraArgs || []));

/**
 * Every weight file under each standard folder of each base. `name` is the
 * native relative loader path, e.g. minimax\\model.safetensors on Windows.
 * Directory links below a shelf are skipped to avoid cycles; a chosen base
 * or shelf can itself be a linked directory. Empty/partial files are skipped.
 */
export async function scanBases(bases) {
  const files = [];
  for (const base of uniqueDirs(bases)) {
    for (const folder of MODEL_FOLDERS) {
      const root = path.join(base, folder), pending = [root];
      while (pending.length) {
        const dir = pending.shift();
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { pending.push(full); continue; }
          if (!e.isFile() || !WEIGHT_RE.test(e.name)) continue;
          const st = await stat(full).catch(() => null);
          if (!st?.isFile() || st.size === 0) continue;
          files.push({ base, folder, shelf: shelfOf(folder), name: path.relative(root, full), full, bytes: st.size, at: st.mtimeMs });
        }
      }
    }
  }
  return files;
}

/** Startup/default selection and synchronous readiness share the same shelf
 * rules. No weight bytes are read. Callers reuse a snapshot when checking
 * several slots rather than rescanning it per candidate. */
export function scanBasesSync(bases) {
  const files = [];
  for (const base of uniqueDirs(bases)) for (const folder of MODEL_FOLDERS) {
    const root = path.join(base, folder), pending = [root];
    while (pending.length) {
      const dir = pending.shift();
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { pending.push(full); continue; }
        if (!e.isFile() || !WEIGHT_RE.test(e.name)) continue;
        let st;
        try { st = statSync(full); } catch { continue; }
        if (!st.isFile() || st.size === 0) continue;
        files.push({ base, folder, shelf: shelfOf(folder), name: path.relative(root, full), full, bytes: st.size, at: st.mtimeMs });
      }
    }
  }
  return files;
}

/** Rewrite only model-bearing loader inputs before hashing/submission. Prompts,
 * media inputs and output prefixes are never searched or changed. */
export function resolveGraphModels(graph, files) {
  if (!graph || typeof graph !== "object") return graph;
  let changed = false;
  const out = {};
  for (const [id, node] of Object.entries(graph)) {
    let next = null;
    for (const [input, value] of Object.entries(node?.inputs || {})) {
      // `adapter` is shelf-specific only on Studio's conditioning-bridge node.
      if (input === "adapter" && node.class_type !== "AiplayH3ConditioningBridge") continue;
      const folders = MODEL_INPUT_FOLDERS[input.replace(/\d+$/, "")];
      if (!folders || typeof value !== "string") continue;
      const found = findShelfModel(files, folders, value);
      if (found && found.name !== value) (next ||= { ...node.inputs })[input] = found.name;
    }
    out[id] = next ? { ...node, inputs: next } : node;
    if (next) changed = true;
  }
  return changed ? out : graph;
}

/** { folder: { files, bytes } } — the preview shown before a folder is adopted. */
export function countByFolder(files) {
  const out = {};
  for (const f of files) {
    const c = (out[f.folder] ||= { files: 0, bytes: 0 });
    c.files++; c.bytes += f.bytes;
  }
  return out;
}

/** Writes the YAML that makes ComfyUI load from `dir`, and returns its path. */
export async function writeModelPathsYaml(dir, appData, also = []) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  /* `also`: earlier models folders, still loaded from so a change of folder
   * never strands what was already downloaded (config.modelsAlso). */
  const block = (name, base, isDefault) => [
    `${name}:`,
    `  base_path: ${q(base)}`,
    ...(isDefault ? ["  is_default: true"] : []),
    ...MODEL_FOLDERS.map((f) => `  ${f}: ${f}/`),
  ];
  const body = [
    "# Written by AIPLAY Studio at every engine start — the models folder chosen",
    "# on the Models screen. Edits here are overwritten; change the folder there.",
    ...block("aiplay_models", dir, true),
    ...also.flatMap((d, i) => block(`aiplay_models_also_${i + 1}`, d, false)),
    "",
  ].join("\n");
  await mkdir(appData, { recursive: true });
  const file = path.join(appData, "extra_model_paths.aiplay.yaml");
  await writeFile(file, body, "utf-8");
  return file;
}

/**
 * A graph with every loader input naming an overridden catalogue file renamed
 * to its local stand-in. Only inputs that ARE file names — ComfyUI's loaders
 * call them unet_name, ckpt_name, clip_name2, lora_name … — and only exact
 * whole-string matches, so a prompt is never touched even if its whole text is
 * a file name. Returns the SAME object when nothing matched, so a graph without
 * overrides is hashed exactly as before.
 */
const FILE_INPUT = /(^|_)name\d*$/;
export function applyModelOverrides(graph, overrides) {
  if (!graph || typeof graph !== "object" || !overrides) return graph;
  const names = Object.keys(overrides).filter((k) => overrides[k]);
  if (!names.length) return graph;
  let changed = false;
  const out = {};
  for (const [id, node] of Object.entries(graph)) {
    const inputs = node?.inputs;
    let next = null;
    if (inputs && typeof inputs === "object") {
      for (const [k, v] of Object.entries(inputs)) {
        const modelInput = FILE_INPUT.test(k) || (node.class_type === "AiplayH3ConditioningBridge" && k === "adapter");
        if (typeof v === "string" && modelInput && names.includes(v)) (next ||= { ...inputs })[k] = overrides[v];
      }
    }
    if (next) { changed = true; out[id] = { ...node, inputs: next }; } else out[id] = node;
  }
  return changed ? out : graph;
}

/**
 * The OS folder picker, on the machine Studio runs on — which is the machine
 * the browser is on, since Studio only listens on loopback.
 * Resolves { path } (null when cancelled), { unsupported } off Windows, or
 * { error }.
 *
 * The caption is a parameter because the launcher asks for the other folder
 * Studio cannot guess — the ComfyUI install — through the same dialog, and a
 * picker captioned "your models" is how somebody hands it the wrong one.
 */
export const MODELS_PROMPT =
  "Choose the folder that holds your models (the one containing checkpoints, diffusion_models, vae, ...)";
export function pickFolderDialog(start = "", description = MODELS_PROMPT) {
  if (process.platform !== "win32") return Promise.resolve({ unsupported: true });
  const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const ps = [
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$o=New-Object System.Windows.Forms.Form -Property @{TopMost=$true;ShowInTaskbar=$false}",
    "$d=New-Object System.Windows.Forms.FolderBrowserDialog",
    `$d.Description=${lit(description)}`,
    "$d.ShowNewFolderButton=$false",
    `$d.SelectedPath=${lit(start)}`,
    "if($d.ShowDialog($o) -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.Write($d.SelectedPath)}",
  ].join(";");
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-STA", "-Command", ps],
      { timeout: 10 * 60_000, windowsHide: true },
      (err, stdout) => resolve(err
        ? { error: String(err.message || err).split("\n")[0] }
        : { path: String(stdout).trim() || null }));
  });
}
