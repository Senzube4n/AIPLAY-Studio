/**
 * ONE-CLICK PYTHON ENVIRONMENTS — "Set up timed lyrics", and the recipes after it.
 *
 * WHY. Timed lyrics run lrc.py in their own interpreter (config.lyrics.python),
 * and nothing ever created one: a newcomer on Discord (Zoepie) needed Python
 * 3.11+ on PATH and three pasted commands, and on a PC without Python the
 * `python` they typed opened the Microsoft Store. 37ea42f made the failure say
 * so; this makes the fix one button.
 *
 * WHAT A JOB DOES, per recipe `{ id, python, torchIndex, packages, modules }`:
 *
 *   check     the python the feature runs in today already imports every module
 *             → nothing is installed (a no-op, said as one); Studio's own venv
 *             from an earlier run is complete → it is chosen, nothing rebuilt.
 *             Either is REPLACED instead when replaceWhy() says so: its PyTorch
 *             fails a real op on the card, it is the CPU build where a CUDA one
 *             is on offer, or the person chose another build
 *   uv        the KEPT uv (server/setup/uv.js): pinned, checksum-checked, at
 *             <app data>\tools\uv — no system Python anywhere in this
 *   python    `uv python install --no-bin --no-registry 3.12` into
 *             <app data>\venvs\<id>\python: no python3.12.exe in ~/.local/bin
 *             and no registry entry (server/setup/pins.js), so the Python
 *             exists only inside the folder a failed build deletes
 *   venv      `uv venv --seed` at <app data>\venvs\<id>\venv (pip seeded, so the
 *             install lines lrc.js prints still work by hand)
 *   torch     PyTorch from a CUDA index on an NVIDIA card (timed lyrics: 12.6,
 *             or 12.8 on an RTX 50; stems: 12.8 when the drive has room, 12.6
 *             on a card older than sm_70), the CPU index everywhere else —
 *             lrc.js's own TORCH_PIP, index swapped
 *   packages  the catalogue's line for the feature (lrc.js whisperPip())
 *   verify    the SAME modules probe the Models row and Settings run, then a
 *             real tensor op on the card (a CUDA build that imports can still
 *             have no kernels for the card: an RTX 50 under CUDA 12.6)
 *   save      only now: the interpreter is chosen through the same door as
 *             Settings > Songs > "timed lyrics python" / "stem separation python"
 *
 * Recipes: "lyrics" (timed lyrics) and "stems" (stem separation and the
 * audio-reference encoder, which share config.systemPython).
 *
 * The folder carries a marker (.aiplay-venv.json). Only a folder with it is
 * ever deleted: a failed build removes it, and keeps the download cache beside
 * it (<id>-cache), so trying again does not fetch PyTorch twice. A folder
 * there WITHOUT the marker is somebody else's and is refused, not reused.
 * Network shares and device paths are refused before anything is fetched.
 *
 * A job never blocks its request: run() answers within a second or two with
 * the job's state, and status() reports the step, the last lines of output and
 * the final sentence. Every dependency that touches the world (uv, the probe,
 * saving the setting, the drive-type read) is a parameter, so
 * server/setup_venv_test.js runs the whole thing with a fake uv.
 */
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rm, readdir, statfs } from "node:fs/promises";
import path from "node:path";
import { TORCH_PIP, whisperPip, mask, PIP_NAME } from "../lrc.js";
import { CATALOG, modulesOf } from "../models.js";
import { config } from "../config.js";
import { STEMS_MODULES, STEMS_SETUP_BUTTON, clearStemsPreflight, findFfmpeg } from "../music/stems.js";
import { ensureUv } from "./uv.js";
import { UV_PYTHON_INSTALL_ARGS, UV_PRIVATE_ENV } from "./pins.js";

const MARKER = ".aiplay-venv.json";
const GB = 1e9;

/* ─────────────────────────────────────────────────────────── the recipes */

/** "-m pip install a b --index-url X" → { packages: [a, b], indexUrl: X }. */
export function pipWords(line) {
  const toks = String(line || "").replace(/^(?:python3?\s+)?-m\s+pip\s+install\s+/, "").split(/\s+/).filter(Boolean);
  const packages = [];
  let indexUrl = null;
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] === "--index-url") { indexUrl = toks[++i] || null; continue; }
    if (!toks[i].startsWith("-")) packages.push(toks[i]);
  }
  return { packages, indexUrl };
}

/** The PyTorch builds a recipe can take, by the index's last path segment,
 *  with the words the page's "PyTorch build" choice shows.
 *
 *  cu128: an RTX 50 (Blackwell, sm_120) has no kernels in the CUDA 12.6
 *  builds, per PyTorch's published arch lists (not measured here); CUDA 12.8
 *  is the first index with them. It also needs a newer NVIDIA driver than 12.6
 *  does, which is why timed lyrics (measured on cu126) keep cu126 as their
 *  default on every card nvidia-smi does not report as sm_100 or newer, and
 *  prove the card with a tensor op either way. */
export const TORCH_BUILDS = {
  cu126: "CUDA 12.6, for an NVIDIA card",
  cu128: "CUDA 12.8, for an NVIDIA card (RTX 50 included)",
  cpu: "the CPU build",
};
const CUDA_WORDS = { cu126: "CUDA 12.6", cu128: "CUDA 12.8" };
const isCuda = (build) => build !== "cpu";

/**
 * A card's compute capability as one number: "sm_120", [12, 0], "12.0" and
 * 120 are all 120; anything else is null. probeTensor reports "sm_120";
 * mesh/runner.js cudaCapability() (nvidia-smi) reports [12, 0].
 */
export function smOf(c) {
  if (Array.isArray(c)) return c.length >= 2 && c.every((n) => Number.isInteger(n) && n >= 0) ? c[0] * 10 + c[1] : null;
  const m = /^(?:sm_)?(\d{1,3})(?:\.(\d))?$/.exec(String(c ?? "").trim());
  if (!m) return null;
  return m[2] !== undefined ? Number(m[1]) * 10 + Number(m[2]) : Number(m[1]);
}
/* Which CUDA build a card needs, by that number. From PyTorch's published arch
 * lists and release notes, not measured here: the CUDA 12.6 builds stop at
 * sm_90, so a Blackwell card (sm_100, sm_120: the RTX 50) needs 12.8; the 12.8
 * builds from PyTorch 2.8 on dropped Maxwell and Pascal (below sm_70), which
 * therefore keep 12.6. */
export const SM_NEEDS_CU128 = 100;
export const SM_OLDEST_CU128 = 70;

