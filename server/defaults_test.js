/**
 * DEFAULTS FOLLOW THE DISK, AND EVERY MAKE BUTTON SAYS WHAT IT WILL DO.
 * (UI_PLAN A1, B2 and C2; INSTALLER_PLAN S5.)
 *
 * A fresh install aimed music at MiniMax Music 3 and pictures and covers at
 * Qwen Image 2.1, neither of which the recommended download fetches, so the
 * first song opened a download for the wrong engine and every cover after it
 * failed. server/fit.js defaultFor() now answers from the disk when nothing is
 * saved; config.js applies its answer without ever writing it to settings.json.
 *
 * §1 the resolver on four imaginary machines (an 8-step disk, a 4-step-only
 *    disk, an AMD card, no card): a saved preference always wins; a fresh
 *    install never gets the Python kit unless it is installed and ready; no
 *    default names a missing model while a ready one exists; no paid row is
 *    ever the machine's pick; no picture model means no cover, in one sentence.
 * §2 the video step default on the disks mcp-steer_test.js builds, through
 *    config.js's own pick() in a child process: the matched count, 8 or 4.
 * §3 config.js: who chose, and what reaches settings.json; the owner's
 *    settings (an older Studio's file) keep every value, pictures included.
 * §4 index.js and the MCP surface: studio_status.defaults, set_music_engine
 *    (withheld from the chat), make_image and set_image_engine run against a
 *    stub, the cover gate, the doors, the card read before any default.
 * §5 the writing-model list: only models that can write, by name.
 * §6 the receipt lane: every field names a control that exists, and the
 *    engine internals moved into the ⓘ panel; the cover refusal on the page.
 * §7 the launcher names what Studio will run.
 * No card, no server of Studio's own, nothing downloaded.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultFor, yue2BuildFor, readMachine, COVER_NEEDS_MODEL } from "./fit.js";
import { CATALOG, isPictureModel } from "./models.js";
import { config } from "./config.js";
import { TOOLS } from "./mcp.js";
import { ROUTABLE, WITHHELD } from "./chat/router.js";
import { writerVerdict, writerLabel, createChatModels } from "./chat/models.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const tool = (name) => TOOLS.find((t) => t.name === name);
const url = (rel) => JSON.stringify(new URL(rel, import.meta.url).href);

/* ── the four machines ─────────────────────────────────────────────────── */

const INT8 = "yue2_3b_int8_convrot.safetensors", BF16 = "yue2_3b_bf16.safetensors";
const choice = {
  comfy: (ckpt, available = true) => ({ value: `yue2-comfy:${ckpt}`, engine: "yue2-comfy", checkpoint: ckpt, label: `YuE2 3B · ${ckpt}`, available }),
  gguf: (p, available) => ({ value: `yue2-gguf:${p}`, engine: "yue2-gguf", precision: p, label: `YuE2 GGUF · ${p}`, available }),
  kit: (available) => ({ value: "yue2", engine: "yue2", label: "YuE2 3B (Python kit)", available }),
  minimax: (available) => ({ value: "minimax-music3:int8", engine: "minimax-music3", precision: "int8", label: "MiniMax Music 3 · int8", available }),
  paid: () => ({ value: "minimax-music3:api:fal", engine: "minimax-music3", api: "fal", label: "MiniMax Music 3 · API (fal.ai)", available: true }),
  ace: (available) => ({ value: "ace-step15:acestep_v1.5_turbo.safetensors", engine: "ace-step15", dit: "acestep_v1.5_turbo.safetensors", label: "ACE-Step 1.5 · turbo", available }),
};
/* The picture rows are the catalogue's own (their rights and requirements are
 * what the ranking reads), with `ready` set per machine. */
const pictures = (ready) => CATALOG.filter(isPictureModel).map((c) => ({
  ...c, ready: ready.includes(c.id), totalBytes: (c.files || []).reduce((s, f) => s + (f.bytes || 0), 0),
}));
const MACHINES = [
  { name: "the 8-step disk (NVIDIA 16 GB)", machine: readMachine({ name: "RTX 4070 Ti SUPER", totalMb: 16376, vendor: "nvidia" }, { totalMb: 32768 }),
    choices: [choice.minimax(true), choice.paid(), choice.gguf("q4_0", true), choice.comfy(BF16), choice.comfy(INT8), choice.ace(false), choice.kit(true)],
    pictures: pictures(["coverArt", "qwen-image-2.1", "imageIdeogram"]), steps: "rig" },
  { name: "the 4-step-only disk (NVIDIA 12 GB)", machine: readMachine({ name: "RTX 4070", totalMb: 12282, vendor: "nvidia" }, { totalMb: 32768 }),
    choices: [choice.minimax(false), choice.gguf("q4_0", false), choice.comfy(BF16), choice.kit(false)],
    pictures: pictures(["imageZImage"]), steps: "shop" },
  { name: "an AMD card (RX 9060 XT 16 GB)", machine: readMachine({ name: "AMD Radeon RX 9060 XT", totalMb: 16368, vendor: "amd" }, { totalMb: 32768 }),
    choices: [choice.minimax(true), choice.comfy(INT8), choice.comfy(BF16), choice.gguf("q8_0", true), choice.kit(false)],
    pictures: pictures([]) },
  { name: "no card", machine: readMachine(null, { totalMb: 16384 }),
    choices: [choice.minimax(false), choice.comfy(INT8), choice.gguf("q4_0", true), choice.gguf("q8_0", true), choice.kit(false)],
    pictures: pictures([]) },
];

console.log("\n§1  the resolver on four imaginary machines");
for (const m of MACHINES) {
  const music = defaultFor("music", { saved: null, choices: m.choices, machine: m.machine, literal: "minimax-music3" });
  const image = defaultFor("image", { capabilities: m.pictures, machine: m.machine, literal: "qwen-image-2.1" });
  const cover = defaultFor("cover", { saved: null, capabilities: m.pictures, machine: m.machine, literal: "qwen-image-2.1" });
  const readyMusic = m.choices.filter((c) => c.available && !c.api);
  const readyPictures = m.pictures.filter((c) => c.ready);
  ok(`${m.name}: every default says who chose it and why`,
    [music, image, cover].every((d) => d.chosenBy === "machine" && typeof d.why === "string" && d.why.length > 20 && d.key),
    JSON.stringify([music, image, cover].map((d) => [d.key, d.chosenBy, d.why])));
  ok(`${m.name}: no music default names a missing model while a ready one exists`,
    !readyMusic.length || (music.ready && readyMusic.some((c) => c.engine === music.value)), JSON.stringify(music));
  ok(`${m.name}: no picture or cover default names a missing model while one is on disk`,
    !readyPictures.length || (image.ready && cover.ready && cover.canRun), JSON.stringify({ image, cover }));
  ok(`${m.name}: never the Python kit unless it is installed and ready`,
    music.value !== "yue2" || m.choices.some((c) => c.engine === "yue2" && c.available), music.value);
  ok(`${m.name}: never a paid row, even with a key ready`, !m.choices.some((c) => c.api && c.engine === music.value && !readyMusic.some((r) => r.engine === music.value)));
  /* A SAVED CHOICE ALWAYS WINS — ready or not, reported as the person's, with
   * a sentence when its files are missing. Never a silent swap. */
  const savedMusic = defaultFor("music", { saved: { engine: "minimax-music3", checkpoint: null }, choices: m.choices, machine: m.machine });
  ok(`${m.name}: a saved music engine wins, ready or not`,
    savedMusic.value === "minimax-music3" && savedMusic.chosenBy === "you"
    && (savedMusic.ready || /not ready on this PC/.test(savedMusic.why)), JSON.stringify(savedMusic));
  const savedCover = defaultFor("cover", { saved: "ideogram4", capabilities: m.pictures, machine: m.machine });
  const ideogramReady = m.pictures.find((c) => c.id === "imageIdeogram")?.ready;
  ok(`${m.name}: a saved cover engine wins, and says so when it cannot draw`,
    savedCover.value === "ideogram4" && savedCover.chosenBy === "you" && savedCover.canRun === !!ideogramReady
    && (ideogramReady || savedCover.why.startsWith(COVER_NEEDS_MODEL)), JSON.stringify(savedCover));
  m.result = { music, image, cover };
}
const [rig, shop, amd, none] = MACHINES.map((m) => m.result);
ok("NVIDIA with both YuE2 builds: YuE2 through ComfyUI, the int8 build", rig.music.value === "yue2-comfy" && rig.music.checkpoint === INT8, JSON.stringify(rig.music));
ok("...before the ready GGUF, the Python kit and MiniMax", rig.music.checkpointBy === "machine");
ok("the 12 GB disk with only bf16: that build, the only one there", shop.music.value === "yue2-comfy" && shop.music.checkpoint === BF16, JSON.stringify(shop.music));
ok("AMD with both builds: bf16, the one measured there", amd.music.value === "yue2-comfy" && amd.music.checkpoint === BF16, JSON.stringify(amd.music));
ok("AMD never gets MiniMax from the machine while its launch lacks the fix",
  defaultFor("music", { choices: [choice.minimax(true), choice.ace(true)], machine: MACHINES[2].machine }).value === "ace-step15");
ok("...and does once the launch carries it",
  defaultFor("music", { choices: [choice.minimax(true)], machine: { ...MACHINES[2].machine, amdMusicFixed: true } }).value === "minimax-music3");
