# -*- coding: utf-8 -*-
"""DAW — the big-room synths. The four voices "Animals" is made of, as circuits.

┌─ WHY THIS MODULE EXISTS ───────────────────────────────────────────────────┐
│ The owner asked the DAW for a banger — Martin Garrix's "Animals",          │
│ instrumentally — and got nothing like it. The mix engine was never the     │
│ problem: BS.1770 loudness, a true-peak limiter and a sidechain compressor  │
│ that keys off another track's dry signal are all in rack.py, so the        │
│ pumping that defines the genre is one insert away. The PALETTE was the     │
│ problem. Thirty-five patches, and every synth among them was a Karplus-    │
│ Strong pluck and two saws through a one-pole. Big-room house is made of    │
│ four voice TYPES the palette did not have: a unison-saw pluck whose        │
│ "pluck" is a resonant filter closing, a sub that is a sine and nothing     │
│ else, a noise riser whose filter opens over the length of its own note,    │
│ and a sub-drop for the downbeat. This file is those four.                  │
│                                                                            │
│ It is drums.py's shape exactly: a MACHINES table, knobs declared in        │
│ patches.json (the ONE table) and read back through resolve_params, and a   │
│ voice() that returns float64 stereo, UNGATED. instruments.py routes every  │
│ machine module through the same door — note cache, _gate2, declared tail — │
│ so a lead note and a hi-hat leave the instrument stage by the same seam.   │
└────────────────────────────────────────────────────────────────────────────┘

WHAT IS MODELLED (and what is honestly approximated)

  bigroom_lead  The Animals pluck. Up to seven PolyBLEP saws (band-limited by
          construction — a naive saw at 48 kHz folds its upper harmonics back
          as inharmonic grit, which a resonant filter then amplifies) spread
          by a detune knob in cents and panned by a stereo-spread knob, summed
          into a 4-pole resonant lowpass (two RBJ biquads, the first carrying
          the resonance) whose cutoff has its OWN fast envelope: rises to
          cutoff x 2^filter_amount at the strike and falls back to cutoff with
          the filter_decay time constant. THAT closing is the pluck; the amp
          envelope underneath is an ordinary AD-S-R with a short decay. An
          optional pitch snap (semitones above, settling in ~10 ms) and an
          output-stage drive. Polyphony is the seam's business: this renders
          ONE note, the note cache replays it, engine sums the track.
          HONEST GAP: the filter is re-coefficiented every 64 samples (1.3
          ms) with state carried across, not a per-sample zero-delay model.
          At the default resonance the steps are inaudible and finite at
          every knob extreme (instruments_test proves the latter).
          THE LAYER (2026-09-03): a second unison stack `layer_octave`
          octaves up, mirror-panned (the voice the main stack puts left,
          the layer puts right) and mixed in by `layer_level` BEFORE the
          filter, so the pluck closes on both. layer_level 0 is the old
          voice to the byte -- the code path is skipped, not multiplied by
          zero. The genre's "bright layer" is inside the voice now; the
          owner heard the lead as "extremely basic" without it.

  sub_bass  A sine at the MIDI pitch with a sub-octave sine blended in by a
          knob, a linear attack, an exponential release, mild saturation
          and a lowpass after the saturation so the drive's harmonics stay
          where a phone speaker reconstructs the sub from and out of the
          lead's band. Honours note LENGTH like tr808_bass. drive 0 is a
          mathematically pure sine.
          THE MID LAYER (2026-09-03): `mid_layer` adds a band-limited saw an
          octave above the note, saturated (a fixed in-voice amount) and
          low-passed at `mid_cutoff`, added AFTER the sub's own lowpass so
          its cutoff is its own. That is the 100-300 Hz body the owner
          asked for as "heavier"; "longer" is `release`, now up to 1.5 s
          (the declared tail grew 0.5 -> 1.6 s to hold it; a note at the
          old default is silent past the old tail, so no existing render
          moves). mid_layer 0 skips the code path: the old voice, byte for
          byte.

  riser   White noise (a fixed seed, so it repeats) high-passed at 120 Hz to
          stay out of the kick's way, plus a PolyBLEP saw under it that rises
          tone_rise semitones over the note; both through a resonant lowpass
          that opens from cutoff_start to cutoff_end across the note's OWN
          duration — a long note IS the sweep length — along a log-frequency
          path bent by `curve`. `swell` rides the level up alongside. Falls
          off in `release` ms after note-off, so a beat of silence before the
          drop is a beat of silence.

  impact  The sub-drop: a sine that glides DOWN from start_hz to end_hz into
          the subs and decays, a band-passed noise burst plus a click on the
          transient, and a drive. Key-tracks from GM key 36 so it can land on
          the song's root. It is a HIT — it ignores note length — and its
          declared 2.6 s tail is the voice's real length (2.4 s cap, cosine
          faded), not a guess.

  big-room kick  NOT here, on purpose. hybrid_kick already has tune, decay,
          snap, pitch_amount, punch and drive; the values that make it a
          big-room kick were MEASURED (below) and recorded as the `bigroom`
          preset on its patches.json row. Nothing applies a preset for you —
          the arranger sends those values through set_track params, and
          daw_patches shows them beside the knobs so it can.

DETERMINISM — a synth repeats EXACTLY, and that is the instrument.
  Nothing here reads the per-note seed: unison phases are fixed constants
  (a golden-ratio spread, so no two voices start aligned), the riser's and
  impact's noise beds come from drums.py's fixed-seed table, and every
  voice is float64 numpy. The same (patch, note, velocity, params) is the
  same bytes in every process — which is what lets the note cache replay a
  16th-note lead 512 times for the cost of one render, and what makes a
  drop's second half byte-identical to its first if the notes are.

MEASURED, on this box, at default knobs, velocity 110 (instruments_test.py
re-measures every one of these per commit rather than trusting the comment):

  bigroom_lead  a 1/16th at 128 BPM (117 ms), F4:
                spectral centroid  first 100 ms 2303 Hz -> last 100 ms of the
                voice 636 Hz (3.6x); inside the note, first 25 ms 3273 Hz ->
                last 25 ms 870 Hz. The level at note-off is still most of the
                attack's: the filter CLOSES, the amp does not -- the pluck is
                the filter.
                L/R correlation 0.70 at spread 0.8 (1.000 at 0 -- the two
                channels are the same bytes -- and 0.34 at 1).
                the oscillator tracks MIDI to +-0.00 cents over F2-F6 with
                one voice and the filter open; the seven-voice default reads
                within its own +-18 cent detune cluster, because a spectral
                peak picker lands on ONE voice of a unison, not its centre.
                snap 12 starts 1.35x above the note (first 21 ms) and is on
                pitch by 40 ms. Peak 0.58 at velocity 127: the safety ceiling
                (0.95) never engages at defaults; drive 0 -> 1 takes the
                crest factor down and the peak 0.63 -> 0.46, no level jump.
  sub_bass      tracks MIDI to +-0.02 cents over 32.7-130.8 Hz; drive 0 with
                sub_mix 0 measures 0.012% harmonics (a sine, on a
                subwoofer), drive 1 48%; a 2 s note sounds 2.07 s against a
                0.25 s note's 0.31 s.
  riser         over a 2-bar note at 128 BPM the centroid rises 197 Hz ->
                6844 Hz (35x); 100 ms after note-off it is > 60 dB down; the
                noise bed is one fixed table, sliced, so a short note is the
                same bytes before and after a 15 s note has grown it.
  impact        pitch 141 Hz at the strike -> 40 Hz by 800 ms (3.5x down, on
                its way to 33); T60 1.84 s inside a 1.95 s voice; burst 0 ->
                1 lifts 2-16 kHz over the first 30 ms by 2013x and moves the
                20-80 Hz body by -0.01 dB: a separable layer.
  hybrid_kick   the `bigroom` preset {decay 0.06, snap 0.20, pitch_amount
                0.60, punch 1.0, drive 0.10}: T60 0.50 s against the
                defaults' 1.00 s (one beat at 128 is 0.47 s, so the tail
                clears before the next kick), T30 0.27 s; transient peak /
                body RMS 2.2 against 1.5; the 2-16 kHz transient +9.7 dB
                relative to the 30-90 Hz sub against the defaults; f0 still
                48.1 Hz. The drive knob is what flattens a kick's transient
                (drive 0 measures 4.6, drive 0.3 measures 1.7), so the preset
                keeps it low and lets punch do the work.

  No voice exceeds full scale at velocity 127 at any knob extreme; the one
  case the lead's ceiling engages at all is drive 0 at F6 with seven raw saws.
"""
import hashlib
import math
import os

