import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
const collab = source.slice(source.indexOf("const cb = (body)"), source.indexOf("function paintExtend(t)"));
const html = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");

function fixture() {
  const nodes = new Map(), calls = [];
  const node = (id) => {
    if (!nodes.has(id)) {
      const n = { value: "", textContent: "", hidden: false, disabled: false, dataset: {}, handlers: {}, inputs: [],
        addEventListener(event, handler) { this.handlers[event] = handler; },
        setAttribute() {}, scrollIntoView() {}, classList: { add() {}, remove() {} },
        querySelectorAll(q) { return q === "input:checked" ? this.inputs.filter((x) => x.checked) : q === 'input[type="checkbox"]' ? this.inputs.filter((x) => x.type === "checkbox") : q === "[data-rate]" ? this.inputs.filter((x) => x.dataset?.rate) : []; },
        querySelector(q) { return q === "input" ? this.inputs[0] || null : null; },
        set innerHTML(s) {
          this.markup = s;
          this.inputs = [...s.matchAll(/<input\b([^>]+)>/g)].map((m) => ({ type: /type="([^"]*)"/.exec(m[1])?.[1], dataset: { rate: /data-rate="([^"]*)"/.exec(m[1])?.[1] }, value: /value="([^"]*)"/.exec(m[1])?.[1] || "", checked: /\bchecked\b/.test(m[1]), disabled: /\bdisabled\b/.test(m[1]) }));
          const options = [...s.matchAll(/<option\b[^>]*value="([^"]*)"/g)];
          if (options.length) this.value = options[0][1];
        },
        get innerHTML() { return this.markup || ""; },
      };
      nodes.set(id, n);
    }
    return nodes.get(id);
  };
  const peer = { fp: "abc123", nickname: "Friend", verified: true, role: "lender" };
  const doc = { segments: [{ id: "opening", title: "The arrival", mode: "generate", durationSec: 5 }, { id: "closing", mode: "generate", durationSec: 4 }] };
  const plan = { slug: "episode", revision: 0, notes: "", shots: doc.segments.map((s) => ({ segmentId: s.id, title: s.title || s.id, seconds: s.durationSec, stage: "storyboard", owner: null, pinned: false, reviewNote: "" })) };
  const defaults = (url, body) => {
    if (url === "/api/mv/projects") return { projects: [{ slug: "episode", title: "Episode" }] };
    if (url === "/api/mv/project/episode") return { project: doc };
    if (url === "/api/collab/plan?slug=episode") return { ok: true, plan };
    if (body?.action === "roster") return { peers: [peer] };
    if (body?.action === "me") return { fp: "local", words: [], card: "key" };
    return { items: [], orders: [], takes: [] };
  };
  const context = vm.createContext({
    $: node, esc: (v) => String(v ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;"),
    state: { collabProtocol: 1 }, localStorage: { getItem() { return ""; }, setItem() {} },
    navigator: {}, CSS: { escape: (s) => s }, matchMedia: () => ({ matches: true }), setTimeout() {},
    respond: defaults,
    fetch: async (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : null;
      calls.push({ url, body });
      const result = await context.respond(url, body);
      return { json: async () => result };
    },
  });
  node("cbKind").value = "shot"; node("cbDraftPolicy").value = "equal";
  vm.runInContext(collab, context);
  return { node, calls, context, defaults, peer, doc, plan, run: (code) => vm.runInContext(code, context), fire: (id, event = "click") => node(id).handlers[event]?.({ target: node(id) }) };
}

test("initial and return visits load real flat scenes and refresh the selected project", async () => {
  const f = fixture();
  await f.run("paintCollab()");
  assert.match(f.node("cbSegment").innerHTML, /opening.*The arrival/);
  assert.equal(f.node("cbSegment").disabled, false);
  f.node("cbSegment").value = "closing";
  await f.run("paintCollab()");
  assert.equal(f.node("cbSegment").value, "closing");
  assert.equal(f.calls.filter((c) => c.url === "/api/mv/project/episode").length, 2);
  assert.ok(!f.calls.some((c) => c.url.startsWith("/api/mv/project?slug=")));
  assert.match(html, /<select id="cbSegment"/);
});

test("scene refresh failures preserve displayed scenes while preventing preview", async () => {
  const f = fixture(); await f.run("paintCollab()");
  const before = f.node("cbSegment").innerHTML;
  f.context.respond = (url, body) => url.includes("/project/") ? { error: "disk unavailable" } : f.defaults(url, body);
  await f.run("loadCollabScenes()");
  assert.equal(f.node("cbSegment").innerHTML, before);
  assert.equal(f.node("cbSegment").disabled, true);
  await f.fire("cbPreview");
  assert.ok(!f.calls.some((c) => c.body?.action === "preview"));
});

test("verified friends without a role can receive resources and received cards can be saved", async () => {
  const f = fixture(), card = { kind: "resources", v: 1, gpu: { name: "Example GPU", vramMb: 16384 }, ready: ["videoExample"] };
  f.peer.role = "none"; await f.run("paintPeers()");
  assert.equal(f.node("cbPreview").disabled, true);
  f.node("cbKind").value = "resources"; f.run("paintCbKind()");
  assert.equal(f.node("cbTo").value, f.peer.fp);
  assert.equal(f.node("cbPreview").disabled, false);
  f.context.respond = (url, body) => body?.action === "open" ? { file: "card.aiplay", kind: "resources", from: f.peer, packet: card } : f.defaults(url, body);
  await f.run('openCollabFile("card.aiplay")');
  assert.equal(f.node("cbSaveResources").hidden, false);
  await f.fire("cbSaveResources");
  const saved = f.calls.find((c) => c.body?.action === "set_resources");
  assert.deepEqual(saved.body, { action: "set_resources", fp: f.peer.fp, resources: card });
});

test("reviewed preview token is required for prepare and changing inputs disarms it", async () => {
  const f = fixture(); await f.run("paintCollab()");
  f.context.respond = (url, body) => body?.action === "preview" ? {
    previewId: "frozen-1", kind: "shot", to: f.peer, packet: { segmentId: "opening", prompt: "Exact resolved prompt", width: 1280, height: 720 },
    manifest: [{ file: "reference.png", bytes: 123, included: false }],
  } : body?.action === "pack" ? { file: "prepared.aiplay", describes: "One scene", bytes: 99 } : f.defaults(url, body);
  await f.fire("cbPreview");
  assert.equal(f.node("cbPreviewPrompt").textContent, "Exact resolved prompt");
  assert.match(f.node("cbPreviewManifest").innerHTML, /manifest only/);
  assert.equal(f.node("cbPack").disabled, false);
  await f.fire("cbPack");
  assert.deepEqual(f.calls.find((c) => c.body?.action === "pack").body, { action: "pack", previewId: "frozen-1" });
  assert.match(f.node("cbPackNote").textContent, /Prepared/);
  await f.fire("cbPreview"); f.node("cbSegment").value = "closing"; await f.fire("cbSegment", "change");
  assert.equal(f.node("cbPack").disabled, true);
  await f.fire("cbPack");
  assert.equal(f.calls.filter((c) => c.body?.action === "pack").length, 1);
});

test("scene review previews distinguish metadata from render orders and show only safe picture assets", async () => {
  const f = fixture(); await f.run("paintCollab()");
  f.context.respond = (url, body) => body?.action === "preview" ? {
    previewId: "scene-review", kind: body.kind, to: f.peer,
    packet: body.kind === "shot" ? { segmentId: "opening", prompt: "Review this scene" }
      : { shot: { segmentId: "opening", prompt: "Render this scene" }, order: { seed: 42, steps: 8 } },
    manifest: [{ file: "reference image.png", bytes: 123, included: body.kind === "order" },
      { file: "../private.png", included: true }, { file: "scene.mp4", included: false }],
  } : f.defaults(url, body);
  await f.fire("cbPreview");
  assert.match(f.node("cbPreviewSettings").textContent, /metadata for review · no render request/);
  assert.match(f.node("cbPreviewSettings").textContent, /seed not assigned/);
  assert.match(f.node("cbPreviewPictures").innerHTML, /\/api\/mv\/asset\/episode\/reference%20image\.png/);
  assert.match(f.node("cbPreviewPictures").innerHTML, /Preview only · picture bytes not included/);
  assert.doesNotMatch(f.node("cbPreviewPictures").innerHTML, /private\.png|scene\.mp4|Included picture/);
  f.node("cbKind").value = "order"; f.run("paintCbKind()"); await f.fire("cbPreview");
  assert.match(f.node("cbPreviewSettings").textContent, /Render request · friend must accept/);
  assert.match(f.node("cbPreviewSettings").textContent, /seed 42/);
  assert.match(f.node("cbPreviewPictures").innerHTML, /Included picture/);
  assert.doesNotMatch(f.node("cbPreviewPictures").innerHTML, /Preview only/);
});

test("late preview response cannot arm changed inputs", async () => {
  const f = fixture(); await f.run("paintCollab()"); let finish;
  f.context.respond = (url, body) => body?.action === "preview" ? new Promise((resolve) => { finish = resolve; }) : f.defaults(url, body);
  const waiting = f.fire("cbPreview");
  f.node("cbSegment").value = "closing"; await f.fire("cbSegment", "change");
  finish({ previewId: "old", packet: {} }); await waiting;
  assert.equal(f.node("cbPack").disabled, true);
  assert.equal(f.node("cbOutgoingPreview").hidden, true);
});

test("equal allocation covers 47 clips once across 10 peers; capability mode excludes stale and incompatible cards", () => {
  const f = fixture();
  const result = f.run(`(() => {
    const peers = Array.from({length:10}, (_,i) => ({fp:String(i),verified:true,role:'lender',resources:{at:100000000,gpu:{vramMb:16384},ready:['videoExample']}}));
    const scenes = Array.from({length:47}, (_,i) => 'scene-'+i);
    const equal = cbAllocateDraft(peers,scenes);
    peers[0].resources.at = 1;
    peers[1].resources.ready = [];
    peers[2].resources.gpu.vramMb = 8192;
    peers[3].resources.at = 100000001;
    const matched = cbAllocateDraft(peers,scenes,{policy:'capability',capability:'videoExample',minVramMb:12288,now:100000000});
    return {counts:equal.assignments.map(x=>x.scenes.length),unique:new Set(equal.assignments.flatMap(x=>x.scenes)).size,matched:matched.assignments.length,excluded:matched.excluded.length};
  })()`);
  assert.equal(result.unique, 47);
  assert.equal(Math.max(...result.counts) - Math.min(...result.counts), 1);
  assert.equal(result.matched, 6); assert.equal(result.excluded, 4);
});

test("all list failures keep previous rows and expose the failure", async () => {
  const f = fixture();
  for (const [id, fn] of [["cbPeers", "paintPeers"], ["cbInbox", "paintInbox"], ["cbOutbox", "paintOutbox"], ["cbErrands", "paintErrands"], ["cbTakes", "paintTakes"]]) {
    f.node(id).innerHTML = "previous rows";
    f.context.respond = () => ({ error: "storage unavailable" });
    await f.run(`${fn}()`);
    assert.equal(f.node(id).innerHTML, "previous rows");
    assert.match(f.node("cbSay").textContent, /storage unavailable/);
  }
});

test("scene plan edits carry the displayed revision and errors preserve the review text", async () => {
  const f = fixture(); await f.run("paintCollab()");
  assert.match(f.node("cbPlanBoard").innerHTML, /Approved locally/);
  f.node("cbShotStage").value = "review"; f.node("cbShotOwner").value = f.peer.fp;
  f.node("cbShotReview").value = "The ending needs a new take"; f.node("cbShotPin").checked = true;
  f.context.respond = (url, body) => url === "/api/collab/plan" ? { error: "This plan changed. Reload it." } : f.defaults(url, body);
  await f.fire("cbShotSave");
  const call = f.calls.find((c) => c.body?.action === "update_shot");
  assert.equal(call.body.expectedRevision, 0); assert.equal(call.body.segmentId, "opening");
  assert.equal(call.body.pinned, true); assert.equal(call.body.stage, "review");
  assert.equal(f.node("cbShotReview").value, "The ending needs a new take");
  assert.match(f.node("cbSay").textContent, /Reload/);
  assert.ok(!f.calls.some((c) => ["pack", "accept"].includes(c.body?.action)));
});

test("allocation preview uses the server's pinned result and does not apply or save it", async () => {
  const f = fixture(); await f.run("paintCollab()");
  f.node("cbDraftPeers").inputs = [{ checked: true, value: f.peer.fp }];
  f.node("cbDraftScenes").inputs = [{ checked: true, value: "opening" }];
  f.context.respond = (url, body) => body?.action === "preview_allocation" ? { ok: true, previewOnly: true, plan: { ...f.plan,
    draft: { assignments: [{ fp: f.peer.fp, nickname: "Pinned owner", segmentIds: ["opening"], estimatedMinutes: null }], excluded: [], unassigned: [] } } } : f.defaults(url, body);
  await f.fire("cbDraftPreview");
  assert.match(f.node("cbDraftResult").innerHTML, /Pinned owner.*The arrival/s);
  assert.match(f.node("cbDraftSummary").textContent, /Unsaved preview/);
  assert.equal(f.node("cbDraftSaved").hidden, true);
  assert.ok(!f.calls.some((c) => ["allocate", "apply_draft", "pack"].includes(c.body?.action)));
});

test("saving one plan section preserves unsaved edits in the other", async () => {
  const f = fixture(); await f.run("paintCollab()");
  f.context.respond = (url, body) => {
    if (url !== "/api/collab/plan") return f.defaults(url, body);
    if (body.action === "update_episode") f.plan.notes = body.notes;
    if (body.action === "update_shot") Object.assign(f.plan.shots.find((s) => s.segmentId === body.segmentId), body);
    f.plan.revision++;
    return { ok: true, plan: structuredClone(f.plan) };
  };
  f.node("cbPlanNotes").value = "Episode note not saved yet";
  f.node("cbShotReview").value = "Save this review";
  await f.fire("cbShotSave");
  assert.equal(f.node("cbPlanNotes").value, "Episode note not saved yet");
  f.node("cbShotReview").value = "Another review not saved yet";
  await f.fire("cbPlanSaveNotes");
  assert.equal(f.node("cbShotReview").value, "Another review not saved yet");
  assert.equal(f.node("cbPlanNotes").value, "Episode note not saved yet");
});

test("switching projects during a save loads the newly selected board after the write settles", async () => {
  const f = fixture(); await f.run("paintCollab()"); let finish;
  const other = { slug: "other", revision: 0, notes: "Other episode", shots: [{ segmentId: "other-shot", title: "Other shot", seconds: 3, stage: "ready", owner: null, reviewNote: "" }] };
  f.context.respond = (url, body) => url === "/api/collab/plan" ? new Promise((resolve) => { finish = resolve; })
    : url === "/api/mv/project/other" ? { project: { segments: [{ id: "other-shot" }] } }
      : url === "/api/collab/plan?slug=other" ? { ok: true, plan: other } : f.defaults(url, body);
  const saving = f.fire("cbShotSave");
  f.node("cbProject").value = "other"; await f.run("loadCollabScenes()");
  finish({ ok: true, plan: { ...f.plan, revision: 1 } }); await saving;
  assert.match(f.node("cbPlanBoard").innerHTML, /Other shot/);
  assert.doesNotMatch(f.node("cbPlanBoard").innerHTML, /The arrival/);
  assert.equal(f.node("cbPlanNotes").value, "Other episode");
  assert.equal(f.calls.filter((c) => c.body?.action === "update_shot").length, 1);
});

test("untitled scenes use an existing storyboard action or lyric snippet, retaining the exact ID separately", async () => {
  const f = fixture();
  f.doc.boards = [{ segmentId: "closing", shots: [{ action: "A figure opens the red door" }] }];
  await f.run("paintCollab()");
  assert.match(f.node("cbPlanBoard").innerHTML, /<b>A figure opens the red door<\/b><small>closing/);
  assert.doesNotMatch(f.node("cbPlanBoard").innerHTML, /<b>closing<\/b>/);
  assert.match(f.node("cbSegment").innerHTML, /closing · A figure opens the red door/);
  assert.equal(f.plan.shots[1].title, "closing"); // Display fallback never changes the saved plan or project.
});

test("planning displays escaped request history separately from the saved stage and opens returns read-only", async () => {
  const f = fixture();
  const delivery = { observedAt: Date.now(), counts: { prepared: 1, returned: 0, adopted: 0, refused: 0, expired: 0, unknown: 0 }, unmatchedOrders: [],
    scenes: [{ segmentId: "opening", orders: [{ id: "o_000000000001", to: { nickname: "<img src=x>" }, status: "prepared", label: "Package prepared", nextStep: "Transfer the file", preparedAt: Date.now(), note: "<script>bad()</script>" }] }] };
  f.context.respond = (url, body) => url === "/api/collab/plan?slug=episode" ? { ok: true, plan: f.plan, delivery } : f.defaults(url, body);
  await f.run("paintCollab()");
  assert.match(f.node("cbPlanBoard").innerHTML, /1 request · latest: Package prepared/);
  assert.match(f.node("cbShotOrders").innerHTML, /&lt;img/);
  assert.doesNotMatch(f.node("cbShotOrders").innerHTML, /<script>|<img/);
  assert.equal(f.node("cbShotStage").value, "storyboard");
  await f.fire("cbShotReturns");
  assert.equal(f.node("cbPaneIn").hidden, false);
  assert.ok(f.calls.some((call) => call.body?.action === "quarantine"));
  assert.ok(!f.calls.some((call) => ["pack", "adopt", "accept", "update_shot"].includes(call.body?.action)));
});

test("prepare render request uses the planned scene and eligible owner without packing or retaining another recipient", async () => {
  const f = fixture(); f.plan.shots[0].owner = f.peer.fp;
  await f.run("paintCollab()"); await f.fire("cbShotOrder");
  assert.equal(f.node("cbKind").value, "order"); assert.equal(f.node("cbSegment").value, "opening");
  assert.equal(f.node("cbTo").value, f.peer.fp);
  f.plan.shots[0].owner = "removed-friend";
  await f.fire("cbShotOrder");
  assert.equal(f.node("cbTo").value, "");
  assert.equal(f.node("cbPack").disabled, true);
  assert.ok(!f.calls.some((call) => ["pack", "accept"].includes(call.body?.action)));
});
