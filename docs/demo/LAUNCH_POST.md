# The Hex Appeal post

Draft copy for X. Nothing here claims anything the repo cannot back up — the
numbers are checked against the build, and the two that are not checkable yet
are marked. Pick a variant, don't post all three.

---

## ⚠ Read this before posting

**X caps video at 2:20 for a standard account.** `docs/demo/hex-appeal.mp4` is
**3:28** (208s, 720×412, 24fps). Three ways out, in the order I'd rank them:

1. **Cut a 60-second version.** Best for the platform regardless of the cap —
   long video dies in the timeline, and a minute is enough to sell it. Say the
   word and I'll cut it to the strongest stretch and hand you the file.
2. **Post the full thing from a Premium account**, which raises the limit.
3. **Post a 60s teaser and put the full film in reply 3** as a YouTube link.

Also: the video is **letterboxed 1.75:1**. X crops aggressively on mobile. A
1:1 or 4:5 re-frame of the same cut will take up roughly twice the screen. I
can render that too.

---

## Variant A — the fact does the work

> This music video was made entirely on one desktop PC.
>
> The song. The lyrics. The cover. All 44 shots. The edit and the grade.
>
> No cloud. No account. No credits. Nothing uploaded.
>
> It's free and the whole studio is open source. 👇

*Why this one:* it leads with the single hardest-to-believe claim and then
proves it by being specific. "44 shots" is what stops the scroll — it is a
number nobody uses in marketing copy because nobody counts.

## Variant B — the grievance hook

> Every AI video tool wants a subscription, an upload and your face in their
> training set.
>
> So this is a whole creative studio that runs on your own machine instead.
> Music, images, video, a real DAW and a compositor. Free, open source, offline.
>
> The video is what it makes.

*Why this one:* it's the angriest, which travels furthest, and the product
genuinely answers the grievance rather than gesturing at it.

## Variant C — the plain one

> Made a music video without opening a single website.
>
> AIPLAY Studio: write a song, draw the cover, cut the video, mix it. All local,
> all free, all open source.
>
> 3 minutes 28 seconds, one GPU, zero uploads.

---

## Reply 2 — what it actually does

Keep it to a screen. Nobody reads a feature list; they read a *shape*.

> What's in it:
>
> 🎵 Songs from lyrics + a style line — vocals, instruments, the lot
> 🎨 Images and cover art, plus a Photoshop-class editor
> 🎬 Music videos: shot planning, rendering, a real timeline and a compositor
> 🎚️ A DAW with instruments, effects and a mixer
> 🧠 An AI agent can drive the entire studio, not just chat about it
>
> NVIDIA, AMD, Intel Arc — or just your CPU.

## Reply 3 — the ask

> Free, Apache-2.0, no account, no telemetry.
>
> github.com/Senzube4n/AIPLAY-Studio
>
> Music-only mode installs in a couple of minutes if you just want the songs.

---

## Notes on accuracy

Checked against the build:

- **44 shots** — the Hex Appeal board is 44 scenes. ✅
- **3:28** — `ffprobe` says 208.29s. ✅
- **One GPU** — everything rendered on the one RTX 4070 Ti SUPER in this box. ✅
- **Apache-2.0, no account, no telemetry, local-only** — ✅, and the README
  leads with it.
- **NVIDIA / AMD / Intel Arc / CPU** — ✅ for the music path; the image and
  video engines want a real GPU. The reply above says "NVIDIA, AMD, Intel Arc —
  or just your CPU" directly under a *list that includes video*, which reads as
  a promise the CPU path does not keep. If you want it airtight, move that line
  under the music bullet instead of under the whole list.
- **"an AI agent can drive the entire studio"** — 289 MCP tools as of this
  commit, covering every page. ✅

⚠ **Not checkable, so not claimed anywhere above:** how long the render took
end to end, and what it would have cost on a commercial service. Both are the
obvious things to put in a viral post and I have no defensible number for
either — an invented one is the kind of thing that gets quote-tweeted with a
receipt.

## Timing

Five shots are still re-rendering (the black-slab fix). The film in
`docs/demo/` is the version *before* those land. Worth waiting for them and
re-cutting before this goes out — the defect is visible in the current cut and
a viral post is the worst place to be showing it.
