# Local avatar workshop

The 3D workshop opens inside Studio’s shared sidebar, palette and player. Existing `/avatars.html?id=…` links redirect to `/?view=avatars&avatar=…`; OBS URLs with `overlay=1` remain standalone and transparent. Hidden workshop views pause rendering and voice playback.

The 3D page loads VRM 1.0 models with MToon materials, existing humanoid bones, expression presets, node constraints and spring-bone hair physics. It uses pinned `@pixiv/three-vrm` 3.5.5, served locally. No CDN is needed.

## Use

1. Use **Try anime sample** for the documented 10.3 MiB reference download, or import a self-contained `.vrm` using **VRM 1.0 workshop**, with the actual source/license. The local preview budget is 64 MiB, 150,000 triangles, 32 materials, 256 skin joints; textures are bounded at 4096 px and 64 megapixels total. Existing World GLB limits are unchanged.
2. Use **Test movement** to inspect gentle humanoid motion and existing hair springs. This is a procedural review pose, not a generated dance clip. Embedded clips retain their own raw-bone animation.
3. Choose visible embedded parts, tint materials and test expressions. The five vowel presets remain manual expression controls. Voice preview additionally drives `aa` (or `jawOpen`) from a local audio waveform. This is loudness-driven mouth motion, not phoneme recognition.
4. Save a named look. Choose a saved look to activate it. An open page follows MCP activation and edits unless it has an unsaved local draft.
5. **Overlay** supplies a local transparent browser-source URL for OBS. It follows the active saved look. This does not start streaming or connect Twitch/Kick.
6. Export the original model, manifest and active look separately. Looks pin the exact source hash; the source model is never rewritten.

The included workflow supports existing components inside a model. It does not automatically fit arbitrary generated hair/outfits. The advanced Attachment weights panel can transfer weights to an already aligned part using a local weighted base; see [its limits and requirements](AVATAR_PARTS.md). Rigged VRM models are distinct from static TripoSG geometry. VRM workshop admission does not grant native Agent World admission or bind an AIPlay account. Persona IDs here remain local attribution.

## MCP

`avatar_install_example` installs the hash-pinned reference on explicit request. `avatar_import` accepts `profile: "vrm"` for this runtime; `world` remains the default. `avatar_list`, `avatar_inspect` and `avatar_export` remain available.

- `avatar_appearance_inventory`: exact mesh/material indices, morph names, expression presets and spring availability.
- `avatar_appearance_list/get`: saved looks for a source asset.
- `avatar_appearance_save`: a name, source SHA-256, settings and expected revision (0 to create).
- `avatar_appearance_activate/active`: select or inspect the live local look.
- `avatar_appearance_delete`: remove a look at its exact revision.

Settings are `hidden_nodes`, `material_colors` (linear RGBA), `expressions` (name to 0..1) and `spring_enabled`. References must exist inside the source. Saves and activation share the same HTTP service as the page; concurrent saves cannot silently overwrite a newer revision. Origin/Host restrictions apply to all file and control routes.

## Reference model and limits

Runtime acceptance uses the official [VRM1 Constraint Twist Sample](https://github.com/vrm-c/vrm-specification/tree/master/samples/VRM1_Constraint_Twist_Sample), copyright 2022 pixiv Inc., governed by its embedded [VRM Public License 1.0](https://vrm.dev/licenses/1.0/) settings. It allows redistribution and modified redistribution, with usage conditions. It is not an MIT/CC0 model; the runtime library's MIT license is separate. The sample is stored locally for acceptance, not bundled into Studio.

This reference has 36,470 triangles, 154 unique skin joints, 18 expression presets, 22 spring chains and 13 colliders. It is a clean functional baseline, not the pink-haired design or a clothing library. The original Mika experiment still needs geometry, topology and material repair.

The recovered web configurator has 30 Quaternius-derived parts, but no facial morphs or spring hair. Its assembly concept can be reused; silently substituting a root bone for missing joints cannot. The web Agent World currently uses a fixed character body and still needs owner-scoped per-persona model resolution and a compatible VRM runtime before these looks can be installed there.

## Local learned rigging

An experimental native PyTorch attention path is available in `server/mesh/unirig_adapter.py` via `--attention sdpa`, or by starting Studio with `AIPLAY_UNIRIG_ATTENTION=sdpa`. Changing the environment requires a Studio restart because prerequisite results are cached. Default behavior remains FlashAttention.

The adapter verifies the tested upstream source contracts and PyTorch version, prepares a private source copy, then runs the existing extraction/skeleton/skin/merge pipeline. It does not install a pretend FlashAttention module or alter the installed UniRig checkout. The attention implementation is inference-only and fails closed on an unknown source revision. NVIDIA CUDA is still required for the actual released UniRig pipeline; CPU numerical tests do not establish CPU model execution.

Body skinning does not author hair spring chains or facial blendshapes. Those remain explicit authored data in the VRM baseline. [UniMate](https://github.com/Friedrich-M/UniMate) targets motion on already rigged assets; its public README still advertises pretrained checkpoints as forthcoming at the time of this work. No UniMate generation button is offered.

## Measured local rigging result

On an existing RTX 4070 Ti SUPER (16 GB), the revised Studio adapter completed the upstream giraffe through extraction, skeleton, skinning and merge in 83.125 seconds of run stages, plus prerequisite probing. The result has 41 joints and 14,885 exported vertices with embedded textures; binary skin validation passed. This is one measured run, not a speed or memory guarantee.

The original TripoSG Mika source also received a learned 65-joint rig. Its fused limbs, rough surfaces and missing textures remained. It is not the quality baseline for the configurator. Body auto-rigging and making a clean modular anime character are separate production steps.

The next asset milestone is a reusable, weighted body with compatible head, hair and outfit parts, authored facial morphs and explicit spring colliders. Arbitrary part fitting, persona ownership binding and Agent World runtime adoption remain outstanding. See [local audio playback](AVATAR_LIPSYNC.md) and [attachment weight transfer](AVATAR_PARTS.md) for the next local workflow pieces and their limits.
