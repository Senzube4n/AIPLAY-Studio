# Engine traps

Things that silently do the wrong thing.

Every entry here cost real time on this project, and every one shares a shape:
the engine accepted the input, returned a plausible result, and the result was
not what was asked for. None of them raise an error. Most of them are invisible
unless you measure the output against the request.

The settings themselves live in `server/config.js` with their measurements. This
file is the list of *mistakes*, kept separately because a config comment is not
somewhere anyone reads before making the same mistake.

---

## Silent size flooring — both engines, different directions

**H3 floors both axes to a multiple of 16.** `MiniMaxH3ReferenceToVideo` builds
its latent as `height//16` and decodes at `latent*16`. We requested 1664×936, our
own size function reported `quantised: false, grid: 1`, and the engine delivered
**1664×928**. Fixed in `server/workflow.js` — the H3 branch now quantises to grid
16 — but the bug is worth knowing about because *nothing* reports it. The clip
just comes back 8 px shorter than you asked.

**LTX floors to 64, because the graph halves your numbers.** The sizes you pass
are *final* sizes; the graph renders at half and upscales ×2 in latent space, and
each axis is floored to the 32 px latent grid *at half size*. So the real output
is `floor(n/64)*64`. We shipped a size entry promising 544 that produced 512 —
directly beneath a comment warning that both axes must survive the flooring.

Both live in `videoSizeFor()` now, which exists so the answer is in one place.
That function's own comment says keeping two answers in two places "is the entire
way that 544 survived", and then its H3 branch modelled nothing. Read it before
adding a size.

## `video_cfg` must equal `audio_cfg` on LTX

`nodes_lt.py` only takes the cheap single-CFG path when the two values are close.
Let them differ and **every one of the 11 steps costs two forward passes instead
of one.** Nothing warns you; the render is simply twice as slow. Both are 1.0 in
our config, and they should stay equal unless you have measured a reason.

## The vendor's LTX template names a VAE file that does not exist

The template widget says `ltx-2.5-video-vae-bf16`. The ComfyUI build of the repo
ships `ltx-2.5-video-vae-`**conv**`-bf16`. Copy the template verbatim and it fails
with "value not in list" — which at least is a real error, unlike everything else
on this page.

## Never `--novram`

It moves the execution device to CPU. The music engine's AR stage requires CUDA
and dies with `ValueError: Expected a cuda device, but got: cpu` — measured
2026-08-18, the tier produced **zero audio in 6 seconds**. The shipped config had
offered it as the 6 GB option, so anyone on a small card hit a hard failure with
no explanation.

Streaming harder while staying on the GPU is the only lever available. See
`config.vramTiers`.

⚠ Those tiers were measured on a 16 GB card using `--reserve-vram` as a proxy for
smaller ones. Nothing OOM'd even at a 6 GB-equivalent budget, but peak still
reported ~13 GB, so the 8 GB and 6 GB tiers are **unproven on real hardware**.
Do not quote a minimum-VRAM number from them.

## Summing checkpoint sizes against VRAM predicts nothing

The H3 set is ~41 GB on disk (20.97 GB DiT int8 + 14.17 GB text encoder +
5.21 GB video VAE + 0.61 GB audio VAE) and it renders on a 16 GB card, because
`--lowvram` streams module by module — the four never co-reside in the way the
sum implies. Our 12 GB tier is verified **bit-identical** to the fast path.

If you are diagnosing slowness, the sum is not the evidence. Wall clock per step
is.

## Reference images cost more at higher resolutions than you measured

`ref_image_size` is hardcoded to `"match"`, so every reference is scaled to the
*generation's* pixel area and attended on every step of every block. Rendering at
1792×1008 makes each reference **1.75×** larger in tokens than at native. Any
benchmark run with one reference under-quotes a real music video, which will use
two or three.

## More pixels can mean a smaller face

