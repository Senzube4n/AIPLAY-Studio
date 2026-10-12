import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createQwenActivation, qwenActivationArgs } from "./qwen-activation.js";
import { createEngineClient } from "../engine/client.js";
import { TEXT_JUDGE_GRAPH } from "../engine/fixtures.js";
import { config as liveConfig } from "../config.js";
import { buildLaunchArgs } from "../comfyargs.js";

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiplay-qwen-activation-"));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    await fs.rm(root, { recursive: true, force: true });
  });
  const oldRig = path.join(root, "old"), newRig = path.join(root, "candidate");
  const settingsFile = path.join(root, "data", "settings.json");
  await fs.mkdir(path.dirname(settingsFile), { recursive: true });
  await fs.mkdir(path.join(newRig, "ComfyUI"), { recursive: true });
  const python = path.join(newRig, "python");
  await fs.writeFile(python, "test interpreter");
  await fs.writeFile(path.join(newRig, "ComfyUI", "main.py"), "# test engine");
  const initial = {
    rig: oldRig, python: path.join(oldRig, "python"), torchBackend: "cuda", torchVersion: "old-torch",
    gpu: { vendor: "nvidia", totalMb: 8192 }, comfyExtraArgs: ["--extra-model-paths-config", "external.yaml", "--use-pytorch-cross-attention"],
    launchFrom: "Original engine", engineInstall: { comfy: "v0.36.0" },
    ...(options.useInstallFlags === false ? { comfyUseInstallFlags: false } : {}),
    volume: 0.5, unfamiliarPreference: { retain: true },
  };
  await fs.writeFile(settingsFile, JSON.stringify(initial));
  const cfg = {
    ...initial, comfyDir: path.join(oldRig, "ComfyUI"), settingsFile,
    modelsAlso: [path.join(root, "other-models")],
    outputDir: path.join(oldRig, "ComfyUI", "output"), inputDir: path.join(oldRig, "ComfyUI", "input"),
    comfy: { extraArgs: [...initial.comfyExtraArgs], useInstallFlags: options.useInstallFlags !== false },
    get modelsDir() { return path.join(this.rig, "ComfyUI", "models"); },
  };
  const originalModelsDescriptor = Object.getOwnPropertyDescriptor(cfg, "modelsDir");
  const calls = [];
  let paused = false;
  const engine = {
    pauseSubmissions(label) {
      if (paused) throw Object.assign(new Error("already paused"), { code: "QWEN_ENGINE_BUSY" });
      paused = true; calls.push(["pause", label]);
      return () => { paused = false; calls.push(["release"]); };
    },
  };
  const supervisor = {
    proc: {},
    async stop() { calls.push(["stop", cfg.rig]); this.proc = null; },
    async start() {
      calls.push(["start", cfg.rig]);
      if (cfg.rig === newRig && options.startFailure) throw new Error("candidate could not start");
      if (cfg.rig === oldRig && options.rollbackFailure) throw new Error("old engine could not start");
      this.proc = {};
      if (cfg.rig === newRig && options.onCandidateStart) await options.onCandidateStart({ cfg, settingsFile, initial });
    },
  };
  const metadata = {
    rig: newRig, python, backend: options.backend || "nvidia", comfy: "v0.37.0", torch: "new-torch",
    torchBackend: options.backend === "cpu" ? "cpu" : "cuda",
    gpu: options.backend === "cpu" ? { vendor: "cpu", name: "CPU only" } : initial.gpu,
    comfyExtraArgs: options.backend === "cpu" ? ["--cpu"] : [],
    launchFrom: "Qwen repair", engineInstall: { backend: options.backend || "nvidia", comfy: "v0.37.0" },
    stageOnly: true, qwenNodes: ["TextEncodeQwenImage21"],
  };
  const readiness = options.readiness || (async () => {
    calls.push(["verify", cfg.rig]);
    assert.equal(cfg.rig, newRig);
    assert.equal(JSON.parse(await fs.readFile(settingsFile, "utf8")).rig, oldRig, "candidate stays unselected on disk until verified");
    assert.equal(paused, true);
    return { runtimeReady: true, filesReady: false };
  });
  const activation = createQwenActivation({ config: cfg, supervisor, engine, readiness,
    busy: options.busy, fs: options.fs || fs });
  return { root, cfg, supervisor, metadata, initial, originalModelsDescriptor, calls, activation,
    settingsFile, oldRig, newRig, engine, paused: () => paused,
    saved: async () => JSON.parse(await fs.readFile(settingsFile, "utf8")) };
}

