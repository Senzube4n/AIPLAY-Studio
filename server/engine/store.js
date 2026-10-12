/**
 * Where the engine door's evidence lives on disk.
 *
 * Three jobs, one file, because all three are "the record needs a fact the
 * graph does not contain":
 *
 *   1. THE GRAPH STORE, content-addressed.  <appData>/provenance/graphs/
 *   2. FILE FACTS, with the expensive half cached.  bytes + mtime always; the
 *      SHA-256 of a 21 GB transformer only when somebody asked for it.
 *   3. THE UNRECORDED SCAN. What is sitting in the output folder that this
 *      ledger has never heard of — 424 files on the day this was written.
 *
 * ── WHY THE GRAPH IS NOT IN THE LEDGER LINE ───────────────────────────────
 *
 * A VACE graph is tens of kilobytes. Putting it inline would make
 * `library.jsonl` unreadable to a human with `tail`, which is the same argument
 * provenance.js already makes about the 34 KB LTX licence text — and it would
 * store a hundred near-identical copies for a hundred-arm sweep. Content
 * addressing costs one write, dedupes the sweep to a single file, and makes
 * "did these two arms really run the same graph?" a string comparison.
 *
 * ⚠ NOTHING HERE IS EVER PRUNED, and no setting may be added to prune it.
 * Deleting a stored graph turns every ledger line that names its hash into an
 * unresolvable reference — a record that points at nothing is worse than no
 * record, because it looks like evidence. The Engine panel reports the
 * directory's SIZE instead, and lets the person decide with their own hands.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import * as provenance from "../provenance.js";
import { MODEL_FOLDERS, MODEL_INPUT_FOLDERS, extraBases, findShelfModel, modelName, modelLeaf, scanBases, uniqueDirs } from "../localmodels.js";

/** Media this app can plausibly have written. Anything else in the output
 *  folder (a .json sidecar, a .txt) is not a missing render. */
const MEDIA_RE = /\.(png|jpe?g|webp|gif|mp4|webm|mov|mkv|flac|wav|mp3|m4a|ogg|opus)$/i;

