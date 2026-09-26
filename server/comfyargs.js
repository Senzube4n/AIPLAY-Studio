/**
 * COMFYUI LAUNCH OPTIONS — the launcher's Advanced settings, as flags.
 *
 * Studio launches ComfyUI itself, so ComfyUI's own command line is where
 * attention, memory and precision are decided. Nobody has to touch any of it:
 * with no choices saved, the arguments are exactly what they were before this
 * file existed (the VRAM tier's flags, then the flags copied from the user's
 * own ComfyUI install). A choice REPLACES its whole family in those — picking
 * PyTorch attention removes the install's `--use-ck-attention`; setting async
 * offload streams removes the tier's `--async-offload 4`, value and all — so
 * the result never carries two mutually exclusive flags for ComfyUI's argparse
 * to reject at startup.
 *
 * THE CATALOGUE IS CURATED, AND FILTERED BY THE INSTALL. Every flag here was
 * read from ComfyUI's `comfy/cli_args.py` (2026-09-16). availableOptions()
 * keeps only the flags the user's own cli_args.py still defines, so an older
 * or newer ComfyUI never offers a flag that would stop it starting.
 *
 * Flags Studio owns (port, listen address, folders, model paths) are not in
 * the catalogue and cannot be set from here.
 */

/** Flags Studio sets or must never pass. None may appear in COMFY_OPTIONS. */
export const STUDIO_OWNED = new Set([
  "--port", "--listen", "--output-directory", "--input-directory", "--temp-directory",
  "--extra-model-paths-config", "--base-directory", "--models-directory", "--user-directory",
  "--disable-auto-launch", "--auto-launch", "--quick-test-for-ci", "--dont-print-server",
  "--tls-keyfile", "--tls-certfile", "--enable-cors-header", "--list-feature-flags",
  /* The minors rule's backstop always loads: see keepSafetyGate below. */
  "--whitelist-custom-nodes",
]);

/** The Studio's own safety node (server/comfy_nodes/aiplay_safety_gate.py),
 *  by the name ComfyUI's custom-node loader knows it. */
export const SAFETY_GATE_MODULE = "aiplay_safety_gate.py";

/**
 * ⚠ NO SETTING TURNS THE MINORS BACKSTOP OFF, and "Don't load custom node
 * packs" is a setting. ComfyUI's --disable-all-custom-nodes skips every
 * custom-node module, the Studio's safety gate included, which would leave a
 * revealed or pinned port running graphs nobody checked. So when that flag is
 * in the launch (from the launcher OR copied from the install's own flags),
 * the gate is whitelisted by name (--whitelist-custom-nodes, which the install
 * must define), and an install too old to know that flag gets its custom
 * nodes back instead: the gate loads either way.
 */
export function keepSafetyGate(args, cliArgsText) {
  const a = (args || []).map(String);
  if (!a.includes("--disable-all-custom-nodes")) return a;
  const knows = typeof cliArgsText === "string" && cliArgsText.includes("\"--whitelist-custom-nodes\"");
  if (!knows) return a.filter((f) => f !== "--disable-all-custom-nodes");
  const i = a.indexOf("--whitelist-custom-nodes");
  if (i < 0) return [...a, "--whitelist-custom-nodes", SAFETY_GATE_MODULE];
  let j = i + 1;
  while (j < a.length && !a[j].startsWith("--")) j++;
  if (a.slice(i + 1, j).includes(SAFETY_GATE_MODULE)) return a;
  return [...a.slice(0, j), SAFETY_GATE_MODULE, ...a.slice(j)];
}

const choice = (id, section, label, help, choices, extra = {}) => ({ id, section, label, help, kind: "choice", choices, ...extra });
const bool = (id, section, label, flag, help, extra = {}) => ({ id, section, label, help, kind: "bool", flag, ...extra });
const number = (id, section, label, flag, help, range, extra = {}) => ({ id, section, label, help, kind: "number", flag, ...range, ...extra });

