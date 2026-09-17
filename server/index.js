/**
 * AIPLAY Studio — local server.
 *
 * Serves the UI and brokers between it and one long-lived ComfyUI process.
 * Packaging as a desktop app (Tauri) wraps this unchanged; the frontend is web
 * either way, so nothing here is throwaway.
 */
import http from "node:http";
import { readFile, stat, writeFile, unlink, mkdir, readdir, rename, copyFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { WebSocketServer } from "ws";
import { config, prefsSnapshot } from "./config.js";
import { createVfxRoutes } from "./vfx/routes.js";
import { createScoreRoutes } from "./score/routes.js";
import { createDawRoutes } from "./daw/routes.js";
/* The Video lab (FORK): compare one prompt across engine configurations, the
 * self-explaining quality selector, and the turbo toggles. Additive — it owns
 * /api/videolab and nothing else. */
import { createVideoLabRoutes } from "./videolab/routes.js";
/* DAWUI: pushes DAW document revisions onto the /live socket below, so an
 * agent's MCP edit lands in an open DAW page without a refresh (report §13a). */
import { createDawLive } from "./daw/live.js";
import { createEarRoutes } from "./daw/ear.js";
import os from "node:os";
import { deriveTitle, videoEngine, videoReady, resolveVideoEngine, enhanceCost, guideStrengths, ZIMAGE_PRESET, buildYue2ComfyGraph } from "./workflow.js";
import { ComfySupervisor } from "./comfy.js";
/* THE ENGINE DOOR. `comfy` supervises the process; `engine` is the only thing
 * in this tree that talks to it — one client, one ledger entry per prompt,
 * written before the POST. Nothing else here may construct an engine URL. */
/* Aliased for the same reason art.js aliases it: `engine` is already the name
 * of an image/video MODEL throughout this file, and a bare import would be
 * shadowed inside the very handlers that need the door. */
import { engine as engineDoor } from "./engine/client.js";
import { createEngineRoutes } from "./engine/routes.js";
import { JobRunner } from "./jobs.js";
import { Library } from "./library.js";
import { BatchRunner } from "./batch.js";
import { gpuStatus, ramStatus } from "./gpu.js";
import { ArtRunner, COVER_DIR, LRC_DIR, CLIP_DIR, IMAGE_DIR, coverNameFor } from "./art.js";
import { setSecret, clearSecret, secretStatus, protectionAvailable } from "./secrets.js";
import { apiStatus, spendSummary, estimateUsd, PROVIDERS } from "./apiEngine.js";
import { listCustom, CUSTOM_DIR, TOKENS, KINDS } from "./customWorkflows.js";
import { ModelManager, diskFree, CATALOG, MODEL_TO_CAPABILITY, modelLabel, modelPageUrl, engineFromModelFile } from "./models.js";
import { probeModel, loadableAs, presetFor, loraFits } from "./detect.js";
import {
  scanBases, extraBases, uniqueDirs, countByFolder, shelfOf, pickFolderDialog,
} from "./localmodels.js";
import { readMachine, fitFor, recommendFor, FIT_STATES } from "./fit.js";
import { createPersonaStore, applyPersona, personaFits } from "./personas.js";
import { createReviewStore, reviewState, makeThumbnailer, suggestExpect } from "./review.js";
import { createPromptStore } from "./prompts.js";
import { expand, enumerate, hasWildcards, combinations, createDuplicateGuard, resolveRepeat } from "./wildcards.js";
import * as reactive from "./reactive.js";
// Video Workflow (fork-only). See FORK_DELTA.md.
import { createMvRoutes } from "./mv/routes.js";
import { convert as convertAudio, FORMATS as AUDIO_FORMATS } from "./exportAudio.js";
import * as prov from "./provenance.js";
/* The welcome window and its capability catalogue (FORK). Additive — it owns
 * /api/welcome and nothing else, and the document it serves is the same one
 * server/mcp-welcome.js hands an agent. */
import { createWelcomeRoutes } from "./welcome/routes.js";
/* CHAT v1 (FORK): the first screen in the rail. Owns /api/chat and nothing
 * else. Its eight tools reach this same server's own routes over loopback rather
 * than importing the runners out of this file's closure — the shape
 * welcome/routes.js already uses for /api/models, and for the same reason: one
 * implementation of every behaviour, not a second that can disagree with it. */
import { createChatRoutes } from "./chat/routes.js";
import { createMusicInputRoutes } from "./music-input.js";
import { createMusicPlanRoutes } from "./music-plan.js";
import { createAvatarRoutes } from "./mesh/avatar.js";
import { fit, rungArgs, fp8Allowed, maxTokensFor, GENERATION_CAP_SECONDS, CONTEXT_SECONDS } from "./music/yue_fit.js";
import { cudaCapability } from "./mesh/runner.js";
/* The YuE2 door's own refusals, answered at the click rather than as a failed
 * job minutes later: bracketed section labels, and a kit that is not there.
 * YUE_MODEL is the name the door writes as data.model on its own ledger rows
 * — "yue2", the key models.js's rights map is keyed by. */
import { refuseLyrics, yueStatus, YUE_MODEL } from "./music/yue.js";
import { yueGgufStatus } from "./music/yue-gguf.js";
import { prepareGgufJob } from "./music-gguf-input.js";
import { GgufSetup } from "./music/gguf-setup.js";
/* Where a YuE2 render lands its score: the run folder is adopted by its
 * receipt, and the sheet is engraved so the ♪ badge on the row answers. */
import { createScore, adoptVersion, readScoreDoc, readScoreAbc, setSheet, findVersion } from "./score/store.js";
import { engrave, sheetCapability } from "./score/sheet.js";
import { transcribeHum } from "./music/hum.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(__dirname, "..", "web");

const comfy = new ComfySupervisor();
const jobs = new JobRunner(comfy);
const library = new Library();
/* `postBusy` lets a run hold the machine awake until its covers, stems, lyrics
 * and clips have drained — not merely until the last song rendered. Injected so
 * batch.js keeps knowing nothing about the art runner. */
/**
 * One picture or one clip for an overnight run, through the app's OWN route.
 *
 * An internal request rather than a second copy of the render path. The manual
 * and overnight paths must not be able to drift, and they cannot if there is
 * only one of them — every guard, clamp, licence check, wildcard expansion and
 * duplicate check applies to a night exactly as it applies to a click. It costs
 * one loopback round trip against a render measured in tens of seconds.
 *
 * The ACTOR the run was started with rides along in the header actorFrom()
 * reads, so a night an agent scheduled is stamped agent:* on every picture,
 * rather than becoming "user" because the request came from localhost.
 */
async function renderMediaForBatch(kind, item, take, actor) {
  const base = `http://127.0.0.1:${config.uiPort}`;
  const headers = { "Content-Type": "application/json" };
  if (actor && actor !== "user") headers["x-aiplay-actor"] = actor;

  /* Resolve when the media LANDS, not when it is accepted. The art runner
   * announces both kinds by the `file` handle the route minted, so the wait is
   * an event rather than a poll, and a run advances the moment its step is
   * really finished. */
  const landed = (event, file) => new Promise((resolve, reject) => {
    const done = (e) => {
      if (e.file !== file) return;
      cleanup();
      resolve(event === "cover" ? (e.covers || []) : [e.clip].filter(Boolean));
    };
    const failed = () => {
      /* The art runner reports a failure by going idle with an error rather
       * than by emitting for this file, so the queue is what says so. */
      if (art.status().queued === 0 && !art.status().current) {
        cleanup();
        reject(new Error(art.lastError || "the render did not produce anything"));
      }
    };
    const cleanup = () => { art.off(event, done); art.off("update", failed); clearTimeout(t); };
    /* A ceiling, not a schedule: art.js already sizes its own per-render
     * deadline from the job. This only catches a step that vanished entirely,
     * which would otherwise stall the whole night on one item. */
    const t = setTimeout(() => { cleanup(); reject(new Error("step timed out")); }, 3 * 60 * 60 * 1000);
    art.on(event, done);
    art.on("update", failed);
  });

  if (kind === "image") {
    const r = await (await fetch(`${base}/api/image`, {
      method: "POST", headers,
      body: JSON.stringify({
        action: "create", prompt: item.prompt,
        engine: item.engine, checkpoint: item.checkpoint, negative: item.negative,
        width: item.width, height: item.height, steps: item.steps,
        cfg: item.cfg, count: item.count,
        /* No seed on purpose. Every take rolls its own, and the duplicate guard
         * catches a repeat that slips through anyway — which is the whole
         * reason an unattended run is safe to leave. */
      }),
    })).json();
    if (r.error) throw new Error(r.error);
    return await landed("cover", `image:${r.id}`);
  }

  if (kind === "video") {
    const r = await (await fetch(`${base}/api/video`, {
      method: "POST", headers,
      body: JSON.stringify({
        action: "create", prompt: item.prompt,
        seconds: item.seconds, width: item.width, height: item.height,
        steps: item.steps, negative: item.negative,
      }),
    })).json();
    if (r.error) throw new Error(r.error);
    return await landed("clip", r.file ?? `clip:${r.id}`);
  }

  throw new Error(`Unknown overnight kind: ${kind}`);
}


const batch = new BatchRunner(jobs, {
  renderMedia: renderMediaForBatch,
  postBusy: () => art.queue.length > 0 || !!art.current,
});
// Draws covers only while the music queue is empty — see art.js for why that is
// a hard requirement rather than politeness.
const art = new ArtRunner(comfy, jobs);

// A finished cover is metadata like any other, so it goes through the same
// sidecar the rest of the library uses.
art.on("cover", async ({ file, covers, thumbs, runId }) => {
  /* ⚠ A standalone image is not a cover.
   *
   * It rides the same engine and therefore the same event, but it belongs to no
   * track — writing it into the library sidecar would invent an `image:i123`
   * entry the library then tries to find audio for, and the tagging pass below
   * would look for a FLAC that does not exist. Handled by its own listener. */
  if (String(file).startsWith("image:")) return;
  if (covers?.length) library.remember(file, { cover: covers[0], covers, thumb: thumbs?.[0] || null });
  // A track's cover is AI-generated art drawn by an internal job: actor
  // system, model = the configured art engine. Registered per file written.
  for (const name of covers || []) {
    provNote("library", {
      actor: "system", type: "generate", asset: `covers/${name}`,
      /* THE JOIN, added here and at every other `generate` seam in this file.
       * `model` and `for` are what this line has always said; `runId` is what
       * makes the rest recoverable — /api/provenance?asset=engine/<runId>
       * answers with the graph, the prompt, the seed, the model FILES, the
       * elapsed time and the SHA-256 of the picture. Purely additive: every
       * existing reader of this event is unaffected. */
      data: { model: config.art.engine || "flux2", for: file, runId: runId ?? null },
    });
  }
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
    // The re-tag must not drop the marker or the record the first pass wrote.
    ...(await songProvMeta(file)),
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
art.on("restyled", ({ clip, seconds, meta, runId }) => {
  if (clip && seconds) clipTimes.set(clip, seconds);
  if (clip && meta) clipMeta.set(clip, meta);
  if (clip) {
    saveClipStore();
    // A restyle is a NEW ai-generated clip derived from an existing one.
    provNote("library", {
      actor: "system", type: "generate", asset: `clips/${clip}`,
      data: { model: meta?.engine || config.video.engine || null,
              derivedFrom: meta?.source ? `clips/${meta.source}` : null, op: "restyle",
              runId: runId ?? null },
    });
  }
  push(jobs.snapshot());
});
art.on("enhanced", ({ source, clip, seconds, meta, owner }) => {
  // An Overnight run's row is ticked here, not where the job was queued: the
  // stage is only done when the file exists.
  if (owner) batch.noteStage(owner, "enhance", clip ? "done" : "failed");
  if (clip && seconds) clipTimes.set(clip, seconds);
  if (clip && meta) clipMeta.set(clip, meta);
  if (clip) {
    saveClipStore();
    /* Enhancement (interpolate/upscale) is algorithmic processing of an
     * existing clip, not fresh generation — an `edit` by the system. It never
     * promotes anything toward a human class (only user edits do). */
    provNote("library", {
      actor: "system", type: "edit", asset: `clips/${clip}`,
      data: { op: "enhance", derivedFrom: source ? `clips/${source}` : null },
    });
  }
  push(jobs.snapshot());
});
/* A standalone image has no track to be written against, so its provenance
 * lives in the same side-map that standalone clips use. */
art.on("cover", ({ file, covers, seed, durationMs, engine, checkpoint, runId }) => {
  if (!file.startsWith("image:") || !covers?.length) return;
  const prompt = pendingImagePrompt.get(file) || "";
  const actor = pendingImageActor.get(file) || "system";
  const wildOf = pendingImageWild.get(file) || null;
  for (const name of covers) {
    imageMeta.set(name, { prompt, seed, at: Date.now(),
                          durationMs: durationMs ?? null, engine: engine || "flux2",
                          /* Which FILE, not just which engine. "checkpoint" names
                           * one of however many .safetensors the user has on the
                           * shelf, so without this the answer to "what made this?"
                           * is a category rather than a model. */
                          checkpoint: checkpoint ?? null,
                          ...(wildOf || {}) });
    // Generated-media registration: the image entered the library here.
    provNote("library", {
      actor, type: "generate", asset: `images/${name}`,
      data: { model: engine || "flux2", promptHash: prompt ? `sha256:${prov.sha256hex(prompt)}` : null,
              /* ADDED beside `model`, never replacing it: existing ledger lines
               * and the provenance tests both read `model`, and a hash chain is
               * not a thing to rewrite the meaning of. For the checkpoint engine
               * this is the field that actually identifies the weights. */
              checkpoint: checkpoint ?? null,
              seed: seed ?? null,
              runId: runId ?? null },
    });
  }
  pendingImagePrompt.delete(file);
  pendingImageActor.delete(file);
  pendingImageWild.delete(file);
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

art.on("clip", ({ file, clip, seconds, meta, runId }) => {
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
  // Generated-media registration: a rendered clip is ai-generated video.
  if (clip) {
    provNote("library", {
      actor: "system", type: "generate", asset: `clips/${clip}`,
      data: { model: meta?.engine || config.video.engine || null,
              for: file.startsWith("clip:") ? null : file,
              seed: meta?.seed ?? null,
              runId: runId ?? null },
    });
  }
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

/* ── the provenance ledger (server/provenance.js) ──────────────────────────
 *
 * Capture seams in this file append events; a ledger failure is logged loudly
 * and never costs the media (same bargain tagging already makes). `provNote`
 * is the one wrapper so no seam hand-rolls its own .catch. */
const provNote = (scope, evt) =>
  prov.append(scope, evt).catch((err) =>
    console.error(`  [provenance] event lost (${evt?.type}/${evt?.asset}): ${err.message}`));

/**
 * The tagging meta's provenance fields for a library audio file: the pinned
 * Tier-1 marker inputs plus — when the user's embed toggle is on — the Tier-2
 * origin map and ledger chain head. tag_audio.py writes the marker no matter
 * what this returns; these fields only make it specific (class, generator)
 * and attach the rich record.
 */
async function songProvMeta(file, { generator = "MiniMax-Music3", cls } = {}) {
  const out = { tier2: config.provenance.embedRecord !== false };
  try {
    const s = await prov.summarize("library", file);
    const klass = cls || s.class || "ai-generated";
    const marker = prov.markerFor(klass, { model: s.model || generator, media: "audio" });
    out.digitalSourceType = marker.digitalSourceType;
    out.disclosure = marker.disclosure;
    out.generator = s.model || generator;
    if (out.tier2) {
      out.provenance = {
        originMap: {
          class: klass, model: s.model || generator,
          editsBy: s.editsBy, authoredBy: s.authoredBy, events: s.events,
        },
        chainHead: s.chainHead,
      };
    }
  } catch (err) {
    console.error(`  [provenance] summary failed for ${file}: ${err.message}`);
    if (cls) {
      const marker = prov.markerFor(cls, { model: generator, media: "audio" });
      out.digitalSourceType = marker.digitalSourceType;
      out.disclosure = marker.disclosure;
      out.generator = generator;
    }
  }
  return out;
}

/**
 * The two-tier embed payload for one library image (SPEC D3.1): the marker
 * always, the record only while the user's embed toggle is on. Class comes
 * from the ledger; images that predate it fall back to what imageMeta knows —
 * an engine means ai-generated, otherwise the honest `composite` ("parts may
 * be AI-generated; origin partially unrecorded") rather than a guess.
 */
async function imageProvenancePayload(name) {
  const m = imageMeta.get(name) || {};
  let cls = null, model = m.engine || null, summary = null, chainHead = null;
  try {
    const s = await prov.summarize("library", `images/${name}`);
    if (s.events > 0) {
      cls = s.class; model = s.model || model; chainHead = s.chainHead;
      summary = { class: s.class, model: s.model, editsBy: s.editsBy,
                  authoredBy: s.authoredBy, events: s.events };
    }
  } catch (err) {
    console.error(`  [provenance] image summary failed for ${name}: ${err.message}`);
  }
  if (!cls) cls = m.engine ? "ai-generated" : "composite";
  const marker = prov.markerFor(cls, { model, media: "image" });
  const record = config.provenance.embedRecord === false ? null : {
    prompt: m.prompt || undefined,
    seed: m.seed ?? undefined,
    model: model || undefined,
    editedFrom: m.editedFrom || m.cutoutFrom || m.upscaledFrom || undefined,
    originMap: summary || { class: cls, model, note: "pre-ledger item; class from the image store" },
    chainHead: chainHead || undefined,
  };
  return { cls, payload: { marker, record } };
}

/* Provenance for standalone images. The cover event reports which files it
 * wrote but not what was asked for, so the prompt is parked here between the
 * request and the result. */
/* ComfyUI stamps the graph it ran into the PNG's own tEXt chunk, so a picture
 * made before the checkpoint was ever recorded can still say what painted it —
 * read exactly, not inferred. Walks chunks and stops at IDAT: metadata precedes
 * the pixels, and there is no reason to pull megabytes of image data into
 * memory to find a text field. Returns null for anything that is not a PNG we
 * wrote, which includes every exported jpg/webp and every SVG. */
async function pngComfyGraph(file) {
  let buf;
  try { buf = await readFile(file); } catch { return null; }
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (type === "IDAT" || type === "IEND") break;
    if (type === "tEXt" && off + 8 + len <= buf.length) {
      const chunk = buf.subarray(off + 8, off + 8 + len);
      const nul = chunk.indexOf(0);
      if (nul > 0 && chunk.toString("latin1", 0, nul) === "prompt") {
        try { return JSON.parse(chunk.toString("utf8", nul + 1)); } catch { /* not ours */ }
      }
    }
    off += 12 + len;
  }
  return null;
}

/* CheckpointLoaderSimple is what every checkpoint graph in workflow.js loads
 * through; the prefix match also catches CheckpointLoader and the Config
 * variant, so a graph built by hand in ComfyUI and dropped into the library
 * reads back too. */
function modelFromGraph(graph) {
  if (!graph || typeof graph !== "object") return null;
  for (const node of Object.values(graph)) {
    const ct = typeof node?.class_type === "string" ? node.class_type : "";
    /* A user's own file. The prefix also catches CheckpointLoader and the
     * Config variant, so a graph built by hand in ComfyUI and dropped into the
     * library reads back too. */
    if (ct.startsWith("CheckpointLoader")) {
      const n = node.inputs?.ckpt_name;
      if (typeof n === "string" && n) return { engine: "checkpoint", checkpoint: n };
    }
    /* Everything this app ships. FLUX.2, Z-Image and Ideogram are DiTs loaded
     * as a bare UNet, which is why looking only for CheckpointLoader found
     * nothing on all of them. */
    if (ct === "UNETLoader" || ct === "UnetLoaderGGUF") {
      const e = engineFromModelFile(node.inputs?.unet_name);
      if (e) return { engine: e, checkpoint: null };
    }
  }
  return null;
}

/* Keyed by name+mtime, so replacing a file re-probes it and nothing else does. */
/* What has been rendered recently, so an overnight run with a forgotten fixed
 * seed makes different pictures instead of one picture two hundred times. In
 * memory on purpose: the question is only ever "did I just do this", and a
 * restart is a fine moment to stop caring. */
const imageDupGuard = createDuplicateGuard({ limit: 500 });

/* The character shelf. Beside the image store, because a persona is about the
 * pictures and travels with them. */
const personas = createPersonaStore(path.join(config.outputDir, "images", "_personas.json"));
/* Templates worth keeping. Beside the personas for the same reason: both are
 * about making the next picture, and both are a few kilobytes of text. */
const promptShelf = createPromptStore(path.join(config.outputDir, "images", "_prompts.json"));

const ckptProbeCache = new Map();

const imageMeta = new Map();
const pendingImagePrompt = new Map();
/* WHO asked for the image — parked beside the prompt for the same reason, so
 * the ledger's generate event can carry the honest actor (user vs agent:*)
 * once the render lands minutes later. */
const pendingImageActor = new Map();
/* The template and the choices that expanded it. Without these a picture from
 * an overnight run can be admired and never made again — which is the whole
 * reason dynamic prompts record anything at all. */
const pendingImageWild = new Map();
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

/* WHAT WAS ASKED FOR, and whether anyone checked (server/review.js).
 *
 * Kept beside the prompt because it is the same kind of fact: the prompt is
 * what was said, the checklist is what was MEANT, and until now only the first
 * survived the render. A picture with no entry here is unchecked, which is the
 * honest default — not "fine". */
const reviews = createReviewStore(path.join(config.outputDir, "images", "_reviews.json"));
const imageThumb = makeThumbnailer(config.python);

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
const ggufSetup = new GgufSetup();
models.on("update", () => push(jobs.snapshot()));

/**
 * MAY A CLIP BE RENDERED — and if so, on WHICH engine.
 *
 * Both video entry points asked this and both answered it wrong in the same
 * way: they looked up the capability for `config.video.engine` and, when its
 * weights were absent, told the user to "open the Models screen". On the
 * shipped default that named LTX 2.5, whose repo is gated — so the Models
 * screen had no button, and the instruction was a dead end. See
 * resolveVideoEngine() in workflow.js for the whole shape of that bug.
 *
 * One gate now, for both, and it returns the RESOLVED engine rather than the
 * configured one. Which matters beyond the error text: on a machine holding H3
 * while the setting says LTX, the old code refused a render the machine could
 * perfectly well do. Now it renders, on H3, and says which.
 *
 * The refusal it does produce carries a capability id that the Models screen
 * has an actual button for, plus the licence acknowledgement that button will
 * demand — a suggestion that bounces at the downloader is not a fix either.
 */
async function videoWeightsGate() {
  const resolution = resolveVideoEngine();
  if (resolution.ready) return { engine: resolution.key, resolution };

  const cat = await models.status();
  const want = resolution.get;
  const cap = want ? cat.find((c) => c.id === want.capabilityId) : null;
  const missingGb = cap ? ((cap.totalBytes - cap.haveBytes) / 1e9).toFixed(1) : null;

  return {
    error: {
      error: want
        ? `No video weights on this machine yet. Get ${want.label}`
          + (missingGb ? ` (${missingGb} GB)` : "")
          + " from the Models screen — it is the video engine Studio can download for you."
          + (want.region ? ` Its licence grants no rights inside ${want.region.excluded.join(", ")}; the download asks you to confirm first.` : "")
        : `${resolution.label} is not downloaded yet. Open the Models screen.`,
      /* Named so the page can scroll to the row and press the button rather
       * than leaving the reader to find it among seventeen. */
      needsModel: want ? want.capabilityId : null,
      needsRegionAck: !!want?.region,
      region: want?.region || null,
      /* The gated engine, mentioned but never prescribed. Somebody who wants
       * the faster one should be able to find the hand-fetch; nobody should be
       * pointed at it by a refusal. */
      alsoGated: resolution.alsoGated || [],
      configuredEngine: resolution.configured,
    },
  };
}

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
// Each package is probed in the interpreter that RUNS it, or the answer is about
// nothing: demucs runs from config.systemPython (art.js), faster_whisper from
// config.lyrics.python (art.js), and those may differ from each other and from
// SYSTEM_PYTHON. The Models screen once reported faster_whisper present in an
// interpreter that never launches it. `probed` says which python answered.
const PACKAGE_PROBES = () => {
  const sys = config.systemPython || SYSTEM_PYTHON;
  const groups = new Map();
  const add = (py, m) => groups.set(py, [...(groups.get(py) || []), m]);
  for (const m of ["demucs", "torch", "av", "numpy"]) add(sys, m);
  add(config.lyrics?.python || sys, "faster_whisper");
  return [...groups.entries()];
};
function probeOne(py, mods) {
  return new Promise((resolve) => {
    const proc = spawn(py, ["-c",
      `import importlib.util as u,json;print(json.dumps({m:u.find_spec(m) is not None for m in ${JSON.stringify(mods)}}))`],
      { windowsHide: true });
    let so = "";
    proc.stdout.on("data", (d) => (so += d));
    proc.on("exit", () => { try { resolve(JSON.parse(so)); } catch { resolve({}); } });
    proc.on("error", () => resolve({}));
  });
}
let probedBy = {};
async function pythonPackages() {
  if (config.musicOnly) return {};
  if (packageCache && Date.now() - packageCache.at < 30_000) return packageCache.value;
  const value = {};
  const by = {};
  for (const [py, mods] of PACKAGE_PROBES()) {
    const got = await probeOne(py, mods).catch(() => ({}));
    for (const m of mods) { value[m] = !!got[m]; by[m] = py; }
  }
  probedBy = by;
  packageCache = { at: Date.now(), value };
  return value;
}

// When a job finishes: stamp provenance into the file and record what the file
// cannot say. `renderSeconds` is how long it took to make; `durationSeconds` is
// how long the music is — two different numbers that were previously conflated.
const tagged = new Set();
/* EVERY SONG'S OUTCOME, IN STUDIO'S OWN CONSOLE.
 *
 * The console is what the launcher's Log shows, and until this listener it
 * said nothing at all about songs: a render that failed after it was queued,
 * or "finished" without writing anything new, left its only trace in the page's
 * job object and the ledger. One line per state change, for every engine,
 * because the runner's many exits (socket error, ComfyUI rejection, watchdog,
 * native driver) all end in the same `update` event. */
const jobSeen = new Map();
jobs.on("update", (snap) => {
  for (const j of [snap.current, ...(snap.history || []).slice(0, 10)]) {
    if (!j || jobSeen.get(j.id) === j.state) continue;
    jobSeen.set(j.id, j.state);
    const name = `"${j.title || "Untitled"}"`;
    if (j.state === "running") {
      // ASCII separators: a legacy cmd console on a non-UTF-8 codepage renders "·" as "Â·".
      console.log(`  [music] started ${name} | ${j.engine || "minimax-music3"} | seed ${j.seed}`);
    } else if (j.state === "done" && j.cached) {
      console.warn(`  [music] WARNING nothing new rendered for ${name}: identical to an earlier take, `
        + `served from ComfyUI's cache (${j.file}). Change the seed for a new song.`);
    } else if (j.state === "done" && !j.file) {
      console.warn(`  [music] WARNING ${name} finished but no audio file was found in the output folder.`);
    } else if (j.state === "done") {
      console.log(`  [music] done ${name} -> ${j.file} in ${j.durationSeconds ?? "?"} s`);
    } else if (j.state === "failed") {
      console.error(`  [music] FAILED ${name}: ${j.error || "no reason was given"}`);
    } else if (j.state === "cancelled") {
      console.log(`  [music] cancelled ${name}`);
    }
  }
});

jobs.on("update", async (snap) => {
  const h = snap.history[0];
  /* A cache hit is not a new song: filing it would add a second library row
   * for a file that already has one. */
  if (!h || h.state !== "done" || !h.file || h.cached || tagged.has(h.file)) return;
  tagged.add(h.file);

  const job = jobs.history.find((j) => j.file === h.file) || {};
  /* Which engine made it decides the model name on every row below — the
   * ledger's, the library's and the file's tags. The two carry different
   * rights classes, so a wrong name here is a wrong licence, not a typo. */
  const isGguf = job.engine === "yue2-gguf";
  const isYue = job.engine === "yue2" || isGguf;
  /* The same YuE2 3B weights through ComfyUI's nodes: filed under the same
   * model name (and so the same CC BY-NC rights row), with its own params. */
  const isYueComfy = job.engine === "yue2-comfy";
  /* ⚠ "yue2", NOT "YuE2-3B". provenance.js stampRights() resolves the rights
   * of a generate row through models.js MODEL_TO_CAPABILITY, keyed by the
   * lowercase name the renderer writes as data.model — and the renderer
   * (yue.js YUE_MODEL) writes "yue2". The first version of this line wrote
   * the human name, which mapped to nothing, so the first Create-made song
   * (aiplay_yue2_439df5cf.flac) carries a rights row reading `unknown` in an
   * append-only ledger. The Library badge keeps its own "YuE2 3B" below. */
  const modelName = isGguf ? "yue2-gguf" : (isYue || isYueComfy) ? YUE_MODEL : "MiniMax-Music3";

  /* A YuE2 render lands its SCORE too: the run folder is adopted into the
   * score store by its receipt (the version the ♪ badge on the row links to)
   * and engraved, so the sheet exists before anyone clicks. Rendered from a
   * draft in the panel, the new version hangs off that draft as its parent;
   * otherwise a score is created under the song's title. Failure here loses
   * the sheet, never the song — the audio is already filed by the runner. */
  let score = null;
  if (job.engine === "yue2" && job.yue?.dir) {
    try {
      let slug = job.scoreSlug || null;
      /* The parent is kept only when it still exists in the score it was
       * loaded from; a slug that no longer resolves gets a fresh score and NO
       * parent, because adoptVersion refuses a parent it cannot find and the
       * refusal would lose the sheet for a lineage claim nobody can check. */
      const loaded = slug ? await readScoreDoc(slug).catch(() => null) : null;
      if (slug && !loaded) slug = null;
      if (!slug) slug = (await createScore(h.title || job.title || "Untitled")).slug;
      const parent = loaded && job.scoreVersion && findVersion(loaded, job.scoreVersion) ? job.scoreVersion : null;
      const by = prov.normalizeActor(job.actor);
      const adopted = await adoptVersion(slug, {
        dir: job.yue.dir, by, parent,
        note: `rendered from Create — ${job.rung?.label || "Standard"} configuration`
          + (job.quantization === "fp8" ? ", 8-bit AR" : "")
          + (job.narSteps === 16 ? ", 16 solver steps" : ""),
      });
      score = { slug, version: adopted.id };
    } catch (err) {
      console.error(`  [score] ${h.file}: the run was not adopted — ${err.message}`);
    }
  }
  /* The sheet is engraved AFTER the song is filed (see the end of this
   * handler): engraving runs Edge twice with a minute's timeout each, and a
   * hang in that window used to leave the song with no sidecar row and no
   * ledger rows for up to two minutes — the song is the thing that must not
   * be lost, the sheet can be engraved again from the ⋯ menu. */

  // An extension arrives as its own file containing only the new section. Splice
  // it onto the original at the resume point so the user gets one whole song.
  // Both source files are kept: the original is untouched, so a bad extension
  // costs nothing but disk.
  if (job.extendedFrom) {
    try {
      /* A YuE2 continuation is a WHOLE song (the kept part re-rendered by the
       * NAR, then the new material), so only its tail past the seam is taken;
       * a MiniMax extension file holds the new section alone. */
      const isYueExt = job.engine === "yue2";
      const at = isYueExt ? (job.fromSeconds || 0) : (job.resumeFrames || 0) / 25;
      const joined = await library.joinExtension(job.extendedFrom, h.file, at, { from: isYueExt ? at : 0 });
      if (joined) {
        // Splice the trajectories too, or a second extension would resume from
        // the last section alone and forget the song it belongs to. A YuE2
        // continuation's run folder already holds the whole performance.
        const priorCodes = isYueExt ? null : library.meta.get(job.extendedFrom)?.codes;
        const chained = isYueExt ? null : await library.spliceTrajectory(
          priorCodes, h.codes, job.resumeFrames || 0);
        library.remember(joined, {
          title: h.title, seed: h.seed, caption: job.caption, lyrics: job.lyrics,
          model: job.model, steps: h.steps,
          codes: chained || h.codes,
          ...(isYueExt ? {
            engine: "yue2", yueDir: job.yue?.dir ?? null, cot: job.cot || "full",
            quantization: job.quantization || "none", rights: "CC BY-NC 4.0 — not for sale",
          } : {}),
          extendedFrom: job.extendedFrom,
          // WHERE the model rejoined, so this take's own new material can later
          // be isolated. Without it a merge cannot tell which part of a branch is
          // new, and every branch would drag a copy of the parent along with it.
          joinedAt: at,
          createdAt: Date.now(),
        });
        console.log(`  extension joined at ${at.toFixed(1)}s -> ${joined}`
          + (chained ? " (trajectory chained)" : " (trajectory NOT chained)"));
        // The joined file is a new library asset assembled from two renders.
        provNote("library", {
          actor: prov.normalizeActor(job.actor), type: "generate", asset: joined,
          /* `runId` is the EXTENSION's render, which is the only one that
            * happened here — the join itself is a splice on disk, not a
            * render. Saying so beats leaving the field out. */
          data: { model: "MiniMax-Music3", modelVersion: job.model || "int8",
                  op: "extend-join", extendedFrom: job.extendedFrom, joinedAt: at,
                  runId: job.runId ?? null },
        });
      }
    } catch (err) {
      console.error(`  join failed (both parts kept): ${err.message}`);
    }
  }

  /* ── the ledger: this is where a generated song is REGISTERED, so this is
   * where its provenance events land (SPEC D1.2, R6.1). The actor was stamped
   * at the API boundary when the job was enqueued: "user" for the Create
   * form, "agent:<name>" for MCP, "system" when nothing attributable asked
   * (overnight batches, watchdog regens). Typed lyrics are a human-authored
   * contribution ONLY when a human typed them — an agent's lyrics are
   * recorded under the agent's own name, which is the entire point. */
  {
    const actor = prov.normalizeActor(job.actor);
    if ((job.lyrics || "").trim() && !h.instrumental) {
      provNote("library", {
        actor, type: "author_text", asset: h.file,
        data: { field: "lyrics", chars: job.lyrics.length,
                textHash: `sha256:${prov.sha256hex(job.lyrics)}` },
      });
    }
    provNote("library", {
      actor, type: "generate", asset: h.file,
      data: {
        model: modelName, modelVersion: (isYue || isYueComfy) ? "3B" : (job.model || "int8"),
        promptHash: `sha256:${prov.sha256hex(`${job.caption || ""}\n${job.lyrics || ""}`)}`,
        seed: h.seed, mixSeed: h.mixSeed ?? null,
        /* The parameters that changed WHICH ARITHMETIC made the song: for
         * YuE2 the chain-of-thought mode, the guidance, the rung and the
         * precision, all of which the door's own ledger row (song/<runId>)
         * carries in full — this is the join to it. */
        params: isGguf
          ? { runtime: "audiocpp", precision: job.quantization || "q4_0", cot: job.cot, narSteps: job.narSteps || 32,
              cfgScale: job.cfgScale ?? null, runId: job.yueGguf?.runId ?? null,
              scoreSupplied: !!job.abc }
          : isYueComfy
          ? { runtime: "comfy", checkpoint: job.yue2Checkpoint || null, cot: job.cot || "full",
              narSteps: job.narSteps || 32, maxDuration: job.maxDuration ?? null,
              lora: job.lora || null, loraStrength: job.lora ? (job.loraStrength ?? 1) : null }
          : isYue
          ? { cot: job.cot, cfgScale: job.cfgScale ?? null, rung: job.rung?.id ?? null,
              offloadAr: !!job.rung?.offloadAr, queryChunk: job.rung?.queryChunk ?? 0,
              quantization: job.quantization || "none", scoreSupplied: !!job.abc,
              narSteps: job.narSteps || 32, maxTokensAsked: job.maxTokens || null,
              score: score ? `${score.slug}/${score.version}` : null }
          : { steps: h.steps, cfg: job.cfg, shift: config.sampling.shift },
        reroll: !!h.reroll, extendedFrom: job.extendedFrom || null,
        ...(job.musicInput ? { musicInput: job.musicInput } : {}),
        instrumental: !!h.instrumental,
        /* Null on an API render, which is honest: that song was made on
         * somebody else's hardware and there is no local engine record of it.
         * A local render's runId leads to the graph, both cfgs, the model
         * files and the wall time. */
        runId: job.runId ?? null,
      },
    });
  }

  library.remember(h.file, {
    title: h.title, seed: h.seed, mixSeed: h.mixSeed,
    /* The Library's model column and its "YuE2 3B" badge read `model`; the
     * MiniMax value is a precision (int8/fp16/fp32) because that engine has
     * one weight file per precision. YuE2's 32 is the NAR's ODE step count,
     * the number the vendor's own protocol fixes. */
    steps: (isYue || isYueComfy) ? (job.narSteps || 32) : h.steps,
    cfg: isYue ? (job.cfgScale ?? null) : isYueComfy ? 1 : job.cfg,
    model: isGguf ? (job.quantization === "q8_0" ? "YuE2 GGUF Q8" : "YuE2 GGUF Q4")
      : isYueComfy ? "YuE2 3B (ComfyUI)" : isYue ? "YuE2 3B" : job.model,
    engine: job.engine || "minimax-music3",
    ...(isGguf ? {
      warnings: job.warnings || [], generationLimits: job.generationLimits ?? null,
    } : {}),
    ...(isYue ? {
      cot: job.cot || "full", quantization: job.quantization || "none",
      rung: job.rung?.id ?? null,
      // The run folder: the whole performance, which is what Extend replays.
      yueDir: job.yue?.dir ?? null,
      scoreSlug: score?.slug ?? null, scoreVersion: score?.version ?? null,
      durationSeconds: Number.isFinite(job.audioSeconds) ? Math.round(job.audioSeconds) : undefined,
      rights: "CC BY-NC 4.0 — not for sale",
    } : {}),
    ...(isYueComfy ? {
      cot: job.cot || "full", checkpoint: job.yue2Checkpoint || null,
      lora: job.lora || null, loraStrength: job.lora ? (job.loraStrength ?? 1) : null,
      rights: "CC BY-NC 4.0 — not for sale",
    } : {}),
    caption: job.caption,
    // Kept so the song panel can show what actually produced the track. It is in
    // the FLAC tags too, but reading tags back per row would mean a subprocess
    // per track just to draw a list.
    lyrics: job.lyrics,
    // Path to the captured AR trajectory. Its presence is what makes a track
    // extendable — anything rendered before the capture patch has none, and
    // never will.
    codes: h.codes,
    ...(job.musicInput ? { musicInput: job.musicInput } : {}),
    instrumental: h.instrumental, preview: h.preview, reroll: h.reroll,
    renderSeconds: h.durationSeconds, createdAt: h.createdAt,
  });

  try {
    const meta = (isYue || isYueComfy)
      ? {
        title: h.title, caption: job.caption, lyrics: job.lyrics,
        seed: h.seed, steps: job.narSteps || 32, cfg: isYueComfy ? 1 : (job.cfgScale ?? "model default"),
        cot: job.cot || "full", quantization: isYueComfy ? (job.yue2Checkpoint || "comfy") : (job.quantization || "none"),
        ...(isYueComfy && job.lora ? { lora: `${job.lora} @ ${job.loraStrength ?? 1}` } : {}),
        model: modelName, date: new Date().toISOString().slice(0, 10),
        ...(score ? { score: `${score.slug}/${score.version}` } : {}),
        ...(await songProvMeta(h.file, { generator: modelName })),
      }
      : {
        title: h.title, caption: job.caption, lyrics: job.lyrics,
        seed: h.seed, mixSeed: h.mixSeed, steps: job.steps ?? config.sampling.steps,
        cfg: job.cfg ?? config.sampling.cfg, shift: config.sampling.shift,
        model: job.model || "int8", date: new Date().toISOString().slice(0, 10),
        // Tier-1 marker specifics + (toggle-governed) Tier-2 ledger summary.
        ...(await songProvMeta(h.file)),
      };
    const info = await library.tagFile(h.file, meta);
    if (info?.seconds) library.remember(h.file, { durationSeconds: Math.round(info.seconds) });
  } catch { /* never lose a track over a tag */ }

  /* Now the sheet — the song is filed, so a slow or hung engraver costs the
   * sheet and nothing else. Same call the score routes make. */
  if (score && sheetCapability().html !== false) {
    try {
      const doc = await readScoreDoc(score.slug);
      const v = findVersion(doc, score.version);
      const abc = await readScoreAbc(score.slug, score.version);
      const sheet = await engrave({ slug: score.slug, versionId: score.version, abc, title: doc.title,
        author: v?.author ?? doc.author ?? null, note: v?.note ?? null,
        audioSeconds: v?.audioSeconds ?? job.audioSeconds ?? null,
        /* The PDF is printed by Edge from the served page, so it needs an
         * http origin — the same one the score routes hand engrave(). */
        origin: `http://127.0.0.1:${config.uiPort}` });
      await setSheet(score.slug, score.version, sheet);
    } catch (err) {
      console.error(`  [score] ${h.file}: adopted as ${score.slug}/${score.version} but not engraved — ${err.message}`);
    }
  }

  // Ask for a cover. This only QUEUES — the runner waits for the music queue to
  // empty before touching the GPU, so an overnight batch draws all of its art at
  // the end rather than evicting the music models between every song.
  if (!h.preview && !config.musicOnly) {
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
/* ── Models screen: what is already on disk ────────────────────────────────
 * Every folder the engine loads weights from: the chosen models folder, the
 * base_path of every extra_model_paths YAML the engine is launched with, and
 * the install's own models folder. */
async function modelBases() {
  return uniqueDirs([
    config.modelsDir,
    ...(await extraBases(config.comfy.extraArgs)),
    path.join(config.comfyDir, "models"),
  ]);
}

/** Merge keys into settings.json without touching the rest of it. */
async function mergeSettings(next) {
  let current = {};
  try { current = JSON.parse(await readFile(config.settingsFile, "utf-8")); } catch { /* first write */ }
  await mkdir(path.dirname(config.settingsFile), { recursive: true });
  await writeFile(config.settingsFile, JSON.stringify({ ...current, ...next }, null, 2));
}

/** The weights on disk, catalogue or not, each labelled by its own header. */
async function localModelsPayload(cat) {
  const bases = await modelBases();
  const files = await scanBases(bases);
  const known = new Set(cat.flatMap((c) => (c.files || []).map((f) => f.name)));
  const standsIn = Object.fromEntries(Object.entries(config.modelOverrides || {}).map(([k, v]) => [v, k]));
  const rows = [];
  for (const f of files) {
    let family = null, variant = null;
    if (/\.(safetensors|sft)$/i.test(f.name)) {
      const k = `local:${f.full}:${f.at}`;
      let probe = ckptProbeCache.get(k);
      if (!probe) { probe = await probeModel(f.full).catch(() => ({})); ckptProbeCache.set(k, probe); }
      family = probe.family ?? null;
      variant = probe.variant ?? null;
    }
    rows.push({
      folder: f.folder, shelf: f.shelf, name: f.name, base: f.base, bytes: f.bytes,
      family, variant, known: known.has(f.name), standsInFor: standsIn[f.name] || null,
    });
  }
  return { modelsDir: config.modelsDir, bases, files: rows };
}

/* ── the music model picker (Models screen and Music tab) ───────────────────
 * One list of concrete choices — an engine plus the build it renders with —
 * each saying whether it can render on this machine right now. Cached for a few
 * seconds because /api/status is polled by every open tab. */
let musicChoicesCache = { at: 0, value: null };
/* Shown without the extension — "minimax_music3_dit_fp16", not the file. */
const bareName = (n) => String(n || "").replace(/\.(safetensors|sft|gguf|ckpt|pt|pth|bin)$/i, "");
/* MiniMax Music 3 on an AMD card: the weights fit and the graph runs, but the
 * renders reported from this machine were not listenable. Said wherever the
 * engine can be chosen, rather than left to be found by rendering. */
const onAmd = () => config.torchBackend === "rocm" || config.gpu?.vendor === "amd";

/* Whether this process starts ComfyUI. Always in full Studio; in music-only
 * only when a YuE2 checkpoint makes YuE2-through-ComfyUI possible. Sent in
 * /api/status so the launcher knows whether to wait for the engine. */
let comfyWanted = !config.musicOnly;

/** YuE2 checkpoints in any checkpoints folder the engine loads from. */
async function findYue2Checkpoints() {
  const seen = new Set();
  return (await scanBases(await modelBases()))
    .filter((f) => f.folder === "checkpoints" && /yue2?/i.test(f.name) && /\.(safetensors|sft)$/i.test(f.name))
    .map((f) => f.name)
    .filter((n) => (seen.has(n) ? false : seen.add(n)));
}
const MINIMAX_AMD_WARNING = "Buggy on AMD (ROCm): it fits and runs, but renders usually come out broken "
  + "or unlistenable. Use YuE2 3B through ComfyUI instead.";
async function musicModelChoices(cat) {
  if (!cat && musicChoicesCache.value && Date.now() - musicChoicesCache.at < 5000) return musicChoicesCache.value;
  cat ||= await models.status();
  const byId = Object.fromEntries(cat.map((c) => [c.id, c]));
  const out = [];
  const minimax = byId.engine;
  if (config.music.engines["minimax-music3"] && minimax && !config.musicOnly) {
    const dit = minimax.files.find((f) => f.name === config.models.dit);
    const restReady = minimax.files.filter((f) => f !== dit).every((f) => f.present);
    const bases = await modelBases();
    const onDisk = async (name) => {
      for (const base of bases) {
        for (const folder of ["diffusion_models", "unet"]) {
          if ((await stat(path.join(base, folder, name)).catch(() => null))?.size > 0) return true;
        }
      }
      return false;
    };
    const builds = [
      { precision: "int8", present: !!dit?.present, note: dit?.override ? `using ${bareName(dit.override)}` : null },
      { precision: "fp16", present: await onDisk(config.models.ditFp16), note: null },
      { precision: "fp32", present: await onDisk(config.models.ditFp32), note: "untested" },
    ];
    for (const b of builds) {
      out.push({
        value: `minimax-music3:${b.precision}`, engine: "minimax-music3", precision: b.precision,
        label: `MiniMax Music 3 · ${b.precision}`,
        available: restReady && b.present,
        note: [
          !restReady ? "text encoder or VAE missing" : !b.present ? "not on disk" : b.note,
          restReady && b.present && onAmd() ? "⚠ buggy on AMD" : null,
        ].filter(Boolean).join(" · ") || null,
      });
    }
  }
  if (config.music.engines["yue2-gguf"]) {
    const s = await ggufSetup.status().catch(() => ({}));
    const variants = Object.entries(s.variants || {});
    for (const [p, v] of (variants.length ? variants : [["q4_0", { ready: !!s.ready }]])) {
      out.push({
        value: `yue2-gguf:${p}`, engine: "yue2-gguf", precision: p,
        label: `YuE2 GGUF · ${p.replace(/_0$/, "").toUpperCase()}`,
        available: v?.ready === true,
        note: v?.ready ? "native runtime, NVIDIA CUDA" : "not installed",
      });
    }
  }
  /* YuE2 through ComfyUI: any YuE2 checkpoint in a checkpoints folder the
   * engine loads from — found by name, one choice per file. */
  if (config.music.engines["yue2-comfy"] && (!config.musicOnly || comfyWanted)) {
    const seen = new Set();
    const ckpts = (await scanBases(await modelBases()))
      .filter((f) => f.folder === "checkpoints" && /yue2?/i.test(f.name) && /\.(safetensors|sft)$/i.test(f.name))
      .filter((f) => (seen.has(f.name) ? false : seen.add(f.name)));
    for (const f of ckpts) {
      const build = bareName(f.name).replace(/^yue2?[_-]?3b[_-]?/i, "") || bareName(f.name);
      out.push({
        value: `yue2-comfy:${f.name}`, engine: "yue2-comfy", precision: null, checkpoint: f.name,
        label: `YuE2 3B · ${build}`, available: true, note: "via ComfyUI",
      });
    }
    if (!ckpts.length) {
      out.push({
        value: "yue2-comfy", engine: "yue2-comfy", precision: null, checkpoint: null,
        label: "YuE2 3B (ComfyUI)", available: false, note: "no YuE2 checkpoint in a checkpoints folder",
      });
    }
  }
  if (config.music.engines.yue2 && byId.musicYue2 && !config.musicOnly) {
    out.push({
      value: "yue2", engine: "yue2", precision: null, label: "YuE2 3B (Python kit)",
      available: !!byId.musicYue2.ready, note: byId.musicYue2.ready ? null : "not installed",
    });
  }
  musicChoicesCache = { at: Date.now(), value: out };
  return out;
}

/* Which collapsible section of the Models screen a capability sits in. */
const MODEL_GROUPS = [
  { id: "music", label: "Music & audio" },
  { id: "images", label: "Images" },
  { id: "video", label: "Video" },
  { id: "3d", label: "3D" },
];
function modelGroupOf(c) {
  if (c.makes === "mesh") return "3d";
  if (c.makes === "picture" || c.id === "imageCutout" || c.id === "upscale") return "images";
  if (/^(video|pose|interpolate)/.test(c.id)) return "video";
  return "music";
}

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

/* The keep-awake child a plan run holds open. batch.js owns four identical
 * lines privately and its file belongs to another strand, so this one lives
 * here for the same reason renderTimeline and saveStudioProject do: the process
 * is index.js's business, and the route should ask for an outcome rather than
 * learn how to get one. Null means nothing is holding the machine up. */
let mvAwake = null;

/* Video Workflow routes. Built here because this is the first point where every
 * dependency it borrows exists — the library, the art runner and the beat
 * cache below. Injected rather than imported so server/mv/ stays additive. */
const mvRoutes = createMvRoutes({
  json, readBody, library, art, beatsFor, LRC_DIR, CLIP_DIR, IMAGE_DIR, COVER_DIR,
  /* THE PLAN OBJECT's two dependencies, and they are the whole of its wiring.
   *
   * `provenance` is the same module every other surface writes through, so a
   * plan's decisions land in the project's own ledger beside its renders: the
   * `choice` that approved an item, the `delegate` that authorised a threshold,
   * and one `plan_step` per execution naming the choice it ran under. */
  provenance: prov,
  keepAwake: (on) => {
    if (on) {
      if (mvAwake) return;
      try {
        mvAwake = spawn(config.python, [path.join(__dirname, "keepawake.py")],
                        { stdio: "ignore", windowsHide: true });
        mvAwake.on("exit", () => { mvAwake = null; });
      } catch { mvAwake = null; }
    } else if (mvAwake) {
      try { mvAwake.kill(); } catch { /* already gone */ }
      mvAwake = null;
    }
  },
  /* MEDIA length of a library clip, when anything recorded it — a vfx render
   * stamps clipSeconds (see rememberClip below), a generated clip's sidecar
   * carries it too. Null means "nothing measured it"; the importer then falls
   * back to the segment length rather than inventing a number. */
  clipSeconds: (name) => {
    const v = Number(clipMeta.get(name)?.clipSeconds);
    return Number.isFinite(v) && v > 0 ? v : null;
  },
  /* Saves a Studio project through the same rules as the Save button — derived
   * filename, overwrite-on-same-name — so the workflow's "Move to Studio" and
   * a human's Save can never disagree about what a project is. */
  saveStudioProject: async (name, doc) => {
    const slug = name.replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "project";
    const file = `${slug}.json`;
    await mkdir(PROJECT_DIR, { recursive: true });
    await writeFile(path.join(PROJECT_DIR, file),
      JSON.stringify({ ...doc, name, savedAt: Date.now() }, null, 1));
    return { file, name };
  },
  outputDir: () => config.outputDir,
  /* EXACT RENDER, offline, when ffmpeg is on the machine.
   *
   * Studio's own export captures the canvas with MediaRecorder — the choice
   * that needs nothing installed, and the one that stays the default. But it is
   * real time, and real time is a ceiling: measured at 1920x1088 the draw path
   * sustains 17 fps against a requested 24, so every export judders and a
   * 148-second video costs 148 seconds. scripts/timeline_render.py composes the
   * same timeline from the source files instead — exactly `fps`, and 4 seconds
   * for a 44-second video on this card.
   *
   * The spawn lives here rather than in mv/routes.js for the same reason
   * saveStudioProject does: config and the process are this file's business,
   * and the route should ask for an outcome rather than know how to get one. */
  renderTimeline: async (name, { fade = 0, beatZoom = 0, beatsFile = null } = {}) => {
    const slug = name.replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "project";
    const proj = path.join(PROJECT_DIR, `${slug}.json`);
    try { await stat(proj); } catch { throw new Error(`No saved timeline called "${name}" — build it first.`); }
    const out = path.join(CLIP_DIR, `mv_${slug.replace(/_video$/, "")}.mp4`);
    const args = [path.join(__dirname, "..", "scripts", "timeline_render.py"),
                  proj, CLIP_DIR, config.outputDir, out];
    if (fade > 0) args.push(`--fade=${Number(fade)}`);
    /* The beat pulse. Both are required together — an amplitude with no tempo
     * has nothing to pulse against, and a tempo with no amplitude is off. */
    if (beatZoom > 0 && beatsFile) {
      args.push(`--beatzoom=${Number(beatZoom)}`, `--beats=${beatsFile}`);
    }
    const r = await new Promise((resolve) => {
      const proc = spawn(config.python, args);
      let so = "", se = "";
      proc.stdout.on("data", (d) => (so += d));
      proc.stderr.on("data", (d) => (se += d));
      proc.on("exit", (code) => resolve({ code, so, se }));
      proc.on("error", () => resolve({ code: 1, so: "", se: "spawn failed" }));
    });
    let body;
    try { body = JSON.parse(r.so); }
    catch { throw new Error(r.se.slice(-300) || "the renderer said nothing"); }
    if (body.error) throw new Error(body.error);
    /* Stamped into the same two maps every other clip maker writes, so the
     * library and the MV importer see a finished timeline exactly as they see
     * a generated clip -- media length in clipMeta, not a guess from the file. */
    clipMeta.set(path.basename(out), {
      ...(clipMeta.get(path.basename(out)) || {}),
      clipSeconds: body.total, source: "timeline",
      width: body.w, height: body.h,
    });
    saveClipStore();
    return { ...body, name: path.basename(out) };
  },
  copyFile: async (src, dest) => writeFile(dest, await readFile(src)),
  jobs,
  /* TTS shares the one GPU with everything else. It politely waits for both
   * queues to drain, then runs as its own process and releases VRAM on exit. */
  waitForIdle: async () => {
    for (;;) {
      const a = art.status().art;             // status() nests under `art`
      if (!jobs.current && !a.queued && !a.current) return;
      await new Promise((r) => setTimeout(r, 5000));
    }
  },
});

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
    if (d.error) return null;
    /* ⚠ AND WRITE THE CACHE IT READS. This function has always LOOKED for
     * .beats/<song>.json at the top and never once written one, so every call
     * re-ran the analysis — and anything downstream that wanted the full
     * result (the bass envelope, the onset curve) found no file to read. Two
     * stale files in that folder came from some other path entirely.
     *
     * srcMtime is what the read above compares against, so it has to travel
     * with the payload or the cache can never hit. */
    try {
      const st = await stat(path.join(config.outputDir, song));
      await mkdir(path.dirname(cache), { recursive: true });
      await writeFile(cache, JSON.stringify({ ...d, srcMtime: Math.round(st.mtimeMs) }));
    } catch { /* an unwritable cache is a slow analysis, not a failure */ }
    return d;
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
  // The About page's showcase ships as static mp4/webm under web/assets — a
  // <video> handed application/octet-stream refuses to play, so name them.
  ".mp4": "video/mp4",
  ".webm": "video/webm",
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

/* The close handler for an engine that speaks {ok:false, error} on STDOUT and
 * then exits 1 (imgdoc.py, imgexport.py — both wrap main in exactly that).
 * Rejecting on the exit code before reading stdout is how the CLI's full
 * diagnosis became `{"error":"exit 1"}` over HTTP: the JSON error is the
 * message, stderr and the exit code are only the fallback for a crash that
 * never got to print one. */
function engineClose(resolve, reject, so, se, code, tailBytes = 400) {
  const tail = so.trim().split(/\r?\n/).pop();
  if (code === 0 && tail) return resolve(tail);
  try {
    const r = JSON.parse(tail);
    if (r && r.ok === false && r.error) return reject(new Error(r.error));
  } catch { /* no JSON on stdout — the engine died before answering */ }
  reject(new Error(se.trim().slice(-tailBytes) || `exit ${code}`));
}

/* The studio runs unattended for hours. A single unhandled rejection anywhere
 * — a fetch that times out inside a timer, a listener that throws — makes Node
 * exit, and the exit takes the ComfyUI child with it: an overnight run dies at
 * 3am with an empty log and no way to tell what happened. Logging loudly and
 * staying up is the better trade for a local single-user app; a wedged feature
 * beats a dead studio, and now it says so. */
process.on("unhandledRejection", (err) => {
  console.error(`  [unhandled rejection] ${err?.stack || err}`);
});
process.on("uncaughtException", (err) => {
  console.error(`  [uncaught] ${err?.stack || err}`);
});

/* The compositor's own surface. It is mounted before everything else because
 * it owns a whole prefix, and it answers `handled` so an unknown /api/vfx path
 * still falls through to the 404 the rest of the app gives. */
const vfxRoutes = createVfxRoutes({
  json, readBody, config, IMAGE_DIR, CLIP_DIR, art,
  provenance: prov,
  /* Renders stamp their provenance into the same two maps every other clip
   * maker uses — source, comp slug and MEDIA length (clipSeconds) in clipMeta,
   * render wall time in clipTimes — so list_clips and the MV importer see a
   * vfx render exactly as they see a generated or imported clip. */
  rememberClip: (name, renderSeconds, meta) => {
    if (!name) return;
    if (renderSeconds) clipTimes.set(name, renderSeconds);
    if (meta) clipMeta.set(name, { ...(clipMeta.get(name) || {}), ...meta });
    saveClipStore();
  },
});

/* The DAW's surface — the same whole-prefix-plus-`handled` bargain as vfx,
 * so an unknown /api/daw path still falls through to the app's own 404.
 * [DAWREC] provenance rides in so recorded takes land as `record` events. */
const dawRoutes = createDawRoutes({ json, readBody, config, provenance: prov });
const scoreRoutes = createScoreRoutes({ json, readBody, config, provenance: prov });
const musicInputRoutes = createMusicInputRoutes({ json, config, jobs, provenance: prov });
const musicPlanRoutes = createMusicPlanRoutes({ json, readBody });
const avatarRoutes = createAvatarRoutes({ json, directory: path.join(config.outputDir, 'avatars'), provenance: prov });

/* The Video lab. It needs the art runner (an arm is awaited by the clip event
 * the runner emits, not by polling a directory) and the same rememberClip the
 * compositor uses — so a comparison arm is tagged into clipMeta exactly the way
 * every other clip maker tags one, and /api/clips shows the group without
 * knowing this subsystem exists. */
const videoLabRoutes = createVideoLabRoutes({
  json, readBody, art,
  rememberClip: (name, renderSeconds, meta) => {
    if (!name) return;
    if (renderSeconds) clipTimes.set(name, renderSeconds);
    if (meta) clipMeta.set(name, { ...(clipMeta.get(name) || {}), ...meta });
    saveClipStore();
  },
});

/* THE EAR — the DAW's critique loop. Its own prefix under /api/daw/ear, so it
 * mounts BEFORE the DAW's mount (which owns /api/daw and falls through on
 * anything it does not recognise) and stays a three-line seam for the merge. */
const earRoutes = createEarRoutes({ json, readBody, config, provenance: prov });

/* The welcome window's surface: the capability catalogue, the showcase read off
 * this disk, and the first-run flag. Two dependencies, both of them this file's
 * own helpers — everything else it needs it reads from config. */
const welcomeRoutes = createWelcomeRoutes({ json, readBody });

/* Chat v1. Two dependencies, both of them this file's own helpers; the model it
 * runs, the tools it can call and where it keeps its conversations all come
 * from config and from the engine door. */
const chatRoutes = createChatRoutes({ json, readBody, config });

/* THE ENGINE DOOR's public side. Same whole-prefix-plus-`handled` bargain as
 * vfx and the DAW, and it gets the same `rememberClip` closure every other clip
 * maker gets — so a render driven by a script or an agent lands in the clip
 * library tagged exactly the way a render driven by the Render button does, and
 * /api/clips shows it without knowing this subsystem exists.
 *
 * ⚠ The engine port is NOT among the things this route may return. That is not
 * a convention here, it is asserted at runtime on the `status` and `identity`
 * responses by server/engine/client_test.js. */
const engineRoutes = createEngineRoutes({
  json, readBody, config, provenance: prov, engine: engineDoor, comfy,
  IMAGE_DIR, CLIP_DIR,
  rememberClip: (name, renderSeconds, meta) => {
    if (!name) return;
    if (renderSeconds) clipTimes.set(name, renderSeconds);
    if (meta) clipMeta.set(name, { ...(clipMeta.get(name) || {}), ...meta });
    saveClipStore();
  },
});
/* The one line that closes the last seam in the door: until this runs, a
 * dispatch with `adopt` on records `adoptedAs: null` because nothing in the
 * client knows where this app's shelves are. It is registered here rather than
 * injected at construction because the client is a module-level singleton and
 * CLIP_DIR, IMAGE_DIR and the closure above are all built in this file. */
engineDoor.setAdopter(engineRoutes.adopt);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  try {
    /* Video Workflow — the whole music-video pipeline, additive. Claims only
     * its own prefix and returns false otherwise, so upstream routing below is
     * untouched and a rebase never has to reason about it. */
    if (p === "/api/mv" || p.startsWith("/api/mv/")) {
      if (await mvRoutes.handle(p, req, res, url)) return;
    }

    /* The engine door. Owns /api/engine and its one documented alias, and
     * answers `handled`, so an unknown /api/engine/... path still falls
     * through to the app's own 404. */
    if (p === "/api/engine" || p.startsWith("/api/engine/")) {
      if (await engineRoutes(req, res, url)) return;
    }

    // ---- API ------------------------------------------------------------
    if (p === '/api/avatars' || p.startsWith('/api/avatars/')) {
      if (await avatarRoutes(req, res, url)) return;
    }
    if (p === "/api/music-input") {
      if (await musicInputRoutes(req, res, url)) return;
    }
    if (p === "/api/music-plan") {
      if (await musicPlanRoutes(req, res, url)) return;
    }
    /* ⚠ THE DOOR THAT WAS NEVER HUNG. server/score/ shipped with 2451 lines and
     * 1287 passing assertions across four suites, and none of it was reachable:
     * nothing here dispatched to it, so /api/score answered the app's own 404
     * while every test went on passing. The suites call the handler directly,
     * which proves the module works and says nothing about whether anything
     * calls it — the same shape as a guard that matches nothing and reports
     * success, one level up. Found by asking the running server for a score
     * list rather than by running the tests again. */
    if (p === "/api/score" || p.startsWith("/api/score/")) {
      if (await scoreRoutes(req, res, url)) return;
    }
    if (p === "/api/vfx" || p.startsWith("/api/vfx/")) {
      if (await vfxRoutes(req, res, url)) return;
    }

    if (p === "/api/daw/ear" || p.startsWith("/api/daw/ear/")) {
      if (await earRoutes(req, res, url)) return;
    }

    if (p === "/api/daw" || p.startsWith("/api/daw/")) {
      if (await dawRoutes(req, res, url)) return;
    }

    /* The Video lab owns exactly one path and answers `handled`, so an unknown
     * one still falls through to the app's own 404. */
    if (p === "/api/videolab") {
      if (await videoLabRoutes(req, res, url)) return;
    }

    /* The welcome window. Same whole-prefix-plus-`handled` bargain as the rest,
     * so an unknown /api/welcome path still falls through to the app's 404. */
    if (p === "/api/welcome" || p.startsWith("/api/welcome/")) {
      if (await welcomeRoutes(req, res, url)) return;
    }

    /* Chat. Same bargain, and note that POST /api/chat answers with an EVENT
     * STREAM rather than JSON — it writes its own head and ends its own
     * response, so nothing below it may touch `res` after it returns true. */
    if (p === "/api/chat" || p.startsWith("/api/chat/")) {
      if (await chatRoutes(req, res, url)) return;
    }

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
          /* WHICH MUSIC ENGINE, and what it can actually do.
           *
           * Sent as data rather than left for the screen to hardcode, for the
           * same reason the video engines are (see the comment at `engines`
           * below): the screen kept its own copy of engine facts once and the
           * copy went stale the day a build was added.
           *
           * The capability flags matter more here than they do for video,
           * because two of them make a control ACTIVELY WRONG rather than
           * merely unused:
           *   sectionTags     — YuE2 SINGS "[verse]" if a tag button inserts
           *                     one. Three MiniMax tracks were rejected for
           *                     this and one ran 202 s instead of 64 s.
           *   audioReference  — the vendor states YuE2 "exposes no
           *                     audio-reference, phoneme-alignment, or
           *                     local-inpainting argument", so the field
           *                     cannot be honoured at all.
           * and one changes what the ETA line may claim:
           *   warmCache       — the preview x0.45 and re-roll x0.6 multipliers
           *                     are MiniMax AR-cache facts. A subprocess engine
           *                     has no such cache, so a re-roll there costs
           *                     full price and the estimate must say so. */
          musicEngine: config.music.engine,
          musicPrecision: config.music.precision,
          musicYue2Checkpoint: config.music.yue2Checkpoint,
          musicYue2Lora: config.music.yue2Lora,
          musicYue2LoraStrength: config.music.yue2LoraStrength,
          musicModels: await musicModelChoices(),
          musicOnly: config.musicOnly,
          engineExpected: comfyWanted,
          musicEngines: Object.fromEntries(await Promise.all(Object.entries(config.music.engines).map(async ([k, e]) => [k, {
            label: e.label, runtime: e.runtime, capability: e.capability,
            ...(k === "yue2-gguf" ? await ggufSetup.status().then(s => {
              const ready = Object.values(s.variants || {}).some(v => v.ready) || s.ready;
              return {ready, variants:s.variants, readinessNote:ready?null:s.message, experimental:true};
            }) : {}),
            audioReference: !!e.audioReference, sectionTags: !!e.sectionTags,
            instrumentalToggle: !!e.instrumentalToggle, score: !!e.score,
            warmCache: !!e.warmCache, emergentLength: !!e.emergentLength,
            realtimeRatio: e.realtimeRatio ?? null, cot: e.cot ?? null,
            maxDuration: e.maxDuration ?? null,
            amdWarning: k === "minimax-music3" && onAmd() ? MINIMAX_AMD_WARNING : null,
            /* ⚠ `!== false` RATHER THAN `!!`, to mirror the refusal in
             * /api/generate exactly. Only an explicit false means "no render
             * path"; a missing flag means an engine that predates this field
             * and works. With `!!` an engine that forgot the flag would be
             * marked unrenderable in the UI while the server happily rendered
             * it, which is the two ends disagreeing about the same fact — the
             * failure the music engine choice already had once, when it lived
             * in client state and the server never heard about it. */
            renderPath: e.renderPath !== false,
            /* `!!` here, unlike renderPath above, and for the opposite
             * reason: an engine that predates this field has no ladder,
             * so absent must mean false. renderPath's absence means a
             * working engine; this one's absence means no rungs. */
            durationLadder: !!e.durationLadder,
          }]))),
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
            /* WHICH ENGINE WILL ACTUALLY RENDER, beside the one the setting
             * names. They differ on two machines that both exist: one holding
             * H3 with the setting on LTX (renders, on H3, and should say so),
             * and a fresh install holding neither (renders nothing, and must
             * name the engine it can FETCH rather than the gated one the
             * default used to point at). The page reads `resolved.why` — it is
             * a whole sentence on purpose, so no surface has to compose its own
             * and get the licence wording wrong.
             *
             * COST, because this endpoint is polled every four seconds by every
             * open tab and videoReady() was already in it: measured 0.40 ms per
             * call against videoReady()'s own 0.24 ms — one extra engine's worth
             * of statSync, about 6 ms per minute per tab. Not cached on purpose;
             * a download finishing has to show up without a reload. */
            resolved: resolveVideoEngine(),
            /* Each engine's OWN sizes, frame rule and cost curve. The UI cannot
             * share one list: H3's native 1344x768 is not a legal LTX size, and
             * LTX quantises to a 32px latent grid after halving, so two of H3's
             * four options would silently render at a different size. */
            engines: Object.fromEntries(Object.entries(config.video.engines).map(([k, e]) => [k, {
              label: e.label, sizes: e.sizes, seconds: e.seconds, fps: e.fps,
              width: e.width, height: e.height, steps: e.steps ?? null,
              frameRule: e.frameRule,
              costFixedSeconds: e.costFixedSeconds, costRate: e.costRate, costExponent: e.costExponent,
              /* The step counts at which each distillation takes over. Sent so
               * the screen can name the path a setting lands on without keeping
               * its own copy of these numbers — it did, and the copy went stale
               * the day the 4-step build was added. */
              turboMaxSteps: e.turboMaxSteps ?? null, turbo4MaxSteps: e.turbo4MaxSteps ?? null,
              turbo3MaxSteps: e.turbo3MaxSteps ?? null,
            }])),
            seconds: videoEngine().seconds,
            width: videoEngine().width, height: videoEngine().height },
          tier: comfy.tier || "auto",
          tiers: Object.entries(config.vramTiers).map(([k, v]) => ({ id: k, label: v.label, note: v.note })),
          // The two provenance toggles (display + Tier-2 record). Tier 1 has
          // no setting to report because it has no setting.
          provenance: { ...config.provenance },
        },
        gpu: gpuStatus(),
        ram: ramStatus(),
        ...art.status(),
        ...jobs.snapshot(),
        // Disk is the source of truth, so the library survives restarts and shows
        // anything already in the output folder.
        library: await library.list(),
        /* The Trash filter reads this. Without it the client had a "trash"
         * option and nothing to show under it — the /api/track reply was the
         * only carrier, and only after an action. */
        trash: await library.listTrash(),
        playlists: library.playlists,
        ...batch.status(),
      });
    }

    // Overnight batches. The plan lives on the server and on disk, so closing the
    // browser -- or losing it to a crash -- does not touch a run in progress.
    if (p === "/api/batch" && req.method === "POST") {
      const b = await readBody(req);
      try {
        /* The actor is taken from the REQUEST, not from the body: a caller must
         * not be able to claim to be a human. Every picture the run makes is
         * then stamped with it. */
        if (b.action === "start") return json(res, 200, batch.start({ ...b, actor: prov.actorFrom(req) }));
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
    if (p === "/api/music-gguf" && req.method === "GET") {
      try { return json(res, 200, await yueGgufStatus({quantization:url.searchParams.get("precision") ?? undefined})); }
      catch(err) { return json(res, 400, {error:err.message}); }
    }
    if (p === "/api/music-gguf/setup") {
      if (req.method === "GET") {
        try { return json(res, 200, await ggufSetup.status({quantization:url.searchParams.get("precision") ?? undefined})); }
        catch(err) { return json(res, 400, {error:err.message}); }
      }
      if (req.method !== "POST") return json(res, 405, {error:"Use GET or POST."});
      const host=req.headers.host || '';
      const allowedHosts=[`127.0.0.1:${config.uiPort}`,`localhost:${config.uiPort}`,`[::1]:${config.uiPort}`];
      if (!allowedHosts.includes(host) || (req.headers.origin && req.headers.origin!==`http://${host}`)
        || !/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')) {
        return json(res,403,{error:"Native setup requires a same-origin local JSON request."});
      }
      const b=await readBody(req);
      try {
        if (b.action === "cancel") return json(res, 200, {...ggufSetup.cancel(),...await ggufSetup.status()});
        if (b.action !== "install") return json(res, 400, {error:"Unknown setup action."});
        if (jobs.current || jobs.queue.length || art.status().art?.current) return json(res, 409, {error:"Wait for Studio's active jobs to finish before changing the runtime."});
        const started=await ggufSetup.start({acceptLicense:b.acceptLicense,quantization:b.quantization});
        return json(res, 202, {...started,...await ggufSetup.status({quantization:b.quantization})});
      } catch(err) {return json(res,400,{error:err.message});}
    }
    if (p === "/api/models" && req.method !== "POST") {
      const [cat, pkgs, disk] = await Promise.all([models.status(), pythonPackages(), diskFree()]);

      /* THE MACHINE, READ ONCE. Both readings are already taken for the status
       * bar; what was missing was anybody dividing one by the other. Read here
       * rather than inside the map so all seventeen verdicts are computed
       * against the SAME reading — nvidia-smi is polled on a timer and a fit
       * table where row 3 saw a different card than row 11 would be indefensible
       * on the one screen whose job is to be trusted. */
      const machine = readMachine(gpuStatus(), ramStatus());

      const nativeSetup = await ggufSetup.status();
      const nativeReadyLabels = Object.entries(nativeSetup.variants || {})
        .filter(([, variant]) => variant.ready).map(([precision]) => precision.toUpperCase());
      const capabilities = cat.map((c) => ({
        ...c,
        ...(c.nativeSetup ? {ready:Object.values(nativeSetup.variants || {}).some(v=>v.ready) || nativeSetup.ready,
          nativeVariants:nativeSetup.variants,totalBytes:nativeSetup.downloadBytes,progress:nativeSetup.progress,
          downloading:!!ggufSetup.pending,blocked:nativeSetup.blocked||null,note:c.note+" "+(nativeReadyLabels.length
            ? `Installed and verified: ${nativeReadyLabels.join(", ")}. Choose precision in Music.`
            : nativeSetup.message)} : {}),
        // A capability can have every weight on disk and still not run if its
        // python package is absent. Saying so is the difference between a
        // useful message and a mystery.
        packageReady: c.needsPackage ? !!pkgs[c.needsPackage] : true,
        /* "4 GB to download" and "will it run on my card" are different
         * questions and only the first one was ever answered here. `requires`
         * has been on every row since the catalogue was written; this is the
         * subtraction. */
        fit: fitFor(c.requires, machine),
        /* The shelf a stand-in may come from (unet counts as diffusion_models). */
        files: (c.files || []).map((f) => ({ ...f, shelf: f.folder ? shelfOf(f.folder) : null })),
        group: modelGroupOf(c),
        ...(c.id === "engine" && onAmd() ? { note: [`⚠ ${MINIMAX_AMD_WARNING}`, c.note].filter(Boolean).join(" ") } : {}),
      }));

      return json(res, 200, {
        disk,
        // Sent so the UI can quote the machine back rather than keeping its own
        // idea of what the card is: one reading, one set of numbers, and every
        // sentence on the screen traceable to it.
        machine,
        capabilities,
        /* WHAT TO ACTUALLY DOWNLOAD. Seventeen rows and no advice is not a
         * neutral position — it is the position that made a newcomer give up and
         * hand the job to an agent. */
        recommended: recommendFor({ capabilities, machine, disk }),
        /* THE FOUR WORDS, SENT RATHER THAN RETYPED IN THE PAGE.
         *
         * Every row on the Models screen needs a short label for its verdict,
         * and the page is the obvious place to write four of them. That is
         * exactly how a screen and an agent end up describing the same machine
         * differently: `streams` means "it runs, from system RAM, slower" in
         * fit.js's own words and in models_for_this_machine's tool description,
         * and the day somebody shortens the badge to "Too slow" the page is
         * telling a person not to bother with a model the agent is recommending.
         * So the chip and its one-line explanation travel with the verdict, from
         * the single definition in fit.js. web/modelfit.js renders these and
         * writes none of its own; server/modelfit_test.js fails if it starts. */
        fitStates: FIT_STATES,
        python: { path: SYSTEM_PYTHON, packages: pkgs, probed: probedBy },
        /* The models folder, every folder the engine loads from, and what is in
         * them — so a file the catalogue does not name is still visible, and can
         * stand in for one it does. */
        local: await localModelsPayload(cat),
        groups: MODEL_GROUPS,
        musicModels: await musicModelChoices(cat),
        musicEngine: config.music.engine,
        musicPrecision: config.music.precision,
        musicYue2Checkpoint: config.music.yue2Checkpoint,
        musicYue2Lora: config.music.yue2Lora,
        musicYue2LoraStrength: config.music.yue2LoraStrength,
      });
    }

    if (p === "/api/models" && req.method === "POST") {
      const b = await readBody(req);
      try {
        /* The OS folder picker. Blocks until the dialog closes. */
        if (b.action === "pickFolder") {
          const r = await pickFolderDialog(config.modelsDir);
          if (r.unsupported) return json(res, 400, { error: "No folder dialog on this platform — type the path instead." });
          return json(res, r.error ? 500 : 200, r);
        }
        /* Preview a folder (scanFolder), or adopt it as the models folder
         * (setModelsDir). Adopting needs a restart: the catalogue's download
         * paths and the engine's model paths are both fixed at start. */
        if (b.action === "scanFolder" || b.action === "setModelsDir") {
          const raw = String(b.dir || "").trim();
          if (!raw) return json(res, 400, { error: "Give a folder." });
          const dir = path.resolve(raw);
          const st = await stat(dir).catch(() => null);
          if (!st?.isDirectory()) return json(res, 400, { error: `Not a folder: ${dir}` });
          const files = await scanBases([dir]);
          const folders = countByFolder(files);
          const bytes = files.reduce((s, f) => s + f.bytes, 0);
          if (b.action === "scanFolder") return json(res, 200, { dir, files: files.length, bytes, folders });
          if (!files.length && !b.force) {
            return json(res, 400, {
              error: `No model files in the usual subfolders of ${dir} (checkpoints, diffusion_models, vae, …). `
                + "Pick the folder that CONTAINS those subfolders.",
              dir, folders, empty: true,
            });
          }
          await mergeSettings({ modelsDir: dir, modelsDirPinned: true });
          return json(res, 200, {
            ok: true, dir, files: files.length, bytes, folders, needsRestart: true,
            note: "Saved. Restart AIPLAY Studio to use this folder — downloads, presence checks and the engine all read it at start.",
          });
        }
        /* A local file standing in for a catalogue file, or `use: null` to undo.
         * Takes effect immediately: presence is re-read on every status, and the
         * engine door renames the file in each graph it sends. */
        if (b.action === "override") {
          const catName = path.basename(String(b.file || ""));
          const entry = CATALOG.flatMap((c) => c.files || []).find((f) => path.basename(f.dest) === catName);
          if (!entry) return json(res, 400, { error: "That is not a file the catalogue knows." });
          const next = { ...config.modelOverrides };
          if (b.use === null || b.use === undefined || b.use === "") {
            delete next[catName];
          } else {
            const useName = path.basename(String(b.use));
            const folder = path.relative(config.modelsDir, path.dirname(entry.dest)).split(path.sep)[0];
            if (!folder || folder.startsWith("..")) {
              return json(res, 400, { error: `${catName} does not live in the models folder, so it cannot be swapped here.` });
            }
            const found = (await scanBases([config.modelsDir]))
              .find((f) => f.name === useName && f.shelf === shelfOf(folder));
            if (!found) {
              return json(res, 400, { error: `${useName} is not in the ${shelfOf(folder)} folder of ${config.modelsDir}.` });
            }
            next[catName] = useName;
          }
          config.modelOverrides = next;
          musicChoicesCache.at = 0;
          await mergeSettings({ modelOverrides: next });
          return json(res, 200, { ok: true, overrides: next });
        }
        if (b.action === "download") {
          /* The region gate is checked HERE, not inside the promise below. That
           * promise is deliberately not awaited and its rejection is swallowed,
           * so a refusal thrown inside it would reach nobody and the UI would
           * show a download that silently never starts. */
          const cap = CATALOG.find((c) => c.id === String(b.id));
          if (!cap) return json(res, 400, {error:"Unknown model capability. Nothing was downloaded."});
          if (cap.nativeSetup) return json(res, 400, {error:"Use YuE2 GGUF setup and review its model/runtime terms first.",setup:"/api/music-gguf/setup"});
          if (cap.gated || cap.awaiting || !cap.files.length) return json(res, 400, {error:cap.gated?.how || cap.awaiting || "This capability needs a separate package installation."});
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
        /* The supervisor is no longer a parameter: a conversion is a graph, and
         * every graph in this app goes through the engine door. The actor comes
         * from the request, so an export driven by an MCP client is recorded as
         * that agent rather than as `system`. */
        const out = await convertAudio({ ...b, actor: prov.actorFrom(req) });
        /* The conversion goes through ComfyUI's encoder, which writes a fresh
         * container — the source file's tags do NOT survive it. Re-stamp the
         * export with the same two-tier metadata the library file carries:
         * the marker unconditionally, the record per the user's toggle. A
         * tagging failure never costs the converted file. */
        const rel = path.join(out.subfolder || "", out.file);
        let embedded = null;
        try {
          const src = path.basename(String(b.file || ""));
          const m = library.meta.get(src) || {};
          const meta = {
            title: m.title, caption: m.caption, lyrics: m.lyrics,
            seed: m.seed, mixSeed: m.mixSeed, steps: m.steps,
            cfg: m.cfg, shift: config.sampling.shift, model: m.model || "int8",
            date: new Date(m.createdAt || Date.now()).toISOString().slice(0, 10),
            ...(await songProvMeta(src)),
          };
          const tagRes = await library.tagFile(rel, meta);
          embedded = tagRes?.ok ? "tags" : null;
          /* Opus rides an Ogg container the C2PA SDK cannot embed into yet
           * (SPEC R1.3), so the export ALSO gets the sidecar — the graceful
           * story for the format, stated rather than silently thinner. */
          if (rel.toLowerCase().endsWith(".opus")) {
            const s = await prov.summarize("library", src).catch(() => null);
            await prov.writeSidecar(path.join(config.outputDir, rel), {
              marker: prov.markerFor(s?.class || "ai-generated",
                { model: s?.model || "MiniMax-Music3", media: "audio" }),
              originMap: s ? { class: s.class, model: s.model, editsBy: s.editsBy,
                               authoredBy: s.authoredBy, events: s.events } : null,
              chainHead: s?.chainHead || null,
            });
            embedded = embedded ? "tags+sidecar" : "sidecar";
          }
          provNote("library", {
            actor: prov.actorFrom(req), type: "export", asset: src,
            data: { format: String(b.format || "").toLowerCase(), out: rel, embedded },
          });
        } catch (err) {
          console.error(`  [provenance] export tagging failed for ${rel}: ${err.message}`);
        }
        return json(res, 200, { ...out, provenance: embedded });
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) });
      }
    }
    if (p === "/api/export/formats") {
      return json(res, 200, Object.fromEntries(
        Object.entries(AUDIO_FORMATS).map(([k, v]) => [k, { qualities: v.qualities, lossy: v.lossy }])));
    }

    /**
     * The provenance ledger, read side (SPEC D1/D2). `asset` filters exactly;
     * `prefix` filters by prefix; `slug` reads a VFX comp's own ledger instead
     * of the library's; `verify=1` walks the whole chain. This is the surface
     * the song panel, the image editor and the `provenance_read` MCP tool all
     * share — one implementation, no drift.
     */
    if (p === "/api/provenance" && req.method === "GET") {
      try {
        const q = url.searchParams;
        const slug = q.get("slug");
        const scope = slug
          ? { dir: path.join(config.outputDir, "vfx", path.basename(slug)) }
          : "library";
        const asset = q.get("asset") || undefined;
        const prefix = q.get("prefix") || undefined;
        const limit = Math.min(Math.max(Number(q.get("limit")) || 100, 1), 500);
        const { events, total, head: chainHead, corrupt } = await prov.read(scope, {
          asset, assetPrefix: prefix, limit,
        });
        const out = {
          ok: true, scope: slug ? `vfx/${slug}` : "library",
          asset: asset ?? prefix ?? null,
          summary: asset ? { asset, ...prov.foldOrigin(events) } : null,
          events, total, chainHead, corrupt: corrupt || undefined,
        };
        if (q.get("verify") === "1") out.chain = await prov.verify(scope);
        return json(res, 200, out);
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) });
      }
    }

    /**
     * The two provenance toggles — and ONLY the two (SPEC D5):
     * `showBadges` governs display, `embedRecord` governs the Tier-2 record
     * in exports. There is deliberately no key that reaches the Tier-1
     * marker or the ledger's capture: the marker is the tool's legal duty
     * (model licences + EU AI Act Art 50(2)), and a gap in the user's own
     * record only ever costs the user.
     */
    if (p === "/api/provenance/settings" && req.method === "POST") {
      const b = await readBody(req);
      if (typeof b.showBadges === "boolean") config.provenance.showBadges = b.showBadges;
      if (typeof b.embedRecord === "boolean") config.provenance.embedRecord = b.embedRecord;
      savePrefs();
      return json(res, 200, { ok: true, provenance: { ...config.provenance } });
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

    /* A song rendered OUTSIDE the job queue — YuE2 through its driver, a file
     * from another machine — becomes a library track. A copy into outputDir is
     * all "importing" is, because the library lists that folder; the sidecar row
     * is what makes it more than a bare file. Its own route, because /api/track
     * acts on a file that EXISTS and guards on that first, and this makes one.
     *
     * ⚠ UNIQUE NAME, OR THE WRONG SONG. The MV route's import_song does
     * `try { stat(dest) } catch { copyFile }` under the source's basename, and
     * every YuE2 render is called audio.flac — so importing <run>/audio.flac
     * silently reused whichever audio.flac reached the folder first, and a 107 s
     * track reported 167 s. MEASURED 2026-09-11. Here the name comes from the
     * caller's id and a collision is refused instead of adopted. */
    if (p === "/api/library/import" && req.method === "POST") {
      const b = await readBody(req);
      const src = String(b.path || "");
      if (!src || !/\.(flac|wav|mp3|ogg|m4a|opus)$/i.test(src)) return json(res, 400, { error: "import needs a path to an audio file." });
      try { await stat(src); } catch { return json(res, 400, { error: `No file at ${src}` }); }
      const rawId = String(b.id || path.parse(src).name).replace(/[^\w.-]+/g, "_").slice(0, 72);
      /* ⚠ THE LIBRARY LISTS ONLY NAMES IT RECOGNISES. library.js:22 admits
       * files starting with aiplay / preview / edit / extend / merge — the job
       * runner's own vocabulary. A copy named anything else is on disk, in the
       * sidecar, and invisible: MEASURED 32/32 imported, 0/32 listed. So an
       * unprefixed id gets the library's own prefix rather than a silent no-show. */
      const id = /^(aiplay|preview|edit|extend|merge)/.test(rawId) ? rawId : `aiplay_${rawId}`;
      const dest = path.join(config.outputDir, `${id}${path.extname(src).toLowerCase()}`);
      const base = path.basename(dest);
      try { await stat(dest); return json(res, 409, { error: `${base} is already in the library; choose another id.`, file: base }); } catch { /* free */ }
      await copyFile(src, dest);
      const meta = (b.meta && typeof b.meta === "object") ? b.meta : {};
      /* The row's badge reads `model`; without it a YuE2 song is labelled int8,
       * which is a MiniMax quantisation and a false statement here. */
      library.remember(base, {
        title: String(b.title || meta.title || id).slice(0, 120),
        imported: true, importedFrom: src, importedAt: Date.now(),
        ...meta,
      });
      return json(res, 200, { ok: true, file: base });
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
      if (typeof body?.caption !== "string" || !body.caption.trim()) return json(res, 400, { error: "Add a style description." });
      if (body.engine !== undefined && !Object.hasOwn(config.music.engines, body.engine)) return json(res, 400, {error:"Unknown music engine. Nothing was queued."});
      const requestedEngine=body.engine || config.music.engine;
      if (config.musicOnly && requestedEngine !== "yue2-gguf" && !(requestedEngine === "yue2-comfy" && comfyWanted)) return json(res, 400, {error:"Music-only mode runs YuE2 (native GGUF, or through ComfyUI when a YuE2 checkpoint is found). Start full Studio for other engines."});
      if (requestedEngine === "yue2-gguf") {
        try {
          const nativeJob=prepareGgufJob(body,prov.actorFrom(req));
          if (ggufSetup.pending) return json(res, 409, {error:"Wait for the native installation to finish."});
          const kit=await ggufSetup.status({quantization:nativeJob.quantization});
          if (ggufSetup.pending) return json(res, 409, {error:"Wait for the native installation to finish."});
          if (!kit.ready) return json(res, 400, {error:kit.message,reason:"kit-missing",needsModel:"musicYue2Gguf",engine:"yue2-gguf"});
          const job=jobs.enqueue(nativeJob);
          return json(res, 200, {ok:true,engine:"yue2-gguf",...jobs.snapshot(),job:{id:job.id,title:job.title,engine:"yue2-gguf",quantization:job.quantization}});
        } catch(err) {return json(res, 400, {error:err.message,reason:err.refusal||"request",engine:"yue2-gguf"});}
      }
      /* ⚠ REFUSE AN ENGINE THIS DOOR CANNOT REACH, rather than quietly using
       * the one it can. An engine whose `renderPath` is false in
       * config.music.engines has wiring that is not finished; rendering with
       * the other engine instead would stamp the song with a model that did
       * not make it, and the two carry DIFFERENT rights classes — a false
       * licence claim rather than a cosmetic mismatch. That is why this
       * refuses instead of substituting. (YuE2 carried `false` until
       * 2026-09-11; its branch is below.) */
      /* The Music page's choice, unless the body names an engine for THIS song —
       * MCP's make_song does, so an agent can render with either without
       * flipping the page's setting under whoever is typing at it. An unknown
       * name falls back to the page's choice rather than refusing: the field
       * is a preference, and the response says which engine took the job. */
      const musicEngine = (typeof body.engine === "string" && config.music.engines[body.engine])
        ? body.engine : config.music.engine;
      /* A per-job engine skips the switch, and the switch is where "are the
       * weights here" is asked (POST /api/music action engine). Ask it here
       * for a named engine, the same way, so an absent kit answers at the
       * click and not as a failed job. YuE2's own kit check follows below. */
      /* yue2-comfy is checked below by its checkpoint, not by the Python kit's row. */
      if (typeof body.engine === "string" && musicEngine === body.engine && musicEngine !== config.music.engine
          && musicEngine !== "yue2-comfy") {
        const capId = MODEL_TO_CAPABILITY[musicEngine];
        const cap = capId ? (await models.status()).find((c) => c.id === capId) : null;
        if (cap && !cap.ready) {
          const gb = ((cap.totalBytes - cap.haveBytes) / 1e9).toFixed(1);
          return json(res, 400, {
            error: cap.gated
              ? `${config.music.engines[musicEngine].label} cannot be downloaded by Studio (${gb} GB, access-gated repository). ${cap.gated.how}`
              : `${config.music.engines[musicEngine].label} is not downloaded yet (${gb} GB missing). Open the Models screen.`,
            engine: musicEngine, needsModel: cap.gated ? null : capId, gated: cap.gated || null, reason: "weights-missing",
          });
        }
      }
      {
        const eng = config.music.engines[musicEngine];
        if (eng && eng.renderPath === false) {
          return json(res, 400, {
            error: `${eng.label} cannot render from here yet: its wiring is marked unfinished `
              + `(renderPath: false in server/config.js). Rendering with another engine instead `
              + `would stamp the song with a model that did not make it, and the two do not share `
              + `a licence. Switch the engine on the Music page to render here.`,
            engine: musicEngine,
            /* So a UI or an agent can say WHY, rather than only that it failed. */
            reason: "no-render-path",
          });
        }
      }

      /* ── YuE2: the second kind of job. ─────────────────────────────────
       * Same door for the browser and for MCP's make_song, so an agent's song
       * and a typed one take the identical path and file the same way. The
       * refusals that can be answered NOW are answered here (bracketed section
       * labels, a preview that does not exist, a precision the card lacks);
       * the ones that need the driver (a busy card, a bad score) surface as
       * the job's own `error` with the door's sentence, minutes later at most.
       * The rung is the ladder's choice for the WANTED length (yue_fit.js) —
       * the same answer the info box on the Create form showed. */
      if (musicEngine === "yue2") {
        if (["q4_0", "q8_0"].includes(body.quantization)) {
          return json(res, 400, {
            error: "Q4_0 and Q8_0 require the native yue2-gguf engine. No Python BF16 fallback was started.",
            engine: musicEngine, reason: "precision-engine-mismatch",
          });
        }
        if (body.preview) {
          return json(res, 400, {
            error: "YuE2 has no preview: every render is the full model writing a score and "
              + "singing it, and there is no cheaper pass to offer. Press Create.",
            engine: musicEngine, reason: "no-preview",
          });
        }
        try {
          refuseLyrics(body.lyrics || "", { allowSectionLabels: !!body.allowSectionLabels });
        } catch (e) {
          return json(res, 400, { error: e.message, engine: musicEngine, reason: e.refusal || "lyrics" });
        }
        /* The kit, checked at the door — a stat() per file, so it is answerable
         * NOW. The engine switch performs this check; a per-job `engine` from
         * MCP skips the switch, and without this line the answer would arrive
         * minutes later as a failed job on a machine that never had the weights. */
        {
          const kit = await yueStatus();
          if (!kit.installed) {
            return json(res, 400, {
              error: "YuE2 is not set up on this machine, so nothing was started:\n"
                + (kit.why || []).map((w) => `  - ${w}`).join("\n")
                + "\nOpen the Models screen, or choose MiniMax Music 3.",
              engine: musicEngine, reason: "kit-missing", needsModel: "musicYue2",
            });
          }
        }
        const capability = await cudaCapability();
        const quantization = body.quantization === "fp8" ? "fp8" : "none";
        if (quantization === "fp8" && !fp8Allowed(capability)) {
          return json(res, 400, {
            error: `8-bit needs an NVIDIA card of compute capability 8.9 or newer (RTX 40-series `
              + `or later); this one reports ${capability ? capability.join(".") : "no CUDA device"}, `
              + `so the kernels do not exist on it. Choose the model's own bf16 precision.`,
            engine: musicEngine, reason: "fp8-capability",
          });
        }
        const want = Number(body.maxDuration) > 0 ? Number(body.maxDuration) : null;
        const chosen = fit(want, { capability });
        const rung = { id: chosen.rung.id, label: chosen.rung.label, ...rungArgs(chosen.rung.id) };
        const cot = ["full", "melody", "off"].includes(body.cot) ? body.cot : "full";
        const abc = typeof body.abc === "string" && body.abc.trim() ? body.abc : null;
        /* A supplied score with the chain of thought off is refused here, in
         * the door's own words (protocol.py:99), rather than silently dropped
         * — the first version dropped it and still filed the render as a
         * child of the score's version, a lineage claim about notes the model
         * never saw. The lineage fields travel only with the score. */
        if (abc && cot === "off") {
          return json(res, 400, {
            error: "A supplied score needs the chain of thought on — set it to full or melody, or "
              + "untick \"render from this score\". With it off the model plans nothing and cannot "
              + "take a score (protocol.py:99), so nothing was started.",
            engine: musicEngine, reason: "score-needs-cot",
          });
        }
        const cfgRaw = body.cfgScale === "" || body.cfgScale == null ? null : Number(body.cfgScale);
        const job = jobs.enqueue({
          engine: "yue2",
          actor: prov.actorFrom(req),
          title: body.title?.trim() || deriveTitle({ lyrics: body.lyrics, caption: body.caption }),
          /* An instrumental on YuE2 is a phrasing, not a flag: the vendor
           * exposes none, and the model sings brackets, so MiniMax's tag
           * scaffold cannot be used. Empty lyrics plus a style that says so
           * is the whole mechanism; whether the model keeps quiet is measured
           * per render, not promised here. */
          caption: body.instrumental
            ? `${body.caption.trim().replace(/[.,;\s]+$/, "")}. Instrumental, no vocals, no singing, no voice.`
            : body.caption.trim(),
          lyrics: body.instrumental ? "" : (body.lyrics || "").trim(),
          /* protocol.py:95 — an integer in [0, 2^63). The random one stays in
           * MiniMax's 32-bit range so the seed field on the page reads the same. */
          seed: Number.isFinite(body.seed) ? Math.max(0, Math.floor(body.seed)) : Math.floor(Math.random() * 4294967296),
          cot,
          /* cfg_scale in [0, 20] (protocol.py:101); null is the model's own
           * default — 1.0, or 1.01 with the chain of thought off. */
          cfgScale: Number.isFinite(cfgRaw) ? Math.min(Math.max(cfgRaw, 0), 20) : null,
          /* A supplied score is honoured verbatim for zero planning tokens
           * (yue.js STAGES "Using provided score"). It needs cot melody/full
           * (protocol.py:99), so with cot off it is dropped rather than refused
           * by the driver eight minutes in. */
          abc,
          /* The hum-to-song recipe: with a score, leave it open for the planner. */
          abcOpen: !!abc && body.abcOpen === true,
          scoreSlug: abc && typeof body.scoreSlug === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(body.scoreSlug) ? body.scoreSlug : null,
          scoreVersion: abc && typeof body.scoreVersion === "string" && /^[\w.-]{1,40}$/.test(body.scoreVersion) ? body.scoreVersion : null,
          wantSeconds: want,
          rung,
          fitCeiling: chosen.ceiling,
          quantization,
          /* The solver's step count: 32 (the vendor's) or 16 (MEASURED the
           * same render — narab_verdict, 2026-09-11). Nothing else is offered
           * because nothing else was measured. */
          narSteps: Number(body.narSteps) === 16 ? 16 : 32,
          /* A song longer than the vendor's 360 s stop asks the sampler for
           * more. fit() owns the number (maxTokensFor) so the box the form
           * showed and the job that follows it are one decision; the driver's
           * exact clamp (which knows the plan's prefix) trims it under the
           * context window. An attempt past what this card has measured. */
          maxTokens: maxTokensFor(want),
          allowSectionLabels: !!body.allowSectionLabels,
          instrumental: !!body.instrumental,
          preview: false,
          model: "YuE2 3B",
        });
        return json(res, 200, { job: jobs.snapshot().current ?? job, engine: "yue2", rung, ceiling: chosen.ceiling, promoted: chosen.promoted });
      }

      /* YuE2 through ComfyUI: the refusals that cost nothing. */
      let yueLora = null, yueLoraStrength = 1;
      if (musicEngine === "yue2-comfy") {
        if (body.preview) {
          return json(res, 400, { error: "YuE2 has no preview pass: every render is the full model. Press Create instead.", engine: musicEngine, reason: "no-preview" });
        }
        const ckpt = config.music.yue2Checkpoint;
        const shelf = await scanBases(await modelBases());
        const found = ckpt && shelf.some((f) => f.folder === "checkpoints" && f.name === ckpt);
        if (!found) {
          return json(res, 400, {
            error: ckpt
              ? `The YuE2 checkpoint ${bareName(ckpt)} is no longer in a checkpoints folder. Pick another in the music model list.`
              : "No YuE2 checkpoint is chosen. Pick one in the music model list (Models screen or Music tab).",
            engine: musicEngine, reason: "weights-missing",
          });
        }
        /* The LoRA, if one is named — by this request, else by the Music tab's
         * saved choice. "" means none, whatever is saved. A name that is not on
         * any loras shelf is refused here, not dropped: LoraLoaderModelOnly
         * skips keys it cannot match without an error, and a render that
         * silently ignored the LoRA is the failure the picker exists to end. */
        const askedLora = body.lora === undefined ? config.music.yue2Lora : body.lora;
        const loraName = typeof askedLora === "string" && askedLora.trim() ? path.basename(askedLora.trim()) : null;
        if (loraName && !(/\.safetensors$/i.test(loraName) && shelf.some((f) => f.folder === "loras" && f.name === loraName))) {
          return json(res, 400, {
            error: `The LoRA ${bareName(loraName)} is not in a loras folder. Pick another under Advanced Options, or choose none.`,
            engine: musicEngine, reason: "lora-missing",
          });
        }
        yueLora = loraName;
        yueLoraStrength = Number.isFinite(Number(body.loraStrength))
          ? Math.min(Math.max(Number(body.loraStrength), -4), 4)
          : (Number.isFinite(config.music.yue2LoraStrength) ? config.music.yue2LoraStrength : 1);
      }
      const job = jobs.enqueue({
        ...(musicEngine === "yue2-comfy" ? {
          engine: "yue2-comfy",
          cot: ["full", "melody", "off"].includes(body.cot) ? body.cot : "full",
          narSteps: Number(body.narSteps) > 0 ? Math.min(Math.max(Math.round(Number(body.narSteps)), 8), 64) : 32,
          yue2Checkpoint: config.music.yue2Checkpoint,
          lora: yueLora, loraStrength: yueLoraStrength,
        } : {}),
        /* WHO asked, stamped at the API boundary (provenance.js). The browser
         * carries no actor header → "user"; MCP always sends agent:<name>;
         * nothing can claim "user" through the header. Rides the job so the
         * ledger's generate event carries it when the song lands. */
        actor: prov.actorFrom(req),
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
        maxDuration: Math.min(Math.max(Number(body.maxDuration) || 240, 30),
          config.music.engines[musicEngine]?.maxDuration || 300),
        // Both map to real model parameters. No cosmetic dials — the
        // ComfyUI-literate half of the audience will check.
        steps: body.steps ? Math.min(Math.max(Number(body.steps), 6), 40) : undefined,
        cfg: body.cfg ? Math.min(Math.max(Number(body.cfg), 1), 5) : undefined,
        // Separated so the two guidance scales can be swept independently; the
        // UI still sends one `cfg` and both follow it.
        arCfg: body.arCfg ? Math.min(Math.max(Number(body.arCfg), 0), 5) : undefined,
        flowCfg: body.flowCfg ? Math.min(Math.max(Number(body.flowCfg), 0), 5) : undefined,
        model: ["int8", "fp16", "fp32"].includes(body.model) ? body.model : config.music.precision,
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
      return json(res, 200, { job: jobs.snapshot().current ?? job, engine: musicEngine });
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
    /* A hummed melody → the two-voice score YuE2 takes verbatim. CPU only:
     * ffmpeg converts the recording, the engine's python runs a pitch tracker
     * (server/music/hum.js). The answer is ABC for Advanced Options or for
     * make_song's `abc`, plus what was heard. */
    if (p === "/api/hum" && req.method === "POST") {
      const b = await readBody(req);
      try {
        const r = await transcribeHum({ source: b.source, bpm: b.bpm, key: b.key });
        return json(res, 200, { ok: true, ...r });
      } catch (e) {
        return json(res, e?.status || 400, { error: e?.message || String(e) });
      }
    }

    if (p === "/api/extend" && req.method === "POST") {
      const b = await readBody(req);
      const file = String(b.file || "");
      if (!file || file.includes("..") || file.includes("/") || file.includes("\\")) {
        return json(res, 400, { error: "bad file" });
      }
      const meta = library.meta.get(file);
      /* YuE2: the take's run folder holds its whole performance (prefix.npy +
       * semantic.npy), which is what MiniMax keeps as `codes`. The driver
       * replays it behind the words and continues; the join below keeps the
       * original audio up to the seam. */
      const yueMatch = /^aiplay_yue2_([0-9a-f]{8})\.flac$/i.exec(file);
      const yueDir = meta?.yueDir || (yueMatch ? path.join(config.outputDir, "yue2", yueMatch[1]) : null);
      if (meta && (meta.engine === "yue2" || yueDir)) {
        if (!yueDir || !(await stat(path.join(yueDir, "result.json")).catch(() => null))) {
          return json(res, 400, { error: "This YuE2 take's run folder is gone, so its performance cannot be replayed.", reason: "run-missing" });
        }
        const dur = meta.durationSeconds || 0;
        const fromSec = Number.isFinite(b.fromSeconds)
          ? Math.max(1, Math.min(b.fromSeconds, Math.max(1, dur - 1)))
          : Math.max(1, dur * 0.8);
        /* The WHOLE sheet, old words then new: the replayed tokens sit under the
         * old words and the sampler continues into the new ones. Brackets are
         * refused as they are on Create — this model sings them. */
        const lyrics = typeof b.lyrics === "string" && b.lyrics.trim() ? b.lyrics.trim() : (meta.lyrics || "");
        if (/^\s*\[[^\]\n]+\]\s*$/m.test(lyrics)) {
          return json(res, 400, { error: "YuE2 sings whatever is in brackets: send the whole lyric sheet, old words then new, with no [section] labels.", reason: "lyrics" });
        }
        const abc = typeof b.abc === "string" && b.abc.trim() ? b.abc.trim() : null;
        const extra = Math.min(Math.max(Number(b.seconds) || 45, 8), 300);
        const want = Math.round(fromSec + extra);
        const capability = await cudaCapability();
        const chosen = fit(want, { capability });
        const rung = { id: chosen.rung.id, label: chosen.rung.label, ...rungArgs(chosen.rung.id) };
        const job = jobs.enqueue({
          engine: "yue2", actor: prov.actorFrom(req),
          title: `${meta.title || file} · extended`,
          caption: b.caption?.trim() || meta.caption || "",
          lyrics, abc,
          seed: Number.isFinite(b.seed) ? Math.max(0, Math.floor(b.seed)) : Math.floor(Math.random() * 4294967296),
          cot: ["full", "melody", "off"].includes(meta.cot) ? meta.cot : "full",
          cfgScale: Number.isFinite(meta.cfg) ? meta.cfg : null,
          quantization: meta.quantization === "fp8" ? "fp8" : "none",
          narSteps: meta.steps === 16 ? 16 : 32,
          wantSeconds: want, rung, fitCeiling: chosen.ceiling, maxTokens: maxTokensFor(want),
          instrumental: !!meta.instrumental, preview: false, model: "YuE2 3B",
          extendFrom: yueDir, fromSeconds: fromSec, extendedFrom: file,
        });
        return json(res, 200, { job: jobs.snapshot().current ?? job, engine: "yue2", resumedFromSeconds: Math.round(fromSec) });
      }
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
        actor: prov.actorFrom(req),
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
      /* ONE STOP BUTTON FOR EVERY KIND OF GENERATION — AND FOR NOBODY ELSE'S.
       *
       * This used to cancel only the song job, so the button was a lie the
       * moment the thing running was an image or a clip. Both are stopped, and
       * the reply says what each one did.
       *
       * ⚠ IT ALSO USED TO STOP THE ENGINE. `art.stopAll()` interrupts whatever
       * is rendering and then POSTs `{clear:true}` to ComfyUI's queue, which
       * empties the pending list wholesale. Measured twice on 2026-09-05: with
       * a chat turn queued behind a song, one press left that turn in neither
       * /history nor /queue, with no output file and a ledger row reading
       * `vanished`. This button may stop the user's song and the user's
       * pictures; a chat turn, a gate render or a control pass queued beside
       * them is somebody else's work and keeps its place.
       *
       * So each half is addressed at its own work. The song goes through
       * jobs.cancel(), which now withdraws its own prompt and nothing else.
       * Art's QUEUED jobs were never submitted to the engine, so dropping them
       * touches no engine queue at all; and art's one IN-FLIGHT render is
       * cancelled through the door, by runId, from the door's own record of who
       * is running what.
       *
       * ⚠ THE RESIDUAL, SAID RATHER THAN LEFT TO BE FOUND: this reaches into
       * the art runner's queue instead of calling one method on it, because
       * that method — a `stopMine()` beside `stopAll()` — belongs in art.js,
       * which is outside this change. `stopAll()` itself is left alone: as the
       * engine-wide sledgehammer reached from the Engine panel it is honest
       * about what it does. It is just not what a Stop button may mean. */
      await jobs.cancel();
      const wasRunning = art.status().art?.current?.title ?? null;
      /* Every distinct file once: drop() is keyed on file and removes every job
       * carrying it, so a `for` over the queue itself would skip entries as it
       * shortened. */
      let dropped = 0;
      for (const f of [...new Set(art.queue.map((j) => j.file))]) dropped += art.drop(f).removed;
      /* A Stop button must never fail because a status read did. Nothing to
       * cancel is the right answer when the door cannot say what is running. */
      const live = await engineDoor.status().catch(() => ({ running: [] }));
      const mine = (live.running || []).filter((r) => String(r.via || "").startsWith("art."));
      const stops = await Promise.all(mine.map((r) => engineDoor.cancelRun({ runId: r.runId })));
      const artStopped = {
        dropped, wasRunning,
        interrupted: stops.some((s) => s.stopped === true),
        engineCancelled: stops.filter((s) => s.stopped === true).length,
      };
      return json(res, 200, { ...jobs.snapshot(), artStopped });
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
    /* Cancel ONE thing, rather than everything. /api/cancel is all-or-nothing
     * and was the only option; these two are the surgical versions. */
    if (p === "/api/artqueue" && req.method === "POST") {
      const b = await readBody(req);
      if (b.action === "drop") {
        const file = String(b.file || "");
        if (!file) return json(res, 400, { error: "give a file" });
        const r = art.drop(file);
        return json(res, 200, { ok: true, ...r, ...art.status() });
      }
      if (b.action === "stop_current") {
        const r = await art.stopCurrent();
        return json(res, 200, { ok: true, ...r, ...art.status() });
      }
      return json(res, 400, { error: "action must be drop or stop_current" });
    }

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
        /* `eng` is the engine that will really render — the setting when its
         * weights are here, whatever IS here when they are not. Everything
         * below reads it instead of config.video.engine, because a substituted
         * engine that still took the other engine's frame rule and native size
         * would be worse than the refusal it replaced. */
        const gate = await videoWeightsGate();
        if (gate.error) return json(res, 400, gate.error);
        const eng = gate.engine;
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
        if ((refImages.length || refAudios.length) && eng !== "h3") {
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
          actor: prov.actorFrom(req),
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
            // The RESOLVED one: what actually renders, not what the setting
            // says, so the provenance record names the model that made the file.
            engine: eng,
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
            seconds: Math.min(Math.max(Number(b.seconds) || videoEngine(eng).seconds, 1), 20),
            /* 3840, not 1920. Native resolution retains detail an upscaler can
             * only invent, so the ceiling is the hardware's rather than a round
             * number's — and the honest limit here is TIME and free system RAM,
             * not VRAM: both engines stream weights from pinned host memory.
             * The render deadline already scales with pixels x frames, so a big
             * ask gets a big budget instead of being killed mid-render. */
            width: Math.min(Math.max(Number(b.width) || videoEngine(eng).width, 256), 3840),
            height: Math.min(Math.max(Number(b.height) || videoEngine(eng).height, 256), 3840),
            steps: Math.min(Math.max(Number(b.steps) || videoEngine(eng).steps || 20, 2), 40),
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
        /* One map, in models.js, rather than this ternary retyped at each of
         * the three places that needed it. A third engine added to config.js
         * used to silently resolve to "video" here — H3's capability — and
         * report H3's download size for a model that is not H3. */
        const capId = MODEL_TO_CAPABILITY[e];
        const cap = (await models.status()).find((c) => c.id === capId);
        if (cap && !cap.ready) {
          const gb = ((cap.totalBytes - cap.haveBytes) / 1e9).toFixed(1);
          return json(res, 400, {
            /* A gated engine gets the hand-fetch, not "open the Models screen"
             * — there is no button there for it, which is the whole reason this
             * app pointed a fresh install at a dead end for as long as it did. */
            error: cap.gated
              ? `${config.video.engines[e].label} cannot be downloaded by Studio (${gb} GB, access-gated repository). ${cap.gated.how}`
              : `${config.video.engines[e].label} is not downloaded yet (${gb} GB missing). Open the Models screen.`,
            needsModel: cap.gated ? null : capId,
            gated: cap.gated || null,
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
        const gate = await videoWeightsGate();
        if (gate.error) return json(res, 400, gate.error);
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
        if (!["flux2", "zimage", "zimage-base", "anima", "ideogram4", "checkpoint"].includes(b.engine)) {
          return json(res, 400, { error: "engine must be flux2 | zimage | zimage-base | ideogram4 | checkpoint" });
        }
        if (b.engine === "zimage" || b.engine === "zimage-base") {
          const capId = b.engine === "zimage" ? "imageZImage" : "imageZImageBase";
          const cap = (await models.status()).find((c) => c.id === capId);
          if (cap && !cap.ready) return json(res, 400, { error: `${cap.label} is not downloaded — open the Models screen first.` });
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
          try { await stat(path.join(config.modelsDir, "checkpoints", nm)); }
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

    /**
     * The music engine, chosen and REMEMBERED.
     *
     * ⚠ THE CHOICE WAS CLIENT-ONLY UNTIL THIS EXISTED, which is subtler than it
     * sounds: `config.music.engine` was already in PREF_PATHS and /api/status
     * already served it, so the round trip LOOKED complete from both ends — the
     * page paints the saved engine on load, and the select updates
     * `state.musicEngine` on change. Nothing carried the change back, so
     * picking YuE2 and reloading returned you to MiniMax with no error to
     * explain it. The video engine has posted its choice since it shipped
     * (/api/video, action "engine"); this is the same shape for the same reason.
     *
     * The readiness check is not decoration. Accepting an engine whose weights
     * are absent makes the click look successful and the render fail minutes
     * later inside a subprocess, detached from the cause. MODEL_TO_CAPABILITY
     * is consulted rather than a ternary, because a third engine added to
     * config.js must not silently resolve to another engine's capability — that
     * is exactly how the video path once reported H3's download size for a
     * model that was not H3.
     */
    if (p === "/api/music" && req.method === "POST") {
      const b = await readBody(req);
      /* THE MUSIC MODEL PICKER: an engine and its build in one choice. A build
       * that cannot render here is refused at the click; native YuE2 GGUF may be
       * chosen while not installed, because choosing it is how its setup panel
       * is reached (and it downloads nothing). */
      /* LOAD / UNLOAD — optional; nothing needs them. The first song loads its
       * model and a different model unloads the old one (jobs.js). Load exists
       * to take the wait out of the first song; Unload gives the card and the
       * RAM back without stopping Studio. */
      if (b.action === "unload" || b.action === "load") {
        if (jobs.current || jobs.queue.length) return json(res, 409, { error: "Wait for the current song to finish first." });
        if (!comfy.ready) return json(res, 409, { error: "ComfyUI is not running yet." });
        if (b.action === "unload") return json(res, 200, { ok: true, report: await jobs.unloadModels(), ...jobs.snapshot() });
        if (config.music.engine !== "yue2-comfy" || !config.music.yue2Checkpoint) {
          return json(res, 400, { error: "Load now is for YuE2 through ComfyUI. Other models load with their first song." });
        }
        const key = `yue2-comfy:${config.music.yue2Checkpoint}`;
        if (jobs.loaded && jobs.loaded.key !== key) await jobs.unloadModels();
        /* A one-second render with no score plan and one step: enough to put
         * the language model, the audio model and the VAE into ComfyUI. The
         * save node becomes PreviewAudio, which writes to ComfyUI's TEMP
         * folder — a warm-up must never become a song or a library row. */
        const graph = buildYue2ComfyGraph({
          caption: "warm-up", lyrics: "", cot: "off", maxDuration: 1, steps: 1,
          checkpoint: config.music.yue2Checkpoint, seed: Date.now() % 4294967296, prefix: "aiplay_warmup",
          lora: config.music.yue2Lora, loraStrength: config.music.yue2LoraStrength,
        });
        for (const n of Object.values(graph)) {
          if (/^Save/.test(n.class_type || "")) { n.class_type = "PreviewAudio"; n.inputs = { audio: n.inputs.audio }; }
        }
        const t0 = Date.now();
        const r = await engineDoor.run({ graph, actor: prov.actorFrom(req), via: "music.load", label: "Load YuE2 into ComfyUI", adopt: false });
        const status = r?.status ?? r?.result?.status;
        if (status && status !== "completed") return json(res, 500, { error: `Loading failed: ${r?.error || r?.result?.error || status}` });
        jobs.markLoaded(key);
        const seconds = Math.round((Date.now() - t0) / 1000);
        console.log(`  [music] loaded ${key} into ComfyUI in ${seconds} s`);
        return json(res, 200, { ok: true, seconds, ...jobs.snapshot() });
      }
      if (b.action === "lora") {
        /* The Music tab's LoRA choice for YuE2 through ComfyUI, remembered.
         * null / "" clears it. The file must be on a loras shelf now; a name
         * that is not there is refused rather than saved for a later render to
         * trip over. */
        const raw = b.value == null ? "" : String(b.value).trim();
        const name = raw ? path.basename(raw) : null;
        if (name) {
          const shelf = await scanBases(await modelBases());
          if (!/\.safetensors$/i.test(name) || !shelf.some((f) => f.folder === "loras" && f.name === name)) {
            return json(res, 400, { error: `${bareName(name)} is not in a loras folder.` });
          }
        }
        config.music.yue2Lora = name;
        if (Number.isFinite(Number(b.strength))) config.music.yue2LoraStrength = Math.min(Math.max(Number(b.strength), -4), 4);
        savePrefs();
        return json(res, 200, { ok: true, music: { yue2Lora: config.music.yue2Lora, yue2LoraStrength: config.music.yue2LoraStrength } });
      }
      if (b.action === "model") {
        const choice = (await musicModelChoices(await models.status())).find((x) => x.value === String(b.value || ""));
        if (!choice) return json(res, 400, { error: "Unknown music model." });
        if (config.musicOnly && choice.engine !== "yue2-gguf" && !(choice.engine === "yue2-comfy" && comfyWanted)) {
          return json(res, 400, { error: "Start full Studio to use other engines." });
        }
        if (!choice.available && choice.engine !== "yue2-gguf") {
          return json(res, 400, { error: `${choice.label} is not ready (${choice.note}). Open the Models screen.` });
        }
        config.music.engine = choice.engine;
        if (choice.engine === "minimax-music3") config.music.precision = choice.precision;
        if (choice.engine === "yue2-comfy") config.music.yue2Checkpoint = choice.checkpoint;
        musicChoicesCache.at = 0;
        /* Choosing a different model gives the card back straight away rather
         * than at the next song. Native GGUF has no ComfyUI key, so choosing it
         * unloads too — its own runtime needs that VRAM. Never mid-render. */
        const nextKey = choice.engine === "yue2-comfy" ? `yue2-comfy:${choice.checkpoint}`
          : choice.engine === "minimax-music3" ? `minimax-music3:${choice.precision}` : null;
        if (jobs.loaded && jobs.loaded.key !== nextKey && !jobs.current && !jobs.queue.length) {
          await jobs.unloadModels().catch(() => {});
        }
        savePrefs();
        return json(res, 200, { ok: true, music: { engine: choice.engine, precision: choice.precision } });
      }
      if (b.action === "engine") {
        const e = String(b.value || "");
        if (!config.music.engines[e]) return json(res, 400, { error: "Unknown engine." });
        if (config.musicOnly && e !== "yue2-gguf" && !(e === "yue2-comfy" && comfyWanted)) return json(res,400,{error:"Start full Studio to use other engines."});
        const capId = MODEL_TO_CAPABILITY[e];
        const cap = capId ? (await models.status()).find((c) => c.id === capId) : null;
        if (e !== "yue2-gguf" && cap && !cap.ready) {
          const gb = ((cap.totalBytes - cap.haveBytes) / 1e9).toFixed(1);
          return json(res, 400, {
            error: cap.gated
              ? `${config.music.engines[e].label} cannot be downloaded by Studio (${gb} GB, access-gated repository). ${cap.gated.how}`
              : `${config.music.engines[e].label} is not downloaded yet (${gb} GB missing). Open the Models screen.`,
            needsModel: cap.gated ? null : capId,
            gated: cap.gated || null,
          });
        }
        config.music.engine = e;
        savePrefs();
        return json(res, 200, { ok: true, music: { engine: e } });
      }
      /* WHICH CONFIGURATION REACHES A WANTED DURATION, and what to say about
       * it. Server-side because `fit()` is the only place that decides, and a
       * browser copy of that decision is a second opinion waiting to drift.
       *
       * The capability is read here rather than sent by the page: the card is
       * the server's fact, and a client that could assert "capability 9.0"
       * would be choosing its own rung. Cached because it cannot change while
       * the process lives.
       */
      if (b.action === "fit") {
        const eng = config.music.engines[config.music.engine];
        if (!eng || !eng.durationLadder) {
          return json(res, 400, {
            error: `${eng?.label || config.music.engine} has no configuration ladder — `
              + `its length is a parameter, not an outcome.`,
            engine: config.music.engine,
          });
        }
        const seconds = Number(b.seconds);
        const answer = fit(Number.isFinite(seconds) && seconds > 0 ? seconds : null,
                           { capability: await cudaCapability() });
        return json(res, 200, {
          ok: true,
          rung: { id: answer.rung.id, label: answer.rung.label,
                  quantization: answer.rung.quantization, offloadAr: answer.rung.offloadAr,
                  savesGib: answer.rung.savesGib, lowers: answer.rung.lowers },
          ceiling: answer.ceiling, promoted: answer.promoted,
          wantSeconds: answer.wantSeconds, info: answer.info,
          /* The ceilings travel with the answer so the slider can mark them
           * without a second request and without hardcoding 360 in the page. */
          ceilings: { generation: GENERATION_CAP_SECONDS, context: CONTEXT_SECONDS },
        });
      }
      return json(res, 400, { error: "Unknown action." });
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

      const engine = ["flux2", "zimage", "zimage-base", "anima", "ideogram4", "checkpoint"].includes(b.engine) ? b.engine : "flux2";
      if (engine === "anima") {
        const cap = (await models.status()).find((c) => c.id === "imageAnima");
        if (cap && !cap.ready) {
          return json(res, 400, {
            error: `Anima needs its text encoder and VAE (${(((cap.totalBytes - cap.haveBytes) || 0) / 1e9).toFixed(2)} GB). Open the Models screen — the DiT you already have is the big half.`,
          });
        }
        /* The DiT is named by the CALLER and must live in models/diffusion_models:
         * UNETLoader reads that folder, so an Anima file left in
         * models/checkpoints is invisible to it however the engine is picked.
         * Checked here so the answer is a sentence rather than a ComfyUI stack
         * trace three minutes into a queue. */
        const dn = path.basename(String(b.dit || config.art.animaDit || ""));
        if (!dn) {
          return json(res, 400, { error: "Pick an Anima model file first (models/diffusion_models)." });
        }
        try { await stat(path.join(config.modelsDir, "diffusion_models", dn)); }
        catch {
          return json(res, 400, {
            error: `No such Anima model in models/diffusion_models: ${dn}. If it is still in models/checkpoints, move it — a bare transformer is loaded from diffusion_models.`,
          });
        }
        b.dit = dn;
        if (Array.isArray(b.refImages) && b.refImages.length) {
          return json(res, 400, { error: "Anima has no reference input — in-context editing is FLUX.2's trick. Switch the engine to FLUX.2 for refs." });
        }
      }
      if (engine === "zimage" || engine === "zimage-base") {
        const capId = engine === "zimage" ? "imageZImage" : "imageZImageBase";
        const cap = (await models.status()).find((c) => c.id === capId);
        if (cap && !cap.ready) {
          return json(res, 400, {
            error: `${cap.label} is not downloaded yet (${((cap.totalBytes - cap.haveBytes) / 1e9).toFixed(1)} GB missing). Open the Models screen.`,
          });
        }
        if (Array.isArray(b.refImages) && b.refImages.length) {
          return json(res, 400, { error: "Reference images are FLUX's trick — no released Z-Image checkpoint takes them. ComfyUI has the node (TextEncodeZImageOmni, up to 3 images) but the weights it needs, Z-Image-Edit and Z-Image-Omni-Base, are both still unreleased. Switch the engine to FLUX.2 for refs." });
        }
        /* REFUSED, not ignored — the same rule the reference block above
         * follows, for the same reason. Turbo samples at cfg 1.0, where
         * ComfyUI never evaluates the uncond branch at all, so a negative
         * prompt would be text the model never sees. Silently dropping the
         * user's own input is the failure mode this codebase keeps finding;
         * saying which engine WOULD honour it is the fix.
         *
         * ⚠ ASKED OF THE PRESET, not re-derived from the engine name. The
         * graph builder is what decides whether a variant gets a real
         * CLIPTextEncode or a ConditioningZeroOut, so `cfgs` is the one place
         * that answer lives — a third variant added to ZIMAGE_PRESET is
         * refused or accepted correctly here without anyone remembering to
         * come back. */
        const variant = engine === "zimage-base" ? "base" : "turbo";
        if (!ZIMAGE_PRESET[variant].cfgs && String(b.negative || "").trim()) {
          return json(res, 400, { error: "Z-Image Turbo is distilled and samples at cfg 1.0, where the negative prompt is never evaluated — it would be ignored, so it is refused instead. Switch the engine to Z-Image base (25 steps, cfg 4.0), which does honour it." });
        }
      }
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
        try { await stat(path.join(config.modelsDir, "checkpoints", nm)); }
        catch { return json(res, 400, { error: `No such checkpoint: ${nm}` }); }
        b.checkpoint = nm;
        if (Array.isArray(b.refImages) && b.refImages.length) {
          return json(res, 400, { error: "Reference images are FLUX's trick — switch the engine to FLUX.2 for refs." });
        }
      }
      /* DYNAMIC PROMPTS. `{a|b|c}` picks one option per render, and an empty
       * option is legal — `{, at night|}` is how a detail appears half the
       * time. The template is what the user typed; the EXPANSION is what the
       * model sees, and both are kept: the choices are recorded beside the
       * seed so any one frame of an overnight run can be reproduced exactly.
       * A prompt with no braces goes through untouched. */
      const template = String(b.prompt || "").trim();
      if (!template) return json(res, 400, { error: "Describe the picture first." });
      const wild = hasWildcards(template);
      const { prompt, choices } = Array.isArray(b.promptChoices)
        ? expand(template, { replay: b.promptChoices })
        : expand(template);

      /* A PERSONA, folded in. Its references go FIRST because the prompt refers
       * to them by position ("image 1") and a character whose number moves when
       * a scene reference is added is a character that stops working. Refused
       * loudly on an engine that cannot use references rather than quietly
       * dropped — a picture that silently lacks the character it was asked for
       * looks like the feature not working. */
      let personaUsed = null;
      if (b.persona) {
        personaUsed = await personas.get(String(b.persona));
        if (!personaUsed) return json(res, 400, { error: `No persona called "${b.persona}".` });
        const fit = personaFits(engine);
        if (fit.fit !== "yes") {
          return json(res, 400, {
            error: `"${personaUsed.name}" cannot be used on this engine — ${fit.why}. Switch to FLUX.2.`,
          });
        }
      }

      /* Reference images — FLUX in-context editing. Staged into ComfyUI's
       * input dir exactly the way video frames are: an already-staged upload
       * name passes through, a cover or Images-screen file is copied in. The
       * prompt refers to them as "image 1", "image 2" in this order. */
      let refImages = [];
      /* Hoisted: the persona path stages its own references through the same
       * function, and a second copy would be a second thing to drift. */
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
      if (Array.isArray(b.refImages) && b.refImages.length) {
        refImages = (await Promise.all(b.refImages.slice(0, 10).map(async (v) => {
          try { return await stage(v); } catch { return undefined; }
        }))).filter(Boolean);
      }

      /* The persona's own reference pictures have to be STAGED too — they are
       * library names exactly like the ones the caller passed, and a name that
       * never reached ComfyUI's input folder is a reference the sampler cannot
       * see. Done here so both sources go through one path. */
      if (personaUsed?.refImages?.length) {
        const staged = (await Promise.all(personaUsed.refImages.map(async (v) => {
          try { return await stage(v); } catch { return undefined; }
        }))).filter(Boolean);
        personaUsed = { ...personaUsed, refImages: staged };
      }
      const shaped = applyPersona(personaUsed, { prompt, refImages });
      const finalPrompt = shaped.prompt;
      refImages = shaped.refImages;

      const id = `i${Date.now().toString(36)}`;
      const file = `image:${id}`;
      pendingImagePrompt.set(file, finalPrompt);
      pendingImageActor.set(file, prov.actorFrom(req));
      if (wild) pendingImageWild.set(file, { template, promptChoices: choices });
      /* Everything the render is, BEFORE it is queued — so the duplicate
       * guard can see the real numbers rather than guess them. */
      const shot = {
        file, title: finalPrompt.slice(0, 48), kind: "cover", force: true,
        /* WHO ASKED, carried all the way to the engine door — the same value
         * that already goes into pendingImageActor for the library event, so
         * the technical record and the library row cannot disagree about who
         * wanted this picture. */
        actor: prov.actorFrom(req),
        seed: Number.isFinite(b.seed) ? Number(b.seed) : Math.floor(Math.random() * 4294967296),
        video: {
          prompt: finalPrompt,
          engine,
          quality: b.quality === "quality" ? "quality" : "default",
          checkpoint: b.checkpoint || undefined,
          dit: engine === "anima" ? b.dit : undefined,
          negative: typeof b.negative === "string" ? b.negative.slice(0, 2000) : undefined,
          cfg: Number.isFinite(b.cfg) ? Math.min(Math.max(Number(b.cfg), 1), 15) : undefined,
          // One text encode serves up to four pictures — see coverGraph.
          count: Math.min(Math.max(Number(b.count) || 1, 1), 4),
          width: Math.min(Math.max(Number(b.width) || config.art.size, 256), 2048),
          height: Math.min(Math.max(Number(b.height) || config.art.size, 256), 2048),
          /* ⚠ NO APP-WIDE DEFAULT FOR Z-IMAGE, on purpose.
           *
           * `config.art.steps` is 4 — FLUX.2 klein's distilled number — and
           * substituting it here would sample Z-Image Turbo at half its
           * schedule and Z-Image base at a sixth of its, silently, whenever a
           * caller (the MCP tool, curl, an old client) omitted the field.
           * Undefined is the signal that nobody asked, and zImageGraph then
           * fills in the vendor preset for the variant it is building — 8 for
           * turbo, 25 for base (ZIMAGE_PRESET in workflow.js).
           *
           * The ceiling differs too: base's own README suggests up to 50, so
           * the 30 that suits FLUX and Ideogram would clip a legitimate ask. */
          steps: (() => {
            const zimage = engine === "zimage" || engine === "zimage-base";
            const asked = Number(b.steps);
            if (!(asked > 0)) return zimage ? undefined : Math.min(Math.max(config.art.steps, 1), 30);
            return Math.min(Math.max(asked, 1), engine === "checkpoint" ? 60 : zimage ? 50 : 30);
          })(),
          /* SD-FAMILY DIALS. Only meaningful on the checkpoint engine — FLUX,
           * Z-Image and Anima have no CLIP text encoder at all, so a CLIP-skip
           * box on those would be a control that does nothing. Passed through
           * undefined otherwise, which leaves every other graph untouched. */
          /* LoRAs, stacked. Checkpoint engine only: FLUX.2 klein, Z-Image and
           * Ideogram load as bare DiTs here and LoraLoader takes a
           * CheckpointLoader’s model+clip pair, which they do not produce.
           * Names are basenamed — a lora_name is a filename inside
           * models/loras, never a path. */
          loras: engine === "checkpoint" && Array.isArray(b.loras)
            ? b.loras.slice(0, 8)
                .map((l) => ({
                  name: path.basename(String(l?.name || "")),
                  strength: Number.isFinite(l?.strength) ? Math.min(Math.max(Number(l.strength), -4), 4) : 1,
                  clipStrength: Number.isFinite(l?.clipStrength)
                    ? Math.min(Math.max(Number(l.clipStrength), -4), 4) : undefined,
                }))
                .filter((l) => l.name && /\.safetensors$/i.test(l.name))
            : undefined,
          clipSkip: engine === "checkpoint" && Number(b.clipSkip) > 1
            ? Math.min(Math.round(Number(b.clipSkip)), 12) : undefined,
          sampler: engine === "checkpoint" && typeof b.sampler === "string" ? b.sampler.slice(0, 40) : undefined,
          scheduler: engine === "checkpoint" && typeof b.scheduler === "string" ? b.scheduler.slice(0, 40) : undefined,
          refImages,
        },
      };

      /* THE FORGOTTEN SEED. Each render individually succeeds, so nothing was
       * ever in a position to notice that an overnight run was making the same
       * picture all night. Identity is the EXPANDED prompt plus the model and
       * every sampling number; a fresh seed is rolled rather than refused,
       * because the caller wanted this picture and the only thing wrong is that
       * it already exists — but the move is reported, never silent. */
      const dedupe = b.dedupe !== false;
      const identityJob = {
        engine, checkpoint: shot.video.checkpoint || null, prompt: finalPrompt,
        negative: shot.video.negative || "", seed: shot.seed,
        width: shot.video.width, height: shot.video.height,
        steps: shot.video.steps, cfg: shot.video.cfg, refImages,
      };
      let dupNote = null;
      if (dedupe) {
        const r = resolveRepeat(identityJob, imageDupGuard, { reroll: b.dedupe !== "refuse" });
        if (r.refused) return json(res, 400, { error: r.note });
        if (r.changed) { shot.seed = r.job.seed; identityJob.seed = r.job.seed; }
        dupNote = r.note;
      }
      imageDupGuard.remember(identityJob);

      const job = art.request(shot);
      return json(res, 200, {
        ok: true, id, job: job && { id: job.id }, seed: shot.seed,
        /* The expansion travels back so the screen and an MCP caller both see
         * WHAT WAS ACTUALLY ASKED, not the template. `promptChoices` fed back
         * into a later call reproduces this exact prompt. */
        ...(wild ? { template, prompt, promptChoices: choices, combinations: combinations(template) } : {}),
        ...(dupNote ? { note: dupNote } : {}),
        ...art.status(),
      });
    }

    /* The bring-your-own-model shelf: whatever .safetensors sits in
     * ComfyUI/models/checkpoints. The app lists, it does not curate. */
    /* See what a dynamic prompt will actually produce, before spending a night
     * on it. Renders nothing and touches no model. */
    /* WHAT THIS INSTALL CAN ACTUALLY SAMPLE WITH, read from ComfyUI rather than
     * written down here. A hardcoded list goes stale the first time a custom
     * node pack adds a sampler, and offering a name the engine does not have
     * fails at render time with a stack trace instead of at pick time with a
     * list. */
    if (p === "/api/sampling/options" && req.method !== "POST") {
      try {
        /* Read from the ENGINE, through the one client that knows where it is.
         * A hardcoded list goes stale the first time a node pack adds a sampler;
         * a hardcoded ADDRESS goes stale at every engine start now that the port
         * is reserved fresh, which is why this cannot be a fetch here. */
        const info = await engineDoor.objectInfo("KSampler");
        /* ⚠ Only SOME nodes inline their combo options; others report the bare
         * string "COMBO" and resolve lazily. Reading [0] and testing .length
         * would "pass" on the five characters of the word COMBO — a check that
         * cannot fail, which is worse than no check. Only trust a real array. */
        const asList = (v) => (Array.isArray(v) ? v : null);
        const req_ = info.KSampler?.input?.required || {};
        return json(res, 200, {
          ok: true,
          samplers: asList(req_.sampler_name?.[0]) ?? [],
          schedulers: asList(req_.scheduler?.[0]) ?? [],
          defaults: { sampler: "dpmpp_2m", scheduler: "karras" },
        });
      } catch {
        return json(res, 200, { ok: false, reason: "the engine did not answer" });
      }
    }

    if (p === "/api/prompt/preview" && req.method === "POST") {
      const b = await readBody(req);
      const template = String(b.prompt || "");
      const n = Math.min(Math.max(Number(b.samples) || 8, 1), 50);
      const all = enumerate(template, 200);
      const samples = Array.from({ length: n }, () => expand(template));
      return json(res, 200, {
        ok: true, template, wildcards: hasWildcards(template),
        combinations: combinations(template),
        /* enumerate() caps; saying so matters because a truncated list that
         * looks complete is worse than no list. */
        all: all.prompts, truncated: all.truncated,
        samples: samples.map((r) => ({ prompt: r.prompt, choices: r.choices })),
      });
    }

    /* THE LoRA SHELF. Same idea as the checkpoint shelf and the same reason: a
     * filename does not say what a file is for, and here the failure is silent.
     * LoraLoader matches keys and SKIPS what does not match, so an SDXL LoRA on
     * FLUX renders happily and changes nothing — no error, no effect, and a
     * night wasted wondering why the style never arrived.
     *
     * Pass ?for=<checkpoint filename> and each row says whether it fits THAT
     * model, in three states: a "cannot tell" is not a "no", because removing a
     * file someone deliberately downloaded is worse than letting them try it. */
    /* BARE TRANSFORMERS. UNETLoader reads models/diffusion_models, and a DiT
     * left in models/checkpoints is invisible to it however the engine is
     * picked — so the Anima picker lists from the folder that actually works,
     * and the checkpoint shelf tells anyone with a file in the wrong place.
     * ?family= filters to one architecture, because offering a Z-Image DiT to
     * the Anima engine would be a choice that can only fail. */
    /* PERSONAS. A saved character: references plus a description, attachable to
     * a render so the same face turns up in a new scene. ?for=<engine> judges
     * whether it can be used at all — references are FLUX.2-only, and offering
     * a character that will be silently ignored is the failure worth avoiding. */
    /* THE PROMPT SHELF. Templates the agent drafted or a person wrote, kept so
     * a good one is reusable. ?tag= filters to a kind (characters, outfits,
     * sceneries, styles). Every row carries what its template can produce, so
     * the count that decides whether a night is varied is on the shelf rather
     * than a preview away. */
    if (p === "/api/prompts" && req.method === "GET") {
      const rows = await promptShelf.list(url.searchParams.get("tag") || "");
      return json(res, 200, {
        templates: rows.map((t) => ({ ...t, combinations: combinations(t.template) })),
      });
    }

    if (p === "/api/prompts" && req.method === "POST") {
      const b = await readBody(req);
      try {
        if (b.action === "delete") {
          const gone = await promptShelf.remove(String(b.id || b.name || ""));
          return json(res, gone ? 200 : 404, gone ? { ok: true } : { error: "No such template." });
        }
        /* WHO WROTE IT is taken from the request, never the body: a caller must
         * not be able to claim a template was typed by a person. */
        const saved = await promptShelf.save({ ...b, by: prov.actorFrom(req) });
        return json(res, 200, { ok: true, template: { ...saved, combinations: combinations(saved.template) } });
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) });
      }
    }

    if (p === "/api/personas" && req.method === "GET") {
      const eng = String(url.searchParams.get("for") || "");
      const rows = await personas.list();
      return json(res, 200, {
        personas: eng ? rows.map((x) => ({ ...x, fits: personaFits(eng) })) : rows,
        ...(eng ? { engine: eng, fits: personaFits(eng) } : {}),
      });
    }

    if (p === "/api/personas" && req.method === "POST") {
      const b = await readBody(req);
      try {
        if (b.action === "delete") {
          const gone = await personas.remove(String(b.id || b.name || ""));
          return json(res, gone ? 200 : 404, gone ? { ok: true } : { error: "No such persona." });
        }
        const saved = await personas.save(b);
        return json(res, 200, { ok: true, persona: saved });
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) });
      }
    }

    if (p === "/api/dits" && req.method === "GET") {
      const want = String(url.searchParams.get("family") || "").toLowerCase();
      const dir = path.join(config.modelsDir, "diffusion_models");
      let files = [];
      try { files = (await readdir(dir)).filter((f) => /\.safetensors$/i.test(f)); }
      catch { /* no folder yet */ }
      const rows = [];
      for (const name of files) {
        const full = path.join(dir, name);
        const key = `dit:${name}:${(await stat(full).catch(() => ({}))).mtimeMs ?? 0}`;
        let probe = ckptProbeCache.get(key);
        if (!probe) { probe = await probeModel(full); ckptProbeCache.set(key, probe); }
        if (want && String(probe.family).toLowerCase() !== want) continue;
        rows.push({ name, bytes: probe.bytes, at: probe.at, family: probe.family, variant: probe.variant ?? null });
      }
      rows.sort((a, b) => (b.at || 0) - (a.at || 0));
      return json(res, 200, { dits: rows });
    }

    if (p === "/api/loras" && req.method === "GET") {
      /* Every base the engine loads from (the Models screen's folder, a ComfyUI
       * Desktop install's extra paths), not only config.modelsDir: the music
       * checkpoint list reads the same shelves, and a LoRA beside a checkpoint
       * ComfyUI can see must be listable here. First base wins a duplicate
       * name, which is also the order ComfyUI resolves it in. */
      const shelf = await scanBases(await modelBases());
      const seen = new Set();
      const files = shelf.filter((f) => f.folder === "loras" && /\.safetensors$/i.test(f.name)
        && !seen.has(f.name) && seen.add(f.name));

      const forName = path.basename(String(url.searchParams.get("for") || ""));
      let against = null;
      if (forName) {
        /* A bare DiT (Krea 2, the MiniMax models) lives in diffusion_models or
         * unet, not checkpoints; a LoRA is judged against whichever holds it. */
        const ck = shelf.find((f) => ["checkpoints", "diffusion_models", "unet"].includes(f.folder) && f.name === forName);
        if (ck) { try { against = await probeModel(ck.full); } catch { /* unreadable checkpoint */ } }
      }

      const rows = await Promise.all(files.map(async ({ name, full }) => {
        const key = `lora:${name}:${(await stat(full).catch(() => ({}))).mtimeMs ?? 0}`;
        let probe = ckptProbeCache.get(key);
        if (!probe) { probe = await probeModel(full); ckptProbeCache.set(key, probe); }
        const base = probe.family === "lora" ? probe.variant : null;
        return {
          name, bytes: probe.bytes, at: probe.at,
          base, confidence: probe.confidence ?? null,
          /* A file in models/loras that is not a LoRA is worth saying out loud
           * rather than listing as one — the three MiniMax turbo files here are
           * genuinely LoRAs, but a checkpoint dropped in the wrong folder is a
           * mistake the shelf can catch. */
          isLora: probe.family === "lora",
          ...(against ? { fits: loraFits(base, against.variant) } : {}),
        };
      }));
      rows.sort((a, b) => (b.at || 0) - (a.at || 0));
      return json(res, 200, {
        loras: rows,
        ...(against ? { against: { name: forName, variant: against.variant, family: against.family } } : {}),
      });
    }

    if (p === "/api/checkpoints" && req.method === "GET") {
      let files = [];
      const dir = path.join(config.modelsDir, "checkpoints");
      try {
        files = (await readdir(dir))
          .filter((f) => /\.(safetensors|ckpt)$/i.test(f) && !/stable_audio/i.test(f));
      } catch { /* dir missing = empty shelf */ }
      /* The shelf says what each file IS, not just that it exists. A filename
       * announces nothing: two files here are Anima and one is a Z-Image DiT,
       * and all three fail to load as checkpoints — which used to surface as a
       * render-time error with no explanation. Reading the safetensors header
       * answers it in single-digit milliseconds without touching the weights.
       * .ckpt is pickle, not safetensors, so it gets the listing without the
       * detection rather than a scary-looking failure. */
      const out = await Promise.all(files.map(async (name) => {
        const full = path.join(dir, name);
        if (!/\.safetensors$/i.test(name)) {
          const st = await stat(full).catch(() => null);
          return { name, bytes: st?.size ?? 0, at: st?.mtimeMs ?? 0, family: null, loadable: true };
        }
        const key = `${name}:${(await stat(full).catch(() => ({}))).mtimeMs ?? 0}`;
        let probe = ckptProbeCache.get(key);
        if (!probe) {
          probe = await probeModel(full);
          ckptProbeCache.set(key, probe);
        }
        const l = loadableAs(probe);
        return {
          name, bytes: probe.bytes, at: probe.at,
          family: probe.family, variant: probe.variant ?? null, detail: probe.detail ?? null,
          dtype: probe.dtype ?? null, params: probe.params ?? null,
          confidence: probe.confidence ?? null,
          loadable: l.ok, why: l.why ?? null,
          /* The author's own claim, kept BESIDE the tensor evidence and never
           * in place of it: one file here says "anima" in its metadata and the
           * other says nothing at all, yet both are Anima by their tensors. */
          author: probe.metadata?.["jdx.merge.architecture"] ?? null,
          /* What this architecture actually wants. Offered so the screen can set
           * sensible numbers when a model is picked, instead of handing an SD1.5
           * checkpoint a 4-step FLUX default and a 1024 canvas. */
          defaults: presetFor(probe),
        };
      }));
      out.sort((a, b) => (b.at || 0) - (a.at || 0));
      return json(res, 200, { checkpoints: out });
    }

    if (p === "/api/images" && req.method !== "POST") {
      let names = [];
      try {
        /* png+svg is what the ENGINE writes, but the export dialog promises
         * "the exported file also lands in the images library" — so the
         * listing admits every export format a browser's <img> can actually
         * show (jpg/webp/avif). tiff/ico/pdf stay off the wall: a broken-image
         * tile is worse than the dialog saying they are download-only. */
        names = (await readdir(IMAGE_DIR)).filter((f) => /\.(png|svg|jpe?g|webp|avif)$/i.test(f) && !f.endsWith("_t.png"));
      } catch { /* none yet */ }
      /* BACK-FILL, once per file ever. A picture from before the checkpoint was
       * recorded still carries ComfyUI's graph in its own bytes, so the honest
       * answer is recoverable rather than lost. `probed` marks the attempt, not
       * the success — without it every listing would re-read every PNG that
       * legitimately has no graph (exports, edits, SVGs) on every paint. */
      let backfilled = false;
      const rows = await Promise.all(names.map(async (name) => {
        const st = await stat(path.join(IMAGE_DIR, name)).catch(() => null);
        let meta = imageMeta.get(name) ?? null;
        if (name.toLowerCase().endsWith(".png") && !meta?.probed && !meta?.engine) {
          const found = modelFromGraph(await pngComfyGraph(path.join(IMAGE_DIR, name)));
          meta = { ...(meta || {}), probed: true, ...(found || {}) };
          imageMeta.set(name, meta);
          backfilled = true;
        }
        return {
          name, bytes: st?.size ?? 0, at: st?.mtimeMs ?? 0,
          meta,
          /* Resolved server-side so the Images screen, the MCP tools and
           * anything else reading this route all get the SAME answer from the
           * one table in models.js. */
          model: meta ? modelLabel(meta) : null,
          modelId: meta?.engine ?? null,
          /* Exposed on the ROW, not read off meta downstream: an inherited
           * model has no meta of its own, and a label that says
           * "dreamshaper_8" beside a null checkpoint is a picture an agent
           * can read about but cannot reproduce. */
          checkpoint: meta?.checkpoint ?? null,
          modelUrl: meta ? modelPageUrl(meta) : null,
        };
      }));
      /* An EDIT inherits what painted its original. New edits already carry it
       * (the edit route spreads the parent's meta forward), but a picture
       * edited before any of this was recorded has a parent that only learned
       * its own model in the back-fill a few lines above — so the chain is
       * walked here rather than left blank. Bounded: a corrupted store must not
       * be able to spin this forever. */
      const byName = new Map(rows.map((r) => [r.name, r]));
      for (const r of rows) {
        if (r.model) continue;
        let cur = r.meta, hops = 0;
        while (cur?.editedFrom && hops++ < 12) {
          const parent = byName.get(cur.editedFrom);
          if (!parent) break;
          if (parent.model) {
            r.model = parent.model; r.modelId = parent.modelId;
            r.modelUrl = parent.modelUrl; r.checkpoint = parent.checkpoint;
            r.inheritedModel = true;
            break;
          }
          cur = parent.meta;
        }
      }
      if (backfilled) saveImageStore();
      rows.sort((a, b) => b.at - a.at);
      return json(res, 200, { images: rows, enabled: true });
    }

    /* The editing engine (server/imagetools.py). One implementation serves the
     * Images screen and the MCP tools: the browser previews with CSS
     * approximations, every COMMITTED edit renders here. Always a NEW file —
     * the original is never touched. */
    /* The effect catalog, for images. Same registry the compositor uses — one
     * source of truth — with the timeline-only ones flagged, because a still
     * has no previous frames and a caller deserves to know that BEFORE asking
     * for an echo rather than after getting an unexplained no-op. */
    if (p === "/api/images/effects" && req.method !== "POST") {
      try {
        const r = await new Promise((resolve, reject) => {
          const prog = [
            "import json,sys,os",
            `d = ${JSON.stringify(path.join(__dirname, "vfx"))}`,
            "sys.path.insert(0, d)",
            "from effects import CATALOG",
            "print(json.dumps(CATALOG))",
          ].join("\n");
          const proc = spawn(config.python, ["-c", prog], { windowsHide: true });
          let so = "", se = "";
          proc.stdout.on("data", (d) => { so += d; });
          proc.stderr.on("data", (d) => { se += d; });
          proc.on("error", reject);
          proc.on("close", (code) => {
            const tail = so.trim().split(/\r?\n/).pop();
            if (code !== 0 || !tail) reject(new Error(se.trim().slice(-300) || `exit ${code}`));
            else { try { resolve(JSON.parse(tail)); } catch (e) { reject(e); } }
          });
        });
        const TIMELINE = ["echo", "timeDifference", "posterizeTime"];
        for (const k of TIMELINE) if (r[k]) r[k].needsTimeline = true;
        return json(res, 200, { effects: r, timelineOnly: TIMELINE });
      } catch (err) {
        return json(res, 503, { error: `The effect catalog is not readable: ${err.message}` });
      }
    }

    /* Every image module's CATALOG, in one call. Enumerated from a table
     * because a route per module is a route to forget: a module that is not on
     * disk yet is reported unavailable rather than taking the others down. */
    if (p === "/api/images/tools" && req.method !== "POST") {
      const MODULES = { selection: "imgselect", strokes: "imgstroke",
                        shapes: "imgshape", text: "imgtext",
                        photo: "imgphoto", export: "imgexport", doc: "imgdoc",
                        // The MCP tool has promised `module=paths` since the
                        // pen landed; this row is what makes that promise true.
                        paths: "imgpath" };
      const prog = [
        "import json,sys,os",
        `sys.path.insert(0, ${JSON.stringify(__dirname)})`,
        `mods = ${JSON.stringify(MODULES)}`,
        "out = {}",
        "for key, mod in mods.items():",
        "    try:",
        "        m = __import__(mod)",
        "        out[key] = getattr(m, 'CATALOG', None) or {}",
        "    except Exception as exc:",
        "        out[key] = {'_unavailable': str(exc)[:200]}",
        "print(json.dumps(out))",
      ].join("\n");
      try {
        const r = await new Promise((resolve, reject) => {
          const proc = spawn(config.python, ["-c", prog], { windowsHide: true });
          let so = "", se = "";
          proc.stdout.on("data", (d) => { so += d; });
          proc.stderr.on("data", (d) => { se += d; });
          proc.on("error", reject);
          proc.on("close", (code) => {
            const tail = so.trim().split(/\r?\n/).pop();
            if (code !== 0 || !tail) reject(new Error(se.trim().slice(-300) || `exit ${code}`));
            else { try { resolve(JSON.parse(tail)); } catch (e) { reject(e); } }
          });
        });
        return json(res, 200, { tools: r });
      } catch (err) {
        return json(res, 503, { error: `The tool catalogs are not readable: ${err.message}` });
      }
    }

    /* Export: a library image out in a chosen format, at a chosen quality,
     * optionally resized and optionally squeezed under a byte target. Always a
     * NEW file — every other image route in here holds that line. */
    /* The photo tools that MEASURE rather than edit: an angle to straighten by,
     * a set of values to set, a colour temperature from a picked pixel. They
     * return numbers, never an image — which is what lets a person see the
     * proposal and argue with it instead of pressing an opaque Enhance. */
    /* What the editor can actually do, so the UI does not have to guess.
     *
     * A capability is live only when BOTH halves hold: the module imports, AND
     * apply_edit reads its ops key. Checking only the first is how a dead
     * button gets enabled — every one of these modules existed and was unwired
     * an hour ago. The ops key is read out of imagetools.py's OWN SOURCE, so
     * this answer cannot drift away from the pipeline it describes. */
    /* The layer document, so the Layers panel can stop being dark: masks, nested groups, adjustment layers, 21 blend
     * modes, non-destructive. GET returns the catalog so a UI can build its
     * panels; POST renders a document to a new image.
     *
     * The document holds library NAMES and never paths — that is what makes it
     * safe to store and hand around, since it cannot name a file outside the
     * library. Resolution happens on this side, which already knows where the
     * library is, and a name that resolves to nothing comes back as a missing
     * SOURCE rather than a failed render: one absent file must not cost the
     * other forty layers. */
    if (p === "/api/images/document") {
      if (req.method !== "POST") {
        try {
          const line = await new Promise((resolve, reject) => {
            const proc = spawn(config.python, [path.join(__dirname, "imgdoc.py"), "catalog"], { windowsHide: true });
            let so = "", se = "";
            proc.stdout.on("data", (d) => { so += d; });
            proc.stderr.on("data", (d) => { se += d; });
            proc.on("error", reject);
            proc.on("close", (code) => engineClose(resolve, reject, so, se, code, 300));
          });
          return json(res, 200, JSON.parse(line));
        } catch (err) {
          return json(res, 503, { error: `The layer document is not readable: ${err.message}` });
        }
      }

      const b = await readBody(req);
      const doc = b.doc;
      if (!doc || typeof doc !== "object" || !Array.isArray(doc.layers)) {
        return json(res, 400, { error: "Give a `doc` with a layers array. GET this route for the catalog." });
      }

      /* Every library name the document mentions, at any depth — groups nest,
       * so this walks rather than scanning the top level.
       *
       * Written against imgdoc.py's SHAPE, not against the layer kinds that
       * happen to use it: `src` sits on image layers, and EVERY layer kind —
       * image, solid, text, adjustment, group, any of them — may carry a
       * mask whose `src` names a library image too (MASK_PARAMS is common to
       * all). A mask src this walk missed used to render the layer UNMASKED,
       * with a warning blaming a missing file that was sitting in the
       * library the whole time. */
      const sources = {};
      const missing = [];
      const stage = async (src) => {
        if (!src || typeof src !== "string") return;
        const nm = path.basename(src);
        if (nm in sources || missing.includes(nm)) return;
        const full = path.join(IMAGE_DIR, nm);
        // forward slashes: this path is read back by python
        try { await stat(full); sources[nm] = full.replace(/\\/g, "/"); }
        catch { missing.push(nm); }
      };
      const walk = async (layers) => {
        for (const l of layers || []) {
          if (!l || typeof l !== "object") continue;
          await stage(l.src);
          if (l.mask && typeof l.mask === "object") await stage(l.mask.src);
          if (Array.isArray(l.layers)) await walk(l.layers);
        }
      };
      await walk(doc.layers);

      const outName = `doc_${Date.now().toString(36)}.png`;
      const jobPath = path.join(IMAGE_DIR, `.doc_${Date.now().toString(36)}.json`);
      await writeFile(jobPath, JSON.stringify({
        doc, sources,
        out: path.join(IMAGE_DIR, outName),
        thumbOut: path.join(IMAGE_DIR, `${outName.replace(/\.png$/, "")}_t.png`),
        thumbSize: config.art.thumbSize,
        scale: Number(b.scale) > 0 ? Number(b.scale) : 1,
      }));
      try {
        const line = await new Promise((resolve, reject) => {
          const proc = spawn(config.python, [path.join(__dirname, "imgdoc.py"), "render", jobPath], { windowsHide: true });
          let so = "", se = "";
          proc.stdout.on("data", (d) => { so += d; });
          proc.stderr.on("data", (d) => { se += d; });
          proc.on("error", reject);
          proc.on("close", (code) => engineClose(resolve, reject, so, se, code));
        });
        const r = JSON.parse(line);
        if (r.ok === false) throw new Error(r.error || "the document did not render");
        /* The layered-document render seam. One `edit` event carrying the
         * layer-kind census (the document is the record of compositional
         * structure), plus an `author_layer` event when a HUMAN put text,
         * shape or paint layers in — those are human-authored contributions
         * (D1.3); an agent's layers are logged under the agent. */
        {
          const actor = prov.actorFrom(req);
          const kinds = {};
          const census = (layers) => {
            for (const l of layers || []) {
              if (!l || typeof l !== "object") continue;
              const k = l.type || "image";       // imgdoc.py stores kind as `type`
              kinds[k] = (kinds[k] || 0) + 1;
              if (Array.isArray(l.layers)) census(l.layers);
            }
          };
          census(doc.layers);
          provNote("library", {
            actor, type: "edit", asset: `images/${outName}`,
            data: { op: "document", layers: kinds, painted: r.painted ?? null },
          });
          // Typed text layers are authored expression (imgdoc has no paint/
          // shape layer kind — vectors ride the ops pipeline, logged there).
          if (kinds.text > 0) {
            provNote("library", {
              actor, type: "author_layer", asset: `images/${outName}`,
              data: { kind: "text", count: kinds.text },
            });
          }
        }
        return json(res, 200, {
          ok: true, name: outName, width: r.width, height: r.height,
          painted: r.painted,
          // Both lists reach the caller. A layer the renderer skipped is the
          // thing a person most needs told about, and it has never been an error.
          missingSources: missing.length ? missing : undefined,
          missing: r.missing?.length ? r.missing : undefined,
          warnings: r.warnings?.length ? r.warnings : undefined,
        });
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) });
      } finally {
        unlink(jobPath).catch(() => {});
      }
    }

    if (p === "/api/images/capabilities" && req.method !== "POST") {
      const CAPS = {
        selection: { mod: "imgselect", ops: ["selection"] },
        strokes:   { mod: "imgstroke", ops: ["strokes"] },
        shapes:    { mod: "imgshape",  ops: ["shapes"] },
        geometry:  { mod: "imgshape",  ops: ["canvas", "geometry"] },
        photo:     { mod: "imgphoto",  ops: ["photo"] },
        paths:     { mod: "imgpath",   ops: ["paths"] },
        liquify:   { mod: "imgpath",   ops: ["liquify"] },
        text:      { mod: "imgtext",   ops: ["text"] },
        // No pipeline stage of their own, so they are backed by a ROUTE and
        // that is what gets checked. imgdoc imports perfectly and has no route
        // yet; reporting it live would enable a Layers menu calling nothing.
        layerdoc:  { mod: "imgdoc",    ops: [], route: "/api/images/document" },
        export:    { mod: "imgexport", ops: [], route: "/api/images/export" },
      };
      const prog = [
        "import json,sys,os,re",
        `sys.path.insert(0, ${JSON.stringify(__dirname)})`,
        `caps = json.loads(${JSON.stringify(JSON.stringify(CAPS))})`,
        `src = open(${JSON.stringify(path.join(__dirname, "imagetools.py"))}, encoding="utf-8", errors="replace").read()`,
        `idx = open(${JSON.stringify(path.join(__dirname, "index.js"))}, encoding="utf-8", errors="replace").read()`,
        // The quote goes in via chr(34) so this JS string literal does not
        // have to carry it — escaping through three layers is how it broke.
        "Q = chr(34)",
        "read = set(re.findall(r'ops\\.get\\(' + Q + '([a-zA-Z]+)' + Q, src))",
        "out = {}",
        "why = {}",
        "for key, spec in caps.items():",
        "    try:",
        "        __import__(spec['mod'])",
        "        importable = True",
        "        note = ''",
        "    except Exception as exc:",
        "        importable = False",
        "        note = str(exc)[:160]",
        "    if spec['ops']:",
        "        wired = all(o in read for o in spec['ops'])",
        "    elif spec.get('route'):",
        // Look for a HANDLER, not the string: the capability table above names
        // the route, in this same file, so a bare substring search finds its
        // own declaration and every route reports itself present.
        "        wired = ('p === ' + Q + spec['route'] + Q) in idx",
        "    else:",
        "        wired = importable",
        "    out[key] = bool(importable and wired)",
        "    if not out[key]:",
        "        if note:",
        "            why[key] = note",
        "        elif spec['ops']:",
        "            why[key] = ('%s.py imports but apply_edit never reads %s'",
        "                        % (spec['mod'], ', '.join(o for o in spec['ops'] if o not in read)))",
        "        else:",
        "            why[key] = ('%s.py imports but %s has no handler'",
        "                        % (spec['mod'], spec.get('route') or 'it'))",
        "print(json.dumps({'capabilities': out, 'why': why}))",
      ].join("\n");
      try {
        const line = await new Promise((resolve, reject) => {
          const proc = spawn(config.python, ["-c", prog], { windowsHide: true });
          let so = "", se = "";
          proc.stdout.on("data", (d) => { so += d; });
          proc.stderr.on("data", (d) => { se += d; });
          proc.on("error", reject);
          proc.on("close", (code) => engineClose(resolve, reject, so, se, code, 300));
        });
        return json(res, 200, JSON.parse(line));
      } catch (err) {
        return json(res, 503, { error: `Could not read the capabilities: ${err.message}` });
      }
    }

    if (p === "/api/images/measure" && req.method === "POST") {
      const b = await readBody(req);
      const name = path.basename(String(b.name || ""));
      if (!/\.(png|jpg|jpeg|webp)$/i.test(name)) return json(res, 400, { error: "bad name" });
      const src = path.join(IMAGE_DIR, name);
      try { await stat(src); } catch { return json(res, 404, { error: "no such image" }); }

      const prog = [
        "import json,sys",
        `sys.path.insert(0, ${JSON.stringify(__dirname)})`,
        "import numpy as np",
        "from PIL import Image",
        "import imgphoto",
        `im = Image.open(${JSON.stringify(src)}).convert("RGBA")`,
        "rgba = np.asarray(im).astype(np.float32) / 255.0",
        `spec = json.loads(${JSON.stringify(JSON.stringify({ tool: String(b.tool || ""), params: b.params || {} }))})`,
        "name = spec['tool']",
        "if name not in imgphoto.CATALOG:",
        "    print(json.dumps({'ok': False, 'error': 'No photo tool called \\\"%s\\\". There are %d: %s.' % (name, len(imgphoto.CATALOG), ', '.join(sorted(imgphoto.CATALOG)))}))",
        "    sys.exit(1)",
        "out = imgphoto.analyze(name, rgba, spec.get('params') or {})",
        "print(json.dumps({'ok': True, 'tool': name, 'result': out}, default=float))",
      ].join("\n");

      try {
        const line = await new Promise((resolve, reject) => {
          const proc = spawn(config.python, ["-c", prog], { windowsHide: true });
          let so = "", se = "";
          proc.stdout.on("data", (d) => { so += d; });
          proc.stderr.on("data", (d) => { se += d; });
          proc.on("error", reject);
          proc.on("close", () => {
            const tail = so.trim().split(/\r?\n/).pop();
            if (!tail) reject(new Error(se.trim().slice(-300) || "no answer"));
            else resolve(tail);
          });
        });
        const r = JSON.parse(line);
        if (r.ok === false) return json(res, 400, { error: r.error });
        return json(res, 200, r);
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) });
      }
    }

    if (p === "/api/images/export" && req.method === "POST") {
      const b = await readBody(req);
      const name = path.basename(String(b.name || ""));
      if (!/\.(png|jpg|jpeg|webp)$/i.test(name)) return json(res, 400, { error: "bad name" });
      const src = path.join(IMAGE_DIR, name);
      try { await stat(src); } catch { return json(res, 404, { error: "no such image" }); }

      const opts = (b.opts && typeof b.opts === "object") ? b.opts : {};
      const FORMATS = { png: "png", jpeg: "jpg", jpg: "jpg", webp: "webp",
                        avif: "avif", tiff: "tif", ico: "ico", pdf: "pdf" };
      const fmt = String(opts.format || "png").toLowerCase();
      if (!FORMATS[fmt]) {
        return json(res, 400, { error: `Format "${opts.format}" is not one of: ${Object.keys(FORMATS).join(", ")}.` });
      }
      const stem = name.replace(/\.[^.]+$/, "");
      const outName = `${stem}_x${Date.now().toString(36)}.${FORMATS[fmt]}`;
      const jobPath = path.join(IMAGE_DIR, `.export_${Date.now().toString(36)}.json`);
      /* The CLI reads `export` (or `ops`), not `opts`, and byte targeting is a
       * separate mode rather than another key — it searches quality, so it
       * cannot be one encode. */
      const wantsTarget = Number.isFinite(Number(opts.maxBytes)) && Number(opts.maxBytes) > 0;
      /* `maxBytes`/`allowMiss` are TOP-LEVEL job keys for the "target" mode,
       * not export options — imgexport.resolve() validates the export opts
       * against its catalog and refuses unknown keys by name, so leaving them
       * inside `export:` failed EVERY export that asked for a byte budget
       * ("unknown option(s) ['maxBytes']"). Pop them before the job is written. */
      const exportOpts = { ...opts };
      delete exportOpts.maxBytes;
      delete exportOpts.allowMiss;
      /* The embed layer (SPEC D3): imgexport writes the provenance XMP into
       * PNG/JPEG and a `.provenance.json` sidecar beside anything else. The
       * marker half of the payload is not optional; the record half already
       * honours the user's embed toggle (built above the write, not in
       * python, so the toggle has exactly one reader). */
      const { payload: provPayload } = await imageProvenancePayload(name);
      await writeFile(jobPath, JSON.stringify({
        in: src, out: path.join(IMAGE_DIR, outName), export: exportOpts,
        maxBytes: wantsTarget ? Number(opts.maxBytes) : undefined,
        allowMiss: !!opts.allowMiss,
        provenance: provPayload,
      }));
      try {
        const line = await new Promise((resolve, reject) => {
          const proc = spawn(config.python, [path.join(__dirname, "imgexport.py"),
                                             wantsTarget ? "target" : "export", jobPath], { windowsHide: true });
          let so = "", se = "";
          proc.stdout.on("data", (d) => { so += d; });
          proc.stderr.on("data", (d) => { se += d; });
          proc.on("error", reject);
          proc.on("close", (code) => engineClose(resolve, reject, so, se, code));
        });
        let r; try { r = JSON.parse(line); } catch { throw new Error(`imgexport did not answer with JSON: ${line.slice(0, 200)}`); }
        if (r.ok === false) throw new Error(r.error || "export failed");
        await library.rescan?.().catch?.(() => {});
        // The export seals the origin map into the artifact — and the reply
        // says WHICH of embed/sidecar happened, never claiming one for the
        // other (D3.3).
        provNote("library", {
          actor: prov.actorFrom(req), type: "export", asset: `images/${name}`,
          data: { format: fmt, out: `images/${outName}`,
                  embedded: r.provenance || null, bytes: r.bytes ?? null },
        });
        return json(res, 200, { ok: true, name: outName, bytes: r.bytes, format: fmt,
                                width: r.width, height: r.height,
                                quality: r.quality, ignored: r.ignored,
                                provenance: r.provenance ?? null });
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) });
      } finally {
        unlink(jobPath).catch(() => {});
      }
    }

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
        /* The capture seam for image edits (SPEC D1.2 `edit`): one event per
         * committed apply, op names + a params hash rather than the params
         * themselves. When the ACTUAL editor was a person this is what later
         * promotes an AI image to ai-assisted-human-edited; an agent's edit
         * stays an agent's edit. */
        provNote("library", {
          actor: prov.actorFrom(req), type: "edit", asset: `images/${outName}`,
          data: {
            ops: Object.keys(b.ops || {}),
            paramsHash: `sha256:${prov.sha256hex(JSON.stringify(b.ops || {}))}`,
            derivedFrom: `images/${name}`,
          },
        });
        // The engine's honesty channels ride along: `notes` is a compromise a
        // stage reported (smartResize past maxCarve becoming a plain resize),
        // `fxSkipped` the timeline effects that did nothing on a still. The
        // route knowing and not saying is the silence IMAGE_SPEC is written
        // against.
        return json(res, 200, { ok: true, name: outName,
          notes: r.notes?.length ? r.notes : undefined,
          fxSkipped: r.fxSkipped?.length ? r.fxSkipped : undefined });
      } catch (err) {
        return json(res, 400, { error: `edit failed: ${err.message}` });
      } finally {
        unlink(jobPath).catch(() => {});
      }
    }

    /* One-shot engine graphs for the image tools: background cutout
     * (BiRefNet, MIT) and RealESRGAN upscaling. Both are seconds of GPU, but
     * the GPU is still the music engine's — they wait for an idle moment
     * rather than shoving into a render. */
    /**
     * @returns {Promise<{file: string, runId: string}>} the written file's
     *   absolute path, and the run that made it — so the `edit` event these
     *   tools already append can point at the full technical record.
     */
    async function runImageGraph(graph, saveNode, timeoutMs = 120_000, { actor = "system" } = {}) {
      const idleBy = Date.now() + 60_000;
      while (!art.idle && Date.now() < idleBy) await new Promise((s) => setTimeout(s, 1000));
      /* `adopt: false` on purpose, and it is not a shortcut: the output of a
       * cutout or an upscale is a TEMPORARY file that adoptEngineImage renames
       * into the image library under a name derived from the source. Filing it
       * twice would put a `imgtools/cutout_00001.png` row in the library beside
       * the real one. Fully recorded either way — that is the point of the
       * door — just not filed by it. */
      const done = await engineDoor.run({
        graph, actor, via: "imagetools", adopt: false,
        timeoutMs, pollMs: 700, label: `imagetools node ${saveNode}`,
      });
      if (done.status !== "completed") {
        throw new Error(done.error || `the engine did not finish (${done.status})`);
      }
      const img = done.outputs.find((o) => o.node === String(saveNode));
      if (!img) throw new Error("engine returned no image");
      return {
        file: path.join(config.outputDir, img.subfolder || "", img.file),
        runId: done.runId,
      };
    }

    /* Content-addressed, so re-cutting the same image reuses one staged copy
     * instead of minting a new one per call — and the caller unlinks it in a
     * finally. The old Date.now() salt meant every cutout/upscale left a
     * full-size duplicate in ComfyUI/input forever (art.js's enhance/restyle
     * staging always cleaned up; this one was the odd one out). */
    async function stageImageForEngine(name) {
      const src = path.join(IMAGE_DIR, name);
      const bytes = await readFile(src);
      const staged = `aiplay_edit_${createHash("sha1").update(bytes).digest("hex").slice(0, 12)}${path.extname(name)}`;
      await mkdir(config.inputDir, { recursive: true });
      await writeFile(path.join(config.inputDir, staged), bytes);
      return staged;
    }
    const unstage = (staged) =>
      staged ? unlink(path.join(config.inputDir, staged)).catch(() => {}) : null;

    async function adoptEngineImage(tmpPath, outName, parentName, extraMeta) {
      const dest = path.join(IMAGE_DIR, outName);
      await rename(tmpPath, dest);
      // thumbnail through the same tool that edits use
      const jobPath = path.join(IMAGE_DIR, `.th_${Date.now().toString(36)}.json`);
      await writeFile(jobPath, JSON.stringify({
        in: dest, out: dest, thumbOut: path.join(IMAGE_DIR, `${outName.replace(/\.png$/i, "")}_t.png`),
        thumbSize: config.art.thumbSize, ops: {},
      }));
      await new Promise((resolve) => {
        const proc = spawn(config.python, [path.join(__dirname, "imagetools.py"), "edit", jobPath], { windowsHide: true });
        proc.on("close", resolve);
      });
      unlink(jobPath).catch(() => {});
      const parent = imageMeta.get(parentName) || {};
      imageMeta.set(outName, { ...parent, ...extraMeta, at: Date.now(), durationMs: null });
      saveImageStore();
    }

    /* Background cutout — BiRefNet (MIT), the model ComfyUI's own core node
     * family is built around. Result is a transparent PNG in the library. */
    /* Gallery privacy blur — a per-image flag the tiles respect. The pixels
     * are untouched; this is presentation, reversible with one click. */
    if (p === "/api/images/flag" && req.method === "POST") {
      const b = await readBody(req);
      const name = path.basename(String(b.name || ""));
      const meta = imageMeta.get(name);
      if (!meta && !(await stat(path.join(IMAGE_DIR, name)).catch(() => null))) {
        return json(res, 404, { error: "no such image" });
      }
      imageMeta.set(name, { ...(meta || {}), blur: !!b.blur });
      saveImageStore();
      return json(res, 200, { ok: true, name, blur: !!b.blur });
    }

    /* The type tool's font shelf: TTFs from the system font folder. Listed,
     * not curated — same philosophy as checkpoints. */
    if (p === "/api/fonts" && req.method === "GET") {
      let fonts = [];
      try {
        fonts = (await readdir("C:/Windows/Fonts"))
          .filter((f) => /\.(ttf|otf)$/i.test(f) && !/^(marlett|symbol|wingding|webdings|holomdl)/i.test(f))
          .sort();
      } catch { /* empty shelf */ }
      return json(res, 200, { fonts });
    }

    if (p === "/api/images/cutout" && req.method === "POST") {
      const b = await readBody(req);
      const name = path.basename(String(b.name || ""));
      if (!/\.(png|jpg|jpeg|webp)$/i.test(name)) return json(res, 400, { error: "bad name" });
      try { await stat(path.join(config.modelsDir, "background_removal", "birefnet.safetensors")); }
      catch { return json(res, 400, { error: "BiRefNet is not downloaded (models/background_removal/birefnet.safetensors — 444 MB, MIT licence)." }); }
      let staged;
      try {
        staged = await stageImageForEngine(name);
        const graph = {
          1: { class_type: "LoadImage", inputs: { image: staged } },
          2: { class_type: "LoadBackgroundRemovalModel", inputs: { bg_removal_name: "birefnet.safetensors" } },
          3: { class_type: "RemoveBackground", inputs: { bg_removal_model: ["2", 0], image: ["1", 0] } },
          4: { class_type: "InvertMask", inputs: { mask: ["3", 0] } },
          5: { class_type: "JoinImageWithAlpha", inputs: { image: ["1", 0], alpha: ["4", 0] } },
          6: { class_type: "SaveImage", inputs: { images: ["5", 0], filename_prefix: "imgtools/cutout" } },
        };
        const actor = prov.actorFrom(req);
        const { file: tmp, runId } = await runImageGraph(graph, "6", 120_000, { actor });
        const outName = `${name.replace(/\.[^.]+$/, "")}_cut.png`;
        await adoptEngineImage(tmp, outName, name, { cutoutFrom: name });
        provNote("library", {
          actor, type: "edit", asset: `images/${outName}`,
          /* `runId` leads to engine/<runId>, which holds the graph, the model
           * files and the output digest for this exact cutout. */
          data: { op: "cutout", model: "BiRefNet", derivedFrom: `images/${name}`, runId },
        });
        return json(res, 200, { ok: true, name: outName });
      } catch (err) {
        return json(res, 400, { error: `cutout failed: ${err.message}` });
      } finally {
        await unstage(staged);
      }
    }

    /* Upscale ×2 — RealESRGAN (BSD-3), already on disk. */
    if (p === "/api/images/upscale" && req.method === "POST") {
      const b = await readBody(req);
      const name = path.basename(String(b.name || ""));
      if (!/\.(png|jpg|jpeg|webp)$/i.test(name)) return json(res, 400, { error: "bad name" });
      let staged;
      try {
        staged = await stageImageForEngine(name);
        const graph = {
          1: { class_type: "LoadImage", inputs: { image: staged } },
          2: { class_type: "UpscaleModelLoader", inputs: { model_name: "RealESRGAN_x2.pth" } },
          3: { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["2", 0], image: ["1", 0] } },
          4: { class_type: "SaveImage", inputs: { images: ["3", 0], filename_prefix: "imgtools/up" } },
        };
        const actor = prov.actorFrom(req);
        const { file: tmp, runId } = await runImageGraph(graph, "4", 240_000, { actor });
        const outName = `${name.replace(/\.[^.]+$/, "")}_x2.png`;
        await adoptEngineImage(tmp, outName, name, { upscaledFrom: name });
        provNote("library", {
          actor, type: "edit", asset: `images/${outName}`,
          data: { op: "upscale", model: "RealESRGAN_x2", derivedFrom: `images/${name}`, runId },
        });
        return json(res, 200, { ok: true, name: outName });
      } catch (err) {
        return json(res, 400, { error: `upscale failed: ${err.message}` });
      } finally {
        await unstage(staged);
      }
    }

    /* Compositing: layers onto a base, Photoshop blend maths. Every path is a
     * library name — the engine never takes a path from the client. */
    if (p === "/api/images/composite" && req.method === "POST") {
      const b = await readBody(req);
      const nameOf = (v) => path.basename(String(v || ""));
      const base = nameOf(b.base);
      if (!/\.(png|jpg|jpeg|webp)$/i.test(base)) return json(res, 400, { error: "bad base name" });
      const layers = [];
      for (const l of (Array.isArray(b.layers) ? b.layers : []).slice(0, 12)) {
        const src = nameOf(l.src);
        if (!/\.(png|jpg|jpeg|webp)$/i.test(src)) continue;
        try { await stat(path.join(IMAGE_DIR, src)); } catch { continue; }
        layers.push({
          src: path.join(IMAGE_DIR, src),
          x: Number(l.x) || 0, y: Number(l.y) || 0,
          scale: Math.min(8, Math.max(0.02, Number(l.scale) || 1)),
          opacity: Math.min(1, Math.max(0, l.opacity == null ? 1 : Number(l.opacity))),
          mode: String(l.mode || "normal"),
          rotate: Number(l.rotate) || 0,
          flipH: !!l.flipH, flipV: !!l.flipV,
          anchor: l.anchor === "center" ? "center" : "topleft",
          effects: (l.effects && typeof l.effects === "object") ? l.effects : undefined,
          clipped: !!l.clipped,
        });
      }
      if (!layers.length) return json(res, 400, { error: "no usable layers" });
      try { await stat(path.join(IMAGE_DIR, base)); } catch { return json(res, 404, { error: "no such base image" }); }

      /* ── clipping masks ride the LAYER DOCUMENT ──────────────────────────
       * `clipped: true` on a layer is Photoshop's clipping mask: the layer
       * keeps the alpha of the nearest non-clipped layer beneath it — the
       * base image counts — as its matte. server/imgdoc.py owns those
       * semantics, and there must be exactly ONE implementation of them, so a
       * composite carrying the flag is translated into a layer document and
       * rendered there instead of imagetools.composite. Two honest
       * differences: flipH/flipV would land a half-pixel off through the
       * document's transform, so they are REFUSED with the workaround named
       * rather than approximated; and rotation pivots about the anchor
       * (Photoshop's semantics) instead of re-placing the expanded box. */
      if (layers.some((l) => l.clipped)) {
        if (layers.some((l) => l.flipH || l.flipV)) {
          return json(res, 400, { error: "flipH/flipV cannot ride a clipped composite — flip the source image first (image_adjust geometry.flipH/flipV), or drop the clip" });
        }
        const canvas = b.canvas || {};
        const cw = Math.round(Number(canvas.w) || 0), ch = Math.round(Number(canvas.h) || 0);
        const styleOf = (fx) => {
          if (!fx || typeof fx !== "object") return undefined;
          const styles = {};
          if (fx.shadow && typeof fx.shadow === "object") {
            // dropShadow speaks angle+distance; the flat effect speaks dx/dy.
            const dx = fx.shadow.dx == null ? 6 : Number(fx.shadow.dx) || 0;
            const dy = fx.shadow.dy == null ? 6 : Number(fx.shadow.dy) || 0;
            styles.dropShadow = {
              color: Array.isArray(fx.shadow.color) ? fx.shadow.color : [0, 0, 0],
              opacity: 100 * (fx.shadow.opacity == null ? 0.55 : Number(fx.shadow.opacity) || 0),
              distance: Math.hypot(dx, dy), angle: (Math.atan2(dy, dx) * 180) / Math.PI,
              size: fx.shadow.blur == null ? 8 : Number(fx.shadow.blur) || 0,
            };
          }
          if (fx.glow && typeof fx.glow === "object") {
            styles.outerGlow = {
              color: Array.isArray(fx.glow.color) ? fx.glow.color : [255, 240, 180],
              opacity: 100 * (fx.glow.opacity == null ? 0.8 : Number(fx.glow.opacity) || 0),
              size: fx.glow.size == null ? 10 : Number(fx.glow.size) || 0,
            };
          }
          if (fx.stroke && typeof fx.stroke === "object") {
            styles.stroke = {
              color: Array.isArray(fx.stroke.color) ? fx.stroke.color : [0, 0, 0],
              size: Math.max(1, fx.stroke.width == null ? 3 : Number(fx.stroke.width) || 0),
              position: "outside",
            };
          }
          return Object.keys(styles).length ? styles : undefined;
        };
        const doc = {
          width: cw > 0 && ch > 0 ? cw : undefined,
          height: cw > 0 && ch > 0 ? ch : undefined,
          bg: Array.isArray(canvas.bg) ? canvas.bg : [0, 0, 0, 0],
          layers: [
            { type: "image", src: base, name: "base",
              transform: { anchor: [0, 0], position: [0, 0] } },
            ...layers.map((l, i) => ({
              type: "image", src: path.basename(l.src), name: `layer ${i + 1}`,
              blend: l.mode, clipped: l.clipped || undefined,
              styles: styleOf(l.effects),
              transform: {
                ...(l.anchor === "center" ? {} : { anchor: [0, 0] }),
                position: [l.x, l.y],
                scale: [l.scale * 100, l.scale * 100],
                rotation: l.rotate || 0,
                opacity: l.opacity * 100,
              },
            })),
          ],
        };
        const sources = { [base]: path.join(IMAGE_DIR, base).replace(/\\/g, "/") };
        for (const l of layers) sources[path.basename(l.src)] = l.src.replace(/\\/g, "/");
        const outName = `${base.replace(/\.[^.]+$/, "")}_c${Date.now().toString(36)}.png`;
        const jobPath = path.join(IMAGE_DIR, `.comp_${Date.now().toString(36)}.json`);
        await writeFile(jobPath, JSON.stringify({
          doc, sources,
          sizeFrom: cw > 0 && ch > 0 ? undefined : base,
          out: path.join(IMAGE_DIR, outName),
          thumbOut: path.join(IMAGE_DIR, `${outName.replace(/\.png$/, "")}_t.png`),
          thumbSize: config.art.thumbSize,
        }));
        try {
          const line = await new Promise((resolve, reject) => {
            const proc = spawn(config.python, [path.join(__dirname, "imgdoc.py"), "render", jobPath], { windowsHide: true });
            let so = "", se = "";
            proc.stdout.on("data", (d) => { so += d; });
            proc.stderr.on("data", (d) => { se += d; });
            proc.on("error", reject);
            proc.on("close", (code) => engineClose(resolve, reject, so, se, code));
          });
          const r = JSON.parse(line);
          if (r.ok === false) throw new Error(r.error || "the clipped composite did not render");
          imageMeta.set(outName, { ...(imageMeta.get(base) || {}), compositeOf: base,
            layers: layers.length, at: Date.now(), durationMs: null });
          saveImageStore();
          return json(res, 200, { ok: true, name: outName, layers: layers.length,
            clipped: true, warnings: r.warnings?.length ? r.warnings : undefined });
        } catch (err) {
          return json(res, 400, { error: `composite failed: ${err.message}` });
        } finally {
          unlink(jobPath).catch(() => {});
        }
      }

      const outName = `${base.replace(/\.[^.]+$/, "")}_c${Date.now().toString(36)}.png`;
      const jobPath = path.join(IMAGE_DIR, `.comp_${Date.now().toString(36)}.json`);
      await writeFile(jobPath, JSON.stringify({
        base: path.join(IMAGE_DIR, base), out: path.join(IMAGE_DIR, outName),
        thumbOut: path.join(IMAGE_DIR, `${outName.replace(/\.png$/, "")}_t.png`),
        thumbSize: config.art.thumbSize, layers, canvas: b.canvas || null,
      }));
      try {
        const out = await new Promise((resolve, reject) => {
          const proc = spawn(config.python, [path.join(__dirname, "imagetools.py"), "composite", jobPath], { windowsHide: true });
          let so = "", se = "";
          proc.stdout.on("data", (d) => { so += d; });
          proc.stderr.on("data", (d) => { se += d; });
          proc.on("close", (code) => code === 0 ? resolve(so) : reject(new Error(se.slice(-300) || `exit ${code}`)));
        });
        const r = JSON.parse(out.trim().split("\n").pop());
        if (!r.ok) throw new Error(r.error || "composite failed");
        imageMeta.set(outName, { ...(imageMeta.get(base) || {}), compositeOf: base,
          layers: layers.length, at: Date.now(), durationMs: null });
        saveImageStore();
        return json(res, 200, { ok: true, name: outName, layers: r.layers });
      } catch (err) {
        return json(res, 400, { error: `composite failed: ${err.message}` });
      } finally {
        unlink(jobPath).catch(() => {});
      }
    }

    /* Auto-enhance: the analysis PROPOSES ops rather than baking them, so
     * the sliders land where it decided and you can argue with any of it. */
    if (p === "/api/images/analyze" && req.method === "POST") {
      const b = await readBody(req);
      const name = path.basename(String(b.name || ""));
      if (!/\.(png|jpg|jpeg|webp)$/i.test(name)) return json(res, 400, { error: "bad name" });
      const src = path.join(IMAGE_DIR, name);
      try { await stat(src); } catch { return json(res, 404, { error: "no such image" }); }
      const jobPath = path.join(IMAGE_DIR, `.an_${Date.now().toString(36)}.json`);
      await writeFile(jobPath, JSON.stringify({ in: src }));
      try {
        const out = await new Promise((resolve, reject) => {
          const proc = spawn(config.python, [path.join(__dirname, "imagetools.py"), "analyze", jobPath], { windowsHide: true });
          let so = "", se = "";
          proc.stdout.on("data", (d) => { so += d; });
          proc.stderr.on("data", (d) => { se += d; });
          proc.on("close", (code) => code === 0 ? resolve(so) : reject(new Error(se.slice(-300) || `exit ${code}`)));
        });
        const r = JSON.parse(out.trim().split("\n").pop());
        if (!r.ok) throw new Error(r.error || "analyze failed");
        return json(res, 200, { ok: true, ops: r.ops, notes: r.notes, stats: r.stats });
      } catch (err) {
        return json(res, 400, { error: `analyze failed: ${err.message}` });
      } finally {
        unlink(jobPath).catch(() => {});
      }
    }

    /* ── did it come back with what was asked for? ────────────────────────
     *
     * The check this app could not make. Everything above measures pixels —
     * brightness, chroma, clipping — and none of it can count the strings on a
     * guitar or the fingers on a hand, which is where image models actually
     * fail. So the judging is done by whoever has eyes (a person at the screen,
     * or the agent now that MCP hands it the picture), and these routes carry
     * the three things that makes durable: the pixels, the intention, and the
     * verdict.
     *
     * Same shape for both callers, deliberately. A verdict a person gave and a
     * verdict an agent gave differ only in the `by` field, and both land in the
     * ledger as a judge event. */
    if (p === "/api/images/review" && req.method === "POST") {
      const b = await readBody(req);
      const name = path.basename(String(b.name || ""));
      if (!/\.(png|jpg|jpeg|webp)$/i.test(name)) return json(res, 400, { error: "bad name" });
      const src = path.join(IMAGE_DIR, name);
      let st;
      try { st = await stat(src); } catch { return json(res, 404, { error: "no such image" }); }
      const entry = await reviews.get(name);
      const meta = imageMeta.get(name) || {};
      const current = { size: st.size, mtime: Math.round(st.mtimeMs) };
      let image = null, imageError = null;
      /* A thumbnail that cannot be made must not hide the rest: the checklist
       * and the verdict are still worth returning, and the caller is told
       * plainly why there is no picture attached. */
      try {
        image = await imageThumb(src, b.max_edge);
      } catch (err) { imageError = err.message; }
      return json(res, 200, {
        ok: true,
        name,
        prompt: meta.prompt || "",
        engine: meta.engine || "",
        seed: meta.seed ?? null,
        expect: entry?.expect || [],
        /* The obvious checks, read off the prompt. Offered rather than applied:
         * a suggestion that cannot be deleted is a rule pretending to be help,
         * and this one is a keyword match that will sometimes be wrong. */
        suggested: suggestExpect(meta.prompt || ""),
        verdict: entry?.verdict || null,
        state: reviewState(entry, current),
        image,
        imageError,
      });
    }

    /* The checklist, after the fact. Usually written at render time by
     * make_image's `expect`, but a picture is often only questioned once it is
     * on screen — which is exactly when the expectation becomes articulable. */
    if (p === "/api/images/expect" && req.method === "POST") {
      const b = await readBody(req);
      const name = path.basename(String(b.name || ""));
      if (!/\.(png|jpg|jpeg|webp)$/i.test(name)) return json(res, 400, { error: "bad name" });
      const entry = await reviews.expect(name, b.expect);
      return json(res, 200, { ok: true, name, expect: entry.expect, state: reviewState(entry) });
    }

    if (p === "/api/images/verdict" && req.method === "POST") {
      const b = await readBody(req);
      const name = path.basename(String(b.name || ""));
      if (!/\.(png|jpg|jpeg|webp)$/i.test(name)) return json(res, 400, { error: "bad name" });
      const src = path.join(IMAGE_DIR, name);
      try { await stat(src); } catch { return json(res, 404, { error: "no such image" }); }
      const actor = prov.actorFrom(req);
      const entry = await reviews.verdict(name, {
        ok: b.ok, failed: b.failed, notes: b.notes, by: actor, file: src,
      });
      /* In the ledger, because "someone looked and it was wrong" is exactly the
       * kind of claim the ledger exists to make checkable later. */
      provNote("images", {
        actor, type: "judge", asset: name,
        detail: {
          ok: entry.verdict.ok,
          failed: entry.verdict.failed,
          against: entry.verdict.against,
          notes: entry.verdict.notes,
        },
      });
      return json(res, 200, { ok: true, name, verdict: entry.verdict, state: reviewState(entry) });
    }

    /* Everything known, so a screen can show a shelf of unchecked pictures and
     * a report can say how many were ever looked at. */
    if (p === "/api/images/reviews" && req.method === "GET") {
      const all = await reviews.all();
      const out = [];
      const counts = { unchecked: 0, pass: 0, fail: 0, stale: 0 };
      for (const [name, entry] of Object.entries(all)) {
        let current = null;
        try {
          const st = await stat(path.join(IMAGE_DIR, name));
          current = { size: st.size, mtime: Math.round(st.mtimeMs) };
        } catch { /* gone from disk; the verdict is still a record of the past */ }
        const state = reviewState(entry, current);
        counts[state] = (counts[state] || 0) + 1;
        out.push({ name, expect: entry.expect || [], verdict: entry.verdict || null, state, onDisk: Boolean(current) });
      }
      out.sort((a, b) => (b.verdict?.at || 0) - (a.verdict?.at || 0));
      return json(res, 200, { ok: true, reviews: out, counts });
    }

    /* Edit lineage. Every edit writes a NEW file, which is what makes the
     * editor non-destructive — but a chain nobody can see is just clutter.
     * This walks the parent links back to the render the whole branch grew
     * from, so the editor can offer "back to the original". */
    if (p.startsWith("/api/images/lineage/")) {
      const name = path.basename(decodeURIComponent(p.slice("/api/images/lineage/".length)));
      const chain = [];
      let cur = name;
      const seen = new Set();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const m = imageMeta.get(cur) || {};
        const via = m.editedFrom ? "edit" : m.compositeOf ? "composite" : m.cutoutFrom ? "cutout"
          : m.upscaledFrom ? "upscale" : m.vectorFrom ? "vectorize" : m.sheetOf ? "collage" : null;
        chain.push({ name: cur, via, ops: m.ops || null, at: m.at || null,
                     exists: !!(await stat(path.join(IMAGE_DIR, cur)).catch(() => null)) });
        cur = m.editedFrom || m.compositeOf || m.cutoutFrom || m.upscaledFrom || m.vectorFrom || null;
      }
      return json(res, 200, { chain });
    }

    /* Contact sheet: the collage a gallery implies. Names from the library
     * only — the engine never takes a path from the client. */
    if (p === "/api/images/sheet" && req.method === "POST") {
      const b = await readBody(req);
      const names = [];
      for (const v of (Array.isArray(b.names) ? b.names : []).slice(0, 64)) {
        const n = path.basename(String(v || ""));
        if (!/\.(png|jpg|jpeg|webp)$/i.test(n)) continue;
        try { await stat(path.join(IMAGE_DIR, n)); names.push(n); } catch { /* skip */ }
      }
      if (names.length < 2) return json(res, 400, { error: "give at least two library images" });
      const outName = `sheet_${Date.now().toString(36)}.png`;
      const jobPath = path.join(IMAGE_DIR, `.sheet_${Date.now().toString(36)}.json`);
      await writeFile(jobPath, JSON.stringify({
        images: names.map((n) => path.join(IMAGE_DIR, n)),
        out: path.join(IMAGE_DIR, outName),
        thumbOut: path.join(IMAGE_DIR, `${outName.replace(/\.png$/, "")}_t.png`),
        thumbSize: config.art.thumbSize,
        cols: Number(b.cols) || 0, cell: Number(b.cell) || 512, gap: Number(b.gap) || 8,
        fit: b.fit === "contain" ? "contain" : "cover",
        bg: Array.isArray(b.bg) ? b.bg : null,
        labels: b.labels === true
          ? names.map((n) => (imageMeta.get(n)?.prompt || n).slice(0, 60))
          : (Array.isArray(b.labels) ? b.labels : null),
      }));
      try {
        const out = await new Promise((resolve, reject) => {
          const proc = spawn(config.python, [path.join(__dirname, "imagetools.py"), "sheet", jobPath], { windowsHide: true });
          let so = "", se = "";
          proc.stdout.on("data", (d) => { so += d; });
          proc.stderr.on("data", (d) => { se += d; });
          proc.on("close", (code) => code === 0 ? resolve(so) : reject(new Error(se.slice(-300) || `exit ${code}`)));
        });
        const r = JSON.parse(out.trim().split("\n").pop());
        if (!r.ok) throw new Error(r.error || "sheet failed");
        imageMeta.set(outName, { prompt: `contact sheet of ${names.length} images`,
          sheetOf: names, at: Date.now(), durationMs: null });
        saveImageStore();
        return json(res, 200, { ok: true, name: outName, tiles: r.tiles, cols: r.cols, rows: r.rows });
      } catch (err) {
        return json(res, 400, { error: `sheet failed: ${err.message}` });
      } finally {
        unlink(jobPath).catch(() => {});
      }
    }

    /* Edit presets: a named ops recipe, saved beside the images. The point is
     * batch — one look applied to a whole shoot, by hand or by an agent. */
    if (p === "/api/images/presets" && req.method === "GET") {
      let presets = {};
      try { presets = JSON.parse(await readFile(path.join(IMAGE_DIR, "_presets.json"), "utf-8")); } catch { /* none */ }
      return json(res, 200, { presets });
    }
    if (p === "/api/images/presets" && req.method === "POST") {
      const b = await readBody(req);
      const name = String(b.name || "").trim().slice(0, 60);
      if (!name) return json(res, 400, { error: "name it" });
      let presets = {};
      try { presets = JSON.parse(await readFile(path.join(IMAGE_DIR, "_presets.json"), "utf-8")); } catch { /* first */ }
      if (b.remove) delete presets[name];
      else presets[name] = b.ops || {};
      await mkdir(IMAGE_DIR, { recursive: true });
      await writeFile(path.join(IMAGE_DIR, "_presets.json"), JSON.stringify(presets, null, 1));
      return json(res, 200, { ok: true, presets });
    }

    /* Swatches — the editor's named colours. APP-LEVEL persistence, decided:
     * this editor has no saved document format for a palette to travel with
     * (every Apply bakes to a new PNG and the ops queue is per-session), so
     * "document-level" would be a file that does not exist. A palette is a
     * workspace preference exactly like a preset, so it lives where presets
     * live — a JSON file beside the images, server-side rather than in
     * localStorage, which is what lets MCP and the UI see the SAME palette.
     * Colours are 0-255 RGB, §9's rule, validated here so a 0..1 triple is
     * refused at the door instead of stored as near-black. */
    if (p === "/api/images/swatches" && req.method === "GET") {
      let swatches = [];
      try { swatches = JSON.parse(await readFile(path.join(IMAGE_DIR, "_swatches.json"), "utf-8")); } catch { /* none yet */ }
      return json(res, 200, { swatches });
    }
    if (p === "/api/images/swatches" && req.method === "POST") {
      const b = await readBody(req);
      let swatches = [];
      try { swatches = JSON.parse(await readFile(path.join(IMAGE_DIR, "_swatches.json"), "utf-8")); } catch { /* first */ }
      if (b.remove != null) {
        const i = Number(b.remove);
        if (!Number.isInteger(i) || i < 0 || i >= swatches.length) {
          return json(res, 400, { error: `no swatch ${b.remove} — there are ${swatches.length}` });
        }
        swatches.splice(i, 1);
      } else {
        const c = Array.isArray(b.color) ? b.color.slice(0, 3).map(Number) : null;
        if (!c || c.length !== 3 || c.some((v) => !Number.isFinite(v) || v < 0 || v > 255)) {
          return json(res, 400, { error: "color must be [r, g, b], each 0-255" });
        }
        // A 0..1 triple is a LEGAL near-black, which is exactly why it is
        // refused: nobody saving a swatch means rgb(1,1,1).
        if (c.every((v) => v <= 1) && c.some((v) => v > 0 && !Number.isInteger(v))) {
          return json(res, 400, { error: "that looks like a 0..1 colour — swatches are 0-255" });
        }
        if (swatches.length >= 200) return json(res, 400, { error: "200 swatches is the shelf; remove one first" });
        swatches.push({ color: c.map((v) => Math.round(v)),
                        ...(b.name ? { name: String(b.name).slice(0, 40) } : {}) });
      }
      await mkdir(IMAGE_DIR, { recursive: true });
      await writeFile(path.join(IMAGE_DIR, "_swatches.json"), JSON.stringify(swatches, null, 1));
      return json(res, 200, { ok: true, swatches });
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
      /* Everything the library can actually HOLD, not just what the engine
       * renders: vectorize writes .svg and export writes six more formats —
       * all of them are offered a trash button in the UI, and a `.png$` guard
       * here answered every one of them "bad name". Same set /api/image/
       * serves; path.basename above is what keeps this inside the folder. */
      if (!name || !/\.(png|jpg|jpeg|webp|svg|avif|tif|tiff|ico|pdf)$/i.test(name)) {
        return json(res, 400, { error: "bad name" });
      }
      const dir = path.join(config.outputDir, "trash");
      try {
        await mkdir(dir, { recursive: true });
        await rename(path.join(IMAGE_DIR, name), path.join(dir, name));
        // The thumbnail travels with it, or the trash fills with orphans.
        await rename(path.join(IMAGE_DIR, name.replace(/\.[^.]+$/, "_t.png")),
                     path.join(dir, name.replace(/\.[^.]+$/, "_t.png"))).catch(() => {});
      } catch (err) {
        return json(res, 400, { error: `Could not move it: ${err.message}` });
      }
      imageMeta.delete(name);
      saveImageStore();
      return json(res, 200, { ok: true });
    }

    if (p.startsWith("/api/image/")) {
      const name = path.basename(decodeURIComponent(p.slice("/api/image/".length)));
      /* Every format /api/images/export can WRITE must be servable here, or
       * the export dialog hands back a file nobody can download. */
      if (!/\.(png|jpg|jpeg|webp|svg|avif|tif|tiff|ico|pdf)$/i.test(name)) return json(res, 400, { error: "bad name" });
      try {
        const buf = await readFile(path.join(IMAGE_DIR, name));
        /* From the EXTENSION. It was hardcoded to image/png while the check
         * above accepts three other types — the same mistake `/api/clip/` had,
         * where an imported PNG was served as video/mp4. Latent today because
         * the engine only writes PNG, which is exactly how it would survive
         * until the day something else lands here. */
        const mime = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
          ".svg": "image/svg+xml", ".avif": "image/avif", ".tif": "image/tiff",
          ".tiff": "image/tiff", ".ico": "image/x-icon",
          ".pdf": "application/pdf" }[path.extname(name).toLowerCase()] || "image/png";
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
     * Bounce a timeline's AUDIO to one file — the other half of Export.
     *
     * `Export video` is a real-time MediaRecorder capture and needs a browser.
     * The sound does not: server/timelinemix.py renders the mix offline from
     * the same numbers playback uses — track levels, mutes, solos, per-item
     * fades and in-points — so what lands here is what the monitor plays.
     *
     * ⚠ RESOLVING `src` IS THIS ROUTE'S JOB, not the worker's. Items carry app
     * URLs ("/api/audio/x.flac", "/api/clip/y.mp4"); the worker takes absolute
     * paths only, so a job cannot become a second file-access surface that
     * nobody audited.
     *
     * The file lands in the LIBRARY rather than beside the clips, because a
     * bounce is a track: it should play, take a cover, get tagged and export
     * like anything else. Which is also why wav is refused — server/library.js
     * indexes .flac/.mp3/.opus, so a WAV would be written and then appear
     * nowhere in the app. Same lesson exportAudio.js already learned about
     * offering a format the rest of the stack does not carry.
     */
    if (p === "/api/studio/bounce" && req.method === "POST") {
      const b = await readBody(req);
      const format = String(b.format || "flac").toLowerCase();
      if (format !== "flac" && format !== "mp3") {
        return json(res, 400, { error: "Bounce to flac or mp3 — a WAV would not show up in your library." });
      }

      let doc = b.doc;
      if (!doc && b.project) {
        const file = path.basename(String(b.project)).endsWith(".json")
          ? path.basename(String(b.project))
          : `${String(b.project).replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60)}.json`;
        try { doc = JSON.parse(await readFile(path.join(PROJECT_DIR, file), "utf8")); }
        catch { return json(res, 404, { error: `No saved project called “${b.project}”.` }); }
      }
      if (!doc || !Array.isArray(doc.tracks)) return json(res, 400, { error: "Nothing to bounce." });

      // Only our own two media folders, and only by basename — the same rule
      // /api/audio/ and /api/clip/ enforce when they serve these files.
      const srcPath = (src) => {
        const s = String(src || "");
        for (const [prefix, dir] of [["/api/audio/", config.outputDir], ["/api/clip/", CLIP_DIR]]) {
          if (!s.startsWith(prefix)) continue;
          let name;
          try { name = decodeURIComponent(s.slice(prefix.length)); } catch { return null; }
          if (!name || name.includes("..") || path.isAbsolute(name)) return null;
          return path.join(dir, path.basename(name));
        }
        return null;
      };

      const missing = [];
      const tracks = doc.tracks.map((t) => ({
        kind: t.kind === "video" ? "video" : "audio",
        level: t.level ?? 1, muted: !!t.muted, solo: !!t.solo,
        items: (t.items || []).map((it) => {
          const src = srcPath(it.src);
          if (!src && t.kind !== "video") missing.push(it.name || it.src);
          return {
            src, start: Number(it.start) || 0, dur: Number(it.dur) || 0,
            inPoint: Number(it.inPoint) || 0,
            fadeIn: Number(it.fadeIn) || 0, fadeOut: Number(it.fadeOut) || 0,
          };
        }).filter((it) => it.src),
      }));
      if (missing.length) {
        return json(res, 400, { error: `Could not find ${missing.slice(0, 3).join(", ")} — bounce only reads your own library and clips.` });
      }

      const title = String(doc.name || doc.songTitle || "Timeline").slice(0, 60);
      // `aiplay_` because library.js lists by PREFIX: a bounce called anything
      // else is written, indexed by nothing, and invisible in Music.
      const outName = `aiplay_bounce_${Date.now().toString(36)}.${format}`;
      const jobPath = path.join(config.outputDir, `.bounce_${Date.now().toString(36)}.json`);
      await writeFile(jobPath, JSON.stringify({
        tracks, out: path.join(config.outputDir, outName), format,
        sampleRate: Number(b.sampleRate) || 44100,
        seconds: Number(b.seconds) || null,
        normalize: b.normalize === undefined ? { rmsDb: -14, peakDb: -1 } : b.normalize,
      }));
      try {
        const out = await new Promise((resolve, reject) => {
          const proc = spawn(config.python, [path.join(__dirname, "timelinemix.py"), jobPath], { windowsHide: true });
          let so = "", se = "";
          proc.stdout.on("data", (d) => { so += d; });
          proc.stderr.on("data", (d) => { se += d; });
          proc.on("close", (code) => code === 0 ? resolve(so) : reject(new Error(se.slice(-300) || `exit ${code}`)));
        });
        // `out` is an absolute path on this machine; the client gets the name.
        const { out: _abs, ...r } = JSON.parse(out.trim().split("\n").pop());
        if (!r.ok) throw new Error(r.error || "the mix failed");
        library.remember(outName, {
          title: `${title} · bounce`, seed: 0,
          durationSeconds: Math.round(r.seconds || 0), createdAt: Date.now(),
          bouncedFrom: doc.name || null, bounceTracks: r.tracks, bounceItems: r.items,
        });
        /* A bounce is a human (or agent) ARRANGEMENT of AI-generated tracks:
         * the timeline mix is an `edit`, the file it seals is an `export`,
         * and the whole-work class is composite-synthetic — AI parts certain,
         * arrangement recorded under whoever actually did it. */
        {
          const actor = prov.actorFrom(req);
          provNote("library", {
            actor, type: "edit", asset: outName,
            data: { op: "bounce", tracks: r.tracks ?? null, items: r.items ?? null,
                    bouncedFrom: doc.name || null },
          });
          provNote("library", {
            actor, type: "export", asset: outName,
            data: { format, embedded: "tags" },
          });
        }
        // Stamp the file itself: composite marker + (toggle-governed) record.
        try {
          await library.tagFile(outName, {
            title: `${title} · bounce`,
            date: new Date().toISOString().slice(0, 10),
            digitalSourceType: prov.DIGITAL_SOURCE_TYPE["composite-synthetic"],
            disclosure: prov.markerFor("composite-synthetic", { media: "audio" }).disclosure,
            generator: "MiniMax-Music3",
            ...(config.provenance.embedRecord === false ? { tier2: false } : {
              provenance: {
                originMap: { class: "composite-synthetic", tracks: r.tracks ?? null,
                             items: r.items ?? null },
                chainHead: await prov.head("library").catch(() => null),
              },
            }),
          });
        } catch (err) {
          console.error(`  [provenance] bounce tagging failed for ${outName}: ${err.message}`);
        }
        return json(res, 200, { ...r, name: outName, title: `${title} · bounce` });
      } catch (err) {
        /* A half-written mix is still `aiplay_*.flac` in the output folder,
         * which is all the library needs to list it — so a failed bounce would
         * put a broken track in Music. Take it back out. */
        await unlink(path.join(config.outputDir, outName)).catch(() => {});
        return json(res, 400, { error: `Bounce failed: ${err.message}` });
      } finally {
        unlink(jobPath).catch(() => {});
      }
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
        actor: prov.actorFrom(req),
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
       * MEASURE a clip instead of judging it. Free, no GPU, no model.
       *
       * This is the deterministic floor, and it exists because a VLM judge
       * saturates — AutoMV measured Qwen-Omni scoring nearly everything 4.7-5.0,
       * and Gemini-2.5-Pro rating AutoMV's own output 4.30/4.55/4.59 where human
       * experts gave 2.94/2.05/2.62 on the same footage. So every ABSOLUTE
       * threshold here has to come from a signal like this one, and a model may
       * only ever COMPARE two candidates above it.
       *
       * It earned its place on the first run: sub-rosa scene 1's chosen take was
       * the most static of the five takes rendered for it (median flow 0.036
       * against 0.247 for the H3 take of the same scene, 52 of 89 frames still).
       * Nothing in the pipeline could see that, because nothing looked at motion.
       *
       * scripts/clipflow.py carries the method, the units and the thresholds —
       * including why a frozen TAIL is counted apart from stillness generally.
       */
      if (b.action === "flow") {
        const names = (Array.isArray(b.names) ? b.names : [b.name]).map((x) => String(x || ""));
        if (!names.length || names.some((n) => !n || n.includes("..") || n.includes("/") || n.includes("\\"))) {
          return json(res, 400, { error: "bad name" });
        }
        const paths = [];
        for (const n of names) {
          const full = path.join(CLIP_DIR, n);
          try { await stat(full); }
          catch { return json(res, 400, { error: `${n} is not on disk.` }); }
          paths.push(full);
        }
        const r = await new Promise((resolve) => {
          const proc = spawn(config.python, [path.join(__dirname, "..", "scripts", "clipflow.py"), ...paths]);
          let so = "", se = "";
          proc.stdout.on("data", (d) => (so += d));
          proc.stderr.on("data", (d) => (se += d));
          proc.on("exit", (code) => resolve({ code, so, se }));
          proc.on("error", () => resolve({ code: 1, so: "", se: "spawn failed" }));
        });
        let body;
        try { body = JSON.parse(r.so); }
        catch { return json(res, 500, { error: r.se.slice(-200) || "flow analysis failed" }); }
        const clips = Array.isArray(body) ? body : [body];
        /* `unreadable` is counted SEPARATELY, and that distinction is the whole
         * point of a deterministic floor. clipflow.py returns {error} with no
         * `ok` key when OpenCV cannot decode a file, and `undefined === false`
         * is false — so counting only `ok === false` filed every unmeasurable
         * clip under "passed". CLIP_DIR holds imported stills and audio beside
         * the renders, so this is ordinary library content, not a corrupt-file
         * edge case. A caller branching on `flagged === 0` must never be told a
         * clip cleared a gate that did not run on it. */
        const unreadable = clips.filter((c) => c.error).length;
        return json(res, 200, {
          ok: true,
          clips,
          flagged: clips.filter((c) => c.ok === false).length,
          unreadable,
        });
      }

      /**
       * FRAMES from a clip, as pictures — the comparator layer.
       *
       * Deliberately weaker than the `flow` action above it, and the pairing is
       * the point. `flow` MEASURES and may hold a threshold; this hands over
       * pictures so something else can form an opinion, and that opinion may
       * only ever COMPARE two candidates. A VLM judge saturates — Qwen-Omni
       * scored nearly everything 4.7-5.0, and Gemini-2.5-Pro rated AutoMV's own
       * output 4.30/4.55/4.59 where human experts gave 2.94/2.05/2.62 on the
       * same footage — so "which of these takes is better" is answerable here
       * and "is this take good enough" is not. That one belongs to `flow`.
       *
       * Returns `_images`, the shape the MCP transport already turns into image
       * content for image_review, so no new case is needed there.
       */
      if (b.action === "review") {
        const name = String(b.name || "");
        if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
          return json(res, 400, { error: "bad name" });
        }
        const full = path.join(CLIP_DIR, name);
        try { await stat(full); } catch { return json(res, 400, { error: `${name} is not on disk.` }); }
        const count = Math.max(1, Math.min(Number(b.count) || 6, 12));
        const r = await new Promise((resolve) => {
          const proc = spawn(config.python, [path.join(__dirname, "..", "scripts", "clipframes.py"),
                                             full, String(count), String(Number(b.width) || 512)]);
          let so = "", se = "";
          proc.stdout.on("data", (d) => (so += d));
          proc.stderr.on("data", (d) => (se += d));
          proc.on("exit", (code) => resolve({ code, so, se }));
          proc.on("error", () => resolve({ code: 1, so: "", se: "spawn failed" }));
        });
        let body;
        try { body = JSON.parse(r.so); }
        catch { return json(res, 500, { error: r.se.slice(-200) || "could not read frames" }); }
        if (body.error) return json(res, 500, body);
        return json(res, 200, {
          ok: true, name,
          durationSec: body.durationSec, fps: body.fps, sampled: body.sampled,
          at: body.images.map((i) => i.atSec),
          _images: body.images.map((i) => ({ data: i.data, mimeType: i.mimeType })),
        });
      }

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
          actor: prov.actorFrom(req),
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
        /* The VFX serve child keeps decoders open between frames, and Windows
         * refuses to move a file a process holds open. Ask it to let go first;
         * a no-op when the compositor has not been used. */
        if (vfxRoutes.releaseSources) await vfxRoutes.releaseSources();
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

    /**
     * A poster frame for a clip, so the library can be pictures instead of video.
     *
     * MEASURED, and the reason this exists: the grid rendered one <video> per
     * clip and the folder holds 438 of them. Every tile that scrolled into view
     * fetched 1-3 MB of MP4 to show one still. The JPEG is about 15 KB, and an
     * <img> lazy-loads natively — no observer, no media element, no decode.
     *
     * Cached beside the clips under `.thumbs`, keyed on the SOURCE mtime rather
     * than on existence: an enhanced clip keeps its name and replaces its bytes,
     * and a stale poster of the pre-enhance version is a silent lie. `.thumbs`
     * is invisible to the listing above, which filters on media extensions.
     *
     * Generated by scripts/clipthumb.py through OpenCV — NOT ffmpeg, which this
     * codebase deliberately does not depend on. Same shape as beats.py.
     */
    if (p.startsWith("/api/clipthumb/")) {
      const name = decodeURIComponent(p.slice("/api/clipthumb/".length));
      if (!name || name.includes("..") || path.isAbsolute(name)) {
        return json(res, 400, { error: "bad name" });
      }
      const full = path.join(CLIP_DIR, name);
      let srcSt;
      try { srcSt = await stat(full); } catch { return json(res, 404, { error: "no clip" }); }

      const dest = path.join(CLIP_DIR, ".thumbs", `${name}.jpg`);
      let fresh = false;
      try { fresh = (await stat(dest)).mtimeMs >= srcSt.mtimeMs; } catch { /* not made yet */ }

      if (!fresh) {
        const r = await new Promise((resolve) => {
          const proc = spawn(config.python, [path.join(__dirname, "..", "scripts", "clipthumb.py"), full, dest]);
          let so = "", se = "";
          proc.stdout.on("data", (d) => (so += d));
          proc.stderr.on("data", (d) => (se += d));
          proc.on("exit", (code) => resolve({ code, so, se }));
          proc.on("error", () => resolve({ code: 1, so: "", se: "spawn failed" }));
        });
        if (r.code !== 0) return json(res, 500, { error: r.se.slice(-200) || "could not make a poster" });
      }

      let buf;
      try { buf = await readFile(dest); } catch { return json(res, 500, { error: "poster vanished" }); }
      /* REVALIDATE rather than cache blind.
       *
       * The URL is keyed on the clip NAME, and a clip can be replaced under its
       * own name — `enhance` writes a better version back over it. A hard
       * max-age would pin a poster of footage that no longer exists, which is
       * exactly the staleness the mtime check above exists to prevent: the
       * server would regenerate correctly and the browser would never ask. An
       * ETag over the source mtime keeps the bytes off the wire through a 304
       * while leaving the decision with the server. */
      const etag = `"${Math.round(srcSt.mtimeMs)}-${buf.length}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" });
        return res.end();
      }
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": buf.length,
        ETag: etag,
        "Cache-Control": "no-cache",
      });
      return res.end(buf);
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

/* DAWUI: the DAW's live document sync rides this SAME socket — one connection
 * per page, two kinds of frame (`state` for jobs, `daw` for documents). It
 * watches <output>/daw/<slug>/project.json rather than hooking the route, so
 * a mutation made by ANY writer — this server, an MCP tool in another
 * process, a repair script — reaches an open page. Purely additive: if the
 * watch cannot start the DAW is unchanged, it simply stops animating. */
const dawLive = createDawLive({
  dir: path.join(config.outputDir, "daw"),
  broadcast: (msg) => { for (const c of wss.clients) if (c.readyState === 1) c.send(msg); },
  log: (m) => console.log(`  ${m}`),
});
dawLive.start();
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
  // The lab's knobs and comparison groups, applied back into config on the way in.
  await videoLabRoutes.load();
  console.log(`  library: ${(await library.list()).length} tracks on disk`);
  await batch.load();
  const b = batch.status().run;
  if (b) console.log(`  batch "${b.name}": ${b.done}/${b.total} done, ${b.state}`);
  if (config.musicOnly) {
    /* Music-only starts no ComfyUI — unless this machine has a ComfyUI install
     * AND a YuE2 checkpoint. That is the only music route on a card the native
     * GGUF runtime cannot use (AMD), so the engine then starts exactly as in
     * full Studio and YuE2 through ComfyUI becomes available. */
    const exists = (p) => stat(p).then(() => true, () => false);
    const ckpts = await findYue2Checkpoints().catch(() => []);
    const hasRig = await exists(path.join(config.comfyDir, "main.py")) && await exists(config.python);
    if (!hasRig || !ckpts.length) {
      console.log("  native music-only mode: ComfyUI is not started. Open Models to install YuE2 GGUF"
        + " (or put a YuE2 checkpoint in ComfyUI's models/checkpoints to use YuE2 through ComfyUI).");
      jobs.emit("update",jobs.snapshot());
      return;
    }
    comfyWanted = true;
    if (!ckpts.includes(config.music.yue2Checkpoint)) {
      config.music.yue2Checkpoint = ckpts.find((n) => /bf16/i.test(n)) || ckpts[0];
    }
    const gguf = await ggufSetup.status().catch(() => ({}));
    const ggufReady = Object.values(gguf.variants || {}).some((v) => v?.ready) || gguf.ready === true;
    if (config.music.engine !== "yue2-comfy" && !ggufReady) config.music.engine = "yue2-comfy";
    musicChoicesCache.at = 0;
    console.log(`  music-only mode: YuE2 checkpoint found (${bareName(config.music.yue2Checkpoint)}) — starting ComfyUI for YuE2 3B`);
  } else if (config.music.engine === "yue2-gguf") {
    /* Full Studio remembering native GGUF where it is not installed (it is an
     * NVIDIA-only runtime): every Create would be refused. With a YuE2
     * checkpoint on disk, YuE2 through ComfyUI is the same model, so use it —
     * and say so, rather than switching silently. */
    const gguf = await ggufSetup.status().catch(() => ({}));
    const ggufReady = Object.values(gguf.variants || {}).some((v) => v?.ready) || gguf.ready === true;
    const ckpts = ggufReady ? [] : await findYue2Checkpoints().catch(() => []);
    if (!ggufReady && ckpts.length) {
      config.music.engine = "yue2-comfy";
      if (!ckpts.includes(config.music.yue2Checkpoint)) {
        config.music.yue2Checkpoint = ckpts.find((n) => /bf16/i.test(n)) || ckpts[0];
      }
      musicChoicesCache.at = 0;
      savePrefs();
      console.log(`  native YuE2 GGUF is selected but not installed — using YuE2 through ComfyUI (${bareName(config.music.yue2Checkpoint)}) instead`);
    }
  }
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
      /* The selected music engine's own settings, not MiniMax's regardless. */
      console.log(config.music.engine === "yue2-comfy"
        ? `  YuE2 3B (ComfyUI) · ${bareName(config.music.yue2Checkpoint) || "no checkpoint chosen"} · dpm_2 / sgm_uniform · 32 steps\n`
        : config.music.engine === "minimax-music3"
          ? `  MiniMax Music 3 · ${config.sampling.sampler} · shift ${config.sampling.shift} · ${config.sampling.steps} steps\n`
          : `  music engine: ${config.music.engines[config.music.engine]?.label || config.music.engine}\n`);
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
