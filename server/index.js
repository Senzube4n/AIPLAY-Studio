/**
 * AIPLAY Studio — local server.
 *
 * Serves the UI and brokers between it and one long-lived ComfyUI process.
 * Packaging as a desktop app (Tauri) wraps this unchanged; the frontend is web
 * either way, so nothing here is throwaway.
 */
import http from "node:http";
import { readFile, stat, writeFile, unlink, mkdir, readdir, rename } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { WebSocketServer } from "ws";
import { config, prefsSnapshot } from "./config.js";
import os from "node:os";
import { deriveTitle, videoEngine, videoReady, enhanceCost, guideStrengths } from "./workflow.js";
import { ComfySupervisor } from "./comfy.js";
import { JobRunner } from "./jobs.js";
import { Library } from "./library.js";
import { BatchRunner } from "./batch.js";
import { gpuStatus, ramStatus } from "./gpu.js";
import { ArtRunner, COVER_DIR, LRC_DIR, CLIP_DIR, IMAGE_DIR, coverNameFor } from "./art.js";
import { setSecret, clearSecret, secretStatus, protectionAvailable } from "./secrets.js";
import { apiStatus, spendSummary, estimateUsd, PROVIDERS } from "./apiEngine.js";
import { listCustom, CUSTOM_DIR, TOKENS, KINDS } from "./customWorkflows.js";
import { ModelManager, diskFree, CATALOG } from "./models.js";
import * as reactive from "./reactive.js";
import { convert as convertAudio, FORMATS as AUDIO_FORMATS } from "./exportAudio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(__dirname, "..", "web");

const comfy = new ComfySupervisor();
const jobs = new JobRunner(comfy);
const library = new Library();
/* `postBusy` lets a run hold the machine awake until its covers, stems, lyrics
 * and clips have drained — not merely until the last song rendered. Injected so
 * batch.js keeps knowing nothing about the art runner. */
const batch = new BatchRunner(jobs, {
  postBusy: () => art.queue.length > 0 || !!art.current,
});
// Draws covers only while the music queue is empty — see art.js for why that is
// a hard requirement rather than politeness.
const art = new ArtRunner(comfy, jobs);

// A finished cover is metadata like any other, so it goes through the same
// sidecar the rest of the library uses.
art.on("cover", async ({ file, covers, thumbs }) => {
  /* ⚠ A standalone image is not a cover.
   *
   * It rides the same engine and therefore the same event, but it belongs to no
   * track — writing it into the library sidecar would invent an `image:i123`
   * entry the library then tries to find audio for, and the tagging pass below
   * would look for a FLAC that does not exist. Handled by its own listener. */
  if (String(file).startsWith("image:")) return;
  if (covers?.length) library.remember(file, { cover: covers[0], covers, thumb: thumbs?.[0] || null });
  batch.noteStage(file, "cover", covers?.length ? "done" : "failed");
  push(jobs.snapshot());
  /* Second tagging pass, purely to embed the art.
   *
   * The first pass runs when the song lands, and at that moment no cover exists
   * — it has not even been queued. So a file tagged once carries its provenance
   * and no picture, which is why every export looked blank in other players.
   * Re-tagging here is the only point at which both halves exist.
   *
   * Best-effort by design: a failure must cost the artwork, never the audio. */
  if (!covers?.length) return;
  try {
    await embedCover(file, covers[0]);
  } catch (err) {
    console.error(`  cover embed failed for ${file}: ${err.message}`);
  }
});

/**
 * Re-tag a finished track so its cover travels inside the file.
 *
 * Rebuilds the same metadata the first pass wrote, from the sidecar, so the
 * second pass never drops a field the first one set.
 */
async function embedCover(file, coverName) {
  const m = library.meta.get(file) || {};
  const meta = {
    title: m.title, caption: m.caption, lyrics: m.lyrics,
    seed: m.seed, mixSeed: m.mixSeed, steps: m.steps,
    cfg: m.cfg, shift: config.sampling.shift,
    model: m.model || "int8",
    date: new Date(m.createdAt || Date.now()).toISOString().slice(0, 10),
  };
  const res = await library.tagFile(file, meta, path.join(COVER_DIR, coverName));
  if (res?.cover) library.remember(file, { coverEmbedded: true });
  return res;
}
art.on("stems", ({ file, stems }) => {
  if (stems?.length) library.remember(file, { stems });
  batch.noteStage(file, "stems", stems?.length ? "done" : "failed");
  push(jobs.snapshot());
});
/* An enhanced clip is a first-class clip: it lands in the same folder, shows in
 * the same grid, and carries provenance saying what it came from and what was
 * done. It is never written into a track's sidecar — the ORIGINAL is still that
 * track's clip, and quietly repointing it would make a non-destructive action
 * destructive at the one place it matters. */
/* A restyled clip is a NEW clip, never a replacement — same rule as an
 * enhancement. The original is what the timeline may already point at. */
art.on("restyled", ({ clip, seconds, meta }) => {
  if (clip && seconds) clipTimes.set(clip, seconds);
  if (clip && meta) clipMeta.set(clip, meta);
  if (clip) saveClipStore();
  push(jobs.snapshot());
});
art.on("enhanced", ({ source, clip, seconds, meta, owner }) => {
  // An Overnight run's row is ticked here, not where the job was queued: the
  // stage is only done when the file exists.
  if (owner) batch.noteStage(owner, "enhance", clip ? "done" : "failed");
  if (clip && seconds) clipTimes.set(clip, seconds);
  if (clip && meta) clipMeta.set(clip, meta);
  if (clip) saveClipStore();
  push(jobs.snapshot());
});
/* A standalone image has no track to be written against, so its provenance
 * lives in the same side-map that standalone clips use. */
art.on("cover", ({ file, covers, seed, durationMs, engine }) => {
  if (!file.startsWith("image:") || !covers?.length) return;
  for (const name of covers) {
    imageMeta.set(name, { prompt: pendingImagePrompt.get(file) || "", seed, at: Date.now(),
                          durationMs: durationMs ?? null, engine: engine || "flux2" });
  }
  pendingImagePrompt.delete(file);
  saveImageStore();
  push(jobs.snapshot());
});
/* A stage that failed is a stage that FINISHED, as far as the display goes.
 *
 * The runner's success events each tick their own row off; nothing ticked a row
 * off when the job threw, so a single exception left an Overnight run showing
 * "waiting" for the rest of its life. The one thing worse than a visible
 * failure is a row that never resolves, because it teaches people to ignore the
 * panel entirely. */
const STAGE_OF_KIND = { video: "video", enhance: "enhance", stems: "stems", lrc: "lrc", cover: "cover" };
art.on("failed", ({ file, kind, owner }) => {
  const stage = STAGE_OF_KIND[kind];
  if (!stage) return;
  // An enhance job is named after the clip; its row belongs to the song.
  const target = owner || file;
  if (String(target).startsWith("clip:") || String(target).startsWith("image:")) return;
  batch.noteStage(target, stage, "failed");
  /* Video failing takes enhancement down with it — there is no clip for it to
   * work on, so the row would otherwise wait on something that is not coming. */
  if (kind === "video") batch.noteStage(target, "enhance", "failed");
  push(jobs.snapshot());
});

art.on("clip", ({ file, clip, seconds, meta }) => {
  // A standalone clip belongs to no track, so it must not be written into the
  // library sidecar — that would invent a `clip:v123` entry the library then
  // tries to find audio for. Its render time is kept separately, keyed by the
  // clip filename, so the gallery can show what it cost either way.
  /* ⚠ `clipRenderSeconds`, NOT `clipSeconds`.
   *
   * This number is how long the RENDER took. The clip's own duration lives at
   * `clipMeta.clipSeconds` — and the sidecar used to spell its render time
   * `clipSeconds` too, so the same key meant two different things in two
   * objects written on the same line. That confusion has already caused one
   * measured bug: the enhancement estimator read a 99-second render as 99
   * seconds of video, costed it at 2376 frames and ~51 GB, and refused a clip
   * that was actually five seconds long. */
  if (clip && !file.startsWith("clip:")) library.remember(file, { clip, clipRenderSeconds: seconds, clipMeta: meta });
  if (clip && seconds) clipTimes.set(clip, seconds);
  // Standalone clips have no library row, so their provenance lives here.
  if (clip && meta) clipMeta.set(clip, meta);
  if (clip && (seconds || meta)) saveClipStore();
  if (!file.startsWith("clip:")) batch.noteStage(file, "video", clip ? "done" : "failed");

  /* Chain the enhancement off the CLIP, not off the song.
   *
   * Every other post-stage takes the finished audio and can start the moment it
   * exists. This one takes a clip, so it can only be queued here — and only if
   * a clip was actually produced. */
  if (clip && batch.wantsStage(file, "enhance")) {
    // `file` travels with the job so the enhanced event can tick the run's row
    // off — the event itself only knows the clip it made, not the song it
    // ultimately belongs to.
    if (!queueEnhance(clip, meta, "overnight", null, file)) {
      batch.noteStage(file, "enhance", "failed");
    }
  }
  push(jobs.snapshot());
});

/* How long each clip took, keyed by its filename.
 *
 * In memory only: a render time is worth showing while you are looking at what
 * you just made, and not worth a schema for. Track-attached clips also record it
 * in the sidecar, which is the copy that survives a restart. */
/**
 * How much memory an enhancement may ask for.
 *
 * Every frame of an upscale is held at full size, so the peak is the batch
 * itself and no amount of VRAM tiling reduces it. A fixed number would be
 * calibrated to whatever machine wrote it — 24 GB is generous on 32 GB and
 * fatal on 16 — so it scales, leaving room for ComfyUI's resident weights, the
 * OS, and the browser this UI runs in.
 */
function enhanceLimitBytes() {
  return Math.max(4e9, os.totalmem() * 0.55);
}

/* Provenance for standalone images. The cover event reports which files it
 * wrote but not what was asked for, so the prompt is parked here between the
 * request and the result. */
const imageMeta = new Map();
const pendingImagePrompt = new Map();
const IMAGE_STORE = path.join(config.outputDir, "images", "_meta.json");
async function saveImageStore() {
  try {
    await mkdir(path.dirname(IMAGE_STORE), { recursive: true });
    await writeFile(IMAGE_STORE, JSON.stringify(Object.fromEntries(imageMeta)));
  } catch { /* provenance is a nicety; losing it must not fail a render */ }
}
try {
  const raw = JSON.parse(await readFile(IMAGE_STORE, "utf8"));
  for (const [k, v] of Object.entries(raw)) imageMeta.set(k, v);
} catch { /* none yet */ }

/** Saved Studio projects. Beside the media they reference, not in the browser. */
const PROJECT_DIR = path.join(config.outputDir, "projects");

const clipTimes = new Map();

/* What each clip was MADE from, keyed by filename.
 *
 * The point is reuse: a clip you liked is worth varying, and a timeline needs to
 * be able to re-roll one in place. Music has carried this since the start; clips
 * carried only a duration, which made every good one a dead end.
 *
 * In memory for standalone clips (they are not library rows); track-attached
 * ones also go into the sidecar, which is the copy that survives a restart. */
const clipMeta = new Map();

/**
 * Both of the above, on disk.
 *
 * Small enough to rewrite whole on every change, and written debounced because a
 * batch of ten clips would otherwise do ten writes in a second for no gain. Read
 * failures are silent on purpose: a corrupt or missing store should cost you the
 * provenance of old clips, never the ability to start the app.
 */
const CLIP_STORE = path.join(config.paths.appData, "clips.json");
let clipStoreTimer = null;

async function loadClipStore() {
  try {
    const raw = JSON.parse(await readFile(CLIP_STORE, "utf8"));
    for (const [k, v] of Object.entries(raw.meta ?? {})) clipMeta.set(k, v);
    for (const [k, v] of Object.entries(raw.times ?? {})) clipTimes.set(k, v);
  } catch { /* first run, or unreadable — neither is worth failing over */ }
}

function saveClipStore() {
  clearTimeout(clipStoreTimer);
  clipStoreTimer = setTimeout(() => {
    writeFile(CLIP_STORE, JSON.stringify({
      meta: Object.fromEntries(clipMeta),
      times: Object.fromEntries(clipTimes),
    }, null, 2), "utf8").catch(() => {});
  }, 400);
}
art.on("lrc", ({ file, lrc, wordLrc, confidence, lines }) => {
  // `confidence` is the share of words timed by measurement rather than
  // interpolation. Stored so the UI can be honest about the word-level file
  // instead of presenting every alignment as equally trustworthy.
  library.remember(file, { lrc, wordLrc, lrcConfidence: confidence, lrcLines: lines });
  batch.noteStage(file, "lrc", lrc ? "done" : "failed");
  push(jobs.snapshot());
});
art.on("update", () => {
  // The tail of an overnight pipeline finishing is the moment the sleep lock
  // can finally be dropped.
  batch.checkAwake();
  push(jobs.snapshot());
});

// Optional model weights. Nothing here downloads on its own — the catalogue
// reports what is missing and how large it is, and the user presses a button.
const models = new ModelManager();
models.on("update", () => push(jobs.snapshot()));

/**
 * Which python packages the optional features need.
 *
 * Checked against the SYSTEM python, not the ComfyUI venv: faster-whisper and
 * demucs are separate tools that happen to need torch, and installing them into
 * the engine's environment risks moving the torch build the engine depends on —
 * which on this stack is the difference between fused CUDA kernels and a
 * silently 5x slower app.
 */
const SYSTEM_PYTHON = process.env.AIPLAY_SYS_PYTHON
  || path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python310", "python.exe");
let packageCache = null;
async function pythonPackages() {
  if (packageCache && Date.now() - packageCache.at < 30_000) return packageCache.value;
  const value = await new Promise((resolve) => {
    const proc = spawn(SYSTEM_PYTHON, ["-c",
      "import importlib.util as u,json;print(json.dumps({m:u.find_spec(m) is not None for m in ['demucs','faster_whisper','torch','av','numpy']}))"]);
    let so = "";
    proc.stdout.on("data", (d) => (so += d));
    proc.on("exit", () => { try { resolve(JSON.parse(so)); } catch { resolve({}); } });
    proc.on("error", () => resolve({}));
  });
  packageCache = { at: Date.now(), value };
  return value;
}

