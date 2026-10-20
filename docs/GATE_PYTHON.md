# CPU Python for the mandatory repository gate

The mandatory `server/daw/production_export_test.js` executes real synthesis,
audio decoding, FLAC/WAV encoding, tagging, loudness and decoded sample/seam
comparisons. It requires Python with **numpy, scipy, av and soundfile**, and **ffmpeg and
ffprobe on PATH**. The mandatory real VFX RAM-preview lane additionally needs
**Pillow and OpenCV**. Both must fail, not skip, when requirements are absent.
The mandatory RoPE derivative check also requires **CPU-only PyTorch**; the
audio-analysis lane it enables requires matching **CPU-only torchaudio**.

The test uses temporary empty app data and the application's established
`config.python` resolution: **AIPLAY_PYTHON**, then a saved interpreter, then
the detected rig Python. With no override or saved settings, a source checkout
can select the default development rig, `D:\AI\aiplay-studio-bench`, and its
missing `venv\Scripts\python.exe`. That is not a requirement to install that
machine-specific directory. A remote-only installation need not have a local
ComfyUI interpreter.

Use an existing suitable interpreter via a process-scoped **AIPLAY_PYTHON**.
Do not change application settings or install test packages into an inference
environment. If needed, this explicit setup reuses the repository's pinned,
checksum-verified `ensureUv` and private environment settings, creates an
isolated venv under ignored `tmp/gate-python`, and installs only the six CPU
dependencies listed in `scripts/gate-python-requirements.txt`, plus CPU-only
PyTorch from the same official CPU index used by the existing setup system:

The dependency cache stays inside that venv, so third-party implementation files
cannot be mistaken for repository suites by the unchanged registration census.

```powershell
node scripts/setup-gate-python.mjs <existing-python-executable>
$env:AIPLAY_PYTHON = (Resolve-Path tmp/gate-python/venv/Scripts/python.exe).Path
& $env:AIPLAY_PYTHON -c "import numpy, scipy, av, soundfile, PIL, cv2, torch; assert torch.version.cuda is None"
node server/daw/production_export_test.js
node server/vfx/routes_ram_test.js
& $env:AIPLAY_PYTHON scripts/rope_grad_check.py
git commit
```

On Linux/macOS the created interpreter is `tmp/gate-python/venv/bin/python`;
export its absolute path as AIPLAY_PYTHON before the test and normal commit.
Keep that interpreter's directory on PATH as well so the gate's standalone
`python` suites use a runnable Python. The setup never downloads model weights,
a CUDA PyTorch build or a new Python interpreter; it uses the explicitly selected existing
Python. It does not weaken or bypass `.githooks/pre-commit`. Record resolved
package versions with the gate evidence. Remove the shell override or close
the test shell before launching the user's application normally.

The VFX harness honors `AIPLAY_RIG_PYTHON` first when explicitly supplied, then
the standard `AIPLAY_PYTHON` before its legacy rig fallback. Its child servers
still use an empty temporary rig so they cannot start the user's ComfyUI.
