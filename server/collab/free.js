/**
 * IS THIS MACHINE FREE TO TAKE SOMEBODY ELSE'S RENDER?
 *
 * One question, asked before a friend's order is accepted, and it is harder than
 * it looks. This module is pure: it takes readings and returns a verdict and the
 * sentence a person should see. It exists so that the wrong expression cannot be
 * written a second time, because the obvious one is wrong twice over and both
 * halves were measured on this machine.
 *
 * ⚠ ONE. `art.idle` IS NOT "THE ART RUNNER IS IDLE". Read it (server/art.js):
 *
 *     get idle() { return this.comfy.ready && !this.jobs.current && this.jobs.queue.length === 0; }
 *
 * `this.jobs` is the MUSIC queue. So `idle` answers "is the music queue empty",
 * and it is `true` for the whole of a twenty-eight-minute video clip. An
 * acceptance test written as `art.idle && art.queue.length === 0` therefore
 * reads FREE while the card is fully committed. `art.current` is the term that
 * was missing, and `art.queued` is a NUMBER rather than an array.
 *
 * ⚠ TWO. MOST GPU WORK NEVER ENTERS THE ART RUNNER AT ALL. Measured live on
 * this instance while writing this: `/api/status` reported `art.current: null`
 * and `queue: 0` at the same moment the engine door reported
 * `queue {running: 1, pending: 0}` with a `reactive.motion` render 173 seconds
 * into the card. Every Reactive render, every harness through the engine door
 * and most plan steps go straight to the engine. (Not all: a plan step that runs
 * a tool which queues on the ArtRunner does appear there, so the two readings
 * overlap rather than partition.) **The only machine-wide
 * reading is the engine's own status**, and a free answer that does not include
 * it is not a reading of a machine, it is a reading of one queue.
 *
 * Confirmed a second time through this module itself, against the live app
 * while a dance scene was on the card: machineBusy answered
 * `engine-busy — motion look, 4 minutes in` at the same moment the design's
 * expression evaluated to FREE.
 *
 * ⚠ THREE. A PAUSED QUEUE ACCEPTS WORK THAT NEVER STARTS. `art.paused` is its
 * own refusal for that reason: saying yes to a friend and then not rendering is
 * worse than saying no, because they are waiting on a take that is not coming.
 *
 * ⚠ FOUR, AND IT IS A DECISION RATHER THAN AN OVERSIGHT: a chat turn on the
 * engine does NOT count as busy. A chat reply is seconds and it would otherwise
 * make a machine look permanently occupied to its friends. It is discounted by
 * `via`, here, in the open, so that it is a decision somebody can disagree with.
 *
 * ⚠ AND TWO CONSUMERS NOTHING HERE CAN SEE. `meshFromImage` spawns its own
 * python, and the audiobook's text-to-speech does too; neither passes the engine
 * door, so neither appears in any reading this module is given. A "free" answer
 * says so in its own sentence rather than claiming a certainty it does not have.
 */

import { isBriefChatVia } from "../engine/chat-vias.js";

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** How long something has been going, in words. Rounding to minutes printed
 *  "0 minutes in" for everything under half a minute, which reads as a bug. */
function elapsed(secs) {
  const s = Math.round(n(secs));
  if (!s) return "";
  if (s < 90) return `, ${s} second${s === 1 ? "" : "s"} in`;
  return `, ${Math.round(s / 60)} minutes in`;
}

/**
 * @param art    `art.status().art` — `{ paused, current, queued }`, where
 *               `queued` is a count and `current` is an object or null.
 * @param jobs   the music queue — `{ current, queue }` as `/api/status` carries
 *               it at the top level. It does NOT nest under a key.
 * @param plansRunning  `anyRunning()` from planrun.js — an array of slugs.
 * @param engine `engine.status()` — `{ ready, queue: {running, pending}, running: [{via, label, elapsedSec}] }`,
 *               or null when it could not be reached.
 * @returns `{ busy, reason, why }`. `reason` is null when free.
 */
