/**
 * DAW — THE VOICE LAB's MCP tools: daw_voice_lab, daw_render_stems, daw_peaks.
 *
 * Spread into dawTools() (server/mcp-daw.js) beside rackTools(), earTools()
 * and masterTools(), so the declared-and-dropped guard, the daw_ family
 * checks and the `by: "agent"` stamp cover these three exactly as they cover
 * the rest. Every capability calls the SAME /api/daw route the page calls —
 * one document, two hands.
 *
 * ── WHY THIS FILE EXISTS, AND WHAT ITS ABSENCE COST ──────────────────────
 * `voice_lab`, `render_stems` and `peaks` shipped with a route and a panel
 * and NO TOOL. Three capabilities a person could reach and an agent could
 * not, past a census that reported 216 passed / 0 failed — because the DAW's
 * census only ever checked route→page, and mcp-daw_test.js's mirror gate
 * scrapes routes.js + ear.js + MIXER_ACTIONS and had never heard of the
 * voicelab mount. server/daw/ui_test.js now fails a route with no tool.
 *
 * ── WHAT THE THREE ARE FOR, IN ONE LINE EACH ─────────────────────────────
 *  daw_voice_lab     hear one note of one instrument, and MEASURE it — with
 *                    knob values the document is never told about.
 *  daw_render_stems  the per-track buses of a region, out of the same graph
 *                    the mix came from.
 *  daw_peaks         the waveform, at a zoom, without decoding a wav.
 *
 * All three are READ-ONLY on the document. Not one of them writes a note, a
 * param, a ledger row or an updatedAt — which is what makes the Voice Lab a
 * place to try things rather than a place to accumulate undo history.
 */

/** Stated once, quoted by the two tools whose cost depends on it. */
const PREFIX_COST =
  "COST: a chained project renders from absolute sample 0 every time (the "
  + "determinism rule), so this costs O(everything before it), not O(the "
  + "window). Measured on a 128-bar, 7-track project with stateful inserts: "
  + "322 ms for a bar at bar 1 and 5 893 ms for the same bar at bar 125. Ask "
  + "for the bars you need, not the song.";

/** Also stated once: what a stem is, and what it is not. */
const STEM_TRUTH =
  "A stem is buses['tracks'][id] from rack.chain_graph(capture=True): the "
  + "POST-FADER, post-pan, post-insert stereo bus of one track, out of THE "
  + "SAME graph the mix comes from. Nothing is re-synthesised and there is no "
  + "second signal path. Two consequences the reply measures rather than "
  + "asserts: all track stems PLUS the separate shared-return files sum to the PRE-MASTER mix "
  + "within float32 rounding. Each region includes `returns`, `exported_complete` and "
  + "`exported_residual_db` when freshly rendered; residual_db describes exact internal buses. "
  + "Shared returns include the whole mix's sends even for a track subset. master_delta_db says how far "
  + "the mastered output sits above it — so the lanes do NOT add up to what "
  + "you hear at the limiter.";