import numpy as np
from scipy.signal import sosfilt

import drums
from drums import (_t, _filt, _noise, _drive, _norm, _fade_tail,   # noqa: F401
                   _midi_hz, _semis, _sweep_sine, _gate, _ceiling)

HERE = os.path.dirname(os.path.abspath(__file__))

_code_fp = None


def code_fingerprint():
    """sha1 of THIS FILE plus drums.py's fingerprint. instruments.py's note
    cache keys on it, the same lesson drums.py learned the hard way: a
    synthesised patch has no bytes on disk to notice an edit. The primitives
    (noise table, drive law, filters) are borrowed from drums.py, so an edit
    THERE has to invalidate a lead note too — hence the second half."""
    global _code_fp
    if _code_fp is None:
        with open(os.path.abspath(__file__), "rb") as fh:
            h = hashlib.sha1(fh.read())
        h.update(drums.code_fingerprint().encode())
        _code_fp = h.hexdigest()[:16]
    return _code_fp


# ───────────────────────────────────────────────────────────── primitives

def _blep_saw(freq, n, sr, phase0=0.0):
    """A band-limited sawtooth, `n` samples, from a frequency that may be a
    scalar or a PER-SAMPLE array (so it can ride a pitch snap or a riser's
    glide). PolyBLEP: the naive saw 2p-1 with the discontinuity smoothed by
    a two-sample polynomial. Aliasing lands ~60 dB down instead of the naive
    saw's -37 dB at the 70th harmonic of an F4 — which matters because a
    resonant filter after it would pick those folded partials out and make
    them ring. (`n` is explicit because a scalar frequency's cumsum is ONE
    sample, and one sample broadcast over a note is DC: the first
    measurement pass read a 52 Hz centroid off exactly that.)"""
    dt = np.broadcast_to(np.asarray(freq, dtype=np.float64) / sr, (int(n),)).copy()
    ph = (np.cumsum(dt) - dt + phase0) % 1.0        # phase at each sample's start
    y = 2.0 * ph - 1.0
    lo = ph < dt
    if np.any(lo):
        tt = ph[lo] / dt[lo]
        y[lo] -= tt + tt - tt * tt - 1.0
    hi = ph > 1.0 - dt
    if np.any(hi):
        tt = (ph[hi] - 1.0) / dt[hi]
        y[hi] -= tt * tt + tt + tt + 1.0
    return y


