import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NVIDIA_TORCH, nvidiaRuntimePlan, parseNvidiaSmi, nvidiaConstraints, torchProbeCode, torchProbeFailure } from './torch-runtime.js';

test('NVIDIA install profiles bind the complete compatible stack and wheel source', () => {
  const modern = nvidiaRuntimePlan({ gpuName: 'NVIDIA GeForce RTX 4070 Ti SUPER' });
  assert.equal(modern.index, 'cu130');
  for (const [name, version] of Object.entries(NVIDIA_TORCH)) assert.ok(modern.cmd.includes(`${name}==${version}+cu130`));
  assert.match(modern.cmd, /--index-url https:\/\/download\.pytorch\.org\/whl\/cu130$/);
  assert.doesNotMatch(modern.cmd, /--extra-index-url|--pre/);
  assert.equal(nvidiaRuntimePlan({ gpuName: 'GTX 1080 Ti' }).index, 'cu126');
  assert.equal(nvidiaRuntimePlan({ gpuName: 'Tesla V100-SXM2-32GB' }).index, 'cu126');
  assert.equal(nvidiaRuntimePlan({ gpuName: 'TITAN V' }).index, 'cu126');
  assert.equal(nvidiaRuntimePlan({ gpuName: 'unlisted OEM GPU', capability: '6.1' }).index, 'cu126');
  assert.equal(nvidiaRuntimePlan({ capability: 'sm_70' }).index, 'cu126');
  assert.equal(nvidiaRuntimePlan({ capability: '7.5' }).index, 'cu130');
  assert.equal(nvidiaRuntimePlan({ gpuName: 'RTX 5090', driverVersion: '576.80' }).index, 'cu130');
  assert.equal(nvidiaRuntimePlan({ capability: '12.0', driverVersion: '576.80' }).index, 'cu130');
  assert.equal(nvidiaRuntimePlan({ gpuName: 'RTX 4090', driverVersion: '576.80' }).index, 'cu126');
  assert.equal(nvidiaRuntimePlan({ gpuName: 'RTX 4090', driverVersion: '591.74' }).index, 'cu130');
  assert.match(nvidiaRuntimePlan({ gpuName: 'RTX 4090', driverVersion: '472.12' }).blocked, /driver 472\.12.*525-series minimum/);
  assert.match(nvidiaRuntimePlan({ capability: '3.5' }).blocked, /compute capability 3\.5.*5\.0 minimum/);
});

test('physical GPU capability and driver belong to the chosen adapter', () => {
  const rows = 'NVIDIA Tesla V100, 7.0, 580.88\r\nNVIDIA GeForce RTX 5090, 12.0, 591.74\r\n';
  assert.deepEqual(parseNvidiaSmi(rows, 'NVIDIA GeForce RTX 5090'), { name: 'NVIDIA GeForce RTX 5090', capability: '12.0', driverVersion: '591.74' });
  assert.equal(parseNvidiaSmi(rows, 'NVIDIA GeForce RTX 4070'), null);
  assert.equal(parseNvidiaSmi(rows), null, 'ambiguous multi-GPU output cannot choose a profile');
  assert.equal(parseNvidiaSmi('NVIDIA GPU, N/A, 591.74'), null);
  assert.equal(parseNvidiaSmi('NVIDIA GPU, 8.9, N/A'), null);
});

test('Comfy requirements preserve torch build tags without constraining unrelated packages', () => {
  const freeze = 'torch==2.14.1+cu130\nnumpy==2.3.5\nTorchVision==0.29.1+cu130\ntorchaudio==2.11.0+cu130\n';
  assert.equal(nvidiaConstraints(freeze), 'torch==2.14.1+cu130\ntorchvision==0.29.1+cu130\ntorchaudio==2.11.0+cu130\n');
  assert.throws(() => nvidiaConstraints('torch==2.14.1+cu130\n'), /no torchvision/);
  assert.equal(nvidiaConstraints(freeze.replaceAll('cu130', 'cu126')).includes('cu130'), false);
});

