# server/control — structural control for video

Three modules that turn a **blocked camera move** or a **performance** into
something a diffusion model will actually follow.

This is the third answer to a question that had two wrong ones. LTX's sparse
appearance guides were tested against the same Blender blockout and are a
**decisive negative** — they write pixels into the denoising latent and the
camera does not follow. H3 has no structural input at all. WAN 2.1 VACE leaves
the latent as noise and pushes it with a scaled additive residual, and that is
the mechanism that works.

---

## What is proven, and what is not

**Proven, measured, on this rig.**
`D:\AI\aiplay-studio-bench\ComfyUI\output\vace\gate_report.json`, 2026-09-02..03.
Ten arms of WAN 2.1 VACE 1.3B against a flat-gray Blender playblast. Arm **W1** —
`control_video` wired, residual strength **1.00**, **no** `control_masks` —
passed all five criteria:

| number | W1 | bar | reads as |
|---|---|---|---|
| CMA (camera-motion agreement) | **0.924** | floor 0.50; its own **time-shift** null 0.402 | the blocked move is being carried |
| MR (motion ratio) | **0.82** | must be inside [0.4, 2.5] | it moves about as much as the blockout does |
| SSIM_block | **0.524** | bar 0.736; reconstruction anchor 0.982 | **generated, not reconstructed** — this is the one that matters |

The strength ladder, all rendered: **0.25 does nothing**, **0.50 passes**,
**1.00 passes** (shipped default), **2.00 reconstructs**.

**What 0.402 is, because this table used to call it something else.** The
`null` column in `gate_report.json`'s rows is not a strength-zero arm. It is
CMA recomputed with *that arm's own* estimated flow circularly shifted in time —
the max over 20 fixed-seed shifts of at least 12 frames
(`measured_null`, `scripts/gate_score.py:660` — **in the base repository at
`C:\temp\AIPLAYStudio`, not in this one**. The gate harness that produced every
number on this page stayed there; this tree has a `scripts/` of its own that
does not contain it, so the path resolves to nothing here and reads as a stale
citation when it is really a cross-repository one). Every arm has one: W0 0.041,
W1 0.402, W2 0.292. It answers *would this render's motion still match the
control if the timing were destroyed*, which is the null that catches motion
that is plausible but not in step. The gate's own verdict line reads
"CMA 0.924 (floor 0.50), W0 + margin, > its own NULL 0.402".

The arms that really do turn the control off are **W8**, residual strength
**0.00**, which scored CMA **-0.056**, and **W0**, no `control_video` wire at
all, which scored **-0.019**. Both are barred or failing by construction. The
distinction is not pedantry: "0.924 against a zero-strength null of 0.402"
reads as though switching the control off still buys 0.402 of agreement, when
switching it off really buys about nothing.

Verified again in this pass, on 2026-09-03: the graph `vaceGraph()` builds is
**field-for-field identical** to `_graphs/W1_s70117.json` except the seed and the
save prefix; it was **posted to the live engine and rendered to completion** in
31.99 minutes, and its output passes this directory's own control-clip gate —
see *The proof render* below.

**Not proven. Do not let a surface imply otherwise.**

- **A full-body dance.** The pose gate below passed, but its source is a man at
  a console with the camera pushing in — legs never appear, hips are detected on
  14 frames of 121. It measures an **upper-body performance under a scale ramp**.
- **The closest frames.** DWPose found no figure at all in **43 of the 121**
  output frames — every one a flat-shaded anime close-up with an obvious person
  in it. The instrument, not the render, is the limit; but it means the hardest
  part of the shot is **unscored**.
- **Hands.** `l_wrist` is 149.9 px at r 0.50/0.45, five times the overall error.
  The raised gloved fists in the render come from the **prompt**, not the
  skeleton — the control has no wrist on those frames.
- **Any strength but 1.00 on the pose path.** The camera gate ran a four-rung
  ladder. The pose gate is **one render, one seed, one source, one reference**.
- **Any size but 1280x704x121.** Nothing has been rendered off that point.
  `vaceSizeFor()` refuses everything else and says so.
