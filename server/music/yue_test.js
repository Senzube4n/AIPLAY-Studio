/**
 * THE YuE2 DOOR — its refusals, its progress parser, and the two ways it can
 * lie about having finished.
 *
 * ⚠ EVERY CHECK IN HERE IS FREE. No GPU, no weights, no card, no network, and —
 * except for four ~150 ms interpreter starts that are SKIPPED LOUDLY when
 * venv-yue is absent — no python either. The whole value of refusing before
 * spend is that the refusal can be proven without spending, and the whole value
 * of a progress parser is that it can be proven against recorded output.
 *
 * ── what this suite exists for, defect by defect ────────────────────────────
 *
 *   progress shapes   THREE shapes exist, not one. A single regex requiring an
 *                     amount group silently matches NONE of the unit-less kind
 *                     ("[YuE2] Starting Loading model: elapsed 0.0s"), and the
 *                     final summary carries NO LABEL before its colon. The
 *                     literals below were produced by running progress.py's own
 *                     writer against a non-TTY stream on 2026-09-11 — they are
 *                     recordings, not guesses, and `--selftest progress` drives
 *                     the vendor's writer again live when the venv is here.
 *   no denominator    pipeline.py:237 opens BOTH autoregressive stages with
 *                     unit="tokens" and NO total, so the two stages worth 70%+
 *                     of the wall time publish no percentage. The derived one
 *                     has to say it is derived.
 *   vram              otherwise: a CUDA out-of-memory two minutes in, at
 *                     nar.py:95, on a card the owner's engine is living on.
 *                     And the gate's floor comes from the MEASURED 10.6 GiB
 *                     peak, not the vendor's 24 GiB, which this card does not
 *                     have and the successful render did not need.
 *   no-audio-input    otherwise: a finished song that ignored the reference,
 *                     which listens like a bad model and is really a silently
 *                     dropped argument. YuE2 has no such argument at all.
 *   tree-kill         otherwise: a plain stop left a python child rendering,
 *                     which contaminated every timing by 3.3x-10.8x and
 *                     presented as a slow render rather than a stuck one.
 *   missing output    THE EXPENSIVE ONE. save_artifacts is a method on the
 *                     RESULT (pipeline.py:103); a hasattr guard on the PIPELINE
 *                     was false, the save was skipped, and the process exited 0
 *                     — discarding a finished 35-minute render and reporting
 *                     success. A zero-byte or absent audio.flac must be a
 *                     FAILURE here, on both sides of the door.
 *
 * ⚠ AND IT DRIVES THE SUBPROCESS DOOR, which the mesh suite does not. That
 * suite opens by promising every check is free and therefore never calls
 * runMeshCli() at all, so its timeout, tree-kill and exit-code branches have no
 * test. `runYueDriver()` takes `spawnFn` and `killTree` as seams for exactly
 * that reason, and the production default is asserted to BE the mesh door's own
 * hardened function rather than a copy of it.
 *
 * Runs standalone (`node server/music/yue_test.js`) and in the pre-commit hook.
 */
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { mkdir, writeFile, rm, readFile, stat } from "node:fs/promises";
import {
  YUE, YueRefusal, yueStatus, refuse, refuseVram, refuseAudioInput, refuseLyrics, refuseRequest,
  parseProgressLine, createProgressReader, assumedTokenTotal, readTokenCaps,
  PROGRESS_RE, PROGRESS_PREFIXES, STAGES, STAGE_ORDER, TOKEN_CAPS, TOKENS_PER_AUDIO_SECOND,
  PEAK_GIB, HEADROOM_GIB, VRAM_MIN_GIB, DERIVED_MIN_GIB, VENDOR_RECOMMENDED_GIB, vramFloorGib,
  vramCardGib, PIPELINE_RESERVE_GIB,
  verifyArtifacts, ARTIFACTS, hoistPythonError, explainExit, PY_ERROR_RE,
  runYueDriver, killYueProcessTree, renderSong, DRIVER, DRIVER_ENV, THIRD_DOOR,
  YUE_MODEL, YUE_CAP, YUE2_RIGHTS, YUE2_LICENCE_READ, catalogueRights, weightFiles,
} from "./yue.js";
import { killMeshProcessTree } from "../mesh/runner.js";
import { CATALOG, MODEL_TO_CAPABILITY } from "../models.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
/** Run `fn` and return what it threw, or null. */
async function refusal(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

const dir = path.join(os.tmpdir(), `aiplay-yue-${Date.now().toString(36)}`);
await mkdir(dir, { recursive: true });

/* ═══════════════════════════════════════════════════════════════════════════
 * THE RECORDED LINES. Every one of these was written by yue2/progress.py with a
 * non-TTY stream on 2026-09-11, with the stage labels pipeline.py really uses.
 * They are the test's ground truth and must not be tidied.
 * ═══════════════════════════════════════════════════════════════════════════ */
const LINES = {
  /* SHAPE 1 — no unit, no total, NO " | " AT ALL. The one a regex demanding an
   * amount group silently drops, which is the whole reason for this section. */
  startNoUnit:  "[YuE2] Starting Loading model: elapsed 0.0s",
  doneNoUnit:   "[YuE2] Completed Loading model: elapsed 0.0s",
  scoreSupplied:"[YuE2] Starting Using provided score: elapsed 0.0s",
  /* SHAPE 2 — an amount, sometimes a total, a rate only when unit == tokens. */
  startTokens:  "[YuE2] Starting Generating song: 0 tokens | 0.0 tokens/s | elapsed 0.0s",
  runTokens:    "[YuE2] Running Generating song: 4177 tokens | 14.9 tokens/s | elapsed 281.0s",
  doneTokens:   "[YuE2] Completed Generating song: 4177 tokens | 14.9 tokens/s | elapsed 281.0s",
  startSteps:   "[YuE2] Starting Synthesizing audio: 0 steps | elapsed 0.0s",
  runSteps:     "[YuE2] Running Synthesizing audio: 7/32 steps (22%) | elapsed 12.0s",
  runChunks:    "[YuE2] Running Decoding audio: 1/3 chunks (33%) | elapsed 0.9s",
  failChunks:   "[YuE2] Failed Decoding audio: 1/3 chunks (33%) | elapsed 0.9s",
  truncStage:   "[YuE2] Finished (generation limit reached) Planning score: 4096 tokens | 13.1 tokens/s | elapsed 312.0s",
  /* SHAPE 3 — the summary. NO LABEL before the colon, which is the only thing
   * that tells it from a finished stage: both start with the same word. */
  summary:      "[YuE2] Completed: 167.0s audio in 399.6s",
  summaryTrunc: "[YuE2] Finished (generation limit reached): 167.0s audio in 399.6s",
  /* NOT PROGRESS, and must parse as nothing rather than as something. fast.py
   * print()s the first of these; the driver writes the second. */
  flashNotice:  "[YuE2] Flash Attention failed; retrying with backend=torch-eager",
  driverEvent:  'YUE_EVENT:{"event":"loaded","seconds":6.6}',
};

console.log("\nTHE PROGRESS PARSER — three shapes, not one");
{
  const e = parseProgressLine(LINES.startNoUnit);
  ok("SHAPE 1 parses: a unit-less line with no amount and no ` | `", e !== null, LINES.startNoUnit);
  ok("...as the `load` stage", e?.stage === "load" && e?.label === "Loading model", JSON.stringify(e));
  ok("...with status `starting`", e?.status === "starting", e?.status);
  ok("...and its elapsed, which is the whole suffix here", e?.elapsedSec === 0, String(e?.elapsedSec));
  ok("...and NO amount and NO unit — null, not zero, because there is nothing to count",
    e?.completed === null && e?.unit === null && e?.total === null, JSON.stringify(e));
}
{
  /* THE TRAP, STATED AS AN ASSERTION. This is the regex the task warns about:
   * one that requires an amount group matches none of shape 1. */
  const naive = /^\[YuE2\] (\w+) (.+?): (\d+)(?:\/(\d+))? (\S+)/;
  ok("a single regex demanding an amount matches NONE of shape 1 — the defect this pins",
    naive.test(LINES.startNoUnit) === false && naive.test(LINES.doneNoUnit) === false);
  ok("...while the shipped one matches every recorded line",
    Object.entries(LINES).filter(([k]) => !["flashNotice", "driverEvent"].includes(k))
      .every(([, l]) => PROGRESS_RE.test(l)),
    Object.entries(LINES).filter(([k, l]) => !["flashNotice", "driverEvent"].includes(k)
      && !PROGRESS_RE.test(l)).map(([k]) => k).join(", "));
}
{
  const e = parseProgressLine(LINES.runTokens);
  ok("SHAPE 2 parses an amount with no total", e?.completed === 4177 && e?.total === null,
    JSON.stringify(e));
  ok("...its unit", e?.unit === "tokens", e?.unit);
  ok("...its rate, which only the token stages carry", e?.rate === 14.9, String(e?.rate));
  ok("...its elapsed", e?.elapsedSec === 281, String(e?.elapsedSec));
  ok("...and the measured figures round-trip (4177 tokens, 14.87 tok/s, 281.0 s)",
    e.completed === 4177 && Math.abs(e.rate - 14.87) < 0.1 && e.elapsedSec === 281.0);
}
{
  const e = parseProgressLine(LINES.runSteps);
  ok("SHAPE 2 parses a REPORTED total", e?.completed === 7 && e?.total === 32, JSON.stringify(e));
  ok("...with the right unit", e?.unit === "steps", e?.unit);
  const c = parseProgressLine(LINES.runChunks);
  ok("...and the VAE's unit is `chunks`, which is what pipeline.py:341 passes",
    c?.unit === "chunks" && c?.total === 3, JSON.stringify(c));
  const s = parseProgressLine(LINES.startSteps);
  ok("...and a total DISCOVERED AT RUN TIME is absent on the stage's first line",
    s?.total === null && s?.completed === 0, JSON.stringify(s));
}
{
  const e = parseProgressLine(LINES.summary);
  ok("SHAPE 3 parses: the summary has no label before the colon", e?.kind === "summary",
    JSON.stringify(e));
  ok("...and carries the audio length and the wall time", e?.audioSeconds === 167 && e?.elapsedSec === 399.6,
    JSON.stringify(e));
  ok("...and is NOT mistaken for a finished stage", e?.stage === undefined && e?.label === undefined);
  const t = parseProgressLine(LINES.summaryTrunc);
  ok("...and the truncated summary is recognised as truncated, not as a new stage",
    t?.kind === "summary" && t?.truncated === true, JSON.stringify(t));
}
{
  const e = parseProgressLine(LINES.truncStage);
  ok("the six-word status prefix parses as one prefix, not as part of the label",
    e?.status === "truncated" && e?.label === "Planning score", JSON.stringify(e));
  ok("...and every prefix progress.py can print is in the table",
    Object.keys(PROGRESS_PREFIXES).length === 6
      && PROGRESS_PREFIXES["Finished (generation limit reached)"] === "truncated",
    Object.keys(PROGRESS_PREFIXES).join(" | "));
  ok("Failed is a status, and a failed stage still parses",
    parseProgressLine(LINES.failChunks)?.status === "failed");
}
{
  ok("a library's own notice on the same prefix parses as NOTHING",
    parseProgressLine(LINES.flashNotice) === null, LINES.flashNotice);
  ok("...and so does a driver event line", parseProgressLine(LINES.driverEvent) === null);
  ok("...and so does an interleaved half-line, which a thread can really produce",
    parseProgressLine("[YuE2] Running Generating so") === null);
  ok("...and so does an empty line", parseProgressLine("") === null);
}
{
  /* EVERY LABEL pipeline.py can open is in the table, or the stage reports as
   * `other` and the overall fraction quietly loses a stage's worth of budget. */
  ok("all nine stage labels are mapped", Object.keys(STAGES).length === 9,
    Object.keys(STAGES).join(" | "));
  ok("...and every mapped key appears in STAGE_ORDER",
    Object.values(STAGES).every((s) => STAGE_ORDER.includes(s.key)),
    STAGE_ORDER.join(","));
  ok("...an unknown label is `other` rather than a crash",
    parseProgressLine("[YuE2] Running Polishing the brass: elapsed 1.0s")?.stage === "other");
}

console.log("\nTHE DENOMINATOR THE TWO LONG STAGES DO NOT HAVE");
{
  const caps = await readTokenCaps();
  ok("the token caps are read from the checkpoint when it is here, else fall back",
    caps.abc > 0 && caps.semantic > 0, JSON.stringify(caps));
  if (caps.read) {
    ok("...and this machine's yue2_generation_config.json says abc 4096 / semantic 9000",
      caps.abc === 4096 && caps.semantic === 9000, JSON.stringify(caps));
    ok("...which is what the fallback constant claims, so the two cannot drift",
      caps.abc === TOKEN_CAPS.abc && caps.semantic === TOKEN_CAPS.semantic);
  } else {
    console.log("  --    the checkpoint is not on this machine, so the caps came from the");
    console.log("        measured fallback. That is the branch under test on a fresh box.");
    ok("...the fallback is the measured pair", TOKEN_CAPS.abc === 4096 && TOKEN_CAPS.semantic === 9000);
  }
}
{
  const a = assumedTokenTotal("semantic", {});
  ok("with no target length the semantic denominator is the CAP", a.total === 9000 && a.basis === "cap",
    JSON.stringify(a));
  ok("...and it is labelled an assumption", a.assumed === true);
  ok("...and the note says a cap is a ceiling rather than a target",
    /ceiling, not a target|not a progress target/.test(a.note || ""), a.note);
  const b = assumedTokenTotal("semantic", { audioSeconds: 167.0 });
  ok("with a target length it is the measured rate instead",
    b.basis === "measured-rate" && b.total === Math.round(TOKENS_PER_AUDIO_SECOND * 167),
    JSON.stringify(b));
  ok("...and 167 s of target reproduces the measured 4177 tokens to within 1%",
    Math.abs(b.total - 4177) / 4177 < 0.01, `${b.total} vs 4177`);
  ok("...and it is STILL an assumption, because YuE2 has no duration argument",
    b.assumed === true && /no duration argument/.test(b.note || ""), b.note);
  const c = assumedTokenTotal("plan", {});
  ok("the ABC stage's denominator is its own cap", c.total === 4096 && c.basis === "cap");
  const d = assumedTokenTotal("nar", {});
  ok("a stage that reports a real total gets no assumption at all",
    d.total === null && d.basis === "none" && d.assumed === false, JSON.stringify(d));
}
{
  /* THE READER, over one real run's worth of lines. */
  const seen = [];
  const r = createProgressReader({ onEvent: (ev) => seen.push(ev) });
  for (const k of ["startNoUnit", "doneNoUnit", "scoreSupplied", "startTokens", "runTokens",
                   "doneTokens", "startSteps", "runSteps", "runChunks", "summary"]) {
    r.line(LINES[k]);
  }
  const semantic = seen.find((e) => e.stage === "semantic" && e.status === "running");
  ok("the semantic stage gets a fraction from the assumed total",
    Math.abs(semantic.fraction - 4177 / 9000) < 1e-9, String(semantic.fraction));
  ok("...and it says so: assumed true, basis cap",
    semantic.assumed === true && semantic.basis === "cap", JSON.stringify({
      assumed: semantic.assumed, basis: semantic.basis }));
  const nar = seen.find((e) => e.stage === "nar" && e.status === "running");
  ok("the synthesize stage's fraction is NOT assumed — it reported 7/32",
    nar.assumed === false && nar.basis === "reported" && Math.abs(nar.fraction - 7 / 32) < 1e-9,
    JSON.stringify({ assumed: nar.assumed, basis: nar.basis, fraction: nar.fraction }));
  const vae = seen.find((e) => e.stage === "vae");
  ok("...and so is the decode stage's", vae.basis === "reported" && vae.assumed === false);
  const load = seen.find((e) => e.stage === "load" && e.status === "starting");
  ok("a stage with nothing to count has fraction null, not 0",
    load.fraction === null, String(load.fraction));
  ok("overall rises across the run — semantic below nar below the summary",
    semantic.overall < nar.overall && nar.overall < 1,
    JSON.stringify({ semantic: semantic.overall, nar: nar.overall }));
  ok("...and overall is weighted by the MEASURED stage times, so the semantic stage is most of it",
    seen.find((e) => e.stage === "semantic" && e.status === "completed").overall > 0.6,
    String(seen.find((e) => e.stage === "semantic" && e.status === "completed")?.overall));
  ok("the summary reports overall 1 and no assumption",
    seen.at(-1).kind === "summary" && seen.at(-1).overall === 1);
  ok("an ETA is offered only once a fraction exists",
    load.etaSeconds === null && Number.isFinite(semantic.etaSeconds),
    JSON.stringify({ load: load.etaSeconds, semantic: semantic.etaSeconds }));
}
{
  /* THE PLANNING STAGE IS THE ONE NUMBER FROM A DIFFERENT RUN, so an overall
   * fraction that includes it has to admit it. */
  const seen = [];
  const r = createProgressReader({ onEvent: (ev) => seen.push(ev) });
  r.line("[YuE2] Running Planning score: 1000 tokens | 13.0 tokens/s | elapsed 76.0s");
  ok("a run that plans its own score marks overall as assumed",
    seen.at(-1).overallAssumed === true, JSON.stringify(seen.at(-1)));
  const seen2 = [];
  const r2 = createProgressReader({ onEvent: (ev) => seen2.push(ev) });
  r2.line(LINES.runSteps);
  ok("...and one that supplied a score does not, on a stage with a real total",
    seen2.at(-1).overallAssumed === false, JSON.stringify(seen2.at(-1)));
}
{
  /* CHUNK BOUNDARIES. stderr arrives in arbitrary pieces; a line split across
   * two reads must still land exactly once. */
  const seen = [];
  const r = createProgressReader({ onEvent: (ev) => seen.push(ev) });
  r.push("[YuE2] Running Generating song: 4177 tok");
  ok("half a line emits nothing", seen.length === 0);
  r.push("ens | 14.9 tokens/s | elapsed 281.0s\n[YuE2] Compl");
  ok("...the rest of it emits exactly one event", seen.length === 1, JSON.stringify(seen));
  r.push("eted: 167.0s audio in 399.6s\n");
  ok("...and the line that spanned two chunks parses whole",
    seen.length === 2 && seen[1].kind === "summary", JSON.stringify(seen[1]));
  r.push("[YuE2] Running Decoding audio: 2/3 chunks (66%) | elapsed 1.2s");
  r.end();
  ok("end() flushes a trailing line with no newline — a killed python's last line",
    seen.length === 3 && seen[2].stage === "vae", JSON.stringify(seen.at(-1)));
}
{
  /* THE DRIVER'S OWN EVENTS, and that a malformed one cannot throw. */
  const seen = [];
  const r = createProgressReader({ onEvent: (ev) => seen.push(ev) });
  r.line(LINES.driverEvent);
  ok("a driver event is reported as kind `driver`",
    seen.length === 1 && seen[0].kind === "driver" && seen[0].event === "loaded",
    JSON.stringify(seen[0]));
  r.line('YUE_EVENT:{"event":"trun');
  ok("...and a half-written one is ignored rather than thrown", seen.length === 1);
}

console.log("\nREFUSAL — the card, with the floor derived from the measurement");
{
  ok("the floor comes from the MEASURED peak, not the vendor's recommendation",
    VRAM_MIN_GIB > PEAK_GIB && VRAM_MIN_GIB < VENDOR_RECOMMENDED_GIB,
    `peak ${PEAK_GIB} < floor ${VRAM_MIN_GIB} < vendor ${VENDOR_RECOMMENDED_GIB}`);
  ok("...and the vendor's 24 GiB is above what this card has, which is why it is not the gate",
    VENDOR_RECOMMENDED_GIB > 15.99);

  /* ⚠ TWO NUMBERS BECAUSE THERE ARE TWO QUESTIONS, and what is guarded is the
   * RELATION between them, not their equality.
   *
   * This suite used to assert the gate's floor WAS the catalogue's, which was
   * right while the row meant "the smallest card above the measured peak" (12).
   * The row was corrected to 16 on 2026-09-11 because the runtime reserves
   * 2 GiB off the top whatever budget it is handed (pipeline.py:162), so a
   * 12 GiB card leaves 10 GiB against a 10.6 GiB peak and cannot run this at
   * all. But a CARD SIZE is not an amount of FREE memory, and demanding 16 GiB
   * free made the gate unsatisfiable on the only machine that has rendered here:
   * it refused at 14.0 GiB free, waiting for 2.0 GiB that a card with a desktop
   * on it will never have.
   *
   * So the gate is the derivation, the row is the purchase, and the invariant is
   * that the card promised can hold the floor plus the reserve. Equality would
   * now be the bug. */
  const floor = vramFloorGib();
  const row = CATALOG.find((c) => c.id === YUE_CAP);
  ok("the gate's floor is this file's derivation, and says where it came from",
    floor.gib === DERIVED_MIN_GIB && /yue\.js/.test(floor.from),
    `${floor.gib} from ${floor.from}`);
  ok("...and it is the measured peak plus the labelled headroom, not a round number",
    DERIVED_MIN_GIB === Number((PEAK_GIB + HEADROOM_GIB).toFixed(2)),
    `${PEAK_GIB} + ${HEADROOM_GIB} = ${DERIVED_MIN_GIB}`);
  if (row) {
    ok("...and the CARD the catalogue asks for holds that floor plus the runtime's own reserve",
      vramCardGib() >= DERIVED_MIN_GIB + PIPELINE_RESERVE_GIB,
      `card ${vramCardGib()} vs floor ${DERIVED_MIN_GIB} + reserve ${PIPELINE_RESERVE_GIB}`);
    ok("...and it is still above the MEASURED peak, which is the only unsafe way it can move",
      row.requires.vramMinGb > PEAK_GIB, `${row.requires.vramMinGb} vs peak ${PEAK_GIB}`);
    /* THE ONE THAT WOULD HAVE CAUGHT IT. A gate the named card cannot clear is a
     * feature that refuses itself on the hardware the Models screen sold. */
    ok("...and a machine holding exactly that card can actually clear the gate",
      vramCardGib() - PIPELINE_RESERVE_GIB >= DERIVED_MIN_GIB,
      `${vramCardGib()} - ${PIPELINE_RESERVE_GIB} >= ${DERIVED_MIN_GIB}`);
  }

  const e = await refusal(() => refuseVram({ free: 7 * 1024 }));
  ok("7 GiB free is refused", e?.refusal === "vram", String(e));
  ok("...saying WHAT IT IS WAITING FOR, with the numbers",
    e.message.startsWith(`Waiting for ${floor.gib} GiB`) && /7\.0 GiB is free/.test(e.message),
    e.message);
  ok("...and naming which file the floor came from, so it can be argued with",
    e.message.includes(floor.from) && e.floorFrom === floor.from, e.floorFrom);
  ok("...and where the figure came from", /peaked at 10\.6 GiB of 15\.99/.test(e.message));
  ok("...and that the vendor's figure is recorded and not used",
    /vendor recommends 24 GB/.test(e.message) && /not the gate/.test(e.message));
  ok("...and it NAMES THE ENGINE as the thing holding the card",
    /music and video engine is resident/.test(e.message));
  ok("...and promises not to evict it", /Nothing here will evict it/.test(e.message));
  ok("...and says this is a refusal rather than an OOM later, at the line it would hit",
    /out-of-memory/.test(e.message) && /nar\.py:95/.test(e.message));
  ok("...and carries the numbers as fields, not only as prose",
    e.freeMb === 7168 && e.needGib === floor.gib && /GiB more/.test(e.waitingFor || ""),
    JSON.stringify({ free: e.freeMb, need: e.needGib, waiting: e.waitingFor }));
}
{
  const r = await refuseVram({ free: 14 * 1024 });
  ok("14 GiB free passes", r.free === 14336 && r.waitingFor === null, JSON.stringify(r));
}
{
  /* ⚠ NO READING IS NOT A REFUSAL. An AMD card, no discrete GPU, a driver
   * mid-update — none is evidence of a full card, and refusing on absent
   * evidence blocks the first machine that is merely unusual. The reading is
   * supplied BY PRESENCE so this branch is reachable at all. */
  const r = await refuseVram({ free: null }).catch((e) => e);
  ok("a machine with no readable card is NOT refused",
    !(r instanceof Error) && r.free === null, String(r?.message || JSON.stringify(r)));
}

console.log("\nREFUSAL — an audio reference, which YuE2 has nowhere to put");
{
  const e = await refusal(() => refuseAudioInput({ style: "s", lyrics: "l", reference_id: "abc" }));
  ok("the Studio's own reference_id is refused", e?.refusal === "no-audio-input", String(e));
  ok("...naming the key that cannot be honoured", e.keys.includes("reference_id"), JSON.stringify(e.keys));
  ok("...and saying there are seven fields and no eighth",
    /seven fields and no eighth/.test(e.message), e.message);
  ok("...and citing the vendor's own sentence rather than only ours",
    /exposes no .*audio-reference/.test(e.message));
  ok("...and offering the thing that DOES work: a score, not a recording",
    /abc.*melody|melody.*abc/is.test(e.message) && /notation|NOTATION/.test(e.message));
  ok("...and saying why it is refused rather than dropped",
    /sounds like a bad model and is really a missing argument/.test(e.message));
}
{
  const e = await refusal(() => refuseAudioInput({ mode: "external_audio_continuation" }));
  ok("the MiniMax continuation mode is refused by name", e?.refusal === "no-audio-input",
    String(e?.refusal));
  const clean = await refusal(() => refuseAudioInput({ style: "s", lyrics: "l", abc: "X:1" }));
  ok("a request with a SCORE is not refused — notation is not audio", clean === null, String(clean));
  const falsey = await refusal(() => refuseAudioInput({ style: "s", lyrics: "l", audio: null }));
  ok("...and an explicitly empty reference key is not a reference", falsey === null, String(falsey));
}

console.log("\nSECTION TAGS — YuE2's own lyric format, never refused");
{
  const e = await refusal(() => refuseLyrics("[Verse]\nrain on the lane\n\n[Chorus]\nlook up"));
  ok("[Verse] / [Chorus] lyrics are accepted", e === null, String(e));
  const r = refuseLyrics("[Verse]\nrain on the lane\n\n[Chorus]\nlook up");
  ok("...and the labels are still reported", r.labels.join(",") === "[Verse],[Chorus]", JSON.stringify(r.labels));
}
{
  const r = refuseLyrics("[Verse]\nwords", { allowSectionLabels: true });
  ok("the flag lets the vendor's shape through, and records that it was used",
    r.allowed === true && r.labels.length === 1, JSON.stringify(r));
  const clean = await refusal(() => refuseLyrics(
    "Docking lights. A hundred years of rain.\n\nPut your hand up. I'll put mine there."));
  ok("the lyrics of the one render that worked here pass untouched", clean === null, String(clean));
  ok("a CJK section marker is accepted too — PYTHONUTF8 means it survives the trip",
    (await refusal(() => refuseLyrics("【副歌】\n words"))) === null);
  ok("a bracket INSIDE a line is not a section label",
    (await refusal(() => refuseLyrics("she said [softly] come home"))) === null);
}

console.log("\nREFUSAL — a request the pipeline would reject 20 seconds later");
{
  const e = await refusal(() => refuseRequest({ lyrics: "words" }));
  ok("no style is refused here rather than in python", e?.refusal === "request", String(e));
  ok("...with the pipeline's own sentence quoted", /Provide style and lyrics/.test(e.message));
  ok("...and the SongRequest trap recorded: fields, never an assembled object",
    /builds the SongRequest itself/.test(e.message) && /style slot/.test(e.message), e.message);
  ok("no lyrics is refused", (await refusal(() => refuseRequest({ style: "pop" })))?.refusal === "request");
  ok("a blank style is refused, not just a missing one",
    (await refusal(() => refuseRequest({ style: "   ", lyrics: "w" })))?.refusal === "request");
}
{
  ok("an unknown cot is refused",
    (await refusal(() => refuseRequest({ style: "s", lyrics: "l", cot: "verse" })))?.refusal === "request");
  ok("a non-integer seed is refused",
    (await refusal(() => refuseRequest({ style: "s", lyrics: "l", seed: 1.5 })))?.refusal === "request");
  ok("a cfg_scale outside [0,20] is refused",
    (await refusal(() => refuseRequest({ style: "s", lyrics: "l", cfg_scale: 25 })))?.refusal === "request");
  const badId = await refusal(() => refuseRequest({ style: "s", lyrics: "l", id: "../escape" }));
  ok("an id that is not filename-safe is refused — it becomes a folder name",
    badId?.refusal === "request" && /folder name/.test(badId.message), badId?.message);
  ok("a score with cot off is refused — there is nothing for it to be",
    (await refusal(() => refuseRequest({ style: "s", lyrics: "l", cot: "off", abc: "X:1" })))?.refusal === "request");
  ok("an ordinary request passes",
    (await refusal(() => refuseRequest({ style: "pop", lyrics: "words", cot: "full", seed: 831001 }))) === null);
  /* ⚠ ONE NAME FOR ONE FIELD. The vendor takes `tags` as an alias for `style`
   * and raises when both disagree; an adapter, a JSON file and a driver that
   * each resolve that ambiguity separately is three chances to resolve it
   * differently. Refused with a rename, which is one edit for the caller. */
  const tags = await refusal(() => refuseRequest({ tags: "pop", lyrics: "words" }));
  ok("the vendor's `tags` alias is refused by name rather than quietly resolved",
    tags?.refusal === "request" && /alias for `style`/i.test(tags.message), tags?.message);
  ok("...and it is not reported as \"no style\", which would be true and unhelpful",
    !/needs both a style and lyrics/.test(tags?.message || ""), tags?.message);
  const tagsAtDoor = await refusal(() => renderSong({
    tags: "pop", lyrics: "words", out: path.join(dir, "z"), via: "test.dry", dryRun: true }));
  ok("...and the same sentence arrives when it is handed to renderSong",
    /alias for `style`/i.test(tagsAtDoor?.message || ""), tagsAtDoor?.refusal);
}

console.log("\nWHAT LANDED ON THE DISK — the 35-minute loss, on this side of the door");
{
  const empty = path.join(dir, "empty-run");
  await mkdir(empty, { recursive: true });
  const v = await verifyArtifacts(empty);
  ok("an EMPTY output directory is a failure, not a success", v.ok === false, JSON.stringify(v.why));
  ok("...naming audio.flac as the thing that was not written",
    v.why.some((w) => /audio\.flac is not in/.test(w)), v.why.join(" | "));
  ok("...and saying what that looks like from out here",
    v.why.some((w) => /save_artifacts\(\) call that never happened/.test(w)), v.why.join(" | "));
  ok("...and result.json's absence is its own sentence, because it is the receipt",
    v.why.some((w) => /result\.json could not be read/.test(w)), v.why.join(" | "));
  ok("...and every expected artifact is listed as missing",
    v.missing.length === ARTIFACTS.length && v.audio.bytes === null, JSON.stringify(v.missing));
}
{
  const zero = path.join(dir, "zero-run");
  await mkdir(zero, { recursive: true });
  await writeFile(path.join(zero, "audio.flac"), "");
  await writeFile(path.join(zero, "result.json"), JSON.stringify({ status: "complete" }));
  const v = await verifyArtifacts(zero);
  ok("a ZERO-BYTE audio.flac is a failure", v.ok === false, JSON.stringify(v.why));
  ok("...called out as zero bytes rather than as missing, because the causes differ",
    v.why.some((w) => /zero bytes/.test(w)), v.why.join(" | "));
  ok("...and the interrupted-decode cause is named",
    v.why.some((w) => /interrupted VAE decode/.test(w)), v.why.join(" | "));
}
{
  const good = path.join(dir, "good-run");
  await mkdir(good, { recursive: true });
  const audio = Buffer.from("fLaC" + "x".repeat(1000));
  await writeFile(path.join(good, "audio.flac"), audio);
  const { createHash } = await import("node:crypto");
  const sha = createHash("sha256").update(audio).digest("hex");
  await writeFile(path.join(good, "result.json"), JSON.stringify({
    status: "complete", audio_seconds: 167.0386, sample_rate: 48000,
    artifacts: { "audio.flac": { sha256: sha, bytes: audio.length } },
  }));
  const v = await verifyArtifacts(good);
  ok("audio plus a receipt that agrees is a pass", v.ok === true, JSON.stringify(v.why));
  ok("...and the duration and sample rate come off the receipt",
    Math.round(v.audioSeconds) === 167 && v.sampleRate === 48000, JSON.stringify(v));
  ok("...and the hash is verified INDEPENDENTLY of the receipt's claim",
    v.sha256Agrees === true && v.sha256 === sha, `${v.sha256Agrees} ${v.sha256?.slice(0, 12)}`);
}
{
  const lying = path.join(dir, "lying-run");
  await mkdir(lying, { recursive: true });
  await writeFile(path.join(lying, "audio.flac"), "short");
  await writeFile(path.join(lying, "result.json"), JSON.stringify({
    status: "complete", artifacts: { "audio.flac": { sha256: "0".repeat(64), bytes: 33549285 } },
  }));
  const v = await verifyArtifacts(lying);
  ok("a receipt that claims more bytes than the disk holds is a failure", v.ok === false);
  ok("...and the disagreement is stated with both numbers",
    v.why.some((w) => /claims audio\.flac is 33549285 bytes and the file on disk is 5/.test(w)),
    v.why.join(" | "));
}
{
  const notComplete = path.join(dir, "incomplete-run");
  await mkdir(notComplete, { recursive: true });
  await writeFile(path.join(notComplete, "audio.flac"), "fLaC");
  await writeFile(path.join(notComplete, "result.json"), JSON.stringify({ status: "failed" }));
  const v = await verifyArtifacts(notComplete, { verifyHash: false });
  ok("a receipt that does not say `complete` is a failure even with audio present",
    v.ok === false && v.why.some((w) => /not "complete"/.test(w)), v.why.join(" | "));
}

console.log("\nTHE EXIT-CODE VOCABULARY, AND THE TRACEBACK HOIST");
{
  const tb = [
    "Traceback (most recent call last):",
    '  File "yue_driver.py", line 390, in render',
    "    result = pipe(style=..., lyrics=...)",
    '  File "yue2\\nar.py", line 95, in _prefill',
    "torch.OutOfMemoryError: Tried to allocate 3.86 GiB. GPU 0 has a total capacity of 15.99 GiB",
    "of which 7.04 GiB is free.",
  ].join("\n");
  const h = hoistPythonError(tb);
  ok("the exception line is hoisted to the front — a python traceback buries it last",
    h.startsWith("torch.OutOfMemoryError: Tried to allocate 3.86 GiB"), h.split("\n")[0]);
  ok("...with everything FROM it to the end, because the message is often several lines",
    h.split("\n\n")[0].includes("7.04 GiB is free"), h.split("\n\n")[0]);
  ok("...and the whole traceback is kept underneath for whoever wants it",
    h.includes("Traceback (most recent call last):"));
  ok("text with no exception line is returned untouched",
    hoistPythonError("just some words") === "just some words");
}
{
  ok("exit 2 is a REFUSAL", /refused this render/.test(explainExit(2, "REFUSED: no")));
  ok("exit 3 is a FAILURE", /render failed/.test(explainExit(3, "boom")));
  ok("⚠ exit 0 with no answer is NOT a success, and the headline says so",
    /finished without answering/.test(explainExit(0, "Traceback…")),
    explainExit(0, "Traceback…"));
  ok("...which is the shape of the defect that discarded a 35-minute render",
    explainExit(0, "x") !== explainExit(3, "x"));
  ok("an unexpected code names itself", /exited 9/.test(explainExit(9, "?")));
}
{
  /* ⚠ THE DRIFT GUARD. This regex now exists in three places —
   * server/mv/blender.js, server/mesh/runner.js, and here as a function because
   * neither of those exports it. Two copies of a hardened thing decay into one
   * hardened thing and one that looks like it; three is worse. Until the
   * consolidation is applied, this lane fails the moment they
   * stop being the same expression. */
  const literal = String(PY_ERROR_RE);
  for (const rel of ["../mesh/runner.js", "../mv/blender.js"]) {
    const src = await readFile(new URL(rel, import.meta.url), "utf8");
    const m = src.match(/findLastIndex\(\(l\) => (\/[^\n]*?\/)\.test\(l\)\)/);
    ok(`${rel} still hoists with the identical regex`, m?.[1] === literal,
      `${rel}: ${m?.[1] || "(no hoist found — was it consolidated? then delete this lane)"} vs ${literal}`);
  }
}

console.log("\nTHE TREE-KILL — the same function, not a second copy");
{
  /* ⚠ IDENTITY, NOT EQUIVALENCE. Asserting that two implementations behave
   * alike is the assertion that keeps passing while one of them rots. This
   * asserts there is only one. */
  ok("killYueProcessTree IS server/mesh/runner.js's killMeshProcessTree",
    killYueProcessTree === killMeshProcessTree);
  ok("...and it is the taskkill /PID /T /F path, which is why it is borrowed",
    /taskkill/.test(String(killMeshProcessTree)) && /\/T/.test(String(killMeshProcessTree)));
  ok("a process with no pid is answered false WITHOUT spawning anything",
    (await killYueProcessTree({})) === false);
  ok("...and so is pid 0, which on POSIX would signal the whole process group",
    (await killYueProcessTree({ pid: 0 })) === false);
  ok("...and a negative pid", (await killYueProcessTree({ pid: -1 })) === false);
}

console.log("\nTHE SUBPROCESS DOOR, driven — what the mesh suite never tests");
/** A child process that never runs. stdout/stderr are emitters; `pid` is real
 *  enough for the kill path to be asked about. */
function fakeProc(pid = 424242) {
  const p = new EventEmitter();
  p.pid = pid; p.exitCode = null;
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  return p;
}
{
  let captured = null;
  const proc = fakeProc();
  const spawnFn = (py, argv, opts) => { captured = { py, argv, opts }; return proc; };
  const answered = runYueDriver(["--request", "r.json", "--out", "o"], { spawnFn });
  /* The vendor's own stdout notice lands on the SAME line as the result object
   * in the measured Blender case, so the parse is brace-matched rather than
   * line-based. Reproduced here exactly. */
  proc.stdout.emit("data", "[YuE2] Pipeline backend='torch-eager'\n");
  proc.stdout.emit("data", 'YUE_RESULT_JSON:{"ok":true,"audioSeconds":167.04,"artifacts":{"audio.flac":33549285}}');
  proc.stdout.emit("data", "[YuE2] done\n");
  proc.emit("close", 0);
  const r = await answered;
  ok("a result line is read even with the library's banner glued to its tail",
    r.ok === true && r.audioSeconds === 167.04, JSON.stringify(r));
  ok("the driver is spawned with -u so its progress is not buffered away",
    captured.argv[0] === "-u" && captured.argv[1] === DRIVER, JSON.stringify(captured.argv));
  ok("...with windowsHide", captured.opts.windowsHide === true);
  ok("...and cwd in the temp directory, not the repo — the package writes runs/ relative to cwd",
    captured.opts.cwd === os.tmpdir(), captured.opts.cwd);
  ok("...and detached only off Windows, which is what makes kill(-pid) legal there",
    captured.opts.detached === (process.platform !== "win32"));
  for (const [k, v] of Object.entries(DRIVER_ENV)) {
    ok(`...and ${k}=${v} is in the environment BEFORE the interpreter starts`,
      captured.opts.env[k] === v, String(captured.opts.env[k]));
  }
  ok("...four of them, no more and no fewer — the set the community node contributed",
    Object.keys(DRIVER_ENV).length === 4, Object.keys(DRIVER_ENV).join(","));
  ok("...and the model and vae are handed in as environment rather than discovered twice",
    captured.opts.env.AIPLAY_YUE_MODEL === YUE.model && captured.opts.env.AIPLAY_YUE_VAE === YUE.vae);
}
{
  const proc = fakeProc();
  const e = await refusal(async () => {
    const p = runYueDriver([], { spawnFn: () => proc });
    proc.stderr.emit("data", "REFUSED: YuE2 has no audio-reference argument.\n");
    proc.emit("close", 2);
    return p;
  });
  ok("exit 2 arrives as a refusal, with the python's sentence",
    /refused this render/.test(e.message) && /no audio-reference/.test(e.message), e.message);
  ok("...and the code travels as a field", e.exitCode === 2, String(e.exitCode));
}
{
  const proc = fakeProc();
  const e = await refusal(async () => {
    const p = runYueDriver([], { spawnFn: () => proc });
    proc.stderr.emit("data", "Traceback (most recent call last):\n  File \"x\", line 1\n"
      + "torch.OutOfMemoryError: Tried to allocate 3.86 GiB\n");
    proc.emit("close", 3);
    return p;
  });
  ok("exit 3 is a failure whose FIRST line is the exception, not the stack",
    /^The YuE2 render failed\.\ntorch\.OutOfMemoryError/.test(e.message),
    e.message.split("\n").slice(0, 2).join(" / "));
}
{
  const proc = fakeProc();
  const e = await refusal(async () => {
    const p = runYueDriver([], { spawnFn: () => proc });
    proc.stdout.emit("data", "loaded the model\nand then nothing\n");
    proc.emit("close", 0);
    return p;
  });
  ok("⚠ exit 0 with no result line is reported as not-an-answer",
    /finished without answering/.test(e.message), e.message);
}
{
  const proc = fakeProc();
  const e = await refusal(async () => {
    const p = runYueDriver([], { spawnFn: () => proc });
    proc.stdout.emit("data", "YUE_RESULT_JSON:{not json at all}");
    proc.emit("close", 0);
    return p;
  });
  ok("a result line that is not JSON is its own error", /not JSON/.test(e.message), e.message);
}
{
  /* THE TIMEOUT, AND THE TREE-KILL IT MUST PERFORM. This is the branch the
   * measured failure lives in: a plain stop left a python child rendering, and
   * every later timing was 3.3x-10.8x wrong. */
  const proc = fakeProc(31337);
  let killed = null;
  const e = await refusal(() => runYueDriver([], {
    spawnFn: () => proc, timeoutMs: 5,
    killTree: (p) => { killed = p; return Promise.resolve(true); },
  }));
  ok("a run that overruns its timeout is stopped", /did not finish in/.test(e.message), e.message);
  ok("...by TREE-KILLING the process it started, not by proc.kill()",
    killed === proc && killed.pid === 31337, String(killed?.pid));
  ok("...and the message says the owned tree was stopped",
    /its owned process tree was stopped/.test(e.message), e.message);
}
{
  const proc = fakeProc();
  const e = await refusal(() => runYueDriver([], {
    spawnFn: () => proc, timeoutMs: 5, killTree: () => Promise.resolve(false),
  }));
  ok("a tree-kill that cannot be confirmed SAYS SO rather than claiming success",
    /could not be confirmed/.test(e.message) && /stray python holding the card/.test(e.message),
    e.message);
}
{
  const proc = fakeProc();
  const e = await refusal(async () => {
    const p = runYueDriver([], { spawnFn: () => proc, python: "C:/nope/python.exe" });
    proc.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    return p;
  });
  ok("a missing interpreter names the file and the setting that moves it",
    /not at C:\/nope\/python\.exe/.test(e.message) && /AIPLAY_YUE_PYTHON/.test(e.message), e.message);
}
{
  const e = await refusal(() => runYueDriver([], {
    spawnFn: () => { throw new Error("EACCES"); },
  }));
  ok("a spawn that throws outright is reported as a start failure, not as a render failure",
    /Could not start the YuE2 python/.test(e.message), e.message);
}
{
  /* THE PROGRESS SEAM, end to end through the door: stderr chunks reach the
   * reader the adapter installs. */
  const proc = fakeProc();
  const seen = [];
  const reader = createProgressReader({ onEvent: (ev) => seen.push(ev) });
  const p = runYueDriver([], { spawnFn: () => proc, onStderr: (c) => reader.push(c) });
  proc.stderr.emit("data", LINES.startNoUnit + "\n" + LINES.runTokens + "\n");
  proc.stdout.emit("data", 'YUE_RESULT_JSON:{"ok":true}\n');
  proc.emit("close", 0);
  await p;
  ok("stderr progress reaches the reader through the door's onStderr seam",
    seen.length === 2 && seen[1].stage === "semantic", JSON.stringify(seen.map((s) => s.stage)));
}

console.log("\nTHE RECORD, AND THE DOOR IT ADMITS TO BEING");
{
  const spent = [];
  const stub = { append: async (scope, e) => { spent.push(e); return { id: "e1" }; } };
  const d = await renderSong({
    style: "slow cyberpunk ballad, female mezzo, 90 BPM",
    lyrics: "Docking lights. A hundred years of rain.\n\nPut your hand up.",
    seed: 831001, cot: "full", id: "rain-yue2-001",
    out: path.join(dir, "song"), via: "test.dry", actor: "script:yue_test",
    prov: stub, dryRun: true,
  });
  ok("a dry run returns a record", d.dryRun === true && !!d.record);
  ok("...and writes NOTHING to the ledger", spent.length === 0, JSON.stringify(spent));
  ok("...naming the engine the ledger will file it under", d.record.model === YUE_MODEL);
  ok("...and that name is the key MODEL_TO_CAPABILITY bridges, so the rights get stamped",
    MODEL_TO_CAPABILITY[YUE_MODEL] === YUE_CAP,
    `${YUE_MODEL} -> ${MODEL_TO_CAPABILITY[YUE_MODEL]} (want ${YUE_CAP})`);
  ok("...recording every argument, including the seed",
    d.record.seed === 831001 && d.record.args.cot === "full" && d.record.args.id === "rain-yue2-001",
    JSON.stringify(d.record.args));
  ok("...and the two numbers the CLI cannot pass together",
    d.record.runtime.memoryBudgetGib === 16 && d.record.runtime.vaeCoreFrames === 512,
    JSON.stringify(d.record.runtime));
  ok("...and the sdpa preference, with FLASH absent on purpose",
    d.record.runtime.sdpaBackends.join(",") === "EFFICIENT_ATTENTION,MATH",
    d.record.runtime.sdpaBackends.join(","));
  ok("...the actor is the harness that asked, not `user`", d.record.actor === "script:yue_test");
  ok("⚠ the LYRICS are not copied into the append-only ledger — a length and a hash instead",
    d.record.args.lyrics === undefined && /^[0-9a-f]{64}$/.test(d.record.args.lyricsSha256)
      && d.record.args.lyricsChars > 0,
    JSON.stringify({ chars: d.record.args.lyricsChars, sha: d.record.args.lyricsSha256?.slice(0, 12) }));
  ok("...both checkpoints have a slot for their bytes and their hash",
    d.record.weights.length === 2 && d.record.weights.every((w) => "sha256" in w && "dest" in w),
    JSON.stringify(d.record.weights.map((w) => w.role)));
  ok("...and the record ADMITS to being a third door",
    d.record.door === THIRD_DOOR && /THIRD door/.test(d.record.door), d.record.door);
  ok("...saying the torch collision is the reason, not a preference",
    /2\.10\.0\+cu130/.test(THIRD_DOOR) && /2\.13\.0\+cu130/.test(THIRD_DOOR));
  ok("...and that it writes the same pair the engine door writes",
    /delegate\/generate pair/.test(THIRD_DOOR));
  ok("a dry run reports what a real one would refuse instead of throwing",
    d.wouldRefuse === null || (typeof d.wouldRefuse.code === "string" && d.wouldRefuse.why.length > 0),
    JSON.stringify(d.wouldRefuse)?.slice(0, 200));

  /* THE RIGHTS TRAVEL IN EVERY ROW. Since 2026-09-24 the label follows the
   * YuE2 authors' statement (sellable by individuals; companies need a
   * commercial licence), and the licence file's own grant — "for
   * NonCommercial purposes only" — rides beside it, verbatim, so neither can
   * be read without the other. */
  ok("the label travels in the record, and says whose words it follows",
    d.record.rights.class === "yours-with-conditions" && d.record.rights.basis === "authors-statement",
    d.record.rights.class);
  ok("...quoting the authors verbatim rather than our summary",
    /Even making money from the outputs\./.test(d.record.rights.quote), d.record.rights.quote?.slice(0, 80));
  ok("...with the licence file's operative sentence beside it",
    /NonCommercial purposes only/.test(d.record.rights.licenceFile?.quote || "")
    && d.record.rights.licenceFile?.name === "CC BY-NC 4.0", JSON.stringify(d.record.rights.licenceFile)?.slice(0, 120));
  ok("...and the record says WHICH file the verdict came from",
    /models\.js|yue\.js/.test(d.record.rightsSource || ""), d.record.rightsSource);

  /* ⚠ TWO INDEPENDENT READINGS OF ONE LICENCE, AND THEY MUST AGREE. models.js's
   * musicYue2 row is the catalogue's verdict and the one the record carries;
   * YUE2_RIGHTS in yue.js is this door's own read of the same LICENSE file,
   * written before that row was known to exist. If somebody later softens
   * either, this lane fails and a human decides — rather than a ledger row
   * quietly changing what it promises a user about selling their song. */
  const cat = catalogueRights();
  if (cat) {
    ok("the catalogue's verdict is the one the record carries",
      d.record.rights === cat && /models\.js/.test(d.record.rightsSource), d.record.rightsSource);
    ok("...and YUE2_RIGHTS, which the GGUF door carries, IS that row",
      YUE2_RIGHTS === cat, `yue.js says ${YUE2_RIGHTS.class}, models.js says ${cat.class}`);
    /* The independent reading of the FILE is kept, and the row must quote the
     * file the way it reads: the grant this file quotes sits inside the
     * catalogue's licenceFile quote, word for word. */
    ok("...and this file's independent reading of the same LICENSE agrees with the row's licenceFile",
      YUE2_LICENCE_READ.class === "not-for-sale" && typeof cat.licenceFile?.quote === "string"
      && cat.licenceFile.quote.includes(YUE2_LICENCE_READ.quote),
      `licenceFile quote: ${cat.licenceFile?.quote?.slice(0, 80)}`);
    ok("...and the change is recorded, not silent",
      cat.changed?.from === "not-for-sale" && cat.changed?.on === "2026-09-24", JSON.stringify(cat.changed));
    ok("...so stampRights fills outputRights from the row rather than from here",
      d.record.outputRights === undefined, JSON.stringify(d.record.outputRights));
  } else {
    ok("with no catalogue row the record sets outputRights itself — `unknown` would be worse",
      d.record.outputRights?.class === "not-for-sale", JSON.stringify(d.record.outputRights));
    ok("...and an admission that the conservative reading is a reading, not a verdict",
      /not a verdict/.test(YUE2_LICENCE_READ.note));
  }
}
{
  /* THE FILE FACTS, joined rather than retyped. The defect this pins is the one
   * server/mesh/catalogue_test.js exists for: the downloader writing to one
   * folder, or claiming one byte count, while the runner reads another. */
  const files = weightFiles();
  const row = CATALOG.find((c) => c.id === YUE_CAP);
  ok("both checkpoints are described", files.length === 2 && files.every((f) => f.dest),
    JSON.stringify(files.map((f) => f.role)));
  if (row) {
    ok("...with their bytes and hashes taken FROM the catalogue row, not retyped",
      files.every((f) => /models\.js/.test(f.factsFrom)),
      JSON.stringify(files.map((f) => f.factsFrom)));
    ok("...joined by the `identifies` tail, which is what that field is for",
      files.every((f) => row.files.some((r) => r.identifies === f.identifies)),
      JSON.stringify(files.map((f) => f.identifies)));
    ok("...and this file's measured fallback AGREES with the row, so it cannot become a second answer",
      files.every((f) => f.bytes === f.fallbackBytes && f.sha256 === f.fallbackSha256),
      JSON.stringify(files.map((f) => [f.role, f.bytes, f.fallbackBytes])));
    ok("...and the paths the interpreter is pointed at end in the tail the row identifies",
      files.every((f) => f.dest.replace(/\\/g, "/").endsWith(f.identifies)),
      JSON.stringify(files.map((f) => f.dest)));
  } else {
    ok("...from this file's measured fallback when the row is absent, and it says so",
      files.every((f) => /yue\.js/.test(f.factsFrom)));
  }
}
{
  /* `via` DEFAULTS, so the refusal is proven the way runner_test.js proves the
   * same rule for meshFromImage: by handing in an empty one. A default that can
   * be emptied is still a field the ledger needs filled. */
  const e = await refusal(() => renderSong({
    style: "s", lyrics: "l", out: path.join(dir, "x"), via: "" }));
  ok("a run with an empty `via` is refused — the ledger must say which part of the app spent the card",
    /needs `via`/.test(e?.message || ""), String(e?.message));
  ok("a run with no output directory is refused",
    /needs an output directory/.test(
      (await refusal(() => renderSong({ style: "s", lyrics: "l", via: "t" })))?.message || ""));
}
{
  /* A dry run keeps the same request checks as a real run, and section tags
   * are YuE2's own lyric format: neither run refuses them. */
  const e = await refusal(() => renderSong({
    style: "pop", lyrics: "[Verse]\nwords", out: path.join(dir, "y"), via: "test.dry", dryRun: true,
  }));
  ok("a dry run does not refuse tagged lyrics", e?.refusal !== "lyrics", String(e?.refusal));
  /* ⚠ THE DEFECT THIS LANE FOUND, kept as the assertion that pins it.
   * `renderSong` destructured the options it knew and `reference_id` was
   * destructured into nothing, so the refusal whose entire purpose is "a dropped
   * argument must never be silent" received a request with the reference already
   * dropped. The rest parameter and refuseUnknownOptions are the fix. */
  const e2 = await refusal(() => renderSong({
    style: "pop", lyrics: "words", reference_id: "abc", out: path.join(dir, "y"),
    via: "test.dry", dryRun: true,
  }));
  ok("...and an audio reference handed to renderSong ITSELF is refused, not destructured away",
    e2?.refusal === "no-audio-input", `${e2?.refusal}: ${String(e2?.message).split("\n")[0]}`);
  const e3 = await refusal(() => renderSong({
    style: "pop", lyrics: "words", duration: 180, out: path.join(dir, "y"),
    via: "test.dry", dryRun: true,
  }));
  ok("...and `duration`, the option people reach for first, is named rather than ignored",
    e3?.refusal === "unknown-option" && /no duration argument at all/.test(e3.message),
    `${e3?.refusal}: ${String(e3?.message).split("\n")[0]}`);
  ok("...with the remedy: different lyrics, or a score of the length you want",
    /supply an `abc` score of the length you want/.test(e3?.message || ""), e3?.message);
  ok("...and audioSeconds, which is a progress assumption and not a request field, still passes",
    (await refusal(() => renderSong({
      style: "pop", lyrics: "words", audioSeconds: 180, out: path.join(dir, "y"),
      via: "test.dry", dryRun: true }))) === null);
}

console.log("\nTHE RUNTIME, AND THE LEDGER-BEFORE-SPEND RULE");
{
  const st = await yueStatus();
  ok("yueStatus answers without spawning anything", typeof st.installed === "boolean");
  ok("...and names the interpreter it looked for", /python/i.test(st.python), st.python);
  if (!st.installed) {
    ok("not installed ⇒ at least one sentence saying which file is missing", st.why.length >= 1,
      st.why.join(" | "));
    ok("...and each sentence names a path or the setting that moves it",
      st.why.every((w) => /AIPLAY_YUE|[A-Za-z]:\\|\//.test(w)), st.why.join(" | "));
    const e = await refusal(() => refuse({ style: "s", lyrics: "l" }));
    ok("refuse() stops on the runtime before it looks at the card",
      e instanceof YueRefusal && e.refusal === "runtime", String(e?.refusal));
    ok("...and says nothing will be installed on its behalf",
      /Nothing here will install either/.test(e.message), e.message);
  } else {
    ok("installed ⇒ no missing-file sentences", st.why.length === 0, st.why.join(" | "));
    ok("...and both checkpoints are exactly their measured size",
      st.weights.every((w) => w.bytes === w.declaredBytes),
      JSON.stringify(st.weights.map((w) => [w.role, w.bytes, w.declaredBytes])));
  }
}
{
  /* ⚠ THE LEDGER-BEFORE-SPEND RULE, PROVEN AT RUNTIME rather than by grepping
   * the source — the same proof server/engine/client_test.js makes about the
   * same kind of append. A ledger that throws must cost the run, and the
   * subprocess must never start.
   *
   * The guards run in order — request, runtime, card, then ledger — so this
   * proof needs the first three to pass. When the card is busy the run is
   * refused for a DIFFERENT and entirely correct reason, and treating that as a
   * failure of the ledger rule is the test lying about which rule broke. So it
   * skips loudly, naming what is holding the card. (The mesh suite records the
   * same lesson at runner_test.js's ledger lane, after a whole night of raising
   * a timeout over a theory that was simply wrong.) */
  let spawned = false;
  const angry = { append: async () => { throw new Error("ledger is down"); } };
  const e = await refusal(() => renderSong({
    style: "slow ballad", lyrics: "words and more words",
    out: path.join(dir, "never"), via: "test.ledger", prov: angry,
    runner: () => { spawned = true; return Promise.resolve({ ok: true }); },
  }));
  if (e instanceof YueRefusal) {
    console.log("  --    the ledger-before-spend proof needs the runtime and the card, and this");
    console.log(`        machine refused first (${e.refusal}):`);
    console.log(`        ${String(e.message).split("\n")[0]}`);
    console.log("        That refusal working is the stronger guarantee while it holds.");
    ok("...and nothing was spawned on the way to that refusal", spawned === false);
  } else {
    ok("a ledger failure costs the run", /ledger is down/.test(e?.message || ""), String(e?.message));
    ok("...and the driver was never started", spawned === false);
  }
}

console.log("\nTHE DRIVER ITSELF — its contract, with no torch and no weights");
{
  let hasPython = true;
  try { await stat(YUE.python); } catch { hasPython = false; }
  if (!hasPython) {
    console.log(`  --    venv-yue is not at ${YUE.python}, so the driver's own four selftest`);
    console.log("        modes are skipped. They load no model and touch no card; they are");
    console.log("        skipped only because there is no interpreter to run them in.");
  } else {
    const r = await runYueDriver(["--selftest", "ok"], { timeoutMs: 60e3 });
    ok("the driver answers behind its marker and exits 0",
      r.ok === true && r.selftest === "ok", JSON.stringify(r));

    const refused = await refusal(() => runYueDriver(["--selftest", "refuse"], { timeoutMs: 60e3 }));
    ok("...exit 2 really is a refusal end to end",
      /refused this render/.test(refused.message) && refused.exitCode === 2, refused.message);

    /* ⚠ THE ONE THAT MATTERS. The driver is told to pretend a render finished
     * over an empty directory. It must exit NON-ZERO. Exiting 0 here is the
     * defect that discarded 35 minutes of finished audio. */
    const missing = await refusal(() => runYueDriver(["--selftest", "missing-output"],
      { timeoutMs: 60e3 }));
    ok("⚠ a render that 'succeeded' and wrote nothing exits NON-ZERO, not 0",
      missing?.exitCode === 3, `exit ${missing?.exitCode}`);
    ok("...and the failure names the loss it is standing in front of",
      /lost 35 minutes of finished audio/.test(missing.message),
      missing.message.split("\n").slice(0, 3).join(" / "));
    ok("...and it is reported as a failure, never as a completion",
      /render failed/.test(missing.message) && !/^The YuE2 render completed/.test(missing.message));

    /* THE VENDOR'S OWN WRITER, live: the recorded literals at the top of this
     * file are re-produced by progress.py in the real interpreter and fed
     * through the real parser. If the vendor ever changes a shape, this lane is
     * where it surfaces — not in a render three hours long. */
    const seen = [];
    const reader = createProgressReader({ onEvent: (ev) => seen.push(ev) });
    await runYueDriver(["--selftest", "progress"],
      { timeoutMs: 60e3, onStderr: (c) => reader.push(c) });
    reader.end();
    const kinds = seen.map((s) => s.kind === "summary" ? "summary" : s.stage);
    ok("progress.py's live output still parses into the three shapes",
      kinds.includes("load") && kinds.includes("semantic") && kinds.includes("nar")
        && kinds.includes("summary"), kinds.join(","));
    ok("...the unit-less stage is among them, which is the shape a naive regex drops",
      seen.some((s) => s.stage === "load" && s.completed === null && s.elapsedSec !== null));
    ok("...the summary carries 167.0 s of audio in 399.6 s, as it did on the real run",
      seen.some((s) => s.kind === "summary" && s.audioSeconds === 167 && s.elapsedSec === 399.6),
      JSON.stringify(seen.find((s) => s.kind === "summary")));
    ok("...and a live line is byte-identical to the recording at the top of this file",
      seen.some((s) => s.stage === "nar" && s.total === 32 && s.completed === 7),
      JSON.stringify(seen.filter((s) => s.stage === "nar")));
  }
}
{
  /* The driver is beside the adapter, and the path is built with
   * fileURLToPath — `new URL().pathname` yields "/C:/temp/…" on Windows and the
   * spawn fails on a path that looks almost right (runner.js:588). */
  let there = true;
  try { await stat(DRIVER); } catch { there = false; }
  ok("the driver file the adapter will spawn is actually there", there, DRIVER);
  ok("...and its path has no leading slash before the drive letter",
    !/^\/[A-Za-z]:/.test(DRIVER), DRIVER);
  const src = await readFile(DRIVER, "utf8");
  /* ⚠ THE GATE READS CODE, NOT COMMENTS. This lane's first draft failed on its
   * own subject matter: it asserted the driver never writes `hasattr(pipe` and
   * the driver's header EXPLAINS the hasattr defect in prose, so the gate was
   * reading the explanation and calling it the bug. Docstrings and comments are
   * stripped first — the same correction commit 7cfde96 made for the VFX gate. */
  const code = src.replace(/"""[\s\S]*?"""/g, "").replace(/^\s*#.*$/gm, "").replace(/\s#.*$/gm, "");
  ok("the comment-stripped view still holds the driver's actual code",
    code.includes("def render(") && !code.includes("THE THREE OTHER TRAPS"),
    `${code.length} of ${src.length} chars are code`);
  ok("the driver passes a HIGH memory cap and SMALL vae tiles together — the pairing the CLI cannot",
    /memory_budget_gib=args\.budget_gib/.test(code) && /vae_core_frames=args\.vae_core_frames/.test(code));
  ok("...calls save_artifacts on the RESULT, never on the pipeline",
    /result\.save_artifacts\(/.test(code) && !/pipe\.save_artifacts|hasattr\(pipe/.test(code));
  ok("...omits FLASH from the sdpa preference, because the Windows wheels advertise and then raise",
    /SDPBackend\.EFFICIENT_ATTENTION, SDPBackend\.MATH/.test(code) && !/SDPBackend\.FLASH/.test(code));
  ok("...passes style and lyrics as FIELDS, not a SongRequest in the style slot",
    /pipe\(style=request\["style"\], lyrics=request\["lyrics"\]/.test(code));
  ok("...asks for local files only, so a missing weight is an error and never a 7 GB download",
    /local_files_only=True/.test(code));
  ok("...imports torch inside the render, so every refusal above it is free",
    code.indexOf("import torch") > code.indexOf("def render("), "torch must not be a module import");

  /* THE TWO MEMORY LEVERS. The ladder in yue_fit.js is only real if the driver
   * actually forwards them, and the failure mode of forgetting is silent: the
   * pipeline defaults both off, so a run asked for in the `compact` rung would
   * render at full precision, succeed, and be recorded as compact. */
  ok("...takes --quantization, restricted to what quantization.py implements",
    code.includes('"--quantization"') && code.includes('choices=["none", "fp8"]'));
  ok("...takes --offload-ar as a flag",
    /"--offload-ar", action="store_true"/.test(code));
  ok("...forwards BOTH to the pipeline constructor, where they default off",
    /quantization=args\.quantization/.test(code) && /offload_ar=args\.offload_ar/.test(code));
  ok("...refuses fp8 on a card below capability 8.9 BEFORE loading the weights",
    code.indexOf("get_device_capability") < code.indexOf("YuE2Pipeline.from_pretrained")
    && /cap < \(8, 9\)/.test(code),
    "the library's own check runs after a 6.76 GiB load, which is too late to be useful");
  ok("...and points the refused user at the lever that has no such requirement",
    /--offload-ar has no such/.test(code));
  ok("...records both in the receipt, because fp8 is different arithmetic",
    /"quantization": args\.quantization/.test(code) && /"offloadAr": args\.offload_ar/.test(code));
}

await rm(dir, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
