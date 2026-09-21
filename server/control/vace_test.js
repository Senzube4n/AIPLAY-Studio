/**
 * The VACE graph, against the graph that actually scored 0.924.
 *
 * THE FIXTURE IS THE REAL THING. W1_GRAPH below is
 * D:\AI\aiplay-studio-bench\ComfyUI\output\vace\_graphs\W1_s70117.json, copied
 * field for field — the graph WAN 2.1 VACE rendered from when it carried the
 * Blender-blocked camera move at CMA 0.924, MR 0.82, SSIM_block 0.524. It is
 * embedded rather than read from D: so this suite runs on a machine that has
 * never seen the bench rig, and then, when that file IS on this disk, the last
 * section diffs the fixture against it — so the copy cannot quietly drift from
 * the original it claims to be.
 *
 * WHY A SHAPE DIFF AND NOT A LIST OF ASSERTIONS. "steps is 20", "cfg is 6",
 * "sampler is uni_pc" is a description of the graph written twice, and the
 * second copy is the one that goes stale. A whole-graph diff modulo prompt,
 * seed, control filename and save prefix says the real thing: this builder
 * emits W1, and the only things that may differ are the four that a caller is
 * supposed to choose. If someone adds an ImageScale to the pixel chain, or
 * moves the shift, or wires an explicit ones-mask, this fails with the field
 * name in the message.
 *
 * The last section, when the engine is reachable, checks the built graph
 * against the live node table, asked through the app's own engine door: every
 * class exists, every required input is
 * present, every combo value is one the node offers. It skips loudly when the
 * engine is down — most machines running the hook have no ComfyUI.
 *
 * Runs standalone (`node server/control/vace_test.js`) and in the hook.
 */
import fs from "node:fs";
import {
  vaceGraph, vaceSizeFor, VACE_SIZE, VACE_PRESET, VACE_WEIGHTS,
  VACE_OPERATING_POINT, VACE_STRENGTH_LADDER, VACE_LICENCE, VACE_LICENCE_VERIFIED,
  DEFAULT_NEGATIVE,
} from "./vace.js";
import { askObjectInfo, graphProblemsAgainst } from "./live_test_lib.js";
/* The catalogue itself, not its source text. See the licence section below for
 * why this import replaced a regex over a relative path. */
import { CATALOG } from "../models.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

console.log("\nWAN 2.1 VACE — the graph that carried the camera\n");

/** W1_s70117.json, verbatim. */
const W1_GRAPH = {
  "1": { class_type: "UNETLoader", inputs: { unet_name: "wan2.1_vace_1.3B_fp16.safetensors", weight_dtype: "default" } },
  "2": { class_type: "CLIPLoader", inputs: { clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", type: "wan", device: "default" } },
  "3": { class_type: "VAELoader", inputs: { vae_name: "wan_2.1_vae.safetensors" } },
  "4": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: "A long concrete corridor lit by cold overhead strip lights, a lone figure in a dark coat walking away from camera down the centre, wet floor reflecting the lights, volumetric haze, cinematic, shot on 35mm." } },
  "5": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: "pc game, console game, video game, cartoon, childish, ugly, static camera, still frame, flat gray, untextured, clay render, watermark, text" } },
  "6": { class_type: "ModelSamplingSD3", inputs: { model: ["1", 0], shift: 5 } },
  "7": { class_type: "WanVaceToVideo", inputs: { positive: ["4", 0], negative: ["5", 0], vae: ["3", 0], width: 1280, height: 704, length: 121, batch_size: 1, strength: 1, control_video: ["22", 0] } },
  "8": { class_type: "KSampler", inputs: { model: ["6", 0], positive: ["7", 0], negative: ["7", 1], latent_image: ["7", 2], seed: 70117, steps: 20, cfg: 6, sampler_name: "uni_pc", scheduler: "simple", denoise: 1 } },
  "9": { class_type: "TrimVideoLatent", inputs: { samples: ["8", 0], trim_amount: ["7", 3] } },
  "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["3", 0] } },
  "11": { class_type: "CreateVideo", inputs: { images: ["10", 0], fps: 24 } },
  "12": { class_type: "SaveVideo", inputs: { video: ["11", 0], filename_prefix: "vace/W1/W1_s70117", format: "auto", codec: "auto" } },
  "20": { class_type: "LoadVideo", inputs: { file: "gate_block.mp4" } },
  "21": { class_type: "GetVideoComponents", inputs: { video: ["20", 0] } },
  "22": { class_type: "ImageFromBatch", inputs: { image: ["21", 0], batch_index: 0, length: 121 } },
};

