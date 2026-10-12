/**
 * H3'S SPEED-UPS ARE OPTIONAL, AND A STEP COUNT SAYS WHICH ONE IT NEEDS.
 *
 * The TaoMate 3-step LoRA, the 4-step and the 8-step files are optional
 * add-ons of the H3 row (models.js, addonFor "video"): H3 renders without any
 * of them (the bare model, 20 steps). A step count whose file is missing is
 * refused with its download offered (needsModel), never run on another
 * build's file at the wrong step count; the Video screen dims the chip whose
 * file is missing and offers it on a press; a speed-up that lands is used
 * without a restart. The engine switch judges an engine by the files the
 * renderer loads, so a missing speed-up (or LTX's template VAE in place of
 * the conv one) no longer leaves FastH3 the only engine it accepts.
 *
 *   node --test server/taomate_test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const { config } = await import("./config.js");
const { videoPlan, taomateNeeded, TAOMATE_ROW, SPEEDUP_ROWS, speedupNeeded } = await import("./video-plain.js");
const { CATALOG } = await import("./models.js");

/* MAIN'S RULE, AS AMD, INTEL AND THE CPU KEEP IT: no per-path reading
 * (config.js makes plainBuilds and refBuilds null where the settings name a
 * card that is not NVIDIA), so turboBuilds, the both-paths reading, decides.
 * The per-path rule NVIDIA and a card nobody could read get is pinned below
 * (nv(), "each path by the file it loads"). */
const h3 = (builds) => ({ ...config.video.engines.h3, plainBuilds: null, refBuilds: null,
  turboBuilds: { three: false, four: false, eight: false, ...builds } });
const plan = (b, eng, engineKey = "h3") => videoPlan({ prompt: "a kite over a hill", width: 1344, height: 768, seconds: 5, ...b }, { engineKey, eng });

test("3 steps without TaoMate is refused, with the download offered", () => {
  for (const steps of [3, 2]) {
    const p = plan({ steps }, h3({ eight: true }));
    assert.equal(p.refusal?.reason, "taomate-missing", `${steps} steps is refused`);
    assert.equal(p.refusal.needsModel, TAOMATE_ROW, "the reply names the row, so the page opens its download");
    assert.equal(p.refusal.error, taomateNeeded(steps));
  }
  assert.equal(TAOMATE_ROW, "videoH3Turbo3Small", "the 182 MB file new installs are offered");
  assert.match(taomateNeeded(3), /^3 steps needs the TaoMate 3-step LoRA \(182 MB\), which is not downloaded\. Download it, or pick 4 or more steps\.$/);
  assert.doesNotMatch(taomateNeeded(3), /—/, "no em dash in what a person reads");
});

test("4 and 8 steps need their own speed-ups, and say which", () => {
  const eightOnly = h3({ three: true, eight: true });
  for (const steps of [4, 5]) {
    const p = plan({ steps }, eightOnly);
    assert.equal(p.refusal?.reason, "speedup-missing", `${steps} steps with only the 8-step file`);
    assert.equal(p.refusal.needsModel, "videoH3Turbo4");
    assert.match(p.refusal.error, new RegExp(`^${steps} steps needs H3's 4-step speed-up \\(1\\.96 GB\\), which is not downloaded\\. Download it, or pick another step count\\.$`));
  }
  const fourOnly = h3({ four: true });
  for (const steps of [6, 8, 12]) {
    assert.equal(plan({ steps }, fourOnly).refusal?.needsModel, "videoH3Turbo8", `${steps} steps with only the 4-step file`);
  }
  assert.deepEqual({ ...SPEEDUP_ROWS }, { 3: "videoH3Turbo3Small", 4: "videoH3Turbo4", 8: "videoH3Turbo8" });
  assert.equal(speedupNeeded(h3({}), { steps: 8, refs: true })?.row, "videoH3Turbo8", "8-step references need their matching slot");
  assert.equal(speedupNeeded(h3({ four: true }), { steps: 8, refs: true })?.row, "videoH3Turbo8", "a 4-step slot cannot satisfy an 8-step reference graph");
});

