/**
 * THE PLAN OBJECT — set up · go through · approve or change · start.
 *
 * The owner's words this exists for, kept verbatim because paraphrasing them is
 * how a feature drifts away from the thing that was asked for:
 *
 *   "people value high quality more then speed but it still needs to be asking
 *    you directive choices when you do run through MCP and we should have it
 *    able to setup things for you and you can go through it approve it change
 *    things and then start."
 *
 * Four verbs. This module is those four verbs and nothing else.
 *
 * ── THE THREE RULES THIS FILE IS ─────────────────────────────────────────────
 *
 * 1. AN ITEM IS A REAL MCP TOOL CALL. `tool` is the name of a tool that already
 *    exists and `args` are that tool's own arguments; the runner resolves the
 *    name through the table `mvTools()` builds and calls `.run(args)`. There is
 *    no translation layer that could drift from the tool the card promises, so
 *    a plan cannot become a second execution path, cannot reach a capability an
 *    agent has not got, and cannot invent an argument the tool would refuse.
 *    That is server/daw/ear.js's invariant 1, applied here. A plan naming a
 *    tool that does not exist is refused AT PROPOSE TIME, which is free, rather
 *    than three hours in, which is not.
 *
 * 2. NOTHING DERIVABLE IS STORED. No minutes, no engine, no width, no height,
 *    no warnings. Every one of those is computed on read by planView() from the
 *    renderer's OWN functions — resolveShot() for the engine, renderSize() +
 *    videoSizeFor() for the size, crimeBoard() for the breaks,
 *    measuredMinutesPerClip() for the minutes. A minutes figure stamped at
 *    propose time is wrong the instant brief.qualityMode changes, and a stored
 *    engine is exactly the disagreement crimeBoard's "one builder" note was
 *    written about. stageOfDoc() is derived for the same reason and for as
 *    long.
 *
 * 3. AN APPROVAL IS OF A SPECIFIC SET OF ARGUMENTS. Editing an approved item
 *    drops it back to `edited` and it must be approved again. Carrying an
 *    approval across a change would make approval mean nothing, which is the
 *    laundering this whole object exists to prevent.
 *
 * PURE. No I/O, no clock the caller cannot supply, no network. Everything here
 * takes a document and returns a value or mutates the object it was handed;
 * persistence is the routes' job and execution is planrun.js's.
 */
import { randomUUID } from "node:crypto";
import { resolveShot, findSegment, ltxReadyNow } from "./shot.js";
import { renderSize, crimeBoard } from "./generate.js";
import { videoSizeFor } from "../workflow.js";
import { measuredMinutesPerClip, scanStale } from "./regen.js";
import {
  CLIP_TOOLS, FREE_TOOLS, FLAT_TOOLS, H3_NATIVE, H3_OOM, COST_SPREAD,
  CONTROL_TOOLS, controlMinutes,
  tableMinutes, flatMinutes, humanMinutes, stepClassOf, trapBand, loadedLoraSteps,
} from "./plancost.js";
import { clipStepsFor } from "./clipsteps.js";

export const PLAN_V = 1;

/** Newest first, bounded. A history is a breadcrumb trail, not an audit log —
 *  the provenance ledger is the audit log and it is append-only. */
export const PLAN_LIMIT = 10;

/** A plan in one of these is LIVE: it is the one the page paints and the one a
 *  second propose is refused against. */
export const LIVE_STATES = new Set(["proposed", "approved", "running", "paused"]);
export const PLAN_STATES = new Set([...LIVE_STATES, "done", "cancelled"]);
export const ITEM_STATES = new Set([
  "proposed", "edited", "approved", "skipped", "running", "done", "failed",
]);

/** The states a human decision may move an item to. Everything else is the
 *  runner's to write. */
export const DECIDABLE = new Set(["approved", "skipped", "proposed"]);

/** What `plan_run` accepts. */
export const RUN_OPS = new Set(["start", "pause", "resume", "stop"]);
export const ITEM_OPS = new Set(["add", "edit", "remove"]);

/** Batch.js's sentence, kept word for word so a person who has seen it once
 *  recognises it here. */
export const RESUME_NOTE = "Picked up where it stopped. Press resume to carry on.";

export const newPlanId = () => `p_${randomUUID().slice(0, 8)}`;

/* ────────────────────────────────────────────── the plannable whitelist */

/**
 * WHICH TOOLS A PLAN MAY NAME — DERIVED, NEVER TYPED TWICE.
 *
 * Handed the live tool names, it subtracts the two families a plan must not
 * contain and returns the rest. A hard-coded array of tool names would be a
 * second list to keep in step with mcp-mv.js, and the videolab rule this
 * codebase already runs on is data, not literals: the moment the two disagree,
 * the plan refuses a tool that exists or accepts one that does not.
 *
 *   mv_plan_*         a plan that plans is a loop with a ledger entry.
 *   *_create_project  a plan lives IN a project document; an item that made a
 *                     new one would be writing outside the thing being approved.
 */
export function plannableTools(toolNames) {
  return [...toolNames]
    .filter((n) => !/^(mv|ab)_plan_/.test(n) && !/_create_project$/.test(n))
    .sort();
}

/* ──────────────────────────────────────────────────────── shape and gates */

const str = (v) => (typeof v === "string" ? v.trim() : "");
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/**
 * One item, validated. `tool` is checked against the live whitelist here — at
 * propose time, where it costs nothing.
 */
export function makeItem(raw, { tools, id }) {
  const tool = str(raw?.tool);
  if (!tool) throw new Error("Every plan item needs a `tool` — the name of an MCP tool you can already call.");
  if (tools && !tools.includes(tool)) {
    throw new Error(
      `"${tool}" is not a tool a plan can run. An item is a REAL tool call, so the name has to be `
      + `one that exists. Legal names: ${tools.join(", ")}.`);
  }
  const args = raw?.args;
  if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) {
    throw new Error(`Item ${id}: \`args\` must be an object — the named arguments of ${tool}.`);
  }
  return {
    id,
    tool,
    args: clone(args) ?? {},
    /* THE PROPOSER'S OWN SENTENCE, never written for them. A why nobody wrote
     * is a why nobody read, and the card is the whole point. */
    why: str(raw?.why) || null,
    status: "proposed",
    edits: [],
    result: null,
    error: null,
    startedAt: null,
    finishedAt: null,
  };
}

