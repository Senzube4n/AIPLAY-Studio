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
  // the dirty-region loop
  "render",
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
];

for (const a of EXPECTED) {
  ok(`action "${a}" is handled`, actions.includes(a));
}
const extra = actions.filter((a) => !EXPECTED.includes(a));
ok("no action is handled but undeclared here", extra.length === 0, extra.join(", "));

// The default-branch error message must name every real action — it is the
// discovery surface an agent that guessed wrong actually reads.
const defaultMsg = src.match(/Unknown action[^;]+/)?.[0] ?? "";
const unnamed = EXPECTED.filter((a) => !defaultMsg.includes(a));
ok("the unknown-action message names every action", unnamed.length === 0, unnamed.join(", "));

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

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.log("  failed:\n   " + failures.join("\n   ") + "\n");
  process.exit(1);
}
