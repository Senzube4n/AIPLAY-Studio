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
  YUE_GGUF_MODEL, YUE_GGUF_FILES, YUE_GGUF_VARIANTS, ggufFilesFor, YUE_GGUF_RUNTIME, YUE_GGUF_WEIGHTS, MIN_FREE_VRAM_MB,
  yueGgufStatus, validateGgufRequest, buildGgufArgs, runGgufDriver, inspectGgufWav,
  renderGgufSong, killGgufProcessTree, ggufGenerationWarnings, GGUF_DIALS,
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
const fakeStatFor = (quantization) => async (file) => {
  if (file === settings.cli) return { isFile: () => true, size: 100 };
  const found = ggufFilesFor(quantization).find((f) => path.join(settings.modelDir, f.name) === file);
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
  // A private, empty timing history: no test's render may give another test an ETA.
  return { events, settings, statFn: fakeStat, timings: { read: async () => [], add: async () => {}, seed: async () => {} },
    prov: { append: async (scope, event) => { assert.equal(scope, "library"); events.push(event); return { id: `event-${events.length}`, ...event }; } },
    runner: async (args) => { await writeFile(args[args.indexOf("--out") + 1], wav()); return {}; }, ...extra };
};
const generationConfig = { semantic: { max_tokens: 9000 } };
const vaeConfig = { sample_rate: 48000, downsampling_ratio: 1920 };
const sidecarReader = (generation = generationConfig, vae = vaeConfig, options = {}) => {
  const reads = [], closed = [], opened = [];
  const files = new Map([
    [path.join(settings.modelDir, "sidecars/yue2-generation-config.json"), generation],
    [path.join(settings.modelDir, "sidecars/yue2-vae-config.json"), vae],
  ]);
  return { reads, closed, opened, openSidecar: async (file, mode) => {
    assert.equal(mode, "r"); assert.ok(files.has(file), "only the two installed sidecars are read");
    opened.push(file);
    const value = files.get(file);
    if (value === null) throw Object.assign(new Error("missing sidecar"), { code: "ENOENT" });
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
    const first = file.endsWith("yue2-generation-config.json");
    return {
      stat: async () => ({ isFile: () => !(first && options.directory), size: first && options.reportedSize !== undefined ? options.reportedSize : bytes.length }),
      read: async (buffer, offset, length, position) => {
        reads.push({ file, length }); options.onRead?.();
        const count = Math.min(length, options.partial ?? length, Math.max(0, bytes.length - position));
        bytes.copy(buffer, offset, position, position + count);
        return { bytesRead: count };
      },
      close: async () => { closed.push(file); },
    };
  } };
};

test("native identity, source pin and no invented memory floor", () => {
  assert.equal(YUE_GGUF_MODEL, "yue2-gguf");
  assert.equal(MIN_FREE_VRAM_MB, null);
  assert.equal(killGgufProcessTree, killMeshProcessTree);
  assert.match(YUE_GGUF_RUNTIME.revision, /^[a-f0-9]{40}$/);
  assert.match(YUE_GGUF_WEIGHTS.revision, /^[a-f0-9]{40}$/);
  assert.equal(YUE_GGUF_RUNTIME.binaryAttested, false);
});

test("Q4 stays the immutable default; Q8 changes only the selected main-weight manifest", () => {
  assert.deepEqual(Object.keys(YUE_GGUF_VARIANTS), ["q4_0", "q8_0"]);
  assert.deepEqual(YUE_GGUF_VARIANTS.q8_0, { label: "Q8_0", modelFile: "yue2-3b-q8_0.gguf" });
  assert.equal(ggufFilesFor(), YUE_GGUF_FILES); assert.equal(ggufFilesFor("q4_0"), YUE_GGUF_FILES);
  const q8 = ggufFilesFor("q8_0");
  assert.equal(q8.length, 6); assert.deepEqual(q8.slice(1), YUE_GGUF_FILES.slice(1));
  assert.deepEqual(q8[0], { name: "yue2-3b-q8_0.gguf", role: "model", declaredBytes: 4264186432,
    declaredSha256: "f3a9e3b197bfd05aa4ae6ab2d4b93f6d57c8cc0ea39a4af7d151f58697c7cfb6" });
  assert.equal(q8.filter((file) => file.role === "model").length, 1);
  assert.ok(!q8.some((file) => file.name.includes("q4_0")));
  for (const value of [YUE_GGUF_VARIANTS, ...Object.values(YUE_GGUF_VARIANTS), YUE_GGUF_FILES, q8, ...q8]) {
    assert.ok(Object.isFrozen(value));
  }
});

