/**
 * DAW — the MCP tools.
 *
 * ┌─ FOR THE INTEGRATOR ───────────────────────────────────────────────────┐
 * │ Two lines in server/mcp.js:                                            │
 * │                                                                        │
 * │  1. beside the other imports:                                          │
 * │     import { dawTools } from "./mcp-daw.js";                           │
 * │                                                                        │
 * │  2. inside the TOOLS array, alongside the existing entries:            │
 * │     ...dawTools(api, safeName),                                        │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * Every tool calls the SAME /api/daw route the DAW page calls — one document,
 * one reducer path, two hands (§13a). The one difference between the hands is
 * attribution: every mutating tool sends `by: "agent"`, which the store stamps
 * on the note and the ledger. Voice and shape follow mcp-vfx.js: snake_case
 * params, additionalProperties: false, errors that name the fix.
 *
 * WHAT THE DESCRIPTIONS ARE FOR. An agent cannot hear the render. Every unit
 * here is spelled out because guessing one is how you get a note at tick 480
 * of a beat that only has 960, or a "beat 8" in a 7/8 bar. The time model is
 * stated once, quoted by every tool that takes a position:
 */

/** Written once, quoted by every tool that takes a musical position. */
const TIME =
  "Positions are MUSICAL: bar and beat are 1-based, tick is 0..959 with 960 "
  + "ticks per beat. A beat is the meter's DENOMINATOR unit (a quarter in 4/4, "
  + "an eighth in 7/8 — so 7/8 bars have beats 1..7). Meter and tempo are "
  + "event lists (set_meter/set_tempo at a bar); bars are derived from them, "
  + "and bars are NOT equal length in mixed meter. Tempo bpm is QUARTER-NOTE "
  + "bpm (the MIDI convention), so a meter change never redefines the pulse. "
  + "Durations (dur_ticks) are ticks of the local beat: 960 = one beat.";

/* CHAIN STAGE (agent/dawrack): the rack's three tools live beside their
 * routes in server/daw/ and are spread into the family below, so every
 * guard in mcp-daw_test.js covers them too. */
import { rackTools } from "./daw/mcp-rack.js";
/* THE EAR (agent/dawear): daw_critique / daw_apply_choice / daw_ear_status /
 * daw_taste live beside their routes in server/daw/ and are spread into the
 * family below, so every guard in mcp-daw_test.js covers them too. */
import { earTools } from "./daw/mcp-ear.js";
/* THE MASTERING SUITE (agent/master): daw_analyze / daw_device_response /
 * daw_reference / daw_check_delivery live beside their routes in
 * server/daw/ and are spread into the family below, so every guard in
 * mcp-daw_test.js covers them too. The suite's SEVEN DEVICES need no tool
 * of their own — they go on a chain with daw_insert like the other nine. */
import { masterTools } from "./daw/mcp-master.js";
import { LOUDNESS_SCHEMA } from "./daw/bounce-options.js";
/* THE ARRANGER's own constants, imported rather than retyped: the description
 * below states the faders, the roll and the track names, and a description
 * that quotes a number the plan no longer sends is a lie an agent acts on.
 * (It has been one twice: "clap+hat" survived the split into clap+snare and
 * hats, and the faders quoted the second take's, not the shipped ones.) */
import {
  FADERS, ROLL, CLAP_VEL, SUB, RISER, MASTER, SIDECHAIN, SIDECHAIN_RELEASE_BEATS,
  HATS_EQ, LEAD_CHAIN, CLAP_CHAIN, ROLES,
} from "./daw/arrange.js";
/* §3 THE VOICE LAB's tools, when the module is on this tree. Optional import
 * for the same reason routes.js mounts voicelab.js optionally. */
const voicelabTools = (await import("./daw/mcp-voicelab.js").catch((err) => {
  if (err?.code !== "ERR_MODULE_NOT_FOUND" || !/mcp-voicelab\.js/.test(String(err.message))) {
    console.error(`  [daw] server/daw/mcp-voicelab.js is present but failed to load: ${err?.message}`);
  }
  return null;
}))?.voicelabTools ?? null;
/* §7 THE REFERENCE PROFILE's four tools, on the same optional terms — a tree
 * without server/daw/refprofile.js has four fewer tools rather than a broken
 * tool list, and server/daw/ui_test.js's route-to-tool gate only asks for a
 * tool for an action the routes actually dispatch, so the two absences agree. */
const refprofileTools = (await import("./daw/mcp-refprofile.js").catch((err) => {
  if (err?.code !== "ERR_MODULE_NOT_FOUND" || !/mcp-refprofile\.js/.test(String(err.message))) {
    console.error(`  [daw] server/daw/mcp-refprofile.js is present but failed to load: ${err?.message}`);
  }
  return null;
}))?.refprofileTools ?? null;
/** The per-track instrument params, quoted by both track tools. */
const PARAMS =
  "Instrument params (all optional): transpose (semitones, -48..48), gain_db (-24..24), "
  + "and — for the GeneralUser GS bank only — program (0..127, the GM program number) "
  + "and drum_kit (true for the GM drum bank). A patch may also declare its OWN knobs: "
  + "the drum machines (tr808, tr909, tr808_bass, hybrid_kick) expose their circuit "
  + "directly — kick_tune, kick_decay, kick_drive, kick_click, snare_snappy, hat_decay "
  + "and the rest — and so do the big-room synths (bigroom_lead: voices, detune, spread, "
  + "cutoff, filter_amount, filter_decay, resonance, snap, drive...; sub_bass; riser, whose "
  + "filter opens over the note's own length; impact). daw_patches lists every patch's "
  + "params with min/max/default/doc, and its presets (named knob settings you send as "
  + "params yourself — hybrid_kick's `bigroom` is the measured big-room kick); "
  + "anything a patch does not declare is dropped on write. Params are part of the "
  + "region hash, so changing one re-renders exactly the regions that patch sounds in.";

