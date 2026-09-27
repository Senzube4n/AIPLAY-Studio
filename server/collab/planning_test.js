import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { allocatePlan, createCollabPlanning, createCollabPlanningRoutes, planHandoffs, projectOrderProgress } from "./planning.js";
import { listOrders, rememberOrder, setOrderState, noteReturn } from "./orderbook.js";

const now = 10_000_000;
const peers = (n = 10) => Array.from({ length: n }, (_, i) => ({ fp: String(i).padStart(32, "0"), nickname: `Peer ${i}`, verified: true, role: "lender", resources: { at: now, ready: ["videoH3"], gpu: { vramMb: 16384 } } }));
const shots = (n = 47) => Array.from({ length: n }, (_, i) => ({ segmentId: `s${i}`, seconds: 10, pinned: false, owner: null }));
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "collab-plan-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const doc = { title: "Episode", segments: shots(4).map((s) => ({ id: s.segmentId, durationSec: 10, mode: "generate" })) };
  const roster = peers(2);
  const deps = { appData: dir, readProject: async (slug) => slug === "episode" ? doc : null, readPeers: async () => ({ peers: roster }), now: () => now };
  return { dir, doc, roster, deps, store: createCollabPlanning(deps) };
}

test("reading is side-effect free; shot stage, owner and review persist without changing MV documents", async (t) => {
  const f = await fixture(t), before = structuredClone(f.doc);
  let r = await f.store.get("episode"); assert.equal(r.plan.revision, 0); assert.equal(r.plan.shots[0].seconds, 10);
  await assert.rejects(stat(path.join(f.dir, "collab")), { code: "ENOENT" });
  r = await f.store.mutate({ action: "update_shot", slug: "episode", expectedRevision: 0, segmentId: "s0", stage: "review", owner: "self", reviewNote: "Check lip sync", pinned: true }, "agent:test");
  assert.equal(r.plan.revision, 1); assert.equal(r.plan.shots[0].changedBy, "agent:test");
  const restored = await createCollabPlanning(f.deps).get("episode");
  assert.equal(restored.plan.shots[0].reviewNote, "Check lip sync"); assert.equal(restored.plan.shots[0].stage, "review");
  assert.deepEqual(f.doc, before);
});

test("revision checks serialize concurrent changes and reject stale writes", async (t) => {
  const { store } = await fixture(t);
  const body = { action: "update_episode", slug: "episode", expectedRevision: 0 };
  const results = await Promise.allSettled([store.mutate({ ...body, notes: "A" }), store.mutate({ ...body, notes: "B" })]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.status, 409);
  assert.equal((await store.get("episode")).plan.revision, 1);
});

test("equal allocation covers 47 scenes once across ten friends and preserves pinned owners", () => {
  const p = peers(), s = shots(); s[0].pinned = true; s[0].owner = p[8].fp;
  const r = allocatePlan({ shots: s, peers: p, segmentIds: s.map((s) => s.segmentId), peerIds: p.map((p) => p.fp), now });
  assert.equal(new Set(r.assignments.flatMap((r) => r.segmentIds)).size, 47);
  const counts = r.assignments.map((r) => r.segmentIds.length); assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
  assert.ok(r.assignments.find((r) => r.fp === p[8].fp).segmentIds.includes("s0"));
  assert.equal(r.availability, "unknown"); assert.equal(r.delivery, "not prepared");
});

test("time balancing uses entered rates and actual duration; stale or incompatible peers are excluded", () => {
  const p = peers(4), s = shots(6); s[0].seconds = 30;
  p[2].resources.at = now - 86400001; p[3].resources.ready = [];
  const r = allocatePlan({ shots: s, peers: p, segmentIds: s.map((s) => s.segmentId), peerIds: p.map((p) => p.fp), policy: "time", capability: "videoH3", minVramMb: 12000,
    minutesPerTenSeconds: { [p[0].fp]: 1, [p[1].fp]: 3, [p[2].fp]: 0.1, [p[3].fp]: 0.1 }, now });
  assert.equal(r.excluded.length, 2); assert.equal(r.unassigned.length, 0);
  assert.ok(r.assignments[0].segmentIds.length > r.assignments[1].segmentIds.length);
  assert.match(r.estimateSource, /user-entered/);
  assert.throws(() => allocatePlan({ shots: s, peers: p, segmentIds: ["s0", "s0"], peerIds: [p[0].fp] }), /distinct/);
});

