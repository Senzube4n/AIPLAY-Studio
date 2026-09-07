/**
 * Video lab — the frame-locked still strip.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS, IN ONE MEASUREMENT. The comparison panel argues an 84 px
 * face at 1792x1008 against a 58 px one at native (docs/RESOLUTION_FOR_FACES.md).
 * It used to make that argument beside four <video> elements 260 px wide. At
 * 260 px those faces are about 12 px and 11 px on screen: the difference the
 * panel exists to teach was invisible IN the panel. A comparison you cannot see
 * is a comparison nobody made.
 *
 * So the strip: the SAME numbered frames out of every arm, extracted at full
 * resolution, drawn at a scale a person picks and zoomable to 1:1. Rows are
 * arms, columns are frames. Frame 0 is in the default set on purpose — that is
 * where reference bleed lives (docs/H3_REFERENCE_BLEED.md), and a sampler that
 * politely skips the opening frames hides the finding.
 *
 * ── WHERE THE PICTURES ARE SERVED FROM, AND WHY IT LOOKS ODD ──────────────
 * server/index.js dispatches this subsystem on `p === "/api/videolab"` and
 * nothing else, so this route CANNOT mint a URL of its own — a tidy-looking
 * `/api/videolab/still/x.jpg` would 404 with no clue why. The stills are
 * therefore written into the clip library's own cache folder and served by the
 * clip route that is already there, which brings Range, ETag-free simple
 * serving and the same traversal refusals for free. `.stills` is dot-prefixed
 * for the same reason `.thumbs` is: /api/clips lists by media EXTENSION, and a
 * folder has none, so the cache cannot appear in anybody's clip grid.
 *
 * ── THE CACHE IS ADDRESSED BY THE CLIP'S BYTES, NOT BY THE GROUP ──────────
 * The key is name + mtime + size of the source file. Two consequences, both
 * wanted: an `enhance` that rewrites a clip under its own name invalidates its
 * stills (the same staleness rule /api/clipthumb learned the hard way), and two
 * arms that RESOLVED TO THE SAME RENDER — the hybrid/LTX twin this surface
 * already knows about — share one set of files instead of decoding the same
 * frames twice.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { stat, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "..", "scripts", "clipstills.py");

/** The clip library, the same folder server/art.js writes finished clips into. */
const CLIP_DIR = () => path.join(config.outputDir, "clips");

/**
 * The cache folder, and the URL prefix that serves it.
 *
 * ⚠ These two strings are a PAIR: `/api/clip/` is a route server/index.js
 * really dispatches, and `.stills` sits under the directory that route serves.
 * server/videolab/ui_test.js checks both halves, because getting this wrong
 * produces a silent 404 in a panel that otherwise looks finished.
 */
export const STILL_SUBDIR = ".stills";
export const STILL_URL = "/api/clip/";

const stillsDir = () => path.join(CLIP_DIR(), STILL_SUBDIR);

/**
 * A content address for one clip's frames.
 *
 * mtime AND size, not existence: a clip can be replaced under its own name and a
 * cached still of the version before that is a picture of footage that is gone.
 */
async function addressOf(clipName) {
  const full = path.join(CLIP_DIR(), clipName);
  const st = await stat(full);
  const key = `${clipName}:${Math.round(st.mtimeMs)}:${st.size}`;
  return { full, prefix: createHash("sha1").update(key).digest("hex").slice(0, 16) };
}

function runScript(job) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(config.python, [SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      resolve({ error: "could not start python" });
      return;
    }
    let so = "", se = "";
    proc.stdout.on("data", (d) => (so += d));
    proc.stderr.on("data", (d) => (se += d));
    proc.on("error", () => resolve({ error: "could not start python" }));
    proc.on("exit", () => {
      try { resolve(JSON.parse(so)); }
      catch { resolve({ error: se.slice(-300) || "the frame reader said nothing" }); }
    });
    proc.stdin.on("error", () => {});
    proc.stdin.end(JSON.stringify(job));
  });
}

/**
 * The strip for one comparison group.
 *
 * @param {object}   group   a stored group, arms and all
 * @param {number[]} frames  which frame numbers; clamped to the shortest arm
 * @param {number}   quality JPEG quality, 40-95
 */
export async function groupStills(group, frames, quality) {
  const arms = (group.arms || []).filter((a) => a.clip);
  if (!arms.length) {
    return {
      frames: [], requested: frames, rows: [],
      note: "No arm of this comparison produced a clip, so there is nothing to take a frame out of.",
    };
  }

  const clips = [];
  const failed = [];
  for (const a of arms) {
    try {
      const { full, prefix } = await addressOf(a.clip);
      clips.push({ key: a.id, src: full, prefix });
    } catch {
      /* The record outlives the file: a group is kept for fifty comparisons and
       * a clip can be deleted from the library in between. Say which arm, once,
       * rather than failing the whole strip. */
      failed.push({ armId: a.id, error: `${a.clip} is no longer in the clip library.` });
    }
  }
  if (!clips.length) {
    return {
      frames: [], requested: frames, rows: failed.map((f) => ({ ...f, stills: [] })),
      note: "Every clip in this comparison has been removed from the library.",
    };
  }

  await mkdir(stillsDir(), { recursive: true }).catch(() => {});
  const out = await runScript({
    destDir: stillsDir(),
    frames,
    quality: Math.max(40, Math.min(Number(quality) || 88, 95)),
    clips,
  });
  if (out.error) throw new Error(`Could not read frames: ${out.error}`);

  const byKey = new Map((out.clips || []).map((c) => [c.key, c]));
  const rows = [];
  for (const a of group.arms || []) {
    const gone = failed.find((f) => f.armId === a.id);
    const c = byKey.get(a.id);
    rows.push({
      armId: a.id,
      label: a.label,
      clip: a.clip || null,
      engine: a.engine,
      status: a.status,
      sizeLabel: a.sizeLabel,
      /* WHAT THE ARM ASKED FOR beside WHAT THE FILE HOLDS. They agree on
       * everything measured so far; when they stop agreeing, the picture is the
       * one telling the truth, and a comparison that quoted only the request
       * would be arguing about a size nothing rendered at. */
      askedWidth: a.width ?? null, askedHeight: a.height ?? null,
      width: c?.width ?? null, height: c?.height ?? null,
      sourceFrames: c?.frames ?? null,
      fps: c?.fps ?? null,
      durationSec: c && c.fps ? Math.round((c.frames / c.fps) * 1000) / 1000 : null,
      error: gone?.error || c?.error || (a.clip ? null : `This arm ${a.status === "done" ? "produced no clip" : a.status}.`),
      stills: (c?.stills || []).map((s) => ({
        frame: s.frame, atSec: s.atSec,
        url: STILL_URL + `${STILL_SUBDIR}/${s.file}`,
        w: s.w, h: s.h, bytes: s.bytes ?? null,
      })),
      missing: (c?.missing || []).map((s) => ({ frame: s.frame, error: s.error })),
    });
  }

  return {
    frames: out.frames || [],
    requested: out.requested || frames,
    clamped: out.clamped || null,
    shortest: out.shortest || null,
    rows,
    note: out.clamped || null,
  };
}
