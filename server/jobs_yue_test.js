/**
 * The runner's second kind of work — a YuE2 job — driven through a fake door in
 * milliseconds: no card, no python, no weights. What is under test is the
 * queue's own behaviour around the door: the card handover, the landing under
 * the library's prefix, the stage mapping, the single filing, and cancel
 * reaching a process the door owns.
 */
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { JobRunner } from "./jobs.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const tmp = mkdtempSync(path.join(tmpdir(), "aiplay-jobs-yue-"));
config.outputDir = tmp;

/* `on` because the constructor subscribes to the supervisor's "died". */
const comfyReady = { ready: true, on() {} };
const comfyDown = { ready: false, on() {} };

function fakeYue({ fail = null, hang = false } = {}) {
  const calls = { queue: 0, free: 0, freeOpts: null, killed: 0, render: null, release: null };
  return {
    calls,
    engine: {
      queue: async () => { calls.queue++; return { queue_running: [], queue_pending: [] }; },
      freeMemory: async (o) => { calls.free++; calls.freeOpts = o; return { freed: true }; },
    },
    spawn: () => ({ pid: 4242 }),
    runDriver: async () => { throw new Error("the fake renderSong never reaches the runner"); },
    killTree: async () => { calls.killed++; if (calls.release) calls.release(); return true; },
    renderSong: async (o) => {
      calls.render = o;
      /* The door hands the runner a spawnFn to wrap; a real door calls it from
       * runYueDriver. Call it here so job.proc exists for the cancel test. */
      o.runner([], { spawnFn: (cmd, argv, opts) => ({ pid: 4242, cmd, argv, opts }) }).catch(() => {});
      o.onProgress({ stage: "semantic", status: "running", fraction: 0.5, overall: 0.4 });
      if (hang) await new Promise((r) => { calls.release = r; });
      if (calls.killed) throw new Error("killed by the test");
      if (fail) throw new Error(fail);
      await new Promise((r) => setTimeout(r, 5));
      const audio = path.join(o.out, "audio.flac");
      writeFileSync(audio, "fLaC-fake");
      o.onProgress({ stage: "vae", status: "completed", fraction: 1, overall: 0.99 });
      return { ok: true, out: audio, dir: o.out, audioSeconds: 12.3, runId: "run_fake",
               realtimeRatio: 2.6, truncated: null };
    },
  };
}
const settle = (runner) => new Promise((resolve) => {
  const tick = () => {
    const h = runner.history[0];
    if (h && !runner.current) resolve(h); else setTimeout(tick, 5);
  };
  tick();
});

console.log("\nA YUE2 JOB THROUGH THE RUNNER");
{
  const yue = fakeYue();
  /* The fake door's runner wrapper: the runner passes `runner: (args, o) =>
   * y.runDriver(args, {...o, spawnFn})`; the fake calls it once so the wrapped
   * spawnFn runs and job.proc is set, then ignores the rejection. */
  yue.runDriver = async (args, o) => { o.spawnFn("python", args, {}); throw new Error("fake"); };
  const runner = new JobRunner(comfyReady, { yue });
  const stages = [];
  runner.on("update", (s) => { if (s.current?.stage) stages.push(s.current.stage); });
  const job = runner.enqueue({
    engine: "yue2", title: "Fake", caption: "warm folk", lyrics: "la la", seed: 7, cot: "full",
    rung: { id: "long", label: "Long", offloadAr: true, quantization: "none", queryChunk: 512 },
    wantSeconds: 200, actor: "user",
  });
  ok("the estimate is the yue ratio plus the planning stage, not MiniMax's",
    job.etaSeconds === Math.round(200 * 2.65 + 111), String(job.etaSeconds));
  const done = await settle(runner);
  ok("it lands as done with a file under the library's prefix",
    done.state === "done" && /^aiplay_yue2_/.test(done.file), `${done.state} ${done.file}`);
  ok("...and the file is in outputDir", !!done.file && existsSync(path.join(tmp, done.file)));
  ok("...copied, not moved: the run folder keeps its audio for the receipt",
    existsSync(path.join(tmp, "yue2", job.id, "audio.flac")));
  ok("the card was yielded first: the engine queue read, then its models unloaded",
    yue.calls.queue >= 1 && yue.calls.free === 1 && yue.calls.freeOpts?.unloadModels === true,
    JSON.stringify(yue.calls.freeOpts));
  ok("the door got the rung's arguments and the runner's own via",
    yue.calls.render.queryChunk === 512 && yue.calls.render.offloadAr === true
    && yue.calls.render.quantization === "none" && yue.calls.render.via === "jobs.music"
    && yue.calls.render.style === "warm folk" && yue.calls.render.seed === 7);
  ok("progress reached the queue's stages", stages.includes("semantic") && stages.includes("vae"),
    stages.join(","));
  const v = runner.snapshot().history[0];
  ok("the snapshot names the engine, the rung and the audio length",
    v.engine === "yue2" && v.audioSeconds === 12.3 && v.rung?.id === "long", JSON.stringify(v));
  ok("the driver's stage key reads in words, not as a key",
    stages.includes("semantic") && runner.snapshot().history[0].stageLabel !== "semantic");
  ok("it was filed exactly once", runner.history.length === 1 && runner.current === null);
  ok("the runId travels on the job for the ledger", done.runId === "run_fake" && done.yue?.dir?.endsWith(job.id));
}

