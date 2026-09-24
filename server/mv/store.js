/**
 * Video Workflow — the project store.
 *
 * One JSON document plus an asset folder per project:
 *   <outputDir>/mv/<slug>/project.json
 *   <outputDir>/mv/<slug>/assets/
 *
 * WHY NOT REUSE /api/studio/projects. The timeline's own save path
 * (`web/studio.js` projDoc()) re-serialises from a FIXED field list, so any
 * top-level key it does not know about is destroyed the moment a human presses
 * Save. Per-track and per-item keys survive, because snapshot()/restore()
 * spread — which is exactly why a clip id stamped on a timeline ITEM is safe
 * while a workflow doc stored alongside one would not be. The two stores stay
 * separate and the timeline doc carries only a pointer.
 *
 * SINGLE WRITER. Both the HTTP routes and the MCP server write here, and a
 * render can finish at any moment and want to attach itself. Every mutation
 * goes through one promise chain per slug and lands via write-temp-then-rename,
 * so a crash mid-write cannot leave a half-written document — losing an hour of
 * directing to a truncated JSON file is not a recoverable error.
 */
import { readFile, writeFile, rename, mkdir, readdir, stat, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";

export const MV_DIR = () => path.join(config.outputDir, "mv");
export const projectDir = (slug) => path.join(MV_DIR(), slug);
export const assetsDir = (slug) => path.join(projectDir(slug), "assets");
const docPath = (slug) => path.join(projectDir(slug), "project.json");

/** Document version. Bump only with a migration in `migrate()`. */
export const DOC_VERSION = 1;

/**
 * A slug is the on-disk identity, so it has to survive a file system and a URL
 * and stay recognisable to a human scanning a folder. Same shape Studio already
 * uses for exports.
 */
export function slugify(title) {
  const base = String(title || "")
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "untitled";
}

const newId = () => randomUUID().slice(0, 8);

/** A blank document. Every array exists from the start so nothing has to null-check. */
export function blankProject(title, kind = "mv") {
  const now = Date.now();
  if (kind === "audiobook") {
    return {
      v: DOC_VERSION, kind, id: newId(), slug: slugify(title),
      title: String(title || "Untitled"), createdAt: now, updatedAt: now,
      /* The source and its chapter inventory. The full text lives in
       * assets/book.json — a webnovel is megabytes and the project doc is
       * read on every paint. */
      book: null,            // { path, title, author, chapters:[{idx,title,words,done}] }
      voice: null,           // { model, persona } — ONE narrator per book, coherence is the point
      cast: [],              // dialogue casting: { name, aliases[], voice:{model,persona}, note }
      settings: { targetMinMinutes: 5, targetMaxMinutes: 15, wpm: 165,
                  bed: true, sfx: false, bedGainDb: -14, duckDb: -13 },
      beds: [],              // reusable ambient beds: { id, mood, caption, file, seed, seconds }
      bundles: [],           // the output units: { idx, title, chapterIdxs[], words,
                             //   estMinutes, status, narration[], bedId, sfx[], mixFile, seed }
      /* SET UP · GO THROUGH · APPROVE · START. Empty here and unused in v1 —
       * an audiobook has no plannable tool list yet, so the key exists only so
       * the two kinds of document have one shape and migrate() has one line
       * rather than two. See server/mv/plan.js. */
      plans: [],
      runs: [],
    };
  }
  return {
    v: DOC_VERSION,
    kind: "mv",
    id: newId(),
    slug: slugify(title),
    title: String(title || "Untitled"),
    createdAt: now,
    updatedAt: now,
    song: null,          // { file, title, durationSeconds, source, lrc, beats }
    brief: {
      medium: null, tone: null, narrative: null,
      aspectRatio: "16:9", resolution: "1280x720", qualityMode: "recommended",
      freeText: null, directionSummary: null,
      videoEngine: null,          // null = decide per clip from what it carries
      /* BASE RENDER SIZE, separate from the delivered size.
       *
       * LTX generates at half and upscales x2 (LTXVLatentUpsampler), which is
       * what makes it fast — but the upscale is a latent one, and a face that
       * was 40 pixels wide when it was sampled does not gain identity from
       * being made 80. Faces are the thing that suffers, and the cast is the
       * thing a video is about. "auto" keeps today's behaviour; a explicit
       * value renders the first pass larger and costs proportionally. */
      baseScale: "auto",          // auto | half | three-quarter | full
      /* Sampling steps per clip. null keeps the 8 that every video so far used.
       * 4 selects the 4-step H3 distillation (workflow.js picks the LoRA by
       * step count), which is the cheap-H3 experiment. */
      videoSteps: null,
      /* Send the rendered storyboard to H3 as an extra reference image.
       * OFF by default: a board is one throwaway generation per scene and its
       * anatomy faults would be taught to the clip as intention. Worth turning
       * on only when the boards have been looked at and are good. */
      boardRef: false,
      /* THE SONG UNDER EVERY SCENE'S CLIP ("Song under the clip: always"), Hex
       * Appeal's setting and where new projects start since 2026-09-24. The
       * REWIND A/B (same seeds, two blind judges; DIRECTING.md §2) put it
       * under every reference shot and the sung line followed the words;
       * "auto" puts it only under boards marked as sung (lipSync), which only
       * an agent sets. Its render-time cost was never measured on its own.
       * An older project keeps what it stored (no value reads as auto). */
      songConditioning: "always",
      /* WHICH IMAGE MODEL DRAWS THE SHEETS AND BOARDS.
       *
       * null keeps the library-wide cover default (config.art.engine: your
       * saved choice, or, when nobody chose, the recommended picture model on
       * this PC — server/fit.js defaultFor). The point of exposing it per
       * project: FLUX.2 and Qwen Image 2.1 take REFERENCE images, and FLUX.2
       * is a generalist — asked for anime hands it
       * produces the extra fingers this project found. An anime-specialised
       * checkpoint draws the style far better and takes no references, which
       * is an acceptable trade for a project whose identity comes from H3's
       * own reference path rather than from the board. */
      imageEngine: null,          // null | "flux2" | "ideogram" | "checkpoint" | "qwen-image-2.1"
      imageCheckpoint: null,      // a file in ComfyUI/models/checkpoints
      storyboardStyle: "sketch",
    },
    lyricLines: [],
    totalDurationSec: 0,
    beats: null,
    story: null,         // { logline, synopsis, arc[] }
    styleBible: null,
    /* The look ALONE — palette, medium, era, lens — guaranteed to name no
     * person, so it can be sent to a board with an empty cast without
     * reintroducing a figure. See the note at generate.js's prompt assembly:
     * withholding styleBible from cast-less boards deleted "1970s" from every
     * shot that was only the car, and the car came back modern. */
    lookBible: null,
    youtube: null,
    segments: [],
    characters: [],
    backgrounds: [],
    /* RECURRING OBJECTS ARE CAST TOO.
     *
     * A car in 13 of 22 scenes, declared nowhere, is re-invented from text on
     * every render — a different car each time, and sometimes two of them in
     * one frame. Characters solved this years ago by carrying a rendered sheet
     * that is fed back in as a reference image; props get the same treatment
     * and the same schema, because the problem is identical.
     *
     * ── TWO FIELDS EVERY CAST ROW MAY CARRY, characters and backgrounds too ──
     *   meshFile  a .glb in assets/, from server/mesh/. The object itself, not a
     *             picture of it. A row holding one is COMPLETE — see
     *             assetComplete() below — because a mesh holds identity harder
     *             than a sheet does. It is NOT a reference the clip engines can
     *             take: control.js's IMAGE_RE is the list of what may be one,
     *             and a mesh is not on it and must not be added to it.
     *   rigFile   the same mesh with glTF joints and inverseBindMatrices in it.
     *             Separate from meshFile rather than replacing it, so an
     *             unsatisfactory rig can be discarded without losing the mesh
     *             that took the GPU time.
     * Both default to absent, which reads the same as null everywhere. */
    props: [],
    boards: [],
    clips: [],
    /* BLOCKED SHOTS, from the Blender previz toolkit. Kept top-level rather
     * than on a board because upsertBoard REPLACES a board wholesale — a
     * previz stored inside one would be destroyed by the next save, and the
     * render that made it cost real seconds. Each record:
     *   { id, segmentId, move, scene, frames, plan,
     *     clipFile, trackFile, use: "human-review",
     *     reference: { file, angle, safe, why[] } | null, at } */
    previz: [],
    /* RUNS THAT WERE SET UP, READ, APPROVED AND ONLY THEN STARTED.
     *
     * Newest first, bounded to 10, at most one in a live state at a time. It
     * lives HERE rather than in a side file for the three reasons this store
     * already pays for: the single-writer chain below makes concurrent
     * mutation safe, the rail reads this document on every paint so "visible
     * while it runs" costs nothing, and a render landing mid-plan attaches
     * itself through updateProject like everything else.
     *
     * Nothing derivable is stored on a plan — no minutes, no engine, no
     * resolution. Those are computed on read by planView(), for the same
     * reason stageOfDoc() is derived: a stamped number is a number that can
     * disagree with the renderer. See server/mv/plan.js. */
    plans: [],
    runs: [],
    timelineProject: null,
  };
}

/* ─────────────────────────────────────────────── the single-writer queue */

/** One promise chain per slug. Serialises read-modify-write against itself. */
const chains = new Map();

function enqueue(slug, fn) {
  const prev = chains.get(slug) ?? Promise.resolve();
  // The chain must not break on a rejection, or every later write for this
  // project is silently dropped. Callers still see their own error.
  const next = prev.then(fn, fn);
  chains.set(slug, next.then(() => {}, () => {}));
  return next;
}

async function writeDoc(slug, doc) {
  await mkdir(assetsDir(slug), { recursive: true });
  const tmp = docPath(slug) + `.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(doc, null, 2), "utf8");
  await rename(tmp, docPath(slug));
  return doc;
}

/** Forward-compatible reads: an older doc is migrated in memory on load. */
function migrate(doc) {
  if (!doc || typeof doc !== "object") return null;
  if (!doc.kind) doc.kind = "mv";
  if (!Array.isArray(doc.runs)) doc.runs = [];
  if (doc.kind === "mv" && !Array.isArray(doc.previz)) doc.previz = [];
  /* The plan array, on BOTH kinds, in the shape `previz` and `runs` already
   * use. DOC_VERSION is deliberately NOT bumped: a default-empty-array
   * migration reads forward and backward, and bumping would make an older
   * build refuse a document it can read perfectly. */
  if (!Array.isArray(doc.plans)) doc.plans = [];
  if (doc.kind === "mv" && !doc.brief) doc.brief = blankProject(doc.title).brief;
  if (doc.kind === "audiobook") {
    if (!Array.isArray(doc.beds)) doc.beds = [];
    if (!Array.isArray(doc.bundles)) doc.bundles = [];
    if (!Array.isArray(doc.cast)) doc.cast = [];
    if (!doc.settings) doc.settings = blankProject(doc.title, "audiobook").settings;
  }
  return doc;
}

export async function readProject(slug) {
  try {
    return migrate(JSON.parse(await readFile(docPath(slug), "utf8")));
  } catch {
    return null;
  }
}

/**
 * Read, mutate, write — atomically with respect to every other writer.
 *
 * `fn` receives the live document and may mutate it in place or return a
 * replacement. Returning `false` abandons the write, which is how a caller
 * refuses a no-op without having to throw.
 */
export async function updateProject(slug, fn) {
  return enqueue(slug, async () => {
    const doc = await readProject(slug);
    if (!doc) throw new Error(`No such project: ${slug}`);
    const out = await fn(doc);
    if (out === false) return doc;
    const next = out && typeof out === "object" ? out : doc;
    next.updatedAt = Date.now();
    return writeDoc(slug, next);
  });
}

/* `brief` (optional) is laid over a new video's blank brief: the routes pass
 * the card's size (server/mv/sizes.js), worked out when the project is made. */
export async function createProject(title, kind = "mv", { brief = null } = {}) {
  const doc = blankProject(title, kind);
  if (brief && doc.brief) Object.assign(doc.brief, brief);
  // Two projects called "Neon" must not become one folder. The suffix is only
  // added on a real collision so the common case stays readable.
  let slug = doc.slug, n = 2;
  while (await readProject(slug)) slug = `${doc.slug}-${n++}`;
  doc.slug = slug;
  return enqueue(slug, () => writeDoc(slug, doc));
}

export async function deleteProject(slug) {
  return enqueue(slug, async () => {
    await rm(projectDir(slug), { recursive: true, force: true });
    return true;
  });
}

/**
 * WHEN THIS PROJECT LAST PRODUCED SOMETHING, as against when it was last poked.
 *
 * `updatedAt` moves on every write — renaming a prop, ticking a checkbox,
 * saving a description — so a picker sorted by it says which project was most
 * recently TOUCHED, which is not the question anybody actually has. The one
 * worth showing beside it is when a render last landed, and that is already on
 * disk: every take carries the moment it was made.
 *
 * Derived rather than stored for the usual reason — a stored timestamp goes
 * wrong the moment a take is deleted, and there is no migration to write.
 * Null is a real answer and means nothing has ever been rendered here.
 */
export function lastRenderAt(doc) {
  let at = 0;
  const scan = (rows) => {
    for (const r of rows || []) {
      for (const t of r.takes || []) {
        const when = typeof t === "string" ? 0 : Number(t?.at);
        if (Number.isFinite(when) && when > at) at = when;
      }
    }
  };
  scan(doc.characters); scan(doc.backgrounds); scan(doc.props);
  scan(doc.boards); scan(doc.clips);
  // An audiobook's artefacts are its mixes and its beds, not takes.
  for (const b of doc.bundles || []) if (Number(b.mixedAt) > at) at = Number(b.mixedAt);
  for (const b of doc.beds || []) if (Number(b.at) > at) at = Number(b.at);
  return at || null;
}

export async function listProjects() {
  let names = [];
  try {
    names = (await readdir(MV_DIR(), { withFileTypes: true }))
      .filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const rows = await Promise.all(names.map(async (slug) => {
    const doc = await readProject(slug);
    if (!doc) return null;
    if (doc.kind === "audiobook") {
      return {
        slug: doc.slug, id: doc.id, title: doc.title, kind: "audiobook",
        stage: stageOfDoc(doc),
        updatedAt: doc.updatedAt, createdAt: doc.createdAt, renderedAt: lastRenderAt(doc),
        book: doc.book?.title ?? null,
        counts: {
          chapters: doc.book?.chapters?.length ?? 0,
          bundles: doc.bundles.length,
          mixed: doc.bundles.filter((b) => b.mixFile).length,
          beds: doc.beds.length,
        },
      };
    }
    return {
      slug: doc.slug, id: doc.id, title: doc.title, kind: "mv",
      stage: stageOfDoc(doc),
      updatedAt: doc.updatedAt, createdAt: doc.createdAt, renderedAt: lastRenderAt(doc),
      song: doc.song?.file ?? null,
      counts: {
        segments: doc.segments.length,
        characters: doc.characters.length,
        /* PROPS WERE THE ONE ASSET ARRAY THIS ROW DID NOT COUNT, which is a
         * small omission with a large shadow: the project picker is where you
         * decide what a project HAS, and a video whose whole continuity problem
         * is an object reported "0 characters" and said nothing about the
         * eleven props holding it together. */
        props: (doc.props || []).length,
        backgrounds: doc.backgrounds.length,
        boards: doc.boards.length,
        clips: doc.clips.length,
        clipsDone: doc.clips.filter((c) => c.status === "done").length,
      },
    };
  }));
  return rows.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}

/* ────────────────────────────────── what "this row has a body" means now */

/**
 * A cast row is COMPLETE when it has been given a body — a rendered sheet, a
 * mesh, or both.
 *
 * ⚠ THIS USED TO BE `!r.imageFile`, WRITTEN OUT IN FOUR PLACES, and that was
 * correct for exactly as long as a picture was the only thing a row could hold.
 * `server/mesh/` gives a row a `meshFile`, which is a STRONGER identity anchor
 * than a sheet by the same argument DIRECTING.md makes for Blender — an image
 * model re-invents an object from its description on every call; a mesh IS the
 * same object. A row holding one and reported as "pending" would stall the rail
 * on a stage nothing can advance, and mv_lint would report a gap that is filled.
 *
 * ONE predicate, exported, because the failure of four copies is that they
 * drift: the stage machine here, bible.js's per-scene reference check and its
 * declaredAssets flattener all ask this, and a project cannot be complete on one
 * screen and pending on another.
 *
 * ⚠ WHAT IT DELIBERATELY DOES NOT MEAN. It is not "this row can be handed to a
 * model as a reference". The clip engines take PICTURES — control.js's IMAGE_RE
 * is unchanged and a mesh is never a VACE reference — so bible.js keeps a
 * separate, quieter line for a row that has a mesh and no sheet. Complete is
 * about the declaration; reference-readiness is about the render.
 */
export const assetComplete = (r) => !!(r?.imageFile || r?.meshFile);

/* ─────────────────────────────────────────────────── stage, derived */

/**
 * The stage is DERIVED from what the document contains, never stored.
 *
 * The website stores it in a jsonb key and writes only 7 of its 13 values —
 * `backgrounds`, `storyboards`, `finish` and `complete` are set by no code path
 * at all, so its stepper really unlocks on content anyway. Deriving means the
 * label can never disagree with the artefacts, and undoing work walks the label
 * back instead of stranding it.
 */
export function stageOfDoc(doc) {
  if (doc?.kind === "audiobook") {
    if (!doc.book) return "ingest";
    if (!doc.bundles.length) return "plan";
    if (!doc.voice) return "voice";
    const mixed = doc.bundles.filter((b) => b.mixFile).length;
    if (!mixed) return "narrate";
    if (mixed < doc.bundles.length) return "produce";
    return "complete";
  }
  if (!doc?.song) return "draft";
  if (!doc.segments.length) return "upload_analyze";
  if (!doc.brief?.directionSummary && !doc.styleBible) return "interview";
  if (!doc.styleBible || !doc.story) return "master_gen";
  if (!doc.boards.length) return "story_review";
  const need = (rows) => rows.some((r) => !assetComplete(r));
  /* PROPS SHARE THE CAST STAGE and this gate ignored them, so the rail walked
   * straight past a declared prop with no sheet — the exact row whose absence
   * DIRECTING.md calls "dropped in silence". A character without a picture
   * stops the stage; an object without one is the same failure and now stops it
   * too. No new stage id: `props` is not in the ported stage machine, ids there
   * are persisted, and "Characters & props" on one stage is the honest label. */
  if (doc.characters.length && need(doc.characters)) return "characters";
  if ((doc.props || []).length && need(doc.props)) return "characters";
  if (doc.backgrounds.length && need(doc.backgrounds)) return "backgrounds";
  if (!doc.clips.length) return "storyboards";
  if (doc.clips.some((c) => c.status !== "done")) return "video";
  if (!doc.timelineProject) return "rough_cut";
  if (!doc.exports?.length) return "finish";
  return "complete";
}

/** Append a run record. Bounded — this is a breadcrumb trail, not an audit log. */
export function noteRun(doc, entry) {
  doc.runs.unshift({ at: Date.now(), ...entry });
  doc.runs = doc.runs.slice(0, 200);
  return doc;
}

/* ──────────────────────────────────── names are keys: the rename cascade */

/**
 * A CAST NAME IS NOT A LABEL. It is the key every board reference, every
 * prominence weight, every recorded take and every prompt sentence resolves
 * through — add_asset refuses a duplicate for exactly that reason ("names bind
 * references across the whole project"). So renaming a row is a graph edit, and
 * doing it as a field assignment is how a project goes from 1 continuity break
 * to 4 breaks and 2 errors in one blur event: measured on the felt-hammers
 * sequence, renaming a prop that two boards carried left both boards pointing
 * at something that no longer exists, and the render would have dropped it in
 * silence.
 *
 * These two functions are the whole of that knowledge, and they are PURE —
 * document in, document out, no files, no clock, no queue — so the route can
 * ask "what would break" and "break nothing" with the same walker. One walker,
 * two verbs, because a survey and an edit that disagreed about where the name
 * lives would be worse than neither.
 */

/** Reference lists are matched by name, case-insensitively — bible.js's rule. */
const nameKey = (v) => String(v ?? "").trim().toLowerCase();

/**
 * Whole-word matching for prose. `\b` is wrong here: cast names carry spaces
 * and digits ("Mk II Metronome"), and a bare substring swap would rewrite
 * "Vire" inside "Vireo". Letters, digits and underscore either side block a
 * match; punctuation and spaces do not.
 */
function nameProse(name) {
  const src = `(^|[^\\p{L}\\p{N}_])(${String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![\\p{L}\\p{N}_])`;
  return {
    mentions: (s) => typeof s === "string" && new RegExp(src, "iu").test(s),
    swap: (s, to) => String(s).replace(new RegExp(src, "giu"), (_m, pre) => pre + to),
  };
}

/**
 * Every site one name occupies, each with the setter that would move it.
 *
 * Two classes, and the difference decides nothing here but explains the report:
 *   BINDING — a key something resolves THROUGH. Left behind, the reference is
 *             dead and the render silently carries nothing.
 *   PROSE   — text that reaches a model. Left behind, the prompt asks for a
 *             thing by a name the bible no longer declares.
 * A third class, `elsewhere`, is REPORTED AND NEVER REWRITTEN: the synopsis,
 * the arc, another row's description. That is authored prose about the story
 * rather than an input to a render, and a rename that quietly edited someone's
 * synopsis would be a surprise, not a repair.
 */
function nameSites(doc, name) {
  const key = nameKey(name), prose = nameProse(name);
  const sites = [], elsewhere = [];
  const scene = (b) => (Number.isFinite(b?.segmentIndex) ? b.segmentIndex + 1 : null);
  const bind = (where, sc, set) => sites.push({ cls: "binding", where, scene: sc, set });
  const text = (where, sc, set) => sites.push({ cls: "prose", where, scene: sc, set });

  for (const board of doc.boards || []) {
    const sc = scene(board);
    for (const field of ["characterRefs", "backgroundRefs", "propRefs"]) {
      const list = board[field];
      if (!Array.isArray(list)) continue;
      list.forEach((n, i) => {
        if (nameKey(n) === key) bind(`scene ${sc} ${field}`, sc, (to) => { list[i] = to; });
      });
    }
    const prom = board.refProminence;
    if (prom && Object.keys(prom).some((k) => nameKey(k) === key)) {
      bind(`scene ${sc} refProminence`, sc, (to) => {
        for (const k of Object.keys(prom)) {
          if (nameKey(k) !== key) continue;
          const v = prom[k]; delete prom[k]; prom[to] = v;
        }
      });
    }
    for (const field of ["boardPrompt", "grade"]) {
      if (prose.mentions(board[field])) {
        text(`scene ${sc} ${field}`, sc, (to) => { board[field] = prose.swap(board[field], to); });
      }
    }
    (board.shots || []).forEach((sh, i) => {
      if (prose.mentions(sh.action)) {
        text(`scene ${sc} shot ${i + 1} action`, sc, (to) => { sh.action = prose.swap(sh.action, to); });
      }
    });
  }

  for (const clip of doc.clips || []) {
    const sc = Number.isFinite(clip.clipIndex) ? clip.clipIndex + 1 : null;
    if (prose.mentions(clip.promptOverride)) {
      text(`scene ${sc} hand-written prompt`, sc, (to) => { clip.promptOverride = prose.swap(clip.promptOverride, to); });
    }
    /* A TAKE'S RECORD OF WHAT MADE IT. The evidence is the FILE — that does not
     * move — and the name beside it is a pointer at the row. Left behind, the
     * take inspector captions a picture with a name the project no longer has,
     * which reads as a reference that resolved to nothing. */
    (clip.takes || []).forEach((t, ti) => {
      for (const field of ["refs", "refsMissing"]) {
        (Array.isArray(t?.[field]) ? t[field] : []).forEach((r, ri) => {
          if (nameKey(r?.name) === key) {
            bind(`scene ${sc} take ${ti + 1} ${field}`, sc, (to) => { t[field][ri].name = to; });
          }
        });
      }
    });
  }

  /* Named, not moved. */
  for (const [where, v] of [["styleBible", doc.styleBible], ["lookBible", doc.lookBible],
                            ["story.logline", doc.story?.logline], ["story.synopsis", doc.story?.synopsis]]) {
    if (prose.mentions(v)) elsewhere.push(where);
  }
  for (const [kind, list] of [["characters", doc.characters], ["backgrounds", doc.backgrounds], ["props", doc.props]]) {
    for (const row of list || []) {
      if (nameKey(row?.name) === key) continue;              // the row being renamed
      if (prose.mentions(row?.description) || prose.mentions(row?.sheetPrompt) || prose.mentions(row?.platePrompt)) {
        elsewhere.push(`${kind}: ${row.name}`);
      }
    }
  }
  return { sites, elsewhere };
}

/** A one-line summary of a set of sites, and the scenes they sit in. */
function summarise({ sites, elsewhere }) {
  return {
    total: sites.length,
    binding: sites.filter((s) => s.cls === "binding").length,
    prose: sites.filter((s) => s.cls === "prose").length,
    scenes: [...new Set(sites.map((s) => s.scene).filter(Number.isFinite))].sort((a, b) => a - b),
    where: sites.map((s) => s.where),
    elsewhere,
  };
}

/**
 * What would move if this name changed — a survey that writes nothing.
 * This is what the 400 for a refused rename is built from.
 */
export function assetReferences(doc, name) {
  return summarise(nameSites(doc, name));
}

/**
 * Rename a declared row AND every reference to it, in one pass over one
 * document. The row is renamed HERE rather than by the caller so the two halves
 * cannot come apart — a cascade that ran without the rename, or a rename whose
 * cascade threw halfway, is the defect this exists to remove.
 */
export function cascadeRename(doc, row, nextName) {
  const to = String(nextName ?? "").trim();
  if (!to) throw new Error("A rename needs a name.");
  const found = nameSites(doc, row.name);
  for (const s of found.sites) s.set(to);
  const report = summarise(found);
  report.from = row.name;
  report.to = to;
  row.name = to;
  return report;
}

/* ─────────────────────────────────────────────────── asset staging */

/**
 * Copy a file into the project's own assets folder.
 *
 * Assets are COPIED, not referenced: a project has to survive the library being
 * re-tagged, a cover being regenerated, or a source file being moved. Named by
 * content hash so importing the same picture twice costs one file.
 */
export async function stageAsset(slug, srcPath, prefix = "asset") {
  const { createHash } = await import("node:crypto");
  const buf = await readFile(srcPath);
  const ext = path.extname(srcPath).toLowerCase() || ".png";
  const name = `${prefix}_${createHash("sha1").update(buf).digest("hex").slice(0, 12)}${ext}`;
  await mkdir(assetsDir(slug), { recursive: true });
  const dest = path.join(assetsDir(slug), name);
  try { await stat(dest); } catch { await writeFile(dest, buf); }
  return name;
}
