import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { CATALOG } from "./models.js";
import { qwenImageStatus, stageQwenReferences } from "./qwen-status.js";
import { QWEN_IMAGE_FILES, qwenImageRequiredNodes } from "./qwen-image.js";
import { personaFits, applyPersona } from "./personas.js";

const cap = CATALOG.find((row) => row.id === "qwen-image-2.1");
const shelf = cap.files.map((file) => ({ name: path.basename(file.dest), folder: path.basename(path.dirname(file.dest)), bytes: file.bytes }));
const info = (options = {}) => Object.fromEntries(qwenImageRequiredNodes(options).map((name) => [name, {}]));
const deps = (options = {}, overrides = {}) => ({ options, config: {}, bases: async () => [], scan: async () => shelf, engine: { objectInfo: async () => info(options) }, ...overrides });

test("readiness requires all native files and the exact generation/edit graph nodes", async () => {
  const ready = await qwenImageStatus(deps());
  assert.equal(ready.ready, true);
  assert.equal(ready.totalBytes, 17283091112);
  const missing = await qwenImageStatus(deps({}, { scan: async () => shelf.slice(1) }));
  assert.equal(missing.filesReady, false);
  assert.deepEqual(missing.missingFiles, [QWEN_IMAGE_FILES.dit]);
  const truncated = await qwenImageStatus(deps({}, { scan: async () => shelf.map((file, i) => i === 1 ? { ...file, bytes: 3 } : file) }));
  assert.deepEqual(truncated.missingFiles, [QWEN_IMAGE_FILES.encoder]);
  const options = { refImages: ["one.png"], count: 2 };
  const old = info(options); delete old.TextEncodeQwenImage21;
  const unavailable = await qwenImageStatus(deps(options, { engine: { objectInfo: async () => old } }));
  assert.equal(unavailable.ready, false);
  assert.equal(unavailable.filesReady, true);
  assert.deepEqual(unavailable.missingNodes, ["TextEncodeQwenImage21"]);
});

test("offline runtime fails closed; custom files replace stock requirements without accepting GGUF", async () => {
  const offline = await qwenImageStatus(deps({}, { engine: { objectInfo: async () => { throw new Error("offline"); } } }));
  assert.equal(offline.ready, false); assert.equal(offline.runtimeReady, false);
  assert.deepEqual(offline.missingNodes, [], "offline is not evidence that an update is required");
  assert.match(offline.error, /offline/);
  const custom = { dit: "other.safetensors" };
  const usable = await qwenImageStatus(deps(custom, { scan: async () => [{ name: custom.dit, folder: "unet", bytes: 400 }, ...shelf.slice(1)] }));
  assert.equal(usable.ready, true);
  const bad = await qwenImageStatus(deps({ dit: "qwen-image-2.1-Q8_0.gguf" }));
  assert.equal(bad.ready, false); assert.match(bad.error, /native.*safetensors/);
  const notExposed = info();
  notExposed.UNETLoader = { input: { required: { unet_name: [[]] } } };
  const hidden = await qwenImageStatus(deps({}, { engine: { objectInfo: async () => notExposed } }));
  assert.equal(hidden.ready, false); assert.deepEqual(hidden.missingFiles, [QWEN_IMAGE_FILES.dit]);
});

test("changing the download folder keeps Qwen files in remembered folders ready", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qwen-old-shelf-"));
  const previous = path.join(root, "previous");
  const options = { dit: "custom-qwen.safetensors", encoder: "custom-encoder.safetensors", vae: "custom-vae.safetensors" };
  const config = { modelsDir: path.join(root, "new"), modelsAlso: [previous], comfyDir: path.join(root, "comfy"), comfy: { extraArgs: [] } };
  try {
    for (const [folder, name] of [["diffusion_models", options.dit], ["text_encoders", options.encoder], ["vae", options.vae]]) {
      await mkdir(path.join(previous, folder), { recursive: true });
      await writeFile(path.join(previous, folder, name), "fixture");
    }
    const engine = { objectInfo: async () => info() };
    const ready = await qwenImageStatus({ options, config, engine });
    assert.equal(ready.ready, true, ready.error);
    const forgotten = await qwenImageStatus({ options, config: { ...config, modelsAlso: [] }, engine });
    assert.equal(forgotten.filesReady, false);
    assert.deepEqual(forgotten.missingFiles, Object.values(options));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reference staging validates the whole ordered set, including uploaded files and combined persona refs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qwen-stage-"));
  const dirs = { inputDir: path.join(root, "input"), coverDir: path.join(root, "covers"), imageDir: path.join(root, "images") };
  try {
    for (const dir of Object.values(dirs)) await mkdir(dir);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
    const jpg = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]);
    await writeFile(path.join(dirs.imageDir, "subject.png"), png);
    await writeFile(path.join(dirs.coverDir, "scene.jpg"), jpg);
    await writeFile(path.join(dirs.imageDir, "invalid.png"), "not an image");
    const persona = { name: "Alex", fragment: "same outfit", refImages: ["subject.png"] };
    assert.equal(personaFits("qwen-image-2.1").fit, "yes");
    const names = applyPersona(persona, { prompt: "on a beach", refImages: ["scene.jpg"] }).refImages;
    const staged = await stageQwenReferences(names, dirs);
    assert.deepEqual(await readFile(path.join(dirs.inputDir, staged[0])), png);
    assert.deepEqual(await readFile(path.join(dirs.inputDir, staged[1])), jpg);
    assert.deepEqual(await stageQwenReferences(staged, dirs), staged);
    for (const refs of [["subject.png", "missing.png"], ["invalid.png"], ["aiplay_frame_123456789abc.png"], ["../subject.png"], [null], ["subject.exe"], Array(11).fill("subject.png")]) {
      await assert.rejects(stageQwenReferences(refs, dirs));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

/* The Images screen asks this route with `refs` as a BUCKET — "none" or "some"
 * — and caches the answer under that key, so it does not re-check every time a
 * picture is dragged in or taken out. That is only sound while the answer is
 * the same for one reference as for ten. It is the node list that decides, and
 * references add their loading nodes once; the second one adds nothing new. If
 * a future graph gives, say, the fourth reference a node of its own, this test
 * fails and web/app.js imgQwenQuery() has to send the real count again. */
test("readiness depends on whether there are references, not how many", () => {
  const list = (n) => qwenImageRequiredNodes({
    refImages: Array.from({ length: n }, (_, i) => `reference-${i + 1}.png`),
  }).slice().sort().join(",");
  const some = list(1);
  for (const n of [2, 3, 5, 10]) assert.equal(list(n), some, `${n} references need the same nodes as one`);
  assert.notEqual(list(0), some, "no references is a different graph, and is the one key that must differ");
});

/** A real 2x1 PNG. The tEXt chunk stands in for the workflow ComfyUI writes
 * ahead of the pixels, so a tRNS chunk sits behind a few KB of metadata. */
function png(colorType, trns = null) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); out.write(type, 4, "ascii"); data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = colorType;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
    chunk("tEXt", Buffer.from(`workflow\0${"{}".repeat(2000)}`)),
    ...(colorType === 3 ? [chunk("PLTE", Buffer.from([90, 30, 200]))] : []),
    ...(trns ? [chunk("tRNS", trns)] : []),
    chunk("IDAT", deflateSync(Buffer.alloc(1 + 2 * channels))), chunk("IEND", Buffer.alloc(0))]);
}

