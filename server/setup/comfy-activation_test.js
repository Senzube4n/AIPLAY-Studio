// Stable ComfyUI activation/restore, using temporary files and fake processes.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createComfyActivation } from "./qwen-activation.js";

const userArg = (args) => {
  const position = args.indexOf("--user-directory");
  return position >= 0 ? args[position + 1] : args.find((arg) => arg.startsWith("--user-directory="))?.slice("--user-directory=".length);
};

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiplay-comfy-activation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const oldRig = path.join(root, "original"), newRig = path.join(root, "latest");
  for (const rig of [oldRig, newRig]) {
    await fs.mkdir(path.join(rig, "ComfyUI"), { recursive: true });
    await fs.writeFile(path.join(rig, "python"), "fake interpreter");
    await fs.writeFile(path.join(rig, "ComfyUI", "main.py"), "# fake engine");
  }
  const settingsFile = path.join(root, "data", "settings.json");
  await fs.mkdir(path.dirname(settingsFile), { recursive: true });
  const extraArgs = ["--extra-model-paths-config", "external-models.yaml", ...(options.userArgs || [])];
  const initial = { rig: oldRig, python: path.join(oldRig, "python"), torchBackend: "cuda", torchVersion: "original-torch",
    gpu: { vendor: "nvidia", name: "fake NVIDIA" }, launchFrom: "Original managed engine",
    engineInstall: { comfy: "v0.36.0", backend: "nvidia", torch: "original-torch" },
    comfyExtraArgs: extraArgs, comfyUseInstallFlags: options.useInstallFlags !== false,
    modelsDir: path.join(root, "shared-models"), modelsAlso: [path.join(root, "extra-models")],
    inputDir: path.join(root, "kept-input"), outputDir: path.join(root, "kept-output"),
    volume: 0.4, unfamiliarPreference: { keep: "this" } };
  await fs.writeFile(settingsFile, JSON.stringify(initial));
  const cfg = { ...initial, settingsFile, comfyDir: path.join(oldRig, "ComfyUI"),
    comfy: { extraArgs: [...extraArgs], useInstallFlags: initial.comfyUseInstallFlags } };
  Object.defineProperty(cfg, "modelsDir", { configurable: true, enumerable: true, get: () => initial.modelsDir });
  const modelsDescriptor = Object.getOwnPropertyDescriptor(cfg, "modelsDir");
  const sourceUser = initial.comfyUseInstallFlags && userArg(extraArgs)
    ? path.resolve(cfg.comfyDir, userArg(extraArgs)) : path.join(cfg.comfyDir, "user");
  await fs.mkdir(path.join(sourceUser, "default", "workflows"), { recursive: true });
  await fs.writeFile(path.join(sourceUser, "default", "workflows", "kept.json"), '{"workflow":"original"}');
  await fs.writeFile(path.join(sourceUser, "comfyui.db"), "original database");
  const calls = [];
  let paused = false;
  const engine = { pauseSubmissions(label) {
    assert.equal(paused, false);
    paused = true; calls.push(["pause", label]);
    return () => { paused = false; calls.push(["release"]); };
  } };
  let f;
  const supervisor = { proc: {},
    async stop() { calls.push(["stop", cfg.rig]); this.proc = null; },
    async start() {
      calls.push(["start", cfg.rig]);
      if (options.failRig === cfg.rig) throw new Error("selected engine failed to start");
      this.proc = {};
      await options.onStart?.(f);
    },
  };
  const metadata = { stageOnly: true, rig: newRig, python: path.join(newRig, "python"), comfy: "v0.41.0",
    torch: "latest-torch", torchBackend: options.cpu ? "cpu" : "cuda", gpu: { vendor: options.cpu ? "cpu" : "nvidia" },
    comfyExtraArgs: options.cpu ? ["--cpu"] : [], launchFrom: "Latest stable engine",
    engineInstall: { comfy: "v0.41.0", backend: options.cpu ? "cpu" : "nvidia", torch: "latest-torch" } };
  const wrappedFs = { ...fs, stat: async (file) => {
    if (file === sourceUser && options.userStatFailure) throw Object.assign(new Error("user folder access denied"), { code: options.userStatFailure });
    return fs.stat(file);
  }, cp: async (from, to, flags) => {
    calls.push(["copy", from, to]);
    assert.equal(supervisor.proc, null, "copy only after the original database owner stops");
    if (options.copyFailure) throw Object.assign(new Error("user directory copy denied"), { code: "EACCES" });
    return fs.cp(from, to, flags);
  } };
  const readiness = async (candidate) => {
    calls.push(["verify", cfg.rig]);
    assert.equal(paused, true);
    return options.readiness ? options.readiness(f, candidate) : { runtimeReady: true, version: candidate.comfy?.replace(/^v/, "") };
  };
  const activation = createComfyActivation({ config: cfg, supervisor, engine, readiness, busy: options.busy, fs: wrappedFs });
  f = { root, oldRig, newRig, initial, cfg, metadata, modelsDescriptor, sourceUser, calls, supervisor, activation,
    settingsFile, options, paused: () => paused,
    saved: async () => JSON.parse(await fs.readFile(settingsFile, "utf8")),
    writeSaved: async (value) => fs.writeFile(settingsFile, JSON.stringify(value)),
  };
  return f;
}

