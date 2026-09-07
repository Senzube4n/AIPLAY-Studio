/**
 * Video Workflow — reading a human's cut back OUT of Studio.
 *
 * WHY THIS EXISTS. `build_timeline` is a one-way door. It composes a Studio
 * project from the workflow and then the agent that composed it is blind: a
 * human opens the timeline, cycles scene 9 to another take, tightens the first
 * cut by 0.4 s, drops a title card in — and every later workflow decision is
 * argued against a cut that no longer exists. The linkage to close the loop was
 * already stamped on the way out (`mvClipId` per item, `mvProjectId` on the
 * doc); nothing read it back.
 *
 * So this module reads the SAVED Studio document, matches every item to the
 * clip and the exact TAKE that made it, and diffs it against what
 * `build_timeline` would emit right now. The diff is the product — "you swapped
 * scene 9 to take 1 and moved it 0.4 s earlier" is a sentence an agent can act
 * on; a list of item starts is not.
 *
 * READ-ONLY BY CONSTRUCTION, which is why it does not call `buildTimeline` to
 * get its own baseline: that function writes a breadcrumb and needs the library
 * handle. The expected projection is recomputed here from the same three facts
 * (the segment's start, the segment's duration, the clip's current pick) and is
 * a deliberate MIRROR of buildTimeline's item shaping — the two move together.
 *
 * WHAT IT CANNOT SEE, stated up front because a confident wrong answer here is
 * worse than a gap:
 *   · Only what was SAVED. An edit sitting in an open browser tab is invisible.
 *   · Anything without `mvClipId` is "foreign" — a hand-imported clip and a
 *     workflow clip whose linkage was lost look identical from here.
 *   · Track state (mute/solo/level), fx, vis, lrc, fades and the output settings
 *     are not compared; this is an edit list, not a project differ.
 *   · "Moved" and "reordered" are both inferred from `start`, so a swap of two
 *     neighbours reports as both, which is what actually happened.
 *   · A source that is not any known take is `relinked` — we can say it is not
 *     ours, never whether that was an upgrade or a mistake.
 */
import path from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import { config } from "../config.js";
import { readProject } from "./store.js";

/** Studio keeps its projects beside the media, not in the browser. */
const PROJECT_DIR = () => path.join(config.outputDir, "projects");

/* A Studio project's filename is DERIVED from its name and never taken from a
 * client — mirrored from index.js's saveStudioProject so the reader lands on
 * exactly the file the Save button wrote. */
const projectFile = (name) =>
  `${String(name ?? "").replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "project"}.json`;

/* Timing lives in seconds as floats. 5 ms is a sixth of a frame at 30 fps —
 * below anything a human can drag, above the rounding buildTimeline does when
 * it writes starts and durations to 3 decimals. */
const EPS = 0.005;

/* Older documents stored a take as a bare filename string before the
 * {file,seed,at} shape landed (Glass And Neon still holds one). Every read of a
 * take goes through these, because a crash on a legacy row would make the loop
 * unusable on exactly the projects that need it most. */
const takeFile = (t) => (typeof t === "string" ? t : (t?.clip ?? t?.file ?? null));
const takeSeed = (t) => (typeof t === "string" ? null : (t?.seed ?? null));
const takeAt = (t) => (typeof t === "string" ? null : (Number.isFinite(t?.at) ? t.at : null));

/** `/api/clip/mv_x.mp4` → `{ kind: "clip", name: "mv_x.mp4" }`. */
function sourceOf(src) {
  const s = String(src ?? "");
  const m = /^\/api\/(clip|audio|images?|cover)\//.exec(s);
  let name = s.split("/").pop() || s;
  try { name = decodeURIComponent(name); } catch { /* a literal % is still a name */ }
  return { kind: m ? m[1] : "other", name };
}

const round3 = (n) => Number(Number(n ?? 0).toFixed(3));

/**
 * Find the Studio document this workflow produced.
 *
 * Two routes, in order: the name the workflow recorded, then a scan for the
 * `mvProjectId` back-pointer. The scan is what survives a human pressing Save
 * As under a new name — the derived filename misses, the stamped id does not.
 */
