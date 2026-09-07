/**
 * The camera-move vocabulary, IN WORDS.
 *
 * ── WHY THIS FILE IS PROSE AND NOT GEOMETRY ────────────────────────────────
 * The Blender toolkit outside this tree owns the geometry: each of these names
 * is a continuous parametric camera path in its previz/moves.py, and previz.js
 * renders it. But a rendered move is not what reaches the video model. H3 takes
 * REFERENCE IMAGES and a PROMPT. It does not take a camera curve. So the only
 * part of a blocked move that can actually influence a clip is the sentence a
 * human or an agent writes into the board — and that sentence is what this file
 * produces.
 *
 * ⚠ THE THING THIS FILE MUST NOT BE MISTAKEN FOR. A gate experiment in the
 * upstream repo tested whether a grey-box blocking clip, fed to LTX as a sparse
 * appearance guide, would carry its camera move into the render. It does NOT:
 * the arms that appeared to follow the move did so by handing the grey boxes
 * straight back. That result is about LTX's appearance-guide path and says
 * nothing about H3's reference path, which is a different mechanism — but it is
 * enough to rule out the obvious shortcut ON THAT PATH. The previz clip is for
 * a DIRECTOR'S EYES (use: human-review), the still is checked before it may be
 * called a reference, and as far as H3 is concerned the words are the only
 * artefact of the three that is claimed to reach the model.
 *
 * ⚠ AND THERE IS NOW A SECOND CLIP, WHICH IS NOT THIS ONE. This paragraph used
 * to end "nothing here or in previz.js wires a blocking clip in as a control
 * video", and that sentence is no longer true — previz.js renders a BLOCKOUT,
 * marked use:vace-control, for WAN 2.1 VACE's `control_video`. Nothing about
 * the LTX measurement above changed; the node did. VACE leaves the latent as
 * noise and pushes it with a scaled additive residual instead of writing pixels
 * into it, and its own gate passed at CMA 0.924 while still generating rather
 * than reconstructing. So the rule this file holds is narrower and sharper than
 * it was: the clip a DIRECTOR watches is never handed to a model, it is a
 * different file with a different sidecar, and no move's words claim that
 * rendering one makes any model obey the move.
 *
 * ── WHAT A MOVE ENTRY OWES ─────────────────────────────────────────────────
 * Four sentences, because a shot is four decisions and a prompt that fuses them
 * into one clause loses three:
 *
 *   camera      where the lens goes, and over what
 *   framing     how much of the subject is in shot, and from where
 *   placement   WHERE IN THE FRAME the subject sits, and what it does there
 *   lens        what the focal length does, which is what separates a push
 *               from a dolly and a dolly from a zoom
 *
 * `placement` is the one people leave out and the one that pays. "Orbit around
 * her" produces a subject nailed to frame centre with the world spinning; "she
 * holds the left third while the background slides behind her" produces the
 * shot that was wanted. DIRECTING.md's own rule — ONE SPACE PER SHOT, say where
 * the camera is — is a placement rule.
 *
 * ── THE TWO VOCABULARIES, AND THE HONEST MAPPING ───────────────────────────
 * bible.js hands an LLM a `cameraMove` word list (static|slow-push-in|pull-out|
 * pan|tracking|orbit|handheld|whip-pan|speed-ramp). The toolkit has its own
 * (orbit, push_in, offset_follow, crane, floor_rise, robo_arm, handheld,
 * speed_ramp, two composites, plus legacy spellings). They are not the same
 * list, and pretending otherwise would silently drop the moves the board
 * vocabulary has no word for. Each entry therefore carries `boardMove` — the
 * NEAREST existing board word — and `boardMoveExact: false` where that word is
 * a lossy stand-in. A caller who wants the real thing puts the full sentence in
 * `action`, which is the field that writes the clip.
 *
 * No Blender, no bpy, no subprocess: this module is pure text and runs on a
 * machine that has never had Blender installed. That is deliberate — the words
 * are the deliverable, and they must not be gated on a 400 MB download.
 */

/** How much of the subject is in shot. Matches web/mv.js SHOT_TYPES. */
export const FRAMINGS = ["wide", "medium", "close", "extreme close",
                         "over-the-shoulder", "insert", "establishing"];

