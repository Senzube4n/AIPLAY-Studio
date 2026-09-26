/**
 * LENDING FOR A PERSON WITH NO STRONG CARD — the numbers both sides need, each
 * computed by the function the renderer itself uses rather than by a copy.
 *
 * A borrower with no GPU renders nothing at home, so every scene of theirs is a
 * scene "never rendered here", every take they keep comes from a friend, and
 * every number on the return check is somebody else's render measured against
 * this machine's expectation of it. Five things went wrong on that path, and
 * each one was a second opinion drifting from the first:
 *
 *   the frame count   the return check expected round(seconds * 24) while H3
 *                     rounds a clip UP to its 17k+5 grid (a 6 s scene renders
 *                     158 frames, not 144) and LTX to its 8k+1 grid — so a
 *                     correct take was refused. `expectForOrder` asks
 *                     `alignFrames`, the one function the graph asks.
 *   the engine        which engine the lender's errand will run is decided by
 *                     `resolveShot` on the errand document — the same call
 *                     `generateClip` makes — so the owner resolves it the same
 *                     way on a provisional copy of that document.
 *   filing a take     a take was filed only onto a scene that already had a
 *                     clip row, and only a render makes one. `fileTakeOnScene`
 *                     makes the row the way generate.js makes it.
 *   speed-up files    the step count selects the distillation LoRA
 *                     (`h3TurboLoraFor`), and a PC set up from the Models screen
 *                     has only 4-step files — an 8-step order runs a 4-step
 *                     file at 8 steps. `speedUpCheck` says so with plancost's
 *                     `trapBand`, the rule the Plan card and the borrower's
 *                     notes use too, and names files from the engine's own
 *                     table of them and the Models screen's own catalogue.
 *   minutes a day     the friend row stored a number nothing read. Accept now
 *                     checks it against what this card has spent (timed here)
 *                     and promised (estimated by the plan's own estimator).
 *
 * ⚠ NOTHING HERE DECIDES FOR ANYBODY. A speed-up overrun is a warning, never a
 * refusal and never a silent change of step count; the minutes are a refusal a
 * person can walk through with "Accept anyway". The order's four words are not
 * touched: `steps` stays what the owner asked for.
 */

import fs from "node:fs";
import path from "node:path";

import { config, loraStepsOf } from "../config.js";
import { CATALOG } from "../models.js";
import { alignFrames, h3TurboLoraFor, videoEngine } from "../workflow.js";
import { findBoard, resolveShot } from "../mv/shot.js";
import { estimateOne } from "../mv/plan.js";
import { trapBand } from "../mv/plancost.js";
import { ERRAND_SEGMENT, errandDoc, errandName } from "./errand.js";
import { orderPlanItem } from "./order.js";
import { H3_MV_SCREEN } from "../h3tier.js";

/* ───────────────────────────────────────── where things are, in words */

/**
 * The rail's label for the screen that holds a project's Plan card and its
 * Video clips stage — web/index.html `data-view="workflow"`.
 *
 * ⚠ ONE CONSTANT FOR EVERY SENTENCE THIS LANE'S SERVER CODE WRITES, AND IT IS
 * PINNED TO THE RAIL. The agreed UI plan relabels that rail entry; when it
 * does, lending_test.js fails until this follows, rather than every sentence
 * quietly pointing at a screen the rail no longer names. The page's own
 * sentences read the rail's label directly (web/app.js cbScreen).
 */
export const WORKFLOW_SCREEN = H3_MV_SCREEN;   // the one copy: server/h3tier.js

/** Where an errand's plan is approved: its own project's Plan card. */
export const planPlace = (title) => `${WORKFLOW_SCREEN} → “${title}” → the Plan card`;

/** Where a kept take is chosen for its scene. */
export const pickPlace = () => `${WORKFLOW_SCREEN} → Video clips → Inspect…`;

/* ───────────────────────────────────────── the errand, before it exists */

