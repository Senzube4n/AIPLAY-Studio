/**
 * THE LEVEL: Simple or Advanced, the way Music, Pictures and Video open.
 *
 * UI_PLAN E1 and the owner's words of 2026-09-24: "have it open on simple but
 * make it clear there is an advanced with a tooltip option that shows what you
 * get". So there are three things here and every one of them is served, never
 * typed into the page:
 *
 *   the level        config.ui.level, decided in server/config.js startLevel():
 *                    a new install opens Simple, an install already in use
 *                    keeps Advanced. Saved in settings.json as prefs.ui.level
 *                    (it is a PREF_PATHS entry, so savePrefs() carries it too).
 *   who chose it     config.ui.levelBy, "studio" until the person changes it.
 *                    Settings says which, because "never pick for them
 *                    silently" includes this choice.
 *   what Advanced adds, per screen   ADVANCED_ADDS below: the tooltip on each
 *                    screen's Advanced switch, and what studio_welcome tells an
 *                    agent. Each line names the control ids it is about, and
 *                    server/welcome/level_test.js fails if one is not in
 *                    web/index.html, so the tooltip cannot promise a control
 *                    that has gone.
 *
 * The per-screen Simple / Advanced buttons stay what they were: a choice for
 * this visit. The saved level is changed in one place, "Show every setting"
 * (Settings, the foot of the rail, and studio_welcome {action:"level"}), and
 * that is why a person who presses Advanced on Video once is not moved to
 * Advanced for ever.
 */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { config, LEVELS } from "../config.js";

/* One line per thing Advanced adds, in the order the screen shows them. `ids`
 * is what the sentence is about (checked against the page, and for Pictures
 * and Video checked to be something Simple really hides); `say` is what the
 * tooltip prints. Short on purpose: a tooltip is read in one glance. The keys
 * are the screens that have a Simple form, served as `screens`, so the page
 * keeps no list of its own. */
export const ADVANCED_ADDS = {
  create: [
    { say: "the Lyrics and Styles boxes, written by hand", ids: ["lyricsBox", "stylesBox"] },
    { say: "length, seed, steps and guidance", ids: ["maxDur", "seed", "qSteps", "qCfg"] },
    { say: "the music model and its own settings", ids: ["musicEngine"] },
    /* A tester looked for the melody box and found only "More Options": it is
     * YuE2's "Melody & score", and the tooltip names it. */
    { say: "Melody & score (hum a tune or paste a score for YuE2 to sing)", ids: ["yMusicPlan", "humRec", "yAbc"] },
    { say: "a song dropped in to reuse its words and style", ids: ["songRef"] },
    { say: "Preview, the cheap first pass", ids: ["btnPreview"] },
  ],
  images: [
    { say: "size, steps, CFG, sampler and scheduler", ids: ["imgSize", "imgSteps", "imgCfg", "imgSampler", "imgSched"] },
    { say: "the model file, LoRAs, VAE and text encoder", ids: ["imgEngine", "imgCkpt", "imgLoras", "imgVae", "imgEncoder"] },
    { say: "negative prompt, seed and how many", ids: ["imgNeg", "imgSeed", "imgCount"] },
    /* Not "characters": the character picker sits in the reference box, which
     * Simple keeps on screen. */
    { say: "templates", ids: ["imgTpl"] },
  ],
  video: [
    { say: "steps and the quality chips", ids: ["vidSteps", "vidQualityRow"] },
    { say: "size and length", ids: ["vidSize", "vidSecs"] },
    { say: "the engine, its files and LoRAs", ids: ["vidEngine", "vidModel", "vidLoras"] },
    /* FastH3 is in the engine list since 2026-09-25, not a switch of its own. */
    { say: "attention and sparse attention", ids: ["vidAttn", "vidSparse"] },
    { say: "what a size needs on this card's graphics memory", ids: ["vidFitNote"] },
    /* Not the song under the clip or Keep my character: Simple shows both
     * since 2026-09-24 (the REWIND A/B, DIRECTING.md §2). */
    { say: "an end frame, and the References box: pictures and sounds by tag", ids: ["vidTo", "vidRefWrap"] },
    { say: "the Video Lab: sizes and side-by-side tests", ids: ["vidLab"] },
  ],
};

/* The tooltip, composed here so the page and an agent read one sentence. */
export const advancedTip = (view) => {
  const adds = ADVANCED_ADDS[view];
  return adds ? `Advanced adds ${adds.map((a) => a.say).join("; ")}.` : null;
};

/* Settings' one line under the switch: who chose, and why. */
export function levelLine(level, by, unreadable = null) {
  if (by === "you") return level === "simple" ? "You chose Simple." : "You chose Advanced.";
  if (unreadable) {
    return "Studio kept Advanced because settings.json could not be read, and wrote nothing over it. "
      + "Fix the file (or move it aside) and restart Studio.";
  }
  return level === "simple"
    ? "Studio chose Simple because this is a new install."
    : "Studio kept Advanced because this copy was already in use.";
}

