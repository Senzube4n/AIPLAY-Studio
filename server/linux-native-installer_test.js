/** Real Linux package acceptance. Opt-in because this installs from GitHub and
 * launches the installed application. The ordinary gate runs the offline suites;
 * the Linux workflow runs this on disposable x64 and arm64 Linux machines. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const enabled = process.platform === 'linux' && process.env.AIPLAY_LINUX_NATIVE_TEST === '1';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function until(url, child, output) {
  for (let i = 0; i < 240; i++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return response;
    } catch {}
    if (child.exitCode !== null) throw Error(`Installed process exited ${child.exitCode}: ${output()}`);
    await wait(250);
  }
  throw Error(`Installed process did not become ready: ${output()}`);
}
const stopped = new WeakSet();
async function stopOwned(child) {
  if (stopped.has(child)) return;
  stopped.add(child);
  // This process group was created by this suite, never found by a name/port.
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  for (let i = 0; i < 40; i++) {
    try { process.kill(-child.pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await wait(100);
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
function launch(command, args, env, cwd) {
  const child = spawn(command, args, { env, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output = (output + data).slice(-24_000); });
  child.stderr.on('data', data => { output = (output + data).slice(-24_000); });
  child.on('error', error => { output += error.stack; });
  return { child, output: () => output };
}

test('real Linux package installs, repairs, launches and preserves user data', {
  skip: !enabled && 'requires the explicit disposable Linux package workflow', timeout: 12 * 60_000,
}, async t => {
  const smoke = process.env.AIPLAY_LINUX_SMOKE_ROOT;
  assert.ok(smoke && path.isAbsolute(smoke) && path.basename(smoke).startsWith('aiplay-linux-smoke-'));
  const repo = process.env.GITHUB_REPOSITORY;
  const ref = process.env.GITHUB_SHA;
  assert.match(repo || '', /^[\w.-]+\/[\w.-]+$/);
  assert.match(ref || '', /^[a-f0-9]{40}$/);
  const home = path.join(smoke, 'home with spaces');
  const data = path.join(home, '.local', 'share');
  const profile = path.join(home, '.aiplay-studio');
  const app = path.join(data, 'aiplay-studio', 'app');
  const wrapper = '/usr/bin/aiplay-studio';
  const runtime = '/usr/lib/aiplay-studio/runtime/bin/node';
  const port = await freePort();
  let studioPort = await freePort();
  while (studioPort === port) studioPort = await freePort();
  await mkdir(profile, { recursive: true });
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: data,
    AIPLAY_APPDATA: profile, AIPLAY_LAUNCHER_NO_WINDOW: '1',
    AIPLAY_LAUNCHER_PORT: String(port), AIPLAY_UI_PORT: String(studioPort) };
  assert.ok(existsSync(wrapper));
  assert.ok(existsSync(runtime));
  const pins = JSON.parse(await readFile(new URL('../installer/linux/runtime.json', import.meta.url), 'utf8'));
  assert.equal(execFileSync(runtime, ['--version'], { encoding: 'utf8' }).trim(), `v${pins.nodeVersion}`);
  // Only dirname is available from the incoming PATH. The package must supply
  // its own Node/npm; CI's preinstalled developer runtimes cannot mask omissions.
  const minimalPath = path.join(smoke, 'minimal commands');
  await mkdir(minimalPath, { recursive: true });
  await symlink('/usr/bin/dirname', path.join(minimalPath, 'dirname'));
  const commands = ['--install-only', '--repo', repo, '--ref', ref];
  const installed = execFileSync(wrapper, commands, { env: { ...env, PATH: minimalPath }, encoding: 'utf8', timeout: 5 * 60_000 });
  assert.match(installed, /(?:installed|ready|complete)/i);
  const info = JSON.parse(await readFile(path.join(app, 'install-info.json'), 'utf8'));
  assert.equal(info.commit, ref);
  assert.equal(info.repo, repo);
  assert.equal(info.linuxBootstrap.version, 1);
  for (const file of ['shared/model-profiles.js', 'scripts/verify-install.mjs', 'node_modules/ws/package.json']) {
    assert.ok((await stat(path.join(app, file))).isFile(), file);
  }
  assert.equal(existsSync(path.join(app, 'AIPLAY Studio.exe')), false);
  assert.equal(existsSync(path.join(app, 'AIPLAY Studio.cmd')), false);
  const custom = path.join(app, 'workflows', 'custom', 'mine.json');
  await mkdir(path.dirname(custom), { recursive: true });
  await writeFile(custom, '{"myWorkflow":true}\n');
  await writeFile(path.join(profile, 'settings.json'), '{"linuxAcceptanceSentinel":"keep","prefs":{"level":"advanced"}}\n');
  await writeFile(path.join(profile, 'keep-project.txt'), 'My existing project and media stay here.\n');
  const settingsBefore = await readFile(path.join(profile, 'settings.json'), 'utf8');
  execFileSync(wrapper, [...commands, '--repair'], { env, encoding: 'utf8', timeout: 5 * 60_000 });
  assert.equal(await readFile(custom, 'utf8'), '{"myWorkflow":true}\n');
  assert.equal(await readFile(path.join(profile, 'settings.json'), 'utf8'), settingsBefore);
  assert.equal(await readFile(path.join(profile, 'keep-project.txt'), 'utf8'), 'My existing project and media stay here.\n');

  const launcher = launch(wrapper, ['--no-open'], { ...env, AIPLAY_LAUNCHER_PORT: String(port) }, home);
  t.after(() => stopOwned(launcher.child));
  try {
    const ping = await until(`http://127.0.0.1:${port}/api/ping`, launcher.child, launcher.output);
    assert.equal((await ping.json()).app, 'aiplay-launcher');
    assert.match(await (await fetch(`http://127.0.0.1:${port}/`)).text(), /AIPLAY/i);
  } finally { await stopOwned(launcher.child); }

  // Real installed server and DAW, with engine auto-start disabled. No models,
  // generation jobs, paid services or existing profiles are used by this test.
  const studio = launch(runtime, [path.join(app, 'server', 'index.js')], {
    ...env, AIPLAY_UI_PORT: String(studioPort), AIPLAY_MUSIC_ONLY: '1', AIPLAY_OPEN: '0',
  }, app);
  t.after(() => stopOwned(studio.child));
  try {
    const response = await until(`http://127.0.0.1:${studioPort}/api/status`, studio.child, studio.output);
    const status = await response.json();
    assert.equal(status.config.musicOnly, true);
    const daw = await fetch(`http://127.0.0.1:${studioPort}/daw.html`);
    assert.equal(daw.status, 200);
    assert.match(await daw.text(), /<!doctype html>/i);
    assert.equal(JSON.parse(await readFile(path.join(profile, 'settings.json'), 'utf8')).linuxAcceptanceSentinel, 'keep');
  } finally { await stopOwned(studio.child); }
  // Workflow removes the system package next and verifies this marker survives.
  await writeFile(path.join(smoke, 'acceptance.json'), JSON.stringify({ ok: true, repo, commit: ref, app, profile, runtime: execFileSync(runtime, ['--version'], { encoding: 'utf8' }).trim() }, null, 2));
});
