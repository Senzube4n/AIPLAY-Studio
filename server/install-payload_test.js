/** Offline temp payloads only. No imported runtime, configuration or server. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { verifyInstall, installPathAllowed, selectInstallManifest } from '../scripts/verify-install.mjs';
import { stageInstallPayload } from '../scripts/package.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CHECKER = path.join(REPO, 'scripts', 'verify-install.mjs');
async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiplay-install-payload-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), root);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(root).startsWith('aiplay-install-payload-')) throw Error('Unsafe test cleanup');
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
async function write(root, file, text = '') {
  const full = path.join(root, file);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text);
}
async function fixture(t, changes = {}) {
  const root = await temp(t);
  const manifest = { include: ['server', 'launcher', 'shared', 'scripts', 'install.json'], exclude: ['*_test.js', '*.md'], keep: ['LICENSE*'], ...changes };
  await write(root, 'install.json', JSON.stringify(manifest));
  await write(root, 'server/index.js', 'import { x } from "../shared/model-profiles.js"; throw Error("must never execute");');
  await write(root, 'shared/model-profiles.js', 'export const x = 1;');
  await write(root, 'launcher/launcher.mjs', 'export { x } from "../shared/model-profiles.js";');
  await write(root, 'scripts/install-manifest.mjs', await fs.readFile(new URL('../scripts/install-manifest.mjs', import.meta.url)));
  return { root, manifest };
}

test('the original missing shared/model-profiles.js payload is refused through real static imports', async t => {
  const { root } = await fixture(t);
  let report = await verifyInstall({ root });
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  await fs.unlink(path.join(root, 'shared', 'model-profiles.js'));
  report = await verifyInstall({ root });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some(error => error.file === 'server/index.js' && error.dependency === '../shared/model-profiles.js'));
});

test('parsing never evaluates runtime, config or dynamic imports, and bare packages need not be installed', async t => {
  const { root } = await fixture(t);
  await write(root, 'server/index.js', 'import "missing-npm-package"; import "node:fs"; import "./config.js"; import("./optional-missing.js"); globalThis.__installPayloadRan = true; throw Error("must never execute");');
  await write(root, 'server/config.js', 'throw Error("configuration must not evaluate");');
  const report = await verifyInstall({ root });
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(globalThis.__installPayloadRan, undefined);
});

test('export-from, multiline imports, cyclic graphs and URL-encoded local names are checked', async t => {
  const { root } = await fixture(t);
  await write(root, 'server/index.js', 'import {\n x\n} from "./with%20space.js?version=1"; export * from "./cycle.js";');
  await write(root, 'server/with space.js', 'export const x = 1;');
  await write(root, 'server/cycle.js', 'export * from "./index.js";');
  assert.equal((await verifyInstall({ root })).ok, true);
  await fs.unlink(path.join(root, 'server', 'with space.js'));
  assert.equal((await verifyInstall({ root })).ok, false);
});

test('worker is required when selected and remains optional in an older manifest without it', async t => {
  const { root, manifest } = await fixture(t);
  assert.equal((await verifyInstall({ root })).ok, true);
  const selected = { ...manifest, include: [...manifest.include, 'worker'] };
  let report = await verifyInstall({ root, manifest: selected });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some(error => error.file === 'worker/runpod-worker.js'));
  await write(root, 'worker/runpod-worker.js', 'import "./worker-support.js";');
  assert.equal((await verifyInstall({ root, manifest: selected })).ok, false);
  await write(root, 'worker/worker-support.js', 'export const worker = true;');
  assert.equal((await verifyInstall({ root, manifest: selected })).ok, true);
});

test('existing files outside include or excluded by filename cannot mask an incomplete shipped payload', async t => {
  const { root, manifest } = await fixture(t);
  const omitted = { ...manifest, include: manifest.include.filter(entry => entry !== 'shared') };
  let report = await verifyInstall({ root, manifest: omitted });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some(error => /excluded.*shared\/model-profiles/.test(error.message)));
  await write(root, 'server/required_test.js', 'export const x = 1;');
  report = await verifyInstall({ root, manifest: { ...manifest, required: ['server/required_test.js'] } });
  assert.equal(report.ok, false);
  await write(root, 'server/index.js', 'import "./required_test.js";');
  assert.equal((await verifyInstall({ root })).ok, false);
});

test('invalid manifest arrays, unsafe paths and nested include entries fail without throwing', async t => {
  const { root, manifest } = await fixture(t);
  for (const invalid of [null, {}, { ...manifest, include: [] }, { ...manifest, include: ['server/nested'] },
    { ...manifest, include: ['../server'] }, { ...manifest, required: 'server/index.js' },
    { ...manifest, required: ['../outside.js'] }, { ...manifest, exclude: '*.js' },
    { ...manifest, keep: {} }, { ...manifest, exclude: [1] }, { ...manifest, keep: [null] },
    { ...manifest, preserve: '../app' }, { ...manifest, preserve: ['../app'] }]) {
    const report = await verifyInstall({ root, manifest: invalid });
    assert.equal(report.ok, false, JSON.stringify(invalid));
    assert.equal(report.errors[0].file, 'install.json');
  }
});

test('syntax errors, directory imports and imports escaping the payload are refused', async t => {
  const { root } = await fixture(t);
  for (const source of ['export const = ;', 'import "./directory";', 'import "../../outside.js";']) {
    await write(root, 'server/index.js', source);
    await fs.mkdir(path.join(root, 'server', 'directory'), { recursive: true });
    const report = await verifyInstall({ root });
    assert.equal(report.ok, false, source);
  }
});

test('keep patterns override excludes and an unreferenced excluded test is never parsed', async t => {
  const { root, manifest } = await fixture(t);
  await write(root, 'shared/unreferenced_test.js', 'not valid javascript !!!');
  assert.equal((await verifyInstall({ root })).ok, true);
  assert.equal(installPathAllowed('server/LICENSE.md', manifest), true);
  assert.equal(installPathAllowed('server/readme.md', manifest), false);
  assert.equal(installPathAllowed('server/private_test.js', manifest), false);
});

test('the CLI emits one JSON result with meaningful success, failure and usage exit codes', async t => {
  const { root } = await fixture(t);
  const run = args => spawnSync(process.execPath, ['--experimental-vm-modules', CHECKER, ...args], { encoding: 'utf8', windowsHide: true });
  let result = run(['--root', root]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  await fs.unlink(path.join(root, 'shared/model-profiles.js'));
  result = run(['--root', root]);
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).ok, false);
  result = run([]); assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).ok, false);
  result = spawnSync(process.execPath, [CHECKER, '--root', root], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).unsupportedParser, true);
});

test('packaging uses manifest folders, keeps the scripts allowlist and excludes development tests', async t => {
  const { root, manifest } = await fixture(t, { include: ['server', 'launcher', 'shared', 'worker', 'scripts', 'install.json', 'NOTICE'] });
  await write(root, 'worker/runpod-worker.js', 'export const worker = true;');
  await write(root, 'NOTICE', 'Fixture notice');
  await write(root, 'server/fixture_test.js', 'not valid syntax');
  await write(root, 'scripts/verify-install.mjs', await fs.readFile(CHECKER));
  await write(root, 'scripts/start-remote.mjs', 'throw Error("never execute");');
  await write(root, 'scripts/dev-private.mjs', 'Private development script');
  const stage = path.join(await temp(t), 'payload');
  await stageInstallPayload({ root, stage });
  for (const file of ['shared/model-profiles.js', 'worker/runpod-worker.js', 'scripts/verify-install.mjs', 'scripts/start-remote.mjs', 'NOTICE']) assert.equal((await fs.stat(path.join(stage, file))).isFile(), true);
  for (const file of ['server/fixture_test.js', 'scripts/dev-private.mjs']) await assert.rejects(fs.stat(path.join(stage, file)), { code: 'ENOENT' });
  assert.equal((await verifyInstall({ root: stage, manifest })).ok, true);
});

test('the actual manifest-selected repository stages a complete parse-only runtime payload', async t => {
  const stage = path.join(await temp(t), 'actual-payload');
  await stageInstallPayload({ root: REPO, stage });
  const report = await verifyInstall({ root: stage });
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.ok(report.modulesChecked > 100, 'real startup graph was inspected');
  const profile = path.join(stage, 'shared', 'model-profiles.js');
  await fs.unlink(profile);
  const missing = await verifyInstall({ root: stage });
  assert.equal(missing.ok, false, 'regression reproduces the original broken package');
});

for (const platform of ['linux', 'darwin']) test(`${platform} selection omits Windows executables without weakening old Windows required paths`, async t => {
  const manifest = JSON.parse(await fs.readFile(path.join(REPO, 'install.json'), 'utf8'));
  const original = JSON.stringify(manifest);
  const windows = selectInstallManifest(manifest, 'win32'), linux = selectInstallManifest(manifest, platform);
  for (const file of ['AIPLAY Studio.exe', 'AIPLAY Studio.cmd']) {
    assert.ok(windows.include.includes(file)); assert.ok(windows.required.includes(file));
    assert.ok(!linux.include.includes(file)); assert.ok(!linux.required.includes(file));
  }
  for (const file of ['shared/model-profiles.js', 'scripts/verify-install.mjs', 'scripts/install-manifest.mjs']) assert.ok(linux.required.includes(file));
  assert.equal(JSON.stringify(manifest), original, 'selection never mutates the Windows contract');
  assert.deepEqual(selectInstallManifest(linux, platform), linux, 'selection is idempotent');
  const stage = path.join(await temp(t), `${platform}-payload`);
  await stageInstallPayload({ root: REPO, stage, platform });
  assert.equal((await verifyInstall({ root: stage, platform })).ok, true);
  for (const file of ['AIPLAY Studio.exe', 'AIPLAY Studio.cmd']) await assert.rejects(fs.stat(path.join(stage, file)), { code: 'ENOENT' });
  const wrongPlatform = await verifyInstall({ root: stage, platform: 'win32' });
  assert.equal(wrongPlatform.ok, false, 'a Unix payload cannot pass Windows requirements');
  await fs.unlink(path.join(stage, 'scripts/install-manifest.mjs'));
  assert.equal((await verifyInstall({ root: stage, platform })).ok, false, 'the shared selection helper is an actual required file');
});

test('malformed overlays and unsupported platforms fail closed, while legacy common manifests still work', async t => {
  const { root, manifest } = await fixture(t);
  for (const platform of ['win32', 'linux', 'darwin']) assert.equal((await verifyInstall({ root, platform })).ok, true);
  const declared = { ...manifest, platforms: { linux: { omit: ['Windows.exe'] } } };
  for (const platform of ['freebsd', 'aix', 'darwin']) assert.equal((await verifyInstall({ root, manifest: declared, platform })).ok, false);
  for (const platforms of [null, [], { linux: [] }, { linux: { omit: '../app' } }, { linux: { omit: ['../app'] } },
    { linux: { omit: ['server/index.js'] } }, { linux: { omit: ['*.exe'] } }, { linux: { omit: [], include: ['server'] } }, { mystery: { omit: [] } }]) {
    assert.equal((await verifyInstall({ root, manifest: { ...manifest, platforms }, platform: 'linux' })).ok, false, JSON.stringify(platforms));
  }
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', CHECKER, '--root', root, '--platform', 'linux'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).platform, 'linux');
});
