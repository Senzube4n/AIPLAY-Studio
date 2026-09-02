# Overnight queue — FINISHED 2026-09-02 ~06:00

**Everything below ran. Read `## Results` first; the task sections are the
working notes behind them.**

## Results

| deliverable | state |
|---|---|
| **The gate** | **DECISIVE NEGATIVE.** Guides transport a camera move; everything that also generates discards it. Do NOT build the Blender bridge for LTX. |
| **THE QUIET** (5:02 short film) | Delivered. `output/THE_QUIET.mp4` + preview. 60 shots, 9 re-rolled after review. |
| **Measure Twice** (1:35 rap track) | Delivered. `output/MEASURE_TWICE.mp3`. |
| **Measure Twice** (music video) | Delivered WITH KNOWN FAULTS. `output/MEASURE_TWICE_MV.mp4`. Lip-sync measured at ~0; identity drifts between clips. |
| **H3 reference bleed** | Answered, measured, pictured. `docs/H3_REFERENCE_BLEED.md`. |
| **Resolution for faces** | Answered + premise corrected. `docs/RESOLUTION_FOR_FACES.md`. |
| **Camera plumbing** | Fatal fixed, plus an unlisted 5th write door. |
| **Blender previz** | Built at `C:/temp/AIPLAYStudio-blender`, outside the repo on the GPL boundary. |

## Three things I asserted and then had to correct

1. **`visual_cond_noise_aug` is the reference-MAXIMISING setting**, not a partial
   strength. 0.999 is ~60 dB SNR. The missing node is the missing cure, not the cause.
2. **LTX lip-sync does not work as wired.** I claimed it would from a code
   reading; measured correlation is +0.034 across 18 clips. Mechanism present,
   outcome absent.
3. **Surface texture on the blocking clip was right after all.** I rejected it,
   then reversed on evidence: it moved the anchor 0.68 -> 0.98 with the flow field
   byte-identical, because it changes pixels and not the flow priors are fitted to.

## Heartbeat: STOPPED

Verified 2026-09-02 ~06:15 — ComfyUI queue empty, app server up, all five
deliverables intact on disk, gate verdict `DECISIVE NEGATIVE` recorded, and every
suite green (ui 12, mcp-vfx 88, camera 80, camera_moves 61, store 203). Nothing
stalled, nothing to resume, so the recurring job was cancelled rather than left to
fire ~330 more times over seven days doing nothing.

## ⚠ A NIGHT OF WORK IS UNCOMMITTED

Ten modified files and eleven new ones, none committed — the gate harness, the
camera plumbing and its fixes, four docs, the film and MV runners. A stray
`git checkout .` would take all of it. Committing was not done because the
standing instruction is to commit only when asked.

## Open, and needing the owner

- **WAN VACE, 11.3 GB.** NOT downloaded — the standing instruction was to ask.
  The gate's negative is precisely the case for it: structural conditioning is the
  one path the mechanism objection does not touch.
- **`LTXVModalityGuidance` at modality_scale 3.0** is the next lip-sync
  measurement, and it is not wired by `videoGraphLtx`.
- **Identity locking** via `firstFrame` for any future music video.

---

# Original queue — resume notes

Written 2026-09-02, ~01:00, before an unattended run. **If a session died and you
are picking this up cold: read this file top to bottom, then check the "state"
line of each task before doing anything.** A crash already cost one turn tonight;
everything below is written so it can be resumed without the conversation.

