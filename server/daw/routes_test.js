/**
 * The DAW route module assembles, and its action list is what it claims.
 *
 * The vfx routes_test's bargain, applied here: the factory is one closure
 * built from injected deps, so a dropped import or a typo in a branch that
 * only runs on one action is invisible until someone hits that action.
 * Constructing the factory catches the first class; enumerating the switch's
 * case labels against the declared list catches the second. STRUCTURAL only
 * — no disk, no python; behaviour is proven over HTTP by scripts/e2e_daw.mjs.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createDawRoutes } from "./routes.js";
/* The THREE MOUNTS' own action lists, so the unknown-action check below reads
 * the same tables routes.js interpolates rather than a copy kept by hand.
 * voicelab.js and refprofile.js are optional exactly as routes.js treats
 * them. */
import { MIXER_ACTIONS } from "./mixer.js";
const voicelab = await import("./voicelab.js").catch(() => null);
const refprofile = await import("./refprofile.js").catch(() => null);
/* The arranger's own constants and the agent's tool list, so the last section
 * can hold daw_arrange_bigroom's description to the numbers the plan really
 * sends rather than to the numbers it sent two takes ago. */
import { FADERS, ROLES, ROLL, SUB, SIDECHAIN, MASTER } from "./arrange.js";
import { dawTools } from "../mcp-daw.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

console.log("\n  -- the factory builds --");

let routes = null;
try {
  routes = createDawRoutes({
    json: () => {},
    readBody: async () => ({}),
    config: { outputDir: path.join(HERE, "__nowhere"), python: "python" },
  });
} catch (err) {
  failures.push(`createDawRoutes threw: ${err.message}`);
  console.log(`  FAIL  createDawRoutes threw\n          ${err.message}`);
}

ok("createDawRoutes returns a handler", typeof routes === "function");
ok("...that takes (req, res, url)", routes?.length === 3, `arity ${routes?.length}`);

console.log("\n  -- every action a caller can name --");

