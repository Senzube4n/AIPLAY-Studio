/**
 * The rack's demo bounce — 4 bars of drums + bass through the real routes.
 *
 * Not a test: a LISTENABLE artifact, built the way a user would build it, so
 * the owner can hear what the chain stage actually does. Everything goes over
 * HTTP to a running server (the shipped path, not a python import), and the
 * bounce is the region file the browser would have played, saved next to a
 * 16-bit twin that opens in anything.
 *
 *   node scripts/daw_rack_demo.mjs <port> <outDir>
 *
 * The chain, deliberately audible:
 *   bass (pluck, low)  → EQ (low bell +4, HP 40) → send -8 dB to the verb
 *   kit  (drums)       → compressor (-26 dB, 6:1, fast) → gate
 *   return "Verb"      → reverb (room .6, mix 1.0)
 *   master             → EQ (air +2) → limiter (-1 dBTP)
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";

const PORT = process.argv[2] || "4271";
const OUT = process.argv[3] || ".";
const BASE = `http://127.0.0.1:${PORT}`;

const api = async (body) => {
  const r = await fetch(`${BASE}/api/daw`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ error: `non-JSON ${r.status}` }));
  if (j.error) throw new Error(`${body.action}: ${j.error}`);
  return j;
};

const stamp = Date.now().toString(36);
const c = await api({ action: "create", name: `rack-demo-${stamp}`, bpm: 100, num: 4, den: 4, length_bars: 4 });
const slug = c.slug;
console.log(`  project ${slug} — 4 bars, 100 bpm, 4/4`);

const bass = await api({ action: "add_track", slug, instrument: "pluck", name: "bass" });
const kit = await api({ action: "add_track", slug, instrument: "drums", name: "kit" });

/* A two-bar bass figure, repeated: root-fifth-octave walk in A. */
const FIG = [
  [1, 1, 33], [1, 3, 40], [2, 1, 33], [2, 3, 45],
  [3, 1, 31], [3, 3, 38], [4, 1, 33], [4, 4, 40],
];
for (const [bar, beat, pitch] of FIG) {
  await api({ action: "add_note", slug, track: bass.trackId, bar, beat, pitch, vel: 105, dur_ticks: 900 });
}
/* Kick on 1 and 3, snare on 2 and 4, hats on the eighths. */
for (let bar = 1; bar <= 4; bar++) {
  for (const beat of [1, 3]) await api({ action: "add_note", slug, track: kit.trackId, bar, beat, pitch: 36, vel: 118, dur_ticks: 240 });
  for (const beat of [2, 4]) await api({ action: "add_note", slug, track: kit.trackId, bar, beat, pitch: 38, vel: 104, dur_ticks: 240 });
  for (const beat of [1, 2, 3, 4]) {
    for (const tick of [0, 480]) {
      await api({ action: "add_note", slug, track: kit.trackId, bar, beat, tick, pitch: 42, vel: tick ? 62 : 84, dur_ticks: 120 });
    }
  }
}

/* The rack. */
await api({ action: "insert_add", slug, target: bass.trackId, type: "eq",
            params: { hp_on: true, hp_hz: 40, b1_hz: 90, b1_gain_db: 4, b1_q: 0.9, b4_gain_db: -3 } });
await api({ action: "insert_add", slug, target: kit.trackId, type: "compressor",
            params: { threshold_db: -26, ratio: 6, attack_ms: 3, release_ms: 90, makeup_db: 3 } });
await api({ action: "insert_add", slug, target: kit.trackId, type: "gate",
            params: { threshold_db: -55, range_db: -24, release_ms: 120 } });
const ret = await api({ action: "return_add", slug, name: "Verb" });
await api({ action: "insert_add", slug, target: ret.returnId, type: "reverb",
            params: { room_size: 0.6, damp: 0.45, mix: 1.0, predelay_ms: 18 } });
await api({ action: "send_set", slug, track: bass.trackId, to: ret.returnId, level: -8 });
await api({ action: "send_set", slug, track: kit.trackId, to: ret.returnId, level: -14 });
/* Gain staging pushed on purpose: the P0 prototype synths are quiet (every
 * voice carries a 0.5 headroom factor), and at their natural level the master
 * limiter never engages — a demo that demonstrates nothing. These faders put
 * ~+10 dB into the master so the limiter actually catches the kick, which is
 * the thing worth hearing.
 *
 * The drive goes in the master CHAIN, not on the master fader, and that is
 * not a style choice: by the seam contract the fader runs AFTER the chain, so
 * a master limiter does not protect against the master fader (Ableton behaves
 * the same way — the limiter is a device, the fader is downstream of it).
 * Putting +8 on the fader here measured 1.58 dBTP out of a -1 dBTP limiter,
 * which is the contract working, not the limiter failing. */
