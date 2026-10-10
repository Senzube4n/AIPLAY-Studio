/**
 * FAST COVERS (2026-09-27): a small cover for every song, drawn on the
 * processor by Supra2-IMG (https://huggingface.co/SupraLabs/Supra2-IMG,
 * Apache-2.0, 104M parameters, 256 px).
 *
 * Settings > Experimental, on by default. The first time Studio opens after
 * it arrives, an in-app question (web/fastcovers.js) offers to switch it off;
 * left on, Studio sets up its Python (setup/venv.js recipe "covers": CPU
 * PyTorch, transformers, diffusers) and fetches the Models row "fastCover"
 * (every file pinned and hashed) by itself. Once both are there, song covers
 * are drawn here instead of by the picture engine: about 8 s on a Ryzen 7
 * 5700X, the card untouched, so a cover no longer waits for ComfyUI or evicts
 * the music model. The Images screen keeps the picture engines.
 *
 * THE PROMPT IS ITS OWN. Measured the same day on real songs from the
 * library: Studio's cover prompt (config.art.style + "evoking <lyric hook>")
 * came back murky and lettered. The style's "no text, no words, no letters"
 * is read by a model this small as a request for text, and a sung line in the
 * prompt comes back painted as gibberish letters (its training set, FLUX-
 * Reason-6M, is heavy on typography). Plain visual nouns drew clean covers:
 * a scene from the genre, the concrete words of the hook in it, and a short
 * positive style. fastCoverPrompt() builds exactly that.
 */
import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lyricHook } from "./workflow.js";

export const FAST_COVER_ENGINE = "supra2-img";
/** The Models row (models.js) and the setup recipe (setup/venv.js). */
export const FAST_COVER_ID = "fastCover";
export const FAST_COVER_SETUP = "covers";
export const FAST_COVER_SCRIPT = fileURLToPath(new URL("./fastcover_run.py", import.meta.url));
export const RESULT_MARKER = "FASTCOVER_RESULT_JSON:";
/** 25 steps looked the same as the 50 SupraLabs suggest, in half the time. */
export const FAST_COVER_STEPS = 25;
export const FAST_COVER_CFG = 3;
/** A stuck program is stopped: a cover takes seconds, the first one ~30 s. */
export const FAST_COVER_TIMEOUT_MS = 5 * 60_000;

/* A scene per genre family, first match wins. Visual nouns only. */
const SCENES = [
  [/hip.?hop|\brap\b|drill|boom.?bap|\btrap\b|grime/i, "city street at night with graffiti walls and streetlights"],
  [/trip.?hop|lo.?fi|chill.?hop|downtempo/i, "rainy window with city lights at dusk"],
  [/metal|hardcore|doom/i, "stormy volcanic mountains under lightning"],
  [/punk|garage|grunge|\brock\b|indie rock/i, "empty concert stage with red lights and smoke"],
  [/techno|house|\bedm\b|trance|electro|synth|dubstep|drum and bass|dnb/i, "neon city skyline with purple and blue lights"],
  [/jazz|blues|soul|funk/i, "smoky jazz club with a warm spotlight"],
  [/folk|acoustic|country|bluegrass/i, "wooden porch at golden hour in the countryside"],
  [/ambient|classical|orchestral|piano|cinematic|score/i, "misty mountain lake at dawn"],
  [/r&b|rnb|neo.?soul/i, "city rooftop at sunset with a warm glow"],
  [/reggae|dancehall|latin|salsa|afro/i, "tropical beach at sunset with palm trees"],
  [/gospel|choir|hymn/i, "sunlight through tall cathedral windows"],
  [/\bpop\b|dance|disco/i, "bright colorful sky with clouds at sunset"],
];
/* When the caption names no family: one of these, by seed. */
const OPEN_SCENES = [
  "dreamy landscape under a colorful sky", "moonlit ocean with gentle waves",
  "forest path with soft morning light", "desert road under a starry night sky",
  "field of wildflowers at sunset", "quiet harbor with boats at dawn",
];
const STYLE = "vibrant digital painting, cinematic lighting, detailed";