- **The DWPose estimator's licence.** WAN's is now settled (see below); the
  estimator's is not, and that is the half that can bite legally.

---

## The contract

### The three numbers

A control clip must be **exactly 1280x704**, **exactly 24.000 fps**, and **at
least 121 frames**. All three fail *silently* — each produces a finished mp4
that is not the shot you asked for, after the render time is spent:

| wrong | what actually happens | where |
|---|---|---|
| size | bilinear resample + **centre crop**, no warning; your framing is gone | `nodes_wan.py:319` |
| frame count | `ImageFromBatch` **clamps** to what exists, then `WanVaceToVideo` **pads with flat mid-gray**, so the end of the shot conditions on nothing | `nodes_images.py:157`, `nodes_wan.py:321` |
| frame rate | nothing in this path reads fps — frames are counted and replayed at 24, so the move is silently retimed | (absence, by construction) |

`validateControlClip(path)` measures all three with `ffprobe` and refuses by
name and by number. It counts frames rather than trusting the container header,
and compares `r_frame_rate` **as a rational**, so 24000/1001 fails.

This app ships without ffmpeg by promise, so **no ffprobe is an answer, not a
crash**: `ok:false` with a `why` explaining how to make the measurement
possible. It never passes a clip it could not measure.

### The surface

```js
import {
  validateControlClip, judgeClip, CONTROL_SPEC,
  controlPoseGraph, controlPoseResolution, DWPOSE_MODELS,
  controlVaceGraph, vaceSizeFor,
  VACE_SIZE, VACE_PRESET, VACE_OPERATING_POINT, VACE_STRENGTH_LADDER,
  VACE_LICENCE, VACE_LICENCE_VERIFIED,
} from "../workflow.js";                       // or from "./control/*.js" directly
```

| function | takes | gives |
|---|---|---|
| `validateControlClip(path, {ffprobe})` | a real path | `{ok, width, height, fps, frames, why}` |
| `judgeClip({file,width,height,fps,frames})` | numbers you already have | `{ok, why}` — the pure half, no shelling out |
| `poseGraph({source, frames, width, height, detect, prefix})` | a **filename in the engine's input dir** | a ComfyUI graph, as JSON |
| `poseResolution(width, height)` | a source size | `{ok, resolution, why}` |
| `vaceGraph({control, reference, prompt, negative, seed, strength, masks, size, frames, prefix})` | filenames + text + a seed | a ComfyUI graph, as JSON |
| `vaceSizeFor(width, height, frames)` | a size | `{ok, ..., why}` — v1 answers for one size |

**`control`, `source` and `reference` are FILENAMES, not paths.** `LoadVideo.file`
and `LoadImage.image` are COMBOs over the engine's own input directory; a path
does not resolve. Stage the file there and pass its basename. **Nothing in this
directory stages files, posts anything or touches a disk** except
`validateControlClip`, which shells out to ffprobe because measuring is what it
is for. `server/mv/control.js` does the staging, the dispatching and the
recording — see *The wiring* below.

**A graph builder is data.** Every builder here returns plain JSON and executes
nothing. Two settings inside them are pinned rather than defaulted, and neither
is a preference:

- `bbox_detector` must be `yolox_l.torchscript.pt`. The node's own default is
  the **ONNX** file, which pulls in `onnxruntime` — and the `onnxruntime` in
  this venv is the CPU build the DAW's basic-pitch depends on. The wrong default
  here breaks note transcription in a different half of the app.
- `resolution` must equal the source's **short side** (704). The node's default
  is 512, which turns 1280x704 into 931x512 — an odd width, which libx264
  refuses, so the whole extraction runs and the *encode* dies at the end.

- `masks: "ones"` means `control_masks` is **absent**, because absent *is* ones
  (`nodes_wan.py:341-343`) and ones means *generate over the clip*. An explicit
  all-zeros mask is the gate's degeneracy calibrator (arm W9): it hands the
  source footage back by construction. The builder refuses it and says so.

---

## Licence — settled for WAN, still open for the pose estimator

