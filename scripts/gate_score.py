#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
gate_score.py - CMA (Camera-Move Adherence) and companions for the VFX motion
                parity gate. Pure CPU: cv2 + numpy + matplotlib. No GPU, no
                ComfyUI, no model, no network.

WHAT THIS GATE IS ABOUT, AND WHAT IT IS NOT ABOUT  (read before quoting a number)
--------------------------------------------------------------------------------
The only conditioning path exercised here is LTXVAddGuide: literal source frames
are VAE-encoded and written into the latent as an APPEARANCE guide. There is no
structure/appearance separation anywhere in that path -- the model is handed
pixels, not a depth map, a pose or a control signal it can read as geometry.

  A NEGATIVE result here means: sparse APPEARANCE guides cannot carry gray-box
  blocking. It does NOT mean "control video does not work locally".
  A POSITIVE result here does NOT transfer to VACE-style structural
  conditioning, which is a different mechanism and has zero bytes on this disk.

Paths NOT tested (none of them are installed): WAN VACE (structural
conditioning), depth/pose ControlNet (the estimators are zero-byte
placeholders), MiniMax H3 (no strength input). That sentence is written into
every JSON artefact and printed under every table by design, so a write-up
weeks from now cannot make the broad claim from the files alone.

THE REFERENCE SIDE IS GROUND TRUTH, THE ARM SIDE IS AN ESTIMATE
---------------------------------------------------------------
gate_block.py computes the blocking clip's flow ANALYTICALLY: every face is a
planar quad, so its frame t -> t+1 mapping is exactly the plane-induced
homography H = K (Rrel + trel n1^T / d1) K^-1. The clip is a flat gray blockout
with almost no texture, so a flow ESTIMATOR on the reference side would be
ill-posed (aperture problem) in precisely the large smooth regions that carry
the camera move. That asymmetry -- derived reference, estimated arm -- is the
entire reason the number is trustworthy.

CONVENTIONS, COPIED FROM gate_block.py AND ASSERTED AT LOAD
-----------------------------------------------------------
  gate_block_flow.npz
    'flow'  (143, 176, 320, 2) float16   'valid' (143, 176, 320) bool
    flow[k] maps frame k -> frame k+1.
    Units are 320x176 pixels (gate_block.downsample() already multiplied by
    0.25). flow[...,0] = dx, flow[...,1] = dy, +x right, +y DOWN.
    Invalid entries are exactly 0.0; a 320x176 pixel is valid only if all 16
    contributing 1280x704 pixels were valid.
  cv2.DISOpticalFlow.calc(I0, I1) returns forward flow from I0 to I1 in the SAME
    convention (dx, dy; +x right, +y down), so there is no sign flip anywhere in
    this file. --ceiling proves that empirically: it prints CMA(+est) and
    CMA(-est), and a flip would show up as a large-magnitude NEGATIVE ceiling.

THE METRIC
----------
  CMA  magnitude-weighted mean cosine between the ground-truth flow and the
       DIS-estimated flow of an arm's output, per frame pair, over the pixels
       the camera actually moves, taken as the MEDIAN across the clip.
       Range [-1,+1]; independent random directions expect 0.
  MR   magnitude ratio, median(|est|[mask]) / median(|gt|[mask]), medianed over
       frames. Direction alone is not survival: a move at 10% of blocked speed
       is a drift.
  SSIM_block  the ANTI-DEGENERACY GUARD. An arm scoring CMA 0.95 by reproducing
       the gray boxes has not passed, it has failed to generate.
  lag  CMA at frame offsets -4..+4. A peak off zero means the move was followed
       but mistimed -- a different, far more fixable result than "ignored".
  NULL measured, not assumed. Both clips can share a net drift for a stretch and
       correlate a little for reasons unrelated to adherence; assuming NULL = 0
       would quietly inflate every arm.
  traj confirmatory. goodFeaturesToTrack -> LK -> estimateAffinePartial2D, then
       Pearson r on the PER-FRAME STEPS against the blocking clip's steps.
       NOT on the cumulative sums: cumulative channels are drift-dominated and
       a straight line carrying zero camera information scores r = +0.93 (tx) /
       +0.81 (ty) / +0.90 (theta) against this clip -- i.e. cumulative r
       confirms precisely the failure the channel was added to detect. On steps
       the same meaningless series scores -0.13 / +0.02 / -0.04. The cumulative
       curves are still PLOTTED, where they are genuinely readable.
       CONFIRMATORY ONLY, never a pass criterion, and its noise floor is neither
       1.0 nor fixed: it is RENDER-DEPENDENT, measured by scoring a re-encode of
       the source frames as if it were an arm (+0.10/+0.65/-0.07 on blocking
       render d54a5791; +0.73/+0.84/+0.88 on a later, better-covered one).
       See traj_r_steps().

MODES
  --ceiling          DIS-vs-ground-truth on the blocking clip itself. Costs
                     nothing and runs before any GPU time. It produces the
                     RECONSTRUCTION ANCHOR, not a ceiling on arms -- see below.
  --score <arm-dir>  score every mp4 (= one seed) in one arm directory.
  --report           read all arm JSONs, apply the pass rule, print the table,
                     and PRINT AN EXPLICIT VERDICT (green / decisive negative /
                     no result), which is the one interpretive judgement this
                     instrument exists to make. Two things it will NOT do:
                     declare GREEN on an arm the run itself disqualified or whose
                     residual strength is 0.00 (verdict branch (e)), and call a
                     DECISIVE NEGATIVE on a calibrator that did not actually
                     reconstruct the source, however high its CMA (branch (g)).
  --root <dir>       where the arm directories live. ONE FAMILY PER ROOT.
  --control <arm>    criterion-2 baseline. Defaults to the family's, or to what
  --degenerate <arm> criterion-5 calibrator.   the run itself declared in
                     <root>/gate_controls.json. A flag that CONTRADICTS a
                     declaration is a hard error, not a silent override.
  --anchor <path>    a reconstruction anchor measured in another root. Legal
                     because the anchor describes the BLOCKING CLIP and the
                     METRIC, not the model -- and source_consistency proves the
                     anchor and the arms share one blockout.

TWO RUNS, TWO FAMILIES, AND THE MISTAKE THAT WOULD LOOK LIKE AN ANSWER
----------------------------------------------------------------------
Arm ids carry a family letter: A* are LTX 2.5 sparse appearance guides
(scripts/gate_run.mjs), W* are WAN 2.1 VACE scaled residuals
(scripts/vace_run.mjs). Criterion (2) is "CMA >= <control> + margin", and the
control used to be the literal "A0". Scoring a W arm against A0 would compare
two MODELS while every heading, column and verdict said it was comparing two
CONDITIONING PATHS -- and the output would look completely normal. So: one
family per root (a mixed root is refused), the run declares its own control in
gate_controls.json, the family is ALSO re-derived from the arm ids, and a
control from another family is refused by name. See FAMILIES and
resolve_controls().

