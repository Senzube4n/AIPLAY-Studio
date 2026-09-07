# Ported from AIPLAY Studio (base) — the VFX family

⚠ **Not to be confused with `server/mv/PORTED_FROM.md`.** That file records hand
ports from *aiplay.live* (a website's TypeScript, stripped by hand). This one
records ports from the *base Studio repo* at `C:\temp\AIPLAYStudio` into this
fork. Different source, different discipline, different failure mode.

**Source repo:** `C:\temp\AIPLAYStudio`, branch `overnight/gate-camera-previz`.

## The discipline

The base is the source of truth for VFX; the fork is the source of truth for
anything fork-specific. A port is a `git diff P..HEAD` over the VFX paths only,
applied to an **uncommitted** working tree. The fork's own VFX divergences are
listed below and must survive every port — if one disappears, the port is wrong,
not the divergence.

Nothing outside these four paths is ported: `server/vfx/**`, `web/vfx.js`,
`server/mcp-vfx.js`, `docs/VFX_SPEC.md`. The base's research scripts and night
notes stay in the base.

---

## Port log

### 2026-09-03 — `6db939c..7cfde96`

**P (previous port point) = `6db939c`** — "The gate answers, and the answer is
no". This was established by **blob comparison, not by a record**: no VFX port
ledger existed, so every fork VFX file was hashed and located in base history.
`6db939c` is the newest base commit at which the fork's `server/vfx` tree,
`web/vfx.js` and `docs/VFX_SPEC.md` match the base exactly (bar the three
divergences below). `6f9cd93` is the first commit that moves `store.js`,
`ui_test.js` and `routes_test.js` away, which is what fixes P at `6db939c`.

**Range ported:** `6db939c..7cfde96` — nine base commits, of which six are camera
plumbing (`6db939c 6f9cd93 cabf7f6 4287ce9 93159d5 c99ec10`) and three are colour
management (`d43c035 37f231d 7cfde96`).

**Applied:** 20 files, +6057 / -174. `git apply` took it with **no conflicts** —
the fork's three divergences sit outside every hunk.

New files:

| File | What it is |
|---|---|
| `server/vfx/cameramoves.js` | the camera-move generators (orbit, dolly, push, handheld…) |
| `server/vfx/camera_test.js` | camera properties, the atomic `mergeCamera` lens switch, band refusals |
| `server/vfx/camera_moves_test.js` | the moves, and the one-lens rule |
| `server/vfx/colour.py` | the sRGB↔linear transfer pair |
| `server/vfx/colour_test.py` | that it is the standard's piecewise curve, not a 2.2 power |
| `server/vfx/cachekey_test.js` | the preview cache key, folded over child comps |

Changed: `engine.py`, `engine_test.py`, `effects.py`, `effects_test.py`,
`lights.py`, `lights_test.py`, `routes.js`, `routes_test.js`, `store.js`,
`store_test.js`, `ui_test.js`, `web/vfx.js`, `server/mcp-vfx.js`,
`docs/VFX_SPEC.md`.

#### Left behind, and why

Base-only, in this range — research apparatus and its write-ups, none of which
the fork's product surface touches:

- `scripts/vace_run.mjs`, `scripts/vace_saturation.py` — the VACE arm and its calibrator
- `scripts/film_run.mjs`, `scripts/mv_run.mjs`, `scripts/shots_anomaly.mjs`
- `scripts/h3_bleed.py`, `scripts/h3_ressweep.mjs`, `scripts/ressweep_score.py`, `scripts/ressweep_table.py`
- `docs/H3_REFERENCE_BLEED.md`, `docs/MV_MEASURE_TWICE.md`, `docs/RESOLUTION_FOR_FACES.md`, `docs/SHORTFILM_ANOMALY.md`

Base-only, from *before* P and still unported for the same reason:
`NIGHT_QUEUE.md`, `scripts/gate_run.mjs`, `scripts/gate_lib.mjs`,
`scripts/gate_block.py`, `scripts/gate_score.py`.

#### ⚠ Two files in the range that are NOT VFX and were NOT ported

Both are outside the four port paths **and** outside this strand's edit mandate.
They are recorded here so the next port does not rediscover them:

1. **`server/mcp-vfx_test.js`** — base added one line, `vfx_camera_move: "*"`, to
   its `IGNORED` map (the tool spreads its arguments wholesale, so no parameter
   name appears individually in `run()`). Without it the fork's copy fails:
   `FAIL every declared parameter is named in its run()`, naming all 22
   `vfx_camera_move` parameters. **The ported code is correct** — the fork's
   `vfx_camera_move` is byte-identical to the base's. Only the prover's ignore
   list is stale. The fork's copy of this file is itself fork-specific (it
   carries the piano-profile parity/honesty rules), so it needs a human hand.

