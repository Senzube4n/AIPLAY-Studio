import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createImageEditor, editorOptions } from "./image-editor.js";

async function waitForStatus(editor, id, expected) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = await editor.request({ action: "status", id });
    if (job.status === expected) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Editor job did not reach ${expected}.`);
}

async function exists(file) {
  try { await stat(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

test("editor options enforce target + ordered references and precise selection semantics", () => {
  const base = { source: "target.png", prompt: "Change the jacket" };
  const { options } = editorOptions(base);
  assert.equal(options.steps, 25); assert.equal(options.cfg, 1);
  assert.equal(options.sampler, "euler"); assert.equal(options.scheduler, "simple");
  assert.equal(options.refSizing, "reference");
  assert.throws(() => editorOptions({ ...base, documentId: "also" }), /exactly one/);
  assert.throws(() => editorOptions({ ...base, mode: "style" }), /style reference/);
  assert.throws(() => editorOptions({ ...base, mode: "inpaint" }), /selection/);
  assert.throws(() => editorOptions({ ...base, refImages: Array(10).fill("ref.png") }), /nine/);
  assert.throws(() => editorOptions({ ...base, mode: "inpaint", refImages: Array(9).fill("ref.png") }), /eight/);
  assert.throws(() => editorOptions({ ...base, steps: 0 }), /steps/);
  assert.throws(() => editorOptions({ ...base, refResolution: 1025 }), /multiple/);
  assert.throws(() => editorOptions({ ...base, dit: "unsafe.gguf" }), /native safetensors/);
  assert.throws(() => editorOptions({ ...base, refImages: ["../ref.png"] }), /filenames/);
});

test("generation freezes source and mask as first two references, then review/accept/undo are separate", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "aiplay-editor-"));
  try {
    const calls = [], registered = [];
    let resolveGPU;
    const gpu = new Promise(resolve => { resolveGPU = resolve; });
    const editor = createImageEditor({ imageDir: temp, inputDir: temp, python: "unused",
      runPython: async (mode, payload) => {
        calls.push({ mode, payload });
        if (mode === "prepare") return { width: 641, height: 479, revision: "before", document: { id: "doc" }, coverage: .2 };
        if (mode === "finish") return { width: 641, height: 479, resizedToSource: true };
        if (mode === "accept") return { doc: { id: "doc", layers: [{ id: "generated" }] }, before: { id: "doc", layers: [] }, revision: "accepted" };
        if (mode === "undo") return { doc: { id: "doc", layers: [] }, revision: "undone" };
      },
      preflight: async options => { calls.push({ mode: "preflight", options }); },
      generate: async options => { calls.push({ mode: "generate", options }); return gpu; },
      register: async (...args) => { registered.push(args); },
    });
    const made = await editor.request({ action: "create", documentId: "doc", prompt: "Green coat", mode: "inpaint",
      refImages: ["fabric.png"], seed: 7, selection: { shapes: [{ kind: "rect", x: 1, y: 2, w: 3, h: 4 }] } }, "agent:test");
    assert.equal(made.status, "generating");
    assert.deepEqual(calls.map(c => c.mode), ["prepare", "preflight", "generate"]);
    const asked = calls.find(c => c.mode === "generate").options;
    assert.equal(asked.refImages.length, 3);
    assert.match(asked.refImages[0], /^aiplay_frame_[a-f0-9]{12}\.png$/);
    assert.match(asked.refImages[1], /^aiplay_frame_[a-f0-9]{12}\.png$/);
    assert.notEqual(asked.refImages[0], asked.refImages[1]);
    assert.equal(asked.refImages[2], "fabric.png");
    assert.match(asked.prompt, /<image 2> is white/);
    await assert.rejects(editor.request({ action: "accept", id: made.id }), /ready/);
    resolveGPU({ name: "generated.png", seed: 7, runId: "run" });
    const ready = await waitForStatus(editor, made.id, "ready");
    assert.equal(ready.status, "ready");
    assert.equal(ready.candidate.width, 641);
    assert.equal(registered[0][1].generatedFrom, "generated.png");
    assert.equal(registered[0][2], "agent:test");
    assert.equal(calls.filter(c => c.mode === "accept").length, 0);
    const accepted = await editor.request({ action: "accept", id: made.id });
    assert.equal(accepted.status, "accepted");
    await assert.rejects(editor.request({ action: "accept", id: made.id }), /ready/);
    const undone = await editor.request({ action: "undo", id: made.id });
    assert.equal(undone.status, "undone");
    assert.equal(calls.at(-1).payload.revision, "accepted");
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("references reach Qwen flattened unless transparency is asked for; composite warnings reach the review", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "aiplay-editor-"));
  try {
    const dirs = { imageDir: path.join(temp, "images"), inputDir: path.join(temp, "input"), coverDir: path.join(temp, "covers") };
    const calls = [], registered = [];
    const warning = "Qwen returned 86% of the selection transparent; those pixels keep the source.";
    const editor = createImageEditor({ ...dirs, python: "unused",
      runPython: async (mode, payload) => {
        calls.push({ mode, payload });
        // Stands in for image_editor.py: only the first reference had alpha.
        if (mode === "prepare") return { width: 8, height: 8, references: payload.references.map((r, i) => i ? r.name : path.basename(r.out)) };
        if (mode === "finish") return { width: 8, height: 8, resizedToSource: false, warnings: [warning] };
      },
      generate: async options => { calls.push({ mode: "generate", options }); return { name: "out.png" }; },
      register: async (name, metadata) => { registered.push(metadata); },
    });
    const refImages = ["cutout.png", "aiplay_frame_0123456789ab.png"];
    const made = await editor.request({ source: "frame.png", prompt: "Put the paper bird here", mode: "inpaint", refImages,
      selection: { shapes: [{ kind: "rect", x: 1, y: 1, w: 4, h: 4 }] } });
    const sent = calls.find(c => c.mode === "prepare").payload.references;
    assert.deepEqual(sent.map(r => r.name), refImages);
    assert.deepEqual(sent.map(r => r.candidates), [[path.join(dirs.coverDir, "cutout.png"), path.join(dirs.imageDir, "cutout.png")],
      [path.join(dirs.inputDir, "aiplay_frame_0123456789ab.png")]]);
    for (const r of sent) {
      assert.equal(path.dirname(r.out), dirs.inputDir);
      assert.match(path.basename(r.out), /^aiplay_frame_[a-f0-9]{12}\.png$/);
    }
    assert.notEqual(sent[0].out, sent[1].out);
    const asked = calls.find(c => c.mode === "generate").options.refImages;
    assert.deepEqual(asked.slice(2), [path.basename(sent[0].out), "aiplay_frame_0123456789ab.png"]);
    const ready = await waitForStatus(editor, made.id, "ready");
    assert.equal(ready.status, "ready");
    assert.deepEqual(ready.warnings, [warning]);
    assert.equal(ready.candidate.warnings, undefined);
    assert.deepEqual(registered[0].refImages, refImages);  // provenance names what the user chose
    calls.length = 0;
    await editor.request({ source: "frame.png", prompt: "Cut out the bird", transparent: true, refImages: ["cutout.png"] });
    assert.deepEqual(calls.find(c => c.mode === "prepare").payload.references, []);
    assert.deepEqual(calls.find(c => c.mode === "generate").options.refImages.slice(1), ["cutout.png"]);
    let flattened;
    const refused = createImageEditor({ ...dirs, generate: async () => ({ name: "out.png" }),
      preflight: async () => { throw new Error("Missing Qwen node"); },
      runPython: async (mode, payload) => {
        flattened = payload.references[0].out;
        await writeFile(flattened, "flat");
        return { width: 8, height: 8, references: [path.basename(flattened)] };
      } });
    await assert.rejects(refused.request({ source: "frame.png", prompt: "edit", refImages: ["cutout.png"] }), /Missing Qwen/);
    await assert.rejects(stat(flattened), { code: "ENOENT" });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("failed readiness never starts generation; discarded results never mutate documents", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "aiplay-editor-"));
  try {
    let generated = 0, modified = 0;
    const dependencies = { imageDir: temp, inputDir: temp, python: "unused",
      runPython: async mode => { if (["accept", "undo"].includes(mode)) modified++; return { width: 32, height: 32 }; },
      generate: async () => { generated++; return { name: "out.png" }; },
    };
    const blocked = createImageEditor({ ...dependencies, preflight: async () => { throw new Error("Missing Qwen node"); } });
    await assert.rejects(blocked.request({ source: "a.png", prompt: "edit" }), /Missing Qwen/);
    assert.equal(generated, 0);
    const available = createImageEditor(dependencies);
    const made = await available.request({ source: "a.png", prompt: "edit" });
    await waitForStatus(available, made.id, "ready");
    assert.equal((await available.request({ action: "discard", id: made.id })).status, "discarded");
    assert.equal(modified, 0);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("two accepted jobs for one document serialize and the second sees the stale revision", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "aiplay-editor-"));
  try {
    let revision = "initial", activeWrites = 0, peak = 0;
    const events = [];
    const editor = createImageEditor({ imageDir: temp, inputDir: temp,
      generate: async () => ({ name: "out.png" }),
      documentChanged: async (event, actor) => events.push({ ...event, actor }),
      runPython: async (mode, payload) => {
        if (mode === "prepare") return { width: 32, height: 32, revision, document: { id: "same" } };
        if (mode === "finish") return { width: 32, height: 32 };
        if (mode === "accept") {
          ++activeWrites; peak = Math.max(peak, activeWrites);
          try {
            if (payload.revision !== revision) throw new Error("The document changed");
            await new Promise(resolve => setTimeout(resolve, 20));
            revision = "accepted";
            return { doc: { id: "same" }, before: {}, revision };
          } finally { --activeWrites; }
        }
      },
    });
    const first = await editor.request({ documentId: "same", prompt: "red" });
    const second = await editor.request({ documentId: "same", prompt: "blue" });
    await Promise.all([waitForStatus(editor, first.id, "ready"), waitForStatus(editor, second.id, "ready")]);
    const results = await Promise.allSettled([
      editor.request({ action: "accept", id: first.id }, "agent:reviewer"),
      editor.request({ action: "accept", id: second.id }, "user"),
    ]);
    assert.deepEqual(results.map(r => r.status), ["fulfilled", "rejected"]);
    assert.match(results[1].reason.message, /changed/);
    assert.equal(peak, 1);
    assert.equal(events.length, 1); assert.equal(events[0].actor, "agent:reviewer");
    assert.equal((await editor.request({ action: "status", id: second.id })).status, "ready");
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("Qwen keeps the frozen source for review, then clears only editor-owned files on accept and discard", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "aiplay-editor-"));
  try {
    const imageDir = path.join(temp, "images"), inputDir = path.join(temp, "input"), coverDir = path.join(temp, "covers");
    await Promise.all([mkdir(imageDir), mkdir(inputDir), mkdir(coverDir)]);
    const source = path.join(imageDir, "source.png"), reference = path.join(coverDir, "reference.png");
    await Promise.all([writeFile(source, "source"), writeFile(reference, "reference")]);
    let resolveGeneration;
    const pendingGeneration = new Promise(resolve => { resolveGeneration = resolve; });
    const prepared = [];
    const editor = createImageEditor({ imageDir, inputDir, coverDir,
      generate: async () => pendingGeneration,
      runPython: async (mode, payload) => {
        if (mode === "prepare") {
          prepared.push(payload);
          await Promise.all([payload.out, payload.maskOut, payload.maskImageOut, ...payload.references.map(r => r.out)]
            .map(file => writeFile(file, "temporary")));
          return { width: 16, height: 16, references: payload.references.map(r => path.basename(r.out)) };
        }
        if (mode === "finish") {
          await writeFile(payload.out, "candidate");
          return { width: 16, height: 16 };
        }
        if (mode === "accept") {
          assert.equal(await exists(payload.sourcePath), true, "accept needs the frozen original");
          return { doc: { id: "saved" }, before: {}, revision: "accepted" };
        }
      },
    });
    const body = { source: "source.png", prompt: "New colors", mode: "inpaint", refImages: ["reference.png"],
      selection: { shapes: [{ kind: "rect", x: 0, y: 0, w: 8, h: 8 }] } };
    const first = await editor.request(body);
    assert.equal(first.status, "generating");
    const firstFiles = prepared[0];
    for (const file of [firstFiles.out, firstFiles.maskOut, firstFiles.maskImageOut, firstFiles.references[0].out])
      assert.equal(await exists(file), true, `pending job retains ${path.basename(file)}`);
    resolveGeneration({ name: "generated.png" });
    const ready = await waitForStatus(editor, first.id, "ready");
    assert.equal(await exists(firstFiles.out), true, "review retains the frozen source");
    for (const file of [firstFiles.maskOut, firstFiles.maskImageOut, firstFiles.references[0].out])
      assert.equal(await exists(file), false, `finished job clears ${path.basename(file)}`);
    assert.equal(await exists(path.join(imageDir, ready.candidate.name)), true);
    await editor.request({ action: "accept", id: first.id });
    assert.equal(await exists(firstFiles.out), false);
    assert.equal(await exists(source), true);
    assert.equal(await exists(reference), true);
    assert.equal(await exists(path.join(imageDir, ready.candidate.name)), true);

    const second = await editor.request(body);
    const secondReady = await waitForStatus(editor, second.id, "ready");
    assert.equal(await exists(prepared[1].out), true);
    await editor.request({ action: "discard", id: second.id });
    assert.equal(await exists(prepared[1].out), false);
    assert.equal(await exists(path.join(imageDir, secondReady.candidate.name)), true);
    assert.equal(await exists(source), true);
    assert.equal(await exists(reference), true);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("failed generation clears owned inputs; expiry retries a failed cleanup without affecting the library", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "aiplay-editor-"));
  try {
    const imageDir = path.join(temp, "images"), inputDir = path.join(temp, "input");
    await Promise.all([mkdir(imageDir), mkdir(inputDir)]);
    const source = path.join(imageDir, "source.png");
    await writeFile(source, "source");
    let currentTime = 1000, generationFails = true, failRemoval = false;
    const prepared = [];
    const editor = createImageEditor({ imageDir, inputDir, now: () => currentTime,
      removeTemp: async file => {
        if (failRemoval && file === prepared[1]?.out) { failRemoval = false; throw new Error("file busy"); }
        return unlink(file);
      },
      generate: async () => {
        if (generationFails) throw new Error("GPU failed");
        return { name: "generated.png" };
      },
      runPython: async (mode, payload) => {
        if (mode === "prepare") {
          prepared.push(payload);
          await writeFile(payload.out, "temporary");
          return { width: 8, height: 8 };
        }
        if (mode === "finish") { await writeFile(payload.out, "candidate"); return { width: 8, height: 8 }; }
      },
    });
    const failed = await editor.request({ source: "source.png", prompt: "First" });
    assert.match((await waitForStatus(editor, failed.id, "error")).error, /GPU failed/);
    assert.equal(await exists(prepared[0].out), false);
    assert.equal(await exists(source), true);

    generationFails = false;
    const reviewed = await editor.request({ source: "source.png", prompt: "Second" });
    const ready = await waitForStatus(editor, reviewed.id, "ready");
    const candidate = path.join(imageDir, ready.candidate.name);
    failRemoval = true;
    const discarded = await editor.request({ action: "discard", id: reviewed.id });
    assert.equal(discarded.status, "discarded");
    assert.match(discarded.warnings.join(" "), /file busy/);
    assert.equal(await exists(prepared[1].out), true);
    currentTime += 86400001;
    const next = await editor.request({ source: "source.png", prompt: "Third" });
    assert.equal(await exists(prepared[1].out), false);
    assert.equal(await exists(candidate), true);
    assert.equal(await exists(source), true);
    await assert.rejects(editor.request({ action: "status", id: reviewed.id }), /unavailable/);
    const nextReady = await waitForStatus(editor, next.id, "ready");
    assert.equal(await exists(prepared[2].out), true, "ready review retains its source until expiry");
    currentTime += 86400001;
    const fourth = await editor.request({ source: "source.png", prompt: "Fourth" });
    assert.equal(await exists(prepared[2].out), false);
    assert.equal(await exists(path.join(imageDir, nextReady.candidate.name)), true);
    await assert.rejects(editor.request({ action: "status", id: next.id }), /unavailable/);
    await waitForStatus(editor, fourth.id, "ready");
  } finally { await rm(temp, { recursive: true, force: true }); }
});
