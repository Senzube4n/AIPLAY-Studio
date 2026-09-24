# YuE2 GGUF: music without ComfyUI

The experimental native YuE2 engine turns a style description and lyrics into
a WAV song through **audio.cpp**. It is separate from Studio's Python YuE2
integration and from MiniMax/ComfyUI.

**This is a launch mode of the same public AIPLAY Studio repository**, not a
separate download edition. The app files are shared; unrelated AI models are
not installed or required. Use the music-only launcher below, not the full-suite launcher.

## Quickstart

1. Install **Node.js 20+** and download
   [AIPLAY Studio ZIP](https://github.com/Senzube4n/AIPLAY-Studio/archive/refs/heads/main.zip), then extract it.
2. On Windows, open **`AIPLAY Studio.exe`** and choose **Music only**. Alternatively, run
   `npm ci --omit=dev` once in the Studio folder, then `npm run start:music`.
3. Open **Models**. Read the native runtime and model notices, then explicitly
   choose **Q4_0** (default, smaller) or **Q8_0** (higher precision), then install
   that model and its separate **native runtime**. You may install both.
4. In **Music**, select native YuE2, enter a style and nonempty lyrics, and press
   **Create**. Your completed WAV appears in the library.

No ComfyUI, Python, PyTorch or unrelated model is needed for this route. It does
not install packages into an existing Python environment. The packaged runtimes
are **Windows x64**, and setup picks the one that fits your card:

| Card | Runtime installed | Needs |
| --- | --- | --- |
| NVIDIA | the pinned CUDA kit below | CUDA 13.3 driver + VC++ redistributable |
| AMD, Intel | official audio.cpp v0.8.1 **Vulkan** build (58,059,664 bytes) | a current graphics driver |
| no graphics card (Studio set up for CPU) | official audio.cpp v0.8.1 **CPU** build (23,692,614 bytes) | nothing; slow |

The weights are the same files on every card. The Vulkan and CPU archives are
downloaded unchanged from the audio.cpp release, pinned by the SHA-256 GitHub
publishes for them, and carry their own Visual C++ runtime DLLs. Nothing is
installed into ComfyUI, ROCm or Python. Only the CUDA kit has been timed here;
Vulkan and CPU speed and memory are not measured yet. On macOS or Linux, point
`AIPLAY_AUDIOCPP_CLI` at your own audio.cpp v0.8+ build; the backend is read
from its `--version` output. `AIPLAY_YUE_GGUF_RUNTIME=cuda|vulkan|cpu` forces
which runtime setup installs, and `AIPLAY_YUE_GGUF_BACKEND` which backend a
render uses.

On NVIDIA, Windows also needs a current driver compatible with **CUDA 13.3** and the
[Microsoft Visual C++ v14 x64 Redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist).
Install that redistributable from Microsoft if it is missing; it is not bundled
with Studio's CUDA package.

Downloads happen only when you request installation. The pinned manifest records
the source, expected byte count and cryptographic identity for each artifact;
verification must succeed before installation completes. A missing runtime is
not permission to silently download one or switch engines. The runtime download
is additional to the weights:
**833,086,121 bytes** (about **833 MB**) for the two runtime archives below.

## What is downloaded

The default Q4 bundle's six model files total **2,933,414,997 bytes** (about **2.93 GB**, decimal).
They are not the older Python safetensors or FP8 files.

| Model bundle member | Bytes |
| --- | ---: |
| `yue2-3b-q4_0.gguf` | 2,665,632,320 |
| `yue2-vae-f16.gguf` | 265,218,656 |
| `sidecars/yue2-model-config.json` | 959 |
| `sidecars/yue2-generation-config.json` | 466 |
| `sidecars/yue2-qwen.tiktoken` | 2,561,218 |
| `sidecars/yue2-vae-config.json` | 1,378 |

The optional Q8 bundle replaces only the main model with
`yue2-3b-q8_0.gguf` (**4,264,186,432 bytes**). Its six model files total
**4,531,969,109 bytes** (about **4.53 GB**), plus the same native runtime below.
The F16 VAE and four sidecars are shared and verified files are reused. If Q4
is already installed, adding Q8 needs its additional main model; it does not
remove Q4. Installing Q8 first does not require downloading Q4.

Choose precision in **Music** for each take. **Models → Native setup** lets you
review and install either option. Missing Q8 is an explicit setup requirement,
never permission to substitute Q4 or download it automatically. Q8 has not yet
been GPU-benchmarked or listening-tested in Studio; higher numerical precision
is not a guarantee of better audio, and download size is not VRAM usage.

| Separate native runtime archive | Bytes |
| --- | ---: |
| `aiplay-yue2-runtime-cda0e3a-windows-x64.zip` | 256,062,665 |
| `aiplay-yue2-cuda13.3-cda0e3a-windows-x64.zip` | 577,023,456 |

These are **AIPlay packages of unchanged, pinned upstream binaries**, not an
official audio.cpp release. Full source attribution and component licences are
included. The [checked-in runtime manifest](../server/music/yue-runtime-manifest.json)
records each archive's download URL, SHA-256 and extracted-file identities.
Model files come directly from the pinned Hugging Face source below. The combined
model/runtime download is about **3.77 GB for Q4** or **5.37 GB for Q8**; extraction, retained archives and
generated songs need additional disk space. Microsoft runtime installation is
separate.

Model source: [audio-cpp/Yue2-3B-GGUF, pinned revision
`eb116220931de5f373d024d48800338178c7de51`](https://huggingface.co/audio-cpp/Yue2-3B-GGUF/tree/eb116220931de5f373d024d48800338178c7de51).
Native contract: [audio.cpp source revision
`cda0e3a4762d855e865980506f934ec0e6928691`](https://github.com/0xShug0/audio.cpp/tree/cda0e3a4762d855e865980506f934ec0e6928691).

Use the runtime selected by Studio's manifest, not an arbitrary `latest` archive:
upstream **v0.7.4 does not include this YuE2 contract**; YuE2 is upstream from
v0.8.0, which renamed the guidance option `cfg_scale` to `guidance_scale` (Studio
reads the build's version and passes the name it knows). An executable's presence alone does not establish its version,
CUDA compatibility or ability to render.

## Controls and limits

| Control | Native behavior |
| --- | --- |
| Style and lyrics | Both required. Up to 2,000 style characters and 8,000 lyric characters; very long commands or paths may be refused sooner. |
| Precision | `q4_0` by default, or optional `q8_0`. Both use F16 VAE; the selected main model must be installed. |
| CoT | `full` by default; `melody` and `off` are alternatives. |
| Synthesis / NAR steps | **32** by default. **16** is an experimental faster setting, not a measured quality-equivalent preset. |
| Seed | Random for each request that names none (it was a fixed 831001, so the same words gave the same song); a nonnegative safe integer. It is not a cross-version determinism guarantee. |
| Sampler | Optional `temperature` / `topP` (the performance) and `planTemperature` / `planTopP` (the planner), passed to the runtime as `semantic_temperature`, `semantic_top_p`, `abc_temperature`, `abc_top_p`; blank keeps the vendor defaults (1.0 / 0.95 and 0.7 / 0.9). The planner's two are refused with a supplied score or CoT `off`, where the planner does not run; the Music page shows Planner temperature disabled then, with the reason, and does not send it. |
| Key, tempo, meter | Not on this runtime (it has no open-score option); the Music page hides those rows on GGUF. |
| Guidance | Optional `cfgScale` / `cfg_scale`, from 0 to 20. |
| ABC input | Optional notation with CoT `melody` or `full`; no generated editable-score export is provided by this native integration. |

### Supplied scores and length planning

Open **Music → Melody & score** to hum a melody into the box, or paste or load a reviewed
two-voice `.abc` score. **Check score** validates the supported notation dialect.
Enable **Use this score with Create** to send that draft through the same native
ABC input available to MCP. CoT must be `full` or `melody`; choose either this
draft or the separate saved-score selection, not both.

The BPM/meter/length planner is local arithmetic, with no GPU or model download.
Without notation it estimates a whole-bar outline. With notation, **Fit notation
length** proposes a tempo change from the actual note durations; **Apply proposed
tempo** changes only the text draft, never the original file. It does not add
verses or guarantee audio length. Keep tempo descriptions in the style prompt
consistent with the score. Agents use `music_plan`, then pass accepted `abc` to
`make_song`; planning never queues a render.

### Recording input and extension are different problems

YuE2 does not expose a direct recording/reference-singer or continuation input.
The upstream recording-cover workflow uses transcription to ABC followed by a
new generation. Extending an arrangement and lyrics can therefore make a new,
longer take, but cannot preserve the existing waveform, singer or untouched
passages. Studio does not label regeneration or a crossfade as seamless song
extension. See the [official generation and cover guide](https://github.com/multimodal-art-projection/YuE/blob/main/skills/yue2-music/references/generation-and-covers.md).

Structure lyrics with section tags on their own lines — `[Verse]`, `[Chorus]`,
`[Bridge]` — the lyric format YuE2 is trained on.

There is **no guaranteed duration**, native instrumental mode, cheap preview,
audio reference/continuation, reusable mix cache, or native score-export workflow.
The Python engine's duration, offload, token and FP8 controls do not apply and
are rejected rather than silently ignored. No ETA is inferred from the benchmark.

### Progress and checking the ending

Native generation shows **elapsed time**, not a predicted finish time. The normal
runtime does not expose live composition/synthesis steps, so **Generating audio**
remains active until output verification begins. Queue estimates stay unavailable
when they include native work; Studio does not substitute another engine's speed.

A completed WAV can still end before all requested lyrics are performed. New takes
whose measured duration is within one semantic frame of the installed model's
configured limit show **Check ending** in the library and a notice in the song
details. This is a *possible* limit hit, not confirmed truncation or a lyric check.
The limit is read from the installed sidecars, not a universal six-minute rule.
Missing or invalid limit metadata produces no inference; an empty warning list
does not certify the ending. Older takes are not retroactively classified.

The receipt, library, REST status and MCP carry the same warning. Listen before
accepting the take. Studio does not automatically regenerate, change your lyrics,
raise a model limit, or append an artificial ending.

## One measured run, not a hardware minimum

A single original short-song test on **14 September 2026** used an **RTX 4070 Ti
SUPER with 16 GB VRAM**, Q4_0/F16 weights, CoT `full`, 32 synthesis steps and seed
831001. It produced **49.4 seconds of 48 kHz stereo PCM16 audio in 22.0 seconds**
of native wall time.

The sampled **whole-GPU peak was 6,589 MiB**, with a **3,129 MiB baseline**.
Desktop and other applications are included. This is **not a process-memory
peak**, a required-memory calculation, or certification for 6 GB, 8 GB or 12 GB
hardware. Longer songs, CoT alternatives and 16-step quality comparisons were
not established by that run. Performance and memory use can change with input,
driver and runtime versions.

## Licences and attribution

Studio's application code is Apache-2.0. audio.cpp is a separate Apache-2.0
project; its bundled third-party components retain their own terms. A permissive
runtime licence does not change the model licence.

The [original YuE2 model licence](https://huggingface.co/m-a-p/YuE2-3B/blob/main/LICENSE)
applies **CC BY-NC 4.0 to the weights**. Since 2026-09-24 Studio's output label
follows the model authors' own statement of 15 Sep 2026
([discussion #5](https://huggingface.co/m-a-p/YuE2-3B/discussions/5)):
**sellable by individuals; companies need a commercial licence**. That statement
is a discussion comment, not the licence file, which has not changed.
Whether particular generated audio is covered adapted material is not resolved
here: the label is neither legal advice nor a change to the weight licence.
Review the source terms before distribution; a company should ask the authors.

Keep model/source attribution, AI disclosure and creator credits. Studio records
delegation before generation, validates the WAV and records its digest and
receipt. Library metadata is applied to a copy so the receipted original stays
unchanged. WAV cover art remains a sidecar image, not an embedded-picture claim.

## If setup or generation fails

- **Runtime unavailable:** use the compatible manifest-selected package when it
  is offered. Do not substitute v0.7.4, a Python launcher or a generic llama.cpp
  executable. Nothing should render until readiness checks pass.
- **Download verification failed:** check available disk space and retry the
  explicit install action. Do not rename a partial file to make it look complete.
- **CUDA or memory error:** close other GPU workloads and retry a short lyric.
  The sampled benchmark does not prove your card fits. Do not modify a working
  ComfyUI/Python installation to repair this separate native runtime.
- **Unsupported option:** use the native controls above. The existing Python
  YuE2 and MiniMax integrations remain different engines with different features.

For scripts and agents, see the [local API](../API.md#native-yue2-gguf).
The public GitHub Pages site describes the app; it does not host your Studio
instance or render music in the cloud.
