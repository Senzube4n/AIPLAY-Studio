# Where a distant face stops being usable, and what it costs

Measured 2026-09-02 on this rig. Six H3 renders, one prompt, one seed, one
reference, 56 frames each — only the size varied. Scripts: `scripts/h3_ressweep.mjs`,
`scripts/ressweep_score.py`.

The question was: *"upscaling won't solve small faces that are a bit further away.
It's best to get it native a bit over the default... maybe do some testing and
judge."*

---

## The table

| size | 56f wall clock | face px | face % of frame | 3-min video |
|---|---|---|---|---|
| 1344×768 **native** | 275.6 s | 58 | 7.55% | 7.7 h |
| 1536×864 | 375.8 s | **50** | 5.73% | 10.6 h |
| 1664×936 → **928 delivered** | 460.9 s | 62 | 6.63% | 13.1 h |
| **1792×1008** | 591.2 s | **84** | 8.38% | **16.9 h** |
| 1920×1088 | 721.4 s | 84 | 7.77% | 20.7 h |
| 1344×768 (2nd seed) | 260.5 s | 55 | 7.16% | — |

## The answer, and the correction underneath it

**1792×1008 is the knee.** It is the first size where a whole class of 1–2 px
feature survives — eyelid crease, lash line, individual brow hairs, nostril wing,
defined nose tip. At native's 58 px those are simply absent. **1920×1088 buys
nothing**: identical face and mouth measurements for 22% more wall clock.

**But resolution alone never gets you there, and the premise needs correcting.**
Set a second bar — "the mouth can actually be lip-synced", face ≥ 96 px — and
**no size on the ladder meets it**, 1920×1088 included. The lever that works is
**framing**. Reframe performance shots chest-up and 1792×1008 clears the bar with
margin; stay knees-up and no render size rescues it.

