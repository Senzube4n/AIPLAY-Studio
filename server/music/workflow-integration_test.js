/** Execute the shared route/queue adapters with real workflow stores and files.
 * No application server, model runtime, subprocess or GPU is started. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { createListeningLab, listeningPairRequests } from "./listening-lab.js";
import { createListeningLabRuntime } from "./lab-runtime.js";
import { buildYue2ComfyGraph, INSTRUMENTAL_PLANNER_LORA } from "../workflow.js";
import { yue2ComfyFields } from "./yue2-comfy-input.js";

// Git may check these sources out as CRLF on Windows. Normalize only line endings
// so executable-boundary markers behave identically in a checkout and a worktree.
const index = (await readFile(new URL("../index.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const runner = (await readFile(new URL("../jobs.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const sha = text => createHash("sha256").update(text).digest("hex");
function between(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Executable integration boundary: ${start}`);
  return source.slice(a, b);
}
function reader(scope) {
  const body = between(index, "async function readWorkflowJob(id)", "const musicArtifactRoutes =");
  return new Function(...Object.keys(scope), `${body}; return readWorkflowJob;`)(...Object.values(scope));
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "music-workflow-integration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputDir = path.join(directory, "output"), appData = path.join(directory, "data");
  await mkdir(outputDir); await mkdir(appData);
  const library = { meta: new Map() }, jobs = { current: null, queue: [], history: [] }, filedMusicJobs = new Set();
  const config = { outputDir, paths: { appData }, output: { format: "flac" } };
  const listeningRuntime = createListeningLabRuntime({ config, library, shelf: async () => [], engine: {},
    measure: async file => (await readFile(file, "utf8")).startsWith("final") ? 37.25 : 40,
    hashFile: async file => sha(await readFile(file)), trainingReceipt: async () => null });
  const readJob = reader({ jobs, filedMusicJobs, listeningRuntime });
  const addFile = async (file, bytes) => { await writeFile(path.join(outputDir, file), bytes); library.meta.set(file, { title: file }); };
  return { directory, outputDir, appData, library, config, jobs, filedMusicJobs, listeningRuntime, readJob, addFile };
}

test("shared job reader waits for initial tagging and resolves only the exact finalized job", async t => {
  const f = await fixture(t);
  await f.addFile("take.flac", "unfinalized audio");
  const job = { id: "exact-take", state: "done", file: "take.flac", yue: { runId: "run-one", timings: { decode: 2 } } };
  f.jobs.history.push(job, { id: "unrelated", state: "failed", error: "another job" });
  assert.equal(await f.readJob("absent"), null);
  assert.equal((await f.readJob(job.id)).state, "composing");
  assert.equal((await f.readJob(job.id)).sha256, undefined, "do not freeze pre-tag bytes");
  await writeFile(path.join(f.outputDir, job.file), "final tagged audio");
  f.filedMusicJobs.add(job.id);
  const completed = await f.readJob(job.id);
  assert.equal(completed.file, job.file); assert.equal(completed.seconds, 37.25);
  assert.equal(completed.sha256, sha("final tagged audio")); assert.equal(completed.runId, "run-one");
  assert.deepEqual(completed.timings, { decode: 2 });
  f.jobs.history.unshift({ id: "cached-replay", state: "done", cached: true, file: job.file });
  const cached = await f.readJob("cached-replay");
  assert.equal(cached.state, "done"); assert.equal(cached.cached, true, "a reused result remains visibly cached");
  await rm(path.join(f.outputDir, job.file));
  assert.equal((await f.readJob(job.id)).state, "failed", "missing completed audio is not success");
});

test("listening store reconciles shared finalized-audio receipts, then detects changed audition bytes", async t => {
  const f = await fixture(t); await f.addFile("source.flac", "source audio");
  const cap = { engine: "yue2-comfy", ready: true, adapters: [{ name: "mine.safetensors", identity: "sha256:adapter" }],
    checkpoints: [{ name: "base.safetensors", identity: "sha256:base" }] };
  const store = createListeningLab({ appData: f.appData, ...f.listeningRuntime, capabilities: async () => cap,
    readJob: f.readJob, cancelJob: async () => ({ state: "cancelled" }),
    submitGenerate: async () => { const job = { id: `paired-${f.jobs.queue.length}`, state: "queued" }; f.jobs.queue.push(job); return { job }; } });
  let row = (await store.request({ action: "create", idempotencyKey: "review", name: "Pair", purpose: "Evaluate articulation",
    adapter: "mine.safetensors", checkpoint: "base.safetensors", trainingSource: { file: "source.flac", startSeconds: 0, seconds: 8 },
    cases: [{ name: "New words", caption: "Quiet folk", lyrics: "A separate evaluation", seed: 42 }] })).experiment;
  row = (await store.request({ action: "start", id: row.id, expectedRevision: row.revision, idempotencyKey: "queue" })).experiment;
  for (const job of f.jobs.queue) { Object.assign(job, { state: "done", file: `${job.id}.flac` }); await f.addFile(job.file, "pre-tag audio"); }
  row = (await store.refresh(row.id)).experiment;
  assert.ok(row.takes.every(take => take.state !== "ready"));
  for (const job of f.jobs.queue) { await writeFile(path.join(f.outputDir, job.file), `final tagged ${job.id}`); f.filedMusicJobs.add(job.id); }
  row = (await store.refresh(row.id)).experiment;
  assert.equal(row.state, "review"); assert.ok(row.takes.every(take => take.seconds === 37.25));
  await writeFile(path.join(f.outputDir, row.takes[0].file), "changed audio bytes");
  row = (await store.refresh(row.id)).experiment;
  assert.equal(row.takes[0].state, "failed"); assert.match(row.takes[0].error, /changed after completion/);
});

function createRouteHarness() {
  const queued = [], shelf = [
    { folder: "checkpoints", name: "reviewed.safetensors", full: "reviewed" },
    { folder: "checkpoints", name: "other.safetensors", full: "other" },
    { folder: "loras", name: "mine.safetensors" },
    { folder: "loras", name: INSTRUMENTAL_PLANNER_LORA },
  ];
  const scope = { path, INSTRUMENTAL_PLANNER_LORA, yue2ComfyFields,
    config: { music: { yue2Checkpoint: "global-wrong.safetensors", yue2Lora: "saved-wrong.safetensors",
      yue2LoraClip: INSTRUMENTAL_PLANNER_LORA, engines: { "yue2-comfy": { maxDuration: 300 } }, precision: "int8" }, audioRef: { denoise: .5 } },
    scanBases: async () => shelf, modelBases: async () => [], probeModel: async file => ({ family: file === "reviewed" ? "yue2" : "flux" }),
    json: (_res, status, value) => ({ status, value }), bareName: value => value, prov: { actorFrom: () => "agent:lab" },
    deriveTitle: () => "Untitled", jobReceipt: job => ({ id: job.id }), jobs: { enqueue: spec => { const job = { ...spec, id: `queued-${queued.length}` }; queued.push(job); return job; } },
    /* Decided above this slice by the paid-song gate (server/cloud-switch.js);
     * a YuE2 song is never a hosted one. */
    paidSong: false };
  const body = between(index, "      let yueLora = null", "\n    /**\n     * Extend an existing take.");
  // The slice ends at the enclosing generate-route brace; execute its branch.
  const route = new AsyncFunction(...Object.keys(scope), "body", `const musicEngine = 'yue2-comfy', aceJob = null, req = {}, res = {}; { ${body}`);
  const graphCall = between(runner, "buildYue2ComfyGraph({", ") : buildGraph({") + ")";
  const graph = new Function("buildYue2ComfyGraph", "job", `return ${graphCall};`).bind(null, buildYue2ComfyGraph);
  return { queued, request: body => route(...Object.values(scope), body), graph };
}

