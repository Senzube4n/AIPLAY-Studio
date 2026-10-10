import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
function section(first, next) {
  const a = app.indexOf(first), b = app.indexOf(next, a + first.length);
  assert.ok(a >= 0 && b > a, `Actual source block ${first} exists`);
  return app.slice(a, b);
}

test("wand tolerance updates its last selection, keeps zero and defaults to 32", () => {
  const controls = { iedSelTol: { value: "32" }, iedSelContig: { checked: true } };
  const ctx = vm.createContext({
    ied: { tool: "wand", sel: [
      { kind: "wand", tolerance: 8, contiguous: true },
      { kind: "rect" }, { kind: "wand", tolerance: 12, contiguous: true }] },
    $: id => controls[id], iedSelPaint() {}, iedOverlayPaint() {}, iedStatus() {}, iedPreviewSchedule() {},
  });
  vm.runInContext(section("function iedSelectionSettingsChange()", 'for (const id of ["iedSelTol"'), ctx);
  vm.runInContext("iedSelectionSettingsChange()", ctx);
  assert.equal(ctx.ied.sel[0].tolerance, 8, "earlier added regions keep their own tolerance");
  assert.equal(ctx.ied.sel[2].tolerance, 32);
  controls.iedSelTol.value = "0"; controls.iedSelContig.checked = false;
  vm.runInContext("iedSelectionSettingsChange()", ctx);
  assert.equal(ctx.ied.sel[2].tolerance, 0);
  assert.equal(ctx.ied.sel[2].contiguous, false);
  controls.iedSelTol.value = "";
  vm.runInContext("iedSelectionSettingsChange()", ctx);
  assert.equal(ctx.ied.sel[2].tolerance, 32);
  assert.match(html, /id="iedSelTol"[^>]*value="32"/);
});

test("wand seeds stay on the clicked pixel after crop, rotations and flips", () => {
  const ctx = vm.createContext({ ied: { crop: null, rotate: 0, flipH: false, flipV: false },
    iedRotSize: () => ({ nw: 20, nh: 10 }) });
  vm.runInContext(section("function iedStageSize()", "/* stage pixel -> canvas-viewport pixel"), ctx);
  for (const [rotate, expected] of [[0, [0, 0]], [90, [9, 0]], [180, [19, 9]], [270, [0, 19]]]) {
    ctx.ied.rotate = rotate;
    assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(Object.values(iedSrcToStage(0, 0, true)))", ctx)), expected);
    ctx.ied.flipH = true; ctx.ied.flipV = true;
    const p = vm.runInContext("iedSrcToStage(0, 0, true)", ctx);
    const size = vm.runInContext("iedStageSize()", ctx);
    assert.equal(p.x, size.w - 1 - expected[0]);
    assert.equal(p.y, size.h - 1 - expected[1]);
    ctx.ied.flipH = false; ctx.ied.flipV = false;
  }
  ctx.ied.crop = { x: 4, y: 2, w: 12, h: 6 }; ctx.ied.rotate = 90;
  const p = vm.runInContext("iedSrcToStage(4, 2, true)", ctx);
  assert.equal(p.x, 5); assert.equal(p.y, 0);
});

