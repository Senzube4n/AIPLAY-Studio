/** Studio-owned NVIDIA runtime profiles and the read-only verification shared
 * by installation and diagnostics. Existing ComfyUI environments are not edited.
 *
 * PyTorch 2.15 removed the CUDA 12.6/13.0 wheels. An unpinned pip command with
 * --extra-index-url can therefore choose a newer, incompatible PyPI build.
 * Keep the complete stack on one explicit index; TorchAudio's stable ABI uses
 * its own 2.11 numbering, rather than matching torch's version.
 * Sources checked 2026-11-14:
 * https://pytorch.org/get-started/previous-versions/
 * https://docs.pytorch.org/audio/stable/installation
 * https://github.com/pytorch/pytorch/releases/tag/v2.15.0
 */
export const NVIDIA_TORCH = Object.freeze({ torch: '2.14.1', torchvision: '0.29.1', torchaudio: '2.11.0' });

// The measured Studio music path needs cu130. Use cu126 for pre-Turing cards
// or older drivers only; Blackwell must never be sent to the legacy build.
const LEGACY_NVIDIA = /\b(gtx\s*(?:7[45]\d|9\d\d|10\d\d)|titan\s*(?:x|xp|v)\b|quadro\s*[pkm]\d|tesla\s*[pkmv]\d|(?:tesla\s+)?v100\b)/i;
const BLACKWELL = /\b(?:rtx\s*(?:50\d\d|pro\s*\d+\s*blackwell)|(?:b100|b200|b300|gb200|gb300))\b/i;

function computeCapability(value) {
  const match = String(value ?? '').trim().match(/^(?:sm[_-]?)?(\d+)(?:\.(\d+))?$/i);
  if (!match) return null;
  return match[2] !== undefined ? Number(match[1]) * 10 + Number(match[2]) : Number(match[1]) < 10 ? Number(match[1]) * 10 : Number(match[1]);
}

export function nvidiaRuntimePlan({ gpuName = '', capability = null, driverVersion = '' } = {}) {
  const cc = computeCapability(capability);
  const driver = Number.parseInt(driverVersion, 10);
  const blackwell = cc !== null ? cc >= 100 : BLACKWELL.test(gpuName);
  const legacy = cc !== null ? cc < 75 : LEGACY_NVIDIA.test(gpuName);
  const olderDriver = Number.isFinite(driver) && driver > 0 && driver < 580 && !blackwell;
  const blocked = cc !== null && cc < 50
    ? `This GPU's compute capability ${capability} is below the 5.0 minimum of Studio's CUDA 12.6 profile. Choose CPU or use a separately maintained compatible engine.`
    : Number.isFinite(driver) && driver > 0 && driver < 525
      ? `NVIDIA driver ${driverVersion} is below the 525-series minimum for Studio's CUDA 12.6 profile. Update the driver before installing, or choose CPU.` : null;
  const index = legacy || olderDriver ? 'cu126' : 'cu130';
  const packages = Object.entries(NVIDIA_TORCH).map(([name, version]) => `${name}==${version}+${index}`);
  return {
    cmd: `pip install ${packages.join(' ')} --index-url https://download.pytorch.org/whl/${index}`,
    python: legacy ? '3.12' : '3.13', index,
    ...(blocked ? { blocked } : {}),
    why: legacy ? 'older NVIDIA card: pinned CUDA 12.6 compatibility build'
      : olderDriver ? `NVIDIA driver ${driverVersion}: pinned CUDA 12.6 compatibility build`
        : 'pinned CUDA 13.0 build; preserves Studio\'s accelerated music path',
  };
}

/** The selected device only. Never borrow the capability of a different GPU. */
export function parseNvidiaSmi(stdout, gpuName = '') {
  const rows = String(stdout || '').split(/\r?\n/).map(line => {
    const [name, capability, driverVersion] = line.split(',').map(value => value.trim());
    return name && computeCapability(capability) !== null && /^\d+(?:\.\d+)+$/.test(driverVersion || '')
      ? { name, capability, driverVersion } : null;
  }).filter(Boolean);
  if (!gpuName) return rows.length === 1 ? rows[0] : null;
  const name = gpuName.toLowerCase().trim();
  return rows.find(row => row.name.toLowerCase() === name)
    || rows.find(row => row.name.toLowerCase().includes(name) || name.includes(row.name.toLowerCase())) || null;
}

/** Constrain the installed stack before ComfyUI resolves its requirements.
 * An explicit developer override is respected, including its local build tag.
 * Do not freeze unrelated transitive packages at this early install step. */
