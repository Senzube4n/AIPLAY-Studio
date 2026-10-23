/** V1.1 preference is a file policy, not a new step, sampler or calibration. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { validateVideoLoras } from "./video-lora-validation.js";

const V11 = "minimax_h3_ref2v_turbo_8step_v1.1_768p_comfyui_bf16.safetensors";
const V10 = "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors";
const R4 = "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors";
const F8 = "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors";
const F4 = "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors";
const url = (rel) => JSON.stringify(new URL(rel, import.meta.url).href);
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

function onDisk(files, extra = "", gpu = "nvidia") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h3-ref-v11-"));
  try {
    const models = path.join(dir, "models");
    fs.mkdirSync(path.join(models, "loras"), { recursive: true });
    fs.mkdirSync(path.join(dir, "settings"));
    fs.writeFileSync(path.join(dir, "settings", "settings.json"), JSON.stringify({ gpu: { vendor: gpu } }));
    for (const f of files) fs.writeFileSync(path.join(models, "loras", f), "fixture");
    const code = `import fs from 'node:fs'; import path from 'node:path';
      import {config,refreshH3Speedups,H3_REF_TURBO8_FILES} from ${url("./config.js")};
      import {videoGraphH3,h3SigmaShiftFor,referenceSteps} from ${url("./workflow.js")};
      import {videoPlan,KEEP_MEASURED,measuredBuildHere,songUnderSay} from ${url("./video-plain.js")};
      const h=config.video.engines.h3;
      const build=(o={})=>videoGraphH3({prompt:'<Picture 1> is Mira. Mira lifts a cup.',seed:1,seconds:5,width:1344,height:768,prefix:'test',steps:8,...o});
      const g=build({refImages:['ref.png']}),q=build({steps:20,refImages:['ref.png']});
      const plan=videoPlan({prompt:'<Picture 1> is Mira. Mira lifts a cup.',refImages:['ref.png'],song:true},{engineKey:'h3',eng:h});
      const out={selected:h.refTurboLora,referenceSteps:referenceSteps(h),defaults:h.stepDefaults,
        versions:H3_REF_TURBO8_FILES,automatic:h.automaticLoras,plain:h.turboLora,
        lora:g[18]?.inputs,ref4:build({steps:4,refImages:['ref.png']})[18]?.inputs,
        plain8:build()[18]?.inputs,plain4:build({steps:4})[18]?.inputs,
        qualityHasLora:!!q[18],qualityShift:q[6].inputs,
        shift:h3SigmaShiftFor(h,{steps:8,refs:true}),
        sampler:g[9].inputs.sampler_name,scheduler:g[8].inputs.scheduler,
        measured:measuredBuildHere(h),calibration:KEEP_MEASURED,character:plan.character,
        notes:plan.notes,songLine:songUnderSay('h3',{pictures:1})};
      ${extra}
      console.log(JSON.stringify(out));`;
    return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, AIPLAY_APPDATA: path.join(dir, "settings"), AIPLAY_MODELS_DIR: models,
        AIPLAY_RIG: path.join(dir, "rig"), AIPLAY_OUTPUT: path.join(dir, "output") },
      encoding: "utf8", timeout: 60_000,
    }).trim().split("\n").at(-1));
  } finally {
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("V1.1 wins with both installed; step counts, other paths and explicit 12/3 stay matched", () => {
  const got = onDisk([V11, V10, R4, F8, F4]);
  assert.equal(got.selected, V11);
  assert.equal(got.referenceSteps, 8);
  assert.equal(got.defaults.standard, 8);
  assert.equal(got.defaults.best, 20);
  assert.deepEqual(got.versions, [V11, V10]);
  assert.deepEqual(got.automatic, [V11, V10]);
  assert.equal(got.lora.lora_name, V11);
  assert.equal(got.lora.strength_model, 1);
  assert.equal(got.ref4.lora_name, R4);
  assert.equal(got.plain8.lora_name, F8);
  assert.equal(got.plain4.lora_name, F4);
  assert.equal(got.qualityHasLora, false);
  assert.equal(got.shift.video, 12);
  assert.equal(got.shift.audio, 3);
  assert.equal(got.shift.source, "lora");
  assert.equal(got.shift.sourceAudio, "lora");
  assert.equal(got.sampler, "res_multistep");
  assert.equal(got.scheduler, "simple");
});

test("V1.0 remains a working eight-step fallback; a four-step-only install stays at four", () => {
  const old = onDisk([V10, R4, F8, F4]);
  assert.equal(old.selected, V10);
  assert.equal(old.referenceSteps, 8);
  assert.equal(old.defaults.standard, 8);
  assert.equal(old.lora.lora_name, V10);
  assert.equal(old.measured, true);
  const four = onDisk([R4, F4]);
  assert.equal(four.selected, R4);
  assert.equal(four.referenceSteps, 4);
  assert.equal(four.defaults.standard, 4);
  assert.equal(four.ref4.lora_name, R4);
});

test("AMD, Intel and CPU use the same version preference without a new hardware claim", () => {
  for (const gpu of ["amd", "intel", "cpu"]) {
    const got = onDisk([V11, V10, R4, F8, F4], "", gpu);
    assert.equal(got.selected, V11, gpu);
    assert.equal(got.referenceSteps, 8, gpu);
    assert.equal(got.lora.lora_name, V11, gpu);
  }
});

test("a late download or removal refreshes the selection without changing a person's steps", () => {
  const got = onDisk([V10, R4, F8, F4], `
    h.steps=20;
    fs.writeFileSync(path.join(config.modelsDir,'loras',${JSON.stringify(V11)}),'fixture');
    refreshH3Speedups(); out.afterDownload={selected:h.refTurboLora,steps:h.steps};
    fs.unlinkSync(path.join(config.modelsDir,'loras',${JSON.stringify(V11)}));
    refreshH3Speedups(); out.afterRemoval={selected:h.refTurboLora,steps:h.steps};`);
  assert.deepEqual(got.afterDownload, { selected: V11, steps: 20 });
  assert.deepEqual(got.afterRemoval, { selected: V10, steps: 20 });
});

test("V1.1 does not inherit the historical V1.0 identity or singing measurement", () => {
  const got = onDisk([V11, V10, R4, F8, F4]);
  assert.equal(got.calibration.file, V10);
  assert.equal(got.calibration.steps, 8);
  assert.equal(got.measured, false);
  assert.equal(got.character.measuredHere, false);
  assert.match(got.character.receipt, /8-step V1\.0; different build selected/);
  assert.doesNotMatch(got.character.hint, /not on this PC|not.*download/);
  assert.match(got.songLine.hint, /8-step V1\.0 reference build; other builds are unverified/);
});

test("the API and status exclude both automatic versions from a custom stack", async () => {
  const index = read("./index.js");
  const code = index.slice(index.indexOf("async function checkedVideoLoras("), index.indexOf("/* Qwen too"));
  let options;
  const e = { loraBase: "MiniMax H3", refTurboLora: V11, automaticLoras: [V11, V10] };
  const route = new Function("videoEngine", "validateVideoLoras", "scanBases", "modelBases", "probeModel",
    `return (${code.trim()});`)(() => e, async (_value, opts) => { options = opts; }, () => [], async () => [], () => ({}));
  await route([{ name: V10 }], "h3");
  assert.ok(options.automatic.includes(V11));
  assert.ok(options.automatic.includes(V10));
  const names = index.match(/ownLoras: ([\s\S]*?)\.map\(\(n\) => requireModelName\(n\)\),/)[1];
  const own = new Function("e", `return (${names});`)(e);
  assert.ok(own.includes(V11));
  assert.ok(own.includes(V10));
  for (const name of [V11, V10]) await assert.rejects(validateVideoLoras([{ name }], {
    engine: "h3", loraBase: "MiniMax H3", automatic: options.automatic,
    shelf: async () => [{ name, folder: "loras", full: `fixture/${name}` }],
    probe: async () => { throw new Error("an automatic adapter must be rejected before probing"); },
  }), /loads automatically/);
});

test("Video references downloads the pinned V1.1 update and keeps the separate four-step file", async () => {
  const { CATALOG } = await import("./models.js");
  const row = CATALOG.find((c) => c.id === "videoRefs");
  const file = row.files.find((f) => path.basename(f.dest) === V11);
  assert.ok(file);
  assert.equal(file.url, `https://huggingface.co/lightx2v/Minimax-h3-Turbo/resolve/30f485ed874aa44c8183348ad361c5eabad318da/${V11}`);
  assert.equal(file.bytes, 1_956_193_000);
  assert.equal(file.sha256, "e56863a7524e0300729cbb7b64cc8b548d90698c1abbf7d83898b0122fbe1e81");
  assert.equal(file.alt, undefined, "V1.0 must not hide an available V1.1 update");
  assert.ok(row.files.some((f) => path.basename(f.dest) === R4));
  assert.equal(row.outputRights.class, "yours-with-conditions");
  assert.ok(row.region.excluded.includes("European Union"));
});
