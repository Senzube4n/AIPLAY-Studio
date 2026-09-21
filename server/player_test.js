/**
 * THE LIBRARY PLAYER'S "NEXT", with repeat off.
 *
 * A pinned song is drawn twice (Pinned and the list), and "next" after the
 * pinned copy was the same song: with repeat off, it played forever. The real
 * visibleTracks/step pair runs here against a fake page.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const code = app.match(/function visibleTracks\(\) \{[\s\S]*?\nfunction step\(dir, auto = false\) \{[\s\S]*?\n\}/)[0];

function page(files, playing, extra = {}) {
  const rows = (sel) => (sel.startsWith("#rows") ? files : [files[0], ...files]).map((f) => ({ dataset: { file: f, title: f, seed: "1" } }));
  const played = [];
  const ctx = { document: { querySelectorAll: rows }, audio: { src: `http://x/api/audio/${playing}` }, state: { shuffle: false, ...extra },
    play: (f) => played.push(f), decodeURIComponent };
  runInNewContext(`${code}; this.step = step;`, ctx);
  return { step: ctx.step, played };
}

test("the end of a song moves on, never back to itself, and stops at the end of the list", () => {
  let p = page(["a.flac", "b.flac", "c.flac"], "a.flac"); p.step(1, true);
  assert.deepEqual(p.played, ["b.flac"], "the pinned copy of a is not 'next'");
  p = page(["a.flac", "b.flac"], "b.flac"); p.step(1, true);
  assert.deepEqual(p.played, [], "the last song ends the list; only repeat goes round");
  p = page(["a.flac"], "a.flac"); p.step(1, true);
  assert.deepEqual(p.played, [], "one song does not replay itself");
  p = page(["a.flac", "b.flac"], "b.flac"); p.step(1);
  assert.deepEqual(p.played, ["a.flac"], "the Next button still wraps");
  p = page(["ab.flac", "b.flac", "c.flac"], "b.flac"); p.step(1, true);
  assert.deepEqual(p.played, ["c.flac"], "a file whose name ends another's is not mistaken for it");
});
