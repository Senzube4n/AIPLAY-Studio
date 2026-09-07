/**
 * §7 THE REFERENCE PROFILE's MCP tools: daw_profile_build / list / get / delete.
 *
 * Spread into dawTools() (server/mcp-daw.js) beside rackTools(), earTools(),
 * masterTools() and voicelabTools(), so the declared-and-dropped guard, the
 * daw_ family checks and the `by: "agent"` stamp cover these four exactly as
 * they cover the rest. Every capability calls the SAME /api/daw route the
 * page calls — one door, two hands.
 *
 * ── WHY THIS FILE EXISTS SEPARATELY ──────────────────────────────────────
 * The Voice Lab shipped with three routes, a panel and NO TOOL, past a census
 * that reported 216 passed / 0 failed. server/daw/ui_test.js now fails a
 * route with no tool, and these four were written the same day their routes
 * were — this file is what keeps that gate green rather than a note in a
 * follow-up.
 *
 * ── THE ONE PARAGRAPH AN AGENT MUST READ ─────────────────────────────────
 * A profile is a SHAPE and never a sample. It is built from a track the owner
 * already has a copy of, on this machine, and every number in it is dB,
 * milliseconds or a count. There is no audio in it, no spectrogram frame that
 * could be inverted, no melody and no lyric — refprofile.py refuses to emit
 * anything outside a declared whitelist and refprofile.js re-checks that list
 * before writing. Nothing here downloads a reference and nothing here
 * reproduces one.
 */

/** Stated once, quoted by the tools that need it. */
const SHAPE_TRUTH =
  "A PROFILE IS A SHAPE, NEVER A SAMPLE: dB numbers, times in milliseconds and "
  + "counts. Per stem (drums / bass / other / vocals) and for the mix — loudness, "
  + "level relative to the mix, the Ear's own nine bands, 29 third-octave bands as a "
  + "dB SHARE of the total (so it says nothing about how loud the reference was "
  + "mastered), and stereo width per band. Plus the kick's fundamental, its "
  + "attack/t10/t30/t60 decay, its click-to-body ratio, and the sidechain pump's "
  + "depth and recovery. No audio, no invertible spectrogram frame, no note, no "
  + "melody, no lyric: refprofile.py checks every key it emits against a declared "
  + "whitelist and refuses the rest, and the route re-checks that list before "
  + "writing. Matching a profile makes a mix SIT like that record. It cannot make "
  + "one SOUND like its parts, and it is not a copy of anything.";

const GRID_TRUTH =
  "READ `kick.grid_gated`. Onsets in a finished master are DETECTED, not known, and "
  + "a low-band flux detector also catches snare bodies, toms and 16th-note bass "
  + "movement — on a real track that reads as 442 BPM and every number downstream "
  + "(the decay window, the pump's beat) is then measured against a grid that is not "
  + "the music's. The profiler fits a comb to the peaks and DECLINES when the fit is "
  + "not salient. When it declines, `grid_gated` is false, no period is reported, and "
  + "daw_critique builds no ref_kick_tune, ref_kick_decay or ref_pump card from that "
  + "profile at all. The bands, the levels and the width are unaffected — they never "
  + "depended on a beat.";

