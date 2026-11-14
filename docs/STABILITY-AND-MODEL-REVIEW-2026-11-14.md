# Studio stability and model review — 14 November 2026

Reviewed source baseline: `Senzube4n/AIPLAY-Studio` commit
`2bda3a1e039e23b34497d311d29b1cc5c4a6f9b2`. Publisher pages and public
Hugging Face metadata were checked on 14 November. No weights were downloaded,
runtime packages replaced or new GPU benchmarks performed for this review.

## Priority

Repair reproducible engine installation before changing generation defaults.
The reviewed baseline requests unpinned torch packages with
`--extra-index-url`; this allows a newer PyPI build to defeat the intended CUDA
index. A later dependency install can also replace the selected framework.
Record and validate the exact interpreter and resolved GPU stack after all
requirements finish. Retain original initialization errors instead of treating
every CUDA failure as an old driver.

The repair pins the local NVIDIA wheel stack to torch 2.14.1, torchvision
0.29.1 and torchaudio 2.11.0 with explicit CUDA build tags and an exclusive
wheel index. It protects those packages while ComfyUI requirements resolve,
then validates a GPU tensor calculation and records the exact Python/runtime.
The RunPod bootstrap separately constrains its container's inherited torch
stack. RunPod's launcher card is now visible at either saved detail level.
The new `node scripts/diagnose-engine.mjs` command produces a read-only report
using the selected ComfyUI Python. See [install troubleshooting](../INSTALL.md).

Validation is local/offline unless explicitly recorded otherwise. No live
RunPod account is available for this change; container startup, model inference
and cloud performance remain unverified. Existing externally managed ComfyUI
and the separate optional music/Whisper environments are not rewritten.

