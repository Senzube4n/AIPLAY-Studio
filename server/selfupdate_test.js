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
  assert.match(h, /id="verUpdate"/);
  /* Under the exe host the footer's sentence was written with $("foot").textContent,
   * which wiped the whole footer: the version line and both buttons never showed. */
  assert.doesNotMatch(h, /\$\("foot"\)\.textContent/);
  assert.match(h, /\$\("footText"\)\.textContent = st\.host === "exe"/);
  assert.match(h, /Your songs, settings and models are not touched/);
  assert.match(readFileSync(new URL("../install.json", import.meta.url), "utf8"), /"preserve": \[\s*"workflows\/custom"/);
  assert.match(readFileSync(new URL("../installer/Setup.cs", import.meta.url), "utf8"), /CopyMissing\(from, Path\.Combine\(stage/, "the installer's reinstall keeps them too");
});
