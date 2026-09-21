import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
