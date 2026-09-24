/**
 * Video Workflow — generation: takes, clips, the timeline handoff, the map.
 *
 * Everything here goes through Studio's OWN art queue (`art.request`), so music
 * still preempts, the cost-modelled deadlines still apply, and the GUI's queue
 * display shows workflow renders like any other job. The workflow never talks
 * to ComfyUI directly.
 *
 * TAKES. Every generated artefact is a take appended to its row's `takes[]`
 * — {file, seed, at} — and the row's chosen file only moves when the caller
 * picks. Regenerating is therefore never destructive: the seed that made every
 * take is recorded, so "give me another like it" and "go back to the second
 * one" are both one call. Images arrive as strips of up to 4 per render for
 * nearly free (one text encode serves the batch — see coverGraph).
 */
import path from "node:path";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { updateProject, readProject, assetsDir, stageAsset, noteRun } from "./store.js";
/* ⚠ THE RESOLUTION LIVES IN shot.js NOW, and this file is one of its callers
 * rather than its owner. Everything a clip render is given — which sheets
 * resolve, in what order, which engine that implies, and the exact prompt text
 * — is decided there, as a pure function, so a human can look at it BEFORE
 * spending the GPU and get the same answer the renderer will act on. */
import { resolveShot, markBoardRefsChanged, refreshBoardStale } from "./shot.js";
/* The size list and the matched step count, each from its one source. */
import { renderSizeOf } from "./sizes.js";
import { clipStepsFor } from "./clipsteps.js";
/* The relationship map draws the undeclared-object finding as a ghost node in
 * the prop lane. The SCAN itself stays in bible.js, beside the lint that also
 * reports it — two copies would disagree the first time anybody added a noun,
 * and the map would then be quietly kinder than the lint. */
import { undeclaredRecurring, declaredAssets, namesAsset, saidWords } from "./bible.js";
import { safetyError, CODE as SAFETY_CODE } from "../safety/refusal.js";
import { UNVERIFIABLE_CODE } from "../safety/graph.js";

/**
 * THE WORDS BEHIND THE PICTURES A RENDER IS HANDED, for the minors rule.
 *
 * A board or clip prompt names its cast only BY NAME ("<Picture 1> is Mara"),
 * and who Mara is reaches the model as her sheet, a picture no text check can
 * read. So a child described in a character's description, rendered to a
 * sheet, and then put in a sexual board action would pass a check of the
 * prompt alone. Each render here therefore hands the art queue the named
 * rows' own descriptions as `safetyContext`: words that are never sent to the
 * model, and that count on both sides of the check exactly like the prompt
 * (server/safety/minors.js). The engine door checks them again.
 */
export function castContext(doc, names = []) {
  const rows = [...(doc?.characters || []), ...(doc?.backgrounds || []), ...(doc?.props || [])];
  const out = [];
  for (const n of new Set(names)) {
    const row = rows.find((r) => r?.name === n);
    if (!row) continue;
    for (const k of ["description", "sheetPrompt", "platePrompt"]) {
      if (typeof row[k] === "string" && row[k].trim()) out.push(row[k]);
    }
  }
  return out;
}

/**
 * THE SAME, WITHOUT WORDS AND WITHOUT A WAY ROUND IT.
 *
 * A description can be edited after its sheet is drawn, so the words above
 * say what a row is NOW and not what its picture was MADE as. Every take
 * carries the wordless fingerprint of what it was rendered from
 * (server/safety/lineage.js), and this returns the fingerprint of the take
 * each named row has ADOPTED, which is the picture a render is actually handed.
 * A board's own adopted still counts too (pass the board as `board`).
 */
export function castFlags(doc, names = [], { board = null } = {}) {
  const rows = [...(doc?.characters || []), ...(doc?.backgrounds || []), ...(doc?.props || [])];
  /* A row may also carry `safety` itself: a friend's errand (collab/errand.js)
   * has no takes, only the flags the sender's Studio put on each picture. */
  const adopted = (row) => {
    const flags = [];
    if (row?.safety && typeof row.safety === "object") flags.push(row.safety);
    if (!row?.imageFile) return flags;
    const take = (row.takes || []).find((t) => t?.file === row.imageFile);
    if (take?.safety && typeof take.safety === "object") flags.push(take.safety);
    return flags;
  };
  const out = [];
  for (const n of new Set(names)) out.push(...adopted(rows.find((r) => r?.name === n)));
  if (board) out.push(...adopted(board));
  return out;
}

const boardCast = (board) => [
  ...(board?.characterRefs || []), ...(board?.backgroundRefs || []), ...(board?.propRefs || []),
];

const rollSeed = () => Math.floor(Math.random() * 4294967296);

/**
 * Wait for the art runner to finish ONE job, identified by its pseudo-file.
 * Resolves with the success payload, rejects on the runner's `failed` emit —
 * and on a deadline, because a wedged queue must not wedge the route forever.
 */
export function awaitArt(art, file, events, timeoutMs = 20 * 60e3, { pollMs = 30e3 } = {}) {
  /* A job the queue REFUSED under the minors rule was never queued, and its
   * `failed` event went out inside request() — before this wait began. Every
   * MV caller ignores request()'s return, so without asking here it would wait
   * the whole deadline for an answer that has already been given. */
  const refused = typeof art?.refusalFor === "function" ? art.refusalFor(file) : null;
  if (refused) return Promise.reject(safetyError({ door: "art.request", hint: refused.hint }));
  return new Promise((resolve, reject) => {
    const done = (fn) => (payload) => {
      if (payload.file !== file) return;
      cleanup();
      fn(payload);
    };
    const ok = done(resolve);
    /* A refusal keeps its own words (the sentence and any hint after it) and
     * its code, so the MV routes answer it as a 422 like every other door. */
    const bad = done((p) => {
      if (p.code !== SAFETY_CODE && p.code !== UNVERIFIABLE_CODE) return reject(new Error(p.error || "render failed"));
      const e = safetyError({ door: "engine.dispatch", code: p.code });
      if (p.error) e.message = String(p.error);
      return reject(e);
    });
    const timer = setTimeout(() => {
      cleanup();
      /* Tagged, so a caller can tell "still rendering past my wait" from a
       * render that failed (generateClip files a late clip when it lands). */
      reject(Object.assign(new Error("render timed out — check the queue on the Music tab"), { timedOut: true }));
    }, timeoutMs);
    /* ⚠ A JOB TAKEN OFF THE QUEUE NAMES NO EVENT. art.drop() (the rail's Stop,
     * a plan's Stop) removes a waiting job and emits only "update", so this
     * waited out its whole deadline for a render that would never run: two
     * hours of a plan item, or a route, hanging on nothing. On every update the
     * job must still be queued, running, or finished (its event then fired, or
     * is about to); none of the three is a job that is gone. A stand-in runner
     * without a queue keeps the events alone. */
    const gone = () => {
      if (!Array.isArray(art.queue)) return;
      if (art.queue.some((j) => j.file === file) || art.current?.file === file) return;
      if (Array.isArray(art.done) && art.done.some((j) => j.file === file)) return;
      cleanup();
      reject(new Error("the render was taken off the queue before it ran (Stop was pressed, or the queue was cleared)"));
    };
    /* AND ONE THAT EMPTIES THE QUEUE SAYS NOTHING AT ALL. art.stopAll() (the
     * Engine panel's) clears the queue without an "update", so the same
     * question is also asked every half minute (`pollMs`, shorter in a test). */
    const poll = setInterval(gone, pollMs);
    poll.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(poll);
      for (const ev of events) art.off(ev, ok);
      art.off("failed", bad);
      art.off("update", gone);
    };
    for (const ev of events) art.on(ev, ok);
    art.on("failed", bad);
    art.on("update", gone);
  });
}

/**
 * art.request, with its refusal said out loud. art.js answers null for a
 * render it will not queue and keeps the reason in `lastRefusal`; the wait
 * above would otherwise read the job that never arrived as one taken off the
 * queue ("Stop was pressed"), which is the wrong sentence. A stand-in runner
 * without `lastRefusal` is taken at its word.
 */
function requestArt(art, job) {
  const queued = art.request(job);
  /* ⚠ A MINORS REFUSAL KEEPS ITS SHAPE: the sentence, the hint and the code,
   * so the MV routes answer 422 like every other door rather than wrapping
   * the sentence in "the queue refused this render". */
  const refused = !queued && typeof art.refusalFor === "function" ? art.refusalFor(job.file) : null;
  if (refused) throw safetyError({ door: "art.request", hint: refused.hint });
  if (!queued && typeof art.lastRefusal === "string" && art.lastRefusal) {
    throw new Error(`The picture and video queue refused this render: ${art.lastRefusal}.`);
  }
  return queued;
}

/* HOW LONG A CLIP'S CALLER WAITS, and how long the take is still filed after.
 * The caller's two hours are the old wait (see generateClip); the day is only
 * a ceiling on a listener, because art.js ends every render with an event of
 * its own long before that. */
const CLIP_WAIT_HOURS = 2;
const CLIP_WAIT_MS = CLIP_WAIT_HOURS * 60 * 60e3;
const CLIP_LATE_CEILING_MS = 24 * 60 * 60e3;

/** `promise`, or the error `onLate()` builds once `ms` pass. The promise
 *  carries on either way; the race only decides what the caller hears. */
function withinWait(promise, ms, onLate) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { Promise.resolve().then(onLate).then(reject, reject); }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Copy a project asset into ComfyUI's input dir so LoadImage can read it. */
async function stageForComfy(slug, assetName) {
  const src = path.join(assetsDir(slug), assetName);
  const buf = await readFile(src);
  const name = `aiplay_frame_${createHash("sha1").update(buf).digest("hex").slice(0, 12)}${path.extname(assetName)}`;
  await mkdir(config.inputDir, { recursive: true });
  const dest = path.join(config.inputDir, name);
  try { await stat(dest); } catch { await writeFile(dest, buf); }
  return name;
}

/** Same, for the song: LoadAudio only reads the input dir, and the library
 *  lives in the output dir. Content-addressed by path like the video route's
 *  own stageSong, so one song staged twice is one file. */
async function stageSongForComfy(file) {
  const src = path.join(config.outputDir, path.basename(file));
  await stat(src);
  const name = `aiplay_refaud_${createHash("sha1").update(src).digest("hex").slice(0, 12)}${path.extname(src).toLowerCase()}`;
  await mkdir(config.inputDir, { recursive: true });
  const dest = path.join(config.inputDir, name);
  try { await stat(dest); } catch { await writeFile(dest, await readFile(src)); }
  return name;
}

/**
 * Which row a (target, id) names. EXPORTED because there must be exactly one of
 * these: blender.js records its sheets into the same `takes[]` this function
 * finds, and "the same selection semantics" is a promise that a second, private
 * copy of this lookup would break the first time either learned a new handle.
 */
export const findRow = (doc, target, id) => {
  const list = target === "character" ? doc.characters
    : target === "background" ? doc.backgrounds
    : target === "prop" ? (doc.props || [])
    : target === "board" ? doc.boards
    : target === "clip" ? doc.clips : null;
  if (!list) throw new Error(`bad target: ${target}`);
  // Clips have no name; they answer to their id, their segment's id, or the
  // scene index — the three handles every other clip route already accepts.
  const row = list.find((r) => r.id === id || r.name === id
    || (target === "clip" && (r.segmentId === id || r.clipIndex === Number(id))));
  if (!row) throw new Error(`No such ${target}: ${id}`);
  return row;
};

