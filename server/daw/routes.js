/**
 * DAW — HTTP routes, mounted at /api/daw.
 *
 * ┌─ FOR THE INTEGRATOR ───────────────────────────────────────────────────┐
 * │ Three lines in server/index.js, nothing else:                          │
 * │                                                                        │
 * │  1. beside the other imports:                                          │
 * │     import { createDawRoutes } from "./daw/routes.js";                 │
 * │                                                                        │
 * │  2. beside the other runners:                                          │
 * │     const dawRoutes = createDawRoutes({ json, readBody, config });     │
 * │                                                                        │
 * │  3. inside the request handler's `try`, beside the vfx mount:          │
 * │     if (p === "/api/daw" || p.startsWith("/api/daw/")) {               │
 * │       if (await dawRoutes(req, res, url)) return; }                    │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * One action-dispatched POST plus a handful of GETs, the /api/vfx shape.
 * EVERY capability here is reachable from MCP too (server/mcp-daw.js), and
 * both surfaces call THESE routes — the dual-control rule (§13a of the DAW
 * report): one document, one reducer path, two hands. Every mutation takes a
 * `by` field ("agent" | "user", default user) that lands in the project's
 * ledger and on the notes it creates.
 *
 * ── THE DIRTY-REGION LOOP, which is what P0-1 exists to measure ──────────
 * A mutation answers with `dirty`: the regions whose content hash changed
 * (store.js's regionHashes — the hash IS the dirty bit AND the cache key).
 * `render` then only touches regions whose hash has no file on disk; every
 * clean region is a cache hit, reported as such so the stopwatch and the
 * tests can see the mechanism working rather than trust it. Region files are
 * content-addressed (reg<idx>_<hash>.wav), so the audio GET can mark them
 * immutable and the browser never re-downloads a region it already holds.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { stat, mkdir, writeFile, readdir, unlink, rename } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  LIMITS, INSTRUMENTS, TAILS, TICKS_PER_BEAT, REGION_BARS,
  listProjects, readProject, createProject, updateProject, deleteProject,
  blankTrack, blankClip, newId, noteLedger,
  findTrack, findClip, clipCovering, findNote,
  buildTimeline, projectSeconds, normPos, normalizeMeterMap, normalizeTempoMap,
  regionsOf, noteEvents, regionHashes, dirtyBetween,
  cacheDir, DAW_DIR, clamp, clampInt,
} from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(__dirname, "engine.py");

const NO_ENGINE =
  "The DAW engine is not installed (server/daw/engine.py is missing). "
  + "Projects, tracks, notes and meter maps can all be edited without it — "
  + "only rendering and calibration need it.";

/** How many content-addressed files to keep per region — enough for a
 *  browser mid-fetch of the old one while the new one lands. */
const CACHE_KEEP = 4;

/* Every live serve child this process built, so ONE exit hook sweeps them.
 * Same double-door as vfx: the hook kills on clean exit, stdin-EOF covers a
 * hard kill, because serve() exits on EOF by contract. */
