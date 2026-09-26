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

test("document viewport uses the newest actual composed pixels, ignoring out-of-order responses", async () => {
  const requests = [], elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, { style: {}, src: "", textContent: "", addEventListener() {} }); return elements.get(id); };
  const ctx = vm.createContext({
    iedDoc: { id: "one", name: "First document" }, ied: { rotate: 90, flipH: true, flipV: false, crop: {} },
    iedPreviewSeq: 0, iedAIPaint() {}, iedPreviewClear() {}, iedApplyEnable() {}, iedDocPaint() {},
    iedDocSay(message) { throw new Error(message); }, $: element,
    fetch: async (url, init) => new Promise(resolve => requests.push({ url, body: JSON.parse(init.body), resolve })),
  });
  vm.runInContext(section("let iedDocViewSeq =", "const iedAI ="), ctx);
  const first = vm.runInContext("iedDocViewRefresh()", ctx);
  ctx.iedDoc = { id: "two", name: "Second document" };
  const second = vm.runInContext("iedDocViewRefresh()", ctx);
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
