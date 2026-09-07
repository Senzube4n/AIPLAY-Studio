/**
 * Video lab — what survives a restart, and what can be got back when it did not.
 *
 * THE BUG THIS EXISTS FOR. videolab.json came back with `groups: []` while five
 * clips in clips.json still carried full `compare` tags — two comparisons, four
 * arms and one, real GPU minutes, on disk and invisible to both surfaces. The
 * store is rewritten WHOLE on every save and a knob write is enough to trigger
 * one, so a single save from a process holding an empty list erases the record.
 *
 * The repair is not a lock and not a second store: routes.js already tags every
 * finished arm's clip with its group, deliberately, "so the group survives in
 * the library". That tag is a complete arm record, so the list is DERIVABLE and
 * `healGroupsFromClips` derives it.
 *
 * THE FIXTURE IS REAL. The five tags below are the ones this machine's
 * clips.json actually holds for groups cmpmtk4kwfv and cmpmtk50tsc, copied
 * field for field. A fixture invented to match the code proves nothing; this
 * one would have failed if the tag shape in routes.js had been misremembered.
 *
 * NOTHING HERE TOUCHES THE REAL STORE. AIPLAY_APPDATA is pointed at a temp
 * directory BEFORE config.js is imported — which is why every import in this
 * file is dynamic — so both files it reads and the one it writes are scratch.
 *
 * Runs standalone (`node server/videolab/store_test.js`) and in the hook.
 */
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const scratch = await mkdtemp(path.join(tmpdir(), "aiplay-videolab-"));
process.env.AIPLAY_APPDATA = scratch;

/* The five tags, verbatim from ~/.aiplay-studio/clips.json (2026-09-02). Four
 * arms of one comparison and the single arm of a later one — an uneven pair on
 * purpose, because a heal that only handles the tidy case is not a heal. */
const CLIPS = {
  meta: {
    /* An ordinary clip with no comparison on it: the heal must walk past it. */
    "ltx_00001__2x.mp4": { source: "enhance", from: "ltx_00001_.mp4", at: 1787138987193 },
    "vmtk4kwgb.mp4": { compare: {
      group: "cmpmtk4kwfv", config: "h3_quality", label: "H3 · 20 steps, no LoRA",
      engine: "h3", declaredEngine: "h3", steps: 20, width: 1344, height: 768,
      sizeLabel: "1344x768 · 20 steps", seed: 424242, wallSeconds: 255 } },
    "vmtk4qcxa.mp4": { compare: {
      group: "cmpmtk4kwfv", config: "h3_turbo4", label: "H3 · 4-step turbo",
      engine: "h3", declaredEngine: "h3", steps: 4, width: 1344, height: 768,
      sizeLabel: "1344x768 · 4 steps", seed: 424242, wallSeconds: 81 } },
    "vmtk4s33c.mp4": { compare: {
      group: "cmpmtk4kwfv", config: "h3_turbo8", label: "H3 · 8-step turbo",
      engine: "h3", declaredEngine: "h3", steps: 8, width: 1344, height: 768,
      sizeLabel: "1344x768 · 8 steps", seed: 424242, wallSeconds: 119 } },
    "vmtk4un33.mp4": { compare: {
      group: "cmpmtk4kwfv", config: "ltx", label: "LTX 2.5",
      engine: "ltx", declaredEngine: "ltx", steps: null, width: 1280, height: 704,
      sizeLabel: "1280x704 · schedule fixed, no step count", seed: 424242, wallSeconds: 181 } },
    "vmtk50tt2.mp4": { compare: {
      group: "cmpmtk50tsc", config: "h3_turbo4", label: "H3 · 4-step turbo",
      engine: "h3", declaredEngine: "h3", steps: 4, width: 1344, height: 768,
      sizeLabel: "1344x768 · 4 steps", seed: 606060, wallSeconds: 78 } },
  },
  times: { "vmtk4kwgb.mp4": 3 },
};

await writeFile(path.join(scratch, "clips.json"), JSON.stringify(CLIPS, null, 2), "utf8");
/* The store as it was found: knobs kept, groups gone. */
await writeFile(path.join(scratch, "videolab.json"), JSON.stringify({
  knobs: { turbo_shift_video: 0, turbo_shift_audio: 0, ref_image_size: "match" },
  sizes: {}, groups: [],
}, null, 2), "utf8");

const store = await import("./store.js");
const { config } = await import("../config.js");
ok(`the test is isolated (${path.basename(scratch)})`,
  config.paths.appData === scratch && store.storeFile.startsWith(scratch),
  "if this fails, everything below is writing the REAL videolab.json — stop");

/* ── the heal, on load ────────────────────────────────────────────────────── */
await store.load();
const healed = store.listGroups(50);
ok(`load() rebuilt the lost comparisons (${healed.length})`, healed.length === 2,
  healed.map((g) => g.id).join(", ") + " — the tags name two groups");

const big = healed.find((g) => g.id === "cmpmtk4kwfv");
const small = healed.find((g) => g.id === "cmpmtk50tsc");
ok("...both by their real ids", !!big && !!small);
ok("the four-arm comparison came back with four arms", big?.arms.length === 4,
  `got ${big?.arms.length}`);
ok("...and the one-arm one with one", small?.arms.length === 1);
ok("newest first, the order every reader assumes",
  healed[0].id === "cmpmtk50tsc" && healed[1].id === "cmpmtk4kwfv");
ok("a clip with no comparison tag is not a comparison",
  !healed.some((g) => g.arms.some((a) => a.clip === "ltx_00001__2x.mp4")));

