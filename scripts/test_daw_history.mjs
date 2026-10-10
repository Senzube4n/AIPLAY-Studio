/** The actual editor history functions against real DAW routes and storage.
 * Disposable CPU-only fixture: no live Studio, Python, audio or GPU jobs. */
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { resizeNoteDurations } from "../web/daw-editing.js";

const fixture = await mkdtemp(path.join(os.tmpdir(), "aiplay-daw-history-"));
process.env.AIPLAY_OUTPUT = path.join(fixture, "output");
process.env.AIPLAY_APPDATA = path.join(fixture, "appdata");
const { config } = await import("../server/config.js");
const { createDawRoutes } = await import("../server/daw/routes.js");
const { dawTools } = await import("../server/mcp-daw.js");
const store = await import("../server/daw/store.js");
assert.ok(path.resolve(store.DAW_DIR()).startsWith(path.resolve(fixture) + path.sep));

const json = (res, code, value) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
};
const deps = { config, json,
  spawnPython: () => { throw new Error("History checks must not run Python"); },
  readBody: async (req) => {
    let body = ""; for await (const chunk of req) body += chunk;
    return JSON.parse(body || "{}");
  },
};
let handle = createDawRoutes(deps);
const server = http.createServer(async (req, res) => {
  try { if (!await handle(req, res, new URL(req.url, "http://localhost"))) json(res, 404, { error: "No route" }); }
  catch (error) { json(res, 500, { error: error.message }); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const request = async (method, route, body) => {
  const response = await fetch(base + route, { method,
    headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
};
const post = (body) => request("POST", "/api/daw", body);
const read = (slug) => request("GET", `/api/daw/project/${slug}`);
const tools = dawTools(request, (value) => value);
const tool = (name, args) => tools.find((entry) => entry.name === name).run(args);

const source = readFileSync(new URL("../web/daw.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const extract = (name) => {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `Missing editor function ${name}`);
  const lineEnd = source.indexOf("\n", start);
  if (source.slice(start, lineEnd).trimEnd().endsWith("}")) return source.slice(start, lineEnd);
  const end = source.indexOf("\n}", start);
  return source.slice(start, end + 2);
};
const listener = (name, marker, signature) => {
  const start = source.indexOf(marker), end = source.indexOf("\n});", start);
  assert.ok(start >= 0 && end > start, `Missing actual editor listener ${name}`);
  return `${signature} {${source.slice(start + marker.length, end)}\n}`;
};
const declaration = (name) => {
  const start = source.indexOf(`const ${name} =`), end = source.indexOf(";", start);
  assert.ok(start >= 0 && end > start, `Missing editor declaration ${name}`);
  return source.slice(start, end + 1);
};
const functions = ["captureSession", "sessionCurrent", "noteEditBusy", "beginEdit", "finishEdit",
  "capturePointer", "releasePointer", "pushUndo", "undoOnce", "redoOnce", "replayHistory",
  "duplicateSelection", "deleteSelection", "splitSelection", "quantizeSelection", "act", "commitVel",
  "VelLine", "VelDraw", "VelNode", "VelNumber", "velChanges", "cancelNoteGesture", "selectTrack"];
const handlers = [
  listener("notePointerDown", 'canvas.addEventListener("pointerdown", async (e) => {', "async function notePointerDown(e)"),
  listener("notePointerMove", 'canvas.addEventListener("pointermove", (e) => {', "function notePointerMove(e)"),
  listener("notePointerUp", 'canvas.addEventListener("pointerup", async (e) => {', "async function notePointerUp(e)"),
  listener("arrPointerDown", 'arrCv.addEventListener("pointerdown", (e) => {', "function arrPointerDown(e)"),
  listener("arrPointerMove", 'arrCv.addEventListener("pointermove", (e) => {', "function arrPointerMove(e)"),
  listener("arrPointerUp", 'arrCv.addEventListener("pointerup", async (e) => {', "async function arrPointerUp(e)"),
  listener("midiRecordClick", '$("midiRecBtn").addEventListener("click", async () => {', "async function midiRecordClick()"),
];
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const pointer = (fields = {}) => ({ clientX: 100, clientY: 20, pointerId: 1, button: 0, ...fields });
let checks = 0;
const test = async (label, run) => { await run(); checks++; console.log(`ok ${label}`); };

async function editor(label) {
  const project = await post({ action: "create", name: label, length_bars: 8 });
  const track = await post({ action: "add_track", slug: project.slug, name: "Notes", instrument: "pluck" });
  const S = { slug: project.slug, projectEpoch: 1, trackId: track.trackId,
    proj: null, timeline: [], sel: new Set(), undo: [], redo: [], historyBusy: false, editBusy: null,
    drag: null, velStrategy: null, noteClipDrag: null, aud: { lastPitch: null }, mode: "select", grid: 480, pxq: 96, arrPxq: 24, rowH: 12 };
  const statuses = [], calls = [];
  const ui = { hit: null, captures: new Set(), released: [], arrCaptures: new Set(), arrReleased: [] }, nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: "100", checked: false,
      selectedOptions: [{ textContent: "1/8" }], classList: { add() {}, remove() {} } });
    return nodes.get(id);
  };
  const allNotes = () => S.proj.tracks.find((t) => t.id === S.trackId)?.clips.flatMap((c) =>
    c.notes.map((n) => ({ n, c }))) || [];
  const qToPosFine = (q) => ({ bar: Math.floor(q / 4) + 1, beat: Math.floor(q % 4) + 1, tick: Math.round((q % 1) * 960) });
  const context = vm.createContext({ S, console, Set, Map, performance, $, resizeNoteDurations,
    status: (value) => statuses.push(value), drawHistory() {}, renderAndSwap() {},
    draw() {}, drawSide() {}, drawArr() {}, drawMixer() {}, drawDevices() {}, drawAutoPane() {}, drawKnobs() {}, fitRoll() {}, paintSelInfo() {},
    auditionNote() {}, auditionDrag() {}, previewPitch() {}, bandSelect() {},
    canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }),
      setPointerCapture: (id) => ui.captures.add(id),
      releasePointerCapture: (id) => { ui.captures.delete(id); ui.released.push(id); } },
    arrCv: { getBoundingClientRect: () => ({ left: 0, top: 0 }),
      setPointerCapture: (id) => ui.arrCaptures.add(id),
      releasePointerCapture: (id) => { ui.arrCaptures.delete(id); ui.arrReleased.push(id); } },
    arrLayout: () => ({ rows: [{ kind: "track", id: S.trackId,
      track: S.proj.tracks.find((t) => t.id === S.trackId), y: 30, h: 46 }] }),
    KEYS_W: 44, VEL_H: 64, RULER_H: 26, ROWS: Array.from({ length: 128 }, (_, i) => 127 - i),
    velTop: () => 100, hitNote: () => ui.hit, hitVel: () => ui.hit?.note,
    pitchAtY: () => 72, selNotes: allNotes,
    MIDI: { on: false, notes: [], open: new Map() }, initMidi: async () => true,
    api: async (body) => { calls.push(body); return post(body); },
    refreshDoc: async () => { const reply = await read(S.slug); S.proj = reply.project; S.timeline = reply.timeline; return true; },
    targetNotes: () => allNotes().filter(({ n }) => S.sel.has(n.id)),
    posToQ: (bar, beat, tick) => (bar - 1) * 4 + beat - 1 + tick / 960,
    durTicksToQ: (bar, beat, tick, duration) => duration / 960,
    rowOf: (bar) => ({ qStart: (bar - 1) * 4, qLen: 4, den: 4, ticksPerBar: 3840 }), qToPosFine,
    qToPos: (q) => qToPosFine(S.grid ? Math.round(q * 960 / S.grid) * S.grid / 960 : q),
    barFloatNow: () => 1.5, qOfBarFloat: (bar) => (bar - 1) * 4, TPB: 960,
  });
  vm.runInContext(["var arrDrag = null;", ...functions.map(extract), ...["DEFAULT_VEL", "clampVel", "velScope", "velFromY"].map(declaration), ...handlers].join("\n"), context);
  const add = (extra = {}) => post({ action: "add_note", slug: S.slug, track: S.trackId,
    bar: 1, beat: 1, pitch: 60, vel: 85, dur_ticks: 3840, ...extra });
  const refresh = () => context.refreshDoc();
  const snapshot = async () => JSON.stringify((await read(S.slug)).project.tracks);
  const select = async (ids) => { await refresh(); S.sel = new Set(ids); };
  const hit = (id, edge = false) => {
    const row = allNotes().find(({ n }) => n.id === id);
    ui.hit = row ? { note: row.n, clip: row.c, edge } : null;
  };
  return { context, S, add, refresh, snapshot, select, hit, ui, statuses, calls };
}

