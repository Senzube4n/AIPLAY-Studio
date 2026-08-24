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
      + "rather than silently ignored; pass `engine` to switch first.",
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
        soundtrack_song: { type: "string", description: "A library song file the clip is generated ON — the finished clip PLAYS this exact segment (frozen audio latent). LTX only." },
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
      if (a.soundtrack_song && engine !== "ltx") {
        throw new Error("A soundtrack (the clip plays real audio) needs LTX, but H3 is selected. Pass engine:\"ltx\", or on H3 use ref_song to make the song a NAMED reference instead.");
      }
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
      + "Takes about two minutes for five seconds at 24fps. Blocks until done.",
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