THE ANCHOR IS NOT A CEILING ON ARM SCORES
-----------------------------------------
In --score, DIS runs on the ARM's frames only; the blocking clip is touched for
SSIM and the LK trajectory and nowhere else. An arm's CMA is therefore bounded
by the texture of the ARM's own output -- a restyled corridor with lights, haze
and grain -- not by the blockout's flatness. The --ceiling number bounds exactly
ONE hypothetical arm: the degenerate reconstruction arm (A4) that hands back the
gray boxes. So it is named CMA_reconstruction_anchor, and it is measured over
the 120 frame pairs an arm can actually occupy (an arm is 121 frames; gt pairs
120..142 are the top-down settle, the highest-scoring stretch of the clip, and
no arm can ever reach them). The all-143-pair figure is kept only as a secondary
descriptive field for the blocking clip; dividing arm scores by it understates
every arm by ~7%.
"""

import argparse
import glob
import hashlib
import json
import math
import os
import re
import sys
import time

import numpy as np
import cv2

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# ---------------------------------------------------------------------------
# THE THREE NUMBERS (see gate_block.py: restyleGraph ignores the source fps,
# guides index by ABSOLUTE frame number, ImageFromBatch CLAMPS out of range)
# ---------------------------------------------------------------------------
WIDTH, HEIGHT = 1280, 704
FPS = 24
BLOCK_FRAMES = 144
ARM_FRAMES = 121           # EmptyLTXVLatentVideo length in every arm graph
AW, AH = 320, 176          # analysis resolution, exactly 1/4 of 1280x704

GATE = r"D:\AI\aiplay-studio-bench\ComfyUI\output\gate"
BLOCK_MP4 = os.path.join(GATE, "gate_block.mp4")
BLOCK_NPZ = os.path.join(GATE, "gate_block_flow.npz")
SCORE_NAME = "gate_score.json"
CEIL_NAME = "gate_ceiling.json"
REPORT_NAME = "gate_report.json"
CEIL_JSON = os.path.join(GATE, CEIL_NAME)   # default; --report resolves under --root

# ---------------------------------------------------------------------------
# SCOPE -- written into every artefact this file produces (see the header).
# The point is that no artefact can be read later as a verdict on "control
# video" in general when it is a verdict on one appearance-guide path.
# ---------------------------------------------------------------------------
SOURCE_CLIP_NOTE = ("flat gray Blender-style playblast, deliberately untextured: "
                    "the conditioning source must stay faithful to the real "
                    "workflow (show_overlays/show_gizmo off = flat solid "
                    "shading), so no synthetic surface detail is added to it")

# ---------------------------------------------------------------------------
# ARM FAMILIES.
#
# An arm id's LETTER PREFIX names the model and conditioning path it came from:
# A* are LTX 2.5 sparse appearance guides (scripts/gate_run.mjs), W* are WAN 2.1
# VACE scaled residuals (scripts/vace_run.mjs). This is not decoration.
#
# ⚠⚠ THE SINGLE MISTAKE THIS FILE MUST MAKE IMPOSSIBLE. ⚠⚠
#
# Criterion (2) is "CMA >= <control> + margin", and the control used to be the
# literal string "A0". A0 is an LTX render. Score a W arm against it and the
# report compares two MODELS while every heading, every column and the verdict
# say it is comparing two CONDITIONING PATHS -- and nothing in the output would
# look wrong. That is a confident wrong answer, which is worse than no answer.
#
# So the control is now named rather than assumed, and it is named three ways
# that have to agree:
#   1. each run writes into its OWN root, so this file's glob cannot see the
#      other family's arms at all;
#   2. a run drops gate_controls.json in that root NAMING its control and its
#      degeneracy calibrator, and --report reads and obeys it (a --control flag
#      that disagrees is a hard error, never a silent override);
#   3. the family is ALSO derived independently from the arm ids present, and a
#      root that mixes families -- or a control from another family -- is
#      refused outright.
#
# Each family carries its own SCOPE, because the scope sentence is stamped into
# every artefact and an LTX scope on a WAN number is exactly the kind of quiet
# mislabelling the whole caveat mechanism exists to prevent.
# ---------------------------------------------------------------------------
FAMILIES = {
    "A": {
        "label": "LTX 2.5 sparse appearance guides (LTXVAddGuide) vs text-only",
        "control": "A0",
        "degenerate": "A4",
        "cond_node": "LTXVAddGuide",
        # NO derived zero-strength bar for this family, and that is a statement
        # about the mechanism rather than an omission. LTXVAddGuide has no single
        # residual scale: `strength` is PER GUIDE and an arm carries one to
        # sixteen of them, so there is no one number whose being 0.00 proves the
        # arm carried nothing. The A arms are barred by declaration only.
        "zero_strength_bar": False,
        # HOW TO MAKE THIS FAMILY'S CALIBRATOR ACTUALLY RECONSTRUCT. Printed by
        # verdict branch (g), which fires exactly when it did not -- so the
        # remedy has to be the one that belongs to the mechanism under test, not
        # the other family's.
        "degenerate_recipe": ("a guide at EVERY frame at the highest strength in "
                              "the sweep -- LTXVAddGuide overwrites the latent at "
                              "the guided indices, so density and strength are the "
                              "whole knob (A4: 16 guides every 8 frames at 0.70 "
                              "reached SSIM_block 0.914)"),
        "scope": {
            "path_tested": ("LTXVAddGuide -- literal source frames VAE-encoded "
                            "into the latent as an APPEARANCE guide; no "
                            "structure/appearance separation"),
            "paths_not_tested": [
                # Corrected after reading comfy_extras/nodes_wan.py and
                # comfy/ldm/wan/model.py: VACE is NOT "structural" conditioning.
                # It VAE-encodes literal pixels too (nodes_wan.py:341-343). What
                # differs is that it adds them as a scaled residual instead of
                # overwriting the denoising latent. Saying "structural" here
                # would have set up the WAN run to be read as testing something
                # it does not test.
                "WAN VACE -- a SCALED ADDITIVE RESIDUAL of VAE-encoded control "
                "frames (x += c_skip * vace_strength), NOT structural "
                "conditioning; tested separately by scripts/vace_run.mjs",
                "depth / pose ControlNet -- the estimators are zero-byte placeholders",
                "MiniMax H3 -- no strength input",
            ],
            "reads_as": ("A NEGATIVE here means sparse APPEARANCE guides cannot "
                         "carry gray-box blocking -- NOT that control video does "
                         "not work locally. A POSITIVE here does NOT transfer to "
                         "VACE's residual injection."),
            "source_clip": SOURCE_CLIP_NOTE,
        },
    },
    "W": {
        "label": ("WAN 2.1 VACE 1.3B scaled additive residual (WanVaceToVideo) "
                  "vs text-only on the SAME model"),
        "control": "W0",
        # W9, not W6. W6 was strength 16.00 -- degenerate by OUT-OF-RANGE GAIN,
        # which comfy/ldm/wan/model.py says cannot work: every consumer of x
        # LayerNorms it and the VACE stream is computed from x_orig, so raising
        # the strength drives the output to a FIXED LIMIT rather than towards the
        # control clip (measured in scripts/vace_saturation.py: at strength 16 the
        # output is already within 19% of its s->infinity limit, at 64 within 5%).
        # W9 is degenerate by TRAINED BEHAVIOUR instead: control_masks all zeros
        # at strength 1.00, which makes the clip `inactive` -- the footage VACE
        # was trained to PRESERVE (nodes_wan.py:341-343).
        "degenerate": "W9",
        "cond_node": "WanVaceToVideo",
        # THE DERIVED BAR APPLIES HERE, AND IT MUST NEVER FALL OPEN QUIETLY.
        # WanVaceToVideo has exactly one residual scale and it appears exactly
        # once (x += c_skip * vace_strength, comfy/ldm/wan/model.py:854), so
        # strength 0.00 is a proof that the arm carried nothing. With this True,
        # resolve_controls REFUSES to report an arm whose strength neither the
        # dispatched graph nor gate_controls.json can supply -- a silently-open
        # bar is how the zero-strength null becomes eligible for GREEN.
        "zero_strength_bar": True,
        "degenerate_recipe": ("control_masks ALL ZEROS at the trained strength "
                              "1.00, which makes the clip `inactive` -- footage to "
                              "PRESERVE (nodes_wan.py:341-343, and ComfyUI's own "
                              "outpainting template wires exactly that polarity, "
                              "mask 0 over the frame it keeps). Cranking `strength` "
                              "cannot substitute: every consumer of x LayerNorms it "
                              "and the VACE stream is computed from x_orig, so the "
                              "output converges to a fixed limit "
                              "(scripts/vace_saturation.py). If an all-zero mask is "
                              "itself too far out of distribution, go one step in: "
                              "a PARTIAL mask, most of the frame zero and a strip "
                              "of ones, which is interior to the inpainting task "
                              "VACE was trained on"),
        "scope": {
            "path_tested": ("WanVaceToVideo -> VaceWanModel -- the control clip is "
                            "VAE-ENCODED (nodes_wan.py:341-343; with control_masks "
                            "absent the mask is ones, so `reactive` IS the clip) and "
                            "injected as a SCALED ADDITIVE RESIDUAL through a "
                            "parallel vace_block stack: x += c_skip * vace_strength "
                            "(comfy/ldm/wan/model.py:854). Every arm UNDER TEST "
                            "leaves control_masks absent; the ONE arm that supplies "
                            "a mask is W9, the degeneracy calibrator, and it is "
                            "disqualified from passing"),
            "paths_not_tested": [
                "LTX sparse appearance guides -- a DIFFERENT run, a different "
                "model; A-arm numbers are not comparable to these",
                "depth / pose ControlNet -- the estimators are zero-byte placeholders",
                "VACE INPAINTING (a partial control_mask, some region reactive and "
                "some inactive) -- the only mask in this run is W9's all-zero "
                "calibrator, which is the opposite extreme and cannot pass",
                "VACE with a reference_image -- never supplied, so trim_latent is 0",
                "WAN 14B VACE -- only the 1.3B is on this disk",
            ],
            "reads_as": ("NOT structure-vs-appearance: both paths VAE-encode "
                         "literal pixels. What differs is that LTXVAddGuide writes "
                         "them INTO the denoising latent while VACE leaves the "
                         "latent as noise and PUSHES it with a scaled residual. A "
                         "NEGATIVE here means that residual does not steer this "
                         "model's camera at any strength sampled -- NOT that "
                         "structural conditioning (depth/pose) fails. Rendered at "
                         "1280x704, off WAN 1.3B's 832x480 native, so that the "
                         "control video reaches the VAE uncropped and the analytic "
                         "ground truth stays valid."),
            "source_clip": SOURCE_CLIP_NOTE,
        },
    },
}

FAMILY_RE = re.compile(r"^([A-Za-z]+)")
DEFAULT_FAMILY = "A"


def arm_family(arm_id):
    """The family letter of an arm id, or None if it does not name one."""
    m = FAMILY_RE.match(str(arm_id or ""))
    if not m:
        return None
    fam = m.group(1).upper()
    return fam if fam in FAMILIES else None


# The ACTIVE scope. Rebound by set_family() so every artefact this process
# writes carries the caveat that belongs to the arms it just measured. The
# default is the LTX family, which is what an --score/--ceiling invocation with
# no family information gets -- exactly today's behaviour.
SCOPE = FAMILIES[DEFAULT_FAMILY]["scope"]
FAMILY = DEFAULT_FAMILY


def set_family(fam):
    global SCOPE, FAMILY                                   # noqa: PLW0603
    FAMILY = fam if fam in FAMILIES else DEFAULT_FAMILY
    SCOPE = FAMILIES[FAMILY]["scope"]
    return FAMILY


def scope_lines():
    return ["SCOPE: %s" % SCOPE["path_tested"], "       %s" % SCOPE["reads_as"]]

# ---------------------------------------------------------------------------
# METRIC PARAMETERS
# ---------------------------------------------------------------------------
MAG_FLOOR = 0.75     # px/frame @320x176; ~2x DIS sub-pixel noise at this res,
                     # so the mask contains motion and not jitter
MIN_COV = 0.05       # skip a pair whose moving mask is under 5% of frame
                     # (the static opening second contributes nothing)
LAGS = list(range(-4, 5))
NULL_NSHIFT = 20
NULL_MIN_OFF = 12    # circular shifts at least 12 frames from zero
NULL_SEED = 20260901  # FIXED, so NULL is reproducible

# PASS RULE
T_CMA_ABS = 0.50      # cos(60 deg): halfway between chance and perfect
T_MARGIN = 0.25       # over A0's median CMA -- the margin IS the claim
T_SPREAD = 0.15       # if A0/A1 seed spread exceeds this, margin -> 2*spread
T_MR_LO, T_MR_HI = 0.4, 2.5   # asymmetric-tolerant: DIS systematically
                              # UNDER-estimates flow on soft generated content
T_SSIM_MARGIN = 0.25  # SSIM_block <= A4's SSIM_block - 0.25; self-calibrating,
                      # and A4 therefore cannot pass, by design

# WHAT COUNTS AS "THE CALIBRATOR RECONSTRUCTED THE SOURCE".
#
# The degenerate arm's whole job is to prove the control pixels reach the
# output, so that a table of failures can be read as "the path transports the
# move and generation discards it" instead of "the instrument is blind". That
# proof needs TWO things and used to be granted on one:
#
#   ABSOLUTE. SSIM_block >= 0.70. Measured on this blockout: the LTX text-only
#   control A0 -- generating freely, conditioned on nothing -- still scored
#   SSIM_block 0.442 against the gray boxes, because a flat gray render
#   correlates with a flat gray render. The LTX degenerate A4, which really did
#   hand the source back, scored 0.914. 0.70 sits above every free-running arm
#   measured on this clip and below every genuine reconstruction.
#
#   RELATIVE. SSIM_block - T_SSIM_MARGIN > the CONTROL arm's own SSIM_block.
#   This is the same quantity criterion (5) uses as its bar, and it must clear
#   the score a normally-generating arm already earns -- otherwise the guard is
#   not a guard, it is a universal fail (see apply_pass_rule).
#
# Both, because either alone is fooled: a low-SSIM control makes the relative
# test cheap, and a clip whose gray floor is high makes the absolute test cheap.
T_RECON_SSIM = 0.70

# RESAMPLING TOLERANCE. A clip whose frame count differs from ARM_FRAMES is
# nearest-in-time resampled; beyond half a frame period that is no longer an
# alignment, it is a fabrication. Measured on a real 100-frame truncation of
# this clip: max error 0.875 s, a tail of 21 frozen frames, and CMA 0.5635 --
# above the 0.50 floor, above its own NULL (0.134), MR 0.617 inside the band,
# i.e. it meets criteria (1), (3) and (4) and sits mid-table looking ordinary.
# (On a later render of the same shot the same truncation scored 0.7390, 94% of
# the anchor -- one of the strongest rows.) Such an arm is now INVALID.
RESAMPLE_TOL_S = 1.0 / 48.0

# VERDICT PARAMETERS (--report). See verdict_of().
VERDICT_ANCHOR_TOL = 0.15   # how far below the reconstruction anchor A4's CMA
                            # may sit and still count as "the guide path
                            # transported the move". Generous on purpose: A4 is
                            # a diffusion output, not a byte copy. For scale,
                            # H.264 CRF14 alone costs ~0.003 CMA (measured).

# INSTRUMENT FLOOR (--ceiling). NOT a go/no-go on GPU time -- it cannot be: the
# anchor bounds no arm but the degenerate one. It is a self-check on the METRIC.
# Calibrated against the quantity this same run measures: NULL, the score the
# very same DIS estimate earns against the WRONG point in time (max over 20
# fixed-seed circular shifts), measured at 0.2684 on this clip. An instrument
# that cannot clear ~1.5x its own NULL on the degenerate case is seeing almost
# nothing, and the first suspects are the mask floor and the analysis
# resolution. Measured anchor for scale: 0.6825.
#
# NOT calibrated on "adversarial priors top out at 0.37", which is in the review
# notes but does NOT reproduce here. Measured today under this scorer's own mask
# over the 95 surviving arm-window pairs: a STATIC radial prior (one centre of
# expansion for the whole clip, sign free, COE grid-searched over
# [-AW,2AW]x[-AH,2AH]) reaches median CMA 0.6428, a static uniform translation
# 0.5672, and per-frame-refit versions 0.8386 / 0.6298. That is a statement
# about criterion (1)'s absolute floor, not about criterion (2): the A0 margin
# is what carries the claim precisely because the corridor's own geometry gives
# any plausible guess a head start. See scratchpad priors.py / priors2.py.
INSTRUMENT_FLOOR = 0.40

SSIM_C1 = (0.01 * 255.0) ** 2
SSIM_C2 = (0.03 * 255.0) ** 2
SSIM_CROP = 5         # drop the 11x11 window's half-width border (Wang et al.
                      # evaluate on valid windows only)


# ===========================================================================
# I/O
# ===========================================================================
def read_clip(path):
    """Decode a clip to a full-res grayscale stack plus per-frame timestamps.

    144 x 704 x 1280 uint8 is ~130 MB; holding the stack makes resampling,
    SSIM and the trajectory pass all trivially indexable.
    """
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise SystemExit("cannot open %s" % path)
    meta = dict(
        width=float(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
        height=float(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
        fps=float(cap.get(cv2.CAP_PROP_FPS)),
        count=float(cap.get(cv2.CAP_PROP_FRAME_COUNT)),
    )
    frames, ts_raw = [], []
    while True:
        ok, bgr = cap.read()
        if not ok:
            break
        # AFTER the read, not before. Sampled before, POS_MSEC returns the
        # position of the frame ALREADY consumed, so ts[i] would be frame i-1's
        # pts with ts[0] pinned to 0 -- a duplicated first entry that makes
        # diff[0] == 0, fails the monotonicity guard below, and silently drops
        # the whole path to index/fps. Measured on the block clip with cv2
        # 5.0.0: pre-read [0, 0, 41.667, 83.333, ...] (rejected);
        # post-read [0, 41.667, 83.333, ...], exactly index/24 to 0.000000 s.
        ts_raw.append(cap.get(cv2.CAP_PROP_POS_MSEC))
        frames.append(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY))
    cap.release()
    if not frames:
        raise SystemExit("decoded 0 frames from %s" % path)
    full = np.stack(frames)
    ts = np.asarray(ts_raw, np.float64) / 1000.0
    # POS_MSEC semantics vary by backend. Accept it only if it looks like a
    # sane, strictly increasing series starting at ~0; otherwise fall back to
    # index/fps and say so.
    ts_source = "container"
    good = (abs(ts[0]) < 1e-6) and (len(ts) == 1 or np.all(np.diff(ts) > 1e-9))
    if not good or not np.isfinite(ts).all():
        rate = meta["fps"] if meta["fps"] and np.isfinite(meta["fps"]) else FPS
        ts = np.arange(len(frames), dtype=np.float64) / float(rate)
        ts_source = "index/fps(%.6g)" % rate
    meta["decoded"] = int(full.shape[0])
    meta["ts_source"] = ts_source
    return full, ts, meta


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def source_fingerprint():
    """Identify the exact blocking clip + ground truth a number was produced
    against, and write it into every artefact.

    Not paranoia: during this file's own repair the blocking clip was
    re-rendered twice underneath a running session, and the anchor moved from
    0.6825 to 0.7842 with nothing in any artefact recording which clip either
    number described. Arm scores and an anchor computed against different
    renders are not comparable, and the mixture is silent -- every number stays
    plausible and internally consistent.
    """
    out = {}
    for key, path in (("block_mp4", BLOCK_MP4), ("block_npz", BLOCK_NPZ)):
        try:
            out[key] = os.path.basename(path)
            out[key + "_sha256"] = sha256_of(path)
            out[key + "_bytes"] = os.path.getsize(path)
        except OSError as e:                                   # noqa: BLE001
            out[key + "_sha256"] = "unreadable: %s" % e
    return out


def fingerprint_key(fp):
    if not fp:
        return None
    return (fp.get("block_mp4_sha256"), fp.get("block_npz_sha256"))


def small_stack(full):
    """Full-res gray -> the 320x176 analysis stack, INTER_AREA."""
    out = np.empty((full.shape[0], AH, AW), np.uint8)
    for i in range(full.shape[0]):
        out[i] = cv2.resize(full[i], (AW, AH), interpolation=cv2.INTER_AREA)
    return out


def resample_by_timestamp(ts_src, ts_target):
    """Nearest-in-TIME source index per target time. Never index-matching: a
    silent index misalignment would corrupt everything downstream."""
    idx = np.abs(ts_src[None, :] - ts_target[:, None]).argmin(axis=1)
    err = np.abs(ts_src[idx] - ts_target)
    return idx.astype(int), float(err.max())


def load_gt():
    z = np.load(BLOCK_NPZ)
    flow, valid = z["flow"], z["valid"]
    assert flow.shape == (BLOCK_FRAMES - 1, AH, AW, 2), "gt flow shape %s" % (flow.shape,)
    assert flow.dtype == np.float16, "gt flow dtype %s" % flow.dtype
    assert valid.shape == (BLOCK_FRAMES - 1, AH, AW) and valid.dtype == np.bool_
    f32 = flow.astype(np.float32)
    assert np.isfinite(f32).all(), "gt flow is not finite"
    assert not f32[~valid].any(), "invalid gt entries are not exactly 0"
    return f32, valid


# ===========================================================================
# FLOW
# ===========================================================================
def make_dis():
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    dis.setUseSpatialPropagation(True)
    return dis


def dis_flow(small):
    """(N,AH,AW) uint8 -> (N-1,AH,AW,2) float32 forward flow, DIS.

    DIS rather than Farneback: it handles the large displacements of a
    180 degree orbit far better at this resolution.
    """
    dis = make_dis()
    out = np.zeros((small.shape[0] - 1, AH, AW, 2), np.float32)
    for k in range(small.shape[0] - 1):
        out[k] = dis.calc(small[k], small[k + 1], None)
    return out


# ===========================================================================
# CMA AND COMPANIONS
# ===========================================================================
def cma_series(gt, gtv, est, offset=0, t_lo=None, t_hi=None):
    """Per-pair magnitude-weighted mean cosine. Returns (values, pair indices).

    Weighting by |gt| makes the fast-moving orbit regions dominate, which is
    correct: that is where the camera move lives.

    t_lo/t_hi restrict the gt pair range. The lag profile passes them so every
    offset is scored on ONE common pair set: without that, lag 0 uses 118 pairs
    and lag +4 uses 114, the pairs falling off the positive end are the
    top-down ones scoring 0.96, and the profile's shape is partly an artefact
    of which pairs were dropped.
    """
    ng, ne = gt.shape[0], est.shape[0]
    lo = 0 if t_lo is None else max(0, int(t_lo))
    hi = ng if t_hi is None else min(ng, int(t_hi))
    vals, kept = [], []
    for t in range(lo, hi):
        s = t + offset
        if s < 0 or s >= ne:
            continue
        g = gt[t]
        m = np.sqrt(g[..., 0] ** 2 + g[..., 1] ** 2)
        mask = gtv[t] & (m >= MAG_FLOOR)
        if mask.mean() < MIN_COV:
            continue
        e = est[s]
        em = np.sqrt(e[..., 0] ** 2 + e[..., 1] ** 2)
        cos = np.clip((g * e).sum(-1) / (m * em + 1e-6), -1.0, 1.0)
        w = m[mask]
        vals.append(float((cos[mask] * w).sum() / w.sum()))
        kept.append(t)
    return np.asarray(vals, np.float64), np.asarray(kept, int)


def mr_series(gt, gtv, est, offset=0):
    """Per-pair median|est| / median|gt| over the moving mask."""
    ng, ne = gt.shape[0], est.shape[0]
    vals = []
    for t in range(ng):
        s = t + offset
        if s < 0 or s >= ne:
            continue
        g = gt[t]
        m = np.sqrt(g[..., 0] ** 2 + g[..., 1] ** 2)
        mask = gtv[t] & (m >= MAG_FLOOR)
        if mask.mean() < MIN_COV:
            continue
        e = est[s]
        em = np.sqrt(e[..., 0] ** 2 + e[..., 1] ** 2)
        den = float(np.median(m[mask]))
        if den <= 1e-9:
            continue
        vals.append(float(np.median(em[mask])) / den)
    return np.asarray(vals, np.float64)


def lag_common_range(ngt, ne):
    """The gt pair range on which EVERY offset in LAGS is defined.

    t is scored at est index t+off, so t >= -min(LAGS) and t < ne - max(LAGS),
    intersected with the available gt pairs. Scoring each lag over its own
    survivable range makes the nine numbers incomparable.
    """
    lo = max(0, -min(LAGS))
    hi = min(int(ngt), int(ne) - max(LAGS))
    return lo, max(lo, hi)


def lag_profile(gt, gtv, est, ngt):
    """CMA at every offset in LAGS, all on ONE common pair set."""
    lo, hi = lag_common_range(ngt, est.shape[0])
    prof, npairs = {}, {}
    for off in LAGS:
        v, _ = cma_series(gt, gtv, est, off, lo, hi)
        prof[off] = float(np.median(v)) if v.size else float("nan")
        npairs[off] = int(v.size)
    return prof, (lo, hi), npairs


def measured_null(gt, gtv, est, rng):
    """CMA recomputed with the ESTIMATED flow circularly shifted in time.

    NULL = max over 20 fixed-seed shifts, each at least NULL_MIN_OFF frames from
    zero in either circular direction.
    """
    n = est.shape[0]
    lo, hi = NULL_MIN_OFF, n - NULL_MIN_OFF
    if hi <= lo:
        return 0.0, []
    ks = rng.choice(np.arange(lo, hi), size=min(NULL_NSHIFT, hi - lo), replace=False)
    rows = []
    for k in sorted(int(v) for v in ks):
        a, _ = cma_series(gt, gtv, np.roll(est, k, axis=0), 0)
        rows.append({"k": k, "cma": float(np.median(a)) if a.size else 0.0})
    return max(r["cma"] for r in rows), rows


# ===========================================================================
# SSIM  (Wang et al. 2004, direct; ~15 lines, no scikit-image)
# ===========================================================================
def ssim(a, b):
    a = a.astype(np.float64)
    b = b.astype(np.float64)
    k, s = (11, 11), 1.5
    mu_a = cv2.GaussianBlur(a, k, s)
    mu_b = cv2.GaussianBlur(b, k, s)
    mu_a2, mu_b2, mu_ab = mu_a * mu_a, mu_b * mu_b, mu_a * mu_b
    sa = cv2.GaussianBlur(a * a, k, s) - mu_a2
    sb = cv2.GaussianBlur(b * b, k, s) - mu_b2
    sab = cv2.GaussianBlur(a * b, k, s) - mu_ab
    num = (2.0 * mu_ab + SSIM_C1) * (2.0 * sab + SSIM_C2)
    den = (mu_a2 + mu_b2 + SSIM_C1) * (sa + sb + SSIM_C2)
    m = num / den
    c = SSIM_CROP
    return float(m[c:-c, c:-c].mean())


def ssim_series(a_stack, b_stack):
    n = min(a_stack.shape[0], b_stack.shape[0])
    return np.asarray([ssim(a_stack[i], b_stack[i]) for i in range(n)], np.float64)


# ===========================================================================
# CONFIRMATORY TRAJECTORY
# ===========================================================================
def affine_track(full):
    """Per-pair similarity (tx, ty, theta, scale) from LK + RANSAC, at 1280x704.

    Returns (N-1, 4) and a per-pair ok flag. Failed pairs carry the identity
    step so the cumulative trajectory stays continuous instead of jumping.
    """
    n = full.shape[0]
    steps = np.zeros((n - 1, 4), np.float64)
    steps[:, 3] = 1.0
    ok = np.zeros(n - 1, bool)
    for i in range(n - 1):
        p0 = cv2.goodFeaturesToTrack(full[i], maxCorners=400, qualityLevel=0.01,
                                     minDistance=8)
        if p0 is None or len(p0) < 6:
            continue
        p1, st, _ = cv2.calcOpticalFlowPyrLK(full[i], full[i + 1], p0, None)
        if p1 is None:
            continue
        st = st.reshape(-1).astype(bool)
        if st.sum() < 6:
            continue
        M, _ = cv2.estimateAffinePartial2D(p0[st], p1[st], method=cv2.RANSAC,
                                           ransacReprojThreshold=3)
        if M is None:
            continue
        a, b = M[0, 0], M[1, 0]
        steps[i] = (M[0, 2], M[1, 2], math.atan2(b, a), math.hypot(a, b))
        ok[i] = True
    return steps, ok


def trajectory(steps):
    """Cumulative-sum each channel. FOR PLOTTING ONLY -- see traj_r_steps().

    DEVIATION, DISCLOSED: the scale channel accumulates (scale - 1), not scale.
    cumsum(scale) is dominated by a deterministic +1 per frame ramp that is
    identical in both clips, which would push Pearson r toward 1 for any pair of
    videos whatsoever. cumsum(scale - 1) is the accumulated scale CHANGE, which
    is what the comparison is actually about.
    """
    t = np.empty_like(steps)
    t[:, 0] = np.cumsum(steps[:, 0])
    t[:, 1] = np.cumsum(steps[:, 1])
    t[:, 2] = np.cumsum(steps[:, 2])
    t[:, 3] = np.cumsum(steps[:, 3] - 1.0)
    return t


TRAJ_SMOOTH = 5      # taps; see traj_r_steps' measured calibration


def smooth_steps(steps, w=TRAJ_SMOOTH):
    k = np.ones(w) / float(w)
    return np.stack([np.convolve(steps[:, c], k, mode="same")
                     for c in range(steps.shape[1])], 1)


def traj_r_steps(block_steps, arm_steps):
    """Pearson r per channel on the PER-FRAME STEPS, not their cumulative sums.

    WHY NOT CUMULATIVE. A straight line with matched endpoints -- carrying zero
    camera-move information -- scores r = +0.93 (tx), +0.81 (ty), +0.90 (theta)
    against the real cumulative trajectory (+0.98/+0.93/+0.94 on a later render
    of the same shot -- the pathology is not a quirk of one clip). That is the
    channel confirming precisely the failure it was added to detect. On steps
    the same ramp scores -0.13 / +0.02 / -0.04. Pearson is shift- and scale-invariant, so the scale
    channel needs no -1 correction here (unlike the cumulative curves, plotted).

    HOW TO READ IT -- THE NOISE FLOOR IS NOT 1.0, AND IT IS RENDER-DEPENDENT.
    LK per-frame steps on a near-textureless blockout are partly estimation
    noise, and noise does not correlate with noise, so this channel's ceiling
    must be measured PER RENDER, by scoring a re-encode of the SOURCE FRAMES
    THEMSELVES as if they were an arm. Two renders of this same shot, both
    measured that way (block_mp4_sha256 prefix in the arm JSON identifies
    which one any given number came from):
      d54a5791 (the render these constants describe, 90.4%% of pixels
        |Sobel| < 2): identical content scores only +0.10 (tx) / +0.65 (ty) /
        -0.07 (theta); %d-tap smoothed +0.56 / +0.89 / +0.41. On this clip a
        low raw value means almost nothing.
      a later, better-covered render: identical content +0.73 / +0.84 / +0.88,
        smoothed +0.92 / +0.97 / +0.97 -- a genuinely usable channel.
    So a LOW raw-steps r is not by itself evidence that the trajectories
    differ. Confirmatory only; deliberately NOT a pass criterion. Re-measure
    the floor whenever the blocking clip is re-rendered.

    The smoothed variant is reported for tx/ty/theta ONLY. Smoothing re-creates
    the drift pathology on the scale channel (an information-free ramp scored
    +0.92 there on the earlier render), so that channel is dropped.
    """
    n = min(block_steps.shape[0], arm_steps.shape[0])
    return {nm: pearson(block_steps[:n, c], arm_steps[:n, c])
            for c, nm in enumerate(["tx", "ty", "theta", "scale"])}


traj_r_steps.__doc__ = traj_r_steps.__doc__ % TRAJ_SMOOTH


def pearson(a, b):
    n = min(len(a), len(b))
    if n < 3:
        return float("nan")
    a, b = a[:n], b[:n]
    sa, sb = a.std(), b.std()
    if sa < 1e-12 or sb < 1e-12:
        return float("nan")
    return float(((a - a.mean()) * (b - b.mean())).mean() / (sa * sb))


def plot_traj(block_traj, arm_traj, path, title):
    names = ["tx (px)", "ty (px)", "theta (rad)", "scale-1 (cum)"]
    fig, ax = plt.subplots(4, 1, figsize=(9, 10), sharex=True)
    for c in range(4):
        ax[c].plot(block_traj[:, c], lw=1.8, color="#1f77b4", label="blocking (reference)")
        if arm_traj is not None:
            ax[c].plot(arm_traj[:, c], lw=1.4, color="#d62728", ls="--", label="arm output")
        ax[c].set_ylabel(names[c])
        ax[c].grid(alpha=0.3)
    ax[0].legend(loc="best", fontsize=8)
    ax[3].set_xlabel("frame pair")
    fig.suptitle(title, fontsize=11)
    fig.tight_layout()
    fig.savefig(path, dpi=110)
    plt.close(fig)


# ===========================================================================
# INSTRUMENT SELF-TEST -- proves no sign / weighting bug before any real number
# ===========================================================================
def self_test(gt, gtv):
    a, _ = cma_series(gt, gtv, gt, 0)
    b, _ = cma_series(gt, gtv, -gt, 0)
    rng = np.random.default_rng(7)
    noise = rng.normal(size=gt.shape).astype(np.float32) * 4.0
    c, _ = cma_series(gt, gtv, noise, 0)
    mr_id = mr_series(gt, gtv, gt, 0)
    res = dict(identity=float(np.median(a)), negated=float(np.median(b)),
               random=float(np.median(c)), mr_identity=float(np.median(mr_id)),
               pairs=int(a.size))
    assert abs(res["identity"] - 1.0) < 1e-6, "gt vs gt is not 1.0: %r" % res
    assert abs(res["negated"] + 1.0) < 1e-6, "gt vs -gt is not -1.0: %r" % res
    assert abs(res["random"]) < 0.15, "random flow does not score ~0: %r" % res
    assert abs(res["mr_identity"] - 1.0) < 1e-9, "MR of gt vs gt is not 1.0"
    return res


# ===========================================================================
# THE SCORER
# ===========================================================================
def score_one(arm_mp4, gt, gtv, block_small, block_full, block_traj, block_steps,
              block_ts, verbose=True):
    full, ts, meta = read_clip(arm_mp4)
    n = meta["decoded"]
    resampled = False
    resample = None
    max_time_error = 0.0
    invalid = []

    if int(meta["width"]) != WIDTH or int(meta["height"]) != HEIGHT:
        raise SystemExit("%s is %dx%d, not %dx%d"
                         % (arm_mp4, meta["width"], meta["height"], WIDTH, HEIGHT))

    target_ts = block_ts[:ARM_FRAMES]
    if n != ARM_FRAMES:
        idx, err = resample_by_timestamp(ts, target_ts)
        full = full[idx]
        resampled = True
        max_time_error = err
        uniq = int(np.unique(idx).size)
        resample = {"from_frames": n, "to_frames": int(ARM_FRAMES),
                    "max_time_error_s": err, "unique_source_frames": uniq,
                    "indices": idx.tolist()}
        if verbose:
            print("    !! %d frames, not %d -- RESAMPLED BY TIMESTAMP "
                  "(max time error %.4f s, %d unique source frames)"
                  % (n, ARM_FRAMES, err, uniq))
        # A nearest-in-time pick beyond half a frame period is not an
        # alignment, it is invention. Measured on real truncated renders of
        # this clip: 100 frames -> max error 0.875 s, 21 frozen tail frames,
        # CMA 0.5635 -- above the 0.50 floor, above its NULL 0.134, MR 0.617
        # inside the band, i.e. it meets criteria (1), (3) and (4) and reads as
        # an ordinary mid-table arm (0.7390 on a later render). 60 frames
        # -> max error 2.54 s and CMA 0.0000. The dangerous case is the MILD
        # truncation, not the obvious one, which is why the bound is on the
        # ERROR and not on how bad the score looks.
        if err > RESAMPLE_TOL_S:
            invalid.append("resampled with max time error %.4f s > %.4f s "
                           "(%d of %d frames are distinct); this clip is not a "
                           "complete %d-frame render"
                           % (err, RESAMPLE_TOL_S, uniq, ARM_FRAMES, ARM_FRAMES))
            if verbose:
                print("    !! INVALID -- %s" % invalid[-1])
    small = small_stack(full)

    est = dis_flow(small)
    ngt = min(gt.shape[0], est.shape[0])

    cma_lag, lag_range, lag_npairs = lag_profile(gt, gtv, est, ngt)
    vals, kept = cma_series(gt[:ngt], gtv[:ngt], est, 0)
    cma = float(np.median(vals)) if vals.size else float("nan")
    best_lag = max(LAGS, key=lambda o: (-1e9 if math.isnan(cma_lag[o]) else cma_lag[o]))

    mr = mr_series(gt[:ngt], gtv[:ngt], est, 0)
    mr_med = float(np.median(mr)) if mr.size else float("nan")

    rng = np.random.default_rng(NULL_SEED)
    null, null_rows = measured_null(gt[:ngt], gtv[:ngt], est, rng)

    ss_full = ssim_series(full, block_full[:full.shape[0]])
    ss_small = ssim_series(small, block_small[:small.shape[0]])

    steps, ok = affine_track(full)
    traj = trajectory(steps)
    r = traj_r_steps(block_steps, steps)
    r_sm = traj_r_steps(smooth_steps(block_steps), smooth_steps(steps))
    r_sm.pop("scale", None)   # smoothing re-creates the drift pathology there
    r_cum = {}
    nn = min(traj.shape[0], block_traj.shape[0])
    for c, nm in enumerate(["tx", "ty", "theta", "scale"]):
        r_cum[nm] = pearson(block_traj[:nn, c], traj[:nn, c])

    out = {
        "scope": SCOPE,
        "file": arm_mp4,
        "frames_decoded": n,
        "frames_used": int(full.shape[0]),
        "resampled": resampled,
        "max_time_error_s": float(max_time_error),
        "resample": resample,
        "valid": not invalid,
        "invalid_reason": "; ".join(invalid) if invalid else None,
        "ts_source": meta["ts_source"],
        "container_fps": meta["fps"],
        "CMA": cma,
        "MR": mr_med,
        "SSIM_block": float(np.mean(ss_full)),
        "SSIM_block_median": float(np.median(ss_full)),
        "SSIM_block_320": float(np.mean(ss_small)),
        "NULL": float(null),
        "lag": {str(k): v for k, v in cma_lag.items()},
        "lag_common_pair_range": [int(lag_range[0]), int(lag_range[1])],
        "lag_pairs_scored": {str(k): v for k, v in lag_npairs.items()},
        "best_lag": int(best_lag),
        "traj_r": r,
        "traj_r_basis": ("Pearson on per-frame STEPS, NOT cumulative sums. "
                         "Confirmatory only, never a pass criterion. Its noise "
                         "floor is not 1.0 and is RENDER-DEPENDENT. Measured "
                         "by scoring a re-encode of the source frames as an arm: "
                         "tx +0.10 / ty +0.65 / theta -0.07 on blocking render "
                         "d54a5791, and +0.73 / +0.84 / +0.88 on a later, "
                         "better-covered render of the same shot. Re-measure it "
                         "whenever the blocking clip changes; block_fingerprint "
                         "in this file says which render produced these numbers."),
        "traj_r_steps_smoothed": r_sm,
        "traj_r_steps_smoothed_taps": TRAJ_SMOOTH,
        "traj_r_cumulative": r_cum,
        "traj_r_cumulative_warning": ("drift-dominated: an information-free ramp "
                                      "scores +0.93/+0.81/+0.90 against "
                                      "render d54a5791 (+0.98/+0.93/+0.94 "
                                      "against a later one). Plotted, never "
                                      "used as evidence."),
        "traj_ok_pairs": int(ok.sum()),
        "pairs_scored": int(vals.size),
        "pairs_available": int(ngt),
        "cma_per_pair": [float(x) for x in vals],
        "cma_pair_index": [int(x) for x in kept],
        "null_shifts": null_rows,
    }
    return out, traj, vals, kept


# ===========================================================================
# MODES
# ===========================================================================
def prepare_block():
    print("=" * 78)
    print("BLOCKING CLIP + GROUND TRUTH")
    print("=" * 78)
    gt, gtv = load_gt()
    full, ts, meta = read_clip(BLOCK_MP4)
    print("  %s" % BLOCK_MP4)
    print("  cv2 : %gx%g  fps=%r  FRAME_COUNT=%r  decoded=%d  timestamps=%s"
          % (meta["width"], meta["height"], meta["fps"], meta["count"],
             meta["decoded"], meta["ts_source"]))
    assert int(meta["width"]) == WIDTH and int(meta["height"]) == HEIGHT, "wrong resolution"
    assert meta["fps"] == 24.0, "fps is not exactly 24.000: %r" % meta["fps"]
    assert meta["decoded"] == BLOCK_FRAMES, "decoded %d frames" % meta["decoded"]
    assert BLOCK_FRAMES >= ARM_FRAMES, "blocking clip shorter than the arm length"
    print("  npz : flow %s %s   valid %s   %d pairs"
          % (gt.shape, gt.dtype, gtv.shape, gt.shape[0]))
    print("  gt valid pixel fraction: min %.2f%%  mean %.2f%%  max %.2f%%"
          % (100 * gtv.mean(axis=(1, 2)).min(), 100 * gtv.mean(),
             100 * gtv.mean(axis=(1, 2)).max()))
    small = small_stack(full)
    return gt, gtv, full, small, ts


def mode_ceiling():
    t0 = time.time()
    gt, gtv, full, small, ts = prepare_block()

    print()
    print("=" * 78)
    print("INSTRUMENT SELF-TEST  (before any real number is produced)")
    print("=" * 78)
    st = self_test(gt, gtv)
    print("  CMA(gt , gt )              = %+.9f   (must be +1)" % st["identity"])
    print("  CMA(gt , -gt)              = %+.9f   (must be -1; a sign flip "
          "anywhere would land here)" % st["negated"])
    print("  CMA(gt , random directions)= %+.6f   (must be ~0)" % st["random"])
    print("  MR (gt , gt )              = %.9f   (must be 1)" % st["mr_identity"])
    print("  pairs surviving the mask   : %d / %d" % (st["pairs"], gt.shape[0]))

    print()
    print("=" * 78)
    print("RECONSTRUCTION ANCHOR  --  DIS looking straight at the clip the "
          "ground truth describes")
    print("=" * 78)
    print("  This is NOT a ceiling on arm scores. In --score, DIS runs on the")
    print("  ARM's frames only and never touches this clip, so an arm is bounded")
    print("  by the texture of its OWN output. What follows bounds exactly one")
    print("  hypothetical arm: the degenerate one (A4) that returns the source.")
    print("  DISOpticalFlow PRESET_MEDIUM, spatial propagation on, 320x176 "
          "INTER_AREA gray.")
    t1 = time.time()
    est = dis_flow(small)
    print("  estimated %d pairs in %.2f s" % (est.shape[0], time.time() - t1))

    # THE anchor: the 120 gt pairs an arm can actually occupy (arms are 121
    # frames). gt pairs 120..142 are the top-down settle and score ~0.96 -- the
    # highest stretch in the clip and unreachable by any arm, so including them
    # inflates the denominator and understates every arm by ~7%.
    nwin = ARM_FRAMES - 1
    vwin, kwin = cma_series(gt[:nwin], gtv[:nwin], est[:nwin], 0)
    anchor = float(np.median(vwin))
    mrwin = mr_series(gt[:nwin], gtv[:nwin], est[:nwin], 0)

    # secondary, descriptive only: the whole blocking clip
    vals, kept = cma_series(gt, gtv, est, 0)
    anchor_all = float(np.median(vals))
    neg, _ = cma_series(gt[:nwin], gtv[:nwin], -est[:nwin], 0)
    mr = mr_series(gt, gtv, est, 0)

    rng = np.random.default_rng(NULL_SEED)
    null, null_rows = measured_null(gt, gtv, est, rng)

    lag, lag_range, lag_npairs = lag_profile(gt, gtv, est, gt.shape[0])

    ss = ssim_series(small, small)
    steps, ok = affine_track(full)
    traj = trajectory(steps)

    print()
    print("  pairs scored / available   : %d / %d   (%d skipped: moving mask "
          "under %.0f%% of frame -- the lock-off opening second)"
          % (vals.size, gt.shape[0], gt.shape[0] - vals.size, 100 * MIN_COV))
    print("  first pair to survive      : %d (t=%.3f s)" % (kept[0], kept[0] / float(FPS)))
    print()
    print("  CMA_reconstruction_anchor  (arm window, %3d pairs) = %.4f   <-- THE"
          " anchor; every arm is read against this" % (nwin, anchor))
    print("  secondary, whole clip      (all %3d pairs)         = %.4f   "
          "(descriptive only: pairs %d..%d are unreachable by any arm)"
          % (gt.shape[0], anchor_all, nwin, gt.shape[0] - 1))
    print("  sign audit: arm-window CMA with est NEGATED        = %+.4f  (exact "
          "mirror; conventions agree)" % float(np.median(neg)))
    print("  mean / p10 / p90 of per-pair CMA (all pairs)       = %.4f / %.4f / %.4f"
          % (vals.mean(), np.percentile(vals, 10), np.percentile(vals, 90)))
    print("  worst pair                                        = %.4f at pair %d (t=%.3f s)"
          % (vals.min(), kept[int(vals.argmin())], kept[int(vals.argmin())] / float(FPS)))
    print("  MR   (median|est|/median|gt|)                      = %.4f (arm window) "
          "/ %.4f (all)" % (float(np.median(mrwin)), float(np.median(mr))))
    print("  NULL (max over %d fixed-seed shifts)               = %+.4f"
          % (len(null_rows), null))
    print("  SSIM_block (clip vs itself)                        = %.6f  (must be 1)"
          % float(np.mean(ss)))
    print("  trajectory pairs solved                           : %d / %d"
          % (int(ok.sum()), steps.shape[0]))
    print()
    print("  lag profile (CMA at frame offset), all offsets on ONE common pair "
          "set (gt pairs %d..%d, %d survive the mask):"
          % (lag_range[0], lag_range[1] - 1, lag_npairs[0]))
    print("   " + "".join("%8d" % o for o in LAGS))
    print("   " + "".join("%8.3f" % lag[o] for o in LAGS))
    print("   " + "".join("%8d" % lag_npairs[o] for o in LAGS) + "   <- pairs scored")
    print()
    print("  per-pair CMA by segment of the move:")
    segs = [("hold      0.00-1.00 s", 0.0, 1.0),
            ("orbit     1.00-3.50 s", 1.0, 3.5),
            ("tip-over  3.50-5.00 s", 3.5, 5.0),
            ("top-down  5.00-5.96 s", 5.0, 5.96)]
    for nm, a, b in segs:
        sel = (kept >= int(a * FPS)) & (kept < int(b * FPS))
        if sel.sum() == 0:
            print("     %-22s  (no pair survived the mask)" % nm)
            continue
        print("     %-22s  median %.4f   min %.4f   n=%d"
              % (nm, float(np.median(vals[sel])), float(vals[sel].min()), int(sel.sum())))

    # figures
    prof = os.path.join(GATE, "gate_ceiling_profile.png")
    fig, ax = plt.subplots(2, 1, figsize=(10, 6), sharex=True)
    ax[0].plot(kept, vals, lw=1.4, color="#1f77b4")
    ax[0].axvline(nwin, color="#8c564b", ls="-", lw=1.0,
                  label="end of arm window (pair %d)" % nwin)
    ax[0].axhline(anchor, color="#d62728", ls="--", lw=1.2,
                  label="reconstruction anchor (arm window) = %.3f" % anchor)
    ax[0].axhline(anchor_all, color="#d62728", ls=":", lw=1.0, alpha=0.6,
                  label="all-pairs median = %.3f (secondary)" % anchor_all)
    ax[0].axhline(T_CMA_ABS, color="#7f7f7f", ls=":", lw=1.2,
                  label="pass floor 0.50")
    ax[0].set_ylabel("CMA per pair")
    ax[0].set_ylim(-0.05, 1.02)
    ax[0].legend(fontsize=8)
    ax[0].grid(alpha=0.3)
    gmag = np.array([np.median(np.sqrt((gt[k] ** 2).sum(-1))[gtv[k]])
                     if gtv[k].any() else 0.0 for k in range(gt.shape[0])])
    ax[1].plot(gmag, lw=1.4, color="#2ca02c")
    ax[1].axhline(MAG_FLOOR, color="#7f7f7f", ls=":", lw=1.2,
                  label="mask floor %.2f px" % MAG_FLOOR)
    ax[1].set_ylabel("median |gt| (px/frame @320)")
    ax[1].set_xlabel("frame pair")
    ax[1].legend(fontsize=8)
    ax[1].grid(alpha=0.3)
    fig.suptitle("Reconstruction anchor: DIS estimate vs analytic ground truth, "
                 "blocking clip\n(bounds the degenerate reconstruction arm, "
                 "not arms that generate)")
    fig.tight_layout()
    fig.savefig(prof, dpi=110)
    plt.close(fig)

    tp = os.path.join(GATE, "gate_block_traj.png")
    plot_traj(traj, None, tp, "Blocking clip reference trajectory (LK + RANSAC similarity, cumulative)")

    doc = {
        "kind": "anchor",
        "scope": SCOPE,
        "block_fingerprint": source_fingerprint(),
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "block": BLOCK_MP4,
        "self_test": st,
        "params": {"mag_floor": MAG_FLOOR, "min_cov": MIN_COV,
                   "null_seed": NULL_SEED, "null_nshift": NULL_NSHIFT,
                   "null_min_off": NULL_MIN_OFF, "aw": AW, "ah": AH,
                   "instrument_floor": INSTRUMENT_FLOOR},
        # THE anchor -- what --report reads. Measured over the 120 gt pairs an
        # arm can occupy. NOT a ceiling on arms: see the module docstring.
        "CMA_reconstruction_anchor": anchor,
        "CMA_reconstruction_anchor_pairs": int(nwin),
        "CMA_reconstruction_anchor_means": ("the CMA the degenerate reconstruction "
                                            "arm (A4) would earn by perfectly "
                                            "returning the source clip"),
        # secondary, descriptive, read by nothing
        "CMA_all_pairs_secondary": anchor_all,
        "CMA_negated_est_arm_window": float(np.median(neg)),
        "MR_arm_window": float(np.median(mrwin)),
        "MR_all_pairs": float(np.median(mr)),
        "NULL": float(null),
        "SSIM_self": float(np.mean(ss)),
        "lag": {str(k): v for k, v in lag.items()},
        "lag_common_pair_range": [int(lag_range[0]), int(lag_range[1])],
        "lag_pairs_scored": {str(k): v for k, v in lag_npairs.items()},
        "pairs_scored": int(vals.size),
        "pairs_available": int(gt.shape[0]),
        "cma_per_pair": [float(x) for x in vals],
        "cma_pair_index": [int(x) for x in kept],
        "null_shifts": null_rows,
        "figures": [prof, tp],
    }
    with open(CEIL_JSON, "w") as fh:
        json.dump(doc, fh, indent=1)

    print()
    print("=" * 78)
    print("SELF-CHECK ON THE INSTRUMENT  (this is NOT a go/no-go on GPU time)")
    print("=" * 78)
    print("  CMA_reconstruction_anchor = %.4f  over the %d-pair arm window."
          % (anchor, nwin))
    print("  It bounds ONE arm -- the degenerate reconstruction (A4). Every other")
    print("  arm is bounded by the texture of its own restyled output, which is")
    print("  richer than this flat blockout, so an arm may legitimately score")
    print("  ABOVE it. No decision about spending GPU time follows from it.")
    print()
    if anchor >= INSTRUMENT_FLOOR:
        print("  FLOOR CHECK: %.4f >= %.2f -- PASS. For scale, this same estimate"
              % (anchor, INSTRUMENT_FLOOR))
        print("  scores NULL = %.4f against the WRONG point in time, so the metric"
              % null)
        print("  is seeing the move and not a coincidence: the mask floor (%.2f px"
              % MAG_FLOOR)
        print("  @%dx%d) and the analysis resolution are doing what they should."
              % (AW, AH))
        print("  The gate proceeds. This is not a licence to read the anchor as a")
        print("  bound on any arm that actually generates.")
    else:
        print("  FLOOR CHECK: %.4f < %.2f -- FAIL, and this is a statement about the"
              % (anchor, INSTRUMENT_FLOOR))
        print("  METRIC, not about the clip. NULL on this run is %.4f; an anchor"
              % null)
        print("  this close to it means the degenerate case is barely "
              "distinguishable")
        print("  from the wrong point in time. Check MAG_FLOOR (%.2f px) and the"
              % MAG_FLOOR)
        print("  analysis resolution (%dx%d) FIRST, and confirm gate_block.mp4 and"
              % (AW, AH))
        print("  gate_block_flow.npz came from the SAME render. Do NOT change the")
        print("  blocking clip: its flatness is fidelity to the real Blender")
        print("  playblast, and the ground truth is analytic, so the clip's texture")
        print("  never touched the reference side at all.")
    print()
    for ln in scope_lines():
        print("  " + ln)
    print()
    print("  wrote %s" % CEIL_JSON)
    print("  wrote %s" % prof)
    print("  wrote %s" % tp)
    print("  total %.1f s" % (time.time() - t0))
    return doc


# ⚠ NOT `^(A\d+)`. That matched LTX arm directories only, so a WAN arm dir would
# have fallen through to the bare basename -- which happens to work for "W1" and
# would silently produce arm ids like "W1 (copy)" for anything else. The family
# letter is load-bearing now (see FAMILIES), so it is parsed, not assumed.
ARM_RE = re.compile(r"^([A-Za-z]+\d+)")
SEED_RE = re.compile(r"_s(\d+)")


def mode_score(arm_dir):
    t0 = time.time()
    arm_dir = os.path.abspath(arm_dir)
    arm = ARM_RE.match(os.path.basename(arm_dir))
    arm_id = arm.group(1) if arm else os.path.basename(arm_dir)
    # The scope written into this arm's gate_score.json is the one belonging to
    # the family the arm id names. An LTX caveat stamped onto a WAN number would
    # survive into a write-up and misdescribe the mechanism.
    fam = arm_family(arm_id)
    if fam is None:
        print("  !! '%s' does not name a known arm family (%s) -- writing the "
              "default %s scope, which may be wrong for it"
              % (arm_id, "/".join(sorted(FAMILIES)), DEFAULT_FAMILY))
    set_family(fam or DEFAULT_FAMILY)
    mp4s = sorted(glob.glob(os.path.join(arm_dir, "*.mp4")))
    if not mp4s:
        raise SystemExit("no .mp4 in %s" % arm_dir)

    gt, gtv, block_full, block_small, block_ts = prepare_block()
    st = self_test(gt, gtv)
    print("  self-test: identity %+.6f  negated %+.6f  random %+.6f  -- OK"
          % (st["identity"], st["negated"], st["random"]))
    bsteps, bok = affine_track(block_full)
    block_traj = trajectory(bsteps)

    print()
    print("=" * 78)
    print("ARM %s   (%d seed clip(s))" % (arm_id, len(mp4s)))
    print("=" * 78)
    seeds = []
    for p in mp4s:
        m = SEED_RE.search(os.path.basename(p))
        sid = int(m.group(1)) if m else None
        print("  %s" % os.path.basename(p))
        rec, traj, vals, kept = score_one(p, gt, gtv, block_small, block_full,
                                          block_traj, bsteps, block_ts)
        rec["seed"] = sid
        png = os.path.splitext(p)[0] + "_traj.png"
        plot_traj(block_traj, traj, png,
                  "%s seed %s - trajectory vs blocking (r: tx %.2f ty %.2f th %.2f sc %.2f)"
                  % (arm_id, sid, rec["traj_r"]["tx"], rec["traj_r"]["ty"],
                     rec["traj_r"]["theta"], rec["traj_r"]["scale"]))
        rec["traj_png"] = png
        seeds.append(rec)
        print("    CMA %.4f | MR %.3f | SSIM_block %.4f | NULL %+.4f | best lag %+d"
              % (rec["CMA"], rec["MR"], rec["SSIM_block"], rec["NULL"], rec["best_lag"]))
        print("    traj r (per-frame STEPS): tx %+.3f  ty %+.3f  theta %+.3f  scale %+.3f"
              % (rec["traj_r"]["tx"], rec["traj_r"]["ty"],
                 rec["traj_r"]["theta"], rec["traj_r"]["scale"]))
        if not rec["valid"]:
            print("    !! THIS SEED IS INVALID and cannot pass: %s"
                  % rec["invalid_reason"])

    cmas = [s["CMA"] for s in seeds]
    bad = [s for s in seeds if not s["valid"]]
    doc = {
        "kind": "arm",
        "scope": SCOPE,
        "block_fingerprint": source_fingerprint(),
        "arm": arm_id,
        # Recorded, so --report can cross-check the family it derived from the
        # id against what the scoring run believed it was measuring.
        "family": FAMILY,
        "family_label": FAMILIES[FAMILY]["label"],
        "dir": arm_dir,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "block": BLOCK_MP4,
        "params": {"mag_floor": MAG_FLOOR, "min_cov": MIN_COV,
                   "null_seed": NULL_SEED, "arm_frames": ARM_FRAMES},
        "seeds": seeds,
        "median": {
            "CMA": float(np.median(cmas)),
            "MR": float(np.median([s["MR"] for s in seeds])),
            "SSIM_block": float(np.median([s["SSIM_block"] for s in seeds])),
            "NULL": float(np.median([s["NULL"] for s in seeds])),
            "traj_r": {nm: float(np.median([s["traj_r"][nm] for s in seeds]))
                       for nm in ("tx", "ty", "theta", "scale")},
        },
        "spread": {"CMA": float(max(cmas) - min(cmas))},
        "any_resampled": any(s["resampled"] for s in seeds),
        "max_time_error_s": float(max(s["max_time_error_s"] for s in seeds)),
        # An arm is valid only if EVERY seed clip was a complete render. An
        # invalid arm is still scored and reported, but it cannot pass and it
        # cannot calibrate anything (A0's margin, A4's degeneracy guard).
        "valid": not bad,
        "invalid_reason": ("; ".join(
            "%s: %s" % (os.path.basename(s["file"]), s["invalid_reason"])
            for s in bad) if bad else None),
    }
    out = os.path.join(arm_dir, SCORE_NAME)
    with open(out, "w") as fh:
        json.dump(doc, fh, indent=1)
    print()
    print("  ARM %s median CMA %.4f  MR %.3f  SSIM_block %.4f  NULL %+.4f  "
          "seed spread %.4f" % (arm_id, doc["median"]["CMA"], doc["median"]["MR"],
                                doc["median"]["SSIM_block"], doc["median"]["NULL"],
                                doc["spread"]["CMA"]))
    if not doc["valid"]:
        print("  !! ARM %s IS INVALID: %s" % (arm_id, doc["invalid_reason"]))
    for ln in scope_lines():
        print("  " + ln)
    print("  wrote %s   (%.1f s)" % (out, time.time() - t0))
    return doc


def arm_is_usable(doc):
    """Present AND a complete render. An arm that had to be resampled beyond
    RESAMPLE_TOL_S describes a clip that was never generated, so it cannot pass
    and -- more important -- it cannot CALIBRATE anything (A0's margin, A4's
    degeneracy guard)."""
    return doc is not None and bool(doc.get("valid", True))


def arm_traj_r(doc):
    med = doc.get("median", {}).get("traj_r")
    if med:
        return med
    seeds = doc.get("seeds") or []
    if not seeds or "traj_r" not in seeds[0]:
        return {nm: float("nan") for nm in ("tx", "ty", "theta", "scale")}
    return {nm: float(np.median([s["traj_r"][nm] for s in seeds]))
            for nm in ("tx", "ty", "theta", "scale")}


def arm_graph(root, arm_id):
    """The graph a run actually emitted for an arm, or None.

    Read rather than believed: the run's gate_controls.json says what it MEANT
    to build, and this says what it built. Where the two disagree the graph
    wins, because the graph is what was dispatched.
    """
    paths = sorted(glob.glob(os.path.join(root, "_graphs", "%s_s*.json" % arm_id)))
    if not paths:
        return None, None
    try:
        return json.load(open(paths[0])), os.path.basename(paths[0])
    except Exception:                                          # noqa: BLE001
        return None, os.path.basename(paths[0])


def mask_of_graph(g):
    """How WanVaceToVideo's `control_masks` is wired, in words.

    nodes_wan.py:337-343. Absent -> mask = ones -> `inactive` is a constant gray
    plate and `reactive` IS the control clip: the model GENERATES over it.
    Wired to an all-zero mask -> `inactive` IS the clip and `reactive` is the
    constant: the model is told to KEEP this footage. Same node, same strength,
    opposite instruction.
    """
    vace = [v for v in g.values() if v.get("class_type") == "WanVaceToVideo"]
    if not vace:
        return "no WanVaceToVideo"
    link = vace[0]["inputs"].get("control_masks")
    if not isinstance(link, list):
        return "no control_masks (mask = ones: generate over the clip)"
    src = g.get(str(link[0]), {})
    if src.get("class_type") == "ImageToMask":
        img = src.get("inputs", {}).get("image")
        base = g.get(str(img[0]), {}) if isinstance(img, list) else {}
        if base.get("class_type") == "EmptyImage" and int(base["inputs"].get("color", -1)) == 0:
            return ("control_masks = ALL ZEROS over %d frames (mask 0: the clip is "
                    "`inactive`, i.e. footage to PRESERVE)"
                    % int(base["inputs"].get("batch_size", 0)))
    return "control_masks wired to %s (NOT the all-zero mask this harness knows)" % (
        src.get("class_type", "?"))


def arm_strength(root, arm_id, declared_arms=None):
    """The arm's VACE residual strength, from the DISPATCHED graph if there is
    one and from the run's declaration otherwise. None when neither says.

    This exists because of the zero-strength null: at strength 0.00 the residual
    is `c_skip * 0.0`, arithmetically nothing, so such an arm CANNOT be carrying
    the control video whatever it scores. An instrument that lets it be declared
    GREEN is reporting its own defect as a finding.
    """
    g, _ = arm_graph(root, arm_id)
    if g:
        for n in g.values():
            if n.get("class_type") == "WanVaceToVideo":
                try:
                    return float(n["inputs"]["strength"]), "graph"
                except (KeyError, TypeError, ValueError):
                    break
    for a in (declared_arms or []):
        if a.get("id") == arm_id and a.get("strength") is not None:
            try:
                return float(a["strength"]), CONTROLS_NAME
            except (TypeError, ValueError):
                break
    return None, None


def arm_operating_point(root, arm_id):
    """The arm's conditioning, read back from the graph gate_run.mjs emitted.

    This is the number step 2 of the brief inherits, so it is read from the
    artefact that was actually dispatched rather than from a table duplicated
    in this file and free to drift out of date.
    """
    paths = sorted(glob.glob(os.path.join(root, "_graphs", "%s_s*.json" % arm_id)))
    if not paths:
        return "operating point UNKNOWN -- no %s_s*.json under %s" % (
            arm_id, os.path.join(root, "_graphs"))
    try:
        g = json.load(open(paths[0]))
    except Exception as e:                                    # noqa: BLE001
        return "operating point UNREADABLE (%s: %s)" % (os.path.basename(paths[0]), e)
    # WAN VACE arms: the operating point is one number (the residual scale) plus
    # whether the control_video wire is there at all. Read from the graph for
    # the same reason as the LTX branch below -- so the report quotes the
    # artefact that was dispatched, not a table in this file free to drift.
    vace = [v for v in g.values() if v.get("class_type") == "WanVaceToVideo"]
    if vace:
        v = vace[0]["inputs"]
        wired = isinstance(v.get("control_video"), list)
        # THE MASK IS PART OF THE OPERATING POINT AND MUST NEVER BE OMITTED.
        # control_masks decides what the encoded pixels MEAN: absent (mask ones)
        # the clip is the `reactive` control signal and the model generates over
        # it; all-zero the clip becomes `inactive`, i.e. footage to PRESERVE
        # (nodes_wan.py:341-343). Two arms with the same strength and opposite
        # masks are running two different experiments, so a GREEN that quoted
        # only the strength would be describing the wrong one.
        mask = mask_of_graph(g)
        if not wired:
            return ("text-only control on the SAME model: WanVaceToVideo with no "
                    "control_video wire, so the node substitutes a uniform gray "
                    "plate; strength %.2f, %s   [read from %s]"
                    % (float(v.get("strength", float("nan"))), mask,
                       os.path.basename(paths[0])))
        span = None
        for n in g.values():
            if n.get("class_type") == "ImageFromBatch":
                span = (int(n["inputs"].get("batch_index", 0)),
                        int(n["inputs"].get("length", 0)))
        where = ("source frames %d..%d" % (span[0], span[0] + span[1] - 1)) if span \
            else "the whole decoded batch"
        return ("control_video wired (%s), residual strength %.2f, %s, %dx%d x %d "
                "frames   [read from %s]"
                % (where, float(v.get("strength", float("nan"))), mask,
                   int(v.get("width", 0)), int(v.get("height", 0)),
                   int(v.get("length", 0)), os.path.basename(paths[0])))

    guides = [v for v in g.values() if v.get("class_type") == "LTXVAddGuide"]
    if not guides:
        return "text-only control (no LTXVAddGuide in %s)" % os.path.basename(paths[0])

    def span_of(node):
        """Walk image -> LTXVPreprocess -> ImageScale -> ImageFromBatch."""
        cur, hops = node, 0
        while cur is not None and hops < 6:
            if cur.get("class_type") == "ImageFromBatch":
                return int(cur["inputs"].get("length", 1))
            nxt = cur.get("inputs", {}).get("image")
            cur = g.get(str(nxt[0])) if isinstance(nxt, list) else None
            hops += 1
        return None

    idx = sorted(int(v["inputs"]["frame_idx"]) for v in guides)
    strengths = sorted({round(float(v["inputs"]["strength"]), 4) for v in guides})
    spans = [span_of(v) for v in guides]
    spans = [s for s in spans if s is not None]
    gaps = sorted({idx[i + 1] - idx[i] for i in range(len(idx) - 1)})
    if len(idx) == 1:
        where = "one guide at frame_idx %d" % idx[0]
    elif len(gaps) == 1:
        where = "%d guides every %d frames (frame_idx %d..%d)" % (
            len(idx), gaps[0], idx[0], idx[-1])
    else:
        where = "%d guides at frame_idx %s" % (len(idx), ",".join(str(i) for i in idx))
    span = ("%d frame(s) each" % spans[0]) if spans and len(set(spans)) == 1 \
        else ("spans %s" % spans if spans else "span unknown")
    stren = ("strength %.2f" % strengths[0]) if len(strengths) == 1 \
        else ("strengths %s" % ", ".join("%.2f" % s for s in strengths))
    return "%s, %s, %s   [read from %s]" % (where, span, stren,
                                            os.path.basename(paths[0]))


# ---------------------------------------------------------------------------
# WHY AN ARM MAY NOT PASS -- AND THE THREE REASONS ARE NOT THE SAME REASON
# ---------------------------------------------------------------------------
# ⚠⚠ Branch (e) used to print ONE sentence over EVERY barred arm: "the arm
# cannot be carrying the control video ... an arm that carries no control
# signal". That is true of exactly one of the three kinds below.
#
# It is FALSE of W9, the masked degeneracy calibrator, which carries the control
# video at FULL strength and is barred for the OPPOSITE reason -- control_masks
# all zeros TELLS it to hand the footage back. It is equally false of W6/W7, the
# saturation probes at strength 16.00 and 64.00. The operating-point line printed
# two rows above said "control_video wired ... residual strength 16.00" while the
# verdict said the arm carries no control signal: the verdict contradicted the
# artefact it had just quoted, and it sends a reader to debug the wiring when the
# wiring is fine.
#
# So the reason travels with the id, and each kind gets the sentence that is TRUE
# of it.
BAR_REASONS = {
    "zero_strength": {
        "short": "zero-strength null",
        "phrase": "the ZERO-STRENGTH NULL",
        "carries": ("carries NO control signal at all -- its VACE residual is "
                    "multiplied by exactly 0.00, so `x += c_skip * 0.0` "
                    "contributes nothing to the denoising latent"),
        "implication": ("The control video cannot have reached that output, so "
                        "whatever it measured, some OTHER property of the output "
                        "cleared the bar."),
        "admits": "an arm that carries no control signal at all",
        "default_why": "%s's VACE residual strength is exactly 0.00",
    },
    "calibrator": {
        "short": "degeneracy calibrator",
        "phrase": "the DEGENERACY CALIBRATOR",
        "carries": ("DOES carry the control video, at full strength, and is barred "
                    "for the opposite reason -- control_masks all zeros makes the "
                    "clip `inactive` (nodes_wan.py:341-343), VACE's own vocabulary "
                    "for 'preserve this footage', so the arm is TOLD to reproduce "
                    "the source"),
        "implication": ("It reproduces the source BY CONSTRUCTION, so clearing "
                        "the criteria measures an instruction being obeyed and says "
                        "nothing about whether an arm that GENERATES can carry the "
                        "move."),
        "admits": "an arm that was TOLD to hand the source footage back",
        "default_why": ("%s is the criterion-(5) calibrator and is disqualified by "
                        "construction"),
    },
    "declared": {
        "short": "declared disqualified",
        "phrase": "an arm THE RUN DECLARED DISQUALIFIED",
        "carries": ("DOES carry the control video -- it is barred by the run's own "
                    "declaration, not by any claim that the control signal is "
                    "absent"),
        "implication": ("The run declared IN ADVANCE that this arm may not support "
                        "a claim, so its clearing the criteria is not a finding "
                        "about conditioning -- the reason it was declared, printed "
                        "above, is the thing to read."),
        "admits": "an arm the run declared may not support a claim",
        "default_why": "%s is disqualified by the run's own declaration",
    },
}


def bar_kind(root, arm_id, strength, degen_id):
    """WHICH of the three reasons bars this arm.

    Read off the DISPATCHED GRAPH wherever the graph can say, for the same reason
    everything else here is: the sentence the verdict prints must be a property of
    the artefact, not of a table in this file that is free to drift. An all-zero
    control_mask IS the 'hand the footage back' instruction whichever arm the run
    happened to nominate as its calibrator, so it is recognised by its mask rather
    than by its id.
    """
    if strength is not None and abs(strength) < 1e-9:
        return "zero_strength"
    g, _ = arm_graph(root, arm_id)
    if g is not None and "ALL ZEROS" in mask_of_graph(g):
        return "calibrator"
    if arm_id == degen_id:
        return "calibrator"
    return "declared"


def row_bar_kind(row, degen_id):
    """The kind for a row, with the fallback the degenerate arm needs: A4 on the
    LTX family is barred by BEING the calibrator and may have no entry in a
    `disqualified` list at all."""
    return row.get("barred_kind") or ("calibrator" if row["arm"] == degen_id
                                      else "declared")


def arms_under_test(rows, cal):
    """The arms this gate is actually ASKING ABOUT.

    NOT the text-only control -- it is criterion (2)'s own baseline and can never
    clear its own margin. NOT the criterion-(5) calibrator. NOT any barred arm.
    And NOT an arm whose render was incomplete: an INVALID arm cannot pass
    whatever it scored, so a root whose only generating arms are invalid has
    asked the question of nobody either.
    """
    control_id = cal.get("control", "A0")
    degen_id = cal.get("degenerate", "A4")
    barred = dict(cal.get("barred") or {})
    return [r for r in rows
            if r["arm"] not in (control_id, degen_id)
            and r["arm"] not in barred and r["valid"]]


def apply_pass_rule(arms, control_id, degen_id, primary_id=None, barred=None,
                    barred_kinds=None):
    """arms: {arm_id: doc}. Returns (rows, margin, margin_note, cal).

    ⚠ `control_id` and `degen_id` ARE ARGUMENTS, NOT THE LITERALS "A0"/"A4".
    They used to be the literals, which meant a WAN arm scored in this function
    was measured against an LTX render and nothing in the output said so. See
    the FAMILIES block at the top of this file. mode_report resolves them from
    the run's own gate_controls.json and refuses a control from another family.

    `barred` is {arm_id: why} for arms that MAY NOT BE REPORTED AS A PASS
    whatever they score -- the run's own gate_controls.json `disqualified` list,
    plus every arm whose VACE residual strength is exactly 0.00. It is recorded
    on the rows here and enforced in verdict_of.

    cal records what could and could not be CALIBRATED, which is a different
    thing from what failed. Criterion (5) is calibrated on the degenerate arm
    alone; when it is absent or invalid the criterion is marked NOT EVALUATED
    rather than failed closed, because failing it closed turns an unevaluable
    gate into a table of five 'fail' rows that reads exactly like a clean sweep
    of real failures. The verdict block downstream refuses to call anything on
    that state.

    ⚠ AND THE SAME TRAP ONE LEVEL DOWN, WHICH IS WHY c5_evaluated IS NOT JUST
    "IS A4 THERE". The bar for (5) is `degenerate_SSIM - 0.25`. If the
    calibrator did not actually reconstruct the source, that bar lands BELOW the
    score a normally-generating arm already earns -- on this blockout the
    text-only control alone scores SSIM_block 0.442 -- and (5) silently inverts
    into a criterion NO arm can clear, including arms that passed (1)-(4). The
    table then shows a clean sweep of failures that is really one uncalibrated
    guard. So the bar is checked against the CONTROL arm's own SSIM_block, and
    when it does not clear it, (5) is NOT EVALUATED, not failed.
    """
    barred = dict(barred or {})
    barred_kinds = dict(barred_kinds or {})
    a0 = arms.get(control_id)
    a4 = arms.get(degen_id)
    a0_ok = arm_is_usable(a0)
    a4_ok = arm_is_usable(a4)
    margin = T_MARGIN
    note = None
    # The seed-spread widening watches the CONTROL and the PRIMARY arm, because
    # those two carry the claim. Which arm is "primary" is family-dependent
    # (A1 on LTX, W1 on WAN), so it is passed in rather than spelled.
    watch = [control_id] + ([primary_id] if primary_id else [])
    spreads = {k: arms[k]["spread"]["CMA"] for k in watch if k in arms}
    worst = max(spreads.values()) if spreads else 0.0
    if worst > T_SPREAD:
        margin = 2.0 * worst
        note = ("seed spread on %s is %.3f, above %.2f -- margin raised to "
                "2x spread = %.3f" % (max(spreads, key=spreads.get), worst,
                                      T_SPREAD, margin))
    # ---- CRITERION (5): IS THE GUARD A GUARD, OR HAS IT INVERTED? -----------
    a4_ssim = a4["median"]["SSIM_block"] if a4_ok else None
    a0_ssim = a0["median"]["SSIM_block"] if a0_ok else None
    ssim_bar = (a4_ssim - T_SSIM_MARGIN) if a4_ok else None
    c5_ok = a4_ok
    c5_why = None
    if a4_ok and a0_ok and ssim_bar <= a0_ssim:
        c5_ok = False
        c5_why = ("the bar for (5) is %s SSIM_block %.3f - %.2f = %.3f, which is "
                  "AT OR BELOW the text-only control %s's own SSIM_block %.3f. "
                  "%s did not reconstruct the source, so the bar has sunk under "
                  "what a normally-generating arm already scores and (5) would "
                  "fail EVERY arm -- including any that passed (1)-(4). That is "
                  "an uncalibrated guard, not a finding."
                  % (degen_id, a4_ssim, T_SSIM_MARGIN, ssim_bar, control_id,
                     a0_ssim, degen_id))
    elif a4_ok and ssim_bar <= 0.0:
        c5_ok = False
        c5_why = ("the bar for (5) is %s SSIM_block %.3f - %.2f = %.3f, which is "
                  "at or below zero: no arm can clear it, so (5) has inverted "
                  "into a universal fail."
                  % (degen_id, a4_ssim, T_SSIM_MARGIN, ssim_bar))

    rows = []
    for k in sorted(arms):
        d = arms[k]
        cma = d["median"]["CMA"]
        mr = d["median"]["MR"]
        ss = d["median"]["SSIM_block"]
        nul = d["median"]["NULL"]
        valid = bool(d.get("valid", True))
        c1 = cma >= T_CMA_ABS
        # None = NOT EVALUATED, printed as '-'. A criterion whose calibration
        # arm is missing must not print as a failure: a column of '.' is what a
        # real negative looks like.
        c2 = (cma >= a0["median"]["CMA"] + margin) if a0_ok else None
        c3 = cma > nul
        c4 = T_MR_LO <= mr <= T_MR_HI
        c5 = (ss <= ssim_bar) if c5_ok else None
        cs = [c1, c2, c3, c4, c5]
        met = all(bool(x) for x in cs if x is not None)
        rows.append(dict(arm=k, cma=cma, mr=mr, ssim=ss, null=nul,
                         spread=d["spread"]["CMA"], valid=valid,
                         resampled=bool(d.get("any_resampled", False)),
                         terr=float(d.get("max_time_error_s", 0.0)),
                         invalid_reason=d.get("invalid_reason"),
                         traj=arm_traj_r(d), c=cs,
                         c2_evaluated=a0_ok, c5_evaluated=c5_ok,
                         # DISQUALIFIED BY THE RUN'S OWN DECLARATION, or by
                         # having a residual strength of exactly 0.00. Such an
                         # arm may meet every criterion and still may not be
                         # reported as a pass -- see verdict_of branch (e).
                         barred=k in barred, barred_why=barred.get(k),
                         # WHICH of the three reasons -- see BAR_REASONS. Branch
                         # (e) prints a different sentence for each because the
                         # single sentence it used to print was false about two
                         # of the three.
                         barred_kind=barred_kinds.get(k),
                         # An invalid arm can never pass, whatever it scored,
                         # and neither can any arm while a criterion is
                         # uncalibrated.
                         passed=bool(valid and met and a0_ok and c5_ok),
                         criteria_met=bool(valid and met)))
    cal = {"a0_present": a0 is not None, "a4_present": a4 is not None,
           "a0_usable": a0_ok, "a4_usable": a4_ok, "c5_evaluated": c5_ok,
           "c5_not_evaluated_why": c5_why,
           "ssim_bar": ssim_bar, "degenerate_SSIM_block": a4_ssim,
           "control_SSIM_block": a0_ssim,
           "a0_invalid_reason": (a0 or {}).get("invalid_reason"),
           "a4_invalid_reason": (a4 or {}).get("invalid_reason"),
           # The names, carried alongside the flags, so a report JSON says WHICH
           # arm calibrated what rather than leaving it to be inferred.
           "control": control_id, "degenerate": degen_id, "primary": primary_id,
           "barred": barred, "barred_kinds": barred_kinds}
    return rows, margin, note, cal


def source_consistency(docs, anchor_doc):
    """Were all these numbers produced against the SAME blocking clip?

    Arms scored against one render and an anchor computed against another are
    not comparable, and the mixture is invisible: every row stays plausible.
    A recorded MISMATCH blocks the verdict; a merely ABSENT fingerprint (an
    artefact written before this field existed) only warns, since absence is
    not evidence of a mismatch.
    """
    seen, missing = {}, []
    for name, d in list(docs.items()) + ([("anchor", anchor_doc)] if anchor_doc else []):
        k = fingerprint_key(d.get("block_fingerprint"))
        if k is None or k[0] is None:
            missing.append(name)
        else:
            seen.setdefault(k, []).append(name)
    if len(seen) > 1:
        groups = "; ".join(
            "%s <- block_mp4 %s / npz %s" % (",".join(sorted(v)), k[0][:12], k[1][:12])
            for k, v in seen.items())
        return {"ok": False, "missing": missing, "groups": groups,
                "why": "these numbers were produced against DIFFERENT blocking "
                       "renders and are not comparable -- %s" % groups}
    return {"ok": True, "missing": missing, "groups": None, "why": None}


# ---------------------------------------------------------------------------
# THE VERDICT -- the one interpretive judgement this instrument exists to make
# ---------------------------------------------------------------------------
def verdict_of(rows, docs, anchor, cal, root):
    """Six-way branch. A 'fail' table means several completely different things
    depending on the DEGENERATE arm, and reading a table at the end of a long
    day is not a reliable way to tell them apart.

      (d) control or degenerate absent/invalid, or mixed renders -> NO RESULT:
          no calibration
      (e) an arm that MAY NOT PASS passed -> NO RESULT: the pass rule did not
          discriminate, so nothing in the table can be believed -- and this
          outranks a GREEN in the same table
      (h) NOT ONE ARM UNDER TEST is present and qualified -> NO RESULT: the
          numbers and the calibration are reported, and nothing whatever is
          claimed about conditioning. This is what a STAGED run's first stage
          produces and it must not read as a result
      (a) a qualified arm passes all five -> GREEN
      (f) nothing passes and there is no anchor -> NO RESULT
      (g) nothing passes and THE CALIBRATOR DID NOT RECONSTRUCT -> NO RESULT:
          transport was never established, so re-aim the calibrator. Explicitly
          NOT "debug the metric"
      (b) nothing passes, the calibrator reconstructed AND its CMA is at the
          anchor -> DECISIVE NEGATIVE: the conditioning path demonstrably
          transports the move and every arm that also GENERATES discards it
      (c) nothing passes, the calibrator reconstructed but its CMA is low ->
          NO RESULT: the source really did reach the output and the metric still
          did not see it, so the metric or the source clip is the suspect

    ⚠⚠ (b) NEEDS BOTH HALVES, AND USED TO TAKE ONLY ONE. ⚠⚠
    "transports the move" was decided on CMA alone. SSIM_block appeared in the
    sentence the branch PRINTS but was never tested, so a calibrator with CMA
    0.900 and SSIM_block 0.380 printed "W6 reproduces the source (SSIM_block
    0.380)" -- a sentence that contradicts itself, under a DECISIVE NEGATIVE
    heading. 0.380 is not reproduction. A high CMA with a low SSIM means the arm
    happened to move in roughly the right direction, which is exactly the
    coincidence NULL and the anchor exist to disbelieve.

    ⚠⚠ (e) EXISTS BECAUSE ONLY THE DEGENERATE ARM USED TO BE BARRED. ⚠⚠
    `passers` was "every row that is not the degenerate arm and passed". The
    run's own gate_controls.json `disqualified` list was written, shipped, and
    never read. So the zero-strength null -- whose residual is multiplied by
    exactly 0.00 and which therefore CANNOT be carrying the control video --
    was eligible to clear all five criteria and be announced as GREEN: the
    instrument reporting its own defect as a discovery.

    ⚠⚠ (h) EXISTS BECAUSE A ROOT WITH NO ARM UNDER TEST FELL THROUGH TO (b). ⚠⚠
    A root holding ONLY the text-only control and the disqualified calibrator --
    not one arm under test -- reached (b) and printed "the conditioning path
    provably transports the move ... and every arm that also GENERATES discards
    it", exit 0. Both halves of (b)'s test are about the CALIBRATOR, so they
    held; the clause about "every arm that also GENERATES" was quantified over
    the EMPTY SET, vacuously true and entirely unfounded. That root is not
    hypothetical -- it is exactly what stage 1 of a staged run produces, and
    scoring it would have printed a confident negative bought with no arm.

    WHICH ARMS THOSE ARE COMES FROM `cal`, NOT FROM THE LITERALS "A0"/"A4".
    Every branch below used to name the LTX arms directly, which is how a WAN
    arm could have been declared a decisive negative on the strength of an LTX
    calibrator. mode_report resolves the pair from the run's own
    gate_controls.json and refuses one from another family.
    """
    control_id = cal.get("control", "A0")
    degen_id = cal.get("degenerate", "A4")
    barred = dict(cal.get("barred") or {})
    a4 = docs.get(degen_id)
    passers = [r for r in rows
               if r["arm"] != degen_id and r["arm"] not in barred and r["passed"]]
    barred_passers = [r for r in rows
                      if (r["arm"] in barred or r["arm"] == degen_id) and r["passed"]]

    # (d) FIRST, and it covers BOTH calibration arms. A missing A0 fails
    # criterion (2) closed for every arm, which then looks exactly like "no arm
    # passed" and would be reported as a decisive negative -- the same
    # confusion this verdict block exists to prevent, one arm over. A0
    # calibrates the margin, and the margin IS the claim; A4 calibrates the
    # degeneracy guard. Without either, nothing can be concluded.
    lost = []
    if not cal.get("source_consistent", True):
        lost.append(("the run itself", "internal consistency: every number must "
                                       "come from ONE blocking render",
                     "MIXED SOURCES -- %s" % cal.get("source_why")))
    if not cal["a0_usable"]:
        lost.append((control_id, "criterion (2), the margin over the text-only "
                                 "control -- and the margin IS the claim",
                     ("%s is absent from %s" % (control_id, root)) if not cal["a0_present"]
                     else "%s rendered but is INVALID: %s" % (control_id, cal["a0_invalid_reason"])))
    if not cal["a4_usable"]:
        lost.append((degen_id, "criterion (5), the anti-degeneracy guard",
                     ("%s is absent from %s" % (degen_id, root)) if not cal["a4_present"]
                     else "%s rendered but is INVALID: %s" % (degen_id, cal["a4_invalid_reason"])))
    if lost:
        mixed = not cal.get("source_consistent", True)
        names = "/".join(n for n, _, _ in lost if n != "the run itself") or "the run"
        near = [r["arm"] for r in rows if r["arm"] not in (control_id, degen_id)
                and r["criteria_met"]]
        det = [why for _, _, why in lost]
        det += ["%s calibrates %s, so it could not be evaluated for any arm."
                % (n, what) for n, what, _ in lost if n != "the run itself"]
        if mixed:
            det.insert(1, "Re-run --ceiling and re-score EVERY arm against the "
                          "current blocking clip before reading any number here.")
            return {"verdict": "NO RESULT", "branch": "d",
                    "label": "NO RESULT - mixed blocking renders, the numbers are "
                             "not comparable",
                    "headline": "NO RESULT: these scores were not all produced "
                                "against the same blocking clip.",
                    "arm": None, "operating_point": None, "detail": det,
                    "numbers": {"degenerate_arm": degen_id, "control_arm": control_id,
                                "degenerate_CMA": None, "anchor": anchor}}
        if not cal["a4_usable"]:
            det.append("An arm that reproduces the gray boxes scores a perfect "
                       "camera match without generating anything; with no A4 "
                       "there is no way to tell that arm from a real one.")
        if not cal["a0_usable"]:
            det.append("Every arm's CMA is unanchored without the text-only "
                       "control: a high score could be the corridor's natural "
                       "forward bias rather than the blocked move.")
        det.append("This is NOT a negative result. Re-run %s and re-report."
                   % names)
        if near:
            det.append("For information only: %s met the evaluable criteria. "
                       "That is not a pass." % ", ".join(near))
        return {"verdict": "NO RESULT", "branch": "d",
                "label": "NO RESULT - %s missing or invalid, so the gate has no "
                         "calibration" % names,
                "headline": "NO RESULT: calibration arm(s) %s missing or invalid, "
                            "so %s could not be evaluated for any arm."
                            % (names, " and ".join(
                                "criterion (2)" if n == control_id else "criterion (5)"
                                for n, _, _ in lost)),
                "arm": None, "operating_point": None, "detail": det,
                "numbers": {"degenerate_arm": degen_id, "control_arm": control_id,
                            "degenerate_CMA": (docs[degen_id]["median"]["CMA"]
                                               if cal["a4_usable"] else None),
                            "anchor": anchor}}

    a4_cma = a4["median"]["CMA"]
    a4_null = a4["median"]["NULL"]
    a4_ssim = a4["median"]["SSIM_block"]
    a0_ssim = docs[control_id]["median"]["SSIM_block"]

    # (e) AN ARM THAT MAY NOT PASS, PASSED. Before GREEN, and it OUTRANKS a
    # GREEN in the same table: if an arm that cannot possibly be carrying the
    # control video cleared all five criteria, then the criteria did not
    # discriminate, and a qualified arm clearing the same five proves nothing.
    if barred_passers:
        names = ", ".join(r["arm"] for r in barred_passers)
        det = []
        kinds = []
        for r in barred_passers:
            kind = row_bar_kind(r, degen_id)
            kinds.append(kind)
            spec = BAR_REASONS[kind]
            why = r["barred_why"] or (spec["default_why"] % r["arm"])
            det.append("%s met all five criteria (CMA %.3f, MR %.2f, SSIM_block "
                       "%.3f, NULL %.3f) -- and %s."
                       % (r["arm"], r["cma"], r["mr"], r["ssim"], r["null"], why))
            # ⚠ THE SENTENCE THAT IS TRUE OF *THIS* REASON. One sentence over all
            # three kinds asserted "carries no control signal" about the masked
            # calibrator and about the saturation probes, contradicting the
            # operating-point line printed immediately below it.
            det.append("%s is %s: it %s. %s"
                       % (r["arm"], spec["phrase"], spec["carries"],
                          spec["implication"]))
            det.append("OPERATING POINT of %s: %s" % (r["arm"], arm_operating_point(root, r["arm"])))
        det.append("A pass by an arm that MAY NOT PASS is a defect in the pass rule "
                   "or in the scoring, not a finding about conditioning: the five "
                   "criteria did not separate the arms under test from an arm that "
                   "was excluded in advance.")
        if passers:
            det.append("%s also met all five. That does NOT stand: the same five "
                       "criteria just admitted %s, so they cannot be read as "
                       "evidence for anything here."
                       % (", ".join(r["arm"] for r in passers),
                          " and ".join(sorted({BAR_REASONS[k]["admits"]
                                               for k in kinds}))))
        det.append("Fix the criteria (or find the scoring bug) and re-report. "
                   "CONCLUDE NOTHING ABOUT CONDITIONING from this run.")
        return {"verdict": "NO RESULT", "branch": "e",
                "label": "NO RESULT - a disqualified arm cleared the pass rule",
                "headline": "NO RESULT: %s may not be reported as a pass and yet "
                            "met all five criteria, so the pass rule did not "
                            "discriminate." % names,
                "arm": None, "operating_point": None, "detail": det,
                "numbers": {"degenerate_arm": degen_id, "control_arm": control_id,
                            "degenerate_CMA": a4_cma, "anchor": anchor,
                            "barred_passers": [r["arm"] for r in barred_passers],
                            "barred_passer_kinds": {r["arm"]: row_bar_kind(r, degen_id)
                                                    for r in barred_passers},
                            "would_be_green": [r["arm"] for r in passers]}}

    # (h) NOT ONE ARM UNDER TEST IS PRESENT AND QUALIFIED.
    #
    # AFTER (d) and (e) -- a missing calibration and a pass rule that did not
    # discriminate are both true and worth saying about any root -- and BEFORE
    # everything else, because every remaining branch makes a claim about
    # CONDITIONING and there is nobody here to make it about. "No arm passed" is
    # then true only because no arm was asked.
    under_test = arms_under_test(rows, cal)
    if not under_test:
        recon = (a4_ssim >= T_RECON_SSIM and a4_ssim - T_SSIM_MARGIN > a0_ssim)
        at_anchor_h = (anchor is not None and a4_cma >= anchor - VERDICT_ANCHOR_TOL
                       and a4_cma >= T_CMA_ABS and a4_cma > a4_null)
        det = ["Arms in this root: %s." % ", ".join(r["arm"] for r in rows)]
        for r in rows:
            if r["arm"] == control_id:
                role = ("the text-only control -- criterion (2)'s own baseline, "
                        "which can never clear its own margin, so it is not an arm "
                        "under test")
            elif r["arm"] == degen_id:
                role = ("the criterion-(5) degeneracy calibrator -- disqualified by "
                        "construction")
            elif r["arm"] in barred:
                role = "MAY NOT PASS: %s" % barred[r["arm"]]
            elif not r["valid"]:
                role = ("INVALID, so it could not have passed whatever it scored: %s"
                        % (r["invalid_reason"] or "not a complete render"))
            else:
                role = "an arm under test"          # unreachable while under_test is empty
            det.append("  %s -- %s" % (r["arm"], role))
        det.append("NOT ONE ARM UNDER TEST IS PRESENT AND QUALIFIED, so NOTHING "
                   "ABOUT CONDITIONING IS ESTABLISHED HERE. A verdict of GREEN, of "
                   "DECISIVE NEGATIVE, or of 'the metric is the suspect' is in "
                   "every case a statement about the arms that GENERATE while "
                   "carrying the control video. With none of them in this root "
                   "there is nothing to make that statement about: 'no arm passed' "
                   "is true only because no arm was asked.")
        # WHAT THIS ROOT *DOES* ESTABLISH. It is the calibration and nothing else
        # -- and for a staged run that is precisely what the stage was bought to
        # measure, so it is stated with both halves and both numbers.
        det.append("WHAT THIS ROOT DOES ESTABLISH -- the calibration of criterion "
                   "(5), and nothing else: %s SSIM_block %.3f against the %.2f "
                   "reconstruction floor (%s), and %.3f clear of the text-only "
                   "control %s's own %.3f, which must exceed %.2f (%s)  ->  %s."
                   % (degen_id, a4_ssim, T_RECON_SSIM,
                      "ok" if a4_ssim >= T_RECON_SSIM else "BELOW",
                      a4_ssim - a0_ssim, control_id, a0_ssim, T_SSIM_MARGIN,
                      "ok" if a4_ssim - T_SSIM_MARGIN > a0_ssim else "BELOW",
                      "RECONSTRUCTED" if recon else "DID NOT RECONSTRUCT"))
        if recon:
            det.append("So criterion (5) IS calibrated: the bar the arms under test "
                       "would face is %.3f, and it clears the control's own %.3f. A "
                       "root that also holds the arms under test can be evaluated."
                       % (a4_ssim - T_SSIM_MARGIN, a0_ssim))
        else:
            det.append("So criterion (5) would be NOT EVALUATED for every arm and NO "
                       "ARM COULD PASS, whatever it scored. Re-aim the calibrator "
                       "before spending anything on the arms under test. For %s: %s."
                       % (FAMILIES[FAMILY]["cond_node"],
                          FAMILIES[FAMILY].get("degenerate_recipe",
                                               "see the run script")))
        if anchor is not None:
            det.append("For reference, the metric side: %s CMA %.3f against the "
                       "reconstruction anchor %.3f (tolerance %.2f) and its own NULL "
                       "%.3f -- %s. That is NOT a conditioning result either; it "
                       "says the metric can see the move in an output that contains "
                       "it." % (degen_id, a4_cma, anchor, VERDICT_ANCHOR_TOL,
                                a4_null,
                                "at the anchor" if at_anchor_h else "BELOW the anchor"))
        else:
            det.append("There is no reconstruction anchor in this root, so the metric "
                       "side is not measured here either -- run --ceiling (CPU only, "
                       "~11 s).")
        det.append("CONCLUDE NOTHING ABOUT CONDITIONING from this root. Dispatch the "
                   "arms under test and re-report.")
        return {"verdict": "NO RESULT", "branch": "h",
                "label": "NO RESULT - no arm under test is in this root, so nothing "
                         "about conditioning is established",
                "headline": "NO RESULT: this root holds no arm under test -- only "
                            "%s (the control), %s (the calibrator) and/or arms that "
                            "may not pass -- so the only thing measured here is the "
                            "calibration, which %s."
                            % (control_id, degen_id,
                               "HOLDS" if recon else "DOES NOT HOLD"),
                "arm": None, "operating_point": None, "detail": det,
                "numbers": {"degenerate_arm": degen_id, "control_arm": control_id,
                            "degenerate_CMA": a4_cma, "anchor": anchor,
                            "degenerate_SSIM_block": a4_ssim,
                            "control_SSIM_block": a0_ssim,
                            "degenerate_NULL": a4_null,
                            "reconstruction_floor": T_RECON_SSIM,
                            "reconstructed": bool(recon),
                            "arms_under_test": []}}

    # (a) GREEN
    if passers:
        best = max(passers, key=lambda r: r["cma"])
        op = arm_operating_point(root, best["arm"])
        det = ["%s passed all five criteria: CMA %.3f (floor %.2f), %s + margin, "
               "> its own NULL %.3f, MR %.2f in [%.1f,%.1f], SSIM_block %.3f "
               "(bar %.3f)." % (best["arm"], best["cma"], T_CMA_ABS, control_id,
                                best["null"], best["mr"], T_MR_LO, T_MR_HI,
                                best["ssim"], a4_ssim - T_SSIM_MARGIN),
               "OPERATING POINT (this is what step 2 inherits): %s" % op,
               "Reconstruction anchor for reference: %s; %s %.3f."
               % ("%.3f" % anchor if anchor is not None else "not measured",
                  degen_id, a4_cma),
               "Trajectory check on per-frame steps: tx %+.2f ty %+.2f theta %+.2f."
               % (best["traj"]["tx"], best["traj"]["ty"], best["traj"]["theta"])]
        if len(passers) > 1:
            det.append("Also passing: %s." % ", ".join(
                r["arm"] for r in passers if r["arm"] != best["arm"]))
        # A GREEN survives a weak calibrator -- the calibrator only interprets a
        # NEGATIVE -- but the anti-degeneracy guard it sets is then loose, and
        # that has to be on the artefact rather than in someone's head.
        if a4_ssim < T_RECON_SSIM:
            det.append("CAVEAT ON (5): the calibrator %s scored SSIM_block %.3f, "
                       "below the %.2f reconstruction floor, so the bar it set "
                       "(%.3f) is looser than intended. The pass stands on (1)-(4) "
                       "and on a bar that %s still cleared, but re-aim the "
                       "calibrator before this GREEN is quoted as a measured "
                       "operating point."
                       % (degen_id, a4_ssim, T_RECON_SSIM, a4_ssim - T_SSIM_MARGIN,
                          best["arm"]))
        return {"verdict": "GREEN", "branch": "a",
                "label": "GREEN - %s carries the blocked camera move" % best["arm"],
                "headline": "GREEN: %s passes all five criteria." % best["arm"],
                "arm": best["arm"], "operating_point": op, "detail": det,
                "numbers": {"degenerate_arm": degen_id, "control_arm": control_id,
                            "degenerate_CMA": a4_cma, "anchor": anchor,
                            "arm_CMA": best["cma"]}}

    # (f) (b)/(c)/(g) need the anchor to tell them apart.
    if anchor is None:
        return {"verdict": "NO RESULT", "branch": "f",
                "label": "NO RESULT - no reconstruction anchor on disk",
                "headline": "NO RESULT: no arm passed, and with no reconstruction "
                            "anchor there is no way to tell a decisive negative "
                            "from a broken instrument.",
                "arm": None, "operating_point": None,
                "detail": ["%s is missing -- run --ceiling (CPU only, ~11 s) and "
                           "re-report." % os.path.join(root, CEIL_NAME),
                           "%s CMA is %.3f; whether that is high or low is exactly "
                           "the question the anchor answers." % (degen_id, a4_cma)],
                "numbers": {"degenerate_arm": degen_id, "control_arm": control_id,
                            "degenerate_CMA": a4_cma, "anchor": None}}

    # ⚠ TWO INDEPENDENT QUESTIONS, AND THE BRANCH USED TO ASK ONLY ONE.
    #
    #   reconstructed  did the calibrator actually hand the source back? That is
    #                  an SSIM question and nothing else. Both halves are needed
    #                  -- an absolute floor because a low-scoring control makes
    #                  the relative test free, and the margin over the control
    #                  because a clip with a high gray floor makes the absolute
    #                  test free. See T_RECON_SSIM.
    #   at_anchor      given that it did, does the METRIC see the move in it?
    #
    # "The path transports the move" needs BOTH. CMA alone answers neither
    # question on its own: an arm can score a high CMA by drifting the right way
    # while looking nothing like the source, which is precisely what NULL and the
    # anchor exist to disbelieve.
    reconstructed = (a4_ssim >= T_RECON_SSIM
                     and a4_ssim - T_SSIM_MARGIN > a0_ssim)
    at_anchor = (a4_cma >= anchor - VERDICT_ANCHOR_TOL
                 and a4_cma >= T_CMA_ABS and a4_cma > a4_null)

    # (g) THE CALIBRATOR DID NOT RECONSTRUCT. This is the most likely failure of
    # a run whose anchor is aimed wrong, and the old code sent it to branch (c),
    # whose remedies all point at the METRIC -- the mask floor, the analysis
    # resolution, whether the npz matches the mp4. Every one of those is the
    # wrong subsystem. If the arm that was supposed to hand back the source did
    # not hand back the source, transport was never established and the metric
    # has not been given anything to fail at.
    if not reconstructed:
        why = []
        if a4_ssim < T_RECON_SSIM:
            why.append("SSIM_block %.3f is below the %.2f reconstruction floor"
                       % (a4_ssim, T_RECON_SSIM))
        if a4_ssim - T_SSIM_MARGIN <= a0_ssim:
            why.append("its SSIM_block %.3f is not %.2f clear of the text-only "
                       "control %s's own %.3f -- it is no closer to the blockout "
                       "than free generation already is"
                       % (a4_ssim, T_SSIM_MARGIN, control_id, a0_ssim))
        det = ["%s was supposed to hand the source back and did not: %s."
               % (degen_id, "; ".join(why)),
               "OPERATING POINT of the calibrator: %s"
               % arm_operating_point(root, degen_id),
               "TRANSPORT WAS THEREFORE NEVER ESTABLISHED. Do NOT debug the "
               "metric: no arm in this run demonstrated that the control pixels "
               "can reach the output at all, so there is nothing yet for the "
               "metric to have missed.",
               # The remedy belongs to the ACTIVE family's mechanism. Printing
               # the WAN recipe under an LTX table would send someone to wire a
               # control_masks input on a node that has none.
               "RE-AIM THE CALIBRATOR. It must be degenerate by TRAINED "
               "BEHAVIOUR, not by out-of-range gain. For %s: %s."
               % (FAMILIES[FAMILY]["cond_node"],
                  FAMILIES[FAMILY].get("degenerate_recipe", "see the run script")),
               "CONCLUDE NOTHING ABOUT CONDITIONING from this run.",
               "%s's CMA is %.3f against an anchor of %.3f and its own NULL %.3f."
               % (degen_id, a4_cma, anchor, a4_null)]
        # NAME THE NEAR MISSES, as branch (d) already does. Re-aiming the
        # calibrator costs renders, and "which arms were one uncalibrated
        # criterion away" is the single number that decides whether it is worth
        # it. Leaving it to be re-derived from the table is how a re-aim gets
        # skipped.
        near = [r["arm"] for r in arms_under_test(rows, cal) if r["criteria_met"]]
        if near:
            det.append("For information only: %s met every criterion that COULD be "
                       "evaluated. That is NOT a pass -- (5) is the guard that "
                       "separates a restyled arm from one handing the boxes back, "
                       "and it is exactly the criterion this run could not "
                       "calibrate. Re-aiming %s is what turns those rows into a "
                       "result." % (", ".join(near), degen_id))
        else:
            det.append("No arm under test met even the criteria that COULD be "
                       "evaluated, so re-aiming %s would not by itself produce a "
                       "pass." % degen_id)
        if at_anchor:
            # ASCII only: this string is PRINTED, and stdout on this rig is
            # cp1252. A non-ASCII glyph in a detail line raises
            # UnicodeEncodeError and takes the whole verdict down with it.
            det.insert(1, "!! AND ITS CMA IS HIGH (%.3f, at the anchor %.3f). That "
                          "is NOT transport: a high CMA on an output that looks "
                          "nothing like the source (SSIM_block %.3f) means the "
                          "clip happened to drift the right way, which is the "
                          "coincidence NULL and the anchor exist to disbelieve. "
                          "Reading it as transport is how a run reports its own "
                          "mis-aimed calibrator as a decisive negative."
                          % (a4_cma, anchor, a4_ssim))
        return {"verdict": "NO RESULT", "branch": "g",
                "label": "NO RESULT - the calibrator did not reconstruct, so "
                         "transport was never established",
                "headline": "NO RESULT: no arm passed, and the degeneracy "
                            "calibrator %s did not reconstruct the source "
                            "(SSIM_block %.3f, floor %.2f, control %s at %.3f) -- "
                            "so this run never showed the control pixels reaching "
                            "the output."
                            % (degen_id, a4_ssim, T_RECON_SSIM, control_id, a0_ssim),
                "arm": None, "operating_point": None, "detail": det,
                "numbers": {"degenerate_arm": degen_id, "control_arm": control_id,
                            "degenerate_CMA": a4_cma, "anchor": anchor,
                            "degenerate_SSIM_block": a4_ssim,
                            "control_SSIM_block": a0_ssim,
                            "degenerate_NULL": a4_null,
                            "reconstruction_floor": T_RECON_SSIM,
                            "cma_at_anchor": bool(at_anchor)}}

    if at_anchor:
        return {"verdict": "DECISIVE NEGATIVE", "branch": "b",
                "label": "DECISIVE NEGATIVE - guides transport the move, "
                         "generation discards it",
                "headline": "DECISIVE NEGATIVE: the conditioning path provably "
                            "transports the move (%s CMA %.3f vs reconstruction "
                            "anchor %.3f, tolerance %.2f), and every arm that also "
                            "GENERATES discards it."
                            % (degen_id, a4_cma, anchor, VERDICT_ANCHOR_TOL),
                "arm": None, "operating_point": None,
                "detail": ["%s reproduces the source -- SSIM_block %.3f, above the "
                           "%.2f reconstruction floor AND %.3f clear of the "
                           "text-only control %s (%.3f) -- and scores CMA %.3f "
                           "against an anchor of %.3f, above its own NULL %.3f. "
                           "BOTH halves hold, so the pixels DO reach the latent and "
                           "the metric DOES see the move in them."
                           % (degen_id, a4_ssim, T_RECON_SSIM, a4_ssim - a0_ssim,
                              control_id, a0_ssim, a4_cma, anchor, a4_null),
                           "OPERATING POINT of the calibrator: %s"
                           % arm_operating_point(root, degen_id),
                           "No arm that actually restyled cleared all five criteria.",
                           # The scope sentence is the ACTIVE family's, so a WAN
                           # negative cannot be captioned as an LTX one.
                           "This is a publishable negative, and its scope is EXACTLY "
                           "this: %s" % SCOPE["reads_as"],
                           "Grid actually sampled: %s." % _grid_summary(root, docs)],
                "numbers": {"degenerate_arm": degen_id, "control_arm": control_id,
                            "degenerate_CMA": a4_cma, "anchor": anchor,
                            "degenerate_SSIM_block": a4_ssim,
                            "control_SSIM_block": a0_ssim,
                            "degenerate_NULL": a4_null}}

    # (c) THE CALIBRATOR DID RECONSTRUCT AND THE METRIC STILL DID NOT SEE IT.
    # This is now the ONLY state in which the measuring side is the suspect, and
    # it is a narrow one: the arm demonstrably handed the source back, so the
    # move is in those pixels by construction and something in the ruler missed
    # it. Branch (g) above catches the far more common case -- a calibrator that
    # never reconstructed -- and sends it somewhere else entirely.
    return {"verdict": "NO RESULT", "branch": "c",
            "label": "NO RESULT - the calibrator reconstructed and the metric "
                     "still did not score it",
            "headline": "NO RESULT: no arm passed, and the degenerate arm %s DID "
                        "reconstruct the source (SSIM_block %.3f) yet still scored "
                        "CMA %.3f against an anchor of %.3f -- so the metric or the "
                        "source clip is the suspect."
                        % (degen_id, a4_ssim, a4_cma, anchor),
            "arm": None, "operating_point": None,
            "detail": ["%s returns the source almost verbatim (SSIM_block %.3f, "
                       "%.3f clear of the control %s). The move is therefore IN "
                       "those pixels, and the failure is on the measuring side."
                       % (degen_id, a4_ssim, a4_ssim - a0_ssim, control_id),
                       "CONCLUDE NOTHING ABOUT CONDITIONING from this run.",
                       "Check first, in this order: (1) the mask floor MAG_FLOOR = "
                       "%.2f px/frame at %dx%d -- if it is above the real motion, "
                       "the surviving pairs are noise; (2) the analysis resolution "
                       "%dx%d and the 0.25 downsample factor baked into the npz; "
                       "(3) that gate_block.mp4 and gate_block_flow.npz are the "
                       "SAME render." % (MAG_FLOOR, AW, AH, AW, AH),
                       "%s's own NULL is %.3f; if its CMA is near NULL the metric "
                       "is seeing nothing at all." % (degen_id, a4_null)],
            "numbers": {"degenerate_arm": degen_id, "control_arm": control_id,
                        "degenerate_CMA": a4_cma, "anchor": anchor,
                        "degenerate_SSIM_block": a4_ssim,
                        "control_SSIM_block": a0_ssim,
                        "degenerate_NULL": a4_null}}


def _grid_summary(root, docs):
    """What the sweep actually covered, printed on the artefact rather than
    left in someone's memory."""
    bits = []
    for k in sorted(docs):
        op = arm_operating_point(root, k)
        bits.append("%s %s" % (k, op.split("   [read from")[0]))
    return "; ".join(bits) if bits else "unknown"


