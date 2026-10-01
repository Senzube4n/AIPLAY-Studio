/**
 * Overnight batch runs.
 *
 * You write a handful of ideas, say how many takes you want of each, and go to
 * bed. In the morning the library is full.
 *
 * Three decisions carry this file:
 *
 * 1. ROUND ROBIN, not sequential. The plan is take 1 of every idea, then take 2
 *    of every idea, and so on. A run that only gets 60% through overnight then
 *    leaves you with a few takes of everything rather than twenty takes of idea
 *    one and nothing at all of ideas four through six. Partial completion is the
 *    normal case for an unattended run, so it is what the ordering optimises for.
 *
 * 2. THE PLAN IS ON DISK. An overnight run outlives crashes, engine restarts and
 *    accidental window-closing, so the plan and the cursor are persisted on every
 *    transition and reloaded at boot. Closing the browser was already harmless --
 *    the queue lives here, not in the page -- but losing power at 3am was not.
 *
 * 3. ONE JOB IN FLIGHT. The runner enqueues the next song only when the previous
 *    one lands. Queueing all fifty up front would make Stop mean "stop in about
 *    four hours", and would freeze every ETA in the UI.
 *
 * Every take gets a fresh performance seed, so takes differ as real alternates
 * rather than as remixes of one performance. See workflow.js for why the seed and
 * the mix seed are separate knobs.
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { assertSafe } from "./safety/refusal.js";
import { enumerate } from "./wildcards.js";
import { cleanMusicItem } from "./batch-music.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(config.paths.appData, "batch.json");

const MAX_ITEMS = 40;
const MAX_TAKES = 20;
const MAX_CAP = 200;

const clamp = (n, lo, hi) => Math.min(Math.max(Number(n) || lo, lo), hi);

/** A scheduled start has an explicit timezone and must survive JSON unchanged.
 * Reject normalised dates (for example February 30), vague local times and past
 * choices instead of unexpectedly starting an unattended run immediately. */
export function batchStartAt(value, now = Date.now()) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    throw new Error("Choose a future startAt in ISO UTC, such as 2026-10-02T20:00:00Z.");
  }
  const at = Date.parse(value);
  const canonical = value.replace(/(?:\.(\d{1,3}))?Z$/, (_whole, fraction) => `.${(fraction || "").padEnd(3, "0")}Z`);
  if (!Number.isFinite(at) || new Date(at).toISOString() !== canonical) {
    throw new Error("Choose a valid startAt date and time in ISO UTC.");
  }
  if (at <= now) throw new Error("The scheduled start is in the past. Choose a future time or Start now.");
  return at;
}

/** Preserve image choices through persistence. Render-time validation remains
 * at /api/image, shared by manual images and every overnight take. */
