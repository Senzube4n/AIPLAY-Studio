/** Build Linux .deb and portable bootstrap packages. Native Linux, no root needed. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, readFile, writeFile, stat, lstat, readdir, realpath, copyFile, cp, chmod, rename, open, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LINUX_SETUP_VERSION = '1.0.0';
const MAX_RUNTIME_BYTES = 128 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const PACKAGE_FILES = [
  ['installer/linux/bootstrap.mjs', 'bootstrap.mjs'],
  ['installer/linux/index.html', 'index.html'],
  ['LICENSE', 'LICENSE'], ['NOTICE', 'NOTICE'],
];
const SOURCE_FILES = [
  'scripts/build-linux-installer.mjs', 'installer/linux/runtime.json',
  'installer/linux/aiplay-studio', 'installer/linux/aiplay-studio.desktop',
  'installer/linux/bootstrap.mjs', 'installer/linux/index.html',
  'web/assets/aiplay-logo.svg', 'LICENSE', 'NOTICE',
];
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function architectureFor(value) {
  if (value === 'x64' || value === 'amd64') return { node: 'x64', debian: 'amd64' };
  if (value === 'arm64' || value === 'aarch64') return { node: 'arm64', debian: 'arm64' };
  throw new Error('Linux setup supports x64/amd64 and arm64 only.');
}

export function validateRuntimePins(manifest) {
  if (manifest?.schemaVersion !== 1 || !/^\d+\.\d+\.\d+$/.test(manifest.nodeVersion || '')
    || !/^\d+\.\d+\.\d+$/.test(manifest.npmVersion || '')) throw new Error('Invalid pinned Node/npm versions.');
  const base = `https://nodejs.org/dist/v${manifest.nodeVersion}/`;
  if (manifest.checksums?.url !== base + 'SHASUMS256.txt' || !SHA256.test(manifest.checksums.sha256)
    || !Number.isSafeInteger(manifest.checksums.bytes) || manifest.checksums.bytes < 1 || manifest.checksums.bytes > 65536) {
    throw new Error('Invalid official checksum-file pin.');
  }
  for (const arch of ['x64', 'arm64']) {
    const row = manifest.architectures?.[arch];
    const file = `node-v${manifest.nodeVersion}-linux-${arch}.tar.gz`;
    if (!row || row.file !== file || row.url !== base + file || !SHA256.test(row.sha256)
      || row.debian !== architectureFor(arch).debian || !Number.isSafeInteger(row.bytes)
      || row.bytes < 1 || row.bytes > MAX_RUNTIME_BYTES) throw new Error(`Invalid official ${arch} runtime pin.`);
  }
  return manifest;
}

export function verifyChecksumListing(text, runtime) {
  const rows = text.split(/\r?\n/).filter(line => line.endsWith('  ' + runtime.file));
  if (rows.length !== 1 || rows[0] !== `${runtime.sha256}  ${runtime.file}`) {
    throw new Error('Pinned runtime does not match the official checksum listing.');
  }
}

export function validateRuntimeListing(text, top) {
  const entries = text.split(/\r?\n/).filter(Boolean);
  if (!entries.length || entries.length > 20000) throw new Error('Unexpected runtime archive entry count.');
  for (const entry of entries) {
    if (!(entry === top || entry.startsWith(top + '/')) || entry.includes('\\') || entry.includes('\0')
      || entry.split('/').includes('..') || entry.startsWith('/')) throw new Error('Unsafe runtime archive path.');
  }
  if (!entries.includes(`${top}/bin/node`) || !entries.includes(`${top}/LICENSE`)
    || !entries.includes(`${top}/lib/node_modules/npm/package.json`)) throw new Error('Incomplete official runtime archive.');
  return entries;
}

export function debControl(arch, installedKiB) {
  const { debian } = architectureFor(arch);
  if (!Number.isSafeInteger(installedKiB) || installedKiB < 1) throw new Error('Invalid installed size.');
  return `Package: aiplay-studio\nVersion: ${LINUX_SETUP_VERSION}\nSection: sound\nPriority: optional\nArchitecture: ${debian}\nMaintainer: AIPLAY Studio contributors\nInstalled-Size: ${installedKiB}\nDepends: libc6 (>= 2.28), libstdc++6 (>= 8.1), xdg-utils, ca-certificates, tar\nHomepage: https://github.com/Senzube4n/AIPLAY-Studio\nDescription: Local creative studio bootstrap\n Installs the current public Studio source into the user's data directory\n on first launch, using a private Node.js runtime and browser progress.\n`;
}

/** Bounded, immutable-pinned download. Verified cache is reusable; partials are never used. */
export async function downloadVerified(url, destination, { sha256, bytes, fetchFn = fetch } = {}) {
  if (!SHA256.test(sha256 || '') || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_RUNTIME_BYTES) {
    throw new Error('Download requires an exact bounded size and SHA-256.');
  }
  const source = new URL(url);
  if (source.protocol !== 'https:' || source.hostname !== 'nodejs.org' || source.username || source.password) {
    throw new Error('Only official HTTPS Node.js assets are accepted.');
  }
  try {
    const existing = await readFile(destination);
    if (existing.length !== bytes || digest(existing) !== sha256) throw new Error('Existing runtime cache differs from its pin; inspect it before retrying.');
    return { sha256, bytes, cached: true };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetchFn(url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw new Error(`Official runtime download failed: HTTP ${response.status}.`);
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) !== bytes) throw new Error('Official runtime Content-Length differs from its pin.');
  await mkdir(path.dirname(destination), { recursive: true });
  const partial = destination + '.partial-' + randomUUID();
  const file = await open(partial, 'wx', 0o600);
  const hash = createHash('sha256');
  let received = 0;
  try {
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > bytes) throw new Error('Official runtime exceeded its pinned byte count.');
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
        if (!bytesWritten) throw new Error('Runtime download could not be written completely.');
        offset += bytesWritten;
      }
    }
  } finally { await file.close(); }
  if (received !== bytes || hash.digest('hex') !== sha256) throw new Error('Downloaded runtime size or SHA-256 mismatch; partial retained for inspection.');
  await copyFile(partial, destination, constants.COPYFILE_EXCL);
  await unlink(partial);
  return { sha256, bytes, cached: false };
}

