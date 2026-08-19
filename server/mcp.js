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

const BASE = process.env.AIPLAY_URL || "http://127.0.0.1:4173";

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
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": payload.length }
          : {},
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
  for (;;) {
    const st = await api("GET", "/api/status");
    const inHistory = (st.history || []).find((j) => j.id === jobId);
    if (inHistory && inHistory.state === "done") return inHistory;
    if (inHistory && inHistory.state === "failed") {
      throw new Error(inHistory.error || "the render failed");
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
    const name = clips[i % clips.length];
    i++;
    items.push({
      id: 1000 + slot,
      name,
      src: `/api/clip/${encodeURIComponent(name)}`,
      start: Number(from.toFixed(3)),
      dur: Number(Math.min(span, lenOf(name)).toFixed(3)),
      inPoint: 0,
      srcDur: lenOf(name),
      still: /\.(png|jpg|jpeg|webp|gif)$/i.test(name) || undefined,
    });
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

const TOOLS = [
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
      + "more than it follows max_seconds.",
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
    name: "make_image",
    description:
      "Draw a picture with the cover-art engine. Renders in about ten seconds and only while "
      + "nothing else is generating — music always takes priority. Blocks until it is done.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string" },
        count: { type: "integer", description: "1-4. One text encode serves all of them, so four is barely slower than one." },
        width: { type: "integer" },
        height: { type: "integer" },
        seed: { type: "integer" },
        timeout_seconds: { type: "integer", description: "Default 600." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const before = new Set(((await api("GET", "/api/images")).images || []).map((i) => i.name));
      const r = await api("POST", "/api/image", {
        action: "create", prompt: a.prompt,
        count: a.count, width: a.width, height: a.height,
        seed: Number.isFinite(a.seed) ? a.seed : undefined,
      });
      if (r.error) throw new Error(r.error);
      await waitForArt((Number(a.timeout_seconds) || 600) * 1000, "image");
      const after = (await api("GET", "/api/images")).images || [];
      const made = after.filter((i) => !before.has(i.name)).map((i) => i.name);
      return { images: made, url_prefix: "/api/image/", note: made.length ? undefined : "Nothing new appeared — check studio_status for the last error." };
    },
  },

  {
    name: "list_images",
    description: "Standalone images, newest first.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer" } },
      additionalProperties: false,
    },
    async run(a) {
      const d = await api("GET", "/api/images");
      return (d.images || []).slice(0, Math.max(1, Number(a.limit) || 40))
        .map((i) => ({ name: i.name, prompt: i.meta?.prompt ?? null, seed: i.meta?.seed ?? null }));
    },
  },

  {
    name: "make_clip",
    description:
      "Render a short video clip. Takes roughly two minutes on LTX. Blocks until done.\n\n"
      + "Optionally starts from a still — pass `first_frame` with an image name from "
      + "list_images, which is how you get a clip that matches art you already made.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string", description: "What happens in the shot. Describe motion, not just a subject." },
        seconds: { type: "integer", description: "Clip length. 5 is the default and what the cost model is anchored on." },
        first_frame: { type: "string", description: "An image name to start from (from list_images or a cover)." },
        negative: { type: "string" },
        seed: { type: "integer" },
        timeout_seconds: { type: "integer", description: "Default 900." },
      },
      additionalProperties: false,
    },
    async run(a) {
      const st = await api("GET", "/api/status");
      if (!st.config?.video?.enabled) {
        throw new Error("Video is switched off in Settings. Turn it on, or the request is refused.");
      }
      if (st.config?.video?.ready === false) {
        throw new Error(`Video models are not installed: ${(st.config.video.missing || []).join(", ")}`);
      }
      const before = new Set(((await api("GET", "/api/clips")).clips || []).map((c) => c.name));
      const body = {
        action: "create", prompt: a.prompt,
        seconds: Number.isFinite(a.seconds) ? a.seconds : undefined,
        negative: a.negative,
        seed: Number.isFinite(a.seed) ? a.seed : undefined,
      };
      if (a.first_frame) body.firstFrame = safeName(a.first_frame, "image");
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
];

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
