/**
 * A FRESH ENGINE BEFORE AN H3 CLIP, WHERE A USED ONE RUNS AT HALF SPEED.
 *
 * Measured 2026-09-24 on an RX 9060 XT (ROCm, Windows, dynamic VRAM), H3
 * 1344x768, 8 steps: a fresh engine process sampled at ~82 s a step, the
 * next render in the same process at ~152 s (4.1 GB spilled to shared
 * memory). ComfyUI's /free with unload_models did not bring it back; a
 * restarted engine did (78 s). So art.js restarts an engine that has
 * rendered anything before an H3 or FastH3 clip, on AMD and Intel cards
 * unless the person says otherwise (video_settings free_before_clip).
 *
 * NOT ON NVIDIA, NOT ON A GUESS (2026-09-25). An NVIDIA rig whose
 * settings.json had no `gpu` and no `torchBackend` read as vendor null, which
 * "auto" treated as "not NVIDIA": ComfyUI restarted before every H3 clip
 * there. The vendor now comes from the settings and, where they name no card,
 * from gpu.js's live reading (art.js cardVendor), and a card nobody could
 * read is not restarted on "auto".
 *
 * NEVER OVER OTHER WORK, ON ANY CARD. Bucky's wait (40f5859,
 * waitForQuietEngine) holds the restart while a song renders or ComfyUI's own
 * queue has work, and it now also reads what that queue does not show
 * (otherWorkOnEngine): the engine door's own runs, another art job, a plan
 * mid-step. One mechanism, on every card. A clip that waits is not on the
 * engine, so its Stop ends the wait and interrupts nothing (video-fail_test
 * runs that through the real runner).
 *
 * AMD, INTEL AND THE CPU AS 40f5859 (Bucky's rule, relayed by the owner:
 * "Make it available only for Nvidia. AMD is locked by my tests."): the same
 * vendor from the same settings, the same restart on "auto", the same
 * deadline. A CPU-only install or a Mac (gpu.vendor "cpu", or a "cpu" torch)
 * kept its restart there, and lost it once (the port restarted only "amd" and
 * "intel").
 *
 * WORK MADE OF SEVERAL DOOR RUNS HOLDS THE DOOR (engine/client.js hold()): a
 * Reactive Paint look posts one run per frame, and between two frames the
 * door and ComfyUI's queue are empty. The restart went there, the next frame
 * was refused, and the whole paint render was lost.
 *
 *   node --test server/fresh-engine_test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const { clipNeedsCleanCard, waitForQuietEngine, otherWorkOnEngine, cardVendor, clipBudgetMs } = await import("./art.js");
const { vendorOf } = await import("./comfyargs.js");
const { config } = await import("./config.js");

/* A fake clock for the wait: sleeping moves time, nothing really sleeps. */
function clockAt(start = 0) {
  const c = { t: start };
  c.now = () => c.t;
  c.sleep = async (ms) => { c.t += ms; };
  return c;
}
const EMPTY_Q = async () => ({ queue_running: [], queue_pending: [] });

test("auto: AMD, Intel and the CPU start an H3 clip on a fresh engine; NVIDIA and a card nobody could read do not", () => {
  for (const vendor of ["amd", "intel", "cpu"]) assert.equal(clipNeedsCleanCard("h3", { vendor }), true, `H3 on ${vendor}`);
  assert.equal(clipNeedsCleanCard("fasth3", { vendor: "cpu" }), true, "a CPU-only install or a Mac, as main");
  assert.equal(clipNeedsCleanCard("fasth3", { vendor: "amd" }), true, "FastH3 is the same model family");
  assert.equal(clipNeedsCleanCard("h3", { vendor: "nvidia" }), false, "not seen on NVIDIA: auto leaves it alone");
  assert.equal(clipNeedsCleanCard("fasth3", { vendor: "nvidia" }), false);
  assert.equal(clipNeedsCleanCard("h3", { vendor: null }), false, "an unknown card is not restarted on a guess");
  assert.equal(clipNeedsCleanCard("h3", { vendor: "nvidia", mode: "always" }), true, "always is the person's to force");
  assert.equal(clipNeedsCleanCard("h3", { vendor: null, mode: "always" }), true);
  assert.equal(clipNeedsCleanCard("h3", { vendor: "amd", mode: "never" }), false);
  assert.equal(clipNeedsCleanCard("ltx", { vendor: "amd", mode: "always" }), false, "measured on H3 only");
  assert.equal(config.video.freeBeforeClip, "auto");
});

