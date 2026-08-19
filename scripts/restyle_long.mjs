/**
 * Restyle a video of any length, in chained segments.
 *
 *   node scripts/restyle_long.mjs --src <clip.mp4> --song <song.flac> [--segments 4]
 *
 * ONE LTX RUN IS 121 FRAMES — five seconds at 24fps. That is a property of the
 * model, not a setting, so anything longer has to be several runs stitched
 * together, and the whole difficulty is making the seam invisible.
 *
 * The join is made with the guide mechanism itself. Segment N+1 gets an extra
 * guide at frame 0 holding the LAST FRAME SEGMENT N PRODUCED — not the last
 * frame of the source — at a deliberately high strength. So each segment starts
 * from where the previous one actually ended, in the style it had actually
 * reached, and the paint carries across the cut instead of resetting.
 *
 * The audio window advances with the segments, so the bass drive follows the
 * song rather than replaying its first five seconds N times.
 *
 * Each segment lands in the clip library as its own clip. That is deliberate:
 * concatenation belongs to the timeline, which is what the timeline is for, and
 * MCP's build_music_video can lay them out. Pass --join to also write a single
 * assembled file for a docs asset — that path uses ffmpeg and is a BUILD step,
 * never something the app itself needs.
 */
import { mkdir, copyFile, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "../server/config.js";
import { restyleGraph, guideStrengths, videoEngine } from "../server/workflow.js";

const BASE = `http://${config.comfy.host}:${config.comfy.port}`;
const CLIP_DIR = path.join(config.outputDir, "clips");
const v = videoEngine("ltx");

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const flag = (n) => argv.includes(`--${n}`);

const SRC = opt("src", null);
const SONG = opt("song", null);
const SEGMENTS = Number(opt("segments", 4));
const EVERY = Number(opt("every", 16));
const START = Number(opt("start", 0));
const SEG_SECONDS = 121 / v.fps;                 // 5.04s — one LTX run
const NAME = opt("name", "long");

const PROMPT = opt("prompt",
  "a woman in a black dress dancing in a dark studio, thick glossy liquid paint "
  + "flowing over her dress and arms, molten magenta cyan and gold enamel trailing "
  + "behind her movement, wet reflections, hard rim light through haze");
const NEGATIVE = opt("negative",
  "nude, naked, topless, bare chest, lingerie, close-up, cropped, empty stage, "
  + "distant figure, illustration, cartoon, text, watermark, " + v.negative);

if (!SRC) { console.error("--src is required"); process.exit(1); }

const ff = (args) => new Promise((res, rej) => {
  const p = spawn("C:/ffmpeg/bin/ffmpeg", ["-v", "error", ...args]);
  let e = "";
  p.stderr.on("data", (d) => (e += d));
  p.on("exit", (c) => (c === 0 ? res() : rej(new Error(e.slice(0, 300)))));
  p.on("error", rej);
});

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

async function submit(graph) {
  const r = await fetch(`${BASE}/prompt`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph }),
  });
  if (!r.ok) throw new Error((await r.text()).slice(0, 400));
  const { prompt_id } = await r.json();
  for (;;) {
    await new Promise((s) => setTimeout(s, 1500));
    const h = await (await fetch(`${BASE}/history/${prompt_id}`)).json();
    const e = h[prompt_id];
    if (!e) continue;
    if (e.status?.status_str === "error") throw new Error(JSON.stringify(e.status.messages || "").slice(0, 500));
    if (e.status?.completed) {
      const o = Object.values(e.outputs || {}).flatMap((x) => x.images || x.videos || [])[0];
      if (!o) throw new Error("no video returned");
      return path.join(config.outputDir, o.subfolder || "", o.filename);
    }
  }
}

/* Add a continuity guide at frame 0, in front of the source guides.
 *
 * restyleGraph builds its own chain starting from node 100; this splices one
 * more in ahead of it by rewiring the first source guide's conditioning inputs
 * to point at ours. Done here rather than inside restyleGraph because it is a
 * property of a SEQUENCE of renders, not of a render. */