/** The four fields a caller chooses. Everything else must match W1. */
const CHOSEN = new Set(["8.seed", "12.filename_prefix", "20.file", "4.text", "5.text"]);

function diff(a, b) {
  const out = [];
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const id of [...ids].sort((x, y) => Number(x) - Number(y))) {
    if (!a[id]) { out.push(`node ${id} (${b[id].class_type}) is in the built graph and not in W1`); continue; }
    if (!b[id]) { out.push(`node ${id} (${a[id].class_type}) is in W1 and not in the built graph`); continue; }
    if (a[id].class_type !== b[id].class_type) {
      out.push(`node ${id}: W1 is ${a[id].class_type}, built is ${b[id].class_type}`); continue;
    }
    const fields = new Set([...Object.keys(a[id].inputs), ...Object.keys(b[id].inputs)]);
    for (const f of [...fields].sort()) {
      const key = `${id}.${f}`;
      if (CHOSEN.has(key)) continue;
      const av = JSON.stringify(a[id].inputs[f]);
      const bv = JSON.stringify(b[id].inputs[f]);
      if (av !== bv) out.push(`${id} ${a[id].class_type}.${f}: W1 ${av}, built ${bv}`);
    }
  }
  return out;
}

/** A built graph with its tiled decode put back to W1's plain one, so every
 *  other comparison below is still against W1 exactly (vace.js node 10). */
const untile = (g) => (g["10"]?.class_type === "VAEDecodeTiled"
  ? { ...g, 10: { class_type: "VAEDecode", inputs: { samples: g["10"].inputs.samples, vae: g["10"].inputs.vae } } } : g);

/* ── the shape diff ──────────────────────────────────────────────────────── */
{
  const built = vaceGraph({
    control: "gate_block.mp4",
    prompt: "anything",
    seed: 12345,
    prefix: "control/whatever",
  });
  /* THE ONE PERMITTED DIFFERENCE: the decode is tiled (see vace.js node 10).
   * Same inputs from the same nodes, and the graph is otherwise W1 exactly. */
  ok("the decode is W1's, tiled: the same samples and VAE into VAEDecodeTiled",
    built["10"]?.class_type === "VAEDecodeTiled"
      && JSON.stringify(built["10"].inputs.samples) === JSON.stringify(W1_GRAPH["10"].inputs.samples)
      && JSON.stringify(built["10"].inputs.vae) === JSON.stringify(W1_GRAPH["10"].inputs.vae),
    JSON.stringify(built["10"]));
  const d = diff(W1_GRAPH, untile(built));
  ok("the built graph IS W1, modulo prompt, seed, control filename and save prefix",
    d.length === 0, d.join("\n          "));
  ok("...and it is W1's node set exactly — no node added, none dropped",
    JSON.stringify(Object.keys(built).sort()) === JSON.stringify(Object.keys(W1_GRAPH).sort()),
    Object.keys(built).join(","));
}

/* ── control_masks is ABSENT, and that is the finding ────────────────────── */
{
  const built = vaceGraph({ control: "c.mp4", prompt: "p", seed: 1 });
  ok("control_masks is ABSENT — absent IS ones, and ones means generate",
    !("control_masks" in built["7"].inputs), JSON.stringify(built["7"].inputs));
  ok("no EmptyImage and no ImageToMask anywhere — an explicit mask is a different graph",
    !Object.values(built).some((n) => ["EmptyImage", "ImageToMask", "SolidMask"].includes(n.class_type)));
  let threw = "";
  try { vaceGraph({ control: "c.mp4", prompt: "p", seed: 1, masks: "zeros" }); } catch (e) { threw = e.message; }
  ok("an all-zeros mask is refused, naming W9 — the calibrator that reproduces by construction",
    /W9/.test(threw) && /degeneracy calibrator/.test(threw), threw);
}

