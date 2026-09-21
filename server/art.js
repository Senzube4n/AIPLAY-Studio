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
import { spawn } from "node:child_process";
import { mkdir, rename, readdir, stat, writeFile, readFile, unlink } from "node:fs/promises";
import zlib from "node:zlib";
import path from "node:path";
import { config } from "./config.js";
import { resolvePick } from "./modelpick.js";
import { animaGraph, coverGraph, coverPrompt, COVER_NODES, ideogramGraph, ideogramPassSeeds, nextIdeogramSeed, isRefusalCard, ideogramRefusalMessage, checkpointGraph, zImageGraph, krea2Graph, videoGraph, videoPrompt, alignFrames, videoEngine, enhanceGraph, restyleGraph } from "./workflow.js";
import { joinClips } from "./clipjoin.js";
import { buildCustom, assignedTo } from "./customWorkflows.js";
/* The ledger, imported HERE and not only at the API seam in index.js: a clip
 * served from the engine's cache is a fact only the renderer can know, and it
 * is gone by the time the completion event is handled. */
import * as prov from "./provenance.js";
/* THE DOOR. Every one of the nine places this file used to touch the engine —
 * five POST /prompt loops, two interrupts, a queue clear, a /free — now goes
 * through here, which means each of them writes a full technical record before
 * the GPU spends anything and a completion record afterwards, INCLUDING the
 * renders that fail. Before this, a render that died left no trace of any kind:
 * no seed, no prompt, no model, no elapsed time, nothing. */
/* ⚠ ALIASED, because in this file `engine` ALREADY MEANS SOMETHING ELSE — it
 * is the name of the image or video model ("flux2", "ideogram4", "ltx"), in a
 * dozen local bindings. Importing it bare shadowed nothing at parse time and
 * failed at RUNTIME, inside a render, with "engine.run is not a function": the
 * `const engine = job.engine || …` two lines above won. Caught by
 * art_cache_test.js on the first run, which is exactly what that test is for. */
import { engine as engineDoor } from "./engine/client.js";

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

/* ── THE RENDER INDEX: which graph produced which clip ──────────────────────
 *
 * THE BUG THIS EXISTS FOR. ComfyUI caches node outputs by their inputs, for the
 * lifetime of the process — that is the whole point of comfy.js keeping ONE
 * engine alive, and it buys an identical re-run in 0.3 s instead of 258 s. But
 * #clip finishes a render by MOVING the engine's file into the clip library,
 * and the library IS a subfolder of the engine's own output folder
 * (`<output>/clips`). So the second identical render is served from cache, the
 * SaveVideo node never executes, /history hands back the entry it wrote the
 * FIRST time — and the file that entry names was moved out from under it.
 * `rename` throws a bare ENOENT with two absolute Windows paths, and a render
 * that cost nothing and proved nothing is reported as a failure.
 *
 * Reproduced twice by hand, then measured on Video Lab's own first re-run:
 * both LTX arms failed this way in four seconds flat. That route papered over
 * it locally by spotting twin ARMS before rendering, which only helps inside
 * one comparison. An ordinary re-render of a clip you already have hits it too.
 *
 * THE KEY IS THE GRAPH, NOT THE PATH. Keying this on the engine's output path
 * would look simpler and be wrong: SaveVideo restarts its counter once the
 * folder is empty, so `clip_00001_.mp4` gets written again by the next
 * UNRELATED render, and a stale entry would hand back somebody else's video.
 * A graph is a total description of a render — prompt, seed, size, schedule,
 * references — so identical graph means identical output, which is exactly the
 * rule ComfyUI's own cache runs on. Hashing it can only ever agree with the
 * engine.
 */
const RENDER_INDEX = path.join(CLIP_DIR, ".renders.json");

/** How many graph→clip pairs to remember. A pair is ~120 bytes and only recent
 *  ones can still be live in the engine's cache, so this is generous. */
const RENDER_INDEX_MAX = 500;

/**
 * A continuation came back as NEW FRAMES ONLY (the graph dropped the overlap).
 * Join source + new into the job's own clip name; the new frames alone stay
 * beside it as <id>_new.mp4. Without ffmpeg the new frames are the clip and
 * the record says so — nothing is thrown away, nothing is promised.
 */
async function joinContinuation(job, clip) {
  const src = path.join(CLIP_DIR, job.extendedFrom);
  const fresh = path.join(CLIP_DIR, clip);
  const newName = clip.replace(/\.mp4$/i, "_new.mp4");
  const kept = path.join(CLIP_DIR, newName);
  try { await rename(fresh, kept); } catch (err) {
    job.continuation = { joined: false, newClip: null, error: `could not set the new frames aside: ${err.message}` };
    return clip;
  }
  const r = await joinClips(src, kept, fresh, { crf: config.video.saveCrf || 14 });
  if (r.ok) {
    job.continuation = { joined: true, newClip: newName, frames: r.frames, audio: r.audio };
    console.log(`  [art] continued ${job.extendedFrom} -> ${clip} (${r.frames} frames; new frames kept as ${newName})`);
    return clip;
  }
  // No join: the new frames ARE the clip, under the job's name, and the reason travels.
  await rename(kept, fresh).catch(() => {});
  job.continuation = { joined: false, newClip: null, error: r.error };
  console.warn(`  [art] continuation of ${job.extendedFrom} not joined: ${r.error}`);
  return clip;
}

/** JSON with the keys sorted, so two objects built from the same values hash
 *  the same however they were assembled. */
function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** A stable fingerprint of a submitted graph — this render's identity. */
export function graphHash(graph) {
  return createHash("sha256").update(stableJson(graph)).digest("hex").slice(0, 16);
}