/* Senzu's review (2026-09-25): the restart killed a song or an engine-door
 * graph that was running at that moment. It waits for both now, and skips the
 * restart rather than kill anything when the card never frees. */
test("the restart waits for a running song and for the engine queue", async () => {
  let t = 0;
  const clock = { now: () => t, sleep: async (ms) => { t += ms; } };
  let songUntil = 6000;
  const quiet = await waitForQuietEngine({ ...clock, musicBusy: () => t < songUntil, engineQueue: async () => ({ queue_running: [], queue_pending: [] }) });
  assert.equal(quiet, true);
  assert.ok(t >= songUntil, "waited for the song");
  t = 0;
  const q = [["x"]];
  const busyQ = await waitForQuietEngine({ ...clock, musicBusy: () => false, engineQueue: async () => ({ queue_running: t < 4000 ? q : [], queue_pending: t < 8000 ? q : [] }) });
  assert.equal(busyQ, true);
  assert.ok(t >= 8000, "pending counts too");
  t = 0;
  const never = await waitForQuietEngine({ ...clock, timeoutMs: 10000, musicBusy: () => true, engineQueue: async () => null });
  assert.equal(never, false, "gives up rather than kill it");
  t = 0;
  assert.equal(await waitForQuietEngine({ ...clock, musicBusy: () => false, engineQueue: async () => { throw new Error("down"); } }), true, "an engine that does not answer has nothing to lose");
});

