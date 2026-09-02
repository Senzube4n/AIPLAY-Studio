/**
 * Camera moves — the rig, driven through the real route handler.
 *
 * WHY THROUGH THE ROUTE rather than against the builder alone. Half of what a
 * preset has to get right is not in the builder at all: whether the document
 * SURVIVES being written and read back (migrate() runs on every read and has
 * historically dropped things it did not recognise), whether a move landing on
 * an existing camera goes through set_layer's merge instead of clobbering what
 * was there, and whether the layers come back in an order that makes the new
 * camera the one the comp actually renders through. A pure-builder test passes
 * on all three while the feature is broken.
 *
 * The one thing this file cannot prove is that the EXPRESSIONS evaluate — that
 * sandbox is python, in the engine. scripts/camera_move_proof.mjs renders them
 * and compares pixels; this asserts the document those renders read.
 *
 *   node server/vfx/camera_moves_test.js
 */
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/* Same discipline as camera_test.js: config.js reads the environment once at
 * import, so the scratch directory has to be in place before store.js loads. */
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "vfx_cammove_"));
process.env.AIPLAY_OUTPUT = SCRATCH;

const { createVfxRoutes } = await import("./routes.js");
const { CAMERA_MOVES, CAMERA_MOVE_NAMES } = await import("./cameramoves.js");
const { layerProperties, cameraLens, isKeyed, hasExpr } = await import("./store.js");

let pass = 0;
const failures = [];

