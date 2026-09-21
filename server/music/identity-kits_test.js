import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const scoreOutput = await mkdtemp(path.join(os.tmpdir(), "kit-score-contract-"));
process.env.AIPLAY_OUTPUT = scoreOutput;
process.env.AIPLAY_APPDATA = path.join(scoreOutput, "appdata");
after(() => rm(scoreOutput, { recursive: true, force: true }));
const { createMusicKits, createMusicKitRoutes, melodyWithoutChords } = await import("./identity-kits.js");
const { musicKitTools } = await import("../mcp-music-kits.js");
const { createScoreRoutes, readScoreVersionSnapshot } = await import("../score/routes.js");
const { scoreTools, compareScores } = await import("../mcp-music-score.js");
const { createCollabPlanning } = await import("../collab/planning.js");
const { collabTools } = await import("../mcp-collab.js");

const ABC = ['X:1', 'T:', 'M:4/4', 'L:1/16', 'Q:1/4=120',
  'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"',
  'V: Ins clef=treble name="Ins Melody" snm="Inst."', 'K:C', '% theme',
  'V: Vocal', '"C"C4D4E4G4|"F"A4G4E4C4|', 'V: Ins', 'C8G8|F8C8|'].join('\n');
const createBody = () => ({ action: "create", idempotencyKey: "creation-one", name: "Episode identity", theme: "A rising theme", abc: ABC,
  style: "Warm piano and cello", lyrics: "A small boat leaves the quay", seed: 42, engine: "yue2", quantization: "none" });
async function fixture(t, more = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "music-kit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [], jobs = new Map(); let clock = 1_000_000;
  const deps = { appData: dir, now: () => clock,
    submitGenerate: async ({ request, actor, requestId }) => { calls.push({ request, actor, requestId }); const job = { id: `exact-${calls.length}`, status: "queued" }; jobs.set(job.id, job); return { job }; },
    readJob: async id => jobs.get(id), ...more };
  return { dir, deps, store: createMusicKits(deps), calls, jobs, advance: n => { clock += n; } };
}

test("kit creation freezes source material, is idempotent and does not queue a job", async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.store.list()).kits, []);
  await assert.rejects(stat(path.join(f.dir, "music-kits")), { code: "ENOENT" });
  const first = await f.store.act(createBody(), "agent:fixture");
  const replay = await f.store.act(createBody(), "agent:fixture");
  assert.equal(first.kit.id, replay.kit.id); assert.equal(first.kit.revision, 1); assert.equal(f.calls.length, 0);
  const saved = (await createMusicKits(f.deps).get(first.kit.id)).kit;
  assert.equal(saved.variants[0].score.abc, ABC); assert.equal(saved.variants[0].recipe.seed, 42);
  assert.equal(saved.variants[0].by, "agent:fixture"); assert.equal(saved.variants[0].score.harmony.Vocal.length, 2);
  await assert.rejects(f.store.act({ ...createBody(), name: "Changed" }), /different kit/);
  await assert.rejects(f.store.act({ ...createBody(), idempotencyKey: "bad-engine", engine: "yue2-comfy" }), /supplied-ABC/);
  await assert.rejects(f.store.act({ ...createBody(), idempotencyKey: "bad-field", singer: "same" }), /Unsupported/);
});

test("variant modes enforce their actual symbolic promise and preserve original bytes", async t => {
  const f = await fixture(t), { kit } = await f.store.act(createBody());
  const common = { id: kit.id, expectedRevision: 1, baseVariantId: "theme", role: "opening", name: "Opening" };
  const stripped = melodyWithoutChords(ABC);
  assert.ok(stripped.abc.includes('name="Vocal Melody"'), "quoted headers are retained");
  assert.equal(stripped.harmony.Vocal.length, 0);
  assert.ok(Object.values(compareScores(ABC, stripped.abc).voices).every(v => v.notes_identical));
  const preview = await f.store.act({ ...common, action: "preview_variant", mode: "keep_melody", style: "Guitar and soft drums" });
  assert.equal(preview.variant.cot, "melody"); assert.equal(preview.saved, false); assert.equal(f.calls.length, 0);
  assert.equal((await f.store.get(kit.id)).kit.revision, 1);
  const saved = await f.store.act({ ...common, action: "save_variant", idempotencyKey: "arrangement", mode: "keep_score", style: "Guitar and soft drums" });
  assert.equal(saved.kit.variants[1].score.abc, ABC); assert.equal(saved.kit.variants[0].recipe.style, "Warm piano and cello");
  const replay = await f.store.act({ ...common, action: "save_variant", idempotencyKey: "arrangement", mode: "keep_score", style: "Guitar and soft drums" });
  assert.equal(replay.kit.variants.length, 2);
  await assert.rejects(f.store.act({ ...common, expectedRevision: 2, action: "save_variant", idempotencyKey: "fake-keep", mode: "keep_score", abc: ABC.replace("D4", "E4") }), /Revise composition/);
  const revised = await f.store.act({ ...common, expectedRevision: 2, action: "save_variant", idempotencyKey: "revision", mode: "revise", abc: ABC.replace("D4", "E4") });
  assert.equal(revised.kit.variants[2].changes.voices.Vocal.notes_identical, false);
  assert.equal(revised.kit.variants[0].score.abc, ABC);
});

