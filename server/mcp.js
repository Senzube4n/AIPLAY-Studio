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
 * ── Why there is no SDK here ────────────────────────────────────────────────
 * AIPLAY Studio installs ONE npm dependency (`ws`), and that promise is in the
 * README. MCP over stdio is newline-delimited JSON-RPC 2.0; the whole transport
 * is the forty lines at the bottom of this file. Taking a dependency tree to
 * avoid writing them would cost more than it saves.
 *
 * ── The one thing this CANNOT do ────────────────────────────────────────────
 * It cannot export a finished video file. Studio's export is a real-time
 * MediaRecorder capture of a canvas, which needs a browser — there is no
 * server-side renderer to call. So `build_music_video` writes a PROJECT, and a
 * human (or a browser-driving agent) opens it in Studio and presses Export.
 * Saying that plainly is better than a tool that appears to render and returns
 * something that is not a video.
 */
import http from "node:http";
import { URL } from "node:url";
import path from "node:path";
import { vfxTools } from "./mcp-vfx.js";
import { dawTools } from "./mcp-daw.js";

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
 * Call the Studio API.
 *
 * Uses node:http rather than fetch for one reason: a render can take minutes and
 * the default fetch timeout would abandon a job that is going perfectly well.
 * The failure mode matters — an abandoned poll looks exactly like a failed
 * render to the caller, and the render carries on burning the GPU either way.
 */