test("exact wand previews debounce, reject stale responses and clear on deselect", async () => {
  const timers = [], requests = [], images = [], drawCalls = [];
  const controls = { imgEd: { hidden: false }, iedImg: { naturalWidth: 20, src: "/frame.png" },
    iedSelPreviewStatus: { textContent: "" } };
  const ctx = vm.createContext({
    ied: { name: "frame.png", sel: [{ kind: "wand", tolerance: 32 }] }, iedDoc: null,
    $: id => controls[id], iedSelFrame: () => ({ rotate: 90 }),
    iedSelectionOp: () => ({ shapes: structuredClone(ctx.ied.sel) }),
    clearTimeout() {}, setTimeout: fn => { timers.push(fn); return timers.length; },
    AbortController,
    fetch: (url, opts) => new Promise(resolve => requests.push({ url, opts, resolve })),
    Image: class { constructor() { this.naturalWidth = 20; this.naturalHeight = 10; images.push(this); } },
    document: { createElement: () => ({ getContext: () => ({ drawImage() {}, fillRect() {} }) }) },
    iedLiveInk: () => "cyan", iedOverlayPaint() {},
    iedStageToView: (x, y) => ({ x: 50 - y * 2, y: 30 + x * 2 }),
  });
  vm.runInContext(section("var iedSelPreviewState;", "/* the pixel under a stage point"), ctx);
  vm.runInContext("iedSelectionPreviewSchedule(); iedSelectionPreviewSchedule()", ctx);
  assert.equal(timers.length, 1, "pan/repaints do not create new selection requests");
  const first = timers[0]();
  assert.equal(requests[0].url, "/api/images/preview-selection");
  assert.deepEqual(JSON.parse(requests[0].opts.body).frame, { rotate: 90 });
  ctx.ied.sel[0].tolerance = 0;
  vm.runInContext("iedSelectionPreviewSchedule()", ctx);
  assert.equal(requests[0].opts.signal.aborted, true);
  const second = timers[1]();
  requests[1].resolve({ ok: true, json: async () => ({ mask: "data:image/png;base64,new", width: 20, height: 10, coverage: .5 }) });
  await second;
  requests[0].resolve({ ok: true, json: async () => ({ mask: "old", width: 20, height: 10, coverage: 1 }) });
  await first;
  assert.equal(images.length, 1, "obsolete results never decode or replace the mask");
  images[0].onload();
  assert.equal(controls.iedSelPreviewStatus.textContent, "50.0% selected");
  const overlay = { save() {}, restore() {}, transform: (...a) => drawCalls.push(a), drawImage: (...a) => drawCalls.push(a) };
  ctx.overlay = overlay;
  vm.runInContext("iedSelectionPreviewDraw(overlay)", ctx);
  assert.deepEqual(drawCalls[0], [0, 2, -2, 0, 50, 30], "mask follows rotated/zoomed stage coordinates");
  ctx.ied.sel = [];
  vm.runInContext("iedSelectionPreviewSchedule(); iedSelectionPreviewDraw(overlay)", ctx);
  assert.equal(controls.iedSelPreviewStatus.textContent, "");
  assert.equal(drawCalls.length, 2, "deselected masks disappear immediately");
});

test("document wand previews use the paint layer or current composed document, never the old flat file", () => {
  let target = { ref: "layer-a" };
  const ctx = vm.createContext({ ied: { name: "old.png" }, iedDoc: { id: "doc-1" },
    iedDocViewReady: true, iedPaintTarget: () => target,
    iedDocFind: () => ({ layer: { src: "actual-layer.png", name: "Foreground" } }) });
  vm.runInContext(section("function iedSelectionPreviewSource()", "function iedSelectionPreviewRecipe()"), ctx);
  assert.equal(vm.runInContext("iedSelectionPreviewSource().name", ctx), "actual-layer.png");
  target = null;
  assert.equal(vm.runInContext("iedSelectionPreviewSource().documentId", ctx), "doc-1");
  ctx.iedDocViewReady = false;
  assert.equal(vm.runInContext("iedSelectionPreviewSource()", ctx), null);
});

