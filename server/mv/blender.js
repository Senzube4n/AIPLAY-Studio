/**
 * Video Workflow — reference sheets rendered by BLENDER instead of by a model.
 *
 * WHY THIS EXISTS. DIRECTING.md's most emphatic rule is that PROPS ARE CAST: an
 * object that recurs across scenes must be the SAME object, and the way a
 * character holds identity — a rendered sheet, fed back in as a reference — is
 * the way a prop must hold it too. store.js already says this in the schema
 * ("a car in 13 of 22 scenes, declared nowhere, is re-invented from text on
 * every render — a different car each time, and sometimes two of them in one
 * frame").
 *
 * An image generator cannot fix that, because it does not have the object. It
 * has a description, and it re-invents from the description every time. A
 * Blender model IS the same object by construction: the second render is the
 * same mesh from a different camera, not a second guess at a sentence. That is
 * the whole argument for this file, and it is why the destination is H3 — the
 * clip engine takes reference images, and DIRECTING.md records that it "renders
 * in the STYLE of its reference — the medium is chosen by the picture, not the
 * words". A gray render therefore does not have to look like the film. It has
 * to be the same object, and the picture decides the medium.
 *
 * ── WHAT IT CANNOT DO, said once and said plainly ─────────────────────────
 * Blender is not a text-to-3D model. There is no path from "a 1973 sedan, sun-
 * bleached teal" to geometry. This renders exactly two things:
 *
 *   1. A NAMED BUILTIN — one mesh out of one of the toolkit's gray-box sets
 *      (see BUILTINS, which is filled in from the toolkit rather than typed). That is a small, blunt vocabulary: a crate stack, a
 *      drum, a plinth, a faceted monolith, a console. Right for "the artifact"
 *      or "the crates"; useless for anything with a make and model.
 *   2. A MODEL FILE you supply — .blend .obj .glb .gltf .fbx .stl. This is the
 *      real answer for a specific prop, and the honest cost of it: somebody has
 *      to model or download the object first.
 *
 * Anything else belongs on generate_asset, which is the image engine, and which
 * is better at "a sun-bleached teal sedan" than this will ever be. The two are
 * not competitors — they are for different rows.
 *
 * ── THE LICENCE BOUNDARY, which is a process boundary ──────────────────────
 * `import bpy` makes a file a derivative work of Blender and this repository is
 * public and Apache-2.0. The toolkit therefore lives outside the tree under
 * GPL-3.0-or-later, and this module NEVER imports it, never copies its python
 * in, and never writes python into it. It spawns `blender.exe -b -P <cli> --`
 * and reads the .png and .json that come back. Files are data. See
 * config.blender and C:\temp\AIPLAYStudio-blender\LICENSE-NOTE.md.
 */
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";
import { readFile, writeFile, stat, mkdir, rm, readdir } from "node:fs/promises";
import zlib from "node:zlib";
import { config } from "../config.js";
import { updateProject, readProject, assetsDir, projectDir, stageAsset, noteRun } from "./store.js";
import { findRow } from "./generate.js";

/** The toolkit's marker: its machine-readable answer is the line after this. */
const RESULT_MARKER = "PREVIZ_RESULT_JSON:";

/**
 * What a sidecar must say for the picture beside it to be handed to a model.
 * The toolkit's own constant (props.USE_REFERENCE). A grid says "human-review".
 */
const USE_REFERENCE = "model-reference";

/** A contact sheet may only be written to this suffix, so a bare path tells. */
const CONTACT_SUFFIX = ".contact.png";

/** Written beside every previz render. Plain JSON, readable with no Blender. */
const SIDECAR_SUFFIX = ".previz.json";

/**
 * ── THE SET LIST IS THE TOOLKIT'S, AND THIS SIDE ASKS FOR IT ───────────────
 *
 * ⚠ THIS USED TO BE FIVE HAND-TYPED COPIES AND THEY WENT STALE THE SAME DAY.
 * The toolkit grew an eighth set ('stage', the arena concert set) and the app
 * had seven in previz.js twice, in this file's mesh table, in mcp-mv.js's enum,
 * in chat/tools.js's argument note and in web/mv.js's picker. One of those
 * seven-name lists is the guard in previzShot, so the Studio answered
 * `No previz set called "stage"` for a set that was sitting right there. A copy
 * of somebody else's list is a promise to re-type it, and nobody ever does.
 *
 * So the names are ASKED FOR, across the licence boundary, the only way this
 * repository is allowed to ask: `blender -b -P <toolkit cli.py> -- list`, which
 * already prints its whole contract as JSON after PREVIZ_RESULT_JSON:. No new
 * CLI flag was needed and no python was written into the toolkit — the payload
 * it has published all along carries `scenes`. (Measured 2026-09-05: 2.9 s for
 * that launch, and it answered eight sets.)
 *
 * The three lists below are FALLBACKS, not the source. SETS and BUILTINS are
 * live objects: `toolkitSets()` replaces their contents in place, so every
 * importer — routes.js's /api/mv/blender payload included — sees the derived
 * list without holding its own copy or being re-imported.
 */

/** The last-known set list. Used only until the toolkit has been asked. */
export const SETS_FALLBACK = ["corridor", "room", "street", "turntable",
                              "atrium", "warship", "dig", "stage"];

/**
 * The gray-box sets, LIVE. Seeded from the fallback and replaced in place by
 * whatever `blender ... -- list` says. Never re-assigned, so the binding every
 * other module imported keeps pointing at the current answer.
 */
export const SETS = [...SETS_FALLBACK];

