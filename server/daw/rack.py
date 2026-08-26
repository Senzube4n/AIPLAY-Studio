# -*- coding: utf-8 -*-
"""DAW -- the mixer and effects rack. The CHAIN STAGE of the render graph.

── THE SEAM CONTRACT (binding, shared with the instrument + capture stages) ──
Per-track render = INSTRUMENT STAGE (theirs: notes -> dry track buffer,
float32 stereo (2,N) @48k, P0 conventions) then CHAIN STAGE (this module):
per-track insert chain -> per-track fader/pan -> sends -> return tracks with
their own chains -> master chain -> master fader -> the tanh master stays
last. engine.py routes here when a job carries `mixer`; without one the P0
path runs untouched, byte for byte.
──────────────────────────────────────────────────────────────────────────────

WHAT ARRIVES. A render job as engine.py knows it, plus:

  notes[*].track_id      which dry buffer a note lands in
  mixer: {
    tracks:  { <trackId>: { inserts, fader, pan, sends } },
    returns: [ { id, inserts, fader, pan } ],
    master:  { inserts, fader },
    spq:     [ [t_sec, seconds_per_quarter], ... ]   # the tempo map, for sync
  }

Every automatable value is EITHER a plain number OR the house keyframe shape
{ "keys": [ { t, v, ease? }, ... ] } -- the vfx format, evaluated by the vfx
evaluator itself (server/vfx/interp.py, imported below -- no parallel
format, no parallel maths). Key times arrive in SECONDS: store.js converts
musical positions (float bars) at the render boundary, the same place all
other seconds are born.

DETERMINISM. The chain stage is a pure function of (dry buffers, mixer,
window): no RNG, no wall clock, no state that survives a call. Stateful
devices (filters, delays, reverbs) are stateful only WITHIN a render, and
every render processes from absolute sample 0 to the end of its window, so a
region render is bit-identical to the same window sliced out of a longer
render -- the P0 seam argument, carried through the rack. The cost -- a late
region re-synthesises the track from the top -- is measured and reported,
not hidden. The consequence for the dirty graph (a note through a STATEFUL
chain reaches every later region) lives in server/daw/mixer.js, beside the
hasher that enforces it.

THE SOUND. In-house DSP, numpy/scipy, offline; no GPL anywhere near this
file. Envelope followers run at a 16-sample control rate (0.33 ms @48k) --
sequential by nature, so the loop is short on purpose. Automated insert
params are evaluated per 1024-sample block with filter state carried across
blocks; fader/pan/send levels are evaluated per block and linearly
interpolated per sample (no zipper).

PAN LAW. Equal-power, CENTER-UNITY: pan 0 leaves both channels at gain 1.0
(so a default mixer sounds exactly like the P0 mono path), hard left/right
reaches +3 dB on the surviving channel. Written here once; the catalog
quotes it.

CPU HONESTY. rack_test.py times every device on a 4-bar region (8 s stereo
@48k) and prints the table on every run. Two devices sit above 100 ms and
neither is a mistake -- both were attacked and measured before being left
alone:

  reverb  ~150 ms. 8 combs + 4 allpasses, per channel. The comb IS
          algebraically one IIR -- fold the damping one-pole into the delay
          recursion and you get b=[1,-damp], a=[1,-damp,0...0,-f*(1-damp)]
          -- and that version is numerically identical (4.4e-16) and
          TWENTY-SEVEN TIMES SLOWER (1305 ms vs 48 ms for 8 combs),
          because scipy's lfilter walks a dense order-1760 denominator
          while the block loop below exploits the fact that all but two of
          those coefficients are zero. The block form IS the optimisation.
          The allpasses vectorise along the block axis for a bit-exact 25%
          (26 -> 20 ms), which does not cross the 100 ms line on its own
          and was not worth a second code path.
  limiter ~105 ms, of which ~38 ms is the 4x resample_poly that true-peak
          detection is FOR. Cutting it would cut the accuracy the device
          exists to provide.

Neither threatens the edit-to-audible budget: the full demo chain (EQ +
compressor + gate + reverb send + master EQ/limiter) bounces a 4-bar region
in ~650 ms, inside the 1 s gate, and only a DIRTY region pays it.
"""
import hashlib
import json
import math
import os
import struct
import sys
import time
from bisect import bisect_right

import numpy as np
from scipy.ndimage import maximum_filter1d, minimum_filter1d
from scipy.signal import lfilter, resample_poly

# The vfx keyframe evaluator IS the daw keyframe evaluator -- one format,
# one implementation (interp.py has no dependencies beyond numpy).
_VFX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "vfx")
if _VFX not in sys.path:
    # APPEND, never insert(0): server/vfx has its own engine.py, and putting
    # that directory first makes a sibling's `import engine` resolve to the
    # COMPOSITOR's engine — which has no SYNTHS, so every note render dies
    # with an AttributeError that names the right symbol in the wrong module.
    # This directory must keep priority for its own module names.
    sys.path.append(_VFX)
import interp  # noqa: E402
# The DAWINST SEAM again: every voice comes from the instrument stage, so the
# chain path speaks the whole palette and not just the three builtin synths.
# engine.py's unchained path calls exactly this function with exactly these
# arguments; the two lanes must agree note for note or a mixer setting would
# change the notes themselves.
import instruments as dawinst  # noqa: E402

RACK_VERSION = 1

AUTO_BLOCK = 1024          # automated insert params re-evaluate every ~21 ms
CTRL = 16                  # envelope followers run every 16 samples (~0.33 ms)

# ---------------------------------------------------------------- catalog
#
# The effects.py registration idiom: CATALOG describes every device and
# EVERY parameter -- default, range, unit, whether it can be keyframed, and
# one line on what it is for -- because the routes serve it verbatim and the
# UI/MCP read it instead of guessing. A parameter that is not in the catalog
# does not exist: unknown keys are dropped and known ones clamped before a
# device body ever sees them.
#
# `stateful` is a message to the DIRTY-REGION hasher (mixer.js), not to a
# person: a stateful device carries audio memory, so a note through it can
# reach every later region and the hasher must say so. mixer.js holds the
# mirror of these flags; the e2e compares the two catalogs.


