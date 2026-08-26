/**
 * End-to-end check of the DAW P0 surface, over HTTP and over MCP.
 *
 * Every assertion goes through the wire, because the seam between store.js,
 * routes.js and engine.py is where the unit tests cannot look. The two big
 * sections are the P0 gates themselves:
 *
 *   THE DIRTY GATE   an edit in bar 9 re-renders ONLY the region holding
 *                    bar 9 — asserted from the render manifest's own
 *                    rendered/cached flags, not from trust.
 *   THE STOPWATCH    50 scripted edits, each timed gesture→ack→render-done→
 *                    region-bytes-fetched, at 120 bpm 4/4 AND in 7/8 with a
 *                    mid-song meter change. (The audible-swap tail of the
 *                    chain needs Web Audio and is measured in the browser;
 *                    this script's "fetched" is everything but the decode.)
 *
 * Needs the server running:  AIPLAY_UI_PORT=4260 node server/index.js
 * Then:                      node scripts/e2e_daw.mjs 4260
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = process.argv[2] || "4260";
const BASE = `http://127.0.0.1:${PORT}`;
const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
const fails = [];
const log = (...a) => console.log(...a);

function ok(label, cond, detail = "") {
  if (cond) { pass++; log(`  ok    ${label}`); }
  else { fails.push(label); log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

async function api(body) {
  const r = await fetch(`${BASE}/api/daw`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ error: `non-JSON ${r.status}` }));
  if (j.error) throw new Error(j.error);
  return j;
}
const get = async (p) => {
  const r = await fetch(`${BASE}${p}`);
  const j = await r.json().catch(() => ({ error: `non-JSON ${r.status}` }));
  if (j.error) throw new Error(j.error);
  return j;
};

/** Minimal WAV reader: returns { sr, samples: Float32Array }. */
function parseWav(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, false) !== 0x52494646) throw new Error("not RIFF");
  let pos = 12, sr = 0, samples = null;
  while (pos + 8 <= buf.byteLength) {
    const id = String.fromCharCode(dv.getUint8(pos), dv.getUint8(pos + 1), dv.getUint8(pos + 2), dv.getUint8(pos + 3));
    const size = dv.getUint32(pos + 4, true);
    if (id === "fmt ") sr = dv.getUint32(pos + 12, true);
    if (id === "data") samples = new Float32Array(buf.slice(pos + 8, pos + 8 + size));
    pos += 8 + size + (size & 1);
  }
  if (!sr || !samples) throw new Error("wav missing fmt/data");
  return { sr, samples };
}

const quantile = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const ms = (v) => `${v.toFixed(0)}ms`;

const stamp = Date.now().toString(36);
const made = [];

/**
 * One measured edit: move a note, then render (only dirty regions re-render),
 * then fetch every region file the render says it (re)wrote.
 */
async function timedEdit(slug, track, noteId, patch) {
  const t0 = performance.now();
  const mv = await api({ action: "move_note", slug, track, note: noteId, ...patch });
  const tAck = performance.now();
  const r = await api({ action: "render", slug });
  const tRender = performance.now();
  const changed = r.regions.filter((g) => g.rendered);
  await Promise.all(changed.map(async (g) => {
    const resp = await fetch(`${BASE}${g.url}`);
    await resp.arrayBuffer();
  }));
  const tFetched = performance.now();
  return {
    ack: tAck - t0, render: tRender - t0, fetched: tFetched - t0,
    rendered: changed.length, cached: r.cachedHits, dirty: mv.dirty,
  };
}

function report(label, runs) {
  const f = runs.map((r) => r.fetched);
  const a = runs.map((r) => r.ack);
  const rr = runs.map((r) => r.render);
  log(`\n        ${label} (n=${runs.length})`);
  log(`          edit ack        median ${ms(quantile(a, 0.5))}   p95 ${ms(quantile(a, 0.95))}`);
  log(`          + render done   median ${ms(quantile(rr, 0.5))}   p95 ${ms(quantile(rr, 0.95))}`);
  log(`          + bytes fetched median ${ms(quantile(f, 0.5))}   p95 ${ms(quantile(f, 0.95))}`);
  return { median: quantile(f, 0.5), p95: quantile(f, 0.95) };
}