**`VACE_LICENCE_VERIFIED` is now `true`, and it speaks for the WAN weights
only.** The three steps this section used to list as *"before any surface
renders with these weights"* were done on 2026-09-03, in that order: the
catalogue entries, `node scripts/gen_notice.mjs`, then the flag.

### WAN 2.1 VACE — verified

`Wan-AI/Wan2.1-VACE-1.3B`'s `LICENSE.txt` at revision `574e6a7` is 11,357 bytes
and 1,581 words. Diffed word by word against canonical Apache-2.0 fetched from
apache.org: **similarity 1.000000, zero differing runs across the whole file
including the appendix**, whitespace-normalised md5 identical, placeholders left
unfilled. No addendum, no acceptable-use annexe, no revenue ceiling, **no
territory clause** — so this added no row to `server/territory_test.js` and H3
remains the only region-locked entry in the catalogue.

Apache-2.0 says nothing whatever about generated material: §2 grants rights over
the Work and its Derivative Works, and its conditions (§4 — keep the notice,
keep the disclaimer, mark changes) attach to *redistributing the software*.
There is no term to comply with when you sell a clip. WAN says the same in its
own README, under "License Agreement", quoted here with its own typo intact:

> The models in this repository are licensed under the Apache 2.0 License. We
> claim no rights over the your generated contents, granting you the freedom to
> use them while ensuring that your usage complies with the provisions of this
> license.

**⚠ The gap this turned up, which is worth knowing before you cite it.** The
weights on this rig are *not* from the repository whose licence is quoted above.
All three are `Comfy-Org/Wan_2.1_ComfyUI_repackaged` at `617a7633`, proven by
sha256 against that repository's own published LFS records — the DiT is
`640ccc05…30784f2`. `Wan-AI/Wan2.1-VACE-1.3B` publishes a diffusers layout and
does not contain these filenames at all, and **the repackage ships no LICENSE
file** — only a `license: apache-2.0` frontmatter tag, which is exactly what
this section used to refuse to accept. That the repackaged fp16 build is a
conversion of Wan-AI's weights rests on Comfy-Org's own `base_model` declaration
plus the filename: an inference, far stronger than a tag and weaker than the
licence text, and provable outright only by downloading the upstream original to
compare. `server/models.js` states it that way in the entry's own note.

### DWPose — one half verified, one half unread

The catalogue row `posePreprocess` ships as **`outputRights.class: "unknown"`,
`sellable: null`, empty quote** — the same shape Ideogram 4 carries, for the
same reason.

- **`yolox_l.torchscript.pt` is settled.** `hr16/yolox-onnx` ships no LICENSE
  file and a 127-byte model card, but the upstream that card names — Megvii's
  YOLOX — has one, and its terms body through END OF TERMS AND CONDITIONS is
  **identical** to canonical Apache-2.0 (1,413 words both sides, md5 equal). The
  only two differences are inside the appendix *example*.
- **`dw-ll_ucoco_384_bs5.torchscript.pt` is not.** Its redistributor ships no
  LICENSE file and a **28-byte model card** — three lines of frontmatter, no
  prose, no statement of what was converted. `yzd-v/DWPose`, usually named as
  the original, is *also* 28 bytes of frontmatter with no LICENSE file. The only
  real document in the chain is `IDEA-Research/DWPose`'s LICENSE on GitHub,
  which diffs clean — but it is reached **only by a filename match**, and a
  filename is not a grant.

In practice a skeleton is a measurement of a video you supplied, and the clip it
steers carries the *rendering* model's terms, which are WAN's and are settled.
Read the chain yourself before relying on the skeleton itself being licensed.

### Where the evidence lives

`server/models.js` (entries `videoControl` and `posePreprocess`) carries the
quote, the clause and the pinned URL; `NOTICE` is generated from it, and its
runtime-dependency section names `comfyui_controlnet_aux` (Apache-2.0,
`@59b1fc4`, LICENSE.txt diffed and identical), which is a code dependency rather
than a model and so is deliberately not a catalogue row.
`server/models_control_test.js` pins all of it, including the file sizes and —
under `AIPLAY_LICENCE_HASHES=1` — the sha256 of every file against the
publisher's own record.

