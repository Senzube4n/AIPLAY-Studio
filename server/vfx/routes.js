/**
 * VFX — HTTP routes, mounted at /api/vfx.
 *
 * ┌─ FOR THE INTEGRATOR ───────────────────────────────────────────────────┐
 * │ Three lines in server/index.js, nothing else:                          │
 * │                                                                        │
 * │  1. beside the other imports:                                          │
 * │     import { createVfxRoutes } from "./vfx/routes.js";                 │
 * │                                                                        │
 * │  2. beside the other runners (after `art` and the DIR consts exist):   │
 * │     const vfxRoutes = createVfxRoutes({ json, readBody, config,        │
 * │                                         IMAGE_DIR, CLIP_DIR, art });   │
 * │                                                                        │
 * │  3. first thing inside the request handler's `try`:                    │
 * │     if (p === "/api/vfx" || p.startsWith("/api/vfx/")) {               │
 * │       if (await vfxRoutes(req, res, url)) return; }                    │
 * │                                                                        │
 * │ PROJECT_DIR and spawnPython are accepted too but default to exactly    │
 * │ what index.js already computes, so passing them is optional.           │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * One action-dispatched POST plus five GETs, the shape /api/mv already uses, so
 * this is one insert into the route table rather than twenty-five.
 *
 * EVERY capability here is reachable from MCP too (server/mcp-vfx.js), and both
 * surfaces call THESE routes. That is the rule that stops the agent path and the
 * GUI path drifting apart — the failure this app has been bitten by before is a
 * feature that works from one surface and silently does nothing from the other.
 *
 * SOURCES ARE LIBRARY NAMES. A layer's `src` is "raven.png", never a path, and
 * it is resolved to an absolute path only in the last breath before the comp is
 * handed to python. A client that could name a path could name any file on the
 * disk, and this server answers to a browser tab and to an agent.
 *
 * Dependencies are injected rather than imported so this file stays additive —
 * index.js owns the paths and the runners.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { stat, mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import {
  LIMITS, LAYER_TYPES, BLEND_MODES, MATTE_TYPES, MASK_MODES, TRANSFORM_ARITY, LABEL_COLORS,
  AUDIO_KINDS, AUDIO_LEVELS_RANGE, AUTO_ORIENT_MODES,
  LIGHT_KINDS, LIGHT_FALLOFFS, LIGHT_PROP_SPEC, LIGHT_KIND_PARAMS,
  MATERIAL_PROP_SPEC, UNSHADEABLE,
  listComps, readComp, createComp, updateComp, deleteComp,
  blankLayer, blankEffect, blankMask, newId, noteRun,
  compDir, previewDir, findLayer, pickEffect, wouldCycle,
  resolvePropPath, normalizeKeys, normalizeValue, normalizeEase,
  isKeyed, hasExpr, isAnimated, layerProperties, arityOf, evalProp, clamp, clampInt,
  readFxPresets, updateFxPresets, shiftPropTimes, pastePresetKeys, FX_PRESET_LIMITS,
} from "./store.js";
import { getTemplate, buildTemplate, sourcesOf, listTemplates } from "./templates.js";
import { buildFretboardRig, buildPianoRig } from "./rigs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(__dirname, "engine.py");
const AUDIOKEYS = path.join(__dirname, "audiokeys.py");
const NOTES = path.join(__dirname, "notes.py");
const TRACKER = path.join(__dirname, "tracker.py");
const VIEWPORT = path.join(__dirname, "viewport.py");

/** Forward slashes everywhere in the job file — python on Windows is happier. */
const fwd = (p) => String(p).replace(/\\/g, "/");

const NO_ENGINE =
  "The VFX engine is not installed yet (server/vfx/engine.py is missing). "
  + "Comps, layers, keyframes and effects can all be built and edited without it — "
  + "only previewing and rendering need it.";

/* Every live serve child, across however many factories this process built
 * (the tests build several) — so ONE process-exit hook can sweep them all.
 * index.js's SIGINT/SIGTERM handlers end in process.exit(0), and 'exit' is the
 * event that still fires on that path; a hard kill of the server skips it, and
 * is covered anyway, because the child's stdin hits EOF when this process dies
 * and serve() exits on EOF by contract. Both doors close; no zombie python. */