test("reference clips refuse the absent slot actually selected by their graph", () => {
  const eightOnly = h3({ eight: true });
  for (const steps of [3, 4, 5]) {
    const p = plan({ steps, refImages: ["a.png"] }, eightOnly);
    assert.equal(p.refusal?.needsModel, "videoH3Turbo4", `${steps} steps cannot load an absent 4-step reference LoRA`);
    assert.equal(p.refusal?.reason, "speedup-missing");
  }
  for (const steps of [6, 8, 12]) {
    assert.equal(plan({ steps, refImages: ["a.png"] }, eightOnly).refusal, null,
      `${steps} steps can load the installed 8-step reference slot`);
  }
  const fourOnly = h3({ four: true });
  for (const steps of [6, 8, 12]) {
    const p = plan({ steps, refImages: ["a.png"] }, fourOnly);
    assert.equal(p.refusal?.needsModel, "videoH3Turbo8", `${steps} steps cannot load an absent 8-step reference LoRA`);
    assert.equal(p.refusal?.reason, "speedup-missing");
  }
  for (const steps of [3, 4, 5]) {
    assert.equal(plan({ steps, refImages: ["a.png"] }, fourOnly).refusal, null,
      `${steps} steps can load the installed 4-step reference slot`);
  }
});

test("everything with its file renders as before, and Best needs none", () => {
  const all = h3({ three: true, four: true, eight: true });
  for (const steps of [3, 4, 5, 6, 8, 12]) assert.equal(plan({ steps }, all).refusal, null, `${steps} steps with every file`);
  for (const steps of [13, 20]) assert.equal(plan({ steps }, h3({})).refusal, null, `${steps} steps is the bare model: no file needed`);
  assert.notEqual(plan({ steps: 3, refImages: ["a.png"] }, h3({ eight: true })).refusal?.reason, "taomate-missing",
    "the reference path runs its own build's count, not TaoMate's slot");
  assert.equal(speedupNeeded({ ...config.video.engines.fasth3 }, { steps: 3 }), null, "FastH3's schedule is fixed");
  const { turboBuilds, ...unknown } = h3({});
  assert.equal(plan({ steps: 3 }, unknown).refusal, null, "an engine that reports no builds is not judged");
});

/* ON NVIDIA AND A CARD NOBODY COULD READ, EACH PATH BY THE FILE IT LOADS
 * (config.js plainBuilds, refBuilds; video-plain.js perPath). main's
 * both-paths reading refused Keep my character on the "Video references"
 * row's own ref2v 4-step file, offering the fl2v 4-step file the reference
 * path never loads, and refused plain 8-step renders beside that row,
 * offering the 8-step file already on disk. */
const nv = ({ plain = {}, ref = {} }) => ({ ...config.video.engines.h3,
  plainBuilds: { three: false, four: false, eight: false, ...plain }, refBuilds: { four: false, eight: false, ...ref },
  turboBuilds: { three: false, four: false, eight: false, ...plain } });

test("NVIDIA: each path is checked by the file it loads, never by the other path's", () => {
  /* H3 + the "Video references" row (ref2v 4-step) and no fl2v file. */
  const refsRow = nv({ ref: { four: true, eight: true } });
  for (const steps of [3, 4, 5]) {
    assert.equal(speedupNeeded(refsRow, { steps, refs: true }), null, `${steps} steps with a character: the reference file is here (main refused it, offering the fl2v 4-step)`);
  }
  assert.equal(speedupNeeded(refsRow, { steps: 4 })?.row, "videoH3Turbo4", "a plain 4-step render still needs the plain path's file");
  /* H3 + the 8-step file + the references row (REVIEW T1). */
  const eightRefs = nv({ plain: { eight: true }, ref: { four: true, eight: true } });
  assert.equal(speedupNeeded(eightRefs, { steps: 8 }), null, "a plain 8-step render: the 8-step file is on disk (main offered it again)");
  assert.equal(speedupNeeded(eightRefs, { steps: 4, refs: true }), null);
  /* A band whose reference file is missing is offered by its band. */
  const noRef8 = nv({ plain: { eight: true }, ref: { four: true, eight: false } });
  assert.equal(speedupNeeded(noRef8, { steps: 8, refs: true })?.row, "videoH3Turbo8");
  assert.equal(speedupNeeded(nv({ ref: { eight: true } }), { steps: 4, refs: true })?.row, "videoH3Turbo4");
  /* The plain path keeps its own three bands. */
  assert.equal(speedupNeeded(nv({ plain: { four: true, eight: true } }), { steps: 3 })?.row, "videoH3Turbo3Small");
  assert.equal(speedupNeeded(nv({ plain: { three: true, eight: true } }), { steps: 4 })?.row, "videoH3Turbo4");
  assert.equal(speedupNeeded(nv({ plain: { three: true, four: true } }), { steps: 8 })?.row, "videoH3Turbo8");
  /* The same disks under main's rule (AMD, Intel, the CPU) keep main's answers. */
  assert.equal(speedupNeeded(h3({}), { steps: 4, refs: true })?.row, "videoH3Turbo4", "main: both paths' four");
  assert.equal(speedupNeeded(h3({ four: false, eight: false }), { steps: 8 })?.row, "videoH3Turbo8");
});

