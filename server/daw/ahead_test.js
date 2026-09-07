/**
 * THE LOOK-AHEAD, AND THE GESTURE — the two Tier-1 route halves, run.
 *
 * routes_test.js is structural: it proves the branches are wired and the
 * decisions are still implemented. This suite proves the ARITHMETIC and the
 * BEHAVIOUR, which are the two things a source pin cannot reach:
 *
 *   1. THE COST MODEL. A chained render is O(prefix), not O(window), because
 *      rack.chain_graph processes from absolute sample 0 every time. The line
 *      the plan estimates with is fitted from five measured region renders,
 *      and this checks the fit against its own evidence, the calibration
 *      against a machine that is deliberately twice as slow, and the two
 *      properties every verdict rests on: the estimate is monotone in prefix,
 *      and a region resolved from a moment in seconds is total and
 *      boundary-exact.
 *
 *   2. edit_notes, THROUGH THE REAL DISPATCHER into a scratch dir. Atomic (a
 *      bad entry at position 7 leaves all twelve notes as they were), ONE
 *      ledger row where twelve move_note calls are twelve, a dirty-region set
 *      equal to the union of the per-note sets, and an `undo` body that
 *      really does restore every previous value.
 *
 *   3. render_plan, likewise — it renders NOTHING, so it runs here with no
 *      python at all, which is exactly the property that makes it the call an
 *      agent can afford to make before every take.
 *
 * Nothing here needs the engine: no region is rendered, and the one job that
 * would be (the fast lane's ceiling refusal) is refused before python is
 * spawned, which is the point of enforcing the ceiling in the lane.
 *
 * Runs standalone (`node server/daw/ahead_test.js`) and in the pre-commit
 * hook. The temp dir is removed at the end; KEEP_AHEAD_TEST=1 keeps it.
 */
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";

/* The output dir MUST be decided before config.js is first imported, and
 * static imports hoist — so every import below is dynamic. */
const OUT = path.join(os.tmpdir(), `daw-ahead-test-${process.pid}-${Date.now().toString(36)}`);
process.env.AIPLAY_OUTPUT = OUT;

const routes = await import("./routes.js");
const store = await import("./store.js");
const {
  createDawRoutes, fitLine, median, calibrateCost, estimateRegionMs, rawRegionMs,
  regionAt, aheadRun, regionVerdict,
  CHAIN_FIT, SPEC_REGION_COST, SPEC_MONO_MS_PER_BAR, CAL_SLOPE_BAND,
} = routes;

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/* ═════════════ 1. THE FIT, AGAINST THE MEASUREMENTS IT IS OF ═════════════ */

console.log("\n  -- the line is a fit of the table, and the table is in the file --");
{
  ok("fitLine recovers an exact line exactly",
    (() => { const f = fitLine([[0, 10], [1, 20], [2, 30], [3, 40]]);
             return near(f.a, 10, 1e-9) && near(f.b, 10, 1e-9); })());
  ok("fitLine on one point is flat rather than undefined (no division by zero)",
    (() => { const f = fitLine([[5, 100]]); return f.b === 0 && near(f.a, 100); })());
  ok("median takes the middle of odd lengths and the mean of the middle two of even",
    median([3, 1, 2]) === 2 && median([1, 2, 3, 4]) === 2.5 && median([]) === 0);

  /* The residuals, printed: the fit is a line through five points that are
   * not exactly on a line (the note count grows with position too), so its
   * error is a real number and it belongs in the record rather than in a
   * claim of exactness. */
  const resid = SPEC_REGION_COST.map(([x, y]) => Math.round(rawRegionMs(true, { t0: x }) - y));
  const worst = Math.max(...resid.map(Math.abs));
  console.log(`        residuals (ms): ${resid.join(", ")} — worst ${worst}`);
  ok(`the fitted line is within 500 ms of every measured region render (worst ${worst})`, worst <= 500);
  ok("the fit is the one the file exports (a + b·prefix, both positive)",
    CHAIN_FIT.a > 0 && CHAIN_FIT.b > 0);
  ok(`b is about 46.5 ms per prefix-second — the O(prefix) slope itself (${CHAIN_FIT.b.toFixed(2)})`,
    CHAIN_FIT.b > 40 && CHAIN_FIT.b < 55);
  ok(`the mono path is ${SPEC_MONO_MS_PER_BAR} ms/bar and does not read prefix at all`,
    rawRegionMs(false, { t0: 0, fromBar: 1, toBar: 4 })
      === rawRegionMs(false, { t0: 999, fromBar: 1, toBar: 4 }));

  /* MONOTONE IN PREFIX. The badge's whole meaning depends on it: a model
   * that said a later region was cheaper would put "ready" in front of the
   * drop. */
  let mono = true;
  for (let t = 0; t < 400; t += 7.5) {
    if (rawRegionMs(true, { t0: t + 7.5 }) <= rawRegionMs(true, { t0: t })) mono = false;
  }
  ok("the chained estimate is strictly increasing in prefix, over a whole 400 s song", mono);
}

