/**
 * Video Workflow — healing drift: the stale-clip sweep.
 *
 * WHY THIS EXISTS. The store has always been honest about drift and useless at
 * fixing it. Commit a bible and every clip built on the old board gets
 * `status: "stale"`; re-pick a face and every board that leaned on it gets
 * `staleRefs`; re-segment and everything downstream gets `staleSegments`. All
 * true, all recorded — and then a person had to right-click twelve items one at
 * a time. A project that drifts faster than a human regenerates it is a project
 * that never converges.
 *
 * THE STALENESS IS NOT INVENTED HERE. Every reason below is read from a field
 * something else already writes; this module only joins them up and acts:
 *
 *   board         clip.status === "stale"   bible.js, on commit / board upsert
 *   segments      clip.staleSegments        routes.js segment(), on a re-cut
 *   board-refs    board.staleRefs           generate.js pickTake(), on a re-pick
 *   board-newer   take.at < board.updatedAt the board was authored after the render
 *   refs          take.at < sheet take.at   the face moved after the render
 *   unnamed-refs  clip.prompt               rendered with references it never named
 *
 * That last one is the defect the overnight run exposed and the reason a flag
 * alone is not enough: the sheets WERE attached, so nothing was ever marked
 * stale, but the prompt never said the words `<Picture 1> is …` and every scene
 * invented a different performer. The recorded prompt is the evidence — a clip
 * that would carry named references today and does not carry them on record was
 * rendered by the older builder. Spoken MV is entirely in this state.
 *
 * DRY RUN IS THE DEFAULT. A sweep spends GPU minutes per clip and the caller is
 * usually an agent that has not looked yet, so `dryRun` is opt-out, never
 * opt-in. Renders run ONE AT A TIME through `generateClip` — the same path
 * `generate_clip` uses, so a swept clip is identical to a hand-regenerated one
 * (same segment, same cast, same soundtrack window, fresh seed, earlier takes
 * kept) — and a failure is recorded and stepped over, because losing eleven
 * good regenerations to the twelfth one's timeout is not an acceptable trade.
 */
import { readProject, updateProject, noteRun } from "./store.js";
import { generateClip } from "./generate.js";
import { resolveShot } from "./shot.js";

/* Legacy rows store a take as a bare filename string. Same tolerance as
 * timeline_read.js, for the same reason: the oldest projects are the ones with
 * the most drift, so they must not be the ones that throw. */
const takeFile = (t) => (typeof t === "string" ? t : (t?.clip ?? t?.file ?? null));
const takeSeed = (t) => (typeof t === "string" ? null : (t?.seed ?? null));
const takeAt = (t) => (typeof t === "string" ? null : (Number.isFinite(t?.at) ? t.at : null));

/** When the newest take landed. Null when no take records a time. */
function renderedAt(clip) {
  const ats = (clip.takes || []).map(takeAt).filter((n) => n != null);
  return ats.length ? Math.max(...ats) : null;
}

/* The legend the current clip builder emits for every reference it is given
 * (shot.js clipPrompt). Its ABSENCE from a recorded prompt, on a clip that has
 * references to name, is what "rendered before the reference-naming fix" looks
 * like on disk. */
const REF_LEGEND = "<Picture 1> is";

/**
 * Which sheets a clip would carry today.
 *
 * ⚠ THIS USED TO BE A HAND-KEPT MIRROR of generateClip's reference resolution,
 * carrying its own warning that it "has to agree with the renderer or the sweep
 * reasons about a clip nobody will make". It did not agree: it read
 * characterRefs and backgroundRefs and never propRefs, which the renderer has
 * carried since props became cast — so every prop-only board looked ref-less to
 * the sweep. A comment asking the next reader to keep two copies in step is not
 * a mechanism. `resolveShot` is the renderer's own reasoning, so there is now
 * one copy and the question cannot be answered two ways.
 */
function refsNow(doc, seg, _board) {
  try { return resolveShot(doc, seg.id).refs; } catch { return []; }
}

/* A name listed as BOTH a characterRef and a backgroundRef resolves twice — the
 * renderer really does send that sheet twice, so refsNow keeps the duplicate,
 * but a report that says a name twice reads as a bug rather than as fidelity. */