export function cleanMediaItem(it, kind) {
  const item = {
    prompt: String(it.prompt || it.caption).trim(), title: String(it.title || "").trim(),
    engine: typeof it.engine === "string" ? it.engine.slice(0, 32) : undefined,
    checkpoint: typeof it.checkpoint === "string" ? it.checkpoint.slice(0, 200) : undefined,
    negative: typeof it.negative === "string" ? it.negative.slice(0, 2000) : undefined,
    width: Number.isFinite(it.width) ? clamp(it.width, 256, kind === "image" ? 4096 : 2048) : undefined,
    height: Number.isFinite(it.height) ? clamp(it.height, 256, kind === "image" ? 4096 : 2048) : undefined,
    steps: Number.isFinite(it.steps) ? clamp(it.steps, 1, 60) : undefined,
    cfg: Number.isFinite(it.cfg) ? clamp(it.cfg, 1, 15) : undefined,
    count: Number.isFinite(it.count) ? clamp(it.count, 1, 4) : undefined,
    seconds: Number.isFinite(it.seconds) ? clamp(it.seconds, 1, 30) : undefined,
  };
  /* ⚠ THE MINORS RULE, AT START, so a night is not forty refusals. Checked on
   * every prompt the template can EXPAND to: a plan any one of whose takes
   * would put a child or teenager beside sexual content is refused whole, and
   * "{a family picnic with kids|a nude figure study of an adult}" is not,
   * because no take holds both. A template with more than 256 expansions is
   * checked whole, braces and all (the old, stricter reading). Every take is
   * checked again at /api/image or /api/video and at the engine door, which
   * also covers a plan saved before this check existed. Pictures and clips
   * only; a music batch's captions are songs. */
  if (kind === "image" || kind === "video") {
    const { prompts, truncated } = enumerate(item.prompt, 256);
    for (const take of truncated ? [item.prompt] : prompts) {
      assertSafe({ door: "batch.start", via: `batch.${kind}`, texts: [take] });
    }
  }
  if (kind !== "image") return item;
  for (const key of ["dit", "ditEngine", "encoder", "vae", "persona", "quality", "sampler", "scheduler", "refSizing"]) {
    if (it[key] !== undefined) {
      if (typeof it[key] !== "string" || it[key].length > 200) throw new Error(`Image ${key} must be text of at most 200 characters.`);
      item[key] = it[key];
    }
  }
  if (it.refImages !== undefined) {
    if (!Array.isArray(it.refImages) || it.refImages.length > 10 || it.refImages.some((name) => typeof name !== "string" || !name || name.length > 200 || /[\\/]/.test(name))) {
      throw new Error("An overnight image accepts up to 10 reference filenames; none may be omitted or truncated.");
    }
    item.refImages = [...it.refImages];
  }
  if (it.transparent !== undefined) {
    if (typeof it.transparent !== "boolean") throw new Error("Image transparent must be a boolean.");
    item.transparent = it.transparent;
  }
  /* Qwen's Fast draft, kept like transparent: /api/image refuses it per take
   * on another engine or beside a base-only choice, in its own words. */
  if (it.draft !== undefined) {
    if (typeof it.draft !== "boolean") throw new Error("Image draft must be a boolean.");
    item.draft = it.draft;
  }
  for (const key of ["clipSkip", "refResolution"]) {
    if (it[key] !== undefined) {
      if (!Number.isFinite(it[key])) throw new Error(`Image ${key} must be a finite number.`);
      item[key] = it[key];
    }
  }
  if (it.loras !== undefined) {
    if (!Array.isArray(it.loras) || it.loras.length > 8) throw new Error("An overnight image accepts up to 8 LoRAs.");
    item.loras = it.loras.map((lora) => {
      if (!lora || typeof lora.name !== "string" || !lora.name || lora.name.length > 200) throw new Error("Each image LoRA needs its model filename.");
      const row = { name: lora.name };
      for (const key of ["strength", "clipStrength"]) if (lora[key] !== undefined) {
        if (!Number.isFinite(lora[key])) throw new Error(`LoRA ${key} must be a finite number.`);
        row[key] = lora[key];
      }
      return row;
    });
  }
  return item;
}

/**
 * Which stages this particular song should expect.
 *
 * Not simply the run's chain: timed lyrics need words, so an instrumental is
 * never owed them. Listing a stage that cannot run would leave a row stuck at
 * "waiting" forever and teach people to ignore the display.
 */
function expectedStages(chain, job) {
  const out = {};
  if (!chain) return out;
  if (chain.cover) out.cover = "waiting";
  if (chain.stems) out.stems = "waiting";
  /* ⚠ `job` here is a jobs.js SNAPSHOT, not the live job, and the snapshot
   * carries no lyric text — so reading `job.lyrics` was always empty and the
   * lrc row was never listed for ANY song. The whisper pass still ran; it just
   * had nowhere to report, and `noteStage(file, "lrc")` was a silent no-op
   * because the key it looks for did not exist. */
  if (chain.lrc && (job?.hasLyrics ?? String(job?.lyrics || "").trim())) out.lrc = "waiting";
  if (chain.video) out.video = "waiting";
  /* Only when there will BE a clip. Enhancement is the one stage whose input is
   * another stage's output, so listing it without video would leave a row
   * waiting forever on something that is never coming. */
  if (chain.enhance && chain.video) out.enhance = "waiting";
  return out;
}

/** How many songs start() would plan for these ideas, and the longest one
 *  asked for: the words of the paid-night question (/api/batch, server/
 *  cloud-switch.js), counted by this file's own limits rather than a copy. */
export function plannedSongs({ items, takes, cap } = {}) {
  const ideas = (items || []).filter((it) => it && String(it.caption || "").trim()).slice(0, MAX_ITEMS);
  if (!ideas.length) return { songs: 0, longestSeconds: 0 };
  const t = clamp(takes ?? 3, 1, MAX_TAKES);
  const c = clamp(cap ?? ideas.length * t, 1, MAX_CAP);
  return {
    songs: Math.min(c, ideas.length * t),
    longestSeconds: Math.max(...ideas.map((it) => clamp(it.maxDuration ?? 240, 30, 300))),
  };
}

/** Paid consent covers only MiniMax takes reached by the bounded round-robin
 * plan. Local engines in the same night cannot inflate its hosted estimate. */
export function plannedPaidSongs({ items, takes, cap, defaultEngine = "minimax-music3" } = {}) {
  const ideas = (items || []).filter(it => it && String(it.caption || "").trim()).slice(0, MAX_ITEMS);
  const t = clamp(takes ?? 3, 1, MAX_TAKES);
  const c = clamp(cap ?? ideas.length * t, 1, MAX_CAP);
  let planned = 0, songs = 0, longestSeconds = 0;
  for (let take = 0; take < t && planned < c; take++) {
    for (const item of ideas) {
      if (planned >= c) break;
      planned++;
      if ((item.engine ?? defaultEngine) !== "minimax-music3") continue;
      songs++;
      longestSeconds = Math.max(longestSeconds, clamp(item.maxDuration ?? 240, 30, 300));
    }
  }
  return { songs, longestSeconds };
}

