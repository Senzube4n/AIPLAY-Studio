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
import { selfUpdate, updateSource, forwardBuild, dependencyInstallCommand } from "./selfupdate.js";

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
      if (String(url).includes("/compare/")) return { ok: true, status: 200, json: async () => ({ status: "ahead", ahead_by: 3, behind_by: 0 }) };
      return new Response(readFileSync(zip));
    };
    let r;
    try { r = await selfUpdate({ root: app }); } finally { globalThis.fetch = real; }

    assert.equal(r.ok, true, r.line);
    assert.ok(asked.some((u) => u.includes("/repos/someone/AIPLAY-Studio/commits/main")), "the repository install-info.json names is asked too");
    assert.ok(asked.some((u) => u.includes("/repos/Senzube4n/AIPLAY-Studio/commits/main")), "and both builds");
    assert.ok(asked.some((u) => u.includes("codeload.github.com/Senzube4n/AIPLAY-Studio/zip/")), "level: Senzu's build, the main one");
    const compare = asked.findIndex(u => u.includes("/repos/Senzube4n/AIPLAY-Studio/compare/1111111...abcdef0123456789"));
    assert.ok(compare >= 0 && compare < asked.findIndex(u => u.includes("codeload.github.com")), "prove the chosen fork contains the installed commit before downloading");
    assert.equal(await readFile(path.join(app, "server/index.js"), "utf8"), "new");
    assert.equal(await readFile(path.join(app, "launcher/launcher.mjs"), "utf8"), "new");
    assert.ok(!existsSync(path.join(app, "server/dropped.js")), "a file the new build dropped is gone");
    assert.ok(!existsSync(path.join(app, "server/NOTES.md")) && !existsSync(path.join(app, "docs")), "install.json's exclude and include");
    assert.equal(await readFile(path.join(app, "workflows/custom/mine.json"), "utf8"), "my workflow", "custom workflows survive");
    assert.equal(await readFile(path.join(app, "node/node.exe"), "utf8"), "private node");
    assert.equal(await readFile(path.join(app, "node_modules/ws/index.js"), "utf8"), "ws");
    assert.equal(JSON.parse(await readFile(path.join(app, "server/version.gen.json"), "utf8")).commit, "abcdef0");
    assert.equal((await updateSource(app)).have, "abcdef0");

    /* Already current: one question per build (all level, so no comparison),
     * nothing downloaded. The update recorded the build it took as the
     * install's own, so the third fork is no longer asked. */
    assert.equal(JSON.parse(await readFile(path.join(app, "install-info.json"), "utf8")).repo, "Senzube4n/AIPLAY-Studio");
    globalThis.fetch = async (url) => { asked.push(String(url)); return { ok: true, status: 200, json: async () => ({ sha: "abcdef0123456789", commit: {} }) }; };
    const n = asked.length;
    try { r = await selfUpdate({ root: app }); } finally { globalThis.fetch = real; }
    assert.equal(r.line, "Already up to date.");
    assert.equal(asked.length, n + 2);
    assert.ok(asked.slice(n).every((u) => u.includes("/commits/main")));
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
      : String(url).includes("/compare/")
        ? { ok: true, json: async () => ({ status: "ahead", ahead_by: 3, behind_by: 0 }) }
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
    const command = async (_cmd, args) => { assert.ok(args.includes("ci")); assert.ok(args.includes("--ignore-scripts")); installs++; if (installs === 1) throw new Error("fixture: registry offline"); return ""; };
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