test("pending flat adjustments are blocked, while selections alone can drive a Qwen masked edit", () => {
  const defaults = { brightness: 100, contrast: 100, saturation: 100, gamma: 1,
    temperature: 0, sharpen: 0, blur: 0, vignette: 0, shadows: 0, highlights: 0,
    rotate: 0, flipH: false, flipV: false };
  let ops = { ...defaults }, layers = [];
  const ctx = vm.createContext({ iedOps: () => structuredClone(ops), get iedLayers() { return layers; } });
  vm.runInContext(section("function iedAIHasPending()", '$("iedAIOpen").onclick'), ctx);
  assert.equal(vm.runInContext("iedAIHasPending()", ctx), false);
  ops.selection = { shapes: [{ kind: "rect", x: 2, y: 4, w: 10, h: 20 }] };
  assert.equal(vm.runInContext("iedAIHasPending()", ctx), false);
  ops.brightness = 120;
  assert.equal(vm.runInContext("iedAIHasPending()", ctx), true);
  ops = { ...defaults }; layers = [{ src: "overlay.png" }];
  assert.equal(vm.runInContext("iedAIHasPending()", ctx), true);
});

test("a transient edit status failure keeps the detached job and recovers its candidate", async () => {
  const timers = [], elements = new Map(), asked = [];
  let failures = 4, libraryRefreshes = 0;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: id === "iedAIMode" ? "edit" : "", title: "",
      querySelectorAll: () => [] });
    return elements.get(id);
  };
  const ctx = vm.createContext({
    iedAI: { refs: [], job: { id: "job-1", status: "generating", source: "frame.png", seed: 17 },
      busy: false, poll: 0, pollFailures: 0 },
    iedDoc: null, ied: { name: "frame.png" }, state: { images: [] },
    iedHasPixels: () => true, iedDocumentFileToolsPaint() {}, esc: value => value,
    $: element, setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    async iedAIRequest(body) {
      asked.push(body);
      if (failures-- > 0) throw new Error("Temporary network failure");
      return { id: "job-1", status: "ready", source: "frame.png", seed: 17, width: 32, height: 32,
        candidate: { url: "/api/image/result.png" }, sourcePreview: "/api/image/source.png", warnings: [] };
    },
    async loadImages() { libraryRefreshes++; },
  });
  vm.runInContext(section("function iedAIPaint()", "async function iedAIRequest(body)"), ctx);
  vm.runInContext(section("async function iedAIPoll()", "function iedAIHasPending()"), ctx);
  await vm.runInContext("iedAIPoll()", ctx);
  for (const delay of [2000, 4000, 8000, 10000]) {
    assert.equal(ctx.iedAI.job.id, "job-1", "the GPU job id survives a failed status check");
    assert.equal(element("iedAIGenerate").disabled, true, "a duplicate render stays blocked");
    assert.equal(timers.at(-1).delay, delay, "retries back off but remain bounded");
    assert.match(element("iedAIStatus").textContent, /Checking edit again/);
    if (delay < 10000) await timers.at(-1).fn();
  }
  await timers.at(-1).fn();
  assert.equal(ctx.iedAI.job.status, "ready");
  assert.equal(ctx.iedAI.pollFailures, 0);
  assert.equal(element("iedAICandidate").src, "/api/image/result.png");
  assert.equal(element("iedAIStatus").title, "");
  assert.equal(element("iedAIGenerate").disabled, true, "review happens before another render");
  assert.equal(libraryRefreshes, 1);
  assert.equal(asked.length, 5);
  assert.ok(asked.every(body => body.action === "status" && body.id === "job-1"));

  ctx.iedAI.job = { id: "old-session", status: "generating", source: "frame.png" };
  ctx.iedAIRequest = async () => { throw new Error("This editor job is unavailable or belongs to a previous app session."); };
  await vm.runInContext("iedAIPoll()", ctx);
  assert.equal(ctx.iedAI.job, null, "a confirmed server restart can release the stale job");
  assert.equal(element("iedAIGenerate").disabled, false);
  assert.equal(timers.length, 4, "a lost server-side job is not polled forever");
  assert.match(element("iedAIStatus").textContent, /session ended/);
});

