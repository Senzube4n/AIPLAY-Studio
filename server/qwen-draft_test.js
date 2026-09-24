/**
 * FAST DRAFT for Qwen Image 2.1 — the graph, its schedule, its readiness, its
 * clock and the page's chip. No engine, no GPU, no weights.
 *
 * The draft is Viggle's 5-step turbo LoRA through the stock
 * LoraLoaderModelOnly, sampled by SamplerCustomAdvanced on ManualSigmas — arm C
 * of the 2026-09-24 A/B, the wiring the owner approved. What this lane holds:
 *   - the ONE sigma helper reproduces the three schedules the A/B ran, exactly;
 *   - the graph is the measured one (nodes, ids, LoRA at 1.0, euler, CFG 1 with
 *     no negative), every edge typed, references on the base's own edit path;
 *   - every base-only case is refused with its sentence, never ignored, a
 *     canvas past the measured ~2 MP (8,192 tokens) among them;
 *   - readiness answers for the LoRA on every check and requires it for a draft;
 *   - the estimate says ~3 s only after a draft of the same words;
 *   - the page offers the chip only on Qwen with the LoRA on disk, greys it
 *     with the reason, and its cases and numbers match the server's.
 * The route's refusals are in qwen-api_test.js (the handler, sliced), the
 * runner's provenance in qwen-cover_test.js, the engine door in
 * safety/doors_test.js.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {
  qwenImageGraph, qwenImageSettings, qwenImageRequiredNodes, qwenDraftSigmas, qwenDraftSigmaText,
  qwenDraftRefusal, qwenDraftTokens, QWEN_DRAFT, QWEN_DRAFT_NODES, QWEN_IMAGE_FILES, QWEN_IMAGE_NODES,
} from "./qwen-image.js";
import { qwenImageStatus } from "./qwen-status.js";
import { imageCostSeconds, imageDeadlineMs, qwenRenderKey, QWEN_DRAFT_SECONDS } from "./art.js";
import { CATALOG } from "./models.js";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/* ── the schedule ─────────────────────────────────────────────────────────── */

test("the one sigma helper reproduces the three schedules the A/B rendered, digit for digit", () => {
  const measured = {
    "1024x1024": [1.0, 0.9334, 0.8572, 0.6668, 0.4001, 0],
    "1344x768": [1.0, 0.9332, 0.8568, 0.6660, 0.3993, 0],
    "1920x1088": [1.0, 0.9450, 0.8805, 0.7106, 0.4501, 0],
  };
  for (const [size, want] of Object.entries(measured)) {
    const [w, h] = size.split("x").map(Number);
    assert.deepEqual(qwenDraftSigmas(w, h), want, size);
  }
  assert.equal(qwenDraftSigmaText(qwenDraftSigmas(1024, 1024)), "1.0, 0.9334, 0.8572, 0.6668, 0.4001, 0");
  // Portrait and landscape of one area share a schedule: it is the token count.
  assert.deepEqual(qwenDraftSigmas(768, 1344), qwenDraftSigmas(1344, 768));
});

test("the shift generalises inside the measured range: five steps, 1 first, 0 last, falling, larger canvases shifted later", () => {
  let previous = null;
  for (const [w, h] of [[512, 512], [768, 768], [1024, 1024], [1536, 1024], [1920, 1088], [2048, 1024]]) {
    const s = qwenDraftSigmas(w, h);
    assert.equal(s.length, QWEN_DRAFT.steps + 1);
    assert.equal(s[0], 1); assert.equal(s.at(-1), 0, "shift_terminal off: the last step goes to zero");
    for (let i = 1; i < s.length; i++) assert.ok(s[i] < s[i - 1], `${w}x${h} falls at ${i}`);
    if (previous) assert.ok(s[4] >= previous[4], "more tokens, more shift");
    // Sane: the last jump to 0 never starts above the largest canvas measured (0.4501 at 1920x1088).
    assert.ok(s[4] <= 0.4501 + 0.002, `${w}x${h} last sigma ${s[4]}`);
    previous = s;
  }
  for (const bad of [[0, 1024], [NaN, 1024], [1024, -1]]) assert.throws(() => qwenDraftSigmas(...bad));
  /* Past 8,192 tokens the formula extrapolates (4096² would end 0.9365 -> 0,
   * one step removing ~94% of the noise): refused, never guessed at. */
  assert.equal(qwenDraftTokens(1920, 1088), 8160, "the largest canvas the A/B rendered");
  assert.equal(qwenDraftTokens(2048, 1024), QWEN_DRAFT.maxTokens, "the edge of the formula's range");
  for (const [w, h] of [[2048, 2048], [3072, 3072], [4096, 4096], [2080, 1024], [1472, 1472]]) {
    assert.throws(() => qwenDraftSigmas(w, h), (err) => err.message === QWEN_DRAFT.refusals.size, `${w}x${h}`);
  }
  assert.doesNotThrow(() => qwenDraftSigmas(1440, 1440), "a reference size of 1440 is the largest square");
});

/* ── the graph ────────────────────────────────────────────────────────────── */

