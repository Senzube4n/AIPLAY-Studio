/**
 * The camera write path, driven through the real route handler.
 *
 * WHY THIS FILE EXISTS SEPARATELY. store_test.js pins the lens as the store
 * sees it — migrate, resolvePropPath, the enumerator — and that half always
 * worked: a template could ship a camera rigged to a null and the document
 * carried it faithfully. The half that was broken is the one only a WRITE can
 * show. set_layer rebuilt `layer.camera` out of four inRange'd scalars, so
 * pointOfInterest, focalLength and blurLevel were discarded on every edit, and
 * the UI camera panel posts the whole spec back with one field changed — which
 * means one click on the zoom box destroyed the aim. That is invisible in the
 * store's tests, invisible in a diff, and it is a data loss rather than a
 * missing feature, so it is asserted here against the actual dispatch.
 *
 * routes_test.js is deliberately structural (no disk, no python) and stays
 * that way. This one uses disk — a scratch output directory it makes and
 * removes — and no python: create, add_layer, set_layer and set_prop never
 * spawn one.
 *
 *   node server/vfx/camera_test.js
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/* config.js reads the environment once, at import, and store.js resolves the
 * comp directory through THAT config rather than through the routes' injected
 * deps — so the scratch directory has to be in place before either is loaded.
 * Hence the dynamic imports below. */
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "vfx_camera_"));
process.env.AIPLAY_OUTPUT = SCRATCH;

const { createVfxRoutes } = await import("./routes.js");

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

/** POST /api/vfx, exactly as the browser and MCP both do. */
async function post(b) {
  body = b; captured = null;
  const done = await handle({ method: "POST", headers: {} }, {}, new URL("http://x/api/vfx"));
  if (!done) throw new Error(`the route did not handle action "${b.action}"`);
  return captured;
}
/** The one thing every assertion below reads: the camera spec after a write. */
const camOf = (r, id) => r.payload.comp.layers.find((l) => l.id === id).camera;

/** A refusal is ANSWERED (400 + a sentence), not thrown — what is asserted is
 *  the sentence a caller reads. */
function refuses(label, r, needle) {
  if (r.code === 400 && String(r.payload.error || "").includes(needle)) {
    pass++; console.log(`  ok    ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}\n          code ${r.code}: ${r.payload.error || "accepted"}`);
  }
}

const SLUG = "camera-merge-test";