test("NVIDIA: the clip runner refuses what videoPlan refuses; AMD refuses only a file that is not on disk", async () => {
  const { speedupNeededAtClip } = await import("./video-plain.js");
  const eightOnly = nv({ plain: { eight: true }, ref: { eight: true } });
  assert.equal(speedupNeededAtClip(eightOnly, { steps: 4 })?.row, "videoH3Turbo4", "the 8-step file at 4 steps is refused on NVIDIA");
  /* main's rule: refused only where the file the graph loads is absent. */
  const amd = { ...h3({ eight: true }), turboLora4: "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors" };
  assert.equal(speedupNeededAtClip(amd, { steps: 4 }, { onDisk: () => true }), null, "AMD: the 8-step file at 4 steps renders as main renders it");
  assert.equal(speedupNeededAtClip(amd, { steps: 4 }, { onDisk: () => false })?.row, "videoH3Turbo4",
    "AMD: a file that is not on disk is refused before ComfyUI rejects it (a bug fix on every card)");
  assert.equal(speedupNeededAtClip(amd, { steps: 4 }), null, "and without a way to look, nothing is refused there");
});

test("NVIDIA: the chips and every count's missing speed-up come from the server, the same numbers make_clip sends", async () => {
  const { qualityChips, speedupTable, keepFast } = await import("./video-plain.js");
  /* H3 alone: Fast 3 and Standard 8 are offered (dimmed) with their rows,
   * Best is the bare model; make_clip "fast" sends the chip's 3, refused with
   * TaoMate offered, where it ran the bare 20 as "fast". */
  const bare = { ...nv({}), stepDefaults: { fast: 20, standard: 20, best: 20 }, refTurboSteps: null, steps: 20 };
  const c = qualityChips(bare);
  assert.deepEqual(c.plain, { fast: { steps: 3, needsModel: "videoH3Turbo3Small" }, standard: { steps: 8, needsModel: "videoH3Turbo8" },
    best: { steps: 20, needsModel: null } });
  /* H3 + references + 8-step: Standard 8 is lit (main dimmed it, offering the
   * file on disk), and the kept Standard is the reference file's own 4. */
  const eightRefs = { ...nv({ plain: { eight: true }, ref: { four: true, eight: true } }), stepDefaults: { fast: 8, standard: 8, best: 20 },
    refTurboSteps: 4, steps: 8, refTurboLora: "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
    refTurboLora4: "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors" };
  const e = qualityChips(eightRefs);
  assert.deepEqual(e.plain.standard, { steps: 8, needsModel: null }, "the 8-step chip is lit on the disk that holds it");
  assert.deepEqual(e.keep.standard, { steps: 4, needsModel: null }, "Keep my character's Standard is the reference file's own count");
  assert.ok(e.keep.fast.steps <= e.keep.standard.steps, "Keep's Fast is never above its Standard (it was the bare 20 beside a 4)");
  assert.equal(e.keep.fast.needsModel, null, "and never a chip whose file is missing");
  assert.equal(keepFast({ ...eightRefs, stepDefaults: { fast: 20, standard: 8, best: 20 } }), null, "a Fast above Standard folds into it");
  const t = speedupTable(eightRefs);
  assert.equal(t.plain[8], null);
  assert.equal(t.plain[4], "videoH3Turbo4");
  assert.equal(t.refs[4], null, "the reference file is here");
  /* AMD, Intel and the CPU: no chips; the page draws main's and make_clip
   * sends stepDefaults (Bucky's rule). The table is main's rule there. */
  assert.equal(qualityChips({ ...h3({ eight: true }), stepDefaults: { fast: 8, standard: 8, best: 20 } }), null);
  assert.equal(speedupTable(h3({ eight: true })).plain[4], "videoH3Turbo4", "main's rule, which the page drew before");
  assert.equal(speedupTable(h3({})).refs[8], "videoH3Turbo8");
});

