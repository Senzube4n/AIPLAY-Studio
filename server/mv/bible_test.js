/**
 * THE THINGS THE BOARDS DO NOT CARRY — the scan, and why it is spelled tightly.
 *
 * WHAT THIS IS GUARDING. `undeclaredRecurring` is the only thing in the pipeline
 * that notices an object the story leans on and the boards do not reference. It
 * used to be eight vehicle words, which meant a metronome, a guitar, a suitcase
 * and a coat were all invisible to it; and it skipped any board that already
 * listed one prop, which meant it nagged exactly the people who had complied and
 * stayed silent for the ones who had half-complied.
 *
 * Both checks now live here and they fail in opposite directions, so both need
 * pinning:
 *
 *   1. namedNotReferenced — the board's TEXT names a row you already declared,
 *      and the board references it nowhere. General, needs no wordlist, and the
 *      risk is a FALSE ALARM: a loose match reads "the gold line slides lower"
 *      as naming Gold Scree. This file already carries the lesson in prose — a
 *      warning that cries on compliant projects is one people learn to scroll
 *      past — so the matcher is pinned against loosening.
 *
 *   2. undeclaredObject — the vehicle heuristic, for the thing with no row at
 *      all. The risk here is the opposite: the suppression that keeps
 *      night-train-girl quiet must not also silence salt-and-static.
 *
 * The fixtures are hand-built documents. The last block MEASURES the real
 * corpus if it is on this machine and only PRINTS what it finds — the library
 * changes under this file, and a test that asserted a count from it would fail
 * for reasons that are not bugs.
 *
 * Runs standalone (`node server/mv/bible_test.js`) and in the pre-commit hook.
 * Reads only; writes nothing.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { undeclaredRecurring, namesAsset, saidWords, boardSays, declaredAssets } from "./bible.js";
import { crimeBoard } from "./generate.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const board = (i, { text = "", refs = {}, shots = [] } = {}) => ({
  id: `bd${i}`, segmentId: `s_${i}`, segmentIndex: i, clipIndex: i,
  boardPrompt: text, grade: null, shots,
  characterRefs: refs.characterRefs || [], backgroundRefs: refs.backgroundRefs || [],
  propRefs: refs.propRefs || [], refProminence: {}, imageFile: null, takes: [],
});
const doc = (over = {}) => ({ characters: [], backgrounds: [], props: [], boards: [], ...over });
const find = (d, kind) => undeclaredRecurring(d).filter((u) => u.kind === kind);

/* ── (1) the board names something you declared ─────────────────────────── */
{
  const d = doc({
    props: [{ id: "p1", name: "The Metronome", description: "a brass desk metronome", imageFile: "m.png" }],
    boards: [
      board(0, { text: "She winds the metronome and lets it run." }),
      board(1, { text: "The metronome ticks on the empty desk." }),
      board(2, { text: "Outside, rain." }),
    ],
  });
  const f = find(d, "namedNotReferenced");
  ok("a declared prop the boards NAME and do not reference is one finding, with its scenes",
    f.length === 1 && f[0].name === "The Metronome" && f[0].scenes.join(",") === "1,2",
    JSON.stringify(f));
  ok("...and it says which lane it is on and whether its sheet exists",
    f[0].assetKind === "prop" && f[0].hasSheet === true);
  ok("...and the wordlist heuristic has nothing to say about it, which is the point",
    find(d, "undeclaredObject").length === 0);

  /* Attaching it is the repair, and the finding has to go away when you make it. */
  d.boards[0].propRefs = ["The Metronome"];
  d.boards[1].propRefs = ["The Metronome"];
  ok("...and attaching it on every scene that names it clears the finding",
    find(d, "namedNotReferenced").length === 0);
}

