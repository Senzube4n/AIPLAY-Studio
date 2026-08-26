/**
 * The store's load-time repair pass, tested by ROUND-TRIPPING documents.
 *
 * Everything here exists because reading the code did not reveal the bugs and
 * writing a document out and back in did. migrate() repairs rather than
 * rejects, which is the right call for a hand-edited file — but it means every
 * mistake it makes is silent by construction, and a layer that comes back as
 * the wrong kind looks exactly like a layer someone authored that way.
 *
 * Two real losses are pinned below. Both were live: shape, camera and comp
 * layers loaded as white rectangles, and a 3D layer's [x, y, z] position was
 * replaced by the comp centre. Neither raised anything.
 */
import { readFileSync } from "node:fs";
import { blankComp, blankLayer, migrate, LAYER_TYPES, hasExpr, evalProp, resolvePropPath,
         layerProperties, shiftPropTimes, pastePresetKeys,
         LIGHT_KINDS, LIGHT_PROP_SPEC, LIGHT_KIND_PARAMS, MATERIAL_PROP_SPEC } from "./store.js";

let pass = 0;
const failures = [];

function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}\n          got  ${g}\n          want ${w}`); }
}

function ok2(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

/** A document is only ever tested through a full serialise/parse cycle: that
 *  is what a save followed by a load actually does, and a mutation migrate()
 *  makes in place would otherwise be invisible to the assertion. */
const roundTrip = (doc) => migrate(JSON.parse(JSON.stringify(doc)));

const comp = (layers) => {
  const d = blankComp("store-test", {});
  d.layers = layers;
  return roundTrip(d);
};

console.log("\n  -- layer kinds survive a load --");

/* The engine draws nine kinds. If it can draw it, the store must keep it;
 * every kind below was rendering correctly in engine.py while the store was
 * turning it into a solid on the way back in. */
for (const kind of ["image", "video", "solid", "text", "shape", "adjustment", "null", "camera", "comp"]) {
  eq(`a ${kind} layer loads as a ${kind} layer`, comp([{ id: "l", type: kind }])[0]?.type ?? comp([{ id: "l", type: kind }]).layers[0].type, kind);
}

eq("every kind the engine draws is on the allowlist",
  ["image", "video", "solid", "text", "shape", "adjustment", "null", "camera", "comp"]
    .filter((k) => !LAYER_TYPES.includes(k)), []);

console.log("\n  -- but nonsense is still repaired, not preserved --");

eq("an unknown type still falls back to solid",
  comp([{ id: "l", type: "banana" }]).layers[0].type, "solid");
eq("a missing type still falls back to solid",
  comp([{ id: "l" }]).layers[0].type, "solid");

console.log("\n  -- 3D transforms keep their third component --");

const threeD = comp([{
  id: "z", type: "solid", threeD: true,
  transform: { anchor: [10, 20, 30], position: [300, 400, -500], scale: [110, 120, 130], rotation: 0, opacity: 100 },
}]).layers[0].transform;

eq("position keeps z", threeD.position, [300, 400, -500]);
eq("anchor keeps z", threeD.anchor, [10, 20, 30]);
eq("scale keeps z", threeD.scale, [110, 120, 130]);

/* The specific old failure: the fallback did not merely drop z, it discarded
 * the authored x and y too, so a layer moved anywhere in 3D snapped back to
 * the middle of the frame. Worth its own assertion because "z is missing" and
 * "the whole vector was replaced" are different bugs with the same symptom. */
eq("...and a rejected vector does NOT quietly become the comp centre",
  threeD.position.slice(0, 2), [300, 400]);

console.log("\n  -- two components still work exactly as before --");

const twoD = comp([{
  id: "a", type: "solid",
  transform: { anchor: [1, 2], position: [100, 200], scale: [50, 60], rotation: 0, opacity: 100 },
}]).layers[0].transform;
eq("2D position untouched", twoD.position, [100, 200]);
eq("2D scale untouched", twoD.scale, [50, 60]);

const centred = comp([{ id: "b", type: "solid", transform: {} }]).layers[0].transform;
eq("a missing position still defaults to the comp centre", centred.position, [960, 540]);

console.log("\n  -- genuinely malformed vectors are still rejected --");

for (const [label, bad] of [
  ["a one-component vector", [5]],
  ["a four-component vector", [1, 2, 3, 4]],
  ["a vector of strings", ["a", "b"]],
  // JSON has no NaN or Infinity — it writes null — so null IS the shape a
  // non-finite number arrives in after a save. Number(null) is 0, which used
  // to sail through the finite check and move the layer to y=0.
  ["a vector holding null (what a saved NaN becomes)", [1, null]],
  ["a vector holding an empty string", [1, ""]],
  ["a vector holding a boolean", [1, false]],
]) {
  eq(`${label} falls back to the default`,
    comp([{ id: "c", type: "solid", transform: { position: bad } }]).layers[0].transform.position,
    [960, 540]);
}

console.log("\n  -- the new kinds are usable the moment they are created --");

const c = blankComp("bl", {});
const shape = blankLayer(c, "shape");
eq("a blank shape layer has items to draw", Array.isArray(shape.shapes) && shape.shapes.length > 0, true);
eq("...and survives the round trip with them",
  comp([shape]).layers[0].shapes.length, shape.shapes.length);

const cam = blankLayer(c, "camera");
eq("a blank camera carries a zoom", Number.isFinite(cam.camera?.zoom), true);
eq("...and is 3D by definition", cam.threeD, true);

console.log("\n  -- auto-orient survives a load, and nonsense repairs to off --");

/* autoOrient is a layer SWITCH like threeD — the engine reads it off the layer
 * (engine.py matrix4, interp.py world_matrix) — and migrateLayer keeps unnamed
 * fields only until someone converts the pass to a rebuild, which has erased
 * fields five times in this repo. Pinned so the sixth time is loud. */
eq("autoOrient alongPath survives the round trip",
  comp([{ id: "ao1", type: "solid", autoOrient: "alongPath" }]).layers[0].autoOrient, "alongPath");
eq("an explicit off survives as off",
  comp([{ id: "ao2", type: "solid", autoOrient: "off" }]).layers[0].autoOrient, "off");
eq("an absent switch STAYS absent — off is the default, not a stamped field",
  comp([{ id: "ao3", type: "solid" }]).layers[0].autoOrient, undefined);
/* "towardCamera" is refused at the route with a reason; a hand-edited document
 * carrying it repairs to off rather than shipping a mode the render silently
 * ignores — the same discipline an unknown label colour gets. */
eq("a hand-written towardCamera repairs to off",
  comp([{ id: "ao4", type: "solid", autoOrient: "towardCamera" }]).layers[0].autoOrient, "off");
eq("garbage repairs to off",
  comp([{ id: "ao5", type: "solid", autoOrient: "banana" }]).layers[0].autoOrient, "off");
/* Not animatable — AE's switch is not either — so the property enumerator must
 * not offer it: a listed path that set_prop would refuse is the drift this
 * codebase has shipped six times. */
ok2("layerProperties does NOT offer autoOrient as an animatable property",
  !layerProperties({ id: "ao6", type: "solid", autoOrient: "alongPath", transform: {}, effects: [], masks: [] })
    .some((p) => /autoOrient/i.test(p.path)), "");

console.log("\n  -- label colours and shy survive a load, field for field --");

/* migrateLayer normalises in place, and a field it does not name survives by
 * accident — until someone converts it to a rebuild, which has erased fields
 * five times in this repo. These pins make that erase loud. */
const labelled = comp([{ id: "lb", type: "solid", label: "aqua", shy: true }]).layers[0];
eq("a layer's label colour survives the round trip", labelled.label, "aqua");
eq("a layer's shy flag survives the round trip", labelled.shy, true);
eq("an unknown label repairs to none, not to a colour the UI cannot draw",
  comp([{ id: "lb2", type: "solid", label: "chartreuse" }]).layers[0].label, "none");
eq("an unlabelled layer reads none", comp([{ id: "lb3", type: "solid" }]).layers[0].label, "none");
eq("shy defaults to false", comp([{ id: "lb4", type: "solid" }]).layers[0].shy, false);

const shyDoc = blankComp("shy", {});
shyDoc.hideShy = true;
eq("the comp-level hide-shy switch survives the round trip", roundTrip(shyDoc).hideShy, true);
eq("...and defaults to false", roundTrip(blankComp("shy2", {})).hideShy, false);

const blankL = blankLayer(blankComp("bl2", {}), "solid");
eq("a blank layer is born with label none and shy off",
  [blankL.label, blankL.shy], ["none", false]);

console.log("\n  -- guides survive a load, field for field --");

/* Guides are document state (a guide marks a place in the composition and
 * travels with the comp); the same rebuild-erases-fields trap the label/shy
 * pins guard applies here, so the round trip is pinned the same way. */
const guided = blankComp("gd", {});           // 1920x1080
guided.guides = [{ axis: "x", position: 960 }, { axis: "y", position: 540.5 }];
eq("guides survive the round trip", roundTrip(guided).guides,
  [{ axis: "x", position: 960 }, { axis: "y", position: 540.5 }]);
eq("a comp born blank has an empty guide list", blankComp("gd2", {}).guides, []);
eq("...and a document missing the field loads with one", roundTrip({ ...blankComp("gd3", {}), guides: undefined }).guides, []);

const guidedBad = blankComp("gd4", {});
guidedBad.guides = [
  { axis: "z", position: 10 },               // no such axis
  { axis: "x" },                             // no position
  { axis: "y", position: null },             // a saved NaN
  { axis: "x", position: "120" },            // numeric string — legal, like everywhere else
  { axis: "y", position: 4000 },             // past the raster — clamped onto it
  null,
];
eq("nonsense guides are dropped, the reparable ones repaired",
  roundTrip(guidedBad).guides, [{ axis: "x", position: 120 }, { axis: "y", position: 1080 }]);

console.log("\n  -- expressions survive a load --");

/* An expression-only property legitimately has NO keys array, so the old
 * isKeyed() test rejected it and migrate replaced it with a plain default.
 * The sandbox could have been switched on and still seen nothing, because no
 * expression ever survived being written to disk. */
const exprLayer = comp([{
  id: "e", type: "solid",
  transform: {
    position: { expr: "wiggle(2,30)", value: [300, 400] },
    opacity: { expr: "value * 2", value: 65 },
    rotation: { expr: "time * 90", value: 0, keys: [{ t: 0, v: 0 }, { t: 2, v: 180 }] },
  },
}]).layers[0].transform;

eq("an expression on a vector property survives", exprLayer.position, { expr: "wiggle(2,30)", value: [300, 400] });
eq("an expression on a scalar survives", exprLayer.opacity, { expr: "value * 2", value: 65 });
eq("an expression ON TOP of keyframes keeps both",
  [exprLayer.rotation.expr, exprLayer.rotation.keys.length], ["time * 90", 2]);

/* The JS evaluator is a MIRROR for the UI; it cannot run the sandbox, which is
 * Python in the engine. It has to show the value underneath rather than the
 * wrapper object — a slider bound to "[object Object]" is worse than a stale
 * number. */
eq("the JS mirror previews the value underneath, not the wrapper",
  evalProp(exprLayer.opacity, 0), 65);
eq("...and still interpolates ordinary keyframes",
  evalProp({ keys: [{ t: 0, v: 0 }, { t: 2, v: 100 }] }, 1), 50);

eq("a blank expression is not an expression", hasExpr({ expr: "   ", value: 1 }), false);
eq("a property with no expr is not one either", hasExpr({ keys: [] }), false);

console.log("\n  -- the property paths a caller can name --");

const flat = { id: "p", type: "video", transform: { opacity: 100 }, effects: [], masks: [] };
const cube = { ...flat, threeD: true };

/* These four live on the LAYER, not inside transform, and the resolver refused
 * all of them — so time remapping could be evaluated by the engine and never
 * authored by anyone, and a 3D layer could hold a fixed Y rotation but never
 * animate around it. */
eq("timeRemap resolves, and stays on the layer", resolvePropPath(flat, "timeRemap").path, "timeRemap");
/* The 3D axes are named bare but LIVE in the transform — asserted properly
 * further down. This block first pinned them at layer level, which is where I
 * had wrongly put them; a test can only lock in what its author already
 * believed, so it made the bug look like the specification. */
for (const p of ["rotationX", "rotationY", "rotationZ"]) {
  eq(`${p} resolves into the transform`, resolvePropPath(flat, p).path, `transform.${p}`);
}
eq("opacity still shorthands to transform.opacity", resolvePropPath(flat, "opacity").path, "transform.opacity");

/* Both effect-param spellings resolve to one canonical answer — two builders
 * picked different ones and the mismatch was a silent 400. */
const fxLayer = { ...flat, effects: [{ id: "fx_1", type: "gaussianBlur", params: { radius: 4 } }] };
eq("effects.<id>.params.<k> resolves", resolvePropPath(fxLayer, "effects.fx_1.params.radius").path, "effects.fx_1.radius");
eq("...and so does the short spelling", resolvePropPath(fxLayer, "effects.fx_1.radius").path, "effects.fx_1.radius");

let refused = false;
try { resolvePropPath(flat, "nonsense"); } catch { refused = true; }
eq("a path that is not a property is still refused", refused, true);

/* A 2D vector is exactly two components and the arity is enforced. On a 3D
 * layer BOTH lengths are legal — the engine defaults a missing z — so pinning
 * it to 3 would refuse every [x, y] and pinning it to 2 would refuse every
 * [x, y, z]. Unstated is the honest answer. */
eq("a 2D vector's arity is enforced", resolvePropPath(flat, "transform.position").arity, 2);
eq("a 3D vector's arity is left unstated", resolvePropPath(cube, "transform.position").arity, null);
eq("a scalar's arity is enforced on a 3D layer too", resolvePropPath(cube, "transform.rotation").arity, 1);

console.log("\n  -- the transform rebuild keeps what the engine reads --");

/* migrateLayer REBUILDS l.transform from an explicit key list, so anything not
 * on that list is deleted from the document on load. The engine reads EIGHT
 * keys off a transform; the list had five, and the three 3D rotation axes were
 * being erased from every comp on every read. This is the same shape as the
 * layer-kind allowlist: reconstructing an object from a key list silently
 * discards the rest. */
const spun = comp([{
  id: "s", type: "solid", threeD: true,
  transform: {
    anchor: [10, 10], position: [100, 200], scale: [100, 100], rotation: 0, opacity: 100,
    rotationX: 45,
    rotationY: { keys: [{ t: 0, v: 0 }, { t: 2, v: 180 }] },
  },
}]).layers[0].transform;

eq("a constant 3D rotation survives a load", spun.rotationX, 45);
eq("a KEYFRAMED 3D rotation survives too", spun.rotationY?.keys?.length, 2);

/* Absent means zero to the engine, so the rebuild must not invent three
 * explicit zeroes on every 2D layer — that would be noise in the document and
 * a lie in the UI about which layers are 3D. */
eq("an axis that was never set stays absent", "rotationZ" in spun, false);

/* The guard that makes the next one findable: if the engine grows a transform
 * property, this test fails until the rebuild is taught about it. */
eq("the five original transform keys are all still there",
  ["anchor", "position", "scale", "rotation", "opacity"].filter((k) => !(k in spun)), []);

console.log("\n  -- the 3D axes resolve INTO the transform --");

const l3d = { id: "p", type: "solid", threeD: true, transform: { opacity: 100 }, effects: [], masks: [] };

/* engine.py reads transform.get("rotationX"). Resolved onto the LAYER instead,
 * the property accepts the value, the document keeps it, and every render
 * ignores it — which is precisely what happened. */
for (const p of ["rotationX", "rotationY", "rotationZ"]) {
  const r = resolvePropPath(l3d, p);
  eq(`${p} resolves to transform.${p}`, r.path, `transform.${p}`);
  eq(`...and its owner IS the transform object`, r.owner === l3d.transform, true);
}
eq("the long spelling resolves identically",
  resolvePropPath(l3d, "transform.rotationY").path, "transform.rotationY");

/* timeRemap genuinely does live on the layer — engine.py reads
 * layer.get("timeRemap") — so it must NOT have moved with the others. */
eq("timeRemap still belongs to the layer", resolvePropPath(l3d, "timeRemap").owner === l3d, true);

console.log("\n  -- shape item parameters are addressable --");

/* shapes.py declares 55 animatable parameters and resolvePropPath could name
 * none of them, so a trim could not be keyframed: the write-on — the most
 * useful thing a shape layer does — was reachable only by hand-writing a keys
 * array into the document.
 *
 * The spelling mirrors engine.py's _expr_props, which is what an expression on
 * the same property reports itself by. The effect-param path and the 3D
 * rotations BOTH drifted because each side worked its own spelling out
 * separately; mirroring makes them agree by construction. */
const shapeLayer = { id: "sh", type: "shape", transform: {}, effects: [], masks: [], shapes: [
  { type: "ellipse", size: [160, 160], position: [0, 0] },
  { type: "trim", start: 0, end: 100 },
  { type: "group", name: "g", items: [{ type: "rect", size: [40, 20] }, { type: "stroke", width: 6 }] },
]};

eq("a top-level item parameter resolves", resolvePropPath(shapeLayer, "shapes.1.end").path, "shapes.1.end");
eq("...reporting arity 1 for a scalar", resolvePropPath(shapeLayer, "shapes.1.end").arity, 1);
eq("...and arity 2 for a size", resolvePropPath(shapeLayer, "shapes.0.size").arity, 2);
eq("a parameter INSIDE a group resolves",
  resolvePropPath(shapeLayer, "shapes.2.items.1.width").path, "shapes.2.items.1.width");
eq("the owner is the item itself, so a write lands on it",
  resolvePropPath(shapeLayer, "shapes.1.end").owner === shapeLayer.shapes[1], true);

for (const [p, why] of [
  ["shapes.9.end", "an index past the end"],
  ["shapes.2.items.5.width", "a group index past the end"],
]) {
  let msg = "";
  try { resolvePropPath(shapeLayer, p); } catch (e) { msg = e.message; }
  eq(`${why} is refused with a message naming what IS there`, /it holds \d+ item/.test(msg), true);
}

let notShape = "";
try { resolvePropPath({ id: "x", type: "solid", transform: {}, effects: [], masks: [] }, "shapes.0.size"); }
catch (e) { notShape = e.message; }
eq("a shape path on a non-shape layer says so", /not a shape layer/.test(notShape), true);

console.log("\n  -- the cache stamp is monotonic --");

/* updatedAt is the frame cache's invalidation key. Date.now() has millisecond
 * resolution, so two edits finishing inside one millisecond would mint the
 * same stamp and a frame rendered from the first would be served for the
 * second. Writes are serialised per slug, which stops them overlapping but
 * not from landing in the same millisecond — and a stale pixel reaching a
 * user is the worst failure this subsystem has. */
const stamps = [];
let prior = { updatedAt: 0 };
const nowFixed = Date.now();
for (let i = 0; i < 5; i++) {
  prior = { updatedAt: Math.max(nowFixed, (prior.updatedAt || 0) + 1) };
  stamps.push(prior.updatedAt);
}
eq("five edits inside one millisecond get five distinct stamps", new Set(stamps).size, 5);
eq("...and they strictly increase",
  stamps.every((v, i) => i === 0 || v > stamps[i - 1]), true);

/* Asserting the store USES it, not just that the arithmetic works — the
 * arithmetic above would pass forever with the old line still in place. */
eq("the store actually mints stamps this way",
  readFileSync(new URL("./store.js", import.meta.url), "utf8")
    .includes("Math.max(Date.now(), (doc.updatedAt || 0) + 1)"), true);

console.log("\n  -- audio layers survive a load field-for-field --");

/* The most-repeated bug class in this file: migrateLayer and friends rebuild
 * objects from key lists and have silently erased fields five separate times.
 * So an audio layer is not merely asserted to keep its TYPE — every field the
 * mixer reads is compared one by one after a save/load cycle. */
const audioIn = {
  id: "au", type: "audio", name: "song", src: "aiplay_00001.flac",
  start: 0.5, end: 6.25, inPoint: 1.5, timeScale: 1,
  audio: false,                                   // the mute switch, explicitly off
  audioLevels: { keys: [{ t: 0, v: 0, ease: "easeOut" }, { t: 4, v: -24 }] },
};
const audioOut = comp([JSON.parse(JSON.stringify(audioIn))]).layers[0];

eq("an audio layer loads as an audio layer", audioOut.type, "audio");
for (const k of ["src", "start", "end", "inPoint", "timeScale", "audio"]) {
  eq(`audio layer keeps ${k}`, audioOut[k], audioIn[k]);
}
eq("KEYFRAMED audioLevels survive, keys and eases intact",
  audioOut.audioLevels, audioIn.audioLevels);

const constLevel = comp([{ id: "cv", type: "video", src: "clip.mp4", audioLevels: -12 }]).layers[0];
eq("a constant audioLevels on a video layer survives", constLevel.audioLevels, -12);
eq("an unset audio switch stays ABSENT (absent means on)",
  "audio" in comp([{ id: "v2", type: "video", src: "clip.mp4" }]).layers[0], false);

console.log("\n  -- audioLevels is addressable exactly where sound can be --");

for (const kind of ["audio", "video", "comp"]) {
  const l = { id: "al", type: kind, transform: {}, effects: [], masks: [] };
  const r = resolvePropPath(l, "audioLevels");
  eq(`audioLevels resolves on a ${kind} layer`, r.path, "audioLevels");
  eq(`...owned by the layer itself, arity 1`, [r.owner === l, r.arity], [true, 1]);
}
let deaf = "";
try { resolvePropPath({ id: "so", type: "solid", transform: {}, effects: [], masks: [] }, "audioLevels"); }
catch (e) { deaf = e.message; }
ok2("audioLevels on a solid is refused, naming where it lives", /audio, video, comp/.test(deaf), deaf);

/* A remapped picture with unremapped audio is a lie, and v1 does not scrub
 * audio through a remap curve — so an audio layer cannot take one at all. */
let remapRefusal = "";
try { resolvePropPath({ id: "au2", type: "audio", transform: {}, effects: [], masks: [] }, "timeRemap"); }
catch (e) { remapRefusal = e.message; }
ok2("timeRemap on an audio layer is refused with the v1 reason", /time-remapped|remap/i.test(remapRefusal), remapRefusal);
eq("...but a video layer still takes the curve (the picture remaps)",
  resolvePropPath({ id: "v3", type: "video", transform: {}, effects: [], masks: [] }, "timeRemap").path,
  "timeRemap");

console.log("\n  -- the enumerator offers audioLevels only where it is real --");

/* layerProperties feeds BOTH the timeline tree and MCP — that is the parity
 * mechanism, so the audio group has to come from it, not from a parallel
 * list in either surface. */
for (const kind of ["audio", "video", "comp"]) {
  const props = layerProperties({ id: "lp", type: kind, transform: {}, effects: [], masks: [] });
  const au = props.find((p) => p.path === "audioLevels");
  ok2(`layerProperties lists audioLevels on a ${kind} layer`, !!au, JSON.stringify(props.map((p) => p.path)));
  if (au) {
    eq("...in its own Audio group with the dB range", [au.group, au.range], ["Audio", [-48, 12]]);
    eq("...falling back to 0 dB (unity), not silence", au.fallback, 0);
  }
}
ok2("layerProperties does NOT offer audioLevels on a solid",
  !layerProperties({ id: "lp2", type: "solid", transform: {}, effects: [], masks: [] })
    .some((p) => p.path === "audioLevels"), "");
ok2("...and does NOT offer timeRemap on an audio layer",
  !layerProperties({ id: "lp3", type: "audio", transform: {}, effects: [], masks: [] })
    .some((p) => p.path === "timeRemap"), "");
console.log("\n  -- FXPRESETS: the time shift and the paste merge --");

/* The two pure halves of the preset feature, pinned here because both rules
 * are DOCUMENTED promises: stored key times are relative to the source
 * layer's start, and pasted keys own only the range they cover. */
{
  const keyed = { keys: [{ t: 0.5, v: 0 }, { t: 1.5, v: 220, ease: "easeInOut" }] };
  const rel = shiftPropTimes(keyed, -0.5);
  eq("shiftPropTimes moves every key by dt", rel.keys.map((k) => k.t), [0, 1]);
  eq("...keeping the ease", rel.keys[1].ease, "easeInOut");
  eq("...and never mutates the original", keyed.keys[0].t, 0.5);
  eq("a constant passes through as a deep copy", shiftPropTimes(42, 3), 42);
  const wrapped = shiftPropTimes({ expr: "value * 2", value: 65 }, 1);
  eq("an expression wrapper keeps its expr and value", [wrapped.expr, wrapped.value], ["value * 2", 65]);

  const cur = { keys: [{ t: 0, v: 10 }, { t: 1, v: 20 }, { t: 5, v: 99 }] };
  const pasted = pastePresetKeys(cur, [{ t: 0.5, v: 50 }, { t: 2, v: 60 }]);
  eq("pasted keys replace existing keys ONLY inside the range they cover — t=0 and t=5 survive, t=1 is replaced",
    pasted.keys.map((k) => [k.t, k.v]), [[0, 10], [0.5, 50], [2, 60], [5, 99]]);
  const onConst = pastePresetKeys(70, [{ t: 0, v: 0 }, { t: 1, v: 100 }]);
  eq("a constant property simply becomes the pasted animation",
    onConst.keys.map((k) => k.t), [0, 1]);
  const onExpr = pastePresetKeys({ expr: "wiggle(2, 5)", value: 70 }, [{ t: 0, v: 0 }, { t: 1, v: 100 }]);
  eq("an expression on the property stays on top of the pasted keys",
    [onExpr.expr, onExpr.keys.length], ["wiggle(2, 5)", 2]);
}

console.log("\n  -- LIGHTS: the spec survives a load, field for field --");

/* The migrate rebuild trap, aimed at the newest field: five fields have been
 * silently erased in this repo by a load-time rebuild, so the light spec is
 * pinned through a full serialise/parse cycle — including a KEYED intensity,
 * because "the object survived" and "the keyframes inside it survived" have
 * different failure modes. */
const litComp = comp([{
  id: "key", type: "light",
  transform: { position: [960, 300, -700] },
  light: {
    kind: "spot", color: [255, 244, 214],
    intensity: { keys: [{ t: 0, v: 0 }, { t: 2, v: 100 }] },
    falloff: "inverseSquare", radius: 640, falloffDistance: 300,
    coneAngle: 35, coneFeather: 20, pointOfInterest: [960, 540, 0],
    castsShadows: true, shadowDarkness: 80, shadowDiffusion: 12,
  },
}]);
const lit = litComp.layers[0];
eq("a light layer loads as a light layer", lit.type, "light");
eq("the kind survives", lit.light.kind, "spot");
eq("a keyed intensity keeps its keyframes", lit.light.intensity.keys.length, 2);
eq("the cone survives", [lit.light.coneAngle, lit.light.coneFeather], [35, 20]);
eq("the shadow trio survives", [lit.light.castsShadows, lit.light.shadowDarkness, lit.light.shadowDiffusion], [true, 80, 12]);
eq("the aim survives", lit.light.pointOfInterest, [960, 540, 0]);
eq("...and the 3D position kept its z", lit.transform.position, [960, 300, -700]);

console.log("\n  -- LIGHTS: nonsense enums repair, everything else is kept --");

const typoLight = comp([{ id: "t", type: "light", light: { kind: "spott", falloff: "banana", intensity: 40 } }]).layers[0];
eq("a typo'd kind repairs to point (what the engine would render)", typoLight.light.kind, "point");
eq("a typo'd falloff repairs to none", typoLight.light.falloff, "none");
eq("...and the fields beside them are untouched", typoLight.light.intensity, 40);

console.log("\n  -- LIGHTS: blankLayer seeds a light that lights something --");

const seedComp = blankComp("lights", {});
const seeded = blankLayer(seedComp, "light");
eq("the seed is a point light at full intensity", [seeded.light.kind, seeded.light.intensity], ["point", 100]);
ok2("the seed sits at the camera's home, not in the layer plane",
  Array.isArray(seeded.transform.position) && seeded.transform.position.length === 3
  && seeded.transform.position[2] < 0,
  JSON.stringify(seeded.transform.position));

console.log("\n  -- LIGHTS: the property paths resolve where they render --");

{
  const r = resolvePropPath(lit, "light.intensity");
  eq("light.intensity resolves with arity 1", [r.path, r.arity], ["light.intensity", 1]);
  const c = resolvePropPath(lit, "light.color");
  eq("light.color is a triple", c.arity, 3);
  const poi = resolvePropPath(lit, "light.pointOfInterest");
  eq("light.pointOfInterest is a triple", poi.arity, 3);

  let offKind = "";
  try { resolvePropPath(typoLight, "light.coneAngle"); } catch (e) { offKind = e.message; }
  ok2("a param the current kind does not read is refused, naming the kind",
    /point light does not read coneAngle/.test(offKind), offKind);

  let onSolid = "";
  try { resolvePropPath(comp([{ id: "s", type: "solid" }]).layers[0], "light.intensity"); }
  catch (e) { onSolid = e.message; }
  ok2("light.* on a non-light layer is refused", /light layers/.test(onSolid), onSolid);

  let kindPath = "";
  try { resolvePropPath(lit, "light.kind"); } catch (e) { kindPath = e.message; }
  ok2("light.kind is refused as a keyframe target, pointing at set_layer",
    /switch, not an animatable/.test(kindPath), kindPath);
}

console.log("\n  -- MATERIALS: addressable exactly where light can reach --");

{
  const shaded = comp([{ id: "m", type: "solid", threeD: true }]).layers[0];
  const r = resolvePropPath(shaded, "material.diffuse");
  eq("material.diffuse resolves on a 3D solid", [r.path, r.arity], ["material.diffuse", 1]);

  let flat = "";
  try { resolvePropPath(comp([{ id: "f", type: "solid" }]).layers[0], "material.diffuse"); }
  catch (e) { flat = e.message; }
  ok2("...but a 2D layer is refused, naming the fix", /threeD: true/.test(flat), flat);

  let onLight = "";
  try { resolvePropPath(lit, "material.diffuse"); } catch (e) { onLight = e.message; }
  ok2("...and a light has no surface to shade", /no surface to shade/.test(onLight), onLight);
}

console.log("\n  -- the enumerator offers Light and Material only where real --");

{
  const rows = layerProperties(lit);
  const lightRows = rows.filter((r) => r.group === "Light");
  eq("a spot light enumerates exactly the params a spot reads",
    lightRows.map((r) => r.path).sort(),
    LIGHT_KIND_PARAMS.spot.map((k) => `light.${k}`).sort());
  ok2("...each with a range even without the python catalog",
    lightRows.every((r) => r.path === "light.pointOfInterest" || Array.isArray(r.range)),
    JSON.stringify(lightRows.map((r) => [r.path, r.range])));
  ok2("...and the keyed intensity reads as animated",
    lightRows.find((r) => r.path === "light.intensity")?.animated === true);

  const shaded = comp([{ id: "m", type: "solid", threeD: true }]).layers[0];
  const mat = layerProperties(shaded).filter((r) => r.group === "Material");
  eq("a 3D solid enumerates the four material numerics",
    mat.map((r) => r.path).sort(), Object.keys(MATERIAL_PROP_SPEC).map((k) => `material.${k}`).sort());
  eq("a 2D solid enumerates none",
    layerProperties(comp([{ id: "f", type: "solid" }]).layers[0]).filter((r) => r.group === "Material").length, 0);
  eq("a light enumerates no Material group (nothing shades a light)",
    layerProperties(lit).filter((r) => r.group === "Material").length, 0);
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
