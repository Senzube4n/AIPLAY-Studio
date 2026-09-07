/** MCP and UI use the same experimental audio-input job route. */
export function musicInputTools(api) {
  const post = (body) => api("POST", "/api/music-input", body);
  return [
    {
      name: "music_input_capabilities",
      description: "Discover installed experimental Music3 audio-input continuation, its limits and missing setup. Read-only. Refiner and inpainting remain explicitly research-only, not executable Studio features.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: () => api("GET", "/api/music-input"),
    },
    {
      name: "music_input_prepare",
      description: "Prepare 0.25–15 seconds of WAV/FLAC as an approximate HOT-Step RVQ prefix for local Music3. Explicit optional runtime required. CPU-only preparation returns a job id; poll music_input_status. This neither generates music nor promises faithful continuation, cover or restoration.",
      inputSchema: { type: "object", required: ["source"], properties: {
        source: { type: "object", properties: {
          path: { type: "string", description: "Absolute local WAV/FLAC path, including a DAW bounce." },
          library_file: { type: "string", description: "WAV/FLAC filename in Studio's music library." },
          data_url: { type: "string", description: "Base64 audio upload; use exactly one source field." },
          name: { type: "string", description: "Filename with .wav/.flac extension for data_url." },
        }, additionalProperties: false },
        start_seconds: { type: "number", minimum: 0 },
        duration_seconds: { type: "number", minimum: .25, maximum: 15 },
      }, additionalProperties: false },
      /* Named, not spread: the census in mcp-image_test.js can only see a
        * parameter it can read in this body, and a schema that advertises a
        * field nothing forwards is a feature that appears to work. The wire
        * body is unchanged for every input the schema allows — JSON.stringify
        * drops an omitted optional either way. */
      run: (a) => post({ action: "prepare", source: a.source,
        start_seconds: a.start_seconds, duration_seconds: a.duration_seconds }),
    },
    {
      name: "music_input_status",
      description: "Read one preparation or continuation job. A ready preparation returns reference_id. A completed continuation returns its music-library filename; no filesystem inspection is needed.",
      inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" } }, additionalProperties: false },
      run: (a) => post({ action: "status", job_id: a.job_id }),
    },
    {
      name: "music_input_continue",
      description: "Queue local Music3 generation from a successfully prepared external-audio RVQ prefix. Returns a render job id; poll music_input_status. Produces only a NEW segment in the music library, leaves the source unchanged, and does not join it automatically. Experimental: musical continuity, key, tempo and identity are not guaranteed. Refiner/inpainting are not supported by this tool.",
      inputSchema: { type: "object", required: ["reference_id", "caption"], properties: {
        reference_id: { type: "string" }, caption: { type: "string" },
        lyrics: { type: "string", description: "Defaults to [Instrumental]." },
        title: { type: "string" }, seconds: { type: "number", minimum: .25, maximum: 30 },
        seed: { type: "integer", minimum: 0, maximum: 4294967295 },
        mix_seed: { type: "integer", minimum: 0, maximum: 4294967295 },
      }, additionalProperties: false },
      run: (a) => post({ action: "continue", reference_id: a.reference_id,
        caption: a.caption, lyrics: a.lyrics, title: a.title,
        seconds: a.seconds, seed: a.seed, mix_seed: a.mix_seed }),
    },
    {
      name: "music_input_cancel",
      description: "Cancel only the named experimental preparation or continuation job. Stops its CPU helper or withdraws its own music prompt; never clears other queued work. Cancelling a ready reference does not delete it or cancel its separate render jobs.",
      inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" } }, additionalProperties: false },
      run: (a) => post({ action: "cancel", job_id: a.job_id }),
    },
  ];
}