/* ── the matcher, pinned against loosening ──────────────────────────────── */
{
  const said = saidWords("The gold line slides lower across the face of the summit cornice, "
    + "over the night train and the white snowfield.");
  ok("ALL of a name's own words must be present, not any one of them",
    namesAsset(said, "Summit Cornice") === true
      && namesAsset(said, "Gold Scree") === false
      && namesAsset(said, "Whiteout Face") === false
      && namesAsset(said, "White Bowl") === false,
    "a loose any-word match produced 20 findings on this corpus, of which 4 survived being looked at");
  ok("...the de-spaced form counts, so a prop declared NightTrain is named by \"night train\"",
    namesAsset(said, "NightTrain") === true);
  ok("...and so does the other direction",
    namesAsset(saidWords("the NightTrain waits"), "night train") === true);
  ok("...plurals count", namesAsset(saidWords("two metronomes on the desk"), "Metronome") === true);
  ok("...and a name made only of function words matches nothing",
    namesAsset(saidWords("in the of and"), "The") === false);
  ok("boardSays reads the shot ACTIONS, not just the board sentence",
    saidWords(boardSays(board(0, { shots: [{ action: "she lights the brass metronome" }] }))).has("metronome"));
  ok("declaredAssets flattens all three lanes and keeps the kind",
    declaredAssets({ characters: [{ name: "A" }], backgrounds: [{ name: "B" }], props: [{ name: "C", imageFile: "c.png" }] })
      .map((a) => `${a.name}:${a.kind}:${a.has}`).join(",") === "A:character:false,B:background:false,C:prop:true");
}

/* ── a board that already carries a prop is NOT skipped ─────────────────── */
{
  /* The deliberate trade this replaces: a scene that declared a guitar and
   * forgot its car was invisible, because ANY propRefs entry dropped the whole
   * board from the scan. */
  const d = doc({
    props: [{ id: "p1", name: "Sunburst Guitar", description: "a 1961 sunburst semi-hollow" }],
    boards: [
      board(0, { text: "He drives the car to the club, guitar on the back seat.", refs: { propRefs: ["Sunburst Guitar"] } }),
      board(1, { text: "The car idles outside.", refs: { propRefs: ["Sunburst Guitar"] } }),
      board(2, { text: "The car pulls away." }),
    ],
  });
  const f = find(d, "undeclaredObject");
  ok("a board that already lists a prop is still scanned for the object it forgot",
    f.length === 1 && f[0].word === "car" && f[0].scenes.join(",") === "1,2,3",
    JSON.stringify(f));
}

/* ── and the false alarm that skip existed to stop, stopped properly ────── */
{
  /* night-train-girl declares "NightTrain", a 1970s railcar, references it on
   * the boards whose text says "car", and was told on all five of them that no
   * prop declares a car. Suppression is at the WORD level and on evidence, so
   * no board is dropped from any other finding's scene list. */
  const d = doc({
    props: [{ id: "p1", name: "NightTrain", description: "a 1970s railcar, oxblood livery" }],
    boards: [
      board(0, { text: "The car sways through the dark.", refs: { propRefs: ["NightTrain"] } }),
      board(1, { text: "She walks the length of the car.", refs: { propRefs: ["NightTrain"] } }),
    ],
  });
  ok("a declared prop that IS the thing silences the word: \"railcar\" declares \"car\"",
    find(d, "undeclaredObject").length === 0, JSON.stringify(undeclaredRecurring(d)));

  /* ⚠ THE ONE IT DOES NOT CATCH, pinned as a KNOWN LIMIT rather than left to be
   * rediscovered as a bug. "the grey Volvo, a grey estate, 1988" contains no
   * vehicle word, so the scan still says no prop declares a car. The repair is
   * one word in the description. The alternative — trusting that a board which
   * attached SOME prop must have meant this one — silences the guitar case
   * above, which is the whole failure this change exists to end. */
  const d2 = doc({
    props: [{ id: "p1", name: "The Grey Volvo", description: "a grey estate, 1988" }],
    boards: [
      board(0, { text: "The car waits at the kerb.", refs: { propRefs: ["The Grey Volvo"] } }),
      board(1, { text: "The car pulls out.", refs: { propRefs: ["The Grey Volvo"] } }),
    ],
  });
  ok("...but a prop that never says what it IS still draws the false alarm (known limit)",
    find(d2, "undeclaredObject").length === 1, JSON.stringify(undeclaredRecurring(d2)));
  d2.props[0].description = "a grey estate car, 1988";
  ok("...and one word in its description is the whole repair",
    find(d2, "undeclaredObject").length === 0);

  /* The length guard is what stops a word ending in the vehicle word from
   * declaring it. Without it "scar" declares "car" and the check goes silent. */
  const d3 = doc({
    props: [{ id: "p1", name: "The Scar", description: "an old scar above her eyebrow" }],
    boards: [board(0, { text: "The car waits." }), board(1, { text: "The car pulls out." })],
  });
  ok("...while a scar does not declare a car",
    find(d3, "undeclaredObject").length === 1, JSON.stringify(undeclaredRecurring(d3)));
}

/* ── one shot is set dressing ───────────────────────────────────────────── */
{
  const d = doc({ boards: [board(0, { text: "A truck passes once." }), board(1, { text: "Rain." })] });
  ok("an object in ONE scene is set dressing and is not reported",
    find(d, "undeclaredObject").length === 0);
}