test("an update takes whichever build is ahead; level or diverged goes to Senzu's", async () => {
  const real = globalThis.fetch;
  const heads = {}, compare = {};
  globalThis.fetch = async (url) => {
    url = String(url);
    const m = url.match(/repos\/([^/]+\/[^/]+)\/commits\/main$/);
    if (m) return heads[m[1]] ? { ok: true, status: 200, json: async () => ({ sha: heads[m[1]], commit: { committer: { date: "d" } } }) } : { ok: false, status: 404 };
    const c = url.match(/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/);
    if (c) return { ok: true, status: 200, json: async () => compare[`${c[1]}...${c[2]}`] };
    throw new Error(`unexpected ${url}`);
  };
  const S = "Senzube4n/AIPLAY-Studio", B = "bani4kaskashka/AIPLAY-Studio-Bucky-Fork";
  try {
    // Senzu ahead of Bucky: an install made from Bucky's build still takes Senzu's.
    Object.assign(heads, { [S]: "aaaaaaa1", [B]: "bbbbbbb1" });
    compare["aaaaaaa1...bbbbbbb1"] = { status: "behind", ahead_by: 0, behind_by: 5 };
    let r = await forwardBuild(B);
    assert.equal(r.repo, S);
    // Bucky ahead: Bucky's.
    compare["aaaaaaa1...bbbbbbb1"] = { status: "ahead", ahead_by: 3, behind_by: 0 };
    r = await forwardBuild(S);
    assert.equal(r.repo, B);
    assert.match(r.note, /Bucky's build is 3 commits ahead of Senzu's build/);
    // Diverged: Senzu's, and it says why.
    compare["aaaaaaa1...bbbbbbb1"] = { status: "diverged", ahead_by: 2, behind_by: 4 };
    r = await forwardBuild(B);
    assert.equal(r.repo, S);
    assert.match(r.note, /each moved on/);
    // A third fork that is ahead of both wins.
    heads["someone/fork"] = "ccccccc1";
    compare["aaaaaaa1...ccccccc1"] = { status: "ahead", ahead_by: 1, behind_by: 0 };
    r = await forwardBuild("someone/fork");
    assert.equal(r.repo, "someone/fork");
    // One build unreachable: the other one.
    delete heads[S];
    r = await forwardBuild(B);
    assert.equal(r.repo, B);
    // Nothing reachable: the error, not a guess.
    for (const k of Object.keys(heads)) delete heads[k];
    await assert.rejects(forwardBuild(B), /GitHub answered 404/);
  } finally { globalThis.fetch = real; }
});

test("ZIP updates refuse a downgrade or unproven ancestry when the installed fork is unreachable", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "aiplay-update-ancestry-"));
  const real = globalThis.fetch;
  try {
    const originalInfo = '{"repo":"bani4kaskashka/AIPLAY-Studio-Bucky-Fork","commit":"bbbbbbb1"}';
    await files(base, { "server/index.js": "installed newer app", "install-info.json": originalInfo,
      "server/version.gen.json": '{"commit":"bbbbbbb1"}' });
    for (const scenario of [
      { relation: "behind", message: /will not downgrade/ },
      { relation: "diverged", message: /will not discard/ },
      { http: 404, message: /Could not verify.*GitHub answered 404/ },
      { relation: "unexpected", message: /did not confirm/ },
    ]) {
      const asked = [];
      globalThis.fetch = async input => {
        const url = String(input); asked.push(url);
        if (url.includes("bani4kaskashka/AIPLAY-Studio-Bucky-Fork/commits/main")) return { ok: false, status: 503 };
        if (url.includes("/commits/main")) return { ok: true, json: async () => ({ sha: "aaaaaaa1", commit: {} }) };
        assert.match(url, /\/repos\/Senzube4n\/AIPLAY-Studio\/compare\/bbbbbbb\.\.\.aaaaaaa1$/);
        return scenario.http ? { ok: false, status: scenario.http } : { ok: true, json: async () => ({ status: scenario.relation }) };
      };
      const result = await selfUpdate({ root: base, command: async () => { throw new Error("No dependency install may run."); } });
      assert.equal(result.ok, false); assert.equal(result.changed, false); assert.match(result.line, scenario.message);
      assert.ok(!asked.some(u => u.includes("codeload.github.com")), "refuse before downloading app bytes");
      assert.equal(await readFile(path.join(base, "server/index.js"), "utf8"), "installed newer app");
      assert.equal(await readFile(path.join(base, "install-info.json"), "utf8"), originalInfo);
    }
  } finally { globalThis.fetch = real; await rm(base, { recursive: true, force: true }); }
});

