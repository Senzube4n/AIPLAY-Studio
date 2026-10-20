# ACE-Step 1.5 XL-SFT: A100 hardware acceptance result

Date: 20 October 2026. **PASS for the exact tested configuration and workload.** One reviewed creation and one inference job completed. Automated output checks passed, and the user accepted the full-sample listening review with “sounds good”. Compute is stopped: RunPod reported **EXITED** at 15:33:54.610 UTC and again at 15:40:38.612 UTC. Persistent storage remains intact.

This result supersedes the pending hardware sections in the historical A100 preflight report. It does not establish minimum hardware requirements or compatibility for smaller GPUs, other ACE variants, longer audio, different planners or larger batches.

## Identity, authorization and software evidence

- Tested/published worker commit: `7447b9b5f322aa9312e8227d348980338b9ac69e`, repository `nemesisone-dev/AIPLAY-Studio`.
- Pod: `5sqxne8ojerewm`; journalled creation request: `d3e90a18-c9ca-496f-90ee-913bac818202`.
- Worker job: `60864629-be3d-44ae-8d97-816a1032dcd3`; Comfy prompt: `810a12d1-2353-4ae4-8476-d94856d1b8b6`.
- Approved: one full A100 SXM 80 GB, Secure only, at most $1.79/hour, minimum 64 GB host RAM / 8 vCPUs, 100 GB persistent / 20 GB temporary storage, 120-minute session, 90-minute workload cutoff and $5 operational allowance. No substitute, replacement or automatic retry was used.
- Mandatory repository gate passed before publication. Gate log SHA-256: `10862bc96bc0b38ef325651de86eb41b3c2862794fa0fd86630b98cfe505a2ab`. Focused evidence included 116 JavaScript and 17 Python tests; DAW export 53, VFX preview 36, audio analysis 65 and RoPE gradient checks passed. Individual suites do not replace the full gate.
- Bootstrap acceptance protocol 2. The exact published bootstrap was verified before creation: SHA-256 `3278733a6ce40ad9466b8424ec9f760cd4e6ea8265eedd39ea006780f4b07003`. Embedded supervisor and bounded policy agreed.
- Source worker archive build: `af8bcb06119881fc628b3af72d1e98b91095c645afceb0f96455a1afcd24a49a`; archive SHA-256 `e51c6ac531ccdff1515f178c68e9f444c864010e13a07fb0ac0cfd0aa18dac23`.

## Actual allocated hardware and runtime

| Item | Verified result |
|---|---|
| GPU | One full NVIDIA A100-SXM4-80GB |
| Pool / hourly GPU rate | Secure / $1.79 |
| Physical GPU memory reported by telemetry | 85,899,345,920 bytes (80 GiB) |
| Driver-available GPU memory in Comfy health | 85,094,825,984 bytes |
| Allocated host RAM / vCPUs | 117 GB / 24, provider-reported |
| Storage | 100 GB persistent at `/workspace`; 20 GB temporary |
| Image | `runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404` |
| Worker | Exact commit above; runtime ready and connected |
| ComfyUI | 0.41.0; pinned source `ce1e922d8623bb507180e32a0c01a7d0e29edef7` |
| Python / PyTorch / CUDA runtime | 3.12.3 / 2.8.0+cu128 / 12.8 |
| NVIDIA driver version | Not exposed by collected authenticated diagnostics; not independently recorded |

Actual provider allocation and runtime health were checked before model installation. Shared-host `/proc/meminfo` reported 1,014,483,017,728 bytes total and 964,109,131,776 bytes available before inference. These describe the physical shared host, not a dedicated Pod entitlement. Container/cgroup usage and limits were unavailable in this diagnostic output. The provider's 117 GB allocation is recorded separately; it is not inferred from shared-host memory.

## Exact model artifacts

Only bundle `ace15-xl-sft` was installed. Hugging Face revision: `6707deb277e9e0907fd9c14ce6b6f1d695c6a3fc`; workflow template revision: `59a3b48bf369c5a15f29a1308bae3e279fa15505`.

| Artifact | Bytes | Verified pinned SHA-256 |
|---|---:|---|
| `diffusion_models/acestep_v1.5_xl_sft_bf16.safetensors` | 9974719930 | `3c05ae268353b3540fb1fd7db4fd77ffbda9802ec641b624e15648e030ecf3ce` |
| `vae/ace_1.5_vae.safetensors` | 337431732 | `6de92e3a862acd287e08b024ac90f0783a8635451b728721a33ff03565bcb2bb` |
| `text_encoders/qwen_0.6b_ace15.safetensors` | 1191588248 | `fd4590c82153b8ddb67e15a2e7aaa8afa8b83a858c8a9b82a4831063156aa7a7` |
| `text_encoders/qwen_4b_ace15.safetensors` | 8379154232 | `ffe5ffb855086c2ab55e467e9859fb01894781020a0376484dd19de166b79873` |

