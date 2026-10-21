/** Actual browser audition functions, with fake audio/network only. No DSP,
 * MIDI access, Studio server, dependency installation or hardware is used. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../web/daw.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./patches.json', import.meta.url), 'utf8'));
const block = source.slice(source.indexOf('const AUDITION_MS ='), source.indexOf('/* ═══════════════════════════════ docks,'));
const fn = name => {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, name + ' exists');
  return source.slice(start, source.indexOf('\n}', start) + 2);
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture({ pendingRender = false, pendingDecode = false } = {}) {
  const calls = [], nodes = [], gains = [], events = new Map(), renders = [];
  const decodeGate = deferred();
  const S = { slug: 'song-a', projectEpoch: 1, trackId: 'piano',
    proj: { tracks: [{ id: 'piano', instrument: { patch: 'pluck', params: {} }, gainDb: 0 }] },
    timeline: [{ bpm: 120, den: 4 }], master: {},
    aud: { on: true, seq: 0, node: null, at: 0, lastPitch: null, cache: new Map() }, playing: false };
  const ctx = { currentTime: 10, resume: async () => {},
    decodeAudioData: async bytes => { if (pendingDecode) await decodeGate.promise; return { duration: 4, bytes }; },
    createBufferSource() {
      const node = { starts: 0, stops: [], connections: [], disconnects: 0,
        connect(target) { this.connections.push(target); }, disconnect() { this.disconnects++; },
        start() { this.starts++; }, stop(at) { this.stops.push(at); this.onended?.(); } };
      nodes.push(node); return node;
    },
    createGain() {
      const gain = { connections: [], disconnects: 0, values: [],
        connect(target) { this.connections.push(target); }, disconnect() { this.disconnects++; },
        gain: { value: 1, cancelScheduledValues(at) { gain.values.push(['cancel', at]); },
          setValueAtTime(value, at) { gain.values.push(['set', value, at]); },
          linearRampToValueAtTime(value, at) { gain.values.push(['ramp', value, at]); } } };
      gains.push(gain); return gain;
    } };
  const MIDI = { on: false, open: new Map(), notes: [] };
  const midiDevice = { value: '' };
  const document = { hidden: false, addEventListener: (name, cb) => events.set('document:' + name, cb) };
  const window = { addEventListener: (name, cb) => events.set('window:' + name, cb) };
  const sandbox = { S, TPB: 960, PALETTE: { rows: [{ id: 'pluck', tail: 1.5 }] }, MIDI, document, window,
    audioCtx: () => ctx, performance: { now: () => 1000 },
    api: async body => {
      calls.push(body); const gate = deferred(); renders.push(gate);
      return pendingRender ? gate.promise : { url: '/preview/' + calls.length };
    },
    fetch: async () => ({ arrayBuffer: async () => new ArrayBuffer(4) }),
    $: () => midiDevice, projTime: () => sandbox.time,
    finePos: () => ({ bar: 2, beat: 1, tick: 120, beatSec: .5 }), status() {}, time: 1,
  };
  const exported = runInNewContext(block + '\n' + fn('onMidi')
    + '\n({ createAuditionVoices, heldPreviewTicks, heldAuditionScope, auditionMidiNote, stopHeldAuditions, auditionNote, auditionStop, midiAuditionKey, onMidi, release: key => heldAuditions?.release(key) });', sandbox);
  return { ...exported, S, MIDI, calls, nodes, gains, events, renders, ctx, midiDevice, sandbox, decodeGate,
    midi: (status, pitch, velocity, input = 'keys-a') => exported.onMidi({ data: [status, pitch, velocity], target: { id: input } }) };
}

test('a MIDI chord starts independent voices using each performed velocity', async () => {
  const f = fixture(); f.midi(0x90, 60, 24); f.midi(0x90, 64, 111); f.midi(0x90, 67, 72); await tick();
  assert.deepEqual(f.calls.map(({ action, pitch, vel }) => ({ action, pitch, vel })), [
    { action: 'preview_note', pitch: 60, vel: 24 }, { action: 'preview_note', pitch: 64, vel: 111 },
    { action: 'preview_note', pitch: 67, vel: 72 }]);
  assert.equal(f.nodes.length, 3); assert.ok(f.nodes.every(n => n.starts === 1 && n.stops.length === 0));
  assert.ok(f.gains.every(g => g.gain.value === 1), 'rendered velocity is not scaled a second time');
  f.stopHeldAuditions(); assert.ok(f.nodes.every(n => n.stops.length === 1));
});

test('note-off and zero-velocity note-on fade only the released key', async () => {
  const f = fixture(); f.midi(0x90, 60, 36); f.midi(0x90, 64, 88); await tick();
  f.midi(0x80, 60, 64);
  assert.deepEqual(f.nodes[0].stops, [10.015]); assert.equal(f.nodes[1].stops.length, 0);
  assert.deepEqual(f.gains[0].values.at(-1), ['ramp', 0, 10.012]);
  f.midi(0x90, 64, 0); assert.deepEqual(f.nodes[1].stops, [10.015]);
  assert.equal(f.calls.length, 2, 'release does not render another note or edit the project');
});

test('same pitch on separate channels or inputs has separate release ownership', async () => {
  const f = fixture(); f.midi(0x90, 60, 40); f.midi(0x91, 60, 80); f.midi(0x90, 60, 110, 'keys-b'); await tick();
  f.midi(0x81, 60, 0);
  assert.deepEqual(f.nodes.map(n => n.stops.length), [0, 1, 0]);
  f.midi(0x80, 60, 0, 'keys-b'); assert.deepEqual(f.nodes.map(n => n.stops.length), [0, 1, 1]);
  f.stopHeldAuditions();
});

test('release before render/decode completes never produces a late note', async () => {
  const render = fixture({ pendingRender: true }); render.midi(0x90, 60, 77); render.midi(0x80, 60, 0);
  render.renders[0].resolve({ url: '/late' }); await tick(); assert.equal(render.nodes.length, 0);
  const decode = fixture({ pendingDecode: true }); decode.midi(0x90, 60, 77); await tick();
  decode.midi(0x80, 60, 0); decode.decodeGate.resolve(); await tick(); assert.equal(decode.nodes.length, 0);
});

test('retriggering a held key replaces only that key, even with out-of-order replies', async () => {
  const f = fixture({ pendingRender: true }); f.midi(0x90, 60, 20); f.midi(0x90, 60, 112);
  f.renders[1].resolve({ url: '/new' }); await tick(); f.renders[0].resolve({ url: '/old' }); await tick();
  assert.equal(f.nodes.length, 1); assert.equal(f.calls[1].vel, 112);
  f.midi(0x90, 60, 95); assert.equal(f.nodes[0].stops.length, 1);
  f.renders[2].resolve({ url: '/third' }); await tick(); assert.equal(f.nodes.length, 2);
  f.stopHeldAuditions();
});

test('the 16-voice bound drops the oldest pending key without cancelling a chord', async () => {
  const f = fixture({ pendingRender: true });
  for (let pitch = 40; pitch < 57; pitch++) f.midi(0x90, pitch, 64);
  f.renders.forEach((gate, i) => gate.resolve({ url: '/voice/' + i })); await tick();
  assert.equal(f.nodes.length, 16); assert.ok(f.nodes.every(n => n.stops.length === 0));
  f.stopHeldAuditions(); assert.ok(f.nodes.every(n => n.stops.length === 1));
});

test('a stale epoch, track or patch cannot start a pending audition', async () => {
  for (const change of [f => f.S.projectEpoch++, f => { f.S.trackId = 'other'; },
    f => { f.S.proj.tracks[0].instrument.params.cutoff = 400; }, f => { f.S.aud.on = false; }]) {
    const f = fixture({ pendingRender: true }); f.midi(0x90, 60, 60); change(f);
    f.renders[0].resolve({ url: '/old-scope' }); await tick(); assert.equal(f.nodes.length, 0);
  }
});

test('blur, hidden-page and navigation cleanup affect held voices, not editor or transport audio', async () => {
  for (const event of ['window:blur', 'window:pagehide', 'document:visibilitychange']) {
    const f = fixture(); let editorStopped = false; f.S.aud.node = { stop() { editorStopped = true; } };
    f.midi(0x90, 60, 70); await tick();
    if (event.startsWith('document:')) f.sandbox.document.hidden = true;
    f.events.get(event)(); assert.equal(f.nodes[0].stops.length, 1); assert.equal(editorStopped, false);
  }
});

test('finite held previews fit the existing duration/grid and declared fast-lane tail budget', () => {
  const f = fixture();
  for (const bpm of [30, 60, 120, 300]) for (const den of [2, 4, 8, 16]) {
    for (const row of Object.values(manifest.patches)) {
      const ticks = f.heldPreviewTicks({ bpm, den }, row.tail);
      const seconds = ticks / 960 * (4 / den) * 60 / bpm;
      assert.ok(Number.isInteger(ticks) && ticks >= 1 && ticks <= 7680);
      assert.ok(seconds <= 4 + 1e-9); assert.ok(seconds + row.tail <= 10, row.label);
    }
  }
  assert.ok(f.heldPreviewTicks({ bpm: 30, den: 4 }, 8) < 960);
});

test('MIDI recording still captures performed velocity and elapsed duration through the original path', async () => {
  const f = fixture(); f.MIDI.on = true; f.S.playing = true;
  f.sandbox.time = 3; f.midi(0x90, 60, 29);
  f.sandbox.time = 3.75; f.midi(0x90, 60, 0); await tick();
  assert.equal(JSON.stringify(f.MIDI.notes), JSON.stringify([{ bar: 2, beat: 1, tick: 120, dur_ticks: 1440, pitch: 60, vel: 29 }]));
  assert.equal(f.MIDI.open.size, 0);
  assert.ok(f.calls.every(call => call.action === 'preview_note'), 'audition makes no note-document writes');
  f.stopHeldAuditions();
});

test('selected MIDI input filtering and editor latest-note behavior remain intact', async () => {
  const f = fixture(); f.midiDevice.value = 'keys-a'; f.midi(0x90, 60, 90, 'keys-b');
  assert.equal(f.calls.length, 0);
  await f.auditionNote(60, 45, 240); await f.auditionNote(64, 85, 480);
  assert.equal(f.nodes.length, 2); assert.equal(f.nodes[0].stops.length, 1); assert.equal(f.nodes[1].stops.length, 0);
  assert.equal(f.calls[0].dur_ticks, 240); assert.equal(f.calls[1].vel, 85);
  f.auditionStop();
});

test('lifecycle wiring covers toggle, project/track deletion, input changes and disconnects', () => {
  for (const name of ['stop', 'selectTrack', 'refreshDoc']) assert.match(fn(name), /stopHeldAuditions\(\)/);
  assert.match(source, /if \(!S\.aud\.on\) \{ \+\+S\.aud\.seq; auditionStop\(\); stopHeldAuditions\(\); \}/);
  assert.match(source, /MIDI\.access\.onstatechange = \(\) => \{\s*stopHeldAuditions\(\)/);
  assert.match(source, /\$\("midiDev"\)\.addEventListener\("change", stopHeldAuditions\)/);
  assert.match(fn('loadProject'), /stop\(\)/);
});
