/**
 * The ladder's tests. The one they exist to protect is the last group: that no
 * rung is ever chosen because of a number nobody measured. Every other property
 * here is arithmetic; that one is the design.
 */
import { readFileSync } from "node:fs";
import {
  fit, fmt, rungArgs, RUNGS, CONTEXT_FRAMES, CONTEXT_SECONDS,
  GENERATION_CAP_SECONDS, FP8_MIN_CAPABILITY,
  PREFILL_MIB_PER_SECOND, CHUNK_PLATEAU_SECONDS,
} from "./yue_fit.js";
import { TOKEN_CAPS, TOKENS_PER_AUDIO_SECOND } from "./yue.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const SRC = readFileSync(new URL("./yue_fit.js", import.meta.url), "utf8");

console.log("\nTHE THREE CEILINGS");
ok("the context window is the published 24576 frames", CONTEXT_FRAMES === 24576);
ok("...which is 983.04 s at the measured 25 frames per second",
  CONTEXT_SECONDS === 983.04, `got ${CONTEXT_SECONDS}`);
ok("the generation cap is derived from TOKEN_CAPS, not typed in twice",
  GENERATION_CAP_SECONDS === Number((TOKEN_CAPS.semantic / TOKENS_PER_AUDIO_SECOND).toFixed(2))
  && GENERATION_CAP_SECONDS === 360, `got ${GENERATION_CAP_SECONDS}`);
ok("the generation cap binds before the context window",
  GENERATION_CAP_SECONDS < CONTEXT_SECONDS);
/* If a future checkpoint raises semantic.max_tokens past the window, the
 * ordering above silently inverts and `fit` would warn about the wrong wall.
 * This is the canary for that, not a restatement of the line above it. */
ok("...and the module would be wrong if it did not, so this is asserted not assumed",
  /Ceiling 3 first, because it is the one that lies/.test(SRC));

console.log("\nTHE WALL THE RUNGS DO NOT MOVE");
ok("the prefill cost is 114,688 bytes per token at 25 tokens a second",
  PREFILL_MIB_PER_SECOND === Number((114688 * 25 / 2 ** 20).toFixed(3))
  && PREFILL_MIB_PER_SECOND === 2.734, `got ${PREFILL_MIB_PER_SECOND}`);
ok("the chunk plateau is protocol.py's (24576 - prefix - 3) / 2, in seconds",
  CHUNK_PLATEAU_SECONDS === 471.4, `got ${CHUNK_PLATEAU_SECONDS}`);
/* This inequality is why the plateau never arrives in a default render, and it
 * is the reason the memory box can say "rises with duration" without hedging.
 * If a future checkpoint raises max_tokens past the plateau, the box's claim
 * becomes wrong and this fails first. */
ok("...and the generation cap binds BEFORE the plateau, so memory never flattens",
  GENERATION_CAP_SECONDS < CHUNK_PLATEAU_SECONDS,
  `${GENERATION_CAP_SECONDS} vs ${CHUNK_PLATEAU_SECONDS}`);

console.log("\nTHE RUNGS");
ok("three rungs, cheapest first", RUNGS.length === 3 && RUNGS[0].id === "standard");
ok("savings increase down the ladder",
  RUNGS.every((r, i) => i === 0 || r.savesGib > RUNGS[i - 1].savesGib));
ok("the compact rung's saving is exactly the sum of its two levers",
  Math.abs(RUNGS[2].savesGib - (4.0344 + 1.3125)) < 1e-9,
  `${RUNGS[2].savesGib} vs ${4.0344 + 1.3125}`);
ok("only the standard rung has a measured reach",
  RUNGS.filter((r) => r.reachSeconds !== null).length === 1
  && RUNGS[0].reachSeconds === 168.0);
ok("every rung says where its reach figure came from",
  RUNGS.every((r) => typeof r.reachFrom === "string" && r.reachFrom.length > 20));