test("reviewed base/adapter requests survive the actual API and queue graph mapping", async () => {
  const f = createRouteHarness();
  const pair = listeningPairRequests({ checkpoint: { name: "reviewed.safetensors" }, adapter: { name: "mine.safetensors" }, strength: .8 },
    { caption: "Warm folk", lyrics: "", instrumental: true, seed: 0, maxDuration: 36.5, narSteps: 16, cot: "melody" });
  const base = await f.request(pair.base), adapted = await f.request(pair.adapter);
  assert.equal(base.status, 200); assert.equal(adapted.status, 200);
  assert.equal(base.value.job.id, "queued-0"); assert.equal(adapted.value.job.id, "queued-1");
  const [a, b] = f.queued.map(f.graph);
  assert.equal(a[1].inputs.ckpt_name, "reviewed.safetensors"); assert.equal(b[1].inputs.ckpt_name, "reviewed.safetensors");
  assert.equal(a[2], undefined); assert.equal(a[3], undefined); assert.equal(b[3], undefined);
  assert.equal(b[2].inputs.lora_name, "mine.safetensors"); assert.equal(b[2].inputs.strength_model, .8);
  assert.deepEqual(a[5], b[5]); assert.equal(a[5].inputs.max_duration, 36.5);
  assert.equal(a[7].inputs.seed, 0); assert.equal(b[7].inputs.seed, 0); assert.equal(b[7].inputs.steps, 16);
  assert.equal(a[4].inputs.mode, "melody"); assert.equal(f.queued[0].lyrics, "", "saved instrumental planner must stay disabled");
  const refused = await f.request({ ...pair.base, checkpoint: "other.safetensors" });
  assert.equal(refused.status, 400); assert.equal(f.queued.length, 2);
  assert.equal((await f.request({ ...pair.base, checkpoint: "../escape.safetensors" })).status, 400);
});