function api(method, path, body, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
        headers: {
          // Every MCP-driven call self-identifies as the agent it is — the
          // server's provenance ledger stamps events from this header.
          "x-aiplay-actor": ACTOR,
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": payload.length }
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
          if (res.statusCode >= 400) {
            reject(new Error(parsed?.error || `HTTP ${res.statusCode}`));
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
    if (inHistory && inHistory.state === "done") return inHistory;
    if (inHistory && inHistory.state === "failed") {
      throw new Error(inHistory.error || "the render failed");
    }
    /* An id the server has never heard of must not spin the full timeout
     * claiming "Still running" — that is a lie about a job that does not
     * exist. Not current, not queued, not in history = unknown; one repoll
     * rides out the instant a job moves between those lists. */
    const isMine = (j) => j && j.id === jobId;
    if (!inHistory && !isMine(st.current) && !(st.queue || []).some(isMine)) {
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
      const cur = st.current;
      throw new Error(
        `Still running after ${Math.round(timeoutMs / 1000)}s`
        + (cur ? ` (${cur.title}: ${cur.stageLabel}, about ${cur.etaSeconds}s left)` : "")
        + ". Nothing was cancelled — call wait_for_song again with the same job_id.",
      );
    }
    await sleep(2000);
  }
}

/**
 * Wait for the art queue to go quiet.
 *
 * Covers/images/clips share ONE idle-drain queue that yields to music, so there
 * is no per-job id to watch — the honest signal is the queue emptying. Which
 * also means: do not call this while a song is rendering, or it waits for the
 * song too. Said in the tool description rather than worked around.
 */
async function waitForArt(timeoutMs, kind) {
  const deadline = Date.now() + timeoutMs;
  await sleep(1200);                       // let the request reach the queue
  for (;;) {
    const st = await api("GET", "/api/status");
    const art = st.art || {};
    const busy = art.queued > 0 || !!art.current;
    if (!busy) {
      if (art.lastError) throw new Error(art.lastError);
      return st;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Still working after ${Math.round(timeoutMs / 1000)}s`
        + (art.current ? ` (${art.current.kind} for ${art.current.title})` : "")
        + `, ${art.queued} queued. Nothing was cancelled.`,
      );
    }
    await sleep(2000);
  }
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
        rendering: st.current ? { title: st.current.title, stage: st.current.stageLabel, eta_seconds: st.current.etaSeconds } : null,
        queued_songs: (st.queue || []).map((q) => q.title),
        art_queue: { queued: st.art?.queued ?? 0, current: st.art?.current?.kind ?? null, last_error: st.art?.lastError ?? null },
        songs_in_library: (st.library || []).length,
        video: {
          enabled: !!st.config?.video?.enabled,
          models_installed: st.config?.video?.ready !== false,
          engine: st.config?.video?.engine,
          missing: st.config?.video?.missing || [],
        },
      };
    },
  },

  {
    name: "list_songs",
    description:
      "Every finished track, newest first: file name, title, length, and whether it already "
      + "has cover art, stems, timed lyrics or a video clip. Use the `file` value with the other tools.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", description: "How many to return (default 30)." } },
      additionalProperties: false,
    },
    async run(a) {
      const st = await api("GET", "/api/status");
      return (st.library || []).slice(0, Math.max(1, Number(a.limit) || 30)).map((t) => ({
        file: t.file, title: t.title, seconds: t.durationSeconds ?? null,
        has_cover: !!t.cover, has_stems: !!(t.stems || []).length,
        has_lyrics: !!t.lrc, clip: t.clip || null,
      }));
    },
  },

  {
    name: "make_song",
    description:
      "Write and render a song. Returns a job id immediately — rendering takes minutes, so "
      + "follow with wait_for_song.\n\n"
      + "The caption is the single biggest quality lever. MiniMax Music 3 responds to a "
      + "three-part structured caption: 'Global Metadata.' (BPM, key, genre, emotional "
      + "progression, production), 'Vocal Details.' (who is singing and how, or that it is "
      + "instrumental), 'Arrangement.' (primary and secondary instruments, groove, space). "
      + "A comma-separated tag list works far less well. Song LENGTH follows lyric length "
      + "more than it follows max_seconds. Recorded in the provenance ledger as an agent action (actor agent:*) — provenance_read shows it.",
    inputSchema: {
      type: "object",
      required: ["caption"],
      properties: {
        caption: { type: "string", description: "The structured style description. See above." },
        lyrics: { type: "string", description: "Optional. Use [Verse] / [Chorus] / [Bridge] section tags." },
        title: { type: "string" },
        instrumental: { type: "boolean", description: "No vocals at all." },
        seed: { type: "integer", description: "Same seed and caption reproduces the performance." },
        max_seconds: { type: "integer", description: "A ceiling, 30-300. The model may finish early." },
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
      });
      const st = await api("GET", "/api/status");
      /* ⚠ /api/generate answers with the CURRENT job, which on a busy queue is
       * somebody else's song. The one we just enqueued is the last in the
       * queue, or the current job if the queue was empty. */
      const mine = (st.queue || []).length
        ? st.queue[st.queue.length - 1]
        : st.current;
      return {
        job_id: mine?.id ?? r.job?.id ?? null,
        title: mine?.title ?? null,
        position_in_queue: (st.queue || []).length,
        note: "Rendering. Call wait_for_song with this job_id.",
      };
    },
  },

  {
    name: "wait_for_song",
    description:
      "Block until a song finishes, then return its file name. Safe to call again if it "
      + "times out — nothing is cancelled and the render keeps going.",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: {
        job_id: { type: "string" },
        timeout_seconds: { type: "integer", description: "Default 900. A 3-minute song takes about 4.5 minutes." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const done = await waitForSong(String(a.job_id), (Number(a.timeout_seconds) || 900) * 1000);
      return { file: done.file, title: done.title, seconds: done.durationSeconds, seed: done.seed };
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
            "The compositor's effect registry, applied to this image in order — 88 effects "
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
        rotate: { type: "integer", enum: [0, 90, 180, 270] },
        flip_h: { type: "boolean" }, flip_v: { type: "boolean" },
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
      },
      additionalProperties: false,
    },
    async run(a) {
      const { name, flip_h, flip_v, chroma_key, auto_levels, grain_seed, ...ops } = a;
      const r = await api("POST", "/api/images/edit", { name: safeName(name, "image"),
        ops: { ...ops, flipH: flip_h, flipV: flip_v, chromaKey: chroma_key,
               autoLevels: auto_levels, grainSeed: grain_seed } });
      if (r.error) throw new Error(r.error);
      // notes / fxSkipped are the engine's honesty channels — a compromise a
      // stage reported, and the timeline effects that did nothing on a still.
      return { image: r.name, url: `/api/image/${r.name}`,
               notes: r.notes, fxSkipped: r.fxSkipped };
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
      + "default, range and options. These are the compositor's own 88 effects running on a "
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
      "Draw a picture with the cover-art engine. Renders in about ten seconds and only while "
      + "nothing else is generating — music always takes priority. Blocks until it is done.\n\n"
      + "Pass `ref_images` for FLUX in-context EDITING: the prompt then refers to them as "
      + "\"image 1\", \"image 2\" in order — \"put the character from image 1 into the scene "
      + "from image 2\", \"same figure as image 1 but seen from behind\". This is how you "
      + "iterate a character toward a target or keep one consistent across pictures. Recorded in the provenance ledger as an agent action (actor agent:*) — provenance_read shows it.\n\n"
      + "Two of the five engines take a `negative`, and the other three REFUSE one rather than "
      + "ignoring it: zimage-base and checkpoint run real classifier-free guidance, while flux2 and "
      + "zimage are distilled models sampled at cfg 1.0 where the negative branch is never evaluated "
      + "at all. `ref_images` is flux2 only — see the engine descriptions.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string",
          description: "Supports DYNAMIC PROMPTS: `{a|b|c}` picks one option per render and an empty option is legal, so `{, at night|}` adds a detail half the time. Groups nest. The reply carries the expansion it chose plus `prompt_choices`, and passing those back reproduces that exact prompt — which is what makes one picture out of an overnight run findable again." },
        prompt_choices: { type: "array", items: { type: "integer" },
          description: "Replay a previous expansion exactly, from a earlier reply's prompt_choices." },
        dedupe: { type: "string", enum: ["reroll", "refuse", "off"],
          description: "What to do when this exact render (model, expanded prompt, seed, size, steps, cfg, refs) has already been made. reroll (default) rolls a fresh seed and says so; refuse errors instead; off renders the repeat. This is what stops an overnight run with a forgotten fixed seed making one picture all night." },
        count: { type: "integer", description: "1-4. One text encode serves all of them, so four is barely slower than one." },
        ref_images: { type: "array", items: { type: "string" }, maxItems: 10,
          description: "Image names (from list_images or covers) the prompt calls \"image 1\"… in this order. ~4 s per reference past the second." },
        width: { type: "integer" },
        height: { type: "integer" },
        seed: { type: "integer" },
        engine: { type: "string", enum: ["flux2", "zimage", "zimage-base", "ideogram4", "checkpoint"],
          description: "flux2 (default): FLUX.2 klein 4B, Apache-2.0, 4 steps, the ONLY one taking ref_images. "
            + "zimage: Z-Image Turbo, Apache-2.0, 8 steps — photographic realism, faces, English and Chinese "
            + "prompts, and the cleanest commercial answer in the app; NO negative (distilled at cfg 1.0, so "
            + "the negative branch is never evaluated — passing one is refused, not ignored) and no refs. "
            + "zimage-base: the same model undistilled, 25 steps at cfg 4.0 — slower, more varied per seed, "
            + "and the negative prompt genuinely works; reach for it when zimage keeps drawing the same "
            + "composition. ideogram4: the open Ideogram release — typography/posters; NON-COMMERCIAL licence "
            + "whose text is gated and unread; preset via quality. checkpoint: any .safetensors in "
            + "ComfyUI/models/checkpoints (list_checkpoints shows the shelf) — negative/cfg apply." },
        quality: { type: "string", enum: ["default", "quality"], description: "ideogram4 only: Default 20 steps or Quality 48." },
        checkpoint: { type: "string", description: "checkpoint engine only: the model filename." },
        negative: { type: "string", description: "checkpoint and zimage-base only: what the picture must not contain. Refused on flux2/zimage/ideogram4 — they sample at cfg 1.0 (or have no negative input), so it would do nothing." },
        cfg: { type: "number", description: "checkpoint (1-15, default 6) and zimage-base (default 4, useful 3-5) only." },
        steps: { type: "integer",
          description: "Optional, and worth setting on a checkpoint. Omit and you get that engine's own "
            + "default: 4 flux2, 8 zimage, 25 zimage-base, 28 checkpoint (ideogram4 takes its steps from "
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
        engine: a.engine, quality: a.quality, checkpoint: a.checkpoint,
        negative: a.negative, cfg: a.cfg,
        count: a.count, width: a.width, height: a.height,
        promptChoices: Array.isArray(a.prompt_choices) ? a.prompt_choices : undefined,
        dedupe: a.dedupe === "off" ? false : a.dedupe === "refuse" ? "refuse" : undefined,
        /* ⚠ NEW, AND FORWARDED IN THE SAME COMMIT THAT DECLARES IT. The route
         * exposed a step count from the beginning and this tool never sent
         * one, so an agent's only lever on schedule length was the engine
         * name. Declaring it without wiring it here would be the silent
         * field-drop mcp-image_test.js exists to catch — the schema and the
         * body have to move together. */
        steps: Number.isFinite(a.steps) ? a.steps : undefined,
        refImages: Array.isArray(a.ref_images) && a.ref_images.length
          ? a.ref_images.slice(0, 10).map((n) => safeName(n, "image")) : undefined,
        seed: Number.isFinite(a.seed) ? a.seed : undefined,
      });
      if (r.error) throw new Error(r.error);
      await waitForArt((Number(a.timeout_seconds) || 600) * 1000, "image");
      const after = (await api("GET", "/api/images")).images || [];
      const made = after.filter((i) => !before.has(i.name)).map((i) => i.name);
      return {
        images: made, url_prefix: "/api/image/",
        /* What was ACTUALLY asked, not the template — and the choices that got
         * there, so this picture can be made again. */
        ...(r.prompt ? { prompt: r.prompt, prompt_choices: r.promptChoices, combinations: r.combinations } : {}),
        seed: r.seed,
        ...(r.note ? { note: r.note } : {}),
        ...(made.length ? {} : { note: "Nothing new appeared — check studio_status for the last error." }),
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
      + "(<Picture n> / <Audio n>) for holding a character across shots.\n\n"
      + "Refused if that engine's weights are not downloaded. Switching means the next "
      + "render reloads ~20 GB of weights, so do not flip per clip — batch by engine.",
    inputSchema: {
      type: "object",
      required: ["engine"],
      properties: { engine: { type: "string", enum: ["h3", "ltx"] } },
      additionalProperties: false,
    },
    async run(a) {
      const r = await api("POST", "/api/video", { action: "engine", value: a.engine });
      if (r.error) throw new Error(r.error);
      return { engine: r.video?.engine ?? a.engine, enabled: r.video?.enabled };
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
      + "finished clip PLAYS that stretch of the song and the picture is invented to fit it, "
      + "which is the tool for a performance shot.\n"
      + "  • MiniMax H3 — slower, and the only engine that takes NAMED REFERENCES. Pass "
      + "`ref_images` / `ref_song`, then call them in the prompt: \"the figure from "
      + "<Picture 1> performs the song from <Audio 1> on a rooftop\". A reference is not "
      + "pinned to a frame — the model recasts the subject wherever the words put it, which "
      + "is how you keep one character across many shots.\n\n"
      + "Passing an engine-specific input while the other engine is selected is REFUSED "
      + "rather than silently ignored; pass `engine` to switch first. Recorded in the provenance ledger as an agent action (actor agent:*) — provenance_read shows it.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string", description: "What happens in the shot. Describe motion, not just a subject. May contain <Picture n> / <Audio n> tags when ref_images / ref_song are given." },
        engine: { type: "string", enum: ["h3", "ltx"], description: "Switch the engine before rendering. Persists, like the GUI dropdown. Omit to use whatever is selected." },
        quality: { type: "string", enum: ["fast", "best"],
          description: "fast = the distilled turbo path (~8 steps). best = the full model on its native schedule, measurably smoother but several times slower. Default: the engine's own default (currently 'best' on H3). Prefer this over `steps`." },
        steps: { type: "integer", description: "Advanced override of the step count; wins over `quality`. On H3 a value at or below turboMaxSteps (12) selects the turbo LoRA and above it runs the bare model. LTX ignores it — its schedule is fixed." },
        seconds: { type: "integer", description: "Clip length. 5 is the default and what the cost model is anchored on." },
        width: { type: "integer", description: "Frame width. Use a size the engine is trained on — see studio_status / the Video page list. H3 native is 1344x768." },
        height: { type: "integer", description: "Frame height." },
        first_frame: { type: "string", description: "An image name to open on (from list_images or a cover). Pinned at frame 0." },
        last_frame: { type: "string", description: "An image name to end on, pinned at the final frame. Ignored when `loop` is set." },
        mid_frames: { type: "array", items: { type: "string" }, maxItems: 4,
          description: "Up to 4 images the clip passes THROUGH, spaced evenly between the ends. Needs both ends set. LTX only. Not style references — the clip lands on each one." },
        loop: { type: "boolean", description: "Seamless loop: reuses the opening picture as the closing one so the clip cuts to its own start." },
        ref_images: { type: "array", items: { type: "string" }, maxItems: 9,
          description: "Image names (from list_images or covers) the prompt refers to as <Picture 1>… in this order. H3 only." },
        ref_song: { type: "string", description: "A library song file (from list_songs) the prompt refers to as <Audio 1>. H3 only." },
        ref_song_start: { type: "integer", description: "Where the 10-second reference window starts, in seconds. Default 0." },
        soundtrack_song: { type: "string", description: "A library song file the clip is generated ON — the finished clip PLAYS this exact segment (frozen audio latent). Works on both engines; on H3 it also anchors the audio so the model reads the vocal while inventing the picture, which is the tool for lip-synced performance shots WITH character references." },
        soundtrack_start: { type: "integer", description: "Where the soundtrack segment starts, in seconds. Default 0." },
        negative: { type: "string", description: "What to avoid. LTX only — H3 has no negative prompt." },
        guidance: { type: "number", description: "How literally to follow the prompt (1-8). LTX only." },
        keep_audio: { type: "boolean", description: "Keep the engine's own rendered audio. Default true; a soundtrack clip always keeps it." },
        seed: { type: "integer", description: "Reproducible when set. A rolled seed is recorded in the clip's metadata either way." },
        timeout_seconds: { type: "integer", description: "Default 900. Raise it for a full-quality H3 render at native size." },
      },
      additionalProperties: false,
    },
    async run(a) {
      let st = await api("GET", "/api/status");
      if (!st.config?.video?.enabled) {
        throw new Error("Video is switched off in Settings. Turn it on, or the request is refused.");
      }
      if (st.config?.video?.ready === false) {
        throw new Error(`Video models are not installed: ${(st.config.video.missing || []).join(", ")}`);
      }
      /* ENGINE FIRST, because the engine decides which of the inputs below are
       * even legal. An explicit `engine` switches (the caller named it, so that
       * is intent, not a side effect). An engine-specific input with the WRONG
       * engine selected throws HERE with the fix in the message — the route
       * would refuse it anyway, and an agent that cannot see why is stuck. */
      if (a.engine && a.engine !== st.config?.video?.engine) {
        const sw = await api("POST", "/api/video", { action: "engine", value: a.engine });
        if (sw.error) throw new Error(sw.error);
        st = await api("GET", "/api/status");
      }
      const engine = st.config?.video?.engine;
      const wantsRefs = (Array.isArray(a.ref_images) && a.ref_images.length) || !!a.ref_song;
      if (wantsRefs && engine !== "h3") {
        throw new Error("Named references (<Picture n> / <Audio n>) need MiniMax H3, but LTX is selected. Pass engine:\"h3\", or use first_frame/last_frame/mid_frames, which is how LTX takes pictures.");
      }
      // Soundtrack works on BOTH engines: LTX freezes the audio latent, H3
      // freezes AND anchors it (the lip-sync pair). No guard on this axis.
      if (Array.isArray(a.mid_frames) && a.mid_frames.length && engine !== "ltx") {
        throw new Error("mid_frames (pass-through pictures) are an LTX feature. Pass engine:\"ltx\", or on H3 use ref_images.");
      }
      const before = new Set(((await api("GET", "/api/clips")).clips || []).map((c) => c.name));
      /* `quality` is the semantic dial; `steps` is the escape hatch and wins.
       * The mapping lives here rather than in the caller's head because the
       * turbo threshold is a measured implementation detail that has already
       * moved once. 8 is the distilled fast point, 20 the measured good one. */
      const steps = Number.isFinite(a.steps) ? a.steps
        : a.quality === "fast" ? 8
        : a.quality === "best" ? 20
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
      };
      /* ⚠ `fromCover`, not `firstFrame` — the route's field is fromCover (it
       * stages covers AND standalone images). This tool sent `firstFrame` from
       * the day it was written and the route read `b.fromCover`, so the still
       * was silently dropped: every MCP clip rendered from nothing while the
       * response looked like success. */
      if (a.first_frame) body.fromCover = safeName(a.first_frame, "image");
      // Same field naming trap as fromCover: the route reads toCover/midUploads.
      if (a.last_frame) body.toCover = safeName(a.last_frame, "image");
      if (Array.isArray(a.mid_frames) && a.mid_frames.length) {
        body.midUploads = a.mid_frames.slice(0, 4).map((n) => safeName(n, "image"));
      }
      if (Array.isArray(a.ref_images) && a.ref_images.length) {
        body.refImages = a.ref_images.slice(0, 9).map((n) => safeName(n, "image"));
      }
      if (a.ref_song) {
        body.refAudios = [{ name: safeName(a.ref_song, "song"),
                            start: Number.isFinite(a.ref_song_start) ? a.ref_song_start : 0 }];
      }
      if (a.soundtrack_song) {
        body.audioTrack = { name: safeName(a.soundtrack_song, "song"),
                            start: Number.isFinite(a.soundtrack_start) ? a.soundtrack_start : 0 };
      }
      const r = await api("POST", "/api/video", body);
      if (r.error) throw new Error(r.error);
      await waitForArt((Number(a.timeout_seconds) || 900) * 1000, "video");
      const after = (await api("GET", "/api/clips")).clips || [];
      const made = after.filter((c) => !before.has(c.name)).map((c) => c.name);
      return { clips: made, note: made.length ? undefined : "Nothing new appeared — check studio_status for the last error." };
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
      await waitForArt((Number(a.timeout_seconds) || 1800) * 1000, "restyle");
      const after = (await api("GET", "/api/clips")).clips || [];
      const made = after.filter((c) => !before.has(c.name)).map((c) => c.name);
      return {
        clips: made,
        guides: r.guides ?? null,
        bpm: r.bpm ?? null,
        // Shown so the caller can see the audio actually reached the render.
        guide_strengths: r.strengths ? r.strengths.map((x) => Number(x.toFixed(3))) : null,
        note: made.length ? undefined : "Nothing new appeared — check studio_status for the last error.",
      };
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
      return reply(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
const RUN_DIRECTLY = !!process.argv[1]
  && import.meta.url.endsWith(process.argv[1].split(path.sep).join("/"));

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