ok("no card: native YuE2 GGUF, Q4 first, before YuE2 through ComfyUI", none.music.value === "yue2-gguf" && none.music.precision === "q4_0", JSON.stringify(none.music));
ok("the music-only launch: native first too, and its own last resort",
  defaultFor("music", { choices: [choice.comfy(INT8), choice.gguf("q4_0", true)], machine: MACHINES[0].machine, musicOnly: true }).value === "yue2-gguf"
  && defaultFor("music", { choices: [], machine: MACHINES[0].machine, musicOnly: true, literal: "yue2-gguf" }).value === "yue2-gguf");
const kitOnly = defaultFor("music", { choices: [choice.kit(true), choice.minimax(false)], machine: MACHINES[0].machine });
ok("the Python kit, when it is the one thing installed and ready", kitOnly.value === "yue2" && kitOnly.ready, JSON.stringify(kitOnly));
/* NOTHING READY IS NOT MINIMAX (release critic, 2026-09-24: UI_PLAN A1 /
 * INSTALLER S5, music half). A fresh Full Studio install named MiniMax Music 3
 * (config.js's old literal), called it "your selected music engine" and on
 * AMD warned about the engine Studio had picked itself. It names the one to
 * get now, the way pictures do, and it is the machine's pick, said as such. */
const nothing = defaultFor("music", { choices: [choice.minimax(false), choice.paid(), choice.kit(false)], machine: MACHINES[0].machine, literal: "minimax-music3" });
ok("nothing ready on NVIDIA: YuE2 through ComfyUI, the int8 build, the machine's pick, not ready, pointing at Models",
  nothing.value === "yue2-comfy" && nothing.precision === "int8" && nothing.chosenBy === "machine" && !nothing.ready
  && /Studio picked YuE2 3B through ComfyUI/.test(nothing.why) && /Models screen/.test(nothing.why) && !/MiniMax/.test(nothing.why),
  JSON.stringify(nothing));
{
  const empty = [choice.minimax(false), choice.paid()];
  const amdEmpty = defaultFor("music", { choices: empty, machine: MACHINES[2].machine });
  ok("nothing ready on AMD: YuE2 through ComfyUI, labelled as the int8 file Models fetches, said to be unmeasured on AMD, never MiniMax",
    amdEmpty.value === "yue2-comfy" && amdEmpty.precision === "int8" && /· int8$/.test(amdEmpty.label) && amdEmpty.chosenBy === "machine"
    && /not yet measured on AMD cards/.test(amdEmpty.why) && /bf16 build is the one measured/.test(amdEmpty.why)
    && !/MiniMax/.test(amdEmpty.why), JSON.stringify(amdEmpty));
  /* No size is typed into the sentence: the Models screen says it, from the row. */
  ok("...and no download size is typed into the nothing-ready sentences",
    ![nothing.why, amdEmpty.why].some((w) => /\d(\.\d+)? GB/.test(w)), nothing.why);
  /* INTEL (release critic): the ComfyUI row is listed for NVIDIA and AMD; the
   * native GGUF has a Vulkan build for Intel (README's Intel row). */
  const intelEmpty = defaultFor("music", { choices: empty,
    machine: readMachine({ name: "Intel Arc A770", totalMb: 16384, vendor: "intel" }, { totalMb: 32768 }) });
  ok("nothing ready on an Intel card: the native GGUF Q4 (Vulkan), with the reason",
    intelEmpty.value === "yue2-gguf" && intelEmpty.precision === "q4_0" && /Intel card/.test(intelEmpty.why) && /Vulkan/.test(intelEmpty.why),
    JSON.stringify(intelEmpty));
  const noCardEmpty = defaultFor("music", { choices: empty, machine: MACHINES[3].machine });
  ok("nothing ready with no card: the native YuE2 GGUF Q4, said to run on the CPU",
    noCardEmpty.value === "yue2-gguf" && noCardEmpty.precision === "q4_0" && /no graphics card/.test(noCardEmpty.why), JSON.stringify(noCardEmpty));
  const noComfy = defaultFor("music", { choices: empty, machine: MACHINES[0].machine, comfy: false });
  ok("nothing ready and no ComfyUI in this launch: the native GGUF Q4",
    noComfy.value === "yue2-gguf" && /no ComfyUI/.test(noComfy.why), JSON.stringify(noComfy));
  const small = defaultFor("music", { choices: empty, machine: MACHINES[0].machine, comfyFits: false });
  ok("nothing ready on a card under YuE2-for-ComfyUI's minimum: the native GGUF Q4",
    small.value === "yue2-gguf" && /under the minimum/.test(small.why), JSON.stringify(small));
  const lowRam = defaultFor("music", { choices: empty, machine: MACHINES[0].machine, comfyFits: false, comfyShort: "ram" });
  ok("...and when the RAM is the half that falls short, the sentence says RAM, not the card",
    lowRam.value === "yue2-gguf" && /less RAM than YuE2 through ComfyUI asks for/.test(lowRam.why) && !/this card is under/.test(lowRam.why), lowRam.why);
  const onlyNothing = defaultFor("music", { choices: [], machine: MACHINES[0].machine, musicOnly: true });
  ok("nothing ready in the music-only launch: the native GGUF Q4", onlyNothing.value === "yue2-gguf" && /music-only launch/.test(onlyNothing.why));
  ok("...and no nothing-ready answer is ever MiniMax, on any machine",
    MACHINES.every((m) => defaultFor("music", { choices: empty, machine: m.machine }).value !== "minimax-music3"));
  /* THE OWNER'S MACHINE: a saved YuE2 Python kit still wins, ready or not. */
  const kitSaved = defaultFor("music", { saved: { engine: "yue2", checkpoint: null }, choices: empty, machine: MACHINES[0].machine });
  ok("a saved YuE2 Python kit still wins over the machine's pick, as the person's",
    kitSaved.value === "yue2" && kitSaved.chosenBy === "you", JSON.stringify(kitSaved));
}
/* THE RECOMMENDATION'S MUSIC SLOT follows the same answer, worded by who chose it. */
{
  const { recommendFor, fitFor } = await import("./fit.js");
  const caps = CATALOG.map((c) => ({ ...c, ready: false, totalBytes: (c.files || []).reduce((s, f) => s + (f.bytes || 0), 0) || c.approxBytes || 0,
    haveBytes: 0 }));
  const rec = (machine, music) => recommendFor({ capabilities: caps.map((c) => ({ ...c, fit: fitFor(c.requires, machine) })), machine, disk: { freeBytes: 900e9 }, music });
  const machinePick = defaultFor("music", { choices: [choice.minimax(false)], machine: MACHINES[2].machine });
  const amdRec = rec(MACHINES[2].machine, machinePick);
  const m = amdRec.picks.find((p) => p.slot === "music");
  ok("recommendFor on a fresh AMD install: YuE2 for ComfyUI, 'Studio picked', and no AMD MiniMax warning",
    m.id === "musicYue2Comfy" && m.chosenBy === "machine" && /^Studio picked this music engine/.test(m.why)
    && /not yet measured on AMD cards/.test(m.why)
    && !/your selected/.test(m.why) && !amdRec.notes.some((n) => n.slot === "music-amd"), JSON.stringify({ why: m.why, notes: amdRec.notes.map((n) => n.slot) }));
  const chose = rec(MACHINES[2].machine, { value: "minimax-music3", chosenBy: "you", kept: false, paid: false });
  const cm = chose.picks.find((p) => p.slot === "music");
  ok("...a MiniMax the person chose on AMD still gets the warning, worded as theirs",
    cm.id === "engine" && !!cm.amdWarning && /^You chose MiniMax Music 3/.test(chose.notes.find((n) => n.slot === "music-amd")?.headline || ""),
    chose.notes.find((n) => n.slot === "music-amd")?.headline);
  const hosted = rec(MACHINES[2].machine, { value: "minimax-music3", chosenBy: "you", kept: false, paid: true });
  ok("...and the hosted MiniMax (it does not render on this card) gets none",
    !hosted.notes.some((n) => n.slot === "music-amd"));
}
ok("a saved YuE2-through-ComfyUI with no checkpoint chosen gets the machine's build",
  (() => { const d = defaultFor("music", { saved: { engine: "yue2-comfy", checkpoint: null }, choices: MACHINES[0].choices, machine: MACHINES[0].machine });
    return d.chosenBy === "you" && d.checkpoint === INT8 && d.checkpointBy === "machine"; })());
ok("yue2BuildFor: int8 on NVIDIA and on an unread card, bf16 on AMD, the one there otherwise",
  yue2BuildFor([BF16, INT8], "nvidia") === INT8 && yue2BuildFor([BF16, INT8], null) === INT8
  && yue2BuildFor([INT8, BF16], "amd") === BF16 && yue2BuildFor(["yue2_custom.safetensors"], "amd") === "yue2_custom.safetensors"
  && yue2BuildFor([], "nvidia") === null);
ok("pictures on the 8-step disk: FLUX.2 klein, on disk and the least restrictive licence", rig.image.value === "flux2" && rig.image.ready, JSON.stringify(rig.image));
ok("...and covers follow it", rig.cover.value === "flux2" && rig.cover.canRun && /because it is on this PC/.test(rig.cover.why));
ok("the Z-Image-only disk: Z-Image for pictures and covers", shop.image.value === "zimage" && shop.cover.value === "zimage" && shop.cover.canRun);
ok("no picture model: covers are off in one sentence, and no cover can run",
  amd.cover.canRun === false && amd.cover.why === COVER_NEEDS_MODEL && none.cover.canRun === false, JSON.stringify(amd.cover));