/**
 * The named builtins, as (set → meshes) — the transcribed half.
 *
 * ⚠ THE OLD COMMENT HERE SAID ASKING WAS IMPOSSIBLE, AND IT WAS WRONG. It read
 * "the toolkit's CLI lists its SETS but not the objects inside them, and asking
 * would mean shipping a python file that imports it". Asking needs no python at
 * all: `reference --scene <set> --object <a name nothing has>` fails in
 * _gather_subjects BEFORE anything renders and puts the true inventory in the
 * message — "no object matched ['__previz_no_such_object__']; scene has: bowl,
 * bowl_pilasters, ground, holotank, idol, pa_left, pa_right, pit, riser,
 * tower_0 … truss". That is a subprocess and a string, which is exactly what
 * the boundary allows. Measured 2026-09-05: 3.0 s, exit 2, and that is how
 * 'stage' got its mesh list without anybody typing one.
 *
 * These seven stay transcribed (taken 2026-09-02 the same way, by hand) because
 * they are already here and re-probing them would cost seven Blender launches
 * to learn what is on the screen. Any set the toolkit reports that is NOT in
 * this table is probed once, cached under the toolkit's version stamp, and
 * merged in — so a new set arrives with its meshes and no edit to this file.
 * `toolkitSets().meshesFrom` says, per set, which half answered.
 *
 * The render itself stays the authority either way: when a name is wrong the
 * toolkit answers with the true inventory, which is the same sentence the probe
 * reads. This table exists to make the common mistake free (no Blender launch)
 * and to give the pickers something to show.
 */
const BUILTINS_FALLBACK = {
  corridor: ["corridor", "corridor_pilasters", "corridor_ribs", "drum", "figure"],
  room: ["figure", "platform", "room", "room_pilasters", "room_ribs", "stack"],
  street: ["blockL_0", "blockL_1", "blockL_2", "blockL_3", "blockL_4",
           "blockR_0", "blockR_1", "blockR_2", "blockR_3", "blockR_4",
           "figure", "ground", "stack"],
  turntable: ["funnel", "ground", "platform", "stack"],
  atrium: ["core", "floor_0", "floor_1", "floor_2", "floor_3", "floor_4", "floor_5", "ground"],
  warship: ["cargo", "console_port", "console_stbd", "crew", "dais", "deck",
            "holotank", "hull", "pylon_port", "pylon_stbd"],
  dig: ["artifact", "crates", "ground", "plinth"],
};

/** (set → meshes), LIVE — same bargain as SETS. Mutated, never re-assigned. */
export const BUILTINS = { ...BUILTINS_FALLBACK };

/** Camera angles the toolkit accepts. Each is one panel, one reference. */
export const ANGLES = ["three_quarter", "front", "back", "side", "left", "top", "low", "hero"];

/**
 * THE DEFAULT SHEET IS THREE ANGLES, and each one is its own take.
 *
 * generate_asset renders four variants because a model gives four different
 * answers to the same prompt. Blender gives ONE answer — it is the same mesh —
 * so seeds would produce four identical files. The axis that actually varies is
 * the CAMERA, and three quarters / front / side is the reference-photograph
 * convention: the first identifies the object, the other two say what it is
 * shaped like.
 *
 * They are three separate single-panel renders, deliberately, and never one
 * grid. A grid handed to a model teaches it to draw a grid — measured twice by
 * the consuming project, which is the whole reason this file has a gate in it.
 */
export const DEFAULT_ANGLES = ["three_quarter", "front", "side"];

const ASSET_EXT = new Set([".blend", ".obj", ".glb", ".gltf", ".fbx", ".stl"]);

/* ───────────────────────────────────────────────── is Blender even here */

/**
 * Is there a Blender and a toolkit to talk to? -> {installed, exe, previz, why}
 *
 * Called before anything spends time, and returned by the route so a UI can
 * hide a button it cannot honour. `why` is written for a person who has never
 * heard of any of this: it names the missing file and the setting that moves it.
 */
export async function blenderStatus() {
  const { exe, previz } = config.blender;
  const missing = [];
  try { await stat(exe); } catch {
    missing.push(`Blender is not at ${exe} — install it, or set AIPLAY_BLENDER to the blender.exe you have.`);
  }
  try { await stat(previz); } catch {
    missing.push(`The previz toolkit is not at ${previz} — set AIPLAY_PREVIZ to its previz/cli.py.`
      + ` It is a separate, GPL-licensed checkout and is deliberately not part of this repository.`);
  }
  return { installed: !missing.length, exe, previz, why: missing };
}

/* ───────────────────────────────────────── the gate, on this side of it */

/**
 * THE CONTACT MARK, IN THE PIXELS — 8-bit sRGB (230, 5, 140).
 *
 * props.py paints a contact sheet's border and gutter in CONTACT_MARK
 * (0.90, 0.02, 0.55), a hue three-point grey lighting cannot produce, precisely
 * so that "this is a grid" survives the file being renamed, copied or stripped
 * of its sidecar. Measured off a real sheet rather than converted on faith:
 * every border pixel of a rendered .contact.png reads exactly 230,5,140, and a
 * reference panel's border reads grey (120,120,120) or black.
 *
 * The tolerance and the tenth-of-the-border threshold are the toolkit's own
 * (_has_contact_mark, tol=0.12 → ±31/255, mean > 0.10).
 */
const CONTACT_MARK = [230, 5, 140];
const CONTACT_MARK_TOL = 31;
/** Reading a PNG header + IDAT is data handling; nothing here needs Blender. */
const MAX_PIXEL_BYTES = 64 * 1024 * 1024;

