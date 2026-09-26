import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { collabTools } from "../mcp-collab.js";

const source = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const collabSource = source.slice(source.indexOf("const cb = (body)"), source.indexOf("function paintExtend(t)"));
const picturesSource = source.slice(source.indexOf("function imageFriendJob()"), source.indexOf('$("imgGo").onclick', source.indexOf("function imageFriendJob()")));

function pictureFixture() {
  const nodes = new Map(), views = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: "", checked: false, textContent: "", handlers: {}, classList: { add() {} },
      addEventListener(event, handler) { this.handlers[event] = handler; } });
    return nodes.get(id);
  };
  for (const [id, value] of Object.entries({
    imgEngine: "qwen-image-2.1", imgPrompt: "  Pink-haired dancer by a window  ", imgPersona: "",
    imgRefSizing: "custom", imgCount: "1", imgSteps: "25", imgCfg: "1", imgNeg: "",
    imgSize: "1024x1024", imgSeed: "", imgW: "1024", imgH: "1024",
  })) node(id).value = value;
  const context = vm.createContext({ $: node, imgRefs: [], imgDraftOn: () => false,
    setView: (name, options) => views.push({ name, options }) });
  vm.runInContext(picturesSource, context);
  return { node, views, context, press: () => node("imgAskFriend").handlers.click() };
}

function collabFixture() {
  const nodes = new Map(), calls = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      value: "", textContent: "", hidden: false, disabled: false, dataset: {}, handlers: {}, inputs: [],
      addEventListener(event, handler) { this.handlers[event] = handler; },
      setAttribute() {}, scrollIntoView() {}, focus() {}, classList: { add() {}, remove() {} },
      querySelectorAll(q) { return q === "img[data-cb-image-reference]" ? (this.images || [])
        : q === "input:checked" ? this.inputs.filter((x) => x.checked)
        : q === 'input[type="checkbox"]' ? this.inputs.filter((x) => x.type === "checkbox")
          : q === "[data-rate]" ? this.inputs.filter((x) => x.dataset?.rate) : []; },
      querySelector(q) { return q === "input" ? this.inputs[0] || null : null; },
      set innerHTML(markup) {
        this.markup = markup;
        this.images = [...markup.matchAll(/<img\b([^>]*\bdata-cb-image-reference="([^"]+)"[^>]*)>/g)].map((match) => ({
          complete: false, naturalWidth: 0, naturalHeight: 0, dataset: { cbImageReference: match[2] },
        }));
        this.inputs = [...markup.matchAll(/<input\b([^>]+)>/g)].map((m) => ({
          type: /type="([^"]*)"/.exec(m[1])?.[1], value: /value="([^"]*)"/.exec(m[1])?.[1] || "",
          dataset: { rate: /data-rate="([^"]*)"/.exec(m[1])?.[1] }, checked: /\bchecked\b/.test(m[1]),
        }));
        const first = /<option\b[^>]*value="([^"]*)"/.exec(markup);
        if (first) this.value = first[1];
      },
      get innerHTML() { return this.markup || ""; },
    });
    return nodes.get(id);
  };
  const peer = { fp: "ab".repeat(16), nickname: "Friend", verified: true, role: "lender",
    resources: { gpu: { vramMb: 16384 }, ready: ["qwen-image-2.1"] }, resourcesSaid: "today" };
  const project = { segments: [{ id: "opening", title: "Opening", mode: "generate" }] };
  const plan = { slug: "episode", revision: 0, notes: "", shots: [{ segmentId: "opening", title: "Opening", stage: "storyboard", owner: null, pinned: false, reviewNote: "" }] };
  const defaults = (url, body) => {
    if (url === "/api/mv/projects") return { projects: [{ slug: "episode", title: "Episode" }] };
    if (url === "/api/mv/project/episode") return { project };
    if (url === "/api/collab/plan?slug=episode") return { ok: true, plan };
    if (body?.action === "roster") return { peers: [peer] };
    if (body?.action === "me") return { fp: "cd".repeat(16), words: [], card: "key" };
    return { items: [], orders: [], takes: [], images: [] };
  };
  const context = vm.createContext({
    $: node, esc: (v) => String(v ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;"),
    state: { collabProtocol: 1 }, localStorage: { getItem() { return ""; }, setItem() {} },
    navigator: {}, CSS: { escape: (s) => s }, matchMedia: () => ({ matches: true }), setTimeout() {},
    respond: defaults,
    fetch: async (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : null;
      calls.push({ url, body });
      return { json: async () => context.respond(url, body) };
    },
  });
  node("cbKind").value = "shot"; node("cbDraftPolicy").value = "equal";
  vm.runInContext(collabSource, context);
  return { node, calls, context, defaults, peer,
    run: (code) => vm.runInContext(code, context),
    fire: (id, event = "click") => node(id).handlers[event]?.({ target: node(id) }) };
}

