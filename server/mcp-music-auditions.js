/** Typed tools use the same persistent auditions as the Music workflows panel. */
export function musicAuditionTools(api) {
  const call = (action, body) => api("POST", "/api/music-auditions", { action, ...body }, 900_000);
  const tool = (name, description, properties, required, run) => ({ name, description,
    inputSchema: { type: "object", properties, required, additionalProperties: false }, run });
  const id = { type: "string", description: "Persisted audition session id." };
  const revision = { type: "integer", minimum: 1, description: "Latest session revision from status; stale choices are refused." };
  return [
    tool("music_auditions", "List saved chorus auditions and library source eligibility. No generation. Optional source returns the replay support and reason for that one library song.",
      { source: { type: "string" } }, [], a => api("GET", "/api/music-auditions" + (a.source ? `?source=${encodeURIComponent(a.source)}` : ""))),
    tool("music_audition_create", "Generate two or three alternatives for a selected region using the original's saved YuE2 Python or local MiniMax performance. No extra model is installed. The original stays untouched. Explicitly ask to generate before calling: this queues 2–3 real renders. Follow status until each take is ready, audition both seams, then explicitly keep. Short takes return the ending early and require acknowledgement. YuE2 GGUF/Comfy and imports without saved replay data are not supported here.",
      { source: { type: "string" }, from_seconds: { type: "number", minimum: 1 }, to_seconds: { type: "number" },
        count: { type: "integer", enum: [2, 3], default: 2 }, context_seconds: { type: "number", minimum: 0, maximum: 15, default: 3 },
        caption: { type: "string", maxLength: 10000 }, lyrics: { type: "string", maxLength: 20000, description: "Whole lyric sheet, including the retained beginning." },
        abc: { type: "string", maxLength: 65536, description: "YuE2 only: supplied whole score." },
        seeds: { type: "array", minItems: 2, maxItems: 3, uniqueItems: true, items: { type: "integer", minimum: 0, maximum: 4294967295 } } },
      ["source", "from_seconds", "to_seconds"], a => call("create", { source: a.source, fromSeconds: a.from_seconds, toSeconds: a.to_seconds,
        count: a.count, contextSeconds: a.context_seconds, caption: a.caption, lyrics: a.lyrics, abc: a.abc, seeds: a.seeds })),
    tool("music_audition_status", "Read exact job ids, generating/composing/ready/failed states, result and raw filenames, seeds, measured durations, effective outgoing seams, warnings and current choice. Ready means the full song has been composed; raw render completion is insufficient.",
      { id }, ["id"], a => api("GET", `/api/music-auditions?id=${encodeURIComponent(a.id)}`)),
    tool("music_audition_keep", "Record an explicit chosen alternative with provenance. Original and other takes remain. Use only after the user chooses this take; selection is not proof of musical quality. If shortfallSeconds > 0, get acknowledgement that the ending moves earlier and set acknowledge_short. Verifies source/candidate bytes and current revision.",
      { id, revision, take_id: { type: "string" }, acknowledge_short: { type: "boolean", default: false } }, ["id", "revision", "take_id"],
      a => call("keep", { id: a.id, revision: a.revision, takeId: a.take_id, acknowledgeShort: a.acknowledge_short })),
    tool("music_audition_cancel", "Cancel only this audition's pending jobs; other Studio jobs are untouched. Finished files remain available. A running job may first report cancelling.",
      { id, revision }, ["id", "revision"], a => call("cancel", { id: a.id, revision: a.revision })),
    tool("music_audition_discard", "Dismiss an unchosen, inactive audition from review. This deletes no song files. Pending jobs must finish or be cancelled first; kept choices remain recorded.",
      { id, revision }, ["id", "revision"], a => call("discard", { id: a.id, revision: a.revision })),
  ];
}
