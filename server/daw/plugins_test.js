/** Native-effect discovery and identity guards, without loading any binary. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPluginManager, fingerprintPlugin, normalizePluginParams } from "./plugins.js";

const root = await mkdtemp(path.join(os.tmpdir(), "aiplay-vst-test-"));
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const rejects = async (action, match) => { await assert.rejects(action, match); checks++; };
try {
  const folder = path.join(root, "external"), bundle = path.join(folder, "Nested", "Example.vst3");
  await mkdir(path.join(bundle, "Contents", "x86_64-win"), { recursive: true });
  await writeFile(path.join(bundle, "Contents", "x86_64-win", "Example.vst3"), "fake plugin bytes");
  await writeFile(path.join(bundle, "LICENSE.txt"), "Example license");
  let inspections = 0, probes = 0, version = "test-host-1";
  const schema = { gain: { type: "number", label: "Gain", default: 0, min: -120, max: 18 },
    mode: { type: "enum", label: "Mode", default: "soft", values: ["soft", "hard"] },
    enabled: { type: "bool", label: "Enabled", default: true },
    mono: { type: "number", label: "Mono", default: 0, min: 0, max: 2, step: 1 } };
  const manager = createPluginManager({ config: { paths: { appData: path.join(root, "data") }, rig: root },
    runWorker: async job => {
      if (job.op === "probe") { probes++; return { ok: true, ready: true, version }; }
      if (job.op === "inspect") {
        inspections++;
        const registry = JSON.parse(await readFile(job.registry, "utf8"));
        check(registry.plugins[job.id].fingerprint === await fingerprintPlugin(bundle), "registry hash before inspection");
        return { ok: true, label: "Example", hostVersion: version, parameters: schema, state: "YWJj", latencySamples: 32 };
      }
      throw new Error("Unexpected worker operation");
    } });
  let list = await manager.list({ folders: [folder] });
  const row = list.plugins.find(row => row.path === bundle);
  check(row?.status === "uninspected", "nested bundles discovered");
  check(inspections === 0 && probes === 1, "scan probes host but never loads plugin");
  list = await manager.list();
  check(probes === 1 && list.plugins.some(row2 => row2.id === row.id), "stable IDs and cached readiness");
  check(manager.env().AIPLAY_DAW_PLUGIN_REGISTRY.endsWith("registry.json"), "native engine registry environment");
  await rejects(() => manager.list({ folders: [path.parse(folder).root] }), /drive root/);
  await rejects(() => manager.list({ folders: ["relative"] }), /absolute/);
  await rejects(() => manager.resolve(row.id), /unavailable/);
  const inspected = await manager.inspect({ plugin: row.id });
  const descriptor = inspected.plugin;
  check(descriptor.id === row.id && descriptor.fingerprint.length === 64, "registered descriptor has stable identity");
  check(!Object.hasOwn(inspected.plugins.find(row2 => row2.id === row.id), "state"), "catalog avoids exposing bulk preset state");
  check(!Object.hasOwn(descriptor, "path"), "saved projects contain no executable path");
  const added = await manager.validateInsert(row.id, { gain: 6, mode: "hard", mono: 2 });
  check(added.params.enabled === true && added.params.gain === 6, "validated controls merge defaults");
  check(added.plugin.state === "YWJj", "default preset state survives");
  await rejects(() => manager.validateInsert(row.id, { gain: 30 }), /number from/);
  await rejects(() => manager.validateInsert(row.id, { gain: "6" }), /number from/);
  await rejects(() => manager.validateInsert(row.id, { enabled: 1 }), /true or false/);
  await rejects(() => manager.validateInsert(row.id, { mode: "unknown" }), /listed values/);
  await rejects(() => manager.validateInsert(row.id, { mono: 0.5 }), /numeric steps/);
  await rejects(() => manager.validateInsert(row.id, { bogus: 1 }), /Unknown/);
  const doc = { tracks: [], returns: [], master: { inserts: [{ type: "vst3", enabled: true, plugin: descriptor }] } };
  await manager.validateProject(doc); checks++;
  await rejects(() => manager.validateProject({ ...doc, master: { inserts: [{ type: "vst3", plugin: { ...descriptor, fingerprint: "0".repeat(64) } }] } }), /changed/);
  await rejects(() => manager.validateProject({ ...doc, master: { inserts: [{ type: "vst3", plugin: { ...descriptor, hostVersion: "older" } }] } }), /changed/);
  await writeFile(path.join(bundle, "Contents", "x86_64-win", "Example.vst3"), "replacement bytes");
  await rejects(() => manager.resolve(row.id), /files changed/);
  await rejects(() => manager.validateProject(doc), /files changed/);
  await manager.validateProject({ ...doc, master: { inserts: [{ type: "vst3", enabled: false, plugin: descriptor }] } }); checks++;
  await manager.validateProject({ tracks: [{ mute: true, inserts: doc.master.inserts }], master: {} }); checks++;
  const changed = (await manager.inspect({ path: bundle })).plugin;
  check(changed.id === descriptor.id && changed.fingerprint !== descriptor.fingerprint, "reinspection retains ID but changes content identity");
  await rejects(() => manager.validateProject(doc), /changed/);
  const oldFingerprint = await fingerprintPlugin(bundle);
  await writeFile(path.join(bundle, "LICENSE.txt"), "Changed license text");
  check(await fingerprintPlugin(bundle) !== oldFingerprint, "whole-bundle identity covers resources and notices");
  const installed = await manager.install({ path: bundle });
  check(installed.installed.length === 1 && installed.installed[0].startsWith(manager.installedDir + path.sep), "local bundle copied into private managed folder");
  check(await readFile(path.join(installed.installed[0], "LICENSE.txt"), "utf8") === "Changed license text", "bundle notices preserved");
  check(installed.plugins.find(row2 => row2.path === installed.installed[0]).status === "uninspected", "installation does not execute plugin");
  version = "test-host-2";
  await manager.host(true);
  await rejects(() => manager.resolve(row.id), /files changed|host changed/);
  await rename(bundle, bundle + ".missing");
  check((await manager.list()).plugins.find(row2 => row2.id === row.id).status === "missing", "missing plugins remain visible");
  await rejects(() => manager.resolve(row.id), /files are missing/);
  assert.deepEqual(normalizePluginParams({}, {}), {}); checks++;
  console.log(`${checks} VST3 manager checks passed; no plugin binary was loaded.`);
} finally {
  await rm(root, { recursive: true, force: true });
}
