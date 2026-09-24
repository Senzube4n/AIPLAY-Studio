/**
 * THE KEPT UV — one pinned, checksum-checked copy of uv for every Python
 * environment Studio builds.
 *
 * uv (astral-sh/uv, Apache-2.0 or MIT) fetches a standalone Python and builds
 * environments with it, so nothing here needs a system Python. The engine
 * installer used to download the LATEST uv into its download cache and delete
 * it with the cache, which left nothing for the next environment (timed lyrics,
 * server/setup/venv.js) to build with. Now:
 *
 *   - the version is pinned (server/setup/pins.js), and the archive must hash
 *     to the SHA-256 its release publishes, or it is deleted and not run;
 *   - it lives at <app data>\tools\uv\uv.exe, outside every engine and cache
 *     folder, so no failure path and no cleanup removes it;
 *   - a receipt (uv.json) beside it names the version and checksum it was
 *     verified against, so a kept copy is reused without a download, and a
 *     changed pin fetches the new one.
 *
 * Node built-ins only: scripts/install-engine.mjs imports this on a machine
 * where Studio's server has never started.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rm, rename, readdir, chmod } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { uvPin, keptUvDir, keptUvPath } from "./pins.js";

const run = promisify(execFile);

async function readJson(p) { try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; } }

/** Download `url` to `file`, hashing as it streams; resolves the hex SHA-256. */
async function downloadHashed(url, file, fetchImpl) {
  const res = await fetchImpl(url, { redirect: "follow", headers: { "User-Agent": "AIPLAY-Studio-installer" } }).catch((e) => {
    throw new Error(`Could not reach ${new URL(url).host} to download uv (${e?.cause?.code || e?.message || e}). `
      + "Check the internet connection, or a firewall or VPN that blocks it.");
  });
  if (!res?.ok || !res.body) throw new Error(`Could not download uv (${res?.status ?? "no answer"} ${res?.statusText || ""}): ${url}`.trim());
  const total = Number(res.headers?.get?.("content-length")) || 0;
  const hash = createHash("sha256");
  let got = 0;
  /* Counted and hashed inside the pipeline: a 'data' listener on the source
   * starts it flowing before the pipe is attached and loses the first chunks
   * (measured in install-engine.mjs: a truncated uv zip tar could not open). */
  const tap = new Transform({ transform(c, _e, cb) { got += c.length; hash.update(c); cb(null, c); } });
  const body = typeof res.body.getReader === "function" ? Readable.fromWeb(res.body) : res.body;
  await pipeline(body, tap, createWriteStream(file));
  if (total && got !== total) throw new Error(`The uv download stopped early (${got} of ${total} bytes): ${url}`);
  return hash.digest("hex");
}

/** Windows' own bsdtar reads .zip and .tar.gz; Git's GNU tar earlier on PATH does not. */
async function extract(archive, dest, platform) {
  await mkdir(dest, { recursive: true });
  const tar = platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
  await run(tar, ["-xf", archive, "-C", dest], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
}

async function findFile(dir, name) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) { const hit = await findFile(p, name); if (hit) return hit; }
  }
  return null;
}

/**
 * The path of a verified uv, downloading it once if it is not kept yet.
 * `pin`, `fetchImpl` and `platform` are parameters so the test can serve a
 * fixture archive with its own checksum and never touch the network.
 */
export async function ensureUv({ appData, log = () => {}, fetchImpl = globalThis.fetch, pin = uvPin(), platform = process.platform } = {}) {
  if (!appData) throw new Error("ensureUv needs Studio's data folder.");
  const dir = keptUvDir(appData);
  const exe = keptUvPath(appData, platform);
  const receiptFile = path.join(dir, "uv.json");
  const receipt = await readJson(receiptFile);
  if (existsSync(exe) && receipt?.version === pin.version && receipt?.sha256 === pin.sha256) {
    log(`Using the kept uv ${pin.version}: ${exe}`);
    return exe;
  }
  if (!pin.sha256) {
    throw new Error(`Studio has no published checksum for ${pin.asset}, so it will not download uv for this machine.`);
  }
  const work = path.join(appData, "tools", "uv-download");
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  try {
    const archive = path.join(work, pin.asset);
    log(`Downloading uv ${pin.version} (kept at ${dir} for later setups): ${pin.url}`);
    const sha = await downloadHashed(pin.url, archive, fetchImpl);
    if (sha !== pin.sha256) {
      throw new Error(`The uv download did not match its published checksum, so it was deleted and not run `
        + `(expected ${pin.sha256}, got ${sha}). Something between this PC and github.com changed it, `
        + "such as antivirus or a proxy.");
    }
    log(`uv ${pin.version}: the checksum matches the published one.`);
    const unpack = path.join(work, "unpacked");
    await extract(archive, unpack, platform);
    const found = await findFile(unpack, path.basename(exe));
    if (!found) throw new Error(`The uv archive ${pin.asset} has no ${path.basename(exe)} in it.`);
    await mkdir(dir, { recursive: true });
    await rm(exe, { force: true });
    await rename(found, exe);   // both under <app data>\tools: one volume
    if (platform !== "win32") await chmod(exe, 0o755);
    await writeFile(receiptFile, `${JSON.stringify({
      version: pin.version, asset: pin.asset, sha256: pin.sha256, url: pin.url, verifiedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    return exe;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