export class BatchRunner extends EventEmitter {
  constructor(jobs, { postBusy, renderMedia, enqueueMusic, stateFile = STATE_FILE, keepAwake,
    now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    super();
    this.jobs = jobs;
    this.enqueueMusic = enqueueMusic || ((spec) => this.jobs.enqueue(spec));
    this.directMusicEnqueue = !enqueueMusic;
    this.stateFile = stateFile;
    this.keepAwake = keepAwake || null;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.scheduleTimer = null;
    this.scheduleGeneration = 0;
    this.persisted = Promise.resolve();
    this.persistenceError = null;
    /* Render one picture or one clip, injected for the same reason postBusy is:
     * this file goes on knowing nothing about the art runner. Resolves when the
     * media has actually landed, so an image run advances on completion exactly
     * as a music run advances on its job event — the two kinds differ in what
     * they ask for, not in how the plan is drained. */
    this.renderMedia = renderMedia || null;
    /* Is there still post-processing outstanding? Injected rather than imported
     * so this file keeps knowing nothing about the art runner.
     *
     * A run used to be "finished" the moment the last song rendered — and then
     * released the sleep lock while hours of clip rendering were still queued.
     * A run is finished when the PIPELINE is, not when the music is. */
    this.postBusy = postBusy || (() => false);
    this.run = null;
    /* Finished runs. The UI has always rendered `s.runs || [s.run]`, which meant
     * the "past runs" list could only ever show the CURRENT run — a duplicate of
     * the live panel directly above it. Nothing was keeping them. */
    this.runs = [];
    this.awake = null;
    this.pendingJobId = null;
    /* A picture or clip in flight. Separate from pendingJobId because the two
     * are advanced by different mechanisms and a run is only ever one kind. */
    this.pendingMedia = false;
    // The ordinary song door can await model checks or cover preparation before
    // it has a job ID. Reserve the slot during that wait as well as the render.
    this.pendingMusic = null;

    // The runner advances off the job runner's own events rather than polling, so
    // a song that fails still moves the batch along instead of wedging it.
    this.jobs.on("update", (snap) => this.#onJobUpdate(snap));
  }

  // ---- persistence --------------------------------------------------------

  async load() {
    this.#cancelSchedule();
    try {
      const raw = JSON.parse(await readFile(this.stateFile, "utf-8"));
      this.runs = Array.isArray(raw?.runs) ? raw.runs : [];
      if (!raw?.run) { if (this.runs.length) this.emit("update"); return; }
      // Before engine snapshots existed every music batch enqueued MiniMax
      // jobs directly. A changed global picker must not reinterpret that plan.
      let migrated = false;
      if (raw.run.kind === undefined) { raw.run.kind = "music"; migrated = true; }
      if ((raw.run.kind || "music") === "music") {
        for (const item of raw.run.items || []) if (item && item.engine === undefined) {
          item.engine = "minimax-music3";
          migrated = true;
        }
      }
      // A run that was mid-flight when the process died resumes as paused. It is
      // never auto-restarted: the machine may have rebooted for a reason, and
      // silently firing up a four-hour GPU job on boot is not a friendly default.
      if (raw.run.state === "running") {
        raw.run.state = "paused";
        raw.run.note = "Picked up where it stopped. Press resume to carry on.";
        migrated = true;
      }
      // Future appointments were explicitly authorised. An appointment missed
      // while Studio was closed needs another press rather than a surprise run.
      if (raw.run.state === "scheduled" && (!Number.isFinite(raw.run.startAt) || raw.run.startAt <= this.now())) {
        raw.run.state = "paused";
        raw.run.note = "The scheduled start was missed while Studio was closed. Press Resume to start now.";
        migrated = true;
      }
      this.run = raw.run;
      if (migrated) await this.#save();
      if (this.run.state === "scheduled") this.#armSchedule();
      this.emit("update");
    } catch { /* no previous run */ }
  }

  #save() {
    // Capture each transition now, then commit it in order. Concurrent writes
    // used to truncate one another; an interrupted write must not lose a plan.
    const snapshot = JSON.stringify({ run: this.run, runs: this.runs }, null, 2);
    this.persisted = this.persisted.then(async () => {
      try {
        await mkdir(path.dirname(this.stateFile), { recursive: true });
        await writeFile(`${this.stateFile}.tmp`, snapshot);
        await rename(`${this.stateFile}.tmp`, this.stateFile);
        this.persistenceError = null;
      } catch (err) { this.persistenceError = err; }
    });
    return this.persisted;
  }

  /** The scheduled-start API waits for the plan to reach disk before saying yes. */
  async persist() {
    await this.persisted;
    if (this.persistenceError) throw new Error(`The batch could not be saved: ${this.persistenceError.message}`);
  }

  #cancelSchedule() {
    this.scheduleGeneration++;
    if (this.scheduleTimer !== null) this.clearTimer(this.scheduleTimer);
    this.scheduleTimer = null;
  }

