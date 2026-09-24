/**
 * ONE SHOT — the resolution, the evidence, and the edit.
 *
 * WHAT THIS IS ACTUALLY GUARDING. `resolveShot` is not a reporting helper; it
 * is the renderer's own reasoning, lifted out so a human and an agent can see
 * it before the GPU is spent. That makes two kinds of failure possible and both
 * are silent:
 *
 *   1. THE RESOLVER AND THE RENDERER DISAGREE. generate.js stages exactly the
 *      list this returns, in order, and clipPrompt numbers the <Picture N> tags
 *      off the same list. If the order or the membership ever drifts, the
 *      prompt says "<Picture 2> is Ivy" over a picture of a bus, and nothing
 *      anywhere reports it. So the checks below are about ORDER and MEMBERSHIP
 *      first, and the wording of the prose a distant second.
 *   2. THE INSPECTOR LIES BY OMISSION. A declared name with no rendered sheet
 *      reaches the render as nothing. That is the failure DIRECTING.md keeps
 *      describing, and the whole feature exists to say it out loud — so a
 *      resolver that quietly skipped such a name would pass every render test
 *      and defeat the point.
 *
 * The fixtures are hand-built documents rather than a real project: the corpus
 * changes under this file, and a test that reads it would fail for reasons that
 * are not bugs.
 *
 * Runs standalone (`node server/mv/shot_test.js`) and in the pre-commit hook.
 * Reads server/mv/ and writes nothing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveShot, shotRecord, applyShotEdit, clipPrompt, REF_CAP,
         markBoardRefsChanged, refreshBoardStale } from "./shot.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(path.join(HERE, f), "utf8");

/* ── fixtures ─────────────────────────────────────────────────────────────
 * Kaya has a sheet. Marek is declared and has none — he is the silent drop.
 * The bus is a PROP with a sheet, which is the case that used to re-route the
 * whole render onto an engine ten times the price. */
const baseDoc = () => ({
  styleBible: "Grainy 16mm night",
  brief: {},
  characters: [{ id: "c1", name: "Kaya", imageFile: "kaya.png", takes: [{ file: "kaya.png", at: 100 }] },
               { id: "c2", name: "Marek", imageFile: null, takes: [] }],
  backgrounds: [{ id: "g1", name: "Underpass", imageFile: "under.png", takes: [{ file: "under.png", at: 100 }] }],
  props: [{ id: "p1", name: "NightBus", imageFile: "bus.png", takes: [{ file: "bus.png", at: 100 }] }],
  segments: [{ id: "s1_0", index: 0, startSec: 0, endSec: 4, durationSec: 4,
               kind: "lyrical", mode: "generate", thesisLine: "the last bus goes" }],
  boards: [{ id: "bd1", segmentId: "s1_0", segmentIndex: 0, grade: "cold cyan",
             shots: [{ shotType: "wide", angle: "low", action: "she runs" }],
             characterRefs: ["Kaya", "Marek"], backgroundRefs: ["Underpass"], propRefs: ["NightBus"],
             refProminence: { Kaya: 0.9, Marek: 0.8, Underpass: 0.4, NightBus: 0.6 },
             imageFile: "board1.png", takes: [] }],
  clips: [],
  runs: [],
});

/* ── the resolution ─────────────────────────────────────────────────────── */

const d = baseDoc();
const r = resolveShot(d, "s1_0");

ok("a shot resolves by segment id and by scene index alike",
  r.segmentId === "s1_0" && resolveShot(d, 0).segmentId === "s1_0" && resolveShot(d, "0").segmentId === "s1_0");

/* ⚠ ORDER IS THE CONTRACT. The prompt numbers its <Picture N> tags off this
 * array, so a reordering here silently mislabels every reference in the
 * render — the exact defect that makes a model draw the wrong person. */
ok("references resolve in PROMINENCE order, which is the order they are staged",
  r.refs.map((x) => x.name).join(",") === "Kaya,NightBus,Underpass",
  r.refs.map((x) => `${x.name}@${x.prominence}`).join(" "));
ok("...and each one carries the file it actually resolved to",
  r.refs.every((x) => x.file) && r.refs[0].file === "kaya.png");
ok("...with its kind, so a prop is distinguishable from a face",
  r.refs.map((x) => x.kind).join(",") === "character,prop,background");

