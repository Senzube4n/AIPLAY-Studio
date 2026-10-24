import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm, lstat, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { defaultDataRoot, parseOptions, macosManifest, validateArchiveEntries, extractSource, installStudio, startLauncher, statusPage, probeRunning, reuseLauncher } from '../installer/macos/bootstrap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA = 'a'.repeat(40), NEXT = 'b'.repeat(40), REPO = 'fixture/Studio';
const run = promisify(execFile);
const manifest = () => ({ include: ['server', 'launcher', 'scripts', 'web', 'workflows', 'package.json', 'package-lock.json', 'install.json', 'AIPLAY Studio.exe', 'AIPLAY Studio.cmd'],
  required: ['server/index.js', 'launcher/launcher.mjs', 'scripts/verify-install.mjs', 'web/index.html', 'package.json', 'package-lock.json', 'install.json', 'AIPLAY Studio.exe', 'AIPLAY Studio.cmd'],
  exclude: ['*_test.js', '*.md'], keep: ['LICENSE*'], preserve: ['workflows/custom'],
  platforms: { darwin: { omit: ['AIPLAY Studio.exe', 'AIPLAY Studio.cmd'] } } });

function header(name, size, type = '0', mode = 0o644) {
  const h = Buffer.alloc(512);
  if (Buffer.byteLength(name) > 100) {
    const split = name.lastIndexOf('/');
    assert.ok(split > 0 && Buffer.byteLength(name.slice(split + 1)) <= 100 && Buffer.byteLength(name.slice(0, split)) <= 155);
    h.write(name.slice(0, split), 345, 155); name = name.slice(split + 1);
  }
  h.write(name, 0, 100); h.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12); h.fill(32, 148, 156); h.write(type, 156, 1);
  h.write('ustar\0', 257); h.write('00', 263);
  const sum = h.reduce((a, b) => a + b, 0); h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}