test("a refused speed-up keeps the Keep my character line and the song line", () => {
  /* The refusal used to carry neither, so the Video screen blanked the Keep
   * line and its receipt and kept the last check's song line while the
   * slider sat on a missing speed-up (web/vidfit.js paintKeep, paintSong).
   * Words only: on every card. */
  for (const eng of [h3({ eight: true }), nv({ plain: { eight: true }, ref: { eight: true } })]) {
    const p = plan({ steps: 4, refImages: ["a.png"], audioTrack: { name: "song.wav" } }, eng);
    assert.equal(p.refusal?.reason, "speedup-missing");
    assert.equal(typeof p.character?.hint, "string", "the Keep line rides with the refusal");
    assert.ok(p.songLine && typeof p.songLine.hint === "string", "and the song line");
  }
});

test("the speed-ups are optional add-on rows of H3; its own row brings the 8-step one on NVIDIA", async () => {
  const row = (id) => CATALOG.find((c) => c.id === id);
  const names = (id) => row(id).files.map((f) => path.basename(f.dest));
  const { cardIsOffNvidia } = await import("./models.js");
  const saved = { gpu: config.gpu, torchBackend: config.torchBackend };
  try {
    for (const [gpu, torchBackend, nvidia] of [[{ vendor: "nvidia", totalMb: 16376 }, "cuda", true], [null, null, true], [null, "cuda", true],
      [{ vendor: "amd", totalMb: 16304 }, "rocm", false], [{ vendor: "intel", totalMb: 16000 }, "xpu", false], [{ vendor: "cpu", totalMb: 0 }, "cpu", false]]) {
      config.gpu = gpu; config.torchBackend = torchBackend;
      assert.equal(cardIsOffNvidia(), !nvidia, JSON.stringify({ gpu, torchBackend }));
      assert.deepEqual(names("video").filter((n) => /turbo|taomate/i.test(n)),
        nvidia ? ["minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"] : [],
        nvidia ? "NVIDIA and an unread card: the H3 row brings the 8-step file Standard renders at" : "AMD, Intel and the CPU: the H3 row holds no speed-up, as main has it");
    }
  } finally { config.gpu = saved.gpu; config.torchBackend = saved.torchBackend; }
  assert.equal(row("video").defaultFiles.find((f) => /turbo_8step/.test(f.dest))?.nvidiaOnly, true, "the published list marks it NVIDIA-only");
  for (const [id, file, steps] of [
    ["videoH3Turbo4", "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors", 4],
    ["videoH3Turbo8", "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors", 8],
  ]) {
    assert.equal(row(id)?.addonFor, "video", `${id} is an add-on of H3`);
    assert.equal(row(id).required, false);
    assert.equal(row(id).stepsFor, steps);
    assert.deepEqual(names(id), [file]);
    assert.match(row(id).files[0].sha256, /^[0-9a-f]{64}$/, "checked on arrival");
    assert.deepEqual(row(id).region.excluded, row("video").region.excluded, "H3's territory, repeated");
  }
  for (const id of ["videoH3Turbo3", "videoH3Turbo3Small"]) assert.equal(row(id).addonFor, "video");
  const ltxVae = row("videoLtx").files.find((f) => /ltx-2\.5-video-vae-conv-bf16/.test(f.dest));
  assert.deepEqual(ltxVae.alt, ["ltx-2.5-video-vae-bf16.safetensors"], "LTX's template VAE counts as present");
  /* videoPick() since setF, and the conv name repeated last: it is the file the
   * LTX row fetches, so a machine holding neither is told that one. */
  assert.match(read("./config.js"), /videoVae: videoPick\("ltx", "videoVae", "vae", "ltx-2\.5-video-vae-conv-bf16\.safetensors", "ltx-2\.5-video-vae-bf16\.safetensors",\s*"ltx-2\.5-video-vae-conv-bf16\.safetensors"\),/,
    "and it is the one loaded when the conv one is absent");
});