/**
 * A new plan. `createdBy` comes from provenance.actorFrom(req) at the route and
 * is never assumed here — a plan that guessed who proposed it would be the
 * first lie in an object whose whole job is to stop one.
 */
export function makePlan({ title, intent, createdBy, items = [] }, { tools, now = Date.now() } = {}) {
  const t = str(title);
  if (!t) throw new Error("A plan needs a `title` — one line a person can read in the rail.");
  const i = str(intent);
  if (!i) {
    throw new Error(
      "A plan needs an `intent` — your own sentence about WHY this run. It is the one field "
      + "nobody can write for you, and it is what the person approving is actually reading.");
  }
  if (!Array.isArray(items)) throw new Error("`items` must be an array (an empty plan is legal).");
  return {
    id: newPlanId(),
    v: PLAN_V,
    title: t,
    intent: i,
    createdBy: createdBy || "system",
    createdAt: now,
    updatedAt: now,
    state: "proposed",
    policy: {
      /* HALT IS THE DEFAULT and it is the owner's stated decision: on a failure
       * the remaining approved items STAY approved and the run STOPS. A human
       * or an agent presses Run again — approve-then-start holds on every
       * resumption, not only the first one. */
      onFailure: "halt",
      autoApproveUnderMinutes: null,
      delegateBrief: null,
      delegateEventId: null,
    },
    items: items.map((raw, n) => makeItem(raw, { tools, id: `i${n + 1}` })),
    note: null,
    startedAt: null,
    finishedAt: null,
  };
}

/** The next free item id in a plan — ids are stable, so a removed one is never
 *  reused and a `plan_step` event in the ledger always names one thing. */