const SERVE_CHILDREN = new Set();
let serveExitHooked = false;
function hookServeExit() {
  if (serveExitHooked) return;
  serveExitHooked = true;
  process.on("exit", () => {
    for (const p of SERVE_CHILDREN) {
      try { p.kill(); } catch { /* already gone */ }
      if (process.platform === "win32" && p.pid) {
        try {
          spawn("taskkill", ["/PID", String(p.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore", detached: true }).unref();
        } catch { /* taskkill missing is not worth a crash */ }
      }
    }
  });
}

export function createDawRoutes(deps) {
  const { json, readBody, config } = deps;
  const spawnPython = deps.spawnPython
    ?? ((args, opts = {}) => spawn(config.python, args, { windowsHide: true, ...opts }));

  const safe = (v) => {
    const s = path.basename(String(v ?? ""));
    return s && !s.includes("..") ? s : null;
  };
  function inRange(v, lo, hi, label) {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${label} must be a number.`);
    if (n < lo || n > hi) throw new Error(`${label} must be between ${lo} and ${hi} — got ${n}.`);
    return n;
  }
  /** The dual-control attribution. Anything that is not the agent is a user. */
  const byOf = (b) => (b?.by === "agent" ? "agent" : "user");

  /* ─────────────────────────────── the persistent engine — `serve` mode */

  /* The vfx lane, cut to this engine's needs: one child, one FIFO queue,
   * ready-line handshake, timeout kills the child (a serial process cannot
   * abandon a job), a failed start cools the lane down so a broken venv
   * degrades to per-call spawning. No idle file-release: this engine holds
   * no files open between jobs. */
  const SERVE_DISABLED = process.env.AIPLAY_DAW_NO_SERVE === "1";
  const READY_PATIENCE = 30_000;
  const SERVE_COOLDOWN = 60_000;

  const lane = {
    proc: null, starting: null, queue: Promise.resolve(),
    seq: 0, brokenUntil: 0, stderrTail: "",
  };
  const transport = (msg) => Object.assign(new Error(msg), { serveTransport: true });

  function laneDrop(proc) {
    if (lane.proc === proc) lane.proc = null;
    SERVE_CHILDREN.delete(proc);
    try { proc.kill(); } catch { /* already gone */ }
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
        () => fail(`the DAW serve child sent no ready line within ${READY_PATIENCE / 1000}s`),
        READY_PATIENCE);
      proc.on("error", (e) => fail(`could not start python (${config.python}): ${e.message}`));
      proc.on("close", (code) => {
        if (!ready) {
          fail(`the DAW serve child exited (${code}) before it was ready: ${lane.stderrTail.slice(-300)}`);
          return;
        }
        const w = proc._waiter;
        proc._waiter = null;
        if (w) w.settle(null, transport(`the DAW serve child died mid-job (exit ${code}): ${lane.stderrTail.slice(-300)}`));
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
          try { j = JSON.parse(s); } catch { continue; }
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
      try {
        proc.unref();
        proc.stdin.unref?.(); proc.stdout.unref?.(); proc.stderr.unref?.();
      } catch { /* not every stdio object can */ }
    });
  }

  async function serveProc() {
    if (lane.proc && lane.proc.exitCode === null) return lane.proc;
    if (Date.now() < lane.brokenUntil) throw transport("the DAW serve lane is cooling down after a failed start");
    if (!lane.starting) {
      lane.starting = spawnServe().then(
        (p) => { lane.starting = null; return p; },
        (err) => { lane.starting = null; lane.brokenUntil = Date.now() + SERVE_COOLDOWN; throw err; },
      );
    }
    return lane.starting;
  }

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
        laneDrop(proc);
        settle(null, Object.assign(
          new Error(`The engine ran past ${Math.round(timeoutMs / 1000)}s and was stopped.`),
          { serveTimeout: true }));
      }, timeoutMs);
      proc._waiter = { id, settle };
      try {
        proc.stdin.write(JSON.stringify({ id, cmd, job }) + "\n");
      } catch (err) {
        laneDrop(proc);
        settle(null, transport(`could not write to the DAW serve child: ${err.message}`));
      }
    });
    if (reply.ok === false) {
      if (reply.fatal) throw transport(`the DAW serve child hit ${reply.error} and exited`);
      throw new Error(reply.error || `${cmd} failed`);
    }
    return reply;
  }

  /** The per-call fallback: one job file, one process, one JSON line back. */
  async function runOnce(mode, job, timeoutMs = 60_000) {
    try { await stat(ENGINE); } catch { throw new Error(NO_ENGINE); }
    await mkdir(DAW_DIR(), { recursive: true });
    const jobPath = path.join(DAW_DIR(), `.job_${mode}_${Date.now().toString(36)}_${randomUUID().slice(0, 4)}.json`);
    await writeFile(jobPath, JSON.stringify(job), "utf8");
    try {
      const line = await new Promise((resolve, reject) => {
        const proc = spawnPython([ENGINE, mode, jobPath]);
        let so = "", se = "", timedOut = false;
        const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
        proc.stdout.on("data", (d) => { so += d; });
        proc.stderr.on("data", (d) => { se += d; });
        proc.on("error", (e) => { clearTimeout(timer); reject(new Error(`Could not start python (${config.python}): ${e.message}`)); });
        proc.on("close", (code) => {
          clearTimeout(timer);
          const tail = so.trim().split(/\r?\n/).pop();
          if (timedOut) { reject(new Error(`The engine ran past ${Math.round(timeoutMs / 1000)}s and was stopped.`)); return; }
          if (code !== 0 && !tail) { reject(new Error(se.trim().slice(-400) || `engine exit ${code}`)); return; }
          resolve(tail);
        });
      });
      let r;
      try { r = JSON.parse(line); } catch {
        throw new Error(`engine.py did not answer with JSON: ${String(line).slice(0, 200)}`);
      }
      if (r.ok === false) throw new Error(r.error || `${mode} failed`);
      return r;
    } finally {
      unlink(jobPath).catch(() => {});
    }
  }

  /** Serve lane if willing, per-call if not — `engine: "serve" | "spawn"`. */
  async function runEngineFast(mode, job, timeoutMs = 60_000) {
    if (!SERVE_DISABLED) {
      try {
        const p = lane.queue.then(() => serveOne(mode, job, timeoutMs));
        lane.queue = p.then(() => {}, () => {});
        const r = await p;
        return { ...r, engine: "serve" };
      } catch (err) {
        if (err.serveTimeout) throw err;      // the time budget is spent — never pay it twice
        if (!err.serveTransport) throw err;   // an engine verdict, identical on either lane
      }
    }
    const r = await runOnce(mode, job, timeoutMs);
    return { ...r, engine: "spawn" };
  }

  /* ─────────────────────────────────── mutations answer with their dirt */

  /**
   * Read-modify-write with the region-hash diff taken INSIDE the writer
   * chain, so "what did this edit dirty" is computed against the exact
   * document states on either side of this one mutation and no other.
   */
  async function mutate(slug, b, action, fn) {
    let dirty = [], extra = {};
    const doc = await updateProject(slug, (d) => {
      const before = regionHashes(d);
      extra = fn(d) || {};
      const after = regionHashes(d);
      dirty = dirtyBetween(before, after, regionsOf(d));
      noteLedger(d, { by: byOf(b), action, ...(extra.ledger || {}) });
      return d;
    });
    return { doc, dirty, extra };
  }

  const mutReply = (res, { doc, dirty, extra }) => {
    const { ledger, ...rest } = extra;
    return json(res, 200, { ok: true, updatedAt: doc.updatedAt, dirty, ...rest });
  };

  /* ────────────────────────────────────────── region files, on demand */

  async function ensureRegions(slug, doc, fromBar, toBar) {
    const events = noteEvents(doc);
    const regions = regionsOf(doc);
    const hashes = regionHashes(doc, events, regions);
    const dir = cacheDir(slug);
    await mkdir(dir, { recursive: true });
    let existing = [];
    try { existing = await readdir(dir); } catch { /* fresh */ }
    const out = [];
    for (const r of regions) {
      if (r.toBar < fromBar || r.fromBar > toBar) continue;
      const name = `reg${r.idx}_${hashes[r.idx]}.wav`;
      const full = path.join(dir, name);
      const row = {
        idx: r.idx, fromBar: r.fromBar, toBar: r.toBar,
        t0: r.t0, t1: r.t1, startSample: r.startSample, nSamples: r.nSamples,
        hash: hashes[r.idx],
        url: `/api/daw/audio/${encodeURIComponent(slug)}/${name}`,
      };
      let have = existing.includes(name);
      if (have) {
        // a zero-byte file from a crash mid-write is not a cache hit
        try { have = (await stat(full)).size > 44; } catch { have = false; }
      }
      if (have) {
        out.push({ ...row, cached: true, rendered: false, ms: 0 });
        continue;
      }
      const notes = events
        .filter((e) => e.startSec < r.t1 && e.endSec > r.t0)
        .map((e) => ({
          inst: e.inst, midi: e.midi, vel: e.vel,
          start_sample: e.startSample, dur_samples: e.durSamples,
          gain_db: e.gainDb, seed: e.seed,
        }));
      const tmp = full + `.tmp-${process.pid}`;
      const rr = await runEngineFast("render", {
        sr: doc.sr, start_sample: r.startSample, n_samples: r.nSamples,
        notes, out: tmp,
      }, 120_000);
      // land atomically under the content-addressed name
      await rename(tmp, full);
      out.push({ ...row, cached: false, rendered: true, ms: rr.ms ?? 0, engine: rr.engine, sha1: rr.sha1 });
      // prune this region's stale generations, newest first
      const mine = existing.filter((f) => f.startsWith(`reg${r.idx}_`) && f !== name);
      if (mine.length > CACHE_KEEP - 1) {
        const stats = await Promise.all(mine.map(async (f) => ({
          f, mtime: (await stat(path.join(dir, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs ?? 0,
        })));
        stats.sort((a, b) => b.mtime - a.mtime);
        for (const s of stats.slice(CACHE_KEEP - 1)) {
          unlink(path.join(dir, s.f)).catch(() => {});
        }
      }
    }
    return out;
  }

  /* ──────────────────────────────────────────────────────────── routes */

  async function handle(req, res, url) {
    const p = url.pathname;

    /* ---- reads ---- */

    if (p === "/api/daw/projects" && req.method === "GET") {
      json(res, 200, { projects: await listProjects() });
      return true;
    }

    if (p.startsWith("/api/daw/project/") && req.method === "GET") {
      const slug = safe(p.slice("/api/daw/project/".length));
      const doc = slug && await readProject(slug);
      if (!doc) { json(res, 404, { error: "No such project." }); return true; }
      // The derived timeline rides along so no client re-implements the maps
      // to draw a grid — the server's bars are THE bars.
      json(res, 200, {
        project: doc,
        timeline: buildTimeline(doc),
        regions: regionsOf(doc),
        hashes: regionHashes(doc),
        totalSeconds: projectSeconds(doc),
      });
      return true;
    }

    /* Region audio. Content-addressed names, so a hit is immutable: the
     * browser may cache it forever, and a re-render is a NEW url. */
    if (p.startsWith("/api/daw/audio/") && req.method === "GET") {
      const rest = p.slice("/api/daw/audio/".length).split("/");
      const slug = safe(rest[0]);
      const name = safe(rest[1]);
      if (!slug || !name || !/^reg\d+_[0-9a-f]{12}\.wav$/.test(name)) {
        json(res, 400, { error: "bad audio path" }); return true;
      }
      const full = path.join(cacheDir(slug), name);
      try {
        const st = await stat(full);
        res.writeHead(200, {
          "Content-Type": "audio/wav",
          "Content-Length": st.size,
          "Cache-Control": "max-age=31536000, immutable",
        });
        createReadStream(full).pipe(res);
      } catch {
        json(res, 404, { error: "No such region render — call render first (the edit may have re-keyed it)." });
      }
      return true;
    }

    /* The calibration chirp, rendered once and served as a wav the browser
     * can decode and play through the speakers. */
    if (p === "/api/daw/chirp.wav" && req.method === "GET") {
      const full = path.join(DAW_DIR(), "_chirp48k.wav");
      try { await stat(full); } catch {
        try {
          await mkdir(DAW_DIR(), { recursive: true });
          await runEngineFast("chirp", { sr: 48000, out: full }, 30_000);
        } catch (err) {
          json(res, 503, { error: String(err.message || err) }); return true;
        }
      }
      const st = await stat(full);
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": st.size });
      createReadStream(full).pipe(res);
      return true;
    }

    /* P0-4: the loopback capture. The body is RAW little-endian float32 PCM
     * (what an AudioWorklet hands over — no container to mis-parse), ?sr=
     * names its rate. Answers the estimated offset and a confidence ratio. */
    if (p === "/api/daw/calibrate" && req.method === "POST") {
      const sr = clampInt(Number(url.searchParams.get("sr")) || 48000, 8000, 192000);
      const chunks = [];
      let bytes = 0;
      try {
        for await (const c of req) {
          bytes += c.length;
          if (bytes > 64 * 1024 * 1024) throw new Error("capture too large (64 MB cap)");
          chunks.push(c);
        }
        const buf = Buffer.concat(chunks);
        if (buf.length < sr * 0.1 * 4) {
          throw new Error(`capture too short (${buf.length} bytes) — record at least the chirp plus headroom`);
        }
        await mkdir(DAW_DIR(), { recursive: true });
        const capPath = path.join(DAW_DIR(), `.cap_${Date.now().toString(36)}.f32`);
        await writeFile(capPath, buf);
        try {
          const r = await runEngineFast("calibrate", { sr, capture: capPath }, 60_000);
          json(res, 200, {
            ok: true, offset_ms: r.offset_ms, peak_ratio: r.peak_ratio,
            confident: r.confident,
            note: r.confident
              ? "Store this offset and shift recorded takes earlier by it."
              : "The correlation peak is not clearly above its rivals — check levels and try again.",
          });
        } finally {
          unlink(capPath).catch(() => {});
        }
      } catch (err) {
        json(res, 400, { error: String(err.message || err) });
      }
      return true;
    }

    /* ---- writes ---- */

    if (p !== "/api/daw" || req.method !== "POST") return false;

    let b, action;
    try {
      b = await readBody(req);
      action = String(b.action || "");
    } catch (err) {
      return json(res, 400, { error: `The request body is not JSON: ${err.message}` }), true;
    }

    try {
      switch (action) {

        /* ── the project itself ─────────────────────────────────────── */

        case "create": {
          const opts = {
            bpm: b.bpm === undefined ? 120 : inRange(b.bpm, LIMITS.bpm[0], LIMITS.bpm[1], "bpm"),
            num: b.num === undefined ? 4 : clampInt(inRange(b.num, LIMITS.meterNum[0], LIMITS.meterNum[1], "num"), 1, 32),
            den: b.den === undefined ? 4 : Number(b.den),
            lengthBars: b.length_bars === undefined ? 16
              : clampInt(inRange(b.length_bars, 1, LIMITS.lengthBars, "length_bars"), 1, LIMITS.lengthBars),
          };
          if (b.den !== undefined && !LIMITS.meterDen.includes(opts.den)) {
            throw new Error(`den must be one of ${LIMITS.meterDen.join(", ")}.`);
          }
          const doc = await createProject(b.name || "Untitled", opts);
          await updateProject(doc.slug, (d) => noteLedger(d, { by: byOf(b), action: "create" }));
          return json(res, 200, { ok: true, slug: doc.slug, project: await readProject(doc.slug) }), true;
        }

        case "delete": {
          const slug = safe(b.slug);
          if (!slug || !(await readProject(slug))) throw new Error("No such project.");
          await deleteProject(slug);
          return json(res, 200, { ok: true, deleted: slug }), true;
        }

        case "set_length": {
          const slug = safe(b.slug);
          const bars = clampInt(inRange(b.length_bars, 1, LIMITS.lengthBars, "length_bars"), 1, LIMITS.lengthBars);
          const m = await mutate(slug, b, "set_length", (d) => {
            d.lengthBars = bars;
            return { lengthBars: bars, ledger: { detail: `${bars} bars` } };
          });
          return mutReply(res, m), true;
        }

        /* ── meter and tempo — the §12 event lists, edited as events ──── */

        case "set_meter": {
          const slug = safe(b.slug);
          const atBar = clampInt(inRange(b.at_bar, 1, LIMITS.lengthBars, "at_bar"), 1, LIMITS.lengthBars);
          const num = clampInt(inRange(b.num, LIMITS.meterNum[0], LIMITS.meterNum[1], "num"), 1, 32);
          const den = Number(b.den);
          if (!LIMITS.meterDen.includes(den)) throw new Error(`den must be one of ${LIMITS.meterDen.join(", ")}.`);
          const m = await mutate(slug, b, "set_meter", (d) => {
            d.meterMap = normalizeMeterMap([...d.meterMap.filter((e) => e.atBar !== atBar), { atBar, num, den }]);
            return { meterMap: d.meterMap, ledger: { detail: `${num}/${den} at bar ${atBar}` } };
          });
          return mutReply(res, m), true;
        }

        case "remove_meter": {
          const slug = safe(b.slug);
          const atBar = clampInt(inRange(b.at_bar, 2, LIMITS.lengthBars, "at_bar"), 2, LIMITS.lengthBars);
          const m = await mutate(slug, b, "remove_meter", (d) => {
            const before = d.meterMap.length;
            d.meterMap = normalizeMeterMap(d.meterMap.filter((e) => e.atBar !== atBar));
            if (d.meterMap.length === before) throw new Error(`No meter event at bar ${atBar}. Events: ${d.meterMap.map((e) => `bar ${e.atBar} (${e.num}/${e.den})`).join(", ")}.`);
            return { meterMap: d.meterMap };
          });
          return mutReply(res, m), true;
        }

        case "set_tempo": {
          const slug = safe(b.slug);
          const atBar = clampInt(inRange(b.at_bar, 1, LIMITS.lengthBars, "at_bar"), 1, LIMITS.lengthBars);
          const bpm = inRange(b.bpm, LIMITS.bpm[0], LIMITS.bpm[1], "bpm");
          const m = await mutate(slug, b, "set_tempo", (d) => {
            d.tempoMap = normalizeTempoMap([...d.tempoMap.filter((e) => e.atBar !== atBar), { atBar, bpm }]);
            return { tempoMap: d.tempoMap, ledger: { detail: `${bpm} bpm at bar ${atBar}` } };
          });
          return mutReply(res, m), true;
        }

        case "remove_tempo": {
          const slug = safe(b.slug);
          const atBar = clampInt(inRange(b.at_bar, 2, LIMITS.lengthBars, "at_bar"), 2, LIMITS.lengthBars);
          const m = await mutate(slug, b, "remove_tempo", (d) => {
            const before = d.tempoMap.length;
            d.tempoMap = normalizeTempoMap(d.tempoMap.filter((e) => e.atBar !== atBar));
            if (d.tempoMap.length === before) throw new Error(`No tempo event at bar ${atBar}. Events: ${d.tempoMap.map((e) => `bar ${e.atBar} (${e.bpm} bpm)`).join(", ")}.`);
            return { tempoMap: d.tempoMap };
          });
          return mutReply(res, m), true;
        }

        /* ── tracks and clips ─────────────────────────────────────────── */

        case "add_track": {
          const slug = safe(b.slug);
          const inst = String(b.instrument || "pluck");
          if (!INSTRUMENTS.includes(inst)) {
            throw new Error(`instrument must be one of ${INSTRUMENTS.join(", ")} — got "${inst}".`);
          }
          const m = await mutate(slug, b, "add_track", (d) => {
            if (d.tracks.length >= LIMITS.tracks) throw new Error(`This project already has ${LIMITS.tracks} tracks.`);
            const track = blankTrack(b.name, inst);
            /* A track without a clip cannot hold a note, and "add_clip first"
             * is a speed bump both hands would hit every time — so a track
             * arrives with one clip spanning the project unless told not to. */
            if (b.with_clip !== false) track.clips.push(blankClip(1, d.lengthBars));
            d.tracks.push(track);
            return { trackId: track.id, clipId: track.clips[0]?.id ?? null,
                     ledger: { detail: `${track.name} (${inst})` } };
          });
          return mutReply(res, m), true;
        }

        case "set_track": {
          const slug = safe(b.slug);
          const m = await mutate(slug, b, "set_track", (d) => {
            const t = findTrack(d, b.track);
            if (b.name !== undefined) t.name = String(b.name).slice(0, 80);
            if (b.instrument !== undefined) {
              if (!INSTRUMENTS.includes(b.instrument)) throw new Error(`instrument must be one of ${INSTRUMENTS.join(", ")}.`);
              t.instrument = b.instrument;
            }
            if (b.gain_db !== undefined) t.gainDb = inRange(b.gain_db, LIMITS.gainDb[0], LIMITS.gainDb[1], "gain_db");
            if (b.mute !== undefined) t.mute = !!b.mute;
            return { track: { id: t.id, name: t.name, instrument: t.instrument, gainDb: t.gainDb, mute: t.mute } };
          });
          return mutReply(res, m), true;
        }

        case "remove_track": {
          const slug = safe(b.slug);
          const m = await mutate(slug, b, "remove_track", (d) => {
            const t = findTrack(d, b.track);
            d.tracks = d.tracks.filter((x) => x.id !== t.id);
            return { removed: t.id, ledger: { detail: t.name } };
          });
          return mutReply(res, m), true;
        }

        case "add_clip": {
          const slug = safe(b.slug);
          const m = await mutate(slug, b, "add_clip", (d) => {
            const t = findTrack(d, b.track);
            if (t.clips.length >= LIMITS.clipsPerTrack) throw new Error(`Track ${t.id} already has ${LIMITS.clipsPerTrack} clips.`);
            const from = clampInt(inRange(b.from_bar, 1, d.lengthBars, "from_bar"), 1, d.lengthBars);
            const bars = clampInt(inRange(b.bars ?? 4, 1, d.lengthBars, "bars"), 1, d.lengthBars);
            const clip = blankClip(from, Math.min(from + bars - 1, d.lengthBars), { name: b.name });
            t.clips.push(clip);
            return { clipId: clip.id, fromBar: clip.fromBar, toBar: clip.toBar };
          });
          return mutReply(res, m), true;
        }

        case "remove_clip": {
          const slug = safe(b.slug);
          const m = await mutate(slug, b, "remove_clip", (d) => {
            const t = findTrack(d, b.track);
            const c = findClip(t, b.clip);
            t.clips = t.clips.filter((x) => x.id !== c.id);
            return { removed: c.id, notesRemoved: c.notes.length };
          });
          return mutReply(res, m), true;
        }

        /* ── notes — the piano roll as data ───────────────────────────── */

        case "add_note": {
          const slug = safe(b.slug);
          const m = await mutate(slug, b, "add_note", (d) => {
            const t = findTrack(d, b.track);
            const pos = normPos(d, { bar: b.bar, beat: b.beat, tick: b.tick }, "note");
            const c = b.clip ? findClip(t, b.clip) : clipCovering(t, pos.bar);
            if (c.notes.length >= LIMITS.notesPerClip) throw new Error(`Clip ${c.id} already holds ${LIMITS.notesPerClip} notes.`);
            const note = {
              id: newId("nt", 6),
              ...pos,
              durTicks: clampInt(b.dur_ticks === undefined ? TICKS_PER_BEAT
                : inRange(b.dur_ticks, LIMITS.durTicks[0], LIMITS.durTicks[1], "dur_ticks"),
                LIMITS.durTicks[0], LIMITS.durTicks[1]),
              pitch: clampInt(inRange(b.pitch, LIMITS.pitch[0], LIMITS.pitch[1], "pitch"), 0, 127),
              vel: clampInt(b.vel === undefined ? 100 : inRange(b.vel, LIMITS.vel[0], LIMITS.vel[1], "vel"), 1, 127),
              by: byOf(b),
            };
            c.notes.push(note);
            return { note, trackId: t.id, clipId: c.id,
                     ledger: { detail: `pitch ${note.pitch} at ${note.bar}.${note.beat}.${note.tick}` } };
          });
          return mutReply(res, m), true;
        }

        case "move_note": {
          const slug = safe(b.slug);
          const m = await mutate(slug, b, "move_note", (d) => {
            const t = findTrack(d, b.track);
            const c = b.clip ? findClip(t, b.clip)
              : t.clips.find((x) => x.notes.some((n) => n.id === String(b.note)));
            if (!c) throw new Error(`No clip on ${t.id} holds note ${b.note}.`);
            const n = findNote(c, b.note);
            const pos = normPos(d, {
              bar: b.bar ?? n.bar, beat: b.beat ?? n.beat, tick: b.tick ?? n.tick,
            }, "note");
            Object.assign(n, pos);
            if (b.pitch !== undefined) n.pitch = clampInt(inRange(b.pitch, LIMITS.pitch[0], LIMITS.pitch[1], "pitch"), 0, 127);
            if (b.dur_ticks !== undefined) n.durTicks = clampInt(inRange(b.dur_ticks, LIMITS.durTicks[0], LIMITS.durTicks[1], "dur_ticks"), LIMITS.durTicks[0], LIMITS.durTicks[1]);
            if (b.vel !== undefined) n.vel = clampInt(inRange(b.vel, LIMITS.vel[0], LIMITS.vel[1], "vel"), 1, 127);
            return { note: n, trackId: t.id, clipId: c.id };
          });
          return mutReply(res, m), true;
        }

        case "delete_note": {
          const slug = safe(b.slug);
          const m = await mutate(slug, b, "delete_note", (d) => {
            const t = findTrack(d, b.track);
            const c = b.clip ? findClip(t, b.clip)
              : t.clips.find((x) => x.notes.some((n) => n.id === String(b.note)));
            if (!c) throw new Error(`No clip on ${t.id} holds note ${b.note}.`);
            const n = findNote(c, b.note);
            c.notes = c.notes.filter((x) => x.id !== n.id);
            return { removed: n.id };
          });
          return mutReply(res, m), true;
        }

        /* ── the render — only what is dirty ──────────────────────────── */

        case "render": {
          const slug = safe(b.slug);
          const doc = slug && await readProject(slug);
          if (!doc) throw new Error("No such project.");
          const fromBar = b.from_bar === undefined ? 1
            : clampInt(inRange(b.from_bar, 1, doc.lengthBars, "from_bar"), 1, doc.lengthBars);
          const toBar = b.to_bar === undefined ? doc.lengthBars
            : clampInt(inRange(b.to_bar, fromBar, doc.lengthBars, "to_bar"), fromBar, doc.lengthBars);
          const t0 = Date.now();
          const regions = await ensureRegions(slug, doc, fromBar, toBar);
          return json(res, 200, {
            ok: true,
            updatedAt: doc.updatedAt,
            sr: doc.sr,
            totalSeconds: projectSeconds(doc),
            regionBars: REGION_BARS,
            regions,
            rendered: regions.filter((r) => r.rendered).length,
            cachedHits: regions.filter((r) => r.cached).length,
            ms: Date.now() - t0,
          }), true;
        }

        /* ── the engine's own mouth, for the seam between the two tables */

        case "probe": {
          const r = await runEngineFast("probe", {}, 30_000);
          return json(res, 200, { ok: true, ...r, storeTails: TAILS, storeInstruments: INSTRUMENTS }), true;
        }

        default:
          return json(res, 400, {
            error: `Unknown action "${action}". Actions: create, delete, set_length, `
              + "set_meter, remove_meter, set_tempo, remove_tempo, add_track, set_track, "
              + "remove_track, add_clip, remove_clip, add_note, move_note, delete_note, "
              + "render, probe.",
          }), true;
      }
    } catch (err) {
      return json(res, 400, { error: String(err.message || err) }), true;
    }
  }

  return handle;
}