const contracts = {
  UNETLoader: { in: { unet_name: "STRING", weight_dtype: "STRING" }, out: ["MODEL"] },
  CLIPLoader: { in: { clip_name: "STRING", type: "STRING", device: "STRING" }, out: ["CLIP"] },
  VAELoader: { in: { vae_name: "STRING" }, out: ["VAE"] },
  TextEncodeQwenImage21: { in: { clip: "CLIP", prompt: "STRING", negative_prompt: "STRING", resolution: "INT" }, optional: { vae: "VAE" }, out: ["CONDITIONING", "CONDITIONING", "LATENT"] },
  EmptyLatentImage: { in: { width: "INT", height: "INT", batch_size: "INT" }, out: ["LATENT"] },
  RepeatLatentBatch: { in: { samples: "LATENT", amount: "INT" }, out: ["LATENT"] },
  LoraLoaderModelOnly: { in: { model: "MODEL", lora_name: "STRING", strength_model: "FLOAT" }, out: ["MODEL"] },
  BasicGuider: { in: { model: "MODEL", conditioning: "CONDITIONING" }, out: ["GUIDER"] },
  KSamplerSelect: { in: { sampler_name: "STRING" }, out: ["SAMPLER"] },
  RandomNoise: { in: { noise_seed: "INT" }, out: ["NOISE"] },
  ManualSigmas: { in: { sigmas: "STRING" }, out: ["SIGMAS"] },
  SamplerCustomAdvanced: { in: { noise: "NOISE", guider: "GUIDER", sampler: "SAMPLER", sigmas: "SIGMAS", latent_image: "LATENT" }, out: ["LATENT", "LATENT"] },
  VAEDecode: { in: { samples: "LATENT", vae: "VAE" }, out: ["IMAGE"] },
  SaveImage: { in: { images: "IMAGE", filename_prefix: "STRING" }, out: [] },
  ImageScale: { in: { image: "IMAGE", upscale_method: "STRING", width: "INT", height: "INT", crop: "STRING" }, out: ["IMAGE"] },
  LoadImage: { in: { image: "STRING" }, out: ["IMAGE", "MASK"] },
  JoinImageWithAlpha: { in: { image: "IMAGE", alpha: "MASK" }, out: ["IMAGE"] },
};
function validateGraph(graph) {
  for (const [id, node] of Object.entries(graph)) {
    const schema = contracts[node.class_type];
    assert.ok(schema, `unknown node ${node.class_type}`);
    for (const key of Object.keys(schema.in)) assert.ok(key in node.inputs, `${id}.${key} missing`);
    for (const [name, value] of Object.entries(node.inputs)) {
      const type = schema.in[name] || schema.optional?.[name]
        || (node.class_type === "TextEncodeQwenImage21" && /^images\.image_\d+$/.test(name) ? "IMAGE" : null);
      assert.ok(type, `${id}.${name} is not an input of ${node.class_type}`);
      if (Array.isArray(value)) {
        const source = graph[value[0]];
        assert.ok(source, `${id}.${name} source missing`);
        assert.equal(contracts[source.class_type].out[value[1]], type, `${id}.${name} type mismatch`);
      } else if (type === "STRING") assert.equal(typeof value, "string");
      else if (type === "INT") assert.ok(Number.isSafeInteger(value), `${id}.${name} must be an integer`);
      else if (type === "FLOAT") assert.ok(Number.isFinite(value));
      else assert.fail(`${id}.${name} requires a linked ${type}`);
    }
  }
}

test("a draft is the measured graph: the LoRA at 1.0, the custom sampler at node 8, CFG 1 with no negative", () => {
  const graph = qwenImageGraph({ prompt: "a lighthouse at dusk", seed: 101, draft: true });
  validateGraph(graph);
  assert.deepEqual(graph[5], { class_type: "LoraLoaderModelOnly",
    inputs: { model: ["1", 0], lora_name: QWEN_DRAFT.lora, strength_model: 1 } });
  assert.deepEqual(graph[80].inputs, { model: ["5", 0], conditioning: ["4", 0] }, "BasicGuider: positive only, through the LoRA");
  assert.deepEqual(graph[81].inputs, { sampler_name: "euler" });
  assert.deepEqual(graph[82].inputs, { noise_seed: 101 });
  assert.equal(graph[83].inputs.sigmas, "1.0, 0.9334, 0.8572, 0.6668, 0.4001, 0");
  assert.equal(graph[8].class_type, "SamplerCustomAdvanced");
  assert.deepEqual(graph[8].inputs, { noise: ["82", 0], guider: ["80", 0], sampler: ["81", 0], sigmas: ["83", 0], latent_image: ["7", 0] });
  assert.ok(!Object.values(graph).some((n) => n.class_type === "KSampler"), "no KSampler left behind");
  assert.ok(!Object.values(graph).some((n) => n.class_type === "ModelSamplingAuraFlow"), "the base has none, and ManualSigmas carries shifted values");
  assert.ok(!JSON.stringify(graph).includes('["4",1]'), "the negative output is wired to nothing");
  assert.equal(graph[4].inputs.negative_prompt, "");
  // Everything downstream of the sampler is the base's, unchanged.
  const base = qwenImageGraph({ prompt: "a lighthouse at dusk", seed: 101 });
  for (const id of ["1", "2", "3", "4", "7", "17", QWEN_IMAGE_NODES.full, "14", QWEN_IMAGE_NODES.thumb]) {
    assert.deepEqual(graph[id], base[id], `node ${id} is the base's`);
  }
  assert.equal(graph[1].inputs.unet_name, QWEN_IMAGE_FILES.dit);
  assert.deepEqual(qwenImageSettings(graph), { draft: true, steps: 5, cfg: 1, sampler: "euler",
    sigmas: "1.0, 0.9334, 0.8572, 0.6668, 0.4001, 0", lora: QWEN_DRAFT.lora, loraStrength: 1 });
  assert.deepEqual(qwenImageSettings(base), { draft: false, steps: 25, cfg: 1, sampler: "euler", scheduler: "simple" });
});

