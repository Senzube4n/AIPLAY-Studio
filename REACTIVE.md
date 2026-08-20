# Audio-reactive video — the optional second engine

This is **not part of an AIPLAY Studio install**, and you do not need it to use
Studio. Skip this file unless you specifically want the Reactive page.

Studio's own engine renders music, images, clips and restyles. The Reactive page
does something Studio's engine genuinely cannot do, and it needs a second
ComfyUI with four community node packs installed. This document explains what it
is, why it is separate, and how to set it up.

---

## What it does

Pictures that change on the beat.

The song is analysed, its peaks are found, and your reference images are
cross-faded **against each other** in time with those peaks — so a new picture
arrives on the hit rather than on a timer. Everything between the pictures is
invented by the model.

Three modes:

| mode | what it uses | what it is for |
|---|---|---|
| **Images → video** | reference images only | Abstract morphs. Nothing is filmed; the whole clip is invented between your pictures. |
| **Video → video** | a source clip + reference images | Your footage restyled, keeping its motion and framing. |
| **Text → video** | a prompt + reference images | The prompt decides the scene; the pictures still supply the look. |

Every mode needs **at least two reference images**, including text mode. The
blend is the whole mechanism, and a blend needs two things to move between.

---

## Why it is a separate engine

**Licensing.** The pack that makes this work, `ComfyUI_Yvann-Nodes`, is
GPL-3.0. AIPLAY Studio is Apache-2.0. GPL code cannot ship inside an Apache-2.0
application, so it is not bundled, not vendored and not installed by Studio.

**The boundary is the same one ComfyUI already sits behind.** Studio does not
link ComfyUI either — it starts it as a separate program and talks to it over
HTTP. The reactive engine works identically: a second ComfyUI, on its own port,
that Studio sends graphs to. Studio never downloads, installs or redistributes
any of it, and the licences are between you and the authors.

**It would also change what a Studio install is.** Putting four extra node packs
and ~11 GB of extra weights into Studio's own ComfyUI would make every install
carry them, for a feature most people will not use.

If no engine is configured or running, the Reactive page says so and shows this
setup. It never presents controls that fail when clicked.

---

## What it needs

### Node packs

| pack | licence | why |
|---|---|---|
| [ComfyUI_Yvann-Nodes](https://github.com/yvann-ba/ComfyUI_Yvann-Nodes) | GPL-3.0 | The audio analysis, peak detection and IPAdapter transitions. By Yvann Barbot and Lilia. |
| [ComfyUI_IPAdapter_plus](https://github.com/cubiq/ComfyUI_IPAdapter_plus) | Apache-2.0 | Conditions every frame on a mix of two images. This is what makes the blend continuous. |
| [ComfyUI-AnimateDiff-Evolved](https://github.com/Kosinkadink/ComfyUI-AnimateDiff-Evolved) | Apache-2.0 | Supplies the motion. |
| [ComfyUI-VideoHelperSuite](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite) | GPL-3.0 | Reads a source clip, for video-to-video. |

### Weights

Roughly 8.7 GB, none of it hosted or redistributed here:

- an **SD1.5 checkpoint** — [DreamShaper 8](https://huggingface.co/Lykon/DreamShaper)
  is what the original workflows use. It must be SD1.5: not SDXL, not an LCM
  checkpoint.
- the **AnimateDiff v3 motion module**, `v3_sd15_mm.ckpt`
  ([guoyww/animatediff](https://huggingface.co/guoyww/animatediff))
- an **IPAdapter PLUS** model for SD1.5, and a **CLIP-vision** encoder
  ([h94/IP-Adapter](https://huggingface.co/h94/IP-Adapter))

Video-to-video also uses `v3_sd15_sparsectrl_rgb.ckpt` if you follow the
upstream workflow, though Studio's own video mode does not require it — see
*How video mode differs* below.

---

## Setting it up

The safe shape is a **separate ComfyUI checkout** that shares your existing
models folder, so nothing about your Studio install changes and the 100+ GB of
weights are not duplicated.

```bash
git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git reactive-comfy
cd reactive-comfy/custom_nodes
git clone --depth 1 https://github.com/yvann-ba/ComfyUI_Yvann-Nodes.git
git clone --depth 1 https://github.com/cubiq/ComfyUI_IPAdapter_plus.git
git clone --depth 1 https://github.com/Kosinkadink/ComfyUI-AnimateDiff-Evolved.git
git clone --depth 1 https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git
```

Point its `models` folder at the one you already have — a directory junction on
Windows, a symlink elsewhere — rather than copying it.

Then start it on **port 8288**:

```bash
python main.py --port 8288 --listen 127.0.0.1 --disable-auto-launch --lowvram --async-offload 4
```

Studio looks for it there by default. Open the Reactive page and it will either
show the controls or tell you exactly which pack is missing.

---

## Two things that will bite you

### The node pack fails to import on Windows, silently

`ComfyUI_Yvann-Nodes` prints an emoji when it loads. On Windows the default
console encoding cannot represent it, so the module raises before registering a
single node — and ComfyUI reports this as one `WARNING` line among hundreds,
then carries on. The Reactive page will tell you the pack is missing while the
folder is plainly there.

Start the engine with UTF-8 forced:

```bash
PYTHONIOENCODING=utf-8 PYTHONUTF8=1 python main.py --port 8288 ...
```

On Windows PowerShell, set `$env:PYTHONIOENCODING = "utf-8"` first.

### Installing preprocessors can wreck your PyTorch

`comfyui_controlnet_aux` is the usual way to get depth and lineart
preprocessors. Its `requirements.txt` lists **torch and torchvision**, so
installing it can replace your PyTorch build — and a wrong build costs roughly
**5× the speed** across everything, silently. Studio's install guide has a whole
section on this for good reason.

Studio's video mode does not need it. See below.

---

## How video mode differs from the upstream workflow

The upstream video-to-video graph holds the source's structure with depth and
lineart ControlNets. Studio's video mode instead **encodes the source frames and
denoises them partially**, so the picture starts as your video rather than as
noise. The composition, framing and motion are already there.

This was deliberate: it gives the same structural hold without pulling in
`comfyui_controlnet_aux` and risking the PyTorch problem above.

---

## Why this cannot be done in Studio's own engine

Worth stating plainly, because it looks like it should be possible.

Studio's engine places a reference picture at a chosen frame with `LTXVAddGuide`.
That node **pins one picture at one frame index**. Measured across four guide
strengths, on and off the guide grid, at several densities, it never produced a
partial blend — a guide either replaces the frame or does nothing.

The reactive effect needs the opposite: two pictures conditioning **every**
frame at once, with the mix travelling in time with the audio. That is what
`Audio IPAdapter Transitions` does — it emits two image streams with
complementary per-frame weights into two IPAdapter batches simultaneously.

The difference is in kind, not in tuning. No setting of the Studio path produces
it, which is the entire reason this second engine exists.

---

## Credit

The technique, and the pack that implements it, are the work of **Yvann Barbot**
and **Lilia** — [ComfyUI_Yvann-Nodes](https://github.com/yvann-ba/ComfyUI_Yvann-Nodes).
The idea of placing image guides on detected audio peaks rather than on a fixed
stride is theirs, and it shaped how Studio's own beat-driven guide placement
works even where their code is not involved. If you use this, star their
repository.