test("Pictures hands an exact, ordered Qwen-only job to Collab without submitting it", () => {
  const f = pictureFixture();
  f.context.imgRefs.push({ name: "head.png", url: "/api/images/head.png" }, { name: "hair.webp", url: "/api/images/hair.webp" });
  f.node("imgSeed").value = "42";
  f.press();
  assert.deepEqual(JSON.parse(JSON.stringify(f.views)), [{ name: "collab", options: {
    imageJob: { prompt: "Pink-haired dancer by a window", negative: "", width: 1024, height: 1024,
      steps: 25, cfg: 1, seed: 42, refs: ["head.png", "hair.webp"] },
    imageRefPreviews: [{ name: "head.png", url: "/api/images/head.png" }, { name: "hair.webp", url: "/api/images/hair.webp" }],
  } }]);
  assert.match(html.match(/<button[^>]*id="imgAskFriend"[^>]*>[^<]*/)?.[0] || "", /Ask friend/);
});

test("Pictures refuses settings that the narrow friend contract would silently change", () => {
  for (const [id, property, value, expected] of [
    ["imgEngine", "value", "sdxl", /Qwen Image 2\.1/],
    ["imgPrivate", "checked", true, /reveals its words/],
    ["imgPersona", "value", "saved-hero", /saved character/],
    ["imgTransparent", "checked", true, /Transparent/],
    ["imgCount", "value", "2", /one image/],
    ["imgSteps", "value", "4", /25-step/],
    ["imgCfg", "value", "2", /CFG 1/],
    ["imgNeg", "value", "negative", /CFG 1/],
    ["imgSize", "value", "512x512", /1024 × 1024/],
    ["imgSeed", "value", "-1", /Seed/],
  ]) {
    const f = pictureFixture(); f.node(id)[property] = value; f.press();
    assert.equal(f.views.length, 0, `${id} must not navigate to Collab`);
    assert.match(f.node("imgNote").textContent, expected);
  }
  const f = pictureFixture();
  f.context.imgRefs.push({ name: "head.png", url: "x" }, { name: "hair.png", url: "y" },
    { name: "outfit.png", url: "z" }, { name: "fourth.png", url: "w" });
  f.press();
  assert.equal(f.views.length, 0);
  assert.match(f.node("imgNote").textContent, /up to three/);
});

test("Collab image preview exposes exact seed and reference hashes; pack uses only the frozen token", async () => {
  const f = collabFixture();
  const image = { prompt: "A dancer", negative: "", width: 1344, height: 768, steps: 25, cfg: 1,
    seed: 42, refs: ["head.png", "hair.png"] };
  const hashes = ["1".repeat(64), "2".repeat(64)];
  f.context.image = image;
  await f.run("paintCollab(false, null, null, image, [{name:'head.png',url:'/api/images/head.png'},{name:'hair.png',url:'/api/images/hair.png'}])");
  assert.equal(f.node("cbKind").value, "image-job");
  assert.equal(f.node("cbTo").value, "", "a friend is never selected automatically");
  assert.ok(!f.calls.some((c) => ["preview", "pack", "image_render"].includes(c.body?.action)));
  f.node("cbTo").value = f.peer.fp; await f.fire("cbTo", "change");
  f.context.respond = (url, body) => body?.action === "preview" ? {
    previewId: "sealed-image-1", to: f.peer,
    packet: { kind: "job-order", jobType: "image", job: { ...image, references: hashes.map((sha256) => ({ sha256, bytes: 2048, b64: "PRIVATE_REFERENCE_BYTES" })) } },
    manifest: [{ file: "head.png", included: true }, { file: "hair.png", included: true }],
  } : body?.action === "pack" ? { file: "image.aiplay", bytes: 4100, to: f.peer }
    : f.defaults(url, body);
  await f.fire("cbPreview");
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find((c) => c.body?.action === "preview").body)),
    { action: "preview", kind: "image-job", to: f.peer.fp, image });
  assert.match(f.node("cbPreviewSettings").textContent, /1344 × 768.*25 steps.*CFG 1.*seed 42.*2 included references.*idle unknown/);
  assert.match(f.node("cbPreviewManifest").innerHTML, new RegExp(hashes[0]));
  assert.match(f.node("cbPreviewManifest").innerHTML, new RegExp(hashes[1]));
  assert.match(f.node("cbPreviewPictures").innerHTML, /head\.png/);
  assert.doesNotMatch(f.node("cbPreviewPacket").textContent, /PRIVATE_REFERENCE_BYTES/);
  assert.equal(f.node("cbPack").disabled, false);
  await f.fire("cbPack");
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find((c) => c.body?.action === "pack").body)),
    { action: "pack", previewId: "sealed-image-1" });
  assert.match(f.node("cbPackNote").textContent, /Awaiting your manual handoff/);
});

