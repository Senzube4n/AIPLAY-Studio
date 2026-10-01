/** Typed face on the same reviewed DAW passage API as the dock. */
const id = { type: 'string', pattern: '^passage-[a-f0-9]{24}$' };
const slug = { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$' };
const passage = {
  slug, fromBar: { type: 'integer', minimum: 1 }, toBar: { type: 'integer', minimum: 1 },
  voiceTracks: { type: 'object', additionalProperties: false, properties: {
    Vocal: { type: ['string', 'null'] }, Ins: { type: ['string', 'null'] },
  }, description: 'Map at most two pitched monophonic tracks. One selected track normally maps to Ins.' },
  source: { type: 'string', description: 'Optional existing library recording filename. Protected alternatives require YuE2 Python saved performance.' },
  sourceOffsetSeconds: { type: 'number', default: 0, description: 'Positive means DAW bar 1 starts later in the recording. Review alignment before starting.' },
  quantizeTo32nd: { type: 'boolean', default: false, description: 'Explicitly snap only exported ABC; DAW notes stay unchanged. Reports every changed onset/length.' },
  caption: { type: 'string', maxLength: 10000 }, lyrics: { type: 'string', maxLength: 20000 },
};
const schema = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const check = (a, allowed) => { if (Object.keys(a).some(key => !allowed.includes(key))) throw new Error('Unsupported passage field.'); };
export function dawPassageTools(api) {
  return [{
    name: 'music_daw_passages', description: 'List saved DAW score drafts and available recordings. Pass a project slug to filter. No render starts and no notes change.',
    inputSchema: schema({ slug }), run(a) { check(a, ['slug']); return api('POST', '/api/music-daw-passages', { action: 'list', slug: a.slug }); },
  }, {
    name: 'music_daw_preview', description: 'Export selected inclusive DAW bars to validated YuE2 ABC without saving or rendering. Reports unsupported timing/polyphony and lost performance controls. Explicit quantization changes only the preview.',
    inputSchema: schema(passage, ['slug', 'fromBar', 'toBar']),
    run(a) { check(a, Object.keys(passage)); return api('POST', '/api/music-daw-passages', { action: 'preview', slug: a.slug, fromBar: a.fromBar, toBar: a.toBar, voiceTracks: a.voiceTracks, source: a.source, sourceOffsetSeconds: a.sourceOffsetSeconds, quantizeTo32nd: a.quantizeTo32nd, caption: a.caption, lyrics: a.lyrics }, 900_000); },
  }, {
    name: 'music_daw_draft', description: 'Save a reviewed passage score, exact style/lyrics, project and recording fingerprints. One score can load in Music; protected alternatives require a complete fixed-tempo monophonic conditioning score and a saved YuE2 Python source.',
    inputSchema: schema(passage, ['slug', 'fromBar', 'toBar']),
    run(a) { check(a, Object.keys(passage)); return api('POST', '/api/music-daw-passages', { action: 'create', slug: a.slug, fromBar: a.fromBar, toBar: a.toBar, voiceTracks: a.voiceTracks, source: a.source, sourceOffsetSeconds: a.sourceOffsetSeconds, quantizeTo32nd: a.quantizeTo32nd, caption: a.caption, lyrics: a.lyrics }, 900_000); },
  }, {
    name: 'music_daw_draft_get', description: 'Read a saved passage draft and its exact audition session/job receipts. A restarted uncertain submission cannot resubmit automatically. Inspect the ordinary audition shelf and queue if its acknowledgement was lost.',
    inputSchema: schema({ id }, ['id']), run(a) { check(a, ['id']); return api('POST', '/api/music-daw-passages', { action: 'get', id: a.id }); },
  }, {
    name: 'music_daw_request', description: 'Return the selected-score generation request after checking the saved project and source fingerprints. This does not queue a song. Load it in Music for review, or explicitly pass it to make_song. Model conditioning does not guarantee exact notes.',
    inputSchema: schema({ id }, ['id']), run(a) { check(a, ['id']); return api('POST', '/api/music-daw-passages', { action: 'request', id: a.id }, 900_000); },
  }, {
    name: 'music_daw_takes', description: 'Queue two or three passage alternatives through saved YuE2 Python replay. Uses the complete edited score; retains the rest of the recording with 80 ms seam blends. Checks project/source freshness; retries reuse their exact session. Uses GPU time.',
    inputSchema: schema({ id, revision: { type: 'integer', minimum: 1 }, count: { type: 'integer', enum: [2, 3], default: 2 },
      seeds: { type: 'array', minItems: 2, maxItems: 3, uniqueItems: true, items: { type: 'integer', minimum: 0, maximum: 4294967295 } },
      contextSeconds: { type: 'number', minimum: 0, maximum: 15, default: 3 } }, ['id', 'revision']),
    run(a) { check(a, ['id', 'revision', 'count', 'seeds', 'contextSeconds']); return api('POST', '/api/music-daw-passages', { action: 'start', id: a.id, revision: a.revision, count: a.count, seeds: a.seeds, contextSeconds: a.contextSeconds }, 900_000); },
  }, {
    name: 'music_daw_audition', description: 'Verify the saved original or composed take hash and return guarded playback with region, incoming seam, outgoing seam or full-song bounds. Reports short endings. An agent must actually audition before claiming a musical or seam-quality judgement.',
    inputSchema: schema({ id, takeId: { type: 'string', description: 'original or an exact take id from the saved audition.' }, part: { type: 'string', enum: ['region', 'in', 'out', 'full'], default: 'region' } }, ['id', 'takeId']),
    run(a) { check(a, ['id', 'takeId', 'part']); return api('POST', '/api/music-daw-passages', { action: 'audition', id: a.id, takeId: a.takeId, part: a.part }, 900_000); },
  }];
}
