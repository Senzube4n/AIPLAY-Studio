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
import { blankComp, blankLayer, migrate, LAYER_TYPES } from "./store.js";

let pass = 0;
const failures = [];

function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}\n          got  ${g}\n          want ${w}`); }
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

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