function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}\n          got  ${g}\n          want ${w}`); }
}
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
/** The route ANSWERS a refusal (400 + a sentence) rather than throwing it, so
 *  what is asserted here is the sentence a caller actually reads. */
async function refuses(label, fn, needle) {
  let r;
  try { r = await fn(); }
  catch (e) { failures.push(label); console.log(`  FAIL  ${label}\n          threw: ${e.message}`); return; }
  if (r.code === 400 && String(r.payload.error || "").includes(needle)) {
    pass++; console.log(`  ok    ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}\n          code ${r.code}: ${r.payload.error || "accepted"}`);
  }
}

/* ─────────────────────────────────────────────────────────── the harness */

let body = null, captured = null;
const handle = createVfxRoutes({
  json: (_res, code, payload) => { captured = { code, payload }; },
  readBody: async () => body,
  config: { outputDir: SCRATCH, python: "python" },
  IMAGE_DIR: path.join(SCRATCH, "images"),
  CLIP_DIR: path.join(SCRATCH, "clips"),
  art: {},
});

async function post(b) {
  body = b; captured = null;
  const done = await handle({ method: "POST", headers: {} }, {}, new URL("http://x/api/vfx"));
  if (!done) throw new Error(`the route did not handle action "${b.action}"`);
  return captured;
}
const layerOf = (r, id) => r.payload.comp.layers.find((l) => l.id === id);
const named = (r, name) => r.payload.comp.layers.find((l) => l.name === name);

const SLUG = "camera-move-test";

try {
  await post({ action: "create", name: SLUG, width: 1920, height: 1080, fps: 30, duration: 6 });
  /* add_layer seeds the transform and does not take one, so the subject is
   * PLACED with set_layer — the same two calls a person makes. */
  const heroId = (await post({
    action: "add_layer", slug: SLUG, type: "solid", name: "hero", threeD: true,
  })).payload.comp.layers[0].id;
  await post({ action: "set_layer", slug: SLUG, layerId: heroId,
               transform: { position: [900, 500, 0] } });

  console.log("\n  -- the shelf describes itself --");
  eq("five moves, by the names the brief asked for", [...CAMERA_MOVE_NAMES].sort(),
     ["handheld", "offsetFollow", "orbit", "pushIn", "rackFocus"]);
  ok("every move says what it is for, in words a director reads",
     CAMERA_MOVE_NAMES.every((n) => CAMERA_MOVES[n].label && CAMERA_MOVES[n].why?.length > 60));
  ok("...and lists the parameters it takes",
     CAMERA_MOVE_NAMES.every((n) => Array.isArray(CAMERA_MOVES[n].takes) && CAMERA_MOVES[n].takes.length));

  console.log("\n  -- offsetFollow: the note this whole feature exists for --");
  const off = await post({ action: "camera_move", slug: SLUG, move: "offsetFollow", target: "hero" });
  eq("it builds two layers, not one", off.payload.layerIds.length, 2);
  const oCam = layerOf(off, off.payload.cameraId);
  const oAim = layerOf(off, off.payload.aimId);
  ok("a camera and an aim null", oCam.type === "camera" && oAim.type === "null",
     `${oCam.type} / ${oAim.type}`);
  eq("the camera is TOPMOST, so it is the one the comp renders through",
     off.payload.comp.layers[0].id, off.payload.cameraId);
  ok("the lens is aimed at the NULL, not at the subject",
     hasExpr(oCam.camera.pointOfInterest)
     && oCam.camera.pointOfInterest.expr.includes(`layer("${oAim.name}")`),
     JSON.stringify(oCam.camera.pointOfInterest));
  ok("the null sits BESIDE and behind the subject rather than on it",
     hasExpr(oAim.transform.position)
     && /\+ \[[^\]]*[1-9]/.test(oAim.transform.position.expr),
     oAim.transform.position?.expr);
  ok("the aim TRAILS the subject in time",
     oAim.transform.position.expr.includes("valueAtTime(time - 0.15)"),
     oAim.transform.position.expr);
  ok("the body trails by MORE than the aim does — one lag on both is still machinery",
     oCam.transform.position.expr.includes("valueAtTime(time - 0.35)"),
     oCam.transform.position.expr);
  ok("both expressions name the subject readably, not by id",
     oAim.transform.position.expr.includes(`layer("hero")`)
     && oCam.transform.position.expr.includes(`layer("hero")`));
  ok("each expression keeps a real value underneath it, so a deleted subject does not aim at 0,0",
     Array.isArray(oCam.camera.pointOfInterest.value)
     && oCam.camera.pointOfInterest.value.length === 3
     && Array.isArray(oAim.transform.position.value));
  ok("the aim null is 3D, so its z means something", oAim.threeD === true);

  console.log("\n  -- and the timeline can now see every one of those rows --");
  const rows = layerProperties(oCam);
  const camRows = rows.filter((p) => p.group === "Camera").map((p) => p.path);
  ok("the camera enumerates a Camera group at all", camRows.length >= 6, camRows.join(", "));
  ok("...including the aim the rig just wrote", camRows.includes("camera.pointOfInterest"));
  ok("...and the rack-focus row", camRows.includes("camera.focusDistance"));
  eq("the aim row reports itself as expression-driven",
     rows.find((p) => p.path === "camera.pointOfInterest").expr,
     oCam.camera.pointOfInterest.expr);

  console.log("\n  -- orbit --");
  const orb = await post({ action: "camera_move", slug: SLUG, move: "orbit", target: "hero",
                           radius: 1000, degrees: 180, steps: 12, duration: 3, name: "orbit cam" });
  const orbCam = layerOf(orb, orb.payload.cameraId);
  const keys = orbCam.transform.position.keys;
  eq("one key per step, plus the one it starts on", keys.length, 13);
  eq("the first key is a radius in front of the subject, a tenth of the frame above it",
     keys[0].v, [900, 392, -1000]);
  ok("half a turn puts the last key a radius BEHIND it",
     Math.round(keys[12].v[2]) === 1000 && Math.abs(keys[12].v[0] - 900) < 1,
     JSON.stringify(keys[12].v));
  ok("every key sits on the circle",
     keys.every((k) => Math.abs(Math.hypot(k.v[0] - 900, k.v[2] - 0) - 1000) < 1));
  eq("the last key lands at start + duration", keys[12].t, 3);
  ok("the aim stays parked on the subject, so a moving subject stays framed",
     hasExpr(orbCam.camera.pointOfInterest)
     && layerOf(orb, orb.payload.aimId).transform.position.expr.includes(`layer("hero")`));
  ok("a second rig does not collide with the first one's names",
     orb.payload.aimName !== off.payload.aimName, orb.payload.aimName);

  console.log("\n  -- pushIn: a push, not a dolly --");
  const push = await post({ action: "camera_move", slug: SLUG, move: "pushIn", target: "hero",
                            from: 2400, to: 1100, fromFocal: 28, toFocal: 62, name: "push cam" });
  const pCam = layerOf(push, push.payload.cameraId);
  ok("the lens itself is keyframed", isKeyed(pCam.camera.focalLength), JSON.stringify(pCam.camera.focalLength));
  eq("from the wide end to the long one", pCam.camera.focalLength.keys.map((k) => k.v), [28, 62]);
  ok("the camera moves in as well — a lens change alone is a zoom, not a push",
     isKeyed(pCam.transform.position)
     && pCam.transform.position.keys[0].v[2] === -2400
     && pCam.transform.position.keys[1].v[2] === -1100);
  eq("focus follows the move, so the subject stays sharp all the way in",
     pCam.camera.focusDistance.keys.map((k) => k.v), [2400, 1100]);
  eq("the dead spelling of the lens is retired, not left to be read by nothing",
     pCam.camera.zoom, undefined);
  eq("...so the store agrees which lens is live", cameraLens(pCam), "focalLength");
  ok("and the enumerator offers the live spelling only",
     layerProperties(pCam).some((p) => p.path === "camera.focalLength")
     && !layerProperties(pCam).some((p) => p.path === "camera.zoom"));
  eq("the ease is on the key that LEAVES, which is where §1 puts it",
     pCam.camera.focalLength.keys[0].ease, "easeInOut");

  console.log("\n  -- rackFocus, on a camera that already exists and is already rigged --");
  /* The bug this whole change closed was a camera edit destroying an aim. A
   * preset is an edit, so it has to be held to the same standard. */
  const rigged = (await post({
    action: "add_layer", slug: SLUG, type: "camera", name: "rigged cam",
    camera: { zoom: 1500, pointOfInterest: { keys: [{ t: 0, v: [100, 200, 0] }, { t: 2, v: [800, 200, 0] }] },
              blurLevel: 130 },
  })).payload.comp.layers[0];
  const rack = await post({ action: "camera_move", slug: SLUG, move: "rackFocus",
                            camera: "rigged cam", from: 2600, to: 900, duration: 2, aperture: 80 });
  const rCam = layerOf(rack, rack.payload.cameraId);
  eq("it edits the camera rather than making a second one", rack.payload.cameraCreated, false);
  eq("...and adds no layers at all", rack.payload.layerIds.length, 0);
  eq("the keyed aim that was already there SURVIVES the preset",
     rCam.camera.pointOfInterest.keys.length, 2);
  eq("...and so does a field the preset never mentions", rCam.camera.blurLevel, 100);
  eq("focus is keyed between the two depths", rCam.camera.focusDistance.keys.map((k) => k.v), [2600, 900]);
  eq("depth of field is on — without it a rack focus renders nothing", rCam.camera.depthOfField, true);
  ok("...and stays a plain boolean rather than churning into 0/1",
     rCam.camera.depthOfField === true);
  eq("the aperture asked for is the aperture stored", rCam.camera.aperture, 80);
  eq("the lens it already had is untouched", rCam.camera.zoom, 1500);

  console.log("\n  -- a depth can be a LAYER, which is the sentence a director says --");
  const singerId = (await post({ action: "add_layer", slug: SLUG, type: "solid",
                                 name: "singer", threeD: true })).payload.comp.layers[0].id;
  await post({ action: "set_layer", slug: SLUG, layerId: singerId,
               transform: { position: [960, 540, 900] } });
  const rack2 = await post({ action: "camera_move", slug: SLUG, move: "rackFocus",
                             camera: "rigged cam", from: "hero", to: "singer", duration: 1 });
  const r2 = layerOf(rack2, rack2.payload.cameraId).camera.focusDistance.keys.map((k) => k.v);
  ok("both depths were measured from the camera to the named layer",
     r2[0] > 2000 && r2[1] > 2000 && r2[0] !== r2[1], JSON.stringify(r2));
  await refuses("a depth naming a layer that is not there is refused, not guessed",
    () => post({ action: "camera_move", slug: SLUG, move: "rackFocus", camera: "rigged cam", from: "ghost" }),
    'there is no layer "ghost"');

  console.log("\n  -- handheld --");
  const hh = await post({ action: "camera_move", slug: SLUG, move: "handheld",
                          camera: "rigged cam", amplitude: 20, frequency: 3, counter: 0.4 });
  const hCam = layerOf(hh, hh.payload.cameraId);
  ok("the body wiggles, in the two numbers that were asked for",
     hCam.transform.position.expr === "wiggle(3, [20, 14, 9])", hCam.transform.position.expr);
  ok("the aim COUNTERS the body rather than wiggling on its own",
     hCam.camera.pointOfInterest.expr.includes(`thisComp.layer("rigged cam").position`)
     && hCam.camera.pointOfInterest.expr.includes("* 0.4"),
     hCam.camera.pointOfInterest.expr);
  eq("the pan that camera was ALREADY keyed to keeps its keyframes under the correction",
     hCam.camera.pointOfInterest.keys.map((k) => k.v), [[100, 200, 0], [800, 200, 0]]);
  ok("...and the expression holds it with `value`, so the keys are what gets corrected",
     hCam.camera.pointOfInterest.expr.startsWith("value - "), hCam.camera.pointOfInterest.expr);
  ok("...by subtracting the body's displacement, which is what makes it opposite",
     /^(\(.*\)|value) - \(thisComp\.layer\(.*\)\.position - \[.*\]\) \* 0\.4$/.test(hCam.camera.pointOfInterest.expr),
     hCam.camera.pointOfInterest.expr);

  console.log("\n  -- handheld COMPOSES onto a follow rig instead of replacing it --");
  const hh2 = await post({ action: "camera_move", slug: SLUG, move: "handheld",
                           camera: off.payload.cameraId, amplitude: 12, frequency: 2 });
  const h2 = layerOf(hh2, hh2.payload.cameraId);
  ok("the follow path is still in the position expression",
     h2.transform.position.expr.includes(`valueAtTime(time - 0.35)`), h2.transform.position.expr);
  ok("...with the shake ADDED to it — wiggle(f,a) - value is exactly the noise",
     h2.transform.position.expr.endsWith("+ wiggle(2, [12, 8.4, 5.4]) - value"),
     h2.transform.position.expr);
  ok("and the aim still points at the null it was pointing at",
     h2.camera.pointOfInterest.expr.includes(`layer("${off.payload.aimName}")`),
     h2.camera.pointOfInterest.expr);
  ok("...while countering the shake it just gained",
     h2.camera.pointOfInterest.expr.includes("* 0.35"), h2.camera.pointOfInterest.expr);

  console.log("\n  -- refusals a person can act on --");
  await refuses("an unknown move names the ones that exist",
    () => post({ action: "camera_move", slug: SLUG, move: "swoop", target: "hero" }),
    "offsetFollow, orbit, pushIn, rackFocus, handheld");
  await refuses("a parameter the move does not take names the moves that DO take it",
    () => post({ action: "camera_move", slug: SLUG, move: "pushIn", target: "hero", radius: 900 }),
    "radius (orbit take it)");
  await refuses("...and one no move takes says so",
    () => post({ action: "camera_move", slug: SLUG, move: "orbit", target: "hero", wobble: 3 }),
    "wobble (no move takes it)");
  await refuses("a move around nothing is refused rather than centred on a guess",
    () => post({ action: "camera_move", slug: SLUG, move: "orbit" }),
    "name the subject with `target`");
  await refuses("a target that is not in the comp is named, with what is",
    () => post({ action: "camera_move", slug: SLUG, move: "orbit", target: "nobody" }),
    'No layer "nobody"');
  await refuses("a `camera` that is not a camera is refused",
    () => post({ action: "camera_move", slug: SLUG, move: "handheld", camera: "hero" }),
    "is a solid layer, not a camera");

  console.log("\n  -- the document survives the round trip --");
  const back = (await post({ action: "get", slug: SLUG })).payload.comp
    || (await post({ action: "list" })).payload;
  const reread = (await post({ action: "set_layer", slug: SLUG, layerId: off.payload.cameraId,
                              name: "hero cam" })).payload.comp;
  const survivor = reread.layers.find((l) => l.id === off.payload.cameraId);
  ok("migrate() keeps a rig's expressions across a read and an unrelated write",
     hasExpr(survivor.camera.pointOfInterest) && hasExpr(survivor.transform.position),
     JSON.stringify(survivor.camera));
  ok("and the aim null's expression too",
     hasExpr(reread.layers.find((l) => l.id === off.payload.aimId).transform.position));
  ok("the comp read back is a comp", !!back);
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
