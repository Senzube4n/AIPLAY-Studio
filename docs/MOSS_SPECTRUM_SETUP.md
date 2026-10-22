# Optional Spectrum for MOSS-Image

Spectrum H1 is an optional MOSS-Image recipe. Standard remains selected by
default. Both use the same native SFT INT8 model, raw prompt, 25 steps, CFG 2.5
and `er_sde` / `simple`. Spectrum forecasts some transformer evaluations; check
the finished picture for your prompt before choosing it for a final.

Qwen Image 2.1 remains the automatic picture choice and the reference/editor
workflow. This setup does not change that preference or select another engine.

## Install the standalone source pack

Use a separate compatible ComfyUI installation with native MOSS-Image support.
The native path was tested with ComfyUI 0.42.1. Download MOSS's three base files
from Studio's Models screen first; Spectrum adds source code, not model weights.

The setup command uses this exact upstream source:

- Repository: <https://github.com/Rkkss/ComfyUI-Spectrum-MOSS>
- Commit: `d3f7e243ea2db6cc3ff26f42b935b167f938b599`
- Version: `0.8.1`
- Licence: `GPL-3.0-only`, retained in the installed `LICENSE` file.

From the Studio checkout, first inspect the plan. Replace the example path with
the compatible ComfyUI folder you intend to use:

```powershell
node scripts/setup-moss-spectrum.mjs --comfy-dir "D:\AI\my-separate-engine\ComfyUI"
```

The plan writes nothing. To install the eight pinned files:

```powershell
node scripts/setup-moss-spectrum.mjs --comfy-dir "D:\AI\my-separate-engine\ComfyUI" --execute
node scripts/setup-moss-spectrum.mjs --comfy-dir "D:\AI\my-separate-engine\ComfyUI" --verify
```

The same commands work on Linux/macOS with an absolute native path. Setup
downloads only those eight files from the exact upstream revision and checks
every byte count and SHA256. It writes a source-pin marker after verification.
Setup does not run Python or pip, replace packages or model weights, change
settings, or restart the engine.

Use Studio's ordinary restart when its jobs are idle. Readiness requires both
the verified source pack and its native node in the running engine. Installing
files alone does not reload a running Python process.

Existing or partial folders are preserved and refused. Inspect a failed attempt
before taking another action; setup never overwrites or repairs it silently.

## Choose the recipe

In Pictures, choose **MOSS-Image SFT**, then **Spectrum H1** in
Preset. Check readiness. Its steps, CFG and sampler controls show the fixed
recipe that will run. References, personas, edits, transparency and custom LoRA
stacks are unavailable on this text-only path.

Through MCP, check the same preset before generating:

```json
{"tool":"moss_image_status","arguments":{"moss_preset":"spectrum-manual-h1"}}
```

```json
{"tool":"make_image","arguments":{"engine":"moss-image","moss_preset":"spectrum-manual-h1","prompt":"A lighthouse on a rocky coast at sunrise","width":1024,"height":1024,"seed":19}}
```

The picture's metadata records the exact source revision, node policy, native
sampling shift 5 and recipe fingerprint. Prompt upsampling and skip-layer
guidance remain off. H1 uses warmup 8, a final actual step and at most one
consecutive forecast; the full policy is pinned in `server/moss-presets.js`.

Choose **Standard** to return to the original MOSS graph. Qwen remains available
for references and edits. Speed and quality depend on the prompt, hardware and
whether model loading is included in the timing.

## Verify an existing exact checkout

If you installed this exact upstream revision yourself and its eight files
match, create the marker explicitly:

```powershell
node scripts/setup-moss-spectrum.mjs --comfy-dir "D:\AI\my-separate-engine\ComfyUI" --execute --write-marker
```

This mode checks the existing files without downloading anything. A mismatched
file or an existing marker is refused. Use `--verify` for later checks.

Studio keeps this optional upstream GPL source pack separate from its deployed
Studio nodes. The model's licence and image output terms are described in the
[MOSS guide](MOSS_IMAGE.md).
