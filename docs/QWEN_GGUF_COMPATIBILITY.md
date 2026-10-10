# Qwen Image 2.1 GGUF compatibility check

Checked 2026-09-27. This is a compatibility record, **not** an install recipe or
a claim that Studio can currently render this format.

The publisher's [Q4_K_M model card](https://huggingface.co/abenzerps/Qwen-Image-2.1-Uncensored-GGUF)
describes a ComfyUI path using `UnetLoaderGGUF`, the standard Qwen3-VL encoder
and the dedicated Qwen Image 2.1 VAE. Its repository revision
`8fa47c0eb8da2323cd756f01404601ed4ff4706e` advertises these exact files
([revision metadata](https://huggingface.co/api/models/abenzerps/Qwen-Image-2.1-Uncensored-GGUF/revision/8fa47c0eb8da2323cd756f01404601ed4ff4706e?blobs=true)):

| File | Bytes | SHA-256 |
|---|---:|---|
| `qwen-image-2.1-UC-Q4_K_M.gguf` | 4,604,558,112 | `e79c8a009f2ecbdb6c70fd663d9aea9ee304a0d91f347e4169a756b8ad141b41` |
| `text_encoders/qwen3vl_8b_int8_convrot.safetensors` | 9,350,798,360 | `8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f` |
| `vae/qwen_image_2.1_vae_bf16.safetensors` | 675,509,688 | `bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9` |

This is a 14.63 GB download before runtime memory. The publisher recommends
Q4_K_M and the [Q8 sampling report](https://huggingface.co/abenzerps/Qwen-Image-2.1-Uncensored-GGUF/discussions/4)
records a Q8-specific 136-versus-128 norm tensor failure; that report says
Q4_K_M, Q5_K_M and Q6_K avoid it. Neither a file size nor that report
establishes a 6 GB VRAM requirement or a successful Studio render. The
publisher's “uncensored” label does not prove different base weights: the card
itself says these are quantizations of the upstream Qwen base. The upstream
[Qwen model](https://huggingface.co/Qwen/Qwen-Image-2.1) is under the Qwen
Research License; a GGUF option would carry Studio's same not-for-sale notice.

The blocker is the loader currently installed at
`D:\AI\aiplay-studio-bench\ComfyUI\custom_nodes\ComfyUI-GGUF`:
`city96/ComfyUI-GGUF` commit `6ea2651e7df66d7585f6ffee804b20e92fb38b8a`.
Its [`IMG_ARCH_LIST`](https://github.com/city96/ComfyUI-GGUF/blob/6ea2651e7df66d7585f6ffee804b20e92fb38b8a/loader.py)
contains `qwen_image` but not the GGUF file's `qwen_image21` architecture,
which the loader rejects before sampling. The publisher points to the
[`leejet` fork](https://github.com/leejet/ComfyUI-GGUF/blob/373048b8403a7820620065210a691263d4da0a61/loader.py),
where that architecture is allowed. Both forks register `UnetLoaderGGUF`, so
Studio's current `/object_info` node-name readiness check cannot tell them
apart. Installing the fork over a customized runtime, or alongside another
pack registering the same node, would change that runtime outside the model
download's scope.

**Decision:** leave the native INT8 catalogue option, default, graph and MCP
behavior unchanged. Do not expose a Q4/Q5/Q6/GGUF download or selection as
render-ready yet. To ship one, first verify the active loader implementation
without relying on the shared node name, route GGUF through `UnetLoaderGGUF`
while keeping the native `UNETLoader` path, and run generation plus reference
editing on the pinned Q4 files. Then add a conditional catalogue row and the
same rights/provenance information used for native Qwen. No weights, loader or
GPU job were installed or run for this check.