test("the canvas that sets the schedule is the latent sampled: the size asked for, or the reference's", () => {
  const wide = qwenImageGraph({ prompt: "x", width: 1344, height: 768, count: 4, draft: true });
  validateGraph(wide);
  assert.deepEqual(wide[7].inputs, { width: 1344, height: 768, batch_size: 4 });
  assert.equal(wide[83].inputs.sigmas, "1.0, 0.9332, 0.8568, 0.6660, 0.3993, 0");
  // References: the base's own edit path, the first reference's geometry.
  const edit = qwenImageGraph({ prompt: "keep the person, rainy street", refImages: ["a.png", "b.png"], count: 2, draft: true });
  validateGraph(edit);
  assert.deepEqual(edit[7], { class_type: "RepeatLatentBatch", inputs: { samples: ["4", 2], amount: 2 } });
  assert.deepEqual(edit[8].inputs.latent_image, ["7", 0]);
  assert.deepEqual(edit[4].inputs.vae, ["3", 0]);
  assert.equal(edit[83].inputs.sigmas, qwenDraftSigmaText(qwenDraftSigmas(1024, 1024)), "sized to refResolution²");
  /* An approximation, said as one: the A/B sized its one-reference edits (R1,
   * R3) from the real 1344x768 reference latent. The gap is at most 8e-4. */
  const lab = [1.0, 0.9332, 0.8568, 0.6660, 0.3993, 0];
  const studio = edit[83].inputs.sigmas.split(", ").map(Number);
  assert.ok(studio.every((s, i) => Math.abs(s - lab[i]) <= 8e-4 + 1e-9), `${studio} within 8e-4 of ${lab}`);
  assert.match(read("./qwen-image.js"), /differs from those by at most 8e-4/, "the code says it is an approximation");
  const base = qwenImageGraph({ prompt: "keep the person, rainy street", refImages: ["a.png", "b.png"], count: 2 });
  for (const id of ["40", "41", "42", "43", "4"]) assert.deepEqual(edit[id], base[id], `reference node ${id} is the base's`);
  const custom = qwenImageGraph({ prompt: "x", refImages: ["a.png"], refSizing: "custom", width: 1920, height: 1088, draft: true });
  assert.equal(custom[83].inputs.sigmas, "1.0, 0.9450, 0.8805, 0.7106, 0.4501, 0");
  const bigRef = qwenImageGraph({ prompt: "x", refImages: ["a.png"], refResolution: 1440, draft: true });
  assert.equal(bigRef[83].inputs.sigmas, qwenDraftSigmaText(qwenDraftSigmas(1440, 1440)));
  assert.throws(() => qwenImageGraph({ prompt: "x", refImages: ["a.png"], refResolution: 1536, draft: true }),
    (err) => err.message === QWEN_DRAFT.refusals.size, "a reference size past 1440 is past the measured range");
});

test("readiness asks for exactly the draft's stock nodes, and only for a draft", () => {
  const draft = qwenImageRequiredNodes({ draft: true });
  for (const name of QWEN_DRAFT_NODES) assert.ok(draft.includes(name), name);
  assert.ok(!draft.includes("KSampler"));
  const base = qwenImageRequiredNodes();
  for (const name of QWEN_DRAFT_NODES) assert.ok(!base.includes(name), `${name} is not asked of a full render`);
});

test("every base-only case is refused with its own sentence, never ignored", () => {
  const R = QWEN_DRAFT.refusals;
  const cases = [
    [{ transparent: true }, R.transparent],
    [{ refImages: ["1.png", "2.png", "3.png", "4.png"] }, R.refs],
    [{ cfg: 2 }, R.cfg],
    [{ negative: "blur" }, R.negative],
    [{ negative: "blur", cfg: 1 }, R.negative],
    [{ steps: 25 }, R.steps],
    [{ steps: 4 }, R.steps],
    [{ refImages: ["a.png"], refResolution: 0 }, R.refSize],
    [{ width: 2048, height: 2048 }, R.size],
    [{ width: 4096, height: 4096 }, R.size],
    [{ width: 2080, height: 1024 }, R.size],
    [{ refImages: ["a.png"], refResolution: 1536 }, R.size],
    [{ refImages: ["a.png"], refSizing: "custom", width: 2048, height: 2048 }, R.size],
  ];
  for (const [opts, sentence] of cases) {
    assert.throws(() => qwenImageGraph({ prompt: "x", draft: true, ...opts }), (err) => err.message === sentence, JSON.stringify(opts));
    assert.equal(qwenDraftRefusal(opts), sentence);
  }
  assert.throws(() => qwenImageGraph({ prompt: "x", draft: "yes" }), (err) => err.message === R.type);
  assert.throws(() => qwenImageGraph({ prompt: "x", draft: true, draftLora: "../x.safetensors" }), /not a path/);
  // What a draft may carry: three references, CFG 1, steps 5, custom sizing,
  // up to 8,192 tokens, and a null reference size (the base's own 1024).
  for (const ok of [{ refImages: ["1.png", "2.png", "3.png"] }, { cfg: 1 }, { steps: 5 }, { refImages: ["a.png"], refSizing: "custom", refResolution: 0 }, { count: 4 },
    { width: 1920, height: 1088 }, { width: 2048, height: 1024 }, { refImages: ["a.png"], refResolution: 1440 },
    { refImages: ["a.png"], refResolution: null }, { refImages: ["a.png"], width: 4096, height: 4096 }]) {
    assert.doesNotThrow(() => qwenImageGraph({ prompt: "x", draft: true, ...ok }), JSON.stringify(ok));
    assert.equal(qwenDraftRefusal(ok), null, JSON.stringify(ok));
  }
  const nullRef = qwenImageGraph({ prompt: "x", draft: true, refImages: ["a.png"], refResolution: null });
  assert.equal(nullRef[4].inputs.resolution, 1024, "null follows the base's 1024, as the full render does");
  // And the same cases on a full render are untouched.
  assert.doesNotThrow(() => qwenImageGraph({ prompt: "x", transparent: true, refImages: Array(10).fill("r.png"), cfg: 3, negative: "blur", steps: 40 }));
  for (const sentence of Object.values(R)) assert.match(sentence, /\.$/, "a sentence");
});

