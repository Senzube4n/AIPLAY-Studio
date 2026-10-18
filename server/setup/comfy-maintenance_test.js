import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deployStudioNodes, deployEpoch, STUDIO_NODES_DIR, VENDORED_NODES, MARKER as STUDIO_COPY_MARKER } from "../comfy_nodes.js";
import { createComfyMaintenance, comfyUpdateEligibility } from "./comfy-maintenance.js";
import { venvPython } from "./engine-packages.js";
import { createEngineRoutes } from "../engine/routes.js";
import { engineTools } from "../mcp-engine.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-comfy-updates-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const rig = path.join(root, "engine"), comfyDir = path.join(rig, "ComfyUI"), python = venvPython(rig);
  await fs.mkdir(path.dirname(python), { recursive: true });
  await fs.mkdir(path.join(comfyDir, "custom_nodes"), { recursive: true });
  await fs.writeFile(python, "test interpreter");
  await fs.writeFile(path.join(comfyDir, "main.py"), "# test engine");
  await fs.writeFile(path.join(comfyDir, "comfyui_version.py"), '__version__ = "0.36.0"');
  await fs.writeFile(path.join(rig, ".aiplay-engine.json"), JSON.stringify({ complete: true, comfy: "v0.36.0" }));
  const config = { dataDir: root, rig, python, comfyDir, settingsFile: path.join(root, "settings.json"),
    modelsDir: path.join(root, "models"), modelsAlso: [], inputDir: path.join(root, "input"), outputDir: path.join(root, "output"),
    comfy: { checkUpdatesOnStart: true, extraArgs: [] } };
  const nodes = Object.fromEntries(["CheckpointLoaderSimple", "KSampler", "EmptyLatentImage", "VAEDecode", "SaveImage",
    "AiplaySafetyRefusal", "AiplayH3ConditioningBridge", "AiplayHintLift", "AiplayIPAdapterLoader", "AiplayIPAdapterApply",
    "AiplaySaveLossJson", "AiplayPromptSchedule", "AiplayYuE2Score", "AiplayYuE2Continue", "AiplaySparseCtrlLoader",
    "AiplaySparseCtrlApply", "AiplayControlNetLoaderSliding"].map((name) => [name, {}]));
  const state = { ready: true, version: "0.36.0" };
  const release = { ok: true, latest: { tag: "v0.41.0", url: "https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.41.0", publishedAt: "2026-10-15T22:57:45Z" }, checkedAt: 100 };
  let checks = 0, options, job = null, restored = null;
  const engine = { status: async () => state, refreshFacts: async () => state, objectInfo: async () => nodes };
  const service = createComfyMaintenance({ config, engine, supervisor: {}, env: {},
    checker: { cached: async () => release, check: async () => { checks++; return release; } },
    runnerFactory: (opts) => { options = opts; return { ids: ["comfy-update"], has: (id) => id === "comfy-update",
      status: async () => ({ setups: [{ id: "comfy-update", job }] }), run: async () => ({ state: "running" }) }; },
    activationFactory: () => ({ activate: async () => {}, restore: async (selection) => { restored = selection; return { ok: true }; } }),
  });
  return { root, config, state, nodes, release, service, options: () => options, checks: () => checks,
    job: (value) => { job = value; }, restored: () => restored };
}

test("status reads installed release and cached latest without contacting GitHub", async (t) => {
  const f = await fixture(t);
  const status = await f.service.status();
  assert.equal(status.installed, "0.36.0");
  assert.equal(status.latest.tag, "v0.41.0");
  assert.equal(status.updateAvailable, true);
  assert.equal(status.blocked, null);
  assert.equal(f.checks(), 0);
  await f.service.status({ force: true });
  assert.equal(f.checks(), 1);
});

test("startup checks are optional and skip cloud, remote and missing local installs", async (t) => {
  const f = await fixture(t);
  f.config.comfy.checkUpdatesOnStart = false;
  await f.service.start();
  assert.equal(f.checks(), 0);
  f.config.comfy.checkUpdatesOnStart = true;
  f.config.cloudOnly = true; await f.service.start();
  f.config.cloudOnly = false; f.config.remoteOnly = true; await f.service.start();
  f.config.remoteOnly = false;
  await f.service.start(); assert.equal(f.checks(), 1);
  await fs.unlink(path.join(f.config.comfyDir, "main.py"));
  await f.service.start(); assert.equal(f.checks(), 1);
});