test("document viewport uses the newest actual composed pixels, ignoring out-of-order responses", async () => {
  const requests = [], elements = new Map(), clearedSelections = [];
  const element = id => { if (!elements.has(id)) elements.set(id, { style: {}, src: "", textContent: "", addEventListener() {} }); return elements.get(id); };
  const ctx = vm.createContext({
    iedDoc: { id: "one", name: "First document" }, ied: { rotate: 90, flipH: true, flipV: false, crop: {} },
    iedPreviewSeq: 0, iedAIPaint() {}, iedPreviewClear() {}, iedApplyEnable() {}, iedDocPaint() {},
    iedOverlayPaint() { clearedSelections.push(true); },
    iedDocSay(message) { throw new Error(message); }, $: element,
    fetch: async (url, init) => new Promise(resolve => requests.push({ url, body: JSON.parse(init.body), resolve })),
  });
  vm.runInContext(section("let iedDocViewSeq =", "const iedAI ="), ctx);
  const first = vm.runInContext("iedDocViewRefresh()", ctx);
  ctx.iedDoc = { id: "two", name: "Second document" };
  const second = vm.runInContext("iedDocViewRefresh()", ctx);
  assert.equal(clearedSelections.length, 2, "each canvas refresh invalidates the old selection preview");
  assert.equal(requests[0].body.id, "one"); assert.equal(requests[1].body.id, "two");
  requests[1].resolve({ json: async () => ({ dataUrl: "data:image/png;base64,newest", revision: "2", paintTargets: { image: { ready: true } } }) });
  await second;
  assert.equal(element("iedImg").src, "data:image/png;base64,newest");
  requests[0].resolve({ json: async () => ({ dataUrl: "data:image/png;base64,stale", revision: "1" }) });
  await first;
  assert.equal(element("iedImg").src, "data:image/png;base64,newest");
  assert.equal(element("iedDocName").textContent, "Second document");
  assert.equal(ctx.ied.rotate, 0);
  assert.equal(vm.runInContext("iedDocViewReady", ctx), true);
  assert.equal(vm.runInContext("iedDocPaintTargets.image.ready", ctx), true);
});

test("the latest canvas choice wins when document opens finish out of order", async () => {
  const pending = new Map(), elements = new Map(), previews = [], messages = [];
  const element = id => { if (!elements.has(id)) elements.set(id, { src: "", textContent: "" }); return elements.get(id); };
  const ctx = vm.createContext({
    iedDoc: null, iedDocLines: [], iedDocPick: [], iedDocOpenSeq: 0, iedDocViewSeq: 0,
    ied: { name: "" }, iedDocPost: ({ id }) => new Promise(resolve => pending.set(id, resolve)),
    iedDocFlat: layers => layers || [], iedDocSay: message => messages.push(message),
    iedDocPaint() {}, iedToast: message => messages.push(message),
    iedDocViewRefresh: async () => previews.push(ctx.iedDoc?.id),
    iedPreviewClear() {}, iedAIPaint() {}, iedApplyEnable() {}, $: element,
  });
  vm.runInContext(section("async function iedDocOpenId(id)", "/* A document is the canvas"), ctx);
  vm.runInContext(section('$("iedDocClose").onclick = () =>', '$("iedDockDocs").addEventListener'), ctx);

  const older = vm.runInContext('iedDocOpenId("older")', ctx);
  const newer = vm.runInContext('iedDocOpenId("newer")', ctx);
  pending.get("newer")({ doc: { id: "newer", name: "Newer", layers: [], width: 16, height: 16 } });
  await newer;
  pending.get("older")({ doc: { id: "older", name: "Older", layers: [], width: 16, height: 16 } });
  await older;
  assert.equal(ctx.iedDoc.id, "newer");
  assert.deepEqual(previews, ["newer"], "the older response does not render over the newer canvas");

  const afterClose = vm.runInContext('iedDocOpenId("after-close")', ctx);
  element("iedDocClose").onclick();
  pending.get("after-close")({ doc: { id: "after-close", layers: [] } });
  await afterClose;
  assert.equal(ctx.iedDoc, null, "closing the document invalidates an in-flight open");

  // The flat-image chooser uses the same invalidation token.
  vm.runInContext(section("function openImageEditor(name) {", "  const im =") + "}", ctx);
  const afterImage = vm.runInContext('iedDocOpenId("after-image")', ctx);
  vm.runInContext('openImageEditor("photo.png")', ctx);
  pending.get("after-image")({ doc: { id: "after-image", layers: [] } });
  await afterImage;
  assert.equal(ctx.iedDoc, null, "choosing a flat image invalidates an in-flight document open");
  assert.deepEqual(previews, ["newer"]);
});

