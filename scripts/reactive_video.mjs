/**
 * Audio-reactive iterative img2img — the Deforum-lineage feedback renderer.
 *
 *   node scripts/reactive_video.mjs --src <dir> --song <file.flac> [options]
 *
 * WHAT THIS IS, AND WHY IT IS NOT A FILTER.
 *
 * Each output frame is generated FROM THE PREVIOUS OUTPUT, not from scratch:
 *
 *     base_N  = blend( zoom(out_{N-1}), src_N, srcWeight )
 *     out_N   = colourMatch( img2img(base_N, denoise_N), anchor )
 *
 * That single line of feedback is the whole trick. The previous output carries
 * the accumulated style forward, so the paint builds up and drifts the way paint
 * does; the source frame is mixed back in every frame, so the dancer's pose and
 * motion keep being re-imposed and never wash away. Neither half works alone —
 * measured on this machine, one img2img pass at denoise 0.75 destroys the figure
 * completely, while 0.50 barely touches it. There is no single denoise that both
 * restyles and preserves. The chain is what makes it possible.
 *
 * WHAT THE MUSIC DRIVES. `denoise_N` and the zoom, from the bass envelope that
 * `beats.py` already measures. Measured on the reference clip this was built to
 * match: how heavily restyled a frame is correlates with the bass at r = +0.378
 * (detrended, against 0.239 for the best time-shifted control) and with onset
 * transients at only +0.126. So it is the CONTINUOUS band envelope that belongs
 * on denoise, not the beat grid. Driving it from peaks gives a flicker; driving
 * it from the envelope gives the slow breathing morph.
 *
 * ⚠ Everything here is core ComfyUI — VAEEncode, SplitSigmasDenoise, ImageBlend,
 * ImageScale/ImageCrop, ColorTransfer. No custom node pack, so no licence
 * question and nothing to install.
 */
import { mkdir, readdir, copyFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "../server/config.js";

const BASE = `http://${config.comfy.host}:${config.comfy.port}`;
const INPUT = config.inputDir;
const OUTPUT = config.outputDir;

/* ── options ──────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

const SRC_DIR = opt("src", "aiplay_src");
const SONG = opt("song", null);
const FPS = Number(opt("fps", 12));
const W = Number(opt("width", 1024));
const H = Number(opt("height", 576));
const STEPS = Number(opt("steps", 12));
const LIMIT = Number(opt("limit", 0));
const RUN = opt("name", "reactive");
/* Where in the SONG the drive is read from. The source frames and the music are
 * independent lengths, and a five-second test clip against a track's quiet intro
 * measures a drive of 0.01 — which looks exactly like a broken envelope. */
const START = Number(opt("start", 0));

/* How hard the source re-asserts itself each frame.
 *
 * The single most important dial, and the one worth understanding before
 * touching anything else. At 0 the source is abandoned after the first frame
 * and the chain free-runs into abstraction within a couple of seconds — which
 * is the classic Deforum look, and NOT this one. At 1 there is no feedback at
 * all and every frame is an independent restyle of the source, which flickers
 * because nothing carries between frames. The dancer surviving inside the paint
 * lives in the middle. */
const SRC_WEIGHT = Number(opt("source", 0.34));

/* Denoise, as a floor plus what the music adds. The floor is what stylises at
 * all; the range is what the bass moves. Measured cliff on this model: below
 * ~0.45 almost nothing happens in one pass, above ~0.7 the figure is gone — but
 * inside a feedback chain the effective strength accumulates, so the usable
 * per-frame band sits lower than a single pass would suggest. */
const D_MIN = Number(opt("denoise-min", 0.42));
const D_RANGE = Number(opt("denoise-range", 0.16));

/* Slow push per frame, plus what the bass adds. Kept tiny: this compounds every
 * frame, so 1.004 is already a visible drift over ten seconds. */
const ZOOM_MIN = Number(opt("zoom-min", 1.0015));
const ZOOM_RANGE = Number(opt("zoom-range", 0.006));

/* Colour matching back to the first styled frame. Feedback chains drift towards
 * whatever the model likes — usually orange — and this is the brake. Not 1.0:
 * some drift IS the effect, and pinning it completely makes every frame the
 * same palette. */
const COLOUR = Number(opt("colour", 0.55));

const PROMPT = opt("prompt",
  "thick glossy liquid enamel paint flowing over the figure, marbled ink in "
  + "water, saturated magenta cyan gold and deep violet, wet reflective surface, "
  + "high contrast fluid art, dramatic light");

/* ── the audio drive ──────────────────────────────────────────────────── */

/** Run beats.py and return its envelopes, or nulls if there is no song. */
async function analyse(song) {
  if (!song) return null;
  const py = config.python;
  const script = path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\//, ""), "beats.py");
  const out = await new Promise((res) => {
    const p = spawn(py, [script, path.join(OUTPUT, song)]);
    let s = "", e = "";
    p.stdout.on("data", (d) => (s += d));
    p.stderr.on("data", (d) => (e += d));
    p.on("exit", () => res(s || e));
    p.on("error", () => res(""));
  });
  try {
    const d = JSON.parse(out);
    return d.error ? null : d;
  } catch { return null; }
}

/**
 * Band level at a time, normalised so the full control range gets used.
 *
 * The envelopes arrive normalised to their own 97th percentile, which leaves a
 * typical passage sitting near the middle and the top of every dial unreachable.
 */
function driver(beats, band = "bass") {
  if (!beats?.bands?.[band]) return () => 0.5;
  const v = beats.bands[band];
  const fps = beats.envFps || 30;
  const sorted = [...v].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.10)];
  const hi = Math.max(lo + 0.05, sorted[Math.floor(sorted.length * 0.92)]);
  return (t) => {
    const i = Math.min(v.length - 1, Math.max(0, Math.round(t * fps)));
    return Math.min(1, Math.max(0, (v[i] - lo) / (hi - lo)));
  };
}