ok("...and Make picture names the one to get: the recommended FLUX.2 klein, not Qwen's research licence",
  amd.image.value === "flux2" && !amd.image.ready && /is the one to get/.test(amd.image.why), JSON.stringify(amd.image));
ok("a cover workflow of the person's own always runs",
  defaultFor("cover", { custom: true, saved: "checkpoint", capabilities: pictures([]) }).canRun === true);

/* THE NAME, NOT THE FILE (review): Settings said "YuE2 3B · int8_convrot". */
ok("the machine's music sentence names the model, and keeps the build for a tooltip",
  rig.music.why === "Studio picked YuE2 3B for music because it is ready on this PC." && /int8/.test(rig.music.label), rig.music.why);

/* VALUES AN OLDER STUDIO SAVED ON ITS OWN: kept, never "You chose". */
const keptMusic = defaultFor("music", { saved: { engine: "minimax-music3", checkpoint: null, kept: true }, choices: MACHINES[0].choices, machine: MACHINES[0].machine });
ok("a kept music value wins like a choice and is worded as saved, not chosen",
  keptMusic.value === "minimax-music3" && keptMusic.chosenBy === "you" && keptMusic.kept === true
  && /^Saved in your settings: MiniMax Music 3 for music\.$/.test(keptMusic.why), keptMusic.why);
const everyPicture = pictures(CATALOG.filter(isPictureModel).map((c) => c.id));
const keptImage = defaultFor("image", { saved: "qwen-image-2.1", kept: true, capabilities: everyPicture, machine: MACHINES[0].machine });
ok("the owner's pictures stay on Qwen Image 2.1 on a disk holding every picture model (kept, not moved to FLUX.2 klein)",
  keptImage.value === "qwen-image-2.1" && keptImage.chosenBy === "you" && keptImage.ready && /^Saved in your settings: /.test(keptImage.why), JSON.stringify(keptImage));
const keptCover = defaultFor("cover", { saved: "qwen-image-2.1", kept: true, capabilities: pictures(["coverArt"]), machine: MACHINES[0].machine });
ok("a kept cover engine whose files are missing: no cover, the one sentence, and no claim anybody chose it",
  keptCover.canRun === false && keptCover.why.startsWith(COVER_NEEDS_MODEL) && !/You chose/.test(keptCover.why), keptCover.why);
const chosenImage = defaultFor("image", { saved: "krea2", capabilities: pictures(["coverArt"]), machine: MACHINES[0].machine });
ok("a picture engine the person saved wins even when missing, and says so",
  chosenImage.value === "krea2" && chosenImage.chosenBy === "you" && !chosenImage.ready && /Studio does not switch for you/.test(chosenImage.why));

/* THIS SESSION RUNS SOMETHING ELSE (a saved choice this launch cannot run):
 * the saved value is reported beside the one running, never rewritten. */
const swapped = defaultFor("music", { saved: { engine: "yue2", checkpoint: null }, session: { engine: "yue2-gguf", reason: "The music-only launch runs YuE2 only" },
  choices: MACHINES[3].choices, machine: MACHINES[3].machine, musicOnly: true });
ok("a session swap runs the swap, names the saved choice, and says it stays saved",
  swapped.value === "yue2-gguf" && swapped.savedValue === "yue2" && swapped.chosenBy === "you"
  && /^You chose YuE2 3B \(Python kit\) for music\. The music-only launch runs YuE2 only, so this session uses YuE2 GGUF; your choice stays saved\.$/.test(swapped.why), swapped.why);

/* API MODE: the person's own switch ("Use a hosted engine instead of my GPU"). */
const apiOn = { enabled: true, provider: "fal" };
const hosted = defaultFor("music", { saved: null, choices: [choice.comfy(INT8), choice.paid()], machine: MACHINES[0].machine, api: apiOn });
ok("API mode on and nothing chosen: MiniMax through the person's own key, said to be billed, and theirs, not the machine's",
  hosted.value === "minimax-music3" && hosted.paid === true && hosted.chosenBy === "you" && /billed per song/.test(hosted.why), JSON.stringify(hosted));
const savedHosted = defaultFor("music", { saved: { engine: "minimax-music3", checkpoint: null }, choices: [choice.minimax(false), choice.paid()], machine: MACHINES[0].machine, api: apiOn });
ok("a saved MiniMax with API mode on is judged by the key, not the missing local files",
  savedHosted.ready === true && savedHosted.paid && /through your own API key/.test(savedHosted.why) && !/not ready on this PC/.test(savedHosted.why), savedHosted.why);
ok("API mode off: the machine never names a paid row, even with only a key ready",
  defaultFor("music", { choices: [choice.paid()], machine: MACHINES[0].machine }).paid === false);

ok("the clip step sentence says it is for clips (music videos read it once their lane lands)",
  /steps for clips/.test(defaultFor("videoSteps", { stepDefaults: { standard: 4 }, turboBuilds: { a: true } }).why));
let threw = false; try { defaultFor("nonsense"); } catch { threw = true; }
ok("an unknown kind is an error, not a guess", threw);

console.log("\n§2  the video step default on the disks mcp-steer_test.js builds");
{
  /* The same LoRA files and the same child-process read as mcp-steer_test.js:
   * each disk is a temp models folder holding only the named files, read by
   * config.js's own pick() in a fresh process. */
  const L = {
    fl2v8: "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
    fl2v4: "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors",
    ref8: "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
    ref4: "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
  };
  const probe = `import { config } from ${url("./config.js")}; import { defaultFor } from ${url("./fit.js")};`
    + "const h3 = config.video.engines.h3;"
    + "console.log(JSON.stringify({ steps: h3.steps, d: defaultFor('videoSteps', { engine: 'h3', label: h3.label, stepDefaults: h3.stepDefaults, turboBuilds: h3.turboBuilds }) }));";
  const disk = (files) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "defaults-disk-"));
    try {
      fs.mkdirSync(path.join(dir, "models", "loras"), { recursive: true });
      for (const f of files) fs.writeFileSync(path.join(dir, "models", "loras", f), "x");
      const env = { ...process.env, AIPLAY_APPDATA: path.join(dir, "settings"), AIPLAY_MODELS_DIR: path.join(dir, "models"),
        AIPLAY_RIG: path.join(dir, "rig"), AIPLAY_OUTPUT: path.join(dir, "output") };
      delete env.AIPLAY_MUSIC_ONLY;
      return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", probe], { env, encoding: "utf8", timeout: 60_000 }).trim().split("\n").at(-1));
    } catch (e) { return { error: String(e.message || e).slice(0, 300) }; }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  const eight = disk([L.fl2v8, L.fl2v4, L.ref8, L.ref4]), four = disk([L.fl2v4, L.ref4]);
  ok("the 8-step disk: the default is 8 steps, the matched count, and it says why",
    eight.d?.value === 8 && eight.steps === 8 && eight.d.chosenBy === "machine" && /made for/.test(eight.d.why), JSON.stringify(eight));
  ok("the 4-step-only disk: 4, never the 8 the old literal ran a 4-step file at",
    four.d?.value === 4 && four.steps === 4 && four.d.ready, JSON.stringify(four));
  const empty = disk([]);
  ok("no speed-up files at all: the fallback count, and it does not claim to be matched",
    empty.d?.value === empty.steps && empty.d.ready === false && /None are on this PC yet/.test(empty.d.why), JSON.stringify(empty));
}