export function nextItemId(plan) {
  let n = 0;
  for (const it of plan.items || []) {
    const m = /^i(\d+)$/.exec(it.id || "");
    if (m) n = Math.max(n, Number(m[1]));
  }
  for (const e of plan.retiredIds || []) {
    const m = /^i(\d+)$/.exec(e || "");
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `i${n + 1}`;
}

/* ────────────────────────────────────────────────── finding plans on a doc */

export const plansOf = (doc) => (Array.isArray(doc?.plans) ? doc.plans : []);

/** The one plan in a live state, or null. At most one exists — addPlan refuses
 *  a second rather than overwriting the first. */
export function livePlan(doc) {
  return plansOf(doc).find((p) => LIVE_STATES.has(p?.state)) || null;
}

export function findPlan(doc, planId) {
  if (!planId) return livePlan(doc);
  return plansOf(doc).find((p) => p.id === planId) || null;
}

/**
 * Put a new plan on the document — REFUSING rather than overwriting.
 *
 * server/batch.js:152 is the reason this is a refusal: pressing Start twice
 * discarded the whole in-flight object, and nothing said so. A plan is a
 * decision somebody made; a second propose that silently replaced it would
 * throw away an approval.
 */
export function addPlan(doc, plan) {
  const live = livePlan(doc);
  if (live) {
    throw new Error(
      `A plan is already open on this project ("${live.title}", ${live.state}). `
      + "Approve it, run it, or discard it first.");
  }
  if (!Array.isArray(doc.plans)) doc.plans = [];
  doc.plans.unshift(plan);
  doc.plans = doc.plans.slice(0, PLAN_LIMIT);
  return plan;
}

/** The index row every read returns beside the plan itself. */
export const planIndex = (doc) => plansOf(doc).map((p) => ({
  id: p.id, title: p.title, state: p.state, createdAt: p.createdAt,
  createdBy: p.createdBy, items: (p.items || []).length,
}));

/* ─────────────────────────────────────────────── the quality line (§3.3) */

/**
 * THE ONE LINE THE OWNER ASKED FOR, and the traps that belong beside it.
 *
 *   H3 · 1920x1088 · 4 steps · references ON — above H3's native 1344x768, ~11 min/clip
 *
 * ⚠ IT SITS ON THE OBJECT BEING APPROVED. A quality choice explained anywhere
 * else is a quality choice nobody read: DIRECTING.md §4 has said all of this for
 * months, and every trap below was found the expensive way anyway. Before
 * approval, on the card, is the only place it means anything.
 *
 * The engine here is the project's MODE, not one scene's resolution — a scene's
 * own engine is on its item, from resolveShot, and the two can legitimately
 * differ under `hybrid`. Saying which is which is the point.
 */
export function qualityLine(doc) {
  const brief = doc?.brief || {};
  const mode = String(brief.videoEngine || "hybrid").toLowerCase();
  const [w, h] = renderSize(doc);
  /* videoSizeFor is asked for the mode's own engine where there is one, and for
   * h3 under hybrid — the expensive branch is the one whose size matters. */
  const engineForSize = mode === "ltx" ? "ltx" : "h3";
  const size = videoSizeFor(engineForSize, w, h);
  const castRefs = brief.castRefs !== false;
  /* "default" is priced as what it RUNS: the count the speed-up files on this
   * disk were made for (clipsteps.js defaultClipSteps), as generate.js sends
   * it. Read as null it used to be classed as the bare 20-step model. */
  const stepsSet = brief.videoSteps ?? null;
  const steps = clipStepsFor(brief, { refs: castRefs && mode !== "ltx" });
  const stepClass = stepClassOf(steps, { refs: castRefs });

  const traps = [];
  if (mode === "ltx") {
    traps.push({
      kind: "ltx-drops-references",
      level: "warn",
      msg: "references are dropped entirely on LTX — every character sheet you built is not used. "
        + "The code reads `useRefs = hasRefs && mode !== \"ltx\"`, so choosing it does not warn, "
        + "it just returns a stranger with the right hair colour.",
      cite: "DIRECTING.md §4",
    });
  }
  if (mode === "hybrid") {
    traps.push({
      kind: "hybrid-routes-on-cast",
      level: "info",
      msg: (ltxReadyNow()
        ? "hybrid sends any scene carrying a named CHARACTER to H3 and everything else to LTX. "
          + "One imported character can therefore qualify every scene for the expensive path and "
          + "turn a twenty-minute render into an overnight one"
        : "hybrid sends a scene with no cast to LTX only when LTX is on this PC, and it is not, so "
          + "every scene renders on H3, the expensive path")
        + " — read the per-item engine below, it is resolveShot's own answer and not a guess.",
      cite: "DIRECTING.md §4",
    });
  }
  /* The band is judged against the file that LOADS on this machine — an
   * 8-step reference build exists since 2026-09-12 and refTurboLora picks it,
   * so 8 steps with references is a matched setting where it is on disk and
   * an overrun where it is not. The message names the file's own count. */
  const loaded = loadedLoraSteps(steps, { refs: castRefs });
  if (trapBand(steps, { refs: castRefs, loaded })) {
    traps.push({
      kind: "step-band",
      level: "error",
      msg: `${steps} steps loads the ${loaded}-step ${castRefs ? "reference " : ""}distillation and runs it `
        + `past its design point — the estimates below are a floor until you use ${loaded}, `
        + "or 13+ for the bare model.",
      cite: "DIRECTING.md §4",
    });
  }
  if (engineForSize === "h3" && size.width * size.height > H3_NATIVE.w * H3_NATIVE.h) {
    traps.push({
      kind: "above-native",
      level: "info",
      msg: `${size.width}x${size.height} is above H3's native ${H3_NATIVE.w}x${H3_NATIVE.h} — `
        + "untrained territory, and priced accordingly. Both shipped films rendered there at 4 "
        + `steps; the knee measured at ${H3_NATIVE.knee.w}x${H3_NATIVE.knee.h}, and 1920x1088 `
        + "buys nothing over it for 22% more wall clock.",
      cite: "docs/RESOLUTION_FOR_FACES.md",
    });
  }
  if (engineForSize === "h3" && stepClass === "bare"
      && size.width * size.height >= H3_OOM.w * H3_OOM.h) {
    traps.push({ kind: "h3-oom", level: "error", msg: H3_OOM.note, cite: H3_OOM.cite });
  }
  if (!castRefs && mode !== "ltx") {
    traps.push({
      kind: "refs-off",
      level: "warn",
      msg: "cast references are switched off for this project, so the sheets do not reach the "
        + "video model even on H3. The prompt still names them.",
      cite: "server/mv/shot.js",
    });
  }

  /* The measured per-clip figure at THIS engine and size, from the same table
   * the items use — so the headline and the rows cannot disagree. */
  const perClip = tableMinutes({
    engine: engineForSize, steps, refs: castRefs,
    width: size.width, height: size.height,
    seconds: 5, pass: engineForSize === "ltx" ? "two" : undefined,
  });

  const stepWords = stepsSet == null ? `${steps} steps (the default for the files on this PC)` : `${steps} steps`;
  /* HYBRID SAYS WHAT IT DOES HERE: LTX takes the cast-less scenes only when it
   * is on this PC (shot.js), and those scenes come out at LTX's own size,
   * floored to 64 (960x544 renders 960x512), which is said beside H3's. */
  const ltxHere = ltxReadyNow();
  const ltxSize = mode === "hybrid" && ltxHere ? videoSizeFor("ltx", w, h) : null;
  const ltxDiffers = ltxSize && (ltxSize.width !== size.width || ltxSize.height !== size.height);
  const line = [
    mode === "hybrid"
      ? (ltxHere ? "hybrid (H3 where there is cast, LTX elsewhere)" : "hybrid (LTX is not on this PC, so H3 for every scene)")
      : mode.toUpperCase(),
    `${size.width}x${size.height}` + (ltxDiffers ? ` (LTX scenes ${ltxSize.width}x${ltxSize.height})` : ""),
    stepWords,
    `references ${castRefs && mode !== "ltx" ? "ON" : "OFF"}`,
  ].join(" · ")
    + (perClip ? ` — ~${perClip.minutes} min per 5 s clip` : "");

  return {
    engine: mode, engineForSize,
    width: size.width, height: size.height,
    requested: { width: w, height: h },
    quantised: size.quantised, grid: size.grid,
    steps, stepsSet, stepClass, castRefs,
    aspectRatio: brief.aspectRatio ?? null,
    qualityMode: brief.qualityMode ?? null,
    baseScale: brief.baseScale ?? null,
    perClipMinutes: perClip?.minutes ?? null,
    line, traps,
  };
}

/* ───────────────────────────────────────────────── per-item derivation */

/** Which scene an item is about, in whatever spelling its tool takes. */
function segmentArg(item) {
  const a = item?.args || {};
  for (const k of ["segment", "segmentId", "segment_id", "id"]) {
    if (a[k] !== undefined && a[k] !== null && a[k] !== "") return String(a[k]);
  }
  return null;
}

/**
 * WHAT THIS ITEM WOULD ACTUALLY RENDER — from the renderer's own functions and
 * from nowhere else.
 *
 * resolveShot gives the engine, renderSize gives the base pair, videoSizeFor
 * applies each engine's own flooring. That last one is the "544 survived
 * because the picker disagreed with the graph" lesson: this app shipped a
 * "960 x 544 · fast" option that rendered 512 for months, and the fix was to
 * keep both answers in ONE function. A plan that re-derived a size here would
 * be the same bug with a new surface.
 */
function clipQuality(doc, item) {
  const seg = segmentArg(item);
  if (!seg) return { error: "this item names no scene — `segment` is missing from its args" };
  let shot = null;
  try { shot = resolveShot(doc, seg); }
  catch (err) { return { error: String(err?.message || err) }; }
  const [w, h] = renderSize(doc);
  const size = videoSizeFor(shot.engine, w, h);
  return {
    segmentId: shot.segmentId,
    scene: shot.scene,
    engine: shot.engine,
    engineMode: shot.engineMode,
    useRefs: shot.useRefs,
    refsSent: shot.refsSent,
    castRefs: shot.castRefs,
    width: size.width, height: size.height,
    quantised: size.quantised,
    durationSec: shot.durationSec,
    blocked: shot.blocked,
    refs: (shot.refs || []).map((r) => r.name),
    refsMissing: (shot.refsMissing || []).map((r) => r.name),
  };
}

/**
 * The estimate, in the order §3.1 sets out: measured, then table, then flat,
 * then free, then ABSENT. An unknown tool yields null and is counted as
 * unpriced — never folded into the total as a zero. That is the Ear's rule
 * that absent is reported as absent, and it is why the headline can honestly
 * read "at least 4 h 10 m, 2 items unpriced".
 */
/** One clip at the PROJECT's current engine and size, for the tools that render
 *  a set rather than a scene. Same table, same cite. */
function perClipTable(doc, project) {
  const avg = (doc.segments || []).filter((s) => s.mode === "generate")
    .map((s) => Number(s.durationSec)).filter((n) => Number.isFinite(n) && n > 0);
  return tableMinutes({
    engine: project.engineForSize,
    steps: clipStepsFor(doc.brief, { refs: doc.brief?.castRefs !== false && project.engineForSize !== "ltx" }),
    refs: doc.brief?.castRefs !== false,
    width: project.width, height: project.height,
    seconds: avg.length ? avg.reduce((a, b) => a + b, 0) / avg.length : 5,
    pass: project.engineForSize === "ltx" ? "two" : undefined,
  });
}

/**
 * @param measuredFor  (engine) => {perClipMinutes, samples} | null. A FUNCTION
 *   and not a value, because the measurement is per engine: see the note at
 *   `sameShape` below and regen.js's own.
 * @param measuredControl  { [via]: {minutes, samples, …} } | null — this
 *   install's own control-render medians, out of the ENGINE ledger rather
 *   than the project document. A value and not a function because there are
 *   exactly two vias and reading them costs one ledger scan, which the route
 *   does once per view rather than once per item.
 */
function estimateFor(doc, item, quality, measuredFor, project, measuredControl = null) {
  const tool = item.tool;
  if (FREE_TOOLS.has(tool)) {
    return { minutes: 0, free: true, basis: "free",
             why: "reads or writes the document; no model runs" };
  }
  /* ⚠ BEFORE THE GENERIC FLAT BRANCH, because a control item is flat in shape
   * and not in price. Two things the `per`/`count` machinery above cannot say:
   * mode "pose" is TWO renders rather than one, and this install's own ledger
   * out-measures the stated constant the moment it holds a single completed run
   * — there is nothing to scale, because VACE builds one operating point and
   * only one. `measuredControl` is the route's read of that ledger; absent, the
   * estimate is the constant and says so with `unmeasuredHere`. */
  if (CONTROL_TOOLS.has(tool)) {
    return controlMinutes(tool, { mode: item.args?.mode ?? null, measured: measuredControl });
  }
  if (FLAT_TOOLS[tool]) {
    const f = FLAT_TOOLS[tool];
    const count = f.per === "take" ? item.args?.count
      : f.per === "angle" ? (Array.isArray(item.args?.angles) ? item.args.angles.length : undefined)
      /* A mesh that rigs itself in the same pass is two model loads and two
       * stages. It is the only argument on that tool that changes the price,
       * and a meter that charged it as one stage would under-report exactly
       * the choice that costs more. */
      : f.per === "stage" ? (item.args?.rig === true ? 2 : 1)
      : 1;
    return flatMinutes(tool, count);
  }
  /* ⚠ THE SWEEP IS N CLIPS, NOT ONE, and it is the single most expensive thing
   * a plan can contain. Leaving it unpriced would put the biggest number on the
   * card in the "unpriced" column, which is exactly backwards. It is priced
   * from scanStale — the same scan mv_regen_stale itself reports from — times
   * the project's own per-clip figure, honouring the `limit` argument if one
   * was set. (A sweep inside a plan is also the thing the plan exists to
   * replace: the tool descriptions say to seed `from: "stale"` and get one item
   * per scene, which is a card a person can actually read.) */
  if (tool === "mv_regen_stale") {
    const rows = scanStale(doc).filter((r) => !r.blocked);
    const lim = Number(item.args?.limit);
    const n = Number.isFinite(lim) && lim > 0 ? Math.min(rows.length, Math.floor(lim)) : rows.length;
    if (item.args?.dry_run === true || item.args?.dryRun === true) {
      return { minutes: 0, free: true, basis: "free", why: "a dry run reports and renders nothing" };
    }
    const one = perClipTable(doc, project);
    if (!one) return null;
    return {
      minutes: Math.round(one.minutes * n * 10) / 10,
      upperMinutes: Math.round((one.upperMinutes ?? one.minutes) * n * 10) / 10,
      basis: "sweep", clips: n, perClipMinutes: one.minutes, cite: one.cite,
      why: `${n} stale clip${n === 1 ? "" : "s"} at the project's current engine and size`,
    };
  }
  if (!CLIP_TOOLS.has(tool)) return null;             // unknown: unpriced, out loud
  if (!quality || quality.error) return null;

  /* MEASURED FIRST, and only where the measurement is about the same thing.
   * The runs list times whatever this project has been rendering; if the
   * item's engine and size are what those renders were, that is the best number
   * in the building. If they are not, it is a number about a different render.
   *
   * ⚠ THE ENGINE USED TO BE CHECKED AGAINST THE PROJECT'S AND NOT AGAINST THE
   * MEASUREMENT'S, which is not the same test and cost felt-hammers a factor of
   * six: the project rendered on ltx, the brief was switched to h3, so
   * `quality.engine === q.engineForSize` was TRUE (h3 === h3) and the median
   * handed over was still the ltx one — 8.7 minutes quoted against a table that
   * said 50. `measuredFor` is now keyed by the item's own engine, so a brief
   * whose engine has no renders behind it falls through to the table and says
   * `basis: "table"` out loud. */
  const q = project;
  const measured = measuredFor(quality.engine);
  const sameShape = measured
    && quality.width === q.width && quality.height === q.height;
  if (sameShape) {
    return {
      minutes: measured.perClipMinutes,
      basis: "measured",
      measuredFrom: `${measured.samples} previous ${quality.engine} renders in this project`,
      cite: "server/mv/regen.js measuredMinutesPerClip",
    };
  }
  return tableMinutes({
    engine: quality.engine,
    steps: clipStepsFor(doc.brief, { refs: !!quality.useRefs }),
    refs: doc.brief?.castRefs !== false,
    width: quality.width, height: quality.height,
    seconds: quality.durationSec,
    pass: quality.engine === "ltx" ? "two" : undefined,
  });
}

/**
 * The warnings for one item: a FILTER over crimeBoard(doc).breaks, never a
 * second lint.
 *
 * generate.js's crimeBoard note is "one builder, not two", and it is the rule
 * here for the same reason it is the rule there — a person who fixes what the
 * map shows must not then be told something different by the plan. Levels come
 * straight through.
 */
function warningsFor(breaks, quality) {
  if (!quality?.segmentId) return [];
  const want = new Set([`clip:${quality.segmentId}`, `board:${quality.segmentId}`]);
  return breaks
    .filter((b) => (b.nodes || []).some((n) => want.has(n)))
    .map((b) => ({ level: b.level, kind: b.kind, where: b.where, msg: b.msg }));
}

/** An error-level warning is the one that cannot be approved silently. */
export const blockingWarnings = (warnings) => (warnings || []).filter((w) => w.level === "error");

/**
 * ⚠ THE ONE THAT EARNS ITS PLACE. A `noSheet` reference means the item is about
 * to spend up to 28 minutes rendering a scene where a named prop reaches the
 * model as NOTHING — the failure DIRECTING.md is mostly about. It is a `warn`
 * in crimeBoard's own levels, correctly: you can legitimately render before
 * every sheet exists. But approving it is a decision, so approval requires
 * `acknowledge` and the refusal names the references. A speed bump with the
 * reason attached, not a wall.
 */
export const needsAcknowledgement = (warnings) =>
  (warnings || []).filter((w) => w.level === "error" || w.kind === "noSheet");

/* ────────────────────────────────────────────────────────── planView */

/**
 * THE DERIVED HALF. Everything a renderer also computes is computed here, on
 * read, every time — so the plan and the renderer cannot disagree, because
 * there is only one of them.
 *
 * @param opts.measured  override for testing; defaults to the runs-list median
 * @param opts.events    the project's provenance events, for the spend meter.
 *                       Omitted, the meter reports null rather than zero.
 * @param opts.controlRuns  this install's control-render medians keyed by the
 *                       engine record's `via`. Omitted, a control item is
 *                       priced from the stated constant and says so — absent
 *                       is absent, never a zero and never a silent guess.
 * @param opts.now       the clock, injectable so etaAt is testable
 */
/**
 * The measured median, PER ENGINE, with the test override kept.
 *
 * `opts.measured` is a fixture: honoured for the engine it names, and for every
 * engine when it names none (which is what every existing caller means).
 */
function measuredLookup(doc, opts) {
  if (opts.measured === undefined) return (engine) => measuredMinutesPerClip(doc, engine);
  const m = opts.measured;
  return (engine) => (m && (m.engine == null || m.engine === engine) ? m : null);
}

/**
 * WHAT ONE CALL WOULD COST, for a caller that has no plan — the spend meter's
 * stamp and any route that wants to price a single tool call before making it.
 *
 * Exported so the number on the card and the number charged to the budget come
 * out of the same function. Two estimators would be two answers to one
 * question, and the wrong one is whichever the person is not looking at.
 */
export function estimateOne(doc, item, opts = {}) {
  const project = opts.project ?? qualityLine(doc);
  const q = CLIP_TOOLS.has(item.tool) ? clipQuality(doc, item) : null;
  return estimateFor(doc, item, q, measuredLookup(doc, opts), project, opts.controlRuns ?? null);
}

export function planView(doc, plan, opts = {}) {
  if (!plan) return null;
  const now = opts.now ?? Date.now();
  const measuredFor = measuredLookup(doc, opts);
  const quality = qualityLine(doc);

  /* ONE crimeBoard PER VIEW, not one per item. It walks every scene and every
   * asset row; calling it twenty-two times to paint twenty-two rows would make
   * reading a plan cost more than proposing one. A malformed document must not
   * take the card down with it either — the map is exactly what you need when
   * something is wrong. */
  let breaks = [];
  try { breaks = crimeBoard(doc).breaks || []; } catch { breaks = []; }

  const items = (plan.items || []).map((item) => {
    const q = CLIP_TOOLS.has(item.tool) ? clipQuality(doc, item) : null;
    const warnings = warningsFor(breaks, q);
    return {
      ...item,
      quality: q,
      warnings,
      needsAcknowledgement: needsAcknowledgement(warnings).map((w) => w.msg),
      estimate: estimateFor(doc, item, q, measuredFor, quality, opts.controlRuns ?? null),
    };
  });

  const counted = (st) => items.filter((i) => i.status === st).length;
  /* THE TOTAL IS OVER WHAT WILL ACTUALLY RUN. A skipped item's minutes are not
   * a cost and a done one's are not a forecast; folding either in produces a
   * headline that is wrong in the direction that makes the run look worse than
   * it is, which teaches people to ignore it. */
  const willRun = items.filter((i) => i.status === "approved" || i.status === "running");
  let totalMinutes = 0, unpriced = 0, upperMinutes = 0;
  for (const i of willRun) {
    if (!i.estimate) { unpriced++; continue; }
    totalMinutes += i.estimate.minutes || 0;
    upperMinutes += i.estimate.upperMinutes ?? i.estimate.minutes ?? 0;
  }
  totalMinutes = Math.round(totalMinutes * 10) / 10;
  upperMinutes = Math.round(upperMinutes * 10) / 10;

  const basis = new Set(willRun.map((i) => i.estimate?.basis).filter(Boolean));
  const perClip = willRun.map((i) => i.estimate)
    .filter((e) => e && !e.free && e.minutes > 0).map((e) => e.minutes);

  const totals = {
    items: items.length,
    approved: counted("approved"),
    proposed: counted("proposed"),
    edited: counted("edited"),
    skipped: counted("skipped"),
    running: counted("running"),
    done: counted("done"),
    failed: counted("failed"),
    perClipMinutes: perClip.length
      ? Math.round((perClip.reduce((a, b) => a + b, 0) / perClip.length) * 10) / 10 : null,
    totalMinutes,
    upperMinutes,
    unpriced,
    /* The headline's provenance is about the PROJECT's own engine — the one
     * every unedited item will render on. */
    measuredFrom: (() => {
      const m = measuredFor(quality.engineForSize);
      return m ? `${m.samples} previous ${quality.engineForSize} renders in this project` : null;
    })(),
    basis: [...basis],
    /* batch.js's "the one number that actually matters at bedtime". */
    etaAt: willRun.length ? now + totalMinutes * 60e3 : null,
    /* ⚠ NEVER A NUMBER THAT PRETENDS TO BE COMPLETE, and never a duration for a
     * run that has not been approved: "under a minute" over an empty plan reads
     * as a cheap job rather than as nothing chosen yet. */
    headline: !willRun.length
      ? "nothing approved yet"
      : unpriced
        ? `at least ${humanMinutes(totalMinutes)}, ${unpriced} item${unpriced === 1 ? "" : "s"} unpriced`
        : humanMinutes(totalMinutes),
    spread: COST_SPREAD.why,
  };

  return {
    ...plan,
    items,
    totals,
    quality,
    spend: spendMeter(doc, opts.events, { now }),
  };
}

/* ─────────────────────────────────────────────────── the spend meter (§11) */

/**
 * UNATTENDED SPEND SINCE THE LAST APPROVAL — the honest version of "should
 * every agent render go through a plan".
 *
 * It does not, and a per-tool refusal is trivially defeated by looping, so the
 * gate is a meter with a soft budget. A human's own click is the approval and
 * resets it; an agent's spend accumulates against it.
 *
 * ⚠ IT SHIPS OFF. `brief.agentBudgetMinutes` defaults to null, which is no gate
 * at all, and the meter is painted anyway. A default that starts refusing calls
 * an agent used to be allowed to make is a regression by the house rule no
 * matter how good the reason — and a week of real numbers beats a guessed
 * threshold. The recommended first value when it is turned on is 30 minutes:
 * roughly one H3 clip at 1080p, i.e. "an agent may spend one expensive mistake
 * unattended, never two".
 *
 * @param events  the project's provenance events, oldest first. ABSENT is
 *                reported as absent: with no ledger the meter is null, never 0.
 */
/**
 * ⚠ THE FIELD THE METER READS, exported so the seam that writes it and the
 * meter that reads it cannot spell it differently. A route that stamps a
 * generation's estimated cost on its provenance event must use THIS name; a
 * misspelling here is a meter that silently reads zero forever, which is worse
 * than no meter at all.
 */
export const SPEND_FIELD = "estimatedMinutes";

export function spendMeter(doc, events, { now = Date.now() } = {}) {
  // null / undefined / "" is the documented NO-GATE value. Number(null) is 0 and
  // Number.isFinite(0) is true, so the old test turned "no budget" into "a budget
  // of zero minutes" and refused the first agent render after any spend.
  const rawBudget = doc?.brief?.agentBudgetMinutes;
  const budgetMinutes = (rawBudget == null || rawBudget === "") ? null
    : (Number.isFinite(Number(rawBudget)) ? Number(rawBudget) : null);
  if (!Array.isArray(events)) {
    return {
      unattendedMinutesSinceApproval: null,
      budgetMinutes,
      over: false,
      since: null,
      why: "no ledger was read for this view — the meter is absent, not zero",
    };
  }
  let since = 0;
  for (const e of events) {
    if ((e.type === "choice" || e.type === "approve") && e.actor === "user") {
      const t = Date.parse(e.t);
      if (Number.isFinite(t) && t > since) since = t;
    }
  }
  let minutes = 0;
  for (const e of events) {
    const t = Date.parse(e.t);
    if (!Number.isFinite(t) || t < since) continue;
    if (!String(e.actor || "").startsWith("agent:")) continue;
    const m = Number(e.data?.[SPEND_FIELD]);
    if (Number.isFinite(m)) minutes += m;
  }
  minutes = Math.round(minutes * 10) / 10;
  return {
    unattendedMinutesSinceApproval: minutes,
    budgetMinutes,
    over: budgetMinutes != null && minutes > budgetMinutes,
    since: since || null,
    sinceAgo: since ? Math.round((now - since) / 60e3) : null,
    why: budgetMinutes == null
      ? "no budget is set, so nothing is refused — the number is here to be watched"
      : `budget ${budgetMinutes} min`,
  };
}

/** The refusal sentence, in one place so the routes and the tools cannot word
 *  it differently. */
export function budgetRefusal(spend) {
  return `This project has spent ${spend.unattendedMinutesSinceApproval} unattended minutes since `
    + `the last approval, and its budget is ${spend.budgetMinutes}. Propose a plan `
    + "(mv_plan_propose) and get it approved, or a human can raise brief.agentBudgetMinutes.";
}

/* ───────────────────────────────────────────────────────── editing a plan */

/**
 * add / edit / remove one item.
 *
 * Refuses to touch an item that is running or done — a finished render is
 * evidence, and editing the record of it is the one thing this object must not
 * make possible.
 *
 * ⚠ AN EDIT TO AN APPROVED ITEM DROPS IT BACK TO `edited`, loudly. That is the
 * whole reason the object exists: approval is of a SPECIFIC SET OF ARGUMENTS,
 * and carrying it across a change would make approval mean nothing.
 */
export function applyItemOp(plan, { op, itemId, tool, args, why, at }, { tools, now = Date.now(), by = "system" } = {}) {
  if (!ITEM_OPS.has(op)) {
    throw new Error(`op must be one of ${[...ITEM_OPS].join(", ")} — not "${op}".`);
  }
  if (plan.state === "running") {
    throw new Error("This plan is running. Pause it first — editing an item under the runner is "
      + "how an approved argument and an executed one come apart.");
  }
  if (plan.state === "done" || plan.state === "cancelled") {
    throw new Error(`This plan is ${plan.state} and cannot be edited. Propose a new one.`);
  }
  const changed = [];

  if (op === "add") {
    const item = makeItem({ tool, args, why }, { tools, id: nextItemId(plan) });
    const idx = Number.isFinite(Number(at)) ? Math.max(0, Math.min(plan.items.length, Number(at)))
      : plan.items.length;
    plan.items.splice(idx, 0, item);
    changed.push(`${item.id} added at position ${idx + 1} — it is proposed, not approved`);
    plan.updatedAt = now;
    return { changed, item };
  }

  const item = (plan.items || []).find((i) => i.id === itemId);
  if (!item) throw new Error(`No item ${itemId} in plan ${plan.id}.`);
  if (item.status === "running" || item.status === "done") {
    throw new Error(`Item ${item.id} is ${item.status} — a render in flight or already made cannot be edited.`);
  }

  if (op === "remove") {
    plan.retiredIds = [...(plan.retiredIds || []), item.id];
    plan.items = plan.items.filter((i) => i.id !== item.id);
    changed.push(`${item.id} removed`);
    plan.updatedAt = now;
    return { changed, item: null };
  }

  // edit
  const wasApproved = item.status === "approved";
  /* ⚠ null IS ABSENT HERE, not the empty string. An editor that sends every
   * field it knows about sends `tool: null` for "I did not touch the tool", and
   * that was refused as `"" is not a tool a plan can run` — a message about a
   * name nobody typed. `args` uses null for "delete this key" one branch down
   * and keeps that meaning; a plan item without a tool is not a thing. */
  if (tool !== undefined && tool !== null) {
    const t = str(tool);
    if (tools && !tools.includes(t)) {
      throw new Error(`"${t}" is not a tool a plan can run. Legal names: ${tools.join(", ")}.`);
    }
    if (t && t !== item.tool) {
      item.edits.push({ at: now, by, field: "tool", from: item.tool, to: t });
      item.tool = t;
      changed.push(`${item.id} tool -> ${t}`);
    }
  }
  if (args !== undefined) {
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      throw new Error("`args` must be an object — the named arguments of the tool this item calls.");
    }
    /* MERGE, not replace. The editor sends the fields it edited; replacing
     * would silently drop the seed a person set two edits ago. */
    for (const [k, v] of Object.entries(args)) {
      const before = item.args[k];
      if (JSON.stringify(before) === JSON.stringify(v)) continue;
      item.edits.push({ at: now, by, field: `args.${k}`, from: before ?? null, to: v });
      if (v === null) delete item.args[k]; else item.args[k] = clone(v);
      changed.push(`${item.id} args.${k} -> ${JSON.stringify(v)}`);
    }
  }
  if (why !== undefined) {
    const w = str(why) || null;
    if (w !== item.why) {
      item.edits.push({ at: now, by, field: "why", from: item.why, to: w });
      item.why = w;
      changed.push(`${item.id} why rewritten`);
    }
  }
  if (changed.length && wasApproved) {
    item.status = "edited";
    changed.push(`${item.id} fell back to edited — approve it again`);
  } else if (changed.length && item.status === "proposed") {
    item.status = "edited";
  }
  plan.updatedAt = now;
  return { changed, item };
}