async function readRenderIndex() {
  try {
    const v = JSON.parse(await readFile(RENDER_INDEX, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

/** Record that this graph produced this clip. Never fatal: an index that fails
 *  to write costs a future cache hit, and must not cost the render in hand. */
export async function noteRender(hash, clip, extra = {}) {
  try {
    const idx = await readRenderIndex();
    idx[hash] = { clip, at: Date.now(), ...extra };
    const keys = Object.keys(idx);
    if (keys.length > RENDER_INDEX_MAX) {
      keys.sort((a, b) => (idx[b].at || 0) - (idx[a].at || 0))
        .slice(RENDER_INDEX_MAX).forEach((k) => delete idx[k]);
    }
    await mkdir(CLIP_DIR, { recursive: true });
    await writeFile(RENDER_INDEX, JSON.stringify(idx), "utf8");
  } catch (err) {
    console.warn(`[art] render index not written (${err.message})`);
  }
}

/**
 * The clip this graph already produced — or null.
 *
 * The on-disk check is not belt and braces: the person may have deleted the
 * clip, and pointing a job at a file that is not there would swap one silent
 * ENOENT for another. A missing twin drops its entry, which is also what tells
 * the caller it has to render for real.
 */
export async function cachedRenderFor(hash) {
  const idx = await readRenderIndex();
  const hit = idx[hash];
  if (!hit?.clip) return null;
  try { await stat(path.join(CLIP_DIR, hit.clip)); }
  catch {
    delete idx[hash];
    await writeFile(RENDER_INDEX, JSON.stringify(idx), "utf8").catch(() => {});
    return null;
  }
  return hit;
}

/** Give the graph's save node a fresh prefix. Used only when the cache is
 *  serving a file that exists in neither place — see #clip. */
function bumpSavePrefix(graph, nonce) {
  let bumped = false;
  for (const node of Object.values(graph || {})) {
    const p = node?.inputs?.filename_prefix;
    if (typeof p === "string") {
      node.inputs.filename_prefix = `${p.replace(/__r[0-9a-z]{6}$/, "")}__r${nonce}`;
      bumped = true;
    }
  }
  return bumped;
}

/* How many pass-seeds one Ideogram job may burn before it gives up. Each one
 * is a full render, so this is a spend cap, not a confidence level — and it is
 * only ever reached on a machine whose ladder is long enough to offer three
 * DISTINCT seeds. */
const IDEO_MAX_TRIES = 3;

/**
 * How long to wait for one image before calling it dead.
 *
 * ⚠ THIS USED TO BE A FLAT 180 s, AND Z-IMAGE BASE FOUND THE HOLE. Every
 * engine before it finished a picture in seconds — 4 distilled FLUX steps, 20
 * Ideogram steps — so a constant was fine. Base is 25 steps with real
 * classifier-free guidance, which is a batch of two through a 6.15B DiT, and
 * on a machine short of free RAM the streamed weights come off the pagefile:
 * measured at 41 s with 16 GB free and STILL RUNNING AT 13 MINUTES with 3.8 GB
 * free. The flat deadline fired at three minutes, the job was marked failed,
 * and ComfyUI carried on rendering it — the app and the GPU disagreeing about
 * whether work was happening, which is the worst of the available outcomes:
 * the picture that eventually lands belongs to a job the library gave up on.
 *
 * ⚠ AND THE JOB SPACE IS BIGGER THAN ANY CONSTANT. The route clamps
 * width/height to 256..2048, steps to 60 on a checkpoint, and count to 4 — and
 * `count` batches INSIDE ONE PROMPT (see the two-SaveImage note in #render), so
 * all four pictures render under ONE deadline rather than four of them. The
 * worst job /api/image will cheerfully accept is therefore 2048² x 60 steps x
 * 4 slots x CFG on a cold SDXL checkpoint: several times 180 s on this card, so
 * the old constant did not make that job slow, it made it UNREACHABLE.
 *
 * So the cost is modelled the way the video path already models its own
 * (#clip below, which learned this exact lesson when a real user render was
 * killed with eleven minutes of GPU already spent), and every term is a factor
 * the route can actually vary:
 *
 *   PIXELS   quadratic in the side, so 2048² is 4x the work of 1024². This is
 *            the term the first version of this function missed.
 *   STEPS    linear, proven: Z-Image base measured 7.2 s at 6 steps and 23.3 s
 *            at 25, warm at 1024².
 *   COUNT    linear, because a batch samples every slot.
 *   CFG      x2 on the engines that evaluate an uncond branch (zimage-base,
 *            checkpoint). The distilled ones at cfg 1.0 never do.
 *
 * `imageCostSeconds` is the HONEST estimate — what the render should take on a
 * quiet machine. The padding lives in the deadline, on purpose, so the two can
 * be read and argued about separately.
 *
 * 0.6 s per model pass per megapixel is a little above what was measured here
 * (Z-Image base: 0.85 s/step at 1 MP with two passes = 0.42 s a pass), because
 * an estimate that only fits the fastest engine is not an estimate.
 *
 * THE MULTIPLIER IS 6, NOT THE VIDEO PATH'S 4, and the extra is bought with
 * evidence: this box runs TWO ComfyUI instances that between them held 15,749
 * of 16,376 MiB, and under that contention the same 1024² Z-Image base picture
 * went from 41 s to still-running-at-13-minutes because the streamed weights
 * came off the pagefile. A deadline that only covers a quiet machine is a
 * deadline that fires on the busy one, which is the case it exists for.
 *
 * Erring short costs a real picture; erring long costs a slow error message.
 * The 180 s floor is the old constant kept as a promise — nothing is ever given
 * less than it used to have — and with these terms nothing reaches it.
 *
 * Exported so scripts/test_workflow.mjs can pin the property that matters: the
 * deadline must cover the largest job the route accepts.
 */
const IMAGE_DEFAULT_STEPS = { flux2: 4, zimage: 8, "zimage-base": 25, checkpoint: 28 };
/* ⚠ IDEOGRAM'S STEP COUNT IS NOT `steps` — it comes from its PRESET.
 *
 * ideogramGraph reads `quality` and puts 20, 48 or 12 into its own scheduler;
 * the request's `steps` field never reaches that graph at all. But the route
 * still fills `steps` in for every engine, so a Quality render arrives here
 * carrying config.art.steps (4) and would be costed at a twelfth of the work
 * it is about to do. Same class of bug as costing a 2048² job as 1024²: the
 * number that reaches the deadline has to be the number the GRAPH uses. */
const IDEOGRAM_PRESET_STEPS = { quality: 48, turbo: 12, default: 20 };
/** Seconds one image job should honestly take on a quiet machine. */
export function imageCostSeconds({ engine = "flux2", steps, count = 1, width, height, quality } = {}) {
  const n = engine === "ideogram4"
    ? (IDEOGRAM_PRESET_STEPS[quality] ?? IDEOGRAM_PRESET_STEPS.default)
    : Math.max(1, Math.round(steps || IMAGE_DEFAULT_STEPS[engine] || 28));
  const slots = Math.min(Math.max(Math.round(count) || 1, 1), 4);
  /* Two model evaluations per step. zimage-base and a checkpoint run a real
   * uncond branch; Ideogram gets there differently but pays the same — its
   * DualModelGuider drives a SECOND 9B DiT (the unconditional one) alongside
   * the first, every step. The distilled engines at cfg 1.0 pay once. */
  const cfgPasses = engine === "zimage-base" || engine === "checkpoint" || engine === "ideogram4" ? 2 : 1;
  // 1024² is the unit. The route clamps both sides to 256..2048.
  const mp = ((width || config.art.size) * (height || config.art.size)) / (1024 * 1024);
  const PER_PASS_MP = 0.6;        // seconds; measured 0.42 here, rounded up
  /* Cold weight load, per engine, because the footprints are not comparable:
   * Z-Image swaps a 6.2 GB DiT (measured — turbo 21.5 s cold against 5.8 s
   * warm, so ~16 s, called 30), a checkpoint is one ~6 GB file, and Ideogram
   * loads TWO 9.3 GB DiTs plus a 6.3 GB encoder. That last figure is an
   * ESTIMATE from the file sizes, not a measurement — Ideogram's cold load has
   * not been timed on this rig — and it is deliberately the pessimistic end,
   * because being wrong here kills a live render. */
  const LOAD = { flux2: 30, zimage: 30, "zimage-base": 30, checkpoint: 45, ideogram4: 180 }[engine] ?? 45;
  return LOAD + PER_PASS_MP * n * slots * cfgPasses * mp;
}
export function imageDeadlineMs(job = {}) {
  return Math.max(180_000, (imageCostSeconds(job) * 6 + 120) * 1000);
}

/**
 * Luma statistics of a PNG, no dependencies — a minimal reader for exactly what
 * SaveImage writes (8-bit, non-interlaced). Exists for one reason: Ideogram 4's
 * open weights render a trained-in "blocked by safety filter" card, and WHICH
 * seeds fall into that basin is random — the same innocent prompt renders on
 * one seed and refuses on the next. The card is near-uniform gray, so it is
 * cheap to detect and retry.
 *
 * Returns `{ variance, flat }` — `flat` being the share of sampled pixels
 * inside the best ±2 luma window, which is the signal that separates the card
 * from a dark-but-real picture. isRefusalCard() in workflow.js owns the
 * thresholds and the measurements behind them.
 *
 * ⚠ EXPORTED so scripts/harvest_ideogram_seeds.mjs can decide "pass" with the
 * SAME arithmetic the renderer uses to decide "card". It used to carry its own
 * copy sampling every 8th pixel against the app's every 4th, so a seed could
 * be harvested as passing and then have its render deleted as a card.
 */
export function pngLumaStats(buf) {
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
    const hist = new Uint32Array(256);
    for (let y = 0; y < height; y += 4) for (let x = 0; x < width; x += 4) {
      const i = y * stride + x * channels;
      const l = channels >= 3 ? (px[i] * 3 + px[i + 1] * 4 + px[i + 2]) >> 3 : px[i];
      n++; sum += l; sum2 += l * l; hist[l]++;
    }
    if (!n) return null;
    const mean = sum / n;
    // The widest single shade: the best contiguous ±2 luma window. A refusal
    // card puts ~97% of its pixels in one; no real render measured goes past
    // half.
    let best = 0, bestC = 0;
    for (let c = 2; c < 254; c++) {
      let s = 0;
      for (let k = c - 2; k <= c + 2; k++) s += hist[k];
      if (s > best) { best = s; bestC = c; }
    }
    /* WHAT COLOUR that shade is. Flatness alone is not the card: a minimalist
     * poster — the exact thing Ideogram is best at — is also 96% one shade.
     * (Measured: "vintage travel poster, cream and teal" came back a flat
     * green field at 96% flat, and a flat-only rule DELETED it.) The card is
     * specifically a NEUTRAL MID-GREY, so the modal shade's chroma is what
     * separates the two. */
    let r = 0, g = 0, b = 0, m = 0;
    for (let y = 0; y < height; y += 4) for (let x = 0; x < width; x += 4) {
      const i = y * stride + x * channels;
      const R = px[i], G = channels >= 3 ? px[i + 1] : px[i], B = channels >= 3 ? px[i + 2] : px[i];
      const l = channels >= 3 ? (R * 3 + G * 4 + B) >> 3 : R;
      if (Math.abs(l - bestC) > 2) continue;
      r += R; g += G; b += B; m++;
    }
    const R = r / (m || 1), G = g / (m || 1), B = b / (m || 1);
    return {
      variance: sum2 / n - mean * mean,
      flat: best / n,
      modalLuma: bestC,
      modalChroma: Math.max(R, G, B) - Math.min(R, G, B),
    };
  } catch { return null; }
}

/** Is this PNG the model's refusal card? Reads the picture, workflow.js judges. */
export function refusalCard(buf) {
  return isRefusalCard(pngLumaStats(buf));
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

    /* ⚠ THE PORT MOVES NOW. It is reserved fresh at every engine start, so a
     * crash-restart or a tier change leaves this socket pointed at a number
     * that is either nobody's or — worse — somebody else's. Drop it and let
     * #connect() make a new one against the new port; progress is optional, so
     * a missed reconnection costs a progress bar and never a render. */
    engineDoor.on("rebound", () => {
      try { this.#ws?.close(); } catch { /* already gone */ }
      this.#ws = null;
    });
  }

  #ws;

  /** Idempotent, lazy, and never fatal — progress is a nicety, not the work. */
  #connect() {
    if (this.#ws && this.#ws.readyState <= 1) return;
    try {
      const ws = engineDoor.socket(this.clientId);
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

  /* STOP EVERYTHING, which until now could not be done at all.
   *
   * /api/cancel has always cancelled the SONG job. Art — every image, cover,
   * board, clip and restyle — had no cancel of any kind, so a 28-minute H3 clip
   * queued by mistake had to be waited out, and a queue of fifty boards could
   * only be drained by restarting the server.
   *
   * Two halves and both are needed: clearing OUR queue stops what has not been
   * submitted, and interrupting ComfyUI stops what has. Clearing Comfy's own
   * queue catches anything it accepted but has not started. The running job's
   * awaiter then fails the same way it would for any render that dies, which is
   * a path this code already handles.
   */
  /* DROP ONE QUEUED JOB, leaving everything else alone.
   *
   * stopAll() is a sledgehammer — it clears the whole queue and interrupts the
   * render. There was nothing between that and waiting: a single mistyped job
   * behind forty good ones could only be dealt with by throwing away all
   * forty-one. Keyed on `file`, which is the id every job already carries and
   * the only handle the UI has.
   *
   * The RUNNING job is deliberately not droppable here — stopping a render in
   * flight is a different operation with a different cost, and quietly doing
   * it because a row looked the same would be a nasty surprise. stopCurrent()
   * below is the explicit version. */
  drop(file) {
    const before = this.queue.length;
    this.queue = this.queue.filter((j) => j.file !== file);
    const removed = before - this.queue.length;
    if (removed) this.emit("update");
    return { removed, running: this.current?.file === file };
  }

  /* STOP WHAT IS RENDERING, and leave the queue to carry on.
   *
   * The counterpart to drop(): kill the one job in flight without discarding
   * the work queued behind it. Interrupting ComfyUI is the whole mechanism —
   * the job's own awaiter then fails down the same path any dead render takes,
   * and the runner picks up the next item by itself. */
  async stopCurrent() {
    const was = this.current?.title || null;
    if (!was) return { stopped: null, queued: this.queue.length };
    /* Never throws — the client reports rather than raising, because Comfy
     * already being gone is a perfectly good outcome for "stop it": the job's
     * awaiter then fails down the same path any dead render takes, and the
     * ledger keeps the interrupted run's record with status "error". */
    await engineDoor.interrupt();
    return { stopped: was, queued: this.queue.length };
  }

  async stopAll() {
    const dropped = this.queue.length;
    const wasRunning = this.current?.title || null;
    this.queue = [];
    /* Two halves and both are needed: clearing OUR queue (above) stops what has
     * not been submitted, interrupting stops what is rendering, and clearing
     * ComfyUI's own queue catches what it accepted but has not started. */
    const stop = await engineDoor.interrupt();
    const cleared = await engineDoor.clearQueue();
    /* Comfy already down still counts as "the queue is cleared", which is most
     * of it — but say which half actually happened rather than reporting the
     * optimistic version of both. */
    const interrupted = stop.stopped === true && !cleared.error;
    return { dropped, interrupted, wasRunning, engineDropped: cleared.dropped ?? null };
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
        // The mini queue's ETA inputs: what this session actually measured.
        // (FORK — see FORK_DELTA.md.)
        doneCount: this.doneCount || 0,
        /* THE FINISHED JOBS, not just how many.
         *
         * `this.done` has always collected every completed job and nothing
         * outside this class could see it, so the app could tell you 47 jobs
         * finished and not one of them what they were or where the file went.
         * Trimmed to what a list needs — the full job objects carry graphs and
         * buffers that have no business crossing the wire. */
        recent: (this.done || []).slice(0, 200).map((j) => ({
          kind: j.kind,
          title: j.title || null,
          file: j.file || null,
          // The artefact each kind actually produced, by its own name.
          clip: j.clip || null,
          covers: j.covers || null,
          images: j.images || null,
          stems: j.stems ? j.stems.length : null,
          lrc: j.lrc || null,
          seed: Number.isFinite(j.seed) ? j.seed : null,
          engine: j.engine || null,
          ms: Number.isFinite(j.durationMs) ? j.durationMs
            : (j.startedAt && j.finishedAt) ? j.finishedAt - j.startedAt : null,
          at: j.finishedAt || j.at || null,
          error: j.error ? String(j.error).slice(0, 200) : null,
        })),
        stats: this.stats || {},
        nextTitles: this.queue.slice(0, 3).map((j) => ({ kind: j.kind, title: j.title })),
        /* EVERY waiting job, not just the next three. A queue you cannot see
         * is a queue you cannot manage — the UI needs one row per job, with
         * the `file` key that drop() takes. */
        items: this.queue.map((j) => ({ file: j.file, kind: j.kind, title: j.title || null })),
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
  request({ file, caption, title, seed, lyrics, kind = "cover", force = false, video, actor, asked = false }) {
    this.lastRefusal = null;
    if (!file) return this.#refuse("nothing to render — no file was named");
    /* `enabled` is the COVER ART setting, and it used to gate every kind.
     *
     * That made one dropdown labelled "Cover art" a silent master switch over
     * stems, timed lyrics and video: turning it off made all four stages
     * enqueue nothing while every trigger still returned ok, so the Overnight
     * checkboxes and the row actions reported success and produced no files.
     * Each kind now answers for itself; the queue is still shared, because what
     * they share is the GPU and the rule that music always preempts.
     *
     * ⚠ AND IT STILL GATED THE IMAGES SCREEN, because a picture a person asks
     * for is queued as kind "cover" — the same kind a finished song queues by
     * itself. So "Cover art: off" in Settings silently turned off every Make
     * image on the Images screen: request() returned null, /api/image answered
     * ok anyway, and the button sat on "Queued" forever while nothing was ever
     * sent to ComfyUI. Measured on this machine: `prefs.art.enabled: false` in
     * settings.json and not one `got prompt` in the engine's log across four
     * sessions of trying.
     *
     * `asked` is the fix and the distinction the setting always meant: it is a
     * switch over covers drawn AUTOMATICALLY for finished songs, never over a
     * render somebody pressed a button for. config.js says as much about the
     * Video screen ("ignores this setting the same way a manual cover render
     * ignores the cover dropdown") — that sentence was true of every screen
     * except this one. */
    if (kind === "cover" && !asked && !this.enabled) {
      return this.#refuse("automatic cover art is switched off in Settings");
    }
    if (!force && this.queue.some((j) => j.file === file && j.kind === kind)) {
      return this.#refuse(`${kind} for this file is already in the queue`);
    }
    const job = {
      id: randomUUID().slice(0, 8),
      kind,
      file,
      /* Somebody pressed a button for this one. Kept on the job so the status
       * line can say "your picture" and so a future reader can tell a render
       * that was asked for from one the app decided to make. */
      asked: !!asked,
      title: title || file,
      caption: caption || "",
      lyrics: lyrics || "",
      /* WHO ASKED, carried to the engine door so the technical record names
       * them rather than filing every render under `system`.
       *
       * "system" is the honest default and not a placeholder: a cover drawn
       * because a song finished, a clip queued by an overnight batch and a
       * stem separation all genuinely have no person behind them. The routes
       * that DO know — the Images screen, an MCP client — pass it, and
       * normalizeActor is what stops a caller claiming to be a human. */
      actor: prov.normalizeActor(actor ?? "system"),
      /* Covers MIX the seed with the file name on purpose — one seed across a
       * whole library must not paint the same art on every song. A VIDEO job
       * must not: its file is a unique timestamp id (`clip:v…`), so mixing
       * makes the typed seed a lie — the recorded seed could never reproduce
       * the clip, because re-submitting it mixed against a NEW id. The route
       * always supplies a concrete seed for clips (explicit or rolled), so
       * verbatim is both honest and sufficient. */
      seed: (kind === "video" || kind === "sfx") && Number.isFinite(seed) ? Number(seed)
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

  /**
   * Say NO out loud.
   *
   * request() answers `null` for four different reasons and the callers could
   * not tell them apart, so every one of them was reported to the user as
   * success — which is how "Cover art: off" became an invisible master switch
   * over the Images screen. The reason is kept here for the route that is about
   * to answer, and cleared at the top of the next request so it can never be a
   * stale explanation for a fresh refusal.
   */
  #refuse(why) {
    this.lastRefusal = why;
    return null;
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
    /* ⚠ `enabled` USED TO BE PART OF THIS GUARD, and it is the cover-art
     * dropdown. With it off, the runner returned here and — because it clears
     * its own timer first and only reschedules on the music branch below —
     * never came back: every job of every kind, a clip, a stem separation, a
     * picture somebody asked for, sat in the queue forever with no error and no
     * way to tell. Which kinds may be QUEUED is request()'s question and it is
     * answered there; what may RUN, once queued, is only ever "the GPU is free
     * and music is not waiting". */
    if (this.current || this.paused) return;
    if (this.queue.length === 0) return;
    if (!this.idle) return this.#schedule();      // music is busy; check back

    while (this.queue.length) {
      if (!this.idle || this.paused) break;       // yield to music
      const job = this.queue.shift();
      this.current = job;
      this.progress = 0;
      this.startedAt = Date.now();
      /* THE MUSIC MODEL LEAVES BEFORE A PICTURE OR A CLIP ARRIVES. ComfyUI
       * keeps MiniMax, ACE-Step or YuE2 loaded after a song, and would load the
       * image or video model beside it: on a 16 or 24 GB card that is how a
       * render ends up streaming from system RAM. The music runner's own
       * switch (jobs.js) only ever compared music models with each other.
       * `artResident` tells it the way back needs an unload too. */
      if (this.jobs.loaded) {
        console.log(`  [art] unloading ${this.jobs.loaded.key} before the ${job.kind || "image"} job`);
        await this.jobs.unloadModels().catch(() => {});
      }
      this.jobs.artResident = true;
      job.startedAt = this.startedAt;
      this.#connect();
      this.emit("update");
      try {
        if (job.kind === "stems") {
          const stems = await this.#separate(job);
          job.stems = stems;
          this.done.unshift(job);
          this.emit("stems", { file: job.file, stems });
        } else if (job.kind === "video") {
          let clip = await this.#clip(job);
          if (clip && job.continueFrom && job.extendedFrom) clip = await joinContinuation(job, clip);
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
            /* THE JOIN. `clips/<name>`'s ledger entry now leads to
             * `engine/<runId>`, which holds the graph, every seed and cfg, the
             * model FILES with their sizes, the references with their hashes,
             * the wall time and the output digest. Before this the clip's
             * provenance was three fields and a filename. */
            runId: job.runId ?? null,
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
              // A continuation: the clip it follows on from, and how the join went.
              extendedFrom: job.extendedFrom || null,
              continuation: job.continuation || null,
              overlapFrames: job.continueFrom?.overlapFrames ?? null,
              // The conditioning bridge this render asked for (undefined = the panel's).
              bridge: job.bridge ?? null, bridgeAlpha: job.bridgeAlpha ?? null,
              /* Set when the engine served this from its cache rather than
               * rendering: the clip is one it already made. index.js writes
               * this meta into the clip store and the song's sidecar untouched,
               * so the fact travels without the seam having to know about it.
               * Carries the graph fingerprint, so "why is this the same file?"
               * has an answer that can be checked. */
              cacheHit: job.cacheHit || null,
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
            runId: job.runId ?? null,
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
            runId: job.runId ?? null,
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
        } else if (job.kind === "sfx") {
          // Fork-only (FORK_DELTA): a 3-5 s sound effect through the same
          // queue as everything else, so music still preempts.
          const out = await this.#sfx(job);
          job.sfxFile = out;
          this.done.unshift(job);
          this.emit("sfx", { file: job.file, sfxFile: out, seed: job.seed, runId: job.runId ?? null });
        } else {
          const { covers, thumbs } = await this.#render(job);
          job.covers = covers;
          this.done.unshift(job);
          this.emit("cover", { file: job.file, covers, thumbs, seed: job.seed, runId: job.runId ?? null,
                               durationMs: job.startedAt ? Date.now() - job.startedAt : null,
                               engine: job._paintedBy || job.engine || "flux2",
                               checkpoint: job._paintedWith || null });
        }
        /* Stamp the finish ONCE, here, rather than in each of the seven
         * kind-specific branches above — every one of them falls through to
         * this point, and a per-branch stamp is a per-branch chance to forget.
         * durationMs already existed but only ever reached a cover event; the
         * job itself never carried how long it took, so nothing downstream
         * could report it. */
        job.finishedAt = Date.now();
        job.durationMs = job.startedAt ? job.finishedAt - job.startedAt : null;
      } catch (err) {
        job.finishedAt = Date.now();
        job.durationMs = job.startedAt ? job.finishedAt - job.startedAt : null;
        job.error = String(err.message || err);
        if (!this.done.includes(job)) this.done.unshift(job);
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
          /* Present when the engine was actually reached: the door recorded the
           * failure too, with the status, the error and the elapsed time. A
           * render that died used to leave no trace of any kind. */
          runId: job.runId ?? null,
        });
      } finally {
        /* Rolling per-kind averages for the mini queue's ETA. Measured on THIS
         * session's hardware and settings rather than guessed — a budget video
         * and a native one differ 7x, and the average follows what the user is
         * actually rendering tonight. (FORK — see FORK_DELTA.md.) */
        if (this.startedAt) {
          const secs = (Date.now() - this.startedAt) / 1000;
          this.stats = this.stats || {};
          const s = this.stats[job.kind] || { n: 0, avg: 0 };
          s.avg = (s.avg * s.n + secs) / (s.n + 1);
          s.n = Math.min(s.n + 1, 8);           // rolling-ish: recent runs dominate
          this.stats[job.kind] = s;
          this.doneCount = (this.doneCount || 0) + 1;
        }
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
      : coverPrompt({ caption: job.caption, title: job.title, seed: job.seed, lyrics: job.lyrics });
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
    // an explicit job engine always wins — that is also how the ideogram
    // cover fallback reaches FLUX; covers otherwise follow the Settings default
    let engine = job.engine || (standalone ? "flux2" : (config.art.engine || "flux2"));
    const ckpt = job.checkpoint || config.art.checkpoint;
    /* A PICKED FILE DECIDES ITS OWN LOADER. The Images route settles this for a
     * standalone render, but a COVER follows the Settings default and reaches
     * here without passing through it — so the same question is asked again
     * rather than assuming models/checkpoints. A bare transformer (Z-Image,
     * Anima, FLUX.2, Krea 2) renders on its family's graph with the user's file
     * in place of the catalogue's; CheckpointLoader could not open it at all. */
    let ownDit = job.dit || null;
    if (engine === "checkpoint" && ckpt) {
      const pick = await resolvePick(ckpt).catch(() => null);
      if (pick?.ok && pick.engine !== "checkpoint") { engine = pick.engine; ownDit = pick.dit; }
    }
    /* The halves the person named on the Images screen, if they named any.
     * Null everywhere else, which is the catalogue's own files. */
    const ownEncoder = job.encoder || null;
    const ownVae = job.vae || null;
    /* WHAT ACTUALLY PAINTED IT, stashed for the cover event below.
     * The event used to report `job.engine || "flux2"`, which is only right for
     * a standalone image: a COVER carries no engine of its own and follows the
     * Settings default, so every cover Ideogram or a checkpoint painted was
     * filed as FLUX.2 — and the provenance ledger reads its `model` from this
     * same event, so the wrong answer was the notarised one.
     * Stashed on the job rather than threaded through #render's several return
     * paths, and re-stamped on the ideogram->flux fallback re-entry, where
     * FLUX genuinely is what painted. */
    job._paintedBy = engine;
    /* The FILE that painted it, whichever shelf it came from: a checkpoint, or
     * the user's own transformer standing in for the catalogue's. The ledger
     * reads this, so "my own model" must not be filed as the stock one. */
    job._paintedWith = engine === "checkpoint" ? (ckpt || null) : (ownDit || null);
    if (!graph && engine === "ideogram4") {
      /* Noise-locked model: only seeds from the pass list render (see
       * workflow.js). A requested seed outside the list would buy the refusal
       * card, so it is swapped for a passing one and the SWAP is what gets
       * recorded — the recorded seed is always the one that painted.
       *
       * The seeds this job has already burned are carried on the job, so the
       * retry below can never re-pick one — see nextIdeogramSeed(). */
      const ladder = ideogramPassSeeds();
      const tried = job._ideoTried || (job._ideoTried = []);
      if (!ladder.includes(job.seed) || tried.includes(job.seed)) {
        // The requested seed picks WHICH pass-seed, so a re-roll is a different
        // picture rather than the same one — see nextIdeogramSeed().
        const fresh = nextIdeogramSeed(tried, ladder, job.seed);
        // Every seed burned and the caller still wants a render: fall through
        // on the one we have rather than inventing a seed the model refuses.
        if (fresh !== undefined) job.seed = fresh;
      }
      if (!tried.includes(job.seed)) tried.push(job.seed);
      graph = ideogramGraph({ prompt, seed: job.seed, width: job.width, height: job.height,
                              quality: job.quality || config.art.quality, count: job.count,
                              prefix: PREFIX });
    } else if (!graph && engine === "checkpoint" && ckpt) {
      graph = checkpointGraph({ ckpt, prompt, negative: job.negative,
                                seed: job.seed, width: job.width, height: job.height,
                                steps: standalone ? job.steps : 28, cfg: job.cfg, count: job.count,
                                /* The SD-family dials. Undefined leaves the graph exactly as
                                 * it was, so a cover keeps rendering byte-identically. */
                                clipSkip: job.clipSkip, sampler: job.sampler, scheduler: job.scheduler,
                                loras: job.loras,
                                prefix: PREFIX });
    } else if (!graph && engine === "anima") {
      /* Anima. The DiT is whichever file the caller named — this app does not
       * ship one, because a user who has an Anima checkpoint already has 4.2 GB
       * of it and the catalogue entry exists to supply the 1.45 GB of encoder
       * and VAE it cannot run without.
       *
       * `steps` and `cfg` arrive undefined unless asked for, exactly as the
       * Z-Image branch below explains: config.art.steps is 4, and handing FLUX
       * klein's distilled number to a 30-step model would look like the model
       * being bad rather than the form being wrong. animaGraph fills the
       * vendor preset when nobody asked. */
      graph = animaGraph({
        dit: ownDit || config.art.animaDit, encoder: ownEncoder, vae: ownVae,
        prompt, negative: job.negative, seed: job.seed,
        width: job.width, height: job.height, steps: job.steps, cfg: job.cfg,
        sampler: job.sampler, scheduler: job.scheduler, count: job.count,
        prefix: PREFIX,
      });
    } else if (!graph && engine === "krea2") {
      /* Krea 2 Turbo: the vendor's 8-step recipe, cfg 1.0. `steps` arrives
       * undefined unless asked for, for the same reason as Z-Image below —
       * config.art.steps is FLUX's 4. */
      graph = krea2Graph({
        prompt, seed: job.seed, width: job.width, height: job.height,
        steps: standalone ? job.steps : undefined,
        count: job.count, prefix: PREFIX, dit: ownDit, encoder: ownEncoder, vae: ownVae,
      });
    } else if (!graph && (engine === "zimage" || engine === "zimage-base")) {
      /* Z-Image, Apache-2.0 — two engine names, ONE graph builder, because the
       * only differences between the two checkpoints are the filename and the
       * sampler preset, and both live in workflow.js.
       *
       * ⚠ `steps` arrives UNDEFINED unless the caller actually asked for one —
       * the /api/image route deliberately does not fill in config.art.steps
       * for these two engines, because that value is 4 (FLUX.2 klein's number)
       * and handing it to Z-Image would sample turbo at half its schedule and
       * base at a sixth of its, silently. Undefined is the signal; zImageGraph
       * then uses the vendor preset for the variant it is building.
       *
       * The negative goes through UNCONDITIONALLY, and zImageGraph decides
       * whether it can be honoured: on turbo (cfg 1.0) ComfyUI never evaluates
       * the uncond branch, so there is nothing to honour. One rule, in one
       * place, rather than a second copy of it here. */
      graph = zImageGraph({
        prompt, negative: job.negative,
        seed: job.seed, width: job.width, height: job.height,
        steps: standalone ? job.steps : undefined,
        cfg: job.cfg,
        variant: engine === "zimage-base" ? "base" : "turbo",
        count: job.count, prefix: PREFIX, dit: ownDit, encoder: ownEncoder, vae: ownVae,
      });
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
        dit: ownDit, encoder: ownEncoder, vae: ownVae,
      });
    }

    /* Sized from the job itself rather than a constant — see imageDeadlineMs()
     * above, the Z-Image base finding that forced it, and the size term that
     * the route's 2048² ceiling forces on top. Width and height must be passed:
     * without them a 2048² request is costed as though it were 1024² and the
     * deadline is a quarter of what that job needs.
     *
     * ⚠ THIS MATHS IS KEPT AND HANDED TO THE DOOR AS `timeoutMs`. The client's
     * own 30-minute default is a backstop for graphs nobody anticipated; this
     * number is fitted to the engine and the picture actually being made, and
     * it is better than a constant in both directions. */
    const budget = imageDeadlineMs({
      engine, steps: job.steps, count: job.count,
      width: job.width, height: job.height,
      /* Resolved the SAME way the ideogram branch above resolves it, because
       * that is the preset whose step count the graph will actually run. */
      quality: job.quality || config.art.quality,
    });

    // Poll history rather than sharing the job runner's websocket. Art progress
    // is not worth showing per-step — it is three seconds — and a second
    // consumer on that socket would have to filter every music event.
    /* 400 ms because a warm FLUX.2 klein cover is about three seconds end to
     * end: the door's 3 s default would roughly double that for nothing. The
     * failure bounds inside the client are stated as durations, so a fast
     * cadence buys latency without weakening them. */
    const done = await engineDoor.run({
      graph, actor: job.actor, via: `art.${standalone ? "image" : "cover"}`,
      clientId: this.clientId, timeoutMs: budget, pollMs: 400,
      label: job.title || job.file, project: null,
      /* The runner files these itself, under a name derived from the TRACK and
       * not known until after the rename below — so the door records the run
       * and index.js's `generate` seam records where the file landed, joined by
       * this runId. A `claim` here would have to guess the name, and a batch of
       * four would get one name for four files. */
      adopt: false,
    });
    /* Kept on the job so the completion event can carry it: this is the join
     * between `images/x.png` in the library and the full technical record of
     * the render that made it. */
    job.runId = done.runId;
    if (done.status !== "completed") {
      throw new Error(done.error || `the engine did not finish (${done.status})`);
    }
    {
      // Keyed by NODE, never by position in a flattened list: the graph has two
      // SaveImage nodes and with count > 1 their outputs interleave, so
      // "first N are the covers" is wrong the moment takes are batched.
      const pick = (node) => done.outputs.filter((o) => o.node === String(node));
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
          const src = path.join(config.outputDir, list[i].subfolder || "", list[i].file);
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
         * means an unlucky seed, not a bad prompt. Up to IDEO_MAX_TRIES seeds,
         * each one used at most ONCE — see nextIdeogramSeed().
         *
         * ⚠ EVERY PICTURE IN THE BATCH, not just the first. `count` renders one
         * seed into a batched latent and ComfyUI gives each slot DIFFERENT
         * noise — so the refusal is per-slot, and a count of 2 routinely comes
         * back as one picture and one card. Checking thumbs[0] alone filed that
         * card in the library with no error anywhere. Reproduced on 2026-08-27:
         * "tarot card gold luxurious minimalistic, 3d cgi octane render",
         * count 2, seed 777 → slot 1 variance 824 (a picture), slot 2 variance
         * 119 at 98% flat (the card), and the card was listed in the gallery. */
        if (engine === "ideogram4" && result.thumbs.length) {
          const verdicts = await Promise.all(result.thumbs.map(async (t) =>
            refusalCard(await readFile(path.join(outDir, t)).catch(() => Buffer.alloc(0)))));
          const cards = verdicts.map((v, i) => (v.isCard ? i : -1)).filter((i) => i >= 0);
          if (cards.length) {
            /* DELETED FIRST, BEFORE anything that can throw.
             *
             * This used to happen only on the give-up path, after the retry
             * had returned — so when the retry threw (and with a one-entry
             * ladder it re-rendered the same seed and threw a rename ENOENT,
             * every time) the card survived in the library. That is exactly
             * how a "blocked by safety filter" tile ended up on the owner's
             * Images wall. A refusal card is noise, not a result: it goes as
             * soon as it is recognised, whatever happens next. */
            for (const i of cards) {
              for (const f of [result.covers[i], result.thumbs[i]]) {
                if (f) await unlink(path.join(outDir, f)).catch(() => {});
              }
            }
            if (cards.length < result.thumbs.length) {
              /* A PARTIAL batch. The pictures that rendered are real results
               * and are kept; the refused slots simply are not there. Saying
               * so beats both alternatives — keeping the card, or throwing
               * away work the GPU already did. */
              console.warn(`  [image] ideogram refused ${cards.length} of ${result.thumbs.length} `
                + `pictures on pass-seed ${job.seed} (${verdicts[cards[0]].why}) — keeping the `
                + `${result.thumbs.length - cards.length} that rendered`);
              const keep = (list) => list.filter((_, i) => !cards.includes(i));
              return { covers: keep(result.covers), thumbs: keep(result.thumbs) };
            }
            const ladder = ideogramPassSeeds();
            const tried = job._ideoTried || [];
            const fresh = nextIdeogramSeed(tried, ladder);
            if (fresh !== undefined && tried.length < IDEO_MAX_TRIES) {
              console.warn(`  [image] ideogram card on pass-seed ${job.seed} (${verdicts[0].why}) — trying ${fresh}, `
                + `${tried.length}/${Math.min(IDEO_MAX_TRIES, ladder.length)} of the ladder burned`);
              job.seed = fresh;
              return await this.#render(job);
            }
            /* A cover falls back to FLUX so the song still gets art; a
             * standalone image fails with the reason — and the reason names
             * the real constraint, which is usually that this machine's
             * ladder has ONE entry and therefore no retry to offer. */
            if (!standalone) {
              console.warn("  [image] ideogram refused this cover — falling back to FLUX");
              return await this.#render({ ...job, engine: "flux2", _ideoTried: [] });
            }
            throw new Error(ideogramRefusalMessage(ladder.length, tried.length));
          }
        }
      return result;
    }
  }

  /**
   * Fork-only (FORK_DELTA): text → sound effect via Stable Audio 3 Small SFX.
   * job: { prompt, seconds (1-10), seed }. Returns the flac's absolute path.
   * The 3.5 GB stack loads beside nothing else — SFX renders run between
   * narration and mixing, when the queue is otherwise idle.
   */
  async #sfx(job) {
    const seconds = Math.min(10, Math.max(1, Number(job.seconds) || 4));
    const graph = {
      1: { class_type: "CheckpointLoaderSimple",
           inputs: { ckpt_name: "stable_audio_3_small_sfx_base.safetensors" } },
      2: { class_type: "CLIPLoader",
           inputs: { clip_name: "t5gemma_b_b_ul2.safetensors", type: "stable_audio" } },
      3: { class_type: "CLIPTextEncode",
           inputs: { clip: ["2", 0], text: String(job.prompt || job.caption || "sound effect") } },
      // the model happily drifts into scoring; keep it on effects
      4: { class_type: "CLIPTextEncode",
           inputs: { clip: ["2", 0], text: "music, melody, singing, speech, voice" } },
      5: { class_type: "ConditioningStableAudio",
           inputs: { positive: ["3", 0], negative: ["4", 0], seconds_start: 0, seconds_total: seconds } },
      6: { class_type: "EmptyLatentAudio", inputs: { seconds, batch_size: 1 } },
      7: { class_type: "KSampler",
           inputs: { model: ["1", 0], positive: ["5", 0], negative: ["5", 1], latent_image: ["6", 0],
                     seed: (job.seed >>> 0) || 1, steps: 20, cfg: 5,
                     sampler_name: "euler", scheduler: "simple", denoise: 1 } },
      8: { class_type: "VAEDecodeAudio", inputs: { samples: ["7", 0], vae: ["1", 2] } },
      9: { class_type: "SaveAudio", inputs: { audio: ["8", 0], filename_prefix: "sfx/aiplay_sfx" } },
    };

    const done = await engineDoor.run({
      graph, actor: job.actor, via: "art.sfx",
      clientId: this.clientId, timeoutMs: 300_000, pollMs: 500,
      label: `sfx: ${String(job.prompt || job.caption || "").slice(0, 60)}`,
      // Renamed into output/sfx/ below under a name minted at that moment.
      adopt: false,
    });
    job.runId = done.runId;
    if (done.status !== "completed") throw new Error(done.error || `sfx did not finish (${done.status})`);

    const audio = done.outputs.filter((o) => o.node === "9");
    if (!audio.length) throw new Error("engine returned no audio");
    const src = path.join(config.outputDir, audio[0].subfolder || "", audio[0].file);
    const outDir = path.join(config.outputDir, "sfx");
    await mkdir(outDir, { recursive: true });
    const name = `sfx_${job.file.replace(/[^\w-]/g, "_")}_${Date.now().toString(36)}${path.extname(audio[0].file)}`;
    const dest = path.join(outDir, name);
    await rename(src, dest);
    return dest;
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
      // LTX only: sample once at the delivered size instead of half-then-upscale.
      // ⚠ This call names every field rather than spreading the job, so a new
      // option that is not listed here is dropped in silence.
      baseScale: job.baseScale,
      firstFrame: job.firstFrame, lastFrame: job.lastFrame, loop: job.loop,
      /* Model files the person named instead of the engine’s own
       * (server/modelpick.js). Undefined leaves every part as it was. */
      models: job.models,
      // Waypoints. Without this line the route stages the pictures, the job
      // carries them, and the graph never sees one -- silently.
      midFrames: job.midFrames,
      // References (<Picture n> / <Audio n> in the prompt) — H3's ref2va path.
      refImages: job.refImages,
      refAudios: job.refAudios,
      /* Video-to-video: the whole clip drives the render frame by frame. Named
       * here for the reason the warning above gives — an option this call does
       * not list is dropped without a word, and a control video that silently
       * did nothing would look like the model ignoring the footage. */
      controlVideo: job.controlVideo,
      controlPatch: job.controlPatch,
      controlStrength: job.controlStrength,
      controlStart: job.controlStart,
      controlEnd: job.controlEnd,
      // Soundtrack — LTX's frozen-audio path: the clip is generated ON it.
      audioTrack: job.audioTrack,
      continueFrom: job.continueFrom || null,
      bridge: job.bridge, bridgeAlpha: job.bridgeAlpha,
      negative: job.negative, guidance: job.guidance, guideStrength: job.guideStrength,
      // A clip under a song has that song's audio; a standalone one has nothing,
      // so H3's own audio is the only thing it could ever play.
      keepAudio: job.keepAudio ?? !job.file.startsWith("clip:"),
    });

    /* THE RENDER'S IDENTITY, taken from the graph as submitted. Everything that
     * decides what the clip looks like is in here, which is why this is a safe
     * key for the render index above — and why it is the same thing ComfyUI's
     * own cache is keyed on. */
    const key = graphHash(graph);

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
    const budgetMs = Math.max(900_000, (expected * 4 + 300) * 1000);

    /* AT MOST TWO SUBMISSIONS, and the second one is rare — see the ENOENT arm
     * below for the only thing that reaches it. The deadline is per attempt
     * because the clock has to start when the engine does. */
    for (let attempt = 0; ; attempt++) {
      /* ⚠ INSIDE THE RETRY LOOP, so the second attempt is a SECOND RUN in the
       * ledger with its own record — which is exactly right. The prefix bump
       * below changes the graph, so the two attempts are genuinely different
       * renders and recording one for both would be the lie. */
      const done = await engineDoor.run({
        graph, actor: job.actor, via: "art.clip",
        clientId: this.clientId, timeoutMs: budgetMs, pollMs: 1000,
        label: job.title || job.file,
        // Renamed into the clip library below, or resolved to an earlier clip
        // entirely on the cache-hit path — neither name is knowable from here
        // before the POST, so the join is index.js's `generate` seam and runId.
        adopt: false,
      });
      job.runId = done.runId;
      if (done.status !== "completed") {
        throw new Error(done.error || `the engine did not finish (${done.status})`);
      }
      // SaveVideo reports under `images` with animated:true, not a `videos` key —
      // the client normalises both into one list, so this no longer has to care.
      const outs = done.outputs;
      if (!outs.length) throw new Error("engine returned no clip");
      const src = path.join(config.outputDir, outs[0].subfolder || "", outs[0].file);
      /* Standalone clips have no track to be named after, so they carry a
       * `clip:<id>` pseudo-file. Naming them after that keeps one flat folder
       * and one naming rule for both kinds. */
      const stem = job.file.startsWith("clip:")
        ? job.file.slice(5)
        : job.file.replace(/\.(flac|mp3|opus|wav)$/i, "");
      const name = `${stem}.mp4`;
      try {
        await rename(src, path.join(CLIP_DIR, name));
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
        /* THE CACHE HIT. /history named a file that is not there, which for
         * this graph means one thing: the engine served the render from cache,
         * and the earlier run already moved that file into the library. See the
         * render index at the top of this file for why it happens at all.
         *
         * Re-rendering would be the wrong answer twice over. It would spend a
         * GPU slot proving that identical settings produce an identical clip,
         * and to make the engine actually do it something would have to change
         * — so the clip you got back would no longer be the one you asked for.
         * The honest answer is the clip that graph already made, said out loud. */
        const twin = await cachedRenderFor(key);
        if (twin) {
          job.cacheHit = {
            clip: twin.clip, graph: key,
            renderedAt: twin.at ?? null,
            why: "The engine served this from its cache: the same prompt, seed, size and "
              + "schedule were rendered before, so this IS that clip. Change the seed to vary it.",
          };
          /* The ledger has to carry it too, or the clip's chain says it was
           * generated twice and nothing explains the second one. Not a new
           * event type — a `regen` whose data records what actually happened,
           * which is that no pixels were made. */
          await prov.append("library", {
            actor: "system", type: "regen", asset: `clips/${twin.clip}`,
            data: {
              cacheHit: true, graph: key, engine,
              seed: job.seed ?? null,
              requestedFor: job.file.startsWith("clip:") ? null : job.file,
              note: "identical graph — ComfyUI served the earlier render, no new frames",
            },
          }).catch((e2) => console.error(`  [provenance] event lost (regen/clips/${twin.clip}): ${e2.message}`));
          return twin.clip;
        }
        /* NEITHER PLACE HAS IT. The cache is serving a file the library no
         * longer holds — the person deleted the clip and asked again. Without
         * this the engine would keep handing back that same dead entry for the
         * rest of the process's life, which is the original dead end wearing a
         * different hat. Changing the SAVE prefix invalidates one node, not the
         * sampler, so a warm cache re-saves the very same frames in about a
         * second and a cold one pays for an honest re-render. */
        if (attempt) throw err;
        if (!bumpSavePrefix(graph, Date.now().toString(36).slice(-6))) throw err;
        continue;
      }
      await noteRender(key, name, { engine, seed: job.seed ?? null });
      return name;
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
      /* The engine's resident weights go first: an enhance holds whole frame
       * batches in RAM (the 2x upscale of a 5 s clip at 1344x768 is 12 GB),
       * and under --lowvram a video model's weights sit in that same RAM.
       * Measured 2026-09-19: 1.1 GB free with H3 loaded, and the upscale
       * could not allocate. The models reload for the next render. */
      await engineDoor.freeMemory({ unloadModels: true });   // reports rather than throws
      const graph = enhanceGraph({
        file: staged,
        interpolate: job.interpolate || null,
        upscale: job.upscale || null,
        keepAudio: job.keepAudio !== false,
        prefix: "clips/enh",
      });

      /* Interpolation is roughly real time; upscaling is emphatically not, and
       * scales with pixels rather than seconds. Ten minutes plus a minute per
       * megapixel-second, floored at fifteen — the same generosity as #clip and
       * for the same reason: killing a nearly-finished job wastes all of it. */
      const px = (job.srcWidth || 1280) * (job.srcHeight || 704) / 1e6;
      const load = (job.srcSeconds || 10) * px
        * (job.upscale ? 12 : 1) * (job.interpolate?.multiplier || 1);
      const budgetMs = Math.max(900_000, (600 + load * 60) * 1000);

      const done = await engineDoor.run({
        graph, actor: job.actor, via: "art.enhance",
        clientId: this.clientId, timeoutMs: budgetMs, pollMs: 1000,
        label: `enhance ${path.basename(job.file)}`,
        // Named below after WHAT WAS DONE, with a collision counter — a name
        // that cannot exist before the render finishes.
        adopt: false,
      });
      job.runId = done.runId;
      if (done.status !== "completed") {
        throw new Error(done.error || `the engine did not finish (${done.status})`);
      }
      const outs = done.outputs;
      if (!outs.length) throw new Error("engine returned no clip");
      const out = path.join(config.outputDir, outs[0].subfolder || "", outs[0].file);

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
      await engineDoor.freeMemory();   // reports rather than throws; never fails a finished job
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

      // Measured 130-235s for 121 frames depending on guide count. The floor is
      // generous for the same reason it is everywhere else here: killing a
      // nearly-finished render wastes all of it.
      const done = await engineDoor.run({
        graph, actor: job.actor, via: "art.restyle",
        clientId: this.clientId, timeoutMs: 1_800_000, pollMs: 1000,
        label: `restyle ${path.basename(job.file)}`,
        adopt: false,   // named below with a collision counter, as in #enhance
      });
      job.runId = done.runId;
      if (done.status !== "completed") {
        throw new Error(done.error || `the engine did not finish (${done.status})`);
      }
      const outs = done.outputs;
      if (!outs.length) throw new Error("engine returned no clip");
      const out = path.join(config.outputDir, outs[0].subfolder || "", outs[0].file);
      const stem = path.basename(job.file).replace(/\.(mp4|webm)$/i, "");
      let name = `${stem}_restyled.mp4`;
      for (let i = 2; ; i++) {
        try { await stat(path.join(CLIP_DIR, name)); } catch { break; }
        name = `${stem}_restyled_${i}.mp4`;
      }
      await rename(out, path.join(CLIP_DIR, name));
      return name;
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