/* ── no resampling anywhere in the pixel chain ───────────────────────────── */
{
  const built = vaceGraph({ control: "c.mp4", prompt: "p", seed: 1 });
  const classes = Object.values(built).map((n) => n.class_type);
  ok("no ImageScale, no crop, no resize — the control clip reaches the VAE as rendered",
    !classes.some((c) => /ImageScale|ImageCrop|ImageResize|Upscale/i.test(c)), classes.join(","));
  ok("the pixel chain is LoadVideo -> GetVideoComponents -> ImageFromBatch -> control_video",
    built["20"].class_type === "LoadVideo"
    && built["21"].inputs.video[0] === "20"
    && built["22"].inputs.image[0] === "21"
    && built["7"].inputs.control_video[0] === "22");
  ok("ImageFromBatch asks for the same length WanVaceToVideo does — 121, from one number",
    built["22"].inputs.length === built["7"].inputs.length && built["22"].inputs.length === 121);
}

/* ── reference_image: present when given, absent when not ────────────────── */
{
  const without = vaceGraph({ control: "c.mp4", prompt: "p", seed: 1 });
  ok("no reference: reference_image is absent and no LoadImage exists",
    !("reference_image" in without["7"].inputs)
    && !Object.values(without).some((n) => n.class_type === "LoadImage"));

  const with_ = vaceGraph({ control: "c.mp4", prompt: "p", seed: 1, reference: "face.png" });
  ok("a reference wires WanVaceToVideo.reference_image",
    Array.isArray(with_["7"].inputs.reference_image), JSON.stringify(with_["7"].inputs.reference_image));
  ok("...from a LoadImage, because the input's declared type is IMAGE, not VIDEO",
    with_["23"]?.class_type === "LoadImage" && with_["23"].inputs.image === "face.png"
    && with_["7"].inputs.reference_image[0] === "23", JSON.stringify(with_["23"]));
  ok("...and node 23 is the ONLY thing a reference adds — the rest of W1 is untouched",
    diff(W1_GRAPH, untile(Object.fromEntries(Object.entries(with_).filter(([k]) => k !== "23"))))
      .filter((l) => !/reference_image/.test(l)).length === 0,
    diff(W1_GRAPH, untile(Object.fromEntries(Object.entries(with_).filter(([k]) => k !== "23")))).join("; "));
  ok("TrimVideoLatent takes trim_amount from the VACE node either way — a reference cannot forget it",
    JSON.stringify(without["9"].inputs.trim_amount) === JSON.stringify(["7", 3])
    && JSON.stringify(with_["9"].inputs.trim_amount) === JSON.stringify(["7", 3]));
  ok("an empty-string reference is no reference, not a LoadImage of nothing",
    !Object.values(vaceGraph({ control: "c.mp4", prompt: "p", seed: 1, reference: "  " }))
      .some((n) => n.class_type === "LoadImage"));
}

/* ── vaceSizeFor: one size in v1, and it says why ────────────────────────── */
{
  const good = vaceSizeFor(1280, 704, 121);
  ok("1280x704x121 is the one size that passes", good.ok === true && good.why === null);

  const wide = vaceSizeFor(1920, 1080, 121);
  ok("1920x1080 is refused", wide.ok === false);
  ok("...naming the size it got and the size it needs",
    /size is 1920x1080, must be 1280x704/.test(wide.why), wide.why);
  ok("...and giving the reason: nothing has been measured off this operating point",
    /only size WAN 2.1 VACE has been measured at here/.test(wide.why), wide.why);

  const short = vaceSizeFor(1280, 704, 81);
  ok("81 frames is refused with the count named",
    short.ok === false && /frame count is 81, must be 121/.test(short.why), short.why);

  ok("a refused size is refused by the BUILDER too, not merely reported",
    (() => { try { vaceGraph({ control: "c.mp4", prompt: "p", seed: 1, size: { width: 832, height: 480 } }); return false; } catch { return true; } })());
}

/* ── the refusals that stop a silently-wrong render ──────────────────────── */
{
  const threw = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };
  ok("no control clip is refused, and the message says it is a FILENAME, not a path",
    /COMBO over that directory/.test(threw(() => vaceGraph({ prompt: "p", seed: 1 }))));
  ok("an empty prompt is refused — WAN renders a gray field from one and reports success",
    /gray field/.test(threw(() => vaceGraph({ control: "c.mp4", prompt: "  ", seed: 1 }))));
  ok("no seed is refused — this path exists to be reproducible",
    /reproducible/.test(threw(() => vaceGraph({ control: "c.mp4", prompt: "p" }))));
  ok("a strength outside the node's declared 0..1000 is refused",
    /0\.\.1000/.test(threw(() => vaceGraph({ control: "c.mp4", prompt: "p", seed: 1, strength: -1 }))));
}

