# Why reference images bleed through on the 4-step H3 turbo path

Investigated 2026-09-02, read-only, from ComfyUI's source and this repo's own
clip ledger. **Nothing was rendered for this document** — every claim below comes
from code and history, which is exactly why the settling experiment comes before
the fix.

---

## The short version

Nothing blends your reference into the output. There is no alpha blend anywhere
in this path.

The reference is fed to the model as **extra rows of the same attention sequence
as the video being generated**, parked one time-unit in front of frame 0 — closer
to frame 0 than frame 1 is — and presented essentially pixel-clean. At 4 steps
with shift 12, the model's last look at the noise is at **sigma 0.800**, and
whatever it predicts there *is* the final output. It has to invent 80% of the
picture in one jump, and the only clean, high-information image in its field of
view is your reference. So it leans on it.

## CONFIRMED, visually, 2026-09-02

**The symptom is mechanism (1), reference-COPY, and it is not subtle.** On
`mv_bone-waffle-cgi_s1_4_mtgkjbnr.mp4` (4 steps, 1920×1088, 3 references) the
**first three output frames are reference 3 almost verbatim** — the same waffle
iron, pot, skull and candle arrangement. By frame 15 it is opening up, by frame 30
the character enters, and from frame 60 on it is the intended scene.

So this is **not** a translucent ghost lying over the whole clip. The reference
*occupies the opening frames and then hands over*, which is exactly what the RoPE
adjacency predicts: the last reference sits 1.000 time-units from frame 0 while
frame 1 sits 1.667 away, so a copy head's pull is strongest at the very start and
washes out.

`scripts/h3_bleed.py` was written to measure this and needed two corrections
before it agreed with the eye — both worth knowing, because both are easy to
repeat:

1. **Best-of-references hides the decay.** Taking the max over references per
   frame tracks whichever reference dominates, so when early frames match the
   kitchen reference and later frames match the character reference, the curve
   stays flat. It reported decay −0.18 and classified the clip "rising, neither
   mechanism". The copy signature lives in *one* reference's own curve — whichever
   owns frame 0, measured against itself across the clip.
2. **References must be aspect-fitted, not stretched.** The references in use are
   942×395, 1372×1190 and 768×1344 — the last is portrait. Squashing that into a
   landscape analysis frame destroys a correlation the eye sees instantly. The
   pipeline itself preserves aspect (`ref_image_size: "match"` scales to equal
   *area*), so measuring against a stretched reference measures something the
   model was never shown. Fixing it took the worst clip from z = 3.05 to
   **z = 6.54** and its copy decay from 0.044 to 0.152.

Measured on six recent 4-step reference-conditioned clips, against a null pooled
over every mismatched reference: BLEED positive on 5 of 6, three clearing z = 2,
copy-decay positive on 4 of 6. **The metric corroborates; the picture settles it.**

## The hypothesis that was wrong

The obvious suspect was `visual_cond_noise_aug`, which defaults to 0.999 and
which **nothing in the codebase ever sets** (4 hits, 2 files, zero producers).
The guess was that it leaves the reference under-noised at low step counts.

Backwards. Work the arithmetic: `r = 0.999·z + 0.001·ε` is a signal-to-noise
ratio around 60 dB — a 0.1% perturbation of a unit-scale latent. The reference
row is effectively pixel-exact. And the audio twin defaults to exactly 1.0, which
*skips* the branch, so 0.999 is the model's trained visual-condition timestep, not
an arbitrary "almost one".

**0.999 is the reference-maximising setting. The missing node is the missing
cure, not the cause.**

## The mechanism, traced

References reach the output through exactly one door — full self-attention over a
packed sequence. `MiniMaxH3ReferenceToVideo` VAE-encodes each reference into
`ref_blocks` (`nodes_minimax_h3.py:304`), which become `minimax_refs` on the
conditioning, arrive as an `extra_conds` kwarg via `samplers.py:940`, and are
packed into one row buffer alongside the target in `ldm/minimax/model.py:594-601`.
Fifty DiT blocks then attend over the whole thing. Reference rows are never
decoded (`model.py:662`) — they only ever influence through attention.

