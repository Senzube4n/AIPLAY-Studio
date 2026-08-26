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
    ok(`the daw_ family is served (${dawNames.length} tools)`, dawNames.length === 14, dawNames.join(", "));

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
