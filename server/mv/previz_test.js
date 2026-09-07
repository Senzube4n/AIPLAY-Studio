/**
 * Blocked shots — the gates for the words, the arithmetic and the two vocabularies.
 *
 * Almost everything here runs with NO BLENDER, because almost everything worth
 * checking is not the render. The words are the artefact that reaches the
 * model, the camera-angle recovery is closed-form arithmetic with a right
 * answer, and the two move vocabularies drifting apart is a fault that shows up
 * as one failed render, months later, with a message about an unknown name and
 * no hint that the table is the stale half.
 *
 * ⚠ AND TWO SECTIONS NEAR THE END DO NOT RUN ON SOURCE TEXT AT ALL, because
 * one of them used to and that is how a real bug passed green. The claim "a
 * refused render leaves the previous good one alone" was pinned as a regex over
 * previz.js's own characters; the cleanup could delete a gate-passing blockout
 * and the regex went on matching, because a regex over a file cannot see what
 * the file DOES. Those are now behavioural: a STUB BLENDER writes files and
 * exits non-zero, and the assertions are on what is left on disk afterwards.
 * The stub is a four-line C# console app compiled with the csc.exe that ships
 * with .NET Framework — the same bargain blockout_test.js makes with ffmpeg, and
 * it skips loudly (with a count) when the compiler is not there. A .cmd or a .js
 * cannot stand in: blender.js spawns config.blender.exe directly, and Node on
 * Windows refuses to spawn a .cmd without a shell (EINVAL).
 *
 * The last section DOES launch the REAL Blender, and only when it is installed —
 * the same bargain the python suites in the hook make. It is the one check that
 * cannot be made any other way: the toolkit is a SEPARATE REPOSITORY on the far
 * side of a licence boundary, so a move renamed over there is invisible to
 * every static check in this one. Four seconds per commit for the only alarm
 * that would ever ring.
 *
 * Runs standalone (`node server/mv/previz_test.js`) and in the pre-commit hook.
 * Writes into a temp directory, which it removes, and one scratch Blender render
 * when Blender is present.
 */
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/* ⚠ THE OUTPUT DIR IS DECIDED BEFORE config.js IS FIRST IMPORTED, and static
 * imports hoist — so every import that reaches config.js is dynamic below. Same
 * discipline as server/mv/blockout_test.js and server/mv/plan_test.js, and now
 * for a reason this file has of its own: the behavioural half creates real
 * projects and writes real files, and it must not write them into the owner's
 * own output folder next to work they care about.
 *
 * AIPLAY_APPDATA is deliberately NOT set. Projects live under outputDir, which
 * is what this redirects; appdata holds the saved preferences, and those are
 * where a machine records the blender.exe it really has. Isolating them would
 * turn the last section's real-Blender check into a skip on any machine that
 * had moved Blender — a green tick bought by not looking. */
const OUT = path.join(os.tmpdir(), `mv-previz-test-${process.pid}-${Date.now().toString(36)}`);
process.env.AIPLAY_OUTPUT = OUT;
mkdirSync(OUT, { recursive: true });

const { MOVES, ALIASES, FRAMINGS, listMoves, resolveMove, shotPlan } = await import("./moves.js");
const { angleFromTrack, SCENES, TAKES, FRAMES_DEFAULT, BLOCKOUT_FRAMES_DEFAULT,
        PROP_KINDS, SPEC_VERSION, framesFor, previzCatalogue,
        previzShot } = await import("./previz.js");
const { CONTROL_SPEC } = await import("../control/control.js");
const { blenderStatus, SETS, SETS_FALLBACK, BUILTINS, toolkitSets } = await import("./blender.js");

let pass = 0, skipped = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(path.join(HERE, f), "utf8");
const PREVIZ = src("previz.js");
const MOVES_SRC = src("moves.js");
const BIBLE = src("bible.js");

console.log("\n-- the words --");

/* Every move, every framing, every pronoun. 19 names x 7 framings x 4 pronouns
 * is 532 sentences, generated in a millisecond, and any one of them reaching a
 * prompt with a hole in it is a hole in the only artefact that steers a clip. */
