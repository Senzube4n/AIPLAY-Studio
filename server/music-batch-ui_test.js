import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { musicBatchIdea } from '../web/music-batch-spec.js';
import { renderMusicBatchIdea, updateMusicBatchField, musicBatchSubmission, syncMusicBatchPlannerFields } from '../web/music-batch-editor.js';
import { cleanMusicItem } from './batch-music.js';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const exactLyrics = '\r\n[Verse]\r\nKeep this phrase  \r\n \r\n';
const exactScore = 'X:1\nM:4/4\nK:C\nC2 D2 E4 |  \n';
const source = () => ({ engine: 'yue2', title: 'Original', caption: 'Warm pop', lyrics: exactLyrics,
  instrumental: false, narSteps: 32, temperature: .7, abc: exactScore, scoreSlug: 'song', scoreVersion: '1',
  coverOf: { file: 'song.flac', seconds: 8, stem: 'vocals' }, seed: 1 });

function section(start, end) {
  const first = app.indexOf(start), last = app.indexOf(end, first);
  assert.ok(first >= 0 && last > first, 'actual application section remains discoverable');
  return app.slice(first, last);
}

function harness(extra = {}) {
  const fields = {}, handlers = {}, requests = [], views = [], stored = new Map();
  const $ = id => fields[id] ||= { value: '', checked: false, hidden: false, disabled: false,
    textContent: '', innerHTML: '', style: {}, dataset: {}, classList: { toggle() {} },
    focus() {}, querySelectorAll: () => [], addEventListener: (name, fn) => { handlers[id + ':' + name] = fn; } };
  $('ovWhen').value = 'now'; $('ovTakes').value = '1'; $('ovCap').value = '50';
  const ctx = vm.createContext({
    $, document: { querySelectorAll: () => [] }, structuredClone, Intl, Date,
    localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
    state: { musicEngine: 'yue2', realtimeRatio: 1, outFormat: 'flac' },
    ov: { kind: 'music', ideas: [] }, currentSpec: source, captionValue: () => 'Warm pop',
    musicBatchIdea, renderMusicBatchIdea, updateMusicBatchField, musicBatchSubmission, syncMusicBatchPlannerFields,
    ovRender() {}, ovSaveIdeas() {}, ovUpdatePlan() {}, ovPaintRuns() {}, ovPaintChain() {},
    ovPost: body => { requests.push(body); }, setView: view => views.push(view),
    esc: value => String(value), dur: value => String(value), size: value => String(value), clock: value => String(value),
    appConfirm: async () => false, ...extra,
  });
  return { ctx, fields, $, handlers, requests, views, stored };
}

function loadScheduler(h) {
  vm.runInContext(section('function ovScheduledStart() {', 'function applyBatch(s) {'), h.ctx);
}

test('the kept Music action area opens an empty batch in Simple without requiring or adding a prompt', () => {
  // Simple hides direct form children and .ctawrap > .cta. This sibling remains visible.
  const create = html.slice(html.indexOf('<section class="create'), html.indexOf('id="ovPanel"'));
  assert.match(create, /<div class="ctawrap">[\s\S]*<\/div>\s*<div class="music-batch-entry" id="musicBatchEntry">[\s\S]*id="btnMusicBatch"/);
  const h = harness({ captionValue: () => '' });
  vm.runInContext(section('function ovMusicIdea() {', '$("btnCreate").onclick'), h.ctx);
  h.$('btnMusicBatch').onclick();
  assert.deepEqual(h.views, ['overnight']);
  assert.equal(h.ctx.ov.ideas.length, 0);
  h.$('btnToOvernight').onclick();
  assert.equal(h.ctx.ov.ideas.length, 0);
  assert.equal(h.requests.length, 0);
});

