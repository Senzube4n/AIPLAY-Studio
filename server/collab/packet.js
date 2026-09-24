/**
 * Collaboration — WHAT LEAVES THIS MACHINE.
 *
 * Two units go out, and they are deliberately not the same size:
 *
 *   shotPacket()     what a person LENDING A GPU receives. One scene. The
 *                    prompt that scene needs, the pictures that scene names or
 *                    is guided by, the size, the engine and the step count.
 *                    Nothing else: not the song, not the lyrics, not the other
 *                    forty-three scenes, not the plan, not the bibles as
 *                    readable fields, not even the project's title.
 *   projectBundle()  what a COLLABORATOR receives. The whole document and a
 *                    manifest of the asset files it refers to, because a
 *                    collaborator is directing, and you cannot direct blind.
 *
 * That split is the owner's answer to the only question this module really
 * asks: "how much of my script does this person have to read in order to help
 * me?" A collaborator, all of it. A lender, one scene.
 *
 * ⚠ ONE SCENE IS ENOUGH ONLY IF EVERY INPUT TO THE RENDER TRAVELS WITH IT, AND
 * THAT LIST IS LONGER THAN IT LOOKS. An earlier version of this header claimed a
 * clip render was "a pure function of prompt, size, engine, seconds, seed and a
 * list of pictures". It is not, and the claim cost real fidelity:
 *
 *   steps      generate.js sends `doc.brief.videoSteps` (default: the count
 *              matched to the speed-up files on the OWNER's disk, which says
 *              nothing about the lender's, so a lend left on default asks for
 *              the usual 8; see DEFAULT_STEPS), and the
 *              step count SELECTS THE DISTILLATION LoRA in workflow.js — 4 and
 *              8 are different turbo LoRAs and 20 is the bare model with none.
 *              Projects on this disk are split 4 / 8 / 20 (porcelain is at 20).
 *              A packet that said `engine: "h3"` and nothing else let a lender's
 *              Studio fall back to 8 and render a different clip, at a cost the
 *              packet's own note then described wrongly in both directions.
 *   baseScale  `brief.baseScale === "full"` moves an UNGUIDED LTX clip off the
 *              half-then-upscale path. Same render request, different sampler.
 *   guides     the opening / waypoint / closing frames LTX is pinned with. See
 *              the warning above `guides` below; this one shipped as a silent
 *              picture-less render on 97 of the corpus's 353 boarded scenes.
 *
 * So all four now travel as fields, and `note` says the ones a human needs to
 * read out loud. The song does NOT travel and that is not an omission: the
 * audio track generateClip freezes into the AV latent is the owner's unreleased
 * record, and a lent clip is expected to come back to be laid against it here.
 *
 * ⚠ THE RECEIVING STUDIO WILL PREPEND ITS OWN STYLE BIBLE IF YOU LET IT. This
 * is the trap the whole file is arranged around. server/mv/shot.js's
 * clipPrompt() opens every clip prompt with `doc.styleBible + "."`
 * unconditionally — that is a documented defect in its own right (one
 * character-sheet line in a style bible poisoned all 34 clips of a project) —
 * and a lender's Studio composing a prompt from a packet would do exactly the
 * same thing with THEIR bible, or with an empty one. So the prompt in a shot
 * packet is COMPOSED HERE, by the owner, and arrives FINISHED. The receiving
 * side renders the string it was given and prepends nothing. That is also why
 * the bibles are not sent as fields: a field invites recomposition, and the
 * only correct number of places a prompt is assembled is one.
 *
 * ⚠ AND THAT MEANS A SECOND COPY OF THE PROMPT ASSEMBLY LIVES HERE. It is a
 * copy of server/mv/shot.js's clipPrompt() and it will drift from it; the
 * repository has already been bitten once by a mirrored resolution (regen.js's
 * `refsNow` silently lost propRefs and reasoned about a clip nobody would
 * make). It is a copy on purpose for two reasons that outweigh that risk.
 * First, this module is allowed to import node builtins and ../config.js and
 * nothing else — it must not drag the MV routes, the store, the art queue or
 * the library into the code path that answers a stranger's network request.
 * (Two pure helpers are the exception: ../mv/sizes.js, one list, because a
 * copy of a list is the drift this paragraph warns about, reading only
 * ../h3tier.js, pure too; and ../safety/lineage.js, the minors fingerprint a
 * lender's check reads, which reads only ../safety/minors.js.)
 * Second, a packet is a WIRE FORMAT: a packet written last month has to still
 * mean what it said, and it says a finished string rather than a recipe for
 * one, so a later change to clipPrompt cannot retroactively change what a
 * friend rendered. If you change clipPrompt, this file does not automatically
 * follow, and that is the intended behaviour rather than an oversight.
 *
 * The copy is currently byte-for-byte against clipPrompt on all 353 boarded
 * scenes on this disk, INCLUDING the `brief.boardRef: true` branch — which no
 * project on disk sets, so it is verified synthetically rather than by corpus.
 * The one knowing divergence: the contract named a `boardPrompt` field, and
 * clipPrompt does not read one, so fidelity to the renderer won over fidelity
 * to the contract's wording. Fidelity to the renderer is the point of the copy.
 *
 * ⚠ DEVIATIONS FROM THE CONTRACT'S FIELD LIST, all additive except the third:
 *   `steps`, `baseScale`, `guides`, `loop`   the render inputs above.
 *   `promptSource`                           "computed" or "edited", so the
 *                                            receiver can see whether the
 *                                            owner hand-wrote this prompt.
 *   `mode` MEANS WHAT IT MEANS EVERYWHERE ELSE IN THIS REPO. Next to a
 *   `segmentId`, `mode` is `generate`/`skip` — that is `seg.mode`,
 *   `doc.clips[].mode` and resolveShot's `mode` alike. This file used to put
 *   the PROJECT'S ENGINE MODE ("hybrid") there, so an author writing
 *   `packet.mode === "skip"` against the rest of the codebase read "hybrid" and
 *   got a wrong answer with no error. The engine mode is `engineMode`, which is
 *   also resolveShot's spelling for it.
 *
 * NOTHING HERE IS ENCRYPTED, SIGNED OR SENT. This module builds plain objects
 * and reads files to hash them. Sealing is server/collab/seal.js's job, the
 * peer's identity is server/collab/identity.js's, and permission is
 * server/collab/roster.js's. A packet is data; it carries no authority.
 */
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { projectRowFingerprint } from "../safety/lineage.js";
import { renderSizeOf } from "../mv/sizes.js";