const nameList = (rows) => [...new Set(rows.map((r) => r.name))];

/**
 * Every clip that no longer tells the truth about its inputs.
 *
 * Pure — it reads the document and nothing else, which is what lets the route,
 * the dry run and the real sweep all agree about what is stale.
 */
export function scanStale(doc) {
  const rows = [];
  for (const clip of doc.clips || []) {
    // A clip with no take is unrendered, not stale. Nothing to heal.
    if (!clip.clipFile && !(clip.takes || []).length) continue;

    const seg = doc.segments.find((s) => s.id === clip.segmentId);
    const board = doc.boards.find((b) => b.segmentId === clip.segmentId
      || (seg && b.segmentIndex === seg.index));
    const at = renderedAt(clip);
    const reasons = [];
    const detail = {};

    if (clip.status === "stale") reasons.push("board");
    if (clip.staleSegments) reasons.push("segments");
    if (board?.staleRefs) reasons.push("board-refs");
    if (at != null && Number.isFinite(board?.updatedAt) && at < board.updatedAt) {
      reasons.push("board-newer");
      detail.boardUpdatedAt = board.updatedAt;
    }

    const refs = seg ? refsNow(doc, seg, board) : [];
    if (at != null) {
      const moved = [];
      /* A resolved reference names a sheet; WHEN that sheet was picked lives on
       * the asset row, so the row is looked up by name. resolveShot returns
       * {name, kind, file} rather than the row itself, deliberately — it is a
       * record of what the render was given, not a handle into the document. */
      for (const r of refs) {
        const src = doc.characters.find((c) => c.name === r.name)
          || doc.backgrounds.find((g) => g.name === r.name)
          || (doc.props || []).find((p) => p.name === r.name);
        const chosen = (src?.takes || []).find((t) => takeFile(t) === r.file);
        const ct = takeAt(chosen);
        if (ct != null && ct > at) moved.push(r.name);
      }
      if (moved.length) { reasons.push("refs"); detail.movedRefs = [...new Set(moved)]; }
    }

    if (refs.length && typeof clip.prompt === "string" && clip.prompt && !clip.prompt.includes(REF_LEGEND)) {
      reasons.push("unnamed-refs");
      detail.wouldName = nameList(refs);
    }

    if (!reasons.length) continue;

    /* Blockers are reported, never silently dropped: a stale clip that cannot
     * be regenerated is exactly the thing a human needs told. */
    let blocked = null;
    if (!seg) blocked = `its segment ${clip.segmentId} no longer exists — re-segmenting orphaned it`;
    else if (seg.mode !== "generate") blocked = `scene ${seg.index + 1} is set to ${seg.mode}`;

    const newest = (clip.takes || [])[(clip.takes || []).length - 1];
    rows.push({
      clipId: clip.id,
      segmentId: clip.segmentId,
      scene: (seg?.index ?? clip.clipIndex) + 1,
      sceneIndex: seg?.index ?? clip.clipIndex,
      reasons,
      detail: Object.keys(detail).length ? detail : undefined,
      blocked,
      oldTake: newest
        ? { n: clip.takes.length, of: clip.takes.length, clip: takeFile(newest), seed: takeSeed(newest), at: takeAt(newest) }
        : null,
      currentFile: clip.clipFile ?? null,
      engine: clip.engine ?? null,
    });
  }
  return rows.sort((a, b) => a.sceneIndex - b.sceneIndex);
}

/**
 * What a clip has actually cost on THIS project, from the breadcrumb trail.
 *
 * Measured rather than assumed: the runs list already carries a timestamp per
 * generate_clip, so consecutive renders give real wall-clock spacing. Gaps over
 * an hour are dropped — that is somebody going to bed, not a render.
 *
 * ⚠ EXPORTED so the plan's estimator uses THIS function rather than a second
 * copy of the same idea. A plan that quoted minutes from its own arithmetic
 * while `mv_regen_stale` quoted them from the runs list would be two answers to
 * one question, and the one that is wrong is whichever the person is not
 * looking at. Same function, same `{perClipMinutes, samples}` vocabulary.
 */