/* THE HEADLINE. A declared name with no sheet must be REPORTED, not skipped. */
ok("a declared name with no rendered sheet is reported as reaching the render as NOTHING",
  r.refsMissing.length === 1 && r.refsMissing[0].name === "Marek",
  JSON.stringify(r.refsMissing));
ok("...and it does not silently occupy a reference slot",
  r.refs.every((x) => x.name !== "Marek"));
ok("...and the reason names the fix rather than just the fault",
  /no sheet has been rendered/.test(r.refsMissing[0].why), r.refsMissing[0].why);

/* An undeclared name is a different fault with a different fix, and the two
 * were indistinguishable before — both were simply absent from the render. */
{
  const d2 = baseDoc();
  d2.boards[0].characterRefs.push("Ghost");
  const r2 = resolveShot(d2, "s1_0");
  ok("a name nothing declares is reported differently from one that is merely unrendered",
    r2.refsMissing.some((m) => m.name === "Ghost" && /not declared/.test(m.why)),
    JSON.stringify(r2.refsMissing.map((m) => m.why)));
}

/* ── the engine, which is where the money is ─────────────────────────────── */

ok("a scene with cast routes to H3 under the default hybrid mode", r.engine === "h3" && r.useRefs);
{
  /* ⚠ THE FORTY-MINUTE BOAT. A prop-only scene has references and must still
   * NOT choose H3 — that regression cost a 13.7 s scene past forty minutes,
   * and it is invisible until after the render. */
  const d2 = baseDoc();
  d2.boards[0].characterRefs = [];
  const r2 = resolveShot(d2, "s1_0");
  ok("a PROP-ONLY scene still carries its prop but does NOT buy the expensive engine",
    r2.refs.some((x) => x.kind === "prop") && r2.castRefs === 0 && r2.engine === "ltx",
    `engine ${r2.engine}, castRefs ${r2.castRefs}, refs ${r2.refs.map((x) => x.name).join(",")}`);
  const d3 = baseDoc(); d3.brief.videoEngine = "ltx";
  ok("...and an explicit ltx is honoured rather than overridden by the presence of a sheet",
    resolveShot(d3, "s1_0").engine === "ltx" && resolveShot(d3, "s1_0").useRefs === false);
  const d4 = baseDoc(); d4.brief.videoEngine = "h3"; d4.boards[0].characterRefs = [];
  const r4 = resolveShot(d4, "s1_0");
  ok("...and an explicit h3 is honoured on a scene with no cast at all", r4.engine === "h3");
  /* ⚠ THE HALF THIS PANEL USED TO LEAVE UNCHECKED, AND IT WAS THE BROKEN HALF.
   * The line above asserted the ENGINE and stopped. `useRefs` was gated on the
   * ROUTER's question — "is there cast?" — so on an explicit-h3 project a board
   * with no person on it ran on H3, paid H3's price, and had its pictures
   * withheld. Eight of ABOVE THE WATER's 34 shots and nine of the coda's twelve
   * went out that way. The engine assertion passed the whole time. */
  ok("...AND ITS PICTURES ARE ACTUALLY SENT, because H3 is the engine that will run",
    r4.useRefs === true && r4.refsSent === true && r4.refs.length > 0,
    `useRefs ${r4.useRefs}, refsSent ${r4.refsSent}, refs ${r4.refs.length}`);
  ok("...so the flux storyboard is NOT pinned as frame 0 on a room with nobody in it",
    r4.opensOn === null && r4.guideMode === "none",
    `opensOn ${r4.opensOn}, guideMode ${r4.guideMode}`);
  const d4b = baseDoc(); d4b.brief.videoEngine = "h3";
  d4b.boards[0].characterRefs = []; d4b.boards[0].propRefs = []; d4b.boards[0].backgroundRefs = [];
  ok("...and a board that names nothing at all sends nothing, h3 or not",
    resolveShot(d4b, "s1_0").useRefs === false, "no pictures is not the same as pictures withheld");
  const d5 = baseDoc(); d5.brief.castRefs = false;
  ok("...and castRefs:false drops the references instead of collecting and discarding them",
    resolveShot(d5, "s1_0").useRefs === false && resolveShot(d5, "s1_0").engine === "ltx");
  const d5b = baseDoc(); d5b.brief.castRefs = false; d5b.brief.videoEngine = "h3";
  ok("...on an explicit h3 project too, which is the only thing that switch ever claimed",
    resolveShot(d5b, "s1_0").useRefs === false);
}

