/**
 * THE BLOCKOUT DOOR — the second way frames reach a control render, and the
 * refusals that keep it from becoming the softer way.
 *
 * server/control/control_test.js already proves the GATE: given numbers, which
 * clips are legal. server/mv/ui_test.js proves both surfaces can send
 * `source`. Neither can see the thing this file is for — that naming a shot
 * really does resolve to a file on disk, that the same ffprobe gate runs on it,
 * and that every way of asking for the wrong thing is answered with a sentence
 * rather than with a render.
 *
 * ⚠ THE CLIPS HERE ARE FORGED WITH ffmpeg, NOT RENDERED WITH BLENDER, and that
 * is deliberate: this file must run in the pre-commit hook on a machine with no
 * Blender at all. One clip is exactly in spec and one is wrong on every axis at
 * once — the same trick previz/verify_test.py plays for the same reason, and it
 * is what lets the green path and the refused path both be real measurements
 * rather than mocks. If ffmpeg is absent the clip half SKIPS LOUDLY and says
 * how many assertions it did not make; the resolution half needs nothing.
 *
 * Runs standalone (`node server/mv/blockout_test.js`). Writes only into a temp
 * directory, which it removes.
 */
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* The output dir MUST be decided before config.js is first imported, and static
 * imports hoist — so every import below is dynamic. Same discipline as
 * server/mv/plan_test.js, for the same reason. */
const OUT = path.join(os.tmpdir(), `mv-blockout-test-${process.pid}-${Date.now().toString(36)}`);
process.env.AIPLAY_OUTPUT = OUT;
process.env.AIPLAY_APPDATA = path.join(OUT, "appdata");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const store = await import("./store.js");
const { controlRender, controlCatalogue, CONTROL_SOURCES } = await import("./control.js");
const { CONTROL_SPEC } = await import("../control/control.js");

const PREVIZ = readFileSync(path.join(HERE, "previz.js"), "utf8");
const CTL = readFileSync(path.join(HERE, "control.js"), "utf8");

let pass = 0, skipped = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
/** The message of the throw, or null when it did not throw. */
async function why(fn) {
  try { await fn(); return null; } catch (err) { return String(err.message); }
}
const names = (msg, ...want) => !!msg && want.every((w) => msg.includes(w));

const run = (bin, args) => new Promise((resolve) => {
  execFile(bin, args, { timeout: 120_000, maxBuffer: 8 << 20 },
    (err) => resolve(!err));
});

/* ── fixtures ─────────────────────────────────────────────────────────────
 * A project, a segment, and an assets folder — the shape previz_shot writes
 * into, built here rather than by running Blender. */
const SLUG = "blockout-test";
mkdirSync(OUT, { recursive: true });
await store.createProject("Blockout Test");
const seg = { id: "seg_a", index: 0, mode: "generate", durationSec: 5,
              startSec: 0, endSec: 5, lyricText: "" };
await store.updateProject(SLUG, (d) => {
  d.segments = [seg, { ...seg, id: "seg_b", index: 1 }];
  return d;
});
const ASSETS = store.assetsDir(SLUG);
mkdirSync(ASSETS, { recursive: true });
const CLIPS = path.join(OUT, "clips");
mkdirSync(CLIPS, { recursive: true });
const deps = { CLIP_DIR: CLIPS };

const GOOD = path.join(ASSETS, "blockout_s1_corridor_push_in.mp4");
const BAD = path.join(ASSETS, "blockout_s1_room_orbit.mp4");
/* Exactly the contract, forged: the same three numbers server/control/control.js
 * measures, so a pass here is the real gate passing and not a stub agreeing. */
const haveFfmpeg = await run("ffmpeg", [
  "-v", "error", "-y", "-f", "lavfi",
  "-i", `testsrc=size=${CONTROL_SPEC.width}x${CONTROL_SPEC.height}:rate=${CONTROL_SPEC.fps}`,
  "-frames:v", String(CONTROL_SPEC.minFrames), "-pix_fmt", "yuv420p", "-c:v", "libx264", GOOD,
]);
if (haveFfmpeg) {
  await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi",
    "-i", "testsrc=size=320x176:rate=30", "-frames:v", "10",
    "-pix_fmt", "yuv420p", "-c:v", "libx264", BAD]);
} else {
  writeFileSync(GOOD, "not a clip");
  writeFileSync(BAD, "not a clip");
}

