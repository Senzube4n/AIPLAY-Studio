# -*- coding: utf-8 -*-
"""DAW — the drum machines. Circuits, not samples.

┌─ WHY DSP AND NOT A SAMPLE PACK ───────────────────────────────────────────┐
│ The owner asked for "high quality good kicks for 808s". An 808 kick is not │
│ a sample problem. It is a bridged-T resonator rung by a trigger pulse: a   │
│ decaying sine, a small initial pitch excess, a separate high-passed click, │
│ and whatever saturation the output stage adds. Written as DSP it costs     │
│ ZERO download, carries NO licence, is byte-deterministic for free, and —   │
│ the part a sample pack can never give — every knob on the front panel is   │
│ a real parameter instead of a folder of frozen wavs.                       │
│                                                                            │
│ So this module is the front panel. Each machine declares its knobs in      │
│ patches.json (the ONE table — store.js validates them, the region hasher   │
│ hashes them, daw_patches lists them) and this file is the circuit behind   │
│ them. A knob that patches.json declares and this file ignores is a lie,    │
│ and instruments_test.py fails on it: every declared param is proven to     │
│ CHANGE THE RENDER.                                                         │
└────────────────────────────────────────────────────────────────────────────┘

WHAT IS MODELLED (and what is honestly approximated)

  tr808   The TR-808 is fully analogue, so all thirteen voices here are the
          real topology: BD/toms/congas are bridged-T rings with a pitch
          excess at the strike; SD is two rings plus band-passed noise under
          a SNAPPY balance; CH/OH/CY/CB share ONE cluster of six square
          oscillators at 205.3, 304.4, 369.6, 522.7, 540.0 and 800.0 Hz —
          the frequencies the machine actually uses — differing only in
          filter and envelope; CP is the three-burst-plus-tail envelope on a
          band-passed noise. This is a faithful model, not a flavour.

  tr909   Deliberately a DIFFERENT circuit, not the 808 with other numbers.
          The BD is a triangle core with a deep, fast pitch envelope and a
          separate noise+pulse ATTACK stage — that is where the 909's punch
          lives. The SD is noise-dominant through a high-pass with a tunable
          TONE, over two triangle rings. The toms carry a noise blend.
          HONEST GAP: on the real 909 the hats, ride, crash, clap and rim
          are 6-bit PCM samples of a real kit, NOT analogue circuits. Those
          five voices here are synthesised approximations — a denser
          inharmonic cluster through a brighter resonant band. They read as
          "909-ish" and they are useful; they are not a transfer of the ROM.

  tr808_bass  The instrument people mean when they say "an 808": the BD
          circuit with the decay opened up and the pitch tracking MIDI, so a
          long note sustains as a bass line. It honours note LENGTH (every
          other machine voice is a hit and ignores it) and saturates on the
          way out so it survives a phone speaker.

  hybrid_kick  Not a vintage model. A clean sine sub with a fast pitch snap
          and a SEPARATE transient layer (a band-passed beater knock plus a
          bright click) that can be dialled in independently — the modern
          trap/pop kick that has to sit under a dense mix.

DETERMINISM — a machine repeats EXACTLY, and that is the instrument.
  Nothing here reads the per-note seed. A TR-808 hi-hat is the same six
  oscillators through the same filter every single trigger; a machine that
  dithered its own noise per hit would be less faithful, not more. So the
  noise beds are drawn from fixed per-voice seeds through a cached table,
  every voice is float64 numpy, and the same (patch, note, velocity, params)
  produces the same bytes in every process — which is also what lets
  instruments.py's per-note disk cache replay a hat 400 times for the cost
  of computing it once.

  Velocity, not chance, is the variation: it scales level, and on the voices
  where a real accent brightens (kick click, snare noise, hat) it scales
  those too.

MEASURED, on this box, at default knobs, velocity 110 (instruments_test.py
re-measures every one of these per commit rather than trusting the comment):

  tr808 kick   f0 55.01 Hz . T60 1.13 s (knob range 0.30 - 1.79 s)
               harmonic energy 5.8% of the fundamental -- a RING, not a buzz
               pitch excess at the strike 65.8 -> 55.2 Hz (1.19x): the 808's
               shallow bend, the thing that makes it a boom and not a click
               kick_tune lands within 1 cent of 55 x 2^(n/12) across +-12
               kick_drive 0 measures 0.03% harmonics: exactly a sine
               kick_click lifts 2-16 kHz by 459x and the ring by 0.00 dB

  tr909 kick   f0 55.06 Hz . T60 0.90 s . harmonic energy 11.2% (2x the 808)
               pitch starts at 3.9x the fundamental against the 808's 1.19x
               ATTACK off -> on lifts 4-16 kHz by 2605x; even fully OFF the
               triangle core carries 12x the 808's 300-2000 Hz energy.
               Two different machines, measured, not asserted.

  tr808_bass   tracks MIDI to +-0.0 cents over 32.7-130.8 Hz; a 2 s note
               sounds 2.41 s against a 0.25 s note's 0.71 s (the only voice
               here that honours note length); drive 0 measures a pure sine

  hybrid_kick  sub f0 48.01 Hz at GM key 36, key-tracking exactly an octave
               punch 0 -> 1 lifts 2-16 kHz by 38x and moves the 30-90 Hz sub
               by -0.01 dB: the transient really is a separable layer

  No voice of either kit exceeds full scale at velocity 127 (loudest: the
  808 open hat at 0.951, the 909 snare at 0.976).
"""
import hashlib
import json
import math
import os