/**
 * ⚠ AND IT IS PER ENGINE, which it was not, and the difference is a factor of
 * six. MEASURED on felt-hammers: the project rendered its first pass on ltx,
 * the brief was switched to h3, and every estimate afterwards kept quoting the
 * ltx median — 8.7 minutes — while the cost table for the same shot on h3 said
 * 50. The gap between two run timestamps is a real number about a real render,
 * and the render it is about is the one on the LATER side of the gap: attribute
 * it to that clip's engine or it is a number about something else.
 *
 * The engine comes off the run entry's own `engine` field. Documents written
 * before that field existed carry it inside the outcome sentence
 * ("scene 4 -> x.mp4 (seed 12, ltx, 2 refs)"), which is parsed rather than
 * thrown away — the whole corpus predates the field, and a measurement that
 * only works on tomorrow's projects is not a measurement.
 *
 * @param engine  restrict to renders made on this engine. Null (the default)
 *                keeps every gap, which is the old behaviour and is still what
 *                mv_regen_stale's dry run wants: its sweep is one engine, the
 *                project's current one, by construction.
 */
/**
 * WHICH ENGINE MADE THE CLIP THIS RUN ENTRY IS ABOUT — three sources, best
 * first, because the answer has to work on the library that exists.
 *
 *   1. `r.engine`, written by generateClip from today on.
 *   2. the word inside the outcome sentence, for the window where the sentence
 *      carried it and the field did not.
 *   3. THE TAKE ITSELF. The outcome always names the file it made, and the take
 *      that holds that file records the engine that made it. Measured over the
 *      whole corpus: 346 of 346 generate_clip entries resolve this way, and NONE
 *      of them resolves by 1 or 2 — every document on this rig predates both.
 *      A measurement that only works on tomorrow's projects is not one.
 */
function engineIndex(doc) {
  const byFile = new Map();
  for (const c of doc.clips || []) {
    for (const t of c.takes || []) {
      const k = t.clip ?? t.file;
      if (k) byFile.set(k, t.engine || c.engine || null);
    }
    if (c.clipFile && !byFile.has(c.clipFile)) byFile.set(c.clipFile, c.engine || null);
  }
  return byFile;
}
const lc = (v) => (v ? String(v).toLowerCase() : null);
function runEngine(r, byFile) {
  if (r.engine) return lc(r.engine);
  const said = /\(seed [^,)]*,\s*([a-z0-9_-]+)/i.exec(String(r.outcome || ""));
  if (said) return lc(said[1]);
  const file = /([\w.-]+\.(?:mp4|webm|mov|mkv|m4v))/i.exec(String(r.outcome || ""));
  return file ? lc(byFile.get(file[1])) : null;
}

/** Every generate_clip entry with the engine that made it, oldest first.
 *  EXPORTED so the attribution can be proved against the real library rather
 *  than asserted about a fixture — it is the half of the estimate that a
 *  hand-built document cannot exercise. */
export function clipRunEngines(doc) {
  const byFile = engineIndex(doc);
  return (doc.runs || []).filter((r) => r.tool === "generate_clip")
    .map((r) => ({ at: r.at, engine: runEngine(r, byFile) }))
    .sort((a, b) => a.at - b.at);
}

export function measuredMinutesPerClip(doc, engine = null) {
  const runs = clipRunEngines(doc);
  const gaps = [];
  for (let i = 1; i < runs.length; i++) {
    const g = (runs[i].at - runs[i - 1].at) / 60000;
    if (g > 0.5 && g < 60) gaps.push({ minutes: g, engine: runs[i].engine });
  }
  const want = engine ? gaps.filter((x) => x.engine === engine) : gaps;
  /* Two is the floor because one gap is a coincidence. Fewer than two on THIS
   * engine is an absent measurement, and absent is reported as absent — the
   * caller falls back to the table and says so. */
  if (want.length < 2) return null;
  const mins = want.map((x) => x.minutes).sort((a, b) => a - b);
  return { perClipMinutes: Math.round(mins[Math.floor(mins.length / 2)] * 10) / 10,
           samples: want.length, engine: engine ?? null };
}