ok("...and an unmeasured reach opens by saying what it is NOT",
  RUNGS.filter((r) => r.reachSeconds === null)
    .every((r) => /^NOT (MEASURED|A DURATION LEVER)/.test(r.reachFrom)));
/* The correction this module was rewritten around: offload_ar frees 4 GiB in
 * the synthesis stage and still does not raise the duration ceiling, because
 * nar.py:249 prefills before nar.py:251 offloads. A future reader who has not
 * read that ordering will "fix" the rung back. This is the tripwire. */
ok("the offload rung states in its own data that it is not a duration lever",
  /^NOT A DURATION LEVER/.test(RUNGS[1].reachFrom));
ok("...and the module records the ordering that makes it so",
  /nar\.py:249/.test(SRC) && /nar\.py:251/.test(SRC) && /BEFORE the/.test(SRC));
ok("every rung says which stage it lowers, since none of them lower the same one",
  RUNGS.every((r) => Array.isArray(r.lowers) && r.lowers.length > 0));
ok("the fp8 rung carries the vendor's own refusal to claim quality",
  RUNGS[2].costs.some((c) => /no quality claim|makes no quality claim/i.test(c)));
ok("...and the compute-capability requirement, because the rung is unusable without it",
  RUNGS[2].costs.some((c) => /8\.9/.test(c)));
ok("rungArgs speaks the pipeline's vocabulary",
  JSON.stringify(rungArgs("compact")) === JSON.stringify({ quantization: "fp8", offloadAr: true }));
ok("rungArgs on an unknown rung is null, not a default",
  rungArgs("turbo") === null);

console.log("\nCHOOSING");
const noWant = fit(null);
ok("no stated duration picks the cheapest rung and says nothing",
  noWant.rung.id === "standard" && noWant.info === null && noWant.ceiling === null);
ok("...and a zero or negative duration is the same as none",
  fit(0).info === null && fit(-5).info === null);

const short = fit(120);
ok("a duration inside the measured reach stays on standard with no box",
  short.rung.id === "standard" && short.info === null && !short.promoted);
ok("...right up to the measured reach itself",
  fit(168).rung.id === "standard" && fit(168).info === null);

const mem = fit(200);
ok("past the measured reach, the ceiling is named memory",
  mem.ceiling === "memory", mem.ceiling);
ok("...and it promotes to the rung with the most headroom",
  mem.promoted && mem.rung.id === "compact", mem.rung.id);
ok("...and the box admits the reach is untested",
  /an attempt rather than a promise/.test(mem.info.lines.join(" ")));
ok("...and names the stage that limits length, with its measured per-second cost",
  /synthesis stage/.test(mem.info.lines.join(" "))
  && mem.info.lines.join(" ").includes(`${PREFILL_MIB_PER_SECOND} MiB`));
/* ⚠ THE ONE THAT MATTERS. The box is allowed to select a lighter rung, but it
 * must never tell the user that doing so buys them a longer song — that was
 * the false claim, and a box is exactly where it would do damage. */
ok("...and does NOT offer a configuration as the cure for length",
  !/switch(ing)? to .{0,40}(configuration|rung) .{0,30}(reach|longer|fit)/i
    .test(mem.info.lines.join(" "))
  && /not a setting/.test(mem.info.lines.join(" ")));
ok("...and points at sections, which is the route that works",
  /render the song in sections/.test(mem.info.lines.join(" ")));
ok("...citing the chunk size the model itself uses above that length",
  mem.info.lines.join(" ").includes(fmt(CHUNK_PLATEAU_SECONDS)));

const gen = fit(400);
ok("past 360 s the ceiling is the generation cap, not memory",
  gen.ceiling === "generation", gen.ceiling);
ok("...and the box says a bigger card does not help",
  /bigger card does not reach further/.test(gen.info.lines.join(" ")));
ok("...and that the quantized release has the same number",
  /same 9000/.test(gen.info.lines.join(" ")));