/* ── THE MAP DRAWS WHAT THE RENDER WAS ACTUALLY HANDED ──────────────────
 *
 * The same subject one layer up. A clip handed no picture is a thing the board
 * did not carry, and the map is the screen built to be read WITHOUT reading —
 * so an edge drawn solid is a claim, and it was a constant. */
{
  const seg = (i) => ({ id: `s_${i}`, index: i, startSec: i * 4, endSec: i * 4 + 4, durationSec: 4,
                        kind: "lyrical", mode: "generate", thesisLine: "a line" });
  const mapDoc = (over = {}) => ({
    brief: {}, styleBible: "grain",
    characters: [{ id: "c1", name: "Kaya", imageFile: "kaya.png", takes: [] }],
    backgrounds: [], props: [{ id: "p1", name: "TheMetronome", imageFile: "m.png", takes: [] }],
    segments: [seg(0)],
    boards: [{ id: "bd1", segmentId: "s_0", segmentIndex: 0, clipIndex: 0, boardPrompt: "she waits",
               grade: null, shots: [{ shotType: "wide", action: "she waits" }],
               characterRefs: ["Kaya"], backgroundRefs: [], propRefs: [],
               refProminence: { Kaya: 1 }, imageFile: "board1.png", takes: [] }],
    clips: [], runs: [], ...over,
  });
  const takeWith = (o) => ({ clip: "c.mp4", at: 1, prompt: "p", promptSource: "computed",
                            refs: [{ name: "Kaya", kind: "character", file: "kaya.png" }],
                            refsMissing: [], ...o });
  const clipWith = (take) => [{ id: "c_s_0", segmentId: "s_0", clipFile: "c.mp4", status: "done",
                               takes: [take] }];
  const castToClip = (b) => b.edges.filter((e) => e.to === "clip:s_0" && e.type === "character");

  const sent = crimeBoard(mapDoc({ brief: { videoEngine: "h3" },
    clips: clipWith(takeWith({ engine: "h3", refsSent: true })) }));
  ok("a cast-to-clip edge is drawn CARRIED when the take says the pictures went",
    castToClip(sent).length === 1 && castToClip(sent)[0].carried === true
      && !castToClip(sent)[0].broken,
    JSON.stringify(castToClip(sent)));

  const notSent = crimeBoard(mapDoc({ brief: { videoEngine: "ltx" },
    clips: clipWith(takeWith({ engine: "ltx", refsSent: false })) }));
  ok("...and BROKEN when it says they did not — `carried: true` used to be a constant",
    castToClip(notSent)[0].carried === false && castToClip(notSent)[0].broken === true,
    JSON.stringify(castToClip(notSent)));

  /* A take from before refsSent existed still has an honest answer, because only
   * H3 has a named-reference input at all. */
  const legacy = crimeBoard(mapDoc({ brief: { videoEngine: "ltx" },
    clips: clipWith(takeWith({ engine: "ltx" })) }));
  ok("...and a take that predates the field is read from its ENGINE, never guessed as carried",
    castToClip(legacy)[0].carried === false,
    JSON.stringify(castToClip(legacy)));

  ok("the honest limit is said ONCE, about the project, and names the board as the only carrier",
    notSent.breaks.filter((b) => b.kind === "sheetsNotSent").length === 1
      && /board image/i.test(notSent.breaks.find((b) => b.kind === "sheetsNotSent").msg)
      && notSent.counts.notes === 1,
    JSON.stringify(notSent.breaks.filter((b) => b.level === "note").map((b) => b.msg)));
  ok("...and a note is counted apart from the breaks, because nothing about it is wrong",
    !notSent.breaks.filter((b) => b.level !== "note").some((b) => b.kind === "sheetsNotSent")
      && notSent.counts.breaks === notSent.breaks.length - 1);
  ok("...and an H3 project that really carries its sheets is told nothing",
    sent.counts.notes === 0);

  /* ── the prompt edit the map could not see ─────────────────────────────── */
  const edited = crimeBoard(mapDoc({
    brief: { videoEngine: "h3" },
    clips: [{ id: "c_s_0", segmentId: "s_0", clipFile: "c.mp4", status: "stale",
              staleWhy: ["prompt"],
              promptOverride: "She winds the metronome until it stops.",
              takes: [takeWith({ engine: "h3", refsSent: true })] }],
  }));
  const kinds = edited.breaks.map((b) => b.kind);
  ok("a saved prompt naming a declared asset the board does not carry is a break",
    kinds.includes("promptNamesUncarried")
      && /TheMetronome/.test(edited.breaks.find((b) => b.kind === "promptNamesUncarried").msg),
    JSON.stringify(edited.breaks.map((b) => `${b.kind}: ${b.msg.slice(0, 60)}`)));
  ok("...and a clip rendered from the BUILDER while a hand-written prompt is stored is another",
    kinds.includes("promptNotUsed"));
  ok("...and the clip's own staleness reason reaches the map in words",
    kinds.includes("promptChanged"));
  /* The whole point: this project reported status done, staleReasons [] and
   * zero breaks before any of the three existed. */
  ok("...so a prompt-only edit is no longer invisible", edited.counts.breaks >= 3);

  const clean = crimeBoard(mapDoc({ brief: { videoEngine: "h3" },
    clips: clipWith(takeWith({ engine: "h3", refsSent: true })) }));
  ok("...while a scene with no saved prompt is accused of none of it",
    !clean.breaks.some((b) => String(b.kind).startsWith("prompt")));
}