export const COMFY_OPTIONS = [
  /* ── performance ─────────────────────────────────────────────────────── */
  choice("attention", "Performance", "Attention",
    "How attention is computed. ComfyUI Desktop on AMD launches with Comfy Kitchen (CK); PyTorch SDPA is the portable default.", [
      { flag: "--use-pytorch-cross-attention", label: "PyTorch (SDPA)" },
      { flag: "--use-ck-attention", label: "Comfy Kitchen (CK)" },
      { flag: "--use-sage-attention", label: "SageAttention (needs the sageattention package)" },
      { flag: "--use-flash-attention", label: "FlashAttention (needs the flash-attn package)" },
      { flag: "--use-split-cross-attention", label: "Split cross attention" },
      { flag: "--use-quad-cross-attention", label: "Sub-quadratic cross attention" },
    ]),
  bool("noCompiler", "Performance", "Disable the Comfy model compiler", "--disable-comfy-compiler",
    "Also disables CUDA graphs. Try this if a model misbehaves right after an update."),
  bool("noCudaGraphs", "Performance", "Disable CUDA graphs", "--disable-cuda-graphs", ""),
  bool("nonBlocking", "Performance", "Force non-blocking tensor operations", "--force-non-blocking",
    "May be faster on non-NVIDIA cards; can cause problems."),
  bool("fast", "Performance", "Experimental optimisations (--fast)", "--fast",
    "Untested optimisations that may lower quality or crash."),
  bool("channelsLast", "Performance", "Force channels-last tensors", "--force-channels-last", ""),
  bool("deterministic", "Performance", "Deterministic algorithms (slower)", "--deterministic", ""),
  choice("triton", "Performance", "Comfy Kitchen Triton backend", "Needs the triton package.", [
    { flag: "--enable-triton-backend", label: "Enable" },
    { flag: "--disable-triton-backend", label: "Force off" },
  ]),

  /* ── memory ──────────────────────────────────────────────────────────── */
  choice("dynamicVram", "Memory", "Dynamic VRAM",
    "Dynamic VRAM stages weights on the card as they are needed.", [
      { flag: "--disable-dynamic-vram", label: "Off — estimate-based loading" },
      { flag: "--enable-dynamic-vram", label: "On — even where it is not the default" },
    ]),
  choice("vramMode", "Memory", "VRAM mode",
    "Overrides the memory tier Studio picks for your card.", [
      { flag: "--gpu-only", label: "GPU only — everything on the card" },
      { flag: "--highvram", label: "High — keep models on the card" },
      { flag: "--lowvram", label: "Low" },
      { flag: "--novram", label: "No VRAM (last resort)" },
    ]),
  number("reserveVram", "Memory", "Reserve VRAM for other apps (GB)", "--reserve-vram", "", { min: 0, max: 64, step: 0.1 }),
  number("vramHeadroom", "Memory", "Extra dynamic-VRAM headroom (GB)", "--vram-headroom", "", { min: 0, max: 64, step: 0.1 }),
  number("asyncOffload", "Memory", "Async offload streams", "--async-offload", "", { min: 1, max: 8, step: 1 },
    { family: ["--async-offload", "--disable-async-offload"] }),
  bool("noAsyncOffload", "Memory", "Disable async weight offloading", "--disable-async-offload", "",
    { family: ["--async-offload", "--disable-async-offload"] }),
  bool("noSmartMemory", "Memory", "Offload models to RAM after every use", "--disable-smart-memory",
    "Frees the card between jobs at the cost of reloading."),
  bool("noPinnedMemory", "Memory", "Disable pinned memory", "--disable-pinned-memory", ""),
  bool("fastDisk", "Memory", "Prefer fast disk over RAM for offloading", "--fast-disk", "For fast NVMe drives."),
  bool("noMmap", "Memory", "Don't memory-map safetensors files", "--disable-mmap",
    "Reads model files fully into RAM instead of mapping them."),
  bool("mmapTorch", "Memory", "Memory-map .ckpt / .pt files", "--mmap-torch-files", ""),
  choice("cache", "Memory", "Node result cache", "The default is RAM-pressure caching.", [
    { flag: "--cache-classic", label: "Classic (aggressive)" },
    { flag: "--cache-none", label: "None — re-run every node (least memory)" },
    { flag: "--high-ram", label: "High RAM" },
  ], { family: ["--cache-ram", "--cache-classic", "--cache-lru", "--cache-none", "--high-ram"] }),
  choice("cudaMalloc", "Memory", "cudaMallocAsync allocator", "", [
    { flag: "--cuda-malloc", label: "Enable" },
    { flag: "--disable-cuda-malloc", label: "Disable" },
  ]),

  /* ── precision ───────────────────────────────────────────────────────── */
  choice("precision", "Precision", "Global precision", "", [
    { flag: "--force-fp16", label: "Force fp16" },
    { flag: "--force-fp32", label: "Force fp32" },
  ]),
  choice("unet", "Precision", "Diffusion model precision", "", [
    { flag: "--bf16-unet", label: "bf16" }, { flag: "--fp16-unet", label: "fp16" }, { flag: "--fp32-unet", label: "fp32" },
    { flag: "--fp8_e4m3fn-unet", label: "fp8 e4m3fn (storage)" }, { flag: "--fp8_e5m2-unet", label: "fp8 e5m2 (storage)" },
  ]),
  choice("vae", "Precision", "VAE precision", "fp16 can produce broken output on some models.", [
    { flag: "--bf16-vae", label: "bf16" }, { flag: "--fp16-vae", label: "fp16" }, { flag: "--fp32-vae", label: "fp32" },
  ]),
  bool("cpuVae", "Precision", "Run the VAE on the CPU (slow)", "--cpu-vae", ""),
  choice("textEnc", "Precision", "Text encoder precision", "", [
    { flag: "--bf16-text-enc", label: "bf16" }, { flag: "--fp16-text-enc", label: "fp16" }, { flag: "--fp32-text-enc", label: "fp32" },
    { flag: "--fp8_e4m3fn-text-enc", label: "fp8 e4m3fn" }, { flag: "--fp8_e5m2-text-enc", label: "fp8 e5m2" },
  ]),
  choice("upcast", "Precision", "Attention upcasting", "", [
    { flag: "--force-upcast-attention", label: "Force on" },
    { flag: "--dont-upcast-attention", label: "Off" },
  ]),

  /* ── custom nodes ────────────────────────────────────────────────────── */
  bool("noCustomNodes", "Custom nodes", "Don't load custom node packs", "--disable-all-custom-nodes",
    "Studio's music graphs use only ComfyUI's built-in nodes, so this starts faster; your other node packs will not load in Studio's engine. Studio's own safety node still loads."),
  bool("noApiNodes", "Custom nodes", "Disable API nodes", "--disable-api-nodes", "Also stops the frontend reaching the internet."),
  bool("manager", "Custom nodes", "Enable ComfyUI-Manager", "--enable-manager", ""),
];