---

## The proof render

One render, this pass. It predates the engine door, so it was posted straight at
ComfyUI's own published port by the temporary client that used to live in
`control.js` — which is why it has a `prompt_id` below and no `runId`. Nothing
listens at that port now (see *The wiring* below), and every control render
since is a `runId` in `/api/provenance?prefix=engine/`.

- **Dispatched** 2026-09-03 04:02 UTC, `prompt_id 19a37426-7bf2-49c7-aee9-4b51e84d7f94`.
  **`execution_success` 04:34 UTC** — `31.99` minutes wall clock, from the
  engine's own `execution_start`/`execution_success` timestamps.
- The graph came from `vaceGraph()` — not from a fixture, not from the bench
  runner — with `control: "gate_block.mp4"`, W1's prompt, **seed 424242** and
  prefix `control/proof_vace_424242`. A new seed and a new prefix on purpose:
  with W1's own, ComfyUI's execution cache could have served the old file whole
  and a broken builder would have looked fine.
- **`HTTP 200, node_errors: {}`.** ComfyUI validates on POST — unknown classes,
  missing required inputs, wrong link types and out-of-range combo values all
  come back as a 400 before anything queues. So the 200 is itself a measured
  claim about the graph.
- Diffed against `_graphs/W1_s70117.json`: **identical but for `KSampler.seed`
  and `SaveVideo.filename_prefix`.** The engine then said the same thing by
  itself: `execution_cached: [1,2,3,4,5,6,20,21,22]` — the loaders, both text
  encoders, the sigma shift and **the whole pixel chain** were cache hits
  against W1's run, so only the VACE node, the sampler and the save re-executed.
  A builder that had drifted anywhere in those nine nodes could not have hit
  that cache.
- **Output:** `output/control/proof_vace_424242_00001_.mp4`, 1,158,262 bytes.
  Fed back through this directory's own gate:
  `{ok: true, width: 1280, height: 704, fps: 24, frames: 121}` — so a VACE
  render is itself a valid control clip, and the path composes.

That ~32 minutes is why the VACE deadline is 90 minutes — `timeoutMs` on the
`engine.run()` call in `server/mv/control.js`, since `waitForPrompt` is deleted.
It matches the gate run's own pace (sixteen renders, 09-02 10:42 → 09-03 05:48),
and 45-minute deadlines abandoned renders that then finished.

---

## The pose gate — run 2026-09-03, and it passed

The camera gate says VACE carries a blocked **camera move**. That is a different
claim from "VACE carries a **performance**", and this is the second one, measured
on its own. One render, `POSE_GATE` in `pose.js` holds the result.

**The chain.** `output/clips/measure_s01.mp4` → `poseGraph()` → a 121-frame
skeleton that passes `validateControlClip` (`1280x704, 24.000 fps, 121`) in
**26.4 s** → `vaceGraph()` with that skeleton on `control_video` and a character
sheet on `reference_image`, strength **1.00**, masks **"ones"**, seed 20260903 →
**2032.2 s (33.87 min)** by the engine's own `execution_start`/`execution_success`
→ DWPose re-run on the **output** → the two keypoint sets compared frame by frame.

**Does it follow the pose?**

| | joint pairs | mean joint error | mean per-joint r |
|---|---|---|---|
| **render vs control** | 803 | **33.7 px** (0.0365 of frame) | **0.893** (median 0.962) |
| null — control played backwards | 749 | 157.3 px | −0.020 |
| null — every control joint frozen at its median | 803 | 119.9 px | undefined¹ |

¹ a constant series has no variance, so its correlation is undefined rather
than zero. The static null still gives the distance baseline, and that is the
one that matters: **33.7 px against 119.9 px** is the render following the
skeleton rather than merely sharing a human body layout.

Per joint, the shape of it: `nose` 6.8 px at r 0.998/0.971, eyes 13–16 px,
shoulders 24–35 px, elbows 47–56 px — and `l_wrist` **149.9 px at r 0.50/0.45**.
The head and torso are carried almost exactly; the hands are not carried at all.

