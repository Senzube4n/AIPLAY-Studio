/**
 * H3 RESOLUTION LADDER — how many face pixels does each size actually buy?
 *
 * THE QUESTION. Rendering at native (1344x768) and upscaling afterwards cannot
 * put detail into a face that was never resolved — a mid-distance head is a few
 * dozen pixels tall and an upscaler invents the rest. So the useful question is
 * not "which size looks best" but where two curves cross: face pixels rise with
 * size, render seconds rise faster, and the answer is the LARGEST size whose
 * total still fits a real music video.
 *
 * The app's size list jumps straight from 1344x768 to 1920x1080 and labels the
 * jump "above native, slow". Everything between has never been measured. This
 * measures it.
 *
 * METHOD, following scripts/h3_shift_resweep.mjs:
 *  1. Build with videoGraphH3 ITSELF. A sweep that hand-copies the graph
 *     measures a program nobody runs — that is how the missing turbo LoRA
 *     survived a whole sweep once already.
 *  2. SHORTEST legal clip. The question is spatial, so 56 frames (2 s at 24 fps,
 *     the smallest n with n mod 17 == 5 at or above 48) answers it. Rendering
 *     5 s at 1080p to learn about face pixels would cost half an hour a row.
 *  3. Everything fixed except size: one prompt, one seed, one reference image.
 *  4. Cold vs warm. Run 1 pays for loading a 20 GB ref2va checkpoint. The last
 *     row repeats the first size at a different SEED — same cost, different
 *     graph so ComfyUI's cache cannot short-circuit it — which separates model
 *     load from render time and gives the face metrics a seed-noise floor.
 *
 * SHOT DESIGN. A mid-distance head, deliberately not a close-up: the owner's
 * case is "small faces a bit further away", and a close-up would resolve at
 * every size and prove nothing. Static camera so nothing is motion-blurred
 * differently between rows, and the subject is rapping so the mouth — what
 * lip-sync has to read — is doing something.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "../server/config.js";
import { videoGraphH3, videoSizeFor, alignFrames } from "../server/workflow.js";

const BASE = `http://${config.comfy.host}:${config.comfy.port}`;
const OUT = path.join(config.outputDir, "ressweep");

/* The requested ladder. videoSizeFor() is asked about every one of them before
 * anything renders — the config carries a scar from a size list that promised a
 * height the engine could not make. */
const LADDER = [
  [1344, 768],   // native
  [1536, 864],
  [1664, 936],
  [1792, 1008],
  [1920, 1088],
];

const REF = "aiplay_frame_f750a9d39e86.png";   // single-subject frontal portrait
const SEED = 424242;
const SECONDS = 2;

const PROMPT =
  "<Picture 1> stands at the far end of a flat concrete rooftop at dusk, city " +
  "skyline behind her, rapping hard into a handheld microphone. Wide static " +
  "locked-off shot from across the roof: she is seen from the knees up and " +
  "fills about two thirds of the frame height, so her head is a small part of " +
  "the picture. 35mm, overcast daylight, no camera movement, no zoom.\n\n" +
  "Audio: a woman rapping.";

const post = (p, b) =>
  fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })
    .then((r) => r.json());

async function run(w, h, seed, tag) {
  const g = videoGraphH3({
    prompt: PROMPT, seed, seconds: SECONDS, width: w, height: h,
    refImages: [REF],
    keepAudio: true,           // H3 renders it regardless; keeping it costs nothing
    prefix: `ressweep/${tag}`,
  });
  const t0 = Date.now();
  const { prompt_id, error } = await post("/prompt", { prompt: g });
  if (error) throw new Error(`${tag}: ${JSON.stringify(error).slice(0, 400)}`);
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const rec = (await (await fetch(`${BASE}/history/${prompt_id}`)).json())[prompt_id];
    if (!rec) continue;
    if (rec.status?.status_str === "error") {
      throw new Error(`${tag} failed: ${JSON.stringify(rec.status.messages).slice(0, 600)}`);
    }
    if (rec.status?.completed) {
      const secs = (Date.now() - t0) / 1000;
      const files = Object.values(rec.outputs ?? {}).flatMap((o) =>
        [...(o.gifs ?? []), ...(o.videos ?? []), ...(o.images ?? [])]
          .map((f) => path.join(f.subfolder || "", f.filename)));
      console.log(`  ${tag}  ${secs.toFixed(0)}s  ${files.join(", ")}`);
      return { tag, requested: `${w}x${h}`, seed, seconds: secs, files };
    }
  }
}

mkdirSync(OUT, { recursive: true });
const v = config.video.engines.h3;
const length = alignFrames(SECONDS, v.fps, "h3");

console.log(`H3 resolution ladder — ${length} frames (${SECONDS}s @ ${v.fps}fps), ` +
            `${v.steps} steps, shift ${v.shiftVideo}, ref ${REF}`);
console.log("size helper check:");
const plan = [];
for (const [w, h] of LADDER) {
  const s = videoSizeFor("h3", w, h);
  // The node builds its latent with width // 16 and height // 16 and decodes
  // back at latent * 16 (comfy_extras/nodes_minimax_h3.py, _empty_av_latent),
  // so anything off the 16px grid comes back SHORTER than asked for. The helper
  // does not model that for h3 — it reports quantised: false.
  const eff = { w: Math.floor(s.width / 16) * 16, h: Math.floor(s.height / 16) * 16 };
  const note = (eff.w !== s.width || eff.h !== s.height)
    ? `  <- engine floors to ${eff.w}x${eff.h}` : "";
  console.log(`  ${w}x${h} -> helper ${s.width}x${s.height} (quantised=${s.quantised})${note}`);
  plan.push({ w: s.width, h: s.height, effW: eff.w, effH: eff.h });
}

const results = [];
const save = () => writeFileSync(path.join(OUT, "ressweep.json"),
  JSON.stringify({ prompt: PROMPT, ref: REF, seed: SEED, seconds: SECONDS, length,
                   steps: v.steps, shiftVideo: v.shiftVideo, dit: v.ditRef,
                   results }, null, 2));

for (const p of plan) {
  const tag = `h3_${p.w}x${p.h}`;
  try { results.push(await run(p.w, p.h, SEED, tag)); }
  catch (e) { console.error(`  ${e.message}`); results.push({ tag, requested: `${p.w}x${p.h}`, error: e.message }); }
  save();
}
// Warm repeat of the first size at a different seed: separates model-load cost
// from render cost, and bounds seed noise on the face metrics.
try { results.push({ ...await run(plan[0].w, plan[0].h, SEED + 1, `h3_${plan[0].w}x${plan[0].h}_warm`), warmRepeat: true }); }
catch (e) { console.error(`  ${e.message}`); }
save();

console.log(`\nwrote ${path.join(OUT, "ressweep.json")}`);
