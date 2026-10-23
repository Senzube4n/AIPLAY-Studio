# MOSS-Image SFT (experimental)

MOSS-Image is an optional **text-to-image** engine. Qwen Image 2.1 remains the
automatic picture choice and the editor/reference workflow. Existing project
settings are preserved. Selecting or downloading MOSS does not update ComfyUI,
change the active engine installation, or move a saved default.

## Native files and runtime

Studio uses the Comfy-Org repack at revision
`24147db865fcdc207270f844777587223fed8d6e`:

| Component | File | Bytes |
| --- | --- | ---: |
| SFT diffusion model | `moss_image_sft_int8_convrot.safetensors` | 5,413,698,958 |
| Text encoder | `qwen3.5_9b_w4a8_gptq.safetensors` | 7,343,591,088 |
| Small VAE | `flux2-vae_small.safetensors` | 249,521,340 |
| Total | Three files | 13,006,811,386 |

An assigned custom Cover workflow is refused before a manual MOSS job is
queued; unassign it to use the native MOSS recipe.

Exact sizes and full SHA256 values are pinned in `server/models.js`. These are
native components, not interchangeable with Qwen Image 2.1's encoder/VAE or
Studio's larger `flux2-vae.safetensors`. GGUF is not offered by this integration.

The graph is based on ComfyUI 0.42.1's bundled
`image_moss_image_t2i.json` template. It uses `UNETLoader`, `CLIPLoader` with
`type=moss_image`, `CLIPTextEncode`, `EmptyFlux2LatentImage`, `KSampler`, and the
small VAE. A compatible runtime must expose the MOSS text-encoder type as well
as all graph nodes. Generic loader/sampler nodes on an older runtime are not
sufficient. An unavailable or incompatible runtime fails before queueing.

## Recipe and limits

- Default: 1024 x 1024, 25 steps, CFG 2.5, `er_sde` / `simple`, denoise 1.
- Native model sampling shift: **5**, recorded as `shiftSource:
  native-model-default` in the image recipe.
- Prompt upsampling and skip-layer guidance are **off**. The stored expanded
  prompt is sent unchanged to the text encoder.
- Native dimensions: multiples of 16 from 256 to 2048 per side. Up to four
  images per job; this is an input limit, not a measured memory guarantee.
- Steps: 1 to 50. CFG: 1 to 10. A negative prompt needs CFG greater than 1.
- This initial preset refuses image references, personas, editing, transparent
  generation, Fast draft, arbitrary custom LoRAs and CLIP skip. Use Qwen Image 2.1 or the
  relevant existing engine for those operations.
- The editor and Collab image-job contract remain on Qwen Image 2.1. MOSS is
  not silently substituted for an existing reference or project workflow.

MOSS's original official defaults and Comfy's faster template are different
recipes. This implementation labels the latter explicitly; a claim about
speed or quality must name the recipe, checkpoint, prompt enhancement setting,
canvas and hardware. No minimum RAM/VRAM, superiority over Qwen Image 2.1, or
cross-vendor performance is established merely by the downloadable sizes or
these CPU graph tests.

## Use

In **Pictures**, select **MOSS-Image (experimental, text only)**. Models
offers its three native files. An incompatible engine needs a separately
prepared compatible installation; this option does not replace the current
patched installation automatically.

Through MCP, call `moss_image_status`, then `make_image` with
`engine: "moss-image"` and a text prompt. `set_image_engine` can remember an
explicit preference. It is never chosen by the automatic recommendation while
the integration remains experimental. `list_dits` and the own-file picker can
recognize native MOSS tensor architecture rather than guessing from a name.
Standard and the original accelerator presets use the exact SFT INT8 bundle.
The explicit Kromoss presets select their own pinned checkpoint; arbitrary
variants and renamed companions remain refused.

Use matched prompts/resolutions and separate cold-load from warm timings when
comparing it with Qwen. Review outputs for the task that matters: text, faces,
hands, composition and style. Keep reference/edit checks separate because
MOSS's text-only generation is a different capability.

## Optional acceleration presets

Pictures has one **Preset** control in Advanced mode. **Standard** remains
selected. Spectrum H1/H2 preserve the standard 25-step CFG 2.5 recipe and require
the separately installed [pinned Spectrum source pack](MOSS_SPECTRUM_SETUP.md).
H1 uses a conservative one-forecast horizon; Adaptive H2 uses the upstream
ER-SDE H1-to-H2 controller. Both keep `er_sde` / `simple`, native shift 5, raw
prompts and no skip-layer guidance.

