import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createImageEditor, editorOptions } from "./image-editor.js";

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
    await new Promise(resolve => setImmediate(resolve));
    const ready = await editor.request({ action: "status", id: made.id });
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
    await new Promise(resolve => setImmediate(resolve));
    const ready = await editor.request({ action: "status", id: made.id });
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
    await new Promise(resolve => setImmediate(resolve));
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
    await new Promise(resolve => setImmediate(resolve));
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
