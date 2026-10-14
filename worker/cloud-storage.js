/** Bounded storage inventory. Cleanup accepts a reviewed manifest, never paths from a caller. */
import path from 'node:path';
import { readFile, realpath, readdir, lstat, statfs, open, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { containedFile, hashFile } from '../server/engine/remote-common.js';

const inside = (base, file) => { const r = path.relative(base, file); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const decodeMount = s => s.replace(/\\([0-7]{3})/g, (_, n) => String.fromCharCode(parseInt(n, 8)));
export async function persistentPaths(root, paths, mountInfo = null) {
  try {
    const base = await realpath(root);
    const mounts = (mountInfo ?? await readFile('/proc/self/mountinfo', 'utf8')).trim().split('\n')
      .map(line => decodeMount(line.split(' ')[4] || '')).filter(Boolean);
    // A /workspace directory on the container root filesystem is not persistent storage.
    const mount = mounts.filter(m => inside(m, base)).sort((a, b) => b.length - a.length)[0];
    if (!mount || mount === '/' || mount !== base) return { verified: false, reason: 'Persistent storage could not be verified.' };
    for (const file of paths) {
      const full = await realpath(file);
      if (!inside(base, full)) return { verified: false, reason: 'Important files are outside persistent storage.' };
      const fileMount = mounts.filter(m => inside(m, full)).sort((a, b) => b.length - a.length)[0];
      if (fileMount !== base) return { verified: false, reason: 'Important files use an unverified nested mount.' };
    }
    return { verified: true, root: base };
  } catch { return { verified: false, reason: 'Persistent storage could not be checked.' }; }
}

export function createCloudStorage({ root, modelsDir, outputDir, tempDir, stateDir, inputDir = null, now = Date.now, verifyPersistence,
  maxEntries = 100000, maxScanMs = 10000 }) {
  let reviewed = null;
  async function inventory() {
    const base = await realpath(root), categories = { models: 0, generated: 0, temporary: 0, other: 0 };
    const modelRoot = await realpath(modelsDir).catch(() => modelsDir), outputRoot = await realpath(outputDir).catch(() => outputDir);
    const tempRoot = await realpath(tempDir).catch(() => tempDir);
    let entries = 0, partial = false; const candidates = [], scanStarted = performance.now();
    const scratchRoots = [path.join(stateDir, 'cache'), ...(inputDir ? [path.join(inputDir, 'aiplay_remote')] : [])];
    const scratch = file => scratchRoots.some(dir => inside(dir, file)) && /^[a-f0-9-]{36}\.upload$/.test(path.basename(file));
    const category = file => inside(modelRoot, file) ? 'models' : inside(outputRoot, file) ? 'generated' : inside(tempRoot, file) || scratch(file) ? 'temporary' : 'other';
    async function walk(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (++entries > maxEntries || performance.now() - scanStarted > maxScanMs) { partial = true; return; }
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { await walk(full); if (partial) return; }
        else if (entry.isFile()) {
          const info = await lstat(full); categories[category(full)] += info.size;
          // Only abandoned AIPLAY upload scratch files in its own cache/input folders.
          // Preview pictures, weights, datasets and general Comfy temp files are never candidates.
          if (scratch(full)
              && now() - info.mtimeMs > 24 * 3600000)
            candidates.push({ relative: path.relative(base, full).split(path.sep).join('/'), bytes: info.size, mtime: info.mtimeMs, ino: String(info.ino), sha256: await hashFile(full) });
        }
      }
    }
    await walk(base);
    const fs = await statfs(base);
    const reviewId = createHash('sha256').update(JSON.stringify(candidates)).digest('hex');
    reviewed = { id: reviewId, candidates, at: now() };
    // statfs on shared network mounts may report the backing filesystem, not this user's quota.
    // User-visible usage is the measured namespace; allocation and charges come from the provider.
    return { usedBytes: partial ? null : Object.values(categories).reduce((n, c) => n + c, 0),
      filesystemUsedBytes: (fs.blocks - fs.bfree) * fs.bsize, filesystemBytes: fs.blocks * fs.bsize, categories, partial,
      cleanup: { reviewId, files: candidates.map(c => ({ name: c.relative, bytes: c.bytes })), bytes: candidates.reduce((n, c) => n + c.bytes, 0) } };
  }
  async function cleanup({ reviewId, confirm }) {
    if (confirm !== 'CLEAN TEMPORARY FILES' || !reviewed || reviewed.id !== reviewId || now() - reviewed.at > 300000)
      throw new Error('Review the temporary files again before cleaning.');
    const before = reviewed; const current = await inventory();
    if (current.cleanup.reviewId !== before.id) throw new Error('Temporary files changed. Review storage again.');
    let freedBytes = 0;
    for (const file of before.candidates) {
      const full = await containedFile(root, file.relative), info = await lstat(full);
      if (!info.isFile() || info.size !== file.bytes || info.mtimeMs !== file.mtime || String(info.ino) !== file.ino)
        throw new Error('A temporary file changed. Review storage again.');
      if (await hashFile(full) !== file.sha256) throw new Error('A temporary file changed. Review storage again.');
      await unlink(full); freedBytes += file.bytes;
    }
    reviewed = null;
    return { freedBytes };
  }
  async function persist(jobs) {
    const verification = await verifyPersistence();
    if (!verification.verified) throw new Error(verification.reason || 'Saved files could not be verified.');
    for (const job of jobs) for (const file of job.outputs || []) {
      const full = await containedFile(outputDir, file.relative);
      if (!inside(await realpath(root), full) || await hashFile(full) !== file.sha256) throw new Error('A generated file could not be verified on persistent storage.');
      const handle = await open(full, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    }
    // Flush dataset/training/model writes as well as individually verified generation outputs.
    if (process.platform === 'linux') await promisify(execFile)('sync', ['-f', root], { timeout: 30000 });
    return verification;
  }
  return { inventory, cleanup, persist };
}