/** Why "auto" picked what it picked, in words a person can check. */
function autoReason(vendor) {
  const WORD = { amd: "AMD", intel: "Intel", apple: "Apple" };
  if (vendor === "nvidia") return "an NVIDIA card was read on this PC";
  if (vendor && vendor !== "cpu") return `this PC's card is ${WORD[vendor] || vendor}, and PyTorch's CUDA build needs NVIDIA`;
  return "no NVIDIA card was read on this PC";
}
/* The clause that says when the card's own number changed the build. */
const newCardWords = (sm) => `it is an RTX 50 or later, sm_${sm}, which PyTorch's CUDA 12.6 builds cannot run`;
const oldCardWords = (sm) => `it is an older card, sm_${sm}, which PyTorch's CUDA 12.8 builds no longer run`;
export const TORCH_CHOICES = ["auto", ...Object.keys(TORCH_BUILDS)];

/** lrc.js's CUDA index with its build swapped: .../whl/cu126 → .../whl/cpu. */
export const torchIndexUrl = (indexUrl, build) => String(indexUrl).replace(/\/[^/]+\/?$/, `/${build}`);

/**
 * Timed lyrics. Every string that names a package comes from where the rest of
 * Studio reads it (lrc.js, the catalogue), so a person who installs by hand
 * and one who presses the button get the same environment.
 * `torch` "auto" is cu126 on an NVIDIA card (cu128 on one whose `capability`
 * the 12.6 builds cannot run: an RTX 50) and the CPU build otherwise;
 * "cu126", "cu128" or "cpu" choose it.
 */
export function lyricsRecipe({ vendor = null, torch = "auto", capability = null } = {}) {
  const t = pipWords(TORCH_PIP);
  const cap = CATALOG.find((c) => c.id === "lyrics") || {};
  const sm = vendor === "nvidia" ? smOf(capability) : null;
  const newCard = sm !== null && sm >= SM_NEEDS_CU128;
  const torchIndex = TORCH_BUILDS[torch] ? torch : vendor === "nvidia" ? (newCard ? "cu128" : "cu126") : "cpu";
  const chosenBy = TORCH_BUILDS[torch] ? "you chose it"
    : newCard ? `${autoReason(vendor)}, and ${newCardWords(sm)}` : autoReason(vendor);
  return {
    id: "lyrics", capability: "lyrics", label: "timed lyrics", button: "Set up timed lyrics",
    title: "Timed lyrics need their own Python", readyWords: "Timed lyrics work here",
    python: "3.12",
    torchIndex, torchAuto: !TORCH_BUILDS[torch], torchChosenBy: chosenBy,
    sm, smDecided: !TORCH_BUILDS[torch] && newCard,
    torch: { packages: t.packages, indexUrl: torchIndexUrl(t.indexUrl, torchIndex) },
    packages: pipWords(whisperPip()).packages,
    modules: modulesOf(cap),
    modelBytes: cap.approxBytes || 0,
    /* The numbers behind the button. The only measurement is NVIDIA's disk
     * figure (one venv: 4.9 GB, torch 2.5.1+cu121, Python 3.10); every
     * download size is an estimate and says so. */
    sizes: torchIndex === "cu126"
      ? { downloadGb: 2.6, diskGb: 5, basis: "the download is an estimate; 4.9 GB on disk was measured on one NVIDIA venv" }
      : torchIndex === "cu128"
        ? { downloadGb: 2.6, diskGb: 5, basis: "estimates: the CUDA 12.8 build has not been measured here" }
        : { downloadGb: 0.5, diskGb: 1.5, basis: "an estimate: the CPU build has not been measured here" },
    words: {
      becomes: "the timed lyrics python",
      cpu: "timing then runs on the processor, which is slower",
      model: "the first timing then fetches the whisper model",
      setUp: "Timed lyrics are set up", runsIn: "They run in",
      usesNow: "timed lyrics use it now",
      firstRun: "The first timing fetches the whisper model",
    },
  };
}

/** What is left free beyond a build and its weights before auto takes the
 *  NVIDIA build: room for the songs, stems and caches that follow. */