console.log("\n  -- the verdict, and where it turns --");
{
  const region = 7500;         // ms of audio in a 4-bar region at 128 BPM
  ok("a cached region is ready whatever it would have cost",
    regionVerdict(99_999, region, true) === "ready");
  ok("over the audio it covers is LATE", regionVerdict(region + 1, region, false) === "late");
  ok("...and exactly equal is not late (the boundary belongs to the side that makes it)",
    regionVerdict(region, region, false) === "tight");
  ok("inside 80 % is ready, past 80 % is tight",
    regionVerdict(region * 0.79, region, false) === "ready"
    && regionVerdict(region * 0.81, region, false) === "tight");

  /* The crossover, computed from the shipped line: where a chained 4-bar
   * region stops fitting inside its own 7.5 s. The measured table says bars
   * 61-64 (prefix 112.5) held at 6 219 ms and bars 85-88 (prefix 157.5)
   * missed at 8 498 — so the crossover must land between them. */
  const cross = (region - CHAIN_FIT.a) / CHAIN_FIT.b;
  console.log(`        the model crosses 7 500 ms at prefix ${cross.toFixed(1)} s (bar ~${Math.round(cross / 1.875) + 1})`);
  ok(`the crossover falls between the region that held and the region that missed (112.5 < ${cross.toFixed(1)} < 157.5)`,
    cross > 112.5 && cross < 157.5);
}