/**
 * Approve, skip, or put back. `items` is a list of ids or "all".
 *
 * Partial approval is the NORMAL case — approve the eight you are sure of, skip
 * the four you are not — so this takes a set and reports per id.
 *
 * The refusal: an item whose scene carries an error-level break or a reference
 * with no rendered sheet cannot go to `approved` without `acknowledge: true`,
 * and the refusal names the references. Refusing after the fact is worse than
 * not being able to make the mistake.
 */
export function decideItems(doc, plan, { items, status, acknowledge = false }, opts = {}) {
  if (!DECIDABLE.has(status)) {
    throw new Error(`status must be one of ${[...DECIDABLE].join(", ")} — not "${status}".`);
  }
  if (plan.state === "running") {
    throw new Error("This plan is running. Pause it before changing what is approved.");
  }
  const view = planView(doc, plan, opts);
  const wantAll = items === "all" || items === undefined || items === null;
  const ids = wantAll ? view.items.map((i) => i.id)
    : (Array.isArray(items) ? items.map(String) : [String(items)]);

  const changed = [], rejected = [], now = opts.now ?? Date.now();
  for (const id of ids) {
    const live = (plan.items || []).find((i) => i.id === id);
    const seen = view.items.find((i) => i.id === id);
    if (!live) { rejected.push({ id, why: `no item ${id} in this plan` }); continue; }
    if (live.status === "running" || live.status === "done") {
      /* "all" must not report every finished item as a rejection — that is
       * noise on the normal path. Naming one explicitly still gets an answer. */
      if (!wantAll) rejected.push({ id, why: `${id} is ${live.status}` });
      continue;
    }
    if (status === "approved") {
      const need = needsAcknowledgement(seen?.warnings);
      if (need.length && !acknowledge) {
        rejected.push({
          id,
          why: `${id} carries ${need.length} warning${need.length === 1 ? "" : "s"} that will not `
            + "happen by accident: " + need.map((w) => w.msg).join(" | ")
            + " — send acknowledge: true to approve it anyway.",
          warnings: need,
        });
        continue;
      }
    }
    if (live.status === status) continue;
    changed.push(`${id}: ${live.status} -> ${status}`);
    live.status = status;
  }
  plan.updatedAt = now;
  /* The plan's own state follows its items: something approved makes the plan
   * approved, and un-approving the last one puts it back. Derived from the
   * items rather than set by the caller, so the two cannot disagree. */
  if (LIVE_STATES.has(plan.state) && plan.state !== "running" && plan.state !== "paused") {
    plan.state = (plan.items || []).some((i) => i.status === "approved") ? "approved" : "proposed";
  }
  return { changed, rejected };
}