const STEMS_HEADROOM_GB = 2;
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Stem separation (demucs) — and the audio-reference encoder, which runs in
 * the same config.systemPython (scripts/dav_encode.py imports numpy, torch, av
 * and safetensors). Every package name comes from where the rest of Studio
 * reads it: demucs from the catalogue's "stems" install line, numpy and av from
 * the "audioRef" row's, torch from lrc.js's TORCH_PIP; safetensors is
 * dav_encode.py's own import and has no catalogue line.
 *
 * THE OWNER'S RULE (2026-09-24): the GPU build on an NVIDIA card when the
 * drive has room, the CPU build otherwise, and the size said either way.
 * "auto" is CUDA 12.8 (RTX 50 included) on NVIDIA when `freeBytes` (the drive
 * holding Studio's data folder) is at least the build plus the separation
 * weights plus STEMS_HEADROOM_GB; below that, or with no NVIDIA card, the CPU
 * build. Free space that cannot be read does not block the GPU build. The GPU
 * build is CUDA 12.8, except on a card whose `capability` is below
 * SM_OLDEST_CU128 (Maxwell, Pascal), which keeps CUDA 12.6.
 */
export function stemsRecipe({ vendor = null, torch = "auto", freeBytes = null, drive = null, capability = null } = {}) {
  const t = pipWords(TORCH_PIP);
  const cap = CATALOG.find((c) => c.id === "stems") || {};
  const ref = CATALOG.find((c) => c.id === "audioRef") || {};
  const weightsGb = (cap.approxBytes || 0) / GB;
  /* The same estimate for either CUDA build; the basis names the one offered. */
  const sizesFor = (build) => (isCuda(build)
    ? { downloadGb: 2.6, diskGb: 5, basis: `estimates: a ${CUDA_WORDS[build] || "CUDA"} stem separation Python has not been measured here` }
    : { downloadGb: 0.5, diskGb: 1.5, basis: "estimates: the CPU build has not been measured here" });
  const GPU = sizesFor("cu128"), CPU = sizesFor("cpu");
  const needGb = {
    gpu: round1(GPU.diskGb + weightsGb + STEMS_HEADROOM_GB),
    cpu: round1(CPU.diskGb + weightsGb + STEMS_HEADROOM_GB),
  };
  /* What each number is made of, for the sentences that state one. */
  const needParts = (sizes) => `${sizes.diskGb} GB for the build, ${sizeText(cap.approxBytes || 0)} of separation weights and ${STEMS_HEADROOM_GB} GB to spare`;
  const freeGb = Number.isFinite(freeBytes) && freeBytes >= 0 ? round1(freeBytes / GB) : null;
  const where = drive || "the drive";
  const sm = vendor === "nvidia" ? smOf(capability) : null;
  const oldCard = sm !== null && sm < SM_OLDEST_CU128;
  let torchIndex, chosenBy;
  if (TORCH_BUILDS[torch]) { torchIndex = torch; chosenBy = "you chose it"; }
  else if (vendor !== "nvidia") { torchIndex = "cpu"; chosenBy = autoReason(vendor); }
  else if (freeGb !== null && freeGb < needGb.gpu) {
    torchIndex = "cpu";
    chosenBy = `an NVIDIA card was read, but ${where} has ${freeGb} GB free and the NVIDIA build needs about ${needGb.gpu} GB free, counting ${needParts(GPU)}, so the CPU build is offered`;
  } else {
    torchIndex = oldCard ? "cu126" : "cu128";
    chosenBy = (freeGb === null
      ? "an NVIDIA card was read on this PC (the free space on the drive could not be read)"
      : `an NVIDIA card was read on this PC, and ${where} has ${freeGb} GB free`)
      + (oldCard ? `; ${oldCardWords(sm)}` : "");
  }
  const refPkgs = pipWords(ref.packageInstall).packages.filter((p) => !t.packages.includes(p));
  return {
    id: "stems", capability: "stems", label: "stem separation", button: STEMS_SETUP_BUTTON,
    title: "Stem separation needs its own Python", readyWords: "Stem separation works here",
    python: "3.12",
    torchIndex, torchAuto: !TORCH_BUILDS[torch], torchChosenBy: chosenBy,
    sm, smDecided: !TORCH_BUILDS[torch] && oldCard && isCuda(torchIndex),
    torch: { packages: t.packages, indexUrl: torchIndexUrl(t.indexUrl, torchIndex) },
    packages: [...new Set([...pipWords(cap.packageInstall).packages, ...refPkgs, "safetensors"])],
    modules: STEMS_MODULES,
    modelBytes: cap.approxBytes || 0,
    sizes: sizesFor(torchIndex),
    freeGb, needGb, drive: where,
    needWhy: { gpu: needParts(GPU), cpu: needParts(CPU) },
    /* The stems setup saves `stems.device` ("cpu" when the card fails the
     * tensor op); timed lyrics have no such setting (lrc.py falls back itself). */
    deviceSetting: true,
    /* demucs 4.1 writes FLAC through ffmpeg, which this setup does not install. */
    needsFfmpeg: true,
    words: {
      becomes: "the python for stem separation and the audio-reference encoder",
      cpu: "separation then runs on the processor, which is slower",
      model: "the first separation then fetches the separation weights",
      setUp: "Stem separation is set up", runsIn: "It runs in",
      usesNow: "stem separation uses it now",
      has: "demucs and PyTorch",
      firstRun: "The first separation fetches the separation weights",
    },
  };
}

export const RECIPES = { lyrics: lyricsRecipe, stems: stemsRecipe };
export const RECIPE_IDS = Object.keys(RECIPES);

const gbText = (n) => `about ${n < 10 ? Math.round(n * 10) / 10 : Math.round(n)} GB`;
/** A size in words: under a gigabyte in MB (the separation weights are 336 MB,
 *  and "about 0.3 GB" hides the number the Models row shows). */
const sizeText = (bytes) => (bytes >= GB ? gbText(bytes / GB) : `${Math.round(bytes / 1e6)} MB`);
/** "a", "a and b", "a, b and c". */
const listWords = (xs) => (xs.length < 3 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/**
 * The sentence beside the button: what it builds, where, how big, what it
 * replaces, and what it does not touch. `replaces` is the interpreter the
 * feature runs in today when that one exists but lacks a module: the new one
 * is chosen in its place, and the person is told before, not after.
 */
export function offerSentence(recipe, root, { replaces = null, ffmpegMissing = false } = {}) {
  const s = recipe.sizes;
  const w = recipe.words || {};
  const cuda = CUDA_WORDS[recipe.torchIndex];
  /* Auto says why whenever more than "an NVIDIA card" decided it: the drive
   * (stems weighs it) or the card's own generation. */
  const why = recipe.torchAuto && (recipe.needGb || recipe.smDecided) ? `; ${recipe.torchChosenBy}` : "";
  const build = cuda
    ? (recipe.torchAuto
      ? `PyTorch for your NVIDIA card (${cuda}${recipe.torchIndex === "cu128" ? ", RTX 50 included" : ""}${why})`
      : `PyTorch's ${cuda} build (you chose it; it needs an NVIDIA card)`)
    : `the CPU build of PyTorch (${recipe.torchAuto ? "because " : ""}${recipe.torchChosenBy}; ${w.cpu || "it then runs on the processor, which is slower"})`;
  const names = listWords(recipe.packages);
  /* Too little room even for the build offered: said before, not found out
   * half-way through a 2.6 GB download, with what the number is made of. */
  const which = cuda ? "gpu" : "cpu";
  const need = recipe.needGb ? recipe.needGb[which] : null;
  const tight = need && recipe.freeGb !== null && recipe.freeGb !== undefined && recipe.freeGb < need
    ? `Only ${recipe.freeGb} GB is free on ${recipe.drive || "the drive"}, and this build needs about ${need} GB free`
      + `${recipe.needWhy?.[which] ? `, counting ${recipe.needWhy[which]}` : ""}: free some space first. `
    : "";
  return `Studio can set up ${recipe.label} for you: it builds a private Python ${recipe.python} in ${root} with ${build} and ${names}. `
    + `${gbText(s.downloadGb)[0].toUpperCase()}${gbText(s.downloadGb).slice(1)} to download and ${gbText(s.diskGb)} on disk (${s.basis})`
    + (recipe.modelBytes ? `; ${w.model || "the first run then fetches the model"}, ${sizeText(recipe.modelBytes)}` : "")
    + ". "
    + tight
    + (replaces ? `It then becomes ${w.becomes || `the ${recipe.label} python`}, in place of ${replaces}. ` : "")
    + (recipe.needsFfmpeg && ffmpegMissing ? `${FFMPEG_NEED} ` : "")
    + "No system Python is needed, and nothing else on this PC changes.";
}

/** Said wherever the stems setup reports on a PC with no ffmpeg to be found. */
const FFMPEG_NEED = "Separating also needs ffmpeg, which Studio does not install and which was not found on PATH or in AIPLAY_FFMPEG: "
  + "demucs writes its FLAC files with it. Put ffmpeg on PATH, or name it in AIPLAY_FFMPEG, then start Studio again.";

/* ─────────────────────────────────────────────── the card, really tested */

/* A 64x64 matrix product ON THE CARD, synchronised, and its sum checked.
 * torch.cuda.is_available() is not enough: a CUDA build without this card's
 * kernels (an RTX 50 under CUDA 12.6) reports the card, imports cleanly, and
 * fails on the first real op with "no kernel image is available". Carried
 * base64 so no shell or argv quoting rule can touch the newlines. */
const TENSOR_SCRIPT = [
  "import json",
  "out = {'ok': None, 'cuda': False}",
  "try:",
  "    import torch",
  "    out['torch'] = torch.__version__",
  "    out['cuda'] = bool(torch.cuda.is_available())",
  "    if not out['cuda']:",
  "        out.update(ok=True, device='cpu')",
  "    else:",
  "        out['name'] = torch.cuda.get_device_name(0)",
  "        out['capability'] = 'sm_%d%d' % torch.cuda.get_device_capability(0)",
  "        x = torch.ones((64, 64), device='cuda')",
  "        y = float((x @ x).sum().item())",
  "        torch.cuda.synchronize()",
  "        out.update(ok=(y == 262144.0), device='cuda')",
  "        if y != 262144.0: out['error'] = 'a 64x64 matrix product on the card gave %r, not 262144' % y",
  "except Exception as e:",
  "    out.update(ok=(False if out.get('cuda') else None), error=('%s: %s' % (type(e).__name__, e))[:300])",
  "print(json.dumps(out))",
].join("\n");
export const TENSOR_CHECK_ARGS = ["-c", `import base64;exec(base64.b64decode('${Buffer.from(TENSOR_SCRIPT).toString("base64")}').decode())`];

/**
 * Run the tensor op in `py`:
 *   { ok: true,  cuda: true,  device: "cuda", name, capability, torch }   the card works
 *   { ok: true,  cuda: false, device: "cpu", torch }                      no card PyTorch can see
 *   { ok: false, cuda: true,  error, name?, capability?, torch }           the card is there and FAILED
 *   { ok: null,  error }                                                   the test itself could not run
 * CUDA's first op can take a minute (lazy module loading), hence the limit.
 */
export function probeTensor(py, { timeoutMs = 180_000, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    let proc;
    try { proc = spawnFn(py, TENSOR_CHECK_ARGS, { windowsHide: true }); }
    catch (e) { return resolve({ ok: null, error: `could not start ${py} (${e.code || e.message})` }); }
    let out = "", err = "", settled = false;
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } finish({ ok: null, error: `the test did not finish within ${Math.round(timeoutMs / 1000)} s` }); }, timeoutMs);
    proc.stdout?.on("data", (d) => { out += d; });
    proc.stderr?.on("data", (d) => { err = (err + d).slice(-4000); });
    proc.on("error", (e) => finish({ ok: null, error: `could not start ${py} (${e.code || e.message})` }));
    proc.on("close", (code) => {
      try { finish(JSON.parse(out.trim().split(/\r?\n/).pop())); }
      catch { finish({ ok: null, error: mask(`it printed no answer (exit ${code})${err.trim() ? `: ${err.trim().split(/\r?\n/).pop()}` : ""}`).slice(0, 300) }); }
    });
  });
}