def _rbj_lp(fc, q, sr):
    """RBJ lowpass biquad sections for an ARRAY of cutoffs → (k, 6) sos rows,
    normalised so a0 == 1. Clamped to [20 Hz, 0.45 sr]: a cutoff at Nyquist
    is a filter that does nothing, and one at 0 Hz is a divide by zero."""
    fc = np.clip(np.asarray(fc, dtype=np.float64), 20.0, 0.45 * sr)
    w0 = 2.0 * np.pi * fc / sr
    cw, sw = np.cos(w0), np.sin(w0)
    alpha = sw / (2.0 * q)
    a0 = 1.0 + alpha
    b1 = (1.0 - cw) / a0
    b0 = b1 * 0.5
    return np.stack([b0, b1, b0, np.ones_like(b0), -2.0 * cw / a0, (1.0 - alpha) / a0], axis=1)


_LP_BLOCK = 64


def _lp_sweep(x, cutoff, q, sr, poles=4):
    """A resonant lowpass whose cutoff MOVES: `cutoff` is a per-sample array.
    Two cascaded RBJ biquads (24 dB/oct) — the first carries the resonance,
    the second is Butterworth (Q 0.707) so the sum has one peak, not two —
    re-coefficiented every 64 samples with the filter state carried across
    blocks. That is 1.3 ms at 48 kHz; the pluck's cutoff moves a few percent
    per block at the default decay and the steps do not read. The honest
    alternative is a per-sample zero-delay SVF, which is a 30k-iteration
    Python loop per note; this is ~500 sosfilt calls."""
    n = len(x)
    if n == 0:
        return x
    nb = (n + _LP_BLOCK - 1) // _LP_BLOCK
    # the cutoff for a block is its MEAN, not its first sample: a fast decay
    # sampled at block starts would sit a half-block early on every step.
    pad = nb * _LP_BLOCK - n
    fc = np.pad(np.asarray(cutoff, dtype=np.float64), (0, pad), mode="edge")
    fc = fc.reshape(nb, _LP_BLOCK).mean(axis=1)
    sos_a = _rbj_lp(fc, q, sr)
    sections = [sos_a]
    if poles >= 4:
        sections.append(_rbj_lp(fc, 1.0 / math.sqrt(2.0), sr))
    sos_all = np.stack(sections, axis=1)              # (nb, sections, 6)
    y = np.empty(n)
    zi = np.zeros((len(sections), 2))
    for k in range(nb):
        s = k * _LP_BLOCK
        e = min(n, s + _LP_BLOCK)
        y[s:e], zi = sosfilt(sos_all[k], x[s:e], zi=zi)
    return y


