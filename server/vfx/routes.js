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
 * One action-dispatched POST plus four GETs, the shape /api/mv already uses, so
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
import { randomUUID } from "node:crypto";
import {
  LIMITS, LAYER_TYPES, BLEND_MODES, MATTE_TYPES, MASK_MODES, TRANSFORM_ARITY,
  listComps, readComp, createComp, updateComp, deleteComp,
  blankLayer, blankEffect, blankMask, newId, noteRun,
  compDir, previewDir, findLayer, pickEffect, wouldCycle,
  resolvePropPath, normalizeKeys, normalizeValue, normalizeEase,
  isKeyed, arityOf, evalProp, clamp, clampInt,
} from "./store.js";
import { getTemplate, buildTemplate, sourcesOf, listTemplates } from "./templates.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(__dirname, "engine.py");

/** Forward slashes everywhere in the job file — python on Windows is happier. */
const fwd = (p) => String(p).replace(/\\/g, "/");

const NO_ENGINE =
  "The VFX engine is not installed yet (server/vfx/engine.py is missing). "
  + "Comps, layers, keyframes and effects can all be built and edited without it — "
  + "only previewing and rendering need it.";

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

export function createVfxRoutes(deps) {
  const { json, readBody, config, IMAGE_DIR, CLIP_DIR, art } = deps;
  const PROJECT_DIR = deps.PROJECT_DIR ?? path.join(config.outputDir, "projects");
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
  async function runEngine(mode, job, { timeoutMs = 15 * 60_000, onProgress = null } = {}) {
    try { await stat(ENGINE); } catch { throw new Error(NO_ENGINE); }

    const dir = path.join(config.outputDir, "vfx");
    await mkdir(dir, { recursive: true });
    const jobPath = path.join(dir, `.job_${mode}_${Date.now().toString(36)}_${randomUUID().slice(0, 4)}.json`);
    await writeFile(jobPath, JSON.stringify(job), "utf8");

    try {
      const line = await new Promise((resolve, reject) => {
        const proc = spawnPython([ENGINE, mode, jobPath]);
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
        throw new Error(`The engine did not answer with JSON: ${String(line).slice(0, 200)}`);
      }
      if (!r.ok) throw new Error(r.error || `${mode} failed`);
      return r;
    } finally {
      unlink(jobPath).catch(() => {});
    }
  }

  /**
   * The effects catalog, read once and kept.
   *
   * A SUCCESS is cached forever — the file cannot change under a running
   * server without a restart. A FAILURE is cached for thirty seconds only,
   * because the usual reason for one is that effects.py has not landed yet, and
   * a permanent negative would outlive the fix.
   */
  let catalogHit = null;
  let catalogMiss = 0;
  let catalogMissWhy = "The effects catalog is not readable yet.";
  async function readCatalog() {
    if (catalogHit) return catalogHit;
    if (Date.now() < catalogMiss) throw new Error(catalogMissWhy);
    try {
      const line = await new Promise((resolve, reject) => {
        const proc = spawnPython(["-c", CATALOG_PROG]);
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
      catalogMissWhy = `The effects catalog is not readable yet (server/vfx/effects.py): ${err.message}`;
      throw new Error(catalogMissWhy);
    }
  }

  /** The catalog if it exists, null if it does not — for the paths that can cope. */
  const catalogOrNull = () => readCatalog().catch(() => null);

  /* ──────────────────────────────────────────────── sources → real files */

  /**
   * A copy of the comp with every source turned into an absolute path, §4.
   *
   * Disabled layers are skipped entirely: a hidden layer pointing at a file you
   * deleted last week is not a reason to refuse to render the nine that work.
   * Every enabled one must resolve, and the error names the layer, because
   * "file not found" against a 40-layer comp is not a message anyone can act on.
   */
  async function resolveComp(doc) {
    const out = JSON.parse(JSON.stringify(doc));
    const missing = [];
    for (const layer of out.layers) {
      if (layer.enabled === false) continue;
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

  /** Probe one library source for its true size and length. Null if it cannot. */
  async function probeSource(type, name) {
    const dir = type === "image" ? IMAGE_DIR : CLIP_DIR;
    const full = path.join(dir, name);
    try { await stat(full); } catch { return null; }
    try {
      const r = await runEngine("probe", { sources: [fwd(full)] }, { timeoutMs: 60_000 });
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

  function frameFile(doc, t, scale, draft) {
    const stamp = Number(doc.updatedAt).toString(36);
    const key = `${doc.slug}|${stamp}|${t}|${scale}|${draft ? 1 : 0}`;
    const running = inflight.get(key);
    if (running) return running;

    const job = (async () => {
      const dir = previewDir(doc.slug);
      const name = `f_${stamp}_${Math.round(t * 1000)}_${Math.round(scale * 1000)}${draft ? "d" : ""}.png`;
      const file = path.join(dir, name);
      try {
        const st = await stat(file);
        if (st.size > 0) return { file, cached: true, ms: 0, ...(frameMeta.get(key) || {}) };
      } catch { /* not rendered yet */ }

      await mkdir(dir, { recursive: true });
      const comp = await resolveComp(doc);
      const r = await runEngine("frame",
        { comp, t, out: fwd(file), scale, draft }, { timeoutMs: 120_000 });
      if (frameMeta.size > 400) frameMeta.clear();
      frameMeta.set(key, { width: r.width, height: r.height });
      prunePreviews(doc.slug, stamp).catch(() => {});
      return { file, width: r.width, height: r.height, ms: r.ms, cached: false };
    })();

    inflight.set(key, job);
    job.catch(() => {}).finally(() => {
      if (inflight.get(key) === job) inflight.delete(key);
    });
    return job;
  }

  /** Frames from a superseded edit are dead weight; keep the live stamp bounded. */
  async function prunePreviews(slug, stamp) {
    const dir = previewDir(slug);
    let names = [];
    try { names = await readdir(dir); } catch { return; }
    const stale = names.filter((n) => n.startsWith("f_") && !n.startsWith(`f_${stamp}_`));
    for (const n of stale) unlink(path.join(dir, n)).catch(() => {});
    const live = names.filter((n) => n.startsWith(`f_${stamp}_`));
    if (live.length <= 120) return;
    const rows = await Promise.all(live.map(async (n) => {
      const st = await stat(path.join(dir, n)).catch(() => null);
      return { n, at: st?.mtimeMs ?? 0 };
    }));
    rows.sort((a, b) => a.at - b.at);
    for (const r of rows.slice(0, rows.length - 120)) unlink(path.join(dir, r.n)).catch(() => {});
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
  async function startRender(slug, b, after = null) {
    const doc = await readComp(slug);
    if (!doc) throw new Error(`No such comp: ${slug}`);
    if (!doc.layers.length) throw new Error("This comp has no layers — there is nothing to render.");
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

    const comp = await resolveComp(doc);

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
        await updateComp(doc.slug, (d) => noteRun(d, {
          tool: "render",
          outcome: `${outName || path.basename(out)} — ${r.frames ?? "?"} frames, ${Math.round((r.ms ?? 0) / 1000)}s`,
        }));
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
    id: r.id, status: r.status, progress: Number(r.progress?.toFixed?.(3) ?? r.progress),
    frame: r.frame, frames: r.frames ?? null, format: r.format,
    clip: r.name, out: r.out, error: r.error,
    startedAt: r.startedAt, finishedAt: r.finishedAt, studio: r.studio ?? null,
  });
  const rendersFor = (slug) =>
    [...renders.values()].filter((r) => r.slug === slug).map(renderRow).reverse();

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

    if (p === "/api/vfx/catalog" && req.method === "GET") {
      try {
        json(res, 200, { effects: await readCatalog() });
      } catch (err) {
        json(res, 503, { error: String(err.message || err) });
      }
      return true;
    }

    if (p.startsWith("/api/vfx/comp/") && req.method === "GET") {
      const slug = safe(p.slice("/api/vfx/comp/".length));
      const comp = slug && await readComp(slug);
      if (!comp) { json(res, 404, { error: "No such comp." }); return true; }
      json(res, 200, { comp, renders: rendersFor(slug) });
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

        const r = await frameFile(doc, t, scale, draft);
        if (url.searchParams.get("meta")) {
          const q = `t=${t}&scale=${scale}&draft=${draft ? 1 : 0}`;
          json(res, 200, {
            ok: true, url: `/api/vfx/frame/${encodeURIComponent(slug)}?${q}`,
            width: r.width ?? null, height: r.height ?? null,
            ms: r.ms ?? 0, cached: !!r.cached, t, scale, draft,
          });
          return true;
        }
        const st = await stat(r.file);
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": st.size,
          // The URL does not carry the comp's version, so a cached copy is a
          // stale copy the moment anyone touches a keyframe.
          "Cache-Control": "no-store",
          "X-Vfx-Ms": String(r.ms ?? 0),
        });
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
            }
            layer.start = b.start === undefined ? 0 : inRange(b.start, 0, d.duration, "start");
            const naturalEnd = type === "video" && probe?.duration
              ? Math.min(layer.start + probe.duration, d.duration) : d.duration;
            layer.end = b.end === undefined ? naturalEnd : inRange(b.end, 0, d.duration, "end");
            if (layer.end <= layer.start) throw new Error("end must be after start.");
            if (b.color !== undefined) layer.color = rgbaOf(b.color, "color");
            if (b.text !== undefined) layer.text = mergeText(layer.text, b.text);
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
            if (b.motionBlur !== undefined) { layer.motionBlur = !!b.motionBlur; changed.push("motionBlur"); }
            if (b.blend !== undefined) { layer.blend = blendOf(b.blend); changed.push("blend"); }

            if (b.type !== undefined && b.type !== layer.type) {
              // A type change re-reads `src`, `color` and `text` as different
              // things entirely. Refusing is kinder than half-converting.
              throw new Error(`A layer's type cannot change (${layer.type} → ${b.type}). Add a new layer and remove this one.`);
            }
            if (b.src !== undefined) {
              if (layer.type !== "image" && layer.type !== "video") {
                throw new Error(`A ${layer.type} layer has no source file.`);
              }
              const src = need(b.src, "library name");
              const dir = layer.type === "image" ? IMAGE_DIR : CLIP_DIR;
              try { await stat(path.join(dir, src)); } catch {
                throw new Error(`${src} is not in the ${layer.type === "image" ? "images" : "clips"} library.`);
              }
              layer.src = src; changed.push("src");
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
              for (const [k, v] of Object.entries(b.transform)) {
                if (!(k in TRANSFORM_ARITY)) throw new Error(`No transform property "${k}".`);
                layer.transform[k] = coerceProp(v, TRANSFORM_ARITY[k], `transform.${k}`);
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

            if (keys !== undefined) {
              ref.owner[ref.key] = { keys: normalizeKeys(keys, { arity, label: ref.path }) };
              wrote = { path: ref.path, keys: ref.owner[ref.key].keys.length };
              noteRun(d, { tool: "set_prop", outcome: `${layer.name} ${ref.path}: ${keys.length} keyframes` });
            } else if (b.value !== undefined) {
              const v = normalizeValue(b.value, { label: ref.path });
              if (arity != null && arityOf(v) !== arity) {
                throw new Error(`${ref.path} takes ${arity} number(s), got ${arityOf(v)}.`);
              }
              ref.owner[ref.key] = v;
              wrote = { path: ref.path, keys: 0, value: v };
              noteRun(d, { tool: "set_prop", outcome: `${layer.name} ${ref.path} = ${JSON.stringify(v)}` });
            } else {
              throw new Error(`set_prop needs either "value" (a constant) or "keys" (an array of { t, v, ease? }).`);
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
               * with no value at all, which §1 has no reading for. */
              ref.owner[ref.key] = evalProp(cur, t);
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
         * Layers out into a comp of their own, and a placeholder left behind.
         *
         * §1's layer types are image | video | solid | text | adjustment | null
         * — there is no "comp" type, so a precomp CANNOT be a live nested
         * render without changing the engine's contract, which belongs to
         * another builder. What it can be is AE's other precompose: the child
         * exists as a real comp immediately, and the parent carries a video
         * layer that points at the child's RENDER. Until that render happens
         * the placeholder is disabled and says so, which is honest; render the
         * child as `mov` and set the placeholder's src to fill it.
         */
        case "precompose": {
          const slug = need(b.slug, "comp slug");
          const parent = await readComp(slug);
          if (!parent) throw new Error(`No such comp: ${slug}`);
          const ids = Array.isArray(b.layerIds) ? b.layerIds : [];
          if (!ids.length) throw new Error("Give layerIds — the layers to move into the new comp.");
          const moving = ids.map((id) => findLayer(parent, id));
          if (moving.length === parent.layers.length) {
            throw new Error("That is every layer in the comp — there would be nothing left to composite it into.");
          }

          const child = await createComp(b.name || `${parent.name} precomp`, {
            width: parent.width, height: parent.height, fps: parent.fps, duration: parent.duration,
            bg: [0, 0, 0, 0],                     // a precomp is transparent by definition
          });
          const movingIds = new Set(moving.map((l) => l.id));
          await updateComp(child.slug, (c) => {
            // Order is preserved, and a parent link pointing OUT of the set is
            // dropped: the layer it referred to is not in this comp any more.
            c.layers = parent.layers.filter((l) => movingIds.has(l.id))
              .map((l) => ({ ...JSON.parse(JSON.stringify(l)), parent: movingIds.has(l.parent) ? l.parent : null }));
            // A matte on the topmost moved layer has lost the layer above it.
            if (c.layers[0]?.trackMatte) c.layers[0].trackMatte = null;
            noteRun(c, { tool: "precompose", outcome: `${c.layers.length} layers from ${parent.slug}` });
            return c;
          });

          let holderId = null;
          const doc = await updateComp(slug, (d) => {
            const at = Math.min(...moving.map((l) => d.layers.findIndex((x) => x.id === l.id)));
            d.layers = d.layers.filter((l) => !movingIds.has(l.id));
            for (const l of d.layers) if (movingIds.has(l.parent)) l.parent = null;
            const holder = blankLayer(d, "video", { name: child.name });
            holder.src = null;
            holder.enabled = false;
            holder.precomp = child.slug;          // what this placeholder is waiting for
            d.layers.splice(clampInt(at, 0, d.layers.length), 0, holder);
            noteRun(d, { tool: "precompose", outcome: `${moving.length} layers → ${child.slug}` });
            holderId = holder.id;
            return d;
          });
          return json(res, 200, {
            ok: true, comp: doc, precompSlug: child.slug, layerId: holderId,
            next: `Render ${child.slug} as format "mov" (it keeps alpha), then set_layer { layerId: "${holderId}", src: "<the clip>", enabled: true }.`,
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
         * AUDIO HAS NOWHERE TO GO. §1 has no audio layer and the engine renders
         * pictures; dropping the audio items silently would make an import look
         * lossless when it is not, so each one lands as a MARKER at its start.
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

          for (const v of vids) {
            const dir = IMAGE_EXT.test(v.src) ? IMAGE_DIR : CLIP_DIR;
            try { await stat(path.join(dir, v.src)); } catch { missing.push(v.src); }
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
            for (const a of auds) {
              d.markers.push({ t: clamp(a.start, 0, d.duration), label: `audio: ${a.name}` });
            }
            d.markers.sort((x, y) => x.t - y.t);
            noteRun(d, {
              tool: "import_studio",
              outcome: `${file}: ${d.layers.length} layers, ${auds.length} audio item(s) as markers`,
            });
            return d;
          });
          return json(res, 200, {
            ok: true, slug: doc.slug, comp: doc,
            layers: doc.layers.length,
            audioAsMarkers: auds.length,
            missingSources: missing,
            note: auds.length
              ? "A comp renders pictures — the audio items were recorded as markers. Put the song back on the Studio timeline on export."
              : undefined,
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
          });

          return json(res, 200, {
            ok: true, jobId: rec.id, project: projectName,
            note: `Rendering. Poll GET /api/vfx/comp/${slug} → renders[] for this job id; the clip is placed on the Studio timeline when it finishes.`,
          }), true;
        }

        /* ── render ──────────────────────────────────────────────────── */

        case "render": {
          const rec = await startRender(need(b.slug, "comp slug"), b);
          return json(res, 200, {
            ok: true, jobId: rec.id, format: rec.format, clip: rec.name, out: rec.out,
            note: `Poll GET /api/vfx/comp/${rec.slug} → renders[] for progress.`,
          }), true;
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

  return handle;
}
