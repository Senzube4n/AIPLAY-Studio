import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { blankProject, blankTrack, blankClip } from '../daw/store.js';
import { createDawPassages, createDawPassageRoutes } from './daw-passages.js';
import { dawPassageTools } from '../mcp-daw-passages.js';

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aiplay-passages-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const project = blankProject('Test', { lengthBars: 8, bpm: 120 }); project.slug = 'test';
  const track = blankTrack('Lead', 'pluck'), clip = blankClip(1, 8);
  clip.notes = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, bar: i + 1, beat: 1, tick: 0, pitch: 60 + i, durTicks: 960, vel: 100 }));
  track.clips.push(clip); project.tracks.push(track);
  const source = { file: 'source.flac', engine: 'yue2', available: true, cot: 'full', sha256: 'a'.repeat(64), seconds: 20, caption: 'Exact style  ', lyrics: 'Hold on  \n' };
  const sessions = new Map(), calls = []; let seed = 77;
  const deps = { dir, newSeed: () => seed++, readProject: async () => structuredClone(project), inspectSource: async () => structuredClone(source),
    inspectAudio: async file => ({ file, seconds: 20, sha256: file === source.file ? source.sha256 : 'b'.repeat(64) }),
    listSources: async () => [structuredClone(source)], auditions: {
      async create(body, actor) { calls.push({ body, actor }); const session = { id: 'aud_1', revision: 1, contextSeconds: 3, takes: [] }; sessions.set(session.id, session); return session; },
      async read(id) { return structuredClone(sessions.get(id)); },
    } };
  return { ...deps, deps, project, source, calls, sessions, store: createDawPassages(deps), body: { slug: 'test', fromBar: 2, toBar: 3, voiceTracks: { Vocal: null, Ins: track.id }, source: 'source.flac' } };
}
test('preview and draft preserve exact text and bar timing, export complete conditioning independently', async t => {
  const f = await setup(t), view = await f.store.preview(f.body);
  assert.equal(view.eligibility.available, true); assert.equal(view.fromSeconds, 2); assert.equal(view.toSeconds, 6);
  assert.equal(view.score.selection.bars, 2); assert.equal(view.fullScore.selection.bars, 8);
  assert.equal(view.request.lyrics, 'Hold on  \n'); assert.equal(view.request.caption, 'Exact style  ');
  assert.equal(view.request.instrumental, false);
  assert.equal(f.calls.length, 0); assert.rejects(readFile(path.join(f.dir, 'passages.json')));
  const saved = await f.store.create(f.body, 'agent:tester');
  assert.equal(saved.draft.actor, 'agent:tester'); assert.equal(saved.draft.state, 'draft');
  assert.equal(view.request.seed, undefined);
  assert.equal(saved.draft.request.seed, 77);
  assert.deepEqual((await f.store.request(saved.draft.id)).request, { ...view.request, seed: 77 });
  assert.equal((await f.store.create(f.body, 'user')).draft.request.seed, 78);
  assert.equal((await createDawPassages(f.deps).request(saved.draft.id)).request.seed, 77);
  assert.equal((await f.store.preview({ ...f.body, lyrics: '' })).request.instrumental, true);
});
test('start queues complete score once; concurrent and stale-revision retries return exact session', async t => {
  const f = await setup(t), { draft } = await f.store.create(f.body, 'user');
  const args = { id: draft.id, revision: 1, seeds: [10, 11] };
  const [a, b] = await Promise.all([f.store.start(args, 'agent:x'), f.store.start(args, 'agent:x')]);
  assert.equal(a.audition.id, b.audition.id); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.abc, draft.fullScore.abc); assert.notEqual(f.calls[0].body.abc, draft.score.abc);
  assert.equal(f.calls[0].body.fromSeconds, 2); assert.deepEqual(f.calls[0].body.seeds, [10, 11]);
  assert.equal((await f.store.start(args, 'agent:x')).audition.id, a.audition.id); assert.equal(f.calls.length, 1);
});
test('changed notes and source audio refuse both generation and Music handoff', async t => {
  const f = await setup(t), { draft } = await f.store.create(f.body, 'user');
  f.project.tracks[0].clips[0].notes[0].pitch++;
  await assert.rejects(f.store.start({ id: draft.id, revision: 1 }, 'user'), /project.*changed/);
  await assert.rejects(f.store.request(draft.id), /project.*changed/); assert.equal(f.calls.length, 0);
  f.project.tracks[0].clips[0].notes[0].pitch--; f.source.sha256 = 'c'.repeat(64);
  await assert.rejects(f.store.start({ id: draft.id, revision: 1 }, 'user'), /source recording changed/); assert.equal(f.calls.length, 0);
});
test('unsupported source and off-song alignment still permit score drafts but cannot queue protected alternatives', async t => {
  const f = await setup(t); f.source.engine = 'yue2-gguf';
  const a = await f.store.create(f.body, 'user'); assert.equal(a.draft.eligibility.available, false);
  await assert.rejects(f.store.start({ id: a.draft.id, revision: 1 }, 'user'), /YuE2 Python/);
  f.source.engine = 'yue2'; const b = await f.store.preview({ ...f.body, sourceOffsetSeconds: -2 });
  assert.equal(b.eligibility.available, false); assert.match(b.eligibility.reason, /one second/); assert.equal(f.calls.length, 0);
});
test('unacknowledged and restarted submissions never resubmit', async t => {
  const f = await setup(t); f.deps.auditions.create = async () => { f.calls.push('lost'); throw new Error('connection lost'); };
  const { draft } = await f.store.create(f.body, 'user');
  await assert.rejects(f.store.start({ id: draft.id, revision: 1 }, 'user'), /will not resubmit/);
  await assert.rejects(f.store.start({ id: draft.id, revision: 3 }, 'user'), /not acknowledged/); assert.equal(f.calls.length, 1);
  const shelf = JSON.parse(await readFile(path.join(f.dir, 'passages.json'), 'utf8')); shelf.drafts[draft.id].state = 'starting';
  await writeFile(path.join(f.dir, 'passages.json'), JSON.stringify(shelf));
  const reopened = createDawPassages(f.deps); assert.equal((await reopened.read(draft.id)).draft.state, 'uncertain');
  await assert.rejects(reopened.start({ id: draft.id, revision: 4 }, 'user'), /restarted/); assert.equal(f.calls.length, 1);
});
test('audio verifies hash, uses effective outgoing seam and refuses unfinished candidates', async t => {
  const f = await setup(t), { draft } = await f.store.create(f.body, 'user');
  const { audition } = await f.store.start({ id: draft.id, revision: 1 }, 'user');
  const session = f.sessions.get(audition.id); session.takes.push({ id: 'take1', label: 'A', state: 'ready', file: 'candidate.flac', sha256: 'b'.repeat(64), effectiveTo: 5, shortfallSeconds: 1 });
  const clip = await f.store.audio({ id: draft.id, takeId: 'take1', part: 'out' });
  assert.equal(clip.fromSeconds, 2); assert.equal(clip.toSeconds, 8); assert.equal(clip.shortfallSeconds, 1); assert.match(clip.url, /sha256=bbbb/);
  await assert.rejects(f.store.audio({ id: draft.id, takeId: 'take1', sha256: 'c'.repeat(64) }), /fingerprint/);
  session.takes[0].state = 'generating'; await assert.rejects(f.store.audio({ id: draft.id, takeId: 'take1' }), /ready/);
  f.source.sha256 = 'd'.repeat(64); await assert.rejects(f.store.audio({ id: draft.id, takeId: 'original' }), /changed/);
});
test('routes pass request actor, require audio fingerprint, and never serve a raw path', async t => {
  const f = await setup(t), replies = []; let served = 0;
  const route = createDawPassageRoutes({ store: f.store, json: (_res, status, body) => replies.push({ status, body }),
    readBody: async req => req.body, actorFrom: req => req.actor, serveAudio: async () => { served++; } });
  await route({ method: 'POST', actor: 'agent:test', body: { action: 'create', ...f.body } }, {}, new URL('http://test/api/music-daw-passages'));
  const draft = replies.at(-1).body.draft; assert.equal(draft.actor, 'agent:test');
  await route({ method: 'GET' }, {}, new URL(`http://test/api/music-daw-passages/audio?id=${draft.id}&takeId=original`));
  assert.equal(replies.at(-1).status, 400); assert.equal(served, 0);
  await route({ method: 'GET' }, {}, new URL(`http://test/api/music-daw-passages/audio?id=${draft.id}&takeId=original&sha256=${f.source.sha256}`));
  assert.equal(served, 1);
});
test('typed MCP forwards every declared passage value without trimming exact text', async () => {
  const calls = [], tools = dawPassageTools(async (...args) => { calls.push(args); return {}; });
  const args = { slug: 'test', fromBar: 2, toBar: 3, voiceTracks: { Vocal: null, Ins: 'trk_1' }, source: 'source.flac', sourceOffsetSeconds: 1.25, quantizeTo32nd: true, caption: 'Style  ', lyrics: 'Line  \n' };
  for (const name of ['music_daw_preview', 'music_daw_draft']) { await tools.find(t => t.name === name).run(args); assert.deepEqual(Object.fromEntries(Object.entries(calls.at(-1)[2]).filter(([k]) => k !== 'action')), args); }
  await assert.rejects(async () => tools.find(t => t.name === 'music_daw_takes').run({ id: 'x', revision: 1, arbitrary: true }), /Unsupported/);
  assert.ok(tools.every(t => t.description.length <= 280));
});
