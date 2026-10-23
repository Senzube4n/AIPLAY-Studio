/** Explicit CPU test setup. Never changes Studio settings or an inference venv. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureUv } from '../server/setup/uv.js';
import { UV_PRIVATE_ENV } from '../server/setup/pins.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] || process.env.AIPLAY_PYTHON || 'python';
const run = (exe, args, options = {}) => execFileSync(exe, args, { windowsHide: true, stdio: 'inherit', ...options });
// Execute the candidate: a Windows Store alias is not a usable Python.
let python;
try { python = run(base, ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8', stdio: 'pipe' }).trim(); }
catch { throw Error('Pass an existing Python executable: node scripts/setup-gate-python.mjs <python>. See docs/GATE_PYTHON.md.'); }
const data = path.join(root, 'tmp', 'gate-python');
const target = path.join(data, 'venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
const uv = await ensureUv({ appData: data, log: console.log });
const env = { ...process.env, ...UV_PRIVATE_ENV, UV_CACHE_DIR: path.join(data, 'venv', 'uv-cache'), UV_PYTHON_DOWNLOADS: 'never' };
// Dependency implementation files belong inside the venv, outside the existing
// repository test census. Do not broaden its exclusions for our scratch cache.
if (!existsSync(target)) run(uv, ['venv', '--python', python, path.dirname(path.dirname(target))], { env: { ...env, UV_NO_CACHE: '1' } });
run(uv, ['pip', 'install', '--python', target, '-r', path.join(root, 'scripts', 'gate-python-requirements.txt')], { env });
// The mandatory RoPE derivative check needs torch, but no model or CUDA build.
run(uv, ['pip', 'install', '--python', target, 'torch', 'torchaudio', ...(process.platform === 'darwin' ? [] : ['--index-url', 'https://download.pytorch.org/whl/cpu'])], { env });
run(target, ['-c', 'import torch,torchaudio; assert torch.version.cuda is None, "Gate requires CPU-only torch"; print("torch="+torch.__version__,"torchaudio="+torchaudio.__version__)']);
run(target, ['-c', 'import sys,numpy,scipy,av,soundfile,PIL,cv2,safetensors,fontTools;print(sys.executable);print("numpy="+numpy.__version__,"scipy="+scipy.__version__,"av="+av.__version__,"soundfile="+soundfile.__version__,"Pillow="+PIL.__version__,"opencv="+cv2.__version__,"safetensors="+safetensors.__version__,"fonttools="+fontTools.__version__)']);
console.log('Set AIPLAY_PYTHON to this executable for the test/gate process only. FFmpeg and ffprobe must also be on PATH.');
