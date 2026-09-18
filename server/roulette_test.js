/** The Genre Roulette (web/roulette.js): drum geometry, reel paths, easing, the
 *  style line it writes, and its wiring on the Music page. No browser needed. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// roulette.js touches `document` only inside init(); give it an inert one.
globalThis.document = { readyState: "complete", getElementById: () => null, addEventListener() {} };
const { REELS, drumTransform, reelPath, easeReel, styleLine } = await import("../web/roulette.js");
const { GENRES, VOCALS, INSTRUMENTS } = await import("../web/style-tags.js");
const js = readFileSync(new URL("../web/roulette.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../web/styles.css", import.meta.url), "utf8");

test("six reels, each drawing from its own list", () => {
  assert.deepEqual(REELS.map((r) => r.key), ["genre", "vocals", "instrument", "mood", "rhythm", "production"]);
  assert.equal(REELS[0].pool, GENRES);
  assert.equal(REELS[1].pool, VOCALS);
  assert.equal(REELS[2].pool, INSTRUMENTS);
  assert.ok(REELS.every((r) => r.pool.length > 0));
});

test("the drum curves top and bottom symmetrically and leaves the centre flat and bright", () => {
  const mid = drumTransform(0);
  assert.equal(mid.y, 0); assert.equal(mid.z, 0); assert.equal(mid.opacity, 1);
  const up = drumTransform(-3), down = drumTransform(3);
  assert.ok(Math.abs(up.y + down.y) < 1e-9, "mirror image above and below");
  assert.ok(up.z < 0 && down.z < 0, "the top and bottom recede");
  assert.ok(down.opacity < 1 && drumTransform(5).opacity < down.opacity, "and dim toward the edge");
  assert.ok(drumTransform(1).y > 0 && drumTransform(2).y > drumTransform(1).y, "rows stay in order");
  assert.ok(Math.abs(drumTransform(1).rot) < 0.3, "a gentle curve, not a strong fish-eye");
});

test("a reel's path is the requested length and lands on the chosen result", () => {
  const path = reelPath(["a", "b", "c"], "z", 40, () => 0.5);
  assert.equal(path.length, 40); assert.equal(path.at(-1), "z");
  assert.ok(path.slice(0, -1).every((x) => x === "b"));
});

test("the easing starts at rest, settles just past the line, and ends exactly on it", () => {
  assert.ok(Math.abs(easeReel(0)) < 1e-12); assert.ok(Math.abs(easeReel(1) - 1) < 1e-12);
  const peak = Math.max(...Array.from({ length: 101 }, (_, i) => easeReel(i / 100)));
  assert.ok(peak > 1 && peak < 1.08, `a small detent (${peak.toFixed(3)})`);
});

test("Populate writes one line, or the three Guided fields", () => {
  const r = { genre: "jazz", vocals: "female vocal", instrument: "piano", mood: "dreamy", rhythm: "92 BPM", production: "minor key" };
  assert.deepEqual(styleLine(r), { caption: "jazz, female vocal, piano, dreamy, 92 BPM, minor key" });
  assert.deepEqual(styleLine(r, true), { capMeta: "jazz, dreamy, 92 BPM, minor key", capVocal: "female vocal", capArr: "piano" });
});

test("the page has the G.R. button on the Styles box and a dialog with Spin, Reroll and Populate", () => {
  // G.R. sits in the tool row under the Styles box, beside the gallery and Enhance.
  assert.match(html, /<summary>Styles<\/summary>/);
  assert.match(html, /<button class="grbtn" type="button" id="grOpen"[\s\S]*?G\.R\. <span aria-hidden="true">⤮<\/span><\/button>\s*<div class="ptools" data-field="style"/);
  for (const id of ["grDlg", "grReels", "grSpin", "grReroll", "grPopulate", "grClose", "grResult", "grHint"]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /<script type="module" src="roulette\.js"><\/script>/);
  assert.match(js, /e\.preventDefault\(\); e\.stopPropagation\(\); open\(\);/, "opening it does not fold the Styles box");
  assert.match(js, /dispatchEvent\(new Event\("input", \{ bubbles: true \}\)\)/, "the page reacts as if typed");
});

test("reels start one after another, spin a few seconds, and always land", () => {
  assert.match(js, /start: i \* 220, dur: 2400 \+ i \* 450/);
  assert.match(js, /setTimeout\(land, Math\.max\(\.\.\.plans\.map\(\(p\) => p\.start \+ p\.dur\)\) \+ 150\)/,
    "a hidden window gets no animation frames; the spin still finishes");
  assert.match(js, /prefers-reduced-motion/);
});

test("the window has perspective, a vignette top and bottom, and a centre line", () => {
  assert.match(css, /\.grwin \{[^}]*perspective: 640px/);
  assert.match(css, /\.grvig \{[^}]*linear-gradient\(180deg/);
  assert.match(css, /\.grline \{/);
  assert.match(js, /<i class="grvig"><\/i><i class="grline"><\/i>/, "the line sits above the vignette");
});