// When a job finishes: stamp provenance into the file and record what the file
// cannot say. `renderSeconds` is how long it took to make; `durationSeconds` is
// how long the music is — two different numbers that were previously conflated.
const tagged = new Set();
jobs.on("update", async (snap) => {
  const h = snap.history[0];
  if (!h || h.state !== "done" || !h.file || tagged.has(h.file)) return;
  tagged.add(h.file);

  const job = jobs.history.find((j) => j.file === h.file) || {};

  // An extension arrives as its own file containing only the new section. Splice
  // it onto the original at the resume point so the user gets one whole song.
  // Both source files are kept: the original is untouched, so a bad extension
  // costs nothing but disk.
  if (job.extendedFrom) {
    try {
      const at = (job.resumeFrames || 0) / 25;
      const joined = await library.joinExtension(job.extendedFrom, h.file, at);
      if (joined) {
        // Splice the trajectories too, or a second extension would resume from
        // the last section alone and forget the song it belongs to.
        const priorCodes = library.meta.get(job.extendedFrom)?.codes;
        const chained = await library.spliceTrajectory(
          priorCodes, h.codes, job.resumeFrames || 0);
        library.remember(joined, {
          title: h.title, seed: h.seed, caption: job.caption, lyrics: job.lyrics,
          model: job.model, steps: h.steps,
          codes: chained || h.codes,
          extendedFrom: job.extendedFrom,
          // WHERE the model rejoined, so this take's own new material can later
          // be isolated. Without it a merge cannot tell which part of a branch is
          // new, and every branch would drag a copy of the parent along with it.
          joinedAt: at,
          createdAt: Date.now(),
        });
        console.log(`  extension joined at ${at.toFixed(1)}s -> ${joined}`
          + (chained ? " (trajectory chained)" : " (trajectory NOT chained)"));
      }
    } catch (err) {
      console.error(`  join failed (both parts kept): ${err.message}`);
    }
  }

  library.remember(h.file, {
    title: h.title, seed: h.seed, mixSeed: h.mixSeed, steps: h.steps,
    cfg: job.cfg, model: job.model, caption: job.caption,
    // Kept so the song panel can show what actually produced the track. It is in
    // the FLAC tags too, but reading tags back per row would mean a subprocess
    // per track just to draw a list.
    lyrics: job.lyrics,
    // Path to the captured AR trajectory. Its presence is what makes a track
    // extendable — anything rendered before the capture patch has none, and
    // never will.
    codes: h.codes,
    instrumental: h.instrumental, preview: h.preview, reroll: h.reroll,
    renderSeconds: h.durationSeconds, createdAt: h.createdAt,
  });

  try {
    const meta = {
      title: h.title, caption: job.caption, lyrics: job.lyrics,
      seed: h.seed, mixSeed: h.mixSeed, steps: job.steps ?? config.sampling.steps,
      cfg: job.cfg ?? config.sampling.cfg, shift: config.sampling.shift,
      model: job.model || "int8", date: new Date().toISOString().slice(0, 10),
    };
    const info = await library.tagFile(h.file, meta);
    if (info?.seconds) library.remember(h.file, { durationSeconds: Math.round(info.seconds) });
  } catch { /* never lose a track over a tag */ }

  // Ask for a cover. This only QUEUES — the runner waits for the music queue to
  // empty before touching the GPU, so an overnight batch draws all of its art at
  // the end rather than evicting the music models between every song.
  if (!h.preview) {
    /* What runs after this song.
     *
     * Read off the JOB, not off the live batch run. Both this listener and the
     * batch runner are on the same emitter and the batch one fires first, so on
     * the last song of a run the run had already flipped to "done" and this saw
     * nothing — every overnight run silently lost one song's post-processing.
     * The chain now travels with the job, so ordering cannot matter. */
    const live = job.stages || null;
    const want = (k, globalWhen) => (live ? !!live[k] : globalWhen === "all");

    // The Overnight "Cover art" checkbox used to be decorative: this fired
    // unconditionally and never consulted it. Outside a run, art.enabled is
    // still the switch, which is what the Settings dropdown means.
    if (live ? live.cover : true) {
      art.request({
        file: h.file, title: h.title, caption: job.caption,
        // Same seed as the music, so a cover is reproducible from the song's own
        // provenance rather than being a second unrecorded random number.
        seed: h.seed,
      });
    }
    // Stems only when the setting asks for every track. The starred/liked modes
    // are handled where the flag is SET, not here — at generation time nobody
    // has starred anything yet, so triggering on those here would never fire.
    /* A run's chain wins over the global settings for songs it produced, so a
     * run does what it was told to do at bedtime regardless of what the
     * dropdowns say by morning. `live` above is that chain. */
    if (want("stems", config.stems.when)) {
      art.request({ file: h.file, title: h.title, kind: "stems" });
    }
    // Timed lyrics need words. An instrumental has none, and asking whisper to
    // align nothing wastes a minute of GPU to produce an empty file.
    if (want("lrc", config.lyrics.when) && (job.lyrics || "").trim()) {
      art.request({ file: h.file, title: h.title, kind: "lrc", lyrics: job.lyrics });
    }
    /* Video, on the same terms as every other stage: the RUN'S CHAIN WINS.
     *
     * This used to also require `config.video.enabled`, a Settings toggle that
     * defaults to off. So a run could tick "video", the panel would list the
     * stage, and nothing would ever queue it — the row said "waiting" until
     * morning and no error was written anywhere. The chain is an explicit
     * instruction for THIS run and outranks a global default, exactly as it
     * already does for cover, stems and lyrics.
     *
     * What genuinely CAN stop it is missing weights, so that is what is checked
     * — and a stage that cannot run is FAILED rather than left waiting, because
     * a row stuck at "waiting" is indistinguishable from one still queued. */
    if (want("video", config.video.when)) {
      const vr = videoReady();
      if (vr.ready) {
        art.request({ file: h.file, title: h.title, caption: job.caption, seed: h.seed, kind: "video" });
      } else {
        console.warn(`  [video] skipped for ${h.file} — missing: ${vr.missing.join(", ")}`);
        batch.noteStage(h.file, "video", "failed");
        // Enhancement chains off the clip, so it can never arrive either.
        batch.noteStage(h.file, "enhance", "failed");
      }
    }
  }
});

/**
 * Write the preference half of Settings back to disk.
 *
 * Called after every switch a user can flip. Fire-and-forget on purpose: the
 * setting has ALREADY taken effect in memory by the time this runs, so a failed
 * write costs the memory of the choice and nothing else, and blocking the reply
 * on a disk round-trip would make every toggle feel slow.
 *
 * Read-merge-write, never a blind overwrite: the same file holds the folder
 * paths, the API mode and the custom-workflow assignments, and three other
 * routes write those.
 */
async function savePrefs() {
  try {
    let cur = {};
    try { cur = JSON.parse(await readFile(config.settingsFile, "utf-8")); } catch { /* first write */ }
    await mkdir(path.dirname(config.settingsFile), { recursive: true });
    await writeFile(config.settingsFile,
      JSON.stringify({ ...cur, prefs: prefsSnapshot() }, null, 2), "utf-8");
  } catch (err) {
    console.warn(`  [settings] could not be saved: ${err.message}`);
  }
}

/**
 * The beat analysis for a track, straight from the same on-disk cache
 * `/api/beats/` writes. Three seconds of CPU the first time, milliseconds after.
 */
async function beatsFor(song) {
  const cache = path.join(config.outputDir, ".beats", `${song}.json`);
  try {
    const st = await stat(path.join(config.outputDir, song));
    const hit = JSON.parse(await readFile(cache, "utf-8"));
    if (hit.srcMtime === Math.round(st.mtimeMs)) return hit;
  } catch { /* not analysed yet */ }
  const r = await new Promise((resolve) => {
    const proc = spawn(config.python, [path.join(__dirname, "..", "scripts", "beats.py"),
                                       path.join(config.outputDir, song)]);
    let so = "", se = "";
    proc.stdout.on("data", (d) => (so += d));
    proc.stderr.on("data", (d) => (se += d));
    proc.on("exit", (code) => resolve({ code, so, se }));
    proc.on("error", () => resolve({ code: 1, so: "", se: "spawn failed" }));
  });
  try {
    const d = JSON.parse(r.so);
    return d.error ? null : d;
  } catch { return null; }
}

/** The four named outcomes, server-side. Mirrors ENH_MODES in the client. */
const ENHANCE_MODES = {
  smooth: { interpolate: true, upscale: false, multiplier: 2, slow: false, scale: 1 },
  slowmo: { interpolate: true, upscale: false, multiplier: 2, slow: true, scale: 1 },
  bigger: { interpolate: false, upscale: true, multiplier: 1, slow: false, scale: 2 },
  both:   { interpolate: true, upscale: true, multiplier: 2, slow: false, scale: 2 },
};

/**
 * Queue an enhancement, choosing a mode that will actually fit.
 *
 * Used by the Overnight chain and the one-click button, both of which run
 * without anyone watching the numbers. Rather than failing on a clip that turns
 * out to be too large, it steps DOWN through the modes until one fits and
 * reports which one it used — a quiet failure at 3am and a silent downgrade are
 * both worse than a job that says what it did.
 *
 * @returns {{mode: string, cost: object}|null} null when nothing fits at all
 */
function queueEnhance(clipName, meta, why, preferred = null, owner = null) {
  const order = preferred
    ? [preferred, ...["both", "bigger", "smooth"].filter((m) => m !== preferred)]
    : [config.enhance.mode || "smooth", "smooth"];
  const w = Number(meta?.width) || 1280;
  const h = Number(meta?.height) || 704;
  const secs = Number(meta?.clipSeconds) || 10;

  for (const name of order) {
    const m = ENHANCE_MODES[name];
    if (!m) continue;
    const cost = enhanceCost({
      width: w, height: h, seconds: secs, fps: 24,
      multiplier: m.interpolate ? m.multiplier : 1, scale: m.upscale ? m.scale : 1,
    });
    if (cost.peakBytes > enhanceLimitBytes()) continue;
    art.request({
      file: clipName, title: clipName, kind: "enhance", force: true,
      video: {
        interpolate: m.interpolate
          ? { model: "rife_v4.26.safetensors", multiplier: m.multiplier, slow: m.slow }
          : null,
        upscale: m.upscale
          ? { model: "RealESRGAN_x2.pth", label: `${m.scale}x`, scale: m.scale }
          : null,
        keepAudio: true,
        srcWidth: w, srcHeight: h, srcSeconds: secs,
        owner,
      },
    });
    console.log(`  [enhance] ${clipName} → ${name} (${why})`);
    return { mode: name, cost };
  }
  console.warn(`  [enhance] ${clipName} skipped — even the cheapest option needs more memory than this machine can give`);
  return null;
}

/**
 * Flagging a track is the moment it becomes worth post-processing.
 *
 * The starred/liked modes CANNOT be handled at generation time — nothing has
 * been starred yet when a song finishes — so they are triggered here instead,
 * where the flag is actually set.
 */
function maybePost(file, flag, on) {
  if (!on) return;
  const m = library.meta.get(file) || {};
  const matches = (w) => (w === "starred" && flag === "starred") || (w === "liked" && flag === "rating");
  if (matches(config.stems.when)) {
    art.request({ file, title: m.title, kind: "stems" });
  }
  if (matches(config.lyrics.when) && (m.lyrics || "").trim()) {
    art.request({ file, title: m.title, kind: "lrc", lyrics: m.lyrics });
  }
  // Video has the same two flag-driven modes as the others, and was the only
  // stage missing from here — so "make a clip for anything I star" could be
  // selected in Settings and would never fire.
  if (config.video.enabled && matches(config.video.when)) {
    art.request({ file, title: m.title, caption: m.caption, seed: m.seed, kind: "video" });
  }
}

/**
 * Repair the links the feed hands us.
 *
 * Two independent faults, both of which produced a dead page:
 *   - the host was the PRODUCTION site while the ids come from dev, and
 *   - the path segment is `/session/<id>` where the real route is `/sessions/`.
 *
 * Rewriting here rather than in the browser keeps one copy of the rule and means
 * every consumer of /api/community — including anything added later — gets a
 * link that actually opens. The proper fix belongs in the dev endpoint; this
 * stays correct either way, because a URL that is already right is left alone.
 */
/**
 * Recent blog posts from the public site.
 *
 * Cached for fifteen minutes: the Community pane refreshes on a two-minute
 * timer, and hitting someone else's server 30 times an hour to re-read nine
 * weekly articles would be rude and pointless.
 *
 * Every failure returns an empty list. This is decoration on a pane that already
 * copes with having nothing — there is no version of "the blog is down" that
 * should cost the user anything.
 */
let blogCache = { at: 0, items: [] };