/**
 * A minimal PNG reader — enough to look at a border, and nothing more.
 *
 * ⚠ WHY THIS IS HERE AT ALL. The name and sidecar checks catch the sheet the
 * toolkit writes and the sheet somebody renames. They do NOT catch a sheet that
 * was renamed AND had its sidecar deleted, and that path was open: import_asset
 * accepted a six-panel grid as a character sheet, measured. The mark is in the
 * pixels for exactly this case, and reading pixels needs zlib, not bpy — so the
 * check the toolkit's docstring calls unavailable outside Blender is available
 * after all, for the one signal that matters.
 *
 * Deliberately narrow: 8-bit, non-interlaced, greyscale/RGB/RGBA. Anything else
 * (a jpeg, a palette PNG, a 16-bit render, a truncated file) returns null, which
 * means NO VERDICT — never a refusal. `safe` stays "not proven unsafe".
 */
function readPngRgb(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let off = 8, ihdr = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    if (off + 12 + len > buf.length) return null;
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4),
               depth: data[8], color: data[9], interlace: data[12] };
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (!ihdr || ihdr.depth !== 8 || ihdr.interlace !== 0 || !idat.length) return null;
  // 0 grey, 2 RGB, 4 grey+alpha, 6 RGBA. 3 is palette: the border colour would
  // be an index, not a colour, so it is left undecoded rather than guessed at.
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.color];
  if (!ch || !ihdr.w || !ihdr.h) return null;
  if (ihdr.w * ihdr.h * ch > MAX_PIXEL_BYTES) return null;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const stride = ihdr.w * ch;
  if (raw.length < ihdr.h * (stride + 1)) return null;
  /* Undo the per-scanline filters. Every row may reference the row above, so
   * this walks the whole image even though only its edges are wanted. */
  const px = Buffer.alloc(ihdr.h * stride);
  for (let y = 0; y < ihdr.h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const o = y * stride, up = o - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[o + x - ch] : 0;
      const b = y ? px[up + x] : 0;
      const c = (y && x >= ch) ? px[up + x - ch] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p0 = a + b - c;
        const pa = Math.abs(p0 - a), pb = Math.abs(p0 - b), pc = Math.abs(p0 - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (ft !== 0) return null;
      px[o + x] = v & 255;
    }
  }
  return { ...ihdr, ch, stride, px };
}

/**
 * Does this picture's frame border carry the contact mark?
 * -> true (it is a sheet) | false (it is not) | null (could not tell).
 */
async function contactMarkInBorder(pngPath) {
  let img;
  try { img = readPngRgb(await readFile(pngPath)); } catch { return null; }
  if (!img) return null;
  const { w, h, ch, stride, px } = img;
  const band = Math.max(2, Math.floor(Math.min(h, w) / 64));
  let hit = 0, seen = 0;
  const test = (x, y) => {
    const o = y * stride + x * ch;
    // Greyscale cannot be magenta; count it as seen so a grey card still
    // divides the fraction rather than skewing it.
    const r = px[o], g = ch >= 3 ? px[o + 1] : r, b = ch >= 3 ? px[o + 2] : r;
    seen++;
    if (Math.abs(r - CONTACT_MARK[0]) < CONTACT_MARK_TOL
      && Math.abs(g - CONTACT_MARK[1]) < CONTACT_MARK_TOL
      && Math.abs(b - CONTACT_MARK[2]) < CONTACT_MARK_TOL) hit++;
  };
  for (let y = 0; y < band; y++) for (let x = 0; x < w; x++) { test(x, y); test(x, h - 1 - y); }
  for (let x = 0; x < band; x++) for (let y = 0; y < h; y++) { test(x, y); test(w - 1 - x, y); }
  return seen > 0 && hit / seen > 0.10;
}

/**
 * May this picture be handed to an image or video model as a reference?
 *
 * This is props.reference_safe() with pixels=False, RE-IMPLEMENTED here rather
 * than called — and the re-implementation is forced, not preferred. That
 * function's docstring says its name and sidecar checks "need no Blender at
 * all", but `props.py` does `import bpy` at module scope, so importing it from
 * a bpy-less interpreter raises ModuleNotFoundError before any of its code
 * runs. The pixel-free half is unreachable from outside Blender. The same
 * docstring's next paragraph says what to do about that — "a consumer OUTSIDE
 * Blender should call the name and sidecar checks itself: both are pure
 * string/JSON work" — and this is that. Two checks, byte for byte the
 * toolkit's:
 *
 *   NAME    — `.contact.png` names a human contact sheet by construction.
 *   SIDECAR — <path>.previz.json records the use it was rendered FOR.
 *   PIXELS  — the magenta border a contact sheet paints (contactMarkInBorder).
 *
 * ⚠ THE PIXEL CHECK WAS THE ONE DOOR LEFT OPEN, and it was open in practice,
 * not in theory. Name and sidecar together refuse the sheet the toolkit writes
 * and the sheet somebody renames — but rename it AND delete its sidecar and
 * import_asset installed a six-panel grid as a character sheet, no complaint.
 * Measured, through MCP, with a real contact sheet. props.py's own answer to
 * that case is the mark in the pixels, and reading pixels turned out to need
 * zlib rather than bpy, so the check does not have to stay on the far side of
 * the boundary after all. The toolkit's _edge_seams half genuinely does — it
 * runs inside every render this app makes — but the mark is the half that
 * catches a deliberate disguise, and it is here now.
 *
 * ⚠ ABSENCE OF A SIDECAR IS NOT PROOF OF ANYTHING, and the distinction is the
 * difference between a gate and a wall. A jpeg off the Images tab has no
 * sidecar and never will; refusing it would break import_asset for every
 * picture in the app. So `safe` means NOT PROVEN UNSAFE, and `proven` means a
 * sidecar affirmatively declared it a model reference. The Blender path demands
 * `proven` — it just rendered the thing, so a missing declaration means the
 * render did not make one and something is wrong. Everything else demands only
 * `safe`.
 */
