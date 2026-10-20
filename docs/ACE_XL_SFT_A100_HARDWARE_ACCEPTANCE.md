# ACE-Step 1.5 XL-SFT A100 SXM hardware acceptance

Current result: **live A100 inference passed and provider-confirmed EXITED** on 20 October 2026. See the [complete hardware acceptance result](ACE_XL_SFT_A100_HARDWARE_ACCEPTANCE_RESULT.md). The following sections preserve the historical preflight and repair record; their pending states describe those earlier phases.

Historical status: **A100 safeguard build and CPU gate-environment repair**. Publishing this build requires the complete mandatory gate without bypass. Hardware acceptance and provisioning are not performed in this repair phase. Exact publication and read-only provider results are recorded separately in the final preflight evidence.

## Approved scope

The user explicitly approved one full **NVIDIA A100-SXM4-80GB**, **Secure Cloud**, at **no more than $1.79/hour**, with **at least 64 GB host RAM and 8 vCPUs**, **100 GB persistent storage and 20 GB temporary disk**. Maximum session duration is **two hours**, including installation, with a **90-minute workload cutoff and final 30-minute shutdown reserve**. The operational session allowance is **$5**, excluding subsequent retained persistent storage, approximately **$20/month while stopped**. These are operational safeguards, not a provider-enforced billing cap.

Only one reviewed creation attempt is authorized after all safeguards, publication and fresh provider checks pass. A failed mandatory check ends the attempt; no automatic retry, substitute GPU, pool switch, price increase, replacement, termination, deletion or resize is authorized.

## Existing policy adaptation

The existing bounded XL-SFT policy now binds the exact A100 SXM identifier, Secure pool, $1.79 ceiling and $5 operational allowance. It replaces the exhausted A40 authorization; A40 and A100 PCIe are explicitly rejected. Normal cloud provisioning, local inference, UI and model registries are unchanged.

The remote actual-resource validator independently enforces the same GPU, count, pool, rate, host floors and disk sizes before installation. The bootstrap acceptance marker advances from 1 to **2**; the local installer refuses old A40 supervisors. The exact committed Python supervisor remains embedded before network installation, with publication SHA-256 verification and no moving branch.

Unchanged safeguards include the immutable absolute/monotonic deadline, separate vaulted stop credential, desktop-independent supervisor, protected active work until cutoff, cancellation reserve, persistent output verification, stop-only provider operations, single journalled create/stop requests with read-only reconciliation, authenticated diagnostics and provider-confirmed EXITED before reporting stopped.

Focused regressions passed: **109 JavaScript tests, zero failures**, and **17 Python tests**. They cover the exact A100 allocation request, budget/reserve, old bootstrap rejection, A40/PCIe/Community substitutions, unavailable stock, over-ceiling prices, actual resource mismatches, uncertain responses, restart/disconnection, cancellation, persistence vetoes and telemetry behavior. Logs: `tmp/cloud-manager/xl-sft-a100-focused.log` and `xl-sft-a100-python.log`. These are software tests, not live GPU acceptance.

## Exact workload and evidence requirements

Reuse the exact four pinned files and SHA-256 values in `shared/model-bundles.js` and the [established acceptance procedure](ACE_XL_SFT_HARDWARE_ACCEPTANCE.md): XL-SFT BF16 DiT, ACE 1.5 VAE, Qwen 0.6B lyric encoder and Qwen 4B planner. Publisher revision: `6707deb277e9e0907fd9c14ce6b6f1d695c6a3fc`. ComfyUI revision: `ce1e922d8623bb507180e32a0c01a7d0e29edef7`. No Turbo/Base variant, smaller planner or optional LoRA is authorized.

Generate the agreed **30-second instrumental electronic sample, batch 1, 50 steps, CFG 7**, using the existing official Comfy workflow builder, Euler/simple, shift 3, denoise 1, audio-code planner enabled and lossless FLAC output. Keep the established fixed seed, prompt and ancillary planner settings. Do not change the user's persistent generation defaults.

Before downloading weights, verify actual GPU/VRAM, allocated and available/container-limited RAM, vCPUs, exact storage, rate, pool, driver/CUDA/PyTorch and runtime operation. Record all four on-disk checksums, worker/build identities, scoped sampled GPU/process/container/host memory, checkpoint/model-loading and generation timing, errors/offloading, persisted/exported audio checksum, output format/duration, signal checks and full-sample playback acceptance. Preserve results, safely stop compute and confirm provider EXITED. A successful 80 GB run would not prove 48 GB compatibility or a minimum memory requirement.

