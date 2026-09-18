# AIPLAY Studio

> Runs on **NVIDIA, AMD, Intel Arc or CPU**, with a Suno-style music screen and
> a launcher that installs its own ComfyUI when a PC has none. What arrived with
> that, merged from [bani4kaskashka's fork](https://github.com/bani4kaskashka/AIPLAY-Studio-Bucky-Fork),
> is under [What's new (September 2026)](#whats-new-september-2026).

A local creative suite. Write a song, draw the artwork, block the camera in
Blender, cut the video, composite the effects, build a 3D prop, and mix it in a
DAW — on your own machine, no account, no credits, no upload, and nothing leaves
the building.

**Only want YuE2 music? You are in the right repository.** Music-only is a
launch mode of this same app, **not a separate GitHub repository or edition**.
You download Studio's app files, but **do not need ComfyUI, Python, MiniMax,
image/video models or the full-suite setup** to make music with native YuE2 GGUF.

[Download Studio ZIP](https://github.com/Senzube4n/AIPLAY-Studio/archive/refs/heads/main.zip)
· [Detailed YuE2 guide](docs/YUE2_GGUF.md)
· [Full-suite installation](INSTALL.md#the-full-studio-installation)

## YuE2 music-only quickstart

This native package is for **Windows x64 with an NVIDIA CUDA GPU**. Install
[Node.js 20 or newer](https://nodejs.org), a CUDA 13.3-compatible NVIDIA driver,
and the [Microsoft Visual C++ v14 x64 Redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist)
if missing. A minimum GPU memory requirement is not yet certified.

1. **Download and extract** the [Studio ZIP](https://github.com/Senzube4n/AIPLAY-Studio/archive/refs/heads/main.zip).
   Open the extracted folder, not the ZIP viewer.
2. **Double-click `AIPLAY Studio.exe`** (or `AIPLAY Studio.cmd`) and choose
   **Music only** in the launcher window. It installs the app's npm
   dependencies on first use and opens Studio in your browser once the music
   engine reports ready. Leave the launcher running while you use Studio.
3. In **Models → Review Q4 / Q8 setup**, choose **Q4_0** (smaller default) or
   **Q8_0** (optional, higher precision). Review the download size and licence
   terms, accept them if you agree, then click **Install** and wait for verification.
   Only your selected weights and native runtime are needed; other models are optional.
4. Open **Music**, enter your **Lyrics** and **Style**, then click **Create**.
   Change installed weights under **Advanced → Native precision** if desired.
   Completed songs appear as WAV files in the **Library**.

**What gets downloaded?** Q4 model files total about **2.93 GB**, or **4.53 GB**
for Q8, plus **833 MB** for the shared native runtime. Verified shared files are
reused; you may install either precision or both. Model/runtime downloads require
your explicit action; choosing a model or requesting a song never downloads it
automatically. Q8 has not been GPU-benchmarked or listening-tested in Studio;
higher precision is **not** a guaranteed audio-quality upgrade.

**Prefer a terminal?** Run these in the extracted Studio folder instead of
double-clicking the launcher:

```text
npm ci --omit=dev
npm run start:music
```

**Already have Studio?** Update the same public checkout; no second repository
or duplicate model installation is required. Wait for running/queued work to
finish, then close the existing Studio before changing launch modes: both use
`http://127.0.0.1:4173` by default. Music-only does not start ComfyUI or rewrite
your full-Studio preferences. Choose **Full Studio** in the launcher when you
want the full suite and have completed its separate prerequisites.

**Hardware and licence limits:** one Q4 short-song test on an RTX 4070 Ti SUPER
16 GB produced 49.4 seconds of audio in 22.0 seconds. The sampled whole-GPU peak
was 6,589 MiB, including a 3,129 MiB baseline—not process memory or proof that a
6/8/12 GB card will work. The weights use **CC BY-NC 4.0**; review the
[hardware details, troubleshooting and attribution](docs/YUE2_GGUF.md) before use
or distribution. Studio keeps a conservative noncommercial label; it does not
claim that the weights' licence automatically governs every generated song.

## The rest of Studio is optional

It started as music generation with MiniMax Music 3 and grew the rest because
each piece needed the one after it: a song wants a cover, a cover wants a video,
a video wants a camera and a compositor, and all of it wants a mixer.

Most full-suite rendering works by submitting a graph to
[ComfyUI](https://github.com/comfyanonymous/ComfyUI), and those graphs are in
[`workflows/`](workflows/) so you can open the real pipeline and change it.
Native YuE2 runs through audio.cpp instead. The DAW and the compositor are
arithmetic this repo ships and run
on a machine with no graphics card at all, and the 3D stack is a second door with
its own Python — each named where it appears, because "everything goes through
ComfyUI" was true once and stopped being true.

---

## NVIDIA or AMD

**No ComfyUI on this PC? Studio installs one.** When the launcher finds no
ComfyUI, it asks **What should Studio run on?** — **NVIDIA**, **AMD**, **Intel Arc**
or **CPU only** (the card it detected is marked). Pick one and Studio installs
its own ComfyUI into `%USERPROFILE%\.aiplay-studio\engine` — nothing else on the
PC is touched, and an existing ComfyUI is never modified:

1. a standalone Python (via [uv](https://github.com/astral-sh/uv), so no system Python is needed);
2. the latest ComfyUI release;
3. PyTorch for your choice, using **the exact command in that ComfyUI's own
   README** — CUDA 13.0 for NVIDIA (CUDA 12.6 on Python 3.12 for GTX 10-series and
   older), AMD's ROCm packages on Windows with only your card's kernels where the
   README's table names it (an RX 9060 XT gets `device-gfx1200`), ROCm 7.2 on
   Linux, XPU for Intel Arc, the CPU build otherwise;
4. ComfyUI's requirements, then a check that PyTorch can see the card, and a
   test start of ComfyUI (`--quick-test-for-ci`).

**If any step fails**, the partial install and its download cache are deleted,
and the launcher asks again showing the exact error (for example pip's own
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

**Music only** starts ComfyUI when this machine has a ComfyUI install and a
YuE2 checkpoint in `models/checkpoints`, and renders with YuE2 through ComfyUI;
without one it is native YuE2 GGUF (NVIDIA) and starts no ComfyUI.

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

⚠ **MiniMax Music 3 is buggy on AMD (ROCm).** The weights fit and the graph
finishes without an error, but the audio comes out broken or unlistenable.

**The low-VRAM tier costs nothing on this card.** Studio's `auto` tier passes
`--lowvram --async-offload 4`; ComfyUI Desktop runs the same card without it.
Measured on 2026-09-16 with six 30-second YuE2 renders, fresh seed each, one job
at a time: `auto` took 64 s, 38 s, 24 s, 24 s and `high` (no `--lowvram`) took
39 s, 24 s, 24 s. Every slow figure is the first render after an engine start —
once the weights are warm both tiers land on **24 s**, which matches Studio's own
note that `--lowvram` reads as a no-op under dynamic VRAM. `auto` stays the
default. If you repeat this, change the seed: an identical seed and caption
returns the cached song in about 5 seconds.
Studio marks it "buggy on AMD" in the music model list and on its Models card.
**On AMD, use YuE2 3B through ComfyUI** — any YuE2 checkpoint in a
`checkpoints` folder is listed in the music model picker. Two runs on one card;
not a root-cause analysis.

What is different on AMD:

- The fused kernels are comfy_kitchen's **`hip`** backend on ROCm. Its `cuda`
  backend reads *disabled* there, and that is expected; Studio counts either.
- The engine's venv folder goes first on PATH at launch, as activation would
  put it. A TheRock ROCm torch runs `hipInfo.exe` from there to identify the
  card; without it ComfyUI logs *"Could not detect ROCm GPU architecture"*.
- The VRAM readout is **total only**, taken from ComfyUI's startup log — there
  is no `nvidia-smi` to read used memory from.
- **Automatic cover art queues an image render straight after every song.** On
  a machine the music model already fills, switch it off
  (`POST /api/art {"action":"enable","value":false}`, remembered) and draw
  covers when nothing else is rendering.
- **Music on AMD is YuE2 through ComfyUI.** It renders with ComfyUI's own YuE2
  nodes (the "Text to Music (YuE2)" template's graph) and a checkpoint such as
  `yue2_3b_bf16`; its length ceiling goes to 6:00. MiniMax Music 3 is listed
  but marked buggy on AMD (see the table above).
- **Not on AMD:** native YuE2 GGUF (the music-only launcher ships a CUDA
  binary) and the 3D mesh stack (CUDA-only wheels). The pip extras — stems,
  Whisper, TTS, the DAV encoder — are untested on AMD.

---

## What's new (18 September 2026)

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

## What's new (17 September 2026)

Everything below has a door (`API.md`), an MCP tool and a control on the page,
and each was measured on the 16 GB card this is developed on.

**YuE2 takes direction.** Under *Advanced Options*: **key, tempo and meter**
(an open seed score the planner continues — asked for E minor at 92 in 4/4,
the score came back with exactly that header and the song followed), and the
**sampler's dials** (temperature, top-p, top-k, repetition penalty, and the
planner's own temperature). MCP: `make_song` gained `key`, `bpm`, `meter`,
`temperature`, `top_p`, `plan_temperature`.

**Extend and replace, on both engines.** A YuE2 take extends by replaying its
own performance behind the words (365 s of wall for 33 s of new song, the
original head bit-exact). **Replace a section**: set *Keep the ending from* in
the extend panel and the model continues from A while the original comes back
at B — the result is exactly as long as the original, head and tail bit-exact,
both seams crossfaded. MCP: `extend_song`, `replace_section`.

**Hum it, or cover it.** A hummed line goes through a pitch tracker (no model)
and becomes the two-voice score YuE2 sings verbatim; a whole song goes through
SheetSage2 (a 1.4 GB row on the Models screen) and comes back as a score to
re-sing under a new style line — a cover with the melody kept. *Voice only*
transcribes the separated vocal stem instead of the mix, which on the test song
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

**A conditioning bridge, as the Studio's own node.** BUNNY (action logic) and
the original Semantic Bridge rewrite H3's text conditioning before the
transformer; the Video panel's *Conditioning bridge* and *Bridge strength*
choose them, and `make_clip` / `extend_clip` can override per render.
**Off by default**: on four action shots at 0.12 nothing broke and nothing
was clearly fixed, which is also what the publishers' own figures say.

**LoRAs on YuE2 (ComfyUI build) and the fixed Krea 2 shelf.** The LoRA row
under Advanced Options lists what fits the loaded music model; the
image LoRA shelf recognises Krea 2 checkpoints again.

**YuE2's rights, as its authors put it.** Beside the unchanged CC BY-NC label,
the Models card and NOTICE quote the m-a-p authors' statement that individuals
may use the model and its outputs commercially and only companies should
license — a discussion comment, dated and sourced, not the licence.

## What's new (September 2026)

Merged on 2026-09-16 from [bani4kaskashka's fork](https://github.com/bani4kaskashka/AIPLAY-Studio-Bucky-Fork),
where all of it was written and measured.

**The Music screen looks like Suno.** From top to bottom: the model button (it
just says *YuE2* or *MiniMax*; click it for the full list, ⓘ for the details,
and **Load** / **Unload** beside it), a **Song | Instrumental** bar, then
**Lyrics**, **Styles** and **More Options** as cards that fold open, and the
**song title** last. Everything technical (seed, sampler settings, audio
reference, score planning) lives under More Options and **Advanced Options**,
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
  install's own flags are kept unless you turn that off.

**Attention on AMD, measured.** RX 9060 XT, 30-second song, fresh start each run:

| | CK attention | PyTorch attention |
|---|---|---|
| YuE2 3B through ComfyUI | **57 s** | 95 s |
| MiniMax Music 3 | **201 s** | 213 s (broken audio under both) |

CK attention (`--use-ck-attention`, what ComfyUI Desktop uses) is faster, and
YuE2's audio was identical under both. MiniMax's broken output on AMD is not
caused by the attention choice.

**YuE2 GGUF is NVIDIA-only.** The YuE2 GGUF files are packed for audio.cpp, and
ComfyUI-GGUF cannot load audio models, so there is no AMD path for them. On a
non-NVIDIA card the GGUF install is refused before anything downloads, and the
Models screen offers **YuE2 3B for ComfyUI (int8)** instead —
`yue2_3b_int8_convrot.safetensors`, 3.96 GB, from Comfy-Org/YuE2. An existing
`yue2_3b_bf16.safetensors` counts as having it.

---

## Why this rather than a cloud tool

Five answers, and each one is a thing in the code rather than a promise.

**It runs on one consumer graphics card, and nothing leaves the machine.** No
account, no key, no credits, no upload. Studio benchmarks below use an
RTX 4070 Ti SUPER (16 GB) with 32 GB of RAM; unbenchmarked options are labelled.
Three network exceptions exist and all three
are named where they live: model downloads go straight to the publisher (Studio
hosts no weights and mirrors none; the native runtime is an attributed AIPlay
package on GitHub), the Community screen is a window onto a
website and is the only screen that wants a connection, and **API mode** is an
opt-in switch for machines that cannot run the music model — off by default, and
it cannot switch itself on.

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
the ledger* below, and [`docs/ENGINE_DOOR.md`](docs/ENGINE_DOOR.md) for the whole
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
picture turned into a 3D mesh. **247 MCP tools** expose it — 46 `mv_*`, 50
`daw_*`, 44 `vfx_*`, 17 `ab_*`, 11 `engine_*`, 6 `score_*` and the rest — so an
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

For the caption, use the one in **[`examples/01-song/caption.txt`](examples/01-song/)**
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
examples of both, input beside output, in **[`examples/`](examples/)**.

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

Full version, including what to do when it goes wrong: **[INSTALL.md](INSTALL.md)**.

---

## The models

Nothing downloads on its own. Open the **Models** screen: it reads your card and
your RAM, tells you which of these your machine can actually run, and fetches
what you ask for — resuming if the connection drops, and verifying every file
against its exact byte count so an interrupted download reads as missing rather
than as broken.

<!-- MODELS:BEGIN -->
<!-- Generated by scripts/models_table.mjs from server/models.js. Do not edit by hand:
     the pre-commit hook fails if this block and the catalogue disagree. -->

| capability | download | licence | your card | your RAM |
|---|---|---|---|---|
| Music engine — MiniMax Music 3 | 11.9 GB | MiniMax Music3 Community | 6 GB (12 rec) | 16 GB (32 rec) |
| Music engine — YuE2 GGUF Q4 / optional Q8 (experimental) | ~2.9 GB | CC BY-NC 4.0 (weights) · Apache-2.0/MIT (native code) · NVIDIA CUDA runtime terms · ⚠ not for sale | Unknown (experimental) | Unknown (experimental) |
| Cover — SheetSage2 song-to-score (ComfyUI) | 1.4 GB | CC BY-NC 4.0 (weights) · ⚠ not for sale | 4 GB (8 rec) | 8 GB (16 rec) |
| Video clips — TaoMate 3-step LoRA (H3) | 2.5 GB | MiniMax H3 Community Licence (derived from H3) · ⚠ territory | 12 GB (16 rec) | 16 GB (32 rec) |
| Video clips — TaoMate 3-step, rank-19 average (H3, small) | 182 MB | MiniMax H3 Community Licence (derived from H3) · ⚠ territory | 12 GB (16 rec) | 16 GB (32 rec) |
| H3 conditioning bridge — BUNNY (action logic) | 22.0 MB | MiniMax H3 Community Licence (derived from H3) · ⚠ territory | none (0 rec) | 0 GB (0 rec) |
| H3 conditioning bridge — Semantic Bridge v1 | 11.0 MB | MiniMax H3 Community Licence (derived from H3) · ⚠ territory | none (0 rec) | 0 GB (0 rec) |
| Music engine — YuE2 3B for ComfyUI (int8) | 4.0 GB | CC BY-NC 4.0 (weights) · ⚠ not for sale | 8 GB (12 rec) | 16 GB (32 rec) |
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
| 3D mesh from a picture — TripoSG 1.5B | 7.9 GB | MIT | 4 GB (12 rec) | 16 GB (32 rec) |
| Skeleton and skin for a mesh — UniRig | 5.8 GB | MIT | 4 GB (8 rec) | 8 GB (16 rec) |
| Timed lyrics — Whisper large-v3 | ~3.1 GB | MIT · pip | 4 GB (6 rec) | 8 GB (16 rec) |
| Smooth motion — RIFE 4.26 | 22.7 MB | MIT | 4 GB (6 rec) | 8 GB (16 rec) |
| Upscale — Real-ESRGAN 2x | 67.1 MB | BSD-3-Clause | 4 GB (8 rec) | 16 GB (32 rec) |

30 capabilities. **Choose one music engine** and install the runtime and models for the features you want. Native YuE2 music-only does not require MiniMax, ComfyUI or Python. Hardware figures are capability-specific guidance, not a guarantee; an experimental Unknown means no minimum has been established. Streaming support and memory measurements from other engines must not be applied to native GGUF.

⚠ **territory** — **TaoMate 3-step LoRA (H3) and TaoMate 3-step, rank-19 average (H3, small) and BUNNY (action logic) and Semantic Bridge v1.** Derived from MiniMax H3, so its Community Licence applies: rights only inside the Applicable Territory, which excludes the EU, the UK, the Republic of Korea and the United States of America. The download goes straight to the publisher. **MiniMax H3 (quantised) and MiniMax H3 ref2va.** MiniMax grants H3 rights only inside its Applicable Territory, which excludes the EU, the UK, the Republic of Korea and the United States of America. If you are in one of those places you may not use these weights — and §V.4 says the same about anything they generate. AIPLAY Studio does not host them — the download goes straight to the publisher, and the licence is between you and MiniMax. Studio treats this as a blocking acknowledgement and refuses the download without it.

⚠ **gated** — **LTX 2.5 (quantised).** The repository is access-gated, so the built-in downloader cannot fetch it — it has no token and deliberately nowhere to keep one. Accept the licence on the model page, then in the ComfyUI python environment run `hf auth login` followed by `python scripts/fetch_ltx25.py`. About 40 GB. Licence and access: https://huggingface.co/Lightricks/LTX-2.5

⚠ **terms unread** — **Ideogram 4 (open 9B)** — https://huggingface.co/ideogram-ai/ideogram-4-fp8/blob/main/LICENSE.md

The Ideogram Non-Commercial Model Agreement is behind a gate: the URL above returns HTTP 401 to an anonymous request (checked 2026-08-27) and no copy of the text has been read here. The name says non-commercial; every other non-commercial licence in this catalogue restricts the MODEL and leaves the output alone — but Ideogram's may not, and Studio will not guess in either direction. Accept the agreement on the model page, read §-by-§, and decide. If you need a settled answer today, FLUX.2 klein 4B is Apache-2.0.

**DWPose (TorchScript)** — https://github.com/IDEA-Research/DWPose/blob/main/LICENSE

Half of this capability is verified and half is not, and the unread half is the one that makes the skeleton, so the row answers with the weaker of the two. The detector (yolox_l.torchscript.pt) is Apache-2.0: Megvii's own LICENSE was diffed against the canonical text and every operative clause is identical. The estimator (dw-ll_ucoco_384_bs5.torchscript.pt) has no readable terms at all — its redistributor's entire model card is 28 bytes of frontmatter with no LICENSE file, and so is the card of the yzd-v/DWPose repository usually named as its origin. The Apache-2.0 licence linked above, IDEA-Research's, is reached only by a filename match, and a filename is not a grant. In practice a skeleton is a measurement of a video you supplied, and the clip it goes on to steer carries the RENDERING model's terms — WAN 2.1 VACE's, which are settled Apache-2.0 — so this is narrower than it sounds. Read the chain yourself before relying on the skeleton itself being licensed. Separately, and binding whoever trained the model rather than whoever runs it: DWPose was trained on COCO-WholeBody and UBody, which carry dataset terms of their own.

⚠ **not for sale** — **YuE2 GGUF Q4 / optional Q8 (experimental).** Studio retains a conservative noncommercial / not-for-sale classification. This does not establish that every generated output is governed by the weights' licence. Review the source terms and output scope: https://huggingface.co/m-a-p/YuE2-3B/blob/main/LICENSE. **SheetSage2 song-to-score (ComfyUI).** Studio retains a conservative noncommercial / not-for-sale classification. This does not establish that every generated output is governed by the weights' licence. Review the source terms and output scope: https://huggingface.co/m-a-p/SheetSage2/blob/main/LICENSE. **YuE2 3B for ComfyUI (int8).** Studio retains a conservative noncommercial / not-for-sale classification. This does not establish that every generated output is governed by the weights' licence. Review the source terms and output scope: https://huggingface.co/m-a-p/YuE2-3B/blob/main/LICENSE. **YuE2 3B.** Studio retains a conservative noncommercial / not-for-sale classification. This does not establish that every generated output is governed by the weights' licence. Review the source terms and output scope: https://huggingface.co/m-a-p/YuE2-3B/blob/main/LICENSE.

**pip, not a download** — Some capabilities are Python packages that fetch their own weights, so Studio has no file to verify and no button to press. They belong in a Python that is **not** ComfyUI's: installing them there can pull the torch build the engine depends on back down, which costs about 5× the speed of everything (INSTALL.md §5).

  · **MiniMax Music 3 DAV encoder** — `python -m pip install numpy torch av` (on top of the 306 MB of weights in the table)
  · **HTDemucs (fine-tuned)** — `python -m pip install demucs`
  · **TTS voices (Kokoro + Qwen3-TTS)** — kokoro + qwen-tts (sidecar venv at tts-venv/) — no single command; see the Models screen
  · **Whisper large-v3** — `python -m pip install faster-whisper`

`node scripts/extras_setup.mjs` prints the exact command for your machine, aimed at the interpreter Studio will actually invoke, and says which are already installed.

**selling what you make** — Model licences and rights in generated material are separate questions. The catalogue records them separately. 12 of 30 are classified as placing no licence conditions on generated material (FLUX.2 klein 4B, HTDemucs (fine-tuned), BiRefNet, TTS voices (Kokoro + Qwen3-TTS), Z-Image Turbo (Apache-2.0), Z-Image base (Apache-2.0), WAN 2.1 VACE 1.3B, TripoSG 1.5B, UniRig, Whisper large-v3, RIFE 4.26, Real-ESRGAN 2x). 12 say you may and attach conditions (MiniMax Music 3, TaoMate 3-step LoRA (H3), TaoMate 3-step, rank-19 average (H3, small), BUNNY (action logic), Semantic Bridge v1, MiniMax Music 3 DAV encoder, MiniMax H3 (quantised), MiniMax H3 ref2va, Stable Audio 3 Small SFX, Krea 2 Turbo (community licence), Anima (non-commercial model, sellable pictures), LTX 2.5 (quantised)). 4 are conservatively classified noncommercial / not for sale; that label does not resolve every output's legal status. 2 — Ideogram 4 (open 9B), DWPose (TorchScript) — nobody here has read. For MiniMax Music 3: §3.1 — a commercial product or service that uses it must show “MiniMax-Music3” prominently in its interface. That is why the name sits in Studio's corner rather than on a credits page. The operative sentence is quoted verbatim in `server/models.js` and shown on the Models screen before you download anything.

**shared files** — 4 files are used by more than one capability, so picking two of those costs less than adding their rows — up to 9.0 GB less. `qwen_3_4b.safetensors` (8.0 GB) is shared by FLUX.2 klein 4B, Z-Image Turbo (Apache-2.0), Z-Image base (Apache-2.0); `flux2-vae.safetensors` (336 MB) is shared by FLUX.2 klein 4B, Ideogram 4 (open 9B); `ae.safetensors` (335 MB) is shared by Z-Image Turbo (Apache-2.0), Z-Image base (Apache-2.0); `qwen_image_vae.safetensors` (254 MB) is shared by Krea 2 Turbo (community licence), Anima (non-commercial model, sellable pictures). The Models screen quotes the deduplicated figure.

Studio hosts no weights and mirrors none: every download goes straight to the publisher, and the licence is between you and them.
<!-- MODELS:END -->

Two video engines, and the shipped default is **MiniMax H3** — not because it is
the better one (LTX 2.5 renders a 5-second clip at 1280x704 in about 121 s against
H3's 660 s at 20 steps, and looks better doing it) but because it is the one Studio
can actually fetch for you. LTX's repository is access-gated; a default pointing at
it meant a fresh install opened the Video page, was told 39.7 GB was missing, opened
the Models screen, and found no button. H3 is also the one trained with a first *and*
last frame, which is what a seamless loop wants. If you go and fetch LTX by hand,
Studio renders on it — the engine resolves to weights that are present, preferring
your setting.

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
[`docs/ENGINE_TRAPS.md`](docs/ENGINE_TRAPS.md).

If this studio makes money for you, the settled answers are **FLUX.2 klein** and
**Z-Image** for pictures: plain Apache-2.0, no addendum, no revenue ceiling, nothing
that reaches what you make. **TripoSG** and **UniRig**, the 3D pair, are MIT for
code and weights, which is why they were chosen over an alternative whose licence
writes the European Union out of the granted territory and extends the bar to the
meshes you generate.

---

## Chat — the first screen (fork only)

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
[`docs/ENGINE_DOOR.md`](docs/ENGINE_DOOR.md): 426 files written in a day, 424 of
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
the optional Reactive engine on its own port writes **no** provenance at all.

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
**[`DIRECTING.md`](DIRECTING.md) §5**.

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

## The music-video workflow (fork only)

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
the clip engine takes pictures.

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

## The audiobook workflow (fork only)

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

*This is new, and an earlier version of this README said it was impossible. That
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
it probes), plus SciPy and soundfile (which it cannot) — python -m pip install scipy soundfile, in the same system Python. Fifty `daw_*` MCP tools, and a census
fails the build if a DAW route ships without one.

---

## The graphs are the product

[`workflows/`](workflows/) holds the four core pipelines Studio submits,
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

Studio can drive a **hosted** MiniMax Music 3 instead of a local one, for
machines that cannot run the model. Same model, someone else's hardware, **your**
API key — Studio calls the provider directly from your machine, so nothing is
proxied through anyone and the account is yours.

Everything around the music is unchanged: library, cover art, timed lyrics, the
studio timeline, overnight runs.

Two things do change, and Studio says both in the UI rather than in a footnote:

- **It costs money per song.** About $0.36 for three minutes. Overnight runs are
  the feature most worth having and the one most able to run up a bill
  unattended, so there is a **hard monthly cap** — default $20 — checked
  immediately before every call, not just when a batch is queued.
- **Audio reference and music input stop working.** Both encode a real recording
  into the model's own latent; hosted endpoints take text and return audio, with
  no latent to hand them. The control is disabled and labelled, not left to fail
  at submit.

Your key is stored with **Windows DPAPI**, tied to your Windows account and that
machine — a copied `secrets.json` is inert anywhere else. It is write-only across
Studio's own HTTP boundary: the browser is told a key exists, how it is
protected, and its last four characters, never the key. On platforms without
DPAPI it falls back to a `0600` file and says so plainly, because file
permissions are not encryption.

Off by default, and it cannot switch itself on.

## Settings that are not up for negotiation

In `server/config.js`, each measured rather than chosen. The mistakes that
produced them — silent axis flooring, a vendor filename that does not exist, a
CFG pair that doubles your render time if you let it differ — are collected in
[`docs/ENGINE_TRAPS.md`](docs/ENGINE_TRAPS.md), because a config comment is not
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

**247 tools.** The bulk of them are the specialist surfaces — 50 `daw_*`, 46
`mv_*`, 44 `vfx_*`, 17 `ab_*`, 11 `engine_*`, 6 `score_*`, 5 `music_input_*`,
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

And [`examples/`](examples/) is the other half of that: real requests with the
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

## Reactive — pictures that move with a song

The Reactive screen takes a song and a few pictures (from the Images library,
or made from a prompt on the spot) and renders a movie with the song on it: a
picture per bar, beat or hit, cut or dissolved on the beat, the frame breathing
with the bass, a flash on every beat, and a look on top — **Cuts**, **Crossfade**,
**Pulse**, **Film** (grain, vignette, a slow push-in) or **Psychedelic** (the hue
turning with the loudness).

It runs on the Studio's **own compositor** (the VFX screen's engine, which mixes
the song into the render itself), so it needs no video model and no second
ComfyUI: it works on any card the Studio runs on, an AMD card included. What it
builds is a real composition — open it on the VFX screen to keep editing, and
every knob is a `vfx_*` tool. Over MCP the whole thing is `reactive_render`.

The idea is Yvann Barbot's (ComfyUI_Yvann-Nodes, GPL-3.0); this is a re-creation
of it on our own engine, not their code, which is why it can ship inside the app.

---

## Working on this repository

**Testing an install without touching your own.** Copy the repo
(`git ls-files -co --exclude-standard`), run `npm ci` in the copy, then start
`scripts/setup.mjs` and `launcher/launcher.mjs` with `AIPLAY_APPDATA` pointing at
an empty folder, different `AIPLAY_LAUNCHER_PORT` / `AIPLAY_UI_PORT`, and
`AIPLAY_LAUNCHER_NO_WINDOW=1` (serves the launcher and its API but opens no
window or browser). Point `USERPROFILE`, `APPDATA` and `LOCALAPPDATA` at empty
folders too to simulate a PC with nothing installed.

**Run the gate before you push.** `sh .githooks/pre-commit` runs every test lane
in the repository — around six minutes, and it is the same gate that guards a
commit. It is not decoration: it holds the licence boundary, the parameter
census, the route/page parity checks and the suite-registration census that
fails when a test file exists but nothing runs it.

```
sh .githooks/pre-commit        every lane, about six minutes
node scripts/trace_load.mjs    just the boot check, about a second
npm test                       the JavaScript suites
```

**Three habits this codebase is built around**, each learned the hard way:

1. **Never claim more than you tested.** If a claim is not covered by an
   assertion, say so in the same breath as the claim.
2. **When you add something other code must know about — a tool, a screen, an
   event, a test suite — add the census that fails when the two sides
   disagree, in the same commit.** Every cross-file bug this project has had
   was two things that must agree with nothing checking that they did.
3. **Build the file list from `git status`, not from your plan.** A change once
   shipped a whole panel unmounted because the plan listed the new files and
   not the three shared ones the feature also needed.


## Known gaps

- **ETA is noisy in the first ~30 s** before it settles.
- **Preview → commit** is not wired end to end.
- No desktop wrapper yet. The frontend is web either way, so a Tauri shell would
  wrap this server unchanged.
- **Rigging cannot run on this machine**, and refuses rather than pretending —
  flash-attention has no Windows binary and building it needs a toolchain that is
  not here. The mesh half works; the rig half is catalogued, hashed and blocked.
- **No Blender blockout has been SCORED through VACE.** The gate's 0.924 was
  measured on a synthetic corridor, and the first real toolkit blockout through
  the route was watched rather than scored. Whether a stage set's placement
  reproduces the way the corridor's did is unmeasured.
- **Identity across shots is unmeasured** — not measured and failed. No performer
  has been carried across two clips in this stack.
- **The DAW's export-parity test compares no audio samples.** Parity holds by
  construction; the regression that would break it is uncovered.
- **The Reactive engine writes no provenance.** It is a second, user-owned
  ComfyUI on its own port, exempt from the door's census **by name**, with an
  assertion that the exemption can never widen to Studio's own engine. A smaller
  door for it is the follow-up.
- **Two model licences have not been read** — Ideogram 4's is behind a gate that
  returns 401 to an anonymous request, and the DWPose estimator has no readable
  terms at all. Both rows say so and neither claims rights.
