/**
 * pipeline_guide — the map of this MCP surface (FORK — see FORK_DELTA.md).
 *
 * A hundred-odd tools and no map means an agent's first hour is spent reading
 * descriptions instead of making anything. This tool IS the map: the five
 * stages of a music video, the episodic-series variant, the engine/licence/
 * cost rules, and one worked scene — each stage naming the exact tools to
 * reach for and the mistake people actually make there.
 *
 * THE CONTRACT WITH mcp-guide_test.js: every tool name in this text is written
 * in `backticks`, and NOTHING ELSE is — no parameters, no template ids, no
 * file names. The test extracts every backticked token and asserts it exists
 * in the live TOOLS list, which is what keeps this guide from doing the thing
 * guides do: naming a tool that was renamed two months ago. Numbers are kept
 * out of the text for the same reason — a tool count would be stale by the
 * commit after next.
 *
 * The `pitfalls` topic is the one that is not a map. It is the set of mistakes
 * this pipeline has actually produced — coverage at parity with the runtime,
 * cuts on lyrics instead of bars, a reference used to compose instead of to
 * continue, a video judged from a still. Guides usually describe the happy
 * path; this section exists because the happy path was never where the time
 * went.
 *
 * Static text on purpose. It answers instantly, works with the Studio down,
 * and costs the caller one read — the catalogs (`vfx_effects_catalog`,
 * `image_tools_catalog`) stay the reference for parameter-level truth.
 */

const HEAD = `AIPLAY STUDIO — WHEN TO USE WHAT

Families: mv_*/ab_* = the workflow store (projects, scenes, cast, takes,
timeline); vfx_* = the compositor; image_* = the editor; engine_* = the raw graph and the record of
every render; the rest = generation
and the library. One local GPU renders everything — music has priority, art
and video queue behind it.

The economics drive the order: PLANNING IS FREE (brief, bible, lint, crime
board), a render costs GPU-minutes, and every render KEEPS its takes. So plan
fully, render once, pick takes, repair the stale minimum, and polish with VFX
instead of re-rendering. Topics: stages, series, engines, example.`;

const STAGES = `THE FIVE STAGES OF A MUSIC VIDEO

1 SONG — \`make_song\` (returns a job id) then \`wait_for_song\`; \`list_songs\`
  to see the library; \`get_beats\` for the measured tempo and bar grid.
  The mistake: a comma-tag caption. The three-part structured caption
  (Global Metadata. / Vocal Details. / Arrangement.) is the quality lever,
  and song LENGTH follows lyric length more than max_seconds. Also check
  \`get_beats\` bpm against what you would tap: detection picks the octave,
  and half-time usually reads doubled (beat_mult 0.5 fixes the cut).
  Lyrical scene-cutting needs timed lyrics: \`list_songs\`
  shows has_lyrics, and a song without them must get an .lrc first.

2 PLAN (all free — spend nothing here) — \`mv_create_project\` →
  \`mv_attach_song\` → \`mv_segment\` (scenes of a few seconds each; re-running
  is DESTRUCTIVE: it versions the set and marks boards/clips stale) →
  interview the human and record the answers with \`mv_set_brief\` →
  \`mv_bible_spec\` for the authoring contract, write the bible, commit with
  \`mv_set_bible\` (strict name binding — boards may only reference declared
  characters/backgrounds) → \`mv_lint\` → \`mv_crime_board\`.
  The mistake: rendering before \`mv_lint\`. A scene without a board falls
  back to a generic performance shot, and that is GPU-minutes spent on a
  shot nobody wanted. \`mv_update_segment\` re-scopes one scene;
  \`mv_set_board\` upserts one storyboard without re-authoring the bible.

3 ASSETS (the expensive stage) — inside the project: \`mv_generate_asset\`
  renders a TAKE STRIP (several seeds off one text encode — four variants
  cost barely more than one) for character sheets, background plates and
  boards; \`mv_pick_take\` chooses (re-picking a face marks dependent boards
  stale — read \`mv_crime_board\` before re-rendering anything);
  \`mv_generate_clip\` renders one scene with its cast riding as references
  and the scene's real stretch of song frozen in. Calling it again is a
  REGENERATE: new seed, old take kept. \`mv_import_asset\` brings any picture
  on disk in as cast — the fastest path to a consistent face.
  Outside the project: \`make_image\` for stills and props (its ref_images
  are how one character stays consistent across pictures), \`image_cutout\`
  for transparent subjects, \`image_adjust\` for cleanup, \`image_upscale\`
  for size; \`make_clip\` for free-standing animated shots; \`restyle_clip\`
  to re-skin an existing clip's motion instead of inventing new footage.
  The mistake: regenerate-everything. Takes accumulate — pick, do not
  re-roll, and let \`mv_regen_stale\` (stage 5) find the stale minimum.

4 POLISH (VFX — seconds per frame, not minutes per clip) —
  \`vfx_templates\` FIRST for anything with a name — title cards, lower
  thirds, stings, grades, transitions, end cards. Otherwise
  \`vfx_create_comp\`
  → \`vfx_add_layer\` → \`vfx_add_effect\` (names and ranges from
  \`vfx_effects_catalog\` — a guessed range renders wrong) →
  \`vfx_preview_frame\` after every meaningful change → \`vfx_render\`
  (poll \`vfx_render_status\`). \`vfx_effect_presets\` saves a grade once and
  applies it to every plate. \`vfx_audio_keys\` turns the song into keyframes
  for beat-driven moments.
  VFX BEATS RE-GENERATION for: text, titles and logos; grades and looks;
  compositing generated elements (a cutout over a plate); transitions;
  particle and light moments; any render that must carry the mix.
  It does NOT beat re-generation for new photography — a different subject,
  camera or scene is a generation problem, not an effect.
  The mistakes here: a comp layer's src is the child comp's SLUG, never a
  file name; shape items compose IN ORDER (paths, then operations, then
  paint — a stroke listed before a trim leaves the trim nothing to cut);
  and preview a title card mid-motion, because at time zero it is a black
  frame that tells you nothing.

5 ASSEMBLE — \`mv_build_timeline\` writes the real Studio project (every
  scene's pick at its exact time, song on the audio track; a rebuild
  OVERWRITES it with current picks). A human edits in
  Studio; \`mv_read_timeline\` reads that edit back as an EDL with what
  changed. \`mv_regen_stale\` heals drift — DRY RUN BY DEFAULT, and a real
  run costs GPU-minutes per clip, so read the dry run first.
  \`studio_bounce\` masters the AUDIO server-side. The finished VIDEO file:
  Studio's own export is a browser capture a person presses, OR
  \`vfx_import_studio\` with audio_as 'layers' followed by \`vfx_render\`
  renders the movie with its mix entirely server-side; \`vfx_export_studio\`
  goes the other way, dropping a finished comp onto the timeline.
  The mistake: expecting \`build_music_video\` or \`mv_build_timeline\` to
  emit an .mp4 — both write PROJECTS. (\`build_music_video\` is the quick
  bar-grid path — a song and a clip pool, no per-scene plan.)`;