def _release(env, dur, n, sr, to60_s):
    """Exponential fall after note-off, sized by its time to -60 dB (so the
    knob's ms is the time the note is GONE, not a time constant somebody
    has to multiply by seven)."""
    if n > dur:
        tau = max(float(to60_s), 0.001) / 6.9078
        env[dur:] *= np.exp(-_t(n - dur, sr) / tau)
    return env


def _soft(y, amount):
    """Output-stage saturation for a SUSTAINED voice: tanh anchored so that a
    0.5 input stays 0.5 whatever the knob -- small signals come UP (about
    +8 dB at 1), peaks fold toward 0.5, harmonics grow. drums._drive is the
    other law: tanh normalised to tanh(g), so a kick's full-scale peak stays
    full-scale. On a synth that is a brick wall (at 0.25 it measured every
    lead note at exactly 0.95 whatever the oscillator gain was), and a plain
    unity-gain tanh(ky)/k is the opposite failure (peak 0.63 -> 0.18 across
    the knob). impact keeps _drive; it is a hit. amount=0 is EXACTLY the
    identity."""
    if amount <= 0.0:
        return y
    k = 1.0 + 4.0 * float(amount)
    return np.tanh(y * k) * (0.5 / math.tanh(0.5 * k))


# _ceiling (a safety ceiling, NOT a normaliser: touches nothing under 0.95)
# lives in drums.py now, because the layered clap needs it too. A resonant
# filter at Q 8 can push a partial that lands on its peak past full scale,
# and the seam's promise is that no voice clips at velocity 127 at any knob
# extreme. At default knobs the lead measures 0.58 and it never runs.


# the mid layer's trim. 0.5 is where mid_layer 1 at velocity 127 SUMS to the
# ceiling (raw peak 0.946 against 0.95) -- the sub's own peak (0.685 raw)
# leaves that much room and no more, and the layer's crest is already 1.33,
# so "1 = the sub's RMS" is not available additively: 1 is 0.42 of it
# (-7.5 dB). 1.2 was tried: the ceiling ran from mid_layer 0.5 up and pulled
# the SUB down with it, which is a blend knob wearing a level knob's name.
MID_TRIM = 0.5


