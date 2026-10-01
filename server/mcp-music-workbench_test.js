import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { musicWorkbenchTools } from './mcp-music-workbench.js';
import { guideTools } from './mcp-guide.js';

const uuid = 'e'.repeat(32);
function harness(response = { ok: true, run: { id: uuid, state: 'running' } }) {
  const calls = [], tools = musicWorkbenchTools(async (...args) => { calls.push(args); return response; });
  return { calls, tools, get: (name) => tools.find((tool) => tool.name === name) };
}
const cases = [
  ['music_workbench_run', 'read', { run: uuid }],
  ['music_workbench_stop', 'stop', {}],
  ['music_native_install', 'install', { kind: 'midi', size: 'medium' }],
  ['music_dataset_create', 'dataset', { name: 'Test dataset', files: ['take.flac', 'second.wav'] }],
  ['music_dataset_edit', 'edit', { id: uuid, item: 'song_0', style: 'Gentle acoustic', lyrics: '[Verse]\nHold on  \n', instrumental: false }],
  ['music_dataset_prepare', 'prepare', { dataset: uuid }],
  ['music_native_train', 'train', { dataset: uuid, recipe: { preset: 'custom', steps: 250, accumulation: 3,
    optimizer: 'adamw', adapter: 'lokr', rank: 8, alpha: 64, lokrDim: 32, lokrFactor: 4,
    learningRate: .001, targetKl: .02, seed: 987, saveEvery: 50 } }],
  ['music_native_continue', 'continue', { run: uuid, steps: 600 }],
  ['music_native_plan', 'plan', { style: 'Gentle acoustic', lyrics: '[Verse]\nHold on  \n', stage: 'audio', seed: 123,
    abc: 'X:1\nM:4/4\nL:1/4\nK:C\nV:1\nC D E F |', quantization: 'q8_0', narSteps: 16, maxTokens: 800 }],
  ['music_native_replay', 'replay', { run: uuid, abc: 'X:1\nK:C\nC D E F |', useTokens: false, seed: 125 }],
  ['music_native_keep', 'keepSong', { run: uuid }],
  ['music_audio_transcribe', 'midi', { file: 'take.flac', size: 'large', device: 'cpu' }],
  ['music_midi_to_daw', 'toDaw', { run: uuid, bpm: 128 }],
  ['music_adapter_export', 'exportAdapter', { run: uuid }],
  ['music_adapter_install', 'installAdapter', { run: uuid }],
  ['music_process_preview', 'process', { file: 'take.flac', reference: 'reference.wav', denoise: true, smoothing: .5,
    plugins: [{ path: path.resolve('plugins', 'Master.vst3'), parameters: { gain: .4, bypass: false, mode: 'Clean' } }] }],
  ['music_process_keep', 'keep', { run: uuid }],
];

test('all native workbench actions have registered typed tools and forward every supplied control to the existing API', async () => {
  const h = harness();
  assert.equal(h.tools.length, 18);
  assert.equal(new Set(h.tools.map((tool) => tool.name)).size, 18);
  for (const tool of h.tools) {
    assert.ok(tool.description.length > 30 && tool.description.length <= 280, `${tool.name} stays within its catalogue text budget`);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok((tool.inputSchema.required || []).every((key) => Object.hasOwn(tool.inputSchema.properties, key)));
  }
  await h.get('music_workbench_status').run({});
  assert.deepEqual(h.calls[0], ['GET', '/api/music-tools']);
  for (const [name, action, args] of cases) {
    await h.get(name).run(args);
    assert.deepEqual(h.calls.at(-1), ['POST', '/api/music-tools', { action, ...args }, 900_000], name);
  }
  const { TOOLS } = await import('./mcp.js');
  for (const tool of h.tools) assert.equal(TOOLS.filter((registered) => registered.name === tool.name).length, 1, `${tool.name} is reachable on the real MCP surface`);
});