def _num(default, lo, hi, desc, unit=None, animatable=True):
    p = {"type": "number", "default": default, "min": lo, "max": hi,
         "animatable": animatable, "desc": desc}
    if unit:
        p["unit"] = unit
    return p


def _bool(default, desc):
    return {"type": "bool", "default": default, "animatable": False, "desc": desc}


def _enum(default, values, desc):
    return {"type": "enum", "default": default, "values": list(values),
            "animatable": False, "desc": desc}


# Tempo-synced note values, in QUARTER NOTES (the tempo map's unit -- store.js
# pins bpm to the quarter, so a meter change never redefines these).
SYNC_QUARTERS = {
    "1/32": 0.125, "1/16t": 1.0 / 6.0, "1/16": 0.25, "1/16d": 0.375,
    "1/8t": 1.0 / 3.0, "1/8": 0.5, "1/8d": 0.75,
    "1/4t": 2.0 / 3.0, "1/4": 1.0, "1/4d": 1.5,
    "1/2t": 4.0 / 3.0, "1/2": 2.0, "1/2d": 3.0, "1/1": 4.0,
}

CATALOG = {
    "eq": {
        "label": "Parametric EQ",
        "why": "Four bells plus high-pass and low-pass, RBJ-cookbook biquads. "
               "A band at gain 0 costs nothing; defaults are bit-transparent "
               "except the filters you switch on.",
        "stateful": True,
        "params": {
            "hp_on": _bool(False, "Enable the high-pass (12 dB/oct)."),
            "hp_hz": _num(80.0, 10.0, 1000.0, "High-pass corner.", "Hz"),
            "lp_on": _bool(False, "Enable the low-pass (12 dB/oct)."),
            "lp_hz": _num(12000.0, 200.0, 20000.0, "Low-pass corner.", "Hz"),
            "b1_hz": _num(120.0, 20.0, 20000.0, "Band 1 centre.", "Hz"),
            "b1_gain_db": _num(0.0, -18.0, 18.0, "Band 1 gain.", "dB"),
            "b1_q": _num(1.0, 0.1, 12.0, "Band 1 Q (width; higher = narrower)."),
            "b2_hz": _num(500.0, 20.0, 20000.0, "Band 2 centre.", "Hz"),
            "b2_gain_db": _num(0.0, -18.0, 18.0, "Band 2 gain.", "dB"),
            "b2_q": _num(1.0, 0.1, 12.0, "Band 2 Q."),
            "b3_hz": _num(2000.0, 20.0, 20000.0, "Band 3 centre.", "Hz"),
            "b3_gain_db": _num(0.0, -18.0, 18.0, "Band 3 gain.", "dB"),
            "b3_q": _num(1.0, 0.1, 12.0, "Band 3 Q."),
            "b4_hz": _num(6000.0, 20.0, 20000.0, "Band 4 centre.", "Hz"),
            "b4_gain_db": _num(0.0, -18.0, 18.0, "Band 4 gain.", "dB"),
            "b4_q": _num(1.0, 0.1, 12.0, "Band 4 Q."),
        },
    },
    "compressor": {
        "label": "Compressor",
        "why": "Feed-forward, soft knee, dB-domain smoothing (the Giannoulis "
               "design). `sidechain` names ANOTHER TRACK whose DRY "
               "(instrument-stage) signal keys the detector -- dry so no "
               "routing cycle can exist.",
        "stateful": True,
        "params": {
            "threshold_db": _num(-18.0, -60.0, 0.0, "Level where reduction starts.", "dB"),
            "ratio": _num(4.0, 1.0, 20.0, "Slope above the knee (4 = 4:1)."),
            "attack_ms": _num(10.0, 0.1, 200.0, "How fast reduction engages.", "ms"),
            "release_ms": _num(120.0, 5.0, 2000.0, "How fast it lets go.", "ms"),
            "knee_db": _num(6.0, 0.0, 24.0, "Width of the soft knee.", "dB"),
            "makeup_db": _num(0.0, -12.0, 24.0, "Gain after reduction.", "dB"),
            "sidechain": {"type": "track", "default": "", "animatable": False,
                          "desc": "Track id whose dry signal keys the detector; "
                                  "empty = this chain's own input."},
        },
    },
    "limiter": {
        "label": "Limiter",
        "why": "Lookahead brickwall, true-peak aware: detection runs on a 4x "
               "oversampled peak envelope, the gain ramp leads the audio by "
               "the lookahead, and the smoothed gain is provably never above "
               "the instantaneous requirement -- the ceiling holds.",
        "stateful": True,
        "params": {
            "ceiling_db": _num(-1.0, -20.0, 0.0, "Output ceiling (true-peak).", "dBTP"),
            "release_ms": _num(80.0, 1.0, 1000.0, "Recovery speed.", "ms"),
            "lookahead_ms": _num(5.0, 1.0, 10.0, "How far the gain ramp leads.", "ms"),
        },
    },
    "saturator": {
        "label": "Saturator",
        "why": "tanh drive, peak-normalised (x=1 stays 1), so drive adds heat "
               "and loudness without runaway peaks. `tape` folds in a gentle "
               "x*|x| thickening and a high roll-off (darker, denser).",
        "stateful": False,
        "params": {
            "drive_db": _num(8.0, 0.0, 36.0, "Input gain into the curve.", "dB"),
            "character": _enum("tanh", ["tanh", "tape"], "Curve family."),
            "mix": _num(1.0, 0.0, 1.0, "Dry/wet crossfade."),
            "trim_db": _num(0.0, -24.0, 24.0, "Output trim.", "dB"),
        },
    },
    "chorus": {
        "label": "Chorus",
        "why": "One modulated delay per channel, quadrature LFOs -- the "
               "classic two-voice widener. Default mix is audible on "
               "purpose: a chorus at 0 is not a chorus.",
        "stateful": True,
        "params": {
            "rate_hz": _num(0.8, 0.05, 8.0, "LFO speed.", "Hz"),
            "depth_ms": _num(3.5, 0.0, 12.0, "Modulation depth.", "ms"),
            "mix": _num(0.5, 0.0, 1.0, "Dry/wet crossfade."),
            "spread": _num(1.0, 0.0, 1.0, "Stereo LFO phase offset (1 = quadrature)."),
        },
    },
    "delay": {
        "label": "Stereo Delay",
        "why": "Tempo-synced echo: the note value is read against the tempo "
               "map (quarter-note bpm), so echoes land on the grid and a "
               "meter change cannot move them. An echo written at time t "
               "uses the tempo AT t -- after a tempo change, new echoes "
               "space to the new tempo.",
        "stateful": True,
        "params": {
            "sync": _enum("1/8", sorted(SYNC_QUARTERS, key=SYNC_QUARTERS.get),
                          "Delay time as a note value."),
            "feedback": _num(0.35, 0.0, 0.9, "How much of an echo re-echoes."),
            "mix": _num(0.3, 0.0, 1.0, "Dry/wet crossfade."),
            "pingpong": _bool(True, "Echoes alternate left/right."),
            "tone_hz": _num(8000.0, 500.0, 18000.0,
                            "Low-pass in the feedback path (darker repeats).", "Hz"),
        },
    },
    "reverb": {
        "label": "Reverb",
        "why": "Freeverb-class comb+allpass network, reimplemented from the "
               "public-domain topology (8 combs, 4 allpasses, 23-sample "
               "stereo spread). Default mix is audible on purpose.",
        "stateful": True,
        "params": {
            "room_size": _num(0.5, 0.0, 1.0, "Decay length (comb feedback)."),
            "damp": _num(0.5, 0.0, 1.0, "High-frequency decay (darker tail)."),
            "width": _num(1.0, 0.0, 1.0, "Stereo width of the wet signal."),
            "mix": _num(0.3, 0.0, 1.0, "Dry/wet crossfade."),
            "predelay_ms": _num(10.0, 0.0, 100.0, "Gap before the tail starts.", "ms"),
        },
    },
    "gate": {
        "label": "Gate",
        "why": "Downward expander with hold and hysteresis (opens at "
               "threshold, closes 3 dB under it, so a level riding the "
               "threshold cannot chatter).",
        "stateful": True,
        "params": {
            "threshold_db": _num(-50.0, -80.0, 0.0, "Open above this level.", "dB"),
            "range_db": _num(-80.0, -80.0, 0.0, "Gain when closed.", "dB"),
            "attack_ms": _num(1.0, 0.1, 100.0, "Opening speed.", "ms"),
            "hold_ms": _num(50.0, 0.0, 1000.0, "Stay open at least this long.", "ms"),
            "release_ms": _num(150.0, 5.0, 2000.0, "Closing speed.", "ms"),
        },
    },
    "utility": {
        "label": "Utility",
        "why": "Gain, pan (equal-power, centre-unity -- the house pan law), "
               "mid/side width, phase flip, mono fold. Memoryless, "
               "bit-transparent at defaults.",
        "stateful": False,
        "params": {
            "gain_db": _num(0.0, -48.0, 24.0, "Gain.", "dB"),
            "pan": _num(0.0, -1.0, 1.0, "-1 hard left .. +1 hard right."),
            "width": _num(1.0, 0.0, 2.0, "0 mono .. 1 as-is .. 2 wide (M/S)."),
            "phase_invert": _bool(False, "Flip polarity of both channels."),
            "mono": _bool(False, "Fold to mono before width/pan."),
        },
    },
}


