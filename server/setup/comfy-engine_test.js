import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { COMFY_SETUP_ID, createComfyEngineRunner, runComfyInstaller, validatedComfyStage, stableComfyTag } from "./comfy-engine.js";
import { venvPython } from "./engine-packages.js";
import { STUDIO_MODULES } from "./studio-packages.js";

const GB = 1024 ** 3, TAG = "v0.38.0";
const pending = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const appData = await mkdtemp(path.join(os.tmpdir(), "aiplay-comfy-update-"));
  t.after(() => rm(appData, { recursive: true, force: true }));
  return appData;
}
async function stage(root, backend = "nvidia", tag = TAG, changes = {}) {
  const py = venvPython(root), packages = { ok: true, missing: [], checked: [...STUDIO_MODULES] };
  const metadata = { rig: root, python: py, backend, comfy: tag, torch: "test-torch",
    torchBackend: { nvidia: "cuda", amd: "rocm", intel: "xpu", cpu: "cpu" }[backend],
    gpu: { vendor: backend, name: "test GPU" }, comfyExtraArgs: backend === "cpu" ? ["--cpu"] : [],
    launchFrom: "Studio's staged ComfyUI", stageOnly: true,
    studio: { ok: true, missing: [], warning: null },
    engineInstall: { backend, comfy: tag, torch: "test-torch", studioPackages: packages, at: "2026-10-18T00:00:00Z" }, ...changes };
  await mkdir(path.dirname(py), { recursive: true }); await writeFile(py, "python fixture");
  await mkdir(path.join(root, "ComfyUI"), { recursive: true }); await writeFile(path.join(root, "ComfyUI", "main.py"), "engine fixture");
  await writeFile(path.join(root, ".aiplay-engine.json"), JSON.stringify({ complete: true, stageOnly: true,
    comfy: tag, backend, torch: metadata.torch, studio: packages, metadata }));
  return metadata;
}
function runner(appData, extra = {}) {
  return createComfyEngineRunner({ appData, target: async () => TAG, targetCached: async () => TAG,
    readiness: async () => ({ runtimeReady: true, version: "0.36.0" }), vendor: () => "nvidia",
    activate: async () => {}, freeBytes: async () => 100 * GB, quickMs: 5, ...extra });
}
async function finish(controller) {
  for (let n = 0; n < 100; n++) {
    const job = (await controller.status()).setups[0].job;
    if (job?.state !== "running") return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("update did not finish");
}

test("status polling never discovers a release, and stable targets reject branches, URLs and prereleases", async t => {
  const appData = await fixture(t); let checks = 0, installs = 0;
  const r = runner(appData, { target: async () => { checks++; return TAG; }, install: async () => { installs++; } });
  await r.status(); await r.status(COMFY_SETUP_ID); assert.equal(checks, 0); assert.equal(installs, 0);
  for (const tag of [null, "main", "v01.2.3", "v1.2.3-beta.1", "v1.2.3/path", "https://example.com/v1.2.3", "v1.2.3;echo bad"]) {
    assert.equal(stableComfyTag(tag), false);
    const bad = runner(appData, { target: async () => tag, install: async () => { installs++; } });
    await bad.run(COMFY_SETUP_ID); assert.equal((await finish(bad)).state, "failed");
  }
  assert.equal(installs, 0);
});

test("a persisted successful update is not called current when release discovery is offline", async t => {
  const appData = await fixture(t);
  await mkdir(path.join(appData, "setup"), { recursive: true });
  await writeFile(path.join(appData, "setup", `${COMFY_SETUP_ID}.json`), JSON.stringify({
    id: COMFY_SETUP_ID, state: "done", tag: "v0.41.0", backend: "nvidia", lines: [],
  }));
  let checks = 0;
  const r = runner(appData, { target: async () => { checks++; return "v0.41.0"; },
    targetCached: async () => null,
    readiness: async () => ({ runtimeReady: true, version: "0.41.0" }),
    install: async () => assert.fail("status cannot install"),
  });
  const setup = (await r.status(COMFY_SETUP_ID)).setups[0];
  assert.equal(setup.job.state, "done", "the completed installation record is retained");
  assert.equal(setup.job.tag, "v0.41.0");
  assert.equal(setup.ready, false, "a past target is not proof of the current latest release");
  assert.equal(setup.tag, null);
  assert.equal(checks, 0);
});

test("a current or newer installed stable version is a no-op, not a downgrade", async t => {
  const appData = await fixture(t);
  for (const version of ["0.38.0", "v0.39.0", "0.100.0"]) {
    const r = runner(appData, { readiness: async () => ({ runtimeReady: true, version }),
      install: async () => assert.fail("already up to date"), activate: async () => assert.fail("must not switch") });
    await r.run(COMFY_SETUP_ID); assert.equal((await finish(r)).state, "ready");
  }
});

test("each supported backend stages its selected release and preserves the old engine", async t => {
  const appData = await fixture(t), old = path.join(appData, "engine"); await mkdir(old); await writeFile(path.join(old, "keep.txt"), "original");
  for (const backend of ["nvidia", "amd", "intel", "cpu"]) {
    let installed, activated, checks = 0;
    const r = runner(appData, { vendor: () => backend, gpuName: () => "the selected card",
      readiness: async () => { checks++; return { runtimeReady: true, version: "0.36.0" }; },
      install: async options => { installed = options; return { ok: true, metadata: await stage(options.root, backend, options.tag) }; },
      activate: async metadata => { activated = metadata; } });
    await r.run(COMFY_SETUP_ID); assert.equal((await finish(r)).state, "done");
    assert.equal(installed.backend, backend); assert.equal(installed.tag, TAG); assert.equal(installed.gpuName, "the selected card");
    assert.match(path.basename(installed.root), /^comfy-/); assert.equal(path.dirname(installed.root), path.join(appData, "engines"));
    assert.equal(activated.rig, installed.root); assert.equal(await readFile(path.join(old, "keep.txt"), "utf8"), "original");
    // finish/status may inspect readiness; activation's successful return is final.
    assert.ok(checks >= 1);
  }
});

test("stage validation binds real files, marker, backend, packages and exact target", async t => {
  const appData = await fixture(t);
  for (const changes of [{ rig: path.join(appData, "foreign") }, { python: process.execPath }, { comfy: "v0.37.0" },
    { stageOnly: false }, { torchBackend: "cpu" }, { gpu: { vendor: "amd" } }, { studio: { ok: false, missing: [] } },
    { engineInstall: { backend: "nvidia", comfy: TAG, torch: "test-torch", studioPackages: { ok: true, missing: [], checked: [] } } }]) {
    const root = path.join(appData, "engines", `comfy-${randomUUID()}`), metadata = await stage(root, "nvidia", TAG, changes);
    assert.equal(await validatedComfyStage(metadata, { root, appData, backend: "nvidia", tag: TAG }), null, JSON.stringify(changes));
  }
  const root = path.join(appData, "engines", `comfy-${randomUUID()}`), metadata = await stage(root);
  assert.ok(await validatedComfyStage(metadata, { root, appData, backend: "nvidia", tag: TAG }));
  const marker = path.join(root, ".aiplay-engine.json"), mark = JSON.parse(await readFile(marker, "utf8")); mark.metadata.torch = "different";
  await writeFile(marker, JSON.stringify(mark)); assert.equal(await validatedComfyStage(metadata, { root, appData, backend: "nvidia", tag: TAG }), null);
});

test("a venv Python symlink is accepted only when its target remains inside the stage", async t => {
  const appData = await fixture(t), root = path.join(appData, "engines", `comfy-${randomUUID()}`), metadata = await stage(root);
  const python = metadata.python, internal = path.join(root, "python", "python-real"), external = path.join(appData, "outside-python");
  await mkdir(path.dirname(internal)); await writeFile(internal, "private Python"); await writeFile(external, "external Python");
  await rm(python);
  try { await symlink(internal, python, "file"); }
  catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.skip("host does not permit file symlinks"); return; } throw error; }
  assert.ok(await validatedComfyStage(metadata, { root, appData, backend: "nvidia", tag: TAG }));
  await rm(python); await symlink(external, python, "file");
  assert.equal(await validatedComfyStage(metadata, { root, appData, backend: "nvidia", tag: TAG }), null);
});

