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
        return {
          projects: projects.projects,
          engine: probe.error ? { error: probe.error } : {
            instruments: probe.instruments, tails: probe.tails, sr: probe.sr_default,
            tables_agree: JSON.stringify(probe.tails) === JSON.stringify(probe.storeTails),
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
      name: "daw_add_track",
      description:
        "Add a track with one of the prototype instruments: pluck (Karplus-Strong string), "
        + "pad (detuned-saw poly pad), drums (synthesised kit — GM-ish keys: 36 kick, 38 snare, "
        + "42 closed hat, 46 open hat, 49 crash, toms elsewhere). The track arrives with one "
        + "clip spanning the whole project, so daw_add_note works immediately.",
      inputSchema: {
        type: "object",
        required: ["slug", "instrument"],
        properties: {
          slug: { type: "string" },
          instrument: { type: "string", enum: ["pluck", "pad", "drums"] },
          name: { type: "string" },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({ action: "add_track", slug: slugOf(a.slug), instrument: a.instrument, name: a.name });
        return { track_id: r.trackId, clip_id: r.clipId, dirty: r.dirty };
      },
    },

    {
      name: "daw_set_track",
      description:
        "Change a track: name, instrument, gain_db (-48..+12), mute. Every change answers "
        + "with the regions it dirtied — a gain change dirties exactly the regions that track "
        + "sounds in.",
      inputSchema: {
        type: "object",
        required: ["slug", "track"],
        properties: {
          slug: { type: "string" },
          track: { type: "string", description: "Track id (or unambiguous name)." },
          name: { type: "string" },
          instrument: { type: "string", enum: ["pluck", "pad", "drums"] },
          gain_db: { type: "number" },
          mute: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async run(a) {
        return daw({ action: "set_track", slug: slugOf(a.slug), track: a.track,
                     name: a.name, instrument: a.instrument, gain_db: a.gain_db, mute: a.mute });
      },
    },

    {
      name: "daw_add_clip",
      description:
        "Add a clip (a bar-range container for notes) to a track. Only needed when the "
        + "auto-created full-length clip is not enough — clips are how sections get moved later.",
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
      name: "daw_set_meter",
      description:
        "Place a meter event: FROM this bar onward the meter is num/den, until the next "
        + "event. This is the §12 model — 7/8 at bar 17 is one call. Bars before the event "
        + "are untouched (their regions keep their hashes); everything after moves in time "
        + "and is dirtied honestly. den is 1, 2, 4, 8, 16 or 32.",
      inputSchema: {
        type: "object",
        required: ["slug", "at_bar", "num", "den"],
        properties: {
          slug: { type: "string" },
          at_bar: { type: "integer" },
          num: { type: "integer", description: "1-32." },
          den: { type: "integer", description: "1, 2, 4, 8, 16 or 32." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({ action: "set_meter", slug: slugOf(a.slug), at_bar: a.at_bar, num: a.num, den: a.den });
        return { meter_map: r.meterMap, dirty: r.dirty, updated_at: r.updatedAt };
      },
    },

    {
      name: "daw_set_tempo",
      description:
        "Place a tempo event: FROM this bar onward the tempo is bpm (QUARTER-NOTE bpm, "
        + "20-400), until the next event. Mid-song tempo changes are one call.",
      inputSchema: {
        type: "object",
        required: ["slug", "at_bar", "bpm"],
        properties: {
          slug: { type: "string" },
          at_bar: { type: "integer" },
          bpm: { type: "number" },
        },
        additionalProperties: false,
      },
      async run(a) {
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
        + "cancel; status (armed tracks, live sessions, per-device latency, recent provenance). "
        + "Samples must be at the project rate (48000). NOTE the provenance honesty: a capture "
        + "driven over MCP is logged as an agent import of existing audio, never as a human "
        + "performance — only the browser's own mic path earns `record`. " + TIME,
      inputSchema: {
        type: "object",
        required: ["op"],
        properties: {
          op: { type: "string", enum: ["arm", "disarm", "start", "chunk", "stop", "cancel", "status"] },
          slug: { type: "string" },
          track: { type: "string", description: "Track id — required for arm/disarm/start." },
          bar: { type: "integer" }, beat: { type: "integer" }, tick: { type: "integer" },
          countin_bars: { type: "integer", description: "0-4, default 1. Meter-aware." },
          device: { type: "string", description: "Input device label — keys the stored latency offset." },
          punch_in: { type: "object", description: "{bar, beat, tick} — keep only samples from here…" },
          punch_out: { type: "object", description: "…to here (exclusive)." },
          rec_id: { type: "string", description: "The session from start — for chunk/stop/cancel." },
          seq: { type: "integer", description: "chunk: 0-based chunk number." },
          samples_b64: { type: "string", description: "chunk: float32 PCM, base64." },
          name: { type: "string", description: "stop: the take's name." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const slug = a.slug ? slugOf(a.slug) : undefined;
        switch (a.op) {
          case "arm": case "disarm":
            return daw({ action: "record_arm", slug, track: a.track, armed: a.op === "arm" });
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
  ];
}