const SERVE_CHILDREN = new Set();
let serveExitHooked = false;
function hookServeExit() {
  if (serveExitHooked) return;
  serveExitHooked = true;
  process.on("exit", () => {
    for (const p of SERVE_CHILDREN) {
      try { p.kill(); } catch { /* already gone */ }
      /* The venv stub-launcher case (see laneDrop): the detached taskkill is
       * created before exit completes and finishes the tree on its own. */
      if (process.platform === "win32" && p.pid) {
        try {
          spawn("taskkill", ["/PID", String(p.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore", detached: true }).unref();
        } catch { /* taskkill missing is not worth a crash */ }
      }
    }
  });
}

/* ──────────────────────────────────────────────── the preview cache budget */

/**
 * RAM preview, in the sense After Effects means it.
 *
 * Playback used to be one on-demand render plus one HTTP round trip PER FRAME —
 * measured at 262 ms on a 1280×720 comp with two glows and a mask, which is
 * 3.8 fps and no amount of renderer tuning turns that into 30. The fix is not a
 * faster render, it is not rendering: pre-render the work area, hold the frames,
 * play them back.
 *
 * Two tiers, because they fail differently. The disk tier survives a restart and
 * is the one that already existed. The RAM tier is bytes — the disk hit is still
 * a stat, an open, a read and a stream, and at 30 fps the player asks for one
 * every 33 ms; holding the PNG collapses that to a single socket write.
 *
 * Both caps are env-settable because the right number is a property of the comp,
 * not of the app: 1080p text frames run ~300 KB, a photographic plate ten times
 * that. The caps are REPORTED in the manifest — a cache that quietly holds less
 * than the UI's progress bar claims is worse than a slow one.
 */
const MB = 1024 * 1024;
const envInt = (name, def, lo, hi) => {
  const n = Number(process.env[name]);
  return Math.round(Math.min(Math.max(Number.isFinite(n) && n > 0 ? n : def, lo), hi));
};
const RAM_CAP = envInt("AIPLAY_VFX_RAM_MB", 512, 16, 8192) * MB;
const DISK_CAP = envInt("AIPLAY_VFX_DISK_MB", 3072, 64, 200_000) * MB;
/* 900 frames is 30 s at 30 fps — the range anyone actually loops. It was 120,
 * which is four seconds and would have evicted a prewarm while it ran. */
const DISK_KEEP = envInt("AIPLAY_VFX_DISK_FRAMES", 900, 60, 20_000);
/* One frame bigger than a quarter of the budget is a 4K plate, not a preview.
 * It streams off disk rather than evicting fifty useful frames to hold itself. */
const RAM_MAX_FRAME = Math.min(32 * MB, Math.floor(RAM_CAP / 4));

/**
 * The on-disk name and the cache key agree on ONE quantisation of t.
 *
 * They used not to: the key held the raw float and the filename held rounded
 * milliseconds, so t=0.03333333 and t=0.03333334 were two keys pointing at one
 * file — two pythons racing to write the same path, both counted as misses.
 * Rounding in a single place fixes that race and is what lets the RAM tier, the
 * disk tier and the manifest agree on which frame is which.
 *
 * Invalidation is untouched. The stamp is still the comp's `updatedAt` and is
 * still the first thing after the slug, so a frame made before an edit can
 * never be looked up after one.
 */
const frameName = (stamp, ms, sc, draft, vtok = "") =>
  `f_${stamp}_${ms}_${sc}${draft ? "d" : ""}${vtok ? `_${vtok}` : ""}.png`;
/* Group 5 is the VIEW token — absent means the active camera, which is also
 * what every pre-view file on disk means, so old caches stay readable. */
const FRAME_RE = /^f_([0-9a-z]+)_(\d+)_(\d+)(d?)(?:_([a-z0-9-]+))?\.png$/;

/* ─────────────────────────────────────────────── the waveform peaks cache
 *
 * Same naming discipline as frameName — one prefix, underscore-separated key
 * parts, one regex that both the lookup and the prune read — but a DIFFERENT
 * key on purpose: peaks are derived from the SOURCE FILE ALONE, so the key is
 * (source path, source mtime, bins) and the comp's `updatedAt` is nowhere in
 * it. That is the point of the sidecar: retiming a layer, adding a keyframe,
 * renaming the comp — none of it invalidates a waveform, because none of it
 * changes what the file sounds like. Only the file being rewritten (new
 * mtime) or a different resolution being asked for computes again.
 *
 * One shared directory rather than per-comp preview dirs, for the same
 * reason: the same song under three comps is one envelope, and it outlives
 * any one comp's deletion. The mtime token doubles as the invalidation:
 * a stale-mtime sibling is deleted on the next write, and the count cap
 * (oldest first, prunePreviews' own rule) keeps the directory bounded.
 */
const PEAKS_RE = /^p_([0-9a-f]{12})_([0-9a-z-]+)_(\d+)\.json$/;
const PEAKS_KEEP = 400;                       // ~a few MB of JSON at worst
const peaksName = (hash, mtok, bins) => `p_${hash}_${mtok}_${bins}.json`;
const peaksHash = (full) => createHash("sha1").update(String(full)).digest("hex").slice(0, 12);
/* mtimeMs can be fractional; floor it so the token is stable across stats. */
const peaksMtok = (st) => Math.floor(st.mtimeMs).toString(36);

/* ─────────────────────────────────────────────── the transcription cache
 *
 * The peaks discipline exactly, and for the peaks REASON: a transcription is
 * derived from the SOURCE FILE ALONE, so the key is (source path, source
 * mtime, profile) and no comp's `updatedAt` appears in it. Retiming a layer,
 * building a second rig from the same stem, deleting the comp that asked
 * first — none of it changes what the file's notes are. Only a rewritten
 * source (new mtime) or a different stem profile (guitar hears 60-2000 Hz,
 * bass 30-400) computes again — which matters more here than for peaks,
 * because a transcription costs seconds of model inference, not milliseconds
 * of min/max.
 *
 * Fingering is NOT in the key and NOT in the sidecar: it depends on the
 * caller's tuning and fret count, and recomputing it from cached notes is a
 * fast pure-python pass (notes.py mode "fingering") that never wakes the
 * model. */
const NOTES_RE = /^n_([0-9a-f]{12})_([0-9a-z-]+)_([a-z]+)\.json$/;
const NOTES_KEEP = 200;
const notesName = (hash, mtok, profile) => `n_${hash}_${mtok}_${profile}.json`;

/* ─────────────────────────────────────────────── custom 3D views, §engine
 *
 * A view override renders the comp from a synthetic camera — Front, Top,
 * Right, or a custom orbit — instead of the active one. engine.view_camera
 * owns the geometry; this side owns two things only: PARSING the caller's
 * spec into one canonical object, and making sure the view is part of the
 * FRAME CACHE KEY. The cache is keyed slug|updatedAt|t|scale|draft, and a
 * render-affecting parameter that is not in the key poisons the cache
 * silently — the Top view would come back as last week's Front frame and
 * nothing would error.
 */
const VIEW_NAMES = ["front", "back", "top", "bottom", "left", "right", "orbit"];

/** Caller spec (string or object, snake or not) -> canonical view, or null
 *  for the active camera. Throws on a name that is not a view. */
function viewOf(raw, params = null) {
  const src = params
    ? { name: params.get("view"), yaw: params.get("yaw"), pitch: params.get("pitch"),
        distance: params.get("distance"), zoom: params.get("vzoom") }
    : (typeof raw === "string" ? { name: raw } : (raw || {}));
  const name = String(src.name ?? "").trim().toLowerCase();
  if (!name || name === "active" || name === "camera") return null;
  if (!VIEW_NAMES.includes(name)) {
    throw new Error(`No view called "${name}". Views: active (the comp's own camera), ${VIEW_NAMES.join(", ")}.`);
  }
  const numOr = (v, def, lo, hi) => {
    if (v === undefined || v === null || v === "") return def;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`view.${name === "orbit" ? "yaw/pitch/" : ""}distance/zoom must be numbers.`);
    return Math.min(Math.max(n, lo), hi);
  };
  const view = { name };
  if (name === "orbit") {
    view.yaw = numOr(src.yaw, 30, -360, 360);
    view.pitch = numOr(src.pitch, -25, -89, 89);
  }
  const d = numOr(src.distance, 0, 0, 1e6);
  const z = numOr(src.zoom, 0, 0, 1e5);
  if (d > 0) view.distance = d;
  if (z > 0) view.zoom = z;
  return view;
}

/** The view as a filename- and cache-key-safe token. "" = active camera. */
function viewToken(view) {
  if (!view) return "";
  const n = (v) => String(Math.round(v * 10) / 10).replace("-", "m").replace(".", "p");
  let tok = view.name;
  if (view.name === "orbit") tok += `-y${n(view.yaw)}-p${n(view.pitch)}`;
  if (view.distance) tok += `-d${n(view.distance)}`;
  if (view.zoom) tok += `-z${n(view.zoom)}`;
  return tok;
}

/**
 * The canonical time grid: t = i / fps, phase-locked to the START OF THE COMP.
 *
 * Prewarm, the manifest and the player have to name the same instants or every
 * prewarmed frame lands a millisecond away from the one the player asks for and
 * the whole cache reads as a miss. A prewarm's `from` is SNAPPED onto this grid
 * rather than being allowed to define its own phase.
 */
const gridMs = (i, fps) => Math.round((i * 1000) / fps);

/**
 * Read CATALOG straight out of effects.py.
 *
 * §4 gives engine.py three modes and none of them is "catalog", so rather than
 * inventing a fourth mode for another agent to implement, this imports the
 * module the spec already names. Both import shapes are tried — `effects` as a
 * top-level module and `vfx.effects` as a package member — because which one
 * works depends on whether effects.py uses relative imports, and that is the
 * effects author's call, not ours.
 */
const CATALOG_PROG = [
  "import json,sys,os",
  `d = ${JSON.stringify(__dirname)}`,
  "sys.path.insert(0, d)",
  "sys.path.insert(0, os.path.dirname(d))",
  "try:",
  "    from vfx.effects import CATALOG",
  "except Exception:",
  "    from effects import CATALOG",
  "print(json.dumps(CATALOG))",
].join("\n");

const SHAPES_PROG = [
  "import json,sys,os",
  `d = ${JSON.stringify(__dirname)}`,
  "sys.path.insert(0, d)",
  "sys.path.insert(0, os.path.dirname(d))",
  "try:",
  "    from vfx.shapes import CATALOG",
  "except Exception:",
  "    from shapes import CATALOG",
  "print(json.dumps(CATALOG))",
].join("\n");

/* Runs one of shapes.py's constructors and prints the layer it builds. The
 * name is checked against a fixed set on the JS side before it ever reaches
 * here, so this interpolates a keyword, never caller text. */
const LIGHTS_PROG = [
  "import json,sys,os",
  `d = ${JSON.stringify(__dirname)}`,
  "sys.path.insert(0, d)",
  "sys.path.insert(0, os.path.dirname(d))",
  "try:",
  "    from vfx.lights import catalog",
  "except Exception:",
  "    from lights import catalog",
  "print(json.dumps(catalog()))",
].join("\n");

const SHAPE_PRESET_PROG = (fn, kwargs) => [
  "import json,sys,os",
  `d = ${JSON.stringify(__dirname)}`,
  "sys.path.insert(0, d)",
  "sys.path.insert(0, os.path.dirname(d))",
  "try:",
  `    from vfx.shapes import ${fn}`,
  "except Exception:",
  `    from shapes import ${fn}`,
  `print(json.dumps(${fn}(**json.loads(${JSON.stringify(JSON.stringify(kwargs))}))))`,
].join("\n");

export function createVfxRoutes(deps) {
  const { json, readBody, config, IMAGE_DIR, CLIP_DIR, art } = deps;
  const PROJECT_DIR = deps.PROJECT_DIR ?? path.join(config.outputDir, "projects");
  /* The provenance ledger (server/provenance.js), injected like everything
   * else so the tests that build this factory bare keep working. Optional:
   * every use below is guarded, and a ledger failure never fails a render. */
  const prov = deps.provenance ?? null;
  const provNote = (scope, evt) => {
    if (!prov) return;
    prov.append(scope, evt).catch((err) =>
      console.error(`  [provenance] event lost (${evt?.type}/${evt?.asset}): ${err.message}`));
  };
  const spawnPython = deps.spawnPython
    ?? ((args, opts = {}) => spawn(config.python, args, { windowsHide: true, ...opts }));

  /* ────────────────────────────────────────────── small, shared validators */

  /** Names come from a browser or a model, so nothing is trusted as a path. */
  const safe = (v) => {
    const s = path.basename(String(v ?? ""));
    return s && !s.includes("..") ? s : null;
  };
  const need = (v, what) => {
    const s = safe(v);
    if (!s) throw new Error(`Give a ${what}.`);
    return s;
  };
  function inRange(v, lo, hi, label) {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${label} must be a number.`);
    if (n < lo || n > hi) throw new Error(`${label} must be between ${lo} and ${hi} — got ${n}.`);
    return n;
  }
  const rgbaOf = (v, label) => {
    if (!Array.isArray(v) || v.length !== 4) throw new Error(`${label} takes four numbers, [r,g,b,a] 0-255.`);
    return v.map((n) => inRange(n, 0, 255, label));
  };

  /* ─────────────────────────────────────────────────────── the python side */

  /**
   * Run one engine mode and read its last stdout line, §4.
   *
   * Progress lines arrive before the result line, so stdout is consumed a line
   * at a time rather than buffered whole — a 4-minute render that only reports
   * itself at the end is a render nobody can tell apart from a hang.
   */
  async function runJob(script, mode, argvOf, job, { timeoutMs = 15 * 60_000, onProgress = null } = {}) {
    try { await stat(script); } catch { throw new Error(script === ENGINE ? NO_ENGINE : `${path.basename(script)} is not installed.`); }

    const dir = path.join(config.outputDir, "vfx");
    await mkdir(dir, { recursive: true });
    const jobPath = path.join(dir, `.job_${mode}_${Date.now().toString(36)}_${randomUUID().slice(0, 4)}.json`);
    await writeFile(jobPath, JSON.stringify(job), "utf8");

    try {
      const line = await new Promise((resolve, reject) => {
        const proc = spawnPython(argvOf(jobPath));
        let buf = "", last = "", err = "", timedOut = false;
        const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);

        proc.stdout.on("data", (d) => {
          buf += d;
          const lines = buf.split(/\r?\n/);
          buf = lines.pop();
          for (const raw of lines) {
            const s = raw.trim();
            if (!s) continue;
            last = s;
            if (onProgress && s.includes('"progress"')) {
              try {
                const j = JSON.parse(s);
                if (Number.isFinite(j.progress)) onProgress(j);
              } catch { /* a malformed progress line is not a failed render */ }
            }
          }
        });
        proc.stderr.on("data", (d) => { err += d; });
        proc.on("error", (e) => {
          clearTimeout(timer);
          reject(new Error(`Could not start python (${config.python}): ${e.message}`));
        });
        proc.on("close", (code) => {
          clearTimeout(timer);
          const tail = buf.trim() || last;
          if (timedOut) { reject(new Error(`The engine ran past ${Math.round(timeoutMs / 1000)}s and was stopped.`)); return; }
          if (code !== 0 && !tail) { reject(new Error(err.trim().slice(-400) || `engine exit ${code}`)); return; }
          resolve(tail);
        });
      });

      let r;
      try { r = JSON.parse(line); } catch {
        throw new Error(`${path.basename(script)} did not answer with JSON: ${String(line).slice(0, 200)}`);
      }
      // audiokeys/tracker report success by simply not setting ok:false, while
      // the engine always sets ok — so only an explicit false is a failure.
      if (r.ok === false) throw new Error(r.error || `${mode} failed`);
      return r;
    } finally {
      unlink(jobPath).catch(() => {});
    }
  }

  const runEngine = (mode, job, opts) =>
    runJob(ENGINE, mode, (jp) => [ENGINE, mode, jp], job, opts);

  /** audiokeys.py / tracker.py: one job file in, one JSON line out. */
  const runTool = (script, mode, job, opts) =>
    runJob(script, mode, (jp) => [script, jp], job, opts);

  /* ─────────────────────────────── the persistent engine — `serve` mode */

  /**
   * One long-lived `engine.py serve` child answering frame and probe jobs over
   * stdin — `{"id":…, "cmd":…, "job":{…}}` a line in, one JSON line back — so
   * the ~400 ms of interpreter + numpy/PIL/cv2/PyAV startup is paid once per
   * session instead of once per frame. Measured on this box before the change:
   * 425 ms wall per cold 320×200 preview frame, of which 28 ms was compositing.
   *
   * ONE CHILD, ONE FIFO QUEUE — not a pool. The decision, so nobody re-decides
   * it blind:
   *   · engine.py's caches (decoded footage, scaled rasters, text, masks — up
   *     to ~1.3 GB at the caps) live per process. N children means N cold
   *     caches and N× the memory; one warm child beats two cold ones for the
   *     scrub-latency this lane exists for.
   *   · the serve protocol is strictly serial (answers in order, and render's
   *     progress lines are only unambiguous with one job in flight), so a
   *     child IS a queue; a pool would buy parallelism only for concurrent
   *     COLD frames, which the prewarm already had to throttle for CPU's sake.
   *   · a frame is ~30–300 ms of numpy on cores the per-call path also shared;
   *     the win being bought here is the 400 ms spawn, and one child buys all
   *     of it.
   *
   * WHAT RIDES IT AND WHAT DOES NOT: `frame` and `probe` — short, latency
   * bound, startup-dominated. `render` stays on the per-call path: it runs for
   * minutes to hours (it would wedge the serial queue behind it), and its
   * startup is amortised over its own frames. audiokeys.py and tracker.py are
   * different scripts with no serve mode.
   *
   * CRASH RESILIENCE: a child that dies mid-job fails that job with a
   * transport-marked error, and runEngineFast retries it once on the per-call
   * path — which stays fully intact below, is what `render` uses, and is the
   * fallback whenever the child cannot be (re)started. A failed start puts the
   * lane in a cooldown so a broken venv degrades to per-call spawning, not to
   * a spawn attempt per frame. A TIMEOUT kills the child (a serial process
   * cannot abandon a job; a wedged frame must not wedge every job behind it)
   * and is NOT retried — the caller's time budget is already spent.
   *
   * WINDOWS FILE LOCKS: the child keeps video containers open between jobs,
   * and Windows will not rename or delete a file a process holds open — the
   * per-call path never had this problem because it died after every frame.
   * Three answers: engine.py re-stats every cached source between jobs (an
   * edited file is dropped and re-read, so the frame cache key logic is
   * unchanged); `releaseSources()` is exported on the handler for the routes
   * that move library files aside; and an idle child releases everything by
   * itself after IDLE_RELEASE with no jobs.
   *
   * AIPLAY_VFX_NO_SERVE=1 pins everything to the per-call path — the A/B
   * switch the numbers above were measured with.
   */
  const SERVE_DISABLED = process.env.AIPLAY_VFX_NO_SERVE === "1";
  const READY_PATIENCE = 30_000;       // cold numpy/cv2/PyAV imports, with margin
  const SERVE_COOLDOWN = 60_000;       // after a failed start: per-call until then
  const IDLE_RELEASE = 120_000;        // idle child lets go of every file handle

  const lane = {
    proc: null,               // the live child, once its ready line has been seen
    starting: null,           // in-flight spawn+handshake, so two jobs share one
    queue: Promise.resolve(), // FIFO — the protocol allows ONE job in flight
    seq: 0,
    brokenUntil: 0,
    idleTimer: null,
    stderrTail: "",
  };

  /** A failure of the LANE, not a verdict on the job — the caller may retry per-call. */
  const transport = (msg) => Object.assign(new Error(msg), { serveTransport: true });

  function laneDrop(proc) {
    if (lane.proc === proc) lane.proc = null;
    SERVE_CHILDREN.delete(proc);
    try { proc.kill(); } catch { /* already gone */ }
    /* On Windows the venv's python.exe is a stub launcher running the real
     * interpreter as ITS child; proc.kill() takes only the stub, and a wedged
     * frame would keep burning a core underneath it. Take the whole tree. */
    if (process.platform === "win32" && proc.pid) {
      try {
        spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" }).unref();
      } catch { /* taskkill missing is not worth a crash */ }
    }
  }

  function spawnServe() {
    return new Promise((resolve, reject) => {
      let proc;
      try { proc = spawnPython([ENGINE, "serve"]); } catch (err) {
        reject(transport(`could not start python (${config.python}): ${err.message}`)); return;
      }
      let buf = "", ready = false;
      const fail = (why) => {
        if (!ready) { ready = true; clearTimeout(bootTimer); reject(transport(why)); }
        laneDrop(proc);
      };
      const bootTimer = setTimeout(
        () => fail(`the serve child sent no ready line within ${READY_PATIENCE / 1000}s`),
        READY_PATIENCE);
      proc.on("error", (e) => fail(`could not start python (${config.python}): ${e.message}`));
      proc.on("close", (code) => {
        if (!ready) {
          fail(`the serve child exited (${code}) before it was ready: ${lane.stderrTail.slice(-300)}`);
          return;
        }
        const w = proc._waiter;
        proc._waiter = null;
        if (w) w.settle(null, transport(`the serve child died mid-job (exit ${code}): ${lane.stderrTail.slice(-300)}`));
        if (lane.proc === proc) lane.proc = null;
        SERVE_CHILDREN.delete(proc);
      });
      proc.stderr.on("data", (d) => { lane.stderrTail = (lane.stderrTail + d).slice(-2000); });
      proc.stdout.on("data", (d) => {
        buf += d;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const raw of lines) {
          const s = raw.trim();
          if (!s) continue;
          let j;
          try { j = JSON.parse(s); } catch { continue; }  // a stray print is not protocol
          if (j.ready && !ready) {
            ready = true;
            clearTimeout(bootTimer);
            lane.proc = proc;
            SERVE_CHILDREN.add(proc);
            hookServeExit();
            resolve(proc);
            continue;
          }
          const w = proc._waiter;
          if (w && j.id === w.id) { proc._waiter = null; w.settle(j, null); }
        }
      });
      /* The child must never hold this process's event loop open — a script
       * that builds these routes and finishes should exit, at which point the
       * child sees stdin EOF and exits too. unref only detaches bookkeeping;
       * data events still fire. */
      try {
        proc.unref();
        proc.stdin.unref?.(); proc.stdout.unref?.(); proc.stderr.unref?.();
      } catch { /* not every stdio object can */ }
    });
  }

  async function serveProc() {
    if (lane.proc && lane.proc.exitCode === null) return lane.proc;
    if (Date.now() < lane.brokenUntil) throw transport("the serve lane is cooling down after a failed start");
    if (!lane.starting) {
      lane.starting = spawnServe().then(
        (p) => { lane.starting = null; return p; },
        (err) => { lane.starting = null; lane.brokenUntil = Date.now() + SERVE_COOLDOWN; throw err; },
      );
    }
    return lane.starting;
  }

  /** One job over the wire. Only ever called with the queue's baton in hand. */
  async function serveOne(cmd, job, timeoutMs) {
    const proc = await serveProc();
    const id = ++lane.seq;
    const reply = await new Promise((resolve, reject) => {
      let done = false;
      const settle = (r, err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (proc._waiter && proc._waiter.id === id) proc._waiter = null;
        if (err) reject(err); else resolve(r);
      };
      const timer = setTimeout(() => {
        laneDrop(proc);   // serial child cannot abandon a job — the process goes with it
        settle(null, Object.assign(
          new Error(`The engine ran past ${Math.round(timeoutMs / 1000)}s and was stopped.`),
          { serveTimeout: true }));
      }, timeoutMs);
      proc._waiter = { id, settle };
      try {
        proc.stdin.write(JSON.stringify({ id, cmd, job }) + "\n");
      } catch (err) {
        laneDrop(proc);
        settle(null, transport(`could not write to the serve child: ${err.message}`));
      }
    });
    if (reply.ok === false) {
      /* fatal:true is the child announcing its own death (MemoryError) — a
       * fresh process may well manage the job, so to the caller it is a lane
       * failure. A plain refusal is a verdict: the per-call path would say
       * exactly the same words, so it is NOT retried. */
      if (reply.fatal) throw transport(`the serve child hit ${reply.error} and exited`);
      throw new Error(reply.error || `${cmd} failed`);
    }
    return reply;
  }

  /** Let go of every file the child holds open — before moving library files. */
  async function releaseSources() {
    if (lane.idleTimer) clearTimeout(lane.idleTimer);
    if (!lane.proc || lane.proc.exitCode !== null) return false;
    const p = lane.queue.then(() => (lane.proc ? serveOne("release", {}, 30_000) : null));
    lane.queue = p.then(() => {}, () => {});
    try { await p; return true; } catch { return false; }
  }

  function armIdleRelease() {
    if (lane.idleTimer) clearTimeout(lane.idleTimer);
    if (!lane.proc) return;
    lane.idleTimer = setTimeout(() => {
      if (!lane.proc || lane.proc.exitCode !== null) return;
      const p = lane.queue.then(() => (lane.proc ? serveOne("release", {}, 30_000) : null));
      lane.queue = p.then(() => {}, () => {});
    }, IDLE_RELEASE);
    lane.idleTimer.unref?.();
  }

  /**
   * The serve lane if it is willing, the per-call lane if it is not. Every
   * result carries `engine: "serve" | "spawn"` so the seam is observable from
   * the outside — the frame route reports it in `?meta=1`.
   */
  async function runEngineFast(mode, job, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
    if (!SERVE_DISABLED) {
      try {
        const p = lane.queue.then(() => serveOne(mode, job, timeoutMs));
        lane.queue = p.then(armIdleRelease, armIdleRelease);
        const r = await p;
        return { ...r, engine: "serve" };
      } catch (err) {
        if (err.serveTimeout) throw err;      // the time budget is spent — never pay it twice
        if (!err.serveTransport) throw err;   // an engine verdict, identical on either lane
        /* lane failure → this one job takes the per-call path below */
      }
    }
    const r = await runEngine(mode, job, opts);
    return { ...r, engine: "spawn" };
  }

  /**
   * The effects catalog, read once and kept.
   *
   * A SUCCESS is cached forever — the file cannot change under a running
   * server without a restart. A FAILURE is cached for thirty seconds only,
   * because the usual reason for one is that effects.py has not landed yet, and
   * a permanent negative would outlive the fix.
   */
  function makeCatalogReader(prog, sourceFile, what) {
    let catalogHit = null;
    let catalogMiss = 0;
    let catalogMissWhy = `The ${what} catalog is not readable yet.`;
    return async function readCatalog() {
      if (catalogHit) return catalogHit;
      if (Date.now() < catalogMiss) throw new Error(catalogMissWhy);
      try {
        const line = await new Promise((resolve, reject) => {
          const proc = spawnPython(["-c", prog]);
          let so = "", se = "";
          const timer = setTimeout(() => proc.kill(), 30_000);
          proc.stdout.on("data", (d) => { so += d; });
          proc.stderr.on("data", (d) => { se += d; });
          proc.on("error", (e) => { clearTimeout(timer); reject(new Error(`Could not start python: ${e.message}`)); });
          proc.on("close", (code) => {
            clearTimeout(timer);
            const tail = so.trim().split(/\r?\n/).pop();
            if (code !== 0 || !tail) reject(new Error(se.trim().slice(-300) || `exit ${code}`));
            else resolve(tail);
          });
        });
        catalogHit = JSON.parse(line);
        return catalogHit;
      } catch (err) {
        catalogMiss = Date.now() + 30_000;
        catalogMissWhy = `The ${what} catalog is not readable yet (${sourceFile}): ${err.message}`;
        throw new Error(catalogMissWhy);
      }
    };
  }

  const readCatalog = makeCatalogReader(CATALOG_PROG, "server/vfx/effects.py", "effects");
  const readShapeCatalog = makeCatalogReader(SHAPES_PROG, "server/vfx/shapes.py", "shapes");
  const readLightsCatalog = makeCatalogReader(LIGHTS_PROG, "server/vfx/lights.py", "lights");

  /** The catalog if it exists, null if it does not — for the paths that can cope. */
  const catalogOrNull = () => readCatalog().catch(() => null);
  /* The shape registry on the same terms: a catalog that will not load
   * costs LABELS and RANGES, never the answer — layer_properties still
   * lists the paths, which are what a caller actually needs to act. */
  const shapeCatalogOrNull = () => readShapeCatalog().catch(() => null);
  const lightsCatalogOrNull = () => readLightsCatalog().catch(() => null);

  /* ──────────────────────────────────────────────── sources → real files */

  /**
   * A copy of the comp with every source turned into an absolute path, §4.
   *
   * Disabled layers are skipped entirely: a hidden layer pointing at a file you
   * deleted last week is not a reason to refuse to render the nine that work.
   * Every enabled one must resolve, and the error names the layer, because
   * "file not found" against a 40-layer comp is not a message anyone can act on.
   */
  /** The engine's own ceiling; deeper than this it refuses anyway. */
  const MAX_COMP_DEPTH = 8;

  /**
   * Load every child comp a document reaches, keyed by slug, with their own
   * sources resolved. §1's `comps` library.
   *
   * A comp that reaches itself is loaded once and NOT flagged here: the engine
   * refuses it by name and can say which link closed the loop, which is a
   * better message than anything this function has the context to write.
   */
  async function resolveChildComps(rootDoc) {
    const lib = {};
    const seen = new Set();
    let frontier = [rootDoc];

    for (let depth = 0; depth < MAX_COMP_DEPTH && frontier.length; depth++) {
      const next = [];
      for (const doc of frontier) {
        for (const layer of doc.layers || []) {
          if (layer.enabled === false || layer.type !== "comp") continue;
          const slug = layer.src ? safe(layer.src) : null;
          if (!slug) {
            throw new Error(`"${layer.name}" (${layer.id}) is a comp layer with no comp to show. Set its src to a comp slug.`);
          }
          if (seen.has(slug)) continue;
          seen.add(slug);

          const child = await readComp(slug);
          if (!child) {
            throw new Error(`"${layer.name}" (${layer.id}) points at comp "${slug}", which does not exist.`);
          }
          // The child's OWN images and videos are library names too, and the
          // engine only ever sees absolute paths. Resolving it through the same
          // function is what makes nesting work at any depth.
          const resolved = await resolveComp(child);
          lib[slug] = resolved;
          next.push(resolved);
        }
      }
      frontier = next;
    }
    return lib;
  }

  /**
   * Where an audio layer's source lives: a song in the music library (the
   * output root) or a clip whose SOUND is wanted without its picture — the
   * same two-step walk audio_keys already does, for the same reason: "the
   * audio" can honestly be either, and making the caller know which is a
   * refusal nobody can act on.
   */
  async function audioSourcePath(name) {
    for (const dir of [config.outputDir, CLIP_DIR]) {
      const full = path.join(dir, name);
      try { await stat(full); return full; } catch { /* try the next home */ }
    }
    return null;
  }

  async function resolveComp(doc) {
    const out = JSON.parse(JSON.stringify(doc));
    const missing = [];
    for (const layer of out.layers) {
      if (layer.enabled === false) continue;
      if (layer.type === "audio") {
        const name = layer.src ? safe(layer.src) : null;
        if (!name) {
          missing.push(`"${layer.name}" (${layer.id}) is an audio layer with no source`);
          continue;
        }
        const full = await audioSourcePath(name);
        if (!full) {
          missing.push(`"${layer.name}" (${layer.id}): ${name} is not in the music library or the clips library`);
          continue;
        }
        layer.src = fwd(full);
        continue;
      }
      if (layer.type !== "image" && layer.type !== "video") continue;
      const name = layer.src ? safe(layer.src) : null;
      if (!name) {
        missing.push(`"${layer.name}" (${layer.id}) is a ${layer.type} layer with no source`);
        continue;
      }
      const dir = layer.type === "image" ? IMAGE_DIR : CLIP_DIR;
      const full = path.join(dir, name);
      try { await stat(full); } catch {
        missing.push(`"${layer.name}" (${layer.id}): ${name} is not in the ${layer.type === "image" ? "images" : "clips"} library`);
        continue;
      }
      layer.src = fwd(full);
    }
    if (missing.length) {
      throw new Error(
        `${missing.join("; ")}. Sources are library names — fix the name, or disable the layer.`,
      );
    }
    return out;
  }

  /**
   * A comp ready to hand to the engine: sources absolute, children attached.
   *
   * Separate from resolveComp because resolveComp is what the child walk calls
   * on each child — folding the walk into it would make every level re-walk
   * everything beneath it.
   */
  async function resolveCompTree(doc) {
    const out = await resolveComp(doc);
    const comps = await resolveChildComps(out);
    if (Object.keys(comps).length) out.comps = comps;
    return out;
  }

  /** Probe one library source for its true size and length. Null if it cannot. */
  async function probeSource(type, name) {
    const dir = type === "image" ? IMAGE_DIR : CLIP_DIR;
    const full = path.join(dir, name);
    try { await stat(full); } catch { return null; }
    try {
      const r = await runEngineFast("probe", { sources: [fwd(full)] }, { timeoutMs: 60_000 });
      return r.sources?.[0] ?? null;
    } catch {
      return null;                       // no engine yet is not a reason to refuse a layer
    }
  }

  /* ──────────────────────────────────────────────────── the preview lane */

  /**
   * One in-flight render per (slug, updatedAt, t, scale, draft).
   *
   * Debouncing is the client's job; surviving a client that does not is this
   * server's. A scrub across a timeline can fire a dozen identical requests
   * before the first finishes, and spawning a dozen pythons over one frame is
   * how a 300 ms preview becomes a thirty-second stall. Identical requests join
   * the job already running.
   *
   * The frame is also kept on disk keyed by the comp's `updatedAt`, so scrubbing
   * BACK over a second you already looked at costs a file read, and the first
   * edit after that invalidates every one of them by changing the stamp.
   */
  const inflight = new Map();
  /* What each cached frame turned out to be. The PNG on disk knows its own
   * size, but reading it back to answer `?meta=1` would mean parsing a header
   * to learn something we were told when we made it. Bounded and disposable. */
  const frameMeta = new Map();

  /**
   * Tier 1: PNG bytes, LRU by Map insertion order, capped in bytes.
   *
   * A Map iterates oldest-first and re-inserting moves an entry to the back, so
   * the chain is free — no second structure to keep in sync with the first,
   * which is how LRU implementations rot.
   */
  const ram = new Map();
  let ramBytes = 0;
  /** The stamp each comp's RAM entries belong to, so a newer one can sweep. */
  const ramStamp = new Map();

  function ramGet(key) {
    const hit = ram.get(key);
    if (!hit) return null;
    ram.delete(key);
    ram.set(key, hit);
    return hit;
  }

  function ramPut(key, rec) {
    const prev = ram.get(key);
    if (prev) { ram.delete(key); ramBytes -= prev.buf.length; }
    if (rec.buf.length > RAM_MAX_FRAME) return;
    ram.set(key, rec);
    ramBytes += rec.buf.length;
    for (const [k, v] of ram) {
      if (ramBytes <= RAM_CAP) break;
      if (k === key) continue;                 // never evict what we just stored
      ram.delete(k);
      ramBytes -= v.buf.length;
    }
  }

  /**
   * Entries from a superseded edit can never be READ again — the stamp is in
   * the key, which is the whole invalidation argument — but they can still hold
   * the budget hostage. Dropped the first time a newer stamp for that comp is
   * seen, which is the next frame request after the edit.
   */
  function ramSweep(slug, stamp) {
    if (ramStamp.get(slug) === stamp) return;
    ramStamp.set(slug, stamp);
    const mine = `${slug}|`;
    const live = `${slug}|${stamp}|`;
    for (const [k, v] of ram) {
      if (!k.startsWith(mine) || k.startsWith(live)) continue;
      ram.delete(k);
      ramBytes -= v.buf.length;
    }
  }

  /**
   * A prewarm yields to anything a human is waiting on.
   *
   * The engine is one python per frame, so a prewarm never HOLDS a resource an
   * interactive request needs — but it does hold the CPU, and a scrub that
   * lands behind a queue of pre-render work feels exactly like a lock. This
   * counter is the whole mechanism: the prewarm loop does not START a frame
   * while someone is waiting on one.
   */
  let interactive = 0;

  const frameKeyOf = (doc, t, scale, draft, vtok = "") => {
    const stamp = Number(doc.updatedAt).toString(36);
    const ms = Math.round(t * 1000);
    const sc = Math.round(scale * 1000);
    // The view token is in the KEY and in the FILENAME both — a view that was
    // in only one of them would serve Front pixels as the Top view, silently.
    return { stamp, ms, sc, key: `${doc.slug}|${stamp}|${ms}|${sc}|${draft ? 1 : 0}|${vtok}` };
  };

  /** Take the bytes if they are worth holding; hand back the path either way. */
  async function absorb(key, file, meta) {
    const st = await stat(file);
    if (!(st.size > 0)) throw new Error("the frame on disk is empty");
    if (st.size > RAM_MAX_FRAME) return { file, buf: null, bytes: st.size, ...meta };
    const buf = await readFile(file);
    ramPut(key, { file, buf, width: meta.width ?? null, height: meta.height ?? null });
    return { file, buf, bytes: buf.length, ...meta };
  }

  function frameFile(doc, t, scale, draft, view = null) {
    const vtok = viewToken(view);
    const { stamp, ms, sc, key } = frameKeyOf(doc, t, scale, draft, vtok);
    ramSweep(doc.slug, stamp);

    const held = ramGet(key);
    if (held) {
      return Promise.resolve({
        file: held.file, buf: held.buf, bytes: held.buf.length,
        width: held.width, height: held.height, ms: 0, cached: true, tier: "ram",
      });
    }

    const running = inflight.get(key);
    if (running) return running;

    const job = (async () => {
      const dir = previewDir(doc.slug);
      const file = path.join(dir, frameName(stamp, ms, sc, draft, vtok));
      try {
        const r = await absorb(key, file, { ...(frameMeta.get(key) || {}) });
        return { ...r, ms: 0, cached: true, tier: "disk" };
      } catch { /* not rendered yet, or the torso of one that died */ }

      await mkdir(dir, { recursive: true });
      const comp = await resolveCompTree(doc);
      const r = await runEngineFast("frame",
        { comp, t, out: fwd(file), scale, draft, ...(view ? { view } : {}) },
        { timeoutMs: 120_000 });
      if (frameMeta.size > 4000) frameMeta.clear();
      frameMeta.set(key, { width: r.width, height: r.height });
      const got = await absorb(key, file, { width: r.width, height: r.height });
      prunePreviews(doc.slug, stamp).catch(() => {});
      return { ...got, ms: r.ms, cached: false, tier: "render", engine: r.engine };
    })();

    inflight.set(key, job);
    job.catch(() => {}).finally(() => {
      if (inflight.get(key) === job) inflight.delete(key);
    });
    return job;
  }

  /**
   * Frames from a superseded edit are dead weight, and even the live stamp has
   * to stop somewhere — a prewarmed 30 s range at 1080p is gigabytes.
   *
   * THROTTLED, which it was not. This ran after every rendered frame: a readdir
   * plus a stat per file, over a directory a prewarm is actively growing, which
   * is quadratic in the length of the range. A stamp change always runs it —
   * that is the stale sweep and it must not be skipped — and otherwise it runs
   * at most every two seconds.
   */
  const pruneState = new Map();
  function prunePreviews(slug, stamp, force = false) {
    const s = pruneState.get(slug) || { at: 0, stamp: null, job: null };
    pruneState.set(slug, s);
    /* `force` means a caller needs the cache to BE within its cap by the time
     * this resolves — the end of a prewarm, where the throttle would otherwise
     * leave the last two seconds' worth over the line indefinitely. Joining the
     * in-flight sweep is not enough: it started before the frames that pushed
     * us over, so it has to be followed by a real one. */
    if (s.job) return force ? s.job.then(() => prunePreviews(slug, stamp, true)) : s.job;
    if (!force && s.stamp === stamp && Date.now() - s.at < 2000) return Promise.resolve();
    s.stamp = stamp;

    s.job = (async () => {
      const dir = previewDir(slug);
      let names = [];
      try { names = await readdir(dir); } catch { return; }

      const live = [];
      for (const n of names) {
        const m = FRAME_RE.exec(n);
        if (!m) continue;
        if (m[1] !== stamp) { unlink(path.join(dir, n)).catch(() => {}); continue; }
        live.push(n);
      }

      const rows = await Promise.all(live.map(async (n) => {
        const st = await stat(path.join(dir, n)).catch(() => null);
        return { n, at: st?.mtimeMs ?? 0, size: st?.size ?? 0 };
      }));
      let count = rows.length;
      let bytes = rows.reduce((a, r) => a + r.size, 0);
      if (count <= DISK_KEEP && bytes <= DISK_CAP) return;
      /* Oldest first, which during a forward prewarm means the head of the
       * range — the same end After Effects drops, and the manifest says so
       * rather than leaving the UI to believe the bar it already filled. */
      rows.sort((a, b) => a.at - b.at);
      const doomed = [];
      for (const r of rows) {
        if (count <= DISK_KEEP && bytes <= DISK_CAP) break;
        doomed.push(unlink(path.join(dir, r.n)).catch(() => {}));
        count--;
        bytes -= r.size;
      }
      // Awaited, or "the cap holds" is only true a few milliseconds after
      // anyone is in a position to look.
      await Promise.all(doomed);
    })().finally(() => { s.job = null; s.at = Date.now(); });

    return s.job;
  }

  /* ────────────────────────────────────────────── the peaks sidecar store */

  const PEAKS_DIR = path.join(config.outputDir, "vfx", ".peaks");

  /**
   * Drop what the write just made stale, then hold the count cap.
   *
   * Stale means: same source (hash), any OTHER mtime token — the file was
   * re-rendered or re-uploaded, so every envelope of its old contents is a
   * lie at any resolution. Other resolutions of the LIVE mtime stay: they are
   * the zoom levels, and evicting them would make every zoom a recompute.
   * The cap evicts oldest-mtime-first, exactly prunePreviews' rule.
   */
  async function prunePeaks(hash, mtok) {
    let names = [];
    try { names = await readdir(PEAKS_DIR); } catch { return; }
    const live = [];
    for (const n of names) {
      const m = PEAKS_RE.exec(n);
      if (!m) continue;
      if (m[1] === hash && m[2] !== mtok) { unlink(path.join(PEAKS_DIR, n)).catch(() => {}); continue; }
      live.push(n);
    }
    if (live.length <= PEAKS_KEEP) return;
    const rows = await Promise.all(live.map(async (n) => {
      const st = await stat(path.join(PEAKS_DIR, n)).catch(() => null);
      return { n, at: st?.mtimeMs ?? 0 };
    }));
    rows.sort((a, b) => a.at - b.at);
    await Promise.all(rows.slice(0, rows.length - PEAKS_KEEP)
      .map((r) => unlink(path.join(PEAKS_DIR, r.n)).catch(() => {})));
  }

  /* ─────────────────────────────── the transcription sidecar store
   * Key discipline documented at NOTES_RE, beside the peaks cache it mirrors. */

  const NOTES_DIR = path.join(config.outputDir, "vfx", ".notes");

  async function pruneNotes(hash, mtok) {
    let names = [];
    try { names = await readdir(NOTES_DIR); } catch { return; }
    const live = [];
    for (const n of names) {
      const m = NOTES_RE.exec(n);
      if (!m) continue;
      if (m[1] === hash && m[2] !== mtok) { unlink(path.join(NOTES_DIR, n)).catch(() => {}); continue; }
      live.push(n);
    }
    if (live.length <= NOTES_KEEP) return;
    const rows = await Promise.all(live.map(async (n) => {
      const st = await stat(path.join(NOTES_DIR, n)).catch(() => null);
      return { n, at: st?.mtimeMs ?? 0 };
    }));
    rows.sort((a, b) => a.at - b.at);
    await Promise.all(rows.slice(0, rows.length - NOTES_KEEP)
      .map((r) => unlink(path.join(NOTES_DIR, r.n)).catch(() => {})));
  }

  /**
   * Transcribe one resolved source under one profile, through the sidecar.
   *
   * Returns { body, cached }: body is notes.py's transcription result (notes
   * with any collapsed bends, the filter's counts, seconds) and never carries
   * fingering — see the cache-key comment for why. Shared by `audio_notes`
   * and `instrument_rig`, which is what keeps "analyse it" and "build the rig
   * from it" one implementation with one cache.
   */
  async function transcribeCached(full, profile) {
    const st = await stat(full);
    const sidecar = path.join(NOTES_DIR, notesName(peaksHash(full), peaksMtok(st), profile));
    try {
      const held = JSON.parse(await readFile(sidecar, "utf8"));
      if (Array.isArray(held.notes)) return { body: held, cached: true };
    } catch { /* not computed yet */ }
    /* First call in a cold python pays the ONNX session + numba warm-up
     * (measured up to ~15 s); the model itself runs 0.03-0.09x realtime. */
    const r = await runTool(NOTES, "transcribe",
      { mode: "transcribe", audio: fwd(full), profile }, { timeoutMs: 10 * 60_000 });
    const body = {
      profile: r.profile, notes: r.notes, count: r.count, bends: r.bends,
      filtered: r.filtered, seconds: r.seconds,
    };
    await mkdir(NOTES_DIR, { recursive: true });
    await writeFile(sidecar, JSON.stringify(body), "utf8");
    pruneNotes(peaksHash(full), peaksMtok(st)).catch(() => {});
    return { body, cached: false };
  }

  /** The audio_peaks addressing rule, shared: a library file name, or a comp
   *  layer whose own source is read. Returns { full, srcName }. */
  async function notesSource(b) {
    if (b.layerId ?? b.id) {
      const doc = await readComp(need(b.slug, "comp slug"));
      if (!doc) throw new Error(`No such comp: ${b.slug}`);
      const layer = findLayer(doc, b.layerId ?? b.id);
      const kind = String(layer.type || "image");
      const srcName = String(layer.src || "");
      let full = null;
      if (kind === "video") full = path.join(CLIP_DIR, srcName);
      else if (kind === "audio") full = srcName ? await audioSourcePath(srcName) : null;
      else throw new Error(`${layer.name} is a ${kind} layer — only audio and video layers have notes to hear.`);
      if (!full) throw new Error(`${layer.name} has no source file to read.`);
      try { await stat(full); } catch {
        throw new Error(`${layer.name}'s source ${srcName} is not in the library any more.`);
      }
      return { full, srcName };
    }
    const srcName = need(b.audio ?? b.src, "audio source name (or slug + layerId)");
    const full = await audioSourcePath(srcName);
    if (!full) {
      throw new Error(`${srcName} is not in the music library or the clips library. `
        + "Give a file name, not a path — or a slug + layerId.");
    }
    return { full, srcName };
  }

  const profileOf = (b) => {
    const p = String(b.profile || "guitar").toLowerCase();
    if (p !== "guitar" && p !== "bass") {
      throw new Error(`No profile "${p}". Profiles: guitar (60-2000 Hz stems), bass (30-400 Hz — a bass stem under the guitar profile reads an octave high and too sparse).`);
    }
    return p;
  };

  /**
   * Everything cached for one (comp, stamp, scale, draft), from BOTH tiers.
   *
   * Memoised for a quarter second. The UI polls this while a bar fills, and the
   * honest answer costs a readdir plus a stat per file; at four polls a second
   * over nine hundred frames that is a lot of syscalls to learn something that
   * changes by one entry. Progress comes from the job record, not from here.
   */
  const indexMemo = new Map();
  /* The RAM preview lane runs on the ACTIVE view only — vtok "" — and that is
   * a decision, not an accident: prewarming every open view would multiply the
   * disk cap by the number of views. A custom view still caches per frame. */
  async function frameIndex(doc, scale, draft, vtok = "") {
    const stamp = Number(doc.updatedAt).toString(36);
    const sc = Math.round(scale * 1000);
    const memoKey = `${doc.slug}|${stamp}|${sc}|${draft ? 1 : 0}|${vtok}`;
    const hit = indexMemo.get(memoKey);
    if (hit && Date.now() - hit.at < 250) return hit.v;

    const dir = previewDir(doc.slug);
    let names = [];
    try { names = await readdir(dir); } catch { /* nothing rendered yet */ }

    const onDisk = new Set();
    let bytes = 0, liveFrames = 0, liveBytes = 0;
    for (const n of names) {
      const m = FRAME_RE.exec(n);
      if (!m || m[1] !== stamp) continue;
      const st = await stat(path.join(dir, n)).catch(() => null);
      if (!st || !st.size) continue;
      /* Every scale of the live stamp counts against the disk cap, so the two
       * totals are deliberately different: `bytes` is this lane, `liveBytes` is
       * what the cap is actually measuring. */
      liveFrames++; liveBytes += st.size;
      if (Number(m[3]) !== sc || !!m[4] !== !!draft || (m[5] || "") !== vtok) continue;
      onDisk.add(Number(m[2]));
      bytes += st.size;
    }

    /* A frame evicted from disk but still held in memory IS cached. Reporting
     * only the disk would understate the cache and make the player re-render
     * something it could have had for free. */
    const pre = `${doc.slug}|${stamp}|`;
    const suf = `|${sc}|${draft ? 1 : 0}|${vtok}`;
    const inRam = [];
    let ramLane = 0;
    for (const [k, v] of ram) {
      if (!k.startsWith(pre) || !k.endsWith(suf)) continue;
      inRam.push(Number(k.slice(pre.length).split("|")[0]));
      ramLane += v.buf.length;
    }
    inRam.sort((a, b) => a - b);

    const set = new Set(onDisk);
    for (const v of inRam) set.add(v);
    const v = {
      set, frames: [...set].sort((a, b) => a - b), ram: inRam,
      bytes, ramBytes: ramLane, liveFrames, liveBytes,
    };
    if (indexMemo.size > 64) indexMemo.clear();
    indexMemo.set(memoKey, { at: Date.now(), v });
    return v;
  }

  /* ─────────────────────────────────────────────────────────── rendering */

  /**
   * Renders wait for the GPU to be free before they start.
   *
   * §6 asks for this to go "through `art` so music keeps priority", but art.js
   * dispatches on a fixed set of job kinds and gates its whole drain on the
   * cover-art switch — a vfx kind would mean editing art.js, which belongs to
   * nobody on this build. So this follows the OTHER discipline already in the
   * tree for exactly this case: runImageGraph in index.js, which waits for
   * `art.idle` and then runs its own process. Same rule, same politeness, no
   * edit to a file we do not own.
   *
   * Bounded at a minute, like runImageGraph: past that the wait itself is the
   * problem, and a composite render is mostly numpy on the CPU anyway.
   */
  async function waitForIdle(maxWaitMs = 60_000) {
    if (!art) return;
    const until = Date.now() + maxWaitMs;
    while (!art.idle && Date.now() < until) {
      // The wait exists to yield the GPU to music. A DEAD engine child runs no
      // music, and `idle` can never come true without one (`comfy.ready` gates
      // it) — so a comp render on a box whose ComfyUI died at boot was paying
      // the full minute for a process that did not exist. proc==null is the
      // dead/never-started state (a booting child still holds its proc), and
      // it is re-checked every second so a mid-wait death releases too.
      if (!art.comfy?.proc) return;
      await new Promise((s) => setTimeout(s, 1000));
    }
  }

  /**
   * Live render jobs, newest last. In memory on purpose: a render that a server
   * restart interrupted did not finish, and a status file claiming otherwise
   * would be a lie that outlives the process.
   *
   * Polled through GET /api/vfx/comp/:slug, which answers `{ comp, renders }` —
   * one route instead of a second one nobody specified.
   */
  const renders = new Map();
  function rememberRender(rec) {
    renders.set(rec.id, rec);
    if (renders.size > 60) {
      for (const [k, v] of renders) {
        if (v.status === "running" || v.status === "queued") continue;
        renders.delete(k);
        if (renders.size <= 60) break;
      }
    }
    return rec;
  }

  /**
   * Start a render and hand back its job id immediately, §6.
   *
   * Sources are resolved BEFORE the id is minted, so a comp pointing at a
   * deleted clip fails at the call with a message naming the layer rather than
   * three seconds later inside a job the caller has to go looking for.
   */
  async function startRender(slug, b, after = null, actor = "system") {
    const doc = await readComp(slug);
    if (!doc) throw new Error(`No such comp: ${slug}`);
    if (!doc.layers.length) throw new Error("This comp has no layers — there is nothing to render.");
    /* The cheap half of the timeRemap/audio refusal, at the call rather than
     * inside a job somebody has to go and read the corpse of: an AUDIO layer
     * always carries sound, so no probe is needed to know the curve is a lie.
     * Remapped video and comp layers are decided in the engine, which knows
     * whether their files actually hold a track. */
    for (const l of doc.layers) {
      if (l.type !== "audio" || l.enabled === false || l.audio === false) continue;
      if (isAnimated(l.timeRemap)) {
        throw new Error(
          `"${l.name}" (${l.id}) is a time-remapped audio layer — v1 does not scrub audio `
          + `through a remap curve. Clear the remap (set_prop path "timeRemap", value null), `
          + `or set the layer's audio switch to false.`,
        );
      }
    }
    /* Fail here, not inside the job. Handing back a job id and THEN discovering
     * there is no engine to run it turns "python is missing" into a job the
     * caller has to go and read the corpse of. */
    try { await stat(ENGINE); } catch { throw new Error(NO_ENGINE); }

    const format = ["mp4", "mov", "png"].includes(b.format) ? b.format : "mp4";
    const from = b.from === undefined ? 0 : inRange(b.from, 0, doc.duration, "from");
    const to = b.to === undefined ? doc.duration : inRange(b.to, 0, doc.duration, "to");
    if (to - from < 1 / doc.fps) {
      throw new Error(`"to" must be at least one frame after "from" (${(1 / doc.fps).toFixed(3)}s at ${doc.fps} fps).`);
    }
    const scale = b.scale === undefined ? 1 : inRange(b.scale, 0.05, 1, "scale");
    const crf = b.crf === undefined ? 18 : clampInt(inRange(b.crf, 0, 51, "crf"), 0, 51);
    const codec = b.codec ? String(b.codec).slice(0, 40) : "auto";
    const draft = !!b.draft;

    const comp = await resolveCompTree(doc);

    const stamp = Date.now().toString(36);
    const base = `vfx_${doc.slug}_${stamp}`;
    /* mp4 and mov land in the clips library so the Studio timeline, the clip
     * browser and every existing tool can see them without a new concept.
     * A png sequence is not a clip, so it stays in the comp's own folder. */
    let out, outName = null;
    if (format === "png") {
      out = path.join(compDir(doc.slug), `frames_${stamp}`);
      await mkdir(out, { recursive: true });
    } else {
      outName = `${base}.${format}`;
      await mkdir(CLIP_DIR, { recursive: true });
      out = path.join(CLIP_DIR, outName);
    }

    const rec = rememberRender({
      id: newId("job", 8), slug: doc.slug, status: "queued",
      progress: 0, frame: 0, format, out: fwd(out), name: outName,
      from, to, scale, draft, error: null,
      startedAt: Date.now(), finishedAt: null,
    });

    (async () => {
      try {
        await waitForIdle();
        rec.status = "running";
        const r = await runEngine("render", {
          comp, out: fwd(out), from, to, format, crf, codec, scale, draft,
          progressEvery: 10,
        }, {
          timeoutMs: 6 * 60 * 60_000,          // a long comp is genuinely hours
          onProgress: (p) => { rec.progress = p.progress; rec.frame = p.frame ?? rec.frame; },
        });
        rec.status = "done";
        rec.progress = 1;
        rec.frames = r.frames ?? null;
        rec.seconds = r.seconds ?? null;
        rec.ms = r.ms ?? null;
        // what the engine muxed, when it muxed anything: {seconds, peakDb, rmsDb}.
        // Absent means the comp had no audio-bearing source and none was added.
        rec.audio = r.audio ?? null;
        await updateComp(doc.slug, (d) => noteRun(d, {
          tool: "render",
          outcome: `${outName || path.basename(out)} — ${r.frames ?? "?"} frames, ${Math.round((r.ms ?? 0) / 1000)}s`,
        }));
        /* ── the render-done provenance seam (SPEC D1.2 / v1 capture set).
         * A comp render is a MODEL-FREE composite: no generator ran here, so
         * the honest class is ai-assisted (the sources may be AI clips and
         * images; the composition is authored). The event carries the comp's
         * layer census so the origin of the output names what went in. Two
         * ledgers see it: the comp's own (beside comp.json) and — when the
         * clip lands in the shared clips library — the library ledger, so
         * the clip browser can answer for it like any other clip. */
        {
          const layerCensus = {};
          for (const l of doc.layers) {
            const k = l.type || "image";
            layerCensus[k] = (layerCensus[k] || 0) + 1;
          }
          provNote({ dir: compDir(doc.slug) }, {
            actor, type: "export", asset: `renders/${outName || path.basename(out)}`,
            data: { format, from, to, frames: r.frames ?? null,
                    origin: "ai-assisted", layers: layerCensus,
                    note: "model-free composite render" },
          });
          if (outName) {
            provNote("library", {
              actor, type: "edit", asset: `clips/${outName}`,
              data: { op: "vfx_render", comp: doc.slug, origin: "ai-assisted",
                      layers: layerCensus },
            });
          }
        }
        if (after) await after(rec);
      } catch (err) {
        rec.status = "failed";
        rec.error = String(err.message || err);
        await updateComp(doc.slug, (d) => noteRun(d, { tool: "render", outcome: `FAILED — ${rec.error}` }))
          .catch(() => {});
      } finally {
        rec.finishedAt = Date.now();
      }
    })();

    return rec;
  }

  const renderRow = (r) => ({
    id: r.id, kind: r.kind ?? "render",
    status: r.status, progress: Number(r.progress?.toFixed?.(3) ?? r.progress),
    frame: r.frame, frames: r.frames ?? null, format: r.format ?? null,
    clip: r.name ?? null, out: r.out ?? null, error: r.error,
    startedAt: r.startedAt, finishedAt: r.finishedAt, studio: r.studio ?? null,
    from: r.from ?? null, to: r.to ?? null, fps: r.fps ?? null,
    scale: r.scale ?? null, draft: r.draft ?? null, audio: r.audio ?? null,
    /* Prewarm only, and the pair is the point: `cached` is what the range
     * already had, `rendered` is what this job actually paid for. A bar that
     * cannot tell them apart makes an instant refill look like work. */
    cached: r.cached ?? null, rendered: r.rendered ?? null, failed: r.failed ?? null,
  });
  /* Two lanes, one store. The job model, the bounded map and the projection are
   * shared — but `renders` stays exactly what every existing caller thinks it
   * is, because a prewarm appearing in the render list is a UI bug on a surface
   * this file does not own. */
  const rowsFor = (slug, kind) => [...renders.values()]
    .filter((r) => r.slug === slug && (r.kind ?? "render") === kind)
    .map(renderRow).reverse();
  const rendersFor = (slug) => rowsFor(slug, "render");
  const prewarmsFor = (slug) => rowsFor(slug, "prewarm");

  /* ────────────────────────────────────────────────────────── RAM preview */

  /**
   * Fill the frame cache over a range, and report it filling.
   *
   * The same job model as a render — `renders`, `rememberRender`, `renderRow`,
   * polled through the same route — because a second progress mechanism is a
   * second thing to get wrong, and this one has to be pollable from the GUI and
   * from MCP alike.
   *
   * Three things it deliberately does NOT do:
   *
   *  · It never writes to the document. A `noteRun` here would bump `updatedAt`
   *    and invalidate the very cache the job just spent a minute filling — the
   *    job would eat its own tail. Prewarming is not an edit and leaves no trace
   *    in the comp's history.
   *  · It does not queue behind, or ahead of, interactive frames. It simply does
   *    not start one while a human is waiting; see `interactive`.
   *  · It does not outlive an edit. Every frame re-reads the comp and stops with
   *    status "stale" the moment `updatedAt` moves, because past that point it
   *    is filling a cache nothing will ever read.
   */
  async function startPrewarm(slug, b) {
    const doc = await readComp(slug);
    if (!doc) throw new Error(`No such comp: ${slug}`);
    if (!doc.layers.length) throw new Error("This comp has no layers — there is nothing to pre-render.");
    /* Fail at the call, not inside the job — the same rule startRender follows,
     * for the same reason: a job id you have to go and read the corpse of is
     * not an error message. */
    try { await stat(ENGINE); } catch { throw new Error(NO_ENGINE); }

    const fps = b.fps === undefined ? doc.fps : inRange(b.fps, LIMITS.minFps, LIMITS.maxFps, "fps");
    const from = b.from === undefined ? 0 : inRange(b.from, 0, doc.duration, "from");
    const to = b.to === undefined ? doc.duration : inRange(b.to, 0, doc.duration, "to");
    if (to <= from) throw new Error(`"to" must be after "from" — got ${from} to ${to}.`);
    const scale = b.scale === undefined ? 1 : inRange(b.scale, 0.05, 1, "scale");
    // Draft follows scale unless asked, exactly as the frame route does it, so
    // a prewarm and the player's own requests land on the same key.
    const draft = b.draft === undefined ? scale < 1 : !!b.draft;
    const lanes = b.concurrency === undefined ? 2 : clampInt(inRange(b.concurrency, 1, 4, "concurrency"), 1, 4);

    const last = Math.floor(doc.duration * fps);
    const i0 = Math.min(last, Math.max(0, Math.round(from * fps)));
    let i1 = Math.min(last, Math.max(i0, Math.round(to * fps)));
    /* Clamped to what the disk cap can actually HOLD, and the reply says so.
     * Rendering three hundred frames that the eviction policy will delete
     * before the user presses play is not a service to anybody. */
    const clamped = (i1 - i0 + 1) > DISK_KEEP;
    if (clamped) i1 = i0 + DISK_KEEP - 1;
    const idx = [];
    for (let i = i0; i <= i1; i++) idx.push(i);

    const params = `${doc.updatedAt}|${i0}|${i1}|${fps}|${Math.round(scale * 1000)}|${draft ? 1 : 0}`;
    /* One RAM preview per comp, as After Effects has. A second identical
     * request rejoins the first rather than doubling the python count; a
     * DIFFERENT one means the user moved the work area, and the old job is
     * work nobody is waiting for any more. */
    let superseded = null;
    for (const r of renders.values()) {
      if ((r.kind ?? "render") !== "prewarm" || r.slug !== doc.slug) continue;
      if (r.status !== "queued" && r.status !== "running") continue;
      if (r.params === params) return { rec: r, rejoined: true, clamped, idx: idx.length };
      r.cancel = true;
      superseded = r.id;
    }

    const have = await frameIndex(doc, scale, draft);
    const already = idx.reduce((a, i) => a + (have.set.has(gridMs(i, fps)) ? 1 : 0), 0);

    const rec = rememberRender({
      id: newId("pre", 8), kind: "prewarm", slug: doc.slug, params,
      status: "queued", progress: 0, frame: 0, frames: idx.length,
      cached: 0, rendered: 0, failed: 0, already,
      from: i0 / fps, to: i1 / fps, fps, scale, draft, lanes,
      stamp: doc.updatedAt, cancel: false, error: null,
      startedAt: Date.now(), finishedAt: null,
    });

    (async () => {
      rec.status = "running";
      let next = 0;
      let stale = false;

      const lane = async () => {
        for (;;) {
          if (rec.cancel || stale) return;
          const i = idx[next++];
          if (i === undefined) return;

          /* Bounded: a leaked counter must not wedge a prewarm forever, and ten
           * seconds of someone scrubbing is ten seconds this job was right to
           * stay out of. */
          const until = Date.now() + 10_000;
          while (interactive > 0 && Date.now() < until && !rec.cancel) {
            await new Promise((s) => setTimeout(s, 15));
          }
          if (rec.cancel || stale) return;

          const fresh = await readComp(doc.slug);
          if (!fresh || fresh.updatedAt !== rec.stamp) { stale = true; return; }

          try {
            const r = await frameFile(doc, Math.min(i / fps, doc.duration), scale, draft);
            if (r.cached) rec.cached++; else rec.rendered++;
          } catch (err) {
            /* One frame that will not render — a font gone, a source deleted
             * mid-flight — must not cost the other two hundred and ninety-nine.
             * The first reason is kept and reported; the range still fills. */
            rec.failed++;
            rec.error ??= String(err.message || err);
          }
          rec.frame++;
          rec.progress = rec.frame / (idx.length || 1);
        }
      };

      await Promise.all(Array.from({ length: lanes }, lane));

      /* Trim BEFORE the status turns terminal. A poller that sees "done" is
       * entitled to read the manifest and find the cache inside its cap; the
       * throttled sweep on its own leaves the tail of every job over the line
       * until something else happens to touch that comp.
       *
       * With the stamp the comp has NOW, not the one this job rendered against.
       * Everything that is not the live stamp is what a prune deletes, so on a
       * job that ended "stale" the old stamp would take the new frames with it. */
      const at = await readComp(doc.slug).catch(() => null);
      if (at) await prunePreviews(doc.slug, Number(at.updatedAt).toString(36), true).catch(() => {});

      if (rec.cancel) rec.status = "cancelled";
      else if (stale) { rec.status = "stale"; rec.error ??= "The comp was edited — these frames would never have been read."; }
      else if (rec.failed && !rec.rendered && !rec.cached) rec.status = "failed";
      else rec.status = "done";
      rec.finishedAt = Date.now();
    })();

    return { rec, rejoined: false, superseded, clamped, idx: idx.length };
  }

  /** Cancellation is cooperative — a frame already in flight finishes and is kept. */
  function cancelPrewarms({ jobId = null, slug = null } = {}) {
    const hit = [];
    for (const r of renders.values()) {
      if ((r.kind ?? "render") !== "prewarm") continue;
      if (jobId && r.id !== jobId) continue;
      if (slug && r.slug !== slug) continue;
      if (r.status !== "queued" && r.status !== "running") continue;
      r.cancel = true;
      hit.push(r.id);
    }
    return hit;
  }

  /**
   * What is cached, on a grid, in a form a scrub bar can draw.
   *
   * `covered` is the answer to "the last four seconds are cached" — contiguous
   * runs in seconds, on the fps the caller asked about. `caps` is the answer to
   * the question nobody asks until it bites: how much of this can be held at
   * all. Both are reported rather than assumed, because a progress bar that
   * fills past what the cache will keep is a lie the UI cannot detect.
   */
  async function cacheManifest(doc, { scale, draft, fps, from, to }) {
    const ix = await frameIndex(doc, scale, draft);
    const last = Math.floor(doc.duration * fps);
    const i0 = from === undefined ? 0 : Math.min(last, Math.max(0, Math.round(from * fps)));
    const i1 = to === undefined ? last : Math.min(last, Math.max(i0, Math.round(to * fps)));

    const covered = [];
    let run = null;
    for (let i = i0; i <= i1; i++) {
      if (ix.set.has(gridMs(i, fps))) {
        if (run) run.i1 = i; else run = { i0: i, i1: i };
      } else if (run) { covered.push(run); run = null; }
    }
    if (run) covered.push(run);
    const onGrid = covered.reduce((a, r) => a + (r.i1 - r.i0 + 1), 0);

    return {
      ok: true, slug: doc.slug, updatedAt: doc.updatedAt,
      width: doc.width, height: doc.height, duration: doc.duration, compFps: doc.fps,
      scale, draft, fps,
      grid: { from: i0 / fps, to: i1 / fps, frames: i1 - i0 + 1, cached: onGrid },
      covered: covered.map((r) => ({
        from: Number((r.i0 / fps).toFixed(4)),
        to: Number((r.i1 / fps).toFixed(4)),
        frames: r.i1 - r.i0 + 1,
      })),
      /* Milliseconds, because that is the quantisation the cache key uses and
       * anything else would invite the client to ask for a frame that exists
       * under a name one millisecond away. */
      frames: ix.frames, ram: ix.ram,
      bytes: ix.bytes, ramBytes: ix.ramBytes,
      caps: {
        ramBytes: RAM_CAP, ramUsed: ramBytes, ramFrames: ram.size, ramFrameMax: RAM_MAX_FRAME,
        diskFrames: DISK_KEEP, diskBytes: DISK_CAP,
        diskUsedFrames: ix.liveFrames, diskUsedBytes: ix.liveBytes,
      },
      prewarms: prewarmsFor(doc.slug),
    };
  }

  /* ────────────────────────────────────────────── Studio timeline bridge */

  const studioFile = (v) => {
    const s = need(v, "Studio project name");
    return s.endsWith(".json") ? s : `${s}.json`;
  };

  /** A Studio item's `src` is a URL like /api/clip/x.mp4 — the library name is the tail. */
  const libNameOf = (src) => {
    const s = decodeURIComponent(String(src || "")).split("?")[0];
    return path.basename(s);
  };

  const IMAGE_EXT = /\.(png|jpe?g|webp|svg|bmp|gif)$/i;

  async function readStudioProject(file) {
    try {
      return JSON.parse(await readFile(path.join(PROJECT_DIR, file), "utf8"));
    } catch (err) {
      throw new Error(`Could not read the Studio project ${file}: ${err.message}`);
    }
  }

  /**
   * Save a Studio project by the SAME rules the Save button uses — filename
   * derived from the name, overwrite on the same name — so an export and a
   * human's Save can never disagree about what a project is.
   */
  async function writeStudioProject(name, doc) {
    const slug = String(name).replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "project";
    const file = `${slug}.json`;
    await mkdir(PROJECT_DIR, { recursive: true });
    await writeFile(path.join(PROJECT_DIR, file),
      JSON.stringify({ ...doc, name, savedAt: Date.now() }, null, 1));
    return { file, name };
  }

  /* ─────────────────────────────────────────────────────── effect params */

  /**
   * What a catalog entry says a param's default is — which is the only place
   * the arity of an effect parameter is written down. Null when the catalog is
   * not there; the keyframe normaliser then only enforces that every key in one
   * property agrees with the others, which is the check that actually matters.
   */
  async function catalogArity(type, param) {
    const cat = await catalogOrNull();
    const def = cat?.[type]?.params?.[param]?.default;
    return def === undefined ? null : arityOf(def);
  }

  async function defaultsFor(type) {
    const cat = await catalogOrNull();
    const spec = cat?.[type];
    if (!spec) return { params: {}, known: !!cat };
    const params = {};
    for (const [k, v] of Object.entries(spec.params || {})) {
      if (v && v.default !== undefined) params[k] = v.default;
    }
    return { params, known: true };
  }

  /* ──────────────────────────────────────────────────────────── the routes */

  async function handle(req, res, url) {
    const p = url.pathname;

    /* ---- reads ---- */

    if (p === "/api/vfx/comps" && req.method === "GET") {
      json(res, 200, { comps: await listComps() });
      return true;
    }

    if (p === "/api/vfx/shapes" && req.method === "GET") {
      try {
        json(res, 200, { shapes: await readShapeCatalog() });
      } catch (err) {
        json(res, 503, { error: String(err.message || err) });
      }
      return true;
    }

    /* lights.py's catalog, verbatim — the same table lights.py serves its own
     * CLI. The UI's light section and an agent reading ranges both come here,
     * so neither can drift from what the shader actually reads. */
    if (p === "/api/vfx/lights" && req.method === "GET") {
      try {
        json(res, 200, await readLightsCatalog());
      } catch (err) {
        json(res, 503, { error: String(err.message || err) });
      }
      return true;
    }

    /* The template shelf, for the GUI's "new from template" — the same
     * listTemplates() the vfx_templates MCP tool answers with. */
    if (p === "/api/vfx/templates" && req.method === "GET") {
      json(res, 200, { templates: listTemplates() });
      return true;
    }

    if (p === "/api/vfx/catalog" && req.method === "GET") {
      try {
        const effects = await readCatalog();
        /* The group list, in first-appearance order — the same derivation the
         * UI picker uses, so the two can never disagree, and NOT a hard-coded
         * list: the Transition lesson was that code hard-coding the group
         * list dropped six effects silently, and Noise & Grain is the tenth
         * group to land since. Served so a caller can see the families
         * without scanning every entry. */
        const groups = [];
        for (const e of Object.values(effects)) {
          if (e && e.group && !groups.includes(e.group)) groups.push(e.group);
        }
        json(res, 200, { effects, groups });
      } catch (err) {
        json(res, 503, { error: String(err.message || err) });
      }
      return true;
    }

    /**
     * The render queue, across every comp — what a queue panel lists and what
     * an agent polls without knowing which comp a job belonged to. Same rows
     * the per-comp route answers with, plus the slug. IN MEMORY: a restart
     * clears it, and a job a restart interrupted is gone rather than lied
     * about as still running — the reply says so every time.
     */
    if (p === "/api/vfx/renders" && req.method === "GET") {
      const slug = url.searchParams.get("slug");
      const kind = url.searchParams.get("kind");
      const jobs = [...renders.values()]
        .filter((r) => (!slug || r.slug === slug) && (!kind || (r.kind ?? "render") === kind))
        .map((r) => ({ slug: r.slug, ...renderRow(r) }))
        .reverse();
      json(res, 200, {
        ok: true, jobs,
        note: "In memory only — a server restart clears this list; a job it interrupted did not finish.",
      });
      return true;
    }

    if (p.startsWith("/api/vfx/comp/") && req.method === "GET") {
      const slug = safe(p.slice("/api/vfx/comp/".length));
      const comp = slug && await readComp(slug);
      if (!comp) { json(res, 404, { error: "No such comp." }); return true; }
      json(res, 200, { comp, renders: rendersFor(slug), prewarms: prewarmsFor(slug) });
      return true;
    }

    /**
     * Which frames of this comp, at this scale, are already there.
     *
     * A separate GET rather than a field on the comp route: the comp route is
     * polled for job progress and this costs a directory listing, and the two
     * have nothing to do with each other. `from`/`to` narrow the window;
     * `fps` chooses the grid the coverage runs are computed on, and defaults to
     * the comp's own.
     */
    if (p.startsWith("/api/vfx/cache/") && req.method === "GET") {
      const slug = safe(p.slice("/api/vfx/cache/".length));
      const doc = slug && await readComp(slug);
      if (!doc) { json(res, 404, { error: "No such comp." }); return true; }
      const scale = clamp(Number(url.searchParams.get("scale") ?? 1) || 1, 0.05, 1);
      const draftParam = url.searchParams.get("draft");
      const draft = draftParam == null ? scale < 1 : draftParam !== "0" && draftParam !== "false";
      const fps = clamp(Number(url.searchParams.get("fps") ?? doc.fps) || doc.fps, LIMITS.minFps, LIMITS.maxFps);
      const fromParam = url.searchParams.get("from");
      const toParam = url.searchParams.get("to");
      json(res, 200, await cacheManifest(doc, {
        scale, draft, fps,
        from: fromParam == null ? undefined : clamp(Number(fromParam) || 0, 0, doc.duration),
        to: toParam == null ? undefined : clamp(Number(toParam) || 0, 0, doc.duration),
      }));
      return true;
    }

    /**
     * The viewer. One PNG of one instant — never a JSON envelope around base64,
     * because an <img src> that the browser can cache-bust and cancel is the
     * whole reason the browser does not need a compositor of its own.
     *
     * `?meta=1` answers JSON instead, with the URL of the same frame. That is
     * the MCP path: an agent needs to know the render SUCCEEDED and get back
     * something it can fetch, and a tool that returns 400 KB of PNG into a
     * transcript helps nobody.
     */
    if (p.startsWith("/api/vfx/frame/") && req.method === "GET") {
      const slug = safe(p.slice("/api/vfx/frame/".length));
      const doc = slug && await readComp(slug);
      if (!doc) { json(res, 404, { error: "No such comp." }); return true; }
      try {
        const t = clamp(Number(url.searchParams.get("t") ?? 0) || 0, 0, doc.duration);
        const scale = clamp(Number(url.searchParams.get("scale") ?? 1) || 1, 0.05, 1);
        // Draft follows the scale unless asked: the half-size lane exists to be
        // fast, and motion blur is the single most expensive thing in it.
        const draftParam = url.searchParams.get("draft");
        const draft = draftParam == null ? scale < 1 : draftParam !== "0" && draftParam !== "false";
        /* ?view=front|top|right|…|orbit renders through a WORKSPACE view
         * instead of the active camera (orbit also takes &yaw=&pitch=; all
         * views take &distance= and &vzoom=). The view rides the cache key —
         * see viewOf/viewToken above for why that is load-bearing. */
        const view = viewOf(null, url.searchParams);

        /* Everything under this counter is a human waiting. A prewarm reads it
         * and stays out of the way; see `interactive`. It covers the RENDER and
         * not the socket write, deliberately — the write is a few hundred
         * microseconds to a loopback client and holding the flag across it
         * would starve the prewarm for no gain a user could feel. */
        interactive++;
        let r;
        try { r = await frameFile(doc, t, scale, draft, view); } finally { interactive--; }

        if (url.searchParams.get("meta")) {
          let q = `t=${t}&scale=${scale}&draft=${draft ? 1 : 0}`;
          if (view) {
            q += `&view=${encodeURIComponent(view.name)}`;
            for (const [k, qk] of [["yaw", "yaw"], ["pitch", "pitch"], ["distance", "distance"], ["zoom", "vzoom"]]) {
              if (view[k] !== undefined) q += `&${qk}=${view[k]}`;
            }
          }
          json(res, 200, {
            ok: true, url: `/api/vfx/frame/${encodeURIComponent(slug)}?${q}`,
            width: r.width ?? null, height: r.height ?? null,
            ms: r.ms ?? 0, cached: !!r.cached, tier: r.tier ?? "render",
            // Which lane rendered it — "serve" is the persistent child, "spawn"
            // the per-call fallback. Absent on cache hits; nothing rendered.
            engine: r.engine ?? null,
            bytes: r.bytes ?? null, t, scale, draft, view: view ?? null,
          });
          return true;
        }
        const head = {
          "Content-Type": "image/png",
          // The URL does not carry the comp's version, so a cached copy is a
          // stale copy the moment anyone touches a keyframe.
          "Cache-Control": "no-store",
          "X-Vfx-Ms": String(r.ms ?? 0),
          // Which tier answered. The measurement this whole lane exists for is
          // not observable from the outside otherwise, and a cache nobody can
          // measure is a cache nobody can prove.
          "X-Vfx-Cache": r.tier ?? "render",
          // ...and which python answered a render: the persistent serve child
          // or the per-call fallback. Same argument, other seam.
          ...(r.engine ? { "X-Vfx-Engine": r.engine } : {}),
        };
        if (r.buf) {
          // The point of the RAM tier: one write to the socket, no syscalls.
          res.writeHead(200, { ...head, "Content-Length": r.buf.length });
          res.end(r.buf);
          return true;
        }
        const st = await stat(r.file);
        res.writeHead(200, { ...head, "Content-Length": st.size });
        createReadStream(r.file).pipe(res);
      } catch (err) {
        // A failed frame answers JSON, not a broken image: the viewer can read
        // the reason and say it out loud instead of showing a torn icon.
        json(res, 400, { error: String(err.message || err) });
      }
      return true;
    }

    /* ---- writes ---- */

    if (p !== "/api/vfx" || req.method !== "POST") return false;

    let b, action;
    try {
      b = await readBody(req);
      action = String(b.action || "");
    } catch (err) {
      // Malformed JSON is the caller's bug, not a 500 — say which it was.
      return json(res, 400, { error: `The request body is not JSON: ${err.message}` }), true;
    }
    /* WHO is acting, from the request headers — never from the body, which a
     * client writes. The browser carries no header → "user"; MCP stamps
     * agent:<name>; anything else records "system" (provenance.js D1.4). */
    const actor = prov ? prov.actorFrom(req) : "system";

    try {
      switch (action) {

        /* ── the comp itself ─────────────────────────────────────────── */

        case "create": {
          const opts = {
            width: b.width === undefined ? 1920 : clampInt(inRange(b.width, LIMITS.minSize, LIMITS.maxSize, "width"), LIMITS.minSize, LIMITS.maxSize),
            height: b.height === undefined ? 1080 : clampInt(inRange(b.height, LIMITS.minSize, LIMITS.maxSize, "height"), LIMITS.minSize, LIMITS.maxSize),
            fps: b.fps === undefined ? 30 : inRange(b.fps, LIMITS.minFps, LIMITS.maxFps, "fps"),
            duration: b.duration === undefined ? 8 : inRange(b.duration, LIMITS.minDuration, LIMITS.maxDuration, "duration"),
          };
          if (b.bg !== undefined) opts.bg = rgbaOf(b.bg, "bg");
          const doc = await createComp(b.name || b.title || "Untitled", opts);
          return json(res, 200, { ok: true, slug: doc.slug, comp: doc }), true;
        }

        /**
         * A comp from a template — the action that answers with something
         * finished instead of something empty.
         *
         * The template is PURE (server/vfx/templates.js): it cannot stat a file
         * and must not try, so the two things only this side knows happen here.
         * First every source it names is checked against the library — §6's
         * rule, a name and never a path. Then each one is PROBED, because scale
         * is a percentage of the source's OWN pixels and "fill the frame" is
         * not computable from the comp alone; without the engine the probe
         * comes back null and the layer keeps 100%, which is a worse picture
         * but never an error.
         *
         * A source the caller simply did not give is not an error either: the
         * template degrades that layer to a solid, and the reply names every
         * one that did so, because a comp with a grey rectangle where the logo
         * goes is only useful if you are told that is what it is.
         */
        case "from_template": {
          const id = String(b.template ?? b.templateId ?? "");
          if (!id) {
            throw new Error(`Give a template. There are ${listTemplates().length}: ${listTemplates().map((t) => t.id).join(", ")}.`);
          }
          getTemplate(id);                       // throws, naming every template
          const params = (b.params && typeof b.params === "object") ? { ...b.params } : {};
          // The comp's own fields are accepted at the top level too — "duration"
          // reads better beside "template" than buried in `params`.
          for (const k of ["name", "width", "height", "fps", "duration", "bg"]) {
            if (b[k] !== undefined && params[k] === undefined) params[k] = b[k];
          }

          const probe = {};
          const sources = [];
          for (const s of sourcesOf(id, params)) {
            const dir = s.kind === "image" ? IMAGE_DIR : CLIP_DIR;
            try { await stat(path.join(dir, s.name)); } catch {
              throw new Error(
                `${id}.${s.param}: "${s.name}" is not in the ${s.kind === "image" ? "images" : "clips"} library. `
                + `Sources are library names, not paths — or leave it out and the layer becomes a solid placeholder.`,
              );
            }
            const info = await probeSource(s.kind, s.name);
            if (info) probe[s.name] = info;
            sources.push({ param: s.param, name: s.name, kind: s.kind, probed: !!info });
          }

          const built = buildTemplate(id, params, { probe });
          // createComp mints the slug and owns collisions; the document's own
          // slug is a suggestion this side does not get to keep.
          const created = await createComp(built.name, {
            width: built.width, height: built.height, fps: built.fps,
            duration: built.duration, bg: built.bg,
          });
          const doc = await updateComp(created.slug, (d) => {
            d.layers = built.layers;
            d.markers = built.markers;
            d.motionBlur = built.motionBlur;
            d.template = id;
            noteRun(d, { tool: "from_template", outcome: `${id} — ${built.layers.length} layers` });
            return d;
          });
          const placeholders = doc.layers.filter((l) => l.templatePlaceholder).map((l) => l.name);
          return json(res, 200, {
            ok: true, slug: doc.slug, template: id, comp: doc, sources,
            placeholders,
            note: placeholders.length
              ? `${placeholders.length} layer(s) had no source and are solid placeholders: ${placeholders.join(", ")}. Point them at a library name with set_layer.`
              : undefined,
          }), true;
        }

        case "delete": {
          const slug = need(b.slug, "comp slug");
          if (!await readComp(slug)) throw new Error(`No such comp: ${slug}`);
          await deleteComp(slug);
          return json(res, 200, { ok: true }), true;
        }

        case "rename": {
          /* The NAME changes; the slug does not. The slug is the folder, the
           * URL and what every render breadcrumb already recorded — renaming it
           * would move an hour of preview cache and orphan every link for the
           * sake of a label nobody reads off the disk. */
          const doc = await updateComp(need(b.slug, "comp slug"), (d) => {
            const name = String(b.name || "").trim().slice(0, 80);
            if (!name) throw new Error("Give the comp a name.");
            noteRun(d, { tool: "rename", outcome: `${d.name} → ${name}` });
            d.name = name;
            return d;
          });
          return json(res, 200, { ok: true, comp: doc }), true;
        }

        case "set_comp": {
          const doc = await updateComp(need(b.slug, "comp slug"), (d) => {
            if (b.width !== undefined) d.width = clampInt(inRange(b.width, LIMITS.minSize, LIMITS.maxSize, "width"), LIMITS.minSize, LIMITS.maxSize);
            if (b.height !== undefined) d.height = clampInt(inRange(b.height, LIMITS.minSize, LIMITS.maxSize, "height"), LIMITS.minSize, LIMITS.maxSize);
            if (b.fps !== undefined) d.fps = inRange(b.fps, LIMITS.minFps, LIMITS.maxFps, "fps");
            /* The whole layer stack at once. The editor's Duplicate builds a
             * comp and then sends the source's layers here; this silently
             * ignored them and answered ok, so every duplicate opened empty
             * with the right size and no content. migrate() re-normalises and
             * re-ids nothing, so the caller's ids come across as given — which
             * is what makes a duplicate a duplicate. */
            if (b.layers !== undefined) {
              if (!Array.isArray(b.layers)) throw new Error("layers is an array of layer objects.");
              if (b.layers.length > LIMITS.layers) {
                throw new Error(`A comp holds at most ${LIMITS.layers} layers — got ${b.layers.length}.`);
              }
              d.layers = b.layers;
            }
            /* Every wiggle() and random() in the comp derives from this, so
             * changing it re-rolls all of them at once and leaves each one
             * reproducible. Absent it is 0, which is why two identical renders
             * are identical. */
            if (b.seed !== undefined) d.seed = clampInt(inRange(b.seed, 0, 2 ** 31 - 1, "seed"), 0, 2 ** 31 - 1);
            if (b.duration !== undefined) {
              d.duration = inRange(b.duration, LIMITS.minDuration, LIMITS.maxDuration, "duration");
              // Shortening a comp must not leave layers ending past its end,
              // which the engine would have to invent a rule for.
              for (const l of d.layers) {
                l.end = Math.min(l.end, d.duration);
                l.start = Math.min(l.start, Math.max(0, l.end - 1 / d.fps));
              }
            }
            if (b.bg !== undefined) d.bg = rgbaOf(b.bg, "bg");
            if (b.name !== undefined) d.name = String(b.name).trim().slice(0, 80) || d.name;
            // Whether the TIMELINE hides shy layers. Never touches a render.
            if (b.hideShy !== undefined) d.hideShy = !!b.hideShy;
            if (b.motionBlur !== undefined) {
              const mb = b.motionBlur || {};
              if (mb.enabled !== undefined) d.motionBlur.enabled = !!mb.enabled;
              if (mb.shutter !== undefined) d.motionBlur.shutter = inRange(mb.shutter, 1, 720, "motionBlur.shutter");
              if (mb.samples !== undefined) d.motionBlur.samples = clampInt(inRange(mb.samples, 2, 64, "motionBlur.samples"), 2, 64);
            }
            if (b.markers !== undefined) {
              if (!Array.isArray(b.markers)) throw new Error("markers must be an array of { t, label }.");
              d.markers = b.markers.map((m, i) => ({
                t: inRange(m?.t, 0, d.duration, `markers[${i}].t`),
                label: String(m?.label ?? "").slice(0, 80),
              })).sort((x, y) => x.t - y.t);
            }
            noteRun(d, { tool: "set_comp", outcome: `${d.width}x${d.height} @${d.fps} · ${d.duration}s` });
            return d;
          });
          return json(res, 200, { ok: true, comp: doc }), true;
        }

        /* ── layers ──────────────────────────────────────────────────── */

        case "add_layer": {
          const slug = need(b.slug, "comp slug");
          let newLayerId = null;
          const type = String(b.type || "");
          if (!LAYER_TYPES.includes(type)) {
            throw new Error(`type must be one of: ${LAYER_TYPES.join(", ")}.`);
          }
          let src = null, probe = null;
          if (type === "image" || type === "video") {
            src = need(b.src, `${type} library name`);
            const dir = type === "image" ? IMAGE_DIR : CLIP_DIR;
            try { await stat(path.join(dir, src)); } catch {
              throw new Error(`${src} is not in the ${type === "image" ? "images" : "clips"} library. Sources are library names, not paths.`);
            }
            // Anchoring on the source's own centre is what makes rotate spin a
            // layer instead of swinging it. Best effort — without the engine we
            // fall back to the comp centre, which is at least predictable.
            if (b.probe !== false) probe = await probeSource(type, src);
          }

          if (type === "audio") {
            src = need(b.src, "audio source name (a song from the music library, or a clip)");
            const full = await audioSourcePath(src);
            if (!full) {
              throw new Error(`${src} is not in the music library or the clips library. Sources are library names, not paths.`);
            }
            if (b.probe !== false) {
              try {
                const r = await runEngine("probe", { sources: [fwd(full)] }, { timeoutMs: 60_000 });
                probe = r.sources?.[0] ?? null;
              } catch { /* no engine yet is not a reason to refuse a layer */ }
              // Refused NOW, not at render: an audio layer over a soundless
              // file is a broken source, and three seconds into a render job
              // is the worst place to learn that.
              if (probe && probe.audio === false) {
                throw new Error(`${src} has no audio stream — an audio layer needs a source with sound.`);
              }
            }
          }

          if (type === "comp") {
            // `compSlug` is accepted because an earlier version of the MCP
            // schema named it that; `src` is what the engine reads.
            src = need(b.src ?? b.compSlug, "comp slug");
            if (src === slug) {
              throw new Error(`A comp cannot contain itself. "${src}" is the comp you are adding this layer to.`);
            }
            if (!await readComp(src)) {
              throw new Error(`There is no comp called "${src}". GET /api/vfx/comps lists them.`);
            }
          }

          const doc = await updateComp(slug, (d) => {
            if (d.layers.length >= LIMITS.layers) {
              throw new Error(`A comp holds at most ${LIMITS.layers} layers — precompose some of them.`);
            }
            const layer = blankLayer(d, type, { name: String(b.name || src || type).slice(0, 80) });
            if (src) layer.src = src;
            if (probe?.width && probe?.height) {
              layer.transform.anchor = [probe.width / 2, probe.height / 2];
              layer.srcWidth = probe.width;          // advisory metadata for the UI;
              layer.srcHeight = probe.height;        // the engine reads the file itself
              if (probe.duration) layer.srcDuration = probe.duration;
              if (probe.fps) layer.srcFps = probe.fps;
            } else if (probe?.duration) {
              layer.srcDuration = probe.duration;    // an audio source has length, no size
            }
            // Advisory, like srcWidth: whether a movie render of this layer
            // will have anything to mix. Most generated clips are silent.
            if (probe && probe.audio !== undefined) layer.srcHasAudio = !!probe.audio;
            layer.start = b.start === undefined ? 0 : inRange(b.start, 0, d.duration, "start");
            const naturalEnd = (type === "video" || type === "audio") && probe?.duration
              ? Math.min(layer.start + probe.duration, d.duration) : d.duration;
            layer.end = b.end === undefined ? naturalEnd : inRange(b.end, 0, d.duration, "end");
            if (layer.end <= layer.start) throw new Error("end must be after start.");
            if (b.color !== undefined) layer.color = rgbaOf(b.color, "color");
            if (b.text !== undefined) layer.text = mergeText(layer.text, b.text);

            /* The kind-specific contents. blankLayer seeds a shape layer with a
             * placeholder rect so a new one is visible rather than blank — but
             * that placeholder must not survive a caller who said what they
             * wanted, which is exactly what happened before this. */
            if (b.shapes !== undefined) {
              if (type !== "shape") throw new Error(`Only a shape layer has shapes — this is a ${type} layer.`);
              if (!Array.isArray(b.shapes) || !b.shapes.length) {
                throw new Error("shapes is a non-empty array of items. GET /api/vfx/shapes lists the 16 types.");
              }
              const bad = b.shapes.findIndex((it) => !it || typeof it !== "object" || !it.type);
              if (bad >= 0) throw new Error(`shapes[${bad}] has no "type". Every item names one — see /api/vfx/shapes.`);
              layer.shapes = b.shapes;
            }
            if (b.animators !== undefined) {
              if (type !== "text") throw new Error(`Animators are per-character text animation — this is a ${type} layer.`);
              if (!Array.isArray(b.animators)) throw new Error("animators is an array.");
              layer.animators = b.animators;
            }
            if (b.camera !== undefined) {
              if (type !== "camera") throw new Error(`Only a camera layer has camera settings — this is a ${type} layer.`);
              const c = b.camera || {};
              /* REBUILT, so a key missing here is discarded. The engine reads
               * three more off a camera — pointOfInterest (engine.py:1770),
               * focalLength (:1765) and blurLevel — and without
               * pointOfInterest camera_from leaves the rotation at identity,
               * which means a camera could be moved and never AIMED. */
              /* REBUILT, so a key missing here is discarded. The engine reads
               * three more off a camera — pointOfInterest (engine.py:1770),
               * focalLength (:1765) and blurLevel — and without
               * pointOfInterest camera_from leaves the rotation at identity,
               * which means a camera could be moved and never AIMED. */
              layer.camera = {
                zoom: inRange(c.zoom ?? 1778, 1, 100000, "camera.zoom"),
                depthOfField: !!c.depthOfField,
                aperture: inRange(c.aperture ?? 25, 0, 1000, "camera.aperture"),
                focusDistance: inRange(c.focusDistance ?? 1778, 1, 100000, "camera.focusDistance"),
              };
              // Optional, and only carried when given: an absent pointOfInterest
              // is what tells the engine to leave the lens free rather than
              // aim it, so writing a default here would change the meaning.
              if (c.focalLength !== undefined) layer.camera.focalLength = inRange(c.focalLength, 1, 5000, "camera.focalLength");
              if (c.blurLevel !== undefined) layer.camera.blurLevel = inRange(c.blurLevel, 0, 1000, "camera.blurLevel");
              if (c.pointOfInterest !== undefined && c.pointOfInterest !== null) {
                const poi = c.pointOfInterest;
                if (!Array.isArray(poi) || poi.length !== 3) {
                  throw new Error("camera.pointOfInterest is [x, y, z] in comp pixels — the spot the lens looks at. Omit it to leave the camera free.");
                }
                layer.camera.pointOfInterest = poi.map((n) => inRange(n, -1e6, 1e6, "camera.pointOfInterest"));
              }
              // Optional, and only carried when given: an absent pointOfInterest
              // is what tells the engine to leave the lens free rather than
              // aim it, so writing a default here would change the meaning.
              if (c.focalLength !== undefined) layer.camera.focalLength = inRange(c.focalLength, 1, 5000, "camera.focalLength");
              if (c.blurLevel !== undefined) layer.camera.blurLevel = inRange(c.blurLevel, 0, 1000, "camera.blurLevel");
              if (c.pointOfInterest !== undefined && c.pointOfInterest !== null) {
                const poi = c.pointOfInterest;
                if (!Array.isArray(poi) || poi.length !== 3) {
                  throw new Error("camera.pointOfInterest is [x, y, z] in comp pixels — the spot the lens looks at. Omit it to leave the camera free.");
                }
                layer.camera.pointOfInterest = poi.map((n) => inRange(n, -1e6, 1e6, "camera.pointOfInterest"));
              }
            }
            if (b.threeD !== undefined) layer.threeD = !!b.threeD;
            /* blankLayer seeds a point light at the camera's home; a caller
             * who said what they wanted lands it in the same call. */
            if (b.light !== undefined) mergeLight(layer, b.light);
            if (b.width !== undefined || b.height !== undefined) {
              if (type !== "solid") throw new Error(`Only a solid has its own width and height — this is a ${type} layer.`);
              if (b.width !== undefined) layer.width = clampInt(inRange(b.width, 1, 16384, "width"), 1, 16384);
              if (b.height !== undefined) layer.height = clampInt(inRange(b.height, 1, 16384, "height"), 1, 16384);
            }
            if (b.blend !== undefined) layer.blend = blendOf(b.blend);
            const at = b.index === undefined ? 0 : clampInt(inRange(b.index, 0, d.layers.length, "index"), 0, d.layers.length);
            d.layers.splice(at, 0, layer);
            noteRun(d, { tool: "add_layer", outcome: `${type} "${layer.name}" at index ${at}` });
            newLayerId = layer.id;
            return d;
          });
          return json(res, 200, { ok: true, layerId: newLayerId, layer: doc.layers.find((l) => l.id === newLayerId), comp: doc }), true;
        }

        case "remove_layer": {
          const doc = await updateComp(need(b.slug, "comp slug"), (d) => {
            const layer = findLayer(d, b.layerId ?? b.id);
            const at = d.layers.indexOf(layer);
            d.layers.splice(at, 1);
            /* Two references go stale the moment a layer leaves the stack, and
             * both would render as something quietly wrong rather than as an
             * error: a child still parented to it, and the layer that was using
             * it as its track matte — which under AE's "the layer above" rule
             * would silently start keying off a different picture. */
            let orphans = 0, mattes = 0;
            for (const l of d.layers) if (l.parent === layer.id) { l.parent = null; orphans++; }
            const below = d.layers[at];
            if (below?.trackMatte) { below.trackMatte = null; mattes++; }
            noteRun(d, {
              tool: "remove_layer",
              outcome: `${layer.name} (${layer.id})${orphans ? `, ${orphans} unparented` : ""}${mattes ? ", 1 track matte cleared" : ""}`,
            });
            return d;
          });
          return json(res, 200, { ok: true, comp: doc }), true;
        }

        case "duplicate_layer": {
          let newLayerId = null;
          const doc = await updateComp(need(b.slug, "comp slug"), (d) => {
            if (d.layers.length >= LIMITS.layers) throw new Error(`A comp holds at most ${LIMITS.layers} layers.`);
            const layer = findLayer(d, b.layerId ?? b.id);
            const copy = JSON.parse(JSON.stringify(layer));
            // Fresh ids all the way down, or a keyframe path written against
            // the copy would land on the original.
            copy.id = newId("ly");
            copy.name = String(b.name || `${layer.name} copy`).slice(0, 80);
            for (const f of copy.effects) f.id = newId("fx");
            for (const m of copy.masks) m.id = newId("mk");
            d.layers.splice(d.layers.indexOf(layer), 0, copy);
            noteRun(d, { tool: "duplicate_layer", outcome: `${layer.name} → ${copy.name}` });
            newLayerId = copy.id;
            return d;
          });
          return json(res, 200, { ok: true, layerId: newLayerId, comp: doc }), true;
        }

        case "reorder_layer": {
          const doc = await updateComp(need(b.slug, "comp slug"), (d) => {
            const layer = findLayer(d, b.layerId ?? b.id);
            const from = d.layers.indexOf(layer);
            const to = clampInt(inRange(b.toIndex, 0, d.layers.length - 1, "toIndex"), 0, d.layers.length - 1);
            d.layers.splice(from, 1);
            d.layers.splice(to, 0, layer);
            noteRun(d, { tool: "reorder_layer", outcome: `${layer.name}: ${from} → ${to}` });
            return d;
          });
          return json(res, 200, { ok: true, comp: doc }), true;
        }

        case "set_layer": {
          const doc = await updateComp(need(b.slug, "comp slug"), async (d) => {
            const layer = findLayer(d, b.layerId ?? b.id);
            const changed = [];

            if (b.name !== undefined) { layer.name = String(b.name).slice(0, 80); changed.push("name"); }
            if (b.enabled !== undefined) { layer.enabled = !!b.enabled; changed.push("enabled"); }
            if (b.solo !== undefined) { layer.solo = !!b.solo; changed.push("solo"); }
            if (b.locked !== undefined) { layer.locked = !!b.locked; changed.push("locked"); }
            /* Timeline organisation, not pixels: a shy layer still renders but
             * hides from the timeline while the comp's hideShy is on; a label
             * is a colour NAME from the store's fixed list. */
            if (b.shy !== undefined) { layer.shy = !!b.shy; changed.push("shy"); }
            if (b.label !== undefined) {
              const lb = String(b.label || "none");
              if (!LABEL_COLORS.includes(lb)) {
                throw new Error(`label is a colour name: ${LABEL_COLORS.join(", ")}.`);
              }
              layer.label = lb; changed.push("label");
            }
            if (b.motionBlur !== undefined) { layer.motionBlur = !!b.motionBlur; changed.push("motionBlur"); }
            if (b.blend !== undefined) { layer.blend = blendOf(b.blend); changed.push("blend"); }

            if (b.type !== undefined && b.type !== layer.type) {
              // A type change re-reads `src`, `color` and `text` as different
              // things entirely. Refusing is kinder than half-converting.
              throw new Error(`A layer's type cannot change (${layer.type} → ${b.type}). Add a new layer and remove this one.`);
            }
            if (b.src !== undefined && layer.type === "comp") {
              // A comp layer's src is the child's SLUG. Refusing it here left a
              // comp layer permanently pointed at whatever it was created with.
              const slug = need(b.src, "comp slug");
              if (slug === d.slug) throw new Error(`A comp cannot contain itself.`);
              if (!await readComp(slug)) {
                throw new Error(`There is no comp called "${slug}". GET /api/vfx/comps lists them.`);
              }
              layer.src = slug; changed.push("src");
            } else if (b.src !== undefined && layer.type === "audio") {
              const src = need(b.src, "audio source name");
              if (!await audioSourcePath(src)) {
                throw new Error(`${src} is not in the music library or the clips library.`);
              }
              layer.src = src; changed.push("src");
              // Same re-probe discipline as a video src change: the duration
              // advisory must not outlive the file it described.
              if (b.probe !== false) {
                try {
                  const r = await runEngine("probe", { sources: [fwd(await audioSourcePath(src))] }, { timeoutMs: 60_000 });
                  const p = r.sources?.[0] ?? null;
                  if (p?.duration) layer.srcDuration = p.duration; else delete layer.srcDuration;
                  if (p && p.audio !== undefined) layer.srcHasAudio = !!p.audio;
                } catch { delete layer.srcDuration; }
              } else {
                delete layer.srcDuration;
              }
            } else if (b.src !== undefined) {
              if (layer.type !== "image" && layer.type !== "video") {
                throw new Error(`A ${layer.type} layer has no source file.`);
              }
              const src = need(b.src, "library name");
              const dir = layer.type === "image" ? IMAGE_DIR : CLIP_DIR;
              try { await stat(path.join(dir, src)); } catch {
                throw new Error(`${src} is not in the ${layer.type === "image" ? "images" : "clips"} library.`);
              }
              layer.src = src; changed.push("src");
              /* srcDuration is the ceiling interp.time_remap clamps a remap
               * curve to (interp.py:532). It was probed once at add_layer time
               * and never again, so repointing a time-remapped layer at a
               * longer clip left it frozen on the old clip's last frame for the
               * rest of the shot. Re-probe, and drop a stale value if the probe
               * cannot answer rather than keeping a number that is now a lie. */
              if (b.probe !== false) {
                const p = await probeSource(layer.type, src);
                if (p?.duration) layer.srcDuration = p.duration;
                else delete layer.srcDuration;
              } else {
                delete layer.srcDuration;
              }
            }
            /* ── the fields the engine reads that this action could not write ── */

            if (b.threeD !== undefined) {
              layer.threeD = !!b.threeD; changed.push("threeD");
            }
            /* AE's auto-orient — a layer switch like threeD, never a keyframe
             * track (it is not animatable in AE either, which is why it is
             * absent from layerProperties). "alongPath" turns the layer along
             * its position track's tangent; its own rotation composes on top. */
            if (b.autoOrient !== undefined) {
              const ao = String(b.autoOrient || "off");
              if (ao === "towardCamera") {
                throw new Error(
                  'autoOrient "towardCamera" is not supported: layer matrices are needed before '
                  + "the frame's camera exists (a camera's own parent chain, the light rig), and a "
                  + "billboard under a rotated parent needs that parent's rotation inverted back out "
                  + "— a wrong orientation rendered silently would be worse than this refusal. "
                  + 'Use "alongPath", or aim the layer with rotationX/Y/Z.',
                );
              }
              if (!AUTO_ORIENT_MODES.includes(ao)) {
                throw new Error(`autoOrient is ${AUTO_ORIENT_MODES.map((m) => `"${m}"`).join(" or ")} — got "${b.autoOrient}".`);
              }
              /* A camera aims with pointOfInterest or its rotations, a light
               * with its own axis, and an audio layer paints nothing — on all
               * three this switch would be stored, returned, and read by no
               * render, the dead control this API refuses to grow. */
              if (["camera", "light", "audio"].includes(layer.type)) {
                throw new Error(`A ${layer.type} layer cannot auto-orient — ${
                  layer.type === "camera" ? "aim it with camera.pointOfInterest or rotationX/Y/Z"
                  : layer.type === "light" ? "aim it with its own transform"
                  : "it paints nothing to orient"}.`);
              }
              layer.autoOrient = ao; changed.push("autoOrient");
            }
            /* Both read by the renderer and writable by nobody until now.
             * preserveTransparency is AE's T switch (engine.py:2405): the layer
             * paints only where what is beneath it is already opaque. `origin`
             * decides whether a shape item's coordinates are measured from the
             * layer's centre or its top-left (shapes.py:1734). */
            if (b.preserveTransparency !== undefined) {
              layer.preserveTransparency = !!b.preserveTransparency;
              changed.push("preserveTransparency");
            }
            if (b.origin !== undefined) {
              const o = String(b.origin).toLowerCase();
              if (!["center", "centre", "topleft"].includes(o)) {
                throw new Error(`origin is "center" or "topleft" — got "${b.origin}".`);
              }
              layer.origin = o === "centre" ? "center" : o;
              changed.push("origin");
            }
            /* Into the TRANSFORM. engine.py:1604 reads transform.get("rotationX");
             * written onto the layer they are kept, returned, and ignored by
             * every render. */
            for (const axis of ["rotationX", "rotationY", "rotationZ"]) {
              if (b[axis] !== undefined) {
                layer.transform[axis] = isAnimated(b[axis]) ? b[axis] : inRange(b[axis], -36000, 36000, axis);
                changed.push(axis);
              }
            }
            /* The engine composes ONE set of angles and says so at engine.py:66 —
             * AE's orientation/rotation split exists to let you animate a spin
             * on top of a fixed pose, which a keyframed rotationX/Y/Z does by
             * itself. Storing an orientation here would keep it, return it, and
             * change no pixel. */
            if (b.orientation !== undefined) {
              throw new Error("This compositor has no separate orientation triple — it composes one set of angles. Use rotationX / rotationY / rotationZ, which keyframe.");
            }
            if (b.camera !== undefined) {
              if (layer.type !== "camera") throw new Error(`Only a camera layer has camera settings — this is a ${layer.type} layer.`);
              const c = b.camera || {};
              // zoom IS the focal length here, and a zero would divide by it.
              layer.camera = {
                zoom: inRange(c.zoom ?? 1778, 1, 100000, "camera.zoom"),
                depthOfField: !!c.depthOfField,
                aperture: inRange(c.aperture ?? 25, 0, 1000, "camera.aperture"),
                focusDistance: inRange(c.focusDistance ?? 1778, 1, 100000, "camera.focusDistance"),
              };
              changed.push("camera");
            }
            if (b.collapse !== undefined) {
              if (layer.type !== "comp") throw new Error("collapse (continuous rasterisation) applies to comp layers.");
              layer.collapse = !!b.collapse; changed.push("collapse");
            }
            /* The light spec and the material options — the two halves of
             * lights.py, both merged per key so keyframes survive. threeD is
             * handled ABOVE, so { threeD: true, material: {...} } in one call
             * does the obvious thing. */
            if (b.light !== undefined) { mergeLight(layer, b.light); changed.push("light"); }
            if (b.material !== undefined) { mergeMaterial(layer, b.material); changed.push("material"); }
            /* The audio pair. `audio` is the mute switch (absent means on) and
             * `audioLevels` is gain in dB — both only where the render's mixer
             * will actually read them, which resolvePropPath is the one
             * authority on. A movie render mixes audio layers, video layers'
             * own tracks and comp layers' child mixes; everything else is
             * deaf and refusing here beats storing a dead control. */
            if (b.audio !== undefined) {
              if (!AUDIO_KINDS.includes(layer.type)) {
                throw new Error(`Only ${AUDIO_KINDS.join("/")} layers carry sound — this is a ${layer.type} layer.`);
              }
              layer.audio = !!b.audio; changed.push("audio");
            }
            if (b.audioLevels !== undefined) {
              const ref = resolvePropPath(layer, "audioLevels");   // refuses deaf kinds
              ref.owner[ref.key] = isAnimated(b.audioLevels)
                ? b.audioLevels
                : inRange(b.audioLevels, AUDIO_LEVELS_RANGE[0], AUDIO_LEVELS_RANGE[1], "audioLevels (dB)");
              changed.push("audioLevels");
            }
            if (b.frameBlend !== undefined) {
              const fb = String(b.frameBlend || "off").toLowerCase();
              if (!["off", "mix", "on"].includes(fb)) {
                throw new Error(`frameBlend is "off" or "mix" — got "${b.frameBlend}".`);
              }
              layer.frameBlend = fb; changed.push("frameBlend");
            }
            /* shapes / animators / styles are list-shaped and their grammars
             * live in shapes.py and engine.py. Checking only the container here
             * is on purpose: a second copy of those rules in JS would be a
             * second source of truth, and it would drift. */
            if (b.shapes !== undefined) {
              if (layer.type !== "shape") throw new Error(`Only a shape layer has shapes — this is a ${layer.type} layer.`);
              if (!Array.isArray(b.shapes)) throw new Error("shapes is an array of items. GET /api/vfx/shapes lists the 16 types.");
              const bad = b.shapes.findIndex((it) => !it || typeof it !== "object" || !it.type);
              if (bad >= 0) throw new Error(`shapes[${bad}] has no "type". Every item names one — see /api/vfx/shapes.`);
              layer.shapes = b.shapes; changed.push("shapes");
            }
            if (b.animators !== undefined) {
              if (layer.type !== "text") throw new Error(`Animators are per-character text animation — this is a ${layer.type} layer.`);
              if (!Array.isArray(b.animators)) throw new Error("animators is an array.");
              layer.animators = b.animators; changed.push("animators");
            }
            if (b.styles !== undefined) {
              if (b.styles !== null && typeof b.styles !== "object") throw new Error("styles is an object, or null to clear it.");
              layer.styles = b.styles; changed.push("styles");
            }
            if (b.width !== undefined || b.height !== undefined) {
              if (layer.type !== "solid") throw new Error(`Only a solid has its own width and height — this is a ${layer.type} layer. Scale it with transform.scale instead.`);
              if (b.width !== undefined) { layer.width = clampInt(inRange(b.width, 1, 16384, "width"), 1, 16384); changed.push("width"); }
              if (b.height !== undefined) { layer.height = clampInt(inRange(b.height, 1, 16384, "height"), 1, 16384); changed.push("height"); }
            }

            if (b.start !== undefined) { layer.start = inRange(b.start, 0, d.duration, "start"); changed.push("start"); }
            if (b.end !== undefined) { layer.end = inRange(b.end, 0, d.duration, "end"); changed.push("end"); }
            if (layer.end <= layer.start) throw new Error("end must be after start.");
            if (b.inPoint !== undefined) { layer.inPoint = inRange(b.inPoint, -3600, 3600, "inPoint"); changed.push("inPoint"); }
            if (b.timeScale !== undefined) {
              const ts = inRange(b.timeScale, -100, 100, "timeScale");
              if (ts === 0) throw new Error("timeScale of 0 would freeze the layer forever — use 0.01, or trim it instead.");
              layer.timeScale = ts; changed.push("timeScale");
            }
            if (b.parent !== undefined) {
              if (b.parent === null || b.parent === "") layer.parent = null;
              else {
                const parent = findLayer(d, b.parent);
                if (parent.id === layer.id) throw new Error("A layer cannot be its own parent.");
                if (wouldCycle(d, layer.id, parent.id)) {
                  throw new Error(`Parenting ${layer.name} to ${parent.name} would make a loop.`);
                }
                layer.parent = parent.id;
              }
              changed.push("parent");
            }
            if (b.color !== undefined) { layer.color = rgbaOf(b.color, "color"); changed.push("color"); }
            if (b.text !== undefined) { layer.text = mergeText(layer.text, b.text); changed.push("text"); }
            if (b.transform !== undefined) {
              // Deep-merged per key on purpose: setting rotation alone must not
              // wipe the position somebody keyframed an hour ago.
              /* Delegated to resolvePropPath rather than consulting
               * TRANSFORM_ARITY directly. That table has five keys and no idea
               * about the 3D axes, and it pins a vector at two components — so
               * this merge rejected `transform.rotationX` outright (which is
               * exactly what the editor's X/Y rotation fields send, leaving
               * both boxes dead) and refused [x,y,z] on a 3D layer that
               * set_prop would have accepted. One resolver, one answer. */
              for (const [k, v] of Object.entries(b.transform)) {
                const ref = resolvePropPath(layer, `transform.${k}`);
                ref.owner[ref.key] = coerceProp(v, ref.arity, `transform.${k}`);
              }
              changed.push("transform");
            }
            if (b.effects !== undefined || b.masks !== undefined) {
              throw new Error("Effects and masks have their own actions (add_effect / set_effect / remove_effect, add_mask / set_mask / remove_mask).");
            }
            noteRun(d, { tool: "set_layer", outcome: `${layer.name}: ${changed.join(", ") || "nothing"}` });
            return d;
          });
          return json(res, 200, { ok: true, comp: doc }), true;
        }

        /* ── animatable properties ───────────────────────────────────── */

        case "set_prop": {
          const slug = need(b.slug, "comp slug");
          // The catalog lives outside the write lock — an effect param's arity
          // costs a subprocess the first time and must not be held under it.
          const arityHint = await propArityHint(slug, b);
          /* The canonical path and the key count go back in the reply. A caller
           * that said "opacity" cannot otherwise find what it just wrote — the
           * property it landed on is transform.opacity. */
          let wrote = null;
          const doc = await updateComp(slug, (d) => {
            const layer = findLayer(d, b.layerId ?? b.id);
            const ref = resolvePropPath(layer, b.path);
            const arity = ref.arity ?? arityHint;
            const keys = b.keys !== undefined ? b.keys : (isKeyed(b.value) ? b.value.keys : undefined);

            /* An expression does not REPLACE the property, it sits on top of
             * it: the constant or the keys underneath stay put, the expression
             * reads them as `value`, and removing it leaves what was already
             * there. So it is applied after whatever else this call sets, and
             * `{value: 65, expr: "value * 2"}` in one call does the obvious
             * thing rather than being a conflict. */
            const setsExpr = b.expr !== undefined;
            const clearsExpr = setsExpr && (b.expr === null || String(b.expr).trim() === "");

            /* value: null is the CLEAR door, and only where absence is a real
             * state. timeRemap is that property: absent means "play straight",
             * a constant is honoured by no render (interp.has_time_remap wants
             * keys or an expression), and Number(null) is 0 — so this used to
             * write a constant-0 remap that was stored, returned and ignored,
             * while the audio refusal kept telling people to "remove the
             * timeRemap" through a door that did not exist. */
            if (b.value === null && keys === undefined) {
              if (!(ref.kind === "layer" && ref.key === "timeRemap")) {
                throw new Error(
                  `value: null clears only timeRemap (absence is its off state). To reset ${ref.path} `
                  + `give it a number — an effect parameter goes back to its catalog default through `
                  + `set_effect with { <param>: null }.`,
                );
              }
              delete ref.owner[ref.key];
              wrote = { path: ref.path, keys: 0, cleared: true };
              noteRun(d, { tool: "set_prop", outcome: `${layer.name} ${ref.path}: cleared — the layer plays straight again` });
            } else if (keys !== undefined) {
              ref.owner[ref.key] = { keys: normalizeKeys(keys, { arity, label: ref.path }) };
              wrote = { path: ref.path, keys: ref.owner[ref.key].keys.length };
              noteRun(d, { tool: "set_prop", outcome: `${layer.name} ${ref.path}: ${keys.length} keyframes` });
            } else if (b.value !== undefined) {
              const v = normalizeValue(b.value, { label: ref.path });
              if (arity != null && arityOf(v) !== arity) {
                throw new Error(`${ref.path} takes ${arity} number(s), got ${arityOf(v)}.`);
              }
              const prev = ref.owner[ref.key];
              /* A BARE constant remap would be stored, returned, and read by
               * no render — the dead-control shape this API refuses to grow.
               * (Under an expression the constant is live: it is what the
               * expression reads as `value`, so that write stays legal.) */
              if (ref.kind === "layer" && ref.key === "timeRemap" && !hasExpr(prev) && !setsExpr) {
                throw new Error(
                  "A constant timeRemap is ignored by the engine — only a KEYED curve or an "
                  + "expression remaps. For a freeze-frame write one hold key: keys: "
                  + `[{ t: ${layer.start}, v: <source second>, ease: "hold" }]. `
                  + "value: null clears the remap.",
                );
              }
              // Keep an expression already on the property when only the value
              // underneath it is being changed.
              ref.owner[ref.key] = (hasExpr(prev) && !setsExpr) ? { ...prev, value: v } : v;
              wrote = { path: ref.path, keys: 0, value: v };
              noteRun(d, { tool: "set_prop", outcome: `${layer.name} ${ref.path} = ${JSON.stringify(v)}` });
            } else if (!setsExpr) {
              throw new Error(`set_prop needs "value" (a constant), "keys" (an array of { t, v, ease? }), or "expr" (an expression).`);
            }

            if (setsExpr) {
              const cur = ref.owner[ref.key];
              if (clearsExpr) {
                /* Unwrap rather than delete: the fallback underneath is the
                 * value the property should keep having. */
                if (hasExpr(cur)) {
                  if (isKeyed(cur)) ref.owner[ref.key] = { keys: cur.keys };
                  else if (ref.kind === "layer" && ref.key === "timeRemap") delete ref.owner[ref.key];
                  else ref.owner[ref.key] = (cur.value ?? 0);
                }
                wrote = { ...(wrote || { path: ref.path }), expr: null };
                noteRun(d, { tool: "set_prop", outcome: `${layer.name} ${ref.path}: expression removed` });
              } else {
                const expr = String(b.expr);
                if (expr.length > 4000) throw new Error("That expression is longer than 4000 characters.");
                const base = (cur && typeof cur === "object" && !Array.isArray(cur))
                  ? cur
                  : { value: cur === undefined ? (arity && arity > 1 ? new Array(arity).fill(0) : 0) : cur };
                ref.owner[ref.key] = { ...base, expr };
                wrote = { ...(wrote || { path: ref.path }), expr };
                noteRun(d, { tool: "set_prop", outcome: `${layer.name} ${ref.path}: expr ${expr.slice(0, 60)}` });
              }
            }
            return d;
          });
          return json(res, 200, { ok: true, ...wrote, comp: doc }), true;
        }

        case "add_key": {
          const slug = need(b.slug, "comp slug");
          const arityHint = await propArityHint(slug, b);
          const fallback = await catalogDefaultFor(slug, b);
          let wrote = null;
          const doc = await updateComp(slug, (d) => {
            const layer = findLayer(d, b.layerId ?? b.id);
            const ref = resolvePropPath(layer, b.path);
            const t = inRange(b.t, -3600, 3600, "t");
            const cur = ref.owner[ref.key] === undefined ? fallback : ref.owner[ref.key];
            if (cur === undefined || cur === null) {
              throw new Error(`${ref.path} has no value yet and the catalog does not name a default — pass "v".`);
            }
            /* This is the stopwatch. Turning one on writes a key at the
             * playhead holding what the property is worth RIGHT NOW, so the
             * picture does not move the instant it becomes animated — which is
             * why `v` is optional and the constant is the fallback. */
            const v = b.v === undefined ? evalProp(cur, t) : b.v;
            const arity = ref.arity ?? arityHint ?? arityOf(isKeyed(cur) ? (cur.keys[0]?.v ?? 0) : cur);
            const ease = b.ease === undefined ? undefined : normalizeEase(b.ease, ref.path);

            const existing = isKeyed(cur)
              // A second key at the same instant is not an animation, it is a
              // coin toss — setting a value at a time that already has one
              // REPLACES it, exactly as a stopwatch does.
              ? cur.keys.filter((k) => Math.abs(Number(k.t) - t) > 1e-3)
              : [];
            const keys = normalizeKeys(
              [...existing, { t, v, ...(ease === undefined ? {} : { ease }) }],
              { arity, label: ref.path },
            );
            ref.owner[ref.key] = { keys };
            wrote = { path: ref.path, keys: keys.length };
            noteRun(d, {
              tool: "add_key",
              outcome: `${layer.name} ${ref.path} @${t}s${isKeyed(cur) ? "" : " (was a constant)"} — ${keys.length} keys`,
            });
            return d;
          });
          return json(res, 200, { ok: true, ...wrote, comp: doc }), true;
        }

        case "remove_key": {
          let wrote = null;
          const doc = await updateComp(need(b.slug, "comp slug"), (d) => {
            const layer = findLayer(d, b.layerId ?? b.id);
            const ref = resolvePropPath(layer, b.path);
            const t = inRange(b.t, -3600, 3600, "t");
            const cur = ref.owner[ref.key];
            if (!isKeyed(cur)) throw new Error(`${ref.path} is a constant — it has no keyframes.`);
            const keep = cur.keys.filter((k) => Math.abs(Number(k.t) - t) > 1e-3);
            if (keep.length === cur.keys.length) {
              throw new Error(`No keyframe within a millisecond of t=${t} on ${ref.path}. It has keys at ${cur.keys.map((k) => k.t).join(", ")}.`);
            }
            if (!keep.length) {
              /* The last key out collapses the property back to a constant —
               * holding the value it had, so removing the animation does not
               * also move the layer. An empty `keys` array would be a property
               * with no value at all, which §1 has no reading for.
               *
               * EXCEPT timeRemap: a constant remap is ignored by the engine,
               * so collapsing to one would leave a field that is stored,
               * returned, and honoured by nothing — absence is the honest
               * collapse, and the layer plays straight, which is also what
               * the ignored constant was already rendering. */
              if (ref.kind === "layer" && ref.key === "timeRemap" && !hasExpr(cur)) {
                delete ref.owner[ref.key];
              } else {
                ref.owner[ref.key] = evalProp(cur, t);
              }
            } else {
              ref.owner[ref.key] = { keys: normalizeKeys(keep, { label: ref.path }) };
            }
            wrote = { path: ref.path, keys: keep.length };
            noteRun(d, { tool: "remove_key", outcome: `${layer.name} ${ref.path} @${t}s — ${keep.length} left` });
            return d;
          });
          return json(res, 200, { ok: true, ...wrote, comp: doc }), true;
        }

        /* ── effects ─────────────────────────────────────────────────── */

        case "add_effect": {
          const slug = need(b.slug, "comp slug");
          const type = String(b.type || "").trim();
          if (!type) throw new Error("Give an effect type — call GET /api/vfx/catalog for the list.");
          const cat = await catalogOrNull();
          if (cat && !cat[type]) {
            const near = Object.keys(cat).filter((k) => k.toLowerCase().includes(type.toLowerCase().slice(0, 5)));
            throw new Error(`No effect called "${type}".${near.length ? ` Did you mean: ${near.slice(0, 6).join(", ")}?` : ""} The catalog is at GET /api/vfx/catalog.`);
          }
          const { params: defaults } = await defaultsFor(type);
          let newFxId = null;
          const doc = await updateComp(slug, (d) => {
            const layer = findLayer(d, b.layerId ?? b.id);
            if (layer.effects.length >= LIMITS.effectsPerLayer) {
              throw new Error(`A layer holds at most ${LIMITS.effectsPerLayer} effects.`);
            }
            const params = { ...defaults };
            for (const [k, v] of Object.entries(b.params || {})) {
              if (cat && cat[type]?.params && !(k in cat[type].params)) {
                throw new Error(`"${type}" has no parameter "${k}". It takes: ${Object.keys(cat[type].params).join(", ")}.`);
              }
              params[k] = v;
            }
            const fx = blankEffect(type, params);
            if (b.enabled !== undefined) fx.enabled = !!b.enabled;
            const at = b.index === undefined ? layer.effects.length : clampInt(inRange(b.index, 0, layer.effects.length, "index"), 0, layer.effects.length);
            layer.effects.splice(at, 0, fx);
            noteRun(d, { tool: "add_effect", outcome: `${layer.name}: ${type} (${fx.id})` });
            newFxId = fx.id;
            return d;
          });
          return json(res, 200, { ok: true, effectId: newFxId, catalog: cat ? "checked" : "unavailable", comp: doc }), true;
        }

        case "set_effect": {
          const slug = need(b.slug, "comp slug");
          const cat = await catalogOrNull();
          const doc = await updateComp(slug, (d) => {
            const layer = findLayer(d, b.layerId ?? b.id);
            const fx = pickEffect(layer, b.fxId ?? b.effectId ?? b.type);
            if (b.enabled !== undefined) fx.enabled = !!b.enabled;
            // Partial by definition: a params object names the ones it changes
            // and everything else keeps the value (or the keyframes) it had.
            for (const [k, v] of Object.entries(b.params || {})) {
              if (cat && cat[fx.type]?.params && !(k in cat[fx.type].params)) {
                throw new Error(`"${fx.type}" has no parameter "${k}". It takes: ${Object.keys(cat[fx.type].params).join(", ")}.`);
              }
              if (v === null) delete fx.params[k];           // back to the catalog default
              else if (isKeyed(v)) fx.params[k] = { keys: normalizeKeys(v.keys, { label: `${fx.type}.${k}` }) };
              else fx.params[k] = v;
            }
            noteRun(d, { tool: "set_effect", outcome: `${layer.name} ${fx.type}: ${Object.keys(b.params || {}).join(", ") || "enabled"}` });
            return d;
          });
          return json(res, 200, { ok: true, comp: doc }), true;
        }

        case "remove_effect": {
          const doc = await updateComp(need(b.slug, "comp slug"), (d) => {
            const layer = findLayer(d, b.layerId ?? b.id);
            const fx = pickEffect(layer, b.fxId ?? b.effectId ?? b.type);
            layer.effects.splice(layer.effects.indexOf(fx), 1);
            noteRun(d, { tool: "remove_effect", outcome: `${layer.name}: ${fx.type} removed` });
            return d;
          });
          return json(res, 200, { ok: true, comp: doc }), true;
        }

        case "reorder_effect": {
          const doc = await updateComp(need(b.slug, "comp slug"), (d) => {
            const layer = findLayer(d, b.layerId ?? b.id);
            const fx = pickEffect(layer, b.fxId ?? b.effectId ?? b.type);
            const from = layer.effects.indexOf(fx);
            const to = clampInt(inRange(b.toIndex, 0, layer.effects.length - 1, "toIndex"), 0, layer.effects.length - 1);
            layer.effects.splice(from, 1);
            layer.effects.splice(to, 0, fx);
            noteRun(d, { tool: "reorder_effect", outcome: `${layer.name} ${fx.type}: ${from} → ${to}` });
            return d;
          });
          return json(res, 200, { ok: true, comp: doc }), true;
        }

        /* ── masks and mattes ────────────────────────────────────────── */

        case "add_mask": {
          let newMaskId = null;
          const doc = await updateComp(need(b.slug, "comp slug"), (d) => {
            const layer = findLayer(d, b.layerId ?? b.id);
            if (layer.masks.length >= LIMITS.masksPerLayer) {
              throw new Error(`A layer holds at most ${LIMITS.masksPerLayer} masks.`);
            }
            const mask = blankMask(pointsOf(b.points), maskPatch(b));
            layer.masks.push(mask);
            noteRun(d, { tool: "add_mask", outcome: `${layer.name}: ${mask.mode} mask, ${mask.points.length} points` });
            newMaskId = mask.id;
            return d;
          });
          return json(res, 200, { ok: true, maskId: newMaskId, comp: doc }), true;
        }

        case "set_mask": {
          const doc = await updateComp(need(b.slug, "comp slug"), (d) => {
            const layer = findLayer(d, b.layerId ?? b.id);
            const mask = layer.masks.find((m) => m.id === (b.maskId ?? b.mkId));
            if (!mask) throw new Error(`No such mask on ${layer.id}: ${b.maskId ?? b.mkId}.`);
            if (b.points !== undefined) mask.points = pointsOf(b.points);
            Object.assign(mask, maskPatch(b));
            noteRun(d, { tool: "set_mask", outcome: `${layer.name} ${mask.id}` });
            return d;
          });
          return json(res, 200, { ok: true, comp: doc }), true;
        }

        case "remove_mask": {
          const doc = await updateComp(need(b.slug, "comp slug"), (d) => {
            const layer = findLayer(d, b.layerId ?? b.id);
            const at = layer.masks.findIndex((m) => m.id === (b.maskId ?? b.mkId));
            if (at < 0) throw new Error(`No such mask on ${layer.id}: ${b.maskId ?? b.mkId}.`);
            layer.masks.splice(at, 1);
            noteRun(d, { tool: "remove_mask", outcome: `${layer.name}: mask removed` });
            return d;
          });
          return json(res, 200, { ok: true, comp: doc }), true;
        }

        case "set_matte": {
          const doc = await updateComp(need(b.slug, "comp slug"), (d) => {
            const layer = findLayer(d, b.layerId ?? b.id);
            const type = b.type ?? b.matte ?? null;
            if (type === null || type === "none" || type === "") {
              layer.trackMatte = null;
            } else {
              if (!MATTE_TYPES.includes(type)) throw new Error(`Track matte type must be one of: ${MATTE_TYPES.join(", ")}, or null.`);
              /* AE's rule, §1: the matte is the layer DIRECTLY ABOVE. Index 0
               * has nothing above it, so this would be a setting that renders
               * as nothing and looks like a broken engine. */
              if (d.layers.indexOf(layer) === 0) {
                throw new Error(`"${layer.name}" is the top layer — a track matte uses the layer directly above it. Move it down first.`);
              }
              layer.trackMatte = { type };
            }
            noteRun(d, { tool: "set_matte", outcome: `${layer.name}: ${layer.trackMatte?.type ?? "none"}` });
            return d;
          });
          return json(res, 200, { ok: true, comp: doc }), true;
        }

        /* ── precompose ──────────────────────────────────────────────── */

        /**
         * AE's precompose, "move all attributes" — the LIVE one. [precomp-nested]
         *
         * The comment that used to sit here said a precomp could not be a live
         * nested render because §1 had no "comp" layer type. It has one now —
         * resolveChildComps and the engine's _child_comp render a layer of
         * type "comp" whose `src` names another comp's slug — so this action
         * is the real gesture: the named layers MOVE into a new comp of the
         * same width/height/fps/duration, byte for byte (ids, keyframes,
         * expressions, effects — everything), and ONE comp layer takes the
         * place of the topmost of them, spanning the parent's timeline. With
         * normal blends and no cross-boundary links, the rendered frame before
         * and after is the same picture — that is the claim of precompose, and
         * scripts/e2e_vfx.mjs proves it byte for byte.
         *
         * What crosses the boundary is handled the way AE handles it, WARNED
         * rather than silently:
         *   · a parent link with one end on each side is BROKEN (both
         *     directions — a moved child of a staying parent, and a staying
         *     child of a moved parent);
         *   · a track matte pair split across the boundary is broken — the
         *     matte is positional (the layer directly above), so leaving it
         *     set would silently matte against whatever lands there next;
         *   · an expression naming a layer on the other side (matched the way
         *     expressions.py resolves layer("x"): name first, then id, within
         *     one document) will fail at render — warned, not blocked, because
         *     the author may be about to fix the expression.
         * Precomposing EVERY layer is legal, as it is in AE: the parent is
         * left holding just the comp layer.
         *
         * AE's other mode, "leave all attributes" — transforms/effects/timing
         * stay on the parent layer and only the source goes down — is refused
         * by name below. Half-building it would corrupt timing silently.
         *
         * ORDERING: the child comp is created and filled BEFORE the parent is
         * touched, so a failure anywhere leaves the parent exactly as it was
         * (at worst an orphan comp sits in the picker, and the error names
         * it). The parent write re-checks the moved layers still exist, since
         * another writer may have slipped in between the read and the write.
         */
        case "precompose": {
          const slug = need(b.slug, "comp slug");
          if (b.leaveAttributes || b.mode === "leave") {
            throw new Error(
              "Only AE's \"move all attributes\" is built: the selected layers go into the "
              + "new comp unchanged and one comp layer replaces them. \"Leave all attributes\" "
              + "— keeping the transforms, effects and timing on the parent layer and sending "
              + "only the source down — is not implemented, and half of it would corrupt "
              + "timing silently. Drop the flag to precompose the normal way.");
          }
          const parent = await readComp(slug);
          if (!parent) throw new Error(`No such comp: ${slug}`);
          const ids = Array.isArray(b.layerIds) ? b.layerIds : [];
          if (!ids.length) throw new Error("Give layerIds — the layers to move into the new comp.");
          const moving = ids.map((id) => findLayer(parent, id));   // throws, naming an unknown id
          const movingIds = new Set(moving.map((l) => l.id));
          if (movingIds.size !== moving.length) {
            throw new Error("layerIds names the same layer twice — each layer moves once.");
          }

          /* AE's default name, AE's numbering: "Pre-comp N", the next free N. */
          let pcpName = String(b.name || "").trim().slice(0, 80);
          if (!pcpName) {
            const used = (await listComps())
              .map((c) => /^Pre-comp (\d+)$/.exec(String(c.name)))
              .filter(Boolean).map((m) => Number(m[1]));
            pcpName = `Pre-comp ${used.length ? Math.max(...used) + 1 : 1}`;
          }

          const child = await createComp(pcpName, {
            width: parent.width, height: parent.height, fps: parent.fps, duration: parent.duration,
            bg: [0, 0, 0, 0],                     // a precomp composites as its layers only
          });

          /* The boundary casualties, computed from the ORIGINAL stack. */
          const pcpWarnings = [];
          const who = (l) => `"${l.name}" (${l.id})`;
          const layersById = new Map(parent.layers.map((l) => [l.id, l]));
          const cutParents = new Set();           // layers whose parent link is broken
          for (const l of parent.layers) {
            const p = l.parent ? layersById.get(l.parent) : null;
            if (!p || movingIds.has(l.id) === movingIds.has(p.id)) continue;
            cutParents.add(l.id);
            pcpWarnings.push(movingIds.has(l.id)
              ? `parent link broken: ${who(l)} was parented to ${who(p)}, which stayed behind — the link is cut, as AE cuts it.`
              : `parent link broken: ${who(l)} was parented to ${who(p)}, which moved into ${child.slug} — the link is cut, as AE cuts it.`);
          }
          const cutMattes = new Set();            // matted layers whose matte is now elsewhere
          parent.layers.forEach((l, i) => {
            if (!l.trackMatte) return;
            const matte = parent.layers[i - 1];   // AE's rule: the matte is DIRECTLY above
            if (!matte) {
              // only a hand-edited document puts a matte on the top layer;
              // moving it cannot break what never resolved, so nothing to say
              return;
            }
            if (movingIds.has(l.id) === movingIds.has(matte.id)) return;
            cutMattes.add(l.id);
            pcpWarnings.push(movingIds.has(l.id)
              ? `track matte broken: ${who(l)} was matted by ${who(matte)}, which stayed behind — the matte pair is split, so the matte was cleared.`
              : `track matte broken: ${who(l)} was matted by ${who(matte)}, which moved into ${child.slug} — the matte pair is split, so the matte was cleared.`);
          });
          /* Expressions that reach across the boundary. Matched the way
           * expressions.py resolves layer("x") — a NAME anywhere in the same
           * document first, then an id — so a ref that still lands on the
           * layer's own side is left alone and only the ones that now resolve
           * to nothing are named. A best-effort grep, exactly as advertised:
           * a ref built at runtime from strings cannot be seen from here. */
          const exprRefsOf = (node, path, out) => {
            if (!node || typeof node !== "object") return out;
            if (typeof node.expr === "string" && node.expr.trim()) {
              for (const m of node.expr.matchAll(/layer\(\s*(["'])((?:(?!\1).)*)\1\s*\)/g)) {
                out.push({ path, ref: m[2] });
              }
            }
            for (const [k, v] of Object.entries(node)) {
              if (k !== "expr" && v && typeof v === "object") exprRefsOf(v, path ? `${path}.${k}` : k, out);
            }
            return out;
          };
          const resolves = (side, ref) => side.some((l) => l.name === ref || l.id === ref);
          const stayers = parent.layers.filter((l) => !movingIds.has(l.id));
          for (const l of parent.layers) {
            const moved = movingIds.has(l.id);
            const sameSide = moved ? moving : stayers;
            const otherSide = moved ? stayers : moving;
            for (const { path, ref } of exprRefsOf(l, "", [])) {
              if (resolves(sameSide, ref) || !resolves(otherSide, ref)) continue;
              pcpWarnings.push(moved
                ? `expression will fail: ${who(l)} at ${path} references layer("${ref}"), which stayed behind — inside ${child.slug} that name resolves to nothing.`
                : `expression will fail: ${who(l)} at ${path} references layer("${ref}"), which moved into ${child.slug} — here that name now resolves to nothing.`);
            }
          }

          await updateComp(child.slug, (c) => {
            /* Verbatim copies in the parent's stacking order — the ONLY edits
             * are the boundary breaks warned about above. Everything else the
             * layer carries (fields this file has never heard of included)
             * survives byte for byte, which the e2e deep-compares. */
            c.layers = parent.layers.filter((l) => movingIds.has(l.id)).map((l) => {
              const copy = JSON.parse(JSON.stringify(l));
              if (cutParents.has(copy.id)) copy.parent = null;
              if (cutMattes.has(copy.id)) copy.trackMatte = null;
              return copy;
            });
            noteRun(c, { tool: "precompose", outcome: `${c.layers.length} layer(s) moved in from ${parent.slug}` });
            return c;
          });

          let holderId = null;
          const doc = await updateComp(slug, (d) => {
            const gone = [...movingIds].filter((id) => !d.layers.some((l) => l.id === id));
            if (gone.length) {
              throw new Error(
                `The comp changed while precomposing — ${gone.join(", ")} no longer exist${gone.length === 1 ? "s" : ""} in ${slug}. `
                + `Nothing was removed. The new comp ${child.slug} holds copies; delete it, or precompose again.`);
            }
            /* Every layer above the topmost moved one stays, so the topmost
             * moved index in the ORIGINAL stack is exactly where the comp
             * layer belongs in the filtered one — AE's placement. */
            const at = Math.min(...moving.map((l) => d.layers.findIndex((x) => x.id === l.id)));
            d.layers = d.layers.filter((l) => !movingIds.has(l.id));
            for (const l of d.layers) {
              if (cutParents.has(l.id)) l.parent = null;
              if (cutMattes.has(l.id)) l.trackMatte = null;
            }
            const holder = blankLayer(d, "comp", { name: pcpName });
            holder.src = child.slug;              // the engine's contract: src IS the child's slug
            holder.start = 0;
            holder.end = d.duration;              // spans the parent, as AE's does
            d.layers.splice(clampInt(at, 0, d.layers.length), 0, holder);
            noteRun(d, { tool: "precompose", outcome: `${moving.length} layer(s) → ${child.slug}${pcpWarnings.length ? ` (${pcpWarnings.length} warning(s))` : ""}` });
            holderId = holder.id;
            return d;
          });
          return json(res, 200, {
            ok: true, comp: doc, precompSlug: child.slug, layerId: holderId,
            moved: moving.length, warnings: pcpWarnings,
          }), true;
        }

        /* ── the Studio timeline, both directions ────────────────────── */

        /**
         * A Studio project in: every video item becomes a layer on the comp
         * timeline where it sat on the Studio one.
         *
         * Studio's track array is in display order and `videoTracks().reverse()`
         * is what it paints bottom-first — so the FIRST video track is the top
         * one, which is exactly AE's layers[0]. The orders match with no
         * flipping, and that is worth stating because getting it wrong is
         * invisible until two layers overlap.
         *
         * AUDIO: two homes, the caller's choice. The default is the original
         * contract — each audio item lands as a MARKER at its start, and the
         * Studio timeline keeps owning the song for the export_studio round
         * trip (Studio plays video tracks MUTED, so a song baked into an
         * exported clip would be a song the timeline cannot hear). Pass
         * audioAs: "layers" and the items become real audio layers instead —
         * a direct movie render then carries the mix, which is the music-video
         * path. Dropping them silently was never on the table either way.
         */
        case "import_studio": {
          const file = studioFile(b.project ?? b.file ?? b.name);
          const proj = await readStudioProject(file);
          if (!Array.isArray(proj.tracks)) throw new Error(`${file} has no tracks — that is not a Studio project.`);

          const vids = [], auds = [], missing = [];
          for (const tr of proj.tracks) {
            for (const it of (tr.items || [])) {
              const name = libNameOf(it.src);
              const row = {
                name: String(it.name || name).slice(0, 80),
                src: name,
                start: Number(it.start) || 0,
                dur: Number(it.dur) || 0,
                inPoint: Number(it.inPoint) || 0,
              };
              if (tr.kind === "audio") auds.push(row); else vids.push(row);
            }
          }
          if (!vids.length && !auds.length) throw new Error(`${file} has no items on any track.`);

          const audioAs = b.audioAs === "layers" ? "layers" : "markers";
          for (const v of vids) {
            const dir = IMAGE_EXT.test(v.src) ? IMAGE_DIR : CLIP_DIR;
            try { await stat(path.join(dir, v.src)); } catch { missing.push(v.src); }
          }
          if (audioAs === "layers") {
            for (const a of auds) {
              if (!await audioSourcePath(a.src)) missing.push(a.src);
            }
          }

          const out = proj.out || {};
          const spanOf = (rows) => rows.reduce((a, r) => Math.max(a, r.start + r.dur), 0);
          // The picture decides the length. A 158-second song under 105 seconds
          // of video would otherwise buy 53 seconds of black.
          const span = vids.length ? spanOf(vids) : spanOf(auds);

          const comp = await createComp(b.name || proj.name || file.replace(/\.json$/, ""), {
            width: clampInt(Number(out.w) || 1920, LIMITS.minSize, LIMITS.maxSize),
            height: clampInt(Number(out.h) || 1080, LIMITS.minSize, LIMITS.maxSize),
            fps: clamp(Number(out.fps) || 30, LIMITS.minFps, LIMITS.maxFps),
            duration: clamp(span || 8, LIMITS.minDuration, LIMITS.maxDuration),
            bg: [0, 0, 0, 255],                   // a timeline import is opaque, like Studio
          });

          const doc = await updateComp(comp.slug, (d) => {
            for (const v of vids.slice(0, LIMITS.layers)) {
              const type = IMAGE_EXT.test(v.src) ? "image" : "video";
              const layer = blankLayer(d, type, { name: v.name });
              layer.src = v.src;
              layer.start = clamp(v.start, 0, d.duration);
              layer.end = clamp(v.start + (v.dur || d.duration), layer.start + 1 / d.fps, d.duration);
              layer.inPoint = v.inPoint;
              d.layers.push(layer);
            }
            if (audioAs === "layers") {
              /* Bottom of the stack, where sound belongs visually — an audio
               * layer paints nothing, so its index only affects reading. */
              for (const a of auds) {
                if (d.layers.length >= LIMITS.layers) break;
                const layer = blankLayer(d, "audio", { name: a.name });
                layer.src = a.src;
                layer.start = clamp(a.start, 0, d.duration);
                layer.end = clamp(a.start + (a.dur || d.duration), layer.start + 1 / d.fps, d.duration);
                layer.inPoint = a.inPoint;
                d.layers.push(layer);
              }
            } else {
              for (const a of auds) {
                d.markers.push({ t: clamp(a.start, 0, d.duration), label: `audio: ${a.name}` });
              }
            }
            d.markers.sort((x, y) => x.t - y.t);
            noteRun(d, {
              tool: "import_studio",
              outcome: `${file}: ${d.layers.length} layers, ${auds.length} audio item(s) as ${audioAs}`,
            });
            return d;
          });
          return json(res, 200, {
            ok: true, slug: doc.slug, comp: doc,
            layers: doc.layers.length,
            audioAsMarkers: audioAs === "markers" ? auds.length : 0,
            audioAsLayers: audioAs === "layers" ? auds.length : 0,
            missingSources: missing,
            note: !auds.length ? undefined : audioAs === "layers"
              ? "The audio items are audio LAYERS — a movie render of this comp carries their mix. If you export_studio it back onto a timeline, remember Studio plays video tracks muted; keep the song on the Studio timeline for that flow instead."
              : "The audio items were recorded as markers (the default) — the Studio timeline owns the song on export. Pass audioAs: \"layers\" to import them as audio layers instead, so a direct render carries the mix.",
          }), true;
        }

        /**
         * Out the other way: render the comp, then drop the clip on a Studio
         * timeline. The render is a job, so this answers with its id and
         * places the clip when it lands — a route that held the socket open for
         * the four minutes a 1080p render takes would be timed out by every
         * client in the building.
         */
        case "export_studio": {
          const slug = need(b.slug, "comp slug");
          const projectName = String(b.project || b.name || "").trim();
          if (!projectName) throw new Error("Give a Studio project name to export into (an existing one is appended to).");
          const format = b.format === "mov" ? "mov" : "mp4";
          /* Since comps grew sound the exported clip can carry a mix — but
           * Studio plays VIDEO tracks muted (timelinemix.py bounces them
           * silent too), so a song baked into this clip is a song the
           * timeline cannot hear. Said in the reply rather than discovered
           * in an edit; the Studio timeline owning the song is still the
           * round-trip contract. Audio layers are the certain case; a video
           * layer is flagged only when its probe SAW a track. */
          const exportDoc = await readComp(slug);
          const carriesAudio = !!exportDoc?.layers?.some((l) =>
            l.enabled !== false && l.audio !== false
            && (l.type === "audio" || (l.type === "video" && l.srcHasAudio === true)));

          const rec = await startRender(slug, { ...b, format }, async (done) => {
            const file = studioFile(projectName);
            let proj = null;
            try { proj = await readStudioProject(file); } catch { /* a new project is fine */ }
            if (!proj || !Array.isArray(proj.tracks)) {
              proj = { v: 1, tracks: [], fx: {}, out: {}, t: 0 };
            }
            const comp = await readComp(slug);
            let track = proj.tracks.find((t) => t.kind === "video");
            if (!track) {
              track = { id: Date.now(), kind: "video", name: "Video 1", muted: false, solo: false, level: 1, items: [] };
              proj.tracks.unshift(track);         // video tracks live at the top, as Studio adds them
            }
            const dur = Number((done.to - done.from).toFixed(3));
            const end = track.items.reduce((a, it) => Math.max(a, (it.start || 0) + (it.dur || 0)), 0);
            const item = {
              id: Date.now(),
              name: comp?.name || slug,
              src: `/api/clip/${done.name}`,
              start: b.start === undefined ? end : Math.max(0, Number(b.start) || 0),
              dur, inPoint: 0, srcDur: dur,
              vfxComp: slug,                       // the pointer home, mv's trick
            };
            track.items.push(item);
            track.items.sort((x, y) => x.start - y.start);
            if (comp) proj.out = { ...(proj.out || {}), w: comp.width, h: comp.height, fps: comp.fps };
            done.studio = await writeStudioProject(projectName, proj);
            done.studio.item = item;
          }, actor);

          return json(res, 200, {
            ok: true, jobId: rec.id, project: projectName,
            note: `Rendering. Poll GET /api/vfx/comp/${slug} → renders[] for this job id; the clip is placed on the Studio timeline when it finishes.`
              + (carriesAudio
                ? " This comp carries audio: it is muxed into the clip, but Studio plays VIDEO tracks muted — keep the song on the Studio timeline (an audio track) for the edit to hear it."
                : ""),
          }), true;
        }

        /* ── render ──────────────────────────────────────────────────── */

        case "render": {
          const rec = await startRender(need(b.slug, "comp slug"), b, null, actor);
          return json(res, 200, {
            ok: true, jobId: rec.id, format: rec.format, clip: rec.name, out: rec.out,
            note: `Poll GET /api/vfx/comp/${rec.slug} → renders[] for progress.`,
          }), true;
        }

        /* ── RAM preview ─────────────────────────────────────────────── */

        /**
         * Fill the cache over the work area so playback can be playback rather
         * than three hundred round trips. Answers immediately with a job id.
         */
        case "prewarm": {
          const slug = need(b.slug, "comp slug");
          const { rec, rejoined, superseded, clamped, idx } = await startPrewarm(slug, b);
          return json(res, 200, {
            ok: true, jobId: rec.id, slug: rec.slug, rejoined, superseded,
            from: rec.from, to: rec.to, fps: rec.fps, frames: idx,
            scale: rec.scale, draft: rec.draft, concurrency: rec.lanes,
            already: rec.already, clamped, capFrames: DISK_KEEP,
            note: clamped
              ? `Clamped to ${DISK_KEEP} frames (${rec.from}s–${rec.to}s) — the disk cache holds no more, and rendering past it would only evict the start. Poll GET /api/vfx/cache/${rec.slug} or GET /api/vfx/comp/${rec.slug} → prewarms[].`
              : `Poll GET /api/vfx/comp/${rec.slug} → prewarms[] for progress, or GET /api/vfx/cache/${rec.slug} for what is playable now.`,
          }), true;
        }

        /**
         * Stop filling. Frames already made are KEPT — they cost what they
         * cost and the next play is entitled to them.
         */
        case "prewarm_cancel": {
          const jobId = b.jobId ? String(b.jobId) : null;
          const slug = b.slug === undefined ? null : need(b.slug, "comp slug");
          if (!jobId && !slug) throw new Error("Give a jobId, or a slug to stop every prewarm on that comp.");
          const cancelled = cancelPrewarms({ jobId, slug });
          return json(res, 200, {
            ok: true, cancelled,
            note: cancelled.length
              ? "Frames already rendered stay cached."
              : "Nothing was running — every prewarm for that id or comp had already finished.",
          }), true;
        }

        case "add_shape_preset": {
          const slug = need(b.slug, "comp slug");
          /* A fixed set, because the name is interpolated into a python import.
           * Never widen this to "whatever the caller said". */
          const PRESETS = {
            lineDraw: { fn: "line_draw", keys: ["points", "color", "width", "duration", "start", "cap", "join", "name"] },
            progressRing: { fn: "progress_ring", keys: ["radius", "width", "color", "track", "from_pct", "to_pct", "duration", "start", "name"] },
            burst: { fn: "burst", keys: ["rays", "length", "inner", "width", "color", "spin", "duration", "name"] },
          };
          const chosen = PRESETS[String(b.preset || "")];
          if (!chosen) {
            throw new Error(`No shape preset "${b.preset}". They are: ${Object.keys(PRESETS).join(", ")}.`);
          }
          /* Refuse rather than filter. The key list has to exist — the kwargs go
           * to one specific python signature — but quietly dropping what does
           * not fit means a burst asked to start at t=2 starts at 0, returns
           * 200, and says nothing. Naming the presets that DO take it is the
           * difference between a refusal someone can act on and a mystery. */
          const IGNORE = new Set(["action", "slug", "preset", "name", "index"]);
          const offered = Object.keys(b).filter((k) => !IGNORE.has(k));
          const unsupported = offered.filter((k) => !chosen.keys.includes(k));
          if (unsupported.length) {
            const elsewhere = unsupported.map((k) => {
              const takers = Object.entries(PRESETS).filter(([, p]) => p.keys.includes(k)).map(([n]) => n);
              return takers.length ? `${k} (${takers.join(", ")} take it)` : `${k} (no preset takes it)`;
            });
            throw new Error(`"${b.preset}" does not take ${elsewhere.join("; ")}. It takes: ${chosen.keys.join(", ")}.`);
          }
          const kwargs = {};
          for (const k of chosen.keys) if (b[k] !== undefined) kwargs[k] = b[k];

          const built = await new Promise((resolve, reject) => {
            const proc = spawnPython(["-c", SHAPE_PRESET_PROG(chosen.fn, kwargs)]);
            let so = "", se = "";
            const timer = setTimeout(() => proc.kill(), 30_000);
            proc.stdout.on("data", (d) => { so += d; });
            proc.stderr.on("data", (d) => { se += d; });
            proc.on("error", (e) => { clearTimeout(timer); reject(new Error(`Could not start python: ${e.message}`)); });
            proc.on("close", (code) => {
              clearTimeout(timer);
              const tail = so.trim().split(/\r?\n/).pop();
              if (code !== 0 || !tail) reject(new Error(se.trim().slice(-300) || `shapes.py exit ${code}`));
              else { try { resolve(JSON.parse(tail)); } catch { reject(new Error(`shapes.py did not answer with JSON: ${tail.slice(0, 160)}`)); } }
            });
          });

          let newId = null;
          const doc = await updateComp(slug, (d) => {
            if (d.layers.length >= 64) throw new Error("A comp holds at most 64 layers.");
            const layer = blankLayer(d, "shape", { name: b.name || built.name || "shape" });
            layer.shapes = built.shapes;
            newId = layer.id;
            const at = b.index === undefined ? 0 : clampInt(b.index, 0, d.layers.length);
            d.layers.splice(at, 0, layer);
            noteRun(d, { tool: "add_shape_preset", outcome: `${layer.name} (${b.preset})` });
            return d;
          });
          return json(res, 200, {
            ok: true, layerId: newId, preset: b.preset,
            items: built.shapes?.length ?? 0, comp: doc,
          }), true;
        }

        /* ── FXPRESETS: effect/animation presets ─────────────────────────
         *
         * A configured effect stack — params, keyframes, expressions — and
         * optionally the layer's keyframed TRANSFORM move, saved under a name
         * on the app-level shelf (store.js: <outputDir>/vfx/_fx_presets.json),
         * listed, applied anywhere. AE's Animation Presets, scoped sanely.
         *
         * The TIME RULE and the MERGE RULE (paste semantics) are documented
         * once, on the shelf itself — see FXPRESETS in store.js. In short:
         * stored key times are relative, zero at the source layer's `start`;
         * apply writes them at `at` + t_rel, `at` defaulting to the TARGET
         * layer's `start`; pasted keys replace existing keys only inside the
         * range they cover, and an expression on the property stays on top.
         */

        case "save_fx_preset": {
          const slug = need(b.slug, "comp slug");
          const doc = await readComp(slug);
          if (!doc) throw new Error(`No such comp: ${slug}`);
          const layer = findLayer(doc, b.layerId ?? b.id);
          const name = String(b.name || "").trim().slice(0, FX_PRESET_LIMITS.nameLen);
          if (!name) throw new Error("Give the preset a name.");

          /* Which effects ride along. `include` filters by effect id or type;
           * an entry matching nothing is refused naming what IS there —
           * quietly saving a smaller stack than asked is the silent failure
           * this file keeps relearning. */
          let chosen = layer.effects || [];
          if (b.include !== undefined) {
            if (!Array.isArray(b.include) || !b.include.length) {
              throw new Error(`"include" is a non-empty array of effect ids or types — or leave it out to save the whole stack.`);
            }
            const picked = [];
            for (const ref of b.include) {
              const id = String(ref);
              const byId = chosen.filter((f) => f.id === id);
              const hits = byId.length ? byId : chosen.filter((f) => f.type === id);
              if (!hits.length) {
                throw new Error(`include: no effect "${id}" on ${layer.id}. It has ${chosen.map((f) => `${f.id} (${f.type})`).join(", ") || "no effects"}.`);
              }
              for (const f of hits) if (!picked.includes(f)) picked.push(f);
            }
            chosen = picked;
          }

          // Relative time: zero at the layer's start (see FXPRESETS, store.js).
          const dt = -(Number(layer.start) || 0);
          const effects = chosen.map((f) => ({
            type: f.type,
            enabled: f.enabled !== false,
            // Stored WITHOUT the id — apply mints fresh ones, never reuses.
            params: Object.fromEntries(Object.entries(f.params || {}).map(([k, v]) => [k, shiftPropTimes(v, dt)])),
          }));

          const wantTransform = !!(b.includeTransform ?? b.include_transform);
          let transform = null;
          if (wantTransform) {
            transform = {};
            for (const [k, v] of Object.entries(layer.transform || {})) {
              if (isAnimated(v)) transform[k] = shiftPropTimes(v, dt);
            }
            if (!Object.keys(transform).length) transform = null;
          }

          if (!effects.length && !transform) {
            throw new Error(
              `Nothing to save: ${layer.name} has no effects`
              + (wantTransform ? " and no keyframed (or expression-driven) transform property" : "")
              + `. Add an effect, or pass include_transform on a layer with an animated transform.`,
            );
          }

          const keyed = effects.some((f) => Object.values(f.params).some((v) => isKeyed(v)))
            || Object.values(transform || {}).some((v) => isKeyed(v));

          await updateFxPresets((shelf) => {
            const cur = shelf.presets[name];
            if (cur?.builtin) throw new Error(`"${name}" is a built-in preset — save under another name.`);
            if (!cur && Object.keys(shelf.presets).length >= FX_PRESET_LIMITS.presets) {
              throw new Error(`${FX_PRESET_LIMITS.presets} presets is the shelf — delete one first.`);
            }
            shelf.presets[name] = {
              createdAt: cur?.createdAt ?? Date.now(),
              updatedAt: Date.now(),
              ...(b.note !== undefined ? { note: String(b.note).slice(0, FX_PRESET_LIMITS.noteLen) }
                : cur?.note !== undefined ? { note: cur.note } : {}),
              effects,
              ...(transform ? { transform } : {}),
            };
            return shelf;
          });

          return json(res, 200, {
            ok: true, preset: name,
            effects: effects.map((f) => f.type), keyed,
            transform: transform ? Object.keys(transform) : [],
            note: `Keyframe times were stored relative to ${layer.name}'s start (${Number(layer.start) || 0}s). `
              + `apply_fx_preset writes them at "at" + relative time; "at" defaults to the target layer's start.`,
          }), true;
        }

        case "list_fx_presets": {
          const shelf = await readFxPresets();           // seeds the built-ins on first read
          const presets = Object.entries(shelf.presets).map(([name, p]) => ({
            name,
            builtin: !!p.builtin,
            effects: (p.effects || []).map((f) => f.type),
            keyed: (p.effects || []).some((f) => Object.values(f.params || {}).some((v) => isKeyed(v)))
              || Object.values(p.transform || {}).some((v) => isKeyed(v)),
            transform: p.transform ? Object.keys(p.transform) : [],
            ...(p.note !== undefined ? { note: p.note } : {}),
            updatedAt: p.updatedAt,
          })).sort((a, z) => a.name.localeCompare(z.name));
          return json(res, 200, { ok: true, count: presets.length, presets }), true;
        }

        case "apply_fx_preset": {
          const slug = need(b.slug, "comp slug");
          const pname = String(b.preset ?? b.name ?? "");
          const shelf = await readFxPresets();
          const preset = shelf.presets[pname];
          if (!preset) {
            throw new Error(`No preset called "${pname}". The shelf holds: ${Object.keys(shelf.presets).join(", ") || "nothing"}.`);
          }

          /* Validate against the CURRENT catalog BEFORE touching the comp —
           * presets outlive catalogs, and a stale one is refused NAMING what
           * is unknown, never half-applied. Same bargain as add_effect: no
           * catalog (engine missing) means no check, and the reply says so. */
          const cat = await catalogOrNull();
          if (cat) {
            for (const f of preset.effects || []) {
              if (!cat[f.type]) {
                throw new Error(`Preset "${pname}" names effect type "${f.type}", which is not in the current catalog — the preset outlived it. Delete or resave the preset.`);
              }
              for (const k of Object.keys(f.params || {})) {
                if (cat[f.type].params && !(k in cat[f.type].params)) {
                  throw new Error(`Preset "${pname}": "${f.type}" has no parameter "${k}" in the current catalog. It takes: ${Object.keys(cat[f.type].params).join(", ")}.`);
                }
              }
            }
          }

          let applied = null;
          const warnings = [];
          const doc = await updateComp(slug, (d) => {
            const layer = findLayer(d, b.layerId ?? b.id);
            const incoming = (preset.effects || []).length;
            if ((layer.effects || []).length + incoming > LIMITS.effectsPerLayer) {
              throw new Error(`A layer holds at most ${LIMITS.effectsPerLayer} effects — ${layer.name} has ${layer.effects.length} and the preset adds ${incoming}.`);
            }
            const at = b.at === undefined ? (Number(layer.start) || 0) : inRange(b.at, -3600, 3600, "at");

            const effectIds = [];
            for (const f of preset.effects || []) {
              const params = {};
              for (const [k, v] of Object.entries(f.params || {})) {
                const s = shiftPropTimes(v, at);
                if (isKeyed(s)) s.keys = normalizeKeys(s.keys, { label: `${f.type}.${k}` });
                params[k] = s;
              }
              const fx = blankEffect(f.type, params);   // a FRESH id — stored ids are never reused
              fx.enabled = f.enabled !== false;
              layer.effects.push(fx);
              effectIds.push(fx.id);
            }

            const wroteTransform = [];
            for (const [k, v] of Object.entries(preset.transform || {})) {
              const ref = resolvePropPath(layer, `transform.${k}`);
              const shifted = shiftPropTimes(v, at);
              const cur = ref.owner[ref.key];
              let next;
              if (isKeyed(shifted)) {
                const norm = normalizeKeys(shifted.keys, { label: `preset transform.${k}` });
                next = pastePresetKeys(cur, norm);      // the merge rule — see FXPRESETS, store.js
              } else {
                next = cur;                             // expression-only preset prop: the value stays
              }
              if (hasExpr(shifted)) {
                // The preset's expression is part of the saved look: it lands
                // on top, over whatever keys/value the paste produced.
                const base = (next && typeof next === "object" && !Array.isArray(next))
                  ? next
                  : { value: next === undefined ? (shifted.value ?? 0) : next };
                next = { ...base, expr: shifted.expr };
              }
              ref.owner[ref.key] = next;
              wroteTransform.push(k);
            }

            for (const w of presetExprWarnings(preset, d)) warnings.push(w);
            applied = { effectIds, transform: wroteTransform, at, layer: layer.name };
            noteRun(d, {
              tool: "apply_fx_preset",
              outcome: `${layer.name}: ${pname} — ${effectIds.length} effect(s)`
                + (wroteTransform.length ? ` + ${wroteTransform.join("/")}` : "") + ` @${at}s`,
            });
            return d;
          });

          return json(res, 200, {
            ok: true, preset: pname,
            effectIds: applied.effectIds, transform: applied.transform, at: applied.at,
            warnings, catalog: cat ? "checked" : "unavailable",
            comp: doc,
          }), true;
        }

        case "delete_fx_preset": {
          const pname = String(b.preset ?? b.name ?? "").trim();
          if (!pname) throw new Error("Name the preset to delete.");
          await updateFxPresets((shelf) => {
            const p = shelf.presets[pname];
            if (!p) throw new Error(`No preset called "${pname}". The shelf holds: ${Object.keys(shelf.presets).join(", ") || "nothing"}.`);
            if (p.builtin) throw new Error(`"${pname}" is a built-in preset and cannot be deleted.`);
            delete shelf.presets[pname];
            return shelf;
          });
          return json(res, 200, { ok: true, deleted: pname }), true;
        }

        case "rename_fx_preset": {
          const from = String(b.preset ?? b.name ?? "").trim();
          const to = String(b.to ?? "").trim().slice(0, FX_PRESET_LIMITS.nameLen);
          if (!from || !to) throw new Error(`rename_fx_preset takes "name" (the current name) and "to" (the new one).`);
          await updateFxPresets((shelf) => {
            const p = shelf.presets[from];
            if (!p) throw new Error(`No preset called "${from}". The shelf holds: ${Object.keys(shelf.presets).join(", ") || "nothing"}.`);
            if (p.builtin) throw new Error(`"${from}" is a built-in preset and cannot be renamed.`);
            if (from !== to && shelf.presets[to]) throw new Error(`There is already a preset called "${to}".`);
            delete shelf.presets[from];
            shelf.presets[to] = { ...p, updatedAt: Date.now() };
            return shelf;
          });
          return json(res, 200, { ok: true, renamed: { from, to } }), true;
        }

        case "layer_properties": {
          /* What can be animated on this layer — keyed or not. The timeline
           * tree and vfx_layer_properties read the SAME function, which is the
           * only way "the UI can do it" and "MCP can do it" stay the same
           * sentence. Catalogs go in so labels and ranges come from the
           * registries; without them those groups are absent rather than
           * guessed, because a wrong range is accepted and renders wrong. */
          const doc = await readComp(need(b.slug, "comp slug"));
          if (!doc) throw new Error(`No such comp: ${b.slug}`);
          const layer = findLayer(doc, b.layerId ?? b.id);
          const [fxCat, shCat, ltCat] = await Promise.all(
            [catalogOrNull(), shapeCatalogOrNull(), lightsCatalogOrNull()]);
          const props = layerProperties(layer, { effects: fxCat, shapes: shCat, lights: ltCat });
          return json(res, 200, {
            ok: true, layerId: layer.id, name: layer.name, type: layer.type,
            count: props.length, properties: props,
          }), true;
        }

        /* ── analysis: sound and motion, turned into keyframes ───────── */

        case "audio_keys": {
          const name = need(b.audio ?? b.track ?? b.src, "audio file name");
          /* Music sits in the output root and clips in the clip library, and
           * "the audio" can honestly be either — a song or the sound of a
           * video. Try both rather than making the caller know which. */
          let full = path.join(config.outputDir, name);
          try { await stat(full); } catch {
            full = path.join(CLIP_DIR, name);
            try { await stat(full); } catch {
              throw new Error(`${name} is not in the library. Give a file name, not a path.`);
            }
          }

          const job = { ...b, audio: fwd(full) };
          delete job.action; delete job.apply; delete job.slug;
          delete job.layerId; delete job.id; delete job.path;
          const r = await runTool(AUDIOKEYS, "audio_keys", job, { timeoutMs: 10 * 60_000 });

          if (!b.apply) {
            return json(res, 200, {
              ok: true, bpm: r.bpm, beats: r.beats?.length ?? 0, bars: r.bars?.length ?? 0,
              seconds: r.seconds, fps: r.fps, frames: r.frames,
              tracks: Object.fromEntries(Object.entries(r.tracks || {}).map(([k, v]) => [k, v.keys?.length ?? 0])),
              silentBands: r.silentBands, bandDb: r.bandDb,
              note: "Pass `apply` {layerId, path, track, min, max} to drive a property with one of these.",
            }), true;
          }

          const a = b.apply;
          const trackName = String(a.track || "amplitude");
          const track = (r.tracks || {})[trackName];
          if (!track) {
            throw new Error(`No track "${trackName}". This analysis has: ${Object.keys(r.tracks || {}).join(", ")}.`);
          }
          const lo = Number(a.min ?? 0), hi = Number(a.max ?? 100);
          if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error("apply.min and apply.max must be numbers.");

          const slug = need(a.slug ?? b.slug, "comp slug");
          let wrote = null;
          const doc = await updateComp(slug, (d) => {
            const layer = findLayer(d, a.layerId ?? a.id);
            const ref = resolvePropPath(layer, a.path);
            /* A vector property (position, scale) needs a value per component.
             * One number would be silently rejected downstream, so the track
             * drives the axis named by `axis` and the other components keep
             * the value they already had.
             *
             * The arity is NOT always declared: on a 3D layer the vector
             * properties accept two or three components, so resolvePropPath
             * leaves it open and the answer has to come from what the property
             * currently is. evalProp gives the concrete value whether that is
             * a constant, a keyframe track or an expression's fallback —
             * pattern-matching the container misses the keyed case, and a
             * missed vector is written as a bare number with no error. */
            const concrete = evalProp(ref.owner[ref.key], 0);
            const concreteArity = Array.isArray(concrete) ? concrete.length : null;
            const arity = ref.arity ?? concreteArity;
            const axis = a.axis == null ? null : Number(a.axis);
            const held = Array.isArray(concrete) ? concrete.slice() : null;

            const keys = track.keys.map((k) => {
              const v = lo + (hi - lo) * Number(k.v);
              if (arity == null || arity === 1) return { t: k.t, v };
              const out = held ? held.slice() : new Array(arity).fill(v);
              if (axis == null) out.fill(v);
              else out[Math.max(0, Math.min(arity - 1, axis))] = v;
              return { t: k.t, v: out };
            });

            ref.owner[ref.key] = { keys: normalizeKeys(keys, { arity, label: ref.path }) };
            wrote = { path: ref.path, keys: keys.length, layer: layer.name };
            noteRun(d, { tool: "audio_keys", outcome: `${layer.name} ${ref.path}: ${keys.length} keys from ${trackName}` });
            return d;
          });
          return json(res, 200, {
            ok: true, applied: wrote, track: trackName, range: [lo, hi],
            bpm: r.bpm, beats: r.beats?.length ?? 0, comp: doc,
          }), true;
        }

        case "audio_peaks": {
          /* The waveform under a layer bar, as numbers: min/max pairs over
           * the WHOLE source, decoded by the engine's own audio path
           * (engine.py cmd_peaks → _decode_audio, the same code the movie
           * mix reads). Addressed either by a layer — slug + layerId, the
           * layer's own src is resolved — or by a library file name, the
           * way audio_keys takes one.
           *
           * Layer TIMING is deliberately absent from both the request and
           * the reply. The envelope is a property of the file; the client
           * maps comp time onto it with the same inPoint/start/timeScale
           * rule the engine uses, so a retimed bar re-DRAWS, never
           * re-computes. That is also why the sidecar cache is keyed on
           * (source, mtime, bins) and NOT on the comp's updatedAt — a
           * waveform that survives every comp edit is the point. */
          let full = null, srcName = null;
          if (b.layerId ?? b.id) {
            const doc = await readComp(need(b.slug, "comp slug"));
            if (!doc) throw new Error(`No such comp: ${b.slug}`);
            const layer = findLayer(doc, b.layerId ?? b.id);
            const kind = String(layer.type || "image");
            srcName = String(layer.src || "");
            if (kind === "video") full = path.join(CLIP_DIR, srcName);
            else if (kind === "audio") full = srcName ? await audioSourcePath(srcName) : null;
            else {
              throw new Error(`${layer.name} is a ${kind} layer — only audio and video layers `
                + `have a waveform. (A comp layer's sound is a mix, not a source; ask its child's layers.)`);
            }
            if (!full) throw new Error(`${layer.name} has no source file to read.`);
            try { await stat(full); } catch {
              throw new Error(`${layer.name}'s source ${srcName} is not in the library any more.`);
            }
          } else {
            srcName = need(b.src ?? b.audio, "audio source name (or slug + layerId)");
            full = await audioSourcePath(srcName);
            if (!full) {
              throw new Error(`${srcName} is not in the music library or the clips library. `
                + `Give a file name, not a path — or a slug + layerId.`);
            }
          }

          /* Resolution: `bins` = how many min/max pairs, or `pixelsPerSecond`
           * = derive it from the source's length, one pair per pixel. The
           * range is the engine's own clamp, restated here so the reply's
           * bin count is what the sidecar was keyed on. */
          let bins = Number(b.bins);
          if (!Number.isFinite(bins)) {
            const pps = Number(b.pixelsPerSecond);
            if (Number.isFinite(pps) && pps > 0) {
              const pr = await runEngineFast("probe", { sources: [fwd(full)] }, { timeoutMs: 60_000 });
              const secs = Number(pr.sources?.[0]?.duration);
              if (!Number.isFinite(secs) || secs <= 0) {
                throw new Error(`${srcName} did not report a duration — ask with \`bins\` instead.`);
              }
              bins = Math.round(secs * pps);
            } else {
              bins = 1000;
            }
          }
          bins = clampInt(bins, 16, 8192);

          const st = await stat(full);
          const sidecar = path.join(PEAKS_DIR, peaksName(peaksHash(full), peaksMtok(st), bins));
          try {
            /* `cached` is this route's X-Vfx-Cache: the cache is a claim, and
             * a claim nobody can observe from outside is a claim nobody can
             * prove. A torn or hand-edited sidecar fails the parse and is
             * simply recomputed. */
            const held = JSON.parse(await readFile(sidecar, "utf8"));
            if (Array.isArray(held.peaks) && held.peaks.length === bins * 2) {
              return json(res, 200, { ok: true, src: srcName, ...held, cached: true }), true;
            }
          } catch { /* not computed yet */ }

          const r = await runEngineFast("peaks", { src: fwd(full), bins }, { timeoutMs: 3 * 60_000 });
          const body = { bins: r.bins, rate: r.rate, seconds: r.seconds, peaks: r.peaks };
          await mkdir(PEAKS_DIR, { recursive: true });
          await writeFile(sidecar, JSON.stringify(body), "utf8");
          prunePeaks(peaksHash(full), peaksMtok(st)).catch(() => {});
          return json(res, 200, { ok: true, src: srcName, ...body, cached: false }), true;
        }

        case "audio_notes": {
          /* Audio → notes, the measured recipe (notes.py's docstring owns the
           * numbers and the caveats): Basic Pitch tuned per stem profile, the
           * two-rule post-filter, the bend collapse — and, on request, the DP
           * fingering. Addressed like audio_peaks: a library name, or a comp
           * layer's own source. Cached like the peaks sidecars, on
           * (source, mtime, profile) — never updatedAt; see NOTES_RE. */
          const { full, srcName } = await notesSource(b);
          const profile = profileOf(b);
          const { body, cached } = await transcribeCached(full, profile);
          /* A transcription is AI-generated ANALYSIS (SPEC v1 capture set):
           * the model heard the audio and wrote the notes. Logged once per
           * fresh run — a cache hit re-reads an already-recorded result. */
          if (!cached) {
            provNote("library", {
              actor, type: "generate", asset: `notes/${srcName}`,
              data: { analysis: "audio_notes", model: "basic-pitch", profile,
                      count: body.count ?? null, seconds: body.seconds ?? null },
            });
          }

          let fingering;
          if (b.fingering) {
            if (!body.notes.length) {
              fingering = { notes: [], assigned: 0, unplayable: [] };
            } else {
              /* Pure-python pass over the (possibly cached) notes — tuning
               * and fret count are the CALLER's, which is why they are not in
               * the sidecar key. */
              const job = { mode: "fingering", notes: body.notes };
              if (b.tuning !== undefined) job.tuning = b.tuning;
              if (b.frets !== undefined) job.frets = b.frets;
              const f = await runTool(NOTES, "fingering", job, { timeoutMs: 2 * 60_000 });
              fingering = { notes: f.notes, assigned: f.assigned, unplayable: f.unplayable,
                            meanPos: f.meanPos, maxPos: f.maxPos, maxJump: f.maxJump };
            }
          }
          return json(res, 200, {
            ok: true, src: srcName, cached, ...body,
            ...(fingering ? { fingering } : {}),
            note: "Thresholds were validated on clean synthetic tones; re-check on real "
              + "recorded material before trusting every note. Feed `fingering.notes` to "
              + "the instrument_rig action to build a playing fretboard.",
          }), true;
        }

        case "instrument_rig": {
          /* A comp that PLAYS the notes: rigs.js builds the layers (pure,
           * deterministic — the same notes render byte-identical frames), this
           * side resolves where the notes come from and splices the layers in.
           * `notes` inline (from audio_notes, or hand-written), or `audio` +
           * `profile` to transcribe here through the same sidecar cache. */
          const slug = need(b.slug, "comp slug");
          const doc0 = await readComp(slug);
          if (!doc0) throw new Error(`No such comp: ${slug}`);
          const instrument = String(b.instrument || "guitar").toLowerCase();
          if (instrument !== "guitar" && instrument !== "piano") {
            throw new Error(`No instrument "${b.instrument}". Instruments: guitar (fretboard), piano (keyboard + roll).`);
          }

          let rigNotes = b.notes;
          let transcription = null;
          if (!Array.isArray(rigNotes)) {
            if (!(b.audio ?? b.src)) {
              throw new Error("Give `notes` (from audio_notes, with fingering for guitar) or `audio` (a library name to transcribe).");
            }
            const { full, srcName } = await notesSource(b);
            const profile = profileOf(b);
            const { body, cached } = await transcribeCached(full, profile);
            // Same seam as audio_notes: a fresh transcription is an
            // AI-generated analysis event, whichever action asked for it.
            if (!cached) {
              provNote("library", {
                actor, type: "generate", asset: `notes/${srcName}`,
                data: { analysis: "audio_notes", model: "basic-pitch", profile,
                        count: body.count ?? null, seconds: body.seconds ?? null },
              });
            }
            rigNotes = body.notes;
            transcription = { src: srcName, profile, cached, count: body.count, bends: body.bends };
            if (instrument === "guitar" && rigNotes.length) {
              const job = { mode: "fingering", notes: rigNotes };
              if (b.tuning !== undefined) job.tuning = b.tuning;
              if (b.frets !== undefined) job.frets = clampInt(b.frets, 3, 24);
              const f = await runTool(NOTES, "fingering", job, { timeoutMs: 2 * 60_000 });
              rigNotes = f.notes;
            }
          }
          if (!Array.isArray(rigNotes) || !rigNotes.length) {
            throw new Error("The transcription found no notes to rig — nothing to build.");
          }

          const opts = {
            frets: b.frets, leftHanded: b.leftHanded === true, tab: b.tab === true,
            bendVisual: b.bendVisual !== false, colors: b.colors, name: b.name,
            roll: b.roll, pixelsPerSecond: b.pixelsPerSecond,
          };
          let built = null, ids = [];
          const doc = await updateComp(slug, (d) => {
            built = instrument === "guitar"
              ? buildFretboardRig(d, rigNotes, opts)
              : buildPianoRig(d, rigNotes, opts);
            if (instrument === "guitar" && !built.drawn) {
              throw new Error("None of these notes carry string/fret — the fretboard needs the "
                + "fingering. Ask audio_notes with fingering:true, or pass audio directly.");
            }
            if (d.layers.length + built.layers.length > 64) {
              throw new Error(`The rig adds ${built.layers.length} layer(s); "${slug}" holds `
                + `${d.layers.length} and a comp holds at most 64.`);
            }
            /* Front-first from the builder; splicing at 0 keeps that order. */
            d.layers.splice(0, 0, ...built.layers);
            ids = built.layers.map((l) => l.id);
            noteRun(d, { tool: "instrument_rig",
                         outcome: `${instrument}: ${built.layers.length} layers from ${rigNotes.length} notes` });
            return d;
          });
          return json(res, 200, {
            ok: true, slug, instrument, layerIds: ids, layers: ids.length,
            notes: rigNotes.length, warnings: built.warnings,
            ...(transcription ? { transcription } : {}),
            comp: doc,
          }), true;
        }

        case "track_motion": {
          const name = need(b.clip ?? b.video ?? b.src, "clip name");
          const full = path.join(CLIP_DIR, name);
          try { await stat(full); } catch {
            throw new Error(`${name} is not in the clips library. Give a file name, not a path.`);
          }

          const job = { ...b, video: fwd(full) };
          delete job.action; delete job.apply; delete job.slug;
          delete job.layerId; delete job.id; delete job.path;
          const r = await runTool(TRACKER, "track_motion", job, { timeoutMs: 20 * 60_000 });

          /* lostAt is the whole point of this tracker: it stops rather than
           * inventing positions. Surface it at the top level so a caller sees
           * it without reading the key list. */
          /* minConfidence in the result is the THRESHOLD the job ran with,
           * not a measurement — reporting it as "the confidence" would be a
           * lie that reads as reassurance. The observed figures come from the
           * per-frame array. */
          const confs = Array.isArray(r.confidence) ? r.confidence : [];
          const summary = {
            frames: r.frames ?? 0, fps: r.fps, lostAt: r.lostAt ?? null,
            confidence: confs.length ? {
              min: Math.min(...confs),
              mean: Number((confs.reduce((a, c) => a + c, 0) / confs.length).toFixed(4)),
              threshold: r.minConfidence,
            } : undefined,
            dips: r.dips?.length ?? 0,
            /* The one signal confidence cannot give. A repetitive texture — a
             * striped shirt, a brick wall — is matched with high confidence by
             * a tracker that has no idea WHICH repeat it found; the margin
             * between the winning peak and its best rival is what collapses.
             * Dropping it left the caller with only the number that lies. */
            margin: Array.isArray(r.margin) && r.margin.length
              ? { min: Math.min(...r.margin), mean: Number((r.margin.reduce((a, m) => a + m, 0) / r.margin.length).toFixed(4)) }
              : undefined,
          };

          if (!b.apply) {
            return json(res, 200, {
              ok: true, ...summary,
              note: r.lostAt != null
                ? `The feature was lost at ${r.lostAt}s — no positions are reported past it. Re-run with a different rect or a larger search.`
                : "Pass `apply` {layerId, path, mode} to drive a property with this.",
            }), true;
          }

          const a = b.apply;
          const mode = String(a.mode || "follow").toLowerCase();
          /* Both live one level down: keys.position for following the
           * feature, stabilize.position for cancelling its motion. */
          const keys = (mode === "stabilize" || mode === "stabilise"
            ? r.stabilize?.position : r.keys?.position)?.keys;
          if (!keys?.length) {
            throw new Error(mode.startsWith("stabili")
              ? "This track has no stabilisation keys — re-run without stabilize:false."
              : "This track produced no positions.");
          }

          const slug = need(a.slug ?? b.slug, "comp slug");
          let wrote = null;
          const doc = await updateComp(slug, (d) => {
            const layer = findLayer(d, a.layerId ?? a.id);
            const ref = resolvePropPath(layer, a.path ?? "transform.position");
            ref.owner[ref.key] = { keys: normalizeKeys(keys, { arity: 2, label: ref.path }) };
            wrote = { path: ref.path, keys: keys.length, layer: layer.name };
            noteRun(d, { tool: "track_motion", outcome: `${layer.name} ${ref.path}: ${keys.length} keys (${mode})` });
            return d;
          });
          return json(res, 200, { ok: true, applied: wrote, mode, ...summary, comp: doc }), true;
        }

        /* ── the workspace: gizmos, views, probes, alignment ─────────── */

        /**
         * Screen-space overlay geometry for the viewer — the selected layer's
         * axis tripod and outline, camera frustums, light wireframes — for
         * the ACTIVE camera or any workspace view. Computed by viewport.py
         * THROUGH engine functions, never re-derived, so what this returns is
         * where the renderer actually put things. Coordinates are comp pixels
         * at scale 1; the client scales to its own display size.
         */
        case "view_overlay": {
          const slug = need(b.slug, "comp slug");
          const doc = await readComp(slug);
          if (!doc) throw new Error(`No such comp: ${slug}`);
          const t = b.t === undefined ? 0 : inRange(b.t, 0, doc.duration, "t");
          const view = viewOf(b.view);
          const layerId = (b.layerId ?? b.id) ? findLayer(doc, b.layerId ?? b.id).id : null;
          const comp = await resolveCompTree(doc);
          const r = await runTool(VIEWPORT, "overlay",
            { mode: "overlay", comp, t, view, layerId }, { timeoutMs: 60_000 });
          return json(res, 200, {
            ...r, slug, updatedAt: doc.updatedAt, view: view ?? null,
          }), true;
        }

        /**
         * The inverse of the projection: a screen-space drag (comp px) into
         * the world-space delta it means and the new value for the layer's
         * transform.position — in the PARENT's space, which is the space that
         * property is written in. The gizmo drag calls this rather than doing
         * any camera maths client-side; the answer is meant to be written
         * back through set_prop / add_key, which is what keeps undo and MCP
         * parity free.
         */
        case "view_unproject": {
          const slug = need(b.slug, "comp slug");
          const doc = await readComp(slug);
          if (!doc) throw new Error(`No such comp: ${slug}`);
          const t = b.t === undefined ? 0 : inRange(b.t, 0, doc.duration, "t");
          const view = viewOf(b.view);
          const layer = findLayer(doc, b.layerId ?? b.id);
          const pt = (v, label) => {
            if (!Array.isArray(v) || v.length !== 2 || v.some((n) => !Number.isFinite(Number(n)))) {
              throw new Error(`${label} is [x, y] in comp pixels.`);
            }
            return [Number(v[0]), Number(v[1])];
          };
          const drag = b.axis ? "axis" : (String(b.drag || "plane") === "axis" ? "axis" : "plane");
          if (drag === "axis" && !["x", "y", "z"].includes(String(b.axis))) {
            throw new Error(`axis is "x", "y" or "z".`);
          }
          const comp = await resolveCompTree(doc);
          const r = await runTool(VIEWPORT, "unproject", {
            mode: "unproject", comp, t, view, layerId: layer.id,
            drag, axis: b.axis, from: pt(b.from, "from"), to: pt(b.to, "to"),
          }, { timeoutMs: 60_000 });
          return json(res, 200, { ...r, slug, layerId: layer.id, drag, view: view ?? null }), true;
        }

        /**
         * RGBA under one comp-space point, read off the SERVER-rendered frame
         * — the same PNG the viewer shows and a render would produce. Both
         * 0-255 and float are returned. This is the tool an agent uses to
         * verify its own edit: "is the pixel at (x, y) actually red now".
         */
        case "probe_pixel": {
          const slug = need(b.slug, "comp slug");
          const doc = await readComp(slug);
          if (!doc) throw new Error(`No such comp: ${slug}`);
          const t = b.t === undefined ? 0 : inRange(b.t, 0, doc.duration, "t");
          const scale = b.scale === undefined ? 1 : inRange(b.scale, 0.05, 1, "scale");
          const draft = b.draft === undefined ? scale < 1 : !!b.draft;
          const view = viewOf(b.view);
          const x = inRange(b.x, 0, doc.width, "x");
          const y = inRange(b.y, 0, doc.height, "y");

          interactive++;
          let r;
          try { r = await frameFile(doc, t, scale, draft, view); } finally { interactive--; }
          let file = r.file;
          try { await stat(file); } catch {
            // Evicted from disk between render and probe; the RAM copy is
            // still the frame, so put it back rather than re-rendering.
            if (!r.buf) throw new Error("That frame left the cache mid-probe — ask again.");
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, r.buf);
          }
          const px = await runTool(VIEWPORT, "probe_pixel", {
            mode: "probe_pixel", png: fwd(file),
            x: Math.floor(x * scale), y: Math.floor(y * scale),
          }, { timeoutMs: 30_000 });
          return json(res, 200, {
            ok: true, slug, t, x, y, scale, draft, view: view ?? null,
            px: [px.x, px.y], width: px.width, height: px.height,
            rgba: px.rgba, float: px.float,
          }), true;
        }

        /**
         * Align or distribute layers in the comp's XY plane. Bounds come from
         * viewport.py — the engine's own transforms, so a rotated or parented
         * layer aligns by where it actually IS — and the writes go through
         * transform.position exactly as set_prop would write it: a constant
         * moves, a keyframed position gets a key at `t`, an expression keeps
         * its expression and moves the value beneath it.
         */
        case "align_layers": {
          const slug = need(b.slug, "comp slug");
          const doc0 = await readComp(slug);
          if (!doc0) throw new Error(`No such comp: ${slug}`);
          const OPS = ["left", "centerH", "right", "top", "centerV", "bottom",
                       "distributeH", "distributeV"];
          const op = String(b.op || "");
          if (!OPS.includes(op)) throw new Error(`op must be one of: ${OPS.join(", ")}.`);
          const to = b.to === "comp" ? "comp" : "selection";
          const t = b.t === undefined ? 0 : inRange(b.t, 0, doc0.duration, "t");
          const ids = (Array.isArray(b.layerIds) ? b.layerIds
            : [b.layerId ?? b.id].filter((v) => v != null))
            .map((ref) => findLayer(doc0, ref).id);
          if (!ids.length) throw new Error("Give layerIds — the layers to align.");
          const distribute = op.startsWith("distribute");
          if (distribute && ids.length < 3) throw new Error("Distribute needs at least three layers.");
          if (!distribute && to === "selection" && ids.length < 2) {
            throw new Error(`Aligning within the selection needs two or more layers — or pass to: "comp" to align against the comp edges.`);
          }
          const lockedNames = ids.map((id) => findLayer(doc0, id)).filter((l) => l.locked).map((l) => l.name);
          if (lockedNames.length) throw new Error(`${lockedNames.join(", ")} ${lockedNames.length === 1 ? "is" : "are"} locked.`);

          const comp = await resolveCompTree(doc0);
          const bounds = await runTool(VIEWPORT, "layer_bounds",
            { mode: "layer_bounds", comp, t, layerIds: ids }, { timeoutMs: 60_000 });
          const rows = bounds.layers || [];

          /* A bbox that IS the comp plane usually means the engine had no
           * tighter answer — a full-frame solid, an adjustment plate. Aligning
           * that is a no-op that reads as a broken button, so it is said out
           * loud instead of silently moving nothing. (Text layers measure by
           * their INK now — viewport.py — so a title no longer trips this.) */
          const planeSized = (r) =>
            Math.abs(r.bbox[0]) < 0.5 && Math.abs(r.bbox[1]) < 0.5
            && Math.abs(r.bbox[2] - doc0.width) < 0.5 && Math.abs(r.bbox[3] - doc0.height) < 0.5;
          const warnings = rows.filter(planeSized).map((r) =>
            `${r.name || r.id}: its rendered bounds are the whole comp plane, so aligning it cannot move it.`);

          /* World-XY deltas per layer. H ops read bbox x (0/2), V ops y (1/3). */
          const ax = /H$|left|right/.test(op) && op !== "distributeV" ? 0 : 1;
          const lo = (r) => r.bbox[ax];
          const hi = (r) => r.bbox[ax + 2];
          const mid = (r) => (lo(r) + hi(r)) / 2;
          const deltas = new Map();
          if (distribute) {
            const sorted = [...rows].sort((a, z) => mid(a) - mid(z));
            const first = mid(sorted[0]), last = mid(sorted[sorted.length - 1]);
            sorted.forEach((r0, i) => {
              const target = first + (last - first) * (i / (sorted.length - 1));
              deltas.set(r0.id, target - mid(r0));
            });
          } else {
            const refLo = to === "comp" ? 0 : Math.min(...rows.map(lo));
            const refHi = to === "comp" ? (ax === 0 ? doc0.width : doc0.height)
              : Math.max(...rows.map(hi));
            for (const r0 of rows) {
              const d = op === "left" || op === "top" ? refLo - lo(r0)
                : op === "right" || op === "bottom" ? refHi - hi(r0)
                : (refLo + refHi) / 2 - mid(r0);
              deltas.set(r0.id, d);
            }
          }

          const moved = [];
          const doc = await updateComp(slug, (d) => {
            for (const row of rows) {
              const dv = deltas.get(row.id) ?? 0;
              if (Math.abs(dv) < 1e-6) continue;
              const wd = ax === 0 ? [dv, 0, 0] : [0, dv, 0];
              // World delta -> the position property's own (parent) space,
              // through the inverse viewport.py computed with engine maths.
              const pinv = row.pinv;
              const pd = [0, 1, 2].map((i) =>
                pinv[i][0] * wd[0] + pinv[i][1] * wd[1] + pinv[i][2] * wd[2]);
              const layer = findLayer(d, row.id);
              const ref = resolvePropPath(layer, "transform.position");
              const next = row.position.map((v, i) => Number((v + (pd[i] || 0)).toFixed(4)));
              const cur = ref.owner[ref.key];
              if (isKeyed(cur)) {
                const keep = cur.keys.filter((k) => Math.abs(Number(k.t) - t) > 1e-3);
                const keys = normalizeKeys([...keep, { t, v: next }], { label: ref.path });
                ref.owner[ref.key] = hasExpr(cur) ? { ...cur, keys } : { keys };
              } else if (hasExpr(cur)) {
                ref.owner[ref.key] = { ...cur, value: next };
              } else {
                ref.owner[ref.key] = next;
              }
              moved.push({ id: row.id, name: row.name, position: next, keyed: isKeyed(cur) });
            }
            noteRun(d, { tool: "align_layers", outcome: `${op} (${to}) — ${moved.length} of ${ids.length} layer(s) moved` });
            return d;
          });
          return json(res, 200, { ok: true, op, to, t, moved,
                                  warnings: warnings.length ? warnings : undefined, comp: doc }), true;
        }

        /**
         * Guides — the workspace's ruler lines, and the one piece of viewer
         * furniture that is DOCUMENT state: a guide marks a place in the
         * composition, so it survives reload, travels with the comp, and is
         * visible to MCP (vfx_get_comp shows it). The grid, the safe-zone
         * overlay and the rulers themselves are VIEW state and never reach
         * this file — they describe how one person is looking at the comp,
         * not the comp.
         *
         * REPLACES the list wholesale, exactly like set_comp's `markers`:
         * add, move and remove are all one read-modify-write for the caller,
         * and there is no id scheme to keep stable for a line with two fields.
         * axis "x" is a VERTICAL line at x=position; axis "y" a HORIZONTAL
         * one at y=position — both in comp pixels, fractions legal. Positions
         * must lie on the comp raster: there is no pasteboard to put one
         * outside it, so out of range is refused rather than invented.
         */
        case "set_guides": {
          const doc = await updateComp(need(b.slug, "comp slug"), (d) => {
            if (!Array.isArray(b.guides)) {
              throw new Error('guides must be an array of { axis: "x" | "y", position } — [] clears them. '
                + 'axis "x" is a vertical line at x=position, "y" a horizontal one at y=position, in comp pixels.');
            }
            if (b.guides.length > LIMITS.guides) {
              throw new Error(`A comp holds at most ${LIMITS.guides} guides — got ${b.guides.length}.`);
            }
            d.guides = b.guides.map((g, i) => {
              const axis = String(g?.axis ?? "");
              if (axis !== "x" && axis !== "y") {
                throw new Error(`guides[${i}].axis must be "x" (a vertical line) or "y" (a horizontal one).`);
              }
              const max = axis === "x" ? d.width : d.height;
              // Rounded to 1/100 px like every other wire coordinate; nobody places finer.
              return { axis, position: Math.round(inRange(g?.position, 0, max, `guides[${i}].position`) * 100) / 100 };
            });
            noteRun(d, { tool: "set_guides", outcome: `${d.guides.length} guide(s)` });
            return d;
          });
          return json(res, 200, { ok: true, guides: doc.guides, comp: doc }), true;
        }

        default:
          return json(res, 400, { error: `Unknown action: ${action}` }), true;
      }
    } catch (err) {
      return json(res, 400, { error: String(err.message || err) }), true;
    }
  }

  /* ─────────────────────────────────────────────────── local helpers */

  const blendOf = (v) => {
    const s = String(v);
    if (!BLEND_MODES.includes(s)) throw new Error(`blend must be one of: ${BLEND_MODES.join(", ")}.`);
    return s;
  };

  /** A closed polygon in comp pixels. Two points is a line, and a line has no inside. */
  function pointsOf(v) {
    if (!Array.isArray(v) || v.length < 3) throw new Error("A mask needs at least three [x,y] points, in comp pixels.");
    return v.map((pt, i) => {
      if (!Array.isArray(pt) || pt.length !== 2) throw new Error(`points[${i}] must be [x, y].`);
      const x = Number(pt[0]), y = Number(pt[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`points[${i}] must be two numbers.`);
      return [x, y];
    });
  }

  function maskPatch(b) {
    const out = {};
    if (b.mode !== undefined) {
      if (!MASK_MODES.includes(b.mode)) throw new Error(`Mask mode must be one of: ${MASK_MODES.join(", ")}.`);
      out.mode = b.mode;
    }
    if (b.feather !== undefined) out.feather = coerceProp(b.feather, 1, "feather");
    if (b.opacity !== undefined) out.opacity = coerceProp(b.opacity, 1, "opacity");
    if (b.expand !== undefined) out.expand = coerceProp(b.expand, 1, "expand");
    if (b.invert !== undefined) out.invert = !!b.invert;
    return out;
  }

  /** A constant or a keyframed object — both are legal everywhere §1 says animatable. */
  function coerceProp(v, arity, label) {
    if (isKeyed(v)) return { keys: normalizeKeys(v.keys, { arity, label }) };
    const out = normalizeValue(v, { label });
    if (arity != null && arityOf(out) !== arity) {
      throw new Error(`${label} takes ${arity} number(s), got ${arityOf(out)}.`);
    }
    return out;
  }

  /** Ask the catalog what arity an effect param has — before taking the write lock. */
  async function propArityHint(slug, b) {
    const parts = String(b.path ?? "").split(".");
    if (parts[0] !== "effects" || parts.length !== 3) return null;
    const doc = await readComp(slug);
    if (!doc) return null;
    try {
      const fx = pickEffect(findLayer(doc, b.layerId ?? b.id), parts[1]);
      return await catalogArity(fx.type, parts[2]);
    } catch { return null; }
  }

  /** The catalog's default for an effect param — what a stopwatch seeds from. */
  async function catalogDefaultFor(slug, b) {
    const parts = String(b.path ?? "").split(".");
    if (parts[0] !== "effects" || parts.length !== 3) return undefined;
    const doc = await readComp(slug);
    if (!doc) return undefined;
    try {
      const fx = pickEffect(findLayer(doc, b.layerId ?? b.id), parts[1]);
      const cat = await catalogOrNull();
      return cat?.[fx.type]?.params?.[parts[2]]?.default;
    } catch { return undefined; }
  }

  /* FXPRESETS: expressions in a preset apply VERBATIM — but one that reaches
   * for another layer by name may be reaching for a layer this comp does not
   * have. Detected with the SAME match order expressions.py's thisComp.layer()
   * uses (exact layer name first, then id; a 1-based numeric index checks the
   * layer count) and reported as warnings, never blocked: the sandbox already
   * degrades a failed expression to the property's underlying value, and the
   * caller may be about to add the layer the expression names. */
  function presetExprWarnings(preset, doc) {
    const out = [];
    const scan = (expr, where) => {
      const re = /thisComp\s*\.\s*layer\s*\(\s*(?:"([^"]*)"|'([^']*)'|(\d+))\s*\)/g;
      let m;
      while ((m = re.exec(String(expr)))) {
        if (m[3] !== undefined) {
          const i = Number(m[3]);
          if (i < 1 || i > doc.layers.length) {
            out.push(`${where}: thisComp.layer(${i}) — this comp has ${doc.layers.length} layer(s)`);
          }
          continue;
        }
        const ref = m[1] ?? m[2];
        const hit = doc.layers.some((l) => String(l.name || "") === ref)
          || doc.layers.some((l) => String(l.id || "") === ref);
        if (!hit) {
          out.push(`${where}: thisComp.layer("${ref}") does not resolve — no layer with that name or id in this comp`);
        }
      }
    };
    for (const f of preset.effects || []) {
      for (const [k, v] of Object.entries(f.params || {})) {
        if (hasExpr(v)) scan(v.expr, `${f.type}.${k}`);
      }
    }
    for (const [k, v] of Object.entries(preset.transform || {})) {
      if (hasExpr(v)) scan(v.expr, `transform.${k}`);
    }
    return out;
  }

  /* LIGHTS: a light layer's spec, merged one property at a time — never
   * rebuilt, so a keyed intensity survives a kind change. The switches are
   * validated here; every animatable parameter goes through the SAME resolver
   * set_prop uses, so a wrong arity, an unknown name and a parameter the
   * current kind does not read are all refused with the same words either way
   * in. Kind/falloff land FIRST so { kind: "spot", coneAngle: 30 } works in
   * one call regardless of key order. */
  function mergeLight(layer, patch) {
    if (layer.type !== "light") {
      throw new Error(`Only a light layer has light settings — this is a ${layer.type} layer.`);
    }
    if (!patch || typeof patch !== "object") throw new Error("light is an object of light settings.");
    layer.light = (layer.light && typeof layer.light === "object") ? layer.light : {};
    const L = layer.light;
    if (patch.kind !== undefined) {
      if (!LIGHT_KINDS.includes(patch.kind)) {
        throw new Error(`light.kind is one of: ${LIGHT_KINDS.join(", ")} — got "${patch.kind}".`);
      }
      L.kind = patch.kind;
    }
    if (patch.falloff !== undefined) {
      if (!LIGHT_FALLOFFS.includes(patch.falloff)) {
        throw new Error(`light.falloff is one of: ${LIGHT_FALLOFFS.join(", ")} — got "${patch.falloff}".`);
      }
      L.falloff = patch.falloff;
    }
    if (patch.castsShadows !== undefined) L.castsShadows = !!patch.castsShadows;
    for (const [k, v] of Object.entries(patch)) {
      if (k === "kind" || k === "falloff" || k === "castsShadows") continue;
      const ref = resolvePropPath(layer, `light.${k}`);
      ref.owner[ref.key] = coerceProp(v, ref.arity, ref.path);
    }
  }

  /* Material options, same discipline. null clears the object entirely, which
   * is "back to AE's defaults" — lights.py::material() owns those. */
  function mergeMaterial(layer, patch) {
    if (UNSHADEABLE.includes(layer.type)) {
      throw new Error(`A ${layer.type} layer has no surface to shade — material lives on 3D pixel layers.`);
    }
    if (patch === null) { delete layer.material; return; }
    if (!patch || typeof patch !== "object") {
      throw new Error("material is an object of material options, or null to clear them.");
    }
    if (!layer.threeD) {
      throw new Error("Materials only mean anything on a 3D layer — set threeD: true first (the same call is fine).");
    }
    layer.material = (layer.material && typeof layer.material === "object") ? layer.material : {};
    for (const [k, v] of Object.entries(patch)) {
      if (["acceptsLights", "castsShadows", "acceptsShadows"].includes(k)) {
        layer.material[k] = !!v;
        continue;
      }
      const ref = resolvePropPath(layer, `material.${k}`);
      ref.owner[ref.key] = coerceProp(v, ref.arity, ref.path);
    }
  }

  function mergeText(current, patch) {
    if (!patch || typeof patch !== "object") throw new Error("text must be an object.");
    const out = { ...(current || {}) };
    if (patch.content !== undefined) out.content = String(patch.content).slice(0, 4000);
    // The font is a BASENAME — python resolves it out of the system font dirs,
    // exactly as imagetools.py already does. A path here would be a path from a
    // client, which is the one thing this file does not accept.
    if (patch.font !== undefined) out.font = path.basename(String(patch.font));
    if (patch.size !== undefined) out.size = inRange(patch.size, 1, 2000, "text.size");
    if (patch.color !== undefined) out.color = rgbaOf(patch.color, "text.color");
    if (patch.align !== undefined) {
      if (!["left", "center", "right"].includes(patch.align)) throw new Error("text.align is left, center or right.");
      out.align = patch.align;
    }
    if (patch.stroke !== undefined) out.stroke = inRange(patch.stroke, 0, 200, "text.stroke");
    if (patch.strokeColor !== undefined) out.strokeColor = rgbaOf(patch.strokeColor, "text.strokeColor");
    if (patch.lineHeight !== undefined) out.lineHeight = inRange(patch.lineHeight, 0.1, 10, "text.lineHeight");
    if (patch.tracking !== undefined) out.tracking = inRange(patch.tracking, -200, 200, "text.tracking");
    return out;
  }

  /* For the routes index.js owns that MOVE library files: Windows will not
   * rename a clip the serve child still holds open in a decoder. Awaiting this
   * first makes the child let go; a no-op when no child is running. */
  handle.releaseSources = releaseSources;

  return handle;
}