def catalog_json():
    """The catalog as the wire sees it, plus the constants a client needs."""
    return {"version": RACK_VERSION, "devices": CATALOG,
            "sync_quarters": SYNC_QUARTERS,
            "pan_law": "equal-power, centre-unity (+3 dB at the edges)",
            "auto_block": AUTO_BLOCK, "ctrl_rate": CTRL}


# ---------------------------------------------------------- param plumbing


def _is_keyed(v):
    return isinstance(v, dict) and isinstance(v.get("keys"), list)


class Params:
    """One insert's parameters: catalog-clamped, keyframe-aware.

    `at(name, t)` is the only read path -- unknown names raise (a device
    asking for a param outside its own catalog entry is a bug, not a
    default), numbers clamp, enums fall back, keys evaluate through the vfx
    evaluator at t seconds.
    """

    def __init__(self, spec, raw, sr):
        self.spec = spec["params"]
        self.raw = raw if isinstance(raw, dict) else {}
        self.sr = sr

    def keyed(self, *names):
        return any(_is_keyed(self.raw.get(n)) for n in (names or self.spec))

    def at(self, name, t=0.0):
        d = self.spec[name]
        v = self.raw.get(name, d["default"])
        if _is_keyed(v):
            v = interp.eval_prop(v, t, default=d["default"])
        if d["type"] == "enum":
            return v if v in d["values"] else d["default"]
        if d["type"] == "bool":
            return bool(v)
        if d["type"] == "track":
            return str(v or "")
        try:
            f = float(v)
        except (TypeError, ValueError):
            return d["default"]
        if not math.isfinite(f):
            return d["default"]
        return min(max(f, d["min"]), d["max"])

    def env(self, name, n, step, sr):
        """The value at every `step`-th sample, as an array of len ceil(n/step).
        Keyed params are evaluated per AUTO_BLOCK and interpolated down to the
        asked-for step, so a control-rate caller costs ~470 evals per 8 s, not
        24 000."""
        m = (n + step - 1) // step
        if not _is_keyed(self.raw.get(name)):
            return np.full(m, self.at(name))
        mb = (n + AUTO_BLOCK - 1) // AUTO_BLOCK + 1
        pts = np.array([self.at(name, float(t))
                        for t in (np.arange(mb) * AUTO_BLOCK) / sr])
        return np.interp(np.arange(m) * step, np.arange(mb) * AUTO_BLOCK, pts)


