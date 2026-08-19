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
/* Zoom compounds every frame, but the prototype's 1.0075 peak was invisible.
 * A ~1.03 peak gives roughly 22px of edge displacement after the chain's own
 * memory — a push you can actually see land on the kick. */
const ZOOM_MIN_X = Number(opt("zoom-base", 0.002));
const ZOOM_PULSE = Number(opt("zoom-pulse", 0.028));

/* Colour matching back to the first styled frame. Feedback chains drift towards
 * whatever the model likes — usually orange — and this is the brake. Not 1.0:
 * some drift IS the effect, and pinning it completely makes every frame the
 * same palette. */
const COLOUR = Number(opt("colour", 0.55));

/* Where the transformation STARTS and where it ENDS.
 *
 * A feedback chain with a single fixed prompt does not hold still — it drifts
 * wherever the model's prior leads, and on this model that measured out as
 * graphic illustration with invented floating objects. Two prompts turn the
 * drift into a journey with a destination. */
const STYLE_A = opt("style-a",
  "photograph of a woman dancing in a dark studio, hard rim light through haze, "
  + "wet glossy paint beginning to run over her skin and dress, photographic, "
  + "plain dark background");
const STYLE_B = opt("style-b",
  "the dancing figure dissolving into thick flowing liquid paint, molten enamel "
  + "swirls of magenta cyan and gold wrapping around her body, marbled ink, "
  + "glossy wet reflections, dark background");

/* The integer band the step count moves within.
 *
 * ⚠ THE MOST IMPORTANT NUMBERS IN THIS FILE. `SplitSigmasDenoise` computes
 * `round(steps * denoise)`, so denoise is QUANTISED to 1/steps — it is not a
 * continuous dial. The first four test renders asked for denoise ranges of
 * 0.16-0.22 at 12 steps, which spans under two integers: every one of them came
 * out a two-level square wave, and one was effectively constant for 29 of its 30
 * frames. The bass envelope was being computed correctly and then thrown away by
 * rounding.
 *
 * So the step COUNT is what gets driven, and denoise is back-solved from it —
 * `round(STEPS * (n / STEPS)) === n` exactly, so the bucket asked for is the
 * bucket that runs. */
const S_MIN = Number(opt("steps-min", 6));
const S_RANGE = Number(opt("steps-range", 4));

// Small per-frame corrections against what a long chain costs. See the graph.
const SHARPEN = Number(opt("sharpen", 0.015));
const GRAIN = Number(opt("grain", 0.02));

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
function driver(beats, band, startT, durT, fps) {
  if (!beats?.bands?.[band]) return { drive: () => 0.5, pulse: () => 0 };
  const v = beats.bands[band];
  const efps = beats.envFps || 30;

  /* ⚠ Percentiles over the RENDERED WINDOW, not the whole song.
   *
   * Normalising against the entire track and then reading three seconds out of
   * it is why the first tests looked dead: a quiet intro measured a drive of
   * 0.03 for every frame, and a loud section measured 0.9 for every frame. The
   * dial never moved because its INPUT never moved. The window is what the
   * viewer hears, so the window is what the range should describe. */
  const i0 = Math.max(0, Math.round(startT * efps));
  const i1 = Math.min(v.length, Math.round((startT + durT) * efps));
  const win = v.slice(i0, Math.max(i0 + 2, i1)).sort((a, b) => a - b);
  const lo = win[Math.floor(win.length * 0.10)];
  const hi = Math.max(lo + 0.05, win[Math.floor(win.length * 0.92)]);

  /* One-pole EMA. The step count is quantised, so a twitchy driver makes it
   * chatter between two integers — which reads as flicker rather than rhythm.
   * Denoise wants the slow signal; the sharp attack goes on zoom instead. */
  let ema = null;
  const A = 0.35;
  const drive = (t) => {
    const raw = Math.min(1, Math.max(0, (v[Math.min(v.length - 1, Math.max(0, Math.round(t * efps)))] - lo) / (hi - lo)));
    ema = ema === null ? raw : A * raw + (1 - A) * ema;
    return ema;
  };

  /* The beat as an impulse with exponential decay. Zoom is continuous and
   * compounds, so unlike denoise it can carry a sharp attack — and a push on
   * the kick is the one thing every Deforum practitioner agrees on. */
  const bts = beats.beats || [];
  const bars = beats.bars || [];
  const TAU = Math.min(0.14, 0.25 * 60 / (beats.bpm || 120));
  const pulse = (t) => {
    let best = 0;
    for (const b of bts) {
      if (b > t) break;
      const x = Math.exp(-(t - b) / TAU);
      if (x > best) best = x;
    }
    // A bar line hits harder than a beat inside the bar.
    if (bars.some((x) => Math.abs(x - t) < 1 / fps)) best = Math.min(1, best * 1.6);
    return best;
  };
  return { drive, pulse };
}