/* Worded for a SUBJECT, not for a person. Half these shots are of a car or a
 * crate — "shoulders just in frame" is nonsense about a sedan, and nonsense in
 * the prompt is noise in the sentence that is meant to be steering. Where the
 * figure version is genuinely more useful it is offered as the second clause
 * rather than as the only one. */
const framingPhrase = {
  wide: "a wide shot, the whole subject in frame with air above and below it",
  medium: "a medium shot, the subject filling about half the frame height — cut at the waist on a figure",
  close: "a close shot, tight on the subject with little room around it — the face on a figure",
  "extreme close": "an extreme close-up filling the frame with one detail",
  "over-the-shoulder": "an over-the-shoulder framing, the near figure soft and large in the corner",
  insert: "a tight insert on a single object, nothing else in frame",
  establishing: "an establishing wide, the subject small in the space",
};

/* ── THE TOOLKIT'S FRAMING WORDS ARE NOT THESE FRAMING WORDS ───────────────
 *
 * `push_in --move-arg framing=full|medium|close` names a BAND OF THE WORLD on
 * the far side (foot-to-head plus a pedestal and headroom / hip-to-head /
 * chest-to-head) and derives an end distance from it. This module's FRAMINGS
 * name how much of the SUBJECT is in shot. The two vocabularies share two
 * words and disagree about the interesting one, so the map is MEASURED rather
 * than assumed: on the PRISM stage blockout, framing=full ends with the 1.70 m
 * figure 352.6 px tall in a 704 px frame — 50.1% of the frame height, the whole
 * body in shot with air above and below, which is this module's "wide". It is
 * emphatically not its "medium", whose phrase says "cut at the waist on a
 * figure" — the words the app really did record against that clip, and a plain
 * contradiction of it.
 */
export const TOOLKIT_FRAMINGS = { full: "wide", medium: "medium", close: "close" };

/* What a push-in is closing TOWARD once a framing keyword sets its end
 * distance. Without one the class falls back to radius*0.45 and the prose's
 * "about half its starting distance" is roughly true; with one it is not
 * (measured on S3: 14.3178 m -> 10.0662 m, a ratio of 0.703), so the sentence
 * has to say the framing rather than a number the keyword overrode. */
const framingApproach = {
  full: "until the whole of it is in frame, head to foot",
  medium: "until it is framed from the hip up",
  close: "until it is framed from the chest up",
};

/** Which third of the frame the subject holds. */
const THIRDS = { left: "the left third", right: "the right third", centre: "frame centre" };

/**
 * PRONOUNS, DECLINED — subject, object and possessive, with verb agreement.
 *
 * Not fussiness. The first draft of this file interpolated one `pronoun` into
 * every slot and produced "matching she speed" and "behind she shoulder" in the
 * text that goes to the model. A prompt is read by something that was trained
 * on English, and ungrammatical English is noise in exactly the sentence that
 * is supposed to be doing the steering. `they` is the default because most
 * subjects here are props, and a prop is a "it"/"they" long before it is a she.
 */
const PRONOUNS = {
  they: { they: "they", them: "them", their: "their", s: "", es: "" },
  she: { they: "she", them: "her", their: "her", s: "s", es: "es" },
  he: { they: "he", them: "him", their: "his", s: "s", es: "es" },
  it: { they: "it", them: "it", their: "its", s: "s", es: "es" },
};

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const the = (s) => (s ? String(s).trim() : "the subject");

/**
 * THE VOCABULARY.
 *
 * `blender` is the exact token the toolkit's CLI accepts; `take: true` means it
 * arrives on --take (a ShotList) rather than --move (a Move), which is
 * previz.js's business and not a caller's. `needs` says what the geometry needs
 * in order to be built at all, so a plan can warn before a render is spent.
 */
