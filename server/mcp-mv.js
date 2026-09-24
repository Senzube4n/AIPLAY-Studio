/**
 * Video Workflow — the MCP tools (FORK — see FORK_DELTA.md).
 *
 * Spread into server/mcp.js's TOOLS array. Every tool calls the SAME /api/mv
 * route the Workflow tab calls, through the same api() transport the existing
 * tools use — one implementation, two surfaces, no drift. Voice and shape
 * follow make_clip: snake_case params, errors that name the fix.
 *
 * ── WHERE THIS FAMILY SITS IN THE PIPELINE (pipeline_guide is the full map) ─
 * mv_* is stages 2, 3 and 5 of a music video. PLAN: mv_create_project →
 * mv_attach_song → mv_segment → mv_set_brief → mv_bible_spec/mv_set_bible →
 * mv_lint (free — run it before spending GPU). ASSETS: mv_generate_asset →
 * mv_pick_take → mv_generate_clip (takes are KEPT; mv_crime_board says what a
 * re-pick invalidates). FIX ONE SHOT: mv_shot (free — the exact prompt, which
 * sheets resolved, which resolved to NOTHING) → mv_set_shot (edit the prompt or
 * the refs, writes only) → mv_regen_clip (re-render that one shot, hold the
 * seed to isolate the change) → mv_pick_take target "clip" to go back.
 * ASSEMBLE: mv_build_timeline → a human edits →
 * mv_read_timeline → mv_regen_stale (dry run by default) → studio_bounce.
 * ab_* is the narration spine of an episodic series: ingest → plan → voice/
 * cast → narrate → sfx → beds → mix; ab_board is how a fresh agent resumes.
 */

/* ─────────────────── THE GRAY-BOX SETS, LIVE — no copy of them in this file
 *
 * ⚠ THIS FILE USED TO CARRY THE SEVEN SET NAMES, SPELLED OUT, as an `enum` on
 * `scene` — and the day the toolkit grew an eighth set that enum became a
 * schema which REFUSES a set that renders perfectly well. An enum is a promise about somebody else's
 * list, and a promise typed into a file is a promise nobody re-types.
 *
 * So there is no set list here. The studio derives it from the toolkit (one
 * subprocess across the licence boundary, cached under a version stamp) and
 * serves it at GET /api/mv/previz as `sets.names`; this asks for it once per
 * process and writes it into the schema object, which tools/list reads at
 * request time. Until it lands there is NO enum on `scene` rather than a wrong
 * one — an absent enum offers no picklist, a stale one refuses a real set, and
 * only one of those two failures costs somebody a render.
 *
 * The arg objects built before the answer arrives are held only until it does;
 * every table built afterwards is stamped from `liveSets` at build time. That
 * matters because mvTools() is also called by server/mv/planrun.js on every
 * plan run, not just once at MCP boot. */
/* THE SIZE LIST AND THE TWO SHAPES, from their one source (server/mv/sizes.js,
 * pure: it reads only server/h3tier.js), so this enum cannot drift from what
 * renderSize makes. Not a copy; an import. */
import { MV_SIZE_IDS, MV_ASPECTS, MV_CLIP_CEILING_SEC, sizeEnumText, cardTierText, cutDefaultText } from "./mv/sizes.js";

let liveSets = null;          // the toolkit's list, once the studio has said it
let liveSetsRun = null;       // one fetch per process, however many tables are built
const pendingSceneArgs = [];  // schema objects still waiting for it

function fillSceneArgs(names) {
  liveSets = names;
  for (const a of pendingSceneArgs) a.enum = names;
  pendingSceneArgs.length = 0;
}

function askForSets(api) {
  if (liveSets || liveSetsRun) return liveSetsRun;
  liveSetsRun = Promise.resolve()
    .then(() => api("GET", "/api/mv/previz"))
    .then((r) => {
      const names = r?.sets?.names || r?.scenes;
      if (Array.isArray(names) && names.length) fillSceneArgs(names);
      else liveSetsRun = null;          // an empty answer is not an answer
    })
    /* The studio may not be up yet, or may be mid-render. Nothing here waits on
     * it and nothing here fails because of it — the next tool table tries
     * again, and the route validates the set for real either way. */
    .catch(() => { liveSetsRun = null; });
  return liveSetsRun;
}

