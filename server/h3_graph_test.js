/**
 * H3's graph after the promo post-mortem, 2026-09-12.
 *
 * Three things the promo clips were rendered with, none of them chosen:
 *   - the 4-step fl2v distillation at sigma shift 12, when it was trained at 6
 *     — and the reference path's 4-step v0.1 LoRA at 8 steps, off its design
 *     point, because it was the only ref2v turbo on disk;
 *   - SaveVideo at `codec: "auto"`, which is libx264 CRF 23 = 1.0 Mbit/s for a
 *     1344x768 frame (measured), so the render was sharper than its file;
 *   - the whole song frozen into the AV latent under references that never
 *     sing, on every step of every block.
 *
 * What is pinned here is the graph the engine is actually asked for: which
 * LoRA loads for which step count and path, the shift that LoRA earns, the
 * panel's precedence over the table, the encode inputs in the dotted form
 * ComfyUI's DynamicCombo reads, and that a clip built without a soundtrack
 * carries no freeze and no anchor — which is the assumption the MV gate in
 * server/mv/generate.js rests on. No card, no ComfyUI, milliseconds.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import {
  videoGraphH3, videoGraphLtx, h3TurboLoraFor, h3SigmaShiftFor, h3SamplerFor, saveEncode,
} from "./workflow.js";
import { attentionOptions } from "./art.js";
import { chosenAttention } from "./comfyargs.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

const h3 = config.video.engines.h3;
const savedH3 = { ...h3 };
const savedCrf = config.video.saveCrf;
function restore() {
  for (const k of Object.keys(h3)) if (!(k in savedH3)) delete h3[k];
  Object.assign(h3, savedH3);
  config.video.saveCrf = savedCrf;
}

/* A synthetic LoRA set with fixed names, so nothing here depends on which
 * files happen to be on this disk. The table knows the 4-step fl2v build and
 * the 8-step ref2v build; the other two fall through to the base shift. */
const A4 = "test_fl2v_4step.safetensors", A8 = "test_fl2v_8step.safetensors";
const R4 = "test_ref2v_4step.safetensors", R8 = "test_ref2v_8step.safetensors";
const A3 = "test_fl2v_3step.safetensors";
Object.assign(h3, {
  turboLora: A8, turboLora4: A4, refTurboLora: R8, refTurboLora4: R4,
  turboLora3: A3, turbo3MaxSteps: 3,
  turboMaxSteps: 12, turbo4MaxSteps: 5, shiftVideo: 12, shiftAudio: 3,
  turboShiftVideo: undefined, turboShiftAudio: undefined,
  sampler: "auto",
  turboShiftByLora: { [A4]: { video: 6, audio: 3 }, [R8]: { video: 12, audio: 3 } },
});
config.video.saveCrf = 14;
const eng = () => ({ ...config.video, ...h3 });

