/**
 * DWPose — the two settings that are not preferences, and the shape around them.
 *
 * This suite exists because both of the settings that matter have DEFAULTS THAT
 * ARE WRONG FOR US, and taking a default is invisible in a diff:
 *
 *   bbox_detector defaults to yolox_l.onnx. Loading it pulls in onnxruntime,
 *   and the onnxruntime in this rig's venv is the CPU build the DAW's
 *   basic-pitch transcription depends on. So the wrong default here breaks a
 *   feature in a different half of the app, and nothing about a pose extraction
 *   would tell you why.
 *
 *   resolution defaults to 512. DWPose scales the SHORT side to it and carries
 *   the long side proportionally: 1280x704 at 512 becomes 931x512, 931 is odd,
 *   and libx264 refuses odd widths — so the whole extraction runs and then the
 *   encode dies at the very end.
 *
 * Both are pinned below against the node's OWN declared defaults, so the test
 * fails if the pin is ever quietly removed AND if upstream changes what the
 * default is. The live-engine section, when there is an engine, re-reads those
 * defaults from object_info rather than trusting the copy in this file.
 *
 * WHAT THIS SUITE NOW ALSO PINS. The pose gate, run 2026-09-03: a 121-frame
 * skeleton from this builder steered a VACE render, and DWPose on the OUTPUT
 * put the render's joints 33.7 px from the control's at r 0.893 against a
 * frozen-skeleton null of 119.9 px. POSE_GATE carries that result. The
 * assertions below check the numbers against their own NULLS rather than
 * against themselves — a claim that cannot beat its null is not a claim — and
 * check that every caveat is still carried, because the caveats are the half a
 * surface will be tempted to drop.
 *
 * Runs standalone (`node server/control/pose_test.js`) and in the hook.
 */
import fs from "node:fs";
import {
  poseGraph, poseResolution, poseHash, DWPOSE_MODELS, DWPOSE_NODE_DEFAULTS,
  POSE_GATE,
} from "./pose.js";
import { CONTROL_SPEC } from "./control.js";
import { askObjectInfo, comboOptions, graphProblemsAgainst } from "./live_test_lib.js";
/* The catalogue, for the licence section near the end — which is new, and which
 * exists because this suite had no licence assertion at all until 2026-09-03. */
import { CATALOG } from "../models.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

console.log("\nDWPose — the skeleton that will steer a render\n");

const G = poseGraph({ source: "measure_s01.mp4" });

/* ── the two settings ────────────────────────────────────────────────────── */
ok("bbox_detector is the TorchScript file",
  G["23"].inputs.bbox_detector === "yolox_l.torchscript.pt", G["23"].inputs.bbox_detector);
ok("...which is NOT the node's default — this is an override, not a coincidence",
  DWPOSE_MODELS.bbox_detector !== DWPOSE_NODE_DEFAULTS.bbox_detector
  && DWPOSE_NODE_DEFAULTS.bbox_detector === "yolox_l.onnx");
ok("no .onnx file is named anywhere in the graph — the CPU onnxruntime stays for basic-pitch",
  !JSON.stringify(G).includes(".onnx"), JSON.stringify(G["23"].inputs));
ok("pose_estimator is the TorchScript file, written out rather than defaulted to",
  G["23"].inputs.pose_estimator === "dw-ll_ucoco_384_bs5.torchscript.pt"
  && "pose_estimator" in G["23"].inputs);

ok("resolution is the source's short side, 704 — not the node's 512 default",
  G["23"].inputs.resolution === 704 && DWPOSE_NODE_DEFAULTS.resolution === 512);

/* ── the resolution rule, in general ─────────────────────────────────────── */
ok("the short side is taken whichever way round the frame is",
  poseResolution(1280, 704).resolution === 704 && poseResolution(704, 1280).resolution === 704);
