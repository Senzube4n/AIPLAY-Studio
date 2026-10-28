# H3 source clip guidance

**Source clip** on Video guides a local MiniMax H3 render with the structure of
an existing video. It does not promise to preserve the source's pixels,
character identity, face, clothing or exact motion. Describe the result you want
in the prompt and review the generated take before using it.

## Use it in Studio

1. Choose **MiniMax H3** on Video, using the built-in Video workflow.
2. In **Source clip**, pick a video from **Library** or **Upload** one. Uploads
   become local Library clips; removing the source from the form leaves the
   Library file intact.
3. Enter the prompt and choose the output length and size. Depth is the initial
   mode. In Advanced, open the source clip's **Control settings** to choose
   **Depth** or **Pose** and adjust strength or the control window. Returning to
   Simple keeps the selected mode while hiding those settings.
4. Read the preflight result. A missing dependency offers **Review model**;
   downloading requires your separate choice. Then press **Render**.

The source stays selected when you switch engines, but it is submitted only on
the local H3 path. Remove it before using another engine, remote rendering,
a friend's text recipe or an assigned custom Video workflow. A compatible H3
checkpoint choice is still allowed. Continuation, looping, RefMod, H3 model
tweaks, bridge, block cache and sparse attention cannot be combined with this
path.

## Depth, Pose and prepared maps

| Mode | What guides H3 | Dependencies |
|---|---|---|
| Depth (default) | Estimated near/far layout and silhouettes | H3 Fun ControlNet patch plus Depth Anything V2 **Small** |
| Pose | Detected body, hand and face landmarks | H3 Fun ControlNet patch plus the TorchScript YOLOX/DWPose pair |
| `prepared` (API/MCP only) | An already authored control-map video | H3 Fun ControlNet patch; no estimator |

Pose extraction can miss people in drawings or stylized footage. Depth can
misread fine edges, reflections and occlusion. Neither is an identity lock.
`prepared` skips extraction; ordinary RGB footage does not become a depth or
pose map merely by selecting it.

Strength defaults to **1** and accepts **0–2**. Start/end default to **0/1** and
are fractions of the **denoising schedule**, not source-video trim points.
They must satisfy `0 <= start < end <= 1`.

## Source length and framing

The source must be a nonempty local Library video under 2 GiB, with one video
stream. MP4, MOV, MKV, WebM and M4V names are accepted when ffmpeg can decode
their actual container. Playlists, paths outside the Library and symlinked
source files are refused. ffmpeg and ffprobe must be available.

Studio conforms the beginning of the source to the render's dimensions and
**24 fps**, scaling to cover and cropping at the center. Longer sources are
trimmed. Short sources are refused rather than padded, looped or slowed down.
H3 rounds the requested duration to its `17k + 5` frame grid: a five-second
request needs **124 frames**, or about **5.167 seconds** of source. Leave a
little extra footage or shorten the render if preflight reports a short source.
Source audio is not copied into the control map; the song-under-clip controls
remain separate.

## Installation and terms

The H3 Fun ControlNet patch must match the selected H3 checkpoint's timestep
embedding form. The **full** patch is about **6.81 GB** and is needed for
full-form checkpoints such as Singularity V2. The **pruned curve** patch is
about **2.3 GB** and is restricted to supported checkpoints with the matching
curve basis. Studio checks this compatibility before extracting a control map.
An unknown or mismatched form is refused; changing a filename or choosing a
different precision does not make the forms interchangeable.

Studio's bundled full-patch loader reads the original publisher file and
converts its tensor layout in memory. It preserves the full timestep embedding
and leaves the downloaded file unchanged. The required patch is offered through
Models when it is missing; downloading still requires your separate choice.

Depth Small is about **99 MB**; the Pose pair is about **353 MB**. Studio
bundles the preprocessing **code**, not these weights. On a fresh H3 setup
without the external `comfyui_controlnet_aux` pack, Models downloads these
files under `models/controlnet/aiplay_preprocessors/<repo>/<file>`. An existing
aux installation keeps its `custom_nodes/comfyui_controlnet_aux/ckpts` shelf,
even if its weights are missing; an exact existing legacy file also keeps that
destination. The bundled H3 nodes read compatible local files and never
download weights themselves.

Legacy VACE Depth/Pose separately requires the external
`comfyui_controlnet_aux` node pack. The optional Depth **Large** file remains
external-pack-only; Studio's bundled H3 nodes do not support it.

If you add the aux pack **after** downloading the H3 weights, **restart Studio**
before using Models so the catalogue selects the legacy shelf. Then explicitly
copy the unchanged files from the modern shelf into the matching paths below
its `ckpts` folder, preserving these repository subfolders, or choose
**Download** again:

- `depth-anything/Depth-Anything-V2-Small/depth_anything_v2_vits.pth`
- `hr16/yolox-onnx/yolox_l.torchscript.pt`
- `hr16/DWPose-TorchScript-BatchSize5/dw-ll_ucoco_384_bs5.torchscript.pt`

A second download can leave a duplicate copy. Studio does not migrate weights
or redirect the external pack's model root automatically.

Preflight also checks the running engine's actual node schemas. If it reports
missing bundled nodes, restart the idle Studio engine before trying again.

H3's existing model licence and territory notice apply to the patch and the
render. The Models screen retains the separate estimator terms: bundling
Apache-2.0 software does not resolve the DWPose weight licence uncertainty.
The H3 source path explicitly uses Depth **Small**, never the optional
non-commercial Large model.

## API and MCP

`POST /api/video` accepts the same fields for `action: "check"` and
`action: "create"`:

```json
{
  "action": "check",
  "prompt": "A clay miniature performer in a warm studio",
  "sourceVideo": "my-take.mp4",
  "controlMode": "depth",
  "controlStrength": 1,
  "controlStart": 0,
  "controlEnd": 1,
  "width": 1344,
  "height": 768,
  "seconds": 5,
  "steps": 8,
  "sparse": "off"
}
```

Use the actual basename returned by `list_clips`, not an arbitrary filesystem
path. MCP `make_clip` uses `source_video`, `control_mode`, `control_strength`,
`control_start` and `control_end`; `check_only: true` validates without a render.
With no source selected, omit all control fields.

To choose a checkpoint for this request, pass optional `modelFile` to the API
or `model_file` to MCP `make_clip`, using the exact installed filename from the
Video model picker. Check and create both validate that file for the selected
engine. On H3 it supplies both the plain and reference checkpoint slots, so
adding a reference cannot silently select a different base checkpoint. This
does not change the saved/default selection. Omit it to use that selection.

Check hashes and measures the source and checks dependencies without staging
files or queuing an extraction/render. `videoControl` in a successful check
describes the source, mode and actual target frame grid. Its `checkpoint` names
the resolved H3 file and its timestep form, including when no per-request
override was supplied; `patchId` and `patchLoader` identify the matching patch
and loader. A queued job rechecks these choices before preparation and render.
`videoModels` reports
the validated named override or `null`; MCP returns its selected checkpoint as
`model_file`, or `null` when no validated override was supplied. Source-control
plans return `fit: null` with an unmeasured-memory caveat rather than borrowing
the ordinary H3 render's fit estimate. Missing weights return
`needsModel` with the catalogue ID and `download_model` tool; missing engine
nodes return `needsNodes`. Create rechecks the queued source before preparation.
The render record carries source/control hashes and the preprocessing run ID
when extraction ran.

The preprocessing code is portable across Studio's supported devices. This
documentation makes no GPU, speed, quality or cross-platform inference
benchmark claim for this path.