The 1536×864 row proves this on its own and is the most useful single result here:
it cost **36% more than native and produced the smallest face on the ladder** —
not a resolution effect, but because the model chose to frame the subject further
away (5.73% of frame height against native's 7.55%). More pixels, smaller face.

## What makes the table readable

A second seed at native was rendered specifically to establish the noise floor,
and it is what licenses reading anything else:

- **face_px repeats to ~5%** (58 vs 55) and framing to ~5%. So the 50 → 84 px
  spread across sizes is signal, not draw.
- **Sharpness does not repeat at all** — 520.5 vs 754.7 at identical size and
  composition, a 45% swing. **Raw variance-of-Laplacian must not be used to rank
  sizes**, and it structurally penalises bigger faces anyway, because a 50 px face
  is aliased and an 84 px one renders skin smoothly. That is backwards for this
  question.
- Warm 261 s against cold 276 s puts model load at ~15 s, so every other row's
  wall clock is essentially pure render.

## ~~Clip length is not the binding constraint — size is~~

### 🔴 WITHDRAWN 2026-09-10. Length matters, past a threshold we never reached.

The claim here was: at 1792×1008, delivering a fixed 3 minutes costs **16.1–20.6
GPU-hours across the entire legal length range** (56 to 209 frames) — a 28% band
against a 2.7× range for size — so cut to the music, not to the budget.

**That was extrapolation, not measurement, and it is wrong at the top end.**

Every row of this sweep rendered **56 frames** (`SECONDS = 2` in
`scripts/h3_ressweep.mjs`, fixed, because the question was spatial). The 56→209
band was produced by running `config.h3`'s cost model over a length range
*nothing on this rig has ever rendered* — using the exponent this same document
flags, two sections down, as under-quoting by −19% at the expensive corner.

An external replication (Nemyra, 158 logged H3 renders) measured what actually
happens up there. Cost is smooth to roughly **331k latent tokens** and then is
not: **30% more frames cost 2.6×**, and the two renders past that point were the
only two of 158 to exceed an hour — one logging two hard OOMs before its third
attempt completed in 117 minutes:

    Allocation on device 0 would exceed allowed memory.
    Currently allocated 8.86 GiB, Requested 8.91 GiB (comfy_kitchen int8_linear)

Their smooth-regime numbers reproduce ours exactly (864×480 → 1344×768 at 124f:
3.2 → 11.8 min, matching the 1.43 area exponent), which is what makes the
divergence at the top credible rather than a rig difference.

**Where our measurements actually stop.** Latent tokens are
`video_latent_t(frames) × (h/16) × (w/16)`, from `nodes_minimax_h3.py`:

| render | latent tokens |
|---|---|
| this sweep, 1344×768 × 56f | 68,544 |
| this sweep, 1792×1008 × 56f | 119,952 |
| this sweep, 1920×1088 × 56f (largest row) | 138,720 |
| the shift resweep / cost-model anchor, 1344×768 × 124f | **149,184** |
| — the observed cliff — | **~331,000** |
| 1792×1008 × 209f, the number this section quoted | 437,472 |

**Nothing in this repository has rendered above ~149k tokens.** The cost model is
fitted entirely inside the smooth regime and then extrapolated straight through a
discontinuity it has no way to know about — at 2.2× beyond our largest render.

**So the honest position:** size dominates *within the range we measured*, and
the face-pixel results above stand — they are all 56-frame renders and unaffected.
But "cut to the music, not to the budget" is withdrawn as general advice. Past
~331k tokens the length term stops being cheap and starts being the thing that
OOMs. Anyone planning a long clip at or above native area should treat ~331k as a
ceiling to test against, not a number to extrapolate past.

## Two bugs found on the way, both fixed or filed

**1. `videoSizeFor` lied about H3, and it is the same scar as 544.** 1664×936 was
requested; the function returned `1664×936, quantised: false, grid: 1`; the engine
delivered **1664×928**. `MiniMaxH3ReferenceToVideo` builds its latent as
`height//16` and decodes at `latent*16`, so any axis that is not a multiple of 16
is floored silently. The function's own comment says keeping both answers in one
place is "the entire way that 544 survived" — and then its H3 branch modelled
nothing. **Fixed** in `server/workflow.js`: the H3 branch now quantises to grid 16.
Every size actually in use is unaffected.

**2. The cost curve under-quotes exactly where it hurts.** `config.js` uses
exponent 1.2. The sweep fits **1.43 on area** and **1.34 on frames**: error is +5%
at native/56f but **−19% at 1920×1088/124f**. It under-quotes the expensive corner,
which is the corner where a bad quote actually costs someone a night. Worth
re-fitting while this data is fresh — not done, to avoid changing queue arithmetic
mid-render.

## Caveats worth carrying

- **The mouth column never measured a mouth.** `mouth_px` is `face_px/3`, the lower
  third of the detector box — and in all six clips a microphone and hand occupy
  that region. The verdict rests on eyes, brows and nose, a fair proxy for facial
  detail but not a direct observation of a readable lip. A follow-up sweep should
  render a shot with no mic in frame.
- **n = 1 per size.** The noise floor was measured at one size only. The framing the
  model chooses is non-monotonic in size (5.73% → 8.38%) and is a real source of
  variation a second seed per row would pin down.
- **1792×1008 is 1.75× the model's declared canvas.** `nodes_minimax_h3.py` sets
  `MAX_PIXELS = 768 × 1344`, exactly native. Both over-native sizes rendered
  cleanly here, but neither is trained territory.
- **Multiple references cost more than this measured.** `ref_image_size` is
  hardcoded to `"match"`, so each reference is scaled to the *generation's* pixel
  area — rendering at 1792×1008 makes every reference 1.75× larger in tokens,
  attended on every step of every block. The sweep used one reference; a music
  video will use two or three.
- **The detector environment is a landmine.** This rig has OpenCV 5.0.0, which
  **removed `cv2.CascadeClassifier`** and leaves `cv2.data.haarcascades` pointing at
  a directory containing only `__init__.py`. Scoring ran in an isolated OpenCV
  4.12 venv. Anyone re-running these scripts will hit this.

## And the engine assumption was wrong

The brief assumed H3 was forced because only it can drive a mouth from a vocal.
**LTX can too**, and the code is unambiguous: `comfy/ldm/lightricks/av_model.py`
defines `audio_to_video_attn` in every block, `run_a2v` defaults to **True**, and
ComfyUI ships `LTXVModalityGuidance` whose own tooltip reads "strengthening
audio-visual sync (e.g. lip-sync). Reference default modality_scale is 3.0." A
vendor does not write a node to amplify a capability the model lacks. The repo's
LTX graph already freezes a real vocal with a zero noise mask, so the video stream
attends to ground-truth audio on every step of both passes.

**That matters for cost.** LTX is 5.5× faster than H3. If it holds up on lip-sync,
a full-length music video at the knee resolution goes from a two-night job to an
overnight one.

### It was tested, and it did not hold up

Measured the same night, on 19 clips of the "Measure Twice" music video rendered
through `videoGraphLtx` with the real vocal frozen in as an audio latent:

**Correlation between mouth-region motion and the audio envelope: mean +0.034,
median +0.073, n = 18.** Working lip-sync would be 0.3–0.6. This is nothing.

The check is worth describing because it could have measured the wrong thing and
did not. Mouth motion was taken over a fixed rectangle at 30–62% frame height,
which only finds a mouth if the framing put one there — so the contact sheet was
read as well, and the framing *is* correct: chest-up, faces well-sized, several
clips catching a mouth open mid-word. Per-clip mouth motion runs 4–14, so mouths
are moving. They are simply not moving **with this audio**.

So the code reading was right about the mechanism and wrong about the outcome.
`audio_to_video_attn` exists, `run_a2v` is on, the vocal is genuinely pinned with
a zero noise mask — and the result still renders *someone rapping* rather than
someone rapping *this*. Possible explanations, none tested: the a2v pathway may
need `LTXVModalityGuidance` explicitly in the graph (it is not wired by
`videoGraphLtx`), the distilled 2.5 checkpoint may not carry the AV training, or
the two-pass schedule may wash the coupling out.

**The honest position: LTX lip-sync is unproven, not disproven-in-general — but
it does not work as currently wired, and nothing should be planned on it.** The
next measurement is to add `LTXVModalityGuidance` at modality_scale 3.0 and
re-run exactly this correlation.

One separate defect found in the same pass, worth recording because it is a
production problem rather than a model one: **identity drifts between clips.**
Framing was locked and identity was not, so the performer is visibly a different
man in several shots. LTX takes a `firstFrame`, so the fix is to generate one
portrait and seed every clip from it.