console.log("\n§3  config.js: who chose, and what reaches settings.json");
{
  /* One fresh process per settings file: config.js reads it at import. The
   * image row is worked out the way index.js machineDefaults() does, on a disk
   * that holds EVERY picture model (the owner's). */
  const probe = `import { config, prefsSnapshot, prefChosen, prefOrigin, applyMachineDefault, overrideForSession, sessionOverride, forgetPref, LITERAL_DEFAULTS } from ${url("./config.js")};`
    + `import { defaultFor, readMachine } from ${url("./fit.js")}; import { CATALOG, isPictureModel } from ${url("./models.js")};`
    + "const every = CATALOG.filter(isPictureModel).map((c) => ({ ...c, ready: true, totalBytes: (c.files || []).reduce((n, f) => n + (f.bytes || 0), 0) }));"
    + "const machine = readMachine({ name: 'RTX 4070 Ti SUPER', totalMb: 16376, vendor: 'nvidia' }, { totalMb: 32768 });"
    + "const out = { literal: LITERAL_DEFAULTS, before: { music: config.music.engine, chosen: prefChosen('music','engine'), art: prefChosen('art','engine'), ckpt: prefChosen('music','yue2Checkpoint'),"
    + "  image: config.image.engine, imageChosen: prefChosen('image','engine'), origin: { music: prefOrigin('music','engine'), art: prefOrigin('art','engine'), image: prefOrigin('image','engine') },"
    + "  session: sessionOverride('music','engine') } };"
    + "out.imageDefault = defaultFor('image', { saved: prefChosen('image','engine') ? config.image.engine : null, kept: prefOrigin('image','engine') === 'kept', capabilities: every, machine });"
    + "out.snapFresh = prefsSnapshot();"
    + "out.applied = applyMachineDefault('music','engine','yue2-comfy'); out.afterApply = { music: config.music.engine, chosen: prefChosen('music','engine') };"
    + "out.snapApplied = prefsSnapshot().music?.engine ?? null;"
    + "out.swap = overrideForSession('music','engine','yue2-gguf','a reason'); out.afterSwap = { music: config.music.engine, snap: prefsSnapshot().music?.engine ?? null, session: sessionOverride('music','engine') };"
    + "config.music.engine = 'ace-step15'; out.afterAssign = { chosen: prefChosen('music','engine'), origin: prefOrigin('music','engine'), snap: prefsSnapshot().music?.engine ?? null, refused: applyMachineDefault('music','engine','yue2-gguf'), session: sessionOverride('music','engine') };"
    + "config.image.engine = 'zimage'; out.imagePicked = { origin: prefOrigin('image','engine'), snap: prefsSnapshot().image?.engine ?? null, kept: prefsSnapshot().keptFromBefore };"
    + "forgetPref('music','engine'); out.forgot = { chosen: prefChosen('music','engine'), snap: prefsSnapshot().music?.engine ?? null };"
    + "out.spread = { ...config.music }.engine;"
    + "console.log(JSON.stringify(out));";
  const run = (settings, extraEnv = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "defaults-cfg-"));
    try {
      fs.mkdirSync(path.join(dir, "settings"), { recursive: true });
      if (settings) fs.writeFileSync(path.join(dir, "settings", "settings.json"), JSON.stringify(settings));
      const env = { ...process.env, AIPLAY_APPDATA: path.join(dir, "settings"), AIPLAY_MODELS_DIR: path.join(dir, "models"),
        AIPLAY_RIG: path.join(dir, "rig"), AIPLAY_OUTPUT: path.join(dir, "output"), ...extraEnv };
      if (!("AIPLAY_MUSIC_ONLY" in extraEnv)) delete env.AIPLAY_MUSIC_ONLY;
      return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", probe], { env, encoding: "utf8", timeout: 60_000 }).trim().split("\n").at(-1));
    } catch (e) { return { error: String(e.message || e).slice(0, 300) }; }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  const fresh = run(null);
  ok("a fresh install: nothing chosen, and the literals are only the last resort",
    fresh.before?.chosen === false && fresh.before.art === false && fresh.before.imageChosen === false && fresh.literal?.music?.engine === "minimax-music3"
    && fresh.literal?.art?.engine === "qwen-image-2.1" && fresh.literal?.image?.engine === "qwen-image-2.1", JSON.stringify(fresh).slice(0, 300));
  ok("...settings.json is not handed the music, picture or cover engine, and is marked as this Studio's",
    fresh.snapFresh?.music?.engine === undefined && fresh.snapFresh?.art?.engine === undefined && fresh.snapFresh?.image?.engine === undefined
    && fresh.snapFresh?.music?.yue2Checkpoint === undefined && fresh.snapFresh?.art?.enabled === true
    && JSON.stringify(fresh.snapFresh?.keptFromBefore) === "[]", JSON.stringify(fresh.snapFresh));
  ok("...so its pictures follow the disk: FLUX.2 klein on a disk holding every picture model", fresh.imageDefault?.value === "flux2"
    && fresh.imageDefault.chosenBy === "machine", JSON.stringify(fresh.imageDefault));
  ok("the machine's pick is applied live and never written", fresh.applied === true && fresh.afterApply?.music === "yue2-comfy"
    && fresh.afterApply.chosen === false && fresh.snapApplied === null);
  ok("a person's assignment is a choice: remembered, and the machine cannot move it",
    fresh.afterAssign?.chosen === true && fresh.afterAssign.origin === "you" && fresh.afterAssign.snap === "ace-step15" && fresh.afterAssign.refused === false);
  ok("a person's pick on the Images screen is saved (image.engine is a real preference now)",
    fresh.imagePicked?.origin === "you" && fresh.imagePicked.snap === "zimage");
  ok("\"auto\" forgets it, so the next start works it out again", fresh.forgot?.chosen === false && fresh.forgot.snap === null);
  ok("a spread of config.music still carries the engine (accessors are enumerable)", fresh.spread === "ace-step15");
  const next = run({ prefs: fresh.snapFresh });
  ok("the next start of a fresh install reads its own file as its own: still nothing chosen, Qwen not pinned",
    next.before?.chosen === false && next.before.imageChosen === false && next.imageDefault?.value === "flux2", JSON.stringify(next.before));

  /* THE OWNER'S MACHINE, from the owner's real prefs as an older Studio wrote
   * them (no keptFromBefore): nothing moves, and nothing claims a choice. */
  const OWNER = { tier: "auto", music: { engine: "yue2", precision: "int8", yue2Checkpoint: INT8 }, art: { enabled: true, engine: "qwen-image-2.1", checkpoint: "dreamshaper_8.safetensors" } };
  const owner = run({ prefs: OWNER });
  ok("the owner's machine: a saved YuE2 Python kit is kept, and nothing moves it",
    owner.before?.music === "yue2" && owner.before.chosen === true && owner.applied === false && owner.afterApply?.music === "yue2"
    && owner.snapFresh?.music?.engine === "yue2" && owner.snapFresh?.art?.engine === "qwen-image-2.1", JSON.stringify(owner).slice(0, 300));
  ok("...its pictures and music-video stills stay on Qwen Image 2.1, on a disk that also holds FLUX.2 klein",
    owner.before?.image === "qwen-image-2.1" && owner.before.imageChosen === true && owner.imageDefault?.value === "qwen-image-2.1"
    && owner.snapFresh?.image?.engine === "qwen-image-2.1", JSON.stringify({ image: owner.imageDefault, snap: owner.snapFresh?.image }));
  ok("...every value an older Studio saved is \"kept\" (Saved in your settings), not \"You chose\"",
    owner.before?.origin?.music === "kept" && owner.before.origin.art === "kept" && owner.before.origin.image === "kept"
    && /^Saved in your settings: /.test(owner.imageDefault?.why || "")
    && ["music.engine", "music.yue2Checkpoint", "art.engine", "image.engine"].every((k) => owner.snapFresh?.keptFromBefore?.includes(k)), JSON.stringify(owner.before?.origin));
  ok("...a session swap of a saved choice is never written back: settings.json keeps it",
    owner.swap === true && owner.afterSwap?.music === "yue2-gguf" && owner.afterSwap.snap === "yue2" && owner.afterSwap.session?.saved === "yue2");
  ok("...a person's own change ends the swap and is theirs from then on",
    owner.afterAssign?.origin === "you" && owner.afterAssign.session === null && !owner.imagePicked?.kept?.includes("image.engine"));
  const ownerNext = run({ prefs: owner.snapFresh });
  ok("...and the next start still reads them as kept (the list travels in settings.json)",
    ownerNext.before?.origin?.music === "kept" && ownerNext.before.origin.image === "kept" && ownerNext.before.image === "qwen-image-2.1");
  ok("...and a saved null checkpoint is no choice, so the machine may fill it",
    run({ prefs: { music: { engine: "yue2", yue2Checkpoint: null } } }).before?.ckpt === false);

  const musicOnly = run(null, { AIPLAY_MUSIC_ONLY: "1" });
  ok("the music-only launch starts on native GGUF without calling it a choice",
    musicOnly.before?.music === "yue2-gguf" && musicOnly.before.chosen === false && musicOnly.before.session === null, JSON.stringify(musicOnly.before));
  const ownerMusicOnly = run({ prefs: OWNER }, { AIPLAY_MUSIC_ONLY: "1" });
  ok("the owner's saved Python kit under the music-only launch: GGUF for this session, \"yue2\" stays in settings.json",
    ownerMusicOnly.before?.music === "yue2-gguf" && ownerMusicOnly.before.chosen === true
    && ownerMusicOnly.before.session?.saved === "yue2" && /music-only launch/.test(ownerMusicOnly.before.session?.reason || "")
    && ownerMusicOnly.snapFresh?.music?.engine === "yue2", JSON.stringify(ownerMusicOnly.before));
}

