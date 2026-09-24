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


test("movie generation handoff selects the saved scene without preparing or running work", async () => {
  const f=fixture();
  f.node("cbSeed").value="999"; f.node("cbSteps").value="40"; f.node("cbEngineMode").value="ltx";
  await f.run('paintCollab(false, {slug:"episode",segmentId:"closing"})');
  assert.equal(f.node("cbKind").value,"order");assert.equal(f.node("cbSegment").value,"closing");
  for(const id of ["cbSeed","cbSteps","cbEngineMode"])assert.equal(f.node(id).value,"");
  assert.ok(!f.calls.some(c=>["preview","pack","accept","generate_clip"].includes(c.body?.action)));
  assert.equal(f.run('selectCollabScene({slug:"episode",segmentId:"deleted"})'),false);
  assert.equal(f.run('selectCollabScene({slug:"other",segmentId:"closing"})'),false);
});


test("movie handoff overrides a different project selected in Collab", async () => {
  const f=fixture();f.node("cbProject").value="old-project";
  f.context.respond=(url,body)=>url==="/api/mv/projects"?{projects:[{slug:"old-project"},{slug:"episode"}]}:f.defaults(url,body);
  await f.run('paintCollab(false,{slug:"episode",segmentId:"closing"})');
  assert.equal(f.node("cbProject").value,"episode");assert.equal(f.node("cbSegment").value,"closing");assert.equal(f.node("cbKind").value,"order");
});


test("standalone video handoff keeps its recipe separate from movie orders",async()=>{
 const f=fixture(); const video={engine:"ltx",prompt:"Moonlight",width:1280,height:704,seconds:5,steps:8,guidance:3,keepAudio:false,seed:42};
 f.context.recipe=video;await f.run("paintCollab(false,null,recipe)");f.node("cbTo").value=f.peer.fp;
 assert.equal(f.node("cbKind").value,"video-recipe");
 assert.deepEqual(JSON.parse(JSON.stringify(f.run("cbPackRequest()"))),{kind:"video-recipe",to:f.peer.fp,video});
 assert.ok(!f.calls.some(c=>["preview","pack","accept","generate_clip"].includes(c.body?.action)));
});

/* ── LENDING FOR A PERSON WITH NO STRONG CARD ────────────────────────────
 * Every override the door has is one a person can reach from this screen,
 * and every one is a QUESTION: a missing dialog must never read as a yes. */

test("a busy lender accepts from the screen: “Accept anyway” asks, then sends the override", async () => {
  for (const answer of [false, true]) {
    const f = fixture();
    const asked = [];
    f.context.bottomDrawer = async (o) => { asked.push(o); return answer; };
    f.node("cbFile").value = "order.aiplay";
    f.node("cbFileCard").dataset.armed = "order.aiplay";
    f.context.respond = (url, body) => body?.action === "accept"
      ? (body.anyway === true ? { ok: true, note: "Accepted." }
        : { error: "The card is busy. You can still take it.", reason: "engine-busy", overridable: true,
            overrides: [{ reason: "engine-busy", why: "A dance scene is rendering." }, { reason: "budget-zero", why: "You give Friend 0 minutes of your card a day." }] })
      : f.defaults(url, body);
    await f.fire("cbAcceptYes");
    const accepts = f.calls.filter((c) => c.body?.action === "accept");
    assert.equal(asked.length, 1, "one question, naming every override");
    assert.match(asked[0].body, /dance scene.*0 minutes/s);
    assert.equal(asked[0].yes, "Accept anyway");
    assert.deepEqual(accepts.map((c) => c.body.anyway === true), answer ? [false, true] : [false]);
  }
});

test("a refusal that cannot be overridden gets no question and no override", async () => {
  const f = fixture(); let asked = 0;
  f.context.bottomDrawer = async () => { asked++; return true; };
  f.node("cbFile").value = "order.aiplay"; f.node("cbFileCard").dataset.armed = "order.aiplay";
  f.context.respond = (url, body) => body?.action === "accept" ? { error: "The queue is paused.", reason: "art-paused", busy: true, overridable: false } : f.defaults(url, body);
  await f.fire("cbAcceptYes");
  assert.equal(asked, 0);
  assert.equal(f.calls.filter((c) => c.body?.action === "accept").length, 1);
  assert.match(f.node("cbSay").textContent, /paused/);
});