/* ── RESOLVED IS NOT SENT ────────────────────────────────────────────────
 * The defect this panel found on its first run, pinned from both sides so
 * nobody re-hides it. generateClip attaches the pictures only when useRefs, and
 * useRefs is false on every ltx project, on every project with cast references
 * switched off, and on every scene with no cast — which was two thirds of this
 * library sending "<Picture 1> is Vire." over no attachment at all.
 *
 * BOTH SPELLINGS ARE PINNED, because both are load-bearing and each is a
 * regression waiting to happen. With pictures, the numbered legend must survive:
 * it is the mechanism that stops every scene inventing a different performer.
 * Without them the NAMES must survive and the picture NUMBERS must not — a tag
 * pointing at nothing is worse than silence. */
{
  const d2 = baseDoc(); d2.brief.videoEngine = "ltx";
  const r2 = resolveShot(d2, "s1_0");
  ok("references that resolve but are NOT handed over are marked as not sent",
    r2.refs.length > 0 && r2.refsSent === false);
  ok("...and warned about by name",
    r2.warnings.some((w) => w.kind === "named-but-not-sent" && w.names.includes("Kaya")),
    JSON.stringify(r2.warnings));
  ok("...and the prompt stops promising pictures that will not arrive",
    !/<Picture \d>/.test(r2.prompt), r2.prompt.slice(0, 200));
  /* ⚠ THE NAMES STILL GO. Dropping the legend outright would re-open the
   * failure it was written for — every scene inventing a new performer because
   * the prompt never said the words. */
  ok("...while still NAMING every reference it resolved, in plain words",
    r2.refs.every((x) => r2.prompt.includes(x.name)), r2.prompt.slice(0, 240));
  ok("...and never names one it did not resolve", !r2.prompt.includes("Marek"));

  const rSent = resolveShot(baseDoc(), "s1_0");
  ok("...while a render that really does carry them warns about nothing",
    rSent.refsSent === true && rSent.warnings.length === 0);
  ok("...and keeps the numbered legend, which is what conditions an H3 render",
    rSent.prompt.includes("<Picture 1> is Kaya"), rSent.prompt.slice(0, 200));

  /* clipPrompt is the unit under both spellings, so it is asked directly too:
   * a resolver change could otherwise mask a builder regression. */
  const seg = d2.segments[0], board = d2.boards[0];
  const withPix = clipPrompt(d2, seg, board, ["Kaya", "NightBus"], -1, true);
  const noPix = clipPrompt(d2, seg, board, ["Kaya", "NightBus"], -1, false);
  ok("clipPrompt numbers its tags only when the pictures attach",
    withPix.includes("<Picture 2> is NightBus") && !/<Picture/.test(noPix)
      && noPix.includes("Kaya and NightBus"),
    noPix.slice(0, 200));
}

/* ── the cap, which used to drop names in silence ────────────────────────── */
{
  const d2 = baseDoc();
  for (let i = 0; i < 12; i++) {
    d2.characters.push({ id: `x${i}`, name: `Extra${i}`, imageFile: `x${i}.png`, takes: [] });
    d2.boards[0].characterRefs.push(`Extra${i}`);
    d2.boards[0].refProminence[`Extra${i}`] = 0.5;
  }
  const r2 = resolveShot(d2, "s1_0");
  ok(`the ${REF_CAP}-picture cap is enforced`, r2.refs.length === REF_CAP);
  ok("...and what it threw away is REPORTED, not silently absent",
    r2.dropped.length > 0 && r2.refs.length + r2.dropped.length + r2.refsMissing.length
      === [...d2.boards[0].characterRefs, ...d2.boards[0].backgroundRefs, ...d2.boards[0].propRefs].length,
    `${r2.refs.length} kept, ${r2.dropped.length} dropped, ${r2.refsMissing.length} missing`);
}

/* ── the prompt, which is the payload ────────────────────────────────────── */

ok("the prompt NAMES every reference it carries, in the order it carries them",
  r.prompt.startsWith("Grainy 16mm night. <Picture 1> is Kaya. <Picture 2> is NightBus. <Picture 3> is Underpass."),
  r.prompt.slice(0, 140));