/* ── the defaults are the measured operating point ───────────────────────── */
{
  const built = vaceGraph({ control: "c.mp4", prompt: "p", seed: 1 });
  ok("the default strength is 1.00 — W1's, the arm that passed",
    built["7"].inputs.strength === 1.0 && VACE_OPERATING_POINT.strength === 1.0);
  ok("the default negative is the one W1 ran with",
    built["5"].inputs.text === DEFAULT_NEGATIVE
    && DEFAULT_NEGATIVE === W1_GRAPH["5"].inputs.text);
  ok("0.50 renders at 0.50 — the ladder is reachable, not decorative",
    vaceGraph({ control: "c.mp4", prompt: "p", seed: 1, strength: 0.5 })["7"].inputs.strength === 0.5);
  ok("the recorded ladder matches the gate: 0.25 fails, 0.50 passes, 1.00 passes, 2.00 fails",
    JSON.stringify(VACE_STRENGTH_LADDER.map((r) => [r.strength, r.pass]))
      === JSON.stringify([[0.25, false], [0.5, true], [1, true], [2, false]]));
  ok("the SSIM the gate measured is BELOW its reconstruction bar — generated, not copied",
    VACE_OPERATING_POINT.SSIM_block < VACE_OPERATING_POINT.ssim_bar
    && VACE_OPERATING_POINT.SSIM_block < VACE_OPERATING_POINT.reconstruction_anchor);
  ok("the preset is the blueprint's non-CausVid branch: shift 5, 20 steps, cfg 6, uni_pc/simple",
    VACE_PRESET.shift === 5 && VACE_PRESET.steps === 20 && VACE_PRESET.cfg === 6
    && VACE_PRESET.sampler === "uni_pc" && VACE_PRESET.scheduler === "simple");
  ok("the weight filenames are the three W1 loaded",
    VACE_WEIGHTS.diffusion_models === W1_GRAPH["1"].inputs.unet_name
    && VACE_WEIGHTS.text_encoders === W1_GRAPH["2"].inputs.clip_name
    && VACE_WEIGHTS.vae === W1_GRAPH["3"].inputs.vae_name);
  ok("VACE_SIZE agrees with the graph it builds", VACE_SIZE.width === built["7"].inputs.width
    && VACE_SIZE.height === built["7"].inputs.height && VACE_SIZE.frames === built["7"].inputs.length);
}

