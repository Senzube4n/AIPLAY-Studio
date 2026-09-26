/**
 * The Models screen's search (web/modelsearch.js): #tags narrow to a section
 * or a state, every other word must be somewhere in the row.
 *
 *   node --test server/modelsearch_test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { parseQuery, matches, queryFor, modelName } = await import("../web/modelsearch.js");
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const rows = [
  { id: "video", label: "MiniMax H3 video", group: "video", ready: true, files: [{ name: "minimax_h3_fl2va_pruned-w4a8_convrot_pruned.safetensors" }] },
  { id: "videoLtx", label: "LTX 2.5", group: "video", ready: false, why: "Lightricks video model" },
  { id: "engine", label: "MiniMax Music 3", group: "music", ready: true },
  { id: "lyrics", label: "Whisper", group: "music", ready: false, why: "Transcription and timed lyrics" },
  { id: "chatQwen3", label: "Qwen3 writer", group: "chat", ready: true },
];
const find = (q) => rows.filter((c) => matches(c, parseQuery(q))).map((c) => c.id);

test("tags pick a section, words must all appear", () => {
  assert.deepEqual(find("#video"), ["video", "videoLtx"]);
  assert.deepEqual(find("#video h3"), ["video"]);
  assert.deepEqual(find("minimax"), ["video", "engine"]);
  assert.deepEqual(find("#music minimax"), ["engine"]);
  assert.deepEqual(find("#audio"), ["engine", "lyrics"], "a synonym for the music section");
  assert.deepEqual(find("#writing"), ["chatQwen3"]);
  assert.deepEqual(find("w4a8"), ["video"], "file names count");
  assert.deepEqual(find("#whisper"), ["lyrics"], "an unknown tag is a word");
  assert.deepEqual(find("#video #missing"), ["videoLtx"]);
  assert.deepEqual(find("#ready #music"), ["engine"]);
  assert.deepEqual(find("nothing-like-this"), []);
  assert.deepEqual(find(""), rows.map((c) => c.id));
});

test("the query a Pre-Configure row points with finds its row", () => {
  for (const c of rows) assert.ok(find(queryFor(c)).includes(c.id), queryFor(c));
  assert.equal(queryFor(rows[1]), "#video LTX 2.5");
  assert.equal(modelName({ label: "Images — Krea 2 Turbo (community licence)" }), "Krea 2 Turbo");
  assert.equal(modelName({ label: "Video clips — LTX 2.5 (quantised)" }), "LTX 2.5");
});

test("app.js paints it after every list paint, and a search does not save open sections", () => {
  const app = read("../web/app.js");
  assert.match(app, /import \{ paintSearch, searchModels, queryFor, modelName \} from "\.\/modelsearch\.js";/);
  assert.match(app, /paintSearch\(d, \{ getOpen: modelGroupsOpen \}\);/);
  assert.match(app, /if \(\$\("modelList"\)\.dataset\.searching\) return;/);
  assert.match(app, /<h3>Pre-Configure Models<\/h3>/);
  for (const id of ["modelMusicPick", "mpImage", "mpCover", "mpVideo", "mpChat", "mpLyrics"]) assert.ok(app.includes(`"${id}"`), id);
});