/* ────────────────────────────────────────────── image artefacts (takes) */

/**
 * Render takes for a character sheet, a background plate or a storyboard.
 *
 * The prompt is the row's own (sheetPrompt / platePrompt / boardPrompt) with
 * the style bible prefixed — the website's rule: one medium+style line
 * inherited by every image prompt. Boards additionally receive the sheets
 * they reference as FLUX reference images, which is what lets a board carry
 * identity instead of being a text-only sketch.
 */
export async function generateAsset(deps, slug, { target, id, count = 4, seed, refs = true }) {
  const { art } = deps;
  const doc = await readProject(slug);
  if (!doc) throw new Error(`No such project: ${slug}`);
  const row = findRow(doc, target, id);

  /* A BOARD WITH BEATS IS A SEQUENCE, so generating it renders the sequence.
   *
   * Deliberately NOT a new action. The MV parity gate requires every dispatched
   * action to be reachable by a human, and this codebase has already shipped one
   * batch of agent-only capabilities that only a gate caught. Folding keyframes
   * into generate_asset means the Generate button a person already has produces
   * them, on both surfaces, with nothing new to wire and nothing to exempt.
   *
   * A single-beat board still renders one still, which is the old behaviour and
   * the right one — there is no move to interpolate across. */
  if (target === "board" && (row.shots || []).length >= 2) {
    return await generateBoardFrames(deps, slug, { id, seed });
  }

  /* ⚠ THE BOARD STILL WAS NOT SEEING `action`, AND action is the field the whole
   * contract is built around — bible.js calls it "REQUIRED, the most important
   * field" and the board editor labels it "this is the field that writes the
   * clip". The board got `boardPrompt` alone, one line of what the scene IS,
   * while the BEAT path two functions down has always composed
   * `${beat}. ${action}`. Two image paths, same job, different inputs.
   *
   * MEASURED on the first full board pass of these five videos: 5 of 15 boards
   * ignored their framing, all in the same direction. A shot written as "a tight
   * insert of two hands, no face, nothing above the wrists" rendered a full
   * torso with a face; a medium rendered as a wide. None of that instruction was
   * ever sent — it was sitting in `action`, unread.
   *
   * The shot metadata leads (it is the framing) and the action follows, which is
   * the beat path's own order. A board with no shots keeps exactly the old
   * behaviour. */
  const boardBase = (r) => {
    const sh = (r.shots || [])[0];
    if (!sh) return r.boardPrompt;
    const framing = [sh.shotType, sh.angle, sh.lensFeel, sh.lighting].filter(Boolean).join(", ");
    return `${r.boardPrompt}. ${framing ? framing + ": " : ""}${sh.action || ""}`.trim();
  };
  const base = target === "character" ? (row.sheetPrompt || row.description)
    : target === "background" ? (row.platePrompt || row.description)
    : target === "prop" ? (row.sheetPrompt || row.description)
    : boardBase(row);
  if (!base) throw new Error(`That ${target} has no prompt yet — commit the bible first, or write one.`);

  /* Boards inherit identity from the sheets they reference, by prominence.
   *
   * ⚠ MEASURED 2026-08-28, AND IT DOES NOT WORK THE WAY THIS READS. A character
   * sheet here is a multi-panel contact strip (see the 16:9 rule below), and
   * handing a whole strip to FLUX as an in-context reference makes it reproduce
   * THE STRIP — three panels, same composition — rather than compose the shot
   * boardPrompt asks for. The same prompt with refs off produced the correct
   * single frame with the character's look carried by the style bible alone.
   *
   * So this path needs a single-panel reference, not the sheet: crop one panel,
   * or render a portrait take alongside the strip. Until then `refs: false` on
   * a board is the option that produces a usable board, and the route now
   * forwards that flag. Left in place rather than silently disabled because the
   * mechanism is right and only the input is wrong. */
  let refImages = [];
  const refNames = [];
  /* Which of those references are OBJECTS. The legend below tells the model
   * what to take from each picture, and "take only the faces, hair and
   * clothing" is exactly wrong instruction for a car. */
  const refIsProp = [];
  /* ...and which are LOCATIONS. See the legend below: the sentence that stops a
   * character reference being copied wholesale also tells the model to throw
   * the background away, which is the opposite of what a location reference is
   * for. */
  const refIsBg = [];
  if (target === "board" && refs) {
    const names = [...(row.characterRefs || []), ...(row.backgroundRefs || []), ...(row.propRefs || [])]
      .sort((a, b) => (row.refProminence?.[b] ?? 0) - (row.refProminence?.[a] ?? 0));
    /* 10, matching the image graph's own cap (workflow.js: refs.slice(0, 10)).
     * The 6 here was arbitrary and it bit the stage that carries identity
     * hardest — boards are where the cast is composed. */
    for (const n of names.slice(0, 10)) {
      const prop = (doc.props || []).find((x) => x.name === n);
      const bg = doc.backgrounds.find((g) => g.name === n);
      const src = doc.characters.find((c) => c.name === n) || bg || prop;
      if (src?.imageFile) {
        refImages.push(await stageForComfy(slug, src.imageFile));
        refNames.push(src.name);
        refIsProp.push(Boolean(prop));
        refIsBg.push(Boolean(bg));
      }
    }
  }

  /* THE SINGLE-SUBJECT ANCHOR, and it fixes two bugs that looked unrelated.
   *
   * MEASURED 2026-08-28. A character sheet came back as a three-panel contact
   * strip and a board came back with the lead painted two and three times over —
   * five board takes, three of them duplicated. Neither was asked for: Vire's
   * sheetPrompt is null, so the prompt is the style bible (a ~1000-character
   * description of ONE person) followed by a one-line subject. A model handed a
   * long description of a person on a wide canvas, with nothing saying how many
   * of them there are, paints several.
   *
   * That mattered beyond looking wrong. The strip is what generateAsset then
   * hands FLUX as an in-context reference for a board, and a reference that is a
   * picture of three panels teaches it to draw three panels — which is the
   * reproduction failure recorded above. Anchoring the count fixes the sheet, the
   * board, and the reference in one line rather than three.
   *
   * Backgrounds are deliberately exempt: a plate has no subject to count, and
   * telling it "one figure" would put a person in an empty room. */
  /* Same rule on the single-still path: a one-beat board with an empty cast is
   * exactly where this was measured (sub-rosa scene 17). */
  const noCastStill = target === "board" && (row.characterRefs || []).length === 0 && !row.crowd;
  /* ⚠ SAY THE NUMBER, and say it FIRST.
   *
   * The anchor below already told a board that "each person appears exactly
   * once" and boards still came back doubled — measured on salt-and-static,
   * where 6 of 22 boards painted the lead twice: two Wrens in the car, two at
   * the diner door facing each other, two drinking coffee, two standing on the
   * road. Every clip built on those boards inherited the twin, because the board
   * IS the opening frame, so re-rolling the CLIPS could never have fixed it.
   *
   * "Each person appears exactly once" never states how many people there are.
   * It is a constraint on repetition, not a count, and a model reading a long
   * character description on a wide canvas can satisfy it with two different
   * people. Naming the number removes the ambiguity, and putting it at the FRONT
   * puts it where a long prompt has not yet buried it. */
  const castCount = target === "board" ? (row.characterRefs || []).length : 0;
  const countWord = ["no", "exactly ONE", "exactly TWO", "exactly THREE", "exactly FOUR"][castCount] || `exactly ${castCount}`;
  const anchor = target === "character"
    ? " A single figure, one person only, centred, alone in frame — one continuous photograph, not a contact sheet or a multi-panel layout."
    /* A PROP SHEET IS A REFERENCE PHOTOGRAPH OF ONE OBJECT. It has to be
     * legible enough to identify the thing again — three-quarter view, whole
     * object in frame, nothing else competing — and it must contain no person,
     * because it is fed back in as a reference and whoever is standing in it
     * will be composed into the scene alongside the object. */
    : target === "prop"
    ? " A single object, exactly one of it, three-quarter view, whole object in frame, centred against a plain uncluttered background, evenly lit reference photograph. No people anywhere in the frame."
    /* ⚠ COUNT THE LIMBS, not just the people.
     *
     * "each person appears exactly once" stopped the doubled-lead failure and
     * says nothing about what a single correct person is MADE of. Measured on
     * Bone Waffle across three different checkpoints: a three-armed figure with
     * its own gold cuff, hands with the wrong finger count, and — on all three
     * models, from the same prompt — a bone in each hand where one was asked
     * for.
     *
     * That last one is the lesson. It was not a model weakness: the board said
     * "a bone ... in both hands", which genuinely reads as one per hand, and
     * every model resolved the ambiguity the same wrong way some of the time.
     * Rewriting it as "ONE bone, not two, both hands on that same one bone"
     * gave 4 of 4 correct on the SAME checkpoint that had failed.
     *
     * So the anchor states the anatomy every frame needs, and the shot's own
     * action states the count of anything it asks a person to hold. */
    : target === "board"
      ? " One continuous photograph of a single moment — not a contact sheet, not split panels, and each person appears exactly once."
        + " Every person in frame has exactly two arms, two hands, five fingers on each hand, and two legs — no extra limbs and no extra fingers."
      : "";
  /* ⚠ SAY IT AT ZERO TOO, which is where it was needed most and never fired.
   *
   * This used to read `castCount > 0`, so countWord[0] — the string "no" — had
   * never once executed. The one board that most needs a count is the one with
   * an empty cast: 12 of salt-and-static's 22 boards carry no characterRefs,
   * and scene 11 ("the car rolls past the lit house") rendered a pedestrian
   * nobody asked for, standing in the road the car drives through.
   *
   * The empty-frame sentence below DID fire for that board — but it is appended
   * at the END, which is the position the comment above says does not survive a
   * long prompt. The strong slot was gated off for exactly the case it was
   * written for. Both now fire: the count opens the prompt, the negation closes
   * it. */
  /* ⚠ A COUNT IS NOT A POPULATION CAP, and saying it as one breaks any shot
   * with a crowd in it. castCount is the number of NAMED characters; "there is
   * exactly one person in this frame" is exactly right for a woman alone at a
   * piano and exactly wrong for "fifty thousand strangers and a countdown", or
   * for eleven neighbours carrying a boat down a lane. Caught while writing the
   * boards for those two songs rather than after rendering them.
   *
   * `crowd` keeps the anti-duplication intent — the doubled-Wren failure this
   * whole anchor exists for was one NAMED character painted twice — while
   * letting the frame hold as many unnamed people as the shot needs. */
  const countLead = target !== "board" ? ""
    : row.crowd
      ? (castCount
          ? `The ${castCount === 1 ? "named person" : `${castCount} named people`} below appear exactly once each; `
            + `beyond them this frame holds a crowd of other people. `
          : "This frame holds a crowd of people, none of them named. ")
      : `There ${castCount === 1 ? "is" : "are"} ${countWord} ${castCount === 1 ? "person" : "people"} in this frame. `;
  /* NAME THE REFERENCES, AND SAY WHAT TO DO WITH THEM.
   *
   * MEASURED 2026-08-28, twice. A board generated with a reference came back as
   * a near-copy of that reference — first of a three-panel contact sheet, then,
   * after the sheet was fixed to a single portrait, of the portrait: same alley,
   * same pose, same framing, none of them the shot the board describes.
   *
   * The reference was not the bug. The PROMPT was. FLUX.2's reference path is
   * in-context EDITING — it is built to keep the picture and change what you
   * name — and the board prompt named nothing, so "keep it" is the correct
   * reading of "here is a picture, and here is some scenery". personas.js has
   * always known the idiom ("put the character from image 1 into the scene from
   * image 2") and clipPrompt builds a `<Picture n> is <Name>` legend for H3;
   * board generation had neither. This gives it one. */
  /* WHAT TO TAKE DEPENDS ON WHAT IT IS. A person contributes a face; an object
   * contributes its shape and colour and nothing else. Telling FLUX to take
   * "faces, hair and clothing" from a photograph of a car is an instruction it
   * cannot follow, and an instruction that cannot be followed is one the model
   * resolves however it likes — which is the whole reason the car drifted. */
  /* ⚠ "DO NOT REUSE THEIR BACKGROUND" WAS BEING SAID TO A BACKGROUND REFERENCE.
   *
   * That closing sentence exists to stop a CHARACTER reference being copied
   * wholesale — pose, framing and all — and it was correct for that. But a
   * location reference is handed over precisely so the place comes back, and it
   * was being told, in the same breath, to discard it. Measured on Bone Waffle:
   * the cast came through perfectly and the set arrived as a generic pastel
   * kitchen with none of the candle-lit chaos in the reference.
   *
   * Each kind now gets the instruction that fits it, and the "everything else
   * is new" clause is scoped to the things it was written about. */
  const anyProp = refIsProp.some(Boolean);
  const anyBg = refIsBg.some(Boolean);
  const anyCast = refIsProp.some((x, i) => !x && !refIsBg[i]);
  const kindOf = (i) => (refIsProp[i] ? " (an object)" : refIsBg[i] ? " (a location)" : "");
  const legend = refNames.length
    ? refNames.map((n, i) => `Image ${i + 1} is ${n}${kindOf(i)}.`).join(" ")
      + (anyCast ? ` Take ONLY the faces, hair and clothing of the people from those images,`
          + ` and do not reuse their pose or framing.` : "")
      + (anyProp ? ` For the object images, keep the SAME object — same make, shape, era, colour and`
          + ` condition — and show exactly one of it.` : "")
      + (anyBg ? ` For the location image, keep the SAME place: the same set, props, dressing,`
          + ` colours and lighting. Stage this shot inside that location.` : "")
      + ` Compose a different shot from a different angle: `
    : "";
  /* THE LOOK AND THE CAST ARE TWO THINGS, and one field was carrying both.
   *
   * 02e1f50 stopped sending styleBible to a cast-less board, and was right to:
   * sub-rosa's carried a ~1000-character description of a woman, and "you
   * cannot negate a description, you can only withhold it". But the contract
   * (bible.js:34) asks styleBible for "ONE line of visual style — palette,
   * medium, era, lens character", and a bible that honours it has no person in
   * it to withhold.
   *
   * MEASURED on salt-and-static, whose styleBible is 154 characters reading
   * "1970s American noir on grainy 35mm — sodium-vapour amber against deep
   * blue night...". Every board with an empty cast — scenes 3, 8, 11, 17, 22,
   * which are precisely the shots that are JUST THE CAR — was rendered with
   * that line withheld, so the era went with it and the car came back a modern
   * silver sedan. Beside Wren, where the line survives, the same car is
   * period-correct. The vehicle was never drifting; the era was being deleted
   * from exactly the frames that had nothing else to hold it.
   *
   * So `lookBible` is the era-and-palette line that is ALWAYS sent, guaranteed
   * cast-free by contract. A document without one keeps 02e1f50's behaviour
   * unchanged — this cannot regress a bible whose style line hides a person. */
  const look = doc.lookBible || (noCastStill ? "" : doc.styleBible);
  const prompt = countLead
    + legend
    + (look ? `${look}. ${base}` : base)
    + (noCastStill ? " An empty frame — no people anywhere in it." : "")
    + anchor;

  const file = `image:mv_${slug}_${Date.now().toString(36)}`;
  const usedSeed = Number.isFinite(seed) ? Number(seed) : rollSeed();
  /* Character sheets are ALWAYS 16:9 regardless of the project aspect — the
   * website's rule, kept because a multi-panel reference sheet needs the
   * width. Everything else follows the project. */
  const wide = target !== "background" || (doc.brief?.aspectRatio || "16:9") !== "9:16";
  /* The picture engine, per project. `job.engine` wins over the library default
   * in art.js, so this is the whole mechanism — see brief.imageEngine. */
  const imgEngine = doc.brief?.imageEngine || undefined;
  const imgCkpt = doc.brief?.imageCheckpoint || undefined;
  requestArt(art, {
    file, title: `${doc.title} · ${row.name || target}`, kind: "cover", force: true,
    engine: imgEngine, checkpoint: imgCkpt,
    seed: usedSeed,
    video: {
      prompt,
      count: Math.min(Math.max(Number(count) || 1, 1), 4),
      width: wide ? 1344 : 768, height: wide ? 768 : 1344,
      refImages,
      safetyContext: castContext(doc, target === "board" ? boardCast(row) : [row.name]),
      safetyFlags: castFlags(doc, target === "board" ? boardCast(row) : []),
    },
  });
  /* HOW LONG IT TOOK, kept on the take.
   *
   * art.js computes a durationMs when a job finishes and emits it in an event —
   * nothing ever wrote it down, so "record the time for these flows" could only
   * be answered by subtracting adjacent run timestamps, which counts the gaps
   * BETWEEN renders as render time. Measured at the call site instead: it
   * survives whatever art.js does internally, and it is the number a person
   * actually means by "how long did that take". */
  const askedAt = Date.now();
  const { covers, safety } = await awaitArt(art, file, ["cover"]);
  const tookMs = Date.now() - askedAt;

  return updateProject(slug, async (doc2) => {
    const row2 = findRow(doc2, target, id);
    row2.takes = row2.takes || [];
    for (const name of covers || []) {
      const staged = await stageAsset(slug, path.join(config.outputDir, "images", name),
        // A prop sheet is not a board. Both are "not a character and not a
        // background", so the old two-way fallthrough filed every prop under
        // board_*.png — harmless to the code, confusing to anyone reading the
        // asset folder for the picture that is keeping a car the same car.
        target === "character" ? "char" : target === "background" ? "bg"
          : target === "prop" ? "prop" : "board");
      /* `safety`: the wordless minors fingerprint of what this take was drawn
       * from, which castFlags reads however the row's words change later. */
      row2.takes.push({ file: staged, seed: usedSeed, at: Date.now(), ms: tookMs,
                        ...(safety ? { safety: { minor: safety.minor === true, sexual: safety.sexual === true } } : {}) });
      if (!row2.imageFile) row2.imageFile = staged;   // first take auto-selects
    }
    row2.status = "rendered";
    /* A board that auto-selected its first take has just ADOPTED a picture, so
     * the same rule applies as for pick_take. A board that already had one has
     * adopted nothing — the redraw is sitting in takes waiting to be picked —
     * and refreshBoardStale correctly leaves the flag alone. */
    if (target === "board") refreshBoardStale(row2);
    /* ⚠ "board undefined: +1 takes" — visible in the Workflow activity list.
     * Characters, backgrounds and props have a `name`; a BOARD does not, it has
     * a scene index. The template asked every target for a name and printed
     * `undefined` for a third of them, in the one place a human reads to find
     * out what just happened. */
    const label = row2.name || (Number.isFinite(row2.clipIndex) ? `scene ${row2.clipIndex + 1}` : row2.id);
    noteRun(doc2, { tool: "generate_asset", outcome: `${target} ${label}: +${(covers || []).length} takes` });
    return doc2;
  });
}