/**
 * Sweep the stale clips: report by default, regenerate when told to.
 *
 * @param segmentIds  restrict to these — segment ids, clip ids, or 0-based
 *                    segment indices, the same three the rest of the workflow
 *                    accepts. A 1-based scene number is deliberately NOT
 *                    matched: "9" would then mean two different scenes.
 * @param limit       how many to regenerate (the report always lists them all).
 */
export async function regenStale(deps, slug, { dryRun = true, limit, segmentIds } = {}) {
  const doc = await readProject(slug);
  if (!doc) throw new Error(`No such project: ${slug}`);
  if (doc.kind === "audiobook") throw new Error("Audiobook projects have no clips to regenerate.");

  const started = Date.now();
  const all = scanStale(doc);

  let picked = all;
  if (Array.isArray(segmentIds) && segmentIds.length) {
    const want = new Set(segmentIds.map(String));
    const keys = (r) => [r.segmentId, r.clipId, r.sceneIndex].map(String);
    picked = all.filter((r) => keys(r).some((k) => want.has(k)));
    const unknown = [...want].filter((w) => !all.some((r) => keys(r).includes(w)));
    if (unknown.length && !picked.length) {
      throw new Error(`Nothing stale matches ${unknown.join(", ")} — run with dry_run to see what is.`);
    }
  }
  const runnable = picked.filter((r) => !r.blocked);
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : runnable.length;
  const queue = runnable.slice(0, cap);

  const clips = picked.map((r) => ({
    ...r,
    selected: queue.includes(r),
    newTake: null,
    seed: null,
    error: r.blocked ? `skipped: ${r.blocked}` : null,
  }));
  const seen = new Map(clips.map((c) => [c.clipId, c]));

  if (dryRun) {
    const engine = doc?.brief?.videoEngine || null;
    const est = measuredMinutesPerClip(doc, engine);
    return {
      slug, dryRun: true,
      scanned: (doc.clips || []).length,
      stale: all.length,
      blocked: picked.filter((r) => r.blocked).length,
      selected: queue.length,
      would: queue.map((r) => `scene ${r.scene} (${r.reasons.join(", ")})`),
      estimate: est ? { perClipMinutes: est.perClipMinutes,
                        totalMinutes: Math.round(est.perClipMinutes * queue.length),
                        measuredFrom: `${est.samples} previous ${engine || ""} renders in this project` } : null,
      clips,
      note: queue.length
        ? `Nothing has been rendered. Call again with dry_run false to spend the GPU on ${queue.length} clip${queue.length === 1 ? "" : "s"}.`
        : "Nothing to do.",
    };
  }

  let ok = 0, failed = 0;
  for (const r of queue) {
    const row = seen.get(r.clipId);
    try {
      /* No seed: a re-roll is the point, and every relationship the render
       * needs (segment, board, cast, soundtrack window) is read fresh from the
       * document by generateClip, so this is the same shot remade with today's
       * inputs rather than a reconstruction from memory. */
      const after = await generateClip(deps, slug, { segmentId: r.segmentId });
      const c2 = after.clips.find((c) => c.id === r.clipId) || after.clips.find((c) => c.segmentId === r.segmentId);
      const nt = (c2?.takes || [])[(c2?.takes || []).length - 1];
      row.newTake = nt ? { n: c2.takes.length, of: c2.takes.length, clip: takeFile(nt), at: takeAt(nt) } : null;
      row.seed = takeSeed(nt);
      ok++;
    } catch (err) {
      // One wedged render must not cost the caller the ones that worked.
      row.error = String(err?.message || err);
      failed++;
    }
  }

  await updateProject(slug, (d) => {
    noteRun(d, { tool: "mv_regen_stale",
      outcome: `${ok}/${queue.length} stale clips regenerated${failed ? `, ${failed} failed` : ""} (of ${all.length} stale)` });
    return d;
  });

  return {
    slug, dryRun: false,
    scanned: (doc.clips || []).length,
    stale: all.length,
    blocked: picked.filter((r) => r.blocked).length,
    selected: queue.length,
    regenerated: ok, failed,
    remaining: all.length - ok,
    elapsedSec: Math.round((Date.now() - started) / 1000),
    clips,
  };
}