console.log("\n  -- this machine's own line: the calibration, and the run that reshaped it --");
{
  const chained = (rows) => calibrateCost(rows, true);
  ok("nothing is calibrated from nothing, and the shipped line stands",
    chained([]).calibrated === false && chained([]).b === CHAIN_FIT.b);
  ok("...nor from two observations, nor from three taken too close together",
    chained([{ t0: 0, ms: 100, chained: true }, { t0: 30, ms: 500, chained: true }]).calibrated === false
    && chained([{ t0: 0, ms: 100, chained: true }, { t0: 3, ms: 110, chained: true },
                { t0: 6, ms: 120, chained: true }]).calibrated === false);

  /* A machine exactly twice as slow as the shipped line. */
  const twice = SPEC_REGION_COST.map(([t0]) =>
    ({ t0, bars: 4, ms: rawRegionMs(true, { t0 }) * 2, chained: true }));
  const cal = chained(twice);
  ok("a machine twice as slow refits to twice the line, both parameters",
    cal.calibrated && cal.method === "fit"
    && near(cal.b, CHAIN_FIT.b * 2, 1e-6) && near(cal.a, CHAIN_FIT.a * 2, 1e-6));
  ok("mono observations are never mixed into the chained fit, or the other way",
    calibrateCost([...twice, { t0: 0, bars: 4, ms: 1, chained: false }], false).samples === 1);

  /* THE RUN THAT REWROTE THIS. Six real region renders of the reference
   * project, bars 1-24 on this machine, measured through the route. The
   * scalar calibration these produced was 0.573 and it turned a project with
   * twelve late regions into a project with none. The refit keeps the slope,
   * which is the part that decides bar 125. */
  const REAL = [[0, 238.1], [7.5, 466.2], [15, 753.6], [22.5, 1079.6], [30, 1483.2], [37.5, 2044]];
  const real = REAL.map(([t0, ms]) => ({ t0, bars: 4, ms, chained: true }));
  const rc = chained(real);
  console.log(`        six real early renders refit to ${rc.a.toFixed(0)} + ${rc.b.toFixed(2)}·prefix `
    + `(shipped: ${CHAIN_FIT.a.toFixed(0)} + ${CHAIN_FIT.b.toFixed(2)})`);
  ok(`the refit recovers the SLOPE from six early regions (${rc.b.toFixed(2)} against the shipped ${CHAIN_FIT.b.toFixed(2)})`,
    Math.abs(rc.b - CHAIN_FIT.b) < 5);
  ok("...and extrapolates to within a second of the measured late region (11 068 ms at prefix 232.5)",
    Math.abs(estimateRegionMs(rc, true, { t0: 232.5 }) - 11068) < 1000,
    `${estimateRegionMs(rc, true, { t0: 232.5 })} ms`);
  ok("...so the late regions STAY late after calibration — the whole point of the badge",
    estimateRegionMs(rc, true, { t0: 232.5 }) > 7500
    && estimateRegionMs(rc, true, { t0: 157.5 }) > 7500);
  const scalar = median(real.map((o) => o.ms / rawRegionMs(true, { t0: o.t0 })));
  ok(`...where the one-scalar calibration these same six produce (${scalar.toFixed(3)}) would have called bar 125 ready`,
    scalar * rawRegionMs(true, { t0: 232.5 }) < 7500);

  ok("a slope no evidence could justify is clamped into a band around the measured one",
    chained([{ t0: 0, ms: 1, chained: true }, { t0: 100, ms: 1e7, chained: true },
             { t0: 200, ms: 2e7, chained: true }]).b === CHAIN_FIT.b * CAL_SLOPE_BAND[1]
    && chained([{ t0: 0, ms: 100, chained: true }, { t0: 100, ms: 100, chained: true },
                { t0: 200, ms: 100, chained: true }]).b === CHAIN_FIT.b * CAL_SLOPE_BAND[0]);
  ok("...so a fit can never invert: the estimate is still increasing in prefix afterwards",
    (() => { const c = chained([{ t0: 0, ms: 9000, chained: true }, { t0: 100, ms: 500, chained: true },
                                { t0: 200, ms: 10, chained: true }]);
             return estimateRegionMs(c, true, { t0: 200 }) > estimateRegionMs(c, true, { t0: 0 }); })());
  ok("the intercept is never negative (a region cannot cost less than nothing)",
    chained([{ t0: 100, ms: 10, chained: true }, { t0: 150, ms: 5000, chained: true },
             { t0: 200, ms: 9000, chained: true }]).a >= 0);
}

console.log("\n  -- a moment in seconds resolves to exactly one region, always --");
{
  const rows = [
    { idx: 0, t0: 0, t1: 7.5, cached: true }, { idx: 1, t0: 7.5, t1: 15, cached: true },
    { idx: 2, t0: 15, t1: 22.5, cached: false }, { idx: 3, t0: 22.5, t1: 30, cached: true },
  ];
  ok("a time inside a region gives that region", regionAt(rows, 8).idx === 1);
  ok("a time exactly ON a seam gives the LATER region ([t0, t1) is how the files abut)",
    regionAt(rows, 7.5).idx === 1 && regionAt(rows, 15).idx === 2 && regionAt(rows, 22.5).idx === 3);
  ok("before the song and after it both resolve (the function is total)",
    regionAt(rows, -5).idx === 0 && regionAt(rows, 1e6).idx === 3 && regionAt([], 3) === null);
  ok("the ahead run counts the CONTIGUOUS cached regions from the playhead, and stops at the gap",
    sameSet(aheadRun(rows, 0), [0, 1]) && sameSet(aheadRun(rows, 16), []) );
  ok("...and a region rendered in this very call counts as being there",
    sameSet(aheadRun(rows, 8, 2), [1, 2, 3]));
}

