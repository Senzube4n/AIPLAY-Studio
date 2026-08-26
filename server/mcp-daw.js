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
/** The per-track instrument params, quoted by both track tools. */
const PARAMS =
  "Instrument params (all optional): transpose (semitones, -48..48), gain_db (-24..24), "
  + "and — for the GeneralUser GS bank only — program (0..127, the GM program number) "
  + "and drum_kit (true for the GM drum bank). Params are part of the region hash, so "
  + "changing one re-renders exactly the regions that patch sounds in.";

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
    tracks: full.project.tracks.map((t) => ({
      id: t.id, name: t.name, instrument: t.instrument,
      gain_db: t.gainDb, mute: t.mute,
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
        + "dirtied, and no ledger entry is made. HONEST ABOUT WHAT IT IS NOT: this is a round "
        + "trip through the server, not low-latency monitoring — expect tens of milliseconds.",
      inputSchema: {
        type: "object",
        required: ["slug", "track", "pitch"],
        properties: {
          slug: { type: "string" },
          track: { type: "string", description: "Track id (or unambiguous name) — its patch is what you hear." },
          pitch: { type: "integer", description: "MIDI 0-127." },
          vel: { type: "integer", description: "1-127. Default 100." },
          dur_ticks: { type: "integer", description: "960 = one beat. Default 480; the patch's tail is added on top." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({ action: "preview_note", slug: slugOf(a.slug), track: a.track,
                              pitch: a.pitch, vel: a.vel, dur_ticks: a.dur_ticks });
        return { url: r.url, patch: r.patch, params: r.params, pitch: r.pitch, vel: r.vel,
                 dur_ticks: r.dur_ticks, seconds: r.seconds, cached: r.cached, note: r.note };
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
        "Render the whole project and write ONE 24-bit FLAC beside it, tagged with the Tier-1 "
        + "AI marker and every attribution line the project owes. Answers with the file path, "
        + "its length, and the credits embedded. Region renders are reused from cache, so a "
        + "bounce right after a render is fast.",
      inputSchema: {
        type: "object",
        required: ["slug"],
        properties: { slug: { type: "string" } },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({ action: "bounce", slug: slugOf(a.slug) });
        return { file: r.file, seconds: r.seconds, credits: r.credits,
                 attribution: r.attribution, tagged: r.tagged, ms: r.ms };
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
        + "losslessly, and placed at bar.beat.tick (default 1.1.0). The clip renders into the "
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
        return { clip: r.clip, url: r.url, seconds: r.seconds, format: r.format, dirty: r.dirty };
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
  ];
}
