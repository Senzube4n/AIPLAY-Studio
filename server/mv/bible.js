/**
 * The production bible — authoring, validation, and lint.
 *
 * On the website this is a paid Opus call. Here the DRIVING AGENT is the
 * master LLM: mv_bible_spec hands it the contract plus this project's actual
 * segments, it writes the bible, mv_set_bible commits it. Everything commits
 * through validation: reference names must bind to declared assets, boards
 * must land on real segments, and anything already rendered from an older
 * board is marked stale rather than silently lied about.
 *
 * The middle stages STEER the clips — a board turns clipPrompt from "sing the
 * line to camera" into numbered shot beats with camera grammar and a grade.
 * Without this file the pipeline had a working spine and a hollow middle.
 */
import { readProject, updateProject, noteRun, assetComplete } from "./store.js";
import { markStale, markBoardRefsChanged, resolveShot } from "./shot.js";

const rid = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 7)}`;

/** The contract handed to the authoring agent, with the project baked in. */
export function bibleSpec(doc) {
  const segments = doc.segments.map((s) => ({
    segmentId: s.id, index: s.index, startSec: s.startSec, endSec: s.endSec,
    durationSec: s.durationSec, kind: s.kind, mode: s.mode,
    line: s.thesisLine || s.lyricText || null,
  }));
  return {
    project: { slug: doc.slug, title: doc.title, brief: doc.brief || null },
    segments,
    existingCharacters: doc.characters.map((c) => ({ name: c.name, description: c.description, hasImage: !!c.imageFile })),
    existingBackgrounds: doc.backgrounds.map((g) => ({ name: g.name, description: g.description, hasImage: !!g.imageFile })),
    contract: {
      shape: {
        story: { logline: "one sentence", synopsis: "2-4 sentences" },
        styleBible: "ONE line of visual style that opens every clip prompt — palette, medium, era, lens character",
        lookBible: "the SAME look with NO PERSON in it — palette, film stock, era, lens. Sent to shots that have no cast, so it must not describe anybody",
        characters: [{ name: "short unique name", role: "lead|support", description: "what they look like, wearable across every shot" }],
        backgrounds: [{ name: "short unique name", description: "the place, lit and dressed" }],
        props: [{ name: "short unique name", description: "a specific object that recurs — make, era, colour, condition, distinguishing marks" }],
        boards: [{
          segmentId: "from segments[] above — one board per mode:generate segment",
          boardPrompt: "one sentence: what this scene IS",
          grade: "color grade + atmosphere line appended to the clip prompt",
          shots: [{ shotType: "wide|medium|close-up|extreme-close|two-shot|POV|b-roll-detail|over-the-shoulder",
                    angle: "eye-level|low-angle|high-angle|overhead|dutch",
                    cameraMove: "static|slow-push-in|pull-out|pan|tracking|orbit|handheld|whip-pan|speed-ramp",
                    lensFeel: "wide-anamorphic|35mm|50mm|85mm-portrait|macro|shallow-DoF|deep-focus",
                    lighting: "Rembrandt|chiaroscuro|volumetric god-rays|rim-light|golden-hour|hard-key|silhouette|low-key|color-gel",
                    action: "REQUIRED, the most important field" }],
          characterRefs: ["names from characters[]"],
          backgroundRefs: ["names from backgrounds[]"],
          propRefs: ["names from props[] — declare the car in EVERY scene it appears in"],
          crowd: "true when the frame holds unnamed people beyond the named cast — a festival crowd, a street, a room of strangers. Without it the prompt states the exact number of people and caps the shot at the named cast.",
          lipSync: "true when a mouth in frame sings THIS scene's line. Projects on Song under the clip \"always\" (new projects since 2026-09-24) put the song under every scene anyway; lipSync is what makes a scene sing on an \"auto\" project.",
          refProminence: { "<name>": 0.5 },
        }],
      },
      rules: [
        "ACTION is the most important field: what HAPPENS in that beat — a clear subject performing a motion, what changes, the emotional beat, 1-2 vivid present-tense sentences that ADVANCE the segment's line. Name the motion and where it goes; never a static tableau.",
        "Name binding is strict: characterRefs/backgroundRefs must exactly match a declared name. Reuse the SAME names across boards — reuse is what makes the video coherent.",
        "refProminence 0..1 per referenced name: hero subject ~1.0, secondary ~0.5, barely-seen ~0.2. When the reference budget overflows (9), the LEAST prominent are dropped first.",
        "2-4 shots for a 10-15s scene; 1-2 for under 6s. Each scene's shots should read as ONE continuous generated clip, not a cut sequence.",
        "Lyrical segments: someone performs the line — say who and how. Instrumental segments: b-roll in the world; characterRefs optional.",
        "Keep existing character/background names when they fit — they may already have rendered sheets (hasImage).",
        "styleBible + grade carry the look; do not repeat style words inside every action.",
        "lookBible must contain NO PERSON. It is the only style line a cast-less shot receives, and it is what keeps the era on a shot that is just an object — a 1970s story whose look line is withheld renders a modern car.",
        "PROPS ARE CAST. Any object that appears in more than one scene and must be the SAME object — a car, a guitar, a jacket, a suitcase — belongs in props[] and must be listed in propRefs on every board it appears in. An undeclared car is a different car in every scene.",
        "PHYSICALLY POSSIBLE ONLY. A person can only touch what is on their side of the glass. Never write a reach, a grab or a switch across a windscreen, a window or a wall. If a control is operated, say where it is ('the dashboard switch by her knee'), because an unplaced control is placed by the model — 'switches the headlights off' put the driver outside on the bonnet.",
        "ONE SPACE PER SHOT. Say where the camera is and keep every subject on one side of it. A camera inside a car and an actor outside it is the commonest impossible frame.",
        "If two things share the ground — a car and a person, two vehicles — say which is in front. Unstated depth is resolved by the model, and it resolves it differently every frame.",
      ],
      commit: "mv_set_bible with this whole object; then mv_lint; render sheets (mv_generate_asset) before clips.",
    },
  };
}

const norm = (s) => String(s || "").trim();
const lc = (s) => norm(s).toLowerCase();

/** Commit a whole bible. Merges by NAME so rendered sheets survive re-authoring. */
export async function commitBible(slug, bible) {
  if (!bible || typeof bible !== "object") throw new Error("bible must be an object");
  return updateProject(slug, (doc) => {
    const errs = [];

    const mergeAssets = (incoming = [], existing, prefix, label) => {
      const out = [];
      for (const inc of incoming) {
        const name = norm(inc.name);
        if (!name) { errs.push(`${label} with no name`); continue; }
        const old = existing.find((x) => lc(x.name) === lc(name));
        out.push(old
          ? { ...old, name, role: inc.role ?? old.role, description: norm(inc.description) || old.description }
          : { id: rid(prefix), name, role: inc.role || null, description: norm(inc.description),
              imageFile: null, status: "pending", takes: [], sheetPrompt: inc.sheetPrompt || null });
      }
      // entries the new bible dropped but that already have a rendered sheet
      // survive — deleting rendered work needs to be a decision, not a diff
      for (const old of existing) {
        if (old.imageFile && !out.some((x) => lc(x.name) === lc(old.name))) out.push(old);
      }
      return out;
    };

    if (bible.characters) doc.characters = mergeAssets(bible.characters, doc.characters, "c", "character");
    if (bible.backgrounds) doc.backgrounds = mergeAssets(bible.backgrounds, doc.backgrounds, "g", "background");
    /* Props merge by the same rule as cast, for the same reason: a rendered
     * sheet is real work and a re-authored bible must not silently delete it. */
    if (bible.props) doc.props = mergeAssets(bible.props, doc.props || [], "p", "prop");
    if (bible.story) doc.story = { logline: norm(bible.story.logline), synopsis: norm(bible.story.synopsis) };
    if (bible.styleBible) doc.styleBible = norm(bible.styleBible);
    if (bible.lookBible) doc.lookBible = norm(bible.lookBible);

    if (bible.boards) {
      const names = new Set([...doc.characters, ...doc.backgrounds, ...(doc.props || [])].map((x) => lc(x.name)));
      const boards = [];
      for (const b of bible.boards) {
        const seg = doc.segments.find((s) => s.id === b.segmentId)
          ?? doc.segments.find((s) => s.index === b.segmentIndex);
        if (!seg) { errs.push(`board for unknown segment ${b.segmentId ?? b.segmentIndex}`); continue; }
        for (const n of [...(b.characterRefs || []), ...(b.backgroundRefs || []), ...(b.propRefs || [])]) {
          if (!names.has(lc(n))) errs.push(`board ${seg.index + 1} references "${n}" which is not a declared character, background or prop`);
        }
        const shots = (b.shots || []).map((sh) => ({
          shotType: sh.shotType || "medium", angle: sh.angle, cameraMove: sh.cameraMove,
          lensFeel: sh.lensFeel, lighting: sh.lighting, action: norm(sh.action),
        }));
        const prom = {};
        for (const n of [...(b.characterRefs || []), ...(b.backgroundRefs || []), ...(b.propRefs || [])]) {
          prom[n] = Math.min(1, Math.max(0, Number(b.refProminence?.[n] ?? 0.5)));
        }
        const old = doc.boards.find((x) => x.segmentId === seg.id);
        boards.push({
          id: old?.id || rid("bd"), segmentId: seg.id, segmentIndex: seg.index, clipIndex: seg.index,
          boardPrompt: norm(b.boardPrompt), grade: norm(b.grade), shots,
          characterRefs: (b.characterRefs || []).map(norm), backgroundRefs: (b.backgroundRefs || []).map(norm),
          propRefs: (b.propRefs || []).map(norm),
          crowd: !!b.crowd,
          /* (2026-09-24: new projects start on songConditioning "always",
           * store.js blankProject, the REWIND A/B; the expression below is
           * unchanged, and lipSync still decides on an "auto" project.)
           *
           * ⚠ READ IN generate.js AND WRITTEN NOWHERE UNTIL NOW. The song is
           * frozen under an H3 render when `engine === "ltx" || !useRefs ||
           * Boolean(board?.lipSync) || brief.songConditioning === "always"`,
           * and that third clause was dead: no writer carried the flag, so the
           * per-scene opt-in could never be true and the only working lever was
           * the all-or-nothing brief flag.
           *
           * It matters because the granularity is the whole point. A music
           * video is mostly not singing - 23 of Bewitching's 50 scenes are -
           * and freezing a song under a shot of her hands costs render time for
           * a mouth that is not in frame. Measured the hard way: the first cut
           * of Bewitching rendered all 50 with no audio input at all, so every
           * close-up mouths something unrelated to the lyric. */
          lipSync: !!b.lipSync,
          refProminence: prom,
          imageFile: old?.imageFile || null, takes: old?.takes || [],
          updatedAt: Date.now(),
        });
        /* THE PICTURE PREDATES THIS BOARD — set through the one writer that
         * owns the flag, so `refsAt` is stamped with it and the redraw that
         * answers it can be recognised as newer. shot.js states the rule. */
        markBoardRefsChanged(boards[boards.length - 1]);
        // a clip rendered from the old board no longer tells the truth
        const clip = doc.clips.find((c) => c.segmentId === seg.id);
        markStale(clip, "board");
      }
      if (errs.length) throw new Error(`bible rejected:\n- ${errs.join("\n- ")}`);
      doc.boards = boards;
    } else if (errs.length) {
      throw new Error(`bible rejected:\n- ${errs.join("\n- ")}`);
    }

    noteRun(doc, { tool: "mv_set_bible", outcome:
      `${doc.characters.length} characters, ${doc.backgrounds.length} backgrounds, ${doc.boards.length} boards — "${doc.story?.logline?.slice(0, 60) || ""}"` });
    return doc;
  });
}

/** Upsert one board without touching the rest of the bible. */
export async function upsertBoard(slug, segmentId, board) {
  const doc = await readProject(slug);
  if (!doc) throw new Error("No such project.");
  const partial = { boards: [{ ...board, segmentId }] };
  // reuse commit validation, but keep every other board
  return updateProject(slug, (d) => {
    const seg = d.segments.find((s) => s.id === segmentId) ?? d.segments.find((s) => s.index === board.segmentIndex);
    if (!seg) throw new Error(`No such segment: ${segmentId}`);
    const names = new Set([...d.characters, ...d.backgrounds, ...(d.props || [])].map((x) => lc(x.name)));
    for (const n of [...(board.characterRefs || []), ...(board.backgroundRefs || []), ...(board.propRefs || [])]) {
      if (!names.has(lc(n))) throw new Error(`"${n}" is not a declared character, background or prop`);
    }
    const old = d.boards.find((x) => x.segmentId === seg.id);
    const prom = {};
    for (const n of [...(board.characterRefs || []), ...(board.backgroundRefs || []), ...(board.propRefs || [])]) {
      prom[n] = Math.min(1, Math.max(0, Number(board.refProminence?.[n] ?? 0.5)));
    }
    const next = {
      id: old?.id || rid("bd"), segmentId: seg.id, segmentIndex: seg.index, clipIndex: seg.index,
      boardPrompt: norm(board.boardPrompt), grade: norm(board.grade),
      shots: (board.shots || []).map((sh) => ({ shotType: sh.shotType || "medium", angle: sh.angle,
        cameraMove: sh.cameraMove, lensFeel: sh.lensFeel, lighting: sh.lighting, action: norm(sh.action) })),
      characterRefs: (board.characterRefs || []).map(norm), backgroundRefs: (board.backgroundRefs || []).map(norm),
      propRefs: (board.propRefs || []).map(norm),
      /* ⚠ PRESERVED when the caller does not mention it. This was an
       * unconditional `!!board.crowd`, and the board editor's payload has no
       * crowd key at all — so every time a human opened a crowd scene and
       * pressed Save, `!!undefined` turned the festival back into the named
       * cast only, with no message and no way to notice until it rendered.
       * Same treatment as imageFile and takes on the next line: a field the
       * editor does not send is a field it does not intend to clear. */
      crowd: board.crowd === undefined ? !!old?.crowd : !!board.crowd,
      /* ⚠ AND THE SAME FOR lipSync, WHICH THIS DOOR DROPPED ENTIRELY.
       *
       * commitBible got the writer (see the long note there); upsertBoard, the
       * door the board editor and every per-scene agent call actually use, had
       * no `lipSync` key at all. So `set_board { lipSync: true }` returned ok,
       * the board came back without it, and generate.js's third clause stayed
       * dead through the one path anybody builds a film with. Fixing the flag
       * in one of two writers is not fixing the flag.
       *
       * `undefined` PRESERVES rather than clears, exactly as crowd above does
       * and for the same reason: the board editor's payload does not carry
       * this key, and a Save from that screen must not silently turn the song
       * off under a scene somebody set to sing. */
      lipSync: board.lipSync === undefined ? !!old?.lipSync : !!board.lipSync,
      refProminence: prom, imageFile: old?.imageFile || null, takes: old?.takes || [],
      updatedAt: Date.now(),
    };
    /* The editor's whole-board commit: the picture predates it by definition.
     * One writer, and it stamps `refsAt` — see the rule in shot.js. */
    markBoardRefsChanged(next);
    d.boards = [...d.boards.filter((x) => x.segmentId !== seg.id), next].sort((a, b2) => a.segmentIndex - b2.segmentIndex);
    const clip = d.clips.find((c) => c.segmentId === seg.id);
    markStale(clip, "board");
    noteRun(d, { tool: "mv_set_board", outcome: `scene ${seg.index + 1}: ${next.shots.length} shots, refs ${[...next.characterRefs, ...next.backgroundRefs, ...next.propRefs].join(", ") || "none"}` });
    return d;
  });
}

/** The free pre-flight: what would waste GPU if rendered right now. */
export function lintProject(doc) {
  const issues = [];
  const push = (level, where, msg) => issues.push({ level, where, msg });
  const names = new Map([...doc.characters, ...doc.backgrounds, ...(doc.props || [])].map((x) => [lc(x.name), x]));

  if (!doc.styleBible) push("warn", "style", "No styleBible — clips will not share a look.");
  /* A cast-less shot receives the look line and nothing else. Without one it
   * receives NOTHING, which is how a 1970s film renders a modern car in every
   * frame that has no actor in it to carry the era. */
  if (!doc.lookBible && doc.boards?.some((b) => !b.characterRefs?.length)) {
    push("warn", "style",
      `No lookBible, and ${doc.boards.filter((b) => !b.characterRefs?.length).length} board(s) have no cast. `
      + "Those shots are rendered with no style line at all — era and palette will drift.");
  }
  if (!doc.story?.logline) push("warn", "story", "No logline — nothing steers the boards toward one story.");

  const scenes = doc.segments.filter((s) => s.mode === "generate");
  for (const seg of scenes) {
    const board = doc.boards.find((b) => b.segmentId === seg.id);
    if (!board) { push("warn", `scene ${seg.index + 1}`, "No storyboard — the clip will fall back to a generic performance shot with every character as reference."); continue; }
    if (!board.shots.length) push("warn", `scene ${seg.index + 1}`, "Board has no shots — nothing steers the camera.");
    for (const sh of board.shots) {
      if (!sh.action || sh.action.length < 12) push("warn", `scene ${seg.index + 1}`, `A shot's action is ${sh.action ? "too thin" : "missing"} — action is the field that writes the clip.`);
    }
    /* THE MIRROR TRAP, measured on salt-and-static scene 6.
     *
     * "Wren glances at the rear-view mirror" — one declared character, and the
     * BOARD came back with two faces that do not match each other: the
     * reflection is a different woman from the driver. Both the pinned and
     * unpinned renders inherited it, because the board IS the first frame, so
     * nothing downstream could recover.
     *
     * A reflection asks a one-subject image for two views of one face, which is
     * the single hardest thing to hold. There is no face detector here to count
     * them with — the InsightFace family is banned outright (non-commercial
     * weights under an MIT badge) and OpenCV 5 no longer ships its cascades — so
     * this is a TEXT check, and it warns rather than refuses: a mirror shot is a
     * legitimate thing to want, it just needs looking at before it is rendered. */
    // Plain word list, not a regex: an earlier attempt here put a literal
    // BACKSPACE in the source instead of a word boundary, which is the exact
    // trap the pipeline notes warn about, and it silently matched nothing.
    // MIRRORS ONLY. "reflection" was in this list for one run and fired on
    // "neon reflections breaking apart under her boots" — light on wet ground,
    // no face anywhere in it. A mirror is the case that asks for two views of
    // ONE face; a puddle is not, and a lint that cries about puddles gets
    // ignored when it is right.
    const MIRROR_WORDS = ["mirror", "mirrors", "rear-view", "rearview"];
    for (const sh of board.shots) {
      const said = (sh.action || "").toLowerCase();
      if (MIRROR_WORDS.some((w) => said.includes(w)) && board.characterRefs.length === 1) {
        push("warn", `scene ${seg.index + 1}`,
          `Reflection shot with ONE declared character ("${board.characterRefs[0]}") — `
          + "a mirror asks for two views of the same face and they routinely do not match. "
          + "Check the board before rendering; the clip inherits whatever the board decided.");
      }
    }
    /* ⚠ REACHING THROUGH GLASS, measured on salt-and-static scene 21.
     *
     * "Wren reaches over and switches the headlights off" — the camera sits
     * inside the car, the headlights are outside it, and the model resolved
     * that by putting Wren OUTSIDE on the bonnet, leaning over the wing and
     * reaching down to a glow on the paintwork. She also arrived wearing
     * glasses her character description never mentions.
     *
     * The prompt never said where the switch was. An unplaced control gets
     * placed by the model, and it places it AT THE PART — so a headlight
     * switch puts the actor at the headlights. Same family as the mirror
     * trap: an interaction whose geometry was never established. Warns,
     * because operating a car at night is a reasonable thing to want; it
     * just has to say where the switch is. */
    const HANDS_ON = ["reach", "reaches", "switch", "switches", "flick", "flicks", "turn off", "turns off",
                      "turn on", "turns on", "grab", "grabs", "touch", "touches", "press", "presses",
                      "pull", "pulls", "push", "pushes"];
    const OUTSIDE_PARTS = ["headlight", "headlights", "high beam", "high beams", "hood", "bonnet",
                           "windshield wiper", "windscreen wiper", "wiper blade", "trunk", "tailgate",
                           "roof rack", "number plate", "licence plate", "license plate"];
    /* A DOOR IS A THING YOU GO THROUGH. The first version of this list carried
     * a bare "through the glass" and fired on scene 1 — "Wren steps out through
     * the glass door" — which is a person using a door correctly. It needs a
     * HAND on the glass, not merely a body passing an opening. */
    const THROUGH_GLASS = ["through the windshield", "through the windscreen", "through the window",
                           "through the glass", "through the pane"];
    const OPENINGS = ["door", "doorway", "gate", "hatch", "open window"];
    for (const sh of board.shots) {
      const said = (sh.action || "").toLowerCase();
      if (THROUGH_GLASS.some((w) => said.includes(w))
          && HANDS_ON.some((w) => said.includes(w))
          && !OPENINGS.some((w) => said.includes(w))) {
        push("warn", `scene ${seg.index + 1}`,
          "An action reaches THROUGH glass. Nothing can; the model will resolve it by moving the "
          + "person to the other side. Put them on one side and keep them there.");
      } else if (board.characterRefs.length
                 && OUTSIDE_PARTS.some((w) => said.includes(w))
                 && HANDS_ON.some((w) => said.includes(w))) {
        push("warn", `scene ${seg.index + 1}`,
          `Someone operates a part that lives on the OUTSIDE of the vehicle. Say where the control `
          + `is instead ("the dashboard switch by her knee") — an unplaced control gets placed at the `
          + `part, which puts the actor outside the car.`);
      }
    }
    for (const n of [...board.characterRefs, ...board.backgroundRefs, ...(board.propRefs || [])]) {
      const a = names.get(lc(n));
      /* THREE ANSWERS, NOT TWO, since a row can hold a mesh.
       *
       * The middle one is the new one and it is deliberately quieter than the
       * gap it replaces. A row with a `meshFile` and no sheet is NOT the failure
       * this warning was written about — that failure is "declared and never
       * given a body", and this row has the strongest body available. What is
       * still true is narrower and worth one sentence: the clip engines take
       * PICTURES (control.js's IMAGE_RE), so a mesh cannot travel into the
       * render as a reference the way a sheet can. Saying "has no rendered
       * sheet — render it first" over a finished mesh would be a lint reporting
       * a gap somebody already closed, which is how people learn to ignore it. */
      if (!a) push("error", `scene ${seg.index + 1}`, `References "${n}" which does not exist.`);
      else if (!assetComplete(a)) push("warn", `scene ${seg.index + 1}`, `"${n}" has no rendered sheet — the clip cannot carry their identity. Render it first.`);
      else if (!a.imageFile) push("warn", `scene ${seg.index + 1}`, `"${n}" has a mesh but no sheet. The mesh holds the shape; the clip engine takes pictures, so render one panel from it before this scene.`);
    }
    const clip = doc.clips.find((c) => c.segmentId === seg.id);
    if (clip?.status === "stale") push("warn", `scene ${seg.index + 1}`, "Clip was rendered from an older board — regenerate it.");
  }
  for (const c of doc.characters) {
    if (!doc.boards.some((b) => b.characterRefs.some((n) => lc(n) === lc(c.name)))
        && doc.boards.length) push("warn", c.name, "Declared but never referenced by any board.");
  }
  for (const pr of doc.props || []) {
    if (!doc.boards.some((b) => (b.propRefs || []).some((n) => lc(n) === lc(pr.name)))
        && doc.boards.length) push("warn", pr.name, "Prop declared but never referenced by any board.");
  }

  /* THE THINGS THE BOARDS DO NOT CARRY. Shared with the relationship map — see
   * undeclaredRecurring() below, which owns the scan.
   *
   * The named-but-not-referenced findings print one line EACH: each names a row
   * that already exists, so the repair is a specific attach and merging them
   * would hide which asset. The wordlist heuristic still prints once — the point
   * there is that SOMETHING recurs undeclared, and a list of every noun in the
   * list buries it. */
  const found = undeclaredRecurring(doc);
  const scenesOf = (u) => `${u.scenes.slice(0, 6).join(", ")}${u.scenes.length > 6 ? ", …" : ""}`;
  for (const u of found) {
    if (u.kind !== "namedNotReferenced") continue;
    /* A CHARACTER NAMED AND NOT TICKED: one line per board, each with its fix.
     * The REWIND A/B (2026-09-24, DIRECTING.md §2) measured what the words
     * alone give: another hair colour, another mask, another coat from clip to
     * clip. The fix ticks the name on that board (set_shot keeps the board's
     * other references), so it is one click on the page and one call for an
     * agent (mv_lint maps it to mv_set_shot). Backgrounds and props keep the
     * per-asset line below. */
    if (u.assetKind === "character") {
      u.scenes.forEach((n, i) => {
        const b = (doc.boards || []).find((x) => x.segmentId === u.segmentIds?.[i]);
        if (!b) return;
        issues.push({
          level: "warn", where: `scene ${n}`,
          msg: `Names ${u.name} in its words but does not tick ${u.name} as cast, so the clip gets no picture of `
            + `${u.name} and invents them from the words: another face, hair or costume from shot to shot.`
            + (u.hasSheet ? "" : ` ${u.name} has no rendered sheet yet either.`),
          fix: { label: `Tick ${u.name}`, action: "set_shot", segmentId: b.segmentId,
                 refs: [...(b.characterRefs || []), ...(b.backgroundRefs || []), ...(b.propRefs || []), u.name] },
        });
      });
      continue;
    }
    push("warn", u.name,
      `Named in the text of ${u.scenes.length} board${u.scenes.length === 1 ? "" : "s"} (${scenesOf(u)}) `
      + `and referenced by none of them. It is declared as a ${u.assetKind}`
      + (u.hasSheet
          ? " and its sheet is rendered — the picture exists and the render is not being handed it"
          : ", and it has no rendered sheet either, so nothing anywhere pins what it looks like")
      + `. List it in the ${u.assetKind} references of those scenes, or each render invents it from the words.`);
  }
  for (const u of found) {
    if (u.kind !== "undeclaredObject") continue;
    push("warn", "props",
      `A ${u.word} appears in ${u.scenes.length} scenes (${scenesOf(u)}) but no prop declares it. `
      + `Each render invents its own, so the ${u.word} changes between shots. Declare it in props[], `
      + `render its sheet, and list it in propRefs. (Wordlist heuristic: it knows eight vehicle words and `
      + `nothing else, so an undeclared guitar or suitcase is invisible to it.)`);
    break;
  }

  /* TICKED CAST WHOSE PICTURES WILL NOT BE SENT. The default brief (hybrid,
   * castRefs unset) sends them: resolveShot routes a scene with resolved cast
   * to H3 with its pictures. The only ways out are an explicit setting, said
   * here with the fix, or a missing sheet, said per scene above. */
  const castBoards = (doc.boards || []).filter((b) => b.characterRefs?.length);
  const ltx = String(doc.brief?.videoEngine || "").toLowerCase() === "ltx";
  const off = doc.brief?.castRefs === false;
  if (castBoards.length && (ltx || off)) {
    const reason = [ltx ? "the engine is set to LTX, which takes no pictures" : null,
      off ? "cast pictures are switched off" : null].filter(Boolean).join(", and ");
    /* Switching an LTX project costs something the person chose LTX to avoid,
     * so the line says the trade before the one click (never picked
     * silently): hybrid renders the cast scenes on MiniMax H3, about 7x slower
     * than LTX (mv_set_brief video_engine), under a licence with a territory
     * clause. */
    issues.push({
      level: "warn", where: "brief",
      msg: `${castBoards.length} board(s) tick cast, but ${reason}, so no clip is given their pictures and faces `
        + "can change from shot to shot."
        + (ltx ? " Switching to hybrid renders those scenes on MiniMax H3: about 7x slower than LTX, and H3's licence "
          + "grants no rights in its excluded territories (studio_status). Where that applies, keep LTX." : ""),
      fix: { label: ltx ? "Render cast scenes on H3 (hybrid)" : "Send cast pictures", action: "set_brief",
             brief: { ...(ltx ? { videoEngine: "hybrid" } : {}), ...(off ? { castRefs: true } : {}) } },
    });
  }

  /* SUNG WITHOUT THE SONG, on "auto" projects only (new projects start on
   * "always"). The words say someone sings, the scene would render with no
   * song under it (shot.js songUnder, generate.js's rule), so the mouth cannot
   * follow the words. A lyrical scene with no board sings by construction
   * (clipPrompt: "sings the line"). */
  if (doc.song?.file && doc.brief?.songConditioning !== "always") {
    const SING = ["sing", "sings", "singing", "sang", "sung"];
    for (const seg of scenes) {
      const board = (doc.boards || []).find((b) => b.segmentId === seg.id);
      const sings = board ? SING.some((w) => saidWords(boardSays(board)).has(w)) : seg.kind === "lyrical";
      if (!sings) continue;
      let rec = null;
      try { rec = resolveShot(doc, seg.id); } catch { rec = null; }
      if (!rec || rec.songUnder !== false) continue;
      issues.push({
        level: "warn", where: `scene ${seg.index + 1}`,
        msg: "The words say someone sings, but Song under the clip is auto and this board is not marked as sung: "
          + "no song goes under the clip, so the mouth will not follow the words.",
        fix: { label: "Put the song under every scene", action: "set_brief", brief: { songConditioning: "always" } },
      });
    }
  }
  return issues;
}