/* Words that are not things to draw. The hook is a sung line; what survives
 * this is its nouns and a few adjectives, which the model draws well. */
const STOP = new Set(("a an the and or but so to of in on at by for with from into onto up down out over under "
  + "again then once here there when where why how all any both each every few more most other some such no nor "
  + "not only own same than too very can will just should now never ever always still even also i me my myself "
  + "we us our you your yours he him his she her it its they them their what which who whom this that these those "
  + "am is are was were be been being have has had do does did would could might must shall oh yeah hey la na "
  + "ooh uh ah woah baby got get gets gonna wanna gotta let lets like know feel make made take give come go goes "
  + "back tonight night day time way one thing things something nothing everything cause cuz tell said say see "
  + "look want need keep stay left right around away through till until inside outside twice").split(/\s+/));

const drawable = (text) => String(text).toLowerCase().replace(/[^a-z\s'-]/g, " ").split(/\s+/)
  .filter((w) => w.length > 2 && !STOP.has(w) && !/ing$|ed$|'|^-|-$/.test(w));

/**
 * Up to two words worth drawing, or []: the hook's words, ranked by how often
 * the whole lyric sings them, the longer first on a tie. Reported 2026-09-27:
 * "I love raw cheese", sung 38 times, drew "love and raw" when the hook's
 * first two words were taken; what a song repeats most is what it is about,
 * and a longer word is more often a thing than a feeling.
 */
export function hookNouns(lyrics = "") {
  const hook = [...new Set(drawable(lyricHook(lyrics) || ""))];
  if (!hook.length) return [];
  const count = new Map();
  for (const w of drawable(String(lyrics).replace(/^\s*\[[^\]\n]*\]\s*$/gm, ""))) count.set(w, (count.get(w) || 0) + 1);
  return hook.sort((a, b) => (count.get(b) || 0) - (count.get(a) || 0) || b.length - a.length).slice(0, 2);
}

/** The prompt Supra2-IMG draws a song's cover from. */
export function fastCoverPrompt({ caption = "", lyrics = "", seed = 0 } = {}) {
  const hit = SCENES.find(([re]) => re.test(String(caption)));
  const scene = hit ? hit[1] : OPEN_SCENES[Math.abs(Number(seed) || 0) % OPEN_SCENES.length];
  const nouns = hookNouns(lyrics);
  return `${nouns.length ? `${nouns.join(" and ")} in a ` : ""}${scene}, ${STYLE}`;
}

/** The runner's arguments. */
export function fastCoverArgs({ models, prompt, seed, out, thumb, size, thumbSize }) {
  return [FAST_COVER_SCRIPT, "--models", models, "--prompt", prompt, "--seed", String(Math.abs(Math.trunc(Number(seed) || 0))),
    "--steps", String(FAST_COVER_STEPS), "--cfg", String(FAST_COVER_CFG),
    "--size", String(size), "--thumb-size", String(thumbSize), "--out", out, "--thumb", thumb];
}

/** The runner's result line, or null. */
export function parseResult(stdout = "") {
  const line = String(stdout).split(/\r?\n/).reverse().find((l) => l.startsWith(RESULT_MARKER));
  if (!line) return null;
  try { return JSON.parse(line.slice(RESULT_MARKER.length)); } catch { return null; }
}

/** Every file of the Models row at its exact size. */
export function filesReady(row) {
  if (!row?.files?.length) return false;
  return row.files.every((f) => {
    try { return statSync(f.dest).size === f.bytes; } catch { return false; }
  });
}

/**
 * The fast-covers service. `config.art.fastCovers` is the switch,
 * `config.art.fastCoversAsked` whether the first-run question was answered,
 * `config.art.fastCoverPython` the Python the setup built.
 *   use()     sync: on, asked, the Python there and every file present
 *   status()  what Settings and the question show
 *   ensure()  switched on and not ready: set up the Python and fetch the files
 *   render()  one cover
 */
export function createFastCovers({ config, catalog, models, setup, save }) {
  const row = () => catalog.find((c) => c.id === FAST_COVER_ID);
  const modelsDir = () => path.dirname(path.dirname(row().files[0].dest));
  const python = () => config.art.fastCoverPython || null;
  const pythonReady = () => !!python() && existsSync(python());
  let starting = null;
  let lastError = null;

  const service = {
    use() {
      return config.art.fastCovers === true && config.art.fastCoversAsked === true && pythonReady() && filesReady(row());
    },

    async status() {
      const files = filesReady(row());
      /* The setup's own status imports the modules in its Python (seconds):
       * asked only while the Python is not there yet. */
      const setupState = pythonReady() ? null
        : await setup.status(FAST_COVER_SETUP).then((s) => s?.setups?.[0] || null).catch(() => null);
      const dl = files ? null : (await models.status().catch(() => []))?.find?.((c) => c.id === FAST_COVER_ID) || null;
      const job = setupState?.job || null;
      return {
        enabled: config.art.fastCovers === true,
        asked: config.art.fastCoversAsked === true,
        ready: service.use(),
        python: pythonReady(), files,
        settingUp: job?.state === "running" ? { step: job.label || job.step || null, n: job.n ?? null, of: job.of ?? null } : null,
        downloading: dl?.downloading && dl.progress?.state !== "failed"
          ? { receivedBytes: dl.progress?.received ?? dl.haveBytes ?? 0, totalBytes: dl.progress?.total ?? dl.totalBytes ?? null } : null,
        totalBytes: row().files.reduce((n, f) => n + f.bytes, 0),
        error: lastError || (dl?.progress?.state === "failed" ? dl.progress.error || null : null)
          || (job?.state === "failed" ? job.message || job.error || null : null),
      };
    },

    /** Start whatever is missing; answers at once, the work goes on. */
    async ensure() {
      if (config.art.fastCovers !== true || config.art.fastCoversAsked !== true || service.use()) return service.status();
      if (!starting) {
        lastError = null;
        starting = (async () => {
          const jobs = [];
          if (!filesReady(row())) jobs.push(models.download(FAST_COVER_ID));
          if (!pythonReady()) jobs.push(setup.run(FAST_COVER_SETUP, { torch: "cpu" }));
          const results = await Promise.allSettled(jobs);
          const failed = results.find((r) => r.status === "rejected");
          if (failed) lastError = String(failed.reason?.message || failed.reason);
        })().finally(() => { starting = null; });
      }
      return service.status();
    },

    /** One cover through `run` (art.js #runChild, so Stop reaches it). */
    async render(job, { out, thumb, run, size = config.art.size || 1024, thumbSize = config.art.thumbSize || 256 }) {
      const prompt = fastCoverPrompt({ caption: job.caption, lyrics: job.lyrics, seed: job.seed });
      const argv = fastCoverArgs({ models: modelsDir(), prompt, seed: job.seed, out, thumb, size, thumbSize });
      const start = () => {
        const proc = spawn(python(), argv, { windowsHide: true, detached: process.platform !== "win32",
          env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", CUDA_VISIBLE_DEVICES: "", HIP_VISIBLE_DEVICES: "" } });
        const timer = setTimeout(() => proc.kill(), FAST_COVER_TIMEOUT_MS);
        proc.once("close", () => clearTimeout(timer));
        return proc;
      };
      const r = await run(start);
      if (r.spawnError) throw new Error(`Fast covers could not start their Python (${r.spawnError.message}).`);
      const done = parseResult(r.stdout);
      if (!done) {
        const tail = String(r.stderr || "").trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ");
        throw new Error(`Fast cover failed${r.code !== null ? ` (exit ${r.code})` : ""}${tail ? `: ${tail}` : "."}`);
      }
      job.usedPrompt = prompt;
      return done;
    },

    async setEnabled(on, { asked = true } = {}) {
      config.art.fastCovers = on === true;
      if (asked) config.art.fastCoversAsked = true;
      await save();
      if (config.art.fastCovers) await service.ensure();
      return service.status();
    },
  };
  return service;
}