Two things make that influence unusually strong here:

**1. RoPE geometry.** Each image reference occupies a time span of exactly 1.0
and the target timeline starts right after it, while target frame spacing is
`FRAME_RESCALE × FRAME_PER_TOKEN` = **1.667** for frame 0 → frame 1. So the last
reference sits **1.000 from frame 0, while frame 1 sits 1.667 away** — the
reference is a closer temporal neighbour to frame 0 than the next frame is.
Spatially, `ref_image_size: "match"` (hardcoded, `workflow.js:1404`) scales the
reference to the generation's pixel area, so a 16:9 reference at 1344×768 lands on
a latent grid with *coordinates identical to every target frame* (verified
numerically: both h [3.905…27.087] step 1.00791). Identical spatial coordinates
plus the closest possible time offset is precisely the geometry a "copy the token
one step back" attention head exploits.

Note this **does not scale with reference count** — the span is a flat 1.0, so the
last reference is always exactly 1.000 away. Cutting references will not help.

**2. Four steps is qualitatively different, not merely less converged.**
`res_multistep` takes a plain Euler step when `sigma_down == 0`, so the output *is*
the x0 prediction at the final sigma. With `simple` + shift 12:

| steps | final eval sigma | evals at σ ≤ 0.8 |
|---|---|---|
| 4 | **0.800** | 1 |
| 8 | 0.632 | 2 |
| 20 | 0.387 | 5 |
| 25 | 0.333 | 6 |

The 4-step run's *last* evaluation is the 25-step run's 19th of 25. It stops
exactly where the long run still has six to go. An x0 estimate at that noise level
is a posterior mean, and the posterior mean of a multimodal distribution
conditioned on a clean, RoPE-adjacent reference looks like the reference.

## The competing explanation, which is entangled and cheaper to test

**All 57 four-step clips ran at 1920×1088** — 2.55× the pixel area of the
1344×768 this repo's own config calls native — on a **v0.1 pre-release** 4-step
LoRA whose fl2v sibling is explicitly tagged "768p". Few-step distillations
degrade sharply off their training resolution.

## Settling experiment — run this before any fix

Nine renders, no new code. One clip that visibly bleeds; prompt, references and
seed fixed:

| | steps | size | shift |
|---|---|---|---|
| **A** control | 4 | 1920×1088 | 12 |
| **B** schedule | 4 | 1920×1088 | 3 |
| **C** resolution | 4 | 1344×768 | 12 |

× 3 seeds. **The seeds are not optional**: commit `b056b11` already retracted an
H3 shift finding because seed spread exceeded between-condition spread on every
metric.

- B ≫ A, C ≈ A → the sigma-0.800 commit is the cause. Ship fix 1.
- C ≫ A, B ≈ A → it is running a v0.1 distillation at 2.55× its native area.
  Render 4-step at 1344×768 and upscale; leave shift alone.
- Both help → both are real, take both.
- Neither → the reference wins on attention regardless of noise level; escalate
  to fix 2.

**Scoring:** `h3_score.py` measures psnr_ref / loop_db / flicker / audio_rms —
none of which detect bleed. Add per-frame normalised cross-correlation between
each output frame and each reference, plotted against frame index. The *shape* is
diagnostic: decaying from frame 0 means reference-copy, flat across the clip means
posterior-mean collapse.

**Free pre-check, no GPU:** for a portrait reference the code predicts the ghost
lands as a **tall narrow band through the vertical centre**, because `_frame_grid`
area-normalises around centre 16.0. If a bleeding clip shows that, mechanism (1)
is confirmed before a single render.

## Fixes