**Turbo 4** and **DMD 8** use the exact model-only LoRAs offered in Models,
at strength 1, with 4 or 8 steps, CFG 1 and Euler/simple. Their fixed controls
cannot be changed silently. A negative prompt is refused at CFG 1. The fast
presets support at most 1,048,576 pixels and a 1536-pixel side; larger canvases
need Standard. These adapters share the existing three native MOSS base files.
The DMD shelf filename is explicit; its upstream file is named `lora.safetensors`.
Exact revisions, byte sizes and SHA256 values are shared by the recipes and
Models catalogue. The actual adapter SHA is verified before queueing, with a
bounded cache invalidated by file identity, size and modification/change times.

The tested base is **INT8 ConvRot**. ComfyUI's native LoRA path can dequantize,
apply a delta and requantize weights. This is an experimental INT8 recipe,
**not** a measurement of the publisher's BF16 base or FP32 unmerged path.
No BF16 fallback was tested or needed for these examples.

Through MCP, pass the same `moss_preset` to `moss_image_status` and `make_image`:
`standard`, `spectrum-manual-h1`, `spectrum-adaptive-h2`, `turbo-4` or `dmd-8`.
The HTTP field is `mossPreset`. Image metadata records the actual graph policy,
source revision or adapter release/strength/verified SHA, and a recipe fingerprint.

### Kromoss and high-resolution options

Three further explicit presets are available: `kromoss-standard` matches the
default 25-step SFT sampling recipe with a different full checkpoint;
`kromoss-dmd2-8` uses that checkpoint's own eight-step DMD2 adapter;
`moss-hires-v03` uses the SFT checkpoint and a HiRes LoHa at exactly
2048 × 2048, 25 steps, CFG 4 and count 1. Standard stays selected by default.
These additions do not inherit the SFT timings or visual findings below.

The [Kromoss and HiRes guide](MOSS_KROMOSS_HIRES.md) lists the extra Models rows,
exact artifacts, recipes, MCP inputs and comparison limits. HiRes uses native
VAE decoding and has no automatic tiled fallback. Its reviewed publisher release
supplies no explicit adapter licence, so its terms remain unknown in Models.

### Optional NSFW Uncensored adapter

Install **MOSS NSFW Uncensored (optional)** in Models, then choose
**NSFW Uncensored** in the MOSS preset menu. Standard and the automatic cover
engine keep their existing defaults. The adapter is selected only by this
explicit preset; custom adapter stacks remain unsupported.

