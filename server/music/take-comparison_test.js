import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { comparisonGains, createTakeComparisons, createTakeComparisonRoutes } from './take-comparison.js';
import { comparisonPlaybackVolume, mountMusicTakeComparison } from '../../web/music-take-comparison.js';

const HASH = 'a'.repeat(64), OTHER = 'b'.repeat(64);
async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aiplay-takes-')); t.after(() => rm(dir, { force: true, recursive: true }));
  const sources = new Map(Array.from({ length: 8 }, (_, index) => [`aiplay_${index}.flac`, { title: `Song ${index}`, seconds: 60 + index, sha256: HASH }]));
  const metadata = new Map([...sources.keys()].map((file, index) => [file, { seed: index ? 420 + index : 0, lyrics: '[Verse]\r\nHold on  \r\n\r\n', caption: 'Warm\n  folk',
    engine: index % 2 ? 'yue2-gguf' : 'yue2', narSteps: 24, request: { abc: 'X:1\nK:C\nC D E F |  \n', instrumental: false } }]));
  const measurements = new Map([...sources.keys()].map((file, index) => [file, { loudness: { integrated: -10 - index, true_peak_db: -.2 - index / 2 } }]));
  const events = [], flags = [], measuredFiles = [];
  const dependencies = { appData: dir, listSongs: async () => [...sources].map(([file, source]) => ({ file, title: source.title, durationSeconds: source.seconds })),
    inspectSource: async file => structuredClone(sources.get(file)), sourceReceipt: async file => ({ metadata: structuredClone(metadata.get(file)),
      provenance: { events: [{ asset: file, data: { seed: metadata.get(file).seed } }], corrupt: 0 } }),
    measureSource: async file => { measuredFiles.push(file); return structuredClone(measurements.get(file)); },
    setFavourite: async (file, value) => flags.push({ file, value }), recordEvent: async event => events.push(event), now: () => 1000, ...options };
  const store = createTakeComparisons(dependencies);
  const body = (n = 2) => ({ action: 'create', name: 'Chorus choices', idempotencyKey: `set-${n}`, files: [...sources.keys()].slice(0, n) });
  return { dir, store, sources, metadata, measurements, events, flags, measuredFiles, dependencies, body,
    create: async (n = 2) => (await store.request(body(n), 'agent:test')).comparison };
}

test('2/4/8 saved recordings preserve exact receipts and survive restart without rendering', async t => {
  const f = await fixture(t);
  for (const count of [2, 4, 8]) {
    const row = await f.create(count); assert.equal(row.takes.length, count); assert.equal(row.revision, 1);
    assert.equal(row.takes[0].receipt.metadata.seed, 0); assert.equal(row.takes[0].receipt.metadata.lyrics, '[Verse]\r\nHold on  \r\n\r\n');
    assert.equal(row.takes[0].receipt.metadata.request.abc, 'X:1\nK:C\nC D E F |  \n');
    const disk = JSON.parse(await readFile(path.join(f.dir, 'music-take-comparisons', `${row.id}.json`), 'utf8'));
    assert.equal(disk.takes[0].receiptHash, row.takes[0].receiptHash);
    const restarted = createTakeComparisons(f.dependencies), reopened = (await restarted.request({ action: 'get', id: row.id })).comparison;
    assert.deepEqual(reopened, row); assert.equal(reopened.takes[0].audioUrl.includes(HASH), true);
  }
  assert.equal(f.measuredFiles.length, 14); assert.equal(f.flags.length, 0); assert.equal(f.events.filter(event => event.data.op === 'take-comparison-create').length, 3);
});