test("selected Q8 status checks Q8 plus shared files, without requiring or falling back to Q4", async () => {
  const seen = [];
  const q8 = await yueGgufStatus({ settings, quantization: "q8_0", statFn: (file) => {
    seen.push(file); return fakeStatFor("q8_0")(file);
  } });
  assert.equal(q8.installed, true); assert.equal(q8.quantization, "q8_0");
  assert.equal(q8.modelFile, "yue2-3b-q8_0.gguf"); assert.equal(q8.weights.length, 6);
  assert.ok(q8.weights.every((file) => file.hashVerified === false));
  assert.ok(!seen.some((file) => file.endsWith("yue2-3b-q4_0.gguf")));
  const absent = await yueGgufStatus({ settings, quantization: "q8_0", statFn: fakeStat });
  assert.equal(absent.installed, false); assert.equal(absent.quantization, "q8_0");
  assert.ok(absent.why.some((reason) => reason.includes("yue2-3b-q8_0.gguf")));
  const q4 = await yueGgufStatus({ settings, statFn: fakeStat });
  assert.equal(q4.installed, true); assert.equal(q4.quantization, "q4_0");
  assert.equal(q4.modelFile, "yue2-3b-q4_0.gguf");
});

test("every incomplete or directory-valued selected Q8 manifest file refuses readiness", async () => {
  for (const file of ggufFilesFor("q8_0")) {
    for (const broken of [null, { isFile: () => true, size: file.declaredBytes - 1 }, { isFile: () => false, size: file.declaredBytes }]) {
      const result = await yueGgufStatus({ settings, quantization: "q8_0", statFn: async (target) => {
        if (target !== path.join(settings.modelDir, file.name)) return fakeStatFor("q8_0")(target);
        if (broken) return broken; throw new Error("missing");
      } });
      assert.equal(result.installed, false, file.name);
    }
  }
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
  assert.equal(status.rights.class, "yours-with-conditions"); assert.equal(status.rights.sellable, true); assert.match(status.rights.chip, /Sellable by individuals/);
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
  assert.equal(r.cot, "full"); assert.equal(r.narSteps, 32);
  // No seed asked for: a new one each time (it was 831001, the same song for the same words).
  assert.ok(Number.isSafeInteger(r.seed) && r.seed >= 0 && r.seed < 2 ** 32, String(r.seed));
  const seeds = new Set(Array.from({ length: 4 }, () => validateGgufRequest(input()).seed));
  assert.ok(seeds.size > 1, "four seedless requests all rolled the same seed");
  assert.equal(validateGgufRequest(input({ seed: 831001 })).seed, 831001);
  assert.equal(r.lyrics, "Étoiles\n星の光");
  assert.equal(r.quantization, "q4_0");
});
test("the sampler dials reach the runtime by its own names, bounded, and the planner's only when it runs", () => {
  const r = validateGgufRequest(input({ semantic_temperature: 0.8, semantic_top_p: 0.9, abc_temperature: 1.1, abc_top_p: 0.85 }));
  const args = buildGgufArgs(r, { ...settings, output: path.join(temp, "song.wav") });
  for (const value of ["semantic_temperature=0.8", "semantic_top_p=0.9", "abc_temperature=1.1", "abc_top_p=0.85"]) {
    assert.equal(args[args.indexOf(value) - 1], "--request-option", value);
  }
  const none = buildGgufArgs(validateGgufRequest(input()), { ...settings, output: path.join(temp, "song.wav") });
  assert.ok(!none.some((a) => /^(semantic|abc)_(temperature|top_p)=/.test(a)), "an unset dial keeps the vendor default");
  for (const bad of [{ semantic_temperature: -0.1 }, { semantic_temperature: 5.1 }, { semantic_top_p: 0 }, { abc_top_p: 1.5 },
    { abc_temperature: "0.7" }, { semantic_temperature: NaN }, { semantic_top_p: null }]) {
    assert.throws(() => validateGgufRequest(input(bad)), { refusal: "sampling" }, JSON.stringify(bad));
  }
  // With a supplied score, or Thinking off, the planner does not run: said, not dropped.
  assert.throws(() => validateGgufRequest(input({ abc: "X:1", abc_temperature: 0.9 })), /supplied score the planner does not run/);
  assert.throws(() => validateGgufRequest(input({ cot: "off", abc_top_p: 0.9 })), /Thinking off the planner does not run/);
  // The house ending: the door refused before anything was queued.
  for (const bad of [{ abc: "X:1", abc_temperature: 0.9 }, { cot: "off", abc_top_p: 0.9 }, { semantic_top_p: 2 }]) {
    assert.throws(() => validateGgufRequest(input(bad)), /Nothing was queued\.$/, JSON.stringify(bad));
  }
  // One list: each dial names the page field it comes from, and its bounds.
  assert.deepEqual(Object.fromEntries(Object.entries(GGUF_DIALS).map(([k, d]) => [k, d.from])),
    { semantic_temperature: "temperature", semantic_top_p: "topP", abc_temperature: "planTemperature", abc_top_p: "planTopP" });
  const sung = validateGgufRequest(input({ abc: "X:1", semantic_temperature: 0.9 }));
  assert.equal(sung.semantic_temperature, 0.9, "the performance dials still apply to a supplied score");
});