function archive(entries) {
  const buffers = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data || '');
    buffers.push(header(entry.name, data.length, entry.type || '0', entry.mode), data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...buffers, Buffer.alloc(1024)]));
}
function pax(key, value) {
  const text = `${key}=${value}\n`; let length = Buffer.byteLength(text) + 2;
  while (Buffer.byteLength(String(length)) + 1 + Buffer.byteLength(text) !== length) length = Buffer.byteLength(String(length)) + 1 + Buffer.byteLength(text);
  return `${length} ${text}`;
}
async function fixtures(t, options = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'aiplay macOS setup with spaces '));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('aiplay macOS setup with spaces '));
    return rm(home, { recursive: true, force: true });
  });
  const dataRoot = defaultDataRoot({}, home);
  const resources = path.join(home, 'Applications', 'AIPLAY Studio.app', 'Contents', 'Resources');
  const npmCli = path.join(resources, 'runtime', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await mkdir(path.dirname(npmCli), { recursive: true }); await writeFile(npmCli, '// fixture, never executed\n');
  const raw = manifest(), files = {
    'install.json': JSON.stringify(raw), 'package.json': JSON.stringify({ type: 'module', name: 'fixture', version: '1.0.0' }),
    'package-lock.json': '{}', 'server/index.js': "import './dependency.js';\n", 'server/dependency.js': 'export const ready = true;\n',
    'launcher/launcher.mjs': 'export const launcher = true;\n', 'web/index.html': '<!doctype html><title>fixture</title>',
    'scripts/verify-install.mjs': await readFile(path.join(ROOT, 'scripts', 'verify-install.mjs')),
    'scripts/install-manifest.mjs': await readFile(path.join(ROOT, 'scripts', 'install-manifest.mjs')),
    'server/should_not_ship_test.js': 'throw Error("do not ship");', 'workflows/custom/default.json': '{"source":true}',
    'notes/outside.txt': 'not selected by the manifest', ...options.files,
  };
  const calls = [], commands = [];
  let revision = SHA;
  const packed = () => archive(Object.entries(files).map(([name, data]) => ({ name: `Studio-${revision}/${name}`, data })));
  const fetchFn = async (url, config) => {
    calls.push({ url, config });
    if (url === `https://api.github.com/repos/${REPO}/commits/${options.ref || 'main'}`) return new Response(JSON.stringify({ sha: revision, commit: { committer: { date: '2026-10-24T12:00:00Z' } } }));
    if (url.startsWith(`https://api.github.com/repos/${REPO}/compare/`)) return new Response(JSON.stringify(options.comparison || { status: 'ahead', ahead_by: 1, behind_by: 0 }));
    assert.equal(url, `https://codeload.github.com/${REPO}/tar.gz/${revision}`);
    return new Response(options.archive || packed());
  };
  const command = async (executable, args, config) => {
    commands.push({ executable, args, config });
    assert.equal(executable, process.execPath);
    if (args[0] === npmCli) {
      assert.deepEqual(args.slice(1), ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
      assert.equal(config.env.npm_config_ignore_scripts, 'true');
      assert.ok(config.env.PATH.startsWith(path.dirname(process.execPath) + path.delimiter));
      return '';
    }
    assert.deepEqual(args.slice(-2), ['--platform', 'darwin']);
    const result = await run(executable, args, { cwd: config.cwd, env: config.env, timeout: 30_000 });
    return result.stdout;
  };
  return { home, dataRoot, resources, npmCli, files, calls, commands, packed, setRevision: next => { revision = next; },
    options: { dataRoot, npmCli, repo: REPO, fetchFn, command, runtimeCheck: async () => ({ busy: false }), ...options.installOptions } };
}

test('macOS app data uses Application Support and rejects arbitrary CLI folders, refs and URLs', () => {
  const home = path.resolve('Users/person with spaces');
  const expected = path.join(home, 'Library', 'Application Support', 'AIPLAY Studio');
  assert.equal(defaultDataRoot({}, home), expected);
  assert.equal(defaultDataRoot({ XDG_DATA_HOME: '/ignored', AIPLAY_APPDATA: '/settings-only' }, home), expected);
  assert.throws(() => defaultDataRoot({}, 'relative'), /absolute/);
  assert.deepEqual(parseOptions(['--install-only', '--repair', '--no-open', '--repo', REPO, '--ref', SHA]),
    { repo: REPO, ref: SHA, installOnly: true, repair: true, noOpen: true, help: false });
  for (const args of [['--ref', 'other-branch'], ['--ref', 'a'.repeat(7)], ['--repo', 'https://evil.test/repo'], ['--repo', '../repo'], ['--repo'], ['--command', 'echo'], ['--data-root', '/elsewhere']]) assert.throws(() => parseOptions(args));
});

test('macOS selection omits only the two Windows entrypoints and keeps required startup files', () => {
  const selected = macosManifest(manifest());
  assert.ok(!selected.include.includes('AIPLAY Studio.exe')); assert.ok(!selected.required.includes('AIPLAY Studio.cmd'));
  assert.ok(selected.required.includes('scripts/verify-install.mjs'));
  const malformed = manifest(); malformed.platforms.darwin.omit.push('server'); assert.throws(() => macosManifest(malformed), /supported macOS/);
  const unsafe = manifest(); unsafe.preserve = ['../personal']; assert.throws(() => macosManifest(unsafe), /preserve/);
  const invalid = manifest(); invalid.include.push('.git'); assert.throws(() => macosManifest(invalid), /include/);
});

test('the actual shipping manifest supports macOS while preserving the optional outside-include toolkit', async () => {
  const actual = JSON.parse(await readFile(path.join(ROOT, 'install.json'))), selected = macosManifest(actual);
  assert.ok(selected.preserve.includes('vendor/previz-blender'));
  assert.ok(selected.required.includes('shared/model-profiles.js'));
  assert.ok(!selected.required.includes('AIPLAY Studio.exe'));
});

test('archive path gate refuses traversal, absolute paths, links and duplicate or mixed roots', () => {
  assert.equal(validateArchiveEntries([{ name: 'app/' , type: '5' }, { name: 'app/file with spaces', type: '0' }]), 'app');
  for (const entries of [[{ name: '../escape' }], [{ name: '/app/file' }], [{ name: 'app/link', type: '2' }], [{ name: 'app/hard', type: '1' }],
    [{ name: 'app/File' }, { name: 'app/file' }], [{ name: 'one/file' }, { name: 'two/file' }], [{ name: 'app\\file' }]]) assert.throws(() => validateArchiveEntries(entries));
});

test('streaming extraction handles Git PAX paths and rejects a malicious extended path', async t => {
  const f = await fixtures(t), destination = path.join(f.home, 'unpacked'); await mkdir(destination);
  const long = 'repo/' + 'directory/'.repeat(13) + 'file.txt';
  const file = path.join(f.home, 'pax.tar.gz');
  await writeFile(file, archive([{ name: 'pax_global_header', type: 'g', data: pax('comment', SHA) },
    { name: 'repo/pax', type: 'x', data: pax('path', long) }, { name: 'repo/short', data: 'actual PAX bytes' }]));
  await extractSource(file, destination);
  assert.equal(await readFile(path.join(destination, ...long.split('/')), 'utf8'), 'actual PAX bytes');
  const bad = path.join(f.home, 'bad.tar.gz'), badOut = path.join(f.home, 'bad-out'); await mkdir(badOut);
  await writeFile(bad, archive([{ name: 'repo/pax', type: 'x', data: pax('path', '../escape') }, { name: 'repo/short', data: 'no' }]));
  await assert.rejects(extractSource(bad, badOut), /unsafe path/);
  await assert.rejects(lstat(path.join(f.home, 'escape')), { code: 'ENOENT' });
});

test('fresh install stages selected payload, disables lifecycle scripts, validates real imports and records exact source/hash', async t => {
  const f = await fixtures(t), hash = createHash('sha256').update(f.packed()).digest('hex');
  const result = await installStudio({ ...f.options, expectedArchiveSha256: hash });
  assert.equal(result.changed, true); assert.equal(result.commit, SHA); assert.equal(result.archiveSha256, hash);
  assert.equal(result.validation.ok, true); assert.ok(result.validation.modulesChecked >= 4);
  const info = JSON.parse(await readFile(path.join(result.app, 'install-info.json')));
  assert.equal(info.repo, REPO); assert.equal(info.commit, SHA); assert.equal(info.macosBootstrap.archiveSha256, hash);
  assert.equal(info.macosBootstrap.archiveCommit, SHA);
  const version = JSON.parse(await readFile(path.join(result.app, 'server/version.gen.json')));
  assert.equal(version.commit, SHA); assert.equal(version.source, 'macos-setup');
  assert.equal(f.commands.length, 2);
  for (const absent of ['AIPLAY Studio.exe', 'server/should_not_ship_test.js', 'notes/outside.txt']) await assert.rejects(lstat(path.join(result.app, absent)), { code: 'ENOENT' });
  assert.equal((await readdir(f.dataRoot)).some(name => name.startsWith('.setup-') || name === 'install.lock'), false);
  assert.ok(f.calls.every(call => call.config.redirect === 'error'));
});

test('ordinary later launch uses the owned install without a download or dependency command', async t => {
  const f = await fixtures(t); await installStudio(f.options);
  f.calls.length = 0; f.commands.length = 0;
  const result = await installStudio(f.options);
  assert.equal(result.changed, false); assert.equal(f.calls.length, 0); assert.equal(f.commands.length, 0);
});

test('Mac staging never writes inside the app bundle or changes a separate Linux installation', async t => {
  const f = await fixtures(t);
  const bundleSentinel = path.join(f.resources, 'immutable-bundle.txt');
  await writeFile(bundleSentinel, 'Bundle bytes stay unchanged.');
  const npmBefore = await readFile(f.npmCli);
  const linuxApp = path.join(f.home, '.local', 'share', 'aiplay-studio', 'app');
  await mkdir(linuxApp, { recursive: true });
  const linuxMarker = path.join(linuxApp, 'install-info.json');
  const linuxBytes = JSON.stringify({ repo: REPO, commit: SHA, linuxBootstrap: { version: 1 } });
  await writeFile(linuxMarker, linuxBytes);
  const result = await installStudio(f.options);
  assert.equal(result.app, path.join(f.home, 'Library', 'Application Support', 'AIPLAY Studio', 'app'));
  const info = JSON.parse(await readFile(path.join(result.app, 'install-info.json')));
  assert.equal(info.macosBootstrap.version, 1); assert.equal(info.linuxBootstrap, undefined);
  await installStudio({ ...f.options, repair: true });
  assert.equal(await readFile(bundleSentinel, 'utf8'), 'Bundle bytes stay unchanged.');
  assert.deepEqual(await readFile(f.npmCli), npmBefore);
  assert.equal(await readFile(linuxMarker, 'utf8'), linuxBytes);
  assert.ok(f.commands.every(call => call.config.cwd.startsWith(f.dataRoot + path.sep + '.setup-')));
  assert.ok(f.commands.every(call => !call.config.cwd.startsWith(f.resources + path.sep)));
});

test('a Linux marker cannot authorize replacing a folder in the Mac app location', async t => {
  const f = await fixtures(t), app = path.join(f.dataRoot, 'app');
  await mkdir(app, { recursive: true });
  const marker = path.join(app, 'install-info.json');
  const original = JSON.stringify({ repo: REPO, commit: SHA, linuxBootstrap: { version: 1 } });
  await writeFile(marker, original);
  await assert.rejects(installStudio(f.options), /another installation/);
  assert.equal(await readFile(marker, 'utf8'), original); assert.equal(f.calls.length, 0);
});

test('unfinished updater dependencies block both normal and direct launcher starts until repair succeeds', async t => {
  const f = await fixtures(t), first = await installStudio(f.options), pending = path.join(first.app, '.aiplay-update-npm-pending');
  await writeFile(pending, 'unfinished update'); f.calls.length = 0;
  await assert.rejects(installStudio(f.options), /--repair/);
  await assert.rejects(startLauncher(first.app, { spawnFn: () => { throw Error('must not spawn'); } }), /--repair/);
  assert.equal(f.calls.length, 0);
  assert.equal((await installStudio({ ...f.options, repair: true })).ok, true);
  await assert.rejects(lstat(pending), { code: 'ENOENT' });
});

test('repair requires a verified forward ancestry when the requested commit differs', async t => {
  for (const comparison of [{ status: 'behind', ahead_by: 0, behind_by: 1 }, { status: 'diverged', ahead_by: 2, behind_by: 1 }, { status: 'ahead', ahead_by: 1 }, {}]) {
    const f = await fixtures(t, { comparison }), first = await installStudio(f.options); f.setRevision(NEXT); f.calls.length = 0;
    await assert.rejects(installStudio({ ...f.options, repair: true }), /forward update/);
    assert.equal(f.calls.length, 2); assert.ok(f.calls[1].url.endsWith(`/compare/${SHA}...${NEXT}`));
    assert.equal(JSON.parse(await readFile(path.join(first.app, 'install-info.json'))).commit, SHA);
  }
});

test('repair preserves custom workflows and outside personal settings, then cleans its own backup', async t => {
  const f = await fixtures(t); const first = await installStudio(f.options);
  const raw = JSON.parse(f.files['install.json']); raw.preserve.push('vendor/previz-blender'); f.files['install.json'] = JSON.stringify(raw);
  await mkdir(path.join(first.app, 'vendor/previz-blender'), { recursive: true }); await writeFile(path.join(first.app, 'vendor/previz-blender/user.blend'), 'toolkit sentinel');
  await writeFile(path.join(first.app, 'workflows/custom/my project.json'), '{"personal":true}');
  const settings = path.join(f.home, '.aiplay-studio', 'settings.json'); await mkdir(path.dirname(settings)); await writeFile(settings, 'personal settings sentinel');
  f.setRevision(NEXT); f.files['server/dependency.js'] = 'export const ready = "new";\n';
  const result = await installStudio({ ...f.options, repair: true });
  assert.equal(result.commit, NEXT); assert.equal(result.backup, null);
  assert.equal(await readFile(path.join(result.app, 'workflows/custom/my project.json'), 'utf8'), '{"personal":true}');
  assert.equal(await readFile(settings, 'utf8'), 'personal settings sentinel');
  assert.equal(await readFile(path.join(result.app, 'vendor/previz-blender/user.blend'), 'utf8'), 'toolkit sentinel');
  assert.equal((await readdir(f.dataRoot)).some(name => name.startsWith('app.backup-')), false);
  assert.equal((await installStudio({ ...f.options, repair: true })).ok, true);
  assert.equal(JSON.parse(await readFile(path.join(result.app, 'install-info.json'))).commit, NEXT);
});

test('repair refuses a live runtime before downloading, and rechecks immediately before swapping', async t => {
  const f = await fixtures(t); const first = await installStudio(f.options); f.calls.length = 0;
  await assert.rejects(installStudio({ ...f.options, repair: true, runtimeCheck: async () => ({ busy: true }) }), /Close the Studio/);
  assert.equal(f.calls.length, 0);
  let checks = 0;
  await assert.rejects(installStudio({ ...f.options, repair: true, runtimeCheck: async () => ({ busy: ++checks === 2 }) }), /started during setup/);
  assert.equal(checks, 2); assert.equal(JSON.parse(await readFile(path.join(first.app, 'install-info.json'))).commit, SHA);
  assert.deepEqual(await readdir(f.dataRoot), ['app']);
});

test('repair refuses preserved-directory ancestor links instead of reading outside the managed app', async t => {
  const f = await fixtures(t); const first = await installStudio(f.options), outside = path.join(f.home, 'outside');
  await mkdir(path.join(outside, 'custom'), { recursive: true }); await writeFile(path.join(outside, 'custom/private.json'), 'private sentinel');
  await rm(path.join(first.app, 'workflows'), { recursive: true });
  await symlink(outside, path.join(first.app, 'workflows'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installStudio({ ...f.options, repair: true }), /unsafe link/);
  assert.equal(await readFile(path.join(outside, 'custom/private.json'), 'utf8'), 'private sentinel');
  assert.equal(JSON.parse(await readFile(path.join(first.app, 'install-info.json'))).commit, SHA);
});

test('bad fresh runtime is refused before any existing app swap', async t => {
  const f = await fixtures(t); const first = await installStudio(f.options);
  const old = await readFile(path.join(first.app, 'server/dependency.js'));
  delete f.files['server/dependency.js']; f.setRevision(NEXT);
  await assert.rejects(installStudio({ ...f.options, repair: true }), /runtime failed validation/);
  assert.deepEqual(await readFile(path.join(first.app, 'server/dependency.js')), old);
  assert.equal(JSON.parse(await readFile(path.join(first.app, 'install-info.json'))).commit, SHA);
  await assert.rejects(lstat(path.join(f.dataRoot, 'app.backup')), { code: 'ENOENT' });
});

test('npm failure and checksum mismatch keep the old app and remove only owned staging', async t => {
  const f = await fixtures(t); const first = await installStudio(f.options);
  await assert.rejects(installStudio({ ...f.options, repair: true, expectedArchiveSha256: '0'.repeat(64) }), /checksum/);
  await assert.rejects(installStudio({ ...f.options, repair: true, command: async () => { throw Error('fixture npm failed'); } }), /fixture npm failed/);
  assert.equal(JSON.parse(await readFile(path.join(first.app, 'install-info.json'))).commit, SHA);
  assert.deepEqual(await readdir(f.dataRoot), ['app']);
});

test('an interrupted swap restores the old app atomically', async t => {
  const f = await fixtures(t); const first = await installStudio(f.options); f.setRevision(NEXT);
  await assert.rejects(installStudio({ ...f.options, repair: true, transactionHook: async phase => { if (phase === 'after-backup') throw Error('fixture swap interruption'); } }), /swap interruption/);
  assert.equal(JSON.parse(await readFile(path.join(first.app, 'install-info.json'))).commit, SHA);
  assert.deepEqual(await readdir(f.dataRoot), ['app']);
});

test('foreign app folders and unknown setup locks are preserved without network calls', async t => {
  const f = await fixtures(t); await mkdir(path.join(f.dataRoot, 'app'), { recursive: true });
  const sentinel = path.join(f.dataRoot, 'app', 'personal.txt'); await writeFile(sentinel, 'keep');
  await assert.rejects(installStudio(f.options), /not managed/); assert.equal(f.calls.length, 0); assert.equal(await readFile(sentinel, 'utf8'), 'keep');
  const lock = path.join(f.dataRoot, 'install.lock'); await writeFile(lock, '{"pid":123,"token":"foreign"}');
  await assert.rejects(installStudio(f.options), /Another setup/); assert.equal(await readFile(lock, 'utf8'), '{"pid":123,"token":"foreign"}');
});

test('concurrent setup is refused while the first setup still owns its exclusive lock', async t => {
  const f = await fixtures(t); let resolveFetch, started, blocked = false;
  const waiting = new Promise(resolve => { started = resolve; });
  const first = installStudio({ ...f.options, fetchFn: async (...args) => { if (!blocked) { blocked = true; started(); await new Promise(resolve => { resolveFetch = resolve; }); } return f.options.fetchFn(...args); } });
  await waiting;
  await assert.rejects(installStudio(f.options), /Another setup/);
  resolveFetch(); assert.equal((await first).ok, true);
});

test('a requested immutable ref must match GitHub metadata before downloading', async t => {
  const f = await fixtures(t, { ref: SHA });
  const mismatch = async (url, config) => url.includes('api.github.com') ? new Response(JSON.stringify({ sha: NEXT, commit: { committer: { date: '2026-10-24T12:00:00Z' } } })) : f.options.fetchFn(url, config);
  await assert.rejects(installStudio({ ...f.options, ref: SHA, fetchFn: mismatch }), /requested source commit/);
  assert.equal(f.calls.length, 0); assert.deepEqual(await readdir(f.dataRoot), []);
});

test('no-open launcher handoff uses the private Node PATH and leaves settings environment unchanged', async t => {
  const f = await fixtures(t); const installed = await installStudio(f.options); let captured;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); const output = [];
  const actual = await startLauncher(installed.app, { noOpen: true, nodePath: '/private runtime/bin/node', onOutput: (...args) => output.push(args),
    spawnFn: (...args) => { captured = args; return child; } });
  assert.equal(actual, child); assert.equal(captured[0], '/private runtime/bin/node');
  assert.equal(captured[2].env.AIPLAY_LAUNCHER_NO_WINDOW, '1');
  assert.equal(captured[2].env.AIPLAY_APPDATA, process.env.AIPLAY_APPDATA);
  assert.ok(captured[2].env.PATH.startsWith(path.dirname('/private runtime/bin/node') + path.delimiter));
  child.stdout.emit('data', Buffer.from('launcher: http://127.0.0.1:4170/\n')); assert.equal(output[0][1], false);
});

test('existing-launcher probing uses only configured loopback endpoints and repeat launch does not create another process', async () => {
  const urls = [];
  const found = await probeRunning({ env: { AIPLAY_LAUNCHER_PORT: '34170', AIPLAY_UI_PORT: '34173' }, fetchFn: async url => {
    urls.push(url); return new Response(JSON.stringify(url.endsWith('/api/ping') ? { app: 'aiplay-launcher' } : { engine: {} }));
  } });
  assert.deepEqual(urls, ['http://127.0.0.1:34170/api/ping', 'http://127.0.0.1:34173/api/status']);
  assert.deepEqual(found, { busy: true, launcherUrl: 'http://127.0.0.1:34170/' });
  let spawned = 0, opened;
  const spawnFn = (file, args) => { spawned++; opened = { file, args }; const child = new EventEmitter(); child.unref = () => {}; return child; };
  assert.equal(await reuseLauncher({ noOpen: false }, { runtimeCheck: async () => found, spawnFn, say: () => {} }), true);
  assert.equal(spawned, 1); assert.deepEqual(opened, { file: '/usr/bin/open', args: [found.launcherUrl] });
  assert.equal(await reuseLauncher({ noOpen: true }, { runtimeCheck: async () => found, spawnFn, say: () => {} }), true); assert.equal(spawned, 1);
  assert.equal(await reuseLauncher({ installOnly: true }, { runtimeCheck: async () => found, spawnFn, say: () => {} }), false);
  await assert.rejects(reuseLauncher({ repair: true }, { runtimeCheck: async () => found }), /Close the Studio/);
});

test('normal owned launch remains valid after the existing updater chooses another managed fork', async t => {
  const f = await fixtures(t); const first = await installStudio(f.options), marker = path.join(first.app, 'install-info.json');
  const info = JSON.parse(await readFile(marker)); info.repo = 'another/Studio'; info.commit = NEXT; await writeFile(marker, JSON.stringify(info));
  f.calls.length = 0;
  const reused = await installStudio(f.options); assert.equal(reused.repo, 'another/Studio'); assert.equal(reused.commit, NEXT); assert.equal(f.calls.length, 0);
  assert.equal(JSON.parse(await readFile(marker)).macosBootstrap.archiveCommit, SHA);
});

test('loopback setup status requires its token path and exact Host and refuses mutation methods', async t => {
  const state = { state: 'working', message: '<fixture text>', log: ['one'] };
  const page = await statusPage(state, { openBrowser: false }); t.after(() => new Promise(resolve => page.server.close(resolve)));
  const good = await fetch(page.url + 'status'); assert.equal(good.status, 200); assert.deepEqual(await good.json(), state);
  assert.match(good.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(new URL('/status', page.url))).status, 404);
  assert.equal((await fetch(page.url, { method: 'POST' })).status, 403);
  const badHost = await new Promise((resolve, reject) => { const req = http.get(page.url, { headers: { Host: 'evil.invalid' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(badHost, 403);
  assert.match(await (await fetch(page.url)).text(), /location\.replace/);
  assert.equal((await fetch(page.url + 'close', { method: 'POST', headers: { Origin: new URL(page.url).origin } })).status, 403);
  state.state = 'failed';
  assert.equal((await fetch(page.url + 'close', { method: 'POST' })).status, 403);
  assert.equal((await fetch(page.url + 'close', { method: 'POST', headers: { Origin: 'https://foreign.invalid' } })).status, 403);
  assert.equal((await fetch(page.url + 'close', { method: 'POST', headers: { Origin: new URL(page.url).origin } })).status, 204);
  await page.closed;
});
