/**
 * THE LAUNCHER'S UPDATE BUTTON: bring this install up to the newest `main`.
 *
 * Two kinds of install, two ways, one button:
 *
 *   A GIT CLONE      `git pull --ff-only` from its own remote. Refused when the
 *                    tree has uncommitted changes: an update must never be the
 *                    thing that merges into somebody's work in progress.
 *   ANYTHING ELSE    a GitHub "Download ZIP", the installer's install, a zip
 *                    from package.mjs. It downloads the newest commit of the
 *                    repository this install came from, unpacks it, and
 *                    replaces exactly what that commit's install.json lists,
 *                    folder by folder, then stamps server/version.gen.json.
 *
 * NEVER TOUCHED: the private Node.js (.\node), node_modules (refreshed by npm
 * only when package-lock.json changed), and everything in ~/.aiplay-studio,
 * where songs, settings and any engine live. Nothing here touches ComfyUI,
 * Python or a model.
 *
 * Which repository: whichever build is AHEAD. Senzu's and Bucky's builds are
 * both asked for their newest `main` (plus this install's own repository when
 * it is some other fork), GitHub compares them, and the one that contains the
 * others' commits wins. Level or diverged, Senzu's build, the main one, wins.
 * install-info.json (written by the installer), else package.json's lineage,
 * else the original, is still what updateSource() reports as the install's own.
 * A git clone is not redirected: it pulls its own tracking branch.
 *
 * The caller (launcher/launcher.mjs) refuses while Studio runs: server files
 * would change under a live process.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, rename, readdir, stat, cp, mkdir } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT_DEFAULT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGINAL = "Senzube4n/AIPLAY-Studio";
/* The builds an update chooses between, in the order a tie goes. */
export const BUILDS = [
  { repo: ORIGINAL, label: "Senzu's build" },
  { repo: "bani4kaskashka/AIPLAY-Studio-Bucky-Fork", label: "Bucky's build" },
];
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HEADERS = { "User-Agent": "AIPLAY-Studio", Accept: "application/vnd.github+json" };
const DEFAULT_INCLUDE = ["server", "web", "workflows", "launcher", "scripts", "package.json", "package-lock.json",
  "AIPLAY Studio.exe", "AIPLAY Studio.cmd", "LICENSE", "NOTICE"];

const run = (cmd, args, opts = {}) => new Promise((ok, fail) => {
  execFile(cmd, args, { windowsHide: true, maxBuffer: 16 << 20, ...opts }, (err, stdout, stderr) => {
    if (err) { err.message = `${err.message}\n${stderr || ""}`.trim(); fail(err); } else ok(String(stdout).trim());
  });
});
const readJson = async (f) => { try { return JSON.parse(await readFile(f, "utf8")); } catch { return null; } };

/** Where this install updates from, and how. */
export async function updateSource(root = ROOT_DEFAULT) {
  if (existsSync(path.join(root, ".git"))) {
    const upstream = await run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd: root }).catch(() => "");
    return { kind: "git", upstream };
  }
  const info = await readJson(path.join(root, "install-info.json"));
  const pkg = await readJson(path.join(root, "package.json"));
  const repo = info?.repo || pkg?.aiplay?.lineage?.repo || ORIGINAL;
  const gen = await readJson(path.join(root, "server", "version.gen.json"));
  const arc = await readJson(path.join(root, "server", "version.archive.json"));
  const have = gen?.commit || (arc?.commit && !arc.commit.includes("$Format") ? arc.commit : "") || info?.commit || "";
  return { kind: "zip", repo, have: String(have).slice(0, 7) };
}

async function gh(url) {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
  if (r.status === 403 || r.status === 429) throw new Error("GitHub is limiting requests from this address (60 an hour without an account). Try again later.");
  if (!r.ok) throw new Error(`GitHub answered ${r.status}.`);
  return r.json();
}

/**
 * The build to update to: the newest `main` of every candidate, and the one
 * that is ahead of the rest. A candidate GitHub cannot answer for is skipped;
 * a comparison it cannot make keeps the build already leading. Throws only
 * when no candidate answered at all.
 */
