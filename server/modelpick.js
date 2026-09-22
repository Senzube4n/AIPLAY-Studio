/**
 * THE MODEL SHELF THE IMAGE SCREENS PICK FROM — both folders, not one.
 *
 * ⚠ THE BUG THIS EXISTS FOR. The picker read `models/checkpoints` only, and a
 * classic checkpoint is not where most of these files live: Z-Image, Anima,
 * FLUX.2 and Krea 2 are bare transformers and belong in
 * `models/diffusion_models`, which is exactly where ComfyUI's own UNETLoader
 * reads them from. So a rig with ten community models in diffusion_models was
 * told "nothing in models/checkpoints yet" and could pick none of them.
 *
 * Both shelves are listed here, each file is probed for what it actually is,
 * and the answer says which LOADER it needs:
 *
 *   checkpoints/…      a full SD-family checkpoint  -> CheckpointLoaderSimple
 *   diffusion_models/… a bare DiT                   -> UNETLoader, plus the
 *                      catalogue's text encoder and VAE for that family
 *
 * A community Z-Image is a re-trained transformer, not a new architecture, so
 * the family's own graph drives it unchanged — which is why picking one can
 * just work rather than needing a bespoke engine per file.
 *
 * Every base the engine loads from is scanned, not only config.modelsDir: a
 * ComfyUI Desktop install keeps its models wherever its extra_model_paths says.
 */
import path from "node:path";
import { config as defaultConfig } from "./config.js";
import { scanBases, extraBases, uniqueDirs } from "./localmodels.js";
import { probeModel, loadableAs, presetFor } from "./detect.js";
import { readPart, partFits } from "./partfit.js";
import { ZIMAGE_PRESET, KREA2_PRESET, ANIMA_PRESET } from "./workflow.js";
import { QWEN_IMAGE_PRESET } from "./qwen-image.js";

/**
 * What each family wants when a file of it is picked, so the screen sets its
 * numbers instead of leaving a checkpoint's 28 steps in front of an 8-step
 * model. The numbers are the vendors' own, read from the graph builders rather
 * than copied — a preset that drifts from the graph it describes is worse than
 * none. Sizes are the square each family is trained at, plus the two common
 * rectangles; detection has no opinion about aspect and neither does this.
 */
const SIDES = (n) => [[n, n], [Math.round(n * 1.25 / 16) * 16, Math.round(n * 0.8 / 16) * 16], [Math.round(n * 0.8 / 16) * 16, Math.round(n * 1.25 / 16) * 16]];
const FAMILY_PRESET = {
  zimage: { steps: ZIMAGE_PRESET.turbo.steps, cfg: ZIMAGE_PRESET.turbo.cfg, native: 1024, clipSkip: false, sizes: SIDES(1024) },
  krea2: { steps: KREA2_PRESET.steps, cfg: KREA2_PRESET.cfg, native: 1024, clipSkip: false, sizes: SIDES(1024) },
  anima: { steps: ANIMA_PRESET.steps, cfg: ANIMA_PRESET.cfg, native: ANIMA_PRESET.size, clipSkip: false, sizes: SIDES(ANIMA_PRESET.size) },
  flux2: { steps: 4, cfg: 1.0, native: 1024, clipSkip: false, sizes: SIDES(1024) },
  "qwen-image-2.1": { steps: QWEN_IMAGE_PRESET.steps, cfg: QWEN_IMAGE_PRESET.cfg,
    native: QWEN_IMAGE_PRESET.size, clipSkip: false, sizes: SIDES(QWEN_IMAGE_PRESET.size) },
};

/** The shelves a picked image model may come from, in listing order. */
export const PICK_FOLDERS = ["checkpoints", "diffusion_models", "unet"];

/**
 * A bare transformer the app can drive with a file the user chose: its family
 * as detection names it, mapped to the image engine that loads it.
 *
 * Ideogram 4 is deliberately absent: its graph loads TWO fixed files (a
 * conditional and an unconditional pass), so one picked file cannot stand in
 * for it. Anything not here is listed and refused BY NAME rather than hidden.
 */
export const DIT_ENGINE = {
  anima: "anima",
  zimage: "zimage",
  flux2: "flux2",
  krea2: "krea2",
  "qwen-image-2.1": "qwen-image-2.1",
};

