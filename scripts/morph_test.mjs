/**
 * Morph between images on the beat — the thing Yvann's examples actually are.
 *
 *   node scripts/morph_test.mjs <song.flac> [startSeconds] [img1,img2,...]
 *
 * Images are taken from the Images screen by default, staged into ComfyUI's
 * input, and placed at the song's own beat times. No source video: the whole
 * clip is invented between the pictures, which is what makes it a morph rather
 * than a slideshow with crossfades.
 */
import { mkdir, copyFile, readdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "../server/config.js";
import { morphGraph, videoEngine } from "../server/workflow.js";

import { postJSON } from "./lib/doorpost.mjs";
/* ── THE DOOR ─────────────────────────────────────────────────────────────
 * This harness no longer knows where ComfyUI is, because nothing does: the app
 * binds the engine to an unpublished loopback port chosen fresh at every start.
 * So the graph goes through AIPLAY Studio or it does not run — and if the app
 * is not up, the refusal below IS the enforcement.
 *
 * What that buys is the thing this script never had. Every arm now appears in
 * the ledger as script:morph_test with its graph stored whole, its resolved
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
      headers: { "Content-Type": "application/json", "x-aiplay-actor": "script:morph_test" },
      body: JSON.stringify({ action: "prompt", wait: true, adopt: false, pollMs: 1500, ...body }),
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
const v = videoEngine("ltx");
const [, , SONG = null, START = "14", LIST = null] = process.argv;
const start = Number(START) || 0;

const PROMPT = process.env.AIPLAY_PROMPT
  || "thick liquid paint flowing and folding, molten enamel and marbled ink, "
  + "magenta cyan gold and deep violet swirling into each other, glossy wet, "
  + "continuous fluid motion, macro";
const NEGATIVE = "text, watermark, logo, static, still, frozen, " + v.negative;

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

// Stage the pictures where LoadImage can reach them.
const IMG_DIR = path.join(config.outputDir, "images");
let names = LIST ? LIST.split(",") : null;
if (!names) {
  names = (await readdir(IMG_DIR)).filter((f) => /\.png$/i.test(f) && !f.endsWith("_t.png")).slice(0, 4);
}
await mkdir(path.join(config.inputDir, "aiplay_morph"), { recursive: true });
const staged = [];
for (const n of names) {
  await copyFile(path.join(IMG_DIR, n), path.join(config.inputDir, "aiplay_morph", n));
  staged.push(`aiplay_morph/${n}`);
}

const beats = await beatsFor(SONG);
const frames = 121;
/* One picture per BAR, not per beat.
 *
 * At 68.8 BPM a beat is 0.87s and a five-second clip holds six of them — a new
 * reference every six frames is not a morph, it is a flicker book. Bars give it
 * room to actually travel between two pictures. */
const positions = beats
  ? (beats.bars || []).filter((b) => b >= start && b < start + frames / v.fps)
      .map((b) => Math.round((b - start) * v.fps))
  : [30, 60, 90];

const { graph, guides, positions: used } = morphGraph({
  images: staged, positions, prompt: PROMPT, negative: NEGATIVE,
  seed: 31337, guideStrength: 0.55, prefix: "morph/m",
});

console.log(`morph — ${staged.length} images, ${guides} guides at frames ${used.join(", ")}`);
console.log(beats ? `  bars of ${SONG} from ${start}s (${beats.bpm} BPM)` : "  no song — even spacing");

const d = await door({ graph, label: `morph ${staged.length} images, ${guides} guides` });
if (d.status !== "completed") {
  console.error(`\n${d.status.toUpperCase()}:`, String(d.error || "").slice(0, 900));
  process.exit(1);
}
const o = d.outputs[0];
console.log(`\n  ${d.elapsedSec.toFixed(0)}s -> ${o?.subfolder}/${o?.file}`);