test("an incomplete image preview cannot arm Prepare even if it has a token", async () => {
  const f = collabFixture(), image = { prompt: "A dancer", negative: "", width: 1024, height: 1024,
    steps: 25, cfg: 1, refs: ["head.png"] };
  f.context.image = image;
  await f.run("paintCollab(false, null, null, image)");
  f.node("cbTo").value = f.peer.fp; await f.fire("cbTo", "change");
  f.context.respond = (url, body) => body?.action === "preview"
    ? { previewId: "incomplete", to: f.peer, packet: { job: { ...image, seed: 5, references: [] } } }
    : f.defaults(url, body);
  await f.fire("cbPreview");
  assert.equal(f.node("cbPack").disabled, true);
  assert.match(f.node("cbPackNote").textContent, /did not include the exact job and reference hashes/);
  await f.fire("cbPack");
  assert.ok(!f.calls.some((c) => c.body?.action === "pack"));
});

test("returned image remains quarantined until its checked picture actually loads and is kept", async () => {
  const f = collabFixture();
  const good = { v: 1, from: f.peer.fp, file: "image_a.png", orderId: "o_0123456789ab", ok: true,
    adopted: false, why: "Signed image, decoded and matched to the sent job.", prompt: "A dancer",
    record: { model: "Qwen Image 2.1", seed: 7, outputRights: { class: "open" } } };
  const bad = { ...good, file: "image_b.png", ok: false, reason: "canvas-mismatch" };
  f.context.respond = (url, body) => body?.action === "quarantine" ? { takes: [], images: [good, bad] }
    : body?.action === "image_adopt" ? { ok: true, name: "filed.png" } : f.defaults(url, body);
  await f.run("paintTakes()");
  const markup = f.node("cbImages").innerHTML;
  assert.equal(f.node("cbImagesWrap").hidden, false);
  assert.equal((markup.match(/cbimagepreview/g) || []).length, 1, "only the checked image may be previewed");
  assert.equal((markup.match(/cbimageadopt/g) || []).length, 1, "only the checked image may be kept");
  assert.match(markup, /cbimageadopt[^>]*disabled/);
  assert.match(markup, /data-src="\/api\/collab-image\//);
  assert.doesNotMatch(markup, /<img[^>]*\ssrc="\/api\/collab-image\//, "a list refresh must not decode the image");
  const preview = { textContent: "Preview image", classList: { contains: (c) => c === "cbimagepreview" } };
  const keep = { disabled: true, classList: { contains: (c) => c === "cbimageadopt" } };
  const image = { hidden: true, dataset: { src: `/api/collab-image/${good.from}/${good.file}` },
    classList: { contains: (c) => c === "cbreturnedimage" } };
  const row = { dataset: { from: good.from, file: good.file },
    querySelector: (selector) => selector === ".cbreturnedimage" ? image
      : selector === ".cbimagepreview" ? preview : selector === ".cbimageadopt" ? keep : null };
  const event = (target) => ({ target: { ...target, closest: () => row } });
  await f.node("cbImages").handlers.click(event(keep));
  assert.ok(!f.calls.some((c) => c.body?.action === "image_adopt"));
  await f.node("cbImages").handlers.click(event(preview));
  assert.equal(image.src, image.dataset.src);
  assert.ok(!f.calls.some((c) => c.body?.action === "image_adopt"));
  f.node("cbImages").handlers.load(event(image));
  assert.equal(keep.disabled, false);
  await f.node("cbImages").handlers.click(event(keep));
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find((c) => c.body?.action === "image_adopt").body)),
    { action: "image_adopt", from: good.from, file: good.file });
});