**Fix 1 — lower the sigma shift on the turbo path only.** One config edit, zero
extra render time, node already in the graph. Add `turboShiftVideo: 3.0` /
`turboShiftAudio: 0.75` (keep the 4:1 ratio — equalising them collapses audio onto
the video schedule) and have both `MiniMaxH3SigmaShift` sites pick by the existing
`useTurbo` flag. Effect: 4 steps commits from **0.500 instead of 0.800**; 8 steps
from 0.300, better than shift 12 reaches at 20 steps. Gate on `useTurbo` so the
20-step quality path keeps the vendor's 12.0, which *is* backed by measurement.
Intermediate options if 3.0 overshoots: 6 → 0.667, 5 → 0.625, 4 → 0.571.
*(Since 2026-09-12 the UNSET default is no longer 12 on every turbo path: the
graph runs the shift the loaded LoRA was trained at — 6 for the 4-step fl2v
build. The knob still wins when set. See the post-mortem below.)*

**Fix 2 — a ~20-line node setting `minimax_visual_cond_noise_aug`.** The actual
dial, and the wiring is verified end to end with no core patch. Sweep
0.999/0.95/0.9/0.8/0.7. Two honest caveats: it also weakens hard frame guides, and
it is unknown whether the model saw varied condition timesteps in training — if
only 0.999, lowering it is off-distribution. The sweep settles that itself:
graceful monotonic weakening means trained with variation, a cliff at the first
step off means it was not. **Requires the user's say-so — a self-written custom
node is still arbitrary Python in an engine with a live queue.**

**Do not** cut reference count (span is flat 1.0). **Do not** patch
`model.py:97-98` to change `_ref_t_span` — seductive one-liner, no vendor
implementation to diff against, and if 1.0 is the trained value it puts every
reference somewhere the model has never seen.

**Known-good fallback:** raise steps above 12 so `useTurbo` goes false. Commits at
sigma 0.387. Costs the entire point of the 4-step path — 5× wall clock.

## Things found along the way that nobody asked about

- **The turbo LoRA may be partly inert.** `workflow.js:1352` uses stock
  `LoraLoaderModelOnly` — a *merge* — against an int8 checkpoint. On a quantized
  base a low-rank delta can be rounded away by requantization. Cheap A/B: render
  4 steps at loraStrength 1.0 vs 0.0. If they look alike, the LoRA is barely doing
  anything and the whole shift analysis is treating a symptom.
- **The LoRA's metadata names a different checkpoint** than it is applied to
  (`fl2va_bf16` in the header, `ref2va int8` in config). It patches `attn.qkv_proj`
  and `attn.out_proj` on all 50 blocks — and in this architecture that
  self-attention *is* the reference path — so a mismatch degrades precisely the
  layers that read references.
- **The shipping config is not what renders.** `config.video.engines.h3` resolves
  to 20 steps at 1344×768, where `useTurbo` is false and no LoRA loads. But 97 of
  100 real clips ran at 4 or 8 steps and 61 at 1920×1088. The longest justification
  comment in `config.js` describes a configuration used 3 times out of 100.
  *(Since 2026-09-23 it resolves to the matched turbo setting the disk has: 8
  where both 8-step builds are on disk, else 4, since the Models screen fetches
  only the 4-step ones. The Video screen opens on the same number, and 20 on
  the bare model is the Best chip. Arm H below is why the default left 20.)*
- **The reference path has never been verified at the settings in use.** Checked
  once, by eye, in `0df69e6`: one reference, 864×480, 8 steps. Meanwhile 53 of 100
  clips used two or three references at 1920×1088 and 4 steps.
- **`ref_image_size` is hardcoded to `"match"`** and was never a measured choice.
  The node's own tooltip says `"max"` gives "best identity fidelity" — and under
  `max` a reference gets a finer RoPE grid so its tokens stop sitting on target
  patch centres, which is what an exact-copy head needs. Worth exposing as a knob,
  not flipping blindly: it pushes far more tokens through 50 blocks of quadratic
  attention every step.
- **A missing `ref2va int8` degrades silently.** `config.js:433` falls back to the
  fl2va weights, so a machine without it runs reference conditioning on a
  checkpoint not built for it and says nothing. Should be a hard error.

## 2026-09-12 — the promo post-mortem: what the fast path was actually running

The owner's verdict on the "AI PLAY Studio · On Your Own Machine" cut: *blurry,
drifting edges, wrong colours*. Traced before touching the card. Five things
the clips were rendered with, none of them chosen, ranked by how much of the
complaint each one can carry:

