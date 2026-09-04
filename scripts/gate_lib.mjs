/**
 * Shared machinery for the conditioning gates — gate_run.mjs (LTX appearance
 * guides) and vace_run.mjs (WAN VACE structural residual).
 *
 * WHY THIS FILE EXISTS, AND WHAT IS DELIBERATELY *NOT* IN IT.
 *
 * vace_run.mjs needed roughly four hundred lines that gate_run.mjs already had
 * and that have nothing to do with either model: probe a clip with PyAV, hash
 * it, ask /system_stats whether the engine answering on this port is actually
 * this rig's, POST a graph and poll it to a terminal state without ever hanging,
 * and walk a ComfyUI API graph looking for dangling links, bad output slots,
 * orphans and cycles. Copying those into a second script would mean two copies
 * of the bounded poll loop — and the poll loop is the part that was hardened
 * after a measured incident (eight silent polls, no deadline, a half-open socket
 * that would have blocked forever). Two copies of a hardened thing decay into
 * one hardened thing and one that looks like it.
 *
 * So the model-agnostic half moved here and BOTH scripts import it.
 *
 * What stayed behind, on purpose, because it is not shared and pretending it is
 * would be worse than duplication:
 *
 *   - `guideLatentSpan` / `assertGuidePlacement` — pure LTX latent arithmetic,
 *     replicated from nodes_lt.py. WAN's VACE has a temporal factor of 4 and no
 *     guide index at all; there is nothing to generalise.
 *   - `buildControl` / `buildDense` / `describeGuides` — LTX graph surgery.
 *   - `fingerprint` / `certifiedValues` — each names the classes of ONE graph
 *     shape. A "generic" version would take the class list as an argument and
 *     be a worse comment than the two explicit ones.
 *   - the three-numbers assertion — SHARED in spirit, but the numbers differ
 *     per run, so what is exported is `assertThreeNumbers(probe, spec)` taking
 *     the spec rather than reading module constants.
 *
 * The prompt guard IS here, and must be: gate_run and vace_run use the SAME
 * frozen prompt, and a camera-move word leaking into it invalidates the
 * text-only control of whichever run it reaches. One list, one guard.
 */