/**
 * One keyframe per storyboard beat — the shot as a sequence, not a still.
 *
 * A board already describes its beats: 21 of sub-rosa's 24 carry exactly two
 * shots, and scene 1's are "a dried rose hangs from a brass ceiling hook" then
 * "the camera tilts down to find Vire sliding into the velvet booth beneath
 * it". That is a first frame and a last frame with a camera move between them,
 * written down and then thrown away — we rendered ONE picture for it and asked
 * the video model to invent the whole move.
 *
 * This renders each beat instead. The image model decides WHAT HAPPENS; the
 * video model only decides how to move between. It is the difference between
 * animating to key poses and hoping.
 *
 * THE CHAIN IS THE WHOLE TRICK, and it turns yesterday's defeat into the
 * mechanism. Beat 1 renders with NO reference, because that is the only way the
 * shot composes correctly — measured over five takes, references made every
 * board a copy of the reference's framing. Every later beat then references THE
 * PREVIOUS FRAME, where preserving framing is exactly what is wanted: same
 * people, same room, same light, one thing changed. FLUX.2's reference path is
 * in-context editing, and "the previous frame of this same shot" is the case it
 * is actually built for.
 *
 * SIX IS THE CEILING and it is measured, not chosen: videoGraphLtx takes one
 * opening frame, four waypoints and one closing frame, and the engine comment
 * records that denser guides ("27 guides over 121 frames") collapse the clip
 * into a crossfade of stills.
 */