async function fileInfo(root, relative) {
  const bytes = await readFile(path.join(root, relative));
  return { file: relative, bytes: bytes.length, sha256: digest(bytes) };
}

async function treeKiB(root) {
  let bytes = 0;
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const info = await lstat(file);
      if (info.isDirectory()) await walk(file);
      else if (info.isSymbolicLink()) {
        const target = await realpath(file);
        if (!target.startsWith(root + path.sep)) throw new Error('Extracted runtime symlink escaped its package.');
      } else if (info.isFile()) bytes += info.size;
      else throw new Error('Unsupported runtime file type.');
    }
  }
  await walk(root);
  return Math.max(1, Math.ceil(bytes / 1024));
}

function nativeCommand(exe, args, options = {}) {
  return execFileSync(exe, args, { stdio: 'pipe', maxBuffer: 16 * 1024 * 1024, ...options });
}

export async function buildLinuxInstaller({ arch = process.arch, root = ROOT, command = nativeCommand, fetchFn = fetch } = {}) {
  if (process.platform !== 'linux') throw new Error('Linux installer builds require native Linux (tar and dpkg-deb).');
  const architecture = architectureFor(arch);
  const pins = validateRuntimePins(JSON.parse(await readFile(path.join(root, 'installer/linux/runtime.json'), 'utf8')));
  const runtime = pins.architectures[architecture.node];
  const out = path.join(root, 'dist', 'linux');
  const stem = `AIPLAY-Studio-Linux-${architecture.debian}`;
  const outputs = [stem + '.deb', stem + '.tar.gz', stem + '.build-metadata.json'];
  for (const file of outputs) {
    try { await stat(path.join(out, file)); throw new Error(`Existing Linux artifact must be inspected before rebuilding: ${file}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  command('tar', ['--version']);
  command('dpkg-deb', ['--version']);
  await mkdir(out, { recursive: true });
  const cache = path.join(out, '.cache');
  const checksums = path.join(cache, 'SHASUMS256-' + pins.nodeVersion + '.txt');
  await downloadVerified(pins.checksums.url, checksums, { ...pins.checksums, fetchFn });
  verifyChecksumListing(await readFile(checksums, 'utf8'), runtime);
  const archive = path.join(cache, runtime.file);
  await downloadVerified(runtime.url, archive, { ...runtime, fetchFn });
  const top = `node-v${pins.nodeVersion}-linux-${architecture.node}`;
  validateRuntimeListing(command('tar', ['-tzf', archive]).toString('utf8'), top);
  const stage = path.join(out, '.stage-' + architecture.debian + '-' + randomUUID());
  const packageRoot = path.join(stage, 'package');
  const app = path.join(packageRoot, 'usr/lib/aiplay-studio');
  const extract = path.join(stage, 'extract');
  await mkdir(extract, { recursive: true });
  command('tar', ['-xzf', archive, '--no-same-owner', '--no-same-permissions', '-C', extract]);
  await treeKiB(path.join(extract, top));
  await mkdir(app, { recursive: true });
  await cp(path.join(extract, top), path.join(app, 'runtime'), { recursive: true, dereference: false, verbatimSymlinks: true });
  const npm = JSON.parse(await readFile(path.join(app, 'runtime/lib/node_modules/npm/package.json'), 'utf8'));
  if (npm.version !== pins.npmVersion) throw new Error('Verified archive bundled npm differs from the pinned version.');
  for (const [from, to] of PACKAGE_FILES) await copyFile(path.join(root, from), path.join(app, to));
  await chmod(path.join(app, 'runtime/bin/node'), 0o755);
  let nativeRuntimeIdentity = null;
  if (architecture.node === process.arch) {
    nativeRuntimeIdentity = JSON.parse(command(path.join(app, 'runtime/bin/node'), ['-p',
      'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})']).toString('utf8'));
    if (nativeRuntimeIdentity.version !== 'v' + pins.nodeVersion || nativeRuntimeIdentity.platform !== 'linux'
      || nativeRuntimeIdentity.arch !== architecture.node) throw new Error('Native private Node identity differs from the exact release/architecture pin.');
  }
  const wrapper = path.join(packageRoot, 'usr/bin/aiplay-studio');
  await mkdir(path.dirname(wrapper), { recursive: true });
  await copyFile(path.join(root, 'installer/linux/aiplay-studio'), wrapper);
  await chmod(wrapper, 0o755);
  const desktop = path.join(packageRoot, 'usr/share/applications/aiplay-studio.desktop');
  const icon = path.join(packageRoot, 'usr/share/icons/hicolor/scalable/apps/aiplay-studio.svg');
  const copyright = path.join(packageRoot, 'usr/share/doc/aiplay-studio/copyright');
  for (const file of [desktop, icon, copyright]) await mkdir(path.dirname(file), { recursive: true });
  await copyFile(path.join(root, 'installer/linux/aiplay-studio.desktop'), desktop);
  await copyFile(path.join(root, 'web/assets/aiplay-logo.svg'), icon);
  await writeFile(copyright, 'AIPLAY Studio source: https://github.com/Senzube4n/AIPLAY-Studio\n\n'
    + await readFile(path.join(root, 'LICENSE'), 'utf8')
    + '\n\nThe private Node.js runtime and bundled npm retain their original licenses under /usr/lib/aiplay-studio/runtime/.\n');
  const controlDir = path.join(packageRoot, 'DEBIAN');
  await mkdir(controlDir);
  await writeFile(path.join(controlDir, 'control'), debControl(architecture.node, await treeKiB(path.join(packageRoot, 'usr'))));
  // No maintainer scripts: package installation never runs Studio or a downloader.
  const deb = path.join(stage, outputs[0]);
  command('dpkg-deb', ['--build', '--root-owner-group', '-Zgzip', packageRoot, deb]);
  const portableTop = 'aiplay-studio-linux-' + architecture.debian;
  const portable = path.join(stage, portableTop);
  await cp(app, portable, { recursive: true, dereference: false, verbatimSymlinks: true });
  await copyFile(wrapper, path.join(portable, 'aiplay-studio'));
  await chmod(path.join(portable, 'aiplay-studio'), 0o755);
  const tarball = path.join(stage, outputs[1]);
  command('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', '-czf', tarball, '-C', stage, portableTop]);
  const built = [];
  for (const [from, name] of [[deb, outputs[0]], [tarball, outputs[1]]]) {
    await copyFile(from, path.join(out, name), constants.COPYFILE_EXCL);
    built.push(await fileInfo(out, name));
  }
  const sourceCommit = command('git', ['rev-parse', 'HEAD'], { cwd: root }).toString('utf8').trim();
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error('Exact source commit is required for package provenance.');
  const metadata = {
    schemaVersion: 1, setupVersion: LINUX_SETUP_VERSION, sourceCommit,
    sourceUrl: `https://github.com/Senzube4n/AIPLAY-Studio/tree/${sourceCommit}`,
    sourceModified: Boolean(command('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root }).toString().trim()),
    builtAtUtc: new Date().toISOString(), platform: 'linux', architecture: architecture.debian,
    builderNode: process.version, privateNode: pins.nodeVersion, privateNpm: pins.npmVersion,
    runtime: { url: runtime.url, bytes: runtime.bytes, sha256: runtime.sha256, checksumsUrl: pins.checksums.url,
      checksumsSha256: pins.checksums.sha256, checksumVerifiedBeforeExtraction: true,
      nativeValidation: nativeRuntimeIdentity, nodeFile: await fileInfo(app, 'runtime/bin/node') },
    packageHasMaintainerScripts: false, appOrModelsStartedDuringBuild: false, artifacts: built,
    sourceFiles: await Promise.all(SOURCE_FILES.map(file => fileInfo(root, file))),
  };
  await writeFile(path.join(out, outputs[2]), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
  await writeLinuxChecksums(out);
  console.log(JSON.stringify({ architecture: architecture.debian, sourceCommit, artifacts: outputs, output: out }));
  return metadata;
}

export async function writeLinuxChecksums(out) {
  const files = (await readdir(out)).filter(file => /^AIPLAY-Studio-Linux-(amd64|arm64)\.(deb|tar\.gz|build-metadata\.json)$/.test(file)).sort();
  const rows = await Promise.all(files.map(async file => `${(await fileInfo(out, file)).sha256}  ${file}`));
  const temporary = path.join(out, '.SHA256SUMS-' + randomUUID());
  await writeFile(temporary, rows.join('\n') + '\n', { flag: 'wx' });
  await rename(temporary, path.join(out, 'SHA256SUMS.txt'));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log('Native Linux: node scripts/build-linux-installer.mjs [--arch=x64|arm64|all]. Writes only dist/linux.');
  else {
    if (args.some(arg => !/^--arch=(x64|amd64|arm64|aarch64|all)$/.test(arg)) || args.length > 1) throw new Error('Expected one optional --arch=x64|arm64|all.');
    const arch = args.length ? args[0].slice(7) : process.arch;
    for (const target of arch === 'all' ? ['x64', 'arm64'] : [arch]) await buildLinuxInstaller({ arch: target });
  }
}
