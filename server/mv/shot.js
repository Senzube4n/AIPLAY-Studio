/**
 * Video Workflow — ONE SHOT: what was sent, what resolved, and what to change.
 *
 * WHY THIS FILE EXISTS. Every failure DIRECTING.md records has the same shape:
 * "the board looked correct and the render got something else". A board names
 * three references; two of them have no rendered sheet; the render carries one
 * picture and the prompt names three, and nothing anywhere says so. The clip
 * comes back wrong and the only evidence — which sheets actually resolved, what
 * text was actually sent, which engine actually ran — was computed inside
 * generateClip, used once, and thrown away.
 *
 * So the resolution is lifted out here as a PURE function of the document. Three
 * things then become possible that were not:
 *
 *   1. LOOK BEFORE YOU SPEND. `resolveShot` costs nothing and answers "what will
 *      this render actually be given" — before the GPU minutes, not after.
 *   2. EDIT THE THING ITSELF. The prompt a human sees is the prompt that is
 *      sent, so editing it is editing the render, not editing a summary of it.
 *   3. NO MIRROR TO DRIFT. generateClip calls this; regen.js's staleness scan
 *      calls this; the inspector calls this. There was already one copy too
 *      many — regen.js's `refsNow` carried a ⚠ MIRROR warning and had ALREADY
 *      drifted: it omits propRefs, which generateClip has carried since props
 *      became cast, so the sweep reasoned about a clip nobody would make.
 *
 * ⚠ PURE ON PURPOSE. Nothing here touches the filesystem, stages a file for
 * ComfyUI, or writes the document. The one impure step of the old code — copying
 * each sheet into the render input directory — stays in generate.js and now
 * operates on the list this file returns, IN ORDER, so `<Picture 3>` in the
 * prompt is the third staged file by construction rather than by coincidence.
 */

/* ─────────────────────────────────────────────────────── the prompt */

/**
 * A compact clip-prompt assembly. NOT the website's seedancePromptBuilder —
 * that ports later, verbatim, with its trim ladder. This one keeps the same
 * ORDER (style → scene → beats → grade) so prompts migrate cleanly when the
 * real builder lands.
 *
 * Moved here from generate.js unchanged. It is the payload, and the payload
 * belongs next to the resolution that decides what goes in it.
 */