The native ComfyUI file is
`MOSS-Image-NSFW-Uncensored-LoRA-ComfyUI.safetensors` (74,379,584 bytes), from
[`axiomofmind/Moss-image-nsfw-uncensored-lora`](https://huggingface.co/axiomofmind/Moss-image-nsfw-uncensored-lora/tree/7f8c6953c6a88af8cbc8daeb34633c237dd1a7bb),
revision `7f8c6953c6a88af8cbc8daeb34633c237dd1a7bb`, SHA-256
`f766c5774a3fb68caa490bbc3f8153e8b5ccacafc36a1ee7f9ad6ec230ff11a3`.
It uses the existing MOSS SFT checkpoint, encoder and VAE. The publisher
supplies an [Apache-2.0 licence](https://huggingface.co/axiomofmind/Moss-image-nsfw-uncensored-lora/blob/7f8c6953c6a88af8cbc8daeb34633c237dd1a7bb/LICENSE).
The PEFT file, separate GGUF adapter and large merged Diffusers model are not
the native ComfyUI file and are not downloaded by this option.

Begin the prompt with **`moss_xvstyle`** when following the publisher's recipe.
Studio preserves the prompt you enter and does not insert the trigger.
The model-only loader applies strength **0.7**, leaving CLIP unpatched
(publisher clip strength 0). The preset fixes **30 steps, CFG 3,
ER-SDE/simple**, starts at 1024 × 1024, and retains the existing adapter limit
of 1024² pixels and a 1536-pixel side. Exact file size, SHA and native loader
support must pass readiness before queueing.

The adapter was trained on MOSS Base; the publisher prefers SFT for inference
and also reports Base compatibility. This Studio preset targets SFT only.
Its native INT8 requantization, sampler and disabled skip-layer guidance do
not reproduce every part of the publisher's BF16 Diffusers example, which
skips layer 22 in negative conditioning. Publisher example content and quality
have not been validated by this integration. Metadata records the selected
recipe, source pin, trigger, actual strength and verified adapter SHA.

MCP callers use `moss_preset: "nsfw-uncensored"`; HTTP callers use
`mossPreset: "nsfw-uncensored"`. Check readiness with the same preset.

### Local comparison, 22 October 2026

A serial Studio-MCP comparison used an RTX 4070 Ti SUPER (16 GB), ComfyUI
0.42.1 and PyTorch 2.14.1+cu130. Each recipe made the same three raw prompts and
seeds at 1024 x 1024, count 1: a portrait with a mug, a four-line poster and a
courtyard with exactly two blue cups. All 15 outputs were visually inspected.
These are examples, not a blind benchmark or general quality ranking.

| Preset | Steps / CFG | First job after unload (s) | Mean of two resident-model new prompts (s) |
| --- | --- | ---: | ---: |
| Standard | 25 / 2.5 | 27.773 | 16.920 |
| Spectrum H1 | 25 / 2.5 | 21.617 | 12.375 |
| Spectrum H2 | 25 / 2.5 | 18.071 | 11.928 |
| Turbo 4 | 4 / 1 | 12.061 | 4.988 |
| DMD 8 | 8 / 1 | 13.196 | 6.138 |

Times are the recorded Studio job duration, including queue/run work, not isolated
denoiser timing. Supported model unload and settling separated groups; the first
job still depends on filesystem caches and compilation. The final Standard
portrait took 22.743 seconds, so the first-job differences are not pure
accelerator speedups. The two later jobs used new prompts, not cached outputs.

Spectrum H1 stayed close to Standard's composition, text and natural portrait
in these examples; H2 was slightly faster and similarly close. Turbo 4 was the
fastest useful option, with a softer portrait and changed compositions. DMD 8
was slower than Turbo 4 but retained more mug/grip detail in the portrait.
All five recipes preserved the poster's four requested text lines and the
courtyard's two cups. Individual differences included added furnishings and
changed framing. None establishes universal superiority, memory savings or
performance on another GPU/vendor.

A sixteenth job restored Standard after all accelerator groups and supported
unload. Its decoded RGB pixels exactly matched the initial Standard portrait
(SHA256 `58bd3c9561843cb2938ec12886372a0f647207f6e37573d4168af37a88933102`).
This confirms that tested restored path; it does not prove every possible
in-memory switching sequence.

<details>
<summary>Exact comparison prompts and seeds</summary>

**portrait**, seed `22102026`:

> A candid 35mm photograph of an adult woman with short dark curly hair and freckles, sitting at a wooden cafe table by a large window. She wears a plain blue linen shirt and holds a white ceramic mug naturally with both hands. Soft overcast daylight, realistic skin texture, sharp eyes, subtle film grain, shallow depth of field, restrained natural colors. Medium portrait showing her face and both hands, no text or logos.

**poster**, seed `22102027`:

> Design a polished square poster on a warm cream background. At the top, large perfectly legible dark blue text says AIPLAY STUDIO. Under it, smaller text says OPEN CREATIVE LAB. The center contains a simple geometric illustration of a red paper boat floating on blue water, with a yellow sun above. At the bottom, clearly typeset text says SATURDAY 19:00 and a separate line says MAKE SOMETHING TOGETHER. Balanced spacing, crisp editorial typography, subtle paper texture. Only the four requested lines of text.

**composition**, seed `22102028`:

> A detailed editorial illustration of a quiet canal-side courtyard at golden hour. A red bicycle leans against a white wall on the left. A small round green table stands on the right, with one yellow teapot and exactly two blue cups on it. A ginger cat sleeps underneath the table. An arched blue door is centered in the background, surrounded by climbing pink flowers. Warm hand-painted gouache texture, coherent perspective, distinct objects, no text or people.

</details>

## Sources

- [OpenMOSS project](https://openmoss.ai/MOSS-Image/)
- [Official code and user guide](https://github.com/OpenMOSS/MOSS-Image)
- [Original SFT weights and Apache-2.0 license](https://huggingface.co/OpenMOSS-Team/MOSS-Image-SFT)
- [Pinned Comfy native repack](https://huggingface.co/Comfy-Org/MOSS-Image/tree/24147db865fcdc207270f844777587223fed8d6e)
- [Native Comfy workflow templates](https://github.com/Comfy-Org/workflow_templates)
