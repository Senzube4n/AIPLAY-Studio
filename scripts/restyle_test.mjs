/**
 * End-to-end test of restyleGraph — a real clip, restyled, driven by a real song.
 *
 *   node scripts/restyle_test.mjs <clipName> <songFile> [startSeconds]
 *
 * The clip is taken from the clip library and staged into ComfyUI's input the
 * same way an enhancement stages one, so this exercises the path the server
 * route will use rather than a convenient shortcut.
 */
import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "../server/config.js";
import { restyleGraph, guideStrengths } from "../server/workflow.js";

import { postJSON } from "./lib/doorpost.mjs";
/* ── THE DOOR ─────────────────────────────────────────────────────────────
 * This harness no longer knows where ComfyUI is, because nothing does: the app
 * binds the engine to an unpublished loopback port chosen fresh at every start.
 * So the graph goes through AIPLAY Studio or it does not run — and if the app
 * is not up, the refusal below IS the enforcement.
 *
 * What that buys is the thing this script never had. Every arm now appears in
 * the ledger as script:restyle_test with its graph stored whole, its resolved
 * prompt, every seed and step count, the size, the model files, the wall time
 * and the digest of everything it wrote — and a FAILED arm is recorded too.
 * On the night this door was built, 424 files in the output folder had none of
 * that. See docs/ENGINE_DOOR.md.
 */
const APP = process.env.AIPLAY_URL || "http://127.0.0.1:4173";
async function door(body) {
  let r;
  try {
    r = await postJSON(`${APP}/api/engine`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-aiplay-actor": "script:restyle_test" },
      body: JSON.stringify({ action: "prompt", wait: true, adopt: false, pollMs: 2000, ...body }),
    });
  } catch (e) {
    /* THIS REFUSAL *IS* THE ENFORCEMENT, so it has to be readable. A harness
     * that cannot find the app can no longer find the engine either. */
    throw new Error(`start AIPLAY Studio first — nothing is answering at ${APP} `
      + `(${e.cause?.code || e.message}). Set AIPLAY_URL if the app is on another port.`);
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `AIPLAY Studio answered ${r.status} at ${APP}.`);
  return d;
}
const [, , CLIP = "vmt08sw55.mp4", SONG = null, START = "14"] = process.argv;
const start = Number(START) || 0;

const PROMPT =
  "a woman in a black dress dancing in a dark studio, thick glossy liquid paint "
  + "flowing over her dress and arms, molten magenta cyan and gold enamel "
  + "trailing behind her movement, wet reflections, hard rim light through haze";
/* LTX has real CFG, so the negative is doing actual work. Two jobs: keep the
 * frame wide (the model crops in on a figure given half a chance) and keep her
 * dressed — "coated in paint" reads as body paint on a nude figure otherwise,
 * which is not what a music tool should be publishing. */
const NEGATIVE =
  "nude, naked, topless, bare chest, lingerie, close-up, cropped, empty stage, distant figure, "
  + "illustration, cartoon, text, watermark, "
  + config.video.engines.ltx.negative;

async function beatsFor(song) {
  if (!song) return null;
  const out = await new Promise((res) => {
    const p = spawn(config.python, [path.join(process.cwd(), "scripts", "beats.py"),
                                    path.join(config.outputDir, song)]);
    let s = "", e = "";
    p.stdout.on("data", (d) => (s += d));
    p.stderr.on("data", (d) => (e += d));
    p.on("exit", () => res(s || e));
    p.on("error", () => res(""));
  });
  try { const d = JSON.parse(out); return d.error ? null : d; } catch { return null; }
}

// Stage the clip where LoadVideo can see it.
const src = path.join(config.outputDir, "clips", CLIP);
const staged = `aiplay_restyle_${CLIP}`;
await mkdir(config.inputDir, { recursive: true });
await copyFile(src, path.join(config.inputDir, staged));

const beats = await beatsFor(SONG);
const EVERY = 16;
const probe = restyleGraph({ file: staged, prompt: PROMPT, guideEvery: EVERY, seed: 1 });
const strengths = beats
  ? guideStrengths(beats, probe.guides, { start, every: EVERY, fps: probe.fps })
  : null;

/* Texture guides ON THE BEAT.
 *
 * Yvann injects their reference images at `peaks_index` through SparseCtrl;
 * this is the same idea with LTXVAddGuide, which takes any image. The beat grid
 * we already measure is a better index than a peak-picker's output, because it
 * is a grid rather than whatever crossed a threshold. */
const TEXTURE = process.env.AIPLAY_TEXTURE || null;
let texturePositions = null;
if (TEXTURE && beats?.beats?.length) {
  const segEnd = start + 121 / (beats.envFps ? 24 : 24);
  texturePositions = beats.beats
    .filter((b) => b >= start && b < start + 121 / 24)
    .map((b) => Math.round((b - start) * 24))
    // Never on frame 0: the opening frame is what the eye reads as "the shot",
    // and replacing it with the texture makes the clip look like it starts on
    // the wrong picture.
    .filter((f) => f > 8 && f < 118);
}

const { graph, guides, length, fps } = restyleGraph({
  file: staged, prompt: PROMPT, negative: NEGATIVE, seed: 909,
  guideEvery: EVERY, strengths, prefix: "restyle/r",
  textureImage: TEXTURE,
  texturePositions,
  textureStrength: Number(process.env.AIPLAY_TEXTURE_STRENGTH) || 0.22,
});
if (TEXTURE) console.log(`  texture ${TEXTURE} at frames ${texturePositions?.join(", ") || "(none)"}`);

console.log(`restyle — ${length} frames at ${fps}fps, ${guides} guides every ${EVERY}`);
console.log(beats
  ? `  driven by ${SONG} from ${start}s — strengths ${strengths.map((x) => x.toFixed(2)).join(" ")}`
  : "  no song — flat guide strength");

const d = await door({ graph, label: `restyle ${length} frames, ${guides} guides` });
if (d.status !== "completed") {
  console.error(`\n${d.status.toUpperCase()}:`, String(d.error || "").slice(0, 1000));
  process.exit(1);
}
// Not outputs[0]: on ComfyUI 0.36 LoadVideo echoes the file it read as a row of type "input".
const o = d.outputs.find((r) => (r.type || "output") === "output");
console.log(`\n  ${d.elapsedSec.toFixed(0)}s -> ${o?.subfolder}/${o?.file}`);