const OPTION = Object.fromEntries(COMFY_OPTIONS.map((o) => [o.id, o]));

/** Every flag this option can emit — and so every flag a choice replaces. */
export function familyOf(option) {
  if (option.family) return option.family;
  return option.kind === "choice" ? option.choices.map((c) => c.flag) : [option.flag];
}

/** The flags for one saved value, or [] when the value is unset or invalid. */
function flagsFor(option, value) {
  if (option.kind === "choice") return option.choices.some((c) => c.flag === value) ? [value] : [];
  if (option.kind === "bool") return value === true ? [option.flag] : [];
  const n = Number(value);
  if (value === null || value === "" || value === undefined || !Number.isFinite(n) || n < option.min || n > option.max) return [];
  return [option.flag, String(n)];
}

/** Only the options — and the choices — this install's cli_args.py defines. */
export function availableOptions(cliArgsText) {
  const has = (flag) => typeof cliArgsText === "string" && cliArgsText.includes(`"${flag}"`);
  const out = [];
  for (const o of COMFY_OPTIONS) {
    if (o.kind === "choice") {
      const choices = o.choices.filter((c) => has(c.flag));
      if (choices.length) out.push({ ...o, choices });
    } else if (has(o.flag)) {
      out.push(o);
    }
  }
  return out;
}

