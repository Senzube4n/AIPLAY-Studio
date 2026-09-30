import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { imageWorkflowOptions, modelChoices, videoWorkflowOptions } from "../../web/runpod-integrated.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts) => readFileSync(path.join(ROOT, ...parts), "utf8");

test("the Images and Video screens carry the RunPod controls (shown in RunPod GPU mode only)", () => {
  const html = read("web", "index.html");
  assert.match(html, /id="imgRenderWhere"[\s\S]*value="local"[\s\S]*value="runpod"/);
  assert.match(html, /id="vidRenderWhere"[\s\S]*value="local"[\s\S]*value="runpod"/);
  assert.match(html, /id="runpodWorkerToken"[^>]*type="password"/);
  assert.match(html, /id="runpodApiKey"[^>]*type="password"/);
  assert.match(html, /id="runpodAccountDisconnect"/);
  assert.match(html, /id="runpodReviewPod"/);
  assert.match(html, /id="runpodCostConfirm"[^>]*type="checkbox"/);
  assert.match(html, /id="runpodCreatePod"[^>]*disabled/);
  assert.match(html, /id="runpodCreateTemplates"/);
  assert.match(html, /id="runpodTemplateState"/);
  assert.match(html, /id="runpodBootstrapCommand"[^>]*readonly/);
  assert.match(html, /id="runpodModelList"/);
  assert.match(html, /id="runpodCancelModel"/);
  assert.match(html, /id="imgRunPodCfg"[^>]*value="6"/);
  assert.match(html, /id="imgRunPodNegative"/);
  assert.match(html, /id="vidRunPodSize"[\s\S]*value="512x320"/);
  assert.match(html, /id="vidRunPodGuidance"[^>]*value="3"/);
  assert.match(html, /src="runpod-integrated\.js"/);
  const worker = read("worker", "runpod-worker.js");
  assert.match(worker, /\/v1\/setup\/install/);
  assert.match(worker, /modelSetupVersion: 1/);
});

test("ComfyUI legacy and 0.37 COMBO model choices both populate the integrated picker", () => {
  assert.deepEqual(modelChoices([["a.safetensors", "b.safetensors"]]), ["a.safetensors", "b.safetensors"]);
  assert.deepEqual(modelChoices(["COMBO", { options: ["new.safetensors"] }]), ["new.safetensors"]);
});

test("integrated image options retain the selected remote checkpoint and common controls", () => {
  assert.deepEqual(imageWorkflowOptions({ prompt: "lake", checkpoint: "sd15.safetensors", width: 512,
    height: 512, steps: 20, seed: 7, count: 2, negative: "blur", cfg: 6.5 }), {
    prompt: "lake", checkpoint: "sd15.safetensors", ckpt: "sd15.safetensors", width: 512,
    height: 512, steps: 20, seed: 7, count: 2, negative: "blur", cfg: 6.5,
  });
});

test("integrated LTX options retain video controls and duration aliases", () => {
  assert.deepEqual(videoWorkflowOptions({ prompt: "robot", negative: "blur", width: 512, height: 320,
    seconds: 2, steps: 8, seed: 9, guidance: 3 }), {
    prompt: "robot", negative: "blur", width: 512, height: 320, seconds: 2,
    duration: 2, maxDuration: 2, steps: 8, seed: 9, guidance: 3,
  });
});

test("remote-only launch opens the integrated application", () => {
  const server = read("server", "index.js");
  assert.match(server, /`http:\/\/127\.0\.0\.1:\$\{config\.uiPort\}`/);
  assert.doesNotMatch(server, /config\.remoteOnly \? "\/runpod\.html"/);
});

/* THE LAUNCHER'S RUNPOD GPU MODE ONLY (2026-09-25). A Pod bills by the hour and
 * the account routes can create one, so full Studio, Music only and Comfy API
 * never show or serve any of it: the no-credits promise of full Studio. */