def load_anchor(root, override=None):
    """The reconstruction anchor, resolved under --root (not the module
    constant: --root pointing elsewhere used to silently read the default
    install's anchor). Returns (value_or_None, path_or_None, note).

    `override` (--anchor PATH) exists because the anchor is a property of the
    BLOCKING CLIP AND THE METRIC, not of the model: mode_ceiling measures DIS
    against the analytic ground truth for the blockout and never touches an arm.
    So one --ceiling run serves every family that conditioned on the same clip,
    and a second run's root would otherwise have no anchor and fall to verdict
    branch (c) -- NO RESULT for a reason that is purely bookkeeping.

    ⚠ THIS IS SAFE ONLY BECAUSE source_consistency() CHECKS IT. The anchor doc
    carries the blocking clip's sha256, and a mismatch against the arm docs
    blocks the verdict outright. Pointing --anchor at an anchor measured on a
    different blockout does not quietly succeed.
    """
    if override:
        p = os.path.abspath(override)
        if not os.path.exists(p):
            return None, None, "--anchor %s does not exist" % p
        d = json.load(open(p))
        if "CMA_reconstruction_anchor" not in d:
            return None, p, ("--anchor %s has no CMA_reconstruction_anchor key -- "
                             "re-run --ceiling" % p)
        return float(d["CMA_reconstruction_anchor"]), p, (
            "anchor taken from --anchor %s (a different root). It is a property of "
            "the blocking clip and the metric, not of the model; "
            "source_consistency below proves it was measured on THIS blockout." % p)
    p = os.path.join(root, CEIL_NAME)
    if not os.path.exists(p):
        if os.path.abspath(root) != os.path.abspath(GATE) and os.path.exists(CEIL_JSON):
            return None, None, ("no %s under --root %s (the default install has "
                                "one, but it describes a different run and is NOT "
                                "being used)" % (CEIL_NAME, root))
        return None, None, "no %s -- run --ceiling first" % p
    d = json.load(open(p))
    if "CMA_reconstruction_anchor" in d:
        return float(d["CMA_reconstruction_anchor"]), p, None
    return None, p, ("%s predates the anchor rename (no CMA_reconstruction_anchor "
                     "key) -- re-run --ceiling; the old CMA_ceiling field was "
                     "measured over pairs no arm can occupy and is NOT used" % p)