test("completed ownership, original interpreter and no custom nodes are required", async (t) => {
  const f = await fixture(t);
  assert.equal((await comfyUpdateEligibility(f.config, {})).blocked, null);
  await fs.writeFile(path.join(f.config.comfyDir, "custom_nodes", "websocket_image_save.py"), "# standard example");
  assert.equal((await comfyUpdateEligibility(f.config, {})).blocked, null);
  await fs.mkdir(path.join(f.config.comfyDir, "custom_nodes", "my-node"));
  assert.match((await comfyUpdateEligibility(f.config, {})).blocked, /custom nodes/);
  f.config.python = path.join(f.root, "different-python");
  assert.match((await comfyUpdateEligibility(f.config, {})).blocked, /different interpreter/);
  await fs.unlink(path.join(f.config.rig, ".aiplay-engine.json"));
  const external = await comfyUpdateEligibility(f.config, {});
  assert.equal(external.managed, false);
  assert.match(external.blocked, /ComfyUI installer/);
  assert.match(external.guideUrl, /^https:\/\/docs\.comfy\.org\//);
});

test("a normal supervisor's exact Studio node deployment stays eligible without redeploying it", async t => {
  const f = await fixture(t), nodes = path.join(f.config.comfyDir, "custom_nodes");
  const deployed = deployStudioNodes(nodes);
  assert.ok(deployed.copied.some(name => /^aiplay_.*\.py$/.test(name)));
  const before = deployEpoch(), names = await fs.readdir(nodes);
  assert.equal((await comfyUpdateEligibility(f.config, {})).blocked, null);
  assert.equal(deployEpoch(), before, "eligibility must remain read-only");
  assert.deepEqual(await fs.readdir(nodes), names);
  assert.equal((await f.service.status()).blocked, null, "the normal running engine can offer its update");
});

test("modified bundled files and foreign aiplay names remain custom nodes", async t => {
  const f = await fixture(t), nodes = path.join(f.config.comfyDir, "custom_nodes");
  const deployed = deployStudioNodes(nodes), name = deployed.copied.find(name => /^aiplay_.*\.py$/.test(name));
  const source = await fs.readFile(path.join(STUDIO_NODES_DIR, name));
  await fs.appendFile(path.join(nodes, name), "\n# a user's change\n");
  assert.match((await comfyUpdateEligibility(f.config, {})).blocked, /custom nodes/);
  await fs.writeFile(path.join(nodes, name), source);
  assert.equal((await comfyUpdateEligibility(f.config, {})).blocked, null);
  await fs.writeFile(path.join(nodes, "aiplay_foreign_extension.py"), "NODE_CLASS_MAPPINGS = {}\n");
  assert.match((await comfyUpdateEligibility(f.config, {})).blocked, /custom nodes/);
});

test("the optional T8 deployment requires its marker and exact bundled files", async t => {
  const f = await fixture(t), nodes = path.join(f.config.comfyDir, "custom_nodes"), name = VENDORED_NODES[0];
  deployStudioNodes(nodes, undefined, { want: { [name]: true } });
  const folder = path.join(nodes, name), markerFile = path.join(folder, STUDIO_COPY_MARKER);
  const marker = await fs.readFile(markerFile, "utf8"), record = JSON.parse(marker);
  assert.ok(Object.keys(record.files).length > 0);
  await fs.mkdir(path.join(folder, "__pycache__"));
  const pythonFile = Object.keys(record.files).find(file => file.endsWith(".py"));
  await fs.writeFile(path.join(folder, "__pycache__", `${pythonFile.slice(0, -3)}.cpython-313.pyc`), "generated cache fixture");
  assert.equal((await comfyUpdateEligibility(f.config, {})).blocked, null);
  await fs.unlink(markerFile);
  assert.match((await comfyUpdateEligibility(f.config, {})).blocked, /custom nodes/, "an unmarked clone is not a deployment receipt");
  await fs.writeFile(markerFile, marker);
  await fs.appendFile(path.join(folder, pythonFile), "\n# changed\n");
  assert.match((await comfyUpdateEligibility(f.config, {})).blocked, /custom nodes/);
  await fs.copyFile(path.join(STUDIO_NODES_DIR, name, pythonFile), path.join(folder, pythonFile));
  const alteredMarker = JSON.parse(marker); alteredMarker.files[pythonFile] = "0".repeat(64);
  await fs.writeFile(markerFile, JSON.stringify(alteredMarker));
  assert.match((await comfyUpdateEligibility(f.config, {})).blocked, /custom nodes/, "a marker cannot vouch for modified content");
  await fs.writeFile(markerFile, marker);
  await fs.writeFile(path.join(folder, "my-node.py"), "# an added file\n");
  assert.match((await comfyUpdateEligibility(f.config, {})).blocked, /custom nodes/);
});

test("a linked node folder cannot qualify as Studio's byte-identical deployment", async t => {
  const f = await fixture(t), nodes = path.join(f.config.comfyDir, "custom_nodes"), name = VENDORED_NODES[0];
  deployStudioNodes(nodes, undefined, { want: { [name]: true } });
  const installed = path.join(nodes, name), kept = path.join(f.root, "linked-node-source");
  await fs.rename(installed, kept);
  try { await fs.symlink(kept, installed, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.skip("host does not permit directory links"); return; } throw error; }
  assert.match((await comfyUpdateEligibility(f.config, {})).blocked, /custom nodes/);
});

test("launch overrides and nonlocal modes refuse installation", async (t) => {
  const f = await fixture(t);
  assert.match((await comfyUpdateEligibility(f.config, { AIPLAY_RIG: f.config.rig })).blocked, /override/);
  assert.match((await comfyUpdateEligibility(f.config, { AIPLAY_PYTHON: f.config.python })).blocked, /override/);
  for (const flag of ["remoteOnly", "cloudOnly", "musicOnly"]) {
    f.config[flag] = true;
    assert.match((await comfyUpdateEligibility(f.config, {})).blocked, /Full Studio/);
    f.config[flag] = false;
  }
});

test("an offline or unidentifiable release never enables updating or downgrading", async (t) => {
  const f = await fixture(t);
  f.release.ok = false; f.release.error = "Offline";
  assert.equal((await f.service.status()).updateAvailable, false);
  await assert.rejects(f.options().target(), /Offline/);
  f.release.ok = true;
  f.release.latest.tag = "v0.35.0";
  await assert.rejects(f.options().target(), /already on/);
  f.release.latest.tag = "v0.41.0";
  await fs.writeFile(path.join(f.config.comfyDir, "comfyui_version.py"), "# nightly");
  f.state.version = "nightly-g123";
  await assert.rejects(f.options().target(), /identify/);
});

test("activation verifies actual runtime version and base nodes", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.service.readiness({ comfy: "v0.41.0" })).runtimeReady, false);
  f.state.version = "0.41.0";
  assert.equal((await f.service.readiness({ comfy: "v0.41.0" })).runtimeReady, true);
  delete f.nodes.KSampler;
  const missing = await f.service.readiness({ comfy: "v0.41.0" });
  assert.equal(missing.runtimeReady, false);
  assert.match(missing.error, /KSampler/);
  f.state.ready = false;
  assert.equal((await f.service.readiness()).runtimeReady, false);
});

