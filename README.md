<p align="center">
  <img src="GitHubAssets/AIPLAY_banner_4_brand.png" alt="AIPLAY Studio: a creative studio that lives on your computer." width="100%">
</p>

<h1 align="center">AIPLAY Studio</h1>

<p align="center">
  <b>Write a song, draw the cover, cut the video and mix it, all on your own machine.</b><br>
  No account. No credits. No upload.
</p>

<p align="center">
  <a href="https://github.com/Senzube4n/AIPLAY-Studio/archive/refs/heads/main.zip"><b>Download</b></a>
  &nbsp;·&nbsp; <a href="#yue2-music-only-quickstart">Quickstart</a>
  &nbsp;·&nbsp; <a href="INSTALL.md">Full install</a>
  &nbsp;·&nbsp; <a href="docs/YUE2_GGUF.md">YuE2 guide</a>
  &nbsp;·&nbsp; <a href="docs/DEEP_DIVE.md">How it works</a>
</p>

<p align="center">
  Runs on <b>NVIDIA</b>, <b>AMD</b>, <b>Intel Arc</b> or just your <b>CPU</b>.
</p>

---

AIPLAY Studio is a local creative suite built around music. Type a few lines of
lyrics and a style, press **Create**, and a finished song lands in your library.
From there the same app can draw its cover art, turn it into a music video, and
mix it in a real DAW.

Everything runs on your own computer. Nothing is uploaded, nothing is billed,
and you never need an account.

<p align="center">
  <img src="GitHubAssets/AIPLAY_banner_1_make-music.png" alt="The Music screen: lyrics, styles and a library of finished songs." width="100%">
</p>

**Only want music? You are in the right place.** Music only is a launch mode of
this same app, **not a separate GitHub repository or edition**. To make songs
with native YuE2 GGUF you do not need ComfyUI, Python, MiniMax or any image and
video models.

## YuE2 music-only quickstart

Works on **Windows x64 with any card**: setup picks audio.cpp's CUDA build on
NVIDIA, its official Vulkan build on AMD and Intel, and its CPU build when there
is no graphics card at all.

