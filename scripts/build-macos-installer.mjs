/** Native macOS bootstrap .app/.dmg builder. No account, models or app startup. */
import { constants } from 'node:fs';
import { readFile, writeFile, mkdir, lstat, readdir, realpath, readlink, cp, copyFile, chmod, mkdtemp, open, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Pure, already tested verified-download utilities. Importing does not build Linux.
import { downloadVerified, verifyChecksumListing, validateRuntimeListing, digest } from './build-linux-installer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA = /^[0-9a-f]{64}$/;
export const MACOS_SETUP_VERSION = '1.0.0';
export const MINIMUM_MACOS = '13.5';
export const MACOS_SOURCE_FILES = [
  'scripts/build-macos-installer.mjs', 'scripts/build-linux-installer.mjs',
  'installer/macos/runtime.json', 'installer/macos/Info.plist', 'installer/macos/entry.m',
  'installer/macos/bootstrap.mjs', 'installer/macos/index.html', 'web/assets/aiplay-logo.png', 'LICENSE', 'NOTICE',
];
const nativeCommand = (exe, args, options = {}) => execFileSync(exe, args, { stdio: 'pipe', maxBuffer: 16 * 1024 ** 2, timeout: 180_000, ...options });
const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };

export function macArchitecture(value) {
  if (value === 'arm64') return { node: 'arm64', clang: 'arm64', cpuType: 0x0100000c };
  if (value === 'x64') return { node: 'x64', clang: 'x86_64', cpuType: 0x01000007 };
  throw Error('macOS setup supports arm64 and x64 only.');
}
export function validateMacRuntimePins(pins) {
  if (pins?.schemaVersion !== 1 || pins.nodeVersion !== '24.22.1' || pins.npmVersion !== '11.19.1'
    || pins.minimumMacOS !== MINIMUM_MACOS) throw Error('Invalid pinned macOS Node/npm or minimum OS versions.');
  const base = `https://nodejs.org/dist/v${pins.nodeVersion}/`;
  if (pins.checksums?.url !== base + 'SHASUMS256.txt' || !SHA.test(pins.checksums.sha256 || '')
    || !Number.isSafeInteger(pins.checksums.bytes) || pins.checksums.bytes < 1 || pins.checksums.bytes > 65536) throw Error('Invalid official checksum-file pin.');
  for (const arch of ['arm64', 'x64']) {
    const row = pins.architectures?.[arch], file = `node-v${pins.nodeVersion}-darwin-${arch}.tar.gz`;
    if (!row || row.file !== file || row.url !== base + file || !SHA.test(row.sha256 || '') || !Number.isSafeInteger(row.bytes)
      || row.bytes < 1 || row.bytes > 128 * 1024 ** 2) throw Error(`Invalid official ${arch} Darwin runtime pin.`);
  }
  return pins;
}

export function parseMacBuildArgs(args, defaultArch = process.arch) {
  let arch = defaultArch, plan = false, help = false, seenArch = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') help = true;
    else if (args[i] === '--plan') plan = true;
    else if (args[i] === '--arch' || args[i].startsWith('--arch=')) {
      if (seenArch) throw Error('Select one macOS architecture.'); seenArch = true;
      arch = args[i] === '--arch' ? args[++i] : args[i].slice(7);
    } else throw Error('Use --arch=arm64|x64, --plan or --help.');
  }
  if (!help) macArchitecture(arch);
  return { arch, plan, help };
}

