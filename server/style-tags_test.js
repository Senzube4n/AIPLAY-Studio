/** The Music page's style chips: the genre list, the other tag lists, and the random hand. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const tags = await import("../web/style-tags.js");
const { GENRES, VOCALS, MOODS, INSTRUMENTS, RHYTHM, PRODUCTION, HAND, dealStyleTags } = tags;
const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");

test("the whole genre list is in, once each, with its punctuation put back", () => {
  assert.ok(GENRES.length > 6000, `${GENRES.length} genres`);
  assert.equal(new Set(GENRES).size, GENRES.length, "no duplicates");
  for (const g of ["pop", "r&b", "singer-songwriter", "post-punk", "lo-fi beats", "k-pop"]) assert.ok(GENRES.includes(g), g);
  for (const g of ["rb", "singersongwriter", "postpunk", "kpop"]) assert.ok(!GENRES.includes(g), `${g} was respelled`);
  assert.ok(GENRES.every((g) => typeof g === "string" && g === g.trim() && g.length > 0));
});

test("the other lists cover vocals, moods, instruments, tempo and production", () => {
  for (const [name, list] of Object.entries({ VOCALS, MOODS, INSTRUMENTS, RHYTHM, PRODUCTION })) {
    assert.ok(list.length >= 20, `${name} has ${list.length}`);
    assert.equal(new Set(list).size, list.length, `${name} has no duplicates`);
  }
  assert.ok(VOCALS.includes("female vocal") && VOCALS.includes("male vocal") && VOCALS.includes("instrumental, no vocals"));
});

test("a hand is the configured size, a few of each kind, with no repeats", () => {
  const hand = dealStyleTags();
  const size = Object.values(HAND).reduce((n, k) => n + k, 0);
  assert.equal(hand.length, size);
  assert.equal(new Set(hand).size, hand.length);
  assert.equal(hand.filter((t) => GENRES.includes(t)).length >= HAND.GENRES, true);
  assert.ok(hand.some((t) => VOCALS.includes(t)) && hand.some((t) => MOODS.includes(t)));
  // A fixed random source gives a fixed hand; a different one gives a different hand.
  let i = 0; const seq = () => ((i++ * 0.6180339887) % 1);
  const a = dealStyleTags(seq); i = 0; const b = dealStyleTags(seq);
  assert.deepEqual(a, b);
  assert.notDeepEqual(dealStyleTags(() => 0.99), dealStyleTags(() => 0.01));
});

test("the page deals a hand once and the random button deals a new one", () => {
  assert.match(app, /import \{ dealStyleTags, GENRES \} from "\.\/style-tags\.js";/);
  assert.match(app, /\$\("chipRandom"\)\.onclick = \(\) => \{ paintChips\(null, true\);/);
  assert.match(app, /if \(chipsPainted && !reroll\) return;/, "a poll never reshuffles under the cursor");
  assert.match(app, /for \(const c of dealStyleTags\(\)\)/);
  assert.doesNotMatch(app, /STYLE_CHIPS|YUE_CHIPS|onclick = \(\) => \{\};/);
  assert.match(html, /id="chipRandom" title="Random styles"/);
  assert.doesNotMatch(html, /coming soon/);
});