Context documents, in order: `NEXT_VFX_AND_3D.md` (the brief, revised against a
measured recon), `CONTINUE_HERE.md` (the repo's own hand-off).

---

## Standing facts (measured, do not re-derive)

- ComfyUI is on port **8266**, not 8188. Started with
  `--lowvram --async-offload 4`, `--output-directory D:/AI/aiplay-studio-bench/ComfyUI/output`,
  `--input-directory D:/AI/aiplay-studio-bench/ComfyUI/input`.
  Python: `D:\AI\aiplay-studio-bench\venv\Scripts\python.exe` (3.10.6, cv2 5.0.0,
  numpy 2.2.6, av 17.1.0).
- Rig: RTX 4070 Ti SUPER, 16376 MiB VRAM. 31.93 GB system RAM — **RAM is the
  binding constraint**, not VRAM. LTX is a 20 GB DiT + 15.4 GB text encoder
  streaming through system RAM.
- **Blender 5.2.1 LTS IS installed** (user installed it 2026-09-02 ~01:00) at
  `C:\Program Files\Blender Foundation\Blender 5.2\blender.exe`. Headless works:
  `blender -b --factory-startup -noaudio -P script.py`, Python 3.13.13, ffmpeg
  output available. Engine enum on this build reports only BLENDER_EEVEE plus
  CYCLES.
- **There is still no bridge, and the gate has still not passed.** Blender does
  not change that discipline: step 2 stays unbuilt until a number says the model
  honors a control video. What Blender DOES unblock immediately, independent of
  the gate: (a) real gray-box previz, far beyond `gate_block.py`; (b) rendered
  props as INPUT REFERENCE IMAGES, which work today through H3 regardless of
  whether video control ever lands.
- **Blender code lives OUTSIDE this repo**, at `C:\temp\AIPLAYStudio-blender`.
  Any `bpy`-importing code is a derivative work under the Blender Foundation's
  position and this repo is public Apache-2.0. Interface is a file handoff
  (rendered mp4/png at a path), never an import. This implements the brief's own
  architecture decision.
- Any clip fed to the LTX restyle path must be **1280x704, exactly 24.000 fps,
  >= 121 frames**. The restyle path ignores source fps, clamps short clips to
  their last frame, and stretches aspect. Getting this wrong fakes a negative.
- Third-party ComfyUI nodes must **not** be installed without the user saying so.

---

## Task 1 — THE GATE  ·  state: ANSWERED. DECISIVE NEGATIVE.

**RUN 2 VERDICT: the guide path provably transports the camera move, and every
arm that also generates discards it.** Exit 0, `gate_report.json` verdict
`DECISIVE NEGATIVE`.

| arm | conditioning | CMA | MR | SSIM to blocking |
|---|---|---|---|---|
| A0 | text only | -0.250 | 0.03 | 0.442 |
| A1 | 16 @ 0.30 (shipped default) | -0.256 | 0.06 | 0.745 |
| A2 | 16 @ 0.45 | -0.257 | 0.06 | 0.805 |
| A3 | 16 @ 0.60 | -0.064 | 0.16 | 0.871 |
| **A4** | **8 @ 0.70 (degenerate anchor)** | **0.918** | **0.89** | **0.914** |
| A5 | 8 @ 0.30 | -0.228 | 0.04 | 0.844 |
| **A6** | **121-frame single guide** | **0.966** | **0.92** | **0.949** |
| A7 | 16 @ 0.22 | -0.244 | 0.05 | 0.696 |
| A8 | 16 @ 0.15 | -0.188 | 0.04 | 0.557 |
| A9 | framing-only control | -0.224 | 0.05 | 0.546 |

A4 reaches CMA 0.918 against a 0.982 reconstruction anchor, above its own NULL of
0.353 — **degenerate anchor CONFIRMED**, so the pixels reach the latent and the
metric sees the move. But A4 and A6 both sit at SSIM 0.91-0.95 to the gray boxes:
they got the move by handing back the blockout. Every arm that actually restyled
has MR 0.03-0.16 — no camera motion at all.

**There is no setting where sparse appearance guides both follow the blocked
camera and produce something other than the gray boxes.** The mechanism explains
it: LTXVAddGuide VAE-encodes literal frames, so there is no structure/appearance
separation to exploit.

**CONSEQUENCE FOR THE PLAN: do not build the Blender bridge for LTX.** The brief's
step 2 is dead on this path, which is exactly what the gate existed to find out
before the work was done. The honest next lever is WAN VACE (11.3 GB, conditions
structurally, `WanVaceToVideo` takes a real `control_video` + independent
strength). **NOT downloaded — the user said to ask first, and they are asleep.**

Run 1 (flat clip) archived at `output/gate/_run1_flat/` with a README. Its scores
are NOT comparable to run 2's.

--- superseded notes from before run 2 ---

Workflow `wf_49b9a98c-89e` (task `wsprz51r3`). Resume with
`Workflow({scriptPath: "…/gate-headroom-wf_49b9a98c-89e.js", resumeFromRunId: "wf_49b9a98c-89e"})`.

**Why it exists.** The first gate run completed — 16 renders, 10 arms, ~29 min,
zero failures — and returned **NO RESULT (exit 3)**. Correctly: the degenerate
calibration arm A4 scored CMA 0.404 against a 0.683 reconstruction anchor, so the
arm that returns the source almost verbatim could not itself score, and nothing
about conditioning can be concluded.

**What is already solid and needs no re-running:**

| series | median px/frame | hold | orbit | tip |
|---|---|---|---|---|
| ground truth (analytic) | 3.818 | 0.000 | 5.388 | 4.194 |
| source re-encoded (DIS) | 2.538 | 0.003 | 3.107 | 3.808 |
| A4 dense 8@0.70 | 1.195 | 0.094 | 1.481 | 1.912 |
| A6 121-frame guide | 1.396 | 0.093 | 1.494 | 1.937 |
| A1 shipped default | 0.341 | 0.295 | 0.348 | 0.350 |
| A0 text only | 0.160 | 0.162 | 0.154 | 0.175 |

- A0 and A1 have a **flat** profile — same motion in the locked-off hold as in
  the orbit. No camera move at all. At shipped strength, guides do not carry one.
- A4 and A6 have the **right shape** but half the magnitude. The guides land.
- CMA and SSIM-to-blocking rise **together** across the strength sweep
  (0.45 → −0.27/0.767, 0.60 → 0.13/0.895, 0.70 → 0.40/0.936). There is no point
  where the camera follows and the picture is not the gray boxes. That is the
  predicted mechanism: an appearance guide has no structure/appearance separation.
- The instrument is the binding constraint: DIS recovers only 2.538 of 3.818
  px/frame on a **perfect** reconstruction.

**IT LANDED, AND IT WORKED.** Plane-locked surface detail (4 octaves of value
noise + 0.5 m panel seams, +-0.045, seed 20260902) took the reconstruction anchor
**0.6825 -> 0.9815**, MR **0.7412 -> 0.9807**. Every prior bound is IDENTICAL to
four decimals (static dolly 0.3027, per-frame radial 0.4398, translation 0.3299)
because the flow field is byte-identical — now SHA-256 pinned and asserted, with
an explicit "do NOT re-pin to make a pixel-only change pass" in the failure
message. The reasoning held: detail changes PIXELS, geometry changes the FLOW
FIELD, and only the latter can make a move matchable by a cheap prior.

**NEW ISSUE TO HANDLE WHEN SCORING:** NULL rose to **0.536**, which is now ABOVE
the scorer's 0.50 absolute pass floor. Criterion (1) has stopped doing any work —
the effective bar is criterion (3) (beat NULL) and criterion (2) (beat A0 by
0.25). Either raise T_CMA_ABS to something like 0.65 or state plainly in the
write-up that the floor is inert and the margin carries the claim.

**RE-DISPATCH IS BLOCKED ON RAM, NOT ON A DECISION.** At the time of writing,
1.35 GB free of 31.93 (Blender previz + camera workflows resident) and only
4.6 GB free VRAM. The LTX stack streams ~35 GB of weights through system RAM;
dispatching into that thrashes for an hour and yields noise. Wait for the other
workflows to exit, confirm >= 15 GB free, then:

**Old next step (kept for the resume path):** if the reconstruction anchor clears ~0.85,
re-dispatch (`node scripts/gate_run.mjs --run`, ~29 min) and re-score
(`gate_score.py --score <armdir>` per arm, then `--report`). If it does not
clear, do NOT re-dispatch into the same ambiguity — record it and move on; the
honest next lever is the 11.3 GB WAN VACE download, which conditions structurally
and is the one path this mechanism objection does not apply to. **Do not buy the
download without asking.**

---

## Task 2 — Camera plumbing defects  ·  state: DONE (fatal fixed, 5th write door found)

Workflow `wf_2bc2905a-fb7` (task `w87gzgqrj`). Launched while the GPU was idle,
because the pixel proofs contend for RAM with a streaming DiT.

The VFX camera work shipped and is green on 2000+ assertions, but adversarial
review found a **fatal** and three serious regressions. Full detail in the review
of workflow `wf_91cf1b2b-64e`.

- **FATAL** — `mergeCamera` (routes.js ~4696) runs
  `if (namesZoom) delete C.focalLength; if (namesFocal) delete C.zoom;` *before*
  its resolve loop, so mid-call the camera holds neither spelling. A camera can
  never be switched back to pixels, and one with no `zoom` field can never be
  given one.
- The `pushIn` preset converts a pixel camera to millimetres permanently, with no
  way back.
- Range validation was enforced by the old replace and is not enforced by the
  merge (aperture −50, blurLevel 1e9 etc. now store).
- The positivity guard exists only in `mergeCamera`, not in `set_prop` or
  `add_key` — three of four write doors are unguarded.

These need `engine.py` pixel proofs, which contend for RAM with a streaming DiT.
**Run them only when the GPU queue is idle.**

---

## Task 3 — H3 reference bleed  ·  state: ANSWERED. See docs/H3_REFERENCE_BLEED.md

Workflow `wf_5893d8b3-4ce` (task `wqee4pohk`).

User's question: why do frames bleed through from reference images on the 4-step
H3 turbo LoRA — a collaborator reproduced it on their own machine, so it is not
rig-specific. Leading hypothesis, to be verified not assumed:
`visual_cond_noise_aug` defaults to ~0.999 (`comfy/ldm/minimax/model.py:481-494`,
plumbed from `comfy/model_base.py:2175`) and **nothing anywhere sets it**, so at
4 steps there is far less opportunity for the reference latent to resolve away
than at ~25.

Three repos to evaluate on their source, **read-only, install nothing**:
`xmarre/ComfyUI-Spectrum-MiniMax-H3`, `Larryvrh/ComfyUI-MiniMax-H3-Turbo`,
`LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler`. The user explicitly did not
vouch for them.

---

## Task 3b — Blender previz toolkit  ·  state: DONE at C:/temp/AIPLAYStudio-blender

Workflow `wf_7336944b-5dc` (task `w70vhyafs`). Builds, at
`C:\temp\AIPLAYStudio-blender`: a gray-box scene builder, a written-from-scratch
camera-move vocabulary (orbit, push-in, offset-follow, crane, floor-rise,
robo-arm, handheld, speed-ramp), a blocking renderer pinned to the three numbers,
and a prop reference-image renderer with contact sheets. The commercial plugin
that inspired this ships NO camera library and NO gray-box builder — its moves
were written on the fly by an LLM — so this vocabulary is genuinely new work.

---

## Task 4 — Rap music video  ·  state: RESOLUTION SWEEP IN FLIGHT (wf_c4edd234-27c)

Requirements as given:
- A rap song, with **cool camera movement**, focus on **lip-sync**.
- **Resolution matters more than upscaling.** Render native somewhat above the
  default, because upscaling will not recover a small face that is further from
  camera. Test the resolution-versus-clip-length trade-off and judge: step down
  through 16:9 sizes until one sustains the clip length a real music video needs.
- 1080p is reachable but costs clip length. Find the balance by measurement.

Note the custom-size work already in the repo (recent commits mention custom
video sizes and a size list that stopped promising sizes it could not make) —
read that before designing the sweep, it may already answer part of it.

---

## Task 5 — Sci-fi short film "The Quiet"  ·  state: RENDERED, FIXES IN FLIGHT

**60/60 shots rendered, zero failures, 70 minutes** at 1280x704 x 121f on LTX.
Output: `D:/AI/aiplay-studio-bench/ComfyUI/output/film/NN_00001_.mp4`.
Review sheet was built and read; nine shots were wrong and are being re-rendered
with corrected prompts (8, 9, 26, 38, 53, 57, 58, 59, 60).

**THE LESSON, now in the shots file header:** a prompt naming a PROCESS renders as
the state before it. "A cable parting and the jib bending" gave a static crane in
fog; "pull back to reveal hundreds of pins" gave a floor with no map in it. Pick
the single most telling moment and write it as ALREADY TRUE, in the perfect tense.
Camera movement is unaffected — that is a fact about the lens and renders fine; it
is SUBJECT change across a clip that does not.

Still to do: concatenate to a single film, then a second review pass.

- Treatment + 60-shot list: `docs/SHORTFILM_ANOMALY.md`
- Render-ready prompts: `scripts/shots_anomaly.mjs` (validated: 60 shots,
  contiguous ids, unique deterministic seeds, ~2.0 h GPU at ~121 s/clip)
- Marker prop rendered: `C:/temp/AIPLAYStudio-blender/out/marker_{q34,low,top}.png`

**The idea.** Not "we wake something up". The anomaly has been making a sound for
140,000 years and the excavation is what makes it STOP. It is not a craft, it is a
boundary marker — and the sound was a fence. The last shot pulls back off a chart
covered in hundreds of evenly spaced pins.

**Engine: LTX 2.5.** No lip-sync needed, 5.5x faster than H3, better by eye.
Camera moves come from the PROMPT, not from blocking — the gate settled that.

**Prop lesson worth keeping:** three attempts to model the script as geometry all
failed differently and all looked plausible in the vertex count (grid-fill does
nothing on a 9-gon; poke+subdivide silently under-subdivided; an explicit radial
grid rendered as a detached lid). Only the render caught each one. The script is
now described in the PROMPT and the mesh carries only silhouette and seam — which
is the right division anyway for a reference image.

## Task 6 — Rap music video "Measure Twice"  ·  state: SONG DONE, VIDEO RENDERING

- **Song rendered**: `output/aiplay_00081.flac` -> `output/MEASURE_TWICE.mp3`,
  1:35, 88 BPM F minor boom-bap, mean -14.5 dB. Length follows lyric length, not
  max_seconds, which is why it is 95 s and not 180.
- **Video**: `scripts/mv_run.mjs`, 19 clips x 5.04 s on LTX at 1280x704, each clip
  handed the SEGMENT of the song it sits over via `audioTrack` so the mouth the
  model drives is the mouth that will be heard. ~40 min.
- **Two decisions came from measurement, not taste**, both documented in the
  runner header: framing chest-up rather than a bigger canvas (the sweep showed
  1536x864 cost 36% more than native and produced the SMALLEST face), and LTX
  rather than H3 (`run_a2v` defaults true in every block; `LTXVModalityGuidance`
  exists specifically to strengthen lip-sync; 5.5x faster).
- App server is now running on 4173 and owns ComfyUI on 8266. The hand-started
  engine was stopped first, because of the adoption guard.

- Caption + lyrics + video plan: `docs/MV_MEASURE_TWICE.md`
- Prerequisite: `make_song` via the app server. **The app refuses to adopt a
  foreign ComfyUI** (adoption guard, comfy.js) — so the manual engine on 8266 must
  be stopped first and the app allowed to spawn its own. Do that only when the
  GPU queue is idle.
- Size decided by the resolution sweep, not guessed.

5 or 10 minutes, whichever fits. Out-of-the-box alien lore set in Earth's oceans:
panic aboard a battleship, the **Baltic Sea Anomaly**, possibly an excavation of
it. Props may be used as input reference images. Fix mistakes afterwards.

**Honesty constraint:** it cannot be Blender-driven — Blender is not installed
and no bridge exists. `scripts/gate_block.py` IS a working gray-box previz
renderer with a keyframed camera and can block shots; the new VFX 3D camera rig
can drive comps. Use those and say plainly what drove what.

---

## Order of operations

GPU is serial, so the queue is: gate re-dispatch (if the anchor clears) →
resolution sweep for task 4 → music video renders → short film renders. Camera
fixes (task 2) and anything CPU-only slot into gaps when the GPU is idle.

Report honestly in the morning: what ran, what the numbers were, what failed, and
anything left undone with the reason. Do not report a task complete unless it is.
