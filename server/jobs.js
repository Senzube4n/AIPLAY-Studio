/**
 * Job queue + progress translation.
 *
 * ComfyUI emits per-node `executing` events over its websocket, which is what lets
 * the UI show honest staged progress — "Composing 43%", "Arranging 9/15" — instead
 * of a spinner. At ~4.6 min for a 3-minute song a spinner reads as frozen, and that
 * misread would be most of the support load.
 *
 * Progress values arrive normalised 0-1 rather than as step counts, so the step
 * number for the sampling stage is derived.
 */
import { EventEmitter } from "node:events";
import { generateViaApi } from "./apiEngine.js";
import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { buildGraph, STAGE_OF_NODE, STAGE_LABEL, STAGE_WEIGHT } from "./workflow.js";
/* The engine door. A song is submitted through it like everything else, which
 * is what makes "watch your own websocket" — the thing this class does, and
 * does well — unable to land on a path that skips the ledger: the record is
 * written before the POST and the completion event is written by the door's own
 * watcher whether or not this socket ever sees the finish. */
import { engine } from "./engine/client.js";

const ORDER = ["loading", "composing", "arranging", "mixing", "saving"];

/* No websocket message and no engine-state change for this long means the job
 * is dead, not slow. Generous on purpose: the small VRAM tiers legitimately
 * crawl, and killing a render that would have finished is the worse failure. */
const STALL_MS = 10 * 60_000;

/** Where a prompt sits in ComfyUI's GET /queue reply. Entries are positional
 *  arrays with the prompt id at index 1 — a shape read off the wire, not a
 *  documented API, which is why a test pins it. */
function queuePhase(q, promptId) {
  const has = (l) => Array.isArray(l) && l.some((e) => e?.[1] === promptId);
  return has(q?.queue_running) ? "running" : has(q?.queue_pending) ? "pending" : "gone";
}

export class JobRunner extends EventEmitter {
  #waitTimer = null;
  #watchTimer = null;
  #lastActivity = 0;
  #lastSeen = null;