test('shared gain plan matches LUFS, stays bounded, attenuates only and protects every peak', () => {
  const facts = [{ integrated: -8, truePeakDb: -.1 }, { integrated: -18, truePeakDb: -8 }];
  const plan = comparisonGains(facts.map(measurement => ({ measurement })));
  for (const [index, take] of plan.takes.entries()) {
    assert.ok(take.gainDb >= -24 && take.gainDb <= 0); assert.ok(take.volume > 0 && take.volume <= 1);
    assert.ok(take.expectedPeakDb <= -1.1 + 1e-9); assert.ok(Math.abs(facts[index].integrated + take.gainDb - plan.targetLufs) < 1e-9);
  }
  assert.throws(() => comparisonGains([{ measurement: { integrated: null, truePeakDb: -80 } }, { measurement: facts[0] }]), /no usable/);
  assert.throws(() => comparisonGains([{ measurement: { integrated: -60, truePeakDb: -20 } }, { measurement: facts[0] }]), /24 dB/);
  assert.throws(() => comparisonGains([{ measurement: facts[0] }]), /2, 4 or 8/);
  assert.equal(comparisonPlaybackVolume(-6, .8), 10 ** (-6 / 20) * .8);
  for (const [gain, volume] of [[1, 1], [-25, 1], [0, 2], [NaN, 1], [0, -1]]) assert.equal(comparisonPlaybackVolume(gain, volume), 0);
});

test('creation retries reuse measurements and immutable receipts rather than adopting newer metadata', async t => {
  const f = await fixture(t), row = await f.create(); f.metadata.get(row.takes[0].file).lyrics = 'Different lyrics';
  const retry = await f.store.request(f.body(), 'agent:test'); assert.equal(retry.replayed, true); assert.deepEqual(retry.comparison, row);
  const input = f.body(); assert.equal((await f.store.request({ files: input.files, idempotencyKey: input.idempotencyKey, action: input.action, name: input.name })).replayed, true);
  assert.equal(f.measuredFiles.length, 2);
  await assert.rejects(f.store.request({ ...f.body(), name: 'Another title' }), /different comparison/);
  f.sources.get(row.takes[0].file).sha256 = OTHER;
  await assert.rejects(f.store.request(f.body()), /missing or changed/);
});

test('source replacement refuses verification, audio URLs and choices while retaining history', async t => {
  const f = await fixture(t), row = await f.create();
  assert.equal((await f.store.request({ action: 'verify', id: row.id })).verified, true);
  assert.deepEqual(await f.store.audio({ id: row.id, takeId: 'A', sha256: HASH }), { file: row.takes[0].file, sha256: HASH });
  await assert.rejects(f.store.audio({ id: row.id, takeId: 'A', sha256: OTHER }), /stale/);
  f.sources.get(row.takes[1].file).sha256 = OTHER;
  await assert.rejects(f.store.request({ action: 'verify', id: row.id }), /missing or changed/);
  await assert.rejects(f.store.audio({ id: row.id, takeId: 'B', sha256: HASH }), /missing or changed/);
  await assert.rejects(f.store.request({ action: 'choose', id: row.id, expectedRevision: 1, takeId: 'A' }), /missing or changed/);
  assert.equal(f.flags.length, 0); assert.equal((await f.store.request({ action: 'get', id: row.id })).comparison.revision, 1);
});

test('a recording changing during measurement never produces a saved comparison', async t => {
  let f;
  f = await fixture(t, { measureSource: async file => { f.sources.get(file).sha256 = OTHER; return { integrated: -14, truePeakDb: -2 }; } });
  await assert.rejects(f.create(), /missing or changed/);
  assert.equal((await f.store.list()).comparisons.length, 0); assert.equal(f.events.length, 0);
});

test('concurrent choices require the latest revision and explicitly save actor, favourite and source receipt', async t => {
  const f = await fixture(t), row = await f.create();
  const choices = await Promise.allSettled(['A', 'B'].map(takeId => f.store.request({ action: 'choose', id: row.id, expectedRevision: 1, takeId }, 'agent:test')));
  assert.equal(choices.filter(choice => choice.status === 'fulfilled').length, 1); assert.equal(choices.filter(choice => choice.status === 'rejected')[0].reason.status, 409);
  let next = (await f.store.request({ action: 'get', id: row.id })).comparison;
  assert.equal(next.chosen.takeId, 'A'); assert.equal(next.chosen.sha256, HASH); assert.equal(next.chosen.actor, 'agent:test');
  assert.deepEqual(f.flags, [{ file: row.takes[0].file, value: true }]);
  next = (await f.store.request({ action: 'choose', id: row.id, expectedRevision: 2, takeId: 'B', favourite: false }, 'user')).comparison;
  assert.equal(next.revision, 3); assert.equal(next.choices.length, 2); assert.equal(next.chosen.favourite, false);
  assert.equal(f.flags.at(-1).value, false); assert.equal(f.events.at(-1).data.receiptHash, row.takes[1].receiptHash);
});