export function voicelabTools({ daw, api, slugOf }) {
  /* THE RENDER LANE'S TIMEOUT for the one tool that renders a window rather
   * than a note. render_stems is a full second graph pass over up to 16
   * regions and the route gives the engine 600 s per region; a tool that
   * gave up at the default two minutes would report a failure while the
   * render carried on and landed — the exact shape of the abandoned-render
   * bug the VACE runner was given a 90-minute deadline for. */
  const dawSlow = api
    ? async (body) => {
      const r = await api("POST", "/api/daw", { ...body, by: "agent" }, 1_800_000);
      if (r.error) throw new Error(r.error);
      return r;
    }
    : daw;

  return [
    {
      name: "daw_voice_lab",
      description:
        "ONE NOTE of one track's instrument, rendered and MEASURED — the tool for "
        + "\"what does this lead actually sound like if I open the filter?\" without "
        + "touching the song. "
        + "Renders the track's real patch at its real params, answers a URL, and "
        + "(with analysis) the picture: per-channel min/max peaks, the Ear's OWN "
        + "nine bands plus a 1/3-octave curve, and a dB envelope with t10/t30/t60 — "
        + "the three numbers that make \"a shorter kick\" a knob rather than an "
        + "adjective. The knob rack comes back too, as `param_schema`, straight "
        + "from patches.json.\n"
        + "`params_override` IS THE POINT: those values are rendered and NOT "
        + "written — no ledger row, no dirty region, no undo entry, updatedAt "
        + "unmoved. They ride the cache key, so a knob you come back to answers "
        + "from disk. Sweep a filter across ten values and the document has not "
        + "changed once; when one of them is right, daw_set_track writes it.\n"
        + "THE PATH MATTERS, and the default is mono. With neither flag this is "
        + "byte-for-byte the same file daw_preview_note renders (the P0 mono job), "
        + "so a WIDTH knob — bigroom_lead.spread, tr808.spread, tr909.spread, "
        + "tr909.hat_width — cannot be seen in it at all: L, R and mid are one "
        + "signal. Pass stereo: true for those. `through_chain: true` adds the "
        + "track's own inserts, fader and pan, but never the master chain or the "
        + "sends — a limiter set for the mix would show you the limiter instead of "
        + "the instrument.\n"
        + "Cheap by measurement: 4-12 ms of DSP per note warm, 13-56 ms for the "
        + "whole round trip including the analysis. Capped at 10 s of audio "
        + "(duration plus the patch's tail) so the short-job lane stays short; the "
        + "refusal names the ceiling and the real length.",
      inputSchema: {
        type: "object",
        required: ["slug", "track"],
        properties: {
          slug: { type: "string" },
          track: { type: "string", description: "Track id (or unambiguous name)." },
          pitch: { type: "integer", minimum: 0, maximum: 127,
                   description: "MIDI note. Default 60 (middle C)." },
          vel: { type: "integer", minimum: 1, maximum: 127, description: "Default 100." },
          dur_ticks: { type: "integer",
                       description: "Note length in ticks of the beat (960 = one beat). "
                         + "Default 480. The rendered file is this plus the patch's tail." },
          params_override: {
            type: "object", additionalProperties: true,
            description: "Knob values to render with, NOT written to the document. "
              + "Merged over the track's own params and normalised by the same table "
              + "the store uses, so a knob at its declared default hashes as "
              + "untouched. Names come from `param_schema` / daw_patches; anything "
              + "the patch does not declare is dropped.",
          },
          stereo: { type: "boolean",
                    description: "Render through the rack with a NO-OP chain — the only "
                      + "path to the two-channel instrument stage. Required to see any "
                      + "width knob move." },
          through_chain: { type: "boolean",
                           description: "Stereo, plus this track's own inserts, fader and "
                             + "pan. Not the master chain, not the sends." },
          analysis: { type: "boolean",
                      description: "Add peaks, spectrum and envelope, measured server-side "
                        + "so nothing decodes a wav to draw a picture." },
          columns: { type: "integer", minimum: 16, maximum: 4000,
                     description: "Envelope/peak columns in the analysis. Default 900 — the "
                       + "panel sends one per pixel of the canvas it draws into." },
          genre: { type: "string",
                   description: "Taste profile for the spectrum's targets. Default neutral." },
          third_octave: { type: "boolean",
                          description: "false drops the 1/3-octave curve (a smaller reply)." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({
          action: "voice_lab", slug: slugOf(a.slug), track: a.track,
          pitch: a.pitch, vel: a.vel, dur_ticks: a.dur_ticks,
          params_override: a.params_override,
          stereo: a.stereo, through_chain: a.through_chain,
          analysis: a.analysis, columns: a.columns, genre: a.genre,
          third_octave: a.third_octave,
        });
        return {
          url: r.url, file: r.file, seconds: r.seconds,
          track: r.track, patch: r.patch,
          pitch: r.pitch, vel: r.vel, dur_ticks: r.dur_ticks,
          params: r.params, params_base: r.params_base,
          params_overridden: r.params_overridden,
          document_untouched: r.document_untouched,
          param_schema: r.param_schema,
          path: r.path, stereo: r.stereo, through_chain: r.through_chain,
          path_note: r.path_note,
          cached: r.cached, render_ms: r.render_ms, ms: r.ms,
          lane: r.lane, lane_note: r.lane_note,
          analysis: r.analysis,
          note: r.note,
        };
      },
    },

    {
      name: "daw_render_stems",
      description:
        "THE PER-TRACK AUDIO of a bar range — one wav per track plus separate shared-return wavs, from the same "
        + "graph pass the mix comes from. The artefact the Ear has been computing "
        + "in memory and throwing away since it shipped, written down and served. "
        + "An agent that can fetch one track's audio can answer questions the mix "
        + "cannot: is the sub actually under the kick, is the clap what is eating "
        + "the top end, did that insert do anything at all.\n"
        + STEM_TRUTH + "\n"
        + "NAMED FOR THE REGION: reg<idx>_<region hash>_trk_<track id>.wav, keyed "
        + "and reg<idx>_<region hash>_ret_<return id>.wav, keyed by the SAME hash the region render is, so a stem is invalidated by "
        + "exactly the edits that invalidate its region and by no others. Served "
        + "from /api/daw/audio/<slug>/<name>, and readable at any zoom with "
        + "daw_peaks.\n"
        + "A STEM EXISTS ONLY FOR A TRACK THAT SOUNDS IN THE REGION — the engine "
        + "writes one bus per track with a note or audio clip in the job — so a track that is "
        + "silent in these bars comes back in `silent_tracks` rather than as a "
        + "missing file. That is also the cache rule: ask twice for the same bars "
        + "and the second call renders nothing.\n"
        + "LAZY, AND IT COSTS. This is a SECOND full graph pass — it costs what "
        + "rendering those bars costs, again — which is why nothing renders until "
        + "you ask. " + PREFIX_COST + " Capped at 16 regions (64 bars) a call.\n"
        + "It cannot move a region hash: this is a separate job with a separate "
        + "output, and on a default-mixer project the rack path is forced (a "
        + "default mixer is a no-op chain, so nothing audible changes) because the "
        + "mono job carries no track_id to separate.",
      inputSchema: {
        type: "object",
        required: ["slug"],
        properties: {
          slug: { type: "string" },
          from_bar: { type: "integer", description: "Default 1." },
          to_bar: { type: "integer", description: "Default: the last bar." },
          tracks: {
            type: "array", items: { type: "string" },
            description: "Only these tracks (ids or unambiguous names). Default: every "
              + "audible track. A subset is cheaper to write but reports exported_complete:false "
              + "if it omits a sounding track. Separate return files still contain the entire mix's sends.",
          },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await dawSlow({
          action: "render_stems", slug: slugOf(a.slug),
          from_bar: a.from_bar, to_bar: a.to_bar, tracks: a.tracks,
        });
        return {
          slug: r.slug, from_bar: r.from_bar, to_bar: r.to_bar,
          tracks: r.tracks,
          regions: (r.regions || []).map((x) => ({
            idx: x.idx, bars: `${x.fromBar}-${x.toBar}`, hash: x.hash,
            cached: x.cached, ms: x.ms,
            silent_tracks: x.silent_tracks,
            sums_to_mix: x.sums_to_mix, residual_db: x.residual_db,
            exported_complete: x.exported_complete, exported_residual_db: x.exported_residual_db,
            master_delta_db: x.master_delta_db,
            stems: x.stems,
            returns: x.returns,
            silent_disagreement: x.silent_disagreement,
          })),
          rendered: r.rendered, cached: r.cached, ms: r.ms,
          /* [DAWREC] which lanes carry a recorded or imported take. The route
           * used to answer the opposite fact — that NO lane could, because the
           * rack rendered notes only — and never forwarded it, so an agent
           * reading stems had no way to learn a clip was missing from all of
           * them. It is in the buses now, and the fact travels. */
          audio_clip_tracks: r.audio_clip_tracks,
          forced_chain: r.forced_chain, forced_chain_note: r.forced_chain_note,
          sums_to: r.sums_to, cache_rule: r.cache_rule, cost_note: r.cost_note,
          silent_disagreement: r.silent_disagreement,
          silent_disagreement_note: r.silent_disagreement_note,
          zoom: "daw_peaks reads any of these files at any zoom without decoding it.",
        };
      },
    },

    {
      name: "daw_peaks",
      description:
        "THE WAVEFORM of a render, at a zoom — min AND max per peak, per channel, "
        + "from a four-stage mip-map built once per file and valid forever "
        + "(every name it serves is content-addressed, so there is nothing to "
        + "invalidate). Stages are 8 / 64 / 512 / 4 096 samples a peak; ask by "
        + "`samples_per_pixel` and the coarsest stage that still gives a peak per "
        + "pixel is chosen, or name a `stage` yourself.\n"
        + "MIN AND MAX, NOT AN ENVELOPE: a rectified |max| hides asymmetry and DC, "
        + "which are two of the things you would look at a waveform to find. Both "
        + "channels, always — a mono fold cannot show a width move.\n"
        + "Values decode as int16 x scale / 32767. `scale` is PER FILE because a "
        + "post-fader stem can be louder than 1.0 and clamping it to 1.0 would "
        + "draw a lie.\n"
        + "It reads, it never renders: `name` must already exist. Three kinds are "
        + "servable — a region render (reg<idx>_<hash>.wav, from daw_render), its "
        + "track/return stems (…_trk_<id>.wav or …_ret_<id>.wav, from daw_render_stems) and a Voice Lab "
        + "preview (pv_….wav, from daw_voice_lab, which needs no slug). Anything "
        + "else is refused: this route cannot be talked into reading a path.",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string",
                  description: "The file name, exactly as daw_render / daw_render_stems / "
                    + "daw_voice_lab answered it. Not a path." },
          slug: { type: "string",
                  description: "The project the region or stem belongs to. Not needed for a "
                    + "pv_… preview, which lives outside any project." },
          from_sample: { type: "integer", description: "Window start. Default 0." },
          to_sample: { type: "integer", description: "Window end. Default: the last sample." },
          samples_per_pixel: { type: "number",
                               description: "The zoom you are drawing at; picks the stage. "
                                 + "Default: the window over 900 columns." },
          stage: { type: "integer", enum: [3, 6, 9, 12],
                   description: "Force a stage by its shift (8 / 64 / 512 / 4 096 samples a "
                     + "peak) instead of deriving it from the zoom." },
          max_peaks: { type: "integer", minimum: 16, maximum: 4000,
                       description: "Cap on peaks per channel (default 4 000). A window that "
                         + "would need more is answered at a coarser stage, and the reply "
                         + "SAYS it coarsened." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({
          action: "peaks", name: a.name, slug: a.slug ? slugOf(a.slug) : undefined,
          from_sample: a.from_sample, to_sample: a.to_sample,
          samples_per_pixel: a.samples_per_pixel, stage: a.stage, max_peaks: a.max_peaks,
        });
        return {
          file: r.file, rate: r.rate, channels: r.channels,
          samples: r.samples, seconds: r.seconds, scale: r.scale,
          stages: r.stages, stage: r.stage,
          from_sample: r.from_sample, to_sample: r.to_sample,
          from_peak: r.from_peak, peaks: r.peaks, data: r.data,
          built: r.built, build_ms: r.build_ms,
          coarsened: r.coarsened, coarsened_note: r.coarsened_note,
          ms: r.ms, note: r.note,
        };
      },
    },
  ];
}