test("a ZIP with no recorded commit does not invent an ancestry requirement", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "aiplay-update-no-commit-"));
  const real = globalThis.fetch, asked = [];
  try {
    await files(base, { "package.json": "{}" });
    globalThis.fetch = async input => {
      const url = String(input); asked.push(url);
      if (url.includes("/commits/main")) return { ok: true, json: async () => ({ sha: "abcdef0123456789", commit: {} }) };
      assert.ok(url.includes("codeload.github.com"), "no invented installed commit comparison");
      return { ok: false, status: 503 };
    };
    const result = await selfUpdate({ root: base });
    assert.match(result.line, /download failed/);
    assert.ok(asked.some(u => u.includes("codeload.github.com")));
    assert.ok(!asked.some(u => u.includes("/compare/")));
  } finally { globalThis.fetch = real; await rm(base, { recursive: true, force: true }); }
});

async function runtimeFixture(t, { sameCommit = true, missingInstalled = null, missingFresh = null, malformedFresh = false, exclude = [], omitIncluded = null } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), "aiplay-runtime-repair-"));
  const app = path.join(base, "app"), src = path.join(base, "src", "Studio-runtime");
  const sha = "abcdef0123456789abcdef0123456789abcdef01", old = sameCommit ? sha : "1111111111111111111111111111111111111111";
  const manifest = { include: ["server","launcher","worker","shared","scripts","workflows","install.json","package.json","package-lock.json"],
    required: ["install.json","server/index.js","launcher/launcher.mjs","worker/runpod-worker.js","shared/model-profiles.js","scripts/verify-install.mjs"],
    exclude, keep: [], preserve: ["workflows/custom"] };
  if (omitIncluded) manifest.include = manifest.include.filter(name => name !== omitIncluded);
  const payload = {
    "package.json": '{"name":"aiplay-runtime-fixture","type":"module"}', "package-lock.json": "{}",
    "install.json": JSON.stringify(manifest),
    "server/index.js": "import { value } from '../shared/model-profiles.js'; throw Error('app modules must never execute during validation');",
    "launcher/launcher.mjs": "import '../server/index.js';",
    "worker/runpod-worker.js": "import '../shared/model-profiles.js';",
    "shared/model-profiles.js": "export const value = 1;",
    "scripts/verify-install.mjs": await readFile(new URL("../scripts/verify-install.mjs", import.meta.url), "utf8"),
    "scripts/install-manifest.mjs": await readFile(new URL("../scripts/install-manifest.mjs", import.meta.url), "utf8"),
    "workflows/base.json": "{}",
  };
  const installed = { ...payload, "server/version.gen.json": JSON.stringify({ commit: old.slice(0,7) }),
    "install-info.json": JSON.stringify({ repo: "Senzube4n/AIPLAY-Studio", commit: old }),
    "node/node.exe": "private Node", "node_modules/ws/index.js": "private dependency", "workflows/custom/mine.json": "my workflow" };
  if (missingInstalled) delete installed[missingInstalled];
  const fresh = { ...payload };
  if (missingFresh) delete fresh[missingFresh];
  if (malformedFresh) fresh["install.json"] = "{broken manifest";
  await files(app, installed); await files(src, fresh);
  const archive = path.join(base, "runtime.zip");
  execFileSync(winTar, ["-a","-c","-f",archive,"-C",path.dirname(src),path.basename(src)]);
  const real = globalThis.fetch, asked = [];
  globalThis.fetch = async input => {
    const url = String(input); asked.push(url);
    if (url.includes("/commits/main")) return { ok: true, json: async () => ({ sha, commit: {} }) };
    if (url.includes("/compare/")) return { ok: true, json: async () => ({ status: "ahead", ahead_by: 1, behind_by: 0 }) };
    assert.equal(url, `https://codeload.github.com/Senzube4n/AIPLAY-Studio/zip/${sha}`);
    return new Response(readFileSync(archive));
  };
  t.after(async () => { globalThis.fetch = real; await rm(base, { recursive: true, force: true }); });
  return { app, asked, sha, installed };
}