const SERIES = `AN EPISODIC SERIES

BIBLE FIRST, before any pixel: \`mv_bible_spec\` → author the story, style
bible, characters, backgrounds and boards → \`mv_set_bible\`. The bible merges
by NAME, so re-committing it never destroys rendered sheets.

One project per episode, one shared cast. Projects do not share a store, so
carry the bible document itself between episodes and commit the SAME
characters/backgrounds into each with \`mv_set_bible\` — then carry the chosen
FACES with \`mv_import_asset\` (import the previous episode's picked sheet
under the same name), so episode two's cast is pixel-identical, not merely
described identically. \`mv_pick_take\` + \`mv_crime_board\` police drift
inside an episode; \`mv_regen_stale\` heals it after a cast change.

Narration-driven episodes (audiobook spine): \`ab_create_project\` →
\`ab_ingest\` (epub/pdf; \`ab_toggle_chapter\` scopes out front matter) →
\`ab_plan\` bundles chapters → \`ab_audition\` to cast BY EAR, then
\`ab_set_voice\` (one narrator per book) and \`ab_set_cast\` (named characters
get their own voices) → \`ab_narrate\` per bundle → sound design:
\`ab_sfx_scan\` proposes cues, \`ab_sfx_set\` writes better ones yourself,
\`ab_sfx_judge\` grades them free on the local model (figure-of-speech cues
get real:false and are skipped), \`ab_sfx_render\` renders the survivors →
\`ab_generate_bed\` makes reusable mood beds and \`ab_use_bed\` is how a late
chapter reuses the bed an early one established → \`ab_mix\` masters the
bundle. \`ab_board\` is how a fresh agent resumes a half-finished book
coherently — read it before touching anything.`;