/** The card failed a real op under a CUDA build: the one verdict that moves
 *  the work to the processor. "Could not test" (ok: null) moves nothing. */
const cardFailed = (t) => t?.ok === false && t.cuda === true;

/** One sentence for the job's log and message. */
function tensorWords(t, recipe) {
  if (!t) return "";
  const card = t.name ? `${t.name}${t.capability ? `, ${t.capability}` : ""}` : "the card";
  if (t.ok === true && t.cuda) return `PyTorch ran a test on ${card}.`;
  if (t.ok === true && /\+cpu$/.test(t.torch || "")) return `Its PyTorch is the CPU build (torch ${t.torch}), so ${recipe.label} runs on the processor, which is slower.`;
  if (t.ok === true) return `PyTorch cannot see an NVIDIA card from this build (torch ${t.torch || "?"}), so ${recipe.label} runs on the processor; a newer NVIDIA driver may be needed.`;
  if (cardFailed(t)) return `${card} could not run PyTorch's ${/^cu\d/.test(recipe.torchIndex || "") ? buildName(recipe.torchIndex) : "CUDA"} build (${t.error || "the test failed"}).`;
  return `The card test could not run (${t.error || "no answer"}).`;
}

/** Where the stems setup's device verdict goes by default: the live config,
 *  with the interpreter it was measured on (art.js applies "cpu" only while
 *  that one runs), which `persist` or the save that follows (index.js) write
 *  to settings.json. */
function defaultOnDevice(id, device, _verdict, python = null) {
  if (id !== "stems" || !config.stems) return;
  config.stems.device = device;
  config.stems.devicePython = device && python ? python : null;
}

/** "2.5.1+cu121" → "cu121", "2.7.0+cpu" → "cpu"; null when the version names
 *  no build (a plain "2.5.1" can be either). */
export const buildOf = (version) => /\+([a-z]+[0-9.]*)$/i.exec(String(version || ""))?.[1]?.toLowerCase() || null;
/** "cpu" → "the CPU build", "cu121" → "CUDA 12.1". */
function buildName(b) {
  if (b === "cpu") return "the CPU build";
  if (CUDA_WORDS[b]) return CUDA_WORDS[b];
  const m = /^cu(\d+)(\d)$/.exec(b || "");
  return m ? `CUDA ${m[1]}.${m[2]}` : b || "an unknown build";
}

/**
 * Why a python that imports everything should still be replaced by the build
 * on offer, or null to keep it. `have` is its PyTorch build ("cpu", "cu121",
 * "cu126", "cu128" …; null when it cannot be told), `t` its card test.
 *
 *  - the same build again would change nothing: kept (a card that fails even
 *    then is a driver matter, said by cpuTail);
 *  - its PyTorch fails on the card and a CUDA build is on offer: replaced;
 *  - the person CHOSE a build and it has another: replaced (that is what the
 *    "choose CUDA 12.8 and press again" advice relies on);
 *  - auto offers a CUDA build (an NVIDIA card, and for stems the room) and it
 *    has the CPU build: replaced — the case a plain `pip install demucs` makes.
 * Auto offering the CPU build (a full drive) never replaces a working GPU one.
 */
export function replaceWhy(recipe, have, t) {
  const want = recipe.torchIndex;
  if (have && have === want) return null;
  if (isCuda(want) && cardFailed(t)) return `its PyTorch${have ? ` (${buildName(have)})` : ""} cannot run on this card`;
  if (!recipe.torchAuto && have) return `you chose ${buildName(want)}, and its PyTorch is ${buildName(have)}`;
  if (recipe.torchAuto && isCuda(want) && have === "cpu") return `its PyTorch is the CPU build, and ${buildName(want)} can use this PC's NVIDIA card`;
  return null;
}

/* Where torch lives in an interpreter and which build it is, read from
 * torch/version.py WITHOUT importing torch (an import starts CUDA; this runs
 * on a Models repaint). `cuda` is null for a CPU (or ROCm) build. */
const TORCH_BUILD_SCRIPT = [
  "import importlib.util as u, json, os, re",
  "out = {'version': None, 'cuda': None}",
  "try:",
  "    s = u.find_spec('torch')",
  "    if s and s.origin:",
  "        t = open(os.path.join(os.path.dirname(s.origin), 'version.py'), encoding='utf-8').read()",
  "        m = re.search(r\"^__version__\\s*(?::[^=]*)?=\\s*['\\\"]([^'\\\"]+)\", t, re.M)",
  "        out['version'] = m.group(1) if m else None",
  "        m = re.search(r\"^cuda\\s*(?::[^=]*)?=\\s*(?:['\\\"]([^'\\\"]*)['\\\"]|None)\", t, re.M)",
  "        out['cuda'] = (m.group(1) or None) if m else None",
  "except Exception as e:",
  "    out['error'] = str(e)[:200]",
  "print(json.dumps(out))",
].join("\n");
export const TORCH_BUILD_ARGS = ["-c", `import base64;exec(base64.b64decode('${Buffer.from(TORCH_BUILD_SCRIPT).toString("base64")}').decode())`];