export async function referenceSafe(pngPath) {
  const why = [];
  const p = String(pngPath || "");
  if (p.toLowerCase().endsWith(CONTACT_SUFFIX)) {
    why.push(`filename ends in ${CONTACT_SUFFIX} — that names a human contact sheet,`
      + ` and a grid handed to a model teaches it to draw a grid`);
  }
  let sidecar = null;
  try {
    sidecar = JSON.parse(await readFile(p + SIDECAR_SUFFIX, "utf8"));
  } catch (err) {
    // Only a sidecar that EXISTS and will not parse is a fault. One that is
    // simply absent means the picture came from somewhere else entirely.
    if (err?.code !== "ENOENT") why.push(`sidecar ${path.basename(p)}${SIDECAR_SUFFIX} is not readable JSON`);
  }
  if (sidecar) {
    if (sidecar.use && sidecar.use !== USE_REFERENCE) {
      why.push(`sidecar says use="${sidecar.use}", not "${USE_REFERENCE}"`);
    }
    const panels = sidecar.panels ?? 1;
    if (panels !== 1) why.push(`sidecar says ${panels} panels — single panels only`);
  }
  /* The pixels, last: they are the only signal that survives a rename and a
   * deleted sidecar. `null` is "could not tell" — a jpeg, a palette PNG, a
   * 16-bit render — and could-not-tell never refuses anything. */
  const marked = await contactMarkInBorder(p);
  if (marked === true) {
    why.push("the frame border carries the contact-sheet marker colour"
      + " — this is a grid, whatever it has been renamed to");
  }
  return {
    safe: !why.length,
    proven: !why.length && sidecar?.use === USE_REFERENCE,
    why,
    sidecar,
    path: p,
  };
}

/**
 * referenceSafe(), as a throw. The message is the one a person has to act on,
 * so it names the file, every reason, and the thing to do instead.
 */
export async function assertReferenceSafe(pngPath, doing = "use as a reference") {
  const r = await referenceSafe(pngPath);
  if (!r.safe) {
    throw new Error(
      `Refusing to ${doing}: ${path.basename(pngPath)} is not a model reference.\n`
      + r.why.map((w) => `  - ${w}`).join("\n")
      + `\nA reference is ONE panel of ONE subject. Crop a single panel out of the sheet,`
      + ` or re-render it with the reference path rather than the contact-sheet path.`);
  }
  return r;
}

/* ───────────────────────────────────────────────────────── the subprocess */

/**
 * Run the toolkit once. -> its result object.
 *
 * ONE process: blender runs the toolkit's own cli.py, which detects that it is
 * already inside Blender and does the work directly. The alternative (system
 * python spawning blender) is the toolkit's documented path and works, but it
 * adds an interpreter this app would then have to have opinions about.
 *
 * Exit codes are the toolkit's: 0 done, 2 REFUSED (a rule it enforces — the
 * reason is on stderr and is meant to be read), 3 the render failed. A refusal
 * is an answer and is passed through verbatim; inventing a friendlier sentence
 * on top of "no object matched ['flarn']; scene has: artifact, crates, ground,
 * plinth" would throw away the only list of the truth anybody gets.
 */
/**
 * The first balanced {...} at or after `from`, or null.
 *
 * Deliberately not a regex and deliberately not line-based: what it has to
 * survive is ANOTHER PROCESS'S OUTPUT arriving beside ours on one pipe.
 *
 * EXPORTED, and read by server/mesh/runner.js. That is a second subprocess on a
 * second interleaved pipe with the same failure available to it, and the rule
 * this repository already wrote down applies: two copies of a hardened thing
 * decay into one hardened thing and one that looks like it.
 * Strings are tracked, so a brace inside a Windows path or a message cannot
 * close the object early.
 */