ok("a square source resolves to its own side", poseResolution(1024, 1024).resolution === 1024);
{
  const r = poseResolution(1281, 704);
  ok("an odd dimension is refused, naming libx264 and the stage it would die at",
    r.ok === false && /libx264/.test(r.why) && /encode/.test(r.why), r.why);
}
ok("a nonsense size is refused rather than producing NaN",
  poseResolution(0, 704).ok === false && poseResolution("x", "y").ok === false);
{
  let threw = "";
  try { poseGraph({ source: "s.mp4", width: 1281, height: 705 }); } catch (e) { threw = e.message; }
  ok("the builder refuses an odd source too — the rule is enforced, not merely available",
    /libx264/.test(threw), threw);
}

/* ── the graph shape ─────────────────────────────────────────────────────── */
ok("the chain is LoadVideo -> GetVideoComponents -> ImageFromBatch -> DWPreprocessor -> CreateVideo -> SaveVideo",
  G["20"].class_type === "LoadVideo"
  && G["21"].class_type === "GetVideoComponents" && G["21"].inputs.video[0] === "20"
  && G["22"].class_type === "ImageFromBatch" && G["22"].inputs.image[0] === "21"
  && G["23"].class_type === "DWPreprocessor" && G["23"].inputs.image[0] === "22"
  && G["24"].class_type === "CreateVideo" && G["24"].inputs.images[0] === "23"
  && G["25"].class_type === "SaveVideo" && G["25"].inputs.video[0] === "24");
ok("DWPreprocessor's IMAGE output (slot 0) is what feeds the video, not the keypoints (slot 1)",
  G["24"].inputs.images[1] === 0);
ok("frames 0..120 by default — the control floor, from CONTROL_SPEC rather than a literal",
  G["22"].inputs.batch_index === 0 && G["22"].inputs.length === CONTROL_SPEC.minFrames
  && CONTROL_SPEC.minFrames === 121);
ok("the output is written at 24 fps, because it is itself a control clip",
  G["24"].inputs.fps === CONTROL_SPEC.fps && G["24"].inputs.fps === 24);
ok("no scaling node anywhere — the skeleton comes out the size the source went in",
  !Object.values(G).some((n) => /ImageScale|ImageResize|Upscale|ImageCrop/i.test(n.class_type)));
ok("the pixel-chain node ids are the SAME three the VACE graph uses, so the two read alike",
  G["20"].class_type === "LoadVideo" && G["21"].class_type === "GetVideoComponents"
  && G["22"].class_type === "ImageFromBatch");

/* ── the pose gate, 2026-09-03 ───────────────────────────────────────────────
 *
 * These do not re-measure anything — one render costs 34 minutes. They pin the
 * SHAPE of the result so it cannot be edited into something stronger than it
 * was: the score must still beat both of its own nulls, the unscored frames
 * must still be counted, and the caveats must still be there.
 */
{
  const g = POSE_GATE;
  ok("the pose gate ran at the operating point the camera gate passed at",
    g.strength === 1.0 && g.masks === "ones"
    && g.size.width === 1280 && g.size.height === 704 && g.size.frames === 121);
  ok("the render followed the skeleton: 33.7 px, comfortably inside the frozen-skeleton null",
    g.mje_px < g.null_static.mje_px * 0.5, `${g.mje_px} vs ${g.null_static.mje_px}`);
  ok("...and inside the time-reversed null, which is the timing test",
    g.mje_px < g.null_reversed.mje_px * 0.35, `${g.mje_px} vs ${g.null_reversed.mje_px}`);
  ok("the joints moved together, not merely sat together — r 0.893 against a reversed null of ~0",
    g.r_mean > 0.8 && Math.abs(g.null_reversed.r_mean) < 0.1);
  ok("the static null has NO correlation, and says so rather than reporting 0",
    g.null_static.r_mean === null);
  ok("the frames DWPose could not see are counted, not quietly dropped",
    g.frames_scored < g.frames && g.frames - g.frames_scored === 43);
  ok("the score is honest about being computed on 78 frames of 121",
    g.frames_scored === 78 && g.joint_pairs === 803);
  ok("the worst joint is named as well as the best — the hands are the weak half",
    g.worst.joint === "l_wrist" && g.worst.mje_px > g.mje_px * 3
    && g.best.mje_px < g.mje_px);
  ok("identity was measured against a null too, and cleared it",
    g.identity_z > 2 && g.identity_delta > 0);
  ok("every caveat is still carried — four of them, and they are the half a card will drop",
    Array.isArray(g.caveats) && g.caveats.length === 4
    && g.caveats.every((c) => typeof c === "string" && c.length > 80));
  ok("the caveats still say the two things that limit this gate: the instrument and the source",
    /DWPOSE CANNOT SEE THIS RENDER/.test(g.caveats[0])
    && /NOT A DANCE/.test(g.caveats[1]));
  ok("the gate names the exact files, so someone else can re-measure it",
    g.render.endsWith(".mp4") && g.skeleton.endsWith(".mp4") && g.reference.endsWith(".png")
    && Number.isInteger(g.seed));
}