/* ─────────────────────────────────────────────────────── refusals */

/**
 * Every throw in this file carries a machine-readable `reason` and a
 * human-readable sentence saying what to do next. The reasons named in the
 * collaboration contract are `no-such-segment`, `no-board` and `no-refs`;
 * `bad-arguments` is added for the caller's own mistakes, because a route that
 * forgot to pass `assetsDir` should be told that rather than being handed a
 * confusing ENOENT from the hashing step several dozen lines later.
 *
 * Two more were added for the same reason — a wrong reason is a wrong
 * instruction to whoever reads it:
 *   `no-guide`          a picture this scene's render is PINNED to is missing.
 *                       Not `no-refs`: no named reference is involved, and the
 *                       fix is to re-render the storyboard, not a cast sheet.
 *   `asset-unreadable`  a file the assets folder listed a moment ago could not
 *                       be read while a BUNDLE was being hashed. Nobody named
 *                       it in a scene and nobody passed a bad argument; the
 *                       folder changed underneath the run.
 */
function refuse(reason, message) {
  const err = new Error(message);
  err.reason = reason;
  return err;
}

/* ─────────────────────────────────────────────────────── local lookups
 *
 * Deliberate duplicates of server/mv/shot.js's helpers, for the import rule
 * given at the top. They are three lines each and they are exercised against a
 * real 44-scene document in the verification below. */

/**
 * THE COLLAB PROTOCOL NUMBER, and the one thing it is for.
 *
 * Every packet carries it. Two Studios can work together when they agree on it,
 * and that is a different question from which BUILD each is running: the app's
 * version moves whenever anything ships, this moves only when the shape of a
 * packet or the rules around it change. server/version.js reports both and
 * keeps them apart on purpose.
 *
 * Bumping it: change it here, and say in VERSIONING.md what an older client
 * does with a newer packet.
 */
export const PACKET_V = 1;

/** Segment by id, then by 0-based index — the two spellings every route takes. */
const findSegment = (doc, segmentId) =>
  (doc.segments || []).find((s) => s.id === segmentId)
  || (doc.segments || []).find((s) => String(s.index) === String(segmentId))
  || null;

const findBoard = (doc, seg) => (doc.boards || []).find(
  (b) => b.segmentId === seg.id || b.segmentIndex === seg.index) || null;

const rowFor = (doc, name) =>
  (doc.characters || []).find((c) => c.name === name)
  || (doc.backgrounds || []).find((g) => g.name === name)
  || (doc.props || []).find((p) => p.name === name)
  || null;

const declaredKind = (doc, name) =>
  (doc.characters || []).some((c) => c.name === name) ? "character"
  : (doc.backgrounds || []).some((g) => g.name === name) ? "background"
  : (doc.props || []).some((p) => p.name === name) ? "prop"
  : null;

/* H3's named-reference input takes nine pictures. Mirrors REF_CAP in
 * server/mv/shot.js; a packet that carried ten would be asking a lender to run
 * a render this house has never run. */
const REF_CAP = 9;

/* What a lend asks for when the owner's brief names no count, and what `note`
 * compares against to warn a human that this scene is NOT at it.
 *
 * ⚠ NOT THE OWNER'S MATCHED COUNT. At home a brief left on default runs the
 * count the speed-up files on the OWNER's disk were made for
 * (server/mv/clipsteps.js). That count describes the wrong machine for a lend:
 * a borrower with no H3 files at all works out 4, and a lender with the 8-step
 * reference file would then run a scene with cast on its 4-step file, a
 * downgrade nobody chose. So a lend left on default asks for the usual 8, as
 * it always has, and the lender's own accept check (lending.js speedUpCheck)
 * says when 8 does not match the files on the lender's PC. An owner who wants
 * another count names it in the brief or pins it on the order. */
const DEFAULT_STEPS = 8;

/**
 * The delivered size, per quality tier: server/mv/sizes.js, the one list
 * generate.js renders from too (it used to be a copy here, and a copy of a
 * list that grew the card tiers would have sent lenders the old sizes). The
 * reason its numbers look wrong is worth repeating here where a lender will
 * read them: ⚠ LTX floors each axis to floor(n / 64) * 64, so the tall pair is
 * 1088 and not 1080 — asking for 1080 silently returns 1024. Those 8 rows are
 * generated content, not padding. A lender who "corrects" the height to 1080
 * returns a smaller render than the owner asked for.
 */
const renderSize = (doc) => renderSizeOf(doc?.brief);

