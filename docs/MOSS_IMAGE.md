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
  generation, Fast draft, custom LoRAs and CLIP skip. Use Qwen Image 2.1 or the
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

In **Pictures**, select **MOSS-Image SFT (experimental, text only)**. Models
offers its three native files. An incompatible engine needs a separately
prepared compatible installation; this option does not replace the current
patched installation automatically.

Through MCP, call `moss_image_status`, then `make_image` with
`engine: "moss-image"` and a text prompt. `set_image_engine` can remember an
explicit preference. It is never chosen by the automatic recommendation while
the integration remains experimental. `list_dits` and the own-file picker can
recognize native MOSS tensor architecture rather than guessing from a name. Only
the exact SFT INT8 bundle is enabled; other variants and renamed companions are
refused until validated.

Use matched prompts/resolutions and separate cold-load from warm timings when
comparing it with Qwen. Review outputs for the task that matters: text, faces,
hands, composition and style. Keep reference/edit checks separate because
MOSS's text-only generation is a different capability.

## Sources

- [OpenMOSS project](https://openmoss.ai/MOSS-Image/)
- [Official code and user guide](https://github.com/OpenMOSS/MOSS-Image)
- [Original SFT weights and Apache-2.0 license](https://huggingface.co/OpenMOSS-Team/MOSS-Image-SFT)
- [Pinned Comfy native repack](https://huggingface.co/Comfy-Org/MOSS-Image/tree/24147db865fcdc207270f844777587223fed8d6e)
- [Native Comfy workflow templates](https://github.com/Comfy-Org/workflow_templates)