import numpy as np
from scipy.signal import butter, sosfilt

HERE = os.path.dirname(os.path.abspath(__file__))

_man = None


_code_fp = None


def code_fingerprint():
    """sha1 of THIS FILE. instruments.py's per-note disk cache keys on it.

    A sampled patch gets cache invalidation for free — its bytes are on disk
    and the fingerprint is their hash. A synthesised one has no such bytes:
    edit a circuit here and every note that patch ever rendered would replay
    from a cache that predates the edit. (It did, once, during this module's
    own measurement pass: the kick's numbers refused to move.) So the CODE is
    the pack, and this is its fingerprint."""
    global _code_fp
    if _code_fp is None:
        with open(os.path.abspath(__file__), "rb") as fh:
            _code_fp = hashlib.sha1(fh.read()).hexdigest()[:16]
    return _code_fp


def _manifest():
    """patches.json — the ONE table. Read here for the declared knob
    DEFAULTS, so this module and store.js's validator cannot drift apart
    (instruments_test.py asserts the two agree, both ways)."""
    global _man
    if _man is None:
        with open(os.path.join(HERE, "patches.json"), encoding="utf-8") as fh:
            _man = json.load(fh)
    return _man


# ───────────────────────────────────────────────────────────── primitives

def _t(n, sr):
    return np.arange(n, dtype=np.float64) / sr


_sos_cache = {}


def _sos(kind, cutoff, sr, order=2):
    key = (kind, cutoff if not isinstance(cutoff, tuple) else cutoff, sr, order)
    hit = _sos_cache.get(key)
    if hit is not None:
        return hit
    ny = sr * 0.5
    if kind == "bp":
        lo, hi = cutoff
        w = [min(max(lo / ny, 1e-4), 0.98), min(max(hi / ny, 2e-4), 0.99)]
        if w[1] <= w[0]:
            w[1] = min(w[0] * 1.5, 0.99)
        sos = butter(order, w, btype="bandpass", output="sos")
    else:
        w = min(max(cutoff / ny, 1e-4), 0.99)
        sos = butter(order, w, btype="highpass" if kind == "hp" else "lowpass", output="sos")
    _sos_cache[key] = sos
    return sos


def _filt(y, kind, cutoff, sr, order=2):
    return sosfilt(_sos(kind, cutoff, sr, order), y)


_noise_tables = {}
_NOISE_SECONDS = 4.0


def _noise(n, sr, seed):
    """A FIXED noise bed per (seed, sr), sliced — so changing a decay knob
    re-shapes the same noise rather than drawing a different one. Uniform
    doubles straight off the PCG64 stream: the most stable transform numpy
    offers, and the one engine.py's P0 synths already use."""
    key = (seed, sr)
    tab = _noise_tables.get(key)
    need = max(n, int(_NOISE_SECONDS * sr))
    if tab is None or len(tab) < n:
        tab = np.random.default_rng(seed).random(need) * 2.0 - 1.0
        _noise_tables[key] = tab
    return tab[:n]