export function createStore({
  graphDir = path.join(config.paths.appData, "provenance", "graphs"),
  hashCacheFile = path.join(config.paths.appData, "model-hashes.json"),
  modelsDir,
  modelsAlso,
  bases = null,
  inputDir = config.inputDir,
  outputDir = config.outputDir,
  prov = provenance,
} = {}) {
  /* ── 1. the graph store ────────────────────────────────────────────────── */

  const graphFile = (hash) => path.join(graphDir, `${String(hash).replace(/^sha256:/, "sha256-")}.json`);

  /** Write a graph under its own hash. Idempotent by construction: a hundred
   *  arms of one sweep write the same bytes to the same name, so the second
   *  through hundredth are free.
   *
   *  `existed` is not bookkeeping — it is half of the cache-hit answer. ComfyUI
   *  serves an identical graph from its own node cache in under a second, and
   *  "this finished in 0.4 s AND we have run this exact graph before" is the
   *  only honest way to say so from out here. */
  async function putGraph(hash, graph) {
    const file = graphFile(hash);
    const rel = `graphs/${path.basename(file)}`;
    try { await stat(file); return { path: rel, existed: true }; } catch { /* first time */ }
    await mkdir(graphDir, { recursive: true });
    await writeFile(file, JSON.stringify(graph, null, 1), "utf8");
    return { path: rel, existed: false };
  }

  async function getGraph(hash) {
    try { return JSON.parse(await readFile(graphFile(hash), "utf8")); }
    catch { return null; }
  }

  /** What the store costs, for the panel to report instead of offering to
   *  delete it. */
  async function graphStoreBytes() {
    let bytes = 0, count = 0;
    try {
      for (const name of await readdir(graphDir)) {
        try { bytes += (await stat(path.join(graphDir, name))).size; count++; } catch { /* raced */ }
      }
    } catch { /* nothing stored yet */ }
    return { bytes, count };
  }

  /* ── 2. file facts ─────────────────────────────────────────────────────── */

  let cache = null;
  let cacheDirty = false;

  async function loadCache() {
    if (cache) return cache;
    try { cache = JSON.parse(await readFile(hashCacheFile, "utf8")); }
    catch { cache = {}; }
    if (!cache || typeof cache !== "object") cache = {};
    return cache;
  }

  async function saveCache() {
    if (!cacheDirty || !cache) return;
    cacheDirty = false;
    try {
      await mkdir(path.dirname(hashCacheFile), { recursive: true });
      await writeFile(hashCacheFile, JSON.stringify(cache), "utf8");
    } catch (e) { console.warn(`  [engine] could not save the model-hash cache: ${e.message}`); }
  }

  /** Streamed, so a 21 GB transformer does not become 21 GB of heap. */
  async function hashFile(full) {
    return new Promise((resolve, reject) => {
      const h = createHash("sha256");
      const s = createReadStream(full);
      s.on("error", reject);
      s.on("data", (d) => h.update(d));
      s.on("end", () => resolve(`sha256:${h.digest("hex")}`));
    });
  }

  /**
   * Size and date always; the digest only when asked for.
   *
   * ⚠ THE CACHE KEY IS (path, bytes, mtime), not path. That is the whole
   * safety of caching a hash at all: replace a weight file with a different
   * build of the same name and the key changes, so the record cannot go on
   * claiming the old digest — which would be the one lie in this module that
   * nobody could detect from the outside.
   */
  async function fileFacts(full, { hash = false } = {}) {
    let st;
    try { st = await stat(full); }
    catch { return { bytes: null, mtimeMs: null, sha256: null, missing: true }; }
    const facts = { bytes: st.size, mtimeMs: Math.round(st.mtimeMs), sha256: null, missing: false };
    if (!hash) return facts;
    const key = `${full}|${st.size}|${Math.round(st.mtimeMs)}`;
    const c = await loadCache();
    if (typeof c[key] === "string") { facts.sha256 = c[key]; return facts; }
    try {
      facts.sha256 = await hashFile(full);
      c[key] = facts.sha256;
      cacheDirty = true;
    } catch { facts.sha256 = null; }
    return facts;
  }

  /* Standard shelves preserve relative names and configured base precedence.
   * Unknown custom loaders retain their historical basename lookup through
   * nonstandard packs. A typed loader never falls back to another shelf. */
  let index = null, indexedAt = 0, indexedBases = "";
  const INDEX_TTL_MS = 60_000;

  async function modelBases() {
    if (bases) return uniqueDirs(bases);
    if (modelsDir !== undefined) return uniqueDirs([modelsDir, ...(modelsAlso || [])]);
    return uniqueDirs([config.modelsDir, ...(modelsAlso ?? config.modelsAlso ?? []),
      ...(await extraBases(config.comfy.extraArgs)), path.join(config.comfyDir, "models")]);
  }

  async function modelIndex(modelBases) {
    const basesKey = JSON.stringify(modelBases);
    if (index && indexedBases === basesKey && Date.now() - indexedAt < INDEX_TTL_MS) return index;
    const files = await scanBases(modelBases), generic = new Map();
    const walk = async (dir, depth) => {
      if (depth > 4) return;
      let entries = [];
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isDirectory()) await walk(path.join(dir, e.name), depth + 1);
        else if (e.isFile() && !generic.has(e.name.toLowerCase())) generic.set(e.name.toLowerCase(), path.join(dir, e.name));
      }
    };
    for (const base of modelBases) await walk(base, 0);
    index = { files, generic }; indexedAt = Date.now(); indexedBases = basesKey;
    return index;
  }

  /** Resolve the same shelf-relative selection the native loader receives. */
  async function findModel(name, input) {
    const rel = modelName(name);
    if (!rel) return null;
    const folders = MODEL_INPUT_FOLDERS[String(input || "").replace(/\d+$/, "")];
    const modelDirs = await modelBases();
    if (folders) {
      // Exact native selections must see completed downloads immediately,
      // including those that landed since the basename index was cached.
      const matches = [];
      for (const base of modelDirs) for (const folder of MODEL_FOLDERS.filter(f => folders.includes(f))) {
        const full = path.join(base, folder, rel);
        const st = await stat(full).catch(() => null);
        if (st?.isFile() && st.size > 0) matches.push(full);
      }
      // The loader sees only this relative name, so no receipt can choose a
      // physical copy when aliases or configured bases contain duplicates.
      if (matches.length > 1) return null;
      if (matches.length === 1) return matches[0];
    }
    const found = await modelIndex(modelDirs);
    if (folders) return findShelfModel(found.files, folders, rel)?.full || null;
    return found.generic.get(modelLeaf(rel).toLowerCase()) || null;
  }

  /**
   * Fill in every hole `record.js` left named.
   *
   * References and outputs are hashed ALWAYS — a few megabytes, about 50 ms for
   * a 50 MB mp4 — because the reference hash is what answers the DIRECTING.md
   * failure mode where a declared reference reached the render as nothing at
   * all. Model weights are hashed only under `hashModels`, which is off by
   * default and says why next to its own switch.
   */
  async function resolveRecordFiles(record, { hashModels = false } = {}) {
    for (const f of [...(record.engineFiles || []), ...(record.loras || [])]) {
      const full = await findModel(f.file, f.input);
      if (!full) { f.resolvedPath = null; continue; }
      f.resolvedPath = full;
      Object.assign(f, await fileFacts(full, { hash: hashModels }));
    }
    for (const r of record.references || []) {
      const full = path.join(inputDir, String(r.file || "").split("\\").join("/"));
      r.resolvedPath = full;
      Object.assign(r, await fileFacts(full, { hash: true }));
    }
    await saveCache();
    return record;
  }

  /** One output file, sized and hashed. `subfolder` comes from ComfyUI's own
   *  history entry, so this reads exactly the file the engine says it wrote. */
  async function outputFacts({ filename, subfolder = "", type = "output" }) {
    const root = type === "output" ? outputDir : path.join(config.comfyDir, type);
    const full = path.join(root, subfolder || "", filename);
    return { ...(await fileFacts(full, { hash: true })), resolvedPath: full };
  }

  /* ── 3. the unrecorded scan ────────────────────────────────────────────── */

  /**
   * Files in the output folder with no ledger event of any kind.
   *
   * Everything made before this door existed, plus anything a bypass still
   * writes. Measured on 2026-09-02: 426 files written since noon the previous
   * day, 424 of them with no entry — including 85 in `clips/`, which the app
   * ALREADY LISTS and can say nothing whatsoever about.
   *
   * Read-only. Adopting one is opt-in, previewed, and lives behind its own
   * action: writing 424 events into a hash chain without being asked is not
   * something a compliance layer gets to do.
   */
  async function scanUnrecorded({ limit = 200, prefix = null, since = null } = {}) {
    const known = new Set();
    try {
      const { events } = await prov.read("library");
      for (const e of events) {
        const asset = String(e.asset || "");
        if (asset) known.add(path.basename(asset).toLowerCase());
        for (const o of e.data?.outputs || []) {
          if (o?.file) known.add(path.basename(String(o.file)).toLowerCase());
          if (o?.adoptedAs) known.add(path.basename(String(o.adoptedAs)).toLowerCase());
        }
      }
    } catch { /* an unreadable ledger means everything looks unrecorded, which
                 is the honest answer to "what can this ledger account for" */ }

    const files = [];
    let total = 0;
    const walk = async (dir, rel, depth) => {
      if (depth > 4) return;
      let entries = [];
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { await walk(path.join(dir, e.name), childRel, depth + 1); continue; }
        if (!MEDIA_RE.test(e.name)) continue;
        if (prefix && !childRel.startsWith(prefix)) continue;
        if (known.has(e.name.toLowerCase())) continue;
        let st;
        try { st = await stat(path.join(dir, e.name)); } catch { continue; }
        if (since && st.mtimeMs < since) continue;
        total++;
        if (files.length < limit) {
          files.push({
            path: childRel, bytes: st.size, mtimeMs: Math.round(st.mtimeMs),
            prefix: childRel.includes("/") ? childRel.slice(0, childRel.indexOf("/")) : "",
          });
        }
      }
    };
    await walk(outputDir, "", 0);
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { files, total, scanned: outputDir };
  }

  /* ── 4. the subsystem's own two settings ───────────────────────────────── */

  /**
   * NOT `settings.json`, and for the reason videolab's store already gives:
   * that file's allow-list is a flat two-level map of APP PREFERENCES, and
   * these are neither flat nor preferences. `hashModels` is a statement about
   * how much evidence this install pays for, which belongs beside the evidence.
   */
  const settingsFile = path.join(config.paths.appData, "engine.json");
  let settings = null;

  async function readSettings() {
    if (settings) return settings;
    try { settings = JSON.parse(await readFile(settingsFile, "utf8")); }
    catch { settings = {}; }
    if (!settings || typeof settings !== "object") settings = {};
    /* Off by default, on purpose and said out loud wherever it is offered: the
     * full digest is the only thing that PROVES which weights rendered a clip,
     * and it costs about ten seconds per file the first time each one is seen. */
    if (typeof settings.hashModels !== "boolean") settings.hashModels = false;
    return settings;
  }

  async function writeSettings(patch) {
    const s = await readSettings();
    Object.assign(s, patch);
    try {
      await mkdir(path.dirname(settingsFile), { recursive: true });
      await writeFile(settingsFile, JSON.stringify(s, null, 2), "utf8");
    } catch (e) { console.warn(`  [engine] could not save engine.json: ${e.message}`); }
    return s;
  }

  return {
    putGraph, getGraph, graphStoreBytes,
    fileFacts, hashFile, findModel, resolveRecordFiles, outputFacts,
    scanUnrecorded, readSettings, writeSettings,
    paths: { graphDir, hashCacheFile, get modelsDir() { return modelsDir ?? config.modelsDir; }, inputDir, outputDir, settingsFile },
  };
}

/** The app's one store. Tests build their own with `createStore({...})`. */
export const store = createStore();
