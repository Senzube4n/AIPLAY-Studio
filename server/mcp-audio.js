/**
 * AUDIO FINISHING — the four routes that existed, worked, and no agent could call.
 *
 * ┌─ FOR THE INTEGRATOR ───────────────────────────────────────────────────┐
 * │ Two lines in server/mcp.js:                                            │
 * │                                                                        │
 * │  1. beside the other imports:                                          │
 * │     import { audioTools } from "./mcp-audio.js";                       │
 * │                                                                        │
 * │  2. inside the TOOLS array, alongside the existing entries:            │
 * │     ...audioTools(api, safeName),                                      │
 * │                                                                        │
 * │ And one line in server/mcp-routes_test.js: this file's name in         │
 * │ MCP_FILES, or the census reports every tool below as unowned.          │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ── WHAT THIS FILE IS FOR ───────────────────────────────────────────────────
 *
 * A coverage audit on 2026-09-21 listed every tool's run() body against the
 * route table and found four live routes with NO tool posting to them:
 *
 *   POST /api/edit             post-generation DSP on a library file
 *   POST /api/merge            a take and its continuations into one song
 *   POST /api/export           format conversion through the engine door
 *   POST /api/timeline/render  a saved timeline composed offline with ffmpeg
 *
 * An agent that can generate a song and cannot top-and-tail it is a strange
 * asymmetry: it can spend six minutes of card on a take and then has no way to
 * remove the four seconds of silence at the front. These tools close it. None
 * of them is new capability — every one is the door the app's own screens have
 * been posting to all along, so there is one implementation of each behaviour
 * and the UI and an agent cannot drift apart.
 *
 * ── THE PROPERTY THAT MAKES EDITING SAFE, AND WHERE IT IS ENFORCED ─────────
 *
 * ⚠ NOTHING HERE OVERWRITES A LIBRARY FILE. server/index.js:5035 reads `src`
 * and writes `edit_<ms>.flac`; /api/merge reads its sources and writes
 * `merge_<ms>.flac` ("Sources are never touched", says the route's own note).
 * VERIFIED by byte comparison on 2026-09-21: a trim of aiplay_00085.flac left
 * the source's sha256 unchanged. That is why none of these tools is classed
 * "destroys" in server/chat/router.js — a bad edit costs a file, not a take.
 *
 * The one thing on this surface that DOES overwrite is audio_render_timeline,
 * and it overwrites only its own output: `mv_<project>.mp4` in the clip folder,
 * the same name every time that project is rendered. Its description says so.
 *
 * ── WHY `with_file` AND NOT `with` ─────────────────────────────────────────
 *
 * edit_audio.py's join and replace take `with` as a PATH ON DISK, and /api/edit
 * forwards the ops array verbatim. An agent has no business knowing where this
 * machine keeps its output folder, and a tool that accepts a raw path is a tool
 * that can be pointed at anything readable. So the schema takes `with_file` — a
 * plain library name, the same one list_songs prints — and this module resolves
 * it against `config.paths.outputDir` from /api/status. The name is checked by
 * safeName() first, so it cannot climb out of that folder.
 */

/**
 * The op table, written once and quoted by audio_edit_song.
 *
 * Taken from server/edit_audio.py's own docstring rather than paraphrased: a
 * description that renames a key is a lie an agent acts on, and these keys are
 * the wire format the Python reads with op.get() and no validation of its own.
 *
 * ⚠ THE ORDER IS LOAD-BEARING. The ops are applied one after another to the
 * running audio, so every time after the first is measured against what the
 * PREVIOUS op left behind. Trim 10-40 then fade out 2 fades the end of the
 * trimmed 30 seconds; fade out 2 then trim 10-40 throws the fade away with the
 * tail it was applied to.
 */
