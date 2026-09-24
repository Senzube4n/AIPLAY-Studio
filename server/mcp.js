#!/usr/bin/env node
/**
 * AIPLAY Studio — MCP server.
 *
 * Lets an agent drive the whole studio: write a song, draw pictures, render
 * clips, read the beat grid off the finished audio, and assemble a music video
 * cut to it. Everything here is a thin, typed face on the HTTP API the app
 * already serves, so there is exactly one implementation of each behaviour and
 * the UI and an agent cannot drift apart.
 *
 *   node server/mcp.js            # speaks MCP over stdin/stdout
 *
 * Point it at a running Studio with AIPLAY_URL (default http://127.0.0.1:4173).
 *
 * The stdio transport uses Node's built-in HTTP/JSON support. Tools call the
 * Studio API and preserve agent provenance. VFX renders can export video on
 * the server; the legacy Studio canvas export remains browser-based.
 */
import http from "node:http";
import { URL, fileURLToPath } from "node:url";
import path from "node:path";
import { realpathSync } from "node:fs";
/* h3tier.js is pure (no config.js): the lab's words for FastH3 and sol-attn, one copy. */
import { h3Brief, H3_SOL_ATTN, H3_MORE_MOTION } from "./h3tier.js";
import { vfxTools } from "./mcp-vfx.js";
import { dawTools } from "./mcp-daw.js";
// Video Workflow tools (FORK — see FORK_DELTA.md).
import { mvTools } from "./mcp-mv.js";
// The map of the surface (FORK): pipeline_guide, listed first on purpose.
import { guideTools } from "./mcp-guide.js";
// The Video lab (FORK): comparison, the quality selector and the render toggles.
import { videoLabTools } from "./mcp-videolab.js";
/* The engine door (FORK): the raw ComfyUI graph, and the record of every one
 * that ran. The engine has no address of its own any more — these tools are
 * the way in, and the reason there is a way in at all. */
import { engineTools } from "./mcp-engine.js";
import { musicInputTools } from "./mcp-music-input.js";
import { musicPlanTools } from "./mcp-music-plan.js";
import { musicKitTools } from "./mcp-music-kits.js";
import { musicReferenceTools } from "./mcp-music-references.js";
import { musicArtifactTools } from "./mcp-music-artifacts.js";
import { musicListeningLabTools } from "./mcp-music-listening-lab.js";
/* AUDIO FINISHING. Four routes that existed, worked, and that no tool posted
 * to — /api/edit, /api/merge, /api/export and /api/timeline/render. The header
 * of mcp-audio.js carries the audit that found them and the reason an agent
 * that can generate a song and cannot top-and-tail it is the wrong surface. */
import { audioTools } from "./mcp-audio.js";
/* The score door: the ABC lead sheet YuE2 plans before it renders, its
 * versions, and the engraver. Unregistered until 2026-09-11 — see the note at
 * the spread below. */
import { scoreTools } from "./mcp-music-score.js";
import { musicAuditionTools } from "./mcp-music-auditions.js";
import { yueSetupTools } from "./mcp-yue-setup.js";
/* One-click setups (timed lyrics): server/setup/, the [Set up timed lyrics] button's door. */
import { setupTools } from "./mcp-setup.js";
import { avatarTools } from "./mcp-avatars.js";
import { avatarWeightTransferTools } from "./mcp-avatar-weight-transfer.js";
import { avatarPlaybackTools } from "./mcp-avatar-playback.js";
import { avatarWardrobeTools } from "./mcp-avatar-wardrobe.js";
import { avatarFittingTools } from "./mcp-avatar-fitting.js";
import { videoLoraInput } from "./video-lora-validation.js";
import { waitForArtJob, emptyResultNote } from "./art-wait.js";

/* The welcome window's catalogue (FORK): what the studio is and can make, in
 * the same words the app shows a new person. */
import { welcomeTools } from "./mcp-welcome.js";
/* The Models screen's hardware answer: which of these an agent's user can
 * actually run, and what to fetch first. */
import { modelTools } from "./mcp-models.js";
import { cloudTools } from "./mcp-cloud.js";
import { collabTools } from "./mcp-collab.js";
import { workspaceTools } from "./mcp-workspace.js";
import { excludedTerritoriesText } from "./models.js";

// H3's excluded territories come from the catalogue (models.js excludedTerritoriesText);
// tool text once hand-typed three of them while the catalogue said four.
const H3_EXCLUDED = excludedTerritoriesText();

const BASE = process.env.AIPLAY_URL || "http://127.0.0.1:4173";

/**
 * The actor this MCP process stamps on every request — ALWAYS `agent:<name>`.
 *
 * The provenance ledger's integrity rests on this line (SPEC D1.0/D1.4): an
 * action driven through MCP is an agent's action and is recorded as one.
 * AIPLAY_AGENT customises the NAME only; whatever it says, the `agent:`
 * prefix is forced in code, so no environment, argument or configuration can
 * make this process claim to be the user. Do not "fix" that.
 */
const ACTOR = "agent:" + ((process.env.AIPLAY_AGENT || "mcp")
  .toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 32) || "mcp");

/* ────────────────────────────────────────────────────────────── HTTP */

/**
 * ONE SENTENCE FOR A REFUSAL, the way an agent needs it.
 *
 * A door that says "this machine is not ready" answers 409 with the sentence
 * and, when one button would fix it, `setup`: the id POST /api/setup
 * {action:"run", id} takes. The page turns that into an Install dialog; an
 * agent only gets the words, so the id is appended in words it can act on —
 * never run: setup_feature downloads gigabytes, so it waits for the person's
 * yes. `needsModel` (a catalogue row to download) keeps song_to_score's
 * existing suffix. Everything else the body carries stays on the thrown error
 * as `.cause.refusal` (and the HTTP status as `.cause.status`).
 */
export function refusalText(r) {
  if (!r || typeof r !== "object") return String(r ?? "");
  let text = String(r.error || "");
  if (typeof r.setup === "string" && r.setup && !text.includes(`"${r.setup}"`)) {
    text += ` Setup id: ${r.setup}. Call setup_feature {"id":"${r.setup}"} once the person agrees.`;
  }
  if (r.needsModel) text += ` (needsModel: ${r.needsModel})`;
  return text;
}

/**
 * Call the Studio API.
 *
 * Uses node:http rather than fetch for one reason: a render can take minutes and
 * the default fetch timeout would abandon a job that is going perfectly well.
 * The failure mode matters — an abandoned poll looks exactly like a failed
 * render to the caller, and the render carries on burning the GPU either way.
 */
function api(method, path, body, timeoutMs = 120_000, media = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE);
    const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
        headers: {
          // Every MCP-driven call self-identifies as the agent it is — the
          // server's provenance ledger stamps events from this header.
          "x-aiplay-actor": ACTOR,
          ...(payload
            ? { "Content-Type": media?.contentType || "application/json", "Content-Length": payload.length,
                ...(media?.name ? { "X-Name": encodeURIComponent(media.name) } : {}) }
            : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed;
          try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 400) }; }
          /* The refusal's own words, plus the setup id or model row that
           * would fix it (refusalText), and the whole body kept on the error
           * as its cause ({status, refusal}): a 409's setup/pip/python used to
           * be dropped here. A safety 422 carries no setup, so its sentence
           * reaches the agent unchanged (server/safety/doors_test pins this
           * line's shape). */
          if (res.statusCode >= 400) {
            reject(new Error(parsed?.error ? refusalText(parsed) : `HTTP ${res.statusCode}`,
              { cause: { status: res.statusCode, refusal: parsed } }));
            return;
          }
          resolve(parsed);
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Studio did not answer in time")));
    req.on("error", (err) => reject(
      err.code === "ECONNREFUSED"
        ? new Error(`No Studio at ${BASE}. Start it with: node server/index.js`)
        : err,
    ));
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ────────────────────────────────────────────────────── shared helpers */

/** A file name that cannot escape its folder or name something we do not serve. */
function safeName(name, what = "file") {
  const s = String(name || "");
  if (!s || s.includes("..") || s.includes("/") || s.includes("\\")) {
    throw new Error(`Bad ${what} name: ${JSON.stringify(s)}`);
  }
  return s;
}

/**
 * Wait for a music job to finish.
 *
 * Polls rather than holding a websocket: this process is short-lived and one
 * poll a second against a local server costs nothing measurable, while a socket
 * would need reconnection logic for a case that lasts minutes at most.
 */
async function waitForSong(jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let unseen = 0;
  for (;;) {
    const st = await api("GET", "/api/status");
    const inHistory = (st.history || []).find((j) => j.id === jobId);
    const replacement = (await api("GET", `/api/music-auditions?jobId=${encodeURIComponent(jobId)}`)).result;
    if (replacement?.state === "ready") return { ...inHistory, ...replacement, audioSeconds: replacement.seconds, replacement };
    if (replacement?.state === "failed" || replacement?.state === "cancelled") throw new Error(replacement.error || "The replacement was cancelled.");
    if (inHistory && inHistory.state === "done" && !replacement) return inHistory;
    if (inHistory && inHistory.state === "failed") {
      throw new Error(inHistory.error || "the render failed");
    }
    if (inHistory && inHistory.state === "cancelled") {
      throw new Error(`Job "${jobId}" was cancelled. No completed song was returned.`);
    }
    /* An id the server has never heard of must not spin the full timeout
     * claiming "Still running" — that is a lie about a job that does not
     * exist. Not current, not queued, not in history = unknown; one repoll
     * rides out the instant a job moves between those lists. */
    const isMine = (j) => j && j.id === jobId;
    if (!replacement && !inHistory && !isMine(st.current) && !(st.queue || []).some(isMine)) {
      if (++unseen >= 2) {
        throw new Error(
          `No job with id "${jobId}" — it is not running, not queued, and not in the server's `
          + `history. Check the job_id against make_song's reply; finished tracks are listed by `
          + `list_songs.`,
        );
      }
    } else {
      unseen = 0;
    }
    if (Date.now() > deadline) {
      const cur = isMine(st.current) ? st.current : null;
      const queued = (st.queue || []).some(isMine);
      const estimate = cur && Number.isFinite(cur.etaSeconds) && cur.etaSeconds >= 0
        ? `about ${Math.round(cur.etaSeconds)}s left` : "ETA unavailable";
      throw new Error(
        `Wait timed out after ${Math.round(timeoutMs / 1000)}s`
        + (cur ? ` (${cur.title || jobId}: ${cur.stageLabel || cur.state || "working"}, ${estimate})`
          : replacement?.state === "composing" ? ` (job ${jobId} is composing the full candidate; ETA unavailable)`
          : queued ? ` (job ${jobId} is still queued; ETA unavailable)`
          : ` (job ${jobId} status is not confirmed)`)
        + ". Nothing was cancelled — call wait_for_song again with the same job_id.",
      );
    }
    await sleep(2000);
  }
}

/**
 * Wait for ONE art job, the one this call just queued, and judge it by its own
 * outcome. server/art-wait.js holds the loop and the reasons, and the chat's
 * picture tool runs the same one: it used to throw `art.lastError`, the
 * queue's last failure whoever's it was, after waiting for the whole queue.
 *
 * Music still preempts: a job behind a song just stays queued, so calling this
 * while a song renders waits for the song too. Said in the tool descriptions
 * rather than worked around.
 */
async function waitForArt(timeoutMs, kind, jobId) {
  return waitForArtJob({ api, sleep, timeoutMs, kind, jobId });
}

/* ───────────────────────────────────────────────── the music video */

/**
 * Lay clips onto bar lines and write a Studio project.
 *
 * This is the tool the whole server exists for, and the only one that is more
 * than a rename of an HTTP route. The arithmetic mirrors `cutToBeat` in
 * web/studio.js deliberately — same bar grid, same "a clip keeps its own length
 * if the slot is longer than its source" rule — so opening the result and
 * pressing "Cut to beat" is a no-op rather than a second, different edit.
 */
async function buildMusicVideo(args) {
  const song = safeName(args.song, "song");
  const clips = (args.clips || []).map((c) => safeName(c, "clip"));
  if (!clips.length) throw new Error("Give it at least one clip.");

  const beats = await api("GET", `/api/beats/${encodeURIComponent(song)}`, undefined, 180_000);
  if (beats.error) throw new Error(beats.error);

  const mult = args.beat_mult === 0.5 || args.beat_mult === 2 ? args.beat_mult : 1;
  let grid = beats.beats;
  if (mult === 0.5) grid = grid.filter((_, i) => i % 2 === 0);
  if (mult === 2) {
    const out = [];
    for (let i = 0; i < grid.length; i++) {
      out.push(grid[i]);
      if (i + 1 < grid.length) out.push((grid[i] + grid[i + 1]) / 2);
    }
    grid = out;
  }
  const bars = grid.filter((_, i) => i % 4 === 0);
  if (bars.length < 2) throw new Error("Not enough beats in that track to cut against.");

  const barsPer = Math.min(Math.max(Number(args.bars_per_clip) || 1, 1), 16);
  const songLen = Number(beats.duration) || 0;

  /* Clip sources: the library knows how long each one is. A clip whose real
   * length is unknown is assumed to be five seconds, which is what every
   * generated clip is — and being wrong here only means the slot is trimmed,
   * never that the project is broken. */
  const clipRows = (await api("GET", "/api/clips")).clips || [];
  const lenOf = (name) => {
    const row = clipRows.find((c) => c.name === name);
    return Number(row?.meta?.clipSeconds) || 5;
  };

  const items = [];
  let i = 0;
  /* Repeat the clip list until the song is covered, rather than stopping when
   * the clips run out. Four clips against a three-minute track is the normal
   * case, not an error, and a video that stops a third of the way through is
   * not what anyone asked for. */
  for (let slot = 0; ; slot++) {
    const from = bars[Math.min(slot * barsPer, bars.length - 1)];
    const to = bars[Math.min((slot + 1) * barsPer, bars.length - 1)];
    const span = to - from;
    if (span <= 0.05) break;                       // ran out of bars
    if (songLen && from >= songLen) break;
    /* Fill the WHOLE slot, repeating the clip if it is shorter than the bar
     * span it was given.
     *
     * ⚠ Measured the hard way. A five-second clip in a seven-second slot (two
     * bars at 69 BPM) leaves two seconds of BLACK at every cut — and the
     * exported video is then a third black. Trimming a long clip to fit is
     * correct; leaving a hole when it is short is not, because the alternatives
     * an editor has are to repeat it, freeze it or stretch it, and repeating is
     * the only one that neither invents motion nor changes the speed.
     *
     * A still has effectively unlimited length, so it fills any slot in one go. */
    const name = clips[i % clips.length];
    i++;
    const srcLen = lenOf(name);
    const isStill = /\.(png|jpg|jpeg|webp|gif)$/i.test(name);
    let at = from;
    let guard = 0;
    while (at < to - 0.05 && guard++ < 40) {
      const piece = Math.min(srcLen, to - at);
      items.push({
        id: 1000 + items.length,
        name,
        src: `/api/clip/${encodeURIComponent(name)}`,
        start: Number(at.toFixed(3)),
        dur: Number(piece.toFixed(3)),
        inPoint: 0,
        srcDur: srcLen,
        still: isStill || undefined,
      });
      at += piece;
      if (isStill) break;                    // one still covers the whole slot
    }
    if (items.length > 2000) break;                // a guard, never a real limit
  }

  const lib = (await api("GET", "/api/status")).library || [];
  const row = lib.find((t) => t.file === song);

  const doc = {
    v: 1,
    tracks: [
      {
        id: 1, kind: "video", name: "Video 1", muted: false, solo: false, level: 1,
        items,
      },
      {
        id: 2, kind: "audio", name: "Music", muted: false, solo: false, level: 1,
        items: [{
          id: 2000, name: row?.title || song,
          src: `/api/audio/${encodeURIComponent(song)}`,
          start: 0, dur: songLen || row?.durationSeconds || 60,
          inPoint: 0, srcDur: songLen || row?.durationSeconds || 60,
        }],
      },
    ],
    fx: {
      beat: args.effect || "punch",
      amount: clamp01(args.amount ?? 0.5),
      drift: clamp01(args.drift ?? 0.15),
      look: args.look || "none",
      vignette: clamp01(args.vignette ?? 0.25),
    },
    vis: args.visualiser || "off",
    out: { w: 1280, h: 720, fps: 30, mbps: 8, codec: "auto" },
    songTitle: row?.title || song,
    lrc: [],
    t: 0,
    beatCfg: {
      sens: clamp01(args.sensitivity ?? 0.5),
      band: args.band || "bass",
      // The reason this server exists at all: a pulse cannot make a slow morph.
      drive: ["pulse", "envelope", "both"].includes(args.drive) ? args.drive : "pulse",
      smooth: clamp01(args.smoothing ?? 0.35),
    },
    beatMult: mult,
    beatSync: true,
    visSize: 0.4,
    visOpacity: 0.7,
  };

  const name = String(args.name || `${row?.title || song} — cut`).slice(0, 80);
  const saved = await api("POST", "/api/studio/projects", { action: "save", name, doc });
  if (saved.error) throw new Error(saved.error);

  return {
    project: saved.name,
    file: saved.file,
    bpm: beats.bpm,
    confidence: beats.confidence,
    bars_used: Math.ceil(items.length * barsPer),
    clips_placed: items.length,
    covers_seconds: items.length ? Number((items[items.length - 1].start + items[items.length - 1].dur).toFixed(2)) : 0,
    song_seconds: songLen,
    open_it: "Open Studio → Open… → " + saved.name + ", then press Export video.",
  };
}

const clamp01 = (v) => Math.min(Math.max(Number(v) || 0, 0), 1);

/* ──────────────────────────────────────────────────────────── tools */

