/** Official optional W6A8 H3 builds; metadata checked against HF 2026-09-30.
 * W6A8 is an experiment, never the automatic replacement for a measured build.
 * Readiness checks installed source in the configured engine Python only. */
import fs from "node:fs";
import path from "node:path";

export const H3_W6A8_FILES = Object.freeze([
  { id: "videoW6A8", role: "fl2va", addonFor: "video", file: "minimax_h3_fl2va_pruned_w6a8.safetensors",
    sha256: "ac746a2e41628ab25afd44d2b22a7fab8d7e66cd07a01bf89ed9d74b0d3f0c35" },
  { id: "videoRefsW6A8", role: "ref2va", addonFor: "videoRefs", file: "minimax_h3_ref2va_pruned_w6a8.safetensors",
    sha256: "ece96bbbce76670ec782de84acc888fd9d9b210bd2ab97c1957b39896734f9f1" },
].map((file) => Object.freeze({ ...file, bytes: 15_983_746_636, gated: false,
  revision: "e5eb578a89295337b8ff433a035929ce0279e0b6",
  url: `https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/e5eb578a89295337b8ff433a035929ce0279e0b6/diffusion_models/${file.file}`,
})));

export const H3_W6A8_CAVEAT = "Experimental W6A8: 15.98 GB per transformer. Quality, render speed and memory use have not been benchmarked here. Requires NVIDIA CUDA, ComfyUI's w6a8_int8 loader and a comfy-kitchen build with six-bit support.";
export const isH3W6A8File = (name) => /(?:^|[\\/])minimax_h3_(?:fl2va|ref2va)_pruned_w6a8\.safetensors$/i.test(String(name || ""));

/** Pure runtime verdict. Missing evidence remains unknown rather than ready. */
export function h3W6a8Compatibility({ gpu = null, torchBackend = null, loader = null,
  kitchenSixbit = null, kitchenVersion = null, torchCuda = null, python = null } = {}) {
  const vendor = gpu?.vendor?.toLowerCase() || null;
  const blocked = ["rocm", "xpu", "cpu", "directml"].includes(torchBackend) || (vendor && vendor !== "nvidia");
  const reasons = [];
  if (blocked) reasons.push("W6A8 is offered only on NVIDIA CUDA; keep the existing H3 build on this machine.");
  else if (vendor !== "nvidia") reasons.push("The NVIDIA card has not been identified.");
  if (loader !== true) reasons.push("The configured ComfyUI source does not confirm a w6a8_int8 loader.");
  if (kitchenSixbit !== true) reasons.push("The configured engine Python does not confirm comfy-kitchen six-bit support (0.2.36 or later).");
  const cudaMajor = /^\d+(?:\.\d+)*$/.test(String(torchCuda || "")) ? Number(String(torchCuda).split(".")[0]) : null;
  if (cudaMajor === null) reasons.push("The configured engine Python's CUDA build has not been read.");
  else if (cudaMajor < 13) reasons.push("ComfyUI's optimized CUDA operations require a PyTorch CUDA 13 build or later.");
  const ready = !reasons.length;
  return { ready, state: ready ? "compatible" : blocked ? "unsupported" : "unavailable",
    downloadable: !blocked && vendor === "nvidia", experimental: true, benchmarked: false,
    reason: reasons.join(" "), reasons, loader, kitchenSixbit, kitchenVersion, torchCuda, python,
    note: H3_W6A8_CAVEAT,
    sources: ["https://github.com/Comfy-Org/ComfyUI/pull/16483", "https://github.com/Comfy-Org/comfy-kitchen/pull/191"],
  };
}