for (const [label, options] of [
  ["unreadable default profile", { userStatFailure: "EACCES" }],
  ["missing explicitly selected profile", { userStatFailure: "ENOENT", userArgs: ["--user-directory", "chosen-user"] }],
]) {
  test(`${label} refuses the switch without dropping user data or stopping the engine`, async (t) => {
    const f = await fixture(t, options);
    const before = await fs.readFile(f.settingsFile, "utf8");
    await assert.rejects(f.activation.activate(f.metadata), /user folder could not be read/);
    assert.equal(f.calls.some(([kind]) => kind === "stop"), false);
    assert.equal(f.cfg.rig, f.oldRig);
    assert.equal(await fs.readFile(f.settingsFile, "utf8"), before);
    assert.equal(f.paused(), false);
  });
}

test("latest stage preserves shelves and I/O, copies user data after shutdown, and records recovery", async (t) => {
  const f = await fixture(t, { onStart: async ({ cfg, newRig }) => {
    if (cfg.rig === newRig) await fs.writeFile(path.join(userArg(cfg.comfy.extraArgs), "comfyui.db"), "new schema");
  } });
  const result = await f.activation.activate(f.metadata);
  assert.equal(result.ok, true);
  assert.equal(f.cfg.rig, f.newRig);
  for (const key of ["modelsDir", "inputDir", "outputDir"]) assert.equal(f.cfg[key], f.initial[key]);
  assert.deepEqual(f.cfg.modelsAlso, [...f.initial.modelsAlso, path.join(f.oldRig, "ComfyUI", "models")]);
  const copiedUser = userArg(f.cfg.comfy.extraArgs);
  assert.notEqual(copiedUser, f.sourceUser);
  assert.equal(path.dirname(copiedUser), f.newRig);
  assert.equal(await fs.readFile(path.join(copiedUser, "default", "workflows", "kept.json"), "utf8"), '{"workflow":"original"}');
  assert.equal(await fs.readFile(path.join(f.sourceUser, "comfyui.db"), "utf8"), "original database");
  const saved = await f.saved();
  assert.equal(saved.previousEngine.rig, f.oldRig);
  assert.deepEqual(saved.previousEngine.comfyExtraArgs, f.initial.comfyExtraArgs);
  assert.equal(saved.previousEngine.modelsDir, f.initial.modelsDir);
  assert.equal(saved.comfyUpdate.rig, f.newRig);
  assert.equal(saved.comfyUpdate.tag, "v0.41.0");
  assert.deepEqual(saved.unfamiliarPreference, f.initial.unfamiliarPreference);
  assert.equal(f.paused(), false);
  assert.deepEqual(f.calls.filter(([kind]) => ["stop", "copy", "start"].includes(kind)).map(([kind]) => kind), ["stop", "copy", "start"]);
});

