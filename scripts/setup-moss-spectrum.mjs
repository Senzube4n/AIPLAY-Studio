/** Optional standalone Spectrum source setup. Imports/help/plan/verify never install. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile, mkdir } from "node:fs/promises";
import { MOSS_SPECTRUM } from "../server/moss-presets.js";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const exists = async file => { try { await lstat(file); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } };
async function ordinaryParents(dir) {
  for (let current = dir; ; current = path.dirname(current)) {
    const s = await lstat(current);
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("Installation folders must be ordinary directories, without linked parents: " + current);
    if (path.dirname(current) === current) return;
  }
}
async function exactFile(file, expected) {
  const s = await lstat(file);
  if (!s.isFile() || s.isSymbolicLink() || s.size !== expected.bytes) throw new Error("Source size/type mismatch: " + path.basename(file));
  if (digest(await readFile(file)) !== expected.sha256) throw new Error("Source SHA256 mismatch: " + path.basename(file));
}
async function boundedSource(fetcher, url, expected) {
  const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error("Source download failed: " + expected.file + " (HTTP " + response.status + ").");
  const length = response.headers?.get("content-length");
  const encoding = response.headers?.get("content-encoding")?.trim().toLowerCase();
  // Fetch exposes decoded body bytes; a compressed Content-Length measures
  // the transport body. The decoded stream still has exact size/hash bounds.
  if ((!encoding || encoding === "identity") && length != null && Number(length) !== expected.bytes) throw new Error("Source length mismatch: " + expected.file);
  const chunks = []; let bytes = 0;
  for await (const part of response.body) {
    const chunk = Buffer.from(part); bytes += chunk.length;
    if (bytes > expected.bytes) throw new Error("Source download exceeds its pinned size: " + expected.file);
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  if (bytes !== expected.bytes || digest(buffer) !== expected.sha256) throw new Error("Source SHA256/size mismatch: " + expected.file);
  return buffer;
}

/** The injection seam is for CPU fixtures; the CLI always uses the shipped pin. */
export async function setupMossSpectrum({ comfyDir, execute = false, verify = false, writeMarker = false } = {},
  { pin = MOSS_SPECTRUM, fetcher = globalThis.fetch, write = writeFile } = {}) {
  if (typeof comfyDir !== "string" || !path.isAbsolute(comfyDir)) throw new Error("Pass an absolute --comfy-dir path. Studio settings are not used or changed.");
  if (verify && (execute || writeMarker)) throw new Error("Use --verify alone, or --execute to write.");
  if (writeMarker && !execute) throw new Error("--write-marker needs explicit --execute.");
  if (!/^[a-f0-9]{40}$/.test(pin.commit) || pin.folder !== "ComfyUI-Spectrum-MOSS" || pin.marker !== ".aiplay-source-pin.json"
    || pin.files.length !== 8 || new Set(pin.files.map(f => f.file)).size !== 8
    || !pin.files.some(f => f.file === "LICENSE")
    || pin.files.some(f => path.basename(f.file) !== f.file || !Number.isSafeInteger(f.bytes) || f.bytes < 1 || !/^[a-f0-9]{64}$/.test(f.sha256))) throw new Error("Invalid shipped Spectrum pin.");
  const target = path.resolve(comfyDir), custom = path.join(target, "custom_nodes"), destination = path.join(custom, pin.folder);
  await ordinaryParents(custom);
  const main = await lstat(path.join(target, "main.py"));
  if (!main.isFile() || main.isSymbolicLink()) throw new Error("The target must contain an ordinary ComfyUI main.py.");
  const base = { destination, repository: pin.repository, commit: pin.commit, version: pin.version,
    files: pin.files, settingsChanged: false, dependenciesInstalled: false, engineStarted: false };
  const checkFiles = async () => {
    await ordinaryParents(destination);
    for (const file of pin.files) await exactFile(path.join(destination, file.file), file);
  };
  const markerFile = path.join(destination, pin.marker);
  if (verify) {
    await checkFiles();
    if (!await exists(markerFile)) throw new Error("Exact source files match, but the source marker is missing. Review the pin, then use --execute --write-marker.");
    const s = await lstat(markerFile);
    if (!s.isFile() || s.isSymbolicLink() || s.size > 16384) throw new Error("Invalid source marker. Do not overwrite it; inspect the installation.");
    const marker = JSON.parse(await readFile(markerFile, "utf8"));
    if (marker.schemaVersion !== 1 || marker.repository !== pin.repository || marker.commit !== pin.commit || marker.version !== pin.version
      || !Array.isArray(marker.files) || marker.files.length !== pin.files.length
      || pin.files.some(f => !marker.files.some(m => m.file === f.file && m.bytes === f.bytes && m.sha256 === f.sha256))) throw new Error("Source marker mismatch. Do not overwrite it; inspect the installation.");
    return { ...base, phase: "verified", verifiedSourceFiles: pin.files.length, networkUsed: false, filesWritten: 0 };
  }
  if (!execute) return { ...base, phase: "planned", networkUsed: false, filesWritten: 0,
    next: "Review the exact pin, then repeat with --execute. Use --verify for an existing installation." };
  if (writeMarker) {
    await checkFiles();
    if (await exists(markerFile)) throw new Error("Source marker already exists. Use --verify; existing markers are never overwritten.");
  } else {
    if (await exists(destination)) throw new Error("Destination already exists. Inspect it or use --verify; existing/partial installations are never overwritten.");
    const sources = [];
    for (const file of pin.files) sources.push(await boundedSource(fetcher,
      "https://raw.githubusercontent.com/Rkkss/ComfyUI-Spectrum-MOSS/" + pin.commit + "/" + file.file, file));
    // Recheck paths after network IO. Exclusive mkdir + wx files also refuse a
    // concurrent installer; POSIX rename cannot replace an empty user's folder.
    await ordinaryParents(custom);
    await mkdir(destination);
    try {
      for (let i = 0; i < pin.files.length; i++) await write(path.join(destination, pin.files[i].file), sources[i], { flag: "wx" });
      await checkFiles();
    } catch (err) { throw new Error("Partial installation preserved at " + destination + ". Inspect it before another attempt. " + err.message); }
  }
  const marker = { schemaVersion: 1, repository: pin.repository, commit: pin.commit, version: pin.version,
    installedAt: new Date().toISOString(), files: pin.files };
  try { await write(markerFile, JSON.stringify(marker, null, 2) + "\n", { flag: "wx" }); }
  catch (err) { throw new Error("Source marker was not completed at " + destination + ". Inspect it; no blind retry. " + err.message); }
  return { ...base, phase: writeMarker ? "marker-created" : "installed", verifiedSourceFiles: pin.files.length,
    networkUsed: !writeMarker, filesWritten: writeMarker ? 1 : pin.files.length + 1, restartRequired: true,
    next: "Use Studio's ordinary restart when idle, then run moss_image_status for the chosen preset." };
}

export function spectrumSetupArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--comfy-dir") { if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error("--comfy-dir needs an absolute path."); out.comfyDir = args[++i]; }
    else if (a === "--execute") out.execute = true;
    else if (a === "--verify") out.verify = true;
    else if (a === "--write-marker") out.writeMarker = true;
    else throw new Error("Unknown option: " + a);
  }
  return out;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = spectrumSetupArgs(process.argv.slice(2));
    if (args.help) console.log("Optional Spectrum source setup\nnode scripts/setup-moss-spectrum.mjs --comfy-dir <absolute ComfyUI folder> [--execute | --verify]\nExisting exact checkout without marker: --execute --write-marker\nNo pip, Python execution, model download, engine restart or settings changes.");
    else console.log(JSON.stringify(await setupMossSpectrum(args), null, 2));
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}