test("blocked or busy work refuses before download and is checked again before activation", async t => {
  const appData = await fixture(t); let installs = 0, activates = 0, working = "The queue is unknown.", block = null;
  const r = runner(appData, { busy: () => working, blockedBy: () => block,
    install: async ({ root, backend, tag }) => { installs++; working = true; return { ok: true, metadata: await stage(root, backend, tag) }; },
    activate: async () => { activates++; } });
  await r.run(COMFY_SETUP_ID); assert.equal((await finish(r)).message, working); assert.equal(installs, 0);
  working = false; block = "An external engine is selected.";
  await r.run(COMFY_SETUP_ID); assert.equal((await finish(r)).message, block); assert.equal(installs, 0);
  block = null; await r.run(COMFY_SETUP_ID); assert.equal((await finish(r)).state, "failed"); assert.equal(installs, 1); assert.equal(activates, 0);
});

test("a changed release invalidates a stage, then retry installs a new target in a new folder", async t => {
  const appData = await fixture(t); let tag = TAG, installs = [], activates = 0;
  const r = runner(appData, { target: async () => tag,
    install: async options => { installs.push(options); const metadata = await stage(options.root, options.backend, options.tag); tag = "v0.39.0"; return { ok: true, metadata }; },
    activate: async metadata => { activates++; assert.equal(metadata.comfy, "v0.39.0"); } });
  await r.run(COMFY_SETUP_ID); assert.match((await finish(r)).error, /different ComfyUI release/); assert.equal(activates, 0);
  await r.run(COMFY_SETUP_ID); assert.equal((await finish(r)).state, "done"); assert.equal(installs.length, 2);
  assert.notEqual(installs[0].root, installs[1].root); assert.equal(installs[1].tag, "v0.39.0");
  assert.equal(JSON.parse(await readFile(path.join(installs[0].root, ".aiplay-engine.json"), "utf8")).comfy, TAG);
});