/* ── the corpus, measured and printed rather than asserted ──────────────── */
{
  /* ⚠ PRINTED, NOT ASSERTED. The library is edited by hand between runs, so a
   * count pinned here would fail for reasons that are not bugs. What it is for:
   * the numbers in the commit message are reproducible by running this file. */
  let root = null;
  try {
    const { config } = await import("../config.js");
    root = path.join(config.outputDir, "mv");
  } catch { /* no config on this machine — skip the measurement */ }
  if (root && existsSync(root)) {
    const slugs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(path.join(root, e.name, "project.json")))
      .map((e) => e.name);
    let named = 0, namedBoards = 0, objects = 0;
    const lines = [];
    for (const slug of slugs) {
      let d;
      try { d = JSON.parse(readFileSync(path.join(root, slug, "project.json"), "utf8")); }
      catch { continue; }
      const f = undeclaredRecurring(d);
      const n = f.filter((u) => u.kind === "namedNotReferenced");
      const o = f.filter((u) => u.kind === "undeclaredObject");
      if (!n.length && !o.length) continue;
      named += n.length;
      namedBoards += n.reduce((a, u) => a + u.scenes.length, 0);
      objects += o.length;
      lines.push(`        ${slug}: `
        + [...n.map((u) => `${u.name} named on ${u.scenes.length} board${u.scenes.length === 1 ? "" : "s"} (${u.scenes.join(",")})`),
           ...o.map((u) => `undeclared ${u.word} ×${u.scenes.length} (${u.scenes.join(",")})`)].join("; "));
    }
    console.log(`\n  measured over ${slugs.length} real projects:`);
    console.log(`        ${named} assets named-but-not-referenced across ${namedBoards} boards; `
      + `${objects} undeclared recurring objects`);
    for (const l of lines) console.log(l);
    ok("the scan runs over the whole real corpus without throwing", true);
  } else {
    console.log("\n  (no project library on this machine — corpus measurement skipped)");
  }
}

/* ── the board flag that reaches the renderer ────────────────────────────
 *
 * generate.js freezes the song under an H3 render when
 *
 *     engine === "ltx" || !useRefs || Boolean(board?.lipSync)
 *       || brief.songConditioning === "always"
 *
 * and on the reference path the first two are false. The third clause was DEAD:
 * `lipSync` was read there and written nowhere, because commitBible did not
 * carry it onto the board it builds. So the per-scene opt-in could never be
 * true, and the only working lever was the all-or-nothing brief flag.
 *
 * MEASURED, not theorised: the first cut of Bewitching rendered all 50 scenes
 * with NO audio input node in the graph at all - MiniMaxH3ReferenceToVideo and
 * LoadImage only - so every close-up mouthed something unrelated to the lyric.
 * A clause nothing can satisfy looks exactly like a clause that works, which is
 * why it survived this long and why it gets a pin rather than a comment.
 *
 * The granularity is the point: 23 of those 50 scenes sing, and freezing a song
 * under a shot of her hands buys a mouth that is not in frame. */
