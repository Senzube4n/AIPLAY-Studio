# VFX with a reason to exist, and 3D blocking as camera control

Written 2026-08-30 as a brief. **Revised 2026-09-01 against a 15-agent recon that
read the code** — models, routes, engine, the Higgsfield add-on's source, and the
machine. A lot of the first draft was guesswork and a lot of the guesswork was
wrong. Corrections are marked ⚠ and the reasons are kept, because the *shape* of
being wrong is useful: almost everything was wrong in the direction of
underestimating what already exists.

Two ideas, still not one project:

- **A. The VFX tab needs a job** — the titles-and-credits work video models
  structurally cannot do.
- **B. Blender blocking → video-to-video** — camera *control*, not VFX.

---

## What the recon changed

Five things, before any detail:

1. **VFX is already a near-complete title-sequence engine.** Per-character text
   animators, speed ramps, real thin-lens depth of field, expression-aimed
   cameras, 81 effects, cross-layer pixel reads — all present, all tested, all
   rendering correctly today. The brief called the first of those "#1 by a wide
   margin if missing." It isn't missing. **The gap is the authoring surface.**
2. **The Higgsfield plugin contains no cinematography knowledge.** There is no
   production-rules prompt, no gray-box builder, and no camera-move library. The
   "crown jewel" does not exist. What it does have is worth much less, and the
   licence attached to it is worth *negatively* much.
3. **The gate can run this week, but as one arm plus a control — not a sweep.**
   WAN VACE has zero bytes on this disk. Depth and pose paths are dead.
4. **A specific harness bug will fake a negative result** unless the blocking
   clip is authored at exactly 1280x704 / 24 fps / ≥121 frames.
5. **The Blender bridge cannot live in this repo.** Not a packaging detail — an
   architecture decision that has to be made before the first line.

---

## A. The VFX tab

### The premise survives

Generative video is better than a compositor at anything organic. But it is
*structurally* bad at clean typography, exact-frame timing, repeatability, logo
lockups, HUD graphics and credit rolls — it paints letterforms as texture, and
has no notion of "logo lands on beat 4." That list is the intros-and-credits
work, it doesn't close with a better checkpoint, and it stays the right job:

> **VFX is the titles-and-credits tab, working on top of generated plates.**

### ⚠ What already exists (the brief guessed, the recon read)

| Brief said | Reality |
|---|---|
| Per-character animators — "#1 by a wide margin" if missing | **Complete.** Six AE range-selector shapes, offset ramps, Ease High/Low, seven per-glyph properties, additive-for-offsets and multiplicative-for-ratios across stacked animators. `engine.py:1165/1203/1281/1349`, tested `engine_test.py:794-945`. Cost measured: 1.6–2.2× static text, never a blocker. `grep -rn animators web/` → **zero**. |
| Speed ramps — build them | **Exist and are reachable today.** `timeRemap` is an ordinary keyframe track (`interp.py:624/632/654`), so bezier easing, hold keys, roving and expressions all apply to the time axis for free. It shows in the timeline because the UI builds property rows from the server's enumerator. Sub-frame landings covered by `frameBlend:'mix'`. |
| Real DOF — add it | **Exists and is already in the UI.** A genuine thin-lens circle of confusion (`Camera.coc`, `engine.py:2259`), with toggle/aperture/focus controls at `web/vfx.js:1877-1879`. |
| Lens flare "exists; the occlusion test may not" | **Both exist, never connected.** Procedural `lensFlare` with core/halo/starburst/ghosts (`effects.py:2993`), and an exact plane-onto-plane occlusion transmittance field inside the shadow code (`lights.py:849/959`). |
| Heat distortion — build it | **Ships.** `turbulentDisplace` (`effects.py:2674`) with an animated evolution field, plus `displacementMap` whose own description names heat haze. |
| "templates.js and rigs.js exist — an extension, not a new subsystem" | **Half right, wrong half load-bearing.** `templates.js` is a real head start: 10 templates, 153 typed parameters, full docs already inlined into the MCP tool. `rigs.js` is unrelated — it builds guitar-fretboard and piano visualisers. |
| Decoupled camera targets — "cheap, large payoff" | **Payoff right; the one place the brief *under*estimated.** The engine resolves it perfectly (proved by render: an expression-aimed camera matched a hardcoded POI byte for byte). But **no write path can author it.** `resolvePropPath` (`store.js:858`) has branches for transform/light/material/effects/shapes/timeRemap and **no camera branch**; `layerProperties` returns zero camera rows while a spot light gets nine; `set_layer` rebuilds the camera from four scalars, silently discarding `pointOfInterest`, `focalLength` and `blurLevel`. `engine.py:2389` says so in its own docstring. |