test("concurrent saves reject stale revisions instead of overwriting another variant", async t => {
  const f = await fixture(t), { kit } = await f.store.act(createBody());
  const results = await Promise.allSettled(["A", "B"].map(name => f.store.act({ action: "save_variant", id: kit.id, expectedRevision: 1,
    idempotencyKey: name, name, role: "tension", mode: "keep_score", style: name })));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.status, 409);
});

test("review precedes render; exact request, actor and queued job survive retry/reload", async t => {
  const f = await fixture(t), { kit } = await f.store.act(createBody());
  const prepared = await f.store.act({ action: "prepare", id: kit.id, expectedRevision: 1, variantId: "theme" }, "agent:fixture");
  assert.equal(f.calls.length, 0); assert.equal(prepared.prepared.request.abc, ABC); assert.equal(prepared.prepared.request.cot, "full");
  assert.equal(prepared.prepared.request.allowSectionLabels, undefined, "no implicit lyric-guard override");
  const render = { action: "render", id: kit.id, expectedRevision: prepared.kit.revision, preparedId: prepared.prepared.id, idempotencyKey: "render-one" };
  const first = await f.store.act(render, "agent:fixture");
  assert.equal(first.render.jobId, "exact-1"); assert.equal(f.calls[0].actor, "agent:fixture");
  assert.deepEqual(f.calls[0].request, prepared.prepared.request);
  assert.equal((await createMusicKits(f.deps).act(render)).render.jobId, "exact-1"); assert.equal(f.calls.length, 1);
  f.jobs.set("exact-1", { id: "exact-1", status: "done", file: "take.wav", durationSeconds: 5.1, scoreSlug: "episode", scoreVersion: "v-new" });
  const done = await f.store.act({ action: "refresh_job", id: kit.id, renderId: first.render.id });
  assert.equal(done.kit.renders[0].file, "take.wav"); assert.deepEqual(done.kit.renders[0].score, { slug: "episode", version: "v-new" });
  f.jobs.set("exact-1", { id: "wrong-current", status: "done", file: "wrong.wav" });
  await assert.rejects(f.store.act({ action: "refresh_job", id: kit.id, renderId: first.render.id }), /exact job/);
  assert.equal((await f.store.get(kit.id)).kit.renders[0].file, "take.wav");
});

test("unknown submissions and expired reviews never silently queue another take", async t => {
  let submitted = 0;
  const f = await fixture(t, { submitGenerate: async () => { submitted++; throw new Error("response lost after submission"); } });
  const { kit } = await f.store.act(createBody());
  const p = await f.store.act({ action: "prepare", id: kit.id, expectedRevision: 1, variantId: "theme" });
  const body = { action: "render", id: kit.id, expectedRevision: p.kit.revision, preparedId: p.prepared.id, idempotencyKey: "uncertain" };
  assert.equal((await f.store.act(body)).render.status, "submission_unknown");
  const replay = await createMusicKits(f.deps).act(body); assert.equal(submitted, 1); assert.match(replay.note, /not.*submitted again/);
  const now = (await f.store.get(kit.id)).kit;
  const another = await f.store.act({ action: "prepare", id: kit.id, expectedRevision: now.revision, variantId: "theme" });
  f.advance(31 * 60_000);
  await assert.rejects(f.store.act({ ...body, idempotencyKey: "expired", expectedRevision: another.kit.revision, preparedId: another.prepared.id }), /expired/);
  assert.equal(submitted, 1);
});

test("native GGUF requests use its actual boundary and do not promise score export or instrumentals", async t => {
  const f = await fixture(t), { kit } = await f.store.act(createBody());
  const p = await f.store.act({ action: "prepare", id: kit.id, expectedRevision: 1, variantId: "theme", engine: "yue2-gguf", quantization: "q8_0" });
  assert.equal(p.prepared.request.quantization, "q8_0");
  for (const field of ["maxDuration", "scoreSlug", "scoreVersion", "abcOpen"]) assert.equal(p.prepared.request[field], undefined);
  await assert.rejects(f.store.act({ ...createBody(), idempotencyKey: "native-instrumental", engine: "yue2-gguf", quantization: "q4_0", instrumental: true, lyrics: "" }), /requires nonempty lyrics/);
});