test("same-commit Update repairs a missing static dependency or validator and keeps personal files", { skip: !canZip }, async t => {
  for (const missingInstalled of ["shared/model-profiles.js", "scripts/verify-install.mjs"]) await t.test(missingInstalled, async t => {
    const { app, asked, sha } = await runtimeFixture(t, { missingInstalled });
    const first = await selfUpdate({ root: app });
    assert.equal(first.ok, true, first.line); assert.equal(first.changed, true); assert.match(first.line, /Repaired runtime files/);
    assert.equal(await readFile(path.join(app,"shared/model-profiles.js"),"utf8"), "export const value = 1;");
    assert.ok(existsSync(path.join(app,"scripts/verify-install.mjs")));
    assert.equal(await readFile(path.join(app,"workflows/custom/mine.json"),"utf8"), "my workflow");
    assert.equal(await readFile(path.join(app,"node/node.exe"),"utf8"), "private Node");
    assert.equal(await readFile(path.join(app,"node_modules/ws/index.js"),"utf8"), "private dependency");
    assert.equal(JSON.parse(await readFile(path.join(app,"install-info.json"),"utf8")).commit, sha);
    assert.equal(asked.filter(url=>url.includes("codeload.github.com")).length, 1);
    const second = await selfUpdate({ root: app });
    assert.equal(second.ok, true, second.line); assert.equal(second.changed, false); assert.equal(second.line, "Already up to date.");
    assert.equal(asked.filter(url=>url.includes("codeload.github.com")).length, 1, "healthy same commit does not download again");
  });
});

test("an invalid downloaded runtime or manifest is rejected before changing any old app file", { skip: !canZip }, async t => {
  for (const options of [{ missingFresh:"shared/model-profiles.js" }, { missingFresh:"scripts/verify-install.mjs" },
    { malformedFresh:true }, { exclude:["model-profiles.js"] }, { omitIncluded:"shared" }]) await t.test(JSON.stringify(options), async t => {
    const { app, installed } = await runtimeFixture(t, { sameCommit:false, ...options });
    const result = await selfUpdate({ root: app });
    assert.equal(result.ok, false); assert.equal(result.changed, false); assert.match(result.line, /validation|validator|manifest/);
    for (const [file, bytes] of Object.entries(installed)) assert.equal(await readFile(path.join(app,file),"utf8"), bytes, file);
    assert.ok(!(await fsPromises.readdir(app)).some(name=>name.includes(".old-")), "validation finishes before any backup/swap starts");
  });
});

test("dependency installation uses the private POSIX Node/npm pair and locked hooks-disabled installs on every platform", () => {
  const prefix = path.resolve("fixture private runtime");
  for (const platform of ["linux", "darwin", "win32"]) {
    const nodePath = path.join(prefix, ...(platform === "win32" ? ["node.exe"] : ["bin", "node"]));
    const cli = platform === "win32" ? path.join(prefix, "node_modules", "npm", "bin", "npm-cli.js")
      : path.join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js");
    const actual = dependencyInstallCommand({ nodePath, platform, exists: file => file === cli });
    assert.equal(actual.command, nodePath); assert.equal(actual.args[0], cli); assert.equal(actual.shell, false);
    assert.deepEqual(actual.args.slice(1), ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]);
    const fallback = dependencyInstallCommand({ nodePath, platform, exists: () => false });
    assert.equal(fallback.command, platform === "win32" ? "npm.cmd" : "npm");
    assert.ok(fallback.args.includes("ci") && fallback.args.includes("--ignore-scripts"));
  }
  assert.throws(() => dependencyInstallCommand({ platform: "freebsd" }), /Unsupported/);
});