PyTorch 2.15 changes its CUDA binary choices and Python/GPU compatibility.
An explicit older torch version alone does not choose its CUDA build. Preserve
a CUDA 13 profile for H3 INT8 ConvRot and compatible newer GPUs; a CUDA 12.6
fallback is a compatibility option, not an equal-performance replacement for
every Studio model. See [PyTorch 2.15 release notes](https://github.com/pytorch/pytorch/releases/tag/v2.15.0),
[official previous-version commands](https://pytorch.org/get-started/previous-versions/),
and [Comfy's H3 packaging advice](https://huggingface.co/Comfy-Org/MiniMax-H3).

## ComfyUI release comparison

`server/setup/pins.js` retains **v0.36.0** for ordinary fresh installs and
**v0.37.0** for the separate Qwen compatibility path. These are Studio's
validation baselines, not current upstream releases. GitHub's official latest
release API and release page identify **v0.45.0**, published **10 November
2026**, as the latest non-prerelease when checked on 14 November.
[Official v0.45.0 release](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.45.0).

Relevant intervening changes justify a staged comparison:

| Release | Relevant published changes |
| --- | --- |
| [v0.38.0](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.38.0) | H3 VAE tile blending, a VAE crash fix when QK normalization is offloaded, Fun ControlNet Union 2.0 and comfy-kitchen 0.2.36. |
| [v0.39.0](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.39.0) | H3 packed-embedding temporaries released before transformer blocks; a lighter H3 VAE option. |
| [v0.43.0](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.43.0) | Graph/prefetch cleanup synchronization, offload-stream synchronization and dynamic-VRAM KV-cache work. |
| [v0.44.0](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.44.0) | Local H3 latent-upscaler, Sol-H3-VAE and context-window support; prefetch cleanup and FP8 dynamic-VRAM fixes; LTX 2.5 VAE dtype crash fix. |
| [v0.45.0](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.45.0) | comfy-kitchen 0.2.41, decoded-frame reuse, prefetch/Qwen FP8 crash fixes and MiniMax-H3-image support. Its Pika H3 Flex entries are hosted partner nodes. |

These release notes establish available code changes. They do not measure
Studio speed, validate its custom nodes or prove that existing patched
workflows will survive an upgrade. Hosted Pika nodes do not establish a local
Pika Flex implementation. Lighter VAEs and H3 upscalers require their own model
files and workflow choices; updating ComfyUI alone does not activate them.

Evaluate v0.45.0 beside the current engine with pinned framework packages,
validate Studio's installed-node checks, then run the acceptance below before
activation. This review changes neither fresh-install pin. All next-model
choices below are evaluated candidates; none was installed or render-tested
as part of the review.

## What Studio already includes

H3 here means **MiniMax H3**, not Hunyuan. These are different model families.
The existing implementation already has several distinct speed paths:

| Existing choice | Status in this source |
| --- | --- |
| H3 Fast | TaoMate three-step FL2VA adapter; separate 182 MB option. Not a three-step reference adapter. |
| H3 Standard | Matching eight-step FL2VA distillation; REF2V V1.1 preferred for eight-step references, V1.0 retained. |
| H3 reference Fast | Separate four-step REF2V v0.1 adapter. |
| H3 W6A8 | Optional, experimental, runtime-gated; 15.98 GB per transformer. No product speed/quality benchmark. |
| FastH3 | Separate distilled model and attention recipe. Its name does not establish that it beats TaoMate locally. |
| Source clip guidance | Depth/Pose/Fun ControlNet, with separate full and curve-form patches. This is structural guidance. |
| Pictures | Qwen Image 2.1 plus optional MOSS Standard/Spectrum/Turbo/DMD and Kromoss/HiRes presets. |

The recorded REF2V V1.1 comparison used one matched pair on an RTX 4070 Ti
SUPER 16 GB: 246.861 s versus 260.611 s for V1.0, with more scene change in
the sampled V1.1 result. That supports the existing scoped preference, not a
general 5% performance promise. See [reference turbo details](H3_REF_TURBO.md).

The H3 memory table derives from one 16 GB card, including smaller memory
caps, with 32 GB RAM. The eight-GB-cap result at 960 × 544 does not certify a
real eight-GB laptop, other quantization, or new H3 derivatives. See
`server/h3tier.js` and [optional runtime requirements](OPTIONAL_H3_YUE2_MODELS.md).

## New H3 candidates worth evaluating

| Candidate | Verified change | Integration decision |
| --- | --- | --- |
| **Pika H3 Flex** | New six-step FL2VA and Ref2VA adapters; native 480p/768p, joint audio, ordered multimodal references. Comfy-format adapters appeared 29 October. | Best next reference-video pilot. Needs its own exact stochastic schedule and input contract. Six ordinary Euler steps plus a LoRA is not equivalent. Keep existing H3 default. |
| **TurboH3 FL2VA I2VA** | Four-update DMD derivative. Kijai published a pruned Comfy INT8 ConvRot conversion on 4 November, with Euler/simple, four steps, CFG 1. | Practical next first-frame pilot using an isolated compatible engine. Do not apply an additional H3 turbo LoRA to these already distilled transformer weights. Single-card speed and memory remain unmeasured here. |
| **LightX2V FL2V four-step V1.3 / REF2V four-step V1.0** | Official publisher files dated 20 October; Studio still names FL2V V1.0 and REF2V v0.1 in its four-step slots. | Smallest adapter-only comparison. Preserve the separate text/frame/reference routes and check each publisher recipe before adopting. Filename version is not quality evidence. |
| **TaoMate-R1** | Released 10 November: three-step streaming Ref2AV with separate opening and continuation adapters. | Research/remote-runtime project, not a drop-in replacement for Studio's TaoMate file. Official workflow documents Linux, BF16, CUDA 12.8/PyTorch 2.8 and 4/8 GPUs. |
| **TaoMate-HD** | Released 3 November: progressive 480p-to-768p chunk generation. | Research/remote-runtime project. Published examples use eight H20 96 GB GPUs and a separate Linux runtime; results do not imply consumer-card gains. |

Sources: [Pika publisher card](https://huggingface.co/Pika-Labs/Pika-H3-Flex),
[official Diffusers Pika pipeline](https://huggingface.co/docs/diffusers/main/api/pipelines/pika_h3_flex),
[Kijai conversion and its recipe](https://huggingface.co/Kijai/MiniMax-H3_comfy),
[TurboH3 publisher](https://huggingface.co/TurboDiffusion/TurboH3-FL2VA-I2VA),
[LightX2V release files](https://huggingface.co/lightx2v/Minimax-h3-Turbo/tree/30f485ed874aa44c8183348ad361c5eabad318da),
[TaoMate-R1 publisher](https://huggingface.co/TaoLiveAIGC/TaoMate-R1),
[TaoMate runtime](https://github.com/TaoLiveAIGC/TaoMate-H3), and
[TaoMate-HD implementation](https://github.com/TaoLiveAIGC/TaoMate-HD).

Pika's public CLI examples use H100 80 GB with optional CPU offload. This does
not establish the Comfy quantized adapter's minimum VRAM. Its hosted 4K features
are not capabilities of the native open-weight 768p recipe.

The native TurboDiffusion H3 implementation uses separate W8A8 kernels,
AdaLN tables, SpargeAttn and distributed profiles; its documented eight-GPU
profile is not the Kijai Comfy conversion. The framework's Wan-specific
100–200× headline is not an H3 desktop speed measurement. See
[H3 runtime instructions](https://github.com/thu-ml/TurboDiffusion/blob/main/docs/h3_i2va.md).

## Metadata for a reproducible pilot

Sizes are decimal **disk bytes**, not memory requirements. These records are
release metadata, not an instruction to download or a benchmark acceptance.

| Artifact | Revision | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| Kijai `diffusion_models/minimax_h3_fl2va_turboh3_i2va_pruned_int8_convrot.safetensors` | `587e806edadec7b92393556b3ac3115cadfb32be` | 20,970,379,696 | `697969821101917c3d5bf5b86a0177817fedfacae67c77312501a1a572c3d344` |
| Comfy-Org `loras/pika_h3_flex_fl2va_v1_bf16.safetensors` | `912b6e38b2092ec4d2e86d24183e0d59ea059d48` | 1,956,172,304 | `cc5453aeecd6189468409003fe4cf1b57e52ff3a830a0a154b87decbe07358b7` |
| Comfy-Org `loras/pika_h3_flex_ref2va_v1_bf16.safetensors` | same | 1,956,172,304 | `de3745ceb7d8d5c20898dd8fa3a05f1c0b00089ccd55297b2a8bab95c766b0e0` |
| LightX2V `minimax_h3_fl2v_turbo_4step_v1.3_768p_comfyui_bf16.safetensors` | `30f485ed874aa44c8183348ad361c5eabad318da` | 1,956,193,000 | `70103fd0d80a947ed4e7fe6f88915863d54ef22c5cab03bd5d2fd649385ffe1e` |
| LightX2V `minimax_h3_ref2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors` | same | 1,956,193,000 | `b4da466e43588004097dfbcde245ccc439c34a26bc997cb76a0b53a1d549ea0d` |

Checked through the publishers' Hugging Face model/tree API, including LFS
OIDs. The MiniMax H3 model terms and existing territory acknowledgement remain
applicable to derivatives; repository code licences do not replace those terms.

## Acceptance before a default changes

Use the same prompts, seed set, actual frame count, canvas, conditioning inputs
and hardware. Record cold and resident-model wall times separately, peak VRAM,
host RAM, decode/export time, model hashes and runtime versions. Compare text,
first/last frame, single-image reference and multi-reference tasks separately.
Review motion, identity, prompt following, detail and audio; test cancellation,
repeat renders and recovery after a failed render. A source or graph test alone
does not establish render quality or GPU compatibility.

For this stability repair, keep the measured generation defaults. Follow with
an explicit Pika reference pilot and TurboH3 first-frame pilot, plus the smaller
LightX2V adapter comparison. Keep new serving stacks isolated from Studio's
ordinary Comfy environment.

## Repair validation

- Installer selection and cleanup assertions: 71 passed.
- Runtime, read-only diagnosis and staged-install fixtures: 23 passed after
  final edits, including kernel failure and preserving an existing engine.
- Broader package/update/activation regression: 162 passed, one skipped.
- RunPod transport, controls and launcher regression: 99 passed.
- RunPod bootstrap: 25 offline Python tests passed.
- Studio detail-level checks: 214 passed; test registration census passed.
- Actual isolated launcher API: a fresh Simple profile offers all four modes
  and accepts the RunPod favourite without changing the detail level.
- Diagnostic CUDA calculations passed on the existing RTX 4070 Ti SUPER with
  both the selected Studio environment (torch 2.13.0+cu130, Python 3.10.6) and
  an older separate environment (torch 2.5.1+cu121, Python 3.11.9). These check
  the diagnostic, not a fresh installation of the new pinned stack.

The full pre-commit gate was attempted but stopped after the unrelated DAW
sampler-quality suite did not complete within three minutes. It is not recorded
as passing. The pinned stack still needs a complete fresh-install/render trial,
and the worker change still needs live RunPod acceptance. No speed gain is
claimed from these tests.