try {
  console.log("\nh3TurboLoraFor — one rule for the LoRA that loads");
  eq("4 steps, fl2v path: the 4-step build", h3TurboLoraFor(eng(), { steps: 4 }).lora, A4);
  eq("5 steps is still the 4-step build (turbo4MaxSteps)", h3TurboLoraFor(eng(), { steps: 5 }).lora, A4);
  eq("3 steps, fl2v path: the 3-step build", h3TurboLoraFor(eng(), { steps: 3 }).lora, A3);
  eq("2 steps: still the 3-step build", h3TurboLoraFor(eng(), { steps: 2 }).lora, A3);
  eq("3 steps on the reference path: the ref2v 4-step build, never the fl2v-trained 3-step",
    h3TurboLoraFor(eng(), { steps: 3, refs: true }).lora, R4);
  eq("a machine without the 3-step file runs the 4-step build at 3 steps, as before",
    h3TurboLoraFor({ ...eng(), turboLora3: undefined }, { steps: 3 }).lora, A4);
  eq("6 steps: the 8-step build", h3TurboLoraFor(eng(), { steps: 6 }).lora, A8);
  eq("12 steps is the last turbo step (turboMaxSteps)", h3TurboLoraFor(eng(), { steps: 12 }).lora, A8);
  eq("13 steps: no LoRA at all", h3TurboLoraFor(eng(), { steps: 13 }).lora, null);
  eq("20 steps is not turbo", h3TurboLoraFor(eng(), { steps: 20 }).turbo, false);
  eq("8 steps on the reference path: the ref2v 8-step build", h3TurboLoraFor(eng(), { steps: 8, refs: true }).lora, R8);
  eq("4 steps on the reference path: the ref2v 4-step build", h3TurboLoraFor(eng(), { steps: 4, refs: true }).lora, R4);
  eq("no steps given: the engine's own default decides", h3TurboLoraFor(eng()).lora,
    h3TurboLoraFor(eng(), { steps: h3.steps }).lora);
  {
    const e = { ...eng(), refTurboLora: undefined, refTurboLora4: undefined };
    eq("a machine without ref2v turbos falls back to the fl2v build", h3TurboLoraFor(e, { steps: 8, refs: true }).lora, A8);
  }

  console.log("\nh3SigmaShiftFor — panel, then the LoRA's trained shift, then the base");
  {
    const s = h3SigmaShiftFor(eng(), { steps: 4 });
    eq("4 steps runs the 4-step build's trained shift", s.video, 6);
    eq("...and says the LoRA chose it", s.source, "lora");
    eq("...audio from the same row", s.audio, 3);
  }
  {
    const s = h3SigmaShiftFor(eng(), { steps: 8 });
    eq("a LoRA the table does not know runs the base shift", s.video, 12);
    eq("...and says so", s.source, "base");
  }
  {
    const s = h3SigmaShiftFor(eng(), { steps: 8, refs: true });
    eq("the reference path looks up ITS LoRA", s.lora, R8);
    eq("...and takes that row", s.source, "lora");
  }
  {
    h3.turboShiftVideo = 3;
    const s = h3SigmaShiftFor(eng(), { steps: 4 });
    eq("an explicit panel shift beats the table", s.video, 3);
    eq("...and says the panel chose it", s.source, "panel");
    eq("...while audio, unset on the panel, still comes from the LoRA row", s.sourceAudio, "lora");
    const q = h3SigmaShiftFor(eng(), { steps: 20 });
    eq("the quality path ignores the panel's turbo shift", q.video, 12);
    eq("...and the table", q.source, "base");
    h3.turboShiftVideo = 0;
    eq("a zero panel shift is unset, not a value (the 2026-09-08 outage)", h3SigmaShiftFor(eng(), { steps: 4 }).video, 6);
    h3.turboShiftVideo = undefined;
  }

  console.log("\nthe graph the engine is asked for");
  const build = (o) => videoGraphH3({ prompt: "t", seed: 1, seconds: 4, width: 1344, height: 768, prefix: "p", ...o });
  {
    const g = build({ steps: 4 });
    eq("fl2v @4: LoraLoaderModelOnly carries the 4-step build", g[18]?.inputs?.lora_name, A4);
    eq("fl2v @4: MiniMaxH3SigmaShift runs its trained shift", g[6].inputs.shift_video, 6);
    eq("fl2v @4: ...on the LoRA'd model", g[6].inputs.model[0], "18");
    eq("fl2v @4: the publisher's Euler turbo sampler", g[9].inputs.sampler_name, "euler");
    eq("fl2v @4: guidance-free BasicGuider", g[7].class_type, "BasicGuider");
    eq("fl2v @4: the publisher's simple schedule", g[8].inputs.scheduler, "simple");
  }
  {
    const g = build({ steps: 3 });
    eq("fl2v @3: LoraLoaderModelOnly carries the 3-step build", g[18]?.inputs?.lora_name, A3);
    eq("fl2v @3: the base shift, because the fixture's table has no row for it", g[6].inputs.shift_video, 12);
    eq("fl2v @3: TaoMate retains its measured sampler", g[9].inputs.sampler_name, "res_multistep");
    eq("a fallback 4-step file uses the turbo recipe even at 3 steps",
      h3SamplerFor({ ...eng(), turboLora3: A4 }, { steps: 3 }), "euler");
  }
  {
    const g = build({ steps: 8 });
    eq("fl2v @8: the 8-step build", g[18]?.inputs?.lora_name, A8);
    eq("fl2v @8: base shift, because the table has no row for it", g[6].inputs.shift_video, 12);
    eq("fl2v @8: the publisher's Euler turbo sampler", g[9].inputs.sampler_name, "euler");
  }
  {
    const g = build({ steps: 8, refImages: ["ref.png"] });
    eq("refs @8: the ref2v 8-step build loads", g[18]?.inputs?.lora_name, R8);
    eq("refs @8: the reference node is there", g[5].class_type, "MiniMaxH3ReferenceToVideo");
    eq("refs @8: its shift is the table's row for THAT LoRA", g[6].inputs.shift_video, 12);
    eq("refs @8: the reference path runs res_multistep, measured (REWIND A/B, 2026-09-24)", g[9].inputs.sampler_name, "res_multistep");
    const g4 = build({ steps: 4, refImages: ["ref.png"] });
    eq("refs @4: the ref2v 4-step build", g4[18]?.inputs?.lora_name, R4);
    eq("refs @4: retains ref2v's 12/3 shift, distinct from fl2v", `${g4[6].inputs.shift_video}/${g4[6].inputs.shift_audio}`, "12/3");
    eq("refs @4: res_multistep with guidance-free BasicGuider", `${g4[9].inputs.sampler_name}/${g4[7].class_type}`, "res_multistep/BasicGuider");
  }
  {
    const g = build({ steps: 20 });
    eq("quality @20: no LoRA node", g[18], undefined);
    eq("quality @20: the shift node sits on the bare model", g[6].inputs.model[0], "1");
    eq("quality @20: the base shift", g[6].inputs.shift_video, 12);
    eq("quality @20: retains its measured res_multistep sampler", g[9].inputs.sampler_name, "res_multistep");
  }
  {
    h3.sampler = "dpmpp_2m";
    for (const steps of [4, 8, 20]) for (const refImages of [[], ["ref.png"]]) {
      eq(`explicit sampler survives at ${steps} steps with ${refImages.length} refs`,
        build({ steps, refImages })[9].inputs.sampler_name, "dpmpp_2m");
    }
    h3.sampler = "res_multistep";
    eq("an existing res_multistep selection remains explicit", build({ steps: 4 })[9].inputs.sampler_name, "res_multistep");
    h3.sampler = "auto";
  }

  console.log("\nSaveVideo — a CRF the writer actually receives");
  eq("saveEncode names the codec", saveEncode({ saveCrf: 14 }).codec, "h264");
  eq("...the encode mode, dotted under it", saveEncode({ saveCrf: 14 })["codec.encoding"], "re-encode");
  eq("...and the CRF, dotted under that", saveEncode({ saveCrf: 14 })["codec.encoding.crf"], 14);
  eq("...container still auto", saveEncode({ saveCrf: 14 }).format, "auto");
  {
    const was = config.video.saveCrf;
    config.video.saveCrf = undefined;
    eq("with no CRF anywhere, the old node", JSON.stringify(saveEncode({})), JSON.stringify({ format: "auto", codec: "auto" }));
    config.video.saveCrf = was;
  }
  eq("a zero CRF is the old node", JSON.stringify(saveEncode({ saveCrf: 0 })), JSON.stringify({ format: "auto", codec: "auto" }));
  eq("an engine without its own CRF takes config.video's", saveEncode({ shiftVideo: 12 })["codec.encoding.crf"], 14);
  eq("a string CRF from a settings file is a number on the wire", saveEncode({ saveCrf: "12" })["codec.encoding.crf"], 12);
  {
    const fl = build({ steps: 8 })[15].inputs;
    const rf = build({ steps: 8, refImages: ["ref.png"] })[15].inputs;
    for (const [name, i] of [["fl2v", fl], ["refs", rf]]) {
      eq(`${name} path SaveVideo: h264`, i.codec, "h264");
      eq(`${name} path SaveVideo: re-encode at config's CRF`, i["codec.encoding.crf"], 14);
      eq(`${name} path SaveVideo: still names its prefix`, i.filename_prefix, "p");
    }
    config.video.saveCrf = 0;
    const off = build({ steps: 8 })[15].inputs;
    eq("CRF 0 restores the auto/auto node", off.codec === "auto" && !("codec.encoding" in off), true);
    config.video.saveCrf = 14;
  }
  try {
    const ltx = videoGraphLtx({ prompt: "t", seed: 1, seconds: 4, prefix: "p" });
    const sv = Object.values(ltx).find((n) => n.class_type === "SaveVideo");
    eq("LTX's SaveVideo takes the same CRF (its engine block has none, config.video does)", sv?.inputs?.["codec.encoding.crf"], 14);
  } catch (e) {
    ok("LTX's SaveVideo takes the same CRF", false, `videoGraphLtx threw: ${e.message}`);
  }

  /* The contract with the node itself, where the rig is present: the option
   * keys the dotted names spell must be the ones SaveVideo declares. A ComfyUI
   * that renames "re-encode" would otherwise take the graph and drop the CRF. */
  {
    const rig = process.env.AIPLAY_RIG || "D:/AI/aiplay-studio-bench";
    const nodes = path.join(rig, "ComfyUI", "comfy_extras", "nodes_video.py");
    const io = path.join(rig, "ComfyUI", "comfy_api", "latest", "_io.py");
    if (fs.existsSync(nodes) && fs.existsSync(io)) {
      const src = fs.readFileSync(nodes, "utf8");
      const sv = src.slice(src.indexOf("class SaveVideo"), src.indexOf("class SaveVideo") + 4000);
      ok("the installed SaveVideo declares codec option \"h264\"", /DynamicCombo\.Option\(\s*"h264"/.test(src));
      ok("...with a nested \"encoding\" combo", /DynamicCombo\.Input\(\s*"encoding"/.test(src));
      ok("...whose \"re-encode\" option carries a Float \"crf\"", /Option\(\s*"re-encode",\s*\[\s*io\.Float\.Input\(\s*"crf"/.test(src));
      /* ComfyUI 0.36 (2026-09-15) moved the codec options into _save_video_codec_input(),
       * nested them under `format`, and kept the old top-level `codec` as an optional
       * HIDDEN input that execute() still honours (`codec = format.get("codec") or codec`).
       * The option text is therefore searched in the whole file, and the class must
       * either declare it inline (0.33) or carry that compatibility input (0.36) — the
       * dotted names this graph sends ride one or the other. */
      ok("...and the class takes the top-level codec the graph sends: inline (0.33) or as the hidden compatibility input (0.36)",
        /DynamicCombo\.Option\(\s*"h264"/.test(sv) || /_save_video_codec_input\(\["auto", "h264", "av1"\], optional=True, hidden=True\)/.test(sv));
      ok("...and reads it as codec[\"encoding\"][\"crf\"]", /encoding\.get\("crf"\)/.test(src));
      ok("the installed _io joins nested ids with a dot", /"\."\.join\(prefix_list\)/.test(fs.readFileSync(io, "utf8")));
    } else {
      console.log("  SKIP  the rig is not here — the node contract pins were not made");
    }
  }

  console.log("\nthe soundtrack is a request, not a default");
  {
    const dry = build({ steps: 8, refImages: ["ref.png"] });
    ok("no audioTrack: no freeze nodes (60-65)", [60, 61, 62, 63, 64, 65].every((n) => !dry[n]));
    ok("no audioTrack: no frame-0 audio anchor (23)", !dry[23]);
    eq("no audioTrack: the sampler denoises node 5's own latent", dry[11].inputs.latent_image[0], "5");
    const wet = build({ steps: 8, refImages: ["ref.png"], audioTrack: { name: "song.flac", start: 12 } });
    ok("audioTrack: the freeze chain is built", [60, 61, 62, 63, 64, 65].every((n) => wet[n]));
    eq("audioTrack: the anchor is on the conditioning", wet[7].inputs.conditioning[0], "23");
    eq("audioTrack: the sampler denoises the frozen AV latent", wet[11].inputs.latent_image[0], "65");
    eq("audioTrack: trimmed from the segment's start", wet[61].inputs.start_index, 12);
  }

  /* The MV gate is inside a function that needs a whole project to call, so it
   * is pinned as text: the audioTrack expression must be gated on the rule,
   * and the rule must name all four doors. */
  {
    const gen = fs.readFileSync(new URL("./mv/generate.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    ok("generate.js gates audioTrack on songConditioned", /audioTrack: \(doc\.song\?\.file && songConditioned\)/.test(gen));
    ok("...LTX always", /songConditioned = engine === "ltx"/.test(gen));
    ok("...H3 off the reference path", /\|\| !useRefs/.test(gen));
    ok("...a board that sings", /Boolean\(board\?\.lipSync\)/.test(gen));
    ok("...or a brief that insists", /doc\.brief\?\.songConditioning === "always"/.test(gen));
    ok("...and the old sentence claiming H3 ignores it is gone", !/and H3 ignores it\./.test(gen));
  }

  console.log("\nconfig.js — the table names files the picks know, and the ref path prefers the 8-step build");
  {
    const cfg = fs.readFileSync(new URL("./config.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    for (const name of Object.keys(savedH3.turboShiftByLora ?? {})) {
      ok(`turboShiftByLora's "${name.slice(11, 46)}…" is also a pick candidate`, cfg.split(`"${name}"`).length - 1 >= 2);
    }
    ok("the table has a row for the fl2v 4-step 768p build, at 6",
      savedH3.turboShiftByLora?.["minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors"]?.video === 6);
    ok("refTurboLora's first candidate is the ref2v 8-step v1.0 768p build",
      /refTurboLora: loraSlot\("refTurboLora",\n\s+"minimax_h3_ref2v_turbo_8step_v1\.0_768p_comfyui_bf16\.safetensors"/.test(cfg));
    ok("refTurboLora4 still leads with the 4-step v0.1 build",
      /refTurboLora4: loraSlot\("refTurboLora4",\n\s+"minimax_h3_ref2v_turbo_4step_v0\.1_comfyui_bf16\.safetensors"/.test(cfg));
    ok("turboLora3 leads with the TaoMate conversion, then Kijai's rank-19 average, then the 4-step build",
      /export const TAOMATE_FILES = \[\n\s+"taomate_h3_3step_comfy\.safetensors",\n\s+"minimax_h3_taomate_3step_lora_avg_rank_19_bf16\.safetensors",\n\];/.test(cfg)
      && /turboLora3: loraSlot\("turboLora3", \.\.\.TAOMATE_FILES,\n\s+"minimax_h3_fl2v_turbo_4step_v1\.0_768p_comfyui_bf16\.safetensors"\)/.test(cfg));
    ok("...and the table starts the rank-19 average at the base 12 too",
      savedH3.turboShiftByLora?.["minimax_h3_taomate_3step_lora_avg_rank_19_bf16.safetensors"]?.video === 12);
    ok("the table starts the 3-step build at the base 12 until it is measured",
      savedH3.turboShiftByLora?.["taomate_h3_3step_comfy.safetensors"]?.video === 12);
    ok("the Video panel's step slider reaches 3",
      /id="vidSteps" type="range" min="3"/.test(fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8")));
    ok("config.video.saveCrf is set, and not to libx264's silent 23", savedCrf > 0 && savedCrf < 23);
  }
  /* ── COMFY KITCHEN ATTENTION ─────────────────────────────────────────────
   * Measured 1.5-1.9x on the sampler for a real film clip on this card, and
   * never switched on in 698 earlier renders (config.js has the numbers). The
   * pins below are about WHERE the node sits, because in the wrong place it is
   * worse than absent: after the shift, the scheduler runs on one model and the
   * guider on another; before a LoRA, the LoRA patches the dense model. */
  console.log("\n  -- Comfy Kitchen attention --");
  {
    ok("config ships H3 with attention \"ck\"", savedH3.attention === "ck", String(savedH3.attention));
    const base = { prompt: "p", seed: 1, seconds: 4.4, width: 1344, height: 768, steps: 4 };
    const shapes = [
      ["references", { refImages: ["a.png", "b.png"] }, "18"],
      ["plain text-to-video", {}, "18"],
      ["the person's own LoRA", { refImages: ["a.png"], loras: [{ name: "mine.safetensors", strength: 0.8 }] }, "90"],
      ["a control video", { controlVideo: "c.mp4", controlPatch: "p.safetensors" }, "34"],
    ];
    for (const [label, extra, wraps] of shapes) {
      const g = videoGraphH3({ ...base, ...extra, attention: "ck" });
      ok(`${label}: node 85 is ModelAttentionBackend on "comfy kitchen attention"`,
        g["85"]?.class_type === "ModelAttentionBackend" && g["85"]?.inputs.attention === "comfy kitchen attention",
        JSON.stringify(g["85"]));
      eq(`${label}: it wraps the LAST patch on the model (${wraps})`, g["85"]?.inputs.model?.[0], wraps);
      eq(`${label}: and the sigma shift reads it`, g["6"].inputs.model[0], "85");
      ok(`${label}: so guider AND scheduler both run on the CK model`,
        g["7"].inputs.model[0] === "6" && g["8"].inputs.model[0] === "6");
    }
    for (const off of [null, undefined, "", "CK", "kitchen"]) {
      const g = videoGraphH3({ ...base, refImages: ["a.png"], attention: off });
      ok(`attention ${JSON.stringify(off)} puts no node in the graph`,
        !Object.values(g).some((n) => n.class_type === "ModelAttentionBackend") && g["6"].inputs.model[0] !== "85");
    }
    /* "pytorch" is an EXPLICIT PyTorch node in the same place. Only an engine
     * with a per-render picker asks for it (FastH3); h3Attention() answers "ck"
     * or null, so H3's own graphs and their cache keys do not change. */
    {
      const g = videoGraphH3({ ...base, refImages: ["a.png"], attention: "pytorch" });
      ok("attention \"pytorch\" is node 85 on \"pytorch attention\", read by the shift",
        g["85"]?.class_type === "ModelAttentionBackend" && g["85"]?.inputs.attention === "pytorch attention"
          && g["6"].inputs.model[0] === "85", JSON.stringify(g["85"]));
    }
    /* Node 85 is the only free id in that neighbourhood. The first A/B harness
     * used 50 and would have overwritten the first AUDIO reference's loader. */
    {
      const g = videoGraphH3({ ...base, refImages: ["a.png"], refAudios: [{ name: "v.wav" }], attention: "ck" });
      ok("an audio reference and the attention node do not collide",
        g["50"]?.class_type === "LoadAudio" && g["85"]?.class_type === "ModelAttentionBackend",
        `50=${g["50"]?.class_type} 85=${g["85"]?.class_type}`);
    }

    /* THE ENGINE'S ANSWER, both shapes. Reading only one would make an engine
     * on the other look like it has no Comfy Kitchen — slow, and never an error. */
    const v3 = { ModelAttentionBackend: { input: { required: { attention: ["COMBO",
      { options: ["pytorch attention", "comfy kitchen attention"], default: "pytorch attention" }] } } } };
    const legacy = { ModelAttentionBackend: { input: { required: { attention: [
      ["pytorch attention", "comfy kitchen attention"], { default: "pytorch attention" }] } } } };
    const without = { ModelAttentionBackend: { input: { required: { attention: ["COMBO",
      { options: ["pytorch attention"] }] } } } };
    ok("the v3 COMBO shape is read (what 0.36 sends)", attentionOptions(v3).includes("comfy kitchen attention"));
    ok("the older list shape is read too", attentionOptions(legacy).includes("comfy kitchen attention"));
    ok("an engine without the kernel does not offer it", !attentionOptions(without).includes("comfy kitchen attention"));
    for (const junk of [null, {}, { ModelAttentionBackend: {} }, { ModelAttentionBackend: { input: { required: { attention: "x" } } } }]) {
      ok(`an unreadable answer is "not offered", not a throw (${JSON.stringify(junk).slice(0, 40)})`,
        Array.isArray(attentionOptions(junk)) && attentionOptions(junk).length === 0);
    }

    /* THE CALLER. The route that builds every clip names each field it passes
     * and drops the rest in silence — so a speedup nobody passes is simply
     * absent, and a slow clip is not an error anyone sees. */
    const art = fs.readFileSync(new URL("./art.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    ok("art.js hands the H3 graph its attention", /attention: await this\.videoAttention\(job\),/.test(art));
    {
      const va = art.slice(art.indexOf("async videoAttention(job)"), art.indexOf("async videoAttention(job)") + 600);
      ok("...videoAttention gives LTX no node", /if \(name === "ltx"\) return null;/.test(va));
      ok("...H3 goes through h3Attention(), never around it", /return this\.h3Attention\(\);/.test(va));
      ok("...and an engine with its own picker names a literal backend, never the launcher's",
        /if \(eng\?\.sparseAttention\) \{[\s\S]{0,200}return "pytorch";[\s\S]{0,120}return \(await this\.#kitchenOffered\(\)\) \? "ck" : "pytorch";/.test(va));
    }
    const fn = art.slice(art.indexOf("async h3Attention()"), art.indexOf("async h3Attention()") + 900);
    const probe = art.slice(art.indexOf("async #kitchenOffered()"), art.indexOf("async #kitchenOffered()") + 500);
    ok("h3Attention answers \"ck\" or null, never \"pytorch\" (so H3's graphs are unchanged)",
      /return \(await this\.#kitchenOffered\(\)\) \? "ck" : null;/.test(fn) && !/"pytorch"/.test(fn.slice(0, fn.indexOf("async #kitchenOffered()"))));
    ok("h3Attention lets an EXPLICIT launcher choice other than CK win",
      /const chosen = chosenAttention\(config\.comfy\?\.options\?\.attention,\s*\{ fix: config\.comfy\?\.amdFix, vendor: vendorOf\(config\.gpu, config\.torchBackend\) \}\);\s*if \(chosen && chosen !== "--use-ck-attention"\) return null;/.test(fn));
    /* The AMD/Intel fix's PyTorch value is what the launcher's panel SHOWS on
     * those cards, so any Save stores it. Read as a choice, it took Comfy
     * Kitchen away from H3 on every AMD install whose panel was ever saved. */
    const PT = "--use-pytorch-cross-attention";
    eq("AMD, fix auto: the fix's PyTorch is not a choice", chosenAttention(PT, { fix: "auto", vendor: "amd" }), null);
    eq("Intel, fix auto: the same", chosenAttention(PT, { fix: "auto", vendor: "intel" }), null);
    eq("fix forced on (any card): the same", chosenAttention(PT, { fix: "on", vendor: "nvidia" }), null);
    eq("NVIDIA, fix auto: PyTorch is the person's choice", chosenAttention(PT, { fix: "auto", vendor: "nvidia" }), PT);
    eq("AMD with the fix OFF: PyTorch is the person's choice", chosenAttention(PT, { fix: "off", vendor: "amd" }), PT);
    eq("AMD, fix auto: Sage is still the person's choice", chosenAttention("--use-sage-attention", { fix: "auto", vendor: "amd" }), "--use-sage-attention");
    eq("AMD, fix auto: CK stays CK", chosenAttention("--use-ck-attention", { fix: "auto", vendor: "amd" }), "--use-ck-attention");
    eq("nothing saved is no choice", chosenAttention(undefined, { fix: "auto", vendor: "amd" }), null);
    ok("...honours config's own switch", /config\.video\.engines\.h3\?\.attention \?\? "ck"\) !== "ck"\) return null/.test(fn));
    ok("...asks the running engine whether it offers the option", /engineDoor\.objectInfo\("ModelAttentionBackend"\)/.test(probe) && /attentionOptions\(info\)\.includes\("comfy kitchen attention"\)/.test(probe));
    ok("...and a failed probe means not offered, never a thrown render", /catch \{ this\.#ckOffered = false; \}/.test(probe));
    ok("an engine restart forgets the answer, because it may be a different ComfyUI",
      /engineDoor\.on\("rebound", \(\) => \{[\s\S]{0,300}this\.#ckOffered = undefined;/.test(art));
  }

} finally {
  restore();
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log("  failed:\n    " + failures.join("\n    ")); process.exit(1); }