def _ring(f0, n, sr, tau, bend=0.0, bend_tau=0.03, phase=0.0):
    """A bridged-T ring: a decaying sine whose frequency starts `bend` above
    f0 and settles onto it. bend=0 is a plain damped sine."""
    t = _t(n, sr)
    f = f0 * (1.0 + bend * np.exp(-t / max(bend_tau, 1e-5))) if bend else f0
    ph = 2.0 * np.pi * np.cumsum(np.full(n, f) if np.isscalar(f) else f) / sr
    return np.sin(ph + phase) * np.exp(-t / max(tau, 1e-4))


def _sweep_sine(f_start, f_end, n, sr, sweep_tau):
    """The 909/modern kick core before the waveshaper: an exponential glide
    from f_start onto f_end. Returned as PHASE so a caller can drive a
    triangle or a sine from the same glide."""
    t = _t(n, sr)
    f = f_end + (f_start - f_end) * np.exp(-t / max(sweep_tau, 1e-5))
    return 2.0 * np.pi * np.cumsum(f) / sr


def _bl_square(f, n, sr):
    """Band-limited square by addition. The 808's metal cluster is six real
    squares; a naive np.sign() square at 48 kHz folds ~100 harmonics back
    down as inharmonic mud, which is the opposite of what the band-pass
    after it is for."""
    t = _t(n, sr)
    y = np.zeros(n)
    lim = sr * 0.45
    k = 1
    while f * k < lim:
        y += np.sin(2.0 * np.pi * f * k * t) / k
        k += 2
    return y * (4.0 / np.pi)


def _bl_tri_phase(ph, harmonics=15):
    """Band-limited triangle from a PHASE array (so it rides a pitch sweep).
    Odd harmonics, 1/k^2, alternating sign — the 909 kick's core."""
    y = np.zeros_like(ph)
    for m in range(harmonics):
        k = 2 * m + 1
        y += ((-1.0) ** m) * np.sin(k * ph) / (k * k)
    return y * (8.0 / (np.pi * np.pi))


_cluster_cache = {}


def _cluster(freqs, n, sr):
    """The six-oscillator metal bed, summed. Cached per (freqs, n, sr): one
    cluster serves the closed hat, the open hat, the cymbal and the cowbell,
    which is exactly how the machine wires it."""
    key = (freqs, n, sr)
    hit = _cluster_cache.get(key)
    if hit is not None:
        return hit
    y = np.zeros(n)
    for f in freqs:
        y += _bl_square(f, n, sr)
    y /= len(freqs)
    if len(_cluster_cache) > 24:
        _cluster_cache.pop(next(iter(_cluster_cache)))
    _cluster_cache[key] = y
    return y


def _norm(y, peak=1.0):
    """Unit-peak a shaped transient. Every click and pulse in this file is a
    filtered impulse whose raw amplitude depends on the filter — normalising
    it means the knob in front of it is the ONLY thing setting its level, and
    a filter tweak can never silently blow a voice past full scale."""
    m = float(np.max(np.abs(y)))
    return y * (peak / m) if m > 1e-12 else y


def _fade_tail(y, frac=0.10):
    """A raised cosine over the last `frac` of a HIT voice's natural length.
    Voices are cut at a fixed length so they fit the patch's declared tail; a
    cymbal still at -18 dB when that length arrives would truncate with a
    click. A voice already decayed does not notice this."""
    n = len(y)
    k = max(2, int(n * frac))
    y = y.copy()
    y[n - k:] *= 0.5 * (1.0 + np.cos(np.linspace(0.0, np.pi, k)))
    return y


def _drive(y, amount):
    """Output-stage saturation. amount=0 is EXACTLY the identity — a clean
    808 kick has to still be a clean sine, so this must not colour at zero."""
    if amount <= 0.0:
        return y
    g = 1.0 + 11.0 * float(amount)
    return np.tanh(y * g) / math.tanh(g)


def _clap_env(n, sr, bursts, spacing, burst_tau, tail_at, tail_tau, tail_level):
    """The clap: several short noise bursts a few milliseconds apart, then
    the longer 'room' tail. The bursts are a max(), not a sum — the circuit
    re-triggers one envelope rather than stacking several."""
    t = _t(n, sr)
    env = np.zeros(n)
    for i in range(int(bursts)):
        s = int(i * spacing * sr)
        if s >= n:
            break
        env[s:] = np.maximum(env[s:], np.exp(-t[:n - s] / burst_tau))
    s = int(tail_at * sr)
    if s < n:
        env[s:] = np.maximum(env[s:], tail_level * np.exp(-t[:n - s] / tail_tau))
    return env