export const MOVES = {
  orbit: {
    blender: "orbit",
    label: "orbit",
    boardMove: "orbit", boardMoveExact: true,
    needs: ["subject"],
    gist: "an arc around the subject on an elliptical path",
    /* The ellipse is not a flourish. A circular orbit inside a corridor puts
     * the camera through a wall; the toolkit takes radius as an (a, b) pair for
     * exactly that reason. The prose says "arc", never "circle", because a full
     * circle is almost never what a shot wants either. */
    camera: (o) => `The camera arcs ${o.degrees ?? 90}° around ${the(o.subject)} on a slow curve, `
      + `holding its distance and its height as it goes.`,
    placement: (o) => `${cap(the(o.subject))} stays put and holds ${o.third}; `
      + `the background slides continuously behind ${o.them} as the camera comes round, `
      + `revealing what was out of shot at the start.`,
    lens: () => "Focal length holds — the change of view comes from travel, not from zoom.",
    note: "An arc, not a circle: past about 120° the background has changed so "
      + "completely that the shot reads as a cut.",
  },

  push_in: {
    blender: "push_in",
    label: "push in",
    boardMove: "slow-push-in", boardMoveExact: true,
    needs: ["subject"],
    gist: "the camera closes AND the focal length lengthens",
    /* A dolly holds focal; a zoom holds position. Doing both at once is what
     * changes the relationship between subject and background, which is the
     * whole point of the shot — the toolkit's PushIn animates both, and the
     * prose has to say both or the model has no reason to compress. */
    camera: (o) => `The camera pushes in on ${the(o.subject)}, `
      + (framingApproach[o.framingKeyword]
        ? `closing ${framingApproach[o.framingKeyword]}, `
        : "closing to about half its starting distance over the length of the shot, ")
      + "and lengthening the lens as it travels.",
    placement: (o) => `${cap(the(o.subject))} holds ${o.third} throughout and grows in frame; `
      + `the background compresses in behind ${o.them} and loses width.`,
    lens: () => "Wide to long — a dolly alone would keep the background the same size, and a "
      + "zoom alone would keep the camera where it is. Both together is the shot.",
    note: "The compression is the tell. If the background stays the same width, "
      + "the model did a dolly and the prompt did not say enough.",
  },

  pull_out: {
    blender: "pull_out",
    label: "pull out",
    boardMove: "pull-out", boardMoveExact: true,
    needs: ["subject"],
    gist: "push_in run backwards — the reveal",
    camera: (o) => `The camera pulls back from ${the(o.subject)} to roughly twice its starting `
      + `distance, widening the lens as it retreats.`,
    placement: (o) => `${cap(the(o.subject))} shrinks in frame and the space around ${o.them} opens `
      + `out; what the tight framing was hiding arrives at the edges first.`,
    lens: () => "Long to wide, so the world grows faster than the retreat alone would make it.",
    note: "The reveal is what the frame GAINS, so the shot only works if there is "
      + "something at the edges worth arriving.",
  },

  offset_follow: {
    blender: "offset_follow",
    label: "offset follow",
    /* No board word for this. "tracking" is the closest, and it is lossy in
     * precisely the way that matters: a tracking shot that aims AT the subject
     * is the robotic one this move exists to avoid. */
    boardMove: "tracking", boardMoveExact: false,
    needs: ["subject"],
    gist: "travels with the subject but aims at a null BESIDE AND BEHIND it",
    /* THIS IS THE MOVE THE VOCABULARY EXISTS FOR. A follow shot that aims at
     * the subject pins it dead centre, and dead centre for six seconds is what
     * makes a follow read as machinery rather than as an operator. Aiming at an
     * offset null instead puts the subject off-axis with lead room ahead of it
     * and lets the background swing behind its shoulder. The prose must
     * describe the RESULT, because a model cannot be handed a null. */
    camera: (o) => `The camera travels with ${the(o.subject)}, keeping pace from ${o.side} and `
      + `slightly behind, matching ${o.their} speed rather than chasing it.`,
    placement: (o) => `${cap(the(o.subject))} is NOT centred. ${cap(o.they)} sit${o.s} off-axis, `
      + `holding ${o.third === THIRDS.centre ? THIRDS.right : o.third}, with open lead room ahead in `
      + `the direction of travel; the frame drifts around ${o.them} instead of locking on, and the `
      + `background swings past behind ${o.their} shoulder.`,
    lens: () => "A medium lens held steady — the interest is the parallax, not the focal length.",
    note: "The lead room is the whole move. A follow shot with the subject dead "
      + "centre is the shot this replaces.",
  },

  crane: {
    blender: "crane",
    label: "crane",
    boardMove: "tracking", boardMoveExact: false,
    needs: [],
    gist: "rise and tip over toward a plan view",
    camera: (o) => `The camera rises from head height and tips down as it climbs, finishing high `
      + `above ${the(o.subject)} and looking steeply down.`,
    placement: (o) => `${cap(the(o.subject))} starts filling ${o.third} and ends small in the middle `
      + `of the ground below; the floor becomes the background.`,
    /* WHAT THE SHOT BECOMES WHEN aim_at IS SET, and the default sentence above
     * is then simply false about it. A crane with no `target` aims down a fixed
     * pitch ramp at a point in front of the lens, and the subject does drift
     * out of the middle — measured on the no-keyword control, the neck leaves
     * frame after 42 of 121 frames and finishes 305 px below the bottom edge.
     * With aim_at the aim IS the body: measured on S1, the neck sits at exactly
     * (640, 352) on every one of the 121 frames, x and y range zero. */
    placementAimed: (o) => `${cap(the(o.subject))} is pinned at ${o.third} for the whole shot — `
      + `the camera tilts as it climbs to hold ${o.their} ${o.aimPart} exactly there — while the `
      + `ground opens out around ${o.them} and becomes the background.`,
    lens: () => "Wide throughout, so the ground opens out as the height comes.",
    note: "At the top of a crane the horizon leaves frame entirely, so anything the "
      + "shot needed to establish must be on the ground.",
  },

  floor_rise: {
    blender: "floor_rise",
    label: "floor rise",
    boardMove: "tracking", boardMoveExact: false,
    needs: [],
    gist: "a vertical reveal up through a structure, the aim trailing below",
    /* The aim TRAILS the camera by a fraction of a storey, which is why storeys
     * sweep down through frame instead of sitting still in the middle of it.
     * Say the sweep, not the lag: the model has no aim-lag parameter. */
    camera: () => "The camera rockets straight up the face of the structure, looking slightly "
      + "down the way it came.",
    placement: () => "Storeys sweep DOWN through frame one after another, each entering at the top "
      + "and leaving at the bottom; nothing holds still in the middle of the frame.",
    /* "Nothing holds still in the middle of the frame" is the trailing-aim
     * shot, and aim_at is the other one: measured on S4, the neck sits at
     * exactly (640, 352) on all 121 frames while the camera climbs 1.2 m -> 7.2
     * m and swings 5.2 m round. The storeys still sweep; the subject does not. */
    placementAimed: (o) => "The structure sweeps DOWN through frame, storey after storey, each "
      + `entering at the top and leaving at the bottom — but ${the(o.subject)} is pinned at `
      + `${o.third} throughout, the camera tilting as it rises to hold ${o.their} ${o.aimPart} `
      + "exactly there.",
    lens: () => "Very wide, close to the surface, so the speed reads.",
    note: "The shot is about the passing storeys. If the camera aims level they sit "
      + "still, and the rise reads as a static shot of a wall.",
  },

  robo_arm: {
    blender: "robo_arm",
    label: "robo arm",
    boardMove: "tracking", boardMoveExact: false,
    needs: [],
    gist: "a smooth path through control points with a separately moving aim",
    camera: (o) => `The camera runs a single unbroken motion-control path — in past a foreground `
      + `element, around, and out — while its aim swings independently onto ${the(o.subject)}.`,
    placement: (o) => `${cap(the(o.subject))} is off-axis at the start, crosses the frame as the path `
      + `bends, and settles into ${o.third} at the end.`,
    lens: () => "One focal length, no cuts — the value is that it is provably one take.",
    note: "The body and the aim move independently. Describing only the path gives a "
      + "shot that stares straight ahead the whole way.",
  },

  handheld: {
    blender: "handheld",
    label: "handheld",
    boardMove: "handheld", boardMoveExact: true,
    needs: [],
    gist: "operator noise layered over any other move",
    /* ASYMMETRY is what makes this read as a person and not as a shaken camera:
     * the aim gets a SMALLER counter-movement than the body, because a real
     * operator's hands drift and they instinctively correct to keep the subject
     * framed. "Shaky" gets the drift without the correction, which is why it
     * looks like an earthquake. */
    camera: (o) => `Handheld: the camera body drifts and settles the way a shoulder rig does`
      + `${o.base ? `, over the ${MOVES[o.base]?.label || o.base} beneath it` : ""}.`,
    placement: (o) => `${cap(the(o.subject))} stays framed — the operator corrects for the drift, so `
      + `the subject moves LESS in frame than the camera moves in space.`,
    lens: () => "Unchanged. Handheld is an overlay, not a move of its own.",
    note: "Ask for drift-and-correct, never for shake. A camera that shakes without "
      + "correcting reads as an earthquake, not an operator.",
  },

  speed_ramp: {
    blender: "speed_ramp",
    label: "speed ramp",
    boardMove: "speed-ramp", boardMoveExact: true,
    needs: [],
    gist: "the same path, re-timed — fast, hold, fast",
    camera: (o) => `The camera runs ${o.base ? `a ${MOVES[o.base]?.label || o.base}` : "its path"} at `
      + `speed, slows almost to a stop across the middle of the shot, then accelerates away.`,
    /* The first version of this line said only "arrives quickly, is held still,
     * and is gone" — a placement sentence that never says where in the frame
     * anything is, which is the exact omission this field exists to prevent.
     * Caught by previz_test.js, which asks every move the same question. */
    placement: (o) => `${cap(the(o.subject))} enters from the frame edge, comes to rest holding `
      + `${o.third} for long enough to be read, and is gone.`,
    lens: () => "Unchanged. The ramp is in time, not in optics.",
    note: "The hold has to land on something worth holding on, or the ramp reads as "
      + "a stutter.",
  },

  /* ── TWO-BEAT COMPOSITES ────────────────────────────────────────────────
   * The toolkit builds these as ShotLists rather than moves and takes them on
   * --take instead of --move; `take: true` is what tells previz.js which flag
   * to use. They are in the same table because from a board's point of view
   * they are one shot with one name, and because a scene long enough to hold
   * two beats is exactly what the segmenter cuts.
   *
   * They are also the strongest argument for previz existing at all. Both are
   * ONE CONTINUOUS TAKE with a join in the middle, and whether that join reads
   * as a move or as a cut is a thing you have to WATCH. The toolkit measured
   * its own: at a 0.6 s blend the follow-into-orbit hands over with an
   * acceleration ratio of 26 and reads as a whip pan; at 1.4 s it is 7.4 and
   * reads as one operator. No prompt can be written that fixes a join.
   */
  follow_orbit: {
    blender: "follow_orbit", take: true,
    label: "follow into orbit",
    boardMove: "tracking", boardMoveExact: false,
    needs: ["subject"],
    gist: "two beats, one take: an offset follow that swings into an orbit",
    camera: (o) => `One continuous take in two beats. First the camera walks with ${the(o.subject)}, `
      + `keeping pace off ${o.side} shoulder; then, without cutting, it swings out and around into `
      + `an arc, ending in front of ${o.them}.`,
    placement: (o) => `${cap(the(o.subject))} starts off-axis with lead room ahead and stays off-axis `
      + `through the turn — the frame swings around ${o.them} rather than the world spinning behind a `
      + `centred figure. The background changes completely between the first beat and the last.`,
    lens: () => "A wide-ish lens throughout, so the swing keeps its parallax.",
    note: "The hand-over is the whole shot. Ask for it as ONE unbroken move — the "
      + "moment it reads as two shots joined, it is a cut and the take is worth nothing.",
  },

  crane_plan: {
    blender: "crane_plan", take: true,
    label: "push into crane",
    boardMove: "tracking", boardMoveExact: false,
    needs: [],
    gist: "two beats, one take: a ground-level push that cranes up into a plan view",
    camera: (o) => `One continuous take in two beats. The camera pushes in on ${the(o.subject)} at `
      + `head height, then rises steeply and tips down, finishing far above and looking straight down.`,
    placement: (o) => `${cap(the(o.subject))} grows in frame through the push, then shrinks to a small `
      + `figure on open ground as the camera climbs; the floor replaces the horizon entirely.`,
    lens: () => "Wide, and widening as the height comes, so the ground opens out.",
    /* Not a style note — a measured refusal, straight from the toolkit: the
     * rise ends 24 m up, and on the capped 'atrium' set 57 of 144 frames came
     * back under the flat-frame threshold and the render was refused outright. */
    note: "NEEDS AN OPEN SET. The rise ends about 24 m up, so a capped one puts the "
      + "lens through the ceiling. Swept all seven: ATRIUM is the only closed one, and "
      + "previz.js refuses that pair before spending the render. The rest rise clean.",
  },

  static: {
    blender: "static",
    label: "static",
    boardMove: "static", boardMoveExact: true,
    needs: [],
    gist: "locked off",
    camera: () => "The camera is locked off and does not move.",
    placement: (o) => `${cap(the(o.subject))} holds ${o.third}; everything that changes in the shot `
      + `is performance, not camera.`,
    lens: () => "Fixed.",
    note: "A locked-off shot puts the whole burden on the action sentence.",
  },
};