const ENGINES = `ENGINES, LICENCES, COST

VIDEO — LTX is the working engine: fast, exact first/mid/last frames, loops,
a soundtrack path that plays the real song, and a working negative prompt.
MiniMax H3 is territory-blocked by licence: no grant AT ALL in the EU, the UK
or South Korea — never steer work toward it. It is the only named-reference
engine (<Picture n>/<Audio n>), and \`mv_generate_clip\` selects it
automatically when a scene has cast refs; where the licence does not apply to
you that path works as designed, and where it does, cover the scene with
\`make_clip\` on LTX instead — first_frame from the board image,
soundtrack_song for the scene's stretch — and place the result on the
timeline (\`mv_read_timeline\` treats a relinked item as a first-class state).
\`set_video_engine\` switches persistently; a switch reloads tens of GB of
weights on the next render, so batch work by engine, never alternate per
clip.

IMAGES — the default engine is FLUX.2 (Apache-2.0) and it is the only one
taking ref_images. The Ideogram engine is typography-grade but NON-COMMERCIAL
and noise-locked: most seeds return the model's refusal card regardless of
prompt. The app renders from its pass-seed list automatically; pin 777
if you pin one at all. A refusal card is a seed problem, not a prompt one.

THE ENGINE DOOR — there is no other way to the GPU. The engine binds an
unpublished loopback port chosen fresh at every start, so a graph runs through
\`engine_run_graph\` or not at all, and \`engine_activity\` is then the whole
record of what this machine rendered and who asked. Reach for a finished verb
first; come here when none fits, and always dry_run first — it returns the
model files, steps, size and seed for nothing.

STRUCTURAL CONTROL — a real clip steers a render: \`mv_control_render\` puts
one on WAN 2.1 VACE's control_video; the camera move IS carried (measured).
\`mv_previz_shot\`'s grey box is the opposite — never send it to a model.
CONTRACT: exactly 1280x704, exactly 24.000 fps, 121+ frames, ALL FAIL
SILENTLY — \`mv_control_check\` is FREE and names the bad number; run it
first. ~32 min. \`mv_pose_extract\`: the 26 s skeleton.
\`mv_control_catalogue\`: free, both licences.

COST ETIQUETTE — never re-render what a cheaper tool fixes. Free:
\`mv_lint\`, \`mv_crime_board\`, \`studio_status\`, every list/read tool, a
\`mv_regen_stale\` dry run. Seconds: \`image_adjust\`, \`vfx_add_effect\`,
\`vfx_preview_frame\`. Minutes of GPU: \`make_song\`, \`make_clip\`,
\`mv_generate_clip\`, \`restyle_clip\`, \`vfx_render\` on a long comp. Music
outranks everything on the one GPU — do not start art mid-song and then
wait on it. Every clip render keeps its earlier takes: the cheap iteration
loop is \`mv_pick_take\`, not another render.`;

const EXAMPLE = `ONE SCENE, BRIEF TO TIMELINE (a compressed transcript; outputs abridged)

 1. \`mv_open_project\` {slug:"neon-rain"} → segment seg4 runs 21.4-28.9s,
    thesis line "city lights come down like rain".
 2. \`mv_set_board\` {slug, segmentId:"seg4", board:{boardPrompt:"rain-slick
    alley, neon signage", characterRefs:["Mara"], shots:[...]}} → board saved,
    old clip (if any) marked stale.
 3. \`mv_lint\` {slug:"neon-rain"} → no issues touching seg4. Free, so it runs
    before anything that is not.
 4. \`make_image\` {prompt:"empty rain-slick neon alley at night, wide",
    seed:41} → alley_41.png. The seed lands in the image's metadata
    (\`list_images\` shows it), so this plate is reproducible; on the Ideogram
    engine pin seed 777 instead — its other seeds mostly refuse.
 5. \`make_image\` {prompt:"the singer from image 1, full body, under a neon
    sign", ref_images:["mara_sheet.png"]} → mara_alley.png — the ref keeps
    her the SAME Mara as the character sheet.
 6. \`image_cutout\` {name:"mara_alley.png"} → mara_alley_cut.png, transparent
    background, ready to composite.
 7. \`image_adjust\` {name:"alley_41.png", temperature:-18, vignette:30} →
    a colder plate. Seconds, not GPU-minutes.
 8. \`vfx_create_comp\` {name:"seg4", width:1280, height:720, fps:30,
    duration:7.5} → slug seg4-comp.
 9. \`vfx_add_layer\` {slug:"seg4-comp", type:"image", src:"alley_41_edit.png"}
    → the plate. src is a LIBRARY NAME, never a path.
10. \`vfx_add_layer\` {slug:"seg4-comp", type:"image",
    src:"mara_alley_cut.png"} → lands on top of the stack — the cutout rides
    over the plate.
11. \`vfx_templates\` {template:"titleCard", params:{title:"NEON RAIN"}} →
    its own comp; nest it with \`vfx_add_layer\` {type:"comp",
    src:"<that slug>"} — the src is the child comp's SLUG.
12. \`vfx_effects_catalog\` {group:"Color"} → real names and ranges, then
    \`vfx_add_effect\` on an adjustment layer for the grade — a guessed
    parameter range is accepted and renders wrong, which is why the catalog
    call comes first.
13. \`vfx_add_layer\` {slug:"seg4-comp", type:"audio", src:"neon_rain.flac"}
    → the scene's stretch of song rides the render as its mix.
14. \`vfx_preview_frame\` {slug:"seg4-comp", t:3} → LOOK at it mid-motion
    before paying per-frame render cost (t:0 on a title is a black frame).
15. \`vfx_render\` {slug:"seg4-comp", format:"mp4"} → a job id; poll
    \`vfx_render_status\` until done → the clip lands in the library.
16. \`mv_build_timeline\` {slug:"neon-rain"} → the Studio project, every
    scene's current pick at its exact time, song on the audio track.
17. \`mv_read_timeline\` {slug:"neon-rain"} → confirms what the cut uses now —
    including seg4 relinked to the comp render, a recognised state.
18. \`studio_bounce\` {project:"Neon Rain — cut"} → the audio master,
    server-side. The picture: a person presses Export video in Studio, or
    \`vfx_import_studio\` (audio_as 'layers') + \`vfx_render\` does the whole
    movie without a browser.`;