The single most counter-intuitive result we have. 1536×864 cost 36% more than
native and produced the **smallest face on the ladder** — not a resolution effect,
but because the model chose to frame the subject further away (5.73% of frame
height against native's 7.55%).

Resolution is not a framing instruction. If a face needs to be bigger, say so in
the prompt; the render size only decides how much detail that face gets once the
model has placed it. Full sweep: [`RESOLUTION_FOR_FACES.md`](RESOLUTION_FOR_FACES.md).

## The turbo LoRA has three ways to be wrong

1. **Not loaded at all.** `config.video` named the file from the first commit and
   no node ever loaded it, so every clip ran the base model. That one missing node
   was most of what people were reporting as bad quality.
2. **The wrong build for your step count.** The LoRA is an 8-step distillation.
   We ran the *4-step 768p* build at 8 steps for months, off its design point.
   `pick` now prefers the matching build and falls back.
3. **Loaded at 20 steps, where it over-shoots.** Crunchy sparkling texture and
   2–3× the inter-frame churn (1.35/0.95 against 0.67/0.30 for the bare model).
   The vendor's own flows never load it above distillation range. Ours applies it
   only below `turboMaxSteps` (12).

Also: use the **full-rank** LoRA, not the 440 MB resized-rank one. It saves 1.5 GB
and has two independent reports of camera-movement degradation and I2V
prompt-following failure.

## Quantisations we do not test are not fallbacks you should reach for

`int8_convrot` is the measured path on both engines and is native on Ada. The
int4 and w4a8 H3 builds are listed as `alt` in `server/models.js` because someone
may only have those — not because they are equivalent. LTX's `nvfp4` is 2.8 GB
smaller but **Blackwell only**: below compute 10 it is emulated and slower. And
the LTX "dev" checkpoint is *not* distilled — it wants 20–30 steps and exists for
training LoRAs, not for generating.

## H3 lengthens your clip without saying so

`align_frame_count` rounds **up** to `n mod 17 == 5`. Ask for an unaligned length
and you get a longer clip than you requested, silently. Our `frameRule` encodes
this as `mod17plus5`; LTX's is `fpsPlus1`.

Related: the trained range is ~124–362 frames, per the node's own tooltip. Below
124 you are outside it, and combined with a sub-native size that is what the
"vague, jittery, morphing" reports actually were — 864×480 × 56f measured 49.1
detail against 1344×768 × 124f at 131.2. **Neither change helps alone.** Native
size at an untrained length scored 48.3; a trained length at 40% of native pixels
scored 41.4. Both, or neither is worth doing.

## Above-native sizes are untrained, not unsupported — and there is no upscaler

H3 samples at whatever size it is given, so everything on our ladder runs. But
`nodes_minimax_h3.py` sets `MAX_PIXELS = 768 × 1344`, exactly native, and there
is **no H3 upscaler node in ComfyUI 0.33.0** — five H3 nodes, none of them an
upscaler. So 1792×1008 and above is territory the model has not seen, offered
because it measurably helps faces and labelled so the price is visible.

LTX is different here: 4K genuinely holds. At 3840×2112 the same seed resolves
individual railing balusters where 1280×704 has only a suggestion of a railing —
no repetition, no smearing, far outside the training size. An upscaler cannot
recover that; it invents something plausible instead.

## A cost model fitted in the smooth regime will extrapolate through a cliff

Ours does. `config.h3` carries `costExponent: 1.2`, fitted to four renders whose
largest is **149,184 latent tokens** (1344×768 × 124f). An external replication
across 158 renders found cost smooth to roughly **331k tokens** and then not:
**30% more frames cost 2.6×**, with hard OOMs
(`comfy_kitchen int8_linear`, 8.86 GiB allocated + 8.91 GiB requested) and a
117-minute render where the curve predicted well under an hour.

Latent tokens are `video_latent_t(frames) × (h/16) × (w/16)` per
`nodes_minimax_h3.py`, and `video_latent_t` is `((f-5)//17)*5+2` — so the
temporal term is a fifth of the frame count, which is exactly why a length that
looks modest can put you past the cliff while the *area* still looks safe.
1792×1008 × 209f and 1344×768 × 362f are 437k and 431k tokens: different sizes,
same wall, both about **2.2× beyond anything measured here.**

Two lessons, and the second is the general one:

- **Treat ~331k tokens as a ceiling to test against, not a number to
  extrapolate past.** Our own published length advice was withdrawn for exactly
  this — see [`RESOLUTION_FOR_FACES.md`](RESOLUTION_FOR_FACES.md).
- **A fitted curve cannot warn you about a regime it never sampled.** The 1.2
  exponent was already known to under-quote by −19% at the top of its own fitted
  range; that was read as a known margin of error rather than as the leading edge
  of something worse. An extrapolation is a hypothesis, and it should be labelled
  as one wherever it is quoted.

### It is an allocator cliff, not a compute one

Established by the replication rather than by us, and it changes what the number
means. Two independent reasons:

- **Slow arithmetic never throws `OutOfMemoryError`.** A compute wall degrades;
  it does not fail an allocation. And the third attempt completed *unchanged* at
  117 minutes, which a compute wall would not do either.
- **The failing tensor is an `int8_linear` output, which grows linearly in
  tokens** — not quadratically like attention. So the thing that runs out of room
  is not the thing that would explain a 2.6× compute jump.

Below the cliff, native wall clock fits **exponent 1.69 on tokens** (124f at
11.8 min, 277f at 45.4 min). Extending that to 362f predicts **71 min**; the
measured render took **117**. So roughly **1.6× of the jump is thrash on top of
the arithmetic**, which is the signature of an allocator falling back to host
memory rather than of the maths getting harder.

**The cliff is bracketed, not located.** 277f is **330,624** tokens and completed
in 45.4 min; 362f is **431,424** and took 117 with two OOMs. Everything between is
unmeasured — a 1.30× window — so "~331k" is the last known-good point, not the
edge. Do not treat it as a threshold with a known position.

### The test that would settle it, and why it is four runs and not two

`--async-offload` is the only difference between the Auto tier
(`--lowvram --async-offload 4`) and the 8 GB tier (`--lowvram --async-offload 2`),
so the stream count can be varied with no code change. `--reserve-vram` appears
only in the 6 GB tier, bundled with `--async-offload 1`, so that tier is not a
clean test of either.

⚠ **A below-cliff control is required, and our own config note cannot supply it.**
`config.vramTiers` labels the 8 GB tier "roughly 2× slower" — but that came from
the 8 GB *simulation*, which changed the VRAM budget and the stream count
together. It does not isolate the flag. So "moving the cliff without costing
anything below it" is the untested half of the hypothesis, and testing it needs:

| run | tokens | purpose |
|---|---|---|
| native × 124f, `--async-offload 4` | 149,184 | below-cliff control |
| native × 124f, `--async-offload 2` | 149,184 | does the flag cost anything down here? |
| native × 362f, `--async-offload 4` | 431,424 | reproduce the cliff |
| native × 362f, `--async-offload 2` | 431,424 | does the flag move it? |

Four runs, one seed. **Not run** — the 362f pair alone is about four hours. Filed
rather than done, so that anyone who has the GPU time knows exactly which four
renders answer both questions.

Credit: the OOM measurements, the 1.69 fit, the allocator diagnosis and the
control-run correction are all Nemyra's, from 158 logged renders on an install
verified to match this one flag for flag.

## Metrics that lie

**Variance-of-Laplacian must not be used to rank render sizes.** It swung 45%
(520.5 vs 754.7) between two seeds at *identical* size and composition, and it
structurally penalises bigger faces — a 50 px face is aliased and an 84 px one
renders skin smoothly. That is backwards for "which size gives me a better face".
It also cannot tell texture from mush: a broken smeared-face render scored 70.2
against a good one at 88.8, close enough to look like a near-miss when the frames
were unusable.

**Measure a noise floor before believing a sweep.** We shipped `shift_video 4.0`
on a result that was 4-for-4 on two metrics across four seeds. Re-running it with
two seeds at a single shift showed every between-shift spread was *smaller than
the seed-to-seed spread* — the finding was noise, and the experiment had no way to
know. Any sweep without a repeated cell is not evidence yet.

**Vary the seed when A/B-ing performance flags,** or ComfyUI's cache returns
instantly and fakes a win.

## An OpenCV upgrade breaks the scoring scripts

OpenCV 5.0.0 **removed `cv2.CascadeClassifier`** and leaves
`cv2.data.haarcascades` pointing at a directory containing only `__init__.py`.
Our face-detection scoring runs in an isolated OpenCV 4.12 venv. Anyone
re-running `scripts/ressweep_score.py` will hit this.

## Reading the code is not measuring the behaviour

The most expensive mistake here, and the one most likely to be repeated.

We concluded LTX could drive a mouth from a vocal, from unambiguous code:
`comfy/ldm/lightricks/av_model.py` defines `audio_to_video_attn` in every block,
`run_a2v` defaults to `True`, and ComfyUI ships `LTXVModalityGuidance` whose own
tooltip reads "strengthening audio-visual sync (e.g. lip-sync)". A vendor does not
write a node to amplify a capability the model lacks.

Then we measured it: 19 clips with a real vocal pinned in as an audio latent under
a zero noise mask. Correlation between mouth-region motion and the audio envelope
was **+0.034 mean, +0.073 median, n = 18**. Working lip-sync would be 0.3–0.6.

Framing was verified from the contact sheet rather than assumed, and per-clip
mouth motion runs 4–14, so mouths *are* moving — just not with this audio. The
code reading was right about the mechanism and wrong about the outcome.

**LTX lip-sync is unproven, not disproven — but it does not work as we wired it,
and nothing should be planned on it.** The next measurement is to add
`LTXVModalityGuidance` at modality_scale 3.0 and re-run exactly that correlation.

## Lock identity, not just framing

Separate from any model behaviour, and a production problem rather than an engine
one: across a 19-clip run with framing locked and identity unlocked, the performer
is visibly a different man in several shots. LTX takes a `firstFrame`, so the fix
is to generate one portrait and seed every clip from it.

---

## Licences are a trap of their own

- **MiniMax H3 Community Licence** grants rights only inside its *Applicable
  Territory*, and **the excluded territories are deliberately not restated
  here** — see the entry below. The authoritative list is `region.excluded` on
  the H3 rows of `server/models.js`; the Models page, the welcome window and the
  generated tables all derive from it. §V.4 extends the same restriction to
  anything the model generates. §IV.2 requires displaying "MiniMax H3"
  prominently in a commercial product; §IV.1 needs written authorisation above
  USD 20 M/yr. Studio does not host the weights: the download goes straight to
  the publisher and the licence is between you and MiniMax.
- **LTX-2.x Community Licence** has no territory clause, but requires a paid
  agreement at **USD 10 M annual revenue or more**, and Attachment A §20 forbids
  use in a product competing with Lightricks' own offerings. §6/§19 forbid
  removing watermarking or provenance features. The HF repo is access-gated.

These are different *shapes* of restriction, which is why they cannot share a
catalogue entry — reusing H3's would region-block LTX for no reason. See the
`region` axis in `server/models.js`.

## A doc that restates a legally significant list will drift from it

This page tried to, and the build stopped it — which is the entry.

On 2026-09-02 four separate files named H3's excluded territories as **three**
while the catalogue said **four**: a comparison arm, two engine-switch
descriptions and a video-lab tool, each written by a different hand on the same
day. Nobody was careless; the list was simply copied at different times.

`server/territory_test.js` now fails the build when any file outside
`server/models.js` hand-types it — either matching a known phrasing or naming
three or more of the territories on one line. Comment lines are exempt, as are
lines flagged as history notes, and so are the generated `MODELS:BEGIN … END`
blocks, because derived output is the opposite of hand-typing.

The first draft of *this file* tripped it, on the licence section above. The list
it typed was correct on the day it was written, which is exactly the failure
mode: a restated list is right until the source changes, and then it is wrong
somewhere nobody is looking. **Derive it, or point at where it lives.**

Worth generalising past territories: any list a build could compute is a list a
document should not retype. The cost of pointing at the source is one
indirection; the cost of restating it is a legal claim that silently goes stale.

---

Everything from here down was met on the second music engine — YuE2, which
plans a score before it sings — and on the ABC that score is written in. Same
shape as everything above: the input was accepted, the output was plausible,
and it was not what was asked for.

## One flag that is secretly two, with a cliff in the middle

YuE2's `--budget` looks like a hint. It is two unrelated decisions wearing one number.

`cli.py:36` sets `vae_core_frames = 512 if budget <= 12 else 1024`, so it picks the
VAE tile size — a **cliff at 12**, not a gradient. And `pipeline.py:162` turns the
same number into `set_per_process_memory_fraction(min((budget-2)*GiB, total-2*GiB))`,
so it is also a hard allocator cap.

Pass `--budget 12` to get tiled VAE decode and you have simultaneously capped
PyTorch at **10.00 GiB**. The render then dies at `nar.py:95` trying to allocate
3.86 GiB with **7.04 GiB still free** — the card was never the limit. Pass 13 to
raise the cap and you silently lose the tiling you wanted.

The CLI cannot express "high cap, small tiles". The Python API can: pass
`memory_budget_gib` and `vae_core_frames` separately. That is the only way to get
both, and it is why our adapter drives the pipeline directly instead of the CLI.

## A memory ceiling you cannot raise by asking — and it is per-runtime

`pipeline.py:162` is `min((budget - 2) * GiB, total - 2 * GiB)`. The second term
reserves **2 GiB unconditionally**. On a 16 GiB card that makes **13.99 GiB** the
most **this pipeline** will ever be given, no matter what budget you pass — its
own OOM text says "13.99 GiB allowed" in those words. There is no headroom to
find by tuning, so when a render OOMs at 13.99 the answer is a different lever,
not a bigger number.

⚠ **THAT FIGURE IS NOT A PROPERTY OF THE CARD**, and reading it as one is the
trap below in miniature. Each runtime computes its own cap from its own
reservation policy. Measured on the same 16 GiB card, the same morning:

| | GiB |
|---|---|
| advertised by the card | 15.992 |
| ComfyUI `torch_vram_total` | 13.594 |
| YuE2 computed cap | 13.992 |

Two runtimes, 0.4 GiB apart, and neither is 16. **Ask the runtime you are about
to allocate in what it thinks its total is** — the card's advertised size is not
it, and the other runtime's answer is not it either.

## A first-pass render can OOM where a score-supplied one fits

MEASURED, same rig, same night. A render from a supplied score peaked ~10.6 GiB and
finished. A first-pass render of a different song — no score, so the model planned
its own and chose its own length — died with 12.69 GiB allocated, 1.10 GiB
reserved-but-unallocated and 256.94 MiB free.

Length is not a parameter in YuE2: it emerges from the lyrics and the score, and the
NAR prefill scales with it. So "it fits on this card" is a statement about a
particular song, not about the card. `offload_ar=True` (`nar.py:251` wraps
synthesize in `_offload_ar`) moves the AR weights off-GPU for exactly the stage that
runs out of room, and is the lever to reach for first.

## Three VRAM levers the model card denies exist

The YuE2 card says "24GB GPU … without quantization". The shipped CLI has
`--quantization fp8` (`pipeline.py:219-221`, AR only), `--offload-ar`
(`:302`), and tiled VAE decode (`:340`/`:348`). All three reduce footprint and none
is documented.

This is the third time on this project that a vendor's stated requirement has been
contradicted by the vendor's own code or its own measured table — after H3's 24 GB
against a measured 11.18 GiB peak, and the withdrawn clip-length band. Read the
source before believing the spec, and read the measured column before believing the
prose next to it.

## A capability probe that returns true for a kernel that is not there

⚠ The nastiest one, because it turns a working fast path into a crash with no
fallback and no explanation.

`cuda_graph.py:75-76` probes for FlashAttention by asking whether the ATen operator
exists. Its **schema** is registered from `torch_cpu.dll` independently of build
flags, so the probe returns **true** — while the kernel is absent from
`torch_cuda.dll`, which instead carries the literal string
`"USE_FLASH_ATTENTION was not enabled for build"`. `USE_FLASH_ATTENTION` is hard-gated
off under MSVC in PyTorch's own CMakeLists, so every official Windows wheel is in
this state.

`--backend torch` is the CLI **default**. So on Windows the default backend resolves
`auto` → `flash`, the guard at `:82-83` is dead code, `_capture()` raises, and
`sampling.py:89` has a `finally` with **no `except`** — so there is no fallback. The
only thing that runs is `--backend torch-eager`, which disables CUDA graphs and puts
~2352 dispatches per token on the critical path.

Two lessons beyond the workaround. **An existence check is not a capability check**
when the declaration and the implementation live in different binaries. And
`timing['graph_fallback_reason']` at `sampling.py:142-149` would have said all of
this in one line — it is written on every run, and nothing on this machine had ever
read it. Read the instrumentation you already have before instrumenting anything.

## A guard that turns "wrong object" into "no output, exit 0"

`save_artifacts` is a method on the **result**, not on the pipeline
(`pipeline.py:103`; `cli.py:132` calls `result.save_artifacts(directory)`).

Calling `pipe.save_artifacts(...)` behind a `hasattr(pipe, "save_artifacts")` guard
therefore writes nothing, reports nothing, and **exits 0**. It discarded a
successful 35-minute render. The generation had already finished; the audio existed
in memory; the process ended cleanly having thrown it away.

A defensive guard that converts a programming error into a silent no-op is worse
than the crash it was avoiding. Any step that produces a file must treat "succeeded
but wrote nothing" as a hard failure.

## A stop that is not a tree-kill leaves the GPU working

Stopping a render's wrapper does not stop the Python child holding the card. Ours
kept rendering after its task was stopped, and then **shared the GPU with the next
run** — contaminating every measurement taken during it:

| stage | with the zombie | clean |
|---|---|---|
| semantic | 930.3 s | **281.0 s** |
| NAR | 1146.2 s | **106.3 s** |

A 3.3× and a 10.8× error. And it presented as a *slow* render, not a stuck one, so
the natural conclusion was "this model is 31× slower than a 4090" from numbers that
were really "two processes, one card". `server/mesh/runner.js`'s
`killMeshProcessTree()` with `taskkill /PID /T /F` exists for this. Use it, and
verify the card actually came back before trusting the next number.

## `yue2.cli doctor` proves nothing, and is not free

It reads the five key dependency versions with `importlib.metadata.version()` and
**never imports them**, and `dependencies_ready = all(versions.values())`
(`cli.py:75`) is true for **any** version, ignoring every `==` pin. A venv holding
the wrong `transformers` prints `dependencies_ready: true` and exits 0.

It is also not free: `cli.py:71-74` calls `torch.cuda.device_count()` then
`get_device_properties(i)`, which initialises CUDA and creates a context. So it is
simultaneously not a proof and not free. The real check is
`python -c "import yue2; from yue2.pipeline import YuE2Pipeline"`, which pulls
`transformers` for real and touches no GPU.

## `pip install yue2_infer` does not resolve

It is not on PyPI (404, verified twice). Install from the GitHub clone
(`pip install ./YuE`) or from the wheel published beside the weights on Hugging
Face. Worth knowing because `docs_test.js` requires INSTALL.md to quote a
catalogue `packageInstall` string verbatim — a plausible-looking pip line would be
enshrined in the docs by a gate designed to prevent exactly that.

## Sheet music: four ways to render nothing

All four MEASURED while wiring ABC to a PDF.

**abcjs is UMD, not ESM.** The bundle is rooted at the global, so it must load via a
classic `<script src>` before any script that uses it, read as `window.ABCJS`. An
`import` of it throws `TypeError: Cannot set properties of undefined`, and a printed
page that did so produced a one-page PDF with the engraving simply absent.

**abcjs draws with `currentColor`.** On a themed page whose text colour is a
dark-theme near-white, it engraves near-white notes onto white paper. The staves are
there; nothing is visible. It reads as a render failure and is a contrast bug — pin
`color:#000` on the paper element.

**Headless Edge prints from `http://` but not from `file://`.** Tested both: the
file URL produced no PDF at all. The app's own UI server is the http origin to print
from, which also means no extra server process.

**`--virtual-time-budget=0` hangs forever.** It is not "no limit"; it needed a
taskkill. Pass a real number.

## This ABC dialect resolves accidentals differently from standard ABC

`abc_tools.py:92` carries the comment "Native exporters propagate accidentals by
letter, across octaves", and `:132` implements it: `local[letter]` is keyed by
letter alone. So an accidental on `c` also applies to `c'` and `C` for the rest of
the bar.

Standard ABC — which general renderers implement — propagates by letter **and
octave**. On any bar where an accidental applies to a note that also appears in
another octave, a general renderer draws a different pitch than the model intended,
and it draws it beautifully. The vendor warns in writing against substituting a
parser with different accidental semantics.

The fix is to normalise before rendering: parse with the vendor's own tools, resolve
every pitch, and re-emit with an explicit accidental on every note, so any renderer
agrees. And check whether it matters for the score in front of you before assuming
it does — our first real score had **zero accidental marks in 179 bars**, so the
hazard was entirely latent there.

## The OOM predictor is the DURATION, and two plausible answers come first

Wrong twice, measured third, and both wrong answers looked well-supported at the
time — which is why the whole sequence is here rather than just the conclusion.

**First answer: short lyrics.** Five renders said so, and it inverted the queue
order to put "safe" long lyrics first. A 1275-character reggae then died.

**Second answer: plan size in ABC tokens.** Ten renders separated *perfectly* —
every success ≤1512 tokens, every failure ≥2237, nothing in between. So the gate
trimmed to 1550. Two songs trimmed to 1488 and 1502 then OOM'd anyway, and a
third at 1422 rendered.

**The answer: how long the song is.** Sixteen renders, duration summed from the
notation:

    RENDERED   98.2  108.4  142.7  147.2  164.0 x4  165.0
    OOM       176.3  180.6  204.8  228.8  252.8  258.9

No overlap, an 11-second gap. The mechanism is direct: the semantic stage emits
**exactly 25 tokens per second of audio** (4176/167.0, 2678/107.1, 2190/87.6,
3681/147.2 — four songs, no residual), and `nar.py` blocks attention over the
whole sequence, accumulating every block before it concatenates. So the peak
follows the length of the SONG, not the length of its description.

Token count was a proxy that worked until it didn't: two scores of equal token
count can ask for very different amounts of music. A bar of dub at 70 BPM lasts
two and a half times a bar of pop at 124 and costs the same to write down.

**Measuring the duration has its own two traps.** Counting bar lines assumes the
model puts `|` at the end of every measure, and it does not — one score counts
122 bar lines for 62 real bars, which made a 167 s song measure 325 s. Counting
every voice counts each bar once per voice, because `V: Vocal` and `V: Ins`
sound *together* — that made the same song measure 651 s. Sum the **first
voice's note lengths in units of `L`** and the answer lands within a mean 2.4%
of the rendered duration across nine songs. `server/score/abc.js` already does
this, including a content-derived bar length that disagrees with the header when
the model's notation does.

## A supplied score constrains the notes, NOT the length

The corollary, and it is the reason a duration gate alone is not enough.

MEASURED: a score notating **86.25 s** rendered **165.2 s** of audio — 1.9x. Two
other trimmed scores in the same batch were honoured to 2.5% and 0.4%, so this
is not the rule, but it happens, and it happens to *short* scores. Given little
to sing, the model generates toward a target length rather than toward an
ending. (That is the first wrong answer above, correct as a statement about
LENGTH and useless as a statement about memory.)

The independent check is `semantic_sampling={"max_tokens": N}`, which bounds
what the model may emit whatever the score asked for. The vendor default is
9000 — 360 s — and `sampling.py:78` sizes the cache as `len(prefix) + max_tokens`,
so the default also reserves room for a song nobody requested. Set from the
longest sequence that has actually rendered here: 4200, being 168 s.

It earned its place on the first run: the doubled render stopped at **4130
tokens with 70 left under the cap**. Without it the same job runs to the 9000
default and dies, which is what it had already done twice.

**Two gates, because they bound different things.** The trim reduces what the
score asks for; the cap bounds what the model emits. Either alone lets this
class through.

## A door that was never hung, with every test passing

Not a model trap — a repository one, and the most expensive kind because nothing
looks wrong.

`server/score/` shipped with 2451 lines across four modules and 1287 passing
assertions. `/api/score` answered the app's own 404 the entire time: nothing in
`server/index.js` dispatched to it. `server/mcp-music-score.js` shipped with 188
passing assertions and not one of its tools existed on the surface an agent
sees, because nothing spread `scoreTools` into `mcp.js`.

Both suites import the module they test and call its handler directly. That
proves the module **works** and says nothing about whether anything **calls** it.
It is the same shape as a guard that matches nothing and reports success — of
which this engine produced three — one level up: not an assertion that checks
nothing, but a subsystem that answers to nobody.

It was found by asking the running server for a score list. Running the tests
again would have said 1287 ok for as long as anyone cared to look.

`server/wiring_test.js` now reads the aggregators' source text and asserts every
`routes.js` factory is imported AND called, and every `mcp-*.js` tool set is
spread somewhere. Two notes on building that kind of census:

  - **Mutation-test it.** Removing the factory call while leaving the import
    must fail, because partial wiring is the interesting case. It does.
  - **Do not guess which file registers what.** The first version asked only
    about `mcp.js` and reported five false failures — the DAW's ear, master,
    rack, refprofile and voicelab surfaces compose inside `mcp-daw.js`, which is
    itself spread into `mcp.js`. A guard that fails on correct code gets
    switched off, and then it guards nothing.

## "The card you must own" is not "the memory that must be free"

One number cannot answer both, and using it for both closed this repository to
every commit.

`musicYue2.requires.vramMinGb` shipped as **12**, ESTIMATED as "the smallest
card above the measured peak". That is the wrong way to derive a minimum when
the runtime takes a fixed cut off the top first: `pipeline.py:162` reserves
2 GiB whatever budget it is handed, so a 12 GiB card leaves torch 10 GiB against
a measured 10.5-10.6 GiB peak. It does not fit. Corrected to 16.

The gate then refused every run. `server/music/yue.js` read that row as its
free-VRAM floor — on the sound principle that one floor in the repository beats
two that agree today — and a 16 GiB card never has 16 GiB free, because the
desktop is on it. MEASURED: refused at 14.0 GiB free, "waiting for 2.0 GiB more"
that would never arrive.

They are separate now: the row is the purchase (and includes the runtime's
reserve), the gate is the measured peak plus labelled headroom. The anti-drift
property survives as a **relation** the suite holds rather than as one shared
number — the card the row names must be able to clear the gate. Stated in the
terms of the failure, because a tidy equality is what caused it.

## A ceiling derivation must never round toward the ceiling

The budget that keeps a YuE2 render under the OOM cap is derived, not chosen:
cap divided by the worst measured overshoot of render length over notated
length. 168 / 1.166 = 144.08, and `round(…, 1)` gave **144.1**.

144.1 x 1.166 = **168.02**. The one property the constant exists to have — that a
song asked for at the budget cannot reach the cap — was false by two hundredths
of a second, in the line that computes it.

`math.floor(… * 10) / 10` gives 144.0, and 144.0 x 1.166 = 167.9. The file now
asserts the relation next to the constant, so the derivation is checked rather
than trusted:

    assert DURATION_BUDGET_S * WORST_OVERSHOOT <= CAP_SECONDS

⚠ The generalisation is not about floats. Rounding is a presentation choice
everywhere EXCEPT where the number is a bound, and there it is a correctness
choice with a direction: **toward the safe side, always, and the safe side is
whichever one the bound was written to protect.** A bound that rounds the wrong
way fails exactly at the edge it exists to guard, which is the one input nobody
tests.