# golden-ratio phase spread for the unison: no two voices start aligned,
# no voice starts at the discontinuity, and it is a CONSTANT — the seam's
# determinism rule says a synth never reads the per-note seed.
_UNISON_PHASE = tuple(((i + 1) * 0.6180339887498949) % 1.0 for i in range(7))


# ═══════════════════════════════════════════════════════════════ the voices

def _lead(P, sr, v, midi, dur):
    """bigroom_lead — see the module header for the design. Returns STEREO:
    the unison voices are panned individually, so the width is in the
    oscillators, not a widener after the fact."""
    f0 = _midi_hz(midi)
    rel = float(P["release"]) / 1000.0
    n = dur + int(sr * min(0.5, rel + 0.02))
    t = _t(n, sr)
    nv = int(round(P["voices"]))
    det = float(P["detune"])
    spread = float(P["spread"])
    snap = float(P["snap"])
    # pitch snap: `snap` semitones above at the strike, 95% settled by 30 ms
    fmul = 2.0 ** (snap * np.exp(-t / 0.010) / 12.0) if snap > 0 else 1.0
    offs = np.linspace(-1.0, 1.0, nv) if nv > 1 else np.zeros(1)
    L = np.zeros(n)
    R = np.zeros(n)
    for i, o in enumerate(offs):
        f = f0 * (2.0 ** (o * det / 1200.0)) * fmul
        y = _blep_saw(f, n, sr, _UNISON_PHASE[i])
        pan = o * spread
        L += y * math.sqrt(0.5 * (1.0 - pan))
        R += y * math.sqrt(0.5 * (1.0 + pan))
    # THE LAYER: the same stack `layer_octave` up, mirror-panned, at
    # `layer_level` -- into the same filter, so the pluck closes on it too.
    # Level is ADDITIVE (1 = as loud as the main stack); the ceiling below
    # is what catches the sum at the knob's extreme, never at a modest one.
    lay = float(P["layer_level"])
    if lay > 0.0:
        f1 = f0 * (2.0 ** float(P["layer_octave"]))
        for i, o in enumerate(offs):
            f = f1 * (2.0 ** (o * det / 1200.0)) * fmul
            y = _blep_saw(f, n, sr, _UNISON_PHASE[6 - i]) * lay
            pan = -o * spread
            L += y * math.sqrt(0.5 * (1.0 - pan))
            R += y * math.sqrt(0.5 * (1.0 + pan))
    # unison sum: equal-power pan puts sqrt(2) in the sum, 1/sqrt(nv) undoes
    # the uncorrelated growth, 0.42 leaves headroom for the filter's peak
    g = 0.42 * math.sqrt(2.0) / math.sqrt(nv)
    L *= g
    R *= g
    # THE PLUCK: the filter's own envelope. Velocity opens it a little.
    floor = float(P["cutoff"])
    peak = min(floor * 2.0 ** (float(P["filter_amount"]) * (0.75 + 0.25 * v)), 0.45 * sr)
    fenv = np.exp(-t / (float(P["filter_decay"]) / 1000.0))
    atk = max(2, int(0.0015 * sr))
    fenv[:atk] *= np.linspace(0.0, 1.0, atk)
    cutoff = floor + (peak - floor) * fenv
    q = 0.5 + 7.5 * float(P["resonance"])
    L = _lp_sweep(L, cutoff, q, sr)
    R = _lp_sweep(R, cutoff, q, sr)
    # the amp: 1.5 ms attack, decay to `sustain`, hold to note-off, release
    sus = float(P["sustain"])
    env = sus + (1.0 - sus) * np.exp(-t / (float(P["amp_decay"]) / 1000.0))
    env[:atk] *= np.linspace(0.0, 1.0, atk)
    env = _release(env, dur, n, sr, rel)
    drive = float(P["drive"])
    L = _soft(L * env, drive)
    R = _soft(R * env, drive)
    st = np.vstack([L, R])
    return _ceiling(st)