/**
 * The failure policy, and the delegation.
 *
 * ⚠ SETTING autoApproveUnderMinutes WITHOUT A BRIEF IS REFUSED, in the Ear's own
 * sentence. A threshold that approves on a human's behalf is a DELEGATION, and a
 * delegation with no brief is a machine decision wearing a human's name — which
 * is the exact thing the provenance ledger exists to make impossible. The brief
 * is stored verbatim and the `delegate` event's id is stored beside it, so every
 * item the machine then approves can name the authority it acted under.
 */
export function setPolicy(plan, { onFailure, autoApproveUnderMinutes, delegateBrief, delegateEventId }, { now = Date.now() } = {}) {
  const changed = [];
  if (onFailure !== undefined && onFailure !== null) {
    const v = String(onFailure);
    if (v !== "halt" && v !== "continue") {
      throw new Error('on_failure must be "halt" or "continue".');
    }
    if (v !== plan.policy.onFailure) {
      changed.push(`on failure: ${plan.policy.onFailure} -> ${v}`);
      plan.policy.onFailure = v;
    }
  }
  if (autoApproveUnderMinutes !== undefined) {
    if (autoApproveUnderMinutes === null) {
      if (plan.policy.autoApproveUnderMinutes !== null) changed.push("auto-approve cleared");
      plan.policy.autoApproveUnderMinutes = null;
      plan.policy.delegateBrief = null;
      plan.policy.delegateEventId = null;
    } else {
      const n = Number(autoApproveUnderMinutes);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error("auto_approve_under_minutes must be a positive number of minutes, or null.");
      }
      const brief = str(delegateBrief);
      if (!brief) {
        throw new Error(
          "delegation needs the human's brief in their own words — it is the direction-setting "
          + "the dossier records as their contribution. Send delegate_brief.");
      }
      plan.policy.autoApproveUnderMinutes = n;
      plan.policy.delegateBrief = brief;      // VERBATIM. Never summarised.
      plan.policy.delegateEventId = delegateEventId ?? null;
      changed.push(`auto-approve under ${n} min, under the brief recorded verbatim`);
    }
  }
  plan.updatedAt = now;
  return { changed };
}