/* ── the graph ────────────────────────────────────────────────────────── */

/**
 * One frame.
 *
 * `prev` null means the very first frame: there is nothing to feed back yet, so
 * it is a plain restyle of the source at a deliberately higher denoise. That
 * frame also becomes the colour anchor for every frame after it.
 */
function frameGraph({ src, prev, anchor, denoise, zoom, mix, seed }) {
  const a = config.art;
  const g = {
    1: { class_type: "UNETLoader", inputs: { unet_name: a.dit, weight_dtype: "default" } },
    2: { class_type: "CLIPLoader", inputs: { clip_name: a.textEncoder, type: "flux2", device: "default" } },
    3: { class_type: "VAELoader", inputs: { vae_name: a.vae } },
    /* TWO style prompts, blended by `mix`.
     *
     * The drift this fixes is real and was the prototype's worst failure: with
     * one fixed prompt the chain wanders wherever the model's prior pulls it —
     * measured, towards graphic illustration with invented floating objects.
     * Giving the transformation a DESTINATION means the drift has somewhere to
     * go instead of somewhere to escape to. Both encodes are cached by ComfyUI
     * for the whole render; only the cheap average below changes per frame. */
    4: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: STYLE_A } },
    5: { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: STYLE_B } },
    6: {
      class_type: "ConditioningAverage",
      inputs: { conditioning_to: ["5", 0], conditioning_from: ["4", 0], conditioning_to_strength: mix },
    },
    /* ⚠ cfg stays at 1. klein is DISTILLED — raising it does not enable a
     * negative prompt, it just breaks the model. There is no negative here and
     * no amount of wishing produces one. */
    7: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["6", 0] } },
    70: { class_type: "CFGGuider", inputs: { model: ["1", 0], positive: ["6", 0], negative: ["7", 0], cfg: a.cfg } },
    71: { class_type: "Flux2Scheduler", inputs: { steps: STEPS, width: W, height: H } },
    8: { class_type: "SplitSigmasDenoise", inputs: { sigmas: ["71", 0], denoise } },
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

  /* Colour-match BEFORE the encode as well as after it.
   *
   * The anchor is frame 0 and is never updated — Deforum's "Match Frame 0", and
   * freezing it IS the mechanism. Correcting only the output lets the drift into
   * the next frame's input, where it compounds; correcting the input too stops
   * it entering the loop at all.
   *
   * ⚠ `source_stats` is a plain string over the API, not a dict. */
  if (anchor && COLOUR > 0) {
    g[50] = { class_type: "LoadImage", inputs: { image: anchor } };
    g[34] = {
      class_type: "ColorTransfer",
      inputs: {
        image_target: baseNode, image_ref: ["50", 0],
        method: "reinhard_lab", source_stats: "per_frame", strength: COLOUR * 0.6,
      },
    };
    baseNode = ["34", 0];
  }

  /* Two small corrections that only matter because this is a CHAIN.
   *
   * Every pass through the VAE loses a little high frequency, and blending with
   * a warped copy of the previous frame loses more — over a hundred frames that
   * compounds into mush. A touch of sharpening returns roughly what one pass
   * costs. The grain gives the sampler something to work with in flat regions,
   * which is where a feedback chain otherwise invents objects out of nothing;
   * it goes AFTER the colour match so it is not itself colour-corrected. */
  g[35] = { class_type: "ImageSharpen", inputs: { image: baseNode, sharpen_radius: 2, sigma: 1.0, alpha: SHARPEN } };
  g[36] = { class_type: "ImageAddNoise", inputs: { image: ["35", 0], seed, strength: GRAIN } };

  g[40] = { class_type: "VAEEncode", inputs: { pixels: ["36", 0], vae: ["3", 0] } };
  g[41] = {
    class_type: "SamplerCustomAdvanced",
    inputs: { noise: ["10", 0], guider: ["70", 0], sampler: ["9", 0], sigmas: ["8", 1], latent_image: ["40", 0] },
  };
  g[42] = { class_type: "VAEDecode", inputs: { samples: ["41", 0], vae: ["3", 0] } };

  let outNode = ["42", 0];
  if (anchor && COLOUR > 0) {
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
const DUR = frames.length / FPS;
const { drive: driveAt, pulse: pulseAt } = driver(beats, "bass", START, DUR, FPS);

// Bars inside the rendered window — the style ramp steps once per bar, so the
// transformation moves with the music's structure instead of sliding.
const winBars = (beats?.bars || []).filter((b) => b >= START && b <= START + DUR);

for (let i = 0; i < frames.length; i++) {
  const t = START + i / FPS;
  const d = beats ? driveAt(t) : 0.5;
  const p = beats ? pulseAt(t) : 0;

  /* Integer first, denoise second. Never the other way around. */
  const steps_N = i === 0
    ? S_MIN + 1
    : Math.max(1, Math.min(STEPS - 1, Math.round(S_MIN + S_RANGE * (0.70 * d + 0.30 * p))));
  const denoise = steps_N / STEPS;

  const zoom = 1 + ZOOM_MIN_X + ZOOM_PULSE * p;
  const mix = winBars.length > 1
    ? Math.min(1, winBars.filter((b) => b <= t).length / (winBars.length - 1))
    : Math.min(1, i / Math.max(1, frames.length - 1));

  const out = await submit(frameGraph({
    src: `${SRC_DIR}/${frames[i]}`,
    prev, anchor, denoise, zoom, mix,
    // Fixed: the noise is not where variety should come from, and a rolling
    // seed adds a shimmer that reads as encoding noise.
    seed: 77000,
  }));

  const produced = path.join(OUTPUT, out.subfolder || "", out.filename);
  const fbName = `${FB}/p${String(i % 2)}.png`;
  await copyFile(produced, path.join(INPUT, fbName));
  prev = fbName;
  if (i === 0) {
    anchor = `${FB}/anchor.png`;
    await copyFile(produced, path.join(INPUT, anchor));
  }

  log.push({ frame: i, t: +t.toFixed(2), drive: +d.toFixed(3), pulse: +p.toFixed(3),
             steps: steps_N, denoise: +denoise.toFixed(4), zoom: +zoom.toFixed(4), mix: +mix.toFixed(3) });
  if (i % 10 === 0 || i === frames.length - 1) {
    const per = (Date.now() - t0) / 1000 / (i + 1);
    process.stdout.write(`  ${i + 1}/${frames.length}  drive ${d.toFixed(2)} pulse ${p.toFixed(2)}`
      + `  steps ${steps_N}  zoom ${zoom.toFixed(3)}  mix ${mix.toFixed(2)}`
      + `  ${per.toFixed(1)}s/f  ~${Math.round((frames.length - i - 1) * per)}s left
`);
  }
}

// Did the music actually reach the picture? A render whose step count never
// moved is the failure this file was rewritten to make impossible, so it is
// reported rather than left to be discovered in the output.
const used = [...new Set(log.slice(1).map((l) => l.steps))].sort();
console.log(`
  step counts used: ${used.join(", ")}`
  + (used.length < 3 ? "   ⚠ fewer than three — the drive is barely reaching the sampler" : ""));

await writeFile(path.join(OUTPUT, RUN, "drive.json"), JSON.stringify(log, null, 1));
console.log(`\ndone in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min — frames in ${path.join(OUTPUT, RUN)}`);
console.log(`assemble with:\n  ffmpeg -framerate ${FPS} -i "${path.join(OUTPUT, RUN, "f_%05d_.png")}" -c:v libx264 -crf 20 -pix_fmt yuv420p out.mp4`);
