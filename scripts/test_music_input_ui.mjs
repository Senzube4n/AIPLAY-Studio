import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inputSelection, continuationSettings, musicResultUrl } from '../web/music-input-ui.js';
let count = 0;
function test(name, run) { run(); count++; console.log(`ok ${name}`); }
test('export bridge and library/file inputs use the same preparation action', () => {
  assert.deepEqual(inputSelection({ path: 'C:/projects/p/bounces/song.flac', start: '1.25', duration: '7.5' }),
    { action: 'prepare', source: { path: 'C:/projects/p/bounces/song.flac' }, start_seconds: 1.25, duration_seconds: 7.5 });
  assert.deepEqual(inputSelection({ library: ' song.flac ', start: '0', duration: '15' }).source, { library_file: 'song.flac' });
  assert.deepEqual(inputSelection({ dataUrl: 'data:audio/wav;base64,AAAA', name: 's.wav', start: 0, duration: .25 }).source,
    { data_url: 'data:audio/wav;base64,AAAA', name: 's.wav' });
});
test('unselected input and invalid time range stop before API calls', () => {
  assert.throws(() => inputSelection({ start: 0, duration: 7.5 }));
  for (const duration of ['', 0, 15.01, Infinity]) assert.throws(() => inputSelection({ library: 's.wav', start: 0, duration }));
  for (const start of ['', -1, NaN]) assert.throws(() => inputSelection({ library: 's.wav', start, duration: 7.5 }));
});
const base = { reference: 'mi_a', caption: 'Piano at 80 BPM', seed: 0, mixSeed: 4294967295, seconds: 7.5, title: 'Piano' };
test('continuation exposes both seeds, lyrics, duration, title and explicit ready reference', () => {
  assert.deepEqual(continuationSettings(base), { action: 'continue', reference_id: 'mi_a', caption: 'Piano at 80 BPM', lyrics: '[Instrumental]',
    seed: 0, mix_seed: 4294967295, seconds: 7.5, title: 'Piano' });
});
test('unfinished input, empty caption and invalid seeds cannot queue generation', () => {
  for (const patch of [{ reference: null }, { caption: '' }, { seed: -1 }, { seed: 1.5 }, { seed: 'abc' }, { mixSeed: 4294967296 }, { seconds: 31 }])
    assert.throws(() => continuationSettings({ ...base, ...patch }));
});
test('a blank seed box is random: the seed is left out and the server rolls one', () => {
  const both = continuationSettings({ ...base, seed: '', mixSeed: ' ' });
  assert.equal(Object.hasOwn(both, 'seed'), false); assert.equal(Object.hasOwn(both, 'mix_seed'), false);
  const mixOnly = continuationSettings({ ...base, seed: 7, mixSeed: '' });
  assert.equal(mixOnly.seed, 7); assert.equal(Object.hasOwn(mixOnly, 'mix_seed'), false);
});
test('the boxes open empty on "random", never on a fixed number', () => {
  const src = readFileSync(new URL('../web/music-input-ui.js', import.meta.url), 'utf8');
  assert.ok(!/418923/.test(src), 'the old fixed seed is gone');
  assert.match(src, /data-mi="seed" type="number" min="0" max="4294967295" step="1" placeholder="random">/);
  assert.match(src, /data-mi="mixSeed" type="number" min="0" max="4294967295" step="1" placeholder="same as composition">/);
});
test('audio results cannot load arbitrary remote or script URLs', () => {
  assert.equal(musicResultUrl('/api/audio/Piano%20song.flac'), '/api/audio/Piano%20song.flac');
  for (const url of ['https://outside.test/song.flac', 'javascript:alert(1)', '/api/audio/../secrets.wav', '/api/audio/song.wav?x=1'])
    assert.equal(musicResultUrl(url), null);
});
console.log(`${count} music input UI checks passed`);
