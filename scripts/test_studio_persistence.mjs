/** Run the editor's actual save/history functions without a browser or server. */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";

const source = readFileSync(new URL("../web/studio.js", import.meta.url), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function extract(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source);
  assert.ok(match, `editor function ${name} exists`);
  const body = source.indexOf("{", source.indexOf(")", match.index));
  let depth = 0;
  for (let i = body; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(match.index, i + 1);
  }
  throw new Error(`Unbalanced editor function ${name}`);
}

function harness() {
  const S = {
    tracks: [{ id: 1, kind: "video", items: [{ id: 2, src: "/api/clip/a.mp4", start: 0, dur: 5,
      inPoint: 1, fx: { look: "warm" }, mvClipId: "scene-1" }] }],
    nextId: 3, undo: [], redo: [], fx: { look: "none", amount: 0.5 },
    out: { w: 1280, h: 720, fps: 24, mbps: 8, codec: "auto" },
    vis: "bars", karaoke: true, showTitle: true, songTitle: "Song", lrc: [], t: 2,
    beatCfg: { sens: 0.5, band: "bass", drive: "pulse", smooth: 0.35 },
    beatMult: 1, beatSync: true, laneH: 92, visSize: 0.4, visOpacity: 0.7,
  };
  const storage = new Map(), timers = new Map(), elements = new Map(), events = [];
  let timerId = 0;
  const element = (id) => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, { type: "select-one", value: "", checked: false,
        classList: { add: (c) => classes.add(c), contains: (c) => classes.has(c) } });
    }
    return elements.get(id);
  };
  const names = ["snapshot", "pushUndo", "ownState", "projectDocument", "historySnapshot",
    "editProjectSettings", "bindProjectInput", "autosave", "restoreAutosave", "restoreProjectState",
    "restore", "undo", "redo"];
  const context = vm.createContext({ S, $: element,
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    window: { dispatchEvent: (e) => events.push(e.type) },
    CustomEvent: class { constructor(type) { this.type = type; } },
    writeRenderOpts() {}, ensureBeats() {}, paintTimeline() {}, render() {},
    attach: async (it) => { it.el = { pause() {} }; },
  });
  vm.runInContext(`const SAVE_KEY = "aiplay-studio-project";
    let saveTimer = null, settingsGesture = null;
    ${names.map(extract).join("\n")}
    globalThis.api = { ${names.join(", ")} };`, context);
  return { S, api: context.api, element, events, storage,
    flush: () => { const pending = [...timers.values()]; timers.clear(); pending.forEach((fn) => fn()); },
    saved: () => JSON.parse(storage.get("aiplay-studio-project")),
  };
}

test("named document keeps output flags and foreign workflow metadata, omitting live media", () => {
  const h = harness();
  h.S.karaoke = false; h.S.showTitle = false;
  h.S.docExtra = { name: "Named film", workflow: { revision: 8 }, futureField: ["keep"] };
  h.S.mvProjectId = "mv-film";
  const media = {}; media.self = media;
  h.S.tracks[0].items[0].el = media;
  const doc = plain(h.api.projectDocument());
  assert.equal(doc.karaoke, false);
  assert.equal(doc.showTitle, false);
  assert.equal(doc.mvProjectId, "mv-film");
  assert.deepEqual(doc.workflow, { revision: 8 });
  assert.deepEqual(doc.futureField, ["keep"]);
  assert.equal(doc.tracks[0].items[0].mvClipId, "scene-1");
  assert.equal("el" in doc.tracks[0].items[0], false);
});