test("Linux tarball updates select the Linux payload, validate before replacement, and preserve private runtime/custom workflows", async t => {
  const base = await mkdtemp(path.join(tmpdir(), "aiplay-linux-update-"));
  const realFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = realFetch; await rm(base, { recursive: true, force: true }); });
  const app = path.join(base, "app"), source = path.join(base, "source", "Studio-new");
  const manifest = { include: ["server", "launcher", "shared", "scripts", "workflows", "install.json", "package.json", "package-lock.json", "AIPLAY Studio.exe", "AIPLAY Studio.cmd"],
    required: ["server/index.js", "launcher/launcher.mjs", "shared/profile.js", "scripts/verify-install.mjs", "scripts/install-manifest.mjs", "AIPLAY Studio.exe", "AIPLAY Studio.cmd"],
    platforms: { linux: { omit: ["AIPLAY Studio.exe", "AIPLAY Studio.cmd"] } }, exclude: ["*_test.js"], keep: [], preserve: ["workflows/custom"] };
  const payload = { "install.json": JSON.stringify(manifest), "package.json": '{"type":"module"}', "package-lock.json": "new lock",
    "server/index.js": "import '../shared/profile.js'; throw Error('must not run');", "launcher/launcher.mjs": "export {};",
    "shared/profile.js": "export const profile = true;", "scripts/verify-install.mjs": await readFile(new URL("../scripts/verify-install.mjs", import.meta.url), "utf8"),
    "scripts/install-manifest.mjs": await readFile(new URL("../scripts/install-manifest.mjs", import.meta.url), "utf8"),
    "AIPLAY Studio.exe": "Windows only", "AIPLAY Studio.cmd": "Windows only", "workflows/base.json": "{}" };
  await files(source, payload);
  await files(app, { "server/index.js": "old server", "launcher/launcher.mjs": "old launcher", "package-lock.json": "old lock",
    "server/version.gen.json": '{"commit":"1111111"}', "node/bin/node": "private Node", "node_modules/ws/index.js": "old dependency", "workflows/custom/own.json": "my workflow" });
  const archive = path.join(base, "source.tar.gz");
  execFileSync(process.platform === "win32" ? winTar : "tar", ["-czf", archive, "-C", path.dirname(source), path.basename(source)]);
  const sha = "abcdef0123456789abcdef0123456789abcdef01", requested = [], commands = [];
  globalThis.fetch = async input => {
    const url = String(input); requested.push(url);
    if (url.includes("/commits/main")) return { ok: true, json: async () => ({ sha, commit: {} }) };
    if (url.includes("/compare/")) return { ok: true, json: async () => ({ status: "ahead" }) };
    assert.equal(url, `https://codeload.github.com/Senzube4n/AIPLAY-Studio/tar.gz/${sha}`);
    return new Response(readFileSync(archive));
  };
  const command = async (cmd, args, opts) => {
    commands.push([cmd, ...args]);
    if (args.includes("--experimental-vm-modules")) {
      assert.equal(await readFile(path.join(app, "server/index.js"), "utf8"), "old server", "old app remains until actual checker completes");
      assert.deepEqual(args.slice(-2), ["--platform", "linux"]);
      return execFileSync(cmd, args, { ...opts, encoding: "utf8", windowsHide: true });
    }
    assert.ok(args.includes("ci") && args.includes("--ignore-scripts")); return "";
  };
  const result = await selfUpdate({ root: app, platform: "linux", command });
  assert.equal(result.ok, true, result.line); assert.equal(result.changed, true);
  assert.equal(await readFile(path.join(app, "server/index.js"), "utf8"), payload["server/index.js"]);
  assert.equal(await readFile(path.join(app, "node/bin/node"), "utf8"), "private Node");
  assert.equal(await readFile(path.join(app, "workflows/custom/own.json"), "utf8"), "my workflow");
  assert.equal(existsSync(path.join(app, "AIPLAY Studio.exe")), false); assert.equal(existsSync(path.join(app, "AIPLAY Studio.cmd")), false);
  assert.equal(commands.length, 2); assert.equal(requested.filter(url => url.includes("codeload")).length, 1);
});

test("unsupported updater platforms refuse before any network or command", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw Error("must not fetch"); };
  try {
    const result = await selfUpdate({ platform: "freebsd", command: async () => { throw Error("must not run"); } });
    assert.equal(result.ok, false); assert.equal(result.changed, false); assert.match(result.line, /Unsupported/);
  } finally { globalThis.fetch = original; }
});
