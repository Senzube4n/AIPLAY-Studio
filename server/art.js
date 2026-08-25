/**
 * Cover art — an IDLE-DRAIN queue, deliberately.
 *
 * Art must never make anyone wait for music. That is the whole design
 * constraint, and it is stronger than it first looks on a 16 GB card:
 *
 *   the music stack is ~14.1 GB resident (DiT fp16 4.91 + text encoder int8
 *   9.20), so there is NO headroom for the image models at any quantisation.
 *   Generating a cover always evicts the music models, and the next song then
 *   pays ~15 s to load them back.
 *
 * So the trigger is "the music queue is empty", not "a song finished". Ten
 * covers drained one-per-song is ten evictions; ten covers drained in one pass
 * is one. Measured: 22.8 s for the first image (cold, loading 12.4 GB of
 * weights) against 3.3 s each once resident — so batching is worth roughly 4x
 * on an overnight run, which is the case that matters most.
 *
 * A new music job preempts: the current image finishes (it is ~3 s, not worth
 * interrupting) and then the runner yields and waits for idle again.
 */
import { EventEmitter } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import { mkdir, rename, readdir, stat, writeFile, readFile, unlink } from "node:fs/promises";
import zlib from "node:zlib";
import path from "node:path";
import { config } from "./config.js";
import { coverGraph, coverPrompt, COVER_NODES, ideogramGraph, ideogramPassSeeds, checkpointGraph, videoGraph, videoPrompt, alignFrames, videoEngine, enhanceGraph, restyleGraph } from "./workflow.js";
import { buildCustom, assignedTo } from "./customWorkflows.js";

/**
 * Fold the track's filename into its seed.
 *
 * 🔑 NOT cosmetic — without this the whole feature silently loses most of its
 * output. ComfyUI caches by graph, and a graph is (prompt, seed): 11 tracks in
 * the test library shared `seed 0` with an empty caption and another 5 shared a
 * seed AND a boilerplate caption, so 16 of 48 produced byte-identical graphs.
 * Every duplicate was served from cache, returning the filename of an image the
 * FIRST job had already moved into covers/ — so the rename failed and the job
 * finished having written nothing, with no error anywhere.
 *
 * Deriving from the filename keeps a cover reproducible from the track's own
 * identity (same track, same picture, forever) while guaranteeing distinct
 * graphs. FNV-1a, because it only has to be stable and well-spread.
 */