/**
 * The errand document a lender's Studio would build from this order, without
 * writing a picture. Only the shape matters here — which pictures are cast,
 * which are guide frames — because that shape is what `resolveShot` reads to
 * choose the engine. The names are content-addressed exactly as staging names
 * them, so the provisional document and the real one resolve identically.
 */
export function provisionalErrand(orderDoc) {
  const staged = (orderDoc?.files || []).map((f) => ({
    file: f.file, name: errandName(String(f.sha256 || ""), ".png"),
    role: f.role || "ref", sha256: String(f.sha256 || ""), bytes: Number(f.bytes) || 0,
  }));
  const doc = errandDoc({ orderDoc, from: orderDoc?.returnTo || {}, staged, now: Number(orderDoc?.at) || 1 });
  doc.slug = "errand-preview";
  return doc;
}

/** Which engine the errand will render on, and whether its pictures ride as
 *  references — `resolveShot`'s own answer, never a re-derivation. */
export function resolveErrand(orderDoc) {
  const doc = provisionalErrand(orderDoc);
  const plan = resolveShot(doc, ERRAND_SEGMENT, {});
  return { doc, engine: plan.engine, useRefs: !!plan.useRefs };
}

/* ───────────────────────────────────────── what the finished take measures */

/** generate.js's own clamp on the length it asks for: a second to fifteen. */
const clampSeconds = (s) => Math.min(Math.max(Number(s) || 5, 1), 15);

/**
 * What the lender's render of this order will measure, in the renderer's own
 * arithmetic. `frames` is what the file will hold; `slotFrames` is the scene's
 * own length, kept so a message can say both numbers.
 */
export function expectForOrder(orderDoc) {
  const shot = orderDoc?.shot || {};
  const { engine } = resolveErrand(orderDoc);
  const seconds = clampSeconds(shot.seconds);
  const fps = Number({ ...config.video, ...videoEngine(engine) }.fps) || 24;
  return {
    width: Number(shot.width), height: Number(shot.height),
    seconds, engine, fps,
    frames: alignFrames(seconds, fps, engine),
    slotFrames: Math.round(seconds * fps),
  };
}

/**
 * The frame counts a returned take may be centred on.
 *
 * An order row written by this build names its engine, so there is one answer.
 * A row written BEFORE this build carries only `round(seconds * 24)`, and the
 * engine that answered it is unknown — so it accepts that number or either
 * engine's grid above it. The check around each centre is still order.js's own
 * few frames of encoder slack; nothing here widens it.
 */
export function framesAccepted(expect) {
  if (!expect || !Number.isFinite(Number(expect.frames))) return [];
  const frames = Number(expect.frames);
  if (expect.engine) return [frames];
  const fps = Number(expect.fps) || 24;
  const seconds = frames / fps;
  return [...new Set([frames, alignFrames(seconds, fps, "h3"), alignFrames(seconds, fps, "ltx")])];
}

/** An order row with the accepted centres filled in, for `checkReturn`. */
export function withFrameGrid(orderRow) {
  if (!orderRow?.expect) return orderRow;
  return { ...orderRow, expect: { ...orderRow.expect, framesAny: framesAccepted(orderRow.expect) } };
}

/* ───────────────────────────────────────── speed-up files (turbo LoRAs) */

/** "Is this file in a loras folder the engine loads from, with bytes in it" —
 *  the same test config.js pick() applies, over the same folders. */
export function loraOnDisk(name, cfg = config) {
  if (!name) return false;
  const bases = [cfg.modelsDir, ...(Array.isArray(cfg.modelsAlso) ? cfg.modelsAlso : [])].filter(Boolean);
  return bases.some((b) => {
    try { return fs.statSync(path.join(b, "loras", String(name))).size > 0; } catch { return false; }
  });
}

/**
 * The speed-up files known for one path (reference pictures or not) and the
 * step counts they are made for — read off the engine's own table of files
 * (`turboShiftByLora`) with the one file-name reader (`loraStepsOf`). No list
 * of step counts lives here: the reference path has no 3-step build, and this
 * says so because the table has none, not because somebody typed it.
 */
