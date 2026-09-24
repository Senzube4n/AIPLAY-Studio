import test from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { VRMExpression, VRMExpressionManager, VRMExpressionMorphTargetBind } from '@pixiv/three-vrm';
import { createAvatarLipSync } from '../../web/avatar-lipsync.js';

const close = (actual, expected, epsilon = 1e-6) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
const audioFile = (name = 'voice.wav') => new File([new Uint8Array(80)], name, {type: 'audio/wav'});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
function fixture({webAudio = true, mouth = 'aa', byteOnly = false, blocked = false, resume} = {}) {
  const manager = new VRMExpressionManager(), drawable = {morphTargetInfluences: [0]};
  if (mouth) { const expression = new VRMExpression(mouth); expression.addBind(new VRMExpressionMorphTargetBind({primitives: [drawable], index: 0, weight: 1})); manager.registerExpression(expression); }
  const happy = new VRMExpression('happy'); manager.registerExpression(happy); manager.setValue('happy', .6);
  const media = [], contexts = [], created = [], revoked = [], states = [];
  const timers = new Map(); let timerId = 0;
  let amplitude = .1, dc = 0;
  class FakeAudio extends EventTarget {
    constructor() { super(); this.currentTime = 0; this.duration = 8; this.paused = true; this.ended = false; this.calls = 0; media.push(this); }
    load() {}
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    play() { this.calls++; if (blocked) return Promise.reject(Object.assign(new Error('Blocked'), {name: 'NotAllowedError'})); this.paused = false; this.ended = false; this.dispatchEvent(new Event('playing')); return Promise.resolve(); }
    pause() { const playing = !this.paused; this.paused = true; if (playing) this.dispatchEvent(new Event('pause')); }
  }
  class FakeContext {
    constructor() { this.destination = {}; this.sourceCalls = 0; this.resumeCalls = 0; this.state = 'suspended'; this.closed = false; contexts.push(this); }
    createAnalyser() {
      const value = {fftSize: 2048, connect: destination => { this.connected = destination; }, disconnect: () => { this.analyserDisconnected = true; }};
      if (!byteOnly) value.getFloatTimeDomainData = array => { for (let i = 0; i < array.length; i++) array[i] = dc + (i % 2 ? amplitude : -amplitude); };
      else value.getByteTimeDomainData = array => { for (let i = 0; i < array.length; i++) array[i] = Math.round(128 + 128 * (dc + (i % 2 ? amplitude : -amplitude))); };
      return value;
    }
    createMediaElementSource(audio) { assert.equal(audio, media[0]); this.sourceCalls++; return {connect: target => { this.analyser = target; }, disconnect: () => { this.sourceDisconnected = true; }}; }
    resume() { this.resumeCalls++; return Promise.resolve(typeof resume === 'function' ? resume(this) : resume?.promise).then(() => { this.state = 'running'; }); }
    close() { this.closed = true; return Promise.resolve(); }
  }
  const controller = createAvatarLipSync({expressionManager: manager, onState: state => states.push(state), environment: {
    Audio: FakeAudio, AudioContext: webAudio ? FakeContext : null, URL: {createObjectURL: file => { const url = `blob:local-${created.length}`; created.push({file, url}); return url; }, revokeObjectURL: url => revoked.push(url)},
    setTimeout: (fn, ms) => { assert.equal(ms, 8000); const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
  }});
  return {controller, manager, drawable, media, contexts, created, revoked, states, timers,
    timeout: () => { const pending = [...timers.values()]; timers.clear(); for (const fn of pending) fn(); },
    samples: (amp, offset = 0) => { amplitude = amp; dc = offset; },
    frame: dt => { controller.update(dt); manager.update(); },
  };
}

test('selecting a local file never autoplays or creates an AudioContext', async () => {
  const f = fixture(); const selected = f.controller.loadFile(audioFile());
  assert.equal(selected.phase, 'ready'); assert.equal(f.media[0].calls, 0); assert.equal(f.contexts.length, 0);
  assert.equal(f.media[0].autoplay, false); assert.equal(f.media[0].loop, false);
  await f.controller.play(); assert.equal(f.media[0].calls, 1); assert.equal(f.contexts.length, 1);
  assert.equal(f.contexts[0].connected, f.contexts[0].destination);
  await f.controller.dispose();
});

test('real VRM mouth binding follows the waveform while unrelated expressions remain intact', async () => {
  const f = fixture(); f.manager.setValue('aa', .2); f.controller.loadFile(audioFile()); await f.controller.play();
  f.frame(1 / 60); const first = f.drawable.morphTargetInfluences[0];
  assert.ok(first > .2 && first < .7);
  for (let i = 0; i < 20; i++) f.frame(1 / 60);
  assert.ok(f.drawable.morphTargetInfluences[0] > first);
  close(f.manager.getValue('happy'), .6);
  f.samples(0); const speaking = f.manager.getValue('aa'); f.frame(1 / 60);
  assert.ok(f.manager.getValue('aa') < speaking && f.manager.getValue('aa') > .2);
  f.controller.pause(); f.manager.update(); close(f.drawable.morphTargetInfluences[0], .2);
  await f.controller.dispose();
});

test('envelope timing is frame-rate independent and rejects DC offsets as speech', async () => {
  const a = fixture(), b = fixture();
  for (const f of [a, b]) { f.controller.loadFile(audioFile()); await f.controller.play(); }
  for (let i = 0; i < 30; i++) a.frame(1 / 60);
  for (let i = 0; i < 15; i++) b.frame(1 / 30);
  close(a.manager.getValue('aa'), b.manager.getValue('aa'));
  a.controller.stop(); a.samples(0, .4); await a.controller.play();
  for (let i = 0; i < 30; i++) a.frame(1 / 60);
  close(a.manager.getValue('aa'), 0); close(a.controller.state().rms, 0);
  await a.controller.dispose(); await b.controller.dispose();
});

test('look updates during speech rebase the mouth and pause never overwrites newer authored expression values', async () => {
  const f = fixture(); f.controller.loadFile(audioFile()); await f.controller.play(); f.frame(.05);
  f.manager.setValue('aa', .4); f.manager.setValue('happy', .9); f.controller.captureBaseline(); f.frame(.05);
  assert.ok(f.manager.getValue('aa') > .4); f.controller.pause(); close(f.manager.getValue('aa'), .4); close(f.manager.getValue('happy'), .9);
  await f.controller.play(); f.frame(.05); f.manager.setValue('aa', .3); f.controller.stop(); close(f.manager.getValue('aa'), .3);
  await f.controller.dispose();
});

test('pause during a pending resume cannot be undone by late playback resolution', async () => {
  const resume = deferred(), f = fixture({resume}); f.controller.loadFile(audioFile());
  const first = f.controller.play(), duplicate = f.controller.play(); assert.equal(first, duplicate); assert.equal(f.media[0].calls, 2);
  assert.equal(f.contexts[0].resumeCalls, 2);
  f.controller.pause(); await first; assert.equal(f.timers.size, 0); resume.resolve(); await Promise.resolve();
  assert.equal(f.controller.state().phase, 'paused'); assert.equal(f.media[0].paused, true); close(f.manager.getValue('aa'), 0);
  await f.controller.dispose();
});

test('a user Play gesture retries a suspended remote request without waiting for its old resume promise', async () => {
  const old = deferred(), f = fixture({resume: context => context.resumeCalls === 1 ? old.promise : Promise.resolve()});
  f.controller.loadFile(audioFile()); const remote = f.controller.play();
  assert.equal(f.controller.state().phase, 'loading');
  assert.equal(f.controller.state().playing, false);
  const clicked = f.controller.play(); assert.equal(clicked, remote);
  assert.equal(f.contexts[0].resumeCalls, 2); assert.equal(f.media[0].calls, 2);
  await clicked; assert.equal(f.controller.state().phase, 'playing'); assert.equal(f.timers.size, 0);
  f.controller.pause(); old.resolve(); await Promise.resolve();
  assert.equal(f.controller.state().phase, 'paused'); assert.equal(f.media[0].paused, true);
  await f.controller.dispose();
});

test('suspended playback times out with activation guidance and a later gesture recovers', async () => {
  const suspended = deferred(), f = fixture({resume: context => context.resumeCalls === 1 ? suspended.promise : Promise.resolve()});
  f.controller.loadFile(audioFile()); const remote = f.controller.play();
  const refusal = assert.rejects(remote, {name:'NotAllowedError'}); f.timeout(); await refusal;
  assert.equal(f.controller.state().phase, 'blocked'); assert.equal(f.media[0].paused, true);
  close(f.manager.getValue('aa'), 0); assert.equal(f.timers.size, 0);
  await f.controller.play(); assert.equal(f.controller.state().phase, 'playing');
  suspended.resolve(); await Promise.resolve(); assert.equal(f.controller.state().phase, 'playing');
  await f.controller.dispose();
});

test('replacement and disposal settle pending playback and ignore late readiness', async () => {
  const resumed = deferred(), f = fixture({resume: resumed}); f.controller.loadFile(audioFile('old.wav'));
  const old = f.controller.play(); f.controller.loadFile(audioFile('new.wav')); await old;
  assert.equal(f.controller.state().phase, 'ready'); assert.equal(f.timers.size, 0);
  const next = f.controller.play(); await f.controller.dispose(); await next;
  resumed.resolve(); await Promise.resolve();
  assert.equal(f.controller.state().phase, 'disposed'); assert.equal(f.media[0].paused, true); assert.equal(f.timers.size, 0);
});

test('decoder refusal remains an error rather than browser activation guidance', async () => {
  const f = fixture(); f.controller.loadFile(audioFile());
  f.media[0].play = () => Promise.reject(Object.assign(new Error('Unsupported codec'), {name:'NotSupportedError'}));
  await assert.rejects(f.controller.play(), {name:'NotSupportedError'});
  assert.equal(f.controller.state().phase, 'error'); assert.match(f.controller.state().error, /Unsupported codec/);
  assert.equal(f.timers.size, 0); await f.controller.dispose();
});

test('file replacement reuses one media source, revokes old URLs, and disposal closes owned resources', async () => {
  const f = fixture(); f.controller.loadFile(audioFile('first.wav')); await f.controller.play(); f.frame(.05);
  f.controller.loadFile(audioFile('second.wav')); assert.equal(f.media[0].paused, true); close(f.manager.getValue('aa'), 0);
  assert.deepEqual(f.revoked, ['blob:local-0']); await f.controller.play(); assert.equal(f.contexts[0].sourceCalls, 1);
  f.frame(.05); await f.controller.dispose();
  assert.deepEqual(f.revoked, ['blob:local-0', 'blob:local-1']); assert.equal(f.contexts[0].closed, true);
  assert.equal(f.contexts[0].sourceDisconnected, true); assert.equal(f.contexts[0].analyserDisconnected, true); close(f.manager.getValue('aa'), 0);
  assert.equal(f.controller.state().phase, 'disposed'); assert.throws(() => f.controller.loadFile(audioFile()), /disposed/);
});

test('natural end, seeking and browser playback refusal restore authored mouth state', async () => {
  const f = fixture(); f.manager.setValue('aa', .25); f.controller.loadFile(audioFile()); await f.controller.play(); f.frame(.05);
  f.controller.seek(50); assert.equal(f.media[0].currentTime, 8); close(f.manager.getValue('aa'), .25);
  f.frame(.05); f.media[0].ended = true; f.media[0].paused = true; f.media[0].dispatchEvent(new Event('ended'));
  assert.equal(f.controller.state().phase, 'ended'); close(f.manager.getValue('aa'), .25);
  assert.throws(() => f.controller.seek(-1), /nonnegative/); assert.throws(() => f.controller.seek(Infinity), /nonnegative/);
  f.media[0].duration = NaN; assert.throws(() => f.controller.seek(1), /metadata/); await f.controller.dispose();
  const blocked = fixture({blocked: true}); blocked.controller.loadFile(audioFile());
  await assert.rejects(blocked.controller.play(), {name:'NotAllowedError'}); assert.equal(blocked.controller.state().phase, 'blocked');
  assert.match(blocked.controller.state().error,/Press Play/);
  close(blocked.manager.getValue('aa'), 0); await blocked.controller.dispose();
});

test('unsupported browsers and models fall back to audio-only, with byte analyser support where available', async () => {
  for (const options of [{webAudio: false}, {mouth: null}]) {
    const f = fixture(options); f.controller.loadFile(audioFile()); await f.controller.play();
    assert.equal(f.controller.state().lipSyncSupported, false); assert.ok(f.controller.state().audioOnlyReason);
    assert.equal(f.controller.state().playing, true); assert.equal(f.contexts.length, 0); await f.controller.dispose();
  }
  const f = fixture({byteOnly: true, mouth: 'jawOpen'}); f.controller.loadFile(audioFile()); await f.controller.play(); f.frame(.05);
  assert.ok(f.manager.getValue('jawOpen') > 0); await f.controller.dispose();
});

test('remote strings and unsupported files are rejected without replacing the current source', async () => {
  const f = fixture(); f.controller.loadFile(audioFile());
  assert.throws(() => f.controller.loadFile('https://example.test/audio.wav'), /local audio/);
  assert.throws(() => f.controller.loadFile(new File(['text'], 'text.txt', {type: 'text/plain'})), /supported audio/);
  assert.throws(() => f.controller.loadFile(new File([], 'empty.wav', {type: 'audio/wav'})), /1 byte/);
  assert.equal(f.controller.state().name, 'voice.wav'); assert.equal(f.created.length, 1);
  await f.controller.dispose();
});

test('managed URL loading remains paused, preserves metadata and rejects arbitrary origins or paths',async()=>{
  const f=fixture();f.controller.loadFile(audioFile());
  const url='/api/avatars/playback/audio/au_12345678-1234-1234-1234-123456789abc';
  const state=f.controller.loadUrl(url,{name:'Managed voice.wav',bytes:80});
  assert.equal(state.name,'Managed voice.wav');assert.equal(state.phase,'ready');assert.equal(f.media[0].calls,0);assert.deepEqual(f.revoked,['blob:local-0']);
  assert.equal(f.media[0].src,url);
  for(const bad of ['https://example.test/audio.wav','//evil.test/audio.wav','/api/avatars/other','/api/avatars/playback/audio/../../secret',url+'?url=http://evil.test'])assert.throws(()=>f.controller.loadUrl(bad),/managed local/);
  await f.controller.dispose();assert.deepEqual(f.revoked,['blob:local-0']);
});