test("a finished edit cannot replace a different or re-opened document", async () => {
  let answer;
  const previews = [];
  const ctx = vm.createContext({
    iedDoc: { id: "edited", layers: [] }, iedDocBusy: false, iedDocLines: [], iedDocPick: [],
    iedDocFlat: layers => layers || [], iedDocPaint() {}, iedDocSay() {}, iedToast() {},
    iedDocViewRefresh: async () => previews.push(ctx.iedDoc.id),
    fetch: async (_url, init) => {
      assert.equal(JSON.parse(init.body).id, "edited");
      return { json: () => new Promise(resolve => { answer = resolve; }) };
    },
  });
  vm.runInContext(section("async function iedDocEdit(ops, what)", "async function iedDocList()"), ctx);
  const edit = vm.runInContext('iedDocEdit([{ op: "update_layer" }], "change")', ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof answer, "function");
  ctx.iedDoc = { id: "chosen", layers: [] };
  answer({ id: "edited", doc: { id: "edited", layers: [{ id: "result" }] }, outline: [{ id: "result" }] });
  await edit;
  assert.equal(ctx.iedDoc.id, "chosen");
  assert.deepEqual(previews, []);
  assert.equal(ctx.iedDocBusy, false);

  ctx.iedDoc = { id: "edited", layers: [] };
  const editBeforeReopen = vm.runInContext('iedDocEdit([{ op: "update_layer" }], "change")', ctx);
  await new Promise(resolve => setImmediate(resolve));
  const reopened = { id: "edited", layers: [{ id: "newer" }] };
  ctx.iedDoc = reopened;
  answer({ id: "edited", doc: { id: "edited", layers: [{ id: "stale" }] } });
  await editBeforeReopen;
  assert.equal(ctx.iedDoc, reopened, "a fresh open of the same document owns the canvas");
  assert.deepEqual(previews, []);
});

test("editor presents references, frozen source comparison and explicit review actions", () => {
  for (const id of ["iedAIOpen", "iedDockAI", "iedAIMode", "iedAIPrompt", "iedAIRefPick", "iedAIRefs",
    "iedAISourcePreview", "iedAICandidate", "iedAIAccept", "iedAIUndo", "iedAIDiscard"])
    assert.equal(html.split(`id="${id}"`).length - 1, 1, `${id} has one live control`);
  assert.match(html, /composites through the frozen selection/);
  assert.match(app, /\["AI edit", \["ai", "docs", "sel"\]\]/);
  assert.match(section("async function iedAIResolve(action)", '$("iedAIAccept").onclick'), /action, id: iedAI\.job\.id/);
  assert.match(section("async function iedDocEdit(ops, what)", "async function iedDocList()"), /await iedDocViewRefresh\(\)/);
});