/**
 * WHICH ITEMS THE DELEGATION WOULD APPROVE — computed here, applied by the
 * caller, so the rule and the ledger entry cannot come apart.
 *
 * Returns the ids only. The route flips them AND writes one `judge` event each,
 * actor `agent:plan`, naming `policy.delegateEventId` in `delegatedBy` —
 * provenance.js's judgeEvent already refuses a judge without one, which is the
 * check that stops a machine approval being recorded as a human's choice.
 *
 * ⚠ AN UNPRICED ITEM IS NEVER AUTO-APPROVED. "Under five minutes" cannot be
 * true of a cost nobody could work out, and reading absent as zero is the exact
 * mistake this whole estimator refuses to make. Nor is an item carrying a
 * warning that a human would have had to acknowledge: a delegation is
 * permission to spend, not permission to skip the speed bump.
 */
export function autoApprovable(doc, plan, opts = {}) {
  const under = plan?.policy?.autoApproveUnderMinutes;
  if (!Number.isFinite(Number(under)) || Number(under) <= 0) return [];
  if (!plan.policy.delegateBrief) return [];
  const view = planView(doc, plan, opts);
  return view.items
    .filter((i) => i.status === "proposed" || i.status === "edited")
    .filter((i) => i.estimate && Number.isFinite(i.estimate.minutes))
    .filter((i) => i.estimate.minutes <= Number(under))
    .filter((i) => needsAcknowledgement(i.warnings).length === 0)
    .map((i) => i.id);
}