CONTROLS_NAME = "gate_controls.json"


def resolve_controls(root, docs, want_control=None, want_degenerate=None):
    """WHICH ARM IS THE CRITERION-2 BASELINE, and which calibrates criterion (5).

    ⚠⚠ THE ONE MISTAKE THAT WOULD PRODUCE A CONFIDENT WRONG ANSWER. ⚠⚠

    Criterion (2) is "CMA >= <control> + margin". Until this function existed the
    control was the literal "A0" -- an LTX render. A WAN VACE arm scored against
    it would have been compared to a DIFFERENT MODEL while every heading and the
    verdict said the comparison was between conditioning paths, and nothing in
    the output would have looked wrong. That is the failure this whole function
    exists to make impossible, and it is made impossible three independent ways:

      (1) FAMILY FROM THE ARM IDS. Every arm under --root must belong to one
          family (A* = LTX, W* = WAN VACE). A root containing both is refused
          outright -- there is no correct control for such a mixture.
      (2) THE RUN'S OWN DECLARATION. vace_run.mjs writes gate_controls.json into
          its root naming its control and degenerate arm. It is READ AND OBEYED,
          and a --control/--degenerate flag that CONTRADICTS it is a hard error
          rather than a silent override: the flag is for a root that has no
          declaration, not for arguing with one that does.
      (3) FAMILY OF THE NAMED ARMS. Whatever the source, the resolved control
          and degenerate must be in the same family as the arms. A0 for W arms
          is refused by name.

    ⚠⚠ AND IT ALSO READS THE `disqualified` LIST, WHICH IT USED NOT TO. ⚠⚠

    vace_run.mjs writes `disqualified: ["W6","W7","W9"]` into gate_controls.json
    and this file ignored it completely: only the DEGENERATE arm was barred from
    passing. So W8 -- the zero-strength null, whose residual is multiplied by
    exactly 0.00 and which therefore cannot be carrying the control video at all
    -- was eligible to clear all five criteria and be announced as GREEN. An
    instrument that can report its own null arm as the finding is worse than no
    instrument.

    Two independent sources, unioned, because a declaration can be stale and a
    graph can be missing:
      * the run's own `disqualified` list;
      * ANY arm whose VACE residual strength is exactly 0.00, read from the
        DISPATCHED GRAPH first and from the declaration second. This one needs
        no list to be maintained: it is derived from what was actually built.

    Returns (family, control_id, degenerate_id, primary_id, notes, barred),
    where `barred` is {arm_id: why}.
    """
    notes = []
    fams = {}
    for arm_id, d in docs.items():
        f = arm_family(arm_id)
        fams.setdefault(f, []).append(arm_id)
        # If the scoring run recorded a family, it must agree with the id.
        rec = d.get("family")
        if rec and f and rec != f:
            raise SystemExit(
                "%s was scored as family %s but its id says %s. One of the two is "
                "wrong and there is no safe way to guess which -- re-score it."
                % (arm_id, rec, f))
    if None in fams:
        raise SystemExit(
            "these arm directories do not name a known family (%s): %s\n"
            "  The family letter decides which arm is the criterion-2 control, so "
            "an unrecognised id cannot be scored."
            % ("/".join(sorted(FAMILIES)), ", ".join(sorted(fams[None]))))
    if len(fams) > 1:
        raise SystemExit(
            "REFUSING TO REPORT: %s holds arms from MORE THAN ONE FAMILY -- %s\n"
            "  Criterion (2) is 'CMA >= control + margin'. With two models in one\n"
            "  root there is no control that is valid for both, and comparing one\n"
            "  family's arm against the other's control is a MODEL comparison\n"
            "  wearing a conditioning comparison's clothes. Score each run in its\n"
            "  own root."
            % (root, "; ".join("%s: %s" % (f, ",".join(sorted(v)))
                               for f, v in sorted(fams.items()))))
    fam = next(iter(fams))
    spec = FAMILIES[fam]
    control, degenerate = spec["control"], spec["degenerate"]
    source = "the %s family default" % fam

    cpath = os.path.join(root, CONTROLS_NAME)
    declared = None
    if os.path.exists(cpath):
        declared = json.load(open(cpath))
        if declared.get("family") and declared["family"] != fam:
            raise SystemExit(
                "%s declares family %s but the arms in %s are family %s."
                % (cpath, declared["family"], root, fam))
        control = declared.get("control", control)
        degenerate = declared.get("degenerate", degenerate)
        source = "%s (written by %s)" % (CONTROLS_NAME, declared.get("written_by", "?"))
        notes.append("controls declared by the run itself: control=%s degenerate=%s  [%s]"
                     % (control, degenerate, cpath))

    for flag, got, name in ((want_control, control, "--control"),
                            (want_degenerate, degenerate, "--degenerate")):
        if flag and flag != got:
            if declared is not None:
                raise SystemExit(
                    "%s says %s but %s in %s names %s.\n"
                    "  Refusing to override a run's own declaration from the command\n"
                    "  line -- that flag exists for a root with no declaration, not\n"
                    "  for arguing with one that has it. Delete or fix %s if it is\n"
                    "  genuinely wrong." % (name, flag, CONTROLS_NAME, root, got, cpath))
            if name == "--control":
                control, source = flag, "the --control flag"
            else:
                degenerate, source = flag, "the --degenerate flag"

    for who, arm_id in (("control", control), ("degenerate", degenerate)):
        f = arm_family(arm_id)
        if f != fam:
            raise SystemExit(
                "REFUSING TO REPORT: the %s arm is %s (family %s) but these arms are "
                "family %s.\n"
                "  %s comes from: %s.\n"
                "  Scoring a %s arm against it compares two MODELS while claiming to\n"
                "  compare two conditioning paths."
                % (who, arm_id, f or "unknown", fam, arm_id,
                   FAMILIES.get(f, {}).get("label", "a different model"), fam))

    # ---- WHO MAY NOT BE REPORTED AS A PASS ---------------------------------
    declared_arms = (declared or {}).get("arms") or []
    strengths = {a: arm_strength(root, a, declared_arms) for a in sorted(docs)}

    # ⚠⚠ THE DERIVED BAR MUST NEVER FALL OPEN QUIETLY. ⚠⚠
    #
    # The zero-strength bar is derived: it reads the DISPATCHED GRAPH, and falls
    # back to gate_controls.json's arms[] when the graph is gone. When NEITHER
    # can supply a strength the bar simply did not fire, and an arm at strength
    # 0.00 -- which carries nothing by arithmetic -- was eligible to be reported
    # GREEN. That is FATAL 1 exactly, and its whole signature was a missing
    # line. It refuses now, and it names what to restore.
    if FAMILIES[fam].get("zero_strength_bar"):
        blind = [a for a in sorted(docs) if strengths[a][0] is None]
        if blind:
            raise SystemExit(
                "REFUSING TO REPORT: the VACE residual strength of %s cannot be "
                "determined,\n"
                "  so the derived zero-strength bar CANNOT BE APPLIED to %s.\n"
                "  There is no %s/_graphs/<arm>_s*.json holding a WanVaceToVideo "
                "strength for %s,\n"
                "  and %s carries no arms[] entry with a strength for %s either.\n"
                "\n"
                "  That bar is the one thing standing between the ZERO-STRENGTH "
                "NULL and a GREEN:\n"
                "  at strength 0.00 the residual is `x += c_skip * 0.00`, "
                "arithmetically nothing, so such an\n"
                "  arm cannot be carrying the control video whatever it scores. A "
                "bar that falls open in\n"
                "  silence is how that arm gets announced as the answer.\n"
                "\n"
                "  Restore either source and re-report:\n"
                "    - the graphs the run dispatched (%s/_graphs/), or\n"
                "    - a %s written by the run, whose arms[] carries each arm's "
                "strength\n"
                "      (scripts/vace_run.mjs writes it on every invocation, dry "
                "runs included)."
                % (", ".join(blind), ", ".join(blind), root, ", ".join(blind),
                   CONTROLS_NAME, ", ".join(blind), root, CONTROLS_NAME))
        readable = [a for a in sorted(docs) if strengths[a][0] is not None]
        notes.append("residual strength per arm (what the derived zero-strength bar "
                     "reads): %s"
                     % "; ".join("%s %.2f [%s]" % (a, strengths[a][0], strengths[a][1])
                                 for a in readable))

    # WHO MAY NOT PASS, AND -- SEPARATELY -- WHY. The three reasons are not
    # interchangeable and the verdict prints a different sentence for each; see
    # BAR_REASONS.
    barred, barred_kinds = {}, {}
    declared_dq = set((declared or {}).get("disqualified") or [])
    for arm_id in sorted(docs):
        s, src = strengths[arm_id]
        zero = s is not None and abs(s) < 1e-9
        if not (arm_id in declared_dq or zero):
            continue
        kind = bar_kind(root, arm_id, s, degenerate)
        barred_kinds[arm_id] = kind
        if kind == "zero_strength":
            barred[arm_id] = ("its VACE residual strength is exactly 0.00 (read "
                              "from the %s), so `x += c_skip * 0.0` contributes "
                              "nothing and this arm CANNOT be carrying the control "
                              "video whatever it scored" % src)
        elif kind == "calibrator":
            barred[arm_id] = ("it is the criterion-(5) degeneracy calibrator: "
                              "control_masks all zeros TELLS it to hand the source "
                              "footage back, so it carries the control video at "
                              "full strength and reproduces the clip BY "
                              "CONSTRUCTION%s"
                              % (" (and %s lists it as DISQUALIFIED)" % CONTROLS_NAME
                                 if arm_id in declared_dq else ""))
        else:
            barred[arm_id] = ("%s lists it as DISQUALIFIED (written by %s)"
                              % (CONTROLS_NAME, (declared or {}).get("written_by", "?")))
    for arm_id in sorted(set((declared or {}).get("disqualified") or []) - set(docs)):
        notes.append("%s names %s as disqualified but it has no %s under %s -- "
                     "nothing to bar" % (CONTROLS_NAME, arm_id, SCORE_NAME, root))

    # The PRIMARY arm, for the seed-spread widening only: the family's control
    # numbered 1 (A1, W1). Absent is fine -- the widening simply watches one arm.
    primary = fam + "1"
    notes.append("criterion (2) baseline = %s, criterion (5) calibrator = %s  [from %s]"
                 % (control, degenerate, source))
    notes.append("MAY NOT PASS: %s" % ("; ".join(
        "%s [%s] (%s)" % (k, BAR_REASONS[barred_kinds[k]]["short"], v)
        for k, v in sorted(barred.items())) if barred
        else "%s only (the calibrator, by construction)" % degenerate))
    return (fam, control, degenerate, (primary if primary in docs else None), notes,
            barred, barred_kinds)