/* ── readiness ────────────────────────────────────────────────────────────── */

const qwenCap = CATALOG.find((row) => row.id === "qwen-image-2.1");
const draftCap = CATALOG.find((row) => row.id === QWEN_DRAFT.capability);
const baseShelf = qwenCap.files.map((f) => ({ name: path.basename(f.dest), folder: path.basename(path.dirname(f.dest)), bytes: f.bytes }));
const loraRow = { name: QWEN_DRAFT.lora, folder: "loras", bytes: QWEN_DRAFT.bytes };
const infoFor = (...options) => Object.fromEntries(options.flatMap((o) => qwenImageRequiredNodes(o)).map((name) => [name, {}]));
const status = (options, { shelf = [...baseShelf, loraRow], info = infoFor({}, { draft: true }) } = {}) =>
  qwenImageStatus({ options, config: {}, bases: async () => [], scan: async () => shelf, engine: { objectInfo: async () => info } });

test("every readiness answer says whether a draft can run, and a draft requires its LoRA", async () => {
  const plain = await status({});
  assert.equal(plain.ready, true);
  assert.equal(plain.draft.ready, true);
  assert.equal(plain.draft.capability, "imageQwenFastDraft");
  assert.equal(plain.draft.bytes, 679_604_800);
  assert.deepEqual([plain.draft.steps, plain.draft.cfg, plain.draft.sampler, plain.draft.strength, plain.draft.maxRefs], [5, 1, "euler", 1, 3]);

  const noLora = await status({}, { shelf: baseShelf });
  assert.equal(noLora.ready, true, "a full render does not need the LoRA");
  assert.equal(noLora.draft.fileReady, false); assert.equal(noLora.draft.ready, false);
  const draftNoLora = await status({ draft: true }, { shelf: baseShelf });
  assert.equal(draftNoLora.ready, false);
  assert.deepEqual(draftNoLora.missingFiles, [QWEN_DRAFT.lora]);
  assert.match(draftNoLora.error, /Fast draft needs its LoRA .*0\.68 GB.*Download "Fast draft" in Models/);
  assert.doesNotMatch(draftNoLora.error, /Missing or incomplete Qwen Image files/, "the base files are all there");

  const truncated = await status({ draft: true }, { shelf: [...baseShelf, { ...loraRow, bytes: 1234 }] });
  assert.equal(truncated.ready, false, "a partial download is not the catalogue's file");
  const hiddenFromLoader = await status({ draft: true }, { info: { ...infoFor({ draft: true }), LoraLoaderModelOnly: { input: { required: { lora_name: [["other.safetensors"]] } } } } });
  assert.equal(hiddenFromLoader.draft.fileReady, false, "the loader's own list must name it");

  const oldRuntime = infoFor({}); // a ComfyUI without the custom-sampler nodes
  const old = await status({}, { info: oldRuntime });
  assert.equal(old.ready, true);
  assert.equal(old.draft.runtimeReady, false);
  assert.ok(old.draft.missingNodes.includes("ManualSigmas"));
  const oldDraft = await status({ draft: true }, { info: oldRuntime });
  assert.equal(oldDraft.ready, false); assert.ok(oldDraft.missingNodes.includes("SamplerCustomAdvanced"));

  const refused = await status({ draft: true, transparent: true });
  assert.equal(refused.ready, false); assert.equal(refused.error, QWEN_DRAFT.refusals.transparent);

  const overridden = await qwenImageStatus({ options: { draft: true }, config: { modelOverrides: { [QWEN_DRAFT.lora]: "my-turbo.safetensors" } },
    bases: async () => [], scan: async () => [...baseShelf, { name: "my-turbo.safetensors", folder: "loras", bytes: 5 }],
    engine: { objectInfo: async () => infoFor({}, { draft: true }) } });
  assert.equal(overridden.draft.lora, "my-turbo.safetensors");
  assert.equal(overridden.ready, true, "a stand-in chosen in Models is the one looked for");
});

/* ── the catalogue row ────────────────────────────────────────────────────── */

test("the catalogue row: pinned, the Qwen licence, an add-on to Qwen Image 2.1 and not a picture engine", () => {
  assert.ok(draftCap);
  assert.equal(draftCap.addonFor, "qwen-image-2.1");
  assert.ok(CATALOG.some((row) => row.id === draftCap.addonFor));
  assert.equal(draftCap.group, "images");
  assert.equal(draftCap.makes, undefined, "never offered as an engine of its own");
  assert.equal(draftCap.required, false);
  assert.match(draftCap.label, /^Images — Fast draft for Qwen Image 2\.1 \(Viggle turbo LoRA\)$/, "Images — like every sibling row");
  assert.equal(draftCap.files.length, 1);
  const [file] = draftCap.files;
  assert.equal(file.url, "https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo/resolve/2b85c1fcb7b2584c4133fe0c547ec968ff2ae20e/Qwen-Image-2.1-viggle-turbo-v0.2-5step-lora-r128.safetensors");
  assert.equal(file.bytes, 679_604_800);
  assert.equal(file.sha256, "7096a791d0f19cd083a8d2984b4524398d1d6bdd4e720c303ed17200df83ae2b");
  assert.equal(path.basename(path.dirname(file.dest)), "loras");
  assert.equal(path.basename(file.dest), QWEN_DRAFT.lora);
  assert.equal(file.bytes, QWEN_DRAFT.bytes);
  assert.match(draftCap.licence, /^Qwen Research License Agreement — /);
  assert.equal(draftCap.outputRights.class, qwenCap.outputRights.class, "no freer than the model it patches");
  assert.equal(draftCap.outputRights.sellable, false);
  assert.match(draftCap.outputRights.url, /Viggle\/Qwen-Image-2\.1-viggle-turbo\/blob\/[0-9a-f]{40}\/LICENSE$/);
  for (const measured of ["3.1 s", "11.2 s", "+8.8 s", "+2.5 s", "small text",
    "two-reference edit only 9.1 s against 20.8 s (2.3x)", "3 and 8 of 17 prompts", "above about 2 MP"]) assert.ok(draftCap.note.includes(measured), measured);
  assert.doesNotMatch(draftCap.note, /4 to 5 of 12/, "the final arm-C judging, not the partial arm-B tally");
  assert.match(draftCap.why, /two-reference style edits/);
  // The licence as the agreement words it: §3(c)'s notice for redistribution, §4(b)'s "Built with Qwen" for trained models.
  assert.match(draftCap.outputRights.clause, /§2\(a\)-\(b\)/, "cited as the base row cites it");
  assert.equal(draftCap.outputRights.clause.split(";")[0], qwenCap.outputRights.clause);
  assert.match(draftCap.outputRights.conditions.join(" "), /§3\(c\) Qwen copyright notice in a Notice file/);
  assert.match(draftCap.outputRights.conditions.join(" "), /"Built with Qwen" \(§4\(b\)\)/);
  assert.match(read("./models.js"), /addonFor: cap\.addonFor \|\| null,/, "status rows carry it");
});