Total: 19,882,894,142 bytes. Verification used the established worker installer: its subsequent `inspect(id)` rehashed every on-disk artifact against the pinned SHA-256 and returned ready without an active download. Independent disk inventory confirmed the exact four paths and sizes. The endpoint reports hash equality rather than returning newly computed digest strings; this is not represented as an independent shell `sha256sum` measurement. No other model bundle was installed for this test.

## Workload and workflow validation

The existing `buildAceStep15Graph` builder and runtime `validateGraph` checked the ten-node graph against the actual ComfyUI node schema. No additional registry, inference path or recommendation engine was introduced.

- Prompt: “Instrumental electronic music, 120 BPM, warm synthesizer chords, clear drum groove, evolving bass line, no vocals.”
- Seed 20261019; empty lyrics; 120 BPM; C major; 4/4; language `en`.
- Duration 30 seconds in both conditioning and latent; batch 1.
- XL-SFT BF16 DiT; ACE 1.5 VAE; Qwen 0.6B lyric encoder and compatible Qwen 4B planner.
- 50 steps, CFG 7, Euler sampler, simple scheduler, shift 3, denoise 1.
- Planner audio-code generation enabled; planner CFG 2, temperature 0.85, top-p 0.9, top-k 0, min-p 0.
- Default model precision/loading policy; no LoRA, reference audio, quantization substitution or manual offload changes.
- Prepared graph SHA-256: `89969dd074b61bc40f31504e57ed3e3841ef6a7a4e826cac77766d82fe67f2df`.
- Executed graph hash after the worker output-prefix rewrite: `7e961fad7cf91debfbe9235ddd6b1022d9d36b210f209276476653f9c8a65640`.

Exactly one generation was performed. Persistent user generation defaults were not changed.

## Observed memory and timings

Telemetry sampled at one-second intervals from Comfy startup through completion: 375 samples, no recorded gaps, no dropped timing records and no diagnostic write errors.

| Measurement | Observed result |
|---|---:|
| Peak whole-device GPU memory used | 23,080,206,336 bytes = **21.50 GiB** |
| Pre-inference whole-device GPU baseline | 445,644,800 bytes = 0.415 GiB |
| Peak sampled Comfy process RSS | 22,331,850,752 bytes = **20.80 GiB** |
| Pre-inference Comfy process RSS | 1,211,084,800 bytes = 1.128 GiB |
| Latest measured process swap | 0 bytes |
| Container total/peak memory | Unavailable |
| VAE loader node | 1.312 seconds |
| Dual text encoder loader node | 0.318 seconds |
| UNET loader node | 0.209 seconds |
| Sum of these three loader node calls | **1.838 seconds** |
| Four checkpoint-deserialization calls combined | 0.022 seconds |
| Planner / text encoding node | **12.780 seconds** |
| KSampler node, requested 50 steps | **13.154 seconds** |
| Audio VAE decode | 0.477 seconds |
| FLAC save node | 0.082 seconds |
| First node start to final node end | **28.443 seconds** |
| Worker job start to completion | **29.841 seconds** |
| Remote queue before job start | 0.709 seconds |

The GPU peak is a sampled whole-device value including runtime baseline, not a per-process allocator maximum. Process RSS is not whole-container or total system memory. The one-second sampler can miss shorter spikes. Whole-host available RAM ended at 949,947,088,896 bytes; changes include unrelated shared-host activity and cannot be attributed solely to inference.

Loader timings are instrumented call wall times, with memory-mapped weights and OS page cache warmed by checksum verification. They do not measure a cold physical-disk load or all deferred tensor transfers. Three nested GPU load/offload wrapper calls totalled 0.390 seconds; they do not distinguish transfers/offloads and must not be added to inclusive node times. The diffusion loader's 0.208-second call is nested in UNETLoader. Timings use remote monotonic clocks; worker job duration uses only remote worker timestamps. No remote/local clock subtraction was used.

No OOM, inference error, failed instrumented call or required manual offloading was observed. This does not prove that no internal ComfyUI offloading occurred. No repeated-run, long-duration or stress benchmark was performed.

## Output integrity and listening review

File: [ace-step-1.5-xl-sft-a100-30s.flac](../tmp/cloud-manager/xl-sft-a100-results/ace-step-1.5-xl-sft-a100-30s.flac).

| Check | Result |
|---|---|
| Container / encoding | FLAC, 16-bit PCM |
| Sample rate / channels | 48,000 Hz / stereo |
| Frames / duration | 1,440,000 / exactly 30.000 seconds |
| File size | 2,549,013 bytes |
| SHA-256 | `15a832bd96a2ddc92541093e3217b0696729ef90aec172877af9ce721e0c051d` |
| Remote manifest, adopted local output and exported copy | Matching checksum |
| Decode, sample finiteness and structural checks | Passed |
| Samples at absolute amplitude >= 0.9999 | 0 |
| All-channel zero frames | 0 |
| Per-channel sample peaks | -1.805 / -1.427 dBFS |
| Integrated loudness / loudness range | -11.6 LUFS / 3.1 LU |
| FFmpeg true peak | -1.3 dBFS |
| Full-sample human review | User replied “sounds good” |