def value_env(v, default, lo, hi, n, sr):
    """A mixer-level value (fader/pan/send level): scalar, or a PER-SAMPLE
    envelope when keyed -- evaluated per AUTO_BLOCK and linearly interpolated,
    so a fader ride has no zipper."""
    if not _is_keyed(v):
        try:
            f = float(default if v is None else v)
        except (TypeError, ValueError):
            f = default
        if not math.isfinite(f):
            f = default
        return min(max(f, lo), hi)
    m = max(2, (n + AUTO_BLOCK - 1) // AUTO_BLOCK + 1)
    ts = (np.arange(m) * AUTO_BLOCK) / sr
    pts = np.array([min(max(_scalar(interp.eval_prop(v, float(t), default=default),
                                    default), lo), hi) for t in ts])
    return np.interp(np.arange(n), np.arange(m) * AUTO_BLOCK, pts)


def _scalar(v, default):
    if isinstance(v, (list, tuple)):
        v = v[0] if v else default
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if math.isfinite(f) else default


def db_to_lin(v):
    return np.power(10.0, np.asarray(v, dtype=np.float64) / 20.0)


def pan_gains(p):
    """The house pan law: equal-power, centre-unity, +3 dB edges."""
    theta = (np.asarray(p, dtype=np.float64) + 1.0) * (math.pi / 4.0)
    root2 = math.sqrt(2.0)
    return np.cos(theta) * root2, np.sin(theta) * root2


# ------------------------------------------------------------- primitives


def _rbj_peaking(f0, q, gain_db, sr):
    a = 10.0 ** (gain_db / 40.0)
    w0 = 2.0 * math.pi * min(f0, sr * 0.49) / sr
    alpha = math.sin(w0) / (2.0 * max(q, 1e-3))
    cw = math.cos(w0)
    b = [1 + alpha * a, -2 * cw, 1 - alpha * a]
    a_ = [1 + alpha / a, -2 * cw, 1 - alpha / a]
    return np.array(b) / a_[0], np.array(a_) / a_[0]


def _rbj_pass(f0, sr, kind):
    w0 = 2.0 * math.pi * min(max(f0, 1.0), sr * 0.49) / sr
    q = math.sqrt(0.5)
    alpha = math.sin(w0) / (2.0 * q)
    cw = math.cos(w0)
    if kind == "hp":
        b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]
    else:
        b = [(1 - cw) / 2, (1 - cw), (1 - cw) / 2]
    a_ = [1 + alpha, -2 * cw, 1 - alpha]
    return np.array(b) / a_[0], np.array(a_) / a_[0]


def _biquad_auto(x, p, coef_names, coef_fn, sr):
    """Run one biquad over (2,N): single pass when its params are static,
    per-AUTO_BLOCK coefficient updates with state carry when keyed."""
    n = x.shape[1]
    if not p.keyed(*coef_names):
        b, a = coef_fn(0.0)
        return np.vstack([lfilter(b, a, x[0]), lfilter(b, a, x[1])])
    out = np.empty_like(x)
    zi = [np.zeros(2), np.zeros(2)]
    for i0 in range(0, n, AUTO_BLOCK):
        i1 = min(i0 + AUTO_BLOCK, n)
        b, a = coef_fn(i0 / sr)
        for ch in (0, 1):
            out[ch, i0:i1], zi[ch] = lfilter(b, a, x[ch, i0:i1], zi=zi[ch])
    return out


def _envelope_db(det_db, atk_c, rel_c):
    """Sequential attack/release smoothing of a control-rate dB-domain
    REDUCTION signal (positive = reducing). Rises with attack, falls with
    release. The one honest python loop in the file -- control rate keeps
    it ~3 k steps per second of audio."""
    out = np.empty(len(det_db))
    e = 0.0
    for i in range(len(det_db)):
        d = det_db[i]
        c = atk_c[i] if d > e else rel_c[i]
        e = d + (e - d) * c
        out[i] = e
    return out


def _ctrl_pool(x, reduce_fn):
    n = len(x)
    m = (n + CTRL - 1) // CTRL
    pad = np.zeros(m * CTRL)
    pad[:n] = x
    return reduce_fn(pad.reshape(m, CTRL), axis=1)


def _ctrl_up(c, n):
    """Control-rate curve back to per-sample, linear between control points."""
    m = len(c)
    return np.interp(np.arange(n), np.arange(m) * CTRL + CTRL * 0.5, c)


def _coef(ms_env, sr):
    return np.exp(-1.0 / (np.maximum(ms_env, 0.01) * 1e-3 * sr / CTRL))


# ---------------------------------------------------------------- devices
#
# Every device: (x (2,N) float64, p Params, ctx) -> (2,N) float64, input
# never written to. ctx: { "sr", "spq", "dry": {trackId: mono float64} }.


def dev_eq(x, p, ctx):
    sr = ctx["sr"]
    y = x
    if p.at("hp_on"):
        y = _biquad_auto(y, p, ("hp_hz",),
                         lambda t: _rbj_pass(p.at("hp_hz", t), sr, "hp"), sr)
    if p.at("lp_on"):
        y = _biquad_auto(y, p, ("lp_hz",),
                         lambda t: _rbj_pass(p.at("lp_hz", t), sr, "lp"), sr)
    for i in (1, 2, 3, 4):
        g, f, q = f"b{i}_gain_db", f"b{i}_hz", f"b{i}_q"
        if abs(p.at(g)) < 0.01 and not p.keyed(g):
            continue                       # a flat band costs nothing
        y = _biquad_auto(y, p, (g, f, q),
                         lambda t, g=g, f=f, q=q: _rbj_peaking(
                             p.at(f, t), p.at(q, t), p.at(g, t), sr), sr)
    return y


