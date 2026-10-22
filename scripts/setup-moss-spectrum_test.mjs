/** CPU-only source install fixtures. No network, Python, engine or model files. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm, symlink, realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { setupMossSpectrum, spectrumSetupArgs } from "./setup-moss-spectrum.mjs";
import { MOSS_SPECTRUM } from "../server/moss-presets.js";
import { mossSpectrumPin } from "../server/moss-spectrum.js";

const hash = data => createHash("sha256").update(data).digest("hex");
async function fixture(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "moss-setup-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const comfyDir = path.join(dir, "engine", "ComfyUI");
  await mkdir(path.join(comfyDir, "custom_nodes"), { recursive: true });
  await writeFile(path.join(comfyDir, "main.py"), "# never executed by these tests\n");
  const data = new Map(MOSS_SPECTRUM.files.map(f => [f.file, Buffer.from(f.file === "LICENSE" ? "GPL fixture licence retained\n" : "reviewed fixture: " + f.file)]));
  const pin = { ...MOSS_SPECTRUM, files: MOSS_SPECTRUM.files.map(f => ({ file: f.file, bytes: data.get(f.file).length, sha256: hash(data.get(f.file)) })) };
  const calls = [], fetcher = async (url, options) => {
    calls.push({ url, options }); const name = url.split("/").at(-1);
    return new Response(data.get(name), { status: 200, headers: { "Content-Length": String(data.get(name).length) } });
  };
  return { dir, comfyDir, pin, data, calls, fetcher, destination: path.join(comfyDir, "custom_nodes", pin.folder) };
}

test("help, importing, and a default plan perform no install or network", async t => {
  const f = await fixture(t);
  const result = await setupMossSpectrum({ comfyDir: f.comfyDir }, { pin: f.pin, fetcher: f.fetcher });
  assert.equal(result.phase, "planned"); assert.equal(result.filesWritten, 0); assert.equal(f.calls.length, 0);
  assert.deepEqual(await readdir(path.join(f.comfyDir, "custom_nodes")), []);
  const help = execFileSync(process.execPath, [fileURLToPath(new URL("./setup-moss-spectrum.mjs", import.meta.url)), "--help"], { encoding: "utf8", timeout: 3000, windowsHide: true });
  assert.match(help, /--execute/); assert.match(help, /--verify/);
  assert.throws(() => spectrumSetupArgs(["--unknown"]), /Unknown/);
  assert.throws(() => spectrumSetupArgs(["--comfy-dir"]), /absolute/);
  await assert.rejects(setupMossSpectrum({ comfyDir: "relative", execute: true }), /absolute/);
  await assert.rejects(setupMossSpectrum({ comfyDir: f.comfyDir, writeMarker: true }), /explicit/);
  assert.equal(f.calls.length, 0);
});

test("explicit setup pins every URL and hash, preserves LICENSE and creates the production-readable marker last", async t => {
  const f = await fixture(t);
  const writes = [], write = async (...args) => { writes.push(path.basename(args[0])); assert.equal(args[2].flag, "wx"); return writeFile(...args); };
  const result = await setupMossSpectrum({ comfyDir: f.comfyDir, execute: true }, { pin: f.pin, fetcher: f.fetcher, write });
  assert.equal(result.phase, "installed"); assert.equal(result.filesWritten, 9); assert.equal(result.restartRequired, true);
  assert.equal(result.dependenciesInstalled, false); assert.equal(result.engineStarted, false); assert.equal(result.settingsChanged, false);
  assert.deepEqual(writes, [...f.pin.files.map(x => x.file), f.pin.marker]);
  assert.equal(f.calls.length, 8);
  for (const call of f.calls) { assert.ok(call.url.startsWith("https://raw.githubusercontent.com/Rkkss/ComfyUI-Spectrum-MOSS/" + f.pin.commit + "/")); assert.equal(call.options.redirect, "error"); }
  assert.equal(await readFile(path.join(f.destination, "LICENSE"), "utf8"), f.data.get("LICENSE").toString());
  assert.equal((await mossSpectrumPin({ comfyDir: f.comfyDir }, f.pin)).ready, true);
  const verified = await setupMossSpectrum({ comfyDir: f.comfyDir, verify: true }, { pin: f.pin, fetcher: async () => { throw Error("verify must not fetch"); } });
  assert.equal(verified.phase, "verified"); assert.equal(verified.filesWritten, 0);
});

test("same-size bad source, oversized streams and HTTP failures write no installation files", async t => {
  const f = await fixture(t);
  for (const make of [
    data => new Response(Buffer.alloc(data.length, 120)),
    data => new Response(Buffer.alloc(data.length + 1, 120)),
    _data => new Response("missing", { status: 404 }),
  ]) {
    await assert.rejects(setupMossSpectrum({ comfyDir: f.comfyDir, execute: true }, { pin: f.pin, fetcher: async url => make(f.data.get(url.split("/").at(-1))) }), /source|Source/);
    assert.deepEqual(await readdir(path.join(f.comfyDir, "custom_nodes")), []);
  }
});

test("an existing or concurrently created destination is never replaced", async t => {
  const f = await fixture(t);
  let first = true;
  const racingFetch = async (...args) => { if (first) { first = false; await mkdir(f.destination); await writeFile(path.join(f.destination, "user.txt"), "preserve me"); } return f.fetcher(...args); };
  await assert.rejects(setupMossSpectrum({ comfyDir: f.comfyDir, execute: true }, { pin: f.pin, fetcher: racingFetch }), /exist/i);
  assert.deepEqual(await readdir(f.destination), ["user.txt"]);
  const count = f.calls.length;
  await assert.rejects(setupMossSpectrum({ comfyDir: f.comfyDir, execute: true }, { pin: f.pin, fetcher: f.fetcher }), /already exists/);
  assert.equal(f.calls.length, count); assert.equal(await readFile(path.join(f.destination, "user.txt"), "utf8"), "preserve me");
});

test("a partial disk failure preserves its exact folder and never writes a misleading marker", async t => {
  const f = await fixture(t);
  const write = async (file, ...args) => { if (path.basename(file) === "nodes.py") throw Error("fixture disk error"); return writeFile(file, ...args); };
  await assert.rejects(setupMossSpectrum({ comfyDir: f.comfyDir, execute: true }, { pin: f.pin, fetcher: f.fetcher, write }), /Partial installation preserved/);
  assert.ok((await readdir(f.destination)).length > 0);
  await assert.rejects(lstat(path.join(f.destination, f.pin.marker)), { code: "ENOENT" });
  const before = await readdir(f.destination), count = f.calls.length;
  await assert.rejects(setupMossSpectrum({ comfyDir: f.comfyDir, execute: true }, { pin: f.pin, fetcher: f.fetcher }), /already exists/);
  assert.deepEqual(await readdir(f.destination), before); assert.equal(f.calls.length, count);
});

test("marker-only setup authenticates existing bytes without downloading and refuses any existing marker", async t => {
  const f = await fixture(t); await mkdir(f.destination);
  for (const [name, data] of f.data) await writeFile(path.join(f.destination, name), data);
  await assert.rejects(setupMossSpectrum({ comfyDir: f.comfyDir, verify: true }, { pin: f.pin }), /marker is missing/);
  const result = await setupMossSpectrum({ comfyDir: f.comfyDir, execute: true, writeMarker: true }, { pin: f.pin, fetcher: f.fetcher });
  assert.equal(result.phase, "marker-created"); assert.equal(result.networkUsed, false); assert.equal(f.calls.length, 0);
  assert.equal((await mossSpectrumPin({ comfyDir: f.comfyDir }, f.pin)).ready, true);
  const before = await readFile(path.join(f.destination, f.pin.marker));
  await assert.rejects(setupMossSpectrum({ comfyDir: f.comfyDir, execute: true, writeMarker: true }, { pin: f.pin }), /already exists/);
  assert.deepEqual(await readFile(path.join(f.destination, f.pin.marker)), before);
});

test("linked parents and linked source files are refused", async t => {
  const f = await fixture(t), link = path.join(f.dir, "linked");
  await symlink(f.comfyDir, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(setupMossSpectrum({ comfyDir: link, execute: true }, { pin: f.pin, fetcher: f.fetcher }), /linked parents/);
  assert.equal(f.calls.length, 0);
  await mkdir(f.destination);
  const real = path.join(f.dir, "actual-source.py"); await writeFile(real, f.data.get("nodes.py"));
  // Directory symlinks work without elevated privileges on Windows. A linked
  // parent is sufficient to cover that supported platform's refusal above.
  if (process.platform !== "win32") {
    for (const [name, data] of f.data) if (name !== "nodes.py") await writeFile(path.join(f.destination, name), data);
    await symlink(real, path.join(f.destination, "nodes.py"));
    await assert.rejects(setupMossSpectrum({ comfyDir: f.comfyDir, execute: true, writeMarker: true }, { pin: f.pin }), /type mismatch/);
  }
});


test("compressed transport length is not confused with fetch's decoded source bytes",async t=>{
  const f=await fixture(t);
  const fetcher=async url=>new Response(f.data.get(url.split("/").at(-1)),{headers:{"content-encoding":"gzip","content-length":"1"}});
  // Response fixtures represent the already decoded body that real fetch exposes.
  const result=await setupMossSpectrum({comfyDir:f.comfyDir,execute:true},{pin:f.pin,fetcher});
  assert.equal(result.phase,"installed");assert.equal((await mossSpectrumPin({comfyDir:f.comfyDir},f.pin)).ready,true);
});