test("CPU stage enables its required flag without enabling previously disabled arguments", async (t) => {
  const f = await fixture(t, { cpu: true, useInstallFlags: false });
  await f.activation.activate(f.metadata);
  assert.equal(f.cfg.torchBackend, "cpu");
  assert.equal(f.cfg.comfy.useInstallFlags, true);
  assert.ok(f.cfg.comfy.extraArgs.includes("--cpu"));
  assert.equal(f.cfg.comfy.extraArgs.includes("--extra-model-paths-config"), false);
  assert.equal((await f.saved()).previousEngine.comfyUseInstallFlags, false);
});

test("runtime version mismatch rolls back the process, getter and settings", async (t) => {
  const f = await fixture(t, { readiness: async () => ({ runtimeReady: false, version: "0.36.0", error: "Running version does not match the release." }) });
  const before = await fs.readFile(f.settingsFile, "utf8");
  await assert.rejects(f.activation.activate(f.metadata), (error) => error.code === "COMFY_ACTIVATION_FAILED" && error.rolledBack === true);
  assert.equal(f.cfg.rig, f.oldRig);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.cfg, "modelsDir"), f.modelsDescriptor);
  assert.equal(await fs.readFile(f.settingsFile, "utf8"), before);
  assert.deepEqual(f.calls.filter(([kind]) => kind === "start").map(([, rig]) => rig), [f.newRig, f.oldRig]);
  assert.equal(await fs.readFile(path.join(f.sourceUser, "comfyui.db"), "utf8"), "original database");
  assert.equal(f.paused(), false);
});

test("restore selects the exact saved original engine, keeps new preferences and clears update state", async (t) => {
  const f = await fixture(t, { userArgs: ["--user-directory", "profiles/custom"] });
  await f.activation.activate(f.metadata);
  const previous = (await f.saved()).previousEngine;
  f.options.readiness = async (current) => {
    const fresh = await current.saved();
    await current.writeSaved({ ...fresh, volume: 0.9, addedAfterUpdate: true });
    return { runtimeReady: true };
  };
  await f.activation.restore(previous);
  const saved = await f.saved();
  for (const key of ["rig", "python", "torchBackend", "torchVersion", "modelsDir", "inputDir", "outputDir"])
    assert.equal(f.cfg[key], previous[key], key);
  assert.deepEqual(f.cfg.modelsAlso, previous.modelsAlso);
  assert.deepEqual(f.cfg.comfy.extraArgs, previous.comfyExtraArgs);
  assert.equal(f.cfg.comfy.useInstallFlags, previous.comfyUseInstallFlags);
  assert.equal(saved.rig, f.oldRig);
  assert.equal(saved.comfyUpdate, null);
  assert.equal(saved.volume, 0.9);
  assert.equal(saved.addedAfterUpdate, true);
  assert.deepEqual(saved.unfamiliarPreference, f.initial.unfamiliarPreference);
  assert.equal(saved.previousEngine.rig, f.newRig, "the kept stage is recorded as the selection we left");
  assert.equal(await fs.readFile(path.join(f.sourceUser, "comfyui.db"), "utf8"), "original database");
  assert.equal(f.paused(), false);
});

test("failed restore returns to the current stage and leaves its settings selected", async (t) => {
  const f = await fixture(t);
  await f.activation.activate(f.metadata);
  const before = await fs.readFile(f.settingsFile, "utf8"), previous = JSON.parse(before).previousEngine;
  const stageArgs = [...f.cfg.comfy.extraArgs];
  f.options.failRig = f.oldRig;
  f.calls.length = 0;
  await assert.rejects(f.activation.restore(previous), (error) => error.code === "COMFY_ACTIVATION_FAILED" && error.rolledBack === true);
  assert.equal(f.cfg.rig, f.newRig);
  assert.deepEqual(f.cfg.comfy.extraArgs, stageArgs);
  assert.equal(await fs.readFile(f.settingsFile, "utf8"), before);
  assert.deepEqual(f.calls.filter(([kind]) => kind === "start").map(([, rig]) => rig), [f.oldRig, f.newRig]);
  assert.equal(f.paused(), false);
});