export function nvidiaConstraints(freezeText) {
  const found = new Map();
  for (const line of String(freezeText || '').split(/\r?\n/)) {
    const match = line.trim().match(/^(torch|torchvision|torchaudio)==([^\s;#]+)$/i);
    if (match) found.set(match[1].toLowerCase(), match[2]);
  }
  for (const name of Object.keys(NVIDIA_TORCH)) {
    if (!found.has(name)) throw new Error(`The NVIDIA runtime has no ${name} installed; its requirements cannot be protected.`);
  }
  return Object.keys(NVIDIA_TORCH).map(name => `${name}==${found.get(name)}`).join('\n') + '\n';
}

/** Run with the exact engine Python. A tensor operation plus synchronization
 * catches unsupported GPU kernels that is_available() alone does not test.
 * CUDA init is called explicitly so its original exception is preserved. */
export function torchProbeCode(backend) {
  if (!['nvidia', 'amd', 'intel', 'cpu'].includes(backend)) throw new Error('Unknown runtime backend.');
  return [
    'import sys, json, traceback, importlib.metadata as metadata',
    `expected = ${JSON.stringify(backend)}`,
    "out = {'python': sys.executable, 'pythonVersion': sys.version.split()[0], 'version': None, 'cudaVersion': None, 'backend': 'unknown', 'gpu': False, 'smoke': False, 'name': '', 'capability': None, 'versions': {}}",
    'try:',
    '    import torch',
    "    out['version'] = torch.__version__",
    "    out['cudaVersion'] = getattr(torch.version, 'cuda', None)",
    "    hip = getattr(torch.version, 'hip', None) or getattr(torch.version, 'rocm', None)",
    "    out['backend'] = 'rocm' if hip else 'cuda' if out['cudaVersion'] else 'xpu' if hasattr(torch, 'xpu') and torch.xpu.is_available() else 'cpu'",
    "    for package in ['torch', 'torchvision', 'torchaudio']:",
    '        try:',
    "            out['versions'][package] = metadata.version(package)",
    '        except metadata.PackageNotFoundError:',
    '            pass',
    "    if expected in ['nvidia', 'amd']:",
    '        torch.cuda.init()',
    "        out['name'] = torch.cuda.get_device_name(0)",
    "        out['capability'] = '.'.join(str(v) for v in torch.cuda.get_device_capability(0))",
    "        value = (torch.ones(4, device='cuda') + 1).sum().item()",
    '        torch.cuda.synchronize()',
    "        if value != 8: raise RuntimeError('GPU tensor test returned an unexpected result')",
    "        out['gpu'] = True",
    "    elif expected == 'intel':",
    "        out['name'] = torch.xpu.get_device_name(0)",
    "        value = (torch.ones(4, device='xpu') + 1).sum().item()",
    '        torch.xpu.synchronize()',
    "        if value != 8: raise RuntimeError('GPU tensor test returned an unexpected result')",
    "        out['gpu'] = True",
    '    else:',
    "        out['gpu'] = hasattr(torch.backends, 'mps') and torch.backends.mps.is_available()",
    "    out['smoke'] = True",
    'except Exception as error:',
    "    out['error'] = type(error).__name__ + ': ' + str(error)",
    "    out['traceback'] = traceback.format_exc()",
    "print('@@probe ' + json.dumps(out))",
  ].join('\n');
}

export function torchProbeFailure(probe, backend, { driverVersion = '', python = '' } = {}) {
  const expected = { nvidia: 'cuda', amd: 'rocm', intel: 'xpu' }[backend];
  if (probe?.smoke && (backend === 'cpu' || (probe.gpu && probe.backend === expected))) return null;
  const runtime = `Python: ${probe?.python || python || 'unknown'} (${probe?.pythonVersion || 'unknown'}). `
    + `PyTorch: ${probe?.version || 'not imported'}; runtime: ${probe?.backend || 'unknown'}`
    + `${probe?.cudaVersion ? ` ${probe.cudaVersion}` : ''}.`;
  let hint = backend === 'nvidia'
    ? 'Check this GPU and the selected PyTorch build together. nvidia-smi reports the CUDA version supported by the driver, not this Python runtime.'
    : backend === 'amd' ? 'Check the GPU and driver against the installed ROCm build.'
      : backend === 'intel' ? 'Check the Intel driver and the installed XPU build.' : 'Check the Python runtime and its installed packages.';
  if (expected && probe?.version && probe.backend !== expected) {
    hint = `This is a ${probe.backend} build, but ${backend.toUpperCase()} needs ${expected}. Run Studio's engine setup again with the intended backend.`;
  } else if (backend === 'nvidia' && Number.parseInt(driverVersion, 10) < 580 && /^13\./.test(probe?.cudaVersion || '')) {
    hint = `NVIDIA driver ${driverVersion} is older than the 580-series minimum for CUDA 13. Update the driver, or use the CUDA 12.6 profile on a supported older GPU.`;
  }
  const original = probe?.traceback || probe?.error || 'The runtime did not report a successful tensor test.';
  return `PyTorch could not complete the ${backend.toUpperCase()} runtime check. ${runtime}\n${hint}\n${original}`;
}
