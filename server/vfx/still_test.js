/**
 * A COMPOSITOR FRAME BECOMES A LIBRARY PICTURE.
 *
 * server/vfx/shapes.py calls itself "the vector side of the compositor" and
 * carries a retained, animatable model — path, rect, ellipse, gradientFill,
 * stroke, group, transform, trim, repeater — plus per-character text animators,
 * masks, mattes, styles and the same 88 effects. That is what a title card, a
 * lower third and a lyric plate are actually built from, and until this route
 * existed none of it could become a picture: no library image, no image_export,
 * no gallery row, no MV board. The compositor persisted a layered document and
 * stopped one inch short of a still.
 *
 * ⚠ AND A FILE IN THE FOLDER IS NOT A LIBRARY PICTURE. vfx/routes.js cannot
 * reach index.js's imageMeta writer, so it calls an injected `rememberImage`
 * behind a guard and reports `remembered:false` when it is absent — which is
 * honest, and also exactly how this could ship half-working: the PNG lands, the
 * reply says ok, and the gallery never hears about it. The pins below check the
 * WIRE as well as the route, because the route was written to survive without
 * it.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
const ok = (what, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ok    ${what}`); }
  else { failed++; console.log(`  FAIL  ${what}${extra ? `\n        ${extra}` : ""}`); }
};
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const routes = src("./routes.js");
const mcp = src("../mcp-vfx.js");
const index = src("../index.js");

console.log("\nA COMPOSITOR FRAME AS A PICTURE");

ok("the route exists and writes into the image library",
  /\/api\/vfx\/still/.test(routes) && /IMAGE_DIR/.test(routes));
ok("...and there is a tool for it, because a person and an assistant get the same doors",
  /name: "vfx_still"/.test(mcp));

/* ⚠ THE WIRE. The route degrades gracefully without rememberImage, so its own
 * success is not evidence the library knows. index.js has to supply it. */
ok("index.js supplies rememberImage to the vfx factory",
  /rememberImage: \(name, meta\) =>/.test(index),
  "without it the route writes a real PNG the gallery never hears about, and says ok");
ok("...and it writes the imageMeta row the rest of the app reads",
  /rememberImage: \(name, meta\) => \{[\s\S]{0,300}imageMeta\.set\(/.test(index));
ok("...and saves the store, or the row is gone at the next restart",
  /rememberImage: \(name, meta\) => \{[\s\S]{0,400}saveImageStore\(\)/.test(index));

/* The route must not pretend. It reports which of the two actually happened. */
ok("the reply says whether the library was told, rather than assuming it",
  /remembered/.test(routes),
  "a caller that cannot tell a filed picture from an orphan file will assume the good one");

/* It renders through the existing frame path rather than a second renderer:
 * two renderers disagree, and the disagreement shows up as a still that does
 * not match the preview it was taken from. */
ok("it goes through the compositor's own frame render, not a second one",
  !/new\s+Renderer\(|spawnRenderer/.test(routes.slice(routes.indexOf("/api/vfx/still"))),
  "a second renderer is a second answer to what the comp looks like");

console.log(`\n  ${passed} passed, ${failed} failed`);
assert.equal(failed, 0, `${failed} vfx-still pins failed`);