1. **The wrong sigma shift for the LoRA that loaded.** Every turbo render here
   ran shift 12/3 — the *base* model's default — because the graph had one
   shift for every turbo path. The fl2v 4-step v1.0 768p distillation was
   trained at **6/3** (ModelTC README; the diffusers recipe's `--video-shift 6`;
   its own dmd config, `video_flow_shift 6.0`). The 8-step fl2v v1.0 and the
   ref2v 4-step v0.1 are 12/3 in the same sources. The ref2v 8-step v1.0 768p
   is the one the sources disagree on (lightx2v #51: 12; comfyui-wiki 09-04: 6).
   *Fixed:* `config.video.engines.h3.turboShiftByLora`, read by
   `h3SigmaShiftFor()` in workflow.js — panel value, else the LoRA's row, else
   the base — and the Video panel's commit-sigma asks the same function.
2. **The reference path ran a 4-step LoRA at 8 steps.** `refTurboLora` had one
   ref2v turbo to pick from, the 4-step v0.1, and the reference path defaults
   to 8 steps. The mistake `turboLora4` was created to stop, made on the other
   path. *Fixed:* the ref2v **8-step v1.0 768p** LoRA (lightx2v, 1.96 GB) is on
   disk and first in the pick; v0.1 stays first for ≤ 5 steps.
3. **SaveVideo at `codec: "auto"` is libx264 CRF 23.** Measured on the promo
   clips: **1.0 Mbit/s** for a 1344×768 frame — a DVD-class bitrate — and the
   cut re-encodes that file at 6 Mbit/s, so the softness is baked in before
   the timeline sees it. This alone is a large part of "blurry". *Fixed:*
   `config.video.saveCrf: 14`, sent in the dotted form the node's DynamicCombo
   reads (`codec.encoding`, `codec.encoding.crf`); 0 restores the old node.
4. **The colour was never wrong in the render — it was wrong in the file.**
   PyAV writes every ComfyUI clip **BT.601-matrix, limited-range, untagged**
   (probed with the rig's own interpreter: pure red encodes 81/90/240). A
   player assumes 709 for an HD frame and shows that as orange-ish red and
   dimmer green. The 1.098×−11 luma remap measured cut-vs-clip was not a range
   error either: it is `contrast=1.09` in the grade, by arithmetic. *Fixed in
   the cut:* `timeline_render.py` converts 601 → 709 in the scale it already
   runs and stamps the frames, so the delivered file is tagged and decodes as
   rendered (scripts/timeline_render_test.py encodes a red frame the way PyAV
   does and reads the cut back). *Not fixed:* the library's raw clips are still
   untagged; the Studio's own preview shows the 601-as-709 shift. Tagging them
   losslessly (h264_metadata) at filing time is possible but changes the bytes
   the ledger digested, so it waits for a decision.
5. **The whole song was frozen into the AV latent under references that never
   sing.** `server/mv/generate.js` sent `audioTrack` for every clip; the graph
   freezes it and anchors it on the conditioning at frame 0 (on BOTH engines —
   the comment claiming H3 ignores it was wrong), and every cond_audio row is
   attended on every step of every block. Unmeasured cost. *Changed:* on H3's
   reference path the song travels only where the board sings (`lipSync`) or
   the brief says `songConditioning: "always"`; LTX and the fl2v path are as
   before.

**Not touched, and why:** the grade (contrast 1.09, saturation 1.15) is an
authorial choice that reads as "wrong colours" only when stacked on item 4;
the prompt's *grain / shallow depth of field / crushed blacks / tungsten*
asks for softness and warmth by name; `ref_image_size: match` (see below).
Those are A/B arms, not code.

**The A/B, run 2026-09-12 04:12–07:37 on the promo's shot s1_1** — the same
reference, recorded prompt and seed as the delivered clip; every arm built by
`videoGraphH3` itself and posted to ComfyUI; 1344×768, 260 frames. *Detail* is
the Laplacian variance at half size, so grain and encode noise do not count
as sharpness; *churn* is the mean |Δ| between sampled frames (the "drifting
edges" proxy); two seeds for the arms that decide defaults, and the
seed-to-seed spread was up to 93 detail, 1.6 churn, 8 saturation — nothing
under that is called a finding.

| arm | detail | churn | mean RGB | what it says |
|---|---|---|---|---|
| delivered: 4-step v0.1, song in, CRF 23 | 368 | 5.30 | 32/28/27 | warm cast, grainy, 1.4 Mbit/s |
| G = the same at CRF 14 | 381 | 5.40 | 32/28/27 | the identical render — the encode alone was only bitrate |
| F = old LoRA, song off | 369 | 4.53 | 35/30/28 | the cast stays; churn −15 % |
| A = 8-step v1.0, shift 12, song off (the new default) | 189 / 148 | 2.62 / 3.87 | neutral | cast gone, churn halved, smoother rather than crisper |
| B = A at shift 6 | 161 / 69 | 2.05 / 2.29 | dark | seed 2 very dark, reference layout lost — **rejected** |
| C = A + the prompt without its softness words | 324 / 251 | 2.35 / 3.96 | neutral, brighter | +70 % detail on both seeds, clean legible UI — **the lever** |
| D = A + song in | 199 | 3.16 | neutral | no visible gain, a little more churn |
| H = bare model, 20 steps, C's prompt | 346 | 3.92 | neutral | ≈ C, at 2.4× the time (45 min vs 19) |

**Verdict.** The new defaults stand: the ref2v 8-step v1.0 LoRA at its
model-default shift 12 (the conflicting sources are settled for this build —
6 is rejected, not pending), CRF 14, the song off the reference path unless
the board sings. The biggest single gain is not a setting: the promo's style
bible asks for *film grain, shallow focus, crushed blacks, tungsten* by name
and the model delivers them. Twenty steps of the bare model buys nothing
visible over the 8-step turbo on this shot. So "blurry, drifting edges, wrong
colours" was four things stacked: the 1.4 Mbit/s encode, the 4-step v0.1
path's warm cast and 2× churn, the prompt's own softness, and the untagged
BT.601 colour in the file. Contact sheets and crops: the session's
scratchpad, `ab_h3_sheet.jpg` and `ab_h3_zoom_*.png`.

Superseded for new music-video projects on 2026-09-24: the REWIND A/B put the song
under every reference shot (DIRECTING.md §2), and new projects start on Song under
the clip: always. The sampler on the reference path is res_multistep again. (The
detail column above is not seconds: arm D's 199 against arm A's 189 is no measure of
what the song costs to render, which has never been measured on its own.)

## The three repos

Read-only evaluation, nothing installed.

| repo | verdict | why |
|---|---|---|
| `xmarre/ComfyUI-Spectrum-MiniMax-H3` | **read, don't install** | Genuinely good engineering aimed at a problem we do not have — never touches reference conditioning. Its own README warns that stacking it on a distilled few-step path costs composition and fine detail, and at 4 steps it can skip at most one of four evaluations. |
| `Larryvrh/ComfyUI-MiniMax-H3-Turbo` | **read, don't install** | Silent on bleed, and its sampler half is dead weight on ComfyUI 0.33.0 (`ModelSamplingAV` is native, so it degrades to plain Euler). Binds to private tensor attributes; two open "broken after update" issues, one failing *silently* with the LoRA simply not applied. But read it for the activation-space LoRA insight above — that one is free and applies directly. |
| `LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler` | **skip; read one file** | Hard blocker: **no licence at all**, and its loader calls `torch.load(weights_only=False)` on a `.pth`. But its Split Upscale is the only real answer here to small distant faces, and its issue #41 reports the neural upscalers *crashing* on reference-conditioned graphs exactly like ours. |
| `xmarre/ComfyUI-Untwisting-RoPE` | **evaluate next** | Not in the original list and worth flagging: same author, MIT, and the only thing found that targets our actual axis — frequency-aware RoPE reference-attention control, tuning reference influence from style transfer to structural copying. 6 stars, last push 2026-08-19, so thin and unproven. Needs the same read-the-source treatment. |