/**
 * Hash one asset file and measure it.
 *
 * The hash is what makes a packet self-checking: the lender's Studio can say
 * "I already hold this exact picture" and skip the transfer, and can refuse a
 * picture whose bytes do not match what the prompt was written against. sha256
 * over the whole file, hex, because the file is a character sheet of a few
 * hundred kilobytes and there is no measurement here suggesting anything
 * cheaper was ever needed.
 *
 * `describe(file, code)` builds the sentence, because the three callers are in
 * three different situations — a named cast reference, a pinned guide frame,
 * and a bundle file the folder listing just promised — and one sentence
 * describing all three is a sentence that is wrong twice.
 *
 * ⚠ joinAsset IS CALLED OUTSIDE THE try, AND THAT IS THE WHOLE POINT OF THE
 * LINE. It used to be the first statement inside it, so its traversal refusal —
 * a `bad-arguments` throw with a carefully written sentence about document rows
 * holding bare file names — was caught two lines later and re-thrown as the
 * caller's reason with an ENOENT-shaped sentence. A document row holding ".."
 * was reported to the owner as `no-refs`, as a "reference picture" that "could
 * not be read", advising them to "re-render that sheet" for a string that is
 * not a file name at all. The refusal still fired; it just never said why. Do
 * not fold this line back into the try to save a variable.
 */