/* ── the arms are the RENDER, not a placeholder ───────────────────────────── */
const quality = big?.arms.find((a) => a.id === "h3_quality");
ok("an arm carries the clip it rendered", quality?.clip === "vmtk4kwgb.mp4");
ok("...its wall time, which is half the answer", quality?.wallSeconds === 255);
ok("...its size and step count", quality?.width === 1344 && quality?.height === 768
  && quality?.steps === 20 && quality?.sizeLabel === "1344x768 · 20 steps");
ok("...its engine, and what it was DECLARED as (hybrid resolves)",
  quality?.engine === "h3" && quality?.declaredEngine === "h3");
ok("...and it is done, because a tagged clip is a finished render",
  big?.arms.every((a) => a.status === "done"));
ok("an arm's reason is read back out of catalog.js, not stored twice",
  typeof quality?.why === "string" && quality.why.length > 80);
ok("the seed is recovered from the arms and is ONE seed",
  big?.seed === 424242 && small?.seed === 606060,
  "a comparison on two seeds is not a comparison — if the tags disagree the field is null");

/* ── the timestamp, decoded from the id rather than invented ──────────────── */
ok("the time it ran is decoded from the group id",
  big?.at === 1788355315003 && small?.at === 1788356058060,
  `${big?.at} / ${small?.at} — cmp<base36 Date.now()>`);
ok("...and it survives new Date().toISOString(), which the MCP layer calls",
  healed.every((g) => !Number.isNaN(new Date(g.at).getTime())));

/* ── a healed group ADMITS what it is ─────────────────────────────────────── */
ok("a healed group says it was healed, and what could not come back",
  big?.healed?.includes("clips.json") && /prompt/i.test(big.healed) && /fail/i.test(big.healed));
ok("...and the name it shows is an admission, not an invented prompt",
  typeof big?.prompt === "string" && /recovered/i.test(big.prompt) && big.prompt.length <= 80,
  "the page prints this in bold, sliced to 80 characters");
ok("nothing was invented for the fields the clips never carried",
  big?.seconds === null && big?.firstFrame === null
    && big?.refImages.length === 0 && big?.refAudios.length === 0);
ok("a healed group is not running", healed.every((g) => g.running === false));

/* ── idempotent, and it never overwrites what is already here ─────────────── */
const again = await store.healGroupsFromClips();
ok("running it again rebuilds nothing", again.rebuilt.length === 0 && again.groupsInClips === 2);
ok("...and the list did not grow", store.listGroups(50).length === 2);

/* A verdict lives only in videolab.json. The clips cannot carry one, so a heal
 * that overwrote a group would silently delete somebody's judgement. */
store.remember({ ...big, verdict: { armId: "h3_quality", note: "the bare model wins", by: "human", at: 1 } });
await store.healGroupsFromClips();
ok("a heal never overwrites a group that is already here",
  store.getGroup("cmpmtk4kwfv")?.verdict?.note === "the bare model wins");

/* ── flush() is the handle on the debounce; a sleep tuned to it is not ─────── */
/* save() is debounced 400 ms. This test used to sleep 700 ms and then read the
 * file — and lost that race once, with a 35-minute render keeping the disk
 * busy, reading the new head of the document spliced onto the old tail. A
 * sleep passes on a fast machine and fails on a slow one; flush() resolves
 * when the write has actually landed. */
await store.flush();
const flushed = JSON.parse(await readFile(path.join(scratch, "videolab.json"), "utf8"));
ok("flush() puts the pending write on disk now, verdict included",
  flushed.groups.find((g) => g.id === "cmpmtk4kwfv")?.verdict?.note === "the bare model wins");

/* ── a group missing while others survive is still rebuilt ────────────────── */
const surviving = store.getGroup("cmpmtk50tsc");
await writeFile(path.join(scratch, "videolab.json"), JSON.stringify({
  knobs: {}, sizes: {}, groups: [surviving],
}, null, 2), "utf8");
const fresh = await import(`./store.js?partial=${Date.now()}`);
await fresh.load();
ok("a comparison missing from a file that still has others comes back",
  fresh.listGroups(50).length === 2 && !!fresh.getGroup("cmpmtk4kwfv"));
ok("...and the one that survived was not rebuilt over it",
  fresh.getGroup("cmpmtk50tsc")?.arms[0]?.clip === "vmtk50tt2.mp4");

/* ── and it reaches the disk ──────────────────────────────────────────────── */
await fresh.flush();
const onDisk = JSON.parse(await readFile(path.join(scratch, "videolab.json"), "utf8"));
ok(`videolab.json regained its groups (${onDisk.groups.length})`,
  onDisk.groups.length === 2 && onDisk.groups.some((g) => g.id === "cmpmtk4kwfv"),
  "the whole point: the record is back in the file the app reads at boot");
const left = (await readdir(scratch)).filter((f) => f.includes(".tmp-"));
ok("...written beside the file and renamed over it, so no temp file is left behind",
  left.length === 0, left.join(", "));

/* ── no clips.json at all is a normal first run, not a failure ────────────── */
const empty = await mkdtemp(path.join(tmpdir(), "aiplay-videolab-none-"));
const none = await fresh.healGroupsFromClips({ file: path.join(empty, "clips.json") });
ok("a machine with no clips.json heals nothing and says nothing",
  none.rebuilt.length === 0 && none.groupsInClips === 0);
await rm(empty, { recursive: true, force: true });

await rm(scratch, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