ok("...and never names one it is not sending", !r.prompt.includes("Marek"));
ok("...and carries the board's shot list and grade", /wide, low: she runs/.test(r.prompt) && /cold cyan/.test(r.prompt));
ok("the resolver's prompt IS clipPrompt's, not a second rendering of it",
  r.prompt === clipPrompt(d, d.segments[0], d.boards[0], r.refNames, r.boardRefIndex));

/* ── the edit ─────────────────────────────────────────────────────────────
 * The precedence has three levels and the shot must say which one won, or a
 * scene that quietly stopped following its board looks like one that follows
 * it. */
{
  const d2 = baseDoc();
  applyShotEdit(d2, "s1_0", { prompt: "  a hand written shot  " });
  const r2 = resolveShot(d2, "s1_0");
  ok("a saved prompt replaces the built one and SAYS so",
    r2.prompt === "a hand written shot" && r2.promptSource === "edited");
  ok("...and the built one is still there to go back to",
    r2.computedPrompt.includes("<Picture 1> is Kaya"));
  const r3 = resolveShot(d2, "s1_0", { prompt: "just for this render" });
  ok("...and a one-render argument beats the saved one without disturbing it",
    r3.prompt === "just for this render" && r3.promptSource === "argument"
      && d2.clips[0].promptOverride === "a hand written shot");
  applyShotEdit(d2, "s1_0", { prompt: "" });
  ok("...and the empty string reverts to the builder",
    resolveShot(d2, "s1_0").promptSource === "computed" && !("promptOverride" in d2.clips[0]));
}

/* ⚠ THE MERGE. set_board REPLACES a board; this must not, or editing the refs
 * from a panel that shows no shot list would erase the shot list. */
{
  const d2 = baseDoc();
  applyShotEdit(d2, "s1_0", { refs: ["NightBus"] });
  const b = d2.boards[0];
  ok("editing references MERGES — the shot list, grade and rendered board survive",
    b.shots.length === 1 && b.grade === "cold cyan" && b.imageFile === "board1.png",
    JSON.stringify({ shots: b.shots.length, grade: b.grade, img: b.imageFile }));
  ok("...and names are sorted onto the right list by what the bible declares them as",
    b.propRefs.join() === "NightBus" && b.characterRefs.length === 0 && b.backgroundRefs.length === 0);
  let threw = null;
  try { applyShotEdit(d2, "s1_0", { refs: ["NotAThing"] }); } catch (e) { threw = e.message; }
  ok("...and an undeclared name is REFUSED, not accepted and dropped later",
    threw && /not a declared/.test(threw), String(threw));
  ok("...so the refusal did not half-apply", d2.boards[0].propRefs.join() === "NightBus");
}
{
  const d2 = baseDoc();
  let threw = null;
  try { applyShotEdit(d2, "s1_0", {}); } catch (e) { threw = e.message; }
  ok("an edit that changes nothing is an error rather than a silent no-op", !!threw);
}

/* ── the evidence, and the honesty about not having it ───────────────────── */
{
  const d2 = baseDoc();
  d2.clips.push({ id: "c_s1_0", segmentId: "s1_0", clipIndex: 0, clipFile: "old.mp4", status: "done",
                  prompt: "WHATEVER THE ROW SAYS NOW",
                  takes: [{ clip: "old.mp4", seed: 7, at: 100, engine: "h3" }] });
  const rec = shotRecord(d2, "s1_0");
  /* ⚠ A take with no recorded prompt must NOT borrow the row's current one.
   * The row's prompt is overwritten by every render, so captioning an old take
   * with it labels that take with text that made a different video — which
   * looks like an answer and is worse than a blank. */
  ok("a take rendered before per-take evidence admits it has none",
    rec.takes[0].evidence === false && rec.takes[0].prompt === null);
  ok("...and drift refuses to guess rather than inventing a comparison",
    rec.drift.unknown === true && rec.drift.any === false, JSON.stringify(rec.drift));

  d2.clips[0].takes.push({ clip: "new.mp4", seed: 9, at: 200, engine: "h3",
    prompt: resolveShot(d2, "s1_0").prompt, promptSource: "computed",
    refs: resolveShot(d2, "s1_0").refs.map((x) => ({ name: x.name, kind: x.kind, file: x.file })),
    refsMissing: [] });
  d2.clips[0].clipFile = "new.mp4";
  ok("a take WITH evidence matches the shot exactly and reports no drift",
    shotRecord(d2, "s1_0").drift.any === false && shotRecord(d2, "s1_0").current.evidence === true,
    JSON.stringify(shotRecord(d2, "s1_0").drift));

  /* Now move the world under it, one axis at a time. */
  const dP = JSON.parse(JSON.stringify(d2));
  applyShotEdit(dP, "s1_0", { prompt: "different words" });
  ok("editing the prompt makes the playing take visibly out of date",
    shotRecord(dP, "s1_0").drift.promptChanged === true);

  const dR = JSON.parse(JSON.stringify(d2));
  applyShotEdit(dR, "s1_0", { refs: ["Kaya"] });
  const drR = shotRecord(dR, "s1_0").drift;
  ok("dropping a reference is named as a drop", drR.refsRemoved.includes("NightBus") && drR.any);

  /* ⚠ THE ONE A NAME-ONLY COMPARISON MISSES. The cast list is unchanged; the
   * FILE behind a name moved because somebody picked a different take. That is
   * how a face silently changes between two clips that look identical on the
   * board. */
  const dF = JSON.parse(JSON.stringify(d2));
  dF.characters[0].imageFile = "kaya_take2.png";
  const drF = shotRecord(dF, "s1_0").drift;
  ok("a re-picked SHEET is caught even though the reference names are unchanged",
    drF.refsRepointed.length === 1 && drF.refsRepointed[0].name === "Kaya"
      && drF.refsRepointed[0].was === "kaya.png",
    JSON.stringify(drF));
}