/* ── the graph ────────────────────────────────────────────────────────── */

/**
 * One frame.
 *
 * `prev` null means the very first frame: there is nothing to feed back yet, so
 * it is a plain restyle of the source at a deliberately higher denoise. That
 * frame also becomes the colour anchor for every frame after it.
 */
function frameGraph({ src, prev, anchor, denoise, zoom, seed }) {
  const a = config.art;
  const g = {
    1: { class_type: "UNETLoader", inputs: { unet_name: a.dit, weight_dtype: "default" } },
    2: { class_type: "CLIPLoader", inputs: { clip_name: a.textEncoder, type: "flux2", device: "default" } },
    3: { class_type: "VAELoader", inputs: { vae_name: a.vae } },
    4: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: PROMPT } },
    5: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } },
    6: { class_type: "CFGGuider", inputs: { model: ["1", 0], positive: ["4", 0], negative: ["5", 0], cfg: a.cfg } },
    7: { class_type: "Flux2Scheduler", inputs: { steps: STEPS, width: W, height: H } },
    8: { class_type: "SplitSigmasDenoise", inputs: { sigmas: ["7", 0], denoise } },
    9: { class_type: "KSamplerSelect", inputs: { sampler_name: a.sampler } },
    10: { class_type: "RandomNoise", inputs: { noise_seed: seed } },

    // The source frame, always at working size.
    20: { class_type: "LoadImage", inputs: { image: src } },
    21: { class_type: "ImageScale", inputs: { image: ["20", 0], upscale_method: "lanczos", width: W, height: H, crop: "disabled" } },
  };

  let baseNode;
  if (!prev) {
    baseNode = ["21", 0];
  } else {
    /* Zoom the PREVIOUS frame before mixing. Scale up, then centre-crop back —
     * ComfyUI has no affine node, and a scale-and-crop is exactly a centred
     * zoom, which is the only camera move this needs. */
    const zw = Math.round(W * zoom / 2) * 2;
    const zh = Math.round(H * zoom / 2) * 2;
    g[30] = { class_type: "LoadImage", inputs: { image: prev } };
    g[31] = { class_type: "ImageScale", inputs: { image: ["30", 0], upscale_method: "lanczos", width: zw, height: zh, crop: "disabled" } };
    g[32] = { class_type: "ImageCrop", inputs: { image: ["31", 0], width: W, height: H, x: Math.floor((zw - W) / 2), y: Math.floor((zh - H) / 2) } };
    /* blend_factor is how much of image2 shows, so it IS the source weight. */
    g[33] = { class_type: "ImageBlend", inputs: { image1: ["32", 0], image2: ["21", 0], blend_factor: SRC_WEIGHT, blend_mode: "normal" } };
    baseNode = ["33", 0];
  }

  g[40] = { class_type: "VAEEncode", inputs: { pixels: baseNode, vae: ["3", 0] } };
  g[41] = {
    class_type: "SamplerCustomAdvanced",
    inputs: { noise: ["10", 0], guider: ["6", 0], sampler: ["9", 0], sigmas: ["8", 1], latent_image: ["40", 0] },
  };
  g[42] = { class_type: "VAEDecode", inputs: { samples: ["41", 0], vae: ["3", 0] } };

  let outNode = ["42", 0];
  if (anchor && COLOUR > 0) {
    g[50] = { class_type: "LoadImage", inputs: { image: anchor } };
    g[51] = {
      class_type: "ColorTransfer",
      inputs: {
        image_target: ["42", 0], image_ref: ["50", 0],
        method: "reinhard_lab", source_stats: "per_frame", strength: COLOUR,
      },
    };
    outNode = ["51", 0];
  }
  g[60] = { class_type: "SaveImage", inputs: { images: outNode, filename_prefix: `${RUN}/f` } };
  return g;
}