console.log("\n  the lipSync flag survives commitBible");
{
  const bsrc = readFileSync(new URL("./bible.js", import.meta.url), "utf8");
  const gsrc = readFileSync(new URL("./generate.js", import.meta.url), "utf8");
  ok("commitBible writes lipSync onto the board it builds", /lipSync:\s*!!b\.lipSync/.test(bsrc));
  ok("...and generate.js is still the reader that needs it", /Boolean\(board\?\.lipSync\)/.test(gsrc));
  ok("...and audioTrack is still gated on that same decision",
    /audioTrack:\s*\(doc\.song\?\.file && songConditioned\)/.test(gsrc));
  ok("...and songConditioned still names the board flag as one of its ways in",
    /songConditioned\s*=[\s\S]{0,160}board\?\.lipSync/.test(gsrc));

  /* ⚠ AND THE SECOND WRITER, WHICH THESE FOUR CHECKS DID NOT SEE.
   *
   * The four above pin commitBible — the whole-bible commit, which an LLM uses
   * once. upsertBoard is the OTHER door: it is what `set_board` calls, what the
   * board editor posts to, and what every per-scene change in a real build goes
   * through. It had no `lipSync` key at all, so `set_board { lipSync: true }`
   * answered ok and returned a board without it, and the clause generate.js
   * reads stayed exactly as dead as before through the path anybody actually
   * films with. Fixing one of two writers is not fixing the flag, and a source
   * check aimed at the writer you happened to think of will say it is.
   *
   * So this counts the BUILDERS instead of naming one. Every board object in
   * bible.js declares `characterRefs:`; every one of them has to declare
   * `lipSync:` too, and a third door added later is caught by arithmetic
   * rather than by somebody remembering to extend a regex. */
  const builders = (bsrc.match(/^\s*characterRefs: /gm) || []).length;
  const flags = (bsrc.match(/^\s*lipSync: /gm) || []).length;
  ok(`every board builder in bible.js carries lipSync (${flags} of ${builders})`,
    builders >= 2 && flags === builders,
    "a writer that omits it returns ok and hands back a board the renderer reads as silent");
  ok("...and upsertBoard PRESERVES it when the caller does not mention it",
    /lipSync: board\.lipSync === undefined \? !!old\?\.lipSync : !!board\.lipSync/.test(bsrc),
    "the board editor sends no lipSync key, so an unconditional !! turns singing off on every Save");
}

/* ── KEEP THE CHARACTER, in the lint (the REWIND A/B, 2026-09-24) ─────────
 *
 * From words alone the lead came back with another hair colour, another mask
 * and another coat from shot to shot; with his pictures he matched in all
 * four. So the lint says, per board, when the words name a character the board
 * does not tick, with a fix that ticks it (set_shot, keeping the board's other
 * references); says when the brief will not send the ticked cast's pictures;
 * and, on an "auto" project, says when the words sing and no song goes under
 * the clip. Props and backgrounds keep their per-asset line (the metronome case
 * above is unchanged). */
