/** Future completion events, with no image generation, server or runtime. */
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temp = await mkdtemp(path.join(os.tmpdir(), "moss-provenance-"));
process.env.AIPLAY_APPDATA = path.join(temp, "settings");
process.env.AIPLAY_RIG = path.join(temp, "rig");
process.env.AIPLAY_MODELS_DIR = path.join(temp, "models");
const { mossGenerationProvenance } = await import("./moss-provenance.js");
const { mossImageGraph, mossImageSettings } = await import("./moss-image.js");
const { MOSS_HIRES_ADAPTER, mossRecipeIdentity } = await import("./moss-presets.js");
const { append, read, foldOrigin } = await import("./provenance.js");
const { rightsStampFor } = await import("./models.js");
after(async () => { await rm(temp, { recursive: true, force: true }); });

const source = await readFile(new URL("./index.js", import.meta.url), "utf8");
const eventStart = source.indexOf('art.on("cover", ({ file, covers, seed, imageOptions, durationMs, engine, checkpoint, runId })');
const eventEnd = source.indexOf("/* A queued friend image is an errand", eventStart);
assert.ok(eventStart > 0 && eventEnd > eventStart);
function complete(engine, imageOptions, { privateImage = false } = {}) {
  const file = "image:fixture", ledger = [], art = new EventEmitter();
  const deps = { art, imageMeta: new Map(), ledger, mossGenerationProvenance,
    pendingImagePrompt: new Map([[file, "private words stay out"]]), pendingImageActor: new Map([[file, "agent:test"]]),
    pendingImageWild: new Map(), pendingImagePrivate: new Map([[file, privateImage]]),
    prov: { sha256hex: () => "fixture-prompt-hash" }, provNote: (_, event) => ledger.push(event),
    saveImageStore() {}, push() {}, jobs: { snapshot: () => ({}) } };
  new Function("deps", `const {${Object.keys(deps).join(",")}}=deps; ${source.slice(eventStart, eventEnd)}`)(deps);
  art.emit("cover", { file, covers: ["fixture.png"], seed: 31, imageOptions, durationMs: 20, engine, checkpoint: null, runId: "fixture-run" });
  assert.equal(ledger.length, 1);
  return { event: ledger[0], meta: deps.imageMeta.get("fixture.png") };
}
function hiresOptions() {
  return { ...mossImageSettings(mossImageGraph({ prompt: "harbor", width: 2048, height: 2048, mossPreset: "moss-hires-v03" })),
    adapterVerifiedSha256: MOSS_HIRES_ADAPTER.sha256 };
}

test("the actual completion seam records the HiRes adapter and its combined unknown rights", async () => {
  const options = hiresOptions(), { event, meta } = complete("moss-image", options);
  assert.equal(event.data.model, "moss-image");
  assert.equal(event.data.mossPreset, "moss-hires-v03");
  assert.equal(event.data.mossRecipe, mossRecipeIdentity("moss-hires-v03"));
  for (const field of ["repo", "revision", "filename", "sha256", "strength"]) assert.equal(event.data.adapter[field], options.adapter[field]);
  assert.equal(event.data.adapterVerifiedSha256, MOSS_HIRES_ADAPTER.sha256);
  assert.equal(event.data.outputRights.class, "unknown");
  assert.equal(event.data.outputRights.capability, "moss-image-hires-v03");
  assert.deepEqual(event.data.outputRights.addOns, ["moss-image-hires-v03"]);
  assert.ok(event.data.outputRights.url.includes(MOSS_HIRES_ADAPTER.revision));
  assert.equal(meta.mossPreset, event.data.mossPreset);
  const scope = { dir: path.join(temp, "future") };
  const saved = await append(scope, event);
  assert.deepEqual(saved.data.outputRights, event.data.outputRights);
  assert.equal(foldOrigin((await read(scope, { asset: event.asset })).events).outputRights.class, "unknown");
});

test("other MOSS recipes and other engines retain their existing event shape and model stamp", async () => {
  for (const preset of ["standard", "kromoss-standard", "kromoss-dmd2-8", "turbo-4", "dmd-8"]) {
    const options = mossImageSettings(mossImageGraph({ prompt: "harbor", mossPreset: preset }));
    assert.deepEqual(mossGenerationProvenance("moss-image", options), {});
    const { event } = complete("moss-image", options);
    assert.equal(event.data.mossPreset, undefined);
    assert.equal(event.data.outputRights, undefined);
    const saved = await append({ dir: path.join(temp, preset) }, event);
    assert.deepEqual(saved.data.outputRights, rightsStampFor("moss-image"));
  }
  assert.deepEqual(mossGenerationProvenance("qwen-image-2.1", hiresOptions()), {});
  assert.deepEqual(mossGenerationProvenance("moss-image", { adapter: { filename: "unknown-moss-hires.safetensors" } }), {});
});

test("incomplete or inconsistent HiRes completion metadata never inherits unrestricted base rights", () => {
  for (const options of [{ mossPreset: "moss-hires-v03" },
    { mossPreset: "standard", adapter: { filename: MOSS_HIRES_ADAPTER.filename, sha256: "unexpected" } },
    { ...hiresOptions(), adapterVerifiedSha256: "unexpected" }]) {
    const record = mossGenerationProvenance("moss-image", options);
    assert.equal(record.outputRights.class, "unknown");
    assert.equal(record.mossRecipe, options.mossRecipe ?? null);
    assert.equal(record.adapterVerifiedSha256, options.adapterVerifiedSha256 ?? null);
  }
  const minimal = mossGenerationProvenance("moss-image", { mossPreset: "moss-hires-v03" });
  assert.equal(minimal.adapter, null);
  assert.equal(minimal.adapterVerifiedSha256, null, "missing verification is never invented");
});

test("private HiRes generation adds only pin metadata and preserves existing redaction", async () => {
  const options = hiresOptions(); options.adapter.prompt = "never copy this field";
  const { event, meta } = complete("moss-image", options, { privateImage: true });
  assert.equal(event.private, true); assert.equal(event.data.promptHash, null);
  assert.equal(event.data.adapter.prompt, undefined); assert.equal(meta.prompt, undefined);
  assert.equal(meta.promptRedacted, true);
  const saved = await append({ dir: path.join(temp, "private") }, event);
  assert.equal(saved.data.outputRights.class, "unknown");
  assert.equal(JSON.stringify(saved).includes("private words stay out"), false);
  assert.equal(JSON.stringify(saved).includes("never copy this field"), false);
});

test("old rows and caller supplied historical stamps are not rewritten", async () => {
  const old = { type: "generate", actor: "system", asset: "images/old.png", t: "2026-01-01T00:00:00Z", data: { model: "moss-image" } };
  const before = JSON.stringify(old);
  assert.equal(foldOrigin([old]).outputRights, null);
  assert.equal(JSON.stringify(old), before);
  const stamp = { class: "not-for-sale", capability: null, url: "https://example.invalid/historical" };
  const saved = await append({ dir: path.join(temp, "historical") }, { ...old, data: { ...old.data, outputRights: stamp } });
  assert.deepEqual(saved.data.outputRights, stamp);
});