def dev_compressor(x, p, ctx):
    sr = ctx["sr"]
    n = x.shape[1]
    key_id = p.at("sidechain")
    key = ctx["dry"].get(key_id) if key_id else None
    det = np.abs(key[:n]) if key is not None else np.maximum(np.abs(x[0]), np.abs(x[1]))
    if key is not None and len(det) < n:
        det = np.pad(det, (0, n - len(det)))
    det_c = _ctrl_pool(det, np.max)
    m = len(det_c)
    thr = p.env("threshold_db", n, CTRL, sr)[:m]
    ratio = p.env("ratio", n, CTRL, sr)[:m]
    knee = p.env("knee_db", n, CTRL, sr)[:m]
    lev = 20.0 * np.log10(np.maximum(det_c, 1e-10))
    over = lev - thr
    slope = 1.0 - 1.0 / np.maximum(ratio, 1.0)
    half = np.maximum(knee * 0.5, 1e-6)
    # Giannoulis soft knee, vectorised: below / inside / above.
    red = np.where(over <= -half, 0.0,
                   np.where(over >= half,
                            slope * over,
                            slope * (over + half) ** 2 / (4.0 * half)))
    atk_c = _coef(p.env("attack_ms", n, CTRL, sr)[:m], sr)
    rel_c = _coef(p.env("release_ms", n, CTRL, sr)[:m], sr)
    red_s = _envelope_db(red, atk_c, rel_c)
    makeup = p.env("makeup_db", n, CTRL, sr)[:m]
    gain = _ctrl_up(db_to_lin(makeup - red_s), n)
    return x * gain


def dev_gate(x, p, ctx):
    sr = ctx["sr"]
    n = x.shape[1]
    det = np.maximum(np.abs(x[0]), np.abs(x[1]))
    det_c = _ctrl_pool(det, np.max)
    m = len(det_c)
    lev = 20.0 * np.log10(np.maximum(det_c, 1e-10))
    thr = p.env("threshold_db", n, CTRL, sr)[:m]
    rng = p.env("range_db", n, CTRL, sr)[:m]
    atk_c = _coef(p.env("attack_ms", n, CTRL, sr)[:m], sr)
    rel_c = _coef(p.env("release_ms", n, CTRL, sr)[:m], sr)
    hold_steps = np.maximum(p.env("hold_ms", n, CTRL, sr)[:m] * 1e-3 * sr / CTRL, 0.0)
    # Sequential: hysteresis (close 3 dB under the open threshold) + hold.
    red = np.empty(m)
    e = 0.0                              # smoothed reduction, dB (0 = open)
    open_now = False
    hold = 0.0
    for i in range(m):
        if lev[i] > thr[i]:
            open_now = True
            hold = hold_steps[i]
        elif open_now and lev[i] < thr[i] - 3.0:
            if hold > 0.0:
                hold -= 1.0
            else:
                open_now = False
        elif open_now and hold > 0.0:
            hold -= 1.0
        target = 0.0 if open_now else -rng[i]
        c = atk_c[i] if target < e else rel_c[i]   # attack = opening (e falls)
        e = target + (e - target) * c
        red[i] = e
    gain = _ctrl_up(db_to_lin(-np.maximum(red, 0.0)), n)
    return x * gain


def dev_limiter(x, p, ctx):
    sr = ctx["sr"]
    n = x.shape[1]
    ceiling = db_to_lin(p.at("ceiling_db")) * 0.999
    la = max(int(p.at("lookahead_ms") * 1e-3 * sr), 8)
    # True-peak envelope: 4x oversampled |peak|, folded back per sample.
    up = resample_poly(x, 4, 1, axis=1)
    tp = np.max(np.abs(up), axis=0)
    if len(tp) < n * 4:
        tp = np.pad(tp, (0, n * 4 - len(tp)))
    tp = tp[: n * 4].reshape(n, 4).max(axis=1)
    g_inst = np.minimum(1.0, ceiling / np.maximum(tp, 1e-12))
    # Musical release at control rate (never above the target)...
    g_c = _ctrl_pool(g_inst, np.min)
    m = len(g_c)
    rel_c = _coef(p.env("release_ms", n, CTRL, sr)[:m], sr)
    out = np.empty(m)
    e = 1.0
    for i in range(m):
        t = g_c[i]
        if t < e:
            e = t                     # clamp down instantly; the ramp is the lookahead's job
        else:
            e = min(t, 1.0 - (1.0 - e) * rel_c[i])   # rise toward unity, never past target
        out[i] = e
    g_rel = np.minimum(np.interp(np.arange(n), np.arange(m) * CTRL, out), g_inst)
    # ...then the lookahead ramp: centred min-filter + matched smoothing
    # window. smooth[n] is a weighted mean of minima whose windows all
    # contain n, so smooth[n] <= g_inst[n]: the ceiling holds by proof.
    w = 2 * la + 1
    g_min = minimum_filter1d(g_rel, size=w, mode="nearest")
    win = np.hanning(w + 2)[1:-1]
    win /= win.sum()
    g_smooth = np.convolve(np.pad(g_min, la, mode="edge"), win, mode="valid")[:n]
    return x * g_smooth


def dev_saturator(x, p, ctx):
    n = x.shape[1]
    sr = ctx["sr"]
    drive = value_env(p.raw.get("drive_db"), p.spec["drive_db"]["default"],
                      0.0, 36.0, n, sr)
    g = np.power(10.0, drive / 20.0)
    norm = np.tanh(np.maximum(g, 1e-6))
    if p.at("character") == "tape":
        bent = x * g + 0.05 * np.square(x * g) * np.sign(x)
        wet = np.tanh(bent) / norm
        k = math.exp(-2.0 * math.pi * 12000.0 / sr)
        wet = np.vstack([lfilter([1 - k], [1, -k], wet[0]),
                         lfilter([1 - k], [1, -k], wet[1])])
    else:
        wet = np.tanh(x * g) / norm
    mix = value_env(p.raw.get("mix"), 1.0, 0.0, 1.0, n, sr)
    trim = db_to_lin(value_env(p.raw.get("trim_db"), 0.0, -24.0, 24.0, n, sr))
    return (x * (1.0 - mix) + wet * mix) * trim


