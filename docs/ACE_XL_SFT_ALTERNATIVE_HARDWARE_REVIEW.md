# XL-SFT alternative RunPod hardware review

Status: read-only comparison and revised proposal, not hardware acceptance or provisioning approval.

Inventory checked **2026-10-19 17:20:55–17:20:57 UTC (19:20:55–19:20:57 Europe/Berlin)**. Source baseline: AIPLAY commit **e23e1c1f369d666dc928f6e6f3c4407b70f0e21a**.

## Recommendation

Recommend **one NVIDIA A100-SXM4-80GB, Secure Cloud**, at the directly returned catalog rate of **$1.79/hour**, subject to a fresh final review and a narrowly scoped acceptance-policy update. The inventory reported **LOW** stock in **US-MD-1**, on hosts advertising CUDA **13.0** compatibility. This is the lowest-priced available full GPU in Secure Cloud in the checked 48 GB-and-up inventory. Its Ampere architecture avoids adding Blackwell-specific kernel validation to the first XL-SFT inference acceptance attempt. This is a practical risk/value judgment, not measured inference performance.

The current installer and deadline resource validator refuse every non-A40 candidate. **No alternative is ready for this bounded test with the existing acceptance policy unchanged.** The A100 recommendation is conditional on adapting and validating that existing policy; it does not authorize bypassing it, selecting an alternative automatically or provisioning now.

## Read-only method and limits

- Retrieved the current official REST v2 OpenAPI schema, then queried the authenticated official GPU catalog separately for Secure and Community Cloud with include=AVAILABILITY, product=POD, count=1 and minCudaVersion=12.8. Kept every NVIDIA listing with at least 48 GB catalog VRAM, including the requested families and other available alternatives.
- Used only **three provider GET requests** for this inventory: two catalog reads and one Pod discovery. Confirmed **zero existing Pods**. No provider POST/PATCH/DELETE, billable operation, template update, credential change, model download, package install or source/configuration change was performed.
- Credentials were read through the existing secure vault and sent only in authorization headers to the official provider. No credentials, balances, private resource names or unrelated personal data are included in the report or sanitized evidence.
- The prices below are the actual current **provider-returned per-pool catalog list rates**, not marketing starting prices or spot bids. The official contract distinguishes these from the actual billed Pod cost, which can only be verified on an allocated Pod. Allocation and a particular rate cannot be guaranteed by read-only inventory. Stock can change between checks, as both A40 attempts demonstrated.
- CUDA entries below are available host compatibility versions returned under the minimum-12.8 filter; they are not measured installed container runtime versions. An empty list is not evidence of compatible available capacity.

## Complete 48 GB-and-up comparison

Prices are USD. LOW means catalog capacity is currently reported, not reserved. NONE means no qualifying capacity. A rate beside NONE is a listing only. Not offered means the pool flag is false; a numeric placeholder price returned by the API is deliberately not treated as an offer.

The final column is estimated **two-hour compute plus 100 GB persistent and 20 GB temporary running storage**, Secure / Community, before taxes. Estimates for unavailable listings are hypothetical, not recommendations.

