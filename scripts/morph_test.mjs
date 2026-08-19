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

const BASE = `http://${config.comfy.host}:${config.comfy.port}`;
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

const t0 = Date.now();
const r = await fetch(`${BASE}/prompt`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: graph }),
});
if (!r.ok) { console.error("REJECTED:", (await r.text()).slice(0, 800)); process.exit(1); }
const { prompt_id } = await r.json();
for (;;) {
  await new Promise((s) => setTimeout(s, 1500));
  const h = await (await fetch(`${BASE}/history/${prompt_id}`)).json();
  const e = h[prompt_id];
  if (!e) { process.stdout.write("."); continue; }
  if (e.status?.status_str === "error") {
    console.error("\nFAILED:", JSON.stringify(e.status.messages || "").slice(0, 900));
    process.exit(1);
  }
  if (e.status?.completed) {
    const o = Object.values(e.outputs || {}).flatMap((x) => x.images || x.videos || [])[0];
    console.log(`\n  ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${o?.subfolder}/${o?.filename}`);
    break;
  }
}