import { stat, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "../server/config.js";

/* ─────────────────────────── graph primitives ────────────────────────────── */

/** A ComfyUI API-format link: ["<node id>", <output slot>]. */
export const isLink = (v) =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && Number.isInteger(v[1]);

export const findByClass = (g, cls) => Object.keys(g).filter((k) => g[k].class_type === cls);

export const oneByClass = (g, cls) => {
  const f = findByClass(g, cls);
  if (f.length !== 1) throw new Error(`expected exactly one ${cls}, found ${f.length}`);
  return f[0];
};

/** Stable JSON — object keys sorted at every level, so two graphs that differ
 *  only in insertion order hash the same. Used by both fingerprints. */
export const sortedJSON = (o) => JSON.stringify(o, (_, v) =>
  (v && typeof v === "object" && !Array.isArray(v))
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
    : v);

/** Every node reachable BACKWARDS from `from` (inclusive) along input links. */
export function ancestors(g, from) {
  const seen = new Set([from]);
  for (const stack = [from]; stack.length;) {
    const id = stack.pop();
    for (const v of Object.values(g[id]?.inputs ?? {})) {
      if (isLink(v) && g[v[0]] && !seen.has(v[0])) { seen.add(v[0]); stack.push(v[0]); }
    }
  }
  return seen;
}

/**
 * The structural checks that are true of ANY ComfyUI API graph: every link
 * points at a node that exists, at an output slot that node actually has;
 * exactly one output node; nothing orphaned; no cycles.
 *
 * `outSlots` is the arity table of the CALLING script — each gate declares its
 * own and cross-checks it against /object_info under --preflight, because
 * ComfyUI is deliberately not running while graphs are being built.
 *
 * Returns an array of complaint strings. Empty means clean.
 */
export function structuralProblems(g, outSlots, outputClasses) {
  const bad = [];
  const ids = new Set(Object.keys(g));

  for (const [id, node] of Object.entries(g)) {
    if (!node?.class_type) { bad.push(`${id}: no class_type`); continue; }
    if (!node.inputs || typeof node.inputs !== "object") { bad.push(`${id}: no inputs object`); continue; }
    for (const [k, v] of Object.entries(node.inputs)) {
      if (!isLink(v)) continue;
      const [src, slot] = v;
      if (!ids.has(src)) { bad.push(`${id}.${k} -> node ${src} which does not exist`); continue; }
      const arity = outSlots[g[src].class_type];
      if (arity === undefined) bad.push(`${id}.${k} -> ${g[src].class_type}: arity unknown to this harness`);
      else if (slot < 0 || slot >= arity) bad.push(`${id}.${k} -> ${g[src].class_type}[${slot}] but it has ${arity} output(s)`);
    }
  }

  // Reachability from the output node — an orphan is work the graph pays for
  // and throws away, and usually means a rewire missed something.
  const outs = Object.keys(g).filter((k) => outputClasses.has(g[k].class_type));
  if (outs.length !== 1) bad.push(`expected exactly 1 output node, found ${outs.length}`);
  const seen = new Set(outs);
  for (const stack = [...outs]; stack.length;) {
    const id = stack.pop();
    for (const v of Object.values(g[id].inputs)) {
      if (isLink(v) && ids.has(v[0]) && !seen.has(v[0])) { seen.add(v[0]); stack.push(v[0]); }
    }
  }
  for (const id of ids) if (!seen.has(id)) bad.push(`node ${id} (${g[id].class_type}) is orphaned`);

  // Cycles. Cheap, and a bad rewire is exactly how you make one.
  const state = {};
  const walk = (id) => {
    if (state[id] === 2) return;
    if (state[id] === 1) { bad.push(`cycle through node ${id}`); return; }
    state[id] = 1;
    for (const v of Object.values(g[id].inputs)) if (isLink(v) && ids.has(v[0])) walk(v[0]);
    state[id] = 2;
  };
  for (const id of ids) walk(id);
  return bad;
}

/* ⚠⚠ THE POSITIVE PROMPT CONTAINS NO CAMERA-MOVE WORDS, AND MUST NOT. ⚠⚠
 *
 * It lives HERE, in one place, because BOTH gates use it and both gates' claims
 * die the same way if it changes. This is the load-bearing property of the whole
 * experiment and exactly the kind of thing a later edit breaks without noticing.
 * The text-only control (A0 on LTX, W0 on WAN) receives this prompt and nothing
 * else. If the prompt described the half-orbit into top-down, the control would
 * be handed the camera move through text, it would "pass" for the wrong reason,
 * and the control-vs-arm margin -- the actual claim under test -- would measure
 * nothing at all.
 *
 * So: describe the SET, never the lens. `assertNoCameraWords()` above turns that
 * sentence into a check that fails the build rather than a comment that gets
 * skimmed. "walking away from camera" is a subject direction, not a camera move,
 * and "overhead" qualifies the strip lights -- neither is in the list.
 *
 * Two gates sharing ONE string is also what makes the two runs describe the same
 * shot. A second copy would drift, and a drifted copy is undetectable in the
 * artefacts: every number stays plausible. */
export const POSITIVE_PROMPT =
  "A long concrete corridor lit by cold overhead strip lights, a lone figure in "
  + "a dark coat walking away from camera down the centre, wet floor reflecting "
  + "the lights, volumetric haze, cinematic, shot on 35mm.";

/**
 * "This graph cannot see a single pixel of the source clip."
 *
 * Said twice, because once is not a proof. First: no pixel-source node exists
 * anywhere in the graph at all. Second, and independently: nothing upstream of
 * the SAMPLER is a pixel source. The second catches the case the first would
 * miss if a future edit added a preview branch, and the first catches a pixel
 * source wired somewhere the sampler-ancestor walk does not reach.
 */
export function pixelLeaks(g, pixelSources, samplerClass) {
  const bad = [];
  for (const [id, n] of Object.entries(g)) {
    if (pixelSources.has(n.class_type)) bad.push(`CONTROL LEAK: ${id} is a ${n.class_type}`);
  }
  const sampler = findByClass(g, samplerClass)[0];
  if (!sampler) { bad.push(`CONTROL: no ${samplerClass} in the graph, so the no-pixel-path proof cannot run`); return bad; }
  for (const id of ancestors(g, sampler)) {
    if (pixelSources.has(g[id].class_type)) bad.push(`CONTROL LEAK: ${g[id].class_type} ${id} feeds the sampler`);
  }
  return bad;
}

/* ───────────────────────────── the prompt guard ──────────────────────────── */

/* Deliberately specific. Broad words ("shot", "camera", "overhead") appear in
 * the frozen prompt describing the set and the lens format, and a guard that
 * fires on those would be turned off by the first person it inconvenienced —
 * which is worse than no guard. These are camera MOVES. */
const BANNED_CAMERA_WORDS = [
  "orbit", "orbits", "orbiting", "revolve", "revolving", "circling", "circles around",
  "pan", "pans", "panning", "whip pan", "tilt", "tilts", "tilting",
  "dolly", "dollies", "trucking", "crane", "craning", "jib",
  "zoom", "zooms", "zooming", "push in", "pull back", "pull out",
  "tracking shot", "camera move", "camera moves", "camera rotates", "rotating camera",
  "camera arcs", "sweeping camera", "flyover", "fly over", "aerial", "drone shot",
  "top-down", "top down", "bird's eye", "birds eye", "steadicam", "handheld",
];

/**
 * The positive prompt must not describe the camera move.
 *
 * If it did, the TEXT-ONLY control would be handed the camera direction through
 * text, it would "pass" for the wrong reason, and the control-vs-arm margin —
 * which is the claim under test in BOTH gates — would measure nothing. Shared
 * because the prompt is shared: a word that invalidates one run invalidates the
 * other, and one list cannot drift out of step with itself.
 */
export function assertNoCameraWords(text, who = "THE POSITIVE PROMPT") {
  const hay = text.toLowerCase();
  const hit = BANNED_CAMERA_WORDS.filter((w) =>
    new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(hay));
  if (hit.length) {
    throw new Error(
      `${who} DESCRIBES A CAMERA MOVE (${hit.join(", ")}).\n`
      + "  The text-only control would then be handed the camera direction through\n"
      + "  text, and the control-vs-arm margin — the claim these gates exist to\n"
      + "  test — would measure nothing. Describe the set, never the lens.");
  }
}

/* ─────────────────────────── the source clip ─────────────────────────────── */

/**
 * Measure a clip with PyAV — no ffmpeg on PATH, no new dependency.
 * Frames are COUNTED, not read off a header: `nb_frames` is a container hint and
 * is routinely wrong or absent, and the whole point of this check is that the
 * conditioning indices land on real frames.
 */
export async function probeClip(file) {
  const py = existsSync(config.python) ? config.python : "D:\\AI\\aiplay-studio-bench\\venv\\Scripts\\python.exe";
  const code = `
import json, sys, av
c = av.open(sys.argv[1])
s = c.streams.video[0]
n = 0
w = h = None
for f in c.decode(video=0):
    n += 1
    if w is None: w, h = f.width, f.height
r = s.average_rate
print(json.dumps({"w": w, "h": h, "frames": n,
                  "fps_num": r.numerator, "fps_den": r.denominator,
                  "codec": s.codec_context.name}))
`;
  const out = await new Promise((res) => {
    const p = spawn(py, ["-c", code, file]);
    let s = "", e = "";
    p.stdout.on("data", (d) => (s += d));
    p.stderr.on("data", (d) => (e += d));
    p.on("exit", () => res(s.trim() || `ERR ${e.trim()}`));
    p.on("error", (err) => res(`ERR ${err.message}`));
  });
  try { return JSON.parse(out); } catch { return { error: out.slice(0, 400) }; }
}

/**
 * THE THREE NUMBERS. Loud, and fatal before dispatch.
 *
 * The spec is passed in rather than read from module constants because the two
 * gates render different lengths — but the three hazards are identical and each
 * has a specific silent failure behind it. The `why` strings are supplied by the
 * caller so each gate states the mechanism in ITS OWN node's terms.
 */
export function assertThreeNumbers(v, { width, height, fps, minFrames, why = {} }) {
  const bad = [];
  if (v.error) return [`could not probe the clip: ${v.error}`];
  if (v.w !== width || v.h !== height) {
    bad.push(`size ${v.w}x${v.h}, must be ${width}x${height}`
      + (why.size ? ` — ${why.size}` : ""));
  }
  // Exactly 24.000. 24000/1001 is 23.976 and would drift a frame every ~42s.
  if (!(v.fps_num === fps && v.fps_den === 1)) {
    bad.push(`fps ${v.fps_num}/${v.fps_den}, must be exactly ${fps}/1`
      + (why.fps ? ` — ${why.fps}` : ""));
  }
  if (!(v.frames >= minFrames)) {
    bad.push(`${v.frames} frames, need >= ${minFrames}`
      + (why.length ? ` — ${why.length}` : ""));
  }
  return bad;
}

/** Identity, not just shape. sha256 + size + mtime of a file on disk. */
export async function fileFacts(f) {
  const s = await stat(f);
  return { path: f, size: s.size, mtime: s.mtime.toISOString(),
           sha256: createHash("sha256").update(await readFile(f)).digest("hex") };
}

/* ───────────────────────── engine identity + dispatch ────────────────────── */

/**
 * ⚠⚠ THE ENGINE DOOR. ComfyUI is no longer reachable at 8266 or any other fixed
 * port — the fork (AIPLAYStudioMV) now binds it to an unpublished loopback port
 * chosen fresh at every start, and its own bypass census fails the build if any
 * script still names a ComfyUI route. Every graph goes through the APP now, via
 * `POST /api/engine`, or it does not run at all. See AIPLAYStudioMV's
 * docs/ENGINE_DOOR.md ("The base repo's experiment scripts") for the contract
 * this file implements; `appBase` below is that app (default
 * http://127.0.0.1:4173, override with AIPLAY_URL), not ComfyUI. Nothing here
 * pins ComfyUI's own port any more, so AIPLAY_COMFY_PORT no longer applies to
 * anything this file does.
 *
 * A request the door cannot attribute is refused, so every POST carries
 * `x-aiplay-actor: script:<name>` — derived from the running script's own
 * filename (gate_run, vace_run, …) so gate_run.mjs and vace_run.mjs need not
 * pass one explicitly.
 */
const DEFAULT_ACTOR = () => `script:${path.basename(process.argv[1] || "gate_lib", ".mjs")}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One POST to the door. Throws with the door's own error text on any refusal —
 * a bad graph, no attribution, or the app not running at all — so a caller
 * gets exactly the message a person would read by hand.
 *
 * ⚠ EVERY REQUEST FROM HERE IS SHORT, AND THAT IS A RULE, NOT AN ACCIDENT.
 * Node's `fetch` is undici, and undici gives up on a response whose HEADERS
 * have not arrived within 300 seconds. Nothing in this file may therefore hold
 * one request open across a render: see makeDispatcher, which posts
 * `wait:false` and polls. The explicit signal below makes the bound OURS and
 * states it in the error, rather than inheriting a five-minute default that
 * reports a live GPU as a missing app.
 */
async function doorPost(appBase, body, { actor, timeoutMs = 120_000 } = {}) {
  let r;
  try {
    r = await fetch(`${appBase}/api/engine`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-aiplay-actor": actor || DEFAULT_ACTOR() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new Error(`AIPLAY Studio did not answer ${body.action ?? "a request"} within `
        + `${Math.round(timeoutMs / 1000)} s at ${appBase}. The app may be busy or wedged; the render, `
        + "if one was posted, is in its ledger either way.");
    }
    throw new Error(`start AIPLAY Studio first — nothing is answering at ${appBase} `
      + `(${e.cause?.code || e.message}). Set AIPLAY_URL if the app is on another port.`);
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(d.error || `AIPLAY Studio answered ${r.status} at ${appBase}.`);
    err.problems = d.problems;
    throw err;
  }
  return d;
}

/**
 * Is anything answering, and which install is it — asked of the APP now, not
 * of ComfyUI directly. The door's own "identity" action already compares the
 * engine's --input-directory/--output-directory against THAT APP'S configured
 * directories, so the input/output/port this function used to receive and
 * check itself are no longer this file's job to verify — the door does it and
 * hands back `problems`.
 *
 * ⚠ RETURN SHAPE KEPT EXACTLY AS gate_run.mjs / vace_run.mjs ALREADY READ IT —
 * {up, version, argv, inputDir, outputDir, port, problems} — so neither caller
 * needs to change beyond its BASE line. The door's actual "identity" response
 * is a DIFFERENT shape ({version, mainPy, inputDirectory, outputDirectory,
 * matchesThisStudio, mode, port, problems} — no `up`, no `argv`, and the two
 * directory fields spelled out rather than abbreviated), mapped below. `argv`
 * can only be approximated as `[mainPy]`: the door does not expose the
 * engine's full launch argv over HTTP the way /system_stats used to.
 *
 * `matchesThisStudio` is carried through as an EXTRA field (additive, so it
 * cannot break either caller) — it is the door's own verdict, `problems.length
 * === 0 && isOurs()`, and it is what a caller should actually name when this
 * check fails, rather than the old "is not this rig's" wording that talked
 * about a raw ComfyUI port neither script posts to any more.
 */
export async function engineIdentity(appBase, { actor } = {}) {
  let d;
  try {
    d = await doorPost(appBase, { action: "identity" }, { actor });
  } catch (e) {
    return { up: false, why: e.message, version: null, argv: null, inputDir: null, outputDir: null, port: null, matchesThisStudio: null, problems: [] };
  }
  return {
    up: true, why: null,
    version: d.version ?? null,
    argv: d.mainPy ? [d.mainPy] : null,
    inputDir: d.inputDirectory ?? null,
    outputDir: d.outputDirectory ?? null,
    port: d.port ?? null,
    matchesThisStudio: d.matchesThisStudio ?? null,
    problems: d.problems || [],
  };
}

/**
 * The node/class schema this install's engine actually has — asked of the
 * APP now via the door's own "object_info" action. `GET ${appBase}/object_info`
 * against ComfyUI directly is dead once `appBase` is the app rather than
 * ComfyUI: nothing answers that raw path there (confirmed live: 404). `POST
 * {action:"object_info"}` with no `node` filter returns the exact same
 * dict ComfyUI's own `/object_info` always returned, keyed by class_type — so
 * the arity and input-name cross-checks in gate_run.mjs / vace_run.mjs's
 * --preflight need no change beyond how this one dict is fetched.
 */
export async function engineObjectInfo(appBase, { actor } = {}) {
  const d = await doorPost(appBase, { action: "object_info" }, { actor });
  return d.nodes || {};
}

/* ⚠ EVERY WAIT IN HERE IS BOUNDED. The loop used to be a bare `for(;;)` whose
 * only exits were "error" and "completed", with `catch { continue; }` swallowing
 * every fetch failure — no deadline, no attempt counter, no AbortSignal, and no
 * output at all on the catch path. Measured against a stub: after the server was
 * killed, eight further polls over 25 s produced no output and no exit, and a
 * half-open TCP connection would have blocked indefinitely.
 *
 * The failure that hits hardest is the one these harnesses themselves predict —
 * a hard CUDA OOM on the densest arm that takes the ComfyUI PROCESS with it. "An
 * OOM is a result, not a harness failure" only holds for an OOM ComfyUI survives
 * and reports; one that kills the process leaves an overnight run frozen forever,
 * and because dispatch runs sequentially, a hang on one blocks all of them.
 * Silence must never be the symptom. */
export const POLL = {
  JOB_DEADLINE_MS: 30 * 60 * 1000,
  POLL_MS: 3000,
  POST_TIMEOUT_MS: 60_000,
  POLL_TIMEOUT_MS: 15_000,
  MAX_CONSECUTIVE_POLL_FAILURES: 8,   // ~24 s of a server that stopped answering
  MAX_VANISHED_POLLS: 3,              // not in /history AND not in /queue
};

/* ⚠ THE NUMBERS FOR WATCHING THE DOOR, which are not the numbers above.
 *
 * POLL is the record of how the ENGINE is polled, and the door owns that loop
 * now. These are how THIS PROCESS watches the door — a different question with
 * a different cost, because every `run` and `status` ask makes the app read its
 * ledger. Ten seconds is modest against renders measured in tens of minutes and
 * cheap enough to leave running overnight; the queued phase asks a little more
 * often because that is where the start instant — the one the deadline hangs
 * off — has to be caught.
 *
 * THE ONE NUMBER THAT IS LOAD-BEARING is REQUEST_TIMEOUT_MS: no single request
 * may outlive it, because a request held longer than 300 s is abandoned by
 * undici underneath us and reported as an app that is not running, which is the
 * defect this whole shape exists to remove. */
export const WATCH = Object.freeze({
  WATCH_MS: 10_000,            // how often to ask the door how a run is going
  REQUEST_TIMEOUT_MS: 20_000,  // no single poll may hold a connection longer
  DISPATCH_TIMEOUT_MS: 90_000, // the wait:false POST: ledger write + POST /prompt
  STATUS_EVERY: 6,             // once started, re-check the live view once a minute
  MAX_CONSECUTIVE_WATCH_FAILURES_MS: 120_000, // of an app that stopped answering
  LOST_WINDOW_MS: 60_000,      // in neither the live view nor the ledger's results
  DEADLINE_GRACE_MS: 90_000,   // the door's own deadline must fire before ours
});

/**
 * POST one graph through the app's engine door and wait for a terminal status.
 * `deadlineMs` is per gate: LTX arms measured 130–235 s, a WAN VACE arm at
 * 3.3x its native token count may take far longer, so the caller states its
 * own bound — unchanged from before this door existed: gate_run.mjs still
 * passes 20 minutes, vace_run.mjs still passes 90.
 *
 * The door polls the ENGINE now — the bounded loop above (POLL) is kept as the
 * record of the numbers it was hardened to after the measured incident in this
 * file's header; server/engine/client.js in the fork ports those same six
 * constants verbatim. What is left here is a second, much slower loop that
 * watches the DOOR (WATCH, above), because the alternative — one request held
 * open for the whole render — is a defect with a measured cost:
 *
 *   ⚠⚠ A `wait:true` DISPATCH DIES AT 306 SECONDS AND BLAMES THE APP. ⚠⚠
 *   Node's fetch is undici, whose default `headersTimeout` is 300 s. The door's
 *   `wait:true` deliberately withholds its response until the render is over,
 *   so on the first dispatch through it every long arm reported "start AIPLAY
 *   Studio first — nothing is answering at http://127.0.0.1:4173" at 306 s,
 *   while the GPU carried on to completion and the app recorded the run
 *   perfectly. The harness could not tell that from an app that had died, and a
 *   90-minute VACE arm could not have been dispatched at all.
 *
 * So: `wait:false`, then poll `{action:"run"}` until it has a `result`, with
 * `{action:"status"}` alongside it to learn when the engine actually STARTED
 * the job — the instant both this deadline and the door's own are measured
 * from, so that a job waiting behind another render is never called late.
 *
 * The result is mapped back onto the exact shape gate_run.mjs and vace_run.mjs
 * already read: `{...job, ok, secs, why, file, promptId, oom, serverGone,
 * timedOut, vanished}` — same fields, same meanings, so neither caller's
 * dispatch loop needs to change. `queuedSec` and `runningSec` are added
 * additively, which nothing has to read.
 *
 * ⚠ ADOPTION IS OFF BY DEFAULT HERE, AND MUST STAY OFF FOR THESE HARNESSES.
 * adopt:true (the door's own default — see docs/ENGINE_DOOR.md) MOVES a
 * finished clip out of ComfyUI's own output folder into the app's clip
 * library the moment it lands. gate_score.py globs `<root>/<arm>/*.mp4`
 * straight out of ComfyUI's output tree (GATE = ".../output/gate"), and both
 * vace_run.mjs's and film_run.mjs's own resume checks `readdir()` that same
 * tree looking for the file by name. Adopting it away would not error — every
 * one of those would just find nothing, silently, and vace_run's "skip if
 * already rendered" would re-render forever. The caller may still pass
 * `adopt: true` explicitly if that ever changes.
 */
export function makeDispatcher(appBase, {
  actor, deadlineMs = POLL.JOB_DEADLINE_MS, adopt = false, project = null,
  pollMs = POLL.POLL_MS, watchMs = WATCH.WATCH_MS, graceMs = WATCH.DEADLINE_GRACE_MS, log = null,
} = {}) {
  /* `pollMs` is how often the DOOR asks ComfyUI (it is forwarded, unchanged).
   * `watchMs` is how often THIS process asks the door. Two loops, two cadences,
   * and conflating them is how a 250 ms feedback render would end up making
   * 21,600 ledger reads an hour. */
  const say = typeof log === "function" ? log : () => {};

  return async function dispatch(job) {
    const t0 = Date.now();
    const secsSince = () => (Date.now() - t0) / 1000;
    const label = job.label ?? job.prefix ?? job.arm ?? null;

    /* ⚠⚠ `wait: false`, AND THE REASON IS MEASURED. ⚠⚠
     *
     * `wait: true` holds ONE HTTP response open for the entire render, and
     * Node's fetch is undici, which abandons a response whose headers have not
     * arrived within 300 seconds. The first dispatch through this door did
     * exactly that: at 306 s every long render reported "start AIPLAY Studio
     * first — nothing is answering" while the GPU carried on to completion and
     * the app recorded the run perfectly. Nothing was broken except this
     * process's own connection, and the harness could not tell the difference
     * between that and an app that had died.
     *
     * (The fork's `overnight_mv_ab.mjs` solved its version of this with raw
     * `node:http`, which has no client-side header timeout at all. That works,
     * and it is still one connection held for ninety minutes: a restart, a
     * sleep, or a stray proxy kills it, and it shows no progress meanwhile.
     * Posting and polling survives all three, and the door completes and
     * records the run whether or not this process ever comes back.) */
    let d;
    try {
      d = await doorPost(appBase, {
        action: "prompt", graph: job.graph, wait: false, adopt, project,
        label, timeoutMs: deadlineMs, pollMs,
      }, { actor, timeoutMs: WATCH.DISPATCH_TIMEOUT_MS });
    } catch (e) {
      // Refused before a run even started — a bad graph, or the app not up.
      return { ...job, ok: false, secs: secsSince(), why: e.message };
    }

    const runId = d.runId ?? null;
    const promptId = d.promptId ?? null;
    if (!runId) {
      return { ...job, ok: false, promptId, secs: secsSince(),
               why: String(d.error ?? "the door accepted the job but named no runId, so there is nothing to watch") };
    }
    say(`    queued ${label ?? runId} as ${runId}`);

    const result = await awaitRun({ appBase, actor, runId, t0, deadlineMs, watchMs, graceMs, say, label });
    return finish({ job, runId, promptId, t0, ...result });
  };
}

/**
 * Watch one run through the door until it is terminal.
 *
 * TWO QUESTIONS, ASKED SEPARATELY, because the door answers them in different
 * places. `{action:"run"}` is the definitive one — it returns the run's own
 * `result`, which is the `generate` event itself, and it only exists once the
 * run is over. `{action:"status"}` is the live one: an in-flight row carries
 * `state` (`queued` | `running`), `queuedSec` and `runningSec`, which is how
 * this process learns WHEN THE ENGINE ACTUALLY STARTED the job — the instant
 * the deadline hangs off, on both sides of the door.
 *
 * ⚠ THE DEADLINE HERE IS A BACKSTOP, NOT THE DEADLINE. The door was handed
 * `timeoutMs: deadlineMs` and enforces it from the start of the render; this
 * one exists only for the case where the door itself stops answering the
 * question, and is therefore deliberately LATER (by DEADLINE_GRACE_MS) so a
 * timeout is reported by the side that can actually see the engine. A job that
 * has not started yet is not late on either side: a queued job spends none of
 * its deadline, which is the whole point of the fix this shares with
 * `server/engine/client.js`'s watch().
 */
async function awaitRun({ appBase, actor, runId, t0, deadlineMs, watchMs, graceMs, say, label }) {
  let fails = 0, cycles = 0, lostFor = 0, startedAt = null, lastState = null;

  for (;;) {
    await sleep(watchMs);
    cycles++;

    /* THE DEFINITIVE ASK. A terminal record ends the wait whatever the live
     * view says, so a run that finished while we were between polls is never
     * missed. */
    let rec;
    try {
      rec = await doorPost(appBase, { action: "run", runId }, { actor, timeoutMs: WATCH.REQUEST_TIMEOUT_MS });
      fails = 0;
    } catch (e) {
      fails++;
      say(`    ${label ?? runId}: the app did not answer (${fails}x): ${e.message}`);
      if (fails * watchMs >= WATCH.MAX_CONSECUTIVE_WATCH_FAILURES_MS) {
        return { appGone: true, why: `AIPLAY Studio stopped answering after ${((Date.now() - t0) / 1000).toFixed(0)} s `
          + `(${fails} consecutive failures, last: ${e.message}). The render may still be running; `
          + `its record is under runId ${runId}.` };
      }
      continue;
    }
    if (rec?.result) return { result: rec.result };

    /* THE LIVE ASK — every cycle until the job starts, because that instant is
     * what the deadline is measured from and it can only be caught while it is
     * happening; once a minute after that, which is enough to notice an app
     * that was restarted out from under the run. */
    if (startedAt === null || cycles % WATCH.STATUS_EVERY === 0) {
      let row;
      try {
        const s = await doorPost(appBase, { action: "status" }, { actor, timeoutMs: WATCH.REQUEST_TIMEOUT_MS });
        row = (s.running || []).find((r) => r.runId === runId) ?? null;
      } catch { row = undefined; }   // undefined = could not ask; null = asked, not there

      if (row) {
        lostFor = 0;
        if (startedAt === null && row.state === "running") {
          /* The door's own clock, mapped onto ours: it started the job
           * `queuedSec` after this dispatch. Older doors do not report the
           * split at all, and for those "the first poll that saw it running"
           * is the honest approximation. */
          startedAt = Number.isFinite(row.queuedSec) ? t0 + row.queuedSec * 1000 : Date.now();
          say(`    ${label ?? runId}: started after ${((startedAt - t0) / 1000).toFixed(1)} s of queue`);
        }
        if (row.state !== lastState) { lastState = row.state; }
      } else if (row === null) {
        /* Not in flight and no result yet. Ordinarily this is the sliver
         * between the door dropping the row and writing the completion event.
         * Sustained, it means the app was restarted and no one is watching the
         * engine any more — which must be said, not waited out for ninety
         * minutes. */
        lostFor += watchMs;
        if (lostFor >= WATCH.LOST_WINDOW_MS) {
          return { appGone: true, why: `run ${runId} is no longer in AIPLAY Studio's in-flight list and no result was `
            + `written for it after ${(lostFor / 1000).toFixed(0)} s. The app was most likely restarted mid-render; `
            + "the delegate is in its ledger, the outcome is not." };
        }
      }
    }

    /* THE BACKSTOP, in the units the door uses: time since the render STARTED,
     * never time since it was queued. Until it has started there is nothing to
     * be late for. */
    if (startedAt !== null && Date.now() - startedAt > deadlineMs + graceMs) {
      return { timedOut: true, why: `the door was given a ${(deadlineMs / 60000).toFixed(0)}-minute deadline and has `
        + `written no terminal record ${((Date.now() - startedAt) / 60000).toFixed(1)} minutes after this job started `
        + `(it queued for ${((startedAt - t0) / 1000).toFixed(0)} s first). Abandoning the wait; runId ${runId}.` };
    }
  }
}

/**
 * The terminal record, mapped onto the EXACT result shape gate_run.mjs and
 * vace_run.mjs already read: `{...job, ok, secs, why, file, promptId, runId,
 * outputs, oom, serverGone, timedOut, vanished}`. `queuedSec` and `runningSec`
 * ride along additively — a 40-minute arm that spent 12 of those waiting for
 * the arm before it is a fact worth having in the report, and neither caller
 * has to know about it to keep working.
 */
function finish({ job, runId, promptId, t0, result, appGone, timedOut, why: watchWhy }) {
  const secsSince = () => (Date.now() - t0) / 1000;
  const base = { ...job, promptId, runId };

  // The watch itself gave up: the app stopped answering, lost the run, or blew
  // through even the backstop. The engine was never heard to fail.
  if (!result) {
    return { ...base, ok: false, secs: secsSince(), why: String(watchWhy ?? "the run ended without a record"),
             serverGone: appGone === true, timedOut: timedOut === true };
  }

  const d = result;
  const secs = d.elapsedSec ?? secsSince();
  const timing = { secs, queuedSec: d.queuedSec ?? null, runningSec: d.runningSec ?? null };
  if (d.status === "completed") {
    const o = d.outputs?.[0];
    return { ...base, ok: true, ...timing, outputs: d.outputs ?? [],
             file: o ? `${o.subfolder || ""}/${o.file}` : "(no output listed)" };
  }
  const why = String(d.error ?? "");
  if (d.status === "timeout") return { ...base, ok: false, timedOut: true, ...timing, why };
  if (d.status === "vanished") return { ...base, ok: false, vanished: true, ...timing, why };
  if (d.status === "error") {
    // An OOM on the densest arm is a RESULT about this rig, not a harness failure.
    const oom = /out of memory|OutOfMemory|CUDA error|alloc/i.test(why);
    if (!oom && /ComfyUI stopped answering/i.test(why)) {
      return { ...base, ok: false, serverGone: true, ...timing, why };
    }
    return { ...base, ok: false, oom, ...timing, why };
  }
  // "rejected" — POST /prompt failed, ComfyUI rejected the job, or no
  // prompt_id came back. The door's own text for these three is byte-for-byte
  // what this loop used to produce itself (client.js ports it verbatim).
  return { ...base, ok: false, ...timing, why };
}
