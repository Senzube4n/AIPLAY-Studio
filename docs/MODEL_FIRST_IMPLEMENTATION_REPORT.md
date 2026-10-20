# Category-aware model setup implementation report

Baseline: `e9c6b46`. The existing audit was read in full and preserved. The minimal plan was established in `MODEL_FIRST_IMPLEMENTATION_PLAN.md` before application changes. No provider resources or model weights have been changed during implementation validation.

## Phase 1: shared profiles and verified manifests

Implemented a small dependency-free adapter (`shared/model-profiles.js`) that names existing catalogue capabilities, worker bundles and workflow builders. The worker's existing curated manifests now live in `shared/model-bundles.js`; its downloader still owns verification, resumption, transfer locking and licence approval. Local installs still use `ModelManager` and its existing Models UI. No replacement registry, download engine or generation library was introduced.

Initial profiles: YuE2 3B int8 ComfyUI, SDXL Turbo fp16, LTX 2.5 distilled int8, standard ACE 1.5 Turbo, ACE 1.5 XL-SFT, XL-Turbo and XL-Base. XL-SFT is offered individually; no variant aliases another DiT. Each profile exposes exact artifacts, supported targets, workflow nodes, fixed planning workload, precision/settings, catalogue requirements, terms links and evidence status.

### ACE evidence checked on 2026-10-18

Metadata only was fetched. No weights were downloaded.

