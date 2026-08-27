/**
 * Did the picture come back with what was asked for — the bookkeeping half.
 *
 * The judging cannot be tested here, because the judging is a look and there is
 * no vision model on this machine. What CAN be tested is everything around the
 * look, and that is where this would fail quietly: a verdict that outlives the
 * picture it judged, a pass that carries a named defect, a checklist that grew
 * after someone signed off on the short version.
 *
 * Each of those is a way for "checked" to become a lie, which is worse than
 * never having checked — an unchecked picture gets looked at, a wrongly-passed
 * one does not.
 *
 * Runs standalone (`node server/review_test.js`) and in the pre-commit hook.
 * Writes one file under the OS temp dir and deletes it.
 */
import { createReviewStore, reviewState, cleanExpect, makeThumbnailer, suggestExpect } from "./review.js";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const FILE = path.join(tmpdir(), `aiplay_review_test_${process.pid}.json`);
const NAME = "im_test.png";

console.log("\n  -- the checklist --");
ok("blanks and whitespace-only entries are dropped",
  eq(cleanExpect(["six strings", "  ", "", null]), ["six strings"]));
ok("...and a repeat is one expectation, however it was cased",
  eq(cleanExpect(["Six Strings", "six strings"]), ["Six Strings"]));
ok("...and the list is bounded, so a runaway caller cannot grow the file forever",
  cleanExpect(Array.from({ length: 100 }, (_, i) => `item ${i}`)).length === 24);
ok("a non-array is an empty checklist rather than a throw",
  eq(cleanExpect("six strings"), []) && eq(cleanExpect(undefined), []));

console.log("\n  -- the checklist that writes itself --");
{
  const has = (p, frag) => suggestExpect(p).some((e) => e.includes(frag));
  /* The two failures on the picture that started this feature. If the
   * suggester cannot name these from the prompt alone, it is not earning its
   * place in the flow. */
  const guitarHands = "wide cinematic still, close on hands playing an electric guitar neck";
  ok("a close-up of hands on a guitar proposes BOTH failures that actually happened",
    has(guitarHands, "four fingers and a thumb") && has(guitarHands, "six strings"),
    suggestExpect(guitarHands).join(" | "));
  ok("an album cover proposes the lettering check",
    has("album cover, a worn sunburst electric guitar", "garbled lettering"));
  ok("a bass is four strings, not six",
    has("a bass guitar on a stand", "four strings on the bass"));

  /* False positives are the whole risk. A checklist that cries wolf gets
   * cleared without being read, and then it is worse than no checklist. */
  ok("a MOUNTAIN face does not propose checking its eyes",
    !has("a lone figure at the foot of an immense pale mountain face", "eyes matched"),
    "the first version of this suggested checking the eyes on a mountain");
  ok("...nor a cliff face, nor the north face of a ridge",
    !has("a cliff face in fog", "eyes matched") && !has("the north face of the ridge", "eyes matched"));
  ok("a portrait still does", has("a portrait of a woman by a window", "eyes matched"));
  ok("a prompt with nothing countable, no anatomy and no text proposes nothing",
    suggestExpect("tangled copper wire coiled on a wet dark surface, amber highlights").length === 0,
    "which is the honest answer — that picture came back correct");
  ok("substrings do not trigger a check",
    suggestExpect("a bassoon in a handsome brass stand").length === 0,
    "bassoon is not a bass and handsome is not a hand — the word boundaries "
    + "in those patterns are load-bearing, and were silently eaten once already");
  ok("a non-string is an empty list rather than a throw",
    suggestExpect(null).length === 0 && suggestExpect(undefined).length === 0);
}

console.log("\n  -- the states, and why the default is not 'fine' --");
{
  const store = createReviewStore(FILE);
  await store.expect(NAME, ["six strings", "five fingers per hand"]);
  let e = await store.get(NAME);
  ok("a picture nobody looked at is UNCHECKED, never a pass",
    reviewState(e) === "unchecked",
    "the whole point: silence is not approval");

  /* THE ONE THAT MATTERS MOST. A caller that says ok:true and then names a
   * defect has contradicted itself, and the contradiction resolves to fail —
   * because a pass-with-notes is exactly how a known defect travels downstream
   * without anyone stopping it. */
  await store.verdict(NAME, { ok: true, failed: ["only five strings visible"], by: "agent:test" });
  e = await store.get(NAME);
  ok("ok:true with a named failure is recorded as a FAIL",
    e.verdict.ok === false && reviewState(e) === "fail",
    "a pass that carries a defect is how the defect gets shipped");
  ok("...and the defect keeps its own words, which is what the next prompt needs",
    eq(e.verdict.failed, ["only five strings visible"]));

  await store.verdict(NAME, { ok: true, failed: [], by: "user" });
  e = await store.get(NAME);
  ok("a clean verdict passes", reviewState(e) === "pass");
  ok("...and records WHO looked, because an agent's look and a person's differ",
    e.verdict.by === "user");
}

console.log("\n  -- a verdict must not outlive what it judged --");
{
  const store = createReviewStore(FILE);
  await store.expect(NAME, ["six strings"]);
  await store.verdict(NAME, { ok: true, by: "user" });
  let e = await store.get(NAME);
  /* The verdict above was given without a file, so it has no fingerprint and
   * nothing to compare — the checklist test below is what catches it. */
  await store.expect(NAME, ["six strings", "no visible text"]);
  e = await store.get(NAME);
  ok("growing the checklist makes an existing verdict STALE",
    reviewState(e) === "stale",
    "a pass on one expectation is not a pass on two");

  await store.verdict(NAME, { ok: true, by: "user" });
  e = await store.get(NAME);
  ok("...and judging again against the longer list clears it", reviewState(e) === "pass");

  /* Fingerprint drift: the same name, different bytes. A re-render reuses a
   * name and the old verdict would otherwise vouch for a picture it never
   * saw — which is the failure this app would never have noticed. */
  e.verdict.fingerprint = { size: 1000, mtime: 5000 };
  ok("a file that changed under a verdict makes it STALE",
    reviewState(e, { size: 2000, mtime: 5000 }) === "stale");
  ok("...and matching bytes keep it valid",
    reviewState(e, { size: 1000, mtime: 5000 }) === "pass");
  ok("...while knowing nothing about the file does not invent staleness",
    reviewState(e, null) === "pass",
    "absence of evidence is not evidence the picture moved");
}

console.log("\n  -- persistence and clearing --");
{
  const store = createReviewStore(FILE);
  const reloaded = createReviewStore(FILE);
  const e = await reloaded.get(NAME);
  ok("a verdict survives a restart", Boolean(e && e.verdict));
  ok("...and so does the checklist it was given against", (e.expect || []).length === 2);
  ok("clearing removes it", await store.clear(NAME) === true);
  ok("...and clearing what is not there says so rather than throwing",
    await store.clear("nope.png") === false);
  ok("an unknown image is null, not an empty pass",
    await store.get("nope.png") === null);
}

console.log("\n  -- the thumbnailer's failure is legible --");
{
  const thumb = makeThumbnailer("definitely_not_a_python_on_this_box.exe");
  let msg = "";
  try { await thumb(path.join(tmpdir(), "nothing.png")); } catch (err) { msg = err.message; }
  ok("a missing python is reported, not swallowed into a silent text-only reply",
    /could not run python/i.test(msg), msg);
}

await rm(FILE, { force: true });
console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
