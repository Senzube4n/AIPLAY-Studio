/**
 * YuE2 SINGS LABELLED LYRICS (server/music/yue-lyrics.js, 2026-09-27).
 *
 *   node --test server/music/yue-lyrics_test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { labelYueLyrics } from "./yue-lyrics.js";

test("the reported song: plain lines get [Verse] and a repeated block [Chorus]", () => {
  const cheese = "I love raw cheese \n\nI love raw cheese \n\nI love raw cheese \n\n\nI love raw cheese \n\n\n"
    + "I love raw cheese \n".repeat(3) + "\nWe eat it on the bus\nWe eat it in the rain";
  const r = labelYueLyrics(cheese);
  assert.equal(r.changed, true);
  const blocks = r.lyrics.split("\n\n");
  assert.equal(blocks[0], "[Chorus]\nI love raw cheese");
  assert.equal(blocks.at(-2), "[Verse]\nI love raw cheese\nI love raw cheese\nI love raw cheese");
  assert.equal(blocks.at(-1), "[Verse]\nWe eat it on the bus\nWe eat it in the rain");
  assert.ok(!/\n{3,}/.test(r.lyrics), "one blank line between sections");
});

test("the writer's own structure is never touched; nothing to label, nothing changed", () => {
  for (const l of ["[Verse]\nrain on the lane", "words\n\n[Chorus]\nlook up", "【副歌】\n words", "", "   ", null]) {
    const r = labelYueLyrics(l);
    assert.equal(r.changed, false);
    assert.equal(r.lyrics, l);
  }
  assert.equal(labelYueLyrics("one line").lyrics, "[Verse]\none line");
  assert.equal(labelYueLyrics("a\r\nb\r\n\r\nc").lyrics, "[Verse]\na\nb\n\n[Verse]\nc", "Windows line ends");
});

test("wired before every YuE2 build branches off, and not for instrumentals", () => {
  const index = readFileSync(new URL("../index.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const at = index.indexOf("if (/^yue2(-|$)/.test(requestedEngine) && !body.instrumental) {");
  assert.ok(at > 0);
  assert.ok(at < index.indexOf('if (requestedEngine === "yue2-gguf") {'), "before the GGUF door");
  assert.ok(at < index.indexOf('if (musicEngine === "yue2-comfy") {'), "and before the ComfyUI one");
  assert.match(index.slice(at, at + 400), /body\.lyrics = labelled\.lyrics;/);
});