export function mvTools(api, safeName) {
  /** `scene`, shared by every tool that takes one. Filled in above. */
  const sceneArg = {
    type: "string",
    description: "The gray-box set to block in, by name. Default corridor. The names are the "
      + "TOOLKIT's, not a list kept in this file: mv_previz_moves (GET /api/mv/previz) returns "
      + "them under `sets`, with `sets.source` saying whether that is the toolkit's own answer "
      + "or this app's last-known copy. This schema's `enum` is filled in from the same place as "
      + "soon as the studio answers. crane_plan needs an OPEN set — on the capped atrium the "
      + "toolkit refuses the render.",
  };
  if (liveSets) sceneArg.enum = liveSets;
  else pendingSceneArgs.push(sceneArg);
  askForSets(api);
  /**
   * ⚠ THE TIMEOUT HAS TO MATCH THE WORK, and it did not.
   *
   * Every MV call used api()'s 120-second default, which is fine for reading a
   * project and impossible for rendering one: a 5-second clip at 1920x1088 takes
   * about three minutes on LTX and roughly twenty-eight on H3. So
   * mv_generate_clip could not succeed at any quality above the default — it
   * reported "Studio did not answer in time" while the render carried on
   * perfectly well behind it, and an agent driving the pipeline saw nothing but
   * failures. Measured the hard way: eight consecutive scenes "failed" at
   * exactly 120s each while the GPU sat at 100%.
   *
   * The generating actions get an hour. That is not a guess at how long they
   * take — it is longer than any of them can take, because art.js already caps
   * a render with its own deadline sized from pixels x frames. This timeout
   * exists to catch a dead server, not to second-guess the renderer.
   */
  /* `blender_asset` is here for the shape of the work, not its usual length: a
   * gray-box builtin renders in a couple of seconds, but the same call handed a
   * dense .blend imports and shades a real mesh, and a cold Blender launch on a
   * loaded machine is not instant either. Nothing about it should fail at 120s
   * while the render is going perfectly well. */
  /* `previz_shot` blocks a camera move and can render a reference frame after
   * it — measured at 23s for 121 frames plus a 512px panel, but that is one
   * gray-box set on a warm machine and a cold launch on a loaded card is not
   * that. `previz_plan` is NOT here: it is words, it touches nothing, and it
   * returns in a millisecond whether Blender exists or not. */
  /* `control_render` is the longest single call on this surface: a 1280x704 x
   * 121-frame WAN 2.1 VACE pass measured 31.99 minutes on this rig, and mode
   * "pose" runs a DWPose extraction in front of it. The hour below is not an
   * estimate of that — it is longer than any of them can take, because the
   * engine door caps every run with its own 90-minute deadline and keeps
   * watching past this one either way. */
  const SLOW = new Set(["generate_clip", "generate_asset", "regen_clip",
                        "regen_by_clip_id", "regen_stale", "build_timeline",
                        "blender_asset", "previz_shot", "control_render"]);
  const mv = async (body) => {
    const r = await api("POST", "/api/mv", body, SLOW.has(body.action) ? 3_600_000 : 120_000);
    if (r.error) throw new Error(r.error);
    return r;
  };
  const stageSummary = (r) => ({
    slug: r.project?.slug, stage: r.stage,
    counts: r.project ? {
      segments: r.project.segments.length, characters: r.project.characters.length,
      backgrounds: r.project.backgrounds.length, boards: r.project.boards.length,
      clips_done: r.project.clips.filter((c) => c.clipFile).length,
    } : undefined,
  });

  /**
   * ONE SHAPE FOR ALL FIVE PLAN TOOLS, so proposing, reading, editing,
   * approving and running all answer in the same words — an agent that learned
   * to read one reply can read the other four.
   *
   * Everything here is DERIVED by the server on read: the engine each item's
   * choice implies, the size it will really render at, its minutes, and the
   * continuity breaks its scene carries. None of it is stored, so it cannot go
   * stale against the brief. An item nothing could price says so in `basis`
   * rather than reporting zero — absent is absent, never a number.
   */
  const planOut = (r) => {
    const p = r.plan;
    const rest = {
      plans: r.plans, changed: r.changed, rejected: r.rejected,
      running: r.running, op: r.op, run_note: r.note,
    };
    if (!p) {
      return { plan: null, note: "No plan on this project — mv_plan_propose starts one.", ...rest };
    }
    const t = p.totals || {};
    return {
      plan_id: p.id, title: p.title, intent: p.intent, state: p.state,
      created_by: p.createdBy, plan_note: p.note,
      /* THE QUALITY LINE, on the object being approved rather than in a
       * document nobody opens: engine, size, steps, references, and the traps
       * that choice walks into. */
      quality: p.quality?.line ?? null,
      traps: (p.quality?.traps || []).map((x) => `${x.level}: ${x.msg} (${x.cite})`),
      on_failure: p.policy?.onFailure ?? null,
      auto_approve_under_minutes: p.policy?.autoApproveUnderMinutes ?? null,
      delegate_brief: p.policy?.delegateBrief ?? null,
      totals: {
        items: t.items, approved: t.approved, proposed: t.proposed, edited: t.edited,
        skipped: t.skipped, running: t.running, done: t.done, failed: t.failed,
        unpriced: t.unpriced, minutes: t.totalMinutes, upper_minutes: t.upperMinutes,
        per_clip_minutes: t.perClipMinutes, measured_from: t.measuredFrom,
        headline: t.headline, spread: t.spread,
        finishes_at: t.etaAt ? new Date(t.etaAt).toISOString() : null,
      },
      items: (p.items || []).map((i) => ({
        id: i.id, tool: i.tool, status: i.status, why: i.why, args: i.args,
        engine: i.quality?.engine ?? null,
        size: i.quality?.width ? `${i.quality.width}x${i.quality.height}` : null,
        minutes: i.estimate ? i.estimate.minutes : null,
        basis: i.estimate ? i.estimate.basis
          : "UNPRICED — nothing here could work out what this costs, so it is not in the total",
        cite: i.estimate?.cite ?? null,
        warnings: (i.warnings || []).map((w) => `${w.level}: ${w.msg}`),
        needs_acknowledgement: i.needsAcknowledgement,
        error: i.error, result: i.result,
      })),
      /* THE SPEND METER. It ships with no budget at all — the number is here to
       * be watched, not to refuse anything yet. */
      unattended_minutes_since_approval: p.spend?.unattendedMinutesSinceApproval ?? null,
      budget_minutes: p.spend?.budgetMinutes ?? null,
      ...rest,
    };
  };

  return [
    {
      name: "mv_create_project",
      description: "Start a music-video project. A project owns the song, its scene cut, the brief, the cast, the boards and every clip — the metadata that makes later regeneration exact. A new project starts at the size this PC's graphics card reaches (" + cardTierText() + "); mv_open_project's cardFit says which and why, and mv_set_brief quality changes it.",
      inputSchema: { type: "object", required: ["title"], properties: { title: { type: "string" } }, additionalProperties: false },
      async run(a) { const r = await mv({ action: "create", title: a.title }); return { slug: r.slug }; },
    },
    {
      name: "mv_list_projects",
      description: "Every music video project (the Music video screen) with its derived stage and artefact counts.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async run() { return (await api("GET", "/api/mv/projects")).projects; },
    },
    {
      name: "mv_open_project",
      description: "The full project document: song, brief, segments, characters, backgrounds, boards, clips with their takes, and the derived stage. Read this before acting — it is the ground truth every other tool writes into. `cardFit` is what this PC gives the project: the sizes (each with whether this card reaches it, what LTX makes of it, and Studio's pick, plus the RAM warning when there is one), the default longest scene for the cut and where that number comes from (with a note when the scenes on file were cut at another default), the step choices worded from the speed-up files on disk, and whether hybrid can send cast-less scenes to LTX here.",
      inputSchema: { type: "object", required: ["slug"], properties: { slug: { type: "string" } }, additionalProperties: false },
      async run(a) { return api("GET", `/api/mv/project/${encodeURIComponent(safeName(a.slug, "project"))}`); },
    },
    {
      name: "mv_attach_song",
      description: "Attach a library song (file from list_songs) and analyze it: timed lyric lines and the beat grid. The song must have timed lyrics (an .lrc) for lyrical scene cutting — make them first with the Music tab's lyrics step if missing.",
      inputSchema: { type: "object", required: ["slug", "file"], properties: { slug: { type: "string" }, file: { type: "string" } }, additionalProperties: false },
      async run(a) { return stageSummary(await mv({ action: "attach_song", slug: a.slug, file: safeName(a.file, "song") })); },
    },
    {
      name: "mv_import_song",
      description:
        "Bring audio in FROM ANYWHERE ON DISK, make it a library track, and attach it — one move "
        + "for a song Studio did not make. The file is COPIED into the library (the library "
        + "re-reads its folder on every list, so a copy is all importing is), then the project "
        + "attaches it and analyzes it exactly as mv_attach_song does.\n\n"
        + "WHAT IT DOES NOT BRING is timed lyrics. The beat grid works on any audio, so segmenting "
        + "will succeed — but lyrical scene cutting is LYRIC-DRIVEN, and an imported track with no "
        + ".lrc segments on instrumental rules alone: whole-song scenes with no thesis lines, and "
        + "boards with nothing to be about. If the video is meant to follow words, make the timed "
        + "lyrics first (Music tab) and use mv_attach_song instead. mp3, wav, flac, ogg or m4a.",
      inputSchema: {
        type: "object", required: ["slug", "path"],
        properties: {
          slug: { type: "string" },
          path: { type: "string", description: "Full local path to the audio file. It is copied, not referenced." },
          title: { type: "string", description: "Library title. Defaults to the filename." },
        }, additionalProperties: false,
      },
      async run(a) {
        const r = await mv({ action: "import_song", slug: a.slug, path: a.path, title: a.title });
        return { ...stageSummary(r), song: r.project?.song, lyricLines: r.project?.lyricLines?.length ?? 0,
                 note: r.project?.lyricLines?.length ? undefined
                   : "No timed lyrics for this track — segmentation will have no lines to cut on." };
      },
    },
    {
      name: "mv_analyze",
      description:
        "RE-READ the attached song's timing: the timed lyric lines from its .lrc, the duration, and "
        + "the beat grid. Attaching already does this, so reach for it when the SONG DID NOT "
        + "CHANGE BUT ITS METADATA DID — lyrics were written or corrected after the track was "
        + "attached, the .lrc was re-timed, the duration was wrong. Free, no GPU, writes only the "
        + "timing fields. It does NOT re-cut the scenes: run mv_segment after if the lines moved, "
        + "and remember that re-segmenting marks existing boards and clips stale.",
      inputSchema: { type: "object", required: ["slug"], properties: { slug: { type: "string" } }, additionalProperties: false },
      async run(a) {
        const r = await mv({ action: "analyze", slug: a.slug });
        return { stage: r.stage, lyricLines: r.project?.lyricLines?.length ?? 0,
                 durationSec: r.project?.totalDurationSec ?? null, bpm: r.project?.beats?.bpm ?? null };
      },
    },
    {
      name: "mv_delete",
      description:
        "DELETE A PROJECT AND EVERYTHING IN ITS FOLDER — the document, the rendered sheets, the "
        + "boards, every take of every clip. It cannot be undone from here and there is no trash.\n\n"
        + "The song is not touched (it lives in the library) and neither are clips already "
        + "imported into the clip library, so a finished video survives its project. Everything "
        + "else is gone: the takes are the expensive part, and a project with 40 of them is hours "
        + "of GPU.\n\n"
        + "`confirm` must be true. It is not ceremony — the caller of this tool is usually driving "
        + "from a slug in a transcript and cannot see the folder it is about to remove, so the "
        + "confirmation is the moment to have read mv_open_project and be sure it is the right one.",
      inputSchema: {
        type: "object", required: ["slug", "confirm"],
        properties: {
          slug: { type: "string" },
          confirm: { type: "boolean", description: "Must be true. Anything else refuses." },
        }, additionalProperties: false,
      },
      async run(a) {
        /* Refused HERE rather than at the route: the page's Delete button has a
         * human in front of a dialog naming the project, which is the same
         * guard by other means, and adding a required argument to the route
         * would break that button to protect a caller it does not have. */
        if (a.confirm !== true) throw new Error("Refusing to delete without confirm:true — read mv_open_project first and be sure of the slug.");
        await mv({ action: "delete", slug: a.slug });
        return { deleted: a.slug };
      },
    },
    {
      name: "mv_segment",
      description: "Cut the analyzed song into scenes with the website's segmenter: scenes snap to whole lyric lines, and instrumental gaps become their own scenes. The longest scene defaults to the brief's (" + cutDefaultText() + "; mv_open_project cardFit.cut says the number and where it comes from). A line longer than the longest scene is the one thing split, into back-to-back scenes, and a short breath between two scenes is held through, so no sung second is left without a picture. max_clip_sec overrides the default, from 1 to " + MV_CLIP_CEILING_SEC + " s (refused past that: a longer scene would render short). DESTRUCTIVE: re-segmenting versions the set and marks existing boards/clips stale.",
      inputSchema: {
        type: "object", required: ["slug"],
        properties: {
          slug: { type: "string" },
          max_clip_sec: { type: "number" }, min_clip_sec: { type: "number" },
          instrumental_gap_sec: { type: "number" },
          /* THE FOURTH KNOB, and until now it was reachable by NOBODY: the
           * segmenter has honoured it since it was written, the route has read
           * it off the body all along, and neither this tool nor the page ever
           * put it there. A parameter that existed only in the source. */
          lead_in_sec: { type: "number", description: "Seconds of the preceding audio a lyrical clip may overlap, so a line has room to breathe before its first word. Default 0, which is the only value it has ever had." },
        }, additionalProperties: false,
      },
      async run(a) {
        const r = await mv({ action: "segment", slug: a.slug, maxClipSec: a.max_clip_sec, minClipSec: a.min_clip_sec, instrumentalGapSec: a.instrumental_gap_sec, leadInSec: a.lead_in_sec });
        return { segments: r.segments.map((s) => ({ id: s.id, index: s.index, start: s.startSec, end: s.endSec, kind: s.kind, mode: s.mode, thesis: s.thesisLine || null })) };
      },
    },
    {
      name: "mv_update_segment",
      description: "Change how one scene is covered (generate | broll | skip) or re-snap its boundaries. A mode change follows through to the linked clip and refuses to touch a scene that already rendered.",
      inputSchema: {
        type: "object", required: ["slug", "id"],
        properties: {
          slug: { type: "string" }, id: { type: "string" },
          mode: { type: "string", enum: ["generate", "broll", "skip"] },
          start_sec: { type: "number" }, end_sec: { type: "number" },
        }, additionalProperties: false,
      },
      async run(a) {
        const r = await mv({ action: "update_segment", slug: a.slug, id: a.id, mode: a.mode, startSec: a.start_sec, endSec: a.end_sec });
        return { segments: r.segments.length };
      },
    },
    {
      name: "mv_set_brief",
      description: "Write the creative brief — the interview's OUTPUT. You are the interviewer: ask the human about medium, tone and narrative in conversation, then record the answers here, including a 2-3 sentence direction_summary the later stages inherit.",
      inputSchema: {
        type: "object", required: ["slug"],
        properties: {
          slug: { type: "string" },
          medium: { type: "string" }, tone: { type: "string" }, narrative: { type: "string" },
          aspect_ratio: { type: "string", enum: [...MV_ASPECTS],
            description: "The two shapes the renderer makes. 1:1, 4:3 and 21:9 are refused: they used to be accepted and rendered 16:9." },
          free_text: { type: "string" }, direction_summary: { type: "string" },
          quality: { type: "string", enum: [...MV_SIZE_IDS],
            description: `The render size: ${sizeEnumText()}. recommended, small and preview are the H3 card `
              + `tiers (${cardTierText()}); a new project starts at its card's tier, `
              + "and mv_open_project cardFit.sizes says which this card reaches. "
              + "high on LTX costs about 3 minutes for a 5-second clip; on H3 about 11 at 4 steps "
              + "(the two shipped films, on a 16 GB card), and more at 8 or 20 steps." },
          video_engine: { type: "string", enum: ["h3", "ltx", "hybrid"],
            description: "hybrid (default) renders a scene on h3 when it carries cast or prop "
              + "references and on ltx otherwise, when LTX is on this PC; without LTX every scene "
              + "renders on h3 and the shot says so (cardFit.ltxReady). "
              + "ltx is ~7x faster and the one whose licence has no territory clause, and asking "
              + "for it explicitly now DROPS references rather than being overridden by them. "
              + "h3 is the only engine that takes reference images." },
          video_steps: { type: "integer",
            description: "Sampling steps per clip. Left unset, each scene runs at the count "
              + "the speed-up files on this PC were made for, with and without cast pictures "
              + "(mv_open_project cardFit.steps; it was a literal 8). Setting 4 selects H3's 4-step "
              + "distillation — workflow.js picks the LoRA by step count. With cast pictures a count "
              + "under the reference build's own is raised to it, and mv_shot says so." },
          base_scale: { type: "string", enum: ["auto", "full"],
            description: "LTX only, and only affects UNGUIDED clips. auto samples at half the "
              + "delivered size and upscales x2 in latent space, which is where faces go soft. "
              + "full samples once at the delivered size and skips the upscaler — a board-pinned "
              + "clip already does this, which is why loop:false quietly halves sampling resolution." },
          agent_budget_minutes: { type: "number",
            description: "The spend meter's soft budget: how many estimated GPU-minutes an AGENT "
              + "may spend on this project between one human approval and the next. null (the "
              + "default, and what every existing project has) is NO GATE — the meter is still "
              + "painted on the plan card so the number can be watched before it is enforced. "
              + "Suggested first value: 30, which is roughly one H3 clip at 1080p — an agent may "
              + "spend one expensive mistake unattended, never two." },
          song_conditioning: { type: "string", enum: ["auto", "always"],
            description: "Song under the clip: whether the song under each scene is frozen into an H3 REFERENCE render (it always is on LTX, and on H3 without references). always (new projects since 2026-09-24, Hex Appeal's setup): the song sits under every scene's clip, so sung shots follow the words (REWIND A/B, DIRECTING.md §2). auto: only boards with lipSync. Its render-time cost was never measured on its own. A close face that is not singing can open its mouth over a vocal: keep \"mouth closed\" in its words and check it. The clip's own audio is dropped either way." },
          cast_refs: { type: "boolean",
            description: "Default true. Reference pictures keep a face identical across scenes, "
              + "but they are H3-only, so at high quality they are the difference between a 5-hour "
              + "render and a 46-hour one. false keeps the cast in the PROMPT instead — less exact, "
              + "and the only way to have consistency AND 1080p in a night." },
        }, additionalProperties: false,
      },
      async run(a) {
        const brief = {};
        if (a.quality !== undefined) brief.qualityMode = a.quality;
        if (a.video_engine !== undefined) brief.videoEngine = a.video_engine;
        if (a.base_scale !== undefined) brief.baseScale = a.base_scale;
        if (a.video_steps !== undefined) brief.videoSteps = a.video_steps;
        if (a.cast_refs !== undefined) brief.castRefs = a.cast_refs;
        if (a.song_conditioning !== undefined) brief.songConditioning = a.song_conditioning;
        if (a.medium !== undefined) brief.medium = a.medium;
        if (a.tone !== undefined) brief.tone = a.tone;
        if (a.narrative !== undefined) brief.narrative = a.narrative;
        if (a.aspect_ratio !== undefined) brief.aspectRatio = a.aspect_ratio;
        if (a.free_text !== undefined) brief.freeText = a.free_text;
        if (a.direction_summary !== undefined) brief.directionSummary = a.direction_summary;
        if (a.agent_budget_minutes !== undefined) brief.agentBudgetMinutes = a.agent_budget_minutes;
        const r = await mv({ action: "set_brief", slug: a.slug, brief });
        return { brief: r.brief, stage: r.stage };
      },
    },
    {
      name: "mv_add_asset",
      description:
        "DECLARE a character, background or prop that has no picture yet — a name and a "
        + "description, which is all a row needs to exist and to be rendered later with "
        + "mv_generate_asset or mv_blender_sheet.\n\n"
        + "USE IT FOR PROPS, and this is the rule the pipeline gets wrong most often: any object "
        + "that appears in more than one scene and must be the SAME object — a car, a guitar, a "
        + "jacket, a suitcase — is CAST. An undeclared object is re-invented from the words on "
        + "every render, so it is a different car in every shot, and mv_lint and mv_crime_board "
        + "both report one the moment they can see it recurring. Declaring it is the fix: declare, "
        + "render its sheet, then list it in propRefs on every board it appears in.\n\n"
        + "The name is the BINDING KEY — boards reference by name and mv_set_bible merges by name — "
        + "so it must be unique across characters, backgrounds and props, and a duplicate is "
        + "refused rather than quietly making a second row nothing will ever resolve to. "
        + "A row declared here has imageFile:null, which is a real state and not an error: it is "
        + "what the render buttons act on. It does mean the clip carries nothing for it until a "
        + "sheet exists, so render one before mv_generate_clip.\n\n"
        + "Prefer mv_set_bible when writing the whole bible at once; this is the one-row door, for "
        + "when you notice a missing prop halfway through and do not want to re-author everything.",
      inputSchema: {
        type: "object", required: ["slug", "kind", "name"],
        properties: {
          slug: { type: "string" },
          kind: { type: "string", enum: ["characters", "backgrounds", "props"], description: "Which cast list — the project's own array name." },
          name: { type: "string", description: "Short, unique, and the word the prompts will use. This is how boards refer to it. Getting it wrong is repairable: mv_update_asset renames it and repoints every reference." },
          description: { type: "string", description: "What it looks like, specifically enough to redraw: for a prop, make/era/colour/condition and any distinguishing mark. This is what the sheet is rendered from." },
          role: { type: "string", enum: ["lead", "support"], description: "Characters only. Omit it for no role, which is what most rows have — anything else is refused rather than stored and ignored." },
          prompt: { type: "string", description: "An explicit sheet/plate prompt, used INSTEAD of the description when the sheet is rendered. Omit it and the description is used, which is usually right." },
        }, additionalProperties: false,
      },
      async run(a) {
        const r = await mv({ action: "add_asset", slug: a.slug, kind: a.kind, name: a.name,
                             description: a.description, role: a.role, prompt: a.prompt });
        const list = a.kind === "backgrounds" ? r.project.backgrounds
          : a.kind === "props" ? r.project.props : r.project.characters;
        const row = list[list.length - 1];
        return { id: row?.id, name: row?.name, stage: r.stage,
                 next: `mv_generate_asset (or mv_blender_sheet for a prop) with id "${row?.id}" to render its sheet` };
      },
    },
    {
      name: "mv_update_asset",
      description:
        "EDIT A DECLARED ROW — its description, its sheet prompt, its role, or its NAME.\n\n"
        + "THE NAME IS NOT A LABEL, and this is the part worth reading before using it. A cast "
        + "name is the BINDING KEY: boards reference by name, mv_set_bible and mv_set_board merge "
        + "by name, mv_set_shot resolves the names you tick, the <Picture N> legend in every clip "
        + "prompt is written from them, and each take records the names it was rendered with. "
        + "Change the name alone and every one of those points at something the project no longer "
        + "declares — measured on one sequence, renaming a prop that two boards carried took it "
        + "from 1 continuity break to 4 breaks and 2 errors, and the render drops the reference in "
        + "silence rather than failing.\n\n"
        + "So a rename has two outcomes and no third. With `cascade: true` the row and every "
        + "reference move together in one transaction — board reference lists, prominence weights, "
        + "the names recorded on existing takes, and the board/shot/hand-written prompt text that "
        + "mentions it — and the result says exactly what moved. WITHOUT it, a rename of anything "
        + "that is referenced is REFUSED, and the refusal lists the scenes, so you find out before "
        + "the project does. Renaming a row nothing references needs no cascade.\n\n"
        + "What a cascade deliberately does NOT rewrite, and reports instead under `elsewhere`: "
        + "the synopsis, the logline, the style bible, and other rows' descriptions. That is "
        + "authored prose about the story, not a key — edit it yourself if it matters.\n\n"
        + "The other fields are ordinary edits: `description` is what the sheet is rendered from, "
        + "`prompt` is the explicit sheet/plate text used instead of it (send \"\" to drop back to "
        + "the description), `role` is lead | support | null on a character. Renders nothing.",
      inputSchema: {
        type: "object", required: ["slug", "kind", "id"],
        properties: {
          slug: { type: "string" },
          kind: { type: "string", enum: ["characters", "backgrounds", "props"], description: "Which cast list the row is in." },
          id: { type: "string", description: "The row's id, or its exact current name." },
          name: { type: "string", description: "A new name. See the cascade rule above — this is a graph edit, not a field edit." },
          description: { type: "string" },
          prompt: { type: "string", description: "Explicit sheet/plate prompt; \"\" clears it and the description is used again." },
          role: { type: "string", enum: ["lead", "support"], description: "Characters only." },
          cascade: { type: "boolean", description: "Required to rename anything that is referenced: move the name and every reference to it in one transaction." },
        }, additionalProperties: false,
      },
      async run(a) {
        const r = await mv({ action: "update_asset", slug: a.slug, kind: a.kind, id: a.id,
                             name: a.name, description: a.description, prompt: a.prompt,
                             role: a.role, cascade: a.cascade });
        return { changed: r.changed, renamed: r.renamed };
      },
    },
    {
      name: "mv_import_asset",
      description: "Make a picture already on disk into a character, background or prop — the fastest path to a consistent cast when the art exists. Give it a NAME; that name is how boards and clip prompts refer to it. To declare one with no picture yet, use mv_add_asset.",
      inputSchema: {
        type: "object", required: ["slug", "path", "name"],
        properties: {
          slug: { type: "string" }, path: { type: "string", description: "Full local path to the image." },
          name: { type: "string" }, target: { type: "string", enum: ["character", "background", "prop"] },
          description: { type: "string", description: "The look, for the prompts: face/build, wardrobe, palette." },
          /* REACHABLE BY NOBODY until now, and unlike its two siblings it was
           * not even validated: the route wrote whatever string arrived onto
           * the row. It goes through readRole() at the route now, and this is
           * the caller that makes the argument exist. */
          role: { type: "string", enum: ["lead", "support"], description: "lead or support. Omit for neither, which is what most rows are." },
        }, additionalProperties: false,
      },
      /* `kind` on the wire, `target` in the schema: the route speaks ONE word
       * for which cast list a row is in (assetKind takes singular or plural),
       * and the agent-facing argument keeps the name agents already send. */
      async run(a) { return stageSummary(await mv({ action: "import_asset", slug: a.slug, path: a.path, name: a.name, kind: a.target || "character", description: a.description, role: a.role })); },
    },
    {
      name: "mv_import_clip",
      description:
        "Attach a clip that ALREADY EXISTS in the clips library as a take on a scene — the "
        + "video half of mv_import_asset, and the return leg of the polish loop: a vfx_render "
        + "lands in the clips library, this makes it the scene's take, and mv_build_timeline "
        + "then cuts it in exactly as it would a generated one (mv_read_timeline owns it as a "
        + "take, not a foreign item). Also the only way to give a b-roll segment footage. "
        + "No generation, no copy — the timeline already plays from that library.",
      inputSchema: {
        type: "object", required: ["slug", "segment", "clip"],
        properties: {
          slug: { type: "string" },
          segment: { type: "string", description: "Segment id (or index) from mv_segment." },
          clip: { type: "string", description: "A video NAME from the clips library (list_clips) — vfx renders and Studio exports live there too. Never a path." },
          seconds: { type: "number", description: "The clip's real length, if you know it (a vfx render's job reports its span). Recorded lengths are found automatically; the segment length is the fallback." },
          pick: { type: "boolean", description: "Default true: the imported take becomes the one that plays. false records it as a take without switching." },
        }, additionalProperties: false,
      },
      async run(a) {
        const r = await mv({ action: "import_clip", slug: a.slug, segmentId: a.segment,
                             clip: safeName(a.clip, "clip"), seconds: a.seconds, pick: a.pick });
        return { clip: r.clip, takes: (r.takes || []).map((t) => ({ clip: t.clip, seed: t.seed, imported: !!t.imported })) };
      },
    },
    {
      name: "mv_generate_asset",
      description:
        "Render a TAKE STRIP for a character sheet, background plate, prop sheet or storyboard — "
        + "up to 4 variants in different seeds from one text encode, appended to the row's takes. "
        + "Blocks (~10-30 s). The first take auto-selects; change with mv_pick_take.\n\n"
        + "READ `refs` BEFORE RENDERING A BOARD. A board is normally composed FROM the sheets it "
        + "references, which is how it carries identity — but a character sheet here is a "
        + "multi-panel contact strip, and handing a whole strip to the image model as an "
        + "in-context reference makes it reproduce THE STRIP: same three-panel layout, instead of "
        + "the single composed shot the board describes. Measured twice, and it is the rule "
        + "DIRECTING.md §2 states as \"references are SINGLE PANELS\". `refs: false` is that path.",
      inputSchema: {
        type: "object", required: ["slug", "kind", "id"],
        properties: {
          slug: { type: "string" },
          kind: { type: "string", enum: ["characters", "backgrounds", "props", "boards"], description: "Which list the row is in." },
          id: { type: "string", description: "The row's id or exact name." },
          count: { type: "integer", description: "1-4 variants. Default 4." },
          seed: { type: "integer" },
          refs: {
            type: "boolean",
            description: "Whether the referenced sheets are handed to the image model as in-context "
              + "references. Default true. DIRECTING.md §2: a reference is a SINGLE PANEL — handed a "
              + "contact strip whole, the model draws a contact strip (measured, twice). Send false "
              + "when the sheets are strips, which is what they are today: the same prompt with refs "
              + "off produced the correct single frame, with the look carried by the style bible alone.",
          },
        }, additionalProperties: false,
      },
      async run(a) {
        const r = await mv({ action: "generate_asset", slug: a.slug, kind: a.kind, id: a.id, count: a.count, seed: a.seed, refs: a.refs });
        /* ⚠ `prop` FELL THROUGH TO BOARDS. The route rendered the prop sheet
         * correctly and this lookup then searched the wrong array, so every
         * prop render answered `{takes: [], chosen: undefined}` — the work
         * happened and the tool reported nothing, which reads as a failure. */
        const list = r.project[a.kind] || r.project.characters;
        const row = list.find((x) => x.id === a.id || x.name === a.id);
        return { takes: (row?.takes || []).map((t) => ({ file: t.file, seed: t.seed })), chosen: row?.imageFile,
                 /* Say which it did. The refs flag decides whether this render was "compose
                  * from the sheets" or "compose from the words", and those are different
                  * pictures — a report that does not name the choice cannot be compared. */
                 refs: a.refs === undefined ? "default (true)" : a.refs };
      },
    },
    {
      name: "mv_blender_catalogue",
      description:
        "What Blender can actually be asked to render, and whether Blender is installed at all. "
        + "READ THIS BEFORE mv_blender_sheet — it returns the complete vocabulary of named "
        + "builtins, and there is no way to guess a name that works. Builtins are meshes out of "
        + "the toolkit's gray-box sets, named \"<set>:<mesh>\" (\"dig:artifact\", \"room:stack\", "
        + "\"warship:holotank\"). Also returns the camera angles, the model-file formats that can "
        + "be imported instead, and — when Blender is missing — the sentence saying so, so you can "
        + "fall back to mv_generate_asset rather than spending a failed render finding out.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async run() { return api("GET", "/api/mv/blender"); },
    },
    {
      name: "mv_blender_sheet",
      description:
        "Render a declared character/background/PROP sheet with Blender instead of the image "
        + "engine, and record it exactly as mv_generate_asset does: takes on the same row, first "
        + "take auto-selected into the same imageFile, boards and mv_lint unchanged. Swap between "
        + "a Blender take and a generated one with mv_pick_take.\n"
        + "WHY: an image model re-invents an object from its description on every call — the same "
        + "car arrives a different car each time. A mesh IS the same object on every call, so this "
        + "is the tool for the rows where identity matters most (DIRECTING.md: props are cast). "
        + "The clip engine renders in the STYLE of its reference, so a grey studio render does not "
        + "make a grey film; it makes the same object.\n"
        + "WHAT IT CANNOT DO — read this before choosing it. There is no text-to-3D here. Blender "
        + "cannot model a noun from a sentence, so this renders ONE of exactly two things: a named "
        + "builtin from mv_blender_catalogue (a crate stack, a drum, a plinth, a faceted monolith "
        + "— a blunt gray-box vocabulary, right for \"the artifact\", useless for anything with a "
        + "make and model), or a model file YOU supply (.blend .obj .glb .gltf .fbx .stl), which "
        + "somebody has to have modelled first. For \"a sun-bleached teal sedan\" use "
        + "mv_generate_asset; it is better at that than this will ever be.\n"
        + "Each angle is a separate SINGLE-PANEL take, never a grid: a grid handed to a model "
        + "teaches it to draw a grid (measured twice). Every panel is checked against its render "
        + "sidecar before it can become imageFile, and a panel that cannot prove it is a "
        + "single-panel model reference is dropped and reported in `refused`.",
      inputSchema: {
        type: "object", required: ["slug", "id"],
        properties: {
          slug: { type: "string" },
          target: { type: "string", enum: ["character", "background", "prop"],
                    description: "Default \"prop\" — the row kind this exists for. A board is a composed shot, not a sheet: build boards with mv_generate_asset from the sheets this makes." },
          id: { type: "string", description: "The row's id or exact name. The row must already be declared (mv_set_bible or mv_import_asset)." },
          builtin: { type: "string", description: "\"<set>:<mesh>\" from mv_blender_catalogue, e.g. \"dig:artifact\". Exactly one of builtin or asset." },
          asset: { type: "string", description: "Full local path to a .blend/.obj/.glb/.gltf/.fbx/.stl. Exactly one of builtin or asset." },
          angles: { type: "array", items: { type: "string" },
                    description: "One take per angle. Default three_quarter, front, side — the reference-photograph convention. There is no seed: the render is deterministic, so the camera is the only axis that varies." },
          res: { type: "integer", description: "Square pixels per panel, 256-2048. Default 1024." },
          samples: { type: "integer", description: "Render samples, 8-256. Default 64." },
          transparent: { type: "boolean", description: "Alpha instead of the neutral cyclorama. Off by default — the card is what keeps environment out of the reference." },
          /* ⚠ aspect and lens were read by the route, clamped by blender.js and
           * honoured by the toolkit — and named in NO schema and on no page.
           * Dead parameters: the class of defect that once shipped 153 of
           * itself in this repository, and invisible to a gate that matches
           * action NAMES. Found by the parameter census now in
           * server/mv/ui_test.js, which fails if another one appears. */
          aspect: { type: "string", enum: ["square", "16:9", "4:3", "3:2", "9:16"],
                    description: "Panel shape. Default square — the reference-photograph convention, and the only one these sheets have been looked at in." },
          lens: { type: "number", description: "Focal length in mm, default 85. That is portrait compression, which is what a reference wants; a wide lens bends the proportions of the object and the clip model copies the bend." },
        }, additionalProperties: false,
      },
      async run(a) {
        const r = await mv({
          action: "blender_asset", slug: a.slug, kind: a.target || "prop", id: a.id,
          builtin: a.builtin, asset: a.asset, angles: a.angles,
          res: a.res, samples: a.samples, transparent: a.transparent,
          aspect: a.aspect, lens: a.lens,
        });
        return { takes: r.takes, refused: r.refused, stage: r.stage };
      },
    },

    /* ── GEOMETRY THE PANEL ALREADY IMPLIES ────────────────────────────────
     * mv_blender_sheet renders an object somebody modelled first, and says so
     * loudly: there is no text-to-3D in it. These are the other half — the mesh
     * is MADE from the sheet the row already carries, which is precisely the
     * case blender_sheet has to refuse ("useless for anything with a make and
     * model"). Two tools rather than one because building and rigging fail for
     * different reasons and are refused on different evidence. */
    {
      name: "mv_mesh_status",
      description:
        "Is there a 3D runtime on this machine, and what does it produce? READ THIS BEFORE "
        + "mv_mesh_from_image. It answers without loading a model or touching the card, and it "
        + "names any missing piece — the venv, either checkout, either set of weights — so a "
        + "missing install costs a read rather than a failed run. It also returns the format "
        + "contract and the accepted input formats.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async run() { return api("GET", "/api/mv/mesh"); },
    },
    {
      name: "mv_mesh_from_image",
      description:
        "Turn a declared character/background/PROP row's rendered sheet into a 3D MESH, recorded "
        + "on the same row the sheet is on (a new `meshFile`, the same takes, the same project). "
        + "Optionally rig it in the same pass.\n\n"
        + "FORMAT CONTRACT — what comes back, and it is CHECKED rather than claimed. The output is "
        + "a GLB. A RIGGED output is a GLB WITH A SKIN: glTF `skins[]` carrying `joints` and "
        + "`inverseBindMatrices`, used by a mesh node. That pair IS the contract, because it is "
        + "what the downstream requires and because a mesh and a rigged mesh have the same "
        + "extension and nearly the same size — so \"the rig succeeded\" cannot be read off an exit "
        + "code. The container is parsed after every run and `skinned` in the answer is that "
        + "assertion, not the subprocess's own opinion.\n\n"
        + "AND THEN THE SKELETON IS POSED, because `skinned` is only half the contract. Two GLBs "
        + "can carry the same `skins[]`, the same joints, the same MAT4 `inverseBindMatrices`, the "
        + "same JOINTS_0/WEIGHTS_0 with every weight row summing to one, and come out the same size "
        + "to the byte, while one of them deforms and the other cannot be posed at all — a rigger "
        + "that binds every vertex to the root produces the second. So every joint is turned and "
        + "the change in the mesh's own shape is measured: `rigged` is BOTH answers, `deforms` "
        + "reports the measurement, and only a `rigged` result is filed as the row's rigFile. A "
        + "rig that ran and produced no usable skin, OR a skin that binds without deforming, comes "
        + "back as `rigRefused` with its reasons, and the MESH is still kept.\n\n"
        + "⚠ VRAM — READ THIS BEFORE SPENDING. This runs in its own python on the SAME 16 GB card "
        + "the music and video engine lives on, and it REFUSES BEFORE STARTING when free VRAM is "
        + "under the catalogue row's stated minimum. That refusal is the useful outcome: it names "
        + "the engine as the thing holding the card and says to unload it first, rather than dying "
        + "in a CUDA out-of-memory forty seconds in with an error about neither. Nothing here will "
        + "evict the engine — a mesh is not worth somebody's half-finished song. On that refusal, "
        + "do not retry: stop the engine, or wait.\n\n"
        + "WHAT IT IS FOR. DIRECTING.md: props are cast. An image model re-invents an object from "
        + "its description on every call — the same car arrives a different car each time. A mesh "
        + "IS the same object. mv_blender_sheet gives you that when somebody has already modelled "
        + "the thing; this gives you it from one panel.\n"
        + "⚠ AND WHAT IT IS NOT. A mesh is NEVER a clip reference: the clip engines take pictures, "
        + "so a mesh cannot be handed to VACE or H3. This does not touch `imageFile` and does not "
        + "replace the sheet — it adds a second artefact to the row.\n"
        + "The input must be ONE PANEL OF ONE SUBJECT. Handed a contact strip this builds a mesh "
        + "OF THE STRIP, so a proven contact sheet is refused before anything is spent — the same "
        + "gate, and the same measured lesson, as DIRECTING.md §2.",
      inputSchema: {
        type: "object", required: ["slug", "id"],
        properties: {
          slug: { type: "string" },
          target: { type: "string", enum: ["character", "background", "prop"],
                    description: "Default \"prop\" — the row kind this exists for. A board is a composed shot, not an object." },
          id: { type: "string", description: "The row's id or exact name. It must already be declared and already carry a rendered sheet, or you must supply `image`." },
          image: { type: "string", description: "OPTIONAL full local path to a .png/.jpg/.webp to use INSTEAD of the row's selected take. For when the selected take is not the clearest single panel of the object. Default: the row's own sheet." },
          rig: { type: "boolean", description: "Also put a skeleton in it, in the same pass. Default false. It costs a second model load, and it is refused on a mesh whose proportions are not plausibly articulated — see mv_mesh_rig." },
          seed: { type: "integer", description: "Sampling seed, recorded on the run so a mesh can be reproduced." },
          steps: { type: "integer", description: "Sampling steps. Default 50. Fewer is faster and coarser — the one knob that trades time against surface detail." },
        }, additionalProperties: false,
      },
      async run(a) {
        const r = await mv({
          action: "mesh_asset", slug: a.slug, kind: a.target || "prop", id: a.id,
          image: a.image, rig: a.rig, seed: a.seed, steps: a.steps,
        });
        return { mesh: r.mesh, skinned: r.skinned, joints: r.joints,
                 /* Said out loud rather than swallowed: a rig that produced no
                  * skin is a failure wearing a success's exit code. */
                 rigRefused: r.rigRefused, runId: r.runId, elapsedSec: r.elapsedSec, stage: r.stage };
      },
    },
    {
      name: "mv_mesh_rig",
      description:
        "Put a skeleton and skinning weights into a mesh the row ALREADY has, and write the result "
        + "back as `rigFile` beside it. The mesh itself is left standing, so a rig that comes out "
        + "wrong costs nothing but its own run.\n\n"
        + "FORMAT CONTRACT, the same as mv_mesh_from_image and asserted the same way: a GLB whose "
        + "glTF `skins[]` carry `joints` and `inverseBindMatrices`, used by a mesh node. A result "
        + "with no usable skin is reported as a failure even though the subprocess exited zero, "
        + "because a file being written proves nothing about what is in it.\n\n"
        + "⚠ IT REFUSES A MESH THAT IS NOT PLAUSIBLY ARTICULATED, measured off the mesh's own "
        + "declared bounds: when the longest axis is not meaningfully longer than the other two it "
        + "is a blocky object, and the rigger asked to rig a crate does not fail — it invents a "
        + "skeleton for a crate and reports success. That is the expensive kind of wrong, so it is "
        + "refused before it is spent.\n"
        + "⚠ VRAM: the same rule as mv_mesh_from_image. It refuses rather than competing with the "
        + "resident engine for the one card.",
      inputSchema: {
        type: "object", required: ["slug", "id"],
        properties: {
          slug: { type: "string" },
          target: { type: "string", enum: ["character", "background", "prop"], description: "Default \"prop\"." },
          id: { type: "string", description: "The row's id or exact name. It must already carry a meshFile." },
        }, additionalProperties: false,
      },
      async run(a) {
        const r = await mv({ action: "mesh_rig", slug: a.slug, kind: a.target || "prop", id: a.id });
        return { rig: r.rig, joints: r.joints, runId: r.runId, elapsedSec: r.elapsedSec, stage: r.stage };
      },
    },

    /* ── BLOCKED SHOTS ─────────────────────────────────────────────────────
     * blender_* is the SHEET path: one object, many angles, identity held by a
     * mesh. previz_* is the SHOT path: the camera moves. Three tools because
     * there are three artefacts with three different standings, and the whole
     * value of the feature is that they are not confused for one another. */

    {
      name: "mv_shot_plan",
      description:
        "A camera move, WRITTEN OUT — the sentences a board's shot can be built from. Free, "
        + "instant, and needs no Blender: this is a pure function of the move name and the "
        + "framing.\n"
        + "WHY THIS IS THE IMPORTANT ONE. H3 takes a prompt and reference images. It does not "
        + "take a camera curve, so of everything the previz path produces, WORDS are the only "
        + "artefact that actually reaches the model. Returns four sentences kept apart on "
        + "purpose — camera (where the lens goes), framing (how much is in shot), placement "
        + "(WHERE IN THE FRAME the subject sits) and lens (what the focal length does) — plus "
        + "`board_shot`, ready to paste into mv_set_board.\n"
        + "Placement is the one people leave out and the one that pays: \"orbit around her\" "
        + "gives a subject nailed to frame centre with the world spinning; \"she holds the right "
        + "third while the background slides behind her\" gives the shot that was wanted.\n"
        + "NOT A GUARANTEE. These are an instruction to a model that may or may not follow "
        + "them, and no amount of previz makes them more likely to be obeyed. `board_move` is "
        + "the nearest word in the board vocabulary and `board_move_exact` says when that word "
        + "is a lossy stand-in — offset_follow has to go in `action` as a sentence, because "
        + "\"tracking\" is exactly the robotic shot it exists to replace.",
      inputSchema: {
        type: "object", required: ["move"],
        properties: {
          move: { type: "string", description: "orbit, push_in, pull_out, offset_follow, crane, floor_rise, robo_arm, handheld, speed_ramp, static, or a two-beat composite (follow_orbit, crane_plan). Legacy spellings work too. mv_previz_moves lists them all with a one-line gist." },
          framing: { type: "string", enum: ["wide", "medium", "close", "extreme close", "over-the-shoulder", "insert", "establishing"] },
          subject: { type: "string", description: "What the shot is of, by the name the board uses — a character or prop row's name, so the sentence names the same thing the references do." },
          third: { type: "string", enum: ["left", "right", "centre"], description: "Which third of frame the subject holds. Centre is the default and is usually wrong for a follow." },
          pronoun: { type: "string", enum: ["they", "she", "he", "it"], description: "Default \"they\". Declined properly through the prose — ungrammatical English in a prompt is noise in the sentence meant to be steering." },
          side: { type: "string", description: "Which side the camera keeps for a follow, e.g. \"the left\". Default \"the left\"." },
          angle: { type: "string", description: "A camera angle in words (\"low\", \"from behind\"), folded into the framing sentence." },
          action: { type: "string", description: "What HAPPENS. Placed first in board_shot.action, ahead of the camera prose." },
          lensFeel: { type: "string" }, lighting: { type: "string" },
          /* Both were read by moves.js and reachable from nowhere. `degrees` is
           * the only number in the orbit sentence — "arcs 90°" is a default, not
           * a fact about the shot — and `base` is what robo_arm and speed_ramp
           * name as the move underneath them. Found by the parameter census. */
          degrees: { type: "number", description: "How far an orbit arcs, in degrees. Default 90. Only orbit and its composites say a number out loud." },
          base: { type: "string", description: "For handheld and speed_ramp — the two moves that are layered OVER another one: the move happening underneath, by name (e.g. \"push_in\"). Without it a speed ramp's sentence says only \"its path\", which steers nothing. Every other move ignores it." },
          move_args: {
            type: "object",
            description:
              "THE SAME KEYWORDS mv_previz_shot takes, priced at nothing. This tool is the "
              + "free half — words, no Blender — so it is where a steered shot gets read "
              + "before anything is spent on it. Without them the sentences describe the "
              + "move's DEFAULTS, which is what the app used to record against steered "
              + "clips: \"arcs 90°\" against a measured 75.000° sweep, \"cut at the waist on "
              + "a figure\" against a push-in holding the whole body, and the same "
              + "paragraph word-for-word for a crane that held its subject 121/121 frames "
              + "and one that lost it after 42. Only the keywords a SENTENCE reads change "
              + "the words — aim_at, degrees, framing; one about geometry alone (rise, "
              + "climb) is carried and changes nothing here. Which keys a move accepts is "
              + "the move's business, not this schema's.",
            additionalProperties: true,
          },
        }, additionalProperties: false,
      },
      async run(a) {
        /* ⚠ `shotAction`, NOT `action`. The route dispatches on `action`, and a
         * shot's own action sentence is also called action — written as one
         * object literal the second key silently wins, so this tool posted
         * {move} with no dispatch key at all and the server answered "Unknown
         * action:". Caught by calling the tool for real; nothing static would
         * have. The wire name is different from the field name on purpose. */
        const r = await mv({ action: "previz_plan", move: a.move, framing: a.framing,
                             subject: a.subject, third: a.third, pronoun: a.pronoun, side: a.side,
                             angle: a.angle, shotAction: a.action,
                             lensFeel: a.lensFeel, lighting: a.lighting,
                             degrees: a.degrees, base: a.base, moveArgs: a.move_args });
        return r.plan;
      },
    },
    {
      name: "mv_previz_moves",
      description:
        "The camera vocabulary a shot can be planned or blocked with, the gray-box sets it can "
        + "be blocked in, and whether Blender is installed at all. READ THIS FIRST — the move "
        + "names are a fixed list and there is no guessing one that works.\n"
        + "The moves are returned WHETHER OR NOT Blender is present, because the words half "
        + "needs none. Only the rendering half does.\n"
        + "`probe: true` costs one Blender launch (~4s) and asks the toolkit what IT knows, then "
        + "reports `drift` in both directions — a name here it cannot build, and a move it has "
        + "that nothing here can reach. Worth running once after the toolkit is updated; "
        + "otherwise it is the same answer for free.",
      inputSchema: {
        type: "object",
        properties: { probe: { type: "boolean", description: "Launch Blender and cross-check the two vocabularies. Default false." } },
        additionalProperties: false,
      },
      async run(a) { return api("GET", `/api/mv/previz${a.probe ? "?probe=1" : ""}`); },
    },
    {
      name: "mv_previz_shot",
      description:
        "BLOCK a shot in Blender: a previz clip to watch, optionally a reference frame from the "
        + "shot's own camera angle, and always the words. Blocks ~25s per shot. Needs Blender; "
        + "without it you get the words and a sentence saying which half is missing, not an "
        + "error.\n"
        + "THE THREE THINGS IT RETURNS HAVE THREE DIFFERENT STANDINGS, and this is the whole "
        + "point of the tool:\n"
        + "  previz — a gray-box .mp4 marked use:HUMAN-REVIEW. A director watches it to judge a "
        + "shot before spending twenty-eight minutes of H3 on it. Do NOT hand it to a video "
        + "model. A gate experiment established that a blocking clip fed to LTX as an appearance "
        + "guide does not carry the camera move into the render — it hands the gray boxes back. "
        + "Nothing here wires it in as a control video and neither should you.\n"
        + "  reference — ONE single-panel .png of a named subject, rendered from the azimuth and "
        + "elevation the blocked camera occupies (recovered from the camera track). It goes "
        + "through the same gate as every other reference and is reported `safe:false` with "
        + "reasons if it fails. It is not a still lifted out of the clip: a picture of a whole "
        + "gray-box set is refused outright, because identifiable environment bleeds into the "
        + "render.\n"
        + "  plan — the words. The only one of the three that reaches the model. Available even "
        + "when the other two are not.\n"
        + "  blockout — the SAME grey boxes, rendered at the control-video contract "
        + "(1280x704, 24.000 fps, 121 frames) and marked use:vace-control. Ask for it with "
        + "`blockout: true`. THIS one IS handed to a model — to WAN 2.1 VACE's control_video, "
        + "which is a different node from the LTX appearance guide that failed and a measured "
        + "positive: arm W1, CMA 0.924, still GENERATING rather than reconstructing. It is a "
        + "separate file with a separate sidecar and it never replaces the previz. Steer with "
        + "it through mv_control_render with source \"blockout\".\n"
        + "  spec — the STAGING, and what makes a blockout worth rendering: "
        + "{set, figures:[{id, at:[x,y,z] metres, to?:[x,y,z]}], props:[{id, kind, at, size}]}. "
        + "`at` is where the thing STANDS, not its centre; `to` is a straight walk from `at` on "
        + "frame 1 to `to` on the last frame. It overrides the set's default figures and props "
        + "— the sets stay presets and the camera stays on `move`. The blockout's "
        + "sidecar records the spec's sha256 and the per-frame projected pixel position of "
        + "every figure's neck and hip, which is the ground truth a consistency measurement "
        + "reads.\n"
        + "A reference needs a subject you can actually render — a builtin from "
        + "mv_blender_catalogue or a model file. There is no text-to-3D here.",
      inputSchema: {
        type: "object", required: ["slug", "move"],
        properties: {
          slug: { type: "string" },
          move: { type: "string", description: "From mv_previz_moves. Two-beat composites (follow_orbit, crane_plan) are named the same way." },
          segment: { type: "string", description: "Segment id or index, to file the previz against a scene. Optional — a shot can be blocked with no scene in mind." },
          scene: sceneArg,
          frames: { type: "integer", description: "121-480, default 144 (six seconds at 24fps). The two kinds answer a below-floor request differently, and mv_previz_moves (GET /api/mv/previz) carries the rule as data so neither surface keeps its own copy: for a PREVIZ, `frames.below` is \"rounded up to the floor\"; for a BLOCKOUT, `blockout.framesBelow` is \"refused\" — the route answers 400 before Blender is launched — with `blockout.framesMin` and `blockout.framesWhy` beside it." },
          render: { type: "boolean", description: "Default true. false returns only the words, spending nothing." },
          framing: { type: "string", enum: ["wide", "medium", "close", "extreme close", "over-the-shoulder", "insert", "establishing"] },
          subject: { type: "string" }, third: { type: "string", enum: ["left", "right", "centre"] },
          pronoun: { type: "string", enum: ["they", "she", "he", "it"] },
          angle: { type: "string" }, action: { type: "string" },
          /* Read by previz.js — `lens` goes to the toolkit as --lens and the
           * other two into the words — and reachable from nothing until the
           * parameter census went looking. */
          lens: { type: "number", description: "Focal length in mm for the PREVIZ render. Changes the blocking clip, not the words." },
          lensFeel: { type: "string" }, lighting: { type: "string" },
          reference: {
            type: "object", description: "Omit for no reference frame. Give exactly one of builtin or asset.",
            properties: {
              builtin: { type: "string", description: "\"<set>:<mesh>\" from mv_blender_catalogue." },
              asset: { type: "string", description: "Full path to a .blend/.obj/.glb/.gltf/.fbx/.stl." },
              angle: { type: "string", description: "Fallback named angle, used only if no camera track was written." },
              res: { type: "integer" }, samples: { type: "integer" },
            }, additionalProperties: false,
          },
          u: { type: "number", description: "Where in the move to take the reference's viewpoint, 0-1. Default 0.5. Moves that aim off-subject by design (offset_follow, crane, floor_rise) report the viewpoint as approximate rather than pretending." },
          blockout: { type: "boolean", description: "Default false. true renders a CONTROL clip for WAN 2.1 VACE instead of a previz for a person: the 121-frame floor is enforced BEFORE Blender is launched rather than discovered after, the look is flat grey, the frame default drops from 144 to 121 because every frame past the floor is render time downstream, and the sidecar carries the spec hash and the per-frame projected neck/hip pixel position of every figure. Separate file, separate sidecar; it never replaces the previz of the same move." },
          spec: {
            type: "object",
            description: "The STAGING — which figures and props stand where — overriding this set's defaults. The sets stay presets and the camera stays on `move`: a spec that could ALSO name the camera would be a second place for the camera to be named, and the loser of that argument is silent. Metres, +Z up.",
            properties: {
              set: { type: "string", description: "Must equal `scene`, or be left out and it takes it. A disagreement is refused rather than resolved, because guessing renders the set nobody asked for." },
              figures: { type: "array", description: "Up to 24 of {id, at:[x,y,z], to?:[x,y,z], height?}. `at` is where the figure STANDS. `to` is a straight walk from `at` on frame 1 to `to` on the last frame with NO lead-in, so the sidecar's frame-1 pixel position really is `at`. height defaults to 1.75 m, and must be inside [0.2, 4.0]." },
              props: { type: "array", description: "Up to 64 of {id, kind:\"box\"|\"cylinder\", at:[x,y,z], size:[x,y,z]}. `at` is the base, `size` the bounding extent in metres. A cylinder's x and y are its DIAMETER and must be equal — an elliptical one is refused rather than silently rounded." },
              note: { type: "string", description: "Free text, carried into the spec's hash: two stagings that differ only in the note are different stagings." },
            },
            additionalProperties: false,
          },
          move_args: {
            type: "object",
            description:
              "THE MOVE'S OWN ARGUMENTS, and the difference between naming a move and "
              + "DIRECTING one. `move` picks the class; these are the keywords that class "
              + "takes, passed to the toolkit one at a time. Measured on the four PRISM "
              + "blockouts, every one of them on the stage set: a crane with no arguments "
              + "held the idol in 42 of 121 frames and ended on a frame that was 80.8% "
              + "arena floor with zero idol pixels; `{\"aim_at\": \"neck\", \"rise\": 6.0}` "
              + "held it 121/121. A floor_rise with none climbed its home set's 19.2 m and "
              + "left the stage behind (33/121); `{\"aim_at\": \"neck\", \"climb\": 6.0}` ends "
              + "at truss height looking down. A push_in with none cut the figure at "
              + "mid-thigh; `{\"framing\": \"full\"}` DERIVES the end distance from the band "
              + "the frame has to hold. An orbit with none sweeps the toolkit's default "
              + "however wide you meant it.\n"
              + "WHICH KEYS ARE LEGAL IS THE MOVE'S BUSINESS, not this schema's — a list "
              + "typed here would be a second vocabulary going stale in silence. Ask "
              + "mv_previz_moves with `probe: true` and read `drift.moveArgVocabulary` for "
              + "the framings and body parts the toolkit really has; an unknown key comes "
              + "back as a refusal NAMING it, before a frame is rendered.\n"
              + "Values keep their JSON type across the boundary, so 6.0 arrives a number "
              + "and \"neck\" arrives a name. Refused on the two-beat composites "
              + "(follow_orbit, crane_plan): those are shot lists, not one move, so there "
              + "is no single camera for a keyword to argue with.",
            additionalProperties: true,
          },
        }, additionalProperties: false,
      },
      async run(a) {
        const r = await mv({ action: "previz_shot", slug: a.slug, move: a.move,
                             segmentId: a.segment, scene: a.scene, frames: a.frames,
                             render: a.render, framing: a.framing, subject: a.subject,
                             third: a.third, pronoun: a.pronoun, angle: a.angle,
                             shotAction: a.action, reference: a.reference, u: a.u,
                             lens: a.lens, lensFeel: a.lensFeel, lighting: a.lighting,
                             blockout: a.blockout, spec: a.spec, moveArgs: a.move_args });
        return { plan: r.plan, previz: r.previz, blockout: r.blockout,
                 /* HANDED BACK, so the caller can see what the far side really read
                  * rather than what it typed: the values have been through JSON in
                  * both directions by the time they appear here. */
                 move_args: r.moveArgs,
                 reference: r.reference, installed: r.installed, note: r.note };
      },
    },

    /* ── STRUCTURAL CONTROL ────────────────────────────────────────────────
     *
     * ⚠ THESE TWO TOOLS AND mv_previz_shot ABOVE ARE OPPOSITES, and an agent
     * that conflates them will waste a night. A previz is grey boxes marked
     * HUMAN-REVIEW and handing one to a video model gives the grey boxes back
     * (measured, on LTX's appearance-guide path). These hand a REAL clip to WAN
     * 2.1 VACE's control_video, which is a different node, a different
     * mechanism and a measured positive. Both tools' descriptions carry the
     * clip contract IN WORDS, because an agent reading only the description is
     * the common case and all three numbers fail silently. */
    {
      name: "mv_control_render",
      description:
        "STEER A RENDER WITH A REAL VIDEO — WAN 2.1 VACE takes a control clip and carries its "
        + "camera move, or a performance, into a generated shot. Blocks about 32 MINUTES for the "
        + "camera path and about 34 for the pose path, which is two renders. This is the most "
        + "expensive single call on this surface.\n\n"
        + "⚠ THE CLIP CONTRACT, AND ALL THREE OF THESE FAIL SILENTLY. The source clip must be "
        + "EXACTLY 1280x704, EXACTLY 24.000 fps, and AT LEAST 121 FRAMES. Not one of them "
        + "produces an error, a warning or a red node; each produces a finished mp4 that is not "
        + "the shot you asked for, after the render time is already spent. A wrong SIZE is "
        + "bilinear-resampled and CENTRE-CROPPED, so your framing is gone. A short clip is "
        + "CLAMPED and then padded with flat mid-gray, so the end of the shot conditions on "
        + "nothing and the camera lets go. A wrong FRAME RATE is not read at all — the frames "
        + "are counted and replayed at 24, so the move is silently retimed and the file looks "
        + "perfectly fine. This tool MEASURES the clip with ffprobe before it stages anything "
        + "and refuses by name and by number, so a refusal costs you nothing and tells you "
        + "exactly what to fix. 24000/1001 is 23.976 and is refused: it is a different number.\n\n"
        + "WHAT IS MEASURED. Arm W1 of the camera gate: camera-motion agreement 0.924 against a "
        + "0.50 floor and its own TIME-SHIFT null of 0.402 (that null is W1's own motion with the "
        + "timing destroyed, NOT a strength-zero arm — the strength-0.00 arm is W8 and it "
        + "scored -0.056, and the no-control-wire arm W0 scored -0.019), motion ratio 0.82, "
        + "and SSIM 0.524 "
        + "against a 0.736 bar — BELOW the bar, which is what \"generated rather than "
        + "reconstructed\" means. The strength ladder was rendered, not guessed: 0.25 does "
        + "nothing, 0.50 passes softly, 1.00 is the shipped default, 2.00 RECONSTRUCTS and hands "
        + "the source footage back instead of a shot. Only 1280x704 x 121 frames has ever been "
        + "rendered, so no other size is built.\n\n"
        + "WHAT IS NOT MEASURED, and do not let a confident number cover it: what a "
        + "reference_image does to the camera score (no gate arm ever supplied one), any "
        + "strength but 1.00 on the pose path, and a full-body dance — see mv_pose_extract for "
        + "why. LICENCE: the WAN weights are Apache-2.0, verified against the licence text at a "
        + "pinned revision with zero differences and no territory clause, so a clip rendered "
        + "here is yours to sell. mode \"pose\" additionally runs DWPose, whose ESTIMATOR has no "
        + "readable licence at all — mv_control_catalogue returns both answers separately.\n\n"
        + "mode \"depth\" is the THIRD door: Depth Anything V2 reads the clip into a depth video "
        + "first and VACE steers with that — where everything is and how far, with the look left "
        + "to the prompt and a reference. This is the structure half of a video-to-video restyle "
        + "(a dancer repainted, the room kept). depth_model \"small\" (default) is Apache-2.0; "
        + "\"large\" is CC-BY-NC-4.0 and marks the chain non-commercial. ⚠ UNSCORED: no depth arm "
        + "has been measured — the pose gate's number does not transfer. A 720p, 30 fps or any "
        + "other off-contract source is refused by the gate: run mv_control_conform first, then "
        + "steer with the clip it writes.\n\n"
        + "`clip` is a NAME from the clips library (the same library mv_import_clip reads), not "
        + "a path. Render one with mv_generate_clip, import one, or make a skeleton with "
        + "mv_pose_extract — a skeleton passes this same gate and is a legal source. The output "
        + "is adopted into the clips library with its runId, so engine_activity and "
        + "mv_pick_take can both reach it.",
      inputSchema: {
        type: "object", required: ["slug", "prompt"],
        properties: {
          slug: { type: "string" },
          source: { type: "string", enum: ["clip", "blockout"], description: "Which door the frames come through. \"clip\" (default) takes `clip`, a name from the shared clips library. \"blockout\" takes THIS SHOT'S OWN blockout — the grey-box control clip mv_previz_shot renders with `blockout: true`, staged from a blocking spec, living in this project's assets rather than on the shared shelf; give `segment` to say which shot, and leave `clip` out. Both doors run the same gate: the file is measured with ffprobe and refused by number before a byte is staged." },
          clip: { type: "string", description: "Required when source is \"clip\" (the default). A video NAME from the clips library. Must be exactly 1280x704, exactly 24.000 fps and at least 121 frames — measured before anything is spent." },
          prompt: { type: "string", description: "What to render. Required and non-empty: WAN renders a gray field from an empty prompt and reports success." },
          mode: { type: "string", enum: ["camera", "pose", "depth"],
                  description: "camera (default) puts the clip on control_video as given — the measured path. pose extracts a DWPose skeleton first and steers with that; it is TWO renders and roughly 34 minutes. Use mv_pose_extract to make and inspect a skeleton on its own for half a minute." },
          segment: { type: "string", description: "Segment id or index, to file the render against a scene. Optional." },
          reference: { type: "string", description: "A project ASSET image (a single-panel character sheet), for reference_image. ⚠ Untested by the camera gate: no arm ever supplied one, so what it does to the camera score is unmeasured. It DID carry the character in the pose gate, at z 2.57." },
          negative: { type: "string", description: "Defaults to the negative arm W1 ran with. Change it and the gate numbers are about a different graph." },
          seed: { type: "integer", description: "Omit and one is minted AND RETURNED — this path exists to be reproducible, so the seed is always on the record." },
          depth_model: { type: "string", enum: ["small", "large"], description: "mode \"depth\" only: which Depth Anything V2 reads the clip. small (default) is Apache-2.0; large is CC-BY-NC-4.0, finer, NON-COMMERCIAL." },
          strength: { type: "number", description: "VACE residual strength, default 1.00 (the measured default). 0.50 also passes; 0.25 does nothing; 2.00 reconstructs. Anything off 1.00 on the pose path is unmeasured." },
        }, additionalProperties: false,
      },
      async run(a) {
        const r = await mv({ action: "control_render", slug: a.slug, clip: a.clip,
                             source: a.source,
                             /* PASSED THROUGH, NOT COERCED. This used to read
                              * `a.mode === "pose" ? "pose" : "camera"`, which
                              * turns any mode this schema does not list into a
                              * 32-MINUTE RENDER rather than into a refusal —
                              * and `check` is a mode mv_control_catalogue tells
                              * the agent about. The route already refuses an
                              * unknown mode naming the four; a silent fallback
                              * to the most expensive one is the wrong default
                              * by a factor of two thousand. */
                             mode: a.mode || "camera",
                             segmentId: a.segment, reference: a.reference,
                             prompt: a.prompt, negative: a.negative,
                             seed: a.seed, strength: a.strength, model: a.depth_model });
        return { mode: r.mode, source_kind: r.source, source: r.clip,
                 source_measured: r.validation, blockout: r.blockout,
                 pose: r.pose, depth: r.depth, render: r.render, operating_point: r.operatingPoint };
      },
    },
    {
      name: "mv_pose_extract",
      description:
        "TURN A CLIP OF A PERSON INTO THE SKELETON THAT WILL STEER ONE. DWPose over 121 frames, "
        + "measured at 26.4 s — half a minute against the half hour mv_control_render costs — and "
        + "the skeleton it writes is itself a valid control clip, adopted into the clips library. "
        + "So the cheap loop is: extract, LOOK AT IT, then pass it to mv_control_render as "
        + "`clip`.\n\n"
        + "SAME CLIP CONTRACT, SAME SILENT FAILURES. The source must be EXACTLY 1280x704, EXACTLY "
        + "24.000 fps and AT LEAST 121 FRAMES. Wrong size is centre-cropped without a word; a "
        + "short clip is clamped and the deficit padded with flat mid-gray; the frame rate is "
        + "never read, so a 30 fps source is silently retimed. Measured and refused by number "
        + "before anything is staged.\n\n"
        + "THE GATE PASSED, AND HERE IS EXACTLY WHAT IT MEASURED. One render, 2026-09-03: the "
        + "output's joints land 33.7 px from the control's (0.0365 of the frame) with a mean "
        + "per-joint correlation of 0.893, against a time-reversed null of 157.3 px / -0.020 and "
        + "a frozen-skeleton null of 119.9 px. 33.7 against 119.9 is the render following the "
        + "skeleton rather than merely sharing a human body layout.\n\n"
        + "⚠ FOUR CAVEATS, AND THEY ARE THE HALF THAT GETS DROPPED FROM A SUMMARY.\n"
        + "  1. DWPOSE CANNOT SEE THE RENDER. No figure was found in 43 of the 121 output frames "
        + "— every one a flat-shaded anime close-up with an obvious person in it, and none in "
        + "the anime character sheet either. yolox is trained on photographs. The score is the "
        + "78 frames where the instrument could see both sides, and the 43 it could not are the "
        + "CLOSEST ones, so the hardest part of the shot is unscored.\n"
        + "  2. THE SOURCE WAS NOT A DANCE. It is a man at a console with the camera pushing in "
        + "2.71x. Legs never appear; hips are detected on 14 frames of 121, wrists on 10 and 41. "
        + "So this measures an upper-body performance under a large scale ramp and says NOTHING "
        + "about a full-body dance. Do not schedule one on the strength of it.\n"
        + "  3. THE HANDS ARE NOT FOLLOWED: l_wrist is 149.9 px at r 0.50/0.45, five times the "
        + "overall error. Raised fists in that render came from the PROMPT, not the skeleton.\n"
        + "  4. ONE RENDER, ONE SEED, ONE SOURCE, ONE REFERENCE. The camera gate ran ten arms "
        + "with a strength ladder; this is a single point, and no pose arm has been run at "
        + "strength 0.50 or 2.00.\n\n"
        + "LICENCE — THIS TOOL IS THE UNSETTLED HALF. The WAN weights that render the clip are "
        + "verified Apache-2.0, but the DWPose ESTIMATOR that draws these skeletons has no "
        + "readable terms at all: its redistributor ships a 28-byte model card and no LICENSE "
        + "file, and the licence usually cited for it is reached only by a filename match. The "
        + "catalogue row says outputRights class \"unknown\", sellable null, and this tool will "
        + "not pretend otherwise. In practice a skeleton is a measurement of a video you "
        + "supplied and the clip it steers carries WAN's settled terms — read the chain before "
        + "relying on more than that.",
      inputSchema: {
        type: "object", required: ["slug", "clip"],
        properties: {
          slug: { type: "string" },
          clip: { type: "string", description: "A video NAME from the clips library, at exactly 1280x704, exactly 24.000 fps and at least 121 frames." },
          segment: { type: "string", description: "Segment id or index, to file the skeleton against a scene. Optional." },
        }, additionalProperties: false,
      },
      async run(a) {
        const r = await mv({ action: "control_render", slug: a.slug, clip: a.clip,
                             mode: "extract", segmentId: a.segment });
        return { source: r.clip, source_measured: r.validation, skeleton: r.pose,
                 next: "pass skeleton.file to mv_control_render as `clip` — a skeleton passes the same gate" };
      },
    },
    {
      name: "mv_depth_extract",
      description:
        "TURN A CLIP INTO THE DEPTH VIDEO THAT WILL STEER ONE. Depth Anything V2 over 121 frames "
        + "— a per-frame forward pass, seconds rather than the half hour mv_control_render costs "
        + "— and the depth video it writes is itself a valid control clip, adopted into the clips "
        + "library. So the cheap loop is: extract, LOOK AT IT, then pass it to mv_control_render "
        + "as `clip` (mode camera) or run mode \"depth\" directly.\n\n"
        + "SAME CLIP CONTRACT, SAME SILENT FAILURES: exactly 1280x704, exactly 24.000 fps, at "
        + "least 121 frames, measured and refused by number before anything is staged. An "
        + "off-contract source goes through mv_control_conform first.\n\n"
        + "LICENCE, PER MODEL. depth_model \"small\" (default) is Apache-2.0 by the authors' own "
        + "statement and keeps a clip sellable; \"large\" is CC-BY-NC-4.0 — finer edges, "
        + "NON-COMMERCIAL, and the record says which one was used. ⚠ UNSCORED: no depth arm has "
        + "been measured against a null; what a depth control does to a VACE render here is "
        + "watched, not measured.",
      inputSchema: {
        type: "object", required: ["slug", "clip"],
        properties: {
          slug: { type: "string" },
          clip: { type: "string", description: "A video NAME from the clips library, at exactly 1280x704, exactly 24.000 fps and at least 121 frames." },
          depth_model: { type: "string", enum: ["small", "large"], description: "small (default, Apache-2.0) or large (CC-BY-NC-4.0, non-commercial)." },
          segment: { type: "string", description: "Segment id or index, to file the depth video against a scene. Optional." },
        }, additionalProperties: false,
      },
      async run(a) {
        const r = await mv({ action: "control_render", slug: a.slug, clip: a.clip,
                             mode: "extract_depth", model: a.depth_model, segmentId: a.segment });
        return { source: r.clip, source_measured: r.validation, depth: r.depth,
                 next: "pass depth.file to mv_control_render as `clip` (mode camera), or run mode \"depth\" on the source — a depth video passes the same gate" };
      },
    },
    {
      name: "mv_control_conform",
      description:
        "FIT ANY VIDEO TO THE CONTROL CONTRACT — free, CPU only, ffmpeg. The gate refuses a 720p "
        + "or 30 fps clip by number; this is the tool that makes the numbers right: scaled to "
        + "COVER 1280x704 (never letterboxed — the model would paint the bars) and centre-cropped, "
        + "retimed to exactly 24.000 fps, sound dropped (a control clip is frames), written to the "
        + "clips library as a NEW clip whose name says what it is, and measured by the same gate "
        + "before it is reported. The original is untouched. A 1280x720 source loses 8 rows top "
        + "and bottom; a 16:9 source at any size keeps its framing.\n\n"
        + "EXACTLY 121 FRAMES (5.04 s) are written, from `start` seconds in — the render uses no "
        + "more, and every graph on this path decodes the whole clip before taking its 121, so a "
        + "46-second conform would sit the GPU idle for minutes. Choose the five seconds with "
        + "`start`. REFUSED, by sentence, when the window runs off the end: conforming cannot "
        + "invent frames. Already-legal clips with start 0 come back with a note and no new file.",
      inputSchema: {
        type: "object", required: ["slug", "clip"],
        properties: {
          slug: { type: "string" },
          clip: { type: "string", description: "A video NAME from the clips library, any size, any frame rate, at least 5.04 s from `start`." },
          start: { type: "number", minimum: 0, description: "The second of the source the 121-frame window starts at. Default 0." },
          segment: { type: "string", description: "Segment id or index. Optional." },
        }, additionalProperties: false,
      },
      async run(a) {
        const r = await mv({ action: "control_render", slug: a.slug, clip: a.clip,
                             mode: "conform", start: a.start, segmentId: a.segment });
        return { source: r.clip, source_measured: r.validation, conformed: r.conformed, note: r.note ?? null,
                 next: r.conformed ? "pass conformed.file to mv_control_check, then mv_control_render or mv_depth_extract" : "the clip already passes — steer with it as it is" };
      },
    },
    {
      name: "mv_control_check",
      description:
        "IS THIS CLIP LEGAL TO STEER WITH? Free, instant, no GPU — ffprobe measures the file and "
        + "says so. Run it before mv_control_render every single time.\n\n"
        + "A control clip must be EXACTLY 1280x704, EXACTLY 24.000 fps and AT LEAST 121 frames, "
        + "and all three fail SILENTLY: the wrong size is bilinear-resampled and CENTRE-CROPPED, "
        + "a short clip is clamped and then padded with flat mid-gray so the end of the shot "
        + "conditions on nothing, and nothing in the path reads fps at all so a 30 fps source is "
        + "retimed. Each one finishes, reports success, and hands back a shot that is not the one "
        + "you asked for — after the 32 minutes are spent. A minute of GPU was already lost here "
        + "to a 96-frame clip once.\n\n"
        + "This is the SAME code path mv_control_render runs, stopped before it stages a byte, so "
        + "the answer here and the refusal there cannot disagree. It returns `ok`, the three "
        + "measured numbers, and — when it fails — `why`: which number is wrong, what it has to "
        + "be, and which line of the engine silently does the wrong thing with it. The human card "
        + "has this as its Check button and keeps the expensive one disabled until it passes; "
        + "this is the same door.",
      inputSchema: {
        type: "object", required: ["slug"],
        properties: {
          slug: { type: "string" },
          source: { type: "string", enum: ["clip", "blockout"], description: "\"clip\" (default) measures `clip` from the clips library. \"blockout\" measures THIS SHOT'S own blockout instead — give `segment` and leave `clip` out. Same measurement either way, and it is the same code path mv_control_render runs." },
          clip: { type: "string", description: "Required when source is \"clip\". A video NAME from the clips library — the clip you are about to steer with, or a skeleton from mv_pose_extract." },
          segment: { type: "string", description: "Segment id or index. With source \"blockout\" it says WHICH shot's blockout to measure; with source \"clip\" it changes nothing about the measurement." },
        }, additionalProperties: false,
      },
      async run(a) {
        const r = await mv({ action: "control_render", slug: a.slug, clip: a.clip,
                             source: a.source,
                             mode: "check", segmentId: a.segment });
        return { ok: r.ok, source_kind: r.source, source: r.clip,
                 measured: r.validation, blockout: r.blockout, why: r.why,
                 next: r.ok
                   ? "legal — pass this name to mv_control_render as `clip`"
                   : "fix the clip to 1280x704 / 24.000 fps / >=121 frames, or pick another" };
      },
    },
    {
      name: "mv_control_catalogue",
      description:
        "WHAT STRUCTURAL CONTROL COSTS AND WHAT IT IS ALLOWED TO CLAIM — read this before "
        + "mv_control_render. Free, instant, no GPU. Returns the clip contract (the three "
        + "numbers), the measured strength ladder with 1.00 marked as the shipped default, the "
        + "operating point arm W1 passed at, the ~32-minute cost, the pose gate's numbers WITH "
        + "its four caveats, and BOTH licence answers separately — WAN's, which is verified "
        + "Apache-2.0 and lets you sell the clip, and the DWPose estimator's, which is "
        + "\"unknown\" and governs only the pose modes. One settled claim must never stand for "
        + "the whole path, which is why they come back as two.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async run() { return api("GET", "/api/mv/control"); },
    },

    {
      name: "mv_pick_take",
      description: "Choose which take a character/background/board/clip uses. Picking a new face marks every board that depends on it stale, so you can see what to redraw. target \"clip\" switches which take of a SCENE plays — a generated take, a regen, or a vfx-polished import — and mv_build_timeline follows the pick; id is the clip id, its segment id, or the scene index.",
      inputSchema: {
        type: "object", required: ["slug", "target", "id", "file"],
        properties: {
          slug: { type: "string" }, target: { type: "string", enum: ["character", "background", "prop", "board", "clip"] },
          id: { type: "string" }, file: { type: "string" },
        }, additionalProperties: false,
      },
      async run(a) { await mv({ action: "pick_take", slug: a.slug, kind: a.target, id: a.id, file: a.file }); return { ok: true }; },
    },
    {
      name: "mv_generate_clip",
      description: "Render one scene's clip. Its ticked cast rides as H3 named references (\"<Picture N> is Name.\") at the reference build's own step count. The song goes under the clip where the brief's Song under the clip is \"always\" (new projects) or the board sings (lipSync), so a singing mouth follows the words; the clip's own audio is dropped and the song is laid in the cut. mv_shot says before you spend whether the song is under this scene. Blocks 2-7 min. Calling again on the same scene is a REGENERATE — a new seed, the old take kept.",
      inputSchema: {
        type: "object", required: ["slug", "segment"],
        properties: {
          slug: { type: "string" },
          segment: { type: "string", description: "Segment id (or index) from mv_segment." },
          seed: { type: "integer" },
        }, additionalProperties: false,
      },
      async run(a) {
        const r = await mv({ action: "generate_clip", slug: a.slug, segmentId: a.segment, seed: a.seed });
        return { clip: r.clip, takes: (r.takes || []).map((t) => ({ clip: t.clip, seed: t.seed })),
                 /* The evidence comes back WITH the render, so an agent never
                  * needs a second call to find out what it just bought — and in
                  * particular finds out here if a named reference reached the
                  * render as nothing. */
                 engine: r.shot?.engine, refs: r.shot?.refs?.map((x) => x.name),
                 refsMissing: r.shot?.refsMissing?.map((x) => x.name) };
      },
    },

    /* ─────────────── ONE SHOT: look at it, change it, redo it ──────────────
     *
     * The agent half of the shot inspector, and it exists for the failure
     * DIRECTING.md keeps describing in different words: the board looked
     * correct and the render got something else. Everything that decides a clip
     * used to be computed inside the renderer and thrown away, so "why did
     * scene 9 come out like that" had no answer anywhere — not for a person and
     * not for an agent. These three are the same three controls the Workflow
     * tab's inspector shows, over the same routes.
     */
    {
      name: "mv_shot",
      description:
        "READ ONE SHOT — the whole record of what a scene will be given, or was given. FREE and "
        + "instant, so call it BEFORE mv_generate_clip rather than after: an H3 render costs up to "
        + "28 minutes and this costs nothing. Returns the EXACT prompt text that will be sent (not "
        + "a summary), which reference sheets resolved and to which file, in the order they are "
        + "handed to the model, and which named references resolved to NOTHING — a declared "
        + "character, location or prop with no rendered sheet reaches the render as nothing and "
        + "warns nowhere else, which is the most common reason a clip ignores its board. Also the "
        + "engine that choice implies, and every take with the prompt and references that made "
        + "THAT take rather than the row's latest. `drift` says what has changed under the take "
        + "currently playing: a re-picked face, an added or removed reference, an edited prompt. "
        + "And whether the song is under this clip (`songLine`, `songUnder`) and its step count "
        + "(`steps`, with `stepsNote` when cast pictures raised the brief's count).",
      inputSchema: {
        type: "object", required: ["slug", "segment"],
        properties: {
          slug: { type: "string" },
          segment: { type: "string", description: "Segment id, or the 0-based scene index." },
        }, additionalProperties: false,
      },
      async run(a) {
        const r = await mv({ action: "shot", slug: a.slug, segmentId: a.segment });
        return { shot: r.shot, declared: r.declared };
      },
    },
    {
      name: "mv_set_shot",
      description:
        "EDIT ONE SHOT and write nothing else. Three independent edits, any combination. `prompt` "
        + "replaces the generated prompt with a hand-written one for this scene only — send an "
        + "empty string to drop the override and go back to the builder. `refs` sets which declared "
        + "names this shot carries, sorted into characters / backgrounds / props automatically; an "
        + "undeclared name is REFUSED rather than silently dropped. `prominence` decides which "
        + "references survive when a scene names more than the engine's nine. MERGES into the "
        + "board where mv_set_board replaces it, so changing refs here cannot erase the shot list. "
        + "Renders NOTHING — call mv_regen_clip after. Returns the updated shot record, so the new "
        + "prompt and the drift this edit just created come back without a second call.",
      inputSchema: {
        type: "object", required: ["slug", "segment"],
        properties: {
          slug: { type: "string" },
          segment: { type: "string", description: "Segment id, or the 0-based scene index." },
          prompt: { type: "string", description: "The exact text to send instead of the built prompt; \"\" reverts to the builder. START FROM mv_shot's `prompt` — written from scratch it loses the <Picture N> legend, and a reference the prompt never names barely conditions the render at all." },
          refs: { type: "array", items: { type: "string" }, description: "Declared names this shot references. Replaces the current set." },
          prominence: { type: "object", description: "{name: 0..1} — which references survive the nine-picture cap.", additionalProperties: { type: "number" } },
        }, additionalProperties: false,
      },
      async run(a) {
        /* An omitted `prompt` is undefined and the route leaves the stored
         * prompt alone; an EMPTY STRING is the revert. Nothing here has to be
         * assembled conditionally, because the route tests the type rather
         * than the key's presence. */
        const r = await mv({ action: "set_shot", slug: a.slug, segmentId: a.segment,
                             prompt: a.prompt, refs: a.refs, prominence: a.prominence });
        return { changed: r.changed, shot: r.shot };
      },
    },
    {
      name: "mv_regen_clip",
      description:
        "RE-RENDER ONE SHOT, every earlier take kept. Same path as mv_generate_clip — same segment, "
        + "same cast, same soundtrack window — with three knobs the plain call has not got. "
        + "`prompt` renders this take with different text WITHOUT storing it on the project: trying "
        + "a wording is not adopting it, and mv_set_shot is how you adopt one. `seed` HOLDS the "
        + "seed, which is the only way to see what a prompt change actually did — omit it and a "
        + "fresh seed is rolled, which is the plain re-roll. `loop` false renders unpinned: ~3x the "
        + "motion of a pinned clip, against identity drift in 1 of 3 on a small sample. Address the "
        + "shot by `segment`, or by `clip_id` — the handle a Studio timeline item carries. BLOCKS "
        + "2-28 minutes depending on engine, so read mv_shot first.\n\n"
        + "`prompt_source` SAYS WHICH OF THE THREE PROMPTS to render, instead of leaving it to be "
        + "inferred from whether `prompt` happens to be in the call. There are always three — the "
        + "builder's, the one stored on the scene by hand (mv_set_shot), and one supplied for this "
        + "render alone — and the inference is what let one surface hold the seed while the other "
        + "used the adopted text, so nobody could have both. \"argument\" renders `prompt` and "
        + "stores nothing; \"edited\" renders the scene's stored prompt; \"built\" renders the "
        + "builder's, ignoring a stored override for this take only. Omit it and nothing changes.",
      inputSchema: {
        type: "object", required: ["slug"],
        properties: {
          slug: { type: "string" },
          segment: { type: "string", description: "Segment id, or the 0-based scene index." },
          clip_id: { type: "string", description: "Clip id instead of a segment — what a Studio timeline item knows about itself." },
          prompt: { type: "string", description: "Render this take with this text, without storing it on the project." },
          prompt_source: {
            type: "string", enum: ["built", "edited", "argument"],
            description: "Which prompt to render: \"argument\" (the `prompt` sent here), \"edited\" (the scene's stored hand-written one), \"built\" (the builder's, ignoring a stored override for this render). Omit for the old behaviour — a `prompt` given is used, otherwise the stored one wins.",
          },
          seed: { type: "integer", description: "Hold the seed so a prompt change is the only variable. Omitted = fresh roll." },
          loop: { type: "boolean", description: "false renders without closing on the opening frame — more motion, less identity protection." },
        }, additionalProperties: false,
      },
      async run(a) {
        if (!a.segment && !a.clip_id) throw new Error("Name the shot: pass segment or clip_id.");
        /* Both bodies carry both handles. regen_clip resolves either one, so the
         * only thing the branch decides is which door a caller who gave ONLY a
         * clip id goes through — and that door is the one a Studio timeline item
         * uses, which is why it still exists. */
        const r = a.segment
          ? await mv({ action: "regen_clip", slug: a.slug, segmentId: a.segment, clipId: a.clip_id,
                       prompt: a.prompt, promptSource: a.prompt_source, seed: a.seed, loop: a.loop })
          : await mv({ action: "regen_by_clip_id", slug: a.slug, clipId: a.clip_id,
                       prompt: a.prompt, promptSource: a.prompt_source, seed: a.seed, loop: a.loop });
        const s = r.shot;
        return { clip: r.clip, takes: (r.takes || []).length,
                 seed: s?.current?.seed, engine: s?.engine, promptSource: s?.promptSource,
                 refs: s?.refs?.map((x) => x.name), refsMissing: s?.refsMissing?.map((x) => x.name) };
      },
    },
    {
      name: "mv_crime_board",
      description:
        "The relationship map, and the project's CONTINUITY BREAKS. Every artefact is a node in "
        + "a lane (characters, props, backgrounds, boards, clips), every dependency an edge "
        + "weighted by refProminence. Read it before spending GPU: it says which clips a "
        + "re-picked face invalidates, and it is the same page a human sees.\n\n"
        + "`breaks[]` is the part to act on. Each carries {level, kind, where, msg, nodes}, "
        + "errors first, and every one is DERIVED — fix the cause and it disappears, there is "
        + "nothing to clear. The kinds:\n"
        + "  undeclared     a board references a name no character/background/prop declares. The "
        + "render drops it silently. Fix with mv_add_asset, or correct the board.\n"
        + "  noSheet        a reference resolves to a real row that has no rendered sheet, so the "
        + "render gets NOTHING for it and re-invents it from the words. This is the failure that "
        + "produces a different car in every shot. Fix with mv_generate_asset or mv_blender_sheet.\n"
        + "  undeclaredRecurring  an object recurs across scenes and no prop declares it at all — "
        + "the same failure one step earlier, before anybody wrote it down. It is drawn as a ghost "
        + "node in the prop lane. Fix with mv_add_asset, then list it in propRefs.\n"
        + "  namedNotReferenced   the OTHER half of that same scan, and the commoner one: a "
        + "board's own words name a row you have ALREADY declared and rendered, and its refs do "
        + "not carry it - so the sheet exists and the render is never shown it. Fix with "
        + "mv_set_shot, which attaches the name; nothing has to be declared or drawn again.\n"
        + "  overCap        a reference resolves and is then thrown away because the shot names "
        + "more than the engine's nine pictures; the least prominent go first.\n"
        + "  renderedWithout  the clip ON DISK was rendered without a reference it names. Unlike "
        + "the others this cannot be fixed by rendering a sheet — the finished file does not "
        + "contain it, so the clip has to be re-rendered.\n"
        + "  neverUsed      declared and referenced by no board. Either it belongs in that board's "
        + "refs or it is not cast.\n"
        + "  builtOnOld / changed   a board drawn, or a clip rendered, before its inputs changed.\n"
        + "  noBoard / noShots      a scene with nothing steering it.\n\n"
        + "mv_lint reports the same findings as a flat list; this returns them attached to the "
        + "graph, so `nodes` tells you exactly which rows and scenes each one is about.",
      inputSchema: { type: "object", required: ["slug"], properties: { slug: { type: "string" } }, additionalProperties: false },
      async run(a) { return mv({ action: "crime_board", slug: a.slug }); },
    },
    {
      name: "mv_build_timeline",
      description: "Move the finished scenes to Studio: a REAL timeline project, every clip at its scene's exact start trimmed to the scene length, the song on the audio track. Items carry the workflow linkage, so a right-click in Studio can regenerate any scene. Rebuilding overwrites the composed project with current picks.",
      inputSchema: { type: "object", required: ["slug"], properties: { slug: { type: "string" } }, additionalProperties: false },
      async run(a) { const r = await mv({ action: "build_timeline", slug: a.slug }); return { project: r.project, scenes: r.scenes }; },
    },
    {
      name: "mv_render_video",
      description:
        "Render the built timeline to a FINISHED FILE, offline. Needs mv_build_timeline "
        + "first, and ffmpeg on the machine. "
        + "This is NOT Studio's Export button, and the difference matters: Export captures "
        + "the canvas with MediaRecorder in REAL TIME, so a 148-second video costs 148 "
        + "seconds, and measured on this rig the draw path sustains 17 fps against a "
        + "requested 24 — every export judders. This composes from the source clips instead, "
        + "at exactly the timeline's fps, in about 4 seconds per 44 seconds of video. "
        + "`fade` cross-dissolves each cut, in seconds; 0 (the default) is a hard cut. A "
        + "dissolve is only honest because clips overshoot their slots, so the outgoing shot "
        + "has real frames to hold under the incoming one — keep it under ~0.3s or it eats "
        + "the shot. Gaps under 0.6s are bridged by holding the last frame; longer ones stay "
        + "black, because a two-second freeze would hide missing footage as a directing choice.",
      inputSchema: {
        type: "object", required: ["slug"],
        properties: {
          slug: { type: "string" },
          fade: { type: "number", description: "Cross-dissolve seconds per cut. 0 = hard cut. Max 2." },
          /* ELEVEN LINES OF ROUTE COMMENT AND NO CALLER ON EITHER SIDE. The
           * confidence gate the route describes has never been openable. */
          beat_zoom: { type: "number", description: "Pulse the picture on the beat: the fraction of the frame each beat zooms, 0 to 0.08. 0 (the default) is no pulse. IGNORED, with the reason in the reply, when the song's measured beat confidence is under 0.40 - pulsing on a grid that weak reads as an encode fault rather than as an edit. The tempo comes from the project's own analysis, never from you." },
        }, additionalProperties: false,
      },
      async run(a) {
        const r = await mv({ action: "render_video", slug: a.slug, fade: a.fade, beatZoom: a.beat_zoom });
        return { clip: r.name, seconds: r.total, width: r.w, height: r.h, fps: r.fps,
                 scenes: r.clips, encoder: r.encoder, bytes: r.bytes };
      },
    },
    {
      name: "mv_read_timeline",
      description: "Read a human's edits BACK out of Studio — the other half of mv_build_timeline. Returns an EDL: per item its scene, mvClipId, source file, start/duration/in-point in SECONDS, which take it is (n of N, with the seed), and what CHANGED versus the cut mv_build_timeline would compose right now — moved, trimmed, in-point, reordered, replaced by another take, relinked to a file that is not a take, split in two, removed, or foreign (an item the workflow never made). `notes` says all of it in one line each. Read-only: nothing renders, nothing is written. Sees only what was SAVED, and cannot judge track levels, fx, fades or transitions.",
      inputSchema: {
        type: "object", required: ["slug"],
        properties: {
          slug: { type: "string" },
          project: { type: "string", description: "A specific Studio project NAME. Default: the one this workflow recorded, else any project stamped with this slug." },
          full: { type: "boolean", description: "Return the whole EDL. Default false — just the summary, the changed items and the notes." },
        }, additionalProperties: false,
      },
      async run(a) {
        const r = await mv({ action: "read_timeline", slug: a.slug, project: a.project });
        const base = {
          project: r.project, saved_at: r.savedAtIso, matched_by: r.matchedBy,
          in_sync: r.inSync, summary: r.summary, notes: r.notes,
          missing: r.missing, audio: r.audio.filter((x) => x.changes.length),
        };
        return a.full ? { ...base, edl: r.edl } : { ...base, changed: r.edl.filter((e) => e.status !== "unchanged") };
      },
    },
    {
      name: "mv_regen_stale",
      description: "Heal drift: find every clip whose take predates its board, its cast or the current prompt builder, and re-render them one at a time through the same path as mv_generate_clip — same segment, same cast, same soundtrack window, a fresh seed, earlier takes KEPT. Reasons come from what the store already records: board (clip marked stale by a bible commit), segments (re-cut underneath it), board-refs / refs (a sheet was re-picked after the render), board-newer (the board was authored after it), unnamed-refs (rendered with reference sheets its prompt never named — the defect that makes every scene invent a different performer). DRY RUN BY DEFAULT: it reports what it would do and spends nothing until dry_run is explicitly false. A real run costs GPU MINUTES PER CLIP and blocks; one failure is recorded and stepped over, never aborting the rest.",
      inputSchema: {
        type: "object", required: ["slug"],
        properties: {
          slug: { type: "string" },
          dry_run: { type: "boolean", description: "Default TRUE. Set false to actually render." },
          limit: { type: "integer", description: "Regenerate at most this many, in scene order. Default: all of them." },
          segments: { type: "array", items: { type: "string" }, description: "Restrict to these segment ids, clip ids, or 0-based segment indices — the same three mv_generate_clip takes." },
        }, additionalProperties: false,
      },
      async run(a) {
        const dry = a.dry_run !== false;
        /* A sweep is minutes per clip, and the shared api() helper's socket
         * timeout would abandon a run that is going perfectly well — so a real
         * sweep gets a deadline sized to the work, not to the default. */
        const body = { action: "regen_stale", slug: a.slug, dryRun: dry, limit: a.limit, segmentIds: a.segments };
        const r = dry ? await mv(body)
          : await (async () => {
              const out = await api("POST", "/api/mv", body, 12 * 60 * 60e3);
              if (out.error) throw new Error(out.error);
              return out;
            })();
        return {
          dry_run: r.dryRun, stale: r.stale, blocked: r.blocked, selected: r.selected,
          would: r.would, estimate: r.estimate, note: r.note,
          regenerated: r.regenerated, failed: r.failed, elapsed_sec: r.elapsedSec,
          clips: r.clips.map((c) => ({
            scene: c.scene, clip_id: c.clipId, segment: c.segmentId, reasons: c.reasons,
            detail: c.detail, selected: c.selected,
            old_take: c.oldTake ? `${c.oldTake.n}/${c.oldTake.of} ${c.oldTake.clip}${c.oldTake.seed != null ? ` (seed ${c.oldTake.seed})` : ""}` : null,
            new_take: c.newTake ? `${c.newTake.n}/${c.newTake.of} ${c.newTake.clip}` : null,
            seed: c.seed, error: c.error,
          })),
        };
      },
    },
    /* ══════════════════════════ THE PLAN OBJECT ═══════════════════════════
     *
     * Five tools over seven routes. They exist because of one sentence:
     *
     *   "people value high quality more then speed but it still needs to be
     *    asking you directive choices when you do run through MCP and we should
     *    have it able to setup things for you and you can go through it approve
     *    it change things and then start."
     *
     * Four verbs — set up, go through, approve or change, start — and NOTHING
     * spends a GPU until the last one. Every item is a real tool call from the
     * list you are already reading: the runner resolves the name in this very
     * table and calls it, so a plan can never reach a capability you have not
     * got and can never invent an argument a tool would refuse. */

    {
      name: "mv_plan_propose",
      description: "SET UP A RUN AND HAND IT OVER BEFORE SPENDING ANYTHING. A plan is a list of calls you intend to make — which scenes, on which engine, at which size, with which references — that a human reads, edits, approves item by item, and only then starts. Nothing renders when you propose. Nothing renders when they approve. The GPU is spent by mv_plan_run, and only on items marked approved.\n\nWHEN TO PLAN, AND WHEN TO JUST ACT. Plan when one intent spends more than one expensive call: rendering a set of scenes, healing everything stale, re-rendering after a re-picked face. Do NOT plan a single test render, a sheet, a board, or anything free — a plan for a two-second test is friction, and it teaches the human to rubber-stamp, which is worth less than nothing. The rule of thumb: if you are about to loop, propose a plan instead.\n\nEACH ITEM IS A REAL TOOL CALL — `tool` is the name of a tool you can already call and `args` are that tool's own arguments. There is no second execution path: the runner calls the tool. A tool name that does not exist is refused here, for free, rather than three hours in.\n\n`from` seeds the items out of what the project already knows: \"stale\" (every clip whose take predates its board or its cast — the same scan mv_regen_stale reports), \"unrendered\" (every generate-mode scene with no take), \"nosheet\" (every declared character, background or prop with no rendered sheet). Seed it, then edit it — that is cheaper and more accurate than writing twenty items by hand.\n\nRead mv_shot first for any scene you are unsure of; it is free and it says which references would reach the render as nothing. The plan reports the same finding per item, so you can also just propose and read the warnings back. Refused if a plan is already open on this project: approve it, run it, or discard it first.",
      inputSchema: {
        type: "object", required: ["slug", "title", "intent"],
        properties: {
          slug: { type: "string" },
          title: { type: "string", description: "One line a person can read in the rail. \"Render the 14 unrendered scenes at H3 1920x1088\"." },
          intent: { type: "string", description: "YOUR OWN SENTENCE about why this run. It is the one field nobody can write for you, and it is what the person approving actually reads. Never left blank." },
          from: { type: "string", enum: ["stale", "unrendered", "nosheet"], description: "Seed the items from the project's own scanners instead of writing them by hand. Ignored when `items` is non-empty." },
          items: {
            type: "array",
            description: "The calls, in the order they should run. An empty plan is legal — the page's + Add to plan fills it.",
            items: {
              type: "object", required: ["tool"],
              properties: {
                tool: { type: "string", description: "An EXISTING mv_* tool name. Anything else is refused here, at zero cost." },
                args: { type: "object", description: "That tool's own arguments, spelled exactly as its inputSchema spells them." },
                why: { type: "string", description: "One sentence, yours. \"scene 9 has a board and no take\"." },
              },
            },
          },
        }, additionalProperties: false,
      },
      async run(a) {
        const r = await mv({
          action: "plan_propose", slug: safeName(a.slug, "project"),
          title: a.title, intent: a.intent, from: a.from, items: a.items,
        });
        return planOut(r);
      },
    },
    {
      name: "mv_plan_read",
      description: "The plan as it stands, with FRESH estimates: per item the engine that choice implies, the size it will actually render at, the minutes it should take, and every continuity break that scene carries. Nothing here is stored — change the brief and this answer changes, which is why it cannot disagree with what the renderer does. `totals` gives the approved count, the total minutes, the wall-clock time it would finish at, and how many items could not be priced (an unpriced item is reported as unpriced, never folded into the number). Poll this while a run is walking. `plan_id` omitted reads the live plan; pass one to read an archived plan.",
      inputSchema: {
        type: "object", required: ["slug"],
        properties: {
          slug: { type: "string" },
          plan_id: { type: "string", description: "Omit for the live plan. `plans` in every reply lists the archived ones." },
        }, additionalProperties: false,
      },
      async run(a) {
        const r = await mv({ action: "plan_read", slug: safeName(a.slug, "project"), planId: a.plan_id });
        return planOut(r);
      },
    },
    {
      name: "mv_plan_edit",
      description: "Change the plan before it runs. op \"edit\" MERGES `args` into one item — the prompt, the seed, the engine, whatever that tool takes (send null for a key to delete it); op \"add\" appends one, or inserts it at `at`; op \"remove\" deletes one; op \"discard\" throws the whole plan away.\n\nEDITING AN APPROVED ITEM DROPS IT BACK TO `edited` AND IT MUST BE APPROVED AGAIN. That is deliberate: an approval is of a specific set of arguments, and carrying it across a change would make approval mean nothing. `changed` in the response says which items fell back. An item that is running or already done cannot be edited at all — a render in flight or a finished one is evidence.",
      inputSchema: {
        type: "object", required: ["slug", "op"],
        properties: {
          slug: { type: "string" },
          plan_id: { type: "string", description: "Omit for the live plan." },
          op: { type: "string", enum: ["add", "edit", "remove", "discard"] },
          item_id: { type: "string", description: "Which item — \"i3\". Required by edit and remove. Ids are stable and never reused." },
          tool: { type: "string", description: "add: the tool this item calls. edit: change which tool it calls." },
          args: { type: "object", description: "That tool's own arguments. On edit these MERGE into what is there; a key set to null is deleted." },
          why: { type: "string", description: "The one-sentence reason on this item." },
          at: { type: "integer", description: "add only: 0-based position to insert at. Omitted, it appends — and the runner walks array order." },
        }, additionalProperties: false,
      },
      async run(a) {
        if (a.op === "discard") {
          const d = await mv({ action: "plan_discard", slug: safeName(a.slug, "project"), planId: a.plan_id });
          return { discarded: d.discarded, title: d.title, items: d.items, plans: d.plans };
        }
        const r = await mv({
          action: "plan_item", slug: safeName(a.slug, "project"), planId: a.plan_id,
          op: a.op, itemId: a.item_id, tool: a.tool, args: a.args, why: a.why, at: a.at,
        });
        return planOut(r);
      },
    },
    {
      name: "mv_plan_decide",
      description: "APPROVE, SKIP, OR SET THE POLICY. op \"approve\" marks items ready to run; op \"skip\" takes them out of this run without deleting them; op \"unapprove\" puts one back to proposed. `items` takes a list of ids or \"all\". Partial approval is the normal case — approve the eight you are sure of, skip the four you are not.\n\nAn item whose scene carries a REFERENCE WITH NO RENDERED SHEET cannot be approved without acknowledge:true. That reference reaches the render as nothing; the response names it. It is not a block — sometimes you mean it — but it will not happen by accident.\n\nop \"policy\" sets on_failure (\"halt\", the default, stops the run and keeps the rest approved so a resume continues; \"continue\" steps over and carries on) and auto_approve_under_minutes — which is a DELEGATION, so it requires delegate_brief: the human's goals in their own words, recorded verbatim. Every item the machine then approves is logged as a `judge` under that brief, never as the human's own choice.\n\nWhat this writes to the ledger is what you are: a decision arriving over MCP records the agent, never the user. The human's contribution is recorded where it actually happened.",
      inputSchema: {
        type: "object", required: ["slug", "op"],
        properties: {
          slug: { type: "string" },
          plan_id: { type: "string", description: "Omit for the live plan." },
          op: { type: "string", enum: ["approve", "skip", "unapprove", "policy"] },
          items: { type: "array", items: { type: "string" }, description: "Which items — [\"i1\",\"i3\"]. OMITTED MEANS ALL OF THEM, which is the whole-plan approve. Each id is answered separately, so a clean item beside a warned one is still decided." },
          acknowledge: { type: "boolean", description: "Approve an item anyway despite a warning that will not happen by accident — a named reference with no rendered sheet, or an error-level continuity break. The refusal names them first." },
          reasoning: { type: "string", description: "Why you decided this way. Recorded on the `choice` event, verbatim." },
          free_text: { type: "string", description: "Anything the decider wanted to say that is not one of the options. Recorded verbatim." },
          on_failure: { type: "string", enum: ["halt", "continue"], description: "policy only. halt (default): the run stops and everything still approved STAYS approved — press Run again. continue: the failure is recorded and stepped over." },
          auto_approve_under_minutes: { type: "number", description: "policy only. A DELEGATION: items estimated under this many minutes are approved by the machine. Requires delegate_brief. null clears it. Never applied to an item nothing could price, or to one carrying a warning a human would have had to acknowledge." },
          delegate_brief: { type: "string", description: "policy only, REQUIRED with auto_approve_under_minutes. The human's goals in their own words. Stored verbatim and named by every machine approval made under it." },
        }, additionalProperties: false,
      },
      async run(a) {
        if (a.op === "policy") {
          const p = await mv({
            action: "plan_policy", slug: safeName(a.slug, "project"), planId: a.plan_id,
            onFailure: a.on_failure,
            autoApproveUnderMinutes: a.auto_approve_under_minutes,
            delegateBrief: a.delegate_brief,
          });
          return planOut(p);
        }
        if (a.op !== "approve" && a.op !== "skip" && a.op !== "unapprove") {
          throw new Error(`op must be approve, skip, unapprove or policy — not "${a.op}".`);
        }
        const status = a.op === "approve" ? "approved" : a.op === "skip" ? "skipped" : "proposed";
        const r = await mv({
          action: "plan_decide", slug: safeName(a.slug, "project"), planId: a.plan_id,
          items: a.items, status, acknowledge: a.acknowledge,
          reasoning: a.reasoning, freeText: a.free_text,
        });
        return planOut(r);
      },
    },
    {
      name: "mv_plan_run",
      description: "START. op \"start\" runs the approved items in order and RETURNS IMMEDIATELY — poll mv_plan_read. \"pause\" lets the render in flight finish and then stops, leaving the rest approved; \"resume\" carries on from there; \"stop\" cancels the plan, marks everything still approved as skipped, and cancels this project's clip in flight (taken off the app's queue, and cancelled on the graphics card if it is rendering); the plan's note then says what was really reached, and a picture or Blender item in flight finishes. The Studio's own Stop button pauses a running plan instead, keeping every approval.\n\nRefuses to start with nothing approved, and refuses while another plan is running anywhere — there is one GPU. On a failure the default policy stops the run and leaves every remaining approved item APPROVED: nothing is un-approved by somebody else's failure, and starting again is a deliberate act.\n\nEach item is executed by calling the tool it names, with the arguments the human approved. Each execution is recorded in the project's provenance ledger with the plan id, the item id, and the id of the `choice` event that authorised it — so \"a human decided\" and \"a machine executed\" are two records with an explicit join, not one record pretending to be both.",
      inputSchema: {
        type: "object", required: ["slug", "op"],
        properties: {
          slug: { type: "string" },
          plan_id: { type: "string", description: "Omit for the live plan." },
          op: { type: "string", enum: ["start", "pause", "resume", "stop"] },
        }, additionalProperties: false,
      },
      async run(a) {
        const r = await mv({ action: "plan_run", slug: safeName(a.slug, "project"), planId: a.plan_id, op: a.op });
        return planOut(r);
      },
    },

    /* ───────────────────────────── audiobooks ─────────────────────────────
     * Same store, same route, kind: "audiobook". The unit of output is the
     * BUNDLE: one 5-15 minute MP3 of whole chapters. One voice per book. */

    {
      name: "ab_create_project",
      description: "Start an audiobook project. The pipeline: ingest a book (epub/pdf) → plan 5-15 minute chapter bundles → choose ONE voice for the whole book → narrate → ambient beds duck under the voice → chaptered, tagged MP3s.",
      inputSchema: { type: "object", required: ["title"], properties: { title: { type: "string" } }, additionalProperties: false },
      async run(a) { const r = await mv({ action: "create", title: a.title, kind: "audiobook" }); return { slug: r.slug }; },
    },
    {
      name: "ab_ingest",
      description: "Read an .epub or .pdf into the project: chapter inventory with word counts, front matter auto-skipped (reversible per chapter with ab_toggle_chapter). Epubs chapter from their own spine; PDFs from 'Chapter N' headings.",
      inputSchema: { type: "object", required: ["slug", "path"], properties: { slug: { type: "string" }, path: { type: "string" } }, additionalProperties: false },
      async run(a) {
        const r = await mv({ action: "ab_ingest", slug: a.slug, path: a.path });
        return { title: r.book.title, chapters: r.book.chapters.length,
                 narratable: r.book.chapters.filter((c) => !c.skip).length,
                 words: r.book.chapters.reduce((x, c) => x + (c.skip ? 0 : c.words), 0) };
      },
    },
    {
      name: "ab_plan",
      description: "Pack whole chapters into MP3-sized bundles (default 5-15 min at 165 wpm). A chapter is never split across files. Re-planning resets bundle state.",
      inputSchema: {
        type: "object", required: ["slug"],
        properties: { slug: { type: "string" }, min_minutes: { type: "number" }, max_minutes: { type: "number" } },
        additionalProperties: false,
      },
      async run(a) {
        const settings = {};
        if (a.min_minutes) settings.targetMinMinutes = a.min_minutes;
        if (a.max_minutes) settings.targetMaxMinutes = a.max_minutes;
        const r = await mv({ action: "ab_plan", slug: a.slug, settings });
        return { bundles: r.bundles.map((b) => ({ idx: b.idx, title: b.title, words: b.words, est_minutes: b.estMinutes })) };
      },
    },
    {
      name: "ab_set_voice",
      description: "Choose THE voice — one per book, recorded on the project so every chapter matches. Engines: kokoro (instant, personas like bm_george/bm_fable/af_heart) or qwen3 (richer; Ryan/Aiden presets). Changing the voice after narration marks narrated bundles stale rather than letting the book drift.",
      inputSchema: {
        type: "object", required: ["slug", "model", "persona"],
        properties: { slug: { type: "string" }, model: { type: "string", enum: ["kokoro", "qwen3"] }, persona: { type: "string" } },
        additionalProperties: false,
      },
      async run(a) { const r = await mv({ action: "ab_set_voice", slug: a.slug, model: a.model, persona: a.persona }); return r.voice; },
    },
    {
      name: "ab_toggle_chapter",
      description: "Include or skip one chapter (by idx from ab_ingest). Skips are how front matter stays out and how a partial book is scoped.",
      inputSchema: { type: "object", required: ["slug", "idx"], properties: { slug: { type: "string" }, idx: { type: "integer" } }, additionalProperties: false },
      async run(a) { await mv({ action: "ab_toggle_chapter", slug: a.slug, idx: a.idx }); return { ok: true }; },
    },
    {
      name: "mv_bible_spec",
      description: "THE AUTHORING CONTRACT: returns the exact bible shape to produce (story, styleBible, characters, backgrounds, one board per generate-segment with shots/refs/prominence), the house rules (action is the field that writes the clip; strict name binding; refProminence drop-order), AND this project's actual segments with their lines and durations. Call this, write the bible, commit with mv_set_bible. You are the master LLM the website pays Opus to be.",
      inputSchema: { type: "object", required: ["slug"], properties: { slug: { type: "string" } }, additionalProperties: false },
      async run(a) { const r = await mv({ action: "bible_spec", slug: a.slug }); return r.spec; },
    },
    {
      name: "mv_set_bible",
      description: "Commit a production bible (shape from mv_bible_spec). Validated: board refs must name declared characters/backgrounds, boards must land on real segments — rejected wholesale otherwise. Merges by NAME so already-rendered sheets survive re-authoring; clips rendered from older boards are marked stale. Returns the project plus a lint report.",
      inputSchema: {
        type: "object", required: ["slug", "bible"],
        properties: { slug: { type: "string" }, bible: { type: "object",
          /* ⚠ `props` was accepted by commitBible, required by DIRECTING.md's
           * loudest rule and named in NO schema — so an agent reading this tool
           * rather than calling mv_bible_spec first could not learn that a prop
           * can be declared at all, and the car in 13 of 22 scenes stayed
           * undeclared. Same defect class as the dead parameters above, one
           * level down: a nested object the census cannot see into. */
          properties: { story: { type: "object" }, styleBible: { type: "string" },
            characters: { type: "array" }, backgrounds: { type: "array" },
            props: { type: "array", description: "PROPS ARE CAST. Any object that recurs and must be the SAME object — a car, a guitar, a suitcase — as {name, description}. Undeclared, it is re-invented on every render. Render its sheet with mv_blender_sheet (a mesh IS the same object) or mv_generate_asset, and list it in each board's propRefs." },
            boards: { type: "array" } } } },
        additionalProperties: false,
      },
      async run(a) { const r = await mv({ action: "set_bible", slug: a.slug, bible: a.bible }); return { boards: r.project.boards.length, characters: r.project.characters.length, backgrounds: r.project.backgrounds.length, lint: r.lint }; },
    },
    {
      name: "mv_set_board",
      description: "Upsert ONE storyboard without re-authoring the bible: segmentId + {boardPrompt, grade, shots[], characterRefs, backgroundRefs, propRefs, refProminence, crowd, lipSync}. propRefs is not optional decoration — an object listed in props[] but not in the propRefs of the scenes it appears in is re-invented in each of them. Same validation as mv_set_bible; an existing clip for that scene is marked stale.",
      inputSchema: {
        type: "object", required: ["slug", "segmentId", "board"],
        properties: { slug: { type: "string" }, segmentId: { type: "string" }, board: { type: "object" } },
        additionalProperties: false,
      },
      async run(a) { const r = await mv({ action: "set_board", slug: a.slug, segmentId: a.segmentId, board: a.board }); return r.board; },
    },
    {
      name: "mv_lint",
      description: "The free pre-flight: what would waste GPU if rendered now — boards referencing nothing, sheets not rendered, scenes without boards (they fall back to a generic performance shot), thin shot actions, clips stale against newer boards, a character named in a board's words but not ticked as its cast (the clip then invents them), ticked cast whose pictures the brief will not send, and sung scenes with no song under the clip. Run before spending on sheets or clips. Issues with a `fix` are one call away: its `tool` with its `args`.",
      inputSchema: { type: "object", required: ["slug"], properties: { slug: { type: "string" } }, additionalProperties: false },
      async run(a) {
        const r = await mv({ action: "lint", slug: a.slug });
        /* The route's fix, in this toolkit's spelling: set_shot is mv_set_shot
         * (segment, refs), set_brief is mv_set_brief with its snake_case keys. */
        const SNAKE = { videoEngine: "video_engine", castRefs: "cast_refs", songConditioning: "song_conditioning" };
        const snake = (o = {}) => Object.fromEntries(Object.entries(o).map(([k, v]) => [SNAKE[k] || k, v]));
        return (r.issues || []).map((i) => (!i.fix ? i : {
          ...i,
          fix: i.fix.action === "set_shot"
            ? { label: i.fix.label, tool: "mv_set_shot", args: { slug: a.slug, segment: i.fix.segmentId, refs: i.fix.refs } }
            : { label: i.fix.label, tool: "mv_set_brief", args: { slug: a.slug, ...snake(i.fix.brief) } },
        }));
      },
    },
    {
      name: "ab_set_cast",
      description: "Dialogue casting: give named characters their own voices. Quoted lines in paragraphs attributed to a cast member ('...' said Geralt) are read in that character's persona; the prose (and 'said X' tails) stays with the narrator, audiobook-style. Unattributed back-and-forth alternates between the last two speakers. Replaces the whole cast list; re-narrate bundles to apply. Kokoro personas: bm_george, bm_fable, bf_emma, af_heart, am_michael and ~45 more.",
      inputSchema: {
        type: "object", required: ["slug", "cast"],
        properties: {
          slug: { type: "string" },
          cast: { type: "array", items: {
            type: "object", required: ["name"],
            properties: {
              name: { type: "string", description: "The character's name as printed in the book" },
              aliases: { type: "array", items: { type: "string" }, description: "Other names the text uses (surname, title)" },
              voice: { type: "object", properties: { model: { type: "string", enum: ["kokoro", "qwen3"] }, persona: { type: "string" } } },
              note: { type: "string" },
            }, additionalProperties: false } },
        }, additionalProperties: false,
      },
      async run(a) { const r = await mv({ action: "ab_set_cast", slug: a.slug, cast: a.cast }); return r.cast; },
    },
    {
      name: "ab_sfx_scan",
      description: "Propose sound-effect cues for a NARRATED bundle: a curated lexicon (rain, thunder, swords, doors, fire, wolves...) scans the narration script and places each cue at the second the phrase is spoken. Restraint built in: max 8 cues, 25 s apart, strongest signals win. Returns the proposals — nothing renders yet. For smarter cues, read the chapter text yourself and use ab_sfx_set.",
      inputSchema: { type: "object", required: ["slug", "bundle"], properties: { slug: { type: "string" }, bundle: { type: "integer" } }, additionalProperties: false },
      async run(a) { const r = await mv({ action: "ab_sfx", mode: "scan", slug: a.slug, bundle: a.bundle }); return r.cues; },
    },
    {
      name: "ab_sfx_set",
      description: "Write the bundle's SFX cue list yourself — the intelligent path: read the chapters (ab_board / project GET show the text inventory), decide what deserves sound, and place cues by the second. Overwrites scan proposals. Each cue: label, prompt (what Stable Audio should render, e.g. 'heavy oak door slamming, reverberant'), at (seconds into the bundle), seconds (1-10), gain (0.1-1 under the narration).",
      inputSchema: {
        type: "object", required: ["slug", "bundle", "cues"],
        properties: {
          slug: { type: "string" }, bundle: { type: "integer" },
          cues: { type: "array", items: {
            type: "object", required: ["prompt", "at"],
            properties: { label: { type: "string" }, prompt: { type: "string" }, at: { type: "number" },
                          seconds: { type: "number" }, gain: { type: "number" } },
            additionalProperties: false } },
        }, additionalProperties: false,
      },
      async run(a) { const r = await mv({ action: "ab_sfx", mode: "set", slug: a.slug, bundle: a.bundle, cues: a.cues }); return r.bundle?.sfxSuggestions; },
    },
    {
      name: "ab_sfx_judge",
      description: "Grade the bundle's cue list with the LOCAL model (qwen 4B via the engine): each cue's passage is judged 'is this a real audible event or a figure of speech?' — 'an explosion of stars' when someone is clubbed gets real:false and is skipped by render. Free, runs on this machine, waits for the render queues first. Returns the graded cues with reasons.",
      inputSchema: { type: "object", required: ["slug", "bundle"], properties: { slug: { type: "string" }, bundle: { type: "integer" } }, additionalProperties: false },
      async run(a) { const r = await mv({ action: "ab_sfx", mode: "judge", slug: a.slug, bundle: a.bundle }); return r.cues; },
    },
    {
      name: "ab_audition",
      description: "Cast by ear: render short samples of candidate voices reading a line from THIS book (or a supplied text). Cached by (persona, text) so re-auditioning is free. Default roster = 7 kokoro personas; pass personas to audition others (e.g. qwen3 Ryan/Aiden). Returns {sample, voices:[{model, persona, file}]} — files are served at /api/mv/asset/<slug>/<file>.",
      inputSchema: {
        type: "object", required: ["slug"],
        properties: { slug: { type: "string" }, text: { type: "string" },
          personas: { type: "array", items: { type: "object", required: ["model", "persona"],
            properties: { model: { type: "string", enum: ["kokoro", "qwen3"] }, persona: { type: "string" } },
            additionalProperties: false } } },
        additionalProperties: false,
      },
      async run(a) { return await mv({ action: "ab_audition", slug: a.slug, personas: a.personas, text: a.text }); },
    },
    {
      name: "ab_sfx_render",
      description: "Render the bundle's cue list through Stable Audio 3 Small SFX and attach the effects to the mix plan (marks an existing mix stale — run ab_mix again to hear them). only: indices into the cue list to render a subset.",
      inputSchema: {
        type: "object", required: ["slug", "bundle"],
        properties: { slug: { type: "string" }, bundle: { type: "integer" },
                      only: { type: "array", items: { type: "integer" } }, seed: { type: "integer" } },
        additionalProperties: false,
      },
      async run(a) { const r = await mv({ action: "ab_sfx", mode: "render", slug: a.slug, bundle: a.bundle, only: a.only, seed: a.seed }); return r.sfx; },
    },
    {
      name: "ab_sfx_clear",
      description: "Remove every cue and rendered effect from a bundle (the mix plan drops them on the next ab_mix).",
      inputSchema: { type: "object", required: ["slug", "bundle"], properties: { slug: { type: "string" }, bundle: { type: "integer" } }, additionalProperties: false },
      async run(a) { await mv({ action: "ab_sfx", mode: "clear", slug: a.slug, bundle: a.bundle }); return { ok: true }; },
    },
    {
      name: "ab_generate_bed",
      description: "Make one REUSABLE ambient bed through the music engine (mood: calm | dark | action | wonder). ~60-90 s of audio; the mixer loops it seamlessly under any bundle. Beds are shared across the book on purpose — same mood, same music, coherent album. Blocks minutes.",
      inputSchema: {
        type: "object", required: ["slug"],
        properties: { slug: { type: "string" }, mood: { type: "string", enum: ["calm", "dark", "action", "wonder"] }, seed: { type: "integer" } },
        additionalProperties: false,
      },
      async run(a) { const r = await mv({ action: "ab_bed", slug: a.slug, mood: a.mood, seed: a.seed }); return { beds: r.beds.map((x) => ({ id: x.id, mood: x.mood, seed: x.seed })) }; },
    },
    {
      name: "ab_narrate",
      description: "Narrate one bundle with the project's voice. Waits for the render queues to go idle (one GPU), then synthesizes chapter by chapter. Blocks — minutes to tens of minutes per bundle.",
      inputSchema: { type: "object", required: ["slug", "bundle"], properties: { slug: { type: "string" }, bundle: { type: "integer" } }, additionalProperties: false },
      async run(a) {
        const r = await mv({ action: "ab_narrate", slug: a.slug, bundle: a.bundle });
        return { minutes: Math.round((r.bundle.narrationSeconds || 0) / 60), chunks: r.bundle.narration.length };
      },
    },
    {
      name: "ab_use_bed",
      description: "Point a bundle at a specific bed (or empty for auto). This is how chapter 12 reuses the dark bed chapter 3 established.",
      inputSchema: { type: "object", required: ["slug", "bundle"], properties: { slug: { type: "string" }, bundle: { type: "integer" }, bed_id: { type: "string" } }, additionalProperties: false },
      async run(a) { await mv({ action: "ab_use_bed", slug: a.slug, bundle: a.bundle, bedId: a.bed_id }); return { ok: true }; },
    },
    {
      name: "ab_mix",
      description: "Mix one narrated bundle to its final MP3: narration mastered to audiobook levels (RMS -20 dBFS, peaks ≤ -3), the bed looped with equal-power crossfades and ducked ~13 dB under speech, 192 kbps stereo, numbered and tagged. The file lands in output/ab/<slug>/out/.",
      inputSchema: { type: "object", required: ["slug", "bundle"], properties: { slug: { type: "string" }, bundle: { type: "integer" } }, additionalProperties: false },
      async run(a) {
        const r = await mv({ action: "ab_mix", slug: a.slug, bundle: a.bundle });
        return { file: r.bundle.mixFile, minutes: Math.round((r.bundle.mixSeconds || 0) / 60) };
      },
    },
    {
      name: "ab_board",
      description: "The audiobook's relationship map + chapter manager: every chapter (done / planned / skipped and which file it went into), every bed with its seed, the voice — what an agent reads to continue a half-finished book coherently.",
      inputSchema: { type: "object", required: ["slug"], properties: { slug: { type: "string" } }, additionalProperties: false },
      async run(a) { return mv({ action: "crime_board", slug: a.slug }); },
    },
  ];
}
