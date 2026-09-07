/**
 * Export Studio's real graphs as ComfyUI workflows.
 *
 * WHY THIS EXISTS
 * ---------------
 * Studio is a face on ComfyUI. Everything it does, it does by submitting a
 * graph — so the graphs ARE the product, and hiding them would be the one thing
 * that makes this a black box instead of a tool. Exporting them means:
 *
 *   - a user can open the exact pipeline in ComfyUI and see how it works,
 *   - they can modify it, and run their version instead,
 *   - and if Studio ever stops being maintained, nothing is lost.
 *
 * FORMAT. These are API-format graphs, which is what Studio submits and
 * therefore what is known to run. ComfyUI's frontend detects them (`isApiJson`
 * / `loadApiJson` in the 1.49 bundle) and reconstructs a laid-out node graph on
 * load, so there is no need to hand-build the editor format and no risk of
 * emitting a subtly wrong one. The official MiniMax template does use the
 * editor format, but wraps the whole pipeline in a subgraph — which is prettier
 * and considerably less legible than the flat graph you get from these.
 *
 * The values baked in are the MEASURED ones, not ComfyUI's defaults. That is
 * most of what Studio actually knows: shift 5.0 on music, the two separate CFG
 * scales, shift_video 4.0 instead of 12.0, cfg 1 and 4 steps on a distilled
 * image model. Anyone loading these gets the tuning for free.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../server/config.js";
import { buildGraph, coverGraph, videoGraph, coverPrompt } from "../server/workflow.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CAPTION = "warm analog synthwave, driving arpeggio, wide reverb, night drive";
const LYRICS = "[Verse]\nSodium light on the ring road again\n\n[Chorus]\nKeep the engine running\n";

/** Strip the bits that are about THIS machine rather than about the pipeline. */
function portable(graph) {
  const g = structuredClone(graph);
  for (const node of Object.values(g)) {
    // A captured-trajectory path is specific to one library on one disk.
    if (node.inputs?.resume_from === "") delete node.inputs.resume_from;
  }
  return g;
}

const WORKFLOWS = [
  {
    name: "01-music",
    title: "AIPLAY · Music (MiniMax Music 3)",
    graph: () => buildGraph({ caption: CAPTION, lyrics: LYRICS, seed: 42, mixSeed: 42, maxDuration: 180 }),
    about: [
      "The core pipeline: caption + lyrics in, a finished song out.",
      "",
      "TWO GUIDANCE SCALES, NOT ONE. `cfg_scale` on MiniMaxMusic3TextEncode steers",
      "the 8B LLM writing the token trajectory — the COMPOSITION. `cfg` on",
      "SamplerCustom steers flow-matching denoising — the RENDER. Studio sweeps",
      "them independently; a single dial only ever samples the diagonal.",
      "",
      "SEED vs NOISE_SEED are also separate. Hold `seed` and change `noise_seed`",
      "and ComfyUI reuses the cached AR stage, so a re-roll costs about 60% of a",
      "full render and returns the same performance with a different mix.",
      "",
      "ManualSigmas carries a shift-5.0 schedule rather than the node default.",
    ],
  },
  {
    name: "02-music-audio-reference",
    title: "AIPLAY · Music from an audio reference",
    graph: () => buildGraph({
      caption: CAPTION, lyrics: "", seed: 42, mixSeed: 42, maxDuration: 60,
      audioRef: "your-reference.latent", audioRefDenoise: 0.85,
    }),
    about: [
      "Start the render from a real song instead of from silence.",
      "",
      "ComfyUI ships the DAV DECODER only — comfy/sd.py raises \"MiniMax Music3 DAV",
      "cannot encode audio\". But the encoder weights exist (SimpleTuner/",
      "MiniMax-Music-3-Encoder) and that checkpoint's 121 decoder tensors are",
      "BIT-IDENTICAL to ComfyUI's minimax_music3_dav.safetensors, so a latent",
      "encoded outside the process is one this graph already understands.",
      "Measured round trip through stock nodes: +26.26 dB SI-SDR, pearson 0.999.",
      "",
      "TO USE IT: run scripts/dav_encode.py on any audio file. It writes a .latent",
      "into ComfyUI/input, and LoadLatent reads it by name.",
      "",
      "    python scripts/dav_encode.py mysong.mp3 --name your-reference",
      "",
      "THE DIAL is the length of the sigma schedule. Keeping only the tail starts",
      "the flow partway down, so less of the reference is destroyed. Measured at",
      "15 steps / shift 5.0 against a deliberately opposite caption:",
      "",
      "    0.90+   reference ignored (the trim removes under one step)",
      "    0.85    a genuine blend — its shape, your sound. The useful setting.",
      "    0.80    the reference dominates; a variation of the same song",
      "    0.60    effectively a copy",
      "",
      "This graph is trimmed to 0.85. The sigma list below is already shortened —",
      "compare it with 01-music to see exactly what was dropped.",
      "",
      "⚠ WHAT IT IS NOT. The reference steers the RENDER. The COMPOSITION still",
      "comes from the caption through the free-running AR stage, so this gives",
      "\"that song's shape, a new sound\" and NOT \"that song's tune with new words\".",
    ],
  },
  {
    name: "03-cover-art",
    title: "AIPLAY · Cover art (FLUX.2 klein 4B)",
    graph: () => coverGraph({
      prompt: coverPrompt({ caption: CAPTION, title: "Night Drive", seed: 42 }),
      seed: 42,
    }),
    about: [
      "Album art, drawn only while the GPU is otherwise idle.",
      "",
      "DISTILLED MEANS CFG 1 AND 4 STEPS. The distillation IS the removal of",
      "classifier-free guidance — raising cfg above 1 does not sharpen the result,",
      "it breaks it. Flux2Scheduler takes width and height because the schedule",
      "depends on resolution.",
      "",
      "The prompt is built by coverPrompt() in server/workflow.js, which strips",
      "musical notation and section headings out of the caption first. Without",
      "that, \"[Chorus]\" and \"78 BPM\" get drawn as objects in the picture.",
    ],
  },
  {
    name: "04-video-clip",
    title: "AIPLAY · Video clip (MiniMax H3)",
    graph: () => videoGraph({
      prompt: "slow drifting neon cityscape at night, gentle camera push",
      seed: 42, seconds: config.video.seconds, width: config.video.width,
      height: config.video.height, steps: config.video.steps,
    }),
    about: [
      "A short looping clip to sit under a finished song.",
      "",
      "🔴 LICENCE. H3's Community Licence grants rights only inside its Applicable",
      "Territory, which EXCLUDES the European Union, the United Kingdom and South",
      "Korea. This workflow is included so the pipeline is legible; obtaining and",
      "using the weights is between you and MiniMax.",
      "",
      "SHIFT_VIDEO 4.0, NOT THE 12.0 DEFAULT. ModelSamplingAV reduces the video and",
      "audio shifts to one ratio, and the node that sets it appears in NEITHER",
      "official template — so the defaults ship unswept. Measured here across four",
      "seeds, shift 4 beat the default on loop closure 4/4 and on flicker 4/4, at",
      "identical wall-clock. The direction is what four-for-four supports; the",
      "magnitude varied too much to quote.",
      "",
      "⚠ FRAME COUNT must satisfy n mod 17 == 5, or align_frame_count silently",
      "rounds UP and your \"2 second\" clip is longer than you asked for. 2 s at",
      "24 fps = 56 frames, which is 17*3 + 5.",
      "",
      "H3 ALWAYS renders audio — there is no video-only path. Studio discards it,",
      "because the song already exists.",
    ],
  },
];

