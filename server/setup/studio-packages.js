/**
 * STUDIO'S OWN PYTHON PACKAGES IN STUDIO'S OWN ENGINE.
 *
 * Studio runs three kinds of its own Python in the engine's interpreter
 * (config.python, the ComfyUI venv): the compositor (server/vfx/engine.py
 * imports cv2), clip posters (scripts/clipthumb.py, cv2), hum-to-score
 * (librosa) and the DAW's sampled instruments and mastered bounce
 * (soundfile). ComfyUI's requirements.txt lists scipy, Pillow and av but none
 * of these three, and nothing installed them: on the rig, `pip show
 * opencv-python` says "Required-by: nothing", i.e. installed by hand.
 *
 * So scripts/install-engine.mjs installs them after ComfyUI's requirements,
 * into an engine it made itself and never into anybody else's. The pip line
 * carries a constraints file that pins the torch and numpy ALREADY installed,
 * so resolving librosa (numba, llvmlite) or OpenCV cannot move the engine's
 * torch build or its numpy: the half-transaction trap the rig hit once, when
 * a pip upgrade left ComfyUI unable to start.
 *
 * Node built-ins only, and nothing here runs a process: the installer does.
 */

/** What pip installs. Headless OpenCV: the engine draws no windows, and the
 *  GUI build drags in Qt libraries for nothing. */
export const STUDIO_PACKAGES = ["opencv-python-headless", "librosa", "soundfile"];
/** What each one imports as, in the same order. */
export const STUDIO_MODULES = ["cv2", "librosa", "soundfile"];
/** A plain name for each module, for the sentence a person reads. */
export const MODULE_WORDS = { cv2: "OpenCV (cv2)", librosa: "librosa", soundfile: "soundfile" };

/** The packages whose installed versions the constraints file pins. torch and
 *  numpy are the two that matter; the torch family rides with torch. */
export const PINNED = ["torch", "torchvision", "torchaudio", "numpy"];

/** Python that prints `@@versions {...}`: the installed version of each of PINNED. */
export const VERSIONS_PROBE = [
  "import json, importlib.metadata as m",
  "out = {}",
  `for n in ${JSON.stringify(PINNED)}:`,
  "    try: out[n] = m.version(n)",
  "    except Exception: pass",
  "print('@@versions ' + json.dumps(out))",
].join("\n");

/** Python that prints `@@modules {...}`: true, or the one-line reason, per module.
 *  A real import, not find_spec: cv2 can be present and still fail on a DLL. */
export const MODULES_PROBE = [
  "import importlib, json",
  "out = {}",
  `for n in ${JSON.stringify(STUDIO_MODULES)}:`,
  "    try:",
  "        importlib.import_module(n)",
  "        out[n] = True",
  "    except Exception as e:",
  "        out[n] = (type(e).__name__ + ': ' + str(e)).splitlines()[0][:200]",
  "print('@@modules ' + json.dumps(out))",
].join("\n");

/** The `@@<tag> {json}` line out of a probe's stdout, or null. */
export function probeLine(stdout, tag) {
  for (const l of String(stdout || "").split(/\r?\n/)) {
    if (l.startsWith(`@@${tag} `)) { try { return JSON.parse(l.slice(tag.length + 3)); } catch { return null; } }
  }
  return null;
}

/**
 * The constraints file: one `name==version` per installed package of PINNED.
 * A local version such as 2.13.0+cu130 is kept whole: pip matches it exactly,
 * and the installed wheel satisfies it, so pip has nothing to change.
 * Refuses when torch or numpy is missing, since then there is nothing to pin
 * against and the packages would be installed into a broken engine.
 */
export function constraintsText(versions) {
  const v = versions || {};
  for (const need of ["torch", "numpy"]) {
    if (!v[need]) throw new Error(`The engine has no ${need} installed, so there is nothing to pin Studio's packages against.`);
  }
  return `${PINNED.filter((n) => v[n]).map((n) => `${n}==${v[n]}`).join("\n")}\n`;
}

/** The modules that did not import, from MODULES_PROBE's answer. */
export const missingModules = (answer) =>
  STUDIO_MODULES.filter((m) => answer?.[m] !== true);

/**
 * The one sentence a person reads when Studio's packages are not all there.
 * The engine itself still works, so the install is not undone for this; the
 * sentence says what is affected and where the retry is: the launcher's
 * "Try again" beside "Studio's own packages" (a Setup.exe install has no
 * `node` on PATH), with the command behind it for whoever wants it.
 */
export function studioWarning(missing, reason = "") {
  if (!missing?.length) return null;
  const names = missing.map((m) => MODULE_WORDS[m] || m).join(", ");
  return `The engine works, but Studio's own packages did not all install (missing: ${names})${reason ? `: ${reason}` : ""}. `
    + "Clip posters, the compositor, hum-to-score and the DAW bounce need them; everything else runs. "
    + "To try only these again, press Try again beside \"Studio's own packages\" in the launcher's system check "
    + "(the same as: node scripts/install-engine.mjs --studio-packages, from the Studio folder).";
}