test("the wait also reads what ComfyUI's queue does not show: the door's own runs, another art job, a plan mid-step", async () => {
  /* The words, one reading each. */
  assert.equal(otherWorkOnEngine({}), null, "nothing else on the card");
  assert.equal(otherWorkOnEngine({ doorRuns: 2 }), "the engine door has 2 other run(s) in flight");
  assert.equal(otherWorkOnEngine({ artOther: true }), "another job of the art queue is on the engine");
  assert.equal(otherWorkOnEngine({ plans: "an overnight run" }), "an overnight run is in the middle of a step");
  assert.equal(otherWorkOnEngine({ doorRuns: 1, plans: "an overnight run" }), "the engine door has 1 other run(s) in flight", "the engine first");
  assert.equal(otherWorkOnEngine({ held: ["a Reactive Paint look"] }), "a Reactive Paint look is between two of its runs on the engine",
    "a job of several door runs, between two of them");
  assert.equal(otherWorkOnEngine({ held: [], artOther: true }), "another job of the art queue is on the engine");
  assert.equal(otherWorkOnEngine({ held: ["a chat turn"], plans: "an overnight run" }), "a chat turn is between two of its runs on the engine");
  /* A music tool (YuE2 training and the other community tools) holds the card
   * in its own process: the restart would be wasted and the clip refused by
   * the door anyway ("Music tools are busy"), new since 40f5859. */
  assert.equal(otherWorkOnEngine({ tools: "train" }), "a music tool (train) is running");
  assert.equal(otherWorkOnEngine({ tools: "train", artOther: true }), "a music tool (train) is running", "before another art job");

  /* A Reactive Paint look (check_1 probe_frames, the real wait): frames of
   * 3 s with 150 ms between them. Without its hold the wait answered "quiet"
   * in a gap and the restart stopped the engine under the next frame. With it
   * the wait holds until the look ends. */
  {
    const c = clockAt();
    const FRAME = 3000, GAP = 150, FRAMES = 40;
    const doorRunAt = (t) => t < FRAMES * (FRAME + GAP) && (t % (FRAME + GAP)) < FRAME;
    const unheld = await waitForQuietEngine({ ...c, musicBusy: () => false, engineQueue: EMPTY_Q,
      otherWork: async () => otherWorkOnEngine({ doorRuns: doorRunAt(c.t) ? 1 : 0 }) });
    assert.equal(unheld, true);
    assert.ok(c.t < FRAMES * (FRAME + GAP), "without the hold: 'quiet' in a gap, mid-render");
    const c2 = clockAt();
    const held = await waitForQuietEngine({ ...c2, musicBusy: () => false, engineQueue: EMPTY_Q,
      otherWork: async () => otherWorkOnEngine({ doorRuns: doorRunAt(c2.t) ? 1 : 0,
        held: c2.t < FRAMES * (FRAME + GAP) ? ["a Reactive Paint look"] : [] }) });
    assert.equal(held, true);
    assert.ok(c2.t >= FRAMES * (FRAME + GAP), "with it: after the last frame");
  }

  /* A run the door holds that ComfyUI's /queue does not list (staged, or
   * finished and not yet read back): the wait holds until it is gone. */
  const c = clockAt();
  const heard = [];
  const freed = await waitForQuietEngine({ ...c, musicBusy: () => false, engineQueue: EMPTY_Q,
    otherWork: async () => (c.t < 6000 ? otherWorkOnEngine({ doorRuns: 1 }) : null), onBusy: (w) => heard.push(w) });
  assert.equal(freed, true);
  assert.ok(c.t >= 6000, "waited for the door's run");
  assert.deepEqual(heard, ["the engine door has 1 other run(s) in flight"], "the reason is said once, not every poll");

  /* A plan mid-step that never ends its step: the same 20-minute limit, then
   * the clip renders on the used engine. */
  const c2 = clockAt();
  assert.equal(await waitForQuietEngine({ ...c2, timeoutMs: 20 * 60_000, musicBusy: () => false, engineQueue: EMPTY_Q,
    otherWork: async () => otherWorkOnEngine({ plans: "the music-video plan for rewind" }) }), false);
  assert.ok(c2.t >= 20 * 60_000);

  /* otherWork is asked only once the song and ComfyUI's queue are quiet, so a
   * long song costs no status reads. */
  const c3 = clockAt();
  let asked = 0;
  await waitForQuietEngine({ ...c3, musicBusy: () => c3.t < 10_000, engineQueue: EMPTY_Q, otherWork: async () => { asked++; return null; } });
  assert.equal(asked, 1, "one reading, after the song");

  /* A reading that throws is not the engine: it cannot say the card is free. */
  const c4 = clockAt();
  const said = [];
  assert.equal(await waitForQuietEngine({ ...c4, timeoutMs: 6000, musicBusy: () => false, engineQueue: EMPTY_Q,
    otherWork: async () => { throw new Error("plan store unreadable"); }, onBusy: (w) => said.push(w) }), false);
  assert.deepEqual(said, ["work that could not be read"]);
});

test("Stop ends the wait at once, and nothing is restarted for it", async () => {
  const c = clockAt();
  let stop = false;
  const out = await waitForQuietEngine({ ...c, musicBusy: () => { if (c.t >= 4000) stop = true; return true; },
    engineQueue: EMPTY_Q, cancelled: () => stop });
  assert.equal(out, false, "not quiet: the clip does not restart");
  assert.ok(c.t < 10_000, "within a poll of the Stop, not at the 20-minute limit");
  const c2 = clockAt();
  assert.equal(await waitForQuietEngine({ ...c2, musicBusy: () => false, engineQueue: EMPTY_Q, cancelled: () => true }), false,
    "a clip stopped before it waited is not restarted either");
  assert.equal(c2.t, 0);
});

