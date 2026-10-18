import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('Windows vault round-trips DPAPI keys with incompatible inherited module paths', { skip: process.platform !== 'win32' }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aiplay-vault-module-'));
  assert.ok(dir.startsWith(path.join(os.tmpdir(), 'aiplay-vault-module-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const modules = path.join(dir, 'modules');
  const incompatible = path.join(modules, 'Microsoft.PowerShell.Security');
  await mkdir(incompatible, { recursive: true });
  await writeFile(path.join(incompatible, 'Microsoft.PowerShell.Security.psd1'),
    "@{RootModule='incompatible.psm1';ModuleVersion='1.0.0';FunctionsToExport=@('ConvertTo-SecureString','ConvertFrom-SecureString')}");
  await writeFile(path.join(incompatible, 'incompatible.psm1'), "throw 'Incompatible inherited security module fixture'");
  const env = { ...process.env, AIPLAY_APPDATA: dir, PSModulePath: modules };
  await assert.rejects(promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; ConvertTo-SecureString -String 'test-only' -AsPlainText -Force | Out-Null"],
    { env, windowsHide: true, timeout: 30000 }), 'fixture must reproduce the auto-loading failure');
  const program = `import assert from 'node:assert/strict';
    import {setSecret,getSecret,secretStatus} from ${JSON.stringify(new URL('./secrets.js', import.meta.url).href)};
    const key='test-only-vault-round-trip-not-a-provider-key';
    const saved=await setSecret('RUNPOD_ACCOUNT_API_KEY',key);
    assert.equal(saved.method,'dpapi');
    assert.equal(await getSecret('RUNPOD_ACCOUNT_API_KEY'),key);
    assert.equal((await secretStatus('RUNPOD_ACCOUNT_API_KEY')).usable,true);`;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', program], {
    env, windowsHide: true, timeout: 30000,
  });
  const record = JSON.parse(await readFile(path.join(dir, 'secrets.json'), 'utf8')).RUNPOD_ACCOUNT_API_KEY;
  assert.equal(record.method, 'dpapi');
  assert.ok(!record.value.includes('test-only-vault-round-trip'));
});
