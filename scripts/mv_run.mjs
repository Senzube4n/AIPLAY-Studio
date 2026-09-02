/* mv_run.mjs — the music video for "Measure Twice".
 *
 *   node scripts/mv_run.mjs            # DRY RUN (default)
 *   node scripts/mv_run.mjs --run
 *
 * TWO DECISIONS HERE CAME OUT OF MEASUREMENT, NOT TASTE.
 *
 * 1. FRAMING, NOT RESOLUTION. docs/RESOLUTION_FOR_FACES.md measured a face at
 *    five sizes: native gives a 58 px face whose mouth is a smear, 1792x1008
 *    gives 84 px and is the knee — but NO size on the ladder reaches the ~96 px
 *    a mouth actually needs. The 1536x864 row settles the argument on its own:
 *    it cost 36% more than native and produced the SMALLEST face of all five,
 *    because the model chose to frame wider. More pixels, smaller face. So every
 *    performance shot below is written chest-up or tighter, and the money is
 *    spent on framing rather than on canvas.
 *
 * 2. LTX, NOT H3. The assumption that only H3 can drive a mouth from a vocal is
 *    wrong: comfy/ldm/lightricks/av_model.py defines audio_to_video_attn in every
 *    block, run_a2v defaults to TRUE, and ComfyUI ships LTXVModalityGuidance
 *    whose own tooltip says "strengthening audio-visual sync (e.g. lip-sync)".
 *    videoGraphLtx already encodes a real vocal through the audio VAE and pins it
 *    with a zero noise mask, so the video stream attends to ground-truth audio on
 *    every step of both passes. At 5.5x H3's speed that turns an eight-hour job
 *    into a forty-minute one.
 *
 * Each clip is handed the SEGMENT OF THE SONG IT COVERS, so the performance the
 * model sees is the performance that will play under it.
 */