test('exact lyric whitespace and prior-token replay survive the typed boundary without invented settings', async () => {
  const h = harness(), lyrics = '[Verse]\nHold on  \n\n';
  await h.get('music_native_plan').run({ style: 'Gentle acoustic', lyrics, stage: 'semantic' });
  assert.equal(h.calls[0][2].lyrics, lyrics);
  assert.deepEqual(Object.keys(h.calls[0][2]).sort(), ['action', 'lyrics', 'stage', 'style']);
  await h.get('music_native_replay').run({ run: uuid, useTokens: true, seed: 1 });
  assert.equal(h.calls[1][2].useTokens, true);
  assert.equal(Object.hasOwn(h.calls[1][2], 'abc'), false);
  await assert.rejects(h.get('music_native_replay').run({ run: uuid, useTokens: true, abc: 'X:1\nK:C\nC|' }), /fresh semantic/);
  assert.equal(h.calls.length, 2);
});

test('dataset creation accepts one local source type and never forwards traversal or unsupported fields', async () => {
  const h = harness();
  await h.get('music_dataset_create').run({ folder: path.resolve('fixtures', 'training'), name: 'My dataset' });
  assert.equal(h.calls[0][2].folder, path.resolve('fixtures', 'training'));
  for (const args of [{}, { files: ['take.flac'], folder: path.resolve('training') }, { folder: 'relative/folder' },
    { files: ['../take.wav'] }, { files: ['..\\take.wav'] }, { files: ['take..wav'] }, { files: ['take.wav', 'take.wav'] },
    { files: ['take.wav'], unsupported: true }]) await assert.rejects(h.get('music_dataset_create').run(args));
  assert.equal(h.calls.length, 1);
  assert.equal((await h.get('music_dataset_edit').run({ id: uuid, item: 'song_1', style: 'Jazz', lyrics: '', instrumental: true })).ok, true);
  assert.equal(h.calls.at(-1)[2].instrumental, true);
});

test('shared planner and recipe constraints refuse invalid or ignored controls before the API', async () => {
  const h = harness();
  const plans = [{ style: ' ', lyrics: 'hello' }, { style: 'Jazz', lyrics: ' ' },
    { style: 'Jazz', lyrics: 'hello', stage: 'abc', abc: 'X:1\nK:C\nC|' },
    { style: 'Jazz', lyrics: 'hello', maxTokens: 9001 }, { style: 'Jazz', lyrics: 'hello', stage: 'latent' },
    { style: 'Jazz', lyrics: 'hello', instrumental: true }];
  for (const args of plans) await assert.rejects(h.get('music_native_plan').run(args));
  for (const recipe of [{ preset: 'balanced', steps: 2 }, { optimizer: 'muon' }, { preset: 'custom', unknown: 1 },
    { preset: 'custom', adapter: 'lora', lokrDim: 16 }, { preset: 'custom', optimizer: 'prodigy', learningRate: .001 }]) {
    await assert.rejects(h.get('music_native_train').run({ dataset: uuid, recipe }));
  }
  await assert.rejects(h.get('music_native_install').run({ kind: 'planner', size: 'large' }), /MIDI/);
  assert.equal(h.calls.length, 0);
  await h.get('music_native_train').run({ dataset: uuid, recipe: { preset: 'fast' } });
  assert.deepEqual(h.calls[0][2].recipe, { preset: 'fast' });
});