async function hashAsset(dir, file, reason, describe) {
  const full = joinAsset(dir, file);
  let bytes;
  try {
    bytes = await readFile(full);
  } catch (e) {
    throw refuse(reason, describe(file, e.code || e.message));
  }
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

/* ⚠ A STORED FILE NAME IS A NAME, NOT A PATH. Asset rows hold a bare basename
 * ("char_b53962174086.png") and nothing in the document should ever hold a
 * traversal — but this is the one function in the collaboration code that turns
 * a string from a DOCUMENT into a path that gets read, and a document can also
 * arrive from a peer. So the name is reduced to its last segment on both
 * separators before it is joined, and a name that survives that as empty or as
 * a parent reference is refused rather than read. path.join is not used: it
 * would happily normalise "../../secrets" into an escape. */
function joinAsset(dir, file) {
  const base = String(file).split(/[\\/]/).pop();
  if (!base || base === "." || base === "..") {
    throw refuse("bad-arguments",
      `"${file}" is not a usable asset file name. Asset rows hold a bare file name; `
      + `fix the document row that holds this value.`);
  }
  return `${dir}${dir.endsWith("\\") || dir.endsWith("/") ? "" : "/"}${base}`;
}

/* ─────────────────────────────────────────────────────── the prompt */

/**
 * The clip prompt, composed by the owner, finished.
 *
 * Kept in the same ORDER as server/mv/shot.js's clipPrompt — style, legend,
 * scene beats, grade — so that a clip a friend renders and a clip the owner
 * renders are prompts of the same shape and can be compared honestly. The
 * 4800-character cap is that function's cap, for the same reason.
 *
 * ⚠ THE PICTURE LEGEND IS ONLY TRUE WHEN PICTURES ARRIVE. `attached` is false
 * for a scene that resolved no cast: it renders on LTX, which has no
 * named-reference input, and a "<Picture 1> is …" sentence over no attachment
 * is worse than silence because the model spends attention resolving a
 * reference nobody handed it. The names still go, in plain words, because
 * dropping them entirely is what made every scene invent a different performer.
 *
 * `boardRefIndex` is the storyboard-as-reference branch (`brief.boardRef`). It
 * is carried even though no project on disk enables it, because omitting it was
 * a LATENT drift: the owner's prompt gains a "Use <Picture N> for the
 * composition" sentence, the packet's did not, and the day somebody ticks that
 * box every lent clip would quietly be composed from a different instruction.
 */
function composePrompt({ doc, seg, board, refNames, attached, boardRefIndex = -1 }) {
  const bits = [];
  if (doc.styleBible) bits.push(doc.styleBible + ".");
  const list = (xs) => (xs.length <= 1 ? (xs[0] || "")
    : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  const legend = !refNames.length ? ""
    : attached
      ? refNames.map((n, i) => `<Picture ${i + 1}> is ${n}.`).join(" ") + " "
        + (boardRefIndex >= 0
            ? `Use <Picture ${boardRefIndex + 1}> for the composition, framing, staging and lighting `
              + `of this shot. It is a STILL reference, not the first frame — the shot must move `
              + `and the subject must perform the action below, not hold that pose. `
            : "")
      : `In this shot: ${list(refNames)}. Keep each one exactly as the style above describes, `
        + `identical in every scene. `;
  const beats = board.shots.map((s, i) =>
    `${i + 1}. ${[s.shotType, s.angle, s.cameraMove, s.lensFeel, s.lighting].filter(Boolean).join(", ")}: ${s.action}`);
  bits.push(`${legend}SCENE (${Number(seg.durationSec).toFixed(1)}s): ${beats.join(" ")}`);
  if (board.grade) bits.push(board.grade);
  return bits.join(" ").slice(0, 4800);
}

/* ─────────────────────────────────────────────────────── the shot packet */

/**
 * One scene, for somebody lending their GPU.
 *
 * @param opts.doc        a parsed MV project.json.
 * @param opts.segmentId  a segment id ("s1_0") or a 0-based index.
 * @param opts.assetsDir  the project's assets folder — store.js's assetsDir(slug).
 *
 * WHAT IS NOT IN HERE, and why each one was left out:
 *   the song, the lyrics       a lender is rendering pictures; the audio is the
 *                              owner's unreleased record. generateClip freezes
 *                              the track into the AV latent HERE, when the clip
 *                              comes home.
 *   the other scenes           the whole point of the unit.
 *   the plan and the runs      an operational history of the owner's machine.
 *   styleBible, lookBible      composed into `prompt` instead — see the header.
 *   the project title          it is the thing the owner has not announced yet.
 *
 * ⚠ THIS IS NOT A REDACTION ENGINE. Board prose is written by a director, and a
 * shot action that quotes the sung line will carry that line into the packet
 * because the director put it there. What this function guarantees is that
 * NOTHING IT ADDS comes from outside the one scene. The boardless branch of
 * clipPrompt quotes `seg.thesisLine` outright — which is precisely why a
 * missing board is a refusal here rather than a fallback. describePacket() is
 * written to promise only what this paragraph can keep.
 */
export async function shotPacket({ doc, segmentId, assetsDir } = {}) {
  /* Refusals first; each costs nothing and none of them touches the disk. */
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.segments)) {
    throw refuse("bad-arguments",
      "Pass the parsed project.json as `doc`. Read it with readProject(slug) first.");
  }
  if (segmentId === undefined || segmentId === null || segmentId === "") {
    throw refuse("bad-arguments",
      "Pass the scene to lend out as `segmentId` — either its id (\"s1_0\") or its 0-based index.");
  }
  if (typeof assetsDir !== "string" || !assetsDir) {
    throw refuse("bad-arguments",
      "Pass the project's assets folder as `assetsDir` — assetsDir(slug) from server/mv/store.js. "
      + "The packet has to hash the reference pictures, so it needs to find them.");
  }

  const seg = findSegment(doc, segmentId);
  if (!seg) {
    throw refuse("no-such-segment",
      `This project has no scene "${segmentId}". It has ${doc.segments.length} scenes, `
      + `numbered 0 to ${doc.segments.length - 1}; pass one of their ids or its index.`);
  }

  const board = findBoard(doc, seg);
  if (!board || !Array.isArray(board.shots) || !board.shots.length) {
    throw refuse("no-board",
      `Scene ${seg.index + 1} has no board with shots on it, so there is no shot to describe. `
      + `Board it first (the workflow's board step), then lend it out. `
      + `A boardless scene cannot be lent even as a fallback: the fallback prompt quotes the `
      + `sung line, and a lender does not receive lyrics.`);
  }

  /* The board's cast by prominence — characters, then backgrounds, then props,
   * the same order the renderer stages them in, because `<Picture 3>` in the
   * prompt has to be the third file in `refs` by construction rather than by
   * coincidence. */
  const wanted = [
    ...(board.characterRefs || []).map((name) => ({ name, declaredAs: "characterRefs" })),
    ...(board.backgroundRefs || []).map((name) => ({ name, declaredAs: "backgroundRefs" })),
    ...(board.propRefs || []).map((name) => ({ name, declaredAs: "propRefs" })),
  ].sort((a, b) => (board.refProminence?.[b.name] ?? 0) - (board.refProminence?.[a.name] ?? 0));

  const resolved = [];
  let castRefs = 0;
  for (const w of wanted) {
    if (resolved.length >= REF_CAP) break;
    const src = rowFor(doc, w.name);
    if (!src?.imageFile) continue;   // named on the board, no sheet rendered yet
    resolved.push({ name: src.name, file: src.imageFile });
    if (declaredKind(doc, w.name) === "character") castRefs++;
  }

  /* HOW THE ENGINE IS CHOSEN, carried so the lender can audit the choice
   * rather than take it on faith. `engineMode` is the PROJECT's engine mode —
   * "hybrid", "h3" or "ltx" — and `engine` is what that mode plus this scene's
   * cast resolves to. Hybrid sends a scene with cast to H3, which is the only
   * engine here with a named-reference input, and everything else to LTX.
   *
   * ⚠ THE PRICE OF GETTING THIS WRONG IS SOMEBODY ELSE'S ELECTRICITY. H3 at
   * 1920x1088 measured roughly 28 minutes for five seconds on this rig against
   * LTX's three. A packet that says "h3" when the scene did not need it is
   * asking a friend for ten times the favour.
   *
   * Computed BEFORE the no-refs refusal below, because that refusal now has to
   * know whether pictures were ever going to travel. */
  const engineMode = String(doc.brief?.videoEngine || "hybrid").toLowerCase();
  const hasRefs = castRefs > 0 && doc.brief?.castRefs !== false;
  const useRefs = hasRefs && engineMode !== "ltx";
  const engine = engineMode === "h3" ? "h3" : engineMode === "ltx" ? "ltx" : (useRefs ? "h3" : "ltx");

  /* ⚠ NAMING A CHARACTER WHOSE SHEET DOES NOT EXIST IS THE FAILURE THIS
   * REFUSES, and nothing wider than that. A board that names a person and has
   * no rendered sheet for them composes a prompt with no legend, and the lender
   * renders a stranger: it looks like a successful lend and comes back as a
   * scene matching no other scene.
   *
   * ⚠ IT USED TO REFUSE ON `wanted.length && !resolved.length`, WITH NO TEST OF
   * KIND AND NO TEST OF WHETHER PICTURES COULD TRAVEL AT ALL, AND THAT MADE
   * WHOLE PROJECTS UNLENDABLE. Measured over 353 boarded scenes on this disk:
   * 82 were refused although `useRefs` was false for every one of them — no
   * sheet would have travelled either way — and the names being refused were
   * backgrounds with `imageFile: null` (WetHighStreet, NightHighway, LiveRoom,
   * RoseRoom). copper-wire, ninety-nine-rooms and slow-hand-on-the-six were
   * 100% un-lendable. shot.js:170-179 reports exactly that state as a
   * NON-error, because you can legitimately render before every sheet exists.
   *
   * The three conditions, and why each is load-bearing:
   *   a character is named    identity is what is at stake; a background or a
   *                           prop with no sheet costs framing, not a stranger.
   *   no character resolved   `castRefs === 0`, not `!resolved.length`: a board
   *                           whose background sheet exists and whose PERSON
   *                           does not still renders a stranger, and the old
   *                           test let that one through.
   *   pictures could travel   an ltx project, or one with castRefs switched
   *                           off, was never going to send a sheet, so a
   *                           missing sheet changes nothing about that render.
   *                           Written from `engineMode`/`brief.castRefs` rather
   *                           than from `useRefs`, because `useRefs` is false
   *                           WHENEVER castRefs is 0 — testing it here would be
   *                           circular and would switch the refusal off
   *                           entirely. */
  /* ⚠ A NAME NO ROW ANSWERS IS STILL A CHARACTER IF THE BOARD DECLARED IT AS
   * ONE, and reading the kind only from the rows is how this refusal gets
   * switched off by deleting a row. Measured: with the `Hex` row removed and
   * the board still naming her, `declaredKind` answered null, `castWanted` came
   * back empty, and the packet built with no pictures at all — the exact
   * "lender renders a stranger" case this guard exists for, reached by a
   * rename. The board's own three lists are the fallback, so a dangling name in
   * `characterRefs` counts as a character and one in `backgroundRefs` does not. */
  const kindWanted = (w) => declaredKind(doc, w.name)
    ?? (w.declaredAs === "characterRefs" ? "character"
      : w.declaredAs === "backgroundRefs" ? "background" : "prop");
  const castWanted = wanted.filter((w) => kindWanted(w) === "character");
  const dangling = castWanted.filter((w) => !rowFor(doc, w.name));
  const picturesCouldTravel = engineMode !== "ltx" && doc.brief?.castRefs !== false;
  if (picturesCouldTravel && castWanted.length && castRefs === 0) {
    throw refuse("no-refs",
      `Scene ${seg.index + 1} names ${castWanted.length} character${castWanted.length === 1 ? "" : "s"} `
      + `(${castWanted.map((w) => w.name).join(", ")}) and not one of them has a rendered sheet, `
      + `so the lender would be rendering a stranger. Render those sheets first.`
      + (dangling.length
        ? ` ${dangling.map((w) => w.name).join(", ")} ${dangling.length === 1 ? "is" : "are"} not in the cast list at all — the row was probably renamed or deleted while the board kept the old name.`
        : ""));
  }

  /* THE STORYBOARD AS A NAMED REFERENCE, opt-in per project and H3-only.
   * Appended last so `<Picture 1>` stays the cast by construction. Mirrors
   * shot.js:251-255. */
  const boardRefIndex = (doc.brief?.boardRef === true
      && engine === "h3" && useRefs && board.imageFile && resolved.length < REF_CAP)
    ? resolved.length : -1;

  /* Only the pictures that are actually handed over are named in the prompt.
   * When the scene is going to LTX the resolved sheets cannot travel — LTX has
   * no named-reference input — so they are not put in `refs` either: a lender
   * should not be asked to carry bytes their render cannot use. */
  const refs = [];
  if (useRefs) {
    for (const r of resolved) {
      const { sha256, bytes } = await hashAsset(assetsDir, r.file, "no-refs", (file, code) =>
        `The reference picture "${file}" is named by this scene but could not be read `
        + `from the project's assets folder (${code}). Re-render that sheet, `
        + `or restore the file, before lending this shot out.`);
      /* `safety`: two booleans saying whether this picture was made as a
       * minor and whether as sexual (server/safety/lineage.js). The words that
       * would say so stay here; the lender's check reads these instead, so a
       * sexual scene over a picture of a child is refused on BOTH machines. */
      refs.push({ name: r.name, sha256, bytes, file: r.file, safety: projectRowFingerprint(rowFor(doc, r.name), r.file) });
    }
    if (boardRefIndex >= 0) {
      const { sha256, bytes } = await hashAsset(assetsDir, board.imageFile, "no-refs", (file, code) =>
        `This project renders the storyboard frame as a composition reference `
        + `(brief.boardRef), but "${file}" could not be read from the assets folder (${code}). `
        + `Re-render this scene's storyboard, or switch brief.boardRef off, before lending it out.`);
      refs.push({ name: "the storyboard frame for this shot", sha256, bytes, file: board.imageFile,
        safety: projectRowFingerprint(board, board.imageFile) });
    }
  }

  /* ⚠ THE UNGUIDED PATH SHIPPED WITH NO PICTURE AT ALL, AND THE COMMENT SAYING
   * THAT WAS CORRECT WAS FALSE. The old code hashed pictures only under
   * `useRefs` and explained that LTX "cannot use" them. LTX uses them — not as
   * named references but as KEYFRAMES: generate.js:720-727 builds, on exactly
   * this branch, `firstFrame` / `midFrames` / `lastFrame` / `loop` out of
   * `board.shotFrames` and `board.imageFile`. So the packet dropped the one
   * thing pinning that render.
   *
   * Measured: 97 of 353 boarded scenes on this disk are ones where the owner's
   * own render pins a guide picture and the packet carried none. sub-rosa's
   * scene s1_0 is `guideMode: "beats"` with two keyframes — the full-size
   * guided path — and was reduced to the bare unguided one, while `note` told
   * the lender "no reference pictures" as though that were the owner's intent.
   * That is this file's own stated failure ("the lender renders a stranger"),
   * reached through the branch meant to prevent it. The sub-rosa re-render is
   * the evidence for why it matters: of the three scenes that took the
   * unguided path, one came back as "three figures, one of them plainly a
   * different, older person".
   *
   * These are NOT put in `refs`. `refs` is the `<Picture N>` legend and its
   * indices have to match the prompt by construction; a guide frame is never
   * named in the prompt, and folding the two together would make
   * `<Picture 2> is …` point at a storyboard. Roles travel with the frames
   * because LTX's graph reads them positionally: `endFrame = loop ?
   * (lastFrame || firstFrame) : lastFrame`, so a single opening frame with
   * `loop: true` closes the clip on itself, which is what puts a one-beat board
   * on the full-size guided path instead of the half-size fallback.
   *
   * Mirrors generate.js's branch exactly, six frames and no more: denser guides
   * ("27 guides over 121 frames") collapse the clip into a crossfade of stills. */
  const keyframes = (!useRefs && Array.isArray(board.shotFrames) && board.shotFrames.length >= 2)
    ? board.shotFrames.slice(0, 6)
    : null;
  const openFrame = keyframes ? keyframes[0] : (!useRefs && board.imageFile) ? board.imageFile : null;
  const guideMode = keyframes ? "beats" : openFrame ? "loop" : "none";
  /* generate.js: `loop = Boolean(boardFrame) && !lastFrame` — true only for the
   * single-picture case, where closing on the opening frame is the mechanism. */
  const loop = Boolean(openFrame) && !keyframes;

  const guides = [];
  const guideFiles = keyframes || (openFrame ? [openFrame] : []);
  for (let i = 0; i < guideFiles.length; i++) {
    const role = i === 0 ? "opening" : i === guideFiles.length - 1 ? "closing" : "waypoint";
    const { sha256, bytes } = await hashAsset(assetsDir, guideFiles[i], "no-guide", (file, code) =>
      `This scene's render is pinned to the storyboard frame "${file}", but it could not be read `
      + `from the project's assets folder (${code}). Re-render this scene's storyboard `
      + `(the workflow's board step), or restore the file, before lending this shot out. `
      + `Sending it without the frame would hand the lender the unguided render, which is the `
      + `one this house has measured coming back with a different performer in it.`);
    guides.push({ role, sha256, bytes, file: guideFiles[i], safety: projectRowFingerprint(board, guideFiles[i]) });
  }

  /* ⚠ THE NAMES COME FROM `resolved`, NOT FROM `refs`. `refs` is empty on the
   * LTX path, but the plain-words legend ("In this shot: Vire and the
   * WetHighStreet…") still has to be written — dropping it entirely is what
   * made every scene invent a different performer, and clipPrompt builds its
   * refNames from the resolved list for the same reason, attached or not. */
  const refNames = resolved.map((r) => r.name);
  if (boardRefIndex >= 0) refNames.push("the storyboard frame for this shot");
  const computedPrompt = composePrompt({
    doc, seg, board, refNames, attached: useRefs, boardRefIndex,
  });
  /* ⚠ THE OWNER'S HAND-EDITED PROMPT USED TO BE SILENTLY DISCARDED. `clip` was
   * read here for its seed and nothing else, so a prompt the owner had rewritten
   * by hand — a shipped feature: shot.js:602-605 writes it, shot.js:311 gives it
   * precedence over the computed string, web/mv.js:2352 offers "Revert to
   * built" — was replaced by the builder's version, under a `note` telling the
   * lender "the prompt is finished as sent — render it verbatim". It was
   * finished, and it was the wrong one. Same precedence as resolveShot, minus
   * the per-render argument that does not exist on this path. */
  const clip = (doc.clips || []).find((c) => c.segmentId === seg.id) || null;
  const edited = typeof clip?.promptOverride === "string" && clip.promptOverride.trim()
    ? clip.promptOverride.trim() : null;
  const prompt = edited || computedPrompt;
  const promptSource = edited ? "edited" : "computed";

  /* ⚠ H3 HAS NO NEGATIVE BRANCH TO SPEAK TO. Its graph zeroes the negative
   * conditioning (ConditioningZeroOut) and samples at cfg 1, so a negative
   * string handed to it is evaluated by nothing. LTX has a real one and it is
   * the house default in config.video.engines.ltx.negative. The field is
   * therefore an empty string on the H3 path rather than a copied-over LTX
   * negative that would read as an instruction the render never received. */
  const negative = engine === "ltx" ? String(config.video?.engines?.ltx?.negative || "") : "";

  const [width, height] = renderSize(doc);
  /* The renderer's own clamp, so the lender is asked for a length the engines
   * accept: at least a second, never more than fifteen. */
  const seconds = Math.min(Math.max(Number(seg.durationSec) || 1, 1), 15);

  /* The step count and the sampling path, copied from generate.js's request.
   * `steps` is not cosmetic: workflow.js picks the distillation LoRA FROM it,
   * so 4, 8 and 20 are three different models. `baseScale: "full"` only reaches
   * LTX and only changes an unguided clip. */
  const steps = Number.isFinite(doc.brief?.videoSteps) ? Number(doc.brief.videoSteps) : DEFAULT_STEPS;
  const baseScale = doc.brief?.baseScale === "full" ? "full" : null;

  /* ⚠ NO SEED TRAVELS, AND TODAY NO SEED CAN. A per-take seed is recorded on
   * the owner's takes (`clip.takes[].seed`) and sending the most recent one
   * would ask a friend to spend their GPU reproducing a video the owner already
   * has, so takes are deliberately not read. null means "roll your own and tell
   * me what it was", which is what a lend is for.
   *
   * The line below reads `clip.seed`, a deliberate per-clip pin — and an
   * earlier comment here described that pin as though it existed. It does not:
   * measured across this disk, 0 of 339 clip rows carry the key, and nothing in
   * the repository writes it (regen.js's `row.seed` is a report row, not the
   * document). So `seed` is null on every packet this build can produce. The
   * reader is kept rather than deleted because it is the field a pin would be
   * written to, and a packet built the day one is written should carry it — but
   * until something writes it, THERE IS NO WAY FOR AN OWNER TO PIN A SEED ON A
   * LEND, and nobody should read this line as evidence that there is. */
  const seed = Number.isFinite(clip?.seed) ? Number(clip.seed) : null;

  const noteBits = [
    `One scene only: ${seconds.toFixed(1)}s at ${width}x${height} on ${engine} at ${steps} steps`
    + `${refs.length ? ` with ${refs.length} reference picture${refs.length === 1 ? "" : "s"}` : ""}`
    + `${guides.length ? ` with ${guides.length} guide frame${guides.length === 1 ? "" : "s"}` : ""}`
    + `${!refs.length && !guides.length ? " and no pictures at all" : ""}.`,
    "The prompt is finished as sent — render it verbatim and prepend nothing, "
    + "in particular not this machine's own style bible.",
  ];
  if (edited) {
    noteBits.push("This prompt was written by hand by the owner, not composed by the builder — "
      + "so it is the instruction, and a Studio that recomposes it is rendering something else.");
  }
  if (steps !== DEFAULT_STEPS) {
    noteBits.push(`⚠ The owner renders this project at ${steps} steps, not the usual `
      + `${DEFAULT_STEPS}. The step count selects the distillation, so a render at ${DEFAULT_STEPS} `
      + `is a different model${steps > DEFAULT_STEPS ? " and this one will take longer" : ""}.`);
  }
  if (guides.length) {
    noteBits.push(guides.length === 1
      ? `The single guide frame is the opening frame, and the clip closes on it again `
        + `(loop), which is what keeps this render on the full-size guided path.`
      : `The guide frames are positional: the first is the opening frame, the last is the `
        + `closing frame, the rest are waypoints in between.`);
  } else if (!refs.length) {
    noteBits.push("This render is unguided — no reference pictures and no keyframes — which is "
      + "what the owner's own render does for this scene too.");
  }
  if (baseScale === "full") {
    noteBits.push("Sample at the delivered size rather than half-then-upscale (baseScale: full).");
  }
  /* ⚠ THE SONG STAYS HOME, SO SAY WHICH SCENES THAT CHANGES. generate.js puts
   * the song under a clip when the expression below holds and the project has
   * one. A lent render never has it. For a singing board or "Song under the
   * clip: always" that is the difference between lips that follow the vocal
   * and lips that do not, so it is carried as a word both screens branch on
   * (order.js describeOrder) — a label, never the file's name.
   *
   * ⚠ A DELIBERATE DUPLICATE, CHARACTER FOR CHARACTER. This module may not
   * import generate.js (the import rule at the top), so `songUnderClip` is
   * generate.js's own `songConditioned` expression copied verbatim, and
   * server/collab/lending_test.js compares the two texts: a change there that
   * is not made here fails that lane rather than drifting. */
  const songUnderClip = engine === "ltx" || !useRefs || Boolean(board?.lipSync)
    || doc.brief?.songConditioning === "always";
  const songConditioned = !!doc.song?.file && songUnderClip;
  const songUnder = !songConditioned ? null
    : board.lipSync ? "lipsync"
    : doc.brief?.songConditioning === "always" ? "always"
    : "engine";
  if (songUnder) {
    noteBits.push(songUnder === "engine"
      ? "The owner's own render of this scene has the song under it; this one is rendered without it."
      : "Lip-sync does not travel: the owner renders this scene with the song under it so mouths follow the vocal, and the song stays on the owner's machine, so this take is rendered without it.");
  }
  /* Worth a sentence: the owner has parked this scene, so a friend burning an
   * hour on it may be burning it on something nobody will cut in. */
  if (seg.mode && seg.mode !== "generate") {
    noteBits.push(`The owner has this scene set to "${seg.mode}" rather than "generate", `
      + `so check before spending time on it.`);
  }

  return {
    v: PACKET_V,
    kind: "shot",
    segmentId: seg.id,
    prompt,
    promptSource,
    negative,
    seconds,
    width,
    height,
    engine,
    engineMode,
    mode: seg.mode ?? null,
    steps,
    baseScale,
    seed,
    refs,
    guides,
    guideMode,
    loop,
    songUnder,
    note: noteBits.join(" "),
  };
}

