/**
 * YOUR OWN LoRAs ON THE VIDEO SCREEN.
 *
 * The Video screen had no LoRA picker at all, while MiniMax H3 and LTX LoRAs
 * exist and ComfyUI loads them with LoraLoaderModelOnly. These build the graphs
 * and read the route and the page; no engine, no GPU.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { videoLoras, videoGraphH3, videoGraphLtx } from "./workflow.js";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const A = { name: "style_a.safetensors", strength: 0.8 }, B = { name: "style_b.safetensors", strength: 1.2 };
const base = { prompt: "a neon street", seed: 1, seconds: 3, width: 864, height: 480 };

test("the stack is cleaned the way the image route cleans its own", () => {
  assert.equal(videoLoras(undefined), undefined);
  assert.equal(videoLoras([]), undefined, "an empty stack sends nothing");
  assert.deepEqual(videoLoras([{ name: "C:\\evil\\..\\x.safetensors", strength: 9 }]), [{ name: "x.safetensors", strength: 4 }],
    "a bare file name, never a path; strength clamped");
  assert.deepEqual(videoLoras([{ name: "notes.txt" }, { name: "ok.safetensors" }]), [{ name: "ok.safetensors", strength: 1 }]);
  assert.equal(videoLoras(Array.from({ length: 12 }, (_, i) => ({ name: `l${i}.safetensors` }))).length, 8);
});

test("H3: the LoRAs chain after the turbo LoRA and feed the shift", () => {
  const g = videoGraphH3({ ...base, steps: 8, loras: [A, B] });
  assert.equal(g[90].class_type, "LoraLoaderModelOnly");
  assert.deepEqual(g[90].inputs, { model: ["18", 0], lora_name: A.name, strength_model: 0.8 }, "on top of the distillation");
  assert.deepEqual(g[91].inputs.model, ["90", 0], "they chain");
  assert.deepEqual(g[6].inputs.model, ["91", 0], "the sampler sees the last one");
});

test("H3: on the quality path they sit on the bare model", () => {
  const g = videoGraphH3({ ...base, steps: 20, loras: [A] });
  assert.equal(g[18], undefined, "no turbo LoRA at 20 steps");
  assert.deepEqual(g[90].inputs.model, ["1", 0]);
  assert.deepEqual(g[6].inputs.model, ["90", 0]);
});

test("H3: the reference path and video-to-video carry them too", () => {
  const r = videoGraphH3({ ...base, steps: 8, loras: [A], refImages: ["ref.png"] });
  assert.equal(r[5].class_type, "MiniMaxH3ReferenceToVideo");
  assert.deepEqual(r[6].inputs.model, ["90", 0]);
  const c = videoGraphH3({ ...base, steps: 8, loras: [A], controlVideo: "c.mp4", controlPatch: "p.safetensors" });
  assert.deepEqual(c[34].inputs.model, ["90", 0], "the control patch goes on the LoRA'd model");
  assert.deepEqual(c[6].inputs.model, ["34", 0]);
});

test("no LoRAs leaves both graphs byte for byte", () => {
  assert.deepEqual(videoGraphH3({ ...base, steps: 8, loras: [] }), videoGraphH3({ ...base, steps: 8 }));
  assert.deepEqual(videoGraphLtx({ ...base, loras: null }), videoGraphLtx(base));
  assert.equal(videoGraphH3({ ...base, steps: 8 })[90], undefined);
});

test("LTX: both passes sample through the LoRAs", () => {
  const g = videoGraphLtx({ ...base, loras: [A, B] });
  assert.deepEqual(g[90].inputs.model, ["1", 0]);
  assert.deepEqual(g[15].inputs.model, ["91", 0], "pass 1");
  assert.deepEqual(g[23].inputs.model, ["91", 0], "pass 2");
  const guided = videoGraphLtx({ ...base, loras: [A], firstFrame: "a.png", lastFrame: "b.png" });
  assert.deepEqual(guided[15].inputs.model, ["90", 0], "the single-pass guided run too");
});

test("H3 user LoRAs preserve the turbo sampler, quality sampling and every conditioning mode", () => {
  const models = { sampler: "auto", turboLora: "fl8.safetensors", turboLora4: "fl4.safetensors", refTurboLora: "ref8.safetensors", refTurboLora4: "ref4.safetensors" };
  const modes = [
    {}, { firstFrame: "first.png" }, { firstFrame: "first.png", loop: true },
    { refImages: ["reference.png"] }, { refAudios: [{ name: "reference.wav", start: 0, seconds: 2 }] },
    { controlVideo: "control.mp4", controlPatch: "control.safetensors" },
    { continueFrom: { file: "tail.mp4", frames: 90, overlapFrames: 22, extensionFrames: 68, hasAudio: true } },
    { refImages: ["reference.png"], audioTrack: { name: "sound.wav", start: 0 }, bridge: "bridge.safetensors", bridgeAlpha: 0.4 },
  ];
  for (const steps of [4, 8, 20]) for (const mode of modes) {
    const g = videoGraphH3({ ...base, ...mode, steps, models, loras: [A, B] });
    /* Euler on the first/last-frame turbo builds only; the reference path runs
     * res_multistep, measured (the REWIND A/B, 2026-09-24). */
    const onRefPath = !!(mode.refImages || mode.refAudios);
    assert.equal(g[9].inputs.sampler_name, steps <= 8 && !onRefPath ? "euler" : "res_multistep");
    assert.equal(g[7].class_type, "BasicGuider");
    assert.deepEqual(g[7].inputs.model, ["6", 0]);
    assert.deepEqual(g[8].inputs.model, ["6", 0]);
    assert.deepEqual(g[90].inputs.model, [steps <= 8 ? "18" : "1", 0]);
    assert.deepEqual(g[91].inputs.model, ["90", 0]);
    assert.deepEqual(g[6].inputs.model, [mode.controlVideo ? "34" : "91", 0]);
    if (mode.controlVideo) assert.deepEqual(g[34].inputs.model, ["91", 0]);
    if (steps <= 8) {
      const refs = !!(mode.refImages || mode.refAudios);
      assert.equal(g[18].inputs.lora_name, `${refs ? "ref" : "fl"}${steps}.safetensors`);
    }
    // No dangling graph edges or collisions with guides, references or bridge.
    for (const node of Object.values(g)) for (const value of Object.values(node.inputs)) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1])) assert.ok(g[value[0]], `missing node ${value[0]}`);
    }
  }
});