/* ⚠ THE RUNG IS FOR THE RENDERED DURATION, NOT THE REQUESTED ONE. The first
 * version promoted to the top rung here "because there is no reason to leave it
 * on the table" — accepting fp8 quality nobody has validated in exchange for a
 * length the sampler stops short of. The fix asks the memory rule about the
 * duration that will actually happen, so these two must agree. */
ok("...and the rung matches what fit() picks for the duration that will render",
  gen.rung.id === fit(GENERATION_CAP_SECONDS).rung.id,
  `${gen.rung.id} vs ${fit(GENERATION_CAP_SECONDS).rung.id}`);
ok("...and the box quotes the rendered duration, not the requested one",
  /treat 6:00 as an attempt/.test(gen.info.lines.join(" ")),
  "a box that says \"treat 6:40 as an attempt\" is describing a length that cannot occur");

const ctx = fit(1200);
ok("past 983 s the ceiling is the context window", ctx.ceiling === "context");
ok("...at the highest severity, because this one does not fail loudly",
  ctx.info.level === "stop");
ok("...and the box says clamped, not rejected",
  /clamped rather than rejected/.test(ctx.info.lines.join(" ")));
ok("...and does not promote a rung, since no configuration helps",
  ctx.promoted === false && ctx.rung.id === "standard");

console.log("\nTHE FP8 GATE");
const old = fit(200, { capability: [8, 6] });
ok("an RTX 30-series card cannot be given the fp8 rung",
  old.rung.quantization !== "fp8" && old.rung.id === "long", old.rung.id);
ok("...and still gets the offload rung, which needs no special kernels",
  old.rung.offloadAr === true);
ok("an RTX 40-series card can", fit(200, { capability: [8, 9] }).rung.id === "compact");
ok("a newer architecture can too", fit(200, { capability: [9, 0] }).rung.id === "compact");
ok("the gate matches the vendor's own comparison",
  FP8_MIN_CAPABILITY[0] === 8 && FP8_MIN_CAPABILITY[1] === 9);
ok("an unknown capability does not silently exclude the rung",
  fit(200, { capability: null }).rung.id === "compact");

console.log("\nNO RUNG IS EVER CHOSEN ON AN ESTIMATE");
/* The property, stated as a property: for every duration across the whole
 * range, either the chosen rung's reach covers it, or the result admits the
 * reach is unmeasured. There is no third case where a number was trusted. */
let unproven = 0, silent = [];
for (let s = 10; s <= 1000; s += 5) {
  const r = fit(s);
  const reach = r.rung.reachSeconds;
  if (reach !== null && s <= reach) continue;          // measured to cover it
  unproven++;
  const said = r.info && /an attempt rather than a promise|expect the song to end|clamped/
    .test(r.info.lines.join(" "));
  if (!said) silent.push(s);
}
ok(`every duration beyond a measured reach (${unproven} of them) says so`,
  silent.length === 0, silent.length ? `silent at: ${silent.slice(0, 8).join(", ")}` : "");

ok("no rung carries a reachSeconds it did not measure",
  RUNGS.every((r) => r.reachSeconds === null || /MEASURED/.test(r.reachFrom)));
/* The 1438 s figure is the exact wrong answer this module was written to avoid
 * printing. If someone later "fixes" the nulls by dividing bytes by the K/V
 * coefficient, this fails and the comment explains why. */
ok("the module records the estimate it refused to print",
  /1438/.test(SRC) && /plainly\s+\*?\s*false/.test(SRC));

console.log("\nFORMATTING");
ok("under two minutes reads in seconds", fmt(90) === "90 s" && fmt(119) === "119 s");
/* 168 s is the measured reach and reads 2:48, which is the point of the
 * threshold: the number people quote for this engine is past two minutes. */
ok("over two minutes reads as a clock",
  fmt(168) === "2:48" && fmt(240) === "4:00" && fmt(983.04) === "16:23");
ok("a fractional short duration keeps one decimal", fmt(107.1) === "107.1 s");
ok("a nonsense duration is a question mark, not a crash",
  fmt(undefined) === "?" && fmt(NaN) === "?");

console.log(`\n  ${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