/* ─────────────────────────────────────────────────────── the project bundle */

/**
 * Walk a parsed document and collect every string it holds.
 *
 * Asset file names live in a dozen different keys — `imageFile` on four kinds
 * of row, `file` on every take, the entries of `shotFrames`, and more will be
 * added by whoever writes the next feature. Enumerating those keys means the
 * manifest goes stale the first time somebody adds a thirteenth, and a manifest
 * that silently omits a picture is exactly the class of failure this repository
 * keeps writing comments about. So every string in the document is a candidate,
 * and the ASSETS FOLDER decides: a string is an asset if a file of that name is
 * actually sitting there.
 *
 * Depth is bounded because a document arriving from a peer is not trusted to be
 * shallow; a parsed JSON value cannot contain a cycle, so nothing else is
 * needed to terminate.
 */
function collectStrings(value, out, depth = 0) {
  if (depth > 12) return out;
  if (typeof value === "string") { out.add(value); return out; }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out, depth + 1);
    return out;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectStrings(v, out, depth + 1);
  }
  return out;
}

/**
 * The whole project, for a collaborator.
 *
 * A collaborator is directing an episode, not running an errand: they get the
 * document — bibles, boards, segments, casting, the lot — plus a manifest of
 * the asset files it refers to, so the receiving side can ask for exactly the
 * pictures it does not already hold. The bytes are not in here; the manifest is
 * the negotiation that decides which bytes are worth sending.
 *
 * ⚠ THE MANIFEST IS OF FILES THAT EXIST, and a referenced sheet whose file has
 * been deleted simply does not appear in it. That is not the silent drop this
 * repository hunts: a missing sheet is already reported as a missing sheet by
 * shot resolution, on the receiving machine exactly as on the sending one, and
 * it will be reported there the first time that scene is looked at. What the
 * manifest cannot do is guess — a document also names rendered .mp4 clips and
 * the song, which live in the library rather than in the assets folder and are
 * not part of a bundle, and from a bare name the two are indistinguishable. The
 * folder listing is the only honest arbiter.
 */