test("incoming image requires separate review, accept, render and send-back presses", async () => {
  const f = collabFixture();
  const reviewDigest = "d".repeat(64);
  const job = { prompt: "Dancer", width: 1024, height: 1024, steps: 25, cfg: 1, seed: 7,
    references: [{ sha256: "a".repeat(64), bytes: 99 }] };
  const imageJob = { id: "o_0123456789ab", job };
  let state = "new";
  f.context.respond = (url, body) => {
    if (body?.action === "open") return { kind: "job-order", file: "friend.aiplay", from: f.peer,
      imageJob, packet: { job: { references: [{ sha256: job.references[0].sha256, mime: "image/png", b64: "iVBORw0KGgo=" }] } } };
    if (body?.action === "image_accept") {
      if (body.seen !== true) return { reason: "not-seen", error: "Review first", from: f.peer, imageJob, reviewDigest };
      if (body.expectedDigest !== reviewDigest) return { reason: "review-changed", error: "Review again" };
      state = "landed"; return { ok: true, note: "Accepted locally" };
    }
    if (body?.action === "image_render") { state = "queued"; return { ok: true, note: "Queued" }; }
    if (body?.action === "orders") return { orders: state === "new" ? []
      : [{ id: imageJob.id, jobType: "image", state, imageId: "rendered_1" }] };
    if (body?.action === "image_send_back") return { ok: true, file: "return.aiplay" };
    if (url === "/api/images") return { images: [{ name: "rendered_1.png" }] };
    return f.defaults(url, body);
  };
  await f.run('openCollabFile("friend.aiplay")');
  assert.equal(f.node("cbImageFace").hidden, false);
  assert.equal(f.node("cbImagePrompt").textContent, "Dancer");
  assert.match(f.node("cbImageRefs").innerHTML, /data:image\/png;base64/);
  assert.equal(f.node("cbImageReview").disabled, true, "review must wait until the reference really displays");
  assert.ok(!f.calls.some((c) => ["image_accept", "image_render", "image_send_back"].includes(c.body?.action)));
  await f.fire("cbImageAccept");
  assert.ok(!f.calls.some((c) => c.body?.action === "image_accept"), "accept without review is inert");
  await f.fire("cbImageReview");
  assert.ok(!f.calls.some((c) => c.body?.action === "image_accept"), "review before image load is inert");
  const shown = f.node("cbImageRefs").images[0];
  shown.complete = true; shown.naturalWidth = 1; shown.naturalHeight = 1;
  f.node("cbImageRefs").handlers.load({ target: shown });
  assert.equal(f.node("cbImageReview").disabled, false);
  await f.fire("cbImageReview");
  assert.equal(f.node("cbImageAccept").hidden, false);
  assert.deepEqual(f.calls.filter((c) => c.body?.action === "image_accept").map((c) => c.body.seen === true), [false]);
  await f.fire("cbImageAccept");
  assert.deepEqual(f.calls.filter((c) => c.body?.action === "image_accept").map((c) => c.body.seen === true), [false, true]);
  assert.equal(f.calls.find((c) => c.body?.action === "image_accept" && c.body.seen === true).body.expectedDigest, reviewDigest);
  assert.equal(f.node("cbImageRender").hidden, false);
  assert.ok(!f.calls.some((c) => c.body?.action === "image_render"));
  await f.fire("cbImageRender");
  assert.equal(f.calls.filter((c) => c.body?.action === "image_render").length, 1);
  assert.equal(f.node("cbImageSendBack").disabled, false);
  assert.ok(!f.calls.some((c) => c.body?.action === "image_send_back"));
  await f.fire("cbImageSendBack");
  assert.equal(f.calls.filter((c) => c.body?.action === "image_send_back").length, 1);
});