def _sub(P, sr, v, midi, dur):
    """sub_bass — a sine, a sub-octave sine, an envelope, a drive, a lowpass,
    and (off by default) a saturated, low-passed saw an octave up."""
    f0 = _midi_hz(midi) * _semis(P["tune"])
    rel = float(P["release"]) / 1000.0
    # 1.55 s: the release's -60 dB point at its 1.5 s maximum, inside the
    # declared 1.6 s tail. At the 80 ms default this is the same 0.1 s the
    # old 0.5 s cap gave, so the old buffer is the old bytes.
    n = dur + int(sr * min(1.55, rel + 0.02))
    t = _t(n, sr)
    mix = float(P["sub_mix"])
    y = (np.sin(2.0 * np.pi * f0 * t) + mix * np.sin(np.pi * f0 * t)) / (1.0 + mix)
    env = np.ones(n)
    atk = max(2, int(float(P["attack"]) / 1000.0 * sr))
    env[:min(atk, n)] = np.linspace(0.0, 1.0, min(atk, n))
    env = _release(env, dur, n, sr, rel)
    y = _soft(y * env, float(P["drive"]))
    y = _filt(y, "lp", float(P["lp_hz"]), sr, 2)
    # THE MID LAYER: a band-limited saw an octave above the note, through a
    # fixed in-voice saturation (0.6 on _soft's law: small signals up, peaks
    # folded) and its OWN lowpass, added after the sub's so `lp_hz` cannot
    # take it away. MID_TRIM lands mid_layer 1 exactly under the ceiling at
    # velocity 127; the ceiling is a safety that measured as never running.
    mid = float(P["mid_layer"])
    if mid > 0.0:
        saw = _blep_saw(f0 * 2.0, n, sr, _UNISON_PHASE[3])
        saw = _soft(saw * env, 0.6)
        saw = _filt(saw, "lp", float(P["mid_cutoff"]), sr, 2)
        y = _ceiling(y + saw * (mid * MID_TRIM))
    return y * 0.90


def _riser(P, sr, v, midi, dur):
    """riser — the note's own length is the sweep. Everything below is a
    function of u = t / dur, clipped to 1 after note-off."""
    rel = float(P["release"]) / 1000.0
    n = dur + int(sr * min(0.3, rel + 0.02))
    t = _t(n, sr)
    u = np.clip(t / (dur / sr), 0.0, 1.0)
    f0 = _midi_hz(midi)
    tone = _blep_saw(f0 * 2.0 ** (float(P["tone_rise"]) * u / 12.0), n, sr, _UNISON_PHASE[0])
    noise = _filt(_noise(n, sr, 7770), "hp", 120.0, sr, 2)
    mix = float(P["noise_mix"])
    x = (1.0 - mix) * tone * 0.8 + mix * noise
    c0 = float(P["cutoff_start"])
    c1 = float(P["cutoff_end"])
    cutoff = c0 * (c1 / c0) ** (u ** float(P["curve"]))
    y = _lp_sweep(x, cutoff, 0.5 + 5.5 * float(P["resonance"]), sr)
    swell = float(P["swell"])
    env = (1.0 - swell) + swell * u
    env = _release(env, dur, n, sr, rel)
    return _ceiling(y * env * 0.6)     # 0.9 measured 0.95 at vel 127: the ceiling was working