## Live evidence ledger

| Evidence | Result |
|---|---|
| Mandatory repository gate and published worker identity | Publishing commit requires complete gate; final commit/publication evidence recorded in `tmp/cloud-manager/xl-sft-a100-publication.json` |
| Fresh exact GPU price / CUDA-qualified capacity | Final read-only result recorded separately after publication; no creation authorized in gate-repair phase |
| Single creation outcome / actual hardware and storage | No creation submitted; no actual allocation |
| Four on-disk artifact SHA-256 values | Pending download and verification |
| Peak observed GPU VRAM / process / container / host RAM | Not measured |
| Model loading / generation duration | Not measured |
| Output format / duration / checksum / local export | No output |
| Automated audio checks / complete playback validation | Pending |
| Provider-confirmed EXITED / retained storage | Not applicable: this attempt created no Pod or storage |

No measured profile compatibility update will be made without live evidence. Other untested workloads and configurations remain unverified.

## Initial mandatory gate failure and stop reason

The normal commit invoked the repository's mandatory `.githooks/pre-commit` with no bypass. The gate ran its cloud regression tests, including the revised installer and all 17 Python startup tests, then failed in the existing **server/daw/production_export_test.js** CPU export integration test:

```text
Error: Could not start python (D:\AI\aiplay-studio-bench\venv\Scripts\python.exe):
spawn D:\AI\aiplay-studio-bench\venv\Scripts\python.exe ENOENT
```

Static inspection confirmed that executable is absent. The export test creates disposable app data, imports the normal config and invokes `config.python`; `server/config.js` selects `AIPLAY_PYTHON`, a saved choice or `detectPython(RIG)`. Its default full-install rig is `D:\AI\aiplay-studio-bench`. Adding the bundled Python directory to PATH was sufficient for the standalone startup suite, but does not override this explicit configured interpreter path. Node subsequently also emitted a Windows libuv closing-handle assertion; the missing interpreter is the first recorded failure. This gate result does not establish that all remaining regression suites would pass.

The user explicitly required stopping if a mandatory check failed. Accordingly, **no gate rerun, configuration repair, package install, publication, fresh provider review, paid create request, worker deployment or model download followed the failure**. The commit was aborted by the gate; HEAD remains `e23e1c1f369d666dc928f6e6f3c4407b70f0e21a`. The reviewed patch and reports remain local and staged, with no failed gate bypass. The existing running AIPLAY installation was not restarted or replaced. The user's pre-existing audit file was not staged or changed.

Complete gate output: `tmp/cloud-manager/xl-sft-a100-gate-commit.log`. The focused test results remain valid as scoped software evidence; they do not satisfy the mandatory full gate or prove actual A100 inference.

No RunPod mutation was attempted in this phase, so no test compute or persistent storage was created and there are no test resource charges attributable to this attempt. The single authorized creation attempt has not been used. GPU/host allocation, actual worker/ComfyUI runtime versions, on-disk artifact hashes, memory peaks, timings, audio and provider-confirmed shutdown remain unavailable rather than inferred or estimated as measured results.

Before resuming, investigate the test interpreter selection and verify an existing suitable Python runtime. A process-scoped `AIPLAY_PYTHON` override can avoid changing the installed application's persistent configuration; required CPU export dependencies must be verified first. Then the full mandatory gate, exact committed worker/bootstrap publication, fresh exact provider review and actual-resource verification must all pass before the one approved creation attempt or any model download. This report records the stop; it does not schedule or execute that remediation or provisioning.

## Authorized gate repair

The user subsequently authorized repairing the gate environment, resolving any further gate failures, committing/publishing the verified safeguard build and reporting a final read-only preflight. **Provisioning remains prohibited during this phase; the single A100 creation attempt is unused.**

The root cause was the test's empty temporary app data plus no `AIPLAY_PYTHON`: normal config selected the default development rig, and its intentional missing-file fallback. Product interpreter resolution is preserved. The bare bundled Python also lacked SciPy, PyAV and soundfile, so a path substitution alone was insufficient.

`scripts/setup-gate-python.mjs` reuses the repository's pinned/checksum-verified `ensureUv` and private environment settings to create an isolated CPU-only venv in ignored `tmp/gate-python`, using an explicitly selected existing Python. Only the six existing CPU DAW/VFX dependency requirements (numpy, scipy, av, soundfile, Pillow, OpenCV) and their dependencies are installed there. No app settings, inference environments, GPU packages, model weights or registry entries are modified. See [portable gate instructions](GATE_PYTHON.md).