test("with no dialog at all, “Accept anyway” is a no, never a silent yes", async () => {
  const f = fixture();
  f.node("cbFile").value = "order.aiplay"; f.node("cbFileCard").dataset.armed = "order.aiplay";
  f.context.respond = (url, body) => body?.action === "accept" ? { error: "busy", reason: "engine-busy", overridable: true, overrides: [{ reason: "engine-busy", why: "busy" }] } : f.defaults(url, body);
  await f.fire("cbAcceptYes");
  assert.ok(!f.calls.some((c) => c.body?.anyway === true));
});

test("the order card shows the speed-up file and the minutes BEFORE the yes", async () => {
  const f = fixture();
  f.node("cbFile").value = "order.aiplay";
  f.context.respond = (url, body) => body?.action === "accept" ? {
    reason: "not-seen", error: "Read it first.", prompt: "A dancer", describes: "One scene", pictures: [],
    speedUp: "This scene asks for 8 steps, and the speed-up file this PC has for it is made for 4 steps.",
    minutes: "Friend may use 60 minutes of your card a day.", overBudget: false,
  } : f.defaults(url, body);
  await f.fire("cbAcceptBtn");
  assert.match(f.node("cbOrderPrompt").innerHTML, /made for 4 steps/);
  assert.match(f.node("cbOrderPrompt").innerHTML, /60 minutes of your card a day/);
});