console.log("\n§4  index.js and the MCP surface");
{
  const index = src("./index.js"), mcp = src("./mcp.js");
  ok("the resolver's answer reaches the live config only through applyMachineDefault",
    /applyMachineDefault\("music", "engine", music\.value\);/.test(index) && /applyMachineDefault\("art", "engine", cover\.value\);/.test(index)
    && /applyMachineDefault\("image", "engine", image\.value\);/.test(index) && !/config\.music\.engine = music\.value/.test(index));
  ok("/api/status works the defaults out before it reads the engine, and sends them",
    /if \(p === "\/api\/status"\) \{[\s\S]{0,400}const defaults = await machineDefaults\(\)/.test(index) && /\n\s+defaults,\n\s+musicOnly: config\.musicOnly,/.test(index));
  ok("a song with no engine named follows the disk first", /if \(body\.engine === undefined && typeof machineDefaults === "function"\) await machineDefaults\(\)/.test(index));
  ok("...and so does a picture with no engine named (make_image, /api/image)",
    /if \(!b\.engine && typeof machineDefaults === "function"\) await machineDefaults\(\)\.catch\(\(\) => null\);\n\s+const engine = b\.engine \|\| config\.image\.engine;/.test(index));
  /* THE CARD FIRST (review): gpuStatus() is null until its first reading, and a
   * default worked out in that window treated every card as no card. */
  const md = /\nasync function machineDefaults\(\) \{[\s\S]*?\n\}\n/.exec(index)?.[0] || "";
  ok("machineDefaults waits for the card's first reading, and caches nothing read before it",
    /await gpuFirstReading\(\);[\s\S]*readMachine\(gpuStatus\(\), ramStatus\(\)(, \{ cpuOnly: cpuOnlyEngine\(\)(, vaeMeasured: h3VaeMeasured\(\))? \})?\)/.test(md) && /defaultsCache = gpuReadOnce\(\) \?/.test(md), md.slice(0, 200));
  {
    /* ...and the wait itself, on this machine's own card (or none): null
     * before the first reading, then the reading, and "read once" either way. */
    const gpu = await import("./gpu.js");
    const before = gpu.gpuReadOnce();
    const first = gpu.gpuStatus();
    const waited = await gpu.gpuFirstReading(10_000);
    ok("gpuFirstReading waits out the first reading that gpuStatus() answers null for",
      before === false && first === null && gpu.gpuReadOnce() === true && (waited === null || waited.totalMb > 0)
      && (await gpu.gpuFirstReading(1)) === waited, JSON.stringify({ before, first, waited: waited && waited.name }));
  }
  ok("...passing what is saved, whether an older Studio kept it, this session's swap, and API mode",
    /kept: prefOrigin\("music", "engine"\) === "kept"/.test(md) && /session: swap \|\| ckptSwap/.test(md)
    && /api: \{ enabled: !!config\.api\?\.enabled/.test(md) && /saved: prefChosen\("image", "engine"\) \? config\.image\.engine : null/.test(md));
  ok("the startup swaps are this session's only (config.js overrideForSession), with a reason, and nothing is saved over them",
    /const settle = \(group, key, value, reason\) => overrideForSession\(group, key, value, reason\);/.test(index)
    && (index.match(/settle\("music", "(engine|yue2Checkpoint)", [^\n]*, "[^"]+"\)/g) || []).length === 4
    && !/config\.music\.yue2Checkpoint = ckpts\.find/.test(index)
    && !/settle\("music", "engine", "yue2-comfy", "Native YuE2 GGUF is not installed"\);[\s\S]{0,500}savePrefs\(\);[\s\S]{0,200}native YuE2 GGUF is selected but not installed/.test(index));
  ok("the doors that choose what runs ask first: /api/music and /api/artconfig (run for real in cross-origin-doors_test.js)",
    /if \(p === "\/api\/music" && req\.method === "POST"\) \{[\s\S]{0,400}if \(!sameOriginLocalJson\(req\)\) return json\(res, 403/.test(index)
    && /if \(p === "\/api\/artconfig" && req\.method === "POST"\) \{[\s\S]{0,400}if \(!sameOriginLocalJson\(req\)\) return json\(res, 403/.test(index)
    && /"POST \/api\/music /.test(src("./cross-origin-doors_test.js")) && /"POST \/api\/artconfig /.test(src("./cross-origin-doors_test.js")));
  ok("the covers card's Apply does not freeze the machine's pick, unless it was picked on purpose (`choose`)",
    /if \(b\.choose === true \|\| b\.engine !== config\.art\.engine \|\| prefChosen\("art", "engine"\)\) config\.art\.engine = b\.engine;/.test(index)
    && /if \(\$\("artEngine"\)\.dataset\.touched === "1"\) body\.choose = true;/.test(src("../web/app.js")));
  ok("\"auto\" forgets a picture or cover choice at the same door, and the Images engine is saved there too",
    /if \(b\.engine === "auto" \|\| b\.imageEngine === "auto"\) \{[\s\S]{0,200}forgetPref\("art", "engine"\)[\s\S]{0,100}forgetPref\("image", "engine"\)/.test(index)
    && /if \(b\.imageEngine !== undefined\) config\.image\.engine = b\.imageEngine;/.test(index));
  /* THE COVER GATE, run: sliced out of index.js with only the names it reads. */
  const body = /\nasync function coverCanRun\(\) \{[\s\S]*?\n\}\n/.exec(index)?.[0] || "";
  const gate = (answer) => {
    const logs = [];
    const fn = new Function("machineDefaults", "console", `let coverSkipSaid = false; ${body}; return coverCanRun;`)(
      async () => answer, { log: (m) => logs.push(m) });
    return fn().then((v) => ({ v, logs }));
  };
  const off = await gate([{ key: "art.engine", canRun: false, why: COVER_NEEDS_MODEL }]);
  const on = await gate([{ key: "art.engine", canRun: true, why: "x" }]);
  ok("no picture model: no cover job is queued, and the log says the one sentence",
    off.v === false && /Add a picture model to get covers\./.test(off.logs[0] || ""), JSON.stringify(off));
  ok("a picture model: covers run", on.v === true);
  ok("Qwen is no longer waved through without its files", !/if \(config\.art\.engine === QWEN_IMAGE_ENGINE\) return true;/.test(index));
  ok("every automatic cover asks first: after a song, after a merge, and \"Draw any missing covers\" says the sentence",
    /if \(\(live \? live\.cover : true\) && await coverCanRun\(\)\) \{/.test(index) && /if \(await coverCanRun\(\)\) art\.request\(\{ file: out,/.test(index)
    && /if \(b\.action === "backfill" \|\| b\.action === "regenerate"\) \{[\s\S]{0,300}cover\.canRun === false\) \{\n\s+return json\(res, 409, \{ error: cover\.why,/.test(index));

  /* studio_status and set_music_engine, run as their own stdio process against
   * a stub Studio, the way mcp-steer_test.js drives make_clip. */
  const smt = tool("set_music_engine");
  ok("set_music_engine exists, offers \"auto\" and exactly the engines config.js has",
    JSON.stringify([...(smt?.inputSchema?.properties?.engine?.enum || [])].sort())
      === JSON.stringify(["auto", ...Object.keys(config.music.engines)].sort()), JSON.stringify(smt?.inputSchema?.properties?.engine?.enum));
  ok("...posts the Music page's own door, both ways", /api\("POST", "\/api\/music", \{ action: "model", value:/.test(String(smt?.run))
    && /api\("POST", "\/api\/music", \{ action: "engine", value: a\.engine \}\)/.test(String(smt?.run)));
  ok("...and is withheld from the in-app chat by sentence, like set_image_engine and set_video_engine",
    typeof WITHHELD?.set_music_engine === "string" && /Music page/.test(WITHHELD.set_music_engine) && !("set_music_engine" in (ROUTABLE || {})));
  ok("the API doc names it", /`set_music_engine`/.test(src("../API.md")));
  ok("make_image and set_image_engine no longer promise Qwen as the fresh default",
    !/defaulting to Qwen Image 2\.1/.test(mcp) && !/Fresh installs default to Qwen/.test(mcp));

  const DEFAULTS = [
    { key: "music.engine", value: "yue2-comfy", chosenBy: "machine", why: "Studio picked YuE2 3B for music because it is ready on this PC." },
    { key: "image.engine", value: "qwen-image-2.1", chosenBy: "you", kept: true, why: "Saved in your settings: Qwen Image 2.1 for pictures." },
    { key: "art.engine", value: "flux2", chosenBy: "machine", why: COVER_NEEDS_MODEL, canRun: false },
  ];
  const posts = [], imagePosts = [], artPosts = [];
  const stub = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    res.setHeader("Content-Type", "application/json");
    const body = () => JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (req.method === "GET" && req.url === "/api/status") {
      return res.end(JSON.stringify({ art: {}, config: { musicEngine: "yue2-comfy", defaults: DEFAULTS,
        musicModels: [choice.comfy(INT8), choice.paid()] } }));
    }
    if (req.method === "POST" && req.url === "/api/music") {
      posts.push(body());
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === "GET" && req.url.startsWith("/api/images")) return res.end(JSON.stringify({ images: [] }));
    if (req.method === "POST" && req.url === "/api/image") {
      imagePosts.push(body());
      return res.end(JSON.stringify({ error: "stub: nothing is drawn here" }));
    }
    if (req.method === "POST" && req.url === "/api/artconfig") {
      const b = body();
      artPosts.push(b);
      return res.end(JSON.stringify({ ok: true, engine: b.engine || "flux2", imageEngine: b.imageEngine || "qwen-image-2.1", checkpoint: null,
        chosen: { engine: !!b.choose, imageEngine: !!b.imageEngine } }));
    }
    return res.end("{}");
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const proc = spawn(process.execPath, [fileURLToPath(new URL("./mcp.js", import.meta.url))], {
    env: { ...process.env, AIPLAY_URL: `http://127.0.0.1:${stub.address().port}` }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const replies = new Map();
  let buffer = "", serial = 0;
  proc.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let cut; (cut = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1);
      try { const r = JSON.parse(line); replies.get(r.id)?.(r); } catch { /* only JSON-RPC replies matter */ }
    }
  });
  const call = (name, args) => new Promise((resolve) => {
    const id = ++serial, timer = setTimeout(() => resolve({ error: "timed out" }), 20_000);
    replies.set(id, (r) => { clearTimeout(timer); replies.delete(id); resolve(r); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
  const parsed = (r) => { try { return JSON.parse(r.result?.content?.[0]?.text || "{}"); } catch { return {}; } };
  try {
    const status = parsed(await call("studio_status", {}));
    ok("studio_status returns defaults: key, value, chosenBy, why, and `kept` for a value an older Studio saved",
      JSON.stringify(status.defaults?.map((d) => [d.key, d.value, d.chosenBy])) === JSON.stringify(DEFAULTS.map((d) => [d.key, d.value, d.chosenBy]))
      && status.defaults?.[1]?.kept === true && status.defaults[0].kept === undefined
      && status.defaults?.[2]?.canRun === false && status.defaults[2].why === COVER_NEEDS_MODEL, JSON.stringify(status.defaults));
    const listed = parsed(await call("set_music_engine", {}));
    ok("set_music_engine with nothing changes nothing and lists the builds, the paid one marked",
      posts.length === 0 && listed.chosenBy === "machine" && listed.choices?.length === 2 && listed.choices[1].paid === true, JSON.stringify(listed));
    await call("set_music_engine", { engine: "auto" });
    await call("set_music_engine", { model: `yue2-comfy:${INT8}` });
    ok("...engine posts action engine, model posts action model",
      JSON.stringify(posts) === JSON.stringify([{ action: "engine", value: "auto" }, { action: "model", value: `yue2-comfy:${INT8}` }]), JSON.stringify(posts));
    const both = await call("set_music_engine", { engine: "yue2", model: "yue2" });
    ok("...and both at once is refused, not guessed", !!(both.error || both.result?.isError));

    /* make_image WITH NO ENGINE POSTS NO ENGINE (review): it hard-coded Qwen,
     * so a FLUX-only install was aimed at files it never downloaded. */
    await call("make_image", { prompt: "a red kite", timeout_seconds: 5 });
    await call("make_image", { prompt: "a red kite", engine: "zimage", timeout_seconds: 5 });
    ok("make_image with no engine sends none (the route uses the saved or machine-picked one); a named one is sent",
      imagePosts.length === 2 && !("engine" in imagePosts[0]) && imagePosts[1].engine === "zimage", JSON.stringify(imagePosts.map((b) => b.engine ?? null)));

    /* set_image_engine: covers by default and always a choice; pictures with use_for; "auto" forgets. */
    await call("set_image_engine", { engine: "flux2" });
    await call("set_image_engine", { engine: "zimage", use_for: "pictures" });
    await call("set_image_engine", { engine: "krea2", use_for: "both" });
    await call("set_image_engine", { engine: "auto", use_for: "both" });
    const refusedCkpt = await call("set_image_engine", { engine: "checkpoint", use_for: "pictures", checkpoint: "x.safetensors" });
    ok("set_image_engine: a cover pick is always remembered (choose), even when it is the machine's own",
      artPosts[0]?.engine === "flux2" && artPosts[0].choose === true && !("imageEngine" in artPosts[0]), JSON.stringify(artPosts[0]));
    ok("...use_for pictures saves the Images engine only; both saves both",
      JSON.stringify(artPosts[1]) === JSON.stringify({ imageEngine: "zimage" })
      && artPosts[2]?.engine === "krea2" && artPosts[2].imageEngine === "krea2" && artPosts[2].choose === true, JSON.stringify(artPosts.slice(1, 3)));
    ok("...\"auto\" forgets both, and is not sent as a choice",
      JSON.stringify(artPosts[3]) === JSON.stringify({ engine: "auto", imageEngine: "auto" }), JSON.stringify(artPosts[3]));
    ok("...and your own model file is refused for pictures (it is picked per picture)",
      !!(refusedCkpt.error || refusedCkpt.result?.isError) && artPosts.length === 4);
  } finally {
    proc.kill();
    await new Promise((resolve) => stub.close(resolve));
  }
}

console.log("\n§5  the writing-model list: only models that can write, by name");
{
  const NOT = ["qwen_3_06b_base.safetensors", "qwen_4b_ace15.safetensors", "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors", "qwen3vl_8b_nvfp4.safetensors"];
  const YES = ["qwen_3_4b.safetensors", "qwen3vl_8b_fp8_scaled.safetensors", "Qwen3-VL-4B-Instruct-abliterated.fp8.safetensors"];
  ok("base models, ACE-Step's planners, LTX's Gemma and fp4 off an RTX 50 are not writers, each with a reason",
    NOT.every((f) => { const v = writerVerdict(f, { gpuName: "NVIDIA GeForce RTX 4070 Ti SUPER" }); return !v.ok && v.why; }));
  ok("...the fp4 build IS one on an RTX 50-series card", writerVerdict("qwen3vl_8b_nvfp4.safetensors", { gpuName: "NVIDIA GeForce RTX 5090" }).ok);
  ok("the rest write", YES.every((f) => writerVerdict(f, { gpuName: "RTX 4070" }).ok));
  ok("friendly names: \"Qwen3 4B - writes lyrics and prompts\"", writerLabel("qwen_3_4b.safetensors") === "Qwen3 4B - writes lyrics and prompts"
    && writerLabel("qwen3vl_8b_fp8_scaled.safetensors") === "Qwen3-VL 8B - writes lyrics and prompts");
  const fakeEngine = { objectInfo: async (cls) => (cls === "CLIPLoader"
    ? { CLIPLoader: { input: { required: { clip_name: [[...NOT, ...YES.slice(0, 2)]] } } } } : null) };
  const models = createChatModels({ engine: fakeEngine, config: {}, gpu: () => ({ name: "NVIDIA GeForce RTX 4070" }) });
  const st = await models.status();
  ok("/models answers with the writers only, by friendly name", st.models.length === 2
    && st.models.every((m) => / - writes lyrics and prompts$/.test(m.label)) && st.models[0].file === "qwen_3_4b.safetensors", JSON.stringify(st.models));
  ok("...and every file under `every`, the others with their reason", st.every.length === 6 && st.every.filter((m) => m.why).length === 4);
  ok("with nothing chosen, a writer answers, never a base model", st.current === "qwen_3_4b.safetensors" && (await models.resolve()).file === "qwen_3_4b.safetensors");
  const baseOnly = createChatModels({ engine: { objectInfo: async (cls) => (cls === "CLIPLoader"
    ? { CLIPLoader: { input: { required: { clip_name: [["qwen_3_06b_base.safetensors", "qwen3vl_4b_fp8_scaled.safetensors"]] } } } } : null) }, config: {} });
  ok("...even when the base model ranks first by name", (await baseOnly.resolve()).file === "qwen3vl_4b_fp8_scaled.safetensors");
  const mine = createChatModels({ engine: fakeEngine, config: { chatModel: "qwen_3_06b_base.safetensors" } });
  ok("a person's own choice stays in the list even when it is not a writer",
    (await mine.status()).models.some((m) => m.file === "qwen_3_06b_base.safetensors"));
  const chat = src("../web/chat.js");
  ok("one usable choice is plain text, and \"Show every file\" is one click away (web/chat.js)",
    /const single = !all && models\.length === 1 && !d\?\.offline;/.test(chat) && /sel\.hidden = single;/.test(chat) && /Show every file/.test(chat));
  const enh = tool("enhance_model");
  ok("enhance_model returns the same filtered list, and the rest with reasons", /not_writers:/.test(String(enh?.run)));
  /* ALL SIX PICKERS (review): Settings' Enhance picker painted its own menu. */
  const pt = src("../web/prompt-tools.js");
  ok("the Enhance picker goes through fillModelMenu too, with its own first choice",
    /import \{ fillModelMenu \} from "\.\/chat\.js";/.test(pt) && /fillModelMenu\(sel, d, [^\n]*\n\s+\{ lead: "Same as Simple mode \(then Chat\)" \}\)/.test(pt)
    && !/rows\.map\(\(m\) => `<option value=/.test(pt) && /if \(opts\.lead\) sel\.value = d\.own/.test(chat));
  ok("\"Show every file\" is an Advanced thing: hidden beside the Simple writers",
    /\.simple-model \.mpick1 \[data-every\] \{ display: none; \}/.test(src("../web/styles.css")));
}

console.log("\n§6  the receipt lane");
{
  const { RECEIPTS, DEFAULT_CONTROLS, estimateOf } = await import("../web/receipt.js");
  const html = src("../web/index.html"), app = src("../web/app.js");
  const has = (id) => new RegExp(`\\bid="${id}"`).test(html);
  const ids = Object.values(RECEIPTS).flatMap((r) => [r.note, r.button, ...r.fields.flatMap((f) => f.controls)]);
  const missing = ids.filter((id) => !has(id));
  ok(`every receipt field names a control that exists in web/index.html (${ids.length} ids)`, ids.length >= 15 && !missing.length, missing.join(", "));
  ok("...every field but the estimate names at least one", Object.values(RECEIPTS).every((r) => r.fields.every((f) => f.estimate || f.controls.length)));
  const views = [...html.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]);
  const dMissing = Object.entries(DEFAULT_CONTROLS).filter(([, w]) => !has(w.control) || !views.includes(w.view)).map(([k]) => k);
  ok("every default's Change leads to a real control on a real screen", !dMissing.length, dMissing.join(", "));
  const keys = new Set(["music", "image", "cover", "videoSteps"].map((k) => defaultFor(k, { choices: [], capabilities: [], stepDefaults: { standard: 4 } }).key));
  ok("...and names exactly the keys the resolver sends", JSON.stringify([...keys].sort()) === JSON.stringify(Object.keys(DEFAULT_CONTROLS).sort()));
  ok("the estimate is read off the screen's own note, without its tail",
    estimateOf("about 4:00 on your card · re-rolls ~3× faster") === "about 4:00"
    && estimateOf("2 takes · about 8:00 in total on your card") === "2 takes · about 8:00 in total"
    && estimateOf("about 3:10 once the engine is idle · 124 frames at 24 fps") === "about 3:10"
    && estimateOf("⚠ “x” failed: y") === null);
  ok("app.js hands every status to the receipts, typeof-guarded", /if \(typeof globalThis\.aiplayReceipts === "function"\) globalThis\.aiplayReceipts\(s\);/.test(app));
  ok("a failed start on Music, Pictures and Video is said under its button, typeof-guarded",
    ["ctaNote", "imgNote", "vidEst"].every((n) => new RegExp(`typeof globalThis\\.aiplayStartFailed === "function"\\) globalThis\\.aiplayStartFailed\\("${n}", `).test(app))
    && /Couldn't start: /.test(src("../web/receipt.js")));
  ok("a machine-picked music engine follows the disk on the page until the person picks",
    /musicDefault\?\.chosenBy === "machine"\s*&& state\.musicEngine === state\.musicEngineSeeded/.test(app));
  ok("Settings lists what Studio picked", /id="set-defaults" data-nav="Picked for this PC"/.test(html) && has("defaultsList"));
  const css = src("../web/styles.css");
  ok("the estimate stays visible: no hover-only note (Bucky's d04ad3e drop-up undone)",
    !/\.ctawrap:hover > \.ctanote/.test(css) && /\.ctawrap > \.ctanote\.rc-took:not\(\.stick\) \{ display: none; \}/.test(css));
  /* THE ENGINE INTERNALS MOVED to the ⓘ panel (catalogue.js howItRuns). */
  const { TABS } = await import("./welcome/catalogue.js");
  const how = (TABS.find((t) => t.id === "create")?.howItRuns || []).join(" ");
  ok("the Python kit's fresh process is said in the ⓘ panel, not under Create",
    /fresh Python process/.test(how) && !/fresh Python process/.test(app.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")));
  ok("...and the prefill block and both measured ratios (2.65× against 2.39×), read from the Long rung and config.js",
    how.includes(`${config.yue.queryChunk}-token`) && how.includes(`${config.music.engines.yue2.realtimeRatio}×`) && how.includes("2.65×")
    && /re-roll of the same song runs about 3× faster/.test(how), how.slice(0, 300));
  ok("the Music ⓘ panel renders it", /howItRuns: tab\.howItRuns \?\? null/.test(src("./welcome/routes.js")) && /function howItRuns\(lines\)/.test(src("../web/info.js")));
  ok("art.lastError clears after a success", /job\.durationMs = job\.startedAt \? job\.finishedAt - job\.startedAt : null;\n[\s\S]{0,700}this\.lastError = null;\n\s+\} catch \(err\) \{/.test(src("./art.js")));
  ok("...and a failed row keeps its whole words for the waiters (fullError), which ownFailure reads first",
    /fullError: String\(j\.error\)\.slice\(0, 4000\)/.test(src("./art.js")) && /if \(typeof done\.fullError === "string" && done\.fullError\) return/.test(src("./art-wait.js")));
  ok("a music video brief accepts the Qwen engine (S5)", /imageEngine: \["flux2", "ideogram", "checkpoint", "qwen-image-2\.1"\]/.test(src("./mv/routes.js")));

  /* THE NOTE'S QUALIFIERS RIDE IN THE RECEIPT (review): hiding the note hid
   * "references ride along", "from your last N native songs", "~3× faster". */
  const { tailOf, LET_STUDIO_PICK } = await import("../web/receipt.js");
  ok("the receipt carries what followed the estimate in the note",
    tailOf("about 4:00 on your card · re-rolls ~3× faster") === "re-rolls ~3× faster"
    && tailOf("about 3:00 on your card · from your last 3 native songs") === "from your last 3 native songs"
    && tailOf("about 3:10 once the engine is idle · 124 frames at 24 fps · references ride along, expect it slower") === "124 frames at 24 fps · references ride along, expect it slower"
    && tailOf("2 takes · about 8:00 in total on your card") === null && tailOf("Native GGUF · your first song sets the estimate") === null);
  const rc = src("../web/receipt.js");
  ok("...and paints it after the estimate", /const tail = f\.estimate \? tailOf\(\$\(spec\.note\)\?\.textContent\) : null;/.test(rc) && /class="rctail"/.test(rc));
  ok("the engine's tooltip is the default's sentence only while the screen holds that default",
    /f\.id === "engine" && def && engineOf\(\$\(owner\[0\]\)\) === def\.value \? def\.why/.test(rc));
  ok("a start that went through (Create, Preview, Make image, Render clip) clears \"Couldn't start\", typeof-guarded",
    ["ctaNote", "imgNote", "vidEst"].every((n) => new RegExp(`typeof globalThis\\.aiplayStartOk === "function"\\) globalThis\\.aiplayStartOk\\("${n}"\\)`).test(app))
    && /globalThis\.aiplayStartOk = startOk;/.test(rc)
    && /state\.lastSpec = \{ \.\.\.spec \};\n[^\n]*\n\s+if \(typeof globalThis\.aiplayStartOk === "function"\) globalThis\.aiplayStartOk\("ctaNote"\);/.test(app));
  ok("Settings' \"Let Studio pick\" posts each key's own door, the one \"auto\" is handled at",
    LET_STUDIO_PICK["music.engine"]?.[0] === "/api/music" && LET_STUDIO_PICK["music.engine"][1].value === "auto"
    && LET_STUDIO_PICK["image.engine"]?.[1].imageEngine === "auto" && LET_STUDIO_PICK["art.engine"]?.[1].engine === "auto"
    && JSON.stringify(Object.keys(LET_STUDIO_PICK).sort()) === JSON.stringify(Object.keys(DEFAULT_CONTROLS).filter((k) => k !== "video.steps").sort())
    && /if \(b\.action === "engine" && b\.value === "auto"\) \{/.test(src("./index.js")));
  ok("...and the Music page re-seeds its engine once after it",
    /const reseed = globalThis\.aiplayMusicReseed === true;/.test(app) && /globalThis\.aiplayMusicReseed = true;/.test(rc));
  ok("the Images engine a person picks is saved (not \"kept until the next reload\")",
    /function imageEnginePicked\(sel\) \{[\s\S]{0,300}fetch\("\/api\/artconfig", \{ method: "POST"[^\n]*JSON\.stringify\(\{ imageEngine: sel\.value \}\)/.test(rc)
    && /if \(e\.isTrusted\) imageEnginePicked\(e\.target\);/.test(rc));

  /* THE COVER REFUSAL, ON THE PAGE (review): the 409 read as "Every track
   * already has a cover" and "Queued". Both handlers run against it. */
  const REFUSAL = { error: COVER_NEEDS_MODEL, needsModel: "coverArt", art: {} };
  const handler = (open) => {
    const at = app.indexOf(open);
    const end = app.indexOf("\n};\n", at);
    return at >= 0 && end > at ? app.slice(at, end + 3) : "";
  };
  const runHandler = async (open, reply) => {
    const els = {}, offered = [], alerts = [];
    const $ = (id) => (els[id] ||= { id, textContent: "", title: "", disabled: false, onclick: null });
    const fetchStub = async () => ({ json: async () => reply });
    const src2 = handler(open);
    new Function("$", "state", "fetch", "offerModel", "appAlert", src2)(
      $, { editFile: "song.flac" }, fetchStub, (r) => { offered.push(r); return true; }, async (m) => { alerts.push(m); });
    await $(open.match(/\$\("([^"]+)"\)/)[1]).onclick();
    return { els, offered, alerts, found: !!src2 };
  };
  const backfill = await runHandler('$("btnBackfillArt").onclick = async () => {', REFUSAL);
  ok("\"Draw any missing covers\" on a PC with no picture model says the server's sentence and offers the model",
    backfill.found && backfill.els.artNote?.textContent === COVER_NEEDS_MODEL && backfill.offered[0]?.needsModel === "coverArt", JSON.stringify(backfill.els.artNote));
  const queued = await runHandler('$("btnBackfillArt").onclick = async () => {', { ok: true, queued: 3 });
  ok("...and still says how many were queued when it can draw", /^3 queued\./.test(queued.els.artNote?.textContent || ""));
  const regen = await runHandler('$("edRegen").onclick = async () => {', REFUSAL);
  ok("the song editor's Regenerate says the sentence, not \"Queued\"",
    regen.found && regen.els.edArt?.title === COVER_NEEDS_MODEL && regen.offered.length === 1, JSON.stringify(regen.els.edArt));
  const regenOk = await runHandler('$("edRegen").onclick = async () => {', { ok: true });
  ok("...and \"Queued\" when it was", /^Queued/.test(regenOk.els.edArt?.title || ""));
}

console.log("\n§7  the launcher names what Studio will run (launcher/musiccard.mjs)");
{
  const { musicCards } = await import("../launcher/musiccard.mjs");
  const launcher = src("../launcher/launcher.mjs");
  ok("the launcher keeps no music default of its own", !/prefs\?\.music\?\.engine \|\| "minimax-music3"/.test(launcher)
    && /import \{ musicCards \} from "\.\/musiccard\.mjs";/.test(launcher) && /engine: cards\.full\.engine,/.test(launcher));
  const disk = { yue2: [BF16, INT8], comfyOk: true, ggufOk: false, minimaxReady: true };
  const freshNv = musicCards({ prefs: undefined, ...disk, vendor: "nvidia" });
  ok("a fresh settings.json with a YuE2 checkpoint on disk names YuE2 (the int8 build on NVIDIA), not MiniMax",
    /^YuE2 3B \(ComfyUI\) · int8/.test(freshNv.full.engine) && !/MiniMax/.test(freshNv.full.engine) && freshNv.full.warn === null
    && freshNv.full.chosenBy === "machine", JSON.stringify(freshNv.full));
  const freshAmd = musicCards({ prefs: {}, ...disk, vendor: "amd", amdMusicFixed: false });
  ok("...on AMD: the bf16 build, and no MiniMax warning nobody chose",
    /· bf16$/.test(freshAmd.full.engine) && freshAmd.full.warn === null, JSON.stringify(freshAmd.full));
  const savedMm = musicCards({ prefs: { music: { engine: "minimax-music3" }, keptFromBefore: [] }, ...disk, vendor: "amd", amdMusicFixed: false });
  ok("...the MiniMax warning is for somebody who saved MiniMax", /renders broken audio on AMD/.test(savedMm.full.warn || "") && /^MiniMax Music 3/.test(savedMm.full.engine));
  const owner = musicCards({ prefs: { music: { engine: "yue2", yue2Checkpoint: INT8 } }, ...disk, vendor: "nvidia" });
  ok("the owner's saved Python kit is named as saved, not replaced",
    owner.full.engine === "YuE2 3B (Python kit)" && /^Saved in your settings: /.test(owner.full.why), JSON.stringify(owner.full));
  const both = musicCards({ prefs: {}, yue2: [INT8], comfyOk: true, ggufOk: true, ggufPrecisions: ["q4_0"], vendor: "nvidia" });
  ok("music-only, as index.js decides it: native GGUF when installed and nothing else was saved",
    both.music.via === "yue2-gguf" && both.music.engine === "YuE2 GGUF (native)");
  const comfyOnly = musicCards({ prefs: {}, yue2: [BF16, INT8], comfyOk: true, ggufOk: false, vendor: "amd" });
  ok("...else YuE2 through ComfyUI with the build Studio loads (bf16 on AMD)", comfyOnly.music.via === "yue2-comfy" && /yue2_3b_bf16\)$/.test(comfyOnly.music.engine), comfyOnly.music.engine);
  const swap = musicCards({ prefs: { music: { engine: "yue2-gguf" }, keptFromBefore: [] }, yue2: [INT8], comfyOk: true, ggufOk: false, vendor: "nvidia" });
  ok("a saved GGUF that is not installed: this session through ComfyUI, and the choice stays saved",
    /for this session$/.test(swap.full.engine) && /your choice stays saved/.test(swap.full.warn || ""), JSON.stringify(swap.full));
  const hosted = musicCards({ prefs: {}, api: { enabled: true, provider: "fal" }, ...disk, vendor: "nvidia" });
  ok("API mode on: the hosted MiniMax on the person's own key, said so", /hosted, your API key/.test(hosted.full.engine) && /billed/.test(hosted.full.why));
  /* THE EMPTY DISK (release critic): the Full card named MiniMax Music 3 on
   * every fresh install, and on AMD warned about it. */
  const empty = { yue2: [], comfyOk: true, ggufOk: false, minimaxReady: false };
  for (const vendor of ["nvidia", "amd"]) {
    const e = musicCards({ prefs: {}, ...empty, vendor, amdMusicFixed: false });
    ok(`an empty disk on ${vendor}: the Full card names YuE2 through ComfyUI, Studio's pick, and no warning`,
      /^YuE2 3B \(ComfyUI\)/.test(e.full.engine) && e.full.chosenBy === "machine" && e.full.warn === null
      && !/MiniMax/.test(e.full.engine + e.full.why), JSON.stringify(e.full));
  }
  const noCard = musicCards({ prefs: {}, ...empty, vendor: null });
  ok("an empty disk with no card: the native GGUF", /^YuE2 GGUF/.test(noCard.full.engine) && !/MiniMax/.test(noCard.full.why), JSON.stringify(noCard.full));
  const small = musicCards({ prefs: {}, ...empty, vendor: "nvidia", comfyFits: false });
  ok("an empty disk on a card under YuE2-for-ComfyUI's minimum: the native GGUF", /^YuE2 GGUF/.test(small.full.engine), JSON.stringify(small.full));
  const { yue2ComfyFits, yue2ComfyVerdict } = await import("../launcher/checks.mjs");
  ok("the launcher reads that minimum off the catalogue row (6 GB no, 8 GB yes, unread: unknown)",
    yue2ComfyFits({ totalMb: 6144 }) === false && yue2ComfyFits({ totalMb: 8188 }) === true && yue2ComfyFits(null) === undefined
    && /const comfyVerdict = yue2ComfyVerdict\(gpu, totalmem\(\)\);/.test(launcher)
    && /cardRead: !!gpu\?\.totalMb, amdMusicFixed, comfyFits: comfyVerdict\.fits, comfyShort: comfyVerdict\.short,/.test(launcher));
  /* THE CPU-ONLY INSTALL (release critic): scripts/install-engine.mjs writes
   * settings.gpu { vendor: "cpu", totalMb: 0 }, and the launcher read "cpu" as
   * a card, so its Full card named YuE2 through ComfyUI while Studio named the
   * GGUF. The real stub now, not vendor null. */
  const cpuStub = { vendor: "cpu", name: "CPU only", totalMb: 0 };
  const cpuMachine = readMachine(null, { totalMb: 32768 }, { cpuOnly: true });
  const cpu = musicCards({ prefs: {}, ...empty, vendor: "cpu", cardRead: !!cpuStub.totalMb, comfyFits: yue2ComfyFits(cpuStub, 32 * 1024 ** 3) });
  ok("a CPU-only install's stub (vendor \"cpu\"): the launcher names the native GGUF Q4, as Studio does",
    yue2ComfyFits(cpuStub) === false && /^YuE2 GGUF/.test(cpu.full.engine) && /no graphics card/.test(cpu.full.why)
    && cpu.full.value === defaultFor("music", { choices: [], machine: cpuMachine }).value, JSON.stringify(cpu.full));
  const cpuDefault = musicCards({ prefs: {}, ...empty, vendor: "cpu" });
  ok("...even when nothing else says the card was not read", /^YuE2 GGUF/.test(cpuDefault.full.engine), JSON.stringify(cpuDefault.full));
  const unread = musicCards({ prefs: {}, ...empty, vendor: "amd", cardRead: false });
  ok("a card whose memory was not read is no reading, as Studio's readMachine counts it: the native GGUF",
    /^YuE2 GGUF/.test(unread.full.engine) && readMachine({ name: "AMD Radeon", vendor: "amd" }, { totalMb: 32768 }).gpu === null, JSON.stringify(unread.full));
  /* ONE JUDGEMENT, CARD AND RAM (release critic): the launcher checked VRAM
   * only, Studio's fitFor also applies the row's 16 GB RAM floor, so an 8 GB
   * laptop with 8 GB of RAM got two engines and Studio blamed the card. Both
   * now ask music-default.js yue2ComfyFit; this grid holds it to fitFor, and
   * the launcher's card to Studio's default, machine by machine. */
  const { yue2ComfyFitOn, fitFor } = await import("./fit.js");
  const comfyRow = CATALOG.find((c) => c.id === "musicYue2Comfy");
  const grid = [];
  for (const vramMb of [null, 6144, 8188, 12282, 16376]) {
    for (const ramGb of [7.7, 8, 12, 12.1, 15.4, 16, 31.4, 32]) grid.push({ vramMb, ramGb });
  }
  const disagree = [];
  for (const { vramMb, ramGb } of grid) {
    const gpu = vramMb ? { name: "NVIDIA GeForce RTX", totalMb: vramMb, vendor: "nvidia" } : null;
    const ramMb = Math.round(ramGb * 1024);
    const m = readMachine(gpu, { totalMb: ramMb });
    const studioFit = yue2ComfyFitOn(comfyRow, m);
    if ((studioFit.fits !== false) !== (fitFor(comfyRow.requires, m).state !== "wont-run")) disagree.push(`fitFor ${vramMb}/${ramGb}`);
    const studio = defaultFor("music", { choices: [], machine: m, comfyFits: studioFit.fits, comfyShort: studioFit.short });
    const v = yue2ComfyVerdict(gpu, ramMb * 1024 * 1024);
    const card = musicCards({ prefs: {}, ...empty, vendor: gpu?.vendor || null, cardRead: !!gpu?.totalMb, comfyFits: v.fits, comfyShort: v.short });
    if (card.full.value !== studio.value || card.full.why !== studio.why) disagree.push(`${vramMb}/${ramGb}: launcher ${card.full.value} · Studio ${studio.value}`);
  }
  ok(`the launcher and Studio name the same nothing-ready engine, in the same words, on ${grid.length} machines (card x RAM), and the judgement is fitFor's`,
    !disagree.length, disagree.join("; "));
  const lapMb = Math.round(7.7 * 1024);
  const laptop = readMachine({ name: "NVIDIA GeForce RTX 4060 Laptop GPU", totalMb: 8188, vendor: "nvidia" }, { totalMb: lapMb });
  const lf = yue2ComfyFitOn(comfyRow, laptop);
  const lapStudio = defaultFor("music", { choices: [], machine: laptop, comfyFits: lf.fits, comfyShort: lf.short });
  const lv = yue2ComfyVerdict({ totalMb: 8188, vendor: "nvidia" }, lapMb * 1024 * 1024);
  const lapCard = musicCards({ prefs: {}, ...empty, vendor: "nvidia", comfyFits: lv.fits, comfyShort: lv.short });
  ok("an 8 GB laptop with 7.7 GB of RAM: the GGUF on both surfaces, and the reason is the RAM, not the card",
    lapStudio.value === "yue2-gguf" && lapCard.full.value === "yue2-gguf" && /less RAM/.test(lapStudio.why)
    && !/this card is under/.test(lapStudio.why) && lapCard.full.why === lapStudio.why, lapStudio.why);
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