const PITFALLS = `WHAT GOES WRONG — each line here was measured on a real run

COVERAGE. Render MORE footage than the song is long, or there is no edit, only
assembly. A cut cannot move onto the beat if moving it opens a hole. Give every
shot handles at both ends, about a bar of the song wide. A pipeline whose footage
equals its runtime has locked its own edit before anyone sits down to cut.

CUT ON THE BAR, NOT THE LYRIC LINE. \`get_beats\` returns the measured grid;
scene segmentation follows lyrics. Nothing joins the two unless you do it
deliberately, and left alone they disagree on nearly every cut.

A BOARD WITH BEATS IS A SEQUENCE, NOT A STILL. \`mv_generate_asset\` on a
multi-beat board renders one keyframe per beat, chained: the first beat with no
reference, every later beat referencing the frame before it. That chain is what
holds a face across a shot. A lone opening frame quietly takes a weaker path —
give the clip a closing frame as well, and waypoints between them.

REFERENCES PRESERVE FRAMING. THAT IS WHAT THEY ARE FOR. Reference conditioning is
in-context EDITING: handed a character sheet and a scene description it will
reproduce the sheet. Use it for continuity — "the previous frame of this same
shot" — and never to compose a new shot out of a portrait.

YOU CANNOT NEGATE A DESCRIPTION, ONLY WITHHOLD IT. A shot with no cast must not
receive the character bible at all; appending "no people" to a long description of
a person still draws the person, and the distilled image engines never evaluate a
negative prompt. For the same reason put the shot first and the style after: a
long character description in front of a one-line subject makes the character the
subject, and an abstract insert comes back full of people.

LOOK AT WHAT YOU MADE. \`image_review\` hands back the picture to check against
what was asked for. There is no equivalent for video: a clip is unverified by
construction, and a still that looks right proves nothing about the motion.

CHECK THE CAST LIST BEFORE CALLING A FACE WRONG. A second person in frame is
usually the second character, not drift.

FINISHING IS A STAGE. \`mv_build_timeline\` is the last one and the easiest never
to reach. Repairing tools is not delivering a video: re-read the objective before
each new thread of work, and ask what the caller would have if you stopped now.`

const TOPICS = { stages: STAGES, series: SERIES, engines: ENGINES, example: EXAMPLE, pitfalls: PITFALLS };

/** Every section, for the test that proves no tool name here is a phantom. */
export const GUIDE_SECTIONS = { head: HEAD, ...TOPICS };

export function guideTools() {
  return [
    {
      name: "pipeline_guide",
      description:
        "THE MAP OF THIS SURFACE — read this before your first render. Which tools to use "
        + "at each of the five stages of a music video (song, plan, assets, polish, "
        + "assemble), the episodic-series variant, the engine and licence rules, and a "
        + "worked scene. Costs nothing and answers instantly. `topic` narrows it: "
        + "stages | series | engines | example | pitfalls. READ `pitfalls` BEFORE A LONG RUN — it is the list of mistakes that have actually been made on this pipeline.",
      inputSchema: {
        type: "object",
        properties: {
          topic: { type: "string", enum: ["stages", "series", "engines", "example", "pitfalls"],
            description: "One section instead of the whole map." },
        },
        additionalProperties: false,
      },
      async run(a) {
        if (a.topic) {
          const text = TOPICS[a.topic];
          if (!text) throw new Error(`No topic "${a.topic}". They are: ${Object.keys(TOPICS).join(", ")}.`);
          return { topic: a.topic, guide: text };
        }
        return { guide: [HEAD, STAGES, SERIES, ENGINES, EXAMPLE, PITFALLS].join("\n\n") };
      },
    },
  ];
}