import { mkdir, writeFile, readdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../server/config.js";
import { videoGraphLtx, videoReady } from "../server/workflow.js";

const BASE = `http://${config.comfy.host}:${config.comfy.port}`;
const OUT = path.join(config.outputDir, "mv");
const arg = (f) => { const i = process.argv.indexOf(f); return i < 0 ? null : process.argv[i + 1]; };
const RUN = process.argv.includes("--run");
const FORCE = process.argv.includes("--force");

const SONG = arg("--song") || "aiplay_00081.flac";
const SONG_SECONDS = Number(arg("--song-seconds") ?? 94.75);
const CLIP = 5.04;                       // 121 frames at 24 fps
const N = Math.ceil(SONG_SECONDS / CLIP);

const LOOK = "cold blue-green screen light, one warm sodium practical behind, "
  + "haze, anamorphic, shallow depth of field, fine 35mm grain, no text, no watermark";
const NEG = "cartoon, anime, illustration, plastic skin, text, subtitles, watermark, logo, "
  + "oversaturated, warm orange teal grade, distorted face, extra fingers";

/* The room: a control room somebody moved a microphone into. Every object in it
 * measures something, which is the song's subject. */
const ROOM = "a dark control room lined with oscilloscopes, chart recorders and a wall of "
  + "small green screens";

/* 19 shots. The camera vocabulary is the one the VFX plumbing unlocked this
 * session — offset-follow, orbit, push-in with focal animating, handheld, crane,
 * rack focus — applied here through the prompt, since the gate settled that
 * blocking cannot drive the generator on this path. */
const SHOTS = [
  "Medium close-up, chest up, of a male rapper performing directly to camera in " + ROOM + ", slow push in, screen light on his face",
  "Tight close-up on the rapper's face and mouth performing, side-lit by a green monitor, slow drift left",
  "Medium shot, chest up, rapper performing, camera in a slow half orbit around him, screens sliding past behind",
  "Close-up profile of the rapper performing, rack focus from a foreground oscilloscope to his face",
  "Medium close-up, chest up, rapper performing, handheld, subtle sway, warm sodium practical behind his shoulder",
  "Tight close-up on the rapper's face performing to camera, static, the only light a bank of green screens",
  "Medium shot, chest up, slow push in with the lens tightening, rapper performing, haze in the beam",
  "Close-up, rapper performing, camera orbiting slowly to reveal a chart recorder scratching behind him",
  "Medium close-up, chest up, rapper performing, static, condensation on a steel wall behind",
  "Tight close-up on mouth and jaw performing, hard side light, black background",
  "Medium shot, chest up, rapper performing, slow crane rising slightly above eye line",
  "Close-up of the rapper performing, camera holding, a red instrument light pulsing on his cheek",
  "Medium close-up, chest up, rapper performing, handheld with a small counter-move, screens out of focus behind",
  "Tight close-up, rapper performing to camera, slow push in, single overhead sodium lamp",
  "Medium shot, chest up, rapper performing, camera in a slow arc, oscilloscope traces reflected in his eyes",
  "Close-up on the rapper's face performing, static, green screen glow, haze",
  "Medium close-up, chest up, rapper performing, slow pull back revealing more of the instrument wall",
  "Tight close-up on the rapper performing, rack focus from his face to a screen behind him",
  "Wide of the rapper alone in " + ROOM + ", small in frame, every screen lit, slow crane up, the only wide shot in the video",
];

const rendered = async (i) => {
  const tag = String(i).padStart(2, "0");
  try { return (await readdir(OUT)).some((f) => f.startsWith(tag + "_") && f.endsWith(".mp4")); }
  catch { return false; }
};

console.log(`mv_run — ${RUN ? "DISPATCH" : "DRY RUN"}   ${BASE}`);
console.log(`  song ${SONG}  ${SONG_SECONDS}s  ->  ${N} clips of ${CLIP}s`);
console.log(`  ${config.video.engines.ltx.width}x${config.video.engines.ltx.height}  ->  ${OUT}\n`);

const ready = videoReady("ltx");
if (!ready.ready) { console.log(`  WEIGHTS MISSING: ${ready.missing.join(", ")}`); process.exit(1); }

/* LoadAudio reads ComfyUI's input directory and nothing else. */
const srcSong = path.join(config.outputDir, SONG);
const stagedSong = path.join(config.inputDir, SONG);
try { await copyFile(srcSong, stagedSong); console.log(`  staged song -> ${stagedSong}`); }
catch (e) { console.log(`  COULD NOT STAGE SONG: ${e.message}`); process.exit(1); }

const jobs = [];
for (let i = 0; i < Math.min(N, SHOTS.length); i++) {
  const id = i + 1;
  if (!FORCE && await rendered(id)) continue;
  const graph = videoGraphLtx({
    prompt: `${SHOTS[i]}. ${LOOK}`,
    negative: NEG,
    seed: 550000 + id * 6151,
    seconds: CLIP,
    width: config.video.engines.ltx.width,
    height: config.video.engines.ltx.height,
    // the slice of the song this clip sits over — so the mouth the model drives
    // is the mouth that will be heard
    audioTrack: { name: SONG, start: +(i * CLIP).toFixed(3) },
    prefix: `mv/${String(id).padStart(2, "0")}`,
  });
  for (const [nid, n] of Object.entries(graph)) {
    for (const [k, v] of Object.entries(n.inputs || {})) {
      if (Array.isArray(v) && !graph[v[0]]) throw new Error(`clip ${id}: dangling ${nid}.${k} -> ${v[0]}`);
    }
  }
  jobs.push({ id, graph, at: +(i * CLIP).toFixed(2) });
}

console.log(`  built ${jobs.length} clip(s)\n`);
if (!RUN) {
  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, "_graph_sample.json"), JSON.stringify(jobs[0]?.graph ?? {}, null, 1));
  const hasAudio = JSON.stringify(jobs[0]?.graph ?? {}).includes("LoadAudio");
  console.log(`  audio wired into the graph: ${hasAudio}`);
  console.log("  DRY RUN — nothing posted. Add --run to dispatch.");
  process.exit(0);
}

const post = async (p, b) => {
  const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${(await r.text()).slice(0, 240)}`);
  return r.json();
};

let n = 0; const t0 = Date.now();
for (const j of jobs) {
  process.stdout.write(`  clip ${String(j.id).padStart(2, "0")} @${String(j.at).padStart(5)}s `);
  const s = Date.now();
  try {
    const { prompt_id } = await post("/prompt", { prompt: j.graph });
    const deadline = Date.now() + 20 * 60_000;
    let fails = 0;
    for (;;) {
      if (Date.now() > deadline) throw new Error("deadline");
      try {
        const h = await (await fetch(`${BASE}/history/${prompt_id}`, { signal: AbortSignal.timeout(15_000) })).json();
        fails = 0;
        const rec = h[prompt_id];
        if (rec?.status?.status_str === "error") throw new Error("engine error");
        if (rec?.status?.completed) break;
      } catch (e) {
        if (e.message === "engine error") throw e;
        if (++fails > 10) throw new Error("engine unreachable");
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    n++;
    const eta = Math.round((Date.now() - t0) / 1000 / n * (jobs.length - n) / 60);
    console.log(`ok ${Math.round((Date.now() - s) / 1000)}s  (${n}/${jobs.length}, ~${eta} min left)`);
  } catch (e) { console.log(`FAILED — ${e.message}`); }
}
console.log(`\n  ${n}/${jobs.length} rendered in ${Math.round((Date.now() - t0) / 60000)} min -> ${OUT}`);