/* ── 0.402 IS A TIME-SHIFT NULL, AND IT WAS CALLED THE WRONG THING ────────
 *
 * This block exists because the code shipped a mislabel, in six places, for a
 * number that is the whole justification for the headline score. vace.js and
 * both READMEs called 0.402 "its own zero-strength null" and one comment went
 * further and named it "arm W0 - the SAME graph at strength 0.00". It is
 * neither.
 *
 * Read out of gate_report.json rather than remembered: `rows[].null` is CMA
 * recomputed with THAT arm's own estimated flow circularly shifted in time,
 * max over 20 fixed-seed shifts of at least 12 frames. W1's is 0.402. The arm
 * that really runs at strength 0.00 is W8 and it scored -0.056; the arm with
 * no control_video wire at all is W0 and it scored -0.019.
 *
 * Why it matters enough to test: "0.924 against a zero-strength null of 0.402"
 * reads as though switching the control off still buys 0.402 of agreement, so
 * the control looks worth 0.52. Switching it off really buys about nothing,
 * and 0.402 is a harder and different bar. The prose is checked as well as the
 * data, because the prose is what a reader acts on. */
{
  /* THE PHRASE MAY ONLY APPEAR IN QUOTATION MARKS, and that is the whole rule.
   * These files have to be able to say what the wording USED to be — deleting
   * the mistake takes the correction with it — so the check is not "the words
   * are absent" but "the words are never this file's own voice". A new author
   * writing `its own zero-strength null of 0.402` unquoted fails here. */
  const SAYS_IT = /zero-strength null/;
  const QUOTED = /"[^"]*zero-strength null[^"]*"/;
  const FILES = {
    "server/control/vace.js": "./vace.js",
    "server/control/README.md": "./README.md",
    "the top-level README.md": "../../README.md",
  };
  const text = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
  ok("the operating point records W1's null AS a time-shift null",
    VACE_OPERATING_POINT.CMA_null === 0.402
    && VACE_OPERATING_POINT.CMA_null_kind === "time-shift"
    && /circularly shifted in time/.test(VACE_OPERATING_POINT.CMA_null_what || ""),
    "a null with no definition beside it is how a null gets relabelled");
  ok("...and the arms that really turn the control off are recorded, with what they scored",
    VACE_OPERATING_POINT.CMA_zero_strength === -0.056
    && VACE_OPERATING_POINT.CMA_zero_strength_arm === "W8"
    && VACE_OPERATING_POINT.CMA_text_only === -0.019
    && VACE_OPERATING_POINT.CMA_text_only_arm === "W0",
    "both are near zero, which is the point: the null that was being quoted is "
    + "nearly eight times either of them");
  ok("...and the strength-zero arm scores far below the null it was confused with",
    VACE_OPERATING_POINT.CMA_zero_strength < VACE_OPERATING_POINT.CMA_null
    && VACE_OPERATING_POINT.CMA_text_only < VACE_OPERATING_POINT.CMA_null);
  for (const [label, rel] of Object.entries(FILES)) {
    const body = text(rel);
    const lines = body.split(/\r?\n/).filter((l) => SAYS_IT.test(l));
    ok(`${label} never calls 0.402 a zero-strength null in its own voice`,
      lines.every((l) => QUOTED.test(l)),
      lines.filter((l) => !QUOTED.test(l)).join(" | "));
    ok(`...and ${label} names the null it really is`,
      /time-shift/.test(body),
      "the correction has to be ON the page a reader lands on, not only in a test");
  }
}

/* ── the licence travels, and is now a grant rather than a pointer ───────── */
/*
 * WHAT THIS SECTION USED TO SAY, and why the change is the point. Until
 * 2026-09-03 it asserted the opposite of everything below: that
 * VACE_LICENCE_VERIFIED was `false`, that the sentence called itself "a pointer,
 * not a settled grant", and — the assertion that pinned the gap — that
 * server/models.js contained no match for /vace/i at all. That last check was
 * written to FAIL the day somebody catalogued the model, so that the flag and
 * the sentence could not be left behind. It has now done its job and is
 * replaced by its own opposite.
 *
 * It is also replaced by a STRONGER check. The old one read models.js as TEXT
 * off a relative path, so it passed vacuously from any other working directory
 * and a regex for "vace" would have been satisfied by a comment. These import
 * the catalogue and interrogate the entry.
 */
{
  const cap = CATALOG.find((c) => c.id === "videoControl");

  ok("the licence line travels with the builder", typeof VACE_LICENCE === "string" && VACE_LICENCE.length > 80);
  ok("...and it now claims a grant, because the text was read",
    VACE_LICENCE_VERIFIED === true && !/pointer, not a settled grant/.test(VACE_LICENCE), VACE_LICENCE);
  ok("...and it still points at the catalogue entry that carries the evidence",
    /server\/models\.js/.test(VACE_LICENCE) && /videoControl/.test(VACE_LICENCE));

  /* THE ENTRY EXISTS. */
  ok("models.js catalogues WAN 2.1 VACE", !!cap, "no capability with id videoControl");
  ok("...and it is the model this builder loads, by name",
    !!cap && cap.files.some((f) => f.dest.endsWith(VACE_WEIGHTS.diffusion_models)),
    cap ? cap.files.map((f) => f.dest.split(/[\\/]/).pop()).join(", ") : "");
  ok("...with the encoder and the VAE the graph loads too, so nothing renders off an uncatalogued file",
    !!cap && [VACE_WEIGHTS.text_encoders, VACE_WEIGHTS.vae]
      .every((n) => cap.files.some((f) => f.dest.endsWith(n))),
    cap ? cap.files.map((f) => f.dest.split(/[\\/]/).pop()).join(", ") : "");

  /* THE RIGHTS ARE VERIFIED, not merely present. `unknown` is a legal answer
   * for a catalogue entry — it is what posePreprocess ships — so "there is an
   * entry" is not the claim this builder needs. The claim is that somebody read
   * the text, and in this catalogue that is spelled: a class that is not
   * unknown, a verbatim quote, a clause naming where it sits, and a URL. */
  const r = cap?.outputRights || {};
  ok("...and its output rights are a verdict, not an admission", r.class === "unrestricted", String(r.class));
  ok("...carrying the publisher's own sentence verbatim, with the clause it sits in",
    typeof r.quote === "string" && r.quote.length > 80 && /Apache-2\.0 §2/.test(String(r.clause)),
    `${String(r.clause)} | ${String(r.quote).slice(0, 60)}`);
  ok("...and a URL to the text, pinned to the revision that was diffed",
    /^https:\/\/huggingface\.co\/Wan-AI\/Wan2\.1-VACE-1\.3B\/blob\/[0-9a-f]{40}\/LICENSE\.txt$/.test(String(r.url)),
    String(r.url));
  ok("...and it says clips are sellable", r.sellable === true, String(r.sellable));

  /* Apache-2.0 has no territorial clause, so this entry must not have grown a
   * `region` — H3 is the only region-locked row and server/territory_test.js
   * depends on every territory-limited row agreeing with the others. */
  ok("...and it is NOT region-locked: nothing in Apache-2.0 limits a territory",
    !cap?.region, JSON.stringify(cap?.region || null));

  /* THE HONEST HALF. The verification found that the files on disk come from
   * Comfy-Org's repackage rather than from the repository whose licence is
   * quoted, and that the DWPose estimator is still unread. A sentence that
   * dropped either would be the drift this whole section exists to prevent. */
  ok("...and the sentence still admits the two things that are NOT settled",
    /Comfy-Org/.test(VACE_LICENCE) && /inference/i.test(VACE_LICENCE) && /posePreprocess/.test(VACE_LICENCE),
    VACE_LICENCE);
}