async function main() {
  const repoDir = path.join(__dirname, "..", "workflows");
  const comfyDir = path.join(config.comfyDir, "user", "default", "workflows", "AIPLAY");
  await mkdir(repoDir, { recursive: true });
  await mkdir(comfyDir, { recursive: true });

  const index = [];
  for (const w of WORKFLOWS) {
    let graph;
    try {
      graph = portable(w.graph());
    } catch (err) {
      console.log(`  ${w.name}: SKIPPED — ${err.message}`);
      continue;
    }
    const json = JSON.stringify(graph, null, 2);
    for (const dir of [repoDir, comfyDir]) {
      await writeFile(path.join(dir, `${w.name}.json`), json);
    }
    index.push({ ...w, nodes: Object.keys(graph).length });
    console.log(`  ${w.name}.json  ${Object.keys(graph).length} nodes`);
  }

  const readme = [
    "# AIPLAY Studio — the actual workflows",
    "",
    "These are not illustrations. They are the graphs Studio submits, exported",
    "straight out of `server/workflow.js`, so what you load here is what the app",
    "runs.",
    "",
    "## Loading them",
    "",
    "Drag a `.json` onto the ComfyUI canvas, or use Workflow → Open. They are in",
    "API format; ComfyUI detects that and lays out the nodes for you.",
    "",
    "They are also copied into `ComfyUI/user/default/workflows/AIPLAY/`, so they",
    "appear in the workflow sidebar without any importing at all.",
    "",
    "## Why the numbers are not ComfyUI's defaults",
    "",
    "Almost everything Studio knows is in these values. They were measured on one",
    "RTX 4080 SUPER, and each one is explained in the file it came from — the",
    "reasoning lives next to the setting rather than in a changelog.",
    "",
    ...index.flatMap((w) => [
      `## ${w.title}`,
      "",
      `\`${w.name}.json\` · ${w.nodes} nodes`,
      "",
      ...w.about,
      "",
    ]),
    "## A caveat worth stating",
    "",
    "Studio does not host or redistribute any weights. Every model is downloaded",
    "from its publisher, and its licence is between you and them. Two of the four",
    "pipelines here use Apache-2.0 or MIT models; the video one does not, and says",
    "so where you choose.",
    "",
  ].join("\n");
  for (const dir of [repoDir, comfyDir]) {
    await writeFile(path.join(dir, "README.md"), readme);
  }

  console.log(`\nwrote ${index.length} workflows + README to:`);
  console.log(`  ${repoDir}`);
  console.log(`  ${comfyDir}   (shows up in ComfyUI's sidebar)`);
}

main();
