/**
 * THE VOICE LAB'S UI — the static gates the panel stands on.
 *
 * server/daw/ui_test.js is the census for web/daw.js. It reads that one file,
 * so a second web module could post an action nobody dispatches, hard-code a
 * knob name the agent has and a person does not, or invent a palette, and no
 * commit would ever fail. This file is the same census, applied to
 * web/voicelab.js and web/voicelab.css and to the three lines they occupy in
 * web/daw.html — plus the two rules that are this panel's own:
 *
 *   1. THE PARITY GATE. Every `action: "…"` the panel posts must be an action
 *      routes.js, mixer.js or voicelab.js actually dispatches, and every
 *      /api/daw/… it reads must be a route routes.js serves. The panel writes
 *      through exactly ONE action, `set_track`, which is the action
 *      daw_set_track posts and the action the instrument column's knobs post.
 *
 *   2. NO KNOB NAME IN THE PAGE. Not one of the ~90 parameters patches.json
 *      declares may appear as a literal in voicelab.js. The rack is built from
 *      the schema the server hands back, so a knob synths.py grows draws for
 *      free — the rule ui_test.js already enforces on daw.js's own panel.
 *
 *   3. A PREVIEW IS NOT AN EDIT. The render path must carry `params_override`
 *      and must not carry `set_track`, and the only writer must be the Apply
 *      handler. This is the difference between "try it" and seventeen undo
 *      entries, and it is the one property of this panel that cannot be seen
 *      by looking at it.
 *
 *   4. THE MEASUREMENT IS REAL. The clock must be stamped at the gesture and
 *      read after the draw, and the budget must be a named constant rather
 *      than a number in a string — otherwise "≤100 ms" is a claim about a
 *      sentence instead of about the panel.
 *
 *   5. THE REFERENCE OVERLAY DRAWS A MEASUREMENT OR IT DRAWS NOTHING. Every
 *      line behind ours must come out of the fetched profile; nothing may be
 *      interpolated, defaulted or averaged to make a curve fit; and the two
 *      families of number that are NOT comparable between one note and a
 *      finished record (level and loudness) must never be subtracted. §6.
 *
 *      This file is also the census for the ONE place web/dawear.js reaches
 *      across to /api/daw. The Ear talks to /api/daw/ear, which is why
 *      ui_test.js deliberately does not read it — but the reference LIBRARY
 *      is not behind that door, so the Ear's row posts `profile_list` on the
 *      main one. That crossing is held to exactly one action here (§10),
 *      because an uncounted second door is how three actions shipped with no
 *      tool.
 *
 * Runs standalone (`node server/daw/voiceui_test.js`) and in the pre-commit
 * hook. Reads web/ and server/daw/; touches nothing else and starts nothing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PATCHES } from "./store.js";
import { MIXER_ACTIONS } from "./mixer.js";
import { VOICELAB_ACTIONS, laneOf } from "./voicelab.js";
/* the agent's tool list, for the one parameter-level cross-check this file
 * makes: the Ear's reference row and daw_critique must take the same field */
import { dawTools } from "../mcp-daw.js";
/* THE FOURTH DISPATCHER, imported the way ui_test.js imports the third: the
 * reference profile's route half is an OPTIONAL mount, so its actions count
 * as dispatched when the module is on the tree and are orphans when it is
 * not — which is the rule, and it is why the panel's four profile_* posts
 * are checked against refprofile.js's OWN exported list rather than against a
 * copy kept here. */
const refprofile = await import("./refprofile.js").catch(() => null);

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, "..", "..", "web");
const JS = readFileSync(path.join(WEB, "voicelab.js"), "utf8");
const CSS = readFileSync(path.join(WEB, "voicelab.css"), "utf8");
const HTML = readFileSync(path.join(WEB, "daw.html"), "utf8");
const DAWCSS = readFileSync(path.join(WEB, "daw.css"), "utf8");
const STYLES = readFileSync(path.join(WEB, "styles.css"), "utf8");
const ROUTES = readFileSync(path.join(HERE, "routes.js"), "utf8");
const VLJS = readFileSync(path.join(HERE, "voicelab.js"), "utf8");
const EARJS = readFileSync(path.join(WEB, "dawear.js"), "utf8");

/* Strip comments and quoted prose before looking for code shapes: a sentence
 * in a docblock must not be able to pass or fail a structural check. */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const CODE = stripComments(JS);