export function jsonAfter(text, from) {
  const start = text.indexOf("{", from);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export function runPreviz(args, { timeoutMs = 10 * 60e3 } = {}) {
  const { exe, previz } = config.blender;
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(exe, ["-b", "--factory-startup", "-noaudio", "-P", previz, "--", ...args],
                   { windowsHide: true });
    } catch (err) {
      reject(new Error(`Could not start Blender at ${exe}: ${err.message}`));
      return;
    }
    let out = "", err = "", done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => {
      proc.kill();
      finish(reject, new Error(`Blender did not finish in ${Math.round(timeoutMs / 1000)}s — killed.`));
    }, timeoutMs);

    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { err += d; });
    // ENOENT lands here, not as a throw from spawn(): say which file is missing
    // rather than letting "spawn ENOENT" reach a person.
    proc.on("error", (e) => finish(reject, new Error(
      e.code === "ENOENT" ? `Blender is not installed at ${exe}. Set AIPLAY_BLENDER to your blender.exe.`
                          : `Blender failed to start: ${e.message}`)));
    proc.on("close", (code) => {
      /* THE RESULT IS BRACE-MATCHED, NOT LINE-SLICED, AND THAT IS A FIX FOR
       * A MEASURED FAILURE.
       *
       * This used to take the whole line after the marker and JSON.parse it.
       * Blender's own C code writes to the same stdout the toolkit's print()
       * does, and the two buffers interleave: on a 121-frame blockout whose
       * result carried a 32,089-character projection table, the JSON arrived
       * COMPLETE and the newline after it did not, so Blender's own
       * "Blender 5.2.1 LTS (hash ...)" banner ended up on the same line and
       * the render came back as "a result line that is not JSON" - after the
       * render had already happened.
       *
       * The toolkit no longer inlines that table (it writes it beside the
       * clip), so the line is small again. This stays anyway: it costs a few
       * thousand characters of scanning and it makes the seam immune to a
       * class of failure that only shows up on the biggest, slowest renders.
       */
      const marker = out.lastIndexOf(RESULT_MARKER);
      const payload = marker < 0 ? null : jsonAfter(out, marker + RESULT_MARKER.length);
      if (code === 0 && payload) {
        try { return finish(resolve, JSON.parse(payload)); }
        catch { return finish(reject, new Error("Blender answered with a result line that is not JSON.")); }
      }
      let detail = (err.trim() || out.split(/\r?\n/).slice(-6).join("\n")).trim();
      /* LEAD WITH THE SENTENCE, NOT WITH THE STACK. An uncaught toolkit error
       * arrives as a 20-line Python traceback whose ONE useful line is the last
       * one — and it is genuinely useful, e.g. "CLIP IS IN SPEC BUT EMPTY:
       * 46/121 frames have contrast below 1.5 ... this almost always means the
       * camera is inside or behind geometry". Buried under a traceback that
       * starts with cli.py line 313, nobody reads it. Hoisted to the front,
       * it is the answer. The traceback stays underneath for whoever wants it.
       * Everything FROM the exception line to the end, because a Python
       * traceback puts the stack first and the message last — and that message
       * is often several lines of measurements worth keeping. */
      const lines = detail.split(/\r?\n/);
      const at = lines.findLastIndex((l) => /^[A-Za-z_][\w.]*(?:Error|Exception): \S/.test(l));
      if (at >= 0) detail = `${lines.slice(at).join("\n").trim()}\n\n${detail}`;
      finish(reject, new Error(
        code === 2 ? `Blender refused this render.\n${detail}`
        : code === 3 ? `The Blender render failed.\n${detail}`
        /* ⚠ EXIT 0 WITH NO RESULT LINE IS NOT A SUCCESS, and the headline has
         * to say so. cli.py catches the toolkit's PropError and turns it into
         * exit 2, but anything it does NOT catch — verify.ClipSpecError, for
         * one, which is how an out-of-spec control clip is rejected — escapes
         * as an uncaught exception while Blender still exits 0. Saying
         * "Blender exited 0" above a Python traceback reads as a mystery; the
         * traceback underneath is the actual answer, so point at it. */
        : code === 0 ? `Blender finished without answering — the toolkit raised instead:\n${detail}`
        : `Blender exited ${code}.\n${detail}`));
    });
  });
}

/* ─────────────────────────── the toolkit's catalogue, asked for not typed */

/** Where the derived catalogue is remembered between runs. */
const catalogueFile = () => path.join(config.paths.appData, "previz-catalogue.json");

/**
 * A name nothing can be called, used to make the toolkit say what IS there.
 * It never renders: props._gather_subjects raises before a pixel is drawn.
 */
const MESH_PROBE = "__previz_no_such_object__";

/** At most this many sets get a mesh probe per derive (~3 s of Blender each). */
const MESH_PROBE_BUDGET = 4;

let catalogue = null;      // the settled answer for this process
let catalogueRun = null;   // { stamp, promise } — N callers, one Blender launch

/**
 * THE VERSION STAMP, and why it is file mtimes rather than a version string.
 *
 * The toolkit publishes no version of its own — `list` reports Blender's and
 * the spec's, and neither of those moves when somebody adds a set. What DOES
 * move is the checkout, so the stamp is the newest mtime across the toolkit
 * package's .py files, how many there are, and the two configured paths.
 *
 * Reading a directory listing is METADATA, not code. Nothing here opens a .py,
 * imports one or copies one — the licence boundary is about derivation, and a
 * timestamp derives nothing. The payoff is that the agent editing moves.py in
 * the next window cannot leave this side quietly believing an old answer: the
 * stamp moves, the cache is dropped, and the toolkit is asked again.
 */
async function toolkitStamp() {
  const { exe, previz } = config.blender;
  const dir = path.dirname(previz);
  let newest = 0, files = 0;
  try {
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".py")) continue;
      const s = await stat(path.join(dir, name));
      files++;
      if (s.mtimeMs > newest) newest = s.mtimeMs;
    }
  } catch { /* no toolkit — blenderStatus() already says so, in a sentence */ }
  return `${previz}|${exe}|${files}|${Math.round(newest)}`;
}

async function readCatalogueFile() {
  try { return JSON.parse(await readFile(catalogueFile(), "utf8")); }
  catch { return null; }
}

async function writeCatalogueFile(c) {
  /* A cache that cannot be written makes the next boot slower, never wrong. */
  try {
    await mkdir(path.dirname(catalogueFile()), { recursive: true });
    await writeFile(catalogueFile(), JSON.stringify(c, null, 1), "utf8");
  } catch { /* ignored on purpose */ }
}