test("global settings undo and redo restore nested values and refresh recovery", async () => {
  const h = harness();
  const original = plain(h.api.ownState());
  h.api.editProjectSettings(() => {
    h.S.fx.look = "vivid"; h.S.beatCfg.band = "high";
    h.S.karaoke = false; h.S.showTitle = false;
    h.S.vis = "radial"; h.S.out.fps = 60;
  });
  const edited = plain(h.api.ownState());
  await h.api.undo(); h.flush();
  assert.deepEqual(plain(h.api.ownState()), original);
  assert.equal(h.saved().fx.look, "none");
  await h.api.redo(); h.flush();
  assert.deepEqual(plain(h.api.ownState()), edited);
  assert.equal(h.saved().out.fps, 60);
  assert.equal(h.events.filter((e) => e === "aiplay-studio-edited").length, 3);
});

test("a long slider gesture has one undo step and saves its final input", async () => {
  const h = harness(), control = h.element("amount");
  control.type = "range";
  h.api.bindProjectInput("amount", () => { h.S.fx.amount = Number(control.value); });
  control.value = "0.6"; control.oninput(); h.flush();
  control.value = "0.9"; control.oninput(); control.onchange(); h.flush();
  assert.equal(h.S.undo.length, 1);
  assert.equal(h.saved().fx.amount, 0.9);
  await h.api.undo();
  assert.equal(h.S.fx.amount, 0.5);
  control.value = "0.7"; control.oninput(); control.onblur();
  assert.equal(h.S.redo.length, 0, "a new edit invalidates redo");
});

test("checkbox and select edits are tracked separately", () => {
  const h = harness();
  h.api.bindProjectInput("title", () => { h.S.showTitle = h.element("title").checked; });
  h.api.bindProjectInput("visualizer", () => { h.S.vis = h.element("visualizer").value; });
  h.element("title").onchange();
  h.element("visualizer").value = "off"; h.element("visualizer").onchange(); h.flush();
  assert.equal(h.S.undo.length, 2);
  assert.equal(h.saved().showTitle, false);
  assert.equal(h.saved().vis, "off");
});

test("crash recovery keeps the project name, metadata and flags through another save", async () => {
  const h = harness();
  h.S.docExtra = { name: "Recovered film", extra: { board: 7 } }; h.S.mvProjectId = "mv-recovered";
  h.S.karaoke = false; h.S.showTitle = false; h.S.visSize = 0.83; h.S.laneH = 120;
  h.api.autosave(); h.flush();
  delete h.S.docExtra; h.S.mvProjectId = null; h.S.karaoke = true; h.S.showTitle = true;
  assert.equal(await h.api.restoreAutosave(), true);
  h.api.autosave(); h.flush();
  const doc = h.saved();
  assert.equal(doc.name, "Recovered film");
  assert.deepEqual(doc.extra, { board: 7 });
  assert.equal(doc.mvProjectId, "mv-recovered");
  assert.equal(doc.karaoke, false); assert.equal(doc.showTitle, false);
  assert.equal(doc.visSize, 0.83); assert.equal(doc.laneH, 120);
  assert.equal(h.element("stProjName").classList.contains("dirty"), true);
});

test("opening a different project clears old history and gives legacy flags their defaults", async () => {
  const h = harness();
  h.api.editProjectSettings(() => { h.S.karaoke = false; h.S.showTitle = false; });
  await h.api.restoreProjectState({ tracks: [], name: "Another", extra: 9 }, true);
  assert.equal(h.S.undo.length, 0); assert.equal(h.S.redo.length, 0);
  assert.equal(h.S.karaoke, true); assert.equal(h.S.showTitle, true);
  assert.equal(h.S.docExtra.extra, 9);
});

test("clip edits still restore their timing alongside the project settings", async () => {
  const h = harness();
  h.api.pushUndo();
  h.S.tracks[0].items[0].inPoint = 3;
  h.S.tracks[0].items[0].dur = 2;
  await h.api.undo();
  assert.equal(h.S.tracks[0].items[0].inPoint, 1);
  assert.equal(h.S.tracks[0].items[0].dur, 5);
  await h.api.redo();
  assert.equal(h.S.tracks[0].items[0].inPoint, 3);
  assert.equal(h.S.tracks[0].items[0].dur, 2);
});