const CSSCODE = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/** Brace-match a named function's body out of the source. */
function bodyOf(src, header) {
  const i = src.indexOf(header);
  if (i < 0) return null;
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") { depth++; started = true; }
    else if (src[j] === "}") { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  return null;
}

/* ══════════════════════════ 1. THE PARITY GATE ══════════════════════════ */

console.log("\n  -- every gesture posts an action the server actually has --");
{
  const routeActions = new Set([...ROUTES.matchAll(/^\s*case "([a-z_]+)": \{/gm)].map((m) => m[1]));
  for (const a of MIXER_ACTIONS) routeActions.add(a);
  for (const a of VOICELAB_ACTIONS) routeActions.add(a);
  for (const a of refprofile?.REFPROFILE_ACTIONS || []) routeActions.add(a);
  ok(`routes.js + mixer.js + voicelab.js dispatch ${routeActions.size} actions`, routeActions.size > 30);

  const posted = [...new Set([...CODE.matchAll(/\baction:\s*"([a-z_]+)"/g)].map((m) => m[1]))].sort();
  ok(`the panel posts ${posted.length} distinct actions (${posted.join(", ")})`, posted.length >= 3);

  const orphans = posted.filter((a) => !routeActions.has(a));
  ok("every action the panel posts exists on the server — no parallel write path",
    orphans.length === 0, `orphans: ${orphans.join(", ")}`);

  /* Named, so that deleting one from the panel is a decision rather than an
   * accident, and so that adding an eighth has to be argued for here. The
   * four profile_* are the reference overlay's whole surface: list what this
   * machine has measured, read one, build one, forget one. */
  ok("...and they are exactly voice_lab, peaks, set_track and the four profile routes",
    posted.join(",") === "peaks,profile_build,profile_delete,profile_get,profile_list,"
      + "set_track,voice_lab", posted.join(","));

  const gets = [...new Set([...CODE.matchAll(/["'`]\/api\/daw\/([a-z0-9.]+)/gi)].map((m) => m[1]))];
  const served = [...new Set([...ROUTES.matchAll(/"\/api\/daw\/([a-z0-9.]+)/gi)].map((m) => m[1]))];
  const badGets = gets.filter((g) => !served.includes(g));
  ok(`every /api/daw/… read the panel makes is a route routes.js serves (${gets.join(", ")})`,
    badGets.length === 0, `unknown: ${badGets.join(", ")}`);

  ok("the panel's POST helper stamps by:\"user\" (and never by:\"agent\")",
    /body:\s*JSON\.stringify\(\{\s*by:\s*"user"/.test(CODE) && !/by:\s*"agent"/.test(CODE));
  ok("there is exactly ONE post helper — no second fetch with its own body shape",
    (CODE.match(/fetch\(/g) || []).length === 2, "one POST helper, one GET helper");
}

/* ═══════════ 2. A PREVIEW IS NOT AN EDIT ════════════════════════════════ */

console.log("\n  -- a knob is a preview; the document moves once, on apply --");
{
  const pump = bodyOf(CODE, "async function pump()") || "";
  const apply = bodyOf(CODE, "async function apply()") || "";
  const undo = bodyOf(CODE, "async function undoApply()") || "";
  const ov = bodyOf(CODE, "function overrideBody()") || "";
  ok("the render loop, the writer, its inverse and the override builder all exist",
    !!pump && !!apply && !!undo && !!ov);

  ok("the render loop posts voice_lab with params_override and analysis",
    /action:\s*"voice_lab"/.test(pump) && /params_override:\s*ov/.test(pump) && /analysis:\s*true/.test(pump));
  ok("...and writes NOTHING: no set_track, no mutating action anywhere in it",
    !/set_track/.test(pump) && !/action:\s*"(?!voice_lab|peaks)/.test(pump));
  ok("...and sends no override at all when the sliders agree with the document, "
     + "so the first render shares preview_note's cached file",
    /Object\.keys\(ov\)\.length \? ov : null/.test(ov)
    && /\.\.\.\(ov \? \{ params_override: ov \} : \{\}\)/.test(pump));

  ok("apply writes through set_track — the action daw_set_track posts",
    /action:\s*"set_track"/.test(apply));
  ok("...merged onto the track's other knobs first (set_track REPLACES params)",
    /params:\s*\{ \.\.\.before, \.\.\.ov \}/.test(apply)
    && /const before = \{ \.\.\.V\.base \}/.test(apply));
  ok("...and the previous params are kept as the inverse, so the write is undoable",
    /V\.applied = before/.test(apply) && /params:\s*V\.applied/.test(undo));
  ok("set_track appears in the writer and its inverse and NOWHERE else",
    (CODE.match(/action:\s*"set_track"/g) || []).length === 2);
  ok("apply refuses when there is nothing to write, rather than posting a no-op version",
    /if \(!ov\)/.test(apply));
}

/* ═══════════ 3. NO KNOB NAME IN THE PAGE ════════════════════════════════ */

console.log("\n  -- every knob a patch declares is a knob this panel draws, and none is written here --");
{
  const knobbed = Object.entries(PATCHES)
    .filter(([, r]) => r.kind === "builtin" && r.params && Object.keys(r.params).length);
  const knobNames = new Set(knobbed.flatMap(([, r]) => Object.keys(r.params)));
  ok(`patches.json declares ${knobNames.size} distinct knobs across ${knobbed.length} builtin patches`,
    knobNames.size >= 50);

  /* The real guard, the same one ui_test.js puts on daw.js's panel, but over
   * the WHOLE module rather than three functions: a knob name as a literal
   * anywhere here means a knob that was drawn because someone typed it, and a
   * knob synths.py grows would not appear.
   *
   * Exactly one declared knob is also a word the DOM owns, and pretending
   * otherwise would mean either a false failure for ever or a weaker guard.
   * So it is written down, with its reason, and the exception is CHECKED: every
   * occurrence of it in the module must be a listener registration and nothing
   * else. If a line ever reads that knob by name, this fails. */
  const DOM_WORDS = {
    click: "the DOM event name. hybrid_kick declares a `click` knob too, so the "
      + "collision is real — but every occurrence of the word in this module is "
      + "addEventListener(\"click\", …), and the check below is exactly that.",
  };
  const leaked = [...knobNames].filter((n) =>
    !DOM_WORDS[n]
    && (new RegExp(`["'\`]${n}["'\`]`).test(CODE) || new RegExp(`\\b${n}\\s*:`).test(CODE)));
  ok(`none of the ${knobNames.size} declared knobs is hard-coded in voicelab.js`,
    leaked.length === 0, leaked.join(", "));

  for (const [word, why] of Object.entries(DOM_WORDS)) {
    ok(`...and the one written-down exception (\`${word}\`) is a real declared knob`,
      knobNames.has(word), why);
    /* The same two shapes the leak scan looks for — a quoted whole token, or a
     * property key — because those are the two ways a parameter is ever named
     * in code. Prose that happens to contain the letters (a tooltip saying
     * "double-click to put it back") is not a parameter read. */
    const asToken = new RegExp(`["'\`]${word}["'\`]`);
    const asKey = new RegExp(`\\b${word}\\s*:`);
    const lines = CODE.split("\n").filter((l) => asToken.test(l) || asKey.test(l));
    const notListeners = lines.filter((l) => !new RegExp(`addEventListener\\("${word}"`).test(l));
    ok(`...and every one of its ${lines.length} occurrences is a listener, never a parameter read`,
      lines.length > 0 && notListeners.length === 0,
      notListeners.map((l) => l.trim().slice(0, 80)).join(" | "));
  }

  const draw = bodyOf(CODE, "function drawKnobs()") || "";
  ok("the rack is built by walking the SERVED schema, not a list of its own",
    /Object\.keys\(V\.schema\)/.test(draw) && /V\.schema\[pname\]/.test(draw));
  ok("a knob's range, default, unit and doc come from that row, not from this file",
    ["spec.min", "spec.max", "spec.default", "spec.unit", "spec.doc"].every((s) => draw.includes(s)));
  ok("a knob is LABELLED with the parameter's own key — the string set_track will carry",
    /EL\("span", "vl-kname", pname\)/.test(draw));
  ok("a knob reads the track's own value, falling back to the declared default "
     + "(defaults are not stored)",
    /V\.knob\[pname\] \?\? def/.test(draw));
  ok("presets are the row's OWN params and are a PREVIEW, not a write",
    /V\.presets/.test(draw) && /\{ \.\.\.V\.base, \.\.\.\(p\.params \|\| \{\}\) \}/.test(draw)
    && !/set_track/.test(draw));
  ok("the schema comes from the palette route, which serves patches.json's own table",
    /\/api\/daw\/patches/.test(CODE) && /row\?\.params \|\| \{\}/.test(CODE));
  ok("the panel says which knobs are NOT its own (transpose and gain_db are the track's)",
    /transpose and gain_db belong to the track/.test(JS));
}

/* ═══════════ 4. THE CLOCK IS A MEASUREMENT ══════════════════════════════ */

console.log("\n  -- the number in the panel is measured, not asserted --");
{
  const pump = bodyOf(CODE, "async function pump()") || "";
  const bump = bodyOf(CODE, "function bump(why)") || "";
  const rec = bodyOf(CODE, "function record(trip, total, r, why)") || "";
  ok("the budget is a named constant, not a number inside a sentence",
    /const BUDGET_MS = 100;/.test(CODE) && /total > BUDGET_MS/.test(rec));
  ok("the clock is stamped at the GESTURE and read after the DRAW",
    /dirtyAt = performance\.now\(\)/.test(bump)
    && /const t0 = dirtyAt/.test(pump)
    && /redraw\(\);\s*\n\s*const t3 = performance\.now\(\);/.test(pump)
    && /record\(t2 - t1, t3 - t0/.test(pump));
  ok("a coalesced burst is measured from the gesture it serves, so the queue is IN the number",
    /if \(!dirty\) \{ dirty = true; dirtyAt = performance\.now\(\)/.test(bump));
  ok("one render in the air at a time, and the latest state wins",
    /if \(busy \|\| !dirty\) return;/.test(pump) && /if \(dirty\) pump\(\);/.test(pump));
  ok("the first render of the session is shown as cold and kept out of the median, "
     + "rather than dropped silently",
    /first render of the session, cold/.test(rec) && /cold was \$\{V\.cold\}/.test(rec));
  ok("the median and the p95 are both printed, with n",
    /warm median/.test(rec) && /p95/.test(rec) && /n=\$\{V\.totals\.length\}/.test(rec));
  ok("the lane the render ran on is printed — a knob on the shared lane is an 8 s knob",
    /lane \$\{r\.lane\}/.test(rec));
}

/* ═══════════ 5. THE LANE SEAM, CLOSED ═══════════════════════════════════
 * The panel's whole claim rests on §3.4's short-job lane being the lane the
 * render actually used. routes.js hands that lane over as `runEngineVoice`;
 * voicelab.js used to read `ctx.runOneNote`, which is its name INSIDE
 * routes.js. The key never matched, so every Voice Lab render fell back to the
 * shared render lane — measured at 28 661 ms for one knob turn fired 250 ms
 * into a cold 16-bar region render, against 22 ms once the names met. Both
 * names are accepted now, and this holds them together. */

console.log("\n  -- the short-job lane is the lane the Voice Lab actually gets --");
{
  const fast = () => {};
  ok("laneOf resolves the name routes.js hands over (runEngineVoice)",
    laneOf({ runEngineFast: fast, runEngineVoice: fast }).lane === "fast");
  ok("...and the name voicelab.js used to read (runOneNote), so a rename cannot reopen it",
    laneOf({ runEngineFast: fast, runOneNote: fast }).lane === "fast");
  ok("...and says `shared` — honestly — when the mount really has no second lane",
    laneOf({ runEngineFast: fast }).lane === "shared"
    && laneOf({ runEngineFast: fast }).run === fast);
  ok("routes.js hands the Voice Lab a short-job lane under that exact name",
    /runEngineVoice:\s*runOneNote/.test(ROUTES));
  /* Both ctx names may be READ, but only inside laneOf — anywhere else is a
   * second resolution, and a second resolution is how the first one drifted. */
  /* bodyOf brace-matches from the header, and `laneOf(ctx = {})` carries a `{}`
   * in its own signature — it would close on the default argument and return
   * 31 characters. Slice from the header to its own closing brace instead. */
  const VLCODE = stripComments(VLJS);
  const at = VLCODE.indexOf("export function laneOf");
  const laneBody = at < 0 ? "" : VLCODE.slice(at, VLCODE.indexOf("\n}", at) + 2);
  const outside = VLCODE.replace(laneBody, "");
  const shortLaneRead = /\b(?:ctx|deps)\.(?:runEngineVoice|runOneNote)\b/g;
  ok("voicelab.js resolves a lane in ONE place — no second copy to drift",
    !!laneBody
    && (outside.match(/laneOf\(/g) || []).length === 2
    && (outside.match(shortLaneRead) || []).length === 0
    && (laneBody.match(shortLaneRead) || []).length >= 2,
    `laneBody ${laneBody.length} chars, ${(outside.match(shortLaneRead) || []).length} reads outside`);
  ok("...and the only jobs that still take the SHARED lane are the two that are not "
     + "knob turns: a stem render (a full second graph pass) and a mip-map build",
    (outside.match(/ctx\.runEngineFast\(/g) || []).length === 2
    && /runEngineFast\("render_stems"/.test(VLJS) && /runEngineFast\("peaks_mip"/.test(VLJS));
  ok("the panel prints whichever lane came back rather than assuming the fast one",
    !/lane: *"fast"/.test(CODE));
}

/* ═══════════ 6. THE OVERLAY DRAWS NOTHING IT HAS NOT MEASURED ═══════════
 *
 * The overlay is the one part of this panel where a plausible-looking line
 * is worse than no line at all, because a knob gets set to it. Four ways it
 * could go wrong, and one check each:
 *
 *   · a curve drawn from a profile the picker never fetched;
 *   · a curve drawn against the WRONG stem, or against a band table that is
 *     not ear.py's nine (an indexing slip reads as a real difference);
 *   · a number SUBTRACTED that has no second side — level, loudness, width.
 *     Ours does not exist on a single note, and a confident difference with
 *     no meaning is the exact failure the blank slot was protecting against;
 *   · a gap filled in — an absent band, a missing t60, a reference envelope
 *     longer than our render — smoothed over instead of named.
 */

console.log("\n  -- the reference overlay draws a measurement, or it draws nothing --");
{
  const over = bodyOf(CODE, "function drawOverlay(a)") || "";
  const spec = bodyOf(CODE, "function drawSpec(a)") || "";
  const env = bodyOf(CODE, "function drawEnv(a)") || "";
  const stem = bodyOf(CODE, "function refStem()") || "";
  const rb = bodyOf(CODE, "function refBands(sp)") || "";
  const kick = bodyOf(CODE, "function refKick()") || "";
  const rnote = bodyOf(CODE, "function drawRefNote()") || "";

  ok("all four canvases the spec names are built, the overlay's among them",
    ["vlWave", "vlSpec", "vlEnv", "vlOverlay"].every((id) => JS.includes(`"${id}"`))
    && /cv\.id = id/.test(CODE) && /figure\("vlOverlay"/.test(CODE));
  ok("with no profile the slot is WORDS, and they name what would fill it, "
     + "what it is made of and what has to run first",
  /slot\.innerHTML = EMPTY_SLOT/.test(over)
    && /profile_build/.test(JS) && /t10\/t30\/t60/.test(JS) && /demucs/.test(JS));
  ok("...including, out loud, that an invented target is worse than a blank one",
    /worse than no target/.test(JS));

  /* THE FOUR ROUTES, and the shape of the surface they make. */
  ok("the picker is the whole library: list, get, build, delete — nothing cached "
     + "here but the profile on screen",
  /action: "profile_list"/.test(CODE) && /action: "profile_get"/.test(CODE)
    && /action: "profile_build"/.test(CODE) && /action: "profile_delete"/.test(CODE)
    && /V\.prof = r\.profile/.test(CODE));
  ok("the library is read on the FIRST OPEN, not at boot — a page that never opens "
     + "this tab costs no request and prints no error",
  /if \(!V\.profAsked\) \{ V\.profAsked = true; loadProfiles\(\); \}/.test(CODE));
  ok("deleting a profile asks first, and the question names what it would cost to "
     + "get it back", /(?:window\.confirm|appConfirm)\(/.test(CODE) && /running demucs over the file again/.test(JS));

  /* WHICH STEM, AND WHY THAT ONE. */
  ok("which stem a track argues with comes from `family` on the SERVED patch row — "
     + "there is no patch name in this file's mapping",
  /const FAMILY_STEM = \{/.test(CODE) && /V\.family = row\?\.family/.test(CODE)
    && /FAMILY_STEM\[V\.family\]/.test(stem));
  ok("...and the auto choice is overridable and SAYS which stem it took",
    /V\.stem === "auto"/.test(stem) && /chosen: V\.stem === "auto"/.test(stem)
    && /\(auto, family/.test(JS));
  ok("a block the profile does not carry draws NOTHING — no nearest stem, no fallback",
    /if \(!block\?\.bands\?\.bands\?\.length\) return null;/.test(stem));
  ok("their nine bands are aligned to OURS BY NAME, and a profile whose band table "
     + "is not ear.py's is refused rather than drawn one band out of step",
  /rows\.length !== sp\.band_names\.length/.test(rb)
    && /r\.name === sp\.band_names\[i\]/.test(rb));
  ok("the reference's kick envelope is only drawn behind a DRUMS-family voice — a "
     + "profile measures one envelope, off one stem",
  /s\.id !== KICK_STEM/.test(kick) && /const KICK_STEM = "drums";/.test(CODE));

  /* WHAT IS COMPARED, AND WHAT IS ONLY SHOWN. */
  ok("the two curves that ARE overlaid are the gain-invariant ones — the 1/3-octave "
     + "dB share and the deviation from the pink null",
  /r\.share_db/.test(spec) && /rr\.deviation_db/.test(spec)
    && /third_octave/.test(spec));
  /* The subtraction that is allowed is named; every OTHER field read off the
   * profile must appear on neither side of a minus. `ours - theirs` on the
   * decay times reads two locals and is declared separately below. */
  const refRead = /(?:ref\.block|rk|rs|pu|st)\.[a-z_0-9]+/;
  ok("the delta bars subtract ONLY the deviation from the pink null",
    /mine\[i\]\.deviation_db - r\.deviation_db/.test(over)
    && !new RegExp(`${refRead.source}\\s*-\\s`).test(over)
    && !new RegExp(`-\\s*${refRead.source}`).test(over));
  ok("...and an absent band on EITHER side has no distance at all, rather than a "
     + "confident zero",
  /r\.absent \|\| mine\[i\]\.absent\) \? null/.test(over) && /x\.d !== null/.test(over));
  ok("level, loudness and width are printed as THEIRS and never subtracted — our "
     + "side of them does not exist on one note",
  /targets\.push/.test(over) && /never subtracted/.test(JS)
    && !/level_rel_mix_db -/.test(over) && !/st\.width -/.test(over));
  ok("...and the panel says so where a reader will see it, not only in a comment",
    /is not measured on one note/.test(JS)
    && /minutes of a finished record/.test(JS));

  /* THE GAPS, NAMED RATHER THAN FILLED. */
  ok("a reference envelope longer than our render is CUT and the cut is named, "
     + "never squeezed to fit",
  /if \(t > span\) return;/.test(env) && /it runs to/.test(JS));
  ok("their decay times are differenced only when both sides really have one",
    /not both measured/.test(over));
  ok("a picked profile that overlays nothing says WHICH of the two reasons it is",
    /no \$\{V\.stem === "auto"/.test(spec) && /nine bands are not ear\.py's/.test(JS));

  /* THE PROVENANCE LINE — the reason a reader can distrust this correctly. */
  ok("the profile's own provenance is printed: source, length, rate, and the grid "
     + "gate's implied BPM, so a 442-BPM read is visible rather than propagated",
  /p\.source/.test(rnote) && /p\.seconds/.test(rnote) && /p\.sr/.test(rnote)
    && /implied_bpm/.test(rnote));
  ok("...and Q2's answer verbatim: a resampled reference says it was resampled, "
     + "and from what",
  /p\.resampled_from/.test(rnote) && /p\.resample_note/.test(rnote)
    && /resampled from \$\{p\.resampled_from\}/.test(JS));
  ok("...and every warning the profile carries is shown, plus an absent LUFS with "
     + "the server's own reason",
  /p\.warnings/.test(rnote) && /lufs_available === false/.test(rnote)
    && /lufs_absent_because/.test(rnote));
  ok("nothing off a profile is ever written as HTML — every value is textContent",
    (CODE.match(/\.innerHTML\s*=/g) || []).length === 2
    && /slot\.innerHTML = EMPTY_SLOT/.test(CODE)
    && !/innerHTML[^=]*=[^;]*\bV\.prof/.test(CODE));
  ok("the panel names what a profile is NOT, where a person choosing one reads it",
    /never audio and never a melody/.test(JS) || /no audio and no melody/.test(JS));
}

/* ═══════════ 7. THE PICTURES ARE THE SERVER'S OWN MEASUREMENTS ══════════ */

console.log("\n  -- the pictures are drawn from the server's numbers, not from a second copy --");
{
  const spec = bodyOf(CODE, "function drawSpec(a)") || "";
  const env = bodyOf(CODE, "function drawEnv(a)") || "";
  const wave = bodyOf(CODE, "function drawWave(a)") || "";
  ok("the nine bands' frequency edges are PARSED from the server's own labels — "
     + "there is no second copy of ear.py's BANDS here",
    /sp\.band_labels\.map/.test(spec) && !/\b20,\s*60\b/.test(spec) && !/8000,\s*20000/.test(spec));
  ok("the band names are the server's too (`sub`, `boxiness`, `air` are not typed here)",
    /sp\.band_names\[i\]/.test(spec)
    && !/["']boxiness["']/.test(CODE) && !/["']brilliance["']/.test(CODE));
  ok("the band scale is FITTED to the data and the fitted number is printed",
    /const SCALE = clamp\(/.test(spec) && /±\$\{SCALE\} dB full scale/.test(spec));
  ok("...and a band ear.py marked `absent` is drawn grey and left OUT of the fit, "
     + "because -37 dB of air on a kick is 'there is none', not 'it is 37 dB wrong'",
    /filter\(\(r\) => !r\.absent\)/.test(spec) && /row\.absent \? P\.ghost/.test(spec));
  ok("L, R and the fold are drawn separately when they differ, and the panel says "
     + "so when they do not",
    /const stereo = !a\.mono/.test(spec) && /L\/R differ/.test(spec)
    && /the same samples/.test(spec));
  ok("the envelope is drawn in dB with the three measured decay times marked",
    /t10_ms/.test(env) && /t30_ms/.test(env) && /t60_ms/.test(env)
    && /\[3, 3\]/.test(env));
  ok("...and a t60 the render was too short to reach is written down, never drawn",
    /t == null\) continue/.test(env) && /t60 not reached in/.test(env));
  ok("...and where the sound actually stops is marked, so a flat line on the floor "
     + "reads as silence rather than as a broken plot",
    /silent from here/.test(env) && /reserved tail unused/.test(env));
  ok("the waveform draws min AND max, per channel — a rectified envelope hides DC",
    /c\.min\[i\]/.test(wave) && /c\.max\[i\]/.test(wave));
  ok("zooming in switches to the four-stage mip-map, and the caption says which "
     + "source is on screen",
    /action:\s*"peaks"/.test(CODE) && /mip stage \$\{src\.stage\.shift\}/.test(wave)
    && /columns \(\$\{a\.peaks\?\.samples_per_column/.test(wave));
  ok("a later zoom cancels an earlier peaks reply rather than letting it land last",
    /const seq = \+\+V\.mipSeq/.test(CODE) && /if \(seq !== V\.mipSeq\) return/.test(CODE));
  ok("the analysis is measured at the width it is drawn at, not at a constant",
    /columns: clamp\(Math\.round\(waveCv\.getBoundingClientRect\(\)\.width\)/.test(CODE));
}

/* ═══════════ 8. THE MOUNT, AND ITS ONE COUPLING TO THE PAGE ═════════════ */

console.log("\n  -- the module owns its pixels and touches the page in one place --");
{
  ok("daw.html carries the tab, the pane and the module script, each marked for "
     + "the hand that owns that file",
    /id="tabVoice"/.test(HTML) && /id="paneVoice"/.test(HTML)
    && /src="voicelab\.js"/.test(HTML)
    && (HTML.match(/VOICE LAB[^\n]*— \d of 3/g) || []).length === 3);
  ok("the pane is inside the dock, after the Ear's, and the tab is in the dock's tab list",
    (() => {
      const dock = HTML.indexOf('<section class="d-dock"');
      const end = HTML.indexOf("</section>", dock);
      const tabs = HTML.indexOf('<div class="d-tabs">', dock);
      const tab = HTML.indexOf('id="tabVoice"');
      const pane = HTML.indexOf('id="paneVoice"');
      return dock >= 0 && tab > tabs && tab < end && pane > tab && pane < end
        && HTML.indexOf('id="paneEar"') < pane;
    })());
  ok("daw.html carries NO markup for the panel itself — the module builds every element",
    !/vl-wrap|vl-knobs|vlWave|vlSpec|vlEnv|vlOverlay/.test(HTML));
  ok("the module is loaded AFTER daw.js, so window.__daw exists when it mounts",
    HTML.indexOf('src="daw.js"') < HTML.indexOf('src="voicelab.js"'));
  ok("daw.js does not import it and does not know its name — deleting the module "
     + "leaves the page unchanged apart from a tab that does nothing",
    !/voicelab/.test(readFileSync(path.join(WEB, "daw.js"), "utf8")));
  ok("the module loads its own stylesheet, as dawear.js does — daw.html links no <link> for it",
    /link\.href = "voicelab\.css"/.test(CODE)
    && !/<link[^>]*voicelab\.css/.test(HTML));
  ok("it never mounts twice, and refuses to mount outside a browser",
    /typeof document === "undefined"/.test(CODE)
    && /document\.querySelector\("\.vl-wrap"\)/.test(CODE));

  const ps = bodyOf(CODE, "function pageState()") || "";
  ok("the page's state is read in ONE function and nowhere else",
    !!ps && (CODE.match(/window\.__daw/g) || []).length === 1);
  ok("...read-only: the module never assigns into the page's handle",
    !/window\.__daw\s*[.[][^=]*=[^=]/.test(CODE) && !/window\.__daw\s*=/.test(CODE));
  ok("...and a host that would rather drive it can pass getSlug/getTrackId instead",
    /opts\.getSlug \|\| \(\(\) => pageState\(\)\.slug\)/.test(CODE)
    && /opts\.getTrackId \|\| \(\(\) => pageState\(\)\.trackId\)/.test(CODE));

  /* The 1 Hz follow is the one thing in this module that could destroy a
   * gesture: rebuilding the rack replaces the slider the pointer is captured
   * on. It must do nothing unless something really moved. */
  const sync = bodyOf(CODE, "async function sync(force)") || "";
  const load = bodyOf(CODE, "function loadTrack(id)") || "";
  ok("the once-a-second follow returns early unless the document or the selection moved",
    /if \(!docMoved && !pageMoved\) return;/.test(sync));
  ok("...and compares the PAGE's revision against the page's own last revision, "
     + "never against the copy this module fetched (which would never converge)",
    /p\.updatedAt !== V\.seenAt/.test(sync) && /V\.seenAt = p\.updatedAt \?\?/.test(sync));
  ok("...and leaves the rack's DOM alone when nothing about the track changed",
    /if \(!settled\) drawKnobs\(\);/.test(load) && /knobCol\.childElementCount/.test(load));
  ok("...and does not yank back a track picked HERE while the page sits on another",
    /p\.trackId !== V\.pageTrack/.test(sync));
  ok("getting out of the way of the other dock tabs is an observer, not three click "
     + "listeners — daw.js calls showDock() from places that are not a click",
    /new MutationObserver/.test(CODE) && /attributeFilter: \["class"\]/.test(CODE));
}

/* ═══════════ 9. ONE PALETTE, ONE PREFIX ════════════════════════════════ */

console.log("\n  -- voicelab.css invents no colour and no class name --");
{
  ok("no hex colours in voicelab.css", !/#[0-9a-f]{3,8}\b/i.test(CSSCODE));
  const rootBlock = STYLES.match(/^:root \{([\s\S]*?)^\}/m)[1];
  const tokenHues = new Set([...rootBlock.matchAll(/hsla?\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%/g)]
    .map((m) => `${m[1]},${m[2]},${m[3]}`));
  const used = [...CSSCODE.matchAll(/hsla?\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%/g)]
    .map((m) => `${m[1]},${m[2]},${m[3]}`);
  const strangers = [...new Set(used)].filter((h) => !tokenHues.has(h));
  ok(`every colour in voicelab.css is a token (${used.length} raw colours found — expected 0)`,
    strangers.length === 0 && used.length === 0, `strangers: ${strangers.join(" | ")}`);

  /* And no per-token fallback either: a fallback that duplicates a token IS a
   * second palette, and it was already a shade off in three places. */
  const colourTokens = /var\(--(ink|dim|faint|ghost|edge|primary|secondary|accent|on|ok|warn|err|hair|panel|raise|rail),/;
  ok("no colour token carries a duplicated fallback value", !colourTokens.test(CSSCODE));

  const classes = [...new Set([...CSSCODE.matchAll(/^\.([a-zA-Z][\w-]*)/gm)].map((m) => m[1]))];
  const foreign = classes.filter((c) => !c.startsWith("vl-") && c !== "d-dockpane");
  ok(`every class in voicelab.css is namespaced vl- (${classes.length} checked)`,
    foreign.length === 0, `foreign: ${foreign.join(", ")}`);
  ok("the ONE d- selector it touches is the dock pane it is mounted in, and it is "
     + "scoped to this module's own class",
    /\.d-dockpane\.vl-host/.test(CSSCODE)
    && !new RegExp("\\.d-(?!dockpane\\.vl-host)[\\w-]+\\s*\\{").test(CSSCODE));
  ok("canvas ink is read from those same custom properties at runtime, with ONE "
     + "named fallback — the shape daw.js's readTokens uses",
    /getPropertyValue\(`--\$\{k\}`\)/.test(CODE) && /const NO_TOKEN = /.test(CODE)
    && (CODE.match(/#[0-9a-f]{3,8}\b/gi) || []).length === 1);
  ok("no class this module defines collides with one daw.css already owns",
    classes.filter((c) => c !== "d-dockpane")
      .every((c) => !new RegExp(`^\\.${c}\\b`, "m").test(DAWCSS)));
}

/* ═══════════ 10. THE EAR'S REFERENCE ROW, AND ITS ONE CROSSING ══════════
 *
 * web/dawear.js talks to /api/daw/ear. That is why server/daw/ui_test.js's
 * parity census reads daw.js and voicelab.js and deliberately not the Ear —
 * a different door, owned by ear_test.js. The reference LIBRARY is not behind
 * that door, so the Ear's row has to reach across to /api/daw for exactly one
 * read. An uncounted second door is how three actions shipped with a route, a
 * panel and no tool, so the crossing is counted here: one helper, one call,
 * one action, and it is a READ.
 */

console.log("\n  -- the Ear's reference row: one crossing, one action, and it is a read --");
{
  const EARCODE = stripComments(EARJS);
  const routeActions = new Set([...ROUTES.matchAll(/^\s*case "([a-z_]+)": \{/gm)].map((m) => m[1]));
  for (const a of MIXER_ACTIONS) routeActions.add(a);
  for (const a of VOICELAB_ACTIONS) routeActions.add(a);
  for (const a of refprofile?.REFPROFILE_ACTIONS || []) routeActions.add(a);

  ok("dawear.js reaches /api/daw through exactly ONE helper, used at exactly one "
     + "call site — everything else it does still goes to /api/daw/ear",
  (EARCODE.match(/fetch\("\/api\/daw"/g) || []).length === 1
    && (EARCODE.match(/fetch\("\/api\/daw\/ear"/g) || []).length === 1
    && (EARCODE.match(/postDaw\(/g) || []).length === 2);
  const cross = bodyOf(EARCODE, "async function loadProfiles()") || "";
  ok("...and the action it carries is profile_list, nothing else",
    /await postDaw\(\{ action: "profile_list" \}\)/.test(cross)
    && [...new Set([...EARCODE.matchAll(/\baction:\s*"(profile_[a-z_]+)"/g)].map((m) => m[1]))]
      .join(",") === "profile_list");
  ok("...and it is a READ: no build, no delete, nothing that writes, from this panel",
    !/action:\s*"profile_(build|delete)"/.test(EARCODE));
  ok("...stamped by:\"user\" like every other call a person makes, never by:\"agent\"",
    /body:\s*JSON\.stringify\(\{ by: "user", \.\.\.body \}\)/.test(EARCODE)
    && !/by:\s*"agent"/.test(EARCODE));
  ok("the library is read on the FIRST OPEN of the panel, not at page load",
    /if \(S\.open && !S\.profilesAsked\) \{ S\.profilesAsked = true; loadProfiles\(\); \}/.test(EARCODE));

  /* THE CHOICE RIDES THE CRITIQUE'S OWN BODY. Two calls could disagree; one
   * field on one body cannot. */
  const listen = bodyOf(EARCODE, "async function listen()") || "";
  ok("the chosen profile rides the SAME critique body the Ear already posts — one "
     + "id, one call, so a critique and the shape it was measured against cannot "
     + "come apart",
  /action: "critique"/.test(listen)
    && /\.\.\.\(S\.profileId \? \{ profile: S\.profileId \} : \{\}\)/.test(listen));
  ok("...and `critique` is an action the ear dispatcher really has",
    /case "critique":/.test(readFileSync(path.join(HERE, "ear.js"), "utf8")));
  /* ONE DOOR, ONE LEVEL DOWN. The field the row sends must be one the AGENT's
   * daw_critique declares — the same parity ui_test.js holds voice_lab and
   * peaks to. A person choosing a reference and an agent choosing one have to
   * be choosing the same thing, or the two hands drift on the argument that
   * decides what the critique is measured against. */
  const critique = dawTools(async () => ({}), (x) => x).find((t) => t.name === "daw_critique");
  ok("the `profile` field the row sends is one daw_critique declares, with a description "
     + "saying what a profile is",
  !!critique?.inputSchema?.properties?.profile
    && /profile/i.test(String(critique.inputSchema.properties.profile.description || "")),
  critique ? Object.keys(critique.inputSchema.properties).join(", ") : "no daw_critique");
  ok("with nothing picked the body is byte-for-byte the one every critique before "
     + "this posted — picking nothing changes nothing",
  /S\.profileId \? \{ profile/.test(listen) && /profileId: ""/.test(EARCODE));

  /* THE ROW ITSELF. */
  const drawSel = bodyOf(EARCODE, "function drawRefSel()") || "";
  ok("the picker's options are the FETCHED list, not a list this page keeps",
    /for \(const p of S\.profiles \|\| \[\]\)/.test(drawSel)
    && /o\.value = p\.id/.test(drawSel));
  ok("...and an id the list no longer has falls back to `no reference` rather than "
     + "posting a profile that was deleted on another tab",
  /S\.profiles \|\| \[\]\)\.some\(\(p\) => p\.id === keep\)/.test(drawSel));
  ok("a machine with no library and a machine with an empty one say DIFFERENT "
     + "things, and neither of them says nothing",
  /No reference library on this machine/.test(EARJS)
    && /No reference profiles yet/.test(EARJS)
    && /S\.profiles === null/.test(EARCODE));
  /* Copy in this file is written as adjacent string literals, so a phrase a
   * reader sees as one sentence is two literals in the source. Join them
   * before looking for prose — otherwise the check silently only ever tests
   * sentences short enough to fit on one line. */
  const joined = EARJS.replace(/"\s*\n\s*\+\s*"/g, "");
  ok("the row names what a profile is and is not, where a person choosing one reads it",
    /never its audio and never its melody/.test(joined)
    && /style target, not a copy/.test(joined));
  const EARCSS = readFileSync(path.join(WEB, "dawear.css"), "utf8");
  const newClasses = [...new Set([...EARCODE.matchAll(/EL\("div", "(ear-[a-z- ]+)"/g)]
    .flatMap((m) => m[1].trim().split(/\s+/)))];
  ok(`the row adds no class dawear.css does not already have (${newClasses.length} checked)`,
    newClasses.length > 0 && newClasses.every((c) => new RegExp(`\\.${c}\\b`).test(EARCSS)),
    newClasses.filter((c) => !new RegExp(`\\.${c}\\b`).test(EARCSS)).join(", "));
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.log("  failed:\n   " + failures.join("\n   ") + "\n");
  process.exit(1);
}