export async function generateBoardFrames(deps, slug, { id, seed } = {}) {
  const { art } = deps;
  const doc = await readProject(slug);
  if (!doc) throw new Error(`No such project: ${slug}`);
  const row = findRow(doc, "board", id);
  const shots = (row.shots || []).slice(0, 6);
  if (shots.length < 2) {
    throw new Error(`Board ${row.name || id} has ${shots.length} beat(s) — keyframes need at least two. `
      + `Use generate_asset for a single still.`);
  }

  const wide = (doc.brief?.aspectRatio || "16:9") !== "9:16";
  const ANCHOR = " One continuous photograph of a single moment —"
    + " not a contact sheet, not split panels, and each person appears exactly once.";
  /** The beat, as a sentence: how it is shot, then what happens in it. */
  const beatOf = (sh) => [sh.shotType, sh.angle, sh.cameraMove, sh.lensFeel, sh.lighting]
    .filter(Boolean).join(", ");

  /* A SHOT WITH NO CAST MUST GET NO CAST.
   *
   * MEASURED on sub-rosa scene 17, whose board carries characterRefs: [] and the
   * prompt "Instrumental: pure abstraction — smoke and one crimson blade of
   * light". It rendered the lead standing in it. Same cause as the b-roll rose:
   * the style bible is a ~1000-character description of a person, and appending
   * it to an abstract shot puts that person in the abstract shot.
   *
   * Moving the beat to the front helped and was not enough — the bible still
   * describes someone, and a model given a description of someone tends to draw
   * them. An empty cast list is an explicit statement that nobody is in this
   * shot, so it is worth saying out loud rather than hoping the ordering wins. */
  /* YOU CANNOT NEGATE A DESCRIPTION, YOU CAN ONLY WITHHOLD IT.
   *
   * First attempt appended "No people, no figures, no hands — this shot contains
   * no person at all." to the cast-free shot. MEASURED: both takes still had the
   * lead in them, one of them three times. A ~1000-character description of a
   * woman followed by "no people" is a contradiction, and the description wins.
   *
   * The negative prompt is not available as an escape either — flux2 is a
   * distilled model sampled at cfg 1.0, where the negative branch is never
   * evaluated (see the engine notes in mcp.js). So the only lever that works is
   * to stop sending the character description for a shot that has no cast, and
   * let the board prompt carry the look on its own. */
  const noCast = (row.characterRefs || []).length === 0;

  const frames = [];
  const frameFlags = [];               // each beat's minors fingerprint, beside it
  let prev = null;
  let beatMs = 0;                      // the whole sequence, not one frame
  for (let i = 0; i < shots.length; i++) {
    const sh = shots[i];
    const beat = beatOf(sh);
    const action = String(sh.action || "").trim();
    const refImages = [];
    let prompt;
    if (i === 0) {
      /* No reference: the opening frame has to be the SHOT, and a reference
       * here reliably replaces the shot with a portrait. The bible carries the
       * look, which is enough inside one picture. */
      /* THE BEAT LEADS, and the bible follows as style.
       *
       * MEASURED: with the bible first, beat 1 of sub-rosa scene 1 — a b-roll
       * detail of a dried rose on a ceiling hook, with NO person in it — came
       * back as three copies of the lead. A ~1000-character description of one
       * woman in front of a one-line subject makes her the subject, and the
       * count anchor could not out-vote it.
       *
       * personas.js already wrote down why: "the model weights early tokens more,
       * and a character named after four clauses of scenery is a character in
       * the background". Same rule, applied the other way round — put the shot
       * first and the bible becomes what it claims to be, a STYLE bible. */
      prompt = `${beat}. ${action}`
        + ((doc.lookBible || (!noCast && doc.styleBible))
            ? ` Shot in this style: ${doc.lookBible || doc.styleBible}.` : "")
        + (noCast ? " An empty frame — no people anywhere in it." : "")
        + ANCHOR;
    } else {
      refImages.push(await stageForComfy(slug, prev));
      prompt = `Image 1 is the previous frame of this same continuous shot.`
        + ` Keep the same people, faces, hair, wardrobe, location and lighting exactly as they are in image 1.`
        + ` This is the next moment of that shot, so change ONLY what this beat describes: ${beat}. ${action}`
        + (noCast ? " An empty frame — no people anywhere in it." : "")
        + ANCHOR;
    }

    const file = `image:mv_${slug}_${row.id}_b${i}_${Date.now().toString(36)}`;
    const usedSeed = Number.isFinite(seed) ? Number(seed) + i : rollSeed();
    requestArt(art, {
      file, title: `${doc.title} · ${row.name || "board"} · beat ${i + 1}`, kind: "cover", force: true,
      engine: doc.brief?.imageEngine || undefined, checkpoint: doc.brief?.imageCheckpoint || undefined,
      seed: usedSeed,
      video: { prompt, count: 1, width: wide ? 1344 : 768, height: wide ? 768 : 1344, refImages,
               safetyContext: castContext(doc, boardCast(row)),
               /* Each beat after the first is drawn FROM the one before it. */
               safetyFlags: [...castFlags(doc, boardCast(row)), ...frameFlags] },
    });
    const beatAt = Date.now();
    const { covers, safety } = await awaitArt(art, file, ["cover"]);
    beatMs += Date.now() - beatAt;
    const made = (covers || [])[0];
    if (!made) throw new Error(`Beat ${i + 1} of ${row.name || id} produced nothing — check studio_status.`);
    const staged = await stageAsset(slug, path.join(config.outputDir, "images", made), "board");
    frames.push(staged);
    frameFlags.push(safety ? { minor: safety.minor === true, sexual: safety.sexual === true } : null);
    prev = staged;
  }

  return updateProject(slug, (doc2) => {
    const row2 = findRow(doc2, "board", id);
    /* The ordered keyframes. Kept separate from `takes` (which are ALTERNATIVES
     * for one still) because these are a SEQUENCE — order is meaning here, and
     * folding them into takes would lose it. */
    row2.shotFrames = frames;
    row2.takes = row2.takes || [];
    frames.forEach((f, i) => row2.takes.push({ file: f, seed: null, at: Date.now(), beat: true,
      ...(frameFlags[i] ? { safety: frameFlags[i] } : {}) }));
    row2.beatMs = beatMs;
    /* The opening beat stays the board's representative still, so every existing
     * reader (the grid, the clip's firstFrame fallback) keeps working. */
    row2.imageFile = frames[0];
    row2.status = "rendered";
    /* Keyframes ADOPT: the opening beat becomes the board's picture with nobody
     * picking it, so this is the moment a reference change is answered. Same
     * rule, same function. */
    refreshBoardStale(row2);
    noteRun(doc2, { tool: "generate_board_frames",
                    outcome: `${row2.name || id}: ${frames.length} keyframes` });
    return doc2;
  });
}

export async function pickTake(slug, { target, id, file }) {
  return updateProject(slug, (doc) => {
    const row = findRow(doc, target, id);
    /* Clip takes spell their file `clip` (generateClip has always pushed
     * { clip, seed, at }) and their pick is `clipFile` — the same loop as an
     * image take, in the vocabulary the timeline already reads. This is what
     * makes a vfx-polished import and a generated take interchangeable:
     * import_clip adds the take, this switches between them, and
     * build_timeline follows clipFile without knowing which kind won. */
    if (target === "clip") {
      const take = (row.takes || []).find((t) => (t.clip ?? t.file) === file);
      if (!take) throw new Error("No such take.");
      row.clipFile = file;
      row.status = "done";
      row.engine = take.imported ? "import" : (take.engine ?? row.engine);
      if (Number.isFinite(take.seconds)) row.durationSeconds = take.seconds;
      return doc;
    }
    if (!(row.takes || []).some((t) => t.file === file)) throw new Error("No such take.");
    row.imageFile = file;
    /* ADOPTING A REDRAW IS THE ANSWER TO `staleRefs`, and until this line
     * nothing anywhere was one. If the take just adopted was drawn after the
     * board's references last moved, the picture no longer predates them and
     * the map must stop saying it does. shot.js states the rule, both ways. */
    if (target === "board") refreshBoardStale(row);
    /* Changing a character's face makes every board built from it stale — the
     * website's attach cascade, kept because a board that silently shows the
     * OLD face is the kind of wrong nobody notices until the render. */
    if (target !== "board") {
      for (const b of doc.boards) {
        if ((b.characterRefs || []).includes(row.name) || (b.backgroundRefs || []).includes(row.name)) {
          markBoardRefsChanged(b);
        }
      }
    }
    return doc;
  });
}

/* ─────────────────────────────────────────────────────── clips (takes) */

/* THE PROMPT BUILDER MOVED to shot.js, whole and unchanged.
 *
 * It did not move for tidiness. A prompt a human can read but not edit is a
 * summary, and a prompt computed inside the renderer cannot be shown before the
 * render — which is why every DIRECTING.md failure reads "the board looked
 * correct and the render got something else". Next to the resolution it becomes
 * the thing itself: `resolveShot` returns the exact string, the inspector shows
 * it, an edit replaces it, and this function renders whatever came back. */

/**
 * Render one clip for a segment — with references AND the real soundtrack.
 *
 * Routing is the memo's rule: anything carrying NAMED identity references
 * renders on H3, and the song segment rides along frozen+anchored so a lyrical
 * shot lip-syncs the actual track.
 *
 * ⚠ THE OLD VERSION OF THIS COMMENT SAID "LTX has no reference input — a model
 * limit". THAT IS FALSE, and believing it cost 99 clips their cast. What LTX has
 * no input for is H3's `<Picture N>` NAMED multi-reference. It has always taken
 * an opening picture, and videoGraphLtx has always destructured firstFrame —
 * the main Video screen uses it. Below, a rendered storyboard becomes that
 * opening picture, which is how a clip gets its people on the licence-clean
 * engine without touching H3 at all.
 *
 * WHY THE BOARD AND NOT THE CAST SHEET. A sheet is a reference portrait; making
 * it frame 0 would open every shot on a mugshot. The board is already the
 * composed frame, and generateAsset renders it WITH the sheets attached as
 * references — so the identity work happens in the image engine, where
 * references are cheap, licence-clean and known to work. This just stops
 * throwing the result away.
 * keepAudio stays FALSE: the timeline supplies the song, and per-clip audio
 * would double against it at every cut.
 */