test("RunPod lives in its own launch mode and nowhere else", () => {
  const html = read("web", "index.html");
  assert.match(html, /id="imgRunPodBlock" hidden/);
  assert.match(html, /id="vidRunPodBlock" hidden/);
  assert.match(html, /<select id="imgRenderWhere" class="sel2" hidden>/, "no local choice in a mode with no local engine");
  assert.doesNotMatch(html, /href="\/runpod\.html" title="RunPod remote rendering"/, "no rail link in full Studio");
  const js = read("web", "runpod-integrated.js");
  assert.match(js, /if \(!status\?\.config\?\.remoteOnly\) return;/);
  const init = js.slice(js.indexOf("async function init() {"));
  assert.ok(init.indexOf("if (!status?.config?.remoteOnly) return;") < init.indexOf("refreshWorker().catch"), "nothing is asked before the mode is known");
  assert.doesNotMatch(js, /localStorage/, "the target is the mode, not a remembered choice");
  const server = read("server", "index.js");
  assert.match(server, /const remoteRoutes = config\.remoteOnly \? createRemoteRoutes\(/);
  assert.match(server, /if \(!remoteRoutes\) return json\(res, 404, \{ error: "RunPod rendering is the launcher's RunPod GPU mode/);
  const config = read("server", "config.js");
  assert.match(config, /const REMOTE_ONLY = !MUSIC_ONLY && !CLOUD_ONLY && process\.env\.AIPLAY_REMOTE_ONLY === "1";/);
  assert.match(config, /comfyAutoStart: !MUSIC_ONLY && !CLOUD_ONLY && !REMOTE_ONLY,/);
  const launcher = read("launcher", "launcher.mjs");
  assert.match(launcher, /mode === "runpod" \? path\.join\("scripts", "start-remote\.mjs"\)/);
  assert.match(launcher, /AIPLAY_REMOTE_ONLY: mode === "runpod" \? "1" : "0"/);
  assert.match(read("launcher", "index.html"), /data-launch="runpod"/);
  assert.match(read("scripts", "start-remote.mjs"), /AIPLAY_REMOTE_ONLY = "1"/);
});

test("the Pod bootstrap installs this repository, not a contributor's branch", () => {
  const sh = read("worker", "bootstrap-runpod.sh");
  assert.match(sh, /AIPLAY_REPOSITORY:-https:\/\/github\.com\/Senzube4n\/AIPLAY-Studio\.git/);
  assert.match(sh, /AIPLAY_BRANCH:-main\}/);
  const html = read("web", "index.html");
  assert.match(html, /raw\.githubusercontent\.com\/Senzube4n\/AIPLAY-Studio\/main\/worker\/bootstrap-runpod\.sh/);
  assert.match(sh, /check-comfy-loopback\.js/);
  assert.match(sh, /different Git origin/);
  assert.match(read("worker", "runpod-worker.js"), /await checkComfyLoopback\(\);/, "worker autostart also verifies the listener");
  assert.doesNotMatch(html, /nemesisone-dev\/AIPLAY-Studio\/feature/);
});

/* MUSIC ON THE POD (2026-09-25): in RunPod GPU mode the music queue builds the
 * graph it builds for this PC and renders it on the Pod; the song is filed by
 * the queue's usual "done" path under an aiplay_ name the library lists. */
test("RunPod GPU mode renders music on the Pod too", () => {
  const jobs = read("server", "jobs.js");
  assert.match(jobs, /setRemote\(fn\) \{ this\.remote = typeof fn === "function" \? fn : null; \}/);
  assert.match(jobs, /if \(this\.remote\) return await this\.#runRemote\(job, graph\);/);
  assert.match(jobs, /if \(!config\.api\?\.enabled && !this\.remote && !this\.comfy\.ready/, "the queue does not wait for a local engine");
  assert.match(jobs, /if \(!this\.remote\) await this\.connect\(\);/);
  const server = read("server", "index.js");
  assert.match(server, /if \(remoteRoutes\) jobs\.setRemote\(async \(\{ graph, label, actor, isCancelled, onState \}\) => \{/);
  assert.match(server, /const name = `aiplay_runpod_\$\{details\.runId\}_\$\{path\.basename\(details\.output\.file\)\}`;/, "a name the library lists");
  assert.match(server, /if \(cap && !cap\.ready && !config\.remoteOnly\) \{/, "the Pod, not this disk, decides");
  assert.match(server, /c\.note = "on your RunPod";/);
  const app = read("web", "app.js");
  assert.match(app, /create\.disabled = noPath \|\| \(eng\.runtime === "audiocpp" \? !nativeReady : !state\.engineReady && !state\.remoteOnly\);/);
});