async function findTimelineDoc(slug, doc, explicit) {
  const dir = PROJECT_DIR();
  const tried = [];

  const load = async (file) => {
    try {
      const full = path.join(dir, file);
      const [raw, st] = await Promise.all([readFile(full, "utf8"), stat(full)]);
      return { file, doc: JSON.parse(raw), mtimeMs: st.mtimeMs };
    } catch { return null; }
  };

  for (const [name, how] of [[explicit, "explicit"], [doc?.timelineProject, "name"]]) {
    if (!name) continue;
    const file = projectFile(name);
    tried.push(file);
    const hit = await load(file);
    // A file that names a DIFFERENT workflow is a collision, not our cut.
    if (hit && (!hit.doc.mvProjectId || hit.doc.mvProjectId === slug)) return { ...hit, matchedBy: how };
  }

  let names = [];
  try { names = (await readdir(dir)).filter((f) => f.endsWith(".json")); } catch { /* none saved yet */ }
  const backlinked = [];
  for (const file of names) {
    const hit = await load(file);
    if (hit?.doc?.mvProjectId === slug) backlinked.push(hit);
  }
  if (backlinked.length) {
    backlinked.sort((a, b) => (b.doc.savedAt ?? b.mtimeMs) - (a.doc.savedAt ?? a.mtimeMs));
    return { ...backlinked[0], matchedBy: "mvProjectId" };
  }

  throw new Error(
    doc?.timelineProject
      ? `No saved Studio project for "${doc.timelineProject}" (looked for ${tried.join(", ")} and for any project stamped mvProjectId "${slug}"). Open it in Studio and Save, or run build_timeline again.`
      : `This workflow has never been moved to Studio — run build_timeline first.`,
  );
}

/**
 * What `build_timeline` would emit RIGHT NOW.
 *
 * ⚠ MIRROR of buildTimeline's item shaping in generate.js — same filter (a clip
 * with a chosen file), same order (clipIndex), same rounding. Change one, change
 * both, or the diff starts reporting drift that only exists in this file.
 */
export function expectedItems(doc) {
  const out = [];
  for (const c of doc.clips.filter((x) => x.clipFile).sort((a, b) => a.clipIndex - b.clipIndex)) {
    const seg = doc.segments.find((s) => s.id === c.segmentId);
    if (!seg) continue;
    out.push({
      mvClipId: c.id,
      name: `scene ${seg.index + 1}`,
      sceneIndex: seg.index,
      source: c.clipFile,
      start: round3(seg.startSec),
      dur: round3(seg.durationSec),
      inPoint: 0,
      srcDur: c.durationSeconds || seg.durationSec,
    });
  }
  return out;
}

/** Which take of its clip a source file is. Null when it is not one of ours. */
function whichTake(clip, source) {
  const takes = clip?.takes || [];
  const n = takes.findIndex((t) => takeFile(t) === source);
  if (n < 0) return null;
  const t = takes[n];
  return { n: n + 1, of: takes.length, file: takeFile(t), seed: takeSeed(t), at: takeAt(t) };
}

/* Sentences, not deltas. An agent has to be able to SAY what happened, and
 * "-0.4s from the cut" is a number a human still has to interpret. */
