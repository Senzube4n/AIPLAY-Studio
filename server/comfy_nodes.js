/**
 * The Studio's own ComfyUI nodes, deployed into the engine at boot, 2026-09-17.
 *
 * server/comfy_nodes/*.py are single-file custom nodes (ComfyUI loads any .py
 * in custom_nodes/ that exports NODE_CLASS_MAPPINGS). They are copied into the
 * rig's custom_nodes folder before the engine starts, and only when the bytes
 * differ — so an edit here reaches the engine on the next boot and an unchanged
 * file is never rewritten. Nothing else in custom_nodes is touched.
 *
 * Why copy rather than point ComfyUI at this folder: the engine has no flag for
 * a second custom_nodes directory, and a symlink needs privileges on Windows.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STUDIO_NODES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "comfy_nodes");

/**
 * Third-party nodes Studio ships, pinned, with their licence (server/comfy_nodes/<dir>/):
 *   comfyui-minimax-h3-blockcache-T8  T8mars, Apache-2.0, commit 36336dc (v1.0.4,
 *     2026-09-08): MiniMaxH3BlockCacheT8, H3's opt-in block cache (h3tier.js
 *     H3_BLOCK_CACHE, video_settings block_cache). Pure Python, no packages.
 *
 * COPIED ONLY WHILE ITS SWITCH IS ON (the owner's decision of 2026-09-26).
 * It was copied into every ComfyUI at every engine start, the owner's
 * included, with the switch off, and never removed. Now the caller says which
 * folders are wanted (`want`, server/comfy.js: the block cache's switch) and,
 * at each engine start:
 *   - on: the folder is copied, and marked as Studio's with MARKER, which
 *     lists every file Studio wrote and its sha256;
 *   - off: Studio's copy is removed: the files the marker lists whose bytes
 *     are still the ones Studio wrote, Python's __pycache__ files for them,
 *     the marker, and the folder once it is empty and Studio made it. A file
 *     somebody changed or added there stays, and so does the folder then;
 *   - either way, a folder that is not Studio's (ComfyUI Manager's clone, a
 *     copy made by hand, one whose files differ) is never written into and
 *     never removed, with a warning. With the switch on, the engine loads
 *     that one.
 * A folder an earlier Studio left behind has no marker. It holds only the
 * files Studio ships, byte for byte (Python's __pycache__ aside), and that is
 * how it is told from somebody else's: it is taken over as Studio's copy.
 * ComfyUI reads custom_nodes only as it starts, so a switch moved while the
 * engine runs takes effect at the next engine start: switched on, the next
 * clip runs without the cache and says so (art.js blockCacheNote); switched
 * off, the running engine keeps the node loaded, unused, until it restarts.
 */
export const VENDORED_NODES = Object.freeze(["comfyui-minimax-h3-blockcache-T8"]);
/** The file that marks a vendored folder as Studio's copy. */
export const MARKER = ".aiplay-studio-copy.json";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const SHIPPED = /\.py$|^LICENSE$/;
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** The folder's marker, or null (none, or one that does not parse as ours). */
function readMarker(to) {
  try {
    const m = JSON.parse(readFileSync(path.join(to, MARKER), "utf8"));
    if (!m || typeof m !== "object" || !m.files || typeof m.files !== "object") return null;
    /* A bare file name only: a hand-edited marker can never reach outside the folder. */
    const files = Object.fromEntries(Object.entries(m.files)
      .filter(([n, h]) => typeof h === "string" && /^[A-Za-z0-9_.-]+$/.test(n) && n !== MARKER && n !== "__pycache__"));
    return { files, createdFolder: m.createdFolder !== false };
  } catch { return null; }
}

/**
 * A folder with no marker: "studio" when it holds nothing but files Studio
 * ships, each byte for byte (an earlier Studio's copy), "empty" when it holds
 * nothing (Python's __pycache__ aside), else "foreign". A marker that no
 * longer parses (a cut-off write, a hand edit) is not somebody else's file:
 * the folder is judged by the rest, so Studio's own copy never turns foreign
 * and stays in custom_nodes with the switch off.
 */
const judged = (n) => n !== "__pycache__" && n !== MARKER;
function unmarkedKind(to, from) {
  const names = readdirSync(to).filter(judged);
  if (!names.length) return "empty";
  return names.every((n) => SHIPPED.test(n) && existsSync(path.join(from, n)) && !isDir(path.join(to, n))
    && readFileSync(path.join(to, n)).equals(readFileSync(path.join(from, n)))) ? "studio" : "foreign";
}

/** Python's bytecode for the .py files named, and the __pycache__ folder once empty. */
function removeBytecode(to, pyNames) {
  const cache = path.join(to, "__pycache__");
  if (!isDir(cache)) return;
  const stems = pyNames.filter((n) => n.endsWith(".py")).map((n) => n.slice(0, -3));
  for (const n of readdirSync(cache)) {
    if (n.endsWith(".pyc") && stems.some((s) => n.startsWith(`${s}.`))) unlinkSync(path.join(cache, n));
  }
  if (!readdirSync(cache).length) rmdirSync(cache);
}

const markerNote = () => ({
  note: "Copied by AIPLAY Studio because its block cache switch (video_settings block_cache) is on. "
    + "Studio removes its copy when the engine starts with the switch off. Delete this file to make the folder yours.",
});