def _semis(x):
    return 2.0 ** (float(x) / 12.0)


def _midi_hz(m):
    return 440.0 * 2.0 ** ((float(m) - 69.0) / 12.0)


# ═══════════════════════════════════════════════════════ the TR-808 voices
#
# The metal cluster the machine really uses: six square oscillators, shared
# by the closed hat, the open hat, the cymbal and the cowbell.
_808_METAL = (205.3, 304.4, 369.6, 522.7, 540.0, 800.0)


def _808_bd(P, sr, v, key_semis=0.0):
    """Bridged-T ring at ~55 Hz with a small pitch excess at the strike, plus
    the TONE click: a very short high-passed transient from the trigger."""
    tune = float(P["kick_tune"]) + key_semis
    f0 = 55.0 * _semis(tune)
    tau = 0.040 + 0.200 * float(P["kick_decay"])
    n = int(sr * min(2.6, 0.25 + tau * 8.0))
    y = _ring(f0, n, sr, tau, bend=0.28, bend_tau=0.030)
    click = float(P["kick_click"]) * (0.55 + 0.45 * v)
    if click > 0:
        # A 0.22 ms exponential, high-passed at 1.5 kHz: brief enough that
        # its own spectrum still has content up there for the filter to pass.
        # (A 0.7 ms one measured at 1.8x the no-click band energy — audible
        # as a thump, not as the TONE tick the front panel promises.)
        c = np.exp(-_t(n, sr) / 0.00022)
        y += _norm(_filt(c, "hp", 1500.0, sr, 2)) * click * 0.55
    return _fade_tail(_drive(y, float(P["kick_drive"])) * 0.85)


def _808_sd(P, sr, v):
    """Two rings (the shell) under band-passed noise (the wires). SNAPPY is
    the balance control on the front panel and it is the balance here."""
    tune = _semis(P["snare_tune"])
    tau_t = 0.045 + 0.055 * float(P["snare_decay"])
    tau_n = 0.030 + 0.220 * float(P["snare_decay"])
    n = int(sr * 0.45)
    t = _t(n, sr)
    tone = (_ring(180.0 * tune, n, sr, tau_t) * 0.62
            + _ring(330.0 * tune, n, sr, tau_t * 0.75) * 0.38)
    noise = _filt(_noise(n, sr, 8081), "bp", (900.0, 6500.0), sr, 2)
    noise *= np.exp(-t / tau_n)
    snap = float(P["snare_snappy"]) * (0.6 + 0.4 * v)
    return (tone * (1.15 - 0.45 * snap) + noise * (2.4 * snap)) * 0.52


def _808_metal(sr, tau, hp, bp, level, two_stage=0.0):
    n = int(sr * min(2.6, 0.06 + tau * 9.0))
    y = _cluster(_808_METAL, n, sr)
    y = _filt(y, "hp", hp, sr, 2)
    if bp:
        y = _filt(y, "bp", bp, sr, 2)
    t = _t(n, sr)
    env = np.exp(-t / tau)
    if two_stage:
        env = (1.0 - two_stage) * env + two_stage * np.exp(-t / (tau * 3.2))
    return _fade_tail(y * env * level, 0.18 if two_stage else 0.10)


def _808_ch(P, sr, v):
    return _808_metal(sr, 0.008 + 0.030 * float(P["hat_decay"]),
                      6000.0, None, 1.42 * (0.55 + 0.45 * v))


def _808_oh(P, sr, v):
    return _808_metal(sr, 0.030 + 0.220 * float(P["openhat_decay"]),
                      5000.0, None, 1.30 * (0.6 + 0.4 * v))


def _808_cy(P, sr, v):
    return _808_metal(sr, 0.060 + 0.380 * float(P["cymbal_decay"]),
                      3200.0, (3200.0, 12000.0), 1.9 * (0.6 + 0.4 * v),
                      two_stage=0.34)