export function dawTools(api, safeName) {
  const daw = async (body) => {
    const r = await api("POST", "/api/daw", { ...body, by: "agent" });
    if (r.error) throw new Error(r.error);
    return r;
  };
  const get = async (p) => {
    const r = await api("GET", p);
    if (r.error) throw new Error(r.error);
    return r;
  };
  /* THE EAR's own prefix. A critique renders and measures a bar range and an
   * auto run does it several times over, so the timeout is the render lane's,
   * not the default 2 minutes. */
  const ear = async (body) => {
    const r = await api("POST", "/api/daw/ear", { ...body, by: "agent" }, 1_800_000);
    if (r.error) throw new Error(r.error);
    return r;
  };
  const earGet = async (p) => {
    const r = await api("GET", p, undefined, 600_000);
    if (r.error) throw new Error(r.error);
    return r;
  };
  const slugOf = (s) => safeName(s, "project");

  /** A project small enough to read back: no per-note dumps unless asked. */
  const summary = (full) => ({
    slug: full.project.slug, name: full.project.name,
    length_bars: full.project.lengthBars,
    total_seconds: Number(full.totalSeconds.toFixed(3)),
    meter_map: full.project.meterMap,
    tempo_map: full.project.tempoMap,
    /* WHERE THE PANELS ARE. Small, and part of the project rather than of one
     * browser -- so an agent asked "what does this look like" can answer, and
     * one asked to restore a window somebody folded into nothing can see what
     * it is restoring FROM. It was dropped here while being persisted and
     * served everywhere else, which is the quiet half of a feature that looks
     * finished. */
    view: full.project.view,
    tracks: full.project.tracks.map((t) => ({
      id: t.id, name: t.name, instrument: t.instrument,
      gain_db: t.gainDb, mute: t.mute,
      /* THE CHAIN, which this view used to omit entirely.
       *
       * The inserts live on the track document and every daw_insert write
       * RETURNS the chain — but there was no way to READ one. op "list" does
       * not exist either, so the only way to learn an insert's id was to send a
       * wrong one and mine it out of the error message. That is not a workflow;
       * it is a guess with a good error attached. Tuning an EQ across three
       * passes needs the id every time. */
      inserts: (t.inserts || []).map((i) => ({
        id: i.id, type: i.type, enabled: i.enabled !== false, params: i.params || {},
      })),
      clips: t.clips.map((c) => ({ id: c.id, bars: `${c.fromBar}-${c.toBar}`, notes: c.notes.length })),
    })),
    regions: full.regions.map((r, i) => ({
      idx: r.idx, bars: `${r.fromBar}-${r.toBar}`,
      seconds: `${r.t0.toFixed(3)}-${r.t1.toFixed(3)}`, hash: full.hashes[i],
    })),
  });

  return [
    {
      name: "daw_status",
      description:
        "The DAW surface: every project (slug, tracks, note counts, meter/tempo maps) and "
        + "what the render engine speaks (instruments, tails, sample rate). Call this first. "
        + "The engine's tail table and the store's must MATCH — a mismatch is a bug worth reporting.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async run() {
        const [projects, probe] = await Promise.all([
          get("/api/daw/projects"),
          daw({ action: "probe" }).catch((e) => ({ error: e.message })),
        ]);
        const installed = probe.patches_installed || {};
        return {
          projects: projects.projects,
          engine: probe.error ? { error: probe.error } : {
            instruments: probe.instruments, tails: probe.tails, sr: probe.sr_default,
            tables_agree: JSON.stringify(probe.tails) === JSON.stringify(probe.storeTails),
            /* The palette, in one line each: how many patches can render now,
             * and whether the store's tail table and the instrument stage's
             * agree patch-for-patch (they are read from ONE manifest, so a
             * disagreement means one side is stale on disk). */
            sampler_backend: probe.sampler_backend,
            instruments_dir: probe.instruments_dir,
            patches_ready: Object.keys(installed).filter((k) => installed[k]).length,
            patches_total: Object.keys(installed).length,
            patch_tables_agree:
              JSON.stringify(probe.patch_tails) === JSON.stringify(probe.storePatchTails),
            /* ⚠ REGIONS WHOSE PITCH COULD NOT BE ESTABLISHED, and therefore play
             * a sample untransposed across a range of keys -- the defect that
             * made a shipped bass a semitone out on two keys, in 302 regions
             * across the installed packs. The audit reaches the raw probe
             * reply; without this line it stopped there and never reached an
             * agent, which is the quiet half of a fix that looks finished.
             * Zero is the expected answer; anything else names packs to look at
             * with `python instruments.py keycenters`. */
            keycenters_unresolved: probe.sfz_keycenters?.totals?.unresolved ?? null,
          },
        };
      },
    },

    {
      name: "daw_create_project",
      description:
        "Create a project. " + TIME + " The project starts with the given meter and tempo "
        + "at bar 1; add more events with daw_set_meter / daw_set_tempo.",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          bpm: { type: "number", description: "Quarter-note bpm, 20-400. Default 120." },
          num: { type: "integer", description: "Meter numerator at bar 1, 1-32. Default 4." },
          den: { type: "integer", description: "Meter denominator at bar 1: 1, 2, 4, 8, 16 or 32. Default 4." },
          length_bars: { type: "integer", description: "Project length in bars, 1-256. Default 16." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({ action: "create", name: a.name, bpm: a.bpm, num: a.num, den: a.den, length_bars: a.length_bars });
        return { slug: r.slug, name: r.project.name, length_bars: r.project.lengthBars };
      },
    },

    {
      name: "daw_get_project",
      description:
        "A project's structure: tracks, clips, note counts, meter/tempo maps, and the render "
        + "regions with their content hashes (the hash changes exactly when a region's sound "
        + "would). Set include_notes to read the piano roll itself.",
      inputSchema: {
        type: "object",
        required: ["slug"],
        properties: {
          slug: { type: "string" },
          include_notes: { type: "boolean", description: "Also return every note (id, bar.beat.tick, dur_ticks, pitch, vel, by)." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const full = await get(`/api/daw/project/${encodeURIComponent(slugOf(a.slug))}`);
        const out = summary(full);
        if (a.include_notes) {
          out.notes = full.project.tracks.map((t) => ({
            track: t.id,
            notes: t.clips.flatMap((c) => c.notes.map((n) => ({
              id: n.id, clip: c.id, at: `${n.bar}.${n.beat}.${n.tick}`,
              dur_ticks: n.durTicks, pitch: n.pitch, vel: n.vel, by: n.by,
            }))),
          }));
        }
        return out;
      },
    },

    {
      name: "daw_delete_project",
      description: "Delete a project and its render cache. Permanent.",
      inputSchema: {
        type: "object", required: ["slug"],
        properties: { slug: { type: "string" } },
        additionalProperties: false,
      },
      async run(a) {
        return daw({ action: "delete", slug: slugOf(a.slug) });
      },
    },

    {
      name: "daw_layout",
      description:
        "WHERE THE PANELS ARE \u2014 the browser, the mixer and the bottom dock \u2014 carried by the "
        + "project, so a layout is part of the work rather than something one browser happens to "
        + "remember.\n\n"
        + "Three presets, named for what they do:\n"
        + "  \u00b7 default \u2014 browser left, mixer as a right column, dock along the bottom. "
        + "Everything reachable; past about four tracks the mixer column scrolls.\n"
        + "  \u00b7 deck \u2014 the mixer moves ACROSS THE BOTTOM and the browser folds. This is the "
        + "shape that fits a whole song's channels at once: measured, a 1920 window holds "
        + "fourteen compact strips in a deck against three in a 268px column. It costs the "
        + "browser and the dock, and 300px of arrangement.\n"
        + "  \u00b7 wide \u2014 everything folded but the arrangement and the piano roll. For writing "
        + "notes, not for mixing.\n\n"
        + "\u26a0 A PRESET AND A MEASUREMENT IN THE SAME CALL BOTH APPLY. The preset lands first and "
        + "anything explicit lands on top, so \"deck, and make it 420 tall\" does both.\n\n"
        + "\u26a0 AND THIS IS THE WAY OUT OF A LAYOUT. Every control for changing the layout lives "
        + "IN it, so a window folded down to nothing has its own fix off screen. Setting "
        + "preset \"default\" restores a working window from here.\n\n"
        + "Changes no audio and dirties no render region.",
      inputSchema: {
        type: "object",
        required: ["slug"],
        properties: {
          slug: { type: "string" },
          preset: { type: "string", enum: ["default", "deck", "wide"],
            description: "Applied first; anything else you pass lands on top of it." },
          mixer_mode: { type: "string", enum: ["side", "deck"],
            description: "side = a column on the right; deck = across the bottom, which is what fits a whole song's strips." },
          mixer_width: { type: "integer", description: "180-640 px, the side column. Below 180 the gutter and two compact strips no longer fit; above 640 the mixer is wider than the arrangement." },
          mixer_height: { type: "integer", description: "260-520 px, the deck. 260 is the shortest deck in which a strip does not overflow its own box \u2014 at 200 the solo/mute/arm row lands where it cannot be clicked." },
          mixer_folded: { type: "boolean" },
          mixer_compact: { type: "boolean", description: "Narrow strips: the fader and the meter, without the patch line, the sends and the pan readout. Roughly twice the channels in the same width." },
          browser_width: { type: "integer", description: "160-480 px." },
          browser_folded: { type: "boolean" },
          dock_folded: { type: "boolean", description: "The bottom dock \u2014 chain, analysis, the Ear, voice." },
          fader_height: { type: "integer", description: "108-320 px. 108 is where the nine dB labels collide; for scale a channel fader is ~160 in Reaper, ~180 in Ableton, ~200 in Logic. A deck wants ~132." },
        },
        additionalProperties: false,
      },
      async run(a) {
        /* Only what was actually asked for: an undefined field must not be sent
         * as a null and overwrite what the project already had. */
        const mixer = {};
        if (a.mixer_mode !== undefined) mixer.mode = a.mixer_mode;
        if (a.mixer_width !== undefined) mixer.width = a.mixer_width;
        if (a.mixer_height !== undefined) mixer.height = a.mixer_height;
        if (a.mixer_folded !== undefined) mixer.folded = a.mixer_folded;
        if (a.mixer_compact !== undefined) mixer.compact = a.mixer_compact;
        const browser = {};
        if (a.browser_width !== undefined) browser.width = a.browser_width;
        if (a.browser_folded !== undefined) browser.folded = a.browser_folded;
        const view = {};
        if (a.preset !== undefined) view.preset = a.preset;
        if (a.fader_height !== undefined) view.faderH = a.fader_height;
        if (Object.keys(mixer).length) view.mixer = mixer;
        if (Object.keys(browser).length) view.browser = browser;
        if (a.dock_folded !== undefined) view.dock = { folded: a.dock_folded };
        const r = await daw({ action: "set_view", slug: slugOf(a.slug), view });
        return r.view ? { view: r.view } : r;
      },
    },
    {
      name: "daw_set_length",
      description:
        "Set the project's length in bars (1-256) — the same edit the arrangement window's "
        + "length box makes. SHORTENING IS NOT A DELETE: clips and notes past the new end are "
        + "kept, simply outside the song (they stop sounding and come back if you lengthen it "
        + "again). Lengthening adds silence, and existing clips do NOT grow to fill it — add or "
        + "resize one with daw_add_clip / daw_set_clip. A length change can change the number of "
        + "render regions, and every region past the old end is new and therefore dirty.",
      inputSchema: {
        type: "object",
        required: ["slug", "length_bars"],
        properties: {
          slug: { type: "string" },
          length_bars: { type: "integer", description: "1-256." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({ action: "set_length", slug: slugOf(a.slug), length_bars: a.length_bars });
        return { length_bars: r.lengthBars, dirty: r.dirty, updated_at: r.updatedAt };
      },
    },

    {
      name: "daw_add_track",
      description:
        "Add a track playing one PATCH from the registry (call daw_patches first — it lists "
        + "every patch, whether it is installed, and its licence). The three built-ins need no "
        + "download and work on a first run: pluck (Karplus-Strong string), pad (detuned-saw "
        + "poly pad), drums (synthesised kit, GM-ish keys: 36 kick, 38 snare, 42 closed hat, "
        + "46 open hat, 49 crash, toms elsewhere). Sampled patches (Salamander grand, AVL kits, "
        + "VSCO2 sections, Meatbass, Hang, GeneralUser GS) must be installed first or this "
        + "refuses and names the packs. " + PARAMS + " The track arrives with one clip spanning "
        + "the whole project, so daw_add_note works immediately.",
      inputSchema: {
        type: "object",
        required: ["slug", "instrument"],
        properties: {
          slug: { type: "string" },
          instrument: { type: "string", description: "A patch id from daw_patches (e.g. pluck, salamander, avl_black_pearl)." },
          params: { type: "object", description: PARAMS, additionalProperties: true },
          name: { type: "string" },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({ action: "add_track", slug: slugOf(a.slug), instrument: a.instrument,
                              params: a.params, name: a.name });
        return { track_id: r.trackId, clip_id: r.clipId, instrument: r.track?.instrument, dirty: r.dirty };
      },
    },

    {
      name: "daw_set_track",
      description:
        "Change a track: name, instrument (a patch id from daw_patches), params, gain_db "
        + "(-48..+12), mute, colour. " + PARAMS + " `colour` is an index into the window's "
        + "track palette (0-15); null clears it back to the one the track's position implies, "
        + "which is what both hands draw when nobody has chosen. It changes no audio and "
        + "dirties nothing. Every change answers with the regions it dirtied "
        + "— a gain change dirties exactly the regions that track sounds in, and so does a "
        + "patch or params change.",
      inputSchema: {
        type: "object",
        required: ["slug", "track"],
        properties: {
          slug: { type: "string" },
          track: { type: "string", description: "Track id (or unambiguous name)." },
          name: { type: "string" },
          instrument: { type: "string", description: "A patch id from daw_patches." },
          params: { type: "object", description: PARAMS, additionalProperties: true },
          gain_db: { type: "number" },
          mute: { type: "boolean" },
          colour: { type: ["integer", "null"], minimum: 0, maximum: 15,
                    description: "Palette index 0-15; null restores the positional default." },
        },
        additionalProperties: false,
      },
      async run(a) {
        return daw({ action: "set_track", slug: slugOf(a.slug), track: a.track,
                     name: a.name, instrument: a.instrument, params: a.params,
                     gain_db: a.gain_db, mute: a.mute, colour: a.colour });
      },
    },

    {
      name: "daw_remove_track",
      description:
        "Remove a track and everything on it — its clips and notes, its audio clips and takes, "
        + "and its mixer strip (inserts, sends, fader, pan). Permanent: the document has no undo, "
        + "only the ledger's record of who did it. Recorded take FILES stay on disk. Answers with "
        + "the regions the removal dirtied — exactly the ones that track sounded in, which is "
        + "none at all if it was muted or silent.",
      inputSchema: {
        type: "object",
        required: ["slug", "track"],
        properties: {
          slug: { type: "string" },
          track: { type: "string", description: "Track id (or unambiguous name)." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({ action: "remove_track", slug: slugOf(a.slug), track: a.track });
        return { removed: r.removed, dirty: r.dirty, updated_at: r.updatedAt };
      },
    },

    {
      name: "daw_add_clip",
      description:
        "Add a clip (a bar-range container for notes) to a track. Only needed when the "
        + "auto-created full-length clip is not enough — clips are how sections get moved later "
        + "(daw_set_clip). A note only sounds while its clip covers its bar.",
      inputSchema: {
        type: "object",
        required: ["slug", "track", "from_bar"],
        properties: {
          slug: { type: "string" },
          track: { type: "string" },
          from_bar: { type: "integer" },
          bars: { type: "integer", description: "Length in bars. Default 4." },
          name: { type: "string" },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({ action: "add_clip", slug: slugOf(a.slug), track: a.track,
                              from_bar: a.from_bar, bars: a.bars, name: a.name });
        return { clip_id: r.clipId, from_bar: r.fromBar, to_bar: r.toBar };
      },
    },

    {
      name: "daw_set_clip",
      description:
        "MOVE, RESIZE or RENAME a MIDI clip — the only way to change a clip's bounds after "
        + "daw_add_clip placed them, and the way to move a whole section without touching a "
        + "single note. FIVE RULES, and they are the whole model:\n"
        + "1. from_bar MOVES the clip and ITS NOTES RIDE ALONG — dragging a clip's body, as in "
        + "any DAW. A note at bar 2 of a clip moved from bar 1 to bar 9 is at bar 10 afterwards.\n"
        + "2. A move with no to_bar/bars KEEPS THE CLIP'S LENGTH: it translates, it does not "
        + "resize. (Pushed past the last bar it is truncated there, not refused.)\n"
        + "3. move_notes: false turns the same call into a TRIM — the left edge moves, the notes "
        + "stay put, and the right edge is left alone. to_bar/bars NEVER move notes.\n"
        + "4. SHRINKING IS NON-DESTRUCTIVE. A clip is the container that decides what sounds, so "
        + "notes outside the new bounds are kept and go SILENT; widening again brings them back "
        + "byte-for-byte. Nothing is ever deleted by a resize — the reply counts them as "
        + "notes_outside. (To actually delete, use daw_remove_clip or daw_delete_note.)\n"
        + "5. A note whose beat does not exist in its destination bar's meter — beat 7 landing in "
        + "a 4/4 bar — is clamped to that bar's last beat and counted as notes_clamped.\n"
        + "The reply's dirty regions name BOTH the range the clip left and the range it entered. "
        + TIME,
      inputSchema: {
        type: "object",
        required: ["slug", "track", "clip"],
        properties: {
          slug: { type: "string" },
          track: { type: "string", description: "Track id (or unambiguous name)." },
          clip: { type: "string", description: "The clip id from daw_add_clip / daw_get_project." },
          from_bar: { type: "integer", description: "New start bar. Moves the clip (see rule 1)." },
          to_bar: { type: "integer", description: "New end bar, inclusive. Resizes; never moves notes." },
          bars: { type: "integer", description: "New length in bars — an alternative to to_bar." },
          move_notes: { type: "boolean", description: "Default true. false = trim the left edge, leaving the notes where they are." },
          name: { type: "string" },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({ action: "set_clip", slug: slugOf(a.slug), track: a.track, clip: a.clip,
                              from_bar: a.from_bar, to_bar: a.to_bar, bars: a.bars,
                              move_notes: a.move_notes, name: a.name });
        return {
          clip: r.clip, moved_bars: r.movedBars,
          notes_moved: r.notesMoved, notes_clamped: r.notesClamped,
          notes_outside: r.notesOutside,
          dirty: r.dirty, updated_at: r.updatedAt,
        };
      },
    },

    {
      name: "daw_remove_clip",
      description:
        "Remove a MIDI clip from a track — AND every note in it. Permanent; the reply says how "
        + "many notes went with it. To silence a range without losing its notes, shrink the clip "
        + "with daw_set_clip instead — that is reversible, this is not.",
      inputSchema: {
        type: "object",
        required: ["slug", "track", "clip"],
        properties: {
          slug: { type: "string" },
          track: { type: "string" },
          clip: { type: "string" },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({ action: "remove_clip", slug: slugOf(a.slug), track: a.track, clip: a.clip });
        return { removed: r.removed, notes_removed: r.notesRemoved, dirty: r.dirty, updated_at: r.updatedAt };
      },
    },

    {
      name: "daw_add_note",
      description: "Add one note. " + TIME + " Velocity is 1-127 (default 100). Answers with "
        + "the note's id and the DIRTY regions — re-render those (daw_render) to hear it.",
      inputSchema: {
        type: "object",
        required: ["slug", "track", "bar", "beat", "pitch"],
        properties: {
          slug: { type: "string" },
          track: { type: "string" },
          clip: { type: "string", description: "Optional — defaults to the clip covering the bar." },
          bar: { type: "integer" },
          beat: { type: "integer" },
          tick: { type: "integer", description: "0..959. Default 0." },
          dur_ticks: { type: "integer", description: "960 = one beat. Default 960." },
          pitch: { type: "integer", description: "MIDI 0-127." },
          vel: { type: "integer", description: "1-127. Default 100." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({ action: "add_note", slug: slugOf(a.slug), track: a.track, clip: a.clip,
                              bar: a.bar, beat: a.beat, tick: a.tick,
                              dur_ticks: a.dur_ticks, pitch: a.pitch, vel: a.vel });
        return { note_id: r.note.id, at: `${r.note.bar}.${r.note.beat}.${r.note.tick}`,
                 clip_id: r.clipId, dirty: r.dirty, updated_at: r.updatedAt };
      },
    },

    {
      name: "daw_move_note",
      description:
        "Move or reshape one note: any of bar/beat/tick, pitch, dur_ticks, vel. Omitted "
        + "fields keep their value. " + TIME,
      inputSchema: {
        type: "object",
        required: ["slug", "track", "note"],
        properties: {
          slug: { type: "string" },
          track: { type: "string" },
          note: { type: "string", description: "The note id from daw_add_note or daw_get_project." },
          bar: { type: "integer" },
          beat: { type: "integer" },
          tick: { type: "integer" },
          pitch: { type: "integer" },
          dur_ticks: { type: "integer" },
          vel: { type: "integer" },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({ action: "move_note", slug: slugOf(a.slug), track: a.track, note: a.note,
                              bar: a.bar, beat: a.beat, tick: a.tick,
                              pitch: a.pitch, dur_ticks: a.dur_ticks, vel: a.vel });
        return { note: r.note, dirty: r.dirty, updated_at: r.updatedAt };
      },
    },

    {
      name: "daw_edit_notes",
      description:
        "Edit MANY notes on one track in ONE write — the array form of daw_move_note. Each entry "
        + "names a note by id and at least one field to change (vel, bar, beat, tick, pitch, "
        + "dur_ticks); omitted fields keep their value. It is one document write, one dirty-region "
        + "diff, ONE ledger row and one undo step, where the same edits sent one at a time are N "
        + "of each — so a velocity ramp across a drop lands as a single edit in the history "
        + "rather than four hundred. "
        + "ATOMIC: if any entry is refused (a note id the track does not hold, a pitch out of "
        + "range, the same note named twice, an entry that changes nothing) NOTHING is written "
        + "and the message names the index. Cap 2000 entries per call. "
        + "The reply carries `undo` — the whole gesture's inverse as a body you can post straight "
        + "back to daw_edit_notes to restore every previous value in one more write. " + TIME,
      inputSchema: {
        type: "object",
        required: ["slug", "track", "notes"],
        properties: {
          slug: { type: "string" },
          track: { type: "string" },
          clip: { type: "string", description: "Optional — defaults to whichever clip on the track holds each note." },
          notes: {
            type: "array",
            description: "[{note, vel?, bar?, beat?, tick?, pitch?, dur_ticks?}] — `note` is the id, "
              + "and each entry needs at least one other field or it is refused.",
            items: { type: "object" },
          },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({ action: "edit_notes", slug: slugOf(a.slug), track: a.track,
                              clip: a.clip, notes: a.notes });
        return { edited: r.edited?.length ?? 0, note_ids: r.edited, fields: r.fields,
                 track_id: r.trackId, dirty: r.dirty, undo: r.undo, updated_at: r.updatedAt };
      },
    },

    {
      name: "daw_delete_note",
      description: "Delete one note by id. Answers with the regions the deletion dirtied.",
      inputSchema: {
        type: "object",
        required: ["slug", "track", "note"],
        properties: {
          slug: { type: "string" },
          track: { type: "string" },
          note: { type: "string" },
        },
        additionalProperties: false,
      },
      async run(a) {
        return daw({ action: "delete_note", slug: slugOf(a.slug), track: a.track, note: a.note });
      },
    },

    {
      name: "daw_preview_note",
      description:
        "AUDITION one note on a track's patch without writing anything to the project — the "
        + "same render the piano roll's key-click makes. Answers with a wav url (content-"
        + "addressed and immutable, so a repeat audition of the same note costs nothing) plus "
        + "the patch and params it actually used, which is how you hear a transpose or a GM "
        + "program before committing to it. Nothing is added to the document, nothing is "
        + "dirtied, and no ledger entry is made. "
        + "params_override renders the note through DIFFERENT knob values without writing them "
        + "to the track: this is what makes a knob a preview rather than an edit — try the "
        + "filter open, hear it, and leave no undo entry behind. The override is clamped by "
        + "patches.json exactly as a real write would be (a knob the patch does not declare is "
        + "dropped) and it rides the cache key, so an audition stays content-addressed. "
        + "analysis: true adds the pictures — peaks and a per-channel spectrum, computed where the "
        + "audio already is, so nothing has to decode a wav to draw them. "
        + "Either field hands the call to the VOICE LAB, which owns that maths, so the reply is "
        + "the Voice Lab's (it also offers stereo and through_chain there) — and with neither "
        + "field this is the plain audition it has always been, the same bytes. "
        + "HONEST ABOUT WHAT IT IS NOT: this is a round trip through the server, not low-latency "
        + "monitoring — expect tens of milliseconds. It runs on the FAST serve lane, a second "
        + "engine child that only ever renders one note's worth of audio, so an audition no "
        + "longer waits behind a multi-second region render.",
      inputSchema: {
        type: "object",
        required: ["slug", "track", "pitch"],
        properties: {
          slug: { type: "string" },
          track: { type: "string", description: "Track id (or unambiguous name) — its patch is what you hear." },
          pitch: { type: "integer", description: "MIDI 0-127." },
          vel: { type: "integer", description: "1-127. Default 100." },
          dur_ticks: { type: "integer", description: "960 = one beat. Default 480; the patch's tail is added on top." },
          params_override: {
            type: "object",
            description: "Knob values for THIS audition only — merged over the track's own params "
              + "and never written to the document. daw_patches lists what each patch declares.",
          },
          analysis: {
            type: "boolean",
            description: "Also return {peaks, spectrum, envelope} for this note, computed server-side.",
          },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({ action: "preview_note", slug: slugOf(a.slug), track: a.track,
                              pitch: a.pitch, vel: a.vel, dur_ticks: a.dur_ticks,
                              params_override: a.params_override, analysis: a.analysis });
        return { url: r.url, patch: r.patch, params: r.params, pitch: r.pitch, vel: r.vel,
                 dur_ticks: r.dur_ticks, seconds: r.seconds, cached: r.cached,
                 params_override: r.params_override, document_unchanged: r.document_unchanged,
                 analysis: r.analysis, analysis_absent: r.analysisAbsent,
                 lane: r.lane, queue_ms: r.queueMs, note: r.note };
      },
    },

    {
      name: "daw_set_meter",
      description:
        "Edit the meter EVENT LIST. Place an event — FROM this bar onward the meter is num/den, "
        + "until the next event: the §12 model, so 7/8 at bar 17 is one call. Or pass "
        + "remove: true to take the event at that bar OUT, which hands those bars back to "
        + "whatever meter was in force before them. Bar 1's event is the anchor and cannot be "
        + "removed (every bar must have a meter) — change it instead. Bars before the edit are "
        + "untouched and keep their region hashes; everything after moves in time and is dirtied "
        + "honestly. den is 1, 2, 4, 8, 16 or 32.",
      inputSchema: {
        type: "object",
        required: ["slug", "at_bar"],
        properties: {
          slug: { type: "string" },
          at_bar: { type: "integer" },
          num: { type: "integer", description: "1-32. Required unless remove is true." },
          den: { type: "integer", description: "1, 2, 4, 8, 16 or 32. Required unless remove is true." },
          remove: { type: "boolean", description: "Delete the meter event at at_bar (which must be 2 or higher) instead of placing one." },
        },
        additionalProperties: false,
      },
      async run(a) {
        if (a.remove) {
          const r = await daw({ action: "remove_meter", slug: slugOf(a.slug), at_bar: a.at_bar });
          return { meter_map: r.meterMap, removed_at_bar: a.at_bar, dirty: r.dirty, updated_at: r.updatedAt };
        }
        if (a.num === undefined || a.den === undefined) {
          throw new Error("daw_set_meter needs num and den to place an event — or remove: true to delete the one at this bar.");
        }
        const r = await daw({ action: "set_meter", slug: slugOf(a.slug), at_bar: a.at_bar, num: a.num, den: a.den });
        return { meter_map: r.meterMap, dirty: r.dirty, updated_at: r.updatedAt };
      },
    },

    {
      name: "daw_set_tempo",
      description:
        "Edit the tempo EVENT LIST. Place an event — FROM this bar onward the tempo is bpm "
        + "(QUARTER-NOTE bpm, 20-400), until the next event, so a mid-song tempo change is one "
        + "call. Or pass remove: true to take the event at that bar OUT, handing those bars back "
        + "to the tempo in force before them. Bar 1's event is the anchor and cannot be removed — "
        + "change it instead.",
      inputSchema: {
        type: "object",
        required: ["slug", "at_bar"],
        properties: {
          slug: { type: "string" },
          at_bar: { type: "integer" },
          bpm: { type: "number", description: "Quarter-note bpm, 20-400. Required unless remove is true." },
          remove: { type: "boolean", description: "Delete the tempo event at at_bar (which must be 2 or higher) instead of placing one." },
        },
        additionalProperties: false,
      },
      async run(a) {
        if (a.remove) {
          const r = await daw({ action: "remove_tempo", slug: slugOf(a.slug), at_bar: a.at_bar });
          return { tempo_map: r.tempoMap, removed_at_bar: a.at_bar, dirty: r.dirty, updated_at: r.updatedAt };
        }
        if (a.bpm === undefined) {
          throw new Error("daw_set_tempo needs bpm to place an event — or remove: true to delete the one at this bar.");
        }
        const r = await daw({ action: "set_tempo", slug: slugOf(a.slug), at_bar: a.at_bar, bpm: a.bpm });
        return { tempo_map: r.tempoMap, dirty: r.dirty, updated_at: r.updatedAt };
      },
    },

    {
      name: "daw_render",
      description:
        "Render the project's bar-regions to audio — ONLY the dirty ones. A region whose "
        + "content hash already has a file is a cache hit (cached: true, 0 ms); an edit "
        + "re-renders exactly the regions it dirtied. Each region row carries a wav url "
        + "(content-addressed, immutable) the browser plays gaplessly. from_bar/to_bar "
        + "narrow the window; default is the whole project.",
      inputSchema: {
        type: "object",
        required: ["slug"],
        properties: {
          slug: { type: "string" },
          from_bar: { type: "integer" },
          to_bar: { type: "integer" },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({ action: "render", slug: slugOf(a.slug), from_bar: a.from_bar, to_bar: a.to_bar });
        return {
          sr: r.sr, total_seconds: r.totalSeconds,
          rendered: r.rendered, cached_hits: r.cachedHits, ms: r.ms,
          regions: r.regions.map((g) => ({
            idx: g.idx, bars: `${g.fromBar}-${g.toBar}`,
            t0: g.t0, t1: g.t1, url: g.url, hash: g.hash,
            rendered: g.rendered, cached: g.cached, ms: g.ms,
          })),
        };
      },
    },

    {
      name: "daw_render_plan",
      description:
        "WILL THIS PROJECT MONITOR SMOOTHLY? Renders nothing, costs nothing, and answers per "
        + "region: the estimated milliseconds, the milliseconds of audio that region actually "
        + "covers, and a verdict of ready | tight | late. "
        + "WHY A PROJECT CAN BE LATE AT ALL: a project with a non-default mixer renders through "
        + "the rack, and the rack processes from absolute sample 0 every time — that is the "
        + "determinism rule that makes a region's bytes the bounce's bytes, and it means the SAME "
        + "four bars cost more the deeper into the song they are. Measured on a 128-bar, 7-track, "
        + "5-stateful-insert project: 305 ms for bars 1-4 and 11 068 ms for bars 125-128, against "
        + "7 500 ms of audio per region. So a rolling monitor holds to about bar 64 and misses at "
        + "bar 85, and this tool says which regions before the drop rather than after it. A "
        + "project with a DEFAULT mixer renders the mono path, which is O(window) and flat in "
        + "position: every region comes back ready. "
        + "The estimate is a line fitted to those measurements and then scaled by ONE number this "
        + "machine earned — the median ratio of the region renders it really did to what the line "
        + "predicted, kept in the project's cache dir. `calibration.calibrated: false` means the "
        + "project has not rendered enough regions here yet and you are reading the shipped line. "
        + "A late verdict is a MEASUREMENT, not a failure. "
        + "ASK ABOUT A STRETCH, NOT THE WHOLE SONG. `from_seconds` + `lead_seconds` bound the "
        + "question to the part being played next — which is the only part a monitor can answer "
        + "for, and the reason a whole-song verdict is useless on a chained take: it is red from "
        + "bar one because bar 125 exists. `counts` is then about the window and `song_counts` "
        + "about everything; `beyond_late` names the first late region AFTER the window and "
        + "`beyond_late_count` how many there are, so narrowing the question never hides the "
        + "rest of the answer. The DAW's readiness badge asks exactly this way: the loop range "
        + "when there is one, otherwise the next four regions from the playhead.",
      inputSchema: {
        type: "object",
        required: ["slug"],
        properties: {
          slug: { type: "string" },
          from_seconds: { type: "number", description: "Plan from this point in the song forward. Default 0." },
          lead_seconds: { type: "number", description: "Judge only this many seconds from from_seconds — the stretch about to be played. Omit for the rest of the song." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({ action: "render_plan", slug: slugOf(a.slug),
                              from_seconds: a.from_seconds, lead_seconds: a.lead_seconds });
        return {
          chained: r.chained, counts: r.counts, first_late: r.firstLate,
          from_seconds: r.fromSeconds, lead_seconds: r.leadSeconds,
          song_regions: r.songRegions, song_counts: r.songCounts,
          beyond_late: r.beyondLate, beyond_late_count: r.beyondLateCount,
          model: r.model, calibration: r.calibration, note: r.note, window_note: r.windowNote,
          regions: r.regions.map((g) => ({
            idx: g.idx, bars: `${g.fromBar}-${g.toBar}`, cached: g.cached,
            estimated_ms: g.estimatedMs, deadline_ms: g.deadlineMs, verdict: g.verdict,
          })),
        };
      },
    },

    {
      name: "daw_render_ahead",
      description:
        "Render the ONE region the playhead will be inside `lead_seconds` from `at_seconds` — "
        + "the rolling monitor's single step, for when you want the next thing to be ready "
        + "rather than the whole song re-checked. "
        + "It renders a WHOLE REGION with the full note list, never a cheap bar. That is a "
        + "measured constraint, not caution: rendering bar 65 with only the last four bars of "
        + "history differs from the truth on 48.82 % of its samples at -4.74 dB error-to-signal, "
        + "because a long tail and a compressor envelope reach across, while bar 87 tolerates no "
        + "history at all. There is no safe constant, so the region — whose hash makes its bytes "
        + "the bounce's bytes — is the unit. "
        + "Omit lead_seconds and the lead IS the estimate: it looks ahead by as long as the "
        + "render is expected to take. The reply says `ready` (the bytes arrived inside the "
        + "audio they cover), `ms` against `deadlineMs`, and `aheadRegions` — the run of regions "
        + "already on disk from the playhead forward. A false `ready` is the honest answer for a "
        + "chained project late in the song; call daw_render_plan to see where that starts.",
      inputSchema: {
        type: "object",
        required: ["slug"],
        properties: {
          slug: { type: "string" },
          at_seconds: { type: "number", description: "Where the playhead is now. Default 0." },
          lead_seconds: { type: "number", description: "How far ahead to render. Default: the region's own estimated cost." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({ action: "render_ahead", slug: slugOf(a.slug),
                              at_seconds: a.at_seconds, lead_seconds: a.lead_seconds });
        return {
          ready: r.ready, ms: r.ms, deadline_ms: r.deadlineMs, estimated_ms: r.estimatedMs,
          verdict: r.verdict, at_seconds: r.atSeconds, lead_seconds: r.leadSeconds,
          ahead_regions: r.aheadRegions, calibration: r.calibration,
          region: r.region && {
            idx: r.region.idx, bars: `${r.region.fromBar}-${r.region.toBar}`,
            url: r.region.url, hash: r.region.hash,
            rendered: r.region.rendered, cached: r.region.cached, ms: r.region.ms,
          },
        };
      },
    },

    {
      name: "daw_patches",
      description:
        "THE INSTRUMENT REGISTRY — call this before adding a track. Lists every patch with "
        + "its family, honest quality note, whether it is installed, and its pack's LICENCE and "
        + "attribution text. action: 'list' (default) reads; 'install' fetches a patch's packs "
        + "(samples land outside the repo, under the app-data instruments dir) and 'uninstall' "
        + "removes a pack's files. INSTALL IS LICENCE-GATED: call it without accept_licence and "
        + "nothing downloads — it answers with the licence rows to read first; repeat with "
        + "accept_licence: true to proceed. Attribution-required packs (Salamander CC-BY, AVL "
        + "CC-BY-SA) add a credit line to every render and bounce that uses them — see "
        + "daw_credits. Four patches (sax, sitar, choir, solo_cello) are GENERATE-THIS-PART "
        + "placeholders: they exist, explain why no free sampleset does the family justice, and "
        + "refuse to render locally rather than shipping a weak patch.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "install", "uninstall"], description: "Default 'list'." },
          patch: { type: "string", description: "For install: the patch id to make playable." },
          pack: { type: "string", description: "For uninstall: the pack id to remove." },
          accept_licence: { type: "boolean", description: "Required for install. Without it nothing downloads and the licences are returned instead." },
          family: { type: "string", description: "For list: only patches in this family (piano, drums, strings, bass, winds, mallets, world, vocal, gm, synth)." },
          installed_only: { type: "boolean", description: "For list: only patches that can render right now." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const action = a.action || "list";
        if (action === "install") {
          if (!a.patch) throw new Error("install needs a patch id — call daw_patches with action 'list' to see them.");
          return daw({ action: "install_patch", patch: a.patch, accept_licence: a.accept_licence === true });
        }
        if (action === "uninstall") {
          if (!a.pack) throw new Error("uninstall needs a pack id — the pack.id on any patch row.");
          return daw({ action: "uninstall_pack", pack: a.pack });
        }
        const r = await get("/api/daw/patches");
        let rows = r.patches;
        if (a.family) rows = rows.filter((x) => x.family === a.family);
        if (a.installed_only) rows = rows.filter((x) => x.installed);
        return {
          instruments_dir: r.instrumentsDir,
          patches: rows.map((x) => ({
            id: x.id, family: x.family, label: x.label, kind: x.kind,
            installed: x.installed, quality: x.quality,
            refusal: x.refusal || undefined,
            gm_programs: x.gm_programs || undefined,
            /* The patch's own knobs, compacted: "name min..max (default)".
             * An agent that can read this can set every one of them through
             * daw_add_track / daw_set_track params without a second lookup. */
            params: x.params
              ? Object.entries(x.params).map(([k, s]) =>
                `${k} ${s.min}..${s.max} (${s.default})${s.unit ? " " + s.unit : ""} — ${s.doc}`)
              : undefined,
            /* Named knob settings, as data: send them back as params. */
            presets: x.presets
              ? Object.fromEntries(Object.entries(x.presets).map(([k, p]) =>
                [k, { params: p.params, doc: p.doc }]))
              : undefined,
            pack: x.pack ? {
              id: x.pack.id, mb: x.pack.bytes ? Math.round(x.pack.bytes / 1e6) : null,
              licence: x.pack.licence.name, spdx: x.pack.licence.spdx,
              attribution: x.pack.attribution,
              attribution_required: x.pack.attribution_required,
              source: x.pack.source, installed: x.pack.installed,
              downloading: x.pack.downloading || undefined,
            } : null,
          })),
        };
      },
    },

    {
      name: "daw_credits",
      description:
        "The project's accumulated third-party ATTRIBUTIONS — one row per licensed sample "
        + "pack any of its tracks used, read straight out of the provenance ledger's "
        + "licence_attach events (not a second list that could drift). Every render appends "
        + "these; every bounce embeds them in the exported file's tags. This is the CC-BY "
        + "compliance surface: if a project plays a CC-BY patch and this is empty, that is a bug.",
      inputSchema: {
        type: "object",
        required: ["slug"],
        properties: { slug: { type: "string" } },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({ action: "credits", slug: slugOf(a.slug) });
        return {
          slug: r.slug,
          credits: r.credits,
          attribution_lines: r.credits.map((c) => c.attribution).filter(Boolean),
        };
      },
    },

    {
      name: "daw_bounce",
      description:
        "Render the whole project and write one lossless FLAC or WAV beside it, tagged with the Tier-1 "
        + "AI marker and every attribution line the project owes. Answers with the file path, "
        + "its length, and the credits embedded. Region renders are reused from cache, so a "
        + "bounce right after a render is fast. The reply includes a downloadable URL, format, "
        + "channels, bit depth, dither status, measured loudness-stage result and origin class. "
        + "Licensed sample credits do not imply human authorship. Use daw_check_delivery with the "
        + "same loudness settings to preflight, or pass the final file to it to check the export.",
      inputSchema: {
        type: "object",
        required: ["slug"],
        properties: {
          slug: { type: "string" },
          format: { type: "string", enum: ["flac", "wav"], description: "Lossless export container; default flac." },
          bit_depth: { type: "integer", enum: [16, 24],
            description: "Deliverable bit depth; 24 by default, which is the master itself. "
              + "16 is DITHERED on the way down — an undithered 16-bit bounce is a real "
              + "mastering fault, so this never skips it." },
          target_lufs: { ...LOUDNESS_SCHEMA.target_lufs, description: "The LOUDNESS STAGE, the bounce's second pass: number "
            + "(-30..-6) aims the assembled song at that integrated loudness (gain into a "
            + "-1 dBTP ceiling, at most 3 dB of true-peak limiting, before any dither); null "
            + "switches it off for this bounce. Absent = the project's own master.target_lufs "
            + "(daw_mixer op=set target=master), and when that is absent too the rendered bytes "
            + "exactly. The reply's `loudness` says before/after, gain, limiter work, and - "
            + "honestly - `reached` or the shortfall with why (crest against the allowance)." },
          ceiling_db: LOUDNESS_SCHEMA.ceiling_db,
          max_limit_db: LOUDNESS_SCHEMA.max_limit_db,
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({ action: "bounce", slug: slugOf(a.slug), format: a.format, bit_depth: a.bit_depth,
                              target_lufs: a.target_lufs, ceiling_db: a.ceiling_db, max_limit_db: a.max_limit_db });
        return { file: r.file, name: r.name, url: r.url, format: r.format, seconds: r.seconds,
                 sr: r.sr, channels: r.channels, bit_depth: r.bit_depth, dithered: r.dithered, stereo: r.stereo,
                 target_lufs: r.target_lufs, loudness: r.loudness ?? null, credits: r.credits,
                 ceiling_db: r.ceiling_db, max_limit_db: r.max_limit_db,
                 attribution: r.attribution, tagged: r.tagged, origin: r.origin, ms: r.ms };
      },
    },

    {
      name: "daw_arrange_bigroom",
      description:
        "Write a COMPLETE big-room house arrangement — the 'Animals' SHAPE, with an ORIGINAL melody — "
        + "into a project, as ordinary tracks, clips, notes, inserts and faders, deterministic from a "
        + "seed. It composes the same actions you would call by hand (add_track, add_clip, "
        + "record_notes, insert_add, mixer_set) through the same route, so every step is in the ledger "
        + "and everything it lays down is editable afterwards with the other daw_* tools. "
        + "FORM (bars): intro 8 | build 16 | drop 32 | break 16 | build 16 | drop 32 | outro 8 "
        + "= 128 bars = 4:00 at 128 BPM; `structure` overrides it (each section a multiple of 4 "
        + "bars, at least one drop). "
        + "THE HOOK: the reference names a shape, not a melody to copy, and the arranger reproduces no "
        + "song. From the seed it writes an 8-bar lead in that shape — a 2-4 note cell on the 'and's "
        + "with an octave leap (F4↔F5), call (bars 1-4) and response (bars 5-8, the cell answered on "
        + "the fifth or third pair), rests on every beat so the pump has room, every note held so the "
        + "next kick ducks it and the recovery reads as a swell, ending on the root. Drop 2 plays a "
        + "variant (the response higher, or displaced a 16th onto the 'a'). Same seed, same hook; a "
        + "different seed, a different hook. "
        + "TRACKS: kick (hybrid_kick with its measured `bigroom` preset PLUS `tune` derived from the key "
        + "so its 48 Hz fundamental lands on the root's octave nearest 48 Hz — F: -1.643 semitones → "
        + "43.65 Hz, no 4.4 Hz beat against the sub; every beat, out for the final beat before each "
        + "drop); sub (sub_bass on the kick's rests — the off-beat eighths — carrying the bar's chord "
        + `root in the sub octave, held ${SUB.note_ticks} ticks from the "and" with a `
        + `${SUB.release} ms release and its mid layer at ${SUB.mid_cutoff} Hz so the bass reads on a `
        + "phone); lead (bigroom_lead, the hook); clap+snare (tr909: clap on 2 and 4 at velocity "
        + `${CLAP_VEL}, and the build's snare roll — eighths, then sixteenths, then thirty-seconds, `
        + `${ROLL.from}→${ROLL.to}); hats (tr909 on its OWN track, because a chain and a fader are `
        + "per track: the open hat on every off-beat eighth, accented on the 'and' of 2 and 4, and "
        + "closed hats on the drop's 'e' and 'a'); crash and impact on each drop's downbeat (the impact "
        + "key-tracked to the song's root); riser as ONE note over each build's last 8 bars, ending a "
        + "beat early so the beat before the drop is silent — pitched F4 with cutoff_start 600 Hz and a "
        + "300 Hz high-pass, the MUSICAL MOVE that takes it out of the kick's 120-250 Hz band instead of "
        + "the Ear's kick bell (which cost 1.7 LUFS and 0.8 dB of transient and left the masking). "
        + "MIX: sidechain compressors on lead and sub keyed from the kick track "
        + `(ratio ${SIDECHAIN.ratio}, hard knee, ${SIDECHAIN.attack_ms} ms attack, threshold `
        + `${SIDECHAIN.threshold_db} dB) with release = 3/16 OF A BEAT (60000/bpm × `
        + `${SIDECHAIN_RELEASE_BEATS} = 87.891 ms `
        + "at 128). MEASURED, not reasoned: the first draft argued for one eighth (60000/bpm/2 = "
        + "234.375 ms) and the render showed the gain still 5.9 dB down at the off-beat and never back "
        + "past -2 dB; against the real kick key the compressor is held 12 dB down and 87.9 ms is the "
        + "largest release that is back within 2 dB by the next 'and' (117 ms, a sixteenth, is still "
        + "-3.0). "
        + `EQ high-pass on everything that is not a sub element: lead ${LEAD_CHAIN.eq.hp_hz} Hz, `
        + `clap+snare ${CLAP_CHAIN.eq.hp_hz}, hats ${HATS_EQ.hp_hz} (plus a +${HATS_EQ.b4_gain_db} dB bell at `
        + `${HATS_EQ.b4_hz / 1000} kHz — the 909 open hat is the only voice carrying 8-20 kHz), crash 300 `
        + `and riser ${RISER.hp_hz}; kick, sub and impact untouched (the impact is a sub-drop). The lead's EQ also `
        + "sweeps a low-pass open across each break (500 Hz → 20 kHz, float-bar keys). CHAINS, in signal "
        + "order: lead saturator → chorus → eq → dotted-eighth ping-pong delay → reverb → sidechain; "
        + "sub saturator → sidechain; clap saturator → eq → a short room. "
        + `Faders ${Object.entries(FADERS).map(([n, v]) => `${n} ${v > 0 ? "+" : ""}${v}`).join(", ")} dB `
        + "— the third take's, measured in the rendered drop window with the chains in, by the Ear's "
        + "role targets and masking margins (at lead +2 the lead sat 5.3 dB over its role target and "
        + "masked 1-2 kHz by 12 dB; sub -6 let the kick mask the sub by 8.8 dB in its own band; the "
        + "riser at -10 was masked by the lead by 20.7 dB at 500-1000 Hz, and its fader moves every "
        + "build band by under 0.3 dB). "
        + `A true-peak limiter at ${MASTER.ceiling_db} dBTP on the master, and ONE mixer_set on the master `
        + "strip that turns the rack's STEREO switch on (the lead's 7-voice spread reaches the file "
        + `instead of folding to (L+R)/2) and sets \`target_lufs\` to ${MASTER.target_lufs} LUFS: the `
        + `bounce's second pass gains the assembled song into the ${MASTER.ceiling_db} dBTP ceiling with `
        + "at most 3 dB of limiting and reports `reached` or the shortfall honestly (daw_bounce → loudness). "
        + "It lays into an EMPTY project — omit `slug` and it creates one named `name` — and "
        + "RENDERS NOTHING: call daw_render or daw_bounce next, and pass the returned `roles` "
        + `(track id → ${[...new Set(Object.values(ROLES))].join("/")}) to daw_critique or daw_analyze `
        + "so the Ear judges each track against what it is instead of guessing from its name. " + TIME,
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "An EMPTY existing project to arrange into. Omit to create one." },
          name: { type: "string", description: "Name for the created project (when slug is omitted). Default 'Big room <key> minor #<seed>'." },
          seed: { type: "integer", description: "Chooses the chord progression and the riff's pitches. Same seed, same song. Default 1." },
          key: { type: "string", description: "The root of the MINOR key: C, C#, Db, D … B. Default F (as 'Animals')." },
          tempo: { type: "number", description: "Quarter-note bpm, default 128. The sidechain release follows it (one eighth)." },
          structure: {
            type: "array",
            description: "Override the form: [{type, bars}] with type intro|build|drop|break|outro and bars a multiple of 4; at least one drop; total ≤ 256.",
            items: { type: "object" },
          },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({ action: "arrange_bigroom",
                              slug: a.slug ? slugOf(a.slug) : undefined, name: a.name,
                              seed: a.seed, key: a.key, tempo: a.tempo, structure: a.structure });
        const kickTrack = (r.tracks || []).find((t) => t.name === "kick");
        return {
          slug: r.slug, created: r.created,
          key: `${r.key} ${r.mode}`, tempo: r.tempo, bars: r.bars, seconds: r.seconds,
          structure: r.structure, progression: r.progression,
          hook: r.riff, kick_tune: kickTrack?.params?.tune ?? 0,
          sidechain_release_ms: r.sidechain_release_ms, kick_preset: r.kick_preset,
          tracks: r.tracks.map((t) => ({
            id: t.id, name: t.name, patch: t.patch, role: t.role, fader_db: t.fader,
            clips: t.clips.length, notes: t.notes, inserts: t.inserts.map((i) => i.type),
          })),
          master_inserts: r.master.inserts.map((i) => i.type),
          master: { stereo: r.master.stereo, target_lufs: r.master.target_lufs, ceiling_db: r.master.ceiling_db },
          roles: r.roles, notes: r.notes, steps: r.steps, ms: r.ms, note: r.note,
        };
      },
    },

    {
      name: "daw_ledger",
      description:
        "The project's mutation ledger, newest first — every edit with its author "
        + "(agent | user), the dual-control audit trail. Bounded at 300 entries.",
      inputSchema: {
        type: "object",
        required: ["slug"],
        properties: {
          slug: { type: "string" },
          limit: { type: "integer", description: "How many entries (default 30)." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const full = await get(`/api/daw/project/${encodeURIComponent(slugOf(a.slug))}`);
        return { ledger: (full.project.ledger || []).slice(0, Math.max(1, Number(a.limit) || 30)) };
      },
    },

    /* ── [DAWREC] the capture family ──────────────────────────────────── */

    {
      name: "daw_record",
      description:
        "Drive the recording transport — the SAME path the browser's record button uses. "
        + "ops: arm/disarm a track; start (needs an armed track; bar/beat/tick is the punch-in "
        + "anchor, countin_bars 0-4 counts in using that bar's meter — 7/8 counts in 7); chunk "
        + "(supply little-endian float32 PCM as samples_b64 with a 0-based seq — chunks are "
        + "assembled strictly in order, sample-exact); stop (assembles, applies the calibrated "
        + "latency shift, punch-trims, encodes a lossless FLAC take onto the track's take lane); "
        + "cancel; status (armed tracks, live sessions, per-device latency, recent provenance); "
        + "notes — the MIDI half: land a whole performance of [{bar, beat, tick, dur_ticks, "
        + "pitch, vel}] on a track in ONE call (up to 2000), optionally quantized to a tick grid "
        + "(quantize_ticks: 240 = sixteenths, 480 = eighths, 0 = leave the timing alone). Each "
        + "note joins the clip covering its bar, so the track needs one there. "
        + "Samples must be at the project rate (48000). NOTE the provenance honesty: a capture "
        + "driven over MCP is logged as an agent import of existing audio, never as a human "
        + "performance — only the browser's own mic path earns `record`, and the same rule holds "
        + "for the notes op: an agent posting notes is authoring, not performing. " + TIME,
      inputSchema: {
        type: "object",
        required: ["op"],
        properties: {
          op: { type: "string", enum: ["arm", "disarm", "start", "chunk", "stop", "cancel", "status", "notes"] },
          slug: { type: "string" },
          track: { type: "string", description: "Track id — required for arm/disarm/start/notes." },
          bar: { type: "integer" }, beat: { type: "integer" }, tick: { type: "integer" },
          countin_bars: { type: "integer", description: "0-4, default 1. Meter-aware." },
          device: { type: "string", description: "Input device label — keys the stored latency offset." },
          punch_in: { type: "object", description: "{bar, beat, tick} — keep only samples from here…" },
          punch_out: { type: "object", description: "…to here (exclusive)." },
          rec_id: { type: "string", description: "The session from start — for chunk/stop/cancel." },
          seq: { type: "integer", description: "chunk: 0-based chunk number." },
          samples_b64: { type: "string", description: "chunk: float32 PCM, base64." },
          name: { type: "string", description: "stop: the take's name." },
          notes: {
            type: "array",
            description: "notes: the performance — [{bar, beat, tick, dur_ticks, pitch, vel}], up to 2000.",
            items: { type: "object" },
          },
          quantize_ticks: { type: "integer", description: "notes: snap each onset to this grid, 0..960. 0 (default) keeps the timing as played." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const slug = a.slug ? slugOf(a.slug) : undefined;
        switch (a.op) {
          case "arm": case "disarm":
            return daw({ action: "record_arm", slug, track: a.track, armed: a.op === "arm" });
          case "notes": {
            const r = await daw({ action: "record_notes", slug, track: a.track,
                                  notes: a.notes, quantize_ticks: a.quantize_ticks });
            return { added: r.added?.length ?? 0, quantized: r.quantized, track: r.trackId,
                     notes: r.added, dirty: r.dirty, updated_at: r.updatedAt };
          }
          case "start":
            return daw({ action: "record_start", slug, track: a.track,
                         bar: a.bar, beat: a.beat, tick: a.tick,
                         countin_bars: a.countin_bars, device: a.device,
                         punch_in: a.punch_in, punch_out: a.punch_out });
          case "chunk":
            return daw({ action: "record_chunk_b64", rec_id: a.rec_id, seq: a.seq, samples_b64: a.samples_b64 });
          case "stop":
            return daw({ action: "record_stop", slug, rec_id: a.rec_id, name: a.name });
          case "cancel":
            return daw({ action: "record_stop", slug, rec_id: a.rec_id, cancel: true });
          case "status":
            return daw({ action: "record_status", slug });
          default:
            throw new Error(`unknown op ${a.op}`);
        }
      },
    },

    {
      name: "daw_takes",
      description:
        "The take lane: list a track's takes (placement, seconds, device, attribution); "
        + "audition one (returns its lossless file url plus placement — an agent reads the "
        + "metadata, a human clicks the url); comp — flatten ORDERED picks "
        + "[{take, from_sample, to_sample}] in absolute project samples into ONE audio clip "
        + "on the track (later picks win where they overlap, silence where nothing covers; "
        + "whole_take: <id> comps one take verbatim); delete a take and its file. "
        + "The comp clip renders into the mix; takes themselves never do.",
      inputSchema: {
        type: "object",
        required: ["op", "slug"],
        properties: {
          op: { type: "string", enum: ["list", "audition", "comp", "delete"] },
          slug: { type: "string" },
          track: { type: "string" },
          take: { type: "string", description: "audition/delete: the take id." },
          picks: {
            type: "array",
            description: "comp: ordered picks [{take, from_sample, to_sample}], absolute project samples.",
            items: { type: "object" },
          },
          whole_take: { type: "string", description: "comp: shortcut — one pick covering this whole take." },
          name: { type: "string", description: "comp: the clip's name." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const slug = slugOf(a.slug);
        if (a.op === "list") {
          const full = await get(`/api/daw/project/${encodeURIComponent(slug)}`);
          const tracks = a.track
            ? full.project.tracks.filter((t) => t.id === a.track || t.name === a.track)
            : full.project.tracks;
          return {
            takes: tracks.map((t) => ({
              track: t.id,
              takes: (t.takes || []).map((k) => ({
                id: k.id, name: k.name, at: `${k.bar}.${k.beat}.${k.tick}`,
                shift_samples: k.shiftSamples, samples: k.samples, sr: k.sr,
                seconds: Number((k.samples / k.sr).toFixed(3)),
                device: k.device, by: k.by, file: k.file,
                url: `/api/daw/take/${encodeURIComponent(slug)}/${encodeURIComponent(k.file)}`,
              })),
              audio_clips: (t.audioClips || []).map((c) => ({
                id: c.id, name: c.name, at: `${c.bar}.${c.beat}.${c.tick}`,
                shift_samples: c.shiftSamples, dur_samples: c.durSamples,
                gain_db: c.gainDb, by: c.by, file: c.file,
              })),
            })),
          };
        }
        if (a.op === "audition") {
          const full = await get(`/api/daw/project/${encodeURIComponent(slug)}`);
          for (const t of full.project.tracks) {
            const k = (t.takes || []).find((x) => x.id === a.take);
            if (k) {
              return {
                id: k.id, name: k.name, track: t.id,
                at: `${k.bar}.${k.beat}.${k.tick}`, shift_samples: k.shiftSamples,
                seconds: Number((k.samples / k.sr).toFixed(3)), sr: k.sr, by: k.by,
                url: `/api/daw/take/${encodeURIComponent(slug)}/${encodeURIComponent(k.file)}`,
                note: "Fetch the url for the lossless audio; the browser's take lane plays it on click.",
              };
            }
          }
          throw new Error(`no take ${a.take} in ${slug}`);
        }
        if (a.op === "comp") {
          return daw({ action: "take_comp", slug, track: a.track,
                       picks: a.picks, whole_take: a.whole_take, name: a.name });
        }
        if (a.op === "delete") {
          return daw({ action: "take_delete", slug, track: a.track, take: a.take });
        }
        throw new Error(`unknown op ${a.op}`);
      },
    },

    {
      name: "daw_calibrate",
      description:
        "The latency loop, headless: run the P0-4 estimator over supplied samples "
        + "(samples_b64 — float32 PCM of a mic hearing the calibration chirp) or over a "
        + "server-injected synthetic capture (synthetic_offset_ms — proves the whole wizard "
        + "path with no microphone; recovery is ±1 ms). store writes the per-device offset "
        + "into app settings — record_start then places takes EARLIER by exactly that. "
        + "read returns the stored table. Honesty: the synthetic path proves the pipeline, "
        + "not any actual hardware.",
      inputSchema: {
        type: "object",
        required: ["op"],
        properties: {
          op: { type: "string", enum: ["run", "store", "read"] },
          samples_b64: { type: "string", description: "run: float32 PCM capture, base64." },
          synthetic_offset_ms: { type: "number", description: "run: inject a synthetic capture with this true offset instead of samples." },
          sr: { type: "integer", description: "run: the capture's rate. Default 48000." },
          device: { type: "string", description: "store/read: device label. Default \"default\"." },
          offset_ms: { type: "number", description: "store: the offset to remember." },
          slug: { type: "string", description: "read: any project — offsets are app-level; slug only scopes the status echo." },
        },
        additionalProperties: false,
      },
      async run(a) {
        if (a.op === "run") {
          return daw({ action: "calibrate_b64", samples_b64: a.samples_b64,
                       synthetic_offset_ms: a.synthetic_offset_ms, sr: a.sr });
        }
        if (a.op === "store") {
          return daw({ action: "set_latency", device: a.device, offset_ms: a.offset_ms });
        }
        if (a.op === "read") {
          const r = await daw({ action: "set_latency" });   // no offset_ms = a read
          const table = r.latency || {};
          if (a.slug) {
            const st = await daw({ action: "record_status", slug: slugOf(a.slug) });
            return { latency: table, device: a.device ?? null, status: st };
          }
          return { latency: table, device: a.device ?? null };
        }
        throw new Error(`unknown op ${a.op}`);
      },
    },

    {
      name: "daw_import_audio",
      description:
        "Drop an existing audio file onto a track as a clip — the no-mic capture path, and "
        + "the seam stem-separation will feed. path is a server-local file in any format "
        + "ffmpeg reads (wav/flac/mp3/m4a/ogg); it is decoded to the project rate, stored "
        + "losslessly with stereo channels preserved, and placed at bar.beat.tick (default 1.1.0). "
        + "Over-range float sources keep their headroom in float WAV; otherwise assets use FLAC. "
        + "The result's channels reports the stored channel count. The clip renders into the "
        + "mix like any instrument — the edit answers with the regions it dirtied. Provenance "
        + "logs an import with origin third-party/existing (set declared: \"human-recorded\" "
        + "ONLY when a human states the file is their own recording). " + TIME,
      inputSchema: {
        type: "object",
        required: ["slug", "track", "path"],
        properties: {
          slug: { type: "string" },
          track: { type: "string" },
          path: { type: "string", description: "Server-local audio file to import." },
          bar: { type: "integer" }, beat: { type: "integer" }, tick: { type: "integer" },
          name: { type: "string" },
          gain_db: { type: "number" },
          declared: { type: "string", enum: ["human-recorded"], description: "Only on the human's word." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({ action: "import_audio", slug: slugOf(a.slug), track: a.track,
                              path: a.path, bar: a.bar, beat: a.beat, tick: a.tick,
                              name: a.name, gain_db: a.gain_db, declared: a.declared });
        return { clip: r.clip, url: r.url, seconds: r.seconds, format: r.format, channels: r.channels,
                 peak: r.peak, note: r.note, sr: r.sr, source_channels: r.source_channels,
                 source_sr: r.source_sr, dirty: r.dirty };
      },
    },

    {
      name: "daw_audio_clip",
      description:
        "Move, retrim, re-gain, rename or REMOVE an audio clip — the rows daw_import_audio and "
        + "daw_takes op:comp put on the timeline (daw_takes op:list shows them under audio_clips). "
        + "op 'set' edits any of: the musical anchor (bar/beat/tick), shift_samples — the SIGNED "
        + "sample-exact fine placement on top of that anchor, which is where latency compensation "
        + "lives and where a comp carries its whole absolute start — the trim into the file "
        + "(offset_samples skips into it, dur_samples is how much plays), gain_db and name. "
        + "op 'remove' takes the clip off the timeline and LEAVES THE FILE on disk, because a "
        + "comp's sources may still be worth auditioning; only deleting the project sweeps them. "
        + "Both answer with the regions they dirtied — a move dirties the range it left and the "
        + "range it entered. " + TIME,
      inputSchema: {
        type: "object",
        required: ["op", "slug", "track", "clip"],
        properties: {
          op: { type: "string", enum: ["set", "remove"] },
          slug: { type: "string" },
          track: { type: "string" },
          clip: { type: "string", description: "The audio clip id (aud_… or the id daw_import_audio answered with)." },
          bar: { type: "integer" }, beat: { type: "integer" }, tick: { type: "integer" },
          shift_samples: { type: "integer", description: "Signed sample offset from the musical anchor." },
          offset_samples: { type: "integer", description: "Trim into the file, in samples from its start." },
          dur_samples: { type: "integer", description: "How many samples of the file play." },
          gain_db: { type: "number", description: "-48..+12, on top of the track's gain." },
          name: { type: "string" },
        },
        additionalProperties: false,
      },
      async run(a) {
        const slug = slugOf(a.slug);
        if (a.op === "remove") {
          const r = await daw({ action: "remove_audio_clip", slug, track: a.track, clip: a.clip });
          return { removed: r.removed, dirty: r.dirty, updated_at: r.updatedAt };
        }
        if (a.op !== "set") throw new Error(`unknown op ${a.op} — daw_audio_clip takes "set" or "remove".`);
        const r = await daw({ action: "set_audio_clip", slug, track: a.track, clip: a.clip,
                              bar: a.bar, beat: a.beat, tick: a.tick,
                              shift_samples: a.shift_samples, offset_samples: a.offset_samples,
                              dur_samples: a.dur_samples, gain_db: a.gain_db, name: a.name });
        return { clip: r.clip, dirty: r.dirty, updated_at: r.updatedAt };
      },
    },
    /* CHAIN STAGE: daw_insert / daw_mixer / daw_meters — the rack. */
    ...rackTools({ daw, get, slugOf }),
    /* THE EAR: critique -> cards -> apply -> A/B guard -> review -> approve. */
    ...earTools({ ear, earGet, slugOf }),
    /* THE MASTERING SUITE: analyse -> compare -> deliver. `api` rather than
     * `daw` because every one of these RENDERS the window first, and a
     * whole-song analyse is a render-lane job, not a 2-minute one — the
     * same argument the Ear's own prefix makes above. */
    ...masterTools({ api, slugOf }),
    /* §3 THE VOICE LAB: its tools live beside its routes in server/daw/, and
     * are spread in here so every guard in mcp-daw_test.js covers them too.
     * Optional, like the module itself — a tree without voicelab.js has one
     * fewer tool rather than a broken tool list.
     *
     * `api` travels as well as `daw`: daw_render_stems is a SECOND full graph
     * pass over up to 16 regions and the route gives the engine 600 s per
     * region, so it needs the render lane's timeout rather than the default
     * two minutes — the same argument the mastering suite makes above. A tool
     * that gave up at two minutes would report a failure while the render
     * carried on and landed. */
    ...(voicelabTools ? voicelabTools({ daw, get, api, slugOf }) : []),
    /* §7 THE REFERENCE PROFILE: build / list / get / delete. `daw` and not
     * `api`, because a build's own long wait belongs to the ROUTE (it polls
     * for the stems and answers `pending: true` rather than holding a socket
     * open), so the tool never needs more than the default timeout — which is
     * the difference between this and daw_render_stems above. */
    ...(refprofileTools ? refprofileTools({ daw }) : []),
  ];
}