test('nonfinite, wrong-type and out-of-range numeric controls fail even when MCP schema validation is bypassed', async () => {
  const h = harness();
  for (const bad of [NaN, Infinity, -Infinity, '128', null]) {
    for (const [name, args] of [
      ['music_native_plan', { style: 'Jazz', lyrics: 'hello', seed: bad }],
      ['music_native_plan', { style: 'Jazz', lyrics: 'hello', narSteps: bad }],
      ['music_native_plan', { style: 'Jazz', lyrics: 'hello', maxTokens: bad }],
      ['music_native_replay', { run: uuid, seed: bad }],
      ['music_native_train', { dataset: uuid, recipe: { preset: 'custom', targetKl: bad } }],
      ['music_native_train', { dataset: uuid, recipe: { preset: 'custom', learningRate: bad } }],
      ['music_native_continue', { run: uuid, steps: bad }],
      ['music_midi_to_daw', { run: uuid, bpm: bad }],
      ['music_process_preview', { file: 'take.flac', smoothing: bad }],
      ['music_process_preview', { file: 'take.flac', plugins: [{ path: path.resolve('Master.vst3'), parameters: { gain: bad } }] }],
    ]) {
      // Numeric-looking strings are legitimate enum-like plugin parameter values.
      if (name === 'music_process_preview' && args.plugins && typeof bad === 'string') continue;
      await assert.rejects(h.get(name).run(args), undefined, `${name} rejects ${String(bad)}`);
    }
  }
  await assert.rejects(h.get('music_native_plan').run({ style: 'Jazz', lyrics: 'hello', seed: Number.MAX_SAFE_INTEGER + 1 }));
  await assert.rejects(h.get('music_native_continue').run({ run: uuid, steps: 1.5 }));
  await assert.rejects(h.get('music_process_preview').run({ file: 'take.flac', smoothing: 1.1 }));
  assert.equal(h.calls.length, 0);
});

test('every tool rejects undeclared arguments; bool and nested VST inputs are enforced', async () => {
  const h = harness();
  for (const [name, , args] of cases) await assert.rejects(h.get(name).run({ ...args, futureControl: true }), /Unsupported/);
  await assert.rejects(h.get('music_workbench_status').run({ render: true }), /Unsupported/);
  for (const args of [{ file: 'take.flac', denoise: 'yes' }, { file: 'take.flac', plugins: [{ path: 'relative.vst3' }] },
    { file: 'take.flac', plugins: [{ path: path.resolve('Master.dll') }] },
    { file: 'take.flac', plugins: [{ path: path.resolve('Master.vst3'), executable: true }] },
    { file: 'take.flac', plugins: [{ path: path.resolve('Master.vst3'), parameters: { nested: {} } }] },
    { file: 'take.flac', plugins: Array.from({ length: 13 }, () => ({ path: path.resolve('Master.vst3') })) }]) {
    await assert.rejects(h.get('music_process_preview').run(args));
  }
  assert.equal(h.calls.length, 0);
});

test('backend refusals and transport errors remain visible rather than appearing successful', async () => {
  const h = harness({ error: 'Wait for the current render to finish.' });
  await assert.rejects(h.get('music_native_plan').run({ style: 'Jazz', lyrics: 'hello' }), /current render/);
  await assert.rejects(h.get('music_workbench_status').run({}), /current render/);
  const tools = musicWorkbenchTools(async () => { throw new Error('Studio is offline'); });
  await assert.rejects(tools.find((tool) => tool.name === 'music_workbench_run').run({ run: uuid }), /offline/);
});

test('workbench guide is discoverable and distinguishes existing tools from experiments', async () => {
  const guide = guideTools()[0];
  assert.ok(guide.inputSchema.properties.topic.enum.includes('music-workbench'));
  const result = await guide.run({ topic: 'music-workbench' });
  assert.match(result.guide, /Music Lab > Native tools/);
  assert.match(result.guide, /Score view/);
  assert.match(result.guide, /Ozone-equivalent/);
  assert.ok(result.guide.length <= 3700, 'the focused workflow guide stays bounded');
  const h = harness();
  for (const tool of h.tools) assert.ok(result.guide.includes(`\`${tool.name}\``), `${tool.name} has a discovery entry`);
  const gate = readFileSync(new URL('../.githooks/pre-commit', import.meta.url), 'utf8');
  assert.ok(gate.includes('server/mcp-music-workbench_test.js'));
});