console.log("\nA USER'S PRECISION CHOICE WINS OVER THE RUNG'S");
{
  const yue = fakeYue();
  yue.runDriver = async () => { throw new Error("fake"); };
  const runner = new JobRunner(comfyReady, { yue });
  runner.enqueue({ engine: "yue2", title: "fp8", caption: "x", lyrics: "", seed: 1, actor: "user",
    quantization: "fp8", rung: { id: "long", label: "Long", offloadAr: true, quantization: "none", queryChunk: 512 } });
  await settle(runner);
  ok("fp8 asked for by name reaches the door although the rung says none",
    yue.calls.render.quantization === "fp8" && yue.calls.render.queryChunk === 512);
}

console.log("\nA FAILED DRIVER");
{
  const yue = fakeYue({ fail: "Waiting for 11.5 GiB of the graphics card to be free." });
  yue.runDriver = async () => { throw new Error("fake"); };
  const runner = new JobRunner(comfyReady, { yue });
  runner.enqueue({ engine: "yue2", title: "Fails", caption: "x", lyrics: "", seed: 1, actor: "user" });
  const h = await settle(runner);
  ok("a refusal lands as a failed job carrying the door's own sentence",
    h.state === "failed" && /11\.5 GiB/.test(h.error), h.error);
  ok("...filed once, queue free", runner.history.length === 1 && runner.current === null);
}

console.log("\nCANCEL REACHES THE DRIVER");
{
  const yue = fakeYue({ hang: true });
  yue.runDriver = async (args, o) => { o.spawnFn("python", args, {}); throw new Error("fake"); };
  const runner = new JobRunner(comfyReady, { yue });
  const job = runner.enqueue({ engine: "yue2", title: "Hangs", caption: "x", lyrics: "", seed: 1, actor: "user" });
  await new Promise((r) => setTimeout(r, 40));          // let it reach renderSong
  ok("the process handle was caught on the way past", !!job.proc && job.proc.pid === 4242);
  const c = await runner.cancelById(job.id);
  ok("cancel answers pending and kills the process tree",
    c.state === "cancelling" && c.pending === true && yue.calls.killed === 1, JSON.stringify(c));
  const h = await settle(runner);
  ok("...and the job files as cancelled, exactly once",
    h.state === "cancelled" && runner.history.length === 1 && runner.current === null,
    `${h.state} x${runner.history.length}`);
  ok("...with the handle released", job.proc === null);
}

console.log("\nMINIMAX JOBS ARE UNTOUCHED, AND YUE2 DOES NOT WAIT FOR COMFYUI");
{
  const yue = fakeYue();
  const runner = new JobRunner(comfyDown, { yue });
  runner.enqueue({ title: "MiniMax", caption: "x", lyrics: "", seed: 1 });
  await new Promise((r) => setTimeout(r, 20));
  ok("a MiniMax job waits for ComfyUI to be ready and never touches the yue door",
    runner.current === null && runner.queue.length === 1 && yue.calls.render === null);
  const yue2 = fakeYue();
  yue2.runDriver = async () => { throw new Error("fake"); };
  const r2 = new JobRunner(comfyDown, { yue: yue2 });
  r2.enqueue({ engine: "yue2", title: "y", caption: "x", lyrics: "", seed: 1, actor: "user" });
  const h = await settle(r2);
  ok("a yue2 job renders with ComfyUI down, and asks nothing of an engine that is not there",
    h.state === "done" && yue2.calls.free === 0, `${h.state} free=${yue2.calls.free}`);
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
if (failures.length) console.log(failures.map((f) => `  - ${f}`).join("\n"));
process.exit(failures.length ? 1 : 0);
