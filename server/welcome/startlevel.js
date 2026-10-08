/**
 * THE LEVEL A START OPENS ON, as a pure function of settings.json.
 *
 * Import-free on purpose: server/config.js decides the level with it at boot,
 * and the launcher (launcher/checks.mjs) reads the same answer before Studio
 * has started, to show or hide the launch modes that are Advanced only. The
 * launcher may not import config.js (it computes a whole Studio configuration
 * at import), so the rule lives here, once, and both import it.
 *
 * UI_PLAN E1, the owner's decision of 2026-09-24: a NEW install opens Music,
 * Pictures and Video on Simple; an install that was already in use, the
 * owner's included, keeps Advanced.
 *
 * "Already in use" is not "settings.json exists": the launcher and the engine
 * installer write that file (rig, python, gpu) before Studio's first start, so
 * on a fresh install it is always there. What only a Studio that has RUN
 * writes is IN_USE_KEYS below: prefs, the welcome flag, the API mode, the
 * Agent page's keys, a saved workflow, a chosen writing model, a model
 * override, the DAW's latency. (modelsDir, modelsAlso, outputDir and rig are
 * not in it: the launcher writes those too.) Songs already made are the other
 * sign, and server/welcome/level.js reads the library for them before saving
 * Simple on the first start; the launcher does not read the library, so until
 * that first start it can read Simple where Studio will save Advanced.
 * `levelBy` says who chose, so Settings can say "Studio chose Simple for a new
 * install" rather than pretending the person did.
 *
 * A FILE THAT IS THERE AND CANNOT BE READ is not a new install: it is an
 * install whose file has a trailing comma or a byte-order mark. It keeps
 * Advanced, and nothing is written over it (`unreadable`), so fixing the comma
 * brings every setting back as it was.
 * server/welcome/level.js saves the answer on the first start and on every
 * change; server/welcome/level_test.js walks every kind of install.
 */
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

/**
 * The same answer from the file's TEXT, read exactly as config.js reads it:
 * null (no file) is a fresh install, and text JSON.parse refuses (a trailing
 * comma, a byte-order mark, which readFileSync's "utf-8" keeps) is
 * `unreadable` and keeps Advanced.
 */
export function levelFromSettingsText(text) {
  if (text === null || text === undefined) return startLevel({});
  let parsed;
  try { parsed = JSON.parse(String(text)) || {}; }
  catch (err) { return startLevel({}, { unreadable: err?.message || String(err) }); }
  return startLevel(parsed);
}