export async function generateClip(deps, slug, { segmentId, seed, loop: wantLoop, prompt: promptArg } = {}) {
  const { art } = deps;
  const doc = await readProject(slug);
  if (!doc) throw new Error(`No such project: ${slug}`);
  const seg = doc.segments.find((s) => s.id === segmentId || s.index === segmentId);
  if (!seg) throw new Error(`No such segment: ${segmentId}`);
  if (seg.mode !== "generate") throw new Error(`Segment ${seg.index} is set to ${seg.mode}.`);
  const board = doc.boards.find((b) => b.segmentId === seg.id || b.segmentIndex === seg.index);

  /* ⚠ EVERY DECISION BELOW USED TO BE MADE HERE, IN LINE, AND THEN DISCARDED.
   *
   * Which sheets resolved, in what order, which of the named refs reached the
   * render as nothing, which engine that implied, and the exact prompt text —
   * all of it was computed inside this function, used once, and never written
   * down. So "the board named three people and the clip has one" had no answer
   * anywhere on disk, which is the shape of nearly every failure DIRECTING.md
   * records.
   *
   * `resolveShot` is that same reasoning as a pure function of the document.
   * The inspector calls it to show a human what will be sent BEFORE the GPU is
   * spent; the staleness sweep calls it instead of the mirror it used to keep;
   * this calls it to actually render. One answer, three readers, no drift.
   *
   * `promptArg` is the hand-edited prompt for THIS render. resolveShot applies
   * the precedence (argument → the project's stored edit → the builder) and
   * reports which one won, so the take can record that too. */
  const plan = resolveShot(doc, seg.id, { prompt: promptArg });

  /* Staging is the one impure step and it stays here. IN ORDER: `<Picture 3>`
   * in the prompt is the third file in this array by construction, which is
   * what the legend promises and what used to be true only by coincidence. */
  const refImages = [];
  for (const r of plan.refs) refImages.push(await stageForComfy(slug, r.file));
  const refNames = plan.refNames;
  const { engine, useRefs, boardRefIndex } = plan;
  if (boardRefIndex >= 0) refImages.push(await stageForComfy(slug, board.imageFile));

  const usedSeed = Number.isFinite(seed) ? Number(seed) : rollSeed();
  const prompt = plan.prompt;
  /* THE KEYFRAMES, as first / waypoints / last.
   *
   * ⚠ `guided = !!endFrame` in videoGraphLtx: waypoints are SILENTLY DROPPED
   * unless a closing frame is given too, and without one the render also falls
   * back to the two-pass path that writes the opening picture into a HALF-SIZE
   * latent. That is why the first firstFrame test came back as a soft
   * re-imagining rather than a pin — one frame is the weakest possible use of
   * this input. A pair puts the whole clip on the full-size guided path.
   *
   * Four waypoints max, and the engine's own measurement is why: denser guides
   * ("27 guides over 121 frames") collapse the clip into a crossfade of stills. */
  const keyframes = (!useRefs && Array.isArray(board?.shotFrames) && board.shotFrames.length >= 2)
    ? await Promise.all(board.shotFrames.slice(0, 6).map((f) => stageForComfy(slug, f)))
    : null;
  const boardFrame = keyframes ? keyframes[0]
    : (!useRefs && board?.imageFile) ? await stageForComfy(slug, board.imageFile)
    : undefined;
  const lastFrame = keyframes ? keyframes[keyframes.length - 1] : undefined;
  const midFrames = keyframes ? keyframes.slice(1, -1).slice(0, 4) : undefined;
  /* A ONE-BEAT BOARD STILL GETS PINNED, by closing on the frame it opened on.
   *
   * MEASURED over the 24-scene sub-rosa re-render: 19 scenes had two beats and
   * took the guided path; the 3 with a single beat did not, and one of those
   * three (scene 10) came back as three figures, one of them plainly a
   * different, older person. The other two were fine — so this is not "unguided
   * always fails", it is "unguided is UNPROTECTED", and one in three is a rate
   * worth closing.
   *
   * videoGraphLtx already has the mechanism: `endFrame = loop ? (lastFrame ||
   * firstFrame) : lastFrame`, so asking for a loop with only an opening picture
   * closes the clip on that same picture and moves the whole render onto the
   * full-size guided path. The shot drifts out and settles back rather than
   * drifting away, which for a single held beat is the right behaviour anyway. */
  /* ⚠ AND IT COSTS MOTION, which the note above did not know yet.
   *
   * Measured since, with the flow gate: the guided path flags 88% of sub-rosa's
   * clips and 95% of salt-and-static's (mostly_still, slideshow, frozen_tail),
   * against 27% for the unguided clips of the other four projects. Mean flow
   * 0.10 guided against 0.22 unguided; still fraction 0.65 against 0.10. Pinning
   * the close does protect identity — but it also holds the shot still, and a
   * held shot is what "cut on the beat" was supposed to avoid.
   *
   * The two measurements are not equally strong. The identity case is n=3 with
   * one failure; the motion case is 46 clips. So the loop stays the DEFAULT
   * (identity is the harder thing to fix afterwards) and becomes refusable, so
   * the trade can be made per project instead of assumed for all of them.
   *
   * ── PAIRED TEST, five scenes re-rendered both ways ──────────────────────
   *
   *   scene   guided   unguided   ratio   guided still   unguided still
   *      1    0.060     0.194      3.2x       0.44           0.01
   *      6    0.080     0.105      1.3x       0.49           0.22
   *     11    0.051     0.120      2.3x       0.59           0.16
   *     17    0.059     0.136      2.3x       0.41           0.17
   *     22    0.083     0.088      1.1x       0.84           0.31
   *   flagged  5 of 5    2 of 5              mean 1.9x more motion unguided
   *
   * ⚠ AND THE RESOLUTION ARGUMENT DOES NOT HOLD. The note above says an
   * unpinned clip "falls back to a half-size two-pass path". It did not: every
   * unguided take came back 1920x1088 at 145 frames, the same as its pinned
   * pair, and rendered FASTER (224s against ~305s). So the pin costs roughly 3x
   * the motion and buys no pixels.
   *
   * Identity, checked by eye rather than by metric: no drift in the unguided
   * takes — first frame and last frame are the same woman, further away. The
   * one cast error found was in the BOARD, not the render: a rear-view-mirror
   * shot produced two non-matching faces of one character, and BOTH the pinned
   * and unpinned takes inherited it. A pin cannot protect against a first frame
   * that is already wrong, so that failure is not evidence for this default.
   *
   * The default is left alone anyway. Five scenes is not a mandate to change
   * what every project does, and identity is still the harder thing to repair.
   * This is written down so the next person changing it argues with numbers. */
  const loop = wantLoop === false ? false : (Boolean(boardFrame) && !lastFrame);
  const file = `clip:mv_${slug}_${seg.id}_${Date.now().toString(36)}`;
  /* Budget mode renders at the vendor's own 0.4-megapixel default. Measured on
   * this card: a 15 s scene at native 1344x768 costs ~45 min; at 864x480 the
   * pixel-frame product drops 2.6x and an overnight batch actually finishes.
   * "recommended"/"high" take native; per-scene re-rolls can upgrade later.
   * The tier table itself now lives in renderSize(), because the export has to
   * reach the same answer and a second copy would drift from this one. */
  const [aw, ah] = renderSize(doc);
  /* See `audioTrack` below. LTX always; H3 only off the reference path, or
   * where the board sings, or where the brief insists. */
  const songConditioned = engine === "ltx" || !useRefs || Boolean(board?.lipSync)
    || doc.brief?.songConditioning === "always";

  requestArt(art, {
    file, title: `${doc.title} · scene ${seg.index + 1}`, kind: "video", force: true,
    seed: usedSeed,
    video: {
      /* REFERENCES FORCE H3 because it is the only engine here that takes them —
       * but that is a very expensive default at high resolution: H3 at 1920x1088
       * costs roughly 28 minutes for five seconds against LTX's three, measured
       * on this rig. A project that asked for high quality and did not ask for
       * cast references should not be quietly moved onto the slow engine, so the
       * brief can opt out and keep its consistency in the prompt instead. */
      engine,
      prompt,
      seconds: Math.min(Math.max(seg.durationSec, 1), 15),
      width: aw, height: ah,
      /* A project may name a count, and the LoRA follows it in workflow.js, so
       * this is one number rather than two. Left on "default" it is the count
       * the speed-up files ON THIS DISK were made for (clipsteps.js
       * defaultClipSteps), with or without cast pictures. It was a literal 8,
       * which ran a 4-step file at 8 on a disk set up from the Models screen. */
      steps: clipStepsFor(doc.brief, { refs: useRefs }),
      /* Sample at the delivered size instead of half-then-upscale. Only reaches
       * LTX, and only matters on an UNGUIDED clip — a board-pinned one is
       * already single-pass at full size. See videoGraphLtx's note above lowW. */
      baseScale: doc.brief?.baseScale === "full" ? "full" : undefined,
      refImages: useRefs ? refImages : undefined,
      /* Only when this clip is NOT going to H3: H3 carries identity through its
       * own named references, and handing it a first frame as well would pin a
       * shot it is already conditioning properly. `boardFrame` is only set when
       * refImages is empty, so the two paths cannot both fire — but the engine
       * test is written out anyway, because the day someone changes that guard
       * this line should still be correct. */
      firstFrame: boardFrame,
      lastFrame,
      midFrames,
      loop,
      /* THE SONG UNDER THE CLIP — frozen into the AV latent and anchored on
       * the conditioning at frame 0 (workflow.js, "SOUNDTRACK"), on BOTH
       * engines. On LTX it is the parity path and stays. On H3's reference
       * path it travels where the brief's `songConditioning` is "always" or
       * the board sings (lipSync). NEW projects start on "always" since
       * 2026-09-24 (store.js blankProject): the REWIND A/B put the song under
       * every reference shot and the sung line followed the words (DIRECTING.md
       * §2). An older project keeps what it stored (no value reads as "auto").
       * The song's own render-time cost was never measured alone; the clip's
       * own audio is discarded either way (`keepAudio` below). */
      audioTrack: (doc.song?.file && songConditioned)
        ? { name: await stageSongForComfy(doc.song.file), start: seg.startSec }
        : undefined,
      keepAudio: false,
      /* Who is behind each <Picture n>, and the board still the clip may open
       * on — see castContext above. */
      safetyContext: [
        ...castContext(doc, board ? boardCast(board) : (doc.characters || []).map((c) => c.name)),
        ...(typeof board?.boardPrompt === "string" && board.boardPrompt.trim() ? [board.boardPrompt] : []),
      ],
      /* ...and what those pictures were drawn as, whatever their words say now. */
      safetyFlags: castFlags(doc, board ? boardCast(board) : (doc.characters || []).map((c) => c.name), { board }),
    },
  });
  const clipAt = Date.now();
  /* ⚠ 40 MINUTES WAS NOT ENOUGH, AND THE FAILURE MODE IS SILENT DATA LOSS.
   *
   * Measured on Bone Waffle scene 9: H3, bare model at 20 steps, 1920x1088,
   * 5 s of video — 34 minutes to reach 65%, so about 52 minutes for the clip.
   * The wait gave up at 40. ComfyUI does not stop when we stop listening: the
   * render finishes and writes the file, and then the updateProject below —
   * the code that actually records the clip on the project — never runs. The
   * artefact exists on disk and the project says the scene was never rendered.
   *
   * Two hours, because the ceiling should be "something is genuinely wrong",
   * not "this render is slower than the ones I happened to measure".
   *
   * ⚠ AND TWO HOURS WAS STILL A DEADLINE ON THE RECORD, NOT ON THE RENDER. The
   * same loss one size up: a card that spills into shared memory, or a clip
   * queued behind other renders (this clock starts at the REQUEST), passed two
   * hours, the wait gave up, and the scene was recorded as never rendered while
   * its file landed anyway. So the take is filed by ONE promise, whenever the
   * clip lands, with a day as the ceiling that means "something is genuinely
   * wrong"; the CALLER still waits two hours for it. Past that it is told the
   * scene is still rendering and will be filed when it lands, and it is, by
   * the same code, with the same evidence. Only a restart of the app before it
   * lands loses it: the listener lives in this process. */
  let waitedOut = false;
  const filed = (async () => {
    const { clip, seconds: ranSeconds, meta: clipMade } = await awaitArt(art, file, ["clip"], CLIP_LATE_CEILING_MS);
    const clipMs = Date.now() - clipAt;
    /* `clipMs` runs from the request to the finish, so it includes every job
     * queued ahead of this one. The art queue's own clock (the "clip" event's
     * `seconds`, from when this job started running) is the render alone — the
     * number a lender's minutes a day are charged in (collab/lending.js). */
    const runMs = typeof ranSeconds === "number" && Number.isFinite(ranSeconds) ? Math.round(ranSeconds * 1000) : null;
    const clipSafety = clipMade?.safety && typeof clipMade.safety === "object"
      ? { minor: clipMade.safety.minor === true, sexual: clipMade.safety.sexual === true } : null;

    return updateProject(slug, (doc2) => {
      const seg2 = doc2.segments.find((s) => s.id === seg.id);
      let row = doc2.clips.find((c) => c.segmentId === seg.id);
      if (!row) {
        row = { id: `c_${seg.id}`, segmentId: seg.id, clipIndex: seg.index,
                boardId: board?.id ?? null, mode: "generate", takes: [] };
        doc2.clips.push(row);
      }
      row.takes = row.takes || [];
      // The engine rides ON the take: once takes can be switched (pick_take
      // target "clip"), "which engine made the one that is playing" must survive
      // the switch — the row-level field alone forgets it.
      row.takes.push({ clip, seed: usedSeed, at: Date.now(), ms: clipMs, runMs,
                       engine,
                       ...(clipSafety ? { safety: clipSafety } : {}),
                       /* WHICH picture this take opened on, recorded for the same
                        * reason the seed and the engine are: without it, "why does
                        * scene 4 hold its face and scene 9 not" has no answer on
                        * disk. null is a real answer — it means text only. */
                       openedOn: boardFrame ? board.imageFile : null,
                       /* ⚠ THE EVIDENCE, PER TAKE — and this is the whole reason
                        * the take strip is worth keeping.
                        *
                        * `row.prompt` below has existed for a while and is
                        * OVERWRITTEN by the next render, so "keep the old take"
                        * kept the video and threw away the reason for it: switch
                        * back to take 2 and the project shows you take 5's
                        * prompt, which is worse than showing nothing because it
                        * looks like an answer.
                        *
                        * `refs` is the half that was never recorded anywhere. A
                        * board naming three people and a render receiving one is
                        * the failure DIRECTING.md keeps describing, and until now
                        * the fact was computed, used, and discarded inside this
                        * function. `refsMissing` is the same fact from the other
                        * side — the names that reached this render as nothing. */
                       prompt,
                       promptSource: plan.promptSource,
                       refs: plan.refs.map((r) => ({ name: r.name, kind: r.kind, file: r.file })),
                       /* ⚠ RESOLVED IS NOT THE SAME AS SENT, AND THE TAKE HAS TO
                        * SAY WHICH. `refs` above is what RESOLVED; the pictures
                        * are attached as `refImages: useRefs ? refImages :
                        * undefined`. On the 11 ltx projects in this library
                        * useRefs is always false, so every one of those takes
                        * recorded a list of sheets it was never handed — and the
                        * map drew each of them as a solid, carried edge from the
                        * cast row into the clip. One boolean is the difference
                        * between "this face is in that clip" and "this face was
                        * named at it over no attachment". */
                       refsSent: plan.refsSent,
                       refsMissing: plan.refsMissing.map((r) => ({ name: r.name, why: r.why })) });
      row.clipFile = clip;           // the newest take plays until someone picks
      row.status = "done";
      /* A render answers every reason the clip was stale. Leaving the list behind
       * would keep a repaired shot flagged forever. */
      delete row.staleWhy;
      /* AND THE SECOND HALF OF THE SAME SENTENCE. `staleRefs` lives on the BOARD,
       * not the clip, so deleting staleWhy left "Drawn before its references
       * changed" on the map beside a clip that had just re-rendered on the
       * redrawn picture. This is the moment the map is read, so this is where the
       * answer has to be current — and it clears only what it can prove, which is
       * a board whose adopted picture really is newer than its references. */
      refreshBoardStale(doc2.boards?.find((x) => x.id === board?.id) ?? null);
      row.prompt = prompt;
      row.engine = engine;
      row.openedOn = boardFrame ? board.imageFile : null;
      /* How many pictures actually steered this clip. 1 is the weak path, 2+ is
       * the guided one — and knowing which is the difference between "the face
       * drifted" and "the face drifted AND nothing was pinning it". */
      row.guidedBy = keyframes ? keyframes.length : (boardFrame ? 1 : 0);
      /* A looped single beat is pinned at BOTH ends by one picture — guided, but
       * from one source. Recorded distinctly so "why does this one breathe rather
       * than travel" has an answer that is not guesswork. */
      row.guideMode = keyframes ? "beats" : loop ? "loop" : boardFrame ? "open-only" : "none";
      row.durationSeconds = seg2?.durationSec ?? null;
      /* ⚠ THE SILENT DROP GETS SAID OUT LOUD, at the only moment anybody is
       * looking. A reference that resolved to nothing is not an error — you can
       * legitimately render before every sheet exists — but it is the single
       * most expensive thing to discover afterwards, and the run log is the one
       * place both surfaces already read. A hand-edited prompt is flagged for
       * the same reason: a scene that no longer follows its board should not
       * look identical to one that does. */
      const gone = plan.refsMissing.map((r) => r.name);
      noteRun(doc2, { tool: "generate_clip",
        /* ⚠ THE ENGINE AS A FIELD, not only as a word inside the sentence. The
         * measured estimate is a median of the gaps between these timestamps, and
         * a gap is a number about the engine that rendered the clip on its later
         * side — regen.js parses it out of the outcome for every document written
         * before this line, which is all of them. */
        engine,
        outcome: `scene ${seg.index + 1} → ${clip} (seed ${usedSeed}, ${engine}`
          + `, ${plan.refs.length} ref${plan.refs.length === 1 ? "" : "s"})`
          + (plan.promptSource !== "computed" ? " · hand-edited prompt" : "")
          + (gone.length ? ` · ⚠ ${gone.join(", ")} had no sheet and reached the render as nothing` : "")
          + (waitedOut ? ` · landed after the ${CLIP_WAIT_HOURS}-hour wait and was filed when it did` : "") });
      return doc2;
    });
  })();
  /* A late render that then fails, or is stopped, is said on the project too:
   * the caller that was told "still rendering" has gone. Before the deadline
   * the caller gets the error itself, so nothing is written twice. */
  filed.catch(async (err) => {
    if (!waitedOut) return;
    console.error(`  [mv] ${slug} scene ${seg.index + 1}: the clip still out past the ${CLIP_WAIT_HOURS}-hour wait was not filed: ${err?.message || err}`);
    await updateProject(slug, (d) => {
      /* Its own tool name, so the Activity headline says it was lost rather
       * than "still waiting" over a failure (web/runwords.js). */
      noteRun(d, { tool: "clip_late_lost",
        outcome: `scene ${seg.index + 1}: the render still out past the ${CLIP_WAIT_HOURS}-hour wait was not filed (${String(err?.message || err).slice(0, 160)})` });
      return d;
    }).catch(() => {});
  });
  /* `deps.clipWaitMs` is for a test, which cannot wait two hours. */
  const waitMs = Number(deps.clipWaitMs) > 0 ? Number(deps.clipWaitMs) : CLIP_WAIT_MS;
  return withinWait(filed, waitMs, async () => {
    waitedOut = true;
    /* The clock started at the REQUEST, so past it the clip may be rendering
     * or still waiting its turn (ComfyUI down, other renders ahead). Say
     * which, from the queue's own answer. */
    const where = art.current?.file === file ? "still rendering" : "still waiting in the queue";
    await updateProject(slug, (d) => {
      noteRun(d, { tool: "clip_late",
        outcome: `scene ${seg.index + 1} is ${where} after ${CLIP_WAIT_HOURS} hours; it is filed onto the scene when it lands` });
      return d;
    }).catch(() => {});
    return new Error(`Scene ${seg.index + 1} is ${where} after ${CLIP_WAIT_HOURS} hours. It has not been `
      + "dropped: Studio files it onto the scene when it lands, as long as the app keeps running "
      + "until then. The Activity list says when it does.");
  });
}