export async function forwardBuild(ownRepo) {
  const cands = [...BUILDS];
  if (REPO_RE.test(ownRepo || "") && !cands.some((b) => b.repo.toLowerCase() === ownRepo.toLowerCase())) {
    cands.push({ repo: ownRepo, label: ownRepo });
  }
  const heads = [];
  let firstError = null;
  for (const c of cands) {
    try {
      const head = await gh(`https://api.github.com/repos/${c.repo}/commits/main`);
      const sha = String(head?.sha || "");
      if (/^[0-9a-f]{7,40}$/i.test(sha)) heads.push({ ...c, sha, date: head.commit?.committer?.date || "" });
    } catch (e) { firstError ||= e; }
  }
  if (!heads.length) throw firstError || new Error("GitHub returned an invalid commit.");
  let best = heads[0], note = "";
  for (const c of heads.slice(1)) {
    if (c.sha === best.sha) continue;
    try {
      /* base...head across the fork network: "ahead" means head has commits
       * base lacks and none the other way. */
      const cmp = await gh(`https://api.github.com/repos/${best.repo}/compare/${best.sha}...${c.sha}`);
      if (cmp?.status === "ahead") { note = `${c.label} is ${cmp.ahead_by} commit${cmp.ahead_by === 1 ? "" : "s"} ahead of ${best.label}`; best = c; }
      else if (cmp?.status === "diverged") note = `${best.label} and ${c.label} have each moved on; staying with ${best.label}`;
    } catch { /* cannot compare: keep the leader */ }
  }
  return { ...best, note };
}

/** Keep every backup until every replacement is in place. A late copy failure
 * restores earlier folders as well as the one that failed. */
async function replaceAppFiles({ root, fresh, include, exclude, keep, preserve }) {
  const entries = [];
  const stamp = `${Date.now()}-${process.pid}`;
  for (const name of include) {
    if (typeof name !== "string" || !name || name === "." || name === ".." || /[\\/:]/.test(name)) {
      throw new Error("install.json include entries must be top-level app files or folders.");
    }
  }
  try {
    for (const name of [...new Set(include)]) {
      const from = path.join(fresh, name), to = path.join(root, name);
      if (!existsSync(from)) continue;
      const directory = (await stat(from)).isDirectory();
      if (directory) await prune(from, exclude, keep);
      const old = existsSync(to) ? `${to}.old-${stamp}` : null;
      if (old) await rename(to, old);
      entries.push({ to, old });
      await cp(from, to, { recursive: directory });
      if (directory && old) for (const p of preserve) {
        const rel = path.relative(name, p);
        if (rel.startsWith("..") || path.isAbsolute(rel) || !existsSync(path.join(old, rel))) continue;
        await cp(path.join(old, rel), path.join(to, rel), { recursive: true, force: false, errorOnExist: false });
      }
    }
  } catch (e) {
    const failed = [];
    for (const { to, old } of entries.reverse()) {
      try {
        await rm(to, { recursive: true, force: true });
        if (old) await rename(old, to);
      } catch { failed.push(old || to); }
    }
    if (failed.length) {
      e.rollbackFailed = true;
      e.message += `; could not restore all files. Keep these recovery paths: ${failed.join(", ")}`;
    }
    throw e;
  }
  for (const { old } of entries) if (old) await rm(old, { recursive: true, force: true }).catch(() => {});
}

/** `*.md` style patterns against a file name. */
function matches(name, patterns) {
  return patterns.some((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i").test(name));
}

async function prune(dir, exclude, keep) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await prune(p, exclude, keep);
    else if (matches(e.name, exclude) && !matches(e.name, keep)) await rm(p, { force: true });
  }
}

/** Unpack a zip with what the machine has: Windows' own tar.exe (bsdtar reads
 *  zip), else unzip. No npm dependency for a thing done once a week. */
async function unzip(zip, into) {
  const winTar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  if (process.platform === "win32" && existsSync(winTar)) return run(winTar, ["-xf", zip, "-C", into]);
  try { return await run("unzip", ["-q", zip, "-d", into]); }
  catch { return run("tar", ["-xf", zip, "-C", into]); }
}

/**
 * Update. `say(line)` receives progress, one sentence at a time.
 * Returns { ok, changed, line, restart } — never throws for the ordinary
 * refusals (offline, dirty tree, already current); those come back as `line`.
 */