const read = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } };
function sitePackages(python) {
  const executableDir = path.dirname(String(python || "")), env = path.basename(executableDir).toLowerCase();
  const root = ["scripts", "bin"].includes(env) ? path.dirname(executableDir) : executableDir;
  const roots = [path.join(root, "Lib", "site-packages"), path.join(root, "lib", "site-packages")];
  try {
    for (const entry of fs.readdirSync(path.join(root, "lib"))) if (/^python\d+\.\d+$/.test(entry)) roots.push(path.join(root, "lib", entry, "site-packages"));
  } catch { /* Portable Windows Python and an absent environment have no lib/. */ }
  /* A separately configured engine venv may inherit libraries through plain
   * .pth paths. Follow those paths in import order; never execute .pth code. */
  const seen = new Set();
  for (let i = 0; i < roots.length; i++) {
    const rootKey = path.resolve(roots[i]);
    if (seen.has(rootKey)) continue;
    seen.add(rootKey);
    try {
      for (const file of fs.readdirSync(roots[i]).filter((entry) => entry.endsWith(".pth")).sort()) {
        for (const line of (read(path.join(roots[i], file)) || "").split(/\r?\n/)) {
          const entry = line.trim();
          if (!entry || entry.startsWith("#") || /^import[ \t]/.test(entry)) continue;
          const inherited = path.resolve(roots[i], entry);
          if (!roots.includes(inherited)) roots.push(inherited);
        }
      }
    } catch { /* No installed libraries, or an unreadable path. */ }
  }
  return [...new Set(roots)];
}

/** Read-only source evidence, no Python process, GPU probe, download or update.
 * The package location comes from config.python, never another benchmark venv. */
export function probeH3W6a8({ python, comfyDir, modelsDir, modelsAlso = [], gpu = null, torchBackend = null } = {}) {
  const quant = read(path.join(comfyDir || "", "comfy", "quant_ops.py"));
  const ops = read(path.join(comfyDir || "", "comfy", "ops.py"));
  const loader = quant === null || ops === null ? null
    : /QUANT_ALGOS\s*\[\s*["']w6a8_int8["']\s*\]/.test(quant)
      && /_GROUPED_INT8_FORMATS\s*=\s*\{[^}]*["']w6a8_int8["']\s*:\s*6/s.test(ops);
  let kitchenSixbit = null, kitchenVersion = null, torchCuda = null, packageRoot = null;
  const roots = python ? sitePackages(python) : [];
  for (const root of roots) {
    const layout = read(path.join(root, "comfy_kitchen", "tensor", "w4a8_int8.py"));
    if (layout === null) continue;
    packageRoot = root;
    kitchenSixbit = /bits\s*:\s*int\s*=/.test(layout) && /6-bit/.test(layout) && /def bits\(/.test(layout);
    try {
      const metadata = fs.readdirSync(root).find((entry) => /^comfy_kitchen-[^-]+\.dist-info$/i.test(entry));
      kitchenVersion = metadata ? read(path.join(root, metadata, "METADATA"))?.match(/^Version:\s*(.+)$/m)?.[1]?.trim() ?? null : null;
    } catch { /* Source installs do not need dist-info for source support. */ }
    break;
  }
  for (const root of roots) {
    const version = read(path.join(root, "torch", "version.py"));
    if (version === null) continue;
    torchCuda = version.match(/^cuda(?:\s*:[^=\n]+)?\s*=\s*["']([^"']+)["']/m)?.[1] ?? null;
    break;
  }
  const files = Object.fromEntries(H3_W6A8_FILES.map((build) => [build.role, {
    file: build.file, bytes: build.bytes,
    present: [modelsDir, ...modelsAlso].filter(Boolean).some((base) => ["diffusion_models", "unet"].some((folder) => {
      try { return fs.statSync(path.join(base, folder, build.file)).size === build.bytes; } catch { return false; }
    })),
  }]));
  return { ...h3W6a8Compatibility({ gpu, torchBackend, loader, kitchenSixbit, kitchenVersion, torchCuda, python }),
    packageRoot, sourceEvidenceOnly: true, files };
}

/** A saved request survives an unavailable runtime. The returned fallback file
 * is the ordinary configured checkpoint; callers can display/record the reason. */
export function resolveH3Checkpoint({ modelBuild = "auto", current, reference = false, runtime = {}, installed } = {}) {
  const compatibility = runtime?.state ? runtime : h3W6a8Compatibility(runtime);
  const file = H3_W6A8_FILES.find((entry) => entry.role === (reference ? "ref2va" : "fl2va")).file;
  const requested = modelBuild === "w6a8";
  const present = installed ?? runtime.files?.[reference ? "ref2va" : "fl2va"]?.present ?? false;
  const selected = requested && compatibility.ready && present;
  return { file: selected ? file : current, selected, requested,
    fallback: requested && !selected ? compatibility.reason || `${file} is not installed at its verified size.` : null, compatibility };
}
