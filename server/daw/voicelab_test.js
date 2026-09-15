/**
 * THE VOICE LAB, THE STEMS AND THE PEAKS ROUTE — the half that is not python.
 *
 * The assertions this file exists for, in the order they would have caught a
 * bug that shipped:
 *
 *  ONE DOOR       voice_lab with no override renders into the SAME file
 *                 `preview_note` renders into: the same name from the same
 *                 recipe, and the same bytes when both are forced to render.
 *                 Two audition paths that could drift apart is the failure
 *                 this pins shut.
 *  NO WRITE       an override renders a DIFFERENT sound and moves nothing in
 *                 the document — not updatedAt, not the ledger. That is the
 *                 whole difference between "try it" and "17 undo entries".
 *  THE DEFAULT    a knob set to its own declared default hashes as untouched,
 *                 because store.normParams drops it. Without that, opening
 *                 the panel would re-key every preview in the cache.
 *  SAME HASH      a stem's filename carries the region's OWN hash, so it is
 *                 invalidated by exactly the edits that invalidate the region
 *                 and by no others.
 *  THE CEILING    a job too long for the short-job lane is refused AT THE
 *                 ROUTE, with the ceiling named.
 *  NO PATHS       a peaks request can only name a content-addressed render.
 *
 * The disk half needs the rig's python (numpy) and skips itself LOUDLY
 * without it. Everything above that line runs anywhere.
 *
 * Run:  node server/daw/voicelab_test.js
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, rm, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

/* The output dir MUST be decided before config.js is first imported, and
 * static imports hoist — so everything below is a dynamic import. */
const OUT = path.join(os.tmpdir(), `daw-voicelab-test-${process.pid}-${Date.now().toString(36)}`);
process.env.AIPLAY_OUTPUT = OUT;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const vl = await import("./voicelab.js");
const store = await import("./store.js");
const mixer = await import("./mixer.js");
const { config } = await import("../config.js");

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const sha = (buf) => createHash("sha1").update(buf).digest("hex");
/** [DAWREC] A float32 mono wav, byte for byte what engine.write_wav_f32
 *  writes — so the import seam is fed the format it is documented to read. */
function wavF32(samples, sr) {
  const data = Buffer.alloc(samples.length * 4);
  samples.forEach((v, i) => data.writeFloatLE(v, i * 4));
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16);
  head.writeUInt16LE(3, 20); head.writeUInt16LE(1, 22);        // IEEE float, mono
  head.writeUInt32LE(sr, 24); head.writeUInt32LE(sr * 4, 28);
  head.writeUInt16LE(4, 32); head.writeUInt16LE(32, 34);
  head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

console.log("\n  -- the mount: one plain function, the handleMixerAction contract --");

ok("voicelab.js exports handleVoiceLabAction", typeof vl.handleVoiceLabAction === "function");
ok("...taking (action, body, ctx), like handleMixerAction", vl.handleVoiceLabAction.length === 3);
ok("it declares the three actions it dispatches",
  JSON.stringify(vl.VOICELAB_ACTIONS) === JSON.stringify(["voice_lab", "render_stems", "peaks"]));
ok("an action it does not own comes back as null, never as a throw",
  await vl.handleVoiceLabAction("add_note", {}, {}) === null);

