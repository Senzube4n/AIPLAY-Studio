/** Pure macOS package fixtures. No Apple tools, runtime downloads or app launch. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir, symlink } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { macArchitecture, validateMacRuntimePins, parseMacBuildArgs, validateMachO, macTreeReceipt,
  stageMacBundle, writeMacChecksums, MACOS_SOURCE_FILES, MACOS_SETUP_VERSION, MINIMUM_MACOS } from '../scripts/build-macos-installer.mjs';
import { digest, verifyChecksumListing } from '../scripts/build-linux-installer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(await readFile(path.join(ROOT, 'installer/macos/runtime.json')));
function machO(arch) {
  const bytes = Buffer.alloc(64); bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(macArchitecture(arch).cpuType, 4); bytes.writeUInt32LE(2, 12); return bytes;
}
async function fixture(t, arch = 'arm64') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aiplay Mac package with spaces '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = path.join(dir, 'official runtime'), bundle = path.join(dir, 'AIPLAY Studio.app');
  await mkdir(path.join(runtime, 'bin'), { recursive: true }); await mkdir(path.join(runtime, 'lib/node_modules/npm'), { recursive: true });
  await writeFile(path.join(runtime, 'bin/node'), machO(arch)); await writeFile(path.join(runtime, 'LICENSE'), 'fixture license');
  await writeFile(path.join(runtime, 'lib/node_modules/npm/package.json'), JSON.stringify({ version: pins.npmVersion }));
  const calls = [];
  const command = (exe, args) => {
    calls.push({ exe, args });
    if (exe === '/usr/bin/clang') writeFileSync(args[args.indexOf('-o') + 1], machO(arch));
    else if (exe === '/usr/bin/sips') writeFileSync(args[args.indexOf('--out') + 1], 'fixture icon');
    else if (exe === '/usr/bin/iconutil') writeFileSync(args[args.indexOf('-o') + 1], 'fixture icns');
    return Buffer.from('');
  };
  return { dir, runtime, bundle, calls, command, options: { root: ROOT, bundle, runtimeRoot: runtime, arch, pins, command, hostPlatform: 'win32', hostArch: 'x64' } };
}

test('Darwin runtime pins bind both official architectures, checksum listing, Node/npm and minimum OS', () => {
  assert.equal(validateMacRuntimePins(pins), pins); assert.equal(pins.nodeVersion, '24.22.1'); assert.equal(pins.npmVersion, '11.19.1');
  assert.equal(pins.minimumMacOS, '13.5'); assert.equal(MINIMUM_MACOS, '13.5'); assert.equal(MACOS_SETUP_VERSION, '1.0.0');
  assert.deepEqual(macArchitecture('x64'), { node: 'x64', clang: 'x86_64', cpuType: 0x01000007 });
  assert.throws(() => macArchitecture('universal'), /supports/);
  for (const arch of ['arm64', 'x64']) verifyChecksumListing(`${pins.architectures[arch].sha256}  ${pins.architectures[arch].file}\n`, pins.architectures[arch]);
  const changed = structuredClone(pins); changed.architectures.arm64.url = 'https://other.example/runtime'; assert.throws(() => validateMacRuntimePins(changed), /official/);
  changed.architectures.arm64 = { ...pins.architectures.arm64, bytes: 2 ** 31 }; assert.throws(() => validateMacRuntimePins(changed), /official/);
  const old = structuredClone(pins); old.minimumMacOS = '10.15'; assert.throws(() => validateMacRuntimePins(old), /minimum OS/);
});

test('builder options cannot select arbitrary output, runtime URL or unsupported architectures', () => {
  assert.deepEqual(parseMacBuildArgs(['--arch=arm64', '--plan']), { arch: 'arm64', plan: true, help: false });
  assert.equal(parseMacBuildArgs(['--arch', 'x64']).arch, 'x64'); assert.equal(parseMacBuildArgs(['--help'], 'unsupported').help, true);
  for (const args of [['--arch=universal'], ['--arch'], ['--arch=x64', '--arch=arm64'], ['--out=/elsewhere'], ['--runtime=https://other.example']]) assert.throws(() => parseMacBuildArgs(args));
});

test('Mach-O identity rejects wrong architecture, scripts and non-executable file types before execution', () => {
  assert.deepEqual(validateMachO(machO('arm64'), 'arm64'), { format: 'Mach-O 64', architecture: 'arm64' });
  assert.throws(() => validateMachO(machO('arm64'), 'x64'), /architecture/);
  assert.throws(() => validateMachO(Buffer.from('#!/bin/sh\n'), 'x64'), /architecture/);
  const library = machO('x64'); library.writeUInt32LE(6, 12); assert.throws(() => validateMachO(library, 'x64'), /architecture/);
});

test('bundle staging retains private runtime layout, copies byte-exact bootstrap and signs only entry then outer bundle', async t => {
  const f = await fixture(t); const result = await stageMacBundle({ ...f.options, provenance: { sourceCommit: 'a'.repeat(40), signing: { notarized: true } } });
  const resources = path.join(f.bundle, 'Contents/Resources');
  assert.deepEqual(await readFile(path.join(resources, 'bootstrap.mjs')), await readFile(path.join(ROOT, 'installer/macos/bootstrap.mjs')));
  assert.deepEqual(await readFile(path.join(resources, 'index.html')), await readFile(path.join(ROOT, 'installer/macos/index.html')));
  assert.deepEqual(await readFile(path.join(resources, 'runtime/bin/node')), machO('arm64'));
  assert.equal(result.nativeValidation, null, 'Windows fixture does not pretend to run Darwin Node');
  const metadata = JSON.parse(await readFile(path.join(resources, 'package-info.json')));
  assert.equal(metadata.sourceCommit, 'a'.repeat(40)); assert.equal(metadata.signing.notarized, false); assert.equal(metadata.signing.developerId, false);
  const clang = f.calls.find(row => row.exe === '/usr/bin/clang');
  assert.ok(clang.args.includes('-mmacosx-version-min=13.5')); assert.equal(clang.args[clang.args.indexOf('-arch') + 1], 'arm64');
  assert.equal(f.calls.filter(row => row.exe === '/usr/bin/sips').length, 10);
  const signs = f.calls.filter(row => row.exe === '/usr/bin/codesign'); assert.equal(signs.length, 3);
  assert.equal(signs[0].args.at(-1), path.join(f.bundle, 'Contents/MacOS/AIPLAY Studio'));
  assert.equal(signs[1].args.at(-1), f.bundle); assert.ok(signs[2].args.includes('--verify')); assert.ok(signs[2].args.includes('--strict'));
  assert.ok(signs.filter(row => row.args.includes('--sign')).every(row => !row.args.includes('--deep')), 'official Node signature and V8 entitlements are preserved');
  assert.ok(!f.calls.some(row => row.exe.endsWith('/node')), 'pure fixture never executes private runtime');
  assert.equal((await readdir(f.dir)).some(name => name.endsWith('.iconset')), false, 'icon build intermediates do not enter the DMG media');
  assert.equal(result.bundle.sha256, (await macTreeReceipt(f.bundle)).sha256);
});

test('wrong npm or Node architecture refuses the bundle before any compiler/signing command', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.runtime, 'lib/node_modules/npm/package.json'), '{"version":"0.0.0"}');
  await assert.rejects(stageMacBundle(f.options), /different npm/); assert.equal(f.calls.length, 0);
  await writeFile(path.join(f.runtime, 'lib/node_modules/npm/package.json'), JSON.stringify({ version: pins.npmVersion }));
  await writeFile(path.join(f.runtime, 'bin/node'), machO('x64'));
  await assert.rejects(stageMacBundle(f.options), /architecture/); assert.equal(f.calls.length, 0);
});

test('failed native signing cannot be reported as a completed verified package', async t => {
  const f = await fixture(t);
  await assert.rejects(stageMacBundle({ ...f.options, command(exe, args) {
    if (exe === '/usr/bin/codesign') throw Error('fixture signing failed'); return f.command(exe, args);
  } }), /signing failed/);
  assert.equal((await readdir(f.dir)).some(name => name.endsWith('.dmg')), false);
});

test('runtime tree proof is deterministic and rejects an escaping directory link', async t => {
  const f = await fixture(t), first = await macTreeReceipt(f.runtime);
  assert.equal(first.sha256, (await macTreeReceipt(f.runtime)).sha256);
  await writeFile(path.join(f.runtime, 'LICENSE'), 'changed'); assert.notEqual(first.sha256, (await macTreeReceipt(f.runtime)).sha256);
  const outside = path.join(f.dir, 'outside'); await mkdir(outside);
  await symlink(outside, path.join(f.runtime, 'escaping'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(macTreeReceipt(f.runtime), /escapes/);
});

test('checksum publication includes only macOS release outputs and keeps unrelated files', async t => {
  const f = await fixture(t), output = path.join(f.dir, 'dist'); await mkdir(output);
  const files = ['AIPLAY-Studio-macOS-arm64.dmg', 'AIPLAY-Studio-macOS-arm64.build-metadata.json'];
  for (const file of [...files, 'unrelated.txt']) await writeFile(path.join(output, file), file);
  await writeMacChecksums(output);
  const rows = (await readFile(path.join(output, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n'); assert.equal(rows.length, 2);
  for (const file of files) assert.ok(rows.includes(`${digest(Buffer.from(file))}  ${file}`));
  assert.equal(await readFile(path.join(output, 'unrelated.txt'), 'utf8'), 'unrelated.txt');
});

test('real build help and plan remain inert on Windows and declare the exact preview policy', () => {
  const script = path.join(ROOT, 'scripts/build-macos-installer.mjs');
  const help = execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' }); assert.match(help, /not notarized/);
  const plan = JSON.parse(execFileSync(process.execPath, [script, '--arch=x64', '--plan'], { encoding: 'utf8' }));
  assert.equal(plan.architecture, 'x64'); assert.equal(plan.runtime.sha256, pins.architectures.x64.sha256); assert.equal(plan.notarized, false);
  assert.equal(plan.output, 'dist/macos/AIPLAY-Studio-macOS-x64.dmg');
});

test('package provenance includes every direct builder dependency and native entry has owned lifecycle/reopen handling', async () => {
  assert.ok(MACOS_SOURCE_FILES.includes('scripts/build-linux-installer.mjs')); assert.ok(MACOS_SOURCE_FILES.includes('web/assets/aiplay-logo.png'));
  for (const file of MACOS_SOURCE_FILES) assert.ok((await readFile(path.join(ROOT, file))).length > 0);
  const entry = await readFile(path.join(ROOT, 'installer/macos/entry.m'), 'utf8');
  for (const required of ['applicationShouldHandleReopen', 'execv(', 'launchAndReturnError', 'O_NOFOLLOW', 'NSApplicationTerminateReply', 'native-entry.jsonl', 'hasPrefix:@"-psn_"']) assert.ok(entry.includes(required));
  assert.doesNotMatch(entry, /\bsystem\s*\(|\/bin\/sh|killall|pkill|setenv\("AIPLAY_APPDATA"/);
  const plist = await readFile(path.join(ROOT, 'installer/macos/Info.plist'), 'utf8');
  assert.match(plist, /<key>CFBundleExecutable<\/key><string>AIPLAY Studio<\/string>/); assert.match(plist, /<key>LSMinimumSystemVersion<\/key><string>13\.5<\/string>/);
});