async function seededEditor(label) {
  const e = await editor(label), a = await e.add({ tick: 120 }), b = await e.add({ tick: 120, pitch: 67 });
  await e.select([a.note.id, b.note.id]);
  await e.context.act({ action: "edit_notes", slug: e.S.slug, track: e.S.trackId,
    notes: [{ note: a.note.id, vel: 86 }] }, { action: "unused" }, "earlier edit");
  e.hit(a.note.id);
  return { e, a, b };
}

async function clipEditor(label) {
  const seeded = await seededEditor(label), { e, a, b } = seeded;
  const clip = e.S.proj.tracks[0].clips.find((c) => c.notes.some((n) => n.id === a.note.id));
  await post({ action: "set_clip", slug: e.S.slug, track: e.S.trackId, clip: clip.id, to_bar: 4 });
  await e.refresh();
  return { e, a, b, clipId: clip.id };
}

const clipPointer = (fields = {}) => pointer({ clientX: 50, clientY: 50, ...fields });

function pauseApi(e) {
  const entered = deferred(), release = deferred(), api = e.context.api, attempts = [];
  e.context.api = async (body) => {
    attempts.push(body);
    if (attempts.length === 1) { entered.resolve(); await release.promise; }
    return api(body);
  };
  return { entered: entered.promise, release: () => release.resolve(), attempts, restore: () => { e.context.api = api; } };
}