/**
 * The size the generator will actually render this project at.
 *
 * Extracted because buildTimeline needs the SAME answer. An export sized to
 * anything else either upscales the footage or throws pixels away, and a
 * hardcoded pair is right for exactly one tier and wrong for the other two —
 * which is what it was until a review caught it.
 *
 * The tiers are H3's native (1344x768) and LTX's real ceiling. ⚠ LTX FLOORS
 * each axis to floor(n/64)*64, which is why the high pair is 1088 and not 1080:
 * asking for 1080 silently returns 1024. So the 8 rows between 1080 and 1088 are
 * GENERATED CONTENT, not padding, and an export that crops to 1080 is discarding
 * real picture. Export at the rendered size.
 *
 * The sizes themselves are server/mv/sizes.js's one list now, which reads the
 * card tiers (Full size, Smaller size, Preview) out of server/h3tier.js beside the
 * two older values (budget, high). This stays the generator's own door to it.
 */
export function renderSize(doc) {
  return renderSizeOf(doc?.brief);
}

/* ───────────────────────────────────────────── the timeline handoff */

/**
 * Compose a REAL Studio project: every finished clip at its scene's exact
 * start, trimmed to the scene length, the song on the audio track. Items carry
 * `mvClipId` and the doc carries `mvProjectId` — the metadata that lets a
 * right-click in Studio regenerate a clip and lets the workflow read a human's
 * edits back. Per-item keys survive every Studio save; the doc-level key needs
 * the one-line projDoc() addition recorded in FORK_DELTA.md.
 */
export async function buildTimeline(deps, slug) {
  const { library } = deps;
  const doc = await readProject(slug);
  if (!doc) throw new Error(`No such project: ${slug}`);
  const done = doc.clips.filter((c) => c.clipFile);
  if (!done.length) throw new Error("No finished clips yet.");

  const items = [];
  for (const c of done.sort((a, b) => a.clipIndex - b.clipIndex)) {
    const seg = doc.segments.find((s) => s.id === c.segmentId);
    if (!seg) continue;
    items.push({
      id: 1000 + items.length,
      name: `scene ${seg.index + 1}`,
      src: `/api/clip/${encodeURIComponent(c.clipFile)}`,
      start: Number(seg.startSec.toFixed(3)),
      dur: Number(seg.durationSec.toFixed(3)),   // the fractional trim: rounded-up renders are cut back
      inPoint: 0,
      srcDur: c.durationSeconds || seg.durationSec,
      mvClipId: c.id,
    });
  }

  const [outW, outH] = renderSize(doc);
  const meta = library.meta.get(doc.song.file) || {};
  const songLen = doc.totalDurationSec || Number(meta.durationSeconds) || 60;
  const studioDoc = {
    v: 1,
    mvProjectId: doc.slug,
    tracks: [
      { id: 1, kind: "video", name: "Video 1", muted: false, solo: false, level: 1, items },
      { id: 2, kind: "audio", name: "Music", muted: false, solo: false, level: 1,
        items: [{ id: 2000, name: doc.song.title, src: `/api/audio/${encodeURIComponent(doc.song.file)}`,
                  start: 0, dur: songLen, inPoint: 0, srcDur: songLen }] },
    ],
    fx: { beat: "none", amount: 0.5, drift: 0, look: "none", vignette: 0.2 },
    vis: "off",
    /* MATCHED TO THE FOOTAGE, and derived rather than assumed.
     *
     * This was 1280x720 at 30fps while every clip renders 24fps — it threw away
     * pixels the render had paid for and resampled 24 into 30, juddering on
     * exactly the guided camera moves that cost the most GPU.
     *
     * Then it was hardcoded 1920x1080, which is right only for qualityMode
     * "high": the other tiers render 1344x768 and 864x480, and a 1080 export
     * would have UPSCALED both. renderSize() is the generator's own answer, so
     * the two cannot drift.
     *
     * The height is the rendered one (1088, not 1080). LTX floors each axis to
     * floor(n/64)*64, so those 8 rows are generated picture, not padding, and
     * cropping them is a real loss. writeRenderOpts() appends a matching option
     * to the size select when one is missing, so a non-standard height no longer
     * gets silently reset to 1280x720 by readRenderOpts(). */
    out: { w: outW, h: outH, fps: 24, mbps: 16, codec: "auto" },
    songTitle: doc.song.title,
    lrc: [],
    t: 0,
    beatCfg: { sens: 0.5, band: "bass", drive: "pulse", smooth: 0.35 },
    beatMult: 1, beatSync: true, visSize: 0.4, visOpacity: 0.7,
  };

  const name = `${doc.title} — video`.slice(0, 80);
  await updateProject(slug, (d) => { d.timelineProject = name; noteRun(d, { tool: "build_timeline", outcome: `${items.length} scenes → "${name}"` }); return d; });
  return { name, doc: studioDoc, scenes: items.length };
}

/* ───────────────────────────────────────────────── the relationship map */