test("an incoming reference that fails to display cannot arm review or acceptance", async () => {
  const f = collabFixture();
  const imageJob = { id: "o_0123456789ab", returnTo: { fp: f.peer.fp, nickname: "Sender" },
    job: { prompt: "Use this reference", width: 1024, height: 1024, steps: 25, cfg: 1,
      seed: 7, references: [{ sha256: "a".repeat(64), bytes: 99 }] } };
  f.context.respond = (url, body) => body?.action === "open"
    ? { kind: "job-order", file: "friend.aiplay", from: f.peer, imageJob,
      packet: { job: { references: [{ sha256: "a".repeat(64), mime: "image/png", b64: "iVBORw0KGgo=" }] } } }
    : body?.action === "image_accept" ? { reason: "not-seen", from: f.peer, imageJob, reviewDigest: "d".repeat(64) }
      : f.defaults(url, body);
  await f.run('openCollabFile("friend.aiplay")');
  const image = f.node("cbImageRefs").images[0];
  assert.equal(f.node("cbImageReview").disabled, true);
  image.complete = true; image.naturalWidth = 0; image.naturalHeight = 0;
  f.node("cbImageRefs").handlers.error({ target: image });
  assert.match(f.node("cbImageNote").textContent, /could not be shown/);
  await f.fire("cbImageReview");
  assert.ok(!f.calls.some((call) => call.body?.action === "image_accept"), "the failed visual review must not call acceptance");
  image.naturalWidth = 1; image.naturalHeight = 1;
  f.node("cbImageRefs").handlers.load({ target: image });
  assert.equal(f.node("cbImageReview").disabled, true, "an error event must remain latched until the file is reopened");
  await f.fire("cbImageAccept");
  assert.ok(!f.calls.some((call) => call.body?.seen === true));
});

test("acceptance rechecks that every displayed reference remains available after review", async () => {
  const f = collabFixture();
  const imageJob = { id: "o_0123456789ab", job: { prompt: "Dancer", width: 1024, height: 1024,
    steps: 25, cfg: 1, seed: 7, references: [{ sha256: "a".repeat(64), bytes: 99 }] } };
  f.context.respond = (url, body) => body?.action === "open"
    ? { kind: "job-order", file: "friend.aiplay", from: f.peer, imageJob,
      packet: { job: { references: [{ sha256: "a".repeat(64), mime: "image/png", b64: "iVBORw0KGgo=" }] } } }
    : body?.action === "image_accept" ? { reason: "not-seen", from: f.peer, imageJob, reviewDigest: "d".repeat(64) }
      : f.defaults(url, body);
  await f.run('openCollabFile("friend.aiplay")');
  const image = f.node("cbImageRefs").images[0];
  image.complete = true; image.naturalWidth = 1; image.naturalHeight = 1;
  f.node("cbImageRefs").handlers.load({ target: image });
  await f.fire("cbImageReview");
  assert.equal(f.node("cbImageAccept").disabled, false);
  image.naturalWidth = 0; image.naturalHeight = 0;
  f.node("cbImageRefs").handlers.error({ target: image });
  assert.equal(f.node("cbImageAccept").disabled, true);
  await f.fire("cbImageAccept");
  assert.ok(!f.calls.some((call) => call.body?.action === "image_accept" && call.body.seen === true));
});

test("review refuses a changed signer or return address even when the image settings match", async () => {
  for (const changed of ["signer", "returnTo"]) {
    const f = collabFixture();
    const imageJob = { id: "o_0123456789ab", returnTo: { fp: f.peer.fp, nickname: "Sender" },
      job: { prompt: "Dancer", width: 1024, height: 1024, steps: 25, cfg: 1, seed: 7, references: [] } };
    const other = { ...f.peer, fp: "ef".repeat(16), nickname: "Another signer" };
    f.context.respond = (url, body) => body?.action === "open"
      ? { kind: "job-order", file: "friend.aiplay", from: f.peer, imageJob, packet: { job: { references: [] } } }
      : body?.action === "image_accept" ? { reason: "not-seen", from: changed === "signer" ? other : f.peer,
        imageJob: changed === "returnTo" ? { ...imageJob, returnTo: { ...imageJob.returnTo, nickname: "Changed" } } : imageJob,
        reviewDigest: "d".repeat(64) } : f.defaults(url, body);
    await f.run('openCollabFile("friend.aiplay")');
    await f.fire("cbImageReview");
    assert.equal(f.node("cbImageAccept").hidden, true, changed);
    assert.match(f.node("cbImageNote").textContent, /file or its signer changed/, changed);
    await f.fire("cbImageAccept");
    assert.ok(!f.calls.some((call) => call.body?.action === "image_accept" && call.body.seen === true), changed);
  }
});