test("a take that failed its checks can be watched and kept anyway, only after playing it and saying yes", async () => {
  const f = fixture();
  const take = { from: "ab".repeat(16), file: `peer_${"ab".repeat(4)}_${"c".repeat(12)}.mp4`, segmentId: "s1_0", ok: false,
    reason: "result-not-the-shot", why: "This clip is 96 frames and the scene wants about 107.", notes: ["Rendered without the song under it."], adopted: false };
  f.context.respond = (url, body) => body?.action === "quarantine" ? { takes: [take] } : body?.action === "adopt" ? { ok: true, note: "Filed." } : f.defaults(url, body);
  await f.run("paintTakes()");
  const markup = f.node("cbTakes").innerHTML;
  assert.match(markup, new RegExp(`<video[^>]*src="/api/collab-take/${take.from}/${take.file}"`), "the take can be watched here");
  assert.match(markup, /class="btn sm cbadoptany"[^>]*>Keep anyway…/);
  assert.doesNotMatch(markup, /cbadopt"/, "a refused take has no plain Keep");
  assert.match(markup, /Rendered without the song under it/);
  const asked = [];
  f.context.bottomDrawer = async (o) => { asked.push(o); return true; };
  const row = { dataset: { from: take.from, file: take.file }, querySelector: () => ({ textContent: take.why }) };
  const press = () => f.node("cbTakes").handlers.click({ target: { classList: { contains: (c) => c === "cbadoptany" }, closest: () => row } });
  await press();
  assert.equal(asked.length, 0, "not asked before it has been played");
  assert.ok(!f.calls.some((c) => c.body?.action === "adopt"));
  assert.match(f.node("cbSay").textContent, /Play it first/);
  /* Pressing play is not watching: only frames on screen ("playing") count. */
  assert.equal(f.node("cbTakes").handlers.play, undefined, "a pressed play button alone does not mark a take watched");
  f.node("cbTakes").handlers.playing({ target: { closest: () => row } });
  await press();
  assert.equal(asked.length, 1);
  assert.match(asked[0].body, /96 frames/);
  assert.deepEqual(f.calls.find((c) => c.body?.action === "adopt").body, { action: "adopt", from: take.from, file: take.file, anyway: true });
});

test("a take that passed keeps its plain Keep, which sends no override", async () => {
  const f = fixture();
  const take = { from: "ab".repeat(16), file: `peer_${"ab".repeat(4)}_${"d".repeat(12)}.mp4`, segmentId: "s1_0", ok: true, why: "ok", adopted: false };
  f.context.respond = (url, body) => body?.action === "quarantine" ? { takes: [take] } : body?.action === "adopt" ? { ok: true } : f.defaults(url, body);
  await f.run("paintTakes()");
  assert.match(f.node("cbTakes").innerHTML, /cbadopt"[^>]*>Keep it/);
  const row = { dataset: { from: take.from, file: take.file } };
  await f.node("cbTakes").handlers.click({ target: { classList: { contains: (c) => c === "cbadopt" }, closest: () => row } });
  assert.deepEqual(f.calls.find((c) => c.body?.action === "adopt").body, { action: "adopt", from: take.from, file: take.file });
});

test("an accepted errand opens its plan in Workflow, on its own project", async () => {
  const f = fixture();
  const events = [], views = [];
  f.context.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  f.context.document = { dispatchEvent: (e) => { events.push(e); return true; } };
  f.context.setView = (v) => views.push(v);
  f.context.respond = (url, body) => body?.action === "orders" && body.side === "in"
    ? { orders: [{ id: "o_0123456789ab", slug: "order-o-01234567-from-friend", from: { nickname: "Friend" }, order: { segmentId: "s1_0", seed: 1, steps: 8, engineMode: "h3" }, state: "landed" }] }
    : f.defaults(url, body);
  await f.run("paintErrands()");
  assert.match(f.node("cbErrands").innerHTML, /cbopenplan[^>]*>Open its plan in Workflow/);
  const row = { dataset: { slug: "order-o-01234567-from-friend", id: "o_0123456789ab" } };
  await f.node("cbErrands").handlers.click({ target: { classList: { contains: (c) => c === "cbopenplan" }, closest: () => row } });
  assert.deepEqual(events.map((e) => [e.type, e.detail.slug]), [["aiplay:open-project", "order-o-01234567-from-friend"]]);
  assert.deepEqual(views, ["workflow"]);
  assert.ok(!f.calls.some((c) => ["send_back", "accept"].includes(c.body?.action)), "opening the plan approves and sends nothing");
});

test("the lender's role reads the right way round and the stored value is unchanged", async () => {
  const f = fixture(); await f.run("paintPeers()");
  const markup = f.node("cbPeers").innerHTML;
  assert.match(markup, /<option value="lender" selected>lending friend: we render single scenes for each other<\/option>/);
  assert.doesNotMatch(markup, /may render single scenes for me/);
  assert.match(markup, /Minutes of my card per day/);
  assert.doesNotMatch(f.node("cbPeersNote").textContent, /advisory, not enforced/);
});

test("the Workflow view listens for the project Collab asks it to open", () => {
  const mv = readFileSync(new URL("../../web/mv.js", import.meta.url), "utf8");
  assert.match(mv, /addEventListener\("aiplay:open-project", \(e\) => \{[\s\S]{0,200}wf\.slug = slug;/);
  assert.match(source, /if \(name === "workflow"\) wfOpen\(\);/, "the view change is what loads it");
});

test("each Ask friend names the other: Video's is text only, Workflow's carries the pictures", () => {
  const mv = readFileSync(new URL("../../web/mv.js", import.meta.url), "utf8");
  assert.match(html, /id="vidAskFriend" title="[^"]*Music video → Video clips → Ask friend, which carries them/);
  /* The page's own sentences name the screen by the rail's label (cbScreen),
   * typeof-guarded because vidPaint and videoFriendRecipe are lifted alone. */
  assert.match(source, /use \$\{typeof cbScreen === "function" \? cbScreen\("workflow", "Workflow"\) : "Workflow"\} → Video clips → Ask friend, which carries them\.`\);/);
  assert.match(source, /const wfName = typeof cbScreen === "function" \? cbScreen\("workflow", "Workflow"\) : "Workflow";/);
  assert.match(mv, /data-friendclip="[^"]*" title="[^"]*carries the scene's reference pictures[^"]*Video → Ask friend/);
});

/* ── THE REVIEW'S FINDINGS, PINNED ──────────────────────────────────────── */

test("the take list fetches nothing until somebody presses play on one take", async () => {
  const f = fixture();
  const take = { from: "ab".repeat(16), file: `peer_${"ab".repeat(4)}_${"e".repeat(12)}.mp4`, segmentId: "s1_0", ok: false, reason: "result-not-the-shot", why: "x", adopted: false };
  f.context.respond = (url, body) => body?.action === "quarantine" ? { takes: [take] } : f.defaults(url, body);
  await f.run("paintTakes()");
  assert.match(f.node("cbTakes").innerHTML, /<video[^>]*preload="none"/);
  assert.doesNotMatch(f.node("cbTakes").innerHTML, /preload="metadata"|preload="auto"/);
});

test("a take this browser cannot play can still be kept — unseen, after a question that says so", async () => {
  for (const how of ["error-event", "probe-failed"]) {
    const f = fixture();
    const take = { from: "ab".repeat(16), file: `peer_${"ab".repeat(4)}_${"f".repeat(12)}.mkv`, segmentId: "s1_0", ok: false,
      reason: how === "probe-failed" ? "probe-failed" : "result-not-the-shot", why: "It could not be measured.", adopted: false };
    f.context.respond = (url, body) => body?.action === "quarantine" ? { takes: [take] } : body?.action === "adopt" ? { ok: true } : f.defaults(url, body);
    await f.run("paintTakes()");
    assert.match(f.node("cbTakes").innerHTML, new RegExp(`data-reason="${take.reason}"`));
    const asked = [];
    f.context.bottomDrawer = async (o) => { asked.push(o); return true; };
    const row = { dataset: { from: take.from, file: take.file, reason: take.reason }, querySelector: () => ({ textContent: take.why }) };
    if (how === "error-event") {
      f.node("cbTakes").handlers.error({ target: { tagName: "VIDEO", closest: () => row } });
      assert.equal(row.dataset.unplayable, "1");
      assert.match(f.node("cbSay").textContent, /cannot play that take.*keep it unseen/);
    }
    await f.node("cbTakes").handlers.click({ target: { classList: { contains: (c) => c === "cbadoptany" }, closest: () => row } });
    assert.equal(asked.length, 1, `${how}: asked, not told to play a take that cannot play`);
    assert.equal(asked[0].title, "Keep a take you have not watched?");
    assert.equal(asked[0].yes, "Keep it unseen");
    assert.match(asked[0].body, /cannot be played here, so you would be keeping it unseen/);
    assert.deepEqual(f.calls.find((c) => c.body?.action === "adopt").body, { action: "adopt", from: take.from, file: take.file, anyway: true });
  }
});

test("after “Not now”, the page says what to press — never a button that is not on the screen", async () => {
  const f = fixture();
  f.context.bottomDrawer = async () => false;
  f.node("cbFile").value = "order.aiplay"; f.node("cbFileCard").dataset.armed = "order.aiplay";
  f.context.respond = (url, body) => body?.action === "accept"
    ? { error: "SERVER TEXT FOR TOOLS", reason: "budget-zero", overridable: true, overrides: [{ reason: "budget-zero", why: "You give Friend 0 minutes of your card a day." }] }
    : f.defaults(url, body);
  await f.fire("cbAcceptYes");
  const said = f.node("cbSay").textContent;
  assert.doesNotMatch(said, /SERVER TEXT FOR TOOLS/);
  assert.match(said, /^Not accepted\. You give Friend 0 minutes.*Press “Yes — take the job” again/);
  assert.equal(f.node("cbFileCard").dataset.armed, "order.aiplay", "the card stays armed, so pressing again asks again");
});

test("the Friends row shows what a friend used today, and warns when a lending friend has 0 minutes", async () => {
  const f = fixture();
  f.context.respond = (url, body) => body?.action === "roster"
    ? { peers: [
      { ...f.peer, lendMinutesPerDay: 60, usedToday: { said: "12 min timed on this card today", measuredMinutes: 12, pending: 0 } },
      { fp: "cd".repeat(16), nickname: "Zero", verified: true, role: "collaborator", lendMinutesPerDay: 0, usedToday: { said: "nothing rendered for them yet today" } },
      { fp: "ef".repeat(16), nickname: "Nobody", verified: true, role: "none", lendMinutesPerDay: 0 },
    ] }
    : f.defaults(url, body);
  await f.run("paintPeers()");
  const markup = f.node("cbPeers").innerHTML;
  assert.match(markup, /Used today: 12 min timed on this card today/);
  assert.equal((markup.match(/0 minutes: every scene they send asks you first/g) || []).length, 1, "the collaborator at 0, not the friend with no role");
});

test("every screen the Collab page names is the rail's own label, read when it paints", async () => {
  const f = fixture();
  const filled = [{ dataset: { screen: "workflow" }, textContent: "Workflow" }];
  f.context.document = {
    querySelector: (q) => (q === '[data-view="workflow"] .lbl' ? { textContent: " Music video " } : null),
    querySelectorAll: (q) => (q === "[data-screen]" ? filled : []),
    dispatchEvent: () => true,
  };
  f.context.respond = (url, body) => body?.action === "orders" && body.side === "in"
    ? { orders: [{ id: "o_0123456789ab", slug: "order-x", from: { nickname: "Friend" }, order: { segmentId: "s1_0", seed: 1, steps: 8, engineMode: "h3" }, state: "landed" }] }
    : f.defaults(url, body);
  await f.run("paintErrands()");
  assert.match(f.node("cbErrands").innerHTML, /cbopenplan[^>]*title="Music video → this project[^>]*>Open its plan in Music video</);
  await f.run("refreshCollab()");
  assert.equal(filled[0].textContent, "Music video", "the static hints follow the rail too");
  assert.match(html, /<b data-screen="workflow">Workflow<\/b> &rarr; the &ldquo;Order/);
  /* No rail (a page without one): the fallback, never an empty name. */
  const bare = fixture();
  assert.equal(bare.run('cbScreen("workflow", "Workflow")'), "Workflow");
});