2. **`server/workflow.js`** — base commit `4287ce9` makes `videoSizeFor()` admit
   that H3 quantises. It used to return `quantised:false, grid:1` for H3 while
   `MiniMaxH3ReferenceToVideo` floors each axis to a multiple of 16, so a
   requested 1664x936 was delivered as 1664x928. This is the 544 incident one
   engine over, and it bears on the fork (`server/mv/clipDuration.js` reads the
   local rule out of `../workflow.js`). Workflow strand's call, not this one's.

#### Suites run in the fork after the port

All green except the one noted above.

| Suite | Result |
|---|---|
| `server/vfx/*_test.js` (cachekey, camera, camera_moves, routes, routes_ram, store, templates, ui) | 19 / 80 / 61 / 20 / 36 / 211 / 66 / 19 passed, 0 failed |
| `server/vfx/*_test.py` (colour, engine, effects, lights, notes, audiokeys, shapes, particles, tracker, expressions, expressions_engine, integration) | 40 / 390 / 398 / 153 / 42 / 65 / 117 / 17 / 64 / 242 / 92 / 33 passed, 0 failed |
| `node --check web/vfx.js` | OK |
| `scripts/trace_load.mjs` | OK — no top-level throw |
| `server/mcp-vfx_test.js` | **89 passed, 1 failed** — the stale `IGNORED` map above |

The fork's VFX parity gate (`server/vfx/ui_test.js`) passed **unchanged**: the
camera and colour controls the base added found every id they needed in the
fork's `web/index.html`. No edit to that file was required.

---

## The fork's own VFX divergences

These are fork-side and deliberate. They are **not** drift to be reconciled away
— a port that removes one has failed. All three survived `6db939c..7cfde96`.

### 1. `server/vfx/notes.py` — the `piano` profile

A `"piano": dict(min_note_ms=45.0, fmin=27.5, fmax=4186.0, vel_gate=0.15)` entry
beside `guitar` and `bass`. The piano *rig* had existed in `mcp-vfx.js` all along
with no profile to feed it, so a piano had to be transcribed as a guitar, which
cannot hear the bottom octave and a half. The file's own comment is explicit that
these thresholds are **reasoned, not swept** — one real song, 693 notes against
the guitar profile's 526, with key-coherence unchanged at 92% as the check that
the extra notes are real.

### 2. `server/vfx/routes.js` — four hunks

- `STEM_PARTS` + `stemPath()` — a stem addressed as a *part of a song*
  (`{file, stem:"other"}`) rather than as a path, because `safe()` reduces any
  input to a basename and every song's stems share four names.
- `b.stem` handling in the audio-source resolver.
- `NOTE_PROFILES` — the third copy of the profile list, and the one that actually
  refuses a request. Adding piano to `notes.py` and `mcp-vfx.js` alone left this
  one rejecting it.
- Render provenance via the optional `deps.rememberClip` — stamps `source:"vfx"`,
  comp slug and MEDIA `clipSeconds` so a render is a first-class library citizen.
  (FORK_DELTA row 19.)

### 3. `server/mcp-vfx.js` — three additions

- The ten-line pipeline-stage pointer in the header comment (FORK_DELTA row 17).
- `"piano"` in the `profile` enum of `vfx_audio_notes` and `vfx_instrument_rig`.
- `camera`, `width`, `height`, `animators` declared on `vfx_add_layer` — the
  route had always read them, but `additionalProperties: false` turned the
  omission into a refusal. The `camera` one has teeth: without `pointOfInterest`
  a camera is placed but never aimed.

`server/mcp-vfx_test.js` also diverges (it proves the piano profile's parity with
`notes.py` and `routes.js`, and that the description admits the thresholds are
unswept), but that file is outside this strand's mandate — see above.