/**
 * The same question for the Video screen: which video engine can be pointed at
 * a file the user chose. A video model is a transformer like the image ones,
 * and it lives in the same folder — so the same shelf, read with a different
 * map. Both engines' graphs take their DiT, text encoder and VAEs by name, so a
 * substitute file needs no new code path, only a name.
 */
export const VIDEO_DIT_ENGINE = {
  "minimax-h3": "h3",
  "ltx-video": "ltx",
  "ltx-av": "ltx",
};

/** Folder → the loader ComfyUI uses for files in it. */
export const isDitFolder = (folder) => folder === "diffusion_models" || folder === "unet";

/* .gguf is here because a quantised transformer is a model somebody put on the
 * shelf on purpose, and leaving it off the list is the app pretending the file
 * does not exist. Nothing in a GGUF header is probed — the family comes from
 * the name if it can, and otherwise the person says what it is in "loads as".
 * It renders through the ComfyUI-GGUF pack's loader (workflow.js unetNode). */
const WEIGHT_RE = /\.(safetensors|ckpt|sft|gguf)$/i;
const GGUF_RE = /\.gguf$/i;
/* Music and audio weights share these folders and are not image models. */
const NOT_IMAGE = /yue2?|minimax_music|ace[_-]?step|stable_audio/i;

const probeCache = new Map();   // path:mtime -> probe

async function probeCached(full, at) {
  const key = `${full}:${at}`;
  let probe = probeCache.get(key);
  if (!probe) { probe = await probeModel(full); probeCache.set(key, probe); }
  return probe;
}

/** Every base ComfyUI loads models from (the same list the Models screen uses). */
export async function modelBases(config = defaultConfig) {
  return uniqueDirs([
    config.modelsDir,
    ...(config.modelsAlso || []),
    ...(await extraBases(config.comfy?.extraArgs || [])),
    path.join(config.comfyDir, "models"),
  ]);
}

/**
 * What a picked file is and how it must be rendered.
 *
 * `engine` is "checkpoint" for a real checkpoint, or the family's own engine
 * for a DiT — and in that case `dit` is the file to hand its graph. `ok` is
 * false with a plain `why` when nothing here can load it.
 */
/** The only thing a .gguf tells us is its name. Used when nothing can be read. */
export function familyFromName(name) {
  const n = String(name || "").toLowerCase();
  /* This labels a GGUF for an explicit refusal below, not permission to load
   * it. The Qwen 2.1 native graph has no verified GGUF path. */
  if (/qwen[-_ ]?image[-_ ]?2[._ -]?1(?:[^0-9]|$)/.test(n)) return "qwen-image-2.1";
  if (/qwen[-_ ]?image/.test(n)) return "qwen-image";
  if (/z[-_ ]?image/.test(n)) return "zimage";
  if (/anima/.test(n)) return "anima";
  if (/krea/.test(n)) return "krea2";
  if (/flux/.test(n)) return "flux2";
  return null;
}

