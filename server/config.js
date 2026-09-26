/**
 * Ship configuration — every value here was measured, not chosen.
 * Where a number is an estimate it says so; where a claim was withdrawn, the
 * data that withdrew it stays in the file beside it.
 */
import fs from "node:fs";
import { autoVramFlags } from "./comfyargs.js";
/* The card tiers' sizes join H3's size list (below the engines): pure data. */
import { H3_TIERS, H3_SOL_ATTN, H3_MORE_MOTION, H3_BLOCK_CACHE } from "./h3tier.js";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

/**
 * Where the settings a user can change actually live.
 *
 * Three layers, most specific first: an environment variable, then a JSON file
 * written by `setup` or by the Settings screen, then the built-in default. The
 * file layer is what makes this installable by someone who is never going to
 * edit a .js — which is the entire difference between a rig and a product.
 *
 * Read synchronously and defensively: config is imported by everything, and a
 * hand-edited settings file with a trailing comma must not take the app down.
 */
/* AIPLAY_APPDATA exists for tests: an isolated e2e run must not read or write
 * the real user's settings, library sidecar or provenance ledger. */
const APPDATA = process.env.AIPLAY_APPDATA || path.join(os.homedir(), ".aiplay-studio");
const SETTINGS_FILE = path.join(APPDATA, "settings.json");
let saved = {};
/* A file that is THERE but could not be read or parsed (a trailing comma, a
 * byte-order mark) is not a first run. Kept, so nothing that writes on its own
 * at start (the level, server/welcome/level.js) mistakes it for one. */