/* ── a skipped scene reads, it does not throw ────────────────────────────── */
{
  const d2 = baseDoc();
  d2.segments[0].mode = "skip";
  const rec = shotRecord(d2, "s1_0");
  ok("a scene set to skip can still be LOOKED at, and says why it will not render",
    rec.blocked && /skip/.test(rec.blocked), String(rec.blocked));
}

/* ── THE FATAL ONE: ATTACHING A REFERENCE MUST MAKE THE BOARD STALE ───────
 *
 * The prover's exact sequence, run against the document instead of the GPU:
 * declare a prop, render its sheet, attach it to two boards, and ask what a
 * re-render would open on. On ltx — 11 of the 15 projects in this library — no
 * picture is handed to the video model at all, so the board image pinned as
 * frame 0 is the ONLY carrier of a prop into a clip. set_board has always
 * marked the board stale on a reference change; set_shot, which is how a prop
 * actually gets attached, marked only the clip, and scene 7 duly re-rendered
 * onto board_11bd1cfe55a7.png — the picture drawn before the prop existed.
 * The map went green and the render was shown nothing. */
{
  const d2 = baseDoc();
  d2.brief.videoEngine = "ltx";
  /* a second scene and board, because the failure is about a prop attached to
   * SEVERAL boards and only one of them being looked at */
  d2.segments.push({ id: "s1_1", index: 1, startSec: 4, endSec: 8, durationSec: 4,
                     kind: "lyrical", mode: "generate", thesisLine: "and it does not come back" });
  d2.boards.push({ id: "bd2", segmentId: "s1_1", segmentIndex: 1, grade: null,
                   shots: [{ shotType: "medium", action: "she waits" }],
                   characterRefs: ["Kaya"], backgroundRefs: [], propRefs: [],
                   refProminence: { Kaya: 0.9 }, imageFile: "board2.png", takes: [] });
  /* both scenes already have a rendered clip, opened on the board of the day */
  for (const [segId, file, board] of [["s1_0", "clip1.mp4", "board1.png"], ["s1_1", "clip2.mp4", "board2.png"]]) {
    d2.clips.push({ id: `c_${segId}`, segmentId: segId, clipFile: file, status: "done",
                    takes: [{ clip: file, at: 1, engine: "ltx", openedOn: board, prompt: "p",
                              promptSource: "computed", refs: [], refsSent: false, refsMissing: [] }] });
  }
  /* the prop is declared and its sheet is rendered — NightBus already is in the
   * fixture, so this is the attach step and nothing else */
  const before = shotRecord(d2, "s1_1");
  ok("before the attach, the board reads as current and the clip as done",
    before.staleReasons.length === 0 && d2.boards[1].staleRefs !== true,
    JSON.stringify(before.staleReasons));

  applyShotEdit(d2, "s1_0", { refs: ["Kaya", "NightBus"] });
  applyShotEdit(d2, "s1_1", { refs: ["Kaya", "NightBus"] });

  ok("attaching a reference marks the BOARD stale, not just the clip",
    d2.boards[0].staleRefs === true && d2.boards[1].staleRefs === true,
    JSON.stringify(d2.boards.map((b) => b.staleRefs)));
  const after = shotRecord(d2, "s1_1");
  /* Two reasons, two repairs: "board" says re-render the clip, "board-refs"
   * says redraw the picture first — which on ltx is the step that actually
   * carries the new reference into the video. */
  ok("...and the shot says so in both words at once",
    after.staleReasons.includes("board-refs") && after.staleReasons.includes("board"),
    JSON.stringify(after.staleReasons));
  /* THE POINT OF ALL OF IT. On ltx the clip opens on the board picture, so a
   * re-render before the redraw pins the picture drawn before the prop existed
   * — which is what actually happened, and what the stale flag now asks to
   * prevent. */
  ok("...and on ltx the render still opens on the board picture, which is why it matters",
    after.opensOn === "board2.png" && after.useRefs === false && after.refsSent === false,
    `opensOn ${after.opensOn}`);
  d2.boards[1].imageFile = "board2_v2.png";
  d2.boards[1].staleRefs = false;
  const redrawn = shotRecord(d2, "s1_1");
  ok("...so once the board is redrawn, the re-render pins the NEW picture and the flag clears",
    redrawn.opensOn === "board2_v2.png" && !redrawn.staleReasons.includes("board-refs"),
    `opensOn ${redrawn.opensOn} reasons ${redrawn.staleReasons.join(",")}`);

  /* A save that changes nothing must not send a director back to redraw a
   * picture that is still correct — upsertBoard can afford an unconditional
   * flag because it is a whole-board commit; this is a per-shot tweak. */
  const d3 = baseDoc();
  d3.clips.push({ id: "c_s1_0", segmentId: "s1_0", clipFile: "clip1.mp4", status: "done", takes: [] });
  applyShotEdit(d3, "s1_0", { refs: ["Kaya", "Marek", "Underpass", "NightBus"] });
  ok("...while re-saving the SAME references marks nothing stale at all",
    d3.boards[0].staleRefs !== true && d3.clips[0].status === "done",
    `staleRefs ${d3.boards[0].staleRefs} status ${d3.clips[0].status}`);
}

