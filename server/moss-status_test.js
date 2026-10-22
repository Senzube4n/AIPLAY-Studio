import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { CATALOG } from "./models.js";
import { mossImageGraph, MOSS_IMAGE_FILES } from "./moss-image.js";
import { mossImageStatus } from "./moss-status.js";

const cap = CATALOG.find(c => c.id === "moss-image");
const shelf = cap.files.map(f => ({ name: path.basename(f.dest), folder: path.basename(path.dirname(f.dest)), bytes: f.bytes }));
function info() {
  const out = Object.fromEntries(Object.values(mossImageGraph({ prompt: "check" })).map(n => [n.class_type, {}]));
  out.CLIPLoader = { input: { required: { type: [["flux2", "moss_image"]] } } };
  return out;
}
const deps = (extra = {}) => ({ config: {}, bases: async () => [], scan: async () => shelf, engine: { objectInfo: async () => info() }, ...extra });

test("readiness requires native MOSS capability, not just generic nodes found on an older engine", async () => {
  const yes = await mossImageStatus(deps()); assert.equal(yes.ready, true, yes.error);
  const old = info(); old.CLIPLoader.input.required.type[0] = ["flux2", "qwen_image"];
  const no = await mossImageStatus(deps({ engine: { objectInfo: async () => old } }));
  assert.equal(no.ready, false); assert.equal(no.filesReady, true); assert.equal(no.runtimeReady, false);
  assert.deepEqual(no.missingNodes, []); assert.match(no.error, /native MOSS-Image support/);
  assert.equal(no.setup, undefined, "never changes or repairs the production runtime automatically");
  const incomplete = info(); delete incomplete.EmptyFlux2LatentImage;
  assert.deepEqual((await mossImageStatus(deps({ engine: { objectInfo: async () => incomplete } }))).missingNodes, ["EmptyFlux2LatentImage"]);
});

test("custom wrong-architecture files cannot pass readiness by being nonempty", async () => {
  for (const options of [{ dit: "wrong-sdxl.safetensors" }, { encoder: "wrong-clip-l.safetensors" }, { vae: "wrong-sd15.safetensors" }]) {
    const wrong = await mossImageStatus(deps({ options, scan: async () => [...shelf, ...Object.values(options).map(name => ({ name, folder: options.dit ? "diffusion_models" : options.encoder ? "text_encoders" : "vae", bytes: 100 }))] }));
    assert.equal(wrong.ready, false); assert.match(wrong.error, /verified MOSS-Image SFT bundle/);
  }
});

test("missing, truncated, hidden or ambiguous files and offline runtime all fail closed", async () => {
  const missing = await mossImageStatus(deps({ scan: async () => shelf.slice(1) }));
  assert.deepEqual(missing.missingFiles, [MOSS_IMAGE_FILES.dit]);
  const short = await mossImageStatus(deps({ scan: async () => shelf.map((f, i) => i === 2 ? { ...f, bytes: 10 } : f) }));
  assert.deepEqual(short.missingFiles, [MOSS_IMAGE_FILES.vae]);
  const hiddenInfo = info(); hiddenInfo.UNETLoader = { input: { required: { unet_name: [[]] } } };
  assert.equal((await mossImageStatus(deps({ engine: { objectInfo: async () => hiddenInfo } }))).ready, false);
  const copies = [...shelf.slice(1), { ...shelf[0], name: "a/" + shelf[0].name }, { ...shelf[0], name: "b/" + shelf[0].name }];
  assert.equal((await mossImageStatus(deps({ scan: async () => copies }))).ready, false);
  const offline = await mossImageStatus(deps({ engine: { objectInfo: async () => { throw new Error("offline"); } } }));
  assert.equal(offline.ready, false); assert.equal(offline.runtimeReady, false); assert.match(offline.error, /offline/);
});