test("every prepared image order keeps its own reveal and copy action after another friend is packed", async () => {
  const f = collabFixture();
  const first = "C:\\Studio\\collab\\out\\image-o_first-to-ab.aiplay";
  const second = "C:\\Studio\\collab\\out\\image-o_second-to-cd.aiplay";
  const copied = [];
  f.context.navigator.clipboard = { writeText: async (value) => copied.push(value) };
  f.context.respond = (url, body) => body?.action === "orders" && body.side === "out"
    ? { orders: [
      { id: "o_first", file: first, jobType: "image", state: "sent", to: f.peer,
        imageJob: { job: { seed: 11 } } },
      { id: "o_second", file: second, jobType: "image", state: "sent",
        to: { ...f.peer, fp: "cd".repeat(16), nickname: "Second friend" },
        imageJob: { job: { seed: 22 } } },
    ] } : f.defaults(url, body);
  await f.run("paintOutbox()");
  const markup = f.node("cbOutbox").innerHTML;
  assert.match(markup, /image-o_first-to-ab\.aiplay/);
  assert.match(markup, /image-o_second-to-cd\.aiplay/);
  assert.equal((markup.match(/cbfile-reveal/g) || []).length, 2);
  assert.equal((markup.match(/cbfile-copy/g) || []).length, 2);
  const row = { dataset: { file: first } };
  const button = (name) => ({ classList: { contains: (className) => className === name },
    closest: () => row });
  await f.node("cbOutbox").handlers.click({ target: { closest: (q) => q === "button" ? button("cbfile-copy") : row } });
  assert.deepEqual(copied, [first]);
  row.dataset.file = second;
  await f.node("cbOutbox").handlers.click({ target: { closest: (q) => q === "button" ? button("cbfile-copy") : row } });
  assert.deepEqual(copied, [first, second], "the second friend keeps a separate sealed file location");
  row.dataset.file = first;
  await f.node("cbOutbox").handlers.click({ target: { closest: (q) => q === "button" ? button("cbfile-reveal") : row } });
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find((call) => call.url === "/api/reveal")?.body)),
    { file: "collab/out/image-o_first-to-ab.aiplay" });
});

test("rendering stays locked while failed image jobs require an explicit retry", async () => {
  const f = collabFixture();
  const imageJob = { id: "o_0123456789ab", job: { prompt: "Dancer", width: 1024, height: 1024,
    steps: 25, cfg: 1, seed: 7, references: [] } };
  let state = "rendering";
  f.context.respond = (url, body) => body?.action === "open"
    ? { kind: "job-order", file: "friend.aiplay", from: f.peer, imageJob, packet: { job: { references: [] } } }
    : body?.action === "orders" && body.side === "in"
      ? { orders: [{ id: imageJob.id, jobType: "image", state, imageJob, from: f.peer }] }
      : body?.action === "image_render" ? { ok: true, note: "Queued" } : f.defaults(url, body);
  await f.run('openCollabFile("friend.aiplay")');
  assert.equal(f.node("cbImageRender").hidden, true, "an uncertain receipt must not allow a second render");
  assert.equal(f.node("cbImageCheck").hidden, false);
  assert.match(f.node("cbImageNote").textContent, /receipt uncertain/);
  await f.run("paintErrands()");
  assert.doesNotMatch(f.node("cbErrands").innerHTML, /cbimgrender/);
  state = "failed";
  await f.run("paintImageCardStatus()");
  assert.equal(f.node("cbImageRender").hidden, false);
  assert.equal(f.node("cbImageRender").textContent, "Retry image render");
  await f.fire("cbImageRender");
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find((call) => call.body?.action === "image_render")?.body)),
    { action: "image_render", id: imageJob.id, retry: true });
  await f.run("paintErrands()");
  assert.match(f.node("cbErrands").innerHTML, /data-retry="true"/);
});

