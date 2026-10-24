/** Run the actual gallery functions with fake rows and HTTP. No media or engine. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const part = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
const code = [
  part("async function loadClips()", "/* The clip library."),
  part("var clipStarRevision =", "/* Grouping, keyed"),
  part("function clipPromptTitle(prompt)", "/* -- the clip viewer"),
  part("var clipView =", 'document.addEventListener("click", (e) => {\n  const star ='),
].join("\n");
function fixture(request) {
  const elements = new Map(), buttons = [], errors = [];
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { value: "", innerHTML: "", textContent: "", dataset: {}, attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; }, querySelectorAll: () => buttons.filter(b => !b.viewer),
      focus() { this.focused = true; } });
    return elements.get(id);
  };
  $("clipFilter").value = "all";
  $("clipSort").value = "new";
  const context = vm.createContext({ $, state: { clips: [] },
    document: { querySelectorAll: () => buttons, activeElement: null },
    stopHoverPreview() {}, observeLazyVideos() {},
    clipGroupedHtml: rows => rows.map(c => c.name).join(","),
    clipDate: () => "today", fmt: String,
    esc: s => String(s ?? "").replaceAll('"', "&quot;").replaceAll("<", "&lt;"),
    failSay: value => errors.push(value.error), fetch: request,
  });
  vm.runInContext(code, context);
  const button = (name, viewer = false) => {
    const b = { dataset: { cstar: name }, viewer, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
    buttons.push(b); return b;
  };
  return { context, $, errors, button };
}
const response = data => ({ ok: true, json: async () => data });
const clip = (name, starred = false, at = 1) => ({ name, starred, at, bytes: 20, meta: {} });

test("starred filtering combines with search, sort and the viewer's exact order", () => {
  const f = fixture();
  f.context.state.clips = [clip("older.mp4", true, 1), clip("other.mp4", false, 4), clip("newer.mp4", true, 3)];
  f.$("clipFilter").value = "starred";
  f.context.paintClips();
  assert.deepEqual(Array.from(f.context.clipViewList()), ["newer.mp4", "older.mp4"]);
  f.$("clipSearch").value = "older";
  f.context.paintClips();
  assert.deepEqual(Array.from(f.context.clipViewList()), ["older.mp4"]);
  f.$("clipSearch").value = "missing";
  f.context.paintClips();
  assert.deepEqual(Array.from(f.context.clipViewList()), []);
  assert.match(f.$("clipGrid").innerHTML, /Nothing matches/);
});

test("cards have a visible keyboard button with escaped names and toggle state", () => {
  const f = fixture();
  const card = f.context.clipCard(clip('a"<.mp4', true));
  assert.match(card, /type="button" data-cstar="a&quot;&lt;\.mp4"/);
  assert.match(card, /aria-pressed="true" aria-label="Remove from favourites"/);
  assert.match(card, />★<\/button>/);
  assert.match(html, /option value="starred">★ Starred/);
  assert.match(html, /id="clipViewStar"[^>]+aria-pressed="false"/);
});

test("saving waits for success, disables duplicate presses and updates both surfaces", async () => {
  let finish, count = 0, body;
  const f = fixture(async (_url, options) => {
    count++; body = JSON.parse(options.body);
    return new Promise(resolve => { finish = () => resolve(response({ ok: true, starred: true })); });
  });
  f.context.state.clips = [clip("take.mp4")];
  const tile = f.button("take.mp4"), viewer = f.button("take.mp4");
  const pending = f.context.toggleClipStar("take.mp4");
  assert.equal(tile.attrs["aria-disabled"], "true");
  assert.equal(viewer.attrs["aria-busy"], "true");
  assert.equal(tile.disabled, false);
  assert.equal(f.context.state.clips[0].starred, false);
  await f.context.toggleClipStar("take.mp4");
  assert.equal(count, 1);
  assert.deepEqual(body, { action: "flag", flag: "starred", name: "take.mp4", value: true });
  // A poll can have replaced the row while the POST is still waiting.
  f.context.state.clips = [clip("take.mp4")];
  finish(); await pending;
  assert.deepEqual(f.errors, []);
  assert.equal(f.context.state.clips[0].starred, true);
  for (const b of [tile, viewer]) {
    assert.equal(b.disabled, false);
    assert.equal(b.textContent, "★");
    assert.equal(b.attrs["aria-pressed"], "true");
  }
  assert.equal(f.$("clipViewMedia").innerHTML, ""); // no viewer repaint/restart
});

test("a failed save leaves the favourite untouched and re-enables retry", async () => {
  const f = fixture(async () => ({ ok: false, json: async () => ({ error: "Disk is full." }) }));
  f.context.state.clips = [clip("keep.mp4", true)];
  const b = f.button("keep.mp4");
  await f.context.toggleClipStar("keep.mp4");
  assert.equal(f.context.state.clips[0].starred, true);
  assert.deepEqual(f.errors, ["Disk is full."]);
  assert.equal(b.disabled, false);
});

test("unfavouriting removes the row from Starred without changing other favourites", async () => {
  const f = fixture(async () => response({ ok: true, starred: false }));
  f.context.state.clips = [clip("remove.mp4", true), clip("keep.mp4", true)];
  f.$("clipFilter").value = "starred";
  await f.context.toggleClipStar("remove.mp4");
  assert.deepEqual(f.errors, []);
  assert.deepEqual(Array.from(f.context.clipViewList()), ["keep.mp4"]);
  assert.equal(f.context.state.clips[1].starred, true);
});

test("an open viewer keeps playback but its arrows follow the remaining favourites", async () => {
  const f = fixture(async () => response({ ok: true, starred: false }));
  f.context.state.clips = [clip("a.mp4", true, 3), clip("b.mp4", true, 2), clip("c.mp4", true, 1)];
  f.$("clipFilter").value = "starred";
  f.context.paintClips(); f.context.openClipView("b.mp4");
  const playing = f.$("clipViewMedia").innerHTML;
  await f.context.toggleClipStar("b.mp4");
  assert.deepEqual(f.errors, []);
  assert.equal(f.$("clipViewMedia").innerHTML, playing);
  assert.equal(f.$("clipViewPos").textContent, "Not in results");
  assert.deepEqual(Array.from(f.context.clipView.list), ["a.mp4", "c.mp4"]);
  // Repainting from a poll retains the anchor around the now-unstarred item.
  f.context.paintClips();
  f.context.clipViewStep(1);
  assert.equal(f.context.clipView.name, "c.mp4");
  f.context.clipViewStep(-1);
  assert.equal(f.context.clipView.name, "a.mp4");
  f.$("clipSearch").value = "no result"; f.context.paintClips();
  assert.equal(f.$("clipViewPrev").disabled, true);
  assert.equal(f.$("clipViewNext").disabled, true);
});

test("a library read error preserves the previous rows and reports it", async () => {
  const f = fixture(async () => response({ error: "The favourites file cannot be read." }));
  f.context.state.clips = [clip("keep.mp4", true)];
  await f.context.loadClips();
  assert.equal(f.context.state.clips[0].name, "keep.mp4");
  assert.deepEqual(f.errors, ["The favourites file cannot be read."]);
});

test("unstarred card focus returns to the filter instead of the hidden viewer", async () => {
  const f = fixture(async () => response({ ok: true, starred: false }));
  f.context.state.clips = [clip("remove.mp4", true)];
  f.$("clipFilter").value = "starred";
  const hiddenViewer = f.button("remove.mp4", true);
  hiddenViewer.focus = () => assert.fail("focused a hidden viewer button");
  f.context.document.activeElement = { dataset: { cstar: "remove.mp4" }, isConnected: false };
  await f.context.toggleClipStar("remove.mp4");
  assert.deepEqual(f.errors, []);
  assert.equal(f.$("clipFilter").focused, true);
});

test("an older poll cannot undo a saved favourite", async () => {
  let finishPoll;
  const f = fixture(async (_url, options) => options?.method === "POST"
    ? response({ ok: true, starred: true })
    : new Promise(resolve => { finishPoll = () => resolve(response({ clips: [clip("take.mp4")] })); }));
  f.context.state.clips = [clip("take.mp4")];
  const poll = f.context.loadClips();
  await f.context.toggleClipStar("take.mp4");
  finishPoll(); await poll;
  assert.equal(f.context.state.clips[0].starred, true);
});

test("star click returns before opening or stepping the viewer", async () => {
  const listener = part('document.addEventListener("click", (e) => {\n  const star =', 'document.addEventListener("keydown", (e) => {\n  const box = $("clipView")');
  let callback, calls = 0, prevented = false, stopped = false;
  vm.runInNewContext(listener, { document: { addEventListener: (_type, fn) => { callback = fn; } },
    toggleClipStar: name => { assert.equal(name, "take.mp4"); calls++; },
    openClipView: () => assert.fail("star opened the viewer"),
  });
  callback({ target: { closest: selector => { assert.equal(selector, "[data-cstar]"); return { dataset: { cstar: "take.mp4" } }; } },
    preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
  assert.equal(calls, 1); assert.equal(prevented, true); assert.equal(stopped, true);
});