export async function projectBundle({ doc, assetsDir } = {}) {
  if (!doc || typeof doc !== "object") {
    throw refuse("bad-arguments",
      "Pass the parsed project.json as `doc`. Read it with readProject(slug) first.");
  }
  if (typeof assetsDir !== "string" || !assetsDir) {
    throw refuse("bad-arguments",
      "Pass the project's assets folder as `assetsDir` — assetsDir(slug) from server/mv/store.js.");
  }

  /* A project created five minutes ago has no assets folder yet and bundling it
   * is a perfectly sensible thing to do, so an absent folder is an empty
   * manifest rather than a refusal. Any other error — a permissions problem, a
   * path that is a file — is a real fault and is left to propagate with its own
   * message rather than being flattened into "no assets". */
  let onDisk = [];
  try {
    onDisk = await readdir(assetsDir);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const present = new Set(onDisk);

  const referenced = collectStrings(doc, new Set());
  /* Sorted, so that two bundles of an unchanged project are the same bundle.
   * A manifest whose order depends on the order of keys in a JSON file makes
   * "has anything changed since I sent it?" unanswerable by comparison. */
  const names = [...present].filter((f) => referenced.has(f)).sort();

  /* ⚠ THE FOLDER CAN CHANGE BETWEEN THE LISTING AND THE HASHING, AND THAT IS
   * NOT THE CALLER'S MISTAKE. This loop runs 30 to 100 readFile calls after the
   * readdir above, and a file deleted, renamed or locked in that window used to
   * be reported as `bad-arguments` with the shot packet's sentence — "the
   * reference picture … is named by this scene … re-render that sheet" — for
   * something that is not a reference picture, not part of any scene, and not
   * caused by whoever called this function. It gets its own reason and its own
   * sentence now; the fix for it is to bundle again, not to edit a document. */
  const assets = [];
  for (const name of names) {
    const { sha256, bytes } = await hashAsset(assetsDir, name, "asset-unreadable", (file, code) =>
      `The assets folder listed "${file}" a moment ago, but it could not be read while the `
      + `bundle was being built (${code}). Something changed the folder during the bundle — `
      + `a delete, a rename, or a file still being written. Bundle this project again.`);
    assets.push({ name, sha256, bytes });
  }

  return { v: PACKET_V, kind: "project", slug: doc.slug || null, doc, assets };
}

/* ─────────────────────────────────────────────────────── the receiving screen */

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

/**
 * One sentence for the person on the receiving end, before they accept.
 *
 * It exists so that accepting is an informed act: the size of the favour being
 * asked (minutes of somebody's card) and the size of the disclosure being made
 * (one scene, or a whole script) are the two things a human needs in front of
 * them, and neither is legible from a JSON blob. The GPU cost is deliberately
 * NOT estimated here — the only numbers this house has measured are for
 * particular sizes on one particular card (roughly 28 minutes for five seconds
 * of H3 at 1920x1088 against LTX's three), and a made-up minute count on
 * somebody else's hardware would be a worse lie than silence.
 *
 * ⚠ IT MAY ONLY PROMISE WHAT shotPacket CAN KEEP. This sentence used to end
 * "no song, no lyrics, no other scenes", and it was shown to a human as the
 * basis for consent — but shotPacket's own header says plainly that this is not
 * a redaction engine and that board prose written by a director can carry the
 * sung line into the packet. "No lyrics" was therefore asserted, never checked;
 * it happens to hold on every project on this disk, which is exactly the kind
 * of luck that stops holding quietly. What IS guaranteed is that no song track
 * and no other scene travels, so that is what it now says.
 */
export function describePacket(packet) {
  if (!packet || typeof packet !== "object") {
    return "This is not a packet — there is nothing here to describe.";
  }
  if (packet.kind === "shot") {
    const refs = Array.isArray(packet.refs) ? packet.refs : [];
    const guides = Array.isArray(packet.guides) ? packet.guides : [];
    const bytes = [...refs, ...guides].reduce((n, r) => n + (Number(r.bytes) || 0), 0);
    const pictures = [
      refs.length
        ? `${refs.length} reference picture${refs.length === 1 ? "" : "s"} `
          + `(${refs.map((r) => r.name).join(", ")})`
        : "",
      guides.length ? `${guides.length} guide frame${guides.length === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    return `Scene metadata for review: scene ${packet.segmentId}, `
      + `${Number(packet.seconds).toFixed(1)}s at ${packet.width}x${packet.height} on `
      + `${packet.engine} (${packet.engineMode} mode) at ${packet.steps} steps, `
      + (pictures.length ? `naming ${pictures.join(" and ")} (${mb(bytes)} on the sender's disk), ` : "with no named pictures, ")
      + `and a ${String(packet.prompt || "").length}-character prompt — no song track, `
      + `no other scenes. This packet contains names and hashes only for those pictures; `
      + `no picture bytes are included, and this is not a render request.`;
  }
  if (packet.kind === "project") {
    const doc = packet.doc || {};
    const assets = Array.isArray(packet.assets) ? packet.assets : [];
    const bytes = assets.reduce((n, a) => n + (Number(a.bytes) || 0), 0);
    return `Project document and asset manifest: "${packet.slug || doc.slug || "untitled"}", `
      + `${(doc.segments || []).length} scenes, ${(doc.boards || []).length} boards, `
      + `${(doc.characters || []).length} character${(doc.characters || []).length === 1 ? "" : "s"}, `
      + `and ${assets.length} named asset file${assets.length === 1 ? "" : "s"} totalling ${mb(bytes)} on the sender's disk `
      + `— including the script, the style bible and every board prompt. `
      + `Only asset names, sizes and hashes are included; no asset file bytes travel with this packet. `
      + `The song and the rendered clips are NOT in the manifest: they live in the library, `
      + `not in the assets folder, so they do not travel with a bundle.`;
  }
  return `A packet of an unknown kind ("${packet.kind}"), version ${packet.v ?? "?"} — `
    + `this build does not know how to read it, so do not act on it.`;
}