test('invalid files, duplicates, cardinality and unsupported fields cannot write or measure', async t => {
  const f = await fixture(t);
  for (const files of [['../outside.wav', 'aiplay_1.flac'], ['C:\\outside.wav', 'aiplay_1.flac'], ['aiplay_0.flac', 'aiplay_0.flac'], [...f.sources.keys()].slice(0, 3)])
    await assert.rejects(f.store.request({ ...f.body(), files }));
  await assert.rejects(f.store.request({ ...f.body(), seed: 11 }), /Unsupported/);
  await assert.rejects(f.store.request({ ...f.body(), files: ['missing.flac', 'aiplay_1.flac'] }), /present in the song library/);
  assert.equal(f.measuredFiles.length, 0); assert.equal((await f.store.list()).comparisons.length, 0);
});

test('tampered receipt and invalid records stay on disk and are reported without replacement', async t => {
  const f = await fixture(t), row = await f.create(), filename = path.join(f.dir, 'music-take-comparisons', `${row.id}.json`);
  const saved = JSON.parse(await readFile(filename, 'utf8')); saved.takes[0].receipt.metadata.seed = 99;
  await writeFile(filename, JSON.stringify(saved)); const before = await readFile(filename, 'utf8');
  await assert.rejects(f.store.request({ action: 'get', id: row.id }), /receipt is invalid/);
  await assert.rejects(f.create(), /receipt is invalid/);
  assert.equal((await f.store.list()).errors.length, 1); assert.equal(await readFile(filename, 'utf8'), before);
});

test('failed favourite persistence does not invent a successful comparison choice', async t => {
  const f = await fixture(t, { setFavourite: async () => { throw new Error('Disk unavailable'); } }), row = await f.create();
  await assert.rejects(f.store.request({ action: 'choose', id: row.id, expectedRevision: 1, takeId: 'B' }), /Disk unavailable/);
  const saved = (await f.store.request({ action: 'get', id: row.id })).comparison;
  assert.equal(saved.chosen, null); assert.equal(saved.choices.length, 0); assert.equal(saved.revision, 1); assert.equal(f.events.length, 1);
});

test('shared route validates audio membership, method and source before delegating range serving', async t => {
  const f = await fixture(t), row = await f.create(), replies = [], served = [];
  const route = createTakeComparisonRoutes({ ...f.dependencies, json: (res, status, data) => replies.push({ status, data }), readBody: async req => req.body,
    actorFrom: req => req.actor || 'user', serveAudio: async (...args) => served.push(args) });
  const res = {}, url = new URL(`http://localhost/api/music-take-comparison/audio?id=${row.id}&takeId=A&sha256=${HASH}`);
  const req = { method: 'HEAD', headers: { range: 'bytes=0-100' } };
  assert.equal(await route(req, res, url), true); assert.equal(served.length, 1); assert.deepEqual(served[0], [req, res, row.takes[0].file, HASH]);
  await route({ method: 'POST' }, res, url); assert.equal(replies.at(-1).status, 405);
  f.sources.get(row.takes[0].file).sha256 = OTHER;
  await route({ method: 'GET' }, res, url); assert.equal(replies.at(-1).status, 409); assert.equal(served.length, 1);
  await route({ method: 'POST', body: { action: 'choose', id: row.id, expectedRevision: 0, takeId: 'A' } }, res, new URL('http://localhost/api/music-take-comparison'));
  assert.equal(replies.at(-1).status, 409);
  assert.equal(await route({ method: 'GET' }, res, new URL('http://localhost/api/elsewhere')), false);
});