test("LTX full-size, loop, waypoints and soundtrack keep user model patches on every sampler", () => {
  const modes = [
    { baseScale: "full" }, { firstFrame: "first.png" },
    { firstFrame: "first.png", loop: true, midFrames: ["middle.png"] },
    { firstFrame: "first.png", lastFrame: "last.png", audioTrack: { name: "sound.wav", start: 0 } },
  ];
  for (const mode of modes) {
    const g = videoGraphLtx({ ...base, ...mode, loras: [A, B] });
    for (const node of Object.values(g).filter((row) => row.class_type === "LTXVDualCFGGuider")) assert.deepEqual(node.inputs.model, ["91", 0]);
    assert.deepEqual(g[90].inputs.model, ["1", 0]);
    assert.deepEqual(g[91].inputs.model, ["90", 0]);
  }
});

test("the route, the job and the page carry the stack", () => {
  const index = src("./index.js");
  assert.equal((index.match(/loras: videoLoras\(b\.loras\),/g) || []).length, 2, "create and extend");
  assert.match(index, /ownLoras: \[e\.turboLora, e\.turboLora4, e\.turboLora3, e\.refTurboLora, e\.refTurboLora4\]/);
  assert.match(src("./art.js"), /loras: job\.loras,/, "the job hands it to the graph");
  const app = src("../web/app.js");
  assert.match(app, /\.\.\.vidLoraChoice\(\),/);
  assert.doesNotMatch(app, /VID_LORA_BASE/, "no copy of the engine list on the screen");
  assert.match(app, /const want = state\.video\?\.engines\?\.\[eng\]\?\.loraBase;/, "the picker judges against the engine's own base, from /api/status");
  assert.match(index, /loraBase: e\.loraBase \?\? null,/, "which /api/status sends");
  assert.match(index, /engine, loraBase: e\.loraBase, label: e\.label, shelf:/, "and /api/video checks against the same value");
  assert.match(app, /!own\.has\(l\.name\)/, "the engine's own turbo LoRAs are not offered twice");
  assert.match(src("../web/index.html"), /<select id="vidLoraPick"/);
  assert.match(src("./detect.js"), /return \{ variant: "MiniMax H3"/);
  assert.match(src("./detect.js"), /return \{ variant: "LTX"/);
});
