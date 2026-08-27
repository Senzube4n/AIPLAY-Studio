/**
 * DAW — patch packs: the registry rows and the on-demand downloader.
 *
 * The About-page model idiom (server/models.js), cut to the palette's needs:
 *  - NOTHING auto-downloads. A licence is SHOWN before a byte moves — the
 *    install route refuses without accept_licence and echoes every licence
 *    the install would pull (a pack plus, for SF2 patches, the FluidSynth
 *    runtime).
 *  - Samples land OUTSIDE the repo, under <appData>/daw/instruments
 *    (AIPLAY_DAW_INSTRUMENTS overrides), the same on-demand pattern as the
 *    11 GB model weights.
 *  - Progress is a polled state row per pack (received/total/state), served
 *    by GET /api/daw/patches while a download runs.
 *  - Installed-ness is FILESYSTEM truth (the manifest's `expect` paths all
 *    present and non-empty), never a flag that can drift.
 *
 * Archives are unpacked with bsdtar — on Windows the OS's own
 * C:\Windows\System32\tar.exe, which reads zip, 7z, tar.gz and tar.xz alike.
 * The generated VSCO2 mappings ship IN the repo (server/daw/sfz/*.sfz,
 * `repo_files` in the manifest) and are copied into the pack at install —
 * the repo carries mappings measured against the samples, never the samples.
 */
import { createWriteStream } from "node:fs";
import { mkdir, stat, rename, rm, unlink, copyFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PATCH_MANIFEST, PATCHES } from "./store.js";
import { config } from "../config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Where the palette lives. instruments.py defaults to ~/.aiplay-studio/...
 *  on its own (CLI/tests); the server passes THIS path in every job, so the
 *  render engine always follows the server's idea of the directory. */
export function instrumentsDir() {
  return process.env.AIPLAY_DAW_INSTRUMENTS
    || path.join(config.paths.appData, "daw", "instruments");
}

const TAR = process.platform === "win32"
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
  : "tar";

/* One state row per pack while an install runs; cleared on success. */
const states = new Map(); // packId -> { state, received, total, error?, at }

export const packState = (id) => states.get(id) || null;

async function fileOk(p) {
  try { return (await stat(p)).size > 0; } catch { return false; }
}

/** Filesystem truth: every `expect` path present and non-empty. */
export async function packInstalled(packId) {
  const pack = PATCH_MANIFEST.packs[packId];
  if (!pack) return false;
  const dir = instrumentsDir();
  for (const rel of pack.expect || []) {
    if (!(await fileOk(path.join(dir, ...rel.split("/"))))) return false;
  }
  return true;
}

/** A patch is installed when its pack is (builtins always; generate never —
 *  and SF2 patches also need the fluidsynth runtime pack). */
export async function patchInstalled(pid) {
  const row = PATCHES[pid];
  if (!row) return false;
  if (row.kind === "builtin") return true;
  if (row.kind === "generate") return false;
  if (!(await packInstalled(row.pack))) return false;
  if (row.kind === "sf2" && !(await packInstalled("fluidsynth"))) return false;
  return true;
}

/** Every pack an install of `pid` would need that is not yet on disk. */
export async function packsNeededFor(pid) {
  const row = PATCHES[pid];
  if (!row || row.kind === "builtin" || row.kind === "generate") return [];
  const need = [];
  if (row.kind === "sf2" && !(await packInstalled("fluidsynth"))) need.push("fluidsynth");
  if (!(await packInstalled(row.pack))) need.push(row.pack);
  return need;
}

/** The registry rows the patch-picker binds to (and daw_patches serves). */
export async function listPatches() {
  const out = [];
  for (const [pid, row] of Object.entries(PATCHES)) {
    const pack = row.pack ? PATCH_MANIFEST.packs[row.pack] : null;
    out.push({
      id: pid,
      family: row.family,
      label: row.label,
      kind: row.kind,
      quality: row.quality || null,
      tail: row.tail,
      installed: await patchInstalled(pid),
      refusal: row.refusal || null,
      gm_programs: !!row.gm_programs,
      /* The patch's own knobs, straight out of the manifest. store.js's
       * normParams validates against these same rows and drums.py clamps
       * against them, so what a caller reads here is exactly what it may
       * send back — no second table to keep in step. */
      params: row.params || null,
      pack: pack ? {
        id: row.pack,
        label: pack.label,
        bytes: pack.bytes ?? null,
        licence: pack.licence,
        attribution: pack.attribution,
        attribution_required: !!pack.attribution_required,
        source: pack.source,
        installed: await packInstalled(row.pack),
        downloading: packState(row.pack),
      } : null,
    });
  }
  return out;
}

