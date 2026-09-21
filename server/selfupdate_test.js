/**
 * THE LAUNCHER'S UPDATE, run for real against a throwaway install.
 *
 * GitHub is a fake `fetch` serving a zip built here, so nothing leaves the
 * machine. What it must do: replace the app folders with the new build (a file
 * the new build dropped is gone), keep the person's own custom workflows,
 * never touch .\node or node_modules, and stamp the new commit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import vm from "node:vm";
import { selfUpdate, updateSource } from "./selfupdate.js";

const winTar = path.join(process.env.SystemRoot || "C:\Windows", "System32", "tar.exe");
const canZip = process.platform === "win32" && existsSync(winTar);

async function files(root, map) {
  for (const [rel, text] of Object.entries(map)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
}

test("a zip install updates in place and keeps what is the person's", { skip: !canZip && "needs Windows' tar.exe to build the zip" }, async () => {
  const base = await mkdtemp(path.join(tmpdir(), "aiplay-selfupdate-"));
  try {
    const app = path.join(base, "app"), src = path.join(base, "src", "AIPLAY-Studio-abc");
    await files(app, {
      "package.json": '{"name":"aiplay-studio"}', "package-lock.json": "{}",
      "launcher/launcher.mjs": "old", "server/index.js": "old", "server/dropped.js": "old only",
      "server/version.gen.json": '{"commit":"1111111"}', "workflows/custom/mine.json": "my workflow",
      "node/node.exe": "private node", "node_modules/ws/index.js": "ws",
      "install-info.json": '{"repo":"someone/AIPLAY-Studio","commit":"1111111"}',
    });
    await files(src, {
      "package.json": '{"name":"aiplay-studio"}', "package-lock.json": "{}",
      "launcher/launcher.mjs": "new", "server/index.js": "new", "server/NOTES.md": "dropped by exclude",
      "workflows/custom/README.md": "readme", "docs/big.md": "never installed",
      "install.json": JSON.stringify({ include: ["server", "launcher", "workflows", "package.json", "package-lock.json"], exclude: ["*.md"], keep: [], preserve: ["workflows/custom"] }),
    });
    const zip = path.join(base, "s.zip");
    execFileSync(winTar, ["-a", "-c", "-f", zip, "-C", path.join(base, "src"), "AIPLAY-Studio-abc"]);

    const real = globalThis.fetch;
    const asked = [];
    globalThis.fetch = async (url) => {
      asked.push(String(url));
      if (String(url).includes("/commits/main")) return { ok: true, status: 200, json: async () => ({ sha: "abcdef0123456789", commit: { committer: { date: "2026-09-22T10:00:00Z" } } }) };
      return new Response(readFileSync(zip));
    };
    let r;
    try { r = await selfUpdate({ root: app }); } finally { globalThis.fetch = real; }

    assert.equal(r.ok, true, r.line);
    assert.ok(asked[0].includes("/repos/someone/AIPLAY-Studio/commits/main"), "the repository install-info.json names");
    assert.equal(await readFile(path.join(app, "server/index.js"), "utf8"), "new");
    assert.equal(await readFile(path.join(app, "launcher/launcher.mjs"), "utf8"), "new");
    assert.ok(!existsSync(path.join(app, "server/dropped.js")), "a file the new build dropped is gone");
    assert.ok(!existsSync(path.join(app, "server/NOTES.md")) && !existsSync(path.join(app, "docs")), "install.json's exclude and include");
    assert.equal(await readFile(path.join(app, "workflows/custom/mine.json"), "utf8"), "my workflow", "custom workflows survive");
    assert.equal(await readFile(path.join(app, "node/node.exe"), "utf8"), "private node");
    assert.equal(await readFile(path.join(app, "node_modules/ws/index.js"), "utf8"), "ws");
    assert.equal(JSON.parse(await readFile(path.join(app, "server/version.gen.json"), "utf8")).commit, "abcdef0");
    assert.equal((await updateSource(app)).have, "abcdef0");

    /* Already current: one question to GitHub, nothing downloaded. */
    globalThis.fetch = async (url) => { asked.push(String(url)); return { ok: true, status: 200, json: async () => ({ sha: "abcdef0123456789", commit: {} }) }; };
    const n = asked.length;
    try { r = await selfUpdate({ root: app }); } finally { globalThis.fetch = real; }
    assert.equal(r.line, "Already up to date.");
    assert.equal(asked.length, n + 1);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("the launcher refuses while Studio runs, and the button says what it keeps", () => {
  const l = readFileSync(new URL("../launcher/launcher.mjs", import.meta.url), "utf8");
  const h = readFileSync(new URL("../launcher/index.html", import.meta.url), "utf8");
  assert.match(l, /if \(child\) return send\(res, 200, \{ \.\.\.updating, error: "Stop Studio first/);
  assert.match(l, /if \(await probeStudio\(\)\) return send\(res, 200, \{ \.\.\.updating, error: "Stop the Studio running outside/);
  assert.match(h, /id="verUpdate"/);
  /* Under the exe host the footer's sentence was written with $("foot").textContent,
   * which wiped the whole footer: the version line and both buttons never showed. */
  assert.doesNotMatch(h, /\$\("foot"\)\.textContent/);
  assert.match(h, /\$\("footText"\)\.textContent = st\.host === "exe"/);
  assert.match(h, /Your songs, settings and models are not touched/);
  assert.match(readFileSync(new URL("../install.json", import.meta.url), "utf8"), /"preserve": \[\s*"workflows\/custom"/);
  assert.match(readFileSync(new URL("../installer/Setup.cs", import.meta.url), "utf8"), /CopyMissing\(from, Path\.Combine\(stage/, "the installer's reinstall keeps them too");
});

test("ZIP source selection respects an explicit installer choice, then fork metadata, then canonical main", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "aiplay-update-source-"));
  try {
    await files(base, { "package.json": '{}' });
    assert.equal((await updateSource(base)).repo, "Senzube4n/AIPLAY-Studio");
    await files(base, { "package.json": JSON.stringify({ aiplay: { lineage: { repo: "someone/fork" } } }) });
    assert.equal((await updateSource(base)).repo, "someone/fork");
    await files(base, { "install-info.json": '{"repo":"selected/build"}' });
    assert.equal((await updateSource(base)).repo, "selected/build");
    await files(base, { ".git": "gitdir: not-a-real-worktree" });
    assert.equal((await updateSource(base)).kind, "git", "a worktree stays on the git path, never ZIP replacement");
  } finally { await rm(base, { recursive: true, force: true }); }
});

async function withUpdateFixture(fn) {
  const base = await mkdtemp(path.join(tmpdir(), "aiplay-update-recovery-"));
  const realFetch = globalThis.fetch;
  try {
    const app = path.join(base, "app"), fresh = path.join(base, "src", "Studio-new");
    await files(app, { "server/index.js": "old server", "launcher/launcher.mjs": "old launcher", "package-lock.json": "old lock",
      "install-info.json": '{"repo":"selected/build","commit":"1111111"}', "server/version.gen.json": '{"commit":"1111111"}' });
    await files(fresh, { "server/index.js": "new server", "launcher/launcher.mjs": "new launcher", "package-lock.json": "new lock",
      "install.json": JSON.stringify({ include: ["server", "launcher", "package-lock.json"], exclude: [], keep: [], preserve: [] }) });
    const zip = path.join(base, "new.zip");
    execFileSync(winTar, ["-a", "-c", "-f", zip, "-C", path.join(base, "src"), "Studio-new"]);
    globalThis.fetch = async url => String(url).includes("/commits/main")
      ? { ok: true, json: async () => ({ sha: "abcdef0123456789", commit: {} }) }
      : new Response(readFileSync(zip));
    await fn(app);
  } finally { globalThis.fetch = realFetch; await rm(base, { recursive: true, force: true }); }
}

test("a later folder copy failure restores the whole previous app and its version", { skip: !canZip }, async () => {
  await withUpdateFixture(async app => {
    const realCopy = fsPromises.cp;
    fsPromises.cp = async (from, to, opts) => {
      if (to === path.join(app, "launcher")) throw new Error("fixture: disk copy failed");
      return realCopy(from, to, opts);
    };
    syncBuiltinESMExports();
    let result;
    try { result = await selfUpdate({ root: app, command: async () => { throw new Error("npm must not run after failed copy"); } }); }
    finally { fsPromises.cp = realCopy; syncBuiltinESMExports(); }
    assert.equal(result.ok, false);
    assert.equal(result.changed, false);
    assert.match(result.line, /fixture: disk copy failed/);
    assert.equal(await readFile(path.join(app, "server/index.js"), "utf8"), "old server");
    assert.equal(await readFile(path.join(app, "launcher/launcher.mjs"), "utf8"), "old launcher");
    assert.equal((await updateSource(app)).have, "1111111");
  });
});

test("npm failure is reported and retry installs dependencies even when the app commit is current", { skip: !canZip }, async () => {
  await withUpdateFixture(async app => {
    let installs = 0;
    const command = async (_cmd, args) => { assert.ok(args.includes("install")); installs++; if (installs === 1) throw new Error("fixture: registry offline"); return ""; };
    const first = await selfUpdate({ root: app, command });
    assert.equal(first.ok, false);
    assert.equal(first.changed, true);
    assert.match(first.line, /dependency install failed.*registry offline/);
    assert.ok(existsSync(path.join(app, ".aiplay-update-npm-pending")));
    assert.equal((await updateSource(app)).have, "abcdef0");
    const second = await selfUpdate({ root: app, command });
    assert.equal(second.ok, true, second.line);
    assert.equal(second.changed, false);
    assert.equal(installs, 2, "retry does not stop at Already up to date");
    assert.ok(!existsSync(path.join(app, ".aiplay-update-npm-pending")));
  });
});

test("Git updates preserve the clone's tracking branch and refuse dirty or diverged work", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "aiplay-git-update-"));
  try {
    await files(base, { ".git": "gitdir: fixture", "package-lock.json": "{}" });
    const calls = [];
    const command = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === "status") return "";
      if (args[0] === "rev-parse") return "1111111";
      throw new Error("Not possible to fast-forward");
    };
    const result = await selfUpdate({ root: base, command });
    assert.equal(result.ok, false);
    assert.match(result.line, /will not merge/);
    assert.deepEqual(calls.at(-1), ["git", "pull", "--ff-only"], "no forced origin, branch switch, reset or fork redirect");
    const dirty = await selfUpdate({ root: base, command: async (_cmd, args) => { assert.equal(args[0], "status"); return " M package.json"; } });
    assert.match(dirty.line, /not committed/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("launch and engine install cannot start during an update or with pending npm repair", async () => {
  const source = readFileSync(new URL("../launcher/launcher.mjs", import.meta.url), "utf8");
  const launchBody = source.slice(source.indexOf("async function launch(mode)"), source.indexOf("async function waitForEngine("));
  const installBody = source.slice(source.indexOf("async function startInstall(backend)"), source.indexOf("function which("));
  const context = { updating: { state: "running" }, path, ROOT: "fixture", existsSync: () => true };
  const launch = vm.runInNewContext(`(${launchBody})`, context);
  const install = vm.runInNewContext(`(${installBody})`, context);
  await assert.rejects(launch("full"), /Wait for the Studio update/);
  await assert.rejects(install("nvidia"), /Wait for the Studio update/);
  context.updating.state = "idle";
  await assert.rejects(launch("full"), /finish installing Studio's dependencies/);
});
