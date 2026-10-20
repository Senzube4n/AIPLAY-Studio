import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, utimes, readFile, rm, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createCloudStorage, persistentPaths } from './cloud-storage.js';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aiplay-cloud-storage-'));
  assert.ok(dir.startsWith(path.join(os.tmpdir(), 'aiplay-cloud-storage-')));
  const roots = { root: dir, modelsDir: path.join(dir, 'models'), outputDir: path.join(dir, 'output'), tempDir: path.join(dir, 'temp'), stateDir: path.join(dir, 'state') };
  for (const folder of Object.values(roots)) await mkdir(folder, { recursive: true });
  await mkdir(path.join(roots.stateDir, 'cache'));
  const store = createCloudStorage({ ...roots, now: () => 2000000000, verifyPersistence: async () => ({ verified: true, root: dir }) });
  t.after(() => rm(dir, { recursive: true, force: true })); return { dir, roots, store };
}
test('storage inventory separates models, content and temporary files; cleanup never targets assets', async t => {
  const f = await fixture(t), scratch = path.join(f.roots.stateDir, 'cache', `${randomUUID()}.upload`);
  for (const [name, text] of [[path.join(f.roots.modelsDir, 'weights.safetensors'), 'weights'], [path.join(f.roots.outputDir, 'song.wav'), 'music'],
    [path.join(f.roots.tempDir, 'preview.png'), 'picture'], [scratch, 'scratch']]) { await writeFile(name, text); await utimes(name, 1, 1); }
  const review = await f.store.inventory(); assert.equal(review.categories.models, 7); assert.equal(review.categories.generated, 5);
  assert.equal(review.usedBytes, 26, 'usage is this namespace, not a shared filesystem backing pool');
  assert.equal(review.cleanup.files.length, 1); assert.ok(review.cleanup.files[0].name.endsWith('.upload'));
  await assert.rejects(f.store.cleanup({ reviewId: review.cleanup.reviewId }), /Review/);
  await f.store.cleanup({ reviewId: review.cleanup.reviewId, confirm: 'CLEAN TEMPORARY FILES' });
  assert.equal(await readFile(path.join(f.roots.modelsDir, 'weights.safetensors'), 'utf8'), 'weights');
  assert.equal(await readFile(path.join(f.roots.outputDir, 'song.wav'), 'utf8'), 'music');
  assert.equal(await readFile(path.join(f.roots.tempDir, 'preview.png'), 'utf8'), 'picture');
});
test('changed cleanup manifests require a new review', async t => {
  const f = await fixture(t), scratch = path.join(f.roots.stateDir, 'cache', `${randomUUID()}.upload`);
  await writeFile(scratch, 'scratch'); await utimes(scratch, 1, 1);
  const review = await f.store.inventory(); await writeFile(scratch, 'changed bytes');
  await assert.rejects(f.store.cleanup({ reviewId: review.cleanup.reviewId, confirm: 'CLEAN TEMPORARY FILES' }), /changed/);
});
test('mount verification refuses container-root storage and paths outside the persistent mount', async t => {
  const f = await fixture(t), escaped = f.dir.split(path.sep).join('\\040');
  const mount = f.dir.replace(/ /g, '\\040');
  const good = `1 0 0:1 / / rw - overlay overlay rw\n2 1 0:2 / ${mount} rw - ext4 disk rw`;
  assert.equal((await persistentPaths(f.dir, [f.roots.outputDir], good)).verified, true);
  assert.equal((await persistentPaths(f.dir, [f.roots.outputDir], '1 0 0:1 / / rw - overlay overlay rw')).verified, false);
  assert.equal((await persistentPaths(f.dir, [os.tmpdir()], good)).verified, false);
  const nested = good + `\n3 2 0:3 / ${f.roots.outputDir.replace(/ /g, '\\040')} rw - tmpfs tmpfs rw`;
  assert.equal((await persistentPaths(f.dir, [f.roots.outputDir], nested)).verified, false);
});
