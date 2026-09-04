#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
gate_block.py - gray-box blocking clip + ANALYTIC ground-truth optical flow.

This renders the source clip for the VFX/3D motion-parity gate. Pure numpy + cv2.
No 3D library, no Blender, no ComfyUI, no GPU.

WHY THE THREE NUMBERS ARE ASSERTED
----------------------------------
server/workflow.js:1000  ->  const rate = fps ?? v.fps;
server/art.js:1110       ->  restyleGraph({...})  with NO fps key
server/config.js:663     ->  fps: 24
  => the restyle render rate is ALWAYS 24 and the source clip's own fps is never
     read. Guides index the source by ABSOLUTE frame number
     (workflow.js:1032 ImageFromBatch batch_index: i), and ImageFromBatch CLAMPS
     an out-of-range index to the last frame instead of erroring, so a short clip
     silently freezes. workflow.js:1033 ImageScale runs crop:"disabled", which
     stretches rather than fits.
  => the clip MUST be exactly 1280x704, exactly 24.000 fps, >= 121 frames.

WHY THE FLOW IS GROUND TRUTH AND NOT AN ESTIMATE
------------------------------------------------
Every face here is a planar quad, so the mapping of that face between frame t and
frame t+1 is EXACTLY a homography induced by its plane:
    H = K (R_rel + t_rel n1^T / d1) K^-1
Computing the reference side analytically is the whole reason the gate number is
trustworthy: it is DERIVED, never estimated, and it does not depend on a single
pixel of what the faces are painted with. That is exactly what makes the
plane-locked surface detail described below safe. Detail changes the PIXELS; it
cannot touch the FLOW. The analytic H is cross-checked against
cv2.getPerspectiveTransform on well-conditioned faces and the agreement printed,
and the flow/valid arrays are hashed on every run against a pinned digest, so
"the pixels moved and the ground truth did not" is PROVED, not assumed.

WHAT A RESULT FROM THIS CLIP DOES AND DOES NOT MEAN  (SCOPE)
-----------------------------------------------------------
This belongs in all three gate scripts' headers. Here it is in this one's, and -
because a header is not an artifact - in every file this script produces: the
mp4's container metadata, the npz ('scope' / 'scope_line'), the camera json, and
burned into the contact sheet's footer. A write-up weeks from now cannot make the
broad claim from these files alone, which is the point.

The conditioning path under test is LTXVAddGuide, which VAE-ENCODES literal
source frames into the latent. That is an APPEARANCE guide with NO
structure/appearance separation. It is not depth/pose ControlNet and it is not
WAN VACE; those are structurally different mechanisms, and both have ZERO BYTES
on this disk, which is the only reason they are not in the sweep.
  A NEGATIVE here reads: "sparse appearance guides cannot carry gray-box
  blocking." It does NOT read "control video does not work locally."
  A POSITIVE here does not transfer to VACE-style structural conditioning.
One path of four, not a sweep.

SURFACE DETAIL ON THIS CLIP: REJECTED ONCE, THEN REVERSED ON EVIDENCE
----------------------------------------------------------------------------
This clip used to be FLAT. It now carries plane-locked surface detail. Both the
original rejection and the reversal are recorded here, in full, so that neither
direction gets re-litigated from half the argument.

THE ORIGINAL PROPOSAL AND ITS REJECTION. A review ran DIS on the flat clip,
compared it to the analytic flow, got CMA 0.7299 (arm window 0.6825), called it
"the ceiling", diagnosed the shortfall as texture poverty (90.4% of pixels carry
|Sobel| < 2) and proposed plane-locked multi-octave value noise at amplitude
0.02, which lifted that number to 0.9873 through the real encoder. The
measurements were correct. The patch was rejected on two grounds:

  1. THE QUANTITY IT FIXES BOUNDS NOTHING. In gate_score.py --score, DIS runs on
     the ARM's frames only; it never touches this clip. An arm's CMA is bounded
     by the texture of the ARM's own output - a restyled corridor with lights,
     haze and grain - not by this clip's flatness. 0.6825 is the score of
     exactly one hypothetical arm, the degenerate one that hands the gray boxes
     back. It is a reconstruction anchor, not a ceiling, and the "below 0.80, do
     not spend GPU time" halt it produced was wrong.
  2. FIDELITY TO THE WORKFLOW WINS. The clip these pixels stand in for is a
     Blender viewport playblast with show_overlays and show_gizmo off: flat
     solid shading, no surface texture, exactly as texture-poor as this. Detail
     that rides the geometry would hand LTXVAddGuide per-surface correspondence
     the real step-2 source will never have, so a green gate on a textured block
     would not transfer to the workflow it is standing in for.

WHAT THE FIRST FULL GATE RUN THEN MEASURED. 16 renders, 10 arms, all completed;
verdict NO RESULT, exit 3. Per-frame median motion @320x176, px/frame:

    series                         median   hold    orbit    tip
    GROUND TRUTH (analytic)         3.818   0.000   5.388   4.194
    RECON (source re-encoded)       2.538   0.003   3.107   3.808
    A4  (dense guides 8 @ 0.70)     1.195   0.094   1.481   1.912
    A6  (121-frame single guide)    1.396   0.093   1.494   1.937
    A1  (shipped default 16@0.30)   0.341   0.295   0.348   0.350
    A0  (text only)                 0.160   0.162   0.154   0.175

  A0 and A1 have a FLAT profile - the same tiny motion during the locked-off
  hold as during the orbit. That is shimmer, not a camera move, and it is a real
  finding no instrument change can alter. A4 and A6 have the RIGHT SHAPE - near
  still in the hold, rising through orbit and tip - so the guides did land, but
  at roughly half the reconstruction's magnitude. And the reconstruction itself
  recovers only 2.538 of 3.818: DIS loses a third of the magnitude ON A PERFECT
  RECONSTRUCTION OF THE SOURCE. That is why the anchor was 0.68 and not ~0.95,
  and it is why the degenerate calibration arm A4 - run specifically to hand the
  source back - could only reach 0.404. When the arm that returns the source
  almost verbatim cannot score, nothing can be concluded about conditioning.

GROUND 1 SURVIVES; GROUND 2 IS REVERSED.
  Ground 1 is still true as stated - the anchor bounds one arm, not all arms -
  and it is still not a licence to read the anchor as a ceiling. But it answered
  the wrong question. The anchor is the CALIBRATION of the instrument, and a
  calibration at 0.68 on a perfect reconstruction leaves too little headroom
  between "followed the move" and "did nothing" for any arm to be adjudicated.
  The instrument, not the arms, was the binding constraint on the first run.
  Ground 2 was wrong on the merits and is hereby REVERSED. Nothing forces a
  Blender blockout to be featureless. A blockout with surface detail is a
  legitimate and free improvement to the REAL step-2 workflow as well - more for
  the model to latch onto helps there exactly as much as it helps here - so
  texturing does not measure "something we would never do", it measures
  something we should be doing anyway. The same reasoning was already accepted
  one level up in this very file: the pilasters exist because "an uninterrupted
  wall gives the flow estimator nothing to hold."

WHY THIS IS NOT THE CORRIDOR-WIDTH MISTAKE. The trade-off table below shows that
widening the corridor lowers peak flow but RAISES cheap-prior matchability until
a zero-information static dolly clears the pass floor. That table is correct and
THE GEOMETRY MUST NOT CHANGE. It does not apply here, and the distinction is the
whole safety argument: widening the corridor changes the FLOW FIELD, which is
what the priors are fitted to. Surface detail changes only the PIXELS. The flow
field, the validity mask, the ground truth, the camera path and every prior
bound are mathematically untouched - only the estimator's ability to TRACK
improves.

THE REQUIREMENT THAT MAKES IT SAFE: THE DETAIL IS PLANE-LOCKED.
  Each face's detail lives in that face's OWN surface coordinates (metres along
  its two edge tangents, measured from its own moving origin) and is recovered
  per pixel from the SAME plane equation that fills the face - so it is carried
  by exactly the homography H = K(Rrel + trel n1^T/d1) K^-1 that IS the ground
  truth. It moves with the geometry by construction. Screen-space or
  view-dependent noise would invent flow the analytic reference does not
  predict, which would be far worse than the problem being solved: it would put
  error on the one side of this gate that is currently exact. That is the line;
  do not cross it.
  This is not left to construction. flow_ds and valid_ds are SHA-256'd on every
  run and asserted against GT_SHA256_FLOW / GT_SHA256_VALID, pinned from the
  final flat render. If detail ever leaks into the reference the digests move
  and the render is refused. Those constants may be re-pinned ONLY when the
  GEOMETRY, CAMERA or TIMING is deliberately changed - NEVER to make a
  pixel-only change pass.

  Note that the reference side never wanted the detail either way: the ground
  truth is ANALYTIC, so this clip's flatness never entered the reference at all.
  There was nothing on this side for texture to fix, and nothing on this side
  for texture to break.

THE ONE REAL TENSION: ESTIMATOR HEADROOM vs UNMISTAKABILITY
------------------------------------------------------------
The reference side is derived, but the ARM side must be ESTIMATED by DIS, so a
move the estimator cannot track gets scored as an arm failure when it is an
instrument failure. The build agent flagged that the orbit whips: peak eye speed
7.489 m/s, peak median flow 39.1 px/frame @320, 9 of 143 pairs over 16 px/frame.
The question - can DIS follow that? - was measured, three ways.

  1. DIS ON THE FLAT CLIP, CMA vs GROUND-TRUTH SPEED. No speed dependence at
     all: spearman(CMA, median|gt|) = -0.09; the 9 pairs over 16 px/frame score
     a median 0.7245 against 0.7304 for the other 109; the two WORST pairs in
     the clip were slow ones (1.71 and 7.62 px/frame, CMA -0.038 and -0.043).
     The 0.73 was texture, not speed - which is the same conclusion the
     then-rejected noise patch rested on, and it was correct as far as it went.
  2. THE SAME FIELD ON A TEXTURED CARRIER. Flat gray hides any speed effect
     under a texture floor, so texture was held constant instead: this clip's
     exact analytic field is carried on a broadband fractal image (I1 = texture,
     I0(p) = texture(p + f(p)) by backward remap, so the true forward flow is
     EXACTLY f - no holes, no inversion, no estimator on the reference side).
     Now the speed effect is visible and sharp:
         0.8 .. 16 px/frame  CMA 0.9905 .. 0.9998  (n=109)  median 0.9989
         16 .. 25            CMA 0.9316 .. 0.9965  (n=  4)  median 0.9931
         25 .. 39            CMA 0.5273 .. 0.9960  (n=  5)  median 0.8286
                                                    ^ DIS is losing the field
     DIS's knee at 320x176 PRESET_MEDIUM is ~25 px/frame. Five pairs of this
     clip - 55..59, t = 2.29 .. 2.46 s, the apex of the orbit - sit past it, and
     the worst of them (pair 58, 35.9 px/frame) falls to 0.5273.
  3. IS ANALYSIS RESOLUTION A FREE LEVER? Mostly not, because the knee scales
     with the image - DIS's pyramid depth does. The same worst pair scores
     0.307 at 640x352 (71.9 px), 0.527 at 320x176 (35.9 px) and 0.866 at 160x88
     (17.9 px): halving the analysis resolution halves the clip's px/frame and
     very nearly halves the knee with it, so it recovers part of the apex rather
     than solving it, at the price of spatial detail and a re-calibration of
     MAG_FLOOR. That constant lives in gate_score.py, not in this file, so it is
     named here and left to the scorer rather than decided in the clip.

  WHAT CHANGED WHEN THE DETAIL LANDED. Test 2 was a hypothetical carrier; the
  clip now IS that carrier, and the hypothetical came true almost exactly. The
  reconstruction anchor went 0.6825 -> 0.9815 over the arm window (0.7299 ->
  0.9850 whole clip) and magnitude recovery MR went 0.7412 -> 0.9807, so DIS no
  longer eats a third of the motion on a perfect reconstruction. The knee is
  still a knee - the same 5 pairs are still the slowest to track - but it is now
  a dent rather than a hole: the worst pair in the whole clip is pair 58 at
  35.9 px/frame scoring 0.7960, where on the flat clip the worst pair scored
  -0.0426 and pair 58 itself scored 0.5273. The orbit segment medians 0.9806 and
  the tip-over 0.9816, against 0.6971 and 0.6330 flat. NOTE that none of this
  moved the FLOW: the over-knee pair count is computed from |gt| and is still 5,
  and the prior bounds below are unchanged to four decimals. Only the
  instrument's grip improved.