test('2/4/8 song presets preserve entered ideas and create independent editable snapshots', () => {
  const h = harness();
  vm.runInContext(section('function ovMusicIdea() {', '$("btnToOvernight").onclick'), h.ctx);
  vm.runInContext(section('$("ovAdd").onclick = () => {', '$("ovClear").onclick'), h.ctx);
  h.ctx.ovFillSongCount(2);
  h.ctx.ov.ideas[0] = updateMusicBatchField(h.ctx.ov.ideas[0], 'caption', 'Quiet acoustic folk');
  h.ctx.ovFillSongCount(4); h.ctx.ovFillSongCount(8);
  assert.equal(h.ctx.ov.ideas.length, 8);
  assert.equal(h.ctx.ov.ideas[0].caption, 'Quiet acoustic folk');
  for (let i = 0; i < 8; i++) {
    let idea = h.ctx.ov.ideas[i];
    for (const dropped of ['abc', 'scoreSlug', 'scoreVersion', 'coverOf', 'seed']) assert.equal(Object.hasOwn(idea, dropped), false);
    idea = updateMusicBatchField(idea, 'title', 'Song ' + i);
    idea = updateMusicBatchField(idea, 'caption', 'Different genre ' + i);
    idea = updateMusicBatchField(idea, 'lyrics', exactLyrics + i + '  ');
    idea = updateMusicBatchField(idea, 'temperature', String(.1 + i / 10));
    h.ctx.ov.ideas[i] = idea;
    const accepted = cleanMusicItem(idea);
    assert.equal(accepted.lyrics, exactLyrics + i + '  ');
    assert.equal(accepted.title, 'Song ' + i);
    assert.equal(accepted.temperature, .1 + i / 10);
  }
  assert.equal(new Set(h.ctx.ov.ideas.map(idea => idea.caption)).size, 8);
  assert.equal(new Set(h.ctx.ov.ideas).size, 8);
  h.ctx.ovFillSongCount(2);
  assert.equal(h.ctx.ov.ideas.length, 8, 'a smaller preset does not discard edited songs');
});

test('editing one field preserves exact conditioning and nested references while optional controls keep Automatic', () => {
  const original = musicBatchIdea(source());
  const changed = updateMusicBatchField(original, 'title', 'Edited title');
  assert.equal(changed.lyrics, exactLyrics); assert.equal(changed.abc, exactScore);
  assert.deepEqual(changed.coverOf, original.coverOf);
  changed.coverOf.seconds = 4;
  assert.equal(original.coverOf.seconds, 8);
  assert.equal(Object.hasOwn(updateMusicBatchField(original, 'abcOpen', ''), 'abcOpen'), false);
  assert.equal(updateMusicBatchField(original, 'abcOpen', 'false').abcOpen, false);
  assert.equal(updateMusicBatchField(original, 'abcOpen', 'true').abcOpen, true);
  assert.throws(() => updateMusicBatchField(original, 'abcOpen', 'wrong'));
  const escaped = renderMusicBatchIdea({ ...original, title: '<script>"', lyrics: '</textarea><script>' }, 0);
  assert.ok(!escaped.includes('<script>'));
  assert.match(escaped, /&lt;\/textarea&gt;&lt;script&gt;/);
  assert.match(escaped, /data-ov-field="abcOpen" class="sel2"><option value="">Automatic/);
  const comfy = renderMusicBatchIdea({ engine: 'yue2-comfy', caption: 'Pop', cfgScale: 1 }, 0);
  assert.ok(!comfy.includes('data-ov-field="cfgScale"'));
  assert.match(comfy, /data-ov-field="narSteps"[^>]*min="8" max="64"/);
  const python = renderMusicBatchIdea(original, 0);
  assert.match(python, /data-ov-field="narSteps" class="sel2">[\s\S]*value="16"/);
  const gguf = renderMusicBatchIdea({ engine: 'yue2-gguf', caption: 'Pop', lyrics: exactLyrics }, 0);
  assert.ok(!gguf.includes('data-ov-field="instrumental"'));
  assert.match(gguf, /data-ov-field="lyrics"[^>]*required/);
  assert.throws(() => updateMusicBatchField({ ...original, instrumental: true }, 'engine', 'yue2-gguf'), /Turn off Instrumental/);
});

