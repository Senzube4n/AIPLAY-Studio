/** Exact prompt capture -> common score store -> UI/MCP read, without a GPU. */
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { capturedYue2Score } from "./yue2-comfy-score.js";

const temporary = await mkdtemp(path.join(tmpdir(), "aiplay-comfy-score-"));
process.env.AIPLAY_OUTPUT = temporary;
process.env.AIPLAY_APPDATA = path.join(temporary, "appdata");
const { buildYue2ComfyGraph } = await import("../workflow.js");
const store = await import("../score/store.js");
const { readScoreVersionSnapshot } = await import("../score/routes.js");
const { inspectReplaySource } = await import("./yue-artifacts.js");
const { scoreRenderSource } = await import("../score/render-source.js");
const abc = "X:1\nT:\nM:4/4\nL:1/8\nQ:1/4=120\nV: Vocal clef=treble name=\"Vocal Melody\" snm=\"Vocal\"\nV: Ins clef=treble name=\"Ins Melody\" snm=\"Inst.\"\nK:C\n% verse  \nV: Vocal\nC2D2E2F2|\nV: Ins\nC4G4|\n";
const base = { caption: "warm", lyrics: "a line  \n", checkpoint: "yue2.safetensors", seed: 71, cot: "full", scoreCaptureKey: "job-a" };
let pass = 0;
function check(fn) { fn(); pass++; }
try {
  const graph = buildYue2ComfyGraph(base);
  check(() => assert.equal(graph[11].class_type, "AiplayYuE2Score"));
  check(() => assert.deepEqual(graph[11].inputs, { abc: ["4", 0], seconds: ["5", 1], capture_key: "job-a" }));
  check(() => assert.deepEqual(graph[5].inputs.abc, ["4", 0], "capture does not replace/transform the music input"));
  const supplied = buildYue2ComfyGraph({ ...base, abc, codes: "codes" });
  check(() => assert.equal(supplied[11].inputs.abc, abc));
  check(() => assert.equal(supplied[5].inputs.abc, abc));
  check(() => assert.equal(supplied[4], undefined));
  check(() => assert.equal(buildYue2ComfyGraph({ ...base, cot: "off" })[11], undefined));
  check(() => assert.equal(buildYue2ComfyGraph({ ...base, captureScore: false })[11], undefined, "remote graphs never require the local capture node"));
  const entry = { outputs: { "11": { aiplay_yue2_score: [{ capture_key: "job-a", abc, audio_seconds: 7.8 }] } } };
  check(() => assert.deepEqual(capturedYue2Score(entry, "job-a"), { abc, audioSeconds: 7.8 }));
  check(() => assert.equal(capturedYue2Score(entry, "job-b"), null, "another prompt's notation is never reused"));
  check(() => assert.equal(capturedYue2Score({ outputs: { "4": { text: [abc] } } }, "job-a"), null));
  check(() => assert.equal(capturedYue2Score({ outputs: { "11": { aiplay_yue2_score: [{ capture_key: "job-a", abc: "🎵".repeat(17000) }] } } }, "job-a"), null));
  /* Exercise the real queue finish path: the pure history reader alone cannot
   * prove its result reaches filing or that metadata is not mistaken for audio. */
  const { engine } = await import("../engine/client.js");
  const { JobRunner } = await import("../jobs.js");
  const savedEngine = { socket: engine.socket, submit: engine.submit, history: engine.history };
  try {
    for (const wrongKey of [false, true, "missing"]) {
      const socket = Object.assign(new EventEmitter(), { readyState: 1 });
      engine.socket = () => { setImmediate(() => socket.emit("open")); return socket; };
      let submitted;
      engine.submit = async ({ graph }) => { submitted = graph; return { promptId: "completed-prompt", runId: "job-record" }; };
      const runner = new JobRunner({ ready: true, on() {} });
      await runner.connect();
      const job = runner.enqueue({ ...base, engine: "yue2-comfy", yue2Checkpoint: base.checkpoint,
        abc: wrongKey === "missing" ? abc : null });
      const deadline = Date.now() + 1000;
      while (!job.promptId && job.state !== "failed" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
      check(() => assert.equal(job.promptId, "completed-prompt"));
      check(() => assert.equal(submitted[11].inputs.capture_key, job.id));
      const filename = `aiplay-finished-${wrongKey}.flac`;
      await writeFile(path.join(temporary, filename), "audio");
      await writeFile(path.join(temporary, "wrong.abc"), "unrelated sheet");
      engine.history = async () => wrongKey === "missing" ? {} : ({ "completed-prompt": { outputs: {
        "11": { aiplay_yue2_score: [{ abc, capture_key: wrongKey ? "another-job" : job.id, audio_seconds: 7.8 }] },
        "8": { files: [{ filename: "wrong.abc", type: "output" }] },
        "9": { audio: [{ filename, type: "output" }] },
      } } });
      socket.emit("message", Buffer.from(JSON.stringify({ type: "executing", data: { prompt_id: job.promptId, node: null } })), false);
      while (runner.current && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
      check(() => wrongKey === "missing" ? assert.ok(job.file) : assert.equal(job.file, filename));
      check(() => assert.equal(job.state, "done"));
      check(() => assert.equal(runner.history.length, 1));
      if (wrongKey) {
        check(() => assert.equal(job.yueComfyScore, null));
        check(() => assert.match(job.scoreWarning, /no readable score/));
      } else {
        check(() => assert.equal(job.yueComfyScore.abc, abc));
        check(() => assert.equal(job.audioSeconds, 7.8));
      }
    }
  } finally { Object.assign(engine, savedEngine); }
  const remoteRunner = new JobRunner({ ready: false, on() {} });
  let remoteGraph;
  remoteRunner.setRemote(async ({ graph }) => { remoteGraph = graph; return { file: "aiplay-remote.flac" }; });
  const remoteJob = remoteRunner.enqueue({ ...base, engine: "yue2-comfy", yue2Checkpoint: base.checkpoint });
  const remoteDeadline = Date.now() + 1000;
  while (["queued", "running"].includes(remoteJob.state) && Date.now() < remoteDeadline) await new Promise(resolve => setTimeout(resolve, 2));
  check(() => assert.equal(remoteJob.state, "done"));
  check(() => assert.equal(remoteGraph[11], undefined));
  check(() => assert.match(remoteJob.scoreWarning, /remote worker returns audio without score capture/));
  check(() => assert.equal(remoteJob.yueComfyScore, undefined));
  for (const ext of ["flac", "mp3", "opus"]) {
    const doc = await store.createScore(`Comfy ${ext}`);
    const audio = Buffer.from(`real output bytes in ${ext}`);
    await writeFile(path.join(temporary, `aiplay-test.${ext}`), audio);
    const draft = await store.draftVersion(doc.slug, { abc: abc + "% draft\n", by: "agent:test" });
    const kept = await store.adoptComfyVersion(doc.slug, {
      abc, file: `aiplay-test.${ext}`, promptId: `prompt-${ext}`, checkpoint: "subfolder/yue2.safetensors",
      request: { style: base.caption, lyrics: base.lyrics, cot: "full", seed: base.seed,
        narSteps: 16, lora: null, loraClip: "planner.safetensors", loraClipStrength: 0.9,
        sampling: { temperature: 0.8, top_p: 0.85, top_k: 50, repetition_penalty: 1.1 } },
      audioSeconds: 7.8, by: "agent:test", parent: draft.id,
    });
    check(() => assert.equal(kept.doc.current, kept.id));
    check(() => assert.equal(kept.version.parent, draft.id));
    check(() => assert.equal(kept.version.producer, "aiplay-yue2-comfy-score-v1"));
    check(() => assert.equal(kept.version.source.engine, "yue2-comfy"));
    check(() => assert.equal(kept.version.weights, null, "capturing notation never claims Python/weight integrity"));
    check(() => assert.equal(kept.version.audioSeconds, 7.8));
    check(() => assert.deepEqual(Object.keys(kept.version.artifacts).sort(), [`audio.${ext}`, "request.json", "score.abc"]));
    check(() => assert.equal(kept.version.verified, "hash"));
    check(() => assert.equal(kept.version.by, "agent:test"));
    check(() => assert.equal(kept.version.drafted, undefined));
    assert.equal(await store.readScoreAbc(doc.slug, kept.id), abc); pass++;
    assert.deepEqual(await store.readArtifact(doc.slug, kept.id, `audio.${ext}`), audio); pass++;
    const snapshot = await readScoreVersionSnapshot({ slug: doc.slug, version: kept.id });
    check(() => assert.equal(snapshot.abc, abc));
    check(() => assert.equal(snapshot.lyrics, base.lyrics, "UI/MCP reuse keeps exact trailing whitespace"));
    check(() => assert.equal(snapshot.requestVerified, true));
    check(() => assert.equal(snapshot.drafted, false));
    const rerender = scoreRenderSource(snapshot);
    check(() => assert.equal(rerender.engine, "yue2-comfy"));
    check(() => assert.equal(rerender.checkpoint, path.join("subfolder", "yue2.safetensors")));
    check(() => assert.equal(rerender.lora, "", "a saved empty slot explicitly clears unrelated current preferences"));
    check(() => assert.equal(rerender.loraClip, "planner.safetensors"));
    check(() => assert.equal(rerender.loraClipStrength, 0.9));
    check(() => assert.equal(rerender.narSteps, 16));
    check(() => assert.equal(rerender.temperature, 0.8));
    check(() => assert.equal(rerender.topP, 0.85));
    check(() => assert.equal(rerender.topK, 50));
    check(() => assert.equal(rerender.repetitionPenalty, 1.1));
    check(() => assert.equal(rerender.planTemperature, undefined, "a saved score bypasses the planner"));
    check(() => assert.throws(() => scoreRenderSource(snapshot, { cfg_scale: 1 }), /no Guidance control/));
    if (ext === "flac") {
      const { scoreTools } = await import("../mcp-music-score.js");
      const renderedBodies = [];
      let apiRow = { ...snapshot, id: kept.id, score: { text: abc } };
      const tool = scoreTools(async (method, endpoint, body) => {
        if (method === "POST" && endpoint === "/api/score") return { score: { slug: doc.slug, current: kept.id }, versions: [apiRow] };
        if (method === "POST" && endpoint === "/api/generate") { renderedBodies.push(body); return { job: { id: "test-job" }, engine: body.engine }; }
        if (method === "GET" && endpoint === "/api/status") return { current: { id: "test-job", seed: 8, engine: "yue2-comfy" } };
        throw new Error(`Unexpected MCP door: ${method} ${endpoint}`);
      }).find(row => row.name === "score_render");
      const result = await tool.run({ score: doc.slug, version: kept.id, seed: 8 });
      check(() => assert.equal(renderedBodies[0].engine, "yue2-comfy", "the actual MCP tool uses the saved engine"));
      check(() => assert.equal(renderedBodies[0].loraClip, "planner.safetensors"));
      check(() => assert.equal(renderedBodies[0].lora, ""));
      check(() => assert.equal(renderedBodies[0].abc, abc));
      check(() => assert.equal(renderedBodies[0].scoreVersion, kept.id));
      check(() => assert.equal(result.cost.measured_reference, null, "Python benchmark timings are not claimed for ComfyUI"));
      await assert.rejects(tool.run({ score: doc.slug, version: kept.id, cfg_scale: 1 }), /no Guidance control/); pass++;
      apiRow = { ...apiRow, source: { ...apiRow.source, engine: "unknown-engine" } };
      await assert.rejects(tool.run({ score: doc.slug, version: kept.id }), /not supported/); pass++;
      check(() => assert.equal(renderedBodies.length, 1, "unsupported source/control never queues a song"));
    }
    const edited = await store.draftVersion(doc.slug, { abc: abc + "% changed\n", by: "agent:test", parent: kept.id });
    check(() => assert.equal(scoreRenderSource({ ...edited.version, producer: null }).engine, "yue2-comfy", "a score edit inherits its rendered source"));
    const receipt = await store.readReceipt(store.versionDir(doc.slug, kept.id));
    check(() => assert.deepEqual(receipt.missing, []));
    check(() => assert.deepEqual(receipt.mismatched, []));
    await assert.rejects(inspectReplaySource(store.versionDir(doc.slug, kept.id)), /48 kHz|unsupported artifact/); pass++;
  }
  const refused = await store.createScore("Refuse wrong audio");
  for (const file of ["../outside.flac", path.join(temporary, "aiplay-test.flac"), "score.json"]) {
    await assert.rejects(store.adoptComfyVersion(refused.slug, { abc, file, promptId: "id", by: "system" }), /Studio library/); pass++;
  }
  const refusedDoc = await store.readScoreDoc(refused.slug);
  check(() => assert.equal(refusedDoc.versions.length, 0));
  assert.equal((await readdir(store.SCORE_DIR())).some(name => name.startsWith(".comfy-capture-")), false); pass++;
  const outside = await mkdtemp(path.join(tmpdir(), "aiplay-comfy-score-external-"));
  const linked = path.join(temporary, "linked-directory");
  try {
    await writeFile(path.join(outside, "outside.flac"), "outside library");
    await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(store.adoptComfyVersion(refused.slug, { abc, file: "linked-directory/outside.flac", promptId: "id", by: "system" }), /Studio library/); pass++;
  } finally {
    await unlink(linked).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (path.dirname(outside) !== path.resolve(tmpdir()) || !path.basename(outside).startsWith("aiplay-comfy-score-external-")) throw new Error("Unexpected external fixture directory");
    await rm(outside, { recursive: true, force: true });
  }
  check(() => assert.deepEqual(scoreRenderSource({}), { engine: "yue2" }));
  check(() => assert.throws(() => scoreRenderSource({ source: { engine: "other" } }), /not supported/));
  check(() => assert.throws(() => scoreRenderSource({ producer: "aiplay-yue2-comfy-score-v1" }), /no saved source/));
  check(() => assert.throws(() => scoreRenderSource({ source: { engine: "yue2-comfy" } }), /no saved checkpoint/));
  check(() => assert.throws(() => scoreRenderSource({ source: { engine: "yue2-comfy", checkpoint: "c.safetensors" } }), /incomplete saved/));
  const { Library } = await import("../library.js");
  const library = new Library();
  await library.load();
  const warning = "The audio finished, but ComfyUI returned no readable score.";
  library.remember("aiplay-test.flac", { engine: "yue2-comfy", durationSeconds: 7.8, scoreWarning: warning });
  const listed = (await library.list()).find(row => row.file === "aiplay-test.flac");
  check(() => assert.equal(listed.scoreWarning, warning));
  await library.save();
  const mcpSource = await readFile(new URL("../mcp.js", import.meta.url), "utf8");
  const mcpStart = mcpSource.indexOf('name: "list_songs"'), mcpEnd = mcpSource.indexOf('name: "make_song"', mcpStart);
  const toolBlock = mcpSource.slice(mcpSource.lastIndexOf("  {", mcpStart), mcpSource.lastIndexOf("  {", mcpEnd)).trim().replace(/,$/, "");
  const listTool = runInNewContext(`(${toolBlock})`, { api: async () => ({ library: [listed, { file: "with-score.flac", scoreSlug: "saved", scoreVersion: "v1" }] }) });
  const mcpRows = await listTool.run({});
  check(() => assert.equal(mcpRows[0].score_warning, warning));
  check(() => assert.equal(mcpRows[0].has_score, false));
  check(() => assert.equal(mcpRows[1].has_score, true));
  check(() => assert.equal(mcpRows[1].score.slug, "saved"));
  const jobsSource = await readFile(new URL("../jobs.js", import.meta.url), "utf8");
  check(() => assert.match(jobsSource, /scoreCaptureKey: job\.id/));
  check(() => assert.match(jobsSource, /capturedYue2Score\(entry, job\.id\)/));
  const indexSource = await readFile(new URL("../index.js", import.meta.url), "utf8");
  /* Exercise the real filing catches: audio succeeds even if adopting its
   * score or printing its sheet fails, and the reason survives a fresh load. */
  const adoptionStart = indexSource.indexOf("  let score = null;");
  const adoptionEnd = indexSource.indexOf("  /* The sheet is engraved AFTER", adoptionStart);
  assert.ok(adoptionStart >= 0 && adoptionEnd > adoptionStart);
  const adoption = indexSource.slice(adoptionStart, adoptionEnd);
  const adoptionFile = "aiplay-adoption-failure.flac";
  await writeFile(path.join(temporary, adoptionFile), "saved audio");
  library.remember(adoptionFile, { durationSeconds: 7.8, engine: "yue2-comfy" });
  const adoptionJob = { state: "done", engine: "yue2-comfy", yueComfyScore: { abc }, promptId: "test-prompt", seed: 71 };
  const adoptionResult = await runInNewContext(`(async () => { ${adoption} return { score, job }; })()`, {
    h: { file: adoptionFile, title: "Saved audio" }, job: adoptionJob, isYueComfy: true, library,
    createScore: async () => ({ slug: "capture" }), readScoreDoc: async () => null,
    findVersion: () => null, prov: { normalizeActor: () => "system" },
    yue2ComfySamplingReceipt: () => ({ audio: {} }),
    adoptComfyVersion: async () => { throw new Error("Score directory permission denied"); },
    console: { error() {} },
  });
  check(() => assert.equal(adoptionResult.score, null));
  check(() => assert.equal(adoptionJob.state, "done", "missing notation never fails saved audio"));
  check(() => assert.match(adoptionJob.scoreWarning, /Sheet music could not be saved\. Score directory permission denied/));
  const afterAdoption = new Library(); await afterAdoption.load();
  check(() => assert.equal(afterAdoption.meta.get(adoptionFile).scoreWarning, adoptionJob.scoreWarning));
  const engravingStart = indexSource.indexOf("  if (score && sheetCapability().html !== false)");
  const engravingEnd = indexSource.indexOf("  // Ask for a cover.", engravingStart);
  assert.ok(engravingStart >= 0 && engravingEnd > engravingStart);
  const engraving = indexSource.slice(engravingStart, engravingEnd);
  const engravingFile = "aiplay-engraving-failure.flac";
  await writeFile(path.join(temporary, engravingFile), "saved audio");
  library.remember(engravingFile, { durationSeconds: 7.8, engine: "yue2-comfy", scoreSlug: "saved", scoreVersion: "v1" });
  const engravingJob = { state: "done", audioSeconds: 7.8 };
  await runInNewContext(`(async () => { ${engraving} })()`, {
    score: { slug: "saved", version: "v1" }, h: { file: engravingFile }, job: engravingJob, library,
    sheetCapability: () => ({ html: true }), readScoreDoc: async () => ({ title: "Saved audio" }),
    findVersion: () => ({ audioSeconds: 7.8 }), readScoreAbc: async () => abc,
    engrave: async () => { throw new Error("Edge could not print the sheet"); },
    config: { uiPort: 4173 }, console: { error() {} },
  });
  check(() => assert.equal(engravingJob.state, "done", "sheet rendering failure never fails saved audio"));
  check(() => assert.match(engravingJob.scoreWarning, /Sheet music could not be engraved\. Edge could not print the sheet/));
  const afterEngraving = new Library(); await afterEngraving.load();
  check(() => assert.equal(afterEngraving.meta.get(engravingFile).scoreWarning, engravingJob.scoreWarning));
  check(() => assert.equal(afterEngraving.meta.get(engravingFile).scoreSlug, "saved"));
  check(() => assert.equal(afterEngraving.meta.get(engravingFile).scoreVersion, "v1"));
  check(() => assert.match(indexSource, /isYueComfy && job\.yueComfyScore\?\.abc/));
  check(() => assert.match(indexSource, /isYueComfy \? await adoptComfyVersion/));
  check(() => assert.match(indexSource, /scoreSlug: score\?\.slug \?\? null, scoreVersion: score\?\.version \?\? null/));
  console.log(`ComfyUI score capture: ${pass} checks passed`);
} finally {
  if (path.dirname(temporary) !== path.resolve(tmpdir()) || !path.basename(temporary).startsWith("aiplay-comfy-score-")) throw new Error("Unexpected test directory");
  await rm(temporary, { recursive: true, force: true });
}