/* ── the clock ────────────────────────────────────────────────────────────── */

test("the estimate: ~3 s only straight after a draft of the same words, ~12 s otherwise, cold when Qwen is not loaded", () => {
  const job = { engine: "qwen-image-2.1", draft: true, width: 1024, height: 1024, count: 1, key: "k1" };
  const near = (a, b) => Math.abs(a - b) < 0.35;
  assert.ok(near(imageCostSeconds(job, { previous: { draft: true, key: "k1" } }), 3.1), "warm, same prompt");
  assert.ok(near(imageCostSeconds(job, { previous: { draft: true, key: "k2" } }), 12.1), "a new prompt pays the encode");
  assert.ok(near(imageCostSeconds(job, { previous: { draft: false, key: "k1" } }), 12.1), "after a final: the re-patch");
  assert.ok(near(imageCostSeconds(job, { previous: null }), 37.1), "Qwen not loaded: the measured cold run");
  assert.ok(near(imageCostSeconds({ ...job, width: 1344, height: 768, count: 4 }, { previous: { draft: true, key: "k1" } }), 12.2), "batch of 4, measured 12.1 s");
  const final = { engine: "qwen-image-2.1", width: 1024, height: 1024, steps: 25 };
  assert.equal(imageCostSeconds(final, { previous: { draft: true, key: "k1" } }) - imageCostSeconds(final, { previous: { draft: false, key: "k1" } }),
    QWEN_DRAFT_SECONDS.finalAfterDrafts, "a final after drafts pays +2.5 s");
  assert.equal(imageCostSeconds(final), imageCostSeconds(final, { previous: null }), "a final with no context is costed as before");
  assert.equal(imageDeadlineMs(job, { previous: null }), 1_800_000, "Qwen's floor still holds for the deadline");
  assert.equal(qwenRenderKey({ prompt: "a" }), qwenRenderKey({ prompt: "a", refImages: [] }));
  assert.notEqual(qwenRenderKey({ prompt: "a" }), qwenRenderKey({ prompt: "b" }));
  assert.notEqual(qwenRenderKey({ prompt: "a" }), qwenRenderKey({ prompt: "a", refImages: ["r.png"] }));
});

/* ── the page ─────────────────────────────────────────────────────────────── */

const app = read("../web/app.js");
const html = read("../web/index.html");
const css = read("../web/ui.css");
const sliceStart = app.indexOf("function imgDraftSpec() {");
const sliceEnd = app.indexOf('$("imgDraft").onchange', sliceStart);
assert.ok(sliceStart > 0 && sliceEnd > sliceStart, "the chip's functions are where this lane reads them");

function page({ engine = "qwen-image-2.1", draftStatus = { fileReady: true, bytes: 679_604_800, capability: "imageQwenFastDraft", missingNodes: [] },
  refs = 0, persona = "", personaRefs = {}, transparent = false, cfg = "1", negative = "", steps = "25",
  size = "1024x1024", w = "1024", h = "1024", refSizing = "reference" } = {}) {
  const els = {};
  const el = (id, init = {}) => (els[id] ||= { id, hidden: false, checked: false, disabled: false, value: "", textContent: "", title: "",
    dataset: {}, classes: new Set(), classList: { toggle(c, on) { on ? this.owner.classes.add(c) : this.owner.classes.delete(c); } }, ...init });
  for (const e of Object.values({
    imgDraftRow: el("imgDraftRow", { hidden: true }), imgDraftChip: el("imgDraftChip"), imgDraft: el("imgDraft"),
    imgDraftGet: el("imgDraftGet", { hidden: true }), imgDraftNums: el("imgDraftNums", { hidden: true }), imgDraftWhy: el("imgDraftWhy", { hidden: true }),
    imgTransparent: el("imgTransparent", { checked: transparent }), imgPersona: el("imgPersona", { value: persona }),
    imgCfg: el("imgCfg", { value: cfg }), imgCfgV: el("imgCfgV"), imgNeg: el("imgNeg", { value: negative }),
    imgSteps: el("imgSteps", { value: steps }), imgStepsV: el("imgStepsV"),
    imgSize: el("imgSize", { value: size }), imgW: el("imgW", { value: w }), imgH: el("imgH", { value: h }),
    imgRefSizing: el("imgRefSizing", { value: refSizing }),
  })) e.classList.owner = e;
  const context = vm.createContext({
    $: (id) => els[id], imgRefs: Array.from({ length: refs }, (_, i) => ({ name: `r${i}.png` })),
    imgEffectiveEngine: () => engine, imgQwenStatus: draftStatus ? { draft: draftStatus } : null,
  });
  vm.runInContext(`${app.slice(sliceStart, sliceEnd)}
    imgPersonaRefCount = ${JSON.stringify(personaRefs)};
    globalThis.api = { imgDraftPaint, imgDraftOn, imgDraftSpec, imgDraftTokens, held: () => imgDraftHeld };`, context);
  return { els, api: context.api, tick: (on) => { els.imgDraft.checked = on; context.api.imgDraftPaint(); } };
}