/* ═════════════════ 2. THROUGH THE REAL ROUTE, INTO A TEMP DIR ════════════ */

console.log("\n  -- THE RUN: through the real dispatcher, into a scratch dir --");
ok(`the store writes under the scratch dir (${OUT})`, store.DAW_DIR().startsWith(OUT));

if (!store.DAW_DIR().startsWith(OUT)) {
  console.log("  refusing to run the disk half anywhere but the scratch dir");
} else {
  const json = (res, code, body) => { res.writeHead(code, {}); res.end(JSON.stringify(body)); };
  const readBody = async (req) => req.body;
  /* A python that must never be reached: every call below either renders
   * nothing, or is refused before a child could be spawned. */
  const spawnPython = () => { throw new Error("ahead_test spawned python — it must not"); };
  const handle = createDawRoutes({
    json, readBody, spawnPython, config: { outputDir: OUT, python: "python" },
  });
  async function call(method, pathname, body) {
    const cap = { code: 0, out: "" };
    const res = {
      writeHead(c) { cap.code = c; return res; }, setHeader() { return res; },
      write(s) { cap.out += s; return true; }, end(s) { if (s != null) cap.out += s; },
    };
    const handled = await handle({ method, body, headers: {} }, res, new URL(`http://daw.test${pathname}`));
    if (!handled) throw new Error(`unhandled ${method} ${pathname}`);
    return { code: cap.code, body: JSON.parse(cap.out) };
  }
  const post = async (body) => {
    const r = await call("POST", "/api/daw", body);
    if (r.body.error) throw new Error(r.body.error);
    return r.body;
  };
  const refuse = async (body) => {
    const r = await call("POST", "/api/daw", body);
    if (!r.body.error) throw new Error(`expected a refusal, got ${JSON.stringify(r.body).slice(0, 120)}`);
    return r.body.error;
  };
  const docOf = async (slug) => (await call("GET", `/api/daw/project/${encodeURIComponent(slug)}`)).body.project;

  try {
    /* ── a project with twelve notes spread over four regions ──────────── */
    const made = await post({ action: "create", name: "ahead run", bpm: 120, length_bars: 16, by: "user" });
    const slug = made.slug;
    const tr = await post({ action: "add_track", slug, name: "lead", instrument: "bigroom_lead",
                            with_clip: false, by: "user" });
    const trackId = tr.trackId ?? tr.track?.id;
    await post({ action: "add_clip", slug, track: trackId, from_bar: 1, bars: 16, name: "all", by: "user" });
    const rec = await post({
      action: "record_notes", slug, track: trackId, by: "user",
      notes: Array.from({ length: 12 }, (_, i) => ({
        bar: 1 + i, beat: 1, tick: 0, dur_ticks: 480, pitch: 60 + i, vel: 40 + i,
      })),
    });
    const ids = rec.added.map((n) => n.id);
    ok("twelve notes are in, one per bar", ids.length === 12);

    const before = await docOf(slug);
    const velOf = (d) => Object.fromEntries(
      d.tracks[0].clips.flatMap((c) => c.notes.map((n) => [n.id, n.vel])));
    const vel0 = velOf(before);
    const ledger0 = before.ledger.length;

    /* ── ATOMIC: a bad entry at position 7 leaves all twelve alone ─────── */
    const edits = ids.map((id, i) => ({ note: id, vel: 100 + i }));
    const bad = [...edits];
    bad[7] = { note: ids[7], vel: 999 };            // outside 1..127
    const err = await refuse({ action: "edit_notes", slug, track: trackId, notes: bad, by: "user" });
    ok("a bad entry is refused and the message names its INDEX", /note 7/.test(err), err);
    const afterBad = await docOf(slug);
    ok("...and nothing was written: all twelve notes keep the velocities they had",
      JSON.stringify(velOf(afterBad)) === JSON.stringify(vel0));
    ok("...and no ledger row was added either", afterBad.ledger.length === ledger0);

    ok("the same note twice in one call is refused (the undo would be wrong)",
      /appears twice/.test(await refuse({ action: "edit_notes", slug, track: trackId, by: "user",
        notes: [{ note: ids[0], vel: 70 }, { note: ids[0], vel: 71 }] })));
    ok("an entry that changes nothing is refused, and says what would count",
      /names no change/.test(await refuse({ action: "edit_notes", slug, track: trackId, by: "user",
        notes: [{ note: ids[0] }] })));
    ok("the cap is 2000 and the refusal says so",
      /2000/.test(await refuse({ action: "edit_notes", slug, track: trackId, by: "user",
        notes: Array.from({ length: 2001 }, () => ({ note: ids[0], vel: 64 })) })));
    ok("a note id the track does not hold is refused by index, not silently skipped",
      /note 1/.test(await refuse({ action: "edit_notes", slug, track: trackId, by: "user",
        notes: [{ note: ids[0], vel: 64 }, { note: "nt_nope", vel: 64 }] })));

    /* ── ONE write, ONE ledger row, and an undo that really undoes ─────── */
    const once = await post({ action: "edit_notes", slug, track: trackId, notes: edits, by: "user" });
    const afterOnce = await docOf(slug);
    ok("twelve velocity edits land in ONE call", once.edited.length === 12);
    ok("...and are exactly what was asked for",
      ids.every((id, i) => velOf(afterOnce)[id] === 100 + i));
    ok("...as ONE ledger row, naming the count and the field it changed",
      afterOnce.ledger.length === ledger0 + 1
      && /12 note\(s\)/.test(afterOnce.ledger[0].detail) && /vel/.test(afterOnce.ledger[0].detail),
      afterOnce.ledger[0]?.detail);
    ok("...by ONE author stamp, with the action named edit_notes",
      afterOnce.ledger[0].action === "edit_notes" && afterOnce.ledger[0].by === "user");
    const idxOf = (rows) => rows.map((d) => d.idx);
    const dirtyOnce = idxOf(once.dirty);
    ok(`the twelve edits dirtied ${dirtyOnce.length} regions`, dirtyOnce.length >= 3);

    /* the undo body, posted straight back */
    const undone = await post({ ...once.undo, by: "user" });
    ok("the returned undo is a body you can post back, and it restores every value",
      JSON.stringify(velOf(await docOf(slug))) === JSON.stringify(vel0), JSON.stringify(undone.edited));
    ok("...and dirties exactly the regions the gesture did", sameSet(idxOf(undone.dirty), dirtyOnce));

    /* ── the dirty set is the union of the per-note sets ───────────────── */
    const union = new Set();
    for (const e of edits) {
      const r = await post({ action: "move_note", slug, track: trackId, note: e.note, vel: e.vel, by: "user" });
      for (const d of r.dirty) union.add(d.idx);
    }
    ok("edit_notes' dirty set equals the union of the twelve one-at-a-time sets",
      sameSet(dirtyOnce, [...union]), `${dirtyOnce.join()} vs ${[...union].join()}`);
    const afterN = await docOf(slug);
    ok("...and twelve separate calls cost twelve ledger rows where the gesture cost one",
      afterN.ledger.length === ledger0 + 2 + 12);

    /* ── render_plan: renders nothing, and says so per region ──────────── */

    /* A NEW project ships with the master's stereo switch ON, which is
     * already a non-default mixer — so the chained model, and the O(prefix)
     * cost, is the ordinary case and not the exotic one. The mono path is
     * what a project gets by turning that switch off. Both are planned. */
    ok("a brand-new project is already on the chained path (the master ships stereo on)",
      (await post({ action: "render_plan", slug, by: "user" })).chained === true);
    await post({ action: "mixer_set", slug, target: "master", stereo: false, by: "user" });
    const planMono = await post({ action: "render_plan", slug, by: "user" });
    ok("with the master's stereo off it is the default mixer: four regions, every one ready",
      planMono.regions.length === 4 && planMono.counts.ready === 4
      && planMono.counts.late === 0 && planMono.chained === false,
      JSON.stringify(planMono.counts) + ` chained=${planMono.chained}`);
    ok("...and its model says out loud that the mono path is flat in position",
      /flat in position/i.test(planMono.model.why) && planMono.model.kind === "mono");
    ok("...with nothing calibrated yet, because nothing has rendered here",
      planMono.calibration.calibrated === false && planMono.calibration.samples === 0);
    ok("every region's deadline is the audio it covers (8 000 ms for 4 bars at 120 BPM)",
      planMono.regions.every((r) => r.deadlineMs === 8000));

    /* one insert makes the mixer non-default, and the model changes with it */
    await post({ action: "insert_add", slug, target: trackId, type: "eq",
                 params: { hp_on: true, hp_hz: 150 }, by: "user" });
    const planChain = await post({ action: "render_plan", slug, by: "user" });
    ok("one insert puts the project on the chained model", planChain.chained === true
      && planChain.model.kind === "chained");
    ok("...and the chained estimates rise with position while the mono ones did not",
      planChain.regions[3].estimatedMs > planChain.regions[0].estimatedMs
      && planMono.regions[3].estimatedMs === planMono.regions[0].estimatedMs);
    ok("...and 16 bars is short enough that even chained it is all ready (the honesty cuts both ways)",
      planChain.counts.late === 0 && planChain.firstLate === null);
    ok("from_seconds drops the regions already behind the playhead",
      (await post({ action: "render_plan", slug, from_seconds: 20, by: "user" })).regions.length === 2);

    /* ── a long chained project is where the badge earns its keep ──────── */
    const big = await post({ action: "create", name: "long chained", bpm: 128, length_bars: 128, by: "user" });
    const bigTr = await post({ action: "add_track", slug: big.slug, name: "lead", instrument: "bigroom_lead", by: "user" });
    await post({ action: "insert_add", slug: big.slug, target: bigTr.trackId ?? bigTr.track?.id,
                 type: "eq", params: { hp_on: true, hp_hz: 150 }, by: "user" });
    const planBig = await post({ action: "render_plan", slug: big.slug, by: "user" });
    ok("a 128-bar chained project plans 32 regions", planBig.regions.length === 32);
    ok("...and it is NOT all ready: the plan names the first region that will arrive late",
      planBig.counts.late > 0 && planBig.firstLate !== null, JSON.stringify(planBig.counts));
    console.log(`        first late: bars ${planBig.firstLate.bars} — `
      + `${planBig.firstLate.estimatedMs} ms for ${planBig.firstLate.deadlineMs} ms of audio`);
    ok("...the first late region is in the second half of the song, as the measurements say",
      planBig.firstLate.idx >= 15 && planBig.firstLate.idx <= 24, `idx ${planBig.firstLate.idx}`);
    ok("...the verdicts are monotone: once late, never ready again",
      (() => { let seen = false;
               for (const r of planBig.regions) { if (r.verdict === "late") seen = true;
                 else if (seen) return false; } return true; })());
    ok("...and the note explains the trade rather than blaming the machine",
      /Bounce, or simplify the chain/.test(planBig.note));

    /* ══ THE BADGE, RELATIVE — the page's own paintAhead, on this reply ═══
     *
     * The regression this section exists for: the badge used to scan EVERY
     * region and go red if any one of them was late, which on this very
     * project means red at bar 1 for the whole life of the file. `planBig`
     * above proves the song has late regions; what must be true is that the
     * WINDOW decides — bars 1-16 read ready, and a loop over the late bars
     * reads late. paintAhead is lifted out of web/daw.js by name and run
     * against a stub DOM, so what is asserted here is the sentence the
     * transport bar shows rather than a re-implementation of it. */
    {
      const { readFileSync } = await import("node:fs");
      const { fileURLToPath } = await import("node:url");
      const HERE = path.dirname(fileURLToPath(import.meta.url));
      const JS = readFileSync(path.join(HERE, "..", "..", "web", "daw.js"), "utf8");
      const lift = (header) => {
        const i = JS.indexOf(header);
        if (i < 0) throw new Error(`web/daw.js no longer defines ${header}`);
        let depth = 0, started = false;
        for (let j = i; j < JS.length; j++) {
          const c = JS[j];
          if (c === "{") { depth++; started = true; }
          else if (c === "}") { depth--; if (started && depth === 0) return JS.slice(i, j + 1); }
        }
        throw new Error(`unbalanced: ${header}`);
      };
      const AHEAD_REGIONS = Number(JS.match(/const AHEAD_REGIONS = (\d+);/)?.[1]);
      ok("web/daw.js judges a REGION-COUNT window, not the song (const AHEAD_REGIONS)",
        AHEAD_REGIONS >= 1 && AHEAD_REGIONS <= 16, `AHEAD_REGIONS = ${AHEAD_REGIONS}`);
      const src = ["function regionSecs()", "function aheadWindow()", "function windowRows(",
        "function planRegionAt(", "function aheadCount(", "function aheadAt(",
        "function beyondNote(", "function paintAhead()", "function paintBadge()"]
        .map(lift);
      src.unshift(`const AHEAD_REGIONS = ${AHEAD_REGIONS};`);

      const els = {};
      const $ = (id) => (els[id] ||= { textContent: "", title: "", classList: {
        set: new Set(), add(k) { this.set.add(k); }, remove(k) { this.set.delete(k); } } });
      const spb = (planBig.regions[0].t1 - planBig.regions[0].t0)
        / (planBig.regions[0].toBar - planBig.regions[0].fromBar + 1);
      const barSec = (barFloat) => (barFloat - 1) * spb;
      const St = { slug: big.slug, playing: false, loop: true, loopA: null, loopB: null,
        at: 0, totalSeconds: planBig.totalSeconds, regions: [], buffers: new Map(),
        ahead: { plan: null, at: null, busy: false, asking: false,
                 state: "idle", txt: "ahead —", why: "", painted: "" } };
      const page = new Function("S", "$", "loopSecs", "projTime", "refreshPlan",
        `${src.join("\n\n")}\nreturn { paintAhead, aheadWindow, windowRows, aheadAt };`)(
        St, $,
        () => (St.loopA == null ? { a: 0, b: St.totalSeconds }
                                : { a: barSec(St.loopA), b: barSec(St.loopB) }),
        () => St.at, () => {});

      /* THE CASE THAT USED TO LIE: bar 1 of a song with late regions in it */
      St.at = 0;
      let w = page.aheadWindow();
      let plan = await post({ action: "render_plan", slug: big.slug, by: "user",
                              from_seconds: w.from, lead_seconds: w.lead ?? undefined });
      ok("with no region length in hand the first ask is unbounded — and the PAGE still cuts it to the window",
        w.lead == null && plan.regions.length === planBig.regions.length
        && page.windowRows(plan.regions, w).length === AHEAD_REGIONS);
      St.ahead.plan = plan; St.ahead.at = w.from;
      page.paintAhead();
      ok(`bars 1-${AHEAD_REGIONS * 4} of a song with ${planBig.counts.late} late regions read READY — "${St.ahead.txt}"`,
        St.ahead.state === "ok" && /^ahead ✓/.test(St.ahead.txt), St.ahead.txt);
      ok("...and the tooltip names what it did NOT judge, and where the first late bars are",
        /Judged: the next \d+ regions from the playhead/.test(St.ahead.why)
        && St.ahead.why.includes(`${planBig.counts.late} of this project's ${planBig.regions.length} regions`)
        && St.ahead.why.includes(`bars ${planBig.firstLate.bars}`),
        St.ahead.why);

      /* the second ask IS bounded, because a region length is now in hand */
      w = page.aheadWindow();
      plan = await post({ action: "render_plan", slug: big.slug, by: "user",
                          from_seconds: w.from, lead_seconds: w.lead });
      ok(`lead_seconds bounds the ROUTE's answer to ${AHEAD_REGIONS} rows of ${plan.songRegions}`,
        plan.regions.length === AHEAD_REGIONS && plan.songRegions === planBig.regions.length
        && plan.counts.late === 0 && plan.songCounts.late === planBig.counts.late,
        `${plan.regions.length} rows, counts ${JSON.stringify(plan.counts)}`);
      ok("...and it hands back what it did not judge rather than hiding it",
        plan.beyondLateCount === planBig.counts.late
        && plan.beyondLate?.bars === planBig.firstLate.bars
        && /NOT in `counts`/.test(plan.windowNote));

      /* THE LOOP OVER THE LATE BARS. Same document, same route, red badge. */
      const lateRow = planBig.regions.find((r) => r.verdict === "late");
      St.loopA = lateRow.fromBar; St.loopB = lateRow.toBar + 1;
      St.at = barSec(lateRow.fromBar);
      w = page.aheadWindow();
      St.ahead.plan = await post({ action: "render_plan", slug: big.slug, by: "user",
                                   from_seconds: w.from, lead_seconds: w.lead });
      St.ahead.at = w.from;
      page.paintAhead();
      ok(`a loop over bars ${lateRow.fromBar}-${lateRow.toBar} turns the SAME project red — "${St.ahead.txt}"`,
        St.ahead.state === "late"
        && St.ahead.txt === `ahead ✗ bars ${lateRow.fromBar}-${lateRow.toBar} · will arrive late`,
        St.ahead.txt);
      ok("...and says the loop is what it judged, in the loop's own bars",
        /^Judged: the loop, bars /.test(St.ahead.why), St.ahead.why.split("\n")[0]);

      /* THE WRAP. In a loop the future is circular: the region to have ready
       * while the last bar plays is the loop's FIRST, not the one after it. */
      St.loopA = 1; St.loopB = 9;
      St.at = barSec(8.9);
      const seek = page.aheadAt(St.at, 3.0);
      ok("inside a loop the look-ahead seek WRAPS to the loop's start rather than running past its end",
        seek < St.at && seek >= 0 && seek < barSec(9),
        `${St.at.toFixed(2)} s + 3 s -> ${seek.toFixed(2)} s`);
      St.loop = false;
      ok("...and with looping off it is plain addition again",
        Math.abs(page.aheadAt(St.at, 3.0) - (St.at + 3.0)) < 1e-9);
    }

    /* ── the fast lane's ceiling, refused before python is ever spawned ── */
    const slow = await post({ action: "create", name: "slow", bpm: 20, length_bars: 4, by: "user" });
    const slowTr = await post({ action: "add_track", slug: slow.slug, name: "pad", instrument: "pad", by: "user" });
    const ceilErr = await refuse({ action: "preview_note", slug: slow.slug,
      track: slowTr.trackId ?? slowTr.track?.id, pitch: 60, dur_ticks: 960 * 8, by: "user" });
    ok("an audition longer than the fast lane's ceiling is refused, with the ceiling in the message",
      /fast serve lane renders at most 10 s of audio/.test(ceilErr) && /480000 samples at 48000 Hz/.test(ceilErr),
      ceilErr);
    ok("...and it names the way through rather than just saying no",
      /action:"render"/.test(ceilErr));
  } catch (err) {
    ok("the run completed", false, err.stack || err.message);
  }
}

if (!process.env.KEEP_AHEAD_TEST) await rm(OUT, { recursive: true, force: true }).catch(() => {});

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.log("  failed:\n   " + failures.join("\n   ") + "\n");
  process.exit(1);
}