/**
 * Ask ONE set what is inside it. -> sorted mesh names, or null if it would not say.
 *
 * There is no `--list-objects`, and none was added: cli.py belongs to a
 * separate repository under a different licence and another agent is editing it
 * right now. This uses the door the toolkit already has. `reference` resolves
 * its subjects first, so an object name nothing can match raises PropError
 * before a pixel is rendered, and props.py puts the real inventory in the
 * message. Exit 2, ~3 s, no file written.
 *
 * If the toolkit ever does publish the inventory itself, `list` is where it
 * will land and toolkitSets() reads `listed.objects` for exactly that — the
 * file convention this side is ready for, with no edit here.
 */
async function probeMeshes(set) {
  const out = path.join(os.tmpdir(), `previz-probe-${process.pid}-${set}.png`);
  try {
    await runPreviz(["reference", "--scene", set, "--object", MESH_PROBE, "--out", out],
                    { timeoutMs: 120e3 });
    return null;              // it rendered — then there is no inventory to read
  } catch (err) {
    const m = /scene has:\s*([^\r\n]+)/.exec(err?.message || "");
    return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean).sort() : null;
  } finally {
    await rm(out, { force: true }).catch(() => {});
  }
}

/** Put the answer into the LIVE bindings, in place, so no importer holds a copy. */
function applyCatalogue(c) {
  SETS.length = 0;
  SETS.push(...c.sets);
  for (const k of Object.keys(BUILTINS)) delete BUILTINS[k];
  for (const s of c.sets) if (c.meshes[s]?.length) BUILTINS[s] = c.meshes[s];
  catalogue = c;
  return c;
}

/**
 * THE ONE SOURCE for "which gray-box sets are there". ->
 *   { sets, meshes, meshesFrom, source, stale, failed, why, stamp, blender, specVersion }
 *
 * `source` is "toolkit" (just asked), "cache" (asked under this same stamp on
 * an earlier run) or "fallback" (nobody could be asked — `stale` is then true
 * and `why` says which file is missing). `failed` separates "there is no
 * Blender here" from "Blender is here and would not answer", because the two
 * deserve different treatment: without a toolkit nothing can render anyway, but
 * a probe that timed out while the card was busy must NOT be allowed to refuse
 * a set that really exists.
 *
 * Cheap to call: it re-stamps the toolkit directory (a readdir and a few stats)
 * and returns the settled answer unless that stamp has moved.
 */
export async function toolkitSets({ refresh = false } = {}) {
  const stamp = await toolkitStamp();
  if (!refresh && catalogue && catalogue.stamp === stamp) return catalogue;
  if (!refresh && catalogueRun && catalogueRun.stamp === stamp) return catalogueRun.promise;

  const promise = (async () => {
    const cached = await readCatalogueFile();
    if (!refresh && cached?.stamp === stamp && Array.isArray(cached.sets) && cached.sets.length) {
      return applyCatalogue({ ...cached, stamp, source: "cache", stale: false, failed: false, why: [] });
    }

    const st = await blenderStatus();
    const fallback = (extra) => applyCatalogue({
      stamp, at: Date.now(), blender: null, specVersion: null,
      sets: [...SETS_FALLBACK],
      meshes: { ...BUILTINS_FALLBACK },
      meshesFrom: Object.fromEntries(SETS_FALLBACK.map(
        (s) => [s, BUILTINS_FALLBACK[s] ? "transcribed" : "unknown"])),
      source: "fallback", stale: true, ...extra,
    });
    if (!st.installed) {
      return fallback({ failed: false, why: [...st.why,
        "So these set names are this app's last-known copy rather than the toolkit's answer."] });
    }

    let listed;
    try { listed = await runPreviz(["list"], { timeoutMs: 120e3 }); }
    catch (err) {
      return fallback({ failed: true, why: [`The toolkit would not list its sets: ${err.message}`] });
    }
    const sets = (listed.scenes || []).filter((s) => typeof s === "string" && s);
    if (!sets.length) return fallback({ failed: true, why: ["The toolkit listed no sets at all."] });

    /* The meshes. Sets this file already transcribes keep the transcription —
     * re-probing them would spend seven Blender launches to learn what is
     * already on the screen. Everything else is probed once and cached under
     * the stamp, which is how a set added over there arrives here with its
     * inventory and no edit to this file. `listed.objects` is read first, so
     * the day the toolkit publishes the inventory itself nothing here changes. */
    const published = listed.objects && typeof listed.objects === "object" ? listed.objects : {};
    const carried = cached?.meshes && typeof cached.meshes === "object" ? cached.meshes : {};
    const meshes = {}, meshesFrom = {};
    let budget = MESH_PROBE_BUDGET;
    for (const s of sets) {
      if (Array.isArray(published[s]) && published[s].length) {
        meshes[s] = [...published[s]].sort(); meshesFrom[s] = "toolkit:list";
      } else if (BUILTINS_FALLBACK[s]) {
        meshes[s] = BUILTINS_FALLBACK[s]; meshesFrom[s] = "transcribed";
      } else if (Array.isArray(carried[s]) && carried[s].length) {
        meshes[s] = carried[s]; meshesFrom[s] = "toolkit:probe";
      } else if (budget > 0) {
        budget--;
        const probed = await probeMeshes(s);
        if (probed?.length) { meshes[s] = probed; meshesFrom[s] = "toolkit:probe"; }
        else meshesFrom[s] = "unknown";
      } else {
        meshesFrom[s] = "unknown";
      }
    }

    const c = {
      stamp, at: Date.now(), blender: listed.blender ?? null,
      specVersion: listed.spec_version ?? null,
      sets, meshes, meshesFrom, source: "toolkit", stale: false, failed: false, why: [],
    };
    await writeCatalogueFile(c);
    return applyCatalogue(c);
  })();

  catalogueRun = { stamp, promise };
  try { return await promise; }
  finally { if (catalogueRun?.promise === promise) catalogueRun = null; }
}