/**
 * Throw the plan away. Refused while it is running — the runner is mid-render
 * and would keep walking a plan that no longer exists, which is the one way to
 * get a GPU job nobody can see.
 */
export function discardPlan(doc, planId, { live = false } = {}) {
  const p = findPlan(doc, planId);
  if (!p) throw new Error(`No plan ${planId ?? "(live)"} on this project.`);
  if (p.state === "running" || live) {
    throw new Error("This plan is running. Stop it first — discarding it would leave a render "
      + "walking a plan that no longer exists.");
  }
  doc.plans = plansOf(doc).filter((x) => x.id !== p.id);
  return { discarded: p.id, title: p.title, items: (p.items || []).length };
}

/* ───────────────────────────────────────────── healing after a restart */

/**
 * A PLAN THAT WAS RUNNING WHEN THE PROCESS DIED COMES BACK PAUSED — NEVER
 * RUNNING.
 *
 * batch.js's exact rule and its exact reason: "the machine may have rebooted
 * for a reason, and silently firing up a four-hour GPU job on boot is not a
 * friendly default." An item left at `running` never finished, so it was never
 * done — it heals back to `approved` and a resume re-runs it.
 *
 * Lazy on purpose: there is no boot scan. Reading every project.json at boot to
 * find a plan almost nobody has is not worth it, so this runs inside plan_read
 * and the GET, which is exactly when somebody is looking.
 *
 * @param live  whether the runner really holds this slug right now. Supplied by
 *              planrun.isRunning(); this module knows nothing about processes.
 */
