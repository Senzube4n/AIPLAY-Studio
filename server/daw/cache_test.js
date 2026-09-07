/** Cache integrity and concurrent renders through the actual DAW routes.
 * A fake subprocess writes deterministic float32 WAV fixtures; no Python,
 * sound engine, providers or existing projects are used. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const OUT = await mkdtemp(path.join(os.tmpdir(), "daw-cache-test-"));
process.env.AIPLAY_OUTPUT = OUT;
process.env.AIPLAY_APPDATA = path.join(OUT, "appdata");
process.env.AIPLAY_DAW_NO_SERVE = "1";
const store = await import("./store.js");
const { createDawRoutes } = await import("./routes.js");
assert.ok(store.DAW_DIR().startsWith(OUT + path.sep));

function wav(n, sr, channels) {
  const bytes = n * channels * 4;
  const b = Buffer.alloc(44 + bytes);
  b.write("RIFF", 0); b.writeUInt32LE(36 + bytes, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * channels * 4, 28);
  b.writeUInt16LE(channels * 4, 32); b.writeUInt16LE(32, 34);
  b.write("data", 36); b.writeUInt32LE(bytes, 40);
  return b;
}

let calls = 0, corruptNext = false, failNext = false;
const paths = [];
function spawnPython(args) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
  proc.kill = () => {};
  setImmediate(async () => {
    try {
      assert.equal(args[1], "render");
      const job = JSON.parse(await readFile(args[2], "utf8"));
      calls++; paths.push(job.out);
      const data = wav(job.n_samples, job.sr, job.mixer ? 2 : 1);
      const corrupt = corruptNext, fail = failNext;
      corruptNext = false; failNext = false;
      await writeFile(job.out, corrupt || fail ? data.subarray(0, 64) : data);
      // Keep the job in flight long enough for a second route to reach it.
      await new Promise((resolve) => setTimeout(resolve, 35));
      proc.stdout.emit("data", JSON.stringify(fail
        ? { ok: false, error: "fixture render failed" }
        : { ok: true, ms: 35, n_samples: job.n_samples }) + "\n");
      proc.emit("close", fail ? 1 : 0);
    } catch (err) { proc.emit("error", err); }
  });
  return proc;
}

const handle = createDawRoutes({
  config: { outputDir: OUT, python: "unused-fixture-python" }, spawnPython,
  readBody: async (req) => req.body,
  json: (res, code, body) => { res.code = code; res.body = body; },
});
async function post(body) {
  const res = {};
  await handle({ method: "POST", body, headers: {} }, res, new URL("http://daw.test/api/daw"));
  return res;
}

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok    ${name}`); }
  catch (err) { failures.push(name); console.error(`  FAIL  ${name}: ${err.message}`); }
}

try {
  const doc = await store.createProject("cache fixtures", { lengthBars: 1 });
  const slug = doc.slug, dir = store.cacheDir(slug);
  await mkdir(dir, { recursive: true });
  const r = store.regionsOf(doc)[0];
  const file = path.join(dir, `reg0_${store.regionHashes(doc)[0]}.wav`);
  const complete = wav(r.nSamples, doc.sr, 2);
  const plan = () => post({ action: "render_plan", slug });
  const render = () => post({ action: "render", slug });

  for (const [name, bytes] of [
    ["empty cache", Buffer.alloc(0)],
    ["truncated sample data", complete.subarray(0, 64)],
    ["wrong sample rate", wav(r.nSamples, 44100, 2)],
    ["wrong duration", wav(r.nSamples - 1, doc.sr, 2)],
    ["wrong channel count", wav(r.nSamples, doc.sr, 1)],
    ["non-WAV bytes", Buffer.alloc(100)],
  ]) {
    await writeFile(file, bytes);
    await check(`plan refuses ${name}`, async () => assert.equal((await plan()).body.regions[0].cached, false));
  }
  await check("render replaces truncated audio instead of serving it", async () => {
    await writeFile(file, complete.subarray(0, 64));
    const before = calls, res = await render();
    assert.equal(res.code, 200); assert.equal(calls, before + 1);
    assert.deepEqual(await readFile(file), complete);
  });
  await check("complete cache is reused by plan and render", async () => {
    await writeFile(file, complete);
    const before = calls;
    assert.equal((await plan()).body.regions[0].cached, true);
    assert.equal((await render()).body.regions[0].cached, true);
    assert.equal(calls, before);
  });
  await check("simultaneous render and look-ahead share one render", async () => {
    await unlink(file);
    const before = calls;
    const replies = await Promise.all([render(), post({ action: "render_ahead", slug, at_seconds: 0, lead_seconds: 0 })]);
    assert.deepEqual(replies.map((x) => x.code), [200, 200]);
    assert.equal(calls, before + 1);
    assert.deepEqual(await readFile(file), complete);
  });
  await check("an incomplete engine result is not published", async () => {
    await unlink(file).catch(() => {}); corruptNext = true;
    const res = await render();
    assert.notEqual(res.code, 200);
    assert.equal((await plan()).body.regions[0].cached, false);
    assert.ok(!(await readdir(dir)).some((f) => f.includes(".tmp-")));
  });
  await check("concurrent callers share a failure and can retry", async () => {
    await unlink(file).catch(() => {}); failNext = true;
    const before = calls;
    const failed = await Promise.all([render(), render()]);
    assert.ok(failed.every((res) => res.code !== 200));
    assert.equal(calls, before + 1);
    assert.ok(!(await readdir(dir)).some((f) => f.includes(".tmp-")));
    assert.equal((await render()).code, 200);
    assert.deepEqual(await readFile(file), complete);
  });
  await check("legacy mono projects still render and reuse their cache", async () => {
    const mono = await store.updateProject(slug, (d) => { d.master.stereo = false; return d; });
    const monoFile = path.join(dir, `reg0_${store.regionHashes(mono)[0]}.wav`);
    const before = calls;
    assert.equal((await render()).code, 200);
    assert.equal(calls, before + 1);
    assert.deepEqual(await readFile(monoFile), wav(r.nSamples, doc.sr, 1));
    assert.equal((await plan()).body.regions[0].cached, true);
    assert.equal((await render()).body.regions[0].cached, true);
    assert.equal(calls, before + 1);
  });
  await check("each independent attempt uses a unique temporary path", async () => {
    assert.equal(new Set(paths).size, paths.length);
  });
} finally {
  assert.ok(OUT.startsWith(path.join(os.tmpdir(), "daw-cache-test-")));
  await rm(OUT, { recursive: true, force: true });
}
console.log(`\n  ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