/** Saved values reduced to known option ids with valid values. */
export function cleanValues(values) {
  const out = {};
  for (const [id, v] of Object.entries(values && typeof values === "object" ? values : {})) {
    const o = OPTION[id];
    if (o && flagsFor(o, v).length) out[id] = o.kind === "number" ? Number(v) : v;
  }
  return out;
}

/* ComfyUI's VRAM modes (one argparse group; "normal" is having none). */
export const VRAM_MODES = new Set(["--gpu-only", "--highvram", "--normalvram", "--lowvram", "--novram"]);

/**
 * The Auto tier's flags, from the card's memory: under 12 GB streams weights
 * from system RAM (--lowvram); 12 GB and up runs ComfyUI's normal mode, which
 * loads what fits and moves the rest out when the next model needs the room.
 * A 12 GB card reads a little under 12 (hence the half-GB margin). Unknown
 * memory keeps the old, cautious --lowvram.
 *
 * ⚠ NO --highvram, AT ANY SIZE. It used to be the answer above 16 GB, and it
 * tells ComfyUI never to move a model off the card. Studio loads a music model,
 * then an image model, then a video model: with nothing allowed to leave, a
 * 24 GB Quadro RTX 6000 filled up, and on Windows the NVIDIA driver then spills
 * into shared system memory instead of failing, which is the 15-minute render
 * and the "soft crash". Normal mode keeps a model resident exactly as long as
 * there is room for it, which is all --highvram was ever buying. It stays in
 * Advanced for anyone who runs one model forever on a server card.
 *
 * ⚠ THE 12 GB LINE AND H3 (lab, 2026-09-24). H3 rendered bit-identical under a
 * 12 GB cap, but that run used --lowvram. What this function gives a real
 * 12 GB card, normal mode, was never run at 12 GB. The flags are unchanged
 * until it is; server/h3tier.js carries the same caveat in its tier sentence
 * and config.js's Auto note says it to the person.
 */
export function autoVramFlags(totalMb) {
  const gb = Number(totalMb) / 1024;
  if (!Number.isFinite(gb) || gb <= 0 || gb < 11.5) return ["--lowvram", "--async-offload", "4"];
  return ["--async-offload", "4"];
}

/** `args` without any flag in `families`, dropping each removed flag's values too. */
export function stripFlags(args, families) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (!families.has(args[i])) { out.push(args[i]); continue; }
    while (i + 1 < args.length && !String(args[i + 1]).startsWith("--")) i++;
  }
  return out;
}

/**
 * The flags ComfyUI launches with: the tier's, then (unless turned off) the
 * install's, each with every family the user chose removed — then the choices.
 */
export function buildLaunchArgs({ tierFlags = [], installFlags = [], useInstallFlags = true, values = {} } = {}) {
  const clean = cleanValues(values);
  const chosen = Object.keys(clean).map((id) => OPTION[id]);
  const families = new Set(chosen.flatMap(familyOf));
  /* ONE VRAM MODE, and Studio's tier decides it. The modes are mutually
   * exclusive in ComfyUI's argparse, and an install can carry its own (ComfyUI
   * Desktop records --highvram when it is set there): beside the tier's
   * --lowvram that stopped ComfyUI starting ("argument --highvram: not allowed
   * with argument --lowvram"). The tier is chosen from the card's memory
   * (autoVramFlags), so the install's mode is dropped; a mode chosen in the
   * launcher's Advanced settings still replaces both (the families below). */
  const install = stripFlags((useInstallFlags ? installFlags : []).map(String), VRAM_MODES);
  const base = [...tierFlags.map(String), ...install];
  /* --cpu (a CPU-only engine) is mutually exclusive with every VRAM mode in
   * ComfyUI's argparse, so the tier's --lowvram would stop it starting at all;
   * GPU offload streams mean nothing there either. */
  if (base.includes("--cpu")) {
    for (const f of ["--gpu-only", "--highvram", "--normalvram", "--lowvram", "--novram", "--async-offload", "--reserve-vram"]) families.add(f);
  }
  return [...stripFlags(base, families), ...chosen.flatMap((o) => flagsFor(o, clean[o.id]))];
}