// Exported for mcp-image_test.js, which asserts every declared parameter is
// named in its run() — the same guard mcp-vfx_test.js runs over the VFX tools.
export const TOOLS = [
  /* FIRST in the list on purpose: the tool list is the only thing a fresh
   * agent reads, so the map heads it. mcp-guide_test.js proves every tool
   * name inside the guide exists in this array. */
  ...guideTools(),
  /* SECOND, beside the map, because they answer the two questions a fresh agent
   * has and neither answers the other's: pipeline_guide maps the TOOL SURFACE
   * (which of these to call, in what order); studio_capabilities maps the
   * PRODUCT (what the screens are, what they can and cannot make, which
   * licences bite, what a size costs) — the same document the app's own welcome
   * window renders, so the agent and the person read one page. */
  ...welcomeTools(api),
  /* THIRD, and before any tool that renders anything, because it is the only
   * one that knows what this machine can do. studio_capabilities says what the
   * studio is; this says which half of it runs here. An agent that skips it
   * recommends a 43 GB video engine to an 8 GB card, politely and with
   * complete confidence. */
  ...modelTools(api),
  ...cloudTools(api),
  ...collabTools(api, safeName),
  ...workspaceTools(api, safeName),
  ...musicInputTools(api),
  ...musicPlanTools(api),
  ...musicKitTools(api),
  ...musicReferenceTools(api),
  ...musicArtifactTools(api),
  ...musicListeningLabTools(api),
  /* Beside the music family, because that is where they are reached FROM: the
   * take comes out of make_song and these are what happens to it next — trim
   * the silence off the front, merge the continuations, convert it, and render
   * the timeline it ends up on. */
  ...audioTools(api, safeName),
  /* ⚠ ADDED LATE, AND THE REASON IS THE POINT. mcp-music-score.js shipped with
   * 188 passing assertions and was never spread in here, so not one of its
   * tools existed on the surface an agent sees. The suite imports scoreTools
   * directly and checks the schemas, which proves the tools are well-formed and
   * says nothing about whether they are REACHABLE. server/score/routes.js had
   * the same hole on the HTTP side at the same time. Two doors, both tested,
   * neither hung — the test that would have caught it asks the running server
   * what it serves, not the module what it exports. */
  ...scoreTools(api),
  ...musicAuditionTools(api),
  ...yueSetupTools(api),
  ...setupTools(api),
  ...avatarTools(api),
  ...avatarPlaybackTools(api),
  ...avatarWeightTransferTools(api),
  ...avatarWardrobeTools(api),
  ...avatarFittingTools(api),
  ...vfxTools(api, safeName),
  ...dawTools(api, safeName),
  {
    name: "studio_status",
    description:
      "What the studio is doing right now: whether the engine is up, what is rendering, "
      + "what is queued, how big the library is, and whether the video models are installed. "
      + "Call this first — every other tool needs the engine ready.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const st = await api("GET", "/api/status");
      return {
        engine_ready: !!st.engine?.ready,
        device: st.engine?.device ?? null,
        engine_fix: st.engine?.fix ?? null,   // the AMD/Intel launch fix: {mode auto|on|off, vendor, applies}
        /* The music model chosen, and the real-audio tokenizer: with it,
         * extend_song and tokenize_track take any track. */
        music: {
          engine: st.config?.musicEngine ?? null,
          tokenizer: st.config?.tokenizer
            ? { ready: !!st.config.tokenizer.ready, missing: (st.config.tokenizer.missing || []).length }
            : null,
        },
        rendering: st.current ? { title: st.current.title, stage: st.current.stageLabel, eta_seconds: st.current.etaSeconds } : null,
        queued_songs: (st.queue || []).map((q) => q.title),
        art_queue: { queued: st.art?.queued ?? 0, current: st.art?.current?.kind ?? null, last_error: st.art?.lastError ?? null },
        songs_in_library: (st.library || []).length,
        video: {
          enabled: !!st.config?.video?.enabled,
          models_installed: st.config?.video?.ready !== false,
          engine: st.config?.video?.engine,
          missing: st.config?.video?.missing || [],
          /* The step counts make_clip's `quality` maps to on THIS disk, and
           * the turbo builds behind them (config.js resolves both from what
           * pick() found): standard is 8 only where both 8-step files are on
           * disk, else 4, and is the default a render with no quality gets. */
          h3_quality_steps: st.config?.video?.engines?.h3?.stepDefaults ?? null,
          /* The number behind "keep my character": the reference build's own
           * step count (workflow.js referenceSteps), which a render with
           * references or a persona and no quality runs. */
          h3_reference_steps: st.config?.video?.engines?.h3?.referenceSteps ?? null,
          h3_turbo_builds: st.config?.video?.engines?.h3?.turboBuilds ?? null,
          /* H3's tier for this card (server/h3tier.js), BRIEF: the size and
           * longest measured clip, whether it is recommended, the RAM and AMD
           * warnings. The need table and every tier stay in /api/status and
           * models_for_this_machine: this tool is called often. */
          h3_card_tier: h3Brief(st.config?.video?.h3),
        },
        /* What runs when nothing names it, and who chose it: "you" (a saved
         * choice, which always wins; `kept` when an older Studio saved it on
         * its own) or "machine" (worked out from what is on this PC, never
         * saved). `savedValue` when this session runs something else than the
         * saved choice, `paid` when songs are billed to the person's own key.
         * The receipts under Make and Settings show the same rows. Change
         * music with set_music_engine, pictures and covers with set_image_engine. */
        defaults: (st.config?.defaults || []).map((d) => ({ key: d.key, value: d.value, chosenBy: d.chosenBy, why: d.why,
          ...(d.kept ? { kept: true } : {}), ...(d.savedValue ? { savedValue: d.savedValue } : {}),
          ...(d.paid ? { paid: true } : {}), ...(d.canRun === false ? { canRun: false } : {}) })),
      };
    },
  },

  {
    name: "list_songs",
    description:
      "Every finished track, newest first: file name, title, length, and whether it already "
      + "has cover art, stems, timed lyrics or a video clip. Also returns generation warnings when recorded; "
      + "an empty warning list does not certify lyric coverage or audio quality. Use the `file` value with the other tools. "
      + "`rights` says whether the song may be sold, worked out from the model catalogue as it is now: "
      + "{ class (unrestricted | yours-with-conditions | not-for-sale | unknown), sellable, label, short, capability, "
      + "licence, url, basis (licence | authors-statement | imported), add_ons (catalogue rows the song used that made it "
      + "stricter), changed? (when the label moved, from what and why) }. YuE2 songs read \"Sellable by individuals (YuE2 "
      + "authors' statement, 15 Sep 2026) · companies need a commercial licence\"; the licence file still reads CC BY-NC 4.0. "
      + "A YuE2 song that used a not-for-sale add-on reads not-for-sale instead, and add_ons names it: a Mothersuperior "
      + "LoRA (the instrumental planner LoRA included), or the real-audio tokenizer (a cover of a recording, a continued "
      + "or section-replaced recording). An imported file with no engine reads basis \"imported\": Studio did not make it. "
      + "`tagged`: true once the file's own tags (AI disclosure, attribution) were written, false while that is owed "
      + "(a FLAC or MP3 is re-tagged by its next cover pass; a native YuE2 WAV is not retried automatically), "
      + "null for songs from before this was recorded.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", description: "How many to return (default 30)." } },
      additionalProperties: false,
    },
    async run(a) {
      const st = await api("GET", "/api/status");
      return (st.library || []).slice(0, Math.max(1, Number(a.limit) || 30)).map((t) => ({
        file: t.file, title: t.title, seconds: t.durationSeconds ?? null,
        engine: t.engine ?? null, precision: t.quantization ?? null,
        has_cover: !!t.cover, has_stems: !!(t.stems || []).length,
        has_lyrics: !!t.lrc, clip: t.clip || null,
        warnings: Array.isArray(t.warnings) ? t.warnings : [],
        generation_limits: t.generationLimits ?? null,
        rights: t.rights && typeof t.rights === "object" ? {
          class: t.rights.class, sellable: t.rights.sellable ?? null, label: t.rights.label ?? null,
          short: t.rights.short ?? null, capability: t.rights.capability ?? null, licence: t.rights.licence ?? null,
          url: t.rights.url ?? null, basis: t.rights.basis ?? null, add_ons: t.rights.addOns || [],
          ...(t.rights.changed ? { changed: t.rights.changed } : {}),
        } : null,
        tagged: t.tagged ?? null,
      }));
    },
  },

  {
    name: "make_song",
    description:
      "Write and render a song. Uses the music engine chosen on the Music page unless `engine` "
      + "names one for this song. Returns a job id immediately — rendering takes minutes, so "
      + "follow with wait_for_song.\n\n"
      + "The caption is the single biggest quality lever, and its grammar is the engine's.\n"
      + "MiniMax Music 3: a three-part structured caption — 'Global Metadata.' (BPM, key, "
      + "genre, emotional progression, production), 'Vocal Details.' (who is singing and how, "
      + "or that it is instrumental), 'Arrangement.' (primary and secondary instruments, groove, "
      + "space). Lyrics take [Verse] / [Chorus] / [Bridge] section tags.\n"
      + "YuE2 3B: ONE line of style tags (genre, mood, tempo, instruments, who sings — "
      + "'female lead vocal', 'male voice'), and lyrics with [Verse] / [Chorus] / [Bridge] "
      + "section tags on their own lines, the format YuE2 is trained on. YuE2 writes an editable score before the audio; length follows the "
      + "lyrics and the score, not max_seconds — max_seconds is a WISH there, which picks the "
      + "memory configuration and, past 360 s, raises the sampler's stop as an attempt.\n"
      + "YuE2 GGUF: optional native audio.cpp backend, Q4_0 default or optional Q8_0. Install the chosen precision explicitly; never silently substitute. Selling: the YuE2 authors say individuals may sell what it makes and companies need a commercial licence (15 Sep 2026); the weights' licence file reads CC BY-NC 4.0. "
      + "No duration wish, preview, audio reference, editable-score export or Python FP8 settings. "
      + "8 GB and 6 GB support is not established; test your hardware before relying on it.\n"
      + "Recorded in the provenance ledger as an agent action (actor agent:*) — provenance_read shows it.",
    inputSchema: {
      type: "object",
      required: ["caption"],
      properties: {
        engine: { type: "string", enum: ["minimax-music3", "yue2", "yue2-comfy", "yue2-gguf", "ace-step15"], description: "Which engine renders THIS song. ace-step15 = ACE-Step 1.5 through ComfyUI's own nodes (MIT; commercial use allowed by its authors; turbo renders in 8 steps; tempo/key/meter/language, LoRAs and covers). yue2-comfy = YuE2 3B through ComfyUI's own nodes (NVIDIA or AMD; needs a YuE2 checkpoint in models/checkpoints). Optional GGUF runs on audio.cpp (CUDA on NVIDIA, Vulkan on AMD/Intel, or CPU) and requires its native runtime and weights; use the setup tool after explicit user approval. Omit to use the Music page's choice." },
        caption: { type: "string", description: "The style description, in the engine's grammar. See above." },
        lyrics: { type: "string", description: "Optional. [Verse] / [Chorus] / [Bridge] section tags on their own lines (every engine). If you write them, write like a person: everyday words, concrete people, places and events, no forced rhymes, a plain repeating chorus, and none of the stock AI images (rooms, doors, floors, ceilings, seams, dreams, skies, neon, echoes, whispers, shadows, embers, souls, fire/desire)." },
        title: { type: "string" },
        instrumental: { type: "boolean", description: "No vocals at all. On YuE2 this is a phrasing of the style plus empty lyrics — unmeasured whether the model stays quiet — except on yue2-comfy with the instrumental planner LoRA on a loras shelf (Models screen), where the planner is patched to write a sectioned instrumental and the sheet becomes [instrumental] (its card: ended on its own 8 times out of 9). That LoRA is Mothersuperior's CC BY-NC weights, so a song made with it is labelled not for sale (list_songs add_ons names it)." },
        seed: { type: "integer", description: "For repeatability, keep the model, precision, settings and all inputs the same; identical output is not guaranteed." },
        max_seconds: { type: "integer", description: "MiniMax: a ceiling, 30-300. YuE2: a wish, 30-600; the model may finish early or run long." },
        cot: { type: "string", enum: ["full", "melody", "off"], description: "YuE2 only. full = plan the whole score then sing (default); melody = plan the tune only; off = no plan. Ignored on MiniMax." },
        precision: { type: "string", enum: ["bf16", "fp8", "q4_0", "q8_0"], description: "Python YuE2: bf16 or experimental fp8 (RTX40+). Native yue2-gguf: q4_0 (default, smaller) or q8_0 (higher precision, optional download). Higher precision does not guarantee better audio. Does not switch engines; omit for that engine's default." },
        nar_steps: { type: "integer", enum: [32, 16], description: "YuE2 synthesis steps: 32 default; 16 optional. The Python fixed-score comparison is not evidence of GGUF quality or speed." },
        allow_section_labels: { type: "boolean", description: "Forward the reviewed lyric section-tag choice to the selected YuE2 runtime; model behavior depends on that backend." },
        cfg_scale: { type: "number", minimum: 0, maximum: 20, description: "YuE2 guidance. Omit for the runtime default." },
        abc: { type: "string", maxLength: 65536, description: "Optional supplied YuE2 ABC score (at most64KiB UTF-8); needs cot full or melody. Conditions the tune, not guaranteed duration. Native GGUF does not export an editable generated score." },
        key: { type: "string", description: "YuE2 only, without abc: the song's key as an ABC key (Em, G, Bb, F#m). With bpm/meter it becomes an open seed score the planner continues, so the song is planned in it." },
        bpm: { type: "integer", minimum: 40, maximum: 240, description: "YuE2 only, without abc: quarter-note tempo for the seed score." },
        meter: { type: "string", enum: ["4/4", "3/4", "6/8", "2/4"], description: "YuE2 only, without abc: the meter for the seed score." },
        temperature: { type: "number", minimum: 0, maximum: 5, description: "YuE2 only: the performance sampler's temperature (vendor default 1.0). Lower = steadier, higher = wilder." },
        top_p: { type: "number", minimum: 0.01, maximum: 1, description: "YuE2 only: the performance sampler's nucleus (vendor default 0.95)." },
        plan_temperature: { type: "number", minimum: 0, maximum: 5, description: "YuE2 only: the score planner's temperature (vendor default 0.7) — the composer's creativity." },
        top_k: { type: "integer", minimum: 1, maximum: 32768, description: "YuE2 only: the performance sampler's top-k (vendor default 100)." },
        repetition_penalty: { type: "number", minimum: 0.01, maximum: 10, description: "YuE2 only: the performance sampler's repetition penalty (vendor default 1.2)." },
        plan_top_p: { type: "number", minimum: 0.01, maximum: 1, description: "YuE2 only: the score planner's nucleus (vendor default 0.9)." },
        abc_open: { type: "boolean", description: "YuE2 only, with abc: leave the score OPEN so the planner continues it — the bars you supply (a hummed melody from hum_to_score) become the opening rather than the whole song. Needs cot full or melody." },
        postprocess: { type: "boolean", description: "Set false to skip automatic cover art, stems, lyric timing and video postprocessing for a controlled audio comparison." },
        checkpoint: { type: "string", description: "yue2-comfy only: pin an installed YuE2 checkpoint for this request without changing the Music page selection." },
        lora: { type: "string", description: "yue2-comfy only: a LoRA filename in models/loras (list_loras with for=<the YuE2 checkpoint> says which fit). Omit to use the Music page's saved choice; \"\" for none. A name not on a loras shelf is refused, never silently skipped. Ignored on the other engines." },
        lora_strength: { type: "number", minimum: -4, maximum: 4, description: "yue2-comfy and ace-step15. 1 = as trained. Omit for the Music page's saved strength." },
        lora_clip: { type: "string", description: "yue2-comfy only: a PLANNER LoRA filename in models/loras — patches the composer (the AR half, ComfyUI's CLIP side) rather than the audio model; the catalogued instrumental planner LoRA (ar_lora_inst_v3abc_comfyui.safetensors) is the one that exists. Omit for the Music page's saved choice; \"\" for none. With `instrumental` and nothing named, the instrumental planner LoRA is used when it is on a shelf. A catalogued Mothersuperior LoRA (this one included) is CC BY-NC, so the song it makes is labelled not for sale, whatever YuE2's own label says." },
        lora_clip_strength: { type: "number", minimum: -4, maximum: 4, description: "yue2-comfy only. 1 = as trained (its card's setting). Omit for the saved strength." },
        cover_of: { type: "string", description: "COVER A REAL SONG (yue2, the Python kit, with the real-audio tokenizer installed): a library file name whose recording this performs. Send its score in `abc` as well — run song_to_score on the same file — and say the words in `lyrics` or set `instrumental`. The recording is read into YuE2's own tokens (once, kept) and the first seconds of it prime the render; the model then performs the SCORE in `caption`'s style. None of the original audio reaches the result, and the rights in the song it covers stay yours to clear." },
        cover_seconds: { type: "integer", minimum: 1, maximum: 30, description: "How many seconds of the original performance prime the render. Default 8. Longer is worse, not better: the tokenizer's codes are flatter than the model's own, so a long prime walks the sampler off its distribution and re-renders the original's arrangement under a caption asking for a different one." },
        cover_stem: { type: "string", enum: ["vocals", "drums", "bass", "other"], description: "Prime the cover from ONE layer of the original rather than its mix — its drums for the groove, its vocals for the phrasing. The score in `abc` still carries the tune." },
        language: { type: "string", description: "ace-step15 only: the lyrics' language code (en, es, fr, de, ja, ko, zh, yue, ru, bg and more; ACE-Step 1.5's list). Default en." },
        ace_steps: { type: "integer", minimum: 1, maximum: 100, description: "ace-step15 only: sampler steps. Omit for the model's template value (8 on turbo)." },
        ace_cfg: { type: "number", minimum: 0.1, maximum: 20, description: "ace-step15 only: sampler guidance. Omit for the template value (1 on turbo)." },
        planner: { type: "boolean", description: "ace-step15 only: let the language model plan the song first (generate_audio_codes). Default on; off by default with a LoRA (ACE-Step's LoRA card advises the DiT alone) and always off for a cover." },
        cover_song: { type: "string", description: "ace-step15 only: a Library file name (list_songs) to cover — ACE-Step re-performs it in this caption and lyrics (ComfyUI's Set Reference Audio, experimental there)." },
        confirm_spend: { type: "boolean", description: "PAID SONGS ONLY. With the hosted engine switched on (cloud_status), a MiniMax Music 3 song bills the person's own key and is refused until this is true; the refusal says what it would cost and which key it bills. Pass true ONLY after the person agreed to pay for THIS song in the conversation, never on your own. Ignored for local engines." },
      },
      additionalProperties: false,
    },
    async run(a) {
      if (!a.caption?.trim()) throw new Error("A caption is required.");
      const r = await api("POST", "/api/generate", {
        caption: a.caption, lyrics: a.lyrics || "", title: a.title,
        instrumental: !!a.instrumental,
        seed: Number.isFinite(a.seed) ? a.seed : undefined,
        maxDuration: Number.isFinite(a.max_seconds) ? a.max_seconds : undefined,
        /* The YuE2 fields. /api/generate validates each and ignores them all on
         * MiniMax, so passing them unconditionally is safe. */
        cot: a.cot, quantization: a.precision === "bf16" ? "none" : a.precision,
        narSteps: a.nar_steps,
        allowSectionLabels: a.allow_section_labels,
        cfgScale: a.cfg_scale,
        abc: a.abc,
        abcOpen: a.abc_open === true ? true : undefined,   // absent unless asked: the GGUF door refuses unknown fields
        /* The same rule for the seed and the dials: absent unless asked. */
        key: typeof a.key === "string" && a.key ? a.key : undefined,
        bpm: Number.isFinite(a.bpm) ? a.bpm : undefined,
        meter: typeof a.meter === "string" && a.meter ? a.meter : undefined,
        temperature: Number.isFinite(a.temperature) ? a.temperature : undefined,
        topP: Number.isFinite(a.top_p) ? a.top_p : undefined,
        topK: Number.isFinite(a.top_k) ? a.top_k : undefined,
        repetitionPenalty: Number.isFinite(a.repetition_penalty) ? a.repetition_penalty : undefined,
        planTopP: Number.isFinite(a.plan_top_p) ? a.plan_top_p : undefined,
        planTemperature: Number.isFinite(a.plan_temperature) ? a.plan_temperature : undefined,
        engine: a.engine,
        checkpoint: typeof a.checkpoint === "string" ? safeName(a.checkpoint, "checkpoint") : undefined,
        postprocess: typeof a.postprocess === "boolean" ? a.postprocess : undefined,
        /* "" is an explicit none; undefined lets the route use the saved choice. */
        lora: typeof a.lora === "string" ? (a.lora ? safeName(a.lora, "LoRA") : "") : undefined,
        loraStrength: Number.isFinite(a.lora_strength) ? a.lora_strength : undefined,
        loraClip: typeof a.lora_clip === "string" ? (a.lora_clip ? safeName(a.lora_clip, "LoRA") : "") : undefined,
        ...(typeof a.cover_of === "string" && a.cover_of
          ? { coverOf: { file: safeName(a.cover_of, "song"),
                         ...(Number.isFinite(a.cover_seconds) ? { seconds: a.cover_seconds } : {}),
                         ...(typeof a.cover_stem === "string" ? { stem: a.cover_stem } : {}) } }
          : {}),
        loraClipStrength: Number.isFinite(a.lora_clip_strength) ? a.lora_clip_strength : undefined,
        /* ACE-Step's own; ignored on the other engines. key/bpm/meter above
         * reach it too, translated by the route. */
        language: typeof a.language === "string" && a.language ? a.language : undefined,
        aceSteps: Number.isFinite(a.ace_steps) ? a.ace_steps : undefined,
        aceCfg: Number.isFinite(a.ace_cfg) ? a.ace_cfg : undefined,
        aceCodes: typeof a.planner === "boolean" ? a.planner : undefined,
        aceCover: typeof a.cover_song === "string" && a.cover_song ? { song: safeName(a.cover_song, "song") } : undefined,
        /* Exactly true or absent: the door reads confirmSpend === true and nothing looser. */
        confirmSpend: a.confirm_spend === true ? true : undefined,
      });
      /* /api/generate refuses with its own sentence (fp8 on an older card, a preview that does not exist); relay it whole
       * rather than answering "job_id: null" and leaving the agent to guess. */
      if (r?.error) throw new Error(r.error);
      const st = await api("GET", "/api/status");
      const mine = r.job;
      if (!mine?.id) throw new Error("Studio returned no exact song job id; check the queue before retrying.");
      return {
        job_id: mine?.id ?? r.job?.id ?? null,
        /* Which engine took the song, and — on YuE2 — the configuration the
         * ladder chose for the wanted length, so the agent can say so. */
        engine: r.engine ?? mine?.engine ?? null,
        precision: mine?.quantization ?? r.job?.quantization ?? null,
        ...(r.rung ? { configuration: r.rung.label, ceiling: r.ceiling ?? null } : {}),
        title: mine?.title ?? null,
        position_in_queue: st.current?.id === mine.id ? 0 : (st.queue || []).findIndex(j => j.id === mine.id) + 1 || null,
        note: "Rendering. Call wait_for_song with this job_id.",
      };
    },
  },

  {
    name: "wait_for_song",
    description:
      "Block until a song finishes, then return its file name. Safe to call again if it "
      + "times out — nothing is cancelled and the render keeps going. seconds is measured audio length "
      + "(null if unknown); render_seconds is elapsed generation time, not song length. "
      + "Read warnings before presenting the take as complete: a possible limit warning is an inference, "
      + "not confirmed truncation. No warning does not certify lyric coverage or audio quality.",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: {
        job_id: { type: "string" },
        timeout_seconds: { type: "integer", description: "Default 900. A polling budget, not a render-time prediction." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const done = await waitForSong(String(a.job_id), (Number(a.timeout_seconds) || 900) * 1000);
      return { file: done.file, title: done.title, engine: done.engine ?? null,
        precision: done.quantization ?? null,
        seconds: Number.isFinite(done.audioSeconds) && done.audioSeconds > 0 ? done.audioSeconds : null,
        render_seconds: Number.isFinite(done.durationSeconds) && done.durationSeconds >= 0 ? done.durationSeconds : null,
        seed: done.seed,
        warnings: Array.isArray(done.warnings) ? done.warnings : [],
        generation_limits: done.generationLimits ?? null,
        ...(done.replacement ? { raw_file: done.rawFile, replacement: done.replacement } : {}) };
    },
  },


  {
    name: "get_beats",
    description:
      "The measured beat grid and per-band loudness of a finished track: tempo, beat and bar "
      + "times, and how loud bass/low/mid/high are over time. This is what makes cutting on "
      + "the beat a calculation rather than a guess. Cached, so the second call is instant.\n\n"
      + "⚠ Tempo detection has to choose between a beat and its octave. On half-time material "
      + "it usually picks the fast one — check `bpm` against what you would tap, and pass "
      + "beat_mult 0.5 to build_music_video if it is doubled.",
    inputSchema: {
      type: "object",
      required: ["song"],
      properties: {
        song: { type: "string", description: "A file name from list_songs." },
        include_envelopes: { type: "boolean", description: "Include the full 30fps band arrays. Large — off by default." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const song = safeName(a.song, "song");
      const d = await api("GET", `/api/beats/${encodeURIComponent(song)}`, undefined, 180_000);
      if (d.error) throw new Error(d.error);
      const out = {
        bpm: d.bpm, confidence: d.confidence, duration: d.duration,
        beat_count: d.beats.length, bar_count: d.bars.length,
        first_bars: d.bars.slice(0, 12),
        beat_interval_seconds: d.beats.length > 1 ? Number((d.beats[1] - d.beats[0]).toFixed(3)) : null,
      };
      if (a.include_envelopes) {
        out.env_fps = d.envFps;
        out.bands = d.bands;
      } else {
        // A summary beats a 140 KB array for deciding which band to drive from.
        out.band_levels = Object.fromEntries(Object.entries(d.bands || {}).map(([k, v]) => {
          const mean = v.reduce((x, y) => x + y, 0) / (v.length || 1);
          return [k, { mean: Number(mean.toFixed(3)), max: Number(Math.max(...v).toFixed(3)) }];
        }));
      }
      return out;
    },
  },

  {
    name: "image_adjust",
    description: "Professional adjustments on a library image, rendered server-side into a NEW file (the original is never touched). All optional: brightness/contrast/saturation 0-200 (100 = unchanged), gamma 0.2-3 (1 = unchanged), temperature -100..100 (cold..warm), sharpen 0-100, blur 0-20 px, vignette 0-100, rotate 0|90|180|270, flip_h/flip_v. Returns the new image name, plus `notes` (compromises a stage reported) and `fxSkipped` (effects that needed a timeline and did nothing on this still) when there are any. Recorded in the provenance ledger as an agent action (actor agent:*) — provenance_read shows it.",
    inputSchema: {
      type: "object", required: ["name"],
      properties: {
        name: { type: "string", description: "Image filename from list_images" },
        brightness: { type: "number" }, contrast: { type: "number" }, saturation: { type: "number" },
        gamma: { type: "number" }, temperature: { type: "number" }, sharpen: { type: "number" },
        blur: { type: "number" }, vignette: { type: "number" },
        photo: {
          type: "array",
          description:
            "Photo-grade tonal work — the Lightroom half, applied in order before the "
            + "effects: dehaze (dark-channel prior; negative re-adds haze by the depth it "
            + "estimated), highlightRecovery (rebuilds a channel clipped in one or two "
            + "channels — it does NOTHING where all three are clipped, and says so), "
            + "clarity (midtone local contrast), texture (a genuine band-pass, not clarity "
            + "with different defaults), whiteBalance (Bradford adaptation from a picked "
            + "neutral pixel), splitTone (independent shadow and highlight hues).\n"
            + "Each entry is { type, params }. autoStraighten and autoTone MEASURE rather "
            + "than edit — use image_measure for those.",
          items: {
            type: "object", required: ["type"],
            properties: { type: { type: "string" }, params: { type: "object", additionalProperties: true } },
          },
        },
        paths: {
          type: "array",
          description:
            "Bezier paths — the pen tool. Each is a path (SVG `d`, or explicit anchors with "
            + "in/out tangents), stroked, filled, or both, with caps, joins and dashes. "
            + "`boolean` unions, subtracts or intersects operands BEFORE a pixel exists, so "
            + "a subtracted overlap is genuinely empty rather than half-covered on the soft "
            + "edge — which is why a pen path makes a precise cutout.\n"
            + "Call image_tools_catalog module=paths for every parameter.",
          items: { type: "object", additionalProperties: true },
        },
        liquify: {
          type: "array",
          description:
            "Push, bloat, pucker and twirl, driven by a stroke path exactly as `strokes` is. "
            + "Every dab across every stroke COMPOSES into one displacement field and the "
            + "image is sampled once from the original — so eight strokes cost one "
            + "interpolation, not eight, and the picture does not soften with each pass.\n"
            + "Pass `freeze` (a selection, same shape as `selection`) to protect a region: "
            + "frozen pixels come back bit-identical.",
          items: { type: "object", additionalProperties: true },
        },
        freeze: {
          type: "object", additionalProperties: true,
          description: "A selection protecting a region from `liquify`. Same shape as `selection`.",
        },
        selection: {
          type: "object",
          description:
            "Restrict EVERY adjustment, effect and stroke in this call to part of the image. "
            + "This is the difference between a filter and an editor.\n"
            + "`shapes` is a list combined in order, each with a `mode` of add (default), "
            + "subtract or intersect: { kind: 'rect', x, y, w, h }, "
            + "{ kind: 'ellipse', cx, cy, rx, ry }, { kind: 'polygon', points: [[x,y]] } "
            + "(a lasso), { kind: 'wand', x, y, tolerance, contiguous } (flood by colour "
            + "from a seed pixel), { kind: 'colorRange', color: [r,g,b], tolerance, softness } "
            + "(every similar pixel in the frame), { kind: 'channel', channel: "
            + "'r'|'g'|'b'|'a'|'luminosity' } (the plane AS the mask — Photoshop's "
            + "ctrl-click on a channel), { kind: 'path', paths: ... } (a pen path as a "
            + "selection, rasterised by the same coverage its fill uses — "
            + "image_tools_catalog module=paths for the geometry).\n"
            + "Then `feather` (px), `expand` (px, negative contracts), `invert`, `antialias`.\n"
            + "Coordinates are pixels AFTER any crop/rotate/flip in the same call. Omit the "
            + "key entirely for the whole image — an EMPTY `shapes` list means a selection "
            + "that selects nothing, which is not the same thing.",
          additionalProperties: true,
        },
        strokes: {
          type: "array",
          description:
            "Brush-class tools, applied in order. You send a PATH in image pixels and the "
            + "server rasterises it, so an agent and a person painting the same stroke get "
            + "identical pixels.\n"
            + "tool: brush | eraser | clone | heal | smudge | blur | sharpen | dodge | burn "
            + "| sponge | bucket | gradient. `points` is [[x, y, pressure?]] — smudge and "
            + "gradient need two, the rest need at least one; clone and heal need `source` "
            + "[x, y], the offset being fixed at the stroke's first point.\n"
            + "size, hardness, opacity, flow, spacing, color [r,g,b,a] 0-255. FLOW "
            + "accumulates within one stroke while OPACITY caps it — two passes of a 50% "
            + "flow brush are darker than one, two at 50% opacity are not.\n"
            + "Stamped tools also take `path` INSTEAD of points — a pen path (anchors/"
            + "points/SVG d), flattened by imgpath and stroked with the brush: "
            + "Photoshop's stroke-path-with-brush. Points win when both are given.\n"
            + "Call image_tools_catalog for every parameter each tool takes.",
          items: { type: "object", additionalProperties: true },
        },
        effects: {
          type: "array",
          description:
            "The compositor's effect registry, applied to this image in order — 93 effects "
            + "in twelve groups (Blur & Sharpen, Color, Distort, Generate, Keying, Matte, Simulation, "
            + "Noise & Grain, Stylize, Time, Transition, Expression Controls), the SAME "
            + "implementations the VFX tab renders with. Each entry is { type, params }. Call "
            + "image_effects_catalog for the names, ranges and defaults — a guessed name "
            + "is refused, and a guessed RANGE is accepted and renders wrong. Four of "
            + "them (echo, timeDifference, posterizeTime, particleSystem) need a timeline "
            + "and return the image untouched on a still — the reply's fxSkipped names "
            + "them — and the Expression Controls are pixel no-ops everywhere.",
          items: {
            type: "object", required: ["type"],
            properties: { type: { type: "string" }, params: { type: "object", additionalProperties: true } },
          },
        },
        rotate: { type: "integer", enum: [0, 90, 180, 270],
          description: "Quarter turns, the quick path. For any other angle use `geometry.rotate`, which takes degrees and can grow the canvas to fit." },
        flip_h: { type: "boolean" }, flip_v: { type: "boolean" },

        /* ⚠ THESE THREE WERE READ BY THE PIPELINE AND REFUSED BY THIS SCHEMA.
         * `additionalProperties: false` sits at the end of this object, so
         * eleven working, tested operations — live in the browser the whole
         * time — could not be called over MCP at all. image_measure's own
         * description even told callers to send `geometry.rotate`, which this
         * schema then rejected. */
        canvas: {
          type: "object",
          description: "THE SHEET, before anything is drawn on it — stage 1, so everything else happens inside the result. "
            + "`canvasSize` {width, height, anchor, background} grows or crops the sheet around the picture without "
            + "rescaling it: a square render becomes a 9:16 story frame or a 3:4 poster with the picture anchored where "
            + "you want it. `trim` {trim: true, tolerance} cuts the empty margin off — the thing to run on a cutout "
            + "before compositing it.",
          /* ⚠ FLAT, NOT NESTED, and checked against imgshape.apply_canvas rather
           * than against the catalog's note about it. The note says "canvasSize
           * and trim are fields of ops.canvas", which reads as two sub-objects
           * and is not: those are the CATALOG ENTRIES whose params land here
           * side by side. Sending {canvasSize:{...}} is accepted and ignored
           * with a note in the reply — measured, not assumed. */
          properties: {
            width: { type: "integer", description: "the new frame width in px (1-30000)" },
            height: { type: "integer", description: "the new frame height in px" },
            anchor: { type: "string", description: "where the existing picture sits in the new sheet: topleft, top, topright, left, center, right, bottomleft, bottom, bottomright" },
            background: { type: "array", items: { type: "integer" }, description: "RGBA 0-255 for the new margin; a 3-element colour gets alpha 255" },
            trim: { type: "string", enum: ["none", "transparent", "borders"],
              description: "cut the empty margin off FIRST, before any new frame is added. `transparent` for a cutout, `borders` for a flat colour edge." },
            tolerance: { type: "number", description: "how far off the border colour still counts as border, per channel, 0-255" },
          },
        },
        geometry: {
          type: "object",
          description: "MOVING THE WHOLE PICTURE — stage 3. `rotate` in DEGREES (any angle, with `expand` to grow the "
            + "canvas so nothing is cut off) is the one image_measure's autoStraighten angle is meant for. `flipH`/`flipV` "
            + "mirror. `perspective` takes four corner points and maps the picture onto them — a poster onto a wall, a "
            + "screen onto a monitor. `smartResize` is seam carving: it changes the aspect ratio by removing the least "
            + "interesting columns rather than squashing everybody in the frame.",
          properties: {
            rotate: { type: "number", description: "degrees, any angle" },
            expand: { type: "boolean", description: "grow the canvas so a rotation loses no corners" },
            flipH: { type: "boolean" }, flipV: { type: "boolean" },
            perspective: { type: "array", description: "four [x,y] corner points to map the picture onto" },
            fit: { type: "string" },
            interpolation: { type: "string" },
            width: { type: "integer", description: "smartResize target" },
            height: { type: "integer", description: "smartResize target" },
            seamsPerPass: { type: "integer" },
            maxCarve: { type: "number" },
          },
        },
        shapes: {
          type: "array",
          description: "VECTOR SHAPES DRAWN ONTO THE PICTURE — stage 8, so they land on top of the adjustments. A LIST, "
            + "each entry {kind, ...}. Kinds: rect (with `radius` for rounded corners), ellipse, polygon, line, arrow. "
            + "All take `points` in image pixels, `fill` and/or `stroke` as RGBA 0-255, `strokeWidth`, and a `blend` mode. "
            + "This is how a callout lands on a storyboard frame, a box goes behind a title, or an arrow marks a "
            + "character sheet — without leaving the studio for another program. Call image_tools_catalog for each "
            + "kind's full parameter list and ranges.",
          items: { type: "object", required: ["kind"],
            properties: { kind: { type: "string", enum: ["rect", "ellipse", "polygon", "line", "arrow"] } },
            additionalProperties: true },
        },
        crop: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" },
          w: { type: "integer" }, h: { type: "integer" } },
          description: "Crop rectangle in source pixels, applied before everything else" },
        levels: { type: "object", description: "Levels — where black starts, where white clips, and the midtone between. Keys master/r/g/b, each {black 0-255, white 0-255, gamma 0.05-9.99, outBlack, outWhite}. Applied BEFORE curves, the way a darkroom pass runs before a tone curve.",
          properties: { master: { type: "object" }, r: { type: "object" }, g: { type: "object" }, b: { type: "object" } } },
        curves: { type: "object", description: "Tone curves, the professional tool: control points [x,y] 0-255 mapped input->output with monotone cubic interpolation. Keys: master (all channels), r, g, b. Example S-curve: {master: [[0,0],[64,44],[192,214],[255,255]]}.",
          properties: { master: { type: "array" }, r: { type: "array" }, g: { type: "array" }, b: { type: "array" } } },
        auto_levels: { type: "boolean", description: "Per-channel percentile stretch (0.3%-99.7%) before curves — the one-click contrast fix" },
        shadows: { type: "number", description: "-100..100 — lift (or crush) the darks, luminance-masked like the Shadows/Highlights tool" },
        highlights: { type: "number", description: "-100..100 — recover (negative) or push blown lights" },
        hsl: { type: "object", description: "Per-color-band HSL, the panel photographers live in. Keys: reds/yellows/greens/cyans/blues/magentas, each {h: -180..180 hue shift, s: -100..100, l: -100..100}. Example: {blues:{h:-12,s:30}}.",
          properties: { reds: { type: "object" }, yellows: { type: "object" }, greens: { type: "object" },
            cyans: { type: "object" }, blues: { type: "object" }, magentas: { type: "object" } } },
        grayscale: { type: "boolean" }, sepia: { type: "boolean" }, invert: { type: "boolean" },
        channel: { type: "string", enum: ["r", "g", "b", "a", "luminosity"],
          description: "Extract ONE plane of the RESULT as a grayscale image — the Channels panel's view, rendered. Runs after every other op (so it reads what the edit produced) and before resize. 'a' is the alpha matte; 'luminosity' is the Rec.601 composite." },
        posterize: { type: "integer", description: "2-8 levels; 0/absent = off" },
        denoise: { type: "number", description: "0-100 — non-local-means noise reduction" },
        grain: { type: "number", description: "0-100 — film grain, seeded (grain_seed) so it reproduces" },
        grain_seed: { type: "integer" },
        text: { type: "object", description: "The type tool — rendered last, on top. Simple form: {content, x, y (px; defaults center), size (px), color [r,g,b], font (filename from list_fonts, e.g. georgia.ttf), align left|center|right, stroke (px outline), strokeColor [r,g,b]}. FULL form: pass _v2: true and the complete spec image_tools_catalog module=text describes — box/anchor/valign, lineHeight (leading), tracking, wordSpacing, justify, overflow/shrink, rotate/skew, fill (solid/gradient/image), outline, shadow, glow, text-on-a-path.",
          properties: { content: { type: "string" }, x: { type: "integer" }, y: { type: "integer" },
            size: { type: "integer" }, color: { type: "array" }, font: { type: "string" },
            align: { type: "string" }, stroke: { type: "integer" }, strokeColor: { type: "array" } } },
        resize: { type: "object", properties: { w: { type: "integer" }, h: { type: "integer" } },
          description: "Exact output size, applied last (LANCZOS)" },
        chroma_key: { type: "object", properties: {
          color: { type: "array", items: { type: "integer" }, description: "[r,g,b] 0-255 — the screen color to key out" },
          tolerance: { type: "number", description: "0-100, how far from the key color still counts (default 25)" },
          softness: { type: "number", description: "0-100, feather band width at the edge (default 10)" } },
          description: "Greenscreen keying: the key color becomes transparency, with despill on the edges. Output keeps alpha." },
        styles: {
          type: "object", additionalProperties: true,
          description:
            "PHOTOSHOP'S TEN LAYER STYLES \u2014 dropShadow, innerShadow, outerGlow, innerGlow, "
            + "bevelEmboss, satin, colorOverlay, gradientOverlay, patternOverlay, stroke. Painted at "
            + "stage 9b, AFTER the selection blend, because a style paints OUTSIDE the shape it "
            + "decorates and the blend would clip the shadow away.\n\n"
            + "\u26a0 A STYLE NEEDS A SHAPE AND A PHOTOGRAPH HAS NONE. A flat picture is opaque in "
            + "every pixel, so each style either paints the whole frame or does nothing \u2014 measured "
            + "at defaults, three of the ten changed nothing and the other seven changed every pixel. "
            + "So give it one: `selection` (the same spec `selection` above takes) on a photograph, or "
            + "`useAlpha: true` on a cutout. Pass NEITHER and the call is refused in a sentence rather "
            + "than rendering a control that appears to work. Pass BOTH and it is also refused \u2014 a "
            + "style has one shape, and silently preferring either is how a cutout comes back styled "
            + "against the wrong edge.\n\n"
            + "`styles` inside is a list of { style, ...params } or an object keyed by style name. "
            + "They are painted in Photoshop's stacking order whatever order you send them in \u2014 a "
            + "drop shadow under a stroke looks different from a stroke under a drop shadow. "
            + "`globalLight` ties dropShadow, innerShadow and bevelEmboss to one angle. Call "
            + "image_styles_catalog for every parameter and its range.",
        },
        clear: { type: "boolean",
          description:
            "Clear to TRANSPARENCY \u2014 what Delete does in a paint program. With `selection` set it "
            + "empties that region and a feathered edge comes back as a soft alpha ramp; with no "
            + "selection it empties the whole frame. Runs BEFORE the brush class, so `strokes` sent in "
            + "the same call paint onto the cleared area rather than being wiped by it. The result is a "
            + "PNG with real alpha, not white \u2014 composite it over something to see the difference." },
        save_selection: { type: "boolean",
          description: "Also write the resolved `selection` out as a grayscale matte picture, filed in the library beside the edit \u2014 the step imgdoc's mask.src refusal tells you to take. Worth it for `wand` and `colorRange`, whose result is computed from pixels and cannot be written down: without this the matte you tuned lives for one call. The reply gains `mask: {name, coverage}`. With no selection the matte is solid white, which is the honest picture of \"the whole frame\"." },
      },
      additionalProperties: false,
    },
    async run(a) {
      /* \u26a0 save_selection MUST COME OUT WITH THE OTHER RENAMED KEYS. Whatever
       * is left after this destructure is spread into `ops`, and the pipeline
       * drops keys it does not know \u2014 so a saveSelection riding inside ops
       * would reach the engine, be ignored, and report success with no matte. */
      const { name, flip_h, flip_v, chroma_key, auto_levels, grain_seed, save_selection, ...ops } = a;
      const r = await api("POST", "/api/images/edit", { name: safeName(name, "image"),
        saveSelection: save_selection === true,
        ops: { ...ops, flipH: flip_h, flipV: flip_v, chromaKey: chroma_key,
               autoLevels: auto_levels, grainSeed: grain_seed } });
      if (r.error) throw new Error(r.error);
      // notes / fxSkipped are the engine's honesty channels — a compromise a
      // stage reported, and the timeline effects that did nothing on a still.
      return { image: r.name, url: `/api/image/${r.name}`,
               mask: r.mask, notes: r.notes, fxSkipped: r.fxSkipped };
    },
  },
  {
    name: "replace_section",
    description:
      "Replace a stretch of a finished song: the model continues from from_seconds exactly as extend_song "
      + "would, and the original comes back at to_seconds, crossfaded at both seams. Both engines — and, with "
      + "the YuE2 real-audio tokenizer installed and YuE2 3B as the music model, ANY RECORDING too, not only a "
      + "take: it is read into YuE2's own tokens first and those are what the model continues from. The "
      + "result is a new library file (replace_<ms>_<id>.flac) — a mix, so it cannot itself be extended; the "
      + "original is untouched. Give the WHOLE lyric sheet in `lyrics` if the new stretch should say "
      + "something else. The new material is asked for at the length of the "
      + "gap plus a little; if it comes back shorter the original returns early. wait_for_song returns "
      + "the composed filename, measured shortfall and effective seam. Returns a job id; follow with wait_for_song.",
    inputSchema: {
      type: "object",
      required: ["file", "from_seconds", "to_seconds"],
      properties: {
        file: { type: "string", description: "The library file name (from list_songs)." },
        from_seconds: { type: "number", description: "Where the new material starts." },
        to_seconds: { type: "number", description: "Where the original comes back. Must be inside the take and past from_seconds." },
        lyrics: { type: "string", description: "The whole sheet, if the words change." },
        abc: { type: "string", maxLength: 65536, description: "YuE2 only: a longer two-voice score to continue under." },
        caption: { type: "string", description: "Style override; the take's own by default." },
        seed: { type: "integer" },
      },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/replace", {
        file: safeName(a.file, "song"),
        fromSeconds: a.from_seconds, toSeconds: a.to_seconds,
        lyrics: typeof a.lyrics === "string" ? a.lyrics : undefined,
        abc: typeof a.abc === "string" ? a.abc : undefined,
        caption: typeof a.caption === "string" ? a.caption : undefined,
        seed: Number.isFinite(a.seed) ? a.seed : undefined,
      });
      if (r?.error) throw new Error(r.error);
      if (!r?.job?.id) throw new Error("Studio returned no exact replacement job id; check the queue before retrying.");
      return { job_id: r.job.id, engine: r?.engine ?? "minimax-music3",
               note: "wait_for_song waits for composition and returns the actual candidate filename. The original remains. A short take moves the ending earlier; inspect its warnings and effectiveTo." };
    },
  },

  {
    name: "song_to_score",
    description:
      "Turn a FINISHED SONG into the two-voice ABC score YuE2 sings from — the cover recipe. SheetSage2, "
      + "run as ComfyUI's own audio-encoder node, transcribes the recording (mode melody: the tune alone, "
      + "recommended for covers; full: chords too). Then make_song with engine yue2 (or yue2-comfy), cot "
      + "melody, `abc` = that score, NEW lyrics if you like, and a NEW style line — 'male lead vocal' "
      + "where the original had a woman — and the melody is kept while everything else is re-rendered. "
      + "Pass the recording as source {path | library_file | data_url}, or just `library_file` for a song in the library. Needs the catalogue's "
      + "'Cover — SheetSage2 song-to-score' row installed (a 1.4 GB file); refused with needsModel "
      + "otherwise. Holds the card for the transcription. For a single hummed voice use hum_to_score, "
      + "which needs no model. The original song's rights are the caller's to check.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "object", additionalProperties: true,
          description: "{ path: absolute local file } | { library_file: a name in the library } | { data_url: base64 audio, name? }" },
        library_file: { type: "string", description: "A song in the library (list_songs), the same as source {library_file}. Give this or source." },
        mode: { type: "string", enum: ["melody", "full"], description: "melody (default, for covers) or full (melody and chords)." },
        stem: { type: "string", enum: ["mix", "vocals"],
          description: "vocals: transcribe the SEPARATED VOICE instead of the mix (library_file sources only) — the Studio's own demucs separation runs first when it is not on disk, about a minute. On a mix the transcriber can file the tune under the accompaniment; the stem gives it the melody that was sung. Default mix." },
      },
      additionalProperties: false,
    },
    async run(a) {
      if (a.source === undefined && !a.library_file) throw new Error("Give source {path | library_file | data_url}, or library_file.");
      const r = await api("POST", "/api/song_to_score", { source: a.source ?? (a.library_file ? { library_file: safeName(a.library_file, "song") } : undefined), mode: a.mode, stem: a.stem === "vocals" ? "vocals" : undefined });
      if (r?.error) throw new Error(refusalText(r));
      return r;
    },
  },

  {
    name: "hum_to_score",
    description:
      "Turn a hummed (or whistled, or sung) melody into the two-voice ABC score YuE2 takes verbatim: "
      + "a pitch tracker in the engine's own python, no model, no card. Pass the recording as source "
      + "{path | library_file | data_url} — the three shapes music_input_prepare takes — or just "
      + "`library_file` for a song in the library; an agent cannot record, so name a file. One to sixty seconds, one voice, nothing behind it. Returns `abc` plus "
      + "the tempo, key, note and bar counts. Then make_song with engine yue2 (or yue2-comfy), cot "
      + "melody or full, `abc` = that score, and either `abc_open: true` — the planner continues the "
      + "hummed bars into a whole song — or omit it to sing exactly those bars. Tempo and key are "
      + "estimated from the recording and can be overridden.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "object", additionalProperties: true,
          description: "{ path: absolute local file } | { library_file: a name in the library } | { data_url: base64 audio, name? }" },
        library_file: { type: "string", description: "A song in the library (list_songs), the same as source {library_file}. Give this or source." },
        bpm: { type: "number", minimum: 40, maximum: 240, description: "Quarter-note tempo to quantise to; omit to beat-track the recording (falls back to 100)." },
        key: { type: "string", description: "ABC key such as Em, G, Bb; omit to estimate it." },
      },
      additionalProperties: false,
    },
    async run(a) {
      if (a.source === undefined && !a.library_file) throw new Error("Give source {path | library_file | data_url}, or library_file.");
      const r = await api("POST", "/api/hum", { source: a.source ?? (a.library_file ? { library_file: safeName(a.library_file, "song") } : undefined), bpm: a.bpm, key: a.key });
      if (r?.error) throw new Error(refusalText(r));
      return r;
    },
  },

  {
    name: "sounds_like",
    description:
      "WHICH OF MY SONGS SOUND LIKE THIS ONE — ranked, over YuE2's own tokens, with no card and no tagging. Every "
      + "YuE2 take keeps the semantic codes it was written from, and any recording that has been read through the "
      + "real-audio tokenizer keeps them too; the signature is how often each of the 32,768 codes is used. ⚠ It "
      + "answers \"the same kind of sound\" — instrumentation, texture, register, production — and NOT \"the same "
      + "tune\": the order of the codes is thrown away, so a cover in another arrangement scores low and two songs "
      + "from one session score high. A recording that has never been read is read first (that costs about half a "
      + "minute per minute of song on the processor); pass tokenize false to refuse instead. Answers `matches` with "
      + "a similarity from 0 to 1, what each one is (a take or a recording), and how many were compared.",
    inputSchema: {
      type: "object",
      required: ["file"],
      properties: {
        file: { type: "string", description: "The library file to compare everything against (from list_songs)." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "How many matches to return. Default 10." },
        tokenize: { type: "boolean", description: "false refuses rather than reading an unread recording first. Default true." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/sounds_like", {
        file: safeName(a.file, "song"),
        limit: Number.isFinite(a.limit) ? a.limit : undefined,
        tokenize: a.tokenize === false ? false : undefined,
      });
      if (r?.error) throw new Error(r.error + (r.missing?.length ? ` Missing: ${r.missing.join(", ")}` : ""));
      return r;
    },
  },
  {
    name: "tokenize_track",
    description:
      "READ A RECORDING INTO YuE2'S OWN TOKENS, and nothing else. The YuE2 real-audio tokenizer "
      + "(Models screen: Mothersuperior's head over m-a-p's MERT-v2-FullSong, CC BY-NC 4.0) turns any "
      + "library track into the semantic codes YuE2 continues from — 25 a second; by its author 16 % "
      + "exact on YuE2's own songs and round trips near 95 % by ear, so the codes are the song as YuE2 "
      + "would have written it, not a copy. The codes are kept by the decoded audio's fingerprint under "
      + "output/yue2/tok_<id>/, where extend_song looks, so an Extend that follows starts at once. "
      + "Runs on the card, or on the CPU while the card has a render in flight (about 30 s of song in 16 s); "
      + "`device` cpu forces the CPU. Answers frames, seconds, device, cached and the timings. Refuses "
      + "with reason tokenizer-missing (and the files) when the tokenizer is not on disk.",
    inputSchema: {
      type: "object",
      required: ["file"],
      properties: {
        file: { type: "string", description: "The library file name (from list_songs)." },
        device: { type: "string", enum: ["auto", "cpu"], description: "auto (default): the card unless a render is in flight. cpu: always the CPU." },
        stem: { type: "string", enum: ["vocals", "drums", "bass", "other"], description: "One layer of the recording instead of its mix: vocals, drums, bass or other. The Studio separates it (demucs, all four at once, so a second stem later is free) and reads THAT into tokens — the drums alone give a groove to build on, the vocals alone a voice to arrange under. Omitted, the mix is read." },
        force: { type: "boolean", description: "Read the track again even when its codes are already kept." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/tokenize", {
        file: safeName(a.file, "song"),
        device: a.device === "cpu" ? "cpu" : undefined,
        stem: typeof a.stem === "string" ? a.stem : undefined,
        force: a.force === true ? true : undefined,
      });
      if (r?.error) throw new Error(r.error + (r.missing?.length ? ` Missing: ${r.missing.join(", ")}` : ""));
      return r;
    },
  },
  {
    name: "extend_song",
    description:
      "Continue a finished song from a point inside it. MiniMax replays the take's saved trajectory "
      + "and generates on; YuE2 replays the take's own semantic tokens behind the words and its "
      + "score and generates on, then the acoustic model re-renders the whole sequence. Either way "
      + "the original file is kept bit-identical up to the seam and the new material is crossfaded "
      + "on, as a new library file (extend_<ms>.flac, list_songs). Returns a job id; follow with "
      + "wait_for_song.\n\n"
      + "YuE2: send the WHOLE lyric sheet in `lyrics` — the old words, then the new ones, no "
      + "[section] labels (the model sings them; the server refuses them). Optionally `abc`: a "
      + "longer two-voice score (the take's own, with bars appended) — without it the take's own "
      + "score is reused and the sampler still owes at least ~8 s. MiniMax: `lyrics` may carry "
      + "[Verse]/[Chorus] tags; omitted, the server appends continuation sections. "
      + "from_seconds defaults to 80% of the take: resuming at the very end leaves the model where "
      + "it chose to stop, and it stops again.\n\n"
      + "ANY OTHER RECORDING (an import, a take with no saved performance): with the YuE2 real-audio "
      + "tokenizer on this machine (Models screen, CC BY-NC) and YuE2 3B as the music model, the track "
      + "is read into YuE2's own codes first (once, kept by its bytes; CPU while the card is busy) and "
      + "continued with no score — `caption` is REQUIRED there, `lyrics` optional (none = instrumental), "
      + "`abc` optional (then cot melody). The reply's `tokenized` says how many codes and where it ran. "
      + "Without the tokenizer the answer is reason tokenizer-missing.",
    inputSchema: {
      type: "object",
      required: ["file"],
      properties: {
        file: { type: "string", description: "The library file name (from list_songs). YuE2 takes are aiplay_yue2_<id>.flac." },
        from_seconds: { type: "number", description: "Where the replay stops and new material begins. Default 80% of the take." },
        lyrics: { type: "string", description: "The whole sheet, old then new, with its section tags." },
        abc: { type: "string", maxLength: 65536, description: "YuE2 only: a longer two-voice ABC score to continue under." },
        seconds: { type: "integer", description: "How much new material to ask for (8-300, default 45). A wish on YuE2, a ceiling on MiniMax." },
        caption: { type: "string", description: "Style override; the take's own by default." },
        stem: { type: "string", enum: ["vocals", "drums", "bass", "other"], description: "Recordings only (a take has its own performance already). " + "One layer of the recording instead of its mix: vocals, drums, bass or other. The Studio separates it (demucs, all four at once, so a second stem later is free) and reads THAT into tokens — the drums alone give a groove to build on, the vocals alone a voice to arrange under. Omitted, the mix is read." },
        seed: { type: "integer" },
      },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/extend", {
        file: safeName(a.file, "song"),
        fromSeconds: Number.isFinite(a.from_seconds) ? a.from_seconds : undefined,
        lyrics: typeof a.lyrics === "string" ? a.lyrics : undefined,
        abc: typeof a.abc === "string" ? a.abc : undefined,
        seconds: Number.isFinite(a.seconds) ? a.seconds : undefined,
        caption: typeof a.caption === "string" ? a.caption : undefined,
        stem: typeof a.stem === "string" ? a.stem : undefined,
        seed: Number.isFinite(a.seed) ? a.seed : undefined,
      });
      if (r?.error) throw new Error(r.error);
      if (!r?.job?.id) throw new Error("Studio returned no exact extension job id; check the queue before retrying.");
      return {
        job_id: r.job.id, engine: r?.engine ?? "minimax-music3",
        resumed_from_seconds: r?.resumedFromSeconds ?? null,
        note: "The original is kept. When the job finishes, a joined file extend_<ms>.flac appears in "
          + "the library with the first part bit-identical to the original and the new material "
          + "crossfaded on at the seam.",
      };
    },
  },

  {
    name: "image_document",
    description:
      "Render a LAYER DOCUMENT to a new image — the non-destructive half of the editor.\n"
      + "A document is layers bottom-up (layers[0] is the BOTTOM, the opposite of a VFX "
      + "comp), each with a transform, opacity, one of 21 blend modes, an optional layer "
      + "mask, and optional layer effects. Layer kinds: image (a library NAME, never a "
      + "path), solid, gradient, text, adjustment, group.\n"
      + "· A GROUP composites as a unit — its opacity applies to the assembled group, not "
      + "to each child, which is what makes overlapping children look right.\n"
      + "· An ADJUSTMENT layer carries `ops` (imagetools' 25 adjustments) and/or `effects` "
      + "(the 88-effect registry) and applies them to everything beneath it, which is what "
      + "makes them re-editable instead of baked in.\n"
      + "· clipped: true on a layer is Photoshop's CLIPPING MASK: the layer keeps the alpha "
      + "of its base — the nearest non-clipped layer below it in the same container — as "
      + "its matte, recolouring what the base covers and never escaping it. Consecutive "
      + "clipped layers share one base; the base's opacity, styles and blend then apply to "
      + "the whole clipped result. A clipped ADJUSTMENT layer adjusts only its base stack — "
      + "the classic non-destructive move. The bottom layer of a container has no base and "
      + "paints unclipped, with a warning.\n"
      + "Call image_tools_catalog module=doc for every field. Layers whose source is missing "
      + "are reported and skipped — one absent file never costs the other forty. Recorded in the provenance ledger as an agent action (actor agent:*) — provenance_read shows it.",
    inputSchema: {
      type: "object", required: ["doc"],
      properties: {
        doc: { type: "object", additionalProperties: true,
          description: "{ width, height, layers: [...] }. Sources are library names." },
        scale: { type: "number", description: "Render at a fraction of full size, for a quick look." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/images/document", { doc: a.doc, scale: a.scale });
      if (r.error) throw new Error(r.error);
      return { image: r.name, url: `/api/image/${r.name}`, width: r.width, height: r.height,
               painted: r.painted, missing: r.missingSources || r.missing, warnings: r.warnings };
    },
  },
  {
    name: "image_measure",
    description:
      "Ask an image what it needs, without changing it. These return NUMBERS, so you can "
      + "see the proposal and argue with it rather than pressing an opaque Enhance.\n"
      + "· autoTone — measures the picture and returns values for controls that already "
      + "exist, which you then pass to image_adjust. It proposes nothing on a picture that "
      + "needs nothing, and it never touches a pixel itself.\n"
      + "· autoStraighten — the dominant horizon or vertical, as an ANGLE plus a confidence. "
      + "It does not rotate; pass the angle to image_adjust as geometry.rotate.\n"
      + "· whiteBalance — pass params {x, y} naming a pixel that should be neutral and it "
      + "returns the colour temperature and tint that would make it so.\n"
      + "Anything else in the photo catalog can be measured too, but those three are the "
      + "ones built to answer rather than act.",
    inputSchema: {
      type: "object", required: ["name", "tool"],
      properties: {
        name: { type: "string", description: "Image filename from list_images." },
        tool: { type: "string", description: "autoTone | autoStraighten | whiteBalance | any photo tool." },
        params: { type: "object", additionalProperties: true, description: "e.g. {x, y} for whiteBalance's picked pixel." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/images/measure", {
        name: safeName(a.name, "image"), tool: String(a.tool || ""), params: a.params || {},
      });
      if (r.error) throw new Error(r.error);
      return { tool: r.tool, ...r.result };
    },
  },
  {
    name: "image_export",
    description:
      "Write a library image out in a real format, at a real quality. Every edit in this "
      + "app produces a PNG; this is how it leaves as something else.\n"
      + "Formats: png, jpeg, webp, avif, tiff, ico, pdf. Quality, progressive JPEG, chroma "
      + "subsampling, WebP lossless, PNG palette quantisation and bit depth — "
      + "image_tools_catalog module=export lists every knob with its range.\n"
      + "A format that cannot carry alpha FLATTENS onto `matte` (white by default, never "
      + "silently black — a cutout exported to JPEG with a black halo is the classic bug).\n"
      + "EXIF is STRIPPED by default; these images get shared. Pass metadata:'preserve' to "
      + "keep it.\n"
      + "`maxBytes` searches quality to land under a byte target and tells you the quality it "
      + "reached; if it cannot get there it says so rather than returning something over.\n"
      + "Anything the encoder had to ignore (a dither on an image with alpha, a quality "
      + "under a lossless codec) comes back in `ignored` rather than being dropped quietly. Exports embed the provenance XMP (the AI marker is always written; the detailed record follows the user's embed setting) and the export lands in the provenance ledger as an agent action — provenance_read shows it.",
    inputSchema: {
      type: "object", required: ["name"],
      properties: {
        name: { type: "string", description: "Image filename from list_images." },
        opts: {
          type: "object", additionalProperties: true,
          description: "format, quality, lossless, progressive, subsampling, palette, bitDepth, "
            + "matte [r,g,b], metadata (strip|preserve|none — the AI marker is written in every mode), "
            + "resize {mode,width,height,percent}, "
            + "sizes (ico), dpi (pdf), maxBytes. See image_tools_catalog module=export.",
        },
      },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/images/export", { name: safeName(a.name, "image"), opts: a.opts || {} });
      if (r.error) throw new Error(r.error);
      return { file: r.name, bytes: r.bytes, format: r.format,
               width: r.width, height: r.height, quality: r.quality,
               ignored: r.ignored?.length ? r.ignored : undefined,
               // "xmp" (embedded), "sidecar" (<file>.provenance.json beside
               // it), or null — the caller must never assume an embed that
               // actually fell back.
               provenance: r.provenance ?? null,
               url: `/api/image/${r.name}` };
    },
  },
  {
    name: "describe_selection",
    description:
      "WHAT A SELECTION ACTUALLY CAUGHT, before an edit is spent running through it. Pass the same "
      + "`selection` you would give image_adjust and get back its coverage, how many pixels are fully in, "
      + "how many sit on the soft edge, and a plain sentence reading those numbers.\n\n"
      + "⚠ CALL THIS WHEN TUNING A wand OR colorRange, because an empty selection is SILENT everywhere "
      + "else. A tolerance that catches nothing resolves to a mask of zeros, every op through it becomes a "
      + "no-op, the edit writes a file identical to its input, and the reply still says ok — which is "
      + "indistinguishable from a subtle edit until you compare the pixels. This is the only thing in the "
      + "system that will tell you the key caught nothing.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "An image in the library (from list_images)." },
        selection: { type: "object", description: "The same shape image_adjust takes: {shapes:[...], mode, feather, expand, invert}. Call image_tools_catalog for the kinds and their ranges." },
        frame: { type: "object", description: "The frame the selection's coordinates are written in — `crop`, `geometry`/`rotate`/`flipH`/`flipV`, `canvas`, exactly as image_adjust takes them. ⚠ PASS THIS WHENEVER THE SAME CALL WOULD CROP OR ROTATE: a selection is resolved AFTER those stages (IMAGE_SPEC §3, \"pixels AFTER any crop/rotate/flip in the same call\"), so without it the shapes are measured against the uncropped picture — right numbers, wrong frame, no error. Omit it when the call has no geometry." },
      },
      additionalProperties: false,
    },
    async run(a) {
      return await api("POST", "/api/images/describe-selection", {
        name: safeName(a.name, "image"), selection: a.selection || {}, frame: a.frame || {},
      });
    },
  },

  {
    name: "measure_text",
    description:
      "WHERE THE TYPE WILL LAND, before there is a picture to land on. Pass the same `text` spec "
      + "image_adjust takes and get back the ink box, the line count, the baseline step, the "
      + "advance width, and whether it overflowed its box \u2014 without rendering anything.\n\n"
      + "\u26a0 THIS IS HOW YOU SIZE A CANVAS TO ITS TYPE rather than the other way round. Every other "
      + "way to find out costs a render and a look: ask for a headline at size 120, measure it, and "
      + "THEN make the frame \u2014 or discover the descenders were cut off after the fact, which the "
      + "picture will not tell you because a cut descender looks like a design.\n"
      + "`inkBoxWhy` says when the box is not the obvious one (a rotation, a stroke, a shadow all "
      + "grow it), and a substituted font is reported rather than silently used.",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "object", additionalProperties: true,
          description: "The type spec \u2014 {content, font, size, box, tracking, lineHeight, rotate, ...}, exactly as image_adjust's `text` takes it. Call image_tools_catalog module=text for every field." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/images/measure-text", { text: a.text });
      if (r.error) throw new Error(r.error);
      return r;
    },
  },

  {
    name: "check_figure",
    description:
      "WHY A LETTER FILLED SOLID \u2014 a diagnosis of a multi-contour figure, before you spend a draw "
      + "on it. Returns each contour's signed area, whether it is closed, which contour encloses it, "
      + "which enclosed ones will actually be HOLES under the fill rule, which will not, and full "
      + "sentences naming what to do.\n\n"
      + "\u26a0 BOTH WAYS TO GET THIS WRONG ARE SILENT. A figure with holes \u2014 a letter, a logo, an "
      + "island with a lake in it \u2014 is a LIST of contours in ONE call with `boolean` left at 'none'. "
      + "An OPEN contour fills identically to a closed one and strokes with a seam where it starts. "
      + "A counter wound the SAME WAY as the contour around it is not a hole under nonzero, and the "
      + "'o' comes back a solid blob. Neither can be refused, because both are legal figures somebody "
      + "might mean \u2014 so nothing will tell you except this.\n"
      + "Run it on any glyph outline or traced logo before drawing it.",
    inputSchema: {
      type: "object",
      required: ["figure"],
      properties: {
        figure: { type: "object", additionalProperties: true,
          description: "The {paths: [...]} spec you were about to draw, with all its contours. Extra keys from a draw job (fill, stroke, colour) are ignored quietly \u2014 the figure to check is the one you were about to paint." },
        rule: { type: "string", enum: ["nonzero", "evenodd"],
          description: "The fill rule to judge against. Defaults to the figure's own `fillRule`, then to nonzero \u2014 which is the rule that cares about winding, and therefore the one that turns a wrongly-wound counter into a solid blob." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/images/check-figure", { figure: a.figure, rule: a.rule || null });
      if (r.error) throw new Error(r.error);
      /* ⚠ TWO VERDICTS, TWO WORDS. `ok` is the CALL; `clean` is the FIGURE.
       * A figure with a backwards counter is a successful diagnosis — read
       * `clean` and `problems`, never `ok`, to find out whether to fix it. */
      return r;
    },
  },

  {
    name: "list_luts",
    description:
      "THE LUTs ON THIS MACHINE \u2014 the .cube files the Studio can put on a picture. A LUT is how a "
      + "look TRAVELS: the one a colourist built, or a film emulation out of a pack, lands here "
      + "unchanged. Returns each file's name and size; call lut_info for what is inside one.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const r = await api("GET", "/api/images/luts");
      if (r.error) throw new Error(r.error);
      return r;
    },
  },

  {
    name: "lut_info",
    description:
      "WHAT IS INSIDE A LUT, without applying it \u2014 its title, whether it is 1D or 3D, its size "
      + "(17, 33 and 65 are the usual ones), and its input domain.\n\n"
      + "\u26a0 CALL THIS BEFORE APPLYING ONE YOU DID NOT MAKE. A LUT cannot say what colour space it "
      + "expects, and a film LUT built for LOG footage applied to an ordinary sRGB picture does not "
      + "look broken \u2014 it looks DELIBERATE, washed out or crushed in a way that reads as a style "
      + "choice. `cannotKnow` in the reply says exactly which of those judgements the file cannot "
      + "make for you. A non-standard `domain` is the other thing worth seeing first.",
    inputSchema: {
      type: "object", required: ["lut"],
      properties: { lut: { type: "string", description: "The file name from list_luts." } },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/images/lut-info", { lut: a.lut });
      if (r.error) throw new Error(r.error);
      return r;
    },
  },

  {
    name: "apply_lut",
    description:
      "PUT A LOOK ON A PICTURE \u2014 a .cube LUT applied to a library image, written to a NEW file "
      + "(the original is never touched). This is the door every other grading tool exports into and "
      + "this studio could not take until now.\n\n"
      + "`strength` under 100 is how a look is actually used \u2014 a LUT at full is usually more than "
      + "anybody wants. `interpolation` defaults to tetrahedral; trilinear is the floor and "
      + "nearest is visibly banded on a 17- or 33-point LUT, so only ask for those to compare.\n\n"
      + "\u26a0 THE ONE THING IT CANNOT CHECK FOR YOU is whether the LUT was built for the kind of "
      + "picture you are giving it. Call lut_info first on anything you did not make.",
    inputSchema: {
      type: "object", required: ["name", "lut"],
      properties: {
        name: { type: "string", description: "An image in the library (from list_images)." },
        lut: { type: "string", description: "The LUT file name from list_luts." },
        strength: { type: "number", description: "0-100. 100 is the full look; a grade is usually somewhere below it." },
        interpolation: { type: "string", enum: ["tetrahedral", "trilinear", "nearest"],
          description: "Defaults to tetrahedral. `nearest` bands visibly and is only useful for comparing." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/images/lut", {
        name: safeName(a.name, "image"), lut: a.lut,
        strength: a.strength, interpolation: a.interpolation,
      });
      if (r.error) throw new Error(r.error);
      return { image: r.name, url: `/api/image/${r.name}`, lut: r.lut,
               ms: r.ms, cannotKnow: r.cannotKnow, notes: r.notes };
    },
  },

  {
    name: "image_styles_catalog",
    description:
      "THE LAYER-STYLE REFERENCE \u2014 call this before passing `styles` to image_adjust. The ten "
      + "styles with every parameter's type, default, range and what it does, plus the aliases "
      + "(`shadow`, `glow`, `bevel`, `outline`, `sheen`, and snake_case spellings) so a near-miss "
      + "resolves instead of erroring.\n\n"
      + "\u26a0 `order` IS PHOTOSHOP'S PAINTING ORDER AND IT IS NOT ALPHABETICAL. A caller or a UI "
      + "that sorts it paints in the wrong order, and a drop shadow under a stroke is a different "
      + "picture from a stroke under a drop shadow. `growsAlpha` says which styles paint OUTSIDE the "
      + "shape, which is what decides whether a glow at the frame edge gets clipped.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "One style, instead of all ten." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("GET", "/api/images/tools?module=styles");
      if (r.error) throw new Error(r.error);
      const cat = r.tools?.styles || r.styles || r;
      if (!a.name) return cat;
      const one = (cat.styles || cat)[a.name];
      if (!one) throw new Error(`no layer style called "${a.name}". The ten are: ${(cat.order || Object.keys(cat.styles || cat)).join(", ")}.`);
      return { [a.name]: one, order: cat.order };
    },
  },

  {
    name: "describe_styles",
    description:
      "WHETHER THIS PICTURE HAS A SHAPE TO STYLE, before a layer style is spent on it. Returns "
      + "`report.shaped`, where the shape came from, its coverage, and \u2014 when the answer is no \u2014 "
      + "`report.why` in a sentence.\n\n"
      + "\u26a0 CALL THIS WHEN YOU ARE UNSURE WHETHER A PICTURE IS A CUTOUT. A flat photograph is "
      + "opaque in every pixel and a layer style decorates ALPHA, so on one of those every style "
      + "either paints the whole frame or does nothing at all. `ok` is the call; `report.shaped` is "
      + "the answer, and a picture with no shape is a legitimate answer rather than a failure.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "An image in the library (from list_images)." },
        selection: { type: "object", description: "The shape to test, same spec image_adjust's `selection` takes. Omit it to ask about the picture's own alpha." },
        useAlpha: { type: "boolean", description: "Test the picture's OWN alpha as the shape \u2014 what you want on a cutout from image_cutout." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/images/describe-styles", {
        name: safeName(a.name, "image"), selection: a.selection || null,
        useAlpha: a.useAlpha === true,
      });
      if (r.error) throw new Error(r.error);
      return r;
    },
  },

  {
    name: "image_to_svg",
    description:
      "THE VECTOR SIDE, AS A FILE \u2014 a pen figure or a line of type written out as a real SVG and "
      + "filed in the image library. Until this existed everything imgpath's pen tool and the "
      + "compositor's shape layers could make left as PIXELS only: a traced logo could not go to a "
      + "printer, a title could not go into a web page, and nothing could be opened in Illustrator "
      + "or Inkscape \u2014 while `vectorize` had always been able to turn a photograph into vectors.\n\n"
      + "Pass `figure` ({paths:[...]}, exactly what image_adjust's `paths` takes) or `text` (exactly "
      + "what its `text` takes). `text` comes out as OUTLINES, so the type survives on a machine "
      + "that does not have the font.\n\n"
      + "\u26a0 A FIGURE WITH HOLES IS ONE FIGURE. Send every contour of a letter or a logo in ONE "
      + "call with `boolean` left at 'none' \u2014 they are emitted as subpaths of a single element, "
      + "which is the only arrangement in which the counters are holes. Two calls make two elements "
      + "and the counter of an 'o' fills solid in every renderer there is.\n\n"
      + "\u26a0 AND READ `figureOk`, NOT `ok`. `ok` says the file was written; `figureOk` says the "
      + "figure is what its author meant. A counter wound the same way as the letter around it "
      + "exports perfectly and fills solid \u2014 `problems` names the contour and what to do to it.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "A short name for the file; the library adds a stamp and the .svg extension." },
        figure: { type: "object", additionalProperties: true, description: "{paths:[...]} plus the paint (fill, stroke, strokeWidth, fillRule, cap, join, dash) \u2014 imgpath's own draw parameters. Call image_tools_catalog module=paths." },
        text: { type: "object", additionalProperties: true, description: "A type spec (content, font, size, box, tracking, rotate\u2026), converted to glyph outlines. Call image_tools_catalog module=text." },
        title: { type: "string", description: "The document's <title>, for a reader and for accessibility." },
        width: { type: "integer" }, height: { type: "integer" },
        margin: { type: "number", description: "Padding around the figure's bounding box when width/height are left out." },
        background: { type: "array", items: { type: "integer" }, description: "RGBA 0-255 behind the figure; omit for a transparent document." },
      },
      /* ⚠ CLOSED, because run() forwards a NAMED list. Left open, a `fill` sent
       * at the top level would be accepted here and dropped there — the exact
       * "advertised and then dropped" failure, moved one level down and made
       * invisible. Closed, it is refused by name. The paint belongs inside
       * `figure`, which is imgpath's own draw spec. */
      additionalProperties: false,
    },
    async run(a) {
      /* ⚠ NAMED, NOT PASSED WHOLE. `api(..., a)` forwarded every declared
       * parameter correctly and forwarded any UNDECLARED one just as happily,
       * and the lane that checks nothing is advertised then dropped cannot see
       * through a pass-through either. Both problems go away by writing the
       * list down: what this tool promises is what this line sends. The paint
       * parameters ride inside `figure`, which is imgpath's own draw spec. */
      const { name, figure, text, title, width, height, margin, background } = a;
      const r = await api("POST", "/api/images/svg", {
        name, figure, text, title, width, height, margin, background,
      });
      if (r.error) throw new Error(r.error);
      return { image: r.name, url: `/api/image/${r.name}`,
               figureOk: r.figureOk, problems: r.reports, contours: r.contours,
               notes: r.notes };
    },
  },

  {
    name: "image_documents",
    description:
      "THE LAYERED DOCUMENT AS A FILE \u2014 save, open, list, delete. image_document renders a document; "
      + "this is what keeps one. Until this existed a twelve-layer comp lived for the length of one "
      + "render call and nothing on disk was the comp.\n\n"
      + "`save` mints an id and a slug when the document has none, so \"save a new one\" and \"save the "
      + "one I am working on\" are the same call \u2014 pass the doc back with its `id` to update it. "
      + "`open` returns the document ready to hand to image_document.\n\n"
      + "\u26a0 `open` RE-VALIDATES WHAT IT READ and returns `warnings`. The shelf is a plain JSON file "
      + "any process on the machine can write, so a document off disk is exactly as untrusted as one "
      + "off the wire; what you get back has been repaired, and the warnings say what was repaired. "
      + "Read them before rendering \u2014 a silently repaired layer is a layer that will not look the way "
      + "it did when it was saved.\n"
      + "`delete` is permanent: there is no trash behind this shelf.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["save", "open", "list", "delete"],
          description: "list first if you do not know the id." },
        doc: { type: "object", additionalProperties: true,
          description: "SAVE only \u2014 the document, the same shape image_document takes: {name?, width, height, layers:[...]}. Include its `id` to update the one on the shelf; leave it out and a new one is minted. Call image_tools_catalog module=doc for the layer kinds." },
        id: { type: "string", description: "OPEN and DELETE \u2014 the document's id or its slug; either works." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/images/documents", {
        action: a.action, doc: a.doc || null, id: a.id || null,
      });
      if (r.error) throw new Error(r.error);
      return r;
    },
  },

  {
    name: "document_edit",
    description:
      "MOVE, RENAME, GROUP, CLIP AND DELETE LAYERS on a shelved document \u2014 the Layers panel's own "
      + "verbs, applied server-side. Ops: add_layer, remove_layer, reorder_layer, move_layer, "
      + "duplicate_layer, group_layers, ungroup_layer, set_clipped, update_layer.\n\n"
      + "\u26a0 USE THIS RATHER THAN open \u2192 EDIT \u2192 save. That round trip rewrites the WHOLE document "
      + "from a copy you took a moment ago, so it silently discards every change anyone or anything "
      + "else made in between \u2014 which is the entire reason a shelf exists rather than a variable.\n\n"
      + "All of the ops or none of them: a refusal anywhere leaves the shelf exactly as it was. Each "
      + "op names its layer by `id`, by `name`, or by `index`. The reply carries a flat `outline` of "
      + "the resulting tree, so you can see what you did without asking for the document back.",
    inputSchema: {
      type: "object",
      required: ["id", "ops"],
      properties: {
        id: { type: "string", description: "The document's id or slug, from image_documents action=list." },
        ops: { type: "array", minItems: 1, items: { type: "object", additionalProperties: true },
          description: "[{op, ...}] applied in order. e.g. {op:\"move_layer\", name:\"logo\", parent:\"titles\", index:0}, {op:\"set_clipped\", name:\"grade\", clipped:true}, {op:\"update_layer\", id:\"l3\", patch:{opacity:0.5}}, {op:\"group_layers\", refs:[\"sky\",\"clouds\"], name:\"background\"}." },
        doc: { type: "boolean", description: "Return the full document too, not only the outline. Off by default \u2014 a big tree is a lot of tokens to move for an answer the outline already gives." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/images/document-edit", {
        id: a.id, ops: a.ops, doc: a.doc === true,
      });
      if (r.error) throw new Error(r.error);
      return r;
    },
  },

  {
    name: "bake_selection",
    description:
      "TURN A SELECTION INTO A PICTURE \u2014 the resolved matte, written into the image library as a "
      + "grayscale plate, with no edit attached. This is the step server/imgdoc.py names in its own "
      + "refusal: a document mask cannot rasterise wand, colorRange or path, and it tells you to "
      + "\"bake the result into a library image and use mask.src\". Until now nothing baked.\n\n"
      + "\u26a0 THE KINDS WORTH BAKING ARE THE ONES THAT CANNOT BE WRITTEN DOWN. A rect you can re-send "
      + "as JSON; a `wand` seed with a tolerance you tuned blind is computed FROM PIXELS, and that "
      + "result used to live for exactly one call. Bake it and it is addressable: mask.src on a "
      + "document layer, `setMatte` on a compositor layer (which reads a matte layer's luminance), the "
      + "map for gradientWipe or displacementMap, or the base of another selection.\n\n"
      + "Returns the new library name, its coverage, and a sentence reading it \u2014 because a matte "
      + "that caught nothing is a solid black PNG and looks exactly like a working file. Call "
      + "describe_selection first if you are still tuning; call this when you like what it caught.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "An image in the library (from list_images). The matte comes out at this picture's size." },
        selection: { type: "object", description: "The same shape image_adjust takes: {shapes:[...], mode, feather, expand, invert, antialias}. Call image_tools_catalog module=selection for the kinds and their ranges. Omit it and the matte is solid white \u2014 the whole frame, which is what no selection means everywhere else in the pipeline." },
        frame: { type: "object", description: "The frame the selection's coordinates are written in — `crop`, `geometry`/`rotate`/`flipH`/`flipV`, `canvas`, exactly as image_adjust takes them. ⚠ PASS THIS WHENEVER THE SAME CALL WOULD CROP OR ROTATE: a selection is resolved AFTER those stages (IMAGE_SPEC §3, \"pixels AFTER any crop/rotate/flip in the same call\"), so without it the shapes are measured against the uncropped picture — right numbers, wrong frame, no error. Omit it when the call has no geometry." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/images/bake-selection", {
        name: safeName(a.name, "image"), selection: a.selection || {}, frame: a.frame || {},
      });
      if (r.error) throw new Error(r.error);
      return { image: r.name, url: `/api/image/${r.name}`,
               coverage: r.coverage, everything: r.everything, says: r.says };
    },
  },

  {
    name: "image_tools_catalog",
    description:
      "THE REFERENCE FOR SELECTIONS, BRUSHES, SHAPES AND THE REST — call this before passing "
      + "`selection` or `strokes` to image_adjust. Returns each module's catalog: every "
      + "parameter with its type, default, range and what it does. A guessed name is "
      + "refused; a guessed RANGE is accepted and renders wrong, which is why the ranges "
      + "are here.\n"
      + "Ask for one `module` (selection, strokes, shapes, text, photo, export, doc, paths) "
      + "or omit it for all of them. A module still being built reports itself unavailable "
      + "rather than pretending to be empty.\n"
      + "Effects have their own, larger catalog — image_effects_catalog.",
    inputSchema: {
      type: "object",
      properties: {
        module: { type: "string", description: "selection | strokes | shapes | text | photo | export | doc | paths" },
        search: { type: "string", description: "Substring match on name, label or purpose." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("GET", "/api/images/tools");
      if (r.error) throw new Error(r.error);
      let tools = r.tools || {};
      if (a.module) {
        const key = String(a.module);
        if (!(key in tools)) {
          throw new Error(`No module "${key}". They are: ${Object.keys(tools).join(", ")}.`);
        }
        tools = { [key]: tools[key] };
      }
      const q = String(a.search || "").toLowerCase();
      const out = {};
      for (const [mod, cat] of Object.entries(tools)) {
        if (cat && cat._unavailable) { out[mod] = { unavailable: cat._unavailable }; continue; }
        let rows = Object.entries(cat || {});
        if (q) {
          rows = rows.filter(([n, s]) => n.toLowerCase().includes(q)
            || String(s?.label || "").toLowerCase().includes(q)
            || String(s?.why || "").toLowerCase().includes(q));
        }
        if (rows.length) out[mod] = Object.fromEntries(rows);
      }
      if (!Object.keys(out).length) throw new Error("Nothing matches that. Call it with no arguments to see everything.");
      return out;
    },
  },
  {
    name: "image_effects_catalog",
    description:
      "THE EFFECT REFERENCE FOR IMAGES — call this before passing `effects` to image_adjust. "
      + "Lists every effect with its group, what it is for, and each parameter's type, "
      + "default, range and options. These are the compositor's own 93 effects running on a "
      + "still, so anything the VFX tab can do to a frame it can do to an image. "
      + "Filter with `group` or `search` when the whole list is more than you need. "
      + "Effects marked needsTimeline (echo, timeDifference, posterizeTime) read previous "
      + "frames and return a still untouched — they are listed rather than hidden so asking "
      + "for one gets an explanation instead of looking like a typo.",
    inputSchema: {
      type: "object",
      properties: {
        group: { type: "string", description: "Only effects in this group." },
        search: { type: "string", description: "Substring match on name, label or purpose." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("GET", "/api/images/effects");
      if (r.error) throw new Error(r.error);
      const q = String(a.search || "").toLowerCase();
      const g = String(a.group || "").toLowerCase();
      let rows = Object.entries(r.effects || {});
      if (g) rows = rows.filter(([, s]) => String(s.group || "").toLowerCase().includes(g));
      if (q) {
        rows = rows.filter(([n, s]) => n.toLowerCase().includes(q)
          || String(s.label || "").toLowerCase().includes(q)
          || String(s.why || "").toLowerCase().includes(q));
      }
      if (!rows.length) {
        throw new Error(`No effect matches that. Call image_effects_catalog with no arguments to see all ${Object.keys(r.effects || {}).length}.`);
      }
      return {
        count: rows.length,
        effects: Object.fromEntries(rows.map(([name, spec]) => [name, {
          label: spec.label, group: spec.group, why: spec.why,
          needsTimeline: spec.needsTimeline || undefined,
          params: Object.fromEntries(Object.entries(spec.params || {}).map(([p, d]) => [p, {
            type: d.type, default: d.default,
            range: d.min !== undefined ? `${d.min}..${d.max}` : undefined,
            options: d.options, desc: d.desc,
          }])),
        }])),
      };
    },
  },
  {
    name: "image_set_blur",
    description: "Blur (or unblur) an image's tile in the gallery — a per-image privacy flag for screens other people can see. The pixels are untouched; a blurred tile reveals with one click.",
    inputSchema: { type: "object", required: ["name", "blur"], properties: { name: { type: "string" }, blur: { type: "boolean" } }, additionalProperties: false },
    async run(a) {
      const r = await api("POST", "/api/images/flag", { name: safeName(a.name, "image"), blur: a.blur });
      if (r.error) throw new Error(r.error);
      return { name: r.name, blur: r.blur };
    },
  },
  {
    name: "image_trash",
    description: "Move a library image to output/trash — reversible by moving the file back. The gallery forgets it; the pixels survive.",
    inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } }, additionalProperties: false },
    async run(a) {
      const r = await api("POST", "/api/images", { action: "trash", name: safeName(a.name, "image") });
      if (r.error) throw new Error(r.error);
      return { ok: true };
    },
  },
  {
    name: "list_fonts",
    description: "TTF/OTF files from the system font folder, usable in image_adjust's text op (the type tool).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() { return await api("GET", "/api/fonts"); },
  },
  {
    name: "image_analyze",
    description: "Read an image and PROPOSE adjustments instead of baking them: returns an ops object (the image_adjust shape) plus the reasoning and the measured stats (mean, sd, chroma, black/white points, clipping). Use it to auto-enhance honestly — inspect what it decided, change what you disagree with, then pass the ops to image_adjust.",
    inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } }, additionalProperties: false },
    async run(a) {
      const r = await api("POST", "/api/images/analyze", { name: safeName(a.name, "image") });
      if (r.error) throw new Error(r.error);
      return { ops: r.ops, notes: r.notes, stats: r.stats };
    },
  },
  {
    name: "image_review",
    description:
      "LOOK AT a picture — this returns the image itself, not a description of it. Every other tool "
      + "in this list returns text, which meant an agent could render a guitar with five strings and "
      + "a hand with the wrong fingers and never know: the file existed, so the render 'worked'. "
      + "image_analyze cannot help here — it measures brightness and clipping, not meaning.\n\n"
      + "Returns the picture (downscaled; 768px long edge by default, enough to count strings or "
      + "fingers), the prompt it was made from, the `expect` checklist recorded at render time, and "
      + "any previous verdict. Look at it against the checklist, then record what you saw with "
      + "image_verdict — a look nobody wrote down protects nothing.",
    inputSchema: {
      type: "object", required: ["name"],
      properties: {
        name: { type: "string" },
        max_edge: { type: "integer", description: "Long edge in px, 256-1536. Default 768. Raise it only for a detail you genuinely cannot resolve — it costs tokens, not quality." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/images/review", {
        name: safeName(a.name, "image"),
        max_edge: Number.isFinite(a.max_edge) ? a.max_edge : undefined,
      });
      if (r.error) throw new Error(r.error);
      const { image, ...rest } = r;
      return {
        ...rest,
        /* The pixels, carried as MCP image content by the tools/call wrapper.
         * Absent only when the thumbnail could not be made, and imageError
         * then says why rather than leaving a silent text-only reply. */
        ...(image ? { _images: [image] } : {}),
        next: rest.state === "unchecked" || rest.state === "stale"
          ? "Compare it against `expect`, then call image_verdict."
          : undefined,
      };
    },
  },

  {
    name: "image_expect",
    description:
      "Say what a picture was SUPPOSED to contain — 'six strings', 'both hands visible', 'no text'. "
      + "Plain words, not a schema. This exists so the check runs against an intention rather than "
      + "against a fresh look at the picture, which tends to approve whatever it happens to see.\n\n"
      + "Usually set at render time by make_image's `expect`; use this when a picture is only "
      + "questioned once it is on screen, which is when the expectation actually becomes sayable. "
      + "Replaces the whole list. Adding to the list makes an existing verdict stale, because a pass "
      + "on three expectations is not a pass on five.",
    inputSchema: {
      type: "object", required: ["name", "expect"],
      properties: {
        name: { type: "string" },
        expect: { type: "array", items: { type: "string" }, maxItems: 24 },
      },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/images/expect", {
        name: safeName(a.name, "image"),
        expect: Array.isArray(a.expect) ? a.expect : [],
      });
      if (r.error) throw new Error(r.error);
      return r;
    },
  },

  {
    name: "image_verdict",
    description:
      "Record what you saw when you looked. `failed` is the field that matters: 'it is wrong' is a "
      + "complaint, 'five strings where the prompt asked for six' is something the next prompt can "
      + "act on. Naming any failure makes the verdict a fail — a pass-with-notes is how a known "
      + "defect travels downstream unnoticed, so this refuses to record one.\n\n"
      + "Goes into the provenance ledger as a judge event (provenance_read shows it) and stays "
      + "attached to the image. The verdict fingerprints the file, so re-rendering over the same "
      + "name marks it stale instead of silently vouching for a different picture.",
    inputSchema: {
      type: "object", required: ["name", "ok"],
      properties: {
        name: { type: "string" },
        ok: { type: "boolean", description: "Did it come back with what was asked for?" },
        failed: { type: "array", items: { type: "string" }, maxItems: 24,
          description: "Which expectations did not hold, in the words of the defect." },
        notes: { type: "string", description: "Anything worth knowing that is not a pass/fail — what to change in the prompt, which part of the frame is wrong." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/images/verdict", {
        name: safeName(a.name, "image"),
        ok: Boolean(a.ok),
        failed: Array.isArray(a.failed) ? a.failed : [],
        notes: a.notes,
      });
      if (r.error) throw new Error(r.error);
      return r;
    },
  },

  {
    name: "image_reviews",
    description:
      "Which pictures were ever looked at. Four states: unchecked (nobody looked — the default, and "
      + "never assume it means fine), pass, fail, and stale (judged, then the file or the checklist "
      + "moved underneath the judgement). Use it to find what an overnight run produced and nobody "
      + "checked.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const r = await api("GET", "/api/images/reviews");
      if (r.error) throw new Error(r.error);
      return r;
    },
  },

  {
    name: "image_lineage",
    description: "How an image was made: the chain of parents back to the original render, each step tagged with how it got there (edit/composite/cutout/upscale/vectorize/collage) and the ops used. Every edit writes a new file, so this is the undo history — and whether each ancestor still exists on disk.",
    inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } }, additionalProperties: false },
    async run(a) {
      const r = await api("GET", `/api/images/lineage/${encodeURIComponent(safeName(a.name, "image"))}`);
      if (r.error) throw new Error(r.error);
      return r;
    },
  },
  {
    name: "image_sheet",
    description: "Build a contact sheet — N library images tiled into one picture, the collage a gallery implies. cols defaults to a near-square arrangement; cell is the tile size in px; fit \"cover\" crops each tile to fill (the tight grid people mean by a collage) while \"contain\" letterboxes and keeps whole images. labels: true captions each tile with its prompt, or pass your own array.",
    inputSchema: {
      type: "object", required: ["names"],
      properties: {
        names: { type: "array", items: { type: "string" }, maxItems: 64 },
        cols: { type: "integer" }, cell: { type: "integer" }, gap: { type: "integer" },
        fit: { type: "string", enum: ["cover", "contain"] },
        bg: { type: "array", items: { type: "integer" } },
        labels: { description: "true for prompts, or an array of strings" },
      }, additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/images/sheet", {
        ...a, names: (a.names || []).map((n) => safeName(n, "image")) });
      if (r.error) throw new Error(r.error);
      return { image: r.name, tiles: r.tiles, grid: `${r.cols}x${r.rows}`, url: `/api/image/${r.name}` };
    },
  },
  {
    name: "image_composite",
    description: "Layer images onto a base — the compositing half of an editor. Layers paint in order (first is bottom); each layer's own transparency (a cutout's, say) multiplies its opacity, so a keyed PNG composites the way it looks. Blend modes: normal, multiply, screen, overlay, softlight, add, subtract, difference, darken, lighten. Per layer: x/y (px), anchor topleft|center, scale, rotate, flipH/flipV, opacity 0-1. Optional canvas {w,h,bg:[r,g,b,a]} enlarges the sheet first (the base lands at 0,0). clipped: true is Photoshop's clipping mask — the layer keeps the alpha of the nearest non-clipped layer beneath it (the base image counts) as its matte, so it recolours what that base covers and never escapes it; consecutive clipped layers share one base. A clipped composite renders through the layer document (image_document's engine): rotation then pivots about the anchor, and flipH/flipV are refused — flip the source first with image_adjust. Result is a new library image.",
    inputSchema: {
      type: "object", required: ["base", "layers"],
      properties: {
        base: { type: "string", description: "Library image name the layers land on" },
        layers: { type: "array", maxItems: 12, items: {
          type: "object", required: ["src"],
          properties: { src: { type: "string" }, x: { type: "number" }, y: { type: "number" },
            scale: { type: "number" }, opacity: { type: "number" }, rotate: { type: "number" },
            flipH: { type: "boolean" }, flipV: { type: "boolean" },
            anchor: { type: "string", enum: ["topleft", "center"] },
            clipped: { type: "boolean", description: "Clip this layer to the nearest non-clipped layer beneath it (the base image counts): its alpha becomes this layer's matte, Photoshop's clipping mask. Consecutive clipped layers stack onto the one base." },
            effects: { type: "object", description: "Layer effects drawn from the layer's own alpha, Photoshop-style: shadow {dx,dy,blur,opacity,color}, glow {size,opacity,color}, stroke {width,color}. The layer grows to fit them so nothing clips.",
              properties: { shadow: { type: "object" }, glow: { type: "object" }, stroke: { type: "object" } } },
            mode: { type: "string", enum: ["normal", "multiply", "screen", "overlay", "softlight", "add", "subtract", "difference", "darken", "lighten"] } },
          additionalProperties: false } },
        canvas: { type: "object", properties: { w: { type: "integer" }, h: { type: "integer" }, bg: { type: "array" } } },
      }, additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/images/composite", {
        base: safeName(a.base, "image"),
        layers: (a.layers || []).map((l) => ({ ...l, src: safeName(l.src, "image") })),
        canvas: a.canvas,
      });
      if (r.error) throw new Error(r.error);
      // `warnings` is the only channel for "clipped, but no base" — a layer
      // that painted UNCLIPPED with the route saying so. Dropping it here
      // turned that honesty back into silence.
      return { image: r.name, layers: r.layers, url: `/api/image/${r.name}`,
               warnings: r.warnings };
    },
  },
  {
    name: "image_presets",
    description: "Named edit recipes. list: every saved preset with its ops. save: store the ops object under a name (the same shape image_adjust takes). remove: delete one. Presets are what image_batch applies to a whole set.",
    inputSchema: {
      type: "object", required: ["action"],
      properties: { action: { type: "string", enum: ["list", "save", "remove"] },
        name: { type: "string" }, ops: { type: "object" } },
      additionalProperties: false,
    },
    async run(a) {
      if (a.action === "list") return await api("GET", "/api/images/presets");
      if (!a.name) throw new Error("name the preset");
      const r = await api("POST", "/api/images/presets", {
        name: a.name, ops: a.ops || {}, remove: a.action === "remove" });
      if (r.error) throw new Error(r.error);
      return { presets: Object.keys(r.presets) };
    },
  },
  {
    name: "image_swatches",
    description: "The editor's colour swatches — the same palette the Swatches panel shows, persisted app-level beside the presets (this editor has no saved document for a palette to travel with, so a swatch is a workspace preference, not a document one). list: every swatch with its index. add: store a colour ([r,g,b] 0-255 — a 0..1 triple is refused, not stored as near-black) with an optional name. remove: drop the swatch at `index` (from list).",
    inputSchema: {
      type: "object", required: ["action"],
      properties: {
        action: { type: "string", enum: ["list", "add", "remove"] },
        color: { type: "array", items: { type: "number" }, description: "add: [r, g, b], each 0-255" },
        name: { type: "string", description: "add: optional label, e.g. \"brand cyan\"" },
        index: { type: "integer", description: "remove: position from list" },
      },
      additionalProperties: false,
    },
    async run(a) {
      if (a.action === "list") return await api("GET", "/api/images/swatches");
      if (a.action === "remove") {
        if (a.index == null) throw new Error("remove needs the swatch's index — image_swatches list shows them");
        const r = await api("POST", "/api/images/swatches", { remove: a.index });
        if (r.error) throw new Error(r.error);
        return { swatches: r.swatches };
      }
      const r = await api("POST", "/api/images/swatches", { color: a.color, name: a.name });
      if (r.error) throw new Error(r.error);
      return { swatches: r.swatches };
    },
  },
  {
    name: "image_batch",
    description: "Apply one edit to many images — by explicit names, or by a prompt substring match over the library. ops is the image_adjust shape, or name a saved preset instead. Each image renders into its own new file; failures are reported per image rather than aborting the run.",
    inputSchema: {
      type: "object",
      properties: {
        names: { type: "array", items: { type: "string" }, description: "Explicit library names" },
        match: { type: "string", description: "Instead of names: every image whose prompt or filename contains this" },
        limit: { type: "integer", description: "Cap on matched images (default 25)" },
        preset: { type: "string", description: "A saved preset name — takes precedence over ops" },
        ops: { type: "object", description: "Raw ops, the image_adjust shape" },
      }, additionalProperties: false,
    },
    async run(a) {
      let ops = a.ops || {};
      if (a.preset) {
        const p = await api("GET", "/api/images/presets");
        ops = (p.presets || {})[a.preset];
        if (!ops) throw new Error(`no preset "${a.preset}" — image_presets list shows them`);
      }
      if (!Object.keys(ops).length) throw new Error("nothing to apply: give ops or a preset");
      let names = (a.names || []).map((n) => safeName(n, "image"));
      if (!names.length && a.match) {
        const lib = (await api("GET", "/api/images")).images || [];
        const q = String(a.match).toLowerCase();
        names = lib.filter((im) => `${im.meta?.prompt || ""} ${im.name}`.toLowerCase().includes(q))
          .slice(0, Number(a.limit) || 25).map((im) => im.name);
      }
      if (!names.length) throw new Error("no images matched");
      const done = [], failed = [], reports = {};
      for (const name of names) {
        const r = await api("POST", "/api/images/edit", { name, ops });
        if (r.error) failed.push({ name, error: r.error });
        else {
          done.push(r.name);
          // The per-image honesty report, kept beside the names rather than
          // replacing them: notes are a stage's compromises, fxSkipped the
          // timeline effects that did nothing on a still.
          if (r.notes || r.fxSkipped) reports[r.name] = { notes: r.notes, fxSkipped: r.fxSkipped };
        }
      }
      return { made: done, failed, count: done.length,
               reports: Object.keys(reports).length ? reports : undefined };
    },
  },
  {
    name: "image_paint_layer",
    description:
      "PAINT ONTO ONE LAYER of a layer document \u2014 the thing a Layers panel is for, and the thing "
      + "that was missing. Takes the same `ops` /api/images/edit takes (strokes, shapes, paths, clear, "
      + "selection) and runs them through the SAME engine, so a stroke an agent posts and a stroke a "
      + "person drags commit the same bytes.\n\n"
      + "\u26a0 ONLY AN IMAGE LAYER CAN BE PAINTED. A solid, gradient, shape or text layer is "
      + "regenerated from its parameters on every render, so a stroke into one would be discarded the "
      + "next time it drew. The refusal says so and names the kind you gave it.\n\n"
      + "\u26a0 THE LAYER'S SOURCE IS NOT OVERWRITTEN. One library picture can be the source of several "
      + "layers in several documents, so this writes a NEW picture and repoints this one layer at it. "
      + "The reply carries the new name.\n\n"
      + "Use image_document_preview paintTargets to check eligibility first. Painting requires a visible, unlocked, full-canvas image layer with identity mapping, inside visible/unlocked identity-mapped groups and with no enabled effects. Transformed/cropped/effected layers are refused; render and open a composite or use Qwen AI editing on the composed document instead. "
      + "Read the op vocabulary with image_tools_catalog.",
    inputSchema: {
      type: "object",
      required: ["id", "ref", "ops"],
      properties: {
        id: { type: "string", description: "Document id or slug, from image_documents." },
        ref: { type: "string", description: "The layer's id, or its name if that is unique in the document." },
        ops: { type: "object", additionalProperties: false,
          description: "Only {strokes:[...], shapes:[...], paths:[...], clear:true, selection:{...}}; at least one actual paint operation is required. image_tools_catalog publishes every kind and its ranges.",
          properties: { strokes: { type: "array", items: { type: "object" } }, shapes: { type: "array", items: { type: "object" } }, paths: { type: "array", items: { type: "object" } }, clear: { type: "boolean" }, selection: { type: "object" } } },
      },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/images/document-paint",
        { id: String(a.id), ref: String(a.ref), ops: a.ops || {} });
      if (r.error) throw new Error(r.error);
      return { document: r.id, layer: r.ref, image: r.src, url: r.url, layers: r.layers };
    },
  },
  {
    name: "image_new_page",
    description:
      "A BLANK PAGE IN THE IMAGE LIBRARY \u2014 the one thing this studio could not make until now. "
      + "Every other picture here came out of the engine, so the painting tools (image_stroke, "
      + "image_shape, image_text, the pen) could only ever be pointed at something already "
      + "rendered. This gives them an empty canvas.\n\n"
      + "\u26a0 THE DEFAULT BACKGROUND IS TRANSPARENT, NOT WHITE, and the difference matters: "
      + "black at alpha 0 composites away, opaque black has to be erased first. Pass "
      + "[255,255,255,255] if you actually want white paper.\n\n"
      + "width and height are pixels, 1-16384. The page lands in the library as paint_*.png and "
      + "is recorded in the provenance ledger as author_layer \u2014 which folds to human-authored, "
      + "because a blank page somebody asked for is not generated content.",
    inputSchema: {
      type: "object",
      properties: {
        width: { type: "integer", description: "1-16384 px (default 1920)" },
        height: { type: "integer", description: "1-16384 px (default 1080)" },
        background: {
          type: "array",
          description: "RGBA 0-255, four numbers. Default [0,0,0,0] \u2014 fully transparent.",
          items: { type: "integer" }, minItems: 4, maxItems: 4,
        },
      },
      additionalProperties: false,
    },
    async run(a) {
      const body = {};
      if (a.width !== undefined) body.width = a.width;
      if (a.height !== undefined) body.height = a.height;
      if (a.background !== undefined) body.background = a.background;
      const r = await api("POST", "/api/images/create", body);
      if (r.error) throw new Error(r.error);
      return { image: r.name, url: `/api/image/${r.name}`,
        width: r.width, height: r.height, background: r.background };
    },
  },
  {
    name: "image_cutout",
    description: "Remove the background from a library image with BiRefNet (MIT licence) — the subject stays, everything else becomes transparency. Result is a new transparent PNG in the library, ready for compositing, chroma work or a logo pass. Runs on the local engine in a couple of seconds. Recorded in the provenance ledger as an agent action (actor agent:*) — provenance_read shows it.",
    inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } }, additionalProperties: false },
    async run(a) {
      const r = await api("POST", "/api/images/cutout", { name: safeName(a.name, "image") });
      if (r.error) throw new Error(r.error);
      return { image: r.name, url: `/api/image/${r.name}` };
    },
  },
  {
    name: "image_upscale",
    description: "Upscale a library image 2x with RealESRGAN (BSD-3, local). New file in the library; chain it twice for 4x. Recorded in the provenance ledger as an agent action (actor agent:*) — provenance_read shows it.",
    inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } }, additionalProperties: false },
    async run(a) {
      const r = await api("POST", "/api/images/upscale", { name: safeName(a.name, "image") });
      if (r.error) throw new Error(r.error);
      return { image: r.name, url: `/api/image/${r.name}` };
    },
  },
  {
    name: "image_vectorize",
    description: "Convert a library image to SVG — posterize to N colors, trace each layer with simplified contours. Made for LOGOS and flat art (a photograph becomes posterized art). colors 2-16 (default 6; use 2-4 for a clean logo), detail 0.2-4 (higher = more faithful, more path points). The SVG lands in the image library.",
    inputSchema: {
      type: "object", required: ["name"],
      properties: { name: { type: "string" }, colors: { type: "integer" }, detail: { type: "number" } },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/images/vectorize", { name: safeName(a.name, "image"), colors: a.colors, detail: a.detail });
      if (r.error) throw new Error(r.error);
      return { svg: r.name, paths: r.paths, bytes: r.bytes, url: `/api/image/${r.name}` };
    },
  },
  {
    name: "list_checkpoints",
    description: "The bring-your-own-model shelf: every .safetensors/.ckpt in ComfyUI/models/checkpoints. Each entry carries what the file actually IS, read from its safetensors header rather than its name — family/variant (SDXL, SD1.5, anima, zimage…), dtype, parameter count, size and when it arrived — plus `loadable`. Only `loadable` files work with make_image engine=checkpoint: a bare diffusion transformer dropped in that folder cannot be loaded by CheckpointLoader and `why` says so. The app lists, it does not curate — licences and content policies are the model author's.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() { return await api("GET", "/api/checkpoints"); },
  },
  {
    name: "overnight_start",
    description:
      "Start an unattended run and leave. THREE KINDS: `music` (song ideas, with optional cover/lyrics/stems/"
      + "clip/enhance stages after each one), `image`, and `video`. Music always preempts, so an image run "
      + "yields the GPU to any song that arrives and picks up after. "
      + "Prompts are TEMPLATES: `{a|b|c}` expands per take, so ten takes of one idea are ten different "
      + "pictures rather than one picture ten times. Seeds are rolled per take and repeats are caught and "
      + "re-rolled, which is what makes a run safe to leave. Use preview_prompt first — a template that "
      + "reads well and expands badly costs a night to discover otherwise.",
    inputSchema: {
      type: "object", required: ["items"],
      properties: {
        kind: { type: "string", enum: ["music", "image", "video"], description: "Default music." },
        name: { type: "string", description: "What to call this run in the history." },
        takes: { type: "integer", description: "How many of each idea. 1-20, default 3." },
        cap: { type: "integer", description: "Stop after this many renders in total." },
        items: {
          type: "array", maxItems: 40,
          description: "The ideas. For music: caption (the style) plus optional title/lyrics/instrumental/"
            + "maxDuration. For image and video: prompt (a template) plus optional engine/checkpoint/"
            + "negative/width/height/steps/cfg/count, and seconds on video. Images also preserve persona, ordered refImages, "
            + "native model filenames, refSizing/refResolution/transparent, Qwen's Fast draft and sampler/LoRA choices. Omitted image engine uses Qwen Image 2.1; "
            + "each take uses the normal image readiness and reference checks.",
          items: {
            type: "object",
            properties: {
              caption: { type: "string" }, prompt: { type: "string" }, title: { type: "string" },
              lyrics: { type: "string" }, instrumental: { type: "boolean" },
              maxDuration: { type: "integer" },
              engine: { type: "string" }, checkpoint: { type: "string" }, negative: { type: "string" },
              width: { type: "integer" }, height: { type: "integer" },
              steps: { type: "integer" }, cfg: { type: "number" },
              count: { type: "integer" }, seconds: { type: "number" },
              dit: { type: "string" }, ditEngine: { type: "string" }, encoder: { type: "string" }, vae: { type: "string" },
              quality: { type: "string", enum: ["default", "quality", "turbo"] }, persona: { type: "string" },
              refImages: { type: "array", maxItems: 10, items: { type: "string" }, description: "Ordered image filenames, plus any saved persona references (10 combined maximum)." },
              refSizing: { type: "string", enum: ["reference", "custom"] },
              refResolution: { type: "integer", minimum: 0, maximum: 4096 }, transparent: { type: "boolean" },
              draft: { type: "boolean", description: "Qwen Image 2.1 only: Fast draft (make_image's draft) for every take of this idea." },
              sampler: { type: "string" }, scheduler: { type: "string" }, clipSkip: { type: "integer" },
              loras: { type: "array", maxItems: 8, items: { type: "object", required: ["name"], properties: {
                name: { type: "string" }, strength: { type: "number" }, clipStrength: { type: "number" },
              }, additionalProperties: false } },
            },
            additionalProperties: false,
          },
        },
        stages: {
          type: "object", description: "MUSIC ONLY: what runs after each song.",
          properties: {
            cover: { type: "boolean" }, lrc: { type: "boolean" }, stems: { type: "boolean" },
            video: { type: "boolean" }, enhance: { type: "boolean" },
          },
          additionalProperties: false,
        },
        confirm_spend: { type: "boolean", description: "MUSIC with the paid hosted engine switched on only: every song of the night bills the person's own key, and the run is refused with the night's estimate until this is true. Pass true ONLY after the person agreed to that estimate." },
      },
      additionalProperties: false,
    },
    async run(a) {
      /* Named field by field rather than spread. A spread forwards whatever it
       * is handed, which reads as complete and proves nothing — and the census
       * cannot tell a forwarded parameter from a declared-and-dropped one
       * through it. Naming them is also the only way an added schema field
       * fails loudly here instead of silently going nowhere. */
      const r = await api("POST", "/api/batch", {
        action: "start",
        kind: a.kind, name: a.name, takes: a.takes, cap: a.cap,
        items: a.items, stages: a.stages,
        confirmSpend: a.confirm_spend === true ? true : undefined,
      });
      if (r.error) throw new Error(r.error);
      return r;
    },
  },

  {
    name: "overnight_control",
    description:
      "Pause, resume or stop the run, or clear the history. Pause lets whatever is rendering finish first "
      + "— killing a nearly-complete render throws away GPU time already spent; stop is there for ending it now.",
    inputSchema: {
      type: "object", required: ["action"],
      properties: { action: { type: "string", enum: ["pause", "resume", "stop", "clear"] } },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/batch", { action: a.action });
      if (r.error) throw new Error(r.error);
      return r;
    },
  },

  {
    name: "overnight_status",
    description:
      "What the run is doing: kind, state, how far through the plan, what it has produced, what failed and "
      + "why, and the finished runs before it. Safe to call while one is going.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      /* /api/batch is POST-only; the run's state is merged into /api/status,
       * which is where the page reads it from too. */
      const st = await api("GET", "/api/status");
      return { run: st.run ?? null, runs: st.runs ?? [], art: st.art ?? null };
    },
  },

  {
    name: "save_prompt_template",
    description:
      "Write a reusable prompt template onto the shelf. THIS IS THE AUTHORING TOOL: when the owner asks for "
      + "\"twenty character archetypes\" or \"outfits\" or \"artist styles\" to explore, YOU write the "
      + "{a|b|c} template and save it here — there is no second language model in this app, and adding one "
      + "would mean an API key and sending prompts off a machine whose whole premise is that it runs locally. "
      + "Write it as ONE prompt with groups in it, not a list: `a portrait of a {stoic|weary|radiant} "
      + "{knight|scholar|smuggler}{, scarred|}` is a template; twenty finished sentences are not. Aim for "
      + "groups that combine, keep an empty option where a detail should appear only sometimes, and check "
      + "it with preview_prompt before saving — a template that reads well and expands badly costs a night.",
    inputSchema: {
      type: "object", required: ["name", "template"],
      properties: {
        name: { type: "string", description: "Short and specific: \"tavern characters\", \"90s film stocks\"." },
        template: { type: "string", description: "The prompt, with {a|b|c} groups." },
        tag: { type: "string", description: "characters | outfits | sceneries | styles | anything else." },
        notes: { type: "string", description: "What it is for. Never sent to the model." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/prompts",
        { name: a.name, template: a.template, tag: a.tag, notes: a.notes });
      if (r.error) throw new Error(r.error);
      return r.template;
    },
  },

  {
    name: "list_prompt_templates",
    description:
      "Templates on the shelf, each with how many distinct prompts it can produce and whether an agent or a "
      + "person wrote it. Pass `tag` to filter. Use one as make_image's `prompt` — the groups expand per "
      + "render, so N takes are N different pictures.",
    inputSchema: {
      type: "object",
      properties: { tag: { type: "string" } },
      additionalProperties: false,
    },
    async run(a) {
      const q = a.tag ? `?tag=${encodeURIComponent(a.tag)}` : "";
      return await api("GET", `/api/prompts${q}`);
    },
  },

  {
    name: "delete_prompt_template",
    description: "Take a template off the shelf.",
    inputSchema: {
      type: "object", required: ["name"],
      properties: { name: { type: "string" } },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/prompts", { action: "delete", name: a.name });
      if (r.error) throw new Error(r.error);
      return r;
    },
  },

  {
    name: "list_personas",
    description:
      "Saved characters: name, description and the reference pictures that show what they look like. "
      + "Pass `for` (an engine) and each says whether it can be used — usable on Qwen Image 2.1 and FLUX.2 "
      + "pictures and on MiniMax H3 clips (make_clip `persona`), so a persona on any other engine is refused "
      + "rather than silently ignored. Not a LoRA and not training: "
      + "this is the reference-image path remembered, so identity holds well but can drift over a long series.",
    inputSchema: {
      type: "object",
      properties: { for: { type: "string", description: "Engine to judge usability against." } },
      additionalProperties: false,
    },
    async run(a) {
      const q = a.for ? `?for=${encodeURIComponent(a.for)}` : "";
      return await api("GET", `/api/personas${q}`);
    },
  },

  {
    name: "save_persona",
    description:
      "Create or update a character. Saving the same NAME twice edits one character rather than making two. "
      + "Give it reference pictures (names from list_images), a description, or both — the pictures carry the "
      + "face, the words carry what a picture cannot show. Use make_image with `persona` to put them in a scene. "
      + "For clips, 1–3 tight pictures of one person on a plain dark background keep them best; make_clip takes the first 3.",
    inputSchema: {
      type: "object", required: ["name"],
      properties: {
        name: { type: "string", description: "How the prompt will refer to them." },
        fragment: { type: "string", description: "The description folded into the prompt." },
        ref_images: { type: "array", items: { type: "string" }, maxItems: 8,
          description: "Image names from list_images that show this character." },
        notes: { type: "string", description: "For you, never sent to the model." },
        engine: { type: "string", description: "Which engine the references were made for. Default flux2." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/personas", {
        name: a.name, fragment: a.fragment, notes: a.notes, engine: a.engine,
        refImages: Array.isArray(a.ref_images) ? a.ref_images.map((n) => safeName(n, "image")) : undefined,
      });
      if (r.error) throw new Error(r.error);
      return r.persona;
    },
  },

  {
    name: "delete_persona",
    description: "Forget a character. The pictures it referenced stay in the library.",
    inputSchema: {
      type: "object", required: ["name"],
      properties: { name: { type: "string" } },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/personas", { action: "delete", name: a.name });
      if (r.error) throw new Error(r.error);
      return r;
    },
  },

  {
    name: "list_dits",
    description:
      "Bare diffusion transformers in ComfyUI/models/diffusion_models, with the architecture each one is. "
      + "These load through UNETLoader, which does NOT read models/checkpoints — a DiT left there is invisible "
      + "to every engine. Pass `family` (e.g. anima) to filter. Use a name from here as make_image's `dit`.",
    inputSchema: {
      type: "object",
      properties: { family: { type: "string", description: "anima, zimage, flux2, ideogram4…" } },
      additionalProperties: false,
    },
    async run(a) {
      const q = a.family ? `?family=${encodeURIComponent(a.family)}` : "";
      return await api("GET", `/api/dits${q}`);
    },
  },

  {
    name: "list_loras",
    description:
      "Every LoRA in ComfyUI/models/loras, with the architecture each one was trained FOR — read from the "
      + "file's own tensors, because the filename does not say and the failure is silent: LoraLoader matches "
      + "keys and skips the rest, so a mismatched LoRA renders with no error and no effect. "
      + "Pass `for` (a checkpoint filename from list_checkpoints) and each row reports fit as yes / no / "
      + "unknown. `unknown` means the file does not state which SD base it targets — worth trying, not "
      + "worth assuming. `for` may also name a file in models/diffusion_models or unet (a bare DiT such as "
      + "Krea 2). Checkpoint-engine pictures take LoRAs, and so does YuE2 through ComfyUI "
      + "(make_song with engine yue2-comfy and `lora`): pass the YuE2 checkpoint as `for` to see which fit.",
    inputSchema: {
      type: "object",
      properties: { for: { type: "string", description: "Checkpoint filename to judge compatibility against." } },
      additionalProperties: false,
    },
    async run(a) {
      const q = a.for ? `?for=${encodeURIComponent(safeName(a.for, "checkpoint"))}` : "";
      return await api("GET", `/api/loras${q}`);
    },
  },

  {
    name: "train_lora",
    description:
      "TEACH THE MUSIC MODEL ONE OF YOUR OWN SONGS. Makes a small adapter (a LoRA) that pulls YuE2 toward "
      + "a recording's character; afterwards it is selectable like any other, with make_song engine "
      + "yue2-comfy and `lora`. The song must be in this machine's library (list_songs) and nothing is "
      + "uploaded \u2014 the audio, the training and the adapter all stay on this computer.\n\n"
      + "\u26a0 THIS TAKES THE GRAPHICS CARD FOR AN HOUR OR MORE and cannot be interrupted usefully, so it "
      + "refuses before spending any of that: no tokenizer, no YuE2 checkpoint, a busy card, or under "
      + "10 GB of free video memory each get their own answer naming the one thing to fix. "
      + "Call with no `file` to get that readiness report and the defaults without starting anything.\n\n"
      + "\u26a0 TWO THINGS THAT BELONG IN ANY DECISION TO RUN IT. The tokenizer that reads your recording is "
      + "subject to non-commercial model/tokenizer terms. Review those terms and the rights to the recording; "
      + "this tool does not determine an adapter's licence. The training loop RUNS is measured \u2014 a real adapter, gradients "
      + "reaching every site \u2014 while whether a given number of steps yields something you can HEAR is "
      + "not yet measured. Do not promise a user an audible result.\n\n"
      + "Returns a runId; poll it with `check` (pass the same runId and name) until done, then the adapter "
      + "is moved into models/loras where every picker reads it.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "A song filename from this machine's library. Omit to get the readiness report only." },
        name: { type: "string", description: "What to call the adapter. Becomes the filename, prefixed mine_." },
        seconds: { type: "number", minimum: 8, maximum: 180, description: "Length of the training region, default 24 seconds. The entire region must fit inside the recording. Audible benefit is not yet validated." },
        startSeconds: { type: "number", minimum: 0, maximum: 3600, description: "Where the training region starts in the recording, default 0. Independent of the selected region length." },
        steps: { type: "integer", minimum: 50, maximum: 4000, description: "Training steps (50-4000, default 600)." },
        seed: { type: "integer", description: "Training graph seed. Default 0." },
        rank: { type: "number", description: "How much room the adapter has to learn in (2-64, default 8). Measured: rank 8 used 8.9 GB of video memory." },
        learningRate: { type: "number", description: "Default 0.0002." },
        check: { type: "string", description: "A runId from an earlier call: report on that run instead of starting one, and file the adapter when it is done." },
        runName: { type: "string", description: "The name that call returned. Required with `check`." },
      },
      additionalProperties: false,
    },
    async run(a) {
      if (a.check) return await api("POST", "/api/train", { action: "check", runId: a.check, name: a.runName });
      if (!a.file) return await api("POST", "/api/train", { action: "status" });
      return await api("POST", "/api/train", {
        action: "start", file: a.file, name: a.name,
        seconds: a.seconds, startSeconds: a.startSeconds, steps: a.steps, rank: a.rank, learningRate: a.learningRate, seed: a.seed,
      });
    },
  },

  {
    name: "sampling_options",
    description:
      "Every sampler and scheduler THIS ComfyUI install actually has, read from its own /object_info rather "
      + "than a list written down here — a custom node pack can add samplers, and offering a name the engine "
      + "does not have fails at render time instead of at pick time. Applies to make_image with "
      + "engine=checkpoint; the distilled engines run fixed schedules.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() { return await api("GET", "/api/sampling/options"); },
  },

  {
    name: "preview_prompt",
    description:
      "Expand a DYNAMIC PROMPT without rendering anything. `{a|b|c}` picks one option, an empty option "
      + "is legal (`{, at night|}` adds a detail half the time), and groups nest. Returns how many distinct "
      + "prompts the template can make, a sample of them, and one concrete expansion with the choices that "
      + "produced it. Use it before starting a long run — a template that reads well and expands badly "
      + "costs a whole night to discover otherwise.",
    inputSchema: {
      type: "object", required: ["prompt"],
      properties: {
        prompt: { type: "string", description: "The template, with {a|b|c} groups." },
        samples: { type: "integer", description: "How many expansions to list. Default 8." },
      },
      additionalProperties: false,
    },
    async run(a) {
      return await api("POST", "/api/prompt/preview", { prompt: a.prompt, samples: a.samples });
    },
  },

  {
    name: "make_image",
    description:
      "Draw a picture. With no `engine` it uses the saved picture engine, or when nobody chose one the recommended picture model on this PC (studio_status `defaults`, key image.engine, says which and why; set_image_engine with use_for \"pictures\" saves one). Qwen Image 2.1's runtime and weights must be ready; check qwen_image_status. It runs only while "
      + "nothing else is generating — music always takes priority. Blocks until it is done.\n\n"
      + "Pass `ref_images` for Qwen Image 2.1 or FLUX.2 editing: the prompt refers to them as "
      + "\"image 1\", \"image 2\" in order — \"put the character from image 1 into the scene "
      + "from image 2\", \"same figure as image 1 but seen from behind\". This is how you "
      + "iterate a character toward a target or keep one consistent across pictures. Recorded in the provenance ledger as an agent action (actor agent:*) — provenance_read shows it.\n\n"
      + "Qwen Image defaults to 25 steps, CFG 1, Euler/simple. A negative needs CFG greater than 1. "
      + "Qwen Image uses a noncommercial research license. `draft: true` is its Fast draft: about 3x quicker "
      + "(measured 3.1 s against 11.2 s at 1024 warm), for storyboards, thumbnails and ideas; it may garble small text "
      + "and add extra faces or fingers, so leave it off for lettering, crowds, close hands, two-reference style edits and finals. "
      + "zimage-base and checkpoint also support negatives; reference images require Qwen Image 2.1 or FLUX.2.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string",
          description: "Supports DYNAMIC PROMPTS: `{a|b|c}` picks one option per render and an empty option is legal, so `{, at night|}` adds a detail half the time. Groups nest. The reply carries the expansion it chose plus `prompt_choices`, and passing those back reproduces that exact prompt — which is what makes one picture out of an overnight run findable again." },
        private: { type: "boolean",
          description:
            "PRIVATE: render this without recording what was typed. The prompt, the negative, every "
            + "text node, the prompt HASH and the label are left out of the ledger; no graph is filed "
            + "in the never-pruned graph store; the engine's metadata chunk is stripped from the PNG; "
            + "and the gallery row keeps its seed, model and date but no prompt.\n\n"
            + "\u26a0 THE RENDER IS STILL RECORDED. The ledger event is still written, with the same "
            + "actor and the same chain \u2014 a hash-chained ledger cannot skip a line without breaking "
            + "verification of every line after it \u2014 and it names what it dropped in `redacted`. The "
            + "picture keeps its IPTC AI-generated disclosure. This hides the WORDS, never the fact "
            + "that a machine made the picture.\n\n"
            + "Not retroactive, and it cannot be added afterwards: the words are simply never written." },
        prompt_choices: { type: "array", items: { type: "integer" },
          description: "Replay a previous expansion exactly, from a earlier reply's prompt_choices." },
        dedupe: { type: "string", enum: ["reroll", "refuse", "off"],
          description: "What to do when this exact render (model, expanded prompt, seed, size, steps, cfg, refs) has already been made. reroll (default) rolls a fresh seed and says so; refuse errors instead; off renders the repeat. This is what stops an overnight run with a forgotten fixed seed making one picture all night." },
        count: { type: "integer", minimum: 1, maximum: 4, description: "1-4 images. Batching increases memory and render time." },
        ref_images: { type: "array", items: { type: "string" }, maxItems: 10,
          description: "Up to 10 existing image names (including persona refs), called image 1, image 2 in this order. Qwen reference cost is unmeasured; FLUX.2 measured about 4 s per reference past the second. Missing or excess Qwen references are refused." },
        ref_sizing: { type: "string", enum: ["reference", "custom"], description: "Qwen only: reference (default) matches the resized first reference geometry; custom uses width/height and may shift an edit." },
        ref_resolution: { type: "integer", minimum: 0, maximum: 4096, description: "Qwen only: reference resize area target, default 1024; rounded up to 32. Zero keeps the source size, rounded to 32, and can need substantial memory." },
        transparent: { type: "boolean", description: "Qwen only: request native RGBA transparency and preserve alpha in PNG output. Without it, references with transparency are flattened onto white." },
        draft: { type: "boolean",
          description: "Qwen Image 2.1 only: FAST DRAFT. Viggle's turbo LoRA at 1.0, 5 steps on its own schedule, euler, CFG 1, "
            + "no negative. Measured about 3x quicker warm (3.1 s against 11.2 s at 1024; batch of 4 3.8x); a new prompt still "
            + "pays the text encode (about 2x), and switching between a draft and a full render costs a model re-patch "
            + "(+8.8 s into a draft, +2.5 s back), so group drafts. For storyboards, board thumbnails and ideas: it may garble "
            + "small text and, in crowds or close hands, add extra faces or fingers; not for finals, lettering or two-reference "
            + "style edits (a two-reference edit measured only 2.3x and judges preferred the full render). "
            + "Refused (with the reason) on any other engine, and with transparent, more than 3 references (a persona's "
            + "count), cfg above 1, a negative, steps other than 5, or a canvas above about 2 MP (measured up to 1920x1088; "
            + "8192 latent tokens, so ref_resolution up to 1440). Needs the Fast draft LoRA (0.68 GB, Models row "
            + "imageQwenFastDraft); qwen_image_status reports `draft.ready`." },
        ref_alpha: { type: "string", enum: ["white", "keep"], description: "Qwen only: white flattens a reference with transparency onto white, keep sends its alpha. Default follows transparent. keep on an opaque request can return a transparent picture." },
        width: { type: "integer" },
        height: { type: "integer" },
        seed: { type: "integer" },
        engine: { type: "string", enum: ["qwen-image-2.1", "flux2", "zimage", "zimage-base", "anima", "ideogram4", "krea2", "checkpoint"],
          description: "qwen-image-2.1: native INT8 Qwen Image 2.1, generation/editing, up to 10 refs, 25 steps at CFG 1, noncommercial research license. "
            + "flux2: FLUX.2 klein 4B, Apache-2.0, 4 steps, also takes ref_images. "
            + "zimage: Z-Image Turbo, Apache-2.0, 8 steps — photographic realism, faces, English and Chinese "
            + "prompts, and the cleanest commercial answer in the app; NO negative (distilled at cfg 1.0, so "
            + "the negative branch is never evaluated — passing one is refused, not ignored) and no refs. "
            + "zimage-base: the same model undistilled, 25 steps at cfg 4.0 — slower, more varied per seed, "
            + "and the negative prompt genuinely works; reach for it when zimage keeps drawing the same "
            + "composition. ideogram4: the open Ideogram release — typography/posters; NON-COMMERCIAL licence "
            + "whose text is gated and unread; preset via quality. checkpoint: any .safetensors in "
            + "ComfyUI/models/checkpoints (list_checkpoints shows the shelf) — negative/cfg apply." },
        quality: { type: "string", enum: ["default", "quality"], description: "ideogram4 only: Default 20 steps or Quality 48." },
        checkpoint: { type: "string", description: "checkpoint engine only: the model filename, from models/checkpoints OR models/diffusion_models (list_checkpoints shows both shelves and says which loader each needs). A bare transformer — Z-Image, Anima, FLUX.2, Krea 2 — renders on its own family's recipe with this file in place of the catalogue's." },
        dit_engine: { type: "string", enum: ["auto", "qwen-image-2.1", "zimage", "anima", "flux2", "krea2", "checkpoint"],
          description: "checkpoint engine only, default auto: what the picked file IS. Detection reads the architecture from the tensors and is right for every file measured here; name one of these only to overrule it." },
        encoder: { type: "string", description: "Optional compatible text-encoder filename from models/text_encoders for a native Qwen or other bare-transformer image engine, including checkpoint picks resolved to that family. Defaults to the family's own; Qwen requires its 2.1 encoder architecture." },
        vae: { type: "string", description: "Optional compatible VAE filename from models/vae for native Qwen or another bare-transformer image engine. Defaults to the family's own; Qwen requires its 2.1 VAE architecture." },
        persona: { type: "string",
          description: "A saved character by name (list_personas). Its references precede ref_images and its description joins the prompt. Qwen Image 2.1 or FLUX.2; combined reference limit 10." },
        dit: { type: "string",
          description: "Optional compatible diffusion-model filename from models/diffusion_models or models/unet (list_dits) for Qwen, Anima, FLUX.2, Krea 2 or Z-Image. Qwen 2.1 currently supports native safetensors only. A bare transformer cannot be loaded from models/checkpoints." },
        negative: { type: "string", description: "What the picture must not contain. Qwen requires cfg>1; also supported by checkpoint and zimage-base." },
        cfg: { type: "number", description: "Qwen 1-10 (default 1; negative requires >1), checkpoint 1-15 (default 6), zimage-base (default 4)." },
        clip_skip: { type: "integer",
          description: "checkpoint engine only, and only on the SD family — FLUX, Z-Image and Anima have no CLIP text encoder, so it would do nothing there. 1 (default) uses the whole encoder. Pony and Illustrious checkpoints are SDXL underneath and effectively REQUIRE 2; nothing in a file's tensors can identify such a merge, so list_checkpoints will not tell you — the model page will." },
        loras: { type: "array", maxItems: 8,
          description: "checkpoint engine only. LoRAs STACK — a style plus a character plus a lighting LoRA "
            + "is the normal case. Each must match the checkpoint's architecture: LoraLoader matches keys and "
            + "SKIPS what does not, so an SDXL LoRA on a SD1.5 checkpoint renders happily and changes NOTHING, "
            + "with no error. Call list_loras with `for` set to your checkpoint and use the ones it says fit. "
            + "Most LoRAs also need their trigger words IN THE PROMPT to do much.",
          items: {
            type: "object", required: ["name"],
            properties: {
              name: { type: "string", description: "A filename from list_loras, never a path." },
              strength: { type: "number", description: "-4 to 4, default 1. Around 0.6-0.9 is usual for a style." },
              clipStrength: { type: "number", description: "The text-encoder half, if it should differ from strength." },
            },
            additionalProperties: false,
          } },
        sampler: { type: "string",
          description: "SD checkpoint sampler, default dpmpp_2m; sampling_options lists this install's choices. Qwen 2.1 accepts only euler (its default); other values are refused by its verified preset." },
        scheduler: { type: "string",
          description: "SD checkpoint schedule, default karras (also normal, simple, sgm_uniform, exponential, beta, ddim_uniform). Qwen 2.1 accepts only simple (its default)." },
        steps: { type: "integer",
          description: "Optional, and worth setting on a checkpoint. Omit and you get that engine's own "
            + "default: 25 qwen-image-2.1 (max 50), 4 flux2, 8 zimage, 25 zimage-base, 28 checkpoint (ideogram4 takes its steps from "
            + "`quality` instead and ignores this). 4 is right for DISTILLED FLUX.2 klein and roughly six "
            + "times too few for an SDXL checkpoint, which wants about 20-30 — that mismatch is the reason "
            + "this parameter exists. Clamped by the route: 60 max on checkpoint, 50 on the two Z-Image "
            + "engines (base's README suggests up to 50), 30 otherwise. Do not raise zimage's 8 — it is "
            + "distilled for exactly that; raise zimage-base's instead." },
        timeout_seconds: { type: "integer", description: "Default 600." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const before = new Set(((await api("GET", "/api/images")).images || []).map((i) => i.name));
      const r = await api("POST", "/api/image", {
        action: "create", prompt: a.prompt,
        // Declared AND forwarded: a schema that names a field its run() drops is
        // a feature that answers ok and does nothing.
        private: a.private === true,
        /* No engine named: none is sent, and /api/image uses the saved picture
         * engine or the machine's pick from the disk (studio_status defaults,
         * image.engine). Posting Qwen here aimed a FLUX-only install at files
         * it never downloaded. */
        ...(a.engine ? { engine: a.engine } : {}), quality: a.quality, checkpoint: a.checkpoint,
        negative: a.negative, cfg: a.cfg,
        refSizing: a.ref_sizing, refResolution: a.ref_resolution, transparent: a.transparent, refAlpha: a.ref_alpha,
        /* Fast draft. Sent only when given, so the route's own default (off)
         * decides otherwise; the route refuses it off Qwen with a sentence. */
        draft: typeof a.draft === "boolean" ? a.draft : undefined,
        count: a.count, width: a.width, height: a.height,
        promptChoices: Array.isArray(a.prompt_choices) ? a.prompt_choices : undefined,
        clipSkip: Number.isFinite(a.clip_skip) ? a.clip_skip : undefined,
        dit: a.dit,
        /* What the picked file is, and the halves that run it — see
         * server/modelpick.js. Undefined means "as detected", which is right
         * for every file measured here. */
        ditEngine: a.dit_engine,
        encoder: a.encoder, vae: a.vae,
        persona: a.persona,
        loras: Array.isArray(a.loras) ? a.loras : undefined,
        sampler: a.sampler, scheduler: a.scheduler,
        dedupe: a.dedupe === "off" ? false : a.dedupe === "refuse" ? "refuse" : undefined,
        /* ⚠ NEW, AND FORWARDED IN THE SAME COMMIT THAT DECLARES IT. The route
         * exposed a step count from the beginning and this tool never sent
         * one, so an agent's only lever on schedule length was the engine
         * name. Declaring it without wiring it here would be the silent
         * field-drop mcp-image_test.js exists to catch — the schema and the
         * body have to move together. */
        steps: Number.isFinite(a.steps) ? a.steps : undefined,
        refImages: Array.isArray(a.ref_images) && a.ref_images.length
          ? a.ref_images.map((n) => safeName(n, "image")) : undefined,
        seed: Number.isFinite(a.seed) ? a.seed : undefined,
      });
      if (r.error) throw new Error(r.error);
      const settled = await waitForArt((Number(a.timeout_seconds) || 600) * 1000, "image", r.job?.id);
      const after = (await api("GET", "/api/images")).images || [];
      const made = after.filter((i) => !before.has(i.name)).map((i) => i.name);
      /* THE CHECK, FOLDED INTO THE RENDER. An expectation is attached to every
       * file that came back and the pictures are returned with it, so the loop
       * that used to need three calls and a decision to bother is one call that
       * ends holding the evidence. Failures here are reported, never fatal:
       * losing a checklist must not lose the render it describes. */
      const expect = Array.isArray(a.expect) ? a.expect.filter(Boolean) : [];
      const shots = [];
      const reviewNotes = [];
      if (expect.length && made.length) {
        for (const name of made.slice(0, 4)) {
          try {
            await api("POST", "/api/images/expect", { name, expect });
            const rv = await api("POST", "/api/images/review", { name });
            if (rv.image) shots.push(rv.image);
            else if (rv.imageError) reviewNotes.push(`${name}: ${rv.imageError}`);
          } catch (err) { reviewNotes.push(`${name}: ${err.message}`); }
        }
      }
      return {
        images: made, url_prefix: "/api/image/",
        ...(expect.length ? {
          expect,
          review_state: "unchecked",
          review_next: "Look at the pictures above against `expect`, then call image_verdict for each. "
            + "A render that produced a file is not a render that produced the right thing.",
          ...(reviewNotes.length ? { review_notes: reviewNotes } : {}),
          ...(shots.length ? { _images: shots } : {}),
        } : {}),
        /* What was ACTUALLY asked, not the template — and the choices that got
         * there, so this picture can be made again. */
        ...(r.prompt ? { prompt: r.prompt, prompt_choices: r.promptChoices, combinations: r.combinations } : {}),
        seed: r.seed,
        ...(r.draft ? { draft: true } : {}),
        ...(r.note ? { note: r.note } : {}),
        /* Reached with its OWN failure already thrown by the wait, so never "the
         * last error": that is the queue's, a stranger's. art-wait.js says why. */
        ...(made.length ? {} : { note: emptyResultNote(settled, r.job?.id, "list_images") }),
      };
    },
  },

  {
    name: "list_images",
    description: "Standalone images, newest first — each with the model that painted it (`model` to read, `engine` and `checkpoint` to feed back into make_image) so a picture you like can be reproduced or varied.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer" } },
      additionalProperties: false,
    },
    async run(a) {
      const d = await api("GET", "/api/images");
      return (d.images || []).slice(0, Math.max(1, Number(a.limit) || 40))
        .map((i) => ({ name: i.name, prompt: i.meta?.prompt ?? null, seed: i.meta?.seed ?? null,
                       /* Name, engine id and page, so an agent can reproduce a
                        * picture it likes: `model` reads, `engine`+`checkpoint`
                        * feed straight back into make_image. */
                       model: i.model ?? null, engine: i.modelId ?? null,
                       checkpoint: i.checkpoint ?? null, model_url: i.modelUrl ?? null }));
    },
  },

  {
    name: "set_video_enabled",
    description: "Enable or disable video generation, matching the Video page's switch-on prompt. Enabling does not render or download anything. Disabling also clears automatic video generation for new songs.",
    inputSchema: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } }, additionalProperties: false },
    async run(a) {
      if (typeof a.enabled !== "boolean") throw new Error("enabled must be true or false.");
      return await api("POST", "/api/video", { action: "enable", value: a.enabled });
    },
  },
  {
    /* The engine choice was previously reachable only from the GUI, which left
     * an agent dead-ended: references need H3, soundtracks need LTX, and the
     * create route refuses the mismatch. make_clip can switch inline, but a
     * deliberate tool is worth having — switching costs a weight reload on the
     * next render, so it is a decision, not a detail. */
    name: "set_video_engine",
    description:
      "Choose the video engine, persistently (same setting as the Video page dropdown).\n\n"
      + "  • ltx — LTX 2.5. Fast (~2 min for 5 s). Exact frames, pass-through pictures, "
      + "loops, and the soundtrack path where the clip plays real audio.\n"
      + "  • h3 — MiniMax H3. Slower (2-13 min). The only engine with named references "
      + "(<Picture n> / <Audio n>) for holding a character across shots. ⚠ Its licence "
      + "grants NO rights in " + H3_EXCLUDED + " (see the Models page) — where "
      + "that applies, do not select it; ltx covers everything except named references.\n\n"
      + "Refused if that engine's weights are not downloaded. Switching means the next "
      + "render reloads ~20 GB of weights, so do not flip per clip — batch by engine.",
    inputSchema: {
      type: "object",
      required: ["engine"],
      properties: { engine: { type: "string", enum: ["h3", "ltx", "fasth3"],
        description: "fasth3 = FastVideo's 8-step distillation of H3: fixed 8 steps, no references, same territory clause as H3." } },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/video", { action: "engine", value: a.engine });
      if (r.error) throw new Error(r.error);
      return { engine: r.video?.engine ?? a.engine, enabled: r.video?.enabled };
    },
  },

  {
    /* THE THIRD ENGINE SETTER (UI_PLAN A1). set_image_engine and
     * set_video_engine existed; the music model was reachable only through
     * studio_api_request. Posts the Music page's own door, so the refusals and
     * the unload are the page's. Withheld from the in-app chat by sentence. */
    name: "set_music_engine",
    description:
      "Choose the music model persistently: the same choice as the Music page's model picker and the Models "
      + "screen's Music model. With no saved choice Studio uses what is installed and ready on this PC "
      + "(studio_status `defaults` says which and why); this saves yours, and a saved choice always wins.\n\n"
      + "  • engine — pick an engine and let Studio pick its build: yue2-comfy (YuE2 through ComfyUI), "
      + "yue2-gguf (native YuE2 GGUF), yue2 (the YuE2 Python kit), minimax-music3, ace-step15. "
      + "\"auto\" forgets your choice so Studio picks from the disk again.\n"
      + "  • model — pick one exact build by its `value` from `choices` (call with no arguments to list them).\n\n"
      + "Refused when that model is not downloaded (models_for_this_machine says; download_model fetches). "
      + "A MiniMax \"api\" choice switches paid API mode on, billed per song to your own key. Choosing a "
      + "different model unloads the previous one when nothing is rendering.",
    inputSchema: {
      type: "object",
      properties: {
        engine: { type: "string", enum: ["auto", "yue2-comfy", "yue2-gguf", "yue2", "minimax-music3", "ace-step15"] },
        model: { type: "string", description: "An exact build: a `value` from `choices`, e.g. \"yue2-comfy:yue2_3b_int8_convrot.safetensors\" or \"yue2-gguf:q4_0\"." },
      },
      additionalProperties: false,
    },
    async run(a) {
      if (a.engine && a.model) throw new Error("Pass engine or model, not both.");
      if (a.model) await api("POST", "/api/music", { action: "model", value: String(a.model).slice(0, 300) });
      else if (a.engine) await api("POST", "/api/music", { action: "engine", value: a.engine });
      const st = await api("GET", "/api/status");
      const d = (st.config?.defaults || []).find((x) => x.key === "music.engine") || null;
      return {
        engine: st.config?.musicEngine ?? null,
        chosenBy: d?.chosenBy ?? null, why: d?.why ?? null,
        choices: (st.config?.musicModels || []).map((c) => ({ value: c.value, label: c.label, ready: !!c.available, note: c.note ?? null,
          ...(c.api ? { paid: true } : {}) })),
      };
    },
  },

  {
    name: "set_image_engine",
    description:
      "Choose a picture engine persistently: for covers (the default), for pictures (the Pictures screen's engine, and make_image or a music video's stills with no engine named), or both, with `use_for`. "
      + "\"auto\" forgets the choice, so Studio picks from what is on this PC again. make_image still takes its own `engine` per picture. "
      + "qwen-image-2.1 supports references, 25 steps at CFG 1, and requires a compatible runtime and native files. "
      + "With no saved choice, covers use the recommended picture model on this PC, and none are queued while no picture model is there (studio_status `defaults`, key art.engine); a saved choice always wins. flux2: FLUX.2 klein, Apache-2.0, also takes references. "
      + "zimage / zimage-base: Z-Image, Apache-2.0, photographic; base honours a negative prompt. "
      + "anima: anime and illustration. "
      + "ideogram4: typography and layouts; ⚠ NON-COMMERCIAL licence. "
      + "krea2: Krea 2 Turbo, the frontier open-weights look, measured 26 s a picture warm (ten times FLUX.2); commercial use only under USD 1M company-wide revenue; no references, no negative. "
      + "checkpoint: a file from models/checkpoints; pass `checkpoint` (a name from list_checkpoints). "
      + "Refused when that engine's weights are not downloaded (models_for_this_machine says; download_model fetches).",
    inputSchema: {
      type: "object",
      required: ["engine"],
      properties: {
        engine: { type: "string", enum: ["auto", "qwen-image-2.1", "flux2", "zimage", "zimage-base", "anima", "ideogram4", "krea2", "checkpoint"] },
        checkpoint: { type: "string", description: "With engine \"checkpoint\": the file name to paint with (covers only; a picture's own file is picked per picture)." },
        use_for: { type: "string", enum: ["covers", "pictures", "both"],
          description: "covers (default): the engine that paints song covers. pictures: the Pictures screen's engine, used by make_image and music-video stills when they name none; kept even when its files are missing (make_image then says what to download). both." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const use = a.use_for || "covers";
      if (a.engine === "checkpoint" && use !== "covers") throw new Error("Your own model file paints covers only; make_image picks a file per picture (engine checkpoint + checkpoint).");
      const body = {
        ...(use !== "pictures" ? { engine: a.engine, ...(a.engine === "auto" ? {} : { choose: true }) } : {}),
        ...(use !== "covers" ? { imageEngine: a.engine } : {}),
        ...(a.checkpoint && use !== "pictures" ? { checkpoint: safeName(a.checkpoint, "checkpoint") } : {}),
      };
      const r = await api("POST", "/api/artconfig", body);
      if (r.error) throw new Error(r.error);
      return { engine: r.engine ?? r.art?.engine ?? a.engine, checkpoint: r.checkpoint ?? r.art?.checkpoint ?? null,
        image_engine: r.imageEngine ?? null, chosen: r.chosen ?? null };
    },
  },

  {
    name: "make_clip",
    description:
      "Render a short video clip. Blocks until done — roughly 2 min on LTX, 2-13 min on H3 "
      + "depending on `quality` and size.\n\n"
      + "TWO ENGINES, AND THEY TAKE DIFFERENT INPUTS. Check the current one with "
      + "studio_status and change it with set_video_engine.\n"
      + "  • LTX 2.5 — fast. Takes EXACT frames: `first_frame`, `last_frame`, `mid_frames` "
      + "(pictures the clip passes through), `loop`. Also takes `soundtrack_song`: the "
      + "finished clip plays that stretch; mouths were measured not to follow it on LTX "
      + "(r +0.034, n=18, docs/ENGINE_TRAPS.md).\n"
      + "  • MiniMax H3 — slower, and the only engine that takes NAMED REFERENCES. Pass "
      + "`ref_images` (or `persona`), then name them in the prompt: \"<Picture 1> is Mira. "
      + "Mira sings on a rooftop at dusk\", with `soundtrack_song` for the song. A reference is not "
      + "pinned to a frame — the model recasts the subject wherever the words put it, which "
      + "is how you keep one character across many shots. ⚠ H3's licence grants NO rights "
      + "in " + H3_EXCLUDED + " — where that applies, stay on LTX.\n"
      + "  • FastH3 — H3 distilled to 8 fixed steps (quality and steps do not apply), the Video screen's "
      + `Advanced "${H3_MORE_MOTION.label}": ${H3_MORE_MOTION.note} ${H3_MORE_MOTION.framesUntried} `
      + "first_frame/last_frame are accepted (the reply warns), references are refused; `attention` picks "
      + "the dense attention under its sparse attention. Same licence and territory clause as H3.\n\n"
      + "KEEPING A CHARACTER (measured 2026-09-24, same seeds, two blind judges): on MiniMax H3 a person who "
      + "must look the same as in other clips needs 1–3 tight pictures of them, one person on a plain dark "
      + "background (`persona`, or `ref_images` with '<Picture 1> is Name.' written in the prompt), their "
      + "name where they act, and the reference build's own step count (leave quality and steps unset: 8 "
      + "where the 8-step reference file is on disk). If they sing, add `soundtrack_song` and "
      + "`soundtrack_start` (where the sung line starts): the song sits under the clip and the mouth follows "
      + "the words. `ref_song` (<Audio 1>) is a different input: the clip re-sings it in its own time. "
      + "From words alone the person changes between clips (hair, mask, costume); that is fine for shots "
      + "with no one in them. The reply's `character` says what this render keeps.\n\n"
      + "Passing an engine-specific input while the other engine is selected is REFUSED "
      + "rather than silently ignored; pass `engine` to switch first. The reply's `warnings` say "
      + "everything the render changed from the request (the card's size when none was named, the "
      + "reference build's step count, a <Picture n> nothing answers taken out of the words) and the "
      + "RAM warning. `check_only` returns that plan, and what the size needs on this card, without "
      + "rendering. Recorded in the provenance ledger as an agent action (actor agent:*) — provenance_read shows it.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string", description: "What happens in the shot. Describe motion, not just a subject. May contain <Picture n> / <Audio n> tags when ref_images / ref_song are given." },
        engine: { type: "string", enum: ["h3", "ltx", "fasth3"], description: "Switch the engine before rendering. Persists, like the GUI dropdown. Omit to use whatever is selected. fasth3 always runs its trained 8 steps (quality and steps do not apply) and takes no references." },
        quality: { type: "string", enum: ["fast", "best"],
          description: "fast = the quickest matched turbo build on this disk: 3 steps on the TaoMate build where it is installed, else the 4-step build. The TaoMate 3-step was measured as coherent and as sharp as the 8-step build at 25–40% less wall time; with sparse attention on (`sparse`, sol-attn by default) fast is " + H3_SOL_ATTN.gain + ", so no longer quite as sharp. best = the bare model at 20 steps on its native schedule, over twice as long; the one A/B of it against the 8-step turbo (docs/H3_REFERENCE_BLEED.md, arm H vs C: one shot, reference path) saw no visible gain. Default: the engine's own default, the Video screen's Standard. With references or a persona and no quality, the reference build's own count runs (studio_status video.h3_reference_steps). All three follow which turbo files are on disk, so studio_status shows them (video.h3_quality_steps, with the builds behind them in video.h3_turbo_builds). Prefer this over `steps`." },
        steps: { type: "integer", description: "Advanced override of the step count; wins over `quality`. On H3 a value at or below turboMaxSteps (12) selects the turbo LoRA and above it runs the bare model. LTX ignores it — its schedule is fixed." },
        seconds: { type: "integer", description: "Clip length. 5 is the default and what the cost model is anchored on." },
        width: { type: "integer", description: "Frame width. Use a size the engine is trained on — see studio_status / the Video page list. H3 native is 1344x768." },
        height: { type: "integer", description: "Frame height." },
        first_frame: { type: "string", description: "An image name to open on (from list_images or a cover). Pinned at frame 0." },
        last_frame: { type: "string", description: "An image name to end on, pinned at the final frame. Ignored when `loop` is set." },
        /* ⚠ VIDEO-TO-VIDEO. A whole clip where a single opening picture goes.
         * The door refuses this with the catalogue row and `download_model`
         * named in the refusal when the patch is absent, so an assistant can
         * offer the download instead of reporting an unsupported option. */
        source_video: { type: "string", description: "H3 ONLY — drive the whole render with an existing clip (a name from list_clips) instead of one opening picture: its motion and blocking are kept while the prompt restyles it, which is how live footage becomes another look. Needs the H3 Fun ControlNet patch (2.3 GB, catalogue id videoH3FunControl); without it the render is refused with that id and the tool to fetch it, rather than quietly ignoring the clip. The patch is a derivative of H3 and carries H3's territory clause." },
        control_strength: { type: "number", description: "How hard the source clip steers the render, 0 to 2. Default 1. Lower follows the prompt more and the footage less." },
        control_start: { type: "number", description: "Fraction of the sampling run where the control begins, 0 to 1. Default 0." },
        control_end: { type: "number", description: "Fraction where it stops, 0 to 1. Default 1. Ending early lets the model finish freely, which loosens the copy." },
        mid_frames: { type: "array", items: { type: "string" }, maxItems: 4,
          description: "Up to 4 images the clip passes THROUGH, spaced evenly between the ends. Needs both ends set. LTX only. Not style references — the clip lands on each one." },
        loop: { type: "boolean", description: "Seamless loop: reuses the opening picture as the closing one so the clip cuts to its own start." },
        ref_images: { type: "array", items: { type: "string" }, maxItems: 9,
          description: "Image names (from list_images or covers) the prompt refers to as <Picture 1>… in this order. H3 only." },
        persona: { type: "string", description: "A saved character by name (list_personas). Up to 3 of its pictures ride as references after any ref_images, each bound in the prompt as '<Picture N> is <name>.', and its description joins the prompt. H3 only (refused on LTX and FastH3). Write the name where they act." },
        ref_song: { type: "string", description: "A library song file (from list_songs) the prompt refers to as <Audio 1>. H3 only. Re-sung in the clip's own time; not lip-sync (use soundtrack_song)." },
        ref_song_start: { type: "integer", description: "Where the 10-second reference window starts, in seconds. Default 0." },
        soundtrack_song: { type: "string", description: "A library song file the clip is generated ON — the finished clip PLAYS this exact segment (frozen audio latent). Works on both engines; on H3 it also anchors the audio so the model reads the vocal while inventing the picture, which is the tool for lip-synced performance shots WITH character references: the mouth follows the song (measured with pictures of the singer; untested from words alone; on LTX mouths do not follow it); start it where the sung line starts. check_only says it for this engine (soundtrack)." },
        soundtrack_start: { type: "integer", description: "Where the soundtrack segment starts, in seconds. Default 0." },
        negative: { type: "string", description: "What to avoid. LTX only — H3 has no negative prompt." },
        guidance: { type: "number", description: "How literally to follow the prompt (1-8). LTX only." },
        keep_audio: { type: "boolean", description: "Keep the engine's own rendered audio. Default true; a soundtrack clip always keeps it." },
        bridge: { type: "string", description: "H3 only: a conditioning-bridge adapter for THIS render (a file name from video_settings' bridge_adapter options, or \"off\"). Default: the Video panel's setting. A learned rewrite of the words toward action logic (BUNNY) or composition (Semantic Bridge); the authors report about 1 in 10 renders regress." },
        bridge_alpha: { type: "number", minimum: 0, maximum: 1, description: "H3 only: the bridge's blend strength for this render. Publishers recommend 0.10–0.15; 0 bypasses." },
        loras: { type: "array", maxItems: 8, description: "Custom video LoRAs in order, from list_loras. Known wrong architectures and missing files are refused. Engine speed adapters load automatically and must not be listed again. Unrecognized bases remain unverified.", items: { type: "object", required: ["name"], properties: { name: { type: "string" }, strength: { type: "number", minimum: -4, maximum: 4, default: 1 } }, additionalProperties: false } },
        seed: { type: "integer", description: "Reproducible when set. A rolled seed is recorded in the clip's metadata either way." },
        attention: { type: "string", enum: ["pytorch", "kitchen"], description: "FastH3 only: the dense attention under its sparse attention; kitchen = Comfy Kitchen int8 where the engine offers it (PyTorch where it does not). H3 decides its own; LTX has none. Default: kitchen, the one the H3 lab timed FastH3 with." },
        sparse: { type: "string", enum: ["sol-attn", "off"], description: "H3 only: sparse attention on the fast setting (the 3-step build, no references), the Video screen's Advanced \"Sparse attention\" switch. " + H3_SOL_ATTN.note + " Default: the saved setting (video_settings sparse_attention), sol-attn unless changed; name it only to differ for this render." },
        check_only: { type: "boolean", description: "Render nothing: return what this call WOULD render on this card (engine, size, seconds, steps, sparse attention), what the size needs (\"needs about X GB free; you have Y\"), every warning, or the refusal. The Video screen's Advanced line reads the same answer." },
        timeout_seconds: { type: "integer", description: "Default 900. Raise it for a full-quality H3 render at native size." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const loras = videoLoraInput(a.loras);
      let st = await api("GET", "/api/status");
      // A check renders nothing, so it answers with video switched off too.
      if (!st.config?.video?.enabled && a.check_only !== true) {
        throw new Error("Video is switched off. Call set_video_enabled with enabled:true to enable it before rendering.");
      }
      /* ENGINE FIRST, because the engine decides which of the inputs below are
       * even legal. An explicit `engine` switches (the caller named it, so that
       * is intent, not a side effect). An engine-specific input with the WRONG
       * engine selected throws HERE with the fix in the message — the route
       * would refuse it anyway, and an agent that cannot see why is stuck. */
      if (a.engine && a.engine !== st.config?.video?.engine) {
        /* A check changes nothing, the saved engine included. */
        if (a.check_only === true) {
          throw new Error(`check_only reads the selected engine (${st.config?.video?.engine}) and switches nothing; `
            + `call set_video_engine with "${a.engine}" first, or leave engine out.`);
        }
        const sw = await api("POST", "/api/video", { action: "engine", value: a.engine });
        if (sw.error) throw new Error(sw.error);
        st = await api("GET", "/api/status");
      }
      if (st.config?.video?.ready === false) {
        throw new Error(`Video models are not installed: ${(st.config.video.missing || []).join(", ")}`);
      }
      const engine = st.config?.video?.engine;
      const wantsRefs = (Array.isArray(a.ref_images) && a.ref_images.length) || !!a.ref_song || !!a.persona;
      /* The refusals name the engine that IS selected: with three engines,
       * "but LTX is selected" was false on FastH3. The reference sentence is
       * the server's (server/video-plain.js refsIgnored, sent per engine on
       * /api/status), the one the Video screen's reference slots show, with
       * this tool's own way out after it. */
      const engLabel = st.config?.video?.engines?.[engine]?.label || engine || "another engine";
      const said = st.config?.video?.engines?.[engine]?.refsIgnored;
      if (wantsRefs && engine !== "h3" && said) {
        throw new Error(`${said} ${engLabel} is selected: pass engine:"h3"`
          + (engine === "ltx" ? ", or use first_frame/last_frame/mid_frames, which is how LTX takes pictures."
            : "."));
      }
      /* A Studio whose status carries no sentence refuses at the door, in its own words. */
      // Soundtrack works on BOTH engines: LTX freezes the audio latent, H3
      // freezes AND anchors it (the lip-sync pair). No guard on this axis.
      if (Array.isArray(a.mid_frames) && a.mid_frames.length && engine !== "ltx") {
        throw new Error(`mid_frames (pass-through pictures) are an LTX feature, and ${engLabel} is selected. Pass engine:"ltx"`
          + (engine === "h3" ? ", or on H3 use ref_images." : "."));
      }
      const before = a.check_only === true ? new Set()
        : new Set(((await api("GET", "/api/clips")).clips || []).map((c) => c.name));
      /* `quality` is the semantic dial; `steps` is the escape hatch and wins.
       * The mapping lives in the server rather than in the caller's head, or
       * here, because which step counts are MATCHED depends on the disk:
       * config.js resolves stepDefaults from the turbo files pick() found and
       * /api/status sends them. No quality leaves `steps` unset, so the
       * engine's own default (the same `standard`) applies; 20 is the bare
       * model. A literal 8 here ran a 4-step LoRA at 8 steps on an install
       * set up from the Models screen, which fetches no 8-step file. */
      /* MEASURED 2026-09-17 (three prompts, one seed each): the TaoMate 3-step
       * build renders two seconds at native size in 92–157 s against the
       * 8-step build's 148–197 s, and the frames are as coherent and as sharp
       * — so "fast" is 3 steps wherever that file is installed, and the 4-step
       * build where it is not (a 4-step LoRA sampled at 3 is the wrong model).
       * References always keep their own builds; the graph decides. LTX has
       * no stepDefaults and ignores steps; the fallbacks are for it. */
      const qs = engine === "h3" ? st.config?.video?.engines?.h3?.stepDefaults : null;
      const steps = Number.isFinite(a.steps) ? a.steps
        : a.quality === "fast" ? (qs?.fast ?? 4)
        : a.quality === "best" ? (qs?.best ?? 20)
        : undefined;
      const body = {
        action: "create", prompt: a.prompt,
        seconds: Number.isFinite(a.seconds) ? a.seconds : undefined,
        width: Number.isFinite(a.width) ? a.width : undefined,
        height: Number.isFinite(a.height) ? a.height : undefined,
        steps,
        negative: a.negative,
        guidance: Number.isFinite(a.guidance) ? a.guidance : undefined,
        loop: a.loop === true ? true : undefined,
        keepAudio: typeof a.keep_audio === "boolean" ? a.keep_audio : undefined,
        seed: Number.isFinite(a.seed) ? a.seed : undefined,
        bridge: typeof a.bridge === "string" && a.bridge ? a.bridge : undefined,
        bridgeAlpha: Number.isFinite(a.bridge_alpha) ? a.bridge_alpha : undefined,
        // FastH3's per-render pick; the route keeps only "pytorch" | "kitchen".
        attention: a.attention === "kitchen" || a.attention === "pytorch" ? a.attention : undefined,
        // H3's sparse attention on the fast setting; the route keeps only these two.
        sparse: a.sparse === "sol-attn" || a.sparse === "off" ? a.sparse : undefined,
        loras,
      };
      /* ⚠ `fromCover`, not `firstFrame` — the route's field is fromCover (it
       * stages covers AND standalone images). This tool sent `firstFrame` from
       * the day it was written and the route read `b.fromCover`, so the still
       * was silently dropped: every MCP clip rendered from nothing while the
       * response looked like success. */
      /* ⚠ VIDEO-TO-VIDEO, sent as the route names it. The trap below cost
       * every MCP clip its opening still for weeks; a control video dropped
       * the same way would render an ordinary clip and look like the model
       * ignoring the footage. The route reads `sourceVideo`. */
      if (a.source_video) {
        body.sourceVideo = safeName(a.source_video, "clip");
        if (Number.isFinite(a.control_strength)) body.controlStrength = a.control_strength;
        if (Number.isFinite(a.control_start)) body.controlStart = a.control_start;
        if (Number.isFinite(a.control_end)) body.controlEnd = a.control_end;
      }
      if (a.first_frame) body.fromCover = safeName(a.first_frame, "image");
      // Same field naming trap as fromCover: the route reads toCover/midUploads.
      if (a.last_frame) body.toCover = safeName(a.last_frame, "image");
      if (Array.isArray(a.mid_frames) && a.mid_frames.length) {
        body.midUploads = a.mid_frames.slice(0, 4).map((n) => safeName(n, "image"));
      }
      if (Array.isArray(a.ref_images) && a.ref_images.length) {
        body.refImages = a.ref_images.slice(0, 9).map((n) => safeName(n, "image"));
      }
      /* A saved character: the server resolves it, binds its pictures after
       * ref_images and checks the words and pictures before staging. */
      if (typeof a.persona === "string" && a.persona.trim()) body.persona = String(a.persona);
      if (a.ref_song) {
        body.refAudios = [{ name: safeName(a.ref_song, "song"),
                            start: Number.isFinite(a.ref_song_start) ? a.ref_song_start : 0 }];
      }
      if (a.soundtrack_song) {
        body.audioTrack = { name: safeName(a.soundtrack_song, "song"),
                            start: Number.isFinite(a.soundtrack_start) ? a.soundtrack_start : 0 };
      }
      /* THE PLAN, NOT THE RENDER: the same answer the Video screen's Advanced
       * line shows (server/video-plain.js videoPlan, POST /api/video check). */
      if (a.check_only === true) {
        const c = await api("POST", "/api/video", { ...body, action: "check" });
        if (c.error) throw new Error(c.error);
        return {
          would_render: !c.refusal, engine: c.engine ?? null,
          refusal: c.refusal ? (c.refusal.error || c.refusal) : null,
          width: c.width ?? null, height: c.height ?? null, seconds: c.seconds ?? null, steps: c.steps ?? null,
          sparse: c.sparse ?? null,
          vram: c.fit ? { needs_about_gb: c.fit.needGb, card_gb: c.fit.haveGb, fits: !c.fit.over, says: c.fit.sentence, measured: c.fit.scope } : null,
          warnings: (c.warnings || []).map((w) => w.text),
          /* Caveats that change nothing (sparse attention at a size the lab never tried it at). */
          notes: (c.notes || []).map((w) => w.text),
          /* What this render keeps of a person (video-plain.js character). */
          keeps_character: c.character?.keeps ?? null,
          character: c.character?.receipt ?? null,
          character_hint: c.character?.hint ?? null,
          sampler: c.sampler ?? null,
          /* What the song under the clip does on this engine (video-plain.js
           * songUnderSay): lip-sync on H3 with pictures, not on LTX. */
          soundtrack: c.songLine?.hint ?? null,
        };
      }
      const r = await api("POST", "/api/video", body);
      if (r.error) throw new Error(r.error);
      const settled = await waitForArt((Number(a.timeout_seconds) || 900) * 1000, "video", r.job?.id);
      const after = (await api("GET", "/api/clips")).clips || [];
      const made = after.filter((c) => !before.has(c.name)).map((c) => c.name);
      /* What the render changed from the request, and the RAM warning: the
       * door's own sentences (video-plain.js), the ones the page shows. */
      const warnings = (r.warnings || []).map((w) => w.text).filter(Boolean);
      // Its own failure has already thrown; see emptyResultNote in art-wait.js.
      return { clips: made, note: made.length ? undefined : emptyResultNote(settled, r.job?.id, "list_clips"),
        ...(warnings.length ? { warnings } : {}),
        ...(r.character ? { character: r.character.receipt, character_hint: r.character.hint ?? undefined } : {}) };
    },
  },

  {
    name: "list_clips",
    description: "Every clip and imported media file, newest first, with what made it.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer" } },
      additionalProperties: false,
    },
    async run(a) {
      const d = await api("GET", "/api/clips");
      return (d.clips || []).slice(0, Math.max(1, Number(a.limit) || 40)).map((c) => ({
        name: c.name, track: c.track, seconds: c.meta?.clipSeconds ?? null,
        source: c.meta?.source ?? "generated", prompt: c.meta?.prompt ?? null,
      }));
    },
  },

  {
    name: "restyle_clip",
    description:
      "Restyle an existing clip while KEEPING ITS MOTION, with how hard it restyles "
      + "driven by a song's bass. This is the audio-reactive video effect — a clip of a "
      + "person dancing comes back as the same choreography rendered in whatever look you "
      + "describe.\n\n"
      + "How it works, because it explains the parameters: it runs at FULL denoise and "
      + "holds the motion with guide frames taken from the source, rather than holding "
      + "denoise down. Holding denoise down does not work — measured, one pass strong "
      + "enough to restyle also destroys the figure.\n\n"
      + "`guide_every` is the dial that matters. Measured on a 121-frame clip: every 8 "
      + "frames reproduces the source with NO restyle; every 16 gives the look with the "
      + "motion still followed; every 24 is looser. Guide strength has a narrow usable "
      + "band (~0.26-0.46) and is set from the song automatically when you name one.\n\n"
      + "⚠ Give it a NEGATIVE prompt. LTX has real classifier-free guidance, so unlike the "
      + "image model the negative genuinely works, and it is the cheapest control here — "
      + "it is how you keep the framing wide and the subject clothed.\n\n"
      + "Takes about two minutes for five seconds at 24fps. Blocks until done. Recorded in the provenance ledger as an agent action (actor agent:*) — provenance_read shows it.",
    inputSchema: {
      type: "object",
      required: ["clip", "prompt"],
      properties: {
        clip: { type: "string", description: "A clip name from list_clips." },
        prompt: { type: "string", description: "The look. Describe the subject too, not only the style." },
        negative: { type: "string", description: "What to keep out. Strongly recommended." },
        song: { type: "string", description: "A song file from list_songs. Its bass drives how hard each section restyles." },
        start: { type: "number", description: "Where in the song to read the audio from, in seconds." },
        band: { type: "string", enum: ["bass", "low", "mid", "high"], description: "Which band drives it. Default bass." },
        guide_every: { type: "integer", description: "Frames between guides. 8 = no restyle, 16 = the default, 24 = looser." },
        guide_strength: { type: "number", description: "Flat strength when no song is given. 0.26-0.46 is the usable band." },
        seed: { type: "integer" },
        timeout_seconds: { type: "integer", description: "Default 1800." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const before = new Set(((await api("GET", "/api/clips")).clips || []).map((c) => c.name));
      const r = await api("POST", "/api/restyle", {
        name: safeName(a.clip, "clip"),
        prompt: a.prompt, negative: a.negative,
        song: a.song ? safeName(a.song, "song") : undefined,
        start: a.start, band: a.band,
        guideEvery: a.guide_every, guideStrength: a.guide_strength,
        seed: Number.isFinite(a.seed) ? a.seed : undefined,
      });
      if (r.error) throw new Error(r.error);
      const settled = await waitForArt((Number(a.timeout_seconds) || 1800) * 1000, "restyle", r.job?.id);
      const after = (await api("GET", "/api/clips")).clips || [];
      const made = after.filter((c) => !before.has(c.name)).map((c) => c.name);
      return {
        clips: made,
        guides: r.guides ?? null,
        bpm: r.bpm ?? null,
        // Shown so the caller can see the audio actually reached the render.
        guide_strengths: r.strengths ? r.strengths.map((x) => Number(x.toFixed(3))) : null,
        // Its own failure has already thrown; see emptyResultNote in art-wait.js.
        note: made.length ? undefined : emptyResultNote(settled, r.job?.id, "list_clips"),
      };
    },
  },

  {
    name: "extend_clip",
    description:
      "Continue a finished clip: MiniMax H3 picks up from its last second and renders what "
      + "happens next, then the two are joined into a NEW clip (the source is untouched; the new "
      + "frames alone are kept beside it as <id>_new.mp4). H3 only. The source's last 17k+5 frames "
      + "(about a second) are anchored as a native guide, so motion, light and sound carry across "
      + "the seam; the words decide what happens after it. `seconds` is snapped up to a multiple of "
      + "17 frames. Blocks until done — a few minutes on the turbo path. The join needs ffmpeg on "
      + "the machine; without it the new frames come back on their own and the clip's record says so.",
    inputSchema: {
      type: "object",
      required: ["clip"],
      properties: {
        clip: { type: "string", description: "A clip name from list_clips (.mp4/.webm, rendered by H3 or imported)." },
        seconds: { type: "number", description: "How much to add, 1–20. Default 3." },
        prompt: { type: "string", description: "What happens next. Default: the source clip's own prompt, which continues the same action." },
        steps: { type: "integer", description: "Step count; default the source's, else the engine's." },
        overlap_frames: { type: "integer", description: "How much of the tail to hand the model as context, snapped down to 17k+5. Default 22." },
        bridge: { type: "string", description: "A conditioning-bridge adapter for this render, or \"off\" (see make_clip). Default: the Video panel's setting." },
        bridge_alpha: { type: "number", minimum: 0, maximum: 1, description: "The bridge's blend strength for this render." },
        loras: { type: "array", maxItems: 8, description: "Custom H3 adapters for this continuation; list_loras supplies filenames. Engine speed adapters load automatically. This does not inherit the source clip's custom stack.", items: { type: "object", required: ["name"], properties: { name: { type: "string" }, strength: { type: "number", minimum: -4, maximum: 4, default: 1 } }, additionalProperties: false } },
        seed: { type: "integer" },
        timeout_seconds: { type: "integer", description: "Default 900." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const before = new Set(((await api("GET", "/api/clips")).clips || []).map((c) => c.name));
      const loras = videoLoraInput(a.loras);
      const r = await api("POST", "/api/video", {
        action: "extend", clip: safeName(a.clip, "clip"),
        seconds: a.seconds, prompt: a.prompt, steps: a.steps,
        overlapFrames: a.overlap_frames,
        loras,
        bridge: typeof a.bridge === "string" && a.bridge ? a.bridge : undefined,
        bridgeAlpha: Number.isFinite(a.bridge_alpha) ? a.bridge_alpha : undefined,
        seed: Number.isFinite(a.seed) ? a.seed : undefined,
      });
      if (r.error) throw new Error(r.error);
      const settled = await waitForArt((Number(a.timeout_seconds) || 900) * 1000, "video", r.job?.id);
      const after = (await api("GET", "/api/clips")).clips || [];
      const made = after.filter((c) => !before.has(c.name) && !/_new\.mp4$/i.test(c.name));
      const mine = made.find((c) => c.name === `${r.id}.mp4`) || made[0] || null;
      return {
        clip: mine?.name ?? null,
        extended_from: safeName(a.clip, "clip"),
        joined: mine?.meta?.continuation?.joined ?? null,
        new_frames_clip: mine?.meta?.continuation?.newClip ?? null,
        overlap_frames: r.overlapFrames, extension_frames: r.extensionFrames,
        extension_seconds: r.extensionSeconds,
        note: mine ? (mine.meta?.continuation?.joined === false ? `Not joined: ${mine.meta.continuation.error}` : undefined)
          // Its own failure has already thrown; see emptyResultNote in art-wait.js.
          : emptyResultNote(settled, r.job?.id, "list_clips"),
      };
    },
  },

  {
    name: "reactive_render",
    description:
      "Render pictures or video with a song. Cuts, crossfade, pulse, film and psychedelic use the CPU compositor; "
      + "paint and motion use GPU diffusion. Pass library pictures/clips or a prompt to generate pictures first. "
      + "motion.profile yvann selects the experimental LCM remix, with drum-stem frame-RMS transitions. "
      + "motion.sourceStart/sourceSpeed control source video independently of the song start. "
      + "Depth/line structure and optional reference anchors guide the result; appearance and speed depend on the profile. "
      + "Call reactive_status for installed choices. The generated composition is editable with vfx_* tools; "
      + "poll vfx_render_status for its final movie. Diffusion preparation can hold this call for a long time. "
      + "This does not recreate the separate handcrafted intro/outro of the experimental Yvann deliverable.",
    inputSchema: {
      type: "object",
      required: ["song"],
      properties: {
        song: { type: "string", description: "A library song file name." },
        pictures: { type: "array", items: { type: "string" }, maxItems: 64, description: "Image names from list_images and/or clip names from list_clips, in order. Omit to make pictures from `prompt`." },
        hits: { type: "string", enum: ["mix", "drums"], description: "Where the beats and hits are read: the whole mix (default) or the separated drum stem." },
        prompt: { type: "string", description: "With no pictures: what the pictures should show; `count` of them are made first." },
        count: { type: "integer", minimum: 1, maximum: 24, description: "How many pictures to make from the prompt. Default 6." },
        style: { type: "string", enum: ["cuts", "crossfade", "pulse", "film", "psychedelic", "paint", "motion"], description: "The look. Default cuts. \"paint\" repaints a clip frame by frame; \"motion\" repaints it under the AnimateDiff motion module (see above)." },
        motion: {
          type: "object", description: "Style \"motion\" dials (advanced). With PICTURES in `pictures` they are the look and switch on the drum-stem beats through our IP-Adapter node (ipWeight 0-2, default 1; transition = frames of cross-fade ending on each hit, default 5; lookWithPictures = the one short prompt kept, default \"4k, beautiful, high quality, highly detailed, art\"). Without pictures, looks: the prompts the piece cycles through on the bars (default: three liquid-paint palettes). depth 0-1.5 (the depth ControlNet's hold: 0.3 keeps the room, 0.2 paints over it); lineart 0-1.5; cfg 1-15; steps 4-40 (20); seed (424242). Left out, depth/lineart/cfg default to 0.4 / 0.5 / 7 with pictures (the reference's 0.3 firmed up a little so the figure keeps its shape under the paint) and to the painted look's 0.2 / 0.25 / 8 with prompts.",
          properties: {
            profile: { type: "string", enum: ["standard", "yvann"], description: "Standard preserves the existing v3 recipe. yvann selects the experimental LCM remix: AnimateLCM + LiquidAF 0.4, 8 steps, CFG 2, Depth Anything V2 Large, AnyLine and drum RMS image transitions. The tested configuration disables the v3 domain adapter, SparseCtrl anchors and detail pass by default. Optional reference anchoring can overwhelm the source; this is not an exact Yvann reproduction." },
            anchorMode: { type: "string", enum: ["source", "references"], description: "SparseCtrl anchors use either source-video frames or selected reference pictures cycling on hits. Default source for standard, references for yvann; references requires pictures." },
            sourceStart: { type: "number", minimum: 0, maximum: 3600, description: "Source VIDEO starting second, independent of the song's start. Default 0." },
            sourceSpeed: { type: "number", minimum: 0.1, maximum: 4, description: "Source video playback speed. Default 1; 2 consumes twice as much source motion per output second." },
            looks: { type: "array", items: { type: "string" }, maxItems: 16 },
            depth: { type: "number" }, lineart: { type: "number" }, cfg: { type: "number" },
            iris: { type: "number", minimum: 0, maximum: 1, description: "0-1, default 0 (off): the reference's black circle, growing on the bass. A black card over the finished frames with a round hole cut in it; the bass scales the card. THE NUMBER SETS HOW CLOSED IT IS BETWEEN THE HITS, and the peak is always the frame's corner — so on every bass peak the whole picture is there, whatever the number. At 1 the resting hole is half the corner radius and doubles on the beat; at 0.2 it is nine tenths of it and barely breathes; 0.4 to 0.6 is the reference's look. A compositor shape, not something the diffusion knows about. On a piece whose bass never moves it is a fixed dark frame." },
            hintLift: { type: "number", minimum: 1, maximum: 4, description: "1-4, default 2.2 when you pass pictures and 1 otherwise: how far the bottom of the range is opened BEFORE the depth and line-art preprocessors see the frames, and only them — what the sampler paints keeps its own blacks. A figure on a black stage sits in the bottom five per cent of an eight-bit range (measured: 83.5% of one real dance frame under luminance 0.05, the figure's own column averaging 0.068), so the estimator is not weak, it is blind; 2.2 multiplies the edge energy inside the figure by 2.2. Above about 2.4 the compression blocking in the background comes up with it and the line-art pass traces that too. 1 is off and renders the graph every piece before 2026-09-20 had." },
            motionScale: { type: "number", minimum: 0.1, maximum: 3, description: "How hard the picture moves between frames — AnimateDiff's own motion scale (ADE's scale_multival). 1 is the module's own and is what every earlier piece rendered at, so a graph at 1 is unchanged. The profile selects its own motion model; this controls the installed module's motion strength. Above about 1.5 the motion stops being motion and becomes churn — where exactly is not measured here." },
            sourceHold: { type: "number", minimum: 0, maximum: 2, description: "SparseCtrl anchor strength, default 0 (off) in both profiles. anchorMode chooses source-video frames or reference pictures. Strength 1 with references tries the published workflow's anchoring, which can overwhelm the source; matching its appearance remains unverified." },
            sourceHoldEnd: { type: "number", description: "0.1-1: how far through each pass the source hold stays on. Default 0.5 (the reference's)." },
            depthEnd: { type: "number", description: "0.1-1: how far through each pass the depth hold stays on (the figure's volumes). Default 0.6 with pictures, 0.5 with prompts. The second pass holds the same fraction of its own steps." },
            lineartEnd: { type: "number", description: "0.1-1: how far through each pass the line-art hold stays on (the figure's edges). Default 0.7." }, steps: { type: "integer" }, seed: { type: "integer" },
            ipWeight: { type: "number" }, transition: { type: "integer" }, lookWithPictures: { type: "string" },
            hitsOn: { type: "string", enum: ["beats", "bars"], description: "Standard profile: switch on beats or bars. Yvann always measures frame RMS peaks from the selected drum-audio window instead of the tempo grid." },
            hitGap: { type: "integer", description: "Least frames between two hits, default 5 (the reference's min distance). 11 makes every other beat a hit at 128 bpm." },
            motionModel: { type: "string", description: "BRING YOUR OWN, nothing shipped: a motion module file in the engine's animatediff_models folder to run instead of v3 (the reference runs AnimateLCM, which has no licence text and is not in the catalogue). reactive_status lists what the folder holds." },
            motionLora: { type: "string", description: "Installed motion LoRA filename in animatediff_motion_lora. The experimental Yvann profile selects LiquidAF-0-1.safetensors at 0.4." },
            motionLoraStrength: { type: "number", description: "0-2, default 1." },
            modelLora: { type: "string", description: "Your own SD1.5 LoRA file in loras. Standard applies it after the v3 domain adapter; the experimental LCM remix skips that domain adapter." },
            modelLoraStrength: { type: "number", description: "0-2, default 1." },
            sampler: { type: "string", enum: ["dpmpp_2m", "dpmpp_2m_sde", "euler", "euler_ancestral", "lcm", "ddim", "uni_pc"], description: "Default dpmpp_2m; lcm with an LCM module and cfg 2 is the reference's setting." },
            scheduler: { type: "string", enum: ["karras", "sgm_uniform", "normal", "simple", "exponential", "beta"], description: "Default karras; sgm_uniform is the reference's with lcm." },
            hires: { type: "boolean", description: "Optional detail pass. Standard defaults true with latent2x upscale; the experimental LCM remix defaults false and uses Lanczos pixel1.5 if enabled. Off renders one pass at 768x432 landscape. Detail repaint amount is hiresDenoise." },
            hiresDenoise: { type: "number", description: "0.2-0.9, default 0.55: how much the second pass repaints." },
            smooth: { type: "boolean", description: "Default true: the 12 fps render is motion-interpolated to 24 fps (ffmpeg, CPU) before the compositor takes it." },
          }, additionalProperties: false,
        },
        paint: {
          type: "object", description: "Style \"paint\" dials (advanced). denoiseMin 0.2-0.95 (default 0.66: how hard each frame is repainted), denoiseRange 0-0.5 (0.2: how much more on a loud bass), source 0-1 (0.65: how hard the source re-asserts itself), colour 0-1 (0.4: colour held to the first frame), fps 6-24 (12), steps 4-30 (12), seed, styleA/styleB (the two prompts the piece travels between).",
          properties: {
            denoiseMin: { type: "number" }, denoiseRange: { type: "number" }, source: { type: "number" }, colour: { type: "number" },
            fps: { type: "number" }, steps: { type: "integer" }, seed: { type: "integer" }, styleA: { type: "string" }, styleB: { type: "string" },
          }, additionalProperties: false,
        },
        cut: { type: "string", enum: ["bar", "beat", "hit"], description: "A new picture on every bar (default), beat, or onset above the threshold." },
        start: { type: "number", minimum: 0, description: "The second of the song the piece begins at. Default 0. A dance track's drums may come in later; start where they do." },
        seconds: { type: "number", minimum: 2, maximum: 600, description: "Length from `start`. Default: the rest of the song." },
        orientation: { type: "string", enum: ["landscape", "portrait", "square"], description: "1920×1080, 1080×1920 or 1080×1080. Default landscape." },
        name: { type: "string", description: "The comp's name. Default \"Reactive · <song>\"." },
        threshold: { type: "number", minimum: 0, maximum: 1, description: "For cut \"hit\": the onset level a hit must reach. Default 0.5." },
        min_gap: { type: "number", minimum: 0.05, maximum: 5, description: "For cut \"hit\": least seconds between two hits. Default 0.25." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/reactive/run", {
        song: safeName(a.song, "song"),
        pictures: Array.isArray(a.pictures) ? a.pictures.slice(0, 64).map((n) => safeName(n, "image")) : undefined,
        prompt: a.prompt, count: a.count, style: a.style, cut: a.cut, hits: a.hits, start: a.start, seconds: a.seconds,
        orientation: a.orientation, name: a.name, threshold: a.threshold, minGap: a.min_gap, paint: a.paint, motion: a.motion,
      }, a.style === "paint" ? 180 * 60_000 : a.style === "motion" ? 120 * 60_000 : 30 * 60_000);
      if (r?.error) throw new Error(r.error);
      return r;
    },
  },

  {
    name: "build_music_video",
    description:
      "Assemble a music video: the song on an audio track, the clips laid onto BAR LINES of "
      + "its measured beat grid, with the effects you choose. Saves a Studio project.\n\n"
      + "The clip list REPEATS until the song is covered, so four clips will fill three "
      + "minutes.\n\n"
      + "`drive` is the important one:\n"
      + "  pulse    — effects hit on each beat. Punchy and obviously rhythmic.\n"
      + "  envelope — effects follow loudness continuously. Breathing and hypnotic; this is "
      + "the one that produces a slow morph, and what most 'audio reactive' reference clips "
      + "actually use.\n"
      + "  both     — a kick still lands inside a swell.\n\n"
      + "⚠ This writes a project. It does NOT export a video file: Studio's export is a "
      + "real-time browser capture, so a person opens the project and presses Export video.",
    inputSchema: {
      type: "object",
      required: ["song", "clips"],
      properties: {
        song: { type: "string", description: "File name from list_songs." },
        clips: { type: "array", items: { type: "string" }, description: "Clip or image names, in the order they should appear." },
        name: { type: "string", description: "Project name." },
        bars_per_clip: { type: "integer", description: "How long each clip holds, in bars. 1 is a fast cut, 4 is stately. Default 1." },
        beat_mult: { type: "number", description: "0.5 for half time, 2 for double. Use 0.5 when get_beats reports roughly twice the tempo you would tap." },
        effect: { type: "string", enum: ["none", "punch", "pull", "shake", "tilt", "blur", "hue", "sat", "strobe", "flash", "rgb"] },
        drive: { type: "string", enum: ["pulse", "envelope", "both"] },
        band: { type: "string", enum: ["bass", "low", "mid", "high", "full"] },
        look: { type: "string", enum: ["none", "warm", "cool", "vivid", "faded", "mono", "noir", "dream", "vhs", "infra", "bleach"] },
        amount: { type: "number", description: "0-1, how hard the effect reacts." },
        drift: { type: "number", description: "0-1, slow Ken Burns push across the whole video." },
        vignette: { type: "number", description: "0-1." },
        sensitivity: { type: "number", description: "0-1. A threshold in pulse mode, a gain in envelope mode." },
        smoothing: { type: "number", description: "0-1. How slowly the envelope drive moves. Higher is more hypnotic." },
        visualiser: { type: "string", enum: ["off", "bars", "wave", "radial"] },
      },
      additionalProperties: false,
    },
    run: buildMusicVideo,
  },

  {
    name: "list_projects",
    description: "Saved Studio projects.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const d = await api("GET", "/api/studio/projects");
      return (d.projects || []).map((p) => ({ name: p.name, file: p.file, items: p.items }));
    },
  },

  {
    name: "studio_bounce",
    description:
      "Mix a saved Studio project's audio tracks down to one file. This renders what you would "
      + "HEAR if you pressed play on the timeline: every track's volume and mute, the solo buttons, "
      + "and each clip's fade-in, fade-out and in-point, all applied the same way playback applies "
      + "them. Video tracks are picture only and are not in the mix.\n"
      + "The file lands in the MUSIC LIBRARY, not the clip folder — so it appears in Music, plays, "
      + "takes cover art and can be tagged or converted like any other track. Returns its filename.\n"
      + "Unlike build_music_video this does not need a browser: the mix is rendered on the server, "
      + "faster than real time. It is the audio half of Export; the picture still needs a person to "
      + "open Studio and press Export video.\n"
      + "Normalisation is on by default: -14 dBFS RMS (plain RMS, not K-weighted LUFS) under a "
      + "-1 dBFS peak ceiling. The ceiling wins, so read `rms_db` in the reply when the loudness "
      + "matters — it says where the mix actually landed, not where it was aimed. Recorded in the provenance ledger as an agent action (actor agent:*) — provenance_read shows it.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "The saved project's name, as list_projects reports it." },
        format: { type: "string", enum: ["flac", "mp3"], description: "flac is lossless and the default." },
        normalize: { type: "boolean", description: "Default true. False bounces at the levels the timeline is set to." },
        rms_db: { type: "number", description: "Target RMS in dBFS, default -14. Negative." },
        peak_db: { type: "number", description: "Peak ceiling in dBFS, default -1. Negative, and it overrides rms_db." },
      },
      required: ["project"],
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/studio/bounce", {
        project: String(a.project || ""),
        format: a.format === "mp3" ? "mp3" : "flac",
        normalize: a.normalize === false ? null
          : { rmsDb: a.rms_db ?? -14, peakDb: a.peak_db ?? -1 },
      // A long timeline decodes every source it touches, so this gets the render
      // budget rather than the default one meant for a status call.
      }, 600_000);
      if (r.error) throw new Error(r.error);
      return {
        file: r.name, title: r.title, seconds: r.seconds,
        tracks_mixed: r.tracks, items_mixed: r.items,
        rms_db: r.rmsDb, peak_db: r.peakDb, gain_db: r.gainDb, clipped_samples: r.clipped,
        where: "Your music library — open Music and it is at the top.",
      };
    },
  },

  {
    name: "provenance_read",
    description:
      "The provenance ledger for a library item or a VFX comp: the per-item origin summary "
      + "(human-recorded / human-authored / ai-generated / ai-assisted-human-edited / "
      + "third-party-licensed), the event trail, and the hash-chain head. Every action driven "
      + "over MCP is recorded with an agent:* actor — an agent's edits never count as human "
      + "editing — so read this BEFORE making any claim about who made what.\n"
      + "Library assets are addressed as a song file name, images/<name>, clips/<name>, "
      + "covers/<name> or notes/<source>; pass slug to read a VFX comp's own ledger "
      + "(renders/<name> assets) instead. verify walks the whole chain — it proves internal "
      + "consistency (no silent edits), not authenticity: this is unsigned local data.",
    inputSchema: {
      type: "object",
      properties: {
        asset: { type: "string", description: "Exact asset id. Omit for the whole ledger (with prefix or alone)." },
        prefix: { type: "string", description: "Asset-id prefix filter, e.g. images/ or clips/." },
        slug: { type: "string", description: "A VFX comp slug — reads <comp>/provenance.jsonl instead of the library ledger." },
        limit: { type: "integer", description: "Max events returned, newest kept (default 100, cap 500)." },
        verify: { type: "boolean", description: "Also walk the full hash chain and report ok/brokenAt." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const q = new URLSearchParams();
      if (a.asset) q.set("asset", String(a.asset));
      if (a.prefix) q.set("prefix", String(a.prefix));
      if (a.slug) q.set("slug", safeName(a.slug, "comp slug"));
      if (a.limit) q.set("limit", String(a.limit));
      if (a.verify) q.set("verify", "1");
      const r = await api("GET", `/api/provenance?${q.toString()}`);
      if (r.error) throw new Error(r.error);
      return {
        scope: r.scope, asset: r.asset, summary: r.summary,
        chain_head: r.chainHead, chain: r.chain ?? undefined,
        events: (r.events || []).map((e) => ({
          id: e.id, t: e.t, actor: e.actor, type: e.type, asset: e.asset, data: e.data,
        })),
        total: r.total,
      };
    },
  },
  // Video Workflow (FORK — see FORK_DELTA.md): the whole music-video pipeline.
  ...mvTools(api, safeName),
  /* The Video lab (FORK): run one prompt through several engine configurations,
   * choose a size with its measured consequence attached, and move the turbo
   * machinery. Same /api/videolab actions the Video panel posts — see
   * server/videolab/ui_test.js, which fails the commit if the two drift. */
  ...videoLabTools(api),
  /* THE ENGINE DOOR (FORK). Last in the list, because it is the raw layer under
   * everything above it: an arbitrary ComfyUI graph, run on this machine, with
   * the whole technical record written before the GPU spends anything. An agent
   * should reach for a finished verb first — make_clip, make_image — and come
   * here when there is no verb for what it needs. Same /api/engine actions
   * web/engine.js posts; server/engine/ui_test.js fails the commit if they
   * drift. */
  ...engineTools(api),
  /* ── Enhance and the saved galleries (server/prompt-tools.js) ──────────
   * One tool per field, so an agent can improve exactly the part it means to.
   * They return the improved text; nothing is written into the page and no
   * render starts. A local model is refused while a render holds the card. */
  ...["style", "lyrics", "simple"].map((field) => ({
    name: { style: "enhance_style", lyrics: "enhance_lyrics", simple: "enhance_description" }[field],
    description: {
      style: "Improve a song's STYLE line with the language model chosen for Enhance (a connected API, or a local model run through ComfyUI): one comma-separated line of tags covering genre, vocals, instruments, mood, tempo and production, keeping every idea already there. Returns the new style text only; pass it to make_song as `caption`. A local model is refused while a render is using the graphics card; an API model is not.",
      lyrics: "Improve or write LYRICS with the Enhance model: keeps the meaning and working lines, tightens rhythm, adds a repeatable chorus, and structures it with [Verse] / [Chorus] / [Bridge] tags. With empty lyrics it writes a whole song from `style`. Returns the lyrics only. A local model is refused while a render is using the graphics card.",
      simple: "Improve a short SONG IDEA (the Music page's Simple mode description) into two to four sentences: topic, genre, mood, who sings, tempo and a concrete detail. Returns the description only. A local model is refused while a render is using the graphics card.",
    }[field],
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", maxLength: 8000, description: field === "lyrics" ? "The current lyrics; may be empty." : field === "style" ? "The current style line." : "The current idea." },
        ...(field === "lyrics" ? { style: { type: "string", maxLength: 2000, description: "The song's style, so the words fit it." } } : {}),
        ...(field === "style" ? { lyrics: { type: "string", maxLength: 8000, description: "Optional lyrics, so the style fits them." } } : {}),
        ...(field === "simple" ? {} : { engine: { type: "string", enum: ["yue2", "yue2-comfy", "yue2-gguf", "minimax-music3"], description: "Which music engine the text is for (its tag style differs). Default yue2." } }),
      },
      required: field === "lyrics" ? [] : ["text"],
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/enhance", { field, text: a.text || "", style: a.style, lyrics: a.lyrics, engine: a.engine }, 300_000);
      if (r?.error) throw new Error(r.error);
      return { text: r.text, model: r.model, local: !!r.local };
    },
  })),

  {
    name: "enhance_model",
    description: "Which language model the Enhance tools (enhance_style, enhance_lyrics, enhance_description) use, and the choices. With `model`, choose one: a value from `models[].file`, e.g. \"api:anthropic\" for a connected API or a local model file. With none chosen, Enhance uses Simple mode's model, then Chat's. `models` lists the ones that can write, by name (the same list every writer picker on the page shows); files that cannot (a base model, ACE-Step's planners, LTX's encoder, an fp4 build off an RTX 50-series card) are in `not_writers` with the reason.",
    inputSchema: {
      type: "object",
      properties: { model: { type: "string", description: "Optional: the model to use from now on." } },
      additionalProperties: false,
    },
    async run(a) {
      const r = a.model ? await api("POST", "/api/enhance", { action: "model", model: a.model }) : await api("GET", "/api/enhance");
      if (r?.error) throw new Error(r.error);
      return { current: r.current, models: (r.models || []).map((m) => ({ file: m.file, label: m.label || m.file, api: !!m.api })), offline: !!r.offline,
        not_writers: (r.every || []).filter((m) => m.why).map((m) => ({ file: m.file, why: m.why })) };
    },
  },

  {
    name: "timed_lyrics_python",
    description: "Which Python timed lyrics run in, and whether they can: whisper needs faster-whisper AND stable-ts in THAT interpreter, not the python on PATH. With no `python`, reports the interpreter, where it came from (the default venv, Settings, or AIPLAY_WHISPER_PYTHON), whether both import, and the install lines when they do not. With `python` (the full path to an existing python.exe or bin/python), makes it the one timed lyrics use, at once and across restarts: the same field as Settings > Songs > timed lyrics python. \"\" goes back to the default venv. AIPLAY_WHISPER_PYTHON, when set, still wins, and the answer says so.",
    inputSchema: {
      type: "object",
      properties: { python: { type: "string", maxLength: 1024, description: "Optional: the full path of the python to use from now on; \"\" for the default." } },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/lyrics", a.python === undefined ? { action: "python" } : { action: "python", value: a.python });
      if (r?.error) throw new Error(r.error);
      return r.lyrics;
    },
  },

  {
    name: "separate_stems",
    description: "Split a library song into its four stems — vocals, drums, bass, other — with demucs (htdemucs_ft), "
      + "the Studio's own separation: the Separate stems button on a song. It is queued behind music like cover art "
      + "and returns at once with a job id; list_songs shows has_stems when it lands. htdemucs_ft runs four models in "
      + "turn: measured here at about 12 s for a 30 s track on the graphics card; on a processor it is slower, by an "
      + "amount not measured. The first run also fetches 336 MB of separation weights. A "
      + "song that is already being separated is joined rather than queued twice. When the stem separation python "
      + "lacks demucs or PyTorch it is refused at once by sentence, with setup id \"stems\": call setup_feature "
      + "{\"id\":\"stems\"} once the person agrees, or name their own python with stems_python. stop_generation stops it.",
    inputSchema: {
      type: "object",
      required: ["file"],
      properties: { file: { type: "string", description: "The library file name (from list_songs)." } },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/stems", { action: "run", file: safeName(a.file, "song") });
      if (r?.error) throw new Error(refusalText(r));
      return {
        job_id: r.jobId ?? null, joined: !!r.joined,
        note: r.joined ? "This song was already being separated; that job is the one to wait for."
          : "Queued. It starts when the music queue is empty; list_songs shows has_stems when it lands.",
      };
    },
  },

  {
    name: "stop_generation",
    description: "Stop what is generating for this person — the Stop button: the song rendering now and the songs "
      + "queued behind it, the pictures, stems and timed lyrics queued behind those, and the one running among them. "
      + "Other work on the engine (a chat turn, a friend's render, a gate run) keeps its place. Returns the song "
      + "queue as it stands and art_stopped: how many queued jobs were dropped, what was running, and whether it is "
      + "still stopping (a separation's process can take a moment to end; the Jobs page says \"stopping\" until it has).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const r = await api("POST", "/api/cancel", {});
      if (r?.error) throw new Error(refusalText(r));
      return {
        art_stopped: r.artStopped ?? null,
        current: r.current ? { id: r.current.id, title: r.current.title, state: r.current.state } : null,
        queued: Array.isArray(r.queue) ? r.queue.length : 0,
      };
    },
  },

  {
    name: "stems_python",
    description: "Which Python stem separation (and the audio-reference encoder) run in, and whether it can: demucs "
      + "needs demucs AND PyTorch in THAT interpreter, not the python on PATH. With no `python`, reports the "
      + "interpreter, where it came from (the default, Settings, or AIPLAY_SYS_PYTHON), and whether both import. With "
      + "`python` (the full path to an existing python.exe or bin/python), makes it the one stem separation uses, at "
      + "once and across restarts: the same field as Settings > Songs > stem separation python. \"\" goes back to the "
      + "default. AIPLAY_SYS_PYTHON, when set, still wins, and the answer says so. setup_feature {\"id\":\"stems\"} "
      + "builds one instead.",
    inputSchema: {
      type: "object",
      properties: { python: { type: "string", maxLength: 1024, description: "Optional: the full path of the python to use from now on; \"\" for the default." } },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/stems", a.python === undefined ? { action: "python" } : { action: "python", value: a.python });
      if (r?.error) throw new Error(refusalText(r));
      return r.stems;
    },
  },

  {
    name: "prompt_gallery",
    description: "The saved galleries the Music and Chat pages share: `styles`, `lyrics`, `simple` (Simple-mode descriptions) and `chat` (chat prompts). action list (default) returns the saved entries, newest first; save stores `text` (an identical entry moves to the top); delete removes the entry with `id`.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["styles", "lyrics", "simple", "chat", "image", "video"] },
        action: { type: "string", enum: ["list", "save", "delete"], description: "Default list." },
        text: { type: "string", maxLength: 8000, description: "save: what to store." },
        name: { type: "string", maxLength: 80, description: "save: an optional short name." },
        id: { type: "string", description: "delete: the entry's id from list." },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    async run(a) {
      const action = a.action || "list";
      if (action === "list") {
        const r = await api("GET", `/api/gallery?kind=${encodeURIComponent(a.kind)}`);
        if (r?.error) throw new Error(r.error);
        return r.items;
      }
      const r = await api("POST", "/api/gallery", { action, kind: a.kind, text: a.text, name: a.name, id: a.id });
      if (r?.error) throw new Error(r.error);
      return r;
    },
  },

];