Automated analysis found a very quiet tail from **25.8 to 30.0 seconds**, below -60 dBFS RMS in 100 ms windows. The file is structurally a full 30 seconds; this result does not claim 30 seconds of equally audible music or infer that the tail was intentional. The observation is retained alongside the user's accepted listening review. Automated signal tests alone do not prove musical coherence or absence of speech.

## Deadline, preservation and shutdown

The separate vaulted shutdown credential and desktop-independent remote supervisor were verified before downloads. The supervisor was watching with the approved 90/120-minute absolute bounds. Credentials are excluded from all exported evidence.

| Event | UTC, 20 October 2026 |
|---|---|
| Session issued / supervisor deadline origin | 15:26:07.970 |
| Provider start timestamp | 15:26:13.787 |
| Actual RUNNING allocation checked | 15:26:29.427 |
| Output exported and checksum matched | 15:33:25.604 |
| Idle safe-stop requested | 15:33:25.605 |
| Stop reply received | 15:33:30.100 |
| First provider-confirmed EXITED | **15:33:54.610** |
| Final read-only EXITED check | **15:40:38.612** |
| Scheduled new-work cutoff, not reached | 16:56:07.970 |
| Scheduled hard stop deadline, not reached | 17:26:07.970 |

The existing idle-stop path was used only after job completion and checksum-matched local output/evidence preservation. Stop request `4f73731e-de3d-4eaf-b1e5-272e4bf2f502` was followed by read-only provider reconciliation. A successful HTTP stop reply was not treated as stopped until the provider returned EXITED.

The run finished early; deadline expiry, forced cancellation and actual desktop-disconnection recovery were not deliberately exercised in this paid run. Those behaviors have software regression evidence, plus a live armed supervisor, rather than a new end-to-end fault-injection result. No Pod termination, storage deletion or resize occurred. The 100 GB persistent volume and its files remain retained.

## Charges: estimates versus provider billing

Elapsed session origin to first EXITED confirmation: **466.64 seconds (7 minutes 46.64 seconds)**. Conservative time-based estimates at the approved rate:

- GPU compute: **$0.232024**.
- Running storage: **$0.002131**, using $12/month for the 100 GB persistent plus 20 GB temporary allocation and a 730-hour month.
- Combined session estimate: **about $0.2342**, before any applicable taxes or provider billing adjustments.

**Actual billed charges are not yet available.** The scoped provider billing query for this Pod on 20 October returned zero billing records at the final check. Its zero-valued aggregate is not evidence that the session was free. The provider allocation confirmed the $1.79/hour GPU rate, but no actual-charge claim is made until records appear. This report therefore cannot provide a provider-confirmed final billed total.

Stopped persistent storage remains approximately **$20/month**, outside the $5 operational session allowance. The Pod was not terminated, so these recurring storage charges continue until the user separately removes it. The operational budget and deadline are not provider-enforced billing caps.

## Compatibility conclusion and planner handoff

Verified evidence applies to **one A100-SXM4-80GB Secure Pod with 117 GB allocated RAM, 24 vCPUs, this exact software/artifact set and the single 30-second batch-1 workload**. It supports recommending that exact tested configuration for this workload through the existing planner.

It does not validate the original 64 GB host minimum as a measured minimum, prove 48 GB or smaller GPU compatibility, validate XL-Turbo/XL-Base, or establish requirements for longer audio or multiple concurrent jobs. Sampled memory peaks must not be used as hard minimum resource requirements. Other configurations retain their existing unverified status. No new recommendation engine, model registry, UI redesign or inference change was made during acceptance. A scoped machine-readable observation is included in `compatibility-observation.json` for the existing planner's evidence handoff; the shipped generic profile thresholds are unchanged.

## Evidence and reproducibility

The local evidence directory contains the submitted graph, runtime node schema, exact artifact-verification receipt, sanitized provider allocation/health, deadline and runtime telemetry, job completion/output receipts, memory/timing summary, audio checks, stop reconciliation and scoped billing queries. The evidence manifest lists byte sizes and SHA-256 values. The accompanying ZIP includes the final report, audio and selected diagnostic evidence, excluding credentials, unrelated user files and model weights.

The historical preflight/repair report remains at `docs/ACE_XL_SFT_A100_HARDWARE_ACCEPTANCE.md`. Gate/publication receipts and hashes are included for provenance; tests were not needlessly rerun after the successful published build, and no worker source changed during this acceptance run.
