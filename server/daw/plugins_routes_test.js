/** Actual DAW HTTP/plugin dispatch and cached-render guards; fake host only. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const root = await mkdtemp(path.join(os.tmpdir(), "aiplay-vst-routes-test-"));
process.env.AIPLAY_APPDATA = path.join(root, "data");
process.env.AIPLAY_OUTPUT = path.join(root, "output");
process.env.AIPLAY_DAW_NO_SERVE = "1";
const { createPluginManager, PLUGIN_ACTIONS } = await import("./plugins.js");
const { createDawRoutes } = await import("./routes.js");
const store = await import("./store.js");
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
function wav(frames, sr) {
  const buffer = Buffer.alloc(44 + frames * 8);
  buffer.write("RIFF"); buffer.writeUInt32LE(36 + frames * 8, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(3, 20); buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(sr, 24); buffer.writeUInt32LE(sr * 8, 28); buffer.writeUInt16LE(8, 32);
  buffer.writeUInt16LE(32, 34); buffer.write("data", 36); buffer.writeUInt32LE(frames * 8, 40);
  return buffer;
}
try {
  const binary = path.join(root, "Example.vst3");
  await writeFile(binary, "fixture binary");
  const manager = createPluginManager({ config: { paths: { appData: process.env.AIPLAY_APPDATA }, rig: root },
    runWorker: async job => job.op === "probe" ? { ok: true, version: "test" } :
      { ok: true, label: "Example", hostVersion: "test", parameters: {}, state: "", latencySamples: 0 } });
  let spawned = 0;
  const handle = createDawRoutes({ config: { outputDir: process.env.AIPLAY_OUTPUT, python: "never-executed" }, plugins: manager,
    spawnPython: () => { spawned++; throw new Error("This test must reuse valid cached audio."); },
    readBody: async request => request.body, json: (res, code, body) => Object.assign(res, { code, body }) });
  async function request(body, url = "/api/daw", method = "POST") {
    const result = {};
    await handle({ body, method, headers: {} }, result, new URL(url, "http://daw.test"));
    return result;
  }
  let result = await request({}, "/api/daw/plugins", "GET");
  check(result.code === 200 && result.body.host.ready, "GET plugin snapshot uses manager");
  result = await request({ action: "plugin_scan", folders: [root] }, "/api/daw/plugins");
  check(result.code === 200 && result.body.plugins.some(row => row.path === binary), "plugin_scan route discovers local effect");
  result = await request({ action: "plugin_inspect", path: binary });
  const descriptor = result.body.plugin;
  check(result.code === 200 && descriptor?.id, "shared DAW action dispatcher inspects effect");
  check(PLUGIN_ACTIONS.includes("plugin_setup") && PLUGIN_ACTIONS.length === 4, "exported action census");

  const document = await store.createProject("plugin cache guards", { lengthBars: 1 });
  const doc = await store.updateProject(document.slug, project => {
    project.master.inserts = [{ id: "fixture-vst", type: "vst3", enabled: true, plugin: descriptor, params: {} }];
    return project;
  });
  const region = store.regionsOf(doc)[0], directory = store.cacheDir(doc.slug);
  await mkdir(directory, { recursive: true });
  const cached = path.join(directory, "reg0_" + store.regionHashes(doc)[0] + ".wav");
  await writeFile(cached, wav(region.nSamples, doc.sr));
  result = await request({ action: "render", slug: doc.slug });
  check(result.code === 200 && result.body.regions[0].cached, "available plugin may reuse exact cached render");
  result = await request({ action: "render_plan", slug: doc.slug });
  check(result.code === 200 && result.body.regions[0].cached, "available plugin plan reports cache ready");
  await writeFile(binary, "changed binary");
  for (const action of ["render", "render_plan", "render_ahead"]) {
    result = await request({ action, slug: doc.slug, at_seconds: 0, lead_seconds: 0 });
    check(result.code === 400 && /files changed/.test(result.body.error), action + " refuses stale binary before cache reuse");
  }
  check(spawned === 0, "cache refusal does not launch an engine or plugin");

  const operations = [];
  const uploadPlugins = { ...manager, install: async ({ path: file }) => {
    operations.push({ file, bytes: await readFile(file) });
    return { ok: true, installed: ["test-plugin"] };
  } };
  const uploadHandle = createDawRoutes({ config: { python: "never-executed" }, plugins: uploadPlugins,
    readBody: async request => request.body, json: (res, code, body) => Object.assign(res, { code, body }) });
  async function upload(name, chunks = [Buffer.from("ZIP fixture")], headers = {}) {
    const req = Readable.from(chunks);
    req.method = "POST"; req.headers = headers;
    const res = {};
    await uploadHandle(req, res, new URL("/api/daw/plugins/upload?name=" + encodeURIComponent(name), "http://daw.test"));
    return res;
  }
  result = await upload("Effect.zip", [Buffer.from("ZIP "), Buffer.from("fixture")]);
  check(result.code === 200 && operations[0].bytes.toString() === "ZIP fixture", "raw upload streams to the shared installer");
  await assert.rejects(() => access(operations[0].file)); checks++;
  for (const name of ["../bad.zip", "plugin.exe", "C:\\bad.zip", "bad\u0000.zip"]) {
    result = await upload(name);
    check(result.code === 400 && /Choose/.test(result.body.error), "unsafe upload name refused");
  }
  result = await upload("empty.zip", []);
  check(result.code === 400 && /empty/.test(result.body.error), "empty upload refused");
  result = await upload("large.zip", [], { "content-length": String(256 * 1024 * 1024 + 1) });
  check(result.code === 400 && /256 MiB/.test(result.body.error), "oversized upload refused before disk writes");
  check(operations.length === 1, "invalid uploads never reach installer");
  console.log(`${checks} VST3 route/cache/upload checks passed; no native effect ran.`);
} finally {
  await rm(root, { recursive: true, force: true });
}