test("successful switch pins original folders, preserves extra shelves and commits only verified runtime", async (t) => {
  const f = await fixture(t);
  const beforeModels = f.cfg.modelsDir;
  const beforeOutput = f.cfg.outputDir, beforeInput = f.cfg.inputDir;
  const result = await f.activation.activate(f.metadata);
  assert.equal(result.runtimeReady, true);
  assert.equal(f.cfg.rig, f.newRig);
  assert.equal(f.cfg.modelsDir, beforeModels);
  assert.equal(f.cfg.outputDir, beforeOutput);
  assert.equal(f.cfg.inputDir, beforeInput);
  assert.ok(f.cfg.modelsAlso.includes(path.join(f.root, "other-models")));
  assert.equal(f.cfg.comfy.extraArgs[1], path.join(f.oldRig, "ComfyUI", "external.yaml"));
  const saved = await f.saved();
  assert.equal(saved.rig, f.newRig);
  assert.equal(saved.modelsDir, beforeModels);
  assert.equal(saved.modelsDirPinned, true);
  assert.deepEqual(saved.unfamiliarPreference, f.initial.unfamiliarPreference);
  assert.equal(saved.previousEngine.rig, f.oldRig);
  assert.equal(f.paused(), false);
  await assert.rejects(fs.stat(path.join(path.dirname(f.settingsFile), "qwen-activation.json")), { code: "ENOENT" });
});

for (const [label, options] of [
  ["start failure", { startFailure: true }],
  ["missing native Qwen node", { readiness: async () => ({ runtimeReady: false, missingNodes: ["TextEncodeQwenImage21"] }) }],
  ["readiness exception", { readiness: async () => { throw new Error("engine did not answer"); } }],
]) {
  test(`${label} restores original engine and exact getter without changing settings`, async (t) => {
    const f = await fixture(t, options);
    const before = await fs.readFile(f.settingsFile, "utf8");
    await assert.rejects(f.activation.activate(f.metadata), (error) => error.code === "QWEN_ACTIVATION_FAILED" && error.rolledBack === true);
    assert.equal(f.cfg.rig, f.oldRig);
    assert.deepEqual(Object.getOwnPropertyDescriptor(f.cfg, "modelsDir"), f.originalModelsDescriptor);
    assert.deepEqual(f.cfg.comfy.extraArgs, f.initial.comfyExtraArgs);
    assert.equal(await fs.readFile(f.settingsFile, "utf8"), before);
    assert.deepEqual(f.calls.filter(([kind]) => kind === "start").map(([, rig]) => rig), [f.newRig, f.oldRig]);
    assert.equal(f.paused(), false);
  });
}

test("settings replacement failure rolls back without leaving temporary files", async (t) => {
  const wrappedFs = { ...fs, rename: async (from, to) => {
    if (path.basename(to) === "settings.json") throw Object.assign(new Error("settings are read only"), { code: "EACCES" });
    return fs.rename(from, to);
  } };
  const f = await fixture(t, { fs: wrappedFs });
  await assert.rejects(f.activation.activate(f.metadata), /previous engine was restored/);
  assert.equal((await f.saved()).rig, f.oldRig);
  assert.equal(f.cfg.rig, f.oldRig);
  assert.ok((await fs.readdir(path.dirname(f.settingsFile))).every((name) => !name.endsWith(".tmp")));
});

for (const value of ["{bad json", "[]", "null", '"text"']) {
  test(`unreadable settings ${value} cannot stop the engine or overwrite the file`, async (t) => {
    const f = await fixture(t);
    await fs.writeFile(f.settingsFile, value);
    await assert.rejects(f.activation.activate(f.metadata), { code: "QWEN_SETTINGS_UNREADABLE" });
    assert.equal(await fs.readFile(f.settingsFile, "utf8"), value);
    assert.equal(f.calls.some(([kind]) => kind === "stop"), false);
    assert.equal(f.paused(), false);
  });
}

