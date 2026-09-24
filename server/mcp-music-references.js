/** Human-intent actions share the reference route used by the Music page. */
export function musicReferenceTools(api) {
  const id = { referenceId: { type: "string", description: "ID returned by music_reference_prepare." } };
  const revision = { ...id, expectedRevision: { type: "integer", minimum: 0, description: "Current reference revision from status; stale edits are refused." } };
  const defined = value => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
  const send = (action, body = {}) => api("POST", "/api/music-references", { action, ...defined(body) });
  const tool = (name, description, properties, required, run) => ({ name, description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    run });
  return [
    tool("music_reference_capabilities", "Inspect local reference preparation and installed vision-language support. No models load or download. Qwen Image generation is separate from Qwen3-VL visual description.", {}, [], () => send("capabilities")),
    tool("music_reference_list", "List saved local reference briefs and their provenance; no generation.", {}, [], () => send("list")),
    tool("music_reference_prepare", "Prepare a bounded local library audio/video region on CPU. Saves source hash, measured beat evidence when available, and timestamped video frames. Returns a reference ID; poll status. No model download, cloud upload or song generation.", {
      kind: { type: "string", enum: ["audio", "video"] }, file: { type: "string", description: "Bare audio library filename or video filename from clips library; no paths/URLs." },
      startSeconds: { type: "number", minimum: 0, maximum: 86400 }, seconds: { type: "number", minimum: .25, maximum: 120 },
      maxFrames: { type: "integer", minimum: 1, maximum: 6 } }, ["kind", "file"],
      a => send("prepare", { kind: a.kind, file: a.file, startSeconds: a.startSeconds, seconds: a.seconds, maxFrames: a.maxFrames })),
    tool("music_reference_status", "Read one reference and optional timestamped contact sheet; preparation/analysis are asynchronous. Model suggestions are separate from the reviewed brief.", { ...id, preview: { type: "boolean" } }, ["referenceId"],
      a => send("get", { referenceId: a.referenceId, preview: a.preview })),
    tool("music_reference_analyze_visual", "Explicitly run the installed local Qwen3-VL model on the prepared contact sheet through Studio's engine queue. Uses GPU when configured, never downloads/uploads. Describes sampled visible events and suggests music; no song is generated. Poll status.", {
      ...revision, model: { type: "string", description: "Optional installed model filename from capabilities.visual.models." } }, ["referenceId", "expectedRevision"],
      a => send("analyze_visual", { referenceId: a.referenceId, expectedRevision: a.expectedRevision, model: a.model })),
    tool("music_reference_transcribe", "Explicitly transcribe prepared region audio with the installed SheetSage2 engine bridge into editable ABC; uses the engine queue. No music render starts. Poll status and review transcription before using it.", {
      ...revision, mode: { type: "string", enum: ["melody", "full"] } }, ["referenceId", "expectedRevision"],
      a => send("transcribe", { referenceId: a.referenceId, expectedRevision: a.expectedRevision, mode: a.mode })),
    tool("music_reference_update_brief", "Save the user's reviewed musical direction, lyrics and notes separately from measured evidence/model suggestions. No render or model call. This does not promise singer cloning or exact synchronization.", {
      ...revision, brief: { type: "object", properties: { style: { type: "string", maxLength: 4000 }, lyrics: { type: "string", maxLength: 16000 }, notes: { type: "string", maxLength: 4000 } }, additionalProperties: false } }, ["referenceId", "expectedRevision", "brief"],
      a => send("update_brief", { referenceId: a.referenceId, expectedRevision: a.expectedRevision,
        brief: a.brief && typeof a.brief === "object" ? defined({ style: a.brief.style, lyrics: a.brief.lyrics, notes: a.brief.notes }) : a.brief })),
    tool("music_reference_update_score", "Save corrected two-voice ABC and return the shared notation check. Invalid drafts may be saved for editing but cannot be used in a prepared generation request. No model or audio operation.", {
      ...revision, abc: { type: "string", maxLength: 65536 }, mode: { type: "string", enum: ["melody", "full"] } }, ["referenceId", "expectedRevision", "abc"],
      a => send("update_score", { referenceId: a.referenceId, expectedRevision: a.expectedRevision, abc: a.abc, mode: a.mode })),
    tool("music_reference_prepare_request", "Prepare a reviewed YuE2 Create request without generating. Requires saved style and lyrics, or explicit instrumental mode with empty lyrics on Python/Comfy brief-only. Native GGUF requires lyrics. Optional validated ABC (useScore) works on all three YuE2 builds: Python, Comfy and GGUF. When the user wants a render, pass reference.prepared.makeSongArguments to make_song; reference.prepared.request is the HTTP/Create shape. Existing audio remains unchanged.", {
      ...revision, reviewed: { type: "boolean", const: true }, engine: { type: "string", enum: ["yue2", "yue2-comfy", "yue2-gguf"] },
      cot: { type: "string", enum: ["full", "melody", "off"] }, seed: { type: "integer", minimum: 0, maximum: 4294967295 },
      useScore: { type: "boolean" }, instrumental: { type: "boolean", description: "Explicit instrumental request; requires empty lyrics and Python/Comfy without supplied score. Uses the backend's current instrumental behavior; no guarantee of exact silence from vocals or automatic adapter download." },
      allowSectionLabels: { type: "boolean", description: "Explicitly allow bracketed section text in lyrics; YuE2 may sing those words rather than treat them as commands." } }, ["referenceId", "expectedRevision", "reviewed"],
      a => send("prepare_request", { referenceId: a.referenceId, expectedRevision: a.expectedRevision, reviewed: a.reviewed,
        engine: a.engine, cot: a.cot, seed: a.seed, useScore: a.useScore, instrumental: a.instrumental, allowSectionLabels: a.allowSectionLabels })),
  ];
}