let mcp = null;
try {
  log("\n-- the two tail tables are one table --");
  const probe = await api({ action: "probe" });
  ok("engine and store agree on instruments",
    JSON.stringify(probe.instruments) === JSON.stringify([...probe.storeInstruments].sort()),
    `${JSON.stringify(probe.instruments)} vs ${JSON.stringify(probe.storeInstruments)}`);
  ok("engine and store agree on tails",
    JSON.stringify(probe.tails) === JSON.stringify(probe.storeTails),
    `${JSON.stringify(probe.tails)} vs ${JSON.stringify(probe.storeTails)}`);
  ok("the render lane is the persistent serve child", probe.engine === "serve", probe.engine);

  log("\n-- a project builds over HTTP --");
  const c = await api({ action: "create", name: `e2e-${stamp}`, bpm: 120, num: 4, den: 4, length_bars: 16 });
  const slug = c.slug; made.push(slug);
  const tr1 = await api({ action: "add_track", slug, instrument: "pluck", name: "keys" });
  const tr2 = await api({ action: "add_track", slug, instrument: "pad", name: "pad" });
  const tr3 = await api({ action: "add_track", slug, instrument: "drums", name: "kit" });
  ok("tracks arrive with a full-length clip", !!tr1.clipId && !!tr3.clipId);

  const seeds = [];
  for (let i = 0; i < 8; i++) {
    seeds.push((await api({ action: "add_note", slug, track: tr1.trackId,
      bar: 1 + i * 2, beat: 1 + (i % 4), pitch: 52 + (i * 5) % 24, vel: 100 })).note);
  }
  await api({ action: "add_note", slug, track: tr2.trackId, bar: 1, beat: 1, pitch: 48, dur_ticks: 3840 });
  for (let b = 1; b <= 16; b += 2) {
    await api({ action: "add_note", slug, track: tr3.trackId, bar: b, beat: 1, pitch: 36, dur_ticks: 240 });
    await api({ action: "add_note", slug, track: tr3.trackId, bar: b, beat: 3, pitch: 38, dur_ticks: 240 });
  }
  const full = await get(`/api/daw/project/${slug}`);
  ok("16 bars of 4/4 at 120 derive 2 s bars", near(full.timeline[0].secLen, 2) && near(full.totalSeconds, 32));
  ok("the manifest has 4 regions abutting in samples",
    full.regions.length === 4
    && full.regions.every((r, i) => i === 0
      || r.startSample === full.regions[i - 1].startSample + full.regions[i - 1].nSamples));

  log("\n-- first render renders, second render caches --");
  const r1 = await api({ action: "render", slug });
  ok("all 4 regions rendered", r1.rendered === 4 && r1.cachedHits === 0, JSON.stringify({ rendered: r1.rendered, cached: r1.cachedHits }));
  const r2 = await api({ action: "render", slug });
  ok("an unchanged project is 4 cache hits, 0 renders", r2.rendered === 0 && r2.cachedHits === 4);
  ok("cache hits answer fast", r2.ms < 250, `${r2.ms} ms`);

  log("\n-- the region files are real audio --");
  const wav0 = parseWav(await (await fetch(`${BASE}${r1.regions[0].url}`)).arrayBuffer());
  ok("region 0 is 48 kHz float32", wav0.sr === 48000);
  ok("...with exactly the manifest's sample count", wav0.samples.length === r1.regions[0].nSamples,
    `${wav0.samples.length} vs ${r1.regions[0].nSamples}`);
  let peak = 0;
  for (const s of wav0.samples) peak = Math.max(peak, Math.abs(s));
  ok("...and it is not silence", peak > 0.01, `peak ${peak}`);

  log("\n-- THE DIRTY GATE: an edit in bar 9 re-renders only its region --");
  const mv = await api({ action: "move_note", slug, track: tr1.trackId, note: seeds[4].id, pitch: 71 });
  ok("the edit names its dirt: bars 9-12", mv.dirty.length === 1 && mv.dirty[0].fromBar === 9 && mv.dirty[0].toBar === 12,
    JSON.stringify(mv.dirty));
  const r3 = await api({ action: "render", slug });
  ok("render touches exactly ONE region", r3.rendered === 1 && r3.cachedHits === 3,
    JSON.stringify(r3.regions.map((g) => ({ idx: g.idx, rendered: g.rendered, cached: g.cached }))));
  ok("...the region holding bar 9", r3.regions.find((g) => g.rendered)?.fromBar === 9);
  ok("a re-rendered region gets a NEW immutable url",
    r3.regions[2].url !== r1.regions[2].url && r3.regions[0].url === r1.regions[0].url);

  log("\n-- meter and tempo change mid-song, honestly --");
  const sm = await api({ action: "set_meter", slug, at_bar: 5, num: 7, den: 8 });
  ok("the meter change leaves bars 1-4 clean", !sm.dirty.some((d) => d.fromBar === 1), JSON.stringify(sm.dirty));
  const full2 = await get(`/api/daw/project/${slug}`);
  ok("bar 5 is now a 1.75 s 7/8 bar", near(full2.timeline[4].secLen, 1.75) && full2.timeline[4].num === 7);
  ok("beat 7 exists in bar 5",
    !!(await api({ action: "add_note", slug, track: tr1.trackId, bar: 5, beat: 7, pitch: 60 })).note);
  let refused = "";
  try { await api({ action: "add_note", slug, track: tr1.trackId, bar: 5, beat: 8, pitch: 60 }); }
  catch (e) { refused = e.message; }
  ok("beat 8 is refused, naming the meter", /7\/8/.test(refused), refused);
  const st = await api({ action: "set_tempo", slug, at_bar: 13, bpm: 90 });
  ok("a tempo change dirties from its bar on", st.dirty.length > 0 && !st.dirty.some((d) => d.fromBar < 13),
    JSON.stringify(st.dirty));
  await api({ action: "remove_meter", slug, at_bar: 5 });
  await api({ action: "remove_tempo", slug, at_bar: 13 });
  await api({ action: "render", slug });

  log("\n-- THE STOPWATCH, 4/4 at 120 bpm: 50 scripted edits --");
  {
    const runs = [];
    for (let i = 0; i < 50; i++) {
      runs.push(await timedEdit(slug, tr1.trackId, seeds[4].id,
        { pitch: 60 + (i % 12), beat: 1 + (i % 4) }));
    }
    ok("every edit dirtied exactly one ≤4-bar region",
      runs.every((r) => r.dirty.length === 1 && r.rendered === 1),
      JSON.stringify(runs.find((r) => r.dirty.length !== 1)?.dirty ?? runs.find((r) => r.rendered !== 1) ?? {}));
    const s = report("4/4 @120, one dirty region", runs);
    ok(`GATE: median edit→fetched ${ms(s.median)} < 1000ms`, s.median < 1000);
    log(`        p95 ${ms(s.p95)} (gate is on the median; p95 reported honestly)`);
  }

  log("\n-- THE STOPWATCH, 7/8 with a mid-song meter change --");
  {
    const c2 = await api({ action: "create", name: `e2e-odd-${stamp}`, bpm: 120, num: 7, den: 8, length_bars: 16 });
    const slug2 = c2.slug; made.push(slug2);
    const t = await api({ action: "add_track", slug: slug2, instrument: "pluck", name: "keys" });
    await api({ action: "set_meter", slug: slug2, at_bar: 9, num: 4, den: 4 });
    const n1 = (await api({ action: "add_note", slug: slug2, track: t.trackId, bar: 2, beat: 3, pitch: 57 })).note;
    const n2 = (await api({ action: "add_note", slug: slug2, track: t.trackId, bar: 10, beat: 2, pitch: 64 })).note;
    for (let b = 1; b <= 16; b += 3) {
      await api({ action: "add_note", slug: slug2, track: t.trackId, bar: b, beat: 1, pitch: 45 });
    }
    const fo = await get(`/api/daw/project/${slug2}`);
    // a 7/8 bar at 120 QUARTER-bpm: 7 eighths x 0.25 s = 1.75 s
    ok("bars 1-8 are 7/8 (1.75 s), bars 9+ are 4/4 (2 s)",
      near(fo.timeline[0].secLen, 1.75) && near(fo.timeline[8].secLen, 2) && fo.timeline[8].num === 4);
    await api({ action: "render", slug: slug2 });
    const runs = [];
    for (let i = 0; i < 50; i++) {
      const odd = i % 2 === 0;
      runs.push(await timedEdit(slug2, t.trackId, odd ? n1.id : n2.id,
        odd ? { pitch: 55 + (i % 10), beat: 1 + (i % 7) } : { pitch: 60 + (i % 10), beat: 1 + (i % 4) }));
    }
    /* rendered === 0 is legal here and worth keeping legal: an edit that
     * returns a note to a recently-held state finds that exact render still
     * in the content-addressed cache (CACHE_KEEP generations) — a full cache
     * hit, which is the mechanism succeeding, not skipping. What is never
     * legal is an edit dirtying more than its own neighbourhood. */
    ok("every edit dirties exactly one region, never more",
      runs.every((r) => r.dirty.length === 1 && r.rendered <= 1),
      JSON.stringify(runs.filter((r) => r.dirty.length !== 1 || r.rendered > 1).slice(0, 2)));
    const s = report("7/8→4/4 @120, alternating halves", runs);
    ok(`GATE: median edit→fetched ${ms(s.median)} < 1000ms`, s.median < 1000);
    log(`        p95 ${ms(s.p95)}`);
  }

  log("\n-- P0-4 over the wire: a synthetic loopback through the real route --");
  {
    const chirpBuf = await (await fetch(`${BASE}/api/daw/chirp.wav`)).arrayBuffer();
    const chirp = parseWav(chirpBuf);
    ok("the chirp serves as 48 kHz float32", chirp.sr === 48000 && chirp.samples.length > 20000);
    const sr = chirp.sr;
    const delay = Math.round(0.0873 * sr);
    const cap = new Float32Array(delay + chirp.samples.length + sr / 2);
    for (let i = 0; i < chirp.samples.length; i++) cap[delay + i] = chirp.samples[i] * 0.3;
    for (let i = 0; i < cap.length; i++) cap[i] += (Math.random() - 0.5) * 0.02;
    const r = await fetch(`${BASE}/api/daw/calibrate?sr=${sr}`, { method: "POST", body: cap.buffer });
    const j = await r.json();
    ok("the estimator answers confidently", j.ok && j.confident, JSON.stringify(j));
    ok(`87.3 ms recovered as ${j.offset_ms} ms (±1 ms)`, Math.abs(j.offset_ms - 87.3) <= 1.0);
  }

  log("\n-- [DAWREC] the calibration WIZARD end-to-end, on injected samples --");
  {
    // the wizard's no-mic branch: the server injects a known-offset capture,
    // the SAME /api/daw/calibrate wire estimates it, set_latency stores it
    const capResp = await fetch(`${BASE}/api/daw/testcap.f32?offset_ms=87.3&sr=48000`);
    ok("the injection route hands back a capture and names its truth",
      capResp.ok && capResp.headers.get("x-injected-offset-ms") === "87.3");
    const cap = await capResp.arrayBuffer();
    const est = await (await fetch(`${BASE}/api/daw/calibrate?sr=48000`, { method: "POST", body: cap })).json();
    ok("the estimator is confident on the injected capture", est.ok && est.confident, JSON.stringify(est));
    ok(`87.3 ms recovered as ${est.offset_ms} ms (±1 ms) through the wizard's wire`,
      Math.abs(est.offset_ms - 87.3) <= 1.0);
    const stored = await api({ action: "set_latency", device: "e2e-mic", offset_ms: est.offset_ms });
    ok("the offset stores per device", stored.ok && Math.abs(stored.latency["e2e-mic"] - est.offset_ms) < 1e-6);
    const readBack = await api({ action: "set_latency" });
    ok("set_latency with no offset READS the table", Math.abs(readBack.latency["e2e-mic"] - est.offset_ms) < 1e-6);
  }

  log("\n-- [DAWREC] a synthetic capture lands a take at the RIGHT SAMPLE --");
  let recSlug, recTrack;
  {
    const c = await api({ action: "create", name: `e2e-rec-${stamp}`, bpm: 120, num: 4, den: 4, length_bars: 8 });
    recSlug = c.slug; made.push(recSlug);
    const tr = await api({ action: "add_track", slug: recSlug, instrument: "pluck", name: "mic" });
    recTrack = tr.trackId;

    let refuse = "";
    try { await api({ action: "record_start", slug: recSlug, track: recTrack, bar: 3 }); }
    catch (e) { refuse = e.message; }
    ok("recording an unarmed track is refused, naming the fix", /record_arm/.test(refuse), refuse);
    await api({ action: "record_arm", slug: recSlug, track: recTrack, armed: true });

    // no offset stored for this device label -> shift 0
    const st = await api({ action: "record_start", slug: recSlug, track: recTrack,
                           bar: 3, beat: 1, tick: 0, countin_bars: 1, device: "e2e-null" });
    ok("bar 3 of 4/4 @120 anchors at sample 192000", st.start_sample === 192000, JSON.stringify(st));
    ok("one 4/4 count-in bar is exactly 2 s", near(st.countin_seconds, 2));
    ok("no stored offset for this device → shift 0", st.shift_samples === 0);

    // a 0.5 s capture with one known impulse, split at awkward chunk sizes,
    // posted OUT OF ORDER — assembly is strict by seq
    const take = new Float32Array(24000);
    take[100] = 0.5;
    const cuts = [0, 7001, 16000, 24000];
    for (const seq of [1, 2, 0]) {
      const part = take.subarray(cuts[seq], cuts[seq + 1]);
      const r = await fetch(`${BASE}/api/daw/record/chunk?rec=${st.rec_id}&seq=${seq}`,
        { method: "POST", body: part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) });
      const j = await r.json();
      ok(`chunk ${seq} accepted (${j.samples} samples)`, j.ok && j.samples === cuts[seq + 1] - cuts[seq]);
    }
    const stop = await api({ action: "record_stop", slug: recSlug, rec_id: st.rec_id, name: "impulse" });
    ok("the take lands at sample 192000 with all 24000 samples",
      stop.start_sample === 192000 && stop.take.samples === 24000, JSON.stringify(stop.take));
    ok("the take file is lossless flac (or honest wav without PyAV)",
      /\.(flac|wav)$/.test(stop.take.file), stop.take.file);
    const takeResp = await fetch(`${BASE}${stop.url}`);
    ok("the take file serves immutably", takeResp.ok
      && /immutable/.test(takeResp.headers.get("cache-control") || ""));

    // comp the whole take -> a clip -> the RENDER puts the impulse exactly
    // at absolute sample 192100 (take start 192000 + local 100)
    const comp = await api({ action: "take_comp", slug: recSlug, track: recTrack, whole_take: stop.take.id });
    ok("the comp clip anchors at the take's absolute start", comp.start_sample === 192000);
    ok("the comp names its dirty regions (bar 3 lives in region 0)",
      comp.dirty.some((d) => d.fromBar === 1), JSON.stringify(comp.dirty));
    const rr = await api({ action: "render", slug: recSlug });
    const reg0 = parseWav(await (await fetch(`${BASE}${rr.regions[0].url}`)).arrayBuffer());
    const expect = Math.tanh(0.7 * 0.5);
    ok(`the impulse renders AT sample 192100 (${reg0.samples[192100].toFixed(5)} ≈ tanh(0.7·0.5))`,
      Math.abs(reg0.samples[192100] - expect) < 2e-3);
    ok("...and its neighbours are silent (placement is sample-exact, not near)",
      Math.abs(reg0.samples[192099]) < 1e-6 && Math.abs(reg0.samples[192101]) < 1e-6);

    // with the wizard's stored offset the same take lands 2400ish EARLIER
    const st2 = await api({ action: "record_start", slug: recSlug, track: recTrack,
                            bar: 3, beat: 1, tick: 0, countin_bars: 0, device: "e2e-mic" });
    const expShift = -Math.round(st2.offset_ms / 1000 * 48000);
    ok(`the stored 87.3 ms offset becomes shift ${st2.shift_samples}`,
      st2.shift_samples === expShift && st2.shift_samples < -4100);
    const b64 = Buffer.from(take.buffer, 0, take.byteLength).toString("base64");
    await api({ action: "record_chunk_b64", rec_id: st2.rec_id, seq: 0, samples_b64: b64 });
    const stop2 = await api({ action: "record_stop", slug: recSlug, rec_id: st2.rec_id, name: "shifted" });
    ok("the calibrated take is placed EARLIER by exactly the offset",
      stop2.start_sample === 192000 + expShift, JSON.stringify({ got: stop2.start_sample, expShift }));

    // provenance: both HTTP-path takes carry actor "user", type "record"
    const rs = await api({ action: "record_status", slug: recSlug });
    const recEvents = (rs.provenance || []).filter((e) => e.type === "record");
    ok("browser-path takes log RECORD events (human-recorded), actor user",
      recEvents.length >= 2 && recEvents.every((e) => e.actor === "user"),
      JSON.stringify(rs.provenance));
    ok("record_status shows the armed track and the stored latency",
      rs.armed.includes(recTrack) && Math.abs(rs.latency["e2e-mic"] - 87.3) <= 1.0);
  }

  log("\n-- [DAWREC] comping: ordered picks flatten to the clip the track renders --");
  {
    // two takes of KNOWN constant value at bar 1; the comp switches source
    // mid-window and the rendered samples must switch with it
    const takes = [];
    for (const val of [0.25, 0.5]) {
      const st = await api({ action: "record_start", slug: recSlug, track: recTrack,
                             bar: 1, beat: 1, tick: 0, countin_bars: 0, device: "e2e-null" });
      const buf = new Float32Array(48000).fill(val);
      await api({ action: "record_chunk_b64", rec_id: st.rec_id, seq: 0,
                  samples_b64: Buffer.from(buf.buffer).toString("base64") });
      const stop = await api({ action: "record_stop", slug: recSlug, rec_id: st.rec_id, name: `dc${val}` });
      takes.push(stop.take);
    }
    const comp = await api({ action: "take_comp", slug: recSlug, track: recTrack,
                             picks: [
                               { take: takes[0].id, from_sample: 0, to_sample: 48000 },
                               { take: takes[1].id, from_sample: 24000, to_sample: 48000 },
                             ], name: "ab-comp" });
    ok("the comp clip covers the union of the picks", comp.start_sample === 0
      && comp.clip.durSamples === 48000, JSON.stringify(comp.clip));
    await api({ action: "render", slug: recSlug });
    const rr = await api({ action: "render", slug: recSlug });
    const reg0 = parseWav(await (await fetch(`${BASE}${rr.regions[0].url}`)).arrayBuffer());
    const a = Math.tanh(0.7 * 0.25), b = Math.tanh(0.7 * 0.5);
    ok(`before the switch the FIRST pick sounds (${reg0.samples[12000].toFixed(4)} ≈ ${a.toFixed(4)})`,
      Math.abs(reg0.samples[12000] - a) < 2e-3);
    ok(`after sample 24000 the LATER pick wins (${reg0.samples[36000].toFixed(4)} ≈ ${b.toFixed(4)})`,
      Math.abs(reg0.samples[36000] - b) < 2e-3);
    ok("the switch happens AT the pick boundary",
      Math.abs(reg0.samples[23999] - a) < 2e-3 && Math.abs(reg0.samples[24000] - b) < 2e-3);
    // the takes themselves still do not render: silence after the comp ends
    ok("past the comp the track is silent (takes audition, never render)",
      Math.abs(reg0.samples[60000]) < 1e-6);
  }

  log("\n-- [DAWREC] the count-in is meter-aware over the wire: 7/8 counts in 7 --");
  {
    const c = await api({ action: "create", name: `e2e-odd-rec-${stamp}`, bpm: 120, num: 7, den: 8, length_bars: 4 });
    made.push(c.slug);
    const tr = await api({ action: "add_track", slug: c.slug, instrument: "pluck" });
    await api({ action: "record_arm", slug: c.slug, track: tr.trackId, armed: true });
    const st = await api({ action: "record_start", slug: c.slug, track: tr.trackId,
                           bar: 1, beat: 1, tick: 0, countin_bars: 1 });
    ok("a 7/8 count-in bar at 120 quarter-bpm is 1.75 s", near(st.countin_seconds, 1.75));
    await api({ action: "record_stop", slug: c.slug, rec_id: st.rec_id, cancel: true });
    const clickResp = await fetch(`${BASE}${st.click_url}`);
    ok("the click bed serves with the count-in named in headers",
      clickResp.ok && near(Number(clickResp.headers.get("x-countin-seconds")), 1.75));
    const click = parseWav(await (await clickResp.blob()).arrayBuffer());
    // count click onsets inside the count-in: clusters of energy ≥ 60 ms apart
    let clicks = 0, last = -1e9;
    const countinSamples = Math.round(1.75 * click.sr);
    for (let i = 0; i < countinSamples; i++) {
      if (Math.abs(click.samples[i]) > 0.05 && i - last > 0.06 * click.sr) { clicks++; last = i; }
    }
    ok(`the count-in holds SEVEN clicks (got ${clicks}) — never four`, clicks === 7);
  }

  log("\n-- MCP drives the IDENTICAL path, attributed as the agent --");
  {
    mcp = spawn(process.execPath, [path.join(HERE, "..", "server", "mcp.js")], {
      env: { ...process.env, AIPLAY_URL: BASE }, stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    const pending = new Map();
    mcp.stdout.on("data", (d) => {
      buf += d;
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line);
          if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        } catch { /* not protocol */ }
      }
    });
    let seq = 0;
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, resolve);
      setTimeout(() => { if (pending.delete(id)) reject(new Error(`MCP ${method} timed out`)); }, 60_000);
      mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    const call = async (name, args) => {
      const m = await rpc("tools/call", { name, arguments: args });
      const text = m.result?.content?.[0]?.text ?? "";
      if (m.result?.isError) throw new Error(text);
      return JSON.parse(text);
    };

    const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
    ok("MCP initializes", !!init.result?.serverInfo);
    const list = await rpc("tools/list", {});
    const dawNames = list.result.tools.map((t) => t.name).filter((n) => n.startsWith("daw_"));
    // 14 P0 tools + the 4 capture tools (daw_record, daw_takes, daw_calibrate,
    // daw_import_audio)
    ok(`the daw_ family is served (${dawNames.length} tools)`, dawNames.length === 18, dawNames.join(", "));

    const stat = await call("daw_status", {});
    ok("daw_status sees the projects and a matching engine",
      stat.projects.some((p) => p.slug === slug) && stat.engine.tables_agree === true);

    const added = await call("daw_add_note", { slug, track: tr1.trackId, bar: 11, beat: 2, pitch: 69 });
    ok("daw_add_note lands and names its dirt", !!added.note_id && added.dirty.length === 1);
    const doc = await get(`/api/daw/project/${slug}`);
    const agentNote = doc.project.tracks.find((t) => t.id === tr1.trackId)
      .clips.flatMap((cl) => cl.notes).find((n) => n.id === added.note_id);
    ok("the note is attributed by: \"agent\"", agentNote?.by === "agent");
    const uiNote = doc.project.tracks.find((t) => t.id === tr1.trackId)
      .clips.flatMap((cl) => cl.notes).find((n) => n.id === seeds[0].id);
    ok("the HTTP-made note stayed by: \"user\" — two hands, one document", uiNote?.by === "user");

    const rr = await call("daw_render", { slug });
    ok("daw_render re-renders only the agent's dirty region", rr.rendered === 1 && rr.cached_hits === 3,
      JSON.stringify({ rendered: rr.rendered, cached: rr.cached_hits }));

    const led = await call("daw_ledger", { slug, limit: 5 });
    ok("the ledger's newest entry is the agent's add_note",
      led.ledger[0]?.by === "agent" && led.ledger[0]?.action === "add_note", JSON.stringify(led.ledger[0]));

    const meter = await call("daw_set_meter", { slug, at_bar: 15, num: 5, den: 4 });
    ok("daw_set_meter works over MCP", meter.meter_map.some((m) => m.atBar === 15 && m.num === 5));
    await api({ action: "remove_meter", slug, at_bar: 15 });

    log("\n-- [DAWREC] MCP capture parity — and the provenance CANNOT lie --");
    {
      // the identical record flow, driven by the agent with supplied samples
      const st = await call("daw_record", { op: "start", slug: recSlug, track: recTrack,
                                            bar: 1, beat: 1, tick: 0, countin_bars: 0, device: "e2e-null" });
      ok("daw_record start opens a session", !!st.rec_id && st.start_sample === 0);
      const buf = new Float32Array(24000).fill(0.1);
      const ch = await call("daw_record", { op: "chunk", rec_id: st.rec_id, seq: 0,
                                            samples_b64: Buffer.from(buf.buffer).toString("base64") });
      ok("daw_record chunk lands 24000 samples", ch.samples === 24000);
      const stop = await call("daw_record", { op: "stop", slug: recSlug, rec_id: st.rec_id, name: "agent take" });
      ok("daw_record stop places the take", stop.take.samples === 24000 && stop.start_sample === 0);
      const rs = await call("daw_record", { op: "status", slug: recSlug });
      const newest = (rs.provenance || [])[rs.provenance.length - 1];
      ok("the agent's capture logs IMPORT (origin third-party/existing), NEVER record",
        newest && newest.type === "import" && /^agent:/.test(newest.actor)
        && newest.data?.origin === "third-party/existing", JSON.stringify(newest));
      ok("...while the browser-path record events stay actor user",
        (rs.provenance || []).filter((e) => e.type === "record").every((e) => e.actor === "user"));

      const lst = await call("daw_takes", { op: "list", slug: recSlug, track: recTrack });
      const lane = lst.takes.find((t) => t.track === recTrack);
      ok("daw_takes list shows the whole lane with placement and attribution",
        lane && lane.takes.length >= 4
        && lane.takes.some((k) => k.name === "agent take" && k.by === "agent")
        && lane.takes.every((k) => typeof k.shift_samples === "number" && k.url.includes("/api/daw/take/")));
      const aud = await call("daw_takes", { op: "audition", slug: recSlug, take: lane.takes[0].id });
      ok("daw_takes audition answers the file url and honest metadata",
        aud.url.includes("/api/daw/take/") && aud.seconds > 0);
      const takeBytes = await fetch(`${BASE}${aud.url}`);
      ok("...and the url actually serves", takeBytes.ok);
    }

    log("\n-- [DAWREC] daw_calibrate: the whole wizard, injected, over MCP --");
    {
      const run = await call("daw_calibrate", { op: "run", synthetic_offset_ms: 42 });
      ok(`42 ms injected → ${run.offset_ms} ms recovered (±1 ms), confident`,
        run.confident && Math.abs(run.offset_ms - 42) <= 1.0, JSON.stringify(run));
      const stored = await call("daw_calibrate", { op: "store", device: "e2e-agent-dev", offset_ms: run.offset_ms });
      ok("daw_calibrate store writes the device row", Math.abs(stored.latency["e2e-agent-dev"] - run.offset_ms) < 1e-6);
      const read = await call("daw_calibrate", { op: "read" });
      ok("daw_calibrate read sees both wizard rows",
        Math.abs(read.latency["e2e-agent-dev"] - run.offset_ms) < 1e-6
        && Math.abs(read.latency["e2e-mic"] - 87.3) <= 1.0);
    }

    log("\n-- [DAWREC] daw_import_audio: a file becomes a clip MIXED with notes --");
    {
      // a 1 s 440 Hz tone written as float32 wav beside the server
      const os = await import("node:os");
      const { writeFile: wf } = await import("node:fs/promises");
      const sr = 48000;
      const tone = new Float32Array(sr);
      for (let i = 0; i < sr; i++) tone[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / sr);
      const header = Buffer.alloc(44);
      header.write("RIFF", 0); header.writeUInt32LE(36 + sr * 4, 4); header.write("WAVE", 8);
      header.write("fmt ", 12); header.writeUInt32LE(16, 16);
      header.writeUInt16LE(3, 20); header.writeUInt16LE(1, 22);
      header.writeUInt32LE(sr, 24); header.writeUInt32LE(sr * 4, 28);
      header.writeUInt16LE(4, 32); header.writeUInt16LE(32, 34);
      header.write("data", 36); header.writeUInt32LE(sr * 4, 40);
      const tonePath = path.join(os.tmpdir(), `e2e_tone_${stamp}.wav`);
      await wf(tonePath, Buffer.concat([header, Buffer.from(tone.buffer)]));

      const proj = await call("daw_create_project", { name: `e2e-imp-${stamp}`, bpm: 120, num: 4, den: 4, length_bars: 4 });
      made.push(proj.slug);
      const tr = await call("daw_add_track", { slug: proj.slug, instrument: "pluck", name: "keys" });
      await call("daw_add_note", { slug: proj.slug, track: tr.track_id, bar: 1, beat: 1, pitch: 60, vel: 110 });

      const imp = await call("daw_import_audio", { slug: proj.slug, track: tr.track_id,
                                                   path: tonePath, bar: 2, beat: 1, name: "tone" });
      ok("the import lands as a clip and names its dirty regions",
        !!imp.clip?.id && imp.dirty.length >= 1 && Math.abs(imp.seconds - 1) < 0.01, JSON.stringify(imp.dirty));
      const rr = await call("daw_render", { slug: proj.slug });
      const reg = parseWav(await (await fetch(`${BASE}${rr.regions[0].url}`)).arrayBuffer());
      const rms = (from, to) => {
        let acc = 0;
        for (let i = from; i < to; i++) acc += reg.samples[i] * reg.samples[i];
        return Math.sqrt(acc / (to - from));
      };
      // bar 1 (0-2 s): the NOTE alone · bar 2 (2-4 s): the imported TONE
      // (bar 2 starts at 2 s; the pluck's 1.5 s tail is over by 2.05 s) ·
      // bar 4's back half: silence
      const noteRms = rms(Math.round(0.05 * sr), Math.round(0.4 * sr));
      const toneRms = rms(Math.round(2.3 * sr), Math.round(2.8 * sr));
      const silence = rms(Math.round(7.5 * sr), Math.round(7.9 * sr));
      ok(`the note sounds in bar 1 (rms ${noteRms.toFixed(4)})`, noteRms > 0.01);
      /* The closed form, so this asserts the MIXING and not a guess: a 0.3
       * sine through the master (tanh(0.7·x), the same curve the notes get)
       * has rms sqrt(mean(tanh(0.21·sinθ)²)) = 0.14688 — numerically
       * integrated, and 1% below the 0.7·0.3/√2 = 0.14849 a linear master
       * would give, which is the soft clip doing its job. */
      ok(`the imported clip sounds in bar 2, mixed by the SAME engine (rms ${toneRms.toFixed(4)} ≈ 0.14688, a 0.3 sine through tanh(0.7x))`,
        Math.abs(toneRms - 0.14688) < 0.003);
      ok(`bar 4 is silent (rms ${silence.toExponential(1)})`, silence < 1e-4);
      // and the tone's first sample is exactly at bar 2: sample 96000
      ok("the clip's placement is sample-exact (silence at 95999, signal by 96010)",
        Math.abs(reg.samples[95960]) < 1e-6 && reg.samples.slice(96000, 96010).some((v) => Math.abs(v) > 1e-4));
    }
  }

} catch (err) {
  fails.push(`unhandled: ${err.message}`);
  log(`\n  UNHANDLED: ${err.stack}`);
} finally {
  if (mcp) { try { mcp.stdin.end(); mcp.kill(); } catch { /* gone */ } }
  for (const slug of made) {
    try { await api({ action: "delete", slug }); log(`  (cleaned up ${slug})`); }
    catch { /* already gone */ }
  }
}

log(`\n  ${pass} passed, ${fails.length} failed\n`);
if (fails.length) {
  log("  failed:\n   " + fails.join("\n   ") + "\n");
  process.exit(1);
}
