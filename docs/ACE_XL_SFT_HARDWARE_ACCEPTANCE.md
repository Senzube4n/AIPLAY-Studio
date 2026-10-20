# ACE-Step 1.5 XL-SFT hardware acceptance

Status: **creation approved conditionally; pre-creation check failed availability; hardware testing not started**. Prepared 2026-10-19 against implementation baseline `444d0070352bb313016858ad07d411867ab64425`; safeguards published in `e23e1c1f369d666dc928f6e6f3c4407b70f0e21a`.

No computer has been created, started, stopped, updated or deleted for this phase. No model weights have been downloaded. No compatibility requirements have been changed. This is a cost proposal and acceptance procedure, not a successful inference report.

## 1. Existing implementation and evidence

Reviewed `shared/model-bundles.js`, `shared/model-profiles.js`, `server/setup-plan.js`, `server/workflow.js`, the existing account/inventory client, REST v2 client, reviewed automatic installer and prior implementation report. The full mandatory repository gate passed when commit `444d007` was created. Its retained output is `tmp/cloud-manager/model-first-commit-final.log`. For this preflight, the existing ACE suite was rerun: **15 passed, 0 failed**, including independent manifests/defaults, complete encoder receipts, selected-model readiness and local receipt evidence. Output: `tmp/cloud-manager/xl-sft-preflight-tests.log`.

Those tests establish software behavior and source metadata consistency. They establish no measured GPU memory requirement, loading speed, successful inference or audible quality for XL-SFT. XL-Turbo and XL-Base remain separately experimental.

## 2. Exact artifact and workflow verification

Rechecked publisher LFS sizes and SHA-256 metadata on 2026-10-19. All four files match the committed shared manifest at revision `6707deb277e9e0907fd9c14ce6b6f1d695c6a3fc`. This verifies published metadata; on-disk hashes must still be checked on the test computer after download.

| Component | Exact filename | Bytes | SHA-256 |
|---|---|---:|---|
| XL-SFT BF16 DiT | `acestep_v1.5_xl_sft_bf16.safetensors` | 9,974,719,930 | `3c05ae268353b3540fb1fd7db4fd77ffbda9802ec641b624e15648e030ecf3ce` |
| ACE VAE | `ace_1.5_vae.safetensors` | 337,431,732 | `6de92e3a862acd287e08b024ac90f0783a8635451b728721a33ff03565bcb2bb` |
| Lyric encoder | `qwen_0.6b_ace15.safetensors` | 1,191,588,248 | `fd4590c82153b8ddb67e15a2e7aaa8afa8b83a858c8a9b82a4831063156aa7a7` |
| 4B planner | `qwen_4b_ace15.safetensors` | 8,379,154,232 | `ffe5ffb855086c2ab55e467e9859fb01894781020a0376484dd19de166b79873` |

Total selected weights: **19,882,894,142 bytes**, about 19.9 decimal GB (18.5 GiB). This is disk size, not VRAM consumption. The current planner's selected-model allowance is 40 GB including its existing 20 GB working reserve; runtime installation, package caches, outputs and partial downloads additionally justify the existing installer's 100 GB minimum persistent volume for this test.