test('changing a captured engine requires confirmation before clearing its score and references', async () => {
  let approve = false, asked = '';
  const h = harness({ appConfirm: async text => { asked = text; return approve; } });
  h.ctx.ov.ideas = [musicBatchIdea(source())];
  vm.runInContext(section('$("ovIdeas").addEventListener("input"', '$("ovTakes").oninput'), h.ctx);
  const card = { dataset: { ovIdea: '0' } };
  const input = { dataset: { ovField: 'engine' }, value: 'ace-step15', type: 'select-one',
    closest: selector => selector === '[data-ov-idea]' ? card : input };
  await h.handlers['ovIdeas:input']({ target: input });
  assert.match(asked, /saved score, references and engine settings/);
  assert.equal(input.value, 'yue2');
  assert.equal(h.ctx.ov.ideas[0].abc, exactScore);
  approve = true; input.value = 'ace-step15';
  await h.handlers['ovIdeas:input']({ target: input });
  assert.equal(h.ctx.ov.ideas[0].engine, 'ace-step15');
  assert.equal(h.ctx.ov.ideas[0].lyrics, exactLyrics);
  assert.equal(Object.hasOwn(h.ctx.ov.ideas[0], 'abc'), false);
  assert.equal(Object.hasOwn(h.ctx.ov.ideas[0], 'coverOf'), false);
});

test('GGUF and Comfy planner context changes disable unused dials and submit requests accepted by the song door', async () => {
  for (const engine of ['yue2-gguf', 'yue2-comfy']) {
    const original = { engine, caption: 'Warm pop', lyrics: exactLyrics, cot: 'full', narSteps: 32,
      temperature: .8, planTemperature: .7, planTopP: .85 };
    cleanMusicItem(original);
    const off = updateMusicBatchField(original, 'cot', 'off');
    const scored = updateMusicBatchField(original, 'abc', exactScore);
    for (const changed of [off, scored]) {
      assert.equal(Object.hasOwn(changed, 'planTemperature'), false);
      assert.equal(Object.hasOwn(changed, 'planTopP'), false);
      assert.equal(cleanMusicItem(changed).temperature, .8);
      assert.equal(changed.lyrics, exactLyrics);
      assert.match(renderMusicBatchIdea(changed, 0), /data-ov-field="planTemperature"[^>]*disabled/);
      assert.match(renderMusicBatchIdea(changed, 0), /data-ov-field="planTopP"[^>]*disabled/);
    }
    assert.equal(scored.abc, exactScore);
    const backToFull = updateMusicBatchField(off, 'cot', 'full');
    const clearedScore = updateMusicBatchField(scored, 'abc', '');
    for (const restored of [backToFull, clearedScore]) {
      assert.ok(!/data-ov-field="planTemperature"[^>]*disabled/.test(renderMusicBatchIdea(restored, 0)));
      cleanMusicItem(updateMusicBatchField(restored, 'planTemperature', '.9'));
    }

    // Exercise the real delegated handler without rerendering the ABC textarea.
    const h = harness();
    h.ctx.ov.ideas = [original];
    vm.runInContext(section('$("ovIdeas").addEventListener("input"', '$("ovTakes").oninput'), h.ctx);
    const fields = ['planTemperature', 'planTopP'].map(key => ({ dataset: { ovField: key }, value: String(original[key]) }));
    const chip = {}, note = {};
    const card = { dataset: { ovIdea: '0' }, querySelectorAll: () => fields,
      querySelector: selector => selector === '.chip' ? chip : note };
    const input = { dataset: { ovField: 'abc' }, value: exactScore, type: 'textarea',
      closest: selector => selector === '[data-ov-idea]' ? card : input };
    await h.handlers['ovIdeas:input']({ target: input });
    assert.ok(fields.every(field => field.disabled && field.value === ''));
    assert.equal(note.hidden, false);
    assert.equal(note.textContent, 'Planner off for this score.');
    assert.equal(h.ctx.ov.ideas[0].abc, exactScore);

    // Old saved cards may still carry unused dials. Start cleans its copied payload too.
    h.ctx.ov.ideas = [{ ...original, abc: exactScore }];
    loadScheduler(h);
    h.$('ovStart').onclick();
    const submitted = h.requests[0].items[0];
    cleanMusicItem(submitted);
    assert.equal(Object.hasOwn(submitted, 'planTemperature'), false);
    assert.equal(Object.hasOwn(submitted, 'planTopP'), false);
    assert.equal(submitted.abc, exactScore);
    assert.equal(h.ctx.ov.ideas[0].planTemperature, .7, 'submission does not mutate the saved card');
  }
  const python = { engine: 'yue2', caption: 'Pop', lyrics: exactLyrics, cot: 'full', planTemperature: .7 };
  assert.equal(updateMusicBatchField(python, 'abc', exactScore).planTemperature, .7);
});

