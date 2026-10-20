/** Explicit single-file deletion in known model folders. Never recursive. */
import path from 'node:path';
import { readdir, lstat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { MODEL_FOLDERS } from '../server/engine/model-catalog.js';
import { containedFile, hashFile } from '../server/engine/remote-common.js';
export function createModelDisk({ modelsDir, assertIdle, removed = () => {}, now = Date.now }) {
  const plans = new Map();
  async function file(relative) {
    if (typeof relative !== 'string' || !MODEL_FOLDERS.includes(relative.split('/')[0]) || !/\.(safetensors|gguf|bin|pt|pth|ckpt)$/i.test(relative)) throw Error('Choose a model file in a supported folder.');
    let current = modelsDir;
    for (const part of relative.split('/')) { if (!part || ['.','..'].includes(part) || /[\\:]/.test(part)) throw Error('Invalid model path.'); current = path.join(current,part); if ((await lstat(current)).isSymbolicLink()) throw Error('Symbolic links cannot be deleted here.'); }
    const full = await containedFile(modelsDir,relative), info = await lstat(full);
    if (!info.isFile()) throw Error('Choose a model file.'); return { full, info };
  }
  async function list() {
    const files = [], queue = MODEL_FOLDERS.map(f => ({ relative: f, depth: 0 })); let scanned = 0, partial = false;
    while (queue.length && scanned < 5000) {
      const next = queue.shift();
      if ((await lstat(path.join(modelsDir,next.relative)).catch(e => { if(e.code !== 'ENOENT') throw e; }))?.isSymbolicLink()) continue;
      let entries; try { entries = await readdir(path.join(modelsDir,next.relative), { withFileTypes: true }); } catch(e) { if (e.code === 'ENOENT') continue; throw e; }
      for (const entry of entries) {
        if (++scanned > 5000) { partial = true; break; }
        if (entry.isSymbolicLink()) continue;
        const relative = `${next.relative}/${entry.name}`;
        if (entry.isDirectory()) { if (next.depth < 8) queue.push({ relative, depth: next.depth+1 }); else partial = true; }
        else if (entry.isFile() && /\.(safetensors|gguf|bin|pt|pth|ckpt)$/i.test(entry.name)) { const { info } = await file(relative); files.push({ relative, bytes: info.size }); }
      }
    }
    return { files: files.sort((a,b) => a.relative.localeCompare(b.relative)), partial: partial || !!queue.length };
  }
  async function review(relative) {
    await assertIdle(); const { full, info } = await file(relative), sha256 = await hashFile(full); await assertIdle();
    for (const [id,p] of plans) if (now() - p.at > 120000) plans.delete(id);
    if (plans.size >= 20) plans.delete(plans.keys().next().value);
    const plan = { id: randomUUID(), relative, bytes: info.size, mtime: info.mtimeMs, sha256, at: now() }; plans.set(plan.id,plan);
    return { id: plan.id, relative, bytes: plan.bytes };
  }
  async function remove(input) {
    const plan = plans.get(input.id);
    if (!plan || now()-plan.at > 120000 || input.confirm !== 'DELETE MODEL FILE') throw Error('Review this file and confirm deletion first.');
    plans.delete(input.id); await assertIdle();
    const { full, info } = await file(plan.relative);
    if (info.size !== plan.bytes || info.mtimeMs !== plan.mtime || await hashFile(full) !== plan.sha256) throw Error('The model file changed. Review it again; it was kept.');
    await assertIdle();
    const final = await file(plan.relative);
    if (final.info.ino !== info.ino || final.info.mtimeMs !== info.mtimeMs || final.info.size !== info.size) throw Error('The model file changed; it was kept.');
    await unlink(final.full); removed(plan.relative); return { deleted: plan.relative, freedBytes: plan.bytes };
  }
  return { list, review, remove };
}