test("shared lab submit callback suppresses automatic media jobs through the actual generate route", async () => {
  const f = createRouteHarness(); let target;
  const scope = { createListeningLabRoutes: options => options, json() {}, readBody() {}, prov: { actorFrom() {} },
    config: { paths: { appData: "unused" } }, listeningRuntime: {}, readWorkflowJob() {}, jobs: {},
    submitStudioJson: async (url, body, actor) => { target = { url, body, actor }; return f.request(body); } };
  const body = between(index, "const listeningLabRoutes =", "const musicWorkflowRoutes =");
  const routes = new Function(...Object.keys(scope), `${body}; return listeningLabRoutes;`)(...Object.values(scope));
  const request = listeningPairRequests({ checkpoint: { name: "reviewed.safetensors" }, adapter: { name: "mine.safetensors" }, strength: 1 },
    { caption: "Piano", lyrics: "Words", instrumental: false, seed: 5, maxDuration: 60, narSteps: 32, cot: "full" }).base;
  const result = await routes.submitGenerate({ request, actor: "agent:comparison", requestId: "lab/case1-A" });
  assert.equal(result.value.job.id, "queued-0"); assert.equal(target.url, "/api/generate");
  assert.equal(target.actor, "agent:comparison"); assert.equal(target.body.postprocess, false);
  assert.deepEqual(f.queued[0].stages, { cover: false, stems: false, lrc: false, video: false }, "later cover embedding must not change audition bytes");
  assert.equal(request.postprocess, undefined, "shared adapter does not mutate the frozen request");
});

test("artifact source callback binds the real library recording to a contained saved run", async t => {
  const f = await fixture(t), runDir = path.join(f.outputDir, "yue2", "run-one");
  await mkdir(runDir, { recursive: true }); await f.addFile("source.flac", "source audio");
  f.library.meta.set("source.flac", { engine: "yue2", yueDir: runDir });
  const body = between(index, "const musicArtifactRoutes =", "const listeningLabRoutes =");
  const scope = { createMusicArtifactRoutes: options => options, json() {}, readBody() {}, prov: { actorFrom() {} },
    config: f.config, library: f.library, listeningRuntime: f.listeningRuntime, readWorkflowJob: f.readJob,
    realpath, path, jobs: f.jobs };
  const routes = new Function(...Object.keys(scope), `${body}; return musicArtifactRoutes;`)(...Object.values(scope));
  const source = await routes.resolveSource("source.flac");
  assert.equal(source.dir, await realpath(runDir)); assert.equal(source.sourceHash, sha("source audio"));
  assert.equal(source.runId, "run-one");
  f.library.meta.get("source.flac").yueDir = f.directory;
  await assert.rejects(routes.resolveSource("source.flac"), /outside Studio/);
  f.library.meta.get("source.flac").engine = "yue2-comfy";
  await assert.rejects(routes.resolveSource("source.flac"), /saved Python/);
});