/**
 * Name and one-line purpose of every tool, for the in-app explanation page.
 *
 * Exported from HERE rather than typed out over there, so the page cannot claim
 * a tool that does not exist or miss one that does — the same reason the Thanks
 * page builds its licence table from the live model catalogue.
 */
export const TOOL_SUMMARY = () => TOOLS.map((t) => ({
  name: t.name,
  // The first sentence is the summary; the rest is guidance for the model.
  summary: String(t.description).split(/\.\s/)[0].split("\n").join(" ").trim() + ".",
  required: t.inputSchema?.required || [],
  params: Object.keys(t.inputSchema?.properties || {}),
}));

/* ───────────────────────────────────────────────── the MCP transport */

const PROTOCOL_VERSION = "2024-11-05";
const byName = new Map(TOOLS.map((t) => [t.name, t]));

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    return reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "aiplay-studio", version: "1.0.0" },
      // The one sentence a client shows its model before any tool is called.
      instructions:
        "Call pipeline_guide first: it maps which of these tools to use at each "
        + "stage of making a music video or an episodic series.",
    });
  }
  // Notifications carry no id and expect no answer. Replying to one is a
  // protocol error, not a harmless extra.
  if (id === undefined) return;

  if (method === "tools/list") {
    return reply(id, {
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
  }

  if (method === "tools/call") {
    const tool = byName.get(params?.name);
    if (!tool) return replyError(id, -32602, `No such tool: ${params?.name}`);
    try {
      const result = await tool.run(params.arguments || {});
      /* PICTURES CAN COME BACK NOW, and until this line they could not.
       *
       * Every tool result was JSON.stringify'd into a text block, so an agent
       * driving this app could make an image and never see it. That is not a
       * cosmetic gap: image models fail in ways only a look catches — a guitar
       * with five strings, a hand with the wrong number of fingers, text that
       * is nearly words. The app reported success because ComfyUI returned a
       * file, and the file was wrong.
       *
       * A tool opts in by putting `_images: [{ data, mimeType }]` on its
       * result; the field is stripped from the JSON so the text half stays
       * clean. MCP carries image content natively — nothing here needed
       * inventing, it simply was never used. */
      const shots = Array.isArray(result?._images) ? result._images : null;
      const text = shots ? { ...result, _images: undefined } : result;
      return reply(id, {
        content: [
          { type: "text", text: JSON.stringify(text, null, 2) },
          ...(shots || []).map((im) => ({
            type: "image", data: im.data, mimeType: im.mimeType || "image/png",
          })),
        ],
      });
    } catch (err) {
      /* An error the MODEL should see and act on, not a transport failure — so
       * it goes back as a successful call carrying isError, which is what lets
       * an agent read "video is switched off" and go and switch it on. */
      return reply(id, {
        content: [{ type: "text", text: String(err.message || err) }],
        isError: true,
      });
    }
  }

  return replyError(id, -32601, `Unknown method: ${method}`);
}

/* Newline-delimited JSON on stdin. Buffered, because a message can arrive split
 * across reads and parsing a half-message would drop it silently. */
/* ⚠ Only wire up stdin when this file is RUN, not when it is imported.
 *
 * `/api/mcp` imports it for the tool list, and a module that starts reading
 * stdin on import would quietly steal the server's own input stream. */
/* Compared as PATHS, never as URL text. import.meta.url is percent-encoded
 * ("AIPLAY%20Studio", "Zo%C3%AB") and argv[1] is not, so the old test (does
 * the URL string end with argv[1]?) was false in the installer's default folder
 * and in any folder with a space or an accent: an MCP client launched the
 * server and it never read its stdin. lrc_test.js runs this exact line from
 * such a folder. Both sides are REAL paths: Node realpaths the main module
 * it loads, so import.meta.url names the target of a junction or symlink while
 * argv[1] still names the link, and a Studio reached through one never read
 * its stdin either. A path that does not resolve is not a main module. */
const RUN_DIRECTLY = !!process.argv[1] && (() => {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1])); } catch { return false; }
})();

let buf = "";
/* How many calls are still running.
 *
 * ⚠ Exiting the moment stdin ends throws away work in flight. A real client
 * holds the pipe open, so this looks safe — but a render takes minutes, and ANY
 * client that closes stdin after writing (a script, a test, a crash) would
 * silently lose every answer. Found by piping three requests in and getting
 * nothing back at all. */
let inFlight = 0;
let stdinDone = false;
const maybeExit = () => { if (stdinDone && inFlight === 0) process.exit(0); };

if (RUN_DIRECTLY) {
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  for (;;) {
    const nl = buf.indexOf("\n");
    if (nl < 0) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    inFlight++;
    handle(msg)
      .catch((err) => {
        if (msg.id !== undefined) replyError(msg.id, -32603, String(err.message || err));
      })
      .finally(() => { inFlight--; maybeExit(); });
  }
});
process.stdin.on("end", () => { stdinDone = true; maybeExit(); });
}
