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
| Cover art — FLUX.2 klein 4B | 12.5 GB | Apache-2.0 |
| Stem separation — HTDemucs | 336 MB | MIT |
| Timed lyrics — Whisper large-v3 | 3.1 GB | MIT |
| Video clips — LTX 2.5 *(default)* | 39.7 GB | LTX-2.x Community ⚠ |
| Video clips — MiniMax H3 | 34.5 GB | MiniMax H3 Community ⚠ |

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
- **Cover art** drawn automatically while the GPU is idle.
- **Stems** (drums / bass / vocals / other) and **timed .lrc** files for visualisers.
- **Video clips** under a finished track, on either of two engines.
- **A small editor** — stacked tracks, drag clips to overlap them into a
  crossfade, a karaoke overlay driven by the timed lyrics, and a visualiser.
- **Overnight runs** — a list of ideas, N takes each, and a full library by morning.
- **Audio-reactive video** — pictures that change on the beat. Optional, and it
  needs a second engine Studio does not ship: see [REACTIVE.md](REACTIVE.md).

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

## The graphs are the product

[`workflows/`](workflows/) contains the four pipelines Studio actually submits,
exported straight from `server/workflow.js`. Drag one onto the ComfyUI canvas, or
find them in the sidebar under **AIPLAY** — export copies them into
`ComfyUI/user/default/workflows/`.

Regenerate after changing anything: `node scripts/export_workflows.mjs`.

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

## Layout

```
server/       config, the graph builders, the ComfyUI supervisor, the queue
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
