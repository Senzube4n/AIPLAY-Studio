/** Real schema/store/preview routes, fake renderer only. No sample downloads. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const temp = await mkdtemp(path.join(os.tmpdir(), 'aiplay-sampler-quality-'));
for (const key of Object.keys(process.env)) if (key.startsWith('AIPLAY_')) delete process.env[key];
Object.assign(process.env, { AIPLAY_APPDATA: path.join(temp, 'appdata'), AIPLAY_OUTPUT: path.join(temp, 'output'),
  AIPLAY_RIG: path.join(temp, 'rig'), AIPLAY_DAW_INSTRUMENTS: path.join(temp, 'instruments'),
  AIPLAY_PYTHON: path.join(temp, 'fake-python.exe'), AIPLAY_DAW_NO_SERVE: '1' });
const store = await import('./store.js');
const { createDawRoutes } = await import('./routes.js');
const { config } = await import('../config.js');
const { dawTools } = await import('../mcp-daw.js');
globalThis.fetch = () => { throw new Error('No network may run in this fixture'); };
const jobs = [];
const owned = file => {
  const relative = path.relative(temp, path.resolve(file));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  return file;
};
const handle = createDawRoutes({ config, json: (res, code, body) => Object.assign(res, { code, body }),
  readBody: async req => req.body,
  spawnPython(args) {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    proc.kill = () => { throw new Error('No real subprocess may run in this fixture'); };
    queueMicrotask(async () => {
      try {
        assert.equal(args[1], 'render');
        const job = JSON.parse(await readFile(owned(args[2]), 'utf8')); jobs.push(job);
        const channels = job.mixer ? 2 : 1, dataBytes = job.n_samples * channels * 4;
        const wav = Buffer.alloc(44 + dataBytes);
        wav.write('RIFF'); wav.writeUInt32LE(36 + dataBytes, 4); wav.write('WAVEfmt ', 8);
        wav.writeUInt32LE(16, 16); wav.writeUInt16LE(3, 20); wav.writeUInt16LE(channels, 22);
        wav.writeUInt32LE(job.sr, 24); wav.writeUInt32LE(job.sr * channels * 4, 28);
        wav.writeUInt16LE(channels * 4, 32); wav.writeUInt16LE(32, 34);
        wav.write('data', 36); wav.writeUInt32LE(dataBytes, 40);
        await writeFile(owned(job.out), wav);
        proc.stdout.emit('data', Buffer.from('{"ok":true,"ms":0}\n')); proc.emit('close', 0);
      } catch (error) { proc.emit('error', error); }
    });
    return proc;
  } });
async function post(body) {
  const res = {};
  assert.equal(await handle({ method: 'POST', headers: {}, body }, res, new URL('http://localhost/api/daw')), true);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  return res.body;
}
after(async () => {
  assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
  assert.match(path.basename(temp), /^aiplay-sampler-quality-/);
  await rm(temp, { recursive: true, force: true });
});

test('every SFZ quality control is declared, default-dropped and isolated from other engines', () => {
  const sfz = Object.entries(store.PATCHES).filter(([, row]) => row.kind === 'sfz');
  assert.ok(sfz.length > 0);
  for (const [id, row] of sfz) {
    const spec = row.params.resample_quality;
    assert.deepEqual([spec.min, spec.max, spec.default, spec.step], [0, 1, 0, 1], id);
    assert.deepEqual(spec.choices, { 0: 'Legacy', 1: 'Bandlimited' }, id);
    assert.deepEqual(store.normParams({ resample_quality: 0 }, id), {});
    assert.equal(store.normParams({ resample_quality: 1 }, id).resample_quality, 1);
  }
  for (const [id, row] of Object.entries(store.PATCHES).filter(([, row]) => row.kind !== 'sfz')) {
    assert.equal(row.params?.resample_quality, undefined, id);
    assert.equal(store.normParams({ resample_quality: 1 }, id).resample_quality, undefined, id);
  }
});

test('MCP track write, reload, preview override and cache all carry the selected SFZ quality', async () => {
  const patch = Object.keys(store.PATCHES).find(id => store.PATCHES[id].kind === 'sfz');
  // The renderer is fake; only the real route's installed-pack presence check
  // needs a fixture. No sample pack is installed, read or downloaded.
  for (const rel of store.PATCH_MANIFEST.packs[store.PATCHES[patch].pack].expect) {
    const file = owned(path.join(temp, 'instruments', ...rel.split('/')));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'synthetic pack-presence fixture');
  }
  const tools = dawTools(async (method, route, body) => {
    assert.equal(method, 'POST'); assert.equal(route, '/api/daw'); return post(body);
  }, value => value);
  const tool = (name, args) => tools.find(t => t.name === name).run(args);
  const made = await post({ action: 'create', name: 'Sampler quality fixture', length_bars: 1 });
  const added = await post({ action: 'add_track', slug: made.slug, name: 'sampler', instrument: patch });
  const args = { slug: made.slug, track: added.trackId, pitch: 60, dur_ticks: 120 };
  const legacy = await post({ action: 'preview_note', ...args });
  assert.equal(jobs.at(-1).notes[0].params.resample_quality, undefined);
  await tool('daw_set_track', { slug: made.slug, track: added.trackId, params: { resample_quality: 1 } });
  const saved = await store.readProject(made.slug);
  assert.equal(saved.tracks[0].instrument.params.resample_quality, 1);
  const quality = await post({ action: 'preview_note', ...args });
  assert.notEqual(quality.url, legacy.url);
  assert.equal(jobs.at(-1).notes[0].params.resample_quality, 1);
  const requests = jobs.length;
  assert.equal((await post({ action: 'voice_lab', ...args })).url, quality.url);
  assert.equal(jobs.length, requests, 'both preview routes share the selected quality cache');
  const before = JSON.stringify(await store.readProject(made.slug));
  const audition = await post({ action: 'voice_lab', ...args, params_override: { resample_quality: 0 } });
  assert.equal(audition.url, legacy.url);
  assert.equal(JSON.stringify(await store.readProject(made.slug)), before, 'audition override does not rewrite the track');
  await tool('daw_set_track', { slug: made.slug, track: added.trackId, params: { resample_quality: 0 } });
  assert.deepEqual((await store.readProject(made.slug)).tracks[0].instrument.params, {});
  assert.equal((await post({ action: 'preview_note', ...args })).url, legacy.url);
});