test("a changed engine selection prevents activation without touching either engine", async t => {
  const appData = await fixture(t); let chosen = "original", activates = 0;
  const r = runner(appData, { selection: () => ({ rig: chosen, python: "python" }),
    install: async ({ root, backend, tag }) => { const metadata = await stage(root, backend, tag); chosen = "other"; return { ok: true, metadata }; },
    activate: async () => { activates++; } });
  await r.run(COMFY_SETUP_ID); assert.match((await finish(r)).error, /selected engine changed/); assert.equal(activates, 0);
});

test("failed activation reuses a verified same-target stage even when disk space becomes low", async t => {
  const appData = await fixture(t); let installs = 0, attempts = 0, bytes = 100 * GB;
  const r = runner(appData, { freeBytes: async () => bytes,
    install: async ({ root, backend, tag }) => { installs++; return { ok: true, metadata: await stage(root, backend, tag) }; },
    activate: async () => { if (++attempts === 1) throw new Error("Startup failed; previous engine restored."); } });
  await r.run(COMFY_SETUP_ID); const old = await finish(r); assert.equal(old.state, "failed");
  bytes = GB; assert.equal((await r.status()).setups[0].blocked, null);
  await r.run(COMFY_SETUP_ID); assert.equal((await finish(r)).state, "done"); assert.equal(installs, 1); assert.equal(attempts, 2);
});

test("simultaneous requests share one job and a live interrupted installer prevents another install", async t => {
  const appData = await fixture(t), wait = pending(); let installs = 0;
  const r = runner(appData, { install: async ({ root, backend, tag }) => { installs++; await wait.promise; return { ok: true, metadata: await stage(root, backend, tag) }; } });
  const [a, b] = await Promise.all([r.run(COMFY_SETUP_ID), r.run(COMFY_SETUP_ID)]);
  assert.equal(a.startedAt, b.startedAt); assert.equal(b.already, true); assert.equal(installs, 1);
  wait.resolve(); assert.equal((await finish(r)).state, "done");
  const root = path.join(appData, "engines", `comfy-${randomUUID()}`); await stage(root);
  await writeFile(path.join(appData, "setup", `${COMFY_SETUP_ID}.json`), JSON.stringify({ id: COMFY_SETUP_ID, state: "running", tag: TAG, root, backend: "nvidia", installerPid: 123, lines: [] }));
  let alive = true, activated = 0;
  const restored = runner(appData, { isProcessAlive: () => alive, install: async () => assert.fail("completed stage is reused"), activate: async () => { activated++; } });
  assert.equal((await restored.status()).setups[0].job.state, "failed"); assert.equal(activated, 0);
  await restored.run(COMFY_SETUP_ID); assert.match((await finish(restored)).message, /still finishing/);
  alive = false; await restored.run(COMFY_SETUP_ID); assert.equal((await finish(restored)).state, "done"); assert.equal(activated, 1);
});

test("failure to persist the staging intent prevents any installer", async t => {
  const appData = await fixture(t);
  const r = runner(appData, { writeRecord: async () => { throw new Error("disk is read-only"); }, install: async () => assert.fail("no persisted intent") });
  await r.run(COMFY_SETUP_ID); assert.match((await finish(r)).error, /read-only/);
});

test("Comfy installer reuses bounded protocol parsing and supplies only its stable-stage arguments", async () => {
  let called = 0, child, args, options;
  const spawnImpl = (_exe, argv, opts) => { called++; args = argv; options = opts; child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    queueMicrotask(() => { child.stdout.emit("data", Buffer.from('@@step {"id":"comfy","n":3}\n@@do')); child.stdout.emit("data", Buffer.from('ne {"comfy":"v0.38.0"}')); child.emit("close", 0); }); return child; };
  const result = await runComfyInstaller({ root: "/stage", appData: "/data", tag: TAG, backend: "cpu", spawnImpl });
  assert.equal(result.ok, true); assert.equal(result.metadata.comfy, TAG);
  assert.deepEqual(args.slice(-3), ["--stage-only", "--comfy-tag", TAG]); assert.equal(args.includes("--qwen-compatible"), false);
  assert.equal(options.env.AIPLAY_ENGINE_DIR, "/stage"); assert.equal(options.windowsHide, true);
  assert.equal((await runComfyInstaller({ tag: "main", spawnImpl })).ok, false); assert.equal(called, 1);
  const failed = await runComfyInstaller({ root: "/stage", appData: "/data", tag: TAG, backend: "cpu", spawnImpl: () => { throw new Error("spawn denied"); } });
  assert.equal(failed.ok, false); assert.match(failed.error, /spawn denied/);
});
