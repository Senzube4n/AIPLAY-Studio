# Kromoss and MOSS HiRes presets

These are optional, experimental text-to-image presets. **Standard remains the
default MOSS preset.** Installing a checkpoint or adapter does not select it,
change a saved image preference, update ComfyUI or replace a patched runtime.
Qwen Image 2.1 remains the automatic picture choice and reference/editing path.

## Choose a recipe

Select **MOSS-Image** in Pictures, open Advanced and choose a Preset. The
named preset selects its own verified diffusion model and adapter; an explicit
incompatible model override is refused.

| Preset | Diffusion model | Adapter | Steps / CFG | Sampler / schedule | Canvas and count |
| --- | --- | --- | --- | --- | --- |
| Standard | MOSS SFT INT8 | None | Defaults to 25 / 2.5 | `er_sde` / `simple` | Existing Standard limits |
| Kromoss Standard | Kromoss INT8 | None | Fixed 25 / 2.5 | `er_sde` / `simple` | Multiples of 16, 256–2048 per side; count 1–4 |
| Kromoss DMD2 8 | Kromoss INT8 | Its own DMD2, strength 1 | Fixed 8 / 1 | `euler` / `simple` | At most 1,048,576 pixels and a 1536-pixel side; count 1–4 |
| MOSS HiRes v0.3 | MOSS SFT INT8 | HiRes v0.3 LoHa, strength 1 | Fixed 25 / 4 | `er_sde` / `simple` | Exactly 2048 × 2048; count 1 |

All use native shift 5, unchanged text prompts and no skip-layer guidance.
Kromoss DMD2 8 refuses a negative prompt because CFG 1 has no negative branch.
The other recipes can use a negative prompt at their CFG above 1.

The HiRes choice sets the form to its fixed size and one image. Leaving that
preset restores the previous size and count. It uses ordinary native
`VAEDecode`; there is no automatic tiled-decoding fallback. A memory failure is
a failed render, not permission to silently change the recipe.

These recipes do not add references, personas, editing, transparency, custom
adapter stacks or CLIP skip to MOSS. Use the existing reference/editing engine
for those operations. Input limits do not establish a minimum RAM or VRAM
requirement.

## Install only the additions you need