test("a rendered incoming image exposes a persistent, verified handoff action", async () => {
  const f = collabFixture();
  const id = "o_0123456789ab", file = "C:\\Studio\\collab\\out\\return.aiplay";
  f.context.respond = (url, body) => body?.action === "orders" && body.side === "in"
    ? { orders: [{ id, jobType: "image", state: "rendered", from: f.peer, imageJob: { job: { seed: 7, references: [] } } }] }
    : body?.action === "image_send_back" ? { ok: true, file, note: "Already prepared" }
      : f.defaults(url, body);
  await f.run("paintErrands()");
  assert.match(f.node("cbErrands").innerHTML, /cbimglocate/);
  const row = { dataset: { id } };
  const target = { classList: { contains: (name) => name === "cbimglocate" },
    closest: (q) => q === ".cbpeer" ? row : null };
  await f.node("cbErrands").handlers.click({ target });
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find((call) => call.body?.action === "image_send_back")?.body)),
    { action: "image_send_back", id });
  assert.equal(f.node("cbHandoff").dataset.file, file);
});

test("image acceptance is bound to the exact opened file, even after its review card is armed", async () => {
  const f = collabFixture();
  const reviewDigest = "e".repeat(64);
  const imageJob = { id: "o_0123456789ab", job: { prompt: "One dancer", width: 1024, height: 1024,
    steps: 25, cfg: 1, seed: 7, references: [] } };
  f.context.respond = (url, body) => body?.action === "open"
    ? { kind: "job-order", file: "first.aiplay", from: f.peer, imageJob, packet: { job: { references: [] } } }
    : body?.action === "image_accept" ? { reason: "not-seen", from: f.peer, imageJob, reviewDigest } : f.defaults(url, body);
  await f.run('openCollabFile("first.aiplay")');
  await f.fire("cbImageReview");
  assert.equal(f.node("cbFileCard").dataset.imageArmed, "first.aiplay");
  f.node("cbFile").value = "second.aiplay";
  await f.fire("cbImageAccept");
  assert.equal(f.calls.filter((c) => c.body?.action === "image_accept" && c.body.seen === true).length, 0);
  assert.equal(f.node("cbImageAccept").hidden, true);
});

test("a review response without a sealed-file digest cannot arm image acceptance", async () => {
  const f = collabFixture();
  const imageJob = { id: "o_0123456789ab", job: { prompt: "One dancer", width: 1024, height: 1024,
    steps: 25, cfg: 1, seed: 7, references: [] } };
  f.context.respond = (url, body) => body?.action === "open"
    ? { kind: "job-order", file: "first.aiplay", from: f.peer, imageJob, packet: { job: { references: [] } } }
    : body?.action === "image_accept" ? { reason: "not-seen", from: f.peer, imageJob } : f.defaults(url, body);
  await f.run('openCollabFile("first.aiplay")');
  await f.fire("cbImageReview");
  assert.equal(f.node("cbImageAccept").hidden, true);
  assert.match(f.node("cbImageNote").textContent, /did not bind this review/);
  await f.fire("cbImageAccept");
  assert.ok(!f.calls.some((c) => c.body?.action === "image_accept" && c.body.seen === true));
});

test("typed MCP image acceptance requires the prior review digest and forwards it unchanged", async () => {
  const calls = [];
  const tool = collabTools(async (...args) => { calls.push(args); return { ok: true }; }, (s) => s)
    .find((entry) => entry.name === "collab_image_accept");
  assert.ok(tool);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.inputSchema.properties.review_digest.pattern, "^[0-9a-f]{64}$");
  await tool.run({ file: "signed.aiplay", seen: false });
  assert.deepEqual(calls[0], ["POST", "/api/collab", { action: "image_accept", file: "signed.aiplay", seen: false }]);
  await assert.rejects(tool.run({ file: "signed.aiplay", seen: true }), /review_digest/);
  assert.equal(calls.length, 1, "missing digest must not reach the API");
  const digest = "f".repeat(64);
  await tool.run({ file: "signed.aiplay", seen: true, review_digest: digest });
  assert.deepEqual(calls[1], ["POST", "/api/collab", { action: "image_accept", file: "signed.aiplay",
    seen: true, expectedDigest: digest }]);
});