def _impact(P, sr, v, midi):
    """impact — a sub-drop. A HIT: ignores note length, like a kit voice."""
    kt = 2.0 ** ((int(midi) - 36) / 12.0)
    f_end = float(P["end_hz"]) * kt
    f_start = max(float(P["start_hz"]) * kt, f_end * 1.05)
    tau = 0.10 + 0.30 * float(P["decay"])          # T60 0.7 s .. 2.8 s
    n = int(sr * min(2.4, 0.20 + tau * 7.0))        # ..capped at the 2.4 s voice
    t = _t(n, sr)
    ph = _sweep_sine(f_start, f_end, n, sr, 0.06 + 0.5 * float(P["sweep"]))
    y = np.sin(ph) * np.exp(-t / tau)
    burst = float(P["burst"]) * (0.5 + 0.5 * v)
    if burst > 0:
        nz = _norm(_filt(_noise(n, sr, 9099), "bp", (300.0, 9000.0), sr, 2) * np.exp(-t / 0.040))
        click = _norm(_filt(np.exp(-t / 0.0005), "hp", 1500.0, sr, 2))
        y = y + (nz * 0.7 + click * 0.3) * burst
    # 0.64: with drive 0 the burst rides on top of the sine and the raw sum
    # peaks at 1.34 -- 0.88 measured 1.18 at velocity 127, over full scale
    return _fade_tail(_drive(y, float(P["drive"])) * 0.64)


# ═══════════════════════════════════════════════════════════ the machines

MACHINES = {
    "bigroom_lead": {"pitched": True, "hit": False, "tail": 0.5},
    "sub_bass": {"pitched": True, "hit": False, "tail": 1.6},
    "riser": {"pitched": True, "hit": False, "tail": 0.3},
    "impact": {"pitched": True, "hit": True, "tail": 2.6},
}


def is_machine(name):
    return name in MACHINES


def machine_names():
    return sorted(MACHINES)


def declared_params(name):
    """The knob table for one synth, straight out of patches.json — the same
    reader drums.py uses, so there is exactly one way to read the ONE table."""
    return drums.declared_params(name)


def defaults(name):
    return drums.defaults(name)


def resolve_params(name, params):
    """Declared defaults, overlaid, clamped; undeclared keys ignored. Delegated
    to drums.resolve_params so the rule cannot drift between the two modules."""
    return drums.resolve_params(name, params)


def presets(name):
    """Named knob settings a row may carry under `presets` — pure data, and
    nothing here applies one: the caller sends the values as params."""
    row = drums._manifest()["patches"].get(name) or {}
    return dict(row.get("presets") or {})


def voice(name, midi, dur_samples, vel127, sr, params=None):
    """One synth note → float64 stereo (2, n), UNGATED. instruments.py pins it
    to the declared (2, dur + tail*sr) contract; drums.py's mono adapter law
    applies to the engine view. Nothing here reads a seed: a synth repeats."""
    if name not in MACHINES:
        raise ValueError(f"unknown synth {name!r} — {', '.join(machine_names())}")
    P = resolve_params(name, params)
    v = min(max(int(vel127), 1), 127) / 127.0
    dur = max(1, int(dur_samples))
    if name == "bigroom_lead":
        st = _lead(P, sr, v, int(midi), dur)
    else:
        if name == "sub_bass":
            mono = _sub(P, sr, v, int(midi), dur)
        elif name == "riser":
            mono = _riser(P, sr, v, int(midi), dur)
        else:
            mono = _impact(P, sr, v, int(midi))
        st = np.vstack([mono, mono])
    return st * (0.28 + 0.72 * v)          # level is note_voice's gain_db job


# ───────────────────────────────────── the P0 engine's view of a synth
#
# Same adapters as drums.py, for the same reason: engine.py keeps ONE builtin
# table (SYNTHS/TAILS) that the e2e holds to store.js's builtin list, so a
# synth that is a builtin patch must be in it. Mono, default knobs; the real
# render always comes through instruments.py.

def _adapter(name):
    def synth(midi, dur_samples, vel, sr, rng):    # noqa: ARG001 — no seed, by design
        y = voice(name, midi, dur_samples, int(round(min(max(vel, 0.0), 1.0) * 127)) or 1, sr)
        total = int(dur_samples) + int(round(MACHINES[name]["tail"] * sr))
        return _gate((y[0] + y[1]) * 0.5, total, sr)
    synth.__name__ = f"synth_{name}"
    return synth


def engine_synths():
    return {name: _adapter(name) for name in MACHINES}


def engine_tails():
    return {name: MACHINES[name]["tail"] for name in MACHINES}
