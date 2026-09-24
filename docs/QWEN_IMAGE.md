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
still need inspection. Unless Transparent is on, a reference with alpha is sent
flattened onto white, as Qwen's vision tower sees it; its VAE would keep the alpha
and hand back a transparent picture. With Transparent on, references keep their
alpha. Existing per-image privacy blur remains available in the library and
through `image_set_blur`; it is independent of model selection.

## Fast draft

**Fast draft** is an optional 0.68 GB add-on: Viggle's v0.2 turbo LoRA (rank 128)
on the same Qwen Image 2.1 files. It renders in 5 steps on its own schedule
instead of 25. Get it from Models (row *Images — Fast draft for Qwen Image 2.1*).
On Pictures a chip reading **Fast draft · about 3× quicker · may garble small
text** then appears under the Make button, in Simple and Advanced. Without the
LoRA the same place offers **Get Fast draft (0.68 GB)**. `make_image` takes it as
`draft: true`, and so do Overnight image items.

Use it for storyboards, board thumbnails and ideas. It is off by default; the
full render stays the default and is the one for lettering, crowds, close hands,
two-reference style edits and finals.

Measured on 2026-09-24 on a 16 GB card, warm, in a blind A/B of five arms and
302 renders:

| Job | Full render | Fast draft |
|---|---:|---:|
| 1024², same prompt | 11.2 s | 3.1 s |
| 1024², a new prompt (pays the text encode) | 22.9 s | 12.2 s |
| 4 × 1344×768 | 45.4 s | 12.1 s |
| 1920×1088 | 27.2 s | 6.7 s |
| One-reference edit, 1344×768 | 15.7 s | 3.9 s |
| Two-reference edit, 1024² | 20.8 s | 9.1 s (only 2.3×) |

Where it fails: small text (a mirrored R, a reversed E), neon and stencil
lettering, and at 1 megapixel fused fingers or a melted face in a crowd. On the
two-reference edit both judges ranked it below the full render (it took the
second picture's grey background), so ticking it with two references shows a
note saying so. Skin is not waxy. Across 17 prompts the two blind judges put it
level with or ahead of the full render on 8 and 3. The same five steps without
the LoRA came last on 16 of 17, so the LoRA is what makes it work.

**Switching costs time.** The draft and the full render share one copy of the
model in VRAM, so every switch re-patches it: +8.8 s into a draft and +2.5 s
back into a full render. A draft right after a full render takes about 12 s.
Group drafts together (seed variations, a batch of 4): expect about 3 s straight
after a draft of the same words, about 12 s otherwise, and about 37 s when Qwen
is not loaded. Overnight's plan costs every draft take at about 12 s at 1024²
(a night goes round its ideas, so each take is a new prompt). No screen shows a
per-picture estimate; the render queue uses these numbers only to size its own
time limit.

What Studio builds: the stock `LoraLoaderModelOnly` at strength 1.0, then
`SamplerCustomAdvanced` with `BasicGuider` (CFG 1, no negative), `KSamplerSelect`
euler, `RandomNoise` and `ManualSigmas`. The sigmas are Viggle's raw nodes 1.0,
0.875, 0.75, 0.5, 0.25 through the dynamic shift (mu from 0.5 at 256 tokens to
0.9 at 8192), then a final 0. At 1024² that is `1.0, 0.9334, 0.8572, 0.6668,
0.4001, 0`. References take the same edit path as the full render. A
reference-sized edit sizes its schedule from the reference size (1024², so the
1024² schedule); the A/B sized its one-reference edits from the real 1344×768
reference, whose schedule differs from that by at most 0.0008.

These stay on the full render and are refused, with the reason, for a draft:
transparent output, masked edits (the editor), more than 3 references (a
character's pictures count; Viggle's own examples use 3, Studio measured 1 and
2), CFG above 1, a negative prompt, a step count other than 5, and a canvas past
8,192 latent tokens (about 2 MP: 1920×1088 was the largest measured, 2048×1024 is
the edge, and a reference size of 1440 the largest square), where the shift
formula would extrapolate. Provenance records `draft: true` and the LoRA on the
picture and in the ledger. The LoRA is under the Qwen Research License like the
base, so a draft is marked not for sale like every Qwen picture.

## Layered image editor

The canvas previews the actual composed document. Qwen freezes that composition
as image 1 before generation, including layer visibility, adjustments and transforms.
Edit and Style modes allow nine more pictures. Style puts its first style reference
at image 2. Inpaint reserves image 2 for the selection mask and permits eight more
references. The mask also controls the final composite: zero-mask RGBA pixels stay
exactly equal to the frozen source, including transparent pixels.

Unless Transparent is on, the editor sends an extra reference that has alpha
flattened onto white. That is what Qwen's vision tower sees, but its VAE keeps all
four channels, and one cutout reference was enough to make the whole generation
transparent. Inside the selection the generation is laid over the source, so a
transparent pixel keeps the source instead of punching a hole. The review names the
share of the selection that came back transparent, and a selection that came back
fully transparent fails instead of producing an unchanged candidate.

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