async function issueNoteEdit(e, kind) {
  const ctx = e.context;
  if (kind === "quantize") return ctx.quantizeSelection();
  if (kind === "velocity") return ctx.commitVel(ctx.VelNumber("set", 63), "velocity");
  if (["duplicate", "delete", "split"].includes(kind)) return ctx[`${kind}Selection`]();
  if (kind === "MIDI") {
    ctx.MIDI.on = true;
    ctx.MIDI.notes = [{ bar: 1, beat: 2, tick: 0, pitch: 75, vel: 66, dur_ticks: 480 }];
    return ctx.midiRecordClick();
  }
  if (kind === "draw") { e.hit(null); e.S.mode = "draw"; return ctx.notePointerDown(pointer()); }
  if (kind === "erase") { e.S.mode = "erase"; return ctx.notePointerDown(pointer()); }
  if (kind === "resize") e.ui.hit.edge = true;
  await ctx.notePointerDown(pointer());
  ctx.notePointerMove(pointer({ clientX: 196 }));
  return ctx.notePointerUp(pointer());
}

async function cycles(editor, before, after, count = 3) {
  for (let iteration = 0; iteration < count; iteration++) {
    await editor.context.undoOnce(); assert.equal(await editor.snapshot(), before, "Undo must restore every note, clip, ID, creator and array position");
    await editor.context.redoOnce(); assert.equal(await editor.snapshot(), after, "Redo must replay the same exact notes");
    assert.equal(editor.S.undo.length, 1); assert.equal(editor.S.redo.length, 0);
  }
}

