import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseEngine } from '../../scripts/diagnose-engine.mjs';

const working = { python: 'C:/engine/python.exe', pythonVersion: '3.13.0', version: '2.14.1+cu130', cudaVersion: '13.0', backend: 'cuda', gpu: true, smoke: true, name: 'NVIDIA GeForce RTX 4070', versions: {} };

test('diagnosis checks the selected engine Python and reports hardware separately', async () => {
  const calls = [];
  const report = await diagnoseEngine({ python: 'C:/engine/python.exe', backend: 'nvidia' }, async (file, args, options) => {
    calls.push({ file, args, options });
    return file === 'nvidia-smi' ? { stdout: 'NVIDIA GeForce RTX 4070, 8.9, 610.88\n' } : { stdout: `@@probe ${JSON.stringify(working)}\n` };
  });
  assert.equal(report.ok, true);
  assert.equal(report.devices[0].driverVersion, '610.88');
  assert.equal(report.freshInstallProfile.index, 'cu130');
  assert.equal(calls[1].file, 'C:/engine/python.exe');
  assert.equal(calls[1].args[0], '-s');
  assert.ok(calls[1].options.timeout <= 60_000);
  assert.doesNotMatch(JSON.stringify(calls), /pip install|powershell|cmd\.exe/);
});

test('a failed kernel is a failed report even when the driver and GPU were detected', async () => {
  const probe = { ...working, smoke: false, gpu: false, error: 'RuntimeError: no kernel image is available', traceback: 'Original kernel traceback' };
  const report = await diagnoseEngine({ python: 'exact-python', backend: 'nvidia' }, async file => file === 'nvidia-smi'
    ? { stdout: 'NVIDIA GeForce RTX 4070, 8.9, 610.88\n' } : { stdout: `@@probe ${JSON.stringify(probe)}` });
  assert.equal(report.ok, false);
  assert.match(report.failure, /Original kernel traceback/);
  assert.doesNotMatch(report.failure, /Update the driver/);
});

test('missing nvidia-smi does not prevent checking the exact engine', async () => {
  const report = await diagnoseEngine({ python: 'exact-python', backend: 'nvidia' }, async file => {
    if (file === 'nvidia-smi') throw new Error('not on PATH');
    return { stdout: `@@probe ${JSON.stringify(working)}` };
  });
  assert.equal(report.ok, true);
  assert.match(report.deviceCheckError, /not on PATH/);
  assert.equal(report.freshInstallProfile, undefined);
});

test('CPU reports make no NVIDIA call, and process failures remain actionable', async () => {
  const calls = [];
  const report = await diagnoseEngine({ python: 'cpu-python', backend: 'cpu' }, async file => {
    calls.push(file);
    return { stdout: `@@probe ${JSON.stringify({ ...working, backend: 'cpu', gpu: false, smoke: true, cudaVersion: null })}` };
  });
  assert.equal(report.ok, true);
  assert.deepEqual(calls, ['cpu-python']);
  const failed = await diagnoseEngine({ python: 'missing-python', backend: 'cpu' }, async () => { throw new Error('ENOENT'); });
  assert.equal(failed.ok, false);
  assert.match(failed.failure, /ENOENT/);
  await assert.rejects(diagnoseEngine({ backend: 'nvidia' }), /No engine Python/);
});