await api({ action: "mixer_set", slug, target: bass.trackId, fader: 4, pan: 0 });
await api({ action: "mixer_set", slug, target: kit.trackId, fader: 5, pan: 0.1 });
await api({ action: "insert_add", slug, target: "master", type: "utility", params: { gain_db: 8 } });
await api({ action: "insert_add", slug, target: "master", type: "eq", params: { b4_hz: 9000, b4_gain_db: 2, b4_q: 0.7 } });
await api({ action: "insert_add", slug, target: "master", type: "limiter", params: { ceiling_db: -1 } });

const r = await api({ action: "render", slug });
console.log(`  rendered ${r.rendered} region(s) in ${r.ms} ms`);
if (r.regions.length !== 1) throw new Error(`expected one 4-bar region, got ${r.regions.length}`);

const wav = Buffer.from(await (await fetch(`${BASE}${r.regions[0].url}`)).arrayBuffer());
const bouncePath = path.join(OUT, "daw_rack_demo_f32.wav");
await writeFile(bouncePath, wav);

const met = await api({ action: "meters", slug });
console.log(`  master: ${met.master.lufs} LUFS  ${met.master.true_peak_db} dBTP  peak ${met.master.peak_db} dBFS`);
for (const [id, m] of Object.entries(met.tracks)) console.log(`  track ${m.name.padEnd(6)} ${String(m.lufs).padStart(7)} LUFS  peak ${m.peak_db} dBFS`);
for (const [id, m] of Object.entries(met.returns)) console.log(`  return ${m.name.padEnd(5)} ${String(m.lufs).padStart(7)} LUFS  peak ${m.peak_db} dBFS`);

/* THE ASSERTION. A bounce that lands outside this window means the chain
 * stage broke something between the notes and the file — too quiet is a
 * fader/gain fault, too loud means the limiter did not hold. The window is
 * wide on purpose: it is a smoke gate on the graph, not a mastering opinion. */
const LO = -20, HI = -8;
const lufs = met.master.lufs;
if (!(lufs > LO && lufs < HI)) {
  throw new Error(`the bounce measured ${lufs} LUFS — outside the sane window ${LO}..${HI}`);
}
const CEIL = -1;
if (!(met.master.true_peak_db <= CEIL + 0.2)) {
  throw new Error(`true peak ${met.master.true_peak_db} dBTP broke the ${CEIL} dBTP ceiling`);
}
console.log(`  LUFS ${lufs} is inside the sane window ${LO}..${HI}; the ${CEIL} dBTP ceiling held`);

/* A 16-bit PCM twin, because float32 wav does not open in everything and this
 * file exists to be LISTENED to. TPDF dither, since 32 -> 16 is a real
 * requantisation and truncating it would add the one artefact the rack is
 * meant not to have. */
const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
let pos = 12, sr = 48000, ch = 2, f32 = null;
while (pos + 8 <= wav.byteLength) {
  const id = String.fromCharCode(dv.getUint8(pos), dv.getUint8(pos + 1), dv.getUint8(pos + 2), dv.getUint8(pos + 3));
  const size = dv.getUint32(pos + 4, true);
  if (id === "fmt ") { ch = dv.getUint16(pos + 10, true); sr = dv.getUint32(pos + 12, true); }
  if (id === "data") f32 = new Float32Array(wav.buffer.slice(wav.byteOffset + pos + 8, wav.byteOffset + pos + 8 + size));
  pos += 8 + size + (size & 1);
}
const pcm = Buffer.alloc(f32.length * 2);
for (let i = 0; i < f32.length; i++) {
  const dither = (Math.random() + Math.random() - 1) / 32768;
  pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((f32[i] + dither) * 32767))), i * 2);
}
const head = Buffer.alloc(44);
head.write("RIFF", 0); head.writeUInt32LE(36 + pcm.length, 4); head.write("WAVE", 8);
head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
head.writeUInt16LE(ch, 22); head.writeUInt32LE(sr, 24);
head.writeUInt32LE(sr * ch * 2, 28); head.writeUInt16LE(ch * 2, 32); head.writeUInt16LE(16, 34);
head.write("data", 36); head.writeUInt32LE(pcm.length, 40);
const playPath = path.join(OUT, "daw_rack_demo.wav");
await writeFile(playPath, Buffer.concat([head, pcm]));
console.log(`  ${(f32.length / ch / sr).toFixed(2)} s, ${ch} ch, ${sr} Hz — 16-bit twin written`);

await api({ action: "delete", slug });
console.log(JSON.stringify({ ok: true, wav: playPath, float32: bouncePath, meters: met.master }));