Also found, not in the brief:

- **A stale banner is telling users the rigging layer is dead.**
  `web/vfx.js:142-145` prints "the renderer does not run expressions yet." It
  does — proved by rendering one comp with and without `expr:'value * 0.2'` and
  getting different hashes. The comment above it reads "⚠ DELETE THIS THE DAY
  engine.py PASSES THE SANDBOX IN." That day passed. Expressions are the
  mechanism behind camera aiming, handheld wiggle and every layer-to-layer rig,
  and a user reading that banner has no reason to try any of them.
- **All ten templates are flat 2D** — zero animators, zero cameras, zero lights,
  zero 3D layers, zero `timeRemap`. None of the engine's title machinery is used
  by anything on the shelf, and there is no credit roll.
- **The template sheet posts the template id and nothing else**
  (`web/vfx.js:5507`), so all 153 typed parameters are unreachable from the
  browser and every template comp is pinned to 1920×1080@30.
- **There is no LLM in this application, deliberately** — `server/prompts.js:3-18`
  argues an API key "would send your prompts off the machine." So "a prompt fills
  a template" works only through the connected MCP agent. Building an in-app path
  would reverse a stated architectural decision.
- **`ui_test.js` is an action-name parity gate only.** It matches
  `action: "..."` strings on both sides and passes green (10/0) while an entire
  *parameter* surface is unreachable. Its green is not evidence about section A.

### ⚠ Three things a titles tab needs that are genuinely missing

These are not discoverability. Wire up every panel and all three remain:

1. **Beat times are computed and then thrown away.** `audiokeys.py` does real
   work — spectral-flux onset, autocorrelation tempo with a 120 BPM log-normal
   prior, DP beat tracking, sample-domain refinement validated against synthetic
   click tracks. Then `routes.js:3830/:3889` return `beats: r.beats?.length ?? 0`
   — the **count**, not the times. Markers are drawn on the timeline but no
   gesture creates one, and nothing snaps a keyframe to one. The strongest
   structural argument for this whole tab — "logo lands on beat 4" — is currently
   reachable only by an agent doing arithmetic on BPM by hand. Cheapest large win
   in section A.
2. **No font story.** A layer stores a bare basename; a missing font falls back
   *silently* to a bitmap face (`engine.py:1090`); all ten templates hardcode
   `arial.ttf`; no font ships with the product; and `/api/fonts` hardcodes
   `C:/Windows/Fonts` while the engine also searches the per-user dir, so the
   picker and the renderer disagree about what exists. A comp is not portable off
   this machine, and a public Apache-2.0 repo would ship title templates
   defaulting to a font licensed through Windows.
3. **No composite path at the plate's own size.** VFX *can* composite — it has a
   real `video` layer type resolving out of the clip library, which is the only
   per-pixel-alpha path that exists. But template comps are hard-locked to
   1920×1080@30 against 1280×704@24 clips, and the Studio route is worse: its
   video export is a real-time browser MediaRecorder capture, so anything cut
   there is a screen recording — precisely where a frame-exact timing guarantee
   stops being frame-exact.

### Corrected order for section A

1. **Delete the stale expression banner.** One line. It sits in front of the
   feature everything else is built on.
2. **Plumb camera properties** — `CAMERA_PROP_SPEC` beside the existing
   `LIGHT_PROP_SPEC`, a `camera.*` branch in `resolvePropPath`, camera rows in
   `layerProperties`, and merge-instead-of-replace in `set_layer`. A verbatim
   copy of the light pattern that is already tested. Everything camera-shaped is
   blocked on it, and without it any camera a template ships is destroyed the
   first time someone opens the camera panel.
3. **Return beat/bar times and write them as comp markers**, with keyframe snap.
4. **Author the templates the premise names** — credit roll, per-character title
   card, animator lower-third, logo lockup, HUD bar — plus camera-move presets
   riding on (2): orbit, push-in, offset-follow, rack focus.