def dev_chorus(x, p, ctx):
    sr = ctx["sr"]
    n = x.shape[1]
    base_ms = 12.0
    if p.keyed("rate_hz"):
        rb = p.env("rate_hz", n, AUTO_BLOCK, sr)
        rate = np.interp(np.arange(n), np.arange(len(rb)) * AUTO_BLOCK, rb)
        phase = 2.0 * math.pi * np.cumsum(rate) / sr
    else:
        phase = 2.0 * math.pi * p.at("rate_hz") * np.arange(n) / sr
    depth = value_env(p.raw.get("depth_ms"), p.spec["depth_ms"]["default"],
                      0.0, 12.0, n, sr)
    spread = p.at("spread")
    mix = value_env(p.raw.get("mix"), p.spec["mix"]["default"], 0.0, 1.0, n, sr)
    max_d = int((base_ms + 12.0) * 1e-3 * sr) + 4
    idx = np.arange(n, dtype=np.float64)
    out = np.empty_like(x)
    for ch, ph_off in ((0, 0.0), (1, math.pi * 0.5 * spread)):
        d = (base_ms * 0.5 + depth * 0.5 * (1.0 + np.sin(phase + ph_off))) * 1e-3 * sr
        src = np.concatenate([np.zeros(max_d), x[ch]])
        wet = np.interp(idx - d + max_d, np.arange(len(src)), src)
        out[ch] = x[ch] * (1.0 - mix) + wet * mix
    return out


def _spq_at(spq, t):
    ts = [row[0] for row in spq]
    i = max(bisect_right(ts, t) - 1, 0)
    return float(spq[i][1])


def dev_delay(x, p, ctx):
    sr = ctx["sr"]
    n = x.shape[1]
    spq = ctx.get("spq") or [[0.0, 0.5]]
    quarters = SYNC_QUARTERS[p.at("sync")]
    fb_env = p.env("feedback", n, AUTO_BLOCK, sr)
    tone_env = p.env("tone_hz", n, AUTO_BLOCK, sr)
    pingpong = p.at("pingpong")
    wet = np.zeros_like(x)
    zi = [0.0, 0.0]                       # damping one-pole state per line
    block = 256
    i0 = 0
    while i0 < n:
        d = max(int(quarters * _spq_at(spq, i0 / sr) * sr), block + 1)
        i1 = min(i0 + block, n)
        bi = i0 // AUTO_BLOCK
        fb = float(fb_env[min(bi, len(fb_env) - 1)])
        tone = float(tone_env[min(bi, len(tone_env) - 1)])
        k = math.exp(-2.0 * math.pi * tone / sr)
        j0, j1 = i0 - d, i1 - d
        def delayed(row):
            seg = np.zeros(i1 - i0)
            a, b = max(j0, 0), max(j1, 0)
            if b > a:
                seg[a - j0:b - j0] = row[a:b]
            return seg
        if pingpong:
            src_in = 0.5 * (delayed(x[0]) + delayed(x[1]))
            feed_l = src_in + fb * delayed(wet[1])
            feed_r = fb * delayed(wet[0])
        else:
            feed_l = delayed(x[0]) + fb * delayed(wet[0])
            feed_r = delayed(x[1]) + fb * delayed(wet[1])
        for ch, feed in ((0, feed_l), (1, feed_r)):
            y, z = lfilter([1 - k], [1, -k], feed, zi=[zi[ch]])
            zi[ch] = z[0]
            wet[ch, i0:i1] = y
        i0 = i1
    mix = value_env(p.raw.get("mix"), p.spec["mix"]["default"], 0.0, 1.0, n, sr)
    return x * (1.0 - mix) + wet * mix


# Freeverb topology constants (44.1 k tunings, scaled to the job's rate).
_COMBS = (1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617)
_ALLPASSES = (556, 441, 341, 225)
_SPREAD = 23


def _comb(x, d, feedback, damp):
    n = len(x)
    out = np.zeros(n)
    buf = np.zeros(d)
    zi = np.zeros(1)
    b_lp, a_lp = [1.0 - damp], [1.0, -damp]
    for i0 in range(0, n, d):
        i1 = min(i0 + d, n)
        m = i1 - i0
        out[i0:i1] = buf[:m]
        low, zi = lfilter(b_lp, a_lp, out[i0:i1], zi=zi)
        buf[:m] = x[i0:i1] + low * feedback
    return out


def _allpass(x, d):
    n = len(x)
    out = np.zeros(n)
    buf = np.zeros(d)
    for i0 in range(0, n, d):
        i1 = min(i0 + d, n)
        m = i1 - i0
        bufout = buf[:m].copy()
        out[i0:i1] = -x[i0:i1] + bufout
        buf[:m] = x[i0:i1] + bufout * 0.5
    return out


def dev_reverb(x, p, ctx):
    sr = ctx["sr"]
    n = x.shape[1]
    scale = sr / 44100.0
    room = p.at("room_size")
    damp = p.at("damp") * 0.4
    feedback = 0.7 + 0.28 * room
    pre = int(p.at("predelay_ms") * 1e-3 * sr)
    mono_in = 0.5 * (x[0] + x[1]) * 0.015          # freeverb's fixed input gain
    if pre:
        mono_in = np.concatenate([np.zeros(pre), mono_in[: max(n - pre, 0)]])
    wet = np.empty_like(x)
    for ch in (0, 1):
        acc = np.zeros(n)
        off = 0 if ch == 0 else _SPREAD
        for c in _COMBS:
            acc += _comb(mono_in, max(int((c + off) * scale), 8), feedback, damp)
        for a in _ALLPASSES:
            acc = _allpass(acc, max(int((a + off) * scale), 8))
        wet[ch] = acc
    width = p.at("width")
    mid = 0.5 * (wet[0] + wet[1])
    side = 0.5 * (wet[0] - wet[1]) * width
    wet = np.vstack([mid + side, mid - side])
    mix = value_env(p.raw.get("mix"), p.spec["mix"]["default"], 0.0, 1.0, n, sr)
    return x * (1.0 - mix) + wet * mix


def dev_utility(x, p, ctx):
    sr = ctx["sr"]
    n = x.shape[1]
    y = x
    if p.at("mono"):
        m = 0.5 * (y[0] + y[1])
        y = np.vstack([m, m])
    width = value_env(p.raw.get("width"), 1.0, 0.0, 2.0, n, sr)
    if not (np.isscalar(width) and abs(width - 1.0) < 1e-12):
        mid = 0.5 * (y[0] + y[1])
        side = 0.5 * (y[0] - y[1]) * width
        y = np.vstack([mid + side, mid - side])
    pan = value_env(p.raw.get("pan"), 0.0, -1.0, 1.0, n, sr)
    if not (np.isscalar(pan) and pan == 0.0):
        gl, gr = pan_gains(pan)
        y = np.vstack([y[0] * gl, y[1] * gr])
    g = db_to_lin(value_env(p.raw.get("gain_db"), 0.0, -48.0, 24.0, n, sr))
    if p.at("phase_invert"):
        g = -g
    if np.isscalar(g) and g == 1.0 and y is x:
        return x
    return y * g