/* ── A PROMPT-ONLY EDIT IS A CHANGE TO THE RENDER ─────────────────────
 * Only a REFERENCE edit used to mark anything, so a scene whose saved prompt
 * asked for something the clip on disk was never told about reported status
 * "done", staleReasons [] and zero breaks. */
{
  const d2 = baseDoc();
  d2.clips.push({ id: "c_s1_0", segmentId: "s1_0", clipFile: "clip1.mp4", status: "done",
                  takes: [{ clip: "clip1.mp4", at: 1, engine: "h3", prompt: "old words",
                            promptSource: "computed", refs: [], refsSent: true, refsMissing: [] }] });
  applyShotEdit(d2, "s1_0", { prompt: "She sets the NightBus alight." });
  const rec = shotRecord(d2, "s1_0");
  ok("editing only the prompt marks the clip stale, and names the PROMPT as the reason",
    rec.status === "stale" && rec.staleReasons.includes("prompt")
      && !rec.staleReasons.includes("board"),
    JSON.stringify(rec.staleReasons));
  /* Two edits before one re-render must both survive: "the refs moved AND the
   * prompt changed" is a different repair from either one alone. */
  applyShotEdit(d2, "s1_0", { refs: ["Kaya"] });
  const both = shotRecord(d2, "s1_0");
  ok("...and a later reference edit ADDS its reason rather than replacing it",
    both.staleReasons.includes("prompt") && both.staleReasons.includes("board"),
    JSON.stringify(both.staleReasons));
  /* Re-saving the same words is not a change and must not re-flag a repaired
   * shot; a clip with nothing rendered yet cannot be out of date at all. */
  const d3 = baseDoc();
  applyShotEdit(d3, "s1_0", { prompt: "unrendered" });
  ok("...while a scene with no rendered clip is never marked stale by an edit",
    shotRecord(d3, "s1_0").staleReasons.length === 0,
    JSON.stringify(shotRecord(d3, "s1_0").staleReasons));
  /* A clip stale from before staleWhy existed still reports what it always
   * meant, rather than losing its reason to a newer field. */
  const d4 = baseDoc();
  d4.clips.push({ id: "c_s1_0", segmentId: "s1_0", clipFile: "c.mp4", status: "stale", takes: [] });
  ok("...and a legacy stale clip with no reason recorded still reads as \"board\"",
    shotRecord(d4, "s1_0").staleReasons.includes("board"));
}

