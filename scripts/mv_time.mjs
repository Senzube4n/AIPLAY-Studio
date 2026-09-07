/**
 * How long a music video actually takes to make.
 *
 * WHY THIS EXISTS. "Record the time for these flows" has sat at [~] in
 * OBJECTIVE.md since the beginning, and it could not honestly be closed,
 * because nothing recorded a duration. `runs[]` carries a timestamp per tool
 * call and clips carry `durationSeconds` — which is how long the clip PLAYS,
 * not how long it took to make. The only way to answer the question was to
 * subtract adjacent run timestamps, which counts every gap between renders
 * (a night of nobody being at the keyboard) as render time.
 *
 * generate.js now writes `ms` onto every take at the call site. This adds them
 * up.
 *
 * ⚠ TWO DIFFERENT NUMBERS, AND THEY ARE NOT INTERCHANGEABLE.
 *
 *   MEASURED  the sum of recorded render times — GPU actually spent. This is
 *             the number that predicts what a rerun costs.
 *   WALL      first run timestamp to last. Includes thinking, reviewing,
 *             re-authoring, sleeping, and every failed attempt that was thrown
 *             away. Always much larger, and it is the number that answers "when
 *             will it be finished".
 *
 * Takes with no `ms` predate the recording and are counted as UNKNOWN rather
 * than as zero — a project that reports "0s of render" because nothing was
 * measured would be a lie in the most flattering direction.
 */
const BASE = process.env.AIPLAY_URL || "http://127.0.0.1:4173";

const get = async (p) => {
  try {
    const r = await fetch(BASE + p);
    return r.ok ? await r.json() : null;
  } catch { return null; }
};

const hms = (ms) => {
  if (ms == null) return "        —";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`.padStart(9);
  /* ⚠ ROUND THE MINUTES FIRST, THEN SPLIT. Rounding the remainder produced
   * "1h 60m" and "11h 60m" on the real data — 59.7 minutes rounds to 60 and
   * the hour was already taken. Anyone reading a report that says 60m stops
   * trusting the rest of it. */
  const mins = Math.round(s / 60);
  const h = Math.floor(mins / 60), m = mins % 60;
  return (h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`).padStart(9);
};

/* Every take that carries a time, by stage. A stage with takes but no recorded
 * ms reports its COUNT so the gap is visible rather than silently absent. */
function tally(rows) {
  let ms = 0, known = 0, unknown = 0;
  for (const r of rows || []) {
    for (const t of r.takes || []) {
      if (Number.isFinite(t.ms)) { ms += t.ms; known++; } else unknown++;
    }
    if (Number.isFinite(r.beatMs)) ms += r.beatMs;
  }
  return { ms, known, unknown };
}

(async () => {
  const projs = (await get("/api/mv/projects"))?.projects || [];
  const mv = projs.filter((p) => p.kind === "mv");
  const docs = [];
  for (const p of mv) {
    const d = await get(`/api/mv/project/${encodeURIComponent(p.slug)}`);
    if (d?.project) docs.push(d.project);
  }

  const rows = [];
  for (const d of docs) {
    const cast = tally(d.characters), bg = tally(d.backgrounds),
          prop = tally(d.props), board = tally(d.boards), clip = tally(d.clips);
    const parts = [cast, bg, prop, board, clip];
    const measured = parts.reduce((n, x) => n + x.ms, 0);
    const known = parts.reduce((n, x) => n + x.known, 0);
    const unknown = parts.reduce((n, x) => n + x.unknown, 0);

    /* WALL spans whole nights of nobody being there — The Long Ascent reads 38
     * hours because its first and last tool calls are two days apart, which
     * answers no useful question. ACTIVE sums only the gaps SHORT enough to be
     * one continuous sitting: anything over 15 minutes is treated as the
     * session having stopped, not as a very slow render. It is a heuristic and
     * it is labelled as one, but it is the closest thing here to "how long was
     * somebody actually making this". */
    const ats = (d.runs || []).map((r) => r.at).filter(Boolean).sort((a, b) => a - b);
    const wall = ats.length >= 2 ? ats[ats.length - 1] - ats[0] : null;
    const GAP = 15 * 60e3;
    let active = null;
    if (ats.length >= 2) {
      active = 0;
      for (let i = 1; i < ats.length; i++) {
        const d2 = ats[i] - ats[i - 1];
        if (d2 <= GAP) active += d2;
      }
    }

    rows.push({
      title: d.title,
      scenes: (d.segments || []).filter((s) => s.mode === "generate").length,
      done: (d.clips || []).filter((c) => c.clipFile).length,
      songSec: d.totalDurationSec || 0,
      sheets: cast.ms + bg.ms + prop.ms,
      boards: board.ms,
      clips: clip.ms,
      measured: known ? measured : null,
      known, unknown, wall, active,
    });
  }
  rows.sort((a, b) => (b.measured ?? -1) - (a.measured ?? -1));

  const W = 24;
  console.log("\nHOW LONG EACH VIDEO TOOK\n");
  console.log("  " + "video".padEnd(W) + "scenes  song    sheets    boards     clips  MEASURED    ACTIVE      WALL");
  console.log("  " + "-".repeat(W + 70));
  let tm = 0, tw = 0, ta = 0, tsong = 0, anyKnown = false, anyUnknown = 0;
  for (const r of rows) {
    console.log("  " + r.title.slice(0, W - 1).padEnd(W)
      + String(`${r.done}/${r.scenes}`).padStart(6)
      + String(`${Math.round(r.songSec)}s`).padStart(6)
      + hms(r.sheets || null) + hms(r.boards || null) + hms(r.clips || null)
      + hms(r.measured) + hms(r.active) + hms(r.wall)
      + (r.unknown ? `  (${r.unknown} unrecorded)` : ""));
    if (r.measured != null) { tm += r.measured; anyKnown = true; }
    if (r.wall != null) tw += r.wall;
    if (r.active != null) ta += r.active;
    tsong += r.songSec;
    anyUnknown += r.unknown;
  }
  console.log("  " + "-".repeat(W + 70));
  console.log("  " + `ALL ${rows.length} VIDEOS`.padEnd(W)
    + "".padStart(6) + String(`${Math.round(tsong)}s`).padStart(6)
    + "".padStart(9) + "".padStart(9) + "".padStart(9)
    + hms(anyKnown ? tm : null) + hms(ta || null) + hms(tw || null));

  console.log("\n  MEASURED is GPU actually spent, summed from every recorded take.");
  console.log("  ACTIVE sums only run-to-run gaps under 15 minutes — roughly the time");
  console.log("  somebody was actually working, with the overnight pauses removed.");
  console.log("  WALL is simply first tool call to last, so it counts whole nights.");
  console.log("  None of the three includes writing the song.");
  if (anyUnknown) {
    console.log(`\n  [!] ${anyUnknown} takes carry no recorded time — they predate the`);
    console.log("      recording added with this script. They are counted as unknown");
    console.log("      rather than as zero, so MEASURED for those videos is a floor.");
  }
  console.log();
})();
