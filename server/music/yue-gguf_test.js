/** Hermetic: synthetic WAVs, fake stats/processes/ledger; no native CLI, Python, GPU, or network. */
import assert from "node:assert/strict";
import { test, after } from "node:test";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";

const tempBase = path.resolve(os.tmpdir());
const temp = await mkdtemp(path.join(tempBase, "aiplay-yue-gguf-test-"));
process.env.AIPLAY_APPDATA = path.join(temp, "appdata");
process.env.AIPLAY_RIG = path.join(temp, "rig");
const {
  YUE_GGUF_MODEL, YUE_GGUF_FILES, YUE_GGUF_RUNTIME, YUE_GGUF_WEIGHTS, MIN_FREE_VRAM_MB,
  yueGgufStatus, validateGgufRequest, buildGgufArgs, runGgufDriver, inspectGgufWav,
  renderGgufSong, killGgufProcessTree,
} = await import("./yue-gguf.js");
const { killMeshProcessTree } = await import("../mesh/runner.js");
after(async () => {
  assert.equal(path.dirname(path.resolve(temp)), tempBase);
  assert.ok(path.basename(temp).startsWith("aiplay-yue-gguf-test-"));
  await rm(temp, { recursive: true, force: true });
});
const settings = { enabled: true, cli: path.join(temp, "audio-cli.exe"), modelDir: path.join(temp, "models"), threads: 8 };
const fakeStat = async (file) => {
  if (file === settings.cli) return { isFile: () => true, size: 100 };
  const found = YUE_GGUF_FILES.find((f) => path.join(settings.modelDir, f.name) === file);
  if (!found) throw Object.assign(new Error("not found"), { code: "ENOENT" });
  return { isFile: () => true, size: found.declaredBytes };
};
const input = (extra = {}) => ({ style: "warm acoustic pop", lyrics: "We find a little light\nIn the rain", ...extra });
const wav = (frames = 8) => {
  const b = Buffer.alloc(44 + frames * 4);
  b.write("RIFF", 0); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(48000, 24); b.writeUInt32LE(192000, 28);
  b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write("data", 36);
  b.writeUInt32LE(frames * 4, 40);
  return b;
};
const fixture = async (name, content) => { const file = path.join(temp, name); await writeFile(file, content); return file; };
const processFake = () => Object.assign(new EventEmitter(), { pid: 8123, stdout: new EventEmitter(), stderr: new EventEmitter() });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const rig = (extra = {}) => {
  const events = [];
  return { events, settings, statFn: fakeStat,
    prov: { append: async (scope, event) => { assert.equal(scope, "library"); events.push(event); return { id: `event-${events.length}`, ...event }; } },
    runner: async (args) => { await writeFile(args[args.indexOf("--out") + 1], wav()); return {}; }, ...extra };
};