async function submit(graph) {
  const r = await fetch(`${BASE}/prompt`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph }),
  });
  if (!r.ok) throw new Error((await r.text()).slice(0, 400));
  const { prompt_id } = await r.json();
  for (;;) {
    await new Promise((s) => setTimeout(s, 250));
    const h = await (await fetch(`${BASE}/history/${prompt_id}`)).json();
    const e = h[prompt_id];
    if (!e) continue;
    if (e.status?.status_str === "error") {
      throw new Error(JSON.stringify(e.status.messages || "").slice(0, 500));
    }
    if (e.status?.completed) {
      const outs = Object.values(e.outputs || {}).flatMap((o) => o.images || []);
      if (!outs.length) throw new Error("no image returned");
      return outs[0];
    }
  }
}

/* ── the run ──────────────────────────────────────────────────────────── */

const srcAbs = path.join(INPUT, SRC_DIR);
if (!existsSync(srcAbs)) {
  console.error(`no source frames at ${srcAbs} — extract them there first`);
  process.exit(1);
}
let frames = (await readdir(srcAbs)).filter((f) => /\.(png|jpg|jpeg)$/i.test(f)).sort();
if (LIMIT) frames = frames.slice(0, LIMIT);
if (!frames.length) { console.error("no frames found"); process.exit(1); }

const beats = await analyse(SONG);
const level = driver(beats, "bass");
console.log(`reactive render — ${frames.length} frames at ${FPS}fps, ${W}x${H}, ${STEPS} steps`);
console.log(`  source weight ${SRC_WEIGHT}  denoise ${D_MIN}..${(D_MIN + D_RANGE).toFixed(2)}  colour ${COLOUR}`);
console.log(beats
  ? `  driven by ${SONG} — ${beats.bpm} BPM, bass envelope at ${beats.envFps}fps`
  : `  no song given — denoise held at the midpoint`);

// A dedicated feedback directory inside ComfyUI's input, because LoadImage only
// reads from there and each frame's output has to become the next one's input.
const FB = "aiplay_fb";
await mkdir(path.join(INPUT, FB), { recursive: true });
await rm(path.join(OUTPUT, RUN), { recursive: true, force: true }).catch(() => {});

let prev = null;
let anchor = null;
const t0 = Date.now();
const log = [];

for (let i = 0; i < frames.length; i++) {
  const t = START + i / FPS;
  const drive = beats ? level(t) : 0.5;
  /* ⚠ The first frame must NOT try to earn the whole style in one pass.
   *
   * It did, at denoise 0.80, and that is exactly the value measured to destroy
   * the figure outright — so the chain began from an abstract blob and every
   * frame after it inherited one. The style is supposed to ACCUMULATE; the
   * opening frame only has to start it. A modest lift over the floor is enough,
   * and the dancer survives to be restyled rather than replaced. */
  const denoise = i === 0
    ? Math.min(0.95, D_MIN + D_RANGE * 0.5)
    : Math.min(0.95, D_MIN + D_RANGE * drive);
  const zoom = ZOOM_MIN + ZOOM_RANGE * drive;

  const out = await submit(frameGraph({
    src: `${SRC_DIR}/${frames[i]}`,
    prev,
    anchor,
    denoise,
    zoom,
    // Fixed seed: the noise is not where variety should come from here, and a
    // rolling seed adds a shimmer that reads as encoding noise.
    seed: 77000,
  }));

  const produced = path.join(OUTPUT, out.subfolder || "", out.filename);
  const fbName = `${FB}/p${String(i % 2)}.png`;             // ping-pong, two files
  await copyFile(produced, path.join(INPUT, fbName));
  prev = fbName;
  if (i === 0) {
    anchor = `${FB}/anchor.png`;
    await copyFile(produced, path.join(INPUT, anchor));
  }

  log.push({ frame: i, t: +t.toFixed(2), drive: +drive.toFixed(3), denoise: +denoise.toFixed(3), zoom: +zoom.toFixed(4) });
  if (i % 10 === 0 || i === frames.length - 1) {
    const per = (Date.now() - t0) / 1000 / (i + 1);
    const left = (frames.length - i - 1) * per;
    process.stdout.write(`  ${i + 1}/${frames.length}  drive ${drive.toFixed(2)}  denoise ${denoise.toFixed(2)}`
      + `  ${per.toFixed(1)}s/frame  ~${Math.round(left)}s left\n`);
  }
}

await writeFile(path.join(OUTPUT, RUN, "drive.json"), JSON.stringify(log, null, 1));
console.log(`\ndone in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min — frames in ${path.join(OUTPUT, RUN)}`);
console.log(`assemble with:\n  ffmpeg -framerate ${FPS} -i "${path.join(OUTPUT, RUN, "f_%05d_.png")}" -c:v libx264 -crf 20 -pix_fmt yuv420p out.mp4`);