**Does it keep the character?** `reference_image` was
`mv/night-train-girl/assets/char_4cf6a2160fb1.png` — Kaya, single panel, one
figure, no lettering, minimal background (DIRECTING.md §2). It works, and
getting a number for it took three tries, which is worth writing down:

| measure | window | vs Kaya | 6-sheet null | z | reads |
|---|---|---|---|---|---|
| `h3_bleed.py` NCC | whole frame | −0.034 | −0.091 ± 0.098 | **0.58** | cannot answer |
| H-S palette | whole frame | 0.127 | 0.156 ± 0.050 | **−0.59** | cannot answer |
| H-S palette | central band | **0.239** | 0.139 ± 0.039 (max 0.199) | **2.57** | **carried** |

The first two are not broken; they are dominated by pixels that were *supposed*
to change. The sheet's background is a night sky and the render's is daylight,
and background is most of both frames. Windowed to the central 40% — one rule,
applied identically to all seven sheets and both clips — Kaya beats not just the
foil mean but the **best individual foil**, at z 2.57 against `h3_bleed`'s own
~2 bar. The tightest foil of all is the source clip itself: the man whose
skeleton drove the render scores **z −1.40** against the same sheet.

And by eye, which is the check the number exists to support: at frames 0, 60 and
120 every named attribute of the sheet is present — black bob with a blunt
fringe, navy double-breasted uniform, brass buttons, gold shoulder boards, white
gloves, peaked cap with a **red** band.

**The two things this gate does not cover**, both in `POSE_GATE.caveats` and
both easy to drop from a card:

1. **DWPose cannot see this render.** No figure in 43 of 121 output frames — all
   flat-shaded anime close-ups with a plainly visible person in them — and none
   in the anime character sheet either. yolox is trained on photographs. The
   score is the 78 frames where the instrument could see both sides, and the 43
   it could not are the **closest** ones.
2. **The source is not a dance.** `measure_s01.mp4` is a man at a console with
   the camera pushing in 2.71x (ear-to-ear span 127 → 345 px). Legs never
   appear; hips land on 14 frames of 121, wrists on 10 and 41.

**What this settles about `reference_image`.** It is no longer untested. It was
supplied for the first time on this rig, and two things came back measured: the
character carried (above), and **the output is exactly 121 frames**. That second
one is the check on `TrimVideoLatent`. A reference prepends one latent frame,
which is four pixel frames; had the trim not been wired to `WanVaceToVideo`'s
4th output the file would be 125 frames and the reference itself would be frame
zero of the shot. It is 121. What is still unmeasured is what a reference does
to **CMA** — the camera-motion score has never been re-run with one attached.

---

## The wiring — done, and this is what it does

This section used to be two: *⚠ The second door, and its expiry date*, describing
a small private engine client at the end of `control.js`, and *The one-door
wiring the next pass must do*, describing what should replace it. Both landed on
**2026-09-03** and both are now one description of what exists.

**What was deleted, not exempted.** `engineBase`, `postGraph`, `waitForPrompt`,
`firstOutputFile` — and `extractPose`, the only caller that made them necessary.
They existed so this directory could take one measured proof render without
editing `art.js` while another strand was live inside it. The base they built
resolved to **8266**, and after the engine door landed nothing listens there: the
app picks an unpublished port at every start and `server/engine/client.js` is the
only file in the tree that knows it. So the block had not merely become a
duplicate — it had stopped working, and its next render would have failed with a
connection refused after the graph was built. `POSE_GATE.engine` went with them;
it is `engine_run: null` now, with the honest note that the gate predates the
door and has no runId to give.

`server/engine/ui_test.js`'s debt list is **empty** and `DEBT_BUDGET` is **0**.

### Route — `server/mv/routes.js` + `server/mv/control.js`

`POST /api/mv` action **`control_render`**, body `{ slug, segmentId?, clip,
reference?, prompt, negative?, seed?, strength?, mode }`. One action and four
modes rather than four actions: they share the staging, the gate, the door and
the record, and splitting them would put four names in the parity census for one
capability and let three of them drift.