async function ordinary(file, directory = false) {
  const info = await lstat(file);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw Error('A macOS build path is not an ordinary file or folder.');
  return info;
}
async function ordinaryDirectory(file) {
  try { await mkdir(file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await ordinary(file, true);
}
async function absent(file) {
  try { await lstat(file); throw Error(`Existing macOS output must be inspected before rebuilding: ${path.basename(file)}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function info(root, relative) {
  const bytes = await readFile(path.join(root, relative));
  return { file: relative, bytes: bytes.length, sha256: digest(bytes) };
}

/** Validate a thin 64-bit executable before asking the operating system to run it. */
export function validateMachO(bytes, arch) {
  const expected = macArchitecture(arch);
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== expected.cpuType
    || bytes.readUInt32LE(12) !== 2) throw Error('The executable does not match the requested macOS architecture.');
  return { format: 'Mach-O 64', architecture: arch };
}

/** Refuse external links and unusual files. The archive's internal npm links
 * remain links; the private runtime is never flattened or linked globally. */
export async function macTreeReceipt(root) {
  const base = await realpath(root), rows = []; let total = 0;
  await ordinary(root, true);
  async function walk(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const file = path.join(dir, entry.name), rel = path.relative(root, file).split(path.sep).join('/'), item = await lstat(file);
      if (item.isDirectory()) await walk(file);
      else if (item.isSymbolicLink()) {
        const target = await realpath(file);
        if (!inside(base, target)) throw Error('A private runtime link escapes the app bundle.');
        rows.push({ file: rel, link: await readlink(file) });
      } else if (item.isFile()) {
        total += item.size; if (total > 512 * 1024 ** 2 || rows.length > 25_000) throw Error('The macOS runtime exceeds package bounds.');
        rows.push(await info(root, rel));
      } else throw Error('Unsupported macOS runtime file type.');
    }
  }
  await walk(root);
  return { sha256: digest(Buffer.from(JSON.stringify(rows))), files: rows.filter(row => !row.link).length,
    links: rows.filter(row => row.link).length, bytes: total };
}

/** Fixture-testable bundle construction. Native commands are injected only by
 * tests; the CLI always uses fixed platform tools and the actual host identity. */
export async function stageMacBundle({ root = ROOT, bundle, runtimeRoot, arch, pins, provenance = {}, command = nativeCommand,
  hostPlatform = process.platform, hostArch = process.arch } = {}) {
  const architecture = macArchitecture(arch); validateMacRuntimePins(pins);
  if (!path.isAbsolute(bundle || '') || !path.isAbsolute(runtimeRoot || '')) throw Error('Bundle and private runtime paths must be absolute.');
  await ordinary(runtimeRoot, true); await macTreeReceipt(runtimeRoot);
  const nodeSource = path.join(runtimeRoot, 'bin/node'); await ordinary(nodeSource);
  validateMachO(await readFile(nodeSource), arch);
  const npm = JSON.parse(await readFile(path.join(runtimeRoot, 'lib/node_modules/npm/package.json'), 'utf8'));
  if (npm.version !== pins.npmVersion) throw Error('The verified runtime bundles a different npm version.');
  await mkdir(bundle);
  const contents = path.join(bundle, 'Contents'), resources = path.join(contents, 'Resources'), macos = path.join(contents, 'MacOS');
  await mkdir(resources, { recursive: true }); await mkdir(macos);
  await cp(runtimeRoot, path.join(resources, 'runtime'), { recursive: true, dereference: false, verbatimSymlinks: true });
  for (const [from, to] of [['installer/macos/bootstrap.mjs', 'bootstrap.mjs'], ['installer/macos/index.html', 'index.html'], ['LICENSE', 'LICENSE'], ['NOTICE', 'NOTICE']]) {
    await ordinary(path.join(root, from)); await copyFile(path.join(root, from), path.join(resources, to), constants.COPYFILE_EXCL);
  }
  await copyFile(path.join(root, 'installer/macos/Info.plist'), path.join(contents, 'Info.plist'), constants.COPYFILE_EXCL);
  const plist = await readFile(path.join(contents, 'Info.plist'), 'utf8');
  if (!plist.includes(`<string>${MINIMUM_MACOS}</string>`) || !plist.includes(`<string>${MACOS_SETUP_VERSION}</string>`)) throw Error('Info.plist does not match the setup/minimum OS versions.');
  command('/usr/bin/plutil', ['-lint', path.join(contents, 'Info.plist')]);
  const executable = path.join(macos, 'AIPLAY Studio');
  command('/usr/bin/clang', ['-fobjc-arc', '-O2', '-arch', architecture.clang, `-mmacosx-version-min=${MINIMUM_MACOS}`,
    '-framework', 'Foundation', '-framework', 'AppKit', path.join(root, 'installer/macos/entry.m'), '-o', executable]);
  await ordinary(executable); validateMachO(await readFile(executable), arch); await chmod(executable, 0o755);
  const iconset = path.join(path.dirname(bundle), 'AIPLAY.iconset'); await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
    const icon = path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`);
    command('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), path.join(root, 'web/assets/aiplay-logo.png'), '--out', icon]);
    await ordinary(icon);
  }
  command('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'AIPLAY.icns')]);
  await ordinary(path.join(resources, 'AIPLAY.icns'));
  await rm(iconset, { recursive: true });
  const node = path.join(resources, 'runtime/bin/node'); await chmod(node, 0o755);
  let nativeValidation = null;
  if (hostPlatform === 'darwin' && hostArch === arch) {
    nativeValidation = JSON.parse(command(node, ['-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})']).toString());
    if (nativeValidation.version !== 'v' + pins.nodeVersion || nativeValidation.platform !== 'darwin' || nativeValidation.arch !== arch) throw Error('Private Node identity differs from its exact version/platform/architecture pin.');
  }
  // The outer app and our entry are ad-hoc signed. Node's original signature is
  // preserved. This is not Developer ID signing or an Apple notarization.
  command('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', executable]);
  await writeFile(path.join(resources, 'package-info.json'), JSON.stringify({ ...provenance, schemaVersion: 1, setupVersion: MACOS_SETUP_VERSION,
    platform: 'darwin', architecture: arch, minimumMacOS: MINIMUM_MACOS, privateNode: pins.nodeVersion, privateNpm: pins.npmVersion,
    runtimeArchive: pins.architectures[arch], signing: { identity: 'ad-hoc', developerId: false, notarized: false } }, null, 2) + '\n', { flag: 'wx' });
  command('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--identifier', 'org.aiplay.studio', bundle]);
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle]);
  return { nativeValidation, bundle: await macTreeReceipt(bundle), entry: await info(bundle, 'Contents/MacOS/AIPLAY Studio'),
    node: await info(bundle, 'Contents/Resources/runtime/bin/node') };
}