/* ── Studio's defaults ─────────────────────────────────────────────────────
 *
 * PyTorch attention and CUDA graphs off, unless the person chose otherwise.
 * Reported 2026-09-18 on an RX 9060 XT (ROCm, ComfyUI Desktop): with these two
 * flags MiniMax Music 3 renders real music where it had come out as broken or
 * full-scale noise, and ACE-Step 1.5 renders too. Harmless elsewhere: PyTorch
 * SDPA is the portable attention and CUDA graphs are an optimisation.
 *
 * `comfyOptionsRev` marks settings saved from a launcher that showed these
 * defaults. Settings saved before it (rev 1, or none) get the defaults laid
 * over them once — an attention choice made before the fix was known is
 * replaced — and anything saved after is taken as it is. A default is only
 * applied when this install's cli_args.py defines its flag, because an unknown
 * flag stops ComfyUI starting. */
export const DEFAULT_OPTIONS = { attention: "--use-pytorch-cross-attention", noCudaGraphs: true };
export const OPTIONS_REV = 3;

/* THE SWITCH (2026-09-19). The two flags were laid on every machine at rev 2.
 * On NVIDIA they change nothing for the better: without xformers, Sage or
 * flash-attn installed ComfyUI's attention IS PyTorch SDPA, and CUDA graphs
 * are an optimisation the model compiler and the weight prefetcher use. So
 * the fix is a setting — `comfyAmdFix`: "auto" (on for AMD and Intel, off for
 * NVIDIA and a card nobody could read), "on", "off" — and the card decides in
 * auto. Settings stamped at rev 2 with exactly the two defaults are read as
 * the defaults they were, not as a choice; anything else saved at rev 2 or 3
 * is the person's. */
export const FIX_MODES = ["auto", "on", "off"];
export const fixMode = (v) => (FIX_MODES.includes(v) ? v : "auto");
/** The card's vendor as the settings know it: the launcher's reading, or the
 *  torch backend when only that was recorded (ROCm is AMD). */
export const vendorOf = (gpu, torchBackend) => gpu?.vendor || (torchBackend === "rocm" ? "amd" : null);
export function fixApplies(mode, vendor) {
  const m = fixMode(mode);
  if (m === "on") return true;
  if (m === "off") return false;
  return vendor === "amd" || vendor === "intel";
}

/** The attention the PERSON chose, for rules that give way to one (art.js
 *  h3Attention), or null. With the fix on, its PyTorch attention is laid over
 *  every launch whatever was saved, and the launcher's Advanced panel shows it
 *  as the value, so any Save there stores it. That value is the fix speaking,
 *  not the person: read as their choice, it would quietly take H3's per-graph
 *  Comfy Kitchen node away on every AMD install whose panel was ever saved.
 *  Someone on AMD who wants H3 on PyTorch turns the fix off and picks it. */
export function chosenAttention(saved, { fix = "auto", vendor = null } = {}) {
  const a = typeof saved === "string" && saved ? saved : null;
  if (a === DEFAULT_OPTIONS.attention && fixApplies(fix, vendor)) return null;
  return a;
}

export function effectiveValues(saved, rev, cliArgsText, { fix = "auto", vendor = null } = {}) {
  let clean = cleanValues(saved);
  const has = (flag) => typeof cliArgsText === "string" && cliArgsText.includes(`"${flag}"`);
  const r = Number(rev) || 1;
  if (r < 3 && r >= 2 && clean.attention === DEFAULT_OPTIONS.attention && clean.noCudaGraphs === true) {
    /* Stamped by the rev-2 launcher, which showed the defaults as ticked. */
    const { attention, noCudaGraphs, ...rest } = clean;
    clean = rest;
  }
  if (!fixApplies(fix, vendor)) return clean;
  const defaults = {};
  for (const [id, v] of Object.entries(DEFAULT_OPTIONS)) {
    if (flagsFor(OPTION[id], v).every(has)) defaults[id] = v;
  }
  return { ...clean, ...defaults };
}

/** The two flags that made MiniMax Music 3 render on AMD. */
export const AMD_MUSIC_FIX = ["--use-pytorch-cross-attention", "--disable-cuda-graphs"];
export const hasAmdMusicFix = (args) => AMD_MUSIC_FIX.every((f) => (args || []).includes(f));