function dom(t) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => original ? Object.defineProperty(globalThis, 'document', original) : delete globalThis.document);
  const documentListeners = new Map(); globalThis.document = { hidden: false, addEventListener: (name, fn) => documentListeners.set(name, fn), removeEventListener: name => documentListeners.delete(name) };
  const fields = new Map(), buttons = new Map();
  function element(dataset = {}) {
    return { dataset, value: '', checked: false, disabled: false, handlers: new Map(), textContent: '', paused: true, currentTime: 0, duration: 61, src: '',
      addEventListener(name, handler) { if (!this.handlers.has(name)) this.handlers.set(name, new Set()); this.handlers.get(name).add(handler); },
      removeEventListener(name, handler) { this.handlers.get(name)?.delete(handler); },
      emit(name) { for (const fn of this.handlers.get(name) || []) fn(); },
      removeAttribute(name) { if (name === 'src') this.src = ''; }, load() { if (this.src) queueMicrotask(() => this.emit('loadedmetadata')); },
      pause() { this.paused = true; this.emit('pause'); }, async play() { this.paused = false; this.emit('play'); },
      closest() { return this; }, matches() { return false; }, insertAdjacentHTML() {} };
  }
  const root = { dataset: {}, parentElement: null, classList: { add() {} }, handlers: {}, hiddenParent: false,
    addEventListener(name, handler) { this.handlers[name] = handler; }, removeEventListener(name) { delete this.handlers[name]; },
    closest() { return this.hiddenParent ? {} : null; }, contains() { return true; },
    querySelector(selector) { const name = /="([^"]+)"/.exec(selector)?.[1]; return selector.includes('-action') ? buttons.get(name) : fields.get(name); },
    querySelectorAll(selector) { if (selector === 'button') return [...buttons.values()]; if (selector.includes('switch')) return [...buttons.values()].filter(button => button.dataset.tcAction === 'switch'); return []; },
  };
  const parseButtons = html => { for (const match of html.matchAll(/<button[^>]*data-tc-action="([^"]+)"[^>]*>/g)) {
    const take = /data-tc-take="([^"]+)"/.exec(match[0])?.[1]; buttons.set(take ? `switch-${take}` : match[1], element({ tcAction: match[1], ...(take ? { tcTake: take } : {}) }));
  } };
  Object.defineProperty(root, 'innerHTML', { set(html) {
    for (const match of html.matchAll(/<([a-z]+)[^>]*data-tc="([^"]+)"[^>]*>/g)) {
      const node = element(); node.value = /value="([^"]*)"/.exec(match[0])?.[1] || ''; node.checked = match[0].includes('checked');
      if (match[2] === 'count') node.value = '2';
      Object.defineProperty(node, 'innerHTML', { get() { return this.html || ''; }, set(content) { this.html = content; if (match[2] === 'takes') parseButtons(content); } });
      fields.set(match[2], node);
    } parseButtons(html);
  } });
  return { root, fields, buttons, documentListeners, fire: async key => { const button = buttons.get(key); assert.ok(button, key); return root.handlers.click({ target: button }); } };
}

test('Takes UI measures saved songs, switches one player at the same time and persists an explicit choice', async t => {
  const f = await fixture(t), d = dom(t), calls = []; let pauseMain = 0;
  const mount = mountMusicTakeComparison({ root: d.root, onBeforePlay: async () => pauseMain++, fetch: async (url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    try { return { ok: true, json: async () => await f.store.request(body) }; }
    catch (error) { return { ok: false, json: async () => ({ error: error.message }) }; }
  } });
  t.after(() => mount.destroy()); await mount.refresh(); await d.fire('latest'); d.fields.get('name').value = 'UI chorus'; await d.fire('create');
  assert.equal(f.measuredFiles.length, 2); assert.equal(d.fields.get('audition').hidden, false);
  assert.match(d.fields.get('receipts').innerHTML, /receiptHash/); assert.equal(f.flags.length, 0);
  await d.fire('play'); const player = d.fields.get('audio'); assert.equal(player.paused, false); assert.ok(player.volume <= .85);
  player.currentTime = 22; player.emit('timeupdate'); await d.fire('switch-B');
  assert.equal(player.currentTime, 22); assert.match(player.src, /takeId=B/); assert.equal(pauseMain, 2);
  await d.fire('play'); assert.equal(player.paused, true);
  await d.fire('switch-A'); await d.fire('play'); assert.equal(player.currentTime, 22, 'paused switch preserves the seek position');
  await d.fire('choose'); assert.equal(f.flags.at(-1).file, 'aiplay_0.flac'); assert.equal(f.events.at(-1).data.op, 'take-comparison-choose');
  assert.equal(calls.some(body => body.action === 'verify'), true); assert.equal(calls.some(body => body.action === 'start'), false);
  mount.destroy(); assert.equal(player.paused, true); assert.equal(player.src, ''); assert.equal(d.documentListeners.size, 0);
});

