/**
 * DAW — the MASTERING SUITE's MCP tools: daw_analyze, daw_device_response,
 * daw_reference, daw_check_delivery.
 *
 * Spread into dawTools() (server/mcp-daw.js) beside rackTools() and
 * earTools(), so the declared-and-dropped guard, the daw_ family checks and
 * the `by: "agent"` stamp all cover these four exactly as they cover the
 * rest of the family. Every capability calls the SAME /api/daw route the UI
 * calls — one document, two hands.
 *
 * THE SEVEN DEVICES are NOT here. They are ordinary rack devices and go on
 * a chain with daw_insert (op: "add", type: "maximizer" ...) like the other
 * nine; daw_insert op:"catalog" lists them with their parameters. Adding a
 * second way to add an insert would be a second thing to keep in sync.
 *
 * WHAT IS HERE is the half a rack cannot do: MEASUREMENT. Mastering is
 * comparative and quantitative — you cannot master by adjusting knobs until
 * it feels right, because "louder" always feels right. These four answer
 * numbers.
 */

const RANGE =
  "`from_bar`/`to_bar` name the window (default: the whole song). Pass "
  + "`file` instead to measure an existing bounce or any server-local audio "
  + "file, in which case no project is needed.";

export function masterTools({ api, slugOf }) {
  /* THE RENDER LANE'S TIMEOUT, not the default two minutes. Every tool here
   * renders the window before it measures it, so analysing a whole song is
   * a render-lane job — the same reason the Ear's prefix carries its own. */
  const daw = async (body) => {
    const r = await api("POST", "/api/daw", { ...body, by: "agent" }, 1_800_000);
    if (r.error) throw new Error(r.error);
    return r;
  };
  return [
    {
      name: "daw_analyze",
      description:
        "EVERY METER, in one call — the mastering analyser. Renders a bar range "
        + "through the full chain graph (or reads a file) and answers: an FFT "
        + "spectrum (log-spaced bins, time-averaged AND peak-hold); the loudness "
        + "time series (LUFS-M per 400 ms and LUFS-S per 3 s, both at a 100 ms "
        + "hop) plus integrated LUFS and gated LRA; L/R correlation over time "
        + "with a mono-compatibility verdict; the goniometer point cloud "
        + "(decimated by peak, not by stride, so the shape survives); crest, PLR "
        + "and PSR; and per-band energy against a pink reference. BS.1770-4 "
        + "throughout — the same maths daw_meters and the Ear use. "
        + RANGE + " "
        + "Optionally pass `device` ({ type, params }) to PROBE what a device "
        + "would do to this master before you commit to it: the reply adds a "
        + "measured gain-reduction series in dB, with the device's own drive or "
        + "makeup knob subtracted out, plus before/after loudness, true peak and "
        + "correlation. That is the honest way to read a maximizer's GR or to "
        + "check that widening the highs has not wrecked mono.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug (omit only with `file`)." },
          from_bar: { type: "integer", description: "Default 1." },
          to_bar: { type: "integer", description: "Default: the last bar." },
          file: { type: "string", description: "Measure this server-local audio file instead of rendering." },
          goniometer: { type: "boolean", description: "false skips the point cloud (a smaller reply)." },
          device: {
            type: "object",
            description: "Probe a device over this master without adding it: "
              + "{ type: <any rack device>, params: {...} }. Answers a measured "
              + "gain-reduction series and before/after meters.",
          },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({
          action: "analyze", slug: a.slug ? slugOf(a.slug) : undefined,
          from_bar: a.from_bar, to_bar: a.to_bar, file: a.file,
          goniometer: a.goniometer, device: a.device,
        });
        return {
          from_bar: r.fromBar, to_bar: r.toBar, source: r.source, seconds: r.seconds,
          spectrum: r.spectrum, loudness: r.loudness, correlation: r.correlation,
          goniometer: r.goniometer, dynamics: r.dynamics, bands: r.bands,
          device: r.device, ms: r.ms,
        };
      },
    },

    {
      name: "daw_device_response",
      description:
        "A device instance's own frequency response, COMPUTED FROM ITS "
        + "COEFFICIENTS — magnitude in dB (and phase in degrees) across "
        + "log-spaced frequencies. This is what an EQ draws its curve from, and "
        + "it is the filter itself rather than a picture of one: the test suite "
        + "sweeps a real impulse through the real device and compares. Name the "
        + "device either explicitly (`type` + `params`) or by pointing at a live "
        + "insert (`slug` + `target` + `insert`), which is usually what you "
        + "want — no need to send the parameters back. A multiband device also "
        + "answers a curve PER BAND; a dynamic EQ answers its flat rest state "
        + "AND the reach of each band at full range; a dynamics device (compressor, "
        + "limiter, maximizer, gate) has no frequency response and says so, "
        + "answering a static input-dB → output-dB TRANSFER curve instead.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: "Device type (with `params`)." },
          params: { type: "object", description: "Device params; catalog defaults fill the rest." },
          slug: { type: "string", description: "Project slug (with `target` + `insert`)." },
          target: { type: "string", description: "Track id, return id, or \"master\"." },
          insert: { type: "string", description: "Insert id on that chain." },
          points: { type: "integer", description: "Curve resolution, 32..2048 (default 512)." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({
          action: "device_response", type: a.type, params: a.params,
          slug: a.slug ? slugOf(a.slug) : undefined, target: a.target,
          insert: a.insert, points: a.points,
        });
        return {
          type: r.type, hz: r.hz, magnitude_db: r.magnitude_db, phase_deg: r.phase_deg,
          max_magnitude_db: r.max_magnitude_db, bands: r.bands,
          crossovers_hz: r.crossovers_hz, transfer: r.transfer,
          at_rest: r.at_rest, none_reason: r.none_reason, note: r.note,
          source: r.source, ms: r.ms,
        };
      },
    },

    {
      name: "daw_reference",
      description:
        "REFERENCE A/B — load a finished track and compare the master against "
        + "it, LOUDNESS-MATCHED. The reference is measured, gained so its "
        + "integrated LUFS equals the project's, and measured again; the applied "
        + "gain is reported, and so is the reference's own unmatched loudness. "
        + "That matching is the whole point: everything sounds better louder, "
        + "including a worse master, so an unmatched spectrum comparison compares "
        + "two loudnesses rather than two masters. The reply carries both full "
        + "spectra, both meter sets, and the per-band difference in dB — "
        + "positive means the project has MORE energy in that band than the "
        + "reference. " + RANGE + " A reference at another sample rate is "
        + "resampled to the project's and the reply says so.",
      inputSchema: {
        type: "object",
        required: ["reference"],
        properties: {
          reference: { type: "string", description: "Server-local audio file to compare against." },
          slug: { type: "string", description: "Project slug (omit only with `file`)." },
          from_bar: { type: "integer", description: "Default 1." },
          to_bar: { type: "integer", description: "Default: the last bar." },
          file: { type: "string", description: "Compare this bounce instead of rendering." },
          match: { type: "string", enum: ["lufs", "off"], description: "Default lufs." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({
          action: "reference", reference: a.reference,
          slug: a.slug ? slugOf(a.slug) : undefined,
          from_bar: a.from_bar, to_bar: a.to_bar, file: a.file, match: a.match,
        });
        return {
          from_bar: r.fromBar, to_bar: r.toBar, match: r.match,
          project: r.project, reference: r.reference,
          delta_bands_db: r.delta_bands_db, ms: r.ms,
        };
      },
    },

    {
      name: "daw_check_delivery",
      description:
        "PASS or FAIL against the streaming targets, with the exact move. For "
        + "each platform: its integrated-LUFS target and true-peak ceiling, what "
        + "this master measures, the gain that would land on the target, and "
        + "WHERE THAT GAIN WOULD PUT THE TRUE PEAK. When the gain would breach "
        + "the ceiling the verdict says so and gives the dB that has to come from "
        + "limiting instead of from the fader — \"turn it up 3 dB\" is wrong "
        + "advice if 3 dB of headroom is not there. Every row carries a "
        + "`confidence` (published | measured | uncertain), its `source`, and a "
        + "note; platforms change normalisation silently, and a row marked "
        + "uncertain must be verified before a master is delivered on it. " + RANGE,
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Project slug (omit only with `file`)." },
          from_bar: { type: "integer", description: "Default 1." },
          to_bar: { type: "integer", description: "Default: the last bar." },
          file: { type: "string", description: "Check this bounce instead of rendering." },
          targets: {
            type: "array", items: { type: "string" },
            description: "Only these target ids (default: all of them).",
          },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await daw({
          action: "check_delivery", slug: a.slug ? slugOf(a.slug) : undefined,
          from_bar: a.from_bar, to_bar: a.to_bar, file: a.file, targets: a.targets,
        });
        return {
          from_bar: r.fromBar, to_bar: r.toBar, measured: r.measured,
          results: r.results, as_of: r.as_of, caveat: r.caveat, ms: r.ms,
        };
      },
    },
  ];
}