test("saved draft survives reload, changes local owners only, and rechecks permissions before apply", async (t) => {
  const f = await fixture(t), body = { action: "allocate", slug: "episode", expectedRevision: 0, segmentIds: ["s0", "s1"], peerIds: f.roster.map((p) => p.fp), policy: "equal" };
  await f.store.mutate(body);
  let r = await createCollabPlanning(f.deps).get("episode"); assert.equal(r.plan.draft.assignments.length, 2); assert.equal(r.plan.shots[0].owner, null);
  f.roster[0].verified = false;
  await assert.rejects(f.store.mutate({ action: "apply_draft", slug: "episode", expectedRevision: 1 }), /changed/);
  f.roster[0].verified = true;
  r = await f.store.mutate({ action: "apply_draft", slug: "episode", expectedRevision: 1 });
  assert.equal(r.plan.shots[0].stage, "assigned"); assert.equal(r.plan.draft.appliedAt, now);
  assert.equal(f.doc.segments[0].owner, undefined);
  await assert.rejects(f.store.mutate({ action: "apply_draft", slug: "episode", expectedRevision: 2 }), /already applied/);
});

test("allocation preview respects pinned owners without writing or incrementing the saved revision", async (t) => {
  const f = await fixture(t);
  await f.store.mutate({ action: "update_shot", slug: "episode", expectedRevision: 0, segmentId: "s0", owner: f.roster[1].fp, pinned: true });
  const before = await readFile(path.join(f.dir, "collab/plans/episode.json"), "utf8");
  const r = await f.store.mutate({ action: "preview_allocation", slug: "episode", expectedRevision: 1, segmentIds: ["s0", "s1"], peerIds: f.roster.map((p) => p.fp), policy: "equal" });
  assert.equal(r.previewOnly, true); assert.equal(r.plan.revision, 1);
  assert.ok(r.plan.draft.assignments.find((row) => row.fp === f.roster[1].fp).segmentIds.includes("s0"));
  assert.equal(await readFile(path.join(f.dir, "collab/plans/episode.json"), "utf8"), before);
  assert.equal((await f.store.get("episode")).plan.draft, null);
});

test("dependencies reject cycles, scene changes invalidate draft, and traversal is refused", async (t) => {
  const f = await fixture(t);
  await f.store.mutate({ action: "update_shot", slug: "episode", expectedRevision: 0, segmentId: "s0", dependsOn: "s1" });
  await assert.rejects(f.store.mutate({ action: "update_shot", slug: "episode", expectedRevision: 1, segmentId: "s1", dependsOn: "s0" }), /cycle/);
  await f.store.mutate({ action: "allocate", slug: "episode", expectedRevision: 1, segmentIds: ["s0"], peerIds: [f.roster[0].fp] });
  f.doc.segments[0].durationSec = 12;
  await assert.rejects(f.store.mutate({ action: "apply_draft", slug: "episode", expectedRevision: 2 }), /durations changed/);
  await assert.rejects(f.store.get("../episode"), /valid project/);
  assert.equal(JSON.parse(await readFile(path.join(f.dir, "collab/plans/episode.json"), "utf8")).revision, 2);
});

test("HTTP planning contract exposes read/write errors and records the caller actor", async (t) => {
  const f = await fixture(t); let answer;
  const route = createCollabPlanningRoutes({ ...f.deps, json: (_res, status, data) => { answer = { status, data }; }, readBody: async (req) => req.body, actorFrom: () => "agent:test" });
  assert.equal(await route({ method: "GET" }, {}, new URL("http://local/other")), false);
  await route({ method: "GET" }, {}, new URL("http://local/api/collab/plan?slug=episode")); assert.equal(answer.status, 200);
  assert.deepEqual(answer.data.delivery.handoffs, [], "the plan API and collab_plan MCP read the same handoff projection");
  await route({ method: "POST", body: { action: "update_episode", slug: "episode", expectedRevision: 0, notes: "Episode arc" } }, {}, new URL("http://local/api/collab/plan"));
  assert.equal(answer.data.plan.changedBy, "agent:test");
  await route({ method: "POST", body: { action: "update_episode", slug: "episode", expectedRevision: 0, notes: "Stale" } }, {}, new URL("http://local/api/collab/plan")); assert.equal(answer.status, 409);
});