function mixSeed(seed, file) {
  let h = 0x811c9dc5;
  const s = `${seed}:${file}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const COVER_DIR = path.join(config.outputDir, "covers");
/* Standalone images — the ones asked for on the Images screen rather than drawn
 * for a track. Kept apart from covers because a cover is named after its song
 * and deleted with it, while these belong to nobody and outlive everything. */
const IMAGE_DIR = path.join(config.outputDir, "images");
// Timed lyrics sit beside the covers rather than next to the audio, so the
// library scan never has to filter them out of the track listing.
const LRC_DIR = path.join(config.outputDir, "lyrics");
// Clips live beside the covers for the same reason: the library scan looks for
// audio in the output root and must not trip over an mp4.
const CLIP_DIR = path.join(config.outputDir, "clips");
// ComfyUI writes SaveImage output relative to its own output folder, so the
// prefix carries the subfolder and the files land in COVER_DIR directly.
const PREFIX = "covers/cover";


/**
 * Luma variance of a PNG, no dependencies — a minimal reader for exactly what
 * SaveImage writes (8-bit, non-interlaced). Exists for one reason: Ideogram 4's
 * open weights render a trained-in "blocked by safety filter" card, and WHICH
 * seeds fall into that basin is random — the same innocent prompt renders on
 * one seed and refuses on the next. The card is near-uniform gray
 * (variance ~35 on a thumb; any real image is hundreds to thousands), so it is
 * cheap to detect and retry.
 */
function pngLumaVariance(buf) {
  try {
    if (buf.readUInt32BE(12) !== 0x49484452) return null;
    const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
    const bitDepth = buf[24], colorType = buf[25], interlace = buf[28];
    if (bitDepth !== 8 || interlace !== 0) return null;
    const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
    if (!channels) return null;
    let off = 8;
    const idat = [];
    while (off + 12 <= buf.length) {
      const len = buf.readUInt32BE(off), type = buf.toString("ascii", off + 4, off + 8);
      if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
      if (type === "IEND") break;
      off += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const px = Buffer.alloc(stride * height);
    const paeth = (a, b, c) => {
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    for (let y = 0; y < height; y++) {
      const f = raw[y * (stride + 1)];
      const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      const out = px.subarray(y * stride, (y + 1) * stride);
      const prev = y ? px.subarray((y - 1) * stride, y * stride) : null;
      for (let x = 0; x < stride; x++) {
        const a = x >= channels ? out[x - channels] : 0;
        const b = prev ? prev[x] : 0;
        const c = x >= channels && prev ? prev[x - channels] : 0;
        let v = row[x];
        if (f === 1) v += a; else if (f === 2) v += b;
        else if (f === 3) v += (a + b) >> 1; else if (f === 4) v += paeth(a, b, c);
        out[x] = v & 0xff;
      }
    }
    let n = 0, sum = 0, sum2 = 0;
    for (let y = 0; y < height; y += 4) for (let x = 0; x < width; x += 4) {
      const i = y * stride + x * channels;
      const l = channels >= 3 ? (px[i] * 3 + px[i + 1] * 4 + px[i + 2]) >> 3 : px[i];
      n++; sum += l; sum2 += l * l;
    }
    const mean = sum / n;
    return sum2 / n - mean * mean;
  } catch { return null; }
}

export class ArtRunner extends EventEmitter {
  /**
   * @param {import("./comfy.js").ComfySupervisor} comfy
   * @param {import("./jobs.js").JobRunner} jobs   consulted for idleness only
   */
  constructor(comfy, jobs) {
    super();
    this.comfy = comfy;
    this.jobs = jobs;
    this.queue = [];
    this.current = null;
    this.done = [];
    this.lastError = null;
    this.enabled = config.art.enabled;
    this.paused = false;
    this.#timer = null;

    /* Post-processing gets its OWN websocket and client id.
     *
     * ComfyUI addresses progress to the client that submitted the prompt, and
     * these jobs were submitted with none — so a 40-second clip render reported
     * nothing at all while the music queue, which does have one, showed a
     * per-step bar. Sharing the job runner's connection would not work either:
     * its handler drops every message when no MUSIC job is current. */
    this.clientId = randomUUID();
    this.progress = 0;
    this.startedAt = null;
    this.#ws = null;
  }

  #ws;

  /** Idempotent, lazy, and never fatal — progress is a nicety, not the work. */
  #connect() {
    if (this.#ws && this.#ws.readyState <= 1) return;
    try {
      const ws = new WebSocket(
        `ws://${config.comfy.host}:${config.comfy.port}/ws?clientId=${this.clientId}`);
      ws.on("message", (raw, isBinary) => {
        if (isBinary || !this.current) return;
        let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
        const { type, data = {} } = msg;
        if (type !== "progress" && type !== "progress_state") return;
        const value = data.value ?? Object.values(data.nodes || {})[0]?.value;
        const max = data.max ?? Object.values(data.nodes || {})[0]?.max ?? 1;
        /* ⚠ IGNORE SINGLE-STEP NODES.
         *
         * ComfyUI emits progress for every node, and the loaders and encoders
         * report 1/1 the instant they finish — so the bar shot to 100%, sat
         * there through the whole model load, then dropped back to 12% when the
         * sampler finally started. Only a node with more than one step is
         * reporting work you can actually watch. */
        if (typeof value === "number" && max > 1) {
          this.progress = Math.max(0, Math.min(1, value / max));
          this.emit("update");
        }
      });
      ws.on("error", () => {});
      ws.on("close", () => { this.#ws = null; });
      this.#ws = ws;
    } catch { /* progress is optional */ }
  }

  #timer;

  /** True when nothing musical is running or waiting. */
  get idle() {
    return this.comfy.ready && !this.jobs.current && this.jobs.queue.length === 0;
  }

  status() {
    return {
      art: {
        enabled: this.enabled,
        paused: this.paused,
        queued: this.queue.length,
        // `kind` is reported so the UI can name the stage that is actually
        // running. Without it the status line said "Drawing a cover for X"
        // while the queue was separating stems or rendering a 30 s clip.
        current: this.current && {
          file: this.current.file, title: this.current.title, kind: this.current.kind,
          // Real per-step progress from the engine, not a timer.
          progress: this.progress,
          elapsed: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
        },
        queuedKinds: this.queue.reduce((m, j) => (m[j.kind] = (m[j.kind] || 0) + 1, m), {}),
        lastError: this.lastError,
      },
    };
  }

  /**
   * Ask for a cover. Cheap and idempotent — a track already queued or already
   * carrying art is skipped, so this can be called from any code path that
   * notices a finished song without deduplicating first.
   */
  /**
   * Ask for a piece of post-processing.
   *
   * `kind` decides what runs — "cover" draws artwork, "stems" separates the
   * track. They share this queue rather than having one each because they share
   * the constraint that matters: both need the GPU, and neither may ever make
   * someone wait for music. One queue means one idleness rule and one place
   * where music preempts.
   */
  request({ file, caption, title, seed, lyrics, kind = "cover", force = false, video }) {
    if (!file) return null;
    /* `enabled` is the COVER ART setting, and it used to gate every kind.
     *
     * That made one dropdown labelled "Cover art" a silent master switch over
     * stems, timed lyrics and video: turning it off made all four stages
     * enqueue nothing while every trigger still returned ok, so the Overnight
     * checkboxes and the row actions reported success and produced no files.
     * Each kind now answers for itself; the queue is still shared, because what
     * they share is the GPU and the rule that music always preempts. */
    if (kind === "cover" && !this.enabled) return null;
    if (!force && this.queue.some((j) => j.file === file && j.kind === kind)) return null;
    const job = {
      id: randomUUID().slice(0, 8),
      kind,
      file,
      title: title || file,
      caption: caption || "",
      lyrics: lyrics || "",
      /* Covers MIX the seed with the file name on purpose — one seed across a
       * whole library must not paint the same art on every song. A VIDEO job
       * must not: its file is a unique timestamp id (`clip:v…`), so mixing
       * makes the typed seed a lie — the recorded seed could never reproduce
       * the clip, because re-submitting it mixed against a NEW id. The route
       * always supplies a concrete seed for clips (explicit or rolled), so
       * verbatim is both honest and sufficient. */
      seed: kind === "video" && Number.isFinite(seed) ? Number(seed)
        : Number.isFinite(seed) ? mixSeed(seed, file) : mixSeed(0, file),
      count: 1,
      // Everything a hand-authored clip needs. Spread rather than listed field by
      // field BECAUSE an explicit whitelist here is exactly what silently dropped
      // audioRef in jobs.js and the video stage in batch.js — the caller already
      // validated this object, and adding a knob should not need three edits.
      ...(video || {}),
    };
    this.queue.push(job);
    this.emit("update");
    this.#schedule();
    return job;
  }

  #schedule() {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#drain().catch((err) => {
        this.lastError = String(err.message || err);
        this.emit("update");
      });
    }, 1200);
  }

  /**
   * Drain the whole queue in one pass while the GPU is free.
   *
   * Re-checks `idle` between every image rather than only at the top: an
   * overnight batch can enqueue a song at any moment, and the point of this
   * runner is that music always wins.
   */
  async #drain() {
    if (this.current || this.paused || !this.enabled) return;
    if (this.queue.length === 0) return;
    if (!this.idle) return this.#schedule();      // music is busy; check back

    while (this.queue.length) {
      if (!this.idle || this.paused) break;       // yield to music
      const job = this.queue.shift();
      this.current = job;
      this.progress = 0;
      this.startedAt = Date.now();
      this.#connect();
      this.emit("update");
      try {
        if (job.kind === "stems") {
          const stems = await this.#separate(job);
          job.stems = stems;
          this.done.unshift(job);
          this.emit("stems", { file: job.file, stems });
        } else if (job.kind === "video") {
          const clip = await this.#clip(job);
          job.clip = clip;
          this.done.unshift(job);
          // How long it actually took. Guesswork about render cost is the single
          // most common question about a 40-second job, and the app knows.
          /* Everything needed to make this clip AGAIN.
           *
           * Music has carried its prompt, seed and settings since the beginning
           * — that is what makes "reuse prompt" and "re-roll" possible. Clips
           * stored only their render time, so a clip you liked was a dead end:
           * no way to vary it, and no way for a timeline to re-roll one in
           * place. Same idea, same reason. */
          this.emit("clip", {
            file: job.file, clip,
            seconds: Math.round((Date.now() - this.startedAt) / 1000),
            meta: {
              engine: job.engine || config.video.engine,
              /* ⚠ `prompt` was a BARE IDENTIFIER here with no binding in this
               * scope. The resolved prompt is a local inside #clip, not a
               * field on the job, so evaluating this object threw
               * `ReferenceError: prompt is not defined` — AFTER the render had
               * finished and the file had already been moved into the clip
               * folder.
               *
               * That made it invisible for months: the Video grid lists the
               * DIRECTORY, so the clip appeared and looked fine, while
               * everything the event was supposed to do was skipped — the clip
               * was never written into its song's sidecar, never recorded a
               * render time or a prompt, and an Overnight run's video row sat
               * at "waiting" forever with the finished clip sitting on disk.
               *
               * Present since the first public commit. #clip now records what
               * it actually rendered on the job. */
              prompt: job.usedPrompt ?? null, seed: job.seed,
              width: job.width, height: job.height,
              clipSeconds: job.seconds, steps: job.steps,
              firstFrame: job.firstFrame || null, loop: !!job.loop,
              // What the prompt's <Picture n> / <Audio n> tags pointed at, so a
              // liked clip can be re-rolled with the same references.
              refImages: job.refImages?.length ? job.refImages : null,
              refAudios: job.refAudios?.length ? job.refAudios : null,
              audioTrack: job.audioTrack || null,
              negative: job.negative || null,
              guidance: job.guidance ?? null, guideStrength: job.guideStrength ?? null,
              at: Date.now(),
            },
          });
        } else if (job.kind === "restyle") {
          const clip = await this.#restyle(job);
          job.clip = clip;
          this.done.unshift(job);
          this.emit("restyled", {
            source: job.file, clip, owner: job.owner || null,
            seconds: Math.round((Date.now() - this.startedAt) / 1000),
            meta: {
              source: "restyle", from: job.file, prompt: job.prompt,
              guideEvery: job.guideEvery, strengths: job.strengths || null,
              width: job.width || null, height: job.height || null,
              clipSeconds: job.seconds || null,
              at: Date.now(),
            },
          });
        } else if (job.kind === "enhance") {
          const clip = await this.#enhance(job);
          job.clip = clip;
          this.done.unshift(job);
          this.emit("enhanced", {
            source: job.file, clip, owner: job.owner || null,
            seconds: Math.round((Date.now() - this.startedAt) / 1000),
            meta: {
              source: "enhance", from: job.file,
              interpolate: job.interpolate || null,
              upscale: job.upscale || null,
              /* The RESULT's own shape, not the source's. Without this an
               * enhanced clip reports the dimensions it came from, and
               * enhancing it a second time estimates memory against a picture
               * a quarter of its real size — which is the one direction the
               * estimate must never be wrong in. */
              width: Math.round((job.srcWidth || 0) * (job.upscale?.scale || 1)) || null,
              height: Math.round((job.srcHeight || 0) * (job.upscale?.scale || 1)) || null,
              clipSeconds: job.interpolate?.slow
                ? (job.srcSeconds || 0) * (job.interpolate.multiplier || 1)
                : (job.srcSeconds || null),
              at: Date.now(),
            },
          });
        } else if (job.kind === "lrc") {
          const info = await this.#timeLyrics(job);
          this.done.unshift(job);
          this.emit("lrc", { file: job.file, ...info });
        } else {
          const { covers, thumbs } = await this.#render(job);
          job.covers = covers;
          this.done.unshift(job);
          this.emit("cover", { file: job.file, covers, thumbs, seed: job.seed,
                               durationMs: job.startedAt ? Date.now() - job.startedAt : null,
                               engine: job.engine || "flux2" });
        }
      } catch (err) {
        this.lastError = `${job.title}: ${String(err.message || err)}`;
        console.error(`  [${job.kind}] ${this.lastError}`);
        /* ⚠ Announce the failure, or an Overnight row waits forever.
         *
         * Every stage is ticked off from its SUCCESS event — `clip`, `stems`,
         * `lrc`, `cover`. A job that throws emits none of them, so the run's
         * row kept saying "waiting" with nothing left that could ever change
         * it. Indistinguishable, at a glance, from a job still in the queue.
         *
         * `owner` is carried by enhance jobs because their row belongs to the
         * SONG while the job itself is about a clip. */
        this.emit("failed", {
          file: job.file, kind: job.kind, owner: job.owner || null,
          error: String(err.message || err),
        });
      } finally {
        this.current = null;
        this.progress = 0;
        this.startedAt = null;
        this.emit("update");
      }
    }
    if (this.queue.length) this.#schedule();      // yielded early; resume later
  }

  async #render(job) {
    /* Two callers, same engine.
     *
     * A cover derives its prompt from the song and is named after it. A
     * standalone image carries its own prompt and its own id — same shape as
     * the `clip:` pseudo-file that standalone clips already use, so there is
     * one convention rather than two. */
    const standalone = job.file.startsWith("image:");
    const outDir = standalone ? IMAGE_DIR : COVER_DIR;
    await mkdir(outDir, { recursive: true });
    // Seed goes in too: captionless tracks pick their subject from it, so that a
    // library of untitled takes gets sixteen different objects rather than one.
    // The Images screen owns its prompt; a cover has one derived for it.
    const prompt = standalone
      ? job.prompt
      : coverPrompt({ caption: job.caption, title: job.title, seed: job.seed });
    /* A custom graph replaces the built-in one entirely.
     *
     * If it fails to load we fall back to the built-in rather than failing the
     * job: a cover is a nice-to-have that runs unattended overnight, and losing
     * an entire batch's art to one bad JSON file would be a poor trade. The
     * reason is logged where it will be read. */
    let graph = null;
    const customCover = assignedTo("cover");
    if (customCover) {
      try {
        graph = await buildCustom(customCover, {
          prompt, seed: job.seed,
          // Covers are square; `size` is the one dimension config carries.
          width: config.art.size, height: config.art.size,
          filename: PREFIX,
        });
      } catch (err) {
        console.warn(`[art] custom cover workflow "${customCover}" did not load (${err.message}) — using the built-in graph`);
      }
    }
    /* Engine choice: a standalone image carries its own pick; a COVER follows
     * the library-wide default in Settings, so a whole library can be painted
     * by Ideogram or by the user's own checkpoint. */
    const engine = standalone ? (job.engine || "flux2") : (config.art.engine || "flux2");
    const ckpt = job.checkpoint || config.art.checkpoint;
    if (!graph && engine === "ideogram4") {
      /* Noise-locked model: only seeds from the pass list render (see
       * workflow.js). A requested seed outside the list would buy the refusal
       * card, so it is swapped for a passing one and the SWAP is what gets
       * recorded — the recorded seed is always the one that painted. */
      const ladder = ideogramPassSeeds();
      if (!ladder.includes(job.seed)) job.seed = ladder[(job._ideoTry || 0) % ladder.length];
      graph = ideogramGraph({ prompt, seed: job.seed, width: job.width, height: job.height,
                              quality: job.quality || config.art.quality, count: job.count,
                              prefix: PREFIX });
    } else if (!graph && engine === "checkpoint" && ckpt) {
      graph = checkpointGraph({ ckpt, prompt, negative: job.negative,
                                seed: job.seed, width: job.width, height: job.height,
                                steps: standalone ? job.steps : 28, cfg: job.cfg, count: job.count,
                                prefix: PREFIX });
    }
    if (!graph) {
      graph = coverGraph({
        prompt,
        seed: job.seed,
        count: job.count,
        /* ⚠ The route accepted width/height/steps from day one and this call
         * never forwarded them — the same silent field-drop that ate midFrames
         * and the MCP first_frame. Every Images-screen size choice rendered at
         * the config default until now. */
        width: job.width,
        height: job.height,
        steps: job.steps,
        // Reference images for FLUX in-context editing — see coverGraph.
        refImages: job.refImages,
        prefix: PREFIX,
      });
    }

    const base = `http://${config.comfy.host}:${config.comfy.port}`;
    const r = await fetch(`${base}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: this.clientId }),
    });
    if (!r.ok) throw new Error((await r.text()).slice(0, 300));
    const { prompt_id } = await r.json();

    // Poll history rather than sharing the job runner's websocket. Art progress
    // is not worth showing per-step — it is three seconds — and a second
    // consumer on that socket would have to filter every music event.
    const deadline = Date.now() + 180_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((s) => setTimeout(s, 400));
      const h = await (await fetch(`${base}/history/${prompt_id}`)).json();
      const e = h[prompt_id];
      if (!e) continue;
      if (e.status?.status_str === "error") {
        throw new Error(JSON.stringify(e.status.messages || "").slice(0, 300));
      }
      if (e.status?.completed) {
        // Keyed by NODE, never by position in a flattened list: the graph has two
        // SaveImage nodes and with count > 1 their outputs interleave, so
        // "first N are the covers" is wrong the moment takes are batched.
        const pick = (node) => e.outputs?.[node]?.images || [];
        const fullImgs = pick(COVER_NODES.full);
        const thumbImgs = pick(COVER_NODES.thumb);
        if (!fullImgs.length) throw new Error("engine returned no image");

        // Name the files after the TRACK, so the pairing survives the sidecar
        // being lost and is obvious to anyone looking in Explorer.
        // `image:abc` would put a colon in a filename, which Windows refuses.
        const stem = standalone
          ? job.file.slice(6)
          : job.file.replace(/\.(flac|mp3|opus|wav)$/i, "");
        const move = async (list, suffix) => {
          const names = [];
          for (let i = 0; i < list.length; i++) {
            const src = path.join(config.outputDir, list[i].subfolder || "", list[i].filename);
            const name = `${stem}${list.length > 1 ? `_${i + 1}` : ""}${suffix}.png`;
            // Throw rather than falling back to ComfyUI's own filename. The
            // fallback looked defensive but recorded a path that does not exist
            // once the file has been moved, which is exactly how the cache-hit
            // bug stayed invisible: 16 tracks "succeeded" and wrote nothing.
            await rename(src, path.join(outDir, name));
            names.push(name);
          }
          return names;
        };
        const result = { covers: await move(fullImgs, ""), thumbs: await move(thumbImgs, "_t") };
        /* Ideogram's refusal card is SEED-dependent (measured: the same prompt
         * renders on one seed and refuses on the next), so a card here usually
         * means an unlucky seed, not a bad prompt. Two fresh seeds; if all
         * three refuse, the card is kept so a real refusal stays visible. */
        if (engine === "ideogram4" && result.thumbs[0]) {
          const v = pngLumaVariance(await readFile(path.join(outDir, result.thumbs[0])).catch(() => Buffer.alloc(0)));
          if (v !== null && v < 120) {
            const attempt = (job._ideoTry || 0) + 1;
            const ladder = ideogramPassSeeds();
            if (attempt <= Math.min(3, ladder.length)) {
              console.warn(`  [image] ideogram card on pass-seed ${job.seed} — trying the next known-good seed (${attempt})`);
              job._ideoTry = attempt;
              job.seed = ladder[attempt % ladder.length];
              return await this.#render(job);
            }
            console.warn("  [image] ideogram drew the card on every known-good seed — this prompt itself is refused");
          }
        }
        return result;
      }
    }
  }

  /**
   * A short looping clip to sit under a finished track.
   *
   * Same idle-drain rule as everything else here, and it matters more for this
   * one: the H3 stack is ~29 GB and evicting the music engine for it is the most
   * expensive swap the app can make. Never while music is queued.
   */
  async #clip(job) {
    await mkdir(CLIP_DIR, { recursive: true });
    /* Two callers, two shapes.
     *
     * A clip queued AFTER A SONG describes itself from that song's caption and
     * takes every default. A clip asked for in the Video screen carries its own
     * prompt, size, length and first frame — so anything the job supplies wins,
     * and only what it leaves out is derived. */
    const prompt = job.prompt
      || videoPrompt({ caption: job.caption, title: job.title, seed: job.seed });
    /* Kept ON THE JOB, because the completion event is emitted by the runner
     * loop rather than from in here, and "what was actually rendered" is not
     * derivable from the job alone once a caption has been turned into a
     * prompt. This is what the event reads. */
    job.usedPrompt = prompt;
    let graph = null;
    const customVideo = assignedTo("video");
    if (customVideo) {
      try {
        graph = await buildCustom(customVideo, {
          prompt, negative: job.negative, seed: job.seed,
          width: job.width, height: job.height,
          length: alignFrames(job.seconds ?? config.video.seconds,
                              videoEngine(job.engine || config.video.engine).fps,
                              job.engine || config.video.engine),
          filename: "clips/clip",
        });
      } catch (err) {
        console.warn(`[art] custom video workflow "${customVideo}" did not load (${err.message}) — using the built-in graph`);
      }
    }
    if (!graph) graph = videoGraph({
      // Which engine. Carried on the job so a clip queued while LTX was selected
      // still renders with LTX even if the setting changed while it waited.
      engine: job.engine || config.video.engine,
      prompt, seed: job.seed, prefix: "clips/clip",
      seconds: job.seconds, width: job.width, height: job.height, steps: job.steps,
      firstFrame: job.firstFrame, lastFrame: job.lastFrame, loop: job.loop,
      // Waypoints. Without this line the route stages the pictures, the job
      // carries them, and the graph never sees one -- silently.
      midFrames: job.midFrames,
      // References (<Picture n> / <Audio n> in the prompt) — H3's ref2va path.
      refImages: job.refImages,
      refAudios: job.refAudios,
      // Soundtrack — LTX's frozen-audio path: the clip is generated ON it.
      audioTrack: job.audioTrack,
      negative: job.negative, guidance: job.guidance, guideStrength: job.guideStrength,
      // A clip under a song has that song's audio; a standalone one has nothing,
      // so H3's own audio is the only thing it could ever play.
      keepAudio: job.keepAudio ?? !job.file.startsWith("clip:"),
    });

    const base = `http://${config.comfy.host}:${config.comfy.port}`;
    const r = await fetch(`${base}/prompt`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: this.clientId }),
    });
    if (!r.ok) throw new Error((await r.text()).slice(0, 300));
    const { prompt_id } = await r.json();

    // Generous: a clip is ~25 s warm but the first one after a music render pays
    // to load 29 GB of weights back in.
    /* Scaled to the job, not a flat 15 minutes.
     *
     * The fixed 900 s was fine for the old 864x480 x 56-frame default. At native
     * size, 124 frames and 20 steps a COLD render is ~200 s of model load plus
     * ~660 s of sampling — and a real user job ("dancing girl") hit the ceiling
     * and was killed after eleven minutes of GPU time had already been spent.
     * A deadline exists to catch a hang, so it has to sit well above the honest
     * worst case rather than just above the old one. */
    /* Per ENGINE. Both halves of this were H3-only and both were wrong for LTX:
     *   - alignFrames defaults to H3's n mod 17 == 5, so the deadline was sized
     *     from a frame count the LTX graph never renders;
     *   - the cost curve is fitted to H3, and LTX has no single `steps` at all
     *     (its step count is baked into two literal sigma strings), so scaling
     *     by job.steps/8 is meaningless there. */
    const engine = job.engine || config.video.engine;
    const v = { ...config.video, ...videoEngine(engine) };
    const px = (job.width ?? v.width) * (job.height ?? v.height);
    const frames = alignFrames(job.seconds ?? v.seconds, v.fps, engine);
    const stepScale = engine === "ltx" ? 1 : (job.steps ?? v.steps) / 8;
    const expected = v.costFixedSeconds
      + v.costRate * Math.pow((px * frames) / 1e6, v.costExponent) * stepScale;
    // 4x the estimate plus five minutes for a cold model load. Generous on
    // purpose: killing a nearly-finished render wastes everything spent on it.
    const deadline = Date.now() + Math.max(900_000, (expected * 4 + 300) * 1000);
    for (;;) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((s) => setTimeout(s, 1000));
      const h = await (await fetch(`${base}/history/${prompt_id}`)).json();
      const e = h[prompt_id];
      if (!e) continue;
      if (e.status?.status_str === "error") {
        throw new Error(JSON.stringify(e.status.messages || "").slice(0, 300));
      }
      if (e.status?.completed) {
        // SaveVideo reports under `images` with animated:true, not a `videos` key.
        const outs = Object.values(e.outputs || {}).flatMap((o) => o.images || o.videos || []);
        if (!outs.length) throw new Error("engine returned no clip");
        const src = path.join(config.outputDir, outs[0].subfolder || "", outs[0].filename);
        /* Standalone clips have no track to be named after, so they carry a
         * `clip:<id>` pseudo-file. Naming them after that keeps one flat folder
         * and one naming rule for both kinds. */
        const stem = job.file.startsWith("clip:")
          ? job.file.slice(5)
          : job.file.replace(/\.(flac|mp3|opus|wav)$/i, "");
        const name = `${stem}.mp4`;
        await rename(src, path.join(CLIP_DIR, name));
        return name;
      }
    }
  }

  /**
   * More frames, more pixels, or both — on a clip that already exists.
   *
   * Two things make this different from #clip. It reads a file rather than a
   * prompt, so the source has to be STAGED into ComfyUI's input directory
   * (`LoadVideo` reads nowhere else). And it is non-destructive: the output is a
   * new clip named for what was done to it, so the original survives an
   * upscale you end up not liking.
   */
  async #enhance(job) {
    await mkdir(CLIP_DIR, { recursive: true });
    const src = path.join(CLIP_DIR, path.basename(job.file));
    await stat(src);                                  // fail early, not mid-render

    /* Staged under a name derived from the SOURCE PATH — not from its bytes, so
     * re-running on the same clip reuses one staging file rather than accreting
     * one per attempt, and a clip name with anything awkward in it cannot reach
     * the graph. Safe because the file is rewritten on every call and removed in
     * `finally`; the hash is a stable short handle, not a cache key. */
    const staged = `aiplay_enh_${createHash("sha1").update(src).digest("hex").slice(0, 10)}${path.extname(src)}`;
    await mkdir(config.inputDir, { recursive: true });
    await writeFile(path.join(config.inputDir, staged), await readFile(src));

    try {
      const graph = enhanceGraph({
        file: staged,
        interpolate: job.interpolate || null,
        upscale: job.upscale || null,
        keepAudio: job.keepAudio !== false,
        prefix: "clips/enh",
      });

      const base = `http://${config.comfy.host}:${config.comfy.port}`;
      const r = await fetch(`${base}/prompt`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: graph, client_id: this.clientId }),
      });
      if (!r.ok) throw new Error((await r.text()).slice(0, 300));
      const { prompt_id } = await r.json();

      /* Interpolation is roughly real time; upscaling is emphatically not, and
       * scales with pixels rather than seconds. Ten minutes plus a minute per
       * megapixel-second, floored at fifteen — the same generosity as #clip and
       * for the same reason: killing a nearly-finished job wastes all of it. */
      const px = (job.srcWidth || 1280) * (job.srcHeight || 704) / 1e6;
      const load = (job.srcSeconds || 10) * px
        * (job.upscale ? 12 : 1) * (job.interpolate?.multiplier || 1);
      const deadline = Date.now() + Math.max(900_000, (600 + load * 60) * 1000);

      for (;;) {
        if (Date.now() > deadline) throw new Error("timed out");
        await new Promise((s) => setTimeout(s, 1000));
        const h = await (await fetch(`${base}/history/${prompt_id}`)).json();
        const e = h[prompt_id];
        if (!e) continue;
        if (e.status?.status_str === "error") {
          throw new Error(JSON.stringify(e.status.messages || "").slice(0, 300));
        }
        if (e.status?.completed) {
          const outs = Object.values(e.outputs || {}).flatMap((o) => o.images || o.videos || []);
          if (!outs.length) throw new Error("engine returned no clip");
          const out = path.join(config.outputDir, outs[0].subfolder || "", outs[0].filename);

          /* Named for what was done, so the library reads as a list of versions
           * rather than a list of hashes. Collisions get a counter rather than
           * overwriting — enhancing the same clip twice at the same settings is
           * a re-roll, not a replacement. */
          const stem = path.basename(job.file).replace(/\.(mp4|webm)$/i, "");
          const bits = [];
          if (job.interpolate) bits.push(job.interpolate.slow ? "slowmo" : `${job.interpolate.multiplier}xfps`);
          if (job.upscale) bits.push(job.upscale.label || "upscaled");
          let name = `${stem}_${bits.join("_")}.mp4`;
          for (let i = 2; ; i++) {
            try { await stat(path.join(CLIP_DIR, name)); } catch { break; }
            name = `${stem}_${bits.join("_")}_${i}.mp4`;
          }
          await rename(out, path.join(CLIP_DIR, name));
          return name;
        }
      }
    } finally {
      // The staged copy is disposable and can be large; leaving it behind grows
      // ComfyUI's input folder by the size of every clip ever enhanced.
      await unlink(path.join(config.inputDir, staged)).catch(() => {});

      /* ⚠ Give the frames back, or one upscale costs the machine 15 GB for the
       * rest of the session.
       *
       * MEASURED: after a 2x upscale ComfyUI sat at 14.95 GB resident with an
       * EMPTY queue — its execution cache still holding the frame batch — and
       * 6 GB free was little enough that the browser's own renderer locked up.
       * `free_memory` alone took it to 0.37 GB.
       *
       * Deliberately NOT `unload_models`. That would evict the music engine
       * too, and this app exists around one long-lived warm process; the
       * enhance models are 22 MB and 67 MB, so there is nothing worth
       * reclaiming there anyway. */
      const base = `http://${config.comfy.host}:${config.comfy.port}`;
      await fetch(`${base}/free`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ free_memory: true }),
      }).catch(() => { /* best effort — never fail a finished job over cleanup */ });
    }
  }

  /**
   * Restyle an existing clip, keeping its motion.
   *
   * Same staging discipline as #enhance — LTX's `LoadVideo` reads ComfyUI's
   * input directory and nowhere else, so the source is copied in under a
   * derived name and removed afterwards.
   *
   * ⚠ No `/free` call at the end, unlike #enhance. That one holds a whole frame
   * batch at full size and measured 15 GB resident with an empty queue; this
   * runs entirely in latent space and does not. Freeing here would evict the
   * LTX weights and make the next restyle pay the load again.
   */
  async #restyle(job) {
    await mkdir(CLIP_DIR, { recursive: true });
    const src = path.join(CLIP_DIR, path.basename(job.file));
    await stat(src);                                  // fail early, not mid-render

    const staged = `aiplay_rs_${createHash("sha1").update(src).digest("hex").slice(0, 10)}${path.extname(src)}`;
    await mkdir(config.inputDir, { recursive: true });
    await writeFile(path.join(config.inputDir, staged), await readFile(src));

    try {
      const { graph } = restyleGraph({
        file: staged,
        prompt: job.prompt,
        negative: job.negative,
        seed: job.seed,
        width: job.width, height: job.height, seconds: job.seconds,
        guideEvery: job.guideEvery, guideStrength: job.guideStrength,
        strengths: job.strengths || null,
        prefix: "clips/rs",
      });

      const base = `http://${config.comfy.host}:${config.comfy.port}`;
      const r = await fetch(`${base}/prompt`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: graph, client_id: this.clientId }),
      });
      if (!r.ok) throw new Error((await r.text()).slice(0, 300));
      const { prompt_id } = await r.json();

      // Measured 130-235s for 121 frames depending on guide count. The floor is
      // generous for the same reason it is everywhere else here: killing a
      // nearly-finished render wastes all of it.
      const deadline = Date.now() + 1_800_000;
      for (;;) {
        if (Date.now() > deadline) throw new Error("timed out");
        await new Promise((s) => setTimeout(s, 1000));
        const h = await (await fetch(`${base}/history/${prompt_id}`)).json();
        const e = h[prompt_id];
        if (!e) continue;
        if (e.status?.status_str === "error") {
          throw new Error(JSON.stringify(e.status.messages || "").slice(0, 300));
        }
        if (e.status?.completed) {
          const outs = Object.values(e.outputs || {}).flatMap((o) => o.images || o.videos || []);
          if (!outs.length) throw new Error("engine returned no clip");
          const out = path.join(config.outputDir, outs[0].subfolder || "", outs[0].filename);
          const stem = path.basename(job.file).replace(/\.(mp4|webm)$/i, "");
          let name = `${stem}_restyled.mp4`;
          for (let i = 2; ; i++) {
            try { await stat(path.join(CLIP_DIR, name)); } catch { break; }
            name = `${stem}_restyled_${i}.mp4`;
          }
          await rename(out, path.join(CLIP_DIR, name));
          return name;
        }
      }
    } finally {
      await unlink(path.join(config.inputDir, staged)).catch(() => {});
    }
  }

  /**
   * Split a finished track into drums, bass, vocals and other.
   *
   * Runs demucs in the SYSTEM python rather than the ComfyUI venv. That is not
   * incidental: the venv is torch 2.13.0+cu130 and the engine's fused int8
   * kernels depend on that exact build, so letting pip resolve a second tool's
   * torch requirement in there risks a silently 5x slower app. Two environments,
   * one of which is allowed to change.
   *
   * FLAC output because stems are working material — you separate a track in
   * order to do something with it, and re-encoding lossy stems for editing is a
   * poor trade for a few megabytes. Measured: ~12 s for a 30 s track, four stems
   * totalling ~4 MB.
   */
  async #separate(job) {
    const src = path.join(config.outputDir, job.file);
    const outRoot = path.join(config.outputDir, "stems");
    await mkdir(outRoot, { recursive: true });

    const args = ["-m", "demucs", "-n", config.stems.model, "--flac", "-o", outRoot];
    if (config.stems.twoStems) args.push("--two-stems", "vocals");
    args.push(src);

    const code = await new Promise((resolve) => {
      const proc = spawn(config.systemPython, args, { windowsHide: true });
      let err = "";
      proc.stderr.on("data", (d) => (err += d));
      proc.on("exit", (c) => { if (c) console.error(`  [stems] ${err.slice(-400)}`); resolve(c); });
      proc.on("error", () => resolve(1));
    });
    if (code !== 0) throw new Error("demucs failed — see the console");

    // demucs writes <out>/<model>/<track name without extension>/<stem>.flac
    const stem = job.file.replace(/\.(flac|mp3|opus|wav)$/i, "");
    const dir = path.join(outRoot, config.stems.model, stem);
    try {
      const names = await readdir(dir);
      return names.filter((n) => n.endsWith(".flac")).map((n) => `${config.stems.model}/${stem}/${n}`);
    } catch {
      throw new Error("demucs wrote nothing where expected");
    }
  }

  /**
   * Two LRC files — line level and word level.
   *
   * The lyrics are written to a temp FILE rather than passed on argv: they carry
   * newlines, apostrophes and quotes, and shell quoting mangles all three. The
   * same lesson is already recorded in tag_audio.py, which learned it the hard
   * way on its first attempt.
   *
   * If the track already has a separated vocal stem, that is used as the input —
   * a clean vocal aligns better than a full mix — but the stem is never
   * generated just for this. Measured 92.9% word match on a raw mix, so the
   * extra 12 s of separation is not worth forcing.
   */
  async #timeLyrics(job) {
    const lyrics = (job.lyrics || "").trim();
    if (!lyrics) throw new Error("no lyrics to time (instrumental?)");

    const here = path.dirname(new URL(import.meta.url).pathname.slice(1));
    const tmp = path.join(config.paths.appData, `lyr_${Date.now()}.txt`);
    await writeFile(tmp, lyrics, "utf8");

    const stem = job.file.replace(/\.(flac|mp3|opus|wav)$/i, "");
    const outStem = path.join(LRC_DIR, stem);
    await mkdir(LRC_DIR, { recursive: true });

    const args = [
      path.join(here, "lrc.py"),
      path.join(config.outputDir, job.file),
      tmp,
      outStem,
    ];
    const vocal = path.join(config.outputDir, "stems", config.stems.model, stem, "vocals.flac");
    if (config.lyrics.useVocalStem) {
      try { await stat(vocal); args.push("--vocals", vocal); } catch { /* mix is fine */ }
    }

    try {
      const out = await new Promise((resolve) => {
        const proc = spawn(config.lyrics.python, args, {
          windowsHide: true,
          env: { ...process.env, AIPLAY_WHISPER_MODEL: config.lyrics.model },
        });
        let so = "", se = "";
        proc.stdout.on("data", (d) => (so += d));
        proc.stderr.on("data", (d) => (se += d));
        proc.on("exit", () => resolve(so));
        proc.on("error", () => resolve(""));
      });
      /* Take the LAST {...} in stdout rather than the last line.
       *
       * Splitting on newlines is wrong here: whisper's progress bars are drawn
       * with carriage returns, so the whole animation and the JSON arrive as one
       * "line" and JSON.parse chokes on "Transcribi…". The script now suppresses
       * that output, but a library that prints one stray banner should not make
       * a completed alignment look like a failure — which is exactly what
       * happened: both LRC files were written and the job still reported an
       * error. */
      const m = out.match(/\{[\s\S]*\}/);
      const info = JSON.parse(m ? m[0] : "{}");
      if (!info.ok) throw new Error(info.error || "alignment failed");
      return { lrc: `${stem}.lrc`, wordLrc: `${stem}.word.lrc`, ...info };
    } finally {
      unlink(tmp).catch(() => {});
    }
  }

  /** Covers already on disk, so restarts do not redraw what exists. */
  async existing() {
    try {
      const names = await readdir(COVER_DIR);
      return new Set(names.filter((n) => n.endsWith(".png")));
    } catch {
      return new Set();
    }
  }

  /** Queue every library track that has no cover yet. The overnight case. */
  async backfill(tracks) {
    const have = await this.existing();
    let n = 0;
    for (const t of tracks) {
      const stem = t.file.replace(/\.(flac|mp3|opus|wav)$/i, "");
      if (have.has(`${stem}.png`)) continue;
      if (this.request({ file: t.file, caption: t.caption, title: t.title, seed: t.seed })) n++;
    }
    return n;
  }
}

export const coverPathFor = (file) => {
  const stem = String(file).replace(/\.(flac|mp3|opus|wav)$/i, "");
  return path.join(COVER_DIR, `${stem}.png`);
};

export const coverNameFor = (file) =>
  `${String(file).replace(/\.(flac|mp3|opus|wav)$/i, "")}.png`;

export { COVER_DIR, LRC_DIR, CLIP_DIR, IMAGE_DIR };