const OPS =
  "OPS, APPLIED IN THE ORDER GIVEN — each one operates on what the one before it left, "
  + "so a trim after a fade discards the fade. Seven kinds:\n"
  + "  trim    {op:\"trim\", start, end}  keep only [start, end) seconds; everything else goes.\n"
  + "  cut     {op:\"cut\", start, end}  remove that section and close the gap, crossfaded 50 ms "
  + "across the seam so the join does not click.\n"
  + "  join    {op:\"join\", with_file, at, from, fade}  splice another library take on at `at` "
  + "seconds: [0, at) of this file, then that one. `from` skips that many seconds off the head of "
  + "the incoming file (a YuE2 continuation is a WHOLE song, so joining it whole plays the shared "
  + "opening twice). `at` is clamped to the length, so a huge value means \"append at the end\". "
  + "`fade` is the crossfade in seconds, default 0.08.\n"
  + "  replace {op:\"replace\", with_file, at, to, from, fade}  new material between two points, the "
  + "original around it. [0, at) and [to, end) are the original AT THE SAME POSITIONS and are "
  + "bit-exact; only the middle changes. Short material lets the original return early rather than "
  + "being stretched.\n"
  + "  fade    {op:\"fade\", fade_in, fade_out}  linear fade of that many seconds at each end.\n"
  + "  reverse {op:\"reverse\"}  the whole thing, backwards.\n"
  + "  speed   {op:\"speed\", rate}  resample. ⚠ PITCH SHIFTS WITH TEMPO, BY DESIGN — this is a "
  + "tape machine, not a time stretch. rate 2 is an octave up and half the length; rate 0.5 is an "
  + "octave down and twice the length. MEASURED 2026-09-21, a 1000 Hz tone through this exact "
  + "code: rate 2.0 came out at 1999.9 Hz in half the time, rate 0.5 at 500.0 Hz in twice, rate "
  + "1.25 at 1250.3 Hz — the pitch scales by the rate, to three decimal places. Pitch-preserving "
  + "stretch would need a phase vocoder, whose artefacts past about 1.2x are worse than the "
  + "effect, so do not ask for one. ⚠ AND SPEEDING UP ALIASES: the resample is a bare "
  + "interpolation with no anti-alias filter, so on real material anything above half of Nyquist "
  + "FOLDS BACK DOWN instead of moving up. MEASURED on a 7.46 s take at rate 2.0: the length "
  + "halved as it should, but the spectral centroid moved 4211 Hz to 4745 Hz rather than doubling "
  + "and the 85% rolloff 10.9 kHz to 14.1 kHz. Slowing down has no such problem (rate 0.5 took "
  + "that take's centroid to 1708 Hz and its rolloff to 4.4 kHz, both scaling with the rate).";

/** Said by both editing tools, because both of them write one. */
const NEW_FILE =
  "The result is a NEW library track (`edit_<timestamp>.flac`) and the source is untouched — "
  + "verified by byte comparison, not by assumption. Returns its filename and its length.";