const PRONOUNS = ["they", "she", "he", "it"];
let generated = 0;
const holes = [];
for (const name of listMoves()) {
  for (const framing of FRAMINGS) {
    for (const pronoun of PRONOUNS) {
      const p = shotPlan(name, { framing, pronoun, subject: "Kaya", third: "right" });
      generated++;
      for (const [k, v] of Object.entries({ camera: p.camera, framing_line: p.framing_line,
                                            placement: p.placement, lens: p.lens })) {
        if (!v || !v.trim()) holes.push(`${name}/${framing}/${pronoun}: ${k} is empty`);
        if (/undefined|\[object|\bnull\b|\$\{/.test(v)) holes.push(`${name}/${framing}/${pronoun}: ${k} — ${v}`);
        if (/ {2}|\s,|\s\./.test(v)) holes.push(`${name}/${framing}/${pronoun}: ${k} has a spacing fault — ${v}`);
      }
    }
  }
}
ok(`every move writes four whole sentences in every framing (${generated} plans)`,
  !holes.length, holes.slice(0, 4).join("\n          "));

/**
 * PRONOUN AGREEMENT, which is not fussiness.
 *
 * The first draft interpolated ONE `pronoun` into the subject, object and
 * possessive slots alike and shipped "matching she speed" and "behind she
 * shoulder" into the text that goes to the model. A prompt is read by something
 * trained on English; ungrammatical English is noise in exactly the sentence
 * that is supposed to be doing the steering. This catches it by the only test
 * that needs no grammar engine: a plan asked for one pronoun must contain no
 * form belonging to another.
 */
const FORMS = {
  they: ["they", "them", "their"], she: ["she", "her"],
  he: ["he", "him", "his"], it: ["it", "its"],
};
const wrong = [];
for (const name of Object.keys(MOVES)) {
  for (const pronoun of PRONOUNS) {
    const words = shotPlan(name, { pronoun, subject: "Kaya", third: "left" }).words;
    for (const [other, forms] of Object.entries(FORMS)) {
      if (other === pronoun) continue;
      /* "it"/"its" are ordinary English words in every one of these sentences
       * ("chasing it", "its distance"), so they can never be evidence of a
       * mis-declension. Every other set can. */
      if (other === "it") continue;
      for (const f of forms) {
        if (new RegExp(`\\b${f}\\b`, "i").test(words)) {
          wrong.push(`${name} asked for "${pronoun}" but says "${f}": ${words.slice(0, 110)}…`);
        }
      }
    }
  }
}
ok("...declined properly — a plan never mixes one subject's pronouns with another's",
  !wrong.length, wrong.slice(0, 3).join("\n          "));

ok("...and the placement sentence says WHERE IN THE FRAME, not just that there is a subject",
  Object.keys(MOVES).every((m) => {
    const p = shotPlan(m, { subject: "Kaya", third: "right" }).placement;
    return /third|centre|frame|off-axis|down through|small in|edges/.test(p);
  }),
  "placement is the sentence people leave out and the one that pays — "
  + "'orbit around her' gives a subject nailed to frame centre with the world spinning");

ok("the shot that gets pasted carries the sentence, not just the label",
  Object.keys(MOVES).every((m) => {
    const s = shotPlan(m, { subject: "Kaya" }).board_shot;
    return s.action.includes("The camera") || s.action.includes("Handheld") || s.action.includes("One continuous");
  }),
  "clipPrompt() joins shotType/angle/cameraMove/lensFeel/lighting into a comma list — "
  + "`cameraMove` is a LABEL, so the move has to be in `action` or it never reaches the prompt");

console.log("\n-- the two vocabularies --");

/**
 * bible.js hands an LLM a cameraMove word list. Every `board_move` this module
 * emits has to be a word from THAT list, or a plan writes a board the bible's
 * own spec does not describe — and the drift is invisible until a model is
 * confused by a word nothing told it about.
 */
const enumLine = BIBLE.match(/cameraMove:\s*"([^"]+)"/);
ok("bible.js still declares a cameraMove vocabulary this can be checked against",
  !!enumLine, "the regex found nothing — if the spec moved, move this check with it");
const boardWords = new Set((enumLine?.[1] || "").split("|").map((s) => s.trim()));
const strangers = [...new Set(Object.values(MOVES).map((m) => m.boardMove))]
  .filter((w) => !boardWords.has(w));
ok(`...and every board_move is one of its words (${boardWords.size} words)`,
  !strangers.length, `not in the bible's vocabulary: ${strangers.join(", ")}`);

/* The lossy ones must SAY they are lossy. offset_follow mapped to "tracking"
 * with boardMoveExact:true would be the quiet lie this whole feature is
 * arranged to avoid — "tracking" is precisely the robotic follow it replaces. */
const mislabelled = Object.entries(MOVES)
  .filter(([k, m]) => m.boardMoveExact && m.boardMove !== k.replace(/_/g, "-")
                      && !["push_in", "pull_out", "speed_ramp"].includes(k));
ok("...and a move whose board word is a stand-in is marked as one",
  !mislabelled.length, mislabelled.map(([k]) => k).join(", "));
ok("offset_follow in particular is NOT sold as exact",
  MOVES.offset_follow.boardMoveExact === false && MOVES.offset_follow.boardMove === "tracking");

ok("every legacy spelling resolves to a real entry",
  Object.entries(ALIASES).every(([, a]) => !!MOVES[a.move]),
  Object.entries(ALIASES).filter(([, a]) => !MOVES[a.move]).map(([k]) => k).join(", "));

ok("the composite list is DERIVED from the vocabulary, not typed twice",
  TAKES.length === Object.values(MOVES).filter((m) => m.take).length && TAKES.includes("follow_orbit"),
  `TAKES=${TAKES.join(",")}`);

ok("an unknown move is refused with the whole list, not a bare failure",
  (() => { try { shotPlan("swoosh"); return false; }
           catch (e) { return /Unknown camera move/.test(e.message) && /offset_follow/.test(e.message); } })());

/* ── THE KEYWORDS HAVE TO REACH THE WORDS ──────────────────────────────────
 *
 * The move keywords steered the CAMERA from the day they were added and did
 * not steer the SENTENCE, and the sentence is the one artefact previz.js says
 * will influence what the model draws. Every assertion below is something the
 * app really did record against the four PRISM stage blockouts, checked
 * against those clips:
 *
 *   words said              the clip measured
 *   "arcs 90°"              75.000° swept (eye about the aim, first to last)
 *   "cut at the waist"      the whole 1.70 m body, 352.6 px in a 704 px frame
 *   "ends small in the      the neck at exactly (640, 352) on all 121 frames,
 *    middle of the ground"  x and y range zero
 *   the SAME paragraph      121/121 frames on screen against 42/121, and
 *    for both cranes        4,176 visible pixels in the last frame against 0
 *
 * None of the suites caught any of it, which is why these are here. */
console.log("\n-- the move's keywords, in the words --");

ok("an orbit's sweep is the one that was asked for, not the vocabulary's default",
  (() => {
    const w = shotPlan("orbit", { subject: "Kaya", moveArgs: { degrees: 75 } }).words;
    return /75°/.test(w) && !/90°/.test(w) && /90°/.test(shotPlan("orbit", {}).words);
  })(),
  "the toolkit swept 75.000° (measured on blockout_s2_stage_orbit) and the plan said 90°");

ok("a push-in framed by keyword stops claiming a framing the render will not give",
  (() => {
    const p = shotPlan("push_in", { subject: "Kaya", moveArgs: { framing: "full" } });
    const d = shotPlan("push_in", { subject: "Kaya" });
    return p.framing === "wide" && !/cut at the waist/.test(p.words)
      && !/about half its starting distance/.test(p.words)
      && d.framing === "medium" && /about half its starting distance/.test(d.words);
  })(),
  "framing=full ended 14.3178 m -> 10.0662 m (ratio 0.703, not 'about half') with the "
  + "whole body in frame; the plan said 'a medium shot ... cut at the waist on a figure'");

ok("a caller's framing gives way to the keyword the render will actually obey",
  shotPlan("push_in", { framing: "close", moveArgs: { framing: "full" } }).framing === "wide"
  && shotPlan("push_in", { framing: "close" }).framing === "close"
  && shotPlan("push_in", {}).framing === "medium");

ok("aim_at replaces the sentence that says the subject drifts out of the middle",
  (() => {
    for (const [mv, kw] of [["crane", { aim_at: "neck", rise: 6 }],
                            ["floor_rise", { aim_at: "neck", climb: 6 }]]) {
      const a = shotPlan(mv, { subject: "Kaya", moveArgs: kw });
      const d = shotPlan(mv, { subject: "Kaya" });
      if (a.words === d.words) return false;
      if (!/pinned/.test(a.placement) || !/neck/.test(a.placement)) return false;
      if (/ends small in the middle/.test(a.words)) return false;
      if (/nothing holds still in the middle/.test(a.words)) return false;
    }
    return true;
  })(),
  "the neck sits at exactly (640, 352) on all 121 frames of both clips");

ok("two shots that share a move name and differ only in keywords no longer share their words",
  shotPlan("crane", { subject: "Kaya", moveArgs: { aim_at: "neck", rise: 6 } }).words
    !== shotPlan("crane", { subject: "Kaya", moveArgs: {} }).words,
  "blockout_s1_stage_crane and blockout_free_stage_crane carry the same spec sha and the "
  + "same move, and the app recorded the same paragraph for both — 121/121 frames on "
  + "screen against 42/121");

ok("the keywords are reported beside the words they steered",
  (() => {
    const p = shotPlan("orbit", { moveArgs: { degrees: 75 } });
    return p.move_args?.degrees === 75
      && JSON.stringify(shotPlan("orbit", {}).move_args) === "{}";
  })());

ok("a keyword with no sentence to change is carried without breaking one",
  (() => {
    const p = shotPlan("crane", { subject: "Kaya", moveArgs: { rise: 6.0 } });
    return typeof p.words === "string" && p.words.length > 80
      && p.move_args.rise === 6 && !/undefined/.test(p.words);
  })());

console.log("\n-- the camera angle, recovered from the track --");

/**
 * THE INVERSE, PROVEN AGAINST THE FORWARD.
 *
 * The toolkit places a reference camera along
 *     dir = (cos el·sin az, −cos el·cos az, sin el)
 * from the subject outwards, and its camera looks back down −dir. previz.js
 * inverts that to put the reference frame at the blocked shot's own viewpoint.
 * An inverse that is subtly wrong renders a reference from a plausible-looking
 * angle that is not the shot's, which is exactly the kind of wrong nobody sees.
 * So: build the forward vector for a known pair, and demand the pair back.
 */
const D = Math.PI / 180;
let worst = 0, worstAt = "";
for (let az = -180; az <= 180; az += 15) {
  for (let el = -80; el <= 80; el += 10) {
    const fx = -Math.cos(el * D) * Math.sin(az * D);
    const fy = Math.cos(el * D) * Math.cos(az * D);
    const fz = -Math.sin(el * D);
    const got = angleFromTrack({ forward: [[fx, fy, fz]], frames: [1] }, { u: 0 });
    // ±180 are the same bearing; compare on the circle, not on the number line.
    const dAz = Math.abs(((got.azimuth - az + 540) % 360) - 180);
    const err = Math.max(dAz, Math.abs(got.elevation - el));
    if (err > worst) { worst = err; worstAt = `az ${az} el ${el} -> ${got.azimuth}/${got.elevation}`; }
  }
}
ok(`the recovered angle round-trips the toolkit's own placement (max error ${worst.toFixed(3)}°)`,
  worst < 0.06, worstAt);

ok("...and u picks a frame across the whole move, not just the ends",
  (() => {
    const t = { forward: [[0, 1, 0], [1, 0, 0], [0, -1, 0]], frames: [1, 2, 3] };
    return angleFromTrack(t, { u: 0 }).frame === 1 && angleFromTrack(t, { u: 0.5 }).frame === 2
        && angleFromTrack(t, { u: 1 }).frame === 3;
  })());

ok("...and a move that aims off-subject says its viewpoint is approximate",
  angleFromTrack({ forward: [[0, 1, 0]], frames: [1], move: "offset_follow" }).aims_at_subject === false
  && angleFromTrack({ forward: [[0, 1, 0]], frames: [1], move: "orbit" }).aims_at_subject === true,
  "offset_follow aims at a null beside and behind the subject BY DESIGN — reporting that "
  + "viewpoint as exact would be a number that is quietly wrong");

ok("a track with no poses is an answer, not a crash",
  (() => { try { angleFromTrack({}, {}); return false; }
           catch (e) { return /no forward vectors/.test(e.message); } })());

console.log("\n-- the three artefacts stay apart --");

ok("the previz clip is marked human-review, in the file system as well as in the doc",
  /USE_HUMAN = "human-review"/.test(PREVIZ) && /markHumanReview\(mp4/.test(PREVIZ),
  "the mark has to travel with the file — anything that finds this clip later "
  + "should learn what it is for from disk, not from remembering to look it up");

ok("...and nothing here calls a previz clip a reference",
  !/reference[^\n]*\bmp4\b/i.test(PREVIZ) && !/model-reference[^\n]*previz\.file/.test(PREVIZ));

ok("the gate is blender.js's, not a second copy of it",
  /import \{[^}]*referenceSafe[^}]*\} from "\.\/blender\.js"/s.test(PREVIZ)
  && !/^export async function referenceSafe/m.test(PREVIZ),
  "two copies of a safety check drift, and the copy that drifts is the one that passes");