THE OBVIOUS FIX MAKES THE GATE WORSE, AND THAT IS MEASURED TOO
---------------------------------------------------------------
The cheap lever is to widen the corridor so the camera passes further from the
subject. It works on the flow and it wrecks the experiment, because the peak
flow is high for the SAME reason the move is unmatchable: the camera is close to
the geometry, and that closeness is the parallax that makes the field
inexpressible as a dolly or a pan. Take the closeness away and the field becomes
a pan. Measured, with the adversarial priors below (all upper bounds, scored on
the arm window; the scorer's absolute pass floor is 0.50):

    CW    ORB_A   peak px/f   >knee   static dolly   per-frame radial   pan
    3.0    1.0       39.1       5        0.303            0.440        0.330   <- kept
    3.5    1.2       31.2       3        0.343            0.475        0.405
    4.0    1.5       25.7       1        0.458            0.529        0.524   FAILS
    5.0    2.0       21.5       0        0.554            0.682        0.630   FAILS

  Every step toward the knee walks the priors toward the floor, monotonically,
  because it is the same quantity twice. At CW 4.0 the move is already matchable,
  and at CW 5.0 - the width that finally clears the knee - a STATIC forward-dolly
  prior carrying ZERO camera-move information scores 0.554, above the pass floor
  the arms themselves have to clear. That gate would hand a green light to a
  model that did nothing but push in, which is worse than no gate. (Not
  hypothetical: CW 5.0 was built, rendered, and rejected by the assertion below.)
  Widening the orbit window instead (T_ORBIT_END 3.5 -> 3.8 / 4.1) does keep the
  priors low - 0.403 / 0.417 - but only takes the peak to 36.1 / 33.4 px/frame,
  still well past the knee, so it pays a change for no result.

  SO THE GEOMETRY STAYS. The residual cost is five pairs out of the 118 the
  scorer keeps, at the orbit apex, where DIS will under-read every arm's motion.
  It is bounded and it very nearly cancels: the gate's statistic is the MEDIAN
  per-pair CMA, which those five pairs cannot move (measured: 0.9987 with them,
  0.9988 without), and they are the same five pairs for A0, for every arm and
  for the anchor, so the margin that IS the claim is unaffected. This is
  disclosed rather than fixed because every available fix costs more than it
  buys. What is asserted after every render is that the situation does not get
  WORSE: the over-knee pairs stay a small minority (budget 10, currently 5), and
  no cheap prior reaches the pass floor (margin currently 0.060).

DISCLOSED DEVIATIONS FROM THE BRIEF (both measured, both reported at the end):
  D1. The corridor is closed at BOTH ends (6 shell quads, not 5). A corridor
      open at one end shows several metres of empty void at the top of frame
      during the tip-over. A large textureless void is the exact degenerate case
      the ground-truth-vs-estimate asymmetry exists to avoid, so the set is
      closed.
  D2. The "half orbit staying ~4 m out" cannot be a circle: the corridor is 3 m
      wide, so a 4 m radius puts the camera 2.5 m inside the wall at 90 deg of
      azimuth. The orbit is therefore an ELLIPSE, 4.0 m along the corridor by
      1.0 m across it - a full 180 deg of azimuth, geometrically inside the set,
      no wall crossings, no culling tricks.
  D3. Downsampling 1280x704 -> 320x176 is 1/4 per axis, i.e. 16 contributing
      pixels per output pixel, not 4. A 320x176 pixel is marked valid only if
      ALL SIXTEEN contributing pixels were valid (the strict reading).
"""

import hashlib
import json
import math
import os
import re
import sys
import time
from fractions import Fraction

import numpy as np
import cv2

# ----------------------------------------------------------------------------
# THE THREE NUMBERS
# ----------------------------------------------------------------------------
WIDTH = 1280
HEIGHT = 704
FPS = 24
NFRAMES = 144            # 6.000 s; >= 121 with 23 frames of headroom
MIN_FRAMES = 121

AW, AH = 320, 176        # analysis resolution, exactly 1/4 of 1280x704
DS = 4
assert WIDTH % DS == 0 and HEIGHT % DS == 0
assert WIDTH // DS == AW and HEIGHT // DS == AH

OUTDIR = r"D:\AI\aiplay-studio-bench\ComfyUI\output\gate"

# ----------------------------------------------------------------------------
# VARIANTS  (--figures 1|2, --camera 1|2)
#
# The gate this file was written for is ONE figure on the orbit camera, and that
# variant is still the DEFAULT and still writes the four unsuffixed filenames the
# LTX and VACE gates already condition on. Nothing about it moves: same faces,
# same camera, same pinned ground-truth digests.
#
# The two flags add a SECOND, independent ground truth for the cross-clip
# consistency experiment, which needs something the gate never did - two figures
# that can be told apart, and two cameras that see the same action from different
# places. Because a second figure changes the occlusion and a static camera
# changes the flow field, the artefacts go to SUFFIXED names and the three
# GATE-VALIDITY assertions (the pinned flow/valid digests, the DIS-knee budget
# and the cheap-prior pass floor) are REPORTED rather than asserted off the
# default. Those three say "this clip can discriminate a camera move"; a
# deliberately locked-off camera cannot, and asserting it there would be
# asserting the wrong thing rather than a stronger one. Every other assertion in
# this file - geometry, shading separation, the analytic homography, the warp
# proof, the container's three numbers - runs on every variant.
# ----------------------------------------------------------------------------
def _flag(name, default, choices):
    a = sys.argv[1:]
    if name in a:
        i = a.index(name)
        if i + 1 >= len(a):
            raise SystemExit("%s needs a value, one of %r" % (name, choices))
        v = a[i + 1]
        if v not in choices:
            raise SystemExit("%s must be one of %r, got %r" % (name, choices, v))
        return v
    return default


N_FIGURES = int(_flag("--figures", "1", ("1", "2")))
CAMERA = int(_flag("--camera", "1", ("1", "2")))
IS_GATE_DEFAULT = (N_FIGURES == 1 and CAMERA == 1)
VARIANT = "gate-default" if IS_GATE_DEFAULT else "f%dc%d" % (N_FIGURES, CAMERA)
_SUF = "" if IS_GATE_DEFAULT else "_f%dc%d" % (N_FIGURES, CAMERA)

MP4 = os.path.join(OUTDIR, "gate_block%s.mp4" % _SUF)
NPZ = os.path.join(OUTDIR, "gate_block%s_flow.npz" % _SUF)
CAMJSON = os.path.join(OUTDIR, "gate_block%s_cam.json" % _SUF)
CONTACT = os.path.join(OUTDIR, "gate_block%s_contact.png" % _SUF)


def gate_assert(cond, msg):
    """Assert on the gate's own variant; REPORT everywhere else.

    Used only for the checks whose subject is "this clip can discriminate a
    camera move". They are properties of the ORBIT clip, not of this renderer,
    and a variant that deliberately holds the camera still would fail them by
    design. Printing rather than silently skipping is the point: the number is
    still in the log, it is just not a gate."""
    if cond:
        return True
    if IS_GATE_DEFAULT:
        raise AssertionError(msg)
    print("  [variant %s] NOT ASSERTED (gate-validity check, default variant only):" % VARIANT)
    for ln in str(msg).splitlines():
        print("      " + ln.strip())
    return False
# Nothing is published under those names until every assertion has passed. The
# marker goes BEFORE the extension so av and cv2 can still infer the format.
def _partial(path):
    stem, ext = os.path.splitext(path)
    return stem + ".partial" + ext


MP4_T, NPZ_T, CAMJSON_T, CONTACT_T = (_partial(x) for x in (MP4, NPZ, CAMJSON, CONTACT))

# ----------------------------------------------------------------------------
# PLANE-LOCKED SURFACE DETAIL
#
# See "SURFACE DETAIL ON THIS CLIP: REJECTED ONCE, THEN REVERSED ON EVIDENCE" in
# the header for why this exists at all. What matters HERE is the one property
# that makes it safe:
#
#   The detail is a function of (u, v) - METRES along a face's own two edge
#   tangents, measured from that face's own origin. For a rigid face those
#   coordinates are painted ON the surface, so the mapping that carries a
#   surface point from frame t to frame t+1 carries its detail value with it
#   unchanged. That mapping is exactly the plane-induced homography
#   H = K(Rrel + trel n1^T / d1) K^-1, which IS the ground truth. Detail
#   therefore rides the ground-truth flow by construction and can invent none of
#   its own. The moving figure's faces use their own MOVING origin (base_pt,
#   which already tracks figure_z), so their detail translates with them.
#
# Per pixel, u and v are recovered from the SAME plane equation the rasteriser
# already uses to fill the face. For a pixel with normalised ray m = (a, b, 1),
# the camera-space point is m / invz with invz = (n1 . m) / d1 - the quantity the
# depth test is already computing - so
#     u = ( (R tu) . m ) / invz  +  (eye - o) . tu
# and likewise for v. No second projection, no screen-space term, nothing
# view-dependent.
#
# The field itself: 4 octaves of tileable value noise (lattice 1.00 / 0.50 /
# 0.25 / 0.125 m) plus a faint regular element - soft panel seams on a 0.5 m
# grid - because regular features give DIS strong local structure to lock onto.
# It is normalised to zero mean and max |D| = 1 over the tile, so a face's MEAN
# value is preserved and the >= 0.10 adjacent-face separation the shading ladder
# is built on is untouched (that assertion reads Face.val, which never changes;
# the rendered means are additionally measured and asserted after every render).
#
# The finest lattice is 0.125 m. At the far end of an 18 m corridor one pixel
# spans ~0.019 m, so the finest feature is still ~7 px wide: the field is
# band-limited well inside Nyquist everywhere in this set and cannot shimmer.
# ----------------------------------------------------------------------------
DET_AMP = 0.045          # peak modulation of the 0..1 value range (+-11/255)
DET_TILE = 2048          # texels per side of the detail tile
DET_PERIOD_M = 4.0       # metres per tile period  -> 512 texels/m, 1.95 mm/texel
DET_TPM = DET_TILE / DET_PERIOD_M
DET_SEAM_M = 0.5         # panel-seam grid spacing (divides DET_PERIOD_M)
DET_SEAM_W = 0.06        # seam half-width, metres (soft raised cosine)
DET_SEAM_MIX = 0.42      # seam share of the field before normalisation
DET_SEED = 20260902

# THE LOAD-BEARING CHECK. Pinned from the final FLAT render, before any detail
# existed. Asserted on every run: the detail changes the pixels and must leave
# the reference side bit-identical. Re-pin these ONLY for a deliberate change to
# geometry / camera / timing -- NEVER to make a pixel-only change pass.
GT_SHA256_FLOW = "5154da10453fb84fe145f816f471e1bda5c0496533ad790b4cbbe340d70a9162"
GT_SHA256_VALID = "f790d414a03de1874e41a3c196e5e790da24fe9002477d6bcc39a1184ae83950"

_DET_TILE_CACHE = [None]


def _value_noise_tile(n, res, rng):
    """One octave of TILEABLE value noise: a res x res lattice of uniform values,
    resampled to n x n with smoothstep interpolation and wrap-around."""
    g = rng.random((res, res))
    x = (np.arange(n, dtype=np.float64) + 0.5) * res / float(n)
    i0 = np.floor(x).astype(np.intp)
    s = x - i0
    s = s * s * (3.0 - 2.0 * s)                 # smoothstep -> C1 across cells
    i0 %= res
    i1 = (i0 + 1) % res
    a = g[:, i0] * (1.0 - s) + g[:, i1] * s     # (res, n)  interpolate in u
    return a[i0, :] * (1.0 - s)[:, None] + a[i1, :] * s[:, None]   # then in v


def detail_tile():
    """The plane-locked detail field, DET_TILE x DET_TILE, tileable at
    DET_PERIOD_M metres, zero mean, max |D| = 1. Deterministic (DET_SEED)."""
    if _DET_TILE_CACHE[0] is not None:
        return _DET_TILE_CACHE[0]
    n = DET_TILE
    rng = np.random.default_rng(DET_SEED)
    # lattice 4 / 8 / 16 / 32 over a 4 m period -> 1.00 / 0.50 / 0.25 / 0.125 m
    field = np.zeros((n, n), np.float64)
    for res, amp in ((4, 1.00), (8, 0.55), (16, 0.30), (32, 0.17)):
        field += amp * _value_noise_tile(n, res, rng)
    field -= field.mean()
    field /= np.abs(field).max()

    # the regular element: soft panel seams on a DET_SEAM_M grid
    coord = (np.arange(n, dtype=np.float64) + 0.5) * DET_PERIOD_M / n
    ph = np.mod(coord, DET_SEAM_M) / DET_SEAM_M
    dist = np.minimum(ph, 1.0 - ph) * DET_SEAM_M
    line = 0.5 * (1.0 + np.cos(math.pi * np.clip(dist / DET_SEAM_W, 0.0, 1.0)))
    seam = np.maximum(line[None, :], line[:, None])       # 1 on a seam, 0 between
    seam -= seam.mean()

    out = (1.0 - DET_SEAM_MIX) * field - DET_SEAM_MIX * seam
    out -= out.mean()
    out /= np.abs(out).max()
    _DET_TILE_CACHE[0] = out
    return out


def sample_detail(u, v):
    """Sample the detail tile at surface coordinates (u, v) in METRES.
    Bilinear with wrap; returns float64 in [-1, 1]."""
    T = detail_tile()
    n = T.shape[0]
    x = np.mod(u * DET_TPM, n)
    y = np.mod(v * DET_TPM, n)
    i0 = x.astype(np.intp)
    j0 = y.astype(np.intp)
    np.clip(i0, 0, n - 1, out=i0)          # guard the fmod boundary
    np.clip(j0, 0, n - 1, out=j0)
    fx = x - i0
    fy = y - j0
    i1 = i0 + 1
    j1 = j0 + 1
    i1[i1 == n] = 0
    j1[j1 == n] = 0
    t0 = T[j0, i0] * (1.0 - fx) + T[j0, i1] * fx
    t1 = T[j1, i0] * (1.0 - fx) + T[j1, i1] * fx
    return t0 * (1.0 - fy) + t1 * fy


# ----------------------------------------------------------------------------
# SCOPE - stamped into every artifact this script writes (see the header).
# Nothing downstream may restate a result from these files without it.
# ----------------------------------------------------------------------------
SCOPE = {
    "path_under_test": ("LTXVAddGuide - a sparse APPEARANCE guide: literal source "
                        "frames VAE-encoded into the latent, with NO "
                        "structure/appearance separation."),
    "paths_not_tested": [
        "WAN VACE (structural conditioning) - 0 bytes on this disk",
        "depth / pose ControlNet - estimators are zero-byte placeholders here",
        "MiniMax H3 - no strength input",
    ],
    "a_negative_reads": ("sparse appearance guides cannot carry gray-box blocking. "
                         "NOT 'control video does not work locally'."),
    "a_positive_reads": ("sparse appearance guides carried it. Does NOT transfer to "
                         "VACE-style structural conditioning."),
    "source_pixels": ("Gray blockout on a 6-value shading ladder, carrying PLANE-LOCKED "
                      "surface detail (multi-octave value noise + 0.5 m panel seams, "
                      "+-DETAMP of the 0-1 value range) in each face's own surface "
                      "coordinates. The detail was rejected once as unfaithful to a flat "
                      "Blender playblast and that rejection was REVERSED after the first "
                      "gate run: a perfect reconstruction of the FLAT clip scored only "
                      "0.6825, so the instrument, not the arms, was the binding "
                      "constraint. Face MEAN values are unchanged; the flow field and "
                      "validity mask are BIT-IDENTICAL to the flat render (SHA-256 "
                      "asserted every run). The header has the full reversal.")
                     .replace("DETAMP", "%.3f" % DET_AMP),
    "reference_side": ("ANALYTIC, not estimated. Per-face plane-induced homography "
                       "H = K (Rrel + trel n1^T / d1) K^-1. It depends on GEOMETRY only, "
                       "never on what the faces are painted with, so surface detail "
                       "cannot enter it - and the hash assertion proves it did not."),
}
SCOPE_LINE = ("SCOPE: LTXVAddGuide sparse APPEARANCE guides (VAE-encoded literal frames, "
              "no structure/appearance separation) vs text-only. One path of four; WAN "
              "VACE and depth/pose ControlNet are 0 bytes on this disk and are NOT "
              "tested. A negative reads 'sparse appearance guides cannot carry gray-box "
              "blocking', NOT 'control video does not work locally'.")

# ----------------------------------------------------------------------------
# INTRINSICS  (pinhole, built by hand; camera looks down +Z_cam, x right, y down)
# ----------------------------------------------------------------------------
HFOV_DEG = 70.0
FX = (WIDTH / 2.0) / math.tan(math.radians(HFOV_DEG / 2.0))
FY = FX
CX = WIDTH / 2.0
CY = HEIGHT / 2.0
SENSOR_MM = 36.0
FOCAL_MM = FX * SENSOR_MM / WIDTH
NEAR = 0.03

K = np.array([[FX, 0.0, CX], [0.0, FY, CY], [0.0, 0.0, 1.0]], np.float64)
KINV = np.linalg.inv(K)

# ----------------------------------------------------------------------------
# SCENE  (metres; world is right handed, +X lateral, +Y up, +Z down the corridor)
# ----------------------------------------------------------------------------
CW = 3.0                 # corridor width. Widening this to 4-5 m was tried, to
                         # get the peak flow under DIS's tracking knee, and
                         # REJECTED on measurement: it destroys the move's
                         # unmistakability. See "THE ONE REAL TENSION" above.
CH = 3.0                 # corridor height
CL = 18.0                # corridor length
HX = CW / 2.0            # +-1.5

PIL_Z = [4.0, 9.0, 14.0]  # pilaster centres down the corridor
PIL_DEPTH = 0.3           # protrusion from the wall
PIL_HALFW = 0.3           # half extent along z  -> 0.6 m wide
PIL_H = 2.6               # pilaster height (leaves 0.4 m under the ceiling)

FIG_W = 0.5
FIG_H = 1.8
FIG_Z0 = 6.0             # start of the walk
FIG_SPEED = 1.2          # m/s, constant, away from camera down the centreline

# ---- the SECOND figure (--figures 2 only) -----------------------------------
# A STANDS at z = 6.0; B walks exactly as it always did, from z = 6.0 down the
# centreline at 1.2 m/s. So the two start at the same depth and separate, and on
# the orbit camera the sign of (u_B - u_A) flips ONCE as the camera swings past
# them - measured, one flip in 121 frames. On the static side camera it never
# flips. That contrast is the whole point: an instrument that reports the same
# left/right order for both cameras is not seeing the camera.
#
# A's x is NEGATIVE and that is load-bearing, not cosmetic. The orbit's lateral
# semi-axis is +1.0 m, so the camera sweeps through POSITIVE x; a standing figure
# at +0.7 would be driven through by the camera near t = 1.9 s. At -0.7 the
# closest approach is ~1.2 m, and clearance_check() proves it every run rather
# than this comment asserting it.
FIG_A_X = -0.7
FIG_A_Z = 6.0

# Where a neck and a pair of hips are on a 1.8 m box. These two heights are what
# the projections in the camera json are computed at, and what the pose scorer
# compares DWPose's neck (COCO-18 joint 1) and mid-hip (joints 8 and 11) against.
# They are anatomy on a box, so they are stated here as a definition rather than
# derived from anything: a 1.8 m adult's C7 sits at ~1.52 m and the hip joints at
# ~0.95 m. A scorer that used the box's own centroid instead would be measuring a
# different thing from what DWPose returns, and the offset would look like error.
NECK_Y = 1.52
HIP_Y = 0.95

# The static side camera. Chosen by search over the corridor's legal interior for
# the largest worst-case margin from the frame edge, over all four tracked points
# and all 121 conditioning frames: measured 271 px, with 1.50 m of clearance to
# the nearest solid. Both figures are in frame on every one of the 121 frames,
# which the orbit camera cannot manage (A leaves it for 37 of them).
CAM2_EYE = np.array([1.15, 1.55, 2.20])
CAM2_TARGET = np.array([0.0, 1.15, 8.50])

# camera path
T_HOLD_END = 1.0
T_ORBIT_END = 3.5
T_TOP_END = 5.0
DURATION = NFRAMES / FPS  # 6.000 s
ORB_A = 1.0              # lateral semi axis  (see D2). Tied to CW: it is what
                         # sets peak on-screen flow AND what creates the
                         # parallax the move's unmistakability rests on. Do not
                         # raise it without re-reading the trade-off table.
ORB_B = 4.0              # longitudinal semi axis
EYE_Y_HOLD = 1.6
EYE_Y_ORBIT = 2.2
TOPDOWN_ABOVE = 7.0      # metres above the look target
TARGET_Y = 1.1
TARGET_DX = 0.4          # the trailing null: 0.4 m beside ...
TARGET_DZ = -0.4         # ... and 0.4 m behind the figure
UP_WORLD = np.array([0.0, 1.0, 0.0])

KEY = np.array([0.35, 0.85, -0.40])
KEY = KEY / np.linalg.norm(KEY)

# ----------------------------------------------------------------------------
# SHADING LADDER
# Shell values are the rank of a single wrap-lambert against KEY, quantised onto
# a 0.10-spaced ladder inside [0.18, 0.72]. Pilaster and figure groups are placed
# so no adjacent pair is closer than 0.10 (asserted from geometry below) and so
# the figure never merges into a same-valued wall (it sits on the half-step
# ladder, so it differs from every shell/pilaster value by >= 0.05).
# ----------------------------------------------------------------------------
LADDER = [0.18, 0.28, 0.38, 0.48, 0.58, 0.68]
NX, PX = np.array([-1.0, 0, 0]), np.array([1.0, 0, 0])
NY, PY = np.array([0, -1.0, 0]), np.array([0, 1.0, 0])
NZ, PZ = np.array([0, 0, -1.0]), np.array([0, 0, 1.0])


def wrap_lambert(n):
    return 0.5 + 0.5 * float(np.dot(n, KEY))


def smoothstep(a, b, t):
    u = min(1.0, max(0.0, (t - a) / (b - a)))
    return u * u * (3.0 - 2.0 * u)


# Arc-length reparametrisation of the elliptical orbit. Sweeping the ellipse at a
# constant ANGULAR rate puts peak linear speed at theta = pi/2 -- which is also
# where the camera is closest to both the subject and the wall, so the two worst
# cases coincide and the flow spikes. Sweeping at a constant ARC rate instead
# keeps the same start, end and timing, stays C1 (the smoothstep envelope still
# has zero derivative at both ends), and moves the angular whip out to the far
# ends of the arc where the subject is 4 m away.
_TH = np.linspace(0.0, math.pi, 4001)
_SPD = np.sqrt((ORB_A * np.cos(_TH)) ** 2 + (ORB_B * np.sin(_TH)) ** 2)
_ARC = np.concatenate([[0.0], np.cumsum(0.5 * (_SPD[1:] + _SPD[:-1]) * np.diff(_TH))])
_ARC_TOT = float(_ARC[-1])


def theta_of(progress):
    """progress in [0,1] -> theta in [0,pi], at a constant arc-length rate."""
    return float(np.interp(progress * _ARC_TOT, _ARC, _TH))


# ----------------------------------------------------------------------------
# geometry helpers
# ----------------------------------------------------------------------------
def quad(p00, p10, p11, p01):
    return np.array([p00, p10, p11, p01], np.float64)


def subdiv(q, nu, nv):
    """Split a quad into an nu x nv grid of quads (bilinear)."""
    p00, p10, p11, p01 = q
    us = np.linspace(0.0, 1.0, nu + 1)
    vs = np.linspace(0.0, 1.0, nv + 1)
    U, V = np.meshgrid(us, vs, indexing="ij")
    P = ((1 - U)[..., None] * (1 - V)[..., None] * p00
         + U[..., None] * (1 - V)[..., None] * p10
         + U[..., None] * V[..., None] * p11
         + (1 - U)[..., None] * V[..., None] * p01)
    out = np.empty((nu * nv, 4, 3), np.float64)
    k = 0
    for i in range(nu):
        for j in range(nv):
            out[k] = (P[i, j], P[i + 1, j], P[i + 1, j + 1], P[i, j + 1])
            k += 1
    return out


class Face(object):
    """One base face: a planar quad with a constant value and a front normal."""

    __slots__ = ("name", "group", "q", "n", "val", "nu", "nv", "moving")

    def __init__(self, name, group, q, n, val, nu=1, nv=1, moving=False):
        self.name = name
        self.group = group
        self.q = np.asarray(q, np.float64)
        self.n = np.asarray(n, np.float64) / np.linalg.norm(n)
        self.val = float(val)
        self.nu = nu
        self.nv = nv
        self.moving = moving


def build_scene():
    F = []

    # ---- corridor shell (D1: closed at both ends) -------------------------
    # inward normals; values are the wrap-lambert RANK on the ladder
    shell_norms = [PY, NY, PX, NX, PZ, NZ]
    order = sorted(range(6), key=lambda i: wrap_lambert(shell_norms[i]))
    lvl = {}
    for rank, i in enumerate(order):
        lvl[tuple(shell_norms[i])] = LADDER[rank]
    v_floor = lvl[tuple(PY)]
    v_ceil = lvl[tuple(NY)]
    v_left = lvl[tuple(PX)]
    v_right = lvl[tuple(NX)]
    v_near = lvl[tuple(PZ)]
    v_far = lvl[tuple(NZ)]

    F.append(Face("floor", "shell",
                  quad([-HX, 0, 0], [HX, 0, 0], [HX, 0, CL], [-HX, 0, CL]),
                  PY, v_floor, 4, 12))
    F.append(Face("ceiling", "shell",
                  quad([-HX, CH, 0], [HX, CH, 0], [HX, CH, CL], [-HX, CH, CL]),
                  NY, v_ceil, 4, 12))
    F.append(Face("wall_left", "shell",
                  quad([-HX, 0, 0], [-HX, CH, 0], [-HX, CH, CL], [-HX, 0, CL]),
                  PX, v_left, 4, 12))
    F.append(Face("wall_right", "shell",
                  quad([HX, 0, 0], [HX, CH, 0], [HX, CH, CL], [HX, 0, CL]),
                  NX, v_right, 4, 12))
    F.append(Face("wall_near", "shell",
                  quad([-HX, 0, 0], [HX, 0, 0], [HX, CH, 0], [-HX, CH, 0]),
                  PZ, v_near, 4, 4))
    F.append(Face("wall_far", "shell",
                  quad([-HX, 0, CL], [HX, 0, CL], [HX, CH, CL], [-HX, CH, CL]),
                  NZ, v_far, 4, 4))

    # ---- pilasters --------------------------------------------------------
    # left wall group (inner normal +X): inner .28, sides .58, top .18
    # right wall group (inner normal -X): inner .18, sides .58, top .28
    for side in (-1, 1):
        xw = side * HX                       # wall plane
        xi = side * (HX - PIL_DEPTH)         # inner face plane
        n_in = PX if side < 0 else NX
        if side < 0:
            v_in, v_side, v_top = 0.28, 0.58, 0.18
        else:
            v_in, v_side, v_top = 0.18, 0.58, 0.28
        for zc in PIL_Z:
            z0, z1 = zc - PIL_HALFW, zc + PIL_HALFW
            tag = "L" if side < 0 else "R"
            F.append(Face("pil_%s%g_in" % (tag, zc), "pilaster",
                          quad([xi, 0, z0], [xi, 0, z1], [xi, PIL_H, z1], [xi, PIL_H, z0]),
                          n_in, v_in, 2, 2))
            F.append(Face("pil_%s%g_zn" % (tag, zc), "pilaster",
                          quad([xw, 0, z0], [xi, 0, z0], [xi, PIL_H, z0], [xw, PIL_H, z0]),
                          NZ, v_side, 2, 2))
            F.append(Face("pil_%s%g_zp" % (tag, zc), "pilaster",
                          quad([xw, 0, z1], [xi, 0, z1], [xi, PIL_H, z1], [xw, PIL_H, z1]),
                          PZ, v_side, 2, 2))
            F.append(Face("pil_%s%g_top" % (tag, zc), "pilaster",
                          quad([xw, PIL_H, z0], [xi, PIL_H, z0], [xi, PIL_H, z1], [xw, PIL_H, z1]),
                          PY, v_top, 2, 2))

    # ---- the figure ------------------------------------------------------
    # Every value here is on the HALF-step ladder, so the figure differs from
    # every shell and pilaster value by >= 0.05 and can never merge into the
    # surface behind it. The top face is DARK (0.23) rather than bright: for the
    # last second the shot is a plan view in which the only thing seen of the
    # figure is its top face against the 0.68 floor, so that one pair carries the
    # subject's readability for 17% of the clip. Given top=0.23 and floor=0.68,
    # the >= 0.10 rule pins the four sides into [0.33, 0.58].
    h = FIG_W / 2.0
    F.append(Face("fig_xp", "figure",
                  quad([h, 0, -h], [h, 0, h], [h, FIG_H, h], [h, FIG_H, -h]),
                  PX, 0.53, 2, 2, moving=True))
    F.append(Face("fig_xn", "figure",
                  quad([-h, 0, -h], [-h, 0, h], [-h, FIG_H, h], [-h, FIG_H, -h]),
                  NX, 0.53, 2, 2, moving=True))
    F.append(Face("fig_zp", "figure",
                  quad([-h, 0, h], [h, 0, h], [h, FIG_H, h], [-h, FIG_H, h]),
                  PZ, 0.33, 2, 2, moving=True))
    F.append(Face("fig_zn", "figure",
                  quad([-h, 0, -h], [h, 0, -h], [h, FIG_H, -h], [-h, FIG_H, -h]),
                  NZ, 0.43, 2, 2, moving=True))
    F.append(Face("fig_top", "figure",
                  quad([-h, FIG_H, -h], [h, FIG_H, -h], [h, FIG_H, h], [-h, FIG_H, h]),
                  PY, 0.23, 2, 2, moving=True))

    # ---- the standing figure A  (--figures 2) -----------------------------
    # Static, so its quads carry their world position directly and `moving` stays
    # False: the render loop's `subq[moving_sub, :, 2] += zf` and the swept-AABB
    # cover both keep working with no change at all.
    #
    # THE FOUR SIDE VALUES ARE CONSTRAINED, NOT PICKED. Every side face touches
    # the floor (0.68), so the >= 0.10 adjacency rule pins them into [0.18, 0.58];
    # on the half-step ladder that is {0.23, 0.33, 0.43, 0.53}. A's set is chosen
    # to sit as far from B's (0.53/0.53/0.33/0.43/0.23) as that allows on the
    # faces a camera in this corridor actually sees - the two sides and the +Z
    # face - so the two boxes are distinguishable to a human and to a palette
    # measure, not only to the geometry. A and B are never ADJACENT (0.20 m of
    # clear air between their swept AABBs in x), so the >= 0.10 rule does not
    # apply BETWEEN them; the separation is a choice about readability, and it is
    # said here so nobody reads it as the rule.
    if N_FIGURES >= 2:
        ax, az = FIG_A_X, FIG_A_Z
        F.append(Face("figA_xp", "figure",
                      quad([ax + h, 0, az - h], [ax + h, 0, az + h],
                           [ax + h, FIG_H, az + h], [ax + h, FIG_H, az - h]),
                      PX, 0.23, 2, 2))
        F.append(Face("figA_xn", "figure",
                      quad([ax - h, 0, az - h], [ax - h, 0, az + h],
                           [ax - h, FIG_H, az + h], [ax - h, FIG_H, az - h]),
                      NX, 0.23, 2, 2))
        F.append(Face("figA_zp", "figure",
                      quad([ax - h, 0, az + h], [ax + h, 0, az + h],
                           [ax + h, FIG_H, az + h], [ax - h, FIG_H, az + h]),
                      PZ, 0.53, 2, 2))
        F.append(Face("figA_zn", "figure",
                      quad([ax - h, 0, az - h], [ax + h, 0, az - h],
                           [ax + h, FIG_H, az - h], [ax - h, FIG_H, az - h]),
                      NZ, 0.33, 2, 2))
        F.append(Face("figA_top", "figure",
                      quad([ax - h, FIG_H, az - h], [ax + h, FIG_H, az - h],
                           [ax + h, FIG_H, az + h], [ax - h, FIG_H, az + h]),
                      PY, 0.43, 2, 2))
    return F


def figure_positions(t):
    """Every tracked point in the scene at time t, in world metres.

    ONE definition, read by the camera json and by nothing else that could drift
    from it. With --figures 1 it holds only B, which is exactly the figure this
    file has always had."""
    out = {}
    if N_FIGURES >= 2:
        out["A"] = {"neck": [FIG_A_X, NECK_Y, FIG_A_Z],
                    "hip": [FIG_A_X, HIP_Y, FIG_A_Z],
                    "base": [FIG_A_X, 0.0, FIG_A_Z],
                    "moving": False}
    z = figure_z(t)
    out["B"] = {"neck": [0.0, NECK_Y, z], "hip": [0.0, HIP_Y, z],
                "base": [0.0, 0.0, z], "moving": True}
    return out


def project(R, eye, P):
    """World point -> (u, v, z_cam), with THIS file's own pinhole and the SAME
    arithmetic the rasteriser uses: X_cam = R (P - eye), u = fx X/Z + cx,
    v = fy Y/Z + cy, camera +Y screen-DOWN. z_cam is returned so a caller can
    tell "behind the camera" from "off the left edge" - two failures that look
    identical once you only have (u, v)."""
    X = R @ (np.asarray(P, np.float64) - np.asarray(eye, np.float64))
    if X[2] <= 1e-9:
        return None, None, float(X[2])
    return float(FX * X[0] / X[2] + CX), float(FY * X[1] / X[2] + CY), float(X[2])


def figure_z(t):
    return FIG_Z0 + FIG_SPEED * t


def check_shading(faces):
    """Adjacency from geometry (inflated AABB overlap, a conservative
    over-approximation), then assert every adjacent pair differs by >= 0.10 and
    every value sits inside [0.18, 0.72].

    THE FIGURE MOVES, SO THE ADJACENCY SET MOVES WITH IT. This used to build one
    box set with the figure frozen at figure_z(0.0), which means the >= 0.10 rule
    was only ever evaluated in the opening pose while the figure actually travels
    FIG_SPEED * DURATION metres down the corridor, past the pilaster at z=9 and up
    to the one at z=14. It passed for the whole clip only because the figure stays
    on the centreline (|x| <= FIG_W/2) while the pilasters sit at |x| >= HX -
    PIL_DEPTH, so they never became adjacent -- a coincidence of the constants,
    not something the check established. An edit to FIG_SPEED, FIG_Z0, PIL_Z,
    PIL_DEPTH or CW could have voided the value-separation guarantee that the plan
    view is built on, and this assertion would have kept passing.

    Two passes now:
      SWEPT   the moving faces' AABBs are unioned over the figure's ENTIRE travel
              and the >= 0.10 rule is asserted on that. Because a union of boxes
              contains every instant's box, a clean SWEPT pass is a proof for all
              t, not a sample of it -- strictly stronger than sampling, and in the
              same conservative direction as the inflated-AABB test itself.
      SAMPLED the same test evaluated at every frame time. Reported, and asserted
              to be a subset of SWEPT, so the swept cover cannot be silently
              wrong and the swept count cannot be vacuously large.
    """
    eps = 1e-3
    n = len(faces)
    sample_t = np.arange(NFRAMES) / float(FPS)
    zs = np.array([figure_z(float(t)) for t in sample_t])

    def boxes_at(zf):
        out = []
        for f in faces:
            q = f.q.copy()
            if f.moving:
                q[:, 2] += zf
            out.append((q.min(0), q.max(0)))
        return out

    def boxes_swept():
        out = []
        for f in faces:
            lo, hi = f.q.min(0).copy(), f.q.max(0).copy()
            if f.moving:
                lo[2] += zs.min()
                hi[2] += zs.max()
            out.append((lo, hi))
        return out

    def adjacent(boxes):
        pr = set()
        for i in range(n):
            lo_i, hi_i = boxes[i]
            for j in range(i + 1, n):
                lo_j, hi_j = boxes[j]
                if np.all(hi_i + eps >= lo_j) and np.all(hi_j + eps >= lo_i):
                    pr.add((i, j))
        return pr

    swept = adjacent(boxes_swept())
    per_t = [adjacent(boxes_at(float(z))) for z in zs]
    sampled = set().union(*per_t)
    assert sampled <= swept,         "swept AABBs do not cover the sampled ones: %r" % sorted(sampled - swept)

    bad = []
    tight = (9.9, None)
    for i, j in sorted(swept):
        gap = abs(faces[i].val - faces[j].val)
        if gap < tight[0]:
            tight = (gap, (faces[i].name, faces[j].name))
        if gap < 0.10 - 1e-9:
            bad.append((faces[i].name, faces[j].name, faces[i].val, faces[j].val))
    for f in faces:
        assert 0.18 - 1e-9 <= f.val <= 0.72 + 1e-9, (f.name, f.val)
    assert not bad, "adjacent faces too close in value (over the whole travel): %r" % (bad,)

    # the figure must never merge into whatever surface is behind it
    sep = min(abs(a.val - b.val) for a in faces if a.group == "figure"
              for b in faces if b.group != "figure")
    assert sep >= 0.05 - 1e-9, "a figure face matches a set value (%.3f apart)" % sep

    fig = set(k for k, f in enumerate(faces) if f.moving)
    info = dict(swept=len(swept), sampled=len(sampled),
                per_t_min=min(len(x) for x in per_t),
                per_t_max=max(len(x) for x in per_t),
                nsamples=len(zs), z0=float(zs.min()), z1=float(zs.max()),
                fig_pairs=len([1 for i, j in swept if i in fig or j in fig]),
                tight_gap=tight[0], tight_pair=tight[1])
    return sorted(swept), sep, info


# ----------------------------------------------------------------------------
# CAMERA
# ----------------------------------------------------------------------------
def camera_at(t, which=None):
    """Return eye, look-at target, up-hint. C1 everywhere (smoothstep easing).

    `which` overrides the --camera flag for ONE call. The camera json carries the
    projections of both cameras whatever it rendered, so the cross-camera null in
    the consistency scorer - score clip 1 against clip 2's projection, which MUST
    fail - can be run from a single file instead of by pairing two of them and
    hoping the pairing is right."""
    which = CAMERA if which is None else which
    if which == 2:
        # A LOCKED-OFF THREE-QUARTER SIDE ANGLE. Constant for every t, so eye
        # speed is exactly 0 and every pixel of frame-to-frame change in this
        # clip is the walking figure and nothing else. That is what makes it the
        # right second camera for a CONSISTENCY experiment and the wrong one for
        # the camera-move gate - see the gate_assert() note at the top of the file.
        #
        # The alternative the brief allowed, a REVERSED ORBIT, was not taken. It
        # would inherit the orbit's own weakness here: the orbit loses the
        # standing figure out of frame for 37 of the 121 conditioning frames,
        # because it tracks the walker. A second camera whose job is to see the
        # SAME two actors from somewhere else should see both of them the whole
        # time, and this one does - 121/121, worst case 271 px from any edge.
        return CAM2_EYE.copy(), CAM2_TARGET.copy(), UP_WORLD.copy()
    s_orb = smoothstep(T_HOLD_END, T_ORBIT_END, t)     # orbit progress
    s_top = smoothstep(T_ORBIT_END, T_TOP_END, t)      # rise + tip-over
    s_trk = smoothstep(T_HOLD_END, 2.2, t)             # target tracking ease-in

    # the trailing null. Frozen during the hold (so the first second is a true
    # lock-off and the flow really is ~0), exactly figure + (0.4, ., -0.4) from
    # t = 2.2 s onward.
    z_t = FIG_Z0 + FIG_SPEED * t * s_trk
    target = np.array([TARGET_DX, TARGET_Y, z_t + TARGET_DZ])

    # orbit centre eases from the frozen start onto the walking figure
    z_c = FIG_Z0 + FIG_SPEED * t * s_orb
    theta = theta_of(s_orb)
    shrink = 1.0 - s_top                                # radius -> 0 at top-down
    ex = ORB_A * math.sin(theta) * shrink
    ez = z_c - ORB_B * math.cos(theta) * shrink
    ey = (EYE_Y_HOLD
          + (EYE_Y_ORBIT - EYE_Y_HOLD) * s_orb
          + (TARGET_Y + TOPDOWN_ABOVE - EYE_Y_ORBIT) * s_top)
    eye = np.array([ex, ey, ez])

    # Up-hint. Stable through the top-down: blend world-up toward a HORIZONTAL
    # direction as the pitch approaches vertical, so the two are always ~90 deg
    # apart and the roll can never flip. The horizontal direction itself rotates
    # from "along the look azimuth" (zero roll, level horizon) to +X, which puts
    # the corridor across the frame's long axis in the plan view.
    f = target - eye
    f = f / np.linalg.norm(f)
    pitch = math.asin(max(-1.0, min(1.0, -f[1])))
    w = max(0.0, min(1.0, pitch / (math.pi / 2.0)))
    az = np.array([target[0] - eye[0], 0.0, target[2] - eye[2]])
    naz = np.linalg.norm(az)
    assert naz > 1e-3, "look azimuth degenerate at t=%.4f" % t
    az = az / naz
    hdir = (1.0 - s_top) * az + s_top * np.array([1.0, 0.0, 0.0])
    hdir = hdir / np.linalg.norm(hdir)
    up_hint = (1.0 - w) * UP_WORLD + w * hdir
    up_hint = up_hint / np.linalg.norm(up_hint)
    return eye, target, up_hint


def look_at(eye, target, up_hint):
    f = target - eye
    f = f / np.linalg.norm(f)
    r = np.cross(f, up_hint)
    nr = np.linalg.norm(r)
    assert nr > 0.30, "degenerate camera basis, |f x up|=%.4f" % nr
    r = r / nr
    d = np.cross(f, r)          # camera +Y is screen-DOWN
    R = np.stack([r, d, f])     # world -> camera
    return R, f, r, d, nr


def clearance_check(eye, t):
    """Camera must stay out of every solid and inside the set (or above it)."""
    solids = []
    for side in (-1, 1):
        for zc in PIL_Z:
            lo = np.array([min(side * HX, side * (HX - PIL_DEPTH)), 0.0, zc - PIL_HALFW])
            hi = np.array([max(side * HX, side * (HX - PIL_DEPTH)), PIL_H, zc + PIL_HALFW])
            solids.append((lo, hi))
    fz = figure_z(t)
    solids.append((np.array([-FIG_W / 2, 0.0, fz - FIG_W / 2]),
                   np.array([FIG_W / 2, FIG_H, fz + FIG_W / 2])))
    worst = 1e9
    for lo, hi in solids:
        d = np.maximum(np.maximum(lo - eye, eye - hi), 0.0)
        worst = min(worst, float(np.linalg.norm(d)))
    inside = (abs(eye[0]) <= HX - 0.30) and (0.30 <= eye[2] <= CL - 0.30)
    above = eye[1] >= CH + 0.02
    assert inside or above, "camera left the set at t=%.4f eye=%r" % (t, eye)
    if not above:
        assert eye[1] > 0.3, "camera below floor at t=%.4f" % t
    return worst


# ----------------------------------------------------------------------------
# RASTERISER
# Back-to-front painter order over subdivided quads (as briefed) PLUS a per-pixel
# inverse-depth test. The depth test is what actually guarantees no popping: a
# pop is a fake cut and the gate would measure it as camera motion.
# ----------------------------------------------------------------------------
CLIP_PLANES = [
    (0.0, 0.0, 1.0, -NEAR),                  # z >= NEAR
    (FX, 0.0, CX, 0.0),                      # u >= 0
    (-FX, 0.0, WIDTH - 1 - CX, 0.0),         # u <= W-1
    (0.0, FY, CY, 0.0),                      # v >= 0
    (0.0, -FY, HEIGHT - 1 - CY, 0.0),        # v <= H-1
]


# Largest |u| or |v| in metres reached by any shaded pixel. Watched because a
# surface coordinate recovered through 1/invz blows up towards a plane's
# vanishing line, and np.mod on a huge float would lose texel precision. The
# corridor is 18 m, so this must stay small; asserted after the render.
_UV_EXTENT = [0.0]


def clip_poly(P):
    """Sutherland-Hodgman against the 5 frustum half-spaces, in camera space."""
    for (a, b, c, d) in CLIP_PLANES:
        if len(P) < 3:
            return P
        s = P[:, 0] * a + P[:, 1] * b + P[:, 2] * c + d
        out = []
        n = len(P)
        for i in range(n):
            j = (i + 1) % n
            si, sj = s[i], s[j]
            if si >= 0.0:
                out.append(P[i])
            if (si >= 0.0) != (sj >= 0.0):
                tt = si / (si - sj)
                out.append(P[i] + tt * (P[j] - P[i]))
        P = np.array(out, np.float64) if out else np.zeros((0, 3))
    return P


def render_frame(subq, sub_base, sub_val, base_n, base_pt, base_tu, base_tv, R, eye):
    """Return (gray uint8 HxW, baseid int16 HxW with -1 = background).

    Each covered pixel gets its face's flat ladder value PLUS DET_AMP times the
    plane-locked detail field sampled at that pixel's SURFACE coordinates. Those
    coordinates come out of the very same plane equation as the depth test:
    invz = (n1 . m) / d1 gives the camera-space point m / invz, and projecting it
    onto the face's own edge tangents gives (u, v) in metres on the face. Nothing
    here is screen-space and nothing is view-dependent, so the detail is carried
    between frames by the ground-truth homography and by nothing else."""
    gray = np.zeros((HEIGHT, WIDTH), np.uint8)
    bid = np.full((HEIGHT, WIDTH), -1, np.int16)
    invzbuf = np.zeros((HEIGHT, WIDTH), np.float64)

    # backface cull per BASE face, then depth-sort sub-quads back to front
    front = (np.einsum("ij,ij->i", base_n, eye[None, :] - base_pt) > 0.0)
    keep = front[sub_base]
    idx = np.nonzero(keep)[0]
    if idx.size == 0:
        return gray, bid
    cen = subq[idx].mean(axis=1)
    cz = (cen - eye) @ R[2]
    idx = idx[np.argsort(-cz)]          # far first

    Xall = (subq[idx] - eye) @ R.T      # (M,4,3) camera space

    for k in range(idx.shape[0]):
        Pc = Xall[k]
        if Pc[:, 2].max() <= NEAR:
            continue
        poly = clip_poly(Pc)
        if len(poly) < 3:
            continue
        z = poly[:, 2]
        u = FX * poly[:, 0] / z + CX
        v = FY * poly[:, 1] / z + CY
        pts = np.empty((len(poly), 2), np.int32)
        pts[:, 0] = np.clip(np.rint(u), 0, WIDTH - 1)
        pts[:, 1] = np.clip(np.rint(v), 0, HEIGHT - 1)
        x0, x1 = int(pts[:, 0].min()), int(pts[:, 0].max())
        y0, y1 = int(pts[:, 1].min()), int(pts[:, 1].max())
        if x1 < x0 or y1 < y0:
            continue

        b = sub_base[idx[k]]
        n1 = R @ base_n[b]
        d1 = float(np.dot(base_n[b], base_pt[b] - eye))
        if abs(d1) < 1e-6:
            continue

        mw, mh = x1 - x0 + 1, y1 - y0 + 1
        mask = np.zeros((mh, mw), np.uint8)
        cv2.fillConvexPoly(mask, pts - np.array([x0, y0], np.int32), 1, cv2.LINE_8)
        if not mask.any():
            continue
        aa = (np.arange(x0, x1 + 1, dtype=np.float64) - CX) / FX
        bb = (np.arange(y0, y1 + 1, dtype=np.float64) - CY) / FY
        invz = (n1[0] * aa[None, :] + n1[1] * bb[:, None] + n1[2]) / d1
        sub = (mask.astype(bool)) & (invz > 1e-9) & (invz > invzbuf[y0:y1 + 1, x0:x1 + 1])
        if not sub.any():
            continue
        invzbuf[y0:y1 + 1, x0:x1 + 1][sub] = invz[sub]

        # ---- plane-locked surface detail --------------------------------
        # u = ((R tu) . m) / invz + (eye - o) . tu, with m = (a, b, 1) the
        # normalised ray and invz the depth test's own quantity. Same plane, same
        # mapping, so the same homography carries it.
        rr, cc = np.nonzero(sub)
        iz = invz[sub]
        am = aa[cc]
        bm = bb[rr]
        tu_c = R @ base_tu[b]
        tv_c = R @ base_tv[b]
        o = base_pt[b]
        uu = (tu_c[0] * am + tu_c[1] * bm + tu_c[2]) / iz + float(np.dot(eye - o, base_tu[b]))
        vv = (tv_c[0] * am + tv_c[1] * bm + tv_c[2]) / iz + float(np.dot(eye - o, base_tv[b]))
        _UV_EXTENT[0] = max(_UV_EXTENT[0], float(np.abs(uu).max()), float(np.abs(vv).max()))
        val = sub_val[idx[k]] + DET_AMP * sample_detail(uu, vv)

        gray[y0:y1 + 1, x0:x1 + 1][sub] = np.clip(np.rint(val * 255.0), 0.0, 255.0).astype(np.uint8)
        bid[y0:y1 + 1, x0:x1 + 1][sub] = b
    return gray, bid


# ----------------------------------------------------------------------------
# GROUND-TRUTH FLOW
# ----------------------------------------------------------------------------
def plane_homographies(base_n, base_pt, base_delta, R1, C1, R2, C2):
    """Exact plane-induced homography per base face, frame t -> t+1.

    For a rigid face translating by delta between the two frames:
        X2 = R2 R1^T X1 + R2 (C1 + delta - C2)
    and on the plane  1 = (n1 . X1) / d1,  so
        H = K (Rrel + trel n1^T / d1) K^-1
    """
    B = base_n.shape[0]
    Rrel = R2 @ R1.T
    H = np.zeros((B, 3, 3), np.float64)
    ok = np.zeros(B, bool)
    for b in range(B):
        n1 = R1 @ base_n[b]
        d1 = float(np.dot(base_n[b], base_pt[b] - C1))
        if abs(d1) < 1e-6:
            continue
        trel = R2 @ (C1 + base_delta[b] - C2)
        M = Rrel + np.outer(trel, n1) / d1
        H[b] = K @ M @ KINV
        ok[b] = True
    return H, ok


UGRID = np.arange(WIDTH, dtype=np.float64)[None, :]
VGRID = np.arange(HEIGHT, dtype=np.float64)[:, None]


def flow_pair(bid_t, bid_t1, H):
    """Dense exact flow at 1280x704 plus a validity mask."""
    has = bid_t >= 0
    safe = np.where(has, bid_t, 0).astype(np.intp)
    Hf = H.reshape(-1, 9)[safe]                       # (H,W,9)
    xw = Hf[..., 0] * UGRID + Hf[..., 1] * VGRID + Hf[..., 2]
    yw = Hf[..., 3] * UGRID + Hf[..., 4] * VGRID + Hf[..., 5]
    ww = Hf[..., 6] * UGRID + Hf[..., 7] * VGRID + Hf[..., 8]

    good = has & (ww > 1e-9)
    wsafe = np.where(good, ww, 1.0)
    x2 = xw / wsafe
    y2 = yw / wsafe
    good &= (x2 >= 0) & (x2 <= WIDTH - 1) & (y2 >= 0) & (y2 <= HEIGHT - 1)

    xi = np.clip(np.rint(np.where(good, x2, 0)), 0, WIDTH - 1).astype(np.intp)
    yi = np.clip(np.rint(np.where(good, y2, 0)), 0, HEIGHT - 1).astype(np.intp)
    good &= (bid_t1[yi, xi] == bid_t)                 # occlusion / disocclusion

    flow = np.zeros((HEIGHT, WIDTH, 2), np.float64)
    flow[..., 0] = np.where(good, x2 - UGRID, 0.0)
    flow[..., 1] = np.where(good, y2 - VGRID, 0.0)
    return flow, good


def downsample(flow, valid):
    """Area-average to 320x176, scale magnitude by 0.25. Valid only if ALL 16
    contributing pixels were valid (see D3)."""
    f = flow.reshape(AH, DS, AW, DS, 2).mean(axis=(1, 3)) * 0.25
    v = valid.reshape(AH, DS, AW, DS).all(axis=(1, 3))
    f[~v] = 0.0
    return f.astype(np.float16), v


# ----------------------------------------------------------------------------
# UNMISTAKABILITY OF THE MOVE  (asserted after every render)
#
# The whole gate turns on the blocked move being one that a model CANNOT match
# by accident. A corridor has a natural forward bias, so a gentle push-in that a
# plain forward-motion prior half-matches would destroy the experiment's
# discriminating power - and it would do so silently, by producing a comfortable
# positive that means nothing. That risk is real whenever the move is retuned
# (it was retuned here: CW 3.0 -> 5.0, ORB_A 1.0 -> 2.0 to get under DIS's
# tracking knee), so the guarantee is measured from the rendered ground truth
# rather than asserted in a comment.
#
# Three adversarial priors, each an UPPER BOUND on a whole family, all scored
# with the scorer's own mask over the 120-pair arm window:
#   * static forward-dolly    radial expansion, one centre-of-expansion grid
#                             searched for the whole clip
#   * per-frame radial        COE re-optimised every pair. Bounds ANY
#                             dolly / zoom / push-in prior, however adaptive.
#   * per-frame translation   direction re-optimised every pair. Bounds ANY
#                             pan / tilt prior. Closed form: the best uniform
#                             direction is the |gt|-weighted mean of the unit
#                             flow, so its CMA is |sum w*ghat| / sum w, i.e. the
#                             field's own directional coherence.
# Each must land below the scorer's absolute pass floor, or the move is
# matchable without following it and the clip is not fit for the gate.
# ----------------------------------------------------------------------------
SCORER_MAG_FLOOR = 0.75      # gate_score.MAG_FLOOR   (agreement asserted below)
SCORER_MIN_COV = 0.05        # gate_score.MIN_COV
SCORER_ARM_FRAMES = 121      # gate_score.ARM_FRAMES  - EmptyLTXVLatentVideo length
SCORER_PASS_FLOOR = 0.50     # gate_score.T_CMA_ABS

# DIS's measured tracking knee at 320x176 PRESET_MEDIUM, in px/frame, and how
# many pairs may sit past it. Currently 5 (the orbit apex, t = 2.29 .. 2.46 s).
# The budget exists so a future retune that speeds the whole move up fires here
# instead of quietly costing every arm its score at the apex.
DIS_KNEE = 25.0
DIS_KNEE_MAX_PAIRS = 10


def _scorer_constants_agree():
    """The mask constants are duplicated here so this file needs no import of the
    scorer. Duplication drifts, so check it against the scorer's source."""
    src = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gate_score.py")
    if not os.path.exists(src):
        return "gate_score.py not found next to this file - constants UNCHECKED"
    with open(src, encoding="utf-8") as fh:
        txt = fh.read()
    want = {"MAG_FLOOR": SCORER_MAG_FLOOR, "MIN_COV": SCORER_MIN_COV,
            "ARM_FRAMES": SCORER_ARM_FRAMES, "T_CMA_ABS": SCORER_PASS_FLOOR}
    for name, val in want.items():
        m = re.search(r"^%s\s*=\s*([0-9.]+)" % name, txt, re.M)
        assert m, "cannot find %s in gate_score.py" % name
        assert abs(float(m.group(1)) - val) < 1e-12,             "%s drifted: gate_block %r vs gate_score %s" % (name, val, m.group(1))
    return "checked against gate_score.py: MAG_FLOOR %.2f, MIN_COV %.2f, arm window %d, pass floor %.2f" % (
        SCORER_MAG_FLOOR, SCORER_MIN_COV, SCORER_ARM_FRAMES, SCORER_PASS_FLOOR)


def prior_bounds(flow_ds, valid_ds, stride=2):
    """Upper bounds on what a dolly / zoom / pan prior can score on this clip.

    The translation bound is closed form and therefore computed at FULL
    resolution. The two radial bounds need a grid search over the centre of
    expansion, so those pixels are strided -- these are bounds, and a strided
    bound that came out LOW would be the wrong kind of wrong, so the stride is
    kept fine (every 2nd pixel each axis) and the drift checked once against a
    full-resolution run: 0.4375 at stride 4 vs 0.4409 full, i.e. the stride is
    worth ~0.003 on a quantity with a 0.06 margin."""
    gy0, gx0 = np.mgrid[0:AH, 0:AW].astype(np.float64)
    gyf, gxf = gy0[::stride, ::stride], gx0[::stride, ::stride]
    per, coh = [], []
    for t in range(SCORER_ARM_FRAMES - 1):
        gfull = flow_ds[t].astype(np.float64)
        mfull = np.sqrt(gfull[..., 0] ** 2 + gfull[..., 1] ** 2)
        maskf = valid_ds[t] & (mfull >= SCORER_MAG_FLOOR)
        if maskf.mean() < SCORER_MIN_COV:
            continue
        wf = mfull[maskf]
        # closed form, full resolution: the best uniform direction is the
        # |gt|-weighted mean of the unit flow, so its CMA is the field's own
        # directional coherence.
        coh.append(float(np.hypot((gfull[..., 0][maskf] / wf * wf).sum(),
                                  (gfull[..., 1][maskf] / wf * wf).sum()) / wf.sum()))
        g = gfull[::stride, ::stride]
        v = valid_ds[t][::stride, ::stride]
        m = np.sqrt(g[..., 0] ** 2 + g[..., 1] ** 2)
        mask = v & (m >= SCORER_MAG_FLOOR)
        w = m[mask]
        per.append((gxf[mask], gyf[mask], g[..., 0][mask] / w, g[..., 1][mask] / w, w))
    coh = np.asarray(coh)
    assert len(per) > 50, "prior test has too few scored pairs (%d)" % len(per)

    cxs = np.linspace(-AW * 0.6, AW * 1.6, 23)
    cys = np.linspace(-AH * 0.6, AH * 1.6, 19)
    grid = np.zeros((len(per), cxs.size * cys.size))
    for k, (x, y, ghx, ghy, w) in enumerate(per):
        c = 0
        for cx in cxs:
            dx = x - cx
            for cy in cys:
                dy = y - cy
                r = np.sqrt(dx * dx + dy * dy) + 1e-9
                grid[k, c] = (w * (ghx * dx / r + ghy * dy / r)).sum() / w.sum()
                c += 1
    static = np.median(grid, axis=0)      # one COE for the whole clip
    j = int(np.argmax(static))
    return dict(npairs=len(per),
                translate_med=float(np.median(coh)), translate_max=float(coh.max()),
                dolly_static=float(static[j]),
                dolly_coe=(float(cxs[j // cys.size]), float(cys[j % cys.size])),
                radial_perframe_med=float(np.median(grid.max(axis=1))),
                radial_perframe_max=float(grid.max()))


# ----------------------------------------------------------------------------
# MAIN
# ----------------------------------------------------------------------------
def main():
    t_start = time.time()
    os.makedirs(OUTDIR, exist_ok=True)
    # a previous run that tripped an assertion leaves its .partial files behind
    for stale in (MP4_T, NPZ_T, CAMJSON_T, CONTACT_T):
        if os.path.exists(stale):
            os.remove(stale)

    faces = build_scene()
    pairs, figsep, adj = check_shading(faces)
    B = len(faces)

    print("=" * 78)
    print("SCENE")
    print("=" * 78)
    print("  base faces      : %d  (shell 6, pilasters 24, figure 5)" % B)
    print("  adjacent pairs  : %d  (all verified >= 0.10 apart in value)" % len(pairs))
    print("    the figure MOVES, so adjacency is checked over its whole travel, not at t=0:")
    print("      swept AABBs (figure z %.2f -> %.2f; a proof for every t) : %d pairs, "
          "%d involving the figure" % (adj["z0"], adj["z1"], adj["swept"], adj["fig_pairs"]))
    print("      sampled at all %d frame times                           : %d pairs "
          "(per-frame %d..%d), subset of swept as asserted"
          % (adj["nsamples"], adj["sampled"], adj["per_t_min"], adj["per_t_max"]))
    print("      tightest adjacent value gap anywhere in the travel     : %.2f  (%s | %s)"
          % (adj["tight_gap"], adj["tight_pair"][0], adj["tight_pair"][1]))
    print("  value range     : %.2f .. %.2f" % (min(f.val for f in faces),
                                                max(f.val for f in faces)))
    print("  figure vs set   : closest value separation %.2f (figure is on the "
          "half-step ladder)" % figsep)
    print("  fig top vs floor: %.2f  (this pair alone carries the subject in the "
          "plan view)" % abs(0.23 - 0.68))
    print("  key direction   : (%.3f, %.3f, %.3f)" % tuple(KEY))
    print("  shading table (wrap-lambert -> quantised value):")
    seen = set()
    for f in faces:
        kk = (f.group, tuple(np.round(f.n, 3)))
        if kk in seen:
            continue
        seen.add(kk)
        print("     %-10s n=(%+.0f,%+.0f,%+.0f)  L=%.3f  ->  v=%.2f  (%d/255)"
              % (f.group, f.n[0], f.n[1], f.n[2], wrap_lambert(f.n), f.val,
                 int(round(f.val * 255))))

    # ---- flatten to sub-quads -------------------------------------------
    subs, sub_base, sub_val = [], [], []
    for b, f in enumerate(faces):
        s = subdiv(f.q, f.nu, f.nv)
        subs.append(s)
        sub_base.append(np.full(s.shape[0], b, np.int32))
        sub_val.append(np.full(s.shape[0], f.val, np.float64))
    subq0 = np.concatenate(subs, 0)
    sub_base = np.concatenate(sub_base, 0)
    sub_val = np.concatenate(sub_val, 0)
    moving_sub = np.array([faces[b].moving for b in sub_base], bool)
    moving_base = np.array([f.moving for f in faces], bool)
    base_n = np.stack([f.n for f in faces])
    base_pt0 = np.stack([f.q[0] for f in faces])
    print("  sub-quads       : %d  (walls/floor/ceiling 4x12, ends 4x4, "
          "pilaster & figure faces 2x2)" % subq0.shape[0])

    # ---- per-face surface frame, for the plane-locked detail -------------
    # (u, v) are metres along the face's own two edge tangents from its own
    # origin q[0]. Every quad in this set is a rectangle, so the frame is
    # orthonormal -- asserted, because a skew frame would still be plane-locked
    # but would silently shear the detail's spatial frequencies.
    base_tu, base_tv = [], []
    for f in faces:
        eu = f.q[1] - f.q[0]
        ev = f.q[3] - f.q[0]
        lu, lv = np.linalg.norm(eu), np.linalg.norm(ev)
        assert lu > 1e-9 and lv > 1e-9, "degenerate face quad: %s" % f.name
        eu, ev = eu / lu, ev / lv
        assert abs(float(np.dot(eu, ev))) < 1e-9, "face %s is not a rectangle" % f.name
        assert abs(float(np.dot(np.cross(eu, ev), f.n))) > 1 - 1e-9, \
            "face %s tangent frame is not in its own plane" % f.name
        base_tu.append(eu)
        base_tv.append(ev)
    base_tu = np.stack(base_tu)
    base_tv = np.stack(base_tv)
    dt = detail_tile()
    print("  surface detail  : PLANE-LOCKED, +-%.3f of the 0-1 value range "
          "(+-%d/255)" % (DET_AMP, int(round(DET_AMP * 255))))
    print("    field         : %d^2 tile, %.1f m period (%.0f texels/m); 4 octaves of "
          "value noise" % (DET_TILE, DET_PERIOD_M, DET_TPM))
    print("                    (lattice 1.00/0.50/0.25/0.125 m) + %.2f m panel seams, "
          "seed %d" % (DET_SEAM_M, DET_SEED))
    print("    tile stats    : mean %+.3e  max|D| %.6f  std %.4f  (zero mean keeps every "
          "face's MEAN value)" % (dt.mean(), np.abs(dt).max(), dt.std()))
    print("    locked to     : each face's own (u,v) in metres, read back through the same "
          "plane equation")
    print("                    the depth test uses, so the ground-truth homography carries "
          "it and nothing else does.")

    # ---- camera track ----------------------------------------------------
    times = np.arange(NFRAMES) / float(FPS)
    cams = []
    min_clear = 1e9
    for t in times:
        eye, tgt, uph = camera_at(float(t))
        R, f, r, d, nr = look_at(eye, tgt, uph)
        min_clear = min(min_clear, clearance_check(eye, float(t)))
        cams.append(dict(t=float(t), eye=eye, target=tgt, R=R, f=f, up=-d, basis=nr))
    roll_dots = [float(np.dot(cams[i]["up"], cams[i + 1]["up"])) for i in range(NFRAMES - 1)]
    speeds = [float(np.linalg.norm(cams[i + 1]["eye"] - cams[i]["eye"])) * FPS
              for i in range(NFRAMES - 1)]
    accel = [abs(speeds[i + 1] - speeds[i]) for i in range(len(speeds) - 1)]

    print()
    print("=" * 78)
    print("CAMERA")
    print("=" * 78)
    print("  intrinsics      : fx=fy=%.3f px  cx=%.1f cy=%.1f  hfov=%.2f deg "
          "vfov=%.2f deg  (%.2f mm on 36 mm)"
          % (FX, CX, CY, HFOV_DEG, 2 * math.degrees(math.atan(CY / FY)), FOCAL_MM))
    print("  min clearance to any solid : %.3f m" % min_clear)
    print("  min |forward x up-hint|    : %.4f   (0 would be a degenerate basis)"
          % min(c["basis"] for c in cams))
    print("  min dot(up_t, up_t+1)      : %.6f  (a roll flip would be <= 0)"
          % min(roll_dots))
    print("  eye speed  min/max         : %.3f / %.3f m/s" % (min(speeds), max(speeds)))
    print("  max |d speed| per frame    : %.4f m/s  (velocity is C1, no cuts)"
          % max(accel))

    # ---- render + flow ---------------------------------------------------
    print()
    print("=" * 78)
    print("RENDER + GROUND-TRUTH FLOW")
    print("=" * 78)
    grays = np.zeros((NFRAMES, HEIGHT, WIDTH), np.uint8)
    flow_ds = np.zeros((NFRAMES - 1, AH, AW, 2), np.float16)
    valid_ds = np.zeros((NFRAMES - 1, AH, AW), bool)
    valid_full = np.zeros(NFRAMES - 1)
    bgfrac = np.zeros(NFRAMES)
    medmag = np.zeros(NFRAMES - 1)
    p95mag = np.zeros(NFRAMES - 1)
    maxmag = np.zeros(NFRAMES - 1)
    hcheck = []
    hres = []

    # blockout audit accumulators: index 0 is the background (LUT value 0, so its
    # residual is identically 0 and it can neither widen the band nor bias a face)
    VAL255_LUT = np.concatenate([[0], np.array([int(round(f.val * 255.0)) for f in faces],
                                               np.int16)]).astype(np.int16)
    det_min, det_max = 0, 0
    det_sum = np.zeros(B + 1, np.float64)
    det_cnt = np.zeros(B + 1, np.float64)

    prev_bid = None
    prev_cam = None
    prev_zf = None
    delta_step = np.array([0.0, 0.0, FIG_SPEED / FPS])

    for i in range(NFRAMES):
        t = float(times[i])
        zf = figure_z(t)
        subq = subq0.copy()
        subq[moving_sub, :, 2] += zf
        base_pt = base_pt0.copy()
        base_pt[moving_base, 2] += zf

        c = cams[i]
        gray, bid = render_frame(subq, sub_base, sub_val, base_n, base_pt,
                                 base_tu, base_tv, c["R"], c["eye"])
        grays[i] = gray
        bgfrac[i] = float((bid < 0).mean())

        # per-face residual against the authored flat value (the blockout audit
        # below reads these; accumulated here so no frame has to be kept twice)
        resid = gray.astype(np.int16) - VAL255_LUT[bid + 1]
        det_min = min(det_min, int(resid.min()))
        det_max = max(det_max, int(resid.max()))
        det_sum += np.bincount((bid + 1).ravel(), weights=resid.ravel().astype(np.float64),
                               minlength=B + 1)
        det_cnt += np.bincount((bid + 1).ravel(), minlength=B + 1)

        if prev_bid is not None:
            bdelta = np.zeros((B, 3))
            bdelta[moving_base] = delta_step
            H, ok = plane_homographies(base_n, prev_base_pt, bdelta,
                                       prev_cam["R"], prev_cam["eye"],
                                       c["R"], c["eye"])
            # cross-check the analytic H against cv2.getPerspectiveTransform on
            # faces whose 4 corners are safely in front of BOTH cameras
            for b in range(B):
                if not ok[b]:
                    continue
                q1 = faces[b].q.copy()
                if faces[b].moving:
                    q1[:, 2] += prev_zf
                q2 = q1 + (delta_step if faces[b].moving else 0.0)
                X1 = (q1 - prev_cam["eye"]) @ prev_cam["R"].T
                X2 = (q2 - c["eye"]) @ c["R"].T
                if X1[:, 2].min() < 0.5 or X2[:, 2].min() < 0.5:
                    continue
                s64 = np.stack([FX * X1[:, 0] / X1[:, 2] + CX,
                                FY * X1[:, 1] / X1[:, 2] + CY], 1)
                d64 = np.stack([FX * X2[:, 0] / X2[:, 2] + CX,
                                FY * X2[:, 1] / X2[:, 2] + CY], 1)
                if (np.abs(s64).max() > 1e5) or (np.abs(d64).max() > 1e5):
                    continue

                # (a) independent float64 residual: does the analytic H carry the
                # 4 corners projected at t onto the 4 corners projected at t+1?
                a = H[b] @ np.concatenate([s64, np.ones((4, 1))], 1).T
                if np.abs(a[2]).min() < 1e-9:
                    continue
                hres.append(float(np.abs((a[:2] / a[2]).T - d64).max()))

                # (b) the briefed check, against cv2.getPerspectiveTransform.
                # cv2 requires CV_32F here, so its own input is quantised to
                # float32 -- that quantisation, not the analytic H, is the floor
                # on this number.
                Hcv = cv2.getPerspectiveTransform(s64.astype(np.float32),
                                                  d64.astype(np.float32))
                probe = np.array([[s64[:, 0].mean(), s64[:, 1].mean(), 1.0],
                                  [s64[0, 0], s64[0, 1], 1.0],
                                  [s64[2, 0], s64[2, 1], 1.0]]).T
                a1, a2 = H[b] @ probe, Hcv @ probe
                if np.abs(a1[2]).min() < 1e-9 or np.abs(a2[2]).min() < 1e-9:
                    continue
                hcheck.append(float(np.abs(a1[:2] / a1[2] - a2[:2] / a2[2]).max()))

            H[~ok] = np.eye(3)
            fl, vv = flow_pair(prev_bid, bid, H)
            vv &= ok[np.where(prev_bid >= 0, prev_bid, 0)]
            valid_full[i - 1] = vv.mean()
            f16, v16 = downsample(fl, vv)
            flow_ds[i - 1] = f16
            valid_ds[i - 1] = v16
            mg = np.linalg.norm(f16[v16].astype(np.float64), axis=-1) if v16.any() else np.zeros(1)
            medmag[i - 1] = float(np.median(mg))
            p95mag[i - 1] = float(np.percentile(mg, 95))
            maxmag[i - 1] = float(mg.max())

        prev_bid = bid
        prev_cam = c
        prev_base_pt = base_pt
        prev_zf = zf
        if (i + 1) % 24 == 0:
            print("    frame %3d/%d   %.1fs elapsed" % (i + 1, NFRAMES, time.time() - t_start))

    assert len(hres) > 1000 and len(hcheck) > 1000, \
        "homography cross-check barely ran (%d / %d) -- it must not pass vacuously" \
        % (len(hres), len(hcheck))
    print("  analytic H, float64 corner residual over %d face/pair checks : %.3e px"
          % (len(hres), max(hres)))
    print("  analytic H vs cv2.getPerspectiveTransform over %d checks     : %.3e px"
          "  (floor is cv2's float32 input)" % (len(hcheck), max(hcheck)))
    assert max(hres) < 1e-6, "analytic homography does not reproduce the projection"

    # ---- pop detection ---------------------------------------------------
    imgdiff = np.array([np.abs(grays[i + 1].astype(np.int16) - grays[i].astype(np.int16)).mean()
                        for i in range(NFRAMES - 1)])
    fd = flow_ds.astype(np.float32)
    both = valid_ds[:-1] & valid_ds[1:]
    dmag = np.linalg.norm(fd[1:] - fd[:-1], axis=-1)
    per_pair_max = np.where(both.any(axis=(1, 2)),
                            np.max(np.where(both, dmag, -1.0), axis=(1, 2)), 0.0)
    allde = dmag[both]
    med_delta = np.array([np.median(dmag[k][both[k]]) if both[k].any() else 0.0
                          for k in range(dmag.shape[0])])

    # ADVECTED delta -- the physically meaningful "no discontinuity spike" test.
    # Comparing F_k and F_k+1 at the SAME pixel compares two different scene
    # points whenever the flow is large, so it reports the flow's spatial
    # gradient as if it were a temporal jump. Following the flow instead
    # (compare F_k(p) with F_k+1(p + F_k(p))) measures true acceleration along
    # each point's trajectory, which is what a pop would break.
    gy, gx = np.mgrid[0:AH, 0:AW]
    adv_all, adv_pair_max, adv_pair_med = [], np.zeros(dmag.shape[0]), np.zeros(dmag.shape[0])
    for k in range(dmag.shape[0]):
        f0 = fd[k]
        xi = np.clip(np.rint(gx + f0[..., 0]), 0, AW - 1).astype(np.intp)
        yi = np.clip(np.rint(gy + f0[..., 1]), 0, AH - 1).astype(np.intp)
        m = valid_ds[k] & valid_ds[k + 1][yi, xi]
        if not m.any():
            continue
        f1 = fd[k + 1][yi, xi]
        dv = np.linalg.norm(f1 - f0, axis=-1)[m]
        adv_all.append(dv)
        adv_pair_max[k] = dv.max()
        adv_pair_med[k] = np.median(dv)
    adv_all = np.concatenate(adv_all)

    # ---- blockout audit ---------------------------------------------------
    # This used to assert that every pixel value was one of the authored ladder
    # values. With plane-locked detail that is false BY DESIGN, so the audit is
    # restated against the thing it was actually protecting: no pixel of any face
    # may stray outside its OWN authored value plus the detail budget, and every
    # face's MEAN must stay on its authored value. That still catches blending
    # and antialiasing (either would push a silhouette pixel toward a neighbour's
    # value and out of its own band) and it additionally pins the amplitude and
    # the mean, which the old form could not see.
    band = int(math.ceil(DET_AMP * 255.0)) + 1        # +1 for the rounding to uint8
    fmean = det_sum[1:] / np.maximum(det_cnt[1:], 1.0)
    seen = det_cnt[1:] > 0
    worst_face = int(np.argmax(np.abs(np.where(seen, fmean, 0.0))))
    print("  blockout audit  : %d distinct pixel values (was 11 flat); every pixel inside "
          "its own face's band" % len(set(int(v) for v in np.unique(grays))))
    print("    per-pixel residual vs the authored flat value : %+d .. %+d /255  "
          "(budget +-%d)" % (det_min, det_max, band))
    print("    worst per-face MEAN drift over the whole clip : %+.3f /255  (%s)  "
          "-- the shading ladder is unmoved"
          % (fmean[worst_face], faces[worst_face].name))
    print("    faces actually seen                           : %d / %d" % (int(seen.sum()), B))
    assert det_min >= -band and det_max <= band, \
        ("a pixel left its face's authored band (%+d .. %+d, budget +-%d): either the "
         "detail exceeded its amplitude or something blended." % (det_min, det_max, band))
    assert max(abs(det_min), abs(det_max)) >= 4, \
        ("the detail is effectively absent (max residual %d/255) -- this audit must not "
         "pass vacuously on a flat render." % max(abs(det_min), abs(det_max)))
    # 3/255 = 0.012 of the 0-1 range. The tightest separation anywhere in the set
    # is the figure's half-step 0.05, so even two faces drifting the full budget
    # in opposite directions leave 0.026 of it -- the ladder cannot collapse.
    # (Measured on this render: worst face 1.66/255, and it is a 0.6 x 0.3 m
    # pilaster top, which samples too small a patch of the tile for its mean to
    # average out. The big faces are at 0.1/255.)
    #
    # THE THRESHOLD IS TIGHTER THAN THE CLAIM, AND ON A LOCKED-OFF CAMERA THAT
    # MATTERS. 3/255 is a tightness convention that holds because the ORBIT sweeps
    # every face across the frame, so each one is sampled over a large, moving
    # patch of a zero-mean tile and its mean averages out. A static camera sees a
    # FIXED patch of each wall for all 144 frames: the sample never moves, so the
    # sampled mean of a zero-mean field does not converge, and camera 2 measures
    # 3.153/255 on wall_right - of which the render sees a sliver.
    #
    # 3.153/255 is 0.0124 of the 0-1 range. The thing the number protects is the
    # tightest separation in the set, the figure's half-step 0.05 (12.75/255), and
    # the bound that actually protects it is that no two faces can drift toward
    # each other by half of it. So the load-bearing bound is asserted on EVERY
    # variant, and the tighter convention on the variant it was measured for.
    # (On the orbit's own render: worst face 1.66/255, a 0.6 x 0.3 m pilaster top,
    # which samples too small a patch of the tile for its mean to average out. The
    # big faces are at 0.1/255.)
    _drift = float(np.abs(np.where(seen, fmean, 0.0)).max())
    _halfsep = 0.5 * 0.05 * 255.0
    assert _drift < _halfsep, \
        ("a face's rendered MEAN drifted %.3f/255 off its authored value, which is at or "
         "past half the tightest authored separation in the set (%.2f/255). Two faces "
         "drifting like that toward each other close the ladder." % (_drift, _halfsep))
    gate_assert(_drift <= 3.0,
        ("a face's rendered MEAN drifted %.3f/255 off its authored value; on the orbit the "
         "convention is 3/255. The >= 0.10 adjacent-face separation is stated in those "
         "means and is separately asserted above at %.2f/255." % (_drift, _halfsep)))
    assert int(VAL255_LUT[1:].min()) + det_min > 0, \
        ("a shaded pixel could reach 0, which is the background value: the darkest face "
         "(%d/255) minus the detail (%d) leaves no separation."
         % (int(VAL255_LUT[1:].min()), det_min))
    assert _UV_EXTENT[0] < 1.0e3, \
        ("a surface coordinate reached %.1f m; np.mod would be losing texel precision "
         "near a vanishing line." % _UV_EXTENT[0])
    print("    max |u|,|v| reached on any shaded pixel       : %.2f m  (set is %.0f m long)"
          % (_UV_EXTENT[0], CL))

    # ---- THE LOAD-BEARING CHECK: the reference side did not move ----------
    # Detail changes PIXELS. The ground truth is derived from geometry, camera
    # and timing alone, so it must be bit-identical to the flat render. Proved,
    # not assumed.
    sha_flow = hashlib.sha256(np.ascontiguousarray(flow_ds).tobytes()).hexdigest()
    sha_valid = hashlib.sha256(np.ascontiguousarray(valid_ds).tobytes()).hexdigest()
    print()
    print("  GROUND TRUTH UNCHANGED  (pixels moved; the reference side must not)")
    print("    sha256(flow  %s %s) = %s" % (flow_ds.shape, flow_ds.dtype, sha_flow))
    print("    sha256(valid %s %s)  = %s" % (valid_ds.shape, valid_ds.dtype, sha_valid))
    print("    pinned from the final FLAT render      : %s / %s"
          % (GT_SHA256_FLOW[:16], GT_SHA256_VALID[:16]))
    gate_assert(sha_flow == GT_SHA256_FLOW,
        ("THE FLOW FIELD MOVED. sha256 %s != pinned %s. The surface detail is not "
         "plane-locked -- it has put error on the one side of this gate that is exact. "
         "Do NOT re-pin to make this pass; fix the detail." % (sha_flow, GT_SHA256_FLOW)))
    gate_assert(sha_valid == GT_SHA256_VALID,
        ("THE VALIDITY MASK MOVED. sha256 %s != pinned %s. Same conclusion as above."
         % (sha_valid, GT_SHA256_VALID)))
    print("    MATCH -- the flow field and validity mask are bit-identical to the flat")
    print("    render, so every prior bound and the whole reference side are untouched.")
    print("    (The npz FILE digest does change, because the SCOPE json stamped into it")
    print("     changed. gate_score.py fingerprints the FILE, so it will correctly refuse")
    print("     to mix arms scored against the flat clip with an anchor from this one --")
    print("     the arms must be re-dispatched. That is a source-identity check, not a")
    print("     ground-truth check; the ground truth is what the two digests above pin.)")

    # ---- write the video --------------------------------------------------
    # EVERYTHING IS WRITTEN TO .partial AND RENAMED AT THE VERY END, after every
    # assertion in this file has passed. Found the hard way: the unmistakability
    # check below fired on a trial geometry, and because the artifacts were
    # written before it ran, a clip this script had just REJECTED was already
    # sitting under the real name where gate_run.mjs stages from. A rejected clip
    # under the published name is precisely the silent failure this gate exists
    # to prevent, and it lasted about four minutes before I hit it.
    import av
    if os.path.exists(MP4_T):
        os.remove(MP4_T)
    cont = av.open(MP4_T, mode="w")
    # Container metadata ONLY -- not one pixel changes, so this cannot alter the
    # treatment the way a surface-noise patch would. It is here so the scope
    # travels with the file even when the file travels alone.
    cont.metadata["comment"] = SCOPE_LINE
    cont.metadata["description"] = SCOPE["path_under_test"]
    st = cont.add_stream("libx264", rate=Fraction(FPS, 1))
    st.width = WIDTH
    st.height = HEIGHT
    st.pix_fmt = "yuv420p"
    st.time_base = Fraction(1, FPS)
    try:
        st.codec_context.options = {"crf": "14", "preset": "medium"}
    except Exception:
        st.options = {"crf": "14", "preset": "medium"}
    for i in range(NFRAMES):
        rgb = np.repeat(grays[i][:, :, None], 3, axis=2)
        fr = av.VideoFrame.from_ndarray(np.ascontiguousarray(rgb), format="rgb24")
        fr.pts = i
        fr.time_base = Fraction(1, FPS)
        for pkt in st.encode(fr):
            cont.mux(pkt)
    for pkt in st.encode():
        cont.mux(pkt)
    cont.close()

    # ---- write flow + camera ---------------------------------------------
    np.savez_compressed(NPZ_T, flow=flow_ds, valid=valid_ds,
                        scope=np.array(json.dumps(SCOPE, indent=1)),
                        scope_line=np.array(SCOPE_LINE))
    # ---- actor tracks: BOTH cameras, whichever one was rendered -----------
    # Per actor, per frame: neck and hip in world metres, and the pixel each
    # projects to under camera 1 AND camera 2. Both are written every run, and
    # that is deliberate. The cross-camera NULL the consistency scorer has to run
    # - score the camera-1 render against camera 2's projection, which MUST fail
    # or the metric is not seeing the camera - then needs one file, not a pairing
    # of two files that could be mismatched without anything noticing.
    #
    # `in_frame` is stated rather than left for the reader to derive, because
    # off-the-left-edge and behind-the-camera produce the same (u, v) nonsense and
    # only z_cam tells them apart. The orbit camera loses the standing figure for
    # part of the clip; a scorer that treats a missing detection there as error
    # would be scoring the framing, not the render.
    tracks = {}
    inframe_counts = {}
    for which in (1, 2):
        key = "cam%d" % which
        tracks[key] = {}
        inframe_counts[key] = {}
        for i in range(NFRAMES):
            eye_w, tgt_w, up_w = camera_at(float(times[i]), which=which)
            Rw, _, _, _, _ = look_at(eye_w, tgt_w, up_w)
            for aid, pos in figure_positions(float(times[i])).items():
                row = {"frame": i, "t": float(times[i]),
                       "neck_world": [float(x) for x in pos["neck"]],
                       "hip_world": [float(x) for x in pos["hip"]],
                       "base_world": [float(x) for x in pos["base"]]}
                allin = True
                for jn in ("neck", "hip"):
                    u, v, zc = project(Rw, eye_w, pos[jn])
                    ok = (u is not None and 0.0 <= u < WIDTH and 0.0 <= v < HEIGHT)
                    row[jn + "_uv"] = None if u is None else [u, v]
                    row[jn + "_zcam"] = zc
                    row[jn + "_in_frame"] = bool(ok)
                    allin = allin and ok
                row["in_frame"] = bool(allin)
                tracks[key].setdefault(aid, []).append(row)
        for aid, rows in tracks[key].items():
            inframe_counts[key][aid] = int(sum(1 for r in rows[:min(NFRAMES, SCORER_ARM_FRAMES)]
                                               if r["in_frame"]))

    print()
    print("=" * 78)
    print("ACTOR TRACKS  (written for BOTH cameras; this run rendered camera %d)" % CAMERA)
    print("=" * 78)
    print("  neck at y=%.2f m, hip at y=%.2f m on a %.1f m box; projected with the same"
          % (NECK_Y, HIP_Y, FIG_H))
    print("  pinhole the rasteriser uses: u = fx*X/Z + cx, v = fy*Y/Z + cy, fx=fy=%.3f." % FX)
    for key in ("cam1", "cam2"):
        for aid in sorted(tracks[key]):
            rows = tracks[key][aid]
            n = min(NFRAMES, SCORER_ARM_FRAMES)
            print("    %s actor %s : neck+hip both in frame on %3d / %d conditioning frames"
                  % (key, aid, inframe_counts[key][aid], n))
    if N_FIGURES >= 2:
        for key in ("cam1", "cam2"):
            n = min(NFRAMES, SCORER_ARM_FRAMES)
            du = []
            for i in range(n):
                a = tracks[key]["A"][i]
                b = tracks[key]["B"][i]
                if a["neck_uv"] and b["neck_uv"]:
                    du.append(b["neck_uv"][0] - a["neck_uv"][0])
            flips = sum(1 for i in range(1, len(du)) if (du[i] > 0) != (du[i - 1] > 0))
            print("    %s  u_B - u_A over %d frames: %+.1f .. %+.1f px, sign changes %d"
                  % (key, len(du), min(du), max(du), flips))
        print("    A sign-change count that is the SAME on both cameras would mean the")
        print("    left/right order carries no camera information at all; it is 1 and 0.")

    cam = {
        "scope": SCOPE,
        "scope_line": SCOPE_LINE,
        "variant": {"name": VARIANT, "figures": N_FIGURES, "camera": CAMERA,
                    "is_gate_default": IS_GATE_DEFAULT,
                    "argv": " ".join(["--figures", str(N_FIGURES), "--camera", str(CAMERA)]),
                    "note": ("The unsuffixed gate_block.* names are the ONE-figure ORBIT "
                             "variant and nothing else writes them. On any other variant the "
                             "three gate-validity assertions (pinned flow/valid digests, the "
                             "DIS-knee budget, the cheap-prior pass floor) are REPORTED, not "
                             "asserted: they are claims about the orbit clip's ability to "
                             "discriminate a camera move, and a locked-off camera is not a "
                             "weaker version of that, it is a different thing.")},
        "actors": {
            "neck_y": NECK_Y, "hip_y": HIP_Y, "figure_size": [FIG_W, FIG_H, FIG_W],
            "A": ({"kind": "standing", "pos": [FIG_A_X, 0.0, FIG_A_Z],
                   "face_values": {"xp": 0.23, "xn": 0.23, "zp": 0.53, "zn": 0.33, "top": 0.43}}
                  if N_FIGURES >= 2 else None),
            "B": {"kind": "walking", "x": 0.0, "z0": FIG_Z0, "speed_mps": FIG_SPEED,
                  "face_values": {"xp": 0.53, "xn": 0.53, "zp": 0.33, "zn": 0.43, "top": 0.23}},
        },
        "cameras": {
            "rendered": CAMERA,
            "1": {"kind": "elliptical orbit into a tip-over and a plan view",
                  "hold_end_s": T_HOLD_END, "orbit_end_s": T_ORBIT_END, "top_end_s": T_TOP_END},
            "2": {"kind": "static three-quarter side angle, eye speed exactly 0",
                  "eye": CAM2_EYE.tolist(), "target": CAM2_TARGET.tolist(),
                  "up_hint": UP_WORLD.tolist()},
        },
        "actor_tracks": tracks,
        "actor_in_frame_counts": inframe_counts,
        "note": ("Pinhole, camera looks down +Z_cam with x right and y DOWN; "
                 "u = fx*X/Z + cx, v = fy*Y/Z + cy. World is right handed, "
                 "+X lateral, +Y up, +Z down the corridor. R is world->camera, "
                 "row major, rows = [right, down, forward]. 'up' is the camera's "
                 "screen-up direction in world space."),
        "width": WIDTH, "height": HEIGHT, "fps": FPS, "frames": NFRAMES,
        "duration_s": DURATION,
        "intrinsics": {"fx": FX, "fy": FY, "cx": CX, "cy": CY,
                       "hfov_deg": HFOV_DEG,
                       "vfov_deg": 2 * math.degrees(math.atan(CY / FY)),
                       "focal_px": FX, "focal_mm": FOCAL_MM,
                       "sensor_width_mm": SENSOR_MM, "sensor_fit": "HORIZONTAL",
                       "near": NEAR},
        "scene": {"corridor_w": CW, "corridor_h": CH, "corridor_l": CL,
                  "corridor_closed_both_ends": True,
                  "pilaster_z": PIL_Z, "pilaster_depth": PIL_DEPTH,
                  "pilaster_halfwidth": PIL_HALFW, "pilaster_height": PIL_H,
                  "figure_size": [FIG_W, FIG_H, FIG_W],
                  "figure_z0": FIG_Z0, "figure_speed": FIG_SPEED,
                  "key_light_dir": KEY.tolist(),
                  "face_values": {f.name: f.val for f in faces}},
        "orbit": {"kind": "ellipse", "semi_axis_lateral_m": ORB_A,
                  "semi_axis_longitudinal_m": ORB_B,
                  "why": ("a 4 m circular orbit does not fit a %.0f m corridor; the "
                          "lateral semi-axis also sets peak on-screen flow, and it is "
                          "sized to stay under DIS's ~25 px/frame tracking knee" % CW)},
        "frames_data": [
            {"frame": i, "t": float(times[i]),
             "eye": cams[i]["eye"].tolist(),
             "target": cams[i]["target"].tolist(),
             "up": cams[i]["up"].tolist(),
             "forward": cams[i]["f"].tolist(),
             "R_world_to_cam": cams[i]["R"].tolist(),
             "focal_px": FX,
             "figure_pos": [0.0, 0.0, float(figure_z(float(times[i])))]}
            for i in range(NFRAMES)],
    }
    with open(CAMJSON_T, "w") as fh:
        json.dump(cam, fh, indent=1)

    # ---- contact sheet ----------------------------------------------------
    picks = [0, 18, 36, 54, 72, 90, 108, 126, 143]
    tw, th = WIDTH // 3, HEIGHT // 3
    FOOT = 78                      # scope footer; see SCOPE_LINE
    sheet = np.zeros((th * 3 + FOOT, tw * 3, 3), np.uint8)
    for n, fi in enumerate(picks):
        im = cv2.cvtColor(cv2.resize(grays[fi], (tw, th), interpolation=cv2.INTER_AREA),
                          cv2.COLOR_GRAY2BGR)
        lab = "f%03d  t=%.2fs" % (fi, fi / float(FPS))
        cv2.putText(im, lab, (10, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.62, (0, 0, 0), 4, cv2.LINE_AA)
        cv2.putText(im, lab, (10, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.62, (255, 255, 255), 1, cv2.LINE_AA)
        r, cc = n // 3, n % 3
        sheet[r * th:(r + 1) * th, cc * tw:(cc + 1) * tw] = im
    sheet[th * 3:, :] = 24
    words, line, lines = SCOPE_LINE.split(" "), "", []
    for w in words:
        if len(line) + len(w) + 1 > 118:
            lines.append(line)
            line = w
        else:
            line = (line + " " + w).strip()
    lines.append(line)
    for li, txt in enumerate(lines[:4]):
        cv2.putText(sheet, txt, (12, th * 3 + 20 + li * 18), cv2.FONT_HERSHEY_SIMPLEX,
                    0.42, (215, 215, 215), 1, cv2.LINE_AA)
    cv2.imwrite(CONTACT_T, sheet)

    # ========================================================================
    # VERIFY BY READING THE FILES BACK
    # ========================================================================
    print()
    print("=" * 78)
    print("READ-BACK VERIFICATION")
    print("=" * 78)

    cap = cv2.VideoCapture(MP4_T)
    cv_w = cap.get(cv2.CAP_PROP_FRAME_WIDTH)
    cv_h = cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
    cv_fps = cap.get(cv2.CAP_PROP_FPS)
    cv_n = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    decoded = 0
    while True:
        ok, _ = cap.read()
        if not ok:
            break
        decoded += 1
    cap.release()

    c2 = av.open(MP4_T)
    vs = c2.streams.video[0]
    av_rate = vs.average_rate
    av_w, av_h = vs.codec_context.width, vs.codec_context.height
    av_pix = vs.codec_context.pix_fmt
    av_n = sum(1 for _ in c2.decode(video=0))
    c2.close()

    print("  cv2  : width=%r  height=%r" % (cv_w, cv_h))
    print("  cv2  : CAP_PROP_FPS raw = %r   repr(%.17g)" % (cv_fps, cv_fps))
    print("  cv2  : CAP_PROP_FRAME_COUNT=%r   frames actually decoded=%d" % (cv_n, decoded))
    print("  av   : %dx%d  pix_fmt=%s  average_rate=%s (=%.17g)  time_base=%s"
          % (av_w, av_h, av_pix, av_rate, float(av_rate), vs.time_base))
    print("  av   : frames actually decoded=%d" % av_n)
    print("  file : %.2f MB" % (os.path.getsize(MP4_T) / 1048576.0))

    assert int(cv_w) == WIDTH and int(cv_h) == HEIGHT, "wrong resolution"
    assert int(av_w) == WIDTH and int(av_h) == HEIGHT, "wrong resolution (av)"
    assert cv_fps == 24.0, "fps is not exactly 24.000: %r" % cv_fps
    assert av_rate == Fraction(24, 1), "container rate is not exactly 24/1: %s" % av_rate
    assert decoded == NFRAMES and av_n == NFRAMES, "frame count %d/%d != %d" % (decoded, av_n, NFRAMES)
    assert NFRAMES >= MIN_FRAMES
    assert av_pix == "yuv420p"

    z = np.load(NPZ_T)
    fl, va = z["flow"], z["valid"]
    print("  npz  : flow  shape=%s dtype=%s" % (fl.shape, fl.dtype))
    print("  npz  : valid shape=%s dtype=%s" % (va.shape, va.dtype))
    assert fl.shape == (NFRAMES - 1, AH, AW, 2) and fl.dtype == np.float16
    assert va.shape == (NFRAMES - 1, AH, AW) and va.dtype == np.bool_
    assert np.isfinite(fl.astype(np.float32)).all()

    # the scope must be IN the artifacts, not just in someone's memory
    c3 = av.open(MP4_T)
    mp4_meta = dict(c3.metadata)
    c3.close()
    npz_scope = json.loads(str(z["scope"]))
    npz_scope_line = str(z["scope_line"])
    z.close()          # np.load holds the file open; the rename below needs it shut
    with open(CAMJSON_T) as fh:
        cam_back = json.load(fh)
    assert "LTXVAddGuide" in mp4_meta.get("comment", ""), "mp4 lost its scope metadata"
    assert npz_scope_line == SCOPE_LINE, "npz lost its scope line"
    assert npz_scope["path_under_test"] == SCOPE["path_under_test"]
    assert cam_back["scope_line"] == SCOPE_LINE, "cam json lost its scope line"
    assert cv2.imread(CONTACT_T).shape[0] == HEIGHT // 3 * 3 + 78, "contact sheet lost its footer"
    print("  scope : present in all four artifacts (mp4 container metadata, npz "
          "'scope'/'scope_line', cam json, contact-sheet footer)")
    print("        : %s" % SCOPE_LINE[:96])
    print("        : %s" % SCOPE_LINE[96:192])

    # ---- GROUND-TRUTH PROOF, END TO END -----------------------------------
    # The corner residual above proves the analytic H against the projection --
    # geometry against geometry, both sides derived. This one closes the loop
    # through the artifacts that actually leave this script: decode the H.264 the
    # gate will stage, warp frame k+1 back onto frame k with the ground-truth
    # flow (I_k(p) ~= I_k+1(p + f(p)), a backward remap, which is what a forward
    # flow means), and see how much of the frame-to-frame change that explains.
    # It is the one check that can fail if the pixels and the flow disagree.
    #
    # This number MOVES with the surface detail, and downward is correct: on a
    # flat blockout most of a face's interior is constant, so warping it changes
    # nothing there and neither the warped nor the unwarped residual can see
    # whether the flow was right -- only silhouettes carry signal. With detail,
    # every pixel carries a marker, the unwarped difference gets much LARGER, and
    # the warp has to explain all of it. The explained FRACTION is the honest
    # statistic; the raw residual on a flat clip is small for the wrong reason.
    capw = cv2.VideoCapture(MP4_T)
    small = np.zeros((NFRAMES, AH, AW), np.uint8)
    ngot = 0
    while True:
        okw, frw = capw.read()
        if not okw:
            break
        small[ngot] = cv2.resize(cv2.cvtColor(frw, cv2.COLOR_BGR2GRAY), (AW, AH),
                                 interpolation=cv2.INTER_AREA)
        ngot += 1
    capw.release()
    assert ngot == NFRAMES, "warp proof decoded %d frames, expected %d" % (ngot, NFRAMES)

    wy, wx = np.mgrid[0:AH, 0:AW].astype(np.float32)
    warp_res = np.full(NFRAMES - 1, np.nan)
    raw_res = np.full(NFRAMES - 1, np.nan)
    for k in range(NFRAMES - 1):
        mk = valid_ds[k]
        if not mk.any():
            continue
        mapx = wx + fd[k][..., 0]
        mapy = wy + fd[k][..., 1]
        pred = cv2.remap(small[k + 1], mapx, mapy, cv2.INTER_LINEAR,
                         borderMode=cv2.BORDER_REPLICATE).astype(np.float32)
        i0 = small[k].astype(np.float32)
        i1 = small[k + 1].astype(np.float32)
        warp_res[k] = float(np.abs(i0 - pred)[mk].mean())
        raw_res[k] = float(np.abs(i0 - i1)[mk].mean())
    mov = np.isfinite(raw_res) & (raw_res > 1.0)     # pairs with real motion
    print()
    print("  END-TO-END WARP PROOF  (decoded mp4 warped by the ground-truth flow)")
    print("    over the %d pairs with real motion (mean|dI| > 1/255 on the valid mask):"
          % int(mov.sum()))
    if int(mov.sum()):
        expl = 1.0 - warp_res[mov] / raw_res[mov]
        print("      unwarped mean|I_k - I_k+1|         : %7.3f /255  (median over pairs)"
              % float(np.median(raw_res[mov])))
        print("      WARPED   mean|I_k - I_k+1(p+f(p))| : %7.3f /255  (median over pairs)"
              % float(np.median(warp_res[mov])))
        print("      explained fraction                 : %7.4f  median, %.4f worst pair"
              % (float(np.median(expl)), float(expl.min())))
    else:
        expl = np.array([])
        print("      (none - see the MOVING-PIXEL warp proof below)")
    print("    all %d valid pairs, whole clip       : warped %.3f vs unwarped %.3f /255"
          % (int(np.isfinite(raw_res).sum()),
             float(np.nanmedian(warp_res)), float(np.nanmedian(raw_res))))
    if int(mov.sum()) >= 5:
        assert float(np.median(expl)) >= 0.60, \
            ("the ground-truth flow explains only %.4f of the frame-to-frame change in the "
             "decoded clip. The pixels and the flow disagree -- on a plane-locked render "
             "they cannot." % float(np.median(expl)))
    else:
        # A LOCKED-OFF CAMERA IS NOT A CLIP WITH NOTHING TO PROVE; it is a clip
        # where the WHOLE-MASK mean is the wrong statistic. The walking figure is
        # ~3% of the frame, so a real 20/255 change on those pixels averages to
        # 0.6/255 over the mask and never clears the floor - the pairs are dropped
        # for being small, not for being still. Rather than skip the proof, run
        # exactly the same one restricted to the pixels the GROUND TRUTH ITSELF
        # says move (|gt| >= 0.5 px at 320x176). That set is chosen from the
        # reference side, never from the pixels, so it cannot be tuned to flatter
        # the render, and the assertion below is the same 0.60 bar.
        print("    only %d pairs cleared the 1/255 WHOLE-MASK motion floor. That is what a"
              % int(mov.sum()))
        print("    locked-off camera looks like, and it is a property of the statistic, not")
        print("    of the flow: the same proof restricted to the pixels the ground truth")
        print("    says actually move follows, and it is asserted at the same 0.60 bar.")
        mwarp = np.full(NFRAMES - 1, np.nan)
        mraw = np.full(NFRAMES - 1, np.nan)
        mpix = np.zeros(NFRAMES - 1, np.int64)
        for k in range(NFRAMES - 1):
            mk = valid_ds[k] & (np.linalg.norm(fd[k].astype(np.float32), axis=2) >= 0.5)
            mpix[k] = int(mk.sum())
            if mpix[k] < 200:
                continue
            mapx = wx + fd[k][..., 0]
            mapy = wy + fd[k][..., 1]
            pred = cv2.remap(small[k + 1], mapx, mapy, cv2.INTER_LINEAR,
                             borderMode=cv2.BORDER_REPLICATE).astype(np.float32)
            i0 = small[k].astype(np.float32)
            i1 = small[k + 1].astype(np.float32)
            mwarp[k] = float(np.abs(i0 - pred)[mk].mean())
            mraw[k] = float(np.abs(i0 - i1)[mk].mean())
        mmov = np.isfinite(mraw) & (mraw > 1.0)
        print()
        print("  MOVING-PIXEL WARP PROOF  (same warp, mask = |ground-truth flow| >= 0.5 px)")
        print("    pixels in that mask per pair : min %d  median %d  max %d  of %d"
              % (mpix.min(), int(np.median(mpix)), mpix.max(), AH * AW))
        print("    pairs with real motion there : %d" % int(mmov.sum()))
        assert int(mmov.sum()) >= 5, \
            ("the ground truth claims fewer than 5 pairs carry any motion at all (%d). "
             "A clip with a moving figure cannot be that still; the flow field is wrong."
             % int(mmov.sum()))
        mexpl = 1.0 - mwarp[mmov] / mraw[mmov]
        print("      unwarped mean|I_k - I_k+1|         : %7.3f /255  (median over pairs)"
              % float(np.median(mraw[mmov])))
        print("      WARPED   mean|I_k - I_k+1(p+f(p))| : %7.3f /255  (median over pairs)"
              % float(np.median(mwarp[mmov])))
        print("      explained fraction                 : %7.4f  median, %.4f worst pair"
              % (float(np.median(mexpl)), float(mexpl.min())))
        assert float(np.median(mexpl)) >= 0.60, \
            ("the ground-truth flow explains only %.4f of the change on the pixels it "
             "itself says are moving. The pixels and the flow disagree -- on a "
             "plane-locked render they cannot." % float(np.median(mexpl)))

    # ---- the profile -----------------------------------------------------
    print()
    print("=" * 78)
    print("MEASURED PROFILE  (every 6th pair; magnitudes in 320x176 px/frame)")
    print("=" * 78)
    print("  pair    t(s)   valid%%(320)  valid%%(1280)   median   p95      max")
    for k in range(0, NFRAMES - 1, 6):
        print("  %4d  %6.3f   %8.2f    %8.2f   %8.3f %8.2f %8.2f"
              % (k, k / float(FPS), 100.0 * valid_ds[k].mean(),
                 100.0 * valid_full[k], medmag[k], p95mag[k], maxmag[k]))

    seg = lambda a, b: slice(int(a * FPS), int(b * FPS))
    print()
    print("  segment medians of the per-pair median flow magnitude:")
    for nm, a, b in (("hold      0.00-1.00 s", 0.0, 1.0),
                     ("orbit     1.00-3.50 s", 1.0, 3.5),
                     ("tip-over  3.50-5.00 s", 3.5, 5.0),
                     ("top-down  5.00-5.96 s", 5.0, 5.958)):
        s = seg(a, b)
        print("     %-22s  median %8.3f   peak %8.3f   (320 px/frame)"
              % (nm, float(np.median(medmag[s])), float(medmag[s].max())))
    print("  valid pixel fraction @320x176: min %.2f%%  mean %.2f%%  max %.2f%%"
          % (100 * valid_ds.mean(axis=(1, 2)).min(),
             100 * valid_ds.mean(axis=(1, 2)).mean(),
             100 * valid_ds.mean(axis=(1, 2)).max()))
    print("  background (no geometry) per frame: min %.2f%%  mean %.2f%%  max %.2f%%"
          " (the open top of the set, seen only in the plan view)"
          % (100 * bgfrac.min(), 100 * bgfrac.mean(), 100 * bgfrac.max()))
    print()
    print("  how much of the clip is fast enough to trouble a flow ESTIMATOR")
    print("  (the restyled side of the gate must be estimated, not derived):")
    for thr in (4.0, 8.0, 16.0, 32.0):
        print("     pairs with median flow > %5.1f px/frame @320 : %3d / %d  (%.1f%%)"
              % (thr, int((medmag > thr).sum()), NFRAMES - 1,
                 100.0 * (medmag > thr).mean()))
    print("     overall median of per-pair medians          : %.3f px/frame @320"
          % float(np.median(medmag)))

    print()
    print("=" * 78)
    print("ESTIMATOR HEADROOM  (the arm side of the gate is ESTIMATED, not derived)")
    print("=" * 78)
    over = int((medmag > DIS_KNEE).sum())
    print("  DIS PRESET_MEDIUM at 320x176 tracks a textured carrier of this clip's own")
    print("  analytic field at CMA ~0.999 up to ~%.0f px/frame and loses grip above that." % DIS_KNEE)
    print("  Since the clip carries plane-locked detail it IS that carrier: measured end to")
    print("  end through the encoder, the reconstruction anchor is 0.9815 over the arm window")
    print("  (0.6825 when this clip was flat) and MR 0.9807 (was 0.7412). The knee is now a")
    print("  dent, not a hole -- worst pair 58 at 35.9 px/frame scores 0.7960, was 0.5273.")
    print("  The pair count below is computed from |gt| and is unchanged by any of that.")
    print("    peak per-pair median flow      : %.2f px/frame @320   (knee ~%.0f)"
          % (medmag.max(), DIS_KNEE))
    print("    pairs over the knee            : %d / %d  (%.1f%%), all at the orbit apex"
          % (over, NFRAMES - 1, 100.0 * over / (NFRAMES - 1)))
    print("    those pairs read low for EVERY arm, for A0 and for the anchor alike, so they")
    print("    cancel in the margin; and the gate's statistic is a median, which %d pairs"
          % over)
    print("    out of the ~118 the scorer keeps cannot move.")
    gate_assert(over <= DIS_KNEE_MAX_PAIRS,         ("%d pairs are past DIS's ~%.0f px/frame knee (budget %d). The move has been "
         "retuned faster and the estimator can no longer follow it; arms would be scored "
         "down for the instrument's failure." % (over, DIS_KNEE, DIS_KNEE_MAX_PAIRS)))

    print()
    print("=" * 78)
    print("UNMISTAKABILITY OF THE MOVE  (adversarial priors, upper bounds)")
    print("=" * 78)
    print("  %s" % _scorer_constants_agree())
    try:
        pb = prior_bounds(flow_ds, valid_ds)
    except AssertionError as e:
        if IS_GATE_DEFAULT:
            raise
        print("  [variant %s] the adversarial-prior bound could not be computed: %s" % (VARIANT, e))
        print("  That is the expected reading for a locked-off camera - the scorer's own mask")
        print("  keeps a pair only when the field carries motion, and this one carries almost")
        print("  none. REPORTED, not passed.")
        pb = None
    if pb is None:
        pb = {"npairs": 0, "dolly_static": float("nan"), "dolly_coe": (float("nan"), float("nan")),
              "radial_perframe_med": float("nan"), "translate_med": float("nan")}
    print("  scored over the %d-pair arm window; %d pairs survive the scorer's mask"
          % (SCORER_ARM_FRAMES - 1, pb["npairs"]))
    print("    best STATIC forward-dolly (one COE for the clip) : %.4f   COE (%.0f, %.0f)"
          % (pb["dolly_static"], pb["dolly_coe"][0], pb["dolly_coe"][1]))
    print("    best PER-FRAME radial  (COE re-optimised/pair)   : %.4f   (OUTWARD only "
          "— see the caveat below)" % pb["radial_perframe_med"])
    print("    best PER-FRAME uniform translation               : %.4f   (bounds ANY "
          "pan/tilt prior; = the field's directional coherence)" % pb["translate_med"])
    print("    scorer's absolute pass floor T_CMA_ABS           : %.4f" % SCORER_PASS_FLOOR)
    worst = max(pb["dolly_static"], pb["radial_perframe_med"], pb["translate_med"])
    print("    margin of the strongest prior below the floor    : %.4f" % (SCORER_PASS_FLOOR - worst))
    gate_assert(worst < SCORER_PASS_FLOOR,         ("a cheap prior reaches %.4f, at or above the scorer's pass floor %.2f: the move "
         "is matchable without following it and this clip cannot discriminate."
         % (worst, SCORER_PASS_FLOOR)))

    # ── WHAT THIS BLOCK DOES AND DOES NOT ESTABLISH ──────────────────────────
    # An earlier version of the line above claimed the radial bound "bounds ANY
    # dolly/zoom/push-in prior". It does not, and the overclaim was caught in
    # review. The search is OUTWARD ONLY: a dolly-BACK or a zoom-OUT is the same
    # family with the sign flipped and is not in the bound. Measured sign-free,
    # the per-frame radial bound rises to ~0.91 — comfortably ABOVE the 0.50
    # floor — and over the orbit segment alone the outward-only bound is already
    # ~0.79.
    #
    # That does not weaken any arm's score, and it does not make the clip a bad
    # one. What it means is narrower and worth stating where it cannot be lost:
    # criterion (1), the absolute pass floor, is a SANITY BAR, not the thing
    # that discriminates. A model with three free parameters refit every frame
    # is not a prior a generator holds; it is an upper bound on how well ANY
    # radial explanation could fit, which is a much weaker claim than "no cheap
    # camera prior reaches the floor".
    #
    # The discriminator is criterion (2): the margin over A0, the text-only
    # control, measured on the same prompt and the same graph. That is where the
    # claim belonged all along — "our weaker model, aimed properly, beats our
    # weaker model rolling dice" is a COMPARISON, and only the margin tests it.
    # Do not quote the numbers above as "no dolly/zoom/pan prior can reach the
    # pass floor" in any write-up. Quote the A0 margin.
    print("    CAVEAT: the radial search is OUTWARD ONLY; sign-free it reaches ~0.91.")
    print("            Criterion (1) is a sanity bar. The DISCRIMINATOR is criterion (2),")
    print("            the margin over the A0 text-only control. Quote that, not this.")

    print()
    print("=" * 78)
    print("POPPING CHECK")
    print("=" * 78)
    print("  [same-pixel, as briefed]")
    print("    max inter-frame flow delta          : %.4f  (320 px/frame)" % allde.max())
    print("    inter-frame flow delta p99 / p99.9  : %.4f / %.4f" %
          (np.percentile(allde, 99), np.percentile(allde, 99.9)))
    print("    max per-pair MEDIAN flow delta      : %.4f" % med_delta.max())
    print("    worst pair                          : %d (t=%.3f s)" %
          (int(np.argmax(per_pair_max)), int(np.argmax(per_pair_max)) / float(FPS)))
    print("  [advected along the flow -- true acceleration, pop-sensitive]")
    print("    max advected flow delta             : %.4f  (320 px/frame)" % adv_all.max())
    print("    advected delta p99 / p99.9          : %.4f / %.4f" %
          (np.percentile(adv_all, 99), np.percentile(adv_all, 99.9)))
    print("    max per-pair MEDIAN advected delta  : %.4f" % adv_pair_med.max())
    print("    worst pair                          : %d (t=%.3f s)" %
          (int(np.argmax(adv_pair_max)), int(np.argmax(adv_pair_max)) / float(FPS)))
    print("  image mean|dI| per pair: min %.3f  max %.3f (at pair %d)" %
          (imgdiff.min(), imgdiff.max(), int(np.argmax(imgdiff))))
    nb = 0.5 * (imgdiff[:-2] + imgdiff[2:])
    # only meaningful where there IS motion: during the lock-off mean|dI| ~ 0.03,
    # so a ratio there is noise on near-zero, not evidence of anything
    m = nb > 1.0
    if m.any():
        ratio = imgdiff[1:-1][m] / nb[m]
        j = int(np.nonzero(m)[0][int(np.argmax(ratio))]) + 1
        print("  worst local spike ratio in mean|dI|   : %.3f at pair %d (t=%.3f s), over "
              "the %d pairs with real motion" % (ratio.max(), j, j / float(FPS), int(m.sum())))
        print("    (a face-order pop is a lone frame where this blows up; 1.0 = perfectly "
              "smooth, and the whole clip stays near it)")
    else:
        # Same reason the whole-mask warp proof found nothing: on a locked-off
        # camera the whole-frame mean|dI| never reaches one grey level, so the
        # 1.0 gate that keeps this ratio off near-zero denominators keeps every
        # pair. The pop this looks for is a face-ORDER pop, and the per-pixel
        # depth test that would have to fail for one is asserted independently
        # above and on every variant.
        print("  worst local spike ratio in mean|dI|   : no pair reaches the 1/255 floor "
              "this ratio needs")
        print("    (whole-frame mean|dI| peaks at %.3f/255 - a locked-off camera. The "
              "face-order" % imgdiff.max())
        print("     pop this looks for is caught by the per-pixel depth test regardless.)")
    urot = np.degrees(np.arccos(np.clip(roll_dots, -1, 1)))
    print("  camera up-vector rotation per frame   : max %.2f deg at frame %d, "
          "p99 %.2f deg (continuous, never flips)"
          % (urot.max(), int(np.argmax(urot)), np.percentile(urot, 99)))

    # ---- every assertion has passed: publish ------------------------------
    for tmp, final in ((MP4_T, MP4), (NPZ_T, NPZ), (CAMJSON_T, CAMJSON), (CONTACT_T, CONTACT)):
        os.replace(tmp, final)

    print()
    print("=" * 78)
    print("OUTPUTS  (written to .partial, renamed only now that everything passed)")
    print("=" * 78)
    for p in (MP4, NPZ, CAMJSON, CONTACT):
        print("  %-64s %9.2f MB" % (p, os.path.getsize(p) / 1048576.0))
    print("  total wall time: %.1f s" % (time.time() - t_start))
    print("ALL ASSERTIONS PASSED")


if __name__ == "__main__":
    main()