test("order history isolates project and scene, retains every request, and never implies receipt or availability", () => {
  const row = { id: "o_000000000001", slug: "episode", order: { segmentId: "s0" }, to: { fp: "friend", nickname: "Friend" }, state: "sent", at: now - 5, expires: now + 1, privatePath: "secret", returns: [{ file: "private" }] };
  const result = projectOrderProgress({ slug: "episode", shots: shots(2), now, orders: [row,
    { ...row, id: "o_000000000002", at: now, state: "returned" },
    { ...row, id: "o_000000000003", slug: "other", state: "adopted" },
    { ...row, id: "o_000000000004", order: { segmentId: "deleted" } }] });
  assert.equal(result.scenes[0].orders.length, 2);
  assert.equal(result.scenes[0].orders[0].status, "returned");
  assert.equal(result.scenes[0].orders[1].label, "Package prepared");
  assert.equal(result.scenes[1].orders.length, 0);
  assert.equal(result.unmatchedOrders.length, 1);
  assert.equal(result.counts.adopted, 0);
  assert.equal(result.remoteAvailability, "unknown");
  assert.doesNotMatch(JSON.stringify(result), /private|secret/);
});

test("expiry applies only to unanswered packages and does not infer cancellation or retry safety", () => {
  const states = ["sent", "returned", "adopted", "refused", "cancelled", "invented"];
  const result = projectOrderProgress({ slug: "episode", shots: shots(1), now,
    orders: states.map((state, i) => ({ id: `order-${i}`, slug: "episode", state, order: { segmentId: "s0" }, at: now - 2, expires: now - 1 })) });
  assert.deepEqual(result.scenes[0].orders.map((row) => row.status), ["expired", "returned", "adopted", "refused", "cancelled", "unknown"]);
  assert.match(result.scenes[0].orders[0].nextStep, /still be running/);
  assert.equal(result.counts.expired, 1);
});

test("handoffs use the current owner and latest order without implying remote idle or delivery", () => {
  const observed = now + 86400002;
  const p = peers(2), s = shots(4); s.forEach((shot) => { shot.mode = "generate"; }); s[0].owner = p[0].fp; s[1].owner = p[1].fp; s[2].owner = p[0].fp; s[3].owner = p[0].fp; s[3].mode = "import";
  p[0].resources.at = observed; p[1].resources.at = now;
  const orders = [
    { id: "o_000000000001", slug: "episode", order: { segmentId: "s0" }, to: p[1], state: "sent", at: observed - 1000, expires: observed + 1000 },
    { id: "o_000000000002", slug: "episode", order: { segmentId: "s0" }, to: p[0], state: "sent", at: observed - 500, expires: observed - 1 },
    { id: "o_000000000003", slug: "episode", order: { segmentId: "s1" }, to: p[1], state: "returned", at: observed - 500 },
  ];
  const delivery = projectOrderProgress({ slug: "episode", shots: s, orders, now: observed });
  const plan = { shots: s, draft: { appliedAt: now, stale: false, capability: "videoH3", minVramMb: 12000,
    assignments: [{ fp: p[0].fp, segmentIds: ["s0", "s2"] }, { fp: p[1].fp, segmentIds: ["s1"] }] } };
  const handoffs = planHandoffs({ plan, peers: p, delivery, now: observed });
  assert.deepEqual(handoffs.map((row) => [row.segmentId, row.status]), [["s0", "expired"], ["s1", "returned"], ["s2", "not-prepared"]]);
  assert.equal(handoffs[0].otherOwnerOrders, 1);
  assert.equal(handoffs[0].card.fit, "listed");
  assert.equal(handoffs[1].card.state, "stale");
  assert.equal(handoffs[1].card.fit, "unknown");
  assert.ok(handoffs.every((row) => row.remoteAvailability === "unknown"));
  assert.doesNotMatch(JSON.stringify(handoffs), /privatePath|secret/);
});