test("work queued during preparation prevents stopping the original engine", async (t) => {
  let checks = 0;
  const f = await fixture(t, { busy: async () => ++checks === 2 ? "A render is queued. Try again after it finishes." : false });
  await assert.rejects(f.activation.activate(f.metadata), { code: "QWEN_ENGINE_BUSY" });
  assert.equal(f.calls.some(([kind]) => kind === "stop"), false);
  assert.equal((await f.saved()).rig, f.oldRig);
  assert.equal(f.paused(), false);
});

test("concurrent unrelated preferences are preserved by a fresh settings read", async (t) => {
  const f = await fixture(t, { onCandidateStart: async ({ settingsFile, initial }) => {
    await fs.writeFile(settingsFile, JSON.stringify({ ...initial, volume: 0.9, newPreference: true }));
  } });
  await f.activation.activate(f.metadata);
  const saved = await f.saved();
  assert.equal(saved.volume, 0.9);
  assert.equal(saved.newPreference, true);
});

test("concurrent engine selection refuses the switch without overwriting that selection", async (t) => {
  const f = await fixture(t, { onCandidateStart: async ({ settingsFile, initial }) => {
    await fs.writeFile(settingsFile, JSON.stringify({ ...initial, python: "user-picked-interpreter" }));
  } });
  await assert.rejects(f.activation.activate(f.metadata), /settings changed during repair/);
  assert.equal((await f.saved()).python, "user-picked-interpreter");
  assert.equal(f.cfg.rig, f.oldRig);
});

test("failed rollback keeps a concrete recovery record and releases the gate", async (t) => {
  const f = await fixture(t, { startFailure: true, rollbackFailure: true });
  await assert.rejects(f.activation.activate(f.metadata), (error) => error.code === "QWEN_ROLLBACK_FAILED" && error.rolledBack === false);
  const journal = JSON.parse(await fs.readFile(path.join(path.dirname(f.settingsFile), "qwen-activation.json"), "utf8"));
  assert.equal(journal.state, "rollback-failed");
  assert.equal(journal.previousEngine.rig, f.oldRig);
  assert.equal((await f.saved()).rig, f.oldRig);
  assert.equal(f.cfg.rig, f.oldRig);
  assert.equal(f.paused(), false);
});

test("CPU candidate includes its CPU flag and keeps configured model YAML", async (t) => {
  const f = await fixture(t, { backend: "cpu" });
  await f.activation.activate(f.metadata);
  assert.ok(f.cfg.comfy.extraArgs.includes("--cpu"));
  assert.equal(f.cfg.torchBackend, "cpu");
  assert.ok(f.cfg.comfy.extraArgs.includes(path.join(f.oldRig, "ComfyUI", "external.yaml")));
});

test("CPU switch enables required candidate flags without enabling previously ignored flags", async (t) => {
  const f = await fixture(t, { backend: "cpu", useInstallFlags: false });
  await f.activation.activate(f.metadata);
  assert.equal(f.cfg.comfy.useInstallFlags, true);
  assert.deepEqual(f.cfg.comfy.extraArgs, ["--cpu"]);
  assert.deepEqual(buildLaunchArgs({ tierFlags: ["--lowvram"], installFlags: f.cfg.comfy.extraArgs, useInstallFlags: f.cfg.comfy.useInstallFlags }), ["--cpu"]);
  const saved = await f.saved();
  assert.equal(saved.comfyUseInstallFlags, true);
  assert.deepEqual(saved.comfyExtraArgs, ["--cpu"]);
  assert.equal(saved.previousEngine.comfyUseInstallFlags, false);
  assert.deepEqual(saved.previousEngine.comfyExtraArgs, f.initial.comfyExtraArgs);
  assert.deepEqual(saved.unfamiliarPreference, f.initial.unfamiliarPreference);
});

test("failed CPU switch restores previously disabled install flags and original settings", async (t) => {
  const f = await fixture(t, { backend: "cpu", useInstallFlags: false, startFailure: true });
  const descriptor = Object.getOwnPropertyDescriptor(f.cfg.comfy, "useInstallFlags");
  await assert.rejects(f.activation.activate(f.metadata), { code: "QWEN_ACTIVATION_FAILED" });
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.cfg.comfy, "useInstallFlags"), descriptor);
  assert.equal(f.cfg.comfy.useInstallFlags, false);
  assert.deepEqual(f.cfg.comfy.extraArgs, f.initial.comfyExtraArgs);
  const saved = await f.saved();
  assert.equal(saved.comfyUseInstallFlags, false);
  assert.equal(saved.rig, f.oldRig);
});