async function blogArticles() {
  if (Date.now() - blogCache.at < 15 * 60_000) return blogCache.items;
  try {
    const r = await fetch(config.community.blogUrl, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(String(r.status));
    const body = await r.json();
    const raw = body?.json?.articles ?? body?.articles ?? [];
    const items = raw
      .filter((a) => !a.status || a.status === "approved")
      .slice(0, 6)
      .map((a) => ({
        title: String(a.title || "").slice(0, 200),
        excerpt: String(a.excerpt || "").slice(0, 300),
        slug: String(a.slug || ""),
        image: a.featuredImageUrl || a.featured_image_url || null,
        category: a.category || null,
        at: a.publishedAt || a.published_at || null,
        /* ⚠ `likeCount` arrives as a string from production — "0", not 0.
         * The client tested it for truthiness and compared it to a number, so
         * every article with no likes rendered "· 0 likes" and a single like
         * would have read "1 likes". Coerced once, here, rather than in each
         * place that displays it. */
        likes: Number.isFinite(Number(a.likeCount)) ? Number(a.likeCount) : null,
      }))
      .filter((a) => a.slug);
    blogCache = { at: Date.now(), items };
  } catch {
    // Keep whatever we had rather than blanking the section on one bad fetch.
    blogCache = { at: Date.now() - 14 * 60_000, items: blogCache.items };
  }
  return blogCache.items;
}

function normaliseFeed(feed) {
  if (!feed || typeof feed !== "object") return feed;
  const origin = config.community.site;
  /* ⚠ ONLY rewrite links that are already AIPLAY's.
   *
   * The first version of this forced the host on every URL it was handed, which
   * was right for session links and catastrophic for the radio: all five
   * stations are YouTube watch URLs, and they came out as
   * https://dev.aiplay.live/watch?v=... — five dead links, caused entirely by
   * the fix for a different bug. Anything pointing elsewhere is somebody else's
   * link and must be passed through untouched. */
  const ours = new Set(["aiplay.live", "dev.aiplay.live", "www.aiplay.live", new URL(origin).host]);
  const fix = (u) => {
    if (!u || typeof u !== "string") return u;
    try {
      // Relative URLs are ours by definition; absolute ones have to prove it.
      const isRelative = !/^[a-z][a-z0-9+.-]*:/i.test(u) && !u.startsWith("//");
      const parsed = new URL(u, origin);
      if (!isRelative && !ours.has(parsed.host)) return u;
      // Follow whichever environment the feed itself points at.
      parsed.protocol = "https:";
      parsed.host = new URL(origin).host;
      parsed.pathname = parsed.pathname.replace(/^\/session\//, "/sessions/");
      return parsed.toString();
    } catch {
      return u;
    }
  };
  const mapUrls = (arr) => Array.isArray(arr) ? arr.map((x) => ({ ...x, url: fix(x?.url) })) : arr;
  return {
    ...feed,
    sessions: mapUrls(feed.sessions),
    parties: mapUrls(feed.parties),
    // `stations` is deliberately NOT mapped — see above. Kept in the list as a
    // comment so nobody adds it back thinking it was an oversight.
    stations: feed.stations,
  };
}

// Peaks are deterministic per file, so compute once and keep the last few.
const peakCache = new Map();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".flac": "audio/flac",
  ".mp3": "audio/mpeg",
  ".opus": "audio/ogg",
  ".json": "application/json; charset=utf-8",
};

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(s) });
  res.end(s);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  try {
    // ---- API ------------------------------------------------------------
    if (p === "/api/status") {
      return json(res, 200, {
        engine: {
          ready: comfy.ready,
          backend: comfy.assertBackend(),
          torch: comfy.backend.torch,
          device: comfy.backend.device,
        },
        config: {
          steps: config.sampling.steps,
          shift: config.sampling.shift,
          cfg: config.sampling.cfg,
          realtimeRatio: config.speed.realtimeRatio,
          // The UI had no way to learn these, so its "open the site" buttons
          // fell back to a hardcoded production URL while the feed served dev
          // ids. Both now come from one place.
          site: config.community.site,
          // Shown in Settings so the folder fields start filled in rather than
          // empty, which would read as "unset" when they are anything but.
          paths: { outputDir: config.outputDir, rig: config.rig },
          siteSessions: config.community.sessions,
          output: config.output,
          stems: config.stems,
          lyrics: { when: config.lyrics.when, model: config.lyrics.model },
          video: {
            enabled: config.video.enabled, when: config.video.when,
            engine: config.video.engine,
            /* Weights on disk, which is a different question from the Settings
             * toggle. The UI greys the Overnight video stage on THIS, not on
             * `enabled` — a machine holding every model should not be told the
             * stage is unavailable because a switch it never saw is off. */
            ...(() => { const r = videoReady(); return { ready: r.ready, missing: r.missing }; })(),
            /* Each engine's OWN sizes, frame rule and cost curve. The UI cannot
             * share one list: H3's native 1344x768 is not a legal LTX size, and
             * LTX quantises to a 32px latent grid after halving, so two of H3's
             * four options would silently render at a different size. */
            engines: Object.fromEntries(Object.entries(config.video.engines).map(([k, e]) => [k, {
              label: e.label, sizes: e.sizes, seconds: e.seconds, fps: e.fps,
              width: e.width, height: e.height, steps: e.steps ?? null,
              frameRule: e.frameRule,
              costFixedSeconds: e.costFixedSeconds, costRate: e.costRate, costExponent: e.costExponent,
            }])),
            seconds: videoEngine().seconds,
            width: videoEngine().width, height: videoEngine().height },
          tier: comfy.tier || "auto",
          tiers: Object.entries(config.vramTiers).map(([k, v]) => ({ id: k, label: v.label, note: v.note })),
        },
        gpu: gpuStatus(),
        ram: ramStatus(),
        ...art.status(),
        ...jobs.snapshot(),
        // Disk is the source of truth, so the library survives restarts and shows
        // anything already in the output folder.
        library: await library.list(),
        playlists: library.playlists,
        ...batch.status(),
      });
    }

    // Overnight batches. The plan lives on the server and on disk, so closing the
    // browser -- or losing it to a crash -- does not touch a run in progress.
    if (p === "/api/batch" && req.method === "POST") {
      const b = await readBody(req);
      try {
        if (b.action === "start") return json(res, 200, batch.start(b));
        if (b.action === "pause") return json(res, 200, batch.pause());
        if (b.action === "resume") return json(res, 200, batch.resume());
        if (b.action === "stop") return json(res, 200, batch.stop());
        if (b.action === "clear") return json(res, 200, batch.clear());
        return json(res, 400, { error: "Unknown action." });
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) });
      }
    }

    /**
     * The model catalogue.
     *
     * This is what makes the optional features shippable rather than "works on
     * the machine where someone already filled the cache". It reports every
     * capability, exactly which files are missing, their real sizes and their
     * licences — and downloads only what is asked for.
     */
    if (p === "/api/models" && req.method !== "POST") {
      const [cat, pkgs, disk] = await Promise.all([models.status(), pythonPackages(), diskFree()]);
      return json(res, 200, {
        disk,
        capabilities: cat.map((c) => ({
          ...c,
          // A capability can have every weight on disk and still not run if its
          // python package is absent. Saying so is the difference between a
          // useful message and a mystery.
          packageReady: c.needsPackage ? !!pkgs[c.needsPackage] : true,
        })),
        python: { path: SYSTEM_PYTHON, packages: pkgs },
      });
    }

    if (p === "/api/models" && req.method === "POST") {
      const b = await readBody(req);
      try {
        if (b.action === "download") {
          /* The region gate is checked HERE, not inside the promise below. That
           * promise is deliberately not awaited and its rejection is swallowed,
           * so a refusal thrown inside it would reach nobody and the UI would
           * show a download that silently never starts. */
          const cap = CATALOG.find((c) => c.id === String(b.id));
          if (cap?.region && !b.acceptRegion) {
            return json(res, 400, {
              error: `${cap.label} is licensed only outside ${cap.region.excluded.join(", ")}.`,
              needsRegionAck: true,
              region: cap.region,
            });
          }
          // Deliberately not awaited: these are multi-gigabyte fetches and the
          // UI follows them over the websocket.
          models.download(String(b.id), { acceptRegion: !!b.acceptRegion }).catch(() => {});
          return json(res, 200, { ok: true, started: b.id });
        }
        if (b.action === "cancel") {
          models.cancel(String(b.id));
          return json(res, 200, { ok: true });
        }
        return json(res, 400, { error: "Unknown action." });
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) });
      }
    }

    /**
     * Output format. Applies to the NEXT render — the graph is built per job, so
     * nothing already queued changes format underneath the user, and no engine
     * restart is needed.
     */
    if (p === "/api/format" && req.method === "POST") {
      const b = await readBody(req);
      const fmt = String(b.format || "").toLowerCase();
      if (!["flac", "mp3", "opus"].includes(fmt)) {
        return json(res, 400, { error: "Format must be flac, mp3 or opus." });
      }
      config.output.format = fmt;
      if (b.mp3Quality && ["V0", "128k", "320k"].includes(b.mp3Quality)) {
        config.output.mp3Quality = b.mp3Quality;
      }
      if (b.opusQuality && ["64k", "96k", "128k", "192k", "320k"].includes(b.opusQuality)) {
        config.output.opusQuality = b.opusQuality;
      }
      savePrefs();
      return json(res, 200, { ok: true, output: config.output });
    }

    // Graphics-memory tier. Restarts the engine, because ComfyUI reads these flags
    // at process start — and that clears the AR cache, so the UI warns first.
    /* Audio-reactive video, on a SECOND ComfyUI.
     *
     * The packs this needs are GPL-3.0 and cannot ship inside an Apache-2.0
     * app, so they live in an engine the user sets up themselves and Studio
     * talks to it over HTTP -- the same arms-length boundary that already
     * applies to ComfyUI. With nothing on the other end the page says so and
     * offers the setup, rather than presenting controls that fail on click. */
    /* Convert a finished track. Goes through ComfyUI, which already encodes
     * these formats, rather than shelling out to ffmpeg -- see exportAudio.js
     * for why WAV is not among them. */
    if (p === "/api/export" && req.method === "POST") {
      const b = await readBody(req);
      try {
        const out = await convertAudio(comfy, b);
        return json(res, 200, out);
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) });
      }
    }
    if (p === "/api/export/formats") {
      return json(res, 200, Object.fromEntries(
        Object.entries(AUDIO_FORMATS).map(([k, v]) => [k, { qualities: v.qualities, lossy: v.lossy }])));
    }

    if (p === "/api/reactive/status") {
      return json(res, 200, await reactive.status());
    }
    if (p === "/api/reactive/run" && req.method === "POST") {
      const b = await readBody(req);
      try {
        const st = await reactive.status();
        if (!st.ok) return json(res, 503, { error: "the reactive engine is not ready", status: st });
        const graph = reactive.buildGraph(b.mode || "images", b);
        const out = await reactive.run(graph);
        return json(res, 200, out);
      } catch (err) {
        return json(res, 500, { error: String(err.message || err) });
      }
    }

    if (p === "/api/tier" && req.method === "POST") {
      const b = await readBody(req);
      try {
        const r = await comfy.setTier(b.tier);
        config.tier = b.tier;
        savePrefs();
        jobs.emit("update", jobs.snapshot());
        return json(res, 200, { ok: true, tier: b.tier, backend: r });
      } catch (err) {
        return json(res, 500, { error: String(err.message || err) });
      }
    }

    // Star, pin, thumb, trash. Trash MOVES the file to output/trash rather than
    // deleting it — a bad click must not cost a 30 MB render.
    if (p === "/api/track" && req.method === "POST") {
      const b = await readBody(req);
      const file = String(b.file || "");
      if (!file || file.includes("..") || file.includes("/") || file.includes("\\")) {
        return json(res, 400, { error: "bad file" });
      }
      try {
        if (b.action === "flag") {
          library.setFlag(file, b.flag, b.value);
          maybePost(file, b.flag, b.value);
        }
        else if (b.action === "rename") {
          // Title is sidecar metadata, not the filename — renaming the file would
          // break the cover, stems and LRC that are all keyed to its stem.
          const title = String(b.title ?? "").trim().slice(0, 120);
          library.remember(file, { title: title || undefined });
          if (!title) {
            // Clearing it hands the name back to the library's own derivation.
            const m = library.meta.get(file);
            if (m) { delete m.title; library.dirty = true; library.save(); }
          }
        }
        /**
         * Edit everything a song carries ABOUT itself.
         *
         * ⚠ None of this re-renders audio. Style and lyrics are what PRODUCED
         * the track; changing them here corrects the record, it does not change
         * the recording. The dialog says so, because a field that looks like an
         * input invites the assumption that editing it does something.
         *
         * `notes` is separate from `caption` on purpose: caption is the prompt
         * the model was given, notes are what the human wants to remember.
         * Collapsing them would destroy the provenance the file is stamped with.
         */
        else if (b.action === "details") {
          const patch = {};
          if (b.title !== undefined) patch.title = String(b.title).trim().slice(0, 120) || undefined;
          if (b.notes !== undefined) patch.notes = String(b.notes).trim().slice(0, 2000);
          if (b.caption !== undefined) patch.caption = String(b.caption).trim().slice(0, 4000);
          if (b.lyrics !== undefined) patch.lyrics = String(b.lyrics).slice(0, 20000);
          library.remember(file, patch);
          if (b.title !== undefined && !patch.title) {
            const m = library.meta.get(file);
            if (m) { delete m.title; library.dirty = true; library.save(); }
          }
        }
        else if (b.action === "trash") await library.trash(file);
        else if (b.action === "restore") await library.restore(file);
        else return json(res, 400, { error: "Unknown action." });
        return json(res, 200, { ok: true, library: await library.list(), trash: await library.listTrash() });
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) });
      }
    }

    // Recover lyrics and style for a track whose sidecar predates them. They
    // were written into the FLAC at generation time, so the file still knows
    // even when our JSON does not. Lazy — reading tags costs a subprocess, so it
    // happens when a panel opens, not on every library listing.
    if (p === "/api/trackmeta") {
      const file = url.searchParams.get("file") || "";
      if (!file || file.includes("..") || file.includes("/") || file.includes("\\")) {
        return json(res, 400, { error: "bad file" });
      }
      const found = await library.readTags(file);
      if (found?.lyrics || found?.caption) {
        library.remember(file, {
          lyrics: found.lyrics || undefined,
          caption: found.caption || undefined,
        });
      }
      return json(res, 200, found || {});
    }

    if (p === "/api/playlist" && req.method === "POST") {
      const b = await readBody(req);
      if (b.action === "create") library.createPlaylist(b.name);
      else if (b.action === "toggle") library.togglePlaylistFile(b.id, b.file);
      else if (b.action === "delete") library.deletePlaylist(b.id);
      return json(res, 200, { playlists: library.playlists });
    }

    if (p === "/api/generate" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.caption?.trim()) return json(res, 400, { error: "Add a style description." });
      const job = jobs.enqueue({
        /* Derived here rather than in the browser, so an overnight run, an API
         * caller and the Create form all get the same treatment. The client's
         * own first-lyric-line guess still arrives as `body.title`; this only
         * fires when nothing at all was supplied. */
        title: body.title?.trim()
          || deriveTitle({ lyrics: body.lyrics, caption: body.caption }),
        caption: body.caption.trim(),
        lyrics: (body.lyrics || "").trim(),
        // The performance. Holding this steady is what lets the AR stage be reused.
        seed: Number.isFinite(body.seed) ? body.seed : Math.floor(Math.random() * 4294967296),
        // The mix. A re-roll keeps `seed` and changes only this, so ComfyUI reuses
        // the cached conditioning and the render costs ~60% of a full one.
        mixSeed: Number.isFinite(body.mixSeed) ? body.mixSeed : undefined,
        maxDuration: Math.min(Math.max(Number(body.maxDuration) || 240, 30), 300),
        // Both map to real model parameters. No cosmetic dials — the
        // ComfyUI-literate half of the audience will check.
        steps: body.steps ? Math.min(Math.max(Number(body.steps), 6), 40) : undefined,
        cfg: body.cfg ? Math.min(Math.max(Number(body.cfg), 1), 5) : undefined,
        // Separated so the two guidance scales can be swept independently; the
        // UI still sends one `cfg` and both follow it.
        arCfg: body.arCfg ? Math.min(Math.max(Number(body.arCfg), 0), 5) : undefined,
        flowCfg: body.flowCfg ? Math.min(Math.max(Number(body.flowCfg), 0), 5) : undefined,
        model: ["fp16", "fp32"].includes(body.model) ? body.model : "int8",
        instrumental: !!body.instrumental,
        preview: !!body.preview,
        reusesConditioning: !!body.reusesConditioning,
        /* Audio reference. A .latent basename produced by /api/audioref, and how
         * much of the schedule still runs — LOW keeps more of the reference.
         * Validated here rather than trusted: the name goes into a ComfyUI graph
         * and must not be able to point outside the input directory. */
        audioRef: typeof body.audioRef === "string"
          && /^[\w.-]+\.latent$/.test(body.audioRef) ? body.audioRef : undefined,
        audioRefDenoise: Number.isFinite(body.audioRefDenoise)
          ? Math.min(Math.max(Number(body.audioRefDenoise), 0.05), 1)
          : config.audioRef.denoise,
      });
      return json(res, 200, { job: jobs.snapshot().current ?? job });
    }

    /**
     * Extend an existing take.
     *
     * No audio is read. The AR stage replays the saved token trajectory to
     * rebuild its state, then keeps sampling — so this works on tracks WE
     * generated and needs none of the blocked audio-encoder machinery.
     *
     * Only the new section is rendered. The original file is never touched, so
     * a bad extension costs nothing.
     */
    if (p === "/api/extend" && req.method === "POST") {
      const b = await readBody(req);
      const file = String(b.file || "");
      if (!file || file.includes("..") || file.includes("/") || file.includes("\\")) {
        return json(res, 400, { error: "bad file" });
      }
      const meta = library.meta.get(file);
      if (!meta?.codes) {
        return json(res, 400, {
          error: "This take has no saved trajectory, so it cannot be extended. "
               + "Only tracks generated after the capture update can be.",
        });
      }
      // Resume from a POINT, not from the end. Replaying a whole trajectory
      // leaves the model exactly where it chose to stop, so the next token is
      // end-of-audio and nothing is generated. Default to 80% through, which
      // keeps the song recognisable while leaving it mid-phrase.
      const fps = 25;
      const dur = meta.durationSeconds || 0;
      const fromSec = Number.isFinite(b.fromSeconds)
        ? Math.max(1, Math.min(b.fromSeconds, Math.max(1, dur - 1)))
        : Math.max(1, dur * 0.8);
      const resumeFrames = Math.max(1, Math.round(fromSec * fps));

      // The model also has to be given somewhere to go. The original lyrics
      // describe a song it already finished; without extra sections it will
      // simply stop again.
      const baseLyrics = b.lyrics ?? meta.lyrics ?? "";
      const extraSections = b.lyrics
        ? ""
        : "\n[Instrumental - continue and develop]\n[Outro - resolve]";

      const job = jobs.enqueue({
        title: `${meta.title || file} · extended`,
        caption: b.caption?.trim() || meta.caption || "",
        // Same words plus somewhere to go. Wholly new lyrics mean re-prefilling
        // different text under the old audio history, which is off-distribution
        // — allowed, but the caller's decision, not a default.
        lyrics: baseLyrics + extraSections,
        seed: Number.isFinite(b.seed) ? b.seed : Math.floor(Math.random() * 4294967296),
        arCfg: meta.arCfg, flowCfg: meta.flowCfg, steps: meta.steps,
        model: meta.model === "fp16" ? "fp16" : "int8",
        instrumental: !!meta.instrumental,
        maxDuration: Math.min(Math.max(Number(b.seconds) || 30, 5), 180),
        resumeFrom: `${meta.codes}#${resumeFrames}`,
        extendedFrom: file,
        resumeFrames,
      });
      return json(res, 200, {
        job: jobs.snapshot().current ?? job,
        resumedFromSeconds: Math.round(fromSec),
      });
    }

    /**
     * Merge a take and its continuations into ONE song.
     *
     * Extending does not build a chain — it builds a TREE. Every extension is
     * joined onto its parent immediately, so each `extend_*` file is already a
     * complete song (parent + that continuation), and extending the same take
     * three times gives three complete alternatives that all share an opening.
     *
     * So merging cannot simply concatenate the files: that would play the shared
     * parent three times. Instead the first branch is taken whole and every later
     * branch contributes only the audio past its own resume point — each piece of
     * music appears exactly once, in the order the user chose.
     *
     * Sources are never touched. A merge that sounds wrong costs a file.
     */
    if (p === "/api/merge" && req.method === "POST") {
      const b = await readBody(req);
      const files = Array.isArray(b.files) ? b.files.filter(Boolean) : [];
      if (files.length < 2) return json(res, 400, { error: "Pick at least two takes to merge." });
      for (const f of files) {
        if (f.includes("..") || f.includes("/") || f.includes("\\")) {
          return json(res, 400, { error: "bad file" });
        }
      }

      // Where each branch's own material begins. Anything made before joinedAt
      // was recorded falls back to the 80% default that /api/extend uses, which
      // is the same figure those files were actually built with.
      const startOf = (f) => {
        const m = library.meta.get(f) || {};
        if (Number.isFinite(m.joinedAt)) return m.joinedAt;
        const parent = m.extendedFrom ? library.meta.get(m.extendedFrom) : null;
        if (parent?.durationSeconds) return parent.durationSeconds * 0.8;
        return 0;
      };

      const [first, ...rest] = files;
      const ops = rest.map((f) => ({
        op: "join",
        with: path.join(config.outputDir, f),
        at: 1e9,               // clamped to the running length: append at the end
        from: startOf(f),      // skip the parent this branch carries with it
        fade: 0.12,
      }));

      const out = `merge_${Date.now()}.flac`;
      const r = await new Promise((resolve) => {
        const proc = spawn(config.python, [
          path.join(__dirname, "edit_audio.py"),
          path.join(config.outputDir, first), path.join(config.outputDir, out),
          JSON.stringify(ops),
        ]);
        let so = "", se = "";
        proc.stdout.on("data", (d) => (so += d));
        proc.stderr.on("data", (d) => (se += d));
        proc.on("exit", (code) => resolve({ code, so, se }));
        proc.on("error", () => resolve({ code: 1, so: "", se: "spawn failed" }));
      });
      if (r.code !== 0) {
        return json(res, 500, { error: r.se.split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300) });
      }
      const info = JSON.parse(r.so || "{}");
      const base = library.meta.get(first) || {};
      library.remember(out, {
        title: `${base.title || "Merged"} · merged`,
        seed: base.seed ?? 0, caption: base.caption, lyrics: base.lyrics,
        model: base.model, durationSeconds: Math.round(info.seconds || 0),
        mergedFrom: files, createdAt: Date.now(),
      });
      // Give it a cover like anything else, rather than leaving one track in the
      // library conspicuously without art.
      art.request({ file: out, title: `${base.title || "Merged"} · merged`, caption: base.caption, seed: base.seed });
      return json(res, 200, { file: out, ...info, merged: files.length });
    }

    if (p === "/api/cancel" && req.method === "POST") {
      await jobs.cancel();
      return json(res, 200, jobs.snapshot());
    }

    // Community feed. Proxied so the UI never talks to aiplay directly (CORS, and
    // it keeps the endpoint swappable). Returns an empty feed rather than an error
    // when the endpoint does not exist yet — the pane hides itself when empty,
    // because "0 sessions live" advertises exactly the wrong thing.
    if (p === "/api/community") {
      // Both sources are fetched together and NEITHER can fail the response. The
      // feed is often absent (not built on prod yet) and the blog is a nicety;
      // one being down must not blank a pane that the other could fill.
      const [feed, articles] = await Promise.all([
        (async () => {
          try {
            const r = await fetch(config.community.feedUrl, { signal: AbortSignal.timeout(4000) });
            if (r.ok) {
              // AIPLAY serialises every endpoint with superjson, so the payload
              // arrives as { json: {...} }. Unwrap so the UI sees the plain shape.
              const body = await r.json();
              return normaliseFeed(body?.json ?? body);
            }
          } catch { /* offline, or not built yet */ }
          return { sessions: [], parties: [], stations: [], offline: true };
        })(),
        blogArticles(),
      ]);
      return json(res, 200, { ...feed, articles });
    }

    // Post-generation edits — pure DSP on the finished file. The model cannot take
    // audio in (decoder-only VAE), so this is the whole of what "editing" can mean
    // here: trim, cut a section, fade, reverse, speed.
    if (p === "/api/edit" && req.method === "POST") {
      const body = await readBody(req);
      const name = String(body.file || "");
      if (!name || name.includes("..") || path.isAbsolute(name)) return json(res, 400, { error: "bad file" });
      const src = path.join(config.outputDir, name);
      const out = path.join(config.outputDir, `edit_${Date.now()}.flac`);
      const r = await new Promise((resolve) => {
        const proc = spawn(config.python, [
          path.join(__dirname, "edit_audio.py"), src, out, JSON.stringify(body.ops || []),
        ]);
        let so = "", se = "";
        proc.stdout.on("data", (d) => (so += d));
        proc.stderr.on("data", (d) => (se += d));
        proc.on("exit", (code) => resolve({ code, so, se }));
      });
      if (r.code !== 0) return json(res, 500, { error: r.se.split("\n").slice(-3).join(" ").slice(0, 300) });
      const info = JSON.parse(r.so || "{}");
      const src0 = library.meta.get(name) || {};
      library.remember(path.basename(out), {
        title: `${src0.title || "Edit"} (edit)`, seed: src0.seed ?? 0,
        durationSeconds: Math.round(info.seconds || 0), createdAt: Date.now(),
      });
      return json(res, 200, { file: path.basename(out), ...info });
    }

    /**
     * Cover art control.
     *
     * `backfill` is the one that matters: it queues every track without a cover
     * and lets the idle-drain runner work through them whenever the GPU is free.
     * On a library of fifty that is one model load and roughly three seconds a
     * picture, which is why it is offered as a single button rather than a
     * per-track action.
     */
    if (p === "/api/art" && req.method === "POST") {
      const b = await readBody(req);
      try {
        if (b.action === "backfill") {
          const n = await art.backfill(await library.list());
          return json(res, 200, { ok: true, queued: n, ...art.status() });
        }
        if (b.action === "regenerate") {
          const file = String(b.file || "");
          if (!file || file.includes("..") || file.includes("/") || file.includes("\\")) {
            return json(res, 400, { error: "bad file" });
          }
          const m = library.meta.get(file) || {};
          // A fresh seed, or "regenerate" would redraw the identical picture.
          art.request({
            file, title: m.title, caption: m.caption,
            seed: Math.floor(Math.random() * 4294967296), force: true,
          });
          return json(res, 200, { ok: true, ...art.status() });
        }
        if (b.action === "enable") {
          art.enabled = !!b.value;
          config.art.enabled = art.enabled;
          savePrefs();
          return json(res, 200, { ok: true, ...art.status() });
        }
        /**
         * Replace a cover with the user's own image, or remove it.
         *
         * The upload arrives as a data URL rather than multipart, because the
         * whole app is a single local page talking to a local server and a
         * multipart parser would be a dependency bought for nothing.
         *
         * Both the full image and the 256px thumbnail are written from the same
         * source: the library list reads thumbnails, so writing only the full
         * one leaves every row still showing the OLD picture.
         */
        if (b.action === "upload" || b.action === "remove") {
          const file = String(b.file || "");
          if (!file || file.includes("..") || file.includes("/") || file.includes("\\")) {
            return json(res, 400, { error: "bad file" });
          }
          const stem = file.replace(/\.(flac|mp3|opus|wav)$/i, "");
          const full = path.join(COVER_DIR, `${stem}.png`);
          const thumb = path.join(COVER_DIR, `${stem}_t.png`);
          if (b.action === "remove") {
            await Promise.all([full, thumb].map((f) => unlink(f).catch(() => {})));
            library.remember(file, { cover: null, covers: null, thumb: null });
            return json(res, 200, { ok: true, library: await library.list() });
          }
          const m = /^data:image\/(png|jpeg|webp);base64,([\s\S]+)$/.exec(String(b.data || ""));
          if (!m) return json(res, 400, { error: "Expected a PNG, JPEG or WebP image." });
          const buf = Buffer.from(m[2], "base64");
          if (buf.length > 25 * 1024 * 1024) return json(res, 400, { error: "Image is over 25 MB." });
          await mkdir(COVER_DIR, { recursive: true });
          await writeFile(full, buf);
          // Delete the OLD thumbnail before regenerating: make_thumbs.py skips
          // anything that already has one, so replacing a cover would otherwise
          // leave every library row still showing the previous picture.
          await unlink(thumb).catch(() => {});
          // Derive the thumbnail with the same script used for the backlog, so
          // there is one implementation of "make a 256px copy".
          await new Promise((resolve) => {
            const proc = spawn(config.python, [
              path.join(__dirname, "..", "scripts", "make_thumbs.py"), COVER_DIR,
            ], { windowsHide: true });
            proc.on("exit", resolve);
            proc.on("error", resolve);
          });
          library.remember(file, { cover: `${stem}.png`, covers: [`${stem}.png`], thumb: `${stem}_t.png` });
          // A hand-picked cover deserves to travel inside the file just as much
          // as a generated one — otherwise uploading art is the one path that
          // silently leaves the audio blank in every other player.
          embedCover(file, `${stem}.png`).catch(() => {});
          return json(res, 200, { ok: true, library: await library.list() });
        }
        /**
         * Backfill: put existing covers inside the files that already have them.
         *
         * Everything made before embedding existed has a loose PNG and a blank
         * file. Runs sequentially and re-tags nothing that is already done,
         * because each pass rewrites a whole FLAC.
         */
        if (b.action === "embed") {
          const rows = await library.list();
          const todo = rows.filter((t) => t.cover && !t.coverEmbedded
            && !/\.mp3$/i.test(t.file));
          res.writeHead(200, { "Content-Type": "application/json" });
          let done = 0, failed = 0;
          for (const t of todo) {
            try { (await embedCover(t.file, t.cover))?.cover ? done++ : failed++; }
            catch { failed++; }
          }
          return res.end(JSON.stringify({
            ok: true, done, failed,
            skippedMp3: rows.filter((t) => t.cover && /\.mp3$/i.test(t.file)).length,
            library: await library.list(),
          }));
        }
        if (b.action === "pause") {
          art.paused = !!b.value;
          return json(res, 200, { ok: true, ...art.status() });
        }
        return json(res, 400, { error: "Unknown action." });
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) });
      }
    }

    /**
     * Stem separation — the setting and the manual trigger.
     *
     * Separation runs on the SAME idle-drain queue as cover art, so it can never
     * delay music: both wait for the generation queue to empty.
     */
    if (p === "/api/stems" && req.method === "POST") {
      const b = await readBody(req);
      if (b.action === "when") {
        if (!["off", "all", "starred", "liked"].includes(b.value)) {
          return json(res, 400, { error: "Must be off, all, starred or liked." });
        }
        config.stems.when = b.value;
        savePrefs();
        return json(res, 200, { ok: true, stems: config.stems });
      }
      if (b.action === "run") {
        const file = String(b.file || "");
        if (!file || file.includes("..") || file.includes("/") || file.includes("\\")) {
          return json(res, 400, { error: "bad file" });
        }
        const m = library.meta.get(file) || {};
        art.request({ file, title: m.title, kind: "stems", force: true });
        return json(res, 200, { ok: true, ...art.status() });
      }
      return json(res, 400, { error: "Unknown action." });
    }

    /** Video clips — enable flag and manual trigger. */
    if (p === "/api/video" && req.method === "POST") {
      const b = await readBody(req);
      if (b.action === "enable") {
        config.video.enabled = !!b.value;
        // Switching the model off must not leave `when` pointing at a mode that
        // silently does nothing, and switching it on must not immediately start
        // rendering 30 s clips for every song. Off means off, both ways.
        if (!config.video.enabled) config.video.when = "off";
        savePrefs();
        return json(res, 200, { ok: true, video: { enabled: config.video.enabled, when: config.video.when } });
      }
      /**
       * Make a clip on its own terms — the Video screen.
       *
       * Distinct from `run`, which derives everything from a finished song.
       * Here the caller owns the prompt, the size, the length and optionally the
       * opening frame, and the result is not attached to any track unless they
       * say so.
       */
      if (b.action === "create") {
        if (!config.video.enabled) return json(res, 400, { error: "Video is switched off in Settings." });
        const cap = (await models.status()).find((c) => c.id === (config.video.engine === "ltx" ? "videoLtx" : "video"));
        if (cap && !cap.ready) {
          return json(res, 400, {
            error: `${videoEngine().label} is not downloaded yet (${((cap.totalBytes - cap.haveBytes) / 1e9).toFixed(1)} GB missing). Open the Models screen.`,
          });
        }
        const prompt = String(b.prompt || "").trim();
        if (!prompt) return json(res, 400, { error: "Describe the clip first." });

        /* Opening and closing frames have to be readable by LoadImage, which only
         * looks in ComfyUI's input directory — so a cover living in output/covers
         * has to be copied there first. Copied, not moved: the library still
         * needs it. The name is content-addressed, so picking the same cover
         * twice reuses one file instead of filling the input directory. */
        const stageFrame = async (cover) => {
          if (!cover) return undefined;
          /* Covers OR standalone images.
           *
           * ⚠ This looked in the cover folder alone, so nothing made on the
           * Images screen could ever be used as an opening frame — which is
           * most of the reason that screen exists. The two live in different
           * folders because a cover belongs to a song and an image belongs to
           * nobody; that is a storage decision and was never meant to become a
           * capability boundary. Covers are tried first, so a name that somehow
           * exists in both keeps the meaning it always had. */
          const base = path.basename(String(cover));
          let src = path.join(COVER_DIR, base);
          try {
            await stat(src);
          } catch {
            src = path.join(IMAGE_DIR, base);
          }
          await stat(src);
          const name = `aiplay_frame_${createHash("sha1").update(src).digest("hex").slice(0, 10)}${path.extname(src)}`;
          await mkdir(config.inputDir, { recursive: true });
          await writeFile(path.join(config.inputDir, name), await readFile(src));
          return name;
        };
        /* An uploaded frame is ALREADY in the input directory — /api/frame put it
         * there and named it. So it bypasses stageFrame, which exists only to
         * copy covers out of the output folder. It is still validated: only a
         * name this server itself minted is accepted, so the render route cannot
         * be talked into loading an arbitrary path. */
        const staged = (v) => {
          if (!v) return undefined;
          const nm = path.basename(String(v));
          return /^aiplay_frame_[0-9a-f]{12}\.(png|jpg|webp)$/.test(nm) ? nm : undefined;
        };

        let firstFrame, lastFrame, midFrames = [], refImages = [], refAudios = [], audioTrack;
        try {
          firstFrame = staged(b.fromUpload) || await stageFrame(b.fromCover);
          // A closing frame is a separate choice from the loop tick. `loop`
          // means "end where you started" and the graph derives it from the
          // opening frame, so an explicit closing frame is only read when the
          // clip is NOT a loop — otherwise the two would contradict each other.
          if (!b.loop) lastFrame = staged(b.toUpload) || await stageFrame(b.toCover);
          /* Waypoints. Staged the same way as the two ends, and capped at four:
           * a guide every few frames leaves the sampler no room to move and the
           * clip degrades into a crossfade of stills. One bad name here should
           * drop that picture, not fail the whole clip. */
          const wanted = Array.isArray(b.midUploads) ? b.midUploads.slice(0, 4) : [];
          midFrames = (await Promise.all(wanted.map(async (v) => {
            try { return staged(v) || await stageFrame(v); } catch { return undefined; }
          }))).filter(Boolean);
          /* REFERENCES — H3's ref2va path. Pictures the prompt can call
           * <Picture 1>…, audio it can call <Audio 1>…. Staged like the frames;
           * a bad name drops that reference rather than failing the clip. */
          const wantedRefs = Array.isArray(b.refImages) ? b.refImages.slice(0, 9) : [];
          refImages = (await Promise.all(wantedRefs.map(async (v) => {
            try { return staged(v) || await stageFrame(v); } catch { return undefined; }
          }))).filter(Boolean);
          /* Ref audio: an upload this server named, or a song straight out of
           * the library. A library file is copied into ComfyUI's input dir the
           * same way a cover is — content of the graph, not a path, so the
           * render route still cannot be talked into reading anywhere else. */
          const stagedAud = (v) => {
            if (!v) return undefined;
            const nm = path.basename(String(v));
            return /^aiplay_refaud_[0-9a-f]{12}\.(wav|mp3|flac|ogg|m4a)$/.test(nm) ? nm : undefined;
          };
          const stageSong = async (name) => {
            const base = path.basename(String(name));
            if (!/^[\w. -]+\.(flac|mp3|wav|ogg|m4a)$/i.test(base)) return undefined;
            const src = path.join(config.outputDir, base);
            await stat(src);
            const nm = `aiplay_refaud_${createHash("sha1").update(src).digest("hex").slice(0, 12)}${path.extname(base).toLowerCase()}`;
            await mkdir(config.inputDir, { recursive: true });
            await writeFile(path.join(config.inputDir, nm), await readFile(src));
            return nm;
          };
          const wantedAuds = Array.isArray(b.refAudios) ? b.refAudios.slice(0, 3) : [];
          refAudios = (await Promise.all(wantedAuds.map(async (a) => {
            if (!a) return undefined;
            const start = Math.min(Math.max(Number(a.start) || 0, 0), 7200);
            try {
              const name = stagedAud(a.name) || await stageSong(a.name);
              return name ? { name, start } : undefined;
            } catch { return undefined; }
          }))).filter(Boolean);
          /* SOUNDTRACK (LTX) — one audio the clip is generated ON: its latent
           * is frozen during sampling and the output's sound IS this segment.
           * Staged exactly like a reference audio. */
          if (b.audioTrack && b.audioTrack.name) {
            const start = Math.min(Math.max(Number(b.audioTrack.start) || 0, 0), 7200);
            try {
              const name = stagedAud(b.audioTrack.name) || await stageSong(b.audioTrack.name);
              if (name) audioTrack = { name, start };
            } catch { /* a missing soundtrack drops silently like a bad ref */ }
          }
        } catch {
          return json(res, 400, { error: "That cover image is not on disk." });
        }
        /* References are an H3 capability — the ref2va conditioning path does
         * not exist in the LTX graph. Refusing beats silently rendering
         * without them, which would look like the model ignoring the user. */
        /* References stay H3-only, but the reason is now the MODEL, not this
         * route: every LTX node that takes an image pins it to a frame index —
         * there is no non-frame-pinned reference input anywhere in the LTX
         * family, and the one IC-LoRA that adds it is 2.3-only and gated. The
         * message points at the real substitute rather than just saying no. */
        if ((refImages.length || refAudios.length) && config.video.engine !== "h3") {
          return json(res, 400, {
            error: "References need MiniMax H3 — LTX has no reference input (a model limit, not a setting). On LTX: compose the identity still first (Images can edit with references), then use it as the opening frame.",
          });
        }
        /* Soundtrack works on BOTH engines now. LTX freezes the audio latent
         * (measured r=0.995 mel); H3 freezes AND anchors so the DiT can read
         * the vocal while the output plays the real track (measured r=0.984
         * waveform on the freeze). No refusal left on this axis. */

        const id = `v${Date.now().toString(36)}`;
        const job = art.request({
          // No track to belong to, so it carries a pseudo-file. #clip names the
          // output after it and library.remember is never called for these.
          file: `clip:${id}`,
          title: String(b.title || "").trim() || prompt.slice(0, 48),
          kind: "video", force: true,
          // An explicit seed makes a clip reproducible; a rolled one is RECORDED in
          // the metadata, so "I liked that, give me another like it" still works.
          seed: Number.isFinite(b.seed) ? Number(b.seed) : Math.floor(Math.random() * 4294967296),
          video: {
            // Carried on the job so a queued clip keeps the engine it was made
            // with, even if the setting changes while it waits for the GPU.
            engine: config.video.engine,
            prompt,
            firstFrame,
            lastFrame,
            // Only meaningful on the guided path, which needs both ends. The
            // graph ignores them otherwise rather than half-applying them.
            midFrames,
            // H3 only — refused above for LTX rather than silently dropped.
            refImages,
            refAudios,
            // LTX only — the clip is generated ON this audio (frozen latent).
            audioTrack,
            /* ⚠ Defaults come from the ENGINE, not from `config.video`.
             *
             * `config.video.seconds`, `.width`, `.height` and `.steps` do not
             * exist — every one of them lives on the selected engine, because
             * H3's native 1344x768 is not a legal LTX size. Reading them here
             * gave `undefined`, and `Math.max(undefined, 256)` is NaN, which
             * JSON-encodes as `null` and reached ComfyUI as
             * "Failed to convert an input value to a INT value: height, None".
             *
             * Invisible until now because the Video screen always sends all
             * four explicitly — so the default path had never once run. The
             * first caller to omit them was an MCP client, and all four of its
             * clips failed validation before a single frame was rendered. */
            seconds: Math.min(Math.max(Number(b.seconds) || videoEngine().seconds, 1), 20),
            width: Math.min(Math.max(Number(b.width) || videoEngine().width, 256), 1920),
            height: Math.min(Math.max(Number(b.height) || videoEngine().height, 256), 1920),
            steps: Math.min(Math.max(Number(b.steps) || videoEngine().steps || 20, 2), 40),
            keepAudio: b.keepAudio !== false,
            negative: typeof b.negative === "string" ? b.negative.slice(0, 500) : undefined,
            // One dial for both CFG scales — see videoGraphLtx for why they must
            // not be settable apart.
            guidance: Number.isFinite(b.guidance) ? Math.min(Math.max(b.guidance, 1), 8) : undefined,
            guideStrength: Number.isFinite(b.guideStrength)
              ? Math.min(Math.max(b.guideStrength, 0.1), 1) : undefined,
            // Same picture at both ends. Measured: it still animates in between
            // (mid-clip divergence 6.00) and returns home (1.62), because the
            // guides sit at strength 0.7 rather than pinning at 1.0.
            loop: !!b.loop,
          },
        });
        return json(res, 200, { ok: true, id, job: job && { id: job.id }, ...art.status() });
      }

      if (b.action === "engine") {
        const e = String(b.value || "");
        if (!config.video.engines[e]) return json(res, 400, { error: "Unknown engine." });
        /* Refuse an engine whose weights are absent. Otherwise the choice looks
         * accepted and every render fails inside a ComfyUI node minutes later,
         * detached from the click that caused it. */
        const capId = e === "ltx" ? "videoLtx" : "video";
        const cap = (await models.status()).find((c) => c.id === capId);
        if (cap && !cap.ready) {
          return json(res, 400, {
            error: `${config.video.engines[e].label} is not downloaded yet (${((cap.totalBytes - cap.haveBytes) / 1e9).toFixed(1)} GB missing). Open the Models screen.`,
          });
        }
        config.video.engine = e;
        savePrefs();
        return json(res, 200, { ok: true, video: { engine: e, enabled: config.video.enabled } });
      }

      if (b.action === "when") {
        const v = String(b.value || "off");
        if (!["off", "all", "starred", "liked"].includes(v)) return json(res, 400, { error: "bad mode" });
        if (v !== "off" && !config.video.enabled) {
          return json(res, 400, { error: "Switch the H3 model on before choosing when clips are made." });
        }
        config.video.when = v;
        savePrefs();
        return json(res, 200, { ok: true, video: { enabled: config.video.enabled, when: v } });
      }
      if (b.action === "run") {
        if (!config.video.enabled) return json(res, 400, { error: "Video is switched off in Settings." });
        /* Check the weights are actually here. Without this the job is queued,
         * runs 30 s later, and fails inside a ComfyUI node — so the error shows
         * up detached from the click that caused it, saying something about a
         * missing safetensors rather than "open the Models screen". */
        const cap = (await models.status()).find((c) => c.id === (config.video.engine === "ltx" ? "videoLtx" : "video"));
        if (cap && !cap.ready) {
          const need = cap.totalBytes - cap.haveBytes;
          return json(res, 400, {
            error: `${videoEngine().label} is not downloaded yet (${(need / 1e9).toFixed(1)} GB missing). Open the Models screen.`,
          });
        }
        const file = String(b.file || "");
        if (!file || file.includes("..") || file.includes("/") || file.includes("\\")) {
          return json(res, 400, { error: "bad file" });
        }
        const m = library.meta.get(file) || {};
        art.request({ file, title: m.title, caption: m.caption, seed: m.seed, kind: "video", force: true });
        return json(res, 200, { ok: true, ...art.status() });
      }
      return json(res, 400, { error: "Unknown action." });
    }

    /**
     * Settings that outlive the process.
     *
     * Only the ones that genuinely have to persist live here — where ComfyUI is
     * and where songs go. Everything else in Settings is a runtime toggle and
     * belongs in memory, because a per-session choice that silently survives a
     * restart is its own kind of confusing.
     *
     * Neither takes effect until the engine restarts, and this says so rather
     * than pretending otherwise: `--output-directory` is a launch argument.
     */
    /* Cover-art preferences: which engine paints the library's thumbnails,
     * and the style line every auto cover prompt opens with. Takes effect on
     * the NEXT cover — nothing needs a restart. */
    if (p === "/api/artconfig" && req.method === "GET") {
      return json(res, 200, {
        engine: config.art.engine, checkpoint: config.art.checkpoint,
        quality: config.art.quality, style: config.art.style,
        styleDefault: config.artStyleDefault,
      });
    }
    if (p === "/api/artconfig" && req.method === "POST") {
      const b = await readBody(req);
      if (b.engine !== undefined) {
        if (!["flux2", "ideogram4", "checkpoint"].includes(b.engine)) {
          return json(res, 400, { error: "engine must be flux2 | ideogram4 | checkpoint" });
        }
        if (b.engine === "ideogram4") {
          const cap = (await models.status()).find((c) => c.id === "imageIdeogram");
          if (cap && !cap.ready) return json(res, 400, { error: "Ideogram 4 is not downloaded — open the Models screen first. And mind its NON-COMMERCIAL licence before making it the library default." });
        }
        config.art.engine = b.engine;
      }
      if (b.checkpoint !== undefined) {
        const nm = b.checkpoint === null ? null : path.basename(String(b.checkpoint));
        if (nm) {
          try { await stat(path.join(config.comfyDir, "models", "checkpoints", nm)); }
          catch { return json(res, 400, { error: `No such checkpoint: ${nm}` }); }
        }
        config.art.checkpoint = nm;
      }
      if (config.art.engine === "checkpoint" && !config.art.checkpoint) {
        return json(res, 400, { error: "Pick which checkpoint file paints the covers." });
      }
      if (b.quality !== undefined) {
        if (!["default", "quality"].includes(b.quality)) return json(res, 400, { error: "quality must be default | quality" });
        config.art.quality = b.quality;
      }
      if (b.style !== undefined) {
        const st = String(b.style).trim();
        if (!st || st.length > 1500) return json(res, 400, { error: "The style line must be 1-1500 characters." });
        config.art.style = st;
      }
      savePrefs();
      return json(res, 200, { ok: true, engine: config.art.engine, checkpoint: config.art.checkpoint,
                              quality: config.art.quality, style: config.art.style });
    }

    if (p === "/api/settings" && req.method === "POST") {
      const b = await readBody(req);
      const next = {};
      if (typeof b.outputDir === "string" && b.outputDir.trim()) {
        const dir = path.resolve(b.outputDir.trim());
        try {
          await mkdir(dir, { recursive: true });
          // Prove it is writable NOW. Discovering otherwise at 3am, four songs
          // into an overnight run, is the version of this that costs a night.
          const probe = path.join(dir, ".aiplay-write-test");
          await writeFile(probe, "");
          await unlink(probe);
        } catch (err) {
          return json(res, 400, { error: `Cannot write to that folder: ${err.message}` });
        }
        next.outputDir = dir;
      }
      if (typeof b.rig === "string" && b.rig.trim()) {
        const rig = path.resolve(b.rig.trim());
        try { await stat(path.join(rig, "ComfyUI", "main.py")); }
        catch { return json(res, 400, { error: "That folder does not contain ComfyUI/main.py." }); }
        next.rig = rig;
      }
      if (!Object.keys(next).length) return json(res, 400, { error: "Nothing to change." });

      let current = {};
      try { current = JSON.parse(await readFile(config.settingsFile, "utf-8")); } catch { /* first write */ }
      const merged = { ...current, ...next };
      await mkdir(path.dirname(config.settingsFile), { recursive: true });
      await writeFile(config.settingsFile, JSON.stringify(merged, null, 2));
      return json(res, 200, {
        ok: true, settings: merged,
        // The honest part: nothing has moved yet.
        needsRestart: true,
        note: "Saved. Restart AIPLAY Studio for this to take effect — the engine is launched with the folder as an argument.",
      });
    }

    /**
     * Audio reference — turn a piece of audio into a latent the sampler can
     * start from.
     *
     * Two sources, one result. `file` reuses a track already in the library
     * (remix your own song); a raw upload covers anything else. Raw bytes
     * rather than a base64 data URI, because a five-minute FLAC is ~50 MB and
     * base64 would make it 67 MB of JSON for no benefit — the image upload
     * elsewhere uses a data URI only because thumbnails are small.
     *
     * The encode is cached by content: the same audio encoded twice reuses the
     * .latent, so re-rolling a remix costs nothing.
     */
    if (p === "/api/audioref" && req.method === "POST") {
      const src = url.searchParams.get("file");
      const name = url.searchParams.get("name") || "reference";
      let audioPath = null;
      let tmp = null;

      if (src) {
        if (src.includes("..") || src.includes("/") || src.includes("\\")) {
          return json(res, 400, { error: "bad file" });
        }
        audioPath = path.join(config.outputDir, src);
      } else {
        const chunks = [];
        let n = 0;
        for await (const c of req) {
          n += c.length;
          // A hard ceiling so a stray upload cannot fill the disk. Generous:
          // a lossless 10-minute master fits.
          if (n > 200 * 1024 * 1024) return json(res, 413, { error: "Reference audio must be under 200 MB." });
          chunks.push(c);
        }
        if (!n) return json(res, 400, { error: "No audio received." });
        const ext = (path.extname(name).toLowerCase().match(/^\.(mp3|wav|flac|ogg|opus|m4a|aac)$/) || [".mp3"])[0];
        tmp = path.join(config.inputDir, `upload_${Date.now()}${ext}`);
        await mkdir(config.inputDir, { recursive: true });
        await writeFile(tmp, Buffer.concat(chunks));
        audioPath = tmp;
      }

      try { await stat(audioPath); } catch { return json(res, 404, { error: "Audio not found." }); }

      // Deterministic name so the same source reuses its latent across re-rolls.
      const stem = "ref_" + createHash("sha1")
        .update(audioPath + String((await stat(audioPath)).size)).digest("hex").slice(0, 12);

      const out = await new Promise((resolve) => {
        const proc = spawn(config.systemPython, [
          path.join(__dirname, "..", "scripts", "dav_encode.py"), audioPath,
          "--out-dir", config.inputDir, "--name", stem,
          "--seconds", String(config.audioRef.maxSeconds), "--json",
        ], { windowsHide: true });
        let last = "", err = "";
        proc.stdout.on("data", (d) => { last += d.toString(); });
        proc.stderr.on("data", (d) => { err += d.toString(); });
        proc.on("error", (e) => resolve({ error: String(e.message || e) }));
        proc.on("close", (code) => {
          // Parse the LAST JSON object on stdout. Anything else the script
          // printed is on stderr by construction, but this stays robust if that
          // ever stops being true.
          const m = last.trim().match(/\{[\s\S]*\}$/);
          if (code !== 0 || !m) return resolve({ error: (err.trim().split("\n").pop() || `encoder exited ${code}`) });
          try { resolve(JSON.parse(m[0])); } catch { resolve({ error: "encoder produced no result" }); }
        });
      });

      if (tmp) await unlink(tmp).catch(() => {});
      if (out.error) return json(res, 500, out);
      return json(res, 200, {
        ...out,
        denoise: config.audioRef.denoise,
        // Surfaced so the UI can warn rather than let a bad reference show up
        // later as a bad-sounding song with no explanation.
        weak: typeof out.siSdrDb === "number" && out.siSdrDb < config.audioRef.warnBelowSdrDb,
      });
    }

    /**
     * Every clip on disk, newest first.
     *
     * Read from the folder rather than from the library, because standalone
     * clips are deliberately not library entries — the folder is the only place
     * that knows about both kinds.
     */
    if (p === "/api/clips" && req.method !== "POST") {
      let names = [];
      // .webm as well as .mp4: studio exports are WebM (MediaRecorder's format),
      // and a listing that only knows about .mp4 makes them invisible in the very
      // library they were assembled from.
      try {
        /* Imports live in this folder too, so the filter cannot be "video only"
         * any more — an imported still or song would be written successfully
         * and then be invisible in the very bin it was imported into. */
        names = (await readdir(CLIP_DIR)).filter((f) =>
          /\.(mp4|webm|mov|mkv|m4v|mp3|wav|flac|ogg|opus|m4a|png|jpg|jpeg|webp|gif)$/i.test(f));
      } catch { /* none yet */ }
      const rows = await Promise.all(names.map(async (name) => {
        const st = await stat(path.join(CLIP_DIR, name)).catch(() => null);
        // A clip named after a track carries that track's title; a standalone one
        // has only its filename, so the job title is lost once the process ends.
        const stem = name.replace(/\.[a-z0-9]+$/i, "");
        const owner = [...library.meta.entries()]
          .find(([f]) => f.replace(/\.(flac|mp3|opus|wav)$/i, "") === stem);
        return {
          name, bytes: st?.size ?? 0, at: st?.mtimeMs ?? 0,
          track: owner ? owner[0] : null,
          title: owner ? (owner[1].title || owner[0]) : null,
          // Render time. `clipSeconds` is read too, for sidecars written before
          // the name was disambiguated — those hold render time under the old
          // spelling, so dropping it would blank the figure on every clip made
          // up to now.
          seconds: clipTimes.get(name) ?? owner?.[1]?.clipRenderSeconds ?? owner?.[1]?.clipSeconds ?? null,
          meta: clipMeta.get(name) ?? owner?.[1]?.clipMeta ?? null,
        };
      }));
      rows.sort((a, b) => b.at - a.at);
      return json(res, 200, {
        clips: rows, enabled: config.video.enabled,
        // So the dialog's warning and the route's refusal cannot disagree.
        enhanceLimitBytes: enhanceLimitBytes(),
      });
    }

    /**
     * API mode: what is configured, what it protects the key with, what it has
     * cost this month. Never the key itself.
     */
    if (p === "/api/apimode" && req.method !== "POST") {
      const st = await apiStatus();
      st.protection = protectionAvailable();
      st.keys = {};
      for (const [name, prov] of Object.entries(PROVIDERS)) {
        st.keys[name] = await secretStatus(prov.keyName);
      }
      return json(res, 200, st);
    }

    if (p === "/api/apimode" && req.method === "POST") {
      const b = await readBody(req);

      /* Saving a key. It is written straight to the encrypted store and dropped
       * — this handler never returns it, and the response says only HOW it was
       * protected so the UI can be truthful about DPAPI versus file
       * permissions. */
      if (b.action === "setKey") {
        const prov = PROVIDERS[b.provider];
        if (!prov) return json(res, 400, { error: "Unknown provider." });
        const r = await setSecret(prov.keyName, b.key);
        return json(res, 200, { ok: true, ...r, status: await secretStatus(prov.keyName) });
      }

      if (b.action === "clearKey") {
        const prov = PROVIDERS[b.provider];
        if (!prov) return json(res, 400, { error: "Unknown provider." });
        await clearSecret(prov.keyName);
        return json(res, 200, { ok: true, status: await secretStatus(prov.keyName) });
      }

      /* Toggling the mode and the cap. Both live in settings.json rather than in
       * memory: an overnight run that starts under one cap and continues under
       * another after a restart would make the ceiling meaningless. */
      if (b.action === "config") {
        const patch = {};
        if (typeof b.enabled === "boolean") patch.enabled = b.enabled;
        if (typeof b.provider === "string" && PROVIDERS[b.provider]) patch.provider = b.provider;
        if (Number.isFinite(b.monthlyCapUsd)) {
          // Clamped rather than free-form: a typo'd extra zero is the exact
          // accident the cap exists to prevent.
          patch.monthlyCapUsd = Math.min(Math.max(b.monthlyCapUsd, 0), 1000);
        }
        Object.assign(config.api, patch);
        let cur = {};
        try { cur = JSON.parse(await readFile(config.settingsFile, "utf-8")); } catch { /* first write */ }
        await writeFile(config.settingsFile,
          JSON.stringify({ ...cur, api: { ...config.api } }, null, 2), "utf-8");
        return json(res, 200, { ok: true, api: config.api, spend: await spendSummary() });
      }

      /* A cheap "is this key real" check. Deliberately does NOT generate — the
       * point is to fail for free rather than to spend money finding out. */
      if (b.action === "test") {
        const prov = PROVIDERS[b.provider || config.api.provider];
        if (!prov) return json(res, 400, { error: "Unknown provider." });
        const st = await secretStatus(prov.keyName);
        if (!st.set) return json(res, 200, { ok: false, reason: "No key saved for that provider." });
        if (!st.usable) {
          return json(res, 200, { ok: false,
            reason: "The saved key cannot be decrypted on this machine or account — save it again." });
        }
        return json(res, 200, { ok: true, reason: `Key is stored and readable (${st.hint}).` });
      }

      return json(res, 400, { error: "Unknown action." });
    }

    /**
     * Custom ComfyUI graphs: what is in the folder, what is wrong with each, and
     * which kind each is standing in for.
     */
    if (p === "/api/workflows" && req.method !== "POST") {
      return json(res, 200, {
        dir: CUSTOM_DIR,
        tokens: TOKENS,
        kinds: KINDS,
        assigned: config.customWorkflows || {},
        workflows: await listCustom(),
      });
    }

    if (p === "/api/workflows" && req.method === "POST") {
      const b = await readBody(req);
      if (b.action !== "assign") return json(res, 400, { error: "Unknown action." });
      if (!KINDS.includes(b.kind)) return json(res, 400, { error: "Unknown kind." });
      const list = await listCustom();
      // Only a graph that actually loads can be assigned. Accepting a broken one
      // would move the failure to render time, hours later, inside a batch.
      if (b.workflow && !list.some((w) => w.id === b.workflow && w.ok)) {
        return json(res, 400, { error: "That workflow is missing or does not load." });
      }
      config.customWorkflows = { ...(config.customWorkflows || {}), [b.kind]: b.workflow || null };
      let cur = {};
      try { cur = JSON.parse(await readFile(config.settingsFile, "utf-8")); } catch { /* first write */ }
      await writeFile(config.settingsFile,
        JSON.stringify({ ...cur, customWorkflows: config.customWorkflows }, null, 2), "utf-8");
      return json(res, 200, { ok: true, assigned: config.customWorkflows });
    }

    /**
     * A picture to use as a starting or closing frame.
     *
     * Written into ComfyUI's input directory, which is the only place LoadImage
     * looks. Returns the name Studio chose, which is what the client passes back
     * when it asks for a render — the client never names the file.
     */
    if (p === "/api/frame" && req.method === "POST") {
      const chunks = [];
      let n = 0;
      for await (const c of req) {
        n += c.length;
        // 40 MB. A 4K PNG is comfortably inside it; a video file is not, and
        // this must refuse before buffering rather than after.
        if (n > 40 * 1024 * 1024) return json(res, 413, { error: "Images must be under 40 MB." });
        chunks.push(c);
      }
      if (!n) return json(res, 400, { error: "No image received." });
      const buf = Buffer.concat(chunks);

      /* Sniff the actual bytes. An extension is a claim by whoever uploaded the
       * file; a magic number is the file itself. WEBP needs the RIFF container
       * AND the WEBP tag, because RIFF alone is also a WAV. */
      const sig = (b) => {
        if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
        if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
        if (b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "webp";
        return null;
      };
      const ext = sig(buf);
      if (!ext) {
        return json(res, 400, {
          error: "That is not a PNG, JPEG or WEBP. Studio checks the file itself, not its name.",
        });
      }

      // Ours, and derived from the content: the same picture twice is one file.
      const name = `aiplay_frame_${createHash("sha1").update(buf).digest("hex").slice(0, 12)}.${ext}`;
      try {
        await mkdir(config.inputDir, { recursive: true });
        await writeFile(path.join(config.inputDir, name), buf);
      } catch (err) {
        return json(res, 500, { error: `Could not save it: ${err.message}` });
      }
      return json(res, 200, { ok: true, name, bytes: buf.length, kind: ext });
    }

    /**
     * Upload an audio file to use as a video REFERENCE (<Audio n> in an H3
     * prompt). Same contract as /api/frame: bytes in, a server-minted name
     * out, the file sniffed rather than trusted. Distinct from /api/audioref,
     * which encodes a recording into the MUSIC model's latent — this one just
     * stages a file where ComfyUI's LoadAudio can read it.
     */
    if (p === "/api/refaudio" && req.method === "POST") {
      const chunks = [];
      let n = 0;
      for await (const c of req) {
        n += c.length;
        // 40 MB holds ~4 minutes of WAV — and only ten seconds ride into the
        // render anyway (the graph trims), so bigger is never useful.
        if (n > 40 * 1024 * 1024) return json(res, 413, { error: "Audio must be under 40 MB." });
        chunks.push(c);
      }
      if (!n) return json(res, 400, { error: "No audio received." });
      const buf = Buffer.concat(chunks);
      const sig = (b) => {
        if (b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE") return "wav";
        if (b.length > 4 && b.toString("ascii", 0, 4) === "fLaC") return "flac";
        if (b.length > 4 && b.toString("ascii", 0, 4) === "OggS") return "ogg";
        if (b.length > 3 && b.toString("ascii", 0, 3) === "ID3") return "mp3";
        if (b.length > 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "mp3";
        if (b.length > 12 && b.toString("ascii", 4, 8) === "ftyp") return "m4a";
        return null;
      };
      const ext = sig(buf);
      if (!ext) {
        return json(res, 400, {
          error: "That is not a WAV, FLAC, MP3, OGG or M4A. Studio checks the file itself, not its name.",
        });
      }
      const name = `aiplay_refaud_${createHash("sha1").update(buf).digest("hex").slice(0, 12)}.${ext}`;
      try {
        await mkdir(config.inputDir, { recursive: true });
        await writeFile(path.join(config.inputDir, name), buf);
      } catch (err) {
        return json(res, 500, { error: `Could not save it: ${err.message}` });
      }
      return json(res, 200, { ok: true, name, bytes: buf.length, kind: ext });
    }

    /** What a render would cost before anyone commits to it. */
    if (p === "/api/apicost") {
      const secs = Number(new URL(req.url, "http://x").searchParams.get("seconds")) || 60;
      return json(res, 200, {
        seconds: secs,
        usd: estimateUsd(secs),
        spend: await spendSummary(),
      });
    }

    /**
     * A studio export, arriving as raw bytes.
     *
     * WebM rather than MP4 because MediaRecorder is what produced it — see
     * web/studio.js for why that is the right trade. It lands in CLIP_DIR so it
     * shows up in the clip library next to the renders it was assembled from,
     * which is where someone would look for it.
     */
    /**
     * Import a file the user already had.
     *
     * Written into the SAME clip folder as everything the app generates, on
     * purpose: an imported file then behaves like a generated one everywhere —
     * it survives a reload, appears in the bin, can be enhanced, and the
     * autosaved project can point at it. Keeping imports in memory as object
     * URLs would be less code and would break every one of those.
     */
    /**
     * Studio projects — list, save, delete.
     *
     * Stored beside the media rather than in the browser: a project references
     * clips and songs that live on the server, so keeping the one part of that
     * graph in localStorage is how you lose a week's work to a cleared cache.
     */
    /** The Images screen: make one, list them, throw one away. */
    if (p === "/api/image" && req.method === "POST") {
      const b = await readBody(req);
      if (b.action !== "create") return json(res, 400, { error: "Unknown action." });

      const engine = ["flux2", "ideogram4", "checkpoint"].includes(b.engine) ? b.engine : "flux2";
      if (engine === "flux2") {
        const cap = (await models.status()).find((c) => c.id === "coverArt");
        if (cap && !cap.ready) {
          return json(res, 400, {
            error: `The image model is not downloaded yet (${((cap.totalBytes - cap.haveBytes) / 1e9).toFixed(1)} GB missing). Open the Models screen.`,
          });
        }
      }
      if (engine === "ideogram4") {
        const cap = (await models.status()).find((c) => c.id === "imageIdeogram");
        if (cap && !cap.ready) {
          return json(res, 400, {
            error: `Ideogram 4 is not downloaded yet (${((cap.totalBytes - cap.haveBytes) / 1e9).toFixed(1)} GB missing). Open the Models screen — and mind its NON-COMMERCIAL licence.`,
          });
        }
        if (Array.isArray(b.refImages) && b.refImages.length) {
          return json(res, 400, { error: "Reference images are FLUX's trick — Ideogram 4 has no reference input. Switch the engine to FLUX.2 for refs." });
        }
      }
      if (engine === "checkpoint") {
        const nm = path.basename(String(b.checkpoint || ""));
        if (!nm) return json(res, 400, { error: "Pick a checkpoint file first (models/checkpoints)." });
        try { await stat(path.join(config.comfyDir, "models", "checkpoints", nm)); }
        catch { return json(res, 400, { error: `No such checkpoint: ${nm}` }); }
        b.checkpoint = nm;
        if (Array.isArray(b.refImages) && b.refImages.length) {
          return json(res, 400, { error: "Reference images are FLUX's trick — switch the engine to FLUX.2 for refs." });
        }
      }
      const prompt = String(b.prompt || "").trim();
      if (!prompt) return json(res, 400, { error: "Describe the picture first." });

      /* Reference images — FLUX in-context editing. Staged into ComfyUI's
       * input dir exactly the way video frames are: an already-staged upload
       * name passes through, a cover or Images-screen file is copied in. The
       * prompt refers to them as "image 1", "image 2" in this order. */
      let refImages = [];
      if (Array.isArray(b.refImages) && b.refImages.length) {
        const stage = async (v) => {
          const nm = path.basename(String(v || ""));
          if (/^aiplay_frame_[0-9a-f]{12}\.(png|jpg|webp)$/.test(nm)) return nm;
          let src = path.join(COVER_DIR, nm);
          try { await stat(src); } catch { src = path.join(IMAGE_DIR, nm); }
          await stat(src);
          const name = `aiplay_frame_${createHash("sha1").update(src).digest("hex").slice(0, 12)}${path.extname(src)}`;
          await mkdir(config.inputDir, { recursive: true });
          await writeFile(path.join(config.inputDir, name), await readFile(src));
          return name;
        };
        refImages = (await Promise.all(b.refImages.slice(0, 10).map(async (v) => {
          try { return await stage(v); } catch { return undefined; }
        }))).filter(Boolean);
      }

      const id = `i${Date.now().toString(36)}`;
      const file = `image:${id}`;
      pendingImagePrompt.set(file, prompt);
      const job = art.request({
        file, title: prompt.slice(0, 48), kind: "cover", force: true,
        seed: Number.isFinite(b.seed) ? Number(b.seed) : Math.floor(Math.random() * 4294967296),
        video: {
          prompt,
          engine,
          quality: b.quality === "quality" ? "quality" : "default",
          checkpoint: b.checkpoint || undefined,
          negative: typeof b.negative === "string" ? b.negative.slice(0, 2000) : undefined,
          cfg: Number.isFinite(b.cfg) ? Math.min(Math.max(Number(b.cfg), 1), 15) : undefined,
          // One text encode serves up to four pictures — see coverGraph.
          count: Math.min(Math.max(Number(b.count) || 1, 1), 4),
          width: Math.min(Math.max(Number(b.width) || config.art.size, 256), 2048),
          height: Math.min(Math.max(Number(b.height) || config.art.size, 256), 2048),
          steps: Math.min(Math.max(Number(b.steps) || config.art.steps, 1), engine === "checkpoint" ? 60 : 30),
          refImages,
        },
      });
      return json(res, 200, { ok: true, id, job: job && { id: job.id }, ...art.status() });
    }

    /* The bring-your-own-model shelf: whatever .safetensors sits in
     * ComfyUI/models/checkpoints. The app lists, it does not curate. */
    if (p === "/api/checkpoints" && req.method === "GET") {
      let files = [];
      try {
        files = (await readdir(path.join(config.comfyDir, "models", "checkpoints")))
          .filter((f) => /\.(safetensors|ckpt)$/i.test(f) && !/stable_audio/i.test(f));
      } catch { /* dir missing = empty shelf */ }
      return json(res, 200, { checkpoints: files });
    }

    if (p === "/api/images" && req.method !== "POST") {
      let names = [];
      try {
        names = (await readdir(IMAGE_DIR)).filter((f) => /\.(png|svg)$/i.test(f) && !f.endsWith("_t.png"));
      } catch { /* none yet */ }
      const rows = await Promise.all(names.map(async (name) => {
        const st = await stat(path.join(IMAGE_DIR, name)).catch(() => null);
        return {
          name, bytes: st?.size ?? 0, at: st?.mtimeMs ?? 0,
          meta: imageMeta.get(name) ?? null,
        };
      }));
      rows.sort((a, b) => b.at - a.at);
      return json(res, 200, { images: rows, enabled: true });
    }

    /* The editing engine (server/imagetools.py). One implementation serves the
     * Images screen and the MCP tools: the browser previews with CSS
     * approximations, every COMMITTED edit renders here. Always a NEW file —
     * the original is never touched. */
    if (p === "/api/images/edit" && req.method === "POST") {
      const b = await readBody(req);
      const name = path.basename(String(b.name || ""));
      if (!/\.(png|jpg|jpeg|webp)$/i.test(name)) return json(res, 400, { error: "bad name" });
      const src = path.join(IMAGE_DIR, name);
      try { await stat(src); } catch { return json(res, 404, { error: "no such image" }); }
      const stem = name.replace(/\.[^.]+$/, "");
      const outName = `${stem}_e${Date.now().toString(36)}.png`;
      const jobPath = path.join(IMAGE_DIR, `.edit_${Date.now().toString(36)}.json`);
      await writeFile(jobPath, JSON.stringify({
        in: src, out: path.join(IMAGE_DIR, outName),
        thumbOut: path.join(IMAGE_DIR, `${outName.replace(/\.png$/, "")}_t.png`),
        thumbSize: config.art.thumbSize, ops: b.ops || {},
      }));
      try {
        const out = await new Promise((resolve, reject) => {
          const proc = spawn(config.python, [path.join(__dirname, "imagetools.py"), "edit", jobPath], { windowsHide: true });
          let so = "", se = "";
          proc.stdout.on("data", (d) => { so += d; });
          proc.stderr.on("data", (d) => { se += d; });
          proc.on("close", (code) => code === 0 ? resolve(so) : reject(new Error(se.slice(-300) || `exit ${code}`)));
        });
        const r = JSON.parse(out.trim().split("\n").pop());
        if (!r.ok) throw new Error(r.error || "edit failed");
        const parent = imageMeta.get(name) || {};
        imageMeta.set(outName, { ...parent, editedFrom: name, ops: b.ops || {}, at: Date.now(), durationMs: null });
        saveImageStore();
        return json(res, 200, { ok: true, name: outName });
      } catch (err) {
        return json(res, 400, { error: `edit failed: ${err.message}` });
      } finally {
        unlink(jobPath).catch(() => {});
      }
    }

    /* Vector conversion — posterize + contour-trace, made for logos and flat
     * art. Photographs come out as posterized art, which is what an SVG is. */
    if (p === "/api/images/vectorize" && req.method === "POST") {
      const b = await readBody(req);
      const name = path.basename(String(b.name || ""));
      if (!/\.(png|jpg|jpeg|webp)$/i.test(name)) return json(res, 400, { error: "bad name" });
      const src = path.join(IMAGE_DIR, name);
      try { await stat(src); } catch { return json(res, 404, { error: "no such image" }); }
      const outName = `${name.replace(/\.[^.]+$/, "")}_v.svg`;
      const jobPath = path.join(IMAGE_DIR, `.vec_${Date.now().toString(36)}.json`);
      await writeFile(jobPath, JSON.stringify({
        in: src, out: path.join(IMAGE_DIR, outName),
        colors: Math.max(2, Math.min(16, Number(b.colors) || 6)),
        detail: Math.max(0.2, Math.min(4, Number(b.detail) || 1)),
      }));
      try {
        const out = await new Promise((resolve, reject) => {
          const proc = spawn(config.python, [path.join(__dirname, "imagetools.py"), "vectorize", jobPath], { windowsHide: true });
          let so = "", se = "";
          proc.stdout.on("data", (d) => { so += d; });
          proc.stderr.on("data", (d) => { se += d; });
          proc.on("close", (code) => code === 0 ? resolve(so) : reject(new Error(se.slice(-300) || `exit ${code}`)));
        });
        const r = JSON.parse(out.trim().split("\n").pop());
        if (!r.ok) throw new Error(r.error || "vectorize failed");
        const parent = imageMeta.get(name) || {};
        imageMeta.set(outName, { ...parent, vectorFrom: name, at: Date.now(), durationMs: null });
        saveImageStore();
        return json(res, 200, { ok: true, name: outName, paths: r.paths, bytes: r.bytes });
      } catch (err) {
        return json(res, 400, { error: `vectorize failed: ${err.message}` });
      } finally {
        unlink(jobPath).catch(() => {});
      }
    }

    if (p === "/api/images" && req.method === "POST") {
      const b = await readBody(req);
      if (b.action !== "trash") return json(res, 400, { error: "Unknown action." });
      const name = path.basename(String(b.name || ""));
      if (!name || !/\.png$/i.test(name)) return json(res, 400, { error: "bad name" });
      const dir = path.join(config.outputDir, "trash");
      try {
        await mkdir(dir, { recursive: true });
        await rename(path.join(IMAGE_DIR, name), path.join(dir, name));
        // The thumbnail travels with it, or the trash fills with orphans.
        await rename(path.join(IMAGE_DIR, name.replace(/\.png$/i, "_t.png")),
                     path.join(dir, name.replace(/\.png$/i, "_t.png"))).catch(() => {});
      } catch (err) {
        return json(res, 400, { error: `Could not move it: ${err.message}` });
      }
      imageMeta.delete(name);
      saveImageStore();
      return json(res, 200, { ok: true });
    }

    if (p.startsWith("/api/image/")) {
      const name = path.basename(decodeURIComponent(p.slice("/api/image/".length)));
      if (!/\.(png|jpg|jpeg|webp|svg)$/i.test(name)) return json(res, 400, { error: "bad name" });
      try {
        const buf = await readFile(path.join(IMAGE_DIR, name));
        /* From the EXTENSION. It was hardcoded to image/png while the check
         * above accepts three other types — the same mistake `/api/clip/` had,
         * where an imported PNG was served as video/mp4. Latent today because
         * the engine only writes PNG, which is exactly how it would survive
         * until the day something else lands here. */
        const mime = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
          ".svg": "image/svg+xml" }[path.extname(name).toLowerCase()] || "image/png";
        res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=3600" });
        return res.end(buf);
      } catch { return json(res, 404, { error: "no image" }); }
    }

    /**
     * What the MCP server offers, read from the MCP server itself.
     *
     * The explanation page renders this rather than a typed-out list, so it
     * cannot advertise a tool that does not exist or miss one that does — same
     * reasoning as the Thanks page building its licence table from the live
     * model catalogue. `mcp.js` only wires up stdin when it is RUN, so importing
     * it here is safe.
     */
    if (p === "/api/mcp") {
      try {
        const { TOOL_SUMMARY } = await import("./mcp.js");
        return json(res, 200, {
          tools: TOOL_SUMMARY(),
          command: process.execPath,
          args: [path.join(__dirname, "mcp.js")],
          url: `http://127.0.0.1:${config.uiPort}`,
        });
      } catch (err) {
        return json(res, 500, { error: String(err.message || err) });
      }
    }

    if (p === "/api/studio/projects" && req.method !== "POST") {
      let rows = [];
      try {
        const names = (await readdir(PROJECT_DIR)).filter((f) => f.endsWith(".json"));
        rows = await Promise.all(names.map(async (f) => {
          const st = await stat(path.join(PROJECT_DIR, f)).catch(() => null);
          let title = f.replace(/\.json$/, ""), items = 0;
          try {
            const d = JSON.parse(await readFile(path.join(PROJECT_DIR, f), "utf8"));
            title = d.name || title;
            items = (d.tracks || []).reduce((a, t) => a + (t.items?.length || 0), 0);
          } catch { /* a corrupt file still lists, so it can be deleted */ }
          return { file: f, name: title, items, bytes: st?.size ?? 0, at: st?.mtimeMs ?? 0 };
        }));
      } catch { /* none yet */ }
      rows.sort((a, b) => b.at - a.at);
      return json(res, 200, { projects: rows });
    }

    if (p === "/api/studio/projects" && req.method === "POST") {
      const b = await readBody(req);

      if (b.action === "save") {
        const name = String(b.name || "").trim().slice(0, 80);
        if (!name) return json(res, 400, { error: "Give the project a name." });
        if (!b.doc || !Array.isArray(b.doc.tracks)) return json(res, 400, { error: "Nothing to save." });
        /* The filename is DERIVED from the name, never taken from the client.
         * Saving twice under one name overwrites, which is what Save means. */
        const slug = name.replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "project";
        const file = `${slug}.json`;
        try {
          await mkdir(PROJECT_DIR, { recursive: true });
          await writeFile(path.join(PROJECT_DIR, file),
            JSON.stringify({ ...b.doc, name, savedAt: Date.now() }, null, 1));
        } catch (err) {
          return json(res, 500, { error: `Could not save: ${err.message}` });
        }
        return json(res, 200, { ok: true, file, name });
      }

      if (b.action === "open" || b.action === "delete") {
        const file = path.basename(String(b.file || ""));
        if (!file.endsWith(".json")) return json(res, 400, { error: "bad name" });
        const full = path.join(PROJECT_DIR, file);
        try {
          if (b.action === "delete") {
            await unlink(full);
            return json(res, 200, { ok: true });
          }
          return json(res, 200, { ok: true, doc: JSON.parse(await readFile(full, "utf8")) });
        } catch (err) {
          return json(res, 400, { error: `Could not open it: ${err.message}` });
        }
      }
      return json(res, 400, { error: "Unknown action." });
    }

    if (p === "/api/studio/import" && req.method === "POST") {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 2_000_000_000) return json(res, 413, { error: "Too large — 2 GB is the limit." });
        chunks.push(c);
      }
      if (!size) return json(res, 400, { error: "Empty file." });

      let raw = "import";
      try { raw = decodeURIComponent(req.headers["x-name"] || "") || "import"; } catch { /* keep default */ }

      /* The extension decides how the file is treated, so it is taken from an
       * ALLOW-LIST rather than from whatever the client sent. A name is a hint
       * for the label; it is never allowed to become a path or an extension we
       * do not serve. */
      const ext = (path.extname(raw).toLowerCase().match(
        /^\.(mp4|webm|mov|mkv|m4v|mp3|wav|flac|ogg|opus|m4a|png|jpg|jpeg|webp|gif)$/) || [])[0];
      if (!ext) {
        return json(res, 400, {
          error: "That file type is not supported. Video, audio or an image, please.",
        });
      }
      const slug = path.basename(raw, path.extname(raw))
        .replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "import";
      const name = `import_${slug}_${Date.now().toString(36)}${ext}`;

      try {
        await mkdir(CLIP_DIR, { recursive: true });
        await writeFile(path.join(CLIP_DIR, name), Buffer.concat(chunks));
      } catch (err) {
        return json(res, 500, { error: `Could not write it: ${err.message}` });
      }
      const kind = /\.(mp3|wav|flac|ogg|opus|m4a)$/i.test(name) ? "audio"
        : /\.(png|jpg|jpeg|webp|gif)$/i.test(name) ? "image" : "video";
      clipMeta.set(name, { source: "import", kind, at: Date.now() });
      saveClipStore();
      return json(res, 200, { ok: true, name, kind });
    }

    if (p === "/api/studio/save" && req.method === "POST") {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        // A cap, because this route accepts an opaque body. 2 GB is well past any
        // plausible timeline and well short of anything that would exhaust RAM
        // slowly enough to be mistaken for a hang.
        if (size > 2_000_000_000) return json(res, 413, { error: "Too large." });
        chunks.push(c);
      }
      if (!size) return json(res, 400, { error: "Empty body." });
      // The title is a hint for the filename only — never trusted as a path.
      let hint = "timeline";
      try { hint = decodeURIComponent(req.headers["x-title"] || "") || "timeline"; } catch { /* keep default */ }
      const slug = hint.replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "timeline";
      const name = `studio_${slug}_${Date.now().toString(36)}.webm`;
      try {
        await mkdir(CLIP_DIR, { recursive: true });
        await writeFile(path.join(CLIP_DIR, name), Buffer.concat(chunks));
      } catch (err) {
        return json(res, 500, { error: `Could not write it: ${err.message}` });
      }
      clipMeta.set(name, { source: "studio", at: Date.now() });
      saveClipStore();
      return json(res, 200, { ok: true, name });
    }

    /**
     * Clip management. Trash only, and reversible.
     *
     * Deliberately a MOVE into output/trash rather than a delete, matching what
     * tracks already do: a render costs minutes of GPU and an accidental click
     * should not be the end of it.
     */
    /**
     * Restyle a clip, keeping its motion, with the look driven by a song.
     *
     * Runs at FULL denoise and holds the motion with LTX guides rather than by
     * holding denoise down — which is the only arrangement that both restyles
     * and preserves. See restyleGraph() for the measurements behind that.
     */
    if (p === "/api/restyle" && req.method === "POST") {
      const b = await readBody(req);
      const name = String(b.name || "");
      if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
        return json(res, 400, { error: "bad clip name" });
      }
      if (!/\.(mp4|webm)$/i.test(name)) return json(res, 400, { error: "not a video clip" });
      const prompt = String(b.prompt || "").trim();
      if (!prompt) return json(res, 400, { error: "Describe the look first." });
      const vr = videoReady("ltx");
      if (!vr.ready) return json(res, 400, { error: `LTX is not installed: ${vr.missing.join(", ")}` });

      const every = Math.min(Math.max(Number(b.guideEvery) || 16, 4), 48);

      /* The audio, if a song was named. Guide strength is INVERTED against
       * loudness — a weaker guide gives the model more freedom, so a loud
       * passage restyles harder. Driving it the intuitive way round makes the
       * picture go flat exactly where the track gets big. */
      let strengths = null;
      let bpm = null;
      if (b.song) {
        const song = path.basename(String(b.song));
        try {
          const beats = await beatsFor(song);
          if (beats) {
            bpm = beats.bpm;
            const guides = Math.ceil(121 / every);
            strengths = guideStrengths(beats, guides, {
              band: b.band || "bass",
              start: Number(b.start) || 0,
              every, fps: videoEngine("ltx").fps,
            });
          }
        } catch { /* a restyle without the audio is still a restyle */ }
      }

      /* ⚠ Everything the job needs goes in the `video` bag.
       *
       * `art.request()` destructures a FIXED set of fields and spreads only
       * `video` — so top-level extras are silently dropped, and the render
       * fails much later inside ComfyUI with "Required input is missing: text"
       * rather than anywhere near the caller. Its own comment warns that an
       * explicit whitelist there is what once dropped `audioRef`; this is the
       * same trap from the other side. */
      const job = art.request({
        file: name, title: name, kind: "restyle", force: true,
        seed: Number.isFinite(b.seed) ? Number(b.seed) : Math.floor(Math.random() * 4294967296),
        video: {
          prompt, negative: b.negative,
          guideEvery: every,
          guideStrength: Number.isFinite(b.guideStrength) ? Number(b.guideStrength) : undefined,
          strengths,
          width: Number(b.width) || undefined, height: Number(b.height) || undefined,
          seconds: Number(b.seconds) || undefined,
        },
      });
      return json(res, 200, {
        ok: true, job: job && { id: job.id },
        guides: strengths?.length ?? null, strengths, bpm,
        ...art.status(),
      });
    }

    if (p === "/api/clips" && req.method === "POST") {
      const b = await readBody(req);
      /**
       * Make a better version of a clip that already exists.
       *
       * Everything below is refused BEFORE queueing. This costs minutes of GPU
       * on a file the user already has, so "you cannot do that" is worth saying
       * up front rather than after the wait.
       */
      if (b.action === "enhance") {
        const name = String(b.name || "");
        if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
          return json(res, 400, { error: "bad name" });
        }
        let srcStat;
        try { srcStat = await stat(path.join(CLIP_DIR, name)); }
        catch { return json(res, 400, { error: "That clip is not on disk." }); }

        /* One-click mode: no explicit choice, just "make this better". Handled
         * up here because it answers the question the rest of the route is
         * about to ask, and answers it by stepping down until something fits
         * rather than by refusing. */
        if (b.auto) {
          const st0 = await models.status();
          for (const id of ["interpolate", "upscale"]) {
            const cap = st0.find((c) => c.id === id);
            if (cap && !cap.ready) {
              return json(res, 400, {
                error: `${cap.label} is not downloaded yet (${Math.round((cap.totalBytes - cap.haveBytes) / 1e6)} MB). Open the Models screen.`,
              });
            }
          }
          const meta0 = clipMeta.get(name) || {};
          const pxc = (v, f) => {
            const n = Number(v);
            return Number.isFinite(n) && n >= 16 && n <= 16384 ? Math.round(n) : f;
          };
          const hint = Number(b.seconds);
          const chosen = queueEnhance(name, {
            width: Number(meta0.width) || pxc(b.srcWidth, 1920),
            height: Number(meta0.height) || pxc(b.srcHeight, 1080),
            clipSeconds: Number(meta0.clipSeconds)
              || (Number.isFinite(hint) ? Math.min(Math.max(hint, 0.5), 600) : 0) || 20,
          }, "one-click", String(b.auto));
          if (!chosen) {
            return json(res, 400, {
              error: `Even the smallest option needs more memory than this machine can give `
                   + `(about ${(enhanceLimitBytes() / 1e9).toFixed(0)} GB available). Try a shorter clip.`,
            });
          }
          return json(res, 200, {
            ok: true, mode: chosen.mode, cost: chosen.cost,
            steppedDown: chosen.mode !== String(b.auto),
            ...art.status(),
          });
        }

        const want = { interp: !!b.interpolate, up: !!b.upscale };
        if (!want.interp && !want.up) {
          return json(res, 400, { error: "Pick smoother motion, a larger size, or both." });
        }

        /* Each half needs its own weights, and they are separate downloads — so
         * the message has to say WHICH one is missing, not that "a model" is. */
        const st = await models.status();
        for (const [need, id] of [[want.interp, "interpolate"], [want.up, "upscale"]]) {
          const cap = need && st.find((c) => c.id === id);
          if (cap && !cap.ready) {
            return json(res, 400, {
              error: `${cap.label} is not downloaded yet (${Math.round((cap.totalBytes - cap.haveBytes) / 1e6)} MB). Open the Models screen.`,
            });
          }
        }

        const mult = Math.min(Math.max(Math.round(Number(b.multiplier) || 2), 2), 8);
        const slow = !!b.slow;
        const meta = clipMeta.get(name) || {};
        /* Same order of trust as the duration below: what we recorded, then
         * what the client measured off its own <video> element, then a large
         * default. Clamped to a sane pixel range so a hand-rolled request
         * cannot shrink its way past the memory ceiling. */
        const px = (v, fallback) => {
          const n = Number(v);
          return Number.isFinite(n) && n >= 16 && n <= 16384 ? Math.round(n) : fallback;
        };
        const srcW = Number(meta.width) || px(b.srcWidth, 1920);
        const srcH = Number(meta.height) || px(b.srcHeight, 1080);
        /* ⚠ NOT `clipTimes` — that map holds how long the RENDER took, which is
         * unrelated to how long the clip plays and is often much larger. Using
         * it here costed a 5-second clip as 99 seconds of video and refused it.
         *
         * Order of trust: the length the clip was rendered at, then the real
         * duration the client read off the <video> element it is already
         * showing, then a conservative default. The client value is clamped
         * rather than believed — it decides how much memory we predict, and a
         * request that skipped the UI must not be able to talk its way past
         * the ceiling by claiming a clip is half a second long. */
        const hinted = Number(b.seconds);
        const srcS = Number(meta.clipSeconds)
          || (Number.isFinite(hinted) ? Math.min(Math.max(hinted, 0.5), 600) : 0)
          || 20;

        /* The one failure this feature can produce that a user cannot diagnose:
         * a 4x upscale holds every frame at full size, and 20 GB of float32 is
         * not a VRAM problem that tiling solves — it is the batch itself. Refuse
         * it here, with the number, rather than letting ComfyUI die at 90%. */
        const scale = want.up ? (Number(b.scale) || 2) : 1;
        const cost = enhanceCost({
          width: srcW, height: srcH, seconds: srcS,
          fps: 24, multiplier: want.interp ? mult : 1, scale,
        });
        if (cost.peakBytes > enhanceLimitBytes()) {
          return json(res, 400, {
            error: `That would need about ${(cost.peakBytes / 1e9).toFixed(0)} GB of memory `
                 + `(${cost.frames} frames at ${cost.width}x${cost.height}), and this machine can `
                 + `safely give about ${(enhanceLimitBytes() / 1e9).toFixed(0)} GB. Try 2x, or a shorter clip.`,
          });
        }

        const job = art.request({
          file: name, title: name, kind: "enhance", force: true,
          video: {
            interpolate: want.interp
              ? { model: String(b.interpModel || "rife_v4.26.safetensors"), multiplier: mult, slow }
              : null,
            upscale: want.up
              ? { model: String(b.upscaleModel || "RealESRGAN_x2.pth"), label: `${scale}x`, scale }
              : null,
            keepAudio: b.keepAudio !== false,
            // Only used to size the timeout — see #enhance.
            srcWidth: srcW, srcHeight: srcH, srcSeconds: srcS,
          },
        });
        return json(res, 200, { ok: true, job: job && { id: job.id }, cost, ...art.status() });
      }

      if (b.action !== "trash") return json(res, 400, { error: "Unknown action." });
      const name = String(b.name || "");
      if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
        return json(res, 400, { error: "bad name" });
      }
      const src = path.join(CLIP_DIR, name);
      const dir = path.join(config.outputDir, "trash");
      try {
        await stat(src);
        await mkdir(dir, { recursive: true });
        await rename(src, path.join(dir, name));
      } catch (err) {
        return json(res, 400, { error: `Could not move it: ${err.message}` });
      }
      // Drop the sidecar link too, or the song panel keeps showing a dead player.
      for (const [file, m] of library.meta.entries()) {
        if (m.clip === name) library.remember(file, { clip: null, clipSeconds: null, clipMeta: null });
      }
      clipTimes.delete(name);
      clipMeta.delete(name);
      saveClipStore();
      return json(res, 200, { ok: true });
    }

    /** Timed lyrics — the setting and the manual trigger. */
    if (p === "/api/lyrics" && req.method === "POST") {
      const b = await readBody(req);
      if (b.action === "when") {
        if (!["off", "all", "starred", "liked"].includes(b.value)) {
          return json(res, 400, { error: "Must be off, all, starred or liked." });
        }
        config.lyrics.when = b.value;
        savePrefs();
        return json(res, 200, { ok: true, lyrics: config.lyrics });
      }
      if (b.action === "run") {
        const file = String(b.file || "");
        if (!file || file.includes("..") || file.includes("/") || file.includes("\\")) {
          return json(res, 400, { error: "bad file" });
        }
        const m = library.meta.get(file) || {};
        // Recover the words from the file itself when the sidecar predates them
        // — they were written into the tags at generation time.
        let lyr = (m.lyrics || "").trim();
        if (!lyr) {
          const found = await library.readTags(file);
          lyr = (found?.lyrics || "").trim();
          if (lyr) library.remember(file, { lyrics: lyr });
        }
        if (!lyr) return json(res, 400, { error: "This track has no lyrics to time." });
        art.request({ file, title: m.title, kind: "lrc", lyrics: lyr, force: true });
        return json(res, 200, { ok: true, ...art.status() });
      }
      return json(res, 400, { error: "Unknown action." });
    }

    // The LRC files themselves, as plain text so they can be opened or copied.
    if (p.startsWith("/api/lrc/")) {
      const name = decodeURIComponent(p.slice("/api/lrc/".length));
      if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
        return json(res, 400, { error: "bad name" });
      }
      try {
        const data = await readFile(path.join(LRC_DIR, name));
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": data.length });
        return res.end(data);
      } catch {
        return json(res, 404, { error: "no lrc" });
      }
    }

    // Video clips. Range support, because these DO get scrubbed in a player.
    if (p.startsWith("/api/clip/")) {
      const name = decodeURIComponent(p.slice("/api/clip/".length));
      if (!name || name.includes("..") || path.isAbsolute(name)) {
        return json(res, 400, { error: "bad name" });
      }
      const full = path.join(CLIP_DIR, name);
      let size;
      try { size = (await stat(full)).size; } catch { return json(res, 404, { error: "no clip" }); }
      /* ⚠ Driven by the EXTENSION, not assumed to be video.
       *
       * This route used to answer video/mp4 for anything that was not .webm,
       * which was true while the folder only ever held generated clips. Imports
       * put audio and stills in the same folder, and a PNG served as video/mp4
       * simply does not render in an <img>. */
      const MIME = {
        ".webm": "video/webm", ".mp4": "video/mp4", ".mov": "video/quicktime",
        ".mkv": "video/x-matroska", ".m4v": "video/mp4",
        ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac",
        ".ogg": "audio/ogg", ".opus": "audio/ogg", ".m4a": "audio/mp4",
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".webp": "image/webp", ".gif": "image/gif",
      };
      const base = {
        "Content-Type": MIME[path.extname(name).toLowerCase()] || "application/octet-stream",
        "Accept-Ranges": "bytes",
      };
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = Math.min(m[2] ? Number(m[2]) : size - 1, size - 1);
        if (start > end || start >= size) {
          res.writeHead(416, { ...base, "Content-Range": `bytes */${size}` });
          return res.end();
        }
        res.writeHead(206, { ...base, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
        return createReadStream(full, { start, end }).pipe(res);
      }
      res.writeHead(200, { ...base, "Content-Length": size });
      return createReadStream(full).pipe(res);
    }

    // Stem audio. Same range-free simple serve as covers — these are opened in an
    // editor rather than scrubbed in the browser.
    if (p.startsWith("/api/stem/")) {
      const name = decodeURIComponent(p.slice("/api/stem/".length));
      if (!name || name.includes("..") || path.isAbsolute(name)) {
        return json(res, 400, { error: "bad name" });
      }
      const full = path.join(config.outputDir, "stems", name);
      try {
        const s = await stat(full);
        res.writeHead(200, { "Content-Type": "audio/flac", "Content-Length": s.size });
        return createReadStream(full).pipe(res);
      } catch {
        return json(res, 404, { error: "no stem" });
      }
    }

    // Cover images. Served from their own folder rather than the output root so
    // the library scan never has to filter them out of the track listing.
    if (p.startsWith("/api/cover/")) {
      const name = decodeURIComponent(p.slice("/api/cover/".length));
      if (!name || name.includes("..") || path.isAbsolute(name)) {
        return json(res, 400, { error: "bad name" });
      }
      const full = path.join(COVER_DIR, name);
      try {
        const s = await stat(full);
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": s.size,
          // Covers are immutable once drawn; regenerating writes a new seed.
          "Cache-Control": "public, max-age=86400",
        });
        return createReadStream(full).pipe(res);
      } catch {
        return json(res, 404, { error: "no cover" });
      }
    }

    // Files are generated locally, so "download" would just duplicate them. Reveal
    // the real file in Explorer instead.
    if (p === "/api/reveal" && req.method === "POST") {
      const body = await readBody(req);
      // Clips live in a subfolder, so they need their own root rather than a
      // path the caller supplies — which would be a traversal waiting to happen.
      const name = String(body.clip || body.image || body.file || "");
      if (!name || name.includes("..") || path.isAbsolute(name)) return json(res, 400, { error: "bad file" });
      // Each kind names its own root. The caller never supplies a path — that
      // would be a traversal waiting to happen.
      const full = body.clip ? path.join(CLIP_DIR, name)
        : body.image ? path.join(IMAGE_DIR, name)
        : path.join(config.outputDir, name);
      spawn("explorer.exe", ["/select,", full], { detached: true, stdio: "ignore" }).unref();
      return json(res, 200, { ok: true, path: full });
    }

    // Waveform peaks, computed here rather than in the browser. Chrome's FLAC
    // support in decodeAudioData is unreliable, and when it fails the editor sits
    // on "reading audio…" with no way forward. PyAV decodes it every time.
    /**
     * The beat grid, and the audio-reactive envelopes that go with it.
     *
     * Cached ON DISK rather than in memory, unlike `/api/peaks/`. Three and a
     * half seconds of CPU for a three-minute track is cheap once and irritating
     * on every reload, and the Studio asks for this the moment a song is
     * dropped on the timeline. A track never changes after it is rendered, so
     * the cache never needs invalidating — the file's own mtime guards the one
     * case that could (an edit that rewrote it in place).
     */
    if (p.startsWith("/api/beats/")) {
      const name = decodeURIComponent(p.slice("/api/beats/".length));
      if (!name || name.includes("..") || path.isAbsolute(name)) return json(res, 400, { error: "bad file" });
      const src = path.join(config.outputDir, name);
      const st = await stat(src).catch(() => null);
      if (!st) return json(res, 404, { error: "no such track" });

      const cacheDir = path.join(config.outputDir, ".beats");
      const cacheFile = path.join(cacheDir, `${name}.json`);
      try {
        const hit = JSON.parse(await readFile(cacheFile, "utf-8"));
        // Re-analyse if the audio was replaced under the same name.
        if (hit.srcMtime === Math.round(st.mtimeMs)) return json(res, 200, hit);
      } catch { /* not analysed yet, or the cache is unreadable */ }

      const r = await new Promise((resolve) => {
        const proc = spawn(config.python, [path.join(__dirname, "..", "scripts", "beats.py"), src]);
        let so = "", se = "";
        proc.stdout.on("data", (d) => (so += d));
        proc.stderr.on("data", (d) => (se += d));
        proc.on("exit", (code) => resolve({ code, so, se }));
        proc.on("error", () => resolve({ code: 1, so: "", se: "spawn failed" }));
      });
      let body;
      try { body = JSON.parse(r.so); } catch { return json(res, 500, { error: r.se.slice(-200) || "beat analysis failed" }); }
      if (body.error) return json(res, 500, body);

      body.srcMtime = Math.round(st.mtimeMs);
      try {
        await mkdir(cacheDir, { recursive: true });
        await writeFile(cacheFile, JSON.stringify(body));
      } catch { /* an uncacheable answer is still an answer */ }
      return json(res, 200, body);
    }

    if (p.startsWith("/api/peaks/")) {
      const name = decodeURIComponent(p.slice("/api/peaks/".length));
      if (!name || name.includes("..") || path.isAbsolute(name)) return json(res, 400, { error: "bad file" });
      const cached = peakCache.get(name);
      if (cached) return json(res, 200, cached);
      const r = await new Promise((resolve) => {
        const proc = spawn(config.python, [path.join(__dirname, "peaks.py"), path.join(config.outputDir, name), "1200"]);
        let so = "", se = "";
        proc.stdout.on("data", (d) => (so += d));
        proc.stderr.on("data", (d) => (se += d));
        proc.on("exit", (code) => resolve({ code, so, se }));
        proc.on("error", () => resolve({ code: 1, so: "", se: "spawn failed" }));
      });
      if (r.code !== 0) return json(res, 500, { error: r.se.slice(-200) || "peaks failed" });
      let body;
      try { body = JSON.parse(r.so); } catch { return json(res, 500, { error: "bad peaks output" }); }
      peakCache.set(name, body);
      if (peakCache.size > 60) peakCache.delete(peakCache.keys().next().value);
      return json(res, 200, body);
    }

    /**
     * Audio, with HTTP range support.
     *
     * This used to answer every request with a plain 200 and the whole file. A
     * browser will not seek a resource that does not advertise `Accept-Ranges`:
     * setting `currentTime` made Chrome re-request from byte zero, so clicking
     * the progress bar restarted the track instead of scrubbing to that point.
     * Range replies are what make the scrubber work at all.
     */
    if (p.startsWith("/api/audio/")) {
      const name = decodeURIComponent(p.slice("/api/audio/".length));
      if (name.includes("..") || path.isAbsolute(name)) return json(res, 400, { error: "bad name" });
      const full = path.join(config.outputDir, name);

      let size;
      try { size = (await stat(full)).size; } catch { return json(res, 404, { error: "not found" }); }
      const type = MIME[path.extname(name)] || "application/octet-stream";
      const base = { "Content-Type": type, "Accept-Ranges": "bytes" };

      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
      if (m) {
        // An open-ended "bytes=N-" is the common case while scrubbing.
        let start = m[1] ? Number(m[1]) : 0;
        let end = m[2] ? Number(m[2]) : size - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
          res.writeHead(416, { ...base, "Content-Range": `bytes */${size}` });
          return res.end();
        }
        end = Math.min(end, size - 1);
        res.writeHead(206, {
          ...base,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Content-Length": end - start + 1,
        });
        if (req.method === "HEAD") return res.end();
        return createReadStream(full, { start, end }).pipe(res);
      }

      res.writeHead(200, { ...base, "Content-Length": size });
      if (req.method === "HEAD") return res.end();
      return createReadStream(full).pipe(res);
    }

    // ---- static ---------------------------------------------------------
    const file = p === "/" ? "index.html" : p.replace(/^\//, "");
    if (file.includes("..")) return json(res, 400, { error: "bad path" });
    const full = path.join(WEB, file);
    const data = await readFile(full);
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
    res.end(data);
  } catch (err) {
    if (err.code === "ENOENT") return json(res, 404, { error: "not found" });
    console.error(err);
    return json(res, 500, { error: String(err.message || err) });
  }
});

