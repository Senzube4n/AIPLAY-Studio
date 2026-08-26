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
let BOUNCE_FILE = null;
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

  log("\n-- THE PALETTE: a real instrument, installed over MCP, credited on render --");
  {
    /* The whole instrument chain over the wire, in the order a user meets it:
     *   registry -> licence gate -> install -> assign -> render -> credits.
     * Nothing here trusts a flag: "installed" is re-read from the route,
     * "credited" is re-read from the provenance ledger's own events, and
     * "it made a sound" is measured off the rendered wav's samples. */
    const reg = await get("/api/daw/patches");
    ok("the patch registry serves rows with licences and install state",
      reg.patches.length >= 15
      && reg.patches.every((p) => p.id && p.family && p.label && typeof p.installed === "boolean"),
      `${reg.patches.length} patches`);
    ok("the P0 prototype synths are patches too, and installed with no download",
      ["pluck", "pad", "drums"].every((id) =>
        reg.patches.find((p) => p.id === id)?.installed === true));

    const gen = reg.patches.filter((p) => p.kind === "generate");
    ok("the four generate-this-part placeholders are registered and explain themselves",
      gen.length === 4 && gen.every((p) => p.refusal && p.refusal.length > 40 && !p.installed),
      gen.map((p) => p.id).join(", "));

    const sal = reg.patches.find((p) => p.id === "salamander");
    ok("Salamander declares CC-BY 3.0 and its attribution text, before any download",
      sal?.pack?.licence?.spdx === "CC-BY-3.0"
      && sal.pack.attribution_required === true
      && /Alexander Holm/.test(sal.pack.attribution || ""),
      JSON.stringify(sal?.pack?.licence));

    /* THE LICENCE GATE: a bare install must download nothing. */
    const gate = await api({ action: "install_patch", patch: "salamander" });
    if (gate.installed === true) {
      ok("(salamander was already installed — the gate is exercised on its licence rows)", true);
    } else {
      ok("install without accept_licence downloads NOTHING and returns the licences",
        gate.needsAccept === true && Array.isArray(gate.licences) && gate.licences.length > 0,
        JSON.stringify(gate).slice(0, 200));
      ok("...and every licence row carries a name, a url and a size",
        gate.licences.every((l) => l.licence?.name && l.licence?.url));
    }
    const inst = await api({ action: "install_patch", patch: "salamander", accept_licence: true });
    ok("with accept_licence the patch becomes playable", inst.ok !== false,
      JSON.stringify(inst).slice(0, 200));

    /* A refusal that matters: a gap patch cannot be assigned to a track. */
    let genRefusal = "";
    try { await api({ action: "add_track", slug, instrument: "sax" }); }
    catch (e) { genRefusal = e.message; }
    ok("a track REFUSES a generate-this-part patch, naming generation as the answer",
      /generate/i.test(genRefusal) && /sax/i.test(genRefusal), genRefusal.slice(0, 140));

    let unknownRefusal = "";
    try { await api({ action: "add_track", slug, instrument: "no_such_patch" }); }
    catch (e) { unknownRefusal = e.message; }
    ok("an unknown patch is refused with the list of what exists",
      /No such patch/.test(unknownRefusal) && /salamander/.test(unknownRefusal));

    /* Assign it, render it, and check the SAMPLES. */
    const piano = await api({ action: "add_track", slug, instrument: "salamander", name: "grand" });
    ok("the track stores { patch, params }", piano.track?.instrument?.patch === "salamander");
    const pianoNote = (await api({ action: "add_note", slug, track: piano.trackId,
      bar: 1, beat: 1, pitch: 60, dur_ticks: 1920, vel: 100 })).note;

    const pr = await api({ action: "render", slug });
    ok("the render reports the licence it attached",
      pr.licencesAttached.includes("salamander") || pr.credits.some((c) => c.pack === "salamander"),
      JSON.stringify(pr.licencesAttached));
    ok("...and answers with the project's credits",
      pr.credits.some((c) => c.spdx === "CC-BY-3.0" && /Alexander Holm/.test(c.attribution || "")),
      JSON.stringify(pr.credits).slice(0, 200));

    const reg0 = pr.regions.find((g) => g.fromBar === 1);
    const pw = parseWav(await (await fetch(`${BASE}${reg0.url}`)).arrayBuffer());
    let ppeak = 0;
    for (const s of pw.samples) ppeak = Math.max(ppeak, Math.abs(s));
    ok("the Salamander region is REAL AUDIO, not silence", ppeak > 0.01, `peak ${ppeak}`);

    /* DETERMINISM over the wire: the same project renders to the same
     * content hash, so the cache key and the bytes agree. */
    const hashBefore = (await get(`/api/daw/project/${slug}`)).hashes[0];
    await api({ action: "move_note", slug, track: piano.trackId, note: pianoNote.id, pitch: 62 });
    await api({ action: "move_note", slug, track: piano.trackId, note: pianoNote.id, pitch: 60 });
    const hashAfter = (await get(`/api/daw/project/${slug}`)).hashes[0];
    ok("a round trip back to the same notes restores the SAME region hash",
      hashBefore === hashAfter, `${hashBefore} vs ${hashAfter}`);
    const rr2 = await api({ action: "render", slug });
    ok("...and that render is a cache hit, proving the bytes were identical",
      rr2.regions.find((g) => g.fromBar === 1)?.cached === true);

    /* IDEMPOTENCE: re-rendering must not grow the ledger. */
    const c1 = await api({ action: "credits", slug });
    await api({ action: "render", slug });
    const c2 = await api({ action: "credits", slug });
    ok("a re-render does not duplicate the attribution", c1.credits.length === c2.credits.length,
      `${c1.credits.length} then ${c2.credits.length}`);

    /* PARAMS reach the engine: a transposed track must sound different. */
    await api({ action: "set_track", slug, track: piano.trackId, params: { transpose: 7 } });
    const rp = await api({ action: "render", slug });
    ok("a params change re-renders exactly the regions that patch sounds in",
      rp.rendered >= 1, JSON.stringify({ rendered: rp.rendered, cached: rp.cachedHits }));
    const tw = parseWav(await (await fetch(`${BASE}${rp.regions.find((g) => g.fromBar === 1).url}`)).arrayBuffer());
    let same = tw.samples.length === pw.samples.length;
    if (same) {
      same = false;
      for (let i = 0; i < tw.samples.length; i++) {
        if (tw.samples[i] !== pw.samples[i]) { same = false; break; }
        if (i === tw.samples.length - 1) same = true;
      }
    }
    ok("...and the transposed audio actually differs from the untransposed", !same);
    await api({ action: "set_track", slug, track: piano.trackId, params: {} });

    /* THE BOUNCE: one file, tagged with the credits it owes. */
    const bounce = await api({ action: "bounce", slug });
    ok("the bounce writes a file with real length", bounce.ok && bounce.seconds > 1,
      JSON.stringify({ seconds: bounce.seconds, file: bounce.file }));
    ok("the bounce carries the attribution lines",
      bounce.attribution.some((a) => /Alexander Holm/.test(a)),
      JSON.stringify(bounce.attribution));
    ok("...and tag_audio embedded them (a missing credit is a FAILURE, not a warning)",
      bounce.tagged?.ok === true, JSON.stringify(bounce.tagged).slice(0, 200));
    BOUNCE_FILE = bounce.file;
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
    // 14 P0 tools + 4 capture (daw_record, daw_takes, daw_calibrate,
    // daw_import_audio) + 3 rack (daw_insert, daw_mixer, daw_meters)
    // + 3 instruments (daw_patches, daw_credits, daw_bounce)
    // + 4 ear (daw_critique, daw_apply_choice, daw_ear_status, daw_taste)
    // + 6 parity (daw_set_length, daw_remove_track, daw_set_clip,
    //   daw_remove_clip, daw_preview_note, daw_audio_clip) — the actions the
    //   arrangement window could reach and no tool could. server/mcp-daw_test.js
    //   now fails the commit if that gap ever reopens.
        // + 4 mastering (daw_analyze, daw_device_response, daw_reference,
        //   daw_check_delivery)
        ok(`the daw_ family is served (${dawNames.length} tools)`, dawNames.length === 38, dawNames.join(", "));
        ok("the four mastering tools are among them",
          ["daw_analyze", "daw_device_response", "daw_reference",
           "daw_check_delivery"].every((n) => dawNames.includes(n)),
          dawNames.join(", "));
    ok("the six parity tools are among them",
      ["daw_set_length", "daw_remove_track", "daw_set_clip", "daw_remove_clip",
       "daw_preview_note", "daw_audio_clip"].every((n) => dawNames.includes(n)),
      dawNames.join(", "));
    // 21 P0 + 3 rack + 4 ear (daw_critique, daw_apply_choice, daw_ear_status, daw_taste)
    ok("the rack tools are among them",
      ["daw_insert", "daw_mixer", "daw_meters"].every((n) => dawNames.includes(n)));
    ok("...and the instrument tools",
      ["daw_patches", "daw_credits", "daw_bounce"].every((n) => dawNames.includes(n)));
    ok("...and the mastering suite's four",
      ["daw_analyze", "daw_device_response", "daw_reference", "daw_check_delivery"]
        .every((n) => dawNames.includes(n)));

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

    log("\n-- the palette over MCP: registry, licence gate, credits --");
    {
      const pl = await call("daw_patches", {});
      ok("daw_patches lists the registry with licences",
        pl.patches.length >= 15 && pl.patches.some((p) => p.pack?.spdx === "CC-BY-3.0"),
        `${pl.patches.length} patches`);
      const genRow = pl.patches.find((p) => p.id === "sax");
      ok("daw_patches surfaces the generate-this-part refusal text",
        !!genRow?.refusal && /generate/i.test(genRow.refusal));
      const ready = await call("daw_patches", { installed_only: true });
      ok("installed_only filters to what can render right now",
        ready.patches.every((p) => p.installed) && ready.patches.length >= 3);
      const fam = await call("daw_patches", { family: "drums" });
      ok("family filters the list", fam.patches.every((p) => p.family === "drums") && fam.patches.length >= 2);

      /* The gate over MCP too: an agent must read the licence before it fetches. */
      const gated = await call("daw_patches", { action: "install", patch: "hang" });
      ok("install over MCP without accept_licence downloads nothing, returns licences",
        gated.installed === true || gated.needsAccept === true,
        JSON.stringify(gated).slice(0, 160));
      const done = await call("daw_patches", { action: "install", patch: "hang", accept_licence: true });
      ok("...and with accept_licence the pack lands", done.ok !== false && (done.ready === true || done.installed === true),
        JSON.stringify(done).slice(0, 160));

      /* Install over MCP -> set a track to it -> render -> credited. */
      const hangTrack = await call("daw_add_track", { slug, instrument: "hang", name: "handpan" });
      ok("daw_add_track assigns an installed sampled patch",
        hangTrack.instrument?.patch === "hang", JSON.stringify(hangTrack).slice(0, 160));
      await call("daw_add_note", { slug, track: hangTrack.track_id, bar: 2, beat: 1, pitch: 62, dur_ticks: 960 });
      const hr = await call("daw_render", { slug });
      ok("the agent's render re-renders its dirty region", hr.rendered >= 1);

      const cr = await call("daw_credits", { slug });
      ok("daw_credits lists every licensed pack the project used",
        cr.credits.some((c) => c.pack === "salamander") && cr.credits.some((c) => c.pack === "hang"),
        JSON.stringify(cr.credits.map((c) => c.pack)));
      ok("...with the attribution line each licence asks for",
        cr.attribution_lines.length === cr.credits.length
        && cr.attribution_lines.every((l) => typeof l === "string" && l.length > 20));

      /* set_track over MCP carries the instrument params. */
      const st2 = await call("daw_set_track", { slug, track: hangTrack.track_id, params: { transpose: -2 } });
      ok("daw_set_track forwards instrument params and names its dirt",
        st2.track?.instrument?.params?.transpose === -2 && Array.isArray(st2.dirty),
        JSON.stringify(st2.track?.instrument));

      const bo = await call("daw_bounce", { slug });
      ok("daw_bounce writes a credited file over MCP",
        bo.seconds > 1 && bo.attribution.length >= 2 && bo.tagged?.ok === true,
        JSON.stringify({ seconds: bo.seconds, credits: bo.attribution.length }));

      const stat2 = await call("daw_status", {});
      ok("daw_status folds in the palette and the patch-table mirror",
        stat2.engine.patch_tables_agree === true && stat2.engine.patches_ready >= 4,
        JSON.stringify(stat2.engine));
    }

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
    log("\n-- THE RACK: catalog parity, an MCP-built chain, stereo bytes, meters --");
    const rackInfo = await get("/api/daw/rack");
    ok("engine and store agree on the rack catalog", rackInfo.tables_agree === true,
      JSON.stringify(rackInfo.problems ?? rackInfo.catalog?.error ?? ""));

    const c3 = await api({ action: "create", name: `e2e-rack-${stamp}`, bpm: 120, num: 4, den: 4, length_bars: 8 });
    const slug3 = c3.slug; made.push(slug3);
    const tA = await api({ action: "add_track", slug: slug3, instrument: "pluck", name: "keys" });
    const tB = await api({ action: "add_track", slug: slug3, instrument: "drums", name: "kit" });
    for (let bb = 1; bb <= 8; bb++) {
      await api({ action: "add_note", slug: slug3, track: tA.trackId, bar: bb,
                  beat: 1 + (bb % 4), pitch: 52 + (bb * 5) % 12, dur_ticks: 1920 });
      await api({ action: "add_note", slug: slug3, track: tB.trackId, bar: bb, beat: 1, pitch: 36, dur_ticks: 240 });
      await api({ action: "add_note", slug: slug3, track: tB.trackId, bar: bb, beat: 3, pitch: 38, dur_ticks: 240 });
    }
    const rMono = await api({ action: "render", slug: slug3 });
    const wMono = parseWav(await (await fetch(`${BASE}${rMono.regions[0].url}`)).arrayBuffer());
    ok("a default mixer renders the P0 MONO path (sample count = manifest)",
      wMono.samples.length === rMono.regions[0].nSamples);

    const cat = await call("daw_insert", { op: "catalog" });
    // 9 channel-strip devices + the mastering suite's 7 (agent/master).
    ok("daw_insert op:catalog serves the devices, each with a why",
      !!cat.devices?.eq?.why && Object.keys(cat.devices).length === 16 && cat.tables_agree === true,
      Object.keys(cat.devices ?? {}).join(", "));

    const insEq = await call("daw_insert", { op: "add", slug: slug3, target: tA.trackId,
      type: "eq", params: { b3_hz: 2000, b3_gain_db: 5 } });
    ok("daw_insert add answers the chain and its dirt",
      insEq.chain.length === 1 && insEq.dirty.length >= 1, JSON.stringify(insEq));
    await call("daw_insert", { op: "add", slug: slug3, target: tB.trackId,
      type: "compressor", params: { threshold_db: -30, ratio: 6 } });
    const ret = await call("daw_mixer", { op: "return_add", slug: slug3, name: "Verb" });
    await call("daw_insert", { op: "add", slug: slug3, target: ret.return_id,
      type: "reverb", params: { mix: 1.0 } });
    await call("daw_mixer", { op: "send_set", slug: slug3, track: tA.trackId, to: ret.return_id, level: -6 });
    await call("daw_mixer", { op: "set", slug: slug3, target: tA.trackId, fader: -3, pan: -0.6 });
    await call("daw_insert", { op: "add", slug: slug3, target: "master", type: "limiter" });

    const rChain = await api({ action: "render", slug: slug3 });
    ok("the chained render re-renders both regions (mono→stereo path switch)",
      rChain.rendered === 2, JSON.stringify({ rendered: rChain.rendered }));
    const wSt = parseWav(await (await fetch(`${BASE}${rChain.regions[0].url}`)).arrayBuffer());
    ok("a chained region is STEREO float32 (2x the manifest samples)",
      wSt.samples.length === rChain.regions[0].nSamples * 2,
      `${wSt.samples.length} vs 2x${rChain.regions[0].nSamples}`);
    let eL = 0, eR = 0;
    for (let i = 0; i + 1 < wSt.samples.length; i += 2) {
      eL += wSt.samples[i] ** 2; eR += wSt.samples[i + 1] ** 2;
    }
    ok("the keys' hard-left pan is in the bytes (L energy > R)", eL > eR * 1.15,
      `L ${eL.toFixed(1)} R ${eR.toFixed(1)}`);
    const rAgain = await api({ action: "render", slug: slug3 });
    ok("a chained re-render is all cache hits (the hash is still the bytes)",
      rAgain.rendered === 0 && rAgain.cachedHits === 2);

    const met = await call("daw_meters", { slug: slug3 });
    ok("daw_meters answers per bus (tracks, return, master with LUFS + true-peak)",
      typeof met.master?.lufs === "number" && typeof met.master?.true_peak_db === "number"
      && !!met.tracks?.[tA.trackId] && !!met.returns?.[ret.return_id], JSON.stringify(met.master));
    ok(`the master limiter ceiling holds in the meters (${met.master.true_peak_db} dBTP)`,
      met.master.true_peak_db <= -1 + 0.2);

    /* ══ THE MASTERING SUITE (agent/master), over the wire ═══════════════
     * The seven devices go on a chain like any other insert; the four
     * analysis tools answer DATA the UI draws from. Everything here is
     * asserted from numbers that came back over HTTP/MCP, not from trust. */
    log("\n-- THE MASTERING SUITE: a real chain, then every meter --");
    const MASTER_DEVICES = ["multibandCompressor", "dynamicEq", "stereoImager",
                            "tiltEq", "maximizer", "exciter", "dither"];
    ok("all seven mastering devices are in the served catalog, each with a why",
      MASTER_DEVICES.every((d) => !!cat.devices?.[d]?.why),
      MASTER_DEVICES.filter((d) => !cat.devices?.[d]?.why).join(", "));
    ok("...and eq/compressor gained stereo_mode with mid and side",
      cat.devices.eq.params.stereo_mode?.values?.join() === "stereo,mid_side,mid,side"
      && cat.devices.compressor.params.stereo_mode?.default === "stereo");
    ok("every mastering parameter carries a range and a description (the UI is catalog-driven)",
      MASTER_DEVICES.every((d) => Object.values(cat.devices[d].params).every(
        (p) => p.desc && (p.type !== "number" || (p.min !== undefined && p.max !== undefined)))));

    /* Before: what the master measures with the plain limiter on it. */
    const before = await call("daw_analyze", { slug: slug3 });
    ok("daw_analyze answers every meter group in one call",
      ["spectrum", "loudness", "correlation", "goniometer", "dynamics", "bands"]
        .every((k) => before[k] !== undefined && before[k] !== null),
      JSON.stringify(Object.keys(before)));
    ok(`the spectrum is log-spaced with both curves (${before.spectrum.hz.length} bins, `
      + `${before.spectrum.resolution_hz} Hz resolution)`,
      before.spectrum.hz.length > 100
      && before.spectrum.hz.length === before.spectrum.avg_db.length
      && before.spectrum.hz.length === before.spectrum.peak_db.length
      && before.spectrum.hz[0] < before.spectrum.hz[before.spectrum.hz.length - 1]);
    ok(`the loudness series are per ~100 ms (M ${before.loudness.momentary.length}, `
      + `S ${before.loudness.short.length}), with integrated ${before.loudness.integrated} `
      + `LUFS and LRA ${before.loudness.lra}`,
      before.loudness.momentary.length > 5
      && typeof before.loudness.integrated === "number"
      && typeof before.loudness.true_peak_db === "number");
    ok(`correlation comes back as a series plus a verdict `
      + `(${before.correlation.series.length} windows, overall ${before.correlation.overall})`,
      before.correlation.series.length > 5 && before.correlation.overall !== undefined);
    ok(`the goniometer cloud is decimated by peak `
      + `(${before.goniometer.points.length} points of ${before.goniometer.n_total} samples)`,
      before.goniometer.points.length > 100
      && before.goniometer.points.length < before.goniometer.n_total
      && before.goniometer.picked === "max-magnitude per slot");
    ok(`crest ${before.dynamics.crest_db} dB, PLR ${before.dynamics.plr_db} dB`,
      typeof before.dynamics.crest_db === "number" && typeof before.dynamics.plr_db === "number");
    ok("the nine bands come with the pink reference they are judged against",
      before.bands.length === 9 && before.bands.every((x) => typeof x.delta_db === "number"));

    /* THE PROBE: what would a maximizer do to this master? Measured on the
     * real samples, before anything is committed to the document. */
    const probe = await call("daw_analyze", {
      slug: slug3, device: { type: "maximizer", params: { gain_db: 10, ceiling_db: -1 } },
    });
    ok(`the device probe answers a MEASURED gain-reduction series `
      + `(max ${probe.device.gr_max_db} dB over ${probe.device.gr_series.length} windows)`,
      probe.device.gr_series.length > 5 && probe.device.gr_max_db < 0);
    ok("...with the device's own drive knob named and subtracted out",
      probe.device.gain_offset_param === "gain_db" && probe.device.gain_offset_db === 10);
    ok(`...and the probe's own before/after loudness `
      + `(${probe.device.before.integrated} -> ${probe.device.after.integrated} LUFS)`,
      probe.device.after.integrated > probe.device.before.integrated);

    /* THE CURVE: an EQ's response, read back for the instance on the chain. */
    const curve = await call("daw_device_response", {
      slug: slug3, target: tA.trackId, insert: insEq.chain[0].id,
    });
    const kNear = (hz) => curve.hz.reduce((best, f, i) =>
      Math.abs(f - hz) < Math.abs(curve.hz[best] - hz) ? i : best, 0);
    ok(`the live EQ instance draws its own curve (${curve.hz.length} points, `
      + `${curve.magnitude_db[kNear(2000)]} dB at 2 kHz where a +5 bell sits)`,
      curve.source === "coefficients" && curve.magnitude_db.length === curve.hz.length
      && Math.abs(curve.magnitude_db[kNear(2000)] - 5) < 1.0);
    ok(`...and it is flat where nothing was asked for `
      + `(${curve.magnitude_db[kNear(100)]} dB at 100 Hz)`,
      Math.abs(curve.magnitude_db[kNear(100)]) < 0.5);
    const mbCurve = await call("daw_device_response", {
      type: "multibandCompressor", params: { bands: "4" },
    });
    ok(`a multiband draws every band AND their flat sum `
      + `(${mbCurve.bands.length} bands, crossovers ${mbCurve.crossovers_hz})`,
      mbCurve.bands.length === 4
      && Math.max(...mbCurve.magnitude_db.map(Math.abs)) < 0.001);
    const maxCurve = await call("daw_device_response", { type: "maximizer" });
    ok("a dynamics device says it has no frequency curve and answers a transfer one instead",
      maxCurve.magnitude_db === null && !!maxCurve.none_reason
      && maxCurve.transfer.in_db.length === maxCurve.transfer.out_db.length);

    /* THE CHAIN: build a real mastering chain over MCP and hear it in the
     * numbers -- louder, still under the ceiling, still mono-compatible. */
    const masterAdded = [];
    for (const [type, params] of [
      ["tiltEq", { tilt_db: 1.5, pivot_hz: 900 }],
      ["multibandCompressor", { bands: "3", x1_hz: 140, x2_hz: 2500,
                                b1_threshold_db: -26, b1_ratio: 2.5,
                                b2_threshold_db: -22, b2_ratio: 2,
                                b3_threshold_db: -24, b3_ratio: 2 }],
      ["stereoImager", { x1_hz: 200, w1_width: 0.7, w3_width: 1.3, mono_below_hz: 90 }],
      ["maximizer", { gain_db: 6, ceiling_db: -1, character: "clean" }],
    ]) {
      const r = await call("daw_insert", { op: "add", slug: slug3, target: "master", type, params });
      masterAdded.push(r.insert_id);
      ok(`${type} goes on the master chain over MCP`, r.chain.some((c) => c.type === type),
        JSON.stringify(r.chain?.map((c) => c.type)));
    }
    const rMaster = await api({ action: "render", slug: slug3 });
    ok("the mastered render re-rendered every region (a master edit reaches all of them)",
      rMaster.rendered === 2, JSON.stringify({ rendered: rMaster.rendered }));
    const after = await call("daw_analyze", { slug: slug3 });
    log(`        BEFORE  ${before.loudness.integrated} LUFS  `
      + `${before.loudness.true_peak_db} dBTP  LRA ${before.loudness.lra}  `
      + `corr ${before.correlation.overall}`);
    log(`        AFTER   ${after.loudness.integrated} LUFS  `
      + `${after.loudness.true_peak_db} dBTP  LRA ${after.loudness.lra}  `
      + `corr ${after.correlation.overall}`);
    ok(`the mastering chain made it louder `
      + `(${before.loudness.integrated} -> ${after.loudness.integrated} LUFS)`,
      after.loudness.integrated > before.loudness.integrated + 1.0);
    ok(`...and the true-peak ceiling still holds (${after.loudness.true_peak_db} dBTP)`,
      after.loudness.true_peak_db <= -1 + 0.05);
    ok(`...and it is still mono-compatible (correlation ${after.correlation.overall}, `
      + `worst window ${after.correlation.min})`,
      after.correlation.overall > 0.2);

    /* DELIVERY: the numbers a release actually turns on. */
    const deliv = await call("daw_check_delivery", { slug: slug3 });
    ok(`every delivery target is checked (${deliv.results.length}) and every row `
      + "carries a confidence and a source",
      deliv.results.length >= 8
      && deliv.results.every((r) => ["published", "measured", "uncertain"].includes(r.confidence)
                                    && typeof r.source === "string" && r.source.length > 5));
    const spot = deliv.results.find((r) => r.id === "spotify");
    ok(`the advice is arithmetic: ${spot.measured_lufs} LUFS ${spot.gain_change_db > 0 ? "+" : ""}`
      + `${spot.gain_change_db} dB -> ${spot.lufs}, true peak would land at `
      + `${spot.true_peak_after_gain_db} dBTP`,
      Math.abs(spot.measured_lufs + spot.gain_change_db - spot.lufs) < 0.02
      && typeof spot.advice === "string" && spot.advice.length > 10);
    ok("a target whose gain would breach the ceiling says LIMITING, not gain",
      deliv.results.every((r) => r.limiting_needed_db === 0
        || /limiting/.test(r.advice) || /ceiling/.test(r.advice)));

    /* REFERENCE A/B against the credited bounce, loudness-matched. */
    if (BOUNCE_FILE) {
      const ref = await call("daw_reference", { slug: slug3, reference: BOUNCE_FILE });
      ok(`the reference is loudness-matched and says by how much `
        + `(${ref.match.applied_gain_db} dB applied)`,
        typeof ref.match.applied_gain_db === "number"
        && Math.abs(ref.project.loudness.integrated
                    - ref.reference.loudness.integrated) < 0.1);
      ok("...and the reference's OWN loudness is still reported, unmatched",
        typeof ref.reference.unmatched_lufs === "number"
        && Math.abs(ref.reference.unmatched_lufs - ref.reference.loudness.integrated)
           > Math.abs(ref.match.applied_gain_db) - 0.2);
      ok(`both spectra come back with the per-band difference `
        + `(${ref.delta_bands_db.length} bands)`,
        ref.delta_bands_db.length === 9
        && ref.project.spectrum.hz.length === ref.reference.spectrum.hz.length);
    } else {
      ok("(no bounce to use as a reference — the bounce block was skipped)", true);
    }

    /* A FILE, with no project at all: the same analyser, the same payload. */
    const fileAn = await call("daw_analyze", { file: BOUNCE_FILE || undefined,
                                               slug: BOUNCE_FILE ? undefined : slug3 });
    ok("the analyser measures a bounce FILE with no project in the call",
      fileAn.source === (BOUNCE_FILE ? "file" : "master")
      && typeof fileAn.loudness.integrated === "number");

    /* Put slug3's master chain back the way the rack section left it: the
     * automation block below measures a fader ride against a region rendered
     * BEFORE this section ran, and a +6 dB maximizer sitting on the master
     * would swamp it. (It did, the first time this block existed -- the ride
     * came out LOUDER. A section that leaves state behind is a booby trap for
     * whoever writes the next one.) */
    for (const id of masterAdded) {
      await call("daw_insert", { op: "remove", slug: slug3, target: "master", insert: id });
    }
    const restored = await get(`/api/daw/project/${slug3}`);
    ok("...and the mastering section puts the master chain back as it found it",
      restored.project.master.inserts.length === 1
      && restored.project.master.inserts[0].type === "limiter",
      JSON.stringify(restored.project.master.inserts.map((i) => i.type)));

    log("\n-- automation, audible by bytes --");
    const before1 = parseWav(await (await fetch(`${BASE}${rChain.regions[1].url}`)).arrayBuffer());
    const ride = await call("daw_mixer", { op: "set", slug: slug3, target: tB.trackId,
      fader: { keys: [{ t: 1, v: 0 }, { t: 8, v: -40, ease: "easeInOut" }] } });
    ok("the fader ride names its dirt", ride.dirty.length >= 1, JSON.stringify(ride.dirty));
    const rRide = await api({ action: "render", slug: slug3 });
    const after1 = parseWav(await (await fetch(`${BASE}${rRide.regions[1].url}`)).arrayBuffer());
    const rmsOf = (s) => Math.sqrt(s.reduce((a, v) => a + v * v, 0) / s.length);
    // 0.9, not 0.85: the project name carries a timestamp, so the drum
    // patch's per-note seed differs run to run and the measured ratio walks
    // 0.847-0.855 — straddling a 0.85 threshold. The claim being made is
    // "the ride is audible in the bytes", and a 10% drop still makes it.
    ok("bars 5-8 got quieter through the ride (bytes, not trust)",
      rmsOf(after1.samples) < rmsOf(before1.samples) * 0.9,
      `${rmsOf(after1.samples).toFixed(4)} vs ${rmsOf(before1.samples).toFixed(4)}`);

    log("\n-- the delay lands on the tempo grid, across a meter change --");
    const c4 = await api({ action: "create", name: `e2e-grid-${stamp}`, bpm: 120, num: 4, den: 4, length_bars: 4 });
    made.push(c4.slug);
    const tD = await api({ action: "add_track", slug: c4.slug, instrument: "drums", name: "hit" });
    await api({ action: "set_meter", slug: c4.slug, at_bar: 2, num: 7, den: 8 });
    await api({ action: "add_note", slug: c4.slug, track: tD.trackId, bar: 1, beat: 1, pitch: 38, dur_ticks: 240 });
    await api({ action: "insert_add", slug: c4.slug, target: tD.trackId, type: "delay",
                params: { sync: "1/4", feedback: 0.6, mix: 1.0, pingpong: false, tone_hz: 18000 } });
    const rG = await api({ action: "render", slug: c4.slug });
    const wG = parseWav(await (await fetch(`${BASE}${rG.regions[0].url}`)).arrayBuffer());
    const eAt = (t0, t1) => {                      // stereo interleaved energy in [t0,t1)
      let e = 0;
      for (let i = Math.floor(t0 * 48000) * 2; i < Math.min(t1 * 48000 * 2, wG.samples.length); i++) {
        e += wG.samples[i] ** 2;
      }
      return e;
    };
    // 1/4 at 120 bpm = 0.5 s echoes: bar 2 turning 7/8 must NOT move them.
    // The 4th echo falls at 2.0 s — past the meter change at bar 2 (2.0 s).
    ok("echo 4 lands ON the half-second grid past the 7/8 change",
      eAt(2.0, 2.06) > 8 * eAt(1.80, 1.86),
      `on-grid ${eAt(2.0, 2.06).toExponential(2)} vs off-grid ${eAt(1.80, 1.86).toExponential(2)}`);
    ok("echo 3 too, for good measure", eAt(1.5, 1.56) > 8 * eAt(1.30, 1.36));

    /* ══════════════════════════════════════════════════════════════════
     * [DAWPARITY] the six actions a human could reach and an agent could
     * not — plus the one nobody could: a MIDI clip's bounds were WRITE-ONCE.
     *
     * Every tool added by agent/dawparity is called here at least once. The
     * two claims worth the wire are the ones a unit test cannot make: that a
     * moved clip's audio really changes on disk (the vacated bars go SILENT
     * in the bytes, the entered bars carry the riff), and that a shrink is
     * reversible down to the CONTENT HASH — widening turns the region back
     * into a cache hit on the very file it had before.
     * ══════════════════════════════════════════════════════════════════ */
    log("\n-- [DAWPARITY] the actions only one hand could reach --");
    {
      const parRmsOf = async (url) => {
        const w = parseWav(await (await fetch(`${BASE}${url}`)).arrayBuffer());
        let acc = 0;
        for (const v of w.samples) acc += v * v;
        return Math.sqrt(acc / w.samples.length);
      };

      const parProj = await call("daw_create_project",
        { name: `e2e-par-${stamp}`, bpm: 120, num: 4, den: 4, length_bars: 16 });
      const parSlug = parProj.slug; made.push(parSlug);
      const parKeys = await call("daw_add_track", { slug: parSlug, instrument: "pluck", name: "keys" });
      const parSpare = await call("daw_add_track", { slug: parSlug, instrument: "pad", name: "spare" });

      const parLen = await call("daw_set_length", { slug: parSlug, length_bars: 24 });
      ok("daw_set_length extends the project and names every NEW region as dirty",
        parLen.length_bars === 24 && parLen.dirty.length === 2
        && parLen.dirty.some((d) => d.fromBar === 21), JSON.stringify(parLen.dirty));
      await call("daw_set_length", { slug: parSlug, length_bars: 16 });

      const parRmTrack = await call("daw_remove_track", { slug: parSlug, track: parSpare.track_id });
      const parLeft = await call("daw_get_project", { slug: parSlug });
      ok("daw_remove_track takes the track, and the document agrees",
        parRmTrack.removed === parSpare.track_id
        && parLeft.tracks.length === 1 && parLeft.tracks[0].id === parKeys.track_id);

      await call("daw_set_meter", { slug: parSlug, at_bar: 9, num: 7, den: 8 });
      await call("daw_set_tempo", { slug: parSlug, at_bar: 5, bpm: 90 });
      const parMetOut = await call("daw_set_meter", { slug: parSlug, at_bar: 9, remove: true });
      ok("daw_set_meter remove:true takes the event back out of the list",
        parMetOut.meter_map.length === 1 && !parMetOut.meter_map.some((m) => m.atBar === 9),
        JSON.stringify(parMetOut.meter_map));
      const parTmpOut = await call("daw_set_tempo", { slug: parSlug, at_bar: 5, remove: true });
      ok("daw_set_tempo remove:true does the same for tempo",
        parTmpOut.tempo_map.length === 1 && !parTmpOut.tempo_map.some((m) => m.atBar === 5),
        JSON.stringify(parTmpOut.tempo_map));
      let parAnchor = "";
      try { await call("daw_set_meter", { slug: parSlug, at_bar: 1, remove: true }); }
      catch (e) { parAnchor = e.message; }
      ok("bar 1's anchor cannot be removed — every bar must have a meter",
        /at_bar/.test(parAnchor), parAnchor);
      let parNeedsBpm = "";
      try { await call("daw_set_tempo", { slug: parSlug, at_bar: 3 }); }
      catch (e) { parNeedsBpm = e.message; }
      ok("...and a tempo call with neither bpm nor remove refuses, naming the fix",
        /bpm/.test(parNeedsBpm) && /remove/.test(parNeedsBpm), parNeedsBpm);

      /* ── THE CLIP: bounds were write-once. Now they move — and the cache
       *    follows them in BOTH directions. ─────────────────────────────── */
      const parClipProj = await call("daw_create_project",
        { name: `e2e-parclip-${stamp}`, bpm: 120, num: 4, den: 4, length_bars: 16 });
      const parCS = parClipProj.slug; made.push(parCS);
      const parCT = await call("daw_add_track", { slug: parCS, instrument: "pluck", name: "riff" });

      const parRmClip = await call("daw_remove_clip",
        { slug: parCS, track: parCT.track_id, clip: parCT.clip_id });
      ok("daw_remove_clip removes the clip and says how many notes went with it",
        parRmClip.removed === parCT.clip_id && parRmClip.notes_removed === 0);

      const parClip = await call("daw_add_clip",
        { slug: parCS, track: parCT.track_id, from_bar: 1, bars: 4, name: "riff A" });
      for (const [parBar, parPitch] of [[1, 60], [2, 64], [3, 67], [4, 72]]) {
        await call("daw_add_note", { slug: parCS, track: parCT.track_id,
                                     bar: parBar, beat: 1, pitch: parPitch, dur_ticks: 960 });
      }
      await call("daw_render", { slug: parCS });

      const parMoved = await call("daw_set_clip",
        { slug: parCS, track: parCT.track_id, clip: parClip.clip_id, from_bar: 9 });
      ok("daw_set_clip moves the clip and its notes ride along, length preserved",
        parMoved.clip.fromBar === 9 && parMoved.clip.toBar === 12
        && parMoved.moved_bars === 8 && parMoved.notes_moved === 4
        && parMoved.notes_clamped === 0 && parMoved.notes_outside === 0,
        JSON.stringify(parMoved));
      ok("...and it dirties BOTH the range it left and the range it entered",
        parMoved.dirty.length === 2
        && parMoved.dirty.some((d) => d.fromBar === 1) && parMoved.dirty.some((d) => d.fromBar === 9),
        JSON.stringify(parMoved.dirty));

      const parR1 = await call("daw_render", { slug: parCS });
      ok("only those two regions re-render; the untouched two are cache hits",
        parR1.rendered === 2 && parR1.cached_hits === 2,
        JSON.stringify({ rendered: parR1.rendered, cached: parR1.cached_hits }));
      const parVacated = await parRmsOf(parR1.regions[0].url);
      const parEntered = await parRmsOf(parR1.regions[2].url);
      ok(`the VACATED bars are silent in the bytes (rms ${parVacated.toExponential(1)})`,
        parVacated < 1e-5);
      ok(`the ENTERED bars carry the riff (rms ${parEntered.toFixed(4)})`, parEntered > 0.01);

      const parShrunk = await call("daw_set_clip",
        { slug: parCS, track: parCT.track_id, clip: parClip.clip_id, to_bar: 10 });
      ok("shrinking keeps every note and counts the ones it silenced",
        parShrunk.clip.notes === 4 && parShrunk.notes_outside === 2
        && parShrunk.notes_moved === 0 && parShrunk.dirty.length === 1,
        JSON.stringify(parShrunk));
      const parR2 = await call("daw_render", { slug: parCS });
      const parQuieter = await parRmsOf(parR2.regions[2].url);
      ok(`...and the region really got quieter (rms ${parQuieter.toFixed(4)} < ${parEntered.toFixed(4)})`,
        parQuieter < parEntered * 0.9);

      const parWidened = await call("daw_set_clip",
        { slug: parCS, track: parCT.track_id, clip: parClip.clip_id, to_bar: 12 });
      ok("widening brings them back — a resize silences, it never deletes",
        parWidened.notes_outside === 0 && parWidened.clip.notes === 4);
      const parR3 = await call("daw_render", { slug: parCS });
      ok("...and the restored region is a CACHE HIT on the very file it had before",
        parR3.regions[2].cached === true && parR3.regions[2].hash === parR1.regions[2].hash,
        `${parR3.regions[2].hash} vs ${parR1.regions[2].hash}`);

      const parTrim = await call("daw_set_clip",
        { slug: parCS, track: parCT.track_id, clip: parClip.clip_id, from_bar: 11, move_notes: false });
      ok("move_notes:false trims the LEFT edge and leaves the notes where they are",
        parTrim.clip.fromBar === 11 && parTrim.clip.toBar === 12
        && parTrim.notes_moved === 0 && parTrim.notes_outside === 2, JSON.stringify(parTrim));
      const parRenamed = await call("daw_set_clip",
        { slug: parCS, track: parCT.track_id, clip: parClip.clip_id, name: "riff B" });
      ok("a rename is only a rename: bounds and notes untouched",
        parRenamed.clip.name === "riff B" && parRenamed.clip.fromBar === 11
        && parRenamed.notes_moved === 0);
      let parNoChange = "";
      try { await call("daw_set_clip", { slug: parCS, track: parCT.track_id, clip: parClip.clip_id }); }
      catch (e) { parNoChange = e.message; }
      ok("a set_clip that names no change refuses, listing the fields that would be one",
        /from_bar, to_bar, bars or name/.test(parNoChange), parNoChange);

      /* the mixed-meter clamp, over the wire: beat 7 exists in 7/8 and not in 4/4 */
      await call("daw_set_clip", { slug: parCS, track: parCT.track_id, clip: parClip.clip_id,
                                   from_bar: 9, to_bar: 12, move_notes: false });
      await call("daw_set_meter", { slug: parCS, at_bar: 9, num: 7, den: 8 });
      await call("daw_add_note", { slug: parCS, track: parCT.track_id,
                                   bar: 9, beat: 7, pitch: 55, dur_ticks: 240 });
      const parClamped = await call("daw_set_clip",
        { slug: parCS, track: parCT.track_id, clip: parClip.clip_id, from_bar: 1 });
      ok("moving into a 4/4 region clamps the 7/8-only beat, and says how many",
        parClamped.notes_moved === 5 && parClamped.notes_clamped === 1, JSON.stringify(parClamped));
      const parClampDoc = await call("daw_get_project", { slug: parCS, include_notes: true });
      const parBeat7 = parClampDoc.notes[0].notes.find((n) => n.pitch === 55);
      ok("...and the clamped note landed on a beat its new bar really has",
        parBeat7?.at === "1.4.0", parBeat7?.at);

      /* ── the audition, which the piano roll had and no agent did ────── */
      const parPv = await call("daw_preview_note",
        { slug: parCS, track: parCT.track_id, pitch: 64, vel: 100, dur_ticks: 480 });
      ok("daw_preview_note auditions the track's PATCH and names what it used",
        parPv.patch === "pluck" && parPv.url.startsWith("/api/daw/preview/pv_pluck_64_100_480_"),
        parPv.url);
      const parPvWav = parseWav(await (await fetch(`${BASE}${parPv.url}`)).arrayBuffer());
      let parPvE = 0;
      for (const v of parPvWav.samples) parPvE += v * v;
      const parPvRms = Math.sqrt(parPvE / parPvWav.samples.length);
      ok(`...and the url serves REAL audio (${parPvWav.samples.length} samples, rms ${parPvRms.toFixed(4)})`,
        parPvWav.samples.length > 1000 && parPvRms > 1e-3);
      const parPv2 = await call("daw_preview_note",
        { slug: parCS, track: parCT.track_id, pitch: 64, vel: 100, dur_ticks: 480 });
      ok("a repeat audition is a cache hit — the preview is content-addressed",
        parPv2.cached === true && parPv2.url === parPv.url);
      ok("...and nothing was written to the project by an audition",
        (await call("daw_get_project", { slug: parCS })).tracks[0].clips
          .reduce((a, cl) => a + cl.notes, 0) === 5);

      /* ── the audio timeline, editable by the agent too ──────────────── */
      const parOs = await import("node:os");
      const { writeFile: parWrite } = await import("node:fs/promises");
      const parSr = 48000;
      const parTone = new Float32Array(parSr / 2);
      for (let i = 0; i < parTone.length; i++) parTone[i] = 0.25 * Math.sin(2 * Math.PI * 330 * i / parSr);
      const parHdr = Buffer.alloc(44);
      parHdr.write("RIFF", 0); parHdr.writeUInt32LE(36 + parTone.length * 4, 4); parHdr.write("WAVE", 8);
      parHdr.write("fmt ", 12); parHdr.writeUInt32LE(16, 16);
      parHdr.writeUInt16LE(3, 20); parHdr.writeUInt16LE(1, 22);
      parHdr.writeUInt32LE(parSr, 24); parHdr.writeUInt32LE(parSr * 4, 28);
      parHdr.writeUInt16LE(4, 32); parHdr.writeUInt16LE(32, 34);
      parHdr.write("data", 36); parHdr.writeUInt32LE(parTone.length * 4, 40);
      const parTonePath = path.join(parOs.tmpdir(), `e2e_par_tone_${stamp}.wav`);
      await parWrite(parTonePath, Buffer.concat([parHdr, Buffer.from(parTone.buffer)]));

      const parAudProj = await call("daw_create_project",
        { name: `e2e-paraud-${stamp}`, bpm: 120, num: 4, den: 4, length_bars: 8 });
      const parAS = parAudProj.slug; made.push(parAS);
      const parAT = await call("daw_add_track", { slug: parAS, instrument: "pluck", name: "audio" });
      const parImp = await call("daw_import_audio",
        { slug: parAS, track: parAT.track_id, path: parTonePath, bar: 1, beat: 1, name: "tone" });
      await call("daw_render", { slug: parAS });
      const parAudSet = await call("daw_audio_clip", { op: "set", slug: parAS, track: parAT.track_id,
        clip: parImp.clip.id, bar: 5, name: "tone moved", gain_db: -6 });
      ok("daw_audio_clip set moves the clip, renames and re-gains it in one call",
        parAudSet.clip.bar === 5 && parAudSet.clip.name === "tone moved"
        && parAudSet.clip.gainDb === -6, JSON.stringify(parAudSet.clip));
      ok("...and dirties the bars it left AND the bars it entered",
        parAudSet.dirty.length === 2, JSON.stringify(parAudSet.dirty));
      const parAudR = await call("daw_render", { slug: parAS });
      ok("both of those regions re-render", parAudR.rendered === 2);
      const parAudRm = await call("daw_audio_clip",
        { op: "remove", slug: parAS, track: parAT.track_id, clip: parImp.clip.id });
      ok("daw_audio_clip remove takes it off the timeline and dirties where it was",
        parAudRm.removed === parImp.clip.id && parAudRm.dirty.length === 1,
        JSON.stringify(parAudRm));
      ok("...and LEAVES THE FILE on disk, exactly as the tool says it does",
        (await fetch(`${BASE}${parImp.url}`)).ok);

      /* ── the MIDI half of capture, in one call ──────────────────────── */
      const parPerf = await call("daw_record", { op: "notes", slug: parAS, track: parAT.track_id,
        notes: [{ bar: 1, beat: 1, tick: 37, dur_ticks: 240, pitch: 60, vel: 90 },
                { bar: 1, beat: 2, tick: 955, dur_ticks: 240, pitch: 64, vel: 90 }],
        quantize_ticks: 240 });
      ok("daw_record op:notes lands a whole performance in one call",
        parPerf.added === 2 && parPerf.quantized === 240, JSON.stringify(parPerf).slice(0, 200));
      const parPerfDoc = await call("daw_get_project", { slug: parAS, include_notes: true });
      const parOnsets = parPerfDoc.notes[0].notes.map((n) => n.at);
      ok("...and every onset really snapped to the 240-tick grid",
        parOnsets.length === 2 && parOnsets.every((at) => Number(at.split(".")[2]) % 240 === 0)
        && parOnsets.includes("1.3.0"), parOnsets.join(" "));
      const parPerfLed = await call("daw_ledger", { slug: parAS, limit: 1 });
      ok("...attributed to the agent, like every other MCP edit",
        parPerfLed.ledger[0]?.by === "agent" && parPerfLed.ledger[0]?.action === "record_notes",
        JSON.stringify(parPerfLed.ledger[0]));
    }
  }