export function classify(row, probe) {
  const family = probe?.family || null;
  const base = {
    name: row.name, folder: row.folder, bytes: probe?.bytes ?? row.bytes ?? 0, at: probe?.at ?? row.at ?? 0,
    family, variant: probe?.variant ?? null, detail: probe?.detail ?? null,
    dtype: probe?.dtype ?? null, params: probe?.params ?? null, confidence: probe?.confidence ?? null,
    /* The author's own claim, kept BESIDE the tensor evidence and never in
     * place of it. */
    author: probe?.metadata?.["jdx.merge.architecture"] ?? null,
    /* What this architecture wants, so the screen can set sensible numbers
     * when a model is picked instead of handing it another engine's defaults. */
    defaults: presetFor(probe) || FAMILY_PRESET[family] || null,
  };
  if ((probe?.gguf || GGUF_RE.test(row.name)) && /^qwen-image(?:-2\.1)?$/.test(family || "")) {
    return { ...base, engine: null, dit: null, ok: false, loadable: false, gguf: true,
      why: "Qwen GGUF loading is not supported by this Studio's Qwen Image 2.1 graph. Use the native INT8 safetensors release with its matching encoder and VAE; a GGUF filename does not establish compatibility." };
  }
  if (isDitFolder(row.folder)) {
    const engine = DIT_ENGINE[family];
    if (engine) {
      return { ...base, engine, dit: row.name, ok: true, loadable: true, gguf: !!probe?.gguf,
        why: probe?.gguf ? "Quantised GGUF — read by the ComfyUI-GGUF pack's loader, and the family is taken from the file name. Set \"loads as\" if that is wrong." : null };
    }
    /* A quantised file whose name says nothing. It is loadable — the GGUF
     * loader does not care what family it is — but which GRAPH to run it on is
     * a question only the person can answer, so it is offered with that asked
     * rather than refused. */
    if (probe?.gguf) {
      return { ...base, engine: null, dit: row.name, ok: true, loadable: true, gguf: true, needsKind: true,
        why: "Quantised GGUF, and its name does not say which family it is. Choose that under \"loads as\" and it will render on that family's graph." };
    }
    /* A full checkpoint sitting in diffusion_models is the mirror of the bug
     * above, and it is just as fixable by moving one file. */
    if (family === "unet") {
      return { ...base, engine: null, dit: null, ok: false, loadable: false,
        why: "This is a full checkpoint, and UNETLoader cannot open one. Move it to models/checkpoints and it will appear under Checkpoints." };
    }
    return { ...base, engine: null, dit: null, ok: false, loadable: false,
      why: family && family !== "unknown"
        ? `${family} has no engine here that can be pointed at your own file.`
        : "architecture not recognised" };
  }
  const l = loadableAs(probe);
  return { ...base, engine: l.ok ? "checkpoint" : null, dit: null, ok: !!l.ok, loadable: !!l.ok, why: l.why ?? null };
}

/** Both shelves, newest first within each, ready for the picker. */
export async function listPickable(config = defaultConfig) {
  const shelf = await scanBases(await modelBases(config));
  const seen = new Set();
  const rows = shelf.filter((f) => PICK_FOLDERS.includes(f.folder) && WEIGHT_RE.test(f.name)
    && !NOT_IMAGE.test(f.name) && !seen.has(`${f.folder}/${f.name}`) && seen.add(`${f.folder}/${f.name}`));
  const out = [];
  for (const row of rows) {
    /* .ckpt is pickle and .gguf is a container neither probe reads: list them,
     * do not pretend to know them. A .ckpt in models/checkpoints loads as a
     * checkpoint ("unet" here means the SD family); a .gguf in a DiT folder is
     * whatever its name suggests, and unknown is a question for the screen
     * rather than a refusal. */
    const probe = /\.safetensors$/i.test(row.name) ? await probeCached(row.full, row.at)
      : GGUF_RE.test(row.name) ? { bytes: row.bytes, at: row.at, family: familyFromName(row.name), gguf: true }
      : { bytes: row.bytes, at: row.at, family: "unet" };
    out.push(classify(row, probe));
  }
  out.sort((a, b) => PICK_FOLDERS.indexOf(a.folder) - PICK_FOLDERS.indexOf(b.folder) || (b.at || 0) - (a.at || 0));
  return out;
}

/**
 * THE OTHER HALVES. A bare transformer cannot render on its own: it needs a
 * text encoder and a VAE, and which ones is normally decided by its family
 * (the catalogue's files for Z-Image, Anima, FLUX.2, Krea 2). A community
 * model is sometimes trained against a different encoder or a fixed VAE, and
 * nothing in the tensors says so — so the screen offers the shelves and the
 * person decides, with "auto" meaning the family's own.
 */