| mode | renders | what |
|---|---|---|
| `check` | 0 | measure the clip and report. **Free**, and it is the same measurement the render makes — stopped before it stages a byte. |
| `camera` | 1 | VACE on the clip as given. The measured path. |
| `pose` | 2 | DWPose the clip into a skeleton, validate THAT, then VACE on it. |
| `extract` | 1 | the skeleton alone, adopted into the clip library. |

In order, and the order is the design:

1. `validateControlClip()` **first**, before a byte is staged, and the `why` goes
   back verbatim — which of the three numbers is wrong, what it has to be, and
   which line of the engine silently does the wrong thing with it. A minute of
   GPU was lost to a 96-frame clip once; the refusal is the feature.

   ⚠ **And so is every argument that can be judged without a machine** — the
   strength, the reference's kind, the reference's existence. They used to be
   checked where they were USED: the strength inside `vaceGraph()`, the
   reference just before it was staged. On `camera` that is still ahead of the
   wire. On **`pose` it is not** — the skeleton IS the control clip, so the VACE
   graph cannot exist until DWPose has already run — and a strength of `5000`
   was refused with a real render already spent. Measured on the scratch
   instance: three 400s, one POST to `/prompt` in front of each. `judgeStrength`
   is now split out of `vaceGraph()` the way `judgeClip` is split out of
   `validateControlClip`, one sentence with two callers, and the reference is
   resolved up here and merely COPIED later. A reference named on a mode that
   renders no image is refused rather than dropped.
2. the clip is copied into the engine's input directory under
   `aiplay_ctl_<tag>_<sha1-of-path>.mp4` and passed by **basename**, because
   `LoadVideo.file` is a combo over that folder. Removed in a `finally`.
3. `poseGraph()` / `vaceGraph()` build the graph — unchanged, still data.
4. **`engine.dispatch()`**, with the CALLER's own actor (`provenance.actorFrom`:
   a browser by its Origin, an agent by its header). Never an invented one.
5. the output is **adopted**, so it lands in the clip library with its runId.
6. the project keeps a row per render — `mode`, `source`, `seed`, `strength`,
   `masks`, both runIds — because a row that only said "a control render
   happened" is a row nobody can reproduce.

`GET /api/mv/control` is the catalogue: `CONTROL_SPEC`, the modes,
`VACE_OPERATING_POINT`, `VACE_STRENGTH_LADDER`, the measured cost, `POSE_GATE`'s
numbers **with its four caveats**, and both licence answers separately. Same
shape as `GET /api/mv/previz`, so the card is data-driven and holds no literal.

**What the door gives that a private client could not.** The graph is hashed and
stored whole, and the prompt, the seed, the steps, the size, every model file and
**every reference's SHA-256** are written to the ledger *before* the GPU spends a
millisecond. A render that FAILS leaves a record where it used to leave nothing.
`scripts/control_route_proof.mjs` proves it end to end on a scratch instance with
only the socket stubbed: the `engine/<runId>` record carries `via: "mv.control"`,
the caller's actor, and the source clip's own digest on the `LoadVideo` node.

### MCP — `server/mcp-mv.js`