export function machineBusy({ art = null, jobs = null, plansRunning = [], engine = null, unreadable = [] } = {}) {
  const say = (reason, why) => ({ busy: true, reason, why });

  if (art && art.paused) {
    return say("art-paused", "This Studio's own render queue is paused. Accepting work now would mean saying yes to your friend and then not rendering, which is worse than saying no — start the queue again first.");
  }
  /* Unknown local queues are non-overridable. Otherwise a known busy queue
   * could be overridden while another queue was unreadable. */
  if (Array.isArray(unreadable) && unreadable.length) {
    return say("workload-unreachable", `This Studio cannot read its ${unreadable.join(", ")} status, so it cannot promise that the card is free. Nothing was accepted.`);
  }
  if (art && art.current) {
    const t = art.current.title || art.current.kind || "something";
    return say("art-rendering", `This Studio is rendering ${t}${elapsed(art.current.elapsed)}. One card, one render at a time.`);
  }
  if (art && n(art.queued) > 0) {
    return say("art-queued", `This Studio has ${n(art.queued)} of its own render${n(art.queued) === 1 ? "" : "s"} waiting. A friend's scene would go behind them and they have not agreed to wait.`);
  }
  if (jobs && jobs.current) {
    return say("music-rendering", "This Studio is rendering a song. Music and video do not share this card well.");
  }
  if (jobs && n(jobs.queue?.length ?? jobs.queue) > 0) {
    return say("music-queued", "This Studio has songs waiting to render.");
  }
  const running = Array.isArray(plansRunning) ? plansRunning.filter(Boolean) : [];
  if (running.length) {
    return say("plan-running", `A plan is running on ${running.join(", ")}. It walks one item at a time because the resource it is spending is this card, and a friend's scene cannot jump it.`);
  }

  if (!engine) {
    return say("engine-unreachable", "This Studio cannot read its own engine, so it cannot honestly say whether the card is free. Nothing was accepted.");
  }
  /* `engine.status()` can still report `ready: true` when its separate queue
   * probe failed. With no queue reading, the count of work started outside this
   * Studio is unknown, so an empty local in-flight list proves nothing. */
  if (!engine.queue || ![engine.queue.running, engine.queue.pending].every((count) => Number.isSafeInteger(count) && count >= 0)) {
    return say("engine-unreachable", "This Studio cannot read its engine queue, so it cannot honestly say whether the card is free. Nothing was accepted.");
  }
  /* ⚠ THE ENGINE IS ASKED LAST AND IT IS THE ONLY ONE THAT SEES EVERYTHING.
   * The four readings above are queues this app keeps; this is the card. */
  const inFlight = Array.isArray(engine.running) ? engine.running : [];
  const live = inFlight.filter((r) => !isBriefChatVia(r?.via));
  if (live.length) {
    const r = live[0];
    return say("engine-busy", `The card is busy: ${r.label || r.via || "a render"}${elapsed(r.elapsedSec)}. That is the reading that sees everything — most work here never touches this app's own queues.`);
  }
  /* ⚠ `queue.running` IS READ AS WELL AS `running[]`. The array lists what THIS
   * app dispatched; the count is what the engine says is on the card. A render
   * somebody started in ComfyUI's own window appears in the second and not the
   * first, and reading only the array called that machine free. */
  /* These are exact prompt-ID matches produced from this same engine queue,
   * not counts inferred from local rows that can linger after a render ends. */
  const otherRunning = Math.max(0, n(engine.queue.running) - n(engine.queue.briefChatRunning));
  if (otherRunning > 0) {
    return say("engine-busy", `${otherRunning} job${otherRunning === 1 ? " is" : "s are"} running on the card. Not all of it was started by this app — the engine's own count sees work this Studio never dispatched.`);
  }
  const otherPending = Math.max(0, n(engine.queue.pending) - n(engine.queue.briefChatPending));
  if (otherPending > 0) {
    return say("engine-busy", `${otherPending} job${otherPending === 1 ? " is" : "s are"} waiting on the card already.`);
  }
  if (engine.ready === false) {
    return say("engine-unreachable", "This Studio's engine is not running, so there is nothing to render a friend's scene with yet.");
  }

  return {
    busy: false,
    reason: null,
    /* ⚠ THE CAVEAT IS PART OF THE ANSWER. Two GPU consumers on this machine —
     * the mesh builder and the audiobook's voice — spawn their own python and
     * pass no door this module is given, so "free" is the truth as far as
     * anything can see it and not a guarantee about the card. */
    why: "Nothing this Studio can see is using the card: its own render queue is empty, no song is rendering, no plan is walking, and the engine has nothing running or waiting. Two things could still be — a 3D mesh and a text-to-speech pass each run their own process outside every queue here — so this is the truest reading available and not a promise.",
  };
}

/**
 * The readings, gathered.
 *
 * ⚠ NAMED `readWorkload` AND NOT `readMachine`, WHICH IS TAKEN. server/fit.js
 * exports a `readMachine` that answers what the hardware IS — the card, its
 * memory, the system RAM — and this answers what the hardware is DOING. Two
 * functions of that name in one file is a collision node refuses outright, and
 * the two questions are different enough that the refusal was doing its job.
 */
/**
 * The readings, gathered. Kept beside the judgement so that a caller cannot
 * accidentally gather three of the four — which is the mistake the design made.
 *
 * Everything is injected; this module opens nothing.
 */
export async function readWorkload({ artStatus, jobsStatus, anyRunning, engineStatus } = {}) {
  const unreadable = [];
  const safe = async (name, fn, valid, fallback) => {
    try {
      const value = await fn();
      if (valid(value)) return value;
    } catch { /* An unreadable local queue cannot establish that the card is free. */ }
    unreadable.push(name);
    return fallback;
  };
  return {
    art: await safe("render queue", async () => (await artStatus())?.art,
      (value) => value && typeof value.paused === "boolean" && Number.isSafeInteger(value.queued) && Object.hasOwn(value, "current"), null),
    jobs: await safe("music queue", jobsStatus,
      (value) => value && Object.hasOwn(value, "current") && Array.isArray(value.queue), null),
    plansRunning: await safe("plan", anyRunning, Array.isArray, []),
    /* null, not {}: "could not read the engine" and "the engine is idle" are
     * different answers and only one of them may accept work. */
    engine: await (async () => { try { return await engineStatus() ?? null; } catch { return null; } })(),
    unreadable,
  };
}