/* ── the save prefix ─────────────────────────────────────────────────────── */
ok("the prefix is control/pose_<hash>",
  /^control\/pose_[0-9a-f]{12}$/.test(G["25"].inputs.filename_prefix), G["25"].inputs.filename_prefix);
ok("the hash is stable — the same ask writes the same name, so a re-ask is a cache hit",
  poseGraph({ source: "a.mp4" })["25"].inputs.filename_prefix
  === poseGraph({ source: "a.mp4" })["25"].inputs.filename_prefix);
ok("...and it moves when the source, the frame count or the resolution moves",
  new Set([
    poseHash({ source: "a.mp4", frames: 121, resolution: 704 }),
    poseHash({ source: "b.mp4", frames: 121, resolution: 704 }),
    poseHash({ source: "a.mp4", frames: 144, resolution: 704 }),
    poseHash({ source: "a.mp4", frames: 121, resolution: 512 }),
  ]).size === 4);
ok("an explicit prefix wins",
  poseGraph({ source: "a.mp4", prefix: "control/mine" })["25"].inputs.filename_prefix === "control/mine");

/* ── detection toggles ───────────────────────────────────────────────────── */
{
  const all = poseGraph({ source: "a.mp4" })["23"].inputs;
  ok("hands, body and face are all on by default — they cost the same pass",
    all.detect_hand === "enable" && all.detect_body === "enable" && all.detect_face === "enable");
  const body = poseGraph({ source: "a.mp4", detect: { hand: false, body: true, face: false } })["23"].inputs;
  ok("...and each maps to the node's enable/disable strings, not to booleans",
    body.detect_hand === "disable" && body.detect_body === "enable" && body.detect_face === "disable");
  ok("scale_stick_for_xinsr_cn stays disabled — that is a different ControlNet's convention",
    all.scale_stick_for_xinsr_cn === "disable");
}

/* ── the refusals ────────────────────────────────────────────────────────── */
{
  const threw = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };
  ok("no source is refused, and the message says FILENAME, not path",
    /COMBO over that directory/.test(threw(() => poseGraph({}))));
  ok("a frame count below the control floor is refused BEFORE the GPU is asked",
    /below the control floor of 121/.test(threw(() => poseGraph({ source: "a.mp4", frames: 96 }))));
  ok("...and the refusal says what would silently happen instead",
    /clamps/.test(threw(() => poseGraph({ source: "a.mp4", frames: 96 })))
    && /mid-gray/.test(threw(() => poseGraph({ source: "a.mp4", frames: 96 }))));
  ok("a fractional frame count is refused rather than floored",
    /not a positive whole number/.test(threw(() => poseGraph({ source: "a.mp4", frames: 121.5 }))));
  ok("144 frames is allowed — the floor is a floor",
    poseGraph({ source: "a.mp4", frames: 144 })["22"].inputs.length === 144);
}

/* ── extractPose is GONE, and this is where it was tested ──────────────
 *
 * Two assertions stood here: that a bad source was reported rather than thrown,
 * and that an engine which is not there is reported rather than thrown. They
 * went with the function. `extractPose` was the one thing in this directory
 * that talked to a machine, and it did so through control.js's temporary engine
 * client — a second `/prompt` poster with a base that resolved to 8266.
 *
 * Both refusals still exist, one layer up and stronger: server/mv/routes.js's
 * `control_render` case runs validateControlClip() BEFORE it stages anything,
 * returns the `why` verbatim, and posts through engine.dispatch(), whose own
 * refusals ("this Studio's ComfyUI child is not alive") are the honest version
 * of the dead-engine case this used to fake with port 1. server/mv/plan_test.js
 * and the route proof carry those. Nothing is asserted here that no longer has
 * a subject. */
