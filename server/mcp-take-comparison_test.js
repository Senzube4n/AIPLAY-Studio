import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { takeComparisonTools } from './mcp-take-comparison.js';
import { createTakeComparisons } from './music/take-comparison.js';

test('five typed tools forward every field to the same comparison API without generation', async () => {
  const calls = [], tools = takeComparisonTools(async (...args) => { calls.push(args); return { ok: true }; });
  assert.equal(tools.length, 5); assert.equal(new Set(tools.map(tool => tool.name)).size, 5);
  const run = (name, args) => tools.find(tool => tool.name === name).run(args);
  for (const tool of tools) { assert.equal(tool.inputSchema.additionalProperties, false); assert.ok(tool.description.length <= 280); }
  await run('music_takes_list', {});
  await run('music_takes_create', { idempotencyKey: 'mcp-key', name: 'Exact takes', files: ['a.flac', 'b.flac'] });
  await run('music_takes_get', { id: 'takes-' + 'a'.repeat(24) });
  await run('music_takes_verify', { id: 'takes-' + 'a'.repeat(24) });
  await run('music_takes_choose', { id: 'takes-' + 'a'.repeat(24), expectedRevision: 3, takeId: 'B', favourite: false });
  assert.deepEqual(calls.map(call => call[2].action), ['list', 'create', 'get', 'verify', 'choose']);
  assert.ok(calls.every(call => call[0] === 'POST' && call[1] === '/api/music-take-comparison'));
  assert.deepEqual(calls[1][2], { action: 'create', idempotencyKey: 'mcp-key', name: 'Exact takes', files: ['a.flac', 'b.flac'] });
  assert.deepEqual(calls[4][2], { action: 'choose', id: 'takes-' + 'a'.repeat(24), expectedRevision: 3, takeId: 'B', favourite: false });
  for (const tool of tools) assert.throws(() => tool.run({ unexpected: true }), /field|no fields/);
});

test('MCP performs a persisted comparison and enforces stale revision/source guards through production store', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mcp-takes-')); t.after(() => rm(directory, { force: true, recursive: true }));
  let sourceHash = 'c'.repeat(64); const favourite = [];
  const store = createTakeComparisons({ appData: directory, listSongs: async () => [{ file: 'a.flac' }, { file: 'b.flac' }],
    inspectSource: async file => ({ file, seconds: 45, sha256: sourceHash }), sourceReceipt: async () => ({ metadata: { lyrics: 'Keep  \n', seed: 0 } }),
    measureSource: async () => ({ loudness: { integrated: -15, true_peak_db: -3 } }), setFavourite: async (file, on) => favourite.push({ file, on }) });
  const tools = takeComparisonTools(async (method, route, body) => store.request(body, 'agent:llm'));
  const run = (name, args) => tools.find(tool => tool.name === name).run(args);
  let row = (await run('music_takes_create', { idempotencyKey: 'mcp-live', name: 'Matched takes', files: ['a.flac', 'b.flac'] })).comparison;
  assert.equal(row.takes[0].receipt.metadata.lyrics, 'Keep  \n'); assert.equal((await run('music_takes_verify', { id: row.id })).verified, true);
  row = (await run('music_takes_choose', { id: row.id, expectedRevision: 1, takeId: 'B' })).comparison;
  assert.equal(row.chosen.actor, 'agent:llm'); assert.deepEqual(favourite, [{ file: 'b.flac', on: true }]);
  await assert.rejects(run('music_takes_choose', { id: row.id, expectedRevision: 1, takeId: 'A' }), /changed/);
  sourceHash = 'd'.repeat(64); await assert.rejects(run('music_takes_verify', { id: row.id }), /missing or changed/);
  await assert.rejects(run('music_takes_choose', { id: row.id, expectedRevision: 2, takeId: 'A' }), /missing or changed/);
  assert.equal(favourite.length, 1);
});