test("what starts while the rest of the card is read is read again before 'free': the song and ComfyUI's queue last", async () => {
  /* check_1's probe on the port: otherWork is engineDoor.status(), which stats
   * every stored graph (814 ms on the rig), and the music queue starts a song
   * whatever the art queue is doing. A song started and a prompt posted during
   * that read, and the wait said "free" with both on the card, so the restart
   * stopped them (review of the port, 2026-10-08). */
  const c = clockAt();
  let song = false, queued = 0;
  const free = await waitForQuietEngine({ ...c, timeoutMs: 10_000, musicBusy: () => song,
    engineQueue: async () => ({ queue_running: Array.from({ length: queued }, () => ["x"]), queue_pending: [] }),
    otherWork: async () => { song = true; queued = 1; return null; } });
  assert.equal(free, false, "never 'free' while the song that started during the read renders");
  /* A prompt posted alone during the read. */
  const c1 = clockAt();
  let posted = 0;
  const heard = [];
  assert.equal(await waitForQuietEngine({ ...c1, timeoutMs: 10_000, musicBusy: () => false,
    engineQueue: async () => ({ queue_running: Array.from({ length: posted }, () => ["x"]), queue_pending: [] }),
    otherWork: async () => { posted = 1; return null; }, onBusy: (w) => heard.push(w) }), false);
  assert.deepEqual(heard, ["ComfyUI has 1 job(s) running or waiting"]);
  /* A song that starts during the read and ends: the wait frees after it. */
  const c2 = clockAt();
  let started = false;
  assert.equal(await waitForQuietEngine({ ...c2, musicBusy: () => started && c2.t < 6000, engineQueue: EMPTY_Q,
    otherWork: async () => { started = true; return null; } }), true);
  assert.ok(c2.t >= 6000, "after the song");
  /* Stop pressed during the slow read: nothing is restarted for it. */
  const c3 = clockAt();
  let stop = false;
  assert.equal(await waitForQuietEngine({ ...c3, musicBusy: () => false, engineQueue: EMPTY_Q,
    otherWork: async () => { stop = true; return null; }, cancelled: () => stop }), false);
});

test("the vendor is the card this PC renders on: the settings first, the live reading where they name none", () => {
  /* Our rig on 2026-09-25: nvidia-smi answers, settings.json names no card. */
  assert.equal(cardVendor({ vendor: "nvidia", source: "nvidia-smi" }, {}), "nvidia");
  assert.equal(clipNeedsCleanCard("h3", { vendor: cardVendor({ vendor: "nvidia" }, { gpu: null, torchBackend: null }) }), false, "so it is not restarted");
  assert.equal(cardVendor(null, { torchBackend: "cuda" }), "nvidia", "a CUDA torch is NVIDIA's");
  assert.equal(cardVendor(null, { torchBackend: "rocm" }), "amd");
  assert.equal(cardVendor(null, { gpu: { vendor: "intel" } }), "intel");
  assert.equal(cardVendor({ vendor: "amd", source: "Windows GPU counters" }, {}), "amd", "the OS counters name AMD");
  assert.equal(cardVendor({ vendor: null, source: "settings.json" }, { gpu: { vendor: "amd" } }), "amd", "a reading with no vendor falls through");
  assert.equal(cardVendor(null, {}), null, "nobody could tell");
  assert.equal(cardVendor(null, null), null);
  /* A CPU-only install or a Mac: install-engine.mjs saves gpu.vendor "cpu",
   * setup a "cpu" torch. The settings still come first, so an NVIDIA card
   * nvidia-smi answers for beside a CPU torch keeps the CPU's rules. */
  assert.equal(cardVendor(null, { gpu: { vendor: "cpu" }, torchBackend: "cpu" }), "cpu");
  assert.equal(cardVendor({ vendor: "nvidia", source: "nvidia-smi" }, { torchBackend: "cpu" }), "cpu");
  assert.equal(clipNeedsCleanCard("h3", { vendor: cardVendor(null, { torchBackend: "cpu" }) }), true);
});