/** { version, cuda } of the torch in `py`, or null when it cannot be read. */
export function probeTorchBuild(py, { timeoutMs = 15_000, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    let proc;
    try { proc = spawnFn(py, TORCH_BUILD_ARGS, { windowsHide: true }); } catch { return resolve(null); }
    let out = "", settled = false;
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } finish(null); }, timeoutMs);
    proc.stdout?.on("data", (d) => { out += d; });
    proc.stderr?.resume?.();
    proc.on("error", () => finish(null));
    proc.on("close", () => {
      try { const v = JSON.parse(out.trim().split(/\r?\n/).pop()); finish(v?.version ? { version: v.version, cuda: v.cuda || null } : null); }
      catch { finish(null); }
    });
  });
}

/* The card's compute capability through nvidia-smi (mesh/runner.js, loaded
 * only when asked: it is a heavy module and most setups never need it). */
const defaultCapability = async () => (await import("../mesh/runner.js")).cudaCapability();

/** Free bytes on the drive holding `dir` (or its nearest existing parent);
 *  null when it cannot be read. */
export async function defaultFreeBytes(dir) {
  let d = path.resolve(String(dir || "."));
  for (let i = 0; i < 64; i++) {
    try {
      const s = await statfs(d);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      const up = path.dirname(d);
      if (up === d) return null;
      d = up;
    }
  }
  return null;
}

/* ───────────────────────────────────────────────────── where it may build */