def _808_cb(P, sr, v):
    """The cowbell is two of the cluster's oscillators (540 + 800 Hz) through
    a mid band — it is not a separate circuit, which is why it is so
    recognisably a relative of the hats."""
    tau = 0.030 + 0.200 * float(P["cowbell_decay"])
    n = int(sr * min(1.2, 0.05 + tau * 7.0))
    y = (_bl_square(540.0, n, sr) + _bl_square(800.0, n, sr)) * 0.5
    y = _filt(y, "bp", (500.0, 5000.0), sr, 2)
    return _fade_tail(y * np.exp(-_t(n, sr) / tau) * 0.52)


def _808_cp(P, sr, v):
    n = int(sr * 0.55)
    env = _clap_env(n, sr, bursts=3, spacing=0.0105, burst_tau=0.0035,
                    tail_at=0.0315, tail_tau=0.020 + 0.130 * float(P["clap_decay"]),
                    tail_level=0.72)
    y = _filt(_noise(n, sr, 4242), "bp", (900.0, 3600.0), sr, 2)
    return y * env * 1.35


def _808_rs(P, sr, v):
    """Rimshot: a hard pulse through a narrow mid band, gone in 40 ms."""
    n = int(sr * 0.14)
    t = _t(n, sr)
    y = _norm(_filt(np.exp(-t / 0.00045), "bp", (1400.0, 2800.0), sr, 2))
    y += _ring(330.0, n, sr, 0.010) * 0.16
    return y * np.exp(-t / 0.014) * 0.62


def _808_tom(P, sr, v, base_hz, noisy=0.07):
    tune = _semis(P["tom_tune"])
    tau = 0.070 + 0.240 * float(P["tom_decay"])
    n = int(sr * min(1.8, 0.15 + tau * 7.0))
    y = _ring(base_hz * tune, n, sr, tau, bend=0.22, bend_tau=0.045)
    if noisy:
        y += _filt(_noise(n, sr, 1717), "bp", (400.0, 5000.0), sr, 2) \
            * np.exp(-_t(n, sr) / 0.020) * noisy * 3.0
    return _fade_tail(y * 0.74)


def _808_maraca(P, sr, v):
    n = int(sr * 0.14)
    y = _filt(_noise(n, sr, 9911), "hp", 8000.0, sr, 2)
    return _norm(y * np.exp(-_t(n, sr) / 0.014)) * 0.60


def _808_clave(P, sr, v):
    n = int(sr * 0.14)
    return _ring(2450.0, n, sr, 0.013) * 0.62


# ═══════════════════════════════════════════════════════ the TR-909 voices
#
# A different machine, not a re-tuned 808: a triangle core under a deep fast
# glide with its own noise ATTACK stage, a noise-led snare, and — honestly
# labelled — synthesised stand-ins for the five voices the real 909 played
# back as 6-bit PCM.
_909_METAL = (263.0, 400.0, 421.0, 474.0, 587.0, 845.0)


def _909_bd(P, sr, v):
    """Triangle core, glide from ~5x down onto the tuned fundamental in tens
    of milliseconds, then the ATTACK stage: a click plus a short noise burst
    that is where the 909's snap actually comes from."""
    f0 = 55.0 * _semis(P["kick_tune"])
    tau = 0.030 + 0.220 * float(P["kick_decay"])
    n = int(sr * min(2.4, 0.20 + tau * 8.0))
    t = _t(n, sr)
    sweep = 0.010 + 0.045 * float(P["kick_sweep"])
    ph = _sweep_sine(f0 * 5.2, f0, n, sr, sweep)
    y = _bl_tri_phase(ph, harmonics=9) * np.exp(-t / tau)
    atk = float(P["kick_attack"]) * (0.5 + 0.5 * v)
    if atk > 0:
        pulse = _norm(_filt(np.exp(-t / 0.00045), "hp", 1200.0, sr, 2))
        burst = _norm(_filt(_noise(n, sr, 9091), "bp", (900.0, 7000.0), sr, 2)
                      * np.exp(-t / 0.0055))
        y += (pulse * 0.42 + burst * 0.62) * atk
    return _fade_tail(_drive(y, float(P["kick_drive"])) * 0.80)


