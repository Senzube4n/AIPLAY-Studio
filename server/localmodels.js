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
import { execFile } from "node:child_process";
import path from "node:path";

/** ComfyUI's model folder names, as listed in its own extra_model_paths
 *  example. Scanned in this order. */
export const MODEL_FOLDERS = [
  "checkpoints", "diffusion_models", "unet", "text_encoders", "clip", "vae", "loras",
  "clip_vision", "controlnet", "upscale_models", "audio_encoders", "embeddings",
  "latent_upscale_models", "model_patches", "style_models", "background_removal",
  "frame_interpolation",
];

/* Folders ComfyUI treats as one shelf: a loader reading `diffusion_models`
 * also lists `unet`, and `text_encoders` also lists `clip`. */
const ALIASES = [["diffusion_models", "unet"], ["text_encoders", "clip"]];
export const folderGroup = (folder) => ALIASES.find((g) => g.includes(folder)) || [folder];
export const shelfOf = (folder) => folderGroup(folder)[0];

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

/**
 * Every weight file at the top level of each standard folder of each base.
 * Top level only: a loader names a file by its path relative to the folder,
 * and a nested name's separator differs by platform.
 */
export async function scanBases(bases) {
  const files = [];
  for (const base of uniqueDirs(bases)) {
    for (const folder of MODEL_FOLDERS) {
      let entries;
      try { entries = await readdir(path.join(base, folder), { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isFile() || !WEIGHT_RE.test(e.name)) continue;
        const full = path.join(base, folder, e.name);
        const st = await stat(full).catch(() => null);
        if (!st || st.size === 0) continue;
        files.push({ base, folder, shelf: shelfOf(folder), name: e.name, full, bytes: st.size, at: st.mtimeMs });
      }
    }
  }
  return files;
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
        if (typeof v === "string" && FILE_INPUT.test(k) && names.includes(v)) (next ||= { ...inputs })[k] = overrides[v];
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
