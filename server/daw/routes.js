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
import { stat, mkdir, writeFile, readdir, unlink, rename, readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import {
  LIMITS, INSTRUMENTS, TAILS, TICKS_PER_BEAT, REGION_BARS,
  PATCHES, PATCH_IDS, PATCH_MANIFEST, normParams,
  listProjects, readProject, createProject, updateProject, deleteProject,
  blankTrack, blankClip, newId, noteLedger,
  findTrack, findClip, clipCovering, findNote,
  /* the clip-bounds surface (agent/dawparity) */
  shiftClipNotes, notesOutsideClip,
  buildTimeline, projectSeconds, normPos, normalizeMeterMap, normalizeTempoMap,
  regionsOf, noteEvents, regionHashes, dirtyBetween,
  cacheDir, DAW_DIR, clamp, clampInt,
  /* [DAWREC] the capture surface */
  audioDir, projectDir, blankAudioClip, blankTake, findAudioClip, findTake,
  audioStartSample, audioEvents, noteSeed,
} from "./store.js";
/* [DAWREC] the capture path's own module — sessions, comping, the click,
 * latency settings, and the actor-honest provenance event chooser. */
import {
  beginSession, getSession, endSession, listSessions, addChunk, assembleSession,
  latencyShift, takePlacement, punchTrim, flattenComp, clickEvents,
  readLatency, writeLatency, offsetFor, captureEvent, parseWavF32, quantizePos,
  posSeconds,
} from "./capture.js";
/* CHAIN STAGE (agent/dawrack): the mixer's actions, job payload and catalog
 * parity live in mixer.js; this file only dispatches to them and switches a
 * render onto the chain path when the mixer is not default. */
import {
  handleMixerAction, mixerJobPayload, isDefaultMixer, catalogsAgree,
  MIXER_CATALOG, MIXER_ACTIONS,
} from "./mixer.js";
/* DAWINST SEAM: the palette — install/uninstall behind the licence gate,
 * and the packs a project's tracks actually need. */
import {
  instrumentsDir, listPatches, patchInstalled, packsNeededFor,
  installPack, uninstallPack, packState, licenceGate,
} from "./patches.js";
import * as prov from "../provenance.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(__dirname, "engine.py");
const CAPTURE = path.join(__dirname, "capture.py");   // [DAWREC]
const INSTRUMENTS_PY = path.join(__dirname, "instruments.py");
const TAG_AUDIO = path.join(__dirname, "..", "tag_audio.py");

/** One newline splitter for the child-process readers below. */
const NL_RE = /\r?\n/;

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

  /* [DAWREC] The provenance ledger, injected like vfx does it — optional so
   * the structural tests can build this factory bare, and guarded so a
   * ledger failure never costs a take. */
  const prov = deps.provenance ?? null;
  const provNote = (scope, evt) => {
    if (!prov) return;
    prov.append(scope, evt).catch((err) =>
      console.error(`  [provenance] event lost (${evt?.type}/${evt?.asset}): ${err.message}`));
  };
  const actorOf = (req) => (prov ? prov.actorFrom(req) : "system");

  const safe = (v) => {
    const s = path.basename(String(v ?? ""));
    return s && !s.includes("..") ? s : null;
  };
  /* [DAWREC] a short content key for cacheable derived files (the click). */
  const createHashShort = (s) =>
    createHash("sha1").update(String(s)).digest("hex").slice(0, 12);
  function inRange(v, lo, hi, label) {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${label} must be a number.`);
    if (n < lo || n > hi) throw new Error(`${label} must be between ${lo} and ${hi} — got ${n}.`);
    return n;
  }
  /** The dual-control attribution. Anything that is not the agent is a user. */
  const byOf = (b) => (b?.by === "agent" ? "agent" : "user");

  /**
   * A patch a track may actually hold. Three refusals, each naming its fix:
   *   unknown        -> the list of what exists
   *   generate-row   -> its OWN honest message (sax/sitar/choir/solo cello:
   *                     no free sampleset does them justice, so the row
   *                     exists, explains itself, and refuses rather than
   *                     shipping a weak patch)
   *   not installed  -> which packs to install, with their licences
   */
  async function assertAssignablePatch(pid) {
    const row = PATCHES[pid];
    if (!row) {
      throw new Error(`No such patch "${pid}". Installed and available: ${PATCH_IDS.join(", ")}.`);
    }
    if (row.kind === "generate") {
      throw new Error(row.refusal);
    }
    if (!(await patchInstalled(pid))) {
      const need = await packsNeededFor(pid);
      const gate = licenceGate(need);
      throw new Error(
        `Patch "${pid}" (${row.label}) is not installed. Install ${need.join(" + ")} first `
        + `(POST /api/daw {action:"install_patch"} or the daw_patches tool): `
        + gate.map((g) => `${g.label} — ${g.licence.name}, ${(g.bytes / 1e6).toFixed(0)} MB`).join("; ")
        + ".");
    }
  }

  /* ── CREDITS: every render that used a licensed patch is recorded ───────
   *
   * The binding requirement. A patch whose pack carries an attribution
   * appends ONE `licence_attach` event per (project, pack) to the project's
   * provenance ledger, carrying the attribution text the licence asks for.
   * The bounce then embeds those texts through the existing Tier-2 path, and
   * daw_credits reads them back. CC-BY compliance is what makes this palette
   * shippable, so a missing attribution is a TEST FAILURE, not a warning.
   *
   * Idempotent by construction: the ledger is read first and a pack already
   * attached for this project is not attached again — a re-render must not
   * grow the ledger, but a NEW patch in the project must always land.
   */
  const provScope = (slug) => ({ dir: projectDir(slug) });

  function packsUsedBy(doc) {
    const out = new Map();
    for (const t of doc.tracks) {
      const row = PATCHES[t.instrument?.patch];
      if (!row?.pack) continue;                 // builtins carry no licence duty
      const pack = PATCH_MANIFEST.packs[row.pack];
      if (!pack?.attribution) continue;
      out.set(row.pack, pack);
    }
    return out;
  }

  async function attachLicences(slug, doc, actor) {
    const used = packsUsedBy(doc);
    if (!used.size) return [];
    let already = new Set();
    try {
      const { events } = await prov.read(provScope(slug), { type: "licence_attach" });
      already = new Set(events.map((e) => e.data?.pack).filter(Boolean));
    } catch { /* an unreadable ledger must not cost the render */ }
    const added = [];
    for (const [packId, pack] of used) {
      if (already.has(packId)) continue;
      try {
        await prov.append(provScope(slug), {
          actor,
          type: "licence_attach",
          asset: `daw/${slug}`,
          data: {
            pack: packId,
            spdx: pack.licence.spdx,
            licenceName: pack.licence.name,
            attributionText: pack.attribution,
            sourceUrl: pack.source,
            licenceUrl: pack.licence.url,
            required: !!pack.attribution_required,
          },
        });
        added.push(packId);
      } catch (err) {
        // Loud, never silent: a compliance layer that fails quietly is not one.
        console.error(`  [daw] licence_attach LOST for ${slug}/${packId}: ${err.message}`);
      }
    }
    return added;
  }

  /** The project's accumulated attributions, newest last. */
  async function creditsOf(slug) {
    let events = [];
    try {
      ({ events } = await prov.read(provScope(slug), { type: "licence_attach" }));
    } catch { /* none yet */ }
    const seen = new Set();
    const credits = [];
    for (const e of events) {
      const packId = e.data?.pack;
      if (!packId || seen.has(packId)) continue;
      seen.add(packId);
      credits.push({
        pack: packId,
        spdx: e.data.spdx || null,
        licence: e.data.licenceName || null,
        attribution: e.data.attributionText || null,
        source: e.data.sourceUrl || null,
        required: !!e.data.required,
        at: e.t,
      });
    }
    return credits;
  }

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

  /** The per-call fallback: one job file, one process, one JSON line back.
   * [DAWREC] `script` widens it to capture.py — same contract, same lane. */
  async function runOnce(mode, job, timeoutMs = 60_000, script = ENGINE) {
    try { await stat(script); } catch { throw new Error(NO_ENGINE); }
    await mkdir(DAW_DIR(), { recursive: true });
    const jobPath = path.join(DAW_DIR(), `.job_${mode}_${Date.now().toString(36)}_${randomUUID().slice(0, 4)}.json`);
    await writeFile(jobPath, JSON.stringify(job), "utf8");
    try {
      const line = await new Promise((resolve, reject) => {
        const proc = spawnPython([script, mode, jobPath]);
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

  /** [DAWREC] capture.py, per-call only: encoding a take happens once per
   * take — the serve lane's startup amortisation buys nothing here. */
  const runCapture = (mode, job, timeoutMs = 120_000) => runOnce(mode, job, timeoutMs, CAPTURE);
  /* ── the instrument stage's own CLI, for the jobs the render lane is not:
   * the bounce encoder. Same one-JSON-line contract as engine.py. */
  async function runInstruments(mode, job, timeoutMs = 120_000) {
    await mkdir(DAW_DIR(), { recursive: true });
    const jobPath = path.join(DAW_DIR(), `.inst_${mode}_${Date.now().toString(36)}_${randomUUID().slice(0, 4)}.json`);
    await writeFile(jobPath, JSON.stringify(job), "utf8");
    try {
      const line = await new Promise((resolve, reject) => {
        const proc = spawnPython([INSTRUMENTS_PY, mode, jobPath]);
        let so = "", se = "", timedOut = false;
        const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
        proc.stdout.on("data", (d) => { so += d; });
        proc.stderr.on("data", (d) => { se += d; });
        proc.on("error", (e) => { clearTimeout(timer); reject(new Error(`Could not start python (${config.python}): ${e.message}`)); });
        proc.on("close", (code) => {
          clearTimeout(timer);
          if (timedOut) { reject(new Error(`instruments.py ${mode} ran past ${Math.round(timeoutMs / 1000)}s and was stopped.`)); return; }
          const tail = so.trim().split(NL_RE).pop();
          if (!tail) { reject(new Error(se.trim().slice(-400) || `instruments.py exit ${code}`)); return; }
          resolve(tail);
        });
      });
      const r = JSON.parse(line);
      if (r.ok === false) throw new Error(r.error || `${mode} failed`);
      return r;
    } finally {
      unlink(jobPath).catch(() => {});
    }
  }

  /**
   * Tag a bounce. The Tier-1 AI marker rides tag_audio.py unconditionally;
   * what THIS function adds is the class and the attribution lines — the
   * CC-BY credit that makes the palette shippable. A DAW bounce is
   * human-authored by default (a person placed every note); a project that
   * used licensed samples is third-party-licensed, which is what the ledger
   * already folded it to.
   */
  async function tagBounce(file, doc, credits) {
    const lines = credits.map((c) => c.attribution).filter(Boolean);
    const cls = lines.length ? "third-party-licensed" : "human-authored";
    const marker = prov.markerFor(cls, { model: null, media: "audio" });
    const meta = {
      title: doc.name,
      generator: `AIPLAY Studio DAW (${doc.tracks.map((t) => t.instrument.patch).join(", ") || "no tracks"})`,
      digitalSourceType: marker.digitalSourceType,
      disclosure: marker.disclosure,
      attribution: lines,
      tier2: config.provenance?.embedRecord !== false,
      date: new Date().toISOString().slice(0, 10),
    };
    const metaPath = path.join(DAW_DIR(), `.tag_${Date.now().toString(36)}.json`);
    await writeFile(metaPath, JSON.stringify(meta), "utf8");
    try {
      const out = await new Promise((resolve) => {
        const proc = spawnPython([TAG_AUDIO, file, metaPath]);
        let so = "";
        proc.stdout.on("data", (d) => { so += d; });
        proc.on("exit", () => resolve(so));
        proc.on("error", () => resolve(""));
      });
      const r = JSON.parse(out.trim().split(NL_RE).pop() || "{}");
      return { ...r, attribution: lines, class: cls };
    } catch (err) {
      // A tagging failure must never cost the audio — but it IS reported,
      // because an untagged bounce of CC-BY material is a compliance gap.
      return { ok: false, error: String(err.message || err), attribution: lines, class: cls };
    } finally {
      unlink(metaPath).catch(() => {});
    }
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

  /**
   * The tracks this machine cannot voice, and the notes that go with them.
   *
   * A project is a document, not an installation: it arrives from someone
   * else naming packs this disk has never had. Refusing to render the WHOLE
   * song because one track wants a piano is the wrong trade — a DAW whose
   * plugin is missing plays the rest and tells you what is silent, and that
   * is what this does. The notes are dropped from the EVENT list, so the
   * region hash is computed from what actually sounds: installing the pack
   * changes the hash and the region re-renders by itself, with no cache to
   * invalidate by hand and no stale silence to explain.
   */
  async function silencedByMissingPacks(doc) {
    const missing = [];
    const dead = new Set();
    for (const t of doc.tracks) {
      const pid = t.instrument?.patch;
      if (!pid || dead.has(t.id)) continue;
      const row = PATCHES[pid];
      if (!row || row.kind === "builtin") continue;
      if (row.kind === "generate") {
        dead.add(t.id);
        missing.push({ trackId: t.id, track: t.name, patch: pid, label: row.label,
                       kind: "generate", reason: row.refusal, packs: [] });
        continue;
      }
      if (await patchInstalled(pid)) continue;
      dead.add(t.id);
      const need = await packsNeededFor(pid);
      missing.push({
        trackId: t.id, track: t.name, patch: pid, label: row.label, kind: row.kind,
        reason: `"${t.name}" is silent: ${row.label} is not installed on this machine.`,
        packs: licenceGate(need).map((g) => ({
          id: g.id, label: g.label, licence: g.licence.name, bytes: g.bytes,
        })),
      });
    }
    return { missing, dead };
  }

  async function ensureRegions(slug, doc, fromBar, toBar) {
    const { missing: missingPacks, dead } = await silencedByMissingPacks(doc);
    const events = dead.size
      ? noteEvents(doc).filter((e) => !dead.has(e.trackId))
      : noteEvents(doc);
    const regions = regionsOf(doc);
    /* [DAWREC] file-backed clips ride the same manifest: they are hashed
     * into the region identity and handed to the engine with absolute
     * paths, mixed into the dry buffer before the master curve. */
    const audio = audioEvents(doc);
    const hashes = regionHashes(doc, events, regions, audio);
    /* CHAIN STAGE: a non-default mixer renders through rack.py — stereo,
     * processed from absolute sample 0 (the determinism rule), so the job
     * carries every note whose REACH touches the window plus the mixer
     * payload. A default mixer keeps the exact P0 mono job, byte for byte. */
    const chained = !isDefaultMixer(doc);
    const mixer = chained ? mixerJobPayload(doc) : null;
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
        .filter((e) => e.reach0 < r.t1 && e.reach1 > r.t0)
        .map((e) => ({
          inst: e.inst, params: e.params, midi: e.midi, vel: e.vel,
          start_sample: e.startSample, dur_samples: e.durSamples,
          gain_db: e.gainDb, seed: e.seed,
          ...(chained ? { track_id: e.trackId } : {}),
        }));
      /* [DAWREC] the audio clips whose samples reach this window */
      const clips = audio
        .filter((a) => a.startSec < r.t1 && a.endSec > r.t0)
        .map((a) => ({
          path: path.join(audioDir(slug), a.file),
          start_sample: a.startSample, offset_samples: a.offsetSamples,
          dur_samples: a.durSamples, gain_db: a.gainDb,
        }));
      const tmp = full + `.tmp-${process.pid}`;
      const rr = await runEngineFast("render", {
        sr: doc.sr, start_sample: r.startSample, n_samples: r.nSamples,
        instruments_dir: instrumentsDir(),
        notes, ...(clips.length ? { audio: clips } : {}), out: tmp,
        ...(chained ? { mixer } : {}),
      }, 300_000);
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
    out.missingPacks = missingPacks;     // a property, so every caller keeps its array
    return out;
  }

  /* ─────────────────────────── [DAWREC] capture helpers, shared by routes */

  /** Read a raw request body up to `cap` bytes. */
  async function readRaw(req, cap = 64 * 1024 * 1024) {
    const chunks = [];
    let bytes = 0;
    for await (const c of req) {
      bytes += c.length;
      if (bytes > cap) throw new Error(`body too large (${Math.round(cap / 1048576)} MB cap)`);
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  /** The chirp as Float32Array at `sr`, rendered once per rate and cached. */
  async function chirpSamples(sr) {
    const full = path.join(DAW_DIR(), sr === 48000 ? "_chirp48k.wav" : `_chirp${sr}.wav`);
    try { await stat(full); } catch {
      await mkdir(DAW_DIR(), { recursive: true });
      await runEngineFast("chirp", { sr, out: full }, 30_000);
    }
    return parseWavF32(await readFile(full)).samples;
  }

  /**
   * The INJECTION seam the calibration wizard leans on when there is no
   * microphone: a capture that sounds exactly like a mic hearing the chirp
   * `offsetMs` late — attenuated, with noise. The wizard does not care where
   * samples came from; this is where honest headless testing comes from.
   */
  async function syntheticCapture(sr, offsetMs, gain = 0.3, noise = 0.02) {
    const chirp = await chirpSamples(sr);
    const delay = Math.round(offsetMs / 1000 * sr);
    const cap = new Float32Array(delay + chirp.length + Math.round(sr / 2));
    for (let i = 0; i < chirp.length; i++) cap[delay + i] = chirp[i] * gain;
    for (let i = 0; i < cap.length; i++) cap[i] += (Math.random() - 0.5) * 2 * noise;
    return cap;
  }

  const f32bytes = (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);

  /** Encode raw float32 samples into the project's audio dir under a minted
   * write-once name. Returns capture.py's encode reply (out names the truth —
   * .flac, or .wav when PyAV is missing). */
  async function encodeAsset(slug, baseName, sr, f32) {
    await mkdir(audioDir(slug), { recursive: true });
    const rawTmp = path.join(audioDir(slug), `.raw_${baseName}_${Date.now().toString(36)}.f32`);
    await writeFile(rawTmp, f32bytes(f32));
    try {
      return await runCapture("encode", {
        sr, raw: rawTmp, out: path.join(audioDir(slug), `${baseName}.flac`),
      }, 300_000);
    } finally {
      unlink(rawTmp).catch(() => {});
    }
  }

  /** Decode one project audio asset (take/import/comp) to Float32Array at
   * the project rate. */
  async function decodeAsset(slug, file, sr) {
    const src = path.join(audioDir(slug), path.basename(file));
    const rawTmp = src + `.dec_${Date.now().toString(36)}.f32`;
    try {
      await runCapture("decode", { path: src, sr, out: rawTmp }, 300_000);
      const buf = await readFile(rawTmp);
      return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    } finally {
      unlink(rawTmp).catch(() => {});
    }
  }

  const takeUrl = (slug, file) =>
    `/api/daw/take/${encodeURIComponent(slug)}/${encodeURIComponent(file)}`;

  /**
   * The import pipeline both hands share: decode ANY audio file to the
   * project rate, re-encode as a write-once FLAC asset, land it as an audio
   * clip at the named position. `srcPath` is a server-local file (the MCP
   * path) or an uploaded temp file (the browser path).
   */
  async function importAsset(req, slug, b, srcPath, sourceName) {
    const doc = await readProject(slug);
    if (!doc) throw new Error("No such project.");
    const track = findTrack(doc, b.track);
    const at = normPos(doc, { bar: b.bar ?? 1, beat: b.beat ?? 1, tick: b.tick ?? 0 }, "import position");
    const impId = newId("imp", 6);
    await mkdir(audioDir(slug), { recursive: true });
    const dec = await runCapture("decode", {
      path: srcPath, sr: doc.sr,
      out: path.join(audioDir(slug), `.raw_${impId}.f32`),
    }, 300_000);
    let enc;
    try {
      enc = await runCapture("encode", {
        sr: doc.sr, raw: dec.out, out: path.join(audioDir(slug), `${impId}.flac`),
      }, 300_000);
    } finally {
      unlink(dec.out).catch(() => {});
    }
    const gainDb = b.gain_db === undefined ? 0
      : inRange(b.gain_db, LIMITS.gainDb[0], LIMITS.gainDb[1], "gain_db");
    let clipOut = null;
    const m = await mutate(slug, b, "import_audio", (d) => {
      const t = findTrack(d, track.id);
      if ((t.audioClips || []).length >= LIMITS.audioClipsPerTrack) {
        throw new Error(`Track ${t.id} already has ${LIMITS.audioClipsPerTrack} audio clips.`);
      }
      const clip = blankAudioClip(path.basename(enc.out), {
        name: b.name || sourceName || "import",
        bar: at.bar, beat: at.beat, tick: at.tick,
        durSamples: enc.n_samples, gainDb, by: byOf(b),
      });
      t.audioClips.push(clip);
      clipOut = clip;
      return { clip, ledger: { detail: `${clip.name} at ${at.bar}.${at.beat}.${at.tick} (${enc.seconds}s)` } };
    });
    /* Actor honesty: an import is an import whoever drives it — the origin
     * is third-party/existing unless the human declares otherwise. */
    provNote({ dir: projectDir(slug) }, {
      actor: actorOf(req), type: "import", asset: `audio/${path.basename(enc.out)}`,
      data: {
        kind: "audio", source: sourceName || path.basename(srcPath),
        declared: b.declared === "human-recorded" ? "human-recorded" : undefined,
        origin: b.declared === "human-recorded" ? "human-recorded" : "third-party/existing",
        seconds: enc.seconds, sr: doc.sr, clip: clipOut.id, track: track.id,
      },
    });
    return {
      ...m,
      extra: {
        ...m.extra,
        clip: clipOut, url: takeUrl(slug, path.basename(enc.out)),
        seconds: enc.seconds, format: enc.format,
      },
    };
  }

  /* ──────────────────────────────────────────────────────────── routes */

  async function handle(req, res, url) {
    const p = url.pathname;

    /* ---- reads ---- */

    /* The patch registry — what exists, what is installed, and every
     * licence in full BEFORE anything is downloaded. This is the endpoint
     * the patch picker binds to (the UI agent wires it later). */
    if (p === "/api/daw/patches" && req.method === "GET") {
      const patches = await listPatches();
      json(res, 200, {
        ok: true,
        instrumentsDir: instrumentsDir(),
        patches,
        packs: Object.entries(PATCH_MANIFEST.packs).map(([id, pk]) => ({
          id, label: pk.label, bytes: pk.bytes ?? null,
          licence: pk.licence, attribution: pk.attribution,
          attribution_required: !!pk.attribution_required,
          source: pk.source, downloading: packState(id),
        })),
      });
      return true;
    }

    if (p === "/api/daw/projects" && req.method === "GET") {
      json(res, 200, { projects: await listProjects() });
      return true;
    }

    /* CHAIN STAGE: the rack catalog — the engine's authoritative table
     * (labels, whys, units) beside the store's validation mirror, with the
     * disagreements named. The TAILS pattern: two tables, one truth, an
     * endpoint that says whether they still agree. */
    if (p === "/api/daw/rack" && req.method === "GET") {
      let engineCatalog = null, problems = null;
      try {
        engineCatalog = await runEngineFast("rack", {}, 30_000);
        problems = catalogsAgree(engineCatalog.devices);
      } catch (err) {
        engineCatalog = { error: String(err.message || err) };
      }
      json(res, 200, {
        ok: true,
        catalog: engineCatalog,
        store: MIXER_CATALOG,
        tables_agree: problems ? problems.length === 0 : null,
        ...(problems && problems.length ? { problems } : {}),
      });
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

    /* ── [DAWREC] the capture surface's own reads and raw-body posts ──── */

    /* A take / import / comp asset. Write-once files under minted names, so
     * they are as immutable as the region renders. */
    if (p.startsWith("/api/daw/take/") && req.method === "GET") {
      const rest = p.slice("/api/daw/take/".length).split("/");
      const slug = safe(decodeURIComponent(rest[0] ?? ""));
      const name = safe(decodeURIComponent(rest[1] ?? ""));
      if (!slug || !name || !/^(tk|imp|cmp)_[a-z0-9]+\.(flac|wav)$/.test(name)) {
        json(res, 400, { error: "bad take path" }); return true;
      }
      const full = path.join(audioDir(slug), name);
      try {
        const st = await stat(full);
        res.writeHead(200, {
          "Content-Type": name.endsWith(".flac") ? "audio/flac" : "audio/wav",
          "Content-Length": st.size,
          "Cache-Control": "max-age=31536000, immutable",
        });
        createReadStream(full).pipe(res);
      } catch {
        json(res, 404, { error: "No such take file — it may have been deleted with its take." });
      }
      return true;
    }

    /* The click bed: count-in (meter of the starting bar — 7/8 counts in 7)
     * plus the real timeline, every blip an absolute sample derived from the
     * SERVER's maps. Content-addressed cache; the count-in length rides in
     * headers so a client needs no second clock. */
    if (p.startsWith("/api/daw/click/") && req.method === "GET") {
      const slug = safe(decodeURIComponent(p.slice("/api/daw/click/".length)).replace(/\.wav$/, ""));
      const doc = slug && await readProject(slug);
      if (!doc) { json(res, 404, { error: "No such project." }); return true; }
      try {
        const fromBar = clampInt(Number(url.searchParams.get("from_bar")) || 1, 1, doc.lengthBars);
        const barsQ = Number(url.searchParams.get("bars"));
        const countin = clampInt(Number(url.searchParams.get("countin")) || 0, 0, 4);
        const ce = clickEvents(doc, fromBar, Number.isFinite(barsQ) && barsQ > 0 ? barsQ : undefined,
          countin, doc.sr);
        const key = createHashShort(JSON.stringify([doc.meterMap, doc.tempoMap, fromBar, countin, ce.nSamples]));
        const dir = cacheDir(slug);
        await mkdir(dir, { recursive: true });
        const full = path.join(dir, `click_${key}.wav`);
        let have = false;
        try { have = (await stat(full)).size > 44; } catch { /* render below */ }
        if (!have) {
          const tmp = full + `.tmp-${process.pid}`;
          await runEngineFast("click", { sr: doc.sr, n_samples: ce.nSamples, events: ce.events, out: tmp }, 60_000);
          await rename(tmp, full);
        }
        const st = await stat(full);
        res.writeHead(200, {
          "Content-Type": "audio/wav", "Content-Length": st.size,
          "Cache-Control": "max-age=31536000, immutable",
          "X-Countin-Seconds": String(ce.countinSeconds),
          "X-Countin-Samples": String(ce.countinSamples),
        });
        createReadStream(full).pipe(res);
      } catch (err) {
        json(res, 400, { error: String(err.message || err) });
      }
      return true;
    }

    /* The synthetic-capture injection: what a microphone WOULD have handed
     * back, offset_ms late. The calibration wizard falls back to this when
     * getUserMedia refuses (headless panes), and the e2e drives the whole
     * wizard flow through it — the estimator cannot tell the difference,
     * which is the point. */
    if (p === "/api/daw/testcap.f32" && req.method === "GET") {
      try {
        const sr = clampInt(Number(url.searchParams.get("sr")) || 48000, 8000, 192000);
        const offsetMs = clamp(Number(url.searchParams.get("offset_ms")) || 87.3, 0, 2000);
        const cap = await syntheticCapture(sr, offsetMs);
        const buf = f32bytes(cap);
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": buf.length,
          "X-Injected-Offset-Ms": String(offsetMs),
        });
        res.end(buf);
      } catch (err) {
        json(res, 400, { error: String(err.message || err) });
      }
      return true;
    }

    /* A rendered single-note preview (the MIDI audition path). */
    if (p.startsWith("/api/daw/preview/") && req.method === "GET") {
      const name = safe(decodeURIComponent(p.slice("/api/daw/preview/".length)));
      if (!name || !/^pv_[a-z0-9_.-]+\.wav$/.test(name)) {
        json(res, 400, { error: "bad preview path" }); return true;
      }
      const full = path.join(DAW_DIR(), "_previews", name);
      try {
        const st = await stat(full);
        res.writeHead(200, {
          "Content-Type": "audio/wav", "Content-Length": st.size,
          "Cache-Control": "max-age=31536000, immutable",
        });
        createReadStream(full).pipe(res);
      } catch {
        json(res, 404, { error: "No such preview — POST action preview_note first." });
      }
      return true;
    }

    /* One numbered chunk of an in-flight recording: raw little-endian
     * float32 PCM, assembled STRICTLY by seq at stop — sample-exact across
     * chunk boundaries because it is bytes end-to-end. */
    if (p === "/api/daw/record/chunk" && req.method === "POST") {
      try {
        const s = getSession(url.searchParams.get("rec"));
        const buf = await readRaw(req);
        const r = addChunk(s, url.searchParams.get("seq"), buf);
        json(res, 200, { ok: true, ...r });
      } catch (err) {
        json(res, 400, { error: String(err.message || err) });
      }
      return true;
    }

    /* The browser's file-drop import: the file's bytes in the body, the
     * placement in the query. Same pipeline as daw_import_audio. */
    if (p.startsWith("/api/daw/upload/") && req.method === "POST") {
      const slug = safe(decodeURIComponent(p.slice("/api/daw/upload/".length)));
      try {
        if (!slug || !(await readProject(slug))) throw new Error("No such project.");
        const q = url.searchParams;
        const origName = safe(q.get("name")) || "upload.bin";
        const buf = await readRaw(req, 256 * 1024 * 1024);
        if (!buf.length) throw new Error("the uploaded file is empty.");
        await mkdir(audioDir(slug), { recursive: true });
        const tmp = path.join(audioDir(slug), `.up_${Date.now().toString(36)}_${origName}`);
        await writeFile(tmp, buf);
        try {
          const m = await importAsset(req, slug, {
            track: q.get("track"),
            bar: Number(q.get("bar")) || 1,
            beat: Number(q.get("beat")) || 1,
            tick: Number(q.get("tick")) || 0,
            name: q.get("clip_name") || origName.replace(/\.[a-z0-9]+$/i, ""),
            gain_db: q.get("gain_db") ?? undefined,
            by: "user",
          }, tmp, origName);
          mutReply(res, m);
        } finally {
          unlink(tmp).catch(() => {});
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
      /* ── CHAIN STAGE: the mixer's actions (insert_*, mixer_set, send_*,
       * return_*, meters) live in mixer.js and share this catch, this
       * `mutate` and this ledger — one document, one reducer path. */
      const mixerReply = await handleMixerAction(action, b, {
        mutate, readProject, runEngineFast, safe, noteEvents, buildTimeline,
      });
      if (mixerReply) return json(res, 200, mixerReply), true;

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
          await assertAssignablePatch(inst);
          const m = await mutate(slug, b, "add_track", (d) => {
            if (d.tracks.length >= LIMITS.tracks) throw new Error(`This project already has ${LIMITS.tracks} tracks.`);
            const track = blankTrack(b.name, { patch: inst, params: b.params });
            /* A track without a clip cannot hold a note, and "add_clip first"
             * is a speed bump both hands would hit every time — so a track
             * arrives with one clip spanning the project unless told not to. */
            if (b.with_clip !== false) track.clips.push(blankClip(1, d.lengthBars));
            d.tracks.push(track);
            return { trackId: track.id, clipId: track.clips[0]?.id ?? null,
                     track: { id: track.id, name: track.name, instrument: track.instrument },
                     ledger: { detail: `${track.name} (${inst})` } };
          });
          return mutReply(res, m), true;
        }

        case "set_track": {
          const slug = safe(b.slug);
          if (b.instrument !== undefined) await assertAssignablePatch(String(b.instrument));
          const m = await mutate(slug, b, "set_track", (d) => {
            const t = findTrack(d, b.track);
            if (b.name !== undefined) t.name = String(b.name).slice(0, 80);
            if (b.instrument !== undefined) {
              t.instrument = { patch: String(b.instrument),
                               params: normParams(b.params ?? t.instrument.params, String(b.instrument)) };
            } else if (b.params !== undefined) {
              t.instrument.params = normParams(b.params, t.instrument.patch);
            }
            if (b.gain_db !== undefined) t.gainDb = inRange(b.gain_db, LIMITS.gainDb[0], LIMITS.gainDb[1], "gain_db");
            if (b.mute !== undefined) t.mute = !!b.mute;
            /* A hand-picked track colour. Null clears it back to the
             * position-derived default, so the override is undoable. */
            if (b.colour !== undefined) {
              if (b.colour === null) delete t.colour;
              else t.colour = clampInt(b.colour, 0, 15);
            }
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

        /**
         * MOVE / RESIZE / RENAME a MIDI clip — the write-once gap closed
         * (agent/dawparity). `add_clip` set fromBar/toBar and nothing could
         * ever change them, so the only way to move a clip was to drag every
         * note inside it.
         *
         * THE SEMANTICS, decided once and pinned in store_test.js:
         *
         *   from_bar MOVES the clip and THE NOTES RIDE ALONG — what dragging
         *     a clip's body does in every DAW.
         *   With no to_bar/bars, a move KEEPS THE CLIP'S LENGTH: it
         *     translates, it does not resize. (Truncated at the project's
         *     last bar rather than refused — a clip dragged off the end is a
         *     clip at the end, and the notes it no longer covers say so in
         *     notesOutside.)
         *   move_notes: false turns the same call into a TRIM: the left edge
         *     moves, the notes stay. to_bar/bars NEVER move notes.
         *   Shrinking is NON-DESTRUCTIVE: notes outside the new bounds are
         *     kept and go silent (store.js's container rule), and widening
         *     brings them back. Nothing is deleted by a resize, ever.
         *
         * Dirtying falls out of the hash diff for free and is right in both
         * directions: the notes leave the vacated region's hash and enter the
         * new one's, so `dirty` names BOTH — which is the difference between
         * a correct move and a cache that serves the old bar's audio.
         */
        case "set_clip": {
          const slug = safe(b.slug);
          if (b.from_bar === undefined && b.to_bar === undefined
              && b.bars === undefined && b.name === undefined) {
            throw new Error("set_clip needs at least one of from_bar, to_bar, bars or name. "
              + "from_bar moves the clip (its notes ride along; pass move_notes: false to trim "
              + "the left edge instead), to_bar or bars resizes it.");
          }
          const m = await mutate(slug, b, "set_clip", (d) => {
            const t = findTrack(d, b.track);
            const c = findClip(t, b.clip);
            const oldFrom = c.fromBar, oldTo = c.toBar;
            const moveNotes = b.move_notes !== false;
            let from = oldFrom, to = oldTo;
            if (b.from_bar !== undefined) {
              from = clampInt(inRange(b.from_bar, 1, d.lengthBars, "from_bar"), 1, d.lengthBars);
            }
            if (b.to_bar !== undefined) {
              to = clampInt(inRange(b.to_bar, from, d.lengthBars, "to_bar"), from, d.lengthBars);
            } else if (b.bars !== undefined) {
              const bars = clampInt(inRange(b.bars, 1, d.lengthBars, "bars"), 1, d.lengthBars);
              to = Math.min(from + bars - 1, d.lengthBars);
            } else if (moveNotes && b.from_bar !== undefined) {
              to = Math.min(from + (oldTo - oldFrom), d.lengthBars);   // a move keeps its length
            }
            if (to < from) to = from;
            c.fromBar = from;
            c.toBar = to;
            if (b.name !== undefined) c.name = String(b.name).slice(0, 80);
            const delta = from - oldFrom;
            const shifted = moveNotes ? shiftClipNotes(d, c, delta) : { moved: 0, clamped: 0 };
            const outside = notesOutsideClip(c);
            return {
              clip: { id: c.id, name: c.name, fromBar: c.fromBar, toBar: c.toBar,
                      notes: c.notes.length },
              movedBars: delta, notesMoved: shifted.moved, notesClamped: shifted.clamped,
              notesOutside: outside,
              ledger: { detail: `${c.id}: bars ${oldFrom}-${oldTo} → ${from}-${to}`
                + (shifted.moved ? `, ${shifted.moved} note(s) moved` : "")
                + (outside ? `, ${outside} note(s) now silent` : "") },
            };
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
          /* CREDITS BEFORE BYTES: the attribution is attached for every
           * licensed patch the project holds, whether or not this render
           * turns out to be all cache hits — a credited work is credited
           * because it USES the patch, not because a region was cold. */
          const attached = await attachLicences(slug, doc,
            b.by === "agent" ? "agent:daw" : "user");
          const regions = await ensureRegions(slug, doc, fromBar, toBar);
          return json(res, 200, {
            ok: true,
            updatedAt: doc.updatedAt,
            sr: doc.sr,
            totalSeconds: projectSeconds(doc),
            regionBars: REGION_BARS,
            regions,
            /* Tracks this machine cannot voice rendered SILENT rather than
             * taking the whole song down with them. Each row names the packs
             * that would bring it back; installing one changes the region
             * hash by itself, so the sound returns with no cache to clear. */
            ...(regions.missingPacks?.length ? { missingPacks: regions.missingPacks } : {}),
            rendered: regions.filter((r) => r.rendered).length,
            cachedHits: regions.filter((r) => r.cached).length,
            licencesAttached: attached,
            credits: await creditsOf(slug),
            ms: Date.now() - t0,
          }), true;
        }

        /* ── [DAWREC] recording: arm, roll, chunks, takes ─────────────── */

        case "record_arm": {
          const slug = safe(b.slug);
          const armed = b.armed !== false;
          const m = await mutate(slug, b, "record_arm", (d) => {
            const t = findTrack(d, b.track);
            t.armed = armed;
            return { trackId: t.id, armed, ledger: { detail: `${t.name}: ${armed ? "armed" : "disarmed"}` } };
          });
          return mutReply(res, m), true;
        }

        case "record_start": {
          const slug = safe(b.slug);
          const doc = slug && await readProject(slug);
          if (!doc) throw new Error("No such project.");
          const t = findTrack(doc, b.track);
          if (!t.armed) throw new Error(`Track ${t.id} (${t.name}) is not armed — record_arm it first.`);
          const at = normPos(doc, { bar: b.bar ?? 1, beat: b.beat ?? 1, tick: b.tick ?? 0 }, "record start");
          const sr = b.sr === undefined ? doc.sr : clampInt(inRange(b.sr, 8000, 192000, "sr"), 8000, 192000);
          if (sr !== doc.sr) {
            throw new Error(`the capture must arrive at the project rate (${doc.sr} Hz) — got ${sr}. `
              + "The browser's AudioContext({sampleRate}) resamples for you; MCP callers should supply "
              + `${doc.sr} Hz samples.`);
          }
          const countinBars = clampInt(Number(b.countin_bars ?? 1), 0, 4);
          const ce = clickEvents(doc, at.bar, undefined, countinBars, sr);
          const punchIn = b.punch_in
            ? Math.round(posSeconds(doc, normPos(doc, b.punch_in, "punch_in")) * sr) : null;
          const punchOut = b.punch_out
            ? Math.round(posSeconds(doc, normPos(doc, b.punch_out, "punch_out")) * sr) : null;
          if (punchIn !== null && punchOut !== null && punchOut <= punchIn) {
            throw new Error("punch_out must be after punch_in.");
          }
          const offsetMs = offsetFor(await readLatency(config), b.device);
          const s = beginSession({
            slug, trackId: t.id, sr, at,
            startSample: Math.round(posSeconds(doc, at) * sr),
            shiftSamples: latencyShift(offsetMs, sr),
            punchIn, punchOut, countinBars, countinSeconds: ce.countinSeconds,
            device: b.device, by: byOf(b),
          });
          return json(res, 200, {
            ok: true, rec_id: s.id, track: t.id, sr,
            at: s.at, start_sample: s.startSample, shift_samples: s.shiftSamples,
            offset_ms: offsetMs,
            countin_bars: countinBars, countin_seconds: ce.countinSeconds,
            countin_samples: ce.countinSamples,
            punch_in: punchIn, punch_out: punchOut,
            click_url: `/api/daw/click/${encodeURIComponent(slug)}.wav?from_bar=${at.bar}&countin=${countinBars}`,
            note: "POST float32 chunks to /api/daw/record/chunk?rec=<rec_id>&seq=<n> "
              + "(or action record_chunk_b64), then action record_stop.",
          }), true;
        }

        case "record_chunk_b64": {
          const s = getSession(b.rec_id);
          if (b.samples_b64 === undefined) throw new Error("record_chunk_b64 needs samples_b64 (little-endian float32 PCM, base64).");
          const buf = Buffer.from(String(b.samples_b64), "base64");
          const r = addChunk(s, b.seq, buf);
          return json(res, 200, { ok: true, ...r }), true;
        }

        case "record_stop": {
          const slug = safe(b.slug);
          const s = getSession(b.rec_id);
          if (s.slug !== slug) throw new Error(`session ${s.id} belongs to project ${s.slug}, not ${slug}.`);
          if (b.cancel) {
            endSession(s.id);
            return json(res, 200, { ok: true, canceled: true, rec_id: s.id }), true;
          }
          const f32 = assembleSession(s);
          const place = takePlacement(s);
          const trimmed = punchTrim(f32, place.startSample, s.punchIn, s.punchOut);
          const takeId = newId("tk", 6);
          const enc = await encodeAsset(slug, takeId, s.sr, trimmed.samples);
          let takeOut = null;
          const m = await mutate(slug, b, "record_stop", (d) => {
            const t = findTrack(d, s.trackId);
            if ((t.takes || []).length >= LIMITS.takesPerTrack) {
              throw new Error(`Track ${t.id} already holds ${LIMITS.takesPerTrack} takes — delete or comp some.`);
            }
            const take = blankTake(path.basename(enc.out), {
              id: takeId,
              name: b.name || `take ${t.takes.length + 1}`,
              bar: s.at.bar, beat: s.at.beat, tick: s.at.tick,
              shiftSamples: s.shiftSamples + trimmed.extraShift,
              samples: enc.n_samples, sr: s.sr, device: s.device, by: s.by,
            });
            t.takes.push(take);
            takeOut = take;
            return { take, ledger: { detail: `${take.name} (${enc.seconds}s, shift ${take.shiftSamples})` } };
          });
          endSession(s.id);
          /* Actor honesty (capture.js captureEvent): a browser capture logs
           * `record` — human-recorded, the strongest human-origin class; the
           * same route driven by an agent logs `import`. */
          provNote({ dir: projectDir(slug) }, {
            actor: actorOf(req),
            asset: `audio/${takeOut.file}`,
            ...captureEvent(actorOf(req), "audio", {
              device: s.device || undefined, sr: s.sr,
              samples: enc.n_samples, seconds: enc.seconds,
              offset_ms_applied: -s.shiftSamples / s.sr * 1000,
              take: takeOut.id, track: s.trackId,
            }),
          });
          return json(res, 200, {
            ok: true, updatedAt: m.doc.updatedAt, dirty: m.dirty,
            take: takeOut, url: takeUrl(slug, takeOut.file),
            start_sample: trimmed.startSample, seconds: enc.seconds, format: enc.format,
          }), true;
        }

        case "record_status": {
          const slug = safe(b.slug);
          const doc = slug && await readProject(slug);
          if (!doc) throw new Error("No such project.");
          const latency = await readLatency(config);
          let provenance;
          if (prov) {
            try {
              provenance = (await prov.read({ dir: projectDir(slug) }, { limit: 10 })).events
                .map((e) => ({ t: e.t, actor: e.actor, type: e.type, asset: e.asset, data: e.data }));
            } catch { provenance = []; }
          }
          return json(res, 200, {
            ok: true,
            armed: doc.tracks.filter((t) => t.armed).map((t) => t.id),
            sessions: listSessions(slug),
            takes: doc.tracks.map((t) => ({ track: t.id, takes: (t.takes || []).length })),
            latency,
            ...(provenance ? { provenance } : {}),
          }), true;
        }

        case "take_delete": {
          const slug = safe(b.slug);
          let file = null;
          const m = await mutate(slug, b, "take_delete", (d) => {
            const t = findTrack(d, b.track);
            const take = findTake(t, b.take);
            t.takes = t.takes.filter((x) => x.id !== take.id);
            file = take.file;
            return { removed: take.id, ledger: { detail: take.name } };
          });
          if (file) unlink(path.join(audioDir(slug), path.basename(file))).catch(() => {});
          return mutReply(res, m), true;
        }

        /* ── [DAWREC] comping: ordered picks flatten to one clip ───────── */

        case "take_comp": {
          const slug = safe(b.slug);
          const doc = slug && await readProject(slug);
          if (!doc) throw new Error("No such project.");
          const t = findTrack(doc, b.track);
          let picks = b.picks;
          if (!Array.isArray(picks) || !picks.length) {
            if (!b.whole_take) throw new Error("take_comp needs picks: [{take, from_sample, to_sample}] (absolute project samples, later picks win), or whole_take: <take id>.");
            const take = findTake(t, b.whole_take);
            const start = audioStartSample(doc, take);
            picks = [{ take: take.id, from_sample: start, to_sample: start + take.samples }];
          }
          picks = picks.map((pk, i) => {
            if (!pk || pk.take === undefined) throw new Error(`pick ${i} must name a take.`);
            return { take: String(pk.take), fromSample: Number(pk.from_sample), toSample: Number(pk.to_sample) };
          });
          const takeMap = new Map();
          for (const pk of picks) {
            if (takeMap.has(pk.take)) continue;
            const take = findTake(t, pk.take);
            const samples = await decodeAsset(slug, take.file, doc.sr);
            takeMap.set(take.id, { start: audioStartSample(doc, take), samples });
          }
          const flat = flattenComp(picks, takeMap);
          const cmpId = newId("cmp", 6);
          const enc = await encodeAsset(slug, cmpId, doc.sr, flat.samples);
          let clipOut = null;
          const m = await mutate(slug, b, "take_comp", (d) => {
            const tt = findTrack(d, t.id);
            if ((tt.audioClips || []).length >= LIMITS.audioClipsPerTrack) {
              throw new Error(`Track ${tt.id} already has ${LIMITS.audioClipsPerTrack} audio clips.`);
            }
            /* Anchored at 1.1.0 with the absolute start in the shift: a comp
             * is a sample-accurate assembly, not a musical object — moving it
             * is set_audio_clip's job. */
            const clip = blankAudioClip(path.basename(enc.out), {
              name: b.name || `comp of ${takeMap.size} take(s)`,
              bar: 1, beat: 1, tick: 0,
              shiftSamples: flat.startSample,
              durSamples: flat.samples.length,
              by: byOf(b),
            });
            tt.audioClips.push(clip);
            clipOut = clip;
            return { clip, ledger: { detail: `${clip.name}: ${picks.length} pick(s), ${enc.seconds}s` } };
          });
          provNote({ dir: projectDir(slug) }, {
            actor: actorOf(req), type: "pick_take", asset: `audio/${clipOut.file}`,
            data: {
              picks: picks.length,
              takes: [...takeMap.keys()],
              from: picks.map((pk) => `${pk.take}[${pk.fromSample},${pk.toSample})`),
              samples: flat.samples.length,
            },
          });
          return json(res, 200, {
            ok: true, updatedAt: m.doc.updatedAt, dirty: m.dirty,
            clip: clipOut, url: takeUrl(slug, clipOut.file),
            start_sample: flat.startSample, seconds: enc.seconds,
          }), true;
        }

        /* ── [DAWREC] audio clips: import (the no-mic path), move, remove ── */

        case "import_audio": {
          const slug = safe(b.slug);
          const src = String(b.path || "");
          if (!src) throw new Error("import_audio needs path: a server-local audio file (wav/flac/mp3/m4a/ogg — anything ffmpeg reads).");
          try { await stat(src); } catch { throw new Error(`No such file: ${src}`); }
          const m = await importAsset(req, slug, b, src, path.basename(src));
          return mutReply(res, m), true;
        }

        case "set_audio_clip": {
          const slug = safe(b.slug);
          const m = await mutate(slug, b, "set_audio_clip", (d) => {
            const t = findTrack(d, b.track);
            const c = findAudioClip(t, b.clip);
            if (b.name !== undefined) c.name = String(b.name).slice(0, 80);
            if (b.gain_db !== undefined) c.gainDb = inRange(b.gain_db, LIMITS.gainDb[0], LIMITS.gainDb[1], "gain_db");
            if (b.bar !== undefined || b.beat !== undefined || b.tick !== undefined) {
              const pos = normPos(d, { bar: b.bar ?? c.bar, beat: b.beat ?? c.beat, tick: b.tick ?? c.tick }, "clip position");
              Object.assign(c, pos);
            }
            if (b.shift_samples !== undefined) {
              c.shiftSamples = clampInt(inRange(b.shift_samples, LIMITS.shiftSamples[0], LIMITS.shiftSamples[1], "shift_samples"),
                LIMITS.shiftSamples[0], LIMITS.shiftSamples[1]);
            }
            if (b.offset_samples !== undefined) c.offsetSamples = Math.max(0, Math.round(inRange(b.offset_samples, 0, 1e10, "offset_samples")));
            if (b.dur_samples !== undefined) c.durSamples = Math.max(1, Math.round(inRange(b.dur_samples, 1, 1e10, "dur_samples")));
            return { clip: c };
          });
          return mutReply(res, m), true;
        }

        case "remove_audio_clip": {
          const slug = safe(b.slug);
          const m = await mutate(slug, b, "remove_audio_clip", (d) => {
            const t = findTrack(d, b.track);
            const c = findAudioClip(t, b.clip);
            t.audioClips = t.audioClips.filter((x) => x.id !== c.id);
            /* The file stays on disk: a comp's source may be auditioned again
             * and project deletion sweeps the whole folder anyway. */
            return { removed: c.id, ledger: { detail: c.name } };
          });
          return mutReply(res, m), true;
        }

        /* ── [DAWREC] MIDI capture: performed notes into the P0 note model ── */

        case "record_notes": {
          const slug = safe(b.slug);
          if (!Array.isArray(b.notes) || !b.notes.length) {
            throw new Error("record_notes needs notes: [{bar, beat, tick, dur_ticks, pitch, vel}].");
          }
          if (b.notes.length > 2000) throw new Error("record_notes caps at 2000 notes per call.");
          const quant = b.quantize_ticks === undefined ? 0
            : clampInt(inRange(b.quantize_ticks, 0, TICKS_PER_BEAT, "quantize_ticks"), 0, TICKS_PER_BEAT);
          const added = [];
          const m = await mutate(slug, b, "record_notes", (d) => {
            const t = findTrack(d, b.track);
            const rows = buildTimeline(d);
            for (const [i, rn] of b.notes.entries()) {
              let pos = normPos(d, { bar: rn.bar, beat: rn.beat ?? 1, tick: rn.tick ?? 0 }, `note ${i}`);
              if (quant > 0) {
                const q = quantizePos(pos.beat, pos.tick, quant, rows[pos.bar - 1].num);
                pos = { bar: pos.bar, ...q };
              }
              const c = clipCovering(t, pos.bar);
              if (c.notes.length >= LIMITS.notesPerClip) throw new Error(`Clip ${c.id} already holds ${LIMITS.notesPerClip} notes.`);
              const note = {
                id: newId("nt", 6),
                ...pos,
                durTicks: clampInt(rn.dur_ticks === undefined ? TICKS_PER_BEAT
                  : inRange(rn.dur_ticks, LIMITS.durTicks[0], LIMITS.durTicks[1], `note ${i} dur_ticks`),
                  LIMITS.durTicks[0], LIMITS.durTicks[1]),
                pitch: clampInt(inRange(rn.pitch, LIMITS.pitch[0], LIMITS.pitch[1], `note ${i} pitch`), 0, 127),
                vel: clampInt(rn.vel === undefined ? 100 : inRange(rn.vel, LIMITS.vel[0], LIMITS.vel[1], `note ${i} vel`), 1, 127),
                by: byOf(b),
              };
              c.notes.push(note);
              added.push(note);
            }
            return { added, quantized: quant, trackId: t.id,
                     ledger: { detail: `${added.length} performed note(s)${quant ? `, quantized to ${quant} ticks` : ""}` } };
          });
          /* A human MIDI performance is a recording of a performance; an
           * agent posting the same shape is authoring, not performing. */
          provNote({ dir: projectDir(slug) }, {
            actor: actorOf(req),
            asset: `midi/${m.extra.trackId}`,
            ...captureEvent(actorOf(req), "midi", { notes: added.length, quantize_ticks: quant }),
          });
          return mutReply(res, m), true;
        }

        /* ── [DAWREC] calibration: estimate, store, read ────────────────── */

        case "calibrate_b64": {
          const sr = b.sr === undefined ? 48000 : clampInt(inRange(b.sr, 8000, 192000, "sr"), 8000, 192000);
          let buf;
          if (b.samples_b64 !== undefined) {
            buf = Buffer.from(String(b.samples_b64), "base64");
          } else if (b.synthetic_offset_ms !== undefined) {
            const off = clamp(inRange(b.synthetic_offset_ms, 0, 2000, "synthetic_offset_ms"), 0, 2000);
            buf = f32bytes(await syntheticCapture(sr, off));
          } else {
            throw new Error("calibrate_b64 needs samples_b64 (float32 PCM of the mic hearing the chirp) or synthetic_offset_ms (the injection path).");
          }
          if (buf.length < sr * 0.1 * 4) throw new Error("capture too short — record at least the chirp plus headroom.");
          await mkdir(DAW_DIR(), { recursive: true });
          const capPath = path.join(DAW_DIR(), `.cap_${Date.now().toString(36)}.f32`);
          await writeFile(capPath, buf);
          try {
            const r = await runEngineFast("calibrate", { sr, capture: capPath }, 60_000);
            return json(res, 200, {
              ok: true, offset_ms: r.offset_ms, peak_ratio: r.peak_ratio, confident: r.confident,
            }), true;
          } finally {
            unlink(capPath).catch(() => {});
          }
        }

        case "set_latency": {
          if (b.offset_ms === undefined) {
            // a read: the stored table, nothing written
            return json(res, 200, { ok: true, latency: await readLatency(config) }), true;
          }
          const off = clamp(inRange(b.offset_ms, -500, 2000, "offset_ms"), -500, 2000);
          const table = await writeLatency(config, b.device, off);
          return json(res, 200, { ok: true, device: String(b.device || "default").slice(0, 120), offset_ms: off, latency: table }), true;
        }

        /* ── [DAWREC] the MIDI monitor: an honest audition render ───────── */

        case "preview_note": {
          const slug = safe(b.slug);
          const doc = slug && await readProject(slug);
          if (!doc) throw new Error("No such project.");
          const t = findTrack(doc, b.track);
          /* A track's instrument is { patch, params } — the palette's shape,
           * not P0's bare string. Reading it as a string here produced an
           * `inst: [object Object]` job and a `pv_[object Object]_…` name the
           * preview GET's own regex would refuse: an audition that could
           * never play. (agent/dawparity) */
          const patch = t.instrument.patch;
          const params = t.instrument.params || {};
          const pitch = clampInt(inRange(b.pitch, LIMITS.pitch[0], LIMITS.pitch[1], "pitch"), 0, 127);
          const vel = clampInt(b.vel === undefined ? 100 : inRange(b.vel, LIMITS.vel[0], LIMITS.vel[1], "vel"), 1, 127);
          const durTicks = clampInt(b.dur_ticks === undefined ? 480
            : inRange(b.dur_ticks, LIMITS.durTicks[0], LIMITS.durTicks[1], "dur_ticks"), 1, TICKS_PER_BEAT * 8);
          const row = buildTimeline(doc, 1)[0];
          const durSec = durTicks / TICKS_PER_BEAT * (4 / row.den) * 60 / row.bpm;
          const durSamples = Math.max(1, Math.round(durSec * doc.sr));
          const nSamples = durSamples + Math.round((TAILS[patch] ?? 1.5) * doc.sr);
          /* The params ride the cache key: a transposed track auditions
           * differently, so it must not answer with the untransposed file. */
          const name = `pv_${patch}_${pitch}_${vel}_${durTicks}`
            + `_${Math.round((t.gainDb || 0) * 10)}_${createHashShort(JSON.stringify(params))}.wav`;
          const dir = path.join(DAW_DIR(), "_previews");
          await mkdir(dir, { recursive: true });
          const full = path.join(dir, name);
          let have = false;
          try { have = (await stat(full)).size > 44; } catch { /* render below */ }
          if (!have) {
            const tmp = full + `.tmp-${process.pid}`;
            await runEngineFast("render", {
              sr: doc.sr, start_sample: 0, n_samples: nSamples,
              /* a sampled patch needs to be told where the samples are — the
               * same line every other render job carries. */
              instruments_dir: instrumentsDir(),
              notes: [{
                inst: patch, params, midi: pitch, vel,
                start_sample: 0, dur_samples: durSamples,
                gain_db: t.gainDb, seed: noteSeed(t.id, "preview", pitch, 0),
              }],
              out: tmp,
            }, 60_000);
            await rename(tmp, full);
          }
          return json(res, 200, {
            ok: true, url: `/api/daw/preview/${name}`,
            track: t.id, patch, params, pitch, vel, dur_ticks: durTicks,
            seconds: Number((nSamples / doc.sr).toFixed(3)),
            cached: have,
            note: "This is an AUDITION render (a round trip through the server), not low-latency monitoring — expect tens of milliseconds.",
          }), true;
        }

        /* ── the palette: install, uninstall, credits, bounce ────────── */

        /* Install everything a patch needs. The LICENCE IS SHOWN FIRST: a
         * call without accept_licence: true is refused WITH the full licence
         * rows it would have accepted, so no byte moves before a human (or
         * an agent quoting it to one) has read the terms. */
        case "install_patch": {
          const pid = String(b.patch || "");
          const row = PATCHES[pid];
          if (!row) throw new Error(`No such patch "${pid}". Patches: ${Object.keys(PATCHES).join(", ")}.`);
          if (row.kind === "generate") throw new Error(row.refusal);
          if (row.kind === "builtin") {
            return json(res, 200, { ok: true, patch: pid, installed: true,
              note: "A built-in synth — nothing to download; it works on a first run with no network." }), true;
          }
          const need = await packsNeededFor(pid);
          if (!need.length) {
            return json(res, 200, { ok: true, patch: pid, installed: true, note: "Already installed." }), true;
          }
          const gate = licenceGate(need);
          if (b.accept_licence !== true) {
            return json(res, 200, {
              ok: false, needsAccept: true, patch: pid, packs: need, licences: gate,
              bytes: gate.reduce((a, g) => a + (g.bytes || 0), 0),
              note: "Nothing has been downloaded. Read the licence(s) above, then repeat this "
                + "call with accept_licence: true. Attribution-required packs add a credit line "
                + "to every render and bounce that uses them.",
            }), true;
          }
          const installed = [];
          for (const packId of need) {
            await installPack(packId);
            installed.push(packId);
          }
          return json(res, 200, { ok: true, patch: pid, installed,
            licences: gate, ready: await patchInstalled(pid) }), true;
        }

        case "uninstall_pack": {
          const packId = String(b.pack || "");
          if (!PATCH_MANIFEST.packs[packId]) {
            throw new Error(`No such pack "${packId}". Packs: ${Object.keys(PATCH_MANIFEST.packs).join(", ")}.`);
          }
          const r = await uninstallPack(packId);
          return json(res, 200, { ok: true, ...r }), true;
        }

        /* The project's accumulated attributions — read straight out of the
         * provenance ledger's licence_attach events, not a second list that
         * could drift from it. */
        case "credits": {
          const slug = safe(b.slug);
          const doc = slug && await readProject(slug);
          if (!doc) throw new Error("No such project.");
          return json(res, 200, { ok: true, slug, credits: await creditsOf(slug) }), true;
        }

        /* Bounce: render every region, concatenate to one 24-bit FLAC, and
         * TAG it — Tier-1 marker plus the accumulated attribution lines. */
        case "bounce": {
          const slug = safe(b.slug);
          const doc = slug && await readProject(slug);
          if (!doc) throw new Error("No such project.");
          const t0 = Date.now();
          const attached = await attachLicences(slug, doc,
            b.by === "agent" ? "agent:daw" : "user");
          const regions = await ensureRegions(slug, doc, 1, doc.lengthBars);
          const parts = regions
            .sort((x, y) => x.idx - y.idx)
            .map((r) => path.join(cacheDir(slug), `reg${r.idx}_${r.hash}.wav`));
          await mkdir(path.join(projectDir(slug), "bounces"), { recursive: true });
          const name = `${slug}_${Date.now().toString(36)}.flac`;
          const out = path.join(projectDir(slug), "bounces", name);
          /* bit_depth reaches the one place in the repo that reduces it, and
           * that place dithers below 24 by default. Absent means 24-bit, the
           * behaviour every existing caller already gets: a deliverable is
           * asked for, never assumed. */
          const enc = await runInstruments("encode", {
            sr: doc.sr, wav_parts: parts, out,
            ...(b.bit_depth !== undefined ? { bit_depth: b.bit_depth } : {}),
          }, 300_000);
          const credits = await creditsOf(slug);
          const tagged = await tagBounce(out, doc, credits);
          return json(res, 200, {
            ok: true, slug, file: out, seconds: enc.seconds,
            licencesAttached: attached, credits,
            attribution: credits.map((c) => c.attribution).filter(Boolean),
            tagged, ms: Date.now() - t0,
          }), true;
        }

        /* ── the engine's own mouth, for the seam between the two tables */

        case "probe": {
          const r = await runEngineFast("probe", { instruments_dir: instrumentsDir() }, 30_000);
          /* The mirror check, now over the PATCH table too: store.js and
           * instruments.py read the same patches.json, so these two views
           * differing means one process is running against a stale file. */
          const storePatchTails = Object.fromEntries(
            PATCH_IDS.map((pid) => [pid, PATCHES[pid].tail]));
          /* Two mirrors, both live:
           *   storeTails      the BUILTIN subset, against engine.py's own
           *                   SYNTHS tail table (the P0 invariant, kept)
           *   storePatchTails the WHOLE palette, against instruments.py's
           *                   patch_tails (the palette invariant) */
          const storeTails = Object.fromEntries(
            INSTRUMENTS.map((pid) => [pid, PATCHES[pid].tail]));
          return json(res, 200, {
            ok: true, ...r,
            storeTails, storeInstruments: INSTRUMENTS,
            storePatchTails, storePatchIds: PATCH_IDS,
          }), true;
        }

        default:
          return json(res, 400, {
            error: `Unknown action "${action}". Actions: create, delete, set_length, `
              + "set_meter, remove_meter, set_tempo, remove_tempo, add_track, set_track, "
              + "remove_track, add_clip, set_clip, remove_clip, add_note, move_note, delete_note, "
              + "render, bounce, install_patch, uninstall_pack, credits, probe, "
              + "record_arm, record_start, record_chunk_b64, record_stop, "
              + "record_status, take_delete, take_comp, import_audio, set_audio_clip, "
              + "remove_audio_clip, record_notes, calibrate_b64, set_latency, preview_note, "
              + `${MIXER_ACTIONS.join(", ")}.`,
          }), true;
      }
    } catch (err) {
      return json(res, 400, { error: String(err.message || err) }), true;
    }
  }

  return handle;
}
