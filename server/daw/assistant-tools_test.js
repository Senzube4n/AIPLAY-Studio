import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAssistantTools, validateAssistantArguments, ASSISTANT_TOOL_GATES } from './assistant-tools.js';

const slug = 'my-current-song';
function fixture() {
  const calls = [];
  const api = async (method, route, body) => {
    calls.push({ method, route, body });
    if (route === '/api/daw/patches') return { instrumentsDir: 'owned-instruments', patches: [] };
    if (route === '/api/daw/rack') return { catalog: { devices: [] }, tables_agree: true };
    return { note: { id: 'n1', bar: 1, beat: 1, tick: 0 }, trackId: 't1', clipId: 'c1', dirty: [],
      edited: [], regions: [], credits: [], ledger: [], project: { slug, name: 'Current', lengthBars: 4,
        meterMap: [], tempoMap: [], view: {}, tracks: [] }, totalSeconds: 8, hashes: [] };
  };
  const tools = createAssistantTools({ slug, api });
  return { calls, tools, get: name => tools.find(tool => tool.name === name) };
}

test('only reviewed project tools are exposed, with the existing chat gate classifications', async () => {
  const { tools } = fixture();
  assert.deepEqual(tools.map(tool => tool.name).sort(), Object.keys(ASSISTANT_TOOL_GATES).sort());
  const router = await readFile(new URL('../chat/router.js', import.meta.url), 'utf8');
  for (const tool of tools) {
    const expected = new RegExp(`\\b${tool.name}:\\s*(null|"gpu"|"destroys")`).exec(router);
    assert.ok(expected, `${tool.name} must have an existing reviewed classification`);
    assert.equal(tool.gate, JSON.parse(expected[1]));
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.properties.slug.enum, [slug]);
    assert.ok(tool.inputSchema.required.includes('slug'));
  }
  const absent = ['daw_status', 'daw_create_project', 'daw_delete_project', 'daw_arrange_bigroom',
    'daw_plugins', 'daw_import_audio', 'daw_reference', 'daw_profile_list', 'daw_profile_build',
    'daw_calibrate', 'daw_record', 'daw_taste', 'api_request', 'cancel_job', 'download_model'];
  for (const name of absent) assert.equal(tools.find(tool => tool.name === name), undefined);
});

test('every tool refuses a different project, unknown arguments and missing slug before API', async () => {
  const r = fixture();
  for (const tool of r.tools) {
    await assert.rejects(async () => tool.run({ slug: 'another-project' }));
    await assert.rejects(async () => tool.run({ slug, actor: 'user', action: 'delete' }));
    await assert.rejects(async () => tool.run({}));
  }
  assert.equal(r.calls.length, 0);
  for (const bad of ['../other', 'a/b', 'a\\b', '', 'a?x', 'a%2fother']) assert.throws(() => createAssistantTools({ slug: bad, api() {} }));
});

test('ordinary edits reuse the real reducer and force agent provenance', async () => {
  const r = fixture();
  assert.equal(r.get('daw_add_note').gate, null);
  await r.get('daw_add_note').run({ slug, track: 't1', bar: 1, beat: 1, pitch: 60 });
  const call = r.calls[0];
  assert.equal(call.method, 'POST'); assert.equal(call.route, '/api/daw');
  assert.equal(call.body.slug, slug); assert.equal(call.body.action, 'add_note'); assert.equal(call.body.by, 'agent');
  assert.equal(call.body.pitch, 60);
  const input = { slug, track: 't1', bar: 1, beat: 1, pitch: 60 };
  const approvedCopy = r.get('daw_add_note').validate(input); input.slug = 'other';
  assert.equal(approvedCopy.slug, slug);
  await r.get('daw_remove_track').run({ slug, track: 't1' });
  assert.equal(r.get('daw_remove_track').gate, 'destroys'); assert.equal(r.calls[1].body.action, 'remove_track');
});

test('render and bounce retain explicit GPU gates and the bound route', async () => {
  const r = fixture();
  await r.get('daw_render').run({ slug, from_bar: 1, to_bar: 2 });
  await r.get('daw_bounce').run({ slug, format: 'wav', bit_depth: 24, target_lufs: null });
  for (const call of r.calls) { assert.equal(call.route, '/api/daw'); assert.equal(call.body.slug, slug); assert.equal(call.body.by, 'agent'); }
  assert.equal(r.get('daw_render').gate, 'gpu'); assert.equal(r.get('daw_bounce').gate, 'gpu');
});

test('patch and rack catalogues remain readable but cannot install files or create VST3 inserts', async () => {
  const r = fixture();
  await r.get('daw_patches').run({ slug }); await r.get('daw_insert').run({ slug, op: 'catalog' });
  assert.deepEqual(r.calls.map(call => call.route), ['/api/daw/patches', '/api/daw/rack']);
  for (const args of [{ slug, action: 'install' }, { slug, action: 'uninstall' }, { slug, patch: 'anything' }, { slug, accept_licence: true }])
    await assert.rejects(async () => r.get('daw_patches').run(args));
  for (const args of [{ slug, op: 'add', type: 'vst3' }, { slug, op: 'add', type: 'eq', plugin: 'native' },
    { slug, op: 'add', type: 'eq', plugin_snapshot: { path: 'arbitrary' } }])
    await assert.rejects(async () => r.get('daw_insert').run(args));
  assert.equal(r.calls.length, 2);
});

test('schemas reject non-JSON, unsafe keys, large payloads, wrong types and advertised ranges', async () => {
  const r = fixture(), note = { slug, track: 't1', bar: 1, beat: 1, pitch: 60 };
  for (const patch of [{ pitch: 60.2 }, { bar: '1' }, { pitch: Infinity }, { pitch: NaN }, { track: 'a'.repeat(16385) }, { unknown: true }])
    await assert.rejects(async () => r.get('daw_add_note').run({ ...note, ...patch }));
  await assert.rejects(async () => r.get('daw_bounce').run({ slug, target_lufs: -99 }));
  await assert.rejects(async () => r.get('daw_add_track').run({ slug, instrument: 'pluck', params: JSON.parse('{"__proto__":{"user":true}}') }));
  await assert.rejects(async () => r.get('daw_add_track').run({ slug, instrument: 'pluck', params: { constructor: 'bad' } }));
  await assert.rejects(async () => r.get('daw_add_track').run({ slug, instrument: 'pluck', params: { x: undefined } }));
  let deep = {}; for (let i = 0; i < 14; i++) deep = { x: deep };
  await assert.rejects(async () => r.get('daw_add_track').run({ slug, instrument: 'pluck', params: deep }));
  assert.throws(() => validateAssistantArguments({}, { data: Array.from({ length: 2049 }, () => 1) }));
  assert.throws(() => validateAssistantArguments({}, { data: Array.from({ length: 20 }, () => 'a'.repeat(16000)) }));
  assert.equal(r.calls.length, 0);
});

test('current project reads use the exact encoded project endpoint', async () => {
  const r = fixture(); await r.get('daw_get_project').run({ slug }); await r.get('daw_ledger').run({ slug });
  assert.deepEqual(r.calls.map(call => [call.method, call.route]), [
    ['GET', `/api/daw/project/${slug}`], ['GET', `/api/daw/project/${slug}`],
  ]);
});
