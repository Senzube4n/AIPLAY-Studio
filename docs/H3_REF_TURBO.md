# H3 reference turbo versions

For whole-video structural guidance, see [H3 source clip guidance](H3_VIDEO_CONTROL.md).

Eight-step reference renders prefer **REF2V Turbo V1.1** when its file is
installed. V1.0 remains the first fallback. Four-step reference renders keep
the separate REF2V v0.1 adapter; text/first-last-frame paths, the default step
count and the bare-model Quality path are unchanged.

In Models, **Video references — MiniMax H3 ref2va** offers the ref2va checkpoint,
V1.1 and the four-step adapter. Existing shared encoder and VAEs are reused.
An older V1.0 installation can still render through the fallback, and the
Models row offers V1.1 as an update. Nothing downloads automatically and no
installed V1.0 file is deleted. Studio excludes both eight-step adapters from
the custom LoRA stack, so an automatic speed adapter cannot be applied twice.

## Exact file and recipe

| Field | Value |
|---|---|
| Publisher | [`lightx2v/Minimax-h3-Turbo`](https://huggingface.co/lightx2v/Minimax-h3-Turbo) |
| Revision | `30f485ed874aa44c8183348ad361c5eabad318da` |
| File | `minimax_h3_ref2v_turbo_8step_v1.1_768p_comfyui_bf16.safetensors` |
| Bytes | `1956193000` |
| SHA-256 | `e56863a7524e0300729cbb7b64cc8b548d90698c1abbf7d83898b0122fbe1e81` |
| Studio reference recipe | 8 steps, strength 1, video/audio shifts 12/3, `res_multistep` / `simple` |

The recipe preserves Studio's reference protocol. An explicit sampler or shift
still wins. It is not a claim of the publisher's optimal V1.1 recipe. The
publisher's newer shift-6 advice is specifically for FL2V, rather than REF2V
([discussion 57](https://huggingface.co/lightx2v/Minimax-h3-Turbo/discussions/57));
the earlier REF2V recipe specifies shifts 12/3 and Euler
([discussion 51](https://huggingface.co/lightx2v/Minimax-h3-Turbo/discussions/51)).
The MiniMax H3 licence and existing territory acknowledgement apply unchanged.
The adapter adds no runtime, framework update or platform-specific code.

## What was compared

On 2026-10-23, one fresh uncached sequential pair used the same Singularity V2
checkpoint, prompt, seed 23102026, reference, 1344×768 output, 124 frames at
24 fps, eight steps, strength 1 and the recipe above. The only graph differences
were the adapter filename and output prefix. Both MP4s passed full CPU decode
and stream/frame checks. Twelve equally spaced frames from each were compared.

V1.0 ran for **260.611 seconds** and V1.1 for **246.861 seconds**: V1.1 used
**5.276% less running time in this pair**. V1.1 showed clearer sampled cup/hand
lowering, while changing more of the reference café scene. V1.0 retained that
scene more closely. The creator chose V1.1 as the default with that tradeoff.
One pair does not establish a repeated speed advantage or an overall quality
winner, and the sampled stills do not establish smooth motion or audio quality.

The older character and lip-sync calibration remains pinned to the exact
eight-step **V1.0** build. Selecting V1.1 does not inherit those historical
measurements, even when the V1.0 file remains installed. No V1.1 identity,
lip-sync, other-checkpoint or other-hardware benchmark is claimed here.
