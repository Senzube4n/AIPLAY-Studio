---
title: "Build log: teaching a music model to accept audio it \"cannot encode\""
published: false
description: "AIPLAY Studio is a local music studio built on ComfyUI. This is the build log: the audio-reference path everyone calls impossible, measured at +26.26 dB, and a video schedule that runs 5.5x faster without a faster model."
tags: ai, opensource, machinelearning, music
cover_image: ASSET-COVER-IMAGE-URL
---

ASSET: cover-image
<!-- replace the `cover_image:` value above with the hosted URL for this asset -->

This is not an announcement post. It is a build log for [AIPLAY Studio](https://github.com/Senzube4n/AIPLAY-Studio), a local music studio that runs on your own GPU, and it leads with the two findings that were worth writing down. Everything below is a number I measured, on hardware I will name, with the scripts shipped in the repo so you can disagree with me in a reproducible way.

Start with the one that is supposed to be impossible.

---

## 1. The model that "cannot encode audio"

Every local MiniMax Music 3 tool tells you the same thing: you cannot feed it a song. ComfyUI is explicit about it. Ask it to encode audio and `comfy/sd.py` raises:

```
MiniMax Music3 DAV cannot encode audio
```

That is true as shipped. ComfyUI includes the DAV **decoder** and nothing else, so there is no route from a waveform back into the model's latent space. No route in means no audio reference, no "start from this track", no remix.

The encoder weights, however, exist — they are published separately from the ones ComfyUI distributes. The interesting part is what is inside that checkpoint. It carries decoder tensors too, and **121 of them are bit-identical** to ComfyUI's own `minimax_music3_dav.safetensors`.

Bit-identical decoders mean one latent space. Which means a latent encoded in a separate process is a latent the stock sampler already understands. No patched node, no fork of ComfyUI, no retraining, no tokenizer.

So: encode out of process, write a `.latent`, and let stock `LoadLatent` pick it up.

Round trip through `LoadLatent` → `VAEDecodeAudio`, measured:

| metric | result |
|---|---|
| SI-SDR | **+26.26 dB** |
| Pearson correlation | **0.999** |

That is the whole trick. The capability was never missing from the architecture; only one half of the weights was missing from the distribution.

ASSET: audio-reference-ab-player
{% embed ASSET-AUDIO-REFERENCE-AB-URL %}

### The dial, and what it actually controls

The strength control is not a blend slider. It is the length of the sigma schedule: keep only the tail and the flow starts partway down, so less of your reference gets destroyed on the way.

| strength | what you get |
|---|---|
| 0.90+ | reference effectively ignored — the trim removes under one step |
| **0.85** | **a genuine blend: its shape, your sound** |
| 0.80 | a variation on the same song |
| 0.60 | effectively a copy |

### What this is not

I want to be exact here, because the honest version is less exciting than the headline and it is the version that survives contact with users.

**The reference steers the render, not the composition.** The composition still comes out of your caption via the autoregressive stage. So you get *that song's shape with a new sound* — not *that song's tune with new words*. It is not a cover engine.

**Extending an uploaded track remains impossible.** Extension needs the autoregressive trajectory, and recovering one from audio needs an RVQ tokenizer that has never been released. Substitutes measure far too weakly to be worth shipping. That door is still shut, and I would rather say so than let someone discover it at 2am.

---

## 2. A video clip that renders 5.5x faster, from the same class of model

Studio can put a clip under a finished track. There are two engines behind that, and the comparison turned out to be a lesson about schedules rather than about models.

| engine | resolution × frames | steps | wall clock |
|---|---|---|---|
| MiniMax H3 | 1344×768 × 124 | 8 | 308 s |
| MiniMax H3 | 1344×768 × 124 | 20 | 660 s |
| LTX 2.5 | 1280×704 × 121, **with audio** | (see below) | **121 s** |

That is 2.5x faster than H3 at 8 steps and 5.5x faster at 20, and better by eye.

The thing to notice: **the speed is the schedule, not a faster model.** LTX 2.5's pipeline is

1. 8 steps at half resolution,
2. a latent 2x upscale,
3. only 3 steps at full size.

Almost all the sampling happens where pixels are cheap, and the expensive full-resolution pass only has to clean up. Once you have seen it, the 20-step-at-full-resolution default in most video graphs looks like paying retail.

One more measured trick, free in either engine: **for a seamless loop, pass the same picture as both first and last frame.** It still animates through the middle (mid-clip divergence 6.00 from the anchor) while returning home at the end (1.62). A looping clip under a looping track, with no editing.

ASSET: video-clip-ltx-loop
{% embed ASSET-VIDEO-CLIP-URL %}

### The licence footnotes, which are not footnotes

Both engines carry real constraints, and Studio shows them before it downloads anything:

- **MiniMax H3** grants rights only inside an "Applicable Territory" that **excludes the European Union, the United Kingdom and South Korea.** If you are in any of those, that is not a technicality, it is you.
- **LTX 2.5** lives in an access-gated repository: you must accept the licence and supply a HuggingFace token. Its terms require a paid agreement at **USD 10,000,000 annual revenue or above**, and forbid use in a product that competes with Lightricks' own offerings.

I am not a lawyer and Studio is not a licence launderer. It hosts no weights; every download goes straight to the publisher, and the agreement is between you and them.

---

## The rig every number above was measured on

- **GPU:** NVIDIA GeForce RTX 4070 Ti SUPER, 16 GB VRAM
- **RAM:** 32 GB
- **OS:** Windows 11
- **Stack:** torch 2.13.0+cu130, ComfyUI 0.33.0

One machine, one set of runs. Your card will produce different numbers; the ratios should survive.

---

## What the thing actually is

A Node server plus a static HTML/CSS/JS UI, driving **one long-lived ComfyUI process**.

That last part is the architecture, not an optimisation. ComfyUI caches node outputs within a process, and MiniMax Music 3's expensive autoregressive stage depends only on the caption, lyrics, seed and a few sampling params. Keep the process alive and re-rolling the mix reuses that stage. Restart per job and every re-roll costs full price, with nothing in the UI to explain why.

The measured effect, on music:

| operation | measured |
|---|---|
| engine cold start | ~15 s |
| fresh render | 39 s of audio in 65 s — **1.66x realtime** |
| re-roll the mix | **50 s → 15 s** |

The re-roll is worth dwelling on: it is *faster than realtime by a wide margin*, because only the render is redone, not the performance. That is what makes "try it again" a usable interaction instead of a coffee break.

Two smaller findings from the same tuning pass:

**There is no quality ladder in the DiT precision.** int8 vs fp16 against a converged reference: both **4.2 dB SNR, +10.8 dB NMR**. Pairwise SI-SDR across int8 / fp16 / fp32 came out **35.34 / 32.38 / 35.46 dB** — fp32 is not a point the others converge toward, it is just another sample. So int8 is the default, and there is no model-size switcher, because it would be a knob whose only effect is a larger download.

**Instrumentals need structure, not an empty lyrics box.** With nothing in the lyrics field the model has nothing to pace itself against and stops early. With eight bare section tags and no words:

| instrumental input | audio produced |
|---|---|
| nothing | 32.5 s |
| 8 section tags, no words | **157.2 s** |

Other runtime dependencies: `ws` (MIT). That is the list. Licence is Apache-2.0.

ASSET: screenshot-create-screen
![The Create screen: caption, lyrics, audio reference](ASSET-SCREENSHOT-CREATE-URL)

---

## It is built on ComfyUI, and the graphs are exported

Studio does not reimplement inference. Everything it does, it does by submitting a graph to ComfyUI.

That buys three things:

1. **Their nodes.** Every sampler, loader and scheduler is maintained by people who do that full time.
2. **Their updates.** When ComfyUI gains a capability, Studio inherits it without a release.
3. **No black box.** The four real pipelines are exported to `workflows/` as ComfyUI-loadable JSON — straight out of the code that submits them, not hand-drawn illustrations. Drag one onto the canvas and you are looking at exactly what the app runs.

That last point matters more than it sounds. The tuned values in those graphs are most of what Studio knows — the separate guidance scales for composition and render, the separate seeds for performance and mix, the sigma schedule, the video shift that neither official template exposes. All of it is readable, editable, and free to anyone who opens the files. A tool that hides its graph is asking you to take its tuning on faith.

ASSET: screenshot-workflow-in-comfyui
![One of the exported graphs open on the ComfyUI canvas](ASSET-SCREENSHOT-WORKFLOW-URL)

---

## The models do not come with it

Studio ships **no model weights**. Not as an oversight — as three separate refusals.

**Size.** The music engine alone is 11.9 GB. Add cover art (12.5 GB) and a video engine (34.5 GB or 39.7 GB) and a "batteries included" download is most of a hundred gigabytes for capabilities most people will not all use.

**Licences.** These weights carry genuinely different terms. Some are Apache-2.0 or MIT. One is territory-restricted. One is access-gated with a revenue threshold and a no-compete clause. Redistributing that pile as a single blob would either violate those terms or quietly transfer someone else's obligations onto me, and then onto you.

**Consent.** Nobody should discover after the fact that they downloaded 34 GB under a licence that excludes their country. The **Models** screen lists each capability with its **real byte count** and its **actual licence**, and fetches it only when you press the button. For H3 it states the territory exclusion and refuses to proceed without an acknowledgement.

| capability | download | licence |
|---|---|---|
| Music — MiniMax Music 3 | 11.9 GB | MiniMax Music3 Community |
| Cover art — FLUX.2 klein 4B | 12.5 GB | Apache-2.0 |
| Stems — HTDemucs (fine-tuned) | 336 MB | MIT |
| Timed lyrics — Whisper large-v3 | 3.1 GB | MIT |
| Video — MiniMax H3 | 34.5 GB | MiniMax H3 Community (territory-limited) |
| Video — LTX 2.5 | 39.7 GB | Lightricks (gated; revenue threshold; no-compete) |

Only the music engine is required. Everything else is optional and the app is fully usable without any of it.

ASSET: screenshot-models-screen
![The Models screen: byte counts, licences, and a fetch button per capability](ASSET-SCREENSHOT-MODELS-URL)

---

## Minimum hardware, stated separately

These are two different machines' worth of requirement, and collapsing them into one number would be a lie by rounding.

### For music

| | |
|---|---|
| **VRAM minimum** | 6 GB |
| **VRAM recommended** | 12 GB |
| Disk | 11.9 GB for the engine |

**The 6 GB tier is unproven.** It is derived, not measured — I have not run it on a 6 GB card. If you try it, I want to hear what happens; until someone does, treat it as an estimate rather than a promise.

### For video

| | |
|---|---|
| **VRAM minimum** | 16 GB, for both engines |
| Disk | 34.5 GB (H3) or 39.7 GB (LTX 2.5) |

Sixteen is where the measurements were taken, and video is where a smaller card actually falls over.

### For the rest

Cover art wants 8 GB VRAM minimum. Stems want 4 GB. Timed lyrics are 3.1 GB on disk.

---

## The three side capabilities, and what they actually do

Not features on a list — each one exists because it removes a step you would otherwise do by hand in another program.

**Stem separation** (HTDemucs fine-tuned, MIT, 336 MB, 4 GB VRAM) splits a finished track into drums, bass, vocals and other. **~12 s for a 30 s track.** That is what makes a generated song usable downstream: drop the stems into a DAW, mute the vocal for an instrumental, or feed one stem to a visualiser.

**Timed lyrics** (Whisper large-v3, MIT, 3.1 GB) transcribes the sung vocal back and aligns it, producing an `.lrc` for karaoke and visualisers. On a real track, **97.9% of words were timed by direct match**, and **~36 s** to process a 2.5-minute song. Honest caveat: **line timing is reliable, word timing is approximate on sung vocals.** Held notes, melisma and stylised delivery are exactly where forced alignment gets vague, and no amount of confidence in the README changes that.

**Cover art** (FLUX.2 klein 4B, Apache-2.0, 12.5 GB, 8 GB VRAM) draws a cover in **~3 s**. It runs only when the music queue is empty, and music preempts it — post-processing never competes with the thing you are waiting for.

---

## Install, in three steps

1. **Install Node.js.** The LTS installer from [nodejs.org](https://nodejs.org), about 30 MB.
2. **Have a ComfyUI.** If you do not already, [install it](https://github.com/comfyanonymous/ComfyUI) and run it once. Studio does not bundle a copy: ComfyUI is gigabytes before any weights and it updates on its own schedule.
3. **Double-click `Start AIPLAY Studio.cmd`.**

That is the whole launch story. First run fetches the single npm dependency, finds your ComfyUI (it checks the usual places across every drive, and asks if it cannot find one), and opens your browser. Then open **Models** and fetch what you want.

The launcher is a readable `.cmd` file rather than an `.exe` on purpose. A downloaded binary that wants to touch tens of gigabytes of model weights deserves more suspicion than a fifteen-line batch script you can read in full.

---

## The limits, collected in one place

Since they are scattered through the post, here they are together — this is the list I would want to read before spending an evening on someone else's tool.

- **The 6 GB music tier is unproven** on real hardware. It is an estimate.
- **MiniMax H3 is region-locked** — its licence excludes the EU, the UK and South Korea.
- **LTX 2.5 is access-gated**, needs a HuggingFace token, requires a paid agreement above USD 10M annual revenue, and forbids competing use.
- **Word-level lyric timing is approximate** on sung vocals. Line timing is solid.
- **Audio reference steers the render, not the composition.** Its shape, your sound. Not a cover engine.
- **You cannot extend an uploaded track.** That needs an unreleased RVQ tokenizer.
- **All numbers come from one machine** — an RTX 4070 Ti SUPER with 16 GB. Expect different absolutes.

---

## Try it, or just read the graphs

Repo: **https://github.com/Senzube4n/AIPLAY-Studio** — Apache-2.0.

If you never run it, the `workflows/` directory is still worth ten minutes. Four real pipelines, tuned values, no illustrations. And if you have a 6 GB card, please tell me what happens.

ASSET: screenshot-library-or-hero
![A finished song in the library, with cover art and stems](ASSET-SCREENSHOT-LIBRARY-URL)