test("without transparency every reference that can carry alpha is flattened; the rest stage byte-exact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qwen-flat-"));
  const dirs = { inputDir: path.join(root, "input"), coverDir: path.join(root, "covers"), imageDir: path.join(root, "images") };
  try {
    for (const dir of Object.values(dirs)) await mkdir(dir);
    const files = {
      "cut.png": [dirs.imageDir, png(6)],
      "gray-alpha.png": [dirs.imageDir, png(4)],
      "keyed.png": [dirs.imageDir, png(2, Buffer.alloc(6))],
      "palette.png": [dirs.coverDir, png(3, Buffer.from([0]))],
      "photo.png": [dirs.imageDir, png(2)],
      "gray.png": [dirs.imageDir, png(0)],
      "indexed.png": [dirs.imageDir, png(3)],
      "scene.jpg": [dirs.coverDir, Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70])],
      "art.webp": [dirs.imageDir, Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8X"), Buffer.alloc(10)])],
      "aiplay_frame_0123456789ab.png": [dirs.inputDir, png(6)],
    };
    for (const [name, [dir, bytes]] of Object.entries(files)) await writeFile(path.join(dir, name), bytes);
    const names = Object.keys(files);
    const handed = [];
    // The contract flatten_references keeps: its own name when opaque after
    // all, which the grey+alpha fixture stands for here.
    const flatten = async (references) => {
      handed.push(...references);
      return Promise.all(references.map(async ({ name, candidates, out }) => {
        if ((await readFile(candidates[0]))[25] === 4) return name;
        await writeFile(out, png(2));
        return path.basename(out);
      }));
    };
    const staged = await stageQwenReferences(names, { ...dirs, flatten });
    const withAlpha = ["cut.png", "gray-alpha.png", "keyed.png", "palette.png", "art.webp", "aiplay_frame_0123456789ab.png"];
    assert.deepEqual(handed.map((row) => row.name), withAlpha, "a JPEG and PNGs with no alpha channel or tRNS never pay for python");
    for (const row of handed) {
      assert.deepEqual(row.candidates, [path.join(files[row.name][0], row.name)]);
      assert.equal(path.dirname(row.out), dirs.inputDir);
      assert.match(path.basename(row.out), /^aiplay_frame_[0-9a-f]{12}\.png$/);
    }
    const flattened = new Map(handed.filter((row) => row.name !== "gray-alpha.png").map((row) => [row.name, path.basename(row.out)]));
    const plain = await stageQwenReferences(names, dirs);
    assert.equal(handed.length, withAlpha.length, "transparent staging never flattens");
    assert.equal(plain.at(-1), "aiplay_frame_0123456789ab.png");
    for (const [i, name] of names.entries()) {
      assert.deepEqual(await readFile(path.join(dirs.inputDir, plain[i])), files[name][1], `${name} stages raw for a transparent request`);
      if (flattened.has(name)) {
        assert.equal(staged[i], flattened.get(name));
        assert.notEqual(staged[i], plain[i], `${name}: a transparent request must not overwrite the flattened copy`);
        assert.deepEqual(await readFile(path.join(dirs.inputDir, staged[i])), png(2));
      } else assert.equal(staged[i], plain[i], `${name} stages exactly as before`);
    }
    assert.deepEqual(await stageQwenReferences(names, { ...dirs, flatten }), staged, "the same source flattens to the same name");
    const again = handed.length;
    assert.deepEqual(await stageQwenReferences(staged, { ...dirs, flatten }), staged, "a flattened picture is opaque");
    assert.equal(handed.length, again + 1, "only the reference that stayed as it was is asked about again");
    await assert.rejects(stageQwenReferences(["cut.png"], { ...dirs, flatten: async () => { throw new Error("python is gone"); } }), /python is gone/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
