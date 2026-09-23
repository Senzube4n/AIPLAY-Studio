import test from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { mountAvatarVoice } from '../../web/avatar-voice.js';

const ID = 'av_12345678-1234-4321-8765-123456789abc';
const AUDIO_ID = 'au_abcdefab-abcd-4abc-8abc-abcdefabcdef';
const AUDIO_URL = `/api/avatars/playback/audio/${AUDIO_ID}`;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const loaded = (revision = 1, extra = {}) => ({revision, desired: {audio_id:AUDIO_ID, url:AUDIO_URL, name:'Voice.wav', bytes:16,
  playing:false, time:0, load_revision:1, seek_revision:1, ...extra}});

// The real voice bridge and real lip-sync controller run against a small media,
// DOM and transport boundary. Requests and media actions remain observable;
// tests never replace the controller with a mock that would hide its races.
function browser(t, options = {}) {
  const elements = new Map(), requests = [], media = [], contexts = [], intervals = new Map();
  let nextTimer = 0, controller, current = true;
  let session = {revision:0, desired:{audio_id:null, url:null, name:null, bytes:0, playing:false, time:0, load_revision:0, seek_revision:0}};
  const node = id => { if (!elements.has(id)) elements.set(id, {hidden:false, disabled:false, value:'0', textContent:'', className:''}); return elements.get(id); };
  const document = {hidden:false, getElementById:node,
    body:{classList:{contains:name => name === 'avatar-overlay' && options.overlay === true}}};
  class FakeAudio extends EventTarget {
    constructor() { super(); this.currentTime = 0; this.duration = NaN; this.paused = true; this.ended = false; this.error = null; this.playCalls = 0; media.push(this); }
    load() { this.currentTime = 0; this.duration = NaN; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    play() {
      this.playCalls++;
      if (options.blocked) return Promise.reject(Object.assign(new Error('User activation required'), {name:'NotAllowedError'}));
      if (options.failure) return Promise.reject(Object.assign(new Error('Unsupported audio'), {name:options.failure}));
      this.paused = false; this.ended = false; this.dispatchEvent(new Event('playing'));
      return Promise.resolve();
    }
    pause() { const changed = !this.paused; this.paused = true; if (changed) this.dispatchEvent(new Event('pause')); }
  }
  class FakeContext {
    constructor() { this.destination = {}; this.closed = false; this.state = 'suspended'; contexts.push(this); }
    createAnalyser() { return {fftSize:2048, connect(){}, disconnect(){}, getFloatTimeDomainData(buffer){buffer.fill(.1);}}; }
    createMediaElementSource() { return {connect(){}, disconnect(){}}; }
    resume() { return (options.resume?.promise || Promise.resolve()).then(() => { this.state = 'running'; }); }
    close() { this.closed = true; return Promise.resolve(); }
  }
  const globals = {
    document, Audio:FakeAudio, AudioContext:FakeContext,
    setInterval(callback, ms) { assert.equal(ms, 1000); intervals.set(++nextTimer, callback); return nextTimer; },
    clearInterval(id) { intervals.delete(id); },
    async fetch(url, init) {
      assert.equal(url, '/api/avatars/playback'); assert.equal(init.method, 'POST');
      const body = JSON.parse(init.body); requests.push(body);
      const value = options.response ? await options.response(body) : undefined;
      return {ok:!value?.httpError, status:value?.httpError || 200,
        async json() { return structuredClone(value ?? (body.action === 'upload' ? {audio_id:AUDIO_ID} : session)); }};
    },
  };
  const previous = new Map(Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, {configurable:true, writable:true, value});
  t.after(() => {
    controller?.dispose();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const values = new Map([['aa', 0]]);
  const expressionManager = {getExpression:name => values.has(name) ? {} : null,
    getValue:name => values.get(name), setValue:(name, value) => values.set(name, value)};
  return {
    node, requests, media, contexts, intervals, document, values,
    async mount() { controller = await mountAvatarVoice({row:{id:ID, inspection:{sha256:'a'.repeat(64)}},
      runtime:{vrm:{expressionManager}}, isCurrent:() => current}); return controller; },
    session(value) { session = structuredClone(value); },
    stale() { current = false; },
    metadata(duration = 8) { media[0].duration = duration; media[0].dispatchEvent(new Event('loadedmetadata')); },
    tick() { return [...intervals.values()][0]?.(); },
  };
}

test('registers the selected content identity and does not play or request audio permission at mount', async t => {
  const f = browser(t); await f.mount();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].action, 'register');
  assert.equal(f.requests[0].id, ID); assert.equal(f.requests[0].sha256, 'a'.repeat(64));
  assert.deepEqual(f.requests[0].capabilities, {audio:true, lip_sync:true});
  assert.equal(f.media[0].playCalls, 0); assert.equal(f.contexts.length, 0);
  assert.equal(f.node('voice-panel').hidden, false); assert.equal(f.node('voice-play').disabled, true);
});

test('MCP load and play reach real media and acknowledge only the consumed revision', async t => {
  const f = browser(t); await f.mount();
  f.session(loaded()); await f.tick(); f.metadata();
  assert.equal(f.media[0].src, AUDIO_URL); assert.equal(f.media[0].playCalls, 0);
  f.session(loaded(2, {playing:true})); await f.tick(); await flush();
  assert.equal(f.media[0].paused, false); assert.equal(f.node('voice-state').textContent, 'Playing');
  await f.tick();
  const report = f.requests.at(-1);
  assert.equal(report.applied_revision, 2); assert.equal(report.status.phase, 'playing');
  assert.equal(f.media[0].playCalls, 1, 'an unchanged heartbeat must not restart playback');
});

test('a seek waits for this audio metadata before acknowledgment or playback', async t => {
  const f = browser(t); await f.mount();
  f.session(loaded(3, {playing:true, time:5, seek_revision:3})); await f.tick();
  assert.equal(f.media[0].playCalls, 0); assert.equal(f.node('voice-state').textContent, 'Loading');
  await f.tick(); assert.equal(f.requests.at(-1).applied_revision, 0);
  f.metadata(8); await f.tick(); await flush();
  assert.equal(f.media[0].currentTime, 5); assert.equal(f.media[0].paused, false);
  await f.tick(); assert.equal(f.requests.at(-1).applied_revision, 3);
});

test('autoplay denial is reported as blocked and a human Play retains browser activation', async t => {
  const options = {blocked:true}, f = browser(t, options); await f.mount();
  f.session(loaded(2, {playing:true})); await f.tick(); await flush(); f.metadata();
  assert.equal(f.node('voice-state').textContent, 'Enable audio');
  assert.equal(f.node('voice-play').disabled, false);
  await f.tick(); assert.equal(f.requests.at(-1).status.phase, 'blocked');
  options.blocked = false; f.session(loaded(3, {playing:true}));
  const before = f.media[0].playCalls;
  f.node('voice-play').onclick();
  assert.equal(f.media[0].playCalls, before + 1, 'play() must be invoked in the original click, before an awaited request');
  await flush();
  const command = f.requests.find(r => r.action === 'command');
  assert.equal(command.op, 'play'); assert.equal(command.session_id, f.requests[0].session_id);
  assert.match(command.command_id, /^[a-f0-9-]{36}$/);
});

test('human file upload, seek and stop use the shared command surface', async t => {
  const f = browser(t); await f.mount(); f.session(loaded());
  await f.node('voice-file').onchange({target:{files:[new File([new Uint8Array(16)], 'Voice.wav', {type:'audio/wav'})]}});
  assert.equal(f.requests.find(r => r.action === 'upload').name, 'Voice.wav');
  assert.equal(f.requests.find(r => r.action === 'command').op, 'load');
  assert.equal(f.requests.find(r => r.action === 'command').audio_id, AUDIO_ID);
  f.metadata(); f.node('voice-time').value = '4.5'; f.session(loaded(2, {time:4.5, seek_revision:2}));
  await f.node('voice-time').onchange(); assert.equal(f.media[0].currentTime, 4.5);
  assert.equal(f.requests.at(-1).op, 'seek'); assert.equal(f.requests.at(-1).seconds, 4.5);
  f.session(loaded(3, {time:0, seek_revision:3})); await f.node('voice-stop').onclick();
  assert.equal(f.requests.at(-1).op, 'stop'); assert.equal(f.media[0].currentTime, 0);
});

test('an inactive preview reports blocked and requires a new play instead of replaying an old command', async t => {
  const f = browser(t), voice = await f.mount(); voice.setActive(false);
  f.session(loaded(2, {playing:true})); await f.tick();
  assert.equal(f.media[0].playCalls, 0);
  await f.tick(); assert.equal(f.requests.at(-1).status.phase, 'blocked');
  voice.setActive(true); await f.tick();
  assert.equal(f.media[0].paused, true);
  f.session(loaded(3, {playing:true})); await f.tick(); await flush();
  assert.equal(f.media[0].paused, false);
});

test('a disposed preview ignores an in-flight heartbeat and releases audio resources', async t => {
  const response = deferred();
  const f = browser(t, {response:body => body.action === 'heartbeat' ? response.promise : undefined});
  const voice = await f.mount(); const pending = f.tick();
  const before = f.node('voice-state').textContent; voice.dispose();
  response.resolve(loaded(2, {playing:true})); await pending;
  assert.equal(f.media[0].playCalls, 0); assert.equal(f.intervals.size, 0);
  assert.equal(f.node('voice-state').textContent, before);
});

test('a superseded registration never installs controls or a heartbeat', async t => {
  const response = deferred();
  const f = browser(t, {response:body => body.action === 'register' ? response.promise : undefined});
  f.node('voice-panel').hidden = true;
  const pending = f.mount(); f.stale(); response.resolve({}); await pending;
  assert.equal(f.node('voice-panel').hidden, true); assert.equal(f.intervals.size, 0);
  assert.equal(f.node('voice-play').onclick, undefined); assert.equal(f.media[0].src, '');
});

test('hiding pauses immediately and records a shared pause without replaying on return', async t => {
  const f = browser(t), voice = await f.mount();
  f.session(loaded(2, {playing:true})); await f.tick(); await flush(); await f.tick();
  assert.equal(f.requests.at(-1).applied_revision, 2);
  f.session(loaded(3));
  voice.setActive(false); assert.equal(f.media[0].paused, true);
  await flush();
  assert.equal(f.requests.find(r => r.action === 'command')?.op, 'pause');
  await f.tick(); assert.equal(f.requests.at(-1).status.phase, 'blocked');
  voice.setActive(true); await f.tick();
  assert.equal(f.media[0].paused, true, 'returning to the active view must not replay pre-suspension intent');
  assert.ok(f.requests.filter(r => r.action === 'heartbeat').slice(1).every(r => r.applied_revision >= 2));
});

test('a suspended AudioContext cannot prevent a later MCP stop from being consumed', async t => {
  const resume = deferred(), f = browser(t, {resume}); await f.mount();
  f.session(loaded()); await f.tick();
  f.session(loaded(2, {playing:true})); const playing = f.tick(); await flush();
  try {
    f.session(loaded(3, {playing:false, time:0, seek_revision:3}));
    await f.tick(); await flush();
    assert.equal(f.media[0].paused, true, 'Stop must remain actionable while audio activation is pending');
  } finally { resume.resolve(); await playing; }
});

test('human Play records intent without waiting for activation and Stop interrupts immediately', async t => {
  const resume = deferred(), f = browser(t, {resume}); await f.mount();
  f.session(loaded()); await f.tick(); f.metadata();
  f.session(loaded(2, {playing:true})); await f.node('voice-play').onclick();
  assert.equal(f.requests.at(-1).op, 'play');
  assert.equal(f.node('voice-play').disabled, false); assert.equal(f.node('voice-stop').disabled, false);
  f.session(loaded(3, {time:0, seek_revision:3}));
  const stopped = f.node('voice-stop').onclick();
  assert.equal(f.media[0].paused, true, 'Stop takes effect before waiting for the server');
  await stopped; resume.resolve(); await flush(); await f.tick();
  assert.equal(f.media[0].paused, true); assert.equal(f.requests.at(-1).applied_revision, 3);
});

test('decoder failures remain errors rather than misleading activation prompts', async t => {
  const f = browser(t, {failure:'NotSupportedError'}); await f.mount();
  f.session(loaded(2, {playing:true})); await f.tick(); await flush(); await f.tick();
  assert.equal(f.node('voice-state').textContent, 'Audio error');
  assert.equal(f.requests.at(-1).status.phase, 'error');
  assert.equal(f.node('voice-play').disabled, false);
});

test('a decoder failure during a metadata-dependent seek does not remain Loading forever', async t => {
  const f = browser(t); await f.mount();
  f.session(loaded(2, {playing:true, time:4, seek_revision:2})); await f.tick();
  assert.equal(f.node('voice-state').textContent, 'Loading');
  f.media[0].error = {code:4}; f.media[0].dispatchEvent(new Event('error'));
  await f.tick(); await f.tick();
  assert.equal(f.node('voice-state').textContent, 'Audio error');
  assert.equal(f.requests.at(-1).status.phase, 'error');
  assert.equal(f.requests.at(-1).applied_revision, 2);
  assert.equal(f.media[0].playCalls, 0);
});

test('HTTP 410 re-registers an empty preview with a new identity and zero acknowledgment', async t => {
  let expire = false, registrations = 0;
  const options = {}, f = browser(t, options);
  options.response = body => {
    if (body.action === 'register' && ++registrations > 1) f.session({revision:0, desired:{url:null, playing:false, time:0, load_revision:0, seek_revision:0}});
    if (body.action === 'heartbeat' && expire) { expire = false; return {httpError:410, error:'Preview session expired'}; }
  };
  await f.mount(); f.session(loaded(2, {playing:true})); await f.tick(); await flush(); await f.tick();
  const firstSession = f.requests[0].session_id; expire = true; await f.tick();
  const registration = f.requests.filter(r => r.action === 'register').at(-1);
  assert.notEqual(registration.session_id, firstSession);
  assert.equal(f.node('voice-name').textContent, 'No audio selected');
  assert.equal(f.node('voice-play').disabled, true); assert.equal(f.media[0].paused, true);
  assert.equal(f.contexts[0].closed, true);
  await f.tick(); const heartbeat = f.requests.at(-1);
  assert.equal(heartbeat.session_id, registration.session_id); assert.equal(heartbeat.applied_revision, 0);
  assert.equal(heartbeat.status.phase, 'empty'); assert.equal(heartbeat.status.time, 0);
});

test('a late heartbeat cannot overwrite a newer Stop command or decrease its acknowledgment', async t => {
  const late = deferred(); let hold = false;
  const f = browser(t, {response:body => body.action === 'heartbeat' && hold ? late.promise : undefined});
  await f.mount(); f.session(loaded()); await f.tick(); f.metadata();
  hold = true; const pending = f.tick();
  f.session(loaded(3, {seek_revision:3})); await f.node('voice-stop').onclick();
  late.resolve(loaded(2, {playing:true})); await pending; await flush();
  assert.equal(f.media[0].playCalls, 0); assert.equal(f.media[0].paused, true);
  hold = false; await f.tick(); assert.equal(f.requests.at(-1).applied_revision, 3);
});

test('older human Play replies and heartbeats cannot restart audio while a newer Stop is pending', async t => {
  const played = deferred(), stopped = deferred();
  const f = browser(t, {response:body => body.action === 'command'
    ? body.op === 'play' ? played.promise : body.op === 'stop' ? stopped.promise : undefined : undefined});
  await f.mount(); f.session(loaded()); await f.tick(); f.metadata();
  const play = f.node('voice-play').onclick(); await flush();
  const stop = f.node('voice-stop').onclick(); assert.equal(f.media[0].paused, true);
  played.resolve(loaded(2, {playing:true})); await flush();
  f.session(loaded(2, {playing:true})); await f.tick(); await flush();
  assert.equal(f.media[0].paused, true);
  assert.equal(f.media[0].playCalls, 1, 'neither stale response may replay a stopped source');
  stopped.resolve(loaded(3, {seek_revision:3})); await play; await stop;
  f.session(loaded(3, {seek_revision:3})); await f.tick();
  assert.equal(f.requests.at(-1).applied_revision, 3);
});

test('a blocked overlay offers activation in its own window and hides the control after successful playback', async t => {
  const options = {overlay:true, blocked:true}, f = browser(t, options); await f.mount();
  assert.equal(f.node('voice-enable-overlay').hidden, true);
  f.session(loaded(2, {playing:true})); await f.tick(); await flush();
  assert.equal(f.node('voice-enable-overlay').hidden, false);
  options.blocked = false; f.session(loaded(3, {playing:true}));
  const before = f.media[0].playCalls, command = f.node('voice-enable-overlay').onclick();
  assert.equal(f.media[0].playCalls, before + 1, 'activation must start synchronously in the overlay gesture');
  await command; await flush();
  assert.equal(f.requests.find(r => r.action === 'command')?.op, 'play');
  assert.equal(f.media[0].paused, false); assert.equal(f.node('voice-enable-overlay').hidden, true);
});

test('a suspended overlay exposes activation without waiting for the startup timeout', async t => {
  const oldResume = deferred(), options = {overlay:true, resume:oldResume};
  const f = browser(t, options); await f.mount();
  f.session(loaded(2, {playing:true})); await f.tick(); await flush();
  assert.equal(f.node('voice-enable-overlay').hidden, false);
  assert.equal(f.node('voice-enable-overlay').disabled, false);
  options.resume = null; f.session(loaded(3, {playing:true}));
  await f.node('voice-enable-overlay').onclick(); await flush();
  assert.equal(f.node('voice-enable-overlay').hidden, true); assert.equal(f.node('voice-state').textContent, 'Playing');
  oldResume.resolve(); await flush();
});

test('the overlay activation control stays hidden in ordinary Studio and for decoder errors', async t => {
  const options = {blocked:true}, f = browser(t, options); await f.mount();
  f.session(loaded(2, {playing:true})); await f.tick(); await flush();
  assert.equal(f.node('voice-enable-overlay').hidden, true);
  options.overlay = true; options.blocked = false; options.failure = 'NotSupportedError';
  f.session(loaded(3, {playing:true})); await f.tick(); await flush();
  assert.equal(f.node('voice-state').textContent, 'Audio error');
  assert.equal(f.node('voice-enable-overlay').hidden, true);
});

test('suspension and disposal remove a blocked overlay activation control', async t => {
  const options = {overlay:true, blocked:true}, f = browser(t, options), voice = await f.mount();
  f.session(loaded(2, {playing:true})); await f.tick(); await flush();
  assert.equal(f.node('voice-enable-overlay').hidden, false);
  f.session(loaded(3)); voice.setActive(false); await flush();
  assert.equal(f.node('voice-enable-overlay').hidden, true);
  voice.setActive(true); f.session(loaded(4, {playing:true})); await f.tick(); await flush();
  assert.equal(f.node('voice-enable-overlay').hidden, false);
  voice.dispose(); assert.equal(f.node('voice-enable-overlay').hidden, true);
  assert.equal(f.node('voice-enable-overlay').onclick, null);
});