| GPU | VRAM GB (catalog) | Secure rate; stock | Community rate; stock | Available Secure CUDA versions | Available Community CUDA versions | Two-hour total Secure / Community |
|---|---:|---|---|---|---|---|
| A100 PCIe | 80 | $1.79/h; NONE | $1.19/h; NONE | None | None | $3.61 / $2.41 |
| A100 SXM | 80 | $1.79/h; LOW | $1.39/h; NONE | 13.0 | None | $3.61 / $2.81 |
| A40 | 48 | $0.59/h; NONE | Not offered | None | None | $1.21 / n/a |
| B200 | 180 | $7.99/h; LOW | $5.98/h; NONE | 13.2 | None | $16.01 / $11.99 |
| B300 | 288 | $8.99/h; NONE | $6.94/h; NONE | None | None | $18.01 / $13.91 |
| H100 SXM | 80 | $3.99/h; LOW | $2.69/h; NONE | 12.8, 13.0, 13.2 | None | $8.01 / $5.41 |
| H100 NVL | 94 | $3.19/h; NONE | $2.59/h; LOW | None | 12.8 | $6.41 / $5.21 |
| H100 PCIe | 80 | $2.89/h; NONE | $1.99/h; NONE | None | None | $5.81 / $4.01 |
| H200 SXM | 141 | $5.29/h; NONE | $3.59/h; NONE | None | None | $10.61 / $7.21 |
| H200 NVL | 143 | $3.79/h; NONE | Not offered | None | None | $7.61 / n/a |
| L40 | 48 | $0.82/h; NONE | $0.69/h; NONE | None | None | $1.67 / $1.41 |
| L40S | 48 | $1.09/h; NONE | $0.79/h; NONE | None | None | $2.21 / $1.61 |
| RTX 6000 Ada | 48 | $0.99/h; NONE | $0.74/h; NONE | None | None | $2.01 / $1.51 |
| RTX A6000 | 48 | $0.59/h; NONE | $0.33/h; NONE | None | None | $1.21 / $0.69 |
| RTX PRO 5000 | 48 | $0.96/h; NONE | $0.82/h; NONE | None | None | $1.95 / $1.67 |
| RTX PRO 6000 MaxQ | 96 | Not offered | $1.64/h; NONE | None | None | n/a / $3.31 |
| RTX PRO 6000 | 96 | $2.49/h; LOW | $1.69/h; NONE | 13.2 | None | $5.01 / $3.41 |
| PRO 6000 MIG 48GB | 48 | $1.29/h; LOW | Not offered | 13.2 | None | $2.61 / n/a |
| RTX PRO 6000 WK | 96 | $2.59/h; NONE | $1.69/h; LOW | None | 13.0 | $5.21 / $3.41 |

Sanitized source: [inventory JSON](../tmp/cloud-manager/xl-sft-alternative-hardware-inventory.json). Archived official schema: [OpenAPI snapshot](../tmp/cloud-manager/xl-sft-alternative-api-schema.json). No stock polling or creation attempt is scheduled.

## Runtime, host and installer compatibility

| Candidate family | Existing runtime path | Host floor request | Current bounded supervisor |
|---|---|---|---|
| RTX 6000 Ada, L40/L40S (48 GB) | CUDA/BF16-capable Ada, compute capability 8.9; reasonable candidates for the current CUDA 12.8/PyTorch path, but no qualifying stock and XL-SFT not measured | REST v2 supports minimum 64 GB RAM / 8 vCPUs; actual placement unconfirmed | Rejects different GPU and higher price; requires reviewed policy adaptation |
| RTX A6000 / A40 (48 GB) | Ampere 8.6; existing NVIDIA path, but no qualifying stock; no further A40 attempt authorized | Same supported request; actual placement unconfirmed | Only A40 Secure at <=$0.59 is allowed currently; A6000 is rejected |
| A100 PCIe / SXM (80 GB) | Ampere 8.0 with documented BF16 support; compatible architecture for existing NVIDIA runtime in principle; only Secure SXM has current stock | Same supported request; actual placement unconfirmed | Rejects non-A40 and >$0.59; scoped adaptation required |
| RTX PRO 6000 Blackwell full GPU (96 GB) | Compute capability 12.0. CUDA 12.8-era PyTorch has Blackwell support, but actual installed wheel, compiled dependencies and this pinned Comfy graph need runtime checks; no measured XL-SFT result | Same supported request; actual placement unconfirmed | Rejects GPU/price, and Community pool if selected; scoped adaptation required |
| RTX PRO 6000 Blackwell MIG (48 GB slice) | A partition rather than a complete 96 GB GPU. Adds MIG enumeration, kernel and telemetry-scope questions. Current diagnostics query physical GPU memory; they do not establish isolated MIG-instance memory | Schema accepts the generic floor fields, but their applicability/allocation for this partition needs provider verification | Rejects GPU/price; instrumentation would also need validation. Excluded from first-test recommendation |
| RTX PRO 5000 (48 GB) | Blackwell 12.0, same conditional runtime checks; no current stock | Supported floor request; actual placement unconfirmed | Rejected; scoped adaptation required |
| H100 / H200 full GPU (80–143 GB) | Hopper 9.0; plausible CUDA/BF16 path, inference not accepted here. Only H100 NVL Community and H100 SXM Secure have current stock | Supported floor request; actual placement unconfirmed | Rejected; scoped adaptation required |
| B200 / B300 (180/288 GB) | Blackwell data-center architectures 10.0/10.3; actual wheel/kernel architecture coverage must be checked, not inferred from VRAM. Only B200 Secure currently has stock | Supported floor request; actual placement unconfirmed | Rejected; scoped adaptation required |