test("precision is a strict Q4/Q8 enum at request, manifest, status and direct argument boundaries", async () => {
  for (const quantization of [null, "", "q4", "q8", "Q8_0", "bf16", "fp8", "none", "__proto__", "constructor", 8, false, {}, ["q8_0"]]) {
    assert.throws(() => validateGgufRequest(input({ quantization })), { refusal: "request" });
    assert.throws(() => ggufFilesFor(quantization), { refusal: "request" });
    assert.throws(() => buildGgufArgs({ ...validateGgufRequest(input()), quantization }, { ...settings, output: "song.wav" }), { refusal: "request" });
    let checked = false;
    await assert.rejects(yueGgufStatus({ settings, quantization, statFn: () => { checked = true; } }), { refusal: "request" });
    assert.equal(checked, false);
  }
  assert.equal(validateGgufRequest(input({ quantization: undefined })).quantization, "q4_0");
  assert.equal(validateGgufRequest(input({ quantization: "q8_0" })).quantization, "q8_0");
});
test("unsupported audio/Python/duration options are refused rather than dropped", () => {
  for (const key of ["referenceAudio", "audio", "duration", "maxTokens", "modelFile", "modelDir", "offloadAr", "backend", "tags", "runner", "ar_temperature"]) {
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
test("native instrumental mode is unsupported; section tags are accepted; ABC needs explicit valid intent", () => {
  assert.throws(() => validateGgufRequest(input({ lyrics: "" })), { refusal: "request" });
  assert.throws(() => validateGgufRequest(input({ lyrics: "", allowEmptyLyrics: true })), { refusal: "request" });
  assert.throws(() => validateGgufRequest(input({ allowEmptyLyrics: true })), { refusal: "request" });
  assert.ok(validateGgufRequest(input({ lyrics: "[Verse]\nHello\n\n[Chorus]\nWorld" })));
  assert.ok(validateGgufRequest(input({ lyrics: "[Verse]\nHello", allowSectionLabels: true })));
  for (const abc of ["", "x".repeat(65537), "x\0y"]) assert.throws(() => validateGgufRequest(input({ abc })), { refusal: "request" });
  assert.throws(() => validateGgufRequest(input({ abc: "X:1\nK:C\nCDEF", cot: "off" })), { refusal: "request" });
});
test("CLI has exact native family/backend, explicit Q4, defaults, and supported controls only", () => {
  const args = buildGgufArgs(validateGgufRequest(input({ cfg_scale: 1.5, abc: "X:1", seed: 831001 })),
    { ...settings, output: path.join(temp, "song.wav"), abcFile: path.join(temp, "melody.abc") });
  assert.deepEqual(args.slice(0, 6), ["--task", "gen", "--family", "yue2", "--model", settings.modelDir]);
  for (const value of ["cuda", "yue2.model_gguf=yue2-3b-q4_0.gguf", "yue2.vae_gguf=yue2-vae-f16.gguf",
    "cot=full", "831001", "num_inference_steps=32", "cfg_scale=1.5", `abc_file=${path.join(temp, "melody.abc")}`]) assert.ok(args.includes(value), value);
  assert.equal(args[args.indexOf("--text") + 1], input().lyrics);
  assert.ok(!args.includes("--text-file")); assert.ok(!args.includes("--guidance-scale"));
  // --log streams phase timing lines (no lyrics) to stdout; never a log FILE.
  assert.ok(args.includes("--log")); assert.ok(!args.includes("--log-file"));
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
  assert.equal(result.generationLimits, null); assert.deepEqual(result.warnings, []);
  assert.equal(receipt.generationLimits, null); assert.deepEqual(receipt.warnings, []);
  assert.equal(await readFile(path.join(result.dir, "melody.abc"), "utf8"), "X:1\nK:C\nCDEF");
});

test("configured duration is captured from bounded sidecars, not desired song length", async () => {
  const reader = sidecarReader(), deps = rig(reader);
  const result = await renderGgufSong(input({ out: path.join(temp, "known-limits"), audioSeconds: 15 }), deps);
  const expected = { semanticMaxTokens: 9000, approxMaxAudioSeconds: 360, source: "installed-sidecars" };
  assert.deepEqual(result.generationLimits, expected);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(deps.events[0].data.generationLimits, expected);
  assert.equal(reader.opened.length, 2); assert.deepEqual(reader.closed, reader.opened);
  assert.ok(reader.reads.every(({ length }) => length <= 8193));
});

test("real temporary sidecar files use the bounded production reader without native runtime work", async () => {
  const modelDir = path.join(temp, "real-sidecar-models");
  await mkdir(path.join(modelDir, "sidecars"), { recursive: true });
  for (const [name, value] of [["yue2-generation-config.json", generationConfig], ["yue2-vae-config.json", vaeConfig]]) {
    const declaredBytes = YUE_GGUF_FILES.find((file) => file.name === `sidecars/${name}`).declaredBytes;
    await writeFile(path.join(modelDir, "sidecars", name), JSON.stringify(value).padEnd(declaredBytes, " "), { flag: "wx" });
  }
  const deps = rig({ settings: { ...settings, modelDir }, statFn: (file) => fakeStat(file === settings.cli
    ? file : path.join(settings.modelDir, path.relative(modelDir, file))) });
  const result = await renderGgufSong(input({ out: path.join(temp, "real-sidecar-render") }), deps);
  assert.deepEqual(result.generationLimits, { semanticMaxTokens: 9000, approxMaxAudioSeconds: 360, source: "installed-sidecars" });
  assert.deepEqual(result.warnings, []);
});

test("Q8 render selects exactly Q8 plus F16 VAE and preserves precision, limits and warnings in all receipts", async () => {
  const reader = sidecarReader({ semantic: { max_tokens: 8 } }, { sample_rate: 48000, downsampling_ratio: 48 });
  const seen = [];
  const deps = rig({ ...reader, statFn: (file) => { seen.push(file); return fakeStatFor("q8_0")(file); }, runner: async (args) => {
    assert.equal(deps.events[0].type, "delegate");
    assert.deepEqual(args.filter((arg) => arg.startsWith("yue2.model_gguf=")), ["yue2.model_gguf=yue2-3b-q8_0.gguf"]);
    assert.ok(args.includes("yue2.vae_gguf=yue2-vae-f16.gguf"));
    assert.ok(!args.includes("--log-file"));
    await writeFile(args.at(-1), wav(383)); return {};
  } });
  const result = await renderGgufSong(input({ quantization: "q8_0", out: path.join(temp, "q8-render") }), deps);
  const receipt = JSON.parse(await readFile(result.receipt, "utf8"));
  for (const evidence of [result, receipt, result.record, ...deps.events.map((event) => event.data)]) {
    assert.equal(evidence.quantization, "q8_0"); assert.equal(evidence.modelFile, "yue2-3b-q8_0.gguf");
    assert.deepEqual(evidence.generationLimits, result.generationLimits);
  }
  for (const evidence of [receipt, result.record, ...deps.events.map((event) => event.data)]) {
    assert.equal(evidence.args.quantization, "q8_0");
    assert.equal(evidence.weights[0].name, "yue2-3b-q8_0.gguf");
    assert.equal(evidence.weights[0].declaredSha256, ggufFilesFor("q8_0")[0].declaredSha256);
    assert.equal(evidence.weights[0].hashVerified, false);
    assert.ok(!evidence.weights.some((file) => file.name.includes("q4_0")));
  }
  assert.equal(result.warnings[0].code, "possible_semantic_limit");
  assert.deepEqual(receipt.warnings, result.warnings); assert.deepEqual(deps.events[1].data.warnings, result.warnings);
  assert.ok(!seen.some((file) => file.endsWith("yue2-3b-q4_0.gguf")));
});

test("missing Q8 refuses before metadata, provenance or runner even when Q4 is present", async () => {
  let read = false, spawned = false;
  const deps = rig({ openSidecar: async () => { read = true; }, runner: async () => { spawned = true; } });
  const out = path.join(temp, "missing-q8");
  await assert.rejects(renderGgufSong(input({ quantization: "q8_0", out }), deps), (error) => {
    assert.equal(error.refusal, "not-installed"); assert.equal(error.status.quantization, "q8_0");
    assert.equal(error.status.modelFile, "yue2-3b-q8_0.gguf"); return true;
  });
  assert.equal(read, false); assert.equal(spawned, false); assert.deepEqual(deps.events, []);
  await assert.rejects(readdir(out), { code: "ENOENT" });
});

test("near-limit warning is explicitly unconfirmed and identical in return, receipt and ledger", async () => {
  const reader = sidecarReader({ semantic: { max_tokens: 8 } }, { sample_rate: 48000, downsampling_ratio: 48 });
  const progress = [];
  const deps = rig({ ...reader, runner: async (args) => {
    assert.equal(reader.closed.length, 2, "metadata handles close before spawn");
    assert.deepEqual(deps.events[0].data.generationLimits,
      { semanticMaxTokens: 8, approxMaxAudioSeconds: 0.008, source: "installed-sidecars" });
    assert.ok(!args.includes("--log-file"));
    await writeFile(args.at(-1), wav(383));
    return { stdout: "[TIMING ts=20260915-120000] yue2.semantic.truncated 1\n", stderr: "untrusted phase prose" };
  } });
  const result = await renderGgufSong(input({ out: path.join(temp, "near-limit"), audioSeconds: 360,
    onProgress: (event) => progress.push(event) }), deps);
  const expected = [{ code: "possible_semantic_limit",
    message: "This take is near the configured generation limit. Check the ending and lyrics; the runtime did not confirm whether it stopped at the limit.",
    evidence: "duration_near_configured_limit", semanticMaxTokens: 8, approxMaxAudioSeconds: 0.008 }];
  assert.deepEqual(result.warnings, expected);
  const receipt = JSON.parse(await readFile(result.receipt, "utf8"));
  for (const copy of [receipt, result.record, deps.events[1].data]) {
    assert.deepEqual(copy.warnings, expected); assert.deepEqual(copy.generationLimits, result.generationLimits);
  }
  assert.ok(!Object.hasOwn(result, "lengthWarning"));
  assert.ok(!Object.hasOwn(receipt, "lengthWarning"));
  // No timing lines and no history: phases are named, the ETA and overall stay unknown.
  assert.deepEqual(progress, ["load", "verify"].map((stage) => ({ stage, fraction: null, percent: null, overall: null, etaSeconds: null })));
});

test("duration warning uses one configured semantic frame, never a fixed six-minute threshold", () => {
  const limits = { semanticMaxTokens: 9000, approxMaxAudioSeconds: 360, source: "installed-sidecars" };
  for (const seconds of [359.9986666666667, 359.96, 360, 360.04]) {
    assert.equal(ggufGenerationWarnings(seconds, limits).length, 1, String(seconds));
  }
  for (const seconds of [359.959, 360.041, 30, 0, -1, null, "360", NaN, Infinity]) {
    assert.deepEqual(ggufGenerationWarnings(seconds, limits), [], String(seconds));
  }
  const custom = { semanticMaxTokens: 100, approxMaxAudioSeconds: 2, source: "installed-sidecars" };
  assert.equal(ggufGenerationWarnings(1.999, custom).length, 1);
  assert.deepEqual(ggufGenerationWarnings(360, custom), []);
  for (const invalid of [null, {}, { ...limits, source: "guess" }, { ...limits, semanticMaxTokens: 0 },
    { ...limits, approxMaxAudioSeconds: Infinity }]) assert.deepEqual(ggufGenerationWarnings(360, invalid), []);
});

test("missing or invalid sidecars remain unknown without failing valid audio", async () => {
  const variants = [
    [null, vaeConfig], [generationConfig, null], ["{broken", vaeConfig], [[], vaeConfig],
    [{ semantic: [] }, vaeConfig], [{ semantic: { max_tokens: "9000" } }, vaeConfig],
    [{ semantic: { max_tokens: 0 } }, vaeConfig], [{ semantic: { max_tokens: -1 } }, vaeConfig],
    [{ semantic: { max_tokens: 1.5 } }, vaeConfig], [{ semantic: { max_tokens: Number.MAX_SAFE_INTEGER } }, vaeConfig],
    [generationConfig, []], [generationConfig, { sample_rate: "48000", downsampling_ratio: 1920 }],
    [generationConfig, { sample_rate: 0, downsampling_ratio: 1920 }],
    [generationConfig, { sample_rate: 192001, downsampling_ratio: 1920 }],
    [generationConfig, { sample_rate: 48000, downsampling_ratio: 0 }],
    [generationConfig, { sample_rate: 48000, downsampling_ratio: 1.5 }],
    [generationConfig, { sample_rate: 48000, downsampling_ratio: 48001 }],
    [Buffer.from([0xff, 0xfe]), vaeConfig],
  ];
  for (const [generation, vae] of variants) {
    const result = await renderGgufSong(input({ out: path.join(temp, "unknown-limits") }), rig(sidecarReader(generation, vae)));
    assert.equal(result.generationLimits, null); assert.deepEqual(result.warnings, []);
    assert.equal(result.record.generationLimits, null); assert.deepEqual(result.record.warnings, []);
  }
});

test("oversized/directory/growing sidecars cannot cause unbounded reads or metadata claims", async () => {
  const readers = [sidecarReader(" ".repeat(8193)), sidecarReader(generationConfig, vaeConfig, { directory: true }),
    sidecarReader(generationConfig, vaeConfig, { reportedSize: 1 })];
  for (const [index, reader] of readers.entries()) {
    const result = await renderGgufSong(input({ out: path.join(temp, "bounded-sidecars") }), rig(reader));
    assert.equal(result.generationLimits, null); assert.deepEqual(result.warnings, []);
    const generationReads = reader.reads.filter(({ file }) => file.endsWith("yue2-generation-config.json"));
    if (index < 2) assert.equal(generationReads.length, 0, "reject file size/type before reading");
    else assert.equal(generationReads[0].length, 2, "growth is detected within the fixed read bound");
    assert.ok(reader.reads.every(({ length }) => length <= 8193));
    assert.equal(reader.closed.length, 2);
  }
});

test("partial sidecar reads are handled and actual WAV/sidecar sample-rate mismatch suppresses inference", async () => {
  const reader = sidecarReader({ semantic: { max_tokens: 8 } }, { sample_rate: 16000, downsampling_ratio: 16 }, { partial: 3 });
  const deps = rig({ ...reader, runner: async (args) => { await writeFile(args.at(-1), wav(383)); } });
  const result = await renderGgufSong(input({ out: path.join(temp, "mismatched-rate") }), deps);
  assert.deepEqual(result.generationLimits, { semanticMaxTokens: 8, approxMaxAudioSeconds: 0.008, source: "installed-sidecars" });
  assert.equal(result.sampleRate, 48000); assert.deepEqual(result.warnings, []);
  assert.ok(reader.reads.length > 4); assert.equal(reader.closed.length, 2);
});

test("abort during bounded sidecar reads closes handles before any delegate or native work", async () => {
  const controller = new AbortController(); let spawned = false;
  const reader = sidecarReader(generationConfig, vaeConfig, { onRead: () => controller.abort() });
  const deps = rig({ ...reader, runner: async () => { spawned = true; } });
  await assert.rejects(renderGgufSong(input({ out: path.join(temp, "cancel-sidecars"), signal: controller.signal }), deps), { name: "AbortError" });
  assert.equal(spawned, false); assert.deepEqual(deps.events, []); assert.equal(reader.closed.length, 2);
});

test("metadata reads do not weaken render cancellation's owned-tree confirmation barrier", async () => {
  const controller = new AbortController(), started = deferred(), kill = deferred();
  let proc, kills = 0, settled = false;
  const deps = rig({ ...sidecarReader(), runner: runGgufDriver,
    spawnFn: () => { proc = processFake(); started.resolve(); return proc; },
    killTree: (owned) => { assert.equal(owned, proc); kills++; return kill.promise; } });
  const pending = renderGgufSong(input({ out: path.join(temp, "cancel-grace"), signal: controller.signal }), deps);
  pending.catch(() => { settled = true; });
  await started.promise; controller.abort(); proc.emit("close", 0); await tick();
  assert.equal(kills, 1); assert.equal(settled, false); kill.resolve(true);
  await assert.rejects(pending, { name: "AbortError", terminationConfirmed: true });
  assert.deepEqual(deps.events.map((event) => event.type), ["delegate"]);
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