const rowFor = (over = {}) => ({
  id: `pz_${path.basename(over.clipFile || GOOD, ".mp4")}`,
  segmentId: "seg_a", segmentIndex: 0, kind: "blockout",
  move: "push_in", scene: "corridor", frames: CONTROL_SPEC.minFrames,
  use: "vace-control", clipFile: path.basename(GOOD),
  trackFile: null, sidecarFile: `${path.basename(GOOD)}.blockout.json`,
  specFile: `${path.basename(GOOD)}.spec.json`,
  specSha256: "24429524c0e5000000000000000000000000000000000000000000000000abcd",
  figures: [{ id: "kaya", onScreen: 1 }],
  at: 1000, ...over,
});

console.log("\n-- the design, in the source --");

ok(`the source table is data, and it names both doors (${CONTROL_SOURCES.length})`,
  CONTROL_SOURCES.length === 2
  && CONTROL_SOURCES.some((x) => x.source === "clip")
  && CONTROL_SOURCES.some((x) => x.source === "blockout"),
  "a page builds its picker from this; a list typed into the page goes stale");

ok("...and the catalogue hands it to both surfaces",
  Array.isArray(controlCatalogue().sources)
  && controlCatalogue().sources.length === CONTROL_SOURCES.length);

/* ⚠ THE DESIGN DECISION, PINNED. A blockout is resolved out of the project's
 * own record; it is NOT copied onto the shared clips shelf. That shelf is what
 * import_clip offers as a scene's TAKE, so a grey-box clip sitting on it makes
 * "the boxes ended up in the finished film" one mis-click. If a later edit
 * moves a blockout into CLIP_DIR, this is the line that should stop it. */
ok("a blockout is resolved from the project's assets, never shelved in the clips library",
  /assetsDir\(slug\), path\.basename\(name\)/.test(CTL)
  && !/CLIP_DIR[^\n]*blockout/i.test(CTL),
  "the clips library is shared with Studio, the compositor and import_clip — a "
  + "grey-box clip on that shelf is one mis-click from the finished film");

ok("...and previz.js writes it to the project's assets, not to the library",
  /assetsDir\(slug\)/.test(PREVIZ) && !/CLIP_DIR/.test(PREVIZ));

console.log("\n-- resolving this shot's blockout --");

let msg = await why(() => controlRender(deps, SLUG, { source: "sideways", clip: "x.mp4" }));
ok("an unknown source is refused, naming the ones there are",
  names(msg, "sideways", "clip", "blockout"), msg);

msg = await why(() => controlRender(deps, SLUG, { source: "blockout", segmentId: "seg_a", mode: "check" }));
ok("a shot with no blockout is refused, and the refusal says how to make one",
  names(msg, "no blockout", "previz_shot", "blockout: true"), msg);

await store.updateProject(SLUG, (d) => { d.previz = [rowFor()]; return d; });

msg = await why(() => controlRender(deps, SLUG, {
  source: "blockout", segmentId: "seg_a", clip: "somethingelse.mp4", mode: "check" }));
ok("a `clip` handed to the blockout door is REFUSED, not ignored",
  names(msg, "somethingelse.mp4", "nowhere to go"),
  "silently dropping an argument somebody typed is how a person concludes it did nothing");

msg = await why(() => controlRender(deps, SLUG, { source: "blockout", segmentId: "seg_b", mode: "check" }));
ok("...and a DIFFERENT shot's blockout is not offered as this shot's",
  names(msg, "no blockout") && names(msg, "other shots"),
  "a blockout belongs to the shot it was staged for; borrowing one silently "
  + "would steer scene 2 with scene 1's blocking");

for (const mode of ["pose", "extract"]) {
  msg = await why(() => controlRender(deps, SLUG, {
    source: "blockout", segmentId: "seg_a", mode, prompt: "a woman walking" }));
  ok(`mode "${mode}" on a blockout is refused before the half minute is spent`,
    names(msg, "grey capsules", "camera"),
    "DWPose would find no person on any frame, write a skeleton of empty frames "
    + "that PASSES the clip gate, and steer the render with a blank");
}

