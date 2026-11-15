/** Read-only ComfyUI discovery and a bounded check of its own Python. */
import { stat, readFile, readdir, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import path from "node:path";

const run = promisify(execFile);
const file = async (p) => { try { return (await stat(p)).isFile(); } catch { return false; } };
export const sameComfyPath = (a, b) => {
  const key = (p) => process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
  return !!a && !!b && key(a) === key(b);
};
export function desktopDirectory({ home = homedir(), env = process.env, platform = process.platform } = {}) {
  if (env.APPDATA) return path.join(env.APPDATA, "Comfy Desktop");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Comfy Desktop");
  if (platform === "linux") return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "comfyui-desktop-2");
  return path.join(home, "AppData", "Roaming", "Comfy Desktop");
}

export async function normalizeComfyRig(input) {
  if (typeof input !== "string" || !input.trim()) return null;
  const resolved = path.resolve(input.trim().replace(/^"|"$/g, ""));
  for (const rig of [resolved, path.dirname(resolved)]) {
    if (await file(path.join(rig, "ComfyUI", "main.py"))) return realpath(rig).catch(() => rig);
  }
  return null;
}

export async function pythonForComfy(rig) {
  const environments = ["venv", ".venv", "ComfyUI/.venv", "ComfyUI/venv"];
  const candidates = [
    ...environments.flatMap((dir) => [path.join(rig, dir, "Scripts", "python.exe"),
      path.join(rig, dir, "bin", "python"), path.join(rig, dir, "bin", "python3")]),
    ...["python_embeded", "python_embedded"].map((dir) => path.join(rig, dir, "python.exe")),
  ];
  for (const candidate of candidates) if (await file(candidate)) return candidate;
  return null;
}

export async function desktopInstalls(directory = desktopDirectory()) {
  let list;
  try { list = JSON.parse(await readFile(path.join(directory, "installations.json"), "utf8")); }
  catch { return []; }
  const result = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (typeof entry?.installPath !== "string" || entry.sourceId === "cloud") continue;
    const rig = await normalizeComfyRig(entry.installPath);
    if (!rig || result.some((item) => sameComfyPath(item.rig, rig))) continue;
    const yaml = path.join(directory, "instance-model-paths", `${entry.id}.yaml`);
    result.push({ rig, name: entry.name || path.basename(rig), source: "desktop", id: entry.id,
      variant: entry.variant || null, launchArgs: typeof entry.launchArgs === "string" ? entry.launchArgs : "",
      modelPaths: await file(yaml) ? yaml : null, lastLaunchedAt: Number(entry.lastLaunchedAt) || 0 });
  }
  return result.sort((a, b) => b.lastLaunchedAt - a.lastLaunchedAt);
}

export function defaultComfyRoots({ home = homedir(), env = process.env, platform = process.platform } = {}) {
  // Also lets isolated launcher subprocess tests avoid scanning a user's disks.
  if (env.AIPLAY_COMFY_SEARCH_ROOTS) {
    try {
      const roots = JSON.parse(env.AIPLAY_COMFY_SEARCH_ROOTS);
      if (Array.isArray(roots) && roots.every((root) => typeof root === "string")) return roots;
    } catch { /* A malformed override does not disable normal discovery. */ }
  }
  return [path.join(env.AIPLAY_APPDATA || path.join(home, ".aiplay-studio"), "engine"),
    path.join(home, "ComfyUI"), path.join(home, "Documents", "ComfyUI"), path.join(home, "Desktop", "ComfyUI"),
    path.join(home, "ComfyUI-Installs"),
    ...(platform === "win32" ? [env.LOCALAPPDATA || path.join(home, "AppData", "Local"),
      path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Programs"),
      env.APPDATA || path.join(home, "AppData", "Roaming"),
      path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Comfy-Desktop", "ComfyUI-Installs"),
      ...["C", "D", "E", "F"].flatMap((d) => [`${d}:\\ComfyUI`, `${d}:\\AI`, `${d}:\\AI\\ComfyUI`,
        `${d}:\\ComfyUI_windows_portable`, `${d}:\\StabilityMatrix`])] : []),
  ];
}

export async function discoverComfyInstalls({ roots = defaultComfyRoots(), desktopDir = desktopDirectory(), savedRig = null } = {}) {
  const installs = await desktopInstalls(desktopDir);
  const add = async (input, source = "folder") => {
    const rig = await normalizeComfyRig(input);
    if (!rig || installs.some((entry) => sameComfyPath(entry.rig, rig))) return;
    installs.push({ rig, name: path.basename(rig), source, lastLaunchedAt: 0 });
  };
  if (savedRig) await add(savedRig, "saved");
  for (const root of roots) {
    await add(root);
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isDirectory()) await add(path.join(root, entry.name));
      }
    } catch { /* Missing or unreadable search root. */ }
  }
  return installs;
}

/** A successful torch import is required; CPU, CUDA, ROCm and XPU all qualify.
 * Use a marker because Python startup hooks and package warnings may print. */
export async function validateComfyInstall(input, { timeout = 45_000, execute = run } = {}) {
  const rig = await normalizeComfyRig(input);
  if (!rig) return { rig: typeof input === "string" ? input : "", python: null, valid: false,
    error: "Choose the folder containing ComfyUI/main.py, or the ComfyUI folder itself." };
  const python = await pythonForComfy(rig);
  if (!python) return { rig, python: null, valid: false,
    error: "No Python environment was found beside this ComfyUI. Run it once first. Older Desktop installs with separate code and Python folders are not supported by this picker." };
  const code = "import json,torch;v=torch.version;print('AIPLAY_TORCH:'+json.dumps({'version':torch.__version__,'backend':'rocm' if getattr(v,'hip',None) or getattr(v,'rocm',None) else 'cuda' if getattr(v,'cuda',None) else 'xpu' if '+xpu' in torch.__version__ else 'cpu'}))";
  try {
    const { stdout = "" } = await execute(python, ["-s", "-c", code],
      { cwd: path.join(rig, "ComfyUI"), timeout, windowsHide: true, maxBuffer: 1 << 20 });
    const marker = String(stdout).split(/\r?\n/).find((line) => line.startsWith("AIPLAY_TORCH:"));
    const torch = marker && JSON.parse(marker.slice("AIPLAY_TORCH:".length));
    if (!torch?.version || !["cpu", "cuda", "rocm", "xpu"].includes(torch.backend)) throw new Error("Python did not report a usable PyTorch build.");
    return { rig, python, valid: true, error: null, torchBackend: torch.backend, torchVersion: torch.version };
  } catch (err) {
    const detail = err.killed || err.code === "ETIMEDOUT" ? `The Python check timed out after ${Math.round(timeout / 1000)} seconds.`
      : String(err.stderr || err.message || err).trim().split(/\r?\n/).filter(Boolean).at(-1);
    return { rig, python, valid: false, error: `This Python could not import PyTorch: ${detail}` };
  }
}

export async function listComfyInstalls(options = {}) {
  const installs = await discoverComfyInstalls(options);
  if (options.validate === false) return Promise.all(installs.map(async (entry) => {
    const python = await pythonForComfy(entry.rig);
    return { ...entry, python, valid: python ? null : false,
      error: python ? null : "No Python environment found. Run this ComfyUI installation once first." };
  }));
  // Bound simultaneous torch imports on machines with several large environments.
  const output = [];
  for (let offset = 0; offset < installs.length; offset += 2) {
    output.push(...await Promise.all(installs.slice(offset, offset + 2).map(async (entry) =>
      ({ ...entry, ...await validateComfyInstall(entry.rig, options.validation) }))));
  }
  return output;
}
