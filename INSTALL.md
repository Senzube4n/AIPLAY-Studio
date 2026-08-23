# Installing AIPLAY Studio

AIPLAY Studio writes and renders music on your own computer. No account, no
upload, no credits, no per-song cost.

It is not a self-contained app, and it is important to know that before you
start. Studio is a face on [ComfyUI](https://github.com/comfyanonymous/ComfyUI).
Studio runs the interface and the queue; ComfyUI runs the models. You install
ComfyUI yourself. That split is deliberate — ComfyUI is gigabytes of Python
before a single model weight, and it updates on its own schedule.

So the install is three things, in order: **Node.js**, then **ComfyUI**, then
**Studio**. Perhaps twenty minutes of your attention, and then a long download
you can leave running.

Everything here is Windows, because that is what this was built and measured on.
Other platforms are covered at the end, honestly.

---

## Before you start

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

Go to the [ComfyUI releases page](https://github.com/comfyanonymous/ComfyUI/releases)
and download the Windows portable build (the NVIDIA one). It is a `.7z`
archive — Windows 11 24H2 opens those natively, and older Windows needs
[7-Zip](https://www.7-zip.org).

Extract it somewhere with room. `D:\AI\` is a good habit: model weights are tens
of gigabytes and the C: drive is rarely where you want them.

**This build comes with its own Python and its own PyTorch.** You do not install
Python. You do not install CUDA. You do not touch a virtual environment. That is
the whole appeal, and it is why this is the route to take if you have never done
this before.

Then run it once, on its own, before you go near Studio. Double-click
`run_nvidia_gpu.bat`. Wait for it to open a browser tab. Close it again. This
matters: the first launch is what proves the graphics card, the driver and
PyTorch actually agree with each other, and it is far easier to read that failure
in ComfyUI's own window than through Studio.

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

It is a fifteen-line batch file rather than an `.exe` on purpose: you can open it
in Notepad and read exactly what it is about to do. Here is what that is.

1. **Checks for Node.js.** If it is missing, it says so and stops. Nothing else
   happens.
2. **Fetches one dependency** on first run — `ws`, a WebSocket library, MIT
   licensed. That is the entire dependency list. Takes a few seconds.
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

| Capability | Download | Licence | Needs |
|---|---|---|---|
| **Music engine** — MiniMax Music 3 | 11.9 GB | MiniMax Music3 Community | 6 GB VRAM min, 12 GB recommended |
| Audio reference — DAV encoder | 292 MB | MiniMax Music3 Community | 4 GB VRAM min |
| Cover art — FLUX.2 klein 4B | 12.5 GB | Apache-2.0 | 8 GB VRAM min |
| Stem separation — HTDemucs | 336 MB | MIT | 4 GB VRAM min |
| Timed lyrics — Whisper large-v3 | 3.1 GB | MIT | 4 GB VRAM min |
| Video clips — MiniMax H3 | 34.5 GB | MiniMax H3 Community ⚠ | 16 GB VRAM min |
| Video clips — LTX 2.5 | 39.7 GB | LTX-2.x Community ⚠ | 16 GB VRAM min |

**Only the music engine is required.** Everything else is optional and the app is
completely usable without any of it. Start with the engine, make a song, and come
back later.

Some things worth knowing before you click:

- **Downloads resume.** A dropped connection three quarters of the way through a
  12 GB file does not cost you the file. The partial is written as `.part` and
  only moved into place when the size matches to the byte, so an interrupted
  download can never leave a truncated file that looks finished.
- **Studio hosts nothing.** Every download goes straight to the publisher on
  HuggingFace. The licence is between you and them.
- **The music weights are already the smallest published.** There is no "small
  model" to switch to. Fitting a smaller card is done by streaming, not by
  shrinking — see the next section.
- ⚠ **MiniMax H3's licence** grants rights only inside its Applicable Territory,
  which **excludes the European Union, the United Kingdom and South Korea**. If
  you are in one of those places you may not use those weights. Studio shows this
  as a blocking acknowledgement and refuses the download without it.
- ⚠ **LTX 2.5** is faster than H3 and better by eye, but its repository is
  access-gated. You must accept the licence on
  [its model page](https://huggingface.co/Lightricks/LTX-2.5), then run two
  commands **using ComfyUI's own Python** — that is the one with
  `huggingface_hub` installed:

  ```
  D:\path\to\ComfyUI\venv\Scripts\hf.exe auth login
  D:\path\to\ComfyUI\venv\Scripts\python.exe scripts\fetch_ltx25.py
  ```

  Portable builds have `python_embeded\python.exe` in place of
  `venv\Scripts\python.exe`. Studio records which one you have in
  `%USERPROFILE%\.aiplay-studio\settings.json` under `python`, and the fetch
  script reads that same file to find your models folder. It is about 40 GB and
  resumes if the connection drops.

  The command is `hf auth login`, **not** `huggingface-cli login` — the latter
  was removed in huggingface_hub 1.x and now refuses to run rather than warning.
  The built-in
  downloader cannot fetch it and deliberately has no place to keep your token.
  Its licence also requires a paid agreement at USD 10,000,000 annual revenue or
  more, and forbids use in a product competing with Lightricks' own.
- **Stems and timed lyrics are the rough edges.** They are Python packages
  (`demucs` and `faster-whisper`), not files Studio can fetch, and they
  deliberately run in a *different* Python from the engine — see the next
  section for why. On a fresh machine they will not work until you install them
  somewhere and point Studio at that Python with the `AIPLAY_SYS_PYTHON` and
  `AIPLAY_WHISPER_PYTHON` environment variables. Everything else in this guide
  is smoother than this part.
- **Audio reference needs three Python packages as well.** Starting a render from
  a real song means encoding that song into the model's latent space, and
  ComfyUI will not do it — `comfy/sd.py` raises *"MiniMax Music3 DAV cannot
  encode audio"*. Studio does it outside ComfyUI, with `scripts/dav_encode.py`,
  which needs `numpy`, `torch` and `av` (PyAV) in the same **system** Python the
  extras above use — not ComfyUI's, for the reason in the next section:

  ```
  python -m pip install numpy torch av
  ```

  The weights are the 292 MB download in the table. Everything after the encode
  is stock ComfyUI: the encoder writes an ordinary `.latent` file and ComfyUI's
  own `LoadLatent` reads it, so no custom nodes are involved at any point. If
  the packages are missing the Models screen says so before you try to use it.

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

The weights Studio uses are already the smallest published versions. So the way
to fit a smaller card is not a smaller model — it is keeping less of the model in
VRAM and streaming the rest from system RAM. That is what the **graphics memory**
setting does. Studio picks a tier automatically; you can override it, and
changing it restarts the engine.

| Your VRAM | Music | Cover art | Stems | Timed lyrics | Video |
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

Five things go wrong on a first run. These are all of them.

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

1. **You are on the portable build and have not made the one-line edit** from
   step 2. Studio is trying to run a `venv\Scripts\python.exe` that does not
   exist. This is the most common cause by a distance.
2. **You are running ComfyUI yourself at the same time.** Close it. Studio starts
   and owns its own copy.
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

The message lists every folder it looked in. Usually it means the 292 MB **Audio
reference** entry on the Models screen has not been downloaded yet.

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

Two traps worth knowing before you start, both covered in
**[REACTIVE.md](REACTIVE.md)**:

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
| The engine | `http://127.0.0.1:8266`, started and stopped by Studio |

Ports and folders can be overridden with the `AIPLAY_UI_PORT`,
`AIPLAY_COMFY_PORT`, `AIPLAY_RIG` and `AIPLAY_OUTPUT` environment variables.

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
