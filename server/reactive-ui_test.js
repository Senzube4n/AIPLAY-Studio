/** Exercise the actual Reactive event handlers without a browser, server or GPU. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const code = app.slice(app.indexOf("let reactPicked = [];"), app.indexOf("/* ── API mode", app.indexOf("let reactPicked = [];")));
function fixture() {
  const nodes = new Map(), calls = [];
  const node = (id) => {
    if (!nodes.has(id)) {
      const tag = new RegExp(`<([a-z]+)\\b[^>]*\\bid="${id}"[^>]*>`, "i").exec(html), attrs = tag?.[0] || "";
      const content = tag ? html.slice(tag.index + attrs.length).split(`</${tag[1]}>`)[0] : "";
      const selected = /<option\b[^>]*selected[^>]*>/.exec(content)?.[0] || /<option\b[^>]*>/.exec(content)?.[0] || "";
      const value = /value="([^"]*)"/.exec(tag?.[1] === "select" ? selected : attrs)?.[1] || "";
      nodes.set(id, { value, defaultValue: value, checked: /\bchecked\b/.test(attrs), defaultChecked: /\bchecked\b/.test(attrs),
        dataset: {}, handlers: {}, hidden: false, innerHTML: "", textContent: "", duration: NaN, currentTime: 0, tagName: (tag?.[1] || "div").toUpperCase(),
        addEventListener(type, fn) { this.handlers[type] = fn; }, querySelectorAll() { return []; },
        removeAttribute(name) { delete this[name]; }, pause() { this.paused = true; }, async play() { this.paused = false; },
        classList: { toggle() {} }, setAttribute() {},
      });
    }
    return nodes.get(id);
  };
  const context = vm.createContext({ $: node, esc: String, document: { querySelectorAll: () => [] },
    state: { library: [], images: [] }, fetch: async (url, options) => { calls.push({ url, body: options?.body ? JSON.parse(options.body) : null }); return { json: async () => ({ error: "fixture stops before rendering" }) }; },
  });
  vm.runInContext(code, context);
  node("reactSong").value = "song.wav";
  return { node, calls, run: (code) => vm.runInContext(code, context), fire: (id, type = "click", target = {}) => node(id).handlers[type]?.({ target }) };
}

test("settings review and Render use the exact same request; review never queues", async () => {
  const f = fixture(); f.node("reactStart").value = "25.5"; f.node("reactSecs").value = "8";
  f.run('reactPicked = ["dance.mp4", "look.png"]; reactStyle = "motion"');
  f.node("reactMotionSourceStart").value = "15.76"; f.node("reactMotionSourceSpeed").value = "1.25";
  await f.fire("reactReviewRefresh");
  const preview = JSON.parse(f.node("reactRequestJson").textContent);
  assert.equal(preview.start, 25.5); assert.equal(preview.motion.sourceStart, 15.76); assert.equal(preview.motion.sourceSpeed, 1.25);
  assert.equal(f.calls.length, 0); assert.match(f.node("reactReview").innerHTML, /96 motion frames/);
  assert.match(f.node("reactReview").innerHTML, /Wall time and peak VRAM are not estimated/);
  await f.fire("reactGo");
  assert.deepEqual(f.calls, [{ url: "/api/reactive/run", body: preview }]);
});

test("Paint requires a picture and Motion rejects an overlong request before a POST", async () => {
  const f = fixture(); f.run('reactPicked = ["dance.mp4"]; reactStyle = "paint"');
  await f.fire("reactGo"); assert.match(f.node("reactNote").textContent, /reference picture/); assert.equal(f.calls.length, 0);
  f.run('reactStyle = "motion"'); f.node("reactSecs").value = "121";
  await f.fire("reactGo"); assert.match(f.node("reactNote").textContent, /2 to 120/); assert.equal(f.calls.length, 0);
  f.node("reactSecs").value = "4"; f.run('reactPicked = ["look.png"]');
  await f.fire("reactGo"); assert.match(f.node("reactNote").textContent, /pick one in the Clips grid/); assert.equal(f.calls.length, 0);
});

test("reordering selected media changes the actual submitted source order", async () => {
  const f = fixture(); f.run('reactPicked = ["first.mp4", "look.png", "second.mp4"]; reactStyle = "motion"');
  const target = { closest: () => ({ dataset: { mediaIndex: "2", mediaAction: "earlier" } }) };
  await f.fire("reactSelected", "click", target);
  target.closest = () => ({ dataset: { mediaIndex: "1", mediaAction: "earlier" } });
  await f.fire("reactSelected", "click", target);
  assert.deepEqual(JSON.parse(f.node("reactRequestJson").textContent).pictures, ["second.mp4", "first.mp4", "look.png"]);
  assert.equal(f.node("reactSourceVideo").src, "/api/clip/second.mp4");
  assert.equal(f.calls.length, 0);
});

test("the short test changes only duration and region listening stops at its selected end", async () => {
  const f = fixture(); f.run('reactPicked = ["dance.mp4", "look.png"]; reactStyle = "motion"');
  f.node("reactSecs").value = "45"; f.node("reactStart").value = "12"; f.node("reactMotionSeed").value = "1234";
  const before = JSON.parse(f.run("JSON.stringify(reactRequest())"));
  await f.fire("reactShortTest");
  const after = JSON.parse(f.node("reactRequestJson").textContent);
  assert.deepEqual(after, { ...before, seconds: 4 }); assert.equal(f.calls.length, 0);
  await f.fire("reactListen"); assert.equal(f.node("reactSongPlayer").currentTime, 12);
  f.node("reactSongPlayer").currentTime = 16; await f.fire("reactSongPlayer", "timeupdate");
  assert.equal(f.node("reactSongPlayer").paused, true);
});
