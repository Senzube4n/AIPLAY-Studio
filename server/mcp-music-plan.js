export function musicPlanTools(api) {
  return [{
    name: "music_plan",
    description: "Read-only, no-GPU YuE2 score/length planning. Without ABC, compute bars from quarter-note BPM, meter and target_seconds (or compute length from bars). With ABC, validate note durations and optionally propose a tempo edit via bpm OR target_seconds. Returns proposed ABC without saving, rendering or changing a recording. This is NOT song extension, a guaranteed audio duration or singer matching. Pass accepted ABC to make_song with YuE2 cot full/melody to generate a NEW take.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      abc: { type: "string", maxLength: 65536, description: "Optional existing two-voice YuE2 ABC, max64KiB UTF-8. With ABC, omit bars/meter; they are checked from notes." },
      bpm: { type: "integer", minimum: 20, maximum: 400, description: "Quarter-note BPM. With ABC, do not combine with target_seconds." },
      bars: { type: "integer", minimum: 1, maximum: 1024, description: "Outline only; do not combine with target_seconds." },
      meter: { type: "string", enum: ["2/4", "3/4", "4/4", "6/8"], description: "Outline only, default4/4. In6/8 BPM still counts quarter notes." },
      target_seconds: { type: "number", minimum: 1, maximum: 900, description: "Desired NOTATION length. With ABC changes tempo; without ABC rounds to whole bars. Never guarantees audio length." },
    } },
    // The stdio dispatcher does not enforce JSON Schema. Preserve unknown
    // fields so the shared planner refuses them instead of silently ignoring
    // an audio/reference/continuation request and returning a default outline.
    run: a => api("POST", "/api/music-plan", a),
  }];
}