test("AMD, Intel and the CPU read exactly as 40f5859 reads them, whatever the live card says", () => {
  /* 40f5859: vendorOf(settings) alone; a rocm torch is AMD, and a null vendor
   * restarted too (anything but "nvidia"). */
  const vendor40 = (s) => s?.gpu?.vendor || (s?.torchBackend === "rocm" ? "amd" : null);
  const restart40 = (s) => vendor40(s) !== "nvidia";
  const budget40 = (s) => clipBudgetMs(299, vendor40(s));
  const SETTINGS = {
    amd_full: { gpu: { vendor: "amd", name: "AMD Radeon RX 9060 XT", totalMb: 16304 }, torchBackend: "rocm" },
    amd_rocm_only: { torchBackend: "rocm" },
    amd_vendor_only: { gpu: { vendor: "amd", totalMb: 8176 } },
    amd_zluda: { gpu: { vendor: "amd", totalMb: 16368 }, torchBackend: "cuda" },
    intel_full: { gpu: { vendor: "intel", totalMb: 16032 }, torchBackend: "xpu" },
    intel_xpu_only: { torchBackend: "xpu" },
    intel_vendor_only: { gpu: { vendor: "intel", totalMb: 12272 } },
    amd_cpu_torch: { gpu: { vendor: "amd", totalMb: 16368 }, torchBackend: "cpu" },
    intel_cpu_torch: { gpu: { vendor: "intel", totalMb: 12272 }, torchBackend: "cpu" },
    /* CPU installs (install-engine.mjs writes gpu.vendor "cpu" for every CPU
     * and every Mac install), and such a PC later pointed at a ROCm or XPU
     * ComfyUI: setup never reads the card again off Windows. */
    cpu_install: { gpu: { vendor: "cpu", name: "CPU only", totalMb: 0, source: "chosen at install" }, torchBackend: "cpu" },
    cpu_gpu_only: { gpu: { vendor: "cpu", name: "CPU only", totalMb: 0 } },
    cpu_torch_only: { torchBackend: "cpu" },
    cpu_gpu_rocm: { gpu: { vendor: "cpu", name: "CPU only", totalMb: 0 }, torchBackend: "rocm" },
    cpu_gpu_xpu: { gpu: { vendor: "cpu", name: "CPU only", totalMb: 0 }, torchBackend: "xpu" },
  };
  const LIVE = { none: null, noVendor: { vendor: null }, amd: { vendor: "amd" }, intel: { vendor: "intel" },
    nvidia: { vendor: "nvidia", source: "nvidia-smi" } };
  for (const [sk, s] of Object.entries(SETTINGS)) {
    for (const [lk, live] of Object.entries(LIVE)) {
      const v = cardVendor(live, s);
      assert.equal(clipNeedsCleanCard("h3", { vendor: v }), restart40(s), `${sk}, live ${lk}: the restart 40f5859 gives`);
      assert.equal(clipBudgetMs(299, v), budget40(s), `${sk}, live ${lk}: main's deadline`);
    }
  }
  /* The two that would move with a live-first reading: an AMD rig on ROCm with
   * a second NVIDIA card answering nvidia-smi keeps its 3x deadline (3,888 s
   * for the 299 s estimate; 1x killed the measured 1,617 s clip at 1,496 s)
   * and its fresh engine, and a Linux Intel PC whose setup saved only the xpu
   * torch (the live reading from ComfyUI's log names no vendor) keeps its
   * fresh engine. */
  assert.equal(cardVendor({ vendor: "nvidia", source: "nvidia-smi" }, SETTINGS.amd_full), "amd");
  assert.equal(clipBudgetMs(299, cardVendor({ vendor: "nvidia" }, SETTINGS.amd_full)), 3_888_000);
  assert.equal(cardVendor({ vendor: null, source: "ComfyUI log" }, SETTINGS.intel_xpu_only), "intel");
  assert.equal(clipNeedsCleanCard("h3", { vendor: cardVendor({ vendor: null }, SETTINGS.intel_xpu_only) }), true);
  /* xpu stays out of vendorOf: the launch fix (fixApplies) is main's there too. */
  assert.equal(vendorOf(null, "xpu"), null);
});

