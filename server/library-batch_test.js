/** The Library acting on several songs at once: the archive flag, adding many
 *  to a playlist, the one-request batch route, the selection bar, sessions that
 *  open by date, and MiniMax's Instrumental as a switch in the Lyrics box. */
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const parent = path.resolve(tmpdir()), scratch = await mkdtemp(path.join(parent, "aiplay-libbatch-test-"));
process.env.AIPLAY_APPDATA = path.join(scratch, "appdata");
process.env.AIPLAY_RIG = path.join(scratch, "rig");
process.env.AIPLAY_OUTPUT = path.join(scratch, "output");
process.env.AIPLAY_PYTHON = path.join(scratch, "must-not-run-python.exe");
const { Library } = await import("./library.js");
after(async () => {
  assert.equal(path.dirname(path.resolve(scratch)), parent);
  await rm(scratch, { recursive: true, force: true });
});
const src = (rel) => readFile(new URL(rel, import.meta.url), "utf8").then((s) => s.replace(/\r\n/g, "\n"));

test("archived is a flag the library keeps and lists; unknown flags are still refused", async () => {
  await mkdir(process.env.AIPLAY_OUTPUT, { recursive: true });
  await writeFile(path.join(process.env.AIPLAY_OUTPUT, "aiplay_00001.mp3"), Buffer.alloc(64));
  const lib = new Library();
  await lib.load();
  assert.equal(lib.setFlag("aiplay_00001.mp3", "archived", true), true);
  assert.equal(lib.setFlag("aiplay_00001.mp3", "deleted", true), false);
  const row = (await lib.list()).find((t) => t.file === "aiplay_00001.mp3");
  assert.equal(row?.archived, true);
});

test("adding several songs to a playlist never takes one out again", () => {
  const lib = new Library();
  const pl = lib.createPlaylist("Mix");
  lib.addToPlaylist(pl.id, ["a.flac", "b.flac"]);
  lib.addToPlaylist(pl.id, ["b.flac", "c.flac"]);
  assert.deepEqual(pl.files, ["a.flac", "b.flac", "c.flac"], "a toggle would have removed b.flac");
});

test("one request acts on many songs, each judged on its own", async () => {
  const index = await src("./index.js");
  const at = index.indexOf('if (b.action === "batch")');
  assert.ok(at > 0 && at < index.indexOf('const file = String(b.file || "");', at), "the batch branch runs before the single-file check");
  const batch = index.slice(at, at + 2200);
  assert.match(batch, /files\.some\(bad\)/, "every name is checked for path tricks");
  assert.match(batch, /\["starred", "pinned", "archived"\]\.includes\(b\.flag\)/);
  assert.match(batch, /catch \(err\) \{ failed\.push/, "one bad file does not stop the rest");
  assert.match(batch, /library: await library\.list\(\), trash: await library\.listTrash\(\)/, "listed once, not per song");
  assert.match(index, /b\.action === "add" && Array\.isArray\(b\.files\)/);
});

test("the page: tick boxes, the bar, session boxes, and today/yesterday open", async () => {
  const html = await src("../web/index.html"), app = await src("../web/app.js"), css = await src("../web/styles.css");
  for (const k of ["star", "pin", "archive", "playlist", "stems", "lrc", "restore", "trash", "clear"]) {
    assert.match(html, new RegExp(`data-batch="${k}"`), k);
  }
  assert.match(html, /id="batchAll"/);
  assert.match(html, /<option value="archived">/);
  assert.match(app, /<input type="checkbox" data-sel="\$\{f\}"/, "every row has its box");
  assert.match(app, /data-grpsel="\$\{esc\(g\.id\)\}"/, "every session has its box");
  assert.match(app, /const byDefault = mode !== "session" \|\| \(anyRecent \? recent\.has\(g\.day\) : i === 0\);/);
  assert.match(app, /new Set\(\[dayKey\(now\), dayKey\(yest\)\]\)/);
  assert.match(app, /done = f === "archived" \? done\.filter\(\(t\) => t\.archived\) : done\.filter\(\(t\) => !t\.archived\);/);
  assert.match(app, /action: "batch", files/);
  assert.match(app, /Move \$\{songs\} to the trash\?/, "a batch trash asks first");
  assert.match(css, /\.batchbar \{ flex: none; \}/, "the bar is not squeezed by the library's flex column");
});

test("MiniMax: Write / Structure is a two-sided switch in the Lyrics box, YuE2 keeps its tab", async () => {
  const html = await src("../web/index.html"), app = await src("../web/app.js");
  // A switch with both sides visible, not one button naming the side you are NOT on.
  assert.match(html, /<summary>Lyrics<span class="lyrswap" id="lyricsSwap" hidden role="group"/);
  assert.match(html, /data-lyrmode="song"[^>]*>Write<\/button>/);
  assert.match(html, /data-lyrmode="instrumental"[^>]*>Structure<\/button>/);
  assert.match(app, /return !!eng\?\.instrumentalToggle && !yueEngine\(\) && !eng\?\.ace;/);
  assert.match(app, /\$\("modeInstr"\)\.hidden = inBox \|\|/);
  assert.match(app, /e\.preventDefault\(\); e\.stopPropagation\(\);/,
    "the switch does not fold the box it sits in");
  assert.match(app, /if \(!side \|\| side\.dataset\.lyrmode === state\.mode\) return;/,
    "pressing the side you are already on does nothing");
  // One field, two ways to fill it: the picker takes the tag strip's place, and
  // its text lands in the box where the words would be.
  assert.match(app, /\$\("lyricTags"\)\.hidden = structure;/);
  assert.match(app, /\$\("scaffold"\)\.hidden = !structure;/);
  assert.match(html, /<textarea id="scaffold" rows="7"/, "a textarea, not a <pre> in a black box");
  assert.doesNotMatch(html, /class="scaffold"/);
});
