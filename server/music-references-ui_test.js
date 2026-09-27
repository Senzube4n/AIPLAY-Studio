import test from "node:test";
import assert from "node:assert/strict";
import { mountMusicReferences } from "../web/music-references.js";

async function harness(t, { visual = false, handoff = null, preparedRequest = null, referenceGet = null } = {}) {
  const elements = {}, calls = [], loaded = [];
  function element() { return { value: "", textContent: "", dataset: {}, disabled: false, checked: false, files: [], handlers: {}, children: [],
    addEventListener(k, fn) { this.handlers[k] = fn; }, append(el) { this.children.push(el); }, replaceChildren() { this.children = []; }, removeAttribute(k) { delete this[k]; } }; }
  const root = { dataset: {}, classList: { add() {} }, ownerDocument: { createElement: element },
    querySelector(selector) { const name = /"([^"]+)"/.exec(selector)[1]; return elements[name] ??= element(); },
    set innerHTML(_s) { for (const [k, v] of Object.entries({ kind: "audio", seconds: "30", start: "0", engine: "yue2", seed: "0" })) (elements[k] ??= element()).value = v; } };
  let row = { id: "mr_fixture", revision: 1, state: "ready", source: { file: "source.wav" }, evidence: { startSeconds: 4, seconds: 8, hasAudio: true, timestamps: [] }, brief: { style: "Piano", lyrics: "Morning arrives", notes: "source notes" }, warnings: [] };
  if (preparedRequest) row.prepared = { request: preparedRequest };
  const fetch = async (url, opts = {}) => {
    const body = opts.headers?.["Content-Type"] === "application/json" ? JSON.parse(opts.body) : null;
    calls.push({ url, body, upload: opts.body, headers: opts.headers }); let value;
    if (url === "/api/status") value = { library: [{ file: "source.wav", title: "Reference track" }] };
    else if (url === "/api/clips") value = { clips: [{ name: "import_voice.wav" }, { name: "clip.mp4" }] };
    else if (url === "/api/studio/import") value = { ok: true, name: "import_voice.wav", kind: "audio" };
    else if (body.action === "capabilities") value = { visual: { available: visual, models: ["qwen3vl_4b.safetensors"], reason: "Local engine unavailable." } };
    else if (body.action === "list") value = { references: [row] };
    else if (body.action === "get" && referenceGet) value = { ok: true, reference: await referenceGet(body.referenceId, structuredClone(row)) };
    else {
      if (body.action === "update_brief") row = { ...row, revision: row.revision + 1, brief: body.brief, prepared: null };
      if (body.action === "prepare_request") row = { ...row, revision: row.revision + 1, prepared: { request: { engine: body.engine, caption: row.brief.style, lyrics: row.brief.lyrics, seed: body.seed, instrumental: body.instrumental } } };
      if (body.action === "update_score") row = { ...row, revision: row.revision + 1, score: { abc: body.abc, check: { ok: true } }, prepared: null };
      value = { ok: true, reference: structuredClone(row) };
    }
    return { ok: true, json: async () => value };
  };
  const mounted = mountMusicReferences({ root, fetch, onLoadRequest: handoff || (req => loaded.push(req)) }); t.after(() => mounted.dispose());
  await new Promise(resolve => setImmediate(resolve));
  elements.saved.value = row.id; await elements.saved.handlers.change();
  return { elements, calls, loaded, fire: (id, kind = "click") => elements[id].handlers[kind](),
    selectUnprepared: async () => { row = { ...row, id: "mr_another", prepared: null }; elements.saved.value = row.id; await elements.saved.handlers.change(); } };
}

test("manual reference brief works without VLM and loading is an explicit composer handoff", async t => {
  const h = await harness(t); assert.equal(h.elements.visual.disabled, true); assert.equal(h.elements.save.disabled, false);
  h.elements.style.value = "Quiet strings"; h.fire("style", "input");
  await h.fire("draft"); assert.equal(h.loaded.length, 0); assert.equal(h.elements.load.disabled, false);
  assert.deepEqual(h.calls.filter(c => c.body?.action === "prepare_request")[0].body, { action: "prepare_request", referenceId: "mr_fixture", expectedRevision: 2, reviewed: true, engine: "yue2", seed: 0, useScore: false, instrumental: false, allowSectionLabels: false });
  await h.fire("load"); assert.equal(h.loaded[0].caption, "Quiet strings");
  assert.ok(h.calls.every(c => c.url !== "/api/generate"));
});

