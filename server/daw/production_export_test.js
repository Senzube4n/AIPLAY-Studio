/** Actual MCP -> HTTP -> CPU encode/tag/download, using disposable app data. */
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, writeFile, copyFile, readdir } from "node:fs/promises";

const fixture = await mkdtemp(path.join(os.tmpdir(), "aiplay-export-"));
process.env.AIPLAY_OUTPUT = path.join(fixture, "output");
process.env.AIPLAY_APPDATA = path.join(fixture, "appdata");
process.env.AIPLAY_DAW_NO_SERVE = "1";
const { config } = await import("../config.js");
const { createDawRoutes } = await import("./routes.js");
const { dawTools } = await import("../mcp-daw.js");
const store = await import("./store.js");
const provenance = await import("../provenance.js");
assert.ok(path.resolve(store.DAW_DIR()).startsWith(path.resolve(fixture) + path.sep));
let children = 0, checks = 0;
const check = (condition, text) => { assert.ok(condition, text); checks++; };
const json = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data));
};
/* THE JOBS THE SERVER REALLY BUILT. AIPLAY_DAW_NO_SERVE=1 above sends every
 * render down runOnce, which writes its job to a file and passes the path —
 * so reading that file at spawn time is a copy of the exact payload routes.js
 * handed the engine, not a second guess at it. The whole-song reference render
 * below is one of those jobs with its window widened, which is why the
 * reference cannot quietly disagree with the product about the document. */