def _909_sd(P, sr, v):
    """Noise-led: the two triangle rings are the body, but TONE (a high-pass
    on the noise) and SNAPPY are what people reach for."""
    tune = _semis(P["snare_tune"])
    n = int(sr * 0.55)
    t = _t(n, sr)
    ph1 = 2.0 * np.pi * 185.0 * tune * t
    ph2 = 2.0 * np.pi * 330.0 * tune * t
    tau_t = 0.035 + 0.045 * float(P["snare_decay"])
    tone = (_bl_tri_phase(ph1, 7) * np.exp(-t / tau_t) * 0.60
            + _bl_tri_phase(ph2, 7) * np.exp(-t / (tau_t * 0.8)) * 0.40)
    hp = 1200.0 + 4800.0 * float(P["snare_tone"])
    noise = _filt(_noise(n, sr, 9092), "bp", (hp, 11000.0), sr, 2)
    noise *= np.exp(-t / (0.050 + 0.260 * float(P["snare_decay"])))
    snap = float(P["snare_snappy"]) * (0.6 + 0.4 * v)
    return (tone * (0.95 - 0.30 * snap) + noise * (3.4 * snap)) * 0.48


def _909_metal(sr, tau, hp, bp, level, two_stage=0.0, ping=0.0):
    n = int(sr * min(2.6, 0.06 + tau * 9.0))
    y = _cluster(_909_METAL, n, sr)
    y = _filt(y, "hp", hp, sr, 2)
    if bp:
        y = _filt(y, "bp", bp, sr, 2)
    t = _t(n, sr)
    env = np.exp(-t / tau)
    if two_stage:
        env = (1.0 - two_stage) * env + two_stage * np.exp(-t / (tau * 3.2))
    y = y * env
    if ping:                       # the ride's struck partial over the wash
        y = y + np.sin(2.0 * np.pi * 3150.0 * t) * np.exp(-t / 0.085) * ping
    return _fade_tail(y * level, 0.18 if two_stage else 0.10)


def _909_ch(P, sr, v):
    return _909_metal(sr, 0.007 + 0.026 * float(P["hat_decay"]),
                      8000.0, (8000.0, 15000.0), 3.6 * (0.55 + 0.45 * v))


def _909_oh(P, sr, v):
    return _909_metal(sr, 0.035 + 0.200 * float(P["openhat_decay"]),
                      6500.0, (6500.0, 15000.0), 3.1 * (0.6 + 0.4 * v))


def _909_crash(P, sr, v):
    return _909_metal(sr, 0.070 + 0.400 * float(P["cymbal_decay"]),
                      2600.0, (2600.0, 13000.0), 2.1 * (0.6 + 0.4 * v),
                      two_stage=0.40)


def _909_ride(P, sr, v):
    return _909_metal(sr, 0.050 + 0.300 * float(P["cymbal_decay"]),
                      3000.0, (3000.0, 11000.0), 1.6 * (0.6 + 0.4 * v),
                      two_stage=0.30, ping=0.30)


def _909_cp(P, sr, v):
    n = int(sr * 0.60)
    env = _clap_env(n, sr, bursts=4, spacing=0.0085, burst_tau=0.0030,
                    tail_at=0.0300, tail_tau=0.025 + 0.150 * float(P["clap_decay"]),
                    tail_level=0.60)
    y = _filt(_noise(n, sr, 4243), "bp", (1200.0, 5200.0), sr, 2)
    return y * env * 1.30


def _909_rs(P, sr, v):
    n = int(sr * 0.12)
    t = _t(n, sr)
    y = _norm(_filt(np.exp(-t / 0.00035), "bp", (1700.0, 3400.0), sr, 2))
    return y * np.exp(-t / 0.010) * 0.66


def _909_tom(P, sr, v, base_hz):
    tune = _semis(P["tom_tune"])
    tau = 0.080 + 0.280 * float(P["tom_decay"])
    n = int(sr * min(2.0, 0.18 + tau * 7.0))
    t = _t(n, sr)
    ph = _sweep_sine(base_hz * tune * 1.9, base_hz * tune, n, sr, 0.030)
    y = np.sin(ph) * np.exp(-t / tau)
    y += _filt(_noise(n, sr, 1718), "bp", (300.0, 4000.0), sr, 2) \
        * np.exp(-t / 0.030) * float(P["tom_noise"]) * 2.2
    return _fade_tail(y * 0.72)


# ══════════════════════════════════════════ the pitched / modern machines