export function speedUpBuilds(eng, refs) {
  const family = refs ? /ref2v/i : /fl2v|taomate/i;
  const files = Object.keys(eng?.turboShiftByLora || {}).filter((name) => family.test(name));
  const steps = [...new Set(files.map(loraStepsOf).filter(Number.isInteger))].sort((a, b) => a - b);
  return { files, steps };
}

/**
 * The Models screen row that downloads this file, or null — read from the
 * catalogue that screen paints (server/models.js CATALOG), never from a list
 * kept here. Only a file a row DOWNLOADS counts; an `alt` name is one a row
 * accepts as present, not one it offers.
 */
export function modelsRowFor(name) {
  if (!name) return null;
  for (const row of CATALOG) {
    for (const f of row.files || []) {
      if (path.basename(String(f.dest || "")) === name) return { id: row.id, label: row.label };
    }
  }
  return null;
}

const listSteps = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : String(xs[0] ?? ""));

/**
 * What an H3 render at `steps` would load, and whether that is a problem.
 *
 *   missing   the file `h3TurboLoraFor` picks is not on this PC: the render
 *             would stop when the engine loads it.
 *   overrun   the file loads, and `steps` OVERRUNS the count it was made for —
 *             plancost's `trapBand`, the same rule the Plan card's floor note
 *             and the borrower's return notes (order.js returnNotes) use, so a
 *             lender is warned exactly when the borrower will be told.
 *
 * Running a file below its count (3 steps on the 4-step file, which config.js
 * documents as the fallback where TaoMate is absent) is not an overrun and
 * says nothing — the rule's own boundary, not this function's.
 *
 * Every sentence offers only what this build can do: a file the Models screen
 * offers is named with its row; one it does not offer is said to be missing
 * from it; a file already on disk that did not load is a restart.
 */
export function speedUpCheck({ engine, steps, refs = false } = {}, { cfg = config, onDisk = loraOnDisk, catalogue = modelsRowFor } = {}) {
  const n = Number(steps);
  const quiet = { engine, steps: n, refs: !!refs, loads: null, madeFor: null, present: null, builds: [], needs: [], problem: null, why: null };
  /* LTX loads no speed-up file, and FastH3 is a distillation of its own. */
  if (engine !== "h3" || !Number.isFinite(n)) return quiet;
  const v = { ...cfg.video, ...cfg.video.engines.h3 };
  const choice = h3TurboLoraFor(v, { steps: n, refs: !!refs });
  /* Over the turbo range the full model runs with no speed-up file at all. */
  if (!choice.turbo || !choice.lora) return quiet;
  const madeFor = loraStepsOf(choice.lora);
  const builds = speedUpBuilds(v, !!refs);
  const present = onDisk(choice.lora, cfg);
  const needs = builds.files.filter((name) => loraStepsOf(name) === n);
  const out = { ...quiet, loads: choice.lora, madeFor, present, builds: builds.steps, needs };
  const pathWords = refs ? "with reference pictures" : "without reference pictures";
  if (!present) {
    const row = catalogue(choice.lora);
    return { ...out, problem: "missing",
      why: `This scene renders on H3 at ${n} steps ${pathWords}, which loads the speed-up file ${choice.lora} — and it is not on this PC, so the render would stop when the engine tries to load it. `
        + (row
          ? `Download it from the Models screen (“${row.label}”) before you approve the plan.`
          : "The Models screen does not offer it, so leave this order unaccepted and tell your friend.") };
  }
  if (!trapBand(n, { refs: !!refs, loaded: madeFor })) return out;
  let fileLine;
  if (!needs.length) {
    fileLine = `No speed-up file is made for ${n} steps ${pathWords}; they are made for ${listSteps(builds.steps)} steps.`;
  } else {
    const here = needs.find((name) => onDisk(name, cfg));
    const offered = needs.map((name) => ({ name, row: catalogue(name) })).find((x) => x.row);
    fileLine = here
      ? `The file made for ${n} steps ${pathWords}, ${here}, is on this PC but loads only after a restart: restart the Studio, then approve the plan.`
      : offered
        ? `The file made for ${n} steps ${pathWords} is ${offered.name}, and the Models screen offers it (“${offered.row.label}”); it is used as soon as the download lands.`
        : `The file made for ${n} steps ${pathWords} is ${needs.join(" or ")}, and the Models screen does not offer it.`;
  }
  return { ...out, problem: "overrun",
    why: `This scene asks for ${n} steps, and the speed-up file this PC loads for it, ${choice.lora}, is made for ${madeFor}: ${n} steps overruns it, so the take can come back looking burned or over-sharpened. ${fileLine} You can render it as it is — your friend's copy of the take says so — or leave it unaccepted and ask them to order ${madeFor} steps.` };
}