{
  /* THE PARITY CENSUS, one level up: a name this module claims must not be a
   * name routes.js or mixer.js already dispatches, or the census's action
   * scrape becomes ambiguous — the same trap `move_notes` would have been. */
  const routes = readFileSync(path.join(HERE, "routes.js"), "utf8");
  const mixer = readFileSync(path.join(HERE, "mixer.js"), "utf8");
  const taken = new Set([
    ...[...routes.matchAll(/^\s*case "([a-z0-9_]+)": \{/gm)].map((m) => m[1]),
    ...[...mixer.matchAll(/^\s*case "([a-z0-9_]+)": \{/gm)].map((m) => m[1]),
  ]);
  const clash = vl.VOICELAB_ACTIONS.filter((a) => taken.has(a));
  ok("no action name collides with one routes.js or mixer.js already dispatches",
    clash.length === 0, `collides: ${clash.join(", ")}`);
}

console.log("\n  -- the names: a stem is named for its region, and nothing else is --");

ok("stemName builds reg<idx>_<hash>_trk_<tid>.wav",
  vl.stemName(7, "1a2b3c4d5e6f", "trk_d688") === "reg7_1a2b3c4d5e6f_trk_trk_d688.wav");
ok("isStemName accepts that name", vl.isStemName(vl.stemName(7, "1a2b3c4d5e6f", "trk_d688")));
ok("...and refuses the region file it was made from",
  !vl.isStemName("reg7_1a2b3c4d5e6f.wav"));
ok("...and refuses a name that is not content-addressed",
  !vl.isStemName("reg7_zzz_trk_a.wav") && !vl.isStemName("../secret.wav"));

{
  /* The region cache prunes stale generations with
   *   f.startsWith(`reg${idx}_`) && f !== name
   * which matches a CURRENT stem too. That costs a re-render, never
   * correctness — but the predicate that fixes it ships here. */
  const keep = "reg3_aaaaaaaaaaaa.wav";
  const stale = "reg3_bbbbbbbbbbbb.wav";
  const stem = "reg3_aaaaaaaaaaaa_trk_trk_1.wav";
  ok("isPrunableRegion drops a stale generation of the region",
    vl.isPrunableRegion(stale, 3, keep) === true);
  ok("...keeps the current one", vl.isPrunableRegion(keep, 3, keep) === false);
  ok("...and does NOT sweep away a live stem, which the naive prefix test does",
    vl.isPrunableRegion(stem, 3, keep) === false && stem.startsWith("reg3_"));
  ok("...nor the peaks sidecar of a live stem, nor the region's own",
    vl.isPrunableRegion(`${stem}.pk1`, 3, keep) === false
    && vl.isPrunableRegion(`${keep}.pk1`, 3, keep) === false);
  ok("...but a STALE region's sidecar goes with it",
    vl.isPrunableRegion(`${stale}.pk1`, 3, keep) === true);
}

console.log("\n  -- the ceiling and the refusals are stated, not just enforced --");
ok("the short-job ceiling is a declared constant, in seconds",
  vl.VOICE_CEILING_SECONDS === 10);

/* ── the disk half ────────────────────────────────────────────────────── */
const havePy = existsSync(config.python);
if (!havePy) {
  console.log(`\n  -- SKIPPING the render half: no python at ${config.python}`);
  console.log("     (voice_lab, render_stems and peaks all go through engine.py,");
  console.log("      which needs numpy + scipy; set AIPLAY_RIG or AIPLAY_PY to run it)");
} else if (!store.DAW_DIR().startsWith(OUT)) {
  console.log(`\n  -- refusing to run the disk half anywhere but ${OUT}`);
  failures.push("the scratch dir was not in force");
} else {
  /* One warm serve child for the whole suite — the same one-JSON-line
   * protocol routes.js's lane speaks, cut to what a test needs. */
  const proc = spawn(config.python, [path.join(HERE, "engine.py"), "serve"], { cwd: HERE });
  let buf = "";
  const waiters = new Map();
  let markReady;
  const ready = new Promise((r) => { markReady = r; });
  proc.stdout.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0;) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r.id === undefined) { markReady(r); continue; }
      const w = waiters.get(r.id); waiters.delete(r.id); if (w) w(r);
    }
  });
  let stderrTail = "";
  proc.stderr.on("data", (d) => { stderrTail = (stderrTail + d).slice(-800); });
  let seq = 0;
  const runEngineFast = (cmd, job) => new Promise((res, rej) => {
    const id = ++seq;
    waiters.set(id, (r) => (r.ok === false ? rej(new Error(r.error)) : res(r)));
    proc.stdin.write(JSON.stringify({ id, cmd, job }) + "\n");
  });
  const ctx = { runEngineFast };

  const { createDawRoutes } = await import("./routes.js");
  const json = (res, code, body) => { res.writeHead(code, {}); res.end(JSON.stringify(body)); };
  const handle = createDawRoutes({
    json, readBody: async (r) => r.body,
    config: { outputDir: OUT, python: config.python },
  });
  async function postRaw(body, url = "http://d.test/api/daw") {
    const cap = { out: "" };
    const res = {
      writeHead() { return res; }, setHeader() { return res; },
      write(s) { cap.out += s; return true; }, end(s) { if (s != null) cap.out += s; },
    };
    await handle({ method: body ? "POST" : "GET", body, headers: {} }, res, new URL(url));
    return JSON.parse(cap.out || "{}");
  }
  async function post(body) {
    const j = await postRaw(body);
    if (j.error) throw new Error(j.error);
    return j;
  }
  const act = (a, b) => vl.handleVoiceLabAction(a, b, ctx);

  /* THE AGENT'S HAND ON THE SAME DOOR. dawTools takes an api() and a name
   * sanitiser; this one dispatches into the very handler `post` uses, so a
   * tool call and a UI call are the same code path with a different actor —
   * which is the only way "one document, two hands" can be checked rather
   * than asserted. */
  const { dawTools } = await import("../mcp-daw.js");
  const TOOLS = dawTools(
    async (method, p, body) => (method === "POST" ? postRaw(body, `http://d.test${p}`)
      : postRaw(null, `http://d.test${p}`)),
    (s) => s);
  const tool = (name, args) => {
    const t = TOOLS.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t.run(args);
  };

  try {
    await ready;

    const P = await post({ action: "create", name: "voicelab suite", bpm: 128, bars: 8 });
    const slug = P.slug;
    await post({ action: "add_track", slug, name: "lead", instrument: "bigroom_lead" });
    await post({ action: "add_track", slug, name: "hats", instrument: "tr909" });
    for (let i = 0; i < 4; i++) {
      await post({ action: "add_note", slug, track: "lead", bar: i + 1, beat: 1, tick: 0, pitch: 60 + i, dur_ticks: 480, vel: 100 });
      await post({ action: "add_note", slug, track: "hats", bar: i + 1, beat: 1, tick: 0, pitch: 42, dur_ticks: 120, vel: 100 });
    }
    const before = await store.readProject(slug);
    const prevDir = path.join(store.DAW_DIR(), "_previews");

    console.log("\n  -- ONE DOOR: voice_lab and preview_note are the same file --");

    const a = await act("voice_lab", { slug, track: "lead", pitch: 64 });
    {
      /* Cache identity is now versioned and hashes the effective audio job.
       * preview-key_test.js varies timing, gain and mixer independently;
       * the real-render comparison below still proves both doors agree. */
      const t = store.findTrack(before, "lead");
      const want = new RegExp(`^pv_${t.instrument.patch}_v2_[a-f0-9]{24}\\.wav$`);
      ok(`the filename is a safe versioned audio identity (${a.file})`, want.test(a.file));
    }
    const pv = await post({ action: "preview_note", slug, track: "lead", pitch: 64 });
    ok("preview_note answers with that same file, from the same cache entry",
      pv.url === a.url && pv.cached === true, `${pv.url} vs ${a.url}`);

    const firstBytes = await readFile(path.join(prevDir, a.file));
    await unlink(path.join(prevDir, a.file));
    const b0 = await act("voice_lab", { slug, track: "lead", pitch: 64, params_override: {} });
    ok("params_override: {} renders the SAME NAME as no override at all",
      b0.file === a.file && b0.cached === false);
    ok("...and, forced to render again, the SAME BYTES — byte-identical, not "
      + "merely equivalent", sha(await readFile(path.join(prevDir, b0.file))) === sha(firstBytes));

    console.log("\n  -- an override changes the sound and touches nothing --");

    const c = await act("voice_lab", { slug, track: "lead", pitch: 64, params_override: { cutoff: 2400 } });
    ok(`a real override re-keys the file (${c.file})`, c.file !== a.file);
    ok("...and it is a different sound, not a different name for the same one",
      sha(await readFile(path.join(prevDir, c.file))) !== sha(firstBytes));
    ok("the reply says so, and hands back BOTH the params it used and the ones "
      + "the document still holds",
    c.document_untouched === true && c.params_overridden === true
      && c.params.cutoff === 2400
      && JSON.stringify(c.params_base) === JSON.stringify(before.tracks[0].instrument.params || {}));

    const dflt = store.PATCHES.bigroom_lead.params.cutoff.default;
    const d = await act("voice_lab", { slug, track: "lead", pitch: 64, params_override: { cutoff: dflt } });
    ok(`a knob set to its own declared default (cutoff ${dflt}) hashes as UNTOUCHED — `
      + "otherwise opening the panel would re-key every preview in the cache",
      d.file === a.file);

    const after = await store.readProject(slug);
    ok("after four previews the document has not moved: same updatedAt, same ledger",
      after.updatedAt === before.updatedAt && after.ledger.length === before.ledger.length,
      `${before.updatedAt} -> ${after.updatedAt}, ledger ${before.ledger.length} -> ${after.ledger.length}`);

    console.log("\n  -- the analysis block --");
    const an = await act("voice_lab", { slug, track: "lead", pitch: 64, analysis: true });
    ok(`analysis: true adds peaks, spectrum and envelope (${an.analysis.ms} ms server-side)`,
      !!an.analysis.peaks && !!an.analysis.spectrum && !!an.analysis.envelope);
    ok("the nine bands are named as well as numbered, per channel and folded",
      an.analysis.spectrum.band_names.length === 9
      && ["L", "R", "mid"].every((k) => k in an.analysis.spectrum.per_channel));
    ok("the knob rack is generated from patches.json, not from a list in this code",
      Object.keys(an.param_schema).length > 0
      && JSON.stringify(an.param_schema) === JSON.stringify(store.PATCHES.bigroom_lead.params));
    ok(`the whole warm call is inside the 100 ms budget (${an.ms} ms, cached: ${an.cached})`,
      an.cached === true && an.ms < 100, `${an.ms} ms`);
    ok("it says which lane it ran on rather than implying a fast one",
      an.lane === "shared" && /SHARED serve lane/.test(an.lane_note));
    console.log("\n  -- ONE FUNCTION, TWO DOORS: preview_note draws what voice_lab draws --");
    ok("analysePreview is exported for routes.js to call, taking (job, deps) — deps defaulted",
      typeof vl.analysePreview === "function" && vl.analysePreview.length === 1);
    {
      /* Through the REAL dispatcher — routes.js's own preview_note, its own
       * fast lane, its own children. This is the assertion that the mount and
       * this module actually fit, rather than each being right alone. */
      const pn = await post({ action: "preview_note", slug, track: "lead", pitch: 64, analysis: true });
      ok("preview_note asked for analysis comes back with one, through the mount",
        !!pn.analysis && !pn.analysisAbsent, pn.analysisAbsent || "no analysis");
      ok("...the same nine bands, per channel, and the knob rack from patches.json",
        pn.analysis.spectrum.band_names.length === 9
        && JSON.stringify(pn.analysis.param_schema) === JSON.stringify(store.PATCHES.bigroom_lead.params));
      const mine = await act("voice_lab", { slug, track: "lead", pitch: 64, analysis: true });
      ok("...and it is the SAME measurement voice_lab returns for the same file — "
        + "band for band, and t10/t30/t60 too",
      JSON.stringify(pn.analysis.spectrum.per_channel.mid.bands)
        === JSON.stringify(mine.analysis.spectrum.per_channel.mid.bands)
        && pn.analysis.envelope.mid.t30_ms === mine.analysis.envelope.mid.t30_ms);
      ok("a one-channel preview says why a width knob will not move in it",
        pn.analysis.channels === 1 && /stereo: true/.test(pn.analysis.mono_caveat));
      ok("...and points at the mip-map for the attack, rather than at 900 buckets",
        /mip-map/.test(pn.analysis.zoom));
      const over = await post({ action: "preview_note", slug, track: "lead", pitch: 64, params_override: { cutoff: 2400 } });
      ok("preview_note's own params_override re-keys the file, exactly as voice_lab's does",
        over.url === c.url, `${over.url} vs ${c.url}`);
    }
    {
      let msg = "";
      try { await vl.analysePreview({ file: "" }, ctx); } catch (e) { msg = e.message; }
      ok("analysePreview refuses a call with no file rather than measuring nothing",
        /rendered file/.test(msg), msg);
      msg = "";
      try { await vl.analysePreview({ file: "x.wav" }, {}); } catch (e) { msg = e.message; }
      ok("...and refuses a call with no lane, naming both lanes it accepts",
        /runOneNote/.test(msg) && /runEngineFast/.test(msg), msg);
    }


    console.log("\n  -- a width knob cannot be seen in a mono fold, and it says so --");
    const mono = await act("voice_lab", { slug, track: "hats", pitch: 42, dur_ticks: 120, analysis: true });
    ok("the default path is P0 mono — one channel, exactly as preview_note renders",
      mono.stereo === false && mono.analysis.channels === 1 && mono.analysis.mono === true);
    ok("...and the reply names the consequence instead of drawing two identical channels",
      /width knob/.test(mono.path_note) && /hat_width/.test(mono.path_note));
    const st0 = await act("voice_lab", {
      slug, track: "hats", pitch: 42, dur_ticks: 120, stereo: true, analysis: true,
      params_override: { hat_width: 0, hat_vel: 0.6 },
    });
    const st6 = await act("voice_lab", {
      slug, track: "hats", pitch: 42, dur_ticks: 120, stereo: true, analysis: true,
      params_override: { hat_width: 0.6, hat_vel: 0.6 },
    });
    ok("stereo: true reaches the two-channel instrument stage",
      st6.stereo === true && st6.analysis.channels === 2 && /^pv_[a-z0-9_]+_v2_[a-f0-9]{24}\.wav$/.test(st6.file));
    ok("hat_width 0 is dual mono; hat_width 0.6 is not",
      st0.analysis.mono === true && st6.analysis.mono === false);
    {
      const air = (r, ch) => r.analysis.spectrum.per_channel[ch].bands.at(-1).level_db;
      const dL = air(st6, "L") - air(st0, "L");
      const dR = air(st6, "R") - air(st0, "R");
      const dM = air(st6, "mid") - air(st0, "mid");
      ok(`THE MEASUREMENT THE MONO FOLD HID: hat_width 0.6 moves L by ${dL.toFixed(2)} dB `
        + `and R by ${dR.toFixed(2)} dB of air — neither channel loses top end — while the `
        + `FOLD loses ${dM.toFixed(2)} dB. An allpass cannot change a channel's magnitude; `
        + "it decorrelates them, and the loss is mono cancellation, not darkness.",
        Math.abs(dL) < 0.05 && Math.abs(dR) < 0.05 && dM < -0.5,
        `L ${dL} R ${dR} mid ${dM}`);
    }

    console.log("\n  -- the ceiling: the short-job lane stays short --");
    {
      const S = await post({ action: "create", name: "slow", bpm: 20, bars: 4 });
      await post({ action: "add_track", slug: S.slug, name: "pad", instrument: "pad" });
      let msg = "";
      try { await act("voice_lab", { slug: S.slug, track: "pad", dur_ticks: 960 * 8 }); }
      catch (err) { msg = err.message; }
      ok("a note past the ceiling is refused, and the refusal names the ceiling, "
        + "the real length and what to do instead",
        /10 s/.test(msg) && /24\.\d\d s/.test(msg) && /dur_ticks/.test(msg), msg || "not refused");
    }

    console.log("\n  -- render_stems: SAME HASH, and the sum it is honest about --");
    const s = await act("render_stems", { slug, from_bar: 1, to_bar: 4 });
    const reg = s.regions[0];
    {
      const doc = await store.readProject(slug);
      const hashes = store.regionHashes(doc);
      ok("the stem filenames carry the REGION's own hash, so they die with it",
        reg.hash === hashes[0]
        && reg.stems.every((x) => x.file === vl.stemName(0, hashes[0], x.track_id)),
        `${reg.hash} vs ${hashes[0]}`);
      ok("...and they are served by the same content-addressed audio path",
        reg.stems.every((x) => x.url === `/api/daw/audio/${slug}/${x.file}`));
    }
    ok(`one stem per audible track (${reg.stems.length}), rendered in ${reg.ms} ms`,
      reg.stems.length === 2);
    ok("the payload measures the sum rather than asserting it: bit-identical to "
      + "the pre-master mix", reg.sums_to_mix === true && reg.residual_db === null);
    ok("...and the master delta proves the master stage is really in the path",
      typeof reg.master_delta_db === "number" && reg.master_delta_db > -60);
    ok("the reply says the lanes do NOT add up to what you hear at the limiter",
      /PRE-MASTER/.test(s.sums_to) && /limiter/.test(s.sums_to));
    ok("...and that a stem render is a second full graph pass, so §0.1 applies",
      /second graph pass/.test(s.cost_note) && /lazy/.test(s.cost_note));
    const s2 = await act("render_stems", { slug, from_bar: 1, to_bar: 4 });
    ok("a second call renders nothing: the stems are cached by that same hash",
      s2.rendered === 0 && s2.regions[0].cached === true && s2.ms < reg.ms);
    {
      /* ── THE HIT TEST ASKS FOR WHAT THE ENGINE WRITES ──────────────────
       * The two tracks above both sound in bars 1-4, which is the one shape
       * that hid this: the hit test asked for a file per AUDIBLE track while
       * rack.render_stems writes one per track that SOUNDS. On any project
       * where a track is silent in the window, `missing` was never empty and
       * the lane re-rendered IN FULL on every open, forever.
       *
       * Eight tracks, four of them with nothing in bars 1-4 — the shape a
       * real arrangement has at bar 1. Measured before the fix, this machine:
       * three consecutive opens rendered 180.8 / 97.8 / 95.8 ms of engine and
       * cached nothing. SPEC §0.1 makes that ~11 s an open at the end of a
       * chained 128-bar project, every open, for the life of the project. */
      const E = await post({ action: "create", name: "eight track take", bpm: 128, length_bars: 16 });
      const es = E.slug;
      const LATE = ["clap", "pad", "riser", "impact"];
      for (const [name, inst, bars] of [
        ["kick", "hybrid_kick", [1, 2, 3, 4]], ["sub", "sub_bass", [1, 2, 3, 4]],
        ["lead", "bigroom_lead", [1, 3]], ["hats", "tr909", [2, 4]],
        ["clap", "tr808", [9, 10]], ["pad", "pad", [9, 11]],
        ["riser", "riser", [13]], ["impact", "impact", [13]],
      ]) {
        await post({ action: "add_track", slug: es, name, instrument: inst });
        for (const bar of bars) {
          await post({ action: "add_note", slug: es, track: name, bar, beat: 1, tick: 0,
            pitch: 48, dur_ticks: 240, vel: 100 });
        }
      }
      const doc8 = await store.readProject(es);
      const idOf = (n) => doc8.tracks.find((t) => t.name === n).id;
      const e1 = await act("render_stems", { slug: es, from_bar: 1, to_bar: 4 });
      const r1 = e1.regions[0];
      ok(`the first open renders the four tracks that SOUND in bars 1-4, not all `
        + `eight (${r1.ms} ms of engine)`,
      e1.rendered === 1 && r1.stems.length === 4
        && LATE.every((n) => !r1.stems.some((x) => x.track_id === idOf(n))));
      ok("...and NAMES the four that are silent there rather than leaving a lane blank",
        r1.silent_tracks.length === 4 && LATE.every((n) => r1.silent_tracks.includes(idOf(n))),
        r1.silent_tracks.join(", "));
      ok("...and the engine's own silent list agrees with the prediction the hit "
        + "test is made of — the differential guard on the cache rule",
        !r1.silent_disagreement && !e1.silent_disagreement
        && JSON.stringify([...r1.engine_silent_tracks].sort())
           === JSON.stringify([...r1.silent_tracks].sort()),
        JSON.stringify(r1.silent_disagreement || r1.engine_silent_tracks));

      const e2 = await act("render_stems", { slug: es, from_bar: 1, to_bar: 4 });
      ok(`THE BUG THIS PINS SHUT: the second open is cached — 0 ms of engine, `
        + `${e2.ms} ms in all — where it used to re-render in full, forever`,
      e2.rendered === 0 && e2.regions[0].cached === true && e2.regions[0].ms === 0,
      `rendered ${e2.rendered}, engine ${e2.regions[0].ms} ms`);
      ok("...and a cached region still names its silent tracks, by the same rule",
        LATE.every((n) => e2.regions[0].silent_tracks.includes(idOf(n))));
      ok("...and answers with the same four stem files, under the region's own hash",
        JSON.stringify(e2.regions[0].stems.map((x) => x.file))
        === JSON.stringify(r1.stems.map((x) => x.file)));
      ok("...and stays cached on the third open (it is a rule, not a warm-up)",
        (await act("render_stems", { slug: es, from_bar: 1, to_bar: 4 })).rendered === 0);
      ok("the reply states the rule, so a silent lane reads as silence and not as "
        + "a render that failed",
        /SOUNDS/.test(e1.cache_rule) && /cached/.test(e1.cache_rule));

      /* The other half of the same rule: opening ONE lane on a track that is
       * silent here must render nothing at all, rather than chasing a file
       * the engine is never going to write. */
      const solo = await act("render_stems", { slug: es, from_bar: 1, to_bar: 4, tracks: ["riser"] });
      ok("a lane opened on a track that is silent in these bars renders NOTHING, "
        + "and claims no stem that cannot exist",
      solo.rendered === 0 && solo.regions[0].cached === true
        && solo.regions[0].stems.length === 0
        && solo.regions[0].silent_tracks.length === 1);

      /* And the window where those four DO sound: the mirror image, same rule. */
      const late1 = await act("render_stems", { slug: es, from_bar: 9, to_bar: 12 });
      const late2 = await act("render_stems", { slug: es, from_bar: 9, to_bar: 12 });
      ok("bars 9-12 render only the two tracks that sound THERE, and cache on the "
        + "second open too — the rule is per region, not per project",
      late1.rendered === 1 && late1.regions[0].stems.length === 2
        && late2.rendered === 0 && late2.regions[0].cached === true);

      /* ── BIT TRANSPARENCY, on this project, both ways ──────────────────
       * The cache fix decides WHETHER to render, never WHAT is rendered, and
       * a stem pass must leave the region cache exactly where it found it.
       * Both are checked on the bytes rather than on the reply. */
      const cdir = store.cacheDir(es);
      const rendered = await post({ action: "render", slug: es, from_bar: 1, to_bar: 8 });
      const shaOf = async (f) => sha(await readFile(path.join(cdir, f)));
      const regFiles = (rendered.regions || []).map((x) => x.url.split("/").pop());
      const beforeSha = {};
      for (const f of regFiles) beforeSha[f] = await shaOf(f);
      await act("render_stems", { slug: es, from_bar: 1, to_bar: 8 });
      let moved = [];
      for (const f of regFiles) if (await shaOf(f) !== beforeSha[f]) moved.push(f);
      ok(`a stem pass leaves every region render byte-identical (${regFiles.length} `
        + "regions, sha1 before and after)", moved.length === 0, moved.join(", "));

      const dropped2 = await vl.dropStems(es, 0);
      const again = await act("render_stems", { slug: es, from_bar: 1, to_bar: 4 });
      ok(`re-rendering a dropped lane (${dropped2.dropped} files) produces the SAME `
        + "BYTES — the engine's own sha1, not the filename, which is only the same "
        + "because the hash is",
      again.rendered === 1
        && JSON.stringify(again.regions[0].stems.map((x) => x.sha1))
           === JSON.stringify(r1.stems.map((x) => x.sha1)),
      JSON.stringify(again.regions[0].stems.map((x) => x.sha1)));
    }
    {
      /* ══ [DAWREC] A RECORDED TAKE, END TO END: the render, then the lane ══
       *
       * THE DEFECT, on the real door. rack.chain_graph built its dry buffers
       * from job["notes"] and nothing else, so a file-backed clip rendered as
       * SILENCE the moment a project had a mixer — and store.js gives every
       * NEW project master.stereo, which forces the chain path. Measured in
       * the engine before the fix: peak 0.206966 on the P0 mono lane, peak
       * 0.0 through a no-op mixer, the chained render carrying the sha1 of
       * the same job with no clip at all. This block asks the question the
       * way a person does — import a file, render the bars — so the answer
       * cannot be right in server/daw/capture_test.py and wrong here.
       */
      const C = await post({ action: "create", name: "a recorded take", bpm: 120, length_bars: 4 });
      const cs = C.slug;
      const doc0 = await store.readProject(cs);
      ok("a NEW project renders through the rack (master.stereo), which is why this "
        + "defect was every new project with a take, not an edge case",
      doc0.master?.stereo === true && !mixer.isDefaultMixer(doc0));
      await post({ action: "add_track", slug: cs, name: "vox", instrument: "pluck" });
      await post({ action: "add_track", slug: cs, name: "keys", instrument: "pad" });
      await post({ action: "add_note", slug: cs, track: "keys", bar: 1, beat: 1, tick: 0,
        pitch: 60, dur_ticks: 480, vel: 100 });

      /* One second of real signal, written as the float32 wav engine.py's own
       * reader speaks, imported through the route both hands use. */
      const secs = 1;
      const samples = new Float32Array(store.SR * secs);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.fround(0.4 * Math.sin((2 * Math.PI * 220 * i) / store.SR));
      }
      const srcWav = path.join(OUT, "take_probe.wav");
      writeFileSync(srcWav, wavF32(samples, store.SR));
      const imp = await post({ action: "import_audio", slug: cs, track: "vox",
        path: srcWav, bar: 1, beat: 1, tick: 0 });
      ok(`the take imported and sits on the timeline (${imp.seconds}s, ${imp.format})`,
        !!imp.clip && imp.clip.durSamples > store.SR * 0.9);

      const withClip = await post({ action: "render", slug: cs, from_bar: 1, to_bar: 4 });
      const cdirC = store.cacheDir(cs);
      const regFile = withClip.regions[0].url.split("/").pop();
      const y = readFileSync(path.join(cdirC, regFile));
      let peak = 0;
      for (let i = 44; i + 4 <= y.length; i += 4) peak = Math.max(peak, Math.abs(y.readFloatLE(i)));
      ok(`THE BUG THIS PINS SHUT: the region carrying the take renders AUDIBLE — `
        + `peak ${peak.toFixed(6)}, where the same file rendered 0.0 through the rack`,
      peak > 0.1, `peak ${peak}`);

      /* And the clip is really what is in there: delete it and the same bars
       * render different bytes. A peak alone could have come from the pad. */
      const only = await post({ action: "remove_audio_clip", slug: cs,
        track: "vox", clip: imp.clip.id });
      const without = await post({ action: "render", slug: cs, from_bar: 1, to_bar: 4 });
      ok("...and it is the CLIP that is in the file: removing it re-keys the region "
        + "and renders other bytes",
      !!only && without.regions[0].hash !== withClip.regions[0].hash
        && without.regions[0].url !== withClip.regions[0].url);

      /* Put it back, then open the lanes: the take's track must have one. */
      await post({ action: "import_audio", slug: cs, track: "vox",
        path: srcWav, bar: 1, beat: 1, tick: 0 });
      const docC = await store.readProject(cs);
      const voxId = docC.tracks.find((t) => t.name === "vox").id;
      const stemsC = await act("render_stems", { slug: cs, from_bar: 1, to_bar: 4 });
      const regC = stemsC.regions[0];
      ok("render_stems gives the take's track its own lane, instead of naming it silent",
        regC.stems.some((x) => x.track_id === voxId)
        && !regC.silent_tracks.includes(voxId),
        `stems ${JSON.stringify(regC.stems.map((x) => x.track_id))} silent ${JSON.stringify(regC.silent_tracks)}`);
      ok("...and the lane carries signal, not an empty bus",
        (regC.stems.find((x) => x.track_id === voxId)?.peak ?? 0) > 0.1);
      ok("...with the route's prediction and the engine's own answer still agreeing "
        + "(the differential guard, on a shape that never existed before)",
      !regC.silent_disagreement && !stemsC.silent_disagreement);
      ok("the reply NAMES the lanes that carry a clip, where it used to say no lane "
        + "could",
      JSON.stringify(stemsC.audio_clip_tracks) === JSON.stringify([voxId])
        && stemsC.audio_clips_absent === undefined,
      JSON.stringify(stemsC.audio_clip_tracks));
      const stemsC2 = await act("render_stems", { slug: cs, from_bar: 1, to_bar: 4 });
      ok("...and the second open is cached: the hit test counts a clip track as one "
        + "that sounds, so the lane does not re-render forever",
      stemsC2.rendered === 0 && stemsC2.regions[0].cached === true);

      /* THE METERS MEASURE THE SAME GRAPH. Without the clips in that job the
       * mastering suite was reading a mix that had never had the take in it. */
      const met = await post({ action: "meters", slug: cs, from_bar: 1, to_bar: 4 });
      ok("the mixer's meters see the take's track above silence — the analyser and "
        + "the render are one graph again",
      (met.tracks?.[voxId]?.peak_db ?? -999) > -40, JSON.stringify(met.tracks?.[voxId]));
    }
    {
      /* 128 bars is 32 regions, and at the end of a chained project each one
       * is ~11 s of graph (SPEC §0.1). Refused before a single sample moves. */
      const B = await post({ action: "create", name: "long one", bpm: 128, length_bars: 128 });
      await post({ action: "add_track", slug: B.slug, name: "lead", instrument: "bigroom_lead" });
      let msg = "";
      try { await act("render_stems", { slug: B.slug }); } catch (e) { msg = e.message; }
      ok("32 regions of stems is refused BEFORE anything renders, with the cost "
        + "and the limit both named",
      /32 regions/.test(msg) && /graph pass/.test(msg) && /16 regions/.test(msg), msg || "not refused");
    }

    console.log("\n  -- peaks: built once per file, and only for a render --");
    const nm = reg.stems[0].file;
    const pk = await act("peaks", { slug, name: nm, samples_per_pixel: 400 });
    ok(`the mip-map builds on first ask (${pk.build_ms} ms) and answers stage `
      + `${pk.stage.shift} for 400 samples a pixel`,
      pk.built === true && pk.stage.shift === 9 && pk.data.length === 2);
    const pk2 = await act("peaks", { slug, name: nm, samples_per_pixel: 400 });
    ok(`a second ask does not rebuild it (${pk2.ms} ms)`, pk2.built === false);
    ok("min and max come back for BOTH channels",
      pk.data.every((c) => c.min.length === c.max.length && c.min.length === pk.peaks));
    {
      const fine = await act("peaks", { slug, name: nm, stage: 3, from_sample: 0, to_sample: 32000 });
      const coarse = await act("peaks", { slug, name: nm, stage: 6, from_sample: 0, to_sample: 32000 });
      let bad = 0;
      for (let i = 0; i < coarse.peaks; i++) {
        for (let j = i * 8; j < Math.min((i + 1) * 8, fine.peaks); j++) {
          if (coarse.data[0].min[i] > fine.data[0].min[j] + 1e-9) bad++;
          if (coarse.data[0].max[i] < fine.data[0].max[j] - 1e-9) bad++;
        }
      }
      ok("through the ROUTE too, a coarse peak bounds every fine peak beneath it",
        bad === 0, `${bad} violations`);
    }
    {
      const wide = await act("peaks", { slug, name: nm, stage: 3, from_sample: 0, to_sample: 360000, max_peaks: 1000 });
      ok(`a zoom that would need 45 000 peaks is answered at a coarser stage `
        + `(${wide.stage.shift}) and SAYS it coarsened`,
        wide.stage.shift > 3 && wide.peaks <= 1000 && /narrower sample range/.test(wide.coarsened_note));
    }
    for (const [label, body] of [
      ["a path outside the cache", { slug, name: "../../project.json" }],
      ["a name that is not content-addressed", { slug, name: "anything.wav" }],
      ["a region name with no slug", { name: "reg0_aaaaaaaaaaaa.wav" }],
      ["a slug that is a path", { slug: "../..", name: "reg0_aaaaaaaaaaaa.wav" }],
    ]) {
      let msg = "";
      try { await act("peaks", body); } catch (e) { msg = e.message; }
      ok(`peaks refuses ${label}`, msg.length > 0, "it answered");
    }
    {
      const dropped = await vl.dropStems(slug, 0);
      ok(`dropStems closes the lanes: ${dropped.dropped} stems and their sidecars gone`,
        dropped.dropped === 2 && dropped.files.every((f) => vl.isStemName(f)));
      const back = await act("render_stems", { slug, from_bar: 1, to_bar: 4 });
      ok("...and re-opening one renders them again under the SAME name, because "
        + "the name was never anything but the region's hash",
      back.rendered === 1 && back.regions[0].stems[0].file === reg.stems[0].file);
    }


    console.log("\n  -- THE AGENT'S HAND: three tools, the same door --");
    {
      /* These three shipped with a route and a panel and NO TOOL: three
       * capabilities a person could reach and an agent could not, past a
       * census that reported 216 passed / 0 failed. server/daw/ui_test.js
       * now fails a route with no tool; this proves the tools reach the
       * SAME door rather than merely existing. */
      const named = ["daw_voice_lab", "daw_render_stems", "daw_peaks"];
      const rows = named.map((n) => TOOLS.find((t) => t.name === n));
      ok(`the three tools are in the family (${named.join(", ")})`,
        rows.every(Boolean), named.filter((n, i) => !rows[i]).join(", "));
      ok("...each with a schema that refuses an undeclared property",
        rows.every((t) => t?.inputSchema?.additionalProperties === false));

      const vlTool = await tool("daw_voice_lab", { slug, track: "lead", pitch: 64 });
      ok("daw_voice_lab answers the SAME file the page's own call answers — one "
        + "cache entry, one door, not a second render path",
      vlTool.url === a.url && vlTool.cached === true, `${vlTool.url} vs ${a.url}`);
      ok("...and hands back the knob rack from patches.json, so an agent can name a "
        + "knob without guessing", Object.keys(vlTool.param_schema).length > 0);
      const beforeTool = await store.readProject(slug);
      const ovTool = await tool("daw_voice_lab",
        { slug, track: "lead", pitch: 64, params_override: { cutoff: 2400 }, analysis: true });
      const afterTool = await store.readProject(slug);
      ok("...and an agent's override writes nothing either: same updatedAt, same "
        + "ledger, and it says so in the reply",
      ovTool.document_untouched === true && ovTool.params_overridden === true
        && afterTool.updatedAt === beforeTool.updatedAt
        && afterTool.ledger.length === beforeTool.ledger.length);
      ok("...with the pictures attached when asked, the same nine bands",
        ovTool.analysis?.spectrum?.band_names?.length === 9);

      const stTool = await tool("daw_render_stems", { slug, from_bar: 1, to_bar: 4 });
      ok("daw_render_stems answers the cached region rather than rendering a second "
        + "copy — the tool shares the region hash's cache with the page",
      stTool.rendered === 0 && stTool.regions[0].cached === true
        && stTool.regions[0].stems[0].file === reg.stems[0].file);
      ok("...and carries the fact the lanes are easiest to be wrong about",
        /PRE-MASTER/.test(stTool.sums_to) && /SOUNDS/.test(stTool.cache_rule));

      const pkTool = await tool("daw_peaks", { slug, name: nm, samples_per_pixel: 400 });
      ok("daw_peaks reads a stem at a zoom: min AND max, both channels, at the "
        + "stage that zoom asks for",
      pkTool.data.length === 2 && pkTool.stage.shift === 9
        && pkTool.data.every((c) => c.min.length === c.max.length && c.min.length === pkTool.peaks));
      ok("...and the sidecar it built is kept, so the next ask rebuilds nothing",
        (await tool("daw_peaks", { slug, name: nm, samples_per_pixel: 400 })).built === false);
      const pkPrev = await tool("daw_peaks", { name: a.file });
      ok("...and a Voice Lab preview needs no slug: it lives outside any project",
        pkPrev.file === a.file && pkPrev.channels >= 1);
      let msg = "";
      try { await tool("daw_peaks", { slug, name: "anything.wav" }); } catch (e) { msg = e.message; }
      ok("...and the tool inherits the route's refusal, naming what it does serve",
        /content-addressed/.test(msg), msg);

      /* THE DESCRIPTIONS ARE THE TEACHING, and an agent cannot hear the
       * render — so the two facts that cost the most to learn by experiment
       * have to be in the text, not just in the reply. */
      const d = (n) => rows[named.indexOf(n)].description;
      ok("daw_render_stems' description states the O(prefix) cost with its measured "
        + "numbers, so an agent knows why bar 125 is slow",
        /322 ms/.test(d("daw_render_stems")) && /5 893 ms/.test(d("daw_render_stems"))
        && /second full graph pass|SECOND full graph pass/.test(d("daw_render_stems")));
      ok("...and that the stems sum to the PRE-MASTER mix, not to what you hear",
        /PRE-MASTER/.test(d("daw_render_stems")));
      ok("daw_voice_lab's description states that the default path is MONO and a "
        + "width knob cannot be seen in it",
        /mono/i.test(d("daw_voice_lab")) && /width/i.test(d("daw_voice_lab"))
        && /stereo: true/.test(d("daw_voice_lab")));
      ok("...and that params_override is not written to the document",
        /NOT\s+written/.test(d("daw_voice_lab")) && /undo/.test(d("daw_voice_lab")));
      ok("daw_peaks' description says min AND max, and how a value decodes",
        /MIN AND MAX/.test(d("daw_peaks")) && /32 ?767/.test(d("daw_peaks")));
    }

    console.log("\n  -- the whole panel's opening call, measured --");
    {
      const t0 = Date.now();
      await act("voice_lab", { slug, track: "lead", pitch: 67, analysis: true });
      const cold = Date.now() - t0;
      const t1 = Date.now();
      await act("voice_lab", { slug, track: "lead", pitch: 67, analysis: true });
      const warm = Date.now() - t1;
      ok(`a knob turn costs ${cold} ms cold (render + analysis) and ${warm} ms warm, `
        + "against the 100 ms the panel is budgeted", warm < 100 && cold < 400,
      `cold ${cold} warm ${warm}`);
    }
  } catch (err) {
    ok("the disk half ran", false, `${err.stack || err.message}\n${stderrTail}`);
  } finally {
    try { proc.stdin.write(JSON.stringify({ id: 0, cmd: "shutdown", job: {} }) + "\n"); } catch { /* gone */ }
    proc.stdin.end();
    if (!process.env.KEEP_VOICELAB_TEST) await rm(OUT, { recursive: true, force: true }).catch(() => {});
  }
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.log("  failed:\n   " + failures.join("\n   ") + "\n");
  process.exit(1);
}