/**
 * Render ONE single-panel reference. -> the toolkit's result, plus `path`.
 *
 * `source` is exactly one of { builtin: "<set>:<mesh>" } or { asset: "<file>" }.
 * Both are checked here so the common mistakes cost nothing: an unknown set or
 * mesh, and a model file that is not on disk or is not a format the importer
 * knows, are all answered without launching anything.
 */
export async function renderReference(outPath, source, opts = {}) {
  const st = await blenderStatus();
  if (!st.installed) throw new Error(st.why.join("\n"));

  if (String(outPath).toLowerCase().endsWith(CONTACT_SUFFIX)) {
    // The toolkit refuses this too. Refusing here as well means the answer
    // arrives without a Blender launch, and means the rule is stated in the
    // app that depends on it rather than only in the library.
    throw new Error(`${path.basename(outPath)} names a contact sheet. A reference is one panel;`
      + ` a grid handed to a model is drawn as a grid.`);
  }

  const args = ["reference", "--out", String(outPath)];
  if (source.builtin) {
    /* THE SET LIST IS THE TOOLKIT'S; THE MESH LIST IS ONLY CHECKED WHEN THIS
     * SIDE REALLY HAS ONE. A set whose inventory was never probed passes
     * straight through — refusing against a table known to be incomplete would
     * reject a mesh that exists, which is the exact failure the derivation was
     * written for. The toolkit names the true inventory in its error either way. */
    const cat = await toolkitSets();
    const [set, mesh] = String(source.builtin).split(":");
    if (!cat.sets.includes(set)) {
      throw new Error(`No builtin set called "${set}". The sets ${
        cat.stale ? "last known here" : "the toolkit reports"} are: ${cat.sets.join(", ")}.`);
    }
    const inventory = BUILTINS[set] || null;
    if (!mesh) throw new Error(`Name a mesh too — "${set}:${inventory ? inventory[0] : "<mesh>"}", not "${set}".`);
    if (inventory && !inventory.includes(mesh)) {
      throw new Error(`"${set}" has no mesh called "${mesh}". It has: ${inventory.join(", ")}.`);
    }
    args.push("--scene", set, "--object", mesh);
  } else if (source.asset) {
    const file = String(source.asset);
    const ext = path.extname(file).toLowerCase();
    if (!ASSET_EXT.has(ext)) {
      throw new Error(`${ext || "that"} is not a model file. Give a ${[...ASSET_EXT].join(", ")}.`);
    }
    try { await stat(file); } catch { throw new Error(`No such model file: ${file}`); }
    args.push("--asset", file);
  } else {
    throw new Error("Give either a builtin (\"dig:artifact\") or a model file (.blend/.obj/.glb/.fbx/.stl)."
      + " Blender cannot model an object from a description — that is what generate_asset is for.");
  }

  /* AN EXPLICIT AZIMUTH+ELEVATION BEATS A NAMED ANGLE, and both are here so
   * there stays exactly one renderer. previz.js needs the second form: it
   * recovers the viewpoint a blocked shot's camera occupied out of the camera
   * track and renders the subject from THERE, which is a pair of degrees and
   * not one of eight names. The toolkit takes both and treats an explicit pair
   * as the override (and relabels the result "custom" so the sidecar cannot go
   * on claiming a preset it is not at) — so this passes them straight through
   * rather than rounding to the nearest name. */
  const az = Number(opts.azimuth), el = Number(opts.elevation);
  if (Number.isFinite(az) && Number.isFinite(el)) {
    args.push("--azimuth", String(az), "--elevation", String(el));
  } else {
    const angle = opts.angle || "three_quarter";
    if (!ANGLES.includes(angle)) throw new Error(`Unknown angle "${angle}". Try: ${ANGLES.join(", ")}.`);
    args.push("--angle", angle);
  }
  args.push("--res", String(Math.min(Math.max(Number(opts.res) || 1024, 256), 2048)));
  args.push("--aspect", opts.aspect || "square");
  args.push("--samples", String(Math.min(Math.max(Number(opts.samples) || 64, 8), 256)));
  if (Number.isFinite(opts.lens)) args.push("--lens", String(opts.lens));
  if (opts.transparent) args.push("--transparent");

  return runPreviz(args, { timeoutMs: opts.timeoutMs });
}

/* ─────────────────────────────────────── the take, recorded like any other */

/**
 * Render a declared row's sheet with Blender and record it EXACTLY as
 * generateAsset records one.
 *
 * That sentence is the specification. This is not a parallel asset system: it
 * appends `{file, seed, at, ms}` to the same `takes[]`, auto-selects the first
 * into the same `imageFile`, sets the same `status`, files the file under the
 * same `char_`/`bg_`/`prop_` prefix, and looks the row up with generate.js's
 * own findRow. Boards therefore compose from a Blender sheet without knowing it
 * is one, pickTake's stale-cascade fires on it, mv_lint counts it, and
 * build_timeline never learns this file exists. A new field would have been
 * cheaper to write and would have quietly forked the document.
 *
 * ⚠ `seed: null` is the truth, and it means what import_asset means by it:
 * there is no seed. The render is deterministic — the same mesh, the same
 * camera, the same pixels — so four seeds would give four identical files. The
 * variation is the ANGLE, which is recorded on the take instead.
 *
 * NOTHING BECOMES `imageFile` UNTIL IT PASSES THE GATE. Every rendered panel is
 * checked with referenceSafe() before it is staged, and a render that cannot
 * prove itself a model-reference is dropped with its reason. A contact sheet
 * cannot arrive here — the toolkit will not write one to a reference path and
 * renderReference() will not ask for one — and if one ever did, this is where
 * it would stop.
 */