/** The speed-up check for the errand this order becomes. */
export function speedUpForOrder(orderDoc, opts) {
  const { engine, useRefs } = resolveErrand(orderDoc);
  return speedUpCheck({ engine, steps: orderDoc?.order?.steps, refs: useRefs }, opts);
}

/* ───────────────────────────────────────── minutes of this card per day */

/** Midnight, on this machine's clock: a lender's day is the lender's. */
export function startOfDay(now) {
  const d = new Date(Number(now) || Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The plan's own estimate for rendering an errand, or null. One estimator:
 *  the number here is the number the Plan card shows before it is approved. */
export function estimateErrand(doc) {
  try {
    const order = doc?.collab?.order;
    if (!order) return null;
    const e = estimateOne(doc, orderPlanItem({ order }, doc.slug || "errand", ERRAND_SEGMENT));
    return e && Number.isFinite(Number(e.minutes)) ? e : null;
  } catch {
    return null;
  }
}

const round1 = (x) => Math.round(x * 10) / 10;

/**
 * What this card has already given one friend today.
 *
 * `measuredMinutes` is TIMED HERE, the render alone: `runMs`, which
 * generate.js takes from the art queue's own clock (from when the job started
 * running), for takes finished since midnight. A take from before that field
 * existed has only `ms`, which runs from the request and so includes any wait
 * behind other jobs; it still counts, and `withWait` says how many did, so the
 * sentence can say so. `pendingMinutes` is ESTIMATED: scenes of theirs
 * accepted TODAY that have not rendered yet, priced by the plan's estimator,
 * because an accepted scene will spend this card whether or not it has
 * started. An older unrendered errand is not counted until it renders —
 * otherwise one plan nobody approved would shrink every later day for good.
 */
export async function lentToday({ rows = [], readProject, fp, now = Date.now(), except = null } = {}) {
  const since = startOfDay(now);
  const who = String(fp || "").toLowerCase();
  const out = { measuredMinutes: 0, rendered: 0, withWait: 0, pendingMinutes: 0, pending: 0, unpriced: 0 };
  for (const row of rows) {
    if (!row || String(row.from?.fp || "").toLowerCase() !== who || (except && row.id === except)) continue;
    if (!["landed", "rendered"].includes(row.state) || !row.slug) continue;
    const doc = await readProject(row.slug).catch(() => null);
    /* A project deleted by hand has nothing left to spend and nothing to count. */
    if (!doc) continue;
    const takes = (doc.clips || []).flatMap((c) => c.takes || []);
    const timed = takes.filter((t) => Number(t.at) >= since && (Number(t.runMs) > 0 || Number(t.ms) > 0));
    if (timed.length) {
      for (const t of timed) {
        if (Number(t.runMs) > 0) out.measuredMinutes += Number(t.runMs) / 60000;
        else { out.measuredMinutes += Number(t.ms) / 60000; out.withWait++; }
      }
      out.rendered++;
      continue;
    }
    if (takes.length) continue;               // rendered on an earlier day
    if (!(Number(row.landedAt) >= since)) continue;   // accepted before today, never rendered
    const e = estimateErrand(doc);
    out.pending++;
    if (e) out.pendingMinutes += Number(e.minutes); else out.unpriced++;
  }
  out.measuredMinutes = round1(out.measuredMinutes);
  out.pendingMinutes = round1(out.pendingMinutes);
  return out;
}

/** What `lentToday` found, as the sentence both the accept card and the
 *  Friends row show. Composed here, so the page only displays it. */
export function usedSentence(used) {
  const parts = [
    used.rendered
      ? `${used.measuredMinutes} min timed on this card today${used.withWait ? ` (${used.withWait === 1 ? "one render was" : `${used.withWait} renders were`} timed from request to finish, so that includes waiting in the queue)` : ""}`
      : "nothing rendered for them yet today",
    used.pending
      ? `${used.pending} scene${used.pending === 1 ? "" : "s"} accepted today still to render (${used.unpriced ? "at least" : "about"} ${used.pendingMinutes} min${used.unpriced ? `; ${used.unpriced} with no estimate` : ""})`
      : "",
  ];
  return parts.filter(Boolean).join(", ");
}

/**
 * Accept's minutes check. `over` is a refusal the person may walk through with
 * "Accept anyway" (and a tool with `anyway: true`); `why` is the sentence either
 * way, so the card can say what a yes costs before anybody presses it.
 *
 * ⚠ A SCENE WITH NO ESTIMATE IS NOT A SCENE THAT COSTS NOTHING. Its minutes are
 * left out of the total, and the total then says "at least", never "about".
 */
export async function budgetCheck({ peer, orderDoc, rows = [], readProject, now = Date.now() } = {}) {
  const allowance = Number(peer?.lendMinutesPerDay) || 0;
  const name = peer?.nickname || String(peer?.fp || "").slice(0, 8) || "this friend";
  const used = await lentToday({ rows, readProject, fp: peer?.fp, now, except: orderDoc?.id });
  const est = estimateErrand(resolveErrand(orderDoc).doc);
  const thisOne = est ? round1(Number(est.minutes)) : null;
  const total = round1(used.measuredMinutes + used.pendingMinutes + (thisOne ?? 0));
  const unknown = thisOne === null || used.unpriced > 0;
  const cost = thisOne === null
    ? "this scene has no estimate"
    : `this scene is about ${thisOne} min more (${est.basis === "measured" ? "timed on earlier renders here" : "an estimate, not timed on this card"})`;
  const tally = `${unknown ? "at least" : "about"} ${total} min in all`;
  const base = { allowance, used, thisOne, total, unknown };
  if (allowance <= 0) {
    return { ...base, over: true, reason: "budget-zero",
      why: `You give ${name} 0 minutes of your card a day (Collab → Friends, “Minutes of my card per day”), so accepting is a decision to make on purpose. ${cost[0].toUpperCase()}${cost.slice(1)}.` };
  }
  const why = `${name} may use ${allowance} minutes of your card a day: ${usedSentence(used)}, and ${cost} — ${tally}.`;
  if (total > allowance) return { ...base, over: true, reason: "budget-spent", why };
  return { ...base, over: false, reason: null, why };
}

/* ───────────────────────────────────────── the borrower's half: filing a take */

/**
 * Put an adopted take on the scene it was ordered for — making the scene's clip
 * row if nothing was ever rendered for it here, which for a borrower with no
 * GPU is every scene. The row is the shape generate.js gives a first render,
 * and the board is found by shot.js's own `findBoard`.
 *
 * ⚠ THE TAKE IS NOT PICKED. `clipFile` is not set, so a scene that had nothing
 * still has nothing playing until a person chooses this take. Picking is an
 * artistic act, and a friend's render becoming the chosen take unseen is what
 * the whole return path exists to prevent.
 */
export function fileTakeOnScene(doc, segmentId, take) {
  let row = (doc.clips || []).find((c) => c.segmentId === segmentId);
  let created = false;
  if (!row) {
    const seg = (doc.segments || []).find((s) => s.id === segmentId);
    if (!seg) return { filed: false, created: false };
    const board = findBoard(doc, seg);
    row = { id: `c_${seg.id}`, segmentId: seg.id, clipIndex: seg.index,
            boardId: board?.id ?? null, mode: "generate", takes: [] };
    doc.clips = [...(doc.clips || []), row];
    created = true;
  }
  row.takes = [...(row.takes || []), take];
  return { filed: true, created };
}