test("native identity, source pin and no invented memory floor", () => {
  assert.equal(YUE_GGUF_MODEL, "yue2-gguf");
  assert.equal(MIN_FREE_VRAM_MB, null);
  assert.equal(killGgufProcessTree, killMeshProcessTree);
  assert.match(YUE_GGUF_RUNTIME.revision, /^[a-f0-9]{40}$/);
  assert.match(YUE_GGUF_WEIGHTS.revision, /^[a-f0-9]{40}$/);
  assert.equal(YUE_GGUF_RUNTIME.binaryAttested, false);
});
test("status requires explicit native configuration even with complete fake files", async () => {
  const status = await yueGgufStatus({ settings: { ...settings, enabled: false }, statFn: fakeStat });
  assert.equal(status.installed, false); assert.equal(status.enabled, false);
  for (const cli of ["", "audio-cli", path.join(temp, "python.exe.py"), path.join(temp, "run.cmd")]) {
    assert.equal((await yueGgufStatus({ settings: { ...settings, cli }, statFn: fakeStat })).installed, false);
  }
});
test("full exact-size preset is installed but hashes are only declared", async () => {
  const status = await yueGgufStatus({ settings, statFn: fakeStat });
  assert.equal(status.installed, true); assert.equal(status.weights.length, 6);
  assert.ok(status.weights.every((f) => f.hashVerified === false && f.bytes === f.declaredBytes));
  assert.equal(status.rights.class, "not-for-sale"); assert.equal(status.rights.sellable, false);
  assert.ok(status.weights.filter((f) => f.gitBlob).every((f) => !f.declaredSha256));
});
test("each missing, truncated, or directory-valued preset member refuses installation", async () => {
  for (const file of YUE_GGUF_FILES) {
    const target = path.join(settings.modelDir, file.name);
    for (const broken of [null, { isFile: () => true, size: file.declaredBytes - 1 }, { isFile: () => false, size: file.declaredBytes }]) {
      const status = await yueGgufStatus({ settings, statFn: async (p) => {
        if (p !== target) return fakeStat(p);
        if (broken) return broken; throw new Error("absent");
      } });
      assert.equal(status.installed, false, file.name);
    }
  }
});
test("default status does not find real native files in isolated temporary rig", async () => {
  const status = await yueGgufStatus({ settings: { ...settings, enabled: false } });
  assert.equal(status.installed, false); assert.equal(status.cliPresent, false);
});
test("request defaults are explicit; controls preserve multiline Unicode", () => {
  const r = validateGgufRequest(input({ lyrics: "Étoiles\n星の光" }));
  assert.equal(r.cot, "full"); assert.equal(r.seed, 831001); assert.equal(r.narSteps, 32);
  assert.equal(r.lyrics, "Étoiles\n星の光");
});
test("unsupported audio/Python/duration options are refused rather than dropped", () => {
  for (const key of ["referenceAudio", "audio", "duration", "maxTokens", "quantization", "offloadAr", "backend", "tags", "runner", "ar_temperature"]) {
    assert.throws(() => validateGgufRequest(input({ [key]: null })), { refusal: "unknown-option" });
  }
});
test("request bounds, flag-only lyrics and unsafe IDs are rejected", () => {
  for (const values of [{ style: "a".repeat(2001) }, { lyrics: "x".repeat(8001) }, { lyrics: "\0a" },
    { lyrics: "--version" }, { seed: -1 }, { seed: Number.MAX_SAFE_INTEGER + 1 }, { seed: 0.5 },
    { cot: "auto" }, { narSteps: 0 }, { narSteps: 257 }, { cfg_scale: Infinity }, { cfg_scale: 21 },
    { id: "../song" }, { id: "a/b" }, { id: 3 }, { timeoutMs: 0 }, { allowEmptyLyrics: "yes" }, { allowSectionLabels: 1 }]) {
    assert.throws(() => validateGgufRequest(input(values)), { refusal: "request" });
  }
});
test("native instrumental mode is unsupported; section labels and ABC need explicit valid intent", () => {
  assert.throws(() => validateGgufRequest(input({ lyrics: "" })), { refusal: "request" });
  assert.throws(() => validateGgufRequest(input({ lyrics: "", allowEmptyLyrics: true })), { refusal: "request" });
  assert.throws(() => validateGgufRequest(input({ allowEmptyLyrics: true })), { refusal: "request" });
  assert.throws(() => validateGgufRequest(input({ lyrics: "[Verse]\nHello" })), { refusal: "lyrics" });
  assert.ok(validateGgufRequest(input({ lyrics: "[Verse]\nHello", allowSectionLabels: true })));
  for (const abc of ["", "x".repeat(65537), "x\0y"]) assert.throws(() => validateGgufRequest(input({ abc })), { refusal: "request" });
  assert.throws(() => validateGgufRequest(input({ abc: "X:1\nK:C\nCDEF", cot: "off" })), { refusal: "request" });
});
test("CLI has exact native family/backend, explicit Q4, defaults, and supported controls only", () => {
  const args = buildGgufArgs(validateGgufRequest(input({ cfg_scale: 1.5, abc: "X:1" })),
    { ...settings, output: path.join(temp, "song.wav"), abcFile: path.join(temp, "melody.abc") });
  assert.deepEqual(args.slice(0, 6), ["--task", "gen", "--family", "yue2", "--model", settings.modelDir]);
  for (const value of ["cuda", "yue2.model_gguf=yue2-3b-q4_0.gguf", "yue2.vae_gguf=yue2-vae-f16.gguf",
    "cot=full", "831001", "num_inference_steps=32", "cfg_scale=1.5", `abc_file=${path.join(temp, "melody.abc")}`]) assert.ok(args.includes(value), value);
  assert.equal(args[args.indexOf("--text") + 1], input().lyrics);
  assert.ok(!args.includes("--text-file")); assert.ok(!args.includes("--guidance-scale"));
});
test("serialized command bound counts quotes/backslashes and configured paths", () => {
  assert.throws(() => buildGgufArgs(validateGgufRequest(input()), { ...settings,
    output: "x".repeat(13000) }), { refusal: "request" });
});
test("driver spawns native CLI without shell and bounds both log tails", async () => {
  let proc, call;
  const result = await runGgufDriver(["--text", "$(never execute)"], { cli: settings.cli, cwd: temp,
    spawnFn: (...args) => { call = args; proc = processFake(); queueMicrotask(() => {
      proc.stdout.emit("data", "o".repeat(100000)); proc.stderr.emit("data", "e".repeat(100000)); proc.emit("close", 0);
    }); return proc; } });
  assert.equal(call[0], settings.cli); assert.equal(call[2].shell, false); assert.equal(call[2].windowsHide, true);
  assert.deepEqual(call[1], ["--text", "$(never execute)"]);
  assert.equal(result.stdout.length, 32768); assert.equal(result.stderr.length, 32768);
});
test("driver rejects spawn errors and nonzero native exit", async () => {
  await assert.rejects(runGgufDriver([], { spawnFn: () => { throw new Error("spawn blocked"); } }), /spawn blocked/);
  await assert.rejects(runGgufDriver([], { spawnFn: () => { const p = processFake();
    queueMicrotask(() => { p.stderr.emit("data", "native refused"); p.emit("close", 1); }); return p;
  } }), /native refused/);
});
test("pre-cancelled driver never spawns", async () => {
  const controller = new AbortController(); controller.abort(); let spawned = false;
  await assert.rejects(runGgufDriver([], { signal: controller.signal, spawnFn: () => { spawned = true; } }), { name: "AbortError" });
  assert.equal(spawned, false);
});
test("cancel owns exactly one tree kill and awaits confirmation despite close race", async () => {
  const controller = new AbortController(), kill = deferred(); let proc, kills = 0, settled = false;
  const promise = runGgufDriver([], { signal: controller.signal, spawnFn: () => (proc = processFake()),
    killTree: (owned) => { assert.equal(owned, proc); kills++; return kill.promise; } });
  promise.catch(() => { settled = true; });
  controller.abort(); proc.emit("close", 0); await tick();
  assert.equal(kills, 1); assert.equal(settled, false); kill.resolve(true);
  await assert.rejects(promise, { name: "AbortError", terminationConfirmed: true });
});
test("cancellation during injected spawn is caught before later work", async () => {
  const controller = new AbortController(); let kills = 0;
  const promise = runGgufDriver([], { signal: controller.signal, spawnFn: () => { controller.abort(); return processFake(); },
    killTree: async () => { kills++; return true; } });
  await assert.rejects(promise, { name: "AbortError" }); assert.equal(kills, 1);
});
test("timeout kills owned tree and reports unconfirmed termination without success", async () => {
  let kills = 0;
  await assert.rejects(runGgufDriver([], { timeoutMs: 5, spawnFn: processFake,
    killTree: async () => { kills++; throw new Error("kill failed"); } }), { refusal: "timeout", terminationConfirmed: false });
  assert.equal(kills, 1);
});
test("WAV duration is derived from actual PCM frames", async () => {
  const audio = await inspectGgufWav(await fixture("valid.wav", wav(480)));
  assert.equal(audio.audioSeconds, 0.01); assert.equal(audio.sampleRate, 48000); assert.equal(audio.channels, 2);
});
test("WAV parser rejects empty, truncated, wrong-format, misaligned and forged containers", async () => {
  const variants = [Buffer.alloc(0), wav(0), wav().subarray(0, 60), Buffer.from("RIFF bogus nonempty")];
  const codec = wav(); codec.writeUInt16LE(3, 20); variants.push(codec);
  const align = wav(); align.writeUInt16LE(2, 32); variants.push(align);
  const rate = wav(); rate.writeUInt32LE(0, 24); variants.push(rate);
  const end = wav(); end.writeUInt32LE(1000000, 4); variants.push(end);
  for (const [i, value] of variants.entries()) await assert.rejects(inspectGgufWav(await fixture(`invalid-${i}.wav`, value)), { refusal: "output" });
});
test("valid render awaits delegate, validates/hash/receipt then generates, without recording lyrics", async () => {
  const gate = deferred(); let spawned = false; const deps = rig();
  const append = deps.prov.append;
  deps.prov.append = async (scope, event) => { if (event.type === "delegate") await gate.promise; return append(scope, event); };
  const writeOutput = deps.runner; deps.runner = async (...args) => { spawned = true; assert.equal(deps.events[0].type, "delegate"); return writeOutput(...args); };
  const running = renderGgufSong(input({ out: path.join(temp, "renders"), actor: "agent:codex", abc: "X:1\nK:C\nCDEF", audioSeconds: 180 }), deps);
  await tick(); assert.equal(spawned, false); gate.resolve();
  const result = await running;
  assert.equal(result.ok, true); assert.equal(result.status, "completed"); assert.equal(result.record.actor, "agent:codex");
  assert.equal(result.audioSeconds, 8 / 48000); assert.notEqual(result.audioSeconds, 180);
  assert.match(result.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(deps.events.map((e) => e.type), ["delegate", "generate"]);
  assert.ok(!JSON.stringify(deps.events).includes(input().lyrics));
  const receipt = JSON.parse(await readFile(result.receipt, "utf8"));
  assert.equal(receipt.output.sha256, result.sha256); assert.equal(receipt.output.audioSeconds, result.audioSeconds);
  assert.equal(await readFile(path.join(result.dir, "melody.abc"), "utf8"), "X:1\nK:C\nCDEF");
});
test("delegate failure cannot create output directories or start rendering", async () => {
  let started = false; const out = path.join(temp, "ledger-refused");
  await assert.rejects(renderGgufSong(input({ out }), rig({ runner: async () => { started = true; },
    prov: { append: async () => { throw new Error("ledger offline"); } } })), /ledger offline/);
  assert.equal(started, false); await assert.rejects(readdir(out), { code: "ENOENT" });
});
test("abort while delegate is pending never starts native runner", async () => {
  const controller = new AbortController(), gate = deferred(); let started = false;
  const pending = renderGgufSong(input({ out: path.join(temp, "abort-before-spawn"), signal: controller.signal }), rig({
    runner: async () => { started = true; }, prov: { append: async () => gate.promise } }));
  await tick(); controller.abort(); gate.resolve({ id: "delegate" });
  await assert.rejects(pending, { name: "AbortError" }); assert.equal(started, false);
});
test("exit zero without WAV and malformed WAV never produce generate or receipt", async () => {
  for (const bad of [null, Buffer.from("not a wav")]) {
    const deps = rig({ runner: async (args) => { if (bad) await writeFile(args.at(-1), bad); } });
    let caught;
    try { await renderGgufSong(input({ out: path.join(temp, "bad-output") }), deps); } catch (error) { caught = error; }
    assert.ok(caught); assert.deepEqual(deps.events.map((e) => e.type), ["delegate"]);
    assert.ok(!(await readdir(caught.dir)).includes("receipt.json"));
  }
});
test("stale parent WAV remains untouched and cannot masquerade as fresh output", async () => {
  const parent = path.join(temp, "stale-parent"); await mkdir(parent); await writeFile(path.join(parent, "song.wav"), wav());
  await assert.rejects(renderGgufSong(input({ out: parent }), rig({ runner: async () => ({}) })));
  assert.deepEqual(await readFile(path.join(parent, "song.wav")), wav());
});
test("hash failure never records a successful generation", async () => {
  const deps = rig({ hashFile: async () => null });
  await assert.rejects(renderGgufSong(input({ out: path.join(temp, "bad-hash") }), deps), { refusal: "output" });
  assert.deepEqual(deps.events.map((e) => e.type), ["delegate"]);
});
test("generate ledger failure propagates instead of claiming successful completion", async () => {
  const deps = rig(); const append = deps.prov.append;
  deps.prov.append = async (scope, event) => { if (event.type === "generate") throw new Error("generate ledger offline"); return append(scope, event); };
  await assert.rejects(renderGgufSong(input({ out: path.join(temp, "generate-fails") }), deps), /generate ledger offline/);
});
test("render cancellation after fake output is not successful and emits no generate", async () => {
  const controller = new AbortController(), deps = rig(); const writeOutput = deps.runner;
  deps.runner = async (...args) => { await writeOutput(...args); controller.abort(); };
  await assert.rejects(renderGgufSong(input({ out: path.join(temp, "post-output-abort"), signal: controller.signal }), deps), { name: "AbortError" });
  assert.deepEqual(deps.events.map((e) => e.type), ["delegate"]);
});
test("disabled/missing runtime refuses before any provenance or runner invocation", async () => {
  const deps = rig({ settings: { ...settings, enabled: false } });
  await assert.rejects(renderGgufSong(input({ out: temp }), deps), { refusal: "disabled" }); assert.equal(deps.events.length, 0);
});