`mv_control_render` (camera and pose), `mv_pose_extract` (the skeleton, and its
description carries POSE_GATE's numbers **and all four caveats** — an agent that
reads "33.7 px, r 0.893" and not "43 of 121 frames were unscored, and the source
has no legs in it" will schedule a full-body dance and be wrong),
`mv_control_catalogue`, which is free and is the thing to read first, and
**`mv_control_check`**, which is the free gate. All four carry the clip contract
in words, because all three numbers fail silently and an agent reading only the
description is the common case.

⚠ **`mv_control_check` was missing, and the parity census could not see it.**
The census counts parameter NAMES: `mode` was reachable from both hands, so it
was green — while the page had four modes and `mv_control_render`'s enum had
two, with `async run` folding everything that was not `"pose"` into `"camera"`.
So the free check was a HUMAN-ONLY button, `mv_control_catalogue` advertised a
`check` mode no tool could ask for, and an agent that sent one would have been
answered with a 32-minute render. The coercion is gone (the route already
refuses an unknown mode naming all four), the tool exists, it is in `FREE_TOOLS`
and in `pipeline_guide`, and `server/mv/ui_test.js` now censuses MODES as well
as parameter names — five assertions that fail if any mode is reachable from one
hand and not the other.

### Cost — `server/mv/plancost.js`

Both tools are in the plan whitelist and both are priced. `controlMinutes()`
prefers **this install's own ledger** — the median `elapsedSec` of completed runs
of that `via`, cache hits and failures dropped — and falls back to a stated
constant (32 min for VACE, 0.5 for the extraction, cited to this file) tagged
`unmeasuredHere: true`. One ledger sample is enough here, unlike regen.js's two,
because this reads the engine's own clock rather than the gap between two rows.
`mode` is carried through the spend meter, so a free `check` is not charged as a
render.

### Card — the board editor, beside Previz

Two buttons and two costs, the same shape the previz bar has and for the same
reason — except here the gap is two orders of magnitude. **Check clip** is free;
**Steer it** is half an hour, stays disabled until a check passes, and confirms
the cost before it commits. The three numbers, the ladder with 1.00 marked, the
~32 minutes and both licence rows all come from the payload; the page holds no
literal. Pinned by `server/mv/ui_test.js`.

### And `CONTROL_SPEC` is imported now

`server/mv/previz.js`'s `FRAMES_MIN` was a second copy of 121 on this side of the
licence boundary. It reads `CONTROL_SPEC.minFrames` instead. The toolkit's own
copy stays — it is the authority, and it is across the boundary.
## Tests

```
node server/control/control_test.js       # 31 — the three numbers, on real mp4s
node server/control/pose_test.js         # 57 — the two settings, and the rights the row refuses
node server/control/vace_test.js         # 48 — the built graph IS W1, and the licence is a grant
node server/models_control_test.js       # 42 — the catalogue rows and the licence chain
node scripts/control_route_proof.mjs     # 51 — the route, over HTTP, only the socket stubbed
node server/mv/ui_test.js                # the card, and the parity census both ways
node server/mv/plan_test.js              # the cost, measured-or-stated, and the free check
```

⚠ **control_test lost three assertions and pose_test two, and both losses are the
point.** They tested `firstOutputFile` and `extractPose`, which are deleted;
`server/engine/client.js`'s `collectOutputs()` reads the same four output keys and
returns strictly more (bytes and a SHA-256), and `client_test.js` owns that now.
Meanwhile the live checks in `pose_test` and `vace_test` **came back**: they had
been silently skipping since the door landed, because they built a URL from
`engineBase()` and there is no published engine base any more. They ask the app's
own door instead — `POST {action:"object_info"}` with an actor header,
`server/control/live_test_lib.js` — and each suite gained three assertions that
really run.

`models_control_test.js` lives beside the catalogue rather than in this folder,
because what it guards is a catalogue fact. Give it `AIPLAY_LICENCE_HASHES=1`
and it also re-reads 11.6 GB to prove every weight on this disk is the byte
sequence the licence claim was made about (~15 s, which is why it is opt-in).

Those counts are this rig's, with ffmpeg and a live engine. A machine missing
either runs fewer assertions and says which, by name, rather than passing
quietly.

All three are in `.githooks/pre-commit`. Two sections skip themselves **loudly**
rather than failing on a machine that is not this one:

- `control_test`'s synthetic clips need ffmpeg. Without it the sentences are
  still checked and the probe is not, and it says so with a count.
- the live-`object_info` sections in `pose_test` and `vace_test` need the APP
  running with an engine behind it — they ask `POST /api/engine`, not the engine,
  and the skip sentence names the app's URL rather than a port. They check that every class, every required input and
  every combo value in the built graph exists on the **live engine** — which is
  how the pinned filenames and the `1280x704` numbers are kept honest against a
  node that changed upstream.

`vace_test` also re-diffs its embedded W1 fixture against the real
`_graphs/W1_s70117.json` when the bench rig is on the disk, so the fixture
cannot drift from the graph it claims to be.