test('Now omits startAt, Later sends UTC, and blank or invalid cards never submit', () => {
  const h = harness();
  loadScheduler(h);
  h.ctx.ov.ideas = [{ engine: 'yue2', caption: 'Pop', lyrics: exactLyrics }];
  h.$('ovStart').onclick();
  assert.equal(h.requests.length, 1);
  assert.equal(Object.hasOwn(h.requests[0], 'startAt'), false);
  h.$('ovWhen').value = 'later'; h.$('ovStartAt').value = '2099-06-12T18:30';
  h.$('ovStart').onclick();
  assert.equal(h.requests[1].startAt, new Date('2099-06-12T18:30').toISOString());
  assert.equal(h.requests[1].items[0].lyrics, exactLyrics);
  h.$('ovStartAt').value = '';
  h.$('ovStart').onclick();
  assert.equal(h.requests.length, 2);
  h.$('ovWhen').value = 'now'; h.ctx.ov.ideas.push({ engine: 'yue2', caption: '  ' });
  h.$('ovStart').onclick();
  assert.equal(h.requests.length, 2);
  assert.equal(h.$('ovEst').textContent, 'Add a style to every song.');
  h.ctx.ov.ideas.pop();
  let opened = false, reported = false;
  const fold = { set open(value) { opened = value; }, parentElement: null };
  h.$('ovIdeas').querySelectorAll = () => [{ checkValidity: () => false, reportValidity: () => { reported = true; }, closest: () => fold }];
  h.$('ovStart').onclick();
  assert.equal(h.requests.length, 2); assert.equal(opened, true); assert.equal(reported, true);
});

test('local scheduling rejects daylight-saving gaps instead of moving the requested time', () => {
  const script = 'import vm from "node:vm"; const code=' + JSON.stringify(section('function ovScheduledStart() {', 'function ovSchedulePaint() {')) +
    '; const c=vm.createContext({Date,$:id=>({value:id==="ovWhen"?"later":"2099-03-29T02:30"})});' +
    'vm.runInContext(code,c);try{c.ovScheduledStart();process.exit(2)}catch(e){if(!e.message.includes("does not exist"))throw e}';
  // The last Sunday of March 2099 is the 29th; Brussels skips 02:00 to 03:00.
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: 'Europe/Brussels' }, stdio: 'pipe' });
});