const src = readFileSync(path.join(HERE, "routes.js"), "utf8");
const actions = [...src.matchAll(/^\s*case "([a-z0-9_]+)": \{/gm)].map((m) => m[1]);

const EXPECTED = [
  // documents
  "create", "delete", "set_length",
  // the §12 event lists
  "set_meter", "remove_meter", "set_tempo", "remove_tempo",
  // structure
  "add_track", "set_track", "remove_track", "add_clip", "set_clip", "remove_clip",
  // the piano roll as data
  "add_note", "move_note", "delete_note",
  // §2 a whole gesture in ONE write — what the velocity lane commits with
  "edit_notes",
  // the dirty-region loop, and §1's look-ahead half
  "render", "render_ahead", "render_plan",
  // [DAWREC] recording: arm, roll, chunks, takes, comping
  "record_arm", "record_start", "record_chunk_b64", "record_stop",
  "record_status", "take_delete", "take_comp",
  // [DAWREC] audio clips (import is the no-mic path) and MIDI capture
  "import_audio", "set_audio_clip", "remove_audio_clip", "record_notes",
  // [DAWREC] calibration and the audition preview
  "calibrate_b64", "set_latency", "preview_note",
  // the palette: packs install behind a licence gate, bounces carry credits
  "install_patch", "uninstall_pack", "credits", "bounce",
  // the engine's own tables, for the mirror check
  "probe",
  // the arranger: a whole big-room song, fed back through this same switch
  "arrange_bigroom",
  /* WHERE THE PANELS ARE -- the browser, the mixer and the bottom dock, carried
   * by the project rather than by one browser's storage. The only action here
   * that moves no sample and dirties no render region; it goes through the same
   * mutate() as the rest for the locking and the save, because a silent write
   * to a document an agent and a page both hold is worse than a noisy one. */
  "set_view",
];

for (const a of EXPECTED) {
  ok(`action "${a}" is handled`, actions.includes(a));
}
const extra = actions.filter((a) => !EXPECTED.includes(a));
ok("no action is handled but undeclared here", extra.length === 0, extra.join(", "));

/* The default-branch error message must name every real action — it is the
 * discovery surface an agent that guessed wrong actually reads.
 *
 * ASKED FOR, NOT GREPPED. Two of the three dispatchers are MOUNTS (mixer.js
 * and the optional voicelab.js), so their names reach that sentence as
 * `${MIXER_ACTIONS.join(", ")}` — a source scrape sees the interpolation and
 * passes while the sentence a caller actually reads names nothing. It named
 * nothing: voice_lab, render_stems and peaks were dispatched, surfaced in the
 * page and missing from the only list of this door there is. So the message
 * is fetched from the real dispatcher, with a capturing json(), and read. */
const unknownMsg = await (async () => {
  const cap = { out: "" };
  const res = { writeHead() { return res; }, setHeader() { return res; },
    write(s) { cap.out += s; return true; }, end(s) { if (s != null) cap.out += s; } };
  const h = createDawRoutes({
    json: (r, code, body) => { r.writeHead(code); r.end(JSON.stringify(body)); },
    readBody: async (r) => r.body,
    config: { outputDir: path.join(HERE, "__nowhere"), python: "python" },
  });
  await h({ method: "POST", body: { action: "no_such_action_at_all" }, headers: {} },
    res, new URL("http://d.test/api/daw"));
  try { return JSON.parse(cap.out).error || ""; } catch { return ""; }
})();
ok("the dispatcher answers an unknown action with a list of the real ones",
  /^Unknown action "no_such_action_at_all"\./.test(unknownMsg), unknownMsg.slice(0, 120));
const NAMEABLE = [...EXPECTED, ...MIXER_ACTIONS, ...(voicelab?.VOICELAB_ACTIONS || []),
                  ...(refprofile?.REFPROFILE_ACTIONS || [])];
const unnamed = NAMEABLE.filter((a) => !unknownMsg.includes(a));
ok(`the unknown-action message names every action, mounts included (${NAMEABLE.length})`,
  unnamed.length === 0, unnamed.join(", "));
ok("...and the mounted ones are read from their modules, never retyped here",
  /MIXER_ACTIONS\.join/.test(src) && /VOICELAB_ACTIONS\.join/.test(src)
  && /REFPROFILE_ACTIONS\.join/.test(src));

console.log("\n  -- the dual-control seams --");

ok("every mutation stamps attribution (byOf reaches the ledger)",
  /noteLedger\(d, \{ by: byOf\(b\), action/.test(src));
ok("mutations answer with their dirty regions",
  /dirty = dirtyBetween\(before, after/.test(src));
ok("region audio is content-addressed and immutable",
  /reg\\d\+_\[0-9a-f\]\{12\}\\.wav/.test(src) && src.includes("immutable"));
ok("the serve lane has a per-call fallback",
  src.includes("serveTransport") && src.includes("runOnce"));

console.log("\n  -- CLIP BOUNDS: the rules set_clip is bound by (agent/dawparity) --");

/* The behavioural proof is store_test.js (the maths) and scripts/e2e_daw.mjs
 * (over the wire). These are the source pins for the DECISIONS — a rule that
 * quietly stops being implemented is exactly the class this file exists for. */

ok("a move takes the notes with it (the DAW default)",
  /shiftClipNotes\(d, c, delta\)/.test(src));
ok("...and move_notes: false is the trim that leaves them where they are",
  /const moveNotes = b\.move_notes !== false;/.test(src));
ok("a move keeps the clip's LENGTH unless a new end is named",
  /from \+ \(oldTo - oldFrom\)/.test(src));
ok("a resize never deletes a note — it counts the ones it silenced",
  /notesOutside: outside/.test(src) && /const outside = notesOutsideClip\(c\)/.test(src));
/** The source of ONE case label, up to the next one — so a check about this
 *  branch cannot be satisfied (or broken) by a line in a different branch. */
function caseBody(label) {
  const i = src.indexOf(`case "${label}": {`);
  if (i < 0) return "";
  const j = src.indexOf('case "', i + 10);
  return src.slice(i, j < 0 ? src.length : j);
}
ok("...and set_clip's own branch never assigns c.notes (nothing is dropped)",
  caseBody("set_clip").length > 200 && !/\bc\.notes\s*=/.test(caseBody("set_clip")));
ok("bounds are validated against THIS project's length, both edges",
  /inRange\(b\.from_bar, 1, d\.lengthBars, "from_bar"\)/.test(src)
  && /inRange\(b\.to_bar, from, d\.lengthBars, "to_bar"\)/.test(src));
ok("a call that names no change refuses, and says which fields would be one",
  /set_clip needs at least one of from_bar, to_bar, bars or name/.test(src));

console.log("\n  -- set_track: a write that changes nothing does not answer ok --");

/* THE HOLE, exactly: `{action:"set_track", slug, track, patch:"tr909"}` used
 * to return 200, a fresh updatedAt and a ledger row reading "set_track", and
 * change nothing — `patch` is what the field is called INSIDE the document,
 * and the case only ever read six others. daw_set_track's schema is
 * additionalProperties:false and refuses it at the tool; the route, which the
 * page and every script also reach, took it. Both hands, one rule.
 *
 * Measured through the real dispatcher on a scratch dir: the four refusals
 * below answer 400 and leave updatedAt and the ledger where they were; a real
 * change still answers 200. The pins here are the source half. */
{
  const body = caseBody("set_track");
  const AGENT = dawTools(async () => ({}), (x) => x).find((t) => t.name === "daw_set_track");
  const declared = Object.keys(AGENT?.inputSchema.properties || {})
    .filter((k) => k !== "slug" && k !== "track");
  ok("a field set_track does not have is REFUSED, not ignored",
    /set_track has no field/.test(body) && /Refused rather than ignored/.test(body));
  ok("...and the refusal names the fields it does take",
    /It takes \$\{SET_TRACK_FIELDS\.join/.test(body));
  ok("...and the ones it takes are exactly the ones daw_set_track declares "
    + `(${declared.join(", ")}) — one rule, two hands`,
  declared.length > 0
    && declared.every((k) => new RegExp(`"${k}"`).test(body.match(/const SET_TRACK_FIELDS = \[[^\]]+\]/)?.[0] || "")),
  declared.join(", "));
  ok("...and `patch` — the document's own name for it — is answered with `instrument`",
    /patch: "instrument/.test(body));
  ok("...while solo and pan are answered with the mixer strip they really live on",
    /solo:[\s\S]{0,40}mixer_set/.test(body) && /pan:[\s\S]{0,40}mixer_set/.test(body));
  ok("a call with no field at all refuses too, rather than stamping updatedAt and "
    + "a ledger row for a change that never happened",
    /set_track needs at least one of/.test(body) && /ledger row for a change that never happened/.test(body));
  ok("...and an explicitly-undefined field is not a field (the MCP tool forwards "
    + "every argument, present or not)",
    /b\[k\] !== undefined/.test(body));
  ok("the envelope is not mistaken for a field: action, slug, track and by pass",
    /const ENVELOPE = \["action", "slug", "track", "by"\]/.test(body));
}

console.log("\n  -- the audition renders the track's PATCH, not its object --");

ok("preview_note reads instrument.patch (a track's instrument is {patch, params})",
  /const patch = t\.instrument\.patch;/.test(src) && /inst: patch, params,/.test(src));
ok("...and its cached name can satisfy the preview GET's own regex",
  /pv_\$\{patch\}_/.test(src));
ok("...and the audition job carries the instruments dir, like every other render",
  /instruments_dir: instrumentsDir\(\)/.test(caseBody("preview_note")));

console.log("\n  -- CREDITS: the licence seam is wired, and cannot be skipped --");

/* The binding requirement, guarded structurally: a render that used a
 * licensed patch MUST append a licence_attach event carrying the
 * attribution text. These are source pins in the same spirit as the
 * Tier-1 marker's (provenance_test.js) — the behavioural proof lives in
 * scripts/e2e_daw.mjs, which drives the real route and reads the real
 * ledger. Both, because a seam that is wired can still stop being called. */

ok("routes.js appends licence_attach to the provenance ledger",
  src.includes('type: "licence_attach"') && src.includes("prov.append"));
ok("the event carries the attribution TEXT, the spdx id and the source url",
  /attributionText: pack\.attribution/.test(src)
  && /spdx: pack\.licence\.spdx/.test(src)
  && /sourceUrl: pack\.source/.test(src));
ok("render attaches licences BEFORE it renders bytes (cache hits are credited too)",
  src.indexOf("await attachLicences(slug, doc") < src.indexOf("await ensureRegions(slug, doc, fromBar"));
ok("bounce attaches them too, and embeds them in the exported file's tags",
  /case "bounce"/.test(src) && src.includes("await attachLicences(slug, doc")
  && src.includes("tagBounce"));
ok("the attribution reaches tag_audio through the meta file",
  /attribution: lines/.test(src));
ok("credits are READ back out of the ledger, not from a second list that could drift",
  /prov\.read\(provScope\(slug\), \{ type: "licence_attach" \}\)/.test(src));
ok("attaching is idempotent — a re-render must not grow the ledger",
  src.includes("already.has(packId)"));
ok("a lost licence_attach is logged LOUDLY, never swallowed",
  /licence_attach LOST/.test(src));
ok("builtin patches carry no licence duty (packsUsedBy skips them)",
  /if \(!row\?\.pack\) continue;/.test(src));

console.log("\n  -- the palette: nothing downloads before a licence is shown --");

ok("install_patch refuses without accept_licence and returns the licences instead",
  /b\.accept_licence !== true/.test(src) && /needsAccept: true/.test(src));
ok("...and the refusal names what it would have downloaded, with sizes",
  /licences: gate/.test(src) && /bytes: gate\.reduce/.test(src));
ok("a generate-this-part patch refuses assignment with its OWN message",
  /throw new Error\(row\.refusal\)/.test(src));
ok("an uninstalled patch refuses and names the packs to install",
  src.includes("packsNeededFor") && src.includes("is not installed"));
ok("the render job carries the instruments dir, so the engine follows the server",
  /instruments_dir: instrumentsDir\(\)/.test(src));
ok("the note job carries the track's instrument params",
  /params: e\.params/.test(src));
ok("probe mirrors BOTH tables: the builtins and the whole palette",
  src.includes("storeTails") && src.includes("storePatchTails"));

/* A project is a document, not an installation — it arrives from someone else
 * naming packs this disk never had. Proven by hand against a fresh instruments
 * directory: before this, opening a shared project succeeded and RENDERING it
 * died whole ("Refusal: Patch 'salamander' is not installed"), naming neither
 * the track nor the packs. These pin the three halves of the fix. */
ok("an unvoiceable track is silenced, not fatal",
  src.includes("silencedByMissingPacks"));
ok("...by dropping its notes from the EVENTS, so the region hash follows",
  /noteEvents\(doc\)\.filter\(\(e\) => !dead\.has\(e\.trackId\)\)/.test(src));
ok("...and the render reply names the packs that would bring it back",
  src.includes("missingPacks: regions.missingPacks"));

console.log("\n  -- THE ARRANGER writes through the switch, never around it --");

/* The whole point of arrange_bigroom is that its document is one a person
 * could have clicked together: every step is a route body run through the
 * same dispatcher. These pin that decision, and the refusal that keeps a
 * half-song from landing on top of someone's tracks. */
const arr = caseBody("arrange_bigroom");
ok("the arranger case exists and is not trivial", arr.length > 800);
ok("it plans with server/daw/arrange.js (bigroomPlan + resolveRefs)",
  /import \{ bigroomPlan, resolveRefs \} from "\.\/arrange\.js"/.test(src)
  && /bigroomPlan\(\{ seed: b\.seed, key: b\.key, tempo: b\.tempo, structure: b\.structure \}\)/.test(arr));
ok("every step goes through runAction — the dispatcher — not the store",
  /runAction\(req, \{ \.\.\.body, by \}\)/.test(arr) && !/updateProject\(|mutate\(|writeDoc\(/.test(arr));
ok("runAction re-enters dispatch() and turns a route error into a thrown step error",
  /async function dispatch\(req, res, b\)/.test(src)
  && /await dispatch\(req, res, body\);/.test(src)
  && /throw new Error\(`\$\{body\.action\}: \$\{out\.error\}`\)/.test(src));
ok("handle() itself now delegates to dispatch(), so both hands share one switch",
  /return dispatch\(req, res, b\);/.test(src));
ok("track ids are resolved from the add_track replies, not guessed",
  /if \(step\.action === "add_track"\) ids\[step\.name\] = r\.trackId;/.test(arr));
ok("a non-empty project is refused (a whole song, or nothing)",
  /is not empty/.test(arr) && /doc\.tracks\.length \|\| doc\.meterMap\.length > 1/.test(arr));
ok("with no slug it CREATES the project through the create action",
  /action: "create", name, bpm: plan\.meta\.tempo/.test(arr));
ok("the reply hands the Ear its roles and says nothing was rendered",
  /roles,/.test(arr) && /Nothing is rendered yet/.test(arr));


console.log("\n  -- the bounce's second pass: the loudness stage is wired, one door --");
ok("bounce reads the project's master.target_lufs, or this call's own (null = off for one bounce)",
  /bounceOptions\(b, doc\.master\?\.target_lufs \?\? null\)/.test(src));
ok("...and sends target_lufs to the encoder ONLY when aimed (absent = today's bytes)",
  /\.\.\.\(aimed \? \{ target_lufs: Number\(targetLufs\) \} : \{\}\)/.test(src));
ok("ceiling_db / max_limit_db ride along per call, range-checked",
  /ceiling_db: options\.ceiling_db, max_limit_db: options\.max_limit_db/.test(src)
  && /const options = bounceOptions\(b,/.test(src));
ok("the reply carries the stage's report, the bit depth and the stereo switch",
  /\{ loudness: enc\.loudness \}/.test(src) && /stereo: doc\.master\?\.stereo === true/.test(src) && /bit_depth: enc\.bit_depth/.test(src));
ok("the arranger's reply exposes master.stereo and master.target_lufs",
  /stereo: doc\.master\?\.stereo === true, target_lufs: doc\.master\?\.target_lufs \?\? null/.test(src));

/* ══════════ §3.4 THE FAST SERVE LANE: two children, one ceiling ═════════
 * The measurement that forced this: one FIFO queue meant a 5 ms knob turn
 * queued behind an 8.5 s region render was an 8.5 s knob. These pin the
 * three decisions — a lane is a factory (so both lanes share every rule
 * about handshakes, timeouts and cooldowns rather than one being a copy that
 * drifts), the audition uses the fast one, and the fast one enforces its own
 * ceiling so it cannot be talked into becoming a second render lane. */

console.log("\n  -- §3.4 the fast serve lane, and the ceiling that keeps it fast --");

ok("a lane is built by a factory, and there are exactly two of them",
  /const makeLane = \(name\) =>/.test(src)
  && /const lane = makeLane\("render"\);/.test(src)
  && /const laneFast = makeLane\("fast"\);/.test(src));
ok("every lane function takes its lane (no lane is hard-coded into the handshake, the drop or the timeout)",
  /function laneDrop\(L, proc\)/.test(src) && /function spawnServe\(L\)/.test(src)
  && /async function serveProc\(L\)/.test(src) && /async function serveOne\(L, cmd, job, timeoutMs\)/.test(src)
  && !/\blane\.(proc|starting|seq|brokenUntil|stderrTail)\b/.test(src));
ok("the queue wait is MEASURED per job, not sampled — the number §3.4 is about",
  /waited = Date\.now\(\) - queuedAt;/.test(src)
  && /L\.waits\.n\+\+; L\.waits\.last = waited/.test(src)
  && /queue_ms: waited/.test(src));
ok("the audition rides the fast lane; regions, bounces and calibration ride the render lane",
  /rr = await runOneNote\("render"/.test(caseBody("preview_note"))
  && /const runEngineFast = \(mode, job, timeoutMs = 60_000\) => runLane\(lane, mode, job, timeoutMs\);/.test(src));
ok("the fast lane refuses a job over its ceiling, and the refusal names the ceiling in seconds AND samples",
  /const FAST_LANE_SECONDS = 10;/.test(src)
  && /if \(Number\(job\.n_samples\) > ceiling\)/.test(src)
  && /renders at most \$\{FAST_LANE_SECONDS\} s of audio/.test(src)
  && /\$\{ceiling\} samples at \$\{sr\} Hz/.test(src));
ok("...and the ceiling is enforced in the LANE, not at one call site that could be forgotten",
  /async function runOneNote\(mode, job, timeoutMs = 30_000\) \{[\s\S]{0,600}?ceiling/.test(src));
ok("AIPLAY_DAW_NO_FAST_LANE=1 puts auditions back on the render lane — the before/after switch",
  /const NO_FAST_LANE = process\.env\.AIPLAY_DAW_NO_FAST_LANE === "1";/.test(src)
  && /runLane\(NO_FAST_LANE \? lane : laneFast, mode, job, timeoutMs\)/.test(src));

/* ═════════ §1 THE LOOK-AHEAD: a cost model fitted from its own evidence ══
 * The arithmetic is proven in ahead_test.js against the measured table; what
 * is pinned here is that the table is IN this file and the line is fitted
 * from it rather than hand-typed beside it, which is the only way the model
 * and its evidence cannot drift apart. */

console.log("\n  -- §1 the region cost model carries its own measurements --");

ok("the five measured region renders are in the source, as data",
  /export const SPEC_REGION_COST = Object\.freeze\(\[/.test(src)
  && /\[0, 305\], \[37\.5, 2607\], \[112\.5, 6219\], \[157\.5, 8498\], \[232\.5, 11068\]/.test(src));
ok("...and the line is FITTED from that table, not typed next to it",
  /export const CHAIN_FIT = Object\.freeze\(fitLine\(SPEC_REGION_COST\)\);/.test(src));
ok("the mono path's constant is the mean of its four measurements, written as the sum",
  /\(201 \+ 208 \+ 209 \+ 197\) \/ 4/.test(src));
ok("the per-machine refit takes both parameters and CLAMPS the slope, so it cannot invert",
  /export function calibrateCost/.test(src)
  && /b: clampTo\(\[CHAIN_FIT\.b \* CAL_SLOPE_BAND\[0\], CHAIN_FIT\.b \* CAL_SLOPE_BAND\[1\]\], f\.b\)/.test(src)
  && /export const CAL_SLOPE_BAND = Object\.freeze\(\[0\.25, 4\]\);/.test(src));
ok("...and it refuses to fit at all on too few observations, or ones too close together",
  /rows\.length < CAL_MIN_SAMPLES \|\| spread < CAL_MIN_SPREAD_S/.test(src)
  && /method: "shipped", a: CHAIN_FIT\.a, b: CHAIN_FIT\.b/.test(src));
ok("the run that forced this is written down beside it (a scalar turned 12 late regions into 0)",
  /turned "twelve\s*\n?\s*\* regions will arrive late" into "none will"/.test(src)
  || /regions will arrive late/.test(src));
ok("observations are written beside the region files they describe, and a lost one never costs audio",
  /const TIMES_FILE = "render_times\.json";/.test(src)
  && /path\.join\(cacheDir\(slug\), TIMES_FILE\)/.test(src)
  && /catch \{ \/\* a lost calibration point is an estimate, not a render \*\/ \}/.test(src));
ok("render_ahead renders ONE region — the one the playhead reaches in `lead` — and orders it first",
  /ensureRegions\(slug, doc, target\.fromBar, target\.toBar,\s*\{ order: \[target\.idx\] \}\)/.test(caseBody("render_ahead")));
ok("...with the lead DERIVED from the estimate when the caller names none",
  /here\?\.estimatedMs \?\? 0\) \/ 1000/.test(caseBody("render_ahead")));
ok("render_plan renders nothing: no ensureRegions, no engine call in its branch",
  !/ensureRegions|runEngineFast|runOneNote/.test(caseBody("render_plan")));
ok("...and it says a late verdict is a measurement rather than a failure",
  /a measurement, not a failure/.test(caseBody("render_plan")));
ok("ensureRegions took order/onRegion/deadlineMs and kept its default byte-for-byte behaviour",
  /async function ensureRegions\(slug, doc, fromBar, toBar, opts = \{\}\)/.test(src)
  && /const first = Array\.isArray\(opts\.order\) \? opts\.order : \[\];/.test(src)
  && /opts\.onRegion\?\.\(rowOut\)/.test(src)
  && /out\.sort\(\(a, b\) => a\.idx - b\.idx\)/.test(src));
ok("a skipped region says WHY, rather than being quietly missing",
  /skipped: true[\s\S]{0,200}budget was spent/.test(src));

/* ══════════════ §2 edit_notes: ONE write, and an inverse ════════════════ */

console.log("\n  -- §2 the whole gesture, once (the behaviour is ahead_test.js) --");

const edit = caseBody("edit_notes");
ok("edit_notes is one mutate() — one document write, one hash diff, one ledger row",
  (edit.match(/await mutate\(/g) || []).length === 1
  && !/updateProject\(|writeDoc\(/.test(edit));
ok("...capped at the same 2000 record_notes carries, named as a constant",
  /const EDIT_NOTES_CAP = 2000;/.test(src) && /b\.notes\.length > EDIT_NOTES_CAP/.test(edit));
ok("...refusing the same note twice, because two entries would make the returned undo wrong",
  /appears twice/.test(edit) && /seen\.add\(id\)/.test(edit));
ok("...and refusing an entry that names no change at all", /names no change/.test(edit));
ok("the inverse is snapshotted BEFORE the write and returned as a postable body",
  /undo\.push\(\{ note: n\.id, bar: n\.bar/.test(edit)
  && /m\.extra\.undo = \{ action: "edit_notes"/.test(edit));
ok("it is NOT called move_notes (that name is already a boolean field on set_clip)",
  !/case "move_notes"/.test(src) && /const moveNotes = b\.move_notes !== false;/.test(src));

/* ═══════ §3 the Voice Lab is MOUNTED, not embedded — and says when absent ══ */

console.log("\n  -- §3 the Voice Lab's mount, and preview_note's two new fields --");

ok("voicelab.js is mounted in ONE line beside the mixer's, sharing this file's catch",
  /const voicelab = await import\("\.\/voicelab\.js"\)/.test(src)
  && /const voiceReply = await voicelab\?\.handleVoiceLabAction\?\.\(action, b, voiceCtx\);/.test(src));
ok("...and it is handed the SHORT-JOB lane as runEngineVoice, which is the whole of §3.4 for it",
  /const voiceCtx = \{ runEngineFast, runEngineVoice: runOneNote, safe \};/.test(src));
ok("...and a module that is PRESENT but fails to load says so loudly (absent is silent)",
  /is present but failed to load/.test(src) && /ERR_MODULE_NOT_FOUND/.test(src));
ok("params_override and analysis are FORWARDED to voice_lab, not reimplemented here",
  /handleVoiceLabAction\?\.\("voice_lab", b, voiceCtx\)/.test(caseBody("preview_note"))
  && !/normParams/.test(caseBody("preview_note")));
ok("...and on a tree without the module the caller is told which fields to drop, not handed a null",
  /belong to the Voice Lab, and/.test(caseBody("preview_note"))
  && /Drop both fields/.test(caseBody("preview_note")));
ok("...and preview_note still writes NOTHING: no mutate, no ledger, no updatedAt",
  !/mutate\(|noteLedger|updateProject/.test(caseBody("preview_note")));
ok("the audio route serves stems by the pattern voicelab.js NAMES them with, not a retyped copy",
  /voicelab\?\.STEM_NAME_RE\?\.test\(n\) === true/.test(src));
ok("...and the region prune no longer eats a lane's stems (reg5_… matches reg5_…_trk_… too)",
  /voicelab\.isPrunableRegion\(f, r\.idx, name\)/.test(src));

/* ═════════ THE ARRANGER'S DESCRIPTION IS THE ARRANGER'S OWN NUMBERS ══════
 * daw_arrange_bigroom's description had gone stale in the way descriptions
 * do: the track split into clap+snare and hats happened in arrange.js and
 * the sentence still said "clap+hat", and the faders it quoted were the
 * SECOND take's (lead -2, clap+hat -5, crash -9, riser -10) against a plan
 * that ships lead +4, clap+snare -2, hats +9, crash -3, riser -1. An agent
 * reads that description and acts on it. So the numbers are now imported
 * from arrange.js and interpolated, and this holds them equal. */

console.log("\n  -- the arranger's tool description quotes the arranger's own constants --");
{
  const desc = dawTools(async () => ({}), (x) => x)
    .find((t) => t.name === "daw_arrange_bigroom").description;
  const faders = Object.entries(FADERS).map(([n, v]) => `${n} ${v > 0 ? "+" : ""}${v}`).join(", ");
  ok(`the faders it states are FADERS itself (${faders})`, desc.includes(faders));
  ok("every track arrange.js lays down is named in the description, and none that it does not",
    Object.keys(ROLES).every((n) => desc.includes(n)) && !/clap\+hat/.test(desc),
    Object.keys(ROLES).filter((n) => !desc.includes(n)).join(", "));
  ok(`the snare roll's velocities are ROLL (${ROLL.from}→${ROLL.to}), not the second take's 72→127`,
    desc.includes(`${ROLL.from}→${ROLL.to}`) && !/72→127/.test(desc));
  ok(`the sub's shipped release is stated (${SUB.release} ms — the reports had quoted 200)`,
    desc.includes(`${SUB.release} ms release`));
  ok("the sidechain, the master ceiling and the loudness target are read from the plan's constants",
    desc.includes(`ratio ${SIDECHAIN.ratio}`) && desc.includes(`${MASTER.ceiling_db} dBTP`)
    && desc.includes(`${MASTER.target_lufs} LUFS`));
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.log("  failed:\n   " + failures.join("\n   ") + "\n");
  process.exit(1);
}