test('Takes UI refuses playback after source replacement and does not save a favourite', async t => {
  const f = await fixture(t), d = dom(t);
  const mount = mountMusicTakeComparison({ root: d.root, fetch: async (url, options) => {
    try { return { ok: true, json: async () => await f.store.request(JSON.parse(options.body)) }; }
    catch (error) { return { ok: false, json: async () => ({ error: error.message }) }; }
  } });
  t.after(() => mount.destroy()); await mount.refresh(); await d.fire('latest'); await d.fire('create');
  f.sources.get('aiplay_0.flac').sha256 = OTHER; await d.fire('play');
  assert.match(d.fields.get('status').textContent, /missing or changed/); assert.equal(d.fields.get('audio').paused, true); assert.equal(d.fields.get('audio').src, '');
  await d.fire('choose'); assert.equal(f.flags.length, 0);
});

test('Takes Refresh retrieves a concurrent choice revision before retrying a rejected choice', async t => {
  const f = await fixture(t), d = dom(t);
  const mount = mountMusicTakeComparison({ root: d.root, fetch: async (url, options) => ({ ok: true, json: async () => f.store.request(JSON.parse(options.body)) }) });
  t.after(() => mount.destroy()); await mount.refresh(); await d.fire('latest'); await d.fire('create');
  const row = (await f.store.list()).comparisons[0];
  await f.store.request({ action: 'choose', id: row.id, expectedRevision: 1, takeId: 'B' }, 'agent:other');
  await d.fire('choose'); assert.match(d.fields.get('status').textContent, /changed/); assert.equal(f.flags.length, 1);
  await d.fire('refresh'); await d.fire('choose');
  assert.equal(f.flags.length, 2); assert.equal((await f.store.request({ action: 'get', id: row.id })).comparison.revision, 3);
});

test('hiding or destroying the mounted UI cancels a pending metadata wait and prevents late playback', async t => {
  const f = await fixture(t), d = dom(t);
  let signalPlay;
  const mount = mountMusicTakeComparison({ root: d.root, onBeforePlay: async () => signalPlay?.(), fetch: async (url, options) => ({ ok: true, json: async () => f.store.request(JSON.parse(options.body)) }) });
  t.after(() => mount.destroy()); await mount.refresh(); await d.fire('latest'); await d.fire('create');
  const player = d.fields.get('audio'); player.load = () => {};
  const beforePlay = new Promise(resolve => { signalPlay = resolve; });
  const playing = d.fire('play'); await beforePlay; await new Promise(resolve => setImmediate(resolve));
  assert.equal(player.handlers.get('loadedmetadata')?.size, 1);
  globalThis.document.hidden = true; d.documentListeners.get('visibilitychange')(); await playing;
  assert.equal(player.paused, true); assert.equal(player.src, ''); assert.equal(player.handlers.get('loadedmetadata')?.size, 0);
  globalThis.document.hidden = false;
  const beforePlayAgain = new Promise(resolve => { signalPlay = resolve; });
  const playingAgain = d.fire('play'); await beforePlayAgain; await new Promise(resolve => setImmediate(resolve));
  mount.destroy(); await playingAgain;
  assert.equal(player.paused, true); assert.equal(player.src, ''); assert.equal(player.handlers.get('error')?.size, 0);
});
