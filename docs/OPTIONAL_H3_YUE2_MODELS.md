# Optional H3 W6A8 and YuE2 style adapters

These downloads are explicit choices. None is installed, selected or activated
by startup, and the ordinary H3 and image defaults keep their existing picks.

## H3 W6A8

The [official Comfy-Org MiniMax-H3 repository](https://huggingface.co/Comfy-Org/MiniMax-H3)
publishes separate FL2VA and REF2VA W6A8 transformers. Each is **15,983,746,636
bytes**. Studio pins revision `e5eb578a89295337b8ff433a035929ce0279e0b6` and verifies
the publisher's LFS SHA256 on download:

| File | SHA256 |
| --- | --- |
| `minimax_h3_fl2va_pruned_w6a8.safetensors` | `ac746a2e41628ab25afd44d2b22a7fab8d7e66cd07a01bf89ed9d74b0d3f0c35` |
| `minimax_h3_ref2va_pruned_w6a8.safetensors` | `ece96bbbce76670ec782de84acc888fd9d9b210bd2ab97c1957b39896734f9f1` |

The catalog treats these as experimental alternatives beside H3. Speed,
quality, and render memory have not been established by this product change.
The ordinary H3 text encoder and audio/video decoders are still required.
The existing MiniMax licence and territory acknowledgement apply.

The implementation offers W6A8 on NVIDIA CUDA only. It checks the **configured
engine interpreter** and ComfyUI directory: the `w6a8_int8` registry and grouped
loader, comfy-kitchen six-bit source support, and a PyTorch CUDA 13 build or
later. [ComfyUI PR 16483](https://github.com/Comfy-Org/ComfyUI/pull/16483) merged on
29 September 2026; [comfy-kitchen PR 191](https://github.com/Comfy-Org/comfy-kitchen/pull/191)
adds six-bit support in both Python and compiled CUDA code. A source patch to
only the kitchen tensor class is insufficient. Studio does not update the
installed runtime to satisfy these checks.

`video.h3ModelBuild` accepts `auto` (the ordinary configured build) or `w6a8`.
`resolveH3Checkpoint()` selects the matching FL2VA or REF2VA file only when its
runtime is compatible and its exact-size file exists. Otherwise it returns the
ordinary configured checkpoint and a fallback reason. The requested preference
can be retained while the current session uses that fallback. FastH3 has its
own distilled weights and is not replaced by this H3 choice.

## YuE2 style adapters

[TRBDR folk troubadour](https://huggingface.co/becausereasons/yue2-trbdr-folk-troubadour)
has five choices: Broadside, Lantern, Hearth, Ferryman and Porch. They steer
English male vocals toward acoustic folk, guitar, harmonica and fantasy folk.
The catalog pins revision `078b19e52baebaa71463ea94afac5ce13abfe29a`.

[GRVL raspy rock and soul](https://huggingface.co/becausereasons/yue2-grvl-raspy-rock-soul)
has six choices: Ember, Smoulder, Cinder, Wildfire, Thunder and Tempest. They
steer English female vocals toward raspy rock, soul and pop. Thunder and
Tempest use the more focused v2 training set. The catalog pins revision
`314dbcf2779e92b1b04e8539f4c2ceee3516f969`.

Each choice has its own download, exact byte count and LFS SHA256 in
`server/music/yue2-style-adapters.js`. The repositories were ungated when checked
through the Hugging Face API on 30 September 2026. The files contain **both**
the planner and audio adapter in ComfyUI's fused layout.

Use the **YuE2 ComfyUI** engine, choose the same file in both planner and audio
LoRA slots, set Thinking to Full, and start both strengths at 1. Begin the
style with `trbdr,` or `grvl,` and describe voice delivery, instruments and mood.
The publisher recipes use 32 steps, `dpm_2`, `sgm_uniform`, and the bf16 YuE2
checkpoint. Applying these adapters to the int8 checkpoint has not been
evaluated here. The native Python and GGUF runners do not implement these
LoRAs; retained ComfyUI preferences must not disrupt those engines.

Both adapter publishers' model cards specify **CC BY-NC 4.0, noncommercial use
only**, with attribution to “TRBDR LoRAs by becausereasons” or “GRVL LoRAs by
becausereasons”. Studio carries that adapter restriction into song rights and
the ledger. The separate base YuE2 authors' statement does not expand the
adapter terms.

For TRBDR, the publisher reports repeated accompaniment with score mode Off,
occasional repeated score sections, and a preference for waltz meter. For
GRVL, later checkpoints can thin the high end; try reducing audio strength to
0.8. Long plans can reach the length cap and stop abruptly.

## Integration helpers

`probeH3W6a8(config)` performs read-only filesystem checks. Its compatibility
result is source evidence, not a successful GPU render; the `files` map reports
each official checkpoint's exact-size presence across the configured model
folders. Plain `.pth` imports are followed without executing Python code.

`validateYue2StyleAdapter({engine, lora, loraClip, cot, explicit})` rejects
unsupported active selections, mismatched slots and score modes other than
Full. Pass `explicit: false` only for dormant ComfyUI preferences on a native
engine. `yue2StyleAdapterGuide()` supplies adapter-specific prompt guidance.

`mountYue2StyleAdapters()` in `web/yue2-style-adapters.js` adds a compact picker
beside the existing LoRA controls. Supply `getState()`, `getAdapters()` (the
model capability rows), `onSelect(patch, adapter)` and optional `onChange()` /
`onError(error)` hooks. Call the returned `refresh()` after the engine,
catalogue or LoRA shelf changes. Refresh never modifies the form's selection.
An explicit style choice pairs both LoRA slots, starts both strengths at 1 and
sets Thinking Full; clearing the picker clears both slots without changing
Thinking or strengths. The caller persists the selection through the atomic
`/api/music` action `style-adapter` with `{value: adapter.file}` (empty clears).
The compact hint carries the family trigger and a CC BY-NC tooltip.