test("real score routes feed score MCP and kits, including exact text, metadata and melody mode", async t => {
  let response;
  const scoreRoute = createScoreRoutes({ json: (_res, status, body) => { response = { status, body }; }, readBody: async req => req.body,
    provenance: { actorFrom: () => "agent:fixture" } });
  const generated = [];
  const api = async (_method, url, body) => {
    if (url === "/api/generate") { generated.push(body); return { job: { id: "score-job" } }; }
    await scoreRoute({ method: "POST", body }, {}, new URL(`http://fixture${url}`));
    if (response.status >= 400) throw new Error(response.body.error); return response.body;
  };
  const created = await api("POST", "/api/score", { action: "create", title: "Real contract" });
  const draft = await api("POST", "/api/score", { action: "draft", slug: created.slug, abc: melodyWithoutChords(ABC).abc,
    style: "Piano only", lyrics: "A small boat leaves the quay", cot: "melody", note: "Fixture source" });
  const tools = scoreTools(api);
  const got = await tools.find(t => t.name === "score_get").run({ score: created.slug, version: draft.version });
  assert.equal(got.abc, melodyWithoutChords(ABC).abc); assert.equal(got.style, "Piano only"); assert.equal(got.cot, "melody");
  await tools.find(t => t.name === "score_render").run({ score: created.slug, version: draft.version, seed: 44 });
  assert.equal(generated[0].cot, "melody"); assert.equal(generated[0].scoreVersion, draft.version);
  const f = await fixture(t, { readScoreSnapshot: readScoreVersionSnapshot });
  const body = createBody(); delete body.abc; delete body.style; delete body.lyrics;
  body.sourceScore = { slug: created.slug, version: draft.version };
  const { kit } = await f.store.act(body);
  assert.equal(kit.variants[0].recipe.style, "Piano only"); assert.equal(kit.variants[0].sourceScore.version, draft.version);
  const prepared = await f.store.act({ action: "prepare", id: kit.id, expectedRevision: 1, variantId: "theme" });
  assert.equal(prepared.prepared.request.scoreSlug, created.slug); assert.equal(prepared.prepared.request.cot, "melody");
});

test("HTTP and typed MCP enforce planning/render separation and request bounds", async t => {
  const f = await fixture(t); let response;
  const route = createMusicKitRoutes({ ...f.deps, actorFrom: () => "agent:mcp", readBody: async req => req.body,
    json: (_res, status, body) => { response = { status, body }; } });
  const api = async (method, url, body) => {
    await route({ method, body }, {}, new URL(`http://fixture${url}`));
    if (response.status >= 400) throw new Error(response.body.error); return response.body;
  };
  const [plan, render] = musicKitTools(api);
  assert.equal(plan.inputSchema.properties.action.enum.includes("render"), false);
  assert.throws(() => plan.run({ action: "render" }), /music_kit_render/);
  assert.throws(() => plan.run({ action: "get" }), /valid music kit/);
  const { kit } = await plan.run(createBody());
  assert.equal(kit.createdBy, "agent:mcp");
  const prepared = await plan.run({ action: "prepare", id: kit.id, expectedRevision: 1, variantId: "theme" });
  assert.equal(f.calls.length, 0);
  const submitted = await render.run({ id: kit.id, expectedRevision: prepared.kit.revision, preparedId: prepared.prepared.id, idempotencyKey: "mcp-render" });
  assert.equal(submitted.render.jobId, "exact-1");
  const req = Readable.from([Buffer.alloc(193 * 1024, "x")]); req.method = "POST"; req.headers = {};
  await route(req, {}, new URL("http://fixture/api/music-kits")); assert.equal(response.status, 413);
});

test("episode cue links validate exact variants and preserve notes, allocation and revision ownership", async t => {
  const f = await fixture(t), { kit } = await f.store.act(createBody());
  const plan = createCollabPlanning({ appData: f.dir, readProject: async () => ({ title: "Episode", segments: [{ id: "scene-one", seconds: 10 }] }),
    readPeers: async () => [], resolveKitCue: f.store.resolveCue });
  await plan.mutate({ action: "update_episode", slug: "episode", expectedRevision: 0, notes: "The episode arc" }, "user");
  const tools = collabTools(async (_method, _url, body) => plan.mutate(body, "agent:mcp"), value => value);
  const link = { kitId: kit.id, variantId: "theme", variantHash: kit.variants[0].hash };
  const linked = await tools.find(t => t.name === "collab_plan").run({ action: "set_music_cue", slug: "episode", expectedRevision: 1, slot: "opening", musicKit: link });
  assert.equal(linked.plan.notes, "The episode arc"); assert.equal(linked.plan.revision, 2);
  assert.equal(linked.plan.musicCues[0].variantHash, link.variantHash); assert.equal(linked.plan.musicCues[0].changedBy, "agent:mcp");
  await assert.rejects(plan.mutate({ action: "set_music_cue", slug: "episode", expectedRevision: 1, slot: "closing", musicKit: link }), /another view/);
  await assert.rejects(plan.mutate({ action: "set_music_cue", slug: "episode", expectedRevision: 2, segmentId: "missing", slot: "opening", musicKit: link }), /no longer/);
  await assert.rejects(plan.mutate({ action: "set_music_cue", slug: "episode", expectedRevision: 2, slot: "opening", musicKit: { ...link, variantHash: "wrong" } }), /changed/);
  const removed = await plan.mutate({ action: "set_music_cue", slug: "episode", expectedRevision: 2, slot: "opening", musicKit: null });
  assert.deepEqual(removed.plan.musicCues, []); assert.equal(f.calls.length, 0);
});