for (const blockedAt of [1, 2]) {
  test(`busy check ${blockedAt} prevents process stop and user-data copy`, async (t) => {
    let checks = 0;
    const f = await fixture(t, { busy: async () => ++checks === blockedAt ? "A render is queued." : false });
    await assert.rejects(f.activation.activate(f.metadata), { code: "COMFY_ENGINE_BUSY" });
    assert.equal(f.calls.some(([kind]) => kind === "stop" || kind === "copy"), false);
    assert.equal((await f.saved()).rig, f.oldRig);
    assert.equal(f.paused(), false);
  });
}

test("a changed saved previous selection is rejected before stopping", async (t) => {
  const f = await fixture(t);
  await f.activation.activate(f.metadata);
  const saved = await f.saved(), previous = saved.previousEngine;
  await f.writeSaved({ ...saved, previousEngine: { ...previous, torchVersion: "changed" } });
  f.calls.length = 0;
  await assert.rejects(f.activation.restore(previous), { code: "COMFY_STAGE_INVALID" });
  assert.equal(f.calls.some(([kind]) => kind === "stop"), false);
  assert.equal(f.cfg.rig, f.newRig);
  assert.equal(f.paused(), false);
});

for (const key of ["previousEngine", "comfyUpdate"]) {
  test(`a concurrent ${key} change during restore is preserved and causes rollback`, async (t) => {
    const f = await fixture(t);
    await f.activation.activate(f.metadata);
    const previous = (await f.saved()).previousEngine;
    f.options.readiness = async (current) => {
      const saved = await current.saved();
      await current.writeSaved({ ...saved, [key]: { ...saved[key], changedDuringRestore: true } });
      return { runtimeReady: true };
    };
    await assert.rejects(f.activation.restore(previous), (error) => error.code === "COMFY_ACTIVATION_FAILED" && error.rolledBack === true);
    assert.equal(f.cfg.rig, f.newRig);
    assert.equal((await f.saved())[key].changedDuringRestore, true);
    assert.equal(f.paused(), false);
  });
}

test("a saved current-engine selection different from the live engine is rejected before stopping", async (t) => {
  const f = await fixture(t);
  await f.writeSaved({ ...f.initial, python: path.join(f.root, "different-python") });
  await assert.rejects(f.activation.activate(f.metadata), { code: "COMFY_STAGE_INVALID" });
  assert.equal(f.calls.some(([kind]) => kind === "stop"), false);
  assert.equal(f.cfg.rig, f.oldRig);
});

for (const userArgs of [["--user-directory", "profiles/custom"], ["--user-directory=profiles/custom"]]) {
  test(`relative user directory ${userArgs[0]} is copied with original content untouched`, async (t) => {
    const f = await fixture(t, { userArgs });
    await f.activation.activate(f.metadata);
    const target = userArg(f.cfg.comfy.extraArgs);
    assert.notEqual(target, f.sourceUser);
    assert.equal(await fs.readFile(path.join(target, "comfyui.db"), "utf8"), "original database");
    await fs.writeFile(path.join(target, "comfyui.db"), "migrated database");
    assert.equal(await fs.readFile(path.join(f.sourceUser, "comfyui.db"), "utf8"), "original database");
    assert.deepEqual((await f.saved()).previousEngine.comfyExtraArgs, f.initial.comfyExtraArgs);
  });
}

test("user-directory copy failure restarts the original without selecting or starting the stage", async (t) => {
  const f = await fixture(t, { copyFailure: true });
  const before = await fs.readFile(f.settingsFile, "utf8");
  await assert.rejects(f.activation.activate(f.metadata), (error) => error.code === "COMFY_ACTIVATION_FAILED" && error.rolledBack === true && /copy denied/.test(error.message));
  assert.equal(f.cfg.rig, f.oldRig);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.cfg, "modelsDir"), f.modelsDescriptor);
  assert.equal(await fs.readFile(f.settingsFile, "utf8"), before);
  assert.deepEqual(f.calls.filter(([kind]) => kind === "start").map(([, rig]) => rig), [f.oldRig]);
  assert.equal(await fs.readFile(path.join(f.sourceUser, "comfyui.db"), "utf8"), "original database");
  assert.equal(f.paused(), false);
});
