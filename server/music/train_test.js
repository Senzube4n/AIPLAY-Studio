/**
 * THE TRAINING SCREEN, PINNED.
 *
 * Most of what matters here is not "does the code run" but "does it tell the
 * truth before somebody spends an hour of their graphics card". So the lane
 * checks the refusals, the two sentences the screen must carry, and the one
 * step that turns a finished run into a thing a person can actually use.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as train from "./train.js";

let passed = 0, failed = 0;
const ok = (what, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ok    ${what}`); }
  else { failed++; console.log(`  FAIL  ${what}${extra ? `\n        ${extra}` : ""}`); }
};
const eq = (what, a, b) => ok(what, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const html = src("../../web/index.html");
const app = src("../../web/app.js");
const index = src("../index.js");
const mcp = src("../mcp.js");

console.log("\nTRAINING — A SONG OF YOUR OWN");

/* ── the name becomes a filename, so it is rebuilt rather than trusted ────── */
eq("a typed name is rebuilt into a safe filename, with a prefix that tells it apart",
  train.trainName("My Song! v2"), "mine_My_Song_v2");
eq("...and a name with path characters keeps only the safe part",
  train.trainName("warm/piano: take 2"), "mine_warmpiano_take_2");
/* A name that is ONLY path characters leaves nothing behind, and refusing is
 * better than inventing a filename the person never chose. */
for (const bad of ["   ", "../../etc/passwd", "///", "..."]) {
  let threw = null;
  try { train.trainName(bad); } catch (e) { threw = e; }
  ok(`a name with nothing usable in it is refused rather than invented (${JSON.stringify(bad)})`,
    !!threw && threw.reason === "name");
}

/* ── the numbers clamp rather than refuse ────────────────────────────────── */
eq("every number clamps into its range — a control that refuses is one people work around",
  train.trainSettings({ steps: 99999, rank: 1, seconds: 5, learningRate: 99 }),
  { steps: train.STEPS_MAX, rank: train.RANK_MIN, seconds: train.SECONDS_MIN, learningRate: train.LR_MAX });
eq("...and an empty request is the measured defaults",
  train.trainSettings({}),
  { steps: 600, rank: 8, seconds: 24, learningRate: 0.0002 });

/* ── the refusals, in the order that makes each sentence the right one ───── */
{
  const base = { checkpoints: ["yue2_3b_int8_convrot.safetensors"], freeVramMb: 13000, busy: false };
  const noTok = await train.trainStatus({ ...base, tokenizer: { ready: false, missing: ["a.safetensors"] } });
  ok("no tokenizer is refused first, because nothing else can be true without it",
    noTok.reason === "tokenizer-missing" && !noTok.ready);
  const noCkpt = await train.trainStatus({ ...base, tokenizer: { ready: true }, checkpoints: [] });
  ok("...then a missing YuE2 checkpoint", noCkpt.reason === "no-checkpoint");
  const busy = await train.trainStatus({ ...base, tokenizer: { ready: true }, busy: true });
  ok("...then a card somebody else is using", busy.reason === "busy");
  const vram = await train.trainStatus({ ...base, tokenizer: { ready: true }, freeVramMb: 4000 });
  ok("...and VRAM last, because it is the only one that changes minute to minute",
    vram.reason === "vram");
  ok("...and the VRAM refusal names the measured number rather than a guess",
    /8\.9 GB/.test(vram.why) && /10 GB/.test(vram.why), vram.why);

  /* ⚠ AN AMD MACHINE CANNOT BE MEASURED BY nvidia-smi, and refusing to train on
   * a card we simply could not read would lock out exactly the friend this
   * feature is meant to reach. An unknown reading is not a small reading. */
  const unknown = await train.trainStatus({ ...base, tokenizer: { ready: true }, freeVramMb: null });
  ok("a card whose free memory cannot be READ is allowed to try, not refused",
    unknown.ready === true, JSON.stringify(unknown.reason));
}