console.log("\n-- the same gate, through the other door --");

let out = await controlRender(deps, SLUG, { source: "blockout", segmentId: "seg_a", mode: "check" });
ok("the blockout door reports which door it was, and which blockout",
  out.source === "blockout" && out.clip === path.basename(GOOD)
  && out.blockout?.move === "push_in" && out.blockout?.scene === "corridor");

ok("...and carries the staging's identity, so the render is EXPLICABLE later",
  out.blockout?.specSha256 === rowFor().specSha256
  && out.blockout?.sidecarFile === rowFor().sidecarFile,
  "a control render is reproducible from its seed; it is only explicable from "
  + "what the control clip WAS, and for a blockout that is a spec hash");

if (haveFfmpeg) {
  ok("...and the clip really is measured — the three numbers come back",
    out.ok === true && out.validation.width === CONTROL_SPEC.width
    && out.validation.height === CONTROL_SPEC.height
    && out.validation.fps === CONTROL_SPEC.fps
    && out.validation.frames === CONTROL_SPEC.minFrames,
    JSON.stringify(out.validation) + " " + (out.why || ""));

  await store.updateProject(SLUG, (d) => {
    d.previz = [rowFor({ clipFile: path.basename(BAD), id: "pz_bad", at: 2000 })];
    return d;
  });
  out = await controlRender(deps, SLUG, { source: "blockout", segmentId: "seg_a", mode: "check" });
  ok("...and an out-of-spec blockout is refused by NUMBER, in the gate's own words",
    out.ok === false && names(out.why, "CONTROL CLIP OUT OF SPEC",
      `must be exactly ${CONTROL_SPEC.width}`, `at least ${CONTROL_SPEC.minFrames}`),
    out.why || "it passed");

  msg = await why(() => controlRender(deps, SLUG, {
    source: "blockout", segmentId: "seg_a", mode: "camera", prompt: "a corridor" }));
  ok("...and a RENDER on that blockout throws the same sentence, before the GPU",
    names(msg, "CONTROL CLIP OUT OF SPEC"), msg,
  );
} else {
  skipped += 4;
  console.log("  SKIP  the clip half — ffmpeg is not on PATH, so no fixture could be forged.\n"
    + "          4 assertions were NOT made. Install ffmpeg to run them.");
}

console.log("\n-- newest wins, and the others are still named --");

await store.updateProject(SLUG, (d) => {
  d.previz = [
    rowFor({ id: "pz_old", move: "orbit", at: 1000 }),
    rowFor({ id: "pz_new", move: "push_in", at: 5000 }),
  ];
  return d;
});
out = await controlRender(deps, SLUG, { source: "blockout", segmentId: "seg_a", mode: "check" });
ok("the newest blockout on a shot is the one that steers",
  out.blockout?.id === "pz_new",
  "it is the only rule a person can predict without reading the code — they "
  + "just rendered it");
ok("...and the ones not chosen are reported rather than being invisible",
  out.blockout?.candidates?.length === 2
  && out.blockout.candidates.some((c) => c.id === "pz_old"));

await store.updateProject(SLUG, (d) => {
  d.previz = [rowFor({ id: "pz_gone", clipFile: "vanished.mp4" })];
  return d;
});
msg = await why(() => controlRender(deps, SLUG, { source: "blockout", segmentId: "seg_a", mode: "check" }));
ok("a row whose file is gone says so, instead of failing inside ffprobe",
  names(msg, "vanished.mp4", "not on disk"), msg);

console.log("\n-- the library door still works exactly as it did --");

msg = await why(() => controlRender(deps, SLUG, { mode: "check" }));
ok("the default source is still the clips library, and it still wants a name",
  names(msg, "Give `clip`"), msg);

msg = await why(() => controlRender(deps, SLUG, { clip: "nope.mp4", mode: "check" }));
ok("...and a name that is not on the shelf is still refused as a library name",
  names(msg, "nope.mp4", "clips library"), msg);

rmSync(OUT, { recursive: true, force: true });

console.log(`\n${pass} passed, ${failures.length} failed`
  + (skipped ? `, ${skipped} skipped` : ""));
for (const f of failures) console.log(`  FAILED: ${f}`);
process.exit(failures.length ? 1 : 0);