export async function blenderAsset(slug, {
  target = "prop", id, builtin, asset, angles, res, aspect, samples, lens, transparent,
} = {}) {
  if (!["character", "background", "prop"].includes(target)) {
    throw new Error(`Blender renders a character, background or prop sheet — not a "${target}".`
      + ` A board is a composed shot; compose it with generate_asset from the sheets this makes.`);
  }
  const wanted = (Array.isArray(angles) && angles.length ? angles : DEFAULT_ANGLES).slice(0, 8);
  for (const a of wanted) {
    if (!ANGLES.includes(a)) throw new Error(`Unknown angle "${a}". Try: ${ANGLES.join(", ")}.`);
  }

  /* ⚠ FIND THE ROW FIRST, and this was measured rather than reasoned.
   *
   * The row was originally looked up only inside updateProject at the bottom,
   * which is where generateAsset writes — so a misspelt name rendered all three
   * angles, staged all three into assets/, and only THEN said "No such prop".
   * Found by counting the files: a project with three takes had six sheets in
   * its asset folder, three of them orphans from a call that failed. It reads
   * as a slow error; it is really ten seconds of GPU and three files nothing
   * points at.
   *
   * Read-then-write is not atomic, and does not need to be: the second lookup
   * inside the transaction is still the authority (the same shape generateAsset
   * uses). This one exists only to fail before spending anything. */
  const doc0 = await readProject(slug);
  if (!doc0) throw new Error(`No such project: ${slug}`);
  findRow(doc0, target, id);

  /* Render into the project's own scratch dir, then stage into assets/ exactly
   * as a generated image is staged out of the art queue's output folder. Two
   * copies is the existing shape, not a new one. */
  const scratch = path.join(projectDir(slug), "blender");
  await mkdir(scratch, { recursive: true });
  const stamp = Date.now().toString(36);

  const made = [];       // { staged, angle, result }
  const refused = [];    // { angle, why } — a panel the gate would not pass
  const askedAt = Date.now();
  /* ⚠ `finally`, because a REFUSED render leaves a directory behind too. The
   * first version cleaned up only on the way out of a successful loop, so every
   * rejected call — an unknown mesh, a missing .blend — left an empty
   * `blender/` folder inside the project, and a Blender that died mid-render
   * would have left the half-written png in it forever. */
  try {
    for (const angle of wanted) {
      const out = path.join(scratch, `${target}_${stamp}_${angle}.png`);
      const result = await renderReference(out, { builtin, asset },
                                           { angle, res, aspect, samples, lens, transparent });

      /* THE GATE. Reads the sidecar the render just wrote, on this side of the
       * licence boundary, with no bpy anywhere near it. `proven` rather than
       * `safe`: we rendered this file seconds ago, so an absent declaration is a
       * fault in the render, not an unknown provenance. */
      const gate = await referenceSafe(out);
      if (!gate.proven) {
        refused.push({ angle, why: gate.why.length ? gate.why : ["no sidecar declared it a model reference"] });
        continue;
      }

      const staged = await stageAsset(slug, out,
        target === "character" ? "char" : target === "background" ? "bg" : "prop");
      /* Carry the sidecar into the asset folder beside the picture it describes.
       * The claim "this file is a model reference" is then re-checkable later, by
       * anything, with no Blender and no memory of this call. */
      try {
        await writeFile(path.join(assetsDir(slug), staged + SIDECAR_SUFFIX),
                        JSON.stringify(gate.sidecar, null, 2), "utf8");
      } catch { /* provenance is a bonus; the picture is the artefact */ }
      made.push({ staged, angle, result });
    }
  } finally {
    /* Whatever survived has been copied into assets/, sidecars and all. Leaving
     * the scratch would grow a second copy of every sheet in the project. */
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
  const tookMs = Date.now() - askedAt;

  if (!made.length) {
    throw new Error(
      `Nothing Blender rendered could be used as a reference:\n`
      + refused.map((r) => `  ${r.angle}: ${r.why.join("; ")}`).join("\n"));
  }

  return updateProject(slug, (doc) => {
    const row = findRow(doc, target, id);
    row.takes = row.takes || [];
    for (const m of made) {
      row.takes.push({
        file: m.staged,
        seed: null,                       // deterministic: there is no seed
        at: Date.now(),
        ms: Math.round(tookMs / made.length),
        /* What made it, kept on the take so a second pass can reproduce it and
         * so a person looking at four grey pictures can tell them apart. */
        blender: {
          angle: m.angle,
          source: builtin ? `builtin:${builtin}` : `asset:${path.basename(String(asset))}`,
          subjects: m.result.subject_names || [],
          use: m.result.use,
          coverage: m.result.exposure?.coverage ?? null,
          edgeSeams: m.result.exposure?.card_edge_seams ?? null,
        },
      });
      if (!row.imageFile) row.imageFile = m.staged;   // first take auto-selects
    }
    row.status = "rendered";
    const label = row.name || row.id;
    noteRun(doc, {
      tool: "blender_asset",
      outcome: `${target} ${label}: +${made.length} take${made.length === 1 ? "" : "s"} from Blender`
        + `${refused.length ? ` (${refused.length} refused by the reference gate)` : ""}`,
    });
    return doc;
  }).then((doc) => ({ doc, made, refused }));
}