test("browser import hands clip audio to CPU reference preparation", async t => {
  const h = await harness(t);
  const file = { name: "voice.wav", size: 1024 };
  h.elements.uploadFile.files = [file]; h.fire("uploadFile", "change");
  await h.fire("upload");
  const upload = h.calls.find(c => c.url === "/api/studio/import");
  assert.equal(upload.upload, file);
  assert.equal(upload.headers["X-Name"], "voice.wav");
  assert.equal(h.elements.kind.value, "clip-audio");
  assert.equal(h.elements.file.value, "import_voice.wav");
  assert.equal(h.elements.player.src, "/api/clip/import_voice.wav");
  await h.fire("prepare");
  const prepared = h.calls.find(c => c.body?.action === "prepare").body;
  assert.deepEqual([prepared.kind, prepared.location, prepared.file], ["audio", "clips", "import_voice.wav"]);
});

test("editing after review disables the previously prepared request", async t => {
  const h = await harness(t); await h.fire("draft"); h.elements.lyrics.value = "Different words"; h.fire("lyrics", "input");
  assert.equal(h.elements.load.disabled, true); await h.fire("load"); assert.equal(h.loaded.length, 0);
});

test("unsaved notation cannot be silently replaced by preparing a request", async t => {
  const h = await harness(t); h.elements.score.value = "edited notation"; h.fire("score", "input"); await h.fire("draft");
  assert.equal(h.elements.score.value, "edited notation"); assert.match(h.elements.status.textContent, /Save and check/);
  assert.equal(h.calls.filter(c => c.body?.action === "prepare_request").length, 0);
  await h.fire("saveScore"); assert.equal(h.calls.at(-1).body.abc, "edited notation");
});

test("failed async composer handoff reports failure rather than claiming loaded", async t => {
  const h = await harness(t, { handoff: async () => { throw new Error("Requested engine unavailable"); } });
  await h.fire("draft"); await h.fire("load"); assert.equal(h.elements.status.textContent, "Requested engine unavailable");
});

test("saved reviewed requests restore their visible settings and another draft resets them", async t => {
  for (const request of [
    { engine: "yue2-gguf", seed: 734, abc: "reviewed score", instrumental: false, allowSectionLabels: true },
    { engine: "yue2-comfy", seed: 0, instrumental: true, allowSectionLabels: false },
  ]) {
    const h = await harness(t, { preparedRequest: request });
    assert.equal(h.elements.engine.value, request.engine);
    assert.equal(h.elements.seed.value, String(request.seed));
    assert.equal(h.elements.useScore.checked, !!request.abc);
    assert.equal(h.elements.instrumental.checked, request.instrumental);
    assert.equal(h.elements.labels.checked, request.allowSectionLabels);
    assert.equal(h.elements.load.disabled, false);
    await h.fire("load"); assert.deepEqual(h.loaded[0], request);
    await h.selectUnprepared();
    assert.equal(h.elements.engine.value, "yue2"); assert.equal(h.elements.seed.value, "0");
    for (const name of ["useScore", "instrumental", "labels"]) assert.equal(h.elements[name].checked, false);
    assert.equal(h.elements.load.disabled, true);
  }
});

test("an older saved-reference response cannot replace the newest selected brief", async t => {
  let releaseOld;
  const oldResponse = new Promise(resolve => { releaseOld = resolve; });
  const h = await harness(t, { preparedRequest: { caption: "Fixture" }, referenceGet: async (id, base) => {
    if (id === "mr_fixture") return base;
    const selected = { ...base, id, source: { file: `${id}.wav` },
      brief: { style: id === "mr_old" ? "Old score" : "New score", lyrics: "Lyrics", notes: "" },
      prepared: { request: { caption: id === "mr_old" ? "Old score" : "New score" } } };
    if (id === "mr_old") await oldResponse;
    return selected;
  } });
  h.elements.saved.value = "mr_old";
  const first = h.fire("saved", "change");
  assert.equal(h.elements.load.disabled, true, "the old prepared request cannot load while another brief is selected but still fetching");
  await h.fire("load"); assert.equal(h.loaded.length, 0);
  h.elements.saved.value = "mr_new";
  await h.fire("saved", "change");
  releaseOld(); await first;
  assert.equal(h.elements.style.value, "New score");
  assert.match(h.elements.request.textContent, /New score/);
  assert.equal(h.elements.load.disabled, false);
  await h.fire("load");
  assert.equal(h.loaded[0].caption, "New score");
});

test("clearing or failing a saved-brief selection restores the open brief's controls", async t => {
  const h = await harness(t, { preparedRequest: { caption: "Fixture" }, referenceGet: async (id, base) => {
    if (id === "mr_missing") throw Error("Saved brief unavailable");
    return base;
  } });
  h.elements.saved.value = "";
  await h.fire("saved", "change");
  assert.equal(h.elements.load.disabled, false);
  h.elements.saved.value = "mr_missing";
  await h.fire("saved", "change");
  assert.equal(h.elements.saved.value, "mr_fixture");
  assert.equal(h.elements.load.disabled, false);
  assert.equal(h.elements.status.textContent, "Saved brief unavailable");
  await h.fire("load");
  assert.equal(h.loaded[0].caption, "Fixture");
});