The reviewed installer selects **runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404**, creates a virtual environment with system packages and installs the pinned ComfyUI checkout's requirements. That requirements file lists torch without a version pin; the entire resolved dependency environment is therefore not immutable merely because ComfyUI source is pinned. Record actual PyTorch/CUDA/driver/package versions and supported device architecture at runtime, verify BF16 and a small GPU operation before downloading the selected weights, and retain the existing exact graph validation. No environment was installed or changed during this inspection.

NVIDIA documents that newer drivers support older CUDA runtimes. Accordingly, the A100 SXM host's reported 13.0 compatibility does not require changing the installer's 12.8 runtime. Driver compatibility alone does not prove package, extension or XL-SFT inference compatibility. [NVIDIA CUDA compatibility](https://docs.nvidia.com/deploy/cuda-compatibility/why-cuda-compatibility.html), [GPU compute capabilities](https://developer.nvidia.com/cuda/gpus), [A100 BF16 architecture](https://developer.nvidia.com/blog/nvidia-ampere-architecture-in-depth/), [PyTorch Blackwell/CUDA 12.8 support](https://pytorch.org/blog/pytorch-2-7/).

The official CreateGpuConfig supports **gpu.minRamPerGpu=64** and **gpu.minVcpuCountPerGpu=8**. These are placement filters, not a promise to resize a host. Actual allocated system RAM and vCPUs are returned in gpu.memory and gpu.vcpuCount, respectively; catalog memory instead means GPU VRAM. The documented catalog query has no host-RAM/vCPU filter, so **no candidate's simultaneous 64 GB / 8 vCPU placement can be confirmed read-only**. After explicit approval, creation must use both floors and stop if placement cannot satisfy them, without another GPU or replacement. Verify actual available/container-limited RAM as well as the allocation before installation. [Official REST v2 contract](https://api.runpod.io/v2/openapi.json).

## Existing safeguards and required scope of a future change

Static inspection verified the following existing paths:

- **server/engine/runpod-install.js:** acceptancePlan explicitly allows only NVIDIA A40, Secure, 100 GB persistent, price <=$0.59. A second acceptance quote guard repeats the $0.59 ceiling; the policy budget is $2. Accepted requests include 64 GB / 8 vCPU placement floors, 20 GB temporary disk, pinned publication checks and a single journalled provider create POST with read-only reconciliation after uncertain responses.
- **worker/automatic-runpod.py:** AcceptanceSupervisor.validate_resource independently requires A40, Secure, <=$0.59, one GPU, the host floors and exact disks before installing. The same supervisor owns the fixed 90-minute workload cutoff / 120-minute stop deadline, separate credential, cancellation/persistence process and provider-confirmed EXITED check. It survives desktop disconnection.
- **worker/acceptance-telemetry.py:** opt-in GPU memory sampling via nvidia-smi and separate process/container/host RAM scopes; existing loading, node and generation timings can be reused on a full A100. This has offline tests, but no actual A100 telemetry result yet. MIG requires additional scope handling rather than assuming a physical-device memory counter measures the assigned slice.
- **server/engine/runpod-bootstrap.js:** embeds the exact committed acceptance bootstrap and verifies publication/integrity. Any future supervisor change must be committed, pass repository checks and be published before its exact bootstrap is used.

For an approved A100 test, update the **existing acceptance policy and corresponding remote actual-resource validator** to bind the exact A100 SXM identifier, Secure pool, approved $1.79 ceiling and revised operational budget. Update existing focused tests for accepted exact settings and rejected price/pool/GPU/resource substitutions; do not introduce another installer, GPU registry or recommendation engine. Preserve both host floors, immutable 90/120-minute timing, the shutdown reserve, idempotency, vault use, separate stop key, telemetry, output persistence, provider state confirmation and no termination/deletion/resize/replacement behavior. Record the revised reviewed configuration in the existing journal/signature. Do not omit the acceptance policy to use the ordinary unbounded installer.

These are prerequisites proposed for a later implementation/test phase. **No source safeguards were changed in this read-only task.** An alternative computer cannot simply be selected now and still pass the current bounded acceptance policy.

## Practical ranking of currently available full-GPU candidates

All entries are conditional runtime candidates, not measured XL-SFT compatibility results. This ordering values Secure Cloud, mature runtime support, price and the purpose of an initial controlled test; it does not claim a measured speed ranking.

| Rank | GPU / pool | Rate | Estimated two-hour total | Assessment |
|---:|---|---:|---:|---|
| 1 | A100 SXM 80 GB / Secure | $1.79/h | $3.61 | Recommended: least expensive currently available full Secure GPU; mature Ampere/BF16 path and more memory headroom than A40 |
| 2 | RTX PRO 6000 Workstation 96 GB / Community | $1.69/h | $3.41 | Cheapest available full GPU across pools; saves only $0.20 over the A100 test while adding a pool change and Blackwell runtime validation |
| 3 | RTX PRO 6000 Server 96 GB / Secure | $2.49/h | $5.01 | Secure alternative with more VRAM; costs more and still adds Blackwell validation |
| 4 | H100 NVL 94 GB / Community | $2.59/h | $5.21 | Hopper candidate; catalog LOW despite no datacenter details in this response. More expensive than the A100 and changes pool |
| 5 | H100 SXM 80 GB / Secure | $3.99/h | $8.01 | Secure Hopper candidate, but extra speed is unmeasured for this workload and its price is hard to justify for first acceptance |
| 6 | B200 180 GB / Secure | $7.99/h | $16.01 | Available but excessive rental and memory for the initial comparison; architecture/kernel validation also needed |

The PRO 6000 MIG 48 GB Secure listing is cheaper at **$1.29/hour**, approximately **$2.61 for two hours**. It is excluded from the full-GPU ranking because it changes compute partitioning and requires additional telemetry validation. The cheaper Ada/L40S/A100 PCIe listings are not ranked because they currently have no qualifying stock. Actual generation duration and peak memory remain unknown for every candidate.

## Revised proposal for explicit approval

| Term | Proposed value |
|---|---|
| Exact GPU identifier | **NVIDIA A100-SXM4-80GB**, count 1, full 80 GB GPU |
| Pool and price ceiling | **Secure Cloud, on-demand, no more than $1.79/hour** |
| Placement floors | **At least 64 GB host RAM and 8 vCPUs**, validated again on the allocated computer |
| Storage | **100 GB persistent + 20 GB temporary**, unchanged |
| Session deadline | **Maximum two hours including installation and shutdown**, workload cutoff at 90 minutes and final 30 minutes reserved for cancellation, persistence and shutdown |
| Two-hour compute estimate | **$3.58** |
| Two-hour running-storage estimate | **$0.0329** using a 730-hour month |
| Estimated session total | **About $3.61 before applicable taxes** |
| Requested operational session allowance | **$5**, to allow taxes and operational headroom; not a provider-enforced billing cap or permission to raise GPU price or extend time |
| Subsequent retained persistent storage | **Approximately $20/month while stopped**, separate from session allowance, retained until user chooses removal |
| Attempts | **One reviewed creation attempt only**, no alternate GPU/pool, duplicate or replacement |
| Preconditions | Narrowly scoped existing-policy update, tests/publication, separate stop-key validation and fresh exact price/availability review before creation |

Running storage remains $10/month for the 100 GB persistent volume plus $2/month for 20 GB temporary disk. Stopping removes compute charges but retains the persistent volume at $20/month. Charges accrue per second; monthly values are rate illustrations, not full-month upfront charges. The estimate excludes subsequent retained storage and does not guarantee provider billing enforcement. [Official RunPod storage and compute billing](https://docs.runpod.io/pods/pricing).

Keep **ACE-Step 1.5 XL-SFT only**, the four existing pinned artifacts and hashes in shared/model-bundles.js, the compatible 4B planner, official graph, **30-second instrumental electronic sample, 50 steps, CFG 7**, batch 1. Preserve the pinned manifest revision 6707deb277e9e0907fd9c14ce6b6f1d695c6a3fc and ComfyUI revision ce1e922d8623bb507180e32a0c01a7d0e29edef7. Preserve all requested device/RAM/version/checksum, loading/generation, FLAC/audio-playback, output-transfer and provider-confirmed shutdown evidence requirements in [the acceptance procedure](ACE_XL_SFT_HARDWARE_ACCEPTANCE.md).

No artifacts, model variants, planner size, workload or compatibility thresholds are changed by this proposal. A successful 80 GB test would establish that exact configuration, not prove 48 GB compatibility or the minimum memory requirement. Other configurations remain unverified.

Approval is requested for this revised A100 proposal and the bounded policy adaptation before its one creation attempt. **No approval is assumed from the earlier A40 authorization.** If exact price, capacity, resource allocation or safeguard validation fails, stop for review; do not substitute, resize, terminate, delete storage or retry automatically.
