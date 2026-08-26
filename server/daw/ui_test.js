/**
 * DAW UI — the static gates the arrangement window stands on.
 *
 * The UI's correctness has three parts. Two of them are ordinary code and
 * are tested here; the third is pixels and is tested by driving the real
 * page (scripts/e2e_dawui.mjs plus a browser).
 *
 *   1. THE PARITY GATE — the binding principle in executable form. Every
 *      `action: "…"` the page posts must be an action routes.js or mixer.js
 *      actually dispatches. This is what makes "one document, two hands"
 *      true rather than aspirational: a gesture that invented its own write
 *      path, or kept a name the server renamed, fails the commit.
 *
 *   2. THE WIRING GATE — daw.js binds listeners at MODULE TOP LEVEL, so one
 *      id daw.html does not carry is `null.addEventListener`: a TypeError
 *      that kills the WHOLE module, piano roll included, and the browser
 *      swallows it. capture_test.js proves every `$("id")` exists; this file
 *      names the ARRANGEMENT cluster explicitly, so deleting one of these
 *      from the page fails here rather than removing a feature quietly.
 *
 *   3. THE PRIMITIVES — the fader law, the keymap profiles, the catalog-
 *      driven device panel and the live-sync frame. Each has a closed-form
 *      answer, so each is checked against arithmetic rather than itself.
 *
 * Runs standalone (`node server/daw/ui_test.js`) and in the pre-commit hook.
 * Touches no disk beyond reading web/ and server/daw/.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MIXER_CATALOG, MIXER_ACTIONS } from "./mixer.js";
import { slugOfEvent, frameFor, DEBOUNCE_MS, createDawLive } from "./live.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, "..", "..", "web");
const JS = readFileSync(path.join(WEB, "daw.js"), "utf8");
const HTML = readFileSync(path.join(WEB, "daw.html"), "utf8");
const CSS = readFileSync(path.join(WEB, "daw.css"), "utf8");
const STYLES = readFileSync(path.join(WEB, "styles.css"), "utf8");
const ROUTES = readFileSync(path.join(HERE, "routes.js"), "utf8");

/* Strip comments and template/quoted prose before looking for code shapes,
 * so a sentence in a docblock cannot pass or fail a structural check. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const CODE = stripComments(JS);

/** Brace-match a named function's body out of the source. */
function bodyOf(src, header) {
  const i = src.indexOf(header);
  if (i < 0) return null;
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (ch === "{") { depth++; started = true; }
    else if (ch === "}") { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  return null;
}

/* ══════════════════════════ 1. THE PARITY GATE ══════════════════════════ */

console.log("\n  -- every gesture posts an action the server actually has --");
{
  const routeActions = new Set([...ROUTES.matchAll(/^\s*case "([a-z_]+)": \{/gm)].map((m) => m[1]));
  for (const a of MIXER_ACTIONS) routeActions.add(a);
  ok(`routes.js + mixer.js dispatch ${routeActions.size} actions`, routeActions.size > 30);

  const posted = [...new Set([...CODE.matchAll(/\baction:\s*"([a-z_]+)"/g)].map((m) => m[1]))];
  ok(`the page posts ${posted.length} distinct actions`, posted.length > 20, posted.join(", "));
  const orphans = posted.filter((a) => !routeActions.has(a));
  ok("every action the page posts exists on the server — no parallel write path",
    orphans.length === 0, `orphans: ${orphans.join(", ")}`);

  /* The other direction is a coverage note, not a failure: the page is not
   * obliged to surface every action (probe/status are agent-only). Printed
   * so the gap is visible when it grows. */
  const unsurfaced = [...routeActions].filter((a) => !posted.includes(a)).sort();
  console.log(`        (not surfaced in the UI: ${unsurfaced.join(", ") || "none"})`);

  /* Reads, too: the page must only fetch endpoints routes.js serves. */
  const gets = [...new Set([...CODE.matchAll(/["'`]\/api\/daw\/([a-z0-9.]+)/gi)].map((m) => m[1]))];
  const served = [...new Set([...ROUTES.matchAll(/"\/api\/daw\/([a-z0-9.]+)/gi)].map((m) => m[1]))];
  const badGets = gets.filter((g) => !served.includes(g));
  ok("every /api/daw/… read the page makes is a route routes.js serves",
    badGets.length === 0, `unknown: ${badGets.join(", ")}`);

  /* And the mutating calls carry an actor. The provenance ledger's honesty
   * rests on the page never claiming to be the agent. */
  ok("the page's POST helper stamps by:\"user\" (and never by:\"agent\")",
    /body:\s*JSON\.stringify\(\{\s*by:\s*"user"/.test(CODE) && !/by:\s*"agent"/.test(CODE));
}

/* ══════════════════════════ 2. THE WIRING GATE ══════════════════════════ */

console.log("\n  -- the arrangement window is wired to elements that exist --");
{
  const inHtml = new Set([...HTML.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const wanted = [...new Set([...JS.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))];
  const missing = wanted.filter((id) => !inHtml.has(id));
  ok(`every id daw.js reaches for exists in daw.html (${wanted.length} checked)`,
    missing.length === 0, missing.join(", "));

  /* The four zones of the report's chosen metaphor, by name. */
  for (const [zone, ids] of Object.entries({
    transport: ["playBtn", "stopBtn", "recBtn", "loopBtn", "clickChk", "posLbl", "posSec",
                "tBpm", "tBar", "tSet", "mNum", "mDen", "mBar", "mSet", "cpuTxt"],
    browser: ["palette", "palCnt", "presetList", "credits", "credCnt", "logBox", "events"],
    arrangement: ["arrWrap", "arrHeads", "arrCanvas", "tracks", "addTrackBtn", "splitH"],
    editor: ["roll", "rollWrap", "paneRoll", "paneAuto", "autoList", "autoCanvas",
             "modeDraw", "modeSel", "modeErase", "gridSel", "quantBtn", "quantAmt",
             "scaleRoot", "scaleType", "foldChk", "ghostChk", "tabRoll", "tabAuto"],
    mixer: ["mixStrips", "metersBtn", "autoWriteBtn", "returnAddBtn", "meterNote"],
    devices: ["devChain", "devAdd", "devTarget", "devNote"],
    dialogs: ["licDlg", "licBody", "licAccept", "bounceDlg", "bounceRun", "kmDlg", "kmBody"],
    live: ["liveDot", "liveTxt", "status"],
  })) {
    const gone = ids.filter((id) => !(inHtml.has(id) && JS.includes(`$("${id}")`)));
    ok(`the ${zone} zone carries all ${ids.length} of its controls`, gone.length === 0, gone.join(", "));
  }

  /* The capture cluster survived the rewrite — DAWREC's features are not
   * quietly lost by a UI stage that only cared about the piano roll. */
  const capture = ["recBtn", "cntIn", "recDev", "impBtn", "impFile", "calOpen", "midiDev",
                   "midiRecBtn", "midiQuant", "takes", "calDlg", "calRunMic", "calRunSyn",
                   "calStore", "calResult", "calNote", "calStored"];
  const lost = capture.filter((id) => !(inHtml.has(id) && JS.includes(`$("${id}")`)));
  ok("the [DAWREC] capture cluster is intact after the UI rewrite", lost.length === 0, lost.join(", "));

  ok("daw.html links the Studio's own stylesheet (one palette, not a sixth)",
    /<link[^>]+href="styles\.css"/.test(HTML) && /<link[^>]+href="daw\.css"/.test(HTML));
}

/* ══════════════════════ 3a. THE FADER LAW ═══════════════════════════════
 * A fader whose taper is linear in dB feels wrong to everyone who has
 * touched a console: real travel expands near unity. The law is a piecewise
 * table in daw.js; this section re-implements nothing — it PARSES the table
 * and proves the properties the UI relies on. */

console.log("\n  -- the dB-law fader is a law, not a lerp --");
{
  const src = JS.match(/const FADER_SEGS = \[([\s\S]*?)\];/);
  ok("the fader law is a declared table", !!src);
  const segs = [...src[1].matchAll(/\[\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)\s*\]/g)]
    .map((m) => m.slice(1).map(Number));
  ok(`the table has ${segs.length} segments`, segs.length >= 3);
  ok("it spans the whole throw, 0 → 1", near(segs[0][0], 0) && near(segs[segs.length - 1][1], 1));
  ok("it spans the mixer's dB range, −60 → +12",
    near(segs[0][2], -60) && near(segs[segs.length - 1][3], 12));

  let contiguous = true, monotonic = true;
  for (let i = 1; i < segs.length; i++) {
    if (!near(segs[i][0], segs[i - 1][1]) || !near(segs[i][2], segs[i - 1][3])) contiguous = false;
    if (segs[i][3] <= segs[i][2]) monotonic = false;
  }
  ok("the segments are contiguous in both position and dB", contiguous);
  ok("every segment rises (the law is invertible)", monotonic);

  const posToDb = (p) => {
    const x = Math.max(0, Math.min(1, p));
    for (const [p0, p1, d0, d1] of segs) if (x <= p1 || p1 === 1) return d0 + (d1 - d0) * (x - p0) / (p1 - p0);
    return 12;
  };
  const dbToPos = (db) => {
    const d = Math.max(-60, Math.min(12, db));
    for (const [p0, p1, d0, d1] of segs) if (d <= d1 || d1 === 12) return p0 + (p1 - p0) * (d - d0) / (d1 - d0);
    return 1;
  };
  let roundTrip = true;
  for (let i = 0; i <= 100; i++) if (!near(dbToPos(posToDb(i / 100)), i / 100, 1e-9)) roundTrip = false;
  ok("position → dB → position round-trips exactly at 101 points", roundTrip);

  const unity = dbToPos(0);
  ok(`unity sits at ${(unity * 100).toFixed(0)} % of the throw, not at the top`,
    unity > 0.6 && unity < 0.9);
  /* The expansion property, stated as arithmetic: the top quarter of the
   * throw must carry FEWER dB than the bottom quarter. That is the whole
   * point of a fader taper. */
  const topSpan = posToDb(1) - posToDb(0.75);
  const botSpan = posToDb(0.25) - posToDb(0);
  ok(`the taper expands near unity (top quarter ${topSpan.toFixed(0)} dB < bottom quarter ${botSpan.toFixed(0)} dB)`,
    topSpan < botSpan);
  ok("the fader's dB range matches the mixer's own limits",
    near(posToDb(0), -60) && near(posToDb(1), 12));
}

/* ══════════════════════ 3b. KEYMAP PROFILES ════════════════════════════ */

console.log("\n  -- three keymap profiles over one action table --");
{
  const body = JS.match(/const KM_ACTIONS = \{([\s\S]*?)\n\};/);
  const maps = JS.match(/const KEYMAPS = \{([\s\S]*?)\n\};/);
  ok("both tables are declared", !!body && !!maps);
  const actions = [...body[1].matchAll(/^\s{2}([a-z_]+):\s*\{/gm)].map((m) => m[1]);
  ok(`${actions.length} gestures are bindable`, actions.length >= 12, actions.join(", "));

  const profiles = [...maps[1].matchAll(/^\s{2}([a-z]+):\s*\{/gm)].map((m) => m[1]);
  ok("the three profiles are live, fl and cubase",
    JSON.stringify(profiles) === JSON.stringify(["live", "fl", "cubase"]), profiles.join(", "));

  for (const p of profiles) {
    const block = maps[1].match(new RegExp(`${p}:\\s*\\{[\\s\\S]*?keys:\\s*\\{([\\s\\S]*?)\\},`));
    const keys = Object.fromEntries([...block[1].matchAll(/([a-z_]+):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
    const missing = actions.filter((a) => !keys[a]);
    ok(`the ${p} profile binds every gesture`, missing.length === 0, missing.join(", "));
    const seen = new Map();
    const clashes = [];
    for (const [a, k] of Object.entries(keys)) {
      if (seen.has(k)) clashes.push(`${k} = ${seen.get(k)} and ${a}`);
      seen.set(k, a);
    }
    ok(`the ${p} profile has no two gestures on one key`, clashes.length === 0, clashes.join("; "));
    if (p === "live") ok("Live's play/stop is Space and draw is B", keys.play_stop === "Space" && keys.draw === "B");
    if (p === "fl") ok("FL's record is R and draw is P", keys.record === "R" && keys.draw === "P");
    if (p === "cubase") ok("Cubase's quantize is Q and split is 3", keys.quantize === "Q" && keys.split === "3");
  }

  ok("the active binding is written into tooltips (a profile you can see)",
    /const TIP_BINDINGS = \[/.test(JS) && /el\.title = `\$\{base\} — \$\{binding\(act\)/.test(JS));
  ok("typing in a field never fires a gesture",
    /\/\^\(INPUT\|SELECT\|TEXTAREA\)\$\/\.test\(t\.tagName\)/.test(CODE));
}

/* ══════════════════ 3c. THE DEVICE PANEL IS CATALOG-DRIVEN ═════════════ */

console.log("\n  -- the device strip is drawn FROM the served catalog --");
{
  const draw = bodyOf(CODE, "function drawDevices()");
  const param = bodyOf(CODE, "function paramControl(");
  ok("both builders exist", !!draw && !!param);
  ok("the chain iterates the catalog's params, not a list of its own",
    /Object\.entries\(spec\?\.params \|\| \{\}\)/.test(draw));

  /* THE REAL GUARD: no parameter name may appear as a literal inside the
   * control builder. Any device rack.py grows must render for free. */
  const names = new Set();
  for (const d of Object.values(MIXER_CATALOG)) for (const n of Object.keys(d.params)) names.add(n);
  const leaked = [...names].filter((n) => new RegExp(`["'\`]${n}["'\`]`).test(param) || new RegExp(`\\b${n}\\s*:`).test(param));
  ok(`none of the ${names.size} device parameters is hard-coded in the control builder`,
    leaked.length === 0, leaked.join(", "));

  const types = [...param.matchAll(/pspec\.type === "([a-z]+)"/g)].map((m) => m[1]);
  ok("bool, enum and track have explicit branches; number is the fall-through knob",
    ["bool", "enum", "track"].every((t) => types.includes(t))
    && /d-knob/.test(param) && /pspec\.min/.test(param) && /pspec\.max/.test(param),
    types.join(", "));
  const kinds = new Set();
  for (const d of Object.values(MIXER_CATALOG)) for (const s of Object.values(d.params)) kinds.add(s.type);
  const unhandled = [...kinds].filter((k) => k !== "number" && !types.includes(k));
  ok(`every parameter type the catalog uses (${[...kinds].join(", ")}) has a control`,
    unhandled.length === 0, unhandled.join(", "));

  ok("the device list itself comes from GET /api/daw/rack, not a constant",
    /get\("\/api\/daw\/rack"\)/.test(CODE) && /RACK\.devices = r\.catalog\?\.devices/.test(CODE));
  ok("a catalog disagreement is shown, not hidden", /tables_agree/.test(CODE));
}

/* ══════════════════ 3d. AUTOMATION USES THE STORE'S SHAPE ══════════════ */

console.log("\n  -- automation reads and writes the store's own keyframes --");
{
  ok("keys are { t, v } with t in FLOAT BARS, the shape mixer.js stores",
    /\{ t: Math\.max\(1, Number\(k\.t\.toFixed\(4\)\)\)/.test(CODE)
    && /qOfBarFloat|barFloatOfQ/.test(CODE));
  const write = bodyOf(CODE, "async function writeLane(");
  ok("a lane writes through the parameter's OWN action (ref.write), never a special one",
    /ref\.write\(/.test(write) && !/action: "/.test(write));

  const ref = bodyOf(CODE, "function laneRef(");
  for (const [what, act] of [["fader", "mixer_set"], ["pan", "mixer_set"],
                             ["send", "send_set"], ["insert param", "insert_set"]]) {
    ok(`a ${what} lane writes with ${act}`, new RegExp(`action: "${act}"`).test(ref));
  }
  ok("only animatable number params can get a lane (the catalog decides)",
    /spec\.type === "number" && spec\.animatable !== false/.test(CODE));

  /* A ride is thinned into keys and merged — it must not silently drop the
   * keys that were already there outside the ridden span. */
  const ride = bodyOf(CODE, "async function writeRide(");
  ok("a fader ride merges with the keys outside its own span",
    /ref\.keys\(\)\.filter\(/.test(ride));
}

/* ══════════════════ 3e. LIVE SYNC ══════════════════════════════════════ */

console.log("\n  -- live sync: one socket, a frame per document revision --");
{
  ok("only the document wakes the page — not a render, a take or a click bed",
    slugOfEvent("mysong/project.json") === "mysong"
    && slugOfEvent("mysong/cache/reg0_abc123def456.wav") === null
    && slugOfEvent("mysong/audio/tk_abc.flac") === null
    && slugOfEvent("mysong/project.json.tmp-1234") === null
    && slugOfEvent("project.json") === null
    && slugOfEvent(null) === null);
  ok("a path that tries to escape the tree is not a slug",
    slugOfEvent("../evil/project.json") === null && slugOfEvent("a/b/project.json") === null);

  const f = frameFor("song", {
    name: "Song", updatedAt: 1234,
    ledger: [{ at: 9, by: "agent", action: "add_note", detail: "pitch 60 at 1.1.0" }],
  });
  ok("the frame names the revision and WHO changed it",
    f.type === "daw" && f.slug === "song" && f.updatedAt === 1234
    && f.by === "agent" && f.action === "add_note" && f.detail.includes("pitch 60"),
    JSON.stringify(f));
  ok("an unknown actor is never promoted to \"agent\"",
    frameFor("s", { ledger: [{ by: "who?" }] }).by === "user"
    && frameFor("s", {}).by === "user");
  ok("a document with no ledger still produces a legal frame",
    frameFor("s", { updatedAt: 7 }).action === "write");
  ok(`the debounce is short enough to feel live (${DEBOUNCE_MS} ms)`, DEBOUNCE_MS > 0 && DEBOUNCE_MS <= 120);

  const live = createDawLive({ dir: "nowhere", broadcast: () => {} });
  ok("createDawLive exposes start/stop and stopping an unstarted watch is safe",
    typeof live.start === "function" && typeof live.stop === "function"
    && (live.stop(), true));

  ok("the page listens on the studio's EXISTING /live socket",
    /new WebSocket\(`ws:\/\/\$\{location\.host\}\/live`\)/.test(CODE));
  ok("the page acts on type:\"daw\" frames for the project it holds",
    /m\.type !== "daw" \|\| m\.slug !== S\.slug/.test(CODE));
  ok("a frame for a revision the page already has is ignored (no self-echo loop)",
    /m\.updatedAt === S\.proj\.updatedAt/.test(CODE));
  ok("an agent edit re-reads the document AND re-renders",
    /refreshDoc\(\);\s*\n\s*await renderAndSwap\(\)/.test(CODE));
}

/* ══════════════════ 3f. THE HONESTY SURFACES ═══════════════════════════ */

console.log("\n  -- the things the UI must not quietly stop saying --");
{
  ok("the four generate-this-part rows are shown, refusal and all",
    /row\.kind === "generate"/.test(CODE) && /d-refusal/.test(CODE) && /row\.refusal/.test(CODE));
  ok("a licence is shown BEFORE a byte moves (the route's gate, surfaced)",
    /install_patch/.test(CODE) && /needsAccept/.test(CODE) && /accept_licence: true/.test(CODE));
  ok("attribution-required packs are marked in the palette AND get a credits panel",
    /attribution_required/.test(CODE) && /function drawCredits\(/.test(CODE));
  ok("the bounce dialog prints the attribution lines a human can read",
    /Attribution written into the file AND shown here/.test(JS));
  ok("per-track meters say they are MEASURED, not live",
    /measured, not live/.test(JS) && /action: "meters"/.test(CODE));
  ok("the master meter says where its numbers come from",
    /live peak from the audio this page is playing/.test(JS));
  ok("the dirty-region renderer's work is shown while it happens",
    /cpu\("re-rendering…", true\)/.test(CODE) && /S\.pending/.test(CODE));
  ok("the session log distinguishes the agent's edits from the human's",
    /d-logrow d-\$\{e\.by === "agent" \? "agent" : "user"\}/.test(CODE));
  ok("the click bed is the engine's, so it cannot drift from the render",
    /\/api\/daw\/click\//.test(CODE));
}

/* ══════════════════ 3g. ONE PALETTE ════════════════════════════════════ */

console.log("\n  -- one palette: daw.css invents no colour --");
{
  ok("no hex colours in daw.css", !/#[0-9a-f]{3,8}\b/i.test(CSS.replace(/\/\*[\s\S]*?\*\//g, "")));
  const rootBlock = STYLES.match(/^:root \{([\s\S]*?)^\}/m)[1];
  const tokenHues = new Set([...rootBlock.matchAll(/hsla?\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%/g)]
    .map((m) => `${m[1]},${m[2]},${m[3]}`));
  const used = [...CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/hsla?\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%/g)]
    .map((m) => `${m[1]},${m[2]},${m[3]}`);
  const strangers = [...new Set(used)].filter((h) => !tokenHues.has(h) && !/^\d+,0,/.test(h));
  ok(`every colour in daw.css is a token or an alpha of one (${used.length} checked)`,
    strangers.length === 0, `strangers: ${strangers.join(" | ")}`);
  ok("canvas ink is read from the same custom properties at runtime",
    /getPropertyValue\(`--\$\{k\}`\)/.test(CODE) && /function tint\(/.test(CODE));
  ok("every class in daw.css is namespaced d- (styles.css already owns .row, .bar, .panel)",
    [...new Set([...CSS.matchAll(/^\.([a-zA-Z][\w-]*)/gm)].map((m) => m[1]))]
      .every((c) => c.startsWith("d-")),
    [...new Set([...CSS.matchAll(/^\.([a-zA-Z][\w-]*)/gm)].map((m) => m[1]))]
      .filter((c) => !c.startsWith("d-")).join(", "));
}

/* ══════════════════ 3h. UNEVEN BARS ════════════════════════════════════
 * The grid must be drawn from the SERVER's timeline rows, never from an
 * assumed 4/4. Structural, because a 7/8 bar being narrower than a 4/4 bar
 * is the feature — and this is the one bug that would look like a rounding
 * error for weeks. */

console.log("\n  -- the grid is derived from the meter map, never assumed --");
{
  ok("no drawing loop assumes four beats in a bar",
    !/for \(let b = 1; b < 4;/.test(CODE) && !/\bnum = 4\b/.test(CODE));
  ok("beat lines come from the row's own numerator", /for \(let b = 1; b < r\.num; b\+\+\)/.test(CODE));
  ok("a beat's width comes from the row's own denominator", /const beatQ = 4 \/ r\.den;/.test(CODE));
  ok("bar positions come from the server's qStart, not from multiplication",
    /r\.qStart \* S\.arrPxq/.test(CODE) && /KEYS_W \+ r\.qStart \* S\.pxq/.test(CODE));
  ok("a meter or tempo change is marked on the ruler",
    /r\.num !== rowOf\(r\.bar - 1\)\?\.num/.test(CODE));
  ok("the quantize grid clamps inside the bar it is in (a 7/8 bar has 7 beats of room)",
    /row\.ticksPerBar - 1/.test(CODE));
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.log("  failed:\n   " + failures.join("\n   ") + "\n");
  process.exit(1);
}