export function refprofileTools({ daw }) {
  return [
    {
      name: "daw_profile_build",
      description:
        "Measure a track the owner already has into a REFERENCE PROFILE, so a mix can "
        + "be matched to how it SITS. This is the tool behind \"get us closer to that "
        + "record\".\n"
        + "It separates the file into four stems through the app's own demucs door "
        + "(POST /api/stems — the same idle-drain queue as cover art, so it never "
        + "delays a render) and measures each one. If the stems are already on disk "
        + "nothing is queued and the build takes about half a minute for a three-minute "
        + "track.\n"
        + SHAPE_TRUTH + "\n"
        + "WHERE THE FILE COMES FROM: `file` is a bare filename, either in the output "
        + "root (a track this app made) or in the DAW's own `reference/` folder — which "
        + "is where a copy of somebody else's record goes. Nothing is ever downloaded "
        + "here. A file in `reference/` is copied to the output root under a name "
        + "derived from its own digest for the length of the separation and removed "
        + "again, because the stems door takes a bare filename there.\n"
        + "44.1 kHz IS RESAMPLED TO 48, AND THE PROFILE SAYS SO. rack.k_weight — the "
        + "BS.1770 filter every LUFS number in this program comes from — is pinned at "
        + "48 kHz, and commercial references are overwhelmingly 44.1, so without the "
        + "resample a real reference would have no loudness at all. `resampled_from` "
        + "and `resample_note` travel on every profile that needed it.\n"
        + "IF THE SEPARATION IS STILL QUEUED the reply is `pending: true` with how long "
        + "it waited. Nothing is lost: ask again and the stems will be there.\n"
        + GRID_TRUTH,
      inputSchema: {
        type: "object",
        properties: {
          file: {
            type: "string",
            description: "A bare filename (no slashes) in the output root or in the DAW's "
              + "`reference/` folder. Give this OR stem_dir.",
          },
          stem_dir: {
            type: "string",
            description: "An already-separated folder holding drums/bass/other/vocals — the "
              + "escape hatch for stems made somewhere else. Absolute, server-local.",
          },
          name: { type: "string", description: "What to call the profile. Defaults to the file's name." },
          id: {
            type: "string",
            description: "The id to store it under (lowercase, digits, - and _). Defaults to a "
              + "slug of the name. Re-using an id REPLACES that profile.",
          },
          separate: {
            type: "boolean",
            description: "Queue a separation when the stems are missing. Default true. false "
              + "refuses rather than waits, which is what you want when you only meant to "
              + "profile something that is already separated.",
          },
          wait_ms: {
            type: "integer",
            description: "How long to wait for a queued separation before answering "
              + "`pending: true`. Default 600 000 (ten minutes), max one hour. The wait is on "
              + "the machine's queue, not on demucs: separation itself measured ~12 s for a "
              + "30 s track.",
          },
          sections: {
            type: "boolean",
            description: "Include the coarse energy-shape segmentation (drop / build / body / "
              + "quiet, with each section's nine-band levels). Default true. It is the only "
              + "thing a profile says about structure, and it says it in energy, never in "
              + "notes.",
          },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({
          action: "profile_build", file: a.file, stem_dir: a.stem_dir,
          name: a.name, id: a.id, separate: a.separate,
          wait_ms: a.wait_ms, sections: a.sections,
        });
        if (r.pending) {
          return { built: false, pending: true, source: r.source, demucs: r.demucs,
                   stem_dir: r.stem_dir, note: r.note };
        }
        return {
          built: true, id: r.id, path: r.path, source: r.source, demucs: r.demucs,
          summary: r.summary, warnings: r.warnings,
          resampled_from: r.resampled_from, resample_note: r.resample_note,
          shape_only: r.shape_only,
          build_ms: r.build_ms, ms: r.ms,
          next: "daw_critique with profile: \"" + r.id + "\" adds the ref_* cards; "
            + "daw_profile_get returns the whole curve set.",
        };
      },
    },

    {
      name: "daw_profile_list",
      description:
        "The reference profiles on this machine, as summaries — id, name, length, the "
        + "master's loudness and width, each stem's level, the kick's fundamental and "
        + "decay, the pump, and whether the beat-grid gate held. This is the list "
        + "`daw_critique`'s `profile` argument takes an id from. "
        + SHAPE_TRUTH,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async run() {
        const r = await daw({ action: "profile_list" });
        return { profiles: r.profiles, dir: r.dir, count: (r.profiles || []).length };
      },
    },

    {
      name: "daw_profile_get",
      description:
        "One reference profile, whole: the nine-band balance and the 29 third-octave "
        + "shares for the mix AND for each of the four stems, the width per band, the "
        + "kick's averaged envelope in dB, the pump's averaged curve, and the coarse "
        + "energy sections. Ask for this when you want to reason about the shape "
        + "yourself; `summary` alone is what the cards are built from.\n"
        + "Curves come back decimated to at most 512 points each, which is a cap the "
        + "profiler enforces rather than a convenience: an array long enough to be "
        + "audio is refused whatever it is called. "
        + GRID_TRUTH,
      inputSchema: {
        type: "object",
        required: ["profile"],
        properties: {
          profile: { type: "string", description: "The profile's id (daw_profile_list)." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({ action: "profile_get", profile: a.profile });
        return { summary: r.summary, profile: r.profile };
      },
    },

    {
      name: "daw_profile_delete",
      description:
        "Remove a reference profile from this machine. The stems it was measured from "
        + "are the library's and are not touched — a profile never owned them.",
      inputSchema: {
        type: "object",
        required: ["profile"],
        properties: {
          profile: { type: "string", description: "The profile's id." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({ action: "profile_delete", profile: a.profile });
        return { deleted: r.deleted, note: r.note };
      },
    },
  ];
}