/* ── the two sentences a person must see BEFORE pressing ─────────────────── */
{
  const st = await train.trainStatus({
    tokenizer: { ready: true }, checkpoints: ["yue2_3b.safetensors"], freeVramMb: 13000, busy: false,
  });
  ok("the licence that follows the adapter is stated, with the condition named",
    /CC BY-NC/.test(st.licence) && /non-commercial/i.test(st.licence));
  /* ⚠ THE HONESTY LINE IS NOT DECORATION. That the loop RUNS is measured; that a
   * given number of steps is AUDIBLE is not. A screen that implied otherwise
   * would cost somebody an hour of their card before they found out. */
  ok("...and so is the thing that is NOT yet measured",
    /not measured/i.test(st.honest) && /runs is measured/i.test(st.honest));
}
ok("both sentences reach the screen, from the door rather than composed twice",
  /id="trLicence"/.test(html) && /id="trHonest"/.test(html)
  && /\$\("trLicence"\)\.textContent = st\.licence/.test(app)
  && /\$\("trHonest"\)\.textContent = st\.honest/.test(app));

/* ── the house rule: a plain control, the number behind it, and a tool ───── */
ok("a plain control: pick a song, name it, press Train",
  /id="trFile"/.test(html) && /id="trName"/.test(html) && /id="trStart"/.test(html));
ok("...the numbers behind it, folded away rather than removed",
  /<details class="adv" id="trNumbers"/.test(html)
  && ["trSeconds", "trSteps", "trRank", "trLr"].every((id) => new RegExp(`id="${id}"`).test(html)));
ok("...and a tool, which says up front that it spends an hour of the card",
  /name: "train_lora"/.test(mcp) && /TAKES THE GRAPHICS CARD FOR AN HOUR/.test(mcp));
ok("...and the tool carries the same two warnings the screen does",
  /CC BY-NC 4\.0/.test(mcp) && /not yet measured/.test(mcp));

/* ── the screen is actually visible, which the rail census also enforces ─── */
ok("the view is registered AND un-hidden — a page nobody can see is not a page",
  /data-view="training"/.test(html) && /<div id="training" hidden>/.test(html)
  && /\$\("training"\)\.hidden = name !== "training"/.test(app));

/* ── the step that turns an hour of electricity into something usable ────── */
ok("the adapter is moved into models/loras, which is the only folder any picker reads",
  /export async function adoptLora/.test(src("./train.js"))
  && /action === "check"/.test(index) && /train\.adoptLora\(name\)/.test(index));
ok("...and it is COPIED, so the run's own artefact stays in the provenance trail",
  /await cp\(/.test(src("./train.js")) && !/await rename\(/.test(src("./train.js")));
ok("...and the list is repainted from that folder, never from the reply that claimed success",
  /action: "list"/.test(app) && /listTrained/.test(index));

/* ── the graph matches the harness, so one failure is one failure ────────── */
{
  const g = train.trainGraph({
    ckpt: "yue2.safetensors", sliceName: "a.wav", codesDir: "C:/codes",
    seconds: 24, steps: 600, rank: 8, learningRate: 0.0002, name: "mine_x",
  });
  eq("the target is the real recording through the model's own VAE",
    g[3].class_type, "VAEEncodeAudio");
  eq("...and the context is that same recording's codes, which is the whole point",
    [g[4].class_type, g[4].inputs.codes_dir], ["AiplayYuE2Continue", "C:/codes"]);
  ok("...and the trainer is fed both", g[5].class_type === "TrainLoraNode"
    && JSON.stringify(g[5].inputs.latents) === JSON.stringify(["3", 0])
    && JSON.stringify(g[5].inputs.positive) === JSON.stringify(["4", 0]));
  const probe = src("../../scripts/yue2_train_probe2.mjs");
  ok("...and the node ids match the probe, so a failure here and there are the same failure",
    /1: \{ class_type: "CheckpointLoaderSimple"/.test(probe) && /3: \{ class_type: "VAEEncodeAudio"/.test(probe));
}

/* ── the derivative without which none of this runs at all ───────────────── */
ok("the rotary derivative ships as a node, because a graph should not have to remember it",
  fs.existsSync(fileURLToPath(new URL("../comfy_nodes/aiplay_rope_autograd.py", import.meta.url))));

console.log(`\n  ${passed} passed, ${failed} failed`);
assert.equal(failed, 0, `${failed} training pins failed`);
