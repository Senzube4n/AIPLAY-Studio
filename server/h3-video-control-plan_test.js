import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => readFile(path.join(here, '..', name), 'utf8');
const { videoPlan } = await import('./video-plain.js');
const { config } = await import('./config.js');
const eng = { ...config.video.engines.h3, fps: 24, plainBuilds: null, refBuilds: null,
  turboBuilds: { three: false, four: false, eight: true } };
const body = { prompt: 'An adult dancer turns.', width: 1344, height: 768, seconds: 5, steps: 8 };
const opts = { engineKey: 'h3', eng, h3: { card: { vramMb: 16376 } } };

test('ordinary H3 retains its measured memory estimate without a control caveat', () => {
  const result = videoPlan(body, opts);
  assert.ok(result.fit?.scope);
  assert.equal(result.notes.some(n => n.id === 'control-memory-unmeasured'), false);
});

test('each control mode returns no fitted memory claim and an explicit caveat', () => {
  for (const controlMode of ['depth', 'pose', 'prepared']) {
    const result = videoPlan({ ...body, sourceVideo: 'source.mp4', controlMode }, { ...opts, control: true });
    assert.equal(result.fit, null);
    assert.equal(result.warnings.some(w => w.id === 'fit'), false);
    const note = result.notes.find(n => n.id === 'control-memory-unmeasured');
    assert.match(note?.text || '', /not been measured/);
    assert.match(note.text, /guide extraction and the control patch/);
  }
});

test('actual MCP vram projection cannot turn an unmeasured control plan into fits:true', async () => {
  const mcp = await read('server/mcp.js');
  const expression = /^\s*vram:\s*(c\.fit\s*\?.*),\r?$/m.exec(mcp)?.[1];
  assert.ok(expression, 'actual MCP projection found');
  const project = new Function('c', 'return (' + expression + ')');
  assert.equal(project(videoPlan(body, { ...opts, control: true })), null);
  assert.equal(typeof project(videoPlan(body, opts)).fits, 'boolean');
});

const art = await read('server/art.js');
const callbackBody = /onStage: \(stage\) => \{([\s\S]*?)\n\s*\} \}\);/.exec(art)?.[1];
assert.ok(callbackBody, 'actual proposed stage callback found');
const onStage = new Function('stage', 'job', callbackBody);

test('actual prepare/extract callback resets progress and distinguishes depth from pose', () => {
  for (const mode of ['depth', 'pose']) {
    const job = { videoControl: { mode } };
    const events = [];
    const runner = { progress: 88, emit: event => events.push(event) };
    onStage.call(runner, 'cpu', job);
    assert.equal(job.controlCpu, true);
    assert.equal(job.controlPhase, 'prepare');
    assert.equal(job.note, 'Preparing control video');
    runner.progress = 30;
    onStage.call(runner, 'preprocess', job);
    assert.equal(job.controlCpu, false);
    assert.equal(job.controlPhase, 'extract');
    assert.equal(job.note, `Extracting ${mode} guide`);
    assert.equal(runner.progress, 0);
    assert.deepEqual(events, ['update', 'update']);
  }
});

test('actual render transition resets progress and public status exposes the phase', () => {
  const transition = /job\.controlReceipt = prepared\.receipt;([\s\S]*?)\/\/ These were rejected/.exec(art)?.[1];
  assert.ok(transition, 'actual render transition found');
  const job = {}, events = [], runner = { progress: 100, emit: e => events.push(e) };
  new Function('job', transition).call(runner, job);
  assert.deepEqual(job, { controlPhase: 'render', note: 'Rendering controlled video' });
  assert.equal(runner.progress, 0);
  assert.deepEqual(events, ['update']);
  assert.match(art, /controlPhase: this\.current\.controlPhase \|\| null/);
});

const app = await read('web/app.js');
const start = app.indexOf('const left = !c.controlPhase');
const end = app.indexOf('} else if (state.vidWasRendering)', start);
assert.ok(start > 0 && end > start, 'actual proposed Video progress snippet found');
const paint = new Function('c', 'pct', 'fmt', '$', app.slice(start, end));
function note(c, pct) {
  const dom = { textContent: '' };
  paint(c, pct, s => `${s}s`, id => { assert.equal(id, 'vidNowNote'); return dom; });
  return dom.textContent;
}

test('Video panel labels controlled phases and does not project whole-job ETA', () => {
  for (const [controlPhase, message] of [['prepare', 'Preparing control video'], ['extract', 'Extracting depth guide'], ['render', 'Rendering controlled video']]) {
    for (const pct of [0, 50]) {
      const text = note({ elapsed: 100, controlPhase, note: message }, pct);
      assert.match(text, new RegExp(message));
      assert.doesNotMatch(text, /loading the video model|to go/);
    }
  }
});

test('ordinary Video panel retains its cold-load line and measured-progress ETA', () => {
  assert.match(note({ elapsed: 100 }, 0), /loading the video model/);
  assert.match(note({ elapsed: 100 }, 50), /about 100s to go/);
  assert.match(note({ elapsed: 100, note: 'An ordinary informational note' }, 50), /about 100s to go/);
});