/**
 * The crime board: every artefact as a node, every dependency as an edge, and —
 * the part that earns the name — every CONTINUITY BREAK the project is carrying
 * right now, computed rather than stored.
 *
 * WHY IT MOVED HERE WHOLE. There were two of these. This function answered
 * mv_crime_board for agents, and web/mvboard.js's mvBoardModel() built a second
 * graph from the same document for the page. They disagreed: neither drew
 * props, and only one of them knew about staleness. A map that omits the thing
 * the project keeps getting wrong is worse than no map, because it reads as
 * confirmation. So there is one builder, the page paints what it returns, and a
 * finding added here reaches both surfaces in the same edit.
 *
 * ⚠ AND IT DOES NOT DECIDE WHAT A SHOT RECEIVES — resolveShot does.
 * The first draft of this function re-derived "which references resolve" from
 * the board's own ref lists, which is a second copy of the renderer's rule and
 * would have drifted from it the first time either changed. It asks shot.js
 * instead, per scene, so the edge you see IS the picture the GPU will be
 * handed. That also buys a finding nothing else reports: a reference that
 * resolves perfectly well and is then thrown away by H3's nine-picture cap.
 *
 * FLAGS ARE DERIVED, NEVER STORED. A stored flag is a lie the moment somebody
 * renders a sheet; every one of these is recomputed on each read, so closing a
 * break makes it disappear with no bookkeeping.
 *
 * The findings are lint's findings — same rules, same words — because a person
 * who fixes what the map shows must not then be told something different by
 * mv_lint. What the map adds is that you do not have to READ it: a break is a
 * red node and a dashed edge, and the count sits on the bar.
 *
 * @returns {{
 *   lanes: {key:string,label:string}[],
 *   nodes: object[], edges: object[],
 *   breaks: {level:string,kind:string,where:string,msg:string,nodes:string[]}[],
 *   counts: object,
 * }}
 */