try {
  await post({ action: "create", name: SLUG, width: 1920, height: 1080, fps: 30, duration: 6 });

  console.log("\n  -- a rigged camera lands in one call, aim and all --");

  const made = await post({
    action: "add_layer", slug: SLUG, type: "camera", name: "hero cam",
    camera: {
      zoom: 1500, depthOfField: true, aperture: 40, blurLevel: 120,
      /* The aim, parked on a moving target — the move the whole brief calls
       * its sharpest note, and the field the old rebuild threw away. */
      pointOfInterest: { keys: [{ t: 0, v: [960, 540, 0] }, { t: 3, v: [1400, 300, 200] }] },
      focusDistance: { keys: [{ t: 0, v: 1800 }, { t: 3, v: 900 }] },
    },
  });
  eq("add_layer accepted the camera", made.code, 200);
  const camId = made.payload.layerId;
  const born = camOf(made, camId);
  eq("...keeping the keyed pointOfInterest", born.pointOfInterest.keys.length, 2);
  eq("...keeping the keyed focusDistance", born.focusDistance.keys.length, 2);
  eq("...and the blurLevel the rebuild used to drop", born.blurLevel, 120);
  eq("...with depthOfField still a plain boolean, not churned to 1",
    [born.depthOfField, born.aperture, born.zoom], [true, 40, 1500]);

  console.log("\n  -- THE BUG: an edit that only changes the zoom keeps everything else --");

  /* This is the UI camera panel's exact shape: it spreads the whole current
   * spec and overwrites one key (web/vfx.js wireSpatial). Before the merge,
   * this call returned a camera with four fields and no aim. */
  const panelPost = { ...born, zoom: 900 };
  const edited = await post({ action: "set_layer", slug: SLUG, layerId: camId, camera: panelPost });
  eq("set_layer accepted the edit", edited.code, 200);
  const after = camOf(edited, camId);
  eq("the zoom changed", after.zoom, 900);
  eq("THE AIM SURVIVED — keyed pointOfInterest, both keyframes",
    after.pointOfInterest.keys.map((k) => k.v), [[960, 540, 0], [1400, 300, 200]]);
  eq("the keyed focusDistance survived — the rack focus is still there",
    after.focusDistance.keys.length, 2);
  eq("blurLevel survived", after.blurLevel, 120);
  eq("depthOfField and aperture survived", [after.depthOfField, after.aperture], [true, 40]);

  /* And the narrower edit the panel makes when the checkbox is the thing that
   * moved: nothing else may be touched. */
  const toggled = await post({
    action: "set_layer", slug: SLUG, layerId: camId, camera: { depthOfField: false },
  });
  eq("a one-key patch changes only that key",
    [camOf(toggled, camId).depthOfField, camOf(toggled, camId).zoom,
     camOf(toggled, camId).pointOfInterest.keys.length], [false, 900, 2]);

  console.log("\n  -- ONE LENS, ONE SPELLING --");

  const bothAtOnce = await post({
    action: "set_layer", slug: SLUG, layerId: camId, camera: { zoom: 1200, focalLength: 35 },
  });
  ok("giving both spellings of the lens in one call is refused, saying why",
    bothAtOnce.code === 400 && /one lens said two ways/.test(bothAtOnce.payload.error),
    JSON.stringify(bothAtOnce.payload));

  const zeroZoom = await post({
    action: "set_layer", slug: SLUG, layerId: camId, camera: { zoom: 0 },
  });
  ok("a zoom of zero is refused — engine.py would hand the lens to focalLength",
    zeroZoom.code === 400 && /must be positive/.test(zeroZoom.payload.error),
    JSON.stringify(zeroZoom.payload));

  /* Switching spelling RETIRES the other, which is what keeps exactly one of
   * them live. The rest of the lens is untouched by the switch. */
  const toMm = await post({
    action: "set_layer", slug: SLUG, layerId: camId, camera: { focalLength: 35 },
  });
  const mm = camOf(toMm, camId);
  eq("switching to millimetres retires the pixel spelling",
    [mm.focalLength, mm.zoom], [35, undefined]);
  eq("...and the aim is still not collateral damage", mm.pointOfInterest.keys.length, 2);

  /* The requested shape of the survival test, in the spelling this camera now
   * uses: an edit that touches NEITHER lens key leaves a keyed focal length
   * exactly where it was. */
  const keyedMm = await post({
    action: "set_prop", slug: SLUG, layerId: camId, path: "camera.focalLength",
    keys: [{ t: 0, v: 24 }, { t: 4, v: 85, ease: "easeInOut" }],
  });
  eq("set_prop keyframes the focal length", keyedMm.payload.keys, 2);
  const apertureOnly = await post({
    action: "set_layer", slug: SLUG, layerId: camId, camera: { aperture: 8 },
  });
  const kept = camOf(apertureOnly, camId);
  eq("a keyed focalLength survives an edit that only changes the aperture",
    [kept.focalLength.keys.length, kept.aperture], [2, 8]);
  eq("...and so does the keyed aim", kept.pointOfInterest.keys.length, 2);

  console.log("\n  -- set_prop reaches the lens at last --");

  const expr = await post({
    action: "set_prop", slug: SLUG, layerId: camId, path: "camera.pointOfInterest",
    expr: 'thisComp.layer("hero cam").position',
  });
  eq("an expression lands on the aim", expr.code, 200);
  eq("...on top of the keys, not instead of them",
    camOf(expr, camId).pointOfInterest.keys.length, 2);

  const wiggle = await post({
    action: "set_prop", slug: SLUG, layerId: camId, path: "camera.focusDistance",
    expr: "wiggle(2, 40)",
  });
  eq("...and on the focus distance", wiggle.payload.expr, "wiggle(2, 40)");

  /* THE SECOND HALF OF THE SAME BUG. The panel posts the whole spec back with
   * one field changed, so an expression on the aim has to survive that round
   * trip too — coerceProp keeps keys and drops the wrapper on its own. */
  const afterPanel = await post({
    action: "set_layer", slug: SLUG, layerId: camId,
    camera: { ...camOf(expr, camId), aperture: 11 },
  });
  eq("an expression on the aim survives the panel echoing the whole spec back",
    camOf(afterPanel, camId).pointOfInterest.expr, 'thisComp.layer("hero cam").position');
  eq("...along with the keys underneath it, and the edit that was asked for",
    [camOf(afterPanel, camId).pointOfInterest.keys.length, camOf(afterPanel, camId).aperture], [2, 11]);
  const boolBack = await post({
    action: "set_layer", slug: SLUG, layerId: camId, camera: { depthOfField: true },
  });
  eq("a plain boolean depthOfField stays a plain boolean", camOf(boolBack, camId).depthOfField, true);
  const nonsense = await post({
    action: "set_layer", slug: SLUG, layerId: camId, camera: { fstop: 2.8 },
  });
  ok("an invented camera field is refused rather than stored and ignored",
    nonsense.code === 400 && /No camera property "fstop"/.test(nonsense.payload.error),
    JSON.stringify(nonsense.payload));

  const deadLens = await post({
    action: "set_prop", slug: SLUG, layerId: camId, path: "camera.zoom", value: 1200,
  });
  ok("set_prop refuses the lens spelling this camera does not use",
    deadLens.code === 400 && /lens is written as focalLength/.test(deadLens.payload.error),
    JSON.stringify(deadLens.payload));

  const wrongArity = await post({
    action: "set_prop", slug: SLUG, layerId: camId, path: "camera.pointOfInterest", value: [960, 540],
  });
  ok("...and an aim that is not [x, y, z]",
    wrongArity.code === 400 && /takes 3 number\(s\)/.test(wrongArity.payload.error),
    JSON.stringify(wrongArity.payload));

  const notACamera = await post({ action: "add_layer", slug: SLUG, type: "solid", name: "plate" });
  const onSolid = await post({
    action: "set_prop", slug: SLUG, layerId: notACamera.payload.layerId,
    path: "camera.zoom", value: 1200,
  });
  ok("a solid has no lens", onSolid.code === 400 && /camera layers/.test(onSolid.payload.error),
    JSON.stringify(onSolid.payload));

  console.log("\n  -- the enumerator the timeline and MCP both read --");

  const props = await post({ action: "layer_properties", slug: SLUG, layerId: camId });
  const camRows = (props.payload.properties || []).filter((r) => r.group === "Camera");
  eq("layer_properties answers with the lens group over HTTP",
    camRows.map((r) => r.path).sort(),
    ["camera.aperture", "camera.blurLevel", "camera.depthOfField",
     "camera.focalLength", "camera.focusDistance", "camera.pointOfInterest"]);
  ok("...and reports the expression it can now carry",
    camRows.find((r) => r.path === "camera.pointOfInterest")?.expr
      === 'thisComp.layer("hero cam").position');

  console.log("\n  -- and the whole thing survives a reload --");

  const reread = await (async () => {
    body = null; captured = null;
    await handle({ method: "GET", headers: {} }, {},
      new URL(`http://x/api/vfx/comp/${SLUG}`));
    return captured;
  })();
  const reloaded = reread.payload.comp.layers.find((l) => l.id === camId).camera;
  eq("the reloaded camera still has the keyed focal length", reloaded.focalLength.keys.length, 2);
  eq("...the keyed aim under its expression",
    [reloaded.pointOfInterest.keys.length, reloaded.pointOfInterest.expr],
    [2, 'thisComp.layer("hero cam").position']);
  eq("...the wiggling focus distance", reloaded.focusDistance.expr, "wiggle(2, 40)");
  eq("...and no zoom resurrected beside the focal length", reloaded.zoom, undefined);

  /* ───────────────────────────────────────────────────────────────────────
   * TRANSITIONS — the moves between states, rather than the states.
   *
   * Everything above this line asserts what a camera IS after a write, and all
   * of it passed while four defects sat underneath, because every one of them
   * lives in a MOVE between two states that each test perfectly well on their
   * own. A pixel camera is fine. A millimetre camera is fine. Going from the
   * second back to the first was impossible through any door in the API — the
   * merge retired the outgoing spelling before it resolved anything, so
   * mid-call the camera held neither, and the resolver refused the write that
   * was performing the switch while naming a field the document did not
   * contain. The same shape of hole covered the lens-less camera receiving its
   * first lens value, the positivity guard sitting on one of four write doors,
   * and the ranges that were enforced by the rebuild and not by the merge that
   * replaced it.
   *
   * So this block is written as journeys: start somewhere real, move, and
   * assert what came out the other end — including that the shot is the same
   * shot, which is the part a spelling change is allowed to change nothing
   * about.
   * ─────────────────────────────────────────────────────────────────────── */

  const T = "camera-transition-test";
  await post({ action: "create", name: T, width: 1920, height: 1080, fps: 30, duration: 6 });

  /** px ⇄ mm, engine.py's own relation, so the test says the number rather
   *  than copying the implementation's arithmetic. */
  const mmToPx = (mm) => Math.round((1920 * mm / 36) * 1000) / 1000;

  /* A document that ALREADY EXISTS in a state no door produces any more — a
   * template that shipped a camera with only depth-of-field settings, a comp
   * hand-edited on disk, one migrated from before the lens had a rule. All
   * three are legitimate input the moment somebody opens the comp, and two of
   * them are exactly where the fatal was reproduced. */
  const onDisk = (slug, mutate) => {
    const p = path.join(SCRATCH, "vfx", slug, "comp.json");
    const doc = JSON.parse(readFileSync(p, "utf8"));
    mutate(doc);
    writeFileSync(p, JSON.stringify(doc), "utf8");
  };
  const newCam = async (name, camera) =>
    (await post({ action: "add_layer", slug: T, type: "camera", name, camera })).payload.layerId;

  console.log("\n  -- TRANSITION: pixels → millimetres → pixels, a closed loop --");

  const rt = await newCam("round trip", { zoom: 1500, aperture: 40 });
  const toMm2 = await post({ action: "set_layer", slug: T, layerId: rt, camera: { focalLength: 35 } });
  eq("out to millimetres", [camOf(toMm2, rt).focalLength, camOf(toMm2, rt).zoom], [35, undefined]);
  /* THE FATAL. Every door back was closed: this call was refused by the
   * resolver inside the merge that was performing the switch. */
  const toPx = await post({ action: "set_layer", slug: T, layerId: rt, camera: { zoom: 1200 } });
  eq("and BACK to pixels — the door that did not exist",
    [toPx.code, camOf(toPx, rt).zoom, camOf(toPx, rt).focalLength], [200, 1200, undefined]);
  eq("...without disturbing the field beside it", camOf(toPx, rt).aperture, 40);
  const rtRows = (await post({ action: "layer_properties", slug: T, layerId: rt })).payload.properties
    .filter((r) => r.group === "Camera").map((r) => r.path);
  ok("...and the enumerator agrees which spelling is live now",
    rtRows.includes("camera.zoom") && !rtRows.includes("camera.focalLength"), rtRows.join(", "));

  console.log("\n  -- TRANSITION: the FIRST lens value onto a camera that has none --");

  const lensless = await newCam("lensless", { depthOfField: true, aperture: 40 });
  onDisk(T, (d) => {
    /* Depth of field, an aperture, a focus distance — and no lens at all. The
     * engine renders this at DEFAULT_FOCAL_MM; the merge could not add either
     * spelling to it. */
    d.layers.find((l) => l.id === lensless).camera =
      { depthOfField: true, aperture: 40, focusDistance: 1800 };
  });
  const firstPx = await post({ action: "set_layer", slug: T, layerId: lensless, camera: { zoom: 900 } });
  eq("a lens-less camera takes its first zoom",
    [firstPx.code, camOf(firstPx, lensless).zoom], [200, 900]);
  eq("...keeping the three fields it did have",
    [camOf(firstPx, lensless).depthOfField, camOf(firstPx, lensless).aperture,
     camOf(firstPx, lensless).focusDistance], [true, 40, 1800]);

  const lensless2 = await newCam("lensless mm", { aperture: 12 });
  onDisk(T, (d) => { d.layers.find((l) => l.id === lensless2).camera = { aperture: 12 }; });
  const firstMm = await post({ action: "set_layer", slug: T, layerId: lensless2, camera: { focalLength: 24 } });
  eq("...and the same camera takes a first focal length just as well",
    [firstMm.code, camOf(firstMm, lensless2).focalLength], [200, 24]);

  console.log("\n  -- TRANSITION: a camera layer with no `camera` object at all --");

  const bare = await newCam("bare", undefined);
  onDisk(T, (d) => { delete d.layers.find((l) => l.id === bare).camera; });
  const bareBack = await (async () => {
    body = null; captured = null;
    await handle({ method: "GET", headers: {} }, {}, new URL(`http://x/api/vfx/comp/${T}`));
    return captured;
  })();
  eq("the document really does hold a camera with no camera object",
    bareBack.payload.comp.layers.find((l) => l.id === bare).camera, undefined);
  const bareSet = await post({ action: "set_layer", slug: T, layerId: bare, camera: { zoom: 1400 } });
  eq("it takes a lens", [bareSet.code, camOf(bareSet, bare).zoom], [200, 1400]);
  const bare2 = await newCam("bare mm", undefined);
  onDisk(T, (d) => { delete d.layers.find((l) => l.id === bare2).camera; });
  const bareMm = await post({ action: "set_layer", slug: T, layerId: bare2, camera: { focalLength: 50 } });
  eq("...in either spelling", [bareMm.code, camOf(bareMm, bare2).focalLength], [200, 50]);

  console.log("\n  -- TRANSITION: an explicit retire hands the lens over, converted --");

  const ret = await newCam("retire mm", { focalLength: 35 });
  const retired = await post({ action: "set_layer", slug: T, layerId: ret, camera: { focalLength: null } });
  eq("retiring the millimetre spelling leaves a PIXEL lens, not none",
    [retired.code, camOf(retired, ret).focalLength, camOf(retired, ret).zoom],
    [200, undefined, mmToPx(35)]);
  const backToMm = await post({ action: "set_layer", slug: T, layerId: ret, camera: { zoom: null } });
  eq("...and retiring that one comes back to the focal length it started at",
    [camOf(backToMm, ret).zoom, camOf(backToMm, ret).focalLength], [undefined, 35]);

  const noop = await post({ action: "set_layer", slug: T, layerId: ret, camera: { zoom: null } });
  eq("retiring a spelling the camera does not have changes nothing",
    [noop.code, camOf(noop, ret).focalLength, camOf(noop, ret).zoom], [200, 35, undefined]);

  const pair = await post({ action: "set_layer", slug: T, layerId: ret,
                            camera: { zoom: 800, focalLength: null } });
  eq("naming one spelling and retiring the other in one call is the same switch",
    [pair.code, camOf(pair, ret).zoom, camOf(pair, ret).focalLength], [200, 800, undefined]);

  /* A lens under an EXPRESSION cannot be converted by arithmetic: the
   * expression reads its own property as `value`, so rescaling the number
   * underneath changes what it computes. Refused, naming the door that works,
   * rather than silently rendering a different shot. */
  const exprLens = await newCam("expr lens", { focalLength: 35 });
  await post({ action: "set_prop", slug: T, layerId: exprLens,
               path: "camera.focalLength", expr: "value * 1.5" });
  refuses("retiring an EXPRESSION-driven lens is refused rather than mis-converted",
    await post({ action: "set_layer", slug: T, layerId: exprLens, camera: { focalLength: null } }),
    "cannot be rescaled");
  const named = await post({ action: "set_layer", slug: T, layerId: exprLens, camera: { zoom: 900 } });
  eq("...and naming the other spelling outright still switches it",
    [named.code, camOf(named, exprLens).zoom, camOf(named, exprLens).focalLength],
    [200, 900, undefined]);

  console.log("\n  -- TRANSITION: both spellings at once, refused with an accurate sentence --");

  refuses("both named in one call is still refused",
    await post({ action: "set_layer", slug: T, layerId: rt, camera: { zoom: 1200, focalLength: 35 } }),
    "one lens said two ways");
  refuses("...and retiring both at once, which would leave no lens at all",
    await post({ action: "set_layer", slug: T, layerId: rt, camera: { zoom: null, focalLength: null } }),
    "no lens at all");

  /* THE MESSAGE ITSELF. On a camera holding no lens, the old refusal said the
   * lens "is written as focalLength" — a field the document did not contain,
   * which is a sentence its owner can neither act on nor check. */
  onDisk(T, (d) => { d.layers.find((l) => l.id === lensless2).camera = { aperture: 12 }; });
  const deadOnLensless = await post({
    action: "set_prop", slug: T, layerId: lensless2, path: "camera.zoom", value: 900,
  });
  ok("set_prop still refuses the spelling this camera does not use",
    deadOnLensless.code === 400, JSON.stringify(deadOnLensless.payload));
  ok("...but never claims a spelling the document does not contain",
    !/written as focalLength/.test(deadOnLensless.payload.error || ""),
    deadOnLensless.payload.error);
  ok("...saying instead that the lens is unset and what the engine renders",
    /is unset/.test(deadOnLensless.payload.error || "")
    && /50mm/.test(deadOnLensless.payload.error || ""),
    deadOnLensless.payload.error);
  /* And the accurate version is still accurate where the field IS there. */
  const mmHolder = await newCam("mm holder", { focalLength: 40 });
  ok("...while a camera that really is written in millimetres is told so",
    /lens is written as focalLength/.test((await post({
      action: "set_prop", slug: T, layerId: mmHolder, path: "camera.zoom", value: 900,
    })).payload.error || ""));

  console.log("\n  -- TRANSITION: pushIn is no longer a one-way door (SERIOUS 1) --");

  await post({ action: "add_layer", slug: T, type: "solid", name: "subject", threeD: true });
  const pxCam = await newCam("push me", { zoom: 900 });
  const pushed = await post({ action: "camera_move", slug: T, move: "pushIn",
                              target: "subject", camera: "push me" });
  const pushedCam = camOf(pushed, pxCam);
  eq("a fresh PIXEL camera comes out of pushIn in millimetres",
    [pushedCam.focalLength.keys.map((k) => k.v), pushedCam.zoom], [[32, 58], undefined]);
  const home = await post({ action: "set_layer", slug: T, layerId: pxCam, camera: { zoom: 900 } });
  eq("and it converts straight back to pixels — the trap is open at both ends",
    [home.code, camOf(home, pxCam).zoom, camOf(home, pxCam).focalLength], [200, 900, undefined]);
  eq("...with the rig the preset built still on it",
    [camOf(home, pxCam).focusDistance.keys.length,
     typeof camOf(home, pxCam).pointOfInterest?.expr], [2, "string"]);

  /* The other way home: retire the millimetres and the KEYED lens comes across
   * as a keyed zoom, key for key, ease and all — the push is still a push. */
  const pxCam2 = await newCam("push me too", { zoom: 900 });
  await post({ action: "camera_move", slug: T, move: "pushIn", target: "subject",
               camera: "push me too", fromFocal: 24, toFocal: 85 });
  const handedOver = await post({ action: "set_layer", slug: T, layerId: pxCam2,
                                  camera: { focalLength: null } });
  const hz = camOf(handedOver, pxCam2).zoom;
  eq("retiring a KEYED focal length converts every key into the pixel spelling",
    [hz.keys.map((k) => k.v), camOf(handedOver, pxCam2).focalLength],
    [[mmToPx(24), mmToPx(85)], undefined]);
  eq("...keeping the ease on the key that leaves, so the move is unchanged",
    hz.keys[0].ease, "easeInOut");

  console.log("\n  -- TRANSITION: a zero lens, through all four write doors (SERIOUS 2) --");

  const guard = await newCam("guard", { zoom: 1500 });
  refuses("door 1 — set_layer { camera: { zoom: 0 } }",
    await post({ action: "set_layer", slug: T, layerId: guard, camera: { zoom: 0 } }),
    "must be positive");
  refuses("door 2 — set_prop camera.zoom, value 0",
    await post({ action: "set_prop", slug: T, layerId: guard, path: "camera.zoom", value: 0 }),
    "must be positive");
  refuses("door 3 — set_prop camera.zoom, a key track through zero",
    await post({ action: "set_prop", slug: T, layerId: guard, path: "camera.zoom",
                 keys: [{ t: 0, v: 0 }, { t: 2, v: 900 }] }),
    "must be positive");
  refuses("door 4 — add_key camera.zoom with a negative v",
    await post({ action: "add_key", slug: T, layerId: guard, path: "camera.zoom", t: 1, v: -50 }),
    "must be positive");
  refuses("...and the millimetre spelling is guarded by the same rule",
    await post({ action: "set_prop", slug: T, layerId: mmHolder, path: "camera.focalLength", value: 0 }),
    "must be positive");
  const guardStill = await post({ action: "set_layer", slug: T, layerId: guard, camera: { aperture: 9 } });
  eq("four refusals later the lens is exactly what it was",
    [camOf(guardStill, guard).zoom, camOf(guardStill, guard).aperture], [1500, 9]);
  /* The exemption that was always part of this rule and stays part of it: an
   * expression owns its own value, and the number underneath is the fallback
   * the render reaches for only if the expression fails. */
  const underExpr = await post({ action: "set_layer", slug: T, layerId: guard,
    camera: { zoom: { value: 0, expr: "wiggle(1, 10) + 900" } } });
  eq("...but a lens UNDER AN EXPRESSION is still left to its own value",
    [underExpr.code, camOf(underExpr, guard).zoom.expr], [200, "wiggle(1, 10) + 900"]);

  console.log("\n  -- TRANSITION: out-of-range scalars through the merge (SERIOUS 3) --");

  const rng = await newCam("range", { zoom: 1500, aperture: 40, blurLevel: 120, focusDistance: 1800 });
  const before = JSON.stringify(camOf(await post({
    action: "set_layer", slug: T, layerId: rng, camera: { aperture: 40 } }), rng));
  for (const [patch, band] of [
    [{ aperture: -50 }, "between 0 and 1000"],
    [{ aperture: 999999 }, "between 0 and 1000"],
    [{ blurLevel: -300 }, "between 0 and 1000"],
    [{ blurLevel: 1e9 }, "between 0 and 1000"],
    [{ focusDistance: 0 }, "between 1 and 100000"],
    [{ focusDistance: -5000 }, "between 1 and 100000"],
    [{ zoom: 1e12 }, "between 1 and 100000"],
    [{ zoom: 1e-6 }, "between 1 and 100000"],
  ]) {
    refuses(`the merge refuses ${JSON.stringify(patch)}, naming the band`,
      await post({ action: "set_layer", slug: T, layerId: rng, camera: patch }), band);
  }
  eq("...and none of the eight left a mark on the document",
    JSON.stringify(camOf(await post({
      action: "set_layer", slug: T, layerId: rng, camera: { aperture: 40 } }), rng)), before);
  refuses("a keyframe out of range is refused too — a key is a value the render holds",
    await post({ action: "set_prop", slug: T, layerId: rng, path: "camera.aperture",
                 keys: [{ t: 0, v: 40 }, { t: 2, v: 5000 }] }),
    "between 0 and 1000");
  const sane = await post({ action: "set_layer", slug: T, layerId: rng,
                            camera: { aperture: 90, blurLevel: 55, focusDistance: 2400 } });
  eq("...while the values inside the band still land",
    [camOf(sane, rng).aperture, camOf(sane, rng).blurLevel, camOf(sane, rng).focusDistance],
    [90, 55, 2400]);
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
