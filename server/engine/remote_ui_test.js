import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
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

test("the Pod bootstrap installs this Studio's own commit, never a branch that moves", () => {
  /* Review of 40f5859, S2, and again on 7b241ea: the page showed a curl | bash
   * of a branch's head with no checksum, and the script fast-forwarded that
   * branch at every rerun. The command is now the Studio's own
   * (runpod-bootstrap.js, remote_guard_test §6). */
  const sh = read("worker", "bootstrap-runpod.sh");
  assert.match(sh, /REPO="\$\{AIPLAY_REPOSITORY:-\}"\s*COMMIT="\$\{AIPLAY_COMMIT:-\}"/, "no default repository, no branch");
  assert.doesNotMatch(sh, /AIPLAY_BRANCH|merge --ff-only|--branch|bani4kaskashka/);
  const html = read("web", "index.html");
  assert.match(html, /id="runpodBootstrapCommand"[^>]*readonly[^>]*><\/textarea>/, "the page holds no command of its own");
  assert.doesNotMatch(html, /raw\.githubusercontent\.com/);
  assert.match(read("web", "runpod-integrated.js"), /api\("\/bootstrap"\)\.then\(\(b\) => \{\s*\$\("runpodBootstrapCommand"\)\.value = b\.command \|\| "";/, "it asks the Studio");
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
  /* The Python kit now answers for its own runtime. Run the actual button
   * condition so adding that branch cannot break remote ComfyUI readiness. */
  const gate = /create\.disabled = ([^;]+);/.exec(app)?.[0];
  assert.ok(gate, "the Music button still has a readiness condition");
  const disabled = ({ runtime = "comfy", ready, engineReady = false, remoteOnly = true, nativeReady = false, noPath = false } = {}) => {
    const create = {};
    runInNewContext(gate, { create, noPath, nativeReady, eng: { runtime, ready }, state: { engineReady, remoteOnly } });
    return create.disabled;
  };
  assert.equal(disabled(), false, "remote ComfyUI does not require a local engine");
  assert.equal(disabled({ remoteOnly: false }), true, "local ComfyUI still requires its engine");
  assert.equal(disabled({ runtime: "python", ready: false }), true, "a Pod does not repair a missing local Python kit");
  assert.equal(disabled({ runtime: "python", ready: true, remoteOnly: false }), false, "a ready separate Python kit does not require ComfyUI");
  assert.equal(disabled({ runtime: "audiocpp" }), true, "local native music still requires its runtime");
  assert.equal(disabled({ noPath: true }), true, "no launch mode enables an absent render path");
});

/* RUNPOD IS ADVANCED ONLY (the owner's decision, 2026-09-26). It ships in the
 * public build, but nothing about it shows in Simple: no launch mode, no star,
 * no RunPod box and no Remote numbers. Advanced keeps the whole mode. A
 * friend's card stays the first advice for a weak card. */
test("the launcher offers RunPod GPU only when Studio opens on Advanced", async () => {
  const { modesForLevel, modeAllowed, launcherLevel, ADVANCED_MODES, advancedOnlyLine, cardAdvice } = await import("../../launcher/checks.mjs");
  assert.deepEqual([...ADVANCED_MODES], ["runpod"]);
  const modes = { full: { available: true }, music: { available: true }, cloud: { available: true }, runpod: { available: true } };
  assert.deepEqual(Object.keys(modesForLevel(modes, "simple")), ["full", "music", "cloud"], "Simple: no RunPod card");
  assert.deepEqual(Object.keys(modesForLevel(modes, "advanced")), ["full", "music", "cloud", "runpod"], "Advanced keeps it");
  assert.equal(modeAllowed("runpod", "simple"), false);
  assert.equal(modeAllowed("cloud", "simple"), true);
  assert.match(advancedOnlyLine("RunPod GPU"), /^RunPod GPU is in Advanced only\. Turn on "Show every setting" in Studio's Settings/);
  /* The level is Studio's own answer from the same file (server/welcome/startlevel.js). */
  assert.equal(launcherLevel(null), "simple", "no settings.json: a new install opens Simple");
  assert.equal(launcherLevel(JSON.stringify({ rig: "C:/rig", python: "C:/py.exe", gpu: { vendor: "nvidia" } })), "simple", "what the launcher writes is not use");
  assert.equal(launcherLevel(JSON.stringify({ api: { enabled: false } })), "advanced", "an install in use keeps Advanced");
  assert.equal(launcherLevel(JSON.stringify({ prefs: { ui: { level: "advanced", levelBy: "you" } } })), "advanced");
  assert.equal(launcherLevel(JSON.stringify({ api: {}, prefs: { ui: { level: "simple", levelBy: "you" } } })), "simple", "a saved choice wins");
  assert.equal(launcherLevel('{"rig": "x",}'), "advanced", "a file that cannot be parsed keeps Advanced, as in Studio");
  assert.equal(launcherLevel("\uFEFF{}"), "advanced", "...a byte-order mark included");
  const cfg = read("server", "config.js");
  assert.match(cfg, /import \{ LEVELS, IN_USE_KEYS, startLevel \} from "\.\/welcome\/startlevel\.js";/, "one rule for Studio and the launcher");
  assert.doesNotMatch(cfg, /export function startLevel\(/, "no second copy in config.js");
  /* A friend's card first, Comfy API second, and no Pod in the advice. */
  const adv = cardAdvice({ gpu: { name: "GTX 1650", totalMb: 4096, vendor: "nvidia" }, torchOnCard: true });
  assert.deepEqual(Object.keys(adv), ["why", "friend", "cloud"]);
  assert.doesNotMatch(JSON.stringify(adv), /runpod|\bpod\b/i);
  const html = read("launcher", "index.html");
  const at = html.indexOf('id="friendCard"');
  const friend = html.slice(at, html.indexOf("</article>", at));
  assert.ok(friend.indexOf("Ask a friend") > 0 && friend.indexOf("Ask a friend") < friend.indexOf("Or use Comfy API"), "the friend comes first");
  assert.doesNotMatch(friend, /runpod/i);
});

test("the launcher's server and page: hidden, not started and not saved as a favourite on Simple", () => {
  const mjs = read("launcher", "launcher.mjs");
  assert.match(mjs, /if \(url\.pathname === "\/api\/check"\) return send\(res, 200, await checkForPage\(await getCheck\(/, "the page gets the modes of this level");
  assert.match(mjs, /return \{ \.\.\.c, level, modes: modesForLevel\(c\.modes, level\) \};/);
  assert.match(mjs, /if \(!modeAllowed\(mode, await studioLevel\(\)\)\) throw new Error\(advancedOnlyLine\(MODE_NAME\[mode\] \|\| mode\)\);/, "a launch is refused");
  assert.match(mjs, /if \(!modeAllowed\(b\.autoLaunch, await studioLevel\(\)\)\) return send\(res, 400, \{ error: advancedOnlyLine\(MODE_NAME\[b\.autoLaunch\]\) \}\);/, "a star is refused");
  assert.match(mjs, /autoLaunch: fav && modeAllowed\(fav, level\) \? fav : null,/, "a saved RunPod star is not started on Simple");
  assert.match(mjs, /const mode = launcherPrefs\(\(await readJson\(SETTINGS\)\) \|\| \{\}, await studioLevel\(\)\)\.autoLaunch;/);
  /* The check itself is cached; the level is read at every ask. */
  const studioLevel = mjs.slice(mjs.indexOf("async function studioLevel() {"), mjs.indexOf("async function checkForPage("));
  assert.match(studioLevel, /catch \(err\) \{ if \(err\?\.code !== "ENOENT"\) return "advanced"; \}\s*return launcherLevel\(text\);/);
  const html = read("launcher", "index.html");
  assert.match(html, /<article class="card mode" id="mode-runpod" data-mode="runpod" data-level="advanced" tabindex="0" role="listitem" hidden>/, "hidden until the check offers it");
  assert.match(html, /if \(card\.dataset\.level === "advanced"\) card\.hidden = !\(check\?\.modes\?\.\[m\] \|\| mine\);/, "shown at Advanced, or while it runs");
  assert.match(html, /@media \(min-width: 1081px\) \{ \.modes:has\(> \.mode\[hidden\]\) \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \} \}/);
});

test("Studio's Simple screens show no RunPod box, and RunPod GPU mode offers no Simple", () => {
  const css = read("web", "styles.css");
  const keepRule = /\.assist-on > ((?::not\([^)]+\))+) \{ display: none !important; \}/.exec(css)?.[1] || "";
  assert.ok(keepRule.length > 100, "the Simple rule was read");
  assert.doesNotMatch(keepRule, /runpod/i, "no RunPod box, so no Remote CFG, negative, size or guidance, in Simple");
  /* The server names the screens that open Advanced in RunPod GPU mode, and only there. */
  const probe = (remote) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e",
    "const {levelState}=await import('./server/welcome/level.js');console.log(JSON.stringify(levelState().advancedOnly||null))"],
  { cwd: ROOT, env: { ...process.env, AIPLAY_APPDATA: path.join(tmpdir(), `aiplay-remote-level-${process.pid}`),
    AIPLAY_MUSIC_ONLY: "0", AIPLAY_CLOUD_ONLY: "0", AIPLAY_REMOTE_ONLY: remote ? "1" : "0" } }).toString());
  const on = probe(true);
  assert.deepEqual(on?.screens, ["create", "images", "video"]);
  assert.match(on?.why || "", /^RunPod GPU is an Advanced launch mode: while it runs, Music, Pictures and Video open on Advanced/);
  assert.equal(probe(false), null, "full Studio, Music only and Comfy API: the level as saved");
  const assist = read("web", "assist.js"), app = read("web", "app.js");
  assert.match(assist, /if \(lock\(n\.advancedOnly\)\) return;\s*if \(n\.view && n\.view !== P\.view\) return;/, "Pictures and Video: no news opens Simple");
  assert.match(assist, /if \(!b \|\| \(locked && b\.dataset\.m === "simple"\)\) return;/, "...nor the Simple button");
  assert.match(assist, /simpleBtn\.disabled = locked;\s*simpleBtn\.title = locked \? only\.why : simpleTip;/, "which says why");
  assert.match(app, /if \(musicLock\(n\.advancedOnly\)\) return;\s*if \(n\.view && n\.view !== "create"\) return;/, "Music the same");
  assert.match(app, /if \(b\) \{ b\.disabled = locked; b\.title = locked \? only\.why : musicSimpleTip; \}/);
  assert.match(read("web", "level.js"), /\[st\.line, st\.advancedOnly\?\.why\]\.filter\(Boolean\)\.join\(" "\)/, "Settings' line says why");
});
