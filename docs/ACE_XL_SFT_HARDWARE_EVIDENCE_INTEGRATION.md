# XL-SFT hardware evidence integration

This change integrates the accepted 20 October 2026 A100 test into the existing model profiles, catalogue requirements, `fitFor`, setup planner, inventory ranking and RunPod wizard. It does not create a new registry, recommendation service or inference implementation.

## Evidence provenance

Authoritative report: [A100 hardware acceptance](ACE_XL_SFT_A100_HARDWARE_ACCEPTANCE_RESULT.md). The verified original ZIP SHA-256 is `e5e90296d67e9139a58614ac69e3811784c994e34085cffeee3fd0d4fe51e1ee`. All ZIP members were checked against its manifest before integration. A selected immutable source snapshot is committed in [docs/evidence/ace15-xl-sft-a100-2026-10-20.json](evidence/ace15-xl-sft-a100-2026-10-20.json), without credentials or model weights.

Regressions bind the four exact pinned artifacts, accepted prepared/executed graph identities, output checksum, runtime, measurements and human playback review to the existing XL-SFT profile. The 4B planner, 50 steps, CFG 7, 30 seconds and batch 1 remain exact. The preflight graph uses the accepted instrumental test workload; it does not change generation preferences or submit inference.

## Supported claims

| Situation | Claim |
|---|---|
| Historical reference | XL-SFT instrumental workflow hardware-validated on one full A100-SXM4-80GB Secure Pod, 117 GB allocated RAM, 24 vCPUs and the recorded runtime |
| Matching inventory SKU with Secure support and known stock/price | Candidate for reviewed provisioning; live allocation, Secure pricing and runtime still need verification |
| Full machine/context passed to `fitFor` | Validated fit only when exact GPU, count, VRAM, pool, allocation, image, runtime, workflow and artifact identities match the accepted reference |
| 24/32/48 GB GPUs, A100 PCIe, other 80 GB GPUs, local execution | No compatibility validation inherited from this test |
| Different planner, steps, CFG, batch, duration, lyrics, style, sampler, output type, LoRA or artifacts | No hardware validation inherited |
| XL-Turbo / XL-Base | Experimental and unverified |
| Minimum VRAM or host RAM | Not established; catalogue floors remain unknown |
| New worker / missing files / stopped Pod | Historical test does not imply installed models or current readiness |

Observed peaks are **23,080,206,336 bytes whole-GPU usage** and **22,331,850,752 bytes Comfy process RSS**, sampled once per second. Generation was **29.841 seconds**. These are observations, not floors, total-container RAM, hard peaks or cold disk benchmarks. Loader call durations and runtime identity remain available in the evidence metadata. A one-off test is not a speed guarantee.

The wizard shows an A100 test badge and measured values inside its existing requirements disclosure. Existing installation and selected-model readiness remain authoritative for each computer. Current inference acceptance still requires a completed verified job on that worker/build/workload; the static hardware record is never used as its substitute. Generic catalogue fit calls without workload identity remain unknown for XL.

## Validation and publication

Focused command: `node --test server/ace-step_test.js server/fit_test.js server/engine/remote_ui_test.js server/engine/remote_guard_test.js server/engine/remote_test.js`.

Result: **90 tests passed**, including seven added evidence/readiness/UI regressions; the existing fit suite additionally reported **98 assertions passed**. Tests use synthetic inventories, temporary app data and local fake workers. They perform no paid provider operations or model downloads.

The normal mandatory `.githooks/pre-commit` must succeed before commit/publication. Its exact execution evidence is retained locally at `tmp/cloud-manager/xl-sft-evidence-gate-commit.log`; the final handoff records its resulting commit and publication checks. It runs with the existing isolated CPU interpreter via process-scoped `AIPLAY_PYTHON` and PATH, without changing installed application settings.

No RunPod resources are created, started, restarted, terminated, deleted or resized by this integration. Persistent storage is preserved. The prior hardware report's billing observation remains historical; this software task does not imply an updated provider invoice.
