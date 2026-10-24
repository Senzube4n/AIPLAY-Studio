/** Actual macOS bundle acceptance. Runs only in the disposable native workflow;
 * ordinary cross-platform gates skip it without installing or starting Studio. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, stat, lstat, realpath, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const enabled = process.platform === 'darwin' && process.env.AIPLAY_MACOS_NATIVE_TEST === '1';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function until(url, process) {
  for (let i = 0; i < 240; i++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return response;
    } catch {}
    if (process.error()) throw Error(`Installed process could not start: ${process.error().message}`);
    if (process.child.exitCode !== null) throw Error(`Installed process exited ${process.child.exitCode}: ${process.output()}`);
    await wait(250);
  }
  throw Error(`Installed process did not become ready: ${process.output()}`);
}
const stopped = new WeakSet();
async function stopOwned(child) {
  if (stopped.has(child)) return;
  stopped.add(child);
  if (!Number.isSafeInteger(child.pid)) return;
  // Only the new detached group created by this fixture is eligible for stop.
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  for (let i = 0; i < 40; i++) {
    try { process.kill(-child.pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await wait(100);
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
function launch(command, args, env, cwd) {
  const child = spawn(command, args, { env, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', error = null;
  child.stdout.on('data', data => { output = (output + data).slice(-24_000); });
  child.stderr.on('data', data => { output = (output + data).slice(-24_000); });
  child.on('error', value => { error = value; });
  return { child, output: () => output, error: () => error };
}
async function hostEvents(file, hostPid) {
  let text;
  try {
    const info = await lstat(file);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 64 * 1024, 'Native host events remain a bounded ordinary file.');
    text = await readFile(file, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const lines = text.split('\n');
  lines.pop(); // A concurrent append may leave the last JSONL record incomplete.
  return lines.filter(Boolean).map(line => {
    const event = JSON.parse(line);
    assert.ok(['child-started', 'url-ready', 'reopen', 'child-exit'].includes(event.event), 'Known native host event.');
    assert.equal(event.hostPid, hostPid, 'Finder reuses the original registered application host.');
    assert.ok(Number.isSafeInteger(event.childPid) && event.childPid > 0);
    if (event.event === 'url-ready') {
      const url = new URL(event.url);
      assert.ok(['setup', 'launcher'].includes(event.kind));
      assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
      assert.ok(Number(url.port) > 0 && Number(url.port) <= 65535 && !url.username && !url.password);
    }
    return event;
  });
}
async function untilHostEvent(file, run, accept) {
  for (let i = 0; i < 300; i++) {
    const events = await hostEvents(file, run.child.pid);
    if (accept(events)) return events;
    if (run.error()) throw run.error();
    assert.equal(run.child.exitCode, null, `Native GUI host exited early: ${run.output()}`);
    await wait(50);
  }
  throw Error('The native GUI host did not record the expected Finder event.');
}
function assertSingleNodeChild(hostPid, childPid) {
  const text = execFileSync('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,comm='], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 5000 });
  const children = text.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line))
    .filter(match => match && Number(match[2]) === hostPid);
  assert.equal(children.length, 1, 'The owned AppKit host has exactly one direct child.');
  assert.equal(Number(children[0][1]), childPid, 'The original bootstrap child is still running.');
  assert.equal(path.basename(children[0][3]), 'node');
  process.kill(childPid, 0);
}

test('actual macOS app installs, repairs, launches and preserves user data', {
  skip: !enabled && 'requires the explicit disposable macOS bundle workflow', timeout: 12 * 60_000,
}, async t => {
  const smoke = process.env.AIPLAY_MACOS_SMOKE_ROOT;
  assert.ok(smoke && path.isAbsolute(smoke) && path.basename(smoke).startsWith('aiplay-macos-smoke-'));
  const bundle = process.env.AIPLAY_MACOS_APP;
  assert.ok(bundle && path.isAbsolute(bundle) && path.basename(bundle) === 'AIPLAY Studio.app');
  const repo = process.env.GITHUB_REPOSITORY;
  const ref = process.env.GITHUB_SHA;
  assert.match(repo || '', /^[\w.-]+\/[\w.-]+$/);
  assert.match(ref || '', /^[a-f0-9]{40}$/);
  const home = path.join(smoke, 'home with spaces');
  const data = path.join(home, 'Library', 'Application Support', 'AIPLAY Studio');
  const app = path.join(data, 'app');
  const profile = path.join(home, '.aiplay-studio');
  const entry = path.join(bundle, 'Contents', 'MacOS', 'AIPLAY Studio');
  const runtime = path.join(bundle, 'Contents', 'Resources', 'runtime', 'bin', 'node');
  for (const file of [entry, runtime]) {
    assert.ok((await stat(file)).isFile(), file);
    assert.ok((await realpath(file)).startsWith(await realpath(bundle) + path.sep), 'Bundle executable stays inside the copied app.');
  }
  const pins = JSON.parse(await readFile(new URL('../installer/macos/runtime.json', import.meta.url), 'utf8'));
  const identity = JSON.parse(execFileSync(runtime, ['-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})'], { encoding: 'utf8' }));
  assert.deepEqual(identity, { version: `v${pins.nodeVersion}`, platform: 'darwin', arch: process.arch });
  const bundledNpm = JSON.parse(await readFile(path.join(bundle, 'Contents', 'Resources', 'runtime', 'lib', 'node_modules', 'npm', 'package.json'), 'utf8'));
  assert.equal(bundledNpm.version, pins.npmVersion);

  await mkdir(profile, { recursive: true });
  const port = await freePort();
  let studioPort = await freePort();
  while (studioPort === port) studioPort = await freePort();
  const env = { ...process.env, HOME: home, AIPLAY_APPDATA: profile,
    AIPLAY_LAUNCHER_NO_WINDOW: '1', AIPLAY_LAUNCHER_PORT: String(port), AIPLAY_UI_PORT: String(studioPort) };
  // No external Node/npm is on the incoming PATH. Only system helper commands
  // needed by the bootstrap are supplied; its own runtime must run npm.
  const minimalPath = path.join(smoke, 'minimal commands');
  await mkdir(minimalPath, { recursive: true });
  for (const command of ['dirname', 'tar']) await symlink('/usr/bin/' + command, path.join(minimalPath, command));
  const commands = ['--install-only', '--repo', repo, '--ref', ref];
  const installed = execFileSync(entry, commands, { env: { ...env, PATH: minimalPath }, encoding: 'utf8', timeout: 5 * 60_000 });
  assert.match(installed, /(?:installed|ready|complete)/i);
  const info = JSON.parse(await readFile(path.join(app, 'install-info.json'), 'utf8'));
  assert.equal(info.commit, ref);
  assert.equal(info.repo, repo);
  assert.equal(info.macosBootstrap.version, 1);
  for (const file of ['shared/model-profiles.js', 'scripts/verify-install.mjs',
    'node_modules/ws/package.json', 'node_modules/three/package.json', 'node_modules/ag-psd/package.json',
    'node_modules/gltf-validator/package.json', 'node_modules/@pixiv/three-vrm/package.json']) {
    assert.ok((await stat(path.join(app, file))).isFile(), file);
  }
  assert.equal(existsSync(path.join(app, 'AIPLAY Studio.exe')), false);
  assert.equal(existsSync(path.join(app, 'AIPLAY Studio.cmd')), false);
  const custom = path.join(app, 'workflows', 'custom', 'mine.json');
  await mkdir(path.dirname(custom), { recursive: true });
  await writeFile(custom, '{"myWorkflow":true}\n');
  await writeFile(path.join(profile, 'settings.json'), '{"macosAcceptanceSentinel":"keep","prefs":{"level":"advanced"}}\n');
  await writeFile(path.join(profile, 'keep-project.txt'), 'My existing project and media stay here.\n');
  const settingsBefore = await readFile(path.join(profile, 'settings.json'), 'utf8');
  execFileSync(entry, [...commands, '--repair'], { env, encoding: 'utf8', timeout: 5 * 60_000 });
  assert.equal(await readFile(custom, 'utf8'), '{"myWorkflow":true}\n');
  assert.equal(await readFile(path.join(profile, 'settings.json'), 'utf8'), settingsBefore);
  assert.equal(await readFile(path.join(profile, 'keep-project.txt'), 'utf8'), 'My existing project and media stay here.\n');

  const launcher = launch(entry, ['--no-open'], env, home);
  t.after(() => stopOwned(launcher.child));
  try {
    const ping = await until(`http://127.0.0.1:${port}/api/ping`, launcher);
    assert.equal((await ping.json()).app, 'aiplay-launcher');
    assert.match(await (await fetch(`http://127.0.0.1:${port}/`)).text(), /AIPLAY/i);
  } finally { await stopOwned(launcher.child); }

  // Real AppKit mode must receive normal Finder reopen events. LaunchServices
  // uses the already registered host, with its original isolated environment.
  const eventFile = path.join(data, 'native-entry.jsonl');
  assert.equal(existsSync(eventFile), false, 'Headless setup did not start a native GUI host.');
  const infoBeforeGui = await readFile(path.join(app, 'install-info.json'), 'utf8');
  const gui = launch(entry, [], env, home);
  t.after(() => stopOwned(gui.child));
  let guiReopen;
  try {
    const ping = await until(`http://127.0.0.1:${port}/api/ping`, gui);
    assert.equal((await ping.json()).app, 'aiplay-launcher');
    let events = await untilHostEvent(eventFile, gui,
      rows => rows.some(row => row.event === 'url-ready' && row.kind === 'launcher'));
    assert.ok(events.some(row => row.event === 'url-ready' && row.kind === 'launcher'
      && new URL(row.url).port === String(port) && new URL(row.url).pathname === '/'), 'GUI host captured this fixture launcher.');
    const started = events.filter(row => row.event === 'child-started');
    assert.equal(started.length, 1);
    assert.equal(started[0].childCount, 1);
    const childPid = started[0].childPid;
    assertSingleNodeChild(gui.child.pid, childPid);
    for (let call = 0; call < 2; call++) {
      const before = events.filter(row => row.event === 'reopen').length;
      execFileSync('/usr/bin/open', [bundle], { env, encoding: 'utf8', timeout: 15000 });
      events = await untilHostEvent(eventFile, gui, rows => rows.filter(row => row.event === 'reopen').slice(before)
        .some(row => row.opened === true));
      assert.equal(events.filter(row => row.event === 'child-started').length, 1, 'Finder reopen did not launch another bootstrap.');
      for (const event of events) {
        assert.equal(event.childPid, childPid);
        if (event.event === 'reopen') assert.equal(event.childCount, 1);
      }
      assertSingleNodeChild(gui.child.pid, childPid);
      assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/ping`)).json()).app, 'aiplay-launcher');
    }
    assert.equal(await readFile(path.join(app, 'install-info.json'), 'utf8'), infoBeforeGui, 'Finder reopen did not replace/reinstall the app.');
    const settingsAfterGui = JSON.parse(await readFile(path.join(profile, 'settings.json'), 'utf8'));
    assert.equal(settingsAfterGui.macosAcceptanceSentinel, 'keep');
    assert.equal(settingsAfterGui.prefs.level, 'advanced');
    assert.equal(await readFile(path.join(profile, 'keep-project.txt'), 'utf8'), 'My existing project and media stay here.\n');
    assert.equal(await readFile(custom, 'utf8'), '{"myWorkflow":true}\n');
    guiReopen = { ok: true, calls: 2, childStarts: 1, hostPid: gui.child.pid, childPid };
  } finally { await stopOwned(gui.child); }

  // Actual installed Studio/DAW CPU startup, without an engine or model job.
  const studio = launch(runtime, [path.join(app, 'server', 'index.js')], {
    ...env, AIPLAY_MUSIC_ONLY: '1', AIPLAY_OPEN: '0',
  }, app);
  t.after(() => stopOwned(studio.child));
  try {
    const status = await (await until(`http://127.0.0.1:${studioPort}/api/status`, studio)).json();
    assert.equal(status.config.musicOnly, true);
    const daw = await fetch(`http://127.0.0.1:${studioPort}/daw.html`);
    assert.equal(daw.status, 200);
    assert.match(await daw.text(), /<!doctype html>/i);
    assert.equal(JSON.parse(await readFile(path.join(profile, 'settings.json'), 'utf8')).macosAcceptanceSentinel, 'keep');
  } finally { await stopOwned(studio.child); }
  // The workflow removes only its copied app bundle and checks these paths.
  await writeFile(path.join(smoke, 'acceptance.json'), JSON.stringify({ ok: true, repo, commit: ref,
    app, profile, bundle, runtime: identity, bundledNpm: bundledNpm.version, guiReopen }, null, 2) + '\n');
});
