/** Exercise the actual mounted widget with deferred HTTP replies. No jobs are run. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { inputSelection, continuationSettings, musicResultUrl } from '../web/music-input-ui.js';
const source = readFileSync(new URL('../web/music-input-ui.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('function mountMusicInput(host)'), end = source.indexOf('\n}\n', start);
assert(start >= 0 && end > start);
const mountSource = source.slice(start, end + 2);
const terminalSource = source.slice(source.indexOf('const terminal ='), source.indexOf('\n', source.indexOf('const terminal =')));
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false; this.listeners = {}; this.files = []; }
  append(...children) { this.children.push(...children); }
  add(child) { this.append(child); }
  replaceChildren(...children) { this.children = children; }
  get options() { return this.children; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  querySelector(tag) { return this.children.find((child) => child.tagName === tag) || null; }
  pause() { this.paused = true; }
}
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
const available = (jobs = []) => ({ available: true, jobs, requirements: {}, limits: {}, modes: {} });
function harness() {
  const nodes = new Map(), requests = [], timers = new Map(), events = [];
  const q = (id) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  for (const [id, value] of Object.entries({ start: '0', duration: '7.5', seconds: '7.5', seed: '0', mixSeed: '1', caption: 'Piano', lyrics: '[Instrumental]', title: 'Piano', library: 'song.wav' })) q(id).value = value;
  const dialog = new Element(); dialog.closed = 0; dialog.close = () => { dialog.closed++; dialog.listeners.close?.(); };
  const host = new Element(); host.dataset = { daw: 'true' }; host.closest = () => dialog;
  host.querySelector = (selector) => q(selector.match(/data-mi="([^"]+)"/)[1]);
  let timerId = 0;
  const ctx = vm.createContext({ inputSelection, continuationSettings, musicResultUrl,
    document: { createElement: (tag) => new Element(tag) },
    window: { dispatchEvent: (event) => { events.push(event); return true; } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    Option: class extends Element { constructor(text, value) { super('option'); this.textContent = text; this.value = value; } },
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id) => timers.delete(id),
    fetch: (url, options) => new Promise((resolve, reject) => {
      const request = { body: options?.body ? JSON.parse(options.body) : null,
        respond: (data, ok = true, status = 200) => resolve({ ok, status, json: async () => data }), reject };
      requests.push(request);
    }),
  });
  vm.runInContext(`${terminalSource}\n${mountSource}`, ctx); ctx.mountMusicInput(host);
  const initialize = async () => { requests[0].respond(available()); await flush(); };
  const select = (id) => { q('jobs').value = id; return q('jobs').onchange(); };
  return { ctx, q, host, dialog, requests, timers, events, initialize, select };
}
let count = 0;
async function test(name, run) { await run(); count++; console.log(`ok ${name}`); }

await test('older availability response cannot overwrite newer availability and job list', async () => {
  const h = harness(); const newer = h.q('refresh').onclick();
  h.requests[1].respond(available([{ id: 'new', state: 'ready' }])); await newer;
  h.requests[0].respond({ available: false, reason: 'Old failure', jobs: [{ id: 'old', state: 'failed' }] }); await flush();
  assert.match(h.q('capability').textContent, /^Ready.$/);
  assert(h.q('jobs').options.some((option) => option.value === 'new'));
  assert(!h.q('jobs').options.some((option) => option.value === 'old'));
});
await test('late availability request cannot erase a later validation error', async () => {
  const h = harness(); await h.initialize(); const pending = h.q('refresh').onclick();
  h.q('library').value = ''; await h.q('prepare').onclick();
  assert.equal(h.q('error').hidden, false); assert.match(h.q('error').textContent, /Choose a WAV or FLAC/);
  h.requests[1].respond(available()); await pending;
  assert.equal(h.q('error').hidden, false); assert.match(h.q('error').textContent, /Choose a WAV or FLAC/);
});
await test('selecting another job discards the old status and keeps polling only the selected job', async () => {
  const h = harness(); await h.initialize(); const a = h.select('a'), b = h.select('b');
  h.requests[2].respond({ job: { id: 'b', state: 'running', stage: 'new stage', reference_id: 'mi_b' } }); await b;
  h.requests[1].respond({ job: { id: 'a', state: 'failed', error: 'old error' } }); await a;
  assert.match(h.q('jobStatus').textContent, /new stage.*b/); assert.doesNotMatch(h.q('jobStatus').textContent, /old error/);
  assert.equal(h.timers.size, 1); assert.equal(h.q('jobs').disabled, false);
});
await test('double preparation clicks submit exactly one job and keep controls disabled until acknowledged', async () => {
  const h = harness(); await h.initialize(); const first = h.q('prepare').onclick(); await h.q('prepare').onclick();
  assert.equal(h.requests.filter((r) => r.body?.action === 'prepare').length, 1);
  assert.equal(h.q('prepareFields').disabled, true); assert.equal(h.q('jobs').disabled, true);
  h.requests[1].respond({ job: { id: 'mi_new' } }); await flush();
  h.requests[2].respond({ job: { id: 'mi_new', state: 'preparing' } }); await first;
  assert.equal(h.q('prepareFields').disabled, true); assert.equal(h.q('jobs').disabled, false);
});
await test('a pending continuation prevents both another continuation and a preparation', async () => {
  const h = harness(); await h.initialize(); const ready = h.select('mi_ready');
  h.requests[1].respond({ job: { id: 'mi_ready', state: 'ready', reference_id: 'mi_ready' } }); await flush();
  h.requests[2].respond(available()); await ready;
  const run = h.q('continue').onclick(); await h.q('continue').onclick(); await h.q('prepare').onclick();
  assert.equal(h.requests.filter((r) => r.body?.action === 'continue').length, 1);
  assert.equal(h.requests.filter((r) => r.body?.action === 'prepare').length, 0);
  h.requests[3].respond({ job: { id: 'render_new' } }); await flush();
  h.requests[4].respond({ job: { id: 'render_new', state: 'running', reference_id: 'mi_ready' } }); await run;
  assert.equal(h.q('continueFields').disabled, true);
});
await test('old cancellation failure cannot overwrite a newly selected job', async () => {
  const h = harness(); await h.initialize(); const a = h.select('a');
  h.requests[1].respond({ job: { id: 'a', state: 'running' } }); await a;
  const cancel = h.q('cancel').onclick(); const b = h.select('b');
  h.requests[3].respond({ job: { id: 'b', state: 'running', stage: 'new stage' } }); await b;
  h.requests[2].reject(new Error('Old cancellation failure')); await cancel;
  assert.equal(h.q('error').hidden, true); assert.match(h.q('jobStatus').textContent, /new stage/);
});
await test('unknown or paused jobs settle without endless polling or a disabled picker', async () => {
  for (const state of ['unknown', 'paused']) {
    const h = harness(); await h.initialize(); const p = h.select('gone');
    h.requests[1].respond({ job: { id: 'gone', state } }); await flush();
    h.requests[2].respond(available()); await p;
    assert.equal(h.timers.size, 0); assert.equal(h.q('jobs').disabled, false); assert.equal(h.q('cancel').disabled, true);
  }
});
await test('explicit generated import dispatches its path and closes the modal to reveal DAW feedback', async () => {
  const h = harness(); await h.initialize(); const p = h.select('done');
  h.requests[1].respond({ job: { id: 'done', state: 'done', file: 'new.wav', path: 'C:/output/new.wav', url: '/api/audio/new.wav' } }); await flush();
  h.requests[2].respond(available()); await p;
  const audio = h.q('result').querySelector('audio'); assert.equal(audio.preload, 'none');
  h.q('result').querySelector('button').onclick();
  assert.equal(h.events.length, 1); assert.equal(h.events[0].type, 'music-input-result');
  assert.equal(h.events[0].detail.path, 'C:/output/new.wav'); assert.equal(h.dialog.closed, 1); assert.equal(audio.paused, true);
});
await test('choosing another source clears the visible ready reference before regeneration', async () => {
  const h = harness(); await h.initialize(); const p = h.select('mi_old');
  h.requests[1].respond({ job: { id: 'mi_old', state: 'ready', reference_id: 'mi_old' } }); await flush();
  h.requests[2].respond(available()); await p;
  h.q('library').oninput(); assert.equal(h.q('continueFields').disabled, true);
  assert.doesNotMatch(h.q('reference').textContent, /mi_old/);
});
console.log(`${count} mounted music input UI race checks passed; no server, provider, job or project touched.`);
