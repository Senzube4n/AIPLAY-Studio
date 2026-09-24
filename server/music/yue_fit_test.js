/**
 * The ladder's tests. The one they exist to protect is the last group: that no
 * rung is ever chosen because of a number nobody measured. Every other property
 * here is arithmetic; that one is the design.
 *
 * Rewritten 2026-09-11 when the wall moved: the first version asserted that no
 * configuration could lengthen a song, and a measured lever proved it wrong.
 * The tests now assert the OPPOSITE for the one lever that was measured, and
 * keep asserting it for the one that was not (fp8).
 */
import { readFileSync } from "node:fs";
import {
  fit, fmt, rungArgs, RUNGS, CONTEXT_FRAMES, CONTEXT_SECONDS,
  GENERATION_CAP_SECONDS, FP8_MIN_CAPABILITY,
  PREFILL_MIB_PER_SECOND, CHUNK_PLATEAU_SECONDS,
  RUNTIME_CAP_GIB, PREFILL_ATTENTION_MIB, CHUNK_ATTENTION_MIB_PER_SECOND,
  MEASURED_PREFILL, projectedPrefillGib, fp8Allowed, usableRungs, maxTokensFor,
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

console.log("\nTHE WALL, AND THE LEVER THAT MOVES IT");
ok("the K/V cost is 114,688 bytes per token at 25 tokens a second",
  PREFILL_MIB_PER_SECOND === Number((114688 * 25 / 2 ** 20).toFixed(3))
  && PREFILL_MIB_PER_SECOND === 2.734, `got ${PREFILL_MIB_PER_SECOND}`);
ok("the chunk plateau is protocol.py's (24576 - prefix - 3) / 2, in seconds",
  CHUNK_PLATEAU_SECONDS === 471.4, `got ${CHUNK_PLATEAU_SECONDS}`);
ok("...and the generation cap binds BEFORE the plateau, so memory never flattens",
  GENERATION_CAP_SECONDS < CHUNK_PLATEAU_SECONDS,
  `${GENERATION_CAP_SECONDS} vs ${CHUNK_PLATEAU_SECONDS}`);
ok("the runtime cap is the 13.99 GiB every OOM on this card has quoted", RUNTIME_CAP_GIB === 13.99);
/* The measurement that changed the module. Four points through the package's
 * own attention(); the whole-sequence column is what the vendor's default
 * allocates and the 512 column is the Long rung. */
ok("the prefill attention table has the four measured lengths, 168 s to the 360 s cap",
  PREFILL_ATTENTION_MIB.length === 4 && PREFILL_ATTENTION_MIB[0].seconds === 168
  && PREFILL_ATTENTION_MIB[3].seconds === 360 && PREFILL_ATTENTION_MIB[3].tokens === 9000);
/* Superlinear, and close to the square: between neighbouring rows the temp's
 * ratio exceeds the token ratio and lands within 20% of its square. */
ok("...the whole-sequence temp grows faster than the length does (tokens²)",
  PREFILL_ATTENTION_MIB.every((p, i) => {
    if (i === 0) return true;
    const q = PREFILL_ATTENTION_MIB[i - 1];
    const wholeRatio = p.whole / q.whole, tokenRatio = p.tokens / q.tokens;
    return wholeRatio > tokenRatio && wholeRatio > 0.8 * tokenRatio ** 2;
  }));
ok("...and the 512-token block stays under 1 GiB at every measured length, including the cap",
  PREFILL_ATTENTION_MIB.every((p) => p.block512 < 1024 && p.block512 < p.whole));
ok("...which at 194 s is the 3.58 GiB the OOM was 764 MiB short of",
  PREFILL_ATTENTION_MIB[1].whole > 3500 && PREFILL_ATTENTION_MIB[1].whole < 3700);
ok("the blocked slope is derived from the table's end points, not typed in",
  CHUNK_ATTENTION_MIB_PER_SECOND
    === Number(((872.1 - 412.0) / (9000 - 4200) * TOKENS_PER_AUDIO_SECOND).toFixed(3))
  && CHUNK_ATTENTION_MIB_PER_SECOND > 2 && CHUNK_ATTENTION_MIB_PER_SECOND < 3,
  `got ${CHUNK_ATTENTION_MIB_PER_SECOND}`);
ok("the measured whole-stage point is the 194.2 s render's own receipt",
  MEASURED_PREFILL.seconds === 194.2 && MEASURED_PREFILL.tokens === 7068
  && MEASURED_PREFILL.peakGib === 8.286 && MEASURED_PREFILL.queryChunk === 512);
ok("the projection returns the measured point at the measured length",
  projectedPrefillGib(MEASURED_PREFILL.seconds) === Number(MEASURED_PREFILL.peakGib.toFixed(2)),
  `got ${projectedPrefillGib(MEASURED_PREFILL.seconds)}`);
ok("...rises with length", projectedPrefillGib(300) > projectedPrefillGib(200));
ok("...and stays under the runtime cap all the way to the sampler's stop",
  projectedPrefillGib(GENERATION_CAP_SECONDS) < RUNTIME_CAP_GIB,
  `${projectedPrefillGib(GENERATION_CAP_SECONDS)} vs ${RUNTIME_CAP_GIB}`);
ok("...and answers nonsense with null, not NaN",
  projectedPrefillGib("x") === null && projectedPrefillGib(undefined) === null);
ok("the module says the projection is an estimate, in its own words",
  /extrapolat/i.test(SRC) && /ESTIMATED peak/.test(SRC));

console.log("\nTHE RUNGS");
ok("three rungs, cheapest first", RUNGS.length === 3 && RUNGS[0].id === "standard");
ok("savings increase down the ladder",
  RUNGS.every((r, i) => i === 0 || r.savesGib > RUNGS[i - 1].savesGib));
ok("the compact rung's saving is exactly the sum of its two weight levers",
  Math.abs(RUNGS[2].savesGib - (4.0344 + 1.3125)) < 1e-9,
  `${RUNGS[2].savesGib} vs ${4.0344 + 1.3125}`);
/* Every rung, the Standard one included: length is an outcome, so a short wish
 * can plan a long song, and the vendor's whole-sequence block is exactly the
 * configuration that died at 194 s. config.yue.queryChunk: 0 is the only way
 * back to it, on purpose. */
ok("every rung carries the 512-token query block — the vendor's whole-sequence default is on no rung",
  RUNGS.every((r) => r.queryChunk === 512));
ok("the standard and long rungs have measured reaches; the fp8 rung has none",
  RUNGS[0].reachSeconds === 168.0 && RUNGS[1].reachSeconds === 264.6 && RUNGS[2].reachSeconds === null);
ok("...and the long rung's reach is at or past the measured whole-stage point, never below it",
  RUNGS[1].reachSeconds >= MEASURED_PREFILL.seconds && /six songs/.test(RUNGS[1].reachFrom));
ok("every rung says where its reach figure came from",
  RUNGS.every((r) => typeof r.reachFrom === "string" && r.reachFrom.length > 20));
ok("...and an unmeasured reach opens by saying what it is NOT",
  RUNGS.filter((r) => r.reachSeconds === null).every((r) => /^NOT MEASURED/.test(r.reachFrom)));
/* The correction this module was rewritten around, twice. First: offload_ar
 * frees 4 GiB in the synthesis stage and still does not raise the ceiling,
 * because nar.py:249 prefills before nar.py:251 offloads. Second: the block
 * size DOES, and it is the rung's own data that says which lever is which. */
ok("the long rung names the block as the lever and lists the prefill first",
  RUNGS[1].queryChunk === 512 && /query_chunk 512/.test(RUNGS[1].reachFrom)
  && /queryChunk/.test(RUNGS[1].lowers[0]) && /prefill/.test(RUNGS[1].lowers[0]));
ok("...and still records that the offload is not the lever, with the ordering that makes it so",
  /offloadAr` does NOT move the ceiling/.test(SRC)
  && /nar\.py:249/.test(SRC) && /nar\.py:251/.test(SRC) && /BEFORE the/.test(SRC));
ok("...and why the reorder cannot be done: the prefill IS the AR backbone",
  /_prefill.*IS the AR backbone/.test(SRC));
ok("every rung says which stage it lowers",
  RUNGS.every((r) => Array.isArray(r.lowers) && r.lowers.length > 0));
ok("the fp8 rung says in its own data that it is not a length rung",
  /NOT A LENGTH RUNG/.test(SRC) && /nothing here changes the length ceiling/.test(RUNGS[2].reachFrom));
ok("the fp8 rung carries the vendor's own refusal to claim quality",
  RUNGS[2].costs.some((c) => /no quality claim|makes no quality claim/i.test(c)));
ok("...and the compute-capability requirement, because the rung is unusable without it",
  RUNGS[2].costs.some((c) => /8\.9/.test(c)));
ok("the long rung's cost quotes the measured ratio, not an adjective",
  RUNGS[1].costs.some((c) => /2\.65×/.test(c) && /2\.39×/.test(c)));
ok("rungArgs speaks the pipeline's vocabulary, block included",
  JSON.stringify(rungArgs("compact")) === JSON.stringify({ quantization: "fp8", offloadAr: true, queryChunk: 512 })
  && JSON.stringify(rungArgs("standard")) === JSON.stringify({ quantization: "none", offloadAr: false, queryChunk: 512 }));
ok("rungArgs on an unknown rung is null, not a default",
  rungArgs("turbo") === null);

console.log("\nCHOOSING");
const noWant = fit(null);
ok("no stated duration picks the cheapest rung and says nothing",
  noWant.rung.id === "standard" && noWant.info === null && noWant.ceiling === null);
ok("...and a zero or negative duration is the same as none",
  fit(0).info === null && fit(-5).info === null);

const short = fit(120);
ok("a duration inside the standard reach stays on standard with no box",
  short.rung.id === "standard" && short.info === null && !short.promoted);
ok("...right up to the measured reach itself",
  fit(168).rung.id === "standard" && fit(168).info === null);

const long = fit(190);
ok("past the standard reach and inside the long one, the long rung is chosen with no ceiling",
  long.rung.id === "long" && long.ceiling === null && long.promoted, `${long.rung.id} ${long.ceiling}`);
ok("...and a promotion the user did not ask for gets a note, not silence",
  long.info && long.info.level === "note" && /uses the Long configuration/.test(long.info.title));
/* Two short lines, on purpose: a song inside the measured reach is the normal
 * case, and the owner asked for the paragraph to go once 4:25 had rendered. */
ok("...that is short — two lines — and quotes the measured reach",
  long.info.lines.length === 2 && /Measured to 4:25/.test(long.info.lines[0]));
/* The mechanism and its two ratios moved to the Music ⓘ panel (catalogue.js
 * howItRuns, UI_PLAN C2); the note keeps the plain half: slower, same audio. */
ok("...and the cost of the change in plain words, the internals left to the ⓘ panel",
  /slower/i.test(long.info.lines[1]) && /same audio/.test(long.info.lines[1])
  && !/512-token|2\.65×|prefill/.test(long.info.lines.join(" ")));
ok("...right up to the long reach itself",
  fit(264.6).rung.id === "long" && fit(264.6).ceiling === null);

const mem = fit(300);
ok("past every measured reach, the ceiling is named memory",
  mem.ceiling === "memory", mem.ceiling);
ok("...and it promotes to the rung that lowers the binding stage — the block, not fp8",
  mem.promoted && mem.rung.id === "long", mem.rung.id);
ok("...and the box admits the reach is untested past the measured point",
  /The longest song rendered here is 4:25/.test(mem.info.lines.join(" "))
  && /an attempt rather than a promise/.test(mem.info.lines.join(" ")));
ok("...and names the stage that limits length",
  /synthesis prefill/.test(mem.info.lines.join(" ")));
/* ⚠ THE ONE THAT MATTERS, INVERTED. The first version of this test forbade the
 * box from offering a configuration as the cure for length, because the only
 * configurations it knew did not cure it. The lever it now names was measured
 * to: the same plan that died at the default rendered at 512. The box must say
 * so, must say the number is a projection past that point, and must not send a
 * song under the cap to be rendered in sections. */
ok("...and names the configuration measured to the reach, and where the default died",
  /whole-sequence default grows with the square of the song and died at 3:14/.test(mem.info.lines.join(" "))
  && /measured to 4:25/.test(mem.info.lines.join(" ")));
ok("...and quotes a projected peak, labelled as an estimate with both measured slopes",
  /Projected peak at 5:00/.test(mem.info.lines.join(" "))
  && /not a measurement/.test(mem.info.lines.join(" "))
  && mem.info.lines.join(" ").includes(`${PREFILL_MIB_PER_SECOND} MiB`)
  && mem.info.lines.join(" ").includes(`${CHUNK_ATTENTION_MIB_PER_SECOND} MiB`));
ok("...and does not send a song under the cap to sections",
  !/render the song in sections/.test(mem.info.lines.join(" ")));
ok("...and does not claim the old wall",
  !/not a setting/.test(mem.info.lines.join(" ")));

const gen = fit(400);
ok("past 360 s the ceiling is the generation cap, not memory",
  gen.ceiling === "generation", gen.ceiling);
/* ⚠ THE BOX AND THE JOB ARE ONE DECISION. fit() owns the raised stop through
 * maxTokensFor(), /api/generate sends exactly that, and the box describes the
 * length that is about to be attempted — not a 360 s song that will not
 * happen, and not the wish either. */
ok("...and fit() names the raised stop it will ask for, in tokens",
  gen.maxTokens === maxTokensFor(400) && gen.maxTokens === Math.ceil(400 * TOKENS_PER_AUDIO_SECOND * 1.08),
  String(gen.maxTokens));
ok("...and the box says the 9000 is a default the render raises, not a limit of the card",
  /a default, not a limit of your card/.test(gen.info.lines.join(" "))
  && new RegExp(`asks the sampler for ${gen.maxTokens} tokens`).test(gen.info.lines.join(" ")));
ok("...and that the vendor validated nothing past it",
  /validated nothing past 6:00/.test(gen.info.lines.join(" ")));
ok("...and the rung is the one the memory rule picks for the attempted length",
  gen.rung.id === "long" && fit(GENERATION_CAP_SECONDS).rung.id === "long");
ok("...and the box quotes the ATTEMPTED duration — 400 s + 8 % — not the wish and not 6:00",
  /treat 7:12 as an attempt/.test(gen.info.lines.join(" ")),
  "a box that says \"treat 6:40 as an attempt\" or \"treat 6:00\" is describing a length that will not be attempted");
ok("...with the projection at the attempted length, under the cap",
  /Projected peak at 7:12/.test(gen.info.lines.join(" ")) && /should fit/.test(gen.info.lines.join(" ")));
ok("...and does NOT send a song the sampler can reach to sections",
  !/sections/.test(gen.info.lines.join(" ")));
ok("maxTokensFor is 0 at and under the vendor's stop, and capped under the context window",
  maxTokensFor(360) === 0 && maxTokensFor(120) === 0 && maxTokensFor("x") === 0
  && maxTokensFor(983) === CONTEXT_FRAMES - 2600 && maxTokensFor(361) === Math.ceil(361 * 25 * 1.08));

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
ok("an RTX 30-series card gets the long rung, which needs no special kernels",
  old.rung.quantization !== "fp8" && old.rung.id === "long" && old.rung.offloadAr === true, old.rung.id);
ok("an RTX 40-series card gets the same rung for length — fp8 is never a length answer",
  fit(200, { capability: [8, 9] }).rung.id === "long" && fit(200, { capability: [9, 0] }).rung.id === "long");
/* The gate itself, on its own: since fit() never answers a length with fp8, the
 * only way to see the gate is to ask it directly — which is also what the
 * precision chooser on the Create form does. */
ok("the gate excludes fp8 on an older card",
  fp8Allowed([8, 6]) === false && fp8Allowed([7, 5]) === false);
ok("...and admits it on 8.9 or newer, and when the capability is unknown",
  fp8Allowed([8, 9]) === true && fp8Allowed([9, 0]) === true && fp8Allowed(null) === true);
ok("the ladder offered to an older card has no fp8 rung, and keeps the other two",
  usableRungs([8, 6]).map((r) => r.id).join(",") === "standard,long");
ok("...and a 40-series card is offered all three",
  usableRungs([8, 9]).map((r) => r.id).join(",") === "standard,long,compact");
ok("a ladder with every rung gated off still answers with its first rung, not undefined",
  fit(100, { capability: [8, 6], rungs: [RUNGS[2]] }).rung.id === "compact");
ok("the gate matches the vendor's own comparison",
  FP8_MIN_CAPABILITY[0] === 8 && FP8_MIN_CAPABILITY[1] === 9);

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
  const said = r.info && /an attempt rather than a promise|expect the song to end|clamped/i
    .test(r.info.lines.join(" "));
  if (!said) silent.push(s);
}
ok(`every duration beyond a measured reach (${unproven} of them) says so`,
  silent.length === 0, silent.length ? `silent at: ${silent.slice(0, 8).join(", ")}` : "");
ok("...and every projected figure in a box is labelled as one",
  [200, 300, 360, 400].every((s) => {
    const t = fit(s).info.lines.join(" ");
    return !/Projected peak/.test(t) || /not a measurement/.test(t);
  }));

ok("no rung carries a reachSeconds it did not measure",
  RUNGS.every((r) => r.reachSeconds === null || /MEASURED/.test(r.reachFrom)));
/* The 1438 s figure is the exact wrong answer this module was written to avoid
 * printing. If someone later "fixes" the nulls by dividing bytes by the K/V
 * coefficient, this fails and the comment explains why. */
ok("the module records the estimate it refused to print",
  /1438/.test(SRC) && /plainly\s+\*?\s*false/.test(SRC));
ok("...and records that the missing term was found, next to the rule it did not change",
  /MISSING TERM WAS FOUND/.test(SRC));

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