DEVICES = {
    "eq": dev_eq, "compressor": dev_compressor, "limiter": dev_limiter,
    "saturator": dev_saturator, "chorus": dev_chorus, "delay": dev_delay,
    "reverb": dev_reverb, "gate": dev_gate, "utility": dev_utility,
}

# ------------------------------------------------------------ chain graph


def run_chain(x, inserts, ctx):
    for ins in inserts or []:
        if not isinstance(ins, dict) or ins.get("enabled") is False:
            continue
        fn = DEVICES.get(ins.get("type"))
        if fn is None:
            raise ValueError(
                f"unknown device {ins.get('type')!r} -- this rack speaks {sorted(DEVICES)}")
        p = Params(CATALOG[ins["type"]], ins.get("params"), ctx["sr"])
        x = fn(x, p, ctx)
    return x


def apply_fader_pan(x, fader, pan, sr):
    n = x.shape[1]
    g = db_to_lin(value_env(fader, 0.0, -60.0, 12.0, n, sr))
    p = value_env(pan, 0.0, -1.0, 1.0, n, sr)
    gl, gr = pan_gains(p)
    return np.vstack([x[0] * g * gl, x[1] * g * gr])


def _synth_notes(job, synths, sr, total):
    """The dry buffers: notes -> one mono float64 per track, P0 note maths
    to the letter (clamps, seed, the 0.5 headroom, absolute placement)."""
    dry = {}
    instruments_dir = job.get("instruments_dir")
    for note in job.get("notes") or []:
        inst = note.get("inst")
        tid = str(note.get("track_id") or "")
        if tid not in dry:
            dry[tid] = np.zeros(total)
        midi = int(note["midi"])
        dur = max(1, int(note["dur_samples"]))
        vel127 = min(max(int(note.get("vel", 100)), 1), 127)
        gain = 10.0 ** (float(note.get("gain_db", 0.0)) / 20.0)
        seed = int(note.get("seed", 0)) & 0xFFFFFFFF
        # `synths` is still the builtin table instruments.py itself reaches
        # for; routing through the seam means a sampled patch renders the
        # same whether or not the track carries a single insert.
        y = dawinst.synth_note_mono(
            inst, midi, dur, vel127, sr, seed,
            note.get("params"), instruments_dir) * gain * 0.5
        s0 = int(note["start_sample"])
        a, b = max(s0, 0), min(s0 + len(y), total)
        if b > a:
            dry[tid][a:b] += y[a - s0:b - s0]
    return dry


def chain_graph(job, synths, capture=False):
    """The whole graph, absolute sample 0 to the end of the window:
    dry -> inserts -> fader/pan -> sends -> returns -> master -> tanh.
    Returns (mastered (2, total) float64, buses) where buses holds the
    post-fader per-track / per-return stereo buffers when capture is on."""
    sr = int(job.get("sr") or 48000)
    w0 = int(job["start_sample"])
    n = int(job["n_samples"])
    if n <= 0 or n > sr * 600:
        raise ValueError(f"n_samples out of range: {n}")
    total = w0 + n
    mixer = job.get("mixer") or {}
    dry = _synth_notes(job, synths, sr, total)
    ctx = {"sr": sr, "spq": mixer.get("spq") or [[0.0, 0.5]], "dry": dry}
    tcfg = mixer.get("tracks") or {}
    returns = mixer.get("returns") or []
    master = mixer.get("master") or {}
    ret_in = {str(r.get("id")): np.zeros((2, total)) for r in returns}
    mix = np.zeros((2, total))
    buses = {"tracks": {}, "returns": {}} if capture else None
    for tid in sorted(dry):
        cfg = tcfg.get(tid) or {}
        x = np.vstack([dry[tid], dry[tid]])
        x = run_chain(x, cfg.get("inserts"), ctx)
        pre_tap = x
        x = apply_fader_pan(x, cfg.get("fader", 0.0), cfg.get("pan", 0.0), sr)
        for s in cfg.get("sends") or []:
            to = str(s.get("to"))
            if to not in ret_in:
                continue                  # a send to a deleted return is silence
            lvl = db_to_lin(value_env(s.get("level", 0.0), 0.0, -60.0, 12.0, total, sr))
            ret_in[to] += (pre_tap if s.get("pre") else x) * lvl
        mix += x
        if capture:
            buses["tracks"][tid] = x
    for r in returns:
        rid = str(r.get("id"))
        y = run_chain(ret_in[rid], r.get("inserts"), ctx)
        y = apply_fader_pan(y, r.get("fader", 0.0), r.get("pan", 0.0), sr)
        mix += y
        if capture:
            buses["returns"][rid] = y
    mix = run_chain(mix, master.get("inserts"), ctx)
    g = db_to_lin(value_env(master.get("fader", 0.0), 0.0, -60.0, 12.0, total, sr))
    mix = mix * g
    # THE TANH MASTER STAYS LAST -- the P0 master curve, per channel,
    # memoryless, exactly as the mono path applies it.
    mastered = np.tanh(0.7 * mix)
    return mastered, buses


# ---------------------------------------------------------------- wav i/o


def write_wav_f32_stereo(path, y, sr):
    """RIFF float32 STEREO writer -- (2, N) in, interleaved on disk."""
    inter = np.empty(y.shape[1] * 2, dtype="<f4")
    inter[0::2] = y[0]
    inter[1::2] = y[1]
    data = inter.tobytes()
    with open(path, "wb") as f:
        f.write(b"RIFF")
        f.write(struct.pack("<I", 36 + len(data)))
        f.write(b"WAVEfmt ")
        f.write(struct.pack("<IHHIIHH", 16, 3, 2, sr, sr * 8, 8, 32))
        f.write(b"data")
        f.write(struct.pack("<I", len(data)))
        f.write(data)