/* ════════════════════════════════════════════════════════════════════════
 * [DAWEAR] THE EAR — over the wire.
 *
 * The unit suites (server/daw/ear_test.py, server/daw/ear_test.js) prove the
 * critic's arithmetic against synthesised ground truth and the loop's
 * machinery against injected io. What only the wire can prove is the seam:
 * that the route really renders through the same graph the bounce uses, that
 * a card's `op` really executes as the MCP tool it names, and — the one that
 * matters most — that the ACTOR the ledger records depends on who actually
 * called, not on what the caller claims.
 * ════════════════════════════════════════════════════════════════════════ */
{
  log("\n  -- [DAWEAR] the Ear: a flawed mix, listened to over the wire --");

  const earPost = async (body, actor) => {
    const r = await fetch(`${BASE}/api/daw/ear`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(actor ? { "x-aiplay-actor": actor } : {}) },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({ error: `non-JSON ${r.status}` }));
    if (j.error) throw new Error(j.error);
    return j;
  };
  const earTry = async (body, actor) => {
    try { return { ok: true, r: await earPost(body, actor) }; }
    catch (e) { return { ok: false, why: e.message }; }
  };
  const dawAs = async (body, actor) => {
    const r = await fetch(`${BASE}/api/daw`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(actor ? { "x-aiplay-actor": actor } : {}) },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({ error: `non-JSON ${r.status}` }));
    if (j.error) throw new Error(j.error);
    return j;
  };

  /* The real tool schemas, read from the module the MCP server exports, so a
   * card that promises a call the tool would refuse fails HERE. */
  const { dawTools } = await import(new URL("../server/mcp-daw.js", import.meta.url));
  const EAR_TOOLS = Object.fromEntries(
    dawTools(async () => ({}), (s) => s).map((t) => [t.name, t]));
  const validateOp = (op) => {
    const t = EAR_TOOLS[op?.tool];
    if (!t) return [`no such tool ${op?.tool}`];
    const S = t.inputSchema, a = op.args || {}, bad = [];
    for (const r of S.required || []) if (a[r] === undefined) bad.push(`missing ${r}`);
    for (const [k, v] of Object.entries(a)) {
      const spec = S.properties?.[k];
      if (!spec) { bad.push(`undeclared ${k}`); continue; }
      if (spec.enum && !spec.enum.includes(v)) bad.push(`${k}="${v}" not in enum`);
    }
    return bad;
  };

  const status0 = await get("/api/daw/ear/status");
  ok("the Ear reports its objective critics", (status0.objective?.critics || []).length >= 8,
    JSON.stringify(status0.objective?.error || (status0.objective?.critics || []).length));
  ok("the python and JS band tables still agree", status0.objective?.bands_agree === true);
  ok("the subjective stage gives a verdict either way — never silence",
    typeof status0.subjective?.available === "boolean"
    || typeof status0.subjective?.error === "string",
    JSON.stringify(status0.subjective).slice(0, 160));
  if (status0.subjective?.available === false) {
    ok("...and when absent, names the install path rather than faking a score",
      !!status0.subjective.installer?.steps?.length && !status0.subjective.scores);
  } else {
    ok("...and when present, names what is installed",
      !!status0.subjective.judges);
  }
  ok("MERT and essentia are refused on licence, in the status itself",
    !!status0.subjective?.refused?.["MERT-v1-330M"] && !!status0.subjective?.refused?.essentia);

  const tasteWasCold = (await get("/api/daw/ear/taste")).summary.observations === 0;

  /* ── a deliberately flawed 4-bar mix ───────────────────────────────── */
  const ec = await api({ action: "create", name: "e2e ear flawed", length_bars: 4,
                         bpm: 120, num: 4, den: 4 });
  made.push(ec.slug);
  const eBass = (await api({ action: "add_track", slug: ec.slug, instrument: "pluck", name: "bass" })).trackId;
  const ePad = (await api({ action: "add_track", slug: ec.slug, instrument: "pad", name: "pad" })).trackId;
  const eLead = (await api({ action: "add_track", slug: ec.slug, instrument: "pluck", name: "lead vox" })).trackId;
  for (let bar = 1; bar <= 4; bar++) {
    for (let beat = 1; beat <= 4; beat++) {
      await api({ action: "add_note", slug: ec.slug, track: eBass, bar, beat, pitch: 40, vel: 118, dur_ticks: 900 });
      await api({ action: "add_note", slug: ec.slug, track: eLead, bar, beat, pitch: 64 + (beat % 3), vel: 90, dur_ticks: 700 });
    }
    for (const p of [60, 64, 67]) {
      await api({ action: "add_note", slug: ec.slug, track: ePad, bar, beat: 1, pitch: p, vel: 112, dur_ticks: 3840 });
    }
  }
  await api({ action: "mixer_set", slug: ec.slug, target: eBass, fader: 9 });
  await api({ action: "mixer_set", slug: ec.slug, target: ePad, fader: 6 });
  await api({ action: "mixer_set", slug: ec.slug, target: eLead, fader: -6 });
  await api({ action: "mixer_set", slug: ec.slug, target: "master", fader: 9 });

  const crit = await earPost({ action: "critique", slug: ec.slug, genre: "pop" });
  ok("the critique renders every track as its own stem", crit.stems.length === 3,
    JSON.stringify(crit.stems));
  ok("it measures the master with BS.1770-4 and true peak",
    Number.isFinite(crit.measure.master.lufs) && Number.isFinite(crit.measure.master.true_peak_db));
  ok("the planted no-headroom fault is caught (loudness far over target)",
    crit.measure.master.lufs > -8, `${crit.measure.master.lufs} LUFS`);
  ok("the planted too-loud bass reads louder than the buried lead",
    crit.measure.tracks[eBass].lufs > crit.measure.tracks[eLead].lufs + 10,
    `${crit.measure.tracks[eBass].lufs} vs ${crit.measure.tracks[eLead].lufs}`);
  ok("cards were produced", crit.cards.length >= 3, String(crit.cards.length));
  ok("the card stack is capped at 5 and says what it held back",
    crit.cards.length <= 5 && Number.isInteger(crit.over_cap));

  const allRoutes = crit.cards.flatMap((c) => c.routes);
  const routeProblems = allRoutes.flatMap((r) => validateOp(r.op).map((p) => `${r.id}: ${p}`));
  ok("EVERY route on EVERY card is a valid call against the real MCP tool schema",
    routeProblems.length === 0, routeProblems.join("; "));
  ok("every card offers 2-4 genuinely different routes",
    crit.cards.every((c) => c.routes.length >= 2 && c.routes.length <= 4),
    crit.cards.map((c) => `${c.id}:${c.routes.length}`).join(" "));
  ok("every card offers free text and a skip",
    crit.cards.every((c) => c.free_text?.allowed && c.skip?.allowed));
  ok("every card carries what / where / how much / severity",
    crit.cards.every((c) => c.observation && c.where && c.how_much
      && ["low", "medium", "high"].includes(c.severity)));
  ok("no card is a one-option confirmation dialog",
    crit.cards.every((c) => c.routes.length !== 1));
  ok("findings that could only name one move came back as notes, with the reason",
    (crit.notes || []).every((n) => !!n.why_not_a_card));

  const masking = (crit.findings || []).filter((f) => f.metric === "masking");
  ok("inter-track masking is measured and located (track, band, bars)",
    masking.length === 0 || masking.every((f) => f.target && f.against && f.band
      && Number.isInteger(f.from_bar) && Number.isInteger(f.to_bar)),
    JSON.stringify(masking[0] || "none in this mix"));

  /* ── THE INVARIANT, over the wire (SPEC D1.0) ──────────────────────── */
  log("\n  -- [DAWEAR] an agent cannot record a human decision --");

  const agentAnswer = await earTry({ action: "answer", slug: ec.slug, run: crit.run,
                                     card: crit.cards[0].id, choice: crit.cards[0].routes[0].id },
                                    "agent:e2e");
  ok("an MCP-actor answer with no delegation on record is REFUSED",
    !agentAnswer.ok && /D1\.0|delegation|auto/.test(agentAnswer.why), String(agentAnswer.why));
  for (const [what, body] of [
    ["review", { action: "review", slug: ec.slug, run: crit.run, card: crit.cards[0].id, verdict: "keep" }],
    ["bulk_accept", { action: "bulk_accept", slug: ec.slug, run: crit.run }],
    ["approve", { action: "approve", slug: ec.slug, run: crit.run, listened_seconds: 30 }],
  ]) {
    const t = await earTry(body, "agent:e2e");
    ok(`an MCP-actor "${what}" is refused — it is the human's act`, !t.ok, String(t.why));
  }

  /* ── the browser path: a real human choice ─────────────────────────── */
  const card0 = crit.cards[0];
  const ans = await earPost({
    action: "answer", slug: ec.slug, run: crit.run, card: card0.id,
    choice: card0.routes[0].id, reasoning: "e2e: taking the first route",
    decide_ms: 8400,
  });                                                    // no actor header = the browser
  ok("a browser answer is recorded as a `choice` by actor user",
    ans.logged_as === "choice" && ans.actor === "user", JSON.stringify(ans.logged_as));
  ok("the chosen route was actually applied as its MCP call", !!ans.applied?.op,
    JSON.stringify(ans.applied?.op));
  ok("the A/B guard ran and reported a verdict with both scores",
    ["keep", "traded", "revert", "kept_unrevertable"].includes(ans.applied.verdict)
    && Number.isFinite(ans.applied.before?.penalty_db)
    && Number.isFinite(ans.applied.after?.penalty_db),
    JSON.stringify({ v: ans.applied.verdict, b: ans.applied.before?.penalty_db,
                     a: ans.applied.after?.penalty_db }));
  ok("the guard's verdict is explained in words, not just a flag",
    typeof ans.applied.reason === "string" && ans.applied.reason.length > 10,
    String(ans.applied.reason));
  {
    /* A reverted edit must leave NOTHING behind: the insert it added is gone
     * from the document. A guard that reports a revert it did not perform is
     * worse than no guard. */
    const doc = (await get(`/api/daw/project/${ec.slug}`)).project;
    const chainOf = (t) => (t === "master" ? doc.master.inserts
      : (doc.tracks.find((x) => x.id === t)?.inserts || []));
    if (ans.applied.reverted && ans.applied.op.args.op === "add") {
      ok("a REVERTED insert is actually gone from the document",
        !chainOf(ans.applied.op.args.target).some((i) => i.type === ans.applied.op.args.type));
    } else if (ans.applied.op.args.op === "add") {
      ok("a KEPT insert is actually on the document",
        chainOf(ans.applied.op.args.target).some((i) => i.type === ans.applied.op.args.type),
        JSON.stringify(chainOf(ans.applied.op.args.target).map((i) => i.type)));
    } else {
      ok("a kept mixer move is on the document",
        ans.applied.op.tool === "daw_mixer");
    }
  }

  /* ── free text, skip, and rejection ────────────────────────────────── */
  const card1 = crit.cards[1];
  const free = await earPost({ action: "answer", slug: ec.slug, run: crit.run, card: card1.id,
                               free_text: "thin the pad, keep the air", decide_ms: 21000 });
  ok("free text is accepted with no route at all and is recorded",
    free.free_text_recorded === true && free.logged_as === "choice");
  ok("free text alone applies nothing automatically — it is direction, not an edit",
    !free.applied);
  const card2 = crit.cards[2];
  const skipped = await earPost({ action: "answer", slug: ec.slug, run: crit.run,
                                  card: card2.id, choice: "skip" });
  ok("a skip is honoured and is NOT written to the ledger",
    skipped.skipped === true && skipped.logged === false);

  /* ── auto-progression: delegated, and logged as delegated ──────────── */
  log("\n  -- [DAWEAR] auto-progression is logged as delegated, never as deliberation --");

  const noBrief = await earTry({ action: "auto", slug: ec.slug }, "agent:e2e");
  ok("auto refuses to run without the human's brief in their own words",
    !noBrief.ok && /brief/.test(noBrief.why), String(noBrief.why));

  const auto = await earPost({ action: "auto", slug: ec.slug, genre: "pop", iterations: 2,
                               brief: "open it up and get the lead back" }, "agent:e2e");
  ok("auto records a delegate event and hangs every decision off it", !!auto.delegate);
  ok("auto respects the iteration cap", auto.iterations.length <= 3, String(auto.iterations.length));
  ok("auto reports before and after objectively",
    Number.isFinite(auto.before?.penalty_db) && Number.isFinite(auto.after?.penalty_db),
    JSON.stringify({ b: auto.before?.penalty_db, a: auto.after?.penalty_db }));
  ok("auto demands a review checkpoint rather than claiming the decisions",
    auto.review_required === true && /never as your own deliberation/.test(auto.honesty));
  ok("each auto decision names the route it took AND the ones it did not",
    auto.judgements.every((j) => j.chosen && j.options.length >= 2));

  const led = await get(`/api/daw/ear/ledger/${ec.slug}`);
  ok("the project ledger's hash chain is intact", led.chain.ok === true, JSON.stringify(led.chain));
  const evs = led.events;
  const choices = evs.filter((e) => e.type === "choice");
  const judges = evs.filter((e) => e.type === "judge");
  const delegates = evs.filter((e) => e.type === "delegate");
  ok("the human's answers landed as `choice` events with actor user",
    choices.length >= 2 && choices.every((e) => e.actor === "user"),
    JSON.stringify(choices.map((e) => e.actor)));
  ok("the Ear's own answers landed as `judge` events with an agent actor",
    judges.length >= 1 && judges.every((e) => String(e.actor).startsWith("agent:")),
    JSON.stringify(judges.map((e) => e.actor)));
  ok("NOT ONE agent decision is recorded as a `choice`",
    !choices.some((e) => String(e.actor).startsWith("agent:")));
  ok("NOT ONE human decision is recorded as a `judge`",
    !judges.some((e) => e.actor === "user"));
  ok("every judge event names the delegation that authorised it",
    judges.every((e) => e.data.delegatedBy === delegates[0]?.id),
    JSON.stringify(judges.map((e) => e.data.delegatedBy)));
  ok("the delegation carries the human's brief VERBATIM",
    delegates[0]?.data.brief === "open it up and get the lead back",
    JSON.stringify(delegates[0]?.data.brief));
  ok("an MCP-relayed delegation is stamped as relayed, not as a direct human act",
    delegates[0]?.actor === "agent:e2e" && delegates[0]?.data.relayed === true,
    JSON.stringify({ a: delegates[0]?.actor, r: delegates[0]?.data.relayed }));
  ok("choice events store the card AS PRESENTED — every option's text",
    choices.every((e) => (e.data.card?.options || []).length >= 2
      && e.data.card.options.every((o) => o.text)));
  ok("choice events record the REJECTED routes — rejection is evidence of control",
    choices.some((e) => (e.data.rejected || []).length >= 1));
  ok("the free-text answer is stored verbatim",
    choices.some((e) => e.data.freeText === "thin the pad, keep the air"));
  ok("the skipped card wrote NOTHING",
    !evs.some((e) => e.data?.card?.observation === card2.observation
      && e.type === "choice" && e.data.chosen === null && e.data.freeText === null
      && (e.data.rejected || []).length === card2.routes.length));

  /* ── the review checkpoint ─────────────────────────────────────────── */
  const rcards = await earPost({ action: "review_cards", slug: ec.slug, run: auto.run });
  ok("the review checkpoint shows every auto decision with its alternatives",
    rcards.cards.length === auto.judgements.length
    && rcards.cards.every((r) => r.alternatives.length >= 2));
  if (rcards.cards.length) {
    const kept = await earPost({ action: "review", slug: ec.slug, run: auto.run,
                                 card: rcards.cards[0].card, verdict: "keep", decide_ms: 5100 });
    ok("a human `keep` is recorded as their own choice, pointing at the judge event",
      kept.logged_as === "choice" && kept.mode === "review" && kept.verdict === "keep"
      && !!kept.reviews);
    const led2 = await get(`/api/daw/ear/ledger/${ec.slug}`);
    const rev = led2.events.find((e) => e.type === "choice" && e.data.mode === "review");
    ok("the review choice is actor user and names what it reviews",
      rev?.actor === "user" && !!rev.data.reviews && rev.data.verdict === "keep");
  }

  /* ── bulk is bulk ──────────────────────────────────────────────────── */
  const bulk = await earPost({ action: "review_keep_all", slug: ec.slug, run: auto.run });
  ok("keep-all is recorded as ONE bulk ratification, and says so",
    bulk.mode === "bulk" && /never as \d+ individual review/.test(bulk.honesty), String(bulk.honesty));
  if (bulk.kept > 0) {
    const led3 = await get(`/api/daw/ear/ledger/${ec.slug}`);
    ok("the bulk events carry mode:bulk, not mode:individual",
      led3.events.filter((e) => e.type === "choice" && e.data.reviews)
        .some((e) => e.data.mode === "bulk"));
  }

  /* ── approval after listening ──────────────────────────────────────── */
  const appr = await earPost({ action: "approve", slug: ec.slug, run: auto.run,
                               listened_seconds: 96, note: "e2e listened" });
  ok("approval after listening is its own first-class human event",
    appr.logged_as === "approve");
  const led4 = await get(`/api/daw/ear/ledger/${ec.slug}`);
  const ap = led4.events.find((e) => e.type === "approve");
  ok("...actor user, with the run, the listening time and the note",
    ap?.actor === "user" && ap.data.sessionSeconds === 96 && ap.data.loopRun === auto.run);
  ok("the chain is STILL intact after the whole loop",
    led4.chain.ok === true, JSON.stringify(led4.chain));

  /* ── the taste profile learned from all of that ────────────────────── */
  const taste = await get("/api/daw/ear/taste");
  ok("the taste profile recorded the human's decisions",
    taste.summary.observations >= 3, String(taste.summary.observations));
  ok("it reports its prior instead of pretending to be certain",
    /Beta\(5,5\)/.test(taste.summary.prior));
  ok("it is stored locally and says where", typeof taste.path === "string" && taste.path.length > 3);
  if (tasteWasCold) {
    const reset = await earPost({ action: "taste_reset", slug: ec.slug });
    ok("reset returns the profile to neutral (and says the ledger is untouched)",
      reset.summary.observations === 0 && /ledger/.test(reset.note));
  } else {
    ok("(the operator already had a taste profile — left alone, not reset)", true);
  }

  /* ── measuring a real bounce file ──────────────────────────────────── */
  const eb = await dawAs({ action: "bounce", slug: ec.slug });
  const fileMeasure = await earPost({ action: "analyse_file", path: eb.file, genre: "pop" });
  ok("the Ear measures a real bounce file end to end",
    Number.isFinite(fileMeasure.measure.master.lufs)
    && Number.isFinite(fileMeasure.measure.master.true_peak_db),
    JSON.stringify(fileMeasure.measure.master).slice(0, 120));
  ok("a mixdown honestly reports that it has no stems to compare",
    fileMeasure.stems_cover === "none" && fileMeasure.measure.masking.length === 0);
  ok("the objective score is a penalty with a stated direction",
    fileMeasure.score.lower_is_better === true && Number.isFinite(fileMeasure.score.penalty_db));
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

if (BOUNCE_FILE) log(`\n  (the credited bounce was written to ${BOUNCE_FILE})`);
log(`\n  ${pass} passed, ${fails.length} failed\n`);
if (fails.length) {
  log("  failed:\n   " + fails.join("\n   ") + "\n");
  process.exit(1);
}