def _bass_808(P, sr, v, midi, dur):
    """THE 808. The BD circuit with the decay opened up and the pitch tracking
    MIDI — so it is a bass instrument, and the ONLY voice here that honours
    note length: write a two-bar note and it holds for two bars."""
    f0 = _midi_hz(midi) * _semis(P["tune"])
    tau = 0.15 + 5.9 * float(P["decay"])
    rel = 0.010 + 0.180 * float(P["release"])
    n = int(dur + sr * min(0.85, rel * 7.0))
    t = _t(n, sr)
    bend = float(P["bend"])
    y = _ring(f0, n, sr, tau, bend=bend, bend_tau=0.008 + 0.060 * float(P["bend_time"]))
    click = float(P["click"]) * (0.5 + 0.5 * v)
    if click > 0:
        y += _norm(_filt(np.exp(-t / 0.00026), "hp", 1200.0, sr, 2)) * click * 0.50
    env = np.ones(n)
    if n > dur:
        env[dur:] = np.exp(-t[:n - dur] / rel)
    return _drive(y * env, float(P["drive"])) * 0.82


def _kick_hybrid(P, sr, v, midi):
    """Clean sub + a SEPARATE transient layer. The sub is a sine (no drive at
    default, so it stays a sine on a subwoofer); the transient is a mid
    beater knock plus a bright click, mixed by its own knob so it can be
    pushed for a laptop speaker without touching the low end."""
    f0 = 48.0 * _semis(P["tune"]) * 2.0 ** ((int(midi) - 36) / 12.0)
    tau = 0.050 + 0.280 * float(P["decay"])
    n = int(sr * min(2.0, 0.20 + tau * 8.0))
    t = _t(n, sr)
    snap = 0.006 + 0.040 * float(P["snap"])
    ph = _sweep_sine(f0 * (1.0 + 7.0 * float(P["pitch_amount"])), f0, n, sr, snap)
    sub = np.sin(ph) * np.exp(-t / tau)
    punch = float(P["punch"]) * (0.5 + 0.5 * v)
    y = sub
    if punch > 0:
        knock = _norm(_filt(_noise(n, sr, 3131), "bp", (280.0, 1100.0), sr, 2)
                      * np.exp(-t / 0.022))
        click = _norm(_filt(np.exp(-t / 0.00040), "hp", 2200.0, sr, 2))
        y = y + (knock * 0.55 + click * 0.40) * punch
    return _fade_tail(_drive(y, float(P["drive"])) * 0.86)


# ═══════════════════════════════════════════════════════════ the machines
#
# Each machine: a GM-ish key map to voice builders, a fallback for keys the
# map does not name (so every key makes a sound), and a per-voice pan for
# the `spread` knob. The default spread is 0 — an 808 has ONE output jack —
# but a kit on one DAW track has no other way to open up, so the knob exists.

def _kit808(P, sr, v, midi):
    m = int(midi)
    if m in (35, 36):
        return _808_bd(P, sr, v), 0.0
    if m == 37:
        return _808_rs(P, sr, v), 0.30
    if m in (38, 40):
        return _808_sd(P, sr, v), -0.08
    if m == 39:
        return _808_cp(P, sr, v), 0.28
    if m in (41, 45):
        return _808_tom(P, sr, v, 82.0), -0.45
    if m in (43, 47):
        return _808_tom(P, sr, v, 122.0), 0.0
    if m in (48, 50):
        return _808_tom(P, sr, v, 165.0), 0.45
    if m in (42, 44):
        return _808_ch(P, sr, v), 0.40
    if m == 46:
        return _808_oh(P, sr, v), 0.40
    if m in (49, 57):
        return _808_cy(P, sr, v), -0.55
    if m in (51, 59):                       # the 808 has no ride: the cymbal,
        return _808_cy(dict(P, cymbal_decay=float(P["cymbal_decay"]) * 0.45),
                       sr, v), 0.55         # damped, is the honest stand-in
    if m == 56:
        return _808_cb(P, sr, v), -0.30
    if m in (54, 70):
        return _808_maraca(P, sr, v), 0.55
    if m in (75, 76, 77):
        return _808_clave(P, sr, v), -0.50
    if m in (61, 64):                       # low conga
        return _808_tom(P, sr, v, 220.0, noisy=0.22), -0.35
    if m in (62, 63):                       # mid / high conga
        return _808_tom(P, sr, v, 310.0 if m == 62 else 440.0, noisy=0.22), 0.35
    return _808_tom(P, sr, v, _midi_hz(m) * 0.5), 0.0