/**
 * One vendored folder, to what its switch asks. Pushes onto the result's
 * lists; `rel` names are "<dir>/<file>".
 */
function syncVendored(dir, want, sourceDir, customNodesDir, out) {
  const from = path.join(sourceDir, dir);
  const to = path.join(customNodesDir, dir);
  const here = isDir(to);
  let marker = here ? readMarker(to) : null;
  if (here && !marker) {
    const kind = unmarkedKind(to, from);
    if (kind === "foreign") {                                                  // somebody else's: never touched
      out.foreign.push(dir);
      if (want) out.warnings.push("Preserved existing custom_nodes/" + dir + "; its files differ from Studio's bundled copy, so the engine loads that one. "
        + "To use the bundled H3 node, move that folder aside and restart Studio.");
      return;
    }
    /* An earlier Studio's copy is Studio's, folder and all; an empty folder is
     * not, so taking Studio's files out again leaves it as it was found. */
    marker = { files: {}, createdFolder: kind === "studio" };
    for (const n of readdirSync(to)) if (judged(n)) marker.files[n] = sha256(readFileSync(path.join(to, n)));
  }
  if (!want) {
    if (!marker) return;                                                       // nothing of Studio's here
    const gone = [];
    for (const [n, h] of Object.entries(marker.files)) {
      const p = path.join(to, n);
      if (!existsSync(p) || isDir(p)) continue;
      if (sha256(readFileSync(p)) !== h) continue;                             // changed since Studio wrote it: kept
      unlinkSync(p);
      gone.push(n);
      out.removed.push(`${dir}/${n}`);
    }
    removeBytecode(to, gone);
    const markerPath = path.join(to, MARKER);
    const left = Object.keys(marker.files).filter((n) => !gone.includes(n) && existsSync(path.join(to, n)));
    if (!readdirSync(to).some((n) => n !== MARKER)) {
      if (existsSync(markerPath)) unlinkSync(markerPath);
      if (marker.createdFolder) rmdirSync(to);
      return;
    }
    if (!existsSync(markerPath) && !left.length) return;                       // an unmarked folder with nothing of Studio's left
    /* Something stays (a file changed or added there): the folder stays
     * marked, with the files still Studio's, so switching on fills it again. */
    writeFileSync(markerPath, JSON.stringify({ ...markerNote(), createdFolder: marker.createdFolder,
      files: Object.fromEntries(left.map((n) => [n, marker.files[n]])) }, null, 2));
    return;
  }
  if (!existsSync(from)) return;
  mkdirSync(to, { recursive: true });
  const files = {};
  for (const name of readdirSync(from).sort()) {
    if (!SHIPPED.test(name)) continue;
    const src = readFileSync(path.join(from, name));
    const dst = path.join(to, name);
    const rel = dir + "/" + name;
    files[name] = sha256(src);
    if (existsSync(dst) && readFileSync(dst).equals(src)) { out.kept.push(rel); continue; }
    writeFileSync(dst, src);
    out.copied.push(rel);
  }
  /* A file an earlier copy wrote that this one no longer ships, unchanged since. */
  for (const [n, h] of Object.entries(marker?.files || {})) {
    const p = path.join(to, n);
    if (files[n] || !existsSync(p) || isDir(p) || sha256(readFileSync(p)) !== h) continue;
    unlinkSync(p);
    out.removed.push(`${dir}/${n}`);
  }
  writeFileSync(path.join(to, MARKER), JSON.stringify({ ...markerNote(), createdFolder: marker ? marker.createdFolder : true, files }, null, 2));
}

/* Every deploy, counted. server/comfy.js deploys at each engine start, and a
 * start can bring the T8 node in or take Studio's copy out; art.js
 * (videoBlockCache) asks the engine for the node again once this moves. The
 * engine door's "rebound" is not enough: a pinned port (AIPLAY_COMFY_PORT)
 * restarts on the same number, and then it says nothing. */
let deploys = 0;
export const deployEpoch = () => deploys;

/**
 * Copy every studio node whose bytes differ, and each vendored folder only
 * while `want[dir]` is true (removing Studio's copy when it is not).
 * Returns { copied, kept, removed, foreign, warnings, dir }.
 */
export function deployStudioNodes(customNodesDir, sourceDir = STUDIO_NODES_DIR, { want = {} } = {}) {
  deploys += 1;
  const copied = [], kept = [], removed = [], foreign = [], warnings = [];
  if (!existsSync(sourceDir)) return { copied, kept, removed, foreign, warnings, dir: customNodesDir };
  mkdirSync(customNodesDir, { recursive: true });
  for (const name of readdirSync(sourceDir)) {
    if (!/^aiplay_[a-z0-9_]+\.py$/.test(name)) continue;
    const src = readFileSync(path.join(sourceDir, name));
    const dst = path.join(customNodesDir, name);
    if (existsSync(dst) && readFileSync(dst).equals(src)) { kept.push(name); continue; }
    writeFileSync(dst, src);
    copied.push(name);
  }
  /* Bundled third-party nodes, one folder each under its upstream name, so a
   * copy ComfyUI Manager installed is found under the same name and is used
   * as it is, instead of Studio registering the node a second time. */
  const out = { copied, kept, removed, foreign, warnings };
  for (const dir of VENDORED_NODES) syncVendored(dir, want[dir] === true, sourceDir, customNodesDir, out);
  return { copied, kept, removed, foreign, warnings, dir: customNodesDir };
}