export async function listParts(config = defaultConfig) {
  const shelf = await scanBases(await modelBases(config));
  const pick = (folders, re) => {
    const seen = new Set();
    return shelf
      .filter((f) => folders.includes(f.folder) && re.test(f.name) && !seen.has(f.name) && seen.add(f.name))
      .map((f) => ({ name: f.name, folder: f.folder, bytes: f.bytes, at: f.at }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };
  return {
    /* ComfyUI reads both names for the same shelf, and a GGUF encoder loads
     * through CLIPLoaderGGUF, so both extensions are listed. */
    encoders: pick(["text_encoders", "clip"], /\.(safetensors|gguf)$/i),
    vaes: pick(["vae"], /\.(safetensors|pt|sft)$/i),
  };
}

/**
 * The video shelf: the transformers in models/diffusion_models, said to be a
 * video model or not.
 *
 * Everything there is listed rather than filtered down to the two families,
 * for the reason the image shelf lists an unloadable file: hiding a file
 * somebody deliberately put there makes the app look broken. What cannot drive
 * a video engine comes back `ok: false` with the reason, and the screen shows
 * it greyed.
 */
export async function listVideoPickable(config = defaultConfig) {
  const all = await listPickable(config);
  return all.filter((r) => isDitFolder(r.folder)).map((r) => {
    const engine = VIDEO_DIT_ENGINE[r.family];
    if (engine) return { ...r, engine, ok: true, loadable: true, why: null };
    return {
      ...r, engine: null, ok: false, loadable: false,
      why: r.family && r.family !== "unknown"
        ? `${r.family} is not a video model — this screen renders with MiniMax H3 or LTX.`
        : "architecture not recognised",
    };
  });
}

/**
 * The Video screen's encoder and VAE shelves, each file said to fit an engine's
 * slot or not.
 *
 * ⚠ THE ANCHOR IS THE ENGINE'S OWN FILE. config.js already names the
 * `textEncoder`, `videoVae` and `audioVae` each engine came with; those are read
 * from disk and everything built the same way is offered. There is no table of
 * "h3 wants qwen3vl" anywhere — a fact like that would be a second copy of
 * something config.js already holds, and the copy is what goes stale.
 *
 * ⚠ A VAE GETS TWO VERDICTS. One file, two rows: the video VAE and the audio
 * VAE read the same folder, and on this shelf nothing is ever right for both.
 * One list for both rows is exactly what made the old dropdown useless.
 *
 * Unknown is not "no". A file this cannot read — a .gguf encoder, a VAE with no
 * embedding tensor — comes back "unknown" and the screen shows it.
 */
const partCache = new Map();                 // full+bytes+mtime -> print

async function printOf(file) {
  const key = `${file.full}|${file.bytes}|${Math.round(file.at)}`;
  if (partCache.has(key)) return partCache.get(key);
  let print = null;
  try { print = await readPart(file.full); } catch { print = null; }
  partCache.set(key, print);
  return print;
}

export async function listVideoParts(config = defaultConfig) {
  const [parts, shelf] = await Promise.all([listParts(config), scanBases(await modelBases(config))]);
  const byName = new Map(shelf.map((f) => [f.name, f]));
  const base = (n) => String(n || "").split(/[\\/]/).pop();
  const engines = config.video?.engines || {};

  /* Each engine's own file for each slot, as a structural print. A slot whose
   * file is not on disk has no anchor, and with no anchor nothing is judged —
   * every file stays listed, which is the right answer to "we cannot say". */
  const anchors = {};
  for (const [eng, cfg] of Object.entries(engines)) {
    anchors[eng] = {};
    for (const slot of ["textEncoder", "videoVae", "audioVae"]) {
      const f = byName.get(base(cfg?.[slot]));
      anchors[eng][slot] = f ? await printOf(f) : null;
    }
  }

  const judge = async (row, slot) => {
    const f = byName.get(row.name);
    const print = f ? await printOf(f) : null;
    const out = {};
    for (const eng of Object.keys(engines)) out[eng] = partFits(print, anchors[eng][slot], slot);
    return out;
  };

  const encoders = [];
  for (const r of parts.encoders) encoders.push({ ...r, fit: await judge(r, "textEncoder") });
  const vaes = [];
  for (const r of parts.vaes) {
    vaes.push({ ...r, fitVideo: await judge(r, "videoVae"), fitAudio: await judge(r, "audioVae") });
  }
  return { encoders, vaes };
}

/**
 * One picked file by name, from either shelf. Checkpoints win a tie, because
 * that is the folder the name came from before this existed.
 */
export async function resolvePick(name, config = defaultConfig) {
  const want = path.basename(String(name || ""));
  if (!want) return null;
  const all = await listPickable(config);
  return all.find((r) => r.name === want) || null;
}

export default { listPickable, listVideoPickable, listParts, listVideoParts, resolvePick, classify, familyFromName, DIT_ENGINE, VIDEO_DIT_ENGINE, PICK_FOLDERS, isDitFolder, modelBases };