test("handoff eligibility and card fit fail closed on changed trust and future timestamps", () => {
  const p = peers(2), s = shots(3); s.forEach((shot, i) => { shot.mode = "generate"; shot.owner = i === 2 ? "missing-friend" : p[i].fp; });
  p[0].verified = false; p[1].resources.at = now + 1;
  const plan = { shots: s, draft: { appliedAt: now, stale: false, capability: "videoH3", minVramMb: 12000,
    assignments: [{ fp: p[0].fp, segmentIds: ["s0"] }, { fp: p[1].fp, segmentIds: ["s1"] }] } };
  const handoffs = planHandoffs({ plan, peers: p, delivery: projectOrderProgress({ slug: "episode", shots: s, orders: [], now }), now });
  assert.equal(handoffs[0].peer.eligible, false);
  assert.equal(handoffs[1].card.state, "future");
  assert.equal(handoffs[1].card.fit, "unknown");
  assert.equal(handoffs[2].peer.eligible, false);
  assert.equal(handoffs[2].card.state, "missing");
});

test("real order-book transitions survive restart without modifying the plan or selecting a take", async (t) => {
  const f = await fixture(t), outDir = path.join(f.dir, "output", "collab"), id = "o_000000000001";
  const deps = { ...f.deps, readOrders: () => listOrders({ outDir }) }, store = createCollabPlanning(deps);
  const assigned = await store.mutate({ action: "update_shot", slug: "episode", expectedRevision: 0, segmentId: "s0", owner: f.roster[0].fp, stage: "assigned" });
  assert.equal(assigned.delivery.handoffs[0].status, "not-prepared", "write response reflects the new current owner");
  const file = path.join(f.dir, "collab/plans/episode.json"), before = await readFile(file, "utf8");
  await rememberOrder({ outDir, row: { id, slug: "episode", order: { segmentId: "s0" }, to: f.roster[0], at: now, expires: now + 1000 } });
  const prepared = await store.get("episode");
  assert.equal(prepared.delivery.counts.prepared, 1);
  assert.equal(prepared.delivery.handoffs[0].status, "prepared");
  await assert.rejects(rememberOrder({ outDir, row: { id } }), { reason: "order-exists" });
  await noteReturn({ outDir, id, entry: { ok: true, file: "take.mp4" } });
  await setOrderState({ outDir, id, state: "returned" });
  const afterReturn = await createCollabPlanning(deps).get("episode");
  assert.equal(afterReturn.delivery.counts.returned, 1);
  assert.equal(afterReturn.delivery.handoffs[0].status, "returned");
  assert.equal(afterReturn.delivery.scenes[0].orders[0].returnCount, 1);
  assert.equal(afterReturn.plan.shots[0].stage, "assigned");
  await setOrderState({ outDir, id, state: "adopted" });
  const adopted = await store.get("episode");
  assert.equal(adopted.delivery.counts.adopted, 1);
  assert.equal(adopted.delivery.handoffs[0].status, "adopted");
  assert.equal(await readFile(file, "utf8"), before);
  await store.mutate({ action: "update_episode", slug: "episode", expectedRevision: 1, notes: "Saved later" });
  assert.equal(JSON.parse(await readFile(file, "utf8")).delivery, undefined);
  assert.equal(f.doc.clips, undefined);
});

test("an unreadable order book refuses the read and does not turn into an empty or saveable plan", async (t) => {
  const f = await fixture(t), readOrders = async () => { throw Object.assign(new Error("Unreadable orders"), { status: 500 }); };
  const store = createCollabPlanning({ ...f.deps, readOrders });
  await assert.rejects(store.get("episode"), /Unreadable orders/);
  await assert.rejects(store.mutate({ action: "update_episode", slug: "episode", expectedRevision: 0, notes: "Changed" }), /Unreadable orders/);
  await assert.rejects(stat(path.join(f.dir, "collab")), { code: "ENOENT" });
});