/* ── the smoke that exists on this rig ───────────────────────────────────── */
{
  const smoke = "D:\\AI\\aiplay-studio-bench\\ComfyUI\\output\\pose_smoke_00001_.mp4";
  if (fs.existsSync(smoke)) {
    ok("the 24-frame DWPose smoke is on this disk, so the estimators really load",
      fs.statSync(smoke).size > 10_000, `${fs.statSync(smoke).size} bytes`);
  } else {
    console.log(`  --    the bench rig is not on this machine, so the DWPose smoke at`);
    console.log(`        ${smoke} was not checked.`);
  }
}

/* ── the catalogue entry, and the rights it REFUSES to claim ──────────────
 *
 * THIS SECTION IS NEW, and it is new because there was nothing here before: on
 * 2026-09-03 this suite had 277 lines and not one mention of a licence. The
 * VACE side at least admitted its gap out loud — vace_test.js carried an
 * assertion that models.js contained no WAN entry, written to fail the day
 * somebody added one. The pose side admitted nothing, which is the quieter
 * failure of the two: two model files were being loaded by name, on every
 * extraction, with no catalogue row, no NOTICE line and no test that would ever
 * have noticed.
 *
 * WHAT IT PINS, and why each half matters as much as the other:
 *
 *   THE ENTRY EXISTS, and its files are the two this builder names. A model
 *   loaded by a filename that appears in no catalogue is a model whose licence
 *   does not travel with a fork — NOTICE is generated from that catalogue.
 *
 *   THE ENTRY REFUSES TO CLAIM RIGHTS. The pose estimator's redistributor ships
 *   no LICENSE file and a 28-byte model card, and the repository usually named
 *   as its origin is also 28 bytes of frontmatter; the only real Apache-2.0
 *   document in the chain is reached by a filename match. So `unknown` is the
 *   correct answer and this section makes it EXPENSIVE TO REMOVE — an upgrade
 *   to a real class has to bring a verbatim quote and a clause with it, which
 *   is the catalogue's own rule (provenance_test.js) applied at the one row
 *   where somebody would most want to skip it, because the honest answer is
 *   inconvenient and the badge on the model card says apache-2.0.
 */
{
  const cap = CATALOG.find((c) => c.id === "posePreprocess");
  ok("models.js catalogues the DWPose pair", !!cap, "no capability with id posePreprocess");

  const names = (cap?.files || []).map((f) => f.dest.split(/[\\/]/).pop());
  ok("...and its files are the two THIS builder names, not the ONNX defaults",
    !!cap && [DWPOSE_MODELS.bbox_detector, DWPOSE_MODELS.pose_estimator].every((n) => names.includes(n)),
    names.join(", "));
  ok("...so the catalogue cannot drift onto the .onnx builds the node would default to",
    !names.some((n) => n.endsWith(".onnx")), names.join(", "));

  /* The destination is inside the node pack's own ckpts/ tree, which is the
   * only place comfyui_controlnet_aux looks. A row that pointed at models/
   * would report ready while the pack downloaded its own copy anyway. */
  ok("...written where the node pack actually reads from",
    (cap?.files || []).every((f) => /comfyui_controlnet_aux[\\/]ckpts[\\/]/.test(f.dest)),
    (cap?.files || []).map((f) => f.dest).join(" | "));

  const r = cap?.outputRights || {};
  ok("the entry REFUSES to claim rights, because half its chain is unread",
    r.class === "unknown", String(r.class));
  ok("...with sellable exactly null — not false, which would be a verdict",
    r.sellable === null, JSON.stringify(r.sellable));
  ok("...and no quote, because there is no sentence anybody here has read",
    r.quote === "" && r.clause === "", `${JSON.stringify(r.quote)} / ${JSON.stringify(r.clause)}`);
  ok("...but a URL all the same, so a person can go and read the chain themselves",
    typeof r.url === "string" && /^https?:\/\//.test(r.url), String(r.url));

  /* The asymmetry is the finding, and losing it would turn a precise answer
   * into a shrug: the DETECTOR was verified against canonical Apache-2.0 and
   * the ESTIMATOR is the half with no document. */
  ok("...and the note names which half is verified and which is not",
    /yolox_l\.torchscript\.pt/.test(String(r.note))
    && /dw-ll_ucoco_384_bs5\.torchscript\.pt/.test(String(r.note))
    && /28 bytes/.test(String(r.note)),
    String(r.note).slice(0, 120));

  /* The measured cost is a number two files now state. They must not drift:
   * models.js quotes it to a reader deciding whether to download, POSE_GATE is
   * where it was measured. */
  ok("the catalogue's extraction time is the one the gate measured",
    new RegExp(`${POSE_GATE.extraction_seconds}\\s*s`).test(String(cap?.note))
    && new RegExp(`${POSE_GATE.extraction_seconds}\\s*s`).test(String(cap?.requires?.note)),
    `POSE_GATE says ${POSE_GATE.extraction_seconds}s`);

  /* The node pack is a CODE dependency and deliberately not a catalogue row —
   * models.js has no concept of one, and a row would put it through
   * MODEL_TO_CAPABILITY and fit.js pricing. It is named in the note and in
   * NOTICE instead, and this checks the note has not lost it. */
  ok("...and the node pack it needs is named, with its licence",
    /comfyui_controlnet_aux/.test(String(cap?.note)) && /Apache-2\.0/.test(String(cap?.note)),
    String(cap?.note).slice(0, 120));
}

/* ── against the live engine, ASKED THROUGH THE DOOR ──────────────────
 *
 * This block used to build a URL from `engineBase()` and fetch the engine's own
 * route. It had stopped running: after the engine door landed there is no
 * published engine base, so it took its skip branch every time and printed the
 * word `null` where a URL used to be. It now asks the APPLICATION the same
 * question, which works exactly when the app is up, needs no address at all, and
 * is attributed like every other request through that door. live_test_lib.js. */
{
  const { nodes, why } = await askObjectInfo("pose_test");
  if (!nodes) {
    console.log(`\n  --    ${why}\n`);
  } else {
    ok("comfyui_controlnet_aux is installed and DWPreprocessor is live",
      !!nodes.DWPreprocessor, Object.keys(nodes).filter((k) => /DWPose|DWPre/i.test(k)).join(","));
    const opt = nodes.DWPreprocessor?.input?.optional || {};
    /* Re-read the defaults from the node rather than trusting this file's copy:
     * if upstream ever makes TorchScript the default, this pin should be
     * updated deliberately rather than discovered later. */
    ok("the node's bbox_detector default really is the ONNX file we are overriding",
      opt.bbox_detector?.[1]?.default === DWPOSE_NODE_DEFAULTS.bbox_detector,
      JSON.stringify(opt.bbox_detector?.[1]));
    ok("the node's resolution default really is 512, the one that yields an odd 931",
      opt.resolution?.[1]?.default === DWPOSE_NODE_DEFAULTS.resolution);
    ok("both files we name are options the engine offers",
      (opt.bbox_detector?.[0] || []).includes(DWPOSE_MODELS.bbox_detector)
      && (opt.pose_estimator?.[0] || []).includes(DWPOSE_MODELS.pose_estimator));

    /* LoadVideo.file is a COMBO over the engine's input directory. Use a name
     * that is really there, so this checks the graph and not the fixture. */
    const inputClips = comboOptions(nodes.LoadVideo?.input?.required?.file) || [];
    const real = inputClips.find((f) => /\.mp4$/i.test(f)) || "gate_block.mp4";
    const problems = graphProblemsAgainst(nodes, poseGraph({ source: real }));
    ok("every class, every required input and every combo value exists on the LIVE engine",
      problems.length === 0, problems.join("\n          "));
  }
}
console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