export function audioTools(api, safeName) {
  /**
   * The two wrappers every tool below goes through.
   *
   * `post` raises the route's own sentence rather than a status code, because
   * these four routes all answer failure with a written explanation — "No saved
   * timeline called X — build it first.", "Pick at least two takes to merge." —
   * and an agent that is told "HTTP 400" has to guess what to do next.
   */
  const post = async (path, body, timeoutMs = 300_000) => {
    const r = await api("POST", path, body, timeoutMs);
    if (r.error) throw new Error(r.error);
    return r;
  };
  const get = async (p) => {
    const r = await api("GET", p);
    if (r.error) throw new Error(r.error);
    return r;
  };

  /* The output folder, asked for once per process. It is a constant of the
   * installation, so re-reading it per op would be one HTTP round trip per
   * splice to learn a string that cannot have changed. */
  let outputDir = null;

  /**
   * A library NAME becomes a path this machine can open — the only place in
   * this file that knows a filesystem exists.
   *
   * ⚠ THE SEPARATOR IS SNIFFED FROM THE FOLDER, NOT TAKEN FROM path.join.
   * The MCP process and the Studio are usually the same machine, but they are
   * not required to be, and node:path would join a Windows outputDir with a
   * forward slash if this process happened to be POSIX. The Python that opens
   * the file runs on the SERVER's side of the wire, so the server's spelling is
   * the one that has to survive.
   */
  const libraryPath = async (name) => {
    if (outputDir === null) {
      const st = await get("/api/status");
      /* ONLY A REAL ANSWER IS REMEMBERED. Memoising an empty string would turn
       * one status reply that happened to arrive without `config.paths` into a
       * permanent refusal for the life of the process, and the caller would be
       * told the Studio cannot say where its library is long after it could. */
      const dir = st?.config?.paths?.outputDir || "";
      if (dir) outputDir = dir;
    }
    if (!outputDir) {
      throw new Error(
        "This Studio did not report its output folder, so a library name cannot be turned into a "
        + "path for `with_file`. Every other op works; join and replace do not.");
    }
    const sep = /^[A-Za-z]:\\|^\\\\/.test(outputDir) ? "\\" : "/";
    return outputDir.replace(/[\\/]+$/, "") + sep + safeName(name, "library file");
  };

  /**
   * One declared op becomes one wire op.
   *
   * Written out per kind, by name, rather than spread. Spreading would be
   * shorter and would defeat the point of declaring the keys at all: the gate
   * lane in server/mcp-audio_test.js asks whether each declared parameter is
   * named in run(), and `{...o}` passes that check while forwarding a typo
   * straight through to a Python that reads with op.get() and silently does
   * nothing. It has also been the failure the other way round — a key declared
   * in a schema and never read — three times in this repository this week.
   *
   * The refusals are here rather than at the route because the route does not
   * have them: edit_audio.py reads `op["start"]` for a cut and raises a
   * KeyError, which reaches the caller as three lines of Python traceback.
   */
  const wireOp = async (o, i) => {
    const where = `ops[${i}]`;
    const num = (v, key) => {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`${where}: ${o.op} needs a number for \`${key}\`.`);
      return n;
    };
    switch (o.op) {
      case "trim": case "cut": {
        if (o.start === undefined || o.end === undefined) {
          throw new Error(`${where}: ${o.op} needs \`start\` and \`end\` in seconds.`);
        }
        const start = num(o.start, "start"), end = num(o.end, "end");
        if (end <= start) {
          throw new Error(`${where}: ${o.op} was given end ${end} which is not after start ${start}.`);
        }
        return { op: o.op, start, end };
      }
      case "join": {
        if (!o.with_file) throw new Error(`${where}: join needs \`with_file\` — the library take to splice on.`);
        const w = { op: "join", with: await libraryPath(o.with_file) };
        if (o.at !== undefined) w.at = num(o.at, "at");
        if (o.from !== undefined) w.from = num(o.from, "from");
        if (o.fade !== undefined) w.fade = num(o.fade, "fade");
        return w;
      }
      case "replace": {
        if (!o.with_file) throw new Error(`${where}: replace needs \`with_file\` — the library take to drop in.`);
        if (o.at === undefined || o.to === undefined) {
          throw new Error(`${where}: replace needs \`at\` and \`to\` — the two points the new material goes between.`);
        }
        const w = { op: "replace", with: await libraryPath(o.with_file), at: num(o.at, "at"), to: num(o.to, "to") };
        if (o.from !== undefined) w.from = num(o.from, "from");
        if (o.fade !== undefined) w.fade = num(o.fade, "fade");
        return w;
      }
      case "fade": {
        if (o.fade_in === undefined && o.fade_out === undefined) {
          throw new Error(`${where}: fade needs \`fade_in\`, \`fade_out\` or both, in seconds.`);
        }
        /* The wire spelling is `in` and `out`, which are a reserved word and a
         * near-miss for one. The schema spells them fade_in / fade_out for the
         * agent's sake; the rename happens here, once. */
        const w = { op: "fade" };
        if (o.fade_in !== undefined) w.in = num(o.fade_in, "fade_in");
        if (o.fade_out !== undefined) w.out = num(o.fade_out, "fade_out");
        return w;
      }
      case "reverse":
        return { op: "reverse" };
      case "speed": {
        if (o.rate === undefined) throw new Error(`${where}: speed needs \`rate\` (2 is twice as fast and an octave up).`);
        const rate = num(o.rate, "rate");
        if (rate <= 0) throw new Error(`${where}: speed needs a rate above zero; ${rate} would produce no audio.`);
        return { op: "speed", rate };
      }
      default:
        throw new Error(
          `${where}: "${o.op}" is not an op. The seven are trim, cut, join, replace, fade, reverse, speed.`);
    }
  };

  return [
    {
      name: "audio_edit_song",
      description:
        "Edit a finished track in the library: trim it, cut a section out, fade it, reverse it, "
        + "change its speed, splice another take onto it or drop new material into the middle. "
        + "Pure DSP on the file — no model runs, nothing is generated, and the graphics card is "
        + "not asked for anything. This is the finishing step after make_song: the take is right "
        + "and the first four seconds are silence.\n"
        + NEW_FILE + "\n"
        + OPS,
      inputSchema: {
        type: "object",
        required: ["file", "ops"],
        properties: {
          file: {
            type: "string",
            description: "The library track to edit, as list_songs prints it (e.g. aiplay_00085.flac).",
          },
          ops: {
            type: "array",
            description: "One or more ops, applied in this order. See the op table in the description.",
            items: {
              type: "object",
              required: ["op"],
              properties: {
                op: { type: "string", enum: ["trim", "cut", "join", "replace", "fade", "reverse", "speed"] },
                start: { type: "number", description: "Seconds. trim and cut." },
                end: { type: "number", description: "Seconds. trim and cut." },
                with_file: {
                  type: "string",
                  description: "Another LIBRARY track by name, for join and replace. Not a path — this "
                    + "tool resolves it against the Studio's own output folder.",
                },
                at: { type: "number", description: "Seconds. Where join splices, and where replace's new material starts." },
                to: { type: "number", description: "Seconds. Where replace's new material ends and the original returns." },
                from: {
                  type: "number",
                  description: "Seconds to skip off the HEAD of with_file, for join and replace. A YuE2 "
                    + "continuation is a whole song; `from` is how you avoid playing the shared opening twice.",
                },
                fade: { type: "number", description: "Crossfade in seconds at a join or replace seam. Default 0.08." },
                fade_in: { type: "number", description: "Seconds, for the fade op. Sent to the route as `in`." },
                fade_out: { type: "number", description: "Seconds, for the fade op. Sent to the route as `out`." },
                rate: { type: "number", description: "For speed. 2 is twice as fast AND an octave up; 0.5 is half speed and an octave down." },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      async run(a) {
        if (!Array.isArray(a.ops) || !a.ops.length) {
          throw new Error("Give at least one op — an edit with no ops would copy the file and change nothing.");
        }
        const ops = [];
        for (let i = 0; i < a.ops.length; i++) ops.push(await wireOp(a.ops[i], i));
        const r = await post("/api/edit", { file: safeName(a.file, "track"), ops });
        return { file: r.file, seconds: r.seconds, sample_rate: r.rate, source: a.file, ops_applied: ops.length };
      },
    },

    {
      name: "audio_trim_song",
      description:
        "Top and tail a track: keep the seconds between `start` and `end` and fade the new edges. "
        + "The flat form of audio_edit_song's commonest job, and the same two ops the Music page's "
        + "own editor sends when a person drags a selection and presses Apply — trim FIRST, then "
        + "fade, so the fade lands on the edges the trim just made.\n"
        + "With `cut` true the selection is REMOVED instead of kept and the gap is closed with a "
        + "50 ms crossfade, which is the editor's other mode.\n"
        + NEW_FILE,
      inputSchema: {
        type: "object",
        required: ["file", "start", "end"],
        properties: {
          file: { type: "string", description: "The library track, as list_songs prints it." },
          start: { type: "number", description: "Seconds. The first moment kept (or, with cut, the first moment removed)." },
          end: { type: "number", description: "Seconds. The moment after the last one kept (or removed)." },
          cut: {
            type: "boolean",
            description: "Remove the selection instead of keeping it, closing the gap. Default false.",
          },
          fade_in: { type: "number", description: "Seconds of fade at the start of the result. Default 0." },
          fade_out: { type: "number", description: "Seconds of fade at the end of the result. Default 0." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const start = Number(a.start), end = Number(a.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
          throw new Error(`\`end\` must be a number after \`start\`; got start ${a.start}, end ${a.end}.`);
        }
        const ops = [{ op: a.cut ? "cut" : "trim", start, end }];
        /* The fade is a SECOND op rather than a parameter of the trim, because
         * the route has no such parameter — and it goes after, for the reason
         * the op table gives: applied first it would fade a stretch the trim
         * then throws away. */
        const fadeIn = Number(a.fade_in) || 0, fadeOut = Number(a.fade_out) || 0;
        if (fadeIn > 0 || fadeOut > 0) ops.push({ op: "fade", in: fadeIn, out: fadeOut });
        const r = await post("/api/edit", { file: safeName(a.file, "track"), ops });
        return {
          file: r.file, seconds: r.seconds, sample_rate: r.rate, source: a.file,
          kept: a.cut ? null : `${start}-${end}`, removed: a.cut ? `${start}-${end}` : null,
        };
      },
    },

    {
      name: "audio_merge_takes",
      description:
        "Join a take and its continuations into ONE song, in the order given.\n"
        + "⚠ EXTENDING BUILDS A TREE, NOT A CHAIN, and this tool is the reason that matters. Every "
        + "extend_* file is already a COMPLETE song — its parent plus that continuation — so "
        + "extending one take three times gives three complete alternatives that all share an "
        + "opening. Concatenating them would play that opening three times. This takes the first "
        + "file whole and every later one only from its own resume point, so each piece of music "
        + "appears exactly once.\n"
        + "Give the files in playing order, first branch first. At least two. The sources are never "
        + "touched; the result is a new library track (`merge_<timestamp>.flac`) and it is queued "
        + "for cover art like any other, which is the one thing here that reaches the graphics card.",
      inputSchema: {
        type: "object",
        required: ["files"],
        properties: {
          files: {
            type: "array",
            description: "Two or more library track names, in playing order. list_songs prints them.",
            items: { type: "string" },
          },
        },
        additionalProperties: false,
      },
      async run(a) {
        const files = (Array.isArray(a.files) ? a.files : []).filter(Boolean).map((f) => safeName(f, "track"));
        if (files.length < 2) {
          throw new Error("Give at least two takes to merge — merging one file with nothing is a copy.");
        }
        const r = await post("/api/merge", { files });
        return { file: r.file, seconds: r.seconds, sample_rate: r.rate, merged: r.merged, sources: files };
      },
    },

    {
      name: "audio_export_formats",
      description:
        "What this Studio can convert a track INTO, read from the engine's own encoder table rather "
        + "than a typed-out list: each format with the quality values its node accepts and whether "
        + "it is lossy. Call it before audio_export_song rather than guessing a quality string.\n"
        + "⚠ WAV IS NOT ON THIS LIST AND THAT IS MEASURED, NOT AN OVERSIGHT. The encoder node takes "
        + "a dynamic combo that cannot be validated statically, so `wav` is ACCEPTED and then fails "
        + "at execution having written nothing. See server/exportAudio.js.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async run() {
        const d = await get("/api/export/formats");
        return d;
      },
    },

    {
      name: "audio_export_song",
      description:
        "Convert a finished track to another container: mp3, opus or flac. Call audio_export_formats "
        + "first for the quality values each one takes.\n"
        + "The conversion is a two-node graph through the engine door, so it is a real render this "
        + "machine performed on the user's audio and it is recorded as one — the run is in the "
        + "engine ledger, and the provenance event names the ACTOR that asked. An export driven "
        + "through MCP is filed as that agent, not as the user.\n"
        + "The file lands in the engine's `exports` subfolder rather than the library: an export is "
        + "the same song in another container, not a new asset, and filing it would put a second row "
        + "in the library for one song. Its tags are re-stamped from the source afterwards, because "
        + "the encoder writes a fresh container and the original's tags do not survive it.\n"
        + "Converting a track to the format it already is is refused rather than silently copied.",
      inputSchema: {
        type: "object",
        required: ["file", "format"],
        properties: {
          file: { type: "string", description: "The library track, as list_songs prints it." },
          format: { type: "string", enum: ["mp3", "opus", "flac"], description: "The container to write." },
          quality: {
            type: "string",
            description: "One of the values audio_export_formats lists for this format (mp3: V0, 128k, "
              + "320k; opus: 64k...320k). Ignored for flac, which is lossless. An unrecognised value "
              + "falls back to the highest rather than failing.",
          },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await post("/api/export", {
          file: safeName(a.file, "track"), format: a.format, quality: a.quality,
        }, 600_000);
        return {
          file: r.file, subfolder: r.subfolder, seconds: r.seconds,
          run_id: r.runId, provenance: r.provenance, source: a.file, format: a.format,
        };
      },
    },

    {
      name: "audio_render_timeline",
      description:
        "Render a SAVED Studio timeline to an mp4 file, offline, with ffmpeg. Project names come "
        + "from list_projects; an unknown one is refused by name.\n"
        + "⚠ THIS IS NOT STUDIO'S EXPORT BUTTON, AND THE DIFFERENCE IS THE POINT. That button "
        + "captures the canvas with MediaRecorder in REAL TIME — a 148-second video costs 148 "
        + "seconds — and measured on this card the draw path sustains 17 fps against a requested "
        + "24, so every export judders. This composes from the source clips at exactly the "
        + "timeline's fps, in about four seconds per forty-four of video: a three-and-a-half-minute "
        + "film is roughly forty seconds. It encodes with h264_nvenc and falls back to libx264 if "
        + "the hardware encoder refuses, so it does take the card.\n"
        + "⚠ IT OVERWRITES ITS OWN OUTPUT. The file is `mv_<project>.mp4` in the clip folder, the "
        + "same name every time that project is rendered, so a second render replaces the first. "
        + "Nothing else is touched.\n"
        + "⚠ A BEAT PULSE NEEDS BOTH HALVES. `beat_zoom` is an amplitude and `beats_file` is the "
        + "tempo it pulses against; one without the other is refused here rather than silently "
        + "rendered flat. get_beats writes the beats file.\n"
        + "Returns the clip name, its length, how many clips were used and which were missing.",
      inputSchema: {
        type: "object",
        required: ["project"],
        properties: {
          project: {
            type: "string",
            description: "The saved project's NAME as list_projects prints it (e.g. \"Hex Appeal — video\").",
          },
          fade: {
            type: "number",
            description: "Cross-dissolve between clips, in seconds. 0 to 2; 0 (the default) is hard cuts.",
          },
          beat_zoom: {
            type: "number",
            description: "How far the picture pushes in on a beat. 0 to 0.08; 0.015 is a visible but "
              + "unobtrusive pulse. Needs beats_file.",
          },
          beats_file: {
            type: "string",
            description: "The beat analysis for the song, by name in the output folder — get_beats "
              + "writes one. Needs beat_zoom.",
          },
        },
        additionalProperties: false,
      },
      async run(a) {
        /* BOTH HALVES OR NEITHER, refused here as well as at the route. The
         * route's own refusal is the backstop and it is a good sentence; this
         * one exists so a caller who sent `beat_zoom` alone learns what is
         * missing without spending a round trip on a 400, and so the pair is
         * visible in the schema's own error rather than only on the wire. */
        const beatZoom = Number(a.beat_zoom) || 0;
        if (beatZoom > 0 && !a.beats_file) {
          throw new Error(
            "A beat pulse needs `beats_file` as well as `beat_zoom` — an amplitude with no tempo has "
            + "nothing to pulse against. Run get_beats on the song first, or omit both for no pulse.");
        }
        if (a.beats_file && !beatZoom) {
          throw new Error(
            "A beat pulse needs `beat_zoom` as well as `beats_file` — a tempo with no amplitude is a "
            + "pulse of zero, which renders flat and looks like a bug. Try beat_zoom 0.015.");
        }
        const r = await post("/api/timeline/render", {
          project: a.project,
          fade: Number(a.fade) || 0,
          beat_zoom: beatZoom,
          beats_file: a.beats_file ? safeName(a.beats_file, "beats file") : undefined,
        }, 1_800_000);
        return {
          clip: r.name, out: r.out, seconds: r.total, width: r.w, height: r.h, fps: r.fps,
          clips_used: r.clips, missing: r.missing, has_song: r.song, encoder: r.encoder, bytes: r.bytes,
        };
      },
    },
  ];
}