test('runtime failure keeps the actual exception and does not invent an obsolete driver', () => {
  const probe = { version: '2.14.1+cu130', backend: 'cuda', cudaVersion: '13.0', gpu: false, smoke: false,
    python: 'C:\\Studio\\venv\\Scripts\\python.exe', pythonVersion: '3.13.9', error: 'RuntimeError: CUDA initialization failed' };
  const recent = torchProbeFailure(probe, 'nvidia', { driverVersion: '591.74' });
  assert.match(recent, /CUDA initialization failed/);
  assert.match(recent, /C:\\Studio\\venv/);
  assert.doesNotMatch(recent, /Update the driver|580-series minimum/);
  assert.match(torchProbeFailure(probe, 'nvidia', { driverVersion: '576.80' }), /driver 576.80 is older than the 580-series minimum/);
  assert.match(torchProbeFailure({ ...probe, backend: 'cpu', cudaVersion: null }, 'nvidia'), /cpu build.*NVIDIA needs cuda/);
  assert.equal(torchProbeFailure({ ...probe, gpu: true, smoke: true }, 'nvidia'), null);
  assert.notEqual(torchProbeFailure({ ...probe, backend: 'rocm', gpu: true, smoke: true }, 'nvidia'), null);
});

// Execute the generated Python against a small fake torch module. No real
// runtime, NVIDIA driver, package install, network or model is needed.
const python = [process.env.AIPLAY_TEST_PYTHON, 'python', 'python3'].filter(Boolean)
  .find(command => spawnSync(command, ['-c', 'import sys; assert sys.version_info >= (3, 10)'], { timeout: 5000, windowsHide: true }).status === 0);
const fakeTorch = `
import os
__version__ = '2.14.1+cu130'
class version:
    cuda = '13.0'
    hip = None
class cuda:
    @staticmethod
    def init():
        if os.environ.get('FAKE_CUDA_INIT_ERROR'): raise RuntimeError('original CUDA initialization exception')
    @staticmethod
    def get_device_name(index): return 'Fake RTX GPU'
    @staticmethod
    def get_device_capability(index): return (8, 9)
    @staticmethod
    def synchronize():
        if os.environ.get('FAKE_CUDA_SYNC_ERROR'): raise RuntimeError('no kernel image is available for execution on the device')
class Tensor:
    def __add__(self, value): return self
    def sum(self): return self
    def item(self): return 8
def ones(count, device):
    assert count == 4 and device == 'cuda'
    return Tensor()
`;

test('real probe source tests kernels and synchronization and preserves Python tracebacks', { skip: !python }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aiplay-torch-probe-'));
  try {
    writeFileSync(path.join(root, 'torch.py'), fakeTorch);
    const probe = (env = {}) => {
      const stdout = execFileSync(python, ['-s', '-c', torchProbeCode('nvidia')],
        { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 15000, windowsHide: true });
      return JSON.parse(stdout.trim().split('\n').find(line => line.startsWith('@@probe ')).slice(8));
    };
    const ready = probe();
    assert.equal(ready.smoke, true);
    assert.equal(ready.gpu, true);
    assert.equal(ready.backend, 'cuda');
    assert.equal(ready.name, 'Fake RTX GPU');
    assert.equal(ready.capability, '8.9');
    assert.ok(ready.python && ready.pythonVersion);
    const init = probe({ FAKE_CUDA_INIT_ERROR: '1' });
    assert.equal(init.smoke, false);
    assert.match(init.traceback, /RuntimeError: original CUDA initialization exception/);
    const sync = probe({ FAKE_CUDA_SYNC_ERROR: '1' });
    assert.equal(sync.smoke, false);
    assert.match(sync.error, /no kernel image is available/);
    assert.equal(sync.gpu, false, 'enumerating a card without executing its kernels is insufficient');
    writeFileSync(path.join(root, 'torch.py'), "raise OSError('missing native DLL')\n");
    const native = probe();
    assert.equal(native.version, null);
    assert.match(native.traceback, /OSError: missing native DLL/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
