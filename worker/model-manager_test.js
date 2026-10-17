import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createModelManager, MODEL_BUNDLES } from "./model-manager.js";

const waitFor = async (manager) => {
  for (let i = 0; i < 100 && manager.status().active; i++) await new Promise(resolve => setTimeout(resolve, 5));
  return manager.status();
};

test('every production bundle has pinned source URLs, sizes and checksums', () => {
  for (const bundle of Object.values(MODEL_BUNDLES)) {
    assert.equal(bundle.totalBytes, bundle.files.reduce((n, f) => n + f.bytes, 0));
    for (const f of bundle.files) { assert.match(f.sha256, /^[a-f0-9]{64}$/); assert.match(f.url, /https:\/\/huggingface.co\/.+\/resolve\/[a-f0-9]{40}\//); }
  }
});

test('gated models require accepted terms and a read token, which never appears in status', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiplay-gated-')); t.after(() => rm(root, { recursive: true, force: true }));
  const body = Buffer.from('model'), token = 'hf_testReadToken123456789'; let auth;
  const manager = await createModelManager({ modelsDir: root, bundles: { gated: { label: 'Gated', requiresToken: true, totalBytes: 5,
    files: [{ relative: 'checkpoints/gated.bin', bytes: 5, sha256: createHash('sha256').update(body).digest('hex'), url: 'https://huggingface.co/test' }] } },
    fetchFn: async (_, init) => { auth = init.headers.Authorization; return new Response(body); } });
  await assert.rejects(manager.install('gated', false, token), /accept/);
  await assert.rejects(manager.install('gated', true), /read token/);
  await manager.install('gated', true, token); const state = await waitFor(manager);
  assert.equal(auth, `Bearer ${token}`); assert.equal(JSON.stringify(state).includes(token), false);
});

test("curated model install removes a corrupt legacy partial and verifies the final file", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiplay-models-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = Buffer.from("verified model bytes");
  const sha256 = createHash("sha256").update(body).digest("hex");
  const relative = "checkpoints/test.safetensors";
  const finalFile = path.join(root, relative);
  await mkdir(path.dirname(finalFile), { recursive: true });
  await writeFile(`${finalFile}.part`, "corrupt");
  const bundles = { test: { label: "Test", description: "Fixture", licenseUrl: "https://example.test/terms",
    totalBytes: body.length, files: [{ relative, bytes: body.length, sha256, url: "https://example.test/model" }] } };
  const calls = [];
  const manager = await createModelManager({ modelsDir: root, bundles, fetchFn: async (url, init) => {
    calls.push({ url, range: init.headers.Range || null });
    return new Response(body, { status: 200 });
  } });

  await assert.rejects(manager.install("test", false), /accept/);
  await manager.install("test", true);
  const done = await waitFor(manager);
  assert.equal(done.active, null);
  assert.equal(done.bundles[0].state, "ready");
  assert.deepEqual(await readFile(finalFile), body);
  await assert.rejects(readFile(`${finalFile}.part`));
  assert.equal(calls.length, 1);
});

test("curated model install resumes its own partial with a Range request", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiplay-models-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = Buffer.from("0123456789");
  const sha256 = createHash("sha256").update(body).digest("hex");
  const relative = "checkpoints/resume.bin";
  const finalFile = path.join(root, relative);
  await mkdir(path.dirname(finalFile), { recursive: true });
  await writeFile(`${finalFile}.aiplay-part`, body.subarray(0, 4));
  const bundles = { test: { label: "Test", description: "Fixture", licenseUrl: "https://example.test/terms",
    totalBytes: body.length, files: [{ relative, bytes: body.length, sha256, url: "https://example.test/model" }] } };
  let range = null;
  const manager = await createModelManager({ modelsDir: root, bundles, fetchFn: async (url, init) => {
    range = init.headers.Range;
    return new Response(body.subarray(4), { status: 206, headers: { "Content-Range": "bytes 4-9/10" } });
  } });
  await manager.install("test", true);
  const done = await waitFor(manager);
  assert.equal(done.bundles[0].state, "ready");
  assert.equal(range, "bytes=4-");
  assert.deepEqual(await readFile(finalFile), body);
});
