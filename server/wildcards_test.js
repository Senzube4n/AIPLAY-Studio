/**
 * Dynamic prompts and the duplicate guard.
 *
 * Both have closed-form answers, so both are checked against arithmetic and
 * exact strings rather than against themselves. The cases that matter are the
 * ones a template hits in real use: the empty option, which is the whole reason
 * the syntax is worth having; the punctuation it strands; and replay, which is
 * the only thing that makes an overnight run reproducible.
 *
 * Runs standalone (`node server/wildcards_test.js`) and in the pre-commit hook.
 * Touches no disk at all.
 */
import {
  hasWildcards, expand, enumerate, combinations,
  jobIdentity, createDuplicateGuard, resolveRepeat,
} from "./wildcards.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Deterministic pickers, so every expansion below is an exact expectation. */
const first = () => 0;
const last = (n) => n - 1;

console.log("\n  -- parsing --");
ok("a prompt with no group is left exactly alone",
  expand("a plain prompt").prompt === "a plain prompt");
ok("hasWildcards agrees", !hasWildcards("a plain prompt") && hasWildcards("a {x|y} prompt"));
ok("one group picks one option", expand("a {red|blue} car", { pick: first }).prompt === "a red car");
ok("...and records WHICH, because that is what makes it reproducible",
  eq(expand("a {red|blue} car", { pick: last }).choices, [1]));

ok("groups nest, and the inner one is resolved too",
  expand("{photo|{oil painting|watercolour}}", { pick: last }).prompt === "watercolour");
ok("a `|` inside a nested group does not split the outer one",
  combinations("{a|{b|c}}") === 3,
  "two options at the top level, one of which has two — if the outer split saw the inner "
  + "`|` it would count differently");

console.log("\n  -- the empty option, which is the point --");
ok("an empty option is legal and yields nothing",
  expand("x{ hat|}", { pick: last }).prompt === "x");
ok("...and enumerate() lists it as a real outcome",
  eq(enumerate("x, {hat|scarf|}").prompts, ["x, hat", "x, scarf", "x"]));
ok("the separator the vanished option owned goes with it",
  expand("a {red|} car, {in the rain|}, lit well", { pick: last }).prompt === "a car, lit well",
  "otherwise the model reads 'a car, , lit well'");
ok("...including a leading one",
  expand("{|}, trailing", { pick: first }).prompt === "trailing");
ok("...and an emptied parenthetical, which promised a detail and delivered none",
  expand("portrait ({smiling|}) of a woman", { pick: last }).prompt === "portrait of a woman");

console.log("\n  -- escapes and malformed input --");
ok("an escaped brace stays a literal brace",
  expand("a \\{literal\\} brace").prompt === "a {literal} brace");
ok("an unbalanced brace is literal text, not an error",
  expand("what { is this").prompt === "what { is this");
ok("an unterminated group does not hang the expander",
  typeof expand("{a|{b").prompt === "string");
ok("neither does a pathological nest",
  typeof expand("{".repeat(60) + "x" + "}".repeat(60)).prompt === "string");

console.log("\n  -- replay: the reason any of this is worth doing --");
{
  const t = "a {red|blue|} car {in the rain|}, {photo|{oil|water}colour}";
  const runs = Array.from({ length: 6 }, () => expand(t));
  ok("replaying the recorded choices reproduces the prompt EXACTLY",
    runs.every((r) => expand(t, { replay: r.choices }).prompt === r.prompt));
  ok("...which is what makes one frame of an overnight run recoverable",
    new Set(runs.map((r) => r.prompt)).size > 1, "and the run still varies");
  ok("a replay that runs out expands the rest fresh rather than throwing",
    typeof expand(t, { replay: [0] }).prompt === "string");
  ok("an out-of-range recorded choice is re-picked, not crashed on",
    typeof expand(t, { replay: [99, -1, 0, 0] }).prompt === "string");
  ok("combinations() counts without enumerating", combinations(t) === 3 * 2 * 3);
  ok("enumerate() agrees with it", enumerate(t).prompts.length === combinations(t));
}
ok("enumerate() caps, and SAYS it capped rather than looking complete",
  enumerate("{a|b}{c|d}{e|f}{g|h}{i|j}{k|l}{m|n}{o|p}", 20).truncated === true);

console.log("\n  -- the duplicate guard --");
const job = { engine: "checkpoint", checkpoint: "x.safetensors", prompt: "a cat",
              seed: 4242, width: 1024, height: 1024, steps: 28, cfg: 6 };
ok("identity ignores what does not change the pixels",
  jobIdentity({ ...job, title: "a" }) === jobIdentity({ ...job, title: "b" }));
ok("...and notices everything that does",
  new Set([
    jobIdentity(job),
    jobIdentity({ ...job, seed: 1 }), jobIdentity({ ...job, steps: 29 }),
    jobIdentity({ ...job, cfg: 6.5 }), jobIdentity({ ...job, width: 512 }),
    jobIdentity({ ...job, prompt: "a dog" }), jobIdentity({ ...job, negative: "blurry" }),
    jobIdentity({ ...job, checkpoint: "y.safetensors" }), jobIdentity({ ...job, engine: "flux2" }),
    jobIdentity({ ...job, refImages: ["a.png"] }),
  ]).size === 10);
{
  const g = createDuplicateGuard();
  ok("a first render is never a repeat", !g.check(job).repeat);
  g.remember(job);
  ok("...the same one again is", g.check(job).repeat);
  ok("...and a different EXPANSION of the same template is not",
    !g.check({ ...job, prompt: "a dog" }).repeat,
    "two expansions are two pictures; the template is not the identity");

  let n = 0;
  const r = resolveRepeat(job, g, { rand: () => 7000 + (++n) });
  ok("a repeat with a fixed seed is re-rolled rather than re-rendered", r.changed && r.job.seed === 7001);
  ok("...and says so, so the moved seed is never a silent change", /rolled a fresh one/.test(r.note));
  ok("...leaving every other field alone",
    r.job.prompt === job.prompt && r.job.steps === job.steps && r.job.cfg === job.cfg);

  const refused = resolveRepeat(job, g, { reroll: false });
  ok("refuse mode refuses instead, and does not touch the seed",
    refused.refused && !refused.changed && refused.job.seed === 4242);
  ok("...naming every field that made it a duplicate", /model, prompt, seed, size, steps and cfg/.test(refused.note));

  const exhausted = resolveRepeat(job, g, { rand: () => 4242 });
  ok("a picker that cannot find a free seed gives up and says so, rather than looping",
    exhausted.refused && /eight tries/.test(exhausted.note));
}
{
  const g = createDuplicateGuard({ limit: 3 });
  for (let i = 0; i < 10; i++) g.remember({ ...job, seed: i });
  ok("the memory is bounded — an overnight run cannot grow it forever", g.size === 3);
  ok("...and it is the OLDEST that is forgotten", g.check({ ...job, seed: 9 }).repeat && !g.check({ ...job, seed: 0 }).repeat);
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