test("the chip says its trade in its own words, visible without hovering", () => {
  /* The owner-approved label. A title tooltip never shows on a touch screen or
   * to someone who does not hover, so the caveat is on the chip itself. */
  assert.match(html, /id="imgDraft" type="checkbox"> Fast draft &middot; about 3&times; quicker &middot; may garble small text<\/label>/);
  const chip = html.slice(html.indexOf('id="imgDraftChip"'), html.indexOf("</label>", html.indexOf('id="imgDraftChip"')));
  assert.match(chip, /title="About 3&times; quicker in a run of drafts \(a new prompt is about 2&times;\); may garble small text and add extra faces or fingers\. For drafts, boards and ideas; not for finals, lettering or two-reference style edits\."/);
  const spec = page().api.imgDraftSpec();
  assert.equal(spec.tip, "About 3× quicker in a run of drafts (a new prompt is about 2×); may garble small text and add extra faces or fingers. "
    + "For drafts, boards and ideas; not for finals, lettering or two-reference style edits.", "the tooltip the page repaints is the markup's");
  assert.match(html, /id="imgDraftNums"[^>]*>Fast draft: turbo LoRA 1\.0 &middot; 5 steps on its own schedule &middot; euler &middot; CFG 1 &middot; measured up to 1920 &times; 1088<\/span>/,
    "the Advanced numbers say '5 steps' once, and the measured limit");
});

test("the chip shows only on Qwen Image 2.1 with its LoRA on disk; otherwise 'Get Fast draft (0.68 GB)'", () => {
  const ready = page();
  ready.api.imgDraftPaint();
  assert.equal(ready.els.imgDraftRow.hidden, false);
  assert.equal(ready.els.imgDraftChip.hidden, false);
  assert.equal(ready.els.imgDraftGet.hidden, true);
  assert.equal(ready.els.imgDraftChip.title, ready.api.imgDraftSpec().tip);
  assert.equal(ready.els.imgDraftWhy.hidden, true, "nothing to say about an offered, unticked chip");
  assert.equal(ready.api.imgDraftOn(), false, "off until ticked: the full render is the default");

  const missing = page({ draftStatus: { fileReady: false, bytes: 679_604_800, capability: "imageQwenFastDraft", missingNodes: [] } });
  missing.tick(true);
  assert.equal(missing.els.imgDraftRow.hidden, false);
  assert.equal(missing.els.imgDraftChip.hidden, true);
  assert.equal(missing.els.imgDraftGet.hidden, false);
  assert.equal(missing.els.imgDraftGet.textContent, "Get Fast draft (0.68 GB)");
  assert.equal(missing.api.imgDraftOn(), false, "a ticked box without its LoRA is not a draft");

  for (const engine of ["flux2", "zimage", "checkpoint"]) {
    const other = page({ engine });
    other.tick(true);
    assert.equal(other.els.imgDraftRow.hidden, true, engine);
    assert.equal(other.api.imgDraftOn(), false, engine);
    assert.equal(other.els.imgDraftNums.hidden, true, "no numbers for a chip that is not there");
  }
  const unknown = page({ draftStatus: null });
  unknown.api.imgDraftPaint();
  assert.equal(unknown.els.imgDraftRow.hidden, true, "nothing is promised before the first readiness answer");
});

test("a LoRA on disk under a ComfyUI without the draft's nodes greys the chip with that reason", () => {
  const old = page({ draftStatus: { fileReady: true, bytes: 679_604_800, capability: "imageQwenFastDraft", missingNodes: ["ManualSigmas", "SamplerCustomAdvanced"] } });
  old.tick(true);
  assert.equal(old.els.imgDraft.disabled, true);
  assert.equal(old.api.imgDraftOn(), false, "the render goes out full, and the Qwen light stays green");
  assert.equal(old.els.imgDraftWhy.textContent, "Fast draft needs a newer ComfyUI (missing ManualSigmas, SamplerCustomAdvanced). Update ComfyUI, restart, then check again.");
  assert.equal(old.els.imgDraft.dataset.why, old.els.imgDraftWhy.textContent);
});

