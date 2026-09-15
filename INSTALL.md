# Installing AIPLAY Studio

AIPLAY Studio writes and renders music on your own computer. No account, no
upload, no credits, no per-song cost.

## Start with YuE2 music only

**Same public repository, two launch modes—not a separate YuE2 edition.**
Use `Start YuE2 Music.cmd` for native music only; the full-suite launcher is
`Start AIPLAY Studio.cmd`. Downloading the app does not install every AI model.

For native lyric-to-song generation, install **Node.js 20+ and Studio**. You do
**not** need ComfyUI, Python, MiniMax or any image/video model.

1. Install [Node.js](https://nodejs.org), then download Studio from
   [Senzube4n/AIPLAY-Studio](https://github.com/Senzube4n/AIPLAY-Studio)
   using **Code → Download ZIP**, or [download the ZIP directly](https://github.com/Senzube4n/AIPLAY-Studio/archive/refs/heads/main.zip).
   Unblock the ZIP in Windows Properties before extracting if Windows requires it.
2. Double-click **`Start YuE2 Music.cmd`**. Or run these from the extracted folder:

   ```text
   npm ci --omit=dev
   npm run start:music
   ```

3. In **Models → Review Q4 / Q8 setup**, explicitly install **YuE2 GGUF Q4**: about **2.93 GB** for the
   Q4 model, F16 VAE and four sidecars, plus **833 MB** for the native runtime.
   Read the licence/source notices and wait for verification to complete.
4. Open **Music**, enter a style and nonempty lyrics, then press **Create**.

Keep the launcher window open. If another Studio is already running, wait for
its jobs to finish and close it before changing modes; both use port 4173 by default.

You can instead choose **Q8_0** in native setup: about **4.53 GB** of model files
plus the same runtime. Install either or both; shared files are reused. Select
Q4/Q8 on the Music page for each take. Q8 is higher precision, not a certified
audio-quality upgrade or a promise that it fits a particular GPU. Q4 stays default.

The native package targets Windows x64 and NVIDIA CUDA. It also requires a
current NVIDIA driver compatible with CUDA 13.3 and the
[Microsoft Visual C++ v14 x64 Redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist),
installed separately from Microsoft if missing. A tested 16 GB GPU is
not a certified minimum; 6 GB and 8 GB cards have not been validated. Use the
[native guide](docs/YUE2_GGUF.md) for the single measured benchmark, CoT/NAR
controls, source pins, licences and troubleshooting. Model/runtime downloads
require your action; no Python packages are installed by this path.

## The full Studio installation

The rest of this guide describes the original, ComfyUI-backed full suite. Its
Python, MiniMax, memory-tier and video instructions are **not** requirements for
the native music-only launcher.

For those features, Studio is a face on [ComfyUI](https://github.com/comfyanonymous/ComfyUI).
Studio runs the interface and the queue; ComfyUI runs the models. You install
ComfyUI yourself. That split is deliberate — ComfyUI is gigabytes of Python
before a single model weight, and it updates on its own schedule.

So the install is three things, in order: **Node.js**, then **ComfyUI**, then
**Studio**. Perhaps twenty minutes of your attention, and then a long download
you can leave running. Once it is done, the first song takes about five minutes:
measured on a 16 GB RTX 4070 Ti SUPER, 0.07 s for the launcher's checks, ~15 s
for the engine to start, and 264 s to render 4 min 22 s of audio from the caption
in [`examples/01-song/`](examples/01-song/).

**If you want the short version, the README's quickstart is it.** This file is
the long version: every failure that has actually happened here, and what to do
about it. [`examples/`](examples/) has a worked input-and-output pair for each
kind of thing Studio makes — a song, a clip, a picture built from two other
pictures, and a music-video production bible — so you can see what a real request
looks like before you write one.

Everything here is Windows, because that is what this was built and measured on.
Other platforms are covered at the end, honestly.

---

## Before you start: full Studio / MiniMax

| You need | Why |
|---|---|
| **An NVIDIA graphics card.** 6 GB of VRAM minimum, 12 GB recommended. | The music model's first stage requires CUDA. There is no CPU fallback — it stops with `Expected a cuda device, but got: cpu`. AMD, Intel and Apple graphics will not run this. |
| **16 GB of system RAM**, 32 GB recommended. | On smaller cards the model is streamed out of system RAM, so RAM does the work VRAM cannot. |
| **Free disk space.** 12 GB for music alone. About 62 GB if you eventually want every feature. | The weights are large and they live inside your ComfyUI folder. Studio shows you the free space on that drive before any download. |
| **Node.js 20 or newer.** | Studio's server is written in it. |
| **A ComfyUI install.** | Studio drives one. It does not contain one. |

All the timings in this guide were measured on an RTX 4070 Ti SUPER (16 GB),
32 GB of RAM, Windows 11. Your numbers will differ; the ratios should not.

---

## 1. Install Node.js

Get the **LTS** installer from [nodejs.org](https://nodejs.org). It is about
30 MB. Accept the defaults.

To check it worked, open a new Command Prompt and run:

```
node -v
```

You want `v20` or higher. Anything older and Studio will not start.

---

## 2. Install ComfyUI

You have to do this part yourself. Studio deliberately ships no copy of it.

### The easy route: the portable Windows build

Go to the [ComfyUI releases page](https://github.com/comfyanonymous/ComfyUI/releases/latest)
and download **`ComfyUI_windows_portable_nvidia.7z`** — about **2.1 GB**
(2,146,721,943 bytes for v0.34.0, checked 2026-09-02; the size moves with each
release, the file name does not). It is a `.7z` archive — Windows 11 24H2 opens
those natively, and older Windows needs [7-Zip](https://www.7-zip.org).

⚠ **There are four NVIDIA-ish files on that page and one of them is a trap.**
Take the plain `_nvidia` build. `ComfyUI_windows_portable_nvidia_cu126.7z` is
there for machines with old drivers, and an old CUDA build is the single failure
in this whole stack that does not announce itself — section 5 below is entirely
about it. It costs about **4.9x the speed of everything**, prints one line into a
log nobody reads, and otherwise works perfectly. The `_amd` and `_intel` builds
will not run the music model at all: its first stage requires CUDA.

Extract it somewhere with room. `D:\AI\` is a good habit: model weights are tens
of gigabytes and land *inside* this folder, and the C: drive is rarely where you
want them.

**This build comes with its own Python and its own PyTorch.** You do not install
Python. You do not install CUDA. You do not touch a virtual environment. That is
the whole appeal, and it is why this is the route to take if you have never done
this before.

Then run it once, on its own, before you go near Studio. Double-click
`run_nvidia_gpu.bat`. Wait for it to open a browser tab. Close it again.

That is not ceremony, and it is worth knowing what it buys you. The first launch
is where the graphics card, the driver and PyTorch either agree with each other
or do not — and a disagreement there is far easier to read in ComfyUI's own
window than through Studio's engine log afterwards. Some layouts also only *have*
a Python environment after their first run, which is the next thing Studio goes
looking for.

**After that, Studio finds it unaided.** `scripts/setup.mjs` searches your home
folder, Documents, Desktop, AppData and every drive from C: to F: for `ComfyUI`,
`AI`, `AI\ComfyUI`, `ComfyUI_windows_portable` and `StabilityMatrix`, plus one
level inside each — so `D:\AI\anything\ComfyUI` is found too. Anything holding
`ComfyUI\main.py` counts. It then records both the folder and **which Python
layout you have** in `%USERPROFILE%\.aiplay-studio\settings.json`. You are asked
once, ever, and only when the search comes back empty or ambiguous. Measured on
this machine, that whole step costs 70 ms on every later launch.

> **Nothing extra for the portable build.** It keeps its Python at
> `<your-folder>\python_embeded\python.exe` rather than in a `venv`, and Studio
> finds either. Earlier versions hard-coded the `venv` layout, so the portable
> build — the route recommended right here — needed a hand edit to a source file
> before the engine would start. It does not any more: first-run setup detects
> the layout and records it. Set `AIPLAY_PYTHON` if you keep yours somewhere
> unusual.

### The other route: install ComfyUI from source

If you already run ComfyUI from a `git clone` with a `venv` beside it, you are
done — that is exactly the layout Studio expects, and no edit is needed. If you
are choosing between the two and you are comfortable in a terminal, this route
needs no patch:

```
git clone https://github.com/comfyanonymous/ComfyUI.git
```

Then create a `venv` inside the folder that *contains* `ComfyUI`, and install
PyTorch and ComfyUI's requirements into it, following ComfyUI's own README. The
result should look like this, and Studio will find it unaided:

```
D:\AI\my-comfy\ComfyUI\main.py
D:\AI\my-comfy\venv\Scripts\python.exe
```

---

## 3. Get Studio and start it

Download the repository from
[github.com/Senzube4n/AIPLAY-Studio](https://github.com/Senzube4n/AIPLAY-Studio)
— either the zip, or:

```
git clone https://github.com/Senzube4n/AIPLAY-Studio.git
```

If you downloaded a zip, **right-click it → Properties → Unblock** before
extracting. Windows marks downloaded archives, and that mark can stop the
launcher from running.

Then double-click **`Start AIPLAY Studio.cmd`**.

It is a short batch file rather than an `.exe` on purpose: you can open it in
Notepad and read exactly what it is about to do, and most of what you will read
is comments explaining each check. Here is what that is.

1. **Checks for Node.js.** If it is missing, it says so and stops. Nothing else
   happens.
2. **Fetches three dependencies** on first run. That is the entire list — they
   pull nothing else in behind them — and it takes a few seconds:

   | Package | Licence | What it is for |
   | --- | --- | --- |
   | `ws` | MIT | WebSockets: following a ComfyUI job's progress, and the live panels in the app |
   | `three` | MIT | The 3D renderer for the avatar review viewer. Served to your browser from `node_modules`, not bundled |
   | `gltf-validator` | Apache-2.0 (Khronos) | The official glTF validator every uploaded avatar GLB is checked with |

   **All three are required to start.** None of them is an optional extra: the
   server imports the validator at the top of `server/mesh/avatar.js`, which
   `server/index.js` imports, so Studio does not boot without them. If you
   updated an older copy of this repository in place, delete `node_modules` and
   let the launcher fetch them again.
3. **Finds your ComfyUI.** It looks in your home folder, Documents, Desktop, and
   on every drive from C: to F: for `ComfyUI`, `AI`, `AI\ComfyUI`,
   `ComfyUI_windows_portable` and `StabilityMatrix` — and one level inside each
   of those, so `D:\AI\anything\ComfyUI` is found too. Anything containing
   `ComfyUI\main.py` counts. If it finds one, it uses it. If it finds several, it
   asks. If it finds none, it asks you to paste a path, and it accepts either the
   `ComfyUI` folder itself or the folder above it.
4. **Starts the app** and opens your browser at `http://127.0.0.1:4173`.

Leave the black window open. Closing it stops Studio.

Your answer to step 3 is saved to `%USERPROFILE%\.aiplay-studio\settings.json`,
so it is asked once, ever. Every later launch skips silently through the whole
sequence.

Behind the scenes, Studio now starts its own ComfyUI process on port **8266** and
keeps it running for as long as Studio is open. This is not a preference — one
long-lived process is what makes re-rolling a mix cost 15 seconds instead of 50.
Note that this is *your* ComfyUI, launched by Studio. Do not also run it yourself
at the same time: two copies will fight over the graphics card.

---

## 4. Get the models

Nothing downloads on its own. A first run must never begin with twelve gigabytes
of traffic you did not ask for.

Open the **Models** screen. Every capability is listed with its real byte count,
its licence, what it needs from your hardware, and one button. You choose what
you want and when.

<!-- MODELS:BEGIN -->
<!-- Generated by scripts/models_table.mjs from server/models.js. Do not edit by hand:
     the pre-commit hook fails if this block and the catalogue disagree. -->

| capability | download | licence | your card | your RAM |
|---|---|---|---|---|
| Music engine — MiniMax Music 3 | 11.9 GB | MiniMax Music3 Community | 6 GB (12 rec) | 16 GB (32 rec) |
| Music engine — YuE2 GGUF Q4 / optional Q8 (experimental) | ~2.9 GB | CC BY-NC 4.0 (weights) · Apache-2.0/MIT (native code) · NVIDIA CUDA runtime terms · ⚠ not for sale | Unknown (experimental) | Unknown (experimental) |
| Music engine — YuE2 3B | 7.8 GB | CC BY-NC 4.0 (weights) · ⚠ not for sale | 16 GB (24 rec) | 24 GB (32 rec) |
| Audio reference — MiniMax Music 3 DAV encoder | 306 MB | MiniMax Music3 Community · +pip | 4 GB (6 rec) | 8 GB (16 rec) |
| Cover art — FLUX.2 klein 4B | 12.5 GB | Apache-2.0 | 8 GB (12 rec) | 16 GB (32 rec) |
| Stem separation — HTDemucs (fine-tuned) | ~336 MB | MIT · pip | 4 GB (6 rec) | 8 GB (16 rec) |
| Video clips — MiniMax H3 (quantised) | 42.9 GB | MiniMax H3 Community · ⚠ territory | 16 GB (24 rec) | 32 GB (64 rec) |
| Video references — MiniMax H3 ref2va | 22.9 GB | MiniMax H3 Community · ⚠ territory | 16 GB (24 rec) | 32 GB (64 rec) |
| Background removal — BiRefNet | 444 MB | MIT | 4 GB (6 rec) | 8 GB (16 rec) |
| Images — Ideogram 4 (open 9B) | 25.2 GB | Ideogram Non-Commercial Model Agreement · ⚠ terms unread | 12 GB (16 rec) | 32 GB (32 rec) |
| Narration — TTS voices (Kokoro + Qwen3-TTS) | ~15.5 GB | Apache-2.0 (both engines) · pip | none (8 rec) | 16 GB (32 rec) |
| Sound effects — Stable Audio 3 Small SFX | 3.5 GB | Stability AI Community License | 6 GB (8 rec) | 16 GB (32 rec) |
| Images — Z-Image Turbo (Apache-2.0) | 14.6 GB | Apache-2.0 | 8 GB (12 rec) | 16 GB (32 rec) |
| Images — Z-Image base (Apache-2.0) | 14.6 GB | Apache-2.0 | 8 GB (12 rec) | 16 GB (32 rec) |
| Images — Anima (non-commercial model, sellable pictures) | 1.4 GB | CircleStone Labs Non-Commercial v1.2 | 6 GB (10 rec) | 16 GB (32 rec) |
| Video clips — LTX 2.5 (quantised) | 39.7 GB | LTX-2.x Community · ⚠ gated | 16 GB (16 rec) | 32 GB (32 rec) |
| Structural control — WAN 2.1 VACE 1.3B | 11.3 GB | Apache-2.0 | 8 GB (16 rec) | 16 GB (32 rec) |
| Pose extraction — DWPose (TorchScript) | 353 MB | Split: Apache-2.0 + terms unread · ⚠ terms unread | 4 GB (6 rec) | 8 GB (16 rec) |
| 3D mesh from a picture — TripoSG 1.5B | 7.9 GB | MIT | 4 GB (12 rec) | 16 GB (32 rec) |
| Skeleton and skin for a mesh — UniRig | 5.8 GB | MIT | 4 GB (8 rec) | 8 GB (16 rec) |
| Timed lyrics — Whisper large-v3 | ~3.1 GB | MIT · pip | 4 GB (6 rec) | 8 GB (16 rec) |
| Smooth motion — RIFE 4.26 | 22.7 MB | MIT | 4 GB (6 rec) | 8 GB (16 rec) |
| Upscale — Real-ESRGAN 2x | 67.1 MB | BSD-3-Clause | 4 GB (8 rec) | 16 GB (32 rec) |

23 capabilities. **Choose one music engine** and install the runtime and models for the features you want. Native YuE2 music-only does not require MiniMax, ComfyUI or Python. Hardware figures are capability-specific guidance, not a guarantee; an experimental Unknown means no minimum has been established. Streaming support and memory measurements from other engines must not be applied to native GGUF.

⚠ **territory** — **MiniMax H3 (quantised) and MiniMax H3 ref2va.** MiniMax grants H3 rights only inside its Applicable Territory, which excludes the EU, the UK, the Republic of Korea and the United States of America. If you are in one of those places you may not use these weights — and §V.4 says the same about anything they generate. AIPLAY Studio does not host them — the download goes straight to the publisher, and the licence is between you and MiniMax. Studio treats this as a blocking acknowledgement and refuses the download without it.

⚠ **gated** — **LTX 2.5 (quantised).** The repository is access-gated, so the built-in downloader cannot fetch it — it has no token and deliberately nowhere to keep one. Accept the licence on the model page, then in the ComfyUI python environment run `hf auth login` followed by `python scripts/fetch_ltx25.py`. About 40 GB. Licence and access: https://huggingface.co/Lightricks/LTX-2.5

⚠ **terms unread** — **Ideogram 4 (open 9B)** — https://huggingface.co/ideogram-ai/ideogram-4-fp8/blob/main/LICENSE.md

The Ideogram Non-Commercial Model Agreement is behind a gate: the URL above returns HTTP 401 to an anonymous request (checked 2026-08-27) and no copy of the text has been read here. The name says non-commercial; every other non-commercial licence in this catalogue restricts the MODEL and leaves the output alone — but Ideogram's may not, and Studio will not guess in either direction. Accept the agreement on the model page, read §-by-§, and decide. If you need a settled answer today, FLUX.2 klein 4B is Apache-2.0.

**DWPose (TorchScript)** — https://github.com/IDEA-Research/DWPose/blob/main/LICENSE

Half of this capability is verified and half is not, and the unread half is the one that makes the skeleton, so the row answers with the weaker of the two. The detector (yolox_l.torchscript.pt) is Apache-2.0: Megvii's own LICENSE was diffed against the canonical text and every operative clause is identical. The estimator (dw-ll_ucoco_384_bs5.torchscript.pt) has no readable terms at all — its redistributor's entire model card is 28 bytes of frontmatter with no LICENSE file, and so is the card of the yzd-v/DWPose repository usually named as its origin. The Apache-2.0 licence linked above, IDEA-Research's, is reached only by a filename match, and a filename is not a grant. In practice a skeleton is a measurement of a video you supplied, and the clip it goes on to steer carries the RENDERING model's terms — WAN 2.1 VACE's, which are settled Apache-2.0 — so this is narrower than it sounds. Read the chain yourself before relying on the skeleton itself being licensed. Separately, and binding whoever trained the model rather than whoever runs it: DWPose was trained on COCO-WholeBody and UBody, which carry dataset terms of their own.

⚠ **not for sale** — **YuE2 GGUF Q4 / optional Q8 (experimental).** Studio retains a conservative noncommercial / not-for-sale classification. This does not establish that every generated output is governed by the weights' licence. Review the source terms and output scope: https://huggingface.co/m-a-p/YuE2-3B/blob/main/LICENSE. **YuE2 3B.** Studio retains a conservative noncommercial / not-for-sale classification. This does not establish that every generated output is governed by the weights' licence. Review the source terms and output scope: https://huggingface.co/m-a-p/YuE2-3B/blob/main/LICENSE.

**pip, not a download** — Some capabilities are Python packages that fetch their own weights, so Studio has no file to verify and no button to press. They belong in a Python that is **not** ComfyUI's: installing them there can pull the torch build the engine depends on back down, which costs about 5× the speed of everything (INSTALL.md §5).

  · **MiniMax Music 3 DAV encoder** — `python -m pip install numpy torch av` (on top of the 306 MB of weights in the table)
  · **HTDemucs (fine-tuned)** — `python -m pip install demucs`
  · **TTS voices (Kokoro + Qwen3-TTS)** — kokoro + qwen-tts (sidecar venv at tts-venv/) — no single command; see the Models screen
  · **Whisper large-v3** — `python -m pip install faster-whisper`

`node scripts/extras_setup.mjs` prints the exact command for your machine, aimed at the interpreter Studio will actually invoke, and says which are already installed.

**selling what you make** — Model licences and rights in generated material are separate questions. The catalogue records them separately. 12 of 23 are classified as placing no licence conditions on generated material (FLUX.2 klein 4B, HTDemucs (fine-tuned), BiRefNet, TTS voices (Kokoro + Qwen3-TTS), Z-Image Turbo (Apache-2.0), Z-Image base (Apache-2.0), WAN 2.1 VACE 1.3B, TripoSG 1.5B, UniRig, Whisper large-v3, RIFE 4.26, Real-ESRGAN 2x). 7 say you may and attach conditions (MiniMax Music 3, MiniMax Music 3 DAV encoder, MiniMax H3 (quantised), MiniMax H3 ref2va, Stable Audio 3 Small SFX, Anima (non-commercial model, sellable pictures), LTX 2.5 (quantised)). 2 are conservatively classified noncommercial / not for sale; that label does not resolve every output's legal status. 2 — Ideogram 4 (open 9B), DWPose (TorchScript) — nobody here has read. For MiniMax Music 3: §3.1 — a commercial product or service that uses it must show “MiniMax-Music3” prominently in its interface. That is why the name sits in Studio's corner rather than on a credits page. The operative sentence is quoted verbatim in `server/models.js` and shown on the Models screen before you download anything.

**shared files** — 3 files are used by more than one capability, so picking two of those costs less than adding their rows — up to 8.7 GB less. `qwen_3_4b.safetensors` (8.0 GB) is shared by FLUX.2 klein 4B, Z-Image Turbo (Apache-2.0), Z-Image base (Apache-2.0); `flux2-vae.safetensors` (336 MB) is shared by FLUX.2 klein 4B, Ideogram 4 (open 9B); `ae.safetensors` (335 MB) is shared by Z-Image Turbo (Apache-2.0), Z-Image base (Apache-2.0). The Models screen quotes the deduplicated figure.

Studio hosts no weights and mirrors none: every download goes straight to the publisher, and the licence is between you and them.
<!-- MODELS:END -->

Some things worth knowing before you click:

- **Downloads resume.** A dropped connection three quarters of the way through a
  12 GB file does not cost you the file. The partial is written as `.part` and
  only moved into place when the size matches to the byte, so an interrupted
  download can never leave a truncated file that looks finished.
- **Studio hosts nothing.** Every download goes straight to the publisher on
  HuggingFace. The licence is between you and them.
- **The MiniMax music weights are already the smallest published.** There is no "small
  model" to switch to. Fitting a smaller card is done by streaming, not by
  shrinking — see section 6.
- **You do not have to work out which rows apply to you.** The Models screen
  reads your card with `nvidia-smi` and your system RAM, and puts one sentence at
  the top naming what to fetch for *that* machine, with the download size. On a
  16 GB card it says three models; on an 8 GB card it says two and explains, per
  row, why video is not among them. On a machine with no NVIDIA card it says so
  and refuses to recommend anything, rather than guessing.
- **The pip half has its own script.** Some capabilities need a Python package
  that Studio cannot fetch — two of them ARE the package rather than a file, and
  audio reference wants one on top of its weights. The table above names each
  one and the line to type. They must go in a Python that is **not** ComfyUI's;
  section 5 is why. Rather than working out which interpreter that is, run:

  ```
  node scripts/extras_setup.mjs
  ```

  It prints the exact command for each one with your own interpreter path
  already in it, read from the same `settings.json` that first-run setup wrote,
  and says which are already installed. It also prints the two LTX commands,
  which are the one case that *does* want ComfyUI's Python — that is where
  `huggingface_hub` lives.

  **Why audio reference is on that list at all.** Starting a render from a real
  song means encoding that song into the model's latent space, and ComfyUI will
  not do it — `comfy/sd.py` raises *"MiniMax Music3 DAV cannot encode audio"*.
  Studio does it outside ComfyUI with `scripts/dav_encode.py`, which is why it
  wants `numpy`, `torch` and `av` in the system Python. Everything after the
  encode is stock ComfyUI: the encoder writes an ordinary `.latent` file and
  ComfyUI's own `LoadLatent` reads it, so no custom nodes are involved at any
  point. If the packages are missing, the Models screen says so before you try
  to use it.

**Structural control needs two things that are not weights.** The Control card
on a storyboard steers a render with a real video (WAN 2.1 VACE), and neither of
these is downloadable from the Models screen:

- **ffprobe, for the gate.** A control clip must be exactly 1280x704, exactly
  24.000 fps and at least 121 frames, and all three fail *silently* — the wrong
  size is centre-cropped, a short clip is padded with flat grey, and the frame
  rate is never read at all. Studio measures the clip before it spends anything,
  and it ships without ffmpeg by promise, so **no ffprobe is an answer, not a
  crash**: the card refuses with a sentence saying the measurement could not be
  made. Put `ffprobe` on PATH, or point `AIPLAY_FFPROBE` at one. It never passes
  a clip it could not measure.
- **`comfyui_controlnet_aux`, for the two pose modes only.** The DWPose skeleton
  path needs that node pack (Apache-2.0) in your ComfyUI. The camera mode needs
  nothing beyond the VACE weights. ⚠ Installing ControlNet preprocessors is
  exactly the thing section 5 is about — some of them replace your PyTorch build
  and cost about 5× the speed of everything. Read that section first.

Models land in `<your-comfy-folder>\ComfyUI\models\` under `diffusion_models`,
`text_encoders`, `vae` and `loras` — ordinary ComfyUI locations. If you already
have any of these files, Studio finds them and does not download them again.

---

## 5. The one thing that can silently ruin this: your PyTorch build

Read this section even if everything is working. It is short.

**Normally you do not think about PyTorch or CUDA at all.** The portable ComfyUI
build ships a working Python and a working PyTorch, and that is the end of it.

But there is one failure that does not announce itself. The music model uses
fused int8 CUDA kernels. Those kernels need PyTorch built against **CUDA 13.0 or
newer**. On an older build — a `cu128` one, for instance — ComfyUI quietly
disables its fused backend, prints a single line into a log nobody reads, and
carries on working perfectly.

Just **4.9 times slower**. No error. No warning in the interface. A three-minute
song that should take five minutes takes twenty-four, and you conclude that this
is simply how fast local music generation is.

So Studio reads ComfyUI's startup output and checks for exactly this.

### What good looks like

Open `http://127.0.0.1:4173/api/status` in your browser. You want:

```
"backend": { "ok": true, "torch": "2.13.0+cu130", "device": "cuda:0 NVIDIA GeForce RTX 4070 Ti SUPER" }
```

The parts that matter are `"ok": true` and a torch version ending in **`+cu130`**
or higher. In the app itself, good looks like the engine line reading
**RUNNING LOCALLY** with no red banner beneath it.

You can also read it straight from the engine log:

```
findstr /i "pytorch version" "%USERPROFILE%\.aiplay-studio\comfy.log"
```

And the kernels themselves:

```
findstr /i "comfy_kitchen" "%USERPROFILE%\.aiplay-studio\comfy.log"
```

A healthy line mentions `comfy_kitchen backend cuda` and says `'disabled': False`.
If it says `'disabled': True`, the fused kernels are off and you are on the slow
path.

### What bad looks like, and how to fix it

Studio shows a red banner: *"This install is running about 5× slower than it
should."* It names the torch version it found.

Update your NVIDIA driver first — a CUDA 13 build needs a recent one. Then
reinstall PyTorch into **the Python that ComfyUI uses**, not any other Python on
your machine. For a portable install:

```
D:\AI\ComfyUI_windows_portable\python_embeded\python.exe -m pip install --upgrade torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu130
```

For a venv install:

```
D:\AI\my-comfy\venv\Scripts\python.exe -m pip install --upgrade torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu130
```

Adjust the path to your own folder. It is a few gigabytes. Restart Studio
afterwards and check `/api/status` again.

### Why Studio uses three different Pythons

This looks like untidiness and is the opposite. ComfyUI's Python must stay on the
CUDA 13 build. If you let `pip` install `demucs` or `faster-whisper` in there,
their own requirements can quietly pull PyTorch back down to an older CUDA build,
and you get the slow app with no error and no obvious cause. So the engine keeps
its Python, and the extras use their own. Never `pip install` anything into
ComfyUI's environment unless you know it does not touch torch.

---

## 6. What can my machine run?

**The app answers this for your actual machine.** The Models screen reads your
card and your RAM and gives each of the seventeen capabilities one of four
verdicts — fits, runs slower by streaming, below the minimum, or "cannot tell"
when there is no NVIDIA card to read — with the reason in each case, and one line
at the top naming what to fetch. The table in this section is the coarse version
of the same arithmetic, kept because it is the shape of the answer rather than
the answer.

The full-suite MiniMax weights discussed here are already the smallest published versions. So the way
to fit a smaller card is not a smaller model — it is keeping less of the model in
VRAM and streaming the rest from system RAM. That is what the **graphics memory**
setting does. Studio picks a tier automatically; you can override it, and
changing it restarts the engine.

| Your VRAM | MiniMax music | Cover art | Stems | Timed lyrics | Video |
|---|---|---|---|---|---|
| **6 GB** | Yes, slowly. Streams almost everything from RAM. ⚠ Unproven on real 6 GB hardware — it was simulated on a 16 GB card. Tell us how it goes. | No | Yes | Yes | No |
| **8 GB** | Yes. Roughly 2× slower than a large card. | Yes | Yes | Yes | No |
| **12 GB** | Yes. Verified bit-identical output to the fast path. | Yes | Yes | Yes | No |
| **16 GB+** | Yes, fastest. The model stays resident. | Yes | Yes | Yes | Yes |

System RAM matters too: 16 GB minimum for music, 32 GB recommended, and 32 GB
minimum if you want video.

Nothing ever competes with music. Cover art, stems and lyrics run only when the
queue is empty, and a new song preempts them. Video and cover art are never
resident alongside the music engine on a 16 GB card, which is exactly why they
wait for idle time.

### What "fast" actually means, measured

| | On a 16 GB RTX 4070 Ti SUPER |
|---|---|
| Engine cold start | about 15 s |
| A fresh song | 39 s of audio in 65 s — **1.66× realtime** |
| Re-rolling the mix | **50 s → 15 s**, because the composition stage is cached |
| A cover | about 3 s |
| Stems for a 30 s track | about 12 s |
| Timed lyrics for a 2.5 minute song | about 36 s |
| A 5-second video clip, LTX 2.5 at 1280×704 | 121 s |
| The same clip, MiniMax H3 at 1344×768 | 308 s at 8 steps, 660 s at 20 |

---

## 7. When it goes wrong

Six things go wrong on a first run. These are all of them.

### "Node.js is not installed"

The launcher stops before doing anything else. Install the LTS build from
[nodejs.org](https://nodejs.org), then close and reopen the launcher — a
Command Prompt that was already open will not see the new install.

### It cannot find ComfyUI, or finds it and says there is no Python inside

If it says *"Found ComfyUI at ..., but no python environment inside it"*, run
ComfyUI once on its own first. That first launch is what creates the Python
environment; before it, there is nothing to find.

If it found nothing at all, paste the full path when it asks. Either the
`ComfyUI` folder or the folder above it is accepted. If the window closed too
fast to type into, write the path yourself into
`%USERPROFILE%\.aiplay-studio\settings.json`:

```
{ "rig": "D:\\AI\\my-comfy" }
```

Note the doubled backslashes — that file is JSON, and single backslashes make it
unreadable. `rig` is the folder that *contains* `ComfyUI`, not `ComfyUI` itself.

### The interface opens but the engine never becomes ready

The engine line stays on **STARTING…**, and after three minutes you get
*"ComfyUI did not become ready in time"*. In order of likelihood:

1. **You are running ComfyUI yourself at the same time.** Close it. Studio starts
   and owns its own copy on port 8266, and two of them fight over the card.
2. **Studio recorded a Python that is no longer there** — the ComfyUI folder was
   moved, or reinstalled into a different layout. Delete the `python` line from
   `%USERPROFILE%\.aiplay-studio\settings.json` and start Studio again; setup
   re-detects it. (Older versions hard-coded the `venv` layout and needed a hand
   edit to a source file on portable installs. That is fixed — first-run setup
   detects `python_embeded\python.exe` and `venv\Scripts\python.exe` alike — so
   if you are following an older guide that tells you to edit `config.js`, do
   not.)
3. **It is genuinely just slow.** The first load reads about 12 GB off disk. On a
   mechanical drive that can approach the three-minute limit.

The engine's own output is the truth here, and it is all in one file:

```
notepad "%USERPROFILE%\.aiplay-studio\comfy.log"
```

Read the last twenty lines. A Python that does not exist, a driver that is too
old, and a model file that is missing all say so plainly.

### A red banner says the install is 5× slower than it should be

Your PyTorch is too old for the model's fused kernels. This is covered in full in
section 5 — update the NVIDIA driver, then reinstall torch from the `cu130`
index into ComfyUI's own Python, then restart Studio.

Do not ignore this banner. It is the difference between the app being fast and
the app being pointless, and everything else will look normal.

### A render fails with an error about a missing model file

Two possibilities.

You have not downloaded that capability yet — open the **Models** screen and
check. Studio tries hard to catch this before you render, but a graph edited by
hand can still ask for something absent.

Or a download was interrupted and never completed. Studio checks every file
against its exact expected byte count, so a partial file reads as missing rather
than as broken — which is the correct behaviour but does look odd if you watched
the progress bar reach 90%. Press the download button again; it resumes from
where it stopped.

### Audio reference says the DAV encoder weights were not found

The message lists every folder it looked in. Usually it means the **Audio
reference** entry on the Models screen has not been downloaded yet — its size is
in the table in section 4, which is generated from the catalogue.

If you already have those weights somewhere — a HuggingFace cache left by another
tool, say — point at them instead of downloading a second copy:

```
set AIPLAY_DAV_ENCODER=D:\path\to\diffusion_pytorch_model.safetensors
```

Studio checks your HuggingFace cache on its own too, honouring `HF_HOME` and
`HUGGINGFACE_HUB_CACHE`, so a copy pulled by another tool is usually found
without you doing anything.

If instead the error mentions `av`, `numpy` or `torch`, it is the packages rather
than the weights — see the pip line in section 4.

---

## Optional: the audio-reactive engine

Nothing above is affected by this, and you do not need it.

The Reactive page renders on a **second ComfyUI** that you set up yourself,
because the node pack behind it is GPL-3.0 and cannot ship inside an Apache-2.0
application. It is a separate install with its own node packs and about 8.7 GB
of additional weights, and Studio downloads none of it.

If you never set it up, the page tells you so and everything else works exactly
as described above.

Two traps worth knowing before you start:

- The pack fails to import on Windows unless UTF-8 is forced, and reports it as
  one warning line rather than an error.
- Installing the usual ControlNet preprocessors can replace your PyTorch build,
  which costs about 5× the speed of everything — see section 5.

---

## Other platforms

Studio is tested on Windows only, and it is honest to say the other platforms are
untested rather than unsupported.

**macOS is out.** Not a packaging problem — the music model's first stage
requires CUDA, and Apple silicon has none.

**Linux with an NVIDIA card should work**, with two edits. There is no
`Start AIPLAY Studio.cmd`, so run setup and the server yourself:

```
node scripts/setup.mjs
```

```
npm install --omit=dev && npm start
```

And `server/config.js` line 47 points at a Windows path. Change it to your venv's
actual Python:

```
  python: path.join(RIG, "venv", "bin", "python"),
```

Everything else — the model catalogue, the download logic, the backend check — is
platform-neutral. If you get it running, the project would like to hear about it.

---

## Where things live

| | |
|---|---|
| Your settings | `%USERPROFILE%\.aiplay-studio\settings.json` |
| The engine's log | `%USERPROFILE%\.aiplay-studio\comfy.log` |
| Finished songs | `<your-comfy-folder>\ComfyUI\output\` by default, changeable in Settings → Folders |
| Model weights | `<your-comfy-folder>\ComfyUI\models\` |
| The interface | `http://127.0.0.1:4173` |
| The engine | an unpublished loopback port Studio picks fresh at every start |

Folders and the interface port can be overridden with `AIPLAY_UI_PORT`,
`AIPLAY_RIG` and `AIPLAY_OUTPUT`.

**The engine's port is deliberately not a fixed number.** Studio binds ComfyUI to
a loopback port it chooses at each start and does not publish, so nothing else on
the machine can find it by guessing — which is what a second copy of Studio, or a
script with an old number baked into it, actually does. Every render then goes
through Studio's own door and is written down: the graph, the prompt, the seeds,
the model files, the wall time and the digest of every file produced. See
[docs/ENGINE_DOOR.md](docs/ENGINE_DOOR.md), and the **Engine** screen, which shows
the same record and can reveal the port when you genuinely need ComfyUI's own web
interface.

`AIPLAY_COMFY_PORT` still pins the engine to a fixed port, for an install that
already had to. It is a **compatibility path with a named cost**, not a
recommended setting: on a pinned port anything else on the machine can drive the
engine directly, and those renders will not appear in the ledger, the clip
library or any project. Studio says so in the log and on the Engine screen rather
than honouring it silently. Unset it to get an unpublished port back.

---

## One last thing

The four pipelines Studio actually submits are in
[`workflows/`](workflows/) as ordinary ComfyUI JSON. Drag one onto the ComfyUI
canvas and you can see and change every value in it.

Those values are not ComfyUI's defaults. They were arrived at by measurement, and
the scripts that measured them ship in `scripts/` so you can re-run them. That
tuning is most of what Studio knows, and it is yours the moment you open the
files.

Studio itself is Apache-2.0. The model weights are not — each carries its own
licence, stated on the Models screen before you download it.