const mag = (n) => `${round3(Math.abs(n))}s`;
const ord = (n) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`; };

/**
 * Read the Studio project a workflow produced and diff it against the cut the
 * workflow would compose today.
 */
export async function readTimeline(slug, { project } = {}) {
  const doc = await readProject(slug);
  if (!doc) throw new Error(`No such project: ${slug}`);
  if (doc.kind === "audiobook") throw new Error("Audiobook projects have no video timeline.");

  const found = await findTimelineDoc(slug, doc, project);
  const studio = found.doc;
  const fps = Number(studio?.out?.fps) || null;
  const frames = (d) => (fps ? Math.round(d * fps) : null);

  const expected = expectedItems(doc);
  const byId = new Map(expected.map((e) => [e.mvClipId, e]));

  /* Every item on every VIDEO track, in play order. Studio allows more than one
   * video track and a human stacking an overlay is a legitimate cut, so the
   * track is recorded per item rather than assumed to be track 1. */
  const raw = [];
  const audio = [];
  for (const tr of studio.tracks || []) {
    for (const it of tr.items || []) {
      const row = { track: { id: tr.id, name: tr.name, kind: tr.kind }, it };
      (tr.kind === "audio" ? audio : raw).push(row);
    }
  }
  raw.sort((a, b) => (a.it.start ?? 0) - (b.it.start ?? 0));

  /* A Split spreads the whole item (`...it` in studio.js), so both halves carry
   * the SAME mvClipId. More than one item per clip is therefore a split, not a
   * bug, and the group — not the item — is what compares against one scene. */
  const groups = new Map();
  for (const r of raw) {
    const id = r.it.mvClipId;
    if (!id || !byId.has(id)) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(r);
  }

  // Order is a property of the SHARED items only: an item the workflow never
  // made cannot push a scene "out of order", it was never in the order.
  const timelineOrder = [...groups.entries()]
    .sort((a, b) => (a[1][0].it.start ?? 0) - (b[1][0].it.start ?? 0))
    .map(([id]) => id);
  const expectedOrder = expected.filter((e) => groups.has(e.mvClipId)).map((e) => e.mvClipId);

  const edl = [];
  const notes = [];
  const tally = { moved: 0, trimmed: 0, "in-point": 0, reordered: 0, replaced: 0, relinked: 0, split: 0, foreign: 0, removed: 0 };

  for (const r of raw) {
    const it = r.it;
    const src = sourceOf(it.src);
    const exp = it.mvClipId ? byId.get(it.mvClipId) : null;
    const clip = it.mvClipId ? doc.clips.find((c) => c.id === it.mvClipId) : null;
    const group = exp ? groups.get(it.mvClipId) : null;
    const changes = [];

    const entry = {
      itemId: it.id ?? null,
      track: r.track,
      name: it.name ?? null,
      mvClipId: it.mvClipId ?? null,
      sceneIndex: exp ? exp.sceneIndex : null,
      source: src.name,
      sourceKind: src.kind,
      start: round3(it.start),
      dur: round3(it.dur),
      end: round3((it.start ?? 0) + (it.dur ?? 0)),
      inPoint: round3(it.inPoint),
      srcDur: it.srcDur ?? null,
      take: clip ? whichTake(clip, src.name) : null,
      status: "unchanged",
      changes,
    };

    if (!exp) {
      /* Either no linkage at all, or a clip the workflow no longer knows —
       * a deleted-and-rebuilt segment leaves items pointing at a dead id. */
      entry.status = "foreign";
      changes.push({ kind: "foreign", note: it.mvClipId ? `mvClipId ${it.mvClipId} is not a clip in this workflow` : "no workflow linkage — a human put this here" });
      tally.foreign++;
      notes.push(`an item the workflow never made: "${it.name ?? src.name}" at ${round3(it.start)}s for ${round3(it.dur)}s`);
      edl.push(entry);
      continue;
    }

    entry.expected = { start: exp.start, dur: exp.dur, inPoint: exp.inPoint, source: exp.source };

    const part = group.indexOf(r) + 1;
    if (group.length > 1) {
      entry.part = { n: part, of: group.length };
      changes.push({ kind: "split", note: `part ${part} of ${group.length}` });
      if (part === 1) { tally.split++; notes.push(`${exp.name} was split into ${group.length} parts`); }
    }

    // The group's extent is what stands in for the scene; a split's halves are
    // each "trimmed" only in the sense that together they still cover the scene.
    const gStart = Math.min(...group.map((x) => x.it.start ?? 0));
    const gEnd = Math.max(...group.map((x) => (x.it.start ?? 0) + (x.it.dur ?? 0)));

    if (part === 1) {
      const dStart = round3(gStart - exp.start);
      if (Math.abs(dStart) > EPS) {
        changes.push({ kind: "moved", from: exp.start, to: round3(gStart), deltaSec: dStart, deltaFrames: frames(dStart) });
        tally.moved++;
        notes.push(`${exp.name} starts ${mag(dStart)} ${dStart < 0 ? "earlier" : "later"} than the cut (${round3(exp.start)}s → ${round3(gStart)}s)`);
      }
      const dDur = round3((gEnd - gStart) - exp.dur);
      if (Math.abs(dDur) > EPS) {
        changes.push({ kind: "trimmed", from: exp.dur, to: round3(gEnd - gStart), deltaSec: dDur, deltaFrames: frames(dDur) });
        tally.trimmed++;
        notes.push(`${exp.name} is ${mag(dDur)} ${dDur < 0 ? "tighter" : "longer"} than its scene (${round3(exp.dur)}s → ${round3(gEnd - gStart)}s)`);
      }
      const from = expectedOrder.indexOf(exp.mvClipId), to = timelineOrder.indexOf(exp.mvClipId);
      if (from !== to && from >= 0 && to >= 0) {
        changes.push({ kind: "reordered", from: from + 1, to: to + 1 });
        tally.reordered++;
        notes.push(`${exp.name} now plays ${ord(to + 1)} of ${timelineOrder.length}, not ${ord(from + 1)}`);
      }
    }

    if (group.length === 1 && Math.abs(round3(it.inPoint) - exp.inPoint) > EPS) {
      changes.push({ kind: "in-point", from: exp.inPoint, to: round3(it.inPoint), deltaSec: round3(round3(it.inPoint) - exp.inPoint) });
      tally["in-point"]++;
      notes.push(`${exp.name} starts ${round3(it.inPoint)}s into its clip instead of at the head`);
    }

    if (src.name !== exp.source) {
      const now = whichTake(clip, exp.source);
      if (entry.take) {
        changes.push({ kind: "replaced", from: exp.source, to: src.name, take: entry.take.n, of: entry.take.of, workflowTake: now?.n ?? null, seed: entry.take.seed });
        tally.replaced++;
        notes.push(`${exp.name} uses take ${entry.take.n} of ${entry.take.of}${entry.take.seed != null ? ` (seed ${entry.take.seed})` : ""} — the workflow now picks take ${now?.n ?? "?"}`);
      } else {
        changes.push({ kind: "relinked", from: exp.source, to: src.name, note: "not a take of this clip" });
        tally.relinked++;
        notes.push(`${exp.name} points at ${src.name}, which is not a take of this clip`);
      }
    }

    entry.status = changes.length ? "changed" : "unchanged";
    edl.push(entry);
  }

  /* Expected but absent: the human cut the scene out of the video. */
  const missing = [];
  for (const e of expected) {
    if (groups.has(e.mvClipId)) continue;
    missing.push({ mvClipId: e.mvClipId, sceneIndex: e.sceneIndex, name: e.name,
                   source: e.source, expectedStart: e.start, expectedDur: e.dur,
                   change: "removed", note: "the workflow would place this scene; the timeline does not have it" });
    tally.removed++;
    notes.push(`${e.name} was cut from the timeline`);
  }

  /* The song. Compared only on what the workflow actually knows — its own file
   * and a start of 0. buildTimeline falls back to the library's duration when
   * totalDurationSec is 0, and the library handle is not available to a reader,
   * so an unknown length reports as unknown instead of as drift. */
  const audioOut = audio.map((r) => {
    const src = sourceOf(r.it.src);
    const changes = [];
    if (doc.song?.file && src.kind === "audio" && src.name !== doc.song.file) {
      changes.push({ kind: "relinked", from: doc.song.file, to: src.name });
    }
    if (Math.abs(round3(r.it.start)) > EPS) changes.push({ kind: "moved", from: 0, to: round3(r.it.start) });
    if (doc.totalDurationSec > 0 && Math.abs(round3(r.it.dur) - round3(doc.totalDurationSec)) > EPS) {
      changes.push({ kind: "trimmed", from: round3(doc.totalDurationSec), to: round3(r.it.dur),
                     deltaSec: round3(round3(r.it.dur) - round3(doc.totalDurationSec)) });
    }
    return { itemId: r.it.id ?? null, track: { id: r.track.id, name: r.track.name },
             name: r.it.name ?? null, source: src.name, start: round3(r.it.start),
             dur: round3(r.it.dur), inPoint: round3(r.it.inPoint), changes };
  });

  const changed = edl.filter((e) => e.status === "changed").length;
  return {
    slug,
    project: studio.name ?? found.file.replace(/\.json$/, ""),
    file: found.file,
    matchedBy: found.matchedBy,
    // A cut saved under a new name still resolves through the back-pointer, but
    // the workflow's own record of "where my cut lives" is then out of date.
    recordedAs: doc.timelineProject ?? null,
    linked: (studio.mvProjectId ?? null) === slug,
    savedAt: studio.savedAt ?? found.mtimeMs,
    savedAtIso: new Date(studio.savedAt ?? found.mtimeMs).toISOString(),
    fps, epsilonSec: EPS,
    inSync: changed === 0 && !tally.removed && !tally.foreign,
    summary: {
      items: edl.length, scenesExpected: expected.length,
      matched: groups.size, unchanged: edl.length - changed - tally.foreign,
      changed, ...tally,
    },
    edl, missing, audio: audioOut,
    notes,
  };
}