**You need:** [Node.js 20 or newer](https://nodejs.org). On NVIDIA you also need
a CUDA 13.3-compatible driver and, if it is missing, the
[Microsoft Visual C++ v14 x64 Redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist).
The Vulkan and CPU builds bring their own.

1. **Download and extract** the [Studio ZIP](https://github.com/Senzube4n/AIPLAY-Studio/archive/refs/heads/main.zip).
   Open the extracted folder, not the ZIP viewer.
2. **Double-click `AIPLAY Studio.exe`** (or `AIPLAY Studio.cmd`) and choose
   **Music only**. The first run installs what the app needs, then opens Studio
   in your browser. Keep the launcher running while you work.
3. Go to **Models → Review Q4 / Q8 setup** and pick **Q4_0** (smaller, the
   default) or **Q8_0** (optional, higher precision). Read the size and licence,
   accept if you agree, and click **Install**.
4. Open **Music**, write your **Lyrics** and **Style**, and click **Create**.
   Finished songs appear as WAV files in the **Library**.

**What gets downloaded?** About **2.93 GB** of model files for Q4 (**4.53 GB**
for Q8), plus **833 MB** for the shared native runtime. Nothing downloads until
you take an explicit action: picking a model or asking for a song never starts
a download on its own. Q8 has not been benchmarked or listening-tested in
Studio yet, so treat it as optional rather than a guaranteed upgrade.

**Prefer a terminal?** In the extracted folder:

```text
npm ci --omit=dev
npm run start:music
```

**Already running Studio?** Update the same checkout. Let running songs finish
and close Studio before switching modes, because both use
`http://127.0.0.1:4173`. Choose **Full Studio** in the launcher when you want
the whole suite.

**Good to know:** one Q4 test on an RTX 4070 Ti SUPER 16 GB made 49.4 seconds
of audio in 22.0 seconds. A minimum amount of graphics memory has not been
certified yet. The YuE2 weights are **CC BY-NC 4.0**, so read the
[hardware notes, troubleshooting and licence details](docs/YUE2_GGUF.md) before
you publish or sell anything. Studio labels YuE2 output noncommercial to be
safe; that label is not a ruling on every song you make.

## What you can make

<p align="center">
  <img src="GitHubAssets/AIPLAY_banner_2_song-to-video.png" alt="One studio: from a song on the Music screen to a video on the Studio timeline." width="100%">
</p>

It started as a music generator and grew one piece at a time, because a song
wants a cover, a cover wants a video, and all of it wants a mixer.

| | |
|---|---|
| 🎵 **Music** | Songs from lyrics and a style, or instrumentals from a structure. Extend a take, replace a section, re-roll the mix, hum a melody, or cover a song with its tune kept. Engines: YuE2 (native GGUF or through ComfyUI), MiniMax Music 3, and [ACE-Step 1.5](docs/DEEP_DIVE.md#ace-step-15) with LoRAs and covers. |
| 💬 **Chat and Simple mode** | Describe the song you want in plain words and let the assistant write the lyrics, style and title for you. |
| ✨ **Enhance and galleries** | One click turns a rough style line or lyrics into a fuller one. Save the ones you like and reuse them later. |
| 🎰 **Genre Roulette** | Spin six reels (genre, vocals, instrument, mood, rhythm, production) when you have no idea where to start. |
| 🖼️ **Images** | Cover art drawn automatically, plus a choice of image engines (FLUX.2 klein, Z-Image, Krea 2, Anima, Ideogram 4 or your own checkpoint) and a full image editor. |
| 🎬 **Video** | Clips under a finished track, a music-video workflow from song to final cut, and a camera you can block in Blender for the render to follow. |
| 🌀 **Reactive** | Pictures that move with a song: cut on the beat, pulse with the bass, flash on the hits. Runs on any card, AMD included. |
| ⚭ **Collab** | Make an episode with friends, or lend one of them a scene to render. A project travels as one sealed file addressed to one person: nothing on the screen opens a connection, and there is no server in it. |
| ✂️ **Edit and mix** | A timeline editor, an After Effects-style compositor, and a DAW with a piano roll, mixer and mastering. |
| 📚 **More** | An audiobook workflow, stems, timed lyrics, 3D models from a picture, overnight batch runs, and a little game for while you wait. |

The [deep dive](docs/DEEP_DIVE.md) covers every one of these in detail, and
[`examples/`](examples/) shows real requests next to what they produced.

## Chat, Simple mode and Enhance

**Simple mode** is the easiest way in: describe your idea ("a slow synthwave
song about driving home at 3am") and the assistant writes the lyrics, the style
and a title, ready for **Create**. The **Chat** screen does the same across the
whole studio, and asks before it spends any time on your graphics card.

Both can use a **local model** on your own card (Qwen3 through ComfyUI) or an
**API model** you connect yourself (Claude, ChatGPT or any OpenAI-compatible
server). **✨ Enhance** under the Styles and Lyrics boxes uses the same choice,
set in **Settings → Enhance**. A local model waits while the card is busy with a
render; an API model never needs to.

## Why this rather than a cloud tool

<p align="center">
  <img src="GitHubAssets/AIPLAY_banner_3_no-account.png" alt="No account. No credits. No upload. Everything runs on your own graphics card." width="100%">
</p>

- **Nothing leaves your machine.** No account, no key, no credits. The only
  network use is downloading models (straight from their publishers), the
  Community screen, and API mode if you switch it on yourself.
- **Every render is recorded.** The model, prompt, seed and settings behind
  each file go into a tamper-evident log *before* the render starts, so you can
  always tell what made a file.
- **It checks before it spends.** A render that would fail is refused up front,
  with the reason, instead of after half an hour on your graphics card.
- **Licences are read, not guessed.** Each model shows what its licence says
  about the model and, separately, about what you make with it, so you know
  whether you can sell a song or picture before you render it.
- **An agent can drive all of it.** 266 MCP tools cover the whole studio, so an
  assistant like Claude can run it while you watch.

The full reasoning is in [the deep dive](docs/DEEP_DIVE.md#why-this-rather-than-a-cloud-tool-in-full).

## NVIDIA, AMD, Intel or CPU

**No ComfyUI on this PC? Studio installs one.** The launcher asks what to run
on (**NVIDIA**, **AMD**, **Intel Arc** or **CPU only**, with your card marked)
and installs a private ComfyUI into `%USERPROFILE%\.aiplay-studio\engine`. It
never touches anything else on the PC, and an existing ComfyUI is never
modified. If a step fails, the partial install is removed and the launcher
shows you the exact error.

**Already have ComfyUI?** Studio finds it (portable, from source, or ComfyUI
Desktop) and launches it the way its own launcher does. It never installs or
replaces torch, CUDA or ROCm.

| your card | what works |
|---|---|
| **NVIDIA** | Everything. Use the portable `ComfyUI_windows_portable_nvidia.7z` (not `_cu126`) or a source install with a `+cu130` torch. |
| **AMD Radeon** | Native YuE2 GGUF (Vulkan), YuE2, ACE-Step 1.5, MiniMax Music 3 and images through ComfyUI, Reactive, the DAW and compositor. MiniMax needs Studio's default launch flags (below). The 3D stack needs CUDA. |
| **Intel Arc** | Native YuE2 GGUF (Vulkan), and ComfyUI with an XPU torch. |
| **No GPU** | Native YuE2 GGUF on the CPU build, the DAW and the compositor. [API mode](docs/DEEP_DIVE.md#no-gpu-api-mode) can drive a hosted MiniMax Music 3 with your own key. |

**Default ComfyUI launch flags:** `--use-pytorch-cross-attention --disable-cuda-graphs`.
They fixed MiniMax Music 3's broken audio on an RX 9060 XT, and they replace any other
attention flag your install uses (two attention flags stop ComfyUI starting). Change them
under **Advanced** in the launcher.

Measured AMD results, launch flags and the details of every layout are in
[the hardware section of the deep dive](docs/DEEP_DIVE.md#hardware-nvidia-amd-intel-and-cpu).

## Full Studio: your first song

For the whole suite (MiniMax Music 3, images, video and the rest):

1. Install **[Node.js](https://nodejs.org)** (the LTS installer).
2. Have a **ComfyUI**, or let the launcher install one for you. See
   [Getting a ComfyUI](docs/DEEP_DIVE.md#getting-a-comfyui).
3. Double-click **`AIPLAY Studio.exe`** and choose **Full Studio**. It fetches
   its npm packages once and opens Studio in your browser.
4. Open **Models**. It reads your card and memory and suggests what is worth
   installing on *your* machine, with the size and licence of each. Nothing
   downloads until you press a button.
5. Open **Music**, write lyrics and a style, and press **Create**.

On an RTX 4070 Ti SUPER, a MiniMax song takes roughly real time: about four
and a half minutes for four and a half minutes of audio. A shorter lyric means
a shorter wait. Want a caption to start from? Try
[`examples/01-song`](examples/01-song/).

[INSTALL.md](INSTALL.md) has the complete walkthrough and troubleshooting.

## The models

Nothing downloads on its own. The **Models** screen reads your card and memory,
tells you what your machine can run, and fetches what you ask for, resuming if
the connection drops and checking every file when it arrives.

<details>
<summary><b>Every model, with its size, licence and hardware needs</b></summary>

<!-- MODELS:BEGIN -->
<!-- Generated by scripts/models_table.mjs from server/models.js. Do not edit by hand:
     the pre-commit hook fails if this block and the catalogue disagree. -->

| capability | download | licence | your card | your RAM |
|---|---|---|---|---|
| Music engine — MiniMax Music 3 | 11.9 GB | MiniMax Music3 Community | 6 GB (12 rec) | 16 GB (32 rec) |
| Music engine — YuE2 GGUF Q4 / optional Q8 (experimental) | ~2.9 GB | CC BY-NC 4.0 (weights) · Apache-2.0/MIT (native code) · NVIDIA CUDA runtime terms on NVIDIA only · ⚠ not for sale | Unknown (experimental) | Unknown (experimental) |
| Cover — SheetSage2 song-to-score (ComfyUI) | 1.4 GB | CC BY-NC 4.0 (weights) · ⚠ not for sale | 4 GB (8 rec) | 8 GB (16 rec) |
| Video clips — TaoMate 3-step LoRA (H3) | 2.5 GB | MiniMax H3 Community Licence (derived from H3) · ⚠ territory | 12 GB (16 rec) | 16 GB (32 rec) |
| Video clips — TaoMate 3-step, rank-19 average (H3, small) | 182 MB | MiniMax H3 Community Licence (derived from H3) · ⚠ territory | 12 GB (16 rec) | 16 GB (32 rec) |
| H3 conditioning bridge — BUNNY (action logic) | 22.0 MB | MiniMax H3 Community Licence (derived from H3) · ⚠ territory | none (0 rec) | 0 GB (0 rec) |
| H3 conditioning bridge — Semantic Bridge v1 | 11.0 MB | MiniMax H3 Community Licence (derived from H3) · ⚠ territory | none (0 rec) | 0 GB (0 rec) |
| Music engine — YuE2 3B for ComfyUI (int8) | 4.0 GB | CC BY-NC 4.0 (weights) · ⚠ not for sale | 8 GB (12 rec) | 16 GB (32 rec) |
| YuE2 instrumental planner LoRA (ComfyUI) | 213 MB | CC BY-NC 4.0 (weights, derived from YuE2-3B) · ⚠ not for sale | 8 GB (12 rec) | 16 GB (32 rec) |
| YuE2 real-audio NAR LoRA (ComfyUI) | 108 MB | CC BY-NC 4.0 (weights, derived from YuE2-3B) · ⚠ not for sale | 8 GB (12 rec) | 16 GB (32 rec) |
| YuE2 real-audio tokenizer (head + MERT-v2-FullSong) | 2.7 GB | CC BY-NC 4.0 (head from YuE2-3B; MERT-v2-FullSong) · ⚠ not for sale | none (4 rec) | 8 GB (16 rec) |
| Music engine — ACE-Step 1.5 turbo (ComfyUI) | 14.7 GB | MIT (ACE-Step's LICENSE; the ComfyUI repack's card tags apache-2.0 with no licence text) | 8 GB (16 rec) | 16 GB (32 rec) |
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
| Images — Krea 2 Turbo (community licence) | 19.0 GB | Krea 2 Community License Agreement | 12 GB (16 rec) | 32 GB (48 rec) |
| Images — Z-Image base (Apache-2.0) | 14.6 GB | Apache-2.0 | 8 GB (12 rec) | 16 GB (32 rec) |
| Images — Anima (non-commercial model, sellable pictures) | 1.4 GB | CircleStone Labs Non-Commercial v1.2 | 6 GB (10 rec) | 16 GB (32 rec) |
| Video clips — LTX 2.5 (quantised) | 39.7 GB | LTX-2.x Community · ⚠ gated | 16 GB (16 rec) | 32 GB (32 rec) |
| Structural control — WAN 2.1 VACE 1.3B | 11.3 GB | Apache-2.0 | 8 GB (16 rec) | 16 GB (32 rec) |
| Pose extraction — DWPose (TorchScript) | 353 MB | Split: Apache-2.0 + terms unread · ⚠ terms unread | 4 GB (6 rec) | 8 GB (16 rec) |
| Depth extraction — Depth Anything V2 Small | 99.2 MB | Apache-2.0 | 2 GB (4 rec) | 8 GB (16 rec) |
| Depth extraction — Depth Anything V2 Large (non-commercial) | 1.3 GB | CC-BY-NC-4.0 · ⚠ not for sale | 4 GB (6 rec) | 8 GB (16 rec) |
| Motion module — AnimateDiff v3 (SD1.5) | 1.8 GB | Apache-2.0 | 6 GB (12 rec) | 16 GB (32 rec) |
| Source on the hits — SparseCtrl RGB (AnimateDiff v3) | 2.0 GB | Apache-2.0 | 8 GB (12 rec) | 16 GB (32 rec) |
| SD1.5 checkpoint — DreamShaper 8 (the Motion look's painter) | 2.1 GB | CreativeML Open RAIL-M | 4 GB (8 rec) | 8 GB (16 rec) |
| ControlNet v1.1 — depth and line art (SD1.5, fp16) | 1.4 GB | OpenRAIL | 4 GB (8 rec) | 8 GB (16 rec) |
| Picture references — IP-Adapter Plus (SD1.5) | 98.2 MB | Apache-2.0 | 4 GB (8 rec) | 8 GB (16 rec) |
| CLIP vision tower — ViT-H/14 (LAION-2B) | 2.5 GB | MIT | 4 GB (8 rec) | 8 GB (16 rec) |
| 3D mesh from a picture — TripoSG 1.5B | 7.9 GB | MIT | 4 GB (12 rec) | 16 GB (32 rec) |
| Skeleton and skin for a mesh — UniRig | 5.8 GB | MIT | 4 GB (8 rec) | 8 GB (16 rec) |
| Timed lyrics — Whisper large-v3 | ~3.1 GB | MIT · pip | 4 GB (6 rec) | 8 GB (16 rec) |
| Smooth motion — RIFE 4.26 | 22.7 MB | MIT | 4 GB (6 rec) | 8 GB (16 rec) |
| Upscale — Real-ESRGAN 2x | 67.1 MB | BSD-3-Clause | 4 GB (8 rec) | 16 GB (32 rec) |

42 capabilities. **Choose one music engine** and install the runtime and models for the features you want. Native YuE2 music-only does not require MiniMax, ComfyUI or Python. Hardware figures are capability-specific guidance, not a guarantee; an experimental Unknown means no minimum has been established. Streaming support and memory measurements from other engines must not be applied to native GGUF.

⚠ **territory** — **TaoMate 3-step LoRA (H3) and TaoMate 3-step, rank-19 average (H3, small) and BUNNY (action logic) and Semantic Bridge v1.** Derived from MiniMax H3, so its Community Licence applies: rights only inside the Applicable Territory, which excludes the EU, the UK, the Republic of Korea and the United States of America. The download goes straight to the publisher. **MiniMax H3 (quantised) and MiniMax H3 ref2va.** MiniMax grants H3 rights only inside its Applicable Territory, which excludes the EU, the UK, the Republic of Korea and the United States of America. If you are in one of those places you may not use these weights — and §V.4 says the same about anything they generate. AIPLAY Studio does not host them — the download goes straight to the publisher, and the licence is between you and MiniMax. Studio treats this as a blocking acknowledgement and refuses the download without it.

⚠ **gated** — **LTX 2.5 (quantised).** The repository is access-gated, so the built-in downloader cannot fetch it — it has no token and deliberately nowhere to keep one. Accept the licence on the model page, then in the ComfyUI python environment run `hf auth login` followed by `python scripts/fetch_ltx25.py`. About 40 GB. Licence and access: https://huggingface.co/Lightricks/LTX-2.5

⚠ **terms unread** — **Ideogram 4 (open 9B)** — https://huggingface.co/ideogram-ai/ideogram-4-fp8/blob/main/LICENSE.md

The Ideogram Non-Commercial Model Agreement is behind a gate: the URL above returns HTTP 401 to an anonymous request (checked 2026-08-27) and no copy of the text has been read here. The name says non-commercial; every other non-commercial licence in this catalogue restricts the MODEL and leaves the output alone — but Ideogram's may not, and Studio will not guess in either direction. Accept the agreement on the model page, read §-by-§, and decide. If you need a settled answer today, FLUX.2 klein 4B is Apache-2.0.

**DWPose (TorchScript)** — https://github.com/IDEA-Research/DWPose/blob/main/LICENSE

Half of this capability is verified and half is not, and the unread half is the one that makes the skeleton, so the row answers with the weaker of the two. The detector (yolox_l.torchscript.pt) is Apache-2.0: Megvii's own LICENSE was diffed against the canonical text and every operative clause is identical. The estimator (dw-ll_ucoco_384_bs5.torchscript.pt) has no readable terms at all — its redistributor's entire model card is 28 bytes of frontmatter with no LICENSE file, and so is the card of the yzd-v/DWPose repository usually named as its origin. The Apache-2.0 licence linked above, IDEA-Research's, is reached only by a filename match, and a filename is not a grant. In practice a skeleton is a measurement of a video you supplied, and the clip it goes on to steer carries the RENDERING model's terms — WAN 2.1 VACE's, which are settled Apache-2.0 — so this is narrower than it sounds. Read the chain yourself before relying on the skeleton itself being licensed. Separately, and binding whoever trained the model rather than whoever runs it: DWPose was trained on COCO-WholeBody and UBody, which carry dataset terms of their own.

⚠ **not for sale** — **YuE2 GGUF Q4 / optional Q8 (experimental).** Studio retains a conservative noncommercial / not-for-sale classification. This does not establish that every generated output is governed by the weights' licence. Review the source terms and output scope: https://huggingface.co/m-a-p/YuE2-3B/blob/main/LICENSE. **SheetSage2 song-to-score (ComfyUI).** Studio retains a conservative noncommercial / not-for-sale classification. This does not establish that every generated output is governed by the weights' licence. Review the source terms and output scope: https://huggingface.co/m-a-p/SheetSage2/blob/main/LICENSE. **YuE2 3B for ComfyUI (int8).** Studio retains a conservative noncommercial / not-for-sale classification. This does not establish that every generated output is governed by the weights' licence. Review the source terms and output scope: https://huggingface.co/m-a-p/YuE2-3B/blob/main/LICENSE. **YuE2 instrumental planner LoRA (ComfyUI).** Studio retains a conservative noncommercial / not-for-sale classification. This does not establish that every generated output is governed by the weights' licence. Review the source terms and output scope: https://huggingface.co/m-a-p/YuE2-3B/blob/main/LICENSE. **YuE2 real-audio NAR LoRA (ComfyUI).** Studio retains a conservative noncommercial / not-for-sale classification. This does not establish that every generated output is governed by the weights' licence. Review the source terms and output scope: https://huggingface.co/m-a-p/YuE2-3B/blob/main/LICENSE. **YuE2 real-audio tokenizer (head + MERT-v2-FullSong).** Studio retains a conservative noncommercial / not-for-sale classification. This does not establish that every generated output is governed by the weights' licence. Review the source terms and output scope: https://huggingface.co/m-a-p/YuE2-3B/blob/main/LICENSE. **YuE2 3B.** Studio retains a conservative noncommercial / not-for-sale classification. This does not establish that every generated output is governed by the weights' licence. Review the source terms and output scope: https://huggingface.co/m-a-p/YuE2-3B/blob/main/LICENSE. **Depth Anything V2 Large (non-commercial).** Studio retains a conservative noncommercial / not-for-sale classification. This does not establish that every generated output is governed by the weights' licence. Review the source terms and output scope: https://github.com/DepthAnything/Depth-Anything-V2#license.

**pip, not a download** — Some capabilities are Python packages that fetch their own weights, so Studio has no file to verify and no button to press. They belong in a Python that is **not** ComfyUI's: installing them there can pull the torch build the engine depends on back down, which costs about 5× the speed of everything (INSTALL.md §5).

  · **MiniMax Music 3 DAV encoder** — `python -m pip install numpy torch av` (on top of the 306 MB of weights in the table)
  · **HTDemucs (fine-tuned)** — `python -m pip install demucs`
  · **TTS voices (Kokoro + Qwen3-TTS)** — kokoro + qwen-tts (sidecar venv at tts-venv/) — no single command; see the Models screen
  · **Whisper large-v3** — `python -m pip install faster-whisper`

`node scripts/extras_setup.mjs` prints the exact command for your machine, aimed at the interpreter Studio will actually invoke, and says which are already installed.

**selling what you make** — Model licences and rights in generated material are separate questions. The catalogue records them separately. 18 of 42 are classified as placing no licence conditions on generated material (ACE-Step 1.5 turbo (ComfyUI), FLUX.2 klein 4B, HTDemucs (fine-tuned), BiRefNet, TTS voices (Kokoro + Qwen3-TTS), Z-Image Turbo (Apache-2.0), Z-Image base (Apache-2.0), WAN 2.1 VACE 1.3B, Depth Anything V2 Small, AnimateDiff v3 (SD1.5), SparseCtrl RGB (AnimateDiff v3), IP-Adapter Plus (SD1.5), ViT-H/14 (LAION-2B), TripoSG 1.5B, UniRig, Whisper large-v3, RIFE 4.26, Real-ESRGAN 2x). 14 say you may and attach conditions (MiniMax Music 3, TaoMate 3-step LoRA (H3), TaoMate 3-step, rank-19 average (H3, small), BUNNY (action logic), Semantic Bridge v1, MiniMax Music 3 DAV encoder, MiniMax H3 (quantised), MiniMax H3 ref2va, Stable Audio 3 Small SFX, Krea 2 Turbo (community licence), Anima (non-commercial model, sellable pictures), LTX 2.5 (quantised), DreamShaper 8 (the Motion look's painter), depth and line art (SD1.5, fp16)). 8 are conservatively classified noncommercial / not for sale; that label does not resolve every output's legal status. 2 — Ideogram 4 (open 9B), DWPose (TorchScript) — nobody here has read. For MiniMax Music 3: §3.1 — a commercial product or service that uses it must show “MiniMax-Music3” prominently in its interface. That is why the name sits in Studio's corner rather than on a credits page. The operative sentence is quoted verbatim in `server/models.js` and shown on the Models screen before you download anything.

**shared files** — 4 files are used by more than one capability, so picking two of those costs less than adding their rows — up to 9.0 GB less. `qwen_3_4b.safetensors` (8.0 GB) is shared by FLUX.2 klein 4B, Z-Image Turbo (Apache-2.0), Z-Image base (Apache-2.0); `flux2-vae.safetensors` (336 MB) is shared by FLUX.2 klein 4B, Ideogram 4 (open 9B); `ae.safetensors` (335 MB) is shared by Z-Image Turbo (Apache-2.0), Z-Image base (Apache-2.0); `qwen_image_vae.safetensors` (254 MB) is shared by Krea 2 Turbo (community licence), Anima (non-commercial model, sellable pictures). The Models screen quotes the deduplicated figure.

Studio hosts no weights and mirrors none: every download goes straight to the publisher, and the licence is between you and them.
<!-- MODELS:END -->

</details>

## Drive it from an agent

Studio speaks MCP. Point an assistant at `node server/mcp.js` and it can make
songs, pictures, clips and whole music videos, edit a DAW project or a
compositor scene, and read the render log back. The **Agent** screen in the app
has the config block to paste. See [the tool list](docs/DEEP_DIVE.md#drive-it-from-an-agent)
and [API.md](API.md).

## Working on this repository

**Run the gate before you push.** `sh .githooks/pre-commit` runs every test lane
in the repository (about six minutes). It is the same gate that guards a commit:
it checks the licences, the docs against the catalogue, and that every screen,
route and tool matches its other half.

```
sh .githooks/pre-commit        every lane, about six minutes
node scripts/trace_load.mjs    just the boot check, about a second
npm test                       the JavaScript suites
```

**Testing an install without touching your own.** Copy the repo
(`git ls-files -co --exclude-standard`), run `npm ci` in the copy, then start
`scripts/setup.mjs` and `launcher/launcher.mjs` with `AIPLAY_APPDATA` pointing at
an empty folder, different `AIPLAY_LAUNCHER_PORT` / `AIPLAY_UI_PORT`, and
`AIPLAY_LAUNCHER_NO_WINDOW=1`. Point `USERPROFILE`, `APPDATA` and `LOCALAPPDATA`
at empty folders too to simulate a PC with nothing installed.

**Three habits this codebase is built around:**

1. **Never claim more than you tested.** If an assertion does not cover a claim,
   say so in the same breath.
2. **When other code must know about something new** (a tool, a screen, an
   event, a test suite), add the check that fails when the two sides disagree,
   in the same commit.
3. **Build the file list from `git status`, not from your plan.**

The folder layout is described in [the deep dive](docs/DEEP_DIVE.md#layout).

## Known gaps

- **The ETA is noisy for the first ~30 seconds** of a render, then settles.
- **Rigging a 3D model cannot run on Windows yet.** It needs flash-attention,
  which has no Windows build. It refuses up front rather than pretending.
- **No Blender blockout has been scored through VACE yet.** The camera gate's
  0.924 motion agreement (against a time-shift null of 0.402) was measured on a
  synthetic corridor; a real stage set was watched, not scored.
- **Keeping a performer's identity across shots is unmeasured.**
- **The DAW's export-parity test compares no audio samples.** Parity holds by
  construction, but the regression that would break it is not covered.
- **Two model licences have not been read:** Ideogram 4's sits behind a login,
  and the DWPose estimator has no readable terms. Both rows say so and claim no
  rights.

## Thanks

The Suno-style Music screen, the one-click engine installer and AMD, Intel and
CPU support were merged from [bani4kaskashka's fork](https://github.com/bani4kaskashka).
Reactive is a re-creation of Yvann Barbot's idea (ComfyUI_Yvann-Nodes) on
Studio's own engine. The model authors and their licences are listed on the
Models screen and in [NOTICE](NOTICE).

<p align="center">
  <img src="GitHubAssets/aiplay-logo.png" alt="AIPLAY Studio logo" width="72"><br>
  <sub>Made for people who would rather own their tools.</sub>
</p>