test("only the assistant's finishing idle chat hold receives a bounded retry", async (t) => {
  const f = await fixture(t);
  const pause = f.engine.pauseSubmissions;
  let calls = 0;
  f.engine.pauseSubmissions = (...args) => {
    if (++calls === 1) throw Object.assign(new Error("chat is finishing"), { onlyChatHold: true, code: "QWEN_ENGINE_BUSY" });
    return pause(...args);
  };
  await f.activation.activate(f.metadata);
  assert.equal(calls, 2);
});

test("repair collision is refused before any process stop", async (t) => {
  const f = await fixture(t);
  const release = f.engine.pauseSubmissions("other operation");
  await assert.rejects(f.activation.activate(f.metadata), { code: "QWEN_ENGINE_BUSY" });
  assert.equal(f.calls.some(([kind]) => kind === "stop"), false);
  release();
});

test("old CPU argument is removed for GPU and relative YAML paths stay anchored", () => {
  const base = path.resolve("old-comfy");
  assert.deepEqual(qwenActivationArgs(["--cpu", "--extra-model-paths-config", "one.yaml", "two.yaml", "--use-pytorch-cross-attention"], [], base),
    ["--extra-model-paths-config", path.join(base, "one.yaml"), path.join(base, "two.yaml"), "--use-pytorch-cross-attention"]);
});

test("real engine client pause blocks dispatch before any filesystem, ledger or wire work", async () => {
  let work = 0;
  const client = createEngineClient({ store: { readSettings: async () => { work++; return {}; } }, fetch: async () => { work++; }, provenance: { append: async () => { work++; } } });
  const release = client.pauseSubmissions("Qwen engine repair");
  await assert.rejects(client.dispatch({ graph: TEXT_JUDGE_GRAPH, dryRun: true, via: "test" }), { code: "QWEN_ENGINE_BUSY" });
  assert.throws(() => client.hold("new render"), { code: "QWEN_ENGINE_BUSY" });
  assert.throws(() => client.pauseSubmissions("second repair"), { code: "QWEN_ENGINE_BUSY" });
  assert.equal(work, 0);
  release();
  const secondRelease = client.pauseSubmissions("another repair");
  release(); // An expired release must not release somebody else's pause.
  await assert.rejects(client.dispatch({ graph: TEXT_JUDGE_GRAPH, dryRun: true, via: "test" }), { code: "QWEN_ENGINE_BUSY" });
  secondRelease();
});

test("real engine client distinguishes finishing chat holds from other work", () => {
  const client = createEngineClient();
  const chatRelease = client.hold("a chat turn");
  assert.throws(() => client.pauseSubmissions("Qwen repair"), (error) => error.onlyChatHold === true);
  const artRelease = client.hold("a Reactive Paint look");
  assert.throws(() => client.pauseSubmissions("Qwen repair"), (error) => error.onlyChatHold === false);
  artRelease(); chatRelease();
  client.pauseSubmissions("Qwen repair")();
});

test("real engine client counts preparation before its first await to close the idle race", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "aiplay-qwen-pause-"));
  const descriptors = Object.fromEntries(["modelsDir", "modelsAlso", "comfyDir"].map((key) => [key, Object.getOwnPropertyDescriptor(liveConfig, key)]));
  for (const [key, value] of Object.entries({ modelsDir: temp, modelsAlso: [], comfyDir: temp })) {
    Object.defineProperty(liveConfig, key, { configurable: true, enumerable: true, writable: true, value });
  }
  t.after(async () => {
    for (const [key, descriptor] of Object.entries(descriptors)) Object.defineProperty(liveConfig, key, descriptor);
    assert.ok(path.resolve(temp).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    await fs.rm(temp, { recursive: true, force: true });
  });
  let finishPreparation;
  const pendingSettings = new Promise((resolve) => { finishPreparation = resolve; });
  const client = createEngineClient({ store: { readSettings: () => pendingSettings, resolveRecordFiles: async () => {} } });
  const submission = client.dispatch({ graph: TEXT_JUDGE_GRAPH, dryRun: true, via: "test" });
  assert.throws(() => client.pauseSubmissions("Qwen repair"), (error) => error.code === "QWEN_ENGINE_BUSY" && error.onlyChatHold === false);
  finishPreparation({});
  await submission;
  client.pauseSubmissions("Qwen repair")();
});