export async function writeMacChecksums(out) {
  const files = (await readdir(out)).filter(file => /^AIPLAY-Studio-macOS-(arm64|x64)\.(dmg|build-metadata\.json)$/.test(file)).sort();
  const rows = await Promise.all(files.map(async file => `${(await info(out, file)).sha256}  ${file}`));
  const temporary = path.join(out, '.SHA256SUMS-' + randomUUID());
  await writeFile(temporary, rows.join('\n') + '\n', { flag: 'wx' });
  // Shared checksum manifest publication is atomic; per-architecture artifacts
  // and metadata themselves are always created exclusively.
  const { rename } = await import('node:fs/promises'); await rename(temporary, path.join(out, 'SHA256SUMS.txt'));
}

export async function buildMacInstaller({ arch = process.arch, root = ROOT, command = nativeCommand, fetchFn = fetch } = {}) {
  if (process.platform !== 'darwin') throw Error('macOS app/DMG builds require native macOS and its Apple build tools.');
  macArchitecture(arch);
  const pins = validateMacRuntimePins(JSON.parse(await readFile(path.join(root, 'installer/macos/runtime.json'), 'utf8'))), runtime = pins.architectures[arch];
  for (const exe of ['clang', 'hdiutil', 'codesign', 'plutil', 'sips', 'iconutil', 'tar']) await realpath('/usr/bin/' + exe);
  command('/usr/bin/clang', ['--version']);
  const sourceCommit = command('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw Error('Exact source commit is required for macOS package provenance.');
  await ordinary(root, true); await ordinaryDirectory(path.join(root, 'dist')); const out = path.join(root, 'dist/macos'); await ordinaryDirectory(out);
  const stem = `AIPLAY-Studio-macOS-${arch}`, lockPath = path.join(out, `.build-${arch}.lock`), lock = await open(lockPath, 'wx', 0o600);
  const token = randomUUID(); let completed = false;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, token, sourceCommit, architecture: arch, startedAt: new Date().toISOString() })); await lock.sync();
    for (const file of [stem + '.dmg', stem + '.build-metadata.json']) await absent(path.join(out, file));
    const cache = path.join(out, '.cache'); await ordinaryDirectory(cache);
    const checksums = path.join(cache, `SHASUMS256-${pins.nodeVersion}.txt`), archive = path.join(cache, runtime.file);
    for (const file of [checksums, archive]) { try { await ordinary(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    await downloadVerified(pins.checksums.url, checksums, { ...pins.checksums, fetchFn });
    verifyChecksumListing(await readFile(checksums, 'utf8'), runtime);
    await downloadVerified(runtime.url, archive, { ...runtime, fetchFn });
    const top = `node-v${pins.nodeVersion}-darwin-${arch}`;
    validateRuntimeListing(command('/usr/bin/tar', ['-tzf', archive]).toString(), top);
    const stage = await mkdtemp(path.join(out, `.stage-${arch}-`)), extract = path.join(stage, 'extract'), media = path.join(stage, 'media');
    await mkdir(extract); await mkdir(media);
    command('/usr/bin/tar', ['-xzf', archive, '--no-same-owner', '--no-same-permissions', '-C', extract]);
    const sourceFiles = await Promise.all(MACOS_SOURCE_FILES.map(file => info(root, file)));
    const built = await stageMacBundle({ root, bundle: path.join(media, 'AIPLAY Studio.app'), runtimeRoot: path.join(extract, top), arch, pins,
      command, provenance: { sourceCommit, sourceFiles } });
    await symlink('/Applications', path.join(media, 'Applications'));
    await writeFile(path.join(media, 'READ ME.txt'), 'AIPLAY Studio macOS preview\n\nDrag AIPLAY Studio.app into Applications, then open it.\n'
      + 'The app bundle stays unchanged; Studio is installed into your own Application Support folder.\n'
      + 'This preview is ad-hoc signed, not Developer ID signed or notarized. macOS may block it.\n'
      + 'Do not disable Gatekeeper. Source and build instructions: https://github.com/Senzube4n/AIPLAY-Studio\n');
    const dmg = path.join(stage, stem + '.dmg');
    command('/usr/bin/hdiutil', ['create', '-volname', 'AIPLAY Studio', '-srcfolder', media, '-format', 'UDZO', dmg], { timeout: 300_000 });
    command('/usr/bin/hdiutil', ['verify', dmg], { timeout: 300_000 });
    await ordinary(dmg); await copyFile(dmg, path.join(out, stem + '.dmg'), constants.COPYFILE_EXCL);
    const metadata = { schemaVersion: 1, setupVersion: MACOS_SETUP_VERSION, sourceCommit,
      sourceUrl: `https://github.com/Senzube4n/AIPLAY-Studio/tree/${sourceCommit}`,
      sourceModified: Boolean(command('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root }).toString().trim()),
      builtAtUtc: new Date().toISOString(), platform: 'darwin', architecture: arch, minimumMacOS: MINIMUM_MACOS,
      builderNode: process.version, privateNode: pins.nodeVersion, privateNpm: pins.npmVersion,
      runtime: { ...runtime, checksums: pins.checksums, checksumVerifiedBeforeExtraction: true, nativeValidation: built.nativeValidation, nodeFile: built.node },
      signing: { mode: 'ad-hoc', developerId: false, notarized: false, codesignDeepStrictVerified: true, gatekeeperAcceptanceNotAssumed: true },
      appOrModelsStartedDuringBuild: false, privateNodeIdentityOnlyExecuted: built.nativeValidation !== null, releasePublished: false,
      bundle: built.bundle, entry: built.entry, sourceFiles, artifacts: [await info(out, stem + '.dmg')] };
    await writeFile(path.join(out, stem + '.build-metadata.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
    await writeMacChecksums(out); completed = true;
    console.log(JSON.stringify({ output: out, sourceCommit, architecture: arch, artifacts: [stem + '.dmg', stem + '.build-metadata.json', 'SHA256SUMS.txt'] }));
    return metadata;
  } finally {
    await lock.close();
    // Failed/partial builds retain the exact lock and stage for inspection.
    if (completed && JSON.parse(await readFile(lockPath, 'utf8')).token === token) await rm(lockPath);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseMacBuildArgs(process.argv.slice(2));
  if (options.help) console.log('Native macOS: node scripts/build-macos-installer.mjs --arch=arm64|x64 [--plan]. Writes only dist/macos. Ad-hoc signed preview; not notarized.');
  else if (options.plan) {
    const pins = validateMacRuntimePins(JSON.parse(await readFile(path.join(ROOT, 'installer/macos/runtime.json'))));
    console.log(JSON.stringify({ platform: 'darwin', architecture: options.arch, minimumMacOS: MINIMUM_MACOS, runtime: pins.architectures[options.arch],
      output: `dist/macos/AIPLAY-Studio-macOS-${options.arch}.dmg`, signing: 'ad-hoc', developerId: false, notarized: false }, null, 2));
  } else await buildMacInstaller(options);
}