test("document canvas blocks legacy file actions before their handlers, while document and AI actions remain available", () => {
  const notices = [], registrations = [];
  const ctx = vm.createContext({ iedDoc: { id: "doc" },
    iedToast: message => notices.push(message),
    $: () => ({ addEventListener: (...args) => registrations.push(args) }),
  });
  vm.runInContext(section("const IED_DOC_FILE_TOOLS =", "async function iedDocViewRefresh()"), ctx);
  assert.equal(registrations[0][0], "click"); assert.equal(registrations[0][2], true);
  function click(id) {
    const event = { target: { closest: () => ({ id }) }, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    ctx.event = event;
    vm.runInContext("iedGuardDocumentFileClick(event)", ctx);
    return event;
  }
  for (const id of ["iedCut", "iedUp", "iedDl", "iedTrash2", "iedAuto", "iedVecGo", "iedSelBake", "iedLutGo", "iedCompose"])
    assert.equal(click(id).stopped, true, `${id} cannot reach the previous image`);
  for (const id of ["iedDocRender", "iedAIGenerate", "iedAIAccept", "iedDocNew"])
    assert.equal(click(id).stopped, false, `${id} acts on the document`);
  ctx.iedDoc = null;
  assert.equal(click("iedCut").stopped, false);
  assert.match(notices[0], /Render & open composite/);
  const exportHandler = section('$("iedDocRender").onclick = async () =>', "async function iedPresetsLoad()");
  assert.ok(exportHandler.indexOf("openImageEditor(r.name)") > exportHandler.indexOf("await loadImages()"));
});

test("StandRig PSD button exports the saved document and accepts only its local download route", async () => {
  assert.equal(html.split('id="iedDocPsd"').length - 1, 1);
  const elements = new Map(), calls = [], messages = [], downloads = [];
  const element = id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); };
  let url = "/api/images/standrig-psd/standrig_" + "a".repeat(32) + ".psd";
  const ctx = vm.createContext({ iedDoc: { id: "saved_doc" }, iedDocBusy: false,
    iedDocPaint() {}, iedDocSay: (...args) => messages.push(args), $: element,
    fetch: async (path, init) => { calls.push({ path, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ name: "part.psd", downloadUrl: url, layers: [{ name: "hair" }, { name: "head" }], warnings: [] }) }; },
    document: { body: { append() {} }, createElement: () => ({ click() { downloads.push(this.href); }, remove() {} }) },
  });
  vm.runInContext(section('$("iedDocPsd").onclick = async () =>', '$("iedDocRender").onclick = async () =>'), ctx);
  await element("iedDocPsd").onclick();
  assert.deepEqual(calls, [{ path: "/api/images/standrig-psd", body: { id: "saved_doc" } }]);
  assert.deepEqual(downloads, [url]);
  assert.match(messages.at(-1)[0], /PSD ready/);
  url = "https://outside.example/part.psd";
  await element("iedDocPsd").onclick();
  assert.equal(downloads.length, 1);
  assert.match(messages.at(-1)[0], /invalid download link/);
});

test("layer paint UI requires fresh server eligibility and the HTTP route checks it before painting", () => {
  const layer = { id: "result", type: "image", src: "qwen_edit.png", locked: false };
  const ctx = vm.createContext({ iedDoc: { id: "doc" }, iedDocRef: () => "result",
    iedDocFind: () => ({ layer }), iedDocViewReady: true,
    iedDocPaintTargets: { result: { ready: false, reason: "Transformed parent" } },
  });
  vm.runInContext(section("function iedPaintTarget()", "function iedPendingMarks()"), ctx);
  assert.equal(vm.runInContext("iedPaintTarget()", ctx), null);
  ctx.iedDocPaintTargets.result.ready = true;
  assert.equal(vm.runInContext("iedPaintTarget().ref", ctx), "result");
  ctx.iedDocViewReady = false;
  assert.equal(vm.runInContext("iedPaintTarget()", ctx), null);
  const index = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const start = index.indexOf('if (p === "/api/images/document-paint"');
  const route = index.slice(start, index.indexOf('if (p === "/api/images/document-edit"', start));
  const guard = route.indexOf("await imageEditor.paintTarget({ doc, ref })");
  const paint = route.indexOf('await imgWorker().run("edit"');
  assert.ok(guard >= 0 && paint > guard, "authoritative guard runs before source pixels are painted");
  assert.match(route, /expectedUpdatedAt: doc.updatedAt/);
  assert.match(route, /paintKeys\.has\(key\)/);
});