// Push job state to the UI so progress is live rather than polled.
const wss = new WebSocketServer({ server, path: "/live" });
function push(snap) {
  const msg = JSON.stringify({ type: "state", ...snap, ...batch.status() });
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "state", ...jobs.snapshot(), ...batch.status() }));
});
jobs.on("update", push);
// A batch transition is not always a job transition -- pausing, finishing the
// last song -- so the runner gets its own push.
batch.on("update", () => push(jobs.snapshot()));

server.listen(config.uiPort, "127.0.0.1", async () => {
  console.log(`\n  AIPLAY Studio  →  http://127.0.0.1:${config.uiPort}\n`);

  /* Open the browser HERE, not in the launcher.
   *
   * The .cmd used to run `start "" http://127.0.0.1:4173` on the line BEFORE
   * `node server/index.js`, so it aimed the browser at a port nothing was
   * listening on yet. Node's own startup is enough to lose that race, and what
   * the user sees is ERR_CONNECTION_REFUSED while the black window looks
   * perfectly healthy -- which reads as "this is broken", not "refresh in a
   * second". The launcher sets AIPLAY_OPEN=1; anything else driving this server
   * (tests, headless runs, a restart in place) leaves it unset and keeps its
   * browser to itself. */
  if (process.env.AIPLAY_OPEN === "1") {
    spawn("cmd", ["/c", "start", "", `http://127.0.0.1:${config.uiPort}`],
      { detached: true, stdio: "ignore", windowsHide: true }).unref();
  }

  await library.load();
  // Clip provenance, so a clip you liked is still reusable after a restart.
  await loadClipStore();
  console.log(`  library: ${(await library.list()).length} tracks on disk`);
  await batch.load();
  const b = batch.status().run;
  if (b) console.log(`  batch "${b.name}": ${b.done}/${b.total} done, ${b.state}`);
  console.log("  starting the engine (one long-lived ComfyUI process)…");
  try {
    /* Launch with the tier the user last chose. ComfyUI reads these flags at
     * process start, so this has to happen BEFORE start() — setTier exists to
     * change it afterwards, and restarts the engine to do so. */
    if (config.tier !== "auto" && config.vramTiers[config.tier]) {
      comfy.tier = config.tier;
      comfy.flags = config.vramTiers[config.tier].flags;
    }
    await comfy.start();
    const check = comfy.assertBackend();
    if (!check.ok) {
      console.error(`\n  ⚠  ${check.message}\n     ${check.fix}\n`);
    } else {
      console.log(`  engine ready — torch ${check.torch}, fused CUDA kernels active`);
      console.log(`  ${config.sampling.sampler} · shift ${config.sampling.shift} · ${config.sampling.steps} steps\n`);
    }
    jobs.emit("update", jobs.snapshot());
  } catch (err) {
    console.error(`\n  engine failed to start: ${err.message}\n`);
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    console.log("\n  shutting the engine down…");
    await comfy.stop();
    process.exit(0);
  });
}