export function healPlan(plan, { live = false, now = Date.now() } = {}) {
  if (!plan || plan.state !== "running" || live) return { healed: false, plan };
  plan.state = "paused";
  plan.note = RESUME_NOTE;
  const healed = [];
  for (const it of plan.items || []) {
    if (it.status !== "running") continue;
    it.status = "approved";
    it.startedAt = null;
    healed.push(it.id);
  }
  plan.updatedAt = now;
  return { healed: true, plan, items: healed };
}

/* ───────────────────────────────────────────────────── seeding a plan */

/**
 * `from` seeds the items out of what the project already knows, using the
 * scanners that already exist. No fourth copy of "what is stale" — scanStale is
 * the one mv_regen_stale reports from, so a seeded plan and that report cannot
 * describe two different sets of scenes.
 *
 * Seed, then edit. That is cheaper and more accurate than writing twenty items
 * by hand, and it is what the tool description tells an agent to do.
 */
export const SEEDS = ["stale", "unrendered", "nosheet"];

export function seedItems(doc, from) {
  if (from === "stale") {
    return scanStale(doc).map((r) => ({
      tool: "mv_regen_clip",
      args: { slug: doc.slug, segment: r.segmentId },
      why: r.blocked
        ? `scene ${r.scene} is stale (${r.reasons.join(", ")}) but ${r.blocked}`
        : `scene ${r.scene} is stale: ${r.reasons.join(", ")}`,
    }));
  }
  if (from === "unrendered") {
    return (doc.segments || [])
      .filter((s) => s.mode === "generate")
      .filter((s) => {
        const clip = (doc.clips || []).find((c) => c.segmentId === s.id);
        return !clip?.clipFile;
      })
      .map((s) => ({
        tool: "mv_generate_clip",
        args: { slug: doc.slug, segment: s.id },
        why: `scene ${s.index + 1} has no take`,
      }));
  }
  if (from === "nosheet") {
    const out = [];
    for (const [kind, rows] of [["characters", doc.characters], ["backgrounds", doc.backgrounds],
                                ["props", doc.props]]) {
      for (const r of rows || []) {
        if (r.imageFile) continue;
        out.push({
          tool: "mv_generate_asset",
          args: { slug: doc.slug, kind, id: r.id || r.name },
          why: `"${r.name}" is declared with no rendered sheet — it reaches every render that `
            + "names it as nothing",
        });
      }
    }
    return out;
  }
  throw new Error(`from must be one of ${SEEDS.join(", ")} — not "${from}".`);
}

/** Whether a scene really exists, for the routes' own argument checking. */
export const sceneExists = (doc, segmentId) => {
  try { return !!findSegment(doc, segmentId); } catch { return false; }
};