test("the engine switch asks the renderer, and a speed-up is not part of it", () => {
  const index = read("./index.js");
  /* videoReadyFresh since setF: the files are looked for once more first. */
  assert.match(index, /if \(cap && !cap\.ready && !videoReadyFresh\(e\)\.ready\) \{/,
    "an engine the renderer can run is not refused for its Models row");
  assert.doesNotMatch(read("./workflow.js").match(/const VIDEO_MODEL_DIRS = \{[\s\S]*?\};/)[0], /^\s*turboLora:/m,
    "no speed-up is needed for an engine to render");
  assert.match(index, /if \(plan\.refusal\) return json\(res, 400, \{ error: plan\.refusal\.error, reason: plan\.refusal\.reason,\s*\.\.\.\(plan\.refusal\.needsModel \? \{ needsModel: plan\.refusal\.needsModel \} : \{\}\) \}\);/,
    "POST /api/video passes needsModel on, which the Video screen's Fix button opens");
  /* Since setF with every other video file too, on any video row
   * (models.js isVideoRow, which counts the speed-up rows; config.js
   * refreshVideoPicks; server/videopicks_test.js). */
  assert.match(index, /models\.on\("ready", \(id\) => \{\s*if \(isVideoRow\(id\)\) refreshVideoPicks\(\);/,
    "a speed-up that lands is looked for again");
});

test("the page dims a missing speed-up, offers it on a press, and before a render", () => {
  const app = read("../web/app.js");
  assert.match(app, /const VID_SPEEDUP_ROWS = \{ 3: "videoH3Turbo3Small", 4: "videoH3Turbo4", 8: "videoH3Turbo8" \};/);
  /* The chips and the table are the server's (video-plain.js qualityChips,
   * speedupTable); main's own chips stay only where no chips come (AMD,
   * Intel, the CPU: Bucky's rule). */
  assert.match(app, /if \(chipOf\) \{\s*getFor = \{ fast: chipOf\.fast\?\.needsModel \|\| null, standard: chipOf\.standard\?\.needsModel \|\| null, best: chipOf\.best\?\.needsModel \|\| null \};/,
    "each chip's Models row is the server's, the kept chips' too");
  assert.match(app, /getFor = \{ fast: tb && !tb\.three \? VID_SPEEDUP_ROWS\[3\] : null, standard: tb && !tb\.eight && !tb\.four \? VID_SPEEDUP_ROWS\[8\] : null, best: null \};/,
    "without chips: Fast is TaoMate's, Standard the 8-step (or 4-step) file, Best never needs one, as main draws them");
  assert.match(app, /const row = eng\?\.speedupNeeds\?\.\[hasRefs \? "refs" : "plain"\]\?\.\[Number\(steps\)\] \|\| null;/,
    "the page's missing speed-up is the server's table, not a copy of the rule");
  assert.match(app, /b\.classList\.toggle\("off", !!get\);/);
  assert.match(app, /if \(b\.dataset\.get\) \{ vidOfferSpeedup\(VID_ROW_BUILD\[b\.dataset\.get\]\); return; \}/, "a dimmed chip offers, never chooses");
  assert.match(app, /const need = eng\.fixedSteps \? null : vidSpeedupNeed\(eng, \+\$\("vidSteps"\)\.value, hasRefs\);\s*if \(need\) \{ vidOfferSpeedup\(need\.build\); return; \}/,
    "Make clip offers the download instead of sending a render that would be refused");
  assert.match(app, /\(needSpeedup \? " · ⚠ " \+ st \+ " steps needs " \+ vidSpeedupWords\(needSpeedup\.build\)/, "the estimate says it first");
  assert.match(read("../web/ui.css"), /#vidQualityRow \.edtool\.off \{ opacity: \.55; \}/);
  assert.match(read("../web/modelpick.js"), /if \(kind === "auto" && asked\?\.addonFor\) return caps\.filter\(\(c\) => c\.id === focus \|\| c\.addonFor === asked\.addonFor\);/,
    "the model window lists H3's speed-ups side by side");
});

/* A disk in a temp folder, and config.js read in its own process against it. */
function probeDisk(files, probeBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h3-speedups-"));
  try {
    const loras = path.join(dir, "models", "loras");
    fs.mkdirSync(loras, { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(loras, f), "x");
    const probe = `
      import fs from "node:fs"; import path from "node:path";
      const { config, refreshH3Speedups, refreshTaoMate } = await import(${JSON.stringify(new URL("./config.js", import.meta.url).href)});
      const h = config.video.engines.h3;
      const land = (f) => fs.writeFileSync(path.join(${JSON.stringify(loras)}, f), "x");
      const snap = () => ({ lora3: h.turboLora3, lora4: h.turboLora4, lora8: h.turboLora, builds: { ...h.turboBuilds }, defaults: { ...h.stepDefaults }, steps: h.steps });
      ${probeBody}`;
    const env = { ...process.env, AIPLAY_APPDATA: path.join(dir, "settings"), AIPLAY_MODELS_DIR: path.join(dir, "models"),
      AIPLAY_RIG: path.join(dir, "rig"), AIPLAY_OUTPUT: path.join(dir, "output") };
    delete env.AIPLAY_MUSIC_ONLY;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], { env, encoding: "utf8", timeout: 60_000 });
    return JSON.parse(out.trim().split("\n").at(-1));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const L = {
  eight: "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
  four: "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors",
  tao: "minimax_h3_taomate_3step_lora_avg_rank_19_bf16.safetensors",
};

test("a disk with no speed-up renders H3 at 20 steps", () => {
  const r = probeDisk([], `console.log(JSON.stringify(snap()));`);
  assert.deepEqual(r.builds, { three: false, four: false, eight: false });
  assert.deepEqual(r.defaults, { fast: 20, standard: 20, best: 20 }, "Standard is the bare model: nothing to fetch first");
  assert.equal(r.steps, 20);
});

test("a speed-up that lands is used without a restart, and a person's step count stays", () => {
  const r = probeDisk([L.eight], `
    const before = snap();
    const nothing = refreshTaoMate();
    land(${JSON.stringify(L.tao)}); const afterTao = refreshH3Speedups();
    const tao = snap();
    h.steps = 12;                        // a person moved it
    land(${JSON.stringify(L.four)}); refreshH3Speedups();
    console.log(JSON.stringify({ before, nothing, afterTao, tao, four: snap() }));`);
  assert.equal(r.before.builds.three, false, "no TaoMate at start");
  assert.equal(r.before.defaults.fast, 8, "and Fast is Standard's 8");
  assert.equal(r.nothing, false, "looking again with nothing new finds nothing");
  assert.equal(r.afterTao.three, true);
  assert.equal(r.tao.lora3, L.tao);
  assert.equal(r.tao.defaults.fast, 3, "Fast drops to 3 at once");
  assert.equal(r.tao.defaults.standard, 8, "Standard stays");
  assert.equal(r.tao.steps, r.before.steps, "the step count in use stays");
  assert.equal(r.four.builds.four, true, "the 4-step file is found too");
  assert.equal(r.four.lora4, L.four, "and loads at 4 steps");
  assert.equal(r.four.steps, 12, "a person's own step count is never moved");
});

test("the first speed-up on an empty disk moves the machine's default off 20", () => {
  const r = probeDisk([], `land(${JSON.stringify(L.eight)}); refreshH3Speedups(); console.log(JSON.stringify(snap()));`);
  assert.equal(r.builds.eight, true);
  assert.equal(r.defaults.standard, 8);
  assert.equal(r.steps, 8, "still the machine's default, so it follows");
});