/**
 * Legacy spellings the toolkit's CLI still accepts, mapped to the entry that
 * describes them. They are not separate moves and do not get separate prose —
 * pointing them at the real entry is how a board that says "orbit_left" gets
 * words instead of a refusal.
 */
export const ALIASES = {
  orbit_left: { move: "orbit", with: {} },
  orbit_right: { move: "orbit", with: {} },
  arc_reveal: { move: "orbit", with: { degrees: 75 } },
  crane_up: { move: "crane", with: {} },
  crane_down: { move: "crane", with: {} },
  dolly_left: { move: "robo_arm", with: { side: "the left" } },
  dolly_right: { move: "robo_arm", with: { side: "the right" } },
};

/** Every name a caller may pass, including the legacy ones. */
export function listMoves() {
  return [...Object.keys(MOVES), ...Object.keys(ALIASES)].sort();
}

/** Resolve a name (or alias) to its entry, or throw with the whole list. */
export function resolveMove(name) {
  const key = String(name || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (MOVES[key]) return { key, entry: MOVES[key], via: null, preset: {} };
  const al = ALIASES[key];
  if (al) return { key: al.move, entry: MOVES[al.move], via: key, preset: al.with };
  throw new Error(`Unknown camera move "${name}". Known: ${listMoves().join(", ")}.`);
}

/**
 * A SHOT PLAN IN WORDS.
 *
 * Returns the four sentences separately AND joined, plus a board `shots[]`
 * entry ready to paste. Separately, because a caller writing a two-beat scene
 * wants the placement line for beat 2 without repeating the camera line;
 * joined, because that is what goes in the prompt.
 *
 * `caveat` is not decoration. It is the sentence that stops this being oversold:
 * the words are an INSTRUCTION to a model that may or may not follow them, and
 * no previz render makes them more likely to be obeyed.
 */
export function shotPlan(name, opts = {}) {
  const { key, entry, via, preset } = resolveMove(name);
  const o = { ...preset, ...opts };

  /* ── THE MOVE'S OWN KEYWORDS REACH THE WORDS ──────────────────────────────
   *
   * `moveArgs` steers the CAMERA on the far side; until this parameter existed
   * it did not steer the SENTENCE, and the sentence is the only one of the
   * three artefacts previz.js claims will influence what the model draws. The
   * result was measured, not feared: the app recorded "arcs 90° around the
   * subject" against an orbit that swept exactly 75.000°; "a medium shot ...
   * cut at the waist" against a push-in whose keyword put the whole 1.70 m body
   * in frame; "ends small in the middle of the ground below" and "nothing holds
   * still in the middle of the frame" against two clips whose neck is pinned at
   * (640, 352) on all 121 frames; and — worst of the four — WORD-FOR-WORD THE
   * SAME PARAGRAPH for the S1 crane and its no-keyword A/B control, two clips
   * that share a move name and a spec sha and differ in whether the subject is
   * in the shot at all (121/121 frames against 42/121, 4,176 visible pixels in
   * the last frame against 0).
   *
   * The prose was already written to be steerable — orbit's camera line has
   * read `o.degrees ?? 90` since it was written — so this is a wire, not a
   * rewrite. What each keyword MEANS still lives with the move classes across
   * the licence boundary; nothing here validates a key or keeps a table of
   * them. A keyword this module has no sentence for simply reaches `ctx` and
   * changes nothing, which is the right answer for a knob about geometry. */
  const kw = (opts.moveArgs && typeof opts.moveArgs === "object"
              && !Array.isArray(opts.moveArgs)) ? opts.moveArgs : {};
  const framingKeyword = TOOLKIT_FRAMINGS[String(kw.framing ?? "").toLowerCase()]
    ? String(kw.framing).toLowerCase() : null;
  /* THE KEYWORD WINS THE FRAMING LINE, and it is the caller's own word that
   * gives way. Not a preference: `--move-arg framing=` is what the RENDER will
   * obey, so a board that typed "close" against a push-in framed full would put
   * "tight on the subject — the face on a figure" in the prompt beside a control
   * clip showing the whole body, and the words would be arguing with the video
   * they were made to accompany. Where no keyword speaks the caller's word
   * stands, and where neither speaks it is "medium" as before — which is also
   * why previzShot's `framing` now defaults to null rather than to "medium": a
   * default that arrives looking like a choice cannot be told from one, and it
   * silently beat framing=full on every push-in that asked for it. */
  const framing = framingKeyword ? TOOLKIT_FRAMINGS[framingKeyword]
    : (FRAMINGS.includes(o.framing) ? o.framing : "medium");
  const pron = PRONOUNS[String(o.pronoun || "they").toLowerCase()] || PRONOUNS.they;
  const ctx = {
    ...kw,
    ...o,
    subject: o.subject || null,
    third: THIRDS[o.third] || THIRDS.centre,
    side: o.side || "the left",
    ...pron,
    framingKeyword,
    /* The body part the camera is holding, as a word a sentence can use. */
    aimPart: kw.aim_at == null ? null : String(kw.aim_at).replace(/_/g, " "),
  };

  const camera = entry.camera(ctx);
  const framingLine = `Framing: ${framingPhrase[framing]}${o.angle ? `, ${o.angle}` : ""}.`;
  /* A move whose default placement sentence describes the subject DRIFTING says
   * the opposite of the truth once the aim is a body. Only the two moves that
   * make that claim carry an aimed variant; orbit and push_in already say the
   * subject holds frame centre and need none. */
  const placement = (ctx.aimPart && entry.placementAimed)
    ? entry.placementAimed(ctx) : entry.placement(ctx);
  const lens = entry.lens(ctx);

  return {
    move: key,
    label: entry.label,
    requested: via || key,
    gist: entry.gist,
    framing,
    /* WHAT STEERED THESE WORDS, beside the words. A surface showing the plan
     * can then say which sentence came from the move and which from a keyword,
     * and a reader comparing two plans with the same move name can see why they
     * differ. Empty object, never null, so `Object.keys` is always safe. */
    move_args: { ...kw },
    subject: ctx.subject,
    board_move: entry.boardMove,
    board_move_exact: entry.boardMoveExact,
    needs: entry.needs,
    camera, framing_line: framingLine, placement, lens,
    note: entry.note,
    words: [camera, framingLine, placement, lens].join(" "),
    /* Ready to drop into board.shots[]. `action` carries the move and the
     * placement, because `cameraMove` is only a LABEL — clipPrompt() joins the
     * labels into a comma list, so the sentence has to be in the field that
     * writes the clip. */
    board_shot: {
      shotType: framing,
      angle: o.angle || "",
      cameraMove: entry.boardMove,
      lensFeel: o.lensFeel || "",
      lighting: o.lighting || "",
      action: [o.action, camera, placement].filter(Boolean).join(" "),
    },
    caveat: "These are WORDS, not a camera curve. H3 takes a prompt and reference "
      + "images; it does not take a path. A previz render proves the move is buildable "
      + "and lets a director judge it — it does not make the model obey it.",
  };
}