/* ── the structural promises the prose cannot keep on its own ────────────── */

const SHOT = src("shot.js"), GEN = src("generate.js"), REGEN = src("regen.js");
ok("generate.js does not keep its own copy of the resolution",
  /resolveShot\(doc, seg\.id/.test(GEN) && !/function clipPrompt/.test(GEN),
  "a second copy is how the prompt and the pictures drift apart");
ok("...and stages exactly the list the resolver returned, in that order",
  /for \(const r of plan\.refs\) refImages\.push/.test(GEN),
  "the <Picture N> numbering is only true if this loop is the one that stages");
ok("...and records the prompt and the references ON THE TAKE, not only on the row",
  /prompt,\s*\n\s*promptSource: plan\.promptSource,\s*\n\s*refs: plan\.refs\.map/.test(GEN),
  "the row's prompt is overwritten by the next render — the take's is the evidence");
ok("...and says out loud, at render time, when a reference reached it as nothing",
  /had no sheet and reached the render as nothing/.test(GEN));
ok("...and records WHETHER THE PICTURES WENT, not only which ones resolved",
  /refsSent: plan\.refsSent/.test(GEN),
  "resolved is not sent: on every ltx project the take listed sheets it was never handed");
ok("...so the map draws a cast-to-clip edge as carried only when they did",
  /carried: sent, broken: !sent/.test(GEN) && !/carried: true[,)}]/.test(GEN),
  "carried:true was a constant, and drew a solid line into a clip that got no picture");
ok("...and says once, per project, that on ltx the board image is the only carrier",
  /sheetsNotSent/.test(GEN) && /the board image/.test(GEN),
  "half the map is bookkeeping on ltx and it has to say so");
ok("the staleness sweep no longer keeps a hand-written mirror of the resolution",
  /resolveShot\(doc, seg\.id\)\.refs/.test(REGEN) && !/board\.characterRefs \|\| \[\]\)\]/.test(REGEN),
  "its copy had already drifted — it read cast and locations and never props");
/* ⚠ ASSERTED ON THE IMPORTS, NOT ON THE PROSE. The first version of this check
 * grepped for `updateProject` and failed on a COMMENT that says applyShotEdit
 * runs inside one. Zero imports is the structural fact: a module that pulls in
 * nothing cannot read a disk, cannot write a document, and can therefore be
 * called for free before a render — which is the whole premise of `mv_shot`. */
ok("the resolver is pure: it imports nothing at all",
  !/^\s*import\s/m.test(SHOT),
  (SHOT.match(/^\s*import\s.*$/gm) || []).join(" / "));
ok("...and no stray control byte crept into the source",
  // eslint-disable-next-line no-control-regex
  !/[ --]/.test(SHOT),
  "a NUL in a template literal is invisible in an editor and makes grep call the file binary");