test("the clip job asks the card, then waits for the whole card, before it restarts a used engine", () => {
  const art = read("./art.js");
  assert.match(art, /const vendor = cardVendor\(\);\s*const budgetMs = clipBudgetMs\(expected, vendor, videoSpeed\.factor\(engine\), engine\);/);
  assert.ok(art.indexOf("if (externalMusicWork.owner) {") > 0
    && art.indexOf("if (externalMusicWork.owner) {") < art.indexOf("if (clipNeedsCleanCard(engine, { mode: config.video.freeBeforeClip, vendor })"),
    "a music tool on the card is said before any restart (the door would refuse the clip after it)");
  assert.match(art, /if \(clipNeedsCleanCard\(engine, \{ mode: config\.video\.freeBeforeClip, vendor \}\)\s*&& engineDoor\.ranSinceStart\(\) > 0 && typeof this\.comfy\?\.restart === "function"\) \{/);
  assert.doesNotMatch(art, /vendor: vendorOf\(config\.gpu, config\.torchBackend\) \}\)\s*&& engineDoor/, "never the settings alone");
  assert.match(art, /job\.waitingForQuiet = true;\s*let free = false;\s*try \{\s*free = await waitForQuietEngine\(\{\s*musicBusy: \(\) => !!this\.jobs\?\.current,\s*engineQueue: \(\) => engineDoor\.queue\(\),\s*otherWork: \(\) => this\.#otherWork\(job\),\s*cancelled: \(\) => !!job\.cancelled,/,
    "Bucky's wait, on every card, with the rest of the card read inside it and Stop honoured");
  assert.match(art, /\} finally \{\s*job\.waitingForQuiet = false;\s*\}\s*if \(job\.cancelled\) throw new Error\(STOPPED_ERROR\);\s*if \(free\) \{\s*console\.log\(`  \[art\] restarting the engine[^\n]*\n\s*await this\.comfy\.restart\(\)\.catch\(/,
    "a stopped clip is not restarted for; the restart is only in the quiet branch, and a failed one is said while the clip still goes");
  assert.match(art, /this\.jobs\.loaded = null;\s*this\.jobs\.artResident = true;\s*this\.#lastQwen = null;\s*\} else \{\s*console\.log\(`  \[art\] the engine stayed busy/, "nothing is warm afterwards; a card that never frees renders unrestarted");
  assert.ok(art.indexOf("clipNeedsCleanCard(engine,") < art.indexOf("for (let attempt = 0; ; attempt++) {", art.indexOf("clipNeedsCleanCard(engine,")),
    "before the clip is submitted");
  assert.match(art, /async #otherWork\(job\) \{\s*const live = await engineDoor\.status\(\);[\s\S]{0,200}this\.planBusy\(job\)[\s\S]{0,200}doorRuns: Array\.isArray\(live\?\.running\) \? live\.running\.length : 0,\s*held: Array\.isArray\(live\?\.held\) \? live\.held : \[\],\s*tools: externalMusicWork\.owner\?\.label \|\| null,\s*artOther: !!\(this\.current && this\.current !== job\),/,
    "the door's runs and holds, a music tool, another art job and the plans, read at the moment of the restart; a status that throws is busy");
  assert.doesNotMatch(art, /restartBlockedBy|restartWaitsForQueues/, "one mechanism: Bucky's wait");
});

test("a clip that waits is stopped without touching the engine", () => {
  const art = read("./art.js");
  const stopCurrent = art.slice(art.indexOf("  async stopCurrent() {"), art.indexOf("  async stopMine() {"));
  assert.match(stopCurrent, /if \(job\.waitingForQuiet\) \{\s*job\.cancelled = true; job\.stopping = true; this\.emit\("update"\);\s*return \{/,
    "marked and returned before any interrupt");
  assert.ok(stopCurrent.indexOf("job.waitingForQuiet") < stopCurrent.indexOf("engineDoor.interrupt()"));
  const stopMine = art.slice(art.indexOf("  async stopMine() {"), art.indexOf("  findJob(file, kind) {"));
  assert.match(stopMine, /if \(job\?\.waitingForQuiet\) \{\s*job\.cancelled = true; job\.stopping = true; out\.stopping = true;/,
    "the Stop button's half ends it too, instead of leaving it to render after the wait");
});

test("the plan runners: busy mid-step, not while they wait on the art queue", () => {
  const index = read("./index.js");
  const m = /art\.planBusy = \(\) => \{[\s\S]*?\n\};/.exec(index);
  assert.ok(m, "index.js sets art.planBusy");
  const make = (batch, art, running) => new Function("batch", "art", "plansRunningNow", `${m[0]}; return art.planBusy;`)(batch, art, () => running);
  const artIdle = { current: { file: "clip:c1" }, queue: [] };
  assert.equal(make({ run: null, pendingMedia: false }, { ...artIdle }, [])(), null, "no plan");
  assert.equal(make({ run: { state: "running" }, pendingMedia: true }, { ...artIdle }, [])(), null, "an overnight clip run waiting on this clip");
  assert.equal(make({ run: { state: "running" }, pendingMedia: false }, { ...artIdle }, [])(), "an overnight run", "a music step, or between two");
  assert.equal(make({ run: { state: "paused" }, pendingMedia: false }, { ...artIdle }, [])(), null, "a paused run holds nothing on the card");
  const mvClip = { current: { file: "clip:mv_rewind_s12_abc" }, queue: [] };
  assert.equal(make({ run: null }, mvClip, ["rewind"])(), null, "a music-video plan waiting on its own clip");
  const mvQueued = { current: { file: "clip:c1" }, queue: [{ file: "image:mv_rewind_b3_0_x" }] };
  assert.equal(make({ run: null }, mvQueued, ["rewind"])(), null, "or on its picture behind this clip");
  assert.equal(make({ run: null }, { ...artIdle }, ["rewind"])(), "the music-video plan for rewind", "a plan step elsewhere");
});

test("the engine counts its own renders and forgets them when a new process attaches", () => {
  const client = read("./engine/client.js");
  assert.match(client, /function attachChild\(proc\) \{ child = proc \|\| null; ranSinceStart = 0; return child; \}/);
  assert.match(client, /if \(status === "completed" && !data\.cached\) ranSinceStart\+\+;/, "a cache hit ran nothing");
  assert.match(client, /ranSinceStart: \(\) => ranSinceStart,/);
  const comfy = read("./comfy.js");
  assert.match(comfy, /async restart\(\) \{\s*await this\.stop\(\);\s*await this\.start\(\);\s*return this\.assertBackend\(\);\s*\}/, "same flags, a new process");
});

test("the setting is a Video Lab row, and says what was measured and where", () => {
  const cat = read("./videolab/catalog.js");
  assert.match(cat, /id: "free_before_clip",[\s\S]{0,120}kind: "enum", options: \["auto", "always", "never"\],\s*path: \["video", "freeBeforeClip"\],/);
  assert.match(cat, /unloading the models did not help, a restart did/);
  assert.match(cat, /Auto does it on AMD and Intel "\s*\+ "cards, where it was measured, and on a PC without a graphics card, and not on NVIDIA or a card Studio "\s*\+ "could not read\./);
  assert.match(cat, /On every card it "\s*\+ "never restarts while something else is running on the engine \(a Reactive look or a chat turn between two "\s*\+ "of its runs included\), a song is rendering, or a plan is mid-step: "\s*\+ "it waits up to 20 minutes, then renders without the restart\./,
    "the wait is said, for every card");
  assert.doesNotMatch(cat, /any card that is "\s*\+ "not NVIDIA/, "the old claim, false on an NVIDIA rig with no saved card");
});