The test retains all original assertions and now probes its selected interpreter/dependencies and FFmpeg tools before opening its HTTP fixture. Missing dependencies produce an actionable failure rather than a skipped lane. A regression in the already registered MCP production suite verifies that an explicit missing interpreter fails with ENOENT and the setup instructions. The gate also syntax-checks the setup helper.

The real export rerun passed **all 53 checks**, including actual audio decode/encode/tag/download, 24/16-bit sample tolerances, frame parity, region seams and return tails. Sample comparisons against the whole-song reference and region seam had maximum difference **zero**. Focused JavaScript rerun: **116 passed**, including the original 109 A100/cloud tests and seven MCP production tests; Python startup/telemetry rerun: **17 passed**. No mocked encoder replaced the real export path.

The first repaired gate run correctly detected two third-party SciPy implementation files in the newly created uv cache as unregistered suites. The setup now stores its cache inside the isolated venv, alongside its dependencies, rather than the repository census's source search area. The cache was relocated and the unchanged census passed all five checks. No repository suite or exemption was removed or added to suppress that failure. The failed run is retained at `tmp/cloud-manager/xl-sft-a100-census-failure.log`.

The next gate run passed the real DAW export lane but exposed a second interpreter override in the mandatory `server/vfx/routes_ram_test.js` harness: it preferred only `AIPLAY_RIG_PYTHON` or its hardcoded legacy rig fallback, replacing the gate's standard `AIPLAY_PYTHON`. The harness now honors its explicit override first, then the standard override, without changing its empty temporary rig or any pixel/cache assertions. Pillow and CPU-only OpenCV were added to the private test environment because the real VFX engine imports them. The standalone real HTTP VFX test then passed **all 36 checks**, including pixel invalidation, cold/warm/disk tiers, process restart, prewarm, cancellation, eviction and responsiveness. Evidence: `xl-sft-a100-vfx-path-failure.log` and `xl-sft-a100-vfx-ram.log`. No failing lane was skipped or disabled.

Test runtime: Python **3.12.14**, numpy **2.5.4**, scipy **1.18.1**, av **19.0.1**, soundfile **0.14.0**, Pillow **13.0.0**, opencv-python-headless **5.0.0.93**. FFmpeg/ffprobe were existing installed tools. `AIPLAY_PYTHON` and PATH changes are scoped to gate subprocesses, not persistent application configuration. Evidence: `tmp/cloud-manager/xl-sft-a100-gate-python-setup.log`, `xl-sft-a100-daw-export.log`, `xl-sft-a100-repair-focused.log`, `xl-sft-a100-repair-python.log`; complete publishing-gate output is retained at `xl-sft-a100-repaired-gate-commit.log`.

The publishing commit must complete that gate before publication. Exact resulting commit, local-versus-published installer SHA-256, decoded embedded supervisor identity and final read-only deployment feasibility belong to the final preflight evidence, not an inferred hardware acceptance result. No actual allocation, measured XL-SFT memory/timing or output/audio acceptance is claimed by this software repair.

A subsequent gate run reached the RoPE derivative lane and failed because the isolated interpreter had no torch. The existing lane treats a launched interpreter's missing dependency as failure; it was not bypassed. The setup now also installs **CPU-only torch from the official CPU index**, matching the project's existing CPU setup mechanism, and asserts that no CUDA runtime is present. Resolved version: **2.14.1+cpu**. No model weights or GPU libraries were installed. The real `scripts/rope_grad_check.py` passed, with reported tested gradient differences zero. Evidence: `xl-sft-a100-torch-failure.log` and `xl-sft-a100-rope.log`. The CPU torch dependency is additional to the six audio/image dependencies above.

CPU torch also enables the gate's existing audio-analysis lane, which imports torchaudio through `scripts/beats.py`. The private runtime now includes the official CPU-index torchaudio build (**2.11.0+cpu**); importing both packages and the actual audio analysis/resampling succeeded. `server/vfx/audiokeys_test.py` passed **65 checks**. The subsequent early gate rerun was interrupted before committing to complete this dependency, then the full gate was started again from the beginning. No mandatory lane was bypassed. Evidence: `xl-sft-a100-audiokeys.log`.