const jobSpy = [];
let spyOn = false;
const ENGINE_PY = path.join(path.dirname(fileURLToPath(import.meta.url)), "engine.py");
const spawnPython = (args, opts = {}) => {
  children++;
  if (spyOn && args[0] === ENGINE_PY && args[1] === "render" && args[2]) {
    try { jobSpy.push(JSON.parse(readFileSync(args[2], "utf8"))); } catch { /* not a job file */ }
  }
  return spawn(config.python, args,
    { windowsHide: true, ...opts, env: { ...process.env, ...opts.env, CUDA_VISIBLE_DEVICES: "", HF_HUB_OFFLINE: "1" } });
};
const handle = createDawRoutes({ config, provenance, json, spawnPython,
  readBody: async req => { let raw = ""; for await (const chunk of req) raw += chunk; return JSON.parse(raw || "{}"); },
});
const server = http.createServer(async (req, res) => {
  try { if (!await handle(req, res, new URL(req.url, "http://localhost"))) json(res, 404, { error: "No route" }); }
  catch (error) { json(res, 500, { error: error.message }); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const api = async (method, route, body) => {
  const r = await fetch(base + route, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const result = await r.json(); if (!r.ok) throw new Error(result.error); return result;
};
const tools = dawTools(api, s => s);
const tool = (name, args) => tools.find(t => t.name === name).run(args);
const post = body => api("POST", "/api/daw", { ...body, by: "agent" });
try {
  const made = await post({ action: "create", name: "Export parity fixture", length_bars: 1, bpm: 120 });
  const slug = made.slug;
  const track = await post({ action: "add_track", slug, name: "Stereo source", instrument: "pad", with_clip: false });
  const tid = track.trackId;
  const sr = 48000, n = sr;
  const wav = Buffer.alloc(44 + n * 8);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(3, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(sr, 24); wav.writeUInt32LE(sr * 8, 28); wav.writeUInt16LE(8, 32);
  wav.writeUInt16LE(32, 34); wav.write("data", 36); wav.writeUInt32LE(n * 8, 40);
  for (let i = 0; i < n; i++) {
    wav.writeFloatLE(.2 * Math.sin(2 * Math.PI * 440 * i / sr), 44 + i * 8);
    wav.writeFloatLE(.1 * Math.cos(2 * Math.PI * 997 * i / sr), 48 + i * 8);
  }
  const source = path.join(fixture, "source.wav"); await writeFile(source, wav);
  const imported = await tool("daw_import_audio", { slug, track: tid, path: source });
  check(imported.channels === 2 && imported.source_channels === 2 && imported.source_sr === sr && imported.peak === .2,
    "MCP import exposes decoded channel/rate/headroom facts");
  const restored = await store.readProject(slug);
  check(restored.tracks[0].audioClips[0].channels === 2 && restored.tracks[0].audioClips[0].format === "flac",
    "import facts survive project reload");
  const before = children, ledger = JSON.stringify(restored.ledger);
  for (const invalid of [{ format: "mp3" }, { bit_depth: 32 }, { target_lufs: -3 }, { target_lufs: "-17" },
    { ceiling_db: 2 }, { max_limit_db: -1 }, { target_lufs: null, ceiling_db: "-1" }]) {
    await assert.rejects(post({ action: "bounce", slug, ...invalid })); checks++;
  }
  check(children === before, "invalid settings launch no encoder or renderer");
  check(JSON.stringify((await store.readProject(slug)).ledger) === ledger, "invalid settings do not mutate provenance or project");
  check((await readdir(path.join(store.projectDir(slug), "bounces")).catch(() => [])).length === 0, "invalid settings write no bounce");

  // A credit is attached locally for this synthetic fixture; no sample pack install.
  const fixtureCredit = "Synthetic test attribution — CC0 fixture, no sample pack used";
  await provenance.append({ dir: store.projectDir(slug) }, { actor: "agent:test", type: "licence_attach",
    asset: `daw/${slug}`, data: { pack: "fixture", spdx: "CC0-1.0", licenceName: "CC0",
      attributionText: fixtureCredit, required: true } });
  const flac = await tool("daw_bounce", { slug, target_lufs: null });
  check(flac.format === "flac" && flac.bit_depth === 24 && flac.channels === 2 && !flac.dithered && flac.tagged.ok,
    "default native FLAC remains tagged 24-bit stereo");
  const wavOut = await tool("daw_bounce", { slug, format: "wav", bit_depth: 16, target_lufs: -17,
    ceiling_db: -1.2, max_limit_db: .98 });
  check(wavOut.format === "wav" && wavOut.bit_depth === 16 && wavOut.dithered && wavOut.tagged.ok,
    "WAV export runs the same loudness, dither and tag pipeline");
  check(wavOut.loudness?.max_limit_db === .98 && wavOut.loudness?.ceiling_db === -1.2 && wavOut.origin === wavOut.tagged.class,
    "MCP exposes effective loudness settings and origin");
  for (const result of [flac, wavOut]) {
    const response = await fetch(base + result.url);
    check(response.ok && /attachment/.test(response.headers.get("content-disposition")), "download has an attachment response");
    check(response.headers.get("content-type") === `audio/${result.format}`, "download MIME matches format");
    check(Buffer.from(await response.arrayBuffer()).equals(await readFile(result.file)), "download bytes equal final tagged file");
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", result.file], { encoding: "utf8", windowsHide: true }));
    check(probe.streams[0].channels === 2 && Number(probe.streams[0].bits_per_raw_sample || probe.streams[0].bits_per_sample) === result.bit_depth,
      "actual encoded channels and bit depth match MCP result");
    const tags = Object.fromEntries(Object.entries(probe.format.tags || {}).map(([k, v]) => [k.toLowerCase(), v]));
    check(tags.copyright === fixtureCredit, "actual export retains required credit text");
    check(result.format === "wav" ? /DIGITALSOURCETYPE=http/.test(tags.comment) && /AI_DISCLOSURE=/.test(tags.comment)
      : String(tags.digitalsourcetype).startsWith("http"), "actual export retains an explicit origin marker");
  }
  const legacyName = `${slug}_abc123.flac`;
  await copyFile(flac.file, path.join(store.projectDir(slug), "bounces", legacyName));
  check((await fetch(`${base}/api/daw/bounce/${slug}/${legacyName}`)).ok, "existing timestamp-only bounce names remain downloadable");
  for (const bad of [`${slug}/..%5Csecret.flac`, `${slug}/${slug}_abc.flac%2fextra`, `${slug}/${slug}_abc.json`,
    `${slug}/${slug}_abc.flac/extra`, `..%5C${slug}/${path.basename(flac.file)}`, `${slug}/another_abc.flac`]) {
    check(!(await fetch(`${base}/api/daw/bounce/${bad}`)).ok, "download rejects traversal, extra segments and unrelated files");
  }
  const delivery = await tool("daw_check_delivery", { file: wavOut.file, target_lufs: -17, ceiling_db: -1.2, max_limit_db: .98 });
  check(delivery.results.some(row => row.id === "custom"), "actual custom delivery check reaches Python through MCP");

  /* ════════════════════════════════════════════════════════════════════════
   * THE SAMPLES. Everything above this line is FORMAT — bit depth, channel
   * count, ffprobe properties, tags, download headers, path safety. Not one
   * of those 35 checks decodes an audio frame, so not one of them could fail
   * if the export stopped carrying the music: a file with the right header,
   * the right tags and the wrong samples passes all of them. That is the
   * regression this file is named for, and this block is the part that bites.
   *
   * THREE renders of ONE five-bar project, compared frame by frame:
   *
   *   editor    the region cache exactly as the browser assembles it — the
   *             reg<idx>_<hash>.wav files fetched back over HTTP from
   *             /api/daw/audio and concatenated in playback order.
   *   export    daw_bounce's delivered file, decoded through ffmpeg. The
   *             bounce concatenates the SAME cache files, so editor↔export
   *             can only differ by the encoder — which is the point: this
   *             pair pins the encoder's arithmetic to the bit depth's own
   *             error bound rather than to "it wrote a file".
   *   reference the whole song rendered in ONE window. editor↔export alone is
   *             true by construction (routes.js's bounce case concatenates
   *             the cache), so a defect in the SHARED render — a dropped
   *             look-ahead, a return missing from the sum — moves both sides
   *             equally and cannot show up in their difference. The one-window
   *             render is the independent side those defects move against.
   *
   * The project is built to exercise the three things the concatenation can
   * get wrong: an effect RETURN (a delay, whose tail rings on for a second
   * after the source clip stops, so the last 20 % of the song is return and
   * nothing else); a REGION BOUNDARY at bar 5 with a transient 5 ms past it,
   * so region 0's last samples are only correct if its render saw the future
   * that region 1 contains; and BOTH BIT DEPTHS, 24-bit undithered and 16-bit
   * with the shaped dither.
   *
   * COST: about 7.5 s on this machine for this section — 7.69 / 8.03 / 7.12 s
   * over three runs — inside a suite that takes about 13 s end to end. 6 s of
   * audio, two regions, two encodes and one reference render, no synthesis (the
   * only source is a file-backed clip, so the rack does the work and the synths
   * do none). Do not trust this sentence: it is measured on every run and
   * printed as `sampleMs` in the result line below, which is the number to
   * read. An earlier draft said "about 10 s" and no run reproduced it.
   * ═══════════════════════════════════════════════════════════════════════ */
  const tSamples = Date.now();

  /* ── the fixture. 200 bpm, 4/4, 5 bars: a bar is 1.2 s, so the song is
   * 6.000 s and REGION_BARS=4 puts the seam at bar 5 = 4.800 s = frame
   * 230400. The clip is 5.000 s, which leaves a full second of nothing but
   * the return's echoes at the end of the song. */
  const bpm = 200, bars = 5, clipSeconds = 5, songSeconds = 6;
  const nClip = sr * clipSeconds;
  const burstAt = Math.round(4.805 * sr);       // 5 ms PAST the seam, on purpose
  const burstLen = 900;
  const clipWav = Buffer.alloc(44 + nClip * 8);
  clipWav.write("RIFF"); clipWav.writeUInt32LE(clipWav.length - 8, 4); clipWav.write("WAVEfmt ", 8);
  clipWav.writeUInt32LE(16, 16); clipWav.writeUInt16LE(3, 20); clipWav.writeUInt16LE(2, 22);
  clipWav.writeUInt32LE(sr, 24); clipWav.writeUInt32LE(sr * 8, 28); clipWav.writeUInt16LE(8, 32);
  clipWav.writeUInt16LE(32, 34); clipWav.write("data", 36); clipWav.writeUInt32LE(nClip * 8, 40);
  for (let i = 0; i < nClip; i++) {
    let l = .12 * Math.sin(2 * Math.PI * 220 * i / sr);
    let r = .12 * Math.sin(2 * Math.PI * 331 * i / sr);
    /* Over the master limiter's ceiling by a wide margin: a transient the
     * limiter ignores would leave the look-ahead with nothing to anticipate,
     * and the seam assertion would pass for the wrong reason. */
    if (i >= burstAt && i < burstAt + burstLen) {
      const w = Math.sin(Math.PI * (i - burstAt) / burstLen);
      l += 1.2 * w; r += 1.15 * w;
    }
    clipWav.writeFloatLE(l, 44 + i * 8); clipWav.writeFloatLE(r, 48 + i * 8);
  }
  const clipFile = path.join(fixture, "parity_source.wav"); await writeFile(clipFile, clipWav);

  const made2 = await post({ action: "create", name: "Export parity samples", length_bars: bars, bpm });
  const slug2 = made2.slug;
  const track2 = await post({ action: "add_track", slug: slug2, name: "Bed", instrument: "pad", with_clip: false });
  const imported2 = await tool("daw_import_audio", { slug: slug2, track: track2.trackId, path: clipFile });
  check(imported2.channels === 2 && imported2.source_sr === sr,
    "the parity fixture imports as a stereo 48 k clip, so no resampler sits between the paths");
  const ret = await post({ action: "return_add", slug: slug2, name: "Echo" });
  await post({ action: "insert_add", slug: slug2, target: ret.returnId, type: "delay",
    params: { sync: "1/8", feedback: .35, mix: 1, pingpong: 0 } });
  await post({ action: "send_set", slug: slug2, track: track2.trackId, to: ret.returnId, level: -6 });
  await post({ action: "insert_add", slug: slug2, target: "master", type: "limiter",
    params: { ceiling_db: -1, lookahead_ms: 10, release_ms: 80 } });

  /* ── path 1: the editor's region cache, fetched the way the browser does. */
  spyOn = true;
  const rendered = await post({ action: "render", slug: slug2 });
  spyOn = false;
  const regions = rendered.regions.slice().sort((a, b) => a.idx - b.idx);
  check(regions.length === 2 && regions[1].startSample === Math.round(4.8 * sr),
    `the fixture really has a region boundary to test: ${regions.length} regions, seam at frame ${regions[1]?.startSample}`);
  const f32 = (buf, off) => {
    const n = (buf.length - off) >> 2, a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = buf.readFloatLE(off + i * 4);
    return a;
  };
  const streamed = [];
  for (const r of regions) {
    const resp = await fetch(base + r.url);
    if (!resp.ok) throw new Error(`the browser's own region URL did not serve: ${r.url}`);
    const bytes = Buffer.from(await resp.arrayBuffer());
    check(bytes.length === 44 + r.nSamples * 2 * 4,
      `region ${r.idx} streams the whole ${r.nSamples}-frame stereo window (${bytes.length} bytes)`);
    streamed.push(f32(bytes, 44));
  }
  const editor = new Float32Array(streamed.reduce((a, p) => a + p.length, 0));
  { let at = 0; for (const p of streamed) { editor.set(p, at); at += p.length; } }
  const frames = editor.length / 2;
  check(frames === songSeconds * sr,
    `the editor's cache adds up to the whole song: ${frames} frames, expected ${songSeconds * sr}`);

  /* ── path 2: the offline export, at both bit depths. target_lufs null on
   * purpose — with the loudness stage on, the export is a DIFFERENT signal by
   * design and there is nothing to compare. Off, the encoder's only licence
   * to change a sample is the quantiser, and that is what is measured. */
  const exp24 = await tool("daw_bounce", { slug: slug2, target_lufs: null });
  const exp16 = await tool("daw_bounce", { slug: slug2, format: "wav", bit_depth: 16, target_lufs: null });
  check(exp24.bit_depth === 24 && !exp24.dithered && exp16.bit_depth === 16 && exp16.dithered,
    "the two exports are the two quantisers this comparison has bounds for: 24-bit rounded, 16-bit dithered");
  const decode = (file) => f32(execFileSync("ffmpeg",
    ["-v", "error", "-i", file, "-f", "f32le", "-acodec", "pcm_f32le", "-"],
    { maxBuffer: 1 << 28, windowsHide: true }), 0);

  /* ── the comparison itself. Both paths start at absolute sample 0 and are
   * declared the same length, so alignment is an ASSERTION, not a search: a
   * length that does not match is already the bug (a dropped region, a padded
   * encoder), and silently sliding one buffer past the other to make the
   * numbers agree would hide exactly that. */
  const diff = (a, b, from = 0, to = Infinity) => {
    const lo = from * 2, hi = Math.min(a.length, b.length, to * 2);
    let max = 0, sum = 0, at = lo;
    for (let i = lo; i < hi; i++) {
      const d = Math.abs(a[i] - b[i]);
      if (d > max) { max = d; at = i; }
      sum += d * d;
    }
    return { max, rms: Math.sqrt(sum / Math.max(1, hi - lo)), frame: at >> 1,
             seconds: Number(((at >> 1) / sr).toFixed(4)) };
  };
  const rms = (a, from, to) => {
    let sum = 0; const lo = from * 2, hi = Math.min(a.length, to * 2);
    for (let i = lo; i < hi; i++) sum += a[i] * a[i];
    return Math.sqrt(sum / Math.max(1, hi - lo));
  };

  /* THE TOLERANCES, derived from the bit depth rather than picked. One LSB on
   * the ±1 scale is 2^-(bits-1).
   *
   *   24-bit, dither OFF: the encoder rounds to nearest, so |error| ≤ ½ LSB
   *     = 2^-24 = 5.96e-8 exactly. Decoding back through float32 can round
   *     once more (float32's own ulp below 1.0 is at most 2^-24), so the
   *     bound is ONE 24-bit LSB, 1.19e-7 — twice what round-to-nearest can
   *     produce, and still four hundred times under the 16-bit floor.
   *   16-bit, dither ON: master.apply_dither adds TPDF at ±1 LSB and feeds
   *     the error back through NTF (1 − z⁻¹)², taps (−2, +1). Per sample the
   *     quantiser's own error is ≤ ½ LSB rounding + 1 LSB dither = 1.5 LSB,
   *     and the shaped output error is e[i] − 2e[i−1] + e[i−2], so the worst
   *     case is 1.5 × (1 + 2 + 1) = 6 LSB = 1.83e-4. NOT zero, and NOT a
   *     guess: a test that demanded bit-equality here would be wrong about
   *     the arithmetic, and one that allowed 1 % would not notice a defect.
   *
   * The rms bounds come from the same place: flat quantisation noise is
   * LSB/√12 = 0.289 LSB, and the shaped 16-bit noise is √6 × the TPDF rms.
   * They are the assertions that catch a small CONSTANT offset, which a peak
   * bound alone would let through. */
  const LSB24 = 2 ** -23, LSB16 = 2 ** -15;
  const d24 = diff(editor, decode(exp24.file));
  const d16 = diff(editor, decode(exp16.file));
  check(decode(exp24.file).length === editor.length && decode(exp16.file).length === editor.length,
    "both exports decode to exactly as many frames as the editor streamed — nothing dropped, nothing padded");
  check(d24.max <= LSB24, `24-bit export matches the editor's samples inside one 24-bit LSB: `
    + `max ${d24.max.toExponential(3)} (${(d24.max / LSB24).toFixed(2)} LSB) at ${d24.seconds}s, `
    + `bound ${LSB24.toExponential(3)}`);
  check(d24.rms <= .4 * LSB24, `24-bit error is quantisation noise and not an offset: `
    + `rms ${d24.rms.toExponential(3)} (${(d24.rms / LSB24).toFixed(3)} LSB), bound 0.4 LSB`);
  check(d16.max <= 6 * LSB16, `16-bit export matches inside the shaped dither's worst case of 6 LSB: `
    + `max ${d16.max.toExponential(3)} (${(d16.max / LSB16).toFixed(2)} LSB) at ${d16.seconds}s, `
    + `bound ${(6 * LSB16).toExponential(3)}`);
  check(d16.rms <= 2 * LSB16, `16-bit error is the dither's own noise: `
    + `rms ${d16.rms.toExponential(3)} (${(d16.rms / LSB16).toFixed(3)} LSB), bound 2 LSB`);

  /* ── the independent side. The last region's job, widened from its own
   * window to the whole song: same document, same mixer, same clips, one
   * render instead of two. The region cache must reproduce it FRAME FOR
   * FRAME — both are float32 written by the same writer, and rack.py renders
   * every window from absolute sample 0, so there is no rounding left to
   * excuse a difference. This is the assertion the seam lives or dies on. */
  check(jobSpy.length === 2 && jobSpy.every(j => (j.audio || []).length === 1),
    `both region jobs were captured with the clip in them (${jobSpy.length} jobs)`);
  const wide = { ...jobSpy[jobSpy.length - 1], start_sample: 0, n_samples: frames,
                 out: path.join(fixture, "one_window.wav") };
  const widePath = path.join(fixture, "one_window.job.json");
  await writeFile(widePath, JSON.stringify(wide), "utf8");
  await new Promise((resolve, reject) => {
    const proc = spawnPython([ENGINE_PY, "render", widePath]);
    let so = "", se = "";
    proc.stdout.on("data", d => { so += d; });
    proc.stderr.on("data", d => { se += d; });
    proc.on("close", (code) => code === 0 && /"ok":\s*true/.test(so)
      ? resolve() : reject(new Error(`one-window reference render failed (${code}): ${se.slice(-400)}`)));
  });
  const reference = f32(await readFile(wide.out), 44);
  check(reference.length === editor.length,
    `the one-window reference is the same length as the cache (${reference.length / 2} frames)`);
  const dRef = diff(editor, reference);
  check(dRef.max === 0, `the region cache reproduces the one-window render EXACTLY: `
    + `max ${dRef.max.toExponential(3)} at ${dRef.seconds}s (frame ${dRef.frame}) — `
    + `a non-zero value here means a region did not see what the next one contains`);
  /* Named separately so a look-ahead failure says SEAM rather than "somewhere
   * in the file": the 20 ms of region 0 that the master limiter's 10 ms of
   * look-ahead has to duck for the transient sitting in region 1. */
  const seam = regions[1].startSample;
  const dSeam = diff(editor, reference, seam - Math.round(.02 * sr), seam);
  check(dSeam.max === 0, `the 20 ms of region 0 before the seam at ${(seam / sr).toFixed(3)}s `
    + `anticipates the transient in region 1 exactly as a whole-song render does: `
    + `max ${dSeam.max.toExponential(3)} at ${dSeam.seconds}s`);

  /* ── the return. The clip stops at 5.000 s; everything after it is the
   * delay return's echoes and nothing else. If the return were dropped from
   * the sum anywhere between the rack and the delivered file, this last
   * second would be digital silence — and the 35 checks above, the ffprobe
   * duration included, would not notice. */
  const tailFrom = Math.round(5.02 * sr);
  const tailEditor = rms(editor, tailFrom, frames);
  const tail24 = rms(decode(exp24.file), tailFrom, frames);
  check(tailEditor > .01, `the effect return is audible on its own after the clip ends: `
    + `rms ${tailEditor.toExponential(3)} over 5.02–6.00 s, floor 1.0e-2`);
  check(tail24 > .01, `and it survives into the delivered 24-bit export: `
    + `rms ${tail24.toExponential(3)} over the same second`);
  check(Math.abs(tail24 - tailEditor) <= 4 * LSB24,
    `the export's return tail is the editor's, not a re-render: rms differs by `
    + `${Math.abs(tail24 - tailEditor).toExponential(3)}`);
  const sampleMs = Date.now() - tSamples;

  console.log(JSON.stringify({ ok: true, checks, fixture, sampleMs,
    samples: { frames, seam, d24, d16, dRef, dSeam, tailEditor, tail24,
               lsb24: LSB24, lsb16: LSB16 },
    flac, wav: wavOut }));
} finally {
  await new Promise(resolve => server.close(resolve));
}