Rechecked the [official XL-SFT workflow](https://github.com/Comfy-Org/workflow_templates/blob/59a3b48bf369c5a15f29a1308bae3e279fa15505/templates/audio_ace_step1_5_xl_sft.json) at revision `59a3b48bf369c5a15f29a1308bae3e279fa15505`. It uses these exact four files, DualCLIP type `ace`, 50 steps, CFG 7, Euler/simple, denoise 1 and AuraFlow shift 3. Its example duration is 120 seconds; this acceptance deliberately sets both conditioning and latent duration to **30 seconds**, batch 1, as requested. The current AIPLAY graph builder already sets both duration inputs consistently.

Public metadata review: `tmp/cloud-manager/xl-sft-manifest-review.json`. [Pinned publisher tree](https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/tree/6707deb277e9e0907fd9c14ce6b6f1d695c6a3fc).

## 3. Cost and resource proposal

Read-only account discovery succeeded at **2026-10-19 16:24 UTC** and returned **zero Pods**. Credentials were read through AIPLAY's existing secure vault, kept in process memory and used only with the official provider. Nothing was written to the credential store. Both read-only inventory and official v2 quotes were checked; no mutation requests were sent.

Preferred candidate: **one NVIDIA A40, 48 GB VRAM, Secure Cloud, on-demand**. The [NVIDIA A40 datasheet](https://images.nvidia.com/content/Solutions/data-center/a40/nvidia-a40-datasheet.pdf) confirms BF16 hardware support; that does not establish XL-SFT inference acceptance. This is a conservative validation candidate, not a measured model minimum or a production compatibility claim.

At **16:25 UTC**, REST v2 with `count=1`, `cloud=SECURE`, `product=POD` and `minCudaVersion=12.8` reported **$0.59/hour**, low availability, with candidate capacity in CA-MTL-1 and EU-SE-1. Drivers advertising CUDA 13.0/13.2 had capacity; exact 12.8 did not. A newer compatible driver can run the installer's CUDA 12.8 runtime, subject to actual runtime validation. Recheck immediately before the reviewed create request. This listing reserves nothing.

| Item | Proposed configuration | Cost basis |
|---|---|---|
| GPU | 1 A40, 48 GB VRAM, Secure Cloud | $0.59/hour current catalog estimate |
| Host RAM | Request at least 64 GB; record actual allocation and available memory | Conservative test allocation, not measured model requirement |
| CPU | Request at least 8 vCPUs | Test placement requirement, actual allocation recorded |
| Persistent workspace | 100 GB, `/workspace` | $10/month running; **$20/month stopped** |
| Temporary container disk | 20 GB | $2/month running; no stopped charge |
| Session | Up to 2 hours, including setup/downloads and shutdown | $1.18 compute; about $1.22 including session storage, before applicable taxes |
| Requested authorization | Up to **$2 additional session charges and 2 hours**, plus retained storage above | Operational budget, not a provider-enforced billing cap |

Storage estimates use [official RunPod pricing](https://docs.runpod.io/pods/pricing). The illustrative two-hour calculation uses a 730-hour month. Charges are accrued, not a full month's prepayment. Stopping compute leaves persistent storage billed at about $0.0274/hour, $0.66/day or $20/month until the user chooses to remove it. Retained storage after the session is separate from the proposed $2 test-session allowance. No deletion or termination is proposed.

The $0.35/hour A40 Community listing has **no available capacity** and must not be used as the approval price. Alternatives observed include RTX 6000 Ada Community at $0.74/hour and A100 PCIe 80 GB Community at $1.19/hour, both low stock. They are comparison quotes only; no automatic replacement or fallback is authorized by approving the A40 proposal. If price, pool, resource allocation or availability prevents this proposal, pause for a fresh review.

Private resource names, balance and credentials are excluded from this report. Sanitized diagnostic quotes: `tmp/cloud-manager/xl-sft-readonly-inventory.json` and `xl-sft-a40-quote.json`.

## 4. Pre-provisioning safeguards

1. Obtain explicit approval for this computer, price ceiling, runtime, install/inference, test-job cancellation if needed to meet the deadline, safe stop and ongoing retained-storage charges. No historical budget is reused.
2. **Implemented:** the existing reviewed installer accepts only the explicit `ace15-xl-sft-v1` acceptance policy and additional `CREATE BOUNDED XL-SFT TEST` confirmation. The policy locks A40, Secure Cloud, 100 GB persistent/20 GB temporary disk, at most $0.59/hour, CUDA >=12.8, `gpu.minRamPerGpu: 64` and `gpu.minVcpuCountPerGpu: 8`. Floors and the 90/120-minute policy are included in the persisted review signature. These placement fields are documented in the current [official REST v2 OpenAPI contract](https://api.runpod.io/v2/openapi.json). Normal installations retain their existing defaults. GPU inventory does not prove RAM/vCPU-specific placement availability; a capacity rejection requires reconciliation and another human review, never an alternate GPU or replacement. The remote supervisor also checks the actual allocated RAM/vCPUs, GPU, pool, actual rate and storage before launching installation.
3. **Implemented:** an opt-in ComfyUI diagnostic wrapper captures one-second target samples of physical GPU used/free/total memory, process RSS, host available RAM and cgroup usage/limits where readable. Scopes and unavailable counters stay distinct. It records checkpoint deserialization, inclusive GPU load/offload calls and selected node durations, including the 4B planner and sampler. It preserves sync/async behavior, staticmethod/classmethod binding and original return/exception behavior; diagnostic write errors do not become inference errors. The wrapper observes ordinary ComfyUI imports after its environment setup instead of importing torch prematurely. Timings are inclusive and can overlap; sampled maxima are not instantaneous or PyTorch allocator peaks. Bounded summaries and installed-hook lists are persisted remotely and exposed only over authenticated fixed diagnostic routes. The local guarded backend verifies computer/session identity before returning diagnostics. No generic remote execution API or replacement model registry was added.
4. **Implemented:** the exact committed Python bootstrap is embedded in the acceptance startup command, so the supervisor exists before any installer/network download. Older published bootstraps without acceptance protocol 1 cannot be used. Creation fixes absolute timestamps, a monotonic workload window, a persistent deadline journal and clock rollback checks. The bootstrap checks its clock against the provider's HTTP Date before starting installation. At 90 minutes, new jobs, queued starts, model installations and other writes are refused; existing jobs still reconcile. The supervisor uses the established worker cancellation/persistence preparation, then stop-only REST v2 on this same Pod. It uses the final 30 minutes as a shutdown reserve; after ten minutes of unsuccessful draining it can terminate only process groups started by this test and reuse `CloudStorage.persist` independently of the worker. Before a runtime/output exists, the fallback verifies the persistent mount and flushes it; it refuses that fallback if job/output evidence requires the installed verifier. Tracked outputs are checksummed and all persistent writes flushed; partial/unfinished outputs are retained without being labelled completed. No normal idle policy can replace this fixed deadline, and the app refuses restarting this spent acceptance session without a new review.
5. Confirm the publisher's applicable model terms before downloading if existing recorded acceptance does not cover ACE XL-SFT. Preserve existing terms approval and credential storage.

### Separate stop credential

The user explicitly authorized creation and vault storage of **AIPLAY XL-SFT deadline stop**. The actual RunPod console offers no Pods-only management scope: the user separately approved **account-wide GraphQL Read/Write, with AI API access None**. Do not describe this as a provider-enforced Pod-scoped key. Its authenticated, read-only Pod discovery succeeded, and local Windows DPAPI storage was verified usable/encrypted. The main account key is rejected as an acceptance stop key and is never sent to the Pod.

The separate credential remains local until final billable creation approval. On the approved computer, only the bootstrap supervisor inherits it; it is removed from the environment before launching git, package installation, ComfyUI or the worker. This reduces incidental exposure; it does not protect against an administrator/root process on the Pod. Provider-side environment configuration can retain the value. The user may revoke the separate key after confirmed shutdown. No credentials, prefixes or private account data appear in this report or source artifacts.

### Shutdown guarantees and failure reporting

The supervisor owns the acceptance stop credential; the worker's ordinary idle watchdog is not a competing stop sender. Worker preparation verifies persistent storage through the existing lifecycle. A stop intent is journalled before the sole stop POST. An ambiguous response permits GET reconciliation only, including after process restart. The UI/diagnostic state says stopped only after provider-confirmed EXITED. No start, terminate, delete, resize or replacement operation exists in this supervisor.

This is a tested remote deadline and safe-stop policy, **not a provider-enforced spending cap or an unconditional guarantee that RunPod will accept a stop**. Provider/key/network failures or unverified storage can prevent safe confirmed shutdown. In those cases it retains diagnostics, records an overrun if applicable and does not falsely report success. Actual provider stop permissions and end-to-end behavior will be exercised during the approved hardware test; they cannot be proven by an offline simulation or a read-only request alone.

### Validation evidence

- Existing focused JS suites: **124 passed, 0 failed** (`tmp/cloud-manager/xl-sft-focused-final.log`). Includes reviewed provisioning, no substitutions, higher prices/storage changes refused, old bootstrap refusal, immutable floors/deadlines, uncertain create recovery, guarded credentials/diagnostics, worker cutoff, continued reconciliation, existing cloud lifecycle and normal inference regressions.
- Existing Python startup suite: **17 passed**, including fixed reserve, desktop-independent shutdown, supervisor restart, monotonic/clock rollback, lost stop reply with no repeated mutation, stuck worker/install failure, persistence veto, incorrect hardware, telemetry scopes/units, sync/async/descriptor preservation, diagnostic disk failure and an actual subprocess running a synthetic ComfyUI entrypoint through the wrapper. No model or GPU inference was used.
- Browser verified the existing stop-key form can be used before creating a computer, the vault save succeeds, its password field clears and the interface still states that creation requires approval. A form-placement error found in browser validation was fixed and regression covered.
- Source-only reproducible archive: `dist/aiplay-cloud-worker-c715a4a47f7e.tar.gz`, 19 source files, build `c715a4a47f7e4fab2762a6cd95a76ffeffb0bfb09e3b4e5f0a6f739e16fd4aad`, archive SHA-256 `38c7bf0ad76fd2a823c5d626ba37cfcfd3f74df74057f9c6f72645a624407529`. No models, account secrets or remote deployment.
- The mandatory repository gate is enforced by the publishing commit without bypass; its final delivery result and commit are reported to the user. Output is retained at `tmp/cloud-manager/xl-sft-safeguards-commit.log`.

The exact price, CUDA-qualified Secure availability and absence of existing Pods will be rechecked after validation and again inside the existing creation review immediately before the one approved create request. No price listing constitutes a reservation.

## 5. Controlled inference acceptance procedure

1. Perform complete resource discovery, re-review the exact A40 Secure quote and CUDA placement, then send at most the existing journalled creation request. Recover timeouts by discovery; never create a replacement because a response was lost. Verify actual GPU, host allocation, price and retained storage. Stop before weights/inference if allocation is below the approved specification.
2. Use the existing pinned worker/ComfyUI installer. Record AIPLAY worker commit/build identity, ComfyUI commit/version, Python, PyTorch, CUDA runtime, driver, startup arguments and offload/attention settings. Do not silently update versions during the measurement. The current planned ComfyUI pin is `ce1e922d8623bb507180e32a0c01a7d0e29edef7`; verify the actual source and runtime rather than assuming the pin was installed.
3. Install **only `ace15-xl-sft`** through the existing checksummed bundle installer, directly to persistent RunPod storage. Verify all four on-disk sizes/hashes and installation state. No 1.7B substitution, standard Turbo fallback, quantized replacement or optional LoRA. Query actual object-info and validate the exact graph before submitting it.
4. Start durable telemetry before any model load; record an idle baseline. Capture timestamped GPU total/used/free and process-attributed GPU usage where available (e.g. `nvidia-smi`, 0.5–1 second samples). Report the sampling interval and gaps: a sampled maximum is a **peak observed**, not a guaranteed instantaneous peak or PyTorch allocator peak.
5. Capture allocated host/container RAM limit, cgroup memory current/peak where available, swap, and ComfyUI process RSS/PSS where readable. Keep whole-host `MemAvailable`, container usage and ComfyUI process memory separate, especially on shared hosts. A lifetime cgroup high-water mark cannot be called a per-job peak without a valid measurement boundary. Record unavailable counters explicitly.
6. Record monotonic timing at checkpoint deserialization/model-load boundaries using a narrowly scoped diagnostic wrapper against the pinned runtime, and capture per-node execution timing, including CPU-to-GPU load/offload calls. Distinguish checkpoint I/O, transfer, planner execution, sampling, VAE decode and encoding. Do not label the whole planner node as model-loading time, or double-count nested loader calls. Preserve the original inference behavior and record instrumentation overhead/limitations.
7. Submit through the existing AIPLAY worker job path. Use a fixed recorded seed (e.g. 20261019), 30 seconds, 50 steps, CFG 7, shift 3, Euler/simple, batch 1, 4B planner with audio-code generation enabled. Prompt: **"Instrumental electronic music, 120 BPM, warm synthesizer chords, clear drum groove, evolving bass line, no vocals."** Empty lyrics; C major; 4/4. No reference audio, LoRA or extra model. Use the existing lossless FLAC save path and record the actual output encoding/sample rate/channels. Do not change the user's persistent generation defaults for this test.
8. Measure first-run elapsed time from execution start to persisted output; separately report queue time, loading/planner time, 50-step sampling duration, decode/save and end-to-end time. If budget/time permits, run a second distinct seed with the same workload as a warm comparison, verify that execution was not entirely cache-served, and label it separately. One successful cold inference is the initial acceptance priority.
9. Check terminal worker status, complete step count, errors/OOMs, offloading and final output existence. Use existing artifact transfer/adoption verification. Persist output, job receipt, graph fingerprint, on-disk artifact hashes, timings and telemetry in retained storage; export the evidence/audio locally and verify the output SHA-256 at both ends.
10. Decode/probe the audio (FLAC, duration near 30 seconds, finite samples, nonzero signal, sample rate/channels) and inspect clipping/silence/discontinuities. Listen to the **whole** sample for coherent electronic music, noise, dropouts, unintended speech and major distortion. Automated signal checks do not constitute subjective listening acceptance. If playback cannot be assessed by the agent, hand the exported sample to the user and keep playback acceptance pending until confirmed.
11. Stop compute through the existing safe-stop path once results are persisted. At the deadline, cancel only this acceptance job if required by the approved budget, verify saved artifacts, then stop and confirm the provider reports EXITED/stopped. Do not merely infer shutdown from a disconnected worker. Never terminate the Pod or delete its persistent volume.

## 6. Evidence ledger

All empty fields are pending actual hardware testing, not zero values.

| Required evidence | Current state |
|---|---|
| GPU model / VRAM | Proposed A40 / 48 GB; actual device not measured |
| Allocated / available host RAM | Proposed at least 64 GB; actual not measured |
| Worker / ComfyUI / CUDA / PyTorch versions | Source baseline known; installed runtime pending |
| Four artifact SHA-256 values | Publisher metadata verified above; on-disk verification pending |
| Peak observed GPU memory | Not measured |
| Peak observed container/process/host memory | Not measured; scopes must be reported separately |
| Cold model loading duration | Not measured |
| Planner / sampling / total generation duration | Not measured |
| Output format / duration / sample rate / channels | FLAC / 30 seconds intended; no output yet |
| Output SHA-256 / persisted local export | No output yet |
| Full-sample playback validation | Pending |
| Runtime errors / offload behavior | Not observed on hardware |
| Confirmed stopped provider state / actual charges | No test resource exists |

## 7. Feeding evidence back into the existing planner

After successful measured inference and playback, update the existing XL-SFT capability/profile through `server/models.js`, `shared/model-profiles.js` and the current `fitFor`/setup-plan path. Store a reference to the acceptance evidence, exact artifact/workflow identity and accepted workload. Reuse existing current-inventory price ranking.

One A40 run can establish a **tested compatible configuration**, not the mathematical minimum VRAM/RAM, compatibility with every 48 GB GPU, or a generic XL-family guarantee. Distinguish a conservative tested allocation from the observed peak and reserve/headroom policy. Require CUDA/BF16/runtime compatibility as well as memory. If necessary, retain experimental status while exposing scoped successful evidence rather than prematurely applying broad memory thresholds.

The initial wizard may recommend the tested configuration or an explicitly qualified equivalent only to the extent the evidence and existing compatibility fields justify it. Smaller cards, other precisions, other planners, longer songs, batch sizes, LoRAs, reference audio, native backends, XL-Turbo and XL-Base remain unverified. Add focused regressions for that scope, changed workload, missing companions, old worker build and insufficient host RAM; run the mandatory gate before publishing source changes.

## 8. Approved attempt and availability outcome

The user explicitly approved one A40 Secure Cloud test computer at **no more than $0.59/hour**, at least **64 GB host RAM / 8 vCPUs**, **100 GB persistent + 20 GB temporary storage**, up to **2 hours / $2 additional session charges**, with the specified installation, inference, evidence collection and safe stop. Retained persistent storage was separately approved at approximately **$20/month while stopped**. The approval expressly requires stopping and requesting renewed approval if the approved configuration is unavailable or materially changes. Termination, deletion, resizing, alternative GPUs and replacement computers remain excluded.

The read-only pre-creation check at **2026-10-19 17:14:13 UTC (19:14:13 Europe/Berlin)** returned **overallAvailability: NONE** for NVIDIA A40 Secure Cloud with the required CUDA runtime compatibility (minimum 12.8). The catalog rate remained **$0.59/hour**, but a price listing does not establish available capacity. Since this GPU/runtime check failed, actual placement meeting the 64 GB RAM / 8 vCPU floors could not be attempted or validated.

The check discovered **zero Pods**, confirmed the separate stop credential was usable and encrypted locally, and verified the published pinned installer. It performed three provider read requests and **zero billable mutations**. No creation request was sent, no Pod or storage was created, no weights were downloaded and no inference ran. This attempt incurred no test resource charges. There is no test computer requiring shutdown and no provider-confirmed shutdown result to report.

Sanitized evidence: `tmp/cloud-manager/xl-sft-final-preflight-inventory.json`. The evidence ledger above remains pending; no measured compatibility result has been added to the planner. The test is awaiting available approved capacity and renewed user approval before another attempt. No automatic retry or alternative provisioning is scheduled.

### One additional approved attempt

The user subsequently authorized **one additional reviewed attempt**, with all hardware, storage, price, time and spending limits unchanged, and explicitly required stopping again if A40 Secure capacity remained unavailable.

- **2026-10-19 17:18:18 UTC (19:18:18 Berlin):** the fresh read-only preflight reported A40 Secure **LOW** stock at **$0.59/hour**, zero existing Pods, a usable encrypted separate stop credential and a verified published supervisor.
- **17:18:27 UTC:** the existing installer review returned HTTP 200 with the same price, pool and acceptance policy, including the 64 GB RAM / 8 vCPU floors and 90/120-minute workload/shutdown windows.
- **17:18:40 UTC:** the single authorized local creation submission was rejected with HTTP 400, **"This graphics card is unavailable. Review another computer."** The installer's mandatory final quote failed before the creation journal or provider create POST. The historical installer state remained `removed`, with no new acceptance request or Pod recorded. The generic suggestion to review another computer was not acted on.
- **17:18:54 UTC:** one read-only provider reconciliation confirmed **zero Pods** and no acceptance computer. No further availability query, create retry, alternative GPU or replacement was attempted.

No billable resource was created, no new retained storage exists from this attempt and no test resource charges were incurred. No installation, inference, telemetry measurement, output generation or shutdown was possible. Provider-confirmed shutdown is **not applicable because no test Pod exists**, rather than a successful shutdown result. Actual VRAM/RAM, load/generation timings and audio acceptance remain unmeasured; the planner retains its unverified profile status.

Sanitized evidence is retained in `tmp/cloud-manager/xl-sft-approved-retry-preflight.json`, `xl-sft-approved-retry-installer-review.json`, `xl-sft-approved-retry-create-result.json` and `xl-sft-approved-retry-reconciliation.json`. This single additional attempt is finished. Further provisioning requires renewed authorization; no automatic retry is scheduled.