/* ── the fixture against the real file, when the rig is on this disk ─────── */
{
  const real = "D:\\AI\\aiplay-studio-bench\\ComfyUI\\output\\vace\\_graphs\\W1_s70117.json";
  if (fs.existsSync(real)) {
    const onDisk = JSON.parse(fs.readFileSync(real, "utf8"));
    const d = diff(onDisk, W1_GRAPH).concat(
      /* the four "chosen" fields are excluded above; check them here, because
       * between the fixture and the original they must NOT differ */
      [...CHOSEN].filter((k) => {
        const [id, f] = k.split(".");
        return JSON.stringify(onDisk[id]?.inputs?.[f]) !== JSON.stringify(W1_GRAPH[id]?.inputs?.[f]);
      }).map((k) => `${k} differs between the fixture and the file on disk`));
    ok("the embedded fixture IS W1_s70117.json on this disk, field for field",
      d.length === 0, d.join("\n          "));
  } else {
    console.log(`  --    the bench rig is not on this machine, so the fixture was not`);
    console.log(`        re-checked against ${real}. Everything above still ran.`);
  }
}

/* -- against the live engine, ASKED THROUGH THE DOOR -----------------------
 *
 * This block used to build a URL from `engineBase()` and fetch the engine's own
 * route. It had stopped running: after the engine door landed there is no
 * published engine base, so it skipped every time and printed `null` where a URL
 * used to be. It now asks the APPLICATION the same question -- which works
 * exactly when the app is up, needs no address, and is attributed like every
 * other request through that door. See live_test_lib.js. */
{
  const { nodes, why } = await askObjectInfo("vace_test");
  if (!nodes) {
    console.log(`\n  --    ${why}\n`);
  } else {
    const built = vaceGraph({ control: "gate_block.mp4", prompt: "p", seed: 1, reference: null });
    const problems = graphProblemsAgainst(nodes, built);
    ok("every class, every required input and every combo value exists on the LIVE engine",
      problems.length === 0, problems.join("\n          "));
    /* The three inputs this whole pass turns on, read back from the node
     * itself rather than believed. */
    const vace = nodes.WanVaceToVideo?.input?.optional || {};
    ok("WanVaceToVideo really declares control_video, control_masks and reference_image",
      vace.control_video?.[0] === "IMAGE" && vace.control_masks?.[0] === "MASK"
      && vace.reference_image?.[0] === "IMAGE", JSON.stringify(Object.keys(vace)));
    ok("...and reference_image is an IMAGE, which is why LoadImage feeds it",
      vace.reference_image?.[0] === "IMAGE");
  }
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