def _kit909(P, sr, v, midi):
    m = int(midi)
    if m in (35, 36):
        return _909_bd(P, sr, v), 0.0
    if m == 37:
        return _909_rs(P, sr, v), 0.30
    if m in (38, 40):
        return _909_sd(P, sr, v), -0.08
    if m == 39:
        return _909_cp(P, sr, v), 0.28
    if m in (41, 45):
        return _909_tom(P, sr, v, 90.0), -0.45
    if m in (43, 47):
        return _909_tom(P, sr, v, 130.0), 0.0
    if m in (48, 50):
        return _909_tom(P, sr, v, 180.0), 0.45
    if m in (42, 44):
        return _909_ch(P, sr, v), 0.40
    if m == 46:
        return _909_oh(P, sr, v), 0.40
    if m in (49, 57):
        return _909_crash(P, sr, v), -0.55
    if m in (51, 53, 59):
        return _909_ride(P, sr, v), 0.55
    return _909_tom(P, sr, v, _midi_hz(m) * 0.5), 0.0


MACHINES = {
    "tr808": {"kit": _kit808, "pitched": False, "tail": 3.0},
    "tr909": {"kit": _kit909, "pitched": False, "tail": 3.0},
    "tr808_bass": {"kit": None, "pitched": True, "tail": 0.9},
    "hybrid_kick": {"kit": None, "pitched": False, "tail": 2.1},
}


def is_machine(name):
    return name in MACHINES


def machine_names():
    return sorted(MACHINES)


def declared_params(name):
    """The knob table for one machine, straight out of patches.json. The ONE
    table: store.js validates against these same rows."""
    row = _manifest()["patches"].get(name) or {}
    return row.get("params") or {}


def defaults(name):
    return {k: s["default"] for k, s in declared_params(name).items()}


def resolve_params(name, params):
    """Declared defaults, overlaid with the caller's values, clamped to the
    declared range. A param this machine does not declare is IGNORED — the
    same rule store.js applies on write, applied again at the voice so the
    CLI and the tests cannot smuggle a knob past it."""
    spec = declared_params(name)
    out = {}
    src = params or {}
    for k, s in spec.items():
        val = src.get(k, s["default"])
        try:
            val = float(val)
        except (TypeError, ValueError):
            val = float(s["default"])
        out[k] = min(max(val, float(s["min"])), float(s["max"]))
    return out


def voice(name, midi, dur_samples, vel127, sr, params=None):
    """One machine hit → float64 stereo (2, n), UNGATED. instruments.py pins
    it to the declared (2, dur + tail*sr) contract; engine.py's mono adapter
    gates its own copy. Nothing here reads a seed: a drum machine repeats."""
    spec = MACHINES.get(name)
    if spec is None:
        raise ValueError(f"unknown drum machine {name!r} — {', '.join(machine_names())}")
    P = resolve_params(name, params)
    v = min(max(int(vel127), 1), 127) / 127.0
    dur = max(1, int(dur_samples))
    pan = 0.0
    if name == "tr808_bass":
        mono = _bass_808(P, sr, v, int(midi), dur)
    elif name == "hybrid_kick":
        mono = _kick_hybrid(P, sr, v, int(midi))
    else:
        mono, pan = spec["kit"](P, sr, v, int(midi))
        pan *= float(P.get("spread", 0.0))
    mono = mono * (0.28 + 0.72 * v)      # level is note_voice's gain_db job
    gl = math.sqrt(0.5 * (1.0 - pan)) * math.sqrt(2.0)
    gr = math.sqrt(0.5 * (1.0 + pan)) * math.sqrt(2.0)
    return np.vstack([mono * gl, mono * gr])


# ───────────────────────────────────── the P0 engine's view of a machine
#
# engine.py keeps ONE builtin table (SYNTHS/TAILS) and the e2e holds it to
# store.js's builtin list byte for byte, so a machine that is a builtin patch
# must be IN that table. These adapters are the mono, default-params view:
# the real render always comes through instruments.py (stereo, knobs, note
# cache), but engine.py's P0 path and probe mirror both stay honest.

def _gate(y, total, sr):
    out = np.zeros(total)
    n = min(len(y), total)
    out[:n] = y[:n]
    fade = min(int(0.010 * sr), total)
    if fade > 1:
        out[total - fade:] *= np.linspace(1.0, 0.0, fade)
    out[-1] = 0.0
    return out


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