function withCarryGuide(built, carryImage, strength) {
  const g = built.graph;
  g[90] = { class_type: "LoadImage", inputs: { image: carryImage } };
  g[91] = { class_type: "ImageScale", inputs: { image: ["90", 0], upscale_method: "lanczos", width: v.width, height: v.height, crop: "disabled" } };
  g[92] = { class_type: "LTXVPreprocess", inputs: { image: ["91", 0], img_compression: 18 } };
  g[93] = {
    class_type: "LTXVAddGuide",
    inputs: { positive: ["8", 0], negative: ["8", 1], vae: ["3", 0], latent: ["9", 0],
              image: ["92", 0], frame_idx: 0, strength },
  };
  // The first source guide now follows ours instead of the raw conditioning.
  const first = g[103];
  first.inputs.positive = ["93", 0];
  first.inputs.negative = ["93", 1];
  first.inputs.latent = ["93", 2];
  return built;
}

const beats = await beatsFor(SONG);
console.log(`restyle_long — ${SEGMENTS} segments of ${SEG_SECONDS.toFixed(2)}s = ${(SEGMENTS * SEG_SECONDS).toFixed(1)}s`);
console.log(beats ? `  driven by ${SONG} — ${beats.bpm} BPM, from ${START}s` : "  no song — flat guide strength");

await mkdir(config.inputDir, { recursive: true });
const produced = [];
let carry = null;

for (let seg = 0; seg < SEGMENTS; seg++) {
  const t0 = Date.now();
  const segStart = START + seg * SEG_SECONDS;

  /* The source window for this segment. The source clip is shorter than the
   * finished video, so it is REUSED — which is honest for a looping dance and
   * is why each segment gets a different audio window and a different seed
   * rather than pretending the motion is new. */
  const staged = `aiplay_long_src.mp4`;
  await copyFile(path.join(CLIP_DIR, SRC), path.join(config.inputDir, staged));

  const probe = restyleGraph({ file: staged, prompt: PROMPT, guideEvery: EVERY, seed: 1 });
  const strengths = beats
    ? guideStrengths(beats, probe.guides, { start: segStart, every: EVERY, fps: v.fps })
    : null;

  let built = restyleGraph({
    file: staged, prompt: PROMPT, negative: NEGATIVE,
    seed: 1000 + seg * 77, guideEvery: EVERY, strengths,
    prefix: `${NAME}/seg`,
  });
  /* 0.62 — deliberately stronger than a source guide. This one is not steering
   * the style, it is holding the seam, and a weak carry makes the paint reset
   * at every join, which is the single most visible way a chained render looks
   * chained. */
  if (carry) built = withCarryGuide(built, carry, 0.62);

  process.stdout.write(`  segment ${seg + 1}/${SEGMENTS} (audio ${segStart.toFixed(1)}s`
    + `${strengths ? `, guides ${strengths[0].toFixed(2)}..${strengths[strengths.length - 1].toFixed(2)}` : ""}) … `);
  const out = await submit(built.graph);
  produced.push(out);
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // The last frame this segment ACTUALLY produced becomes the next one's seam.
  carry = `aiplay_carry_${seg}.png`;
  await ff(["-sseof", "-0.1", "-i", out, "-frames:v", "1", "-update", "1",
            path.join(config.inputDir, carry), "-y"]);
}

console.log(`\n${produced.length} segments in ${path.dirname(produced[0])}`);

if (flag("join")) {
  const listFile = path.join(config.outputDir, `${NAME}_list.txt`);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(listFile, produced.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n"));
  const joined = path.join(CLIP_DIR, `${NAME}_restyled.mp4`);
  await ff(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", joined, "-y"]);
  await unlink(listFile).catch(() => {});
  console.log(`joined -> ${joined}`);
}