async function defaultDriveType(letter) {
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[System.IO.DriveInfo]::new('${letter}').DriveType`],
      { windowsHide: true, timeout: 10_000 }, (err, stdout) => resolve(err ? null : String(stdout).trim() || null));
  });
}

/**
 * Null when `dir` is on this computer's own disk; else the sentence refusing it.
 * A share (\\server\share), a device path (\\?\, \\.\) or a mapped network
 * drive would put a program Studio runs on another machine, and a venv on a
 * share is slow and breaks when the share is gone.
 */
export async function localDiskProblem(dir, { platform = process.platform, driveType = defaultDriveType } = {}) {
  const s = String(dir || "");
  const fix = "Studio builds this Python on this computer's own disk: set AIPLAY_APPDATA to a folder on a local drive, then start Studio again.";
  if (/^[\\/]{2}/.test(s)) return `${s} is a network or device path. ${fix}`;
  if (platform === "win32") {
    const m = /^([A-Za-z]):/.exec(s);
    if (m && (await Promise.resolve(driveType(m[1].toUpperCase())).catch(() => null)) === "Network") {
      return `${m[1].toUpperCase()}: is a network drive. ${fix}`;
    }
  }
  return null;
}

export const venvPython = (root, platform = process.platform) =>
  platform === "win32" ? path.join(root, "venv", "Scripts", "python.exe") : path.join(root, "venv", "bin", "python");

async function readJson(p) { try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; } }

/* ──────────────────────────────────────────────────────────── the runner */

/** An error whose message is already the sentence a person reads. */
class SetupError extends Error {}

const STEPS = [
  ["check", "Checking what is already there"],
  ["uv", "Getting the Python installer (uv)"],
  ["python", "Installing Python"],
  ["venv", "Making the environment"],
  ["torch", "Installing PyTorch"],
  ["packages", "Installing the packages"],
  ["verify", "Checking that everything imports and runs"],
  ["save", "Choosing it"],
];

/**
 * The runner behind POST /api/setup and the MCP tools.
 *
 *   appData        Studio's data folder (config.dataDir)
 *   vendor()       "nvidia" | "amd" | "intel" | … | null — the card as read now
 *   probe(py, mods) → { module: bool } — index.js probeOne, the Models row's probe
 *   currentPython(id) → the interpreter the feature runs in today, or null
 *   save(id, py)   → choose it; resolves the verdict ({ note }) to say afterwards
 *   getUv(say)     → the uv program: a path, or [program, ...leading args]
 *   blockedBy(id)  → null, or the sentence saying why building would not
 *                    change what the feature runs in (AIPLAY_WHISPER_PYTHON
 *                    names the interpreter, and the environment wins)
 *   commandTimeoutMs  0 (the default): no limit. PyTorch's CUDA wheel is one
 *                    ~2.5 GB file that uv does not resume, and uv prints nothing
 *                    while it downloads, so neither a wall-clock nor an idle
 *                    limit can tell a slow line from a stuck one; the engine
 *                    installer sets none either. Tests set one.
 *   freeBytes(dir)  → free bytes on the drive holding Studio's data folder, or
 *                    null; the stems recipe's "auto" reads it (GPU build only
 *                    with room). Default: fs.statfs.
 *   tensorCheck(py) → probeTensor's verdict: a real op on the card, run at
 *                    verify for every CUDA build, and at "check" on the python
 *                    the feature runs in today whenever a CUDA build is on offer
 *   onDevice(id, device, verdict, python)  where a recipe with a device setting
 *                    (stems) puts "cpu" (the card failed the op) or null (it
 *                    passed), for that python. Default: config.stems.device and
 *                    config.stems.devicePython, which `persist`/`save` then write.
 *   persist()       → writes the settings to disk (index.js savePrefs). Called
 *                    after every device verdict, so one found on a no-op run
 *                    survives a restart. Default: nothing (the save writes it).
 *   capability()    → the card's compute capability ([12, 0], "sm_120", …) or
 *                    null; asked only with an NVIDIA card, kept 10 minutes. Auto
 *                    picks CUDA 12.8 for timed lyrics on an RTX 50 and CUDA 12.6
 *                    for stems on a card the 12.8 builds dropped. Default:
 *                    nvidia-smi through mesh/runner.js cudaCapability().
 *   torchBuild(py)  → { version, cuda } of the torch in the python the feature
 *                    runs in (read from torch/version.py, no import): status()
 *                    says `onProcessor` when a working one is the CPU build on
 *                    an NVIDIA card. Default: probeTorchBuild.
 *   ffmpeg()        → the ffmpeg demucs would run, or null (the stems setup
 *                    says so when there is none). Default: findFfmpeg.
 */
export function createSetupRunner({
  appData, vendor = () => null, probe, currentPython = () => null, save,
  getUv = (say) => ensureUv({ appData, log: say }), blockedBy = () => null,
  driveType, platform = process.platform, quickMs = 1500, commandTimeoutMs = 0,
  freeBytes = defaultFreeBytes, tensorCheck = (py) => probeTensor(py), onDevice = defaultOnDevice,
  persist = async () => {}, capability = defaultCapability, torchBuild = (py) => probeTorchBuild(py),
  ffmpeg = () => findFfmpeg(),
} = {}) {
  if (!appData) throw new Error("createSetupRunner needs Studio's data folder.");
  const jobs = new Map();
  /* "Does the feature work today?" for status(): the same probe, kept for 30 s
   * (the Models screen repaints on every download tick), and dropped whenever a
   * job finishes. */
  const readyCache = new Map();
  async function readyNow(id, recipe) {
    const py = currentPython(id);
    if (!py || !path.isAbsolute(py) || !existsSync(py)) return false;
    const hit = readyCache.get(py);
    if (hit && Date.now() - hit.at < 30_000) return hit.ok;
    const got = await Promise.resolve(probe(py, recipe.modules)).catch(() => ({}));
    const ok = recipe.modules.every((m) => got?.[m] === true);
    readyCache.set(py, { at: Date.now(), ok });
    return ok;
  }
  /* Which PyTorch build a working python has, for status() (30 s, like readiness). */
  const buildCache = new Map();
  async function torchBuildNow(py) {
    const hit = buildCache.get(py);
    if (hit && Date.now() - hit.at < 30_000) return hit.v;
    const v = await Promise.resolve(torchBuild(py)).catch(() => null);
    buildCache.set(py, { at: Date.now(), v: v || null });
    return v || null;
  }
  /* The card's compute capability, asked once per ten minutes and only of an
   * NVIDIA card (nvidia-smi is not free, and status() runs on every repaint). */
  let capHit = null;
  async function smNow() {
    if (vendor() !== "nvidia") return null;
    if (capHit && Date.now() - capHit.at < 600_000) return capHit.sm;
    const sm = smOf(await Promise.resolve().then(() => capability()).catch(() => null));
    capHit = { at: Date.now(), sm };
    return sm;
  }
  const ffmpegMissing = async () => !(await Promise.resolve().then(() => ffmpeg()).catch(() => null));
  const rootOf = (id) => path.join(appData, "venvs", id);
  const cacheOf = (id) => path.join(appData, "venvs", `${id}-cache`);
  const samePath = (a, b) => (platform === "win32"
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b));
  /* "C:" on Windows; the stems recipe names it when the drive is too full. */
  const drive = /^[A-Za-z]:/.exec(String(appData))?.[0]?.toUpperCase() || null;
  const freeNow = async () => {
    const n = await Promise.resolve(freeBytes(appData)).catch(() => null);
    return Number.isFinite(n) ? n : null;
  };
  const recipeFor = (id, torch = "auto", free = null, sm = null) =>
    RECIPES[id]({ vendor: vendor() || null, torch, freeBytes: free, drive, capability: sm });
  /* The card test, never fatal: a test that cannot run is "unknown". */
  const runTensor = async (j, py) => {
    const t = await Promise.resolve(tensorCheck(py)).catch((e) => ({ ok: null, error: e?.message || String(e) }));
    j.lines.push(`> tensor check in ${py}: ${t?.ok === true ? "passed" : t?.ok === false ? "FAILED" : "could not run"}${t?.name ? ` (${t.name}${t.capability ? `, ${t.capability}` : ""})` : ""}${t?.torch ? ` [torch ${t.torch}]` : ""}${t?.error ? `: ${mask(String(t.error)).slice(0, 200)}` : ""}`);
    return t || { ok: null };
  };
  /* A recipe with a device setting learns where its work runs, in THAT python:
   * "cpu" when the card failed a real op, null when it passed. "Could not
   * test" changes nothing. The verdict is written to disk at once (`persist`),
   * so one found on a no-op run is not lost at the next restart. */
  const settleDevice = async (recipe, t, py) => {
    if (!recipe.deviceSetting || !t || t.ok === null) return;
    await Promise.resolve(onDevice(recipe.id, cardFailed(t) ? "cpu" : null, t, py)).catch(() => {});
    await Promise.resolve().then(() => persist()).catch(() => {});
  };
  /* What the message adds when the card test did not simply pass. `have` is
   * the build that was tested; the advice follows the card's generation, so
   * it never points at a build that would fail the same way. */
  const cpuTail = (recipe, t, have = recipe.torchIndex) => {
    if (!t || t.ok === true && t.cuda) return "";
    if (!cardFailed(t)) return ` ${tensorWords(t, recipe)}`;
    const sm = smOf(t.capability) ?? recipe.sm ?? null;
    const lowDisk = recipe.needGb && recipe.torchAuto && !isCuda(recipe.torchIndex) && recipe.freeGb !== null && recipe.freeGb < recipe.needGb.gpu;
    const advice = lowDisk
      ? `with about ${recipe.needGb.gpu} GB free on ${recipe.drive || "the drive"}, pressing ${recipe.button} again builds PyTorch for the card`
      : sm !== null && sm < SM_OLDEST_CU128 && have !== "cu126"
        ? `this card is older than PyTorch's ${CUDA_WORDS.cu128} builds support, so choose ${CUDA_WORDS.cu126} under PyTorch build and press ${recipe.button} again`
        : have !== "cu128" && (sm === null || sm >= SM_NEEDS_CU128)
          ? `for an RTX 50 card, choose ${CUDA_WORDS.cu128} under PyTorch build and press ${recipe.button} again`
          : "an NVIDIA driver update may be what it needs; run this setup again afterwards";
    /* Timed lyrics run on CTranslate2, which uses torch only for its CUDA
     * libraries: a failed torch op says the card is in doubt, not that whisper
     * certainly falls back. */
    return ` ${tensorWords(t, { ...recipe, torchIndex: have })} `
      + (recipe.deviceSetting
        ? `So ${recipe.label} runs on the processor (slower) until this setup is run again: ${advice}.`
        : `${recipe.label[0].toUpperCase()}${recipe.label.slice(1)} may fall back to the processor: ${advice}.`);
  };
  /* What the message adds on a PC with no ffmpeg for a recipe that needs one. */
  const ffmpegTail = async (recipe) => (recipe.needsFfmpeg && (await ffmpegMissing()) ? ` ${FFMPEG_NEED}` : "");

  const snapshot = (j) => j && ({
    id: j.id, state: j.state, step: j.step, label: j.label, n: j.n, of: STEPS.length,
    torchIndex: j.torchIndex, root: j.root, python: j.python || null, noop: !!j.noop,
    message: j.message || null, error: j.error || null, lines: j.lines.slice(-12),
    startedAt: j.startedAt, finishedAt: j.finishedAt || null,
  });

  /** One command, its output kept as the job's lines; rejects with the last of them. */
  function exec(j, uv, args, env) {
    const [cmd, ...lead] = Array.isArray(uv) ? uv : [uv];
    return new Promise((resolve, reject) => {
      j.lines.push(`> uv ${args.join(" ")}`);
      let child;
      try { child = spawn(cmd, [...lead, ...args], { env: { ...process.env, ...env }, windowsHide: true }); }
      catch (e) { reject(new SetupError(`Could not start uv (${e.code || e.message}).`)); return; }
      const onText = (d) => {
        for (const raw of String(d).split(/\r?\n|\r/)) {
          const line = mask(raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trimEnd()).slice(0, 300);
          if (!line.trim()) continue;
          j.lines.push(line);
          if (j.lines.length > 200) j.lines.shift();
        }
      };
      child.stdout?.on("data", onText);
      child.stderr?.on("data", onText);
      const timer = commandTimeoutMs > 0 ? setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, commandTimeoutMs) : null;
      child.on("error", (e) => { clearTimeout(timer); reject(new SetupError(`Could not start uv (${e.code || e.message}).`)); });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        const last = [...j.lines].reverse().find((l) => !l.startsWith("> ")) || "";
        reject(new SetupError(`uv ${args.slice(0, 2).join(" ")} ${signal ? `was stopped (${signal})` : `exited with code ${code}`}${last ? `: ${last}` : ""}`));
      });
    });
  }

  async function build(j, recipe) {
    const step = (id) => {
      const n = STEPS.findIndex(([k]) => k === id);
      j.step = id; j.n = n + 1;
      j.label = id === "torch" ? `Installing PyTorch (${CUDA_WORDS[recipe.torchIndex] || "CPU"})`
        : id === "packages" ? `Installing ${listWords(recipe.packages)}`
        : id === "python" ? `Installing Python ${recipe.python}` : STEPS[n][1];
    };
    const root = j.root, cache = cacheOf(recipe.id), marker = path.join(root, MARKER);
    const py = venvPython(root, platform);
    const allImport = (got) => recipe.modules.every((m) => got?.[m] === true);
    const w = recipe.words || {};

    step("check");
    const now = currentPython(recipe.id);
    /* Set when the python the feature runs in today IS Studio's own venv and it
     * is to be replaced: the "built before" reuse below must not choose it again. */
    let replaceOwn = false;
    if (now && path.isAbsolute(now) && existsSync(now) && allImport(await probe(now, recipe.modules))) {
      /* A python that imports everything is not necessarily the one to keep
       * (review, 2026-09-24): its PyTorch may have no kernels for this card
       * (Tika's case: an older CUDA build on an RTX 50), it may be the CPU
       * build on an NVIDIA card (a plain `pip install demucs`), or the person
       * may have CHOSEN another build ("choose CUDA 12.8 and press again").
       * So it is tested whenever a CUDA build is on offer, a build was chosen,
       * or the recipe owns a device setting, and replaceWhy() decides. */
      const test = recipe.deviceSetting || isCuda(recipe.torchIndex) || !recipe.torchAuto;
      const t = test ? await runTensor(j, now) : null;
      const own = samePath(now, py) ? await readJson(marker) : null;
      const have = buildOf(t?.torch) || (own?.complete === true ? own.torchIndex || null : null);
      const why = replaceWhy(recipe, have, t);
      if (!why) {
        await settleDevice(recipe, t, now);
        return { state: "ready", noop: true, python: now,
          message: `${recipe.readyWords}, so nothing was installed: ${now} has ${w.has || listWords(recipe.packages)}.${cpuTail(recipe, t, have)}${await ffmpegTail(recipe)}` };
      }
      j.lines.push(`${now} imports everything, but ${why}, so Studio builds its own (${buildName(recipe.torchIndex)}).`);
      replaceOwn = own !== null;
    }
    const where = await localDiskProblem(appData, { platform, driveType });
    if (where) throw new SetupError(where);
    const mark = await readJson(marker);
    if (!replaceOwn && mark?.complete === true && existsSync(py) && allImport(await probe(py, recipe.modules))) {
      /* Built before: tested again (a driver update may have fixed the card,
       * or broken it), then chosen, unless it is not the build asked for
       * (the same replaceWhy(): a chosen build, a card it cannot run, or the
       * CPU build where a CUDA one is now on offer), in which case it is
       * built again. The marker says which build it was made with. */
      const have = mark.torchIndex || null;
      const t = isCuda(have || recipe.torchIndex) ? await runTensor(j, py) : null;
      const why = replaceWhy(recipe, have, t);
      if (!why) {
        await settleDevice(recipe, t, py);
        step("save");
        const verdict = await save(recipe.id, py);
        return { state: "done", noop: true, python: py,
          message: (verdict?.note || `Studio's own ${recipe.label} Python was already built, and ${w.usesNow || `${recipe.label} use it now`}: ${py}.`)
            + cpuTail(recipe, t, have) + (await ffmpegTail(recipe)) };
      }
      j.lines.push(`Studio's own ${recipe.label} Python (${buildName(have)}) is built again with ${buildName(recipe.torchIndex)}: ${why}.`);
    }
    if (existsSync(root) && !existsSync(marker) && (await readdir(root)).length) {
      throw new SetupError(`${root} already exists and was not made by Studio, so it was left alone. Move it away, then press ${recipe.button} again.`);
    }
    if (existsSync(marker)) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    await mkdir(root, { recursive: true });
    await writeFile(marker, `${JSON.stringify({ id: recipe.id, complete: false, python: recipe.python, torchIndex: recipe.torchIndex, startedAt: new Date().toISOString() }, null, 2)}\n`);
    await mkdir(cache, { recursive: true });

    step("uv");
    const uv = await getUv((line) => j.lines.push(mask(String(line))));
    const env = { ...UV_PRIVATE_ENV, UV_PYTHON_INSTALL_DIR: path.join(root, "python"), UV_CACHE_DIR: cache, PYTHONUTF8: "1" };
    step("python");
    await exec(j, uv, ["python", "install", ...UV_PYTHON_INSTALL_ARGS, recipe.python], env);
    step("venv");
    await exec(j, uv, ["venv", "--seed", "--python", recipe.python, path.join(root, "venv")], env);
    if (!existsSync(py)) throw new SetupError(`The environment was not created: there is no ${py}.`);
    step("torch");
    await exec(j, uv, ["pip", "install", "--python", py, ...recipe.torch.packages, "--index-url", recipe.torch.indexUrl], env);
    step("packages");
    await exec(j, uv, ["pip", "install", "--python", py, ...recipe.packages], env);

    step("verify");
    const got = await probe(py, recipe.modules);
    const missing = recipe.modules.filter((m) => got?.[m] !== true);
    if (missing.length) {
      const word = (m) => PIP_NAME[m] ? `${PIP_NAME[m]} (${m})` : m;
      const have = recipe.modules.filter((m) => !missing.includes(m)).map(word);
      throw new SetupError(`${have.length ? `${have.join(" and ")} installed, but ` : ""}${missing.map(word).join(" and ")} `
        + `${missing.length > 1 ? "do" : "does"} not import in ${py}, so it was not chosen for ${recipe.label}.`);
    }
    /* A REAL OP ON THE CARD, for every CUDA build. Importing proves nothing
     * about the card: a build without its kernels imports cleanly. A failure
     * does not fail the setup (the processor still works): the python is
     * still chosen, the work moves to the processor, and the message says so. */
    const tensor = isCuda(recipe.torchIndex) ? await runTensor(j, py) : null;
    await settleDevice(recipe, tensor, py);
    await writeFile(marker, `${JSON.stringify({ ...(await readJson(marker)), complete: true, finishedAt: new Date().toISOString(),
      ...(tensor ? { tensor: { ok: tensor.ok, cuda: !!tensor.cuda, name: tensor.name || null, capability: tensor.capability || null } } : {}) }, null, 2)}\n`);

    step("save");
    const verdict = await save(recipe.id, py);
    await rm(cache, { recursive: true, force: true }).catch(() => {});
    return { state: "done", python: py,
      message: `${w.setUp || `${recipe.label[0].toUpperCase()}${recipe.label.slice(1)} are set up`}. ${verdict?.note || `${w.runsIn || "They run in"} ${py}.`}`
        + (recipe.modelBytes ? ` ${w.firstRun || "The first run fetches the model"} (${sizeText(recipe.modelBytes)}).` : "")
        + cpuTail(recipe, tensor) + (await ffmpegTail(recipe)) };
  }

  /* The outcome is assembled first and published in ONE assignment, last:
   * a status read between "failed" and its sentence (or before the cleanup and
   * the log) would report a finished job that has not finished. */
  async function runJob(j, recipe) {
    let outcome;
    try {
      outcome = await build(j, recipe);
    } catch (e) {
      const stoppedAt = j.label || "the start";
      const reason = e instanceof SetupError ? e.message : `${e?.message || e}`;
      let cleaned = "";
      if (j.step !== "check" && existsSync(path.join(j.root, MARKER)) && (await readJson(path.join(j.root, MARKER)))?.complete !== true) {
        await rm(j.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {});
        cleaned = ` The half-built environment was removed; its download cache (${cacheOf(recipe.id)}) is kept, so trying again does not fetch the same files twice.`;
      }
      outcome = { state: "failed", error: mask(reason), message: mask(`Setting up ${recipe.label} stopped at "${stoppedAt}": ${reason}${cleaned}`) };
    }
    readyCache.clear();
    buildCache.clear();
    /* The doors ask the stems python again rather than remember a refusal. */
    if (recipe.id === "stems") clearStemsPreflight();
    /* The whole log, for Details and Copy report; the status carries its tail.
     * Not for a refusal at "check": that may be a network path, which this
     * must not write to either. */
    if (!(outcome.state === "failed" && j.step === "check")) {
      await mkdir(path.join(appData, "logs"), { recursive: true }).catch(() => {});
      await writeFile(path.join(appData, "logs", `setup-${recipe.id}.log`), `${j.lines.join("\n")}\n\n${outcome.message || ""}\n`).catch(() => {});
    }
    Object.assign(j, outcome, { finishedAt: Date.now() });
  }

  return {
    has: (id) => Object.prototype.hasOwnProperty.call(RECIPES, id),
    ids: RECIPE_IDS,

    /** Start (or report) a setup. Resolves within `quickMs`: with the final
     *  state when the job is that quick (a no-op), else with it running. */
    async run(id, { torch = "auto" } = {}) {
      const running = jobs.get(id);
      if (running?.state === "running") return { ...snapshot(running), already: true };
      /* Refused before anything is fetched: building would change nothing the
       * feature runs in, and the answer would say "set up" when it is not. */
      const blocked = blockedBy(id);
      if (blocked) return { id, state: "blocked", message: blocked, error: blocked, lines: [], of: STEPS.length, n: 0 };
      /* The drive and the card's generation are read before the recipe: "auto"
       * depends on both. */
      const recipe = recipeFor(id, torch, await freeNow(), await smNow());
      /* A second press that arrived while the drive was being read. */
      const raced = jobs.get(id);
      if (raced?.state === "running") return { ...snapshot(raced), already: true };
      const j = { id, state: "running", step: null, label: null, n: 0, lines: [], root: rootOf(id),
        torchIndex: recipe.torchIndex, startedAt: Date.now() };
      jobs.set(id, j);
      const done = runJob(j, recipe);
      await Promise.race([done, new Promise((r) => setTimeout(r, quickMs))]);
      return snapshot(j);
    },

    /** Every recipe (or one): what the button would build, and the job's state. */
    async status(id = null) {
      const ids = id ? [id] : RECIPE_IDS;
      const out = [];
      const free = await freeNow();
      const sm = await smNow();
      for (const k of ids) {
        if (!RECIPES[k]) continue;
        const recipe = recipeFor(k, "auto", free, sm);
        const root = rootOf(k);
        const current = currentPython(k) || null;
        const ready = await readyNow(k, recipe);
        const blocked = blockedBy(k) || null;
        /* WORKS, BUT ON THE PROCESSOR: a python that imports everything whose
         * PyTorch is the CPU build, while auto offers a CUDA one (an NVIDIA
         * card, and for stems the room). Read from torch/version.py, without
         * importing torch. The page keeps the button for it: pressing it
         * builds the GPU version (replaceWhy), no longer a no-op. */
        let onProcessor = false;
        if (ready && isCuda(recipe.torchIndex) && current) {
          const tb = await torchBuildNow(current);
          onProcessor = !!tb && !tb.cuda;
        }
        const needsFfmpeg = !!recipe.needsFfmpeg;
        const noFfmpeg = needsFfmpeg ? await ffmpegMissing() : false;
        /* The interpreter the build would replace: one that exists but lacks a
         * module, or one that works on the processor only. */
        const replaces = (!ready || onProcessor) && current && path.isAbsolute(current) && existsSync(current) ? current : null;
        /* One offer per PyTorch choice, so the page's "PyTorch build" shows the
         * sentence for the build it will post, and decides nothing itself. */
        const offers = Object.fromEntries(TORCH_CHOICES.map((t) => [t, offerSentence(recipeFor(k, t, free, sm), root, { replaces, ffmpegMissing: noFfmpeg })]));
        out.push({
          id: k, label: recipe.label, button: recipe.button, title: recipe.title, readyWords: recipe.readyWords,
          capability: recipe.capability,
          python: recipe.python, torchIndex: recipe.torchIndex, torchChoices: TORCH_CHOICES,
          torchBuilds: { auto: `Auto: ${TORCH_BUILDS[recipe.torchIndex]} (${recipe.torchChosenBy})`, ...TORCH_BUILDS },
          packages: recipe.packages, modules: recipe.modules, sizes: recipe.sizes,
          root, venvPython: venvPython(root, platform), current,
          ready, onProcessor, blocked,
          offer: blocked || offers.auto, offers,
          job: snapshot(jobs.get(k)) || null,
          /* The numbers behind "auto" for a recipe that weighs the drive
           * (stems): what is free, and what each build needs with room to spare. */
          ...(recipe.needGb ? { freeGb: recipe.freeGb, needGb: recipe.needGb } : {}),
          /* demucs 4.1 writes FLAC through ffmpeg, which no setup installs. */
          ...(needsFfmpeg ? { ffmpegFound: !noFfmpeg } : {}),
        });
      }
      return { setups: out };
    },
  };
}