let settingsUnreadable = null;
try { saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")) || {}; }
catch (err) { if (err?.code !== "ENOENT") settingsUnreadable = err?.message || String(err); }

// The optional native music entry point never needs a ComfyUI/Python rig.
const MUSIC_ONLY = process.env.AIPLAY_MUSIC_ONLY !== undefined
  ? process.env.AIPLAY_MUSIC_ONLY === "1" : saved.musicOnly === true;
/* The Comfy API entry point (launcher: "Use Comfy API"): models run on Comfy's
 * cloud through Comfy Router with the user's own key and credits, so nothing
 * local is needed, not ComfyUI and not a card. Only the launcher turns it on,
 * so full Studio never shows a page that spends credits. */
const CLOUD_ONLY = !MUSIC_ONLY && process.env.AIPLAY_CLOUD_ONLY === "1";
/* The RunPod entry point (launcher: "RunPod GPU"; scripts/start-remote.mjs):
 * Images and Video render on the person's own RunPod Pod through the AIPLAY
 * worker (server/engine/remote-*.js), so no local ComfyUI starts. RunPod bills
 * by the hour, so like the Comfy API mode only the launcher turns it on and
 * full Studio never shows it (/api/runpod answers in this mode only). */
const REMOTE_ONLY = !MUSIC_ONLY && !CLOUD_ONLY && process.env.AIPLAY_REMOTE_ONLY === "1";
const RIG = process.env.AIPLAY_RIG || saved.rig
  || (MUSIC_ONLY ? path.join(APPDATA, "rig") : "D:\\AI\\aiplay-studio-bench");
/* Where model weights live. A ComfyUI Desktop install keeps them outside the
 * rig (its extra_model_paths default), so this can be PINNED, by env or by
 * settings. Unpinned, it is the rig's own models folder — and `config.modelsDir`
 * below re-derives that from `config.rig` at access time rather than freezing
 * it here, so whatever points the rig elsewhere (fit_test.js does, at an empty
 * folder, to reproduce a fresh install) moves the weights folder with it.
 * Frozen, videoReady() kept finding this machine's real H3 weights under a rig
 * the test had emptied, and that lane passed only on machines without them. */
const MODELS_DIR_PINNED = process.env.AIPLAY_MODELS_DIR || saved.modelsDir || null;
const MODELS_DIR = MODELS_DIR_PINNED || path.join(RIG, "ComfyUI", "models");
/* The extra models folders (settings `modelsAlso`): one left behind by "Use this
 * folder", or one added with "Add as extra". The engine loads from all of them
 * (localmodels.js writes them into its YAML), so a file in any of them is on disk. */
const MODELS_ALSO = Array.isArray(saved.modelsAlso) ? saved.modelsAlso.filter((d) => typeof d === "string" && d.trim()) : [];

/**
 * First of these filenames that is actually on disk, else the last one.
 *
 * Needed because the weights this rig MEASURED and the weights a new install can
 * DOWNLOAD are not the same files — the pure-int4 H3 DiT was pulled from its
 * repo and the two H3 VAEs were cast locally, so `models.js` offers the nearest
 * published equivalents instead. Hard-coding either set breaks the other
 * machine, and silently falling back to a name that does not exist produces a
 * ComfyUI node error at render time rather than "download this first".
 *
 * Order is preference: measured build first, downloadable substitute last.
 */
const pick = (sub, ...names) => names.find((n) => onDisk(sub, n)) ?? names[names.length - 1];

/* "Is this file on disk, with bytes in it", asked one way for pick() and for
 * the H3 step defaults below `config`, so the two cannot disagree about it.
 * Every folder the engine loads from counts: the models folder and the extra
 * ones (config.modelsAlso). A declaration, so pick() above can use it. */
function onDisk(sub, name) {
  const bases = [MODELS_DIR, ...MODELS_ALSO];
  return bases.some((b) => { try { return fs.statSync(path.join(b, sub, String(name))).size > 0; } catch { return false; } });
}

/* THE H3 SPEED-UP SLOTS and their candidate lists, kept so a speed-up that
 * lands (a Models download) is picked again without a restart
 * (refreshH3Speedups below). loraSlot() is pick() on the loras folder that
 * also remembers the list. */
const H3_LORA_SLOTS = {};
const loraSlot = (slot, ...names) => { H3_LORA_SLOTS[slot] = names; return pick("loras", ...names); };

/* The TaoMate 3-step files, in pick order (the full conversion, then Kijai's
 * 182 MB rank-19 average). OPTIONAL: nothing asks for them at start. They are
 * read at import like every other file, again when a download finishes
 * (refreshTaoMate below), and a render asking for 3 steps without one is
 * refused with the download offered (video-plain.js videoPlan). */
export const TAOMATE_FILES = [
  "taomate_h3_3step_comfy.safetensors",
  "minimax_h3_taomate_3step_lora_avg_rank_19_bf16.safetensors",
];

/** The step count a turbo LoRA was distilled for, read off its file name
 *  (`_8step_`), or null for a name that does not say. One reader for the H3
 *  step defaults below, /api/status and mv/plancost.js loraSteps(). */
export const loraStepsOf = (name) => {
  const m = /(\d+)step/i.exec(String(name ?? ""));
  return m ? Number(m[1]) : null;
};

/* The card first-run setup saved. Same test as index.js onAmd() and
 * models.js cardIsAmd(): ROCm has no kernel for NVIDIA's fp4 formats. */
const AMD_CARD = saved.torchBackend === "rocm" || saved.gpu?.vendor === "amd";
/* A LIGHT MACHINE for H3: an AMD or Intel card, a card under 16 GB, or under
 * 32 GB of RAM. It downloads and loads H3's lighter builds: the w4a8 DiT and
 * the int8 video VAE (models.js `light` entries; the int4 text encoder is
 * everyone's). MEASURED 2026-09-25 on an RX 9060 XT 16 GB, TaoMate 3-step
 * 1344x768 5 s, same seed, each on a fresh engine: int8 DiT + int8 TE + fp16
 * VAE 357 s; int8 VAE 316 s (frames PSNR 35.8 dB, SSIM 0.975 against fp16);
 * int4 TE 299 s (13.5 GB staged against 25.9); w4a8 DiT 293 s; all three
 * 290 s, every one as good to the eye. 30 GB to fetch instead of 41. */
export function isLightH3({ gpu, torchBackend } = {}, ramBytes = os.totalmem()) {
  return torchBackend === "rocm" || gpu?.vendor === "amd" || gpu?.vendor === "intel" || torchBackend === "xpu"
    || (Number(gpu?.totalMb) > 0 && Number(gpu.totalMb) < 15000)
    || ramBytes < 30 * 2 ** 30;
}
const LIGHT_H3 = isLightH3(saved);
/** Video starts at 720p on any card but NVIDIA (the H3 block below): an AMD
 *  or Intel card, or the CPU. A machine whose card was never recorded keeps
 *  the trained size. */
export function prefers720p({ gpu, torchBackend } = {}) {
  return ["rocm", "xpu", "cpu"].includes(torchBackend) || gpu?.vendor === "amd" || gpu?.vendor === "intel";
}
const PREFER_720P = prefers720p(saved);

/** Find a python inside a ComfyUI rig, trying every layout in the wild.
 *
 * Order matters only in that it must be deterministic; the layouts are mutually
 * exclusive in practice. Falls back to the venv path rather than to null so the
 * error a user sees is "this file is missing", which is actionable, instead of
 * "cannot spawn undefined", which is not. */
function detectPython(rig) {
  const candidates = [
    ["venv", "Scripts", "python.exe"],   // from source, Windows
    ["python_embeded", "python.exe"],    // the portable Windows build
    [".venv", "Scripts", "python.exe"],  // uv / poetry habits
    ["venv", "bin", "python"],           // from source, Linux and macOS
  ];
  for (const rel of candidates) {
    const full = path.join(rig, ...rel);
    try { if (fs.existsSync(full)) return full; } catch { /* keep looking */ }
  }
  return path.join(rig, "venv", "Scripts", "python.exe");
}

/**
 * The whisper venv's interpreter when nothing names another.
 *
 * `Scripts\python.exe` is the Windows venv layout ONLY. Everywhere else a venv
 * keeps it in `bin/python`, and a Windows path handed to a Linux spawn is an
 * ENOENT whose message tells people to create a folder their system cannot
 * have. Platform and home are parameters so lrc_test.js pins the Linux answer
 * on a Windows machine.
 */
export function defaultWhisperPython(platform = process.platform, home = os.homedir()) {
  const p = platform === "win32" ? path.win32 : path.posix;
  return p.join(home, "aiplay-whisper", "venv", ...(platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
}

/**
 * The interpreter timed lyrics runs: AIPLAY_WHISPER_PYTHON, else the one chosen
 * in Settings (prefs.lyrics.whisperPython), else the default venv.
 *
 * WHY A SETTING AT ALL. Until now the environment variable was the only way to
 * name another python, and an environment variable reaches the server only
 * through the launcher that starts it: "setx …, then restart Studio" changed
 * nothing while the launcher kept running. A saved choice needs no restart,
 * because art.js reads config.lyrics.python at every spawn. The environment
 * still wins, as it does for every other path in this file, so a launcher that
 * sets it on purpose is never overridden by a stale field; Settings says so.
 */
export function whisperPython(choice = config.lyrics?.whisperPython) {
  return process.env.AIPLAY_WHISPER_PYTHON || choice || defaultWhisperPython();
}

/**
 * The stem separation python when nothing names another: python.org's per-user
 * 3.10 folder. The literal this file has carried since the first public commit;
 * it is only the last resort now.
 */
export function defaultSystemPython(home = os.homedir()) {
  return path.join(home, "AppData", "Local", "Programs", "Python", "Python310", "python.exe");
}

/**
 * The interpreter stem separation (demucs) and the audio-reference encoder
 * (scripts/dav_encode.py) run: AIPLAY_SYS_PYTHON, else the one chosen in
 * Settings > Songs > "stem separation python" (prefs.stems.systemPython, or the
 * "stems" setup when it finishes), else the Python310 default.
 *
 * WHY A SETTING AT ALL (Tika's report, 2026-09-24). The default was the only
 * way in besides an environment variable, so the Models row's remedy
 * ("python -m pip install demucs") installed into whatever `python` was on
 * PATH, never the interpreter Studio runs. Same rule as whisperPython() above:
 * the environment wins, a saved choice needs no restart because art.js reads
 * config.systemPython at every spawn, and Settings says when the environment
 * is overriding the field.
 */
export function systemPython(choice = config.stems?.systemPython) {
  return process.env.AIPLAY_SYS_PYTHON || choice || defaultSystemPython();
}

/** Where systemPython() got its answer: "env" (AIPLAY_SYS_PYTHON), "saved" (a
 *  choice in Settings or the stems setup) or "default" (Python310). */
export function systemPythonSource(choice = config.stems?.systemPython) {
  if (process.env.AIPLAY_SYS_PYTHON) return "env";
  return choice ? "saved" : "default";
}

/**
 * Where the attachment weight-transfer script lives, and why it is not in
 * server/mesh/. It does `import bpy`, which by the Blender Foundation's stated
 * position makes it a derivative work of Blender, and this tree is Apache-2.0
 * and public — the boundary `config.blender` below describes and
 * server/licence_test.js checks. So it sits outside the tree, as
 * server/mesh/deform.js's deformScriptPath() does for deform.py, and
 * server/mesh/avatar-weight-transfer.js spawns it and reads JSON off stdout.
 * Resolved per call, so a changed environment is read without a restart.
 */
export function weightTransferScriptPath() {
  return outsideTreeScript("AIPLAY_WEIGHT_TRANSFER_SCRIPT", "weight_transfer.py");
}

/**
 * The attachment fitter, attachment_fit.py, does `import weight_transfer` and
 * takes bpy's own types back from it, so it is Blender-derived the same way and
 * stays out of this tree with it (server/licence_test.js). Its suite also loads
 * weight_transfer_test.py from its own folder, so the three belong together:
 * unset, the fitter is looked for beside whichever weight_transfer.py
 * weightTransferScriptPath() found, not by a second search.
 */
export function attachmentFitScriptPath() {
  return process.env.AIPLAY_ATTACHMENT_FIT_SCRIPT
    || path.join(path.dirname(weightTransferScriptPath()), "attachment_fit.py");
}

/**
 * The lookup the out-of-tree bpy scripts share. The variable wins when set.
 * Unset, two places are tried, in order: beside the toolkit's cli.py
 * (config.blender.previz), where deform.py's default also points and where
 * the GPL toolkit repository keeps these scripts (previz/; the URL, and
 * whether it is public yet, are in server/mesh/previz-toolkit.js), and
 * <rig>/blender-toolkit/, a local folder
 * for a copy outside any clone. The first that holds the
 * file wins. With neither, the toolkit path comes back, so the sentence the
 * caller prints names where the script is expected, never a folder in here.
 */
function outsideTreeScript(variable, file) {
  if (process.env[variable]) return process.env[variable];
  const candidates = [
    path.join(path.dirname(config.blender.previz), file),
    path.join(config.rig, "blender-toolkit", file),
  ];
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* try the next */ }
  }
  return candidates[0];
}

export const config = {
  rig: RIG,
  dataDir: APPDATA,
  musicOnly: MUSIC_ONLY,
  cloudOnly: CLOUD_ONLY,
  remoteOnly: REMOTE_ONLY,
  comfyAutoStart: !MUSIC_ONLY && !CLOUD_ONLY && !REMOTE_ONLY,
  // Optional external-audio RVQ preprocessing. Explicit opt-in; never download
  // or execute a research workspace just because one exists on this machine.
  musicInput: {
    enabled: process.env.AIPLAY_MUSIC_INPUT === "1" || saved.musicInput?.enabled === true,
    runtimeFile: process.env.AIPLAY_MUSIC_INPUT_RUNTIME || saved.musicInput?.runtimeFile
      || path.join(RIG, "music-input", "runtime.json"),
  },
  /* Graphics-memory tier, remembered across restarts. "auto" detects. */
  tier: "auto",
  comfyDir: path.join(RIG, "ComfyUI"),
  get modelsDir() { return MODELS_DIR_PINNED || path.join(this.rig, "ComfyUI", "models"); },
  /* Folders the models folder USED to be. Choosing a new folder on the Models
   * screen (a bigger drive, say) sends new downloads there; the weights already
   * downloaded stay where they are, so the old folder is remembered here and
   * still searched, by Studio for "is it installed" and by the engine for
   * loading (server/localmodels.js writes it into the same YAML). */
  modelsAlso: MODELS_ALSO,
  /* The card first-run setup found ({vendor, name, totalMb, source}). Only a
   * fallback for machines where nvidia-smi cannot be read — see gpu.js. */
  gpu: saved.gpu && typeof saved.gpu === "object" ? saved.gpu : null,
  /* H3's lighter builds (LIGHT_H3 above): models.js downloads them, the picks
   * below load them first. */
  h3Light: LIGHT_H3,
  /* "cuda" | "rocm" | "cpu" — which torch build the engine's python carries. */
  torchBackend: typeof saved.torchBackend === "string" ? saved.torchBackend : null,
  /* Local files standing in for catalogue files, by basename:
   * { "<catalogue file>": "<local file in the same model folder>" }. Read by
   * models.js for presence and applied to every graph at the engine door.
   * Changed live from the Models screen; persisted as `modelOverrides`. */
  /** The chat's language model file (server/chat/models.js); null = automatic. */
  chatModel: typeof saved.chatModel === "string" && saved.chatModel ? saved.chatModel : null,
  /** Simple mode's own choice (the Music panel); null = the Chat tab's. */
  chatModelMusic: typeof saved.chatModelMusic === "string" && saved.chatModelMusic ? saved.chatModelMusic : null,
  /* The assistants run GPU work as soon as it is asked for, with a warning and
   * Cancel; true brings back the ask-first card (server/chat/loop.js). */
  chatConfirmGpu: saved.chatConfirmGpu === true,
  // The Enhance button's own model (server/prompt-tools.js); null borrows Simple mode's, then Chat's.
  enhanceModel: typeof saved.enhanceModel === "string" && saved.enhanceModel ? saved.enhanceModel : null,
  /** Cloud language models (server/llm/providers.js): the model picked per
   *  provider and the base URL of the custom OpenAI-compatible one. The keys
   *  are NOT here — they live in the secret store. */
  llm: {
    models: saved.llm?.models && typeof saved.llm.models === "object"
      ? Object.fromEntries(Object.entries(saved.llm.models).filter(([k, v]) => typeof k === "string" && typeof v === "string"))
      : {},
    /* { provider: "Claude Opus 5" } — the chosen model's display name, so the
     * menus read well before the provider's list has been fetched again. */
    names: saved.llm?.names && typeof saved.llm.names === "object"
      ? Object.fromEntries(Object.entries(saved.llm.names).filter(([k, v]) => typeof k === "string" && typeof v === "string"))
      : {},
    bases: saved.llm?.bases && typeof saved.llm.bases === "object"
      ? Object.fromEntries(Object.entries(saved.llm.bases).filter(([k, v]) => typeof k === "string" && typeof v === "string"))
      : {},
  },
  modelOverrides: saved.modelOverrides && typeof saved.modelOverrides === "object"
    ? Object.fromEntries(Object.entries(saved.modelOverrides).filter(([k, v]) => typeof k === "string" && typeof v === "string"))
    : {},
  /* The python that runs ComfyUI.
   *
   * Layout differs by install route and there is no way to guess from the rig
   * path alone: a from-source ComfyUI keeps it in `venv/`, and the PORTABLE
   * Windows build — the route INSTALL.md recommends — keeps it in
   * `python_embeded/`. This used to be hardcoded to the venv layout, so the
   * recommended route produced a wrong path and the docs carried a note telling
   * people to edit this very line. Detected once, at load, and whatever setup
   * saved wins over the guess. */
  python: process.env.AIPLAY_PYTHON || saved.python || detectPython(RIG),
  /* Where finished songs live. Settable, because "my music is on the D: drive"
   * is an ordinary thing to want and the alternative is editing a source file.
   *
   * ⚠ This is also ComfyUI's output directory — the engine is launched with
   * `--output-directory` pointing here, so the two can never drift apart. That
   * coupling is why changing it needs an engine restart rather than taking
   * effect on the next render. */
  outputDir: process.env.AIPLAY_OUTPUT || saved.outputDir
    /* Comfy API mode with no ComfyUI set up keeps its results in app data,
     * like music-only; with one, beside everything else Studio made. */
    || (MUSIC_ONLY || ((CLOUD_ONLY || REMOTE_ONLY) && !process.env.AIPLAY_RIG && !saved.rig)
      ? path.join(APPDATA, "output") : path.join(RIG, "ComfyUI", "output")),
  settingsFile: SETTINGS_FILE,
  // Where `LoadLatent` looks. Its `latent` input is a name RELATIVE to this, so
  // the encoder writes here and the graph refers to the basename only.
  // A folder chosen in the launcher's Advanced settings, else ComfyUI's own.
  inputDir: process.env.AIPLAY_INPUT || saved.inputDir || path.join(RIG, "ComfyUI", "input"),

  // ONE long-lived ComfyUI process. This is architectural, not a preference:
  // restarting per job discards the AR-stage cache, and with it the ~40% saving
  // that makes re-rolling a mix faster than realtime.
  comfy: {
    /**
     * ⚠ THERE IS NO `port` HERE ANY MORE, AND NO `host` EITHER.
     *
     * Until 2026-09-03 this key read `Number(process.env.AIPLAY_COMFY_PORT ||
     * 8266)`, and that default was the bug. It resolved to 8266 whether or not
     * anybody had asked for a pin, so nothing downstream could tell "the user
     * pinned this port" from "nobody said anything" — and 8266 became a
     * constant that fifteen scripts across two repos copied. On one night in
     * September 2026, 426 files were written to the output folder and 424 of
     * them had no ledger entry, because three harnesses posted straight at that
     * number. `server/engine/client.js` now picks an unpublished port at every
     * start, and it is the only file in the tree that knows what it is.
     *
     * `pinnedPort` is NULL unless somebody really set the variable. That is the
     * whole point of the shape: null means "let the app choose", a number means
     * "this install pinned it and knows what that costs" — which the client
     * says out loud in the log, in a `choice` event on `asset:"engine"`, and in
     * a strip across the top of the Engine panel. Honoured, never silently.
     *
     * `host` is gone because the thing that passes `--listen` and the thing
     * that builds `http://…` must agree BY CONSTRUCTION rather than because two
     * settings happen to match. Both are now `LISTEN_HOST` in the client.
     * `server/engine/ui_test.js` fails the commit if either name comes back
     * anywhere outside that module.
     */
    pinnedPort: process.env.AIPLAY_COMFY_PORT ? Number(process.env.AIPLAY_COMFY_PORT) : null,
    // The Auto tier: the VRAM mode from the card's memory (comfyargs.js autoVramFlags).
    flags: autoVramFlags(saved.gpu?.totalMb),
    /* Extra launch arguments appended after the tier flags — e.g. the ones a
     * ComfyUI Desktop install launches with (--use-ck-attention,
     * --extra-model-paths-config). From settings.json `comfyExtraArgs`. */
    extraArgs: Array.isArray(saved.comfyExtraArgs) ? saved.comfyExtraArgs.map(String) : [],
    /* The launcher's Advanced settings (server/comfyargs.js). `options` is a
     * map of option id → value; a choice replaces its family in the tier and
     * install flags. `useInstallFlags: false` launches without `extraArgs`. */
    options: saved.comfyOptions && typeof saved.comfyOptions === "object" ? saved.comfyOptions : {},
    // Which launcher wrote them: below comfyargs.js OPTIONS_REV, Studio's defaults apply over them.
    optionsRev: Number(saved.comfyOptionsRev) || 1,
    useInstallFlags: saved.comfyUseInstallFlags !== false,
    /* The AMD/Intel engine fix (PyTorch attention + CUDA graphs off): "auto"
     * lets the card decide, "on"/"off" force it. settings.json `comfyAmdFix`. */
    amdFix: ["auto", "on", "off"].includes(saved.comfyAmdFix) ? saved.comfyAmdFix : "auto",
    startupTimeoutMs: 180_000,
  },

  /**
   * Graphics-memory tiers.
   *
   * 🔑 The weights we ship are ALREADY the smallest that exist — int8 DiT (2.33 GB)
   * + pruned int8 text encoder (8.57 GB) + VAE (0.20 GB) = 11.1 GB. Every other
   * file in the repo is larger, so "switch to a smaller model" is not available:
   * the only way to fit a smaller card is to keep less of it resident and stream
   * the rest from system RAM.
   *
   * That is what these tiers do. Flags are read at process start, so changing tier
   * restarts the engine (and clears the AR cache — worth saying in the UI).
   *
   * ⚠ Measured on a 16 GB card plus `--reserve-vram` simulation. Nothing OOM'd even
   * at a 6 GB-equivalent budget, but the proxy is imperfect (peak still reported
   * ~13 GB) and the small tiers are UNPROVEN ON REAL HARDWARE. Do not publish a
   * minimum-VRAM claim from this; the community beta settles it.
   */
  /* Said beside every tier on the Music screen: the choice restarts the ONE
   * engine, whose flags every model shares, and it is not a video size. */
  vramTierScope: "Changing this restarts the engine for every model it runs, pictures and video (H3) "
    + "included, not only music. It does not choose a video size: the Video screen picks that from your card.",
  vramTiers: {
    auto:   { label: "Auto", flags: autoVramFlags(saved.gpu?.totalMb), note: "From your card: under 12 GB streams weights from system RAM (low VRAM); 12 GB and up runs normal mode, which keeps a model on the card while there is room and moves it off when the next one needs it. An unread card stays on low VRAM. H3's 12 GB result was measured in low-VRAM mode; normal mode on a 12 GB card is untested." },
    /* The same flags Auto gives 12 GB and up (comfyargs.js autoVramFlags), so
     * the same words: it was "Keeps the model resident", which is --highvram's
     * promise, not normal mode's. */
    high:   { label: "16 GB or more", flags: ["--async-offload", "4"], note: "Normal mode, the same as Auto on 12 GB and up: keeps a model on the card while there is room and moves it off when the next one needs it. Fastest." },
    mid:    { label: "12 GB", flags: ["--lowvram", "--async-offload", "4"], note: "Verified bit-identical to the fast path." },
    low:    { label: "8 GB", flags: ["--lowvram", "--async-offload", "2"], note: "More streaming from system RAM. Roughly 2× slower." },
    /* ⚠ `--novram` is INCOMPATIBLE with this model and must never come back.
     * It moves the execution device to CPU, and the AR stage requires CUDA:
     *   ValueError: Expected a cuda device, but got: cpu
     * Measured 2026-08-18 — the tier produced zero audio in 6 seconds. The
     * shipped config offered it as the 6 GB option, so anyone on a small card
     * would have hit a hard failure with no explanation.
     * Streaming harder while staying on the GPU is the only lever we have. */
    minimum:{ label: "6 GB", flags: ["--lowvram", "--async-offload", "1", "--reserve-vram", "1.0"], note: "Streams almost everything from system RAM. Much slower, and still unproven on real 6 GB hardware — tell us how it goes." },
  },

  uiPort: Number(process.env.AIPLAY_UI_PORT || 4173),

  /**
   * The SYSTEM python, for tools that are not the engine.
   *
   * ⚠ Deliberately not the ComfyUI venv. That venv is torch 2.13.0+cu130 and the
   * fused int8 kernels the music model needs exist only on that build; letting
   * pip resolve demucs' or ctranslate2's torch requirement inside it is how you
   * end up with a silently 5x slower app. Verified after installing demucs:
   * system python stayed at 2.5.1+cu121 and the venv at 2.13.0+cu130.
   *
   * A plain string, recomputed by systemPython() once the saved prefs are read
   * (below) and by whoever changes `stems.systemPython`. Everything that spawns
   * it reads this field at spawn time, so a change needs no restart.
   */
  systemPython: process.env.AIPLAY_SYS_PYTHON || defaultSystemPython(),

  /**
   * BLENDER, and the previz toolkit that drives it. Both OPTIONAL — every
   * capability that uses them degrades to a sentence saying so, never a crash.
   *
   * ⚠ THIS IS A LICENCE BOUNDARY, not a convenience. Anything that does
   * `import bpy` is, by the Blender Foundation's stated position, a derivative
   * work of Blender and must be GPL-compatible; this tree is Apache-2.0 and
   * public. So the toolkit is its own GPL-3.0-or-later repository, meant to
   * sit at vendor/previz-blender as a SUBMODULE, whose .py never enter this
   * Apache tree's commits (only a gitlink SHA and a URL would). This tree
   * carries no gitlink for it yet, so a clone there is just an untracked
   * folder, and server/licence_test.js reads the INDEX, vendor/ included, so
   * none of its .py can be staged unnoticed. The only thing that crosses
   * back at runtime is a .png and a .json on disk — data, which carries no
   * obligation. The interface is a subprocess and it must stay one. Nothing
   * here imports it, nothing here copies its .py in, and this app writes no
   * .py into it. See vendor/previz-blender/LICENSE-NOTE.md.
   *
   * `previz` points at the toolkit's own CLI. It is run as
   * `blender.exe -b --factory-startup -noaudio -P <previz> -- <args>` — one
   * process, no second interpreter — and answers on stdout after the marker
   * `PREVIZ_RESULT_JSON:`. Exit 2 means it REFUSED (a rule it enforces, with
   * the reason on stderr); 3 means the render itself failed.
   */
  blender: {
    exe: process.env.AIPLAY_BLENDER || saved.blenderExe
      || "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe",
    previz: process.env.AIPLAY_PREVIZ || saved.previz
      || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor", "previz-blender", "previz", "cli.py"),
  },

  /**
   * ⚠ THE THIRD AND FOURTH PYTHONS, AND NEITHER IS A PREFERENCE.
   *
   * This app already talks to two interpreters and knows why: the ENGINE's venv
   * (torch 2.13.0+cu130, whose fused int8 kernels the music model needs) and
   * `systemPython` above (torch 2.5.1+cu121, where demucs and ctranslate2 live).
   * `server/mesh/` needs a THIRD, and the reason is a hard version collision
   * rather than tidiness: TripoSG is a diffusers pipeline that wants a modern
   * diffusers, and the interpreter this app's engine runs on is pinned at
   * diffusers 0.7.0.dev0. `pip install diffusers` into a running engine's
   * environment does not fail — it succeeds, and the next song render fails,
   * hours later, in a place that says nothing about a mesh.
   *
   * So: its OWN venv, spawned as a subprocess, never imported. Nothing in this
   * tree may add a package to either of the other two on its behalf. And then a
   * FOURTH, `unirigPython` below, for the same reason one step further out: the
   * rig needs a different Python VERSION, not merely different packages. All of
   * these paths are OPTIONAL — every capability that uses them degrades to a
   * sentence saying which file is missing, exactly as `blender` above does.
   *
   * Licence note, for contrast with the block above: this one is NOT a licence
   * boundary. TripoSG and UniRig are MIT for code AND weights, which is why they
   * were chosen, so `server/mesh/mesh_cli.py` is an ordinary file in this
   * Apache-2.0 tree. The subprocess here is about python versions and nothing
   * else. (Hunyuan3D would have been a licence boundary AND a territory one —
   * its terms exclude the European Union — which is why it is not installed, not
   * depended on, and not in the catalogue.)
   */
  mesh: {
    /* ⚠ THESE FOUR PATHS ARE MEASURED, not chosen. They were invented here
     * (`mesh3d/venv`, `mesh3d/TripoSG`, `mesh-models`) while a parallel
     * strand was building the environment, and the strand put it somewhere
     * else. None of the four existed on this machine, so meshStatus() reported
     * four missing files and the capability was unreachable through its own
     * route — the defect a default is supposed to prevent. They now name what
     * is actually on the disk; all four stay overridable. */
    python: process.env.AIPLAY_MESH_PYTHON || saved.meshPython
      || path.join(RIG, "venv3d", "Scripts", "python.exe"),
    /* A FOURTH interpreter, and unlike the three above it is a Python VERSION
     * boundary rather than only a package one. UniRig documents Python 3.11 and
     * means it: `bpy==4.2` publishes a cp311 wheel and no cp310 one, so on this
     * machine's 3.10.6 the rig could not be assembled at all — no amount of pip
     * would have produced it. `venv311` is Python 3.11.9 (installed per-user
     * from python.org, leaving the 3.10 that `python`/`systemPython` use alone)
     * with torch 2.5.1+cu121, bpy 4.2.0, spconv-cu121, torch_scatter/_cluster
     * built for pt25cu121, transformers 4.51.3 and numpy 1.26.4 — upstream's
     * pins, which collide head-on with what venv3d holds for TripoSG
     * (transformers 5.16.1, numpy 1.22.3). That collision is the whole reason
     * this key is separate.
     *
     * The default used to fall through to `python` above — TripoSG's 3.10
     * interpreter, which cannot run UniRig — so out of the box probe() refused
     * on the Python version. It now names venv311. Both overrides survive:
     * AIPLAY_UNIRIG_PYTHON, then a saved setting. The fall-through to
     * meshPython is deliberately gone; borrowing TripoSG's interpreter was
     * never a working configuration, only a plausible-looking one.
     *
     * Still OPTIONAL, and still honest when absent: probe() reports the exact
     * missing modules rather than half-importing anything. One prerequisite is
     * knowingly unmet on this machine — flash_attn, which upstream imports at
     * module scope in src/model/unirig_skin.py and which publishes no Windows
     * wheel from either PyPI or its own GitHub releases. See
     * D:\AI\aiplay-studio-bench\venv311-INSTALL-RECORD.md. */
    unirigPython: process.env.AIPLAY_UNIRIG_PYTHON || saved.unirigPython
      || path.join(RIG, "venv311", "Scripts", "python.exe"),
    triposg: process.env.AIPLAY_TRIPOSG || saved.triposg || path.join(RIG, "repos3d", "TripoSG"),
    unirig: process.env.AIPLAY_UNIRIG || saved.unirig || path.join(RIG, "repos3d", "UniRig"),
    /* Where MESH() in server/models.js puts the weights. Stated in both places
     * and checked against each other by server/mesh/catalogue_test.js — the
     * downloader writing to one folder while the runner reads another is a
     * capability that reports ready and then cannot find its own model. */
    weights: process.env.AIPLAY_MESH_WEIGHTS || path.join(RIG, "models", "3d"),
  },

  /**
   * YuE2 — the SECOND music engine, and the SIXTH interpreter on this machine.
   *
   * ⚠ Its own venv, and the reason is a torch build rather than tidiness.
   * venv-yue is python 3.10.6 with torch 2.10.0+cu130, transformers 4.57.6,
   * numpy 2.2.6 and yue2_infer 0.1.6 (MEASURED off the venv 2026-09-11). The
   * engine's interpreter is pinned at torch 2.13.0+cu130 because MiniMax's fused
   * int8 kernels exist only on that build. `pip install yue2-infer` into the
   * engine's python does not fail; it succeeds, it moves torch, and the next
   * song render dies hours later inside a kernel in a place that says nothing
   * about YuE2. Same argument as `mesh` above, one engine along. Six of YuE2's
   * eight pins collide with the engine's, two across a major version.
   *
   * The two model paths are here only so they are overridable in ONE place;
   * their defaults are identical to models.js's YUE() helper, which is where the
   * downloader writes. server/music/yue_test.js fails if they ever diverge — a
   * downloader writing to one folder while the runner reads another is a
   * capability that reports ready and then cannot find its own model.
   *
   * 🔴 MEASURED ON THIS CARD, and the operating rules that came out of it:
   *   167.0 s of 48 kHz 24-bit audio in 399.6 s from a SUPPLIED score, peak
   *   ~10.5 GiB. 163.9 s in 473.5 s on a first pass with offloadAr on.
   *   The ceiling is 13.99 GiB and it CANNOT be raised: the pipeline computes
   *   min((budget-2)*GiB, total-2*GiB), so 2 GiB is reserved whatever you pass,
   *   and a 12 GiB card therefore gets a 10 GiB cap that does NOT fit.
   *   FIVE OOMs traced to one cause: a one-step render lets the model choose
   *   its own length and then allocates for it. Both halves fit separately —
   *   planning alone peaked ~8.9 GiB — so `twoStep` splits it, and the second
   *   half costs ZERO score tokens because the score is then supplied.
   *   Each render needs a FRESH PROCESS: a held pipeline OOM'd on the same
   *   score and seed that finished in a clean one, because fragmentation
   *   belongs to the CUDA context and outlives empty_cache().
   */
  /**
   * WHICH MUSIC ENGINE RENDERS A SONG.
   *
   * Music had no engine concept until now — MiniMax's settings were flat
   * siblings (`models`, `sampling`, `speed`), which is fine for one engine and
   * wrong for two. The shape here follows `video.engines` below, and the same
   * rule applies: every engine-specific value lives under `engines`, and
   * nothing sits beside it except the switch a user thinks of as "which model".
   *
   * ⚠ `runtime` is the axis video does not need and music does. The two engines
   * do not merely differ in weights, they run in DIFFERENT PROCESSES:
   *   "comfy"  — the long-lived ComfyUI engine. Keeps a warm AR cache, which is
   *              worth a great deal: MEASURED 258 s -> 0.3 s on an identical
   *              re-run, 246 s -> 130 s on a settings-only change.
   *   "python" — a subprocess on its own interpreter (`config.yue`), a fresh one
   *              per render. No warm cache, so a re-roll costs full price.
   * A third, "audiocpp", is where the published GGUF builds would go: a native
   * binary, which the arithmetic says is ~8.9x this machine's Python path at
   * BF16 (RTF 0.27 against a MEASURED 2.39) with nothing quantised, and ~8.3 GiB
   * instead of 12.5 at Q8_0 — so quantisation there buys HARDWARE REACH rather
   * than speed. It is deliberately NOT listed as an engine yet: nothing has been
   * built, installed or heard on this machine, and an engine that appears in a
   * dropdown and cannot render is the exact defect `mesh`'s comment above was
   * written about. It becomes a data change here, not an architecture change,
   * once it has been measured.
   *
   * Adding an engine needs BOTH a row here and a MODEL_TO_CAPABILITY line in
   * models.js — see the warning on PREF_PATHS. One without the other stamps
   * every render `unknown` and looks perfectly healthy.
   */
  music: {
    /* The key is the name the CATALOGUE already uses, not a shorter one I
     * preferred: provenance_test.js resolves every engine name through
     * MODEL_TO_CAPABILITY, and "minimax" does not resolve while
     * "minimax-music3" does. It caught this within a minute of the map landing,
     * which is the guard doing its job. */
    engine: "minimax-music3",
    /* Which MiniMax DiT build a song renders with when the request does not say:
     * "int8" | "fp16" | "fp32". Chosen with the music model picker (Models
     * screen, Music tab) and remembered through PREF_PATHS. */
    precision: "int8",
    /* The checkpoint the ComfyUI YuE2 engine loads (a file name in
     * models/checkpoints), chosen with the same picker. */
    yue2Checkpoint: null,
    /* A LoRA for that engine — a file name in a loras folder, or null — and
     * its strength. buildYue2ComfyGraph splices it as LoraLoaderModelOnly
     * between the checkpoint and the sampler, which patches the NAR, the half
     * ComfyUI exposes as MODEL; the AR arrives as CLIP and has no LoRA path
     * there. Chosen under the Music tab's Melody & score; a request may
     * name its own (`lora`, `loraStrength` on /api/generate). */
    yue2Lora: null,
    yue2LoraStrength: 1,
    /* The planner's LoRA — the AR half, which ComfyUI holds as CLIP — through
     * LoraLoader on the clip wire (buildYue2ComfyGraph). The instrumental
     * planner LoRA from the catalogue is the reason the door exists; a
     * request may name its own (`loraClip`, `loraClipStrength`). */
    yue2LoraClip: null,
    yue2LoraClipStrength: 1,
    /* ACE-Step 1.5: the DiT file (models/diffusion_models), the planner LM
     * (qwen_4b_ace15 or qwen_1.7b_ace15 in text_encoders; null = the biggest
     * one on a shelf), and a LoRA with its strength. Chosen on the Music tab. */
    aceModel: null,
    aceLm: null,
    aceLora: null,
    aceLoraStrength: 1,
    engines: {
      "minimax-music3": {
        label: "MiniMax Music 3",
        runtime: "comfy",
        capability: "engine",          // the models.js row that carries its rights
        /* What this engine can do that the other cannot. */
        audioReference: true,          // config.audioRef, the DAV encoder
        sectionTags: true,             // [Verse] etc. are its caption grammar
        instrumentalToggle: true,
        score: false,                  // no editable intermediate; a seed and a WAV
        warmCache: true,
        realtimeRatio: 1.53,           // MEASURED: 135 s of audio in ~207 s
        /* ⚠ CAN THE CREATE BUTTON ACTUALLY USE THIS ENGINE. Not a capability of
         * the model — a fact about how far the wiring has got, and it is here
         * because the alternative is a chooser that promises a render it cannot
         * perform. See the note on `renderPath` in the yue2 entry below. */
        renderPath: true,
      },
      yue2: {
        label: "YuE2 3B",
        runtime: "python",
        capability: "musicYue2",
        /* ⚠ NO audio reference of any kind. The vendor states it plainly:
         * "YuE2 exposes no audio-reference, phoneme-alignment, or
         * local-inpainting argument." Offering the field would be offering
         * something that cannot work. */
        audioReference: false,
        /* [Verse] / [Chorus] / [Bridge] are YuE2's own lyric format. */
        sectionTags: true,
        /* No flag on the model — an instrumental is a phrasing: empty lyrics
         * and a style that says "instrumental, no vocals". The toggle exists
         * so "pick instrumental, write a style, press Create" works here the
         * way it does on MiniMax; /api/generate writes the phrasing, and the
         * door is told to accept the empty lyrics it would otherwise refuse.
         * ⚠ UNMEASURED until the first instrumental render lands — whether
         * the model actually keeps quiet is its call, not this flag's. */
        instrumentalToggle: true,
        score: true,                   // an editable ABC lead sheet, before the audio
        warmCache: false,              // fresh process per render, by necessity
        /* MEASURED on this card: 167.0 s of audio in 399.6 s from a supplied
         * score; 163.9 s in 473.5 s on a first pass with the AR offloaded.
         * Quoted as a ratio the queue can use, and it is a MEASUREMENT of two
         * songs rather than a fitted curve — do not extrapolate it. */
        realtimeRatio: 2.39,
        /* Length is NOT a parameter here. It emerges from the lyrics and the
         * score: the same lyric gave 86 s on MiniMax and 164 s on YuE2. The UI
         * must not offer a duration control for this engine. */
        emergentLength: true,
        cot: ["full", "melody", "off"],
        /* 🟢 TRUE SINCE 2026-09-11, AND WHAT IT TOOK IS RECORDED HERE, because
         * the previous version of this comment said 🔴 FALSE for a reason that
         * was right: /api/generate enqueued into the ComfyUI job runner, which
         * knew one engine, so pressing Create with this selected would have
         * rendered MiniMax and stamped the ledger with the wrong model — and
         * the rights class of these two DIFFER (CC BY-NC against the engine's
         * own terms), so that would have been a false licence stamp, not a
         * cosmetic mismatch.
         *
         * What changed: server/jobs.js learned a second kind of work. A job
         * with `engine: "yue2"` waits for ComfyUI's queue to drain, asks it to
         * release its models (the two runtimes have separate ceilings and
         * cannot share the card — see the note on vramFloorGib in yue.js),
         * runs server/music/yue.js `renderSong()` with the rung the ladder
         * chose, maps the driver's progress onto the queue's stages, and copies
         * the receipted audio into the library under the library's own prefix.
         * index.js files it with model "YuE2 3B", adopts the run into the
         * score store (the version the ♪ badge links to) and writes the
         * provenance rows under the right model name. The one thing this door
         * still refuses is a preview: YuE2 has no cheap pass to offer.
         *
         * `false` is still honoured everywhere it used to be: an engine whose
         * wiring is not finished says so here and the button disables. */
        renderPath: true,
        /* The duration ladder applies to this engine and no other, because the
         * rungs in server/music/yue_fit.js are YuE2's own pipeline arguments.
         * Flagged rather than inferred from `emergentLength` so a future engine
         * with emergent length does not silently inherit YuE2's levers. */
        durationLadder: true,
      },
      /* YuE2 3B through ComfyUI's OWN nodes (comfy_extras/nodes_yue2.py) and a
       * single checkpoint in models/checkpoints — the route ComfyUI's "Text to
       * Music (YuE2)" template takes, and the one a ComfyUI Desktop install
       * already has. No Python kit, no second runtime: the job runs through the
       * engine door like MiniMax does. Same weights as `yue2`, so the same
       * rights row (models.js: the authors' statement of 15 Sep 2026; the
       * licence file still reads CC BY-NC 4.0). */
      "yue2-comfy": {
        label: "YuE2 3B (ComfyUI)",
        runtime: "comfy",
        // The ComfyUI checkpoint's own row (bf16 counts through `alt`), not the Python kit's.
        capability: "musicYue2Comfy",
        audioReference: false,
        /* ComfyUI's own template writes [Verse] / [Chorus] into the lyrics. */
        sectionTags: true,
        instrumentalToggle: true,
        score: false,                  // the ABC plan is made inside the graph, not kept
        warmCache: true,               // a re-roll changes only the sampler seed
        realtimeRatio: null,           // not measured on this engine yet
        emergentLength: true,          // max_duration is a ceiling; the model stops earlier
        /* The length slider's ceiling for this engine, in seconds (default 300).
         * YuE2GenerateMusic accepts up to 900; 360 is its own default. */
        maxDuration: 360,
        cot: ["full", "melody", "off"],
        renderPath: true,
      },
      /* ACE-Step 1.5 through ComfyUI's OWN nodes (comfy_extras/nodes_ace.py):
       * the graph of ComfyUI's "ACE-Step 1.5" templates (split 4B), with the
       * turbo DiT, the ACE 1.5 VAE and two Qwen text encoders — the 0.6B
       * embedder and a planner LM that writes "audio codes" before the DiT
       * renders. MIT, commercial use allowed by its authors. Duration is a
       * setting here, not an outcome: the latent is made exactly that long. */
      "ace-step15": {
        label: "ACE-Step 1.5 (ComfyUI)",
        runtime: "comfy",
        capability: "musicAceStep15",
        audioReference: false,         // MiniMax's DAV reference; ACE has its own cover input
        sectionTags: true,             // [Verse] / [Chorus] on their own lines, per its docs
        instrumentalToggle: true,      // lyrics "[Instrumental]", as ACE-Step documents
        score: false,
        warmCache: true,               // a re-roll changes only the sampler seed
        realtimeRatio: null,           // not measured here
        emergentLength: false,
        /* ACE-Step documents 10 s to 10 minutes. */
        maxDuration: 600,
        renderPath: true,
        ace: true,                     // its own options panel on the Music tab
        loras: true,
        cover: true,                   // ComfyUI's "Set Reference Audio" (experimental there)
      },
    },
  },

  yueGguf: {
    // Discoverable before installation. Only an explicit environment disable
    // removes permission to execute; availability is checked separately.
    enabled: process.env.AIPLAY_YUE_GGUF_ENABLED !== "0",
    cli: process.env.AIPLAY_AUDIOCPP_CLI || saved.audioCppCli
      || path.join(APPDATA, "yue2-gguf", "runtime", "audiocpp_cli.exe"),
    modelDir: process.env.AIPLAY_YUE_GGUF_MODEL_DIR || saved.yueGgufModelDir
      || path.join(APPDATA, "yue2-gguf", "models"),
    threads: Number(process.env.AIPLAY_YUE_GGUF_THREADS || saved.yueGgufThreads || 8),
    // "auto" reads the backends the runtime was built with and picks the best
    // one for this card (music/yue-gguf.js pickBackend). cuda|hip|vulkan|cpu forces one.
    backend: process.env.AIPLAY_YUE_GGUF_BACKEND || saved.yueGgufBackend || "auto",
    // Which official runtime the setup panel installs: "auto" follows the card
    // (NVIDIA -> cuda, anything else -> vulkan, no GPU -> cpu).
    runtime: process.env.AIPLAY_YUE_GGUF_RUNTIME || saved.yueGgufRuntime || "auto",
  },
  yue: {
    python: process.env.AIPLAY_YUE_PYTHON || saved.yuePython
      || path.join(RIG, "venv-yue", "Scripts", "python.exe"),
    model: process.env.AIPLAY_YUE_MODEL || saved.yueModel
      || path.join(RIG, "yue2-kit", "models", "YuE2-3B"),
    vae: process.env.AIPLAY_YUE_VAE || saved.yueVae
      || path.join(RIG, "yue2-kit", "models", "YuE2-Vae"),

    /* Plan the score, then render from it. NOT an optimisation — it is the only
     * shape that reliably fits 16 GiB, for the reason in the block comment. On
     * a 24 GiB card one step is fine and this can be turned off. */
    twoStep: true,
    /* Moves the AR weights off-GPU during the synthesis SOLVE.
     *
     * 🔴 TWO CORRECTIONS TO WHAT THIS COMMENT USED TO SAY, both found by reading
     * the code rather than by a new measurement.
     *
     * FIRST, IT WAS READ BY NOTHING. This key has been `true` since the engine
     * landed and no code consumed it: `renderSong()` did not take the option,
     * yue_driver.py had no argument for it, and pipeline.py:124 defaults
     * `offload_ar=False`. So every song rendered before 2026-09-11 ran with the
     * flag OFF while this file said otherwise. Now wired: yue.js reads it as
     * the default for `renderSong({ offloadAr })`, which forwards --offload-ar.
     * A setting nothing consumes is worse than a missing one, because it is
     * believed — including by whoever wrote the sentence below it.
     *
     * SECOND, THE SPEED FIGURE WAS NOT MEASURING THIS. It said "2.89x realtime
     * with it against 2.39x without". Given the above, the 2.89x run had the
     * flag off, and its own note at config.js:306 calls it "a first pass" — so
     * it measured a cold start, not a lever. The cost of this flag is UNMEASURED
     * and the ladder in server/music/yue_fit.js records it as null rather than
     * carrying the old number forward.
     *
     * ⚠ AND IT DOES NOT RAISE THE DURATION CEILING, which is the reason it is
     * kept at `true` as a stability setting and not offered as a way to get a
     * longer song. nar.py:249 constructs CachedNAR — whose __init__ ends in
     * _prefill() at nar.py:127, allocating the whole length-dependent K/V cache
     * with all 6.7627 GiB of weights resident — BEFORE nar.py:251 enters the
     * offload context. The stage's peak is already set by then. What the flag
     * buys is 4.0344 GiB of headroom across the 64 velocity evaluations that
     * follow, which is most of the wall clock. */
    offloadAr: true,

    /* Experimental FP8 for the AR linears only. OFF, and the default matters:
     * quantization.py's own docstring says "No quantized quality or speed claim
     * is implied by enabling this module" and quantization_status() reports
     * "quality_validation": "unvalidated". Nobody has listened to a comparison.
     *
     * It saves a MEASURED 1.3125 GiB in the planning and semantic stages (the
     * 196 tensors matching quantization.py's AR_LINEAR regex weigh 2.6250 GiB
     * at BF16; E4M3 is one byte where BF16 is two) and needs compute capability
     * 8.9 or newer — an RTX 40-series floor. It is for a card that cannot hold
     * the semantic stage, not for a longer song — AND NOT FOR SPEED. MEASURED
     * 2026-09-11, same song, seed and lyrics on an RTX 4070 Ti SUPER through
     * the Create button: bf16 composed at 14.8 tokens a second (224.8 s of
     * audio in 745 s); fp8 at 7.4 (204.4 s in 1,131 s), a different plan and a
     * different song. The hope that "quantised" means "faster" is exactly the
     * hope the vendor declined to underwrite, and the card agrees. Selectable
     * per song on the Create form (precision), never the default. */
    quantization: "none",
    /* The attention block for the synthesis prefill and solve — the lever that
     * moves the duration ceiling, found 2026-09-11. nar.py:70 runs the whole
     * sequence in ONE block on CUDA, so the prefill's attention temp grows as
     * tokens² and is what reached the 13.99 GiB cap at 194 s (764 MiB short).
     * 512-token blocks hold it under 0.9 GiB up to the sampler's own 360 s
     * stop, and run faster — MEASURED through nar.attention() itself: 3.58 GiB
     * -> 0.46 at 194 s, 11.79 -> 0.87 at 360 s (yue_fit.js, the Long rung).
     * The same plan that OOM'd then rendered: 194.2 s, prefill peak 8.29 GiB.
     * 0 restores the package default. The audio is the same arithmetic in
     * smaller pieces; the ledger records which one ran. */
    queryChunk: 512,
    /* The sampler's stop in semantic tokens; 0 = the vendor's 9000 (360 s).
     * Set per song by /api/generate when a longer length is asked for, and
     * clamped by the driver to what the context leaves after the prefix. */
    maxTokens: 0,
    /* Tiled VAE decode. The CLI ties this to its budget flag and cannot express
     * "high cap, small tiles" — the Python API can, which is why the runner
     * drives that and not the CLI. */
    vaeCoreFrames: 512,
    memoryBudgetGib: 16,

    /* The NAR flow-matching solver's step count. 32 is the vendor default and
     * cost 106.3 s of a 399.6 s render MEASURED. A public C++ port runs 8, which
     * is part of why its headline figure looks so much better.
     *
     * THE A/B LANDED, 2026-09-11 (scratchpad narab_verdict.py: one fixed score
     * and seed, three renders, all 167.04 s and sample-aligned). Against the
     * 32-step reference: 16 steps correlates 0.9991, residual −27.6 dB relative
     * to programme level, every octave band within 0.01 dB — the same render
     * for half the synthesis time. 8 steps correlates 0.980, residual −14.0 dB,
     * bands still within 0.05 dB — so what it loses is transients and phase,
     * exactly what a band table cannot show and a correlation can. The Create
     * form offers 32 and 16 (--nar-steps); 8 is not offered. The default stays
     * where the vendor put it because nobody has LISTENED to the pair. */
    odeSteps: 32,
  },

  /**
   * Stem separation. OFF by default — it is a deliberate act, not something that
   * should quietly consume the card after every song.
   *
   * `when`: off | all | starred | liked
   *   Starred and liked exist because separating everything is wasteful: most
   *   takes are discarded, and the ones worth pulling apart are exactly the ones
   *   already marked worth keeping.
   */
  stems: {
    when: "off",
    model: "htdemucs_ft",
    // Four stems rather than vocals/no-vocals. The two-stem mode is faster but
    // it is the lyric-alignment use case, not the "remix this" one.
    twoStems: false,
    /* The interpreter a person chose in Settings > Songs > "stem separation
     * python" (or the "stems" setup chose when it finished), saved as
     * prefs.stems.systemPython; null when nobody chose. `config.systemPython`
     * is what actually runs (see systemPython()). */
    systemPython: null,
    /* null (demucs picks: the card when PyTorch can use it) or "cpu". Set by the
     * "stems" setup when its PyTorch cannot run a tensor op on this card (an
     * RTX 50 with a CUDA 12.6-or-older build is the case that motivated it);
     * art.js #separate then passes `-d cpu`. Running the setup again re-tests. */
    device: null,
    /* The interpreter `device` was measured on. A "cpu" verdict about one
     * python says nothing about the next one chosen, so #separate applies it
     * only while config.systemPython is this path (or when none was recorded). */
    devicePython: null,
  },

  /**
   * Timed lyrics — two LRC files per song, for visualisers.
   *
   * Same off/all/starred/liked shape as stems, and off by default for the same
   * reason: it is a deliberate act, and it costs a whisper pass over the audio.
   *
   * ⚠ Runs in the RE-TIMING venv (`%USERPROFILE%\aiplay-whisper\venv`, or the
   * python chosen in Settings, or AIPLAY_WHISPER_PYTHON: see whisperPython()),
   * which needs stable-ts and faster-whisper; a CUDA torch there puts it on the
   * GPU, and without one lrc.py times on the CPU
   * (AIPLAY_WHISPER_DEVICE=auto|cuda|cpu). Not the ComfyUI venv — ctranslate2
   * expects a different torch than the cu130 build the engine depends on.
   *
   * ⚠ Measured honesty: line-level timing is reliable; word-level is approximate
   * on sung vocals, because a word held across two bars has no single onset. The
   * UI must not present the word file as exact.
   */
  /* Narration (audiobooks). Kokoro runs in the main engine venv; Qwen3-TTS
   * lives in ITS OWN venv because its transformers pin would fight ComfyUI's
   * stack — the same isolation the whisper venv already uses. The runner picks
   * the interpreter by engine. */
  tts: {
    python: process.env.AIPLAY_TTS_PYTHON
      || path.join(RIG, "tts-venv", "Scripts", "python.exe"),
    // The default storytelling register handed to engines that take one.
    instruct: "Warm, unhurried audiobook narrator. Clear storytelling cadence, gentle dynamics, natural pauses at sentence ends.",
  },

  lyrics: {
    when: "off",
    /* The whisper model for timed lyrics AND transcription (server/whisper.js),
     * one of WHISPER_MODELS; saved when chosen (PREF_PATHS). */
    model: "large-v3",
    /* The interpreter a person chose in Settings > Songs (or with the
     * timed_lyrics_python tool), saved as prefs.lyrics.whisperPython; null when
     * nobody chose. `python` below is what actually runs, and is recomputed
     * from this after the saved prefs are read (see whisperPython()). */
    whisperPython: null,
    python: process.env.AIPLAY_WHISPER_PYTHON || defaultWhisperPython(),
    // Separating the vocal first measurably helps a dense mix. It is skipped
    // when stems already exist for the track, and skipped entirely when the mix
    // is clear enough — a 92.9% match was achieved on the raw mix in testing.
    useVocalStem: true,
  },

  /**
   * Output format.
   *
   * FLAC stays the default because it is lossless and the library recovers
   * lyrics and style by reading tags back out of the file — the file is a real
   * source of truth here, not just a rendering.
   *
   * MP3 exists because size is the honest constraint on an overnight run: a
   * 3-minute track is ~30 MB as FLAC against ~4 MB as V0, so fifty songs is
   * 1.5 GB versus 200 MB. That is the difference between "leave it running" and
   * "watch the disk".
   *
   * ⚠ There is no WAV option and there should not be: no ComfyUI audio writer
   * emits it, so offering it would mean inventing a conversion step for a format
   * that is strictly larger than FLAC and carries no tags.
   */
  output: {
    format: process.env.AIPLAY_FORMAT || "flac",   // flac | mp3 | opus
    mp3Quality: "V0",                              // V0 | 128k | 320k
    opusQuality: "192k",                           // 64k | 96k | 128k | 192k | 320k
  },

  models: {
    // int8 DiT beats fp16 on full songs once the fused kernels exist (cu130).
    dit: "minimax_music3_dit_int8_convrot.safetensors",
    // Offered as an advanced override only. Measured identical to int8 against a
    // converged reference (both 4.2 dB SNR / +10.8 dB NMR) — it is twice the size
    // for the same result, so int8 stays the default.
    ditFp16: "minimax_music3_dit_fp16.safetensors",
    textEncoder: "minimax_music3_text_encoder_pruned_int8_convrot.safetensors",
    // fp32 VAE is deliberate: bf16 measures +23.5 dB NMR (audible in 18.5% of
    // tiles) and fp16 clips 100% of samples outright. Do not "optimise" this.
    //
    // It is enforced by OMISSION — ComfyUI runs the audio VAE at fp32 unless you
    // pass --fp16-vae / --bf16-vae, so those flags must never appear in
    // `comfy.flags` above.
    vae: "minimax_music3_dav.safetensors",

    // ⚠ The repo also publishes `minimax_music3_dit_fp32.safetensors` (9.15 GB),
    // which we have never downloaded and never measured. The int8 ≡ fp16 result
    // was a two-way test against a SAMPLING-convergence reference (euler@300); it
    // says nothing about fp32. Do not describe fp16 as "the highest precision
    // available" anywhere in the UI until this is settled.
    ditFp32: "minimax_music3_dit_fp32.safetensors",
  },

  // Sampling. shift-5 @ 15 steps lands ~2x closer to the converged solution than
  // the stock euler@30 default, in half the sampling time. Chosen by listening.
  sampling: {
    sampler: "euler",
    steps: 15,
    shift: 5.0,
    cfg: 1.7,
    topK: 50,
    // Preview: same conditioning, fewer steps. The AR stage is cached between
    // the two, so committing after a preview costs only the sampling stage.
    previewSteps: 6,
  },

  // Measured on an RTX 4070 Ti SUPER: 135 s of audio in ~207 s => ~1.5x realtime.
  // Refined per machine by the first-run warm-up; this is only the cold estimate.
  speed: {
    /* Where the engine ended up: 1.53x realtime, so a 3-minute song renders in
     * about 4.6 minutes. Measured on a 135 s render.
     *
     * `naiveRatio` is where it STARTED — an untuned self-install on this same
     * card, before the schedule, the precision and the torch build were sorted
     * out. 9.6x realtime, i.e. ~28.8 minutes for the same 3-minute song.
     *
     * ⚠ That baseline is NOT re-runnable. Reproducing it means reverting every
     * tuning decision at once, and the config that produced it no longer exists.
     * It is recorded here so the speedup claim has a stated provenance instead of
     * living only in someone's memory — but it is a historical measurement, not
     * a checkable one, and anything quoting it should say so.
     *
     * 9.6 / 1.53 = 6.3x end to end. */
    realtimeRatio: 1.53,
    naiveRatio: 9.6,
  },

  /**
   * ── H3 video: launch flags and settings worth A/B-ing ──────────────────────
   *
   * Findings from a verified community survey (2026-08-18). NOT applied, because
   * every one of them touches the engine that currently renders music correctly,
   * and this project already shipped one launch flag that was reasoned about
   * rather than measured — `--novram`, which produced zero audio. Measure first.
   *
   *  `--fast-disk`   Real flag (cli_args.py:182), parses on this build: "prefer
   *                  disk-backed dynamic loading and offload over unpinned RAM".
   *                  One report measured ComfyUI RSS 45.4 -> 12.6 GiB on the same
   *                  model set. This box has 32 GB and a ~31 GB video set, which
   *                  is exactly that case — but it trades RAM for disk I/O, so it
   *                  is only a win if D: is fast.
   *  `--lowvram`     Reported a no-op under dynamic VRAM on this exact argv. Our
   *                  tiers are measured for the MUSIC path though, so removing it
   *                  is a music change, not a video one. Leave alone.
   *  `--async-offload 4`  The 4 is unsourced; the default is 2.
   *  `--use-ck-attention` / ModelAttentionBackend node — comfy_kitchen is present
   *                  and int8 attention is available. Ada is untested middle
   *                  ground between "no gain on a 5090" and "20-30% on a 3060".
   *                  ⚠ Vary the seed per run or ComfyUI's cache returns instantly
   *                  and fakes a win.
   *
   * Sampling, from practitioner reports rather than the template defaults:
   *   turbo LoRA at 6-8 steps, strength 0.75, er_sde + beta (4 steps is where the
   *   "metallic audio" complaints come from). Keep BasicGuider — CFGGuider doubles
   *   inference time for nothing here. MiniMaxH3SigmaShift 12/3 for the 8-step
   *   LoRA, 6/3 for the 4-step 768p one.
   *   Do NOT add VAEDecodeTiled: sd.py sets handles_tiling=True and the H3 video
   *   VAE already tiles internally at 256px / 17 frames.
   *   ⚠ Avoid EasyCache on this product: ~50% audio amplitude regression
   *   (ComfyUI issue 15326). A 25% speedup is not worth that in a music tool.
   */

  /**
   * Audio reference — start the render from a real song instead of from noise.
   *
   * Proven 2026-08-17. ComfyUI ships the DAV decoder only and `sd.py:534`
   * refuses to encode, but the encoder weights exist and its 121 decoder tensors
   * are BIT-IDENTICAL to ComfyUI's, so a latent we produce outside the process
   * is one the sampler already understands. Round trip through stock
   * `LoadLatent` -> `VAEDecodeAudio`: +26.26 dB SI-SDR, pearson 0.999.
   *
   * ⚠ WHAT THIS IS NOT. The reference steers the RENDER, not the composition —
   * that still comes from the caption through the free-running AR stage. So it
   * gives "this song's shape, a new sound", not "this song's tune with new
   * words". Extending an uploaded track remains impossible: that needs the AR
   * trajectory, and getting one from audio needs the RVQ tokenizer nobody
   * released.
   */
  audioRef: {
    // See the calibration table in workflow.js. 0.85 is the blend; lower keeps
    // more of the reference and 0.6 is effectively a copy.
    denoise: 0.85,
    /* Encoding is quadratic-ish in memory and a full track OOM'd the card while
     * the music stack was resident. 60 s is plenty to establish structure and
     * fits alongside everything else. */
    maxSeconds: 60,
    // Below this the reference reconstructs badly enough that it is worth
    // saying so — measured 22-25 dB on ordinary material, 6.6 dB on signals the
    // autoencoder has never seen anything like.
    warnBelowSdrDb: 12,
  },

  /**
   * Video clips — MiniMax H3, the 29 GB int4_convrot set.
   *
   * 🔴 LICENCE — READ THIS BEFORE YOU DOWNLOAD THE WEIGHTS. The H3 Community
   * Licence grants rights "solely within the Applicable Territory", and that
   * territory EXCLUDES the European Union, the United Kingdom, the Republic of
   * Korea and the United States of America. If you are in one of those places
   * you may not use these weights, and §V.4 says the same about anything they
   * generate. This is a condition between you and MiniMax: AIPLAY Studio does
   * not host the files, the download goes straight to the publisher, and the
   * Models screen shows the territory warning before anything is fetched.
   * `enabled: false` is the default for exactly that reason — the engine is
   * off until someone reads the licence and decides it applies to them.
   *
   * 🔑 int4_convrot is NATIVE on this card, nvfp4 is NOT. Verified by reading the
   * weights (`{"format":"convrot_w4a4"}`, present in `QUANT_ALGOS`) and by
   * `supports_nvfp4_compute` returning false on sm_89. The 12.5 GB nvfp4 DiT is
   * smaller but would run emulated; int4 is smaller AND native.
   *
   * ⚠ `length` must satisfy `n mod 17 == 5` — see `align_frame_count` in
   * comfy_extras/nodes_minimax_h3.py. 2 s at 24 fps = 56 frames. Passing any
   * other value silently gets rounded UP, so a "2 second" clip becomes longer
   * than the caller asked for.
   */
  /**
   * Post-processing for finished clips.
   *
   * Off by default like everything else that costs GPU time. `when: "all"`
   * enhances every clip an Overnight run produces; the Video screen can also
   * ask for one directly, which ignores this setting the same way a manual
   * cover render ignores the cover dropdown.
   */
  enhance: {
    when: "off",                       // "off" | "all"
    // Which of the four named outcomes an unattended run should use. "smooth"
    // is the default because it is the cheap one and the one that helps most:
    // generated clips are short and their weak point is motion.
    mode: "smooth",                    // "smooth" | "bigger" | "both"
  },

  video: {
    enabled: false,

    /* A FRESH ENGINE BEFORE EVERY H3-FAMILY CLIP. MEASURED 2026-09-24 on an
     * RX 9060 XT (ROCm, Windows, dynamic VRAM), H3 1344x768, 8 steps, same
     * settings: on a fresh engine process ~82 s a step; the next render in
     * the same process ~152 s, with 14.1 GB on the card and 4.1 GB spilled to
     * shared system memory (13.3 and 2.5 before). ComfyUI's /free with
     * unload_models did NOT bring it back (155 s a step after it), and
     * --disable-dynamic-vram was far worse (580 s for one step, RAM paging).
     * A restarted engine did: 78 s a step on the render after a TaoMate one.
     * So an engine that has rendered anything is restarted before an H3 or
     * FastH3 clip: "auto" does it on any card that is not NVIDIA (not seen
     * there), "always" and "never" force it. art.js clipNeedsCleanCard();
     * video_settings free_before_clip. */
    freeBeforeClip: "auto",

    /* WHAT SaveVideo ENCODES AT — every engine, both H3 paths and LTX.
     *
     * MEASURED 2026-09-12 on the promo clips: `codec: "auto"` hands ComfyUI's
     * PyAV writer no CRF, libx264 falls back to its default 23, and a 1344x768
     * clip came back at 1.0 Mbit/s — a DVD-class bitrate for an HD frame. A
     * large part of "blurry" was this: the render was sharper than the file it
     * was saved into, and the timeline cut re-encodes THAT file at 6 Mbit/s,
     * so the softness is baked in before the cut ever sees it. 14 is close to
     * visually lossless for this content and costs disk, not render time. 0
     * keeps the old auto/auto node byte for byte. workflow.js, saveEncode(). */
    saveCrf: 14,

    /* When to make a clip automatically: off | all | starred | liked.
     *
     * ⚠ THIS LIVES ON `video`, not on an engine. It was declared inside
     * `engines.h3`, where nothing reads it — so `config.video.when` was
     * `undefined`, every `want("video", config.video.when)` compared
     * `undefined === "all"` and was false, and `maybePost` never fired either.
     * The field was added specifically to make "a clip for everything I star"
     * reachable, and being one object too deep meant it still was not: the
     * setting could be chosen in Settings and would quietly do nothing.
     *
     * It looked present because the route ASSIGNS it, so `config.video.when`
     * springs into existence the first time anyone changes the dropdown and
     * behaves correctly for the rest of that session.
     *
     * `off` is still the default — 34 GB of weights and ~30 s a clip should not
     * start happening to people — but now it is a default rather than a gap. */
    when: "off",


    /* WHICH ENGINE. Two are supported and they are genuinely different tools.
     *
     * Measured here 2026-08-18, same prompt and seed, comparable resolution:
     *     H3  @ 8 steps  1344x768 x 124f   308 s
     *     H3  @ 20 steps 1344x768 x 124f   660 s
     *     LTX 2.5        1280x704 x 121f   121 s   <- and visibly better
     * LTX wins on both axes because of a two-pass schedule, not a faster model:
     * 8 steps at HALF resolution, a latent x2 upscale, then only 3 steps at full
     * size starting from sigma 0.85. Almost nothing is spent at full resolution.
     *
     * ⚠ They are NOT interchangeable in their settings. Different frame rules,
     * different valid sizes, different cost curves, different licences. Every
     * engine-specific value lives under `engines` below; nothing here is shared
     * except the switches a user thinks of as "video on/off". */
    /* ⚠ THE SHIPPED DEFAULT MUST BE AN ENGINE STUDIO CAN DOWNLOAD.
     *
     * This said "ltx" and it was the only defect in the install path that could
     * not be worked around by reading more carefully. LTX 2.5 is the better
     * engine on the numbers directly above — and its repository is ACCESS-GATED.
     * The built-in downloader refuses it on purpose (see `gated` on videoLtx in
     * models.js: it has no token and deliberately nowhere to keep one), so the
     * Models screen offers instructions where every other row offers a button.
     *
     * Which meant the shipped default pointed at the single model a new user
     * could not obtain. Open the Video page on a fresh install and it said "LTX
     * 2.5 is not downloaded yet (39.7 GB missing). Open the Models screen." —
     * and the Models screen had nothing to press. First click, dead end,
     * out of the box.
     *
     * So the default is now the fetchable engine. This costs an existing user
     * nothing: a saved `video.engine` in settings.json overrides it (PREF_PATHS
     * below), and anyone already holding LTX weights keeps rendering on them
     * because resolveVideoEngine() in workflow.js resolves to WHAT IS ON DISK,
     * preferring the setting. The default is only ever the answer for a machine
     * that has neither — and for that machine, H3 is the only true answer.
     *
     * ⚠ H3 carries a TERRITORY condition (no rights in the EU, the UK, the
     * Republic of Korea or the USA) and the downloader will not fetch it
     * without an explicit acknowledgement. That is a licence someone must
     * accept, not a default that quietly does something; nothing here
     * downloads, and the Video surface names the condition beside the engine. */
    engine: "h3",
    engines: {

    /* ── MiniMax H3 ────────────────────────────────────────────────────────
     * Slower and heavier, region-locked, but it is what the shift/steps/native
     * -resolution work was measured on and it stays available. */
    h3: {
    label: "MiniMax H3",
    /* The architecture name server/detect.js reads out of a LoRA made for this
     * engine. The ONE place it is written: the Video screen's LoRA picker and
     * /api/video's check (video-lora-validation.js) both read it from here, via
     * /api/status, so they cannot disagree. FastH3 inherits it through the
     * spread below (its DiT is H3's, distilled; the graph stacks your LoRAs on
     * it as on H3's). An engine without one takes no LoRAs of your own. */
    loraBase: "MiniMax H3",
    /* OFFICIAL weights first — Comfy-Org/MiniMax-H3 published the full set
     * (2026-08-24; it did not exist when the third-party builds were hunted
     * down). Measured, same seed and flow: the official pruned int8 DiT with
     * the official VAEs is a different class of output from the local int4
     * prune — an actual prompt-following close-up with photographic texture —
     * at ~15% more wall clock (771 s vs 669 s at 1344x768x124x20). The old
     * builds stay as fallbacks for machines that only have those. */
    /* A light machine (LIGHT_H3) loads the w4a8 build first: measured as good
     * and a little faster on an RX 9060 XT, 8 GB smaller. Repeated last so a
     * light machine holding none is told to fetch it. */
    dit: LIGHT_H3
      ? pick("diffusion_models",
        "minimax_h3_fl2va_pruned-w4a8_convrot_pruned.safetensors",
        "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
        "minimax_h3_fl2va_pruned_int4_convrot.safetensors",
        "minimax_h3_fl2va_pruned-w4a8_convrot_pruned.safetensors")
      : pick("diffusion_models",
        "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
        "minimax_h3_fl2va_pruned_int4_convrot.safetensors",
        "minimax_h3_fl2va_pruned-w4a8_convrot_pruned.safetensors"),
    /* References render on the checkpoint BUILT for them — the vendor's r2v
     * template uses ref2va, not fl2va. Falls back to the fl2va builds so refs
     * keep working (measured working 08-23) where ref2va is not downloaded. */
    ditRef: pick("diffusion_models",
      "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
      "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
      "minimax_h3_fl2va_pruned_int4_convrot.safetensors",
      "minimax_h3_fl2va_pruned-w4a8_convrot_pruned.safetensors"),
    /* The int4 build on every card. AMD used to take the int8 one on the
     * belief that ROCm ran int4 on a slow fallback; measured 2026-09-25 on an
     * RX 9060 XT it was a little FASTER than int8 (299 s against 316 s a
     * clip) and staged 13.5 GB instead of 25.9. The int4 name is repeated
     * last so a machine holding neither is told to fetch the int4. */
    textEncoder: pick("text_encoders",
      "qwen3vl_32b_minimax_h3-int4_convrot.safetensors",
      "qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
      "qwen3vl_32b_minimax_h3-int4_convrot.safetensors"),
    /* int8 first where it is on disk; a light machine (LIGHT_H3) is told to
     * fetch it, others the fp16 (the build the H3 lab measured with). */
    videoVae: LIGHT_H3
      ? pick("vae",
        "minimax_h3_video_vae_int8_convrot.safetensors",
        "minimax_h3_video_vae_fp16.safetensors",
        "minimax_h3_video_vae_int8_convrot.safetensors")
      : pick("vae",
        "minimax_h3_video_vae_int8_convrot.safetensors",
        "minimax_h3_video_vae_fp16.safetensors"),
    audioVae: pick("vae",
      "minimax_h3_audio_vae_fp32.safetensors",
      "minimax_h3_audio_vae_bf16.safetensors"),
    // Full-rank on purpose. The 440 MB resized-rank LoRA saves 1.5 GB and has
    // two independent reports of camera-movement degradation and I2V
    // prompt-following failure.
    /* The 8-step LoRA, matching our 8-step setting.
     *
     * We ran the 4-STEP 768p build at 8 steps, which is off its design point.
     * Both are on disk; `pick` prefers the matching one and falls back to the
     * 4-step build for anyone who only has that. */
    turboLora: loraSlot("turboLora",
      "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
      "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors"),
    /* The ref2va checkpoint has its own turbo distillations — TWO now. The
     * 8-step v1.0 768p build (lightx2v, 1.96 GB, fetched 2026-09-12) is the one
     * the community calls "much better at keeping references", and the point
     * that matters here is plainer: it MATCHES the 8-step schedule the
     * reference path runs by default. Until this date the 4-step v0.1 was the
     * only ref2v turbo on disk, so every 8-step reference render ran a 4-step
     * distillation off its design point — the exact mistake the turboLora4
     * comment below describes for the fl2v path, made on the other one. Falls
     * back to v0.1, then to the fl2v loras, for machines without it. */
    refTurboLora: loraSlot("refTurboLora",
      "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
      "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
      "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
      "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors"),
    /* THE 4-STEP BUILDS, NAMED SEPARATELY so the LoRA can match the schedule.
     *
     * The comment above admits it: "We ran the 4-STEP 768p build at 8 steps,
     * which is off its design point." That happened because `turboLora` was one
     * name chosen at config time, with no idea how many steps the render would
     * use — a distillation trained for 4 steps run at 8 is not a faster model,
     * it is a different one used wrongly. Picking by step count is the whole
     * fix; both files have been on disk all along. */
    turboLora4: loraSlot("turboLora4",
      "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors",
      "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"),
    refTurboLora4: loraSlot("refTurboLora4",
      "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
      "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors"),
    // At or below this many steps, the 4-step distillation is the right one.
    turbo4MaxSteps: 5,
    /* THE 3-STEP BUILD: TaoMate-H3 (TaoLiveAIGC, rank 128, trained on the FL2VA
     * weights), converted for ComfyUI's LoraLoaderModelOnly by Robert1212star,
     * 2026-09, 2.48 GB. Its card publishes no shift, so the table below starts
     * it at the base 12/3 — a starting point, not a measurement; sweep 8 if
     * it comes back overcooked. Falls back to the 4-step build on a machine
     * without the file, which is what 2 and 3 steps ran before this existed.
     * The reference path is left alone: this file was not trained on ref2va. */
    // TAOMATE_FILES: the full conversion, then Kijai's rank-19 average of the
    // same LoRA (182 MB against 2.48 GB), taken when the full one is not on disk.
    turboLora3: loraSlot("turboLora3", ...TAOMATE_FILES,
      "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors"),
    // At or below this many steps, the 3-step distillation is the right one.
    turbo3MaxSteps: 3,
    /* A CONDITIONING BRIDGE (server/comfy_nodes/aiplay_h3_bridge.py): a small
     * learned rewrite of H3's text conditioning, blended in at `bridgeAlpha`.
     * "off" by default — its authors report ~1 in 10 renders regress and the
     * reference path was measured worse for singing. The Video panel and
     * video_settings choose the adapter; make_clip/extend_clip can override
     * per render. Adapters live in models/conditioning_bridges. */
    bridge: "off",
    bridgeAlpha: 0.10,

    /* THE SHIFT EACH DISTILLATION WAS TRAINED AT, keyed by LoRA file.
     *
     * A turbo LoRA is not schedule-agnostic: it was distilled at one sigma
     * shift and the vendor publishes that number with the weights. Ours all
     * ran at 12/3 — the BASE model's default — because the graph had one shift
     * for every turbo path. For the fl2v 4-step v1.0 768p build that is wrong:
     * ModelTC's README lists it at 6/3, the diffusers recipe runs
     * `--video-shift 6`, and its own dmd config says video_flow_shift 6.0. The
     * 8-step fl2v v1.0 (544p) and the ref2v 4-step v0.1 are 12/3 in the same
     * sources. The ref2v 8-step v1.0 768p is the one the sources DISAGREE on
     * (lightx2v issue #51 says 12, comfyui-wiki 2026-09-04 says 6). MEASURED
     * 2026-09-12 on the promo's shot s1_1, two seeds, same prompt and
     * reference: 12 is right for it — at 6 the second seed came back very
     * dark with the reference's layout lost (detail 69 against 148, mean
     * luma 10 against 19). 6 is rejected, not pending.
     * docs/H3_REFERENCE_BLEED.md, "the promo post-mortem".
     *
     * Precedence, in workflow.js h3SigmaShiftFor(): an explicit turboShiftVideo
     * from the Video panel wins (a person moved it on purpose), then this table
     * for the LoRA that actually loads, then the base shiftVideo. The quality
     * path — no LoRA — never reads any of this. server/videolab/catalog.js
     * asks the same function for the commit sigma it shows, so the panel and
     * the graph describe one render. */
    turboShiftByLora: {
      // TaoMate 3-step: no published shift; the base pair until measured here.
      "taomate_h3_3step_comfy.safetensors": { video: 12, audio: 3 },
      "minimax_h3_taomate_3step_lora_avg_rank_19_bf16.safetensors": { video: 12, audio: 3 },
      "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors": { video: 6, audio: 3 },
      "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors": { video: 12, audio: 3 },
      "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors": { video: 12, audio: 3 },
      "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors": { video: 12, audio: 3 },
    },

    /* Strength of the turbo LoRA. 1.0 is the published default for this build;
     * community reports settle around 0.75-1.0 and lower is where the "metallic"
     * complaints start. Exposed because the LoRA was, until now, not applied at
     * all — so this value has never actually been exercised. */
    loraStrength: 1.0,

    /* THE MATCHED TURBO SETTING THIS DISK HAS, NEVER A LITERAL. 4 here, and
     * raised to 8 below the object (the step-defaults block after `config`)
     * only where pick() resolved BOTH turboLora and refTurboLora to an 8-step
     * file, because a 4-step distillation run at 8 is the wrong model and the
     * Models screen fetches no 8-step file: a literal 8 is right only on a rig
     * that fetched those files by hand, as this one did. It was 20 until
     * 2026-09-23. This is the number every render that names no step count
     * gets: make_clip without `quality` or `steps`, the API, and the Video Lab
     * panel. The Video screen's slider opens on the same number (/api/status
     * sends it as stepDefaults.standard).
     *
     * What is on file, each with its scope:
     *   - docs/H3_REFERENCE_BLEED.md, arm H against arm C (2026-09-12, ONE
     *     shot, the reference path, 1344x768 x 260 frames): the bare model at
     *     20 steps came back about equal to the ref2v 8-step turbo (detail 346
     *     against 324/251) at 2.4x the time, 45 min against 19. It is the only
     *     A/B of the two paths this graph runs today.
     *   - 2026-08-24, two seeds: the bare model at 20 with shift 12 was the
     *     cleanest arm, and the churn it beat was the turbo LoRA run AT 20
     *     steps (docs/ENGINE_TRAPS.md), which no longer happens: see
     *     turboMaxSteps below.
     *   - 2026-08-18, native size, 124 frames, same prompt and seed. This
     *     table is why the default used to be 20:
     *       turbo @  8   detail 38.0   308 s   clean but flat
     *       turbo @ 20   detail 88.8   660 s   VISIBLY the best
     *       full  @ 30   detail 70.2   963 s   BROKEN: the face is a smear
     *     Its "turbo @ 20" is that same LoRA-at-20 path, and "full @ 30" ran
     *     at shift 4 (see shiftVideo), so neither row is a render made now.
     *
     * So the one direct comparison found no visible gain for 20, and the
     * 8-step turbo costs under half the time. Best (20, the bare model) is
     * still one click on the Video screen and make_clip's quality "best". The
     * MV pipeline never read this default: it sends its own 8
     * (mv/generate.js). */
    steps: 4,
    /* Auto, per path (workflow.js h3SamplerFor, 2026-09-24): res_multistep on
     * the reference path (pictures or sounds attached), measured there by Hex
     * Appeal's final cut and the REWIND A/B's winning arm; Euler on the
     * first/last-frame LightX2V turbo builds, the publisher's recipe, not
     * measured here; res_multistep for the bare model and TaoMate 3-step. An
     * explicit Video Lab sampler remains an override for every path. */
    sampler: "auto",
    scheduler: "simple",

    /* 🔴 NATIVE RESOLUTION AND A TRAINED LENGTH. Both, or neither helps.
     *
     * We shipped 864x480 x 56 frames. The node's own defaults are 1344x768, and
     * its `length` tooltip says the TRAINED RANGE IS ~124-362 FRAMES — so we were
     * asking for 40% of the native pixel count at less than half the shortest
     * length the model has ever seen. That is the "vague, jittery, morphing"
     * report, and it is not a sampler setting.
     *
     * Measured 2026-08-18, same prompt and seed, variance-of-Laplacian detail:
     *     864x480  x  56f   49.1   <- what shipped
     *     864x480  x 124f   41.4   <- longer alone: no help
     *    1344x768  x  56f   48.3   <- bigger alone: no help
     *    1344x768  x 124f  131.2   <- BOTH: 2.7x the detail
     * High-frequency spectral share moved 40.4% -> 51.8% on the same pair.
     *
     * The interaction is the point: neither change on its own does anything.
     * It costs ~300 s a clip instead of ~54 s, which is the honest price of the
     * model working as intended, and the Video panel offers smaller/faster sizes
     * for anyone who would rather have speed. */
    width: 1344,
    height: 768,
    seconds: 5,
    fps: 24,

    /* Render-cost model, fitted to four measured points on this card:
     *   23.2 Mpx-frames -> 54 s | 51.4 -> 97 s | 57.8 -> 103 s | 128 -> 298 s
     * Superlinear because attention is quadratic in token count, so a linear
     * per-pixel rate under-quotes the native size badly. */
    costFixedSeconds: 15,
    costRate: 0.84,
    costExponent: 1.2,

    /* 🔑 shift_video 4, NOT the 12.0 default.
     *
     * Measured here 2026-08-18 across four seeds: shift 4 beat the default on
     * loop closure 4/4 and on flicker 4/4, at identical wall-clock. `ModelSamplingAV`
     * reduces the pair to one ratio (audio_scale = video/audio) and the node that
     * sets it appears in NEITHER official template — so the defaults ship unswept.
     * This is the video analogue of the two-CFG split in the music engine.
     *
     * ⚠ Magnitude is uncertain (+0.68 to +9.89 dB across seeds); the DIRECTION is
     * what four-for-four supports. Do not quote a headline number.
     *
     * 🔴 RE-MEASURED 2026-08-18, AND THE FINDING DOES NOT SURVIVE.
     *
     * The sweep above ran before the turbo LoRA was wired in — on the BASE model
     * at 8 steps, which we now know produces vague frames that barely follow the
     * prompt. So it was re-run on the SHIPPING graph (scripts/h3_shift_resweep.mjs
     * calls videoGraphH3 itself rather than copying it), 3 shifts x 2 seeds,
     * 1344x768 x 124 frames, 20 steps, ~11 min a clip:
     *
     *              loop_db   flicker   detail   drift
     *   shift  4     12.98      2.22    574.5   27.69
     *   shift  6     13.04      2.37    686.8   28.37
     *   shift 12     12.46      2.10    460.9   31.22
     *   spread        0.57      0.27    225.9    3.53
     *   NOISE FLOOR   5.17      0.39    237.7   10.55   <- two seeds, same shift
     *
     * EVERY metric's between-shift spread is smaller than the seed-to-seed
     * spread at a single shift. The seed dominates completely — at shift 4 alone,
     * loop_db runs 11.13 to 14.83 and detail 455.6 to 693.3. So shift_video has
     * no measurable effect on the distilled path, and the original "4 beats the
     * 12.0 default, 4/4 on two metrics" was noise being read as signal by a
     * design with no noise floor in it.
     *
     * Confirmed by eye: the contact sheets for shift 4 and shift 12 are both
     * clean — coherent face, readable knit texture, stable lamp, smooth push-in
     * — and shift 12 scored the LOWEST `detail` while looking fine, which is one
     * more reminder that high-frequency energy is not quality.
     *
     * 4.0 is KEPT, but only because every render on this machine was made with
     * it and there is no reason to churn. It is not better. If anything here
     * matters for quality it is the two rows above this one: native resolution
     * with a trained length, and actually loading the LoRA.
     *
     * 🔴 SUPERSEDED 2026-08-24 — 12.0, the model's own default, after diffing
     * our graph against the vendor's template flows and A/B-ing what they do
     * differently. The vendor runs NO sigma-shift node (so the model default,
     * 12/3, applies) and NO turbo LoRA at 20 steps. Reconciling every
     * measurement on file:
     *
     *   - The BARE model needs shift 12 — its own schedule. "LoRA off = the
     *     face is a smear" (08-18) was measured at shift 4; at shift 12 the
     *     bare model at 20 steps was the cleanest arm on both seeds tried.
     *   - The LoRA path tolerates any shift (the 08-18 resweep: spread smaller
     *     than seed noise on every metric) — distillation bakes its own
     *     schedule in, so 12 costs the fast path nothing.
     *   - Temporal churn (mean inter-frame |diff|, two seeds): LoRA@20+shift4
     *     1.35/0.95 vs bare@20+shift12 0.67/0.30 — the shipped combo flickers
     *     2-3x more, which IS the long-standing "jittery" report.
     *
     * So: 12 unconditionally, and the LoRA only below `turboMaxSteps`.
     */
    shiftVideo: 12.0,
    shiftAudio: 3.0,

    /* The turbo LoRA is an 8-STEP DISTILLATION. Run at 20 steps it over-shoots:
     * crunchy sparkling textures and 2-3x the inter-frame churn (measured
     * 08-24, two seeds, same prompt). The vendor's own flows never load it at
     * 20 steps. So it applies only when the step count is in distillation
     * range — the slider's fast half — and the quality half runs the bare
     * model on its native schedule, exactly like the templates. */
    turboMaxSteps: 12,

    /* COMFY KITCHEN ATTENTION, per graph: "ck" puts a ModelAttentionBackend
     * node between the LoRAs and the sigma shift; "pytorch" leaves it out.
     *
     * MEASURED 2026-09-23 on this card (RTX 4070 Ti SUPER, Ada), on a real
     * film-clip graph — ref2va int8 + ref2v 4-step turbo, 1344x768, 107
     * frames, two reference plates — four renders interleaved OFF/ON/OFF/ON
     * with a fresh seed each:
     *
     *     steady s/step   pytorch 32.8, 39.5    comfy kitchen 17.3, 25.7
     *     whole clip      pytorch 209 s, 187 s  comfy kitchen 101 s, 140 s
     *
     * 1.9x and 1.5x on the sampler inside each pair (the second pair ran
     * ~20% slower in BOTH arms, which is contention, not the setting). The
     * gain is all in sampling; text encode and VAE decode did not move. At
     * 1:1 the CK frames showed no banding, blocking or int8 noise and the
     * best feather detail of the four. This is the lever Maurice Bourdon's
     * 12 GB H3 post names, and every one of 698 earlier H3 renders in
     * comfy.log said "Using pytorch attention" — it was available since
     * ComfyUI 0.32 and never switched on.
     *
     * H3 ONLY, deliberately. The launcher's Attention choice (comfyargs.js)
     * flips EVERY model — FLUX.2, Qwen Image, LTX, YuE2's nodes, AnimateDiff
     * — and none of those are measured under int8 attention. A per-graph
     * node changes the one model it wraps.
     *
     * Two things turn it off without anybody editing this line: a card whose
     * ComfyUI does not offer the option (the node's COMBO lists it only when
     * comfy_kitchen int8 is available, and an unlisted value fails the whole
     * prompt at validation), and an EXPLICIT attention choice in the
     * launcher's Advanced settings, which is a person saying what they want.
     * Both are decided in art.js h3Attention(). */
    attention: "ck",

    /* SPARSE ATTENTION ON THE FAST SETTING, and only there (the H3 lab,
     * 2026-09-24, arm A3 against A: 1344x768, 8 s, one 16 GB card). ComfyUI
     * 0.36's own BlockSparseAttention in sol-attn mode, as node 81 after the
     * sigma shift (workflow.js h3SparseFor): tau 1.3, dense for the first 20%
     * of the schedule, only above 12,288 video tokens. Measured: step 1 stays
     * dense, steps 2 and 3 run 1.54x faster, so the sampler is 1.26x and the
     * whole clip 1.15x faster (22.5 s saved on a 172 s clip), for a slightly
     * softer, paler picture. Not measured on the 4- or 8-step builds, on the
     * reference path, on continuations or video-to-video, so those stay dense;
     * not measured at 960x544 or with the rank-19 TaoMate file either, which
     * the note says. The recipe and its words are h3tier.js H3_SOL_ATTN, the
     * one copy.
     *
     * `sparse` is the setting ("sol-attn" | "off"): the Video screen's Advanced
     * "Sparse attention" switch saves it (video_settings' sparse_attention row,
     * the same value) and follows it; a render names it only to differ from it
     * (make_clip `sparse`, or the page while its save is in flight). `solAttn` is the
     * measured recipe, not a setting. The node runs dense by itself on a card
     * without the comfy_kitchen sol_attn kernel; an engine without the node or
     * the mode gets no node at all (art.js videoSparse asks it first). */
    sparse: "sol-attn",
    solAttn: H3_SOL_ATTN,
    /* OPT-IN, NOT MEASURED BY THE LAB: sol-attn on every step count of the
     * plain path (Standard and Best too), and its strength. video_settings
     * sparse_everywhere / sparse_tau. Off and the lab's tau until a person
     * sets them; workflow.js h3SparseFor reads both. */
    sparseAll: false,
    solAttnTau: null,
    /* OPT-IN, EXPERIMENTAL: T8mars's MiniMax H3 Block Cache custom node
     * (h3tier.js H3_BLOCK_CACHE) on the plain path, where no sparse attention
     * runs. video_settings block_cache; art.js videoBlockCache() asks the
     * engine for the node first. */
    blockCache: false,
    blockCacheRecipe: H3_BLOCK_CACHE,

    /* H3 ALWAYS renders audio — there is no video-only path, and moving the
     * audio shift changes its level without changing the time it costs
     * (measured: identical wall-clock, audio RMS -14.1 to -27.6 dBFS). For a clip
     * that sits under a song we already made, that audio is discarded. */
    dropAudio: true,

    /* Frame rule. H3's `align_frame_count` rounds UP to n mod 17 == 5, silently,
     * so an unaligned request returns a longer clip than asked for. */
    frameRule: "mod17plus5",
    /* Sizes that are actually native. 40% of native pixels measured 2.7x worse. */
    sizes: [
      /* H3 samples at whatever size it is given, so these all RUN — but there
       * is no H3-Regenerate-2K in ComfyUI 0.33.0 (checked: five H3 nodes, none
       * of them an upscaler), so anything above native is untrained territory
       * rather than a supported mode, AND expensive: the cost curve puts 1080p
       * near half an hour for five seconds against LTX's three minutes.
       * Offered because the owner asked for the ceiling, labelled so the price
       * is visible before it is paid. */
      { w: 1344, h: 768, label: "1344 x 768 · native — best quality" },
      { w: 1280, h: 720, label: "1280 x 720 · 720p" },
      { w: 1920, h: 1080, label: "1920 x 1080 · 1080p — above native, slow" },
      { w: 2560, h: 1440, label: "2560 x 1440 · 1440p — above native, very slow" },
      { w: 768, h: 1344, label: "768 x 1344 · vertical" },
      { w: 1080, h: 1920, label: "1080 x 1920 · 1080p vertical — slow" },
      { w: 864, h: 480, label: "864 x 480 · fast, noticeably softer" },
      /* The card tiers' own sizes (server/h3tier.js) join below, so the size
       * chip a smaller card starts on is a size this list has. */
    ],
    },

    /* ── LTX 2.5 ───────────────────────────────────────────────────────────
     * Lightricks. 5.5x faster than H3 at 20 steps and better by eye.
     *
     * 🔑 THE SPEED IS THE SCHEDULE, not the model. Two passes: 8 steps at half
     * resolution, LTXVLatentUpsampler x2 in LATENT space, then 3 steps at full
     * size starting at sigma 0.85. Step counts are baked into two literal sigma
     * strings, so there is no single `steps` number — which is exactly why the
     * cost model has to be per-engine.
     *
     * ⚠ LICENCE is a different shape from H3's, and the difference is good news
     * that has been mis-stated elsewhere. There is NO territory restriction: §2.1
     * grants a worldwide licence "for any purpose", §7 is only OFAC sanctions,
     * and the EU/UK appear once — in §14, to PRESERVE mandatory consumer rights,
     * not to withhold a grant. The EU is fine. §5 is explicit that "Licensor
     * claims no rights in the Output you generate". This is NOT the H3 pattern
     * and must not be recorded as if it were.
     *
     * What DOES bite (re-read from primary text 2026-08-28):
     *  - A paid agreement is required at annual revenue of $10,000,000 or more.
     *  - Attachment A item 20 (a list of 20 use restrictions, NOT "§20" — the
     *    Agreement's own sections stop at 16) forbids use in a product that
     *    "directly competes with" Lightricks' offerings. They ship LTX Studio.
     *  - ⚠ THE BROADER BAR IS IN THE AUP, WHICH IS INCORPORATED BY REFERENCE and
     *    which nobody here had read: it forbids using the Products "or any
     *    outputs to develop, modify, fine tune or improve any products or
     *    services that compete with our Products" — no "directly", and its own
     *    scope sentence covers "on-premises deployments", so running the weights
     *    locally does not put us outside it. Attachment A also opens "you agree
     *    not to use the Outputs ... in any of the following ways", so the use
     *    restrictions reach outputs even though ownership does not.
     *  - §6/§19 forbid removing watermarking or provenance features, and §6's
     *    remedy is revocation "effective immediately" — worth knowing before
     *    anyone applies a broad LoRA across all 48 blocks.
     *
     * The HF repo is access-gated: it needs an accepted licence and a token. */
    ltx: {
    label: "LTX 2.5",
    loraBase: "LTX",
    dit: "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
    textEncoder: "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
    /* ⚠ "-conv-" first: it is the file Studio's LTX graph was measured with.
     * The diffusion-decoder VAE (CausalDiffusionVAE) is what ComfyUI's own
     * LTX 2.5 template loads under the plain name; ComfyUI's VAELoader reads it
     * (comfy/sd.py, "lightricks LTX 2.4 diffusion VAE decoder"). Taken when
     * the conv one is not on disk, so a template install renders here too. */
    videoVae: pick("vae", "ltx-2.5-video-vae-conv-bf16.safetensors", "ltx-2.5-video-vae-bf16.safetensors"),
    audioVae: "ltx-2.5-audio-vae-bf16.safetensors",
    upscaler: "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",

    sampler: "euler_ancestral",
    /* The two schedules, verbatim from the vendor template. Pass 2 starts at
     * 0.85 rather than 1.0 — it is a partial re-denoise of an upscaled latent,
     * not a fresh render. */
    sigmasLow: "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0",
    sigmasHigh: "0.85, 0.7250, 0.4219, 0.0",

    /* ⚠ video_cfg MUST equal audio_cfg. nodes_lt.py only takes the cheap
     * single-CFG path when the two are close; differ, and every one of the 11
     * steps costs two forward passes instead of one. */
    videoCfg: 1.0,
    audioCfg: 1.0,
    negative: "pc game, console game, video game, cartoon, childish, ugly",

    seconds: 5,
    fps: 24,
    // LTX renders at HALF and doubles. These are the FINAL sizes; the graph
    // halves them, and both axes must survive //32 flooring or the upscale
    // lands somewhere the user did not ask for.
    width: 1280,
    height: 704,
    frameRule: "fpsPlus1",
    sizes: [
      /* Times are MEASURED on this rig for a 2-second clip, warm, 2026-08-27 —
       * not modelled. The cost curve was fitted from one anchor point and these
       * four disagree with it in both directions, so the labels quote the
       * stopwatch and the curve is left to do the queue arithmetic.
       *
       * 4K is real and it holds: same seed at 3840x2112 resolves individual
       * railing balusters where 1280x704 has a suggestion of a railing, with no
       * repetition or smearing despite being far outside the training size. An
       * upscaler cannot recover that — it invents something plausible instead. */
      { w: 1280, h: 704, label: "1280 x 704 · widescreen — native" },
      { w: 1600, h: 896, label: "1600 x 896 · large" },
      { w: 1920, h: 1088, label: "1920 x 1088 · 1080p — ~75 s per 2 s" },
      { w: 2560, h: 1408, label: "2560 x 1408 · 1440p — ~3.5 min per 2 s" },
      { w: 3840, h: 2112, label: "3840 x 2112 · 4K — ~6 min per 2 s" },
      { w: 704, h: 1280, label: "704 x 1280 · vertical" },
      { w: 1088, h: 1920, label: "1088 x 1920 · 1080p vertical" },
      /* 512, not 544. LTX floors each axis to the 32px latent grid at HALF size
       * and doubles back, so the real output is floor(n/64)*64 — this entry
       * promised 544 and produced 512, silently, directly beneath the comment
       * warning that both axes must survive the flooring. videoSizeFor() is now
       * the one place that arithmetic lives. */
      { w: 960, h: 512, label: "960 x 512 · fast" },
    ],

    /* Cost model, anchored on ONE measured point: 1280x704 x 121 frames = 121 s.
     * Deliberately marked as thin evidence — H3's curve took four points and this
     * has one, so the exponent is borrowed rather than fitted. Re-anchor once
     * there are more renders. */
    costFixedSeconds: 20,
    costRate: 0.31,
    costExponent: 1.2,

    // LTX renders real audio and a standalone clip has nothing underneath it.
    dropAudio: false,
    },

    },
  },

  /**
   * Images and automatic covers follow the disk when nobody chose: the
   * recommended picture model that is on this PC (server/fit.js defaultFor,
   * applied by index.js and never written into settings.json). "qwen-image-2.1"
   * below is only the last resort. A saved cover engine always wins. Qwen's
   * native INT8 files and compatible runtime must be ready when it is chosen;
   * nothing here downloads them. Its graph owns its sampling defaults.
   *
   * The FLUX.2 klein settings below are what a FLUX cover renders with.
   *
   * Chosen over Z-Image-Turbo and Krea-2-Turbo on three counts: it is the
   * smallest DiT of the three (4.07 GB official fp8), it is Apache-2.0 with no
   * content-filtering obligation attached, and ComfyUI 0.33 supports it natively
   * (`class Flux2`, supported_models.py:795) so no custom node is needed.
   *
   * 🔑 DISTILLED means cfg 1 and 4 steps. That is not a speed compromise — the
   * distillation IS the removal of classifier-free guidance, so raising cfg above
   * 1 does not "improve" anything, it drives the model off-distribution. The
   * undistilled base variant is the one that wants cfg 5 / 20 steps.
   *
   * The text encoder is shared with Z-Image-Turbo (both use Qwen3-4B), so adding
   * Z-Image later as an alternate look costs only its 5 GB DiT, not another
   * encoder.
   *
   * ⚠ fp16 encoder chosen deliberately. The 3.85 GB `qwen_3_4b_fp4_flux2` variant
   * is half the size but fp4 has native tensor-core support only on Blackwell
   * (RTX 50-series); this is an Ada card (sm_89), where it would be dequantised on
   * load. A shipped installer should pick precision from GPU ARCHITECTURE, not
   * just VRAM size.
   */
  // Standalone requests can pick an engine per image. Automatic covers use
  // art.engine, with an existing saved preference applied below.
  image: { engine: "qwen-image-2.1" },
  art: {
    enabled: true,
    /* Which engine paints COVERS (song thumbnails). The Images screen picks
     * per-picture; this is the library-wide default. "checkpoint" uses
     * `checkpoint` below — any file in ComfyUI/models/checkpoints. */
    engine: "qwen-image-2.1",
    checkpoint: null,
    quality: "default",   // ideogram covers: default 20 steps / quality 48
    dit: "flux-2-klein-4b-fp8.safetensors",
    textEncoder: "qwen_3_4b.safetensors",
    vae: "flux2-vae.safetensors",
    steps: 4,
    cfg: 1,          // see above — 1 is correct for the distilled model
    size: 1024,      // klein's native training resolution
    // What the library list actually loads. The full 1024² is kept for the song
    // panel and the full-screen player, where it is one image rather than fifty.
    thumbSize: 256,
    sampler: "euler",
    /**
     * FIXED look, varying subject. Measured, not guessed — three drafts were
     * rendered across abstract and concrete genres before this one.
     *
     * Fifty covers generated freely per song clash with each other and turn the
     * library into noise, which is precisely what the deterministic gradients
     * already avoid. So the style half never changes; only the subject, drawn
     * from the song's own caption, does.
     *
     * 🔑 TWO failures this wording exists to avoid — do not "tidy" them back in:
     *
     *  1. NEVER say "album cover". That phrase summons the album-cover
     *     CONVENTION, which includes a title, and the model renders garbled
     *     lettering across the top ("DEPMESIIN HOD JISLARK"). Framing it as a
     *     photograph removes the text problem at the source. The explicit
     *     no-text clause is belt-and-braces on top.
     *  2. NEVER stack "minimalist" + "restrained palette" + "generous negative
     *     space" together. Those compound into literal emptiness: on an abstract
     *     caption like "dark synthwave, analog pads" the first draft returned a
     *     black frame with a grey corner and no subject at all. Genre words are
     *     not visual nouns, so the prompt has to DEMAND a tangible object.
     */
    style: "fine art photograph, one tangible object as the subject, tight crop, "
         + "strong directional light, deep shadow, restrained colour palette, "
         + "subtle film grain, no text, no words, no letters, no signage",
  },
  artStyleDefault: "fine art photograph, one tangible object as the subject, tight crop, "
    + "strong directional light, deep shadow, restrained colour palette, "
    + "subtle film grain, no text, no words, no letters, no signage",

  /**
   * API mode — a hosted engine instead of a local GPU.
   *
   * OFF by default and it must stay that way. Studio's whole pitch is that
   * nothing leaves the building and nothing costs per song; switching that on
   * silently because a GPU looked small would be the opposite of the promise.
   * It is a toggle the user throws, having read what it costs.
   */
  /**
   * LoRA training on Music 3 — MEASURED 2026-08-19, and it works.
   *
   * Blocked until now for one reason: there was no way to get real audio into
   * the model's latent space, so there was nothing to train ON. The DAV encoder
   * removed that, and ComfyUI's stock TrainLoraNode turns out to accept a
   * Music 3 model, a DAV flow latent and AR-derived conditioning unchanged.
   * Output is a genuine 528-tensor adapter over to_qkv / to_out /
   * preprocess_conv, and LoraLoaderModelOnly loads it into a normal render.
   *
   * 🔑 THE SETTING THAT MAKES IT POSSIBLE ON 16 GB: checkpoint_depth 5 with
   * offloading. At the default depth of 1 even a FIFTEEN-SECOND window runs out
   * of memory; at depth 5 a full 60-second song trains at ~12 s/step. Sequence
   * length is the binding constraint, not model size — which is not obvious and
   * makes this look impossible on a consumer card if you never change it.
   * Train against the fp16 DiT; the int8 build that ships is not the target.
   *
   * MEASURED, 150 steps at rank 16 on ONE matched 60 s pair:
   *     metric        moved      floor    verdict
   *     mel_l1        +0.019     0.184    inside the noise
   *     centroid    +590.1 Hz   57.8 Hz   REAL — 10.2x the floor
   *     rms_db        +0.501     0.509    inside the noise
   * Brightness went 776 Hz off target to 186 Hz off and did NOT overshoot,
   * which is what undertrained-but-correct looks like rather than a model being
   * dulled. So the loop learns; 150 steps on one example is simply too few.
   *
   * 🔴 THE STRUCTURAL LIMIT, and it is not a step count.
   * MiniMaxMusic3TextEncode RUNS the autoregressive stage — its conditioning
   * carries one specific composed performance. For an outside recording there is
   * no way to produce matching conditioning; that needs the audio→RVQ tokenizer
   * that was never released. So training on real outside audio necessarily pairs
   * conditioning for performance A with the acoustics of performance B. Whether
   * that mismatch teaches style or teaches noise is untested and is the next
   * experiment. See scripts/lora_selftest.mjs and scripts/lora_score.py.
   */
  loraTraining: {
    dit: "minimax_music3_dit_fp16.safetensors",
    checkpointDepth: 5,
    offloading: true,
    secondsPerStep: 12,
  },

  /* Custom ComfyUI graphs standing in for built-in ones, by kind.
   * `{ cover: "my-graph", video: null }`. Empty by default — the built-ins are
   * the tuned ones, and this is for people who already have a graph they
   * prefer. See server/customWorkflows.js. */
  customWorkflows: saved.customWorkflows || {},

  /* Off unless the person turned it on. Read back from settings.json, where
   * POST /api/apimode writes it: before this the switch and the cap were saved
   * and then ignored at every start, so API mode switched itself OFF on each
   * restart and a raised or lowered cap quietly reverted to $20. */
  api: {
    enabled: saved.api?.enabled === true,
    provider: typeof saved.api?.provider === "string" ? saved.api.provider : "fal", // see server/apiEngine.js PROVIDERS
    /* A HARD monthly ceiling, checked immediately before each call rather than
     * only when a batch is queued. Overnight is the feature most worth having
     * and the one most able to run up a bill unattended: twenty ideas at three
     * takes of three minutes is roughly twenty dollars. A default of $20 means
     * an accident costs a takeaway, not a holiday. */
    monthlyCapUsd: Number.isFinite(saved.api?.monthlyCapUsd) ? Math.min(Math.max(saved.api.monthlyCapUsd, 0), 1000) : 20,
    timeoutMs: 10 * 60_000,
  },

  // Community is advertising, not the draw (HANDOVER §1). One anonymous, cached,
  // versioned endpoint; everything else links out to the browser where the user
  // is already signed in.
  community: {
    /**
     * ⚠ Must stay a PUBLIC host. This repository is public, so whatever is
     * written here is what every stranger's install will call on startup.
     * It was briefly pointed at the dev box while the endpoint was only live
     * there — fine on one machine, an unpaid DDoS once the software ships, and
     * the same box serves production.
     *
     * The endpoint is live on dev (endpoints/desktop/feed_GET.ts) and not yet on
     * prod, so this 404s for now and the Community page degrades to its "not
     * reachable" state, which is the correct thing for it to do anyway — a user
     * offline, behind a firewall or on an old build hits the identical path.
     * Point a local install at dev with AIPLAY_FEED, which is per-machine.
     */
    feedUrl: process.env.AIPLAY_FEED || "https://aiplay.live/_api/desktop/feed",
    /* The public blog. Unlike the desktop feed this one EXISTS on production
     * today, which is why the Community tab has anything to show at all. */
    blogUrl: process.env.AIPLAY_BLOG || "https://aiplay.live/_api/blog/articles",
    /**
     * ⚠ DERIVED from feedUrl, never written out by hand.
     *
     * These were hardcoded to `https://aiplay.live` while the feed pointed at
     * dev, so every Join button sent the user to the PRODUCTION site to open a
     * session id that only exists on dev — a guaranteed 404. Tying both to the
     * feed's own origin means the two can never disagree again: point the feed
     * at prod and the links follow.
     *
     * The feed itself also emits `/session/<id>` (singular), which is not a real
     * route — it is `/sessions/<id>`. That is a bug in the dev endpoint
     * (app/endpoints/desktop/feed_GET.ts); until it is fixed there, the proxy in
     * index.js rewrites it.
     */
    get site() { return new URL(this.feedUrl).origin; },
    get sessions() { return `${new URL(this.feedUrl).origin}/sessions`; },
    refreshMs: 120_000,
  },

  /**
   * Provenance (SPEC.md D2/D5). Two user toggles and DELIBERATELY not a third:
   *
   *   showBadges  — display only. Hides the badges/panels; never touches
   *                 capture or embedding.
   *   embedRecord — Tier 2, the detailed record in exported files (prompts,
   *                 seeds, lyrics, edit history, ledger summary). The record
   *                 is the user's; off keeps it on this machine.
   *
   * There is NO toggle for the Tier-1 AI marker and none may be added: the
   * model licences require machine-generated content to be disclosed, and EU
   * AI Act Article 50(2) puts the marking duty on the tool's provider — the
   * studio marks so its users never have to think about it. A settings note
   * explains this in the UI. Capture (the ledger itself) is also not a
   * toggle: a gap in the user's own record only ever costs the user.
   */
  provenance: {
    showBadges: true,
    embedRecord: true,
  },

  /* Battery Safe (server/power.js). On by default: when a generation runs on
   * battery (a laptop unplugged, a desktop whose UPS took over) it is stopped
   * after `graceMinutes` unless the person says to keep going. */
  power: {
    batterySafe: true,
    graceMinutes: 5,
  },

  paths: { appData: APPDATA },
};

/* H3'S DEFAULT STEP COUNT, AND THE THREE QUALITY CHIPS, FOLLOW THE DISK.
 *
 * An 8-step default is right only where the 8-step turbo files are on disk.
 * The Models screen fetches the fl2v 4-step 768p (its "video" row) and the
 * ref2v 4-step v0.1 ("videoRefs") and no 8-step file, so on a machine set up
 * from that screen `turboLora` and `refTurboLora` fall back to 4-step files.
 * A literal 8 there ran a 4-step distillation at 8 steps on every render that
 * named no step count, the move the turboLora4 comment calls "a different one
 * used wrongly". So each number is what this disk can run matched:
 *
 *   standard  8 where pick() resolved BOTH turboLora and refTurboLora to an
 *             8-step file, else 4, the matched 4-step setting. Never the
 *             bare model by default: 20 costs 2.4x the time (arm H vs C).
 *   fast      3 where a TaoMate 3-step file resolved, else 4 where both
 *             4-step slots did, else the same as standard (one chip then,
 *             not two that do the same thing).
 *   best      20, the bare model, which no LoRA file gates.
 *
 * `steps` is standard. /api/status sends stepDefaults and turboBuilds, and
 * the Video screen's slider and chips and make_clip's `quality` read them
 * there rather than keeping a literal. Resolved once, at import, like pick()
 * itself: a file downloaded later loads after a restart, and so does the
 * default that matches it. A file's step count is read off its name
 * (loraStepsOf), and only for a file that is on disk, because pick() returns
 * its last name when none is.
 * server/mcp-steer_test.js builds both disks in a temp folder and pins this. */
/* With no speed-up on disk at all, Standard is the bare model's 20: every
 * speed-up is optional (models.js, addonFor "video"), and a step count whose
 * file is missing is refused with its download offered (video-plain.js). */
function resolveH3Steps(h3) {
  const stepsOnDisk = (name) => (onDisk("loras", name) ? loraStepsOf(name) : null);
  const eight = stepsOnDisk(h3.turboLora) === 8 && stepsOnDisk(h3.refTurboLora) === 8;
  const four = stepsOnDisk(h3.turboLora4) === 4 && stepsOnDisk(h3.refTurboLora4) === 4;
  const three = stepsOnDisk(h3.turboLora3) === 3;
  const standard = eight ? 8 : four ? 4 : 20;
  h3.turboBuilds = { three, four, eight };
  h3.stepDefaults = { fast: three ? 3 : four ? 4 : standard, standard, best: 20 };
  /* The step count of the REFERENCE speed-up file on this disk (8, 4, or null
   * when none is), for a music-video scene with cast pictures: its matched
   * default is this file's count, which can be 8 where standard is 4
   * (server/mv/clipsteps.js defaultClipSteps). */
  h3.refTurboSteps = stepsOnDisk(h3.refTurboLora);
  return standard;
}
config.video.engines.h3.steps = resolveH3Steps(config.video.engines.h3);

/** Look for H3's speed-ups again, after one lands (server/index.js, the
 *  downloader's "ready" for a row with addonFor "video"), so its step counts
 *  work without a restart: every slot is picked again from its own list, and
 *  the builds and step defaults follow. The step count in use moves only
 *  while it is still the machine's default (Standard), never a person's.
 *  Returns turboBuilds. */
export function refreshH3Speedups() {
  const h3 = config.video.engines.h3;
  const before = h3.stepDefaults?.standard;
  for (const [slot, names] of Object.entries(H3_LORA_SLOTS)) h3[slot] = pick("loras", ...names);
  const standard = resolveH3Steps(h3);
  if (h3.steps === before) h3.steps = standard;
  return h3.turboBuilds;
}
/** The 3-step slot alone; kept for its callers. */
export const refreshTaoMate = () => refreshH3Speedups().three;

/* THE CARD TIERS' SIZES in H3's list, from server/h3tier.js (the one source),
 * each labelled with the card it was measured for. Added before FastH3 copies
 * H3's settings, so both list them. A size already listed is not repeated. */
{
  const h3 = config.video.engines.h3;
  for (const t of H3_TIERS) {
    if (!t.width || h3.sizes.some((z) => z.w === t.width && z.h === t.height)) continue;
    h3.sizes.push({ w: t.width, h: t.height,
      label: `${t.width} x ${t.height} · ${t.label.toLowerCase()} for ${t.minGb} GB cards${t.experimental ? ", experimental" : ""}` });
  }
}

/* 720P FIRST OFF NVIDIA (the owner's call, 2026-09-25): on an AMD or Intel
 * card, or no card, H3 (and FastH3, which copies this below) starts at
 * 1280x720 and lists it first, ahead of the 1344x768 it was trained at. 720
 * is not on H3's 32 px grid; the model pads the latent to its 2x2 patch and
 * crops the output back (comfy/ldm/minimax/model.py _forward), so it renders
 * at exactly 1280x720. `nativeWidth`/`nativeHeight` keep the trained size
 * for anything that measures against it. LTX already starts at 1280x704. A
 * smaller card's tier (h3tier.js) still starts at its own measured size. */
{
  const h3 = config.video.engines.h3;
  h3.nativeWidth = h3.width;
  h3.nativeHeight = h3.height;
  if (PREFER_720P) {
    h3.width = 1280;
    h3.height = 720;
    const i = h3.sizes.findIndex((z) => z.w === 1280 && z.h === 720);
    if (i > 0) h3.sizes.unshift(...h3.sizes.splice(i, 1));
  }
}

/* ── FastH3 ──────────────────────────────────────────────────────────────
 * FastVideo's DMD2 distillation of MiniMax H3 (FastVideo/FastVideo-FastH3-Comfy):
 * eight steps with no turbo LoRA, the same text encoder and VAEs as H3, and
 * trained against VSA sparse attention. Built on H3's settings so sizes, frame
 * rule and soundtrack behave the same; everything below is what differs,
 * copied from ComfyUI's own video_fastvideo_fasth3 templates.
 *
 * No references: FastH3 distilled t2va and fl2va only, so the route and the
 * Video screen keep references to H3 exactly as they do for LTX. */
config.video.engines.fasth3 = {
  ...config.video.engines.h3,
  label: "FastH3",
  dit: pick("diffusion_models",
    "fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors",
    "fastvideo_fasth3_8step_v2_pruned_bf16.safetensors",
    "fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors"),
  ditRef: null,
  // A distillation already: none of H3's turbo LoRAs load on top of it.
  turboLora: null, turboLora4: null, turboLora3: null, refTurboLora: null, refTurboLora4: null,
  refTurboSteps: null,
  turboMaxSteps: 0, turbo4MaxSteps: 0, turbo3MaxSteps: 0, turboShiftByLora: {},
  bridge: "off",
  // The trained schedule: 8 steps, res_multistep, video shift 10 (not H3's 12).
  steps: 8, fixedSteps: 8,
  /* The H3 step-defaults block above ran before this spread, so H3's chips and
   * turbo builds would travel with it. A fixed schedule has neither. */
  stepDefaults: null, turboBuilds: null,
  sampler: "res_multistep", scheduler: "simple",
  shiftVideo: 10, shiftAudio: 3,
  /* The checkpoint was trained with FastVideo's VSA at 10% of video cubes.
   * ComfyUI's BlockSparseAttention runs dense wherever its kernel is missing,
   * so a card without one still renders, only without the speed-up. */
  sparseAttention: { method: "vsa", keepPercent: 10, startPercent: 0.2, endPercent: 1,
    minTokens: 12288, extraTokens: 256, sinkConditioning: "exact_kv_and_rows" },
  /* H3's sol-attn switch is H3's: FastH3 always runs its own VSA above. */
  sparse: null, solAttn: null,
  /* FastH3 always runs BlockSparseAttention (VSA), which the block cache refuses. */
  blockCache: false, blockCacheRecipe: null,
  /* NOT IN THE MAIN ENGINE LIST (the H3 lab, 2026-09-24): slower than the Fast
   * setting in every pair (1.37x the wall at 1344x768, 8 s; 1.22x at 960x544)
   * and good on one prompt of three (a white blob on one, colour changes on
   * another). The Video screen offers it under Advanced with this label and
   * note, text to video only; a saved FastH3 choice keeps rendering on it. */
  advanced: { label: H3_MORE_MOTION.label, note: H3_MORE_MOTION.note },
  /* The dense attention it falls back to. "kitchen" (Comfy Kitchen's INT8
   * attention, the template's choice and the one the H3 lab timed FastH3 with)
   * by default; "pytorch" on request, per render, on the Video screen. The pick
   * is written into the graph as node 85 either way (art.js videoAttention()),
   * so the launcher's own Attention setting cannot overrule it; where the
   * engine does not offer Kitchen, the node says PyTorch. It was "pytorch"
   * until the lab: the default a person got was a speed nobody had measured. */
  attention: "kitchen",
};

/**
 * The settings that survive a restart.
 *
 * ⚠ Until now, almost none of them did. `settings.json` held the folders, the
 * API mode and the custom-workflow assignments — and nothing else. So switching
 * video on, choosing an engine, asking for stems, picking an output format or
 * turning cover art off was remembered for exactly as long as the process
 * lived. The symptom is a switch that "will not stay on", and it is impossible
 * to tell from the inside of one session.
 *
 * An ALLOW-LIST, not a deep merge, and that is the important part: this object
 * also carries measured constants — sigma schedules, model filenames, cost
 * curves, the fp32 VAE rule — and a stale or hand-edited settings file must
 * never be able to reach any of them.
 *
 * Each entry also declares what a legal value looks like, because a file on
 * disk is untrusted input: a saved `engine` naming a model that no longer
 * exists would otherwise be accepted at boot and fail much later, somewhere
 * that cannot explain itself.
 */
const OK_WHEN = (v) => ["off", "all", "starred", "liked"].includes(v);
/* An interpreter path from settings.json: absolute on THIS platform, one line.
 * Existence is checked where it is set (POST /api/lyrics) and where it is run
 * (server/lrc.js), not here: a python on an unplugged drive is still the one the
 * person chose, and dropping it at boot would silently put the default back. */
const OK_PYTHON_PATH = (v) => v === null
  || (typeof v === "string" && v.length > 0 && v.length <= 1024 && !/[\r\n\0]/.test(v) && path.isAbsolute(v));
/* The whisper models Studio offers (config.lyrics.model, POST /api/whisper
 * {action:"model"}). Every one is a name faster-whisper's own table resolves
 * to a converted checkpoint on huggingface.co (its utils.py _MODELS, which
 * has had "large-v3-turbo" since 1.1), fetched on first use into its cache.
 * large-v3 stays the default: it is the one measured on sung vocals. */
export const WHISPER_MODELS = ["large-v3", "large-v3-turbo", "medium", "small", "base", "tiny"];
config.music.engines["yue2-gguf"] = {
  label: "YuE2 GGUF · Q4 / Q8 · sellable by individuals",
  runtime: "audiocpp", capability: "musicYue2Gguf",
  audioReference: false, sectionTags: true, instrumentalToggle: false,
  score: false, warmCache: false, emergentLength: true,
  cot: ["full", "melody", "off"], renderPath: true, durationLadder: false,
  experimental: true,
  note: "Native Q4 (default, smaller) or optional Q8 (higher precision), both with F16 VAE. Choose and install weights in Models. No Python or ComfyUI required. Higher precision is not a guarantee of better audio. Licence file CC BY-NC 4.0; the authors say individuals may sell what it makes and companies need a commercial licence; attribution required. Duration is not guaranteed.",
};
/* THE LEVEL EVERY MAKE SCREEN OPENS ON (UI_PLAN E1, the owner's decision of
 * 2026-09-24): a NEW install opens Music, Pictures and Video on Simple; an
 * install that was already in use, the owner's included, keeps Advanced.
 *
 * "Already in use" is not "settings.json exists": the launcher and the engine
 * installer write that file (rig, python, gpu) before Studio's first start, so
 * on a fresh install it is always there. What only a Studio that has RUN
 * writes is IN_USE_KEYS below: prefs, the welcome flag, the API mode, the
 * Agent page's keys, a saved workflow, a chosen writing model, a model
 * override, the DAW's latency. (modelsDir, modelsAlso, outputDir and rig are
 * not in it: the launcher writes those too.) Songs already made are the other
 * sign, and level.js reads the library for them before saving Simple.
 * `levelBy` says who chose, so Settings can say "Studio chose Simple for a new
 * install" rather than pretending the person did.
 *
 * A FILE THAT IS THERE AND CANNOT BE READ is not a new install: it is an
 * install whose file has a trailing comma or a byte-order mark. It keeps
 * Advanced, and nothing is written over it (`unreadable`), so fixing the comma
 * brings every setting back as it was.
 * server/welcome/level.js saves the answer on the first start and on every
 * change; server/welcome/level_test.js walks every kind of install. */
export const LEVELS = ["simple", "advanced"];
export const IN_USE_KEYS = ["prefs", "welcome", "api", "llm", "customWorkflows",
  "chatModel", "chatModelMusic", "enhanceModel", "modelOverrides", "dawLatency"];
export function startLevel(settings, { unreadable = null } = {}) {
  if (unreadable) return { level: "advanced", levelBy: "studio", saved: false, unreadable: String(unreadable) };
  const s = settings || {};
  const want = s.prefs?.ui?.level;
  if (LEVELS.includes(want)) return { level: want, levelBy: s.prefs.ui.levelBy === "studio" ? "studio" : "you", saved: true };
  const used = IN_USE_KEYS.some((k) => s[k] !== undefined && s[k] !== null);
  return { level: used ? "advanced" : "simple", levelBy: "studio", saved: false };
}
config.ui = startLevel(saved, { unreadable: settingsUnreadable });
export const PREF_PATHS = [
  ["ui", "level", (v) => LEVELS.includes(v)],
  ["ui", "levelBy", (v) => v === "studio" || v === "you"],
  ["video", "enabled", (v) => typeof v === "boolean"],
  ["video", "engine", (v) => Object.prototype.hasOwnProperty.call(config.video.engines, v)],
  ["video", "when", OK_WHEN],
  /* Validated against the MAP, not a hand-typed list, so a new engine is
   * accepted and a removed engine's saved name is rejected without anyone
   * remembering to edit this line. Same shape as video.engine above. */
  ["music", "engine", (v) => Object.prototype.hasOwnProperty.call(config.music.engines, v)],
  ["music", "precision", (v) => ["int8", "fp16", "fp32"].includes(v)],
  ["music", "yue2Checkpoint", (v) => v === null || (typeof v === "string" && /^[^\\/:*?"<>|]+\.(safetensors|sft)$/i.test(v))],
  ["music", "yue2Lora", (v) => v === null || (typeof v === "string" && /^[^\\/:*?"<>|]+\.safetensors$/i.test(v))],
  ["music", "yue2LoraStrength", (v) => Number.isFinite(v) && v >= -4 && v <= 4],
  ["music", "yue2LoraClip", (v) => v === null || (typeof v === "string" && /^[^\\/:*?"<>|]+\.safetensors$/i.test(v))],
  ["music", "yue2LoraClipStrength", (v) => Number.isFinite(v) && v >= -4 && v <= 4],
  ["music", "aceModel", (v) => v === null || (typeof v === "string" && /^[^\\/:*?"<>|]+\.(safetensors|sft)$/i.test(v))],
  ["music", "aceLm", (v) => v === null || (typeof v === "string" && /^[^\\/:*?"<>|]+\.safetensors$/i.test(v))],
  ["music", "aceLora", (v) => v === null || (typeof v === "string" && /^[^\\/:*?"<>|]+\.safetensors$/i.test(v))],
  ["music", "aceLoraStrength", (v) => Number.isFinite(v) && v >= -4 && v <= 4],
  ["stems", "when", OK_WHEN],
  ["stems", "model", (v) => typeof v === "string" && /^[\w.-]+$/.test(v)],
  ["stems", "twoStems", (v) => typeof v === "boolean"],
  ["stems", "systemPython", OK_PYTHON_PATH],
  ["stems", "device", (v) => v === null || v === "cpu"],
  ["stems", "devicePython", OK_PYTHON_PATH],
  ["lyrics", "when", OK_WHEN],
  ["lyrics", "whisperPython", OK_PYTHON_PATH],
  ["lyrics", "model", (v) => WHISPER_MODELS.includes(v)],
  ["output", "format", (v) => ["flac", "mp3", "opus"].includes(v)],
  ["output", "mp3Quality", (v) => ["V0", "128k", "320k"].includes(v)],
  ["output", "opusQuality", (v) => ["64k", "96k", "128k", "192k", "320k"].includes(v)],
  ["art", "enabled", (v) => typeof v === "boolean"],
  /* ⚠ THIS LIST IS READ BY A TEST, not only by the loader. provenance_test.js
   * parses this exact literal and requires every name in it to resolve through
   * MODEL_TO_CAPABILITY — an engine added here without a line in models.js
   * would stamp every render `unknown` and look perfectly fine. Add both, or
   * the hook fails. */
  ["art", "engine", (v) => ["flux2", "zimage", "zimage-base", "anima", "ideogram4", "krea2", "qwen-image-2.1", "checkpoint"].includes(v)],
  ["art", "checkpoint", (v) => v === null || (typeof v === "string" && /^[\w .()-]+\.(safetensors|ckpt)$/i.test(v))],
  /* The Images screen's engine, and a picture with none named (make_image, a
   * music video's stills). The covers' list above, read at call time rather
   * than retyped; minus "checkpoint", which needs a file picked per picture. */
  ["image", "engine", (v) => v !== "checkpoint" && PREF_PATHS.find(([g, k]) => g === "art" && k === "engine")[2](v)],
  ["art", "quality", (v) => ["default", "quality"].includes(v)],
  ["art", "style", (v) => typeof v === "string" && v.length > 0 && v.length <= 1500],
  ["enhance", "when", (v) => ["off", "all"].includes(v)],
  ["enhance", "mode", (v) => ["smooth", "slowmo", "bigger", "both"].includes(v)],
  // Provenance: display and the Tier-2 record only. The Tier-1 AI marker has
  // no preference path ON PURPOSE — see the config block above.
  ["provenance", "showBadges", (v) => typeof v === "boolean"],
  ["provenance", "embedRecord", (v) => typeof v === "boolean"],
  ["power", "batterySafe", (v) => typeof v === "boolean"],
  ["power", "graceMinutes", (v) => Number.isInteger(v) && v >= 1 && v <= 60],
];

/**
 * DEFAULTS THAT FOLLOW THE DISK: who chose each of these values.
 *
 * The literals in `config` above (music "minimax-music3", pictures and covers
 * "qwen-image-2.1") aimed a fresh install at models it never downloaded. When
 * nobody has chosen, server/fit.js defaultFor() works out what is on this PC
 * and index.js applies it here WITHOUT marking it chosen, so prefsSnapshot()
 * never writes it into settings.json and the next start works it out again.
 * Any ordinary assignment (a route, a saved file, a test) is a choice and is
 * marked as one, so a new route that sets the value is remembered without
 * having to know this exists. The literals stay as the last resort.
 *
 * Three origins: "you" (chosen, or read from a settings file this Studio
 * wrote), "kept" (read from a settings file an OLDER Studio wrote, which saved
 * every value whether or not anybody chose it: it wins like a choice, and is
 * worded "Saved in your settings" rather than "You chose"), and none (the
 * machine's). `keptFromBefore` in settings.json carries "kept" across starts
 * and marks a file as this Studio's.
 */
const MACHINE_KEYS = [["music", "engine"], ["music", "yue2Checkpoint"], ["art", "engine"], ["image", "engine"]];
export const LITERAL_DEFAULTS = Object.fromEntries(["music", "art", "image"].map((g) => [g,
  Object.fromEntries(MACHINE_KEYS.filter(([mg]) => mg === g).map(([, k]) => [k, config[g][k]]))]));
const origin = new Map();         // id -> "you" | "kept"
const machineValue = new Map();   // id -> the live value
const sessionSaved = new Map();   // id -> { saved, reason }: a saved choice this launch does not run
for (const [group, key] of MACHINE_KEYS) {
  const id = `${group}.${key}`;
  machineValue.set(id, config[group][key]);
  Object.defineProperty(config[group], key, {
    enumerable: true, configurable: true,
    get: () => machineValue.get(id),
    /* A saved null checkpoint is "no choice", not a choice of nothing. */
    set: (v) => {
      machineValue.set(id, v);
      sessionSaved.delete(id);
      if (v !== null) origin.set(id, "you"); else origin.delete(id);
    },
  });
}
/** Whether a person (or a saved file) chose this value, rather than the machine. */
export function prefChosen(group, key) { return origin.has(`${group}.${key}`); }
/** "you", "kept" (an older Studio saved it on its own) or null (the machine's). */
export function prefOrigin(group, key) { return origin.get(`${group}.${key}`) || null; }
/** Put the machine's pick in place without marking it chosen. Ignored once chosen. */
export function applyMachineDefault(group, key, value) {
  const id = `${group}.${key}`;
  if (!machineValue.has(id) || origin.has(id)) return false;
  machineValue.set(id, value);
  return true;
}
/**
 * THIS LAUNCH RUNS SOMETHING ELSE, AND NOTHING IS SAVED. A startup that cannot
 * run a saved choice (the music-only launch runs YuE2 only; a saved native
 * GGUF that is not installed) swaps the live value for this session: the saved
 * one stays in settings.json, is reported beside the one running (`reason`),
 * and is back the next time it can run. Unchosen, it is the machine's pick.
 */
export function overrideForSession(group, key, value, reason = null) {
  const id = `${group}.${key}`;
  if (!machineValue.has(id)) return false;
  if (!origin.has(id)) { machineValue.set(id, value); return true; }
  /* A second swap keeps what was SAVED, and the newer, fuller reason. */
  const prev = sessionSaved.get(id);
  sessionSaved.set(id, { saved: prev ? prev.saved : machineValue.get(id), reason: reason ?? prev?.reason ?? null });
  machineValue.set(id, value);
  return true;
}
/** The saved value this session is not running, and why; null when it runs what is saved. */
export function sessionOverride(group, key) {
  const s = sessionSaved.get(`${group}.${key}`);
  return s ? { saved: s.saved, reason: s.reason, value: machineValue.get(`${group}.${key}`) } : null;
}
/** Forget a choice, so the machine decides again ("auto", Let Studio pick). */
export function forgetPref(group, key) {
  const id = `${group}.${key}`;
  origin.delete(id);
  sessionSaved.delete(id);
}

/** Just the preference fields, ready to be merged into settings.json. A value
 *  the machine picked is left out: it is worked out again on the next start.
 *  A session's swap is not saved either: the saved value is written back. */
export function prefsSnapshot() {
  const out = { tier: config.tier };
  for (const [group, key] of PREF_PATHS) {
    const id = `${group}.${key}`;
    if (machineValue.has(id) && !origin.has(id)) continue;
    (out[group] ||= {})[key] = sessionSaved.has(id) ? sessionSaved.get(id).saved : config[group][key];
  }
  out.keptFromBefore = [...origin].filter(([, o]) => o === "kept").map(([id]) => id);
  return out;
}

/* Apply what was saved last time. Anything that fails its own check is dropped
 * with a warning rather than throwing — a bad settings file must not be able to
 * stop the app from starting, which is the one outcome nobody can recover from
 * without a text editor. */
for (const [group, key, ok] of PREF_PATHS) {
  const v = saved.prefs?.[group]?.[key];
  if (v === undefined) continue;
  if (ok(v)) config[group][key] = v;
  else console.warn(`  [settings] ignoring saved ${group}.${key}: ${JSON.stringify(v)}`);
}
/* SETTINGS AN OLDER STUDIO WROTE. Before defaults followed the disk, the first
 * save wrote every preference, chosen or not, so a value in such a file is
 * kept (it wins) but nobody can say it was chosen: "kept". The Images engine
 * was never saved at all; it was the literal, so an existing install keeps the
 * literal rather than moving to whatever the disk suggests (the owner's
 * pictures and music-video stills stay on Qwen Image 2.1). A file this Studio
 * wrote carries `keptFromBefore`, even empty, and says which are still kept. */
if (saved.prefs && typeof saved.prefs === "object") {
  if (!Array.isArray(saved.prefs.keptFromBefore)) {
    if (!origin.has("image.engine")) config.image.engine = LITERAL_DEFAULTS.image.engine;
    for (const [group, key] of MACHINE_KEYS) if (origin.has(`${group}.${key}`)) origin.set(`${group}.${key}`, "kept");
  } else {
    for (const id of saved.prefs.keptFromBefore) if (origin.has(id)) origin.set(id, "kept");
  }
}
/* The graphics-memory tier is a launch FLAG, so it is applied before the engine
 * starts rather than through setTier — which exists to change it afterwards and
 * restarts the process to do so. */
if (typeof saved.prefs?.tier === "string" && config.vramTiers[saved.prefs.tier]) {
  config.tier = saved.prefs.tier;
}
/* The whisper interpreter, now that a saved choice may have been read. */
config.lyrics.python = whisperPython();
/* The stem separation interpreter, likewise. */
config.systemPython = systemPython();
/* Music-only runs native YuE2 GGUF, or YuE2 through ComfyUI when this machine
 * has a ComfyUI install and a YuE2 checkpoint (decided at startup, index.js). */
/* A saved engine it cannot run is swapped for this session only (overrideForSession):
 * settings.json keeps the choice, and the full Studio runs it again. */
if (config.musicOnly && !["yue2-gguf", "yue2-comfy"].includes(config.music.engine)) {
  overrideForSession("music", "engine", "yue2-gguf", "The music-only launch runs YuE2 only");
}
