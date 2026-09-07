import assert from 'node:assert/strict';
import { EXPORT_PRESETS, exportSettings, exportFacts, exportDownloadUrl } from '../web/daw-export.js';
const base = { format: 'flac', depth: '24', mode: 'project', target: '-14', ceiling: '-1', limiting: '3' };
let count = 0;
function test(name, run) { run(); count++; console.log(`ok ${name}`); }
test('project target is absent on wire, explicit off remains null', () => {
  assert.deepEqual(exportSettings(base), { format: 'flac', bit_depth: 24, ceiling_db: -1, max_limit_db: 3 });
  assert.deepEqual(exportSettings({ ...base, mode: 'off', ceiling: '', limiting: '' }), { format: 'flac', bit_depth: 24, target_lufs: null });
});
test('WAV and user mastering settings reach the shared route without preset substitution', () => {
  assert.deepEqual(exportSettings({ ...base, format: 'wav', depth: '16', mode: 'custom', target: '-12.3', ceiling: '-1.2', limiting: '0' }),
    { format: 'wav', bit_depth: 16, target_lufs: -12.3, ceiling_db: -1.2, max_limit_db: 0 });
});
test('blank, nonfinite and out-of-range values do not become zero', () => {
  for (const target of ['', 'NaN', 'Infinity', '-31', '-5']) assert.throws(() => exportSettings({ ...base, mode: 'custom', target }));
  for (const ceiling of ['', 1, -13]) assert.throws(() => exportSettings({ ...base, ceiling }));
  for (const limiting of ['', -1, 13]) assert.throws(() => exportSettings({ ...base, limiting }));
  assert.throws(() => exportSettings({ ...base, format: 'mp3' }));
  assert.throws(() => exportSettings({ ...base, depth: '32' }));
});
test('all starting points produce valid shared API settings', () => {
  for (const preset of Object.values(EXPORT_PRESETS)) exportSettings({ ...base, ...preset });
});
test('tag failure object is not rendered as metadata success', () => {
  const facts = Object.fromEntries(exportFacts({ tagged: { ok: false }, target_lufs: null }));
  assert.match(facts.Metadata, /Not written/);
  assert.match(facts['Loudness stage'], /master inserts and fader still apply/i);
  assert.match(Object.fromEntries(exportFacts({ tagged: { ok: true }, target_lufs: null })).Metadata, /^Written$/);
});
test('measurement shortfall and real stereo/dither are exposed', () => {
  const facts = Object.fromEntries(exportFacts({ format: 'wav', channels: 2, sr: 48000, dithered: true, bit_depth: 16,
    seconds: 1, target_lufs: -14, loudness: { before: { lufs: -20 }, after: { lufs: -15, true_peak_db: -1.2 }, limiter_work_db: 3, reached: false, shortfall_db: 1 } }));
  assert.match(facts.Audio, /WAV · 16-bit · stereo · 48000 Hz/);
  assert.equal(facts.Dither, 'Applied'); assert.match(facts.Target, /1.00 LU below target/); assert.equal(facts['True peak'], '-1.20 dBTP');
});
test('missing channel metadata stays unknown and actual channels take priority over the requested stereo flag', () => {
  assert.match(Object.fromEntries(exportFacts({})).Audio, /channels not reported/);
  assert.match(Object.fromEntries(exportFacts({ channels: 1, stereo: true })).Audio, / · mono · /);
  assert.match(Object.fromEntries(exportFacts({ channels: 2, stereo: false })).Audio, / · stereo · /);
});
test('downloads must belong to the captured project and local bounce route', () => {
  assert.equal(exportDownloadUrl('/api/daw/bounce/a/a_123.wav', 'a'), '/api/daw/bounce/a/a_123.wav');
  for (const url of ['https://example.com/a.wav', 'javascript:alert(1)', '/api/daw/bounce/b/a.wav', '/api/daw/bounce/a/../x.wav', '/api/daw/bounce/a/x.wav?bad=1'])
    assert.equal(exportDownloadUrl(url, 'a'), null);
});
console.log(`${count} export checks passed`);
