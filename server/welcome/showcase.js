/**
 * THE SHOWCASE — what this studio has actually made, read off this disk.
 *
 * The owner's ask: "show what images you can make. show what music you can
 * make. show what daw music you can make."
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE ONE RULE: NOTHING IN HERE IS TYPED.
 *
 * Every item is a file that exists on this machine, paired with the prompt or
 * caption that produced it, read from the same stores the Images screen, the
 * Video screen and the library itself read. There is no fixtures list, no
 * bundled sample, no "representative example". A fresh install shows an empty
 * showcase and says so.
 *
 * That is not modesty, it is the only version of this feature that is worth
 * having. A showcase of stock output is a claim about somebody else's machine;
 * a showcase of YOUR output is the answer to "what can this thing do" that you
 * can check by clicking it. It also degrades honestly: the day the DAW has no
 * bounce, the DAW panel says the bounce is coming, rather than borrowing a
 * song from the music engine and hoping nobody looks.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A PROMPT IS THE PRICE OF ADMISSION. An item with no prompt or caption is
 * skipped even when the file is beautiful, because half the point is showing
 * the INPUT beside the result — "a picture appeared" teaches nobody anything.
 * That rule also, for free, keeps the test and probe files out: nothing anyone
 * rendered to check a code path ever carried a real caption.
 *
 * READ-ONLY, AND FORGIVING. Every store here is optional and every read is
 * wrapped: a welcome window that fails to open because a sidecar is corrupt
 * would be a worse bug than the one it is reporting.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

/** Enough words that a reader learns something from seeing them. */
const MIN_PROMPT = 40;
const MIN_CAPTION = 80;
/** A handful, per the ask. More than this is a gallery, and there is one of those. */
const PER_KIND = 4;

const clip = (s, n) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
};
const readJson = async (p) => {
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; }
};
const exists = async (p) => {
  try { return (await stat(p)).size > 0; } catch { return false; }
};

/* ── pictures ───────────────────────────────────────────────────────────── */
/**
 * From `images/_meta.json` — the same sidecar `/api/images` reads, so the model
 * label shown here is the model label shown everywhere else.
 *
 * Edits are skipped. An edited file inherits its parent's prompt, so showing
 * both would show one prompt twice and quietly claim the editor's work for the
 * generator.
 */
async function images() {
  const dir = path.join(config.outputDir, "images");
  const meta = await readJson(path.join(dir, "_meta.json"));
  if (!meta) return [];
  const rows = Object.entries(meta)
    .filter(([name, m]) =>
      m && !m.editedFrom
      && typeof m.prompt === "string" && m.prompt.trim().length >= MIN_PROMPT
      && /\.(png|jpe?g|webp)$/i.test(name))
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0));

  const out = [];
  for (const [name, m] of rows) {
    if (out.length >= PER_KIND) break;
    if (!(await exists(path.join(dir, name)))) continue;
    out.push({
      kind: "image",
      name,
      url: `/api/image/${encodeURIComponent(name)}`,
      prompt: clip(m.prompt, 280),
      engine: m.engine ?? null,
      checkpoint: m.checkpoint ?? null,
      seed: m.seed ?? null,
      at: m.at ?? null,
    });
  }
  return out;
}

/* ── songs ──────────────────────────────────────────────────────────────── */
/**
 * From the library sidecar. The `caption` IS the input — this engine is steered
 * by a three-part structured caption (Global Metadata / Vocal Details /
 * Arrangement), and showing it beside the track is the single most useful thing
 * a new user can be shown, because it is the whole skill.
 */
async function music() {
  const meta = (await readJson(path.join(config.paths.appData, "library.json")))?.meta;
  if (!meta) return [];
  const rows = Object.entries(meta)
    .filter(([name, m]) =>
      m && !m.trashedAt && typeof m.title === "string" && m.title.trim()
      && typeof m.caption === "string" && m.caption.trim().length >= MIN_CAPTION
      && /\.(flac|mp3|opus)$/i.test(name))
    .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

  const out = [];
  const seen = new Set();
  for (const [name, m] of rows) {
    if (out.length >= PER_KIND) break;
    /* One row per SONG, not per take. Re-rolls share a title and would
     * otherwise fill the whole panel with the same song four times. */
    const key = m.title.trim().toLowerCase();
    if (seen.has(key)) continue;
    if (!(await exists(path.join(config.outputDir, name)))) continue;
    seen.add(key);
    out.push({
      kind: "song",
      name,
      title: m.title.trim(),
      url: `/api/audio/${encodeURIComponent(name)}`,
      cover: m.cover ? `/api/cover/${encodeURIComponent(m.cover)}` : null,
      caption: clip(m.caption, 420),
      seconds: m.durationSeconds ?? null,
      at: m.createdAt ?? null,
    });
  }
  return out;
}