If the three [MOSS SFT components](MOSS_IMAGE.md#native-files-and-runtime) are
already installed, the GPTQ encoder and small VAE are reused. Keep the SFT
checkpoint for Standard and HiRes. Kromoss is a separate full fine-tune, not a
small adapter that converts SFT at load time.

| Models row | Capability ID | Added bytes |
| --- | --- | ---: |
| Kromoss INT8 | `moss-image-kromoss` | 5,413,698,958 |
| Kromoss DMD2 8 | `moss-image-kromoss-dmd2-8` | 1,189,176,800 |
| MOSS HiRes v0.3 | `moss-image-hires-v03` | 182,195,248 |

Kromoss alone adds about 5.41 GB; Kromoss plus DMD2 adds about 6.60 GB. All
three additions total 6,785,071,006 bytes, about 6.79 GB. These are decimal disk
sizes, not VRAM requirements. A fresh install also needs the shared
`qwen3.5_9b_w4a8_gptq.safetensors` encoder and
`flux2-vae_small.safetensors` VAE. The main MOSS SFT Models row installs its
three-file bundle, including the SFT checkpoint used by Standard and HiRes.

Use Models or `download_model` with the desired capability ID. Downloads start
only when requested and report completion or failure through Models. Do not
download the whole Kromoss repository: it also contains a larger BF16 encoder,
BF16 checkpoint and duplicate Diffusers components that these presets do not
need. Existing correctly installed companions need not be downloaded again.

The small VAE in Kromoss has the same published SHA256 as the shared MOSS VAE.
The Studio presets deliberately retain the existing GPTQ encoder rather than
the publisher's BF16 encoder. That precision choice must remain part of any
comparison.

## Pinned artifacts

The catalogue and recipes share these exact releases in
[`server/moss-presets.js`](../server/moss-presets.js). Files are fetched directly
from their publisher, not mirrored by Studio.

| Component | Repository revision | Installed filename |
| --- | --- | --- |
| Kromoss INT8 | `lodestones/Kromoss` at `7f9bb7b06d7b6c27d294b0bab5a2b3056c379279` | `kromoss_int8_convrot.safetensors` |
| Kromoss DMD2 | Same revision | `kromoss_dmd2_8step.safetensors` |
| HiRes v0.3 | `comfyanonymous/MOSS_image_MAX_ULTRA_hires_lora_test` at `9af7b1f3d135ce132cc6c4b8147030efff19507f` | `moss_hires_lora_test_v0.3.safetensors` |

The DMD2 upstream filename is `8-steps-dmd2-lora.safetensors`; its explicit local
name prevents confusion with the earlier SFT DMD adapter.

```text
Kromoss INT8 SHA256
cacff0dd25cd2cf531e1f5ddae7872c3d57a54dbf66f1a1279f2f118514e7905

Kromoss DMD2 SHA256
7683fe1fb51f73f5d690f24dd6b7f46f31ab9a9873729a854ac5c9a420ffe6f2

HiRes v0.3 SHA256
98e8abcc25016d17a4ca41dec4063abe2ff2b0a12da42e0483c522ce36f8430b
```

Readiness verifies the selected Kromoss checkpoint and adapter SHA before
queueing. The first check streams the file and may take time. A bounded cache
reuses verification while the file's resolved identity, size and modification
and change times remain unchanged. A same-sized wrong checkpoint is not a
valid substitute. Do not rename Kromoss to the SFT filename.

## MCP and HTTP

Check the same preset you intend to render. A readiness check does not download
files, update an engine, switch a default or start image generation.

For `moss_image_status`:

```json
{"moss_preset":"kromoss-dmd2-8"}
```

Then, once ready, call `make_image`:

```json
{
  "engine":"moss-image",
  "moss_preset":"kromoss-dmd2-8",
  "prompt":"A red paper boat on blue water, crisp editorial illustration",
  "seed":42,
  "width":1024,
  "height":1024,
  "count":1
}
```

Use `moss_preset: "kromoss-standard"` for the matched 25-step recipe. For HiRes,
use `moss_preset: "moss-hires-v03"`, width and height 2048, count 1. Omitted
HiRes dimensions default to that fixed canvas. Do not send the form's earlier
SFT model choice as a `dit` override with a Kromoss preset.

HTTP uses `mossPreset` rather than `moss_preset`:
`GET /api/images/moss-status?mossPreset=kromoss-dmd2-8` checks readiness;
`POST /api/image` with `action: "create"`, `engine: "moss-image"`, the chosen
`mossPreset` and prompt queues a picture. See the [API reference](../API.md).

## Compare the right things

**Kromoss Standard** intentionally matches Studio Standard's default sampling
recipe. Use identical prompt, seed, dimensions, count and negative prompt to
isolate a checkpoint difference. Do not carry the existing SFT speed or quality
measurements over to Kromoss.

The Kromoss publisher instead documents a full-model recipe of 50 steps, CFG 3,
Euler, shift 5 and negative-branch layer 22 skipping. That is a different
recipe; this integration does not offer it as an implied quality setting. The
publisher's 100-prompt CLIP table compares Kromoss with MOSS Base, without an
official SFT row. It is not an independent visual-quality ranking.

**Kromoss DMD2 8** is another recipe, with both a new adapter and fewer guided
passes. Its adapter is distinct from the earlier SFT DMD 8 release. Do not
substitute that earlier file or stack Spectrum or another adapter onto it.
Native INT8 adapter application can dequantize, apply a delta and requantize;
it is not claimed equivalent to the publisher's BF16 or unmerged FP32 path.

For **HiRes v0.3**, compare against Standard explicitly set to 2048 × 2048,
25 steps, CFG 4, ER-SDE/simple and count 1. Comparing it only with a 1024-pixel
CFG 2.5 image changes resolution, guidance and the adapter together. HiRes is
direct high-resolution generation, not an upscaler for an existing picture.

Separate first-load and resident-model timings, and inspect actual outputs for
text, faces, hands, composition and the requested style. Any later result must
name the artifacts, precision, recipe, dimensions and hardware. No universal
quality winner or speedup follows from the existence of these presets.

## Runtime and terms

The presets use native MOSS loading, fused-qkv adapter mapping and the shared
encoder/VAE path. A compatible ComfyUI must expose `moss_image` in `CLIPLoader`
and the graph's native nodes and sampler. The runtime's available model list,
node schema and pinned artifacts are checked before queueing. An older engine
is refused rather than updated automatically.

The same Studio model-path discovery serves source, portable and Desktop
installations. No separate NVIDIA-only integration or automatic dependency
replacement is added. Native runtime support, available memory and performance
still depend on the machine; a CPU graph check does not establish cross-vendor
render performance.

Kromoss's publisher supplies an
[Apache-2.0 licence](https://huggingface.co/lodestones/Kromoss/blob/7f9bb7b06d7b6c27d294b0bab5a2b3056c379279/LICENSE)
for the checkpoint and bundled adapters. The reviewed HiRes v0.3 release does
**not supply an explicit adapter licence**. Models records its output terms as
unknown, without claiming permission or prohibition. The SFT base's Apache-2.0
licence does not by itself settle separate adapter terms; consult the publisher
before relying on them for commercial work.

Sources: [pinned Kromoss model card](https://huggingface.co/lodestones/Kromoss/blob/7f9bb7b06d7b6c27d294b0bab5a2b3056c379279/README.md),
[pinned HiRes release](https://huggingface.co/comfyanonymous/MOSS_image_MAX_ULTRA_hires_lora_test/tree/9af7b1f3d135ce132cc6c4b8147030efff19507f).

## Local comparison, 22 October 2026

Thirteen uncached images were generated and visually checked in a separate
ComfyUI 0.42.1 / PyTorch 2.14.1+cu130 installation on an RTX 4070 Ti SUPER
16 GB with 32 GB system RAM. The patched original engine was preserved.
All used the pinned INT8 ConvRot checkpoint, Qwen3.5 9B W4A8 GPTQ encoder and
small FLUX2 VAE. Other desktop applications were running.

The three 1024-square prompts covered a photographic portrait with hands,
four lines of poster text, and a painted courtyard with an exact object count.
Raw prompts and seeds matched across recipes. Times are Studio ledger seconds;
the first job after unloading is separated from the next two resident jobs.

| Recipe | First job | Resident poster | Resident courtyard | Resident mean |
| --- | ---: | ---: | ---: | ---: |
| MOSS Standard, 25 steps | 27.242 s | 15.850 s | 15.944 s | 15.897 s |
| Kromoss Standard, 25 steps | 21.733 s | 16.808 s | 16.014 s | 16.411 s |
| Kromoss DMD2, 8 steps | 13.684 s | 5.750 s | 6.057 s | 5.904 s |

Kromoss Standard matched the portrait and poster well, but its courtyard added
a third cup and unwanted lettering. It is an optional style alternative, not
a demonstrated overall replacement for SFT. DMD2 was useful for faster drafts;
its portrait hands were more blurred, and its courtyard had a small unwanted
signature-like mark. These results compare complete recipes, not equal-step
checkpoint speed for the distilled adapter.

Two separate 2048-square pairs used SFT at 25 steps, CFG 4 and ordinary native
VAE decoding. Adding only HiRes v0.3 gave 83.205 s versus 84.433 s for the
portrait, and 83.528 s versus 83.579 s for the courtyard. Both versions were
detailed. The adapter changed framing and texture, with crisper illustrated
edges in the courtyard, without a decisive broad quality gain. It remains an
opt-in experiment; Standard remains the default MOSS preset.

These are small local samples, not general rankings or hardware requirements.
Loading, compilation, paging and other applications affect times. The hires
adapter's explicit licence is unverified. New HiRes library events record
unknown combined terms and the adapter pin; historical benchmark events are
preserved rather than rewritten.