  #armSchedule() {
    this.#cancelSchedule();
    const r = this.run;
    if (!r || r.state !== "scheduled") return;
    const generation = this.scheduleGeneration;
    // Node timers overflow beyond roughly 24 days. Recheck long appointments
    // and changes to the system clock instead of firing an overflowing timer.
    const delay = Math.min(2 ** 31 - 1, Math.max(0, r.startAt - this.now()));
    this.scheduleTimer = this.setTimer(() => {
      if (generation !== this.scheduleGeneration || this.run !== r || r.state !== "scheduled") return;
      this.scheduleTimer = null;
      if (this.now() < r.startAt) return this.#armSchedule();
      this.#begin(r);
    }, delay);
    this.scheduleTimer?.unref?.();
  }

  #begin(r = this.run) {
    if (!r || this.run !== r) return;
    this.#cancelSchedule();
    r.state = "running";
    r.note = null;
    r.startedAt ??= this.now();
    this.#keepAwake(true);
    this.#save();
    if (!this.pendingJobId && !this.pendingMedia && !this.pendingMusic) this.#next();
    this.emit("update");
  }

  // ---- shaping ------------------------------------------------------------

  /** Build the round-robin plan, truncated to the cap. */
  #plan(items, takes, cap) {
    const out = [];
    for (let take = 0; take < takes; take++) {
      for (let i = 0; i < items.length; i++) {
        if (out.length >= cap) return out;
        out.push({ item: i, take });
      }
    }
    return out;
  }

  start({ items, takes, cap, name, stages, kind: k, actor, paidConfirmed = false, startAt }) {
    /* Refuse rather than overwrite.
     *
     * `this.run` was assigned unconditionally, so pressing Start during a live
     * run discarded the whole in-flight object — plan, cursor, counters, file
     * list — and enqueued a second song alongside the one still rendering. With
     * no history kept, the discarded run left no trace at all. */
    if (this.run && ["running", "paused", "scheduled"].includes(this.run.state)) {
      throw new Error("A run is already going. Stop it first, or wait for it to finish.");
    }
    const scheduledAt = batchStartAt(startAt, this.now());
    /* WHAT THIS RUN MAKES. Music is the original and stays the default, so an
     * older client that sends no kind keeps working exactly as before.
     *
     * The three kinds differ only in what one item IS and what rendering it
     * means. The plan, the cursor, the cap, the takes, the archive and the
     * sleep lock are identical for all of them — which is why this is a field
     * on the run rather than a second runner. */
    const kind = ["music", "image", "video"].includes(k) ? k : "music";
    if (kind !== "music" && !this.renderMedia) {
      throw new Error(`This build cannot run ${kind} batches — no media renderer was wired in.`);
    }

    const clean = kind !== "music" ? (items || [])
      .filter((it) => it && String(it.prompt || it.caption || "").trim())
      .slice(0, MAX_ITEMS)
      .map((it) => cleanMediaItem(it, kind)) : (items || [])
      .filter((it) => it && String(it.caption || "").trim())
      .slice(0, MAX_ITEMS)
      .map((it) => cleanMusicItem(it, { defaultEngine: config.music.engine }));
    if (!clean.length) {
      throw new Error(kind === "music"
        ? "Add at least one idea with a style."
        : `Add at least one ${kind} idea with a prompt.`);
    }

    const t = clamp(takes ?? 3, 1, MAX_TAKES);
    const c = clamp(cap ?? clean.length * t, 1, MAX_CAP);

    this.run = {
      id: randomUUID().slice(0, 8),
      name: String(name || "").trim() || (kind === "music" ? "Batch run" : `Batch ${kind} run`),
      kind,
      /* WHO started this night. Carried on the run and stamped on everything it
       * makes: a run an agent scheduled must not launder into "system" at the
       * first hop, which is exactly what an internal request with no actor
       * header would do.
       *
       * ⚠ BUT THE FALLBACK IS `system`, AND MUST NOT GO BACK TO `user`. Keeping
       * a NAMED actor whole is the paragraph above; inventing one for a caller
       * that named nobody is the opposite thing, and the ledger's rule (D1.0)
       * is that the unattributable records `system` and NEVER `user`. A whole
       * overnight run of takes stamped as a person's is also how `ai-generated`
       * becomes `ai-assisted-human-edited` in foldOrigin. /api/batch already
       * passes prov.actorFrom(req), which is never empty, so this branch only
       * ever catches a caller with no name — the case it must not flatter. */
      actor: typeof actor === "string" && actor ? actor : "system",
      items: clean,
      takes: t,
      cap: c,
      /* The person's yes to a paid night: /api/batch sets it only from the
       * request's own confirmSpend, after telling them what the run would
       * cost on the hosted engine (server/cloud-switch.js). Without it, a
       * song that would reach the hosted engine is refused by the runner. */
      paidConfirmed: paidConfirmed === true,
      /**
       * What runs AFTER each song in this run.
       *
       * Stored ON THE RUN rather than read from global settings, so a plan made
       * at bedtime keeps its shape: changing a Settings dropdown the next morning
       * must not retroactively alter what an in-flight run is doing.
       *
       * These schedule nothing themselves — they are handed to the same
       * idle-drain runner that already draws covers, which is what guarantees
       * music always preempts.
       */
      stages: {
        cover: stages?.cover !== false,
        lrc: !!stages?.lrc,
        stems: !!stages?.stems,
        // `video` was absent from this rebuild while the client had been sending
        // it all along, so run.stages.video was permanently undefined and the
        // Overnight "Video clip" checkbox enqueued nothing — silently, because
        // the trigger reads `!!live[k]` and an undefined key just skips.
        video: !!stages?.video,
        enhance: !!stages?.enhance,
      },
      plan: this.#plan(clean, t, c),
      cursor: 0,
      done: 0,
      failed: 0,
      files: [],
      state: scheduledAt === null ? "running" : "scheduled",
      note: null,
      createdAt: this.now(),
      startAt: scheduledAt,
      startedAt: scheduledAt === null ? this.now() : null,
      finishedAt: null,
    };
    const r = this.run;
    const saved = this.#save();
    if (scheduledAt !== null) {
      // A timer may be armed only after its frozen plan is safely on disk.
      saved.then(() => {
        if (this.run !== r || r.state !== "scheduled") return;
        if (this.persistenceError) this.pause("The schedule could not be saved. Check the folder and available space before starting.");
        else this.#armSchedule();
      });
    } else {
      this.#keepAwake(true);
      this.#next();
    }
    this.emit("update");
    return this.status();
  }

  /** Pause lets the song in flight finish, then stops. Killing a nearly-complete
   *  render to honour a pause would throw away minutes of GPU time for no reason;
   *  Stop is there for people who want it to end now. */
  pause(note) {
    if (!this.run || !["running", "scheduled"].includes(this.run.state)) return this.status();
    const wasScheduled = this.run.state === "scheduled";
    this.#cancelSchedule();
    this.run.state = "paused";
    this.run.note = note ?? (wasScheduled ? "Scheduled start paused. Press Resume to start now."
      : this.pendingJobId || this.pendingMusic ? "Finishing the current song, then pausing." : null);
    this.#keepAwake(false);
    this.#save();
    this.emit("update");
    return this.status();
  }

  resume() {
    if (!this.run || !["paused", "scheduled"].includes(this.run.state)) return this.status();
    // If a song was still finishing when we paused, it is already in flight and
    // will drive the next one itself. Enqueuing here would run two at once —
    // and the same is true of a picture or a clip mid-render.
    this.#begin();
    return this.status();
  }


  /**
   * Move a finished run into the history.
   *
   * Called from every terminal path. A summary rather than the whole object: the
   * plan and the per-song cursor are worthless once a run is over, while the
   * name, counts, timing and produced files are what anyone actually looks back
   * for. Capped, because this file is rewritten on every job transition.
   */
  #archive() {
    const r = this.run;
    if (!r || this.runs.some((x) => x.id === r.id)) return;
    this.runs.unshift({
      id: r.id, name: r.name, state: r.state,
      /* The history must say what each night MADE. Without the kind, an image
       * run and a music run are indistinguishable rows the morning after. */
      kind: r.kind || "music",
      done: r.done, failed: r.failed, planned: r.plan.length,
      takes: r.takes, stages: r.stages,
      ideas: r.items.map((i) => i.title || i.prompt?.slice(0, 60)).filter(Boolean).slice(0, 12),
      files: r.files.slice(0, 200),
      songs: (r.songs || []).map(song => ({ ...song, stages: { ...song.stages } })),
      createdAt: r.createdAt ?? r.startedAt, startAt: r.startAt ?? null,
      startedAt: r.startedAt, finishedAt: r.finishedAt || this.now(),
    });
    this.runs = this.runs.slice(0, 25);
  }

  stop() {
    this.#cancelSchedule();
    if (!this.run) return this.status();
    this.run.state = "stopped";
    this.run.finishedAt = this.now();
    this.#archive();
    // Drop our claim on the job BEFORE cancelling, so the resulting "cancelled"
    // transition is not mistaken for the user cancelling a song mid-run (which
    // pauses instead of stopping).
    const inFlight = this.pendingJobId;
    this.pendingJobId = null;
    // Stop has to mean stop. Leaving the current song to finish would keep the
    // GPU busy for minutes after the button was pressed.
    //
    // Gating this on "was the run still running" was wrong: pausing then stopping
    // left the in-flight song rendering, because pause had already moved the state
    // off "running". Whether a job is actually in flight is the only thing that
    // matters, and the identity check below is what answers that.
    if (inFlight && this.jobs.cancelById) {
      Promise.resolve(this.jobs.cancelById(inFlight)).catch(() => {});
    } else if (inFlight && this.jobs.current?.id === inFlight) {
      Promise.resolve(this.jobs.cancel()).catch(() => {});
    }
    this.#keepAwake(false);
    this.#save();
    this.emit("update");
    return this.status();
  }

  /**
   * Called whenever the post-processing queue changes.
   *
   * The sleep lock outlives the music by design, so something has to notice when
   * the tail of the pipeline finally empties. Cheap and idempotent.
   */
  checkAwake() {
    if (!this.awake) return;
    const r = this.run;
    const live = r && (r.state === "running" || r.state === "paused");
    if (!live && !this.postBusy()) this.#keepAwake(false);
  }

  clear() {
    this.#cancelSchedule();
    if (this.run && ["running", "paused", "scheduled"].includes(this.run.state)) this.stop();
    // Archive whatever is being cleared, so "clear" tidies the panel rather than
    // erasing the record of a night's work.
    this.#archive();
    this.run = null;
    this.#save();
    this.emit("update");
    return this.status();
  }

  // ---- driving ------------------------------------------------------------

  #next() {
    const r = this.run;
    if (!r || r.state !== "running" || this.pendingJobId || this.pendingMedia || this.pendingMusic) return;
    if (r.cursor >= r.plan.length) {
      r.state = "done";
      r.finishedAt = this.now();
      this.#archive();
      this.pendingJobId = null;
      this.pendingMedia = false;
      // Hold the machine awake until the covers, stems, lyrics and clips this
      // run asked for have actually drained. checkAwake() releases it.
      if (!this.postBusy()) this.#keepAwake(false);
      this.#save();
      this.emit("update");
      return;
    }

    const step = r.plan[r.cursor];
    const item = r.items[step.item];

    /* MEDIA RUNS drain the same plan and differ only in what one step asks for.
     *
     * A music step is enqueued and the cursor advances off the job runner's
     * event; a picture or a clip has no such event here, so the step is awaited
     * and advances itself. Everything else — cap, takes, pause, stop, archive,
     * the sleep lock — is the shared machinery above and below this branch.
     *
     * The prompt is expanded PER TAKE by the renderer, so ten takes of one idea
     * are ten different pictures rather than one picture ten times. */
    if (r.kind !== "music") {
      this.pendingMedia = true;
      const label = item.title || item.prompt.slice(0, 48);
      r.note = r.takes > 1 ? `${label} · take ${step.take + 1}` : label;
      this.emit("update");
      Promise.resolve()
        .then(() => this.renderMedia(r.kind, item, step.take, r.actor))
        .then((made) => {
          for (const f of [].concat(made || [])) if (f) r.files.push(f);
          r.done++;
        })
        .catch((err) => {
          r.failed++;
          /* A failed step must not end the night. One bad prompt out of forty
           * is not a reason to stop the other thirty-nine, and the message is
           * kept so the morning says which. */
          r.note = `${item.title || item.prompt.slice(0, 40)}: ${String(err.message || err).slice(0, 160)}`;
        })
        .finally(() => {
          this.pendingMedia = false;
          r.cursor++;
          this.#save();
          this.emit("update");
          /* A pause taken mid-render is honoured HERE rather than by killing the
           * render — the same rule music follows, and for the same reason: the
           * GPU time is already spent. */
          if (r.state === "running") this.#next();
          else if (r.state === "paused") { this.#keepAwake(false); this.emit("update"); }
        });
      return;
    }

    const request = {
      ...item,
      title: r.takes > 1 ? `${item.title} · take ${step.take + 1}` : item.title,
      // A fresh performance every take. Reusing the seed and varying only the mix
      // would return near-identical songs, which is the opposite of the point.
      seed: Math.floor(Math.random() * 4294967296),
      batchId: r.id,
      actor: r.actor,
      paidConfirmed: r.paidConfirmed === true,
      /* The stage chain travels WITH the job.
       *
       * index.js used to read it back off the live run when a song landed — but
       * both listeners are on the same emitter and this one registers first, so
       * by the time index.js looked, the LAST song of every run had already
       * flipped the run to "done" and `live` was null. Every overnight run was
       * silently missing one song's stems, lyrics and clip. Carrying the chain
       * on the job removes the ordering dependency rather than reordering it. */
      stages: { ...r.stages },
    };
    const submission = { run: r };
    this.pendingMusic = submission;
    Promise.resolve().then(() => {
      if (this.run !== r || r.state === "stopped") return null;
      return this.enqueueMusic(request);
    }).then((job) => {
      if (!job) return;
      if (!job.id) throw new Error("Studio did not acknowledge an overnight song.");
      if (this.run !== r || r.state === "stopped") {
        // Stop can happen while a cover is being prepared, before any job ID
        // exists. Cancel the returned ID, even when it is still queued.
        if (this.jobs.cancelById) return this.jobs.cancelById(job.id);
        if (this.jobs.current?.id === job.id) return this.jobs.cancel();
        return;
      }
      this.pendingMusic = null;
      this.pendingJobId = job.id;
      this.#save();
      this.emit("update");
      // An injected or very fast runner can finish before the door returns.
      // Its event arrived before pendingJobId existed, so reconcile once now.
      if (this.jobs.snapshot) this.#onJobUpdate(this.jobs.snapshot());
    }).catch((err) => {
      if (this.run !== r || r.state === "stopped") return;
      if (err?.definitelyNotQueued !== true && !this.directMusicEnqueue) {
        // A missing acknowledgement does not prove that the GPU job was never
        // queued. Keep this take in place and ask the person to inspect it.
        r.note = `Song submission could not be confirmed. Check the queue before resuming. ${String(err?.message || err).slice(0, 160)}`;
        if (r.state === "running") this.pause(r.note);
        else { this.#save(); this.emit("update"); }
        return;
      }
      r.failed++;
      r.cursor++;
      r.note = `${item.title}: ${String(err?.message || err).slice(0, 160)}`;
      this.#save();
      this.emit("update");
    }).finally(() => {
      if (this.pendingMusic === submission) this.pendingMusic = null;
      if (this.run?.state === "running" && !this.pendingJobId) this.#next();
    });
  }

  #onJobUpdate(snap) {
    const r = this.run;
    // Deliberately NOT gated on state === "running": a pause lets the song in
    // flight finish, and its result still has to be recorded. Skipping it here
    // would leave pendingJobId set, and resume would then enqueue a second song
    // alongside the one already rendering.
    if (!r || !this.pendingJobId) return;

    const finished = (snap.history || []).find((j) => j.id === this.pendingJobId);
    if (!finished) return;

    this.pendingJobId = null;
    if (finished.state === "done") {
      r.done++;
      if (finished.file) {
        r.files.push(finished.file);
        /* One row per produced song, carrying the chain that song was promised.
         * Taken from the JOB rather than from the run for the same reason the
         * chain itself is: by the time the last song lands, the run may already
         * have flipped to done. */
        (r.songs ||= []).push({
          file: finished.file,
          title: finished.title || finished.file,
          at: this.now(),
          costUsd: finished.costUsd ?? null,
          stages: expectedStages(finished.stages || r.stages, finished),
        });
      }
      r.cursor++;
    } else if (finished.state === "cancelled") {
      // Cancel is the "make it stop" button. Treating it as skip-one would mean
      // pressing it starts the next song immediately, which reads as broken.
      // (A batch Stop clears pendingJobId first, so it never lands here.)
      r.cursor++;
      this.#save();
      return void this.pause("Stopped at a song you cancelled.");
    } else {
      r.failed++;
      r.cursor++;
    }
    this.#save();
    this.emit("update");
    if (r.state === "running") this.#next();
  }

  /**
   * Record that a post-stage finished for one song.
   *
   * Called from index.js, which is the only place that hears the art runner.
   * batch.js still knows nothing about that runner — it is told, rather than
   * subscribing, so the two stay uncoupled.
   *
   * Searches the ARCHIVE as well as the live run: post-stages drain long after
   * the music finishes, so most of these arrive for a run that is already done,
   * which is exactly the state this display exists to make visible.
   */
  /**
   * Did the run that produced this file ask for this stage?
   *
   * Needed because one stage now chains off another's OUTPUT rather than off
   * the song, so the decision has to be readable later instead of only at the
   * moment the song finished.
   */
  wantsStage(file, kind) {
    // Same traversal as noteStage: the live run first, then the archive, because
    // a clip usually lands long after its run has finished.
    for (const run of [this.run, ...(this.runs || [])]) {
      if (!run?.songs) continue;
      if (run.songs.some((x) => x.file === file)) return !!(run.stages || {})[kind];
    }
    return false;
  }

  noteStage(file, kind, state = "done") {
    let touched = false;
    for (const run of [this.run, ...(this.runs || [])]) {
      if (!run?.songs) continue;
      const song = run.songs.find((x) => x.file === file);
      if (!song || !song.stages || !(kind in song.stages)) continue;
      song.stages[kind] = state;
      touched = true;
    }
    if (touched) { this.#save(); this.emit("update"); }
    return touched;
  }

  /** Stages that are owed but have not landed, across every run we remember. */
  outstanding() {
    let waiting = 0, failed = 0;
    const seen = new Set();
    for (const run of [this.run, ...(this.runs || [])]) {
      if (!run || seen.has(run.id)) continue;
      seen.add(run.id);
      for (const song of run?.songs || []) {
        for (const st of Object.values(song.stages || {})) {
          if (st === "waiting" || st === "running") waiting++;
          else if (st === "failed") failed++;
        }
      }
    }
    return { waiting, failed };
  }

  // ---- keep the machine awake --------------------------------------------

  #keepAwake(on) {
    if (this.keepAwake) { this.keepAwake(on); this.awake = on ? true : null; return; }
    if (on) {
      if (this.awake) return;
      try {
        this.awake = spawn(config.python, [path.join(__dirname, "keepawake.py")], {
          stdio: "ignore", windowsHide: true,
        });
        this.awake.on("exit", () => { this.awake = null; });
      } catch { this.awake = null; }
    } else if (this.awake) {
      try { this.awake.kill(); } catch { /* already gone */ }
      this.awake = null;
    }
  }

  // ---- reporting ----------------------------------------------------------

  status() {
    const r = this.run;
    /* The no-live-run case must STILL report what is outstanding. That is not an
     * edge case, it is the normal one: post-stages only touch the card once the
     * music queue is empty, so almost every cover, stem and clip lands after the
     * run that asked for it has finished and been archived. Returning early
     * without them meant the panel went blank exactly when there was something
     * to say. */
    if (!r) return { run: null, runs: this.runs, postStages: this.outstanding() };

    const total = r.plan.length;
    const attempted = r.done + r.failed;
    const left = Math.max(0, total - r.cursor);

    // Estimate from this run's own pace once there is one, because it is measured
    // on the actual card with the actual lyric lengths. Fall back to the cold
    // ratio for the first song only.
    let perSong = null;
    if (r.done > 0 && r.startedAt) {
      perSong = (this.now() - r.startedAt) / 1000 / r.done;
    } else {
      /* The cold guess is a SONG's. A picture is seconds and a clip is minutes,
       * so a media run that has not finished a step yet gets a number of the
       * right order instead of a song's three minutes. */
      perSong = r.kind === "image" ? 20 : r.kind === "video" ? 240 : 150 * config.speed.realtimeRatio;
    }
    const secondsLeft = ["running", "paused", "scheduled"].includes(r.state)
      ? Math.round(left * perSong)
      : 0;

    const owed = this.outstanding();
    return {
      postStages: owed,
      runs: this.runs,
      run: {
        id: r.id, name: r.name, state: r.state, note: r.note, stages: r.stages,
        /* WHAT this run makes. A status that cannot say whether the night is
         * songs, pictures or clips is not a status. */
        /* ⚠ `system` for a run saved before this field existed. The panel shows
         * this line; back-filling "a person started this" onto a run nobody can
         * name is the same fabrication at the READ end (D1.0). */
        kind: r.kind || "music", actor: r.actor || "system",
        items: r.items.map((i) => ({
          title: i.title, caption: i.caption, instrumental: i.instrumental, engine: i.engine,
          /* Media items have a prompt where a song has a caption; the template
           * is shown UNEXPANDED, because that is what was asked for and each
           * take expands it differently. */
          prompt: i.prompt,
        })),
        takes: r.takes, cap: r.cap,
        total, done: r.done, failed: r.failed, attempted,
        currentIndex: Math.min(r.cursor, total - 1),
        currentItem: total
          ? (() => {
              const it = r.items[r.plan[Math.min(r.cursor, total - 1)].item];
              return it?.title || it?.prompt?.slice(0, 60) || null;
            })()
          : null,
        secondsLeft,
        // The one number that actually matters at bedtime.
        etaAt: secondsLeft ? (r.state === "scheduled" ? r.startAt : this.now()) + secondsLeft * 1000 : null,
        createdAt: r.createdAt ?? r.startedAt, startAt: r.startAt ?? null,
        startedAt: r.startedAt, finishedAt: r.finishedAt,
        files: r.files.slice(-200),
        /* One row per produced song, carrying the chain it was promised. The
         * headline done/total counts MUSIC only; these are what is still owed
         * after the singing stops, which is where an overnight run really ends. */
        songs: (r.songs || []).slice(-200),
        keepingAwake: Boolean(this.awake),
      },
    };
  }
}