async function fetchTo(url, dest, onBytes) {
  await mkdir(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`${res.status} fetching ${url}`);
  const tmp = dest + `.part-${process.pid}`;
  let received = 0;
  const counter = async function* (src) {
    for await (const chunk of src) {
      received += chunk.length;
      onBytes?.(chunk.length);
      yield chunk;
    }
  };
  await pipeline(counter(Readable.fromWeb(res.body)), createWriteStream(tmp));
  await rename(tmp, dest);
  return received;
}

function untar(archive, into, strip) {
  return new Promise((resolve, reject) => {
    const args = ["-xf", archive, "-C", into];
    if (strip) args.push(`--strip-components=${strip}`);
    const proc = spawn(TAR, args, { windowsHide: true });
    let se = "";
    proc.stderr.on("data", (d) => { se += d; });
    proc.on("error", (e) => reject(new Error(`could not run ${TAR}: ${e.message}`)));
    proc.on("close", (code) => code === 0 ? resolve()
      : reject(new Error(`extract failed (${code}): ${se.slice(-300)}`)));
  });
}

/**
 * Install one pack. Serialised per pack; progress lands in `states` for the
 * route to poll. The caller has already shown the licence and collected the
 * accept — this function moves bytes and verifies, nothing else.
 */
export async function installPack(packId) {
  const pack = PATCH_MANIFEST.packs[packId];
  if (!pack) throw new Error(`No such pack: ${packId}`);
  if (states.get(packId)?.state === "downloading" || states.get(packId)?.state === "extracting") {
    return { already: "in-flight" };
  }
  const dir = instrumentsDir();
  const st = { state: "downloading", received: 0, total: pack.download.bytes
    ?? (pack.download.files?.reduce((a, f) => a + (f.bytes || 0), 0) || null), at: Date.now() };
  states.set(packId, st);
  try {
    const dl = pack.download;
    if (dl.kind === "archive") {
      const archive = path.join(dir, "_dl", `${packId}${extOf(dl.url)}`);
      await fetchTo(dl.url, archive, (n) => { st.received += n; });
      st.state = "extracting";
      const into = path.join(dir, ...dl.into.split("/"));
      await mkdir(into, { recursive: true });
      await untar(archive, into, dl.strip || 0);
      unlink(archive).catch(() => {});
    } else {
      const packDir = packDirOf(packId);
      for (const f of dl.files) {
        const dest = path.join(dir, packDir, ...f.dest.split("/"));
        if (await fileOk(dest)) { st.received += f.bytes || 0; continue; }
        await fetchTo(f.url, dest, (n) => { st.received += n; });
      }
    }
    for (const rf of dl.repo_files || []) {
      const dest = path.join(dir, packDirOf(packId), rf.dest);
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(path.join(HERE, ...rf.src.split("/")), dest);
    }
    const missing = [];
    for (const rel of pack.expect || []) {
      if (!(await fileOk(path.join(dir, ...rel.split("/"))))) missing.push(rel);
    }
    if (missing.length) {
      throw new Error(`install verified INCOMPLETE — missing: ${missing.join(", ")}`);
    }
    states.delete(packId);
    return { installed: packId };
  } catch (err) {
    states.set(packId, { state: "error", error: String(err.message || err), at: Date.now() });
    throw err;
  }
}

const extOf = (url) => {
  const m = /(\.tar\.(gz|xz|bz2)|\.(zip|7z|tgz))($|\?)/.exec(url);
  return m ? m[1] || `.${m[3]}` : ".bin";
};

/** A pack's own directory under the instruments dir (for uninstall/copies). */
function packDirOf(packId) {
  const pack = PATCH_MANIFEST.packs[packId];
  if (pack.download.kind === "archive") return pack.download.into;
  // files-kind packs land under packs/<id> (their expect paths say so)
  return `packs/${packId}`;
}

export async function uninstallPack(packId) {
  const pack = PATCH_MANIFEST.packs[packId];
  if (!pack) throw new Error(`No such pack: ${packId}`);
  const dir = path.join(instrumentsDir(), ...packDirOf(packId).split("/"));
  await rm(dir, { recursive: true, force: true });
  states.delete(packId);
  return { uninstalled: packId };
}

/** The licence payload shown BEFORE any download — one row per pack the
 *  install would pull. This is what accept_licence accepts. */
export function licenceGate(packIds) {
  return packIds.map((id) => {
    const p = PATCH_MANIFEST.packs[id];
    return {
      pack: id, label: p.label,
      bytes: p.bytes ?? p.download.bytes ?? null,
      licence: p.licence, attribution: p.attribution,
      attribution_required: !!p.attribution_required,
      source: p.source,
    };
  });
}

/** Read a pack's bundled licence text from disk (post-install display). */
export async function licenceText(packId) {
  const pack = PATCH_MANIFEST.packs[packId];
  if (!pack) return null;
  for (const rel of pack.expect || []) {
    if (/licen[cs]e/i.test(rel)) {
      try { return await readFile(path.join(instrumentsDir(), ...rel.split("/")), "utf8"); }
      catch { return null; }
    }
  }
  return null;
}