- [Comfy-Org manifest](https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/tree/6707deb277e9e0907fd9c14ce6b6f1d695c6a3fc): immutable revision `6707deb277e9e0907fd9c14ce6b6f1d695c6a3fc`, HF API LFS SHA-256 and exact bytes.
- [XL-SFT workflow](https://github.com/Comfy-Org/workflow_templates/blob/59a3b48bf369c5a15f29a1308bae3e279fa15505/templates/audio_ace_step1_5_xl_sft.json), [XL-Turbo workflow](https://github.com/Comfy-Org/workflow_templates/blob/59a3b48bf369c5a15f29a1308bae3e279fa15505/templates/audio_ace_step1_5_xl_turbo.json), [XL-Base workflow](https://github.com/Comfy-Org/workflow_templates/blob/59a3b48bf369c5a15f29a1308bae3e279fa15505/templates/audio_ace_step1_5_xl_base.json).
- All three official templates use the split ACE VAE, Qwen 0.6B lyric encoder, Qwen 4B planner, Euler/simple sampler and AuraFlow shift 3. SFT is 50 steps / CFG 7; Base 50 / CFG 6; Turbo 8 / CFG 1. Existing graph defaults already match these ComfyUI templates and were preserved.
- The pinned worker ComfyUI source `ce1e922d8623bb507180e32a0c01a7d0e29edef7` contains ACE 1.5 model detection, implementation and stock nodes. Schema validation is still required against the actual worker. Source presence does not establish successful model loading or inference.
- [Official native ACE installation requirements](https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/INSTALL.md) describe a different backend and offload/quantization configuration. Those memory minima were deliberately **not** applied to the ComfyUI BF16 XL + 4B planner profiles. XL fit remains unknown and the choices stay experimental.

| Variant | DiT bytes | DiT SHA-256 |
|---|---:|---|
| XL-SFT | 9,974,719,930 | `3c05ae268353b3540fb1fd7db4fd77ffbda9802ec641b624e15648e030ecf3ce` |
| XL-Turbo | 9,974,719,892 | `86a1afb0a1f711f0e3304ff65d874df3ae6783db683dcf982513fb9b6d14ae71` |
| XL-Base | 9,974,719,930 | `56bf816fc9a69a5f45635e867b2ad742e1e648eb51fadb7d124cb8332d2e0940` |

Companions are pinned in the shared manifest: VAE 337,431,732 bytes; lyric encoder 1,191,588,248; 4B planner 8,379,154,232. The existing local 1.7B fallback remains available when installed, but this reviewed XL installation profile uses the 4B planner from the official templates. No claim of XL acceptance for other LMs, covers, LoRAs, Extract/Lego/Complete or arbitrary workload sizes is made.

## Phase 2: existing UI and persistence

The current Nemesis sidebar and four cloud tabs are preserved. Your Goal now supports independent category checkboxes and an actual model per category. Settings and generation defaults are not rewritten merely by planning. `cloudSetup.plan` and `modelSetup.local` persist through validated `PREF_PATHS`; legacy saved goals and known ACE variants migrate in memory without provisioning resources.

Models contains a collapsed **Choose models and computer** planner for Local or RunPod. Choosing a planning target does not change the running launch mode. The panel names the required existing launcher mode and keeps unrelated native/API paths intact.

## Phase 3: compatibility and recommendations

`server/setup-plan.js` reuses catalogue requirements and `fitFor`. It counts the maximum sequential VRAM/RAM floor instead of summing independently unloaded models, unions shared artifacts by destination/hash, and reserves 20 GB working space in the storage preview. It states that larger workloads need a new fit check.

Existing account inventory/prices feed Budget, Recommended and Performance estimates. Only available, priced NVIDIA inventory with sufficient model evidence is ranked. Manual selection remains. Host RAM is not in this inventory and is explicitly unverified. Performance describes memory headroom, not measured speed. XL profiles receive no fabricated recommendation.

## Phase 4: selected installation

Guided installation filters the existing worker bundle controls to the selected plan. Terms/token approval remains per model; data travels directly from the publisher to RunPod. Older workers missing a selected bundle prompt an AI-service update. Local planning uses existing catalogue downloads and the Models access instructions for gated LTX, without introducing another credential store. The existing local LTX helper now pins the worker's reviewed revision, reads its LFS checksums through the existing Hugging Face client and verifies bytes before replacement. Local overlapping capability downloads are refused while writing a shared companion partial. An explicit exact-profile install does not silently accept a different legacy variant; normal existing download/alternative behavior remains available.

Existing creation reconciliation, lost-response handling, fresh pricing approval, storage persistence, worker update and shutdown code remain authoritative. Planning performs no provider calls. Current model storage needs are checked in the creation review without changing an approved storage size automatically.

## Phase 5: readiness and inference evidence

Selected workflow checks distinguish connection, downloaded files, checksums, runtime nodes, workflow schema, previous successful inference and stopped state. Cloud checks are bound to the selected running provider computer and worker identity. Changing selection cannot inherit another profile's ready flags. Schema success is shown as **Workflow checked / Ready for a generation test**, not proof of accepted inference.

Successful ordinary remote jobs can record a wordless model/workload fingerprint only after outputs have passed existing checksum/download/adoption handling. The curated artifact bundle must already be checksum verified at submission, and its manifest digest must still match at readiness checking. Acceptance is scoped to worker identity, worker install commit, ComfyUI version, artifact checksums and workflow settings/workload. Private jobs leave no acceptance fingerprint. Existing jobs without this evidence remain unverified.

Local readiness reuses existing completed Engine receipts and its model hash cache. Explicit Check setup verifies the selected artifact checksums. Prior inference evidence requires the same workflow, runtime version, hashed artifacts, verified output facts and unchanged model paths, sizes and modification times. Old, private or unhashed jobs remain unverified. Enable the existing Engine model-hash option before a sample when that evidence is needed. Ordinary panel opening does not hash gigabytes of weights. Receipt capture now includes both numbered DualCLIP encoder inputs, with an assertion against every XL profile's complete artifact list.

## Phase 6: existing generation forms

Explicit use of a plan fills the existing Music, Pictures or Video form and invokes its existing model-selection handlers; it does not click Generate. Remote ACE DiTs and compatible planner names are discovered from worker loader metadata, and YuE remote checkpoints likewise come from the worker. Missing files no longer become available merely because they exist on the PC. A missing explicitly selected XL DiT is refused rather than silently substituted with Turbo. Music options state execution location, including native/Python choices in RunPod mode. Saved XL defaults and compatibility advice use the actual selected variant. Native GGUF, Python kit and API restrictions are retained.

## Phase 7: ACE XL support limits

All three exact ComfyUI XL split profiles are installable locally or on a current worker through existing downloaders. Their stock-node graphs match the reviewed templates. Hardware fit and real output quality remain experimental until paid or local hardware acceptance. No claim of successful XL-SFT inference is made from graph or filename tests.

## Phase 8: validation

Focused suites: **104 passed, 0 failed**, covering selection/persistence, independently pinned manifests/defaults, selected XL advice, GPU/storage, schema/readiness, remote inventory, privacy/artifact evidence, local exact-build downloads, shared-file locking, and the gated LTX helper with synthetic files. Existing UI approval, transport recovery, credential guards and worker installation tests run in those suites. Installation/defaults/Models/self-update/card handover checks: **46 passed, 0 failed** (overlap with the full gate, not an additional aggregate total). Existing compatibility suite: **98 checks passed**. Boot trace evaluated the client, Video Lab, Engine and video compatibility modules without top-level errors.

Browser checks used isolated profiles on ports 4193/4194 with simulated provider/worker responses and external requests blocked. Verified category combinations and persistence, selection synchronization between Models and Cloud Setup, selected-bundle filtering, missing-runtime refusal, separate inference status, Local launch-mode guidance, and XL-SFT sample preparation using the existing Music screen (4B planner, 50 steps, CFG 7, 30 seconds). Normal and 700-pixel layouts were visually checked. No sample generation was submitted. Screenshots are diagnostic simulations, not GPU acceptance evidence: `tmp/cloud-manager/model-first-goal.png` and `model-first-700.png`.

The Windows installation manifest now includes `shared/`; no installer executable rebuild is needed for this source addition. Model tables, NOTICE and installer disk totals were regenerated using the repository's existing generators.

The mandatory `.githooks/pre-commit` gate is enforced during the implementation commit, without bypass. Its result is reported with delivery. Earlier full runs caught and corrected a native-picker fixture assumption, unknown-rights metadata shape, generated disk figures and new-variant badge census. The browser startup empty-state exception has a regression test. After the final receipt change, ACE tests passed (15 tests) and the existing Engine client suite passed (219 assertions). Full-gate output is retained in `tmp/cloud-manager/model-first-commit-final.log`.

### Hardware acceptance still required

No new paid operations are authorized by this implementation task. Before any hardware test, obtain fresh approval for the specific computer/GPU, current rate, persistent storage cost, maximum spend and runtime. Priority is a short XL-SFT song using the exact manifest/settings, followed by XL-Turbo and XL-Base individually, then selected cross-category switching, restart with retained files and shutdown/disconnection checks. Record the actual worker build, GPU, RAM, workload, installed artifact checksums, output checksum and playback quality. Stop compute safely within the approved budget; do not delete storage or replace resources as recovery.