# ------------------------------------------------------------ entry points


def render_with_chain(job, synths, tails):
    """engine.py's chain-stage dispatch target: one absolute sample window
    through the full graph, to a float32 STEREO wav."""
    t_start = time.perf_counter()
    sr = int(job.get("sr") or 48000)
    w0 = int(job["start_sample"])
    n = int(job["n_samples"])
    mastered, _ = chain_graph(job, synths)
    win = mastered[:, w0:w0 + n].astype(np.float32)
    out_path = job.get("out")
    if out_path:
        write_wav_f32_stereo(out_path, win, sr)
    inter = np.empty(n * 2, dtype="<f4")
    inter[0::2] = win[0]
    inter[1::2] = win[1]
    sha = hashlib.sha1(inter.tobytes()).hexdigest()
    peak = float(np.max(np.abs(win))) if n else 0.0
    return {"ok": True, "sr": sr, "n_samples": n, "channels": 2,
            "peak": round(peak, 6), "sha1": sha,
            "notes": len(job.get("notes") or []), "chained": True,
            "ms": round((time.perf_counter() - t_start) * 1000, 1)}


# ---------------------------------------------------------------- meters
#
# BS.1770-4 K-weighting at 48 kHz -- the spec's own coefficient table
# (stage 1 high shelf, stage 2 high-pass). rack_test.py pins the response
# shape (unity at 1 kHz, +4 dB at 10 kHz, strong cut at 30 Hz) so a typo
# here fails arithmetic, not ears. pyloudnorm (MIT) was NOT vendored: it is
# absent from the rig venv and installing into the shared ComfyUI venv is a
# prod side effect this module must not have. The maths below is the
# standard's, in full.

_K1_B = (1.53512485958697, -2.69169618940638, 1.19839281085285)
_K1_A = (1.0, -1.69065929318241, 0.73248077421585)
_K2_B = (1.0, -2.0, 1.0)
_K2_A = (1.0, -1.99004745483398, 0.99007225036621)


def k_weight(x, sr):
    if sr != 48000:
        raise ValueError("the K-weighting table is pinned at 48 kHz, the project rate")
    y = np.empty_like(x)
    for ch in range(x.shape[0]):
        y[ch] = lfilter(_K2_B, _K2_A, lfilter(_K1_B, _K1_A, x[ch]))
    return y


def _block_loudness(kw, sr, win_s, hop_s):
    win = int(win_s * sr)
    hop = int(hop_s * sr)
    n = kw.shape[1]
    out = []
    for i0 in range(0, max(n - win, 0) + 1, hop):
        z = float(np.mean(np.sum(np.square(kw[:, i0:i0 + win]), axis=0)))
        out.append((i0 / sr, -0.691 + 10.0 * math.log10(max(z, 1e-12))))
    if not out and n:
        z = float(np.mean(np.sum(np.square(kw), axis=0)))
        out.append((0.0, -0.691 + 10.0 * math.log10(max(z, 1e-12))))
    return out


def lufs_integrated(x, sr):
    """BS.1770-4 gated integrated loudness: 400 ms blocks, 75% overlap,
    -70 LUFS absolute gate then a -10 LU relative gate."""
    kw = k_weight(np.asarray(x, dtype=np.float64), sr)
    blocks = _block_loudness(kw, sr, 0.4, 0.1)
    if not blocks:
        return float("-inf")
    zs = np.array([10.0 ** ((l + 0.691) / 10.0) for _, l in blocks])
    ls = np.array([l for _, l in blocks])
    keep = ls > -70.0
    if not keep.any():
        return float("-inf")
    rel = -0.691 + 10.0 * math.log10(float(np.mean(zs[keep]))) - 10.0
    keep &= ls > rel
    if not keep.any():
        return float("-inf")
    return -0.691 + 10.0 * math.log10(float(np.mean(zs[keep])))


def lufs_short_term(x, sr):
    """Short-term (3 s window, 1 s hop) series: [[t, LUFS-S], ...]."""
    kw = k_weight(np.asarray(x, dtype=np.float64), sr)
    return [[round(t, 3), round(l, 2)] for t, l in _block_loudness(kw, sr, 3.0, 1.0)]


def true_peak_db(x):
    up = resample_poly(np.asarray(x, dtype=np.float64), 4, 1, axis=1)
    p = float(np.max(np.abs(up))) if up.size else 0.0
    return 20.0 * math.log10(max(p, 1e-12))


def _bus_meters(x, sr, with_tp=False):
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    rms = float(np.sqrt(np.mean(np.square(x)))) if x.size else 0.0
    row = {
        "peak_db": round(20.0 * math.log10(max(peak, 1e-12)), 2),
        "rms_db": round(20.0 * math.log10(max(rms, 1e-12)), 2),
        "lufs": (lambda v: round(v, 2) if math.isfinite(v) else None)(lufs_integrated(x, sr)),
    }
    if with_tp:
        row["true_peak_db"] = round(true_peak_db(x), 2)
        row["lufs_short"] = lufs_short_term(x, sr)
    return row


def meters(job, synths):
    """Offline metering for a window: the same graph as the render, buses
    captured, levels per track / return / master over [start, start+n)."""
    t_start = time.perf_counter()
    sr = int(job.get("sr") or 48000)
    w0 = int(job["start_sample"])
    n = int(job["n_samples"])
    mastered, buses = chain_graph(job, synths, capture=True)
    sl = slice(w0, w0 + n)
    out = {
        "ok": True, "sr": sr, "start_sample": w0, "n_samples": n,
        "master": _bus_meters(mastered[:, sl], sr, with_tp=True),
        "tracks": {tid: _bus_meters(b[:, sl], sr) for tid, b in buses["tracks"].items()},
        "returns": {rid: _bus_meters(b[:, sl], sr) for rid, b in buses["returns"].items()},
        "ms": round((time.perf_counter() - t_start) * 1000, 1),
    }
    return out


def rack_probe(job):
    return {"ok": True, **catalog_json()}
