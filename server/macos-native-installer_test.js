/** Actual macOS bundle acceptance. Runs only in the disposable native workflow;
 * ordinary cross-platform gates skip it without installing or starting Studio. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, stat, lstat, realpath, symlink, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { tmpdir } from 'node:os';

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
function redactedDiagnosticText(value, limit = 2048) {
  return String(value || '').replace(/https?:\/\/[^\s<>"']+/gi, '[URL redacted]')
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[credential redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [credential redacted]')
    .replace(/\bAuthorization\s*:[^\r\n]*/gi, 'Authorization: [redacted]')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(-limit);
}
function redactedEventRows(rows) {
  return rows.slice(-24).map(row => {
    const result = {};
    for (const key of ['event', 'kind']) if (typeof row?.[key] === 'string') result[key] = redactedDiagnosticText(row[key], 64);
    for (const key of ['hostPid', 'childPid', 'childCount', 'status']) if (Number.isSafeInteger(row?.[key])) result[key] = row[key];
    if (typeof row?.opened === 'boolean') result.opened = row.opened;
    return result;
  });
}
async function nativeDiagnostic(file, run, phase, outcome, error = null) {
  let rows = [], eventFileBytes = 0, eventReadError = null, incompleteLastRecord = false;
  try {
    const info = await lstat(file);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 64 * 1024);
    eventFileBytes = info.size;
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n'); incompleteLastRecord = Boolean(lines.pop());
    for (const line of lines.filter(Boolean)) {
      try { rows.push(JSON.parse(line)); }
      catch { eventReadError = 'A complete native event row was not valid JSON.'; }
    }
  } catch (value) { eventReadError = value.code === 'ENOENT' ? 'Native event file does not exist.' : redactedDiagnosticText(value.message, 512); }
  return { schemaVersion: 1, phase, outcome, checkedAtUtc: new Date().toISOString(),
    commit: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || '') ? process.env.GITHUB_SHA : null,
    host: { pid: run.child.pid ?? null, exitCode: run.child.exitCode, signalCode: run.child.signalCode,
      spawnError: run.error() ? redactedDiagnosticText(run.error().message, 512) : null },
    eventFileBytes, eventRowsRead: rows.length, incompleteLastRecord, eventReadError,
    events: redactedEventRows(rows), outputSnippet: redactedDiagnosticText(run.output()),
    error: error ? redactedDiagnosticText(error.message, 1024) : null };
}
async function saveNativeDiagnostic(root, snapshot) {
  assert.ok(/^[a-z0-9-]{1,64}$/.test(snapshot.phase));
  assert.ok(path.isAbsolute(root) && path.basename(root).startsWith('aiplay-macos-smoke-'));
  await writeFile(path.join(root, `native-diagnostic-${snapshot.phase}.json`), JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
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
    assert.ok(['child-started', 'url-ready', 'reopen-request', 'reopen', 'child-exit'].includes(event.event), 'Known native host event.');
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
async function untilHostEvent(file, run, accept, { root, phase }) {
  try {
    for (let i = 0; i < 300; i++) {
      const events = await hostEvents(file, run.child.pid);
      if (accept(events)) {
        await saveNativeDiagnostic(root, await nativeDiagnostic(file, run, phase, 'observed'));
        return events;
      }
      if (run.error()) throw run.error();
      assert.equal(run.child.exitCode, null, 'Native GUI host exited early.');
      await wait(50);
    }
    throw Error('The native GUI host did not record the expected Finder event.');
  } catch (error) {
    const snapshot = await nativeDiagnostic(file, run, phase, 'failed', error);
    try { await saveNativeDiagnostic(root, snapshot); }
    catch (value) { snapshot.diagnosticWriteError = redactedDiagnosticText(value.message, 512); }
    throw Error(`${redactedDiagnosticText(error.message, 1024)} Native host diagnostic: ${JSON.stringify(snapshot)}`);
  }
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

test('native failure diagnostics redact URLs and credentials and bound captured output', () => {
  const text = redactedDiagnosticText('Setup: http://127.0.0.1:1234/private-token/\n'
    + 'https://github.com/private?token=secret\nBearer synthetic-secret\nAuthorization: synthetic-secret\n'
    + 'github_pat_synthetic_secret ghp_synthetic_secret');
  assert.doesNotMatch(text, /https?:\/\/|private-token|synthetic.secret|token=secret/);
  assert.ok(text.includes('[URL redacted]') && text.includes('[credential redacted]'));
  assert.equal(redactedDiagnosticText('a'.repeat(4096)).length, 2048);
});

test('native event diagnostics preserve only bounded lifecycle fields, never event URLs or other text', () => {
  const rows = Array.from({ length: 30 }, (_, hostPid) => ({ event: 'reopen', kind: 'launcher', hostPid,
    childPid: 9, childCount: 1, opened: false, status: 0, url: 'http://127.0.0.1:1234/private-token/', arbitrary: 'secret' }));
  const safe = redactedEventRows(rows);
  assert.equal(safe.length, 24);
  assert.equal(safe[0].hostPid, 6);
  assert.deepEqual(Object.keys(safe[0]).sort(), ['childCount', 'childPid', 'event', 'hostPid', 'kind', 'opened', 'status']);
  assert.doesNotMatch(JSON.stringify(safe), /private-token|127\.0\.0\.1|arbitrary|secret/);
});

test('native diagnostic files save safe complete event rows and preserve an existing receipt', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiplay-macos-smoke-diagnostics-'));
  try {
    const file = path.join(root, 'native-entry.jsonl');
    await writeFile(file, JSON.stringify({ event: 'reopen-request', hostPid: 123, childPid: 456, childCount: 1,
      url: 'http://127.0.0.1:1234/private-token/', private: 'ignored' }) + '\n{"incomplete":');
    const run = { child: { pid: 123, exitCode: null, signalCode: null }, error: () => null,
      output: () => 'http://127.0.0.1:1234/private-token/ Bearer synthetic-secret' };
    const snapshot = await nativeDiagnostic(file, run, 'fixture', 'failed', Error('Expected event missing.'));
    assert.equal(snapshot.incompleteLastRecord, true);
    assert.equal(snapshot.eventRowsRead, 1);
    assert.equal(snapshot.events[0].event, 'reopen-request');
    assert.doesNotMatch(JSON.stringify(snapshot), /private-token|synthetic-secret|127\.0\.0\.1|"private"/);
    await saveNativeDiagnostic(root, snapshot);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'native-diagnostic-fixture.json'), 'utf8')), snapshot);
    await assert.rejects(saveNativeDiagnostic(root, snapshot), { code: 'EEXIST' });
    const rows = await hostEvents(file, 123);
    assert.equal(rows[0].event, 'reopen-request');
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('aiplay-macos-smoke-diagnostics-'));
    await rm(root, { recursive: true, force: true });
  }
});

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
      rows => rows.some(row => row.event === 'url-ready' && row.kind === 'launcher'), { root: smoke, phase: 'gui-ready' });
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
        .some(row => row.opened === true), { root: smoke, phase: `finder-reopen-${call + 1}` });
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
    await saveNativeDiagnostic(smoke, await nativeDiagnostic(eventFile, gui, 'gui-complete', 'observed'));
  } catch (error) {
    const snapshot = await nativeDiagnostic(eventFile, gui, 'gui-failure', 'failed', error);
    try { await saveNativeDiagnostic(smoke, snapshot); }
    catch (value) { snapshot.diagnosticWriteError = redactedDiagnosticText(value.message, 512); }
    throw Error(`${redactedDiagnosticText(error.message, 2048)} GUI diagnostic: ${JSON.stringify(snapshot)}`);
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
