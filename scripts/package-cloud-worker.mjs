/** Reproducible source-only worker archive for reviewing/testing an unpublished build.
 * Does not upload, install, provision resources or include credentials/models. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function cloudWorkerFiles(root = ROOT) {
  const files = new Map();
  async function visit(relative) {
    if (files.has(relative)) return;
    const full = path.resolve(root, relative);
    if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error('Worker import escapes the source tree.');
    const data = await readFile(full); files.set(relative, data);
    for (const m of data.toString('utf8').matchAll(/(?:import[\s\S]*?from\s*|export\s*\{[^}]*\}\s*from\s*)["']([^"']+)["']/g)) {
      if (m[1].startsWith('node:')) continue;
      if (!m[1].startsWith('.') || !m[1].endsWith('.js')) throw new Error('Worker bundle needs an unsupported dependency.');
      await visit(path.posix.normalize(path.posix.join(path.posix.dirname(relative), m[1])));
    }
  }
  await visit('worker/runpod-worker.js');
  files.set('LICENSE', await readFile(path.join(root, 'LICENSE')));
  files.set('worker/comfyui-autostart/__init__.py', await readFile(path.join(root, 'worker/comfyui-autostart/__init__.py')));
  for (const name of ['automatic-runpod.py', 'acceptance-telemetry.py'])
    files.set('worker/' + name, await readFile(path.join(root, 'worker', name)));
  files.set('package.json', Buffer.from(JSON.stringify({ name: 'aiplay-cloud-worker', private: true, type: 'module' }, null, 2)));
  return files;
}
function tarEntry(name, data) {
  if (Buffer.byteLength(name) > 100) throw new Error('Archive path too long.');
  const header = Buffer.alloc(512);
  const put = (offset, value) => header.write(value, offset, 'ascii');
  put(0, name); put(100, '0000644\0'); put(108, '0000000\0'); put(116, '0000000\0');
  put(124, data.length.toString(8).padStart(11, '0') + '\0'); put(136, '00000000000\0');
  header.fill(32, 148, 156); put(156, '0'); put(257, 'ustar\0'); put(263, '00');
  const sum = header.reduce((n, c) => n + c, 0); put(148, sum.toString(8).padStart(6, '0') + '\0 ');
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
export async function packageCloudWorker(root = ROOT, outDir = path.join(root, 'dist')) {
  const files = await cloudWorkerFiles(root);
  const manifest = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, body]) => ({ name, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }));
  const manifestBytes = Buffer.from(JSON.stringify({ version: 1, cloudManagerVersion: 1, files: manifest }, null, 2));
  const build = createHash('sha256').update(manifestBytes).digest('hex');
  files.set('cloud-worker-manifest.json', manifestBytes);
  const tar = Buffer.concat([...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, body]) => tarEntry(name, body)).concat(Buffer.alloc(1024)));
  const archive = gzipSync(tar, { level: 9 }); await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `aiplay-cloud-worker-${build.slice(0, 12)}.tar.gz`);
  await writeFile(file, archive); await writeFile(`${file}.sha256`, `${createHash('sha256').update(archive).digest('hex')}  ${path.basename(file)}\n`);
  return { file, files: manifest.length, build, sha256: createHash('sha256').update(archive).digest('hex') };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await packageCloudWorker(), null, 2));