try {
  await test("duplicate retains IDs and clip order over three undo/redo cycles", async () => {
    const e = await editor("Duplicate history"), a = await e.add(), b = await e.add({ beat: 2, pitch: 64 });
    await e.select([a.note.id, b.note.id]);
    const before = await e.snapshot(); await e.context.duplicateSelection(); const after = await e.snapshot();
    assert.notEqual(before, after); await cycles(e, before, after);
    const first = Object.keys((await read(e.S.slug)).project.noteHistory).length;
    await cycles(e, before, after);
    assert.equal(Object.keys((await read(e.S.slug)).project.noteHistory).length, first, "Repeated cycles must reuse saved snapshots");
  });

  await test("split retains each tail's original clip and ID", async () => {
    const e = await editor("Split history"), a = await e.add(), b = await e.add({ pitch: 67 });
    const extra = await post({ action: "add_clip", slug: e.S.slug, track: e.S.trackId, from_bar: 1, to_bar: 8 });
    const c = await e.add({ clip: extra.clipId, pitch: 72 });
    await e.select([a.note.id, b.note.id, c.note.id]); const before = await e.snapshot();
    await e.context.splitSelection(); const after = await e.snapshot();
    assert.deepEqual((await read(e.S.slug)).project.tracks[0].clips.map((clip) => clip.notes.length), [4, 2]);
    await cycles(e, before, after);
  });

  await test("multi-delete restores interleaved notes and original agent creators", async () => {
    const e = await editor("Delete history");
    const notes = [];
    for (let i = 0; i < 5; i++) notes.push((await e.add({ pitch: 60 + i, by: i % 2 ? "agent" : "user" })).note);
    await e.select([notes[0].id, notes[1].id, notes[3].id]); const before = await e.snapshot();
    await e.context.deleteSelection(); const after = await e.snapshot(); await cycles(e, before, after);
  });

  await test("delete undo keeps older edits addressable through the same note ID", async () => {
    const e = await editor("Earlier note history"), added = await e.add({ by: "agent" });
    await e.select([added.note.id]); const original = await e.snapshot();
    await e.context.act({ action: "edit_notes", slug: e.S.slug, track: e.S.trackId,
      notes: [{ note: added.note.id, vel: 31 }] }, { action: "unused" }, "velocity");
    const edited = await e.snapshot(); await e.context.deleteSelection(); const removed = await e.snapshot();
    for (let i = 0; i < 3; i++) {
      await e.context.undoOnce(); assert.equal(await e.snapshot(), edited);
      await e.context.undoOnce(); assert.equal(await e.snapshot(), original);
      await e.context.redoOnce(); assert.equal(await e.snapshot(), edited);
      await e.context.redoOnce(); assert.equal(await e.snapshot(), removed);
    }
    assert.equal(e.S.undo.length, 2); assert.equal(e.S.redo.length, 0);
  });

  await test("redo duplicate keeps later edits addressed to the originally created ID", async () => {
    const e = await editor("Created note history"), added = await e.add();
    await e.select([added.note.id]); const original = await e.snapshot();
    await e.context.duplicateSelection(); const duplicated = await e.snapshot();
    const copiedId = [...e.S.sel][0];
    await e.context.act({ action: "edit_notes", slug: e.S.slug, track: e.S.trackId,
      notes: [{ note: copiedId, pitch: 79, vel: 47 }] }, { action: "unused" }, "copied note");
    const edited = await e.snapshot();
    await e.context.undoOnce(); assert.equal(await e.snapshot(), duplicated);
    await e.context.undoOnce(); assert.equal(await e.snapshot(), original);
    await e.context.redoOnce(); assert.equal(await e.snapshot(), duplicated);
    await e.context.redoOnce(); assert.equal(await e.snapshot(), edited);
  });

  await test("single-note erase uses the server inverse and restores exact region hashes", async () => {
    const e = await editor("Erase history"), added = await e.add({ by: "agent" }); await e.refresh();
    const before = await e.snapshot(), hashes = store.regionHashes((await read(e.S.slug)).project);
    await e.context.act({ action: "delete_note", slug: e.S.slug, track: e.S.trackId, note: added.note.id },
      { action: "add_note", slug: e.S.slug }, "erase");
    const after = await e.snapshot(); await cycles(e, before, after);
    await e.context.undoOnce(); assert.deepEqual(store.regionHashes((await read(e.S.slug)).project), hashes);
  });

  await test("MCP restore receipts survive factory restart and cannot spoof IDs or creator", async () => {
    const e = await editor("Persistent history"), added = await e.add({ by: "user" });
    const before = await e.snapshot();
    const deleted = await tool("daw_delete_note", { slug: e.S.slug, track: e.S.trackId, note: added.note.id });
    handle = createDawRoutes(deps);
    const restored = await tool("daw_restore_note", { slug: e.S.slug, receipt: deleted.undo.receipt });
    assert.equal(restored.note.id, added.note.id); assert.equal(restored.note.by, "user");
    assert.equal(await e.snapshot(), before);
    const document = (await read(e.S.slug)).project;
    assert.equal(document.ledger[0].by, "agent");
    await assert.rejects(post({ action: "restore_note", slug: e.S.slug, receipt: deleted.undo.receipt }), /already exists/);
    await assert.rejects(post({ action: "restore_note", slug: e.S.slug, receipt: "0".repeat(64), note: { id: "spoof", by: "user" } }), /No saved note/);
    assert.equal(await e.snapshot(), before);
  });

  await test("receipts reject the wrong project and deleted clips without changing notes", async () => {
    const e = await editor("Missing parent history"), other = await editor("Wrong project history"), added = await e.add();
    const removed = await post({ action: "delete_note", slug: e.S.slug, track: e.S.trackId, note: added.note.id });
    await assert.rejects(post({ ...removed.undo, slug: other.S.slug }), /No saved note/);
    await post({ action: "remove_clip", slug: e.S.slug, track: e.S.trackId, clip: added.clipId });
    const before = await e.snapshot(); await assert.rejects(post(removed.undo), /clip/i); assert.equal(await e.snapshot(), before);
  });

  await test("rapid undo/redo requests cannot interleave history gestures", async () => {
    const e = await editor("Overlapping history"), added = await e.add(); await e.select([added.note.id]);
    const before = await e.snapshot(); await e.context.duplicateSelection(); const after = await e.snapshot();
    let release; const paused = new Promise((resolve) => { release = resolve; }), api = e.context.api;
    e.context.api = async (body) => { await paused; return api(body); };
    const pending = e.context.undoOnce();
    assert.equal(e.S.historyBusy, true); await e.context.undoOnce(); await e.context.redoOnce();
    release(); await pending; assert.equal(await e.snapshot(), before); assert.equal(e.S.redo.length, 1);
    e.context.api = api; await e.context.redoOnce(); assert.equal(await e.snapshot(), after);
  });

  await test("middle-step undo failure rolls back before retry", async () => {
    const e = await editor("Undo retry history"), a = await e.add(), b = await e.add({ pitch: 67 });
    await e.select([a.note.id, b.note.id]); const before = await e.snapshot();
    await e.context.duplicateSelection(); const after = await e.snapshot();
    const api = e.context.api; let calls = 0;
    e.context.api = (body) => ++calls === 2 ? Promise.reject(new Error("Simulated rejection")) : api(body);
    await e.context.undoOnce(); assert.equal(await e.snapshot(), after); assert.equal(e.S.undo.length, 1); assert.equal(e.S.redo.length, 0);
    e.context.api = api; await cycles(e, before, after);
  });

  await test("middle-step redo failure rolls back before retry", async () => {
    const e = await editor("Redo retry history"), a = await e.add(), b = await e.add({ pitch: 67 });
    await e.select([a.note.id, b.note.id]); const before = await e.snapshot();
    await e.context.duplicateSelection(); const after = await e.snapshot(); await e.context.undoOnce();
    const api = e.context.api; let calls = 0;
    e.context.api = (body) => ++calls === 2 ? Promise.reject(new Error("Simulated rejection")) : api(body);
    await e.context.redoOnce(); assert.equal(await e.snapshot(), before); assert.equal(e.S.redo.length, 1); assert.equal(e.S.undo.length, 0);
    e.context.api = api; await e.context.redoOnce(); assert.equal(await e.snapshot(), after);
  });

  for (const gesture of ["duplicateSelection", "deleteSelection", "splitSelection"]) {
    await test(`a partial ${gesture} keeps the successful changes undoable and redoable`, async () => {
      const e = await editor(`Partial ${gesture}`), a = await e.add(), b = await e.add({ pitch: 67 });
      await e.select([a.note.id, b.note.id]); const before = await e.snapshot();
      const api = e.context.api; let calls = 0;
      const failAt = gesture === "splitSelection" ? 3 : 2;
      e.context.api = (body) => ++calls === failAt ? Promise.reject(new Error("Simulated gesture rejection")) : api(body);
      await e.context[gesture](); const partial = await e.snapshot();
      assert.notEqual(partial, before); assert.equal(e.S.undo.length, 1);
      assert.match(e.statuses.at(-1), /Simulated gesture rejection/);
      e.context.api = api; await cycles(e, before, partial);
    });
  }

  await test("refresh failure after a replay cannot duplicate its history entry", async () => {
    const e = await editor("Refresh retry history"), added = await e.add(); await e.select([added.note.id]);
    const before = await e.snapshot(); await e.context.duplicateSelection(); const after = await e.snapshot();
    const refresh = e.context.refreshDoc; let calls = 0;
    e.context.refreshDoc = () => ++calls === 1 ? Promise.reject(new Error("Simulated refresh failure")) : refresh();
    await e.context.undoOnce(); assert.equal(await e.snapshot(), before); assert.equal(e.S.undo.length, 0); assert.equal(e.S.redo.length, 1);
    e.context.refreshDoc = refresh; await e.context.redoOnce(); assert.equal(await e.snapshot(), after);
  });

  await test("a new edit after undo clears the redo branch", async () => {
    const e = await editor("Branch history"), added = await e.add(); await e.select([added.note.id]);
    await e.context.duplicateSelection(); await e.context.undoOnce(); assert.equal(e.S.redo.length, 1);
    await e.context.act({ action: "edit_notes", slug: e.S.slug, track: e.S.trackId,
      notes: [{ note: added.note.id, pitch: 72 }] }, { action: "unused" }, "pitch");
    assert.equal(e.S.redo.length, 0); assert.equal(e.S.undo.length, 1);
  });

  await test("paused undo rejects every note command and pointer gesture without changing notes or selection", async () => {
    const { e, a } = await seededEditor("Undo excludes note writes"), before = await e.snapshot();
    await e.context.duplicateSelection(); const after = await e.snapshot();
    const pause = pauseApi(e), pending = e.context.undoOnce(); await pause.entered;
    const selected = [...e.S.sel], model = JSON.stringify(e.S.proj.tracks);
    await e.context.quantizeSelection();
    await e.context.commitVel(e.context.VelNumber("set", 63), "blocked velocity");
    for (const kind of ["duplicate", "delete", "split"]) await issueNoteEdit(e, kind);
    e.hit(a.note.id); await e.context.notePointerDown(pointer());
    e.context.notePointerMove(pointer({ clientX: 196 })); await e.context.notePointerUp(pointer());
    await e.context.notePointerDown(pointer({ clientY: 130 }));
    e.context.notePointerMove(pointer({ clientY: 120 })); await e.context.notePointerUp(pointer());
    e.context.arrPointerDown(clipPointer()); e.context.arrPointerMove(clipPointer({ clientX: 146 }));
    await e.context.arrPointerUp(clipPointer());
    e.hit(null); e.S.mode = "draw"; await e.context.notePointerDown(pointer());
    e.hit(a.note.id); e.S.mode = "erase"; await e.context.notePointerDown(pointer());
    e.context.MIDI.on = true;
    e.context.MIDI.notes = [{ bar: 1, beat: 2, tick: 0, pitch: 75, vel: 66, dur_ticks: 480 }];
    await e.context.midiRecordClick();
    assert.equal(pause.attempts.length, 1, "Only the reserved undo may reach the write API");
    assert.equal(await e.snapshot(), after); assert.equal(JSON.stringify(e.S.proj.tracks), model);
    assert.deepEqual([...e.S.sel], selected); assert.equal(e.S.drag, null); assert.equal(e.S.velStrategy, null);
    assert.equal(e.S.noteClipDrag, null); assert.equal(e.context.arrDrag, null); assert.equal(e.ui.arrCaptures.size, 0);
    assert.equal(e.context.MIDI.on, true); assert.equal(e.context.MIDI.notes.length, 1);
    pause.release(); await pending; pause.restore();
    assert.equal(await e.snapshot(), before); assert.equal(e.S.redo.length, 1); assert.equal(e.S.historyBusy, false);
    await e.context.redoOnce(); assert.equal(await e.snapshot(), after);
  });

  for (const kind of ["quantize", "velocity", "drag", "resize", "draw", "erase", "duplicate", "delete", "split", "MIDI"]) {
    await test(`pending ${kind} excludes undo, redo and another edit until its history is ready`, async () => {
      const { e } = await seededEditor(`Pending ${kind}`), before = await e.snapshot();
      const previousUndo = e.S.undo[0], pause = pauseApi(e), pending = issueNoteEdit(e, kind);
      await pause.entered;
      assert.ok(e.S.editBusy, "The edit must reserve history before its first request");
      await e.context.undoOnce(); await e.context.redoOnce(); await e.context.duplicateSelection();
      assert.equal(pause.attempts.length, 1); assert.equal(e.S.undo[0], previousUndo); assert.equal(e.S.undo.length, 1);
      assert.equal(await e.snapshot(), before, "A held write has not committed anything");
      pause.release(); await pending; pause.restore();
      const after = await e.snapshot(); assert.notEqual(after, before); assert.equal(e.S.editBusy, null);
      if (kind === "MIDI") {
        assert.equal(e.S.undo.length, 1, "MIDI must preserve earlier history when it has no inverse");
        assert.equal(e.context.MIDI.notes.length, 0);
      } else {
        assert.equal(e.S.undo.length, 2);
        await e.context.undoOnce(); assert.equal(await e.snapshot(), before); assert.equal(e.S.undo[0], previousUndo);
        await e.context.redoOnce(); assert.equal(await e.snapshot(), after);
      }
    });
  }

  for (const mode of ["move", "resize", "velocity"]) {
    await test(`active ${mode} reserves history and cancellation restores the preview and capture`, async () => {
      const { e, a } = await seededEditor(`Cancel active ${mode}`), before = await e.snapshot();
      e.hit(a.note.id, mode === "resize");
      const start = pointer(mode === "velocity" ? { clientY: 130 } : {});
      await e.context.notePointerDown(start);
      e.context.notePointerMove(pointer({ clientX: 196, clientY: mode === "velocity" ? 120 : 20 }));
      const live = e.S.drag, calls = e.calls.length;
      assert.ok(e.context.noteEditBusy()); assert.ok(e.ui.captures.has(1));
      const preview = JSON.stringify(e.S.proj.tracks);
      e.context.notePointerMove(pointer({ pointerId: 2, clientX: 400, clientY: 150 }));
      await e.context.notePointerUp(pointer({ pointerId: 2 }));
      assert.equal(e.S.drag, live, "Another pointer cannot move or release this gesture");
      assert.equal(JSON.stringify(e.S.proj.tracks), preview); assert.ok(e.ui.captures.has(1));
      await e.context.undoOnce(); await e.context.redoOnce();
      await e.context.quantizeSelection(); await e.context.commitVel(e.context.VelNumber("set", 63), "blocked velocity");
      await e.context.duplicateSelection(); await e.context.notePointerDown(pointer());
      assert.equal(e.calls.length, calls); assert.equal(e.S.drag, live); assert.equal(e.S.undo.length, 1);
      assert.equal(await e.snapshot(), before);
      e.context.cancelNoteGesture({ pointerId: 2 }); assert.equal(e.S.drag, live, "Another pointer cannot cancel this gesture");
      e.context.cancelNoteGesture({ pointerId: 1 });
      assert.equal(e.S.drag, null); assert.equal(e.S.velStrategy, null); assert.equal(e.context.noteEditBusy(), false);
      assert.equal(e.ui.captures.has(1), false); assert.equal(JSON.stringify(e.S.proj.tracks), before);
      await e.context.notePointerUp(pointer()); assert.equal(e.calls.length, calls, "Cancelled release cannot commit");
      await e.context.undoOnce(); assert.equal(e.S.undo.length, 0);
    });
  }

  await test("click-only and snapped-back drags release history without posting a no-op", async () => {
    const { e, a } = await seededEditor("No-op note gestures");
    await e.context.quantizeSelection(); const before = await e.snapshot(), calls = e.calls.length;
    for (const moved of [false, true]) {
      e.hit(a.note.id); await e.context.notePointerDown(pointer());
      if (moved) e.context.notePointerMove(pointer());
      await e.context.notePointerUp(pointer());
      assert.equal(e.calls.length, calls); assert.equal(e.context.noteEditBusy(), false); assert.equal(e.ui.captures.has(1), false);
    }
    await e.context.commitVel(e.context.VelNumber("add", 0), "unchanged velocity");
    e.context.barFloatNow = () => 1;
    await e.context.splitSelection(); await e.context.quantizeSelection();
    assert.equal(e.calls.length, calls); assert.equal(e.context.noteEditBusy(), false); assert.equal(await e.snapshot(), before);
  });

  await test("a refused note drag restores its preview, releases its edit and permits history retry", async () => {
    const { e, a } = await seededEditor("Rejected note drag"), before = await e.snapshot();
    const api = e.context.api;
    e.context.api = (body) => api({ ...body, track: "missing-track" });
    await e.context.notePointerDown(pointer()); e.context.notePointerMove(pointer({ clientX: 196 }));
    await e.context.notePointerUp(pointer());
    assert.equal(e.S.editBusy, null); assert.equal(e.S.drag, null); assert.equal(e.S.undo.length, 1);
    assert.equal(JSON.stringify(e.S.proj.tracks), before); assert.equal(await e.snapshot(), before);
    assert.match(e.statuses.at(-1), /track/i);
    e.context.api = api; e.hit(a.note.id);
    await issueNoteEdit(e, "drag"); const after = await e.snapshot(); assert.notEqual(after, before);
    await e.context.undoOnce(); assert.equal(await e.snapshot(), before);
    await e.context.redoOnce(); assert.equal(await e.snapshot(), after);
  });

  for (const rejected of [false, true]) {
    await test(`a ${rejected ? "failed" : "pending"} refresh keeps acknowledged edit history reserved until settlement`, async () => {
      const { e } = await seededEditor(`Refresh lock ${rejected}`), before = await e.snapshot();
      const entered = deferred(), release = deferred(), refresh = e.context.refreshDoc;
      e.context.refreshDoc = async () => { entered.resolve(); await release.promise; return refresh(); };
      const pending = e.context.quantizeSelection(); await entered.promise;
      const committed = await e.snapshot(), calls = e.calls.length;
      assert.notEqual(committed, before); assert.ok(e.S.editBusy); assert.equal(e.S.undo.length, 2);
      await e.context.undoOnce(); await e.context.redoOnce(); await e.context.deleteSelection();
      assert.equal(e.calls.length, calls); assert.equal(e.S.undo.length, 2); assert.equal(await e.snapshot(), committed);
      if (rejected) release.reject(new Error("Simulated pending refresh rejection")); else release.resolve();
      await pending; e.context.refreshDoc = refresh;
      assert.equal(e.S.editBusy, null); assert.equal(e.S.undo.length, 2);
      await e.context.undoOnce(); assert.equal(await e.snapshot(), before);
      await e.context.redoOnce(); assert.equal(await e.snapshot(), committed);
    });
  }

  await test("track changes cancel active notes but cannot retarget a pending write", async () => {
    const { e, a } = await seededEditor("Track switching edits"), first = e.S.trackId;
    const second = await post({ action: "add_track", slug: e.S.slug, name: "Other notes", instrument: "pluck" });
    await e.refresh(); e.hit(a.note.id); const before = await e.snapshot();
    await e.context.notePointerDown(pointer()); e.context.notePointerMove(pointer({ clientX: 196 }));
    e.context.selectTrack(second.trackId);
    assert.equal(e.S.trackId, second.trackId); assert.equal(e.context.noteEditBusy(), false);
    assert.equal(e.ui.captures.has(1), false); assert.equal(JSON.stringify(e.S.proj.tracks), before);
    await e.context.notePointerUp(pointer()); assert.equal(await e.snapshot(), before);
    e.context.selectTrack(first); e.S.sel = new Set([a.note.id]); e.hit(a.note.id);
    const pause = pauseApi(e), pending = e.context.quantizeSelection(); await pause.entered;
    e.context.selectTrack(second.trackId); assert.equal(e.S.trackId, first);
    pause.release(); await pending; pause.restore();
    assert.equal(e.S.undo.at(-1).forward.track, first); assert.equal(e.S.editBusy, null);
    e.context.selectTrack(second.trackId); assert.equal(e.S.trackId, second.trackId);
    await e.context.undoOnce(); assert.equal(await e.snapshot(), before);
  });

  await test("live MIDI clip movement excludes history and note edits, and cancellation restores its bounds and capture", async () => {
    const { e } = await clipEditor("Cancel MIDI clip movement"), before = await e.snapshot(), calls = e.calls.length;
    e.context.arrPointerDown(clipPointer());
    const live = e.S.noteClipDrag; assert.ok(live); assert.equal(e.context.arrDrag, live); assert.ok(e.ui.arrCaptures.has(1));
    e.context.arrPointerMove(clipPointer({ clientX: 146 }));
    const preview = JSON.stringify(e.S.proj.tracks); assert.notEqual(preview, before);
    e.context.arrPointerMove(clipPointer({ pointerId: 2, clientX: 242 }));
    await e.context.arrPointerUp(clipPointer({ pointerId: 2 }));
    e.context.cancelNoteGesture({ pointerId: 2 });
    assert.equal(e.S.noteClipDrag, live); assert.equal(JSON.stringify(e.S.proj.tracks), preview); assert.ok(e.ui.arrCaptures.has(1));
    await e.context.undoOnce(); await e.context.redoOnce();
    await e.context.quantizeSelection(); await e.context.commitVel(e.context.VelNumber("set", 63), "blocked velocity");
    await e.context.duplicateSelection(); await e.context.notePointerDown(pointer());
    assert.equal(e.calls.length, calls); assert.equal(e.S.undo.length, 1); assert.equal(await e.snapshot(), before);
    e.context.cancelNoteGesture({ pointerId: 1 });
    assert.equal(e.S.noteClipDrag, null); assert.equal(e.context.arrDrag, null); assert.equal(e.context.noteEditBusy(), false);
    assert.equal(e.ui.arrCaptures.has(1), false); assert.equal(JSON.stringify(e.S.proj.tracks), before);
    await e.context.arrPointerUp(clipPointer()); assert.equal(e.calls.length, calls);
    await e.context.undoOnce(); assert.equal(e.S.undo.length, 0);
  });

  await test("MIDI clip release reserves set_clip and preserves exact notes through repeated undo and redo", async () => {
    const { e, a, b, clipId } = await clipEditor("Committed MIDI clip movement"), before = await e.snapshot();
    e.context.arrPointerDown(clipPointer()); e.context.arrPointerMove(clipPointer({ clientX: 146 }));
    const pause = pauseApi(e), pending = e.context.arrPointerUp(clipPointer()); await pause.entered;
    assert.equal(e.S.noteClipDrag, null); assert.equal(e.context.arrDrag, null); assert.ok(e.S.editBusy);
    assert.equal(e.ui.arrCaptures.has(1), false);
    assert.equal(pause.attempts[0].action, "set_clip"); assert.equal(pause.attempts[0].clip, clipId);
    await e.context.undoOnce(); await e.context.redoOnce(); await e.context.quantizeSelection();
    assert.equal(pause.attempts.length, 1); assert.equal(await e.snapshot(), before);
    pause.release(); await pending; pause.restore();
    const after = await e.snapshot(), document = (await read(e.S.slug)).project;
    const moved = document.tracks[0].clips.find((c) => c.id === clipId);
    assert.deepEqual([moved.fromBar, moved.toBar], [2, 5]);
    assert.deepEqual(moved.notes.map((n) => [n.id, n.bar, n.beat, n.tick, n.by]),
      [[a.note.id, 2, 1, 120, a.note.by], [b.note.id, 2, 1, 120, b.note.by]]);
    assert.equal(e.S.editBusy, null); assert.equal(e.S.undo.length, 2);
    for (let i = 0; i < 3; i++) {
      await e.context.undoOnce(); assert.equal(await e.snapshot(), before);
      await e.context.redoOnce(); assert.equal(await e.snapshot(), after);
      assert.equal(e.S.undo.length, 2); assert.equal(e.S.redo.length, 0);
    }
  });

  await test("click-only and snapped-back MIDI clip drags release their marker without writing", async () => {
    const { e } = await clipEditor("No-op MIDI clip movement"), before = await e.snapshot(), calls = e.calls.length;
    for (const moved of [false, true]) {
      e.context.arrPointerDown(clipPointer()); assert.ok(e.context.noteEditBusy());
      if (moved) {
        e.context.arrPointerMove(clipPointer({ clientX: 146 }));
        e.context.arrPointerMove(clipPointer());
      }
      await e.context.arrPointerUp(clipPointer());
      assert.equal(e.S.noteClipDrag, null); assert.equal(e.context.arrDrag, null); assert.equal(e.context.noteEditBusy(), false);
      assert.equal(e.ui.arrCaptures.has(1), false); assert.equal(e.calls.length, calls); assert.equal(await e.snapshot(), before);
    }
    await e.context.undoOnce(); assert.equal(e.S.undo.length, 0);
  });

  await test("a refused MIDI clip move restores its preview and leaves earlier history usable", async () => {
    const { e } = await clipEditor("Refused MIDI clip movement"), before = await e.snapshot();
    const api = e.context.api;
    e.context.api = (body) => api({ ...body, track: "missing-track" });
    e.context.arrPointerDown(clipPointer()); e.context.arrPointerMove(clipPointer({ clientX: 146 }));
    await e.context.arrPointerUp(clipPointer());
    assert.equal(e.S.noteClipDrag, null); assert.equal(e.context.arrDrag, null); assert.equal(e.S.editBusy, null);
    assert.equal(e.ui.arrCaptures.has(1), false); assert.equal(e.S.undo.length, 1); assert.equal(await e.snapshot(), before);
    assert.equal(JSON.stringify(e.S.proj.tracks), before, "A refused write must not leave its clip preview in the document");
    e.context.api = api;
    await e.context.undoOnce(); assert.equal(e.S.undo.length, 0);
  });

  await test("an acknowledged MIDI clip move keeps its committed bounds and inverse when refresh is rejected", async () => {
    const { e, clipId } = await clipEditor("Acknowledged clip refresh rejection"), before = await e.snapshot();
    const refresh = e.context.refreshDoc;
    e.context.refreshDoc = () => Promise.reject(new Error("Simulated clip refresh rejection"));
    e.context.arrPointerDown(clipPointer()); e.context.arrPointerMove(clipPointer({ clientX: 146 }));
    await e.context.arrPointerUp(clipPointer());
    const after = await e.snapshot(), committed = (await read(e.S.slug)).project.tracks[0].clips.find((c) => c.id === clipId);
    const preview = e.S.proj.tracks[0].clips.find((c) => c.id === clipId);
    assert.notEqual(after, before); assert.deepEqual([preview.fromBar, preview.toBar], [committed.fromBar, committed.toBar]);
    assert.deepEqual([committed.fromBar, committed.toBar], [2, 5]); assert.equal(e.S.undo.length, 2);
    assert.equal(e.S.editBusy, null); assert.equal(e.S.noteClipDrag, null); assert.equal(e.ui.arrCaptures.has(1), false);
    assert.match(e.statuses.at(-1), /Simulated clip refresh rejection/);
    e.context.refreshDoc = refresh;
    await e.context.undoOnce(); assert.equal(await e.snapshot(), before);
    await e.context.redoOnce(); assert.equal(await e.snapshot(), after);
  });

  console.log(`${checks} history checks passed against real isolated DAW routes; no live project touched.`);
} finally {
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  assert.ok(path.dirname(fixture) === os.tmpdir() && path.basename(fixture).startsWith("aiplay-daw-history-"));
  await rm(fixture, { recursive: true, force: true });
}