test('all plan repaints preserve eligibility and Later estimates finish from the scheduled start', () => {
  const h = harness();
  loadScheduler(h);
  vm.runInContext(section('function ovUpdatePlan() {', '/**\n * What the whole plan costs'), h.ctx);
  vm.runInContext(section('const OV_COST = {', '/** Past runs'), h.ctx);
  h.ctx.ov.ideas = [{ engine: 'yue2', caption: '' }];
  h.ctx.ovPaintPlan();
  assert.equal(h.$('ovStart').disabled, true);
  h.$('ovStCover').onchange();
  assert.equal(h.$('ovStart').disabled, true);
  h.ctx.ov.ideas[0].caption = 'Pop';
  h.$('ovWhen').value = 'later'; h.$('ovStartAt').value = '';
  h.ctx.ovPaintPlan();
  assert.equal(h.$('ovStart').disabled, true);
  h.$('ovStartAt').value = '2099-06-12T18:30';
  h.ctx.ovUpdatePlan();
  assert.equal(h.$('ovStart').disabled, false);
  const expectedFinish = Date.parse(h.ctx.ovScheduledStart()) + 150000;
  assert.ok(h.$('ovEst').textContent.endsWith(String(expectedFinish)));
  assert.equal(h.$('ovTotalCount').textContent, '1 song planned · 1 idea × 1 take');
  h.$('ovTakes').value = '4'; h.$('ovCap').value = '2';
  h.ctx.ovUpdatePlan();
  assert.equal(h.$('ovTotalCount').textContent, '2 songs planned · 1 idea × 4 takes');
});

test('Songs/Images kind switching loads the target list before rendering or saving it', () => {
  const buttons = ['music', 'image', 'video'].map(kind => ({ dataset: { kind }, classList: { toggle() {} } }));
  const h = harness({ document: { querySelectorAll: selector => selector.includes('data-kind') ? buttons : [] } });
  h.ctx.ov.ideas = [{ engine: 'yue2', caption: 'Music saved' }];
  h.stored.set('aiplayIdeas', JSON.stringify(h.ctx.ov.ideas));
  h.stored.set('aiplayIdeasImage', JSON.stringify([{ prompt: 'Image saved', engine: 'flux2' }]));
  vm.runInContext(section('function ovSetKind(k) {', 'function ovRender() {'), h.ctx);
  h.ctx.ovRender = () => h.ctx.ovSaveIdeas();
  const loop = app.indexOf('  b.onclick = () => { ovSaveIdeas();');
  vm.runInContext(app.slice(app.lastIndexOf('for (const b', loop), app.indexOf('function ovScheduledStart()', loop)), h.ctx);
  buttons[1].onclick();
  assert.equal(h.ctx.ov.ideas[0].prompt, 'Image saved');
  assert.equal(JSON.parse(h.stored.get('aiplayIdeas'))[0].caption, 'Music saved');
  buttons[0].onclick();
  assert.equal(h.ctx.ov.ideas[0].caption, 'Music saved');
  assert.equal(JSON.parse(h.stored.get('aiplayIdeasImage'))[0].prompt, 'Image saved');
});

test('scheduled live controls support Pause/Start now/Stop and reset after clearing', () => {
  const h = harness();
  loadScheduler(h);
  vm.runInContext(section('function applyBatch(s) {', '/* What each song is still owed'), h.ctx);
  h.ctx.applyBatch({ run: { state: 'scheduled', startAt: Date.parse('2099-06-12T18:30:00Z'), done: 0, total: 8 } });
  assert.equal(h.$('ovPip').hidden, false);
  assert.equal(h.$('ovStartNow').hidden, false);
  assert.equal(h.$('ovPause').hidden, false);
  h.$('ovPause').onclick(); h.$('ovStartNow').onclick(); h.$('ovStop').onclick();
  assert.deepEqual(h.requests.map(request => request.action), ['pause', 'resume', 'stop']);
  h.ctx.applyBatch({ run: { state: 'paused', done: 0, total: 8 } });
  assert.equal(h.$('ovPause').textContent, 'Resume');
  assert.match(h.$('ovPause').title, /starts the batch now/);
  h.$('ovPause').onclick();
  assert.equal(h.requests.at(-1).action, 'resume');
  h.ctx.applyBatch({ run: null });
  assert.equal(h.$('ovStartNow').hidden, true);
  assert.equal(h.$('ovPause').hidden, true);
  assert.equal(h.$('ovStop').hidden, true);
});