export function clipPrompt(doc, seg, board, refNames = [], boardRefIndex = -1, attached = true) {
  const bits = [];
  if (doc.styleBible) bits.push(doc.styleBible + ".");
  const list = (xs) => (xs.length <= 1 ? (xs[0] || "")
    : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  /* ⚠ References must be NAMED in the prompt or they barely condition — the
   * overnight run proved it: every scene carried the character's sheet as
   * <Picture 1> and every scene invented a different performer, because the
   * prompt never said the words. The tag legend is not decoration; it is the
   * mechanism. Order here matches the refImages array by construction.
   *
   * ⚠ AND THE TAG IS ONLY TRUE WHEN A PICTURE ARRIVES. `attached` is the
   * resolver's `useRefs`: false on every ltx project, on every project with
   * cast references switched off, and on every scene with no cast. The panel
   * measured what that costs on sub-rosa — a prompt whose first sentence after
   * the style bible was "<Picture 1> is Vire." over no attachment at all — and
   * a picture tag pointing at nothing is worse than silence, because the model
   * spends attention resolving a reference that was never handed over.
   *
   * THE NAMES STILL GO. Dropping the legend entirely would repeat the original
   * failure (every scene inventing a different performer). What changes is the
   * SPELLING: with pictures, the tag legend the engine can follow; without,
   * plain words, which is all the model was ever going to get. */
  const legend = !refNames.length ? ""
    : attached
      ? refNames.map((n, i) => `<Picture ${i + 1}> is ${n}.`).join(" ") + " "
        /* Say what to DO with the storyboard, and say what not to do with it.
         * A still handed to a video model without instruction is an invitation
         * to hold still, which is the one failure a dance shot cannot survive. */
        + (boardRefIndex >= 0
            ? `Use <Picture ${boardRefIndex + 1}> for the composition, framing, staging and lighting `
              + `of this shot. It is a STILL reference, not the first frame — the shot must move `
              + `and the subject must perform the action below, not hold that pose. `
            : "")
      : `In this shot: ${list(refNames)}. Keep each one exactly as the style above describes, `
        + `identical in every scene. `;
  /* <Picture 1> is the cast by construction — the board reference is appended
   * last, so this never points at a storyboard. Without attachments there is no
   * picture to point at, so the lead is named instead. */
  const lead = !refNames.length ? "the lead performer"
    : attached ? "the performer from <Picture 1>" : refNames[0];
  if (board?.shots?.length) {
    const beats = board.shots.map((s, i) =>
      `${i + 1}. ${[s.shotType, s.angle, s.cameraMove, s.lensFeel, s.lighting].filter(Boolean).join(", ")}: ${s.action}`);
    bits.push(`${legend}SCENE (${seg.durationSec.toFixed(1)}s): ${beats.join(" ")}`);
  } else if (seg.kind === "lyrical") {
    bits.push(`${legend}${lead[0].toUpperCase() + lead.slice(1)} sings the line "${seg.thesisLine || seg.lyricText}" to camera, expressive, a music-video performance shot, keeping the exact same appearance in every shot.`);
  } else {
    bits.push(`${legend}Atmospheric instrumental b-roll matching the music's energy${
      refNames.length ? `, in the world of ${attached ? "<Picture 1>" : refNames[0]}` : ""}.`);
  }
  if (board?.grade) bits.push(board.grade);
  return bits.join(" ").slice(0, 4800);
}

/* ─────────────────────────────────────────────────────── lookups */

/** Segment by id, then by 0-based index — the two spellings every route takes. */
export const findSegment = (doc, segmentId) =>
  (doc.segments || []).find((s) => s.id === segmentId)
  || (doc.segments || []).find((s) => String(s.index) === String(segmentId))
  || null;

export const findBoard = (doc, seg) => (doc.boards || []).find(
  (b) => b.segmentId === seg.id || b.segmentIndex === seg.index) || null;

export const findClip = (doc, seg) => (doc.clips || []).find(
  (c) => c.segmentId === seg.id) || null;

/** Which list a declared name lives on, or null when nothing declares it. */
function declaredKind(doc, name) {
  if ((doc.characters || []).some((c) => c.name === name)) return "character";
  if ((doc.backgrounds || []).some((g) => g.name === name)) return "background";
  if ((doc.props || []).some((p) => p.name === name)) return "prop";
  return null;
}

const rowFor = (doc, name) =>
  (doc.characters || []).find((c) => c.name === name)
  || (doc.backgrounds || []).find((g) => g.name === name)
  || (doc.props || []).find((p) => p.name === name)
  || null;

/* H3's named-reference input takes nine pictures. Named here because three
 * separate places used to spell it as a bare 9. */
export const REF_CAP = 9;

/* IS LTX ON THIS PC? A FACT, INJECTED. "hybrid" sends a scene with no cast to
 * LTX, and a newcomer cannot download LTX (its repo is gated), so on a fresh
 * install every cast-less scene went to an engine that is not there. This file
 * stays pure: the server hands in a probe (server/mv/routes.js, from index.js's
 * videoReady("ltx")), and with none installed, as in a test or a script, LTX
 * counts as ready, which is how hybrid behaved before. `opts.ltxReady` on one
 * call beats both. */
let ltxProbe = null;
export function setLtxReady(fn) { ltxProbe = typeof fn === "function" ? fn : null; }
export function ltxReadyNow() {
  if (!ltxProbe) return true;
  try { return ltxProbe() !== false; } catch { return true; }
}

/* ─────────────────────────────────────────────────────── the resolution */

/**
 * What THIS shot would actually be given, right now.
 *
 * ⚠ THIS IS THE RENDERER'S OWN REASONING, not a description of it. generateClip
 * calls this and stages `refs` in the order returned; if the two ever disagree
 * the bug is here, in one place, rather than in a copy nobody remembers.
 *
 * @param opts.prompt  a one-render override, beating the stored one.
 */
export function resolveShot(doc, segmentId, opts = {}) {
  const seg = findSegment(doc, segmentId);
  if (!seg) throw new Error(`No such segment: ${segmentId}`);
  const board = findBoard(doc, seg);
  const clip = findClip(doc, seg);

  /* The board's cast by prominence, else every character (a video without a
   * board still keeps its people consistent). Props ride along: they are cast,
   * and they have been in this list since the props work landed. */
  const wanted = board
    ? [
        ...(board.characterRefs || []).map((name) => ({ name, declaredAs: "characterRefs" })),
        ...(board.backgroundRefs || []).map((name) => ({ name, declaredAs: "backgroundRefs" })),
        ...(board.propRefs || []).map((name) => ({ name, declaredAs: "propRefs" })),
      ].sort((a, b) => (board.refProminence?.[b.name] ?? 0) - (board.refProminence?.[a.name] ?? 0))
    : (doc.characters || []).map((c) => ({ name: c.name, declaredAs: "every character (no board)" }));

  const refs = [];        // resolved, in the exact order they are staged
  const refsMissing = []; // named on the board, reaching the render as nothing
  const dropped = [];     // resolved fine, lost to the 9-picture cap
  let castRefs = 0;
  let capped = false;

  for (const w of wanted) {
    if (capped) { dropped.push({ ...w, kind: declaredKind(doc, w.name), file: rowFor(doc, w.name)?.imageFile ?? null }); continue; }
    const kind = declaredKind(doc, w.name);
    const src = rowFor(doc, w.name);
    const prominence = board?.refProminence?.[w.name] ?? null;
    if (src?.imageFile) {
      refs.push({ name: src.name, kind, file: src.imageFile, prominence, declaredAs: w.declaredAs });
      if (kind === "character") castRefs++;
    } else {
      /* ⚠ THE SILENT DROP, NAMED. A declared prop with imageFile:null is
       * exactly the failure DIRECTING.md calls out: the board looks correct,
       * the render gets nothing, and no warning is printed anywhere. It is not
       * an error — you can legitimately render before every sheet exists — so
       * it is reported, on the shot, every time anyone looks. */
      refsMissing.push({
        name: w.name, kind, declaredAs: w.declaredAs, prominence,
        why: !kind ? "not declared as a character, background or prop"
          : `declared as a ${kind}, but no sheet has been rendered — it reaches this render as nothing`,
      });
    }
    /* Cap AFTER the push, exactly as the renderer's loop did: a name that
     * resolves to nothing does not consume one of the nine. */
    if (refs.length >= REF_CAP) capped = true;
  }

  /* ⚠ ONLY A FACE JUSTIFIES H3. Props became references and that immediately
   * re-routed the engine: a scene carrying only a prop — a boat, a train, no
   * cast at all — had refImages.length > 0 and so chose H3, at roughly ten
   * times LTX's cost. Measured the hard way: one 13.7 s boat scene at 1920x1088
   * ran past forty minutes and was still going.
   *
   * And it buys nothing, because the prop is ALREADY carried. The board is
   * rendered WITH the prop sheet attached as an image reference — in the image
   * engine, where references are cheap and known to work — and LTX pins that
   * board as frame 0. The identity work has happened before the clip starts.
   * That is the documented design for how LTX gets its people; it is just as
   * true of objects.
   *
   * So props stay in `refs` (H3 uses them properly when a scene is going there
   * anyway for its cast) but they no longer DECIDE the engine — which is why
   * `castRefs` counts characters and not resolved pictures.
   *
   * ── THREE MODES ─────────────────────────────────────────────────────────
   *   "hybrid"  H3 for any scene carrying named cast, LTX for everything else.
   *             This was ALREADY the behaviour — it just fell out of whether a
   *             scene happened to have refs rather than being a choice anybody
   *             made. Naming it makes the split visible.
   *   "h3"      every clip on H3. Roughly 10x LTX at the same size (~28 min
   *             against ~3 for five seconds at 1920x1088 on this rig), and the
   *             only engine with a named-reference input.
   *   "ltx"     every clip on LTX, references dropped. An explicit "ltx" used
   *             to be silently overridden to H3 the moment a scene had a sheet,
   *             so the setting did not mean what it said.
   *
   * ⚠ HYBRID'S CHEAP BRANCH IS LTX, NOT "whatever the machine is set to". This
   * once read `useRefs ? "h3" : (config.video.engine || "ltx")`, and
   * config.video.engine is a PERSISTED per-machine preference that this rig had
   * set to "h3" — so every scene without cast fell through to H3 as well and
   * "hybrid" quietly meant "everything on the ten-times-more-expensive engine".
   * It cost most of an evening, because nothing reported which engine a clip
   * chose until after it had run. That is now the first thing the shot record
   * says, above the prompt, for exactly this reason. */
  const mode = String(doc.brief?.videoEngine || "hybrid").toLowerCase();
  const refsWanted = doc.brief?.castRefs !== false;

  /* ⚠ TWO QUESTIONS THAT WERE ONE VARIABLE, AND THE SECOND ANSWER WAS WRONG.
   *
   * "does this scene justify H3's price?" and "should this scene's pictures be
   * attached?" are not the same question, and `hasRefs = castRefs > 0` used to
   * answer both. For hybrid that is harmless — a cast-less scene goes to LTX,
   * and LTX has no picture input, so there is nothing to attach either way.
   *
   * On an EXPLICIT "h3" project it was a straight defect. The engine is H3
   * because the brief said so; the ten-times cost is already being paid; and
   * then a board with no person on it — a room, a prop, an empty case — had its
   * pictures withheld anyway, because the ROUTER's question came back "no
   * cast". The plates were resolved, named in the prompt, and never sent. Worse
   * than losing them: `opensOn` below then pinned the flux storyboard as frame
   * 0 on exactly those shots, so the one picture that DID reach the render was
   * the one the owner had asked to keep out of the clip path.
   *
   * MEASURED on ABOVE THE WATER: 8 of 34 shots, and 9 of the coda's 12, because
   * a shot of a city has nobody standing in it. The workaround was to import a
   * duplicate of a plate under `characters` purely to trip the counter — two of
   * the nine slots spent on one image to answer a question nobody was asking.
   *
   * So the router keeps counting CAST (that part was right and is why props
   * stopped re-routing the engine), and the attachment follows THE ENGINE THAT
   * WILL ACTUALLY RUN. `brief.castRefs: false` still switches pictures off
   * everywhere, which is the only thing it ever claimed to do. */
  /* ⚠ AND HYBRID'S CHEAP BRANCH ONLY WHEN IT IS THERE. A scene with no cast
   * goes to LTX when LTX is on this PC; otherwise to H3, the engine that is,
   * and the shot says so (warning "ltx-not-here") rather than sending the
   * render to weights that do not exist. An explicit "ltx" is left alone: a
   * person who named the engine gets it, or its own missing-model refusal. */
  const ltxHere = typeof opts.ltxReady === "boolean" ? opts.ltxReady : ltxReadyNow();
  const castless = !(castRefs > 0 && refsWanted);
  const engine = mode === "h3" ? "h3" : mode === "ltx" ? "ltx"
    : (!castless ? "h3" : ltxHere ? "ltx" : "h3");
  // H3 is the only engine with a <Picture N> input, so refs can only be honoured
  // there. Asking for LTX is therefore also asking to drop them.
  const useRefs = engine === "h3" && refsWanted && refs.length > 0;

  /* IS THE SONG UNDER THIS CLIP? generate.js's rule, character for character
   * (collab/lending_test holds the three copies to one text): LTX always; H3
   * off the reference path, where the board sings, or where the brief puts it
   * under every scene. Said on the shot (`songUnder`, `songLine`) before
   * anything is spent, because a singing mouth follows the words only when the
   * song is under the clip (the REWIND A/B, 2026-09-24, DIRECTING.md §2). */
  const songUnderClip = engine === "ltx" || !useRefs || Boolean(board?.lipSync)
    || doc.brief?.songConditioning === "always";
  const songUnder = !!doc.song?.file && songUnderClip;
  const songLine = !doc.song?.file ? "no song attached to this project"
    : engine === "ltx" ? "song under this clip (LTX always hears it; its mouths do not follow it, measured)"
    : !useRefs ? "song under this clip (text path, no pictures)"
    : board?.lipSync ? "song under this clip: this board sings (lip-sync)"
    : doc.brief?.songConditioning === "always"
      ? "song under this clip: the brief puts it under every scene, so a singing mouth follows the words"
    : "no song under this clip: Song under the clip is auto and this board is not marked as sung, so a mouth "
      + "here will not follow the words";

  /* THE STORYBOARD AS A REFERENCE (not a first frame), OPT-IN PER PROJECT.
   *
   * A FIRST FRAME is a pin: LTX's ImgToVideoInplace writes the picture into
   * frame 0 and the clip must start exactly there, which measurably costs
   * motion. A REFERENCE is not pinned at all — the model is free to put the
   * pictured subject in a new scene, which is the whole point. So the board can
   * guide an H3 shot's composition without costing it motion.
   *
   * ⚠ AND IT IS OFF BY DEFAULT ANYWAY. That reasoning assumes the board is
   * GOOD, and on Bone Waffle it plainly was not: 19 boards came back with
   * mangled hands, cut-off legs, one upside-down frame with a doubled face. Each
   * fault would have been taught to the clip as if it were intentional. A
   * CHARACTER sheet is authored art, checked by a person, reused across every
   * scene; a board is one throwaway generation nobody looks at. Handing both to
   * the same mechanism averages them. And composition never needed a picture —
   * shotType, angle, cameraMove, lensFeel and lighting are all in the prompt,
   * and text cannot have six fingers. Cast stays ahead of the board in the
   * ordering, because identity outranks framing when the cap bites. */
  const boardRefIndex = (doc.brief?.boardRef === true
      && engine === "h3" && useRefs && board?.imageFile && refs.length < REF_CAP)
    ? refs.length : -1;
  const refNames = refs.map((r) => r.name);
  if (boardRefIndex >= 0) refNames.push("the storyboard frame for this shot");

  /* Which pictures STEER the clip, as opposed to condition it. Predicted here
   * so the inspector can say "this one is pinned and that one is not" before
   * the render rather than after. Mirrors generateClip's keyframe branch. */
  const keyframes = (!useRefs && Array.isArray(board?.shotFrames) && board.shotFrames.length >= 2)
    ? board.shotFrames.slice(0, 6) : null;
  const opensOn = keyframes ? keyframes[0] : (!useRefs && board?.imageFile) ? board.imageFile : null;
  const guideMode = keyframes ? "beats" : opensOn ? "loop" : "none";

  /* ⚠ RESOLVED IS NOT THE SAME AS SENT, AND THE DIFFERENCE IS A LIVE DEFECT.
   *
   * generateClip attaches the pictures as `refImages: useRefs ? refImages :
   * undefined` — but it builds the NAME LIST unconditionally, and clipPrompt
   * writes a `<Picture N> is <Name>` legend from that list either way. So an
   * LTX render, or any project with castRefs switched off, sends a prompt that
   * introduces pictures the model is never given.
   *
   * FOUND BY THIS PANEL ON ITS FIRST RUN, on sub-rosa: videoEngine "ltx",
   * useRefs false, one resolved character, and a prompt whose first sentence
   * after the style bible is "<Picture 1> is Vire." over no attachment at all.
   * Every clip in that project is in this state.
   *
   * ⚠ NOW FIXED, one layer down. The note above said "not fixed here,
   * deliberately — a default changes on a measurement rather than on an
   * inference". The measurement arrived: 11 of the 15 projects in this library
   * are on the ltx engine, so on two thirds of the corpus every clip prompt
   * introduces pictures that are never attached. That is not a default worth
   * protecting; it is a sentence about nothing.
   *
   * `useRefs` is handed to clipPrompt as `attached`, and the legend changes
   * SPELLING rather than disappearing — the names still go, because naming them
   * is what stops each scene inventing a new performer. `refsSent` stays, and
   * stays reported, because it is also the honest answer to "did the sheets
   * reach the video model" for the take record and the map. */
  const refsSent = useRefs && refs.length > 0;
  const warnings = [];
  if (mode === "hybrid" && castless && !ltxHere) {
    warnings.push({
      kind: "ltx-not-here",
      names: [],
      why: "this scene carries no cast, so hybrid would render it on LTX, but LTX is not on this PC: "
        + "it renders on H3 instead, which takes longer. Choose h3 in the brief to make that the rule for every scene.",
    });
  }
  if (refs.length && !useRefs) {
    warnings.push({
      kind: "named-but-not-sent",
      names: refs.map((r) => r.name),
      why: `the prompt introduces ${refs.length} reference picture${refs.length === 1 ? "" : "s"} `
        + `(${refs.map((r) => r.name).join(", ")}) that this render will NOT be given — `
        + (mode === "ltx" ? "the project is set to the ltx engine, which has no named-reference input"
           : doc.brief?.castRefs === false ? "the project has cast references switched off"
           : "this scene carries no cast, so it renders on ltx, which has no named-reference input")
        + ". The sheets are still reaching the model indirectly if the storyboard was rendered with them attached and pins frame 0.",
    });
  }

  const computedPrompt = clipPrompt(doc, seg, board, refNames, boardRefIndex, useRefs);
  /* PRECEDENCE, and each level is visible in `promptSource` so nobody has to
   * guess which one won: an argument for this one render beats the project's
   * stored hand-edit, which beats what the builder computes. */
  const override = typeof opts.prompt === "string" && opts.prompt.trim()
    ? opts.prompt.trim()
    : (typeof clip?.promptOverride === "string" && clip.promptOverride.trim() ? clip.promptOverride.trim() : null);
  const promptSource = !override ? "computed"
    : (typeof opts.prompt === "string" && opts.prompt.trim()) ? "argument" : "edited";

  return {
    segmentId: seg.id,
    sceneIndex: seg.index,
    scene: seg.index + 1,
    startSec: seg.startSec, endSec: seg.endSec, durationSec: seg.durationSec,
    kind: seg.kind, mode: seg.mode,
    line: seg.thesisLine || seg.lyricText || null,
    clipId: clip?.id ?? null,
    boardId: board?.id ?? null,
    boardShots: (board?.shots || []).length,
    boardImage: board?.imageFile ?? null,

    refs, refsMissing, dropped, refNames, castRefs,
    /* Whether the resolved pictures are actually handed over. A panel that
     * lists references without this reads as a promise the render does not
     * keep — which is the failure it exists to catch, one level up. */
    refsSent, warnings,
    refCap: REF_CAP,

    engineMode: mode, useRefs, engine,
    songUnder, songLine,
    boardRefIndex, opensOn, guideMode,
    keyframes: keyframes ? keyframes.length : 0,

    computedPrompt,
    prompt: override || computedPrompt,
    promptSource,
    promptOverride: typeof clip?.promptOverride === "string" ? clip.promptOverride : null,

    /* Reported, never thrown by the resolver itself — a caller that only wants
     * to LOOK at a skipped scene should not be handed an exception. */
    blocked: seg.mode !== "generate" ? `scene ${seg.index + 1} is set to ${seg.mode}` : null,
  };
}

/* ─────────────────────────────────────────────────────── the take history */

/* Legacy rows store a take as a bare filename string. Same tolerance as
 * timeline_read.js and regen.js, for the same reason: the oldest projects have
 * the most to explain, so they must not be the ones that throw. */
const takeFile = (t) => (typeof t === "string" ? t : (t?.clip ?? t?.file ?? null));

/**
 * One take, as evidence.
 *
 * ⚠ `prompt` AND `refs` ARE RECORDED PER TAKE from this change onward, and were
 * not before: the row carried a single `prompt` that the next render
 * overwrote, so "keep the old take" kept the video and lost the reason for it.
 * A take from before this lands has `evidence:false`, which is the honest
 * answer — better than showing the row's current prompt and implying it made
 * a video it did not.
 */
function takeRow(t, i, clip) {
  const file = takeFile(t);
  const o = typeof t === "string" ? {} : (t || {});
  return {
    n: i + 1,
    file,
    current: file === clip?.clipFile,
    seed: o.seed ?? null,
    engine: o.engine ?? (o.imported ? "import" : null),
    at: Number.isFinite(o.at) ? o.at : null,
    ms: Number.isFinite(o.ms) ? o.ms : null,
    imported: !!o.imported,
    openedOn: o.openedOn ?? null,
    prompt: typeof o.prompt === "string" ? o.prompt : null,
    promptSource: o.promptSource ?? null,
    refs: Array.isArray(o.refs) ? o.refs : null,
    refsMissing: Array.isArray(o.refsMissing) ? o.refsMissing : null,
    /* Does this take know what made it? The whole point of the inspector is
     * that "why did this come out like that" has an answer on disk, and for
     * older takes it honestly does not. */
    evidence: typeof o.prompt === "string" && Array.isArray(o.refs),
  };
}

/* A reference is identified by NAME AND FILE together. Name alone would miss
 * the failure that matters most here — the name stayed, the sheet behind it
 * moved — and file alone would call two different names sharing a picture the
 * same reference. "" is the unit separator: it cannot occur in either. */
const refKey = (r) => `${r.name}${r.file}`;

/**
 * What has changed under the take that is currently playing.
 *
 * This is the "and see what that changed" half of the ask. Toggling a
 * reference or editing a prompt is invisible until something says the playing
 * clip no longer matches its own inputs — which is the exact failure the
 * staleness flags catch for boards and have never caught for prompts.
 */
export function shotDrift(plan, current) {
  if (!current) return { any: false, why: "nothing rendered yet" };
  if (!current.evidence) {
    return { any: false, unknown: true,
      why: "this take predates per-take evidence — its prompt and references were not recorded, so nothing can be compared. Re-render to start the record." };
  }
  const was = new Map(current.refs.map((r) => [refKey(r), r]));
  const now = new Map(plan.refs.map((r) => [refKey(r), r]));
  const byName = (list) => new Map(list.map((r) => [r.name, r]));
  const wasN = byName(current.refs), nowN = byName(plan.refs);

  const added = plan.refs.filter((r) => !was.has(refKey(r)) && !wasN.has(r.name)).map((r) => r.name);
  const removed = current.refs.filter((r) => !now.has(refKey(r)) && !nowN.has(r.name)).map((r) => r.name);
  /* A name that survived but points at a DIFFERENT sheet — somebody re-picked
   * a take. This is the one a name-only comparison misses entirely, and it is
   * the one that silently changes a face. */
  const repointed = plan.refs
    .filter((r) => wasN.has(r.name) && wasN.get(r.name).file !== r.file)
    .map((r) => ({ name: r.name, was: wasN.get(r.name).file, now: r.file }));

  const promptChanged = current.prompt !== plan.prompt;
  const engineChanged = current.engine && current.engine !== "import" && current.engine !== plan.engine;
  return {
    any: promptChanged || engineChanged || added.length > 0 || removed.length > 0 || repointed.length > 0,
    promptChanged, engineChanged,
    engineWas: engineChanged ? current.engine : undefined,
    refsAdded: added, refsRemoved: removed, refsRepointed: repointed,
  };
}

/**
 * The whole record for one shot: what would be sent, what was sent, what
 * changed in between. Pure, free, and the same answer for both surfaces.
 */
export function shotRecord(doc, segmentId, opts = {}) {
  const plan = resolveShot(doc, segmentId, opts);
  const seg = findSegment(doc, segmentId);
  const clip = findClip(doc, seg);
  const takes = (clip?.takes || []).map((t, i) => takeRow(t, i, clip));
  const current = takes.find((t) => t.current) || takes[takes.length - 1] || null;
  return {
    ...plan,
    clipFile: clip?.clipFile ?? null,
    status: clip?.status ?? null,
    /* ⚠ WHY, NOT JUST WHETHER. `clip.status = "stale"` is one word for four
     * different causes, and it used to be READ as one of them: any stale clip
     * reported "board", which is a lie the moment a prompt edit is what made it
     * stale. Every writer now appends its own reason to `clip.staleWhy`, and a
     * clip from before that field existed still reports "board", which is what
     * it always meant. */
    staleReasons: [
      ...(Array.isArray(clip?.staleWhy) && clip.staleWhy.length
        ? clip.staleWhy
        : (clip?.status === "stale" ? ["board"] : [])),
      clip?.staleSegments ? "segments" : null,
      findBoard(doc, seg)?.staleRefs ? "board-refs" : null,
    ].filter(Boolean),
    takes,
    current,
    drift: shotDrift(plan, current),
  };
}

/* ─────────────────────────────────────────────────────── the edit */

/**
 * Apply a per-shot edit to the document. Runs INSIDE updateProject.
 *
 * ⚠ THIS MERGES, and upsertBoard replaces — the difference is deliberate and
 * is the whole reason this does not just call that. `set_board` is the board
 * EDITOR's save: it sends a complete board and means every field it omits.
 * This is a per-shot tweak from an inspector that shows one thing at a time,
 * so sending `refs` alone must not silently erase the shot list, the grade or
 * the rendered board picture — which is exactly what routing it through
 * upsertBoard would have done.
 *
 * @param edit.prompt      the hand-written prompt. The EMPTY STRING clears the
 *                         override and returns the shot to the builder;
 *                         undefined leaves whatever is there untouched.
 * @param edit.refs        names to reference, sorted into their own lists by
 *                         what the bible declares them as. Undeclared names
 *                         are refused, same rule as set_board.
 * @param edit.prominence  {name: 0..1}, merged over what is there.
 */
/**
 * Append a reason to the clip's staleness without losing the ones already
 * there. Two edits before a re-render must both survive: "the refs moved AND
 * the prompt changed" is a different repair from either one alone.
 *
 * EXPORTED so every writer that sets `status = "stale"` says WHY in the same
 * words. `staleReasons` used to read a bare "stale" as "board", which is a lie
 * for three of the four causes.
 */
export function markStale(clip, why) {
  if (!clip?.clipFile) return;          // nothing is playing, so nothing is out of date
  clip.status = "stale";
  clip.staleWhy = [...new Set([...(Array.isArray(clip.staleWhy) ? clip.staleWhy : []), why])];
}

/* ─────────────────────────────────────────── board.staleRefs, BOTH WAYS
 *
 * ⚠ THE RULE, IN ONE PLACE, BECAUSE IT ONLY EVER EXISTED IN ONE DIRECTION.
 *
 * `staleRefs` means ONE thing: THE PICTURE THIS BOARD IS SHOWING WAS DRAWN
 * BEFORE ITS REFERENCES LAST CHANGED. bible.js has said so in a comment since
 * the field existed ("the picture predates this board") — and four writers set
 * it true (commitBible, upsertBoard, pick_take's cast cascade, applyShotEdit)
 * while NOTHING ANYWHERE SET IT FALSE. Measured by the prover: attach a prop,
 * redraw the board, adopt the redraw with pick_take, re-render the clip so it
 * really opens on the new picture — and the map still printed "Drawn before its
 * references changed", forever, on a board that was correct. A warning that
 * cannot be answered is one people learn to scroll past, which costs the ones
 * that are true.
 *
 * So the flag is a CACHE of a comparison, and these two functions are the only
 * places that comparison is made:
 *
 *   refsChangedAt(board)  when the references last moved. `refsAt` is written by
 *                         markBoardRefsChanged; documents older than that field
 *                         fall back to `updatedAt`, which is the value those
 *                         four writers were bumping in the same breath.
 *   the adopted take's `at`  when the picture on show was actually made. A take
 *                         from before takes carried `at` reads as 0 and stays
 *                         stale, which is the conservative direction.
 *
 * ⚠ AND `refsAt` IS THE AUTHORITY, WITH ONE FALLBACK THAT ONLY CLEARS.
 * With `refsAt` present the flag is DERIVED, both directions: adopting the
 * redraw clears it and flipping back to the picture that predates the attach
 * sets it again, because it is stale again. With `refsAt` absent — every board
 * written before this rule existed — the fallback is `updatedAt`, which moves
 * on saves that changed nothing about the references (applyShotEdit bumps it
 * unconditionally and marks stale only on a real change). So on the fallback
 * this only ever CLEARS: it can answer an old complaint, never invent one.
 */

/** The take that IS the board's picture, or null. Board takes spell it `file`. */
const adoptedTake = (board) =>
  (board?.takes || []).find((t) => (t.file ?? t.clip) === board.imageFile) || null;

const refsChangedAt = (board) => Number(board?.refsAt ?? board?.updatedAt ?? 0) || 0;

/**
 * The references moved. Called by EVERY writer that changes what a board points
 * at — the bible commit, the board editor's save, a per-shot ref edit, and the
 * cast cascade when a face is re-picked under a board that carries it.
 *
 * `refsAt` is stamped even with no picture yet, so the first render after this
 * moment is recognisably newer than it.
 */
export function markBoardRefsChanged(board, { now = Date.now() } = {}) {
  if (!board) return board;
  board.refsAt = now;
  /* A board with NO picture cannot be showing an out-of-date one. The cast
   * cascade used to set the flag on those too, which put "Drawn before its
   * references changed" on a board that had never been drawn. */
  board.staleRefs = !!board.imageFile;
  return board;
}

/**
 * The picture caught up. Called wherever a board's adopted picture changes —
 * pick_take's board branch, generate_asset's first-take auto-select,
 * generate_board_frames' opening beat — and once more when a CLIP re-renders,
 * because that is the moment the map is read and the answer has to be current.
 *
 * Clears nothing it cannot prove: with no picture, no matching take, or a take
 * older than the reference change, the flag stays exactly as it was.
 */
export function refreshBoardStale(board) {
  if (!board?.imageFile) return board;
  const drawn = Number(adoptedTake(board)?.at ?? 0) || 0;
  if (!drawn) return board;              // no take says when: nothing is proved
  const refsAt = Number(board.refsAt ?? 0) || 0;
  if (refsAt) board.staleRefs = drawn < refsAt;
  else if (board.staleRefs && drawn >= Number(board.updatedAt ?? 0)) board.staleRefs = false;
  return board;
}

export function applyShotEdit(doc, segmentId, edit = {}) {
  const seg = findSegment(doc, segmentId);
  if (!seg) throw new Error(`No such segment: ${segmentId}`);
  const changed = [];

  /* undefined = leave it alone; a string = set it, and the EMPTY string is the
   * revert. Callers must not send undefined to mean "clear". */
  if (typeof edit.prompt === "string") {
    let clip = findClip(doc, seg);
    if (!clip) {
      /* A prompt may be written BEFORE the first render — that is the useful
       * order, not an edge case — so the row is created to hold it. Shape
       * matches generateClip's own, minus everything a render fills in. */
      clip = { id: `c_${seg.id}`, segmentId: seg.id, clipIndex: seg.index,
               boardId: findBoard(doc, seg)?.id ?? null, mode: "generate", takes: [] };
      /* Same tolerance the reads above show. Every project store.js creates
       * has these arrays, so this is consistency rather than a known case —
       * a resolver that guards and a writer that does not is a trap. */
      (doc.clips = doc.clips || []).push(clip);
    }
    const was = typeof clip.promptOverride === "string" ? clip.promptOverride : null;
    const next = edit.prompt.trim();
    if (next) { clip.promptOverride = next; changed.push("prompt edited by hand"); }
    else if (clip.promptOverride) { delete clip.promptOverride; changed.push("prompt reverted to the builder"); }
    /* ⚠ A PROMPT EDIT IS A CHANGE TO THE RENDER, and it was the one change
     * nothing marked. Only a REFERENCE edit set the clip stale, so a scene
     * whose saved prompt now asks for something the clip on disk was never told
     * about reported status "done", staleReasons [] and zero breaks — the map
     * went green over a shot that no longer matches its own instruction.
     * Reproduced by the prover on scene 5: the saved prompt called for a
     * declared, rendered prop the board does not carry, and nothing said so. */
    if (was !== (next || null)) markStale(clip, "prompt");
  }

  if (Array.isArray(edit.refs) || edit.prominence) {
    let board = findBoard(doc, seg);
    if (!board) {
      board = { id: `bd_${seg.id}`, segmentId: seg.id, segmentIndex: seg.index, clipIndex: seg.index,
                boardPrompt: null, grade: null, shots: [], characterRefs: [], backgroundRefs: [],
                propRefs: [], refProminence: {}, imageFile: null, takes: [] };
      (doc.boards = doc.boards || []).push(board);
      doc.boards.sort((a, b) => a.segmentIndex - b.segmentIndex);
    }
    /* What the board's references ARE before this edit, so the staleness below
     * fires on a real change rather than on every Save. upsertBoard marks the
     * board stale unconditionally; it can afford to, because it is the editor's
     * whole-board commit. This is a per-shot tweak and a no-op save must not
     * send a director back to redraw a picture that is still correct. */
    const refSig = (b) => JSON.stringify([b.characterRefs || [], b.backgroundRefs || [],
                                          b.propRefs || [], b.refProminence || {}]);
    const before = refSig(board);
    if (Array.isArray(edit.refs)) {
      const c = [], g = [], p = [];
      for (const raw of edit.refs) {
        const name = String(raw ?? "").trim();
        if (!name) continue;
        const kind = declaredKind(doc, name);
        /* Refuse rather than accept-and-drop. An undeclared name on a board is
         * the silent-nothing failure one layer up, and set_board already
         * refuses it — a second door with a looser lock is not a door. */
        if (!kind) throw new Error(`"${name}" is not a declared character, background or prop`);
        (kind === "character" ? c : kind === "background" ? g : p).push(name);
      }
      board.characterRefs = c; board.backgroundRefs = g; board.propRefs = p;
      changed.push(`references: ${[...c, ...g, ...p].join(", ") || "none"}`);
    }
    if (edit.prominence && typeof edit.prominence === "object") {
      board.refProminence = { ...(board.refProminence || {}) };
      for (const [k, v] of Object.entries(edit.prominence)) {
        board.refProminence[k] = Math.min(1, Math.max(0, Number(v) || 0));
      }
      changed.push("prominence");
    }
    board.updatedAt = Date.now();

    if (refSig(board) !== before) {
      /* ⚠ THE FATAL ONE, AND IT IS FATAL BECAUSE OF WHICH ENGINE MOST PROJECTS
       * ARE ON. `set_board` — the board editor's Save — has always set
       * `staleRefs` (bible.js: "the picture predates this board"). `set_shot`,
       * which is how a prop actually gets attached from the inspector and from
       * mv_set_shot, marked only the CLIP and left the board reading as
       * current.
       *
       * On H3 that would be survivable: the sheets ride into the clip as named
       * references, so a stale board picture costs framing and not identity.
       * On LTX it is the whole thing. 11 of the 15 projects in this library are
       * on ltx, where no picture is handed to the video model at all and the
       * ONLY carrier of a prop into a clip is the board image pinned as frame 0.
       *
       * MEASURED BY THE PROVER: declare a prop, render its sheet, attach it to
       * two boards, re-render the shot — and scene 7's clip opened on
       * board_11bd1cfe55a7.png, the board picture drawn before the prop existed.
       * The map turned green; the render was shown nothing. Marking the board
       * stale is what makes the redraw — the step that would actually carry the
       * prop — the thing being asked for.
       *
       * ⚠ THROUGH markBoardRefsChanged, which also stamps `refsAt`: the moment
       * a redraw has to be newer than before the flag can come off again. The
       * rule, both directions, is above this function. */
      markBoardRefsChanged(board);
      /* A ref change makes the playing take wrong in the same way a board commit
       * does, and the store already has one word for that — "board", because
       * references LIVE on the board and changing them is changing it. The two
       * reasons that come out of this branch are not the same repair and both
       * are wanted: "board" says re-render the clip, "board-refs" says redraw
       * the picture first, which on ltx is the step that actually carries the
       * new reference into the video. */
      markStale(findClip(doc, seg), "board");
    }
  }

  if (!changed.length) throw new Error("Nothing to change — send prompt, refs or prominence.");
  return changed;
}