/** What the door, the page and studio_welcome all return. */
export function levelState() {
  const level = config.ui?.level ?? "advanced";
  const by = config.ui?.levelBy ?? "studio";
  const unreadable = config.ui?.unreadable || null;
  return {
    level, levelBy: by, levels: LEVELS,
    line: levelLine(level, by, unreadable),
    ...(unreadable ? { unreadable } : {}),
    /* The screens that open on the level; web/level.js keeps no list of its own. */
    screens: Object.keys(ADVANCED_ADDS),
    advancedAdds: Object.fromEntries(Object.keys(ADVANCED_ADDS).map((v) => [v, advancedTip(v)])),
    advancedIds: Object.fromEntries(Object.entries(ADVANCED_ADDS).map(([v, a]) => [v, a.flatMap((x) => x.ids)])),
  };
}

/* An error that carries the status the door answers with. */
const failure = (message, status) => Object.assign(new Error(message), { status });

/* Read-modify-write of ONE key, prefs.ui, the same shape the welcome flag
 * uses. Not savePrefs(): that writes every preference's current value, and a
 * first start must not freeze machine-chosen defaults into the file (UI_PLAN
 * A1: defaults are worked out when read, never written).
 *
 * ONLY A MISSING FILE starts from nothing. A file that is there and cannot be
 * read or parsed (a hand edit with a trailing comma, a byte-order mark from
 * PowerShell) is refused: writing `{prefs:{ui}}` over it would erase the rig,
 * the python, the models folder, the keys, and the person could never get
 * them back by fixing the comma. */
async function writeUi(ui) {
  let cur = {};
  let text = null;
  try { text = await readFile(config.settingsFile, "utf-8"); }
  catch (err) { if (err?.code !== "ENOENT") throw failure(`settings.json could not be read (${err.message}), so nothing was written.`, 409); }
  if (text !== null) {
    try { cur = JSON.parse(text); }
    catch (err) { throw failure(`settings.json could not be parsed (${err.message}), so nothing was written. Fix the file (or move it aside) and try again.`, 409); }
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) throw failure("settings.json does not hold a settings object, so nothing was written.", 409);
  }
  const prefs = { ...(cur.prefs || {}), ui: { ...(cur.prefs?.ui || {}), ...ui } };
  /* A prefs block THIS write creates carries config.js's `keptFromBefore`
   * marker, empty: "this Studio wrote the file, nothing was kept from an
   * older one". Without it the next start reads {prefs:{ui}} as an older
   * Studio's file and pins pictures to the literal engine as "Saved in your
   * settings" (config.js, SETTINGS AN OLDER STUDIO WROTE). A prefs block that
   * was already there is left as it is, marker or not, so an older install's
   * values stay "kept". */
  if (!cur.prefs || typeof cur.prefs !== "object") prefs.keptFromBefore = [];
  await mkdir(path.dirname(config.settingsFile), { recursive: true });
  await writeFile(config.settingsFile, JSON.stringify({ ...cur, prefs }, null, 2));
}

/** A person (or an agent on their behalf) chose a level. Written first, so a
 *  file that refuses leaves the running level as it was. */
export async function saveLevel(level) {
  if (!LEVELS.includes(level)) throw failure(`level must be one of: ${LEVELS.join(", ")}.`, 400);
  await writeUi({ level, levelBy: "you" });
  const { unreadable, ...rest } = config.ui || {};
  config.ui = { ...rest, level, levelBy: "you", saved: true };
  return levelState();
}

/* SONGS ALREADY MADE are the other sign of an install in use: somebody who
 * only ever ran Music with the default settings has no key config.js counts,
 * and has a library. Studio's own files by their prefixes (the library's gate,
 * server/index.js), in the folder Studio renders into. */
const STUDIO_MADE = /^(aiplay|preview|edit|extend|merge)[^\\/]*\.(flac|mp3|opus|wav|png|jpe?g|webp|mp4|webm)$/i;
async function hasLibrary() {
  try { return (await readdir(config.outputDir)).some((n) => STUDIO_MADE.test(n)); }
  catch { return false; }
}

/**
 * On the first start, write down what Studio chose, so the answer cannot
 * change under the person later: without it, the first thing that writes an
 * `api` or `welcome` key would turn a new install into an "install already in
 * use" at the next start, and it would open Advanced for no reason it could
 * explain. Nothing is written when the level was already saved, and nothing
 * at all when settings.json is there but could not be read.
 */
export async function persistStartLevel() {
  if (!config.ui || config.ui.saved) return false;
  if (config.ui.unreadable) {
    console.warn(`  [settings] settings.json could not be read (${config.ui.unreadable}); `
      + "Studio kept Advanced and wrote nothing over it.");
    return false;
  }
  if (config.ui.level === "simple" && config.ui.levelBy === "studio" && await hasLibrary()) {
    config.ui = { ...config.ui, level: "advanced" };
  }
  await writeUi({ level: config.ui.level, levelBy: config.ui.levelBy });
  config.ui = { ...config.ui, saved: true };
  return true;
}