  constructor(comfy) {
    super();
    this.comfy = comfy;
    this.queue = [];
    this.current = null;
    this.history = [];
    this.clientId = randomUUID();
    this.ws = null;

    /* THE ENGINE CAN DIE UNDER A RUNNING JOB, and the queue could not see it.
     *
     * #pump() returns early while `current` is set, and readiness is only
     * checked BEFORE a job starts — so a crash mid-render left `current`
     * populated forever and nothing else ever ran. By hand that reads as one
     * song taking a very long time; unattended it ends the night silently at
     * whatever it had reached, which is the case this exists for.
     *
     * Failing the job is the honest response rather than trying to resume it:
     * the sampling state died with the process, the supervisor is already
     * restarting, and the next job gets a fresh engine. The song is lost; the
     * other four are not. */
    comfy.on?.("died", ({ code } = {}) => {
      const job = this.current;
      if (!job) return;
      job.state = "failed";
      job.error = `The engine stopped during this render (exit ${code ?? "?"}). `
        + "It is restarting; the rest of the queue will continue. See comfy.log.";
      job.finishedAt = Date.now();
      this.history.unshift(job);
      this.current = null;
      this.emit("update", this.snapshot());
      /* Not immediately: the supervisor backs off before respawning, and #pump
       * will wait for readiness on its own anyway. */
      queueMicrotask(() => { this.#pump().catch(() => {}); });
    });

    /* THE PORT MOVES AT EVERY ENGINE START, so a socket opened against the old
     * one is pointed at nothing (or, worse, at whatever took the number). Drop
     * it; #watchTick reconnects on its next tick, which is the same recovery
     * path a dropped socket already had. */
    engine.on("rebound", () => {
      try { this.ws?.close(); } catch { /* already gone */ }
      this.ws = null;
    });
  }

  /** ComfyUI's socket, OPEN. `1` rather than `WebSocket.OPEN` because the
   *  constructor now lives behind the engine client and this class no longer
   *  imports `ws` — the constant is fixed by the protocol, not by the library. */
  #isOpen() { return !!this.ws && this.ws.readyState === 1; }

  async connect() {
    if (this.#isOpen()) return;
    await new Promise((resolve, reject) => {
      const ws = engine.socket(this.clientId);
      ws.on("open", () => { this.ws = ws; resolve(); });
      ws.on("error", reject);
      ws.on("message", (raw, isBinary) => { if (!isBinary) this.#onMessage(raw.toString()); });
      ws.on("close", () => { this.ws = null; });
    });
  }

  enqueue(spec) {
    const job = {
      id: randomUUID().slice(0, 8),
      ...spec,
      state: "queued",
      stage: null,
      stageProgress: 0,
      overall: 0,
      queuedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      etaSeconds: this.#estimate(spec),
      file: null,
      error: null,
    };
    this.queue.push(job);
    this.emit("update", this.snapshot());
    queueMicrotask(() => { this.#pump().catch((err) => console.warn(`  [queue] pump failed: ${err.message}`)); });
    return job;
  }

  /** Cold estimate from the measured ~1.5x realtime ratio. The first-run warm-up
   *  should replace this with a figure measured on the user's own card. */
  #estimate(spec) {
    const target = Math.min(spec.maxDuration ?? 240, 300);
    const assumed = Math.min(target, 150); // songs rarely run to the ceiling
    const full = assumed * config.speed.realtimeRatio;
    if (spec.preview) return Math.round(full * 0.45);
    // A re-roll reuses the cached AR stage — roughly 60% of a full render.
    return Math.round(spec.reusesConditioning ? full * 0.6 : full);
  }

  async #pump() {
    if (this.current || this.queue.length === 0) return;
    // The engine can drop out mid-run — it restarts, or a driver hiccup kills it.
    // Returning here without arranging a retry stalls the queue permanently, which
    // nobody notices while clicking Create by hand but silently ends an overnight
    // batch at whatever song it had reached. Keep checking back instead.
    /* API mode does not need a local engine, so the readiness wait must be
     * skipped — otherwise switching to API on a machine with no ComfyUI leaves
     * the queue spinning forever on an engine that is never going to arrive. */
    if (!config.api?.enabled && !this.comfy.ready) {
      clearTimeout(this.#waitTimer);
      this.#waitTimer = setTimeout(() => this.#pump(), 4000);
      return;
    }
    const job = this.queue.shift();
    this.current = job;
    job.state = "running";
    job.startedAt = Date.now();
    job.stage = "loading";
    this.emit("update", this.snapshot());

    if (config.api?.enabled && job.requiresLocal) {
      job.state = "failed";
      job.error = "This audio-input continuation requires local Music3. Hosted API mode was enabled before it started; no API request was sent.";
      job.finishedAt = Date.now();
      this.history.unshift(job);
      this.current = null;
      this.emit("update", this.snapshot());
      queueMicrotask(() => { this.#pump().catch(() => {}); });
      return;
    }
    if (config.api?.enabled) return this.#runApi(job);

    try {
      await this.connect();
      if (job.cancelRequested) return;
      const graph = buildGraph({
        caption: job.caption,
        lyrics: job.lyrics,
        seed: job.seed,
        mixSeed: job.mixSeed,
        model: job.model,
        steps: job.steps,
        cfg: job.cfg,
        arCfg: job.arCfg,
        flowCfg: job.flowCfg,
        maxDuration: job.maxDuration,
        resumeFrom: job.resumeFrom,
        /* Start the flow from a real song's latent instead of from noise.
         *
         * This explicit list is why the feature was dead on arrival: buildGraph
         * accepted `audioRef`, nothing here passed it, and so every render
         * silently took the empty-latent branch. Adding a field to buildGraph is
         * never enough on its own. */
        audioRef: job.audioRef,
        audioRefDenoise: job.audioRefDenoise,
        preview: job.preview,
        prefix: job.preview ? "preview" : "aiplay",
      });
      /* THROUGH THE DOOR, not straight at the engine.
       *
       * `submit` (rather than `run`) because this class watches its own
       * websocket and must not block here — it returns as soon as the POST is
       * accepted, with the delegate event already in the ledger. The door's own
       * watcher finishes the record in the background even if this socket never
       * sees the end, which is precisely the case that used to leave a render
       * with no completion record at all.
       *
       * `adopt: false` because #finish files the song itself, under a name it
       * finds by mtime after the fact; the join back to the technical record is
       * `job.runId`, which index.js writes into the song's `generate` event. */
      job.submitting = true;
      const sent = await engine.submit({
        graph, actor: job.actor, via: "jobs.music", clientId: this.clientId,
        label: job.title || null, adopt: false,
      });
      job.submitting = false;
      job.promptId = sent.promptId;
      job.runId = sent.runId;
      if (job.cancelRequested) {
        // A cancellation can arrive while submit is in flight. Withdraw the
        // newly learned prompt id, without touching a subsequent current job.
        let stopped;
        try { stopped = await engine.cancelRun({ runId: sent.runId, promptId: sent.promptId }); }
        catch (e) { stopped = { ok: false, error: e.message }; }
        if (stopped?.ok === false) {
          job.cancelRequested = false;
          job.state = "running";
          job.error = `Cancellation was not confirmed: ${stopped.error || "the engine may still be running this song"}`;
          this.emit("update", this.snapshot());
        } else {
          this.#markCancelled(job);
          return;
        }
      }
      /* A dropped socket used to wedge the queue forever: close() nulls `ws`,
       * nothing ever ends the job, #pump early-returns on `current` — and
       * ArtRunner starves too, since its idle rule watches this queue. The
       * watchdog turns that into a recovery or an honest failure. */
      this.#lastActivity = Date.now();
      this.#lastSeen = null;
      /* .catch is not optional: an async function behind setInterval rejects
       * into nobody, and Node kills the process on an unhandled rejection —
       * so a hiccup in the code that exists to SURVIVE hiccups would take the
       * whole studio down, engine child and all. */
      if (!this.#watchTimer) {
        this.#watchTimer = setInterval(() => {
          this.#watchTick().catch((err) => console.warn(`  [watchdog] tick failed: ${err.message}`));
        }, 30_000);
        this.#watchTimer.unref();
      }
    } catch (err) {
      job.submitting = false;
      if (this.current !== job) return;
      job.state = "failed";
      job.error = String(err.message || err);
      job.finishedAt = Date.now();
      this.history.unshift(job);
      this.current = null;
      this.emit("update", this.snapshot());
      queueMicrotask(() => { this.#pump().catch((err) => console.warn(`  [queue] pump failed: ${err.message}`)); });
    }
  }

  #onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const job = this.current;
    if (!job) return;
    this.#lastActivity = Date.now();
    const { type, data = {} } = msg;

    if (type === "executing" && data.prompt_id === job.promptId) {
      if (data.node === null) return this.#finish(job);
      const stage = STAGE_OF_NODE[data.node];
      if (stage && stage !== job.stage) {
        job.stage = stage;
        job.stageProgress = 0;
        this.#recomputeOverall(job);
        this.emit("update", this.snapshot());
      }
    } else if (type === "progress" || type === "progress_state") {
      const value = data.value ?? Object.values(data.nodes || {})[0]?.value;
      const max = data.max ?? Object.values(data.nodes || {})[0]?.max ?? 1;
      if (typeof value === "number" && max) {
        job.stageProgress = Math.max(0, Math.min(1, value / max));
        this.#recomputeOverall(job);
        this.emit("update", this.snapshot());
      }
    } else if (type === "execution_error" && data.prompt_id === job.promptId) {
      job.state = "failed";
      job.error = data.exception_message || "Generation failed";
      job.finishedAt = Date.now();
      this.history.unshift(job);
      this.current = null;
      this.emit("update", this.snapshot());
      queueMicrotask(() => { this.#pump().catch((err) => console.warn(`  [queue] pump failed: ${err.message}`)); });
    }
  }

  /* Every 30 s while a local job is current. ComfyUI keeps rendering
   * server-side after a socket drop, so the order is: reattach, ask /history
   * whether it finished without us, and only fail on evidence — the prompt
   * vanishing from the engine, or nothing at all changing for STALL_MS. */
  async #watchTick() {
    const job = this.current;
    if (!job || !job.promptId) {
      clearInterval(this.#watchTimer);
      this.#watchTimer = null;
      return;
    }
    if (!this.ws) { try { await this.connect(); } catch { /* engine down; the poll decides */ } }
    let seen;
    try {
      const entry = (await engine.history(job.promptId))[job.promptId];
      if (this.current !== job) return;           // a live socket beat us to it
      if (entry) {
        // Finished while nobody was listening. Recover the result rather than
        // re-render minutes of GPU work that already happened.
        if (entry.status?.status_str === "error") return this.#abandon(job, "Generation failed while the engine connection was down");
        return this.#finish(job);
      }
      seen = queuePhase(await engine.queue(), job.promptId);
    } catch { seen = "unreachable"; }
    if (this.current !== job) return;
    /* Absent from the queue AND from history: the engine restarted and the job
     * went with it. Two consecutive sightings, because a prompt sits in neither
     * list for the instant between finishing and being written to history. */
    if (seen === "gone" && this.#lastSeen === "gone") {
      return this.#abandon(job, "The engine restarted and lost this job");
    }
    if (seen !== this.#lastSeen) { this.#lastSeen = seen; this.#lastActivity = Date.now(); }
    if (Date.now() - this.#lastActivity > STALL_MS) {
      /* Take THIS job's prompt off the engine too, so the next one is not
       * queued behind a stuck render — and only this one. A bare interrupt()
       * here stopped whatever the GPU was holding, which on a music-video night
       * is as likely to be an image, a gate render or a chat turn as it is to
       * be the song this watchdog gave up on. */
      engine.cancelRun({ runId: job.runId, promptId: job.promptId }).catch(() => {});
      this.#abandon(job, `No progress for ${Math.round(STALL_MS / 60_000)} minutes; engine presumed stuck`);
    }
  }

  /* The one thing the wedge never did: clear `current` so the queue pumps. */
  #abandon(job, why) {
    job.state = "failed";
    job.error = why;
    job.finishedAt = Date.now();
    this.history.unshift(job);
    this.current = null;
    this.emit("update", this.snapshot());
    queueMicrotask(() => { this.#pump().catch((err) => console.warn(`  [queue] pump failed: ${err.message}`)); });
  }

  #recomputeOverall(job) {
    let done = 0;
    for (const s of ORDER) {
      if (s === job.stage) { done += STAGE_WEIGHT[s] * job.stageProgress; break; }
      done += STAGE_WEIGHT[s];
    }
    job.overall = Math.max(0, Math.min(0.99, done));

    // ETA smoothing. A raw elapsed/progress extrapolation is meaningless in the
    // first seconds — it swung 184 -> 402 -> 269 s before settling, which reads as
    // the app not knowing what it is doing. So: hold the cold estimate until there
    // is real signal, then ease toward the measured pace instead of snapping.
    const elapsed = (Date.now() - job.startedAt) / 1000;
    if (job.overall < 0.08) return;
    const measured = Math.max(1, elapsed / job.overall - elapsed);
    const alpha = Math.min(0.35, 0.08 + job.overall * 0.4); // trust it more as it proceeds
    job.etaSmooth = job.etaSmooth == null ? measured : job.etaSmooth * (1 - alpha) + measured * alpha;
    // Never let a displayed ETA climb back up by more than a token amount; a
    // number that goes backwards is worse than one that is slightly optimistic.
    const shown = Math.round(job.etaSmooth);
    job.etaSeconds = job.etaSeconds != null && shown > job.etaSeconds + 20
      ? job.etaSeconds
      : shown;
  }

  /**
   * Run a job through the hosted engine.
   *
   * Reaches #finish's outcome by hand rather than calling it: #finish looks for
   * the newest file matching a prefix and for a captured AR trajectory, and
   * neither applies here — the provider hands back one finished file and has no
   * trajectory to capture. Assigning job.file directly is the honest version.
   */
  async #runApi(job) {
    try {
      job.stage = "queued";
      this.emit("update", this.snapshot());

      const out = await generateViaApi(job, {
        onStage: (stage) => {
          job.stage = stage;
          /* No step counts exist to drive a percentage. Rather than invent one,
           * the bar sits at a third while queued and two thirds while rendering
           * — coarse, but it never claims to know something it does not. */
          job.overall = stage === "downloading" ? 0.9 : stage === "rendering" ? 0.66 : 0.33;
          this.emit("update", this.snapshot());
        },
      });

      job.state = "done";
      job.overall = 1;
      job.finishedAt = Date.now();
      job.durationSeconds = Math.round((job.finishedAt - job.startedAt) / 1000);
      job.file = out.file;
      job.costUsd = out.usd;      // surfaced in the UI; local renders have none
      job.viaApi = true;
    } catch (err) {
      job.state = "failed";
      job.error = String(err.message || err);
      job.finishedAt = Date.now();
    }
    this.history.unshift(job);
    this.current = null;
    this.emit("update", this.snapshot());
    queueMicrotask(() => { this.#pump().catch((err) => console.warn(`  [queue] pump failed: ${err.message}`)); });
  }

  async #finish(job) {
    if (job.cancelRequested || this.current !== job) return;
    job.state = "done";
    job.overall = 1;
    job.finishedAt = Date.now();
    job.durationSeconds = Math.round((job.finishedAt - job.startedAt) / 1000);
    job.file = await this.#newestOutput(job.preview ? "preview" : "aiplay");
    job.codes = await this.#trajectoryFor(job);
    if (job.cancelRequested || this.current !== job) return;
    this.history.unshift(job);
    this.current = null;
    this.emit("update", this.snapshot());
    queueMicrotask(() => { this.#pump().catch((err) => console.warn(`  [queue] pump failed: ${err.message}`)); });
  }

  /** Everything that decides the AR trajectory. Two jobs agreeing on this share
   *  one AR execution — and therefore one captured trajectory. */
  #arKey(job) {
    return JSON.stringify([job.caption, job.lyrics, job.seed,
      job.arCfg ?? job.cfg ?? null, job.maxDuration, job.resumeFrom ?? null]);
  }

  /**
   * Which captured trajectory belongs to this render.
   *
   * "Newest npz" is wrong on its own: ComfyUI skips the AR stage on a cache hit,
   * so a re-roll writes no capture and would silently inherit whatever song ran
   * last. Take a capture only if it was written after this job started; if none
   * was, this was a cache hit, so reuse the trajectory of the earlier job with
   * identical AR inputs — which is genuinely the same trajectory.
   */
  async #trajectoryFor(job) {
    try {
      const dir = path.join(config.outputDir, ".codes");
      const names = await readdir(dir);
      let best = null;
      for (const n of names) {
        if (!n.endsWith(".npz")) continue;
        const s = await stat(path.join(dir, n));
        if (s.mtimeMs < job.startedAt) continue;
        if (!best || s.mtimeMs > best.mtimeMs) best = { n, mtimeMs: s.mtimeMs };
      }
      if (best) return path.join(dir, best.n);
    } catch { /* capture patch not applied */ }

    const key = this.#arKey(job);
    const prior = this.history.find((j) => j.codes && this.#arKey(j) === key);
    return prior?.codes ?? null;
  }

  async #newestOutput(prefix) {
    try {
      const entries = await readdir(config.outputDir, { withFileTypes: true });
      // Any audio extension we can emit, not just .flac — switching the output
      // format otherwise leaves this looking for a file that was never written,
      // so every render "succeeded" with `file: null`.
      const exts = [".flac", ".mp3", ".opus"];
      const files = entries.filter((e) => e.isFile() && e.name.startsWith(prefix)
        && exts.some((x) => e.name.endsWith(x)));
      let best = null;
      for (const f of files) {
        const full = path.join(config.outputDir, f.name);
        const s = await stat(full);
        if (!best || s.mtimeMs > best.mtimeMs) best = { name: f.name, mtimeMs: s.mtimeMs };
      }
      return best?.name ?? null;
    } catch {
      return null;
    }
  }

  /**
   * STOP THIS SONG. NOT THE ENGINE.
   *
   * ⚠ `await engine.interrupt()` was the whole of this method, and interrupt is
   * addressed at nothing in particular: it stops whatever the GPU is holding.
   * With the Stop button clearing ComfyUI's pending queue behind it, one
   * cancelled song took every other actor's queued prompt with it — measured
   * twice on 2026-09-05, when a chat turn queued behind a song was afterwards
   * in neither /history nor /queue, wrote no output, and was recorded
   * `vanished`, as though the engine had restarted under it.
   *
   * The door's cancelRun() is addressed at THIS job's own prompt: it asks the
   * engine to cancel that one id (atomically, where the engine can), and never
   * reaches for the engine-wide interrupt. A job with no promptId — API mode,
   * or one stopped before its POST — touches the engine not at all, because the
   * only thing an interrupt could stop then is somebody else's render.
   */
  #markCancelled(job) {
    if (this.current !== job) return;
    job.state = "cancelled";
    job.finishedAt = Date.now();
    this.history.unshift(job);
    this.current = null;
    this.emit("update", this.snapshot());
    queueMicrotask(() => { this.#pump().catch((err) => console.warn(`  [queue] pump failed: ${err.message}`)); });
  }

  async cancelById(id) {
    const index = this.queue.findIndex((j) => j.id === id);
    if (index >= 0) {
      const [job] = this.queue.splice(index, 1);
      job.cancelRequested = true;
      job.state = "cancelled";
      job.finishedAt = Date.now();
      this.history.unshift(job);
      this.emit("update", this.snapshot());
      return { found: true, id, state: job.state };
    }
    const job = this.current;
    if (!job || job.id !== id) {
      const past = this.history.find((j) => j.id === id);
      return { found: !!past, id, state: past?.state ?? null };
    }
    // A finished output may still be receiving its filename/trajectory. Let
    // that completion finish rather than falsely reporting it as cancelled.
    if (job.state === "done") return { found: true, id, state: job.state };
    job.cancelRequested = true;
    if (job.submitting && !job.promptId) {
      job.state = "cancelling";
      this.emit("update", this.snapshot());
      return { found: true, id, state: "cancelling", pending: true };
    }
    try {
      if (job.promptId) {
        const stopped = await engine.cancelRun({ runId: job.runId, promptId: job.promptId });
        if (stopped?.ok === false) throw new Error(stopped.error || "The engine did not confirm cancellation.");
      }
    } catch (e) {
      job.cancelRequested = false;
      job.error = `Cancellation was not confirmed: ${e.message}`;
      this.emit("update", this.snapshot());
      throw e;
    }
    if (this.current !== job) return { found: true, id, state: job.state };
    this.#markCancelled(job);
    return { found: true, id, state: job.state };
  }

  async cancel() {
    if (!this.current) return;
    return this.cancelById(this.current.id);
  }

  snapshot() {
    const view = (j) => j && {
      id: j.id, title: j.title, state: j.state, stage: j.stage,
      stageLabel: j.stage ? STAGE_LABEL[j.stage] : null,
      stageProgress: j.stageProgress, overall: j.overall,
      etaSeconds: j.etaSeconds, preview: !!j.preview,
      seed: j.seed, mixSeed: j.mixSeed, reroll: !!j.reusesConditioning,
      instrumental: !!j.instrumental, steps: j.steps, cfg: j.cfg,
      /* Whether this take HAS words, not the words themselves.
       *
       * The overnight panel needs it to decide whether a song is owed timed
       * lyrics, and that decision was silently always "no" because the view
       * dropped `lyrics` entirely. Sending the text instead would ship full
       * lyrics for forty history entries on every poll. */
      hasLyrics: !!String(j.lyrics || "").trim(),
      createdAt: j.finishedAt ?? j.startedAt ?? j.queuedAt,
      file: j.file, error: j.error, durationSeconds: j.durationSeconds,
      // Present means this take can be extended.
      codes: j.codes ?? null,
      ...(j.musicInput ? { musicInput: j.musicInput } : {}),
    };
    return {
      current: view(this.current),
      queue: this.queue.map(view),
      history: this.history.slice(0, 40).map(view),
    };
  }
}