/* ────────────────────────────────────── the things the boards do not carry */

/* Function words, and the only wordlist left in the first check. Everything it
 * looks for now comes from what the project ITSELF declared. */
const STOP = new Set(["the", "a", "an", "of", "and", "in", "on", "at", "to",
                      "with", "for", "from", "his", "her", "its", "into"]);

/* ⚠ WORD SETS, NOT A REGEX, and this file has had to learn it twice. A pattern
 * built as a template literal with an escape in it put a real control character
 * in the source where the word boundary was meant to be, so the pattern matched
 * nothing at all and the check silently passed everything. Splitting on
 * non-letters gives real boundaries with no escape to get wrong. */
const tokensOf = (t) => String(t ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/* A NAME is tokenised one step further than prose: camel case is a word
 * boundary. Directors write "NightTrain" and "TheMetronome" on the cast list and
 * "the night train" in the action, and a check that cannot see through that
 * misses the commonest naming style in this whole library. */
const nameTokens = (t) => tokensOf(String(t ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2"));

/** Everything one board says out loud — the payload that writes the clip prompt,
 *  which is exactly the text the render will be reasoning from. */
export const boardSays = (b) => [b?.boardPrompt, b?.grade,
  ...((b?.shots || []).flatMap((s) => [s.action, s.shotType, s.angle, s.cameraMove, s.lensFeel, s.lighting]))]
  .filter(Boolean).join(" ");

/** A text as a word set, built once per board and asked about many assets. */
export const saidWords = (text) => new Set(tokensOf(text));

/**
 * Does this text NAME this asset?
 *
 * ⚠ ALL THE NAME'S OWN WORDS, NOT ANY ONE OF THEM, and the corpus is why.
 * A loose any-word match over the-long-ascent's backgrounds reads "the gold
 * line slides lower" as naming Gold Scree, "across the face" as naming Whiteout
 * Face, and "the blue lower snowfield" as naming White Bowl — 20 findings, of
 * which four survive being looked at. This file already carries the lesson in
 * prose ("a warning that cries on compliant projects is one people learn to
 * scroll past"), so the check is spelled to be believed rather than to be loud.
 *
 * Plurals count, and so does the de-spaced form: a prop declared "NightTrain"
 * is named by a board that says "night train", and one declared "night train"
 * is named by a board that says "NightTrain".
 */
export function namesAsset(said, name) {
  const w = nameTokens(name).filter((x) => x.length >= 3 && !STOP.has(x));
  if (!w.length) return false;
  const compact = nameTokens(name).join("");
  if (compact.length >= 4 && said.has(compact)) return true;
  return w.every((x) => said.has(x) || said.has(x + "s") || said.has(x + "es"));
}

/** Every declared row, flattened, with the kind it was declared as. */
/* `has` is store.js's assetComplete(), not `!!imageFile`: a row that holds a
 * mesh has been given a body, and every reader of this list is asking whether
 * the declaration was ever honoured. */
export const declaredAssets = (doc) => [
  ...(doc?.characters || []).map((r) => ({ name: r.name, kind: "character", has: assetComplete(r) })),
  ...(doc?.backgrounds || []).map((r) => ({ name: r.name, kind: "background", has: assetComplete(r) })),
  ...(doc?.props || []).map((r) => ({ name: r.name, kind: "prop", has: assetComplete(r) })),
];

/* The one remaining object wordlist, and it is now the SECOND check rather than
 * the only one. Kept because it catches what the first cannot: a thing the story
 * leans on that was never declared at all, so there is no name to match. */
const VEHICLES = ["car", "truck", "van", "pickup", "sedan", "coupe", "motorcycle", "motorbike"];

/**
 * THINGS THE RENDER WILL INVENT — two checks, failing in opposite directions,
 * which is why neither one alone was enough.
 *
 * (1) namedNotReferenced — THE BOARD NAMES SOMETHING YOU ALREADY DECLARED.
 *     The board's own text says "the summit cornice"; Summit Cornice is a
 *     declared background with a row of its own; and the board does not list it
 *     in backgroundRefs. So the render is told the words, handed no picture, and
 *     re-invents a thing you had already drawn. This is the general case, it
 *     needs no wordlist, and it sees a metronome, a guitar, a suitcase and a
 *     coat — every one of which the vehicle scan below is blind to.
 *
 * (2) undeclaredObject — NOTHING DECLARES IT AT ALL. The complement: there is
 *     no row to match a name against, so a small wordlist is the only handle.
 *     salt-and-static put a car in 8 of 22 scenes and declared it nowhere; every
 *     render invented one, so it was an 80s coupe in one shot and a modern
 *     silver sedan in the next, and scene 11 came back with TWO of them.
 *     Explicitly a HEURISTIC, and labelled as one wherever it prints.
 *
 * ⚠ THE PER-BOARD SKIP IS GONE, AND WHAT REPLACED IT.
 * (2) used to drop any board that referenced ANY prop, so a scene that declared
 * a guitar and forgot its car was invisible — that false negative was written
 * down as a deliberate trade. It existed to stop one specific false alarm:
 * night-train-girl declares "NightTrain", a 1970s railcar, and was told on all
 * 5 of its "car" boards that no prop declares a car.
 *
 * The replacement is one rule, at the WORD level rather than the board level, so
 * no board is ever dropped from a finding's scene list: A DECLARED PROP WHOSE
 * OWN WORDS ARE THAT THING SILENCES THE WORD. "railcar" declares "car", "minivan"
 * declares "van". The length guard (a compound must be at least three letters
 * longer) is what stops "scar" and "oscar" doing the same.
 *
 * MEASURED across the library with the per-board skip removed and this rule in:
 * night-train-girl silent (was 5 false scenes), salt-and-static car×8,
 * ninety-nine-rooms car×7 and sedan×4 — the two real findings intact, with their
 * full scene lists.
 *
 * ⚠ THE FALSE ALARM THIS DOES NOT CATCH, stated so nobody rediscovers it as a
 * bug: a car declared as "the grey Volvo, a grey estate, 1988" contains no
 * vehicle word at all, so the scan still says no prop declares a car. The repair
 * is one word in the description, and the alternative — trusting that a board
 * which attached SOME prop must have meant this one — silences the guitar case
 * above, which is the failure this change exists to end.
 *
 * EXPORTED because the relationship map draws the same findings as ghost nodes
 * and broken edges. Two copies of this scan would disagree the first time
 * anybody added a noun, and the map would then be quietly kinder than the lint.
 *
 * @returns {{kind:string, name:string, word:string, assetKind?:string,
 *            hasSheet?:boolean, scenes:number[]}[]} scene numbers are 1-based,
 *   the way a human counts them and the way every message here prints them.
 */
export function undeclaredRecurring(doc) {
  const lcName = (s) => String(s ?? "").trim().toLowerCase();
  const sceneNo = (b) => (b.segmentIndex ?? b.clipIndex ?? 0) + 1;
  const boards = doc.boards || [];
  const assets = declaredAssets(doc);
  const out = [];

  /* ── (1) declared, named on the board, and not referenced by it ────────── */
  const named = new Map();   // name → { asset, scenes[] }
  for (const b of boards) {
    const said = saidWords(boardSays(b));
    const refs = new Set([...(b.characterRefs || []), ...(b.backgroundRefs || []),
                          ...(b.propRefs || [])].map(lcName));
    for (const a of assets) {
      if (refs.has(lcName(a.name))) continue;
      if (!namesAsset(said, a.name)) continue;
      if (!named.has(a.name)) named.set(a.name, { asset: a, scenes: [], segmentIds: [] });
      named.get(a.name).scenes.push(sceneNo(b));
      /* Beside the scene number, the board's segment, so a fix can name the
       * board it ticks (lintProject; the crime board keeps reading scenes). */
      named.get(a.name).segmentIds.push(b.segmentId);
    }
  }
  for (const { asset, scenes, segmentIds } of named.values()) {
    out.push({ kind: "namedNotReferenced", name: asset.name, word: asset.name,
               assetKind: asset.kind, hasSheet: asset.has, scenes, segmentIds });
  }

  /* ── (2) the wordlist heuristic, for the thing with no row at all ──────── */
  /* The length guard is what keeps "scar" and "oscar" from declaring a car. */
  const says = (toks, w) => toks.some((x) => x === w || x === w + "s"
    || ((x.length >= w.length + 3) && (x.endsWith(w) || x.endsWith(w + "s"))));
  const propTokens = nameTokens((doc.props || []).map((p) => `${p.name} ${p.description || ""}`).join(" "));
  for (const w of VEHICLES) {
    if (says(propTokens, w)) continue;
    /* ⚠ NO BOARD IS SKIPPED. Suppression is per WORD and on the declaration, so
     * a finding always carries its full scene list. */
    const scenes = boards.filter((b) => says(tokensOf(boardSays(b)), w)).map(sceneNo);
    /* An object in ONE shot is set dressing and needs no sheet. An object in
     * several is cast, and the film will show every difference between them. */
    if (scenes.length >= 2) out.push({ kind: "undeclaredObject", name: w, word: w, scenes });
  }
  return out;
}