ok("...and the reference frame is only CALLED a reference when it passes it",
  /safe\.proven \? "model-reference" : null/.test(PREVIZ));

/* ⚠ THIS ASSERTION USED TO READ `/control video/.test(PREVIZ)` AND IT WAS RIGHT
 * TO FAIL. The claim it guarded — "nothing here wires a blocking clip in as a
 * control video" — stopped being true the day previz.js grew a BLOCKOUT for
 * WAN 2.1 VACE, and a test that had been rewritten to pass would have deleted
 * the guard along with the stale sentence.
 *
 * So it is sharpened rather than relaxed. Three things must all hold:
 *   1. THE LTX MEASUREMENT SURVIVES, in both files, in its own words. It was
 *      never about VACE and it has not been overturned; a reader who meets the
 *      blockout must meet the negative in the same breath.
 *   2. THE TWO CLIPS ARE DIFFERENT FILES with different sidecars and different
 *      `use` values. Sharing one would let a re-render silently hand a model
 *      the clip a director was watching, which is the actual hazard the old
 *      line was pointing at.
 *   3. THE REASON THE BLOCKOUT IS ALLOWED IS NAMED — the NODE, not a change of
 *      mind. Without that, the next reader concludes the negative was ignored. */
ok("the LTX appearance-guide negative is still written down in both files",
  /appearance guide/.test(PREVIZ) && /grey boxes/.test(PREVIZ)
  && /appearance guide/.test(MOVES_SRC) && /grey boxes/.test(MOVES_SRC),
  "a blocking clip fed to LTX as an appearance guide hands the grey boxes back — "
  + "that measurement stands, and neither file may quietly drop it");