console.log("\n  the lint keeps the character");
{
  const { lintProject } = await import("./bible.js");
  const { applyShotEdit } = await import("./shot.js");
  const seg = (i, kind = "lyrical") => ({ id: `s_${i}`, index: i, startSec: i * 4, endSec: i * 4 + 4, durationSec: 4,
    kind, mode: "generate", thesisLine: "I miss her" });
  const project = (over = {}) => ({
    styleBible: "Anime night", lookBible: "cold cyan", story: { logline: "a thief runs" },
    brief: { videoEngine: null, songConditioning: "always" }, song: { file: "song.flac" },
    characters: [{ id: "c1", name: "Senzu", imageFile: "senzu.png" }, { id: "c2", name: "Rin", imageFile: "rin.png" }],
    backgrounds: [{ id: "g1", name: "Harbour", imageFile: "harbour.png" }],
    props: [{ id: "p1", name: "The Metronome", imageFile: "m.png" }],
    segments: [seg(0), seg(1)],
    boards: [
      board(0, { refs: { characterRefs: ["Rin"], backgroundRefs: ["Harbour"] },
        shots: [{ action: "Senzu vaults the rail while Rin watches from the dock" }] }),
      board(1, { refs: { characterRefs: ["Senzu"] }, shots: [{ action: "Senzu turns to camera under the lamp" }] }),
    ],
    clips: [], ...over,
  });
  const d = project();
  const tick = lintProject(d).filter((i) => i.fix?.action === "set_shot");
  ok("a character named in a board's words and not ticked: one line for that board, with a fix",
    tick.length === 1 && tick[0].where === "scene 1"
      && /^Names Senzu in its words but does not tick Senzu as cast, so the clip gets no picture of Senzu and invents them from the words/.test(tick[0].msg),
    JSON.stringify(tick));
  ok("...the fix ticks the name and keeps the board's other references",
    JSON.stringify(tick[0]?.fix) === JSON.stringify({ label: "Tick Senzu", action: "set_shot", segmentId: "s_0", refs: ["Rin", "Harbour", "Senzu"] }),
    JSON.stringify(tick[0]?.fix));
  applyShotEdit(d, tick[0].fix.segmentId, { refs: tick[0].fix.refs });
  ok("...and applying it clears the line", !lintProject(d).some((i) => i.fix?.action === "set_shot"));
  const noSheet = project({ characters: [{ id: "c1", name: "Senzu", imageFile: null }, { id: "c2", name: "Rin", imageFile: "rin.png" }] });
  ok("...and says when the character has no sheet yet either",
    lintProject(noSheet).some((i) => i.fix?.action === "set_shot" && / Senzu has no rendered sheet yet either\.$/.test(i.msg)));
  ok("a prop keeps its one per-asset line (no fix)",
    lintProject(project({ boards: [board(0, { refs: { characterRefs: ["Senzu"] }, shots: [{ action: "Senzu winds the metronome on the desk" }] })] }))
      .some((i) => i.where === "The Metronome" && /^Named in the text of 1 board/.test(i.msg) && !i.fix));

  const off = (brief) => lintProject(project({ brief: { songConditioning: "always", ...brief } })).find((i) => i.where === "brief" && i.fix?.action === "set_brief");
  const ltx = off({ videoEngine: "ltx" });
  ok("ticked cast on an LTX project: the pictures will not be sent, said once, with the fix and its trade",
    /^2 board\(s\) tick cast, but the engine is set to LTX, which takes no pictures, so no clip is given their pictures/.test(ltx?.msg || "")
      && / Switching to hybrid renders those scenes on MiniMax H3: about 7x slower than LTX, and H3's licence grants no rights in its excluded territories \(studio_status\)\. Where that applies, keep LTX\.$/.test(ltx?.msg || "")
      && JSON.stringify(ltx?.fix) === JSON.stringify({ label: "Render cast scenes on H3 (hybrid)", action: "set_brief", brief: { videoEngine: "hybrid" } }),
    JSON.stringify(ltx));
  const refsOff = off({ castRefs: false });
  ok("...and with cast pictures switched off", /but cast pictures are switched off,/.test(refsOff?.msg || "")
    && JSON.stringify(refsOff?.fix?.brief) === JSON.stringify({ castRefs: true }), JSON.stringify(refsOff));
  ok("...and not on the default brief, which sends them", !off({}));

  const sung = (brief) => lintProject(project({ brief, boards: [
    board(0, { refs: { characterRefs: ["Senzu", "Rin"] }, shots: [{ action: "Senzu sings the line to Rin" }] }),
    board(1, { refs: { characterRefs: ["Senzu"] }, shots: [{ action: "Senzu turns to camera under the lamp" }] }),
  ] })).filter((i) => i.fix?.brief?.songConditioning === "always");
  const auto = sung({ songConditioning: "auto" });
  ok("an auto project whose board sings with no song under the clip: said on that scene, with the fix",
    auto.length === 1 && auto[0].where === "scene 1"
      && auto[0].msg === "The words say someone sings, but Song under the clip is auto and this board is not marked as sung: no song goes under the clip, so the mouth will not follow the words."
      && auto[0].fix.label === "Put the song under every scene" && auto[0].fix.action === "set_brief", JSON.stringify(auto));
  ok("...an older project with no value reads as auto", sung({}).length === 1);
  ok("...a board marked as sung has the song under it", lintProject(project({ brief: { songConditioning: "auto" }, segments: [seg(0)],
    boards: [{ ...board(0, { refs: { characterRefs: ["Senzu"] }, shots: [{ action: "Senzu sings" }] }), lipSync: true }] }))
    .every((i) => i.fix?.brief?.songConditioning !== "always"));
  /* A lyrical scene with no board sings by construction ("sings the line"). */
  ok("...and a lyrical scene with no board, on auto, is said too", lintProject(project({ brief: { songConditioning: "auto" }, segments: [seg(0), seg(1)],
    boards: [{ ...board(0, { refs: { characterRefs: ["Senzu"] }, shots: [{ action: "Senzu sings" }] }), lipSync: true }] }))
    .some((i) => i.where === "scene 2" && i.fix?.brief?.songConditioning === "always"));
  ok("...and an \"always\" project (new projects) gives neither the sung line nor the pictures line",
    sung({ songConditioning: "always" }).length === 0 && !off({}));
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
