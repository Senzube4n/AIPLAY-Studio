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
import { readdir, stat, copyFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { config } from "./config.js";
import { buildGraph, buildYue2ComfyGraph, buildAceStep15Graph, STAGE_OF_NODE, STAGE_LABEL, STAGE_WEIGHT } from "./workflow.js";
/* The second kind of work: a subprocess with a receipt, not a graph. The door
 * (renderSong) owns the refusals, the progress line and the ledger row; this
 * class owns the queue position, the card handover and the landing. */
import { renderSong as renderYueSong, runYueDriver, killYueProcessTree, VRAM_MIN_GIB } from "./music/yue.js";
import { renderGgufSong, runGgufDriver, MIN_FREE_VRAM_MB as GGUF_MIN_FREE_VRAM_MB } from "./music/yue-gguf.js";
/* A FRESH card reading for the settle after /free — not gpu.js's 3-second
 * poller, which would answer with the number from before the release. */
import { freeVramMb } from "./mesh/runner.js";
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

/* The YuE2 branch's constants live ON THE CLASS (static fields below), not
 * here: scripts/test_music_input_jobs.mjs evals the class's text on its own
 * and injects only the names it knows, so a module-level constant the class
 * reaches for is a ReferenceError inside #pump in that test. */

/** Where a prompt sits in ComfyUI's GET /queue reply. Entries are positional
 *  arrays with the prompt id at index 1 — a shape read off the wire, not a
 *  documented API, which is why a test pins it. */
function queuePhase(q, promptId) {
  const has = (l) => Array.isArray(l) && l.some((e) => e?.[1] === promptId);
  return has(q?.queue_running) ? "running" : has(q?.queue_pending) ? "pending" : "gone";
}

export class JobRunner extends EventEmitter {
  /* How long a YuE2 job waits for ComfyUI to finish what it is doing before
   * giving up. Long, because "what it is doing" can be a 28-minute clip, and
   * a song that waited for it is better than a song that OOM'd against it. */
  static CARD_WAIT_MS = 45 * 60_000;
  /* How long the settle after /free waits for the floor the door needs.
   * ComfyUI releases in seconds once its worker gets to it; a minute is
   * generous, and past it the driver's own refusal says what still holds it. */
  static CARD_SETTLE_MS = 60_000;
  /* The driver's stage keys (yue.js STAGES) in the queue's words. `waiting`
   * and `load` are this runner's own moments; the rest arrive from the driver. */
  static YUE_STAGE_LABEL = {
    waiting: "Waiting for the card",
    resolve: "Checking the model files",
    verify: "Verifying the weights",
    load: "Loading the model",
    "score-supplied": "Using the supplied score",
    plan: "Writing the score",
    semantic: "Composing",
    nar: "Synthesising the audio",
    "decoder-load": "Loading the decoder",
    vae: "Decoding",
  };
  static YUE_GGUF_STAGE_LABEL = {
    waiting: "Waiting for the card",
    resolve: "Checking the native model files",
    verify: "Verifying the WAV audio",
    load: "Loading the model",
    plan: "Writing the score",
    semantic: "Singing",
    nar: "Synthesising the audio",
    decode: "Decoding the WAV",
    saving: "Saving the WAV",
  };
  static isStandaloneEngine(value) { return value === "yue2" || value === "yue2-gguf"; }
  static isKnownEngine(value) {
    return value == null || value === "minimax-music3" || value === "yue2-comfy" || value === "ace-step15" || JobRunner.isStandaloneEngine(value);
  }
  static sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  #waitTimer = null;
  #watchTimer = null;
  #lastActivity = 0;
  #lastSeen = null;

  constructor(comfy, { yue = null, yueGguf = null } = {}) {
    super();
    this.comfy = comfy;
    /* The YuE2 door, injectable so jobs_yue_test.js can run a job through a
     * fake driver in milliseconds. The default is the real one. */
    /* `typeof`-guarded because scripts/test_music_input_jobs.mjs evals this
     * class's text on its own, without the module's imports; an eval'd copy
     * gets no door and #runYue fails a YuE2 job in words rather than crash. */
    this.yue = yue || (typeof renderYueSong === "function" ? {
      renderSong: renderYueSong, runDriver: runYueDriver,
      killTree: killYueProcessTree, engine, spawn,
      freeVram: freeVramMb,
    } : null);
    /* A distinct door and receipt: native GGUF is not a Python rung. An
     * unmeasured native memory budget is null, never Python's 11.5 GiB floor.
     * The same typeof guard preserves the isolated class-extraction tests. */
    this.yueGguf = yueGguf || (typeof renderGgufSong === "function" ? {
      renderSong: renderGgufSong, runDriver: runGgufDriver, engine, spawn,
      freeVram: freeVramMb, minFreeVramMb: GGUF_MIN_FREE_VRAM_MB,
    } : null);
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
      /* A YuE2 job never used the engine that just died: its driver is its
       * own process and #runYue files it when that process ends. Failing it
       * here would pump the next job while the driver still holds the card. */
      if (!job || JobRunner.isStandaloneEngine(job.engine)) return;
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
      // A fresh engine has neither the old resident models nor necessarily
      // the same node set (the runtime may have changed between starts).
      this.loaded = null;
      this.artResident = false;
      this.#tiledAudio = false;
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
    /* There are no measured native ratios yet. Neither MiniMax's nor the
     * Python implementation's timings describe this different executable. */
    if (spec.engine === "yue2-gguf" || spec.engine === "yue2-comfy" || spec.engine === "ace-step15" || !JobRunner.isKnownEngine(spec.engine)) return null;
    if (spec.engine === "yue2") {
      /* MEASURED ratios (yue_fit.js Long rung): 2.39x realtime at the vendor's
       * defaults, 2.65x with the AR half offloaded; plus the planning stage,
       * ~111 s when no score is supplied (yue.js PLAN_SECONDS_ESTIMATED). The
       * length is an outcome, so the wanted length stands in for it. */
      const ratio = spec.rung?.offloadAr ? 2.65 : (config.music?.engines?.yue2?.realtimeRatio || 2.39);
      /* Past the vendor's stop the length attempted is the raised one, in
       * tokens at 25 a second; under it the wish stands in. */
      const attempt = spec.maxTokens ? spec.maxTokens / 25 : (Number(spec.wantSeconds) || 150);
      const want = Math.min(Math.max(attempt, 30), 983);
      return Math.round(want * ratio + (spec.abc ? 0 : 111));
    }
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
    /* A YuE2 job does not need ComfyUI to be ready — it needs it to be QUIET,
     * which #yieldCard settles — so the readiness wait is skipped for it too;
     * otherwise a machine whose ComfyUI is down could never render a song
     * with the engine that does not use it. */
    const next = this.queue[0];
    if (!config.api?.enabled && !this.comfy.ready && !JobRunner.isStandaloneEngine(next?.engine)
        && JobRunner.isKnownEngine(next?.engine)) {
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

    /* Local always, API mode or not: the hosted provider is MiniMax's, and a
     * YuE2 song rendered on somebody else's hardware does not exist. */
    if (job.engine === "yue2") return this.#runYue(job);
    if (job.engine === "yue2-gguf") return this.#runYueGguf(job);
    if (!JobRunner.isKnownEngine(job.engine)) {
      job.state = "failed";
      job.error = "This music engine is not supported. No other engine was started.";
      job.finishedAt = Date.now();
      this.history.unshift(job);
      this.current = null;
      this.emit("update", this.snapshot());
      queueMicrotask(() => { this.#pump().catch(() => {}); });
      return;
    }

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
    /* Only MiniMax has a hosted twin. YuE2 through ComfyUI and ACE-Step used to
     * fall through to here and be sent to the MiniMax API with API mode on. */
    if (config.api?.enabled && (!job.engine || job.engine === "minimax-music3")) return this.#runApi(job);

    try {
      await this.connect();
      if (job.cancelRequested) return;
      /* A DIFFERENT MODEL UNLOADS THE PREVIOUS ONE FIRST. ComfyUI would load
       * the new one beside the old, and on a 16 GB card MiniMax (~14 GiB warm)
       * next to YuE2 is how a render ends up streaming everything from RAM. */
      const modelKey = JobRunner.modelKey(job);
      if (modelKey && ((this.loaded && this.loaded.key !== modelKey) || this.artResident)) {
        console.log(`  [music] switching model: unloading ${this.artResident ? "the image/video model" : this.loaded.key} before ${modelKey}`);
        await this.unloadModels().catch(() => {});
        if (job.cancelRequested) return;
      }
      const graph = job.engine === "ace-step15" ? buildAceStep15Graph({
        caption: job.caption, lyrics: job.lyrics, seed: job.seed, mixSeed: job.mixSeed,
        duration: job.maxDuration, bpm: job.bpm, keyscale: job.keyscale, timesignature: job.timesignature,
        language: job.language, steps: job.aceSteps, cfg: job.aceCfg, dit: job.aceDit, lm: job.aceLm,
        lora: job.lora, loraStrength: job.loraStrength, codes: job.aceCodes, planTemperature: job.acePlanTemp,
        cover: job.aceCover, prefix: "aiplay",
      }) : job.engine === "yue2-comfy" ? buildYue2ComfyGraph({
        caption: job.caption,
        lyrics: job.lyrics,
        seed: job.seed,
        mixSeed: job.mixSeed,
        cot: job.cot,
        maxDuration: job.maxDuration,
        steps: job.narSteps,
        checkpoint: job.yue2Checkpoint,
        /* Named here or the LoRA the route accepted never reaches the graph —
         * the same explicit-list trap the audioRef comment below describes. */
        lora: job.lora,
        loraStrength: job.loraStrength,
        loraClip: job.loraClip,
        loraClipStrength: job.loraClipStrength,
        prefix: "aiplay",
      }) : buildGraph({
        tiledVae: await this.#hasTiledAudioDecode(),
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
    /* A YuE2 job's progress arrives from its driver, never from this socket —
     * and the `progress` branch below does not check prompt_id, so a stray
     * ComfyUI message would otherwise overwrite the driver's figures. */
    if (JobRunner.isStandaloneEngine(job.engine)) return;
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
    if (!job || JobRunner.isStandaloneEngine(job.engine) || !job.promptId) {
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

  /**
   * Run a job through the YuE2 driver — the second kind of work this runner
   * knows, and the one config.js's yue2 entry said was missing.
   *
   * Not a graph: a subprocess with its own progress line, its own receipt and
   * its own refusals (server/music/yue.js). Like #runApi it reaches #finish's
   * outcome by hand — there is no "newest file with a prefix" to find, because
   * the file is copied here under a name this method chose.
   *
   * ⚠ THE CARD IS NOT SHARED. ComfyUI and this driver have separate ceilings
   * (13.59 against 13.99 GiB) that do not add up to one card, so the job waits
   * for ComfyUI's queue to drain and then asks it to release its models before
   * a byte of YuE2 loads. That evicts the MiniMax weights; the next MiniMax
   * render pays a cold load. Stated here, and cheaper than an OOM eight minutes
   * in — which is what the driver's refusal would otherwise report, in a
   * traceback that says nothing about memory being somebody else's.
   */
  async #runYue(job) {
    const y = this.yue;
    try {
      if (!y) throw new Error("This runner has no YuE2 door wired (jobs.js was loaded without server/music/yue.js).");
      await this.#yieldCard(job);
      if (job.cancelRequested) throw Object.assign(new Error("cancelled"), { cancelled: true });
      const runDir = path.join(config.outputDir, "yue2", job.id);
      await mkdir(runDir, { recursive: true });
      job.stage = "load"; job.stageProgress = 0; job.overall = 0.01;
      this.emit("update", this.snapshot());
      /* The child is caught on its way past so a cancel can reach it: the door
       * owns the process and exposes nothing else about it. */
      const spawnFn = (cmd, argv, opts) => { const p = y.spawn(cmd, argv, opts); job.proc = p; return p; };
      const rung = job.rung || {};
      const r = await y.renderSong({
        style: job.caption, lyrics: job.lyrics, cot: job.cot || "full", seed: job.seed,
        abc: job.abc || null, cfg_scale: job.cfgScale ?? null, id: "song",
        /* ⚠ `system`, NOT `user`, for a job that arrived without an actor — and
         * it must not go back. renderSong stamps this straight into the ledger,
         * so the fallback decides what an unattributable render is recorded as,
         * and D1.0 says that is `system`. (The ComfyUI path at :356 passes
         * `job.actor` bare and lets normalizeActor land on `system`; these two
         * used to disagree with it, in the one direction that invents a person.) */
        out: runDir, actor: job.actor || "system", via: "jobs.music",
        offloadAr: !!rung.offloadAr,
        /* The user's precision choice wins over the rung's: a rung is a memory
         * plan, and "8-bit" is a thing somebody asked for by name. */
        quantization: job.quantization || rung.quantization || "none",
        queryChunk: rung.queryChunk ?? 0,
        /* Per-song speed and length choices, validated by /api/generate: the
         * solver's step count (32 or the measured-identical 16) and a raised
         * sampler stop for a song longer than the vendor's 360 s default. */
        narSteps: job.narSteps || 32,
        maxTokens: job.maxTokens || 0,
        /* A continuation: the run folder to replay and where the replay stops.
         * Named here or the route's acceptance never reaches the driver. */
        extendFrom: job.extendFrom || null,
        extendCodes: job.extendCodes || null,
        fromSeconds: job.fromSeconds || 0,
        abcOpen: !!job.abcOpen,
        sampling: job.sampling || null,
        planSampling: job.planSampling || null,
        allowSectionLabels: !!job.allowSectionLabels,
        /* An instrumental arrives with empty lyrics on purpose; the style
         * already says "no vocals" (index.js /api/generate phrased it). */
        allowEmptyLyrics: !!job.instrumental,
        audioSeconds: job.wantSeconds || null,
        onProgress: (ev) => this.#yueProgress(job, ev),
        /* The last synchronous moment before the python exists: a Stop that
         * arrived during the door's own checks (ledger append, stat()s, the
         * nvidia-smi read) is honoured here instead of after a full render. */
        runner: (args, o) => {
          if (job.cancelRequested) throw Object.assign(new Error("Cancelled before the driver started."), { cancelled: true });
          return y.runDriver(args, { ...o, spawnFn });
        },
      });
      /* COPIED, NOT MOVED. The receipt in runDir hashes audio.flac in place and
       * the score store adopts the folder by that receipt; a moved file would
       * make the run unadoptable. The prefix is the library's own gate
       * (library.js PREFIXES): a file without it is on disk and invisible. */
      const file = `aiplay_yue2_${job.id}.flac`;
      await copyFile(r.out, path.join(config.outputDir, file));
      job.file = file;
      job.audioSeconds = r.audioSeconds;
      job.runId = r.runId;
      job.yue = { runId: r.runId, dir: runDir, realtimeRatio: r.realtimeRatio,
                  truncated: r.truncated, rung: rung.id || null,
                  prefillPeakGib: r.prefillPeakGib ?? null, maxTokensRan: r.maxTokensRan ?? null,
                  extended: r.extended ?? null };
      job.state = "done";
      job.overall = 1;
    } catch (err) {
      if (this.current !== job) return;                    // filed by a cancel already
      if (job.cancelRequested || err?.cancelled) { job.proc = null; return this.#markCancelled(job); }
      job.state = "failed";
      job.error = String(err.message || err);
    } finally {
      job.proc = null;
    }
    if (this.current !== job) return;
    job.finishedAt = Date.now();
    job.durationSeconds = Math.round((job.finishedAt - job.startedAt) / 1000);
    this.history.unshift(job);
    this.current = null;
    this.emit("update", this.snapshot());
    queueMicrotask(() => { this.#pump().catch((err) => console.warn(`  [queue] pump failed: ${err.message}`)); });
  }

  /** Native YuE2 has its own WAV/provenance contract and cancellation owner.
   * The adapter awaits its ledger before calling runner, and runner awaits the
   * owned process tree's exit on abort. Keep the queue slot until that promise
   * settles; an unrelated ComfyUI event can neither finish nor cancel it. */
  async #runYueGguf(job) {
    const y = this.yueGguf;
    const controller = new AbortController();
    let childClosed = false;
    let childExit = null;
    job.abortController = controller;
    const assertActive = () => {
      if (job.cancelRequested || controller.signal.aborted) {
        throw Object.assign(new Error("Cancelled before the native driver started."), {
          name: "AbortError", refusal: "cancelled",
        });
      }
    };
    try {
      if (!y || typeof y.renderSong !== "function" || typeof y.runDriver !== "function"
          || typeof y.spawn !== "function") {
        throw new Error("This runner has no native YuE2 GGUF door wired. No other engine was started.");
      }
      if (job.preview || job.reusesConditioning || job.resumeFrom || job.musicInput || job.instrumental) {
        throw new Error("Native YuE2 GGUF does not support preview, re-roll, audio-input continuation or instrumentals. No other engine was started.");
      }
      const minFreeMb = y.minFreeVramMb ?? null;
      if (minFreeMb !== null && (!Number.isFinite(minFreeMb) || minFreeMb <= 0)) {
        throw new Error("The native YuE2 GGUF memory budget is invalid. Nothing was started.");
      }
      assertActive();
      await this.#yieldCard(job, y, minFreeMb);
      assertActive();
      const runDir = path.join(config.outputDir, "yue2-gguf", job.id);
      await mkdir(runDir, { recursive: true });
      assertActive();
      job.stage = "load"; job.stageProgress = null; job.overall = 0;
      this.emit("update", this.snapshot());
      const spawnFn = (cmd, argv, opts) => {
        /* Last synchronous check: a stop while the ledger or model checks
         * were awaiting cannot race into starting a new child afterwards. */
        assertActive();
        const child = y.spawn(cmd, argv, opts);
        job.proc = child;
        /* Observe close before the adapter attaches its own callbacks, so a
         * close concurrent with a failed kill acknowledgement is not lost. */
        childExit = new Promise((resolve) => {
          child.once?.("close", () => { childClosed = true; resolve(); });
        });
        return child;
      };
      const r = await y.renderSong({
        style: job.caption, lyrics: job.lyrics, cot: job.cot || "full", seed: job.seed,
        quantization: job.quantization === undefined ? "q4_0" : job.quantization,
        abc: job.abc || null, cfg_scale: job.cfgScale ?? null, narSteps: job.narSteps || 32,
        // ⚠ `system`, not `user` — see the note on the Python path above.
        id: "song", out: runDir, actor: job.actor || "system", via: "jobs.music",
        audioSeconds: job.wantSeconds || null,
        allowEmptyLyrics: !!job.instrumental,
        allowSectionLabels: !!job.allowSectionLabels,
        signal: controller.signal,
        onProgress: (ev) => this.#yueGgufProgress(job, ev),
      }, {
        runner: (args, options) => {
          assertActive();
          return y.runDriver(args, { ...options, signal: controller.signal, spawnFn });
        },
      });
      assertActive();
      if (r?.ok !== true || r.status !== "completed" || typeof r.out !== "string"
          || path.extname(r.out).toLowerCase() !== ".wav" || typeof r.runId !== "string" || !r.runId
          || !Number.isFinite(r.audioSeconds) || r.audioSeconds <= 0) {
        throw new Error("The native YuE2 GGUF door did not return a completed WAV receipt.");
      }
      /* The adapter has finished the actual render; as in #finish, a late
       * Stop must not turn this completed output into a cancellation while
       * its filename is being filed. Keep the original WAV beside its native
       * receipt, never adopt it through the Python score/receipt path. */
      job.state = "done";
      job.stage = "saving"; job.stageProgress = 1; job.overall = 1;
      const file = `aiplay_yue2_gguf_${job.id}.wav`;
      await copyFile(r.out, path.join(config.outputDir, file));
      job.file = file;
      job.audioSeconds = r.audioSeconds;
      job.runId = r.runId;
      job.quantization = r.quantization ?? job.quantization ?? "q4_0";
      // A valid WAV is not evidence that the model performed every lyric.
      // Keep the adapter's qualified warning with the take at every door.
      job.warnings = Array.isArray(r.warnings) ? r.warnings : [];
      job.generationLimits = r.generationLimits ?? null;
      job.yueGguf = {
        runId: r.runId, dir: r.dir || runDir,
        bytes: r.bytes ?? null, sampleRate: r.sampleRate ?? null,
        rights: r.rights ?? null, record: r.record ?? null, ledger: r.ledger ?? null,
      };
    } catch (err) {
      if (this.current !== job) return;
      if (job.proc && !childClosed && err?.terminationConfirmed !== true) {
        /* A rejected termination attempt is NOT evidence that the card is
         * free. Keep the queue reserved until this owned child closes. No
         * unrelated process is interrupted and no competing job is pumped. */
        job.state = "cancelling";
        job.error = "Native process termination could not be confirmed; the queue is waiting for its owned process to close.";
        this.emit("update", this.snapshot());
        await childExit;
        if (this.current !== job) return;
      }
      if (job.cancelRequested || err?.refusal === "cancelled" || err?.name === "AbortError") {
        return this.#markCancelled(job);
      }
      job.state = "failed";
      job.error = String(err?.message || err);
    } finally {
      job.proc = null;
      job.abortController = null;
    }
    if (this.current !== job) return;
    job.finishedAt = Date.now();
    job.durationSeconds = Math.round((job.finishedAt - job.startedAt) / 1000);
    this.history.unshift(job);
    this.current = null;
    this.emit("update", this.snapshot());
    queueMicrotask(() => { this.#pump().catch((err) => console.warn(`  [queue] pump failed: ${err.message}`)); });
  }

  /** The phase comes from the runtime's own timing lines; overall and ETA come
   * from this machine's earlier native renders (music/yue-gguf.js ggufEta), and
   * stay null until one has been measured — never a guessed figure. */
  #yueGgufProgress(job, ev) {
    if (this.current !== job || job.cancelRequested || !ev || ev.kind === "driver" || ev.kind === "summary") return;
    if (typeof ev.stage !== "string" || !Object.hasOwn(JobRunner.YUE_GGUF_STAGE_LABEL, ev.stage)) return;
    job.stage = ev.stage;
    job.stageProgress = Number.isFinite(ev.fraction) ? Math.max(0, Math.min(1, ev.fraction)) : null;
    job.etaSeconds = Number.isFinite(ev.etaSeconds) && ev.etaSeconds >= 0 ? Math.round(ev.etaSeconds) : null;
    if (Number.isFinite(ev.overall)) job.overall = Math.max(job.overall || 0, Math.min(0.99, ev.overall));
    const now = Date.now();
    if (now - (job.lastEmit || 0) > 900 || ev.status === "completed") {
      job.lastEmit = now;
      this.emit("update", this.snapshot());
    }
  }

  /** Wait for ComfyUI to have nothing running or pending, then ask it to give
   *  the card back — models included. An unreachable engine is not a busy one. */
  async #yieldCard(job, y = this.yue, minFreeMb = VRAM_MIN_GIB * 1024) {
    // Standalone music without a running ComfyUI has no queue to wait for.
    if (config.musicOnly && !this.comfy.ready) return;
    const t0 = Date.now();
    for (;;) {
      let q = null;
      try { q = await y.engine.queue(); } catch { q = null; }
      if (job.engine === "yue2-gguf" && this.comfy.ready
          && (!q || !Array.isArray(q.queue_running) || !Array.isArray(q.queue_pending))) {
        throw new Error("Cannot confirm that the image and video engine is idle. Native YuE2 GGUF was not started.");
      }
      const busy = !!q && ((q.queue_running || []).length + (q.queue_pending || []).length) > 0;
      if (!busy) break;
      if (job.cancelRequested) return;
      if (job.stage !== "waiting") { job.stage = "waiting"; job.stageProgress = 0; this.emit("update", this.snapshot()); }
      if (Date.now() - t0 > JobRunner.CARD_WAIT_MS) {
        throw new Error(`The graphics card did not come free in ${Math.round(JobRunner.CARD_WAIT_MS / 60_000)} minutes `
          + "— the image and video engine is still rendering. Nothing was started.");
      }
      await JobRunner.sleep(5000);
    }
    if (job.cancelRequested || !this.comfy.ready) return;
    const released = await y.engine.freeMemory({ unloadModels: true });
    if (job.engine === "yue2-gguf" && released?.freed !== true) {
      throw new Error("The image and video engine did not confirm unloading its models. Native YuE2 GGUF was not started.");
    }
    /* A native threshold must be explicit. null means no benchmark-backed
     * threshold exists; it does not mean reuse the Python memory plan. */
    if (minFreeMb == null) return;
    /* /free answers 200 when ComfyUI has QUEUED the release, not when the
     * memory is back: post_free only sets flags its prompt worker acts on.
     * Returning here on the 200 handed the driver a still-resident card
     * (MiniMax warm is ~14 GiB) and the driver's own VRAM refusal, which is
     * honest but late. Settle: read the card until the floor the door needs
     * is free, for a bounded while; a card that never frees is the driver's
     * refusal to explain, in its own words. `null` = no NVIDIA reading on
     * this machine, and nothing to wait for. */
    const t1 = Date.now();
    for (;;) {
      let freeMb = null;
      try { freeMb = await y.freeVram(); } catch { freeMb = null; }
      if (job.engine === "yue2-gguf" && (!Number.isFinite(freeMb) || freeMb < 0)) {
        throw new Error("Cannot verify the configured native YuE2 GGUF memory budget. Nothing was started.");
      }
      if (freeMb === null || freeMb >= minFreeMb) return;
      if (job.cancelRequested) return;
      if (Date.now() - t1 > JobRunner.CARD_SETTLE_MS) {
        if (job.engine === "yue2-gguf") {
          throw new Error("The configured native YuE2 GGUF memory budget did not become available. Nothing was started.");
        }
        return;
      }
      if (job.stage !== "waiting") { job.stage = "waiting"; this.emit("update", this.snapshot()); }
      await JobRunner.sleep(2000);
    }
  }

  /** The driver's progress line, in the queue's fields. `overall` and the ETA
   *  come from the reader's own accounting (yue.js createProgressReader), which
   *  knows the measured share of each stage; this only refuses to go backwards. */
  #yueProgress(job, ev) {
    if (this.current !== job || !ev || ev.kind === "driver" || ev.kind === "summary") return;
    if (ev.stage) job.stage = ev.stage;
    job.stageProgress = Number.isFinite(ev.fraction) ? ev.fraction : 0;
    if (Number.isFinite(ev.overall)) job.overall = Math.max(job.overall || 0, Math.min(0.99, ev.overall));
    const elapsed = (Date.now() - job.startedAt) / 1000;
    if (job.overall > 0.08) job.etaSeconds = Math.max(0, Math.round(elapsed / job.overall - elapsed));
    const now = Date.now();
    if (now - (job.lastEmit || 0) > 900 || ev.status === "completed") {
      job.lastEmit = now;
      this.emit("update", this.snapshot());
    }
  }

  async #finish(job) {
    if (job.cancelRequested || this.current !== job) return;
    job.state = "done";
    job.overall = 1;
    job.finishedAt = Date.now();
    job.durationSeconds = Math.round((job.finishedAt - job.startedAt) / 1000);
    /* THE FILE THIS PROMPT WROTE, from ComfyUI's own history — and only when
     * that cannot be read, the newest file by name. "Newest" alone is a guess
     * that goes wrong exactly when nothing new was written: it then names the
     * previous song, and this job reports that song as its own. */
    const reported = await this.#historyOutput(job);
    job.file = reported?.name ?? await this.#newestOutput(job.preview ? "preview" : "aiplay");
    /* NOTHING NEW WAS RENDERED. ComfyUI answers an identical graph from its
     * cache: every node skipped, the old file listed as the output. That file
     * predates this job, which is the one test that cannot be fooled by timing.
     * The job still points at the file (it IS what those inputs make), but it
     * says so, rather than looking like a render that happened. */
    if (reported && reported.mtimeMs < job.startedAt) {
      job.cached = true;
      job.note = `Nothing new was rendered: the seed, words and settings match an earlier take, `
        + `so ComfyUI returned that result (${job.file}) from its cache. `
        + `Press 🎲 random or change the seed for a new song.`;
    }
    // A real render leaves its model loaded in ComfyUI; a cache hit loaded nothing.
    if (!job.cached && JobRunner.modelKey(job)) this.loaded = { key: JobRunner.modelKey(job), at: Date.now() };
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

  /* ── THE MUSIC MODEL COMFYUI IS HOLDING ──────────────────────────────────
   *
   * ComfyUI keeps a model loaded between prompts — measured here 2026-09-16:
   * the first YuE2 song after an engine start took 38–64 s, every later one
   * 24 s. The page used to say "every take is a fresh render", which is true
   * of the Python YuE2 kit (a new process per song) and false for anything
   * rendered through ComfyUI. ComfyUI has no endpoint that lists loaded
   * models, so this is Studio's own record: set by a render or a Load that
   * finished, cleared by Unload, by a different model starting, or by the
   * engine going down. */
  loaded = null;

  /* Whether this ComfyUI has VAEDecodeAudioTiled (newer builds do; an older
   * install would refuse a graph naming it). Asked of the engine itself; a yes
   * is kept, a no or an unreachable engine is asked again next song, and until
   * then the song decodes whole, as it always did. */
  #tiledAudio = false;
  async #hasTiledAudioDecode() {
    if (config.music?.tiledVae === false) return false;
    if (this.#tiledAudio) return true;
    try {
      const info = await engine.objectInfo("VAEDecodeAudioTiled");
      this.#tiledAudio = !!info?.VAEDecodeAudioTiled;
    } catch { this.#tiledAudio = false; }
    return this.#tiledAudio;
  }
  /* Set by the art runner when a picture, clip or stem job ran in ComfyUI
   * since the last unload: its model is resident and Studio cannot see which. */
  artResident = false;
  static modelKey(job) {
    if (job?.engine === "yue2-comfy") return job.yue2Checkpoint ? `yue2-comfy:${job.yue2Checkpoint}` : null;
    if (job?.engine === "ace-step15") return job.aceDit ? `ace-step15:${job.aceDit}` : null;
    if (!job?.engine || job.engine === "minimax-music3") return `minimax-music3:${job?.model || "int8"}`;
    return null;   // standalone engines (Python YuE2, native GGUF) never live in ComfyUI
  }
  markLoaded(key) {
    this.loaded = key ? { key, at: Date.now() } : null;
    this.emit("update", this.snapshot());
  }
  /** Unload every model from ComfyUI (RAM and VRAM). Reports; never throws. */
  async unloadModels() {
    const report = await engine.freeMemory({ unloadModels: true });
    this.loaded = null;
    this.artResident = false;
    console.log("  [music] models unloaded from ComfyUI");
    this.emit("update", this.snapshot());
    return report;
  }

  /** { name, mtimeMs } of the first output file ComfyUI's history lists for
   *  this job's prompt, or null when there is no prompt id, no history entry
   *  or no file on disk — the caller then falls back to #newestOutput. */
  async #historyOutput(job) {
    if (!job.promptId) return null;
    try {
      const entry = (await engine.history(job.promptId))?.[job.promptId];
      for (const out of Object.values(entry?.outputs || {})) {
        for (const f of Object.values(out || {}).flat()) {
          if (!f?.filename || (f.type && f.type !== "output")) continue;
          const st = await stat(path.join(config.outputDir, f.subfolder || "", f.filename)).catch(() => null);
          if (st) return { name: f.subfolder ? path.join(f.subfolder, f.filename) : f.filename, mtimeMs: st.mtimeMs };
        }
      }
    } catch { /* engine unreachable: the newest-file fallback decides */ }
    return null;
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
    if (job.engine === "yue2-gguf") {
      /* The native adapter owns this child's kill/exit lifecycle. Do not also
       * kill it here or interrupt ComfyUI; its promise is the card-release
       * barrier. Repeated Stop is idempotent and does not file a second row. */
      job.state = "cancelling";
      job.abortController?.abort();
      this.emit("update", this.snapshot());
      return { found: true, id, state: "cancelling", pending: true };
    }
    if (job.engine === "yue2") {
      /* No promptId ever: the driver is the thing to stop. #runYue's catch sees
       * cancelRequested and files the job once; nothing here may file it too.
       * Before the process exists (still waiting for the card) the flag alone
       * is enough — #yieldCard checks it between polls. */
      job.state = "cancelling";
      this.emit("update", this.snapshot());
      if (job.proc && this.yue?.killTree) await this.yue.killTree(job.proc).catch(() => {});
      return { found: true, id, state: "cancelling", pending: true };
    }
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
      stageLabel: j.stage ? (j.engine === "yue2-gguf"
        ? (JobRunner.YUE_GGUF_STAGE_LABEL[j.stage] || j.stage)
        : (STAGE_LABEL[j.stage] || JobRunner.YUE_STAGE_LABEL[j.stage] || j.stage)) : null,
      /* Which runner made it, so the page draws that engine's stages and the
       * filer stamps that engine's model. Absent means the original one. */
      engine: j.engine || "minimax-music3",
      ...(j.engine === "yue2-gguf" ? {
        elapsedSeconds: Number.isFinite(j.startedAt)
          ? Math.max(0, Math.floor(((j.finishedAt ?? Date.now()) - j.startedAt) / 1000)) : null,
        generationLimits: j.generationLimits ?? null,
        warnings: Array.isArray(j.warnings) ? j.warnings : [],
      } : {}),
      wantSeconds: j.wantSeconds ?? null, audioSeconds: j.audioSeconds ?? null,
      rung: j.rung ? { id: j.rung.id, label: j.rung.label } : null,
      quantization: j.quantization || null,
      /* The YuE2-through-ComfyUI LoRAs, so queue rows and MCP say what patched
       * the render — BOTH of them. The planner's was added the day the clip
       * door shipped and left out of here, which made the one LoRA the Studio
       * can choose BY ITSELF (an instrumental picks the planner LoRA) the one
       * nothing could report. A choice made on your behalf that you cannot see
       * afterwards is the worst kind. */
      lora: j.lora ?? null, loraStrength: j.lora ? (j.loraStrength ?? 1) : null,
      loraClip: j.loraClip ?? null, loraClipStrength: j.loraClip ? (j.loraClipStrength ?? 1) : null,
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
      // A run ComfyUI answered from its cache: nothing new was rendered.
      cached: !!j.cached, note: j.note || null,
      // Present means this take can be extended.
      codes: j.codes ?? null,
      ...(j.musicInput ? { musicInput: j.musicInput } : {}),
    };
    return {
      /* What ComfyUI is holding, per Studio's record — none while the engine
       * is down, because a restarted ComfyUI holds nothing. */
      loadedModel: this.comfy?.ready ? this.loaded : null,
      current: view(this.current),
      queue: this.queue.map(view),
      history: this.history.slice(0, 40).map(view),
    };
  }
}