ok("...and the previz and the blockout are two files with two sidecars and two uses",
  /USE_CONTROL = "vace-control"/.test(PREVIZ)
  && /BLOCKOUT_SIDECAR_SUFFIX = "\.blockout\.json"/.test(PREVIZ)
  && /markBlockout\(mp4/.test(PREVIZ) && /markHumanReview\(mp4/.test(PREVIZ)
  && /stem\(wantBlockout \? "blockout" : "previz"/.test(PREVIZ),
  "one filename for both would let a re-render replace the clip a director watched "
  + "with a clip that is about to be handed to a model, or the reverse");

ok("...and the blockout is justified by the NODE, not by a change of mind",
  /VACE/.test(PREVIZ) && /control_video/.test(PREVIZ)
  && /different node|different mechanism/.test(PREVIZ)
  && /VACE/.test(MOVES_SRC),
  "\"the measurement was about LTX's appearance guides and this is a different "
  + "node\" is the whole argument; without it on the page the next reader reads "
  + "the blockout as the negative being ignored");

ok("...and the words are not oversold either",
  /caveat/.test(MOVES_SRC) && /does not make the model obey it/.test(MOVES_SRC));

console.log("\n-- the blockout, and the staging that goes into it --");

/* THE FLOOR IS IMPORTED, NOT TYPED, and that is the same rule FRAMES_MIN
 * already holds one line above it. A blockout written at 121 while the gate
 * had moved to 129 would render, pass on this side, and be refused half an
 * hour later by the thing that measures it — which is the exact minute-of-GPU
 * failure previz.js's own comment describes, one layer up. */
ok("a blockout's default length IS the control floor, and it is imported",
  BLOCKOUT_FRAMES_DEFAULT === CONTROL_SPEC.minFrames
  && /BLOCKOUT_FRAMES_DEFAULT = CONTROL_SPEC\.minFrames/.test(PREVIZ),
  "every frame past the floor is render time downstream on a point nobody "
  + "measured, and every frame below it is a clip that gets padded with grey");
ok("...and it is SHORTER than a previz's, because they are different jobs",
  BLOCKOUT_FRAMES_DEFAULT < FRAMES_DEFAULT,
  "six seconds is right for a clip a director watches; the floor is right for "
  + "a clip that is about to cost half an hour of GPU per render");

/* ⚠ THE BUG THIS FUNCTION EXISTS FOR, pinned in both directions.
 *
 * `frames` defaults to null so the two kinds can default differently, and
 * the clamp underneath reads Number.isFinite(Number(v)) — where Number(null)
 * is 0 and 0 IS finite. So an absent frame count went through the clamp
 * instead of past it and came out at the FLOOR: every previz rendered 121
 * frames instead of 144, silently and plausibly. Measured on the scratch
 * instance before the fix, and the file really had 121 frames in it. */
ok("an ABSENT frame count takes the kind's default, not the floor",
  framesFor(null) === FRAMES_DEFAULT
  && framesFor(undefined) === FRAMES_DEFAULT
  && framesFor("") === FRAMES_DEFAULT
  && framesFor(null, { blockout: true }) === BLOCKOUT_FRAMES_DEFAULT,
  `null->${framesFor(null)} undefined->${framesFor(undefined)} `
  + `""->${framesFor("")} blockout null->${framesFor(null, { blockout: true })}`);
ok("...and a PREVIZ's number is still bounded by the contract rather than refused",
  framesFor(96) === CONTROL_SPEC.minFrames
  && framesFor(200) === 200 && framesFor(9999) === 480,
  "a previz is a clip a person watches: 96 is a taste, the floor only exists to "
  + "stop a file that would be refused downstream, and rounding up costs a second");

/* ⚠ THE HALF THAT WAS SILENTLY RAISED, AND IS NOW REFUSED.
 *
 * framesFor used to clamp both kinds alike, so at the route `previz_shot` with
 * `blockout: true, frames: 96` came back 200 with a real 121-frame render on it
 * and said "96" nowhere — not in a note, not in a warning. It also made
 * blocking.py's own BlockingError for a short blockout unreachable from this
 * app, because the clamp always ran first. A blockout is a CONTROL clip and a
 * shorter one is not a shorter control clip, it is not one. */
let refusal = null;
try { framesFor(96, { blockout: true }); } catch (e) { refusal = e.message; }
ok("...but a BLOCKOUT under the floor is REFUSED, and the sentence says why",
  !!refusal && refusal.includes("96") && refusal.includes(String(CONTROL_SPEC.minFrames))
  && /clamped to its last frame/.test(refusal) && /drop `blockout`/.test(refusal),
  refusal === null ? "it did not throw — it was raised to the floor instead"
                   : refusal);
ok("...and a value that is not a number at all falls back rather than becoming 0",
  framesFor("banana") === FRAMES_DEFAULT
  && framesFor(NaN, { blockout: true }) === BLOCKOUT_FRAMES_DEFAULT,
  "NaN is not a short blockout, it is an absent one — refusing it would refuse a typo "
  + "instead of answering it with the default");

/* AND THE DIFFERENCE IS IN THE CATALOGUE, not only in the code. Both surfaces
 * build their cards from this fetch, and a card that says "asking below 121 is
 * rounded up, not refused" is right about a previz and wrong about the kind
 * that costs half an hour of GPU. The rule is data, so it cannot be described
 * two ways. (This needs no Blender: the vocabulary half is unconditional.) */
const cat0 = await previzCatalogue();
ok("...and the catalogue says which kind rounds up and which kind refuses",
  cat0.frames.below === "rounded up to the floor"
  && cat0.blockout.framesBelow === "refused"
  && cat0.blockout.framesMin === CONTROL_SPEC.minFrames
  && /refused/.test(cat0.blockout.framesWhy || ""),
  JSON.stringify({ frames: cat0.frames, blockout: cat0.blockout?.framesBelow }));

ok("the two kinds are different FILES, and the kind is part of the name",
  /stem\(wantBlockout \? "blockout" : "previz"/.test(PREVIZ),
  "a deterministic name is only safe when it is a function of everything that "
  + "changes what the file IS — the set already is, and so is the kind");

/* THE SPEC CROSSES THE BOUNDARY AS A FILE. That subprocess-and-file handoff
 * IS the licence boundary (LICENSE-NOTE.md), and a spec on a command line
 * would be a JSON blob through two shells' quoting rules as well. */
ok("the blocking spec goes over as a file, beside the clip it staged",
  /args\.push\("--spec", specPath\)/.test(PREVIZ)
  && /SPEC_SUFFIX = "\.spec\.json"/.test(PREVIZ),
  "the input belongs on disk next to the output it produced");

/* ⚠ WHAT USED TO BE ASSERTED HERE, AND WHY IT IS NOT ANY MORE.
 *
 * Three claims lived at this point as regexes over previz.js's own characters:
 * that the spec survives a refused render, that a refusal leaves the previous
 * good render alone, and that a surviving clip keeps the spec that really made
 * it. All three are about what the code DOES, and a regex over a file cannot
 * see that — which is not a theory: the cleanup really did delete a
 * gate-passing 121-frame blockout, its track and its sidecar when one unknown
 * key in a staging spec was refused, and every one of those regexes went on
 * matching while it did. `/mtimeMs/.test(PREVIZ)` is true of a comment.
 *
 * They are proven on disk now, in "the stub blender" section below. This
 * pointer stays because the next reader deserves to know the claims moved
 * rather than went away. */

/* ⚠ ONE AUTHORITY FOR THE HASH. Two implementations of a canonical form are
 * two canonical forms, and the one that matters is held by the side that
 * actually built the set. This side quotes it. */
ok("the spec's hash is the TOOLKIT's, recorded rather than recomputed here",
  /specSha256: r\.spec_sha256/.test(PREVIZ)
  && !/createHash|sha256\(/.test(PREVIZ),
  "a second canonical form on this side would agree until the day it did not");

ok("the spec vocabulary is offered to a surface, and probed against the toolkit",
  Array.isArray(PROP_KINDS) && PROP_KINDS.length === 2 && SPEC_VERSION === 1
  && /propKindsWithoutGeometry/.test(PREVIZ)
  && /geometryWithoutPropKinds/.test(PREVIZ)
  && /supportsMissing/.test(PREVIZ),
  "a kind this side offers and the toolkit refuses is a form field that always "
  + "fails; a kind the toolkit builds and this side never offers is a capability "
  + "nobody can reach. SCENES already makes this bargain.");

ok("...and a toolkit too old to take a spec, a blockout or move keywords is named, not discovered mid-render",
  /\["spec", "blockout", "move_args"\]\.filter/.test(PREVIZ)
  /* AND EVERY CAPABILITY IN THAT LIST IS ONE THIS FILE REALLY SENDS. A
   * declaration that outruns the code is worse than none: it fails the probe
   * against a toolkit that would have worked perfectly. Read off the flags
   * rather than restated, so deleting a flag breaks this line. */
  && /args\.push\("--spec"/.test(PREVIZ)
  && /args\.push\("--blockout"\)/.test(PREVIZ)
  && /args\.push\("--move-arg"/.test(PREVIZ),
  "'unrecognized arguments: --spec' a minute into a Blender launch is the "
  + "wrong way to find out, and so is '--move-arg'");

/* ── THE VALUE'S TYPE IS THE WHOLE POINT ─────────────────────────────────
 *
 * The toolkit publishes its own coercion rule — "KEY=VALUE, value parsed as
 * JSON or kept as a string" — which means the characters `75` arrive as the
 * NUMBER 75 whether the caller meant a number or the string. JSON.stringify
 * on this side is the only mapping that survives that rule intact in both
 * directions, and it is the difference between `framing=full` and a framing
 * of the string "full" quietly becoming something else on the way. */
ok("a move keyword crosses the boundary as JSON, so its TYPE survives the trip",
  /moveArgPairs\.push\(\[k, JSON\.stringify\(v\)\]\)/.test(PREVIZ)
  && /Object\.fromEntries\(moveArgPairs\.map\(\(\[k, v\]\) => \[k, JSON\.parse\(v\)\]\)\)/.test(PREVIZ),
  "sending the raw characters and letting the far side coerce turns the STRING "
  + "\"75\" into the NUMBER 75 somewhere in the middle, in a value nobody would "
  + "think to check");
ok("...and they are recorded beside the move, because \"crane\" alone no longer says which crane",
  /moveArgs: kwargs,/.test(PREVIZ)
  && (PREVIZ.match(/moveArgs: kwargs/g) || []).length >= 5,
  "the sidecar, both kinds of clip, the project row and the response: a blockout "
  + "whose record says `crane` and nothing else cannot be told apart from the crane "
  + "that aims somewhere else entirely, and those are two different shots");

console.log("\n-- the wire --");

/**
 * NO TOOL MAY POST TWO `action` KEYS, and this check exists because one did.
 *
 * The route dispatches on `action`. A board shot's own sentence is ALSO called
 * `action`. Written as one object literal — `mv({ action: "previz_plan", ...,
 * action: a.action })` — the second key silently wins, so the tool posted a
 * body with no dispatch key at all and the server answered "Unknown action:".
 * Nothing static caught it; calling the tool for real did. This is that catch,
 * made static, over EVERY tool in the file rather than the two that had it.
 */
const MCP = readFileSync(path.join(HERE, "..", "mcp-mv.js"), "utf8");
const dupes = [];
for (const m of MCP.matchAll(/\bmv\(\{/g)) {
  let i = m.index + m[0].length - 1, depth = 0;
  for (; i < MCP.length; i++) {
    if (MCP[i] === "{") depth++;
    else if (MCP[i] === "}") { if (--depth === 0) break; }
  }
  const call = MCP.slice(m.index, i + 1);
  const n = (call.match(/(?:^|[\s,{])action:/g) || []).length;
  if (n !== 1) dupes.push(`${n} action keys in: ${call.replace(/\s+/g, " ").slice(0, 90)}…`);
}
ok(`every mv() body carries exactly one dispatch key (${[...MCP.matchAll(/\bmv\(\{/g)].length} calls)`,
  !dupes.length, dupes.join("\n          "));

ok("...and the shot's own action sentence travels under a name that cannot collide",
  /shotAction: a\.action/.test(MCP) && /action: b\.shotAction/.test(src("routes.js")),
  "the field is `action` on both sides of the boundary and the dispatch key owns that word");

console.log("\n-- the render floor --");

/* ⚠ THIS ASSERTION USED TO READ `/const FRAMES_MIN = 121;/.test(PREVIZ)` AND IT
 * WAS PASSING ON A COMMENT. That line was replaced by
 * `const FRAMES_MIN = CONTROL_SPEC.minFrames;` months ago, and the comment
 * explaining the change quotes the OLD line verbatim — "This line used to read
 * `const FRAMES_MIN = 121;`" — so the regex kept matching prose about code that
 * no longer existed. It would have gone on matching if the floor had been
 * retyped as 200. The gate must read the code, not the commentary about it, so
 * the floor is now asked for by BEHAVIOUR: a number below it comes back as the
 * floor, and the floor is the one the control contract holds. */
ok(`the frame floor is the toolkit's control spec (${CONTROL_SPEC.minFrames}), not a taste`,
  framesFor(1) === CONTROL_SPEC.minFrames && framesFor(CONTROL_SPEC.minFrames - 1) === CONTROL_SPEC.minFrames
  && BLOCKOUT_FRAMES_DEFAULT === CONTROL_SPEC.minFrames && FRAMES_DEFAULT === 144,
  "asking for 96 renders a clip and then throws it away as out of spec — "
  + "measured, and the reason the floor is on this side of the subprocess");

ok("...and the floor is IMPORTED from the contract, never typed here",
  /const FRAMES_MIN = CONTROL_SPEC\.minFrames;/.test(PREVIZ)
  && !/const FRAMES_MIN = \d+;/.test(PREVIZ.replace(/`const FRAMES_MIN = \d+;`/g, "")),
  "a second copy of 121 on this side of the boundary can drift from the gate "
  + "that enforces it without anything failing");

ok("...and a too-short PREVIZ request is rounded up rather than refused a minute later",
  /clamp\(frames, FRAMES_MIN/.test(PREVIZ));

/* ══ THE SET LIST IS THE TOOLKIT'S ═══════════════════════════════════════
 *
 * ⚠ THIS ASSERTION USED TO READ `SCENES.length === 7`, and it passed on the
 * day the Studio started refusing a set that renders. Seven was never a fact
 * about this app — it was a fact about a checkout on the other side of a
 * licence boundary, transcribed into five files here, and the number in the
 * test froze the transcription in place instead of catching it.
 *
 * So the shape is checked here (one live array, no literal, an await before
 * the guard) and the CONTENT is checked against the real toolkit at the bottom
 * of this file, both ways. */
ok("the set list is the live one from blender.js, not a literal in previz.js",
  SCENES === SETS && /export const SCENES = SETS;/.test(PREVIZ)
  && !/export const SCENES = \[/.test(PREVIZ),
  "a second array here is a second list to forget to update");

ok("...and a typo still costs nothing: the guard asks the toolkit first",
  /const known = await toolkitSets\(\);/.test(PREVIZ)
  && /No previz set called/.test(PREVIZ)
  && !/SCENES\.includes\(scene\)/.test(PREVIZ),
  "the guard is the thing that broke — it refused 'stage' out of a hard-coded seven");

ok("...and it does NOT refuse when the toolkit is here but would not answer",
  /!known\.failed/.test(PREVIZ),
  "a probe that timed out while the card was busy must not reject a set that exists");

/* ⚠ READ THE CODE, NOT THE COMMENTARY ABOUT IT. Every clause below names a
 * construct that has to be PRESENT, plus the one array literal that is allowed
 * to exist. The first draft of this check asserted the ABSENCE of the seven
 * names and failed on a comment in mcp-mv.js quoting the line it had deleted —
 * the same trap the frame-floor assertion above records falling into. */
const surfaces = {
  "previz.js": [PREVIZ, /export const SCENES = SETS;/],
  "blender.js": [src("blender.js"), /export const SETS = \[\.\.\.SETS_FALLBACK\];/],
  "mcp-mv.js": [readFileSync(path.join(HERE, "..", "mcp-mv.js"), "utf8"), /\bscene: sceneArg,/],
  "chat/tools.js": [readFileSync(path.join(HERE, "..", "chat", "tools.js"), "utf8"), /\bscene: sceneArg,/],
  "web/mv.js": [readFileSync(path.join(HERE, "..", "..", "web", "mv.js"), "utf8"), /o: \(\) => previzSets,/],
};
const notWired = Object.entries(surfaces).filter(([, [text, re]]) => !re.test(text)).map(([f]) => f);
ok(`the five surfaces that each held their own copy now read one source (${
     Object.keys(surfaces).length})`,
  !notWired.length, `still holding a list of their own: ${notWired.join(", ")}`);

/* And exactly ONE hand-typed set list is left in the app, in the one place a
 * machine with no Blender needs one. Counting them is what stops a sixth copy
 * being added quietly next time. */
const setLiterals = Object.entries(surfaces)
  .flatMap(([f, [text]]) => [...text.matchAll(/\[\s*"corridor",\s*"room",\s*"street"/g)].map(() => f));
ok(`exactly one hand-typed set list survives, and it is the fallback (${setLiterals.join(", ") || "none"})`,
  setLiterals.length === 1 && setLiterals[0] === "blender.js"
  && /export const SETS_FALLBACK = \[/.test(src("blender.js")),
  `set-name arrays found in: ${setLiterals.join(", ") || "none"} — the only one allowed is `
  + "SETS_FALLBACK in blender.js, which is what a machine with no Blender shows");

/* ══════════════════════════════════════════════════════════════════════════
 * THE STUB BLENDER — what really lands on disk, and what really leaves it
 *
 * Everything above this line reads previz.js. This section RUNS it, against a
 * Blender that is four lines of C# and does exactly what it is told: writes the
 * files named in STUB_FILES, prints a result line, and exits with the code in
 * STUB_EXIT. That is enough to reproduce the two failures this module was
 * measured making, neither of which a regex could see:
 *
 *   A REFUSED RENDER USED TO DELETE THE RENDER BEFORE IT. One unknown key in a
 *   staging spec — refused on the far side before Blender staged an object —
 *   removed a gate-passing 121-frame blockout, its track and its sidecar,
 *   after which the control route answered "recorded as this shot's blockout
 *   but is not on disk any more".
 *
 *   A PREVIZ LEFT THE TOOLKIT'S PROJECTION TABLE BEHIND. blocking.py writes a
 *   `<clip>.mp4.projection.json` whenever the set has figures in it — which
 *   corridor, room and street all do, spec or no spec — and only the blockout
 *   branch removed it. A 36,582-byte orphan sat in the assets folder, named by
 *   nobody and pointed at by nothing.
 *
 * WHY C# AND NOT A SCRIPT. blender.js spawns config.blender.exe directly, and
 * on Windows Node refuses to spawn a .cmd or .bat without a shell (EINVAL,
 * since the 2024 argument-injection fix), while node.exe itself rejects the
 * argument vector Blender is given ("bad option: -b"). A real PE is the only
 * thing that can stand in the exe's place, and csc.exe ships with the .NET
 * Framework every Windows machine already has. Same bargain as blockout_test.js
 * and ffmpeg: if it is not there, the section SKIPS LOUDLY with a count.
 * ════════════════════════════════════════════════════════════════════════ */
console.log("\n-- the stub blender: what really lands on disk --");

const STUB_ASSERTIONS = 19;
const STUB_CS = String.raw`
using System;
using System.IO;

class Stub {
  static int Main(string[] a) {
    // THE ARGUMENT VECTOR, WRITTEN OUT FIRST — before the files, before the
    // result line, and before any chance of exiting non-zero. What reaches
    // Blender is the only place a flag can be proven to have crossed the
    // process boundary, and a refusal has an argv worth reading too.
    string argvOut = Environment.GetEnvironmentVariable("STUB_ARGV");
    if (!string.IsNullOrEmpty(argvOut)) File.WriteAllLines(argvOut, a);
    string outp = null, track = null;
    for (int i = 0; i + 1 < a.Length; i++) {
      if (a[i] == "--out") outp = a[i + 1];
      if (a[i] == "--track") track = a[i + 1];
    }
    string files = Environment.GetEnvironmentVariable("STUB_FILES");
    foreach (string entry in (files ?? "").Split(';')) {
      string p = entry.Trim();
      if (p.Length == 0) continue;
      if (p.StartsWith("@out")) p = outp + p.Substring(4);
      else if (p.StartsWith("@track")) p = track + p.Substring(6);
      File.WriteAllText(p, p.EndsWith(".json")
        ? (Environment.GetEnvironmentVariable("STUB_JSON") ?? "{}")
        : "not an mp4, but a file with a finished-looking name");
    }
    string res = Environment.GetEnvironmentVariable("STUB_RESULT");
    if (!string.IsNullOrEmpty(res)) {
      Console.WriteLine("Blender 5.2.1 LTS (hash 0000000000) - a banner, on the same pipe");
      Console.WriteLine("PREVIZ_RESULT_JSON: " + res.Replace("@OUT@", (outp ?? "").Replace("\\", "\\\\")));
    }
    string msg = Environment.GetEnvironmentVariable("STUB_STDERR");
    if (!string.IsNullOrEmpty(msg)) Console.Error.WriteLine(msg);
    return int.Parse(Environment.GetEnvironmentVariable("STUB_EXIT") ?? "0");
  }
}
`;

let STUB = null, stubWhy = "";
try {
  const csc = ["C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
               "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe"].find((p) => existsSync(p));
  if (!csc) stubWhy = "no csc.exe under C:\\Windows\\Microsoft.NET — install the .NET Framework";
  else {
    const cs = path.join(OUT, "stub_blender.cs");
    const exe = path.join(OUT, "blender.exe");
    writeFileSync(cs, STUB_CS, "utf8");
    execFileSync(csc, ["-nologo", "-optimize+", `-out:${exe}`, cs], { stdio: "pipe" });
    STUB = existsSync(exe) ? exe : null;
    if (!STUB) stubWhy = "csc.exe ran but wrote no blender.exe";
  }
} catch (err) { stubWhy = `csc.exe failed: ${err.message.split(/\r?\n/)[0]}`; }

/* blenderStatus() stats BOTH paths, so the toolkit side needs a file to exist
 * as well. It is never executed and it is never read: the stub ignores every
 * argument it is handed, including `-P`. Written outside the toolkit's own
 * checkout on purpose — this repository puts no python into that tree. */
const STUB_CLI = path.join(OUT, "stub_previz_cli.py");
writeFileSync(STUB_CLI, "# placeholder. The stub blender never runs this file.\n", "utf8");

const store = await import("./store.js");
const { config } = await import("../config.js");
const realBlender = { ...config.blender };

const stubEnv = ({ files = "", result = "", json = "{}", exit = 0, stderr = "", argv = "" } = {}) => {
  process.env.STUB_ARGV = argv;
  process.env.STUB_FILES = files;
  process.env.STUB_RESULT = result;
  process.env.STUB_JSON = json;
  process.env.STUB_EXIT = String(exit);
  process.env.STUB_STDERR = stderr;
};
const VERIFIED = { width: CONTROL_SPEC.width, height: CONTROL_SPEC.height,
                   fps: CONTROL_SPEC.fps, frames: CONTROL_SPEC.minFrames };
/** Everything about a file that a refusal must not change. */
const snap = (p) => (existsSync(p)
  ? { mtimeMs: statSync(p).mtimeMs, text: readFileSync(p, "utf8") } : null);
const same = (a, b) => !!a && !!b && a.mtimeMs === b.mtimeMs && a.text === b.text;
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message); } };

const doc = await store.createProject("Previz Stub");
const SLUG = doc.slug;
const ASSETS = store.assetsDir(SLUG);

if (!STUB) {
  skipped += STUB_ASSERTIONS;
  console.log(`  SKIP  the stub-blender half — ${stubWhy}.\n`
    + `          ${STUB_ASSERTIONS} assertions were NOT made, and they are the ones that read the`
    + " disk\n          rather than previz.js's own characters.");
} else {
  config.blender.exe = STUB;
  config.blender.previz = STUB_CLI;

  /* ── a PREVIZ that succeeds: the orphan projection table ──────────────── */
  stubEnv({
    files: "@out;@track;@out.projection.json",
    json: JSON.stringify({ frames: [1, 2], figures: [{ id: "figure" }] }),
    result: JSON.stringify({ path: "@OUT@", verified: VERIFIED,
                             projection_path: "@OUT@.projection.json",
                             projection: { report: { figures: [{ id: "figure", fraction: 1 }] } } }),
  });
  const a = await previzShot(SLUG, { move: "push_in", scene: "corridor", subject: "Kaya" });
  const A_MP4 = path.join(ASSETS, a.previz?.file || "missing.mp4");
  ok("a previz render leaves the clip, its track and ONE sidecar on disk",
    !!a.previz && existsSync(A_MP4) && existsSync(path.join(ASSETS, a.previz.track))
    && existsSync(`${A_MP4}.previz.json`),
    `previz=${JSON.stringify(a.previz)}`);
  ok("...marked human-review, in the file system and not just in the document",
    existsSync(`${A_MP4}.previz.json`) && read(`${A_MP4}.previz.json`).use === "human-review");
  /* ⚠ ITEM 2, MEASURED. The toolkit writes this file for a previz too — the
   * corridor set has a figure in it — and the previz branch used to walk past
   * it. "ONE file describes this clip" is the invariant, and it is not "one
   * file describes a blockout". */
  ok("...and the toolkit's own .projection.json is NOT left beside it",
    !existsSync(`${A_MP4}.projection.json`),
    "36,582 bytes written by the other half of the licence boundary, named by "
    + "nobody and removed by nobody, is the third JSON beside a clip that is "
    + "supposed to be described by one");
  ok("...and it was DROPPED, not folded into the human-review sidecar",
    existsSync(`${A_MP4}.previz.json`)
    && read(`${A_MP4}.previz.json`).projection === undefined,
    "a per-frame table of neck and hip pixels is what a CONSISTENCY MEASUREMENT "
    + "reads — it is the blockout's payload, and putting it on the clip a "
    + "director watches makes the two artefacts look alike in the one place "
    + "this module spends forty lines keeping them apart");

  /* ── a BLOCKOUT that succeeds: the table is kept, in OUR file ─────────── */
  const TABLE = { frames: [1, 2, 3], figures: [{ id: "kaya", neck_px: [[640, 300]] }],
                  projection_check: { worst_px: 0.0004 } };
  const SPEC1 = { figures: [{ id: "kaya", at: [0, 2, 0], to: [0.4, 9, 0], height: 1.72 }] };
  stubEnv({
    files: "@out;@track;@out.projection.json", json: JSON.stringify(TABLE),
    result: JSON.stringify({ path: "@OUT@", verified: VERIFIED, spec_sha256: "24429524c0e5abcd",
                             projection_path: "@OUT@.projection.json",
                             projection: { report: { figures: [{ id: "kaya", fraction: 1 }] },
                                           projection_check: { worst_px: 0.0004 } } }),
  });
  const b = await previzShot(SLUG, { move: "push_in", scene: "corridor",
                                     blockout: true, spec: SPEC1 });
  const B_MP4 = path.join(ASSETS, b.blockout?.file || "missing.mp4");
  const B_TRACK = path.join(ASSETS, b.blockout?.track || "missing.track.json");
  const B_SIDE = `${B_MP4}.blockout.json`;
  const B_SPEC = path.join(ASSETS, b.blockout?.spec || "missing.spec.json");
  ok("a blockout render writes its OWN sidecar, under its own name and use",
    !!b.blockout && existsSync(B_SIDE) && read(B_SIDE).use === "vace-control"
    && B_MP4 !== A_MP4,
    `blockout=${JSON.stringify(b.blockout?.file)} previz=${JSON.stringify(a.previz?.file)}`);
  ok("...carrying the toolkit's whole table, read off disk rather than off stdout",
    existsSync(B_SIDE)
    && JSON.stringify(read(B_SIDE).projection) === JSON.stringify(TABLE),
    "the summary is in the response; the 121 pairs of numbers are in the file");
  ok("...and the toolkit's copy is gone from beside the blockout as well",
    !existsSync(`${B_MP4}.projection.json`));
  ok("...and the staging that made it is on disk next to it",
    existsSync(B_SPEC) && read(B_SPEC).set === "corridor",
    "the input belongs beside the output it produced");

  /* ── A REFUSAL THAT WRITES NOTHING must change nothing ────────────────── */
  const wasClip = snap(B_MP4), wasTrack = snap(B_TRACK);
  const wasSide = snap(B_SIDE), wasSpec = snap(B_SPEC);
  stubEnv({ files: "", exit: 2,
            stderr: "SpecError: figures[0] has an unknown key 'colour'" });
  const refused = await threw(() => previzShot(SLUG, {
    move: "push_in", scene: "corridor", blockout: true,
    spec: { figures: [{ id: "kaya", at: [0, 2, 0], colour: "red" }] } }));
  ok("a refused render is an error, with the far side's own sentence in it",
    !!refused && /colour/.test(refused), refused || "it did not throw");
  ok("...and the gate-passing render before it is UNTOUCHED — every byte, every mtime",
    same(wasClip, snap(B_MP4)) && same(wasTrack, snap(B_TRACK))
    && same(wasSide, snap(B_SIDE)),
    "this is the bug: the cleanup used to remove all four names unconditionally, "
    + "so one typo in a staging form deleted a blockout that had already passed "
    + "the gate. A regex over previz.js watched it happen and stayed green.");
  /* TEXT, not mtime, and that is the point rather than a looser check: the
   * refused staging really was written over this path before the render was
   * attempted, and the earlier bytes were then put BACK. A restored file is a
   * rewritten file, so its mtime has to have moved; what must not have moved is
   * a single character of what it says. */
  ok("...and the surviving clip keeps the spec that really made it",
    snap(B_SPEC)?.text === wasSpec?.text && read(B_SPEC).figures[0].height === 1.72
    && !JSON.stringify(read(B_SPEC)).includes("colour"),
    "the refused staging is written to that path before the render is attempted; "
    + "leaving it there would leave the surviving clip described by a spec that "
    + "never produced it");

  /* ── A REFUSAL THAT WRITES A TRAP must take its own trap away ─────────── */
  stubEnv({ files: "@out", exit: 2,
            stderr: "CLIP IS IN SPEC BUT EMPTY: 46/121 frames have contrast below 1.5" });
  const trapped = await threw(() => previzShot(SLUG, {
    move: "push_in", scene: "corridor", blockout: true, spec: SPEC1 }));
  ok("a refusal that had already written the .mp4 removes it: the error is the answer",
    !!trapped && !existsSync(B_MP4),
    "the toolkit writes the clip and THEN measures it, so a clip refused as "
    + "empty is sitting on disk under a name that reads like a finished render");
  ok("...but only that. The track and the sidecar it did not write are still there",
    same(wasTrack, snap(B_TRACK)) && same(wasSide, snap(B_SIDE)),
    "scoped to what THIS attempt wrote — absent beforehand, or rewritten since");


  /* ── THE MOVE'S OWN KEYWORDS, ON THE REAL ARGUMENT VECTOR ──────────────
   *
   * Everything static above reads previz.js's characters. These read what a
   * Blender was really handed, because the whole value of this parameter is
   * that it CROSSES A PROCESS BOUNDARY with its types intact — and the far
   * side's own rule ("parsed as JSON or kept as a string") will turn a bare
   * 75 into a number whether that was meant or not.
   *
   * WHY IT EXISTS AT ALL, measured on the four PRISM blockouts: with no
   * keywords, a crane held the idol's neck on screen in 42 of 121 frames and
   * a floor_rise in 33 (it climbed its home set's 19.2 m and left the stage
   * behind); with aim_at=neck and a climb sized to the truss, both hold 121
   * of 121. Nothing about the move NAME changed between those two renders.
   */
  const ARGV = path.join(OUT, "stub-argv.txt");
  const argvOf = () => readFileSync(ARGV, "utf8").split(/\r?\n/).filter(Boolean);
  stubEnv({ files: "@out;@track", argv: ARGV,
            result: JSON.stringify({ path: "@OUT@", verified: VERIFIED }) });
  const kw = await previzShot(SLUG, { move: "crane", scene: "corridor", blockout: true,
                                      moveArgs: { aim_at: "neck", rise: 6 } });
  const KW_ARGV = argvOf();
  ok("a move keyword reaches Blender as its own --move-arg, one flag per pair",
    KW_ARGV.filter((x) => x === "--move-arg").length === 2
    && KW_ARGV.includes(String.raw`aim_at="neck"`) && KW_ARGV.includes("rise=6"),
    KW_ARGV.join(" "));
  ok("...with the TYPES intact: a name crosses with its quotes, a number without",
    kw.blockout?.moveArgs?.aim_at === "neck" && kw.blockout?.moveArgs?.rise === 6
    && typeof kw.blockout.moveArgs.rise === "number",
    JSON.stringify(kw.blockout?.moveArgs));
  const KW_MP4 = path.join(ASSETS, kw.blockout?.file || "missing.mp4");
  ok("...and the sidecar records them beside the move, so the clip says which crane it is",
    existsSync(`${KW_MP4}.blockout.json`)
    && read(`${KW_MP4}.blockout.json`).moveArgs?.aim_at === "neck"
    && read(`${KW_MP4}.blockout.json`).moveArgs?.rise === 6,
    "a blockout whose record says 'crane' and nothing else cannot be told apart "
    + "from the crane that aims somewhere else entirely");
  const KW_DOC = await store.readProject(SLUG);
  const KW_ROW = (KW_DOC.previz || []).find((r) => r.kind === "blockout" && r.move === "crane");
  ok("...and so does the project row, which is what a later render reads back",
    !!KW_ROW && KW_ROW.moveArgs?.aim_at === "neck" && KW_ROW.moveArgs?.rise === 6,
    JSON.stringify(KW_ROW?.moveArgs));

  /* THE DEFAULT PATH IS UNTOUCHED, and that is a claim worth a measurement:
   * every previz and blockout rendered before this parameter existed passed no
   * keywords, and must still pass none. An empty object is not "no keywords"
   * either — it is what a page sends when a field was cleared. */
  stubEnv({ files: "@out;@track", argv: ARGV,
            result: JSON.stringify({ path: "@OUT@", verified: VERIFIED }) });
  await previzShot(SLUG, { move: "orbit", scene: "corridor" });
  ok("a shot with no keywords sends NO --move-arg at all, so the old path is the old path",
    !argvOf().includes("--move-arg"),
    argvOf().join(" "));
  stubEnv({ files: "@out;@track", argv: ARGV,
            result: JSON.stringify({ path: "@OUT@", verified: VERIFIED }) });
  const empty = await previzShot(SLUG, { move: "orbit", scene: "corridor", moveArgs: {} });
  ok("...and an EMPTY object is the same shot, not a different one",
    !argvOf().includes("--move-arg") && JSON.stringify(empty.moveArgs) === "{}",
    argvOf().join(" "));

  Object.assign(config.blender, realBlender);
}

/* ══════════════════════════════════════════════════════════════════════════
 * THROUGH THE REAL ROUTE — the refusal a caller actually meets
 *
 * framesFor is unit-tested above, but the claim being made is about the DOOR:
 * "a shorter blockout is refused BEFORE the render". At the route it was not.
 * MEASURED on a scratch instance: previz_shot with `blockout: true, frames: 96`
 * answered 200, with a real 121-frame render on it and `frames: 121` in the
 * body — the number 96 appeared nowhere in the response. So this posts the same
 * body through createMvRoutes, with only `json` and `readBody` injected, and
 * asks for the 400.
 *
 * "NO BLENDER WAS LAUNCHED" is proven twice over: the exe is a stub that would
 * leave a marker file if it ever ran, and no clip appears in the assets folder.
 * ════════════════════════════════════════════════════════════════════════ */
console.log("\n-- through the real route --");

const LAUNCHED = path.join(OUT, "blender-was-launched");
config.blender.exe = STUB || path.join(OUT, "no-blender-here.exe");
config.blender.previz = STUB_CLI;
stubEnv({ files: LAUNCHED, result: JSON.stringify({ path: "x", verified: VERIFIED }) });

const { createMvRoutes } = await import("./routes.js");
const mv = createMvRoutes({
  json: (res, code, body) => { res.code = code; res.body = body; },
  readBody: async (req) => req.body,
  art: null, library: { meta: new Map(), remember: () => {} },
  beatsFor: async () => null,
  LRC_DIR: OUT, CLIP_DIR: OUT, IMAGE_DIR: OUT, COVER_DIR: OUT,
  outputDir: () => OUT, clipSeconds: () => null, keepAwake: () => {},
});
const post = async (body) => {
  const res = { code: 0, body: null };
  await mv.handle("/api/mv", { method: "POST", headers: {}, body }, res,
                  new URL("http://127.0.0.1/api/mv"));
  return res;
};

const short = await post({ action: "previz_shot", slug: SLUG, move: "orbit",
                           scene: "corridor", blockout: true, frames: 96 });
ok("a 96-frame BLOCKOUT is refused at the door, 400, with the sentence",
  short.code === 400 && /96/.test(short.body?.error || "")
  && new RegExp(String(CONTROL_SPEC.minFrames)).test(short.body?.error || "")
  && /clamped to its last frame/.test(short.body?.error || ""),
  `${short.code} ${JSON.stringify(short.body)}`);
ok("...and nothing was rendered to find that out",
  !existsSync(LAUNCHED)
  && !existsSync(path.join(ASSETS, "blockout_free_corridor_orbit.mp4")),
  "the point of refusing at the door is that the minute of render is not spent; "
  + "a 200 with a clip on it was the measured behaviour before this");

/* ── AND THE SAME DOOR FOR THE MOVE'S KEYWORDS ────────────────────────────
 *
 * The parameter is new, so the ways of getting it wrong are new too, and every
 * one of them is answerable without launching anything: a value that is not an
 * object at all, a key no Python function could ever accept, and keywords aimed
 * at a two-beat composite — which is a SHOT LIST on the far side, built out of
 * two moves, so there is no single camera for a keyword to argue with.
 *
 * The composite case is posted with `render: false` on purpose: the free call
 * has to give the same verdict the paid one would, or an agent checks its shot
 * for nothing and is refused after the spend. */
const kwBad = await post({ action: "previz_shot", slug: SLUG, move: "orbit",
                           scene: "corridor", moveArgs: "aim_at=neck" });
ok("a `moveArgs` that is not an object is refused at the door, 400, with the shape",
  kwBad.code === 400 && /moveArgs/.test(kwBad.body?.error || "")
  && /--move-arg KEY=VALUE/.test(kwBad.body?.error || ""),
  `${kwBad.code} ${JSON.stringify(kwBad.body)}`);

const kwKey = await post({ action: "previz_shot", slug: SLUG, move: "orbit",
                           scene: "corridor", moveArgs: { "not an identifier": 75 } });
ok("...and a key no move could ever accept is NAMED rather than sent",
  kwKey.code === 400 && /not an identifier/.test(kwKey.body?.error || ""),
  `${kwKey.code} ${JSON.stringify(kwKey.body)}`);

const kwTake = await post({ action: "previz_shot", slug: SLUG, move: "crane_plan",
                            scene: "corridor", render: false, moveArgs: { rise: 6 } });
ok("...and a two-beat composite refuses them by name, on the FREE call as well as the paid one",
  kwTake.code === 400 && /composite/.test(kwTake.body?.error || "")
  && /rise/.test(kwTake.body?.error || ""),
  `${kwTake.code} ${JSON.stringify(kwTake.body)}`);

ok("...and NOTHING was launched to learn any of the three",
  !existsSync(LAUNCHED),
  "every one of these is decided from the arguments alone, which is the whole "
  + "reason they are decided here and not by a traceback out of a render");

if (!STUB) {
  skipped += 1;
  console.log("  SKIP  the previz half of the same request — it needs the stub blender.\n"
    + "          1 assertion was NOT made.");
} else {
  config.blender.exe = STUB;
  stubEnv({ files: "@out;@track", result: JSON.stringify({ path: "x", verified: VERIFIED }) });
  const plain = await post({ action: "previz_shot", slug: SLUG, move: "orbit",
                             scene: "corridor", frames: 96 });
  ok("...while the SAME 96 frames as a plain previz still renders, rounded up",
    plain.code === 200 && plain.body?.previz?.frames === CONTROL_SPEC.minFrames,
    `${plain.code} ${JSON.stringify(plain.body?.previz)} — the two kinds answer `
    + "differently on purpose: a previz is a clip a person watches and the floor "
    + "is only there to stop a file that would be refused downstream");
}

/* The real Blender again for the last section, and the stub's env with it. */
Object.assign(config.blender, realBlender);
for (const k of ["STUB_FILES", "STUB_RESULT", "STUB_JSON", "STUB_EXIT", "STUB_STDERR", "STUB_ARGV"]) {
  delete process.env[k];
}

console.log("\n-- Blender, when it is here --");

const st = await blenderStatus();
if (!st.installed) {
  /* Not a pass and not a failure. A machine without Blender is the normal case
   * and the words half is unaffected; saying which file is missing is more
   * use than a green tick that proved nothing. */
  console.log(`  skip  Blender is not installed — ${st.why.join(" ")}`);
  console.log("        (the vocabulary cross-check is the only thing that needs it)");
} else {
  const t0 = Date.now();
  const cat = await previzCatalogue({ probe: true });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  ok(`the toolkit answers, and agrees with this vocabulary (${cat.blenderVersion}, ${secs}s)`,
    cat.agrees === true,
    `words the toolkit cannot build: ${cat.drift?.wordsWithoutGeometry.join(", ") || "none"}\n`
    + `          moves nothing here can reach: ${cat.drift?.geometryWithoutWords.join(", ") || "none"}\n`
    + `          sets named here and gone over there: ${cat.drift?.setsWithoutGeometry.join(", ") || "none"}\n`
    + `          sets built over there and named nowhere here: ${cat.drift?.geometryWithoutSets.join(", ") || "none"}\n`
    + "          The toolkit is a separate repository across a licence boundary. "
    + "This is the only check that sees a rename over there.");

  /* ── THE SET LIST, DERIVED AND CHECKED BOTH WAYS ────────────────────────
   *
   * The one-directional version of this check (SCENES minus the toolkit's
   * list) was BLIND to the direction that actually happened: a set added over
   * there. It could only ever report a deletion. Both directions are asserted
   * now, and the failure names the one file that still holds a typed list. */
  ok(`the sets came from the toolkit itself, not from this app (${cat.sets?.source}, `
     + `${cat.sets?.names?.length} sets, stamp ${String(cat.sets?.stamp).slice(-14)})`,
    (cat.sets?.source === "toolkit" || cat.sets?.source === "cache") && cat.sets?.stale === false,
    `source=${cat.sets?.source} stale=${cat.sets?.stale} why=${(cat.sets?.why || []).join(" ")}`);

  ok("...and the toolkit's list is exactly the one this app falls back to, both ways",
    !cat.drift.setsWithoutGeometry.length && !cat.drift.geometryWithoutSets.length,
    `named in SETS_FALLBACK and NOT in the toolkit: ${cat.drift.setsWithoutGeometry.join(", ") || "none"}\n`
    + `          built by the toolkit and NOT in SETS_FALLBACK: ${cat.drift.geometryWithoutSets.join(", ") || "none"}\n`
    + "          SETS_FALLBACK in server/mv/blender.js is the only hand-typed set list left in "
    + "the app — it is what a machine with no Blender shows. Bring it level with the toolkit.");

  /* ⚠ AND THE LIST HAS TO BE REACHABLE, not merely correct. The bug was never
   * that the app did not KNOW about 'stage'; it was that previzShot refused
   * it. So every set the toolkit reports is put through the real guard. */
  const refused = [];
  for (const set of cat.sets.names) {
    try { await previzShot(SLUG, { move: "push_in", scene: set, render: false }); }
    catch (err) { refused.push(`${set}: ${err.message}`); }
  }
  ok(`every set the toolkit builds is one previz_shot will accept (${cat.sets.names.length})`,
    !refused.length, refused.join("\n          "));

  ok(`...and each one has a mesh inventory or says it has none (${
      Object.entries(cat.sets.meshesFrom || {}).map(([k, v]) => `${k}:${v}`).join(" ")})`,
    cat.sets.names.every((s) => cat.sets.meshesFrom?.[s]),
    "meshesFrom must answer for every set — 'transcribed' (this app's copy), "
    + "'toolkit:probe' (asked for and cached) or 'unknown' (not asked yet)");

  ok("...and BUILTINS is keyed by the derived sets, never by a stale seven",
    Object.keys(BUILTINS).every((k) => cat.sets.names.includes(k)),
    `in BUILTINS and not a set any more: ${
      Object.keys(BUILTINS).filter((k) => !cat.sets.names.includes(k)).join(", ")}`);
}

rmSync(OUT, { recursive: true, force: true });

console.log(`\n  ${pass} passed, ${failures.length} failed`
  + (skipped ? `, ${skipped} skipped` : "") + "\n");
for (const f of failures) console.log(`  FAILED: ${f}`);
process.exit(failures.length ? 1 : 0);
