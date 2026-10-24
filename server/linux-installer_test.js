/** Packaging contracts and download integrity, without network or a Linux runtime. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { architectureFor, validateRuntimePins, verifyChecksumListing, validateRuntimeListing,
  debControl, downloadVerified, digest, writeLinuxChecksums, LINUX_SETUP_VERSION } from '../scripts/build-linux-installer.mjs';

const pins = JSON.parse(await readFile(new URL('../installer/linux/runtime.json', import.meta.url), 'utf8'));
const source = relative => readFile(new URL('../' + relative, import.meta.url), 'utf8');
async function fixture(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'aiplay-linux-packaging-'));
  try { return await run(dir); }
  finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(tmpdir()));
    assert.match(path.basename(dir), /^aiplay-linux-packaging-/);
    await rm(dir, { recursive: true, force: true });
  }
}

test('Linux architectures use Debian names and exact official Node/npm release pins', () => {
  assert.deepEqual(architectureFor('amd64'), { node: 'x64', debian: 'amd64' });
  assert.deepEqual(architectureFor('arm64'), { node: 'arm64', debian: 'arm64' });
  assert.throws(() => architectureFor('x86'), /supports/);
  assert.equal(validateRuntimePins(pins), pins);
  assert.equal(pins.nodeVersion, '24.22.1');
  assert.equal(pins.npmVersion, '11.19.1');
  const altered = structuredClone(pins);
  altered.architectures.x64.url = 'https://other.example/runtime';
  assert.throws(() => validateRuntimePins(altered), /official x64/);
  altered.architectures.x64 = { ...pins.architectures.x64, bytes: 2 ** 31 };
  assert.throws(() => validateRuntimePins(altered), /official x64/);
});

test('official checksum listing and runtime tar paths are checked before extraction', () => {
  const row = pins.architectures.x64;
  verifyChecksumListing(`${row.sha256}  ${row.file}\n`, row);
  assert.throws(() => verifyChecksumListing(`wrong  ${row.file}\n`, row), /checksum listing/);
  assert.throws(() => verifyChecksumListing(`${row.sha256}  ${row.file}\n${row.sha256}  ${row.file}\n`, row), /checksum listing/);
  const top = 'node-v24.22.1-linux-x64';
  const listing = [top + '/', top + '/bin/node', top + '/LICENSE', top + '/lib/node_modules/npm/package.json'].join('\n');
  assert.equal(validateRuntimeListing(listing, top).length, 4);
  for (const bad of ['../outside', top + '/../outside', '/' + top + '/bin/node', top + '\\bad']) {
    assert.throws(() => validateRuntimeListing(listing + '\n' + bad, top), /Unsafe/);
  }
  assert.throws(() => validateRuntimeListing(top + '/bin/node', top), /Incomplete/);
});

test('bounded verified download writes exact bytes, reuses only verified cache, and never runs content', async () => fixture(async dir => {
  const bytes = Buffer.from('not executable: fixture runtime bytes');
  const destination = path.join(dir, 'runtime.tar.gz');
  let fetched = 0;
  const fetchFn = async (url, options) => {
    fetched++;
    assert.equal(url, 'https://nodejs.org/dist/fixture/runtime.tar.gz');
    assert.equal(options.redirect, 'error');
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  };
  const contract = { sha256: digest(bytes), bytes: bytes.length, fetchFn };
  assert.equal((await downloadVerified('https://nodejs.org/dist/fixture/runtime.tar.gz', destination, contract)).cached, false);
  assert.deepEqual(await readFile(destination), bytes);
  assert.equal((await downloadVerified('https://nodejs.org/dist/fixture/runtime.tar.gz', destination, contract)).cached, true);
  assert.equal(fetched, 1);
  assert.deepEqual(await readdir(dir), ['runtime.tar.gz'], 'successful verified partial is removed');
  await writeFile(destination, 'tampered');
  await assert.rejects(downloadVerified('https://nodejs.org/dist/fixture/runtime.tar.gz', destination, contract), /cache differs/);
  assert.equal(fetched, 1, 'a bad existing cache is inspected, not silently redownloaded');
}));

test('wrong hashes, oversized bodies and nonofficial URLs never publish a runtime cache', async () => fixture(async dir => {
  const bytes = Buffer.from('good');
  const destination = path.join(dir, 'runtime.tar.gz');
  await assert.rejects(downloadVerified('https://attacker.example/file', destination,
    { bytes: bytes.length, sha256: digest(bytes), fetchFn: () => { throw new Error('must not fetch'); } }), /official HTTPS/);
  await assert.rejects(downloadVerified('https://nodejs.org/dist/test', destination,
    { bytes: bytes.length, sha256: digest(bytes), fetchFn: async () => new Response('evil') }), /SHA-256 mismatch/);
  await assert.rejects(readFile(destination), { code: 'ENOENT' });
  await assert.rejects(downloadVerified('https://nodejs.org/dist/test', destination,
    { bytes: bytes.length, sha256: digest(bytes), fetchFn: async () => new Response('too long') }), /exceeded/);
  await assert.rejects(readFile(destination), { code: 'ENOENT' });
  await assert.rejects(downloadVerified('https://nodejs.org/dist/test', destination,
    { bytes: bytes.length, sha256: digest(bytes), fetchFn: async () => new Response(bytes, { headers: { 'content-length': '10' } }) }), /Content-Length/);
}));

test('Debian control and desktop launcher declare the supported runtime and graphical entry', async () => {
  const control = debControl('arm64', 123);
  assert.match(control, /^Package: aiplay-studio$/m);
  assert.match(control, new RegExp(`^Version: ${LINUX_SETUP_VERSION.replaceAll('.', '\\.')}$$`, 'm'));
  assert.match(control, /^Architecture: arm64$/m);
  for (const dependency of ['libc6', 'libstdc++6', 'xdg-utils', 'ca-certificates', 'tar']) assert.ok(control.includes(dependency));
  assert.throws(() => debControl('x64', -1), /size/);
  const desktop = await source('installer/linux/aiplay-studio.desktop');
  assert.match(desktop, /^Exec=\/usr\/bin\/aiplay-studio$/m);
  assert.match(desktop, /^TryExec=\/usr\/bin\/aiplay-studio$/m);
  assert.match(desktop, /^Icon=aiplay-studio$/m);
  assert.match(desktop, /^Terminal=false$/m);
  assert.match(desktop, /^StartupNotify=false$/m);
  const wrapper = await source('installer/linux/aiplay-studio');
  assert.ok(wrapper.startsWith('#!/bin/sh\n'));
  assert.doesNotMatch(wrapper, /\r|\bsudo\b|\.bashrc|\.profile/);
  assert.match(wrapper, /exec "\$app_dir\/runtime\/bin\/node" "\$app_dir\/bootstrap\.mjs" "\$@"/);
});

test('release checksum manifest includes only named Linux artifacts and preserves unrelated output', async () => fixture(async dir => {
  const expected = ['AIPLAY-Studio-Linux-amd64.deb', 'AIPLAY-Studio-Linux-amd64.tar.gz', 'AIPLAY-Studio-Linux-amd64.build-metadata.json'];
  for (const file of [...expected, 'unrelated.txt']) await writeFile(path.join(dir, file), file);
  await mkdir(path.join(dir, '.cache'));
  await writeLinuxChecksums(dir);
  const lines = (await readFile(path.join(dir, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 3);
  for (const file of expected) assert.ok(lines.includes(digest(Buffer.from(file)) + '  ' + file));
  assert.equal(await readFile(path.join(dir, 'unrelated.txt'), 'utf8'), 'unrelated.txt');
}));

test('portable POSIX entry uses its own runtime from a path with spaces and forwards arguments', { skip: process.platform !== 'linux' }, async () => fixture(async dir => {
  const app = path.join(dir, 'portable folder with spaces');
  await mkdir(path.join(app, 'runtime/bin'), { recursive: true });
  const entry = path.join(app, 'aiplay-studio');
  const node = path.join(app, 'runtime/bin/node');
  await writeFile(entry, await source('installer/linux/aiplay-studio'));
  await writeFile(path.join(app, 'bootstrap.mjs'), 'fixture');
  await writeFile(node, '#!/bin/sh\nprintf "%s\\n" "$@" "$PATH"\n');
  await chmod(entry, 0o755); await chmod(node, 0o755);
  const lines = execFileSync(entry, ['--no-open', '--ref', 'argument with spaces'], { cwd: dir, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(lines.slice(0, 4), [path.join(app, 'bootstrap.mjs'), '--no-open', '--ref', 'argument with spaces']);
  assert.ok(lines[4].startsWith(path.join(app, 'runtime/bin') + ':'));
}));