def mode_report(root, control=None, degenerate=None, anchor_path_override=None):
    root = os.path.abspath(root)
    docs = {}
    for p in sorted(glob.glob(os.path.join(root, "*", SCORE_NAME))):
        d = json.load(open(p))
        docs[d["arm"]] = d
    if not docs:
        raise SystemExit("no %s under %s -- run --score first" % (SCORE_NAME, root))

    # ⚠ BEFORE ANY NUMBER IS READ. resolve_controls raises rather than guessing.
    (fam, control_id, degen_id, primary_id, control_notes, barred,
     barred_kinds) = resolve_controls(root, docs, control, degenerate)
    set_family(fam)

    anchor, anchor_path, anchor_note = load_anchor(root, anchor_path_override)
    anchor_doc = json.load(open(anchor_path)) if anchor_path else None

    rows, margin, note, cal = apply_pass_rule(docs, control_id, degen_id, primary_id,
                                              barred, barred_kinds)
    con = source_consistency(docs, anchor_doc)
    cal["source_consistent"] = con["ok"]
    cal["source_why"] = con["why"]
    cal["source_fingerprint_missing"] = con["missing"]
    print("=" * 110)
    print("GATE REPORT   (%d arms)   --  %s" % (len(rows), FAMILIES[fam]["label"]))
    print("=" * 110)
    # WHAT CALIBRATED WHAT, printed before any number, because a reader who
    # skips it has no way to tell an LTX-controlled table from a WAN one.
    for ln in control_notes:
        print("  " + ln)
    if anchor is not None:
        print("  CMA_reconstruction_anchor = %.4f  (%s)" % (anchor, anchor_path))
        # degen_id, not the literal "A4": this same line printed "A4" over a
        # table of W arms, which is exactly the cross-family mislabelling the
        # rest of this file exists to make impossible.
        print("  It is the score the DEGENERATE arm (%s) would earn by returning "
              "the source, measured" % degen_id)
        print("  over the %d pairs an arm can occupy. It is NOT a ceiling: DIS "
              "never touches the blocking" % (ARM_FRAMES - 1))
        print("  clip when scoring an arm, so an arm restyled with real texture "
              "may legitimately exceed it.")
    if anchor_note:
        print("  !! %s" % anchor_note)
    if note:
        print("  !! %s" % note)
    if not con["ok"]:
        print("  !! " + "=" * 100)
        print("  !! MIXED BLOCKING RENDERS. %s" % con["why"])
        print("  !! Arm scores and an anchor from different renders are not "
              "comparable, and the mixture is")
        print("  !! invisible -- every row below still looks plausible. NO ARM "
              "CAN PASS THIS REPORT.")
        print("  !! " + "=" * 100)
    elif con["missing"]:
        print("  !! no block fingerprint recorded in: %s -- cannot prove these "
              "numbers share one source clip" % ", ".join(sorted(con["missing"])))
    if not (cal["a0_usable"] and cal["c5_evaluated"]):
        print("  !! " + "=" * 100)
        if not cal["a0_usable"]:
            print("  !! %s %s. Criterion (2), the margin over the text-only "
                  "control, is NOT EVALUATED."
                  % (control_id, "is missing" if not cal["a0_present"] else
                     "is INVALID (%s)" % cal["a0_invalid_reason"]))
        if not cal["a4_usable"]:
            print("  !! %s %s. Criterion (5), the anti-degeneracy guard, is NOT "
                  "EVALUATED."
                  % (degen_id, "is missing" if not cal["a4_present"] else
                     "is INVALID (%s)" % cal["a4_invalid_reason"]))
        elif not cal["c5_evaluated"]:
            # SILENT INVERSION, NOW LOUD. The bar for (5) is degenerate - 0.25;
            # when the calibrator did not reconstruct, that bar drops under what
            # a normally-generating arm already scores and (5) fails EVERYONE,
            # including arms that passed (1)-(4). Marked NOT EVALUATED, never
            # failed, because a column of '.' is what a real negative looks like.
            print("  !! CRITERION (5) HAS INVERTED AND IS NOT EVALUATED:")
            print("  !!   %s" % cal["c5_not_evaluated_why"])
        print("  !! Not failed closed: a column of '.' is exactly what a real "
              "negative looks like, and an")
        print("  !! uncalibrated gate must not be readable as a failed one.")
        print("  !! NO ARM CAN PASS THIS REPORT. See the verdict below.")
        print("  !! " + "=" * 100)
    if cal.get("barred"):
        print("  !! MAY NOT PASS, whatever they score:")
        for k, v in sorted(cal["barred"].items()):
            kind = cal.get("barred_kinds", {}).get(k, "declared")
            print("  !!   %-4s [%s] %s" % (k, BAR_REASONS[kind]["short"], v))
    # ⚠ IS THERE ANYBODY HERE TO ASK? Printed before the table, in the same
    # register as the other blockers, because a reader who reaches the table
    # first will read a column of failures as a negative result.
    under_test = arms_under_test(rows, cal)
    cal["arms_under_test"] = [r["arm"] for r in under_test]
    if not under_test:
        print("  !! " + "=" * 100)
        print("  !! NOT ONE ARM UNDER TEST IS IN THIS ROOT. What is here is the "
              "text-only control, the")
        print("  !! criterion-(5) calibrator and/or arms that may not pass -- no arm "
              "that GENERATES while")
        print("  !! carrying the control video. NOTHING ABOUT CONDITIONING CAN BE "
              "ESTABLISHED, and 'no arm")
        print("  !! passed' below would be true only because no arm was asked. The "
              "calibration IS measured;")
        print("  !! see the verdict.")
        print("  !! " + "=" * 100)
    print()
    hdr = ("  arm    CMA  /anch     MR   SSIM_b    NULL  spread  rs    terr   "
           "traj r (steps) tx/ty/th   1 2 3 4 5   verdict")
    print(hdr)
    print("  " + "-" * (len(hdr) - 2))
    for r in rows:
        frac = (r["cma"] / anchor) if anchor else float("nan")
        tr = r["traj"]
        if not r["valid"]:
            vd = "INVALID"
        elif r["passed"] and (r["barred"] or r["arm"] == degen_id):
            # NEVER the bare word PASS for an arm that may not pass. The table is
            # read faster than the verdict, and "PASS" on the zero-strength null
            # is exactly the line someone would quote.
            vd = "MET ALL 5 - DISQUALIFIED"
        elif r["passed"]:
            vd = "PASS"
        elif r["barred"] or r["arm"] == degen_id:
            vd = "disqualified"
        elif r["criteria_met"] and not (r["c2_evaluated"] and r["c5_evaluated"]):
            vd = "NOT EVALUATED"
        else:
            vd = "fail"
        print("  %-4s %6.3f %6.2f  %5.2f   %6.3f  %+6.3f  %6.3f  %-3s %6.3f   "
              "%+5.2f %+5.2f %+5.2f       %s   %s"
              % (r["arm"], r["cma"], frac, r["mr"], r["ssim"], r["null"],
                 r["spread"], "Y" if r["resampled"] else ".", r["terr"],
                 tr["tx"], tr["ty"], tr["theta"],
                 " ".join("Y" if x else ("-" if x is None else ".") for x in r["c"]),
                 vd))
    print()
    print("  /anch = CMA / reconstruction anchor. Above 1.00 is possible and is "
          "not an error.")
    print("  rs / terr = resampled? and max resample time error. An arm over "
          "%.4f s (half a frame)" % RESAMPLE_TOL_S)
    print("  is INVALID: it was not a complete %d-frame render and cannot be "
          "ranked against one." % ARM_FRAMES)
    print("  traj r is Pearson on PER-FRAME STEPS, not cumulative sums "
          "(cumulative r is +0.93/+0.81/+0.90 here")
    print("  for a meaningless straight line). CONFIRMATORY ONLY -- not a pass "
          "criterion -- and its noise floor is")
    print("  neither 1.0 nor constant: a re-encode of the SOURCE FRAMES scored "
          "as an arm gives +0.10/+0.65/-0.07 on")
    print("  blocking render d54a5791 and +0.73/+0.84/+0.88 on a "
          "better-covered render of the same shot. A low")
    print("  value alone is NOT evidence of a different camera path; "
          "re-measure the floor when the clip changes.")
    print("  '-' in a criterion column = NOT EVALUATED, not failed.")
    print("  'MET ALL 5 - DISQUALIFIED' = the arm cleared every criterion but may "
          "not be reported as a pass")
    print("  (it is the criterion-(5) calibrator, or the run's own "
          "gate_controls.json disqualified it, or its VACE")
    print("  residual strength is exactly 0.00 -- three DIFFERENT reasons; the "
          "verdict names which one applies).")
    print("  That is a defect in the pass rule, not a result -- the verdict below "
          "refuses to call anything on it.")
    print()
    print("  criteria: (1) CMA >= %.2f  (2) CMA >= %s + %.3f  (3) CMA > NULL"
          % (T_CMA_ABS, control_id, margin))
    print("            (4) MR in [%.1f, %.1f]  (5) SSIM_block <= %s - %.2f"
          % (T_MR_LO, T_MR_HI, degen_id, T_SSIM_MARGIN))
    if cal["a0_usable"]:
        print("  %s median CMA = %.3f  ->  bar for (2) is %.3f"
              % (control_id, docs[control_id]["median"]["CMA"],
                 docs[control_id]["median"]["CMA"] + margin))
    # CALIBRATION OF (5), STATED. The guard is relative to a single arm on a
    # single seed; a reader must be able to see what it was calibrated on.
    if cal["a4_usable"]:
        a4d = docs[degen_id]
        a4ss, a4cma = a4d["median"]["SSIM_block"], a4d["median"]["CMA"]
        nseed = len(a4d.get("seeds", []))
        print("  (5) CALIBRATION: %s SSIM_block = %.3f over %d seed(s), spread "
              "%.3f -> bar %.3f%s."
              % (degen_id, a4ss, nseed, a4d["spread"]["CMA"], a4ss - T_SSIM_MARGIN,
                 "" if cal["c5_evaluated"] else "  [NOT EVALUATED]"))
        print("      %s operating point: %s"
              % (degen_id, arm_operating_point(root, degen_id)))
        # DID IT RECONSTRUCT? Two tests, both printed, because the verdict below
        # turns on them and "reproduces the source" must never be asserted from
        # a CMA alone -- that is how a calibrator at SSIM 0.380 got captioned
        # "reproduces the source" under a DECISIVE NEGATIVE heading.
        if cal["a0_usable"]:
            a0ss = cal["control_SSIM_block"]
            recon = (a4ss >= T_RECON_SSIM and a4ss - T_SSIM_MARGIN > a0ss)
            print("      RECONSTRUCTION: SSIM_block %.3f vs floor %.2f (%s) and vs "
                  "control %s %.3f + %.2f = %.3f (%s)  ->  %s"
                  % (a4ss, T_RECON_SSIM, "ok" if a4ss >= T_RECON_SSIM else "BELOW",
                     control_id, a0ss, T_SSIM_MARGIN, a0ss + T_SSIM_MARGIN,
                     "ok" if a4ss - T_SSIM_MARGIN > a0ss else "BELOW",
                     "RECONSTRUCTED" if recon else "DID NOT RECONSTRUCT"))
        if anchor is not None:
            conf = (a4cma >= anchor - VERDICT_ANCHOR_TOL and a4cma >= T_CMA_ABS)
            print("      METRIC:  %s CMA = %.3f vs anchor %.3f (tol %.2f)  ->  %s"
                  % (degen_id, a4cma, anchor, VERDICT_ANCHOR_TOL,
                     "at the anchor" if conf else "BELOW the anchor"))
            print("      Transport is established only when BOTH lines say yes. A "
                  "high CMA on an output that does not")
            print("      look like the source is a coincidence, not transport.")
        if not cal["c5_evaluated"]:
            print("      !! %s" % cal["c5_not_evaluated_why"])
        if nseed < 2:
            print("      NOTE: one seed, so this bar carries no spread. It "
                  "calibrates every other arm.")

    # ---------------------------------------------------------------- verdict
    v = verdict_of(rows, docs, anchor, cal, root)
    print()
    print("=" * 110)
    print("VERDICT: %s" % v["label"])
    print("=" * 110)
    print("  " + v["headline"])
    for d in v["detail"]:
        print("   - " + d)
    print()
    for ln in scope_lines():
        print("  " + ln)
    print("  Paths NOT tested: %s" % "; ".join(SCOPE["paths_not_tested"]))

    png = os.path.join(root, "gate_report.png")
    fig, ax = plt.subplots(figsize=(9, 6.6))
    for r in rows:
        bar = r["barred"] or r["arm"] == degen_id
        # A barred arm is never green on the figure either, however it scored.
        col = ("#7f7f7f" if not r["valid"]
               else "#ff7f0e" if bar
               else "#2ca02c" if r["passed"] else "#d62728")
        ax.scatter(r["ssim"], r["cma"], s=90, c=col,
                   marker=("X" if not r["valid"] else "s" if bar else "o"),
                   edgecolor="k", zorder=3)
        ax.annotate(r["arm"] + ("" if r["valid"] else " (invalid)")
                    + (" (disqualified)" if bar and r["valid"] else ""),
                    (r["ssim"], r["cma"]), textcoords="offset points",
                    xytext=(7, 4), fontsize=10)
    ax.axhline(T_CMA_ABS, color="#7f7f7f", ls=":", label="CMA floor %.2f" % T_CMA_ABS)
    if cal["a0_usable"]:
        ax.axhline(docs[control_id]["median"]["CMA"] + margin, color="#1f77b4",
                   ls="--", label="%s + %.2f" % (control_id, margin))
    if cal["a4_usable"]:
        ax.axvline(docs[degen_id]["median"]["SSIM_block"] - T_SSIM_MARGIN,
                   color="#ff7f0e", ls="--" if cal["c5_evaluated"] else ":",
                   label="%s SSIM - %.2f%s" % (degen_id, T_SSIM_MARGIN,
                                               "" if cal["c5_evaluated"]
                                               else " (NOT EVALUATED)"))
    if cal["a0_usable"]:
        ax.axvline(cal["control_SSIM_block"], color="#8c564b", ls=":", lw=1.0,
                   label="%s's own SSIM %.3f -- (5)'s bar must clear this"
                         % (control_id, cal["control_SSIM_block"]))
    if anchor is not None:
        ax.axhline(anchor, color="#9467bd", ls="-.",
                   label="reconstruction anchor %.3f (%s only)" % (anchor, degen_id))
    ax.set_xlabel("SSIM_block  (higher = closer to the gray blockout)")
    ax.set_ylabel("CMA  (camera-move adherence)")
    ax.set_title("%s\n%s -- one conditioning path, not a sweep over paths"
                 % (v["label"], FAMILIES[fam]["label"]), fontsize=10)
    ax.grid(alpha=0.3)
    ax.legend(fontsize=8, loc="best")
    fig.tight_layout()
    fig.savefig(png, dpi=110)
    plt.close(fig)

    out = {
        "kind": "report",
        "scope": SCOPE,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "root": root,
        # WHICH FAMILY, AND WHAT CALIBRATED WHAT. Recorded so a report JSON read
        # six months from now cannot be mistaken for the other run's.
        "family": fam,
        "family_label": FAMILIES[fam]["label"],
        "control_arm": control_id,
        "degenerate_arm": degen_id,
        "primary_arm": primary_id,
        "controls_resolved_from": control_notes,
        "verdict": v["verdict"],
        "verdict_branch": v["branch"],
        "verdict_label": v["label"],
        "verdict_headline": v["headline"],
        "verdict_detail": v["detail"],
        "verdict_numbers": v["numbers"],
        "green_arm": v["arm"],
        "green_operating_point": v["operating_point"],
        "CMA_reconstruction_anchor": anchor,
        "anchor_source": anchor_path,
        "anchor_note": anchor_note,
        "margin": margin,
        "margin_note": note,
        "calibration": cal,
        "source_consistency": con,
        "block_fingerprints": {k: d.get("block_fingerprint") for k, d in docs.items()},
        "anchor_block_fingerprint": (anchor_doc or {}).get("block_fingerprint"),
        "thresholds": {"T_CMA_ABS": T_CMA_ABS, "T_MARGIN": T_MARGIN,
                       "T_SPREAD": T_SPREAD, "T_MR_LO": T_MR_LO,
                       "T_MR_HI": T_MR_HI, "T_SSIM_MARGIN": T_SSIM_MARGIN,
                       "T_RECON_SSIM": T_RECON_SSIM,
                       "VERDICT_ANCHOR_TOL": VERDICT_ANCHOR_TOL,
                       "RESAMPLE_TOL_S": RESAMPLE_TOL_S},
        # WHO MAY NOT PASS, on the artefact. A report read six months from now
        # must be able to say why an arm that met every criterion was not the
        # answer, without re-deriving it from the run's scripts.
        "barred": barred,
        "barred_kinds": barred_kinds,
        "arms_under_test": cal.get("arms_under_test", []),
        "grid_sampled": _grid_summary(root, docs),
        "rows": rows,
        "figure": png,
    }
    rp = os.path.join(root, REPORT_NAME)
    with open(rp, "w") as fh:
        json.dump(out, fh, indent=1)
    print()
    print("  wrote %s" % png)
    print("  wrote %s   (verdict: %s)" % (rp, v["verdict"]))
    return rows, v


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--ceiling", action="store_true",
                    help="DIS vs ground truth on the blocking clip itself")
    ap.add_argument("--score", metavar="ARM_DIR", help="score one arm directory")
    ap.add_argument("--report", action="store_true", help="table + pass rule")
    ap.add_argument("--root", default=GATE, help="root holding the arm dirs")
    ap.add_argument("--control", default=None, metavar="ARM",
                    help="criterion-2 baseline (default: the family's, or the "
                         "run's own gate_controls.json). A value that CONTRADICTS "
                         "a gate_controls.json in --root is a hard error, and a "
                         "control from another family is refused outright.")
    ap.add_argument("--degenerate", default=None, metavar="ARM",
                    help="criterion-5 calibrator (same rules as --control)")
    ap.add_argument("--anchor", default=None, metavar="PATH",
                    help="reconstruction anchor JSON from another root. The anchor "
                         "is a property of the BLOCKING CLIP and the metric, not of "
                         "the model, so one --ceiling serves every run that "
                         "conditioned on the same clip -- and source_consistency "
                         "proves it did.")
    a = ap.parse_args()
    if not (a.ceiling or a.score or a.report):
        ap.print_help()
        return 2
    if a.ceiling:
        mode_ceiling()
    if a.score:
        mode_score(a.score)
    if a.report:
        _, v = mode_report(a.root, a.control, a.degenerate, a.anchor)
        # A NO RESULT must not exit like a completed evaluation: a wrapper (or a
        # tired operator) reads the exit code, and "the gate could not be
        # evaluated" is not "the gate failed".
        #
        # ⚠ ALLOW-LIST, NOT DENY-LIST. This was `== "NO RESULT" -> 3`, so any
        # verdict string that was not that exact word exited 0 -- which is how a
        # root with no arm under test came back as a clean success. Only the two
        # verdicts that are actual conclusions exit 0; everything else, including
        # every state added later, is non-zero by default.
        if v["verdict"] not in ("GREEN", "DECISIVE NEGATIVE"):
            return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
