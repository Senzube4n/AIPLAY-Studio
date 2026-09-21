# Qwen Image 2.1 in Studio

Studio uses the native ComfyUI Qwen Image 2.1 workflow for image creation and
reference-guided editing. The Images page and `make_image` select it by default.
Fresh installations also default automatic covers to Qwen; saved engine choices
are preserved. Missing files or nodes produce an actionable cover failure before
a GPU graph is submitted. An offline engine leaves queued work explicitly deferred.
Check Models or `qwen_image_status` before rendering: installing weights alone
does not add missing ComfyUI nodes.

## Installation and model choices

The catalogue downloads three official files, pinned by revision and SHA-256:

| Component | File | Download size |
|---|---|---:|
| Diffusion model | `qwen_image_2.1_int8_convrot.safetensors` | 7.26 GB |
| Text and vision encoder | `qwen3vl_8b_int8_convrot.safetensors` | 9.35 GB |
| Dedicated VAE | `qwen_image_2.1_vae_bf16.safetensors` | 0.68 GB |

Use a ComfyUI build containing `TextEncodeQwenImage21` and the corresponding
Qwen Image 2.1 architecture. Current official ComfyUI supports it; an older build
may not. The readiness response names missing nodes and files. Studio does not
silently upgrade a customized runtime. The installer resolves an official release;
existing customized installations should preserve their local changes when updating.

The native INT8 package is the supported catalogue option. Compatible native
`.safetensors` DiT, encoder and VAE filenames can be selected explicitly. Community
GGUF conversions are a different loader path and are not advertised as working
by this integration. In particular, the linked community Q8 conversion reports
an upstream shape mismatch; a filename containing “uncensored” does not establish
different base weights or a capability test.

Download sizes are not VRAM requirements. Memory and time depend on image size,
batch, references, runtime and offloading. The model uses the Qwen Research License,
not Apache-2.0; the catalogue links its terms before download.

## Generation and references

The starting recipe is 25 steps, CFG 1, Euler and the simple scheduler. A negative
prompt requires CFG greater than 1. Supply up to ten ordered reference images and
refer to them as `<image 1>`, `<image 2>`, and so on. With reference sizing, the
encoder supplies the latent shape matching reference one. Custom output dimensions
are an explicit choice. Missing references are refused rather than silently omitted.

Transparency is an RGBA generation request, not background removal. The graph
preserves the dedicated VAE's RGBA output. Prompt adherence and edge quality
still need inspection. Existing per-image privacy blur remains available in the
library and through `image_set_blur`; it is independent of model selection.

## Layered image editor

The canvas previews the actual composed document. Qwen freezes that composition
as image 1 before generation, including layer visibility, adjustments and transforms.
Edit and Style modes allow nine more pictures. Style puts its first style reference
at image 2. Inpaint reserves image 2 for the selection mask and permits eight more
references. The mask also controls the final composite: zero-mask RGBA pixels stay
exactly equal to the frozen source, including transparent pixels.

Compare the candidate with the frozen source before accepting it. Accept adds a
full-canvas layer and hides the old layers; undo restores their visibility. The old
layers remain in the saved document. Revision checks and a shared shelf lock refuse
stale results instead of overwriting intervening edits. Generated candidates and
accepted documents persist; review jobs and their one-click undo records last for
the current app session.

A nontransparent original document background is also retained as a hidden bottom
solid layer named **Original document background**, so its color and alpha remain
recoverable after an app restart.

Legacy tools that operate on a flat library file are unavailable while viewing a
document. Use **Documents → Render & open composite** to use those tools on the
visible composition. This avoids applying a tool to a previously opened image.
Direct layer painting currently requires a visible, unlocked, full-canvas image
with identity transforms. Transformed or smaller layers give the same composite
guidance; Qwen can still edit the entire composed document.

## MCP

Use `import_local_media` for local reference pictures, `make_image` for generation,
and `image_ai_edit_create` followed by `image_ai_edit_status` for a candidate.
Review it, then use `image_ai_edit_accept`, `image_ai_edit_undo`, or
`image_ai_edit_discard`. `image_document_preview` renders a saved document without
flattening it. The browser and MCP use the same handlers and actor provenance.
See [MCP workflow controls](MCP_WORKFLOWS.md).

## Local validation — 2026-09-21

Actual stdio MCP requests completed on an RTX 4070 Ti SUPER 16 GB, 32 GB system
RAM, PyTorch 2.13.0+cu130 and ComfyUI with native Qwen Image 2.1 support. These
were 512×512, batch one, 25-step, CFG 1 checks, using 512 reference resolution
for edits. The times include Studio orchestration and completion polling.

| Request | Elapsed | Observed result |
|---|---:|---|
| Text-to-image, first load | 70.0 s | Teal teapot with coral lid |
| Transparent image, warm | 29.0 s | Watercolor leaf with real alpha, including fully transparent pixels |
| Two-reference style edit, after runtime restart | 64.8 s | Same teapot composition in watercolor; requested seed verified in the actual graph |
| Masked document edit, warm | 44.7 s | White star added; zero RGBA pixel changes outside the selected rectangle |

Accepting the style candidate rendered pixels identical to the candidate. Undo
restored pixels identical to the original. The accepted masked document likewise
matched its candidate exactly. Live testing found and fixed standalone-image seed
mixing; regression coverage also checks exact-seed replay when ComfyUI caches pixels.

This establishes these small jobs on this machine, not minimum VRAM, ten-reference
performance, large-canvas throughput, every prompt's quality, or a GGUF benchmark.

Sources checked 2026-09-21:
[official model](https://huggingface.co/Qwen/Qwen-Image-2.1),
[official native files](https://huggingface.co/Comfy-Org/Qwen-Image-2.1),
[ComfyUI core](https://github.com/Comfy-Org/ComfyUI),
[community GGUF model notes](https://huggingface.co/abenzerps/Qwen-Image-2.1-Uncensored-GGUF).
