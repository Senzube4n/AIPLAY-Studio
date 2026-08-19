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

const BASE = `http://${config.comfy.host}:${config.comfy.port}`;
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

const { graph, guides, length, fps } = restyleGraph({
  file: staged, prompt: PROMPT, negative: NEGATIVE, seed: 909,
  guideEvery: EVERY, strengths, prefix: "restyle/r",
});

console.log(`restyle — ${length} frames at ${fps}fps, ${guides} guides every ${EVERY}`);
console.log(beats
  ? `  driven by ${SONG} from ${start}s — strengths ${strengths.map((x) => x.toFixed(2)).join(" ")}`
  : "  no song — flat guide strength");

const t0 = Date.now();
const r = await fetch(`${BASE}/prompt`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: graph }),
});
if (!r.ok) { console.error("REJECTED:", (await r.text()).slice(0, 900)); process.exit(1); }
const { prompt_id } = await r.json();

for (;;) {
  await new Promise((s) => setTimeout(s, 2000));
  const h = await (await fetch(`${BASE}/history/${prompt_id}`)).json();
  const e = h[prompt_id];
  if (!e) { process.stdout.write("."); continue; }
  if (e.status?.status_str === "error") {
    console.error("\nFAILED:", JSON.stringify(e.status.messages || "").slice(0, 1000));
    process.exit(1);
  }
  if (e.status?.completed) {
    const o = Object.values(e.outputs || {}).flatMap((x) => x.images || x.videos || [])[0];
    console.log(`\n  ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${o?.subfolder}/${o?.filename}`);
    break;
  }
}
