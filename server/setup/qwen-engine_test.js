import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createQwenEngineRunner, QWEN_SETUP_ID, QWEN_ENGINE_NODES, runQwenInstaller, validatedQwenStage } from "./qwen-engine.js";
import { QWEN_COMFY_TAG } from "./pins.js";
import { venvPython } from "./engine-packages.js";
import { STUDIO_MODULES } from "./studio-packages.js";

const pending = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const absent = () => ({ runtimeReady: false, filesReady: true, missingNodes: [...QWEN_ENGINE_NODES] });
const supported = () => ({ runtimeReady: true, filesReady: false, missingNodes: [] });
const GB = 1024 ** 3;
async function fixture(t) {
  const appData = await mkdtemp(path.join(os.tmpdir(), "aiplay-qwen-repair-"));
  t.after(() => rm(appData, { recursive: true, force: true }));
  return appData;
}
async function stage(root, backend = "nvidia", changes = {}) {
  const py = venvPython(root);
  const studioPackages = { ok: true, missing: [], checked: [...STUDIO_MODULES] };
  const metadata = {
    rig: root, python: py, backend, comfy: QWEN_COMFY_TAG, torch: "test-torch", torchBackend: backend === "cpu" ? "cpu" : "cuda",
    gpu: { vendor: backend, name: "test", totalMb: 0 }, comfyExtraArgs: backend === "cpu" ? ["--cpu"] : [],
    launchFrom: "Studio's compatible Qwen engine", stageOnly: true, qwenNodes: [...QWEN_ENGINE_NODES],
    engineInstall: { backend, comfy: QWEN_COMFY_TAG, torch: "test-torch", studioPackages, at: "2026-10-12T00:00:00Z" },
    studio: { ok: true, missing: [], warning: null }, ...changes,
  };
  await mkdir(path.dirname(py), { recursive: true });
  await mkdir(path.join(root, "ComfyUI"), { recursive: true });
  await writeFile(py, "test");
  await writeFile(path.join(root, "ComfyUI", "main.py"), "test");
  await writeFile(path.join(root, ".aiplay-engine.json"), JSON.stringify({
    complete: true, stageOnly: true, backend, comfy: QWEN_COMFY_TAG, torch: metadata.torch,
    studio: studioPackages, metadata,
  }));
  return metadata;
}
function runner(appData, extra = {}) {
  return createQwenEngineRunner({ appData, readiness: async () => absent(), vendor: () => "nvidia",
    freeBytes: async () => 100 * GB, activate: async () => {}, quickMs: 10, ...extra });
}
async function finish(r) {
  for (let tries = 0; tries < 100; tries++) {
    const s = (await r.status()).setups[0];
    if (s.job?.state !== "running") return s.job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("repair did not finish");
}

test("repair is offered only on proven missing Qwen support, and files do not define engine readiness", async (t) => {
  const appData = await fixture(t);
  let status = absent(), installs = 0;
  const r = runner(appData, { readiness: async () => status, install: async () => { installs++; } });
  let row = (await r.status()).setups[0];
  assert.equal(row.blocked, null);
  assert.equal(row.capability, "qwen-image-2.1");
  assert.equal(row.button, "Fix Qwen");
  assert.equal(row.progressOnly, true);
  assert.match(row.sizeWords, /6-15 GB download/);
  status = { runtimeReady: false, missingNodes: [], error: "offline" };
  assert.match((await r.status()).setups[0].blocked, /Start the local engine/);
  await r.run(QWEN_SETUP_ID);
  assert.equal((await finish(r)).state, "blocked");
  status = { runtimeReady: false, missingNodes: ["UnrelatedCustomNode"] };
  assert.match((await r.status()).setups[0].blocked, /other required nodes/);
  status = supported();
  assert.equal((await r.status()).setups[0].ready, true);
  await r.run(QWEN_SETUP_ID);
  assert.equal((await finish(r)).state, "ready");
  assert.equal(installs, 0);
});

test("machine overrides, remote runtime and busy rendering refuse before any installer", async (t) => {
  const appData = await fixture(t);
  let blocked = "A remote engine is selected.", busy = false, installs = 0;
  const r = runner(appData, { blockedBy: () => blocked, busy: () => busy, install: async () => { installs++; } });
  await r.run(QWEN_SETUP_ID);
  assert.equal((await finish(r)).state, "blocked");
  blocked = null; busy = true;
  await r.run(QWEN_SETUP_ID);
  assert.match((await finish(r)).message, /current render/);
  assert.equal(installs, 0);
});

test("an unknown render queue keeps its concrete refusal before install and before activation", async (t) => {
  const appData = await fixture(t);
  const reason = "Studio could not check the render queue. Try again shortly.";
  let busy = reason, installs = 0, switches = 0;
  const r = runner(appData, { busy: () => busy,
    install: async ({ root, backend }) => { installs++; busy = reason; return { ok: true, metadata: await stage(root, backend) }; },
    activate: async () => { switches++; },
  });
  assert.equal((await r.status()).setups[0].blocked, reason);
  await r.run(QWEN_SETUP_ID);
  assert.equal((await finish(r)).message, reason);
  assert.equal(installs, 0);
  busy = false;
  await r.run(QWEN_SETUP_ID);
  assert.equal((await finish(r)).error, reason);
  assert.equal(installs, 1); assert.equal(switches, 0);
});

test("a successful repair stages a separate engine and validates real runtime support", async (t) => {
  const appData = await fixture(t);
  const original = path.join(appData, "user-managed-engine");
  await mkdir(original); await writeFile(path.join(original, "keep.txt"), "untouched");
  let status = absent(), installed, activated;
  const r = runner(appData, {
    readiness: async () => status, gpuName: () => "RTX test",
    install: async (opts) => { installed = opts; return { ok: true, metadata: await stage(opts.root, opts.backend) }; },
    activate: async (metadata) => { activated = metadata; status = supported(); },
  });
  await r.run(QWEN_SETUP_ID);
  assert.equal((await finish(r)).state, "done");
  assert.equal(installed.backend, "nvidia");
  assert.equal(installed.gpuName, "RTX test");
  assert.equal(path.dirname(installed.root), path.join(appData, "engines"));
  assert.equal(activated.rig, installed.root);
  assert.equal(await readFile(path.join(original, "keep.txt"), "utf8"), "untouched");
});

test("simultaneous button and assistant requests claim one job before asynchronous reads", async (t) => {
  const appData = await fixture(t);
  const preflight = pending(), installing = pending();
  let started = 0, status = absent();
  const r = runner(appData, { readiness: async () => { await preflight.promise; return status; },
    install: async ({ root, backend }) => { started++; await installing.promise; return { ok: true, metadata: await stage(root, backend) }; },
    activate: async () => { status = supported(); },
  });
  const a = r.run(QWEN_SETUP_ID), b = r.run(QWEN_SETUP_ID);
  const first = await a, second = await b;
  assert.equal(first.startedAt, second.startedAt);
  assert.equal(second.already, true);
  preflight.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(started, 1);
  installing.resolve();
  assert.equal((await finish(r)).state, "done");
});

test("wrong stage paths, tags, missing package verification and missing nodes cannot activate", async (t) => {
  const appData = await fixture(t);
  for (const changes of [
    { rig: path.join(appData, "foreign") }, { python: process.execPath }, { comfy: "v0.36.0" },
    { stageOnly: false }, { studio: { ok: false, missing: ["scipy"] } }, { qwenNodes: [] },
    { engineInstall: { backend: "nvidia", comfy: QWEN_COMFY_TAG, torch: "test-torch", studioPackages: { ok: true, checked: [] } } },
  ]) {
    let switches = 0;
    const r = runner(appData, { install: async ({ root, backend }) => ({ ok: true, metadata: await stage(root, backend, changes) }),
      activate: async () => { switches++; } });
    await r.run(QWEN_SETUP_ID);
    assert.equal((await finish(r)).state, "failed", JSON.stringify(changes));
    assert.equal(switches, 0);
  }
});

test("readiness failures and installer rejections are captured, never reported as ready", async (t) => {
  const appData = await fixture(t);
  let r = runner(appData, { readiness: async () => { throw new Error("cannot inspect runtime"); } });
  await r.run(QWEN_SETUP_ID);
  assert.equal((await finish(r)).state, "failed");
  r = runner(appData, { install: async () => { throw new Error("network unavailable"); } });
  await r.run(QWEN_SETUP_ID);
  assert.match((await finish(r)).error, /network unavailable/);
  r = runner(appData, { install: async ({ root, backend }) => ({ ok: true, metadata: await stage(root, backend) }) });
  await r.run(QWEN_SETUP_ID);
  assert.match((await finish(r)).error, /Qwen support could not be verified/);
});

test("failed activation keeps a verified stage and retry switches it without another download", async (t) => {
  const appData = await fixture(t);
  let status = absent(), installs = 0, attempts = 0, space = 100 * GB;
  const r = runner(appData, { readiness: async () => status, freeBytes: async () => space,
    install: async ({ root, backend }) => { installs++; return { ok: true, metadata: await stage(root, backend) }; },
    activate: async () => { attempts++; if (attempts === 1) throw new Error("Startup failed; previous engine restored."); status = supported(); },
  });
  await r.run(QWEN_SETUP_ID);
  const first = await finish(r);
  assert.equal(first.state, "failed");
  assert.equal((await r.status()).setups[0].button, "Try again");
  space = GB; // Activation reuses already installed files, not another 16 GB install.
  assert.equal((await r.status()).setups[0].blocked, null);
  await r.run(QWEN_SETUP_ID);
  const second = await finish(r);
  assert.equal(second.state, "done");
  assert.equal(second.root, first.root);
  assert.equal(installs, 1);
});

test("concurrent retries wait for a failed job's final disk write and claim one fresh retry", async (t) => {
  const appData = await fixture(t);
  const failedWrite = pending(), releaseWrite = pending();
  let status = absent(), installs = 0, attempts = 0;
  const r = runner(appData, { readiness: async () => status,
    install: async ({ root, backend }) => { installs++; return { ok: true, metadata: await stage(root, backend) }; },
    activate: async () => { attempts++; if (attempts === 1) throw new Error("first startup failed"); status = supported(); },
    writeRecord: async (file, record) => {
      if (record.state === "failed") { failedWrite.resolve(); await releaseWrite.promise; }
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(record));
    },
  });
  await r.run(QWEN_SETUP_ID);
  await failedWrite.promise;
  let settled = 0;
  const a = r.run(QWEN_SETUP_ID).then((job) => { settled++; return job; });
  const b = r.run(QWEN_SETUP_ID).then((job) => { settled++; return job; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(settled, 0, "retry must wait for prior finalization instead of returning its failure");
  assert.equal(attempts, 1);
  releaseWrite.resolve();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first.startedAt, second.startedAt);
  assert.equal(second.already, true);
  assert.equal((await finish(r)).state, "done");
  assert.equal(attempts, 2); assert.equal(installs, 1);
});

test("server restart marks an interrupted job retryable and resumes only on explicit request", async (t) => {
  const appData = await fixture(t);
  const root = path.join(appData, "engines", "qwen-00000000-0000-4000-8000-000000000000");
  await stage(root);
  await mkdir(path.join(appData, "setup"));
  await writeFile(path.join(appData, "setup", "qwen-engine.json"), JSON.stringify({
    id: QWEN_SETUP_ID, state: "running", root, backend: "nvidia", installerPid: null, lines: [], startedAt: 1,
  }));
  let status = absent(), installs = 0, activations = 0;
  const r = runner(appData, { readiness: async () => status,
    install: async () => { installs++; }, activate: async () => { activations++; status = supported(); } });
  const row = (await r.status()).setups[0];
  assert.equal(row.job.state, "failed");
  assert.equal(row.job.retryable, true);
  assert.equal(installs, 0); assert.equal(activations, 0);
  assert.equal(JSON.parse(await readFile(path.join(appData, "setup", "qwen-engine.json"), "utf8")).state, "failed");
  await r.run(QWEN_SETUP_ID);
  assert.equal((await finish(r)).state, "done");
  assert.equal(installs, 0); assert.equal(activations, 1);
});

test("unfinished staged install reuses its own cache root on explicit retry", async (t) => {
  const appData = await fixture(t);
  let status = absent(), tries = 0;
  const roots = [];
  const r = runner(appData, { readiness: async () => status,
    install: async ({ root, backend }) => {
      roots.push(root); tries++;
      if (tries === 1) {
        await mkdir(root); await mkdir(`${root}-cache`);
        await writeFile(path.join(root, ".aiplay-engine.json"), JSON.stringify({ complete: false, stageOnly: true, backend }));
        return { ok: false, error: "download interrupted" };
      }
      return { ok: true, metadata: await stage(root, backend) };
    }, activate: async () => { status = supported(); },
  });
  await r.run(QWEN_SETUP_ID); assert.equal((await finish(r)).state, "failed");
  await r.run(QWEN_SETUP_ID); assert.equal((await finish(r)).state, "done");
  assert.equal(roots[0], roots[1]);
});

test("an old installer still alive cannot be run twice after a server restart", async (t) => {
  const appData = await fixture(t);
  const root = path.join(appData, "engines", "qwen-00000000-0000-4000-8000-000000000000");
  await mkdir(path.join(appData, "setup"));
  await writeFile(path.join(appData, "setup", "qwen-engine.json"), JSON.stringify({ id: QWEN_SETUP_ID, state: "running", root, installerPid: 123, lines: [] }));
  let starts = 0;
  const r = runner(appData, { isProcessAlive: () => true, install: async () => { starts++; } });
  await r.run(QWEN_SETUP_ID);
  assert.match((await finish(r)).message, /previous repair is still finishing/);
  assert.equal(starts, 0);
  assert.equal((await r.status()).setups[0].job.root, root);
});

test("a render beginning during install postpones activation and the retry keeps the download", async (t) => {
  const appData = await fixture(t);
  let busy = false, status = absent(), starts = 0, switches = 0;
  const r = runner(appData, { readiness: async () => status, busy: () => busy,
    install: async ({ root, backend }) => { starts++; const metadata = await stage(root, backend); busy = true; return { ok: true, metadata }; },
    activate: async () => { switches++; status = supported(); },
  });
  await r.run(QWEN_SETUP_ID);
  assert.equal((await finish(r)).state, "failed"); assert.equal(switches, 0);
  busy = false; await r.run(QWEN_SETUP_ID);
  assert.equal((await finish(r)).state, "done"); assert.equal(starts, 1); assert.equal(switches, 1);
});

test("temporary engine downtime during restart keeps progress visible and never offers a duplicate repair", async (t) => {
  const appData = await fixture(t);
  const restarting = pending();
  let status = absent(), checks = 0;
  const r = runner(appData, { readiness: async () => { checks++; return status; },
    install: async ({ root, backend }) => ({ ok: true, metadata: await stage(root, backend) }),
    activate: async () => { status = { runtimeReady: false, missingNodes: [] }; await restarting.promise; status = supported(); },
  });
  await r.run(QWEN_SETUP_ID);
  for (let n = 0; n < 100; n++) {
    const row = (await r.status()).setups[0];
    if (row.job.step === "activate") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const before = checks;
  const row = (await r.status()).setups[0];
  assert.equal(row.job.label, "Restarting engine");
  assert.equal(row.blocked, null);
  assert.equal(checks, before);
  restarting.resolve();
  assert.equal((await finish(r)).state, "done");
});

test("CPU repair reports CPU sizes and refuses insufficient space before download", async (t) => {
  const appData = await fixture(t);
  let starts = 0;
  const r = runner(appData, { vendor: () => "cpu", freeBytes: async () => 5 * GB, install: async () => { starts++; } });
  const row = (await r.status()).setups[0];
  assert.equal(row.diskGb, 6); assert.equal(row.downloadGb, "3-5");
  assert.match(row.blocked, /Free about 6 GB/);
  await r.run(QWEN_SETUP_ID);
  assert.equal((await finish(r)).state, "blocked");
  assert.equal(starts, 0);
});

test("staged validation requires the launch metadata recorded by the installer", async (t) => {
  const appData = await fixture(t);
  const root = path.join(appData, "engines", "qwen-00000000-0000-4000-8000-000000000000");
  const metadata = await stage(root);
  assert.equal(await validatedQwenStage(metadata, { root, appData, backend: "nvidia" }), metadata);
  assert.equal(await validatedQwenStage({ ...metadata, torchBackend: "changed" }, { root, appData, backend: "nvidia" }), null);
  await rm(metadata.python);
  assert.equal(await validatedQwenStage(metadata, { root, appData, backend: "nvidia" }), null);
});

test("installer parser separates streams, bounds giant lines and uses a staged automatic backend", async () => {
  let invocation, child;
  const lines = [], steps = [];
  const result = runQwenInstaller({ root: "C:\\stage", appData: "C:\\profile", backend: "amd", gpuName: "RX test",
    spawnImpl: (...args) => {
      invocation = args;
      child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      return child;
    }, onLine: (line) => lines.push(line), onStep: (step) => steps.push(step),
  });
  child.stdout.emit("data", '@@step {"id":"torch","n":5}\n@@do');
  child.stderr.emit("data", "warning from another stream\n" + "x".repeat(100_000));
  child.stdout.emit("data", 'ne {"rig":"C:\\\\stage"}\n');
  child.emit("close", 0);
  assert.deepEqual((await result).metadata, { rig: "C:\\stage" });
  assert.equal(steps.length, 1); assert.ok(lines.every((line) => line.length <= 600));
  assert.ok(invocation[1].includes("--qwen-compatible")); assert.ok(invocation[1].includes("--stage-only"));
  assert.equal(invocation[2].env.AIPLAY_ENGINE_DIR, "C:\\stage");
  assert.equal(invocation[2].windowsHide, true);
  assert.deepEqual(invocation[1].slice(1, 5), ["--backend", "amd", "--gpu-name", "RX test"]);
});

test("installer spawn failure, missing result and explicit error all resolve as failures", async () => {
  assert.equal((await runQwenInstaller({ spawnImpl: () => { throw new Error("ENOENT"); } })).ok, false);
  for (const output of ["", '@@error {"message":"disk full"}\n@@done {"rig":"stage"}\n']) {
    let child;
    const result = runQwenInstaller({ spawnImpl: () => {
      child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); return child;
    } });
    child.stdout.emit("data", output); child.emit("close", 0);
    assert.equal((await result).ok, false);
  }
});

test("installer results preserve Unicode profile names across buffer boundaries", async () => {
  let child;
  const result = runQwenInstaller({ spawnImpl: () => {
    child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); return child;
  } });
  const output = Buffer.from('@@done {"rig":"C:\\\\用户\\\\engine"}\n');
  const insideCharacter = output.indexOf(Buffer.from("用户")) + 1;
  child.stdout.emit("data", output.subarray(0, insideCharacter));
  child.stdout.emit("data", output.subarray(insideCharacter));
  child.stdout.emit("end"); child.emit("close", 0);
  assert.equal((await result).metadata.rig, "C:\\用户\\engine");
});