test("ticked, it locks steps at 5 and CFG at 1 and shows the numbers; unticked, it gives them back", () => {
  const p = page({ steps: "30" });
  p.tick(true);
  assert.equal(p.api.imgDraftOn(), true);
  assert.equal(p.els.imgSteps.value, 5); assert.equal(p.els.imgSteps.disabled, true);
  assert.equal(p.els.imgCfg.value, 1); assert.equal(p.els.imgCfg.disabled, true);
  assert.equal(p.els.imgStepsV.textContent, "5");
  assert.match(p.els.imgSteps.dataset.why, /Fast draft is on/, "the Simple assistant is told why the slider is locked");
  assert.equal(p.els.imgDraftNums.hidden, false);
  p.tick(false);
  assert.equal(p.els.imgDraftNums.hidden, false, "the numbers stay beside the chip whenever it is offered");
  assert.equal(p.els.imgSteps.value, "30"); assert.equal(p.els.imgSteps.disabled, false);
  assert.equal(p.els.imgCfg.disabled, false);
  assert.equal(p.els.imgSteps.dataset.why, undefined);
  assert.equal(p.api.held(), null);
  assert.match(css, /\.assist-on #imgDraftNums \{ display: none !important; \}/, "Simple does not show the numbers");
});

test("a value written while the chip was locked is kept, not reverted, when that value greys it", () => {
  /* The trace: draft on (held 25 / CFG 1), then the Simple assistant writes
   * CFG 3 into the disabled slider and fires input. The chip greys for CFG, and
   * the lock must not put CFG back to 1 under a message that says it is above 1. */
  const p = page({ steps: "25", cfg: "1" });
  p.tick(true);
  p.els.imgCfg.value = "3";
  p.api.imgDraftPaint();
  assert.equal(p.els.imgDraft.disabled, true);
  assert.equal(p.els.imgDraftWhy.textContent, p.api.imgDraftSpec().reasons.cfg);
  assert.equal(p.els.imgCfg.value, "3", "the CFG that was asked for survives");
  assert.equal(p.els.imgSteps.value, "25", "steps still held the lock's 5, so they are given back");
  assert.equal(p.els.imgCfg.disabled, false); assert.equal(p.els.imgSteps.disabled, false);
  assert.equal(p.api.held(), null);
});

test("a base-only choice greys the chip with the reason, and the render goes out full", () => {
  const spec = page().api.imgDraftSpec();
  const cases = [
    [{ transparent: true }, spec.reasons.transparent],
    [{ refs: 4 }, spec.reasons.refs],
    [{ refs: 2, persona: "Alex", personaRefs: { Alex: 2 } }, spec.reasons.refs],
    [{ cfg: "3" }, spec.reasons.cfg],
    [{ negative: "blur" }, spec.reasons.negative],
    [{ size: "custom", w: "2048", h: "2048" }, spec.reasons.size],
    [{ size: "custom", w: "2080", h: "1024" }, spec.reasons.size],
  ];
  for (const [opts, reason] of cases) {
    const p = page(opts);
    p.tick(true);
    assert.equal(p.els.imgDraft.disabled, true, JSON.stringify(opts));
    assert.equal(p.api.imgDraftOn(), false, JSON.stringify(opts));
    assert.equal(p.els.imgDraftChip.title, reason);
    assert.equal(p.els.imgDraftWhy.hidden, false);
    assert.equal(p.els.imgDraftWhy.textContent, reason);
    assert.equal(p.els.imgDraftWhy.classes.has("quiet"), false, "asked for, so said in Advanced too");
    assert.equal(p.els.imgDraft.dataset.why, reason, "and handed to the Simple assistant");
    assert.ok(p.els.imgDraftChip.classes.has("off"));
  }
  for (const opts of [{ refs: 3 }, { size: "custom", w: "2048", h: "1024" }, { size: "1536x1024" },
    { refs: 1, size: "custom", w: "2048", h: "2048" }]) {
    const p = page(opts);
    p.tick(true);
    assert.equal(p.api.imgDraftOn(), true, `${JSON.stringify(opts)} is inside what was measured`);
  }
  const refSized = page({ refs: 1, size: "custom", w: "2048", h: "2048" });
  assert.equal(refSized.api.imgDraftTokens(), 4096, "a reference-sized edit samples the 1024² the page asks for");
  const customRef = page({ refs: 1, refSizing: "custom", size: "custom", w: "2048", h: "2048" });
  customRef.tick(true);
  assert.equal(customRef.api.imgDraftOn(), false, "custom sizing samples the canvas");
  /* Unticked: the reason still reaches a Simple reader (no hover there), and
   * Advanced keeps it in the tooltip (.quiet, hidden outside .assist-on). */
  const quiet = page({ transparent: true });
  quiet.api.imgDraftPaint();
  assert.equal(quiet.els.imgDraftWhy.hidden, false);
  assert.equal(quiet.els.imgDraftWhy.textContent, spec.reasons.transparent);
  assert.equal(quiet.els.imgDraftWhy.classes.has("quiet"), true);
  assert.match(css, /\.draftrow #imgDraftWhy\.quiet \{ display: none; \}/);
  assert.match(css, /\.assist-on \.draftrow #imgDraftWhy\.quiet:not\(\[hidden\]\) \{ display: block; \}/);
});

test("ticked with two or more references, it runs and says what the A/B found there", () => {
  const spec = page().api.imgDraftSpec();
  for (const opts of [{ refs: 2 }, { refs: 1, persona: "Alex", personaRefs: { Alex: 1 } }, { refs: 3 }]) {
    const p = page(opts);
    p.tick(true);
    assert.equal(p.api.imgDraftOn(), true, JSON.stringify(opts));
    assert.equal(p.els.imgDraftWhy.hidden, false);
    assert.equal(p.els.imgDraftWhy.textContent, spec.twoRefs);
    assert.equal(p.els.imgDraftWhy.classes.has("quiet"), false);
  }
  assert.match(spec.twoRefs, /two-reference style edit/);
  const one = page({ refs: 1 });
  one.tick(true);
  assert.equal(one.els.imgDraftWhy.hidden, true, "one reference is the edit it won");
  const unticked = page({ refs: 2 });
  unticked.api.imgDraftPaint();
  assert.equal(unticked.els.imgDraftWhy.hidden, true);
});

test("the page's cases and numbers are the server's", () => {
  const spec = page().api.imgDraftSpec();
  assert.equal(spec.steps, QWEN_DRAFT.steps);
  assert.equal(spec.cfg, QWEN_DRAFT.cfg);
  assert.equal(spec.maxRefs, QWEN_DRAFT.maxRefs);
  assert.equal(spec.maxTokens, QWEN_DRAFT.maxTokens);
  assert.equal(spec.capability, QWEN_DRAFT.capability);
  // Every case the page greys, the server refuses (the server has more: steps,
  // a zero reference size and the editor, which the page never sends).
  for (const key of Object.keys(spec.reasons)) assert.ok(QWEN_DRAFT.refusals[key], key);
  assert.deepEqual(Object.keys(spec.reasons).sort(), ["cfg", "negative", "refs", "size", "transparent"]);
  // The page counts tokens the way the server does.
  for (const [w, h] of [[1024, 1024], [1920, 1088], [2048, 1024], [2048, 2048], [1000, 700], [300, 2048]]) {
    const p = page({ size: "custom", w: String(w), h: String(h) });
    const side = (v) => Math.ceil(v / 32) * 32;
    assert.equal(p.api.imgDraftTokens(), qwenDraftTokens(side(w), side(h)), `${w}x${h}`);
  }
});

test("the chip lives where Simple keeps it, sends draft, and the receipt says so", () => {
  const cta = html.slice(html.indexOf('<div class="ctawrap">'), html.indexOf('id="imgProg"'));
  assert.match(cta, /id="imgDraftRow"[\s\S]*id="imgDraft" type="checkbox"> Fast draft &middot;/, "inside .ctawrap, a plain checkbox the Simple assistant can read");
  assert.match(cta, /id="imgDraftGet"[^>]*>Get Fast draft \(0\.68 GB\)<\/button>/);
  assert.match(app, /\.\.\.\(imgDraftOn\(\) \? \{ draft: true \} : \{\}\),/, "Make image sends it");
  assert.match(app, /if \(typeof imgDraftOn === "function" && imgDraftOn\(\)\) query\.set\("draft", "true"\);/, "readiness is asked for a draft");
  assert.match(app, /offerModel\(\{ needsModel: st\.capability \|\| imgDraftSpec\(\)\.capability/, "Get opens the Models row");
  assert.match(app, /\$\("imgSize"\)\.addEventListener\("change", \(\) => imgDraftPaint\(\)\);/, "a size change repaints the chip");
  assert.match(app, /for \(const id of \["imgW", "imgH"\]\) \$\(id\)\.addEventListener\("input", \(\) => imgDraftPaint\(\)\);/);
  const receipt = read("../web/receipt.js");
  assert.match(receipt, /\{ id: "draft", controls: \["imgDraft"\] \}/);
  assert.match(receipt, /if \(f\.id === "draft"\) return el\.checked && !el\.disabled \? "Fast draft" : null;/);
});

test("Overnight costs a draft idea from the measurements, and drops 'unmeasured' for it", () => {
  const start = app.indexOf("function ovMediaCost(idea, kind) {");
  const end = app.indexOf("function ovPaintPlan(", start);
  assert.ok(start > 0 && end > start);
  const context = vm.createContext({ state: {} });
  vm.runInContext(`${app.slice(start, end)}; globalThis.cost = ovMediaCost;`, context);
  const S = QWEN_DRAFT_SECONDS;
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(context.cost({ engine: "qwen-image-2.1", draft: true, width: 1024, height: 1024 }, "image"), S.perMegapixel + S.notWarm), "~12 s: a new prompt with Qwen loaded");
  assert.ok(near(context.cost({ engine: "qwen-image-2.1", draft: true, width: 1024, height: 1024, count: 4 }, "image"), 4 * S.perMegapixel + S.notWarm));
  assert.ok(near(context.cost({ engine: "qwen-image-2.1", draft: true, refImages: ["a.png"], refResolution: 1024 }, "image"), S.perMegapixel + S.perReference + S.notWarm));
  assert.ok(context.cost({ engine: "qwen-image-2.1", width: 1024, height: 1024 }, "image") > 100, "a full render keeps its allowance");
  assert.match(app, /"qwen-image-2\.1" && it\.draft !== true\)\s*\? " · Qwen time is an unmeasured planning estimate\."/);
  // And the one sentence the docs say about it describes what exists.
  const docs = read("../docs/QWEN_IMAGE.md");
  assert.doesNotMatch(docs, /Studio's time estimate says/);
  assert.match(docs, /Overnight's plan costs every draft take at about 12 s/);
});

test("the Simple assistant is told when to tick it, when not to, and why a greyed one is greyed", async () => {
  const { formIntro, checkValue, describeScreen } = await import("./chat/form-tools.js");
  const intro = formIntro("image").join("\n");
  assert.match(intro, /FAST DRAFT \(imgDraft, Qwen Image 2\.1 only/);
  assert.match(intro, /may garble\nsmall text and add extra faces or fingers/);
  assert.match(intro, /leave it off for words in the picture, crowds, close hands, two-reference style edits and a final picture/);
  assert.doesNotMatch(formIntro("video").join("\n"), /FAST DRAFT/, "a Pictures setting only");
  // The page hands its reason over (data-why), and the assistant uses it rather than "choose another engine".
  assert.match(read("../web/assist.js"), /\.\.\.\(el\.disabled \? \{ fixed: true, \.\.\.\(el\.dataset\?\.why \? \{ why: String\(el\.dataset\.why\)\.slice\(0, 240\) \} : \{\}\) \} : \{\}\),/);
  const why = page().api.imgDraftSpec().reasons.transparent;
  const field = { id: "imgDraft", label: "Fast draft · about 3× quicker · may garble small text", type: "checkbox", value: false, fixed: true, why };
  assert.throws(() => checkValue(field, "true"), (err) => err.message.includes(why) && !/choose another engine/.test(err.message));
  assert.match(describeScreen({ fields: [field] }), /imgDraft · Fast draft · about 3× quicker[^\n]*? \(fixed: Fast draft is off: a transparent picture needs the full render\.\)/);
  // A field locked by its engine still says so.
  assert.throws(() => checkValue({ id: "imgSampler", type: "select", fixed: true, value: "euler", options: [] }, "er_sde"), /fixed by this engine/);
});