export async function selfUpdate({ root = ROOT_DEFAULT, say = () => {}, command = run } = {}) {
  const src = await updateSource(root);
  const dependencies = async (lockBefore, changed, line) => {
    try { await npmIfChanged(root, lockBefore, say, command); }
    catch (e) { return { ok: false, changed, restart: changed, line: `${changed ? "App files updated, but" : "The pending"} dependency install failed: ${e.message}. Press Update again to retry before starting Studio.` }; }
    return { ok: true, changed, restart: changed, line };
  };

  if (src.kind === "git") {
    say("Checking for changes of your own…");
    if ((await command("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root })).length) {
      return { ok: false, changed: false, line: "This folder has changes that are not committed. Commit or stash them, then update — an update never merges into work in progress." };
    }
    const before = await command("git", ["rev-parse", "HEAD"], { cwd: root });
    const lockBefore = await readFile(path.join(root, "package-lock.json"), "utf8").catch(() => "");
    say("Pulling from GitHub…");
    try { await command("git", ["pull", "--ff-only"], { cwd: root, timeout: 120_000 }); }
    catch (e) {
      return { ok: false, changed: false, line: /not possible to fast-forward|diverg/i.test(e.message)
        ? "This clone has commits the remote does not; an update will not merge them. Pull by hand."
        : `git pull failed: ${e.message.split("\n").find(Boolean)}` };
    }
    const after = await command("git", ["rev-parse", "HEAD"], { cwd: root });
    if (after === before) return dependencies(lockBefore, false, "Already up to date.");
    return dependencies(lockBefore, true, `Updated ${before.slice(0, 7)} → ${after.slice(0, 7)}. Close the launcher and open it again to use the new version.`);
  }

  say("Asking GitHub which build is ahead…");
  let pick;
  try { pick = await forwardBuild(src.repo); }
  catch (e) { return { ok: false, changed: false, line: e.name === "TimeoutError" ? "GitHub did not answer in time." : e.message }; }
  const { sha, date, repo, label, note } = pick;
  if (note) say(`${note}.`);
  if (src.have && sha.startsWith(src.have)) {
    const lock = await readFile(path.join(root, "package-lock.json"), "utf8").catch(() => "");
    return dependencies(lock, false, "Already up to date.");
  }

  const work = await mkdtemp(path.join(tmpdir(), "aiplay-update-"));
  try {
    say(`Downloading ${sha.slice(0, 7)}…`);
    const zip = path.join(work, "studio.zip");
    const res = await fetch(`https://codeload.github.com/${repo}/zip/${sha}`, { headers: { "User-Agent": HEADERS["User-Agent"] }, signal: AbortSignal.timeout(600_000) });
    if (!res.ok || !res.body) return { ok: false, changed: false, line: `The download failed (${res.status}).` };
    await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));

    say("Unpacking…");
    const out = path.join(work, "x");
    await mkdir(out);
    await unzip(zip, out);
    const top = (await readdir(out))[0];
    const fresh = path.join(out, top || "");
    if (!top || !existsSync(path.join(fresh, "launcher", "launcher.mjs"))) {
      return { ok: false, changed: false, line: "The download is not a Studio build (no launcher inside). Nothing was changed." };
    }
    const manifest = await readJson(path.join(fresh, "install.json"));
    const include = [...(manifest?.include || DEFAULT_INCLUDE)];
    const exclude = manifest ? manifest.exclude || [] : ["*.md"];
    const keep = manifest ? manifest.keep || [] : ["LICENSE*", "NOTICE*"];
    /* Folders inside the app that hold the person's own files. They come
     * across from the old copy; a file the new build also ships wins. */
    const preserve = manifest?.preserve || ["workflows/custom"];

    say("Replacing the app files…");
    const lockBefore = await readFile(path.join(root, "package-lock.json"), "utf8").catch(() => "");
    await writeFile(path.join(fresh, "server", "version.gen.json"), JSON.stringify({
      commit: sha.slice(0, 7), date, modified: false, base: null, at: new Date().toISOString(), via: "launcher update", repo,
    }));
    const info = await readJson(path.join(root, "install-info.json"));
    if (info) {
      await writeFile(path.join(fresh, "install-info.json"), JSON.stringify({ ...info, repo, commit: sha, date, updatedAt: new Date().toISOString() }));
      include.push("install-info.json");
    }
    await replaceAppFiles({ root, fresh, include, exclude, keep, preserve });
    return dependencies(lockBefore, true, `Updated to ${sha.slice(0, 7)} from ${label}${note ? ` (${note})` : ""}. Close the launcher and open it again to use the new version.`);
  } catch (e) {
    return { ok: false, changed: !!e.rollbackFailed, line: `The update stopped: ${e.message}` };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** npm only when the dependency list moved, with the Node.js this runs on. */
async function npmIfChanged(root, lockBefore, say, command = run) {
  const lockAfter = await readFile(path.join(root, "package-lock.json"), "utf8").catch(() => "");
  const pending = path.join(root, ".aiplay-update-npm-pending");
  if (lockAfter === lockBefore && !existsSync(pending)) return;
  await writeFile(pending, "Dependency installation needs to finish before starting Studio.\n");
  say("Updating Studio's npm packages…");
  const cli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(cli)) await command(process.execPath, [cli, "install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: root, timeout: 600_000 });
  else await command(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: root, timeout: 600_000, shell: process.platform === "win32" });
  await rm(pending, { force: true });
}
