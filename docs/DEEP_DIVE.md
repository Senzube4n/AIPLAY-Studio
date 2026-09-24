# AIPLAY Studio in depth

The [README](../README.md) is the short tour. This is the long one: how each
part works, what was measured, and what each part cannot do. Every number here
was measured on a real machine, and the scripts that measured them ship in
[`scripts/`](../scripts/).

**Contents**

- [Hardware: NVIDIA, AMD, Intel and CPU](#hardware-nvidia-amd-intel-and-cpu)
- [Why this rather than a cloud tool, in full](#why-this-rather-than-a-cloud-tool-in-full)
- [Full Studio: your first MiniMax song](#full-studio-your-first-minimax-song)
- [Getting a ComfyUI](#getting-a-comfyui)
- [Two video engines, and YuE2's Python build](#two-video-engines-and-yue2s-python-build)
- [ACE-Step 1.5](#ace-step-15)
- [Chat — the first screen](#chat--the-first-screen)
- [What it does](#what-it-does)
- [The engine door and the ledger](#the-engine-door-and-the-ledger)
- [Blocking a camera, and steering a render with it](#blocking-a-camera-and-steering-a-render-with-it)
- [A picture becomes a 3D model](#a-picture-becomes-a-3d-model)
- [The music-video workflow](#the-music-video-workflow)
- [The audiobook workflow](#the-audiobook-workflow)
- [Audio reference — starting from a real song](#audio-reference--starting-from-a-real-song)
- [Music input — continuing from a recording (experimental, opt-in)](#music-input--continuing-from-a-recording-experimental-opt-in)
- [Images](#images)
- [The DAW](#the-daw)
- [The graphs are the product](#the-graphs-are-the-product)
- [Why it is fast](#why-it-is-fast)
- [No GPU? API mode](#no-gpu-api-mode)
- [Settings that are not up for negotiation](#settings-that-are-not-up-for-negotiation)
- [Drive it from an agent](#drive-it-from-an-agent)
- [Layout](#layout)
- [Settings you can change](#settings-you-can-change)
- [Reactive — pictures that move with a song](#reactive--pictures-that-move-with-a-song)
- [Release notes, September 2026](#release-notes-september-2026)

---

## Hardware: NVIDIA, AMD, Intel and CPU

**No ComfyUI on this PC? Studio installs one.** When the launcher finds no
ComfyUI, it asks **What should Studio run on?** — **NVIDIA**, **AMD**, **Intel Arc**
or **CPU only** (the card it detected is marked). Pick one and Studio installs
its own ComfyUI into `%USERPROFILE%\.aiplay-studio\engine` — nothing else on the
PC is touched (uv's Python is installed with no ~/.local/bin copy and no
registry entry), and an existing ComfyUI is never modified:

1. a standalone Python (via [uv](https://github.com/astral-sh/uv), pinned and
   checked against its published SHA-256, kept in `.aiplay-studio\tools\uv`;
   so no system Python is needed);
2. ComfyUI **v0.36.0**, the version this Studio is tested with
   (`server/setup/pins.js`); a newer upstream release is not taken until that
   pin changes;
3. PyTorch for your choice, using **the exact command in that ComfyUI's own
   README** — CUDA 13.0 for NVIDIA (CUDA 12.6 on Python 3.12 for GTX 10-series and
   older), AMD's ROCm packages on Windows with only your card's kernels where the
   README's table names it (an RX 9060 XT gets `device-gfx1200`), ROCm 7.2 on
   Linux, XPU for Intel Arc, the CPU build otherwise;
4. ComfyUI's requirements, then Studio's own packages (OpenCV, librosa,
   soundfile and SciPy, only those that do not import, with every package
   already installed pinned at its version so none of them moves), then a
   check that PyTorch can see the card, and a test start of ComfyUI
   (`--quick-test-for-ci`).
   If only Studio's packages fail, the engine is kept and the launcher's
   "Studio's own packages" row offers **Try again**. From inside a running
   Studio the same repair only adds what is missing; a package that is
   installed but does not import is put back at its version by the
   launcher's Try again, with Studio stopped, since the running engine holds
   its files open.

**If any step fails**, the half-built engine folder is deleted and its download
cache is kept (so the next try does not fetch the same gigabytes again), and
the launcher asks again showing the exact error (for example pip's own
message). A folder the installer did not create is never deleted or reused.
Measured on a clean profile: CPU install, 5 min 52 s, 2.1 GB, Studio then started
on it. `node scripts/install-engine.mjs --backend amd --gpu-name "AMD Radeon RX
9060 XT" --plan <ComfyUI README.md>` prints the command a card would get without
installing anything; `AIPLAY_ENGINE_DIR` puts the engine on another drive.

The graphics card is now read before anything else, so a PC with no ComfyUI no
longer reports "No NVIDIA or AMD card could be read".

**One launcher.** Double-click **`AIPLAY Studio.exe`** (or **`AIPLAY
Studio.cmd`**, the same thing as a readable script with a console). It checks
Node.js and the npm packages, then opens a launcher window with both modes — **Full
Studio** and **Music only** — and a system check: graphics card, CUDA or ROCm
PyTorch, ComfyUI install, models folder, YuE2 checkpoint, MiniMax weights,
native YuE2 GGUF and ffprobe, each marked ok / warning / missing. Launching
streams Studio's output into the window and opens Studio in your browser
**only once ComfyUI reports it is ready** (a music-only run with no ComfyUI
opens as soon as the server answers). *Stop* ends Studio and ComfyUI together;
closing the launcher's console does too. The exe has no console: it keeps an
AI PLAY icon in the tray while the launcher runs — click it to reopen the
window, right-click for *Open Studio* or *Stop Studio and quit* — and writes the
launcher's output to `%USERPROFILE%\.aiplay-studio\launcher.log`. The launcher
is `launcher/launcher.mjs` and `launcher/index.html` — readable, loopback-only,
and it installs nothing. The exe is ~200 lines of C# in `launcher/exe/`;
rebuild it (and `launcher/aiplay.ico`, from `web/assets/aiplay-logo.svg`) with
`node scripts/build-launcher-exe.mjs`, which uses the C# compiler that ships with
Windows. It is unsigned, so SmartScreen may ask once (*More info → Run anyway*).
It replaces the two `Start …cmd` files Studio used to ship: both modes, and the
setup they each ran, are in the launcher window. The **ComfyUI install** and
**Models folder** rows have a *Change…* button that opens a native folder
picker, so the two settings that can stop Studio starting can be fixed from the
screen that is up when they are wrong — no editing `settings.json`, and no
starting Studio first.

**Music only** runs native YuE2 GGUF and starts no ComfyUI when GGUF is the
selected engine and is installed, on any card. Otherwise it starts ComfyUI when
this machine has a ComfyUI install and a YuE2 checkpoint in `models/checkpoints`,
and renders with YuE2 through ComfyUI.

The ComfyUI-backed suite runs on either vendor. Studio does not install or
replace torch, CUDA or ROCm: it drives the ComfyUI you already have, launched
the way that install's own launcher launches it.

| your card | which ComfyUI | torch it must carry |
|---|---|---|
| **NVIDIA** | portable `ComfyUI_windows_portable_nvidia.7z` (not `_cu126`), or from source | `+cu130` or newer |
| **AMD Radeon** | **ComfyUI Desktop → AMD**, the portable `_amd` build, or from source with AMD's ROCm wheels | `+rocm…` |

Every layout is found: portable (`python_embeded`), from source (`venv`), and
ComfyUI Desktop (`<install>\ComfyUI\.venv`, read from
`%APPDATA%\Comfy Desktop\installations.json`). The launcher runs
`scripts/setup.mjs`, which records in `%USERPROFILE%\.aiplay-studio\settings.json`:

- **the card** — from `nvidia-smi`, or on AMD/Intel from the Windows
  display-adapter registry (the WMI `AdapterRAM` field is capped at 4 GB);
- **the torch build** of the engine's python — `cuda`, `rocm` or `cpu` — with a
  warning naming the right ComfyUI build when it does not match the card. It
  never changes that python;
- **the launch flags** from the install's own launcher: ComfyUI Desktop's
  recorded launch arguments and extra model paths (plus its default models
  folder, so Studio looks and downloads there), or the portable build's
  `run_nvidia_gpu.bat` / `run_amd_gpu.bat`. Flags Studio owns (`--port`,
  `--listen`, the directories, auto-launch, the manager) are dropped.

`node scripts/setup.mjs --redetect` re-reads the card and torch after a change.
`"launchFlagsSync": false` in settings.json stops setup rewriting
`comfyExtraArgs` / `modelsDir`, for anyone who sets them by hand.

**Measured on AMD.** RX 9060 XT 16 GB, 32 GB RAM, ComfyUI Desktop with torch
`2.15.0a0+rocm10.1`, same smoke-test prompt, 30 s cap, seed 12345:

| engine | result | wall time | audio check |
|---|---|---|---|
| **YuE2 3B through ComfyUI** (`yue2_3b_bf16`, score plan on, 32 steps dpm_2) | ✅ works | 56 s for 30.0 s | peak −1.7 dB, RMS −18.5 dB |
| **MiniMax Music 3** (fp16 DiT) — first run | ⚠ rendered, reported not listenable | 180 s for 15.8 s | peak −1.2 dB, RMS −19.5 dB |
| **MiniMax Music 3** (fp16 DiT) — retry | ❌ broken output | 187 s for 30.0 s | peak and RMS both 0 dBFS — a flat full-scale signal, not music |

⚠ **MiniMax Music 3 was broken on AMD (ROCm) under the launch above.** The weights fit
and the graph finishes without an error, but the audio came out broken or unlistenable.
**Fixed 2026-09-18:** launching ComfyUI with `--use-pytorch-cross-attention
--disable-cuda-graphs` makes it render real music on the same RX 9060 XT (reported by
the owner of that card). Those two flags are now Studio's default launch options; the
warnings below only appear when a launch lacks them.

**Auto picks the VRAM mode from the card (since 2026-09-19):** under 12 GB it passes
`--lowvram`, 12 GB and up runs ComfyUI's normal mode (no flag), each with
`--async-offload 4`. Cards over 16 GB used to get `--highvram`; since 2026-09-21 they
don't, because it forbids moving any model off the card. A 24 GB Quadro RTX 6000 loading
music, then image, then video models filled up and spilled into shared system memory:
15-minute renders and a soft crash. It replaces any VRAM mode the install's own
flags carry, so ComfyUI never gets two. The measurement below is why normal mode was
safe to make the default on a 16 GB card: `--lowvram` bought no speed there and kept far
more in system RAM.

**The low-VRAM tier cost nothing on this card.** Studio's `auto` tier used to pass
`--lowvram --async-offload 4`; ComfyUI Desktop runs the same card without it.
Measured on 2026-09-16 with six 30-second YuE2 renders, fresh seed each, one job
at a time: `auto` took 64 s, 38 s, 24 s, 24 s and `high` (no `--lowvram`) took
39 s, 24 s, 24 s. Every slow figure is the first render after an engine start —
once the weights are warm both tiers land on **24 s**, which matches Studio's own
note that `--lowvram` reads as a no-op under dynamic VRAM. `auto` stays the
default. If you repeat this, change the seed: an identical seed and caption
returns the cached song in about 5 seconds.
Studio marked it "buggy on AMD" in the music model list and on its Models card until the launch-flag fix above.
**On AMD, use YuE2 3B through ComfyUI** — any YuE2 checkpoint in a
`checkpoints` folder is listed in the music model picker. Two runs on one card;
not a root-cause analysis.

What is different on AMD:

- The fused kernels are comfy_kitchen's **`hip`** backend on ROCm. Its `cuda`
  backend reads *disabled* there, and that is expected; Studio counts either.
- The engine's venv folder goes first on PATH at launch, as activation would
  put it. A TheRock ROCm torch runs `hipInfo.exe` from there to identify the
  card; without it ComfyUI logs *"Could not detect ROCm GPU architecture"*.
- The VRAM readout (the rail meter) reads memory in use and load from Windows'
  own GPU performance counters, the ones Task Manager shows, through
  `server/gpu-win.ps1`; on Linux from amdgpu's sysfs files. It is display only:
  the free-VRAM checks that can refuse a render still read `nvidia-smi` and so
  skip themselves on AMD, exactly as before.
- **Automatic cover art queues an image render straight after every song.** On
  a machine the music model already fills, switch it off
  (`POST /api/art {"action":"enable","value":false}`, remembered) and draw
  covers when nothing else is rendering.
- **Music on AMD is YuE2 through ComfyUI.** It renders with ComfyUI's own YuE2
  nodes (the "Text to Music (YuE2)" template's graph) and a checkpoint such as
  `yue2_3b_bf16`; its length ceiling goes to 6:00. MiniMax Music 3 is listed
  but marked buggy on AMD (see the table above).
- **Native YuE2 GGUF runs on AMD and Intel** through audio.cpp's official
  Vulkan build, and on the CPU build without a card (see the release notes
  below for the measured times).
- **Not on AMD:** the 3D mesh stack (CUDA-only wheels). The pip extras — stems,
  Whisper, TTS, the DAV encoder — are untested on AMD.

---

## Why this rather than a cloud tool, in full

Five answers, and each one is a thing in the code rather than a promise.

**It runs on one consumer graphics card, and nothing leaves the machine.** No
account, no key, no credits, no upload. Studio benchmarks below use an
RTX 4070 Ti SUPER (16 GB) with 32 GB of RAM; unbenchmarked options are labelled.
Three network exceptions exist and all three
are named where they live: model downloads go straight to the publisher (Studio
hosts no weights and mirrors none; the native runtime is an attributed AIPlay
package on GitHub), the Community screen is a window onto a
website and is the only screen that wants a connection, and **the hosted engine**
(Settings → No strong graphics card?) is an opt-in switch for machines that
cannot run the music model — off by default, it cannot switch itself on, and
every paid song asks first.

**Every render is written down before it is asked for.** On 2026-09-02 the output
folder held 426 files written since the previous noon, and **424 of them had no
ledger entry of any kind** — rendered by scripts posting straight at ComfyUI's
port. So there is now one door. The engine binds a loopback port the app picks
fresh at every start and never publishes; one module knows the number and a
census over the tree **fails the build** if any other file names it, a ComfyUI
route, or the port config. Every render — from the app, from an agent, from your
own script — writes the whole technical record to a hash-chained ledger *before*
the POST: the graph itself, the prompt verbatim, every sampler's seed and step
count, the size, every model file with its bytes, every reference image's digest,
who asked. A ledger that throws means the engine is never contacted. So you can
prove what made a file, with which weights and which seed — and a render that
**failed** is recorded too, which it never was before. See *The engine door and
the ledger* below, and [`docs/ENGINE_DOOR.md`](ENGINE_DOOR.md) for the whole
argument including what it does not defend against.

**It refuses before it spends, rather than failing after.** This is a design rule
with named refusals all over the tree, and the expensive paths are where it
matters: a control clip that is not exactly 1280x704 at exactly 24.000 fps with at
least 121 frames is refused by ffprobe **for free**, naming which of the three
numbers is wrong, because all three otherwise produce a finished mp4 that is not
your shot after half an hour of GPU. A mesh run refuses on five separate
conditions, each one sentence, each costing nothing. A rig refuses on one named
missing module rather than pretending. A negative prompt on a distilled engine is
refused rather than accepted and ignored. A chat that would spend GPU minutes
shows you the exact arguments and waits. The rule, in §5 of `DIRECTING.md`'s
words: *asking is never the expensive option.*

**The licences are read, and enforced in code.** Every capability answers two
separate questions — what the licence says about the MODEL, and what it says
about what you GENERATE — because people lose money to that confusion in both
directions. The bar for a licence claim here is the text shipped with the weights
diffed against the canonical one, and where that bar cannot be met the row says
**terms unread** and refuses to claim rights. One model is territory-restricted
and Studio blocks its download without an acknowledgement; a build-failing test
(`server/territory_test.js`) makes sure no other file in the repo — source, doc or
page — ever hand-types that territory list, because four files once typed it as
three territories while the catalogue said four. Rights are stamped onto each
render **at generation time**, not looked up afterwards.

**It covers the whole chain, and an agent can drive all of it.** Song, lyrics,
stems, cover art, standalone images and a full image editor, video clips on two
engines, a camera blocked in Blender that the render actually follows, an
After-Effects-shaped compositor, a server-rendered DAW with mastering, and now a
picture turned into a 3D mesh. **266 MCP tools** expose it — 46 `mv_*`, 50
`daw_*`, 46 `vfx_*`, 17 `ab_*`, 11 `engine_*`, 8 `score_*` and the rest — so an
assistant can run the studio while you watch. The honest limit is stated in its
own section: one thing an agent cannot do is press Export.

---

## Full Studio: your first MiniMax song

The instructions below are for the original ComfyUI-backed music engine and the
full creative suite, not prerequisites for the native music-only quickstart.

Three things to install, then one question, then a caption. Measured on this
machine, and the parts are broken out below so you can see where the time goes.

**1. Node.js** — [nodejs.org](https://nodejs.org), the **LTS** installer, ~30 MB.
Accept the defaults. Studio's server is written in it, and it is the only thing
here that has to be on your PATH.

**2. ComfyUI** — see *[Getting a ComfyUI](#getting-a-comfyui)* just below if you
do not already have one. Studio drives one; it does not contain one.

**3. Double-click `AIPLAY Studio.exe`.** It checks Node, fetches three npm
packages (`ws` and `three`, MIT; `gltf-validator`, Apache-2.0 — a few seconds,
once; all three are needed to start), finds your ComfyUI — it looks in the
usual places on every drive and asks only if it cannot — and opens your browser
at `http://127.0.0.1:4173`. Leave the black window open; closing it stops Studio.

**4. Open the Models screen and read the top line.** It reads your card and your
system RAM and names the two or three models worth having *on that machine*,
with the download size and the licence for each. Press the button on the ones it
names. Nothing downloads on its own, ever, and the music engine — 11.9 GB — is
the only one you actually need.

**5. Open Create, paste a caption, press Make.**

For the caption, use the one in **[`examples/01-song/caption.txt`](../examples/01-song/)**
— it is the real request behind the demo track, lyrics and all, and its
three-part shape (*Global Metadata / Vocal Details / Arrangement*) is most of
what decides the quality.

### How long that actually took

On an RTX 4070 Ti SUPER (16 GB) with 32 GB of RAM, Windows 11. Your numbers will
differ; the shape should not.

| step | time | where the number comes from |
|---|---|---|
| the launcher's checks, and finding ComfyUI | **0.07 s** | timed 2026-09-02, three runs: 75, 69, 66 ms |
| ComfyUI starting | **~15 s** | this repo's existing figure, not re-timed |
| **the song** — the caption in `examples/01-song` | **264.1 s** | timed 2026-09-02, engine already warm |
| ↳ composing — the performance | 108 s | |
| ↳ arranging | 57 s | |
| ↳ mixing down | 95 s | |
| re-rolling the mix afterwards | **~15 s** | existing figure — the composing stage is cached |

That render produced **4 min 22 s of audio in 4 min 24 s**, which is roughly real
time. Song length follows lyric length rather than a setting, so a shorter lyric
is a shorter wait.

Call it **five minutes** from a working install to a finished song, plus the one
11.9 GB download, which is your connection rather than anything Studio does. Two
things sit outside that number and both are stated rather than folded in: a first
render on a cold engine pays once more for reading the weights off disk, and the
15 s engine start is this repo's earlier measurement — it was not re-timed here
because doing so means restarting a running app.

**What this deliberately leaves out.** Video and images. Both are optional, both
are much larger downloads, and neither is the reason you are here on day one —
so the quickstart does not mention them and the app does not need them. When you
want them: *Images* below, and *Video clips* in the table. There are worked
examples of both, input beside output, in **[`examples/`](../examples/)**.

---

## Getting a ComfyUI

Optional for native YuE2 music-only; required for the ComfyUI-backed features below.

"Install ComfyUI and run it once" is a whole project if you have never done it,
so here is the short version. Studio ships no copy of it: ComfyUI is gigabytes
of Python before a single model weight, it updates on its own schedule, and
bundling a second one would be the largest thing in this download and the first
to rot.

**Take the portable Windows build.** On the
[ComfyUI releases page](https://github.com/comfyanonymous/ComfyUI/releases/latest),
download **`ComfyUI_windows_portable_nvidia.7z`** — about **2.1 GB**
(2,146,721,943 bytes for v0.34.0, checked 2026-09-02; the number moves with each
release, the name does not).

⚠ **Not the `_cu126` one.** That build exists for old drivers, and an old CUDA
build is the one failure in this whole stack that does not announce itself — it
costs about **4.9× the speed of everything**, with a single line in a log and no
error anywhere. INSTALL.md §5 is entirely about that, and Studio checks for it
on every start and puts a red banner up if it finds it. Update your NVIDIA
driver and take the plain `nvidia` build.

**Unzip it somewhere with room, not on C:.** `D:\AI\` is a good habit — the
model weights land *inside* this folder and they are tens of gigabytes. It is a
`.7z`; Windows 11 24H2 opens those natively and older Windows wants
[7-Zip](https://www.7-zip.org).

**Then run it once, on its own, before you go near Studio.** Double-click
`run_nvidia_gpu.bat`, wait for a browser tab, close it. Nothing about that is
ceremony: the first launch is what proves your card, your driver and PyTorch
agree with each other, and if they do not you want to read that failure in
ComfyUI's own window rather than through Studio's engine log. It is also what
some layouts need in order to have a Python at all.

**Then Studio finds it by itself.** `scripts/setup.mjs` looks for
`ComfyUI\main.py` in your home folder, Documents, Desktop, AppData, and on every
drive from C: to F: under `ComfyUI`, `AI`, `AI\ComfyUI`,
`ComfyUI_windows_portable` and `StabilityMatrix` — and one level inside each, so
`D:\AI\anything\ComfyUI` is found too. It records the folder **and which Python
layout you have**: the portable build keeps its interpreter at
`python_embeded\python.exe` and a from-source install keeps one at
`venv\Scripts\python.exe`, and Studio reads either. One question, asked once,
saved to `%USERPROFILE%\.aiplay-studio\settings.json`.

If you already run ComfyUI from a `git clone` with a `venv` beside it, you are
done — that is exactly the layout Studio expects.

⚠ **Do not run ComfyUI yourself while Studio is open.** Studio starts and owns
its own copy, on a loopback port it picks fresh at every start and does not
publish, and keeps it alive — which is what makes re-rolling a mix cost 15
seconds instead of 50. Two copies fight over the graphics card.

Full version, including what to do when it goes wrong: **[INSTALL.md](../INSTALL.md)**.

---

## Two video engines, and YuE2's Python build

Two video engines, and the shipped default is **MiniMax H3** — not because it is
the better one (LTX 2.5 renders a 5-second clip at 1280x704 in about 121 s against
H3's 660 s at 20 steps, and looks better doing it) but because it is the one Studio
can actually fetch for you. LTX's repository is access-gated; a default pointing at
it meant a fresh install opened the Video page, was told 39.7 GB was missing, opened
the Models screen, and found no button. H3 is also the one trained with a first *and*
last frame, which is what a seamless loop wants. If you go and fetch LTX by hand,
Studio renders on it — the engine resolves to weights that are present, preferring
your setting.

**Keeping a character.** On the Video screen, *Keep my character* takes a saved
character or 1–3 pictures of them and runs the reference build at its own step
count; on MiniMax H3, with pictures of the singer, *Song under the clip* is
lip-sync (on LTX mouths do not follow it). Measured 2026-09-24 (DIRECTING.md §2):
without pictures a person changes from clip to clip.

The full suite also offers a separate **Python YuE2** integration. Its editable
scores, memory figures and duration controls below do **not** describe native
GGUF. **MiniMax
Music 3** takes a caption and gives back a finished track; there is nothing in
between to argue with. **YuE2 3B** plans a *score* first — a two-voice ABC lead
sheet with chord symbols — and only then sings it, and Studio keeps that score
where you can read it and change it: reharmonise the chorus, move the tempo,
re-bar the meter, drop an instrument, and render again. The edit is free and
only the render is paid for, because a supplied score is honoured verbatim
rather than generated. The sheet engraves to a PDF you could put on a stand
(abcjs, MIT, vendored; printed by a headless Edge where one is present, and
where there is none the engraved HTML page is the artefact). Three things are
settled before anything leans on it, each measured rather than read off the
model card:

- **16 GB of VRAM, minimum.** The runtime reserves 2 GiB off the top of whatever
  card it is given, so a 12 GB card leaves 10 GiB against a measured peak of
  10.6 — it does not fit, and the row says 16 for that reason.
- **CC BY-NC 4.0 applies to the weights.** Studio conservatively labels YuE2
  output noncommercial / not for sale. Whether generated audio is covered
  adapted material is not settled here; this label is not commercial clearance
  or a claim that every output is automatically licensed by the weights' terms.
- **Length is emergent — there is no duration argument** — and three ceilings
  bind, in this order. The first two moved on 2026-09-11, and the table says
  by what:

| ceiling | set by | what it is |
|---|---|---|
| **4:25** | the 16 GB card, so far | Measured: six songs of 3:14 to 4:25 rendered on a 16 GB card, prefill peaks 8.3–8.7 GiB of the 13.99 the runtime allows. The old figure here was 2:48, and the reason was not the card: `nar.py:70` runs the synthesis prefill's attention over the whole song in ONE block on CUDA, so its memory grows with the square of the length (measured 3.58 GiB at 3:14, 11.8 GiB at 6:00). Studio passes a 512-token block instead (`--query-chunk`, the default), which holds it under 0.9 GiB all the way to the model's own stop — and is faster. Past 4:25 the box under the slider says "an attempt", with a projected peak labelled as an estimate. |
| **6:00** | the model's own stop — a default | The 9000-token generation cap at a measured 25 tokens per second of audio. The sampler stops emitting there unless asked for more, and Studio asks: a wanted length past 6:00 raises the stop (`--max-tokens`), clamped to what the plan's prefix leaves under the context window. The vendor validated nothing past 6:00; the box says so, and the model may still end the song on its own. |
| **16:23** | the context window | 24,576 positions, architectural. It does not fail — it clamps, so a longer request comes back as a finished file whose tail is built on positions the model has already used. The one ceiling you have to be told about, because the failure sounds like a song. |

`server/music/yue_fit.js` sorts a wanted duration into whichever of the three it
is about to meet. The mistakes met along the way — a `--budget` flag that is
secretly two settings, a doctor command that proves nothing, a score that
constrains the notes and not the length — are in
[`docs/ENGINE_TRAPS.md`](ENGINE_TRAPS.md).

If this studio makes money for you, the settled answers are **FLUX.2 klein** and
**Z-Image** for pictures: plain Apache-2.0, no addendum, no revenue ceiling, nothing
that reaches what you make. **TripoSG** and **UniRig**, the 3D pair, are MIT for
code and weights, which is why they were chosen over an alternative whose licence
writes the European Union out of the granted territory and extends the bar to the
meshes you generate.

---

## ACE-Step 1.5

A song model that runs inside ComfyUI's own nodes: the turbo build renders in 8
steps, takes lyrics in 50+ languages, and has a tempo, a key and a time
signature as real inputs rather than words in the style. **MIT**, and its authors
say of the output: *"You can strictly use the generated music for commercial
purposes."*

- Model card: [ACE-Step/Ace-Step1.5](https://huggingface.co/ACE-Step/Ace-Step1.5) ·
  code and licence: [github.com/ace-step/ACE-Step-1.5](https://github.com/ace-step/ACE-Step-1.5)
- The files Studio downloads: [Comfy-Org/ace_step_1.5_ComfyUI_files](https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files),
  the set ComfyUI's "ACE-Step 1.5 (split 4B)" template loads. 14.7 GB:
  `acestep_v1.5_turbo` (4.8 GB, diffusion_models), `ace_1.5_vae` (0.34 GB, vae),
  `qwen_0.6b_ace15` (1.2 GB) and the planner `qwen_4b_ace15` (8.4 GB, text_encoders).
  `qwen_1.7b_ace15` (3.7 GB) is the lighter planner and counts instead. The repack's
  card tags `apache-2.0` with no licence text behind it; the catalogue follows the
  upstream MIT LICENSE.

**On the Music tab** (pick "ACE-Step 1.5 · turbo" in the model list), under
*ACE-Step Options*:

| control | what it sets |
|---|---|
| Tempo, Key, Time signature | the encoder's `bpm`, `keyscale`, `timesignature`. Blank reads them from the style line ("92 BPM", "F# minor", "3/4"), else 120 BPM, a key picked from the seed (a re-roll keeps it) and 4/4. |
| Lyrics language | the encoder's `language` (51 codes). |
| Steps, Guidance | the sampler. Blank uses the template for the model: turbo 8 / 1, XL base 50 / 6, XL SFT 50 / 7. |
| Planner, planner temperature, planner model | `generate_audio_codes`: a language model writes the song's audio codes before the DiT renders. Slower, usually better. |
| LoRA, strength | `LoraLoaderModelOnly` on the DiT. |
| Cover a song | a Library song or a file, re-performed in your style and lyrics. |

Length is a setting here (10 s to 10 minutes, as ACE-Step documents), and an
instrumental is `[Instrumental]` in the lyrics, which is ACE-Step's own way.

**Covers** use ComfyUI's *Set Reference Audio* node (`ReferenceTimbreAudio`,
marked experimental in ComfyUI): the song is encoded with the ACE VAE and set on
the conditioning, and ComfyUI's ACE-Step 1.5 model treats the render as a cover.
The planner is off for a cover, as the node's own tooltip says to do.

**LoRAs** go in `models/loras`. ComfyUI loads ACE-Step's official LoRA layout
(`base_model.model.layers.N.…`, e.g. [ACE-Step's own example](https://huggingface.co/ACE-Step/ACE-Step-v1.5-chinese-new-year-LoRA)).
A file whose prefix is nested more than once cannot be mapped by ComfyUI at all, so
Studio lists it disabled and says why instead of letting it silently do nothing.
With a LoRA the planner switches off by default, because ACE-Step's LoRA card says to
render with the DiT alone. **A LoRA has its own licence**: ACE-Step's example forbids
commercial use even though the base model allows it.

**Not here:** Extract, Lego and Complete, which ACE-Step documents as base-model
tasks, and no timing has been measured on this machine yet.

---

## Chat — the first screen

*Chat can also answer through a connected API model (Claude, ChatGPT or any
OpenAI-compatible server), chosen on the Chat screen or in Settings. What
follows describes the local path, which is the default.*

The app opens on it. Type what you want to make in ordinary words and it uses
the studio for you.

The model answering is **Qwen3-4B** by default — `qwen_3_4b.safetensors`, the
8.0 GB text encoder that already came down with the cover artist — run through
ComfyUI's `TextGenerate` node, on your own graphics card. The **Model** dropdown
in the Chat header picks any other chat-capable text encoder ComfyUI can load
(a Qwen3-VL build, or a GGUF through ComfyUI-GGUF). There is no account, no key and
nothing leaves this machine. If you can draw covers, you can already chat: it is
the same file and there is no second download.

**It knows eight tools, and eight is a budget rather than an oversight.**

| tool | what it does | cost |
| --- | --- | --- |
| `make_song` | caption + lyrics → a rendering song | **spends** ~4–5 min of GPU |
| `song_status` | how one song is doing, by job id or file name | free |
| `list_library` | the tracks already on this disk | free |
| `make_image` | a description → one picture in the Images library | **spends** ~10 s of GPU |
| `list_images` | the pictures already on this disk | free |
| `mv_create_project` | start a music-video project | free |
| `mv_previz_shot` | block a shot in Blender, grey boxes to watch | **spends** ~25 s of Blender |
| `mv_control_check` | is this clip legal to steer a render with | free |

These eight are written *for* a small model: short sentences, the rule stated
rather than implied, the failure named. `make_song`'s paragraph carries the
three-part caption rule and the fact that output length tracks lyric length;
`mv_control_check`'s carries all three numbers of the clip contract, because all
three fail silently.

**And it reaches the other 233 a few at a time.** The full MCP surface is 241
tools whose descriptions come to about 100,000 tokens — three times what this
model can read at once, so pasting the library in is not a thing that can be done
badly, it is a thing that cannot be done. But the *names* are 3,860 characters.
So your message is matched against all 241 names and one-line summaries in plain
JavaScript, costing no model call and no GPU, and only the six that fit are
described in full. Ask to upscale a picture and `image_upscale` is there; ask
about your mix and the mastering analyser is. The eight written tools are never
displaced, so a bad match costs you nothing.

Two rules make that safe, and both are enforced by a test rather than a
convention. **Not one of the 241 declares whether it spends** — so the cost of
every reachable tool is typed out by hand in `server/chat/router.js`, a tool
nobody listed is unreachable, and 24 tools are withheld on purpose with the
reason written beside each. Deriving the cost from the tool's own source was
tried and is wrong in the direction that matters: it called `avatar_import` free.
**And a tool that removes something is never volunteered** to a person who did
not ask for anything to be removed, because a delete put in front of someone who
was asking about something else is how a confirm box starts getting a reflexive
yes.

**Nothing that spends is done without you saying so.** A tool marked *spends* is
never called in the turn it is proposed. The loop stops and shows a decision card
carrying the tool, the exact cost sentence and the exact arguments, and waits —
and when you say yes it runs *those* arguments, with no second model call, so
nothing can change between the plan and the approval. Changing the subject is not
consent. The gate lives in `server/chat/loop.js`; the confirm button on the page
posts a body byte-identical to a typed yes, and its cancel was measured to run
nothing.

That gate is not decorative. Driven adversarially against the real model, the
prover found the exact defect the design exists to prevent: the model's argument
names drifted by a leading space and were silently dropped, so a confirmed spend
would have rendered something other than what the confirm box promised. That and
five others are fixed and pinned — a busy gate that sat below the confirm branch,
one yes buying two songs, a reopened conversation giving the model amnesia.

**One card, one queue.** The graphics card is shared with every render in the
app. Before the model is asked anything the engine door's own status is read,
and a busy card ends the turn with a sentence saying your message will run when
the render frees it — rather than silently queueing a chat behind a 32-minute
VACE pass, which looks exactly like a chat that has hung.

**The panel.** The assistant's turns render markdown — headings, nested lists,
quotes, links, code fences with a language chip and a copy button — with no
dependency and no build step. Its safety argument is the order it works in: every
character is escaped before any formatting rule runs and code spans are lifted out
and restored last, so no rule can emit a tag the model asked for. A reply
containing a script tag, an image with an error handler and a javascript link
renders all three as visible text; that is pinned by a test and was confirmed in a
browser with the console watched.

**What it cannot do.** It is a 4B on a home card, not a frontier assistant. It
answers flat JSON reliably and nested JSON not at all (measured — the same
finding `server/mv/sfxcue.js`'s cue judge is built on), so every argument of
every tool is a plain string, whole number or true/false, and the tools that
need a nested spec are deliberately not offered here. Malformed output gets one
re-ask and then a plain "I could not form a tool call" rather than a third
attempt on a shared card. Six model calls is the budget for one message. Latency
on this card is about a second for a short reply and twelve for a long one, after
an eleven-second cold load.

The panel streams the loop's **phases** — thinking, the tool it called, what the
tool said, then the answer. It does not stream tokens, and does not pretend to:
`TextGenerate` returns its whole string when the graph finishes, so there is no
partial decode to forward, and no amount of front-end work changes that. Fenced
code is monospace and uncoloured. Conversations are kept as JSONL under the
app-data folder, one file per conversation, appended as each turn happens.

---

## What it does

Native music-only generates lyric-driven WAV songs. The wider features below
belong to the full suite and may require ComfyUI, Python or additional models.

- **Write a song** from a style description and lyrics, or an instrumental from
  a structure.
- **Write a song you can read before you hear it** — the second music engine,
  YuE2, plans a two-voice lead sheet with chords before it sings, and the sheet
  is yours to edit and print. This is the optional Python integration, not the
  native GGUF engine; Studio labels YuE2 output conservatively noncommercial.
  See *The models* below.
- **Re-roll the mix** — same performance, new render, ~60% of the cost.
- **Extend** a take, branch it, and merge the branches back into one song.
- **Start from an existing song** — see *Audio reference* below.
- **Continue from a recording you already have** — experimental, opt-in, and it
  needs a runtime you install yourself. See *Music input* below.
- **Cover art** drawn automatically while the GPU is idle, on the engine you
  pick in Settings.
- **Standalone images** on six engines — FLUX.2 klein, Z-Image Turbo and
  Z-Image base, Anima, the open Ideogram 4, or any checkpoint of your own. Drop
  a `.safetensors` in and the shelf reads its architecture out of the file's own
  header, sets the sizes and step count that architecture actually wants, and
  says plainly when a file cannot be loaded and why. See *Images* below.
- **Stems** (drums / bass / vocals / other) and **timed .lrc** files for visualisers.
- **Video clips** under a finished track, on either of two engines.
- **A camera you block yourself** — lay out a shot in Blender, render a grey
  blockout at the control contract, and have the video model follow that move.
  See *Blocking a camera, and steering a render with it* below.
- **A 3D mesh from one picture** — TripoSG, MIT, about a minute on this card.
  See *A picture becomes a 3D model* below.
- **A small editor** — stacked tracks, drag clips to overlap them into a
  crossfade, a karaoke overlay driven by the timed lyrics, and a visualiser.
- **Overnight runs** — songs, images or video: a list of ideas, N takes each,
  and a full library by morning. The panel sums the whole queue and tells you
  what time it will finish, so a night can be planned against the hours you
  actually have. Repeats are caught and re-rolled, so a forgotten fixed seed
  makes different pictures instead of one picture two hundred times.
- **Audio-reactive video** — pictures that move with a song: cut or dissolved
  on the bar, breathing with the bass, a flash on the beat, five looks. Rendered
  by the Studio's own compositor, so it needs no video model and runs on any
  card (AMD included). See *Reactive* below.
- **An MCP server** — an agent can drive all of the above. See *Drive it from
  an agent* below.
- **A DAW** — a server-rendered arrangement window with a piano roll, 19
  instrument packs and 39 patches (drum kits, basses, guitars, sitar, flutes,
  handpan, sax, cello, pianos), a mixer with inserts and sends, recording with
  latency calibration and comping, and mastering with delivery checks against
  each platform's loudness targets. See *The DAW* below for what it costs and
  what it exports.
- **A compositor** — After Effects-shaped: 3D layers with cameras and lights,
  masks, mattes, expressions, motion blur, particles, text animators,
  precomposition, effect presets, point tracking, and audio-driven keyframes.
- **A full image editor** behind the gallery — layers and blend modes, curves,
  levels, HSL bands, selections and paths, brushes, shapes, type, chroma key,
  cutout, upscale, SVG trace, collage and batch.
- **An avatar review bench** — import a rigged GLB, have it validated twice,
  orbit it and play its own clips before you trust it. See *Avatars* below.
- **LoRAs and personas** — stack LoRAs with per-LoRA strength. The picker reads
  each LoRA's base architecture and marks the ones that do not fit your
  checkpoint, disabling them, because a mismatched LoRA renders with no error
  and no effect. Save a character as a persona and put the same face in a new
  scene.
- **Dynamic prompts** — `{a|b|c}` picks one option per render, and the choice is
  recorded beside the seed so a picture from an overnight run can be made again.
- **Provenance** — a hash-chained ledger with honest actor attribution, an AI
  marker that has no off switch and none may be added (EU AI Act Article 50(2)
  puts the marking duty on the tool's provider), and per-model output rights
  stamped at generation time so you know before you render whether you may sell
  what comes out.
- **A minigame** for while the queue renders — 2248, the connect-merge number
  game, on the Games screen. The ruleset (and why a chain rounds *up*) is
  written out in the header of `web/games.js`.

Nineteen screens, each with its own information panel saying what it needs, what
it makes and — in its own words — what it **cannot** do. A build-failing census
makes sure a new screen arrives with all three rather than none.

Post-processing never competes with music: it runs only when the queue is empty,
and music always preempts.

---

## The engine door and the ledger

**One way to the graphics card, and a record of everything that went through it.**

The measurement this exists for is at the top of
[`docs/ENGINE_DOOR.md`](ENGINE_DOOR.md): 426 files written in a day, 424 of
them with no ledger entry, 85 of those sitting in the folder the library already
listed — so the app could show you a clip and say nothing whatsoever about it. No
model, no prompt, no seed, no actor.

**How it is closed.** ComfyUI runs as a child process on a loopback port the app
picks fresh at every spawn and never advertises. `server/engine/client.js` is the
only file in the tree that knows the number, and a census fails the build if any
other file names it, a ComfyUI route, or the port setting. Everything inside the
app goes through `engine.dispatch()`; everything outside goes through
`POST /api/engine` with an actor header naming itself (`script:<name>`,
`agent:<name>`, or a browser recognised by its origin). Nothing invents an actor
for you: filing renders under a name meaning "the app did this on its own" is not
a smaller lie than no record, it is a more convincing one.

**What is recorded**, two events per prompt, both in one hash chain. The
**delegate**, written *before* the POST and awaited with no `catch`: the graph
(hashed with sorted keys and stored whole under that hash), the resolved positive
and negative prompt verbatim, every sampler's seed, steps, cfg, sampler and
scheduler, the size, frames, fps and seconds, every model and LoRA file with its
bytes and date, every reference image's SHA-256, who asked, which project and
shot, and how exposed the engine was at the time. The **generate**, written after
the terminal poll: the status, the error, the wall time, the queued time, the
render's own time, whether ComfyUI served it from its own cache, and every file
written with its bytes and SHA-256.

**Three timings, because one number cannot answer both questions.** `elapsedSec`
is what you waited, `queuedSec` is what the engine spent finishing somebody
else's render first, and `runningSec` is the only one about your render — and the
only one a deadline is checked against. A job waiting its turn behind a
half-hour pass is not late. That distinction is not theoretical: one real run sat
pending for most of thirty minutes, ran, wrote its files, and was recorded as a
timeout, because the clock had been started at queueing.

**A cancel is addressed at one prompt.** Pressing Stop used to call the engine's
global interrupt and clear its whole pending list, so a chat turn queued behind a
song vanished when somebody cancelled a cover — and the ledger recorded it as
`vanished`, which is this door's word for *a ComfyUI restart discarded it*.
Nothing had restarted. Cancel now resolves the run to its own prompt id and asks
the engine to cancel that one, under its queue mutex; `cancelled` is its own
ledger status, distinct from `error` and from `vanished`, and every other run in
the queue keeps its place.

**Weight hashing is an explicit choice.** Every render records
`{file, bytes, mtimeMs}` for every model input — free, and enough to notice a
swapped file. The full SHA-256 is the only thing that *proves* which weights
rendered a clip and costs about ten seconds per file the first time each one is
seen, so it is **off by default**, with that sentence next to the toggle.
Reference images and outputs are hashed always.

**The Engine screen** is this looked at from the front: the activity list, one
run's whole record, the graph itself, the graph store's size, and a Reveal
control that hands you the port number and **appends a dated event saying it
did** — so the ledger can honestly say "at 02:14 the port was revealed; renders
after that may have bypassed", which is the whole difference between an invisible
bypass and a visible one.

**What it does not defend against, stated rather than implied.** ComfyUI ships no
authentication of any kind. Binding loopback means nothing off this machine can
reach it; on this machine, anything can, and an ephemeral port does not change
that. What it changes is that nothing can find it by *guessing* — and guessing is
exactly what a second copy of this app, a stale script with a number baked in, or
a person following an old note actually does. Two exceptions are named rather
than hidden: the 3D stack is a deliberate **second door** with its own Python
that writes the same two ledger events and carries a `door` field saying so, and
the engine's own port is the only one anything renders on.

> That sentence used to end "and the optional Reactive engine on its own port
> writes **no** provenance at all." Both halves stopped being true on
> 2026-09-18, when Reactive became a recipe over `server/vfx` and its two
> diffusion looks moved onto the main engine. There is no second port, and
> `/api/reactive/run` stamps the actor from the request like every other door —
> `server/provenance_test.js` fails if it stops.

---

## Blocking a camera, and steering a render with it

A storyboard has two doors onto camera movement and they are opposites, which is
worth getting right before you spend anything.

**Previz** blocks the move in Blender and hands you a grey-box clip to watch.
**Control** puts a clip on WAN 2.1 VACE's `control_video` and the render follows
it. The important recent change is that a blockout can now be rendered *at the
control contract* and walk through the second door — so previz is no longer
strictly for your eyes only. What has not changed: feed a blockout to LTX's
**appearance-guide** path and it hands the grey boxes back. That was measured and
it is a decisive negative. VACE is the door that carries the camera.

**What a blockout provably gives: the camera, and where things stand.** One arm
of a ten-arm gate, WAN 2.1 VACE 1.3B fp16, `control_video` wired, strength 1.00,
at 1280x704 / 24 fps / 121 frames:

| number | measured | bar | reads as |
|---|---|---|---|
| CMA, camera-motion agreement | **0.924** | floor 0.50; the arm's own time-shift null 0.402 | the blocked move is being carried |
| MR, motion ratio | 0.82 | inside [0.4, 2.5] | it moves about as much as the blockout |
| SSIM against the blockout | **0.524** | bar 0.736 | **generated, not reconstructed** — the one that matters |

Every cell is the median of three seeds (CMA 0.916 / 0.924 / 0.942), and per seed
the SSIM was 0.661 / 0.524 / 0.519 — all three under the bar, so the verdict does
not rest on the median alone.

⚠ **0.402 is that arm's own null**, its motion agreement recomputed with the flow
shifted in time — not a control-off arm. The arms that really turn the control
off scored **−0.056** (strength 0.00) and **−0.019** (no wire at all). Reading
"0.924 against a null of 0.402" as "switching the control off still buys 0.4" is
wrong; it buys nothing.

**Strength is a gain on a residual, not a "how much Blender" dial.** The usable
window is **0.5–1.0** and the model was trained at 1.0, which is the shipped
default. The ladder was rendered rather than guessed: 0.25 does nothing and the
layout is lost, 0.50 passes softly, 1.00 is the table above, **2.00 tracks the
move and hands the boxes back** (SSIM 0.889), 4.00 collapses.

**The contract has three numbers and all three fail silently.** Exactly
**1280x704**, exactly **24.000 fps** (compared as a rational, so 24000/1001
fails), and at least **121 frames**. A wrong size is bilinear-resampled and then
centre-cropped with no warning, so your framing is gone; a short clip is clamped
and padded with flat mid-grey, so the end of the shot conditions on nothing;
nothing in the path reads fps at all, so a 30 fps move is silently retimed.
`validateControlClip()` measures all three with ffprobe, counts frames rather
than trusting the container, and refuses by name and by number.
**`mv_control_check` runs exactly that validation for free** and the expensive
button stays disabled until it passes.

**A blockout is placement and camera. It is never an actor.** A grey-box figure
renders as a dark slab at every strength in the window. Three renders of a
two-figure blockout put something dark at both figures' projected positions on
every frame and nothing that reads as a person: DWPose, which finds a person on
121 of 121 frames of real footage on this machine, found 1, 0 and 0 of 121. The
strength sweep only darkened the frame. **Strength is the wrong knob** — a
recognisable person needs the pose path (a real clip → DWPose skeleton →
`control_video`, with a single-panel sheet as `reference_image`), and that path is
proven for the **upper body** only: one render, one seed, mean joint error 33.7 px
over 803 joint pairs against nulls of 119.9 px (frozen) and 157.3 px (reversed).
Not proven for legs, for hands, or at any strength but 1.00.

**Read the framing off the sidecar before you spend.** The blockout writes every
figure's projected neck and hip per frame, computed with per-frame intrinsics
because a push-in ramps the lens — checked against Blender's own projector to
under a thousandth of a pixel. On the first four shots put through this path, a
figure standing 125–148 px tall in a 704 px frame covered **0.46–0.59% of it**,
and at half a percent the model is not painting a performer, it is painting a
bright sliver on a column. Thirty-five minutes buys a beautiful empty stage. The
number is already in the sidecar; it is the cheapest shot note in `DIRECTING.md`.

**Costs, measured on this machine.** A 121-frame blockout renders in **3.34–4.10 s**
in Blender, **7.1–7.5 s** wall through the route including Blender's launch. The
VACE render on the other side is the most expensive thing in the application: the
app's own graph builder completed in **31.99 minutes** (seed 424242, 2026-09-03),
and the first toolkit blockout through the route completed in **34.99 minutes**
(2026-09-05) and came back a legal control clip in its own right.

**What has not been measured, said plainly.** That 34.99-minute render was
**watched, not scored** — no CMA, MR or SSIM was computed on it, and by this
repo's own standard that means it proves nothing about agreement. What watching it
supports is the division of labour: the crane, riser, towers, truss and pedestal
all arrived where the blockout put them, and the model supplied the haze, the key
light and the glow, none of which the grey boxes contained. Consistency across
clips is what the shared Blender scene imposes and nothing more — it transferred
as geometry, at tens of pixels, and **nothing transferred as a person**.
**Identity across shots is unmeasured** — not measured and failed; unmeasured,
because there was no character to measure.

**Two guards worth knowing.** A blockout is never adopted into the shared clip
library, because that shelf is one mis-click from the finished film; the control
route resolves it as *this shot's* own artefact. And pose extraction on a blockout
is refused by name, because DWPose would find no person on grey capsules, write a
skeleton of empty frames that **passes the clip gate**, and steer the render with
a blank.

**Licences travel in pairs here and neither speaks for the other.** WAN 2.1
VACE's weights are verified Apache-2.0 and a clip is yours to sell; the DWPose
*estimator* has no readable licence at all — a 28-byte model card — so the two
pose modes carry that admission on the card and the app refuses to claim rights it
cannot read.

**The third door is depth (18 September 2026).** Depth Anything V2 reads a clip
into a depth video — where everything is and how far, nothing about what it looks
like — and VACE steers with that: the person, the room and the move survive, the
prompt and a reference supply the look. It is the structure half of a
video-to-video restyle (a dancer repainted, the room kept). Mode `depth` on the
control card and on `mv_control_render`; `extract_depth` / `mv_depth_extract`
writes the depth video alone into the clip library so you can look at it first.
**Two models, two licences:** Small (the default) is Apache-2.0 by its authors'
own statement; Large is CC-BY-NC-4.0, non-commercial, and the record says which
one made each depth video. The node's own default is Large; the app never
inherits it. ⚠ **Unscored:** no depth arm has been measured against a null — the
pose gate's number does not transfer, and the card says so.

**Any 720p (or other) video can be the source.** The gate still refuses a clip
that is not 1280x704 at 24.000 fps with 121 frames, by number — and `conform`
(`mv_control_conform`) is the mode that makes the numbers right: scaled to cover
and centre-cropped (a 1280x720 source loses 8 rows top and bottom, never gains
black bars), retimed to 24, sound dropped, cut to exactly the 121 frames (5.04 s)
the render uses — from a `start` second you choose — and written to the clip
library as a NEW clip whose name says what it is, then measured by the same gate
before it is reported. Free, ffmpeg on the CPU. Measured: a 1280x720 46 s clip at
24.044 fps conformed in 9.9 s.

The Blender toolkit itself is a separate GPL-3.0 project, deliberately kept
outside this Apache-2.0 tree and reached only as a subprocess that writes files
to disk. That boundary is the whole arrangement: no file importing `bpy` may
enter this repository. It is optional, and every capability that needs it
degrades to a plain sentence when it is absent. The
set list and the per-set mesh inventory are **asked of the toolkit** rather than
typed here: five files once hand-typed the same seven set names while the toolkit
had eight, so a set that rendered perfectly from the command line could not be
reached from the app at all.

The full write-up, with every null and every condition, is
**[`DIRECTING.md`](../DIRECTING.md) §5**.

---

## A picture becomes a 3D model

Cast a prop or a character as a reference sheet, press **Mesh** on its row, and
**TripoSG 1.5B** turns that one picture into a `.glb`. MIT code and MIT weights,
no gate, no territory. A mesh is the strongest form of the identity a sheet only
approximates — it is the same object on every render by construction.

**Measured by running it**, 2026-09-06: a character sheet through the route in
**63.5 seconds**, a 35 MB GLB of 985,072 vertices, staged on that asset's row,
with both ledger rows written. Nine defects fell out of that one real run and
four were fatal; the worst is worth recording, because it is an argument for
running the thing: the container magic was typed with a capital G, so the reader
rejected every genuine GLB in existence — and it passed a forty-assertion suite
because the fixtures held a copy of the same wrong number.

**What comes out is coherent and not yet clean.** The figure reads from every
angle; it is 247 separate bodies of which the figure is 92 percent, it is not
watertight, a heuristic matte baked the ground reflection into a plinth, and the
geometry comes out of the hierarchical marching-cubes decoder rather than
TripoSG's own flash decoder, which will not build on a box with no MSVC. There is
no texture, which is the point rather than a shortfall: what a cast prop needs to
hold is its shape.

**It is a second door and says so.** The engine's Python is pinned — the music
model's fused int8 kernels exist only on that torch build — and a `diffusers`
install into it does not fail, it succeeds and then kills a song render hours
later somewhere that says nothing about a mesh. So the 3D stack lives in its own
virtual environment and is reached the way Blender is, by subprocess and files. It
writes the **same delegate/generate pair** the engine door writes, in the same
order, with the same actor discipline and the delegate awaited with no `catch`,
and every record carries a `door` field naming itself a second door.

**Five refusals, each one sentence and each costing nothing:** the weights are
absent, the runtime is missing, the input is not an image by extension *or* by its
first bytes, the picture is a contact sheet rather than one subject, and the card
has less free memory than the row needs — which says the music and video engine is
resident rather than dying in an out-of-memory forty seconds in. The memory figure
is measured rather than quoted: with more than 12 GB free the three modules stay
resident together, and below that the run pages them in one at a time and peaks at
**3,157 MiB** of torch allocation. The publisher's stated 8 GB was refusing runs
on this card that then fitted in a quarter of the memory it demanded.

### Rigging is present, and it refuses on this class of machine

**UniRig** (MIT, 5.8 GB) predicts a skeleton and solves skinning weights onto it,
writing the result back into the `.glb` as glTF joints and inverse bind matrices.
It is catalogued, its weights are downloaded and hashed, and on this machine it
**refuses in under a second** rather than spending a whole mesh and failing on an
import.

UniRig originally refused with thirteen reasons. Twelve are now satisfied — the
root of it was the interpreter, because the Blender module publishes a wheel for
Python 3.11 and none for 3.10, so a checksummed 3.11 and a fourth virtual
environment were built beside the three that already exist (TripoSG wants
transformers 5.16 and numpy 1.22 where UniRig wants 4.51 and 1.26, so sharing one
would have broken the meshing that already works).

The thirteenth is **refused on purpose**. Flash-attention is genuinely required —
the skin model imports it at module scope and uses it as the bone-to-point
cross-attention, and the single upstream entry point pulls that module in even for
the skeleton stage. There is no official Windows binary anywhere: the package
index ships a source archive and no wheels for any platform, and building it wants
a compiler toolchain this machine does not have. Deleting the import, vendoring a
replacement or shimming a fake module would each change what the model computes
while letting the probe report success. So it fails honestly on one named module,
and the refusal names it. `AIPLAY_UNIRIG_PYTHON` points at a compatible
environment if you have one; the adapter installs nothing and downloads nothing.

**Readiness stopped meaning "a file exists."** It used to be decided by asking
whether checkpoints were on disk, so the Studio reported that it could rig while
the rig itself refused with thirteen blockers — one millisecond against thirteen
seconds, and because the interpreter path had a fall-through the check could not
fail even in principle. Readiness now means the files **and** a probe that
answered yes, and there is a third state: **unchecked**. A cold process reports
unchecked rather than ready, because an unasked question is not a yes.

**A rig is refused unless the vertices really move.** A file can carry a skeleton,
bind matrices and a skin that names joints and still deform nothing, because the
vertices were never bound to it. The validator opens the binary chunk and decodes
the joint indices and weights for real — honouring interleaved strides, sparse
overrides, normalised integer types and the component type — and refuses a mesh
whose vertex weights sum to zero, whose joint index falls outside the skin, or
that claims a skin without both attributes. That check existed in JavaScript and
was index-only in Python, which mattered because the Python half is the last gate
before the rigged file replaces the original **in place**: a degenerate rig would
have destroyed the mesh it was meant to improve. Both halves now decode the same
bytes, driven against 38 hand-built fixtures and agreeing on all 38, with 26
refusal sentences identical word for word.

And one thing that proves what no validator can: two files were built identical in
every structural respect — same skins, joints, bind matrices, vertex attributes
and weight sums — where one deforms and the other does not. No amount of parsing
separates them. Only moving a bone and measuring whether the vertices follow does.

### Avatars — the screen that reviews rather than creates

Import a self-contained `.glb` and it is checked twice: once by the Khronos glTF
validator, and once against its own bytes for whether the skin is **real** rather
than merely declared. Then you look at it, which is the half no file check can do
— orbit the mesh, turn the skeleton and wireframe on, play the clips the file
brought with it and scrub them frame by frame. When it holds up, prepare a handoff:
the GLB and its manifest together, with who imported it and what they claimed
about its rights recorded beside it.

The limits are hard and small on purpose: **8 MiB, 30,000 triangles, four
materials, 96 joints**, and every texture embedded — because a rig that reaches out
to the network to finish drawing itself is not self-contained.

**What it is not**, in the screen's own words: it reviews, it does not create.
Nothing here generates a mesh, rigs an unrigged one, retargets a clip onto a
different skeleton or authors an animation — the character and its motion have to
arrive inside the file. A persona ID recorded here is an attribution you typed,
not proof of ownership and not an account binding. And passing the file checks is
the cheap half: whether the shoulders deform, whether the feet stay on the ground,
whether the walk stays in place and whether it still looks like the character are
judgements only your eyes make, which is why **every import lands pending** and
stays pending until you say otherwise.

Four `avatar_*` MCP tools, three `mv_mesh_*` tools.

---

## The music-video workflow

A song in, a cut video out, in eleven stages you can stop at any point:

**Draft → Upload & analyze → Creative interview → Script & direction → Story
review → Characters → Backgrounds → Storyboards → Video clips → Rough cut →
Finish & export.**

The analyse step cuts the track into scenes on its own beat grid and never
splits a lyric line. The **production bible** is the document that steers
everything after it — the story, the visual style, the reusable cast and
locations, and one storyboard per scene. Write it yourself in the form, or ask
the agent to draft it and edit what it wrote; both reach the same document, and
a scene's shot *action* is the field that actually writes the clip.

Characters and backgrounds are rendered once as reference sheets and then
carried into every scene that names them, which is what keeps a face the same
face across a three-minute video. References are dropped in order of
*prominence* when a scene names more than the engine can take. A cast row can
also carry a **mesh** and, where the machine allows it, a **rig** — see *A
picture becomes a 3D model* above; a mesh does not replace the sheet, because
the clip engine takes pictures. New projects put the song under every scene
(Song under the clip: always), so sung shots follow the words, and the lint
offers a one-click tick where a board names a character it does not carry.

Also here: a **crime board** view of the whole production, **b-roll** scenes fed
from your own clip library, per-scene **regeneration** that keeps every earlier
take, a **lint** pass that catches what would waste GPU before it is spent, a
**previz** bar and a **Control** card for the Blender path above, and a one-press
bridge onto the Studio timeline.

Planning is free; only rendering costs the card. Forty-six `mv_*` MCP tools cover
all of it, so the whole pipeline can be driven by an agent.

**What the pipeline enforces is a discipline, not a guarantee the model gives:**
names must be declared before a board may use them, and re-segmenting is
destructive on purpose — it versions the scene set and marks boards and clips
stale rather than quietly leaving them attached to a song that has changed.

## The audiobook workflow

A book in, narrated and mixed audio out: **Book in → Chapters & plan → Voice →
Narrate & mix → Complete.** It reads the book's own structure, skips front
matter, packs whole chapters into files of a target length without ever
splitting a chapter, and holds one voice for the whole book because that is what
keeps chapter forty sounding like chapter one.

Beyond narration it does **casting** with voice auditions, **sound effects**
scanned from the prose and judged before they are rendered, **emotion tags**,
and **mood beds** matched to the scene. Seventeen `ab_*` MCP tools.

---

## Audio reference — starting from a real song

*An earlier version of the README said this was impossible. That
was wrong, and the reason is worth stating.*

ComfyUI ships the DAV **decoder** only. `comfy/sd.py` raises
`"MiniMax Music3 DAV cannot encode audio"`, so there is no path from audio back
into the model's latent space — which is why local tools say covers and
references cannot be done.

But the encoder weights exist
([SimpleTuner/MiniMax-Music-3-Encoder](https://huggingface.co/SimpleTuner/MiniMax-Music-3-Encoder)),
and that checkpoint's **121 decoder tensors are bit-identical** to ComfyUI's
`minimax_music3_dav.safetensors`. Same latent space. So a latent encoded outside
the process is one the sampler already understands — no patching, no custom node,
no retraining.

Measured round trip through stock `LoadLatent` → `VAEDecodeAudio`:
**+26.26 dB SI-SDR, pearson 0.999.**

Drop a file into the Audio reference box in Create. The strength slider is the
length of the sigma schedule — keeping only the tail starts the flow partway
down, so less of the reference is destroyed:

| setting | what you get |
|---|---|
| 0.90+ | reference ignored (the trim removes under one step) |
| **0.85** | **a genuine blend — its shape, your sound** |
| 0.80 | the reference dominates; a variation of the same song |
| 0.60 | effectively a copy |

**What it is not.** The reference steers the *render*. The *composition* still
comes from your caption, through the autoregressive stage. So this gives "that
song's shape, a new sound" — not "that song's tune with new words".

And it is not the same thing as continuing a recording you already own. That
needs the model's own prefix representation rather than a latent, and the
experimental path to one is the next section.

Generality was measured too, since the encoder only ever saw music: MP3 128k
**22.0 dB**, MP3 64k 22.6, room reverb 23.9, mono 25.1, resampled through 22 kHz
25.2, loudness-war clipped 22.4, pitch-shifted +3 semitones 17.8. It holds up on
ordinary material.

---

## Music input — continuing from a recording (experimental, opt-in)

A track you already have can be handed to the song model as a **starting point**
rather than described to it in words: a chosen window of audio becomes the
model's own prefix representation and generation continues from there, so a bass
line or a bar of drums you like can steer a take instead of a paragraph of
adjectives trying to.

Read the qualifiers before reaching for it, because they are the feature's honest
shape rather than small print:

- **It is off by default and Studio installs nothing for it.** You opt in
  (`musicInput.enabled`, or `AIPLAY_MUSIC_INPUT=1`) *and* point a setting at a
  runtime manifest naming an adapter, an RVQ config and weights, and the DAV
  weights — files you install yourself. Nothing is downloaded automatically. The
  capabilities call reports exactly which requirement is unmet rather than
  offering a control that fails.
- **The prefix is approximate.** The route calls it an approximate HOT-Step RVQ
  prefix, and there is no guarantee of musical continuity, key, tempo or
  identity. It produces a **new segment** in the music library, leaves your source
  file untouched, and does not join the two for you.
- **Preparation is CPU-only**, in a subprocess launched with the GPU hidden from
  it, so it never competes with a render for the card. It takes 0.25–15 seconds of
  WAV or FLAC, up to 50 MB, and the continuation is capped at 30 seconds.
- **Local Music 3 only.** Hosted API mode has no latent to hand the model, so the
  route says so rather than failing at submit.
- Two neighbouring ideas — a latent refiner and inpainting — are marked
  **research only** in the same reply, with the reason: an isolated experiment ran
  and there is no supported Studio job. They are not offered.

Five `music_input_*` MCP tools: capabilities, prepare, status, continue, cancel.
Cancel stops that job's own CPU helper or withdraws its own prompt and never
touches anyone else's queued work.

### YuE2: any recording, through the real-audio tokenizer (20 September)

YuE2 has the same idea with a plainer shape, because its takes already carry
their own performance: a run folder's `semantic.npy` is what Extend replays.
What no take could give it was a recording from outside, since m-a-p never
published an encoder from audio back into those codes. A community one now
exists — Mothersuperior's realaudio tokenizer (Hugging Face, CC BY-NC 4.0):
MERT-v2-FullSong's layer-20 features at 25 Hz, instance-normalised per track,
through an 8-layer transformer head that predicts the code at every frame.
Its author measures 16 % exact codes on YuE2's own songs and hears round trips
near 95 %, which is the honest shape of it: the song as YuE2 would have written
it, close enough to continue, not a copy.

It is catalogued (*YuE2 real-audio tokenizer*: the 171 MB head and MERT's 2.5 GB
with its own modeling code, six files under `models/audio_encoders`), and with it
on disk **Extend works on any track in the library**: the recording is read into
codes once, kept by its bytes under `output/yue2/tok_<sha12>/`, on the CPU while
the card has a render in flight (30 s of song in 16 s, measured here) and on the
card otherwise; then the YuE2 Python engine replays the codes with no score
(`--extend-codes`, `cot` off unless an ABC is handed in) and the join keeps the
original up to the seam, as for a take. A style is required, since a recording
carries none; words are optional, none meaning an instrumental. Over MCP it is
`extend_song` on any file; `GET /api/status` reports the tokenizer under
`config.tokenizer`. Not measured yet: how well a continuation of a real
recording holds its key and feel — the codes' 16 % is a number about the
tokenizer, and the ear test is the author's, not ours.

**Covering a real song** is the two readings used together, and it is a
**Create rather than an edit** for one mechanical reason: the continuation's
finish keeps the source's own samples up to the seam, which is exactly right
for an extension and would put the original recording inside a cover. So a
cover goes to `/api/generate` with the song's score in `abc` and
`coverOf: { file, seconds }`, carries its lineage in a field nothing splices
on, and lands as one whole render. The prime defaults to **eight seconds**, not
the extension's eighty per cent, and that number has a measurement under it:
on this rig the tokenizer's codes carry 0.43–0.53 distinct codes per frame
against the model's own 0.68–0.73, and hold one code for as long as 8 frames
where a real trajectory never repeats more than twice. A long prime walks the
sampler off its own distribution and re-performs the original's arrangement
under a caption asking for a different one. On the page it is one slider in the
panel that already transcribes a library song — *Start from the original*, 0
meaning the score alone, which is the recipe that existed before the tokenizer.
The rights in the song being covered stay the caller's to clear; nothing here
does that for anybody.

**On ComfyUI's engine too, through a node of our own.** ComfyUI's
`YuE2GenerateMusic` has eleven inputs and none of them is a prefix, and its
token generation is sealed: the text encoder generates the codes, hands them
straight to the acoustic pass, and returns only their *count* to the graph. So
`server/comfy_nodes/aiplay_yue2_continue.py` reaches past the graph instead of
through it — it builds the same token dictionary the stock node builds, swaps
`encode_token_weights` on the model instance for exactly one call, and lets
ComfyUI do all the loading and offloading as it would have. The swapped
function is the stock one with the same four changes the Python kit's driver
makes: the codes offset into the vocabulary, appended to the positive prefix
and to the negative branch so guidance compares like with like, and prepended
to the generated codes before the acoustic pass. It costs more than the kit's
path, and the docstring says so: a continuation has no score to plan under, and
ComfyUI defaults guidance to 1.01 rather than 1.0 with the chain of thought
off, which turns classifier-free guidance on and doubles the cache. It is the
door that runs on an AMD card. ⚠ The node and the graph are wired and pinned;
the Studio route that would drive them is not built yet — the Python kit is
what `/api/extend` uses today.

**Three things follow from having the codes, and none of them needs another
model.** *One layer instead of the mix*: the Studio already separates a track
into vocals, drums, bass and other, so reading only the drums gives a groove to
build on and only the voice gives a phrasing to arrange under — `stem` on the
tokenizer, on a continuation and on a cover, with its own cache entry because
the cache is keyed on the decoded audio. *Replace a stretch of a recording*:
the same door that rewrites bars of a YuE2 take now rewrites bars of anything,
the original returning at the second handle. *And which of my songs sound like
this one*: every take and every read recording carries its codes, so the
library can be ranked by how it actually sounds with no tagging and no card —
the signature is how often each of the 32,768 codes is used, and the order is
thrown away, which means it answers "the same kind of sound" and firmly not
"the same tune". Measured here: a forty-second clip of a song put that song's
own continuation first at 0.56 and a second clip of the same song next at 0.25,
with unrelated takes at 0.11 and below. It is *Sounds like this* on a track's
panel and `sounds_like` over MCP.

Two companions from the same author sit beside it in the catalogue and load
through the Music tab's two LoRA doors: the **real-audio NAR LoRA** (the acoustic
half adapted to real recordings' tokens, on the audio LoRA picker) and the
**instrumental planner LoRA** (the composer trained on 2,700 instrumental tracks
with SheetSage2 scores; on the *Planner LoRA* picker, and picked by itself for an
Instrumental take on YuE2 through ComfyUI). The planner door is new: ComfyUI
holds YuE2's composer as CLIP, so a planner LoRA rides LoraLoader on the clip
wire with the model strength at 0, the audio model untouched. The hum-to-song
adapter from the same author (a prosody LoRA in the decoder, "intentionally
subtle" by its card, with ComfyUI nodes whose source is not published) is not
catalogued; our own hum-to-score path is its first stage already.

---

## Images

The Images screen is the cover-art pipeline given its own room: a prompt on the
left, a masonry gallery on the right — hover a tile for its prompt, seed and
render time. Six engines:

- **FLUX.2 klein** *(default)* — fast, Apache-2.0, and the only engine that
  takes **reference images**: the prompt refers to them as "image 1",
  "image 2" — "the character from image 1 in the scene from image 2" — which is
  how a character stays consistent across pictures. References are reachable
  through the API and the MCP tools; the screen itself has no attach control
  yet.
- **Z-Image Turbo** (Tongyi-MAI, Apache-2.0) — eight steps to a finished
  picture, strong on photographic realism, faces and bilingual
  English/Chinese prompts, and the cleanest commercial answer in the app:
  plain Apache-2.0 with no addendum. It shares FLUX.2 klein's Qwen3-4B text
  encoder byte for byte, so on a machine that already has klein it costs
  6.5 GB rather than 14.6. Measured here at 1024²: 21 s cold, 5.8 s warm.
  It has **no negative prompt** — it is distilled and samples at cfg 1.0,
  where the negative branch is never evaluated at all, so Studio refuses one
  rather than accepting it and doing nothing with it.
- **Z-Image base** — the same model undistilled: 25 steps at cfg 4.0, real
  classifier-free guidance, a negative prompt that works, and genuinely
  different pictures per seed where Turbo's stay close together. 23 s warm at
  1024². Reach for it when Turbo keeps drawing the same composition.
  Neither variant takes reference images: ComfyUI has the node, the
  checkpoints it needs (Z-Image-Edit, Z-Image-Omni-Base) are unreleased, and
  feeding one to the shipping weights returns the reference's composition
  covered in noise with the prompt ignored — tested, not assumed.
- **Anima** — small (1.4 GB) and a different hand again. The **model** licence is
  non-commercial; the pictures are sellable. Those are two different claims and
  the catalogue answers them separately, which is the whole reason it answers
  them separately.
- **Ideogram 4** — the open 9B release, a different eye: typography, posters,
  graphic layouts where FLUX paints. **Non-commercial licence**, stated above.
  The open weights are also **noise-locked** — only a sparse, deterministic set
  of seeds renders at all, and every other seed draws the model's trained-in
  refusal card regardless of prompt (measured: 1 in 23). So Studio renders from
  a list of known-good seeds (777 ships with it), and
  `scripts/harvest_ideogram_seeds.mjs` finds more overnight — they hold on
  every machine, because ComfyUI's noise is CPU-generated. Composition variety
  per prompt is the size of that list. Hunyuan Image 3.0 was evaluated for this
  slot and rejected: 48 GB of weights even at NF4, over this machine's memory.
- **Custom checkpoint** — any `.safetensors` in `ComfyUI/models/checkpoints`.
  The app lists, it does not curate; licences are the model author's. SD-class
  conventions apply: a negative prompt, and a real cfg (exposed on the API and
  MCP; default 6).

**The editor.** Click any tile. The browser only previews, with CSS
approximations; **Apply renders the exact edit server-side**
(`server/imagetools.py`) into a **new** file — the original is never touched,
and an agent calling the same tools produces identical pixels. What is in it:

- **Tone** — a histogram behind per-channel curves (monotone cubic, no
  ringing) with one-click auto-levels, plus sliders for brightness, contrast,
  saturation, gamma, temperature, sharpen, blur, vignette, and
  luminance-masked **shadows / highlights** recovery.
- **HSL color bands** — hue / sat / light per band, reds through magentas,
  45°-feathered.
- **Effects** — b&w, sepia, invert, posterize, non-local-means denoise, seeded
  film grain.
- **Type tool** — text in any TTF/OTF from the system font folder, with an
  outline, placed by clicking the image.
- **Crop, rotate, flip, exact resize.**
- **Chroma key** — pick the screen color on the image; it becomes transparency,
  with despill on the edges.
- **Background cutout** — BiRefNet (MIT): the subject stays, everything else
  becomes transparency. The one model the Models screen does not fetch — it
  wants `birefnet.safetensors` (444 MB) in
  `ComfyUI/models/background_removal`, and the button says so if it is missing.
- **Upscale ×2** — Real-ESRGAN, from the Models screen.
- **Vectorize** — posterize and contour-trace to SVG. Made for logos and flat
  art; a photograph comes out as posterized art, which is honest for what an
  SVG is.
- **Gallery blur** — a per-image privacy flag for screens other people can
  see. The pixels are untouched; a blurred tile reveals with one click.

No CMYK and no print pipeline — everything is RGB, made for screens.

---

## The DAW

A real arrangement window: tracks, a piano roll with its own ruler, mixed meter,
a mixer with sends and returns, automation lanes, 19 instrument packs and 39
patches, recording with latency calibration and comping, and a mastering chain.

**It renders on the server, so what you monitor IS the bounce.** The browser
never synthesises a note; it plays the file the server made. An assistant editing
the project over MCP writes the same document the window is looking at, and the
change appears while you watch it, tagged with who made it.

**The cost model is stated rather than hidden, because it reads as a bug until it
is named.** Once a project has a mixer chain, a region renders from the first
sample every time — a compressor's state at bar 125 is the sum of bars 1 to 124,
and history cannot be truncated without changing the sound. So the render is
**O(prefix)**: on a 128-bar, 7-track project with five stateful inserts, bars 1–4
cost **305 ms** and bars 125–128 cost **11,068 ms**, against 7,500 ms of audio per
region. That is exactly what makes what you hear identical to the bounce. The
transport carries a **readiness badge** that judges the next four regions from the
playhead — not the whole song, which on a 128-bar take was red from the first
frame forever while bars 1 to 4 were ready — and says which bars will arrive late
before you reach them.

Around that fact:

- **A one-note lane that answers in 4 to 12 ms**, so a velocity edit is heard as
  it is made, with its own hard ceiling on job length enforced at the route
  rather than trusted to callers.
- **The Voice Lab** — one note of one voice through its own chain, median 57 ms.
- **A ticker on a worker thread**, so a busy main thread does not stall the
  playhead.
- **THE EAR** — a critique pass that names bars and bands, with a
  reference-match critic whose cards name the knob and the amount. Matching a
  reference measures its **shape** and never copies it: dB, milliseconds and
  counts, per stem and for the mix, with no audio and no melody taken out of it.
  It needs the reference separated into four stems first, which is the Stems
  capability's demucs.

**Export is a choice rather than a fixed format.** FLAC or WAV, 16- or 24-bit,
with the loudness target (−30 to −6 LUFS, or null to switch the second pass off),
the true-peak ceiling (−12 to 0 dBTP, default −1) and the limiter budget (0–12 dB,
default 3) set **per export** instead of baked into the song — and the measured
loudness of the finished file is handed back. Bad settings are refused before
anything spawns, so a typo cannot half-write a file.

**Effect returns export as stems.** Per-track stems used to drop the reverb and
delay buses silently, so what you handed a collaborator did not add up to the mix
you heard. Each shared return is now its own file, and the reply says whether the
lanes reconstruct the pre-master mix and by how much they miss — and says plainly
when you exported a subset, because a subset cannot reconstruct anything.

**Region look-ahead.** A limiter with ten milliseconds of look-ahead has to hear
the transient that lands just *after* a region boundary, or a four-bar seam sounds
different in the editor than in the finished render. Regions now render past their
own end and crop back, and the note living in that overhang is pulled into the
earlier region's cache key, so editing it invalidates the audio before it. Proven
by PCM equality: a region rendered on its own is sample-identical to the same span
of the whole render, for the mix and for each track bus.

**One honest note on the export claim.** The bounce concatenates exactly the cache
files the editor streams, so parity holds by construction — but the test named for
parity compares no audio samples. The mechanism is right and the regression that
would break it is currently uncovered.

**What it is not.** Not a live-performance instrument: there is no client-side
audio engine, so a note you draw is heard after the server renders it. It is
instrumental — its synths render and its choir row refuses to, and the two TTS
voices speak and never sing, so a vocal comes from the music model and nothing
else here will do it. Stereo imports fold to mono at the import seam, by design
and documented there. It opens as its own page rather than a tab, because it owns
a window's worth of chrome and its own transport.

It needs three Python packages Studio can only partly check for you: numpy (which
it probes), plus SciPy and soundfile (which it cannot), installed with the engine's own python, not a system Python: `"<engine python>" -m pip install scipy soundfile` (the path under the launcher's "ComfyUI install" row; an engine Studio installed already has both). Fifty `daw_*` MCP tools, and a census
fails the build if a DAW route ships without one.

---

## The graphs are the product

[`workflows/`](../workflows/) holds the four core pipelines Studio submits,
exported straight from `server/workflow.js`. They are generated, not committed
— so the repo can never disagree with the graph builders — and
`node scripts/export_workflows.mjs` writes them, there and into
`ComfyUI/user/default/workflows/`, where they appear in the sidebar under
**AIPLAY**. Drag one onto the ComfyUI canvas, and re-run the export after
changing anything.

The values in them are the measured ones, not ComfyUI's defaults. That tuning is
most of what Studio knows, and it is free to anyone who opens the files.

---

## Why it is fast

**One long-lived ComfyUI process.** ComfyUI caches node outputs within a process,
and the expensive autoregressive stage depends only on
`(caption, lyrics, seed, max_duration, cfg, top_k)`. Restart per job and every
re-roll costs full price with nothing in the UI to explain why. Architectural,
not an optimisation.

**Two seeds, not one.** `seed` conditions the AR stage — *the performance*.
`mixSeed` is the diffusion noise — *the render of it*. Hold the first, change the
second, and you get the same take rendered differently, fast. Using one seed for
both makes an identical request a plain cache hit returning the very same file:
reproducibility, not a re-roll. That was a real bug, caught by testing.

**Two guidance scales, not one.** `cfg_scale` on the text encoder steers the
composition; `cfg` on the sampler steers the render. A single dial only ever
samples the diagonal.

**The backend assertion.** With a **cu128** torch build, ComfyUI silently disables
its fused CUDA kernels and falls back to eager — **4.9× slower**, one warning
line, no error. `comfy.js → assertBackend()` checks for exactly that, because a
slow app with no explanation is worse than a failure.

| | measured |
|---|---|
| engine start | ~15 s |
| fresh render | 39 s of audio in 65 s (**1.66× realtime**) |
| re-roll the mix | **50 s → 15 s** |
| cover art | ~3 s |
| stems (30 s track) | ~12 s |
| video clip (5 s, LTX 2.5, 1280×704) | ~121 s |
| the same clip on MiniMax H3, 1344×768 | 308 s at 8 steps · 660 s at 20 |
| a mesh from one picture (TripoSG) | 63.5 s |
| a 121-frame Blender blockout | 3.34–4.10 s render · 7.1–7.5 s through the route |
| a VACE control render at the clip contract | ~32–35 min |

---

## No GPU? API mode

**Ask a friend first.** Without a strong graphics card, the first answer is a
friend who has one: on **Collab** you add each other once, press **Ask friend**
beside a scene (Music video → Video clips) and send them the sealed file it makes;
they send the finished clip back as a file for you to look at before you keep
it. It is free, nothing connects to anybody, both of you run Full Studio, and it
lends video scenes, not songs. Lending is built but not yet tried between two
PCs ([Collab](COLLAB.md),
[Ask a friend to render](FRIEND_RENDERING.md)). A paid
service on your own key is the second answer. Both live on one Settings card,
**No strong graphics card?**, in that order; `cloud_status` gives an agent the
same answer.

Studio can drive a **hosted** MiniMax Music 3 instead of a local one, for
machines that cannot run the model. Same model, someone else's hardware, **your**
API key — Studio calls the provider directly from your machine, so nothing is
proxied through anyone and the account is yours.

Everything around the music is unchanged: library, cover art, timed lyrics, the
studio timeline, overnight runs.

Two things do change, and Studio says both in the UI rather than in a footnote:

- **It costs money per song, and every song asks first.** About $0.36 for three
  minutes. With the hosted engine on, a song is refused until that song's own
  confirmation says yes: the question names the cost, the key it bills and how
  much of the month's cap is spent. An overnight run on the hosted engine is
  asked for once, with the whole night's estimate. There is also a **hard
  monthly cap** — default $20 — checked immediately before every call, not just
  when a batch is queued. Nothing ever switches to a paid service on its own.
- **Audio reference and music input stop working.** Both encode a real recording
  into the model's own latent; hosted endpoints take text and return audio, with
  no latent to hand them. The control is disabled and labelled, not left to fail
  at submit.

Your key is stored with **Windows DPAPI** when DPAPI works, tied to your Windows
account and that machine — a copied `secrets.json` is inert anywhere else. It is
write-only across Studio's own HTTP boundary: the browser is told a key exists,
how it is protected, when it was saved and its last four characters, never the
key. If DPAPI fails, or on platforms without it, the key is kept as plain text in
`secrets.json` and the card says so, with where the file is and who can read it,
because file permissions are not encryption.

Off by default, and it cannot switch itself on.

### Your own key, and only yours

Studio uses a key only if you typed it into Studio: the Hosted engine's key and
the Comfy API key on the **No strong graphics card?** card (or the Comfy API
page), and the Agent page's language-model keys. Nothing reads a key from another
program's settings or from an environment variable — an exported `FAL_KEY`,
`MINIMAX_API_KEY` or `OPENAI_API_KEY` is never looked at. (`FAL_KEY` is also the
name Studio's own store files the fal key under; that is a record name, not a
variable.)

The store is `%USERPROFILE%\.aiplay-studio\secrets.json`, one per Windows
account, so every Studio folder on the account shares it. A key saved by another
copy of Studio is still yours, and it is shown rather than silently reused:
"Using the key …abcd saved on 21 Sep 2026 by another copy of Studio on this
Windows account", with Replace and Forget beside it.

The `AIPLAY_` variables near the paid path are switches you set yourself, and
none of them carries a key:

| variable | what it does |
|---|---|
| `AIPLAY_CLOUD_ONLY=1` | starts the Comfy API mode (the launcher's **Use Comfy API**, or `npm run start:cloud`) |
| `AIPLAY_FAL_BASE`, `AIPLAY_MINIMAX_BASE` | where hosted-music requests go, for a local mock or a relay you run; your key goes there too, so point them only at something you control |
| `AIPLAY_APPDATA` | where settings and `secrets.json` live (tests use it to stay off your real profile) |

The one credential Studio's own code reads from outside itself is Hugging Face's
login for the gated LTX 2.5 download: `scripts/fetch_ltx25.py`, which you run by
hand after `hf auth login`, asks `huggingface_hub` for the token that login
stored. It downloads, it bills nothing, and nothing in the running Studio uses it.

## Settings that are not up for negotiation

In `server/config.js`, each measured rather than chosen. The mistakes that
produced them — silent axis flooring, a vendor filename that does not exist, a
CFG pair that doubles your render time if you let it differ — are collected in
[`docs/ENGINE_TRAPS.md`](ENGINE_TRAPS.md), because a config comment is not
somewhere anyone reads before making the same mistake.

- **torch cu130+** — cu128 costs 4.9×.
- **fp32 VAE** — `bf16` measures +23.5 dB NMR (audible in 18.5% of tiles); `fp16`
  clips 100% of samples and destroys the audio.
- **euler + shift-5 sigma schedule @ 15 steps** — ~2× closer to the converged
  solution than the stock `euler@30`, at half the sampling time. Chosen by listening.
- **int8 DiT** — int8 vs fp16 scored against a converged reference: both 4.2 dB
  SNR, both +10.8 dB NMR. Identical to the decimal, half the download. So there is
  no model switcher — it would be a knob that only makes things bigger.
- **cfg 1 and 4 steps** on cover art — the model is distilled, and distillation
  *is* the removal of classifier-free guidance. Raising cfg breaks it.
- **H3 at native size AND a trained length** — 1344×768 with 124 frames, not the
  864×480 × 56 that shipped first. Neither change helps alone; together they
  measured 2.7× the detail (49.1 → 131.2). The node's own tooltip gives the
  trained range as ~124–362 frames, and asking for 40% of the native pixel count
  at under half the shortest length it has ever seen is what "vague and jittery"
  actually was. It costs ~300 s a clip instead of ~54 s, and the Video panel
  keeps the smaller sizes for anyone who would rather have the speed.
- **VACE control strength 1.00** — the value the model was trained at, and the
  one arm that passed all five criteria of the gate. The window is 0.5–1.0 and
  the ladder was rendered rather than guessed.

- **The turbo LoRA is actually loaded.** `config.video` named the file from the
  first commit and no node ever loaded it, so every clip ran the base model at
  8 steps. That single missing node is most of what people were seeing.

- ~~**shift_video 4.0**, not H3's 12.0 default~~ — **withdrawn.** That result
  (better loop closure 4/4, flicker 4/4) was measured on the graph *without* the
  turbo LoRA, i.e. on a model that barely followed the prompt, so it says nothing
  about the distilled path. The re-run on the shipping graph puts every metric
  inside the seed-to-seed noise floor, which suggests the original finding was
  noise. 4.0 stays only because it is the value the current renders were made
  with — not because it is better. See `scripts/h3_shift_resweep.mjs`.

Instrumentals need a structure, not an empty lyrics box — with no lyrics the model
has nothing to pace itself against and stops after ~30 s:

| instrumental input | audio produced |
|---|---|
| nothing | 32.5 s |
| 8 section tags, no words | **157.2 s** |

---

## Drive it from an agent

Studio speaks MCP. `node server/mcp.js` is the whole server — a thin, typed
face on the same HTTP API the app runs on (no SDK: the transport is forty lines
of newline-delimited JSON-RPC), pointed at a running Studio via `AIPLAY_URL`.
The in-app **Agent** screen has the exact config block to paste and builds its
tool list from the live server, so the two cannot drift.

**266 tools.** The bulk of them are the specialist surfaces — 50 `daw_*`, 46
`mv_*`, 46 `vfx_*`, 17 `ab_*`, 11 `engine_*`, 8 `score_*`, 5 `music_input_*`,
4 `avatar_*` — and this is the core:

| tool | one line |
|---|---|
| `studio_status` | engine health, what is rendering, queues, library size |
| `studio_welcome` / `studio_screen_info` | the same catalogue the welcome window shows, including what each screen cannot do |
| `models_for_this_machine` | what this card can run, with each licence and its output rights |
| `make_song` / `wait_for_song` | write and render a song; block until it is done |
| `list_songs` | the library, newest first, with what each track already has |
| `get_beats` | measured tempo, beat/bar grid and per-band loudness of a track |
| `score_get` | read a YuE2 score — one version's ABC with its tempo, meter, key, sections and check verdict; no arguments lists the scores on this machine |
| `score_check` | validate an ABC score without rendering — the dialect, every bar against its meter, the two native voices; pure text, no GPU |
| `score_edit` | write a new version from a whole edited score, parent pointer and your note recorded; runs `score_check` first and refuses an invalid or unchanged one |
| `score_mechanical` | the four edits that need no model to write ABC — `tempo`, `meter` (re-barred and proved note-for-note), `drop_instrument`, `sections` |
| `score_render` | spend the GPU on one version; returns a job id, and `score_get` fills in the render |
| `score_compare` | two versions side by side — what the bytes changed, computed, and the audio of both |
| `make_image` / `list_images` | draw pictures on any of the six engines; FLUX takes `ref_images` |
| `image_adjust` | the whole editor in one call — curves, HSL, effects, type, crop, chroma key — rendered to a new file |
| `image_cutout` | BiRefNet background removal → transparent PNG |
| `image_upscale` | Real-ESRGAN ×2; chain it for ×4 |
| `image_vectorize` | posterize + trace to SVG |
| `image_set_blur` | the gallery privacy flag, per image |
| `image_trash` | move an image to `output/trash` — reversible |
| `list_fonts` | the system TTF/OTF shelf for the type tool |
| `list_checkpoints` | the bring-your-own-model shelf |
| `set_video_engine` | pick LTX or H3, persistently — a decision, not a detail |
| `make_clip` / `list_clips` | render a clip; each engine's inputs are typed and mismatches are refused with the fix |
| `restyle_clip` | keep a clip's motion, restyle its look, driven by a song's bass |
| `build_music_video` | lay clips onto the bar lines and write a Studio project |
| `list_projects` | saved Studio projects |
| `engine_run_graph` | submit a ComfyUI graph of your own, through the door, recorded |
| `engine_activity` / `engine_run` / `engine_graph` | read the ledger back: what ran, one run's whole record, the graph itself |
| `provenance_read` | the hash-chained ledger for one asset |

Two things it cannot do, and both are said plainly rather than papered over. It
cannot export the finished video file: Studio's export is a real-time browser
capture of a canvas, so `build_music_video` writes a **project** and a person
opens it and presses Export. And an agent must be able to ask before spending
half an hour of GPU, which is why the free checks — `mv_control_check`,
`mv_mesh_status`, `engine_status` — exist as tools of their own.

---

## Layout

```
server/           config, the graph builders, the ComfyUI supervisor, the queue,
                  the image tools, the MCP servers
server/engine/    the one door to the card, and the record it writes
server/chat/      the local-model chat loop, its eight tools, and the router
                  that reaches the rest of the surface a few at a time
server/control/   the clip contract, the pose graph, the VACE builders
server/mesh/      image → mesh, the rig adapter, the GLB validators
server/daw/       the arrangement engine, instruments, mixer, capture, mastering
server/vfx/       the compositor — layers, effects, expressions, particles
server/welcome/   the screen catalogue every info panel is built from
web/              the UI — plain HTML/CSS/JS, no build step
workflows/        the pipelines, as ComfyUI can open them
scripts/          setup, the DAV encoder, and the measurement harnesses
examples/         one input beside the output it made, for each kind of thing
docs/             ENGINE_DOOR.md and the rest of the long-form record
                  (the previz Blender toolkit is a separate GPL-3.0 repository)
```

The measurement scripts ship on purpose. Every number above is a checkable claim,
and a claim nobody can re-run is just an assertion.

The **previz toolkit** is a separate GPL-3.0 repository with its
own repository and its own licence. Every file in it imports `bpy`, which the
Blender Foundation treats as making it a GPL-3.0 derivative of Blender — so it
is kept out of this Apache-2.0 tree's own commits and reached only as a
subprocess that writes files to disk. It is optional; the previz card says so
when it is absent, and every camera feature degrades to a clear refusal rather
than a broken render when Blender is not installed.

And [`examples/`](../examples/) is the other half of that: real requests with the
files they produced, so every pipeline above has a worked case rather than a
description. The requests were recovered from what the renders themselves stored
— a library record, or the graph ComfyUI embedded in the file — never written by
hand afterwards, and where an input genuinely was not recorded the manifest says
so rather than inventing one.

## Settings you can change

**Folders** (Settings → Folders) — where songs go, and where ComfyUI lives. Both
become launch arguments for the engine, so they take effect on restart. Stored in
`~/.aiplay-studio/settings.json`; `AIPLAY_RIG` and `AIPLAY_OUTPUT` override.

**Cover art** (Settings → Cover art) — which engine paints the library's covers
(FLUX.2 klein, either Z-Image, Anima, Ideogram 4, or your own checkpoint), and the
editable **style line**. Every auto cover prompt is two halves: the style line, then
`, evoking <subject>` — the subject taken from the song's caption with musical
notation stripped out (note names were getting carved into the pictures),
falling back to the title, and for untitled tracks to a rotating pool of
neutral objects indexed by seed, so a library of captionless takes gets sixteen
different subjects instead of one rock eleven times. Edit the style line and
every future cover follows; the per-song subject stays automatic. Applies to
the next cover, no restart — and the Images screen keeps its own per-picture
engine choice.

**Memory tier** — changing it restarts the engine and clears the cached take, so
the next re-roll costs a full render. It says so before it does it.

**Provenance** — two display/embedding toggles, and deliberately not a third.
There is no switch for the Tier-1 AI marker and none may be added: the model
licences require machine-generated content to be disclosed, and the AI Act puts
the marking duty on the tool's provider. Capture is not a toggle either — a gap
in your own record only ever costs you.

---

## Reactive — pictures that move with a song

The Reactive screen takes a song and a few pictures (from the Images library,
or made from a prompt on the spot) and renders a movie with the song on it: a
picture per bar, beat or hit, cut or dissolved on the beat, the frame breathing
with the bass, a flash on every beat, and a look on top — **Cuts**, **Crossfade**,
**Pulse**, **Film** (grain, vignette, a slow push-in) or **Psychedelic** (the hue
turning with the loudness).

Two more things it does. **Hits from the drums:** ask for the beats and hits
from the separated drum stem rather than the whole mix, the way Yvann's
workflow detects peaks on "Drums Only" — cleaner cuts on a busy song. **Clips
in the slots:** a clip plays in sync with the song, so the same shot rendered a
few ways (the control card's depth mode with different prompts or seeds) cuts
between its own versions on the beat without the move jumping.

**Paint (diffusion), on NVIDIA.** The sixth look repaints a clip frame by frame
with the image engine: each frame is made from the previous one (so the paint
builds and drifts the way paint does), the source frame is re-imposed every
frame (so the dancer's pose survives), your pictures are the look and take turns
on the bars, and the bass decides how hard each frame is repainted. This is the
Deforum-lineage half of Yvann's audio-reactive video-to-video look — the half a
video model steered by depth does not give. About 8 s a frame at 12 fps on the
16 GB card; the dials are under *Paint dials* and on `reactive_render`'s `paint`.

**Motion (AnimateDiff), on NVIDIA.** The seventh look is the reference
workflow's own shape on the pieces whose licences let it ship: SD1.5
(DreamShaper 8) under the **AnimateDiff v3 motion module** (Apache-2.0), the
whole piece rendered as one batch through sliding 16-frame windows so the
frames agree with each other, the figure held by **ControlNet depth and line
art** at the decoded strengths, and the look changing on the drum-stem bars by
prompt — one conditioning per frame from our own schedule node. Measured: 60
frames at 768x432 in 199 s; at depth 0.2 / line 0.25 with paint-heavy prompts
it is a painted figure in a paint-smeared room whose palette moves with the
music. **The pictures are the look (19 September):** pictures picked beside
the clip go through our own IP-Adapter node — the method and the weights are
Apache-2.0, the CLIP tower MIT; only the usual node pack is GPL — and take turns
on the drum-stem beats with a five-frame cross-fade ending on each hit, which is
the reference workflow's picture path. Measured: 60 frames with three pictures
on eleven drum hits in 208 s, the pictures' palette on every surface and on the
dancer, the figure held. With pictures the holds default to the reference's
(depth 0.4 held until 0.6 of each pass, line 0.5 until 0.7, cfg 7 — the reference's
0.3 firmed up a little so the figure keeps her shape under the paint, and the second
pass holds the same fraction of its own steps, without which it repainted her unheld);
with prompts to the painted look's (0.2, 0.25, 8);
a dial you move wins either way. **The detail pass (19 September):** the
reference workflow renders twice — small, then at twice the size from 0.55 of
the way down — and so does Motion by default: the first pass at 512x288 lets the
motion module and the pictures settle the composition, the second paints the
detail at 1024x576 with the depth and line-art hints read sharp from a source
staged at that size. *Detail pass* and *Detail repaint* on the page, `hires` and
`hiresDenoise` on the tool; off is one pass at 768x432 in about half the time.
*Smooth to 24 fps* doubles the 12 fps render with RIFE 4.26 through the engine —
the clip enhancer's model, MIT, on the card and clean on a dancer's limbs — and
falls back to ffmpeg's motion compensation on a machine without the
interpolation pack (`smooth`; the reply says which ran). The second pass slides
eight-frame windows of its own: at
1024x576 sixteen-frame windows pushed the 16 GB card into streaming weights from
the CPU (114 s a step against 11.5). Measured: 48 frames in 380 s all in. The
look layer on top adds a small unsharp mask, contrast and vibrance beside the
beat flash, because the render is painterly-soft after the second pass, the
interpolation and the cover scale, and the reference's frames are not.
**Which hits (19 September):** *Switch on* picks every drum-stem beat or the
bars only, and *Least gap between hits* is the reference's min distance in
frames (5); at 128 bpm beats are 5.6 frames apart and every frame is a blend,
so bars, or a gap of 11, make the switches cut. **The source on the hits (19 September):** the reference workflow runs the
source video through SparseCtrl at full strength for the first half of
sampling, anchoring the render to the source frame on every drum hit — the punch
of its hits, and the dancer's own colours flickering through the paint. That
node pack is GPL; SparseCtrl's method and its weights (guoyww, Apache-2.0) are
not, so `server/comfy_nodes/aiplay_sparsectrl.py` is the method on ComfyUI's
own ControlNet network — the checkpoint's twelve zero convolutions and middle
block loaded through ComfyUI's diffusers map, its single five-channel condition
conv (four latent channels of the keyframe plus a mask), and its eight temporal
transformers ported from the reference, sliced to the sliding window like our
other nodes. *Source on the hits* and *Source hold until* on the page,
`sourceHold` / `sourceHoldEnd` on the tool, off until asked for. Loads every
key of the checkpoint, and renders on the card since the night of the 19th: a
2.5 s piece with six pictures and three keyframes through both passes and RIFE
in 419 s on a cold engine. Two contracts the CPU could not show had to be met
first — AnimateDiff-Evolved refuses any control without `sub_idxs` and writes
the window onto the control before every window, and the temporal layers must
be built through ComfyUI's typed operations or they sit in fp32 beside an fp16
body. Measured against the same piece with it off (20 September): at the
reference's 1.0 until 0.5 the anchoring flattened the paint to one red wash and
defined the dancer less, the opposite of what the reference's hits do — the
source here is a dark stage, and a dark stage is what the keyframes anchor to.
So it ships off, dial in hand, until the cause is found; the comparison sheet
is the measurement, not a guess about it. **Bring your own:** the two
pieces of the reference that cannot ship — AnimateLCM (its module, its LoRA,
sampler lcm / sgm_uniform at cfg 2) and the LiquidAF motion LoRA at 0.4, both
without licence text — have a door but no download: *Your own motion module*,
*motion LoRA* and *model LoRA* list whatever the engine's own folders hold, by
name, and the app never fetches or catalogues them. The graph shape is pinned;
the path itself is unverified, because no such file was on the rig that built it. **Setup:** the engine needs the ComfyUI-AnimateDiff-Evolved pack
(Apache-2.0) — `git clone https://github.com/Kosinkadink/ComfyUI-AnimateDiff-Evolved`
into ComfyUI's `custom_nodes`, checked out at commit `9257651` (v1.6.0,
2026-07-28) — and the three catalogue rows (motion module + adapter, the SD1.5
checkpoint, the two ControlNets). The two nodes that make core ControlNet work
under the sliding window and put one prompt per frame ship with the app in
`server/comfy_nodes/`, and so does the IP-Adapter node. **Not here, and why:**
the IPAdapter_plus and Advanced-ControlNet node PACKS are GPL-3.0 (the method
and the weights are not, hence our own nodes), AnimateLCM has no licence text,
and the LiquidAF motion LoRA has no readable terms — so the paint does not flow
between the hits the way the reference's does. **WAN-Animate, looked at and
not built (19 September):** Wan2.2-Animate-14B is Apache-2.0 and its Mix mode
— replace the character in a driving video from one reference — is the shape
of a beat-switch feature (one driving clip, a Mix render per segment, cut on
the hits). It fits a 16 GB card only as a GGUF quant at roughly seven minutes
per five seconds at 1024x574, needs its own pose and face preprocessing on the
driving clip, and would be a fourth video model to catalogue and keep; measured
against the Motion look above, which switches on the hits in about a minute a
second, it is not the next thing to build.

It runs on the Studio's **own compositor** (the VFX screen's engine, which mixes
the song into the render itself), so it needs no video model and no second
ComfyUI: it works on any card the Studio runs on, an AMD card included. What it
builds is a real composition — open it on the VFX screen to keep editing, and
every knob is a `vfx_*` tool. Over MCP the whole thing is `reactive_render`.

The idea is Yvann Barbot's (ComfyUI_Yvann-Nodes, GPL-3.0); this is a re-creation
of it on our own engine, not their code, which is why it can ship inside the app.

---

---

## Collab — making something with friends, and lending a card

Three people making one series, each owning an episode, all of them lending each
other a graphics card in the evening. That is the thing this screen is for, and
phase one of it is deliberately the smallest thing that does it: **a file**.

A project, or one scene of one, is packed into a single sealed bundle addressed
to one named friend and signed by the machine that packed it. Nothing on this
screen opens a connection. There is no account, no server, no relay and no
discovery — the bundle travels by whatever you already use to send a friend a
file, which is also the channel you already trust. Pointing a sync folder at the
inbox is the entirety of "automatic delivery", with no networking code here at
all.

**Identity.** Two keypairs, made the first time you open the screen and never at
boot: a Studio that never collaborates never has one. Their fingerprint is 128
bits over both public keys, and it reads out as twelve words. The one-line key
card is meant to be pasted into a chat — it holds no secret.

**Trust is a phone call.** You add a friend's key card; they arrive with no role
and no minutes of your card. Then you read your twelve words to each other. If
they match, you mark it, and that mark is the only trust in the system. No tool
can assert it. No route can infer it. The software cannot hear a voice, and it
does not pretend to.

**Two roles decide what leaves.**

- A **collaborator** may receive the whole project: the document, the boards, the
  bible, the assets.
- A **lender** may receive one scene, and one scene is the finished prompt, the
  pictures that prompt names, and the render settings. Not the script, not the
  song, not the plan, not the other scenes. The prompt is composed here rather
  than there, because their Studio would otherwise put its own style bible in
  front of it.

**What each of you can do, said out loud.** Before anyone asks anyone for a
scene, it helps to know whether they can even run it: a friend with a small card
and no video weights cannot take an H3 shot, and finding that out by sending them
one and waiting an hour is the bad version of this. A *resource card* says the
card's model name and memory, the system memory, and which catalogue models are
downloaded — ids from a list both Studios already have. It names no path, no
folder, no library entry, and nothing you have made; an inventory of a personal
machine is a fingerprint of a person, and the line is drawn at what a friend
needs in order to decide. It is the one thing a verified friend may have with no
role at all, because saying what your machine can do is how the two of you decide
whether to lend to each other. And it is a message rather than a window: what
they see is what your machine could do at the moment you pressed send, which is
why every copy of it is shown with its age.

**What arrives is read, and then it stops.** Opening checks the signature against
the key held for the fingerprint the envelope claims — a bundle from somebody not
on your roster is refused rather than believed — then checks it was sealed to
this machine, then decrypts, then describes itself in a sentence. Nothing is
rendered. A bundle is a stranger's sentence until a person has read it, and
turning it into work on your own card is a separate press.

**Who did what.** A project's credit list is folded out of its provenance
ledger, never out of its document — a document is edited by whoever opens it,
while the ledger is hash-chained and stamps every act at the door it came
through. A browser is `user`, an MCP client is `agent:<name>`, a harness is
`script:<name>`, and work that came back from a friend's machine is
`peer:<fingerprint>:<their own actor>` — theirs, under their fingerprint, with
their own hand named inside it rather than flattened into yours. It counts acts
and not merit, and it says so on the page: ten edits can be one slider nudged ten
times, and one render can be the shot the whole thing turns on. (Nothing writes
the peer form yet — the return path is still design — but the reader understands
it today so the credit list does not have to be rebuilt the day it lands.)

**Lending a card, which is the thing this was for.** You can ask a friend to
render one scene. The order carries four words — the scene, the seed, the steps
and the engine mode — beside the finished prompt and the pictures that prompt
names, and nothing else. No graph travels, and that is the whole security model:
the engine validates a graph's shape and not its intent, so a graph on the wire
would reach node classes that read arbitrary files and install python packages,
and the vocabulary simply has no words for any of it. A fully compromised, fully
trusted friend's best outcome is "renders a scene you already had, into a take
you must pick by hand, filed under their name".

On their side the order becomes a one-scene project with a plan that is
*proposed*. Nothing renders until a person there approves it, their machine
refuses the order outright if the card is busy, and the same order accepted twice
is refused rather than rendered again. Their style bible cannot reach your scene:
the prompt is frozen on the sending side and their project carries it as an
override, so the function that would have pasted their look over your film is
never consulted.

The take comes home sealed, and lands in quarantine. Your machine measures the
file itself and checks it against the order — the seed, the steps, the size, the
length — and compares their own measurement against yours, which is the cheap
check that catches an edited record. It sits there until you press Adopt, which
files it as a take **nobody has picked**, carrying their model and their licence
rather than yours, under an actor that says whose machine made it.

The Collab MCP tools use the same API as the screen, including explicit
verification statements, roles, lending allowances, reviewed acceptance and take
adoption. A tool cannot infer that a person's word check happened. Acceptance
creates a proposed plan; GPU rendering remains a separate decision. See the
[MCP workflow map](MCP_WORKFLOWS.md) for the full surface and boundaries.

The design, the mechanism, and the owner's answers to the seven questions that
shaped it are in [COLLAB.md](COLLAB.md), which also lists what is still design
rather than built — the render *order*, the returned take, the resource
advertisement and the credit rollup.

---

## Release notes, September 2026

### What's new (20 September 2026)

**Collab.** A new screen: make an episode with friends, or lend one of them a
scene to render. Phase one is a sealed file addressed to one person — no server,
no account, no connection opened anywhere — with two roles deciding what may
leave, and twelve words read aloud as the only trust in it. Six tools, and three
absences that are decisions. See the section above.

**Reactive answers three notes on the Motion look.** The reference video's black
circle opening on the bass is now a compositor shape (`iris`); AnimateDiff's own
`scale_multival`, which we had never been sending, is now a dial (`motionScale`);
and the dancer's shape survives the repaint because the depth and line-art
preprocessors are no longer handed a near-black frame. Measured on a real dance
clip: 83.5% of the picture sits under luminance 0.05 and the figure's own column
averages 0.068, so the estimator was not weak, it was blind. `hintLift` opens the
bottom of the range for those two nodes **and nothing else** — the frames the
sampler paints keep their own blacks — which multiplies the edge energy inside
the figure by 2.2. All three are off at their old values, so anything rendered
before this can still be reproduced exactly.

**YuE2 continues a real recording.** Audio you own becomes the semantic codes the
model speaks, and those codes become the prefix of a new render: a continuation
holds 0.9947 against its source where a fresh render holds -0.003. The same codes
make the library searchable by how a song sounds rather than by what it is called.

### What's new (19 September 2026)

**Two diffusion looks for Reactive, on NVIDIA.** *Paint* repaints the clip in
the slots frame by frame through the image engine (the pictures are the look,
the bass decides how hard, the figure is kept). *Motion* is the reference
workflow's own shape on the pieces whose licences let it ship: SD1.5 under the
AnimateDiff v3 motion module, the figure held by ControlNet depth and line art,
and the pictures you pick switching on the drum-stem hits with a five-frame
cross-fade — through **our own IP-Adapter node** (the method and the weights are
Apache-2.0; only the usual node pack is GPL). Three nodes of ours ship in
`server/comfy_nodes/`. Every dial is on the page and on `reactive_render`.
Measured: 60 frames at 768x432 in 199 s by prompt, 208 s with three pictures.

**The compositor's answers are read.** Every Reactive piece before this one
shipped without its cover scale, its start offset and its beat flash: the door
answers an error to a wrongly named layer field and the recipe never looked.
It looks now, and stops with the action named.

### What's new (18 September 2026)

**Reactive, inside the app, on any card.** The audio-reactive screen no longer
asks for a second ComfyUI: a song and a few pictures (from the library, or made
from a prompt on the spot) become a movie with the song on it, rendered by the
Studio's own compositor. A picture per bar, beat or hit; cut or dissolved on the
beat; the frame breathing with the bass; a flash on every beat; five looks
(Cuts, Crossfade, Pulse, Film, Psychedelic); landscape, portrait or square. No
video model, so it renders on an AMD card too. What it builds is a real comp,
so the VFX screen and the `vfx_*` tools are the advanced way. Measured: a
24 s clip at 1080p builds in 4 s and renders in 152 s on the CPU, the song
muxed in at -15 dB RMS with no clipping. MCP: `reactive_render`. See
*Reactive* below.

**Depth is the third control door, and any 720p video can walk through it.**
Depth Anything V2 (Small, Apache-2.0 by its authors' statement; Large offered
as non-commercial) reads a clip into a depth video and WAN 2.1 VACE steers with
it: the person, the room and the move survive, the prompt and a reference
picture supply the look. `conform` fits any video to the contract (1280x704,
24 fps, the 121 frames from a chosen second) for free. Measured: a generated
high-heels dance clip, conformed in 1.2 s, depth in 20 s, repainted by VACE in
34 minutes with every pose kept. Control card modes `depth`, `extract_depth`,
`conform`; MCP `mv_control_render` mode depth, `mv_depth_extract`,
`mv_control_conform`.

**Reactive cuts on the drums, cuts between clips, and starts where you say.**
`hits: drums` reads the beats off the separated drum stem (cleaner cuts on a
busy mix); a slot may hold a clip that plays in sync with the song, so the same
dance rendered in three palettes cuts between its own versions on the beat;
`start` begins the piece at any second of the song. Together with the depth
door this is Yvann's audio-reactive video-to-video effect on our own engines.

### What's new (17 September 2026)

Everything below has a door (`API.md`), an MCP tool and a control on the page,
and each was measured on the 16 GB card this is developed on.

**YuE2 takes direction.** Under *More Options*: **key, tempo and meter**
(an open seed score the planner continues — asked for E minor at 92 in 4/4,
the score came back with exactly that header and the song followed), and the
**sampler's dials** (temperature, top-p, top-k, repetition penalty, and the
planner's own temperature). MCP: `make_song` gained `key`, `bpm`, `meter`,
`temperature`, `top_p`, `plan_temperature`. Key, tempo and meter are the
Python kit's: the native GGUF runtime and the ComfyUI nodes cannot seed an open
score, so on those builds the rows are not shown (they used to be, and did
nothing). The dials reach all three builds; on GGUF as the runtime's own
`semantic_temperature`, `semantic_top_p` and `abc_temperature`.

**Extend and replace, on both engines.** A YuE2 take extends by replaying its
own performance behind the words (365 s of wall for 33 s of new song, the
original head bit-exact). **Replace a section**: set *Keep the ending from* in
the extend panel and the model continues from A while the original comes back
at B — the result is exactly as long as the original, head and tail bit-exact,
both seams crossfaded. MCP: `extend_song`, `replace_section`.

**Hum it, or cover it.** A hummed line goes through a pitch tracker (no model)
and becomes the two-voice score YuE2 sings verbatim; a whole song goes through
SheetSage2 (a 1.4 GB row on the Models screen) and comes back as a score to
re-sing under a new style line — a cover with the melody kept. *Read the tune
from: its separated voice* transcribes the separated vocal stem instead of the
mix (it starts off until stem separation is set up on the PC), which on the test song
recovered the right key and tempo where the mix had not. MCP: `hum_to_score`,
`song_to_score` (with `stem`).

**A score into the DAW, and out as MIDI.** *Open in DAW* builds a project from
a score version — tempo and meter from the header, one track per voice, every
note at bar.beat.tick — and *MIDI* downloads it as a Standard MIDI File for any
other DAW. MCP: `score_to_daw`, `score_export_midi`.

**Continue a clip.** *extend* on any video clip: MiniMax H3 reads the clip's
last second as a native guide, renders what happens next, and ffmpeg joins the
two into a new clip beside the original (56 frames + 3 s asked → 141 frames,
the seam reads as one shot). MCP: `extend_clip`.

**Faster H3.** The TaoMate 3-step distillation is in the catalogue (one click,
2.48 GB, or Kijai's 181 MB rank-19 average) and loads at or below the Video
panel's *3-step build threshold*: two seconds at native size in 105 s where the
4-step build takes 135 s. Deterministic across runs; a different picture than
the 4-step build at the same seed, not a faster copy of it.

**Krea 2 Turbo, as an image engine.** The 12B open-weights model in Comfy-Org's
int8 repack, through ComfyUI's own Krea 2 support: pick *Krea 2 Turbo* on the
Images screen (or `make_image` with `engine: "krea2"`). Measured at 1024²: 52 s
for the first picture, 26 s warm — ten times FLUX.2 klein, for the frontier
look. Krea 2 Community Licence: outputs are yours; commercial use under USD 1M
company-wide revenue. No references (FLUX.2's trick) and no negative prompt
(distilled at cfg 1). FLUX.2 stays the default for speed and references.

**"fast" means 3 steps now.** `make_clip`'s fast preset renders on the TaoMate
build where it is installed (measured as coherent and as sharp as the 8-step
build on three prompts, at 25–40% less wall time) and 8 steps where it is not.
(Since 2026-09-23 every quality word follows the disk instead: where TaoMate
is missing, fast is the 4-step build, and the default is 8 only where both
8-step turbo files are on disk, else 4. `studio_status` shows the numbers.)

**A conditioning bridge, as the Studio's own node.** BUNNY (action logic) and
the original Semantic Bridge rewrite H3's text conditioning before the
transformer; the Video panel's *Conditioning bridge* and *Bridge strength*
choose them, and `make_clip` / `extend_clip` can override per render.
**Off by default**: on four action shots at 0.12 nothing broke and nothing
was clearly fixed, which is also what the publishers' own figures say.

**LoRAs on YuE2 (ComfyUI build) and the fixed Krea 2 shelf.** The LoRA row
at the foot of *Melody & score* lists what fits the loaded music model; the
image LoRA shelf recognises Krea 2 checkpoints again.

**YuE2's rights, as its authors put it.** Since 2026-09-24 Studio's label for
YuE2 follows the m-a-p authors' statement (a discussion comment of 15 September
2026, dated and sourced): *sellable by individuals · companies need a commercial
licence*. The licence file shipped with the weights still reads CC BY-NC 4.0,
and the chip's detail says so and links both. The chip is on the Models card,
under every YuE2 song's title and on the receipt under Create; the add-ons
whose own authors said nothing of the kind (the CC BY-NC LoRAs and the
real-audio tokenizer) keep their not-for-sale answer, and a song that used one
carries it.

### What's new (September 2026)

Merged on 2026-09-16 from [bani4kaskashka's fork](https://github.com/bani4kaskashka/AIPLAY-Studio-Bucky-Fork),
where all of it was written and measured.

**The Music screen looks like Suno.** From top to bottom: the model button (it
just says *YuE2* or *MiniMax*; click it for the full list, ⓘ for the details,
and **Load** / **Unload** beside it), a **Song | Instrumental** bar, then
**Lyrics**, **Styles** and **More Options** as cards that fold open, and the
**song title** last. Everything technical (seed, sampler settings, audio
reference, score planning) lives under More Options and, for YuE2, **Melody & score**,
so a first song is: type, press Create.

- **Reuse a song's lyrics and style.** Drag any song from the Library onto the
  Music panel. A drop box slides open while you drag; let go and the song's
  lyrics and style fill the form. The ▾ on the placed song lists the whole
  Library as cards, and choosing a different song asks before it replaces
  anything.
- **Section tags and style chips** are one row each: drag them sideways, or
  press ▾ to see every tag. Choosing *Instrumental* on YuE2 slides the Lyrics
  card away.
- **Library rows:** click a row to open its details, click the cover to play.
- **The sidebar** is grouped (Create, Edit, Automate, Explore, System) with
  Agent, Settings, About and Thanks pinned to the bottom. ❮ folds it to icons
  only; the VRAM and RAM meters stay visible when folded.
- **The player** stays hidden until a song plays, and its timeline has a large
  grab area — hold and drag to scrub.
- One font and four text sizes across the app, and one dropdown style.

**The model stays loaded.** ComfyUI keeps a model in memory between songs, so
only the first song after starting pays the load. **Load** warms it up ahead of
time, **Unload** frees the memory, and choosing a different music model unloads
the old one automatically.

**A song that did not render says so.** With 🎲 random on, every Create now gets
a new seed. If ComfyUI answers from its cache (same seed, same lyrics, same
style), Studio marks the result as nothing new rather than filing it as a fresh
song, and the launcher's log prints a warning. Every song's start, finish or
failure is printed there as well.

**Chat model picker.** The Chat screen has a **Model** dropdown listing every
language model your ComfyUI can load for chat — Qwen3 / Qwen3-VL text encoders,
and `.gguf` builds through ComfyUI-GGUF. With nothing chosen it picks the best
Qwen3-4B it can find. Saved as `chatModel` in settings.json;
`GET/POST /api/chat/models` for scripts.

**Launcher settings.**

- *Closing this window also stops Studio* — off by default (the window closes
  and Studio keeps running).
- **Advanced** (folded, for people who want it): separate models, output and
  input folders, and ComfyUI's own options read from the installed ComfyUI —
  attention, VRAM mode, dynamic VRAM, disable mmap, precision and more — with
  the exact launch line shown before you save. Saved as `comfyOptions`; the
  install's own flags are kept unless you turn that off. At the top of it sits
  the **AMD / Intel engine fix** — PyTorch attention and CUDA graphs off, what
  makes MiniMax Music 3 render on AMD — as Auto, On or Off. Auto turns it on
  for AMD and Intel cards and leaves NVIDIA on ComfyUI's own defaults: without
  xformers, Sage or flash-attn installed ComfyUI's attention on NVIDIA already
  is PyTorch SDPA, and CUDA graphs are an optimisation its model compiler and
  weight prefetcher use, so the flags would only take something away there.
  Saved as `comfyAmdFix`.

**Attention on AMD, measured.** RX 9060 XT, 30-second song, fresh start each run:

| | CK attention | PyTorch attention |
|---|---|---|
| YuE2 3B through ComfyUI | **57 s** | 95 s |
| MiniMax Music 3 | **201 s** | 213 s (broken audio under both) |

CK attention (`--use-ck-attention`, what ComfyUI Desktop uses) is faster, and
YuE2's audio was identical under both. MiniMax's broken output on AMD is not
caused by the attention choice.

**YuE2 GGUF runs on AMD through Vulkan.** The YuE2 GGUF files are packed for
audio.cpp, so ComfyUI-GGUF still cannot load them, but audio.cpp itself runs
on Vulkan: on an AMD or Intel card, setup installs audio.cpp's official Vulkan
build (no ROCm, CUDA or Python, nothing installed into ComfyUI). Measured on an
RX 9060 XT at Q8_0: 86 s of audio in 72 s and 97 s in 68 s, against 69 s for
59 s through ComfyUI with the model already loaded. YuE2 through ComfyUI remains
available too: **YuE2 3B for ComfyUI (int8)** — `yue2_3b_int8_convrot.safetensors`,
3.96 GB, from Comfy-Org/YuE2; an existing `yue2_3b_bf16.safetensors` counts as
having it.