test("restoration requires the retained managed engine and is blocked during installation", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.service.restore(), /no verified previous/);
  const oldRig = path.join(f.root, "previous"), python = venvPython(oldRig);
  await fs.mkdir(path.dirname(python), { recursive: true });
  await fs.mkdir(path.join(oldRig, "ComfyUI"), { recursive: true });
  await fs.writeFile(python, "old interpreter");
  await fs.writeFile(path.join(oldRig, "ComfyUI", "main.py"), "# previous engine");
  await fs.writeFile(path.join(oldRig, ".aiplay-engine.json"), '{"complete":true}');
  const previousEngine = { rig: oldRig, python, modelsDir: f.config.modelsDir, inputDir: f.config.inputDir, outputDir: f.config.outputDir };
  await fs.writeFile(f.config.settingsFile, JSON.stringify({ comfyUpdate: { rig: f.config.rig }, previousEngine }));
  assert.equal((await f.service.status()).canRestore, true);
  f.job({ state: "running" });
  await assert.rejects(f.service.restore(), /Wait for/);
  f.job(null);
  assert.equal((await f.service.restore()).ok, true);
  assert.deepEqual(f.restored(), previousEngine);
  await fs.unlink(path.join(oldRig, ".aiplay-engine.json"));
  assert.equal((await f.service.status()).canRestore, false);
});

test("engine update/restore routes require the same local JSON guard as setup", async () => {
  const calls = [];
  const route = createEngineRoutes({ json: (res, status, body) => Object.assign(res, { status, body }), readBody: async (req) => req.body,
    config: { uiPort: 4173 }, provenance: { actorFrom: () => "script:test" }, engine: {},
    sameOriginLocalJson: (req) => req.local === true,
    maintenance: { status: async (options) => { calls.push(options); return { ok: true }; },
      update: async () => { calls.push("update"); return { state: "running" }; }, restore: async () => { calls.push("restore"); return { ok: true }; } },
  });
  async function request(action, local, extra = {}) {
    const res = {};
    await route({ method: "POST", headers: { "x-aiplay-actor": "script:test" }, body: { action, ...extra }, local }, res, new URL("http://localhost:4173/api/engine"));
    return res;
  }
  assert.equal((await request("updates", false, { force: true })).status, 200);
  assert.deepEqual(calls, [{ force: true }]);
  for (const action of ["update_comfy", "restore_comfy"]) assert.equal((await request(action, false)).status, 403);
  assert.equal(calls.length, 1);
  assert.equal((await request("update_comfy", true)).body.job.state, "running");
  assert.equal((await request("restore_comfy", true)).body.ok, true);
});

test("MCP exposes the same update check, install and restore actions", async () => {
  const calls = [];
  const tools = engineTools(async (method, url, body) => { calls.push([method, url, body]); return { ok: true }; });
  await tools.find((tool) => tool.name === "engine_updates").run({ force: true });
  await tools.find((tool) => tool.name === "engine_update_comfyui").run();
  await tools.find((tool) => tool.name === "engine_restore_comfyui").run();
  assert.deepEqual(calls, [
    ["POST", "/api/engine", { action: "updates", force: true }],
    ["POST", "/api/engine", { action: "update_comfy" }],
    ["POST", "/api/engine", { action: "restore_comfy" }],
  ]);
});
