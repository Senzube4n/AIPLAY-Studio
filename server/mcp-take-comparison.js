/** Same validated saved-song comparison door as Music Lab. No generation. */
export function takeComparisonTools(api) {
  const id = { type: 'string', pattern: '^takes-[a-f0-9]{24}$' };
  const takeId = { type: 'string', enum: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] };
  return [{
    name: 'music_takes_list',
    description: 'List saved 2/4/8-song comparisons and available library recordings. Creating a comparison measures existing audio only; it never queues a song or changes the original recordings.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    run(a) {
      if (Object.keys(a).length) throw new Error('music_takes_list takes no fields.');
      return api('POST', '/api/music-take-comparison', { action: 'list' });
    },
  }, {
    name: 'music_takes_create',
    description: 'Save exactly 2, 4 or 8 existing library songs with immutable audio hashes and exact stored settings/provenance receipts. Measure CPU loudness and peak-safe playback gains. Older missing settings stay unknown. Retry the same creation key and inputs safely.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['idempotencyKey', 'name', 'files'], properties: {
      idempotencyKey: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$' }, name: { type: 'string', minLength: 1, maxLength: 120 },
      files: { type: 'array', minItems: 2, maxItems: 8, uniqueItems: true, items: { type: 'string' }, description: 'Exactly 2, 4 or 8 filenames from music_takes_list.' },
    } },
    run(a) {
      if (Object.keys(a).some(key => !['idempotencyKey', 'name', 'files'].includes(key))) throw new Error('Unsupported comparison creation field.');
      return api('POST', '/api/music-take-comparison', { action: 'create', idempotencyKey: a.idempotencyKey, name: a.name, files: a.files }, 1_800_000);
    },
  }, {
    name: 'music_takes_get',
    description: 'Read a saved comparison, source hashes, exact stored receipts, measured matching gains, durations and choice history. get does not verify current files; call music_takes_verify before auditioning or deciding. Playback URLs independently verify each request.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id } },
    run(a) {
      if (Object.keys(a).some(key => key !== 'id')) throw new Error('Unsupported comparison read field.');
      return api('POST', '/api/music-take-comparison', { action: 'get', id: a.id });
    },
  }, {
    name: 'music_takes_verify',
    description: 'Verify every saved recording against its immutable audio hash and measured duration. Missing or replaced files refuse the comparison. Returns verified true and fingerprinted playback URLs; this does not claim an agent listened or judge audio quality.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id } },
    run(a) {
      if (Object.keys(a).some(key => key !== 'id')) throw new Error('Unsupported comparison verification field.');
      return api('POST', '/api/music-take-comparison', { action: 'verify', id: a.id }, 900_000);
    },
  }, {
    name: 'music_takes_choose',
    description: 'Record the requested take choice and explicitly set its library favourite flag (default true). Requires the latest revision and unchanged audio. Preserves every original and previous choice. An agent should choose only on the user’s direction, never infer preference from meters.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id', 'expectedRevision', 'takeId'], properties: {
      id, expectedRevision: { type: 'integer', minimum: 1 }, takeId, favourite: { type: 'boolean', default: true },
    } },
    run(a) {
      if (Object.keys(a).some(key => !['id', 'expectedRevision', 'takeId', 'favourite'].includes(key))) throw new Error('Unsupported comparison choice field.');
      return api('POST', '/api/music-take-comparison', { action: 'choose', id: a.id, expectedRevision: a.expectedRevision,
        takeId: a.takeId, ...(a.favourite === undefined ? {} : { favourite: a.favourite }) }, 900_000);
    },
  }];
}