/* ── board.staleRefs: THE RULE, BOTH DIRECTIONS, ON ITS OWN ────────────────
 *
 * The field existed for the life of this app with four writers that set it and
 * none that cleared it, so "Drawn before its references changed" stayed on the
 * map after the redraw, after the adopt, and after the clip re-rendered on the
 * new picture. These are the two functions that make the sentence answerable;
 * the route-level proof that the whole loop really closes is in plan_test.js.
 */
{
  const board = (over = {}) => ({
    id: "bd", segmentId: "s1_0", imageFile: "one.png",
    takes: [{ file: "one.png", at: 1000 }, { file: "two.png", at: 3000 }],
    updatedAt: 900, ...over,
  });

  const b1 = board();
  markBoardRefsChanged(b1, { now: 2000 });
  ok("marking the references changed stamps WHEN, so a redraw can be newer than it",
    b1.staleRefs === true && b1.refsAt === 2000, JSON.stringify(b1));

  refreshBoardStale(b1);
  ok("...and the picture on show, drawn before that, stays stale",
    b1.staleRefs === true, `drawn 1000, refs 2000 -> ${b1.staleRefs}`);

  b1.imageFile = "two.png";
  refreshBoardStale(b1);
  ok("...adopting the take drawn AFTER the change clears it",
    b1.staleRefs === false, `drawn 3000, refs 2000 -> ${b1.staleRefs}`);

  b1.imageFile = "one.png";
  refreshBoardStale(b1);
  ok("...and going back to the older picture is stale again, because it is",
    b1.staleRefs === true, `drawn 1000, refs 2000 -> ${b1.staleRefs}`);

  /* A board with no picture cannot be showing an out-of-date one. The cast
   * cascade used to flag those too. */
  const b2 = board({ imageFile: null });
  markBoardRefsChanged(b2, { now: 2000 });
  ok("a board that has never been drawn is not 'drawn before its references changed'",
    b2.staleRefs === false && b2.refsAt === 2000);

  /* Nothing is proved when nothing says when the picture was made — a take from
   * before takes carried a timestamp, or a picture with no take at all. */
  const b3 = board({ takes: [{ file: "one.png" }], refsAt: 2000, staleRefs: true });
  refreshBoardStale(b3);
  ok("a take with no timestamp proves nothing, so the flag is left exactly as it was",
    b3.staleRefs === true);

  /* The migration. A document written before `refsAt` existed falls back to
   * `updatedAt` — which applyShotEdit bumps on every save, including one that
   * changed no reference — so on that path the rule may only CLEAR. */
  const b4 = board({ updatedAt: 500, staleRefs: true });
  refreshBoardStale(b4);
  ok("an older document clears on `updatedAt` when its picture is newer than the save",
    b4.staleRefs === false, JSON.stringify(b4));
  const b5 = board({ updatedAt: 5000, staleRefs: false });
  refreshBoardStale(b5);
  ok("...and never INVENTS staleness from a bumped updatedAt, which a no-op save moves",
    b5.staleRefs === false, JSON.stringify(b5));
}

/* ── THE SONG UNDER THE CLIP, said on the shot (2026-09-24) ───────────────
 * A new project starts on Song under the clip "always" (store.js, the REWIND
 * A/B), so a ticked character with a sheet goes to H3 with its picture named
 * first and the song under the clip; an "auto" brief on a board not marked as
 * sung says, before anything is spent, that the mouth will not follow. */
{
  const { blankProject } = await import("./store.js");
  const fresh = () => ({ ...blankProject("Rewind"), styleBible: "Anime night", song: { file: "song.flac" },
    characters: [{ id: "c1", name: "Senzu", imageFile: "senzu.png", takes: [] }], backgrounds: [], props: [],
    segments: [{ id: "s1_0", index: 0, startSec: 0, endSec: 4, durationSec: 4, kind: "lyrical", mode: "generate", thesisLine: "I miss her" }],
    boards: [{ id: "bd1", segmentId: "s1_0", segmentIndex: 0, shots: [{ action: "Senzu sings the line to camera" }],
      characterRefs: ["Senzu"], backgroundRefs: [], propRefs: [], refProminence: {}, imageFile: null, takes: [] }],
    clips: [] });
  const r1 = resolveShot(fresh(), "s1_0", { ltxReady: true });
  ok("a new project's scene with a ticked character goes to H3 with its picture",
    r1.engine === "h3" && r1.useRefs === true && r1.refsSent === true, JSON.stringify({ engine: r1.engine, useRefs: r1.useRefs }));
  ok("...its prompt names the picture first after the style", r1.prompt.startsWith("Anime night. <Picture 1> is Senzu."), r1.prompt.slice(0, 80));
  ok("...and the song is under the clip, said in the brief's words",
    r1.songUnder === true && /^song under this clip: the brief puts it under every scene/.test(r1.songLine), r1.songLine);
  const auto = fresh();
  auto.brief.songConditioning = "auto";
  const r2 = resolveShot(auto, "s1_0", { ltxReady: true });
  ok("an auto brief on a board not marked as sung: no song, and the shot says the mouth will not follow",
    r2.songUnder === false && /^no song under this clip: Song under the clip is auto/.test(r2.songLine), r2.songLine);
  auto.boards[0].lipSync = true;
  ok("...a board marked as sung has it", resolveShot(auto, "s1_0", { ltxReady: true }).songLine === "song under this clip: this board sings (lip-sync)");
  const none = fresh();
  none.song = null;
  ok("...and with no song attached, the shot says so", resolveShot(none, "s1_0").songUnder === false
    && resolveShot(none, "s1_0").songLine === "no song attached to this project");
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
