/**
 * Key, tempo, meter and the sampler's dials, 2026-09-17.
 *
 * Pinned: seedScore writes the planner's own header layout and nothing after
 * "% intro", refuses a bad key / tempo / meter by sentence, and returns null
 * when nothing was asked; the route seeds only without a score and with the
 * plan on, marks the seed open, and range-checks the dials with the vendor's
 * limits; the door and the job pump hand the dials to the driver as JSON; the
 * driver refuses unknown dial keys by name; the tab, make_song and the doc
 * name every field. No card.
 */
import fs from "node:fs";
import { seedScore, SEED_METERS } from "./seed.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

console.log("\n§1  the seed is the planner's own header, left open");
{
  const s = seedScore({ key: "Em", bpm: 92, meter: "4/4" });
  eq("headers, in the planner's order, then % intro and nothing after",
    s, 'X:1\nT:\nM:4/4\nL:1/32\nQ:1/4=92\nV: Vocal clef=treble name="Vocal Melody" snm="Vocal"\nV: Ins clef=treble name="Ins Melody" snm="Inst."\nK:Em\n% intro\n');
  ok("a key alone seeds, with the defaults for the rest",
    /^X:1\nT:\nM:4\/4\nL:1\/32\nQ:1\/4=120\n/.test(seedScore({ key: "Bb" })) && /\nK:Bb\n% intro\n$/.test(seedScore({ key: "Bb" })));
  ok("nothing asked, nothing seeded", seedScore({}) === null && seedScore({ key: "", bpm: "", meter: "" }) === null);
  const refuses = (o, re) => { try { seedScore(o); return false; } catch (e) { return re.test(e.message); } };
  ok("a bad key is refused by sentence", refuses({ key: "H" }, /key must be a letter/) && refuses({ key: "E minor" }, /key must be/));
  ok("a bad tempo is refused by sentence", refuses({ bpm: 39 }, /bpm must be/) && refuses({ bpm: 120.5 }, /bpm must be/));
  ok("a bad meter is refused by sentence", refuses({ meter: "5/4" }, /meter must be one of/));
  eq("the meters offered", SEED_METERS, ["4/4", "3/4", "6/8", "2/4"]);
}

console.log("\n§2  the route, the door, the pump, the driver");
{
  const index = src("../index.js"), yue = src("./yue.js"), jobs = src("../jobs.js"), py = src("./yue_driver.py");
  ok("the route seeds only without a score and with the plan on", /if \(!abc && cot !== "off" && \(body\.key \|\| body\.bpm \|\| body\.meter\)\)/.test(index));
  ok("...and marks the seed open", /abcOpen: !!abc && \(body\.abcOpen === true \|\| seeded\),/.test(index));
  ok("...refusing a bad seed by reason", /reason: "seed"/.test(index));
  ok("...range-checks the dials with the vendor's limits",
    /temperature: dial\(body\.temperature, 0, 5\), top_p: dial\(body\.topP, 0\.01, 1\), top_k: dial\(body\.topK, 1, 32768, true\), repetition_penalty: dial\(body\.repetitionPenalty, 0\.01, 10\)/.test(index));
  ok("...and refuses by reason", /reason: "sampling"/.test(index));
  ok("...enqueuing both dial sets", /sampling, planSampling,\n\s+scoreSlug:/.test(index));
  ok("the door hands the dials to the driver as JSON",
    /\["--sampling", JSON\.stringify\(args\.sampling\)\]/.test(yue) && /\["--plan-sampling", JSON\.stringify\(args\.planSampling\)\]/.test(yue));
  ok("the job pump passes them", /sampling: job\.sampling \|\| null,\n\s+planSampling: job\.planSampling \|\| null,/.test(jobs));
  ok("the driver takes --sampling and --plan-sampling", /add_argument\("--sampling", default="",/.test(py) && /add_argument\("--plan-sampling", default="",/.test(py));
  ok("...refuses unknown dial keys by name", /unknown keys %s; Sampling takes %s/.test(py));
  ok("...merges the performance dials over max_tokens", /semantic_sampling = \{\*\*\(semantic_sampling or \{\}\), \*\*perf\}/.test(py));
  ok("...and hands the planner's to __call__ as abc_sampling", /kwargs\["abc_sampling"\] = plan_dials/.test(py));
  ok("...recording both in the receipt", /"performance": effective\.get\("performance"\),/.test(py) && /"plan": effective\.get\("plan"\),/.test(py));
}

console.log("\n§3  the tab, the tool and the doc");
{
  const html = src("../../web/index.html"), app = src("../../web/app.js"), mcp = src("../mcp.js"), api = src("../../API.md");
  for (const id of ["yKey", "yBpm", "yMeter", "yTemp", "yTopP", "yPlanTemp"]) ok(`the tab has #${id}`, new RegExp(`id="${id}"`).test(html));
  /* Key, tempo and meter are the Python kit's alone since 2026-09-24: the GGUF
   * runtime and the ComfyUI nodes cannot seed an open score, so the rows are
   * tagged data-python-yue and yueSpec() sends them only there. */
  ok("...on YuE2 rows only, and only the Python kit's", /<label for="yKey" data-engine="yue2" data-python-yue hidden>Key<\/label>/.test(html));
  /* The planner dial also waits for a planner: on GGUF and ComfyUI it is off
   * while a score is sung as written (planDialOff, server/music-engine-rows_test.js). */
  ok("yueSpec sends each only when set",
    /if \(\$\("yKey"\)\?\.value\.trim\(\)\) out\.key = \$\("yKey"\)\.value\.trim\(\);/.test(app)
    && /if \(num\("yPlanTemp"\) !== undefined && !\(typeof planDialOff === "function" && planDialOff\(\)\)\) out\.planTemperature = num\("yPlanTemp"\);/.test(app));
  ok("make_song declares key, bpm, meter, temperature, top_p, plan_temperature",
    /key: \{ type: "string", description: "YuE2 only, without abc/.test(mcp) && /bpm: \{ type: "integer", minimum: 40, maximum: 240/.test(mcp)
    && /meter: \{ type: "string", enum: \["4\/4", "3\/4", "6\/8", "2\/4"\]/.test(mcp) && /plan_temperature: \{ type: "number", minimum: 0, maximum: 5/.test(mcp));
  ok("...and forwards them absent unless asked",
    /key: typeof a\.key === "string" && a\.key \? a\.key : undefined,/.test(mcp) && /planTemperature: Number\.isFinite\(a\.plan_temperature\) \? a\.plan_temperature : undefined,/.test(mcp));
  ok("the API doc names them", /### YuE2 controls on `POST \/api\/generate`/.test(api) && /planTemperature/.test(api));
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
