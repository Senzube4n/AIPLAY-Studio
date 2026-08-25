# AIPLAY Studio

Local music generation with MiniMax Music 3. Write a style and some lyrics, get a
song — on your own machine, no account, no credits, no upload.

It is a face on [ComfyUI](https://github.com/comfyanonymous/ComfyUI). Everything
it does, it does by submitting a graph, and those graphs are in
[`workflows/`](workflows/) so you can open the real pipeline and change it.

---

## Install

**1. Node.js** — [nodejs.org](https://nodejs.org), the LTS installer, ~30 MB.

**2. ComfyUI** — if you do not already have one,
[install it](https://github.com/comfyanonymous/ComfyUI) and run it once. Studio
does not bundle a copy: ComfyUI is gigabytes before any weights, it updates on
its own schedule, and most people who want this already have it.

**3. Double-click `Start AIPLAY Studio.cmd`.**

That is the whole thing. On first run it fetches one npm package, finds your
ComfyUI (it checks the usual places across every drive, and asks if it cannot),
and opens the browser.

Then open the **Models** screen. Nothing downloads on its own — each capability
states what it needs, how big it is, what licence it carries, and whether your
card can run it. One button fetches it, resuming if the connection drops.

| capability | download | licence |
|---|---|---|
| Music engine — MiniMax Music 3 | 11.9 GB | MiniMax Music3 Community |
| Audio reference — the DAV encoder | 306 MB | MiniMax Music3 Community |
| Cover art & images — FLUX.2 klein 4B | 12.5 GB | Apache-2.0 |
| Images — Ideogram 4 (open 9B) | 25.2 GB | Ideogram Non-Commercial ⚠ |
| Stem separation — HTDemucs | 336 MB | MIT |
| Timed lyrics — Whisper large-v3 | 3.1 GB | MIT |
| Video clips — LTX 2.5 *(default)* | 39.7 GB | LTX-2.x Community ⚠ |
| Video clips — MiniMax H3 | 43 GB | MiniMax H3 Community ⚠ |
| Video references — H3 ref2va | 23 GB | MiniMax H3 Community ⚠ |
| Smooth motion — RIFE 4.26 | 22 MB | MIT |
| Upscale — Real-ESRGAN 2x | 67 MB | BSD-3-Clause |

Two video engines, and **LTX 2.5 is the default** — it renders a 5-second clip at
1280×704 in about 121 s against H3's 660 s at 20 steps, and looks better doing it.
H3 is kept because it is the one trained with a first *and* last frame, which is
what a seamless loop wants.

⚠ Both video licences restrict more than the audio ones do, and Studio treats
them as blocking rather than as a footnote:

- **H3** grants rights only inside its Applicable Territory, which **excludes the
  EU, the UK and South Korea**. Studio refuses the download without an
  acknowledgement.
- **LTX 2.5** requires a paid agreement above USD 10M annual revenue, forbids use
  in a product competing with Lightricks' own, and its repository is access-gated
  — so Studio cannot fetch it for you and says so instead of failing oddly.

One image licence deserves the same treatment: **Ideogram 4 is non-commercial**
— personal and research use only, no commercial use of the model *or its
outputs*. The Models screen says so where you choose it, and if this studio
makes money for you, FLUX.2 (Apache-2.0) is the engine to render with.

Studio hosts no weights: every download goes straight to the publisher, and the
licence is between you and them.

Only the music engine is required. Everything else is optional and the app is
fully usable without any of it.

---

## What it does

- **Write a song** from a style description and lyrics, or an instrumental from
  a structure.
- **Re-roll the mix** — same performance, new render, ~60% of the cost.
- **Extend** a take, branch it, and merge the branches back into one song.
- **Start from an existing song** — see *Audio reference* below.
- **Cover art** drawn automatically while the GPU is idle, on the engine you
  pick in Settings.
- **Standalone images** on three engines — FLUX.2 klein, the open Ideogram 4,
  or any checkpoint of your own — with a real editor behind the gallery. See
  *Images* below.
- **Stems** (drums / bass / vocals / other) and **timed .lrc** files for visualisers.
- **Video clips** under a finished track, on either of two engines.
- **A small editor** — stacked tracks, drag clips to overlap them into a
  crossfade, a karaoke overlay driven by the timed lyrics, and a visualiser.
- **Overnight runs** — a list of ideas, N takes each, and a full library by morning.
- **Audio-reactive video** — pictures that change on the beat. Optional, and it
  needs a second engine Studio does not ship: see [REACTIVE.md](REACTIVE.md).
- **An MCP server** — an agent can drive all of the above. See *Drive it from
  an agent* below.
- **A minigame** for while the queue renders — 2248, the connect-merge number
  game, on the Games screen. The ruleset (and why a chain rounds *up*) is
  written out in the header of `web/games.js`.

Post-processing never competes with music: it runs only when the queue is empty,
and music always preempts.

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
song's shape, a new sound" — not "that song's tune with new words". Extending an
uploaded track is still impossible: that needs the AR trajectory, and getting one
from audio needs the RVQ tokenizer nobody has released.

Generality was measured too, since the encoder only ever saw music: MP3 128k
**22.0 dB**, MP3 64k 22.6, room reverb 23.9, mono 25.1, resampled through 22 kHz
25.2, loudness-war clipped 22.4, pitch-shifted +3 semitones 17.8. It holds up on
ordinary material.

---

## Images

The Images screen is the cover-art pipeline given its own room: a prompt on the
left, a masonry gallery on the right — hover a tile for its prompt, seed and
render time. Three engines:

- **FLUX.2 klein** *(default)* — fast, Apache-2.0, and the only engine that
  takes **reference images**: the prompt refers to them as "image 1",
  "image 2" — "the character from image 1 in the scene from image 2" — which is
  how a character stays consistent across pictures. References are reachable
  through the API and the MCP tools; the screen itself has no attach control
  yet.
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
- **Audio reference stops working.** It encodes a real recording into the
  model's own latent; hosted endpoints take text and return audio, with no latent
  to hand them. The control is disabled and labelled, not left to fail at submit.

Your key is stored with **Windows DPAPI**, tied to your Windows account and that
machine — a copied `secrets.json` is inert anywhere else. It is write-only across
Studio's own HTTP boundary: the browser is told a key exists, how it is
protected, and its last four characters, never the key. On platforms without
DPAPI it falls back to a `0600` file and says so plainly, because file
permissions are not encryption.

Off by default, and it cannot switch itself on.

## Settings that are not up for negotiation

In `server/config.js`, each measured rather than chosen:

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

| tool | one line |
|---|---|
| `studio_status` | engine health, what is rendering, queues, library size |
| `make_song` / `wait_for_song` | write and render a song; block until it is done |
| `list_songs` | the library, newest first, with what each track already has |
| `get_beats` | measured tempo, beat/bar grid and per-band loudness of a track |
| `make_image` / `list_images` | draw pictures on any of the three engines; FLUX takes `ref_images` |
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

The one thing it cannot do is export the finished video file: Studio's export
is a real-time browser capture of a canvas, so `build_music_video` writes a
**project** and a person opens it and presses Export. Saying that plainly beats
a tool that appears to render and returns something that is not a video.

---

## Layout

```
server/       config, the graph builders, the ComfyUI supervisor, the queue,
              the image tools, the MCP server
web/          the UI — plain HTML/CSS/JS, no build step
workflows/    the four pipelines, as ComfyUI can open them
scripts/      setup, the DAV encoder, and the measurement harnesses
```

The measurement scripts ship on purpose. Every number above is a checkable claim,
and a claim nobody can re-run is just an assertion.

## Settings you can change

**Folders** (Settings → Folders) — where songs go, and where ComfyUI lives. Both
become launch arguments for the engine, so they take effect on restart. Stored in
`~/.aiplay-studio/settings.json`; `AIPLAY_RIG` and `AIPLAY_OUTPUT` override.

**Cover art** (Settings → Cover art) — which engine paints the library's covers
(FLUX.2 klein, Ideogram 4, or your own checkpoint), and the editable **style
line**. Every auto cover prompt is two halves: the style line, then
`, evoking <subject>` — the subject taken from the song's caption with musical
notation stripped out (note names were getting carved into the pictures),
falling back to the title, and for untitled tracks to a rotating pool of
neutral objects indexed by seed, so a library of captionless takes gets sixteen
different subjects instead of one rock eleven times. Edit the style line and
every future cover follows; the per-song subject stays automatic. Applies to
the next cover, no restart — and the Images screen keeps its own per-picture
engine choice.

## Audio-reactive video (optional, separate)

The Reactive page cross-fades reference images against each other in time with a
song's detected peaks — images to video, video to video, or text to video.

It is **not part of a Studio install**. The pack that does the work is GPL-3.0
and cannot ship inside an Apache-2.0 app, so it runs on a second ComfyUI that
you set up and Studio talks to over HTTP — the same arms-length boundary that
already applies to ComfyUI itself. Studio never downloads or installs any of it.

With no engine running, the page shows the setup rather than controls that fail.

Setup, licences and the reason it cannot live in Studio's own engine:
**[REACTIVE.md](REACTIVE.md)**.

---

## Known gaps

- **ETA is noisy in the first ~30 s** before it settles.
- **Preview → commit** is not wired end to end.
- No desktop wrapper yet. The frontend is web either way, so a Tauri shell would
  wrap this server unchanged.