test("typed MCP preview maps only bounded image fields to the same Collab route", async () => {
  const calls = [];
  const tool = collabTools(async (...args) => { calls.push(args); return { previewId: "p1" }; }, (s) => s)
    .find((entry) => entry.name === "collab_image_preview");
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ["to", "prompt", "width", "height"]);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.inputSchema.properties.refs.maxItems, 3);
  for (const prohibited of ["path", "url", "model", "graph", "lora", "apiKey", "negative", "steps", "cfg"])
    assert.equal(Object.hasOwn(tool.inputSchema.properties, prohibited), false, prohibited);
  const result = await tool.run({ to: "ab".repeat(16), prompt: "A dancer", width: 768, height: 1344,
    seed: 31, refs: ["head.png", "hair.webp"] });
  assert.equal(result.previewId, "p1");
  assert.deepEqual(calls, [["POST", "/api/collab", { action: "preview", kind: "image-job", to: "ab".repeat(16),
    image: { prompt: "A dancer", negative: "", width: 768, height: 1344, steps: 25, cfg: 1,
      seed: 31, refs: ["head.png", "hair.webp"] } }]]);
});

test("returned image bytes have a same-origin browser gate before quarantine reads", () => {
  const imageRoute = routeSource.slice(routeSource.indexOf('if (p.startsWith("/api/collab-image/")'),
    routeSource.indexOf('if (p === "/api/collab" && req.method === "POST")'));
  const fetchSiteGate = imageRoute.indexOf('site !== "same-origin"');
  const readPicture = imageRoute.indexOf("await imageQuarantinePicture(");
  assert.ok(fetchSiteGate >= 0 && fetchSiteGate < readPicture,
    "cross-site and headerless requests must be refused before a quarantined PNG is looked up");
  assert.ok(imageRoute.includes('reason: "not-same-origin"'));
  assert.ok(imageRoute.includes('"Content-Type": "image/png"') && imageRoute.includes('"Cache-Control": "no-store"'));
});

test("orders and acceptance summaries omit carried image bytes while consent retains viewable pictures", () => {
  const ordersRoute = routeSource.slice(routeSource.indexOf('if (action === "orders")'),
    routeSource.indexOf('if (action === "inbox")'));
  assert.ok(ordersRoute.includes('references: row.imageJob.job.references.map(({ b64, ...reference }) => reference)'),
    "the incoming and outgoing order lists must not echo large private reference bytes");
  const acceptance = routeSource.slice(routeSource.indexOf('if (action === "image_accept")'),
    routeSource.indexOf('if (action === "image_render")'));
  assert.ok(acceptance.includes('references: imageOrder.job.references.map(({ b64, ...reference }) => reference)'),
    "the acceptance response must keep only reference metadata");
  assert.ok(acceptance.includes('dataUrl: `data:${reference.mime};base64,${reference.b64}`'),
    "the explicit consent card still needs each picture to inspect before accepting");
});

test("image accept binds consent to the current signed file digest before staging references", () => {
  const acceptance = routeSource.slice(routeSource.indexOf('if (action === "image_accept")'),
    routeSource.indexOf('if (action === "image_render")'));
  const digest = acceptance.indexOf('createHash("sha256").update(read.blob).digest("hex")');
  const comparison = acceptance.indexOf('b.expectedDigest !== reviewDigest');
  const stage = acceptance.indexOf('await book.landOrderRow(');
  assert.ok(digest >= 0 && comparison > digest && stage > comparison,
    "a changed signed file must be refused before an order row or references are staged");
  assert.ok(acceptance.includes('reason: "review-changed"'));
  assert.ok(acceptance.includes("pictures, reviewDigest, describes"), "the first review must return the digest to bind the later Yes");
});

test("concurrent image submissions have distinct IDs before output and private prompt bookkeeping", () => {
  const imageRoute = routeSource.slice(routeSource.indexOf('if (p === "/api/image" && req.method === "POST")'),
    routeSource.indexOf('if (p === "/api/images" && req.method !== "POST")'));
  const expression = /const id = ([^\r\n;]+);\s*const file = `image:\$\{id\}`;/.exec(imageRoute)?.[1];
  assert.ok(expression, "the image route must derive the output file key from one ID");
  assert.match(expression, /randomUUID\(\)/, "a millisecond timestamp alone can collide across two Collab jobs");
  assert.ok(imageRoute.includes("pendingImagePrompt.set(file, finalPrompt)"));
  assert.ok(imageRoute.includes("pendingImagePrivate.set(file, true)"));
  const uuids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
  const ids = uuids.map((uuid) => vm.runInNewContext(expression, { randomUUID: () => uuid,
    Date: { now: () => 123456789 } }));
  assert.notEqual(ids[0], ids[1], "two submissions in the same millisecond need separate output keys");
  for (const id of ids) assert.match(id, /^i[a-z0-9]+$/, "IDs must remain safe image file names");
});