export function crimeBoard(doc) {
  const lc = (s) => String(s ?? "").trim().toLowerCase();
  const nodes = [], edges = [], breaks = [];
  const byId = new Map();
  const add = (n) => { n.flags = n.flags || []; nodes.push(n); byId.set(n.id, n); return n; };
  const flag = (n, f) => { if (n && !n.flags.includes(f)) n.flags.push(f); };
  /** A break names the nodes it is about, so the page can light them without
   *  re-deriving anything and an agent can act on it without a second read. */
  const brk = (level, kind, where, msg, ids = []) => {
    breaks.push({ level, kind, where, msg, nodes: ids });
    for (const id of ids) flag(byId.get(id), kind);
  };

  const scenes = doc.segments.filter((s) => s.mode === "generate");
  /* Scenes that resolve reference sheets the video model will not be given.
   * Counted here and said ONCE at the end: it is a property of the project's
   * engine choice, not news about any one shot.
   *
   * ⚠ TAKEN FROM THE PLAN, NOT FROM THE TAKES. `refsSent` only started being
   * recorded on takes with this change, so every clip already on disk in this
   * library would answer "unknown" — and a note that stays silent on 15 of 15
   * existing projects is not an honest limit, it is a limit that shows up for
   * new work only. The plan is the renderer's own reasoning about what the NEXT
   * render receives, and on an ltx project the answer is the same for every
   * clip that has ever run there. */
  const sceneRefsNotSent = [];

  /* ── the cast lanes, props among them ────────────────────────────────────
   * Prop sits BETWEEN character and background on purpose. DIRECTING.md's rule
   * is "props are cast"; putting the lane next to the cast is the cheapest way
   * to say so every time anybody looks at this. */
  const LANES = [
    { key: "character", label: "characters", rows: doc.characters || [] },
    { key: "prop", label: "props", rows: doc.props || [] },
    { key: "background", label: "backgrounds", rows: doc.backgrounds || [] },
  ];
  /* Name → node. Built in the SAME precedence rowFor() resolves a reference
   * with (character, then background, then prop) so that a duplicated name
   * lights up the row the renderer will actually use, not a different one. */
  const byName = new Map();
  for (const lane of LANES) {
    lane.rows.forEach((r, i) => add({
      id: `${lane.key}:${r.id || r.name}`, kind: lane.key, lane: lane.key, col: i,
      label: r.name, rowId: r.id || null,
      has: !!r.imageFile, file: r.imageFile || null, takes: (r.takes || []).length,
      status: r.status || (r.imageFile ? "rendered" : "pending"),
      usedIn: [],
    }));
  }
  for (const key of ["character", "background", "prop"]) {
    for (const n of nodes) if (n.kind === key && !byName.has(lc(n.label))) byName.set(lc(n.label), n);
  }
  /** Ghosts occupy real space in their lane — a missing thing that is only a
   *  line of text in a panel is a missing thing nobody looks at. */
  const ghostCols = { character: 0, prop: 0, background: 0 };
  const ghost = (lane, label) => {
    const id = `ghost:${lane}:${lc(label)}`;
    if (!byId.has(id)) {
      const base = (LANES.find((l) => l.key === lane)?.rows.length) ?? 0;
      add({ id, kind: lane, lane, col: base + ghostCols[lane]++, label,
            ghost: true, has: false, takes: 0, status: "failed", usedIn: [] });
    }
    return byId.get(id);
  };

  /* ── scenes: board, then clip ────────────────────────────────────────────── */
  for (const [col, seg] of scenes.entries()) {
    const where = `scene ${seg.index + 1}`;
    const board = doc.boards.find((b) => b.segmentId === seg.id || b.segmentIndex === seg.index);
    const clip = doc.clips.find((c) => c.segmentId === seg.id);
    const boardId = `board:${seg.id}`, clipId = `clip:${seg.id}`;
    /* The hand-written prompt stored against this scene, if any. It is what the
     * next render will send, and the map has never looked at it. */
    const savedPrompt = typeof clip?.promptOverride === "string" ? clip.promptOverride.trim() : "";

    /* WHAT THIS SHOT WOULD BE GIVEN IF IT RENDERED NOW. The renderer's own
     * answer, not an imitation of it. A malformed scene must not take the
     * whole map down with it — a map that fails to draw is the one moment you
     * most need it — so a throw becomes a break of its own. */
    let plan = null;
    try { plan = resolveShot(doc, seg.id); }
    catch (err) { brk("error", "unresolvable", where, `Cannot work out what this shot would receive: ${err.message}`, []); }
    if (plan?.refs.length && !plan.refsSent) sceneRefsNotSent.push(seg.index + 1);

    if (board) {
      add({ id: boardId, kind: "board", lane: "board", col, label: `board ${seg.index + 1}`,
            has: !!board.imageFile, file: board.imageFile || null,
            takes: (board.takes || []).length, group: col,
            status: (board.staleRefs || board.staleSegments) ? "stale"
              : board.imageFile ? "rendered" : "planned",
            shots: (board.shots || []).length });
      if (board.staleRefs || board.staleSegments) {
        brk("warn", "builtOnOld", where,
          "Drawn before its references changed — redraw it, or the clip inherits a face nobody picked.",
          [boardId]);
      }
      if (!(board.shots || []).length) {
        brk("warn", "noShots", where, "Board has no shots — nothing steers the camera.", [boardId]);
      }
    } else {
      brk("warn", "noBoard", where,
        "No storyboard — this scene falls back to a generic performance shot with every character as reference.",
        []);
    }

    /* The reference edges, drawn from the resolution rather than from intent.
     * Anchor them on the board when there is one and on the clip otherwise, so
     * a boardless scene still shows what it is pulling in. */
    const anchor = board ? boardId : clipId;
    for (const r of plan?.refs || []) {
      const tgt = byName.get(lc(r.name));
      if (!tgt) continue;
      tgt.usedIn.push(seg.index + 1);
      edges.push({ from: tgt.id, to: anchor, w: r.prominence ?? 0.5, type: tgt.kind, group: col });
    }

    /* ⚠ THE SILENT DROP, THE FAILURE THIS WHOLE MAP EXISTS FOR.
     *
     * A name on the board that reaches the render as nothing. Two causes and
     * they cost exactly the same thing, so both draw a broken edge: the row
     * does not exist at all (lint's error — upsertBoard refuses one, so a board
     * carrying it came from an older document or a renamed row), or the row
     * exists and has no rendered sheet (DIRECTING.md's "dropped in silence" —
     * the board looks correct, the render gets no picture, nothing says so). */
    for (const m of plan?.refsMissing || []) {
      const tgt = byName.get(lc(m.name));
      if (tgt) {
        tgt.usedIn.push(seg.index + 1);
        edges.push({ from: tgt.id, to: anchor, w: m.prominence ?? 0.5, type: tgt.kind,
                     group: col, broken: true, why: "no sheet" });
        brk("warn", "noSheet", where,
          `"${m.name}" is referenced here and has no rendered sheet — the render gets nothing for it `
          + "and re-invents it from the words. Render the sheet first.",
          [tgt.id, anchor]);
      } else {
        const g = ghost(m.kind || "prop", m.name);
        g.usedIn.push(seg.index + 1);
        edges.push({ from: g.id, to: anchor, w: 0.5, type: g.kind, group: col,
                     broken: true, why: "not declared" });
        brk("error", "undeclared", where,
          `References "${m.name}", which is not a declared character, background or prop. `
          + "The render drops it and invents whatever the sentence implies.",
          [g.id, anchor]);
      }
    }

    /* OVER THE CAP. A reference that resolved perfectly and was thrown away
     * because the engine takes nine pictures. Nothing has ever reported this:
     * it looks exactly like a scene that was never asked for the sheet. */
    for (const d of plan?.dropped || []) {
      const tgt = byName.get(lc(d.name));
      if (!tgt) continue;
      tgt.usedIn.push(seg.index + 1);
      edges.push({ from: tgt.id, to: anchor, w: 0.2, type: tgt.kind, group: col,
                   broken: true, why: "over the 9-picture cap" });
      brk("warn", "overCap", where,
        `"${d.name}" resolves but is dropped — this shot names more references than the engine takes, `
        + "and the least prominent go first. Lower another reference's prominence or split the shot.",
        [tgt.id, anchor]);
    }

    if (clip) {
      add({ id: clipId, kind: "clip", lane: "clip", col, label: `scene ${seg.index + 1}`,
            has: !!clip.clipFile, file: clip.clipFile || null, video: clip.clipFile || null,
            takes: (clip.takes || []).length, group: col,
            status: clip.status || (clip.clipFile ? "done" : "pending"),
            engine: clip.engine || null });
      if (board) edges.push({ from: boardId, to: clipId, w: 1, type: "board", group: col });
      if (clip.status === "stale") {
        brk("warn", "changed", where,
          "Rendered from an older board — regenerate it, or the cut carries a shot nobody approved.",
          [clipId]);
      }

      /* ── WHAT THE RENDER ACTUALLY RECEIVED ────────────────────────────────
       * Everything above is INTENT: what this shot would get if it ran now.
       * The take's own `refs`/`refsMissing` are the record of what the finished
       * file was handed, written at the moment it was resolved. So this is the
       * one row of the map that can say a clip ON DISK is missing its prop
       * rather than that it might be. Takes from before that record existed
       * carry neither field and stay silent rather than guessing. */
      const take = (clip.takes || [])[(clip.takes || []).length - 1];
      for (const m of take?.refsMissing || []) {
        const tgt = byName.get(lc(m.name));
        brk("error", "renderedWithout", where,
          `The clip on disk was rendered without "${m.name}" — re-rendering is the only way to get it in.`,
          [clipId, ...(tgt ? [tgt.id] : [])]);
      }
      /* Cast → CLIP. Reference edges have only ever reached the BOARD, which
       * quietly implies identity stops there — and on the H3 path it does not:
       * the sheets ride into the clip as named references. Drawing it is what
       * makes "re-picking this face invalidates these five clips" visible.
       *
       * ⚠ AND IT WAS DRAWN SOLID EVERY TIME, INCLUDING WHEN NOTHING WENT.
       * `carried: true` was a constant. generateClip attaches pictures only when
       * useRefs, which is false on all 11 ltx projects here — so on two thirds
       * of the library this map drew an unbroken line from a character's sheet
       * into a clip that was handed no picture at all. The shot inspector said
       * so in words; the map, the screen built to be read WITHOUT reading, said
       * the opposite.
       *
       * A take from before `refsSent` existed still has an honest answer,
       * because only H3 has a named-reference input: an ltx or imported take
       * cannot have carried a sheet whatever else it forgot to record. Anything
       * unknown draws BROKEN, which is the direction the house rule points —
       * the map must never draw as whole an edge the GPU was not handed. */
      const sent = typeof take?.refsSent === "boolean" ? take.refsSent : take?.engine === "h3";
      for (const r of take?.refs || []) {
        const tgt = byName.get(lc(r.name));
        if (!tgt) continue;
        edges.push({ from: tgt.id, to: clipId, w: sent ? 0.6 : 0.3, type: tgt.kind, group: col,
                     carried: sent, broken: !sent,
                     why: sent ? undefined : "named in the prompt, not handed to the video model" });
      }

      /* ── A PROMPT EDIT THE CLIP ON DISK NEVER HEARD ───────────────────────
       * The stored `promptOverride` is what the NEXT render will send. The
       * take's `promptSource` is what the LAST one was sent. "edited" or
       * "argument" means a hand-written prompt made this file; "computed" means
       * the builder did — so a saved override plus a computed take is a clip
       * rendered before the instruction it is now supposed to follow. Nothing
       * reported it: applyShotEdit marked only reference changes, so the scene
       * read status "done", staleReasons [] and zero breaks. */
      if (savedPrompt && take?.promptSource === "computed") {
        brk("warn", "promptNotUsed", where,
          "The saved prompt for this scene was written after the clip was rendered — the file on disk "
          + "came from the builder, not from the words now stored against it. Re-render, or the cut "
          + "carries a shot nobody asked for.",
          [clipId]);
      }
      if ((clip.staleWhy || []).includes("prompt")) {
        brk("warn", "promptChanged", where,
          "Its prompt was edited after this take was made. Re-render to hear it.",
          [clipId]);
      }
    }

    /* ── THE SAVED PROMPT ASKS FOR SOMETHING THE BOARD DOES NOT CARRY ───────
     * A hand-written prompt can name a declared, rendered asset while the board
     * references nothing of the kind — and then the render is told the words and
     * handed no picture, which is the silent drop with an extra step. Same
     * name-word matcher the lint uses, so the two cannot disagree. */
    if (savedPrompt) {
      const said = saidWords(savedPrompt);
      const carriedNames = new Set([...(board?.characterRefs || []), ...(board?.backgroundRefs || []),
                                    ...(board?.propRefs || [])].map(lc));
      for (const a of declaredAssets(doc)) {
        if (carriedNames.has(lc(a.name)) || !namesAsset(said, a.name)) continue;
        const tgt = byName.get(lc(a.name));
        brk("warn", "promptNamesUncarried", where,
          `The saved prompt names "${a.name}", which is a declared ${a.kind}${a.has ? " with a rendered sheet" : ""}, `
          + "and this board references it nowhere. The words go to the render and the picture does not — "
          + `add it to the ${a.kind} references of this scene.`,
          [clipId, ...(tgt ? [tgt.id] : [])]);
      }
    }
  }

  /* ── declared and never used ─────────────────────────────────────────────── */
  if (doc.boards.length) {
    for (const n of nodes) {
      if (n.ghost || !["character", "prop", "background"].includes(n.kind) || n.usedIn.length) continue;
      brk("warn", "neverUsed", n.label,
        n.kind === "prop"
          ? "Declared as a prop and referenced by no board. Either it belongs in propRefs on the scenes it appears in, or it is not cast."
          : "Declared and never referenced by any board.",
        [n.id]);
    }
  }

  /* ── the things the boards do not carry ──────────────────────────────────
   * The scan lives in bible.js so the lint and this map cannot drift apart.
   *
   * The two findings draw differently because they ARE different. An object
   * nobody declared has no row, so it arrives as a GHOST PROP — the map's whole
   * claim is that a break is visible without reading, and a car in eight scenes
   * with no row of its own has to take up space in the prop lane for that to be
   * true. An asset the boards NAME but do not reference already has a row, and
   * often a rendered sheet: what is missing is the edge, so a broken edge from
   * the real node to the real board is the honest picture. */
  const sceneCol = (n) => scenes.findIndex((s) => s.index + 1 === n);
  for (const u of undeclaredRecurring(doc)) {
    if (u.kind === "namedNotReferenced") {
      const tgt = byName.get(lc(u.name));
      for (const sceneNo of u.scenes) {
        const seg = scenes[sceneCol(sceneNo)];
        if (!tgt || !seg || !byId.has(`board:${seg.id}`)) continue;
        tgt.usedIn.push(sceneNo);
        edges.push({ from: tgt.id, to: `board:${seg.id}`, w: 0.3, type: tgt.kind,
                     group: sceneCol(sceneNo), broken: true, why: "named, not referenced" });
      }
      brk("warn", "namedNotReferenced", u.name,
        `Named in the text of ${u.scenes.length} board${u.scenes.length === 1 ? "" : "s"} `
        + `(${u.scenes.slice(0, 6).join(", ")}${u.scenes.length > 6 ? ", …" : ""}) and referenced by none `
        + `of them. It is a declared ${u.assetKind}`
        + (u.hasSheet ? " with a rendered sheet — the picture exists and the render is not being handed it"
                      : " with no rendered sheet, so nothing anywhere pins what it looks like")
        + `. List it in the ${u.assetKind} references of those scenes.`,
        [...(tgt ? [tgt.id] : []), ...u.scenes.map((n) => `board:${scenes[sceneCol(n)]?.id}`).filter((k) => byId.has(k))]);
      continue;
    }
    const g = ghost("prop", u.word);
    g.usedIn = u.scenes;
    for (const sceneNo of u.scenes) {
      const seg = scenes[sceneCol(sceneNo)];
      if (seg && byId.has(`board:${seg.id}`)) {
        edges.push({ from: g.id, to: `board:${seg.id}`, w: 0.5, type: "prop",
                     group: sceneCol(sceneNo), broken: true, why: "undeclared" });
      }
    }
    brk("warn", "undeclaredRecurring", "props",
      `A ${u.word} appears in ${u.scenes.length} scenes (${u.scenes.slice(0, 6).join(", ")}`
      + `${u.scenes.length > 6 ? ", …" : ""}) and no prop declares it. Each render invents its own, `
      + `so it is a different ${u.word} in every shot. Declare it, render its sheet, list it in propRefs. `
      + "(Wordlist heuristic: eight vehicle words and nothing else.)",
      [g.id]);
  }

  /* ── THE HONEST LIMIT, SAID ONCE, ABOUT THE WHOLE PROJECT ────────────────
   *
   * Half of this map is bookkeeping and it should say so. On an ltx project no
   * picture is handed to the video model at all: the sheets condition the BOARD
   * in the image engine, and the board image pinned as frame 0 is the only
   * thing that carries a face or an object into a clip. Every cast lane, every
   * prominence, every reference edge above the board line is a plan for the
   * still — and the map can go completely green while the GPU that made the
   * video was shown nothing but text and one picture.
   *
   * ⚠ ONE NOTE, NOT ONE PER SCENE. This is a property of the project's engine
   * choice; repeating it 22 times would bury the findings that are about a
   * specific shot, which is the failure mode the whole break list is written
   * against. It is a "note" rather than a warning because nothing here is
   * wrong — ltx is a legitimate, ten-times-cheaper choice — it is simply not
   * what the lanes above look like they are saying. */
  const engineMode = String(doc.brief?.videoEngine || "hybrid").toLowerCase();
  if (sceneRefsNotSent.length) {
    const list = [...new Set(sceneRefsNotSent)].sort((a, b) => a - b);
    brk("note", "sheetsNotSent", "this project",
      `${list.length} scene${list.length === 1 ? "" : "s"} `
      + `(${list.slice(0, 8).join(", ")}${list.length > 8 ? ", …" : ""}) `
      + `resolve${list.length === 1 ? "s" : ""} reference sheets that are named in the prompt and never `
      + "handed to the video model. "
      + (engineMode === "ltx"
          ? "This project is set to the ltx engine, which has no named-reference input at all, so no clip "
            + "here will ever receive one: the sheets reach the video only through the BOARD image, which "
            + "is pinned as frame 0. Redrawing a stale board is the only way to get a new face or a new "
            + "prop into a shot."
          : doc.brief?.castRefs === false
            ? "This project has cast references switched off, so the sheets reach the video only through "
              + "the board image pinned as frame 0."
            : `${list.length === 1 ? "That scene carries" : "Those scenes carry"} no named cast, so `
              + `${list.length === 1 ? "it renders" : "they render"} on ltx, which has no named-reference `
              + "input — their sheets reach the video only through the board image pinned as frame 0.")
      + " The cast lanes above are a plan for the STILL, not a record of what the video was given.",
      []);
  }

  /* A scene is listed once per finding, not once per reference: "scenes 3, 4, 8"
   * on one line is a pattern, eight separate lines are a wall. */
  for (const n of nodes) if (Array.isArray(n.usedIn)) n.usedIn = [...new Set(n.usedIn)].sort((a, b) => a - b);

  /* Order matters to a reader: an error is already wrong, a warning will be, and
   * a note is neither — it is the thing the rest of the picture does not say.
   * Stable within a level, so the list does not reshuffle between two reads of
   * an unchanged project. */
  const RANK = { error: 0, warn: 1, note: 2 };
  breaks.sort((a, b) => (RANK[a.level] ?? 9) - (RANK[b.level] ?? 9));

  return {
    lanes: [...LANES.map(({ key, label }) => ({ key, label })),
            { key: "board", label: "boards" }, { key: "clip", label: "clips" }],
    nodes, edges, breaks,
    counts: {
      characters: (doc.characters || []).length, props: (doc.props || []).length,
      backgrounds: (doc.backgrounds || []).length,
      boards: doc.boards.length, scenes: scenes.length,
      clipsDone: doc.clips.filter((c) => c.clipFile).length,
      /* A note is not a break — nothing about it is wrong — so it is counted
       * apart. `breaks` here is what a human should act on. */
      breaks: breaks.filter((b) => b.level !== "note").length,
      errors: breaks.filter((b) => b.level === "error").length,
      notes: breaks.filter((b) => b.level === "note").length,
    },
  };
}
