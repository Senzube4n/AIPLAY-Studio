/** Audition cache regression: real route/store branches, fake renderer, no Python/audio playback. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { mkdtemp, mkdir, readFile, writeFile, stat, unlink, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const tempParent = path.resolve(os.tmpdir());
const scratch = path.resolve(await mkdtemp(path.join(tempParent, "aiplay-preview-key-test-")));
assert.equal(path.dirname(scratch), tempParent);
assert.match(path.basename(scratch), /^aiplay-preview-key-test-/);
for (const key of Object.keys(process.env)) if (key.startsWith("AIPLAY_")) delete process.env[key];
Object.assign(process.env, {
  AIPLAY_APPDATA: path.join(scratch, "appdata"), AIPLAY_RIG: path.join(scratch, "rig"),
  AIPLAY_OUTPUT: path.join(scratch, "output"), AIPLAY_DAW_INSTRUMENTS: path.join(scratch, "instruments"),
  AIPLAY_PYTHON: path.join(scratch, "never-spawn-python.exe"), AIPLAY_DAW_NO_SERVE: "1",
});
function owned(file) {
  const resolved = path.resolve(file), relative = path.relative(scratch, resolved);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "test file must stay inside its owned scratch directory");
  return resolved;
}
after(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(path.dirname(scratch), tempParent);
  assert.match(path.basename(scratch), /^aiplay-preview-key-test-/);
  await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
});
const { config } = await import("../config.js");
const { createDawRoutes } = await import("./routes.js");
const store = await import("./store.js");
const { previewAudioKey } = await import("./preview-key.js");
const { dawTools } = await import("../mcp-daw.js");
owned(config.outputDir);
owned(store.DAW_DIR());

const withoutOut = ({ out, ...job }) => job;
function basicJob() {
  return { sr: 48000, start_sample: 0, n_samples: 84000, instruments_dir: process.env.AIPLAY_DAW_INSTRUMENTS,
    notes: [{ inst: "pluck", params: {}, midi: 60, vel: 100, start_sample: 0, dur_samples: 12000, gain_db: 0, seed: 1 }] };
}
function fixtureWav(job) {
  const channels = job.mixer ? 2 : 1;
  assert.ok(job.n_samples > 0 && job.n_samples <= 480000, "fake renderer stays one-note bounded");
  const bytes = job.n_samples * channels * 4, wav = Buffer.alloc(44 + bytes);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + bytes, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(3, 20); wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(job.sr, 24); wav.writeUInt32LE(job.sr * channels * 4, 28);
  wav.writeUInt16LE(channels * 4, 32); wav.writeUInt16LE(32, 34); wav.write("data", 36); wav.writeUInt32LE(bytes, 40);
  // Deterministic byte fixture only; this is not a DSP or listening-quality test.
  const hash = createHash("sha256").update(JSON.stringify(withoutOut(job))).digest();
  wav.writeFloatLE(hash.readUInt32LE(0) / 0xffffffff / 4, 44);
  return wav;
}
function fixture() {
  const jobs = [];
  const handle = createDawRoutes({
    config,
    json: (res, status, body) => Object.assign(res, { status, body }),
    readBody: async (req) => req.body,
    spawnPython: (args) => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
      proc.kill = () => { throw new Error("No real process or timeout is allowed in this fixture."); };
      queueMicrotask(async () => {
        try {
          assert.equal(args[1], "render", "only a one-note fake render may be requested");
          const job = JSON.parse(await readFile(owned(args[2]), "utf8"));
          assert.equal(job.notes.length, 1);
          jobs.push(job);
          await writeFile(owned(job.out), fixtureWav(job));
          proc.stdout.emit("data", Buffer.from('{"ok":true,"ms":0}\n'));
          proc.emit("close", 0);
        } catch (error) { proc.emit("error", error); }
      });
      return proc;
    },
  });
  const post = async (body) => {
    const res = {};
    assert.equal(await handle({ method: "POST", headers: {}, body }, res, new URL("http://localhost/api/daw")), true);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    return res.body;
  };
  const getPreview = async (url) => {
    const chunks = [], res = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    res.writeHead = (status, headers) => Object.assign(res, { status, headers });
    const finished = new Promise((resolve, reject) => { res.on("finish", resolve); res.on("error", reject); });
    assert.equal(await handle({ method: "GET", headers: {} }, res, new URL(url, "http://localhost")), true);
    assert.equal(res.status, 200);
    await finished;
    assert.equal(res.headers["Content-Type"], "audio/wav");
    assert.equal(Number(res.headers["Content-Length"]), Buffer.concat(chunks).length);
    return Buffer.concat(chunks);
  };
  return { post, getPreview, jobs, async make() {
    const { slug } = await post({ action: "create", name: "cache fixture", bpm: 120, length_bars: 2 });
    const { trackId } = await post({ action: "add_track", slug, name: "pluck", instrument: "pluck" });
    return { slug, track: trackId, pitch: 60, vel: 100, dur_ticks: 480 };
  } };
}
function cacheFile(result) {
  assert.match(result.url, /^\/api\/daw\/preview\/pv_[a-z][a-z0-9_]*_v2_[a-f0-9]{24}\.wav$/);
  return owned(path.join(store.DAW_DIR(), "_previews", path.basename(result.url)));
}

test("key is a stable safe fragment; output destinations do not participate", () => {
  const job = basicJob(), before = structuredClone(job), key = previewAudioKey(job);
  assert.match(key, /^v2_[a-f0-9]{24}$/);
  assert.equal(key, previewAudioKey({ ...job, out: "../../not-a-cache-key.wav" }));
  assert.deepEqual(job, before);
});
test("canonical params/maps share keys while audible array order remains significant", () => {
  const a = basicJob(), b = basicJob();
  a.notes[0].params = { transpose: 3, gain_db: 2 };
  b.notes[0].params = { gain_db: 2, transpose: 3 };
  a.mixer = { stereo: true, inserts: [{ drive: 2 }, { gain: 3 }] };
  b.mixer = { inserts: [{ drive: 2 }, { gain: 3 }], stereo: true };
  assert.equal(previewAudioKey(a), previewAudioKey(b));
  b.mixer.inserts.reverse();
  assert.notEqual(previewAudioKey(a), previewAudioKey(b));
});
test("renderer defaults and unsigned seed normalization are stable", () => {
  const a = basicJob(), b = basicJob();
  delete a.notes[0].params; delete a.notes[0].gain_db; delete a.notes[0].seed;
  b.notes[0].gain_db = -0; b.notes[0].seed = 0;
  assert.equal(previewAudioKey(a), previewAudioKey(b));
  a.notes[0].seed = 0x100000001; b.notes[0].seed = 1;
  assert.equal(previewAudioKey(a), previewAudioKey(b));
});
test("sample rate, held/window samples, exact gain, params, seed, library and mixer invalidate", () => {
  const base = basicJob(), key = previewAudioKey(base);
  const changes = [
    j => { j.sr = 44100; }, j => { j.n_samples++; }, j => { j.notes[0].dur_samples++; },
    j => { j.notes[0].gain_db = 0.01; }, j => { j.notes[0].params.transpose = 1; },
    j => { j.notes[0].seed++; }, j => { j.instruments_dir += "/different-library"; },
    j => { j.mixer = { stereo: true }; }, j => { j.notes[0].midi++; }, j => { j.notes[0].vel--; },
  ];
  for (const change of changes) { const job = structuredClone(base); change(job); assert.notEqual(previewAudioKey(job), key); }
});
test("malformed/path-like IDs and nonfinite or oversized metadata fail bounded", () => {
  for (const change of [
    j => { j.notes = []; }, j => { j.notes.push(j.notes[0]); }, j => { j.sr = NaN; },
    j => { j.n_samples = 0; }, j => { j.start_sample = 1; }, j => { j.notes[0].dur_samples = 1.1; },
    j => { j.notes[0].inst = "../pluck"; }, j => { j.notes[0].inst = "pluck\0"; },
    j => { j.notes[0].midi = 128; }, j => { j.notes[0].vel = 0; },
    j => { j.notes[0].gain_db = "0"; }, j => { j.notes[0].params.bad = Infinity; },
    j => { j.notes[0].params.loop = j; }, j => { j.notes[0].params.huge = "a".repeat(32769); },
    j => { j.notes[0].params.huge = Array(20).fill("a".repeat(16000)); },
  ]) { const job = basicJob(); change(job); assert.throws(() => previewAudioKey(job)); }
});
test("both actual preview doors share a cache and identical effective render jobs/bytes", async () => {
  const f = fixture(), args = await f.make(), docPath = owned(path.join(store.projectDir(args.slug), "project.json"));
  const before = await readFile(docPath);
  const plain = await f.post({ action: "preview_note", ...args });
  assert.equal(plain.cached, false); assert.equal(f.jobs.length, 1);
  const voice = await f.post({ action: "voice_lab", ...args });
  assert.equal(voice.url, plain.url); assert.equal(voice.cached, true);
  const bytes = await readFile(cacheFile(plain));
  assert.deepEqual(await f.getPreview(plain.url), bytes, "unchanged audio GET serves the new opaque cache filename");
  await unlink(cacheFile(plain)); // exact, validated test-owned file only
  const forced = await f.post({ action: "voice_lab", ...args, params_override: {} });
  assert.equal(forced.cached, false); assert.equal(forced.url, plain.url);
  assert.deepEqual(withoutOut(f.jobs[0]), withoutOut(f.jobs[1]));
  assert.deepEqual(await readFile(cacheFile(forced)), bytes);
  const forwarded = await f.post({ action: "preview_note", ...args, params_override: {} });
  assert.equal(forwarded.forwarded_to, "voice_lab"); assert.equal(forwarded.cached, true);
  assert.equal(forwarded.url, plain.url);
  assert.deepEqual(await readFile(docPath), before, "audition must not change project/ledger/updatedAt");
});
for (const action of ["preview_note", "voice_lab"]) {
  test(`${action}: tempo changes sample duration, misses stale audio, then hits current cache`, async () => {
    const f = fixture(), args = await f.make();
    const first = await f.post({ action, ...args });
    await f.post({ action: "set_tempo", slug: args.slug, at_bar: 1, bpm: 60 });
    const slower = await f.post({ action, ...args });
    assert.notEqual(slower.url, first.url); assert.equal(slower.cached, false);
    assert.equal(f.jobs[0].notes[0].dur_samples, 12000); assert.equal(f.jobs[1].notes[0].dur_samples, 24000);
    assert.equal(first.seconds, 1.75); assert.equal(slower.seconds, 2);
    const wav = await readFile(cacheFile(slower));
    assert.equal(wav.readUInt32LE(40) / wav.readUInt32LE(28), slower.seconds);
    assert.equal((await f.post({ action, ...args })).cached, true); assert.equal(f.jobs.length, 2);
  });
  test(`${action}: denominator changes invalidate, equivalent effective duration reuses cache`, async () => {
    const f = fixture(), args = await f.make();
    const first = await f.post({ action, ...args });
    await f.post({ action: "set_meter", slug: args.slug, at_bar: 1, num: 7, den: 8 });
    const eighth = await f.post({ action, ...args });
    assert.notEqual(eighth.url, first.url); assert.equal(eighth.cached, false);
    assert.equal(f.jobs[1].notes[0].dur_samples, 6000);
    await f.post({ action: "set_tempo", slug: args.slug, at_bar: 1, bpm: 60 });
    const equivalent = await f.post({ action, ...args });
    assert.equal(equivalent.url, first.url); assert.equal(equivalent.cached, true);
  });
}
test("actual routes preserve exact gain and normalized params without stale collisions", async () => {
  const f = fixture(), args = await f.make();
  await f.post({ action: "set_track", slug: args.slug, track: args.track, gain_db: 0.01 });
  const a = await f.post({ action: "preview_note", ...args });
  await f.post({ action: "set_track", slug: args.slug, track: args.track, gain_db: 0.02 });
  const b = await f.post({ action: "voice_lab", ...args });
  assert.notEqual(a.url, b.url); assert.equal(b.cached, false);
  assert.equal(f.jobs[0].notes[0].gain_db, 0.01); assert.equal(f.jobs[1].notes[0].gain_db, 0.02);
  const unchanged = await f.post({ action: "voice_lab", ...args, params_override: { transpose: 0 } });
  assert.equal(unchanged.url, b.url); assert.equal(unchanged.cached, true);
  const changed = await f.post({ action: "voice_lab", ...args, params_override: { transpose: 12 } });
  assert.notEqual(changed.url, b.url); assert.equal(changed.cached, false);
  await f.post({ action: "set_track", slug: args.slug, track: args.track, params: { transpose: 12 } });
  assert.equal((await f.post({ action: "preview_note", ...args })).url, changed.url);
});
test("track-derived seeds participate and repeat visits hit the original voice", async () => {
  const f = fixture(), args = await f.make();
  const a = await f.post({ action: "preview_note", ...args });
  const { trackId } = await f.post({ action: "add_track", slug: args.slug, name: "other pluck", instrument: "pluck" });
  const b = await f.post({ action: "voice_lab", ...args, track: trackId });
  assert.notEqual(f.jobs[0].notes[0].seed, f.jobs[1].notes[0].seed);
  assert.notEqual(a.url, b.url); assert.equal(b.cached, false);
  assert.equal((await f.post({ action: "voice_lab", ...args })).cached, true);
});
test("Voice Lab stereo/own chain inputs re-key; unused chain does not invalidate dry preview", async () => {
  const f = fixture(), args = await f.make();
  const dry = await f.post({ action: "preview_note", ...args });
  const stereo = await f.post({ action: "voice_lab", ...args, stereo: true });
  assert.notEqual(stereo.url, dry.url); assert.equal(f.jobs[1].mixer.stereo, true);
  const added = await f.post({ action: "insert_add", slug: args.slug, target: args.track, type: "saturator", params: { drive_db: 4 } });
  const chain = await f.post({ action: "voice_lab", ...args, through_chain: true });
  assert.notEqual(chain.url, stereo.url); assert.equal(chain.cached, false);
  await f.post({ action: "insert_set", slug: args.slug, target: args.track, insert: added.insertId, params: { drive_db: 8 } });
  const changed = await f.post({ action: "voice_lab", ...args, through_chain: true });
  assert.notEqual(changed.url, chain.url); assert.equal(changed.cached, false);
  await f.post({ action: "mixer_set", slug: args.slug, target: args.track, fader: -3, pan: 0.2 });
  const mixed = await f.post({ action: "voice_lab", ...args, through_chain: true });
  assert.notEqual(mixed.url, changed.url);
  assert.equal((await f.post({ action: "voice_lab", ...args, through_chain: true })).cached, true);
  assert.equal((await f.post({ action: "preview_note", ...args })).url, dry.url);
  assert.equal((await f.post({ action: "voice_lab", ...args, stereo: true })).url, stereo.url);
});
test("legacy cache is left untouched and client fields cannot choose output/cache paths", async () => {
  const f = fixture(), args = await f.make(), dir = owned(path.join(store.DAW_DIR(), "_previews"));
  await mkdir(dir, { recursive: true });
  const old = owned(path.join(dir, "pv_pluck_60_100_480_0_bf21a9e8fbc5.wav")), bytes = Buffer.alloc(48, 13);
  await writeFile(old, bytes);
  const arbitrary = owned(path.join(scratch, "not-a-preview.wav"));
  const result = await f.post({ action: "preview_note", ...args, out: arbitrary, file: "../not-a-preview.wav", key: "client-chosen" });
  assert.equal(result.cached, false); cacheFile(result);
  assert.deepEqual(await readFile(old), bytes);
  await assert.rejects(stat(arbitrary), { code: "ENOENT" });
  assert.equal(f.jobs.length, 1);
});
test("MCP audition forwards into the same effective-job cache as the HTTP/UI door", async () => {
  const f = fixture(), args = await f.make();
  const tool = dawTools(async (method, url, body) => {
    assert.equal(url, "/api/daw"); assert.equal(method, "POST");
    return f.post(body);
  }, (name) => name).find(t => t.name === "daw_preview_note");
  const viaMcp = await tool.run(args), http = await f.post({ action: "preview_note", ...args });
  assert.equal(viaMcp.url, http.url); assert.equal(http.cached, true); assert.equal(f.jobs.length, 1);
});