5. **A parameter form on the template sheet.** It generates itself from
   `listTemplates()`; the specs are already typed with ranges and defaults.
6. **The animator catalog** (GET route + MCP tool, mirroring the existing shape
   and effect catalogs) and a text-animator panel with 4–6 stock presets.
7. **`lightWrap`** on the existing `_layer_in` cross-layer read (`effects.py:661`,
   "THE ONLY WAY IN", already used by three effects). Highest payoff-to-effort of
   anything genuinely new — but do it in linear light, see the colour note below.
8. **Anchor `lensFlare` to a 3D light** through `Camera.project` and the existing
   transmittance field. Wiring plus one parameter.
9. **Cheap preset wrappers** over shipped machinery: speed-ramp curves, heat
   shimmer, stutter stack, three-point light rig, energy beam as an fx-preset.
10. **Park two, with reasons recorded** so they are not re-proposed: extruded 3D
    text and imported meshes (`_warp3` is a four-corner homography, "no per-pixel
    ray, no depth buffer" — that is section B's job), and volumetric light
    (`lights.py:57-58` refuses it by design: "a renderer, not a module").

Unexamined and worth knowing: **there is no colour management** — 8-bit uint8
throughout, no linear-light conversion around glow/blur, and every VFX mp4 goes
out untagged. Survivable now; it becomes real at item 7, because light wrap done
in gamma space is the classic version of that effect that looks wrong.

---

## B. Blender blocking as camera control

### The workflow, still worth reproducing

From the source video (https://www.youtube.com/watch?v=OiULPvTJ-0E): LLM writes
Blender Python for gray-box geometry and camera keyframes → Blender
viewport-renders a flat gray MP4 → the LLM reads its own blocking back and writes
a second-by-second prompt → gray video + prompt + references into the model → the
output follows the blocked camera. Six people at a table with zero seat swaps, a
19-shot car commercial, one blocking file re-skinned as three visual worlds with
every cut matching. Against raw prompts: drifting cameras, swapped seats, ~5,000
credits of nothing.

### ⚠ What the plugin actually contains

The first draft said its production rules were "the real crown jewel." They do
not exist.

- **No cinematography prompt.** No 180° rule, no shot-size vocabulary, no framing
  or keyframe-discipline instructions anywhere in the package. The only LLM
  instruction text is upstream Blender Lab's `prompts.yml`.
- **No gray-box builder and no camera-move library.** An exhaustive grep for
  `bpy.ops.mesh.primitive_*_add` across the whole add-on returns **one** hit, and
  it draws a UI panel. The remote LLM builds scenes by shipping **arbitrary
  Python** through `execute_script` / `execute_python`. The named moves in the
  video — orbit, floor-rise, robo-arm — were written by the model on the fly, not
  looked up from a library.
- **The MCP server is remote.** `https://bridge.higgsfield.ai/mcp`. The plugin
  dials *out* over WSS with an OAuth token in the query string and executes
  received commands through a localhost TCP socket on 127.0.0.1:9876. Tools ship
  as paired `<tool>_toolcode.py` source text that is `exec()`'d inside Blender.
- **It never automates the loop.** The Scene Builder chat and the Create-tab
  capture are separate features joined by a user clicking between them.

Two genuinely useful facts survive:

- **The flat-gray look costs two flags**, not a shading pipeline:
  `space.overlay.show_overlays = False` and `space.show_gizmo = False`, plus one
  render flag. The playblast needs an open, visible VIEW_3D area
  (`temp_override` on the largest one).
- **They send the blocking clip as `video_references` alone**, deliberately not
  the first frame alongside — their in-source reasoning is that on a
  reference-driven model a still is a second competing description of the same
  shot. Worth copying.

### ⚠ The licence, which the brief got backwards

The brief said "if OSS, take it directly and the licensing question evaporates."
Wrong, and in the expensive direction.

- The bundled wheel is **Blender Lab's official `blmcp`, © Blender Authors,
  GPL-3.0-or-later** — not the MIT community `blender-mcp`. Being open source
  makes this *worse*, not moot.
- The entire Higgsfield add-on is GPL-3.0-or-later in its manifest and every SPDX
  header. Nothing in its own Python is permissive.
- **And the consequence nobody had drawn:** the Blender Foundation's position is
  that any add-on importing `bpy` is a derivative work and must be GPL-compatible.
  So **the bridge we write is encumbered whether or not we ever look at their
  code.**

**Therefore step 2 cannot be a directory inside this Apache-2.0 repo.** It has to
be a separately-distributed GPL add-on talking over a process boundary — a socket
or MCP hop — to the Apache side. Which is exactly Higgsfield's architecture, now
worth adopting for the licence reason rather than the engineering one. Decide this
before writing a line; discovering it at packaging time means a repo split plus a
rewritten transport.

### ⚠ What can actually condition on a control video here

| Path | State |
|---|---|
| **LTX 2.5 guide conditioning** | **Runnable today.** All five weight files present, `videoReady('ltx')` → `{ready:true, missing:[]}`. `LTXVAddGuide` is core ComfyUI with a real strength float, and the app already wires it. |
| **WAN VACE** | **Core support is complete and genuine** — `WanVaceToVideo` takes `control_video` *and* an independent strength, actually consumed at `comfy/ldm/wan/model.py:854`, with a worked blueprint shipped and zero custom nodes needed. **Zero weights on disk.** 11.3 GB unblocks it (VACE 1.3B fp16 + umt5-xxl fp8 + wan 2.1 VAE). This is the only candidate where the control is *structural* rather than appearance-injected. |
| **Depth / pose ControlNet** | **Dead twice over.** `models/geometry_estimation` and `models/detection` hold only zero-byte placeholders, so no estimator can load; and the SD1.5 ControlNets that are on disk are unusable for want of ControlNet-aux, AnimateDiff-Evolved and VideoHelperSuite, none of which are installed. |
| **MiniMax H3** | `MiniMaxH3AddGuide` has **no strength input** — a control video is a hard anchor, so it returns the gray boxes. But the model itself implements partial-strength blending on guide latents (`comfy/ldm/minimax/model.py:481-494`) via a conditioning key nothing anywhere sets. A ~20-line custom node, not a model limitation. Stretch arm only. |

**The mechanism caveat that decides how to read any result:** `LTXVAddGuide`
VAE-encodes literal source frames into the latent. It is an *appearance* guide
with no structure/appearance separation, unlike depth ControlNet or VACE. On a
flat gray source the two failure modes are not "too strong / too weak" but "high
strength reconstructs the gray boxes" and "low strength loses the move" — with no
guarantee a workable middle exists. So a failure means *"sparse appearance guides
cannot carry gray-box blocking,"* **not** *"control video does not work here."*
And a success does not transfer to VACE-style conditioning either. The write-up
must name the mechanism or the gate teaches the wrong lesson in both directions.

### ⚠ The trap that would fake a negative

Three silent failures compose, and the most natural way to make the gray clip
walks straight into all of them:

- `restyleGraph` does `const rate = fps ?? v.fps` and the caller never passes
  `fps`, so the render is **always 24 fps** and the source's own rate is never
  read. Guides index by **absolute frame number**, so a 30 fps source pulls every
  guide ~25% early and drifts further each time.
- `ImageFromBatch` **clamps** an out-of-range index to the last frame, no error —
  a short clip silently freezes.
- `ImageScale` runs `crop:'disabled'`, which **stretches** rather than fits.

And the VFX engine's own template defaults are **1920×1080 @ 30**, against LTX's
**1280×704 @ 24**. Author the gray clip the obvious way and the measurement is
corrupted, the camera does not match, and the honest-looking conclusion is "the
local model ignores control video — kill it." Weeks abandoned on a harness bug.

**Prophylactic: author at exactly 1280×704, 24.000 fps, ≥121 frames, and assert
all three in the harness before it runs.**

### ⚠ Where the blocking clip comes from

Not Blender — **it is not installed** (swept C: and D:, three registry hives,
winget, Appx, PATH, and the absence of `%APPDATA%\Blender Foundation`). Not
`viewport.py` either: the brief assumed it renders, and it does not — it is a
JSON geometry/gizmo query tool that never emits a pixel.

`engine.py` genuinely could do it (3D solids, lit, through a keyframed camera,
straight to mp4). But a standalone numpy/cv2 script wins on the one thing that
decides the experiment: **only a script we write can emit ground-truth optical
flow.** Every face is a planar quad, so its mapping between frames is exactly a
homography through its projected corners — computed, not estimated. That matters
because a flat gray wall has almost no texture, and a flow *estimator* on the
reference side would be ill-posed in exactly the large smooth regions carrying the
camera move. Ground truth on one side, estimate on the other, is the entire reason
the number is trustworthy. (Secondary: `engine.py` sorts 3D layers by layer-centre
depth with no per-pixel test, and a corridor is large planes at grazing angles
seen from a camera swinging 180° — precisely where that pops. A pop is a fake cut
the gate would then measure as camera motion.)

---

## The order to do it in

**1. The gate.** One measured afternoon, no downloads, no Blender.
   - Render a gray-box corridor at 1280×704 / 24.000 fps / 144 frames with an
     unmistakable move (hold → half orbit → top-down), emitting ground-truth flow.
   - Run the **ceiling anchor first** — DIS-estimated flow on the blocking clip
     against its own ground truth. If that is below ~0.80 the clip is too
     texture-poor to measure and needs faint surface detail. Ten seconds here
     versus twelve wasted renders later.
   - Seven arms on one seed: text-only control, LTX sparse guides across a
     strength cross (16@0.30 / 0.45 / 0.60) and a density cross (8@0.30), a
     degenerate anchor (8@0.70) run *specifically* to reproduce the source and
     disqualified from passing, and a true dense 121-frame guide. Two extra seeds
     on the control and the primary arm, because the margin between them is the
     claim and you cannot tell a margin from seed noise otherwise.
   - Score **CMA** — magnitude-weighted mean cosine between ground-truth and
     estimated flow, median over frames — with magnitude ratio, a lag scan, a
     measured null, and an SSIM-to-blocking guard so an arm that "succeeds" by
     handing back the gray boxes cannot pass.
   - Decision surface is the CMA-vs-SSIM scatter, not any single number.

**2. Only if the gate is green:** the Blender add-on — **in its own GPL repo**,
   talking to the Apache side over a socket. Blender install, gray-box tools,
   camera vocabulary (which has to be written, not lifted), viewport playblast at
   the three numbers above, and the LLM reading its own blocking back.

**3. In parallel, independent of the gate:** section A, in the corrected order.
   Items 1–3 there are small, verified, and need no GPU.

**4. Later, if both land:** one blocking file drives the plate *and* the VFX
   camera. Note the concurrency hazard before then: VFX renders wait for the GPU
   via a `waitForIdle` **bounded at 60 seconds** and then proceed regardless,
   while a restyle takes 130–235 s. Step 4 is exactly the workflow that starts a
   Python render on top of a streaming 20 GB DiT.

---

## Open decisions

- **The 11.3 GB VACE download** — buy it only if the LTX gate is red or
  ambiguous. A green LTX result makes it unnecessary *for the gate*, though still
  interesting for quality, since VACE conditions structurally.
- **The GPL boundary for step 2.** Decide before writing the bridge.
- **What ships as the font.** One OFL face bundled, a missing font promoted from
  silent fallback to an error, and `/api/fonts` reading the same dirs the engine
  does.
- **Where the composite happens.** If it is the VFX engine with the plate as a
  video layer — the only per-pixel-alpha path — then `from_template` must accept
  width/height/fps and "new comp matching this clip" is worth more than any
  effect on the list.
- **The first real deliverable.** Still unanswered, and it decides which of
  section A matters: a credit roll needs beat sync, fonts and a scroll; a channel
  intro needs animators, camera craft and light wrap; a lower-third over
  generated footage needs the composite path and none of the 3D. Naming one
  collapses the list. Not naming one guarantees all of it gets half-built.

---

## Machine, as measured 2026-09-01

16376 MiB VRAM (14120 free) · 31.93 GB RAM, **7.48 GB free** · 84 GB free on D: ·
ComfyUI on port **8266**, not 8188 · nothing running · Blender absent.

System RAM is the binding constraint, not VRAM: the LTX stack is a 20 GB DiT plus
a 15.4 GB text encoder streaming through system RAM under `--lowvram`. Close the
browser and chat tier before any timing run, or every number recorded is noise.