/* ── clips ──────────────────────────────────────────────────────────────── */
async function clips() {
  const meta = (await readJson(path.join(config.paths.appData, "clips.json")))?.meta;
  if (!meta) return [];
  const rows = Object.entries(meta)
    .filter(([name, m]) =>
      m && typeof m.prompt === "string" && m.prompt.trim().length >= MIN_PROMPT
      && /\.(mp4|webm)$/i.test(name))
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0));

  const out = [];
  for (const [name, m] of rows) {
    if (out.length >= PER_KIND) break;
    if (!(await exists(path.join(config.outputDir, "clips", name)))) continue;
    out.push({
      kind: "clip",
      name,
      url: `/api/clip/${encodeURIComponent(name)}`,
      poster: `/api/clipthumb/${encodeURIComponent(name)}`,
      prompt: clip(m.prompt, 280),
      engine: m.engine ?? null,
      size: m.width && m.height ? `${m.width} x ${m.height}` : null,
      seconds: m.clipSeconds ?? null,
      /* The step count is the turbo question the owner asked about, so it is
       * shown when the render recorded one rather than left implicit. */
      steps: m.steps ?? null,
      note: m.note ? clip(m.note, 120) : null,
      at: m.at ?? null,
    });
  }
  return out;
}

/* ── DAW bounces ────────────────────────────────────────────────────────── */
/**
 * Arrangements, not generations — the distinction the owner drew by asking for
 * "daw music" separately. A bounce is a file somebody built bar by bar, so what
 * is worth showing beside it is the SHAPE of the project (tempo, meter, how
 * many tracks and what they are), which is the closest thing the DAW has to a
 * prompt.
 *
 * Bounces live under the project folder and are not served by the DAW's own
 * routes — that path is content-addressed region cache only — so welcome/routes.js
 * serves them itself under /api/welcome/bounce/. Additive, and it means the
 * showcase can be listened to rather than only read.
 */
async function daw() {
  const root = path.join(config.outputDir, "daw");
  let slugs = [];
  try {
    slugs = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
      .map((d) => d.name);
  } catch { return []; }

  const found = [];
  for (const slug of slugs) {
    const bdir = path.join(root, slug, "bounces");
    let names = [];
    try { names = (await readdir(bdir)).filter((n) => /\.(flac|wav)$/i.test(n)); } catch { continue; }
    if (!names.length) continue;
    const doc = await readJson(path.join(root, slug, "project.json"));

    /* Newest bounce per project. Earlier ones are drafts of the same piece and
     * a showcase that lists four versions of one bass line is not a showcase. */
    let best = null;
    for (const n of names) {
      const st = await stat(path.join(bdir, n)).catch(() => null);
      if (!st?.size) continue;
      /* FLAC over WAV when both exist: same audio, a third of the bytes, and
       * every browser this app runs in plays it. */
      const rank = (n.toLowerCase().endsWith(".flac") ? 2 : 1) * 1e15 + st.mtimeMs;
      if (!best || rank > best.rank) best = { name: n, at: st.mtimeMs, bytes: st.size, rank };
    }
    if (!best) continue;

    const tempos = doc?.tempoMap || [];
    const meters = doc?.meterMap || [];
    found.push({
      kind: "bounce",
      slug,
      name: best.name,
      title: doc?.name || slug,
      url: `/api/welcome/bounce/${encodeURIComponent(slug)}/${encodeURIComponent(best.name)}`,
      bpm: tempos[0]?.bpm ?? null,
      meter: meters[0] ? `${meters[0].num ?? meters[0].beats}/${meters[0].den ?? meters[0].unit}` : null,
      bars: doc?.lengthBars ?? null,
      tracks: (doc?.tracks || []).map((t) => t.name).filter(Boolean).slice(0, 8),
      trackCount: (doc?.tracks || []).length,
      bytes: best.bytes,
      at: best.at,
    });
  }
  return found.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, PER_KIND);
}

/* ── the whole showcase ─────────────────────────────────────────────────── */

/**
 * Four panels. Each carries its items and, when it has none, the honest reason
 * — which the window prints instead of the panel, and which an agent reading
 * `studio_showcase` gets as text rather than as an empty array it has to guess
 * the meaning of.
 */
export async function showcase() {
  const [img, mus, cli, bnc] = await Promise.all([
    images().catch(() => []),
    music().catch(() => []),
    clips().catch(() => []),
    daw().catch(() => []),
  ]);

  const panel = (id, title, items, empty) => ({
    id, title, items, count: items.length,
    empty: items.length ? null : empty,
  });

  return {
    /* Stamped so a reader can tell a stale cache from a quiet studio, and so
     * "read live from this machine" is a checkable claim rather than a boast. */
    readAt: new Date().toISOString(),
    source: "This machine's own library, provenance sidecars and DAW project folders. Nothing here ships with the app.",
    panels: [
      panel("images", "Pictures", img,
        "No picture on this machine carries the prompt that made it yet. Generate one on Images and it will appear here."),
      panel("music", "Songs", mus,
        "No finished track with a caption yet. Write one on Music — the caption is the input, and it is what this panel shows."),
      panel("clips", "Video clips", cli,
        "No clip with a recorded prompt yet. Render one on Video."),
      panel("daw", "DAW arrangements", bnc,
        "COMING. Nothing has been bounced from the DAW on this machine yet — an arrangement is built bar by bar, and no finished one exists here to show. Open the DAW, make a project and press Bounce, and the real thing appears here."),
    ],
  };
}

export { PER_KIND, MIN_PROMPT, MIN_CAPTION };
