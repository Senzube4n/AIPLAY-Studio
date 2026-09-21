# -*- coding: utf-8 -*-
"""The instrument stage -- the palette, the seam contract, and DETERMINISM.

What this suite exists to prove, in the order it matters:

  SEAM      every voice honours the stereo contract exactly: shape
            (2, dur + tail*sr), last column exactly 0, float32-exact values.
            The region-hash proof in store.js leans on that silence being
            EXACT, so a patch whose tail whispered past its declared bound
            would be a note the hasher excluded and the renderer included.
  SOUND     every installed patch actually makes a noise, and a sampled
            piano is not a sine: the Salamander middle-C render is checked
            for real harmonic structure (>= 4 partials above the noise) and
            against the P0 pluck it replaces.
  REFUSE    the four generate-this-part rows raise Refusal with a message
            that names the family and points at generation.
  REPEAT    same patch + same note = byte-identical, across a cold cache,
            across note ORDER, and across PROCESSES. The FluidSynth finding
            that forced fresh-synth-per-note is re-proven here, not trusted.
  MANIFEST  patches.json is well formed and every renderable patch's file
            resolves -- the one table both sides read.
  KEYCENTER an sfz region that declares no pitch_keycenter is tuned from its
            SAMPLE FILE NAME (in that file's own octave convention, measured
            against its declared regions) and from the format's default of
            60 -- never from the note being played, which is what it used to
            do. Proven in AUDIO: inside one region every key is the same
            sample resampled, so the render at key k must be the render at
            the region's bottom key shifted by exactly (k - bottom)
            semitones, and that is read by cross-correlating their
            log-frequency spectra. The regions nothing corroborates keep the
            old bytes and stop being silent about it.
  CIRCUITS  the drum machines (drums.py) and the big-room synths (synths.py)
            are claims about sound, so they are MEASURED: fundamentals, decay
            times, the 909's pitch envelope against the 808's, the lead's
            filter closing over a 16th, the riser's cutoff opening over its
            note -- and every declared knob is proven to change the render.
  LAYERS    the 2026-09-03 additions the owner's A/B asked for (an octave
            stack on the lead, a mid layer and a longer release on the sub,
            a burst and a room on the 909 clap, a velocity law and a width
            on the 909 hats) are measured the same way, and every existing
            render is PINNED: the sha1 of each machine voice at default
            knobs and of a 2-bar machine job through the rack, recorded on
            the tree before the layers existed.
  CHANNELS  and the two knobs whose settings were argued about in MONO. The
            909 hat pair was reported as costing "0.6-0.9 dB of top end";
            rendered as the bar arrange.js actually writes and read on L, on
            R and on the fold SEPARATELY, that cost is hat_vel's alone
            (identical in both channels to 0.01 dB, so it is a level trim,
            not a tone change) and hat_width's is exactly zero per channel
            and lives only in the fold. The sub's `release` was quoted as
            200 by patches.json and 600 by arrange.js; the geometry it is
            spent on -- note-off 9.77 ms before the next kick and 244 ms
            before the next sub note -- is measured here, and the value both
            files now ship is checked against the audio it produces.

Sections that need an installed pack SKIP (loudly, with the reason) when it
is absent, so the suite runs on a machine that has never downloaded a byte;
the manifest, refusal and builtin sections always run.

Run:  python server/daw/instruments_test.py     (rig venv: numpy + soundfile)
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import instruments as I  # noqa: E402

SR = 48000
passed = 0
failures = []
skipped = []


def ok(label, cond, detail=""):
    global passed
    if cond:
        passed += 1
        print(f"  ok    {label}")
    else:
        failures.append(label)
        print(f"  FAIL  {label}" + (f"\n          {detail}" if detail else ""))


def skip(label, why):
    skipped.append(label)
    print(f"  skip  {label} -- {why}")


INSTALLED = I.installed_state()
MAN = I.manifest()


def have(pid):
    return INSTALLED.get(pid, False)


# ───────────────────────────────────────────────────────── the manifest

print("\n  -- patches.json is the one table, and it is well formed --")

ok("the manifest has a rev, packs and patches",
   isinstance(MAN.get("rev"), int) and MAN.get("packs") and MAN.get("patches"))

bad = []
for pid, row in MAN["patches"].items():
    if row.get("kind") not in ("builtin", "sf2", "sfz", "generate"):
        bad.append(f"{pid}: kind {row.get('kind')!r}")
    if not row.get("label") or not row.get("family"):
        bad.append(f"{pid}: missing label/family")
    if row["kind"] == "generate" and not row.get("refusal"):
        bad.append(f"{pid}: a generate row with no refusal message")
    if row["kind"] in ("sf2", "sfz"):
        if not row.get("file") or not row.get("pack"):
            bad.append(f"{pid}: sampled patch with no file/pack")
        elif row["pack"] not in MAN["packs"]:
            bad.append(f"{pid}: names pack {row['pack']!r} which does not exist")
    if row["kind"] != "generate" and not isinstance(row.get("tail"), (int, float)):
        bad.append(f"{pid}: no numeric tail")
ok("every patch row is complete and internally consistent", not bad, "; ".join(bad))

licence_gaps = []
for pack_id, pack in MAN["packs"].items():
    lic = pack.get("licence") or {}
    if not lic.get("name") or not lic.get("url"):
        licence_gaps.append(f"{pack_id}: no licence name/url")
    if pack.get("attribution_required") and not pack.get("attribution"):
        licence_gaps.append(f"{pack_id}: attribution REQUIRED but no attribution text")
    if not pack.get("expect"):
        licence_gaps.append(f"{pack_id}: no expect paths, so 'installed' cannot be filesystem truth")
ok("every pack states a licence, and every attribution-required pack has its text",
   not licence_gaps, "; ".join(licence_gaps))

ok("the four generate-this-part placeholders exist and are named",
   all(MAN["patches"].get(p, {}).get("kind") == "generate"
       for p in ("sax", "sitar", "choir", "solo_cello")))

ok("effective_tails covers every renderable patch and no generate row",
   set(I.effective_tails()) == {p for p, r in MAN["patches"].items() if r["kind"] != "generate"})

missing_files = [pid for pid, row in MAN["patches"].items()
                 if row["kind"] in ("sf2", "sfz") and have(pid)
                 and not os.path.isfile(os.path.join(I.default_instruments_dir(), *row["file"].split("/")))]
ok("every patch reported installed has its file on disk", not missing_files, ", ".join(missing_files))

# ─────────────────────────────────────────────── the seam, on every patch

print("\n  -- THE SEAM: (2, dur+tail) stereo, ending in exact silence --")

dur = SR // 4
for pid in sorted(I.effective_tails()):
    if not have(pid):
        skip(f"{pid}: seam", "not installed")
        continue
    row = I.patch_row(pid)
    # a midi the patch actually maps: drums answer on GM keys, pitched
    # patches around the middle of their range
    midi = 38 if row["family"] == "drums" else (62 if pid == "hang" else 60)
    y = I.note_voice(pid, midi, dur, 100, SR, 1234)
    want = dur + int(round(row["tail"] * SR))
    ok(f"{pid}: shape is (2, dur + {row['tail']}s)", y.shape == (2, want),
       f"got {y.shape} want (2, {want})")
    ok(f"{pid}: both channels end at exactly zero",
       float(y[0, -1]) == 0.0 and float(y[1, -1]) == 0.0)
    ok(f"{pid}: it actually makes sound", float(np.max(np.abs(y))) > 1e-3,
       f"peak {float(np.max(np.abs(y)))}")
    ok(f"{pid}: values are float32-exact (a cache replay is bit-identical)",
       np.array_equal(y, np.asarray(y, dtype=np.float32).astype(np.float64)))

# ────────────────────────────────────────────────────── the refusals

print("\n  -- the four gaps refuse honestly, and say why --")

for pid, family_word in (("sax", "sax"), ("sitar", "sitar"),
                         ("choir", "choir"), ("solo_cello", "solo string")):
    try:
        I.note_voice(pid, 60, dur, 100, SR, 1)
        ok(f"{pid} refuses to render locally", False, "it rendered instead of refusing")
    except I.Refusal as exc:
        msg = str(exc)
        ok(f"{pid} refuses to render locally", True)
        ok(f"{pid}'s refusal names the family and points at generation",
           family_word.split()[0].lower() in msg.lower() and "generate" in msg.lower(),
           msg[:120])

try:
    I.note_voice("no_such_patch", 60, dur, 100, SR, 1)
    ok("an unknown patch is a ValueError naming the registry", False)
except ValueError as exc:
    ok("an unknown patch is a ValueError naming the registry", "daw_patches" in str(exc))
except I.Refusal:
    ok("an unknown patch is a ValueError naming the registry", False, "got a Refusal")

# ──────────────────────────────────────────────────────── determinism

print("\n  -- DETERMINISM: same note, same bytes -- cache, order, process --")


def cold():
    shutil.rmtree(os.path.join(I.default_instruments_dir(), "_notecache"), ignore_errors=True)


det_patches = [p for p in ("salamander", "generaluser", "hang",
                           "avl_black_pearl", "meatbass_pizz", "vsco2_marimba")
               if have(p)]
if not det_patches:
    skip("determinism", "no sampled patch is installed")

for pid in det_patches:
    row = I.patch_row(pid)
    midi = 38 if row["family"] == "drums" else (62 if pid == "hang" else 60)
    cold()
    a1 = I.note_voice(pid, midi, dur, 100, SR, 7)
    # a DIFFERENT note in between: the FluidSynth history-dependence that
    # forced fresh-synth-per-note showed up exactly here and nowhere else.
    I.note_voice(pid, midi + 7, dur * 2, 120, SR, 8)
    cold()
    a2 = I.note_voice(pid, midi, dur, 100, SR, 7)
    ok(f"{pid}: A-B-A is byte-identical (cold cache, note order changed)",
       np.array_equal(a1, a2),
       f"max diff {float(np.max(np.abs(a1 - a2))) if a1.shape == a2.shape else 'shape'}")
    a3 = I.note_voice(pid, midi, dur, 100, SR, 7)      # now a cache HIT
    ok(f"{pid}: the cached replay is bit-identical to the computed one",
       np.array_equal(a1, a3))

if det_patches:
    print("\n  -- ...and across PROCESSES (the claim a single process cannot make) --")
    pid = det_patches[0]
    row = I.patch_row(pid)
    midi = 38 if row["family"] == "drums" else (62 if pid == "hang" else 60)
    shas = []
    for _ in range(2):
        cold()
        with tempfile.TemporaryDirectory() as td:
            job = os.path.join(td, "j.json")
            with open(job, "w", encoding="utf-8") as fh:
                json.dump({"patch": pid, "midi": midi, "dur_samples": dur,
                           "vel": 100, "sr": SR, "seed": 7}, fh)
            out = subprocess.run([sys.executable, os.path.join(HERE, "instruments.py"), "note", job],
                                 capture_output=True, text=True)
            shas.append(json.loads(out.stdout.strip().splitlines()[-1])["sha1"])
    ok(f"{pid}: two fresh processes render the same sha1", shas[0] == shas[1],
       f"{shas[0]} vs {shas[1]}")
    cold()

# ─────────────────────────────────── the piano is a piano, not a sine

print("\n  -- LISTEN BY PROXY: the Salamander grand has real harmonic structure --")

if not have("salamander"):
    skip("Salamander spectral check", "the salamander pack is not installed")
else:
    y = I.note_voice("salamander", 60, SR, 100, SR, 99)      # middle C, 1 s
    mono = (y[0] + y[1]) * 0.5
    body = mono[int(0.05 * SR):int(0.85 * SR)]
    win = np.hanning(len(body))
    mag = np.abs(np.fft.rfft(body * win))
    freqs = np.fft.rfftfreq(len(body), 1 / SR)
    f0 = 261.6256                                            # middle C

    def energy_at(f, halfwidth=6.0):
        sel = (freqs > f - halfwidth) & (freqs < f + halfwidth)
        return float(mag[sel].max()) if sel.any() else 0.0

    floor = float(np.median(mag))
    partials = [energy_at(f0 * k) for k in range(1, 9)]
    strong = [k for k, e in enumerate(partials, 1) if e > floor * 40]
    ok(f"the fundamental (261.6 Hz) is present and dominant",
       partials[0] > floor * 40, f"partial 1 = {partials[0]:.1f}, floor {floor:.3f}")
    ok(f"at least 4 harmonics stand above the floor (a sine would have 1) -- got {len(strong)}: {strong}",
       len(strong) >= 4)
    ok("the 2nd harmonic is a real partial, not numerical leakage",
       partials[1] > floor * 40, f"partial 2 = {partials[1]:.1f}")
    # a piano decays; a synth pad does not
    head = float(np.sqrt(np.mean(mono[:SR // 10] ** 2)))
    tail = float(np.sqrt(np.mean(mono[SR // 2:SR] ** 2)))
    ok(f"it decays like a struck string (head {head:.4f} > tail {tail:.4f})", head > tail * 1.5)

    # ...and it is NOT the P0 pluck it replaces
    p = I.note_voice("pluck", 60, SR, 100, SR, 99)
    ok("the Salamander render differs from the KS pluck at the same note",
       not np.array_equal(y[:, :SR], p[:, :SR]))
    pm = (p[0] + p[1]) * 0.5
    pmag = np.abs(np.fft.rfft(pm[int(0.05 * SR):int(0.85 * SR)] * win))
    # spectral centroid: two different instruments, two different timbres
    cen = lambda m: float((freqs * m).sum() / max(m.sum(), 1e-12))  # noqa: E731
    ok(f"...and its timbre differs measurably (centroid {cen(mag):.0f} Hz vs pluck {cen(pmag):.0f} Hz)",
       abs(cen(mag) - cen(pmag)) > 50)

# ──────────────────────────────────────────────────── params reach the voice

print("\n  -- params are real: transpose, gain, GM program --")

if have("salamander"):
    base = I.note_voice("salamander", 60, dur, 100, SR, 5)
    up = I.note_voice("salamander", 60, dur, 100, SR, 5, {"transpose": 12})
    direct = I.note_voice("salamander", 72, dur, 100, SR, 5)
    ok("transpose: +12 on C4 is the same voice as C5",
       np.array_equal(up, direct) and not np.array_equal(up, base))
    quiet = I.note_voice("salamander", 60, dur, 100, SR, 5, {"gain_db": -12})
    ratio = float(np.max(np.abs(quiet))) / max(float(np.max(np.abs(base))), 1e-9)
    ok(f"gain_db: -12 dB is a quarter of the amplitude (got {ratio:.3f})",
       abs(ratio - 10 ** (-12 / 20)) < 0.02)
else:
    skip("params (transpose/gain)", "the salamander pack is not installed")

if have("generaluser"):
    a = I.note_voice("generaluser", 60, dur, 100, SR, 6, {"program": 0})
    b = I.note_voice("generaluser", 60, dur, 100, SR, 6, {"program": 40})
    ok("GM program: piano (0) and violin (40) are different voices",
       not np.array_equal(a, b)
       and float(np.max(np.abs(a))) > 1e-3 and float(np.max(np.abs(b))) > 1e-3)
else:
    skip("GM program param", "the generaluser pack is not installed")

# ────────────────────────────────────────────────── the sfz parser itself

print("\n  -- the SFZ subset parses what our packs actually use --")

sfz_patches = [p for p, r in MAN["patches"].items() if r["kind"] == "sfz" and have(p)]
if not sfz_patches:
    skip("sfz parser", "no sfz pack is installed")
for pid in sfz_patches:
    path = os.path.join(I.default_instruments_dir(), *I.patch_row(pid)["file"].split("/"))
    regions, control = I.parse_sfz(path)
    ok(f"{pid}: parses to regions with samples ({len(regions)} regions)",
       len(regions) > 0 and all("sample" in r for r in regions))
    missing = []
    default_path = control.get("default_path", "")
    for r in regions[:400]:
        rel = (default_path + r["sample"]).replace("\\", os.sep)
        full = os.path.normpath(os.path.join(os.path.dirname(path), rel))
        if not os.path.isfile(full):
            missing.append(rel)
    ok(f"{pid}: every region's sample file exists on disk", not missing,
       f"{len(missing)} missing, first: {missing[:2]}")

ok("sfz note names resolve on the sfz convention (c4 = 60)",
   I._sfz_key("c4") == 60 and I._sfz_key("a4") == 69 and I._sfz_key(48) == 48
   and I._sfz_key("f#3") == 54)

# ═══ DRUM MACHINES ═══ (drums.py) ═══════════════════════════════════════
#
# Four synthesised machines, zero download, zero licence. The circuits are
# claims about sound, so this section MEASURES them rather than asserting
# that something rendered: the 808 kick's fundamental and decay against the
# published circuit, the 909's pitch envelope against the 808's to prove the
# two are different machines and not one with different numbers, and every
# declared knob against the render it is supposed to change.

import drums as DR  # noqa: E402

MACHINES = sorted(DR.MACHINES)
KIT_KEYS = [35, 36, 37, 38, 39, 41, 42, 43, 45, 46, 47, 48, 49, 51,
            54, 56, 61, 62, 63, 75]


def m_mono(pid, midi, vel=110, dur=SR // 4, params=None):
    y = I.note_voice(pid, midi, dur, vel, SR, 1, params)
    return (y[0] + y[1]) * 0.5


def m_f0(m, lo=20.0, hi=400.0):
    """Peak of the low spectrum, log-parabolic-interpolated to sub-bin."""
    n = 1 << 19
    seg = m[:min(len(m), n)]
    mag = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), n=n))
    f = np.fft.rfftfreq(n, 1 / SR)
    sel = (f >= lo) & (f <= hi)
    fs, ms = f[sel], mag[sel]
    i = int(np.argmax(ms))
    if 0 < i < len(ms) - 1:
        a, b, c = np.log(np.maximum([ms[i - 1], ms[i], ms[i + 1]], 1e-30))
        den = a - 2 * b + c
        if den < -1e-12:
            d = 0.5 * (a - c) / den
            if abs(d) <= 1.0:
                return float(fs[i] + d * (fs[1] - fs[0]))
    return float(fs[i])


def m_decay(m, db, win_ms=10.0):
    """Seconds from the loudest 10 ms window down to -db, by RMS envelope."""
    w = int(SR * win_ms / 1000)
    e = np.array([np.sqrt(np.mean(m[i * w:(i + 1) * w] ** 2))
                  for i in range(len(m) // w)])
    pk = int(np.argmax(e))
    idx = np.nonzero(e[pk:] < e[pk] * 10 ** (-db / 20))[0]
    return float(idx[0] * w / SR) if len(idx) else float("inf")


def m_harmonics(m, f0, k=8, skip=0.02, span=0.30):
    seg = m[int(skip * SR):int((skip + span) * SR)]
    n = 1 << 18
    mag = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), n=n))
    f = np.fft.rfftfreq(n, 1 / SR)
    return [float(mag[(f > f0 * i - 8) & (f < f0 * i + 8)].max()) for i in range(1, k + 1)]


def m_thd(m, f0):
    h = m_harmonics(m, f0)
    return (sum(h) - h[0]) / max(h[0], 1e-12)


_PITCH_LP = None


def m_pitch_at(m, ms, win=1024):
    """Instantaneous fundamental at `ms` into the voice, by zero crossings on
    a 500 Hz low-passed copy (so a click or an upper partial cannot fool it)."""
    global _PITCH_LP
    if _PITCH_LP is None:
        from scipy.signal import butter as _bt
        _PITCH_LP = _bt(4, 500 / (SR / 2), btype="lowpass", output="sos")
    from scipy.signal import sosfilt as _sf
    s = int(ms * SR / 1000)
    seg = _sf(_PITCH_LP, m[s:s + win])
    z = np.nonzero(np.diff(np.signbit(seg)))[0]
    return float(SR / (2 * np.mean(np.diff(z)))) if len(z) >= 2 else float("nan")


def m_band(m, lo, hi, span=0.030):
    """Energy in a band. RECTANGULAR at the head, cosine only at the tail:
    every transient in this file lives at sample 0, and np.hanning()[0] is
    exactly 0 -- a plain Hann window measures a click as absent. (It did,
    while these thresholds were first being set: an 808 click that raises the
    2-16 kHz band 459x measured as 1.0x.)"""
    seg = np.array(m[:int(span * SR)], dtype=np.float64)
    k = max(2, len(seg) // 4)
    seg[-k:] *= 0.5 * (1.0 + np.cos(np.linspace(0.0, np.pi, k)))
    n = 1 << 18
    mag = np.abs(np.fft.rfft(seg, n=n)) ** 2
    f = np.fft.rfftfreq(n, 1 / SR)
    return float(mag[(f >= lo) & (f < hi)].sum())


print("\n  -- the machines are in the ONE table, on every side of it --")

ok("every drums.py machine is a patch row",
   all(MAN["patches"].get(n, {}).get("builtin") == n for n in MACHINES),
   ", ".join(n for n in MACHINES if MAN["patches"].get(n, {}).get("builtin") != n))
ok("...and every machine patch declares knobs with min/max/default/doc",
   all(MAN["patches"][n].get("params")
       and all({"min", "max", "default", "unit", "doc"} <= set(s)
               for s in MAN["patches"][n]["params"].values())
       for n in MACHINES))
ok("the declared tails and drums.py's own tail table agree",
   {n: MAN["patches"][n]["tail"] for n in MACHINES} == DR.engine_tails(),
   f"{ {n: MAN['patches'][n]['tail'] for n in MACHINES} } vs {DR.engine_tails()}")
_eng = I._daw_engine()
ok("engine.SYNTHS and engine.TAILS carry them too (the probe mirror store.js "
   "is held to)",
   all(n in _eng.SYNTHS and _eng.TAILS.get(n) == DR.MACHINES[n]["tail"] for n in MACHINES))
ok("the mono engine adapter honours the P0 contract (length, exact-zero end)",
   all((lambda y, want: len(y) == want and y[-1] == 0.0 and np.max(np.abs(y)) > 1e-3)(
       _eng.SYNTHS[n](36, SR // 4, 0.85, SR, np.random.default_rng(3)),
       SR // 4 + int(round(DR.MACHINES[n]["tail"] * SR))) for n in MACHINES))

print("\n  -- every mapped key sounds, and nothing clips at full velocity --")

for pid in ("tr808", "tr909"):
    peaks, silent = [], []
    for midi in KIT_KEYS:
        y = I.note_voice(pid, midi, SR // 4, 127, SR, 1)
        p = float(np.max(np.abs(y)))
        peaks.append((p, midi))
        if p < 1e-3:
            silent.append(midi)
    hot = [(round(p, 3), m) for p, m in peaks if p > 1.0]
    ok(f"{pid}: all {len(KIT_KEYS)} mapped keys make sound", not silent, str(silent))
    ok(f"{pid}: no voice exceeds full scale at velocity 127 "
       f"(loudest {max(peaks)[0]:.3f} on key {max(peaks)[1]})", not hot, str(hot))
    ok(f"{pid}: an UNMAPPED key still answers (the tom fallback)",
       float(np.max(np.abs(I.note_voice(pid, 79, SR // 4, 110, SR, 1)))) > 1e-3)
    ok(f"{pid}: velocity 1 is quieter than velocity 127, and still audible",
       1e-3 < float(np.max(np.abs(I.note_voice(pid, 36, SR // 4, 1, SR, 1))))
       < float(np.max(np.abs(I.note_voice(pid, 36, SR // 4, 127, SR, 1)))))

print("\n  -- THE 808 KICK, measured against the circuit it claims to be --")

k808 = m_mono("tr808", 36)
f0_808 = m_f0(k808)
ok(f"the fundamental is the tuned 55 Hz (measured {f0_808:.2f} Hz)",
   abs(f0_808 - 55.0) < 0.6)
t60_808 = m_decay(k808, 60)
ok(f"it decays like an 808 and not a sine wave file: T60 {t60_808:.2f} s, "
   f"inside the machine's 0.6-1.5 s range at the default decay", 0.6 < t60_808 < 1.5)
thd_808 = m_thd(k808, f0_808)
ok(f"the spectrum is a RING, not a buzz: harmonic energy is {100*thd_808:.1f}% "
   f"of the fundamental (a bridged-T is nearly a pure sine)", thd_808 < 0.20)
p0_808, p1_808 = m_pitch_at(k808, 0), m_pitch_at(k808, 120)
ok(f"there is a small pitch excess at the strike: {p0_808:.1f} Hz -> {p1_808:.1f} Hz "
   f"({p0_808/p1_808:.2f}x), the 808's shallow bend",
   1.05 < p0_808 / p1_808 < 1.45)

print("\n  -- ...and the knobs move it, exactly as far as they claim --")

for semis in (-12, 0, 12):
    got = m_f0(m_mono("tr808", 36, params={"kick_tune": semis}))
    want = 55.0 * 2 ** (semis / 12)
    ok(f"kick_tune {semis:+d} puts the fundamental at {want:.1f} Hz (got {got:.2f})",
       abs(1200 * np.log2(got / want)) < 25)
d_min = m_decay(m_mono("tr808", 36, params={"kick_decay": 0.0}), 60)
d_max = m_decay(m_mono("tr808", 36, params={"kick_decay": 1.0}), 60)
ok(f"kick_decay sweeps a real range: T60 {d_min:.2f} s at 0 to {d_max:.2f} s at 1",
   d_max > d_min * 4.0 and d_min < 0.5 and d_max > 1.2)
thd_clean = m_thd(m_mono("tr808", 36, params={"kick_drive": 0.0}), 55.0)
thd_hot = m_thd(m_mono("tr808", 36, params={"kick_drive": 1.0}), 55.0)
ok(f"kick_drive adds harmonics and 0 adds NONE: {100*thd_clean:.2f}% clean -> "
   f"{100*thd_hot:.1f}% driven", thd_clean < 0.02 and thd_hot > thd_clean * 8)
q = m_mono("tr808", 36, params={"kick_click": 0.0})
c = m_mono("tr808", 36, params={"kick_click": 1.0})
r_click = m_band(c, 2000, 16000) / max(m_band(q, 2000, 16000), 1e-30)
ok(f"kick_click is a real TONE transient: it lifts 2-16 kHz over the first "
   f"30 ms by {r_click:.0f}x, and the ring underneath is untouched "
   f"({abs(10*np.log10(m_band(c, 40, 90, 0.25) / max(m_band(q, 40, 90, 0.25), 1e-30))):.2f} dB)",
   r_click > 50
   and abs(10 * np.log10(m_band(c, 40, 90, 0.25) / max(m_band(q, 40, 90, 0.25), 1e-30))) < 1.0)

print("\n  -- the 909 is a DIFFERENT machine, not the 808 with other numbers --")

k909 = m_mono("tr909", 36)
f0_909 = m_f0(k909)
ok(f"its fundamental is also the tuned 55 Hz (measured {f0_909:.2f} Hz) -- so any "
   f"difference below is character, not tuning", abs(f0_909 - 55.0) < 0.6)
ok("the two kicks are not the same bytes", not np.array_equal(k808, k909))
sw808 = m_pitch_at(k808, 0) / m_pitch_at(k808, 120)
sw909 = m_pitch_at(k909, 0) / m_pitch_at(k909, 120)
ok(f"the 909's pitch envelope is far deeper: it starts at {sw909:.1f}x its "
   f"fundamental, the 808 at {sw808:.2f}x", sw909 > sw808 * 2.0 and sw909 > 2.5)
thd_909 = m_thd(k909, f0_909)
ok(f"its triangle core carries more harmonic energy: {100*thd_909:.1f}% vs the "
   f"808's {100*thd_808:.1f}%", thd_909 > thd_808 * 1.5)
atk_on = m_mono("tr909", 36, params={"kick_attack": 1.0})
atk_off = m_mono("tr909", 36, params={"kick_attack": 0.0})
r_atk = m_band(atk_on, 4000, 16000) / max(m_band(atk_off, 4000, 16000), 1e-30)
ok(f"the ATTACK stage is a real second circuit, not a level trim: 0 -> 1 lifts "
   f"4-16 kHz by {r_atk:.0f}x", r_atk > 100)
_mid9 = m_band(atk_off, 300, 2000, 0.25)
_mid8 = m_band(k808, 300, 2000, 0.25)
ok(f"...and with ATTACK all the way OFF the 909 STILL carries {_mid9/_mid8:.0f}x "
   f"the 808's 300-2000 Hz energy -- that is the triangle core, not the transient",
   _mid9 > _mid8 * 5.0)
sn808 = m_mono("tr808", 38)
sn909 = m_mono("tr909", 38)
cen = lambda m: float(  # noqa: E731
    (np.fft.rfftfreq(len(m[:SR // 4]), 1 / SR)
     * np.abs(np.fft.rfft(m[:SR // 4] * np.hanning(len(m[:SR // 4])))))
    .sum() / max(np.abs(np.fft.rfft(m[:SR // 4] * np.hanning(len(m[:SR // 4])))).sum(), 1e-12))
ok(f"the snares differ in timbre too (centroid {cen(sn808):.0f} Hz vs "
   f"{cen(sn909):.0f} Hz)", abs(cen(sn808) - cen(sn909)) > 500)

print("\n  -- the 808 BASS tracks MIDI and holds a note --")

for midi in (24, 33, 40, 48):
    got = m_f0(m_mono("tr808_bass", midi, dur=SR), 15, 600)
    want = 440.0 * 2 ** ((midi - 69) / 12)
    ok(f"midi {midi} sounds {want:.2f} Hz (got {got:.2f}, "
       f"{1200*np.log2(got/want):+.1f} cents)", abs(1200 * np.log2(got / want)) < 12)
short = I.note_voice("tr808_bass", 33, SR // 4, 110, SR, 1)
long_ = I.note_voice("tr808_bass", 33, SR * 2, 110, SR, 1)


def sounding_seconds(y, floor_db=-45.0):
    m = np.abs((y[0] + y[1]) * 0.5)
    thr = float(m.max()) * 10 ** (floor_db / 20)
    idx = np.nonzero(m > thr)[0]
    return float((idx[-1] - idx[0]) / SR) if len(idx) else 0.0


ok(f"it is the one machine voice that honours note LENGTH: a 2 s note sounds "
   f"{sounding_seconds(long_):.2f} s, a 0.25 s note {sounding_seconds(short):.2f} s",
   sounding_seconds(long_) > sounding_seconds(short) * 2.5)
ok("...while a kit voice ignores it -- a hit is a hit",
   np.array_equal(I.note_voice("tr808", 36, SR // 4, 110, SR, 1)[:, :SR // 4],
                  I.note_voice("tr808", 36, SR * 2, 110, SR, 1)[:, :SR // 4]))
ok("drive 0 leaves a mathematically clean sub (a sine, on a subwoofer)",
   m_thd(m_mono("tr808_bass", 33, dur=SR, params={"drive": 0.0, "click": 0.0}),
         55.0) < 0.02)
_bq = m_mono("tr808_bass", 33, dur=SR, params={"click": 0.0})
_bc = m_mono("tr808_bass", 33, dur=SR, params={"click": 1.0})
ok(f"...and click is what makes it audible on a phone: "
   f"{m_band(_bc, 2000, 16000) / max(m_band(_bq, 2000, 16000), 1e-30):.0f}x in 2-16 kHz",
   m_band(_bc, 2000, 16000) > m_band(_bq, 2000, 16000) * 30)
ok("drive is real too: 0 -> 1 multiplies the harmonic energy",
   m_thd(m_mono("tr808_bass", 33, dur=SR, params={"drive": 1.0, "click": 0.0}), 55.0)
   > m_thd(m_mono("tr808_bass", 33, dur=SR, params={"drive": 0.0, "click": 0.0}), 55.0) * 10)

print("\n  -- the HYBRID kick: a clean sub with a separable transient --")

kh = m_mono("hybrid_kick", 36)
ok(f"the sub sits at 48 Hz on GM key 36 (measured {m_f0(kh):.2f} Hz)",
   abs(m_f0(kh) - 48.0) < 0.6)
ok("it key-tracks an octave up",
   abs(m_f0(m_mono("hybrid_kick", 48), 20, 400) - 96.0) < 1.2)
p_on = m_mono("hybrid_kick", 36, params={"punch": 1.0})
p_off = m_mono("hybrid_kick", 36, params={"punch": 0.0})
r_p = m_band(p_on, 2000, 16000) / max(m_band(p_off, 2000, 16000), 1e-30)
d_sub = 10 * np.log10(m_band(p_on, 30, 90, 0.25) / max(m_band(p_off, 30, 90, 0.25), 1e-30))
ok(f"punch is a SEPARATE layer: it lifts 2-16 kHz by {r_p:.0f}x and moves the "
   f"30-90 Hz sub by {d_sub:+.2f} dB -- the whole point of the design",
   r_p > 20 and abs(d_sub) < 0.5)
ok("drive 0 keeps the sub a pure sine",
   m_thd(m_mono("hybrid_kick", 36, params={"drive": 0.0, "punch": 0.0}), 48.0) < 0.02)

print("\n  -- WIRE IT OR IT DOES NOT EXIST: every declared knob changes a render --")

PROBE_KEYS = {"tr808": KIT_KEYS, "tr909": KIT_KEYS,
              "tr808_bass": [24, 33, 45], "hybrid_kick": [36, 48]}

# A knob that only ACTS once a sibling layer is up (the octave stack's
# octave, the mid layer's cutoff, the burst's decay) is probed with that
# sibling ON -- and proven inert with it OFF, which is the byte-identity
# promise the layer's 0 makes. Every other knob must move a render alone.
COMPANIONS = {"tr909": {"clap_noise_decay": {"clap_noise": 0.5}},
              "bigroom_lead": {"layer_octave": {"layer_level": 0.5}},
              "sub_bass": {"mid_cutoff": {"mid_layer": 0.5}}}


def knob_moves(name, knob, alt, keys, base=None):
    base = dict(base or {})
    for midi in keys:
        a = I.note_voice(name, midi, SR // 4, 110, SR, 1, base)
        b = I.note_voice(name, midi, SR // 4, 110, SR, 1, dict(base, **{knob: alt}))
        if not np.array_equal(a, b):
            return True
    return False


def dead_knobs(name, spec, keys):
    dead = []
    for knob, s in spec.items():
        lo, hi, d = float(s["min"]), float(s["max"]), float(s["default"])
        alt = hi if abs(hi - d) > abs(lo - d) else lo
        comp = COMPANIONS.get(name, {}).get(knob)
        if comp is not None:
            if knob_moves(name, knob, alt, keys):
                dead.append(f"{knob} (moved with its layer OFF)")
            elif not knob_moves(name, knob, alt, keys, comp):
                dead.append(f"{knob} (even with {comp})")
        elif not knob_moves(name, knob, alt, keys):
            dead.append(knob)
    return dead


for name in MACHINES:
    spec = MAN["patches"][name]["params"]
    dead = dead_knobs(name, spec, PROBE_KEYS[name])
    ok(f"{name}: all {len(spec)} declared knobs reach the circuit"
       + (f" ({len(COMPANIONS.get(name, {}))} through a layer that is off by default)" if COMPANIONS.get(name) else ""),
       not dead, f"declared but inert: {dead}")
    # ...and the extremes are safe: no NaN, no clip, no wrong shape
    bad = []
    for knob, s in spec.items():
        for val in (float(s["min"]), float(s["max"])):
            midi = PROBE_KEYS[name][0]
            y = I.note_voice(name, midi, SR // 4, 127, SR, 1, {knob: val})
            pk = float(np.max(np.abs(y)))
            if not np.all(np.isfinite(y)) or pk > 1.05 or pk < 1e-4:
                bad.append(f"{knob}={val} -> peak {pk:.3f}")
    ok(f"{name}: both extremes of every knob render finite and unclipped", not bad,
       "; ".join(bad))
    ok(f"{name}: a knob it does NOT declare is ignored, not obeyed",
       np.array_equal(I.note_voice(name, PROBE_KEYS[name][0], SR // 4, 110, SR, 1),
                      I.note_voice(name, PROBE_KEYS[name][0], SR // 4, 110, SR, 1,
                                   {"no_such_knob": 0.9})))

print("\n  -- a machine REPEATS: the same trigger is the same bytes, always --")

for name in MACHINES:
    midi = PROBE_KEYS[name][0]
    cold()
    a = I.note_voice(name, midi, SR // 4, 110, SR, 7)
    I.note_voice(name, midi + 4, SR // 3, 90, SR, 8)      # a different note between
    cold()
    b = I.note_voice(name, midi, SR // 4, 110, SR, 7)
    ok(f"{name}: A-B-A is byte-identical across a cold cache", np.array_equal(a, b))
    ok(f"{name}: the cached replay is bit-identical to the computed one",
       np.array_equal(a, I.note_voice(name, midi, SR // 4, 110, SR, 7)))
    ok(f"{name}: the per-note SEED is ignored -- an 808 hat is the same six "
       f"oscillators every trigger, and that is the instrument",
       np.array_equal(a, I.note_voice(name, midi, SR // 4, 110, SR, 999_999)))

print("\n  -- ...and across PROCESSES, like every other backend --")
shas = {}
for name in MACHINES:
    midi = PROBE_KEYS[name][0]
    runs = []
    for _ in range(2):
        cold()
        with tempfile.TemporaryDirectory() as td:
            job = os.path.join(td, "j.json")
            with open(job, "w", encoding="utf-8") as fh:
                json.dump({"patch": name, "midi": midi, "dur_samples": SR // 4,
                           "vel": 110, "sr": SR, "seed": 7,
                           "params": {list(MAN["patches"][name]["params"])[0]: 0.77}}, fh)
            out = subprocess.run([sys.executable, os.path.join(HERE, "instruments.py"),
                                  "note", job], capture_output=True, text=True)
            runs.append(json.loads(out.stdout.strip().splitlines()[-1])["sha1"])
    shas[name] = runs
    ok(f"{name}: two fresh processes render the same sha1", runs[0] == runs[1],
       f"{runs[0]} vs {runs[1]}")
ok("...and the four machines are four different sounds, not one",
   len({v[0] for v in shas.values()}) == len(MACHINES))
cold()

print("\n  -- editing a CIRCUIT invalidates its cached notes --")
_row808 = dict(I.patch_row("tr808"))
fp_now = I._pack_fingerprint(_row808, I.default_instruments_dir())
ok("a machine's cache fingerprint is drums.py's own source hash, not the "
   "constant every other packless patch gets",
   fp_now == DR.code_fingerprint() and fp_now != "builtin", fp_now)
ok("...while a P0 builtin, whose voice cannot be re-tuned, still gets it",
   I._pack_fingerprint(dict(I.patch_row("pluck")), I.default_instruments_dir()) == "builtin")
# ═══ end DRUM MACHINES ══════════════════════════════════════════════════


# ═══ BIG-ROOM SYNTHS ═══ (synths.py) ════════════════════════════════════
#
# Four synthesised voices for the genre the palette could not make: a
# unison-saw lead whose pluck is a resonant filter closing, a sub that is a
# sine, a riser whose filter opens over its own note, and a sub-drop. Same
# seam as the drum machines, same discipline: every number in synths.py's
# header is re-measured here, every declared knob is proven to change the
# render, and the kick PRESET recorded on hybrid_kick's row is checked
# against the knobs it names and the numbers it claims.

import hashlib as _hl  # noqa: E402

import synths as SY  # noqa: E402

SYNTHS = sorted(SY.MACHINES)
BPM = 128
SIXTEENTH = int(SR * 60 / BPM / 4)           # 117 ms: the Animals lead note
TWO_BARS = int(SR * 60 / BPM * 8)


def m_centroid(seg):
    """Amplitude-weighted spectral centroid of one segment, Hann-windowed."""
    seg = np.asarray(seg, dtype=np.float64)
    if len(seg) < 8 or not np.any(seg):
        return 0.0
    w = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
    f = np.fft.rfftfreq(len(seg), 1 / SR)
    return float((f * w).sum() / max(w.sum(), 1e-12))


def m_last_sounding(m, floor=1e-4):
    idx = np.nonzero(np.abs(m) > floor * float(np.max(np.abs(m))))[0]
    return int(idx[-1]) + 1 if len(idx) else len(m)


def m_crest(m):
    return float(np.max(np.abs(m)) / max(np.sqrt(np.mean(m ** 2)), 1e-12))


# the oscillator alone: one voice, no detune, filter parked wide open
LEAD_OPEN = {"voices": 1, "detune": 0, "cutoff": 6000, "filter_amount": 0,
             "resonance": 0, "drive": 0}

print("\n  -- the synths are in the ONE table, on every side of it --")

ok("every synths.py machine is a patch row, builtin, no pack",
   all(MAN["patches"].get(n, {}).get("builtin") == n
       and MAN["patches"][n].get("kind") == "builtin"
       and not MAN["patches"][n].get("pack") for n in SYNTHS),
   ", ".join(n for n in SYNTHS if MAN["patches"].get(n, {}).get("builtin") != n))
ok("...and every synth patch declares >= 6 knobs with min/max/default/unit/doc",
   all(len(MAN["patches"][n].get("params") or {}) >= 6
       and all({"min", "max", "default", "unit", "doc"} <= set(s)
               and s["min"] <= s["default"] <= s["max"] and len(s["doc"]) > 10
               for s in MAN["patches"][n]["params"].values())
       for n in SYNTHS))
ok("the declared tails and synths.py's own tail table agree",
   {n: MAN["patches"][n]["tail"] for n in SYNTHS} == SY.engine_tails(),
   f"{ {n: MAN['patches'][n]['tail'] for n in SYNTHS} } vs {SY.engine_tails()}")
ok("engine.SYNTHS and engine.TAILS carry them too",
   all(n in _eng.SYNTHS and _eng.TAILS.get(n) == SY.MACHINES[n]["tail"] for n in SYNTHS))
ok("the mono engine adapter honours the P0 contract (length, exact-zero end, sound)",
   all((lambda y, want: len(y) == want and y[-1] == 0.0 and np.max(np.abs(y)) > 1e-3)(
       _eng.SYNTHS[n](60, SR // 4, 0.85, SR, np.random.default_rng(3)),
       SR // 4 + int(round(SY.MACHINES[n]["tail"] * SR))) for n in SYNTHS))
ok("no name is claimed by both machine modules",
   not (set(DR.MACHINES) & set(SY.MACHINES)))
ok("instruments.machine_module sends each name to its own module, and a "
   "non-machine builtin to neither",
   all(I.machine_module(n) is SY for n in SYNTHS)
   and all(I.machine_module(n) is DR for n in DR.MACHINES)
   and I.machine_module("pluck") is None and I.machine_module("salamander") is None)
ok("the synths' front panels are in the palette's families (synth, bass, fx)",
   {MAN["patches"][n]["family"] for n in SYNTHS} == {"synth", "bass", "fx"})

print("\n  -- THE LEAD: the pluck is the filter closing, the width is in the oscillators --")

y_lead = I.note_voice("bigroom_lead", 65, SIXTEENTH, 110, SR, 1)
ok("a 16th at 128 BPM renders the stereo contract (2, dur + 0.5 s), last column 0",
   y_lead.shape == (2, SIXTEENTH + int(round(0.5 * SR))) and np.all(y_lead[:, -1] == 0.0))
m_lead = (y_lead[0] + y_lead[1]) * 0.5
h100 = int(0.100 * SR)
end = m_last_sounding(m_lead)
c_head = m_centroid(m_lead[:h100])
c_tail = m_centroid(m_lead[end - h100:end])
ok(f"spectral centroid first 100 ms {c_head:.0f} Hz -> last 100 ms of the voice "
   f"{c_tail:.0f} Hz ({c_head / max(c_tail, 1):.1f}x): the filter CLOSES over the note",
   c_head > 2.5 * c_tail and c_head > 1500)
q25 = int(0.025 * SR)
c_a, c_b = m_centroid(m_lead[:q25]), m_centroid(m_lead[SIXTEENTH - q25:SIXTEENTH])
ok(f"...and inside the note itself: first 25 ms {c_a:.0f} Hz -> last 25 ms {c_b:.0f} Hz",
   c_a > 2.5 * c_b)
steps = [m_centroid(m_lead[int(ms * SR / 1000):int(ms * SR / 1000) + int(0.010 * SR)])
         for ms in (0, 50, 100)]
ok(f"the cutoff falls monotonically through the note: {steps[0]:.0f} > {steps[1]:.0f} > "
   f"{steps[2]:.0f} Hz at 0 / 50 / 100 ms", steps[0] > steps[1] > steps[2])
rms_a = float(np.sqrt(np.mean(m_lead[:q25] ** 2)))
rms_b = float(np.sqrt(np.mean(m_lead[SIXTEENTH - q25:SIXTEENTH] ** 2)))
ok(f"the AMP is not what does it: level is still {100 * rms_b / rms_a:.0f}% of the "
   f"attack at note-off while the timbre has dulled {c_a / max(c_b, 1):.1f}x",
   rms_b > 0.25 * rms_a)
corr = float(np.corrcoef(y_lead[0][:SIXTEENTH], y_lead[1][:SIXTEENTH])[0, 1])
y_s0 = I.note_voice("bigroom_lead", 65, SIXTEENTH, 110, SR, 1, {"spread": 0.0})
y_s1 = I.note_voice("bigroom_lead", 65, SIXTEENTH, 110, SR, 1, {"spread": 1.0})
corr1 = float(np.corrcoef(y_s1[0][:SIXTEENTH], y_s1[1][:SIXTEENTH])[0, 1])
ok(f"L/R correlation {corr:.2f} at the default spread; spread 1 gives {corr1:.2f}: "
   f"the width is real and the knob covers the range",
   0.3 < corr < 0.9 and corr1 < corr and corr1 < 0.6)
ok("spread 0 is EXACTLY mono: the two channels are the same bytes",
   np.array_equal(y_s0[0], y_s0[1]))
for midi in (41, 53, 65, 77):
    y1 = I.note_voice("bigroom_lead", midi, SR, 110, SR, 1, LEAD_OPEN)
    want = 440.0 * 2 ** ((midi - 69) / 12)
    got = m_f0(((y1[0] + y1[1]) * 0.5)[int(0.05 * SR):], want * 0.7, want * 1.4)
    ok(f"the oscillator tracks MIDI {midi}: {want:.2f} Hz, got {got:.2f} "
       f"({1200 * np.log2(got / want):+.2f} cents, filter open, one voice)",
       abs(1200 * np.log2(got / want)) < 1.0)
y7 = I.note_voice("bigroom_lead", 65, SR, 110, SR, 1)
got7 = m_f0(((y7[0] + y7[1]) * 0.5)[int(0.05 * SR):], 349.23 * 0.7, 349.23 * 1.4)
det = MAN["patches"]["bigroom_lead"]["params"]["detune"]["default"]
ok(f"the seven-voice default reads within the detune cluster: {1200 * np.log2(got7 / 349.23):+.1f} "
   f"cents against a +-{det} cent spread (a peak picker lands on ONE voice)",
   abs(1200 * np.log2(got7 / 349.23)) < det + 6)
y_snap = I.note_voice("bigroom_lead", 65, SR // 2, 110, SR, 1, dict(LEAD_OPEN, snap=12))
m_snap = (y_snap[0] + y_snap[1]) * 0.5
_lp900 = None


def m_pitch_hi(m, ms, win=1024):
    global _lp900
    from scipy.signal import butter as _bt, sosfilt as _sf
    if _lp900 is None:
        _lp900 = _bt(4, 900 / (SR / 2), btype="lowpass", output="sos")
    s = int(ms * SR / 1000)
    seg = _sf(_lp900, m[s:s + win])
    z = np.nonzero(np.diff(np.signbit(seg)))[0]
    return float(SR / (2 * np.mean(np.diff(z)))) if len(z) >= 2 else float("nan")


p_atk, p_body = m_pitch_hi(m_snap, 0), m_pitch_hi(m_snap, 200)
ok(f"snap 12 starts {p_atk / 349.23:.2f}x above the note and is on pitch by 200 ms "
   f"({p_body:.0f} Hz)", p_atk > 1.15 * 349.23 and abs(p_body / 349.23 - 1) < 0.03)
pk127 = float(np.max(np.abs(I.note_voice("bigroom_lead", 65, SIXTEENTH, 127, SR, 1))))
ok(f"peak {pk127:.3f} at velocity 127, default knobs: the safety ceiling (0.95) never "
   f"engages at defaults", 0.3 < pk127 < 0.9)
ok("velocity 1 is quieter than velocity 127, and still audible",
   1e-3 < float(np.max(np.abs(I.note_voice("bigroom_lead", 65, SIXTEENTH, 1, SR, 1))))
   < pk127)
m_d0 = (lambda y: (y[0] + y[1]) * 0.5)(I.note_voice("bigroom_lead", 65, SIXTEENTH, 110, SR, 1, {"drive": 0.0}))
m_d1 = (lambda y: (y[0] + y[1]) * 0.5)(I.note_voice("bigroom_lead", 65, SIXTEENTH, 110, SR, 1, {"drive": 1.0}))
ok(f"drive 0 -> 1 is compression, not a level jump: crest factor {m_crest(m_d0):.2f} -> "
   f"{m_crest(m_d1):.2f}, peak {np.max(np.abs(m_d0)):.2f} -> {np.max(np.abs(m_d1)):.2f}",
   m_crest(m_d1) < m_crest(m_d0) * 0.85
   and 0.4 < np.max(np.abs(m_d1)) / np.max(np.abs(m_d0)) < 1.25)
y_v1 = I.note_voice("bigroom_lead", 65, SIXTEENTH, 110, SR, 1, {"voices": 1})
ok("one voice is narrower than seven",
   float(np.corrcoef(y_v1[0][:SIXTEENTH], y_v1[1][:SIXTEENTH])[0, 1]) > corr + 0.05)

print("\n  -- THE SUB tracks MIDI exactly and holds a note --")

for midi in (24, 33, 40, 48):
    got = m_f0(m_mono("sub_bass", midi, dur=SR), 15, 600)
    want = 440.0 * 2 ** ((midi - 69) / 12)
    ok(f"midi {midi} sounds {want:.2f} Hz (got {got:.2f}, {1200 * np.log2(got / want):+.2f} cents)",
       abs(1200 * np.log2(got / want)) < 3)
ok("drive 0 with sub_mix 0 is a mathematically pure sine (a sine, on a subwoofer)",
   m_thd(m_mono("sub_bass", 33, dur=SR, params={"drive": 0.0, "sub_mix": 0.0}), 55.0) < 0.001)
ok("drive 1 is real: it multiplies the harmonic energy",
   m_thd(m_mono("sub_bass", 33, dur=SR, params={"drive": 1.0, "sub_mix": 0.0}), 55.0)
   > 100 * m_thd(m_mono("sub_bass", 33, dur=SR, params={"drive": 0.0, "sub_mix": 0.0}), 55.0))
_sm0 = m_harmonics(m_mono("sub_bass", 45, dur=SR, params={"sub_mix": 0.0, "drive": 0.0}), 55.0, k=2)
_sm1 = m_harmonics(m_mono("sub_bass", 45, dur=SR, params={"sub_mix": 1.0, "drive": 0.0}), 55.0, k=2)
ok(f"sub_mix puts a real octave under it: at A2 the 55 Hz partial rises "
   f"{_sm1[0] / max(_sm0[0], 1e-9):.0f}x from sub_mix 0 to 1",
   _sm1[0] > 50 * _sm0[0])
ok(f"it honours note LENGTH: a 2 s note sounds "
   f"{sounding_seconds(I.note_voice('sub_bass', 33, SR * 2, 110, SR, 1)):.2f} s, a 0.25 s note "
   f"{sounding_seconds(I.note_voice('sub_bass', 33, SR // 4, 110, SR, 1)):.2f} s",
   sounding_seconds(I.note_voice("sub_bass", 33, SR * 2, 110, SR, 1))
   > 2.5 * sounding_seconds(I.note_voice("sub_bass", 33, SR // 4, 110, SR, 1)))
ok("release is the knob it says: 450 ms rings longer after note-off than 5 ms",
   sounding_seconds(I.note_voice("sub_bass", 33, SR // 4, 110, SR, 1, {"release": 450}))
   > sounding_seconds(I.note_voice("sub_bass", 33, SR // 4, 110, SR, 1, {"release": 5})) + 0.15)

print("\n  -- THE RISER opens over its own note --")

y_r = I.note_voice("riser", 53, TWO_BARS, 110, SR, 1)
m_r = (y_r[0] + y_r[1]) * 0.5
tenth = TWO_BARS // 10
r_a, r_b = m_centroid(m_r[:tenth]), m_centroid(m_r[TWO_BARS - tenth:TWO_BARS])
ok(f"over a 2-bar note the centroid rises {r_a:.0f} Hz -> {r_b:.0f} Hz ({r_b / max(r_a, 1):.0f}x): "
   f"the cutoff actually OPENS", r_b > 8 * r_a and r_a < 600)
y_r1 = I.note_voice("riser", 53, TWO_BARS // 2, 110, SR, 1)
m_r1 = (y_r1[0] + y_r1[1]) * 0.5
r1_b = m_centroid(m_r1[TWO_BARS // 2 - tenth // 2:TWO_BARS // 2])
ok(f"a 1-bar note arrives at the same place ({r1_b:.0f} Hz): the note's length IS the sweep",
   0.6 < r1_b / r_b < 1.6)
mid = m_centroid(m_r[TWO_BARS // 2 - tenth // 2:TWO_BARS // 2 + tenth // 2])
ok(f"halfway it is still climbing: {mid:.0f} Hz, between the ends", r_a < mid < r_b)
_pre = float(np.sqrt(np.mean(m_r[TWO_BARS - int(0.020 * SR):TWO_BARS] ** 2)))
_post = float(np.sqrt(np.mean(m_r[TWO_BARS + int(0.100 * SR):TWO_BARS + int(0.120 * SR)] ** 2)))
ok(f"it STOPS: 100 ms after note-off it is {20 * np.log10(max(_post, 1e-12) / _pre):.0f} dB down "
   f"-- the beat of silence before the drop is silent", _post < _pre * 0.01)
ok("the noise bed is one fixed table, sliced: a 1000-sample draw is the prefix of a 15 s one",
   np.array_equal(DR._noise(1000, SR, 7770), DR._noise(15 * SR, SR, 7770)[:1000]))
_tone = m_mono("riser", 53, dur=SR, params={"noise_mix": 0.0, "tone_rise": 0.0})
_tf0 = m_f0(_tone[int(0.05 * SR):int(0.5 * SR)], 120, 260)
ok(f"noise_mix 0 with tone_rise 0 is a pitched tone at the note: {_tf0:.2f} Hz for F3 (174.61)",
   abs(1200 * np.log2(_tf0 / 174.614)) < 8)
_lowend = m_mono("riser", 53, dur=TWO_BARS // 2, params={"cutoff_end": 200})
ok("cutoff_end is where it lands: at 200 Hz the last tenth is far darker than the default's",
   m_centroid(_lowend[TWO_BARS // 2 - tenth // 2:TWO_BARS // 2]) < 0.25 * r1_b)
ok("the riser ends inside its 0.3 s tail (release max 250 ms): the buffer past dur + 0.28 s is exactly 0",
   not np.any(I.note_voice("riser", 53, SR // 4, 110, SR, 1, {"release": 250})
              [:, SR // 4 + int(0.28 * SR):]))

print("\n  -- THE IMPACT falls into the subs --")

k_imp = m_mono("impact", 36)
p0_imp, p1_imp = m_pitch_at(k_imp, 5), m_pitch_at(k_imp, 800, 8192)
ok(f"pitch {p0_imp:.0f} Hz at the strike -> {p1_imp:.0f} Hz by 800 ms ({p0_imp / p1_imp:.1f}x down)",
   p0_imp > 2.5 * p1_imp and p1_imp < 60)
t60_imp = m_decay(k_imp, 60)
ok(f"T60 {t60_imp:.2f} s -- long enough to be a drop, inside the 2.4 s voice", 1.0 < t60_imp < 2.4)
_b0 = m_mono("impact", 36, params={"burst": 0.0})
_b1 = m_mono("impact", 36, params={"burst": 1.0})
_r_b = m_band(_b1, 2000, 16000) / max(m_band(_b0, 2000, 16000), 1e-30)
_d_b = 10 * np.log10(m_band(_b1, 20, 80, 0.5) / max(m_band(_b0, 20, 80, 0.5), 1e-30))
ok(f"burst is a separate layer: 0 -> 1 lifts 2-16 kHz by {_r_b:.0f}x and moves the 20-80 Hz "
   f"body by {_d_b:+.2f} dB", _r_b > 100 and abs(_d_b) < 0.5)
ok("it is a HIT: note length does not change it",
   np.array_equal(I.note_voice("impact", 36, SR // 4, 110, SR, 1)[:, :SR // 4],
                  I.note_voice("impact", 36, SR * 2, 110, SR, 1)[:, :SR // 4]))
_p36 = m_pitch_at(m_mono("impact", 36), 1200, 8192)
_p48 = m_pitch_at(m_mono("impact", 48), 1200, 8192)
ok(f"it key-tracks: key 48 lands an octave above key 36 ({_p48:.1f} vs {_p36:.1f} Hz)",
   1.7 < _p48 / _p36 < 2.3)
ok("its declared tail is honest: the buffer past dur + 2.45 s is exactly 0 before the gate",
   not np.any(I.note_voice("impact", 36, SR // 4, 127, SR, 1, {"decay": 1.0})
              [:, SR // 4 + int(2.45 * SR):]))

print("\n  -- WIRE IT OR IT DOES NOT EXIST: every declared synth knob changes a render --")

SYN_KEYS = {"bigroom_lead": [53, 65], "sub_bass": [33, 45],
            "riser": [53], "impact": [36, 48]}
for name in SYNTHS:
    spec = MAN["patches"][name]["params"]
    dead = dead_knobs(name, spec, SYN_KEYS[name])
    ok(f"{name}: all {len(spec)} declared knobs reach the circuit"
       + (f" ({len(COMPANIONS.get(name, {}))} through a layer that is off by default)" if COMPANIONS.get(name) else ""),
       not dead, f"declared but inert: {dead}")
    bad = []
    for knob, s in spec.items():
        for val in (float(s["min"]), float(s["max"])):
            for midi in SYN_KEYS[name]:
                y = I.note_voice(name, midi, SR // 4, 127, SR, 1, {knob: val})
                pk = float(np.max(np.abs(y)))
                if not np.all(np.isfinite(y)) or pk > 1.05 or pk < 1e-4:
                    bad.append(f"{knob}={val}@{midi} -> peak {pk:.3f}")
    ok(f"{name}: both extremes of every knob render finite, unclipped and audible", not bad,
       "; ".join(bad))
    ok(f"{name}: a knob it does NOT declare is ignored, not obeyed",
       np.array_equal(I.note_voice(name, SYN_KEYS[name][0], SR // 4, 110, SR, 1),
                      I.note_voice(name, SYN_KEYS[name][0], SR // 4, 110, SR, 1,
                                   {"no_such_knob": 0.9})))
    ok(f"{name}: a drum-machine knob is not its knob either",
       np.array_equal(I.note_voice(name, SYN_KEYS[name][0], SR // 4, 110, SR, 1),
                      I.note_voice(name, SYN_KEYS[name][0], SR // 4, 110, SR, 1,
                                   {"kick_decay": 0.9})))

print("\n  -- a synth REPEATS: the same trigger is the same bytes, always --")

for name in SYNTHS:
    midi = SYN_KEYS[name][0]
    cold()
    a = I.note_voice(name, midi, SR // 4, 110, SR, 7)
    I.note_voice(name, midi + 4, SR // 3, 90, SR, 8)      # a different note between
    cold()
    b = I.note_voice(name, midi, SR // 4, 110, SR, 7)
    ok(f"{name}: A-B-A is byte-identical across a cold cache", np.array_equal(a, b))
    ok(f"{name}: the cached replay is bit-identical to the computed one",
       np.array_equal(a, I.note_voice(name, midi, SR // 4, 110, SR, 7)))
    ok(f"{name}: the per-note SEED is ignored -- a synth repeats, and that is the instrument",
       np.array_equal(a, I.note_voice(name, midi, SR // 4, 110, SR, 999_999)))
    ok(f"{name}: the gate invariant -- last column exactly zero, shape (2, dur + tail)",
       a.shape == (2, SR // 4 + int(round(SY.MACHINES[name]["tail"] * SR)))
       and a[0, -1] == 0.0 and a[1, -1] == 0.0)
cold()
a_short = I.note_voice("riser", 53, SR // 4, 110, SR, 1)
I.note_voice("riser", 53, SR * 15, 110, SR, 1)            # grows the noise table
cold()
ok("riser: a short note renders the same bytes before and after a 15 s note has grown "
   "the noise table (the table is a prefix-stable stream)",
   np.array_equal(a_short, I.note_voice("riser", 53, SR // 4, 110, SR, 1)))

print("\n  -- ...and across PROCESSES, like every other backend --")
syn_shas = {}
for name in SYNTHS:
    midi = SYN_KEYS[name][0]
    runs = []
    for _ in range(2):
        cold()
        with tempfile.TemporaryDirectory() as td:
            job = os.path.join(td, "j.json")
            with open(job, "w", encoding="utf-8") as fh:
                json.dump({"patch": name, "midi": midi, "dur_samples": SR // 4,
                           "vel": 110, "sr": SR, "seed": 7,
                           "params": {list(MAN["patches"][name]["params"])[1]: 0.77}}, fh)
            out = subprocess.run([sys.executable, os.path.join(HERE, "instruments.py"),
                                  "note", job], capture_output=True, text=True)
            runs.append(json.loads(out.stdout.strip().splitlines()[-1])["sha1"])
    syn_shas[name] = runs
    ok(f"{name}: two fresh processes render the same sha1", runs[0] == runs[1],
       f"{runs[0]} vs {runs[1]}")
ok("...and the four synths are four different sounds, and none is a drum machine's",
   len({v[0] for v in syn_shas.values()} | {v[0] for v in shas.values()})
   == len(SYNTHS) + len(MACHINES))
cold()

print("\n  -- editing a CIRCUIT invalidates its cached notes (synths too) --")
_fp_syn = I._pack_fingerprint(dict(I.patch_row("bigroom_lead")), I.default_instruments_dir())
ok("a synth's cache fingerprint is synths.py's own hash, not the constant every other "
   "packless patch gets, and not drums.py's",
   _fp_syn == SY.code_fingerprint() and _fp_syn != "builtin" and _fp_syn != DR.code_fingerprint(),
   _fp_syn)
with open(os.path.join(HERE, "synths.py"), "rb") as _fh:
    _raw_fp = _hl.sha1(_fh.read()).hexdigest()[:16]
ok("...and it folds drums.py's fingerprint in, because the primitives are borrowed: "
   "editing a drums.py filter re-renders a lead note too",
   _fp_syn != _raw_fp)

print("\n  -- the big-room kick PRESET names real knobs and measures as it claims --")
_pre = (MAN["patches"]["hybrid_kick"].get("presets") or {}).get("bigroom")
ok("hybrid_kick carries a `bigroom` preset with a doc and params", bool(_pre)
   and isinstance(_pre.get("params"), dict) and "T60" in (_pre.get("doc") or ""))
_kspec = MAN["patches"]["hybrid_kick"]["params"]
ok("every preset key is a declared hybrid_kick knob, inside its declared range",
   bool(_pre) and all(k in _kspec and _kspec[k]["min"] <= v <= _kspec[k]["max"]
                      for k, v in _pre["params"].items()))
ok("...and it is data, not code: synths.presets() reads the same row (and a row without one reads {})",
   SY.presets("hybrid_kick").get("bigroom") == _pre and SY.presets("riser") == {})
k_def = m_mono("hybrid_kick", 36)
k_big = m_mono("hybrid_kick", 36, params=_pre["params"] if _pre else None)


def m_peak_over_body(m):
    tr = float(np.max(np.abs(m[:int(0.006 * SR)])))
    body = float(np.sqrt(np.mean(m[int(0.030 * SR):int(0.130 * SR)] ** 2)))
    return tr / max(body, 1e-12)


def m_hi_over_sub_db(m):
    return 10 * np.log10(m_band(m, 2000, 16000) / max(m_band(m, 30, 90, 0.25), 1e-30))


t60_def, t60_big = m_decay(k_def, 60), m_decay(k_big, 60)
ok(f"T60 {t60_big:.2f} s against the defaults' {t60_def:.2f} s: the tail clears inside a "
   f"beat at 128 BPM (0.47 s) plus the limiter's release", t60_big < 0.6 and t60_big < t60_def * 0.7)
ok(f"transient peak / body RMS {m_peak_over_body(k_big):.2f} against {m_peak_over_body(k_def):.2f}: "
   f"the hit stands further out of the body", m_peak_over_body(k_big) > m_peak_over_body(k_def) * 1.2)
ok(f"2-16 kHz transient relative to the 30-90 Hz sub: {m_hi_over_sub_db(k_big):+.1f} dB against "
   f"{m_hi_over_sub_db(k_def):+.1f} dB -- {m_hi_over_sub_db(k_big) - m_hi_over_sub_db(k_def):+.1f} dB "
   f"more punch", m_hi_over_sub_db(k_big) - m_hi_over_sub_db(k_def) > 6)
ok(f"...and it is still the same kick underneath: f0 {m_f0(k_big):.2f} Hz",
   abs(m_f0(k_big) - 48.0) < 0.8)
# ═══ end BIG-ROOM SYNTHS ═══════════════════════════════════════════════


# ═══ THE LAYERS (2026-09-03) ═══ (synths.py + drums.py) ═══════════════
#
# The owner heard round 3 and said the lead was "extremely basic", the clap
# and hat "a bit simple", and asked for a bass "heavier and slightly longer".
# The voices grew what the genre keeps INSIDE the voice: an octave stack on
# the lead, a saturated mid layer and a longer release on the sub, a noise
# burst and a room on the 909 clap, a velocity law and a stereo width on the
# 909 hats. Every new knob defaults to OFF and its code path is SKIPPED at
# 0 (not multiplied by zero), so every existing project renders
# byte-identical -- pinned at the end of this block. The `bigroom` presets
# on the three rows carry the measured "modest" values; nothing applies
# them, the arranger sends them.

import rack as RK  # noqa: E402


def m_band_at(m, lo, hi, t0, t1):
    """Energy in a band over a LATE window (t0..t1 s), Hann-windowed --
    for a tail, where the head's transient rule does not apply."""
    seg = np.asarray(m[int(t0 * SR):int(t1 * SR)], dtype=np.float64)
    seg = seg * np.hanning(len(seg))
    n = 1 << 18
    mag = np.abs(np.fft.rfft(seg, n=n)) ** 2
    f = np.fft.rfftfreq(n, 1 / SR)
    return float(mag[(f >= lo) & (f < hi)].sum())


def m_rms(x):
    return float(np.sqrt(np.mean(np.asarray(x, dtype=np.float64) ** 2)))


print("\n  -- THE LEAD's octave layer: energy at 2f, none at 3f, and the pluck closes on it --")

_f4 = 349.23
_h0 = m_harmonics(m_mono("bigroom_lead", 65, dur=SR, params=LEAD_OPEN), _f4, k=4)
_h1 = m_harmonics(m_mono("bigroom_lead", 65, dur=SR, params=dict(LEAD_OPEN, layer_level=0.7)), _f4, k=4)
_h2 = m_harmonics(m_mono("bigroom_lead", 65, dur=SR, params=dict(LEAD_OPEN, layer_level=0.7, layer_octave=2)), _f4, k=4)
ok(f"one open voice, F4: layer_level 0.7 lifts the 2f partial {_h1[1] / _h0[1]:.2f}x (relative to f "
   f"{_h0[1] / _h0[0]:.2f} -> {_h1[1] / _h1[0]:.2f}) and moves 3f by {20 * np.log10(_h1[2] / _h0[2]):+.2f} dB, "
   f"f by {20 * np.log10(_h1[0] / _h0[0]):+.2f} dB: a stack an octave up, not a brighter filter",
   _h1[1] > 2.0 * _h0[1] and abs(20 * np.log10(_h1[2] / _h0[2])) < 0.5
   and abs(20 * np.log10(_h1[0] / _h0[0])) < 0.5)
ok(f"layer_octave 2 puts it at 4f instead: 4f {_h2[3] / _h0[3]:.2f}x, 2f {_h2[1] / _h0[1]:.2f}x",
   _h2[3] > 2.5 * _h0[3] and abs(20 * np.log10(_h2[1] / _h0[1])) < 0.5)
_yl0 = I.note_voice("bigroom_lead", 65, SIXTEENTH, 127, SR, 1)
_yl1 = I.note_voice("bigroom_lead", 65, SIXTEENTH, 127, SR, 1, {"layer_level": 0.35})
_ml0, _ml1 = (_yl0[0] + _yl0[1]) * 0.5, (_yl1[0] + _yl1[1]) * 0.5
_d24 = 10 * np.log10(m_band(_ml1, 2000, 4000, 0.1) / m_band(_ml0, 2000, 4000, 0.1))
_d48 = 10 * np.log10(m_band(_ml1, 4000, 8000, 0.1) / m_band(_ml0, 4000, 8000, 0.1))
ok(f"default knobs, the 16th at velocity 127: the layer at 0.35 (the preset) lifts 2-4 kHz {_d24:+.1f} dB and "
   f"4-8 kHz {_d48:+.1f} dB; peak {float(np.max(np.abs(_yl0))):.3f} -> {float(np.max(np.abs(_yl1))):.3f}, "
   f"the 0.95 ceiling untouched", _d24 > 0.4 and float(np.max(np.abs(_yl1))) < 0.95)
ok("...and it still plucks: with the layer on the centroid falls > 2.5x inside the note",
   m_centroid(_ml1[:int(0.025 * SR)]) > 2.5 * m_centroid(_ml1[SIXTEENTH - int(0.025 * SR):SIXTEENTH]))
_yl_x = I.note_voice("bigroom_lead", 65, SR // 4, 127, SR, 1, {"layer_level": 1.0})
ok(f"layer_level 1 at velocity 127 peaks {float(np.max(np.abs(_yl_x))):.3f}: the ceiling holds the extreme",
   float(np.max(np.abs(_yl_x))) <= 0.951)
ok("layer_level 0 is the old voice to the byte, whatever layer_octave says",
   np.array_equal(_yl0, I.note_voice("bigroom_lead", 65, SIXTEENTH, 127, SR, 1,
                                     {"layer_level": 0.0, "layer_octave": 2})))
ok(f"`spread` already reads as a per-voice width (L/R {corr:.2f} at 0.8, {corr1:.2f} at 1, measured above), "
   f"so the lead grew no `width` knob", "width" not in MAN["patches"]["bigroom_lead"]["params"]
   and 0.3 < corr < 0.9 and corr1 < 0.6)

print("\n  -- THE SUB's mid layer: 100-300 Hz that scales with its level, the sub untouched --")

_SUBP = {"sub_mix": 0.2}                      # the arranger's sub, F1
_s = {ml: m_mono("sub_bass", 29, vel=100, dur=SR // 2, params=dict(_SUBP, mid_layer=ml))
      for ml in (0.0, 0.5, 1.0)}
_b = {ml: m_band(_s[ml], 100, 300, 0.4) for ml in _s}
_lo = {ml: m_band(_s[ml], 30, 70, 0.4) for ml in _s}     # the sub's 43.65 Hz; the layer's own fundamental is at 87
_md = {ml: m_band(_s[ml], 400, 2000, 0.4) for ml in _s}
ok(f"F1: 100-300 Hz energy {10 * np.log10(_b[0.5] / _b[0.0]):+.1f} dB at mid_layer 0.5, "
   f"{10 * np.log10(_b[1.0] / _b[0.0]):+.1f} dB at 1 -- monotonic -- while the sub's own 30-70 Hz moves "
   f"{10 * np.log10(_lo[1.0] / _lo[0.0]):+.2f} dB (the layer's fundamental sits at 87 Hz, above it): "
   f"a layer over the sub, not a louder sub",
   _b[0.0] < _b[0.5] < _b[1.0] and _b[1.0] > 1.8 * _b[0.0]
   and abs(10 * np.log10(_lo[1.0] / _lo[0.0])) < 0.5)
ok(f"...and the harmonics a phone speaker hears: 400-2000 Hz {10 * np.log10(_md[1.0] / _md[0.0]):+.0f} dB at 1",
   _md[1.0] > 100 * _md[0.0])
_c100 = m_band(m_mono("sub_bass", 29, vel=100, dur=SR // 2, params=dict(_SUBP, mid_layer=0.5, mid_cutoff=100)),
               400, 2000, 0.4)
_c2k = m_band(m_mono("sub_bass", 29, vel=100, dur=SR // 2, params=dict(_SUBP, mid_layer=0.5, mid_cutoff=2000)),
              400, 2000, 0.4)
ok(f"mid_cutoff is the layer's own lowpass: 400-2000 Hz {10 * np.log10(_c2k / _c100):+.0f} dB from 100 Hz to 2 kHz",
   _c2k > 30 * _c100)
_ratio = m_rms((_s[1.0] - _s[0.0])[:SR // 2]) / m_rms(_s[0.0][:SR // 2])
ok(f"mid_layer 1 is {_ratio:.2f} of the sub's RMS ({20 * np.log10(_ratio):+.1f} dB): what the doc says, and all the "
   f"room the sub's own peak leaves under the ceiling (MID_TRIM {SY.MID_TRIM})",
   0.35 < _ratio < 0.5 and SY.MID_TRIM == 0.5)
_pk_mid = float(np.max(np.abs(I.note_voice("sub_bass", 29, SR // 4, 127, SR, 1, {"mid_layer": 1.0}))))
ok(f"mid_layer 1 at velocity 127 peaks {_pk_mid:.3f}: under full scale, and under the ceiling's own mark "
   f"(0.95 x 0.90 = 0.855), so the ceiling did not run", _pk_mid < 0.855)
ok("mid_layer 0 is the old voice to the byte, whatever mid_cutoff says",
   np.array_equal(I.note_voice("sub_bass", 33, SR // 4, 110, SR, 1),
                  I.note_voice("sub_bass", 33, SR // 4, 110, SR, 1, {"mid_layer": 0.0, "mid_cutoff": 2000})))

print("\n  -- ...and 'slightly longer': release to 1.5 s inside an honest 1.6 s tail --")

_rel = {r: sounding_seconds(I.note_voice("sub_bass", 33, SR // 4, 110, SR, 1, {"release": r}))
        for r in (80, 200, 1500)}
ok(f"a 0.25 s note sounds {_rel[80]:.2f} s at release 80 (the default), {_rel[200]:.2f} s at 200, "
   f"{_rel[1500]:.2f} s at 1500", _rel[80] < _rel[200] < _rel[1500] and _rel[1500] > _rel[80] + 0.8)
ok("the tail is honest: declared 1.6 s, and at release 1500 the buffer past dur + 1.55 s is exactly 0",
   MAN["patches"]["sub_bass"]["tail"] == 1.6 and SY.MACHINES["sub_bass"]["tail"] == 1.6
   and not np.any(I.note_voice("sub_bass", 33, SR // 4, 127, SR, 1, {"release": 1500})
                  [:, SR // 4 + int(1.55 * SR):]))
ok("...and at the default release the old 0.5 s tail was already silence, so the longer buffer adds exact "
   "zeros to an existing project's sum",
   not np.any(I.note_voice("sub_bass", 29, SIXTEENTH * 2, 100, SR, 1, _SUBP)[:, SIXTEENTH * 2 + int(0.5 * SR):]))

# ── AND WHAT THE `bigroom` PRESET'S RELEASE ACTUALLY SPENDS ────────────────
# The preset shipped 200 while arrange.js sent 600, so a report quoted either
# depending on which file it had read. Both are 500 now, chosen by a sweep
# through rack.chain_graph (arrange.js SUB_RELEASE_SWEEP holds the table and
# arrange_test checks the shipped value IS its maximum). What can be proven
# HERE, on the audio itself, is the geometry that sweep was spending: the
# note the arranger writes is 460 ticks from the "and", so note-off is 20
# ticks before the next kick and 500 ticks before the next sub note, and
# `release` is a time to -60 dB, so the knob is the whole decision about how
# much of each note lands on each of those two places.
_SUB_REL = MAN["patches"]["sub_bass"]["presets"]["bigroom"]["params"]["release"]
_BEAT = 60.0 / BPM
_SUBDUR = int(round(460 / 960 * _BEAT * SR))          # SUB.note_ticks
_TO_KICK = int(round(20 / 960 * _BEAT * SR))          # note-off -> the next kick
_TO_NEXT = int(round(500 / 960 * _BEAT * SR))         # note-off -> the next sub note
_SUBARR = {"sub_mix": 0.2, "mid_layer": 0.8, "mid_cutoff": 400}


def _sub_note(rel):
    return I.note_voice("sub_bass", 29, _SUBDUR, 100, SR, 1,
                        dict(_SUBARR, release=rel)).mean(axis=0)


def _sounds60(m):
    """Time from note-on to the last sample above -60 dB of the note's own
    peak -- the number arrange.js's release table is written in."""
    idx = np.flatnonzero(np.abs(m) > float(np.max(np.abs(m))) * 10 ** (-60 / 20.0))
    return float(idx[-1] + 1) / SR if len(idx) else 0.0


def _tail_db(m, at):
    """The tail 10 ms after `at`, in dB under the note's own body."""
    body = m_rms(m[:_SUBDUR])
    seg = m[_SUBDUR + at: _SUBDUR + at + 480]
    return 20 * np.log10(max(m_rms(seg), 1e-12) / body) if len(seg) else -999.0


ok(f"the arranger's sub note is {_SUBDUR / SR * 1000:.1f} ms and its note-off is "
   f"{_TO_KICK / SR * 1000:.2f} ms before the next kick, {_TO_NEXT / SR * 1000:.2f} ms before the next "
   f"sub note -- 20 and 500 ticks at {BPM} BPM",
   abs(_TO_KICK / SR * 1000 - 9.77) < 0.02 and abs(_TO_NEXT / SR * 1000 - 244.14) < 0.02)
_srel = {r: _sub_note(r) for r in (80, 200, 500, 600, 800)}
_ssnd = {r: _sounds60(m) for r, m in _srel.items()}
ok(f"sounding time at release 80 / 200 / 500 / 600 / 800: "
   + " / ".join(f"{_ssnd[r]:.2f}" for r in (80, 200, 500, 600, 800))
   + f" s -- the shipped {_SUB_REL} sounds {_ssnd[500] / _ssnd[80]:.1f}x the patch default, which is the "
     "'slightly longer' the brief asked for",
   _SUB_REL == 500 and _ssnd[80] < _ssnd[200] < _ssnd[500] < _ssnd[600] < _ssnd[800]
   and _ssnd[500] > 2.0 * _ssnd[80])
ok(f"at the next KICK the tail is {_tail_db(_srel[500], _TO_KICK):+.2f} dB under the note's body at 500 "
   f"against {_tail_db(_srel[200], _TO_KICK):+.2f} at 200 -- only "
   f"{abs(_tail_db(_srel[500], _TO_KICK) - _tail_db(_srel[200], _TO_KICK)):.2f} dB apart, because 9.77 ms of "
   "a -60 dB/500 ms fall is barely any of it. The release is NOT what clears the kick; the sidechain is",
   abs(_tail_db(_srel[500], _TO_KICK) - _tail_db(_srel[200], _TO_KICK)) < 1.5
   # ...while the SAME two settings are 11 dB apart where the next sub note
   # starts. The knob's whole reach is the note after it, not the kick.
   and abs(_tail_db(_srel[500], _TO_NEXT) - _tail_db(_srel[800], _TO_NEXT)) > 5.0
   and abs(_tail_db(_srel[500], _TO_KICK) - _tail_db(_srel[800], _TO_KICK)) < 1.0)
ok(f"at the next SUB NOTE it is {_tail_db(_srel[500], _TO_NEXT):+.1f} dB at 500 against "
   f"{_tail_db(_srel[600], _TO_NEXT):+.1f} at 600 -- 5 dB less of the last note under the next one, and at "
   "200 and under the voice's buffer (dur + release + 20 ms) has already ended, so it is EXACTLY zero",
   _tail_db(_srel[500], _TO_NEXT) < _tail_db(_srel[600], _TO_NEXT) - 3.0
   and not np.any(_srel[200][_SUBDUR + _TO_NEXT:]))

print("\n  -- THE 909 CLAP's burst widens the spectrum; its room outlasts the clap --")

_cp0 = m_mono("tr909", 39)
_cp1 = m_mono("tr909", 39, params={"clap_noise": 1.0})
_cph = m_mono("tr909", 39, params={"clap_noise": 0.5})
_r6k = m_band(_cp1, 6000, 16000) / m_band(_cp0, 6000, 16000)
_dbody = 10 * np.log10(m_band(_cp1, 1200, 5200) / m_band(_cp0, 1200, 5200))
_cen = [m_centroid(m[:int(0.03 * SR)]) for m in (_cp0, _cph, _cp1)]
ok(f"clap_noise 1 lifts 6-16 kHz {_r6k:.1f}x over the first 30 ms and the 1.2-5.2 kHz body {_dbody:+.2f} dB; "
   f"the centroid goes {_cen[0]:.0f} -> {_cen[1]:.0f} (0.5) -> {_cen[2]:.0f} Hz (1): the spectrum WIDENS",
   _r6k > 5 and _dbody < 2.0 and _cen[0] < _cen[1] < _cen[2])
_e5 = m_band_at(m_mono("tr909", 39, params={"clap_noise": 1.0, "clap_noise_decay": 5}), 6000, 16000, 0.04, 0.10)
_e120 = m_band_at(m_mono("tr909", 39, params={"clap_noise": 1.0, "clap_noise_decay": 120}), 6000, 16000, 0.04, 0.10)
ok(f"clap_noise_decay is the burst's own: 6-16 kHz in the 40-100 ms window {10 * np.log10(_e120 / _e5):+.1f} dB "
   f"from 5 ms to 120 ms", _e120 > 2.0 * _e5)
_rm1 = m_mono("tr909", 39, params={"clap_room": 1.0})
_late = lambda m: m_rms(m[int(0.06 * SR):int(0.20 * SR)])   # noqa: E731
_head = lambda m: m_rms(m[:int(0.03 * SR)])                  # noqa: E731
ok(f"clap_room 1 lifts 60-200 ms {20 * np.log10(_late(_rm1) / _late(_cp0)):+.1f} dB and takes T60 "
   f"{m_decay(_cp0, 60):.2f} s -> {m_decay(_rm1, 60):.2f} s while the first 30 ms move "
   f"{20 * np.log10(_head(_rm1) / _head(_cp0)):+.2f} dB: a tail under the clap, not a louder clap",
   _late(_rm1) > 1.8 * _late(_cp0) and m_decay(_rm1, 60) > 1.4 * m_decay(_cp0, 60)
   and abs(20 * np.log10(_head(_rm1) / _head(_cp0))) < 1.5)
_cpk = {str(prm): float(np.max(np.abs(I.note_voice("tr909", 39, SIXTEENTH, 127, SR, 1, prm))))
        for prm in ({"clap_noise": 1.0}, {"clap_room": 1.0}, {"clap_noise": 1.0, "clap_room": 1.0})}
ok("burst 1, room 1 and both at velocity 127 stay under full scale (the ceiling holds the extreme): "
   + ", ".join(f"{v:.3f}" for v in _cpk.values()), all(v <= 0.951 for v in _cpk.values()))
ok("clap_noise 0 and clap_room 0 are the old clap to the byte, whatever clap_noise_decay says",
   np.array_equal(I.note_voice("tr909", 39, SR // 4, 110, SR, 1),
                  I.note_voice("tr909", 39, SR // 4, 110, SR, 1,
                               {"clap_noise": 0.0, "clap_room": 0.0, "clap_noise_decay": 120})))

print("\n  -- THE 909 HATS: velocity moves decay AND level, width decorrelates without a level cost --")


def _t30(v, hv, key=42):
    return m_decay(m_mono("tr909", key, vel=v, params={"hat_vel": hv}), 30)


def _pk(v, hv, key=42):
    return float(np.max(np.abs(m_mono("tr909", key, vel=v, params={"hat_vel": hv}))))


ok(f"closed hat at hat_vel 0: T30 {_t30(40, 0):.2f} s at velocity 40 and {_t30(127, 0):.2f} s at 127 -- the old "
   f"fixed decay, which is what the owner heard", abs(_t30(40, 0) - _t30(127, 0)) < 0.011)
ok(f"hat_vel 1: velocity 40 decays in {_t30(40, 1):.2f} s against 127's {_t30(127, 1):.2f} s and sits "
   f"{20 * np.log10(_pk(40, 1) / _pk(127, 1)):+.1f} dB down against hat_vel 0's "
   f"{20 * np.log10(_pk(40, 0) / _pk(127, 0)):+.1f} dB: decay AND level follow velocity",
   _t30(40, 1) < 0.75 * _t30(127, 1) and _pk(40, 1) < 0.8 * _pk(40, 0))
ok("...and velocity 127 is untouched by the knob, to the byte (the law multiplies by nothing there)",
   np.array_equal(I.note_voice("tr909", 42, SR // 4, 127, SR, 1),
                  I.note_voice("tr909", 42, SR // 4, 127, SR, 1, {"hat_vel": 1.0})))
ok(f"the open hat follows the same law: T30 {_t30(40, 1, 46):.2f} s at velocity 40 against {_t30(127, 1, 46):.2f} s",
   _t30(40, 1, 46) < 0.75 * _t30(127, 1, 46))
_oh = {od: m_decay(m_mono("tr909", 46, params={"openhat_decay": od}), 60) for od in (0.0, 1.0)}
_chx = m_decay(m_mono("tr909", 42, params={"hat_decay": 1.0}), 60)
ok(f"openhat_decay spans T60 {_oh[0.0]:.2f} s -> {_oh[1.0]:.2f} s: a real open hat lives inside the range it "
   f"already had; the closed hat at hat_decay 1 stays {_chx:.2f} s",
   _oh[0.0] < 0.4 and _oh[1.0] > 1.2 and _chx < 0.35)
_hw = {w: I.note_voice("tr909", 42, SIXTEENTH, 110, SR, 1, {"hat_width": w}) for w in (0.0, 0.3, 0.6, 1.0)}
_c = {w: float(np.corrcoef(_hw[w][0][:SIXTEENTH], _hw[w][1][:SIXTEENTH])[0, 1]) for w in _hw}
ok(f"closed hat L/R correlation {_c[0.0]:.2f} / {_c[0.3]:.2f} / {_c[0.6]:.2f} / {_c[1.0]:.2f} at hat_width "
   f"0 / 0.3 / 0.6 / 1: monotonic, down to about 0 at 1 and never anti-phase",
   _c[0.0] > 0.999 and _c[0.0] > _c[0.3] > _c[0.6] > _c[1.0] and -0.3 < _c[1.0] < 0.3)
ok("the LEFT channel is the old hat to the byte at every width, and the RIGHT keeps its level within 0.1 dB "
   "(a flat-magnitude allpass, not a crossfade)",
   all(np.array_equal(_hw[w][0], _hw[0.0][0]) for w in _hw)
   and all(abs(20 * np.log10(m_rms(_hw[w][1]) / m_rms(_hw[0.0][1]))) < 0.1 for w in _hw))
_fl = {w: m_band((_hw[w][0] + _hw[w][1]) * 0.5, 8000, 15000, 0.05) for w in _hw}
ok(f"the price under the FOLD: (L+R)/2 loses {10 * np.log10(_fl[0.6] / _fl[0.0]):+.1f} dB at 0.6 and "
   f"{10 * np.log10(_fl[1.0] / _fl[0.0]):+.1f} dB at 1 in 8-15 kHz -- near the 3 dB any decorrelation costs a mono bus",
   _fl[1.0] > _fl[0.0] * 10 ** (-4.5 / 10) and _fl[0.6] > _fl[0.0] * 10 ** (-2.0 / 10))
_ohw = I.note_voice("tr909", 46, SR // 4, 110, SR, 1, {"hat_width": 1.0})
ok(f"the open hat decorrelates too (L/R {float(np.corrcoef(_ohw[0][:SR // 4], _ohw[1][:SR // 4])[0, 1]):+.2f} at 1)",
   abs(float(np.corrcoef(_ohw[0][:SR // 4], _ohw[1][:SR // 4])[0, 1])) < 0.3)
ok("hat_width touches the HATS only: the clap and the snare render the same bytes with it at 1",
   all(np.array_equal(I.note_voice("tr909", k, SR // 4, 110, SR, 1),
                      I.note_voice("tr909", k, SR // 4, 110, SR, 1, {"hat_width": 1.0})) for k in (38, 39)))

# ══════════════════════════════════════════════════════════════════════════
print("\n  -- the hat knobs' cost, PER CHANNEL, on the pattern the arranger writes --")
#
# The pair was reported as costing "0.6-0.9 dB of top end". That report came
# from a MONO measurement, and a mono measurement cannot tell the two knobs
# apart: one of them takes energy out of both channels and the other takes
# none out of either and only combs the SUM. So the whole hat bar is rendered
# here at the velocities arrange.js writes, and every band is read on L, on R
# and on the fold, separately.

_HATV = {"accent": 108, "plain": 96, "closed_e": 82, "closed_a": 92}


def _hat_bar(params):
    """One drop bar of the arranger's hats: open hats (46) on the four
    "and"s, accented on the "and" of 2 and 4; closed hats (42) on the "e"
    and the "a". Velocities are arrange.js's HATS."""
    out = np.zeros((2, SIXTEENTH * 24))
    plan = []
    for slot in range(16):
        if slot % 4 == 2:
            plan.append((slot, 46, _HATV["accent"] if slot in (6, 14) else _HATV["plain"]))
        elif slot % 4 == 1:
            plan.append((slot, 42, _HATV["closed_e"]))
        elif slot % 4 == 3:
            plan.append((slot, 42, _HATV["closed_a"]))
    for slot, key, vel in plan:
        y = I.note_voice("tr909", key, SIXTEENTH, vel, SR, 1, params)
        a = slot * SIXTEENTH
        out[:, a:a + y.shape[1]] += y[:, :out.shape[1] - a]
    return out


def _wide_band(x, lo, hi):
    """Energy in a band over a WHOLE signal (not a transient window): a plain
    periodogram, so a level change and a comb notch both show up honestly."""
    seg = np.asarray(x, dtype=np.float64)
    mag = np.abs(np.fft.rfft(seg)) ** 2
    f = np.fft.rfftfreq(len(seg), 1 / SR)
    return float(mag[(f >= lo) & (f < hi)].sum())


_HBANDS = (("presence", 2000, 4000), ("brilliance", 4000, 8000), ("air", 8000, 20000))
_hbar = {kv: _hat_bar({"hat_vel": kv[0], "hat_width": kv[1]})
         for kv in ((0.0, 0.0), (0.6, 0.0), (0.0, 0.6), (0.6, 0.6), (0.6, 1.0))}


def _hd(kv, lo, hi, which):
    """dB against hat_vel 0 / hat_width 0, on channel L, channel R, or the fold."""
    pick = {"L": lambda y: y[0], "R": lambda y: y[1], "fold": lambda y: y.mean(axis=0)}[which]
    return 10 * np.log10(_wide_band(pick(_hbar[kv]), lo, hi)
                         / _wide_band(pick(_hbar[(0.0, 0.0)]), lo, hi))


_vel_only = [(nm, _hd((0.6, 0.0), lo, hi, "L"), _hd((0.6, 0.0), lo, hi, "R")) for nm, lo, hi in _HBANDS]
ok("hat_vel 0.6 costs " + ", ".join(f"{nm} {l:+.2f}" for nm, l, _ in _vel_only)
   + " dB -- and the RIGHT channel loses the SAME to 0.01 dB, so it is a level trim on both channels, "
     "not a tone change. It reads as a loss of TOP end only because the 909 hats hold nothing under 6.5 kHz",
   all(abs(l - r) < 0.01 for _, l, r in _vel_only)
   and max(l for _, l, _ in _vel_only) - min(l for _, l, _ in _vel_only) < 0.35
   and all(-1.6 < l < -0.2 for _, l, _ in _vel_only))

_wid_only = [(nm, _hd((0.0, 0.6), lo, hi, "L"), _hd((0.0, 0.6), lo, hi, "R"),
              _hd((0.0, 0.6), lo, hi, "fold")) for nm, lo, hi in _HBANDS]
ok("hat_width 0.6 costs " + ", ".join(f"{nm} {l:+.2f} L / {r:+.2f} R" for nm, l, r, _ in _wid_only)
   + " dB -- NOTHING in either channel, because an allpass is flat in magnitude",
   all(abs(l) < 0.01 and abs(r) < 0.05 for _, l, r, _ in _wid_only))
ok("...and its whole price is the FOLD: " + ", ".join(f"{nm} {f:+.2f}" for nm, _, _, f in _wid_only)
   + " dB, growing with frequency because the allpass turns 90 degrees at 10 kHz. A mono measurement "
     "blames the knob for a loss that only a mono listener has",
   all(f < 0 for _, _, _, f in _wid_only)
   and _wid_only[0][3] > _wid_only[1][3] > _wid_only[2][3] and _wid_only[-1][3] < -1.0)

_pair = [(nm, _hd((0.6, 0.6), lo, hi, "L"), _hd((0.6, 0.6), lo, hi, "fold")) for nm, lo, hi in _HBANDS]
ok("the SHIPPED pair together: " + ", ".join(f"{nm} {l:+.2f} per channel / {f:+.2f} folded" for nm, l, f in _pair)
   + " dB -- the per-channel column is hat_vel's alone, and the two columns add up",
   all(abs(l - v) < 0.02 for (_, l, _), (_, v, _) in zip(_pair, _vel_only))
   and all(abs(f - (v + w)) < 0.25 for (_, _, f), (_, v, _), (_, _, _, w)
           in zip(_pair, _vel_only, _wid_only)))
_hcorr = {w: float(np.corrcoef(_hbar[(0.6, w)][0], _hbar[(0.6, w)][1])[0, 1]) for w in (0.0, 0.6, 1.0)}
ok(f"and what the width BUYS, on the same bar: L/R correlation {_hcorr[0.0]:.3f} -> {_hcorr[0.6]:.3f} at the "
   f"shipped 0.6 and {_hcorr[1.0]:.3f} at 1 -- 0.6 keeps real margin over the Ear's mono-compatible floor "
   "of 0.2 and 1 falls through it, which is why the preset stops where it does",
   _hcorr[0.0] > 0.999 and _hcorr[0.6] > 0.2 + 0.2 and _hcorr[1.0] < 0.2)

print("\n  -- the `bigroom` PRESETS on the three rows are data, declared, in range, and measured --")

_PRESET_KEY = {"bigroom_lead": 65, "sub_bass": 29, "tr909": 39}
for _p in ("bigroom_lead", "sub_bass", "tr909"):
    _prs = (MAN["patches"][_p].get("presets") or {}).get("bigroom")
    _spec = MAN["patches"][_p]["params"]
    ok(f"{_p}: carries a `bigroom` preset -- every key a declared knob inside its range, and a doc that says "
       f"what was measured",
       bool(_prs) and isinstance(_prs.get("params"), dict) and len(_prs["params"]) >= 2
       and all(k in _spec and _spec[k]["min"] <= v <= _spec[k]["max"] for k, v in _prs["params"].items())
       and "measured" in (_prs.get("doc") or "").lower() and SY.presets(_p).get("bigroom") == _prs)
    ok(f"{_p}: ...and its values move the render (a preset of defaults would be a lie)",
       bool(_prs) and not np.array_equal(
           I.note_voice(_p, _PRESET_KEY[_p], SR // 4, 110, SR, 1),
           I.note_voice(_p, _PRESET_KEY[_p], SR // 4, 110, SR, 1, _prs["params"])))

print("\n  -- BYTE PINS: every existing render is the old render (recorded 2026-09-03, before the layers) --")

# Every machine voice at DEFAULT knobs over a spread of keys, velocities and
# lengths (sub_bass over the first dur + 0.5 s: its declared tail grew and
# the rest must be exact zeros), plus the arranger's own lead and sub params
# and the kick preset. Recorded by running this exact code on the certified
# tree (instruments_test 445/0) before synths.py, drums.py or patches.json
# were touched. A change to any default-knob byte flips a line here.
PIN_VOICES = {
    "bigroom_lead": "e6b7ab898f6c2a201ad3fe1d97a2951bfa166447",
    "sub_bass": "fee705da66536329e1d7dab5108833e740024e19",
    "riser": "c4564546482a8a1a0aa3f96eac4333c6c500fe57",
    "impact": "ac258f980284178b1953bd64ccef35c094dd0ef7",
    "tr909": "c76255c05d64186059b06f0034fee616d1f25b95",
    "tr808": "ad3b0fa28c99a7bbc542d99f092aefd8e685e702",
    "hybrid_kick": "2e2c37401f1863f1a99b53b2ee665e5f5c2d6d94",
    "tr808_bass": "dead98ea7a9441209731b404e2eb5d747a989905",
}
PIN_CASES = {
    "bigroom_lead": [(53, 110, SIXTEENTH), (65, 110, SIXTEENTH), (77, 127, SR // 4)],
    "sub_bass": [(29, 100, SIXTEENTH * 2), (33, 110, SR // 4), (45, 127, SR)],
    "riser": [(53, 110, SR)], "impact": [(36, 110, SR // 4), (48, 127, SR // 4)],
    "tr909": [(k, v, SIXTEENTH) for k in (36, 38, 39, 42, 46, 49, 51) for v in (80, 110, 127)],
    "tr808": [(k, 110, SIXTEENTH) for k in (36, 38, 39, 42, 46, 49)],
    "hybrid_kick": [(36, 120, SIXTEENTH), (36, 110, SR // 4)],
    "tr808_bass": [(33, 110, SR // 4)],
}
_OLD_TAIL = int(0.5 * SR)
for _pid, _lst in PIN_CASES.items():
    _h = _hl.sha1()
    _spill = False
    for _midi, _vel, _dur in _lst:
        _y = I.note_voice(_pid, _midi, _dur, _vel, SR, 1)
        if _pid == "sub_bass":
            _h.update(np.ascontiguousarray(_y[:, :_dur + _OLD_TAIL], dtype=np.float32).tobytes())
            _spill = _spill or bool(np.any(_y[:, _dur + _OLD_TAIL:]))
        else:
            _h.update(np.ascontiguousarray(_y, dtype=np.float32).tobytes())
    ok(f"{_pid}: {len(_lst)} default-knob notes render the pinned sha1 {PIN_VOICES[_pid][:12]}"
       + (" (and nothing past the old 0.5 s tail)" if _pid == "sub_bass" else ""),
       _h.hexdigest() == PIN_VOICES[_pid] and not _spill, _h.hexdigest())


def _sha(y):
    return _hl.sha1(np.ascontiguousarray(y, dtype=np.float32).tobytes()).hexdigest()


ok("the arranger's round-3 lead (cutoff 2000, filter_amount 3, filter_decay 120) renders its pinned bytes",
   _sha(I.note_voice("bigroom_lead", 65, SIXTEENTH, 110, SR, 1,
                     {"cutoff": 2000, "filter_amount": 3.0, "filter_decay": 120}))
   == "b57cd2939983dd380c693fc691c4cd8c8daab9b2")
ok("the arranger's round-3 sub (sub_mix 0.2, F1, an eighth) renders its pinned bytes over the old tail",
   _sha(I.note_voice("sub_bass", 29, SIXTEENTH * 2, 100, SR, 1, {"sub_mix": 0.2})[:, :SIXTEENTH * 2 + _OLD_TAIL])
   == "5d728168095b3e00ee129bdc3360987b6dd746b1")
ok("the kick's `bigroom` preset renders its pinned bytes",
   _sha(I.note_voice("hybrid_kick", 36, SIXTEENTH, 120, SR, 1,
                     {"decay": 0.06, "snap": 0.2, "pitch_amount": 0.6, "punch": 1.0, "drive": 0.1}))
   == "d88ce78931fe338638a6d3938d89b7da2b388742")

# ...and through the RACK: a 2-bar machine job in the round-3 shape (kick on
# the beat with the preset and a -9 dB bell at 173 Hz, the sub on the
# off-beats through the kick's sidechain, the lead on eighths through a
# 150 Hz high-pass and the same sidechain, the 909 clap on 2 and 4 with open
# hats on the off-beats and closed 16ths between, a crash on 1, a -1 dBTP
# limiter on the master), rendered under the fold and under mixer.stereo.
# rack_test.py pins its own lead + kick job the same way; this one carries
# the sub and the 909 too, because those are the voices that grew.
# Updated 2026-09-06 for the limiter's future control samples. Against the
# previous rack, only frames 179993..179999 of 180000 differ (max 1.4802e-5).
# Every voice pin above is unchanged; region_lookahead_test.py independently
# checks that a region now equals the same prefix of a longer native render.
PIN_JOB_FOLD = "5b8aba62a1d11b6be2a47566325c745b8570f5e0"
PIN_JOB_STEREO = "8be4b99b96253c23622e7f0784b9646656634e40"


def machine_job(stereo):
    KP = {"decay": 0.06, "snap": 0.2, "pitch_amount": 0.6, "punch": 1.0, "drive": 0.1}
    SIX = SIXTEENTH
    notes = []
    for i in range(8):
        notes.append({"inst": "hybrid_kick", "midi": 36, "vel": 120, "start_sample": i * SIX * 4,
                      "dur_samples": SIX, "gain_db": 0, "seed": 1, "track_id": "kick", "params": KP})
        notes.append({"inst": "sub_bass", "midi": 29 + (0, 0, 3, 3, 8, 8, 10, 10)[i], "vel": 100,
                      "start_sample": i * SIX * 4 + SIX * 2, "dur_samples": SIX * 2, "gain_db": 0,
                      "seed": 1, "track_id": "sub", "params": {"sub_mix": 0.2}})
    for i in range(16):
        notes.append({"inst": "bigroom_lead", "midi": 65 + (0, 3, 7, 12)[i % 4], "vel": 110,
                      "start_sample": i * SIX * 2, "dur_samples": SIX, "gain_db": 0, "seed": 1,
                      "track_id": "lead", "params": {}})
    for i in range(32):
        if i % 8 == 4:
            notes.append({"inst": "tr909", "midi": 39, "vel": 110, "start_sample": i * SIX,
                          "dur_samples": SIX, "gain_db": 0, "seed": 1, "track_id": "hats", "params": {}})
        elif i % 4 == 2:
            notes.append({"inst": "tr909", "midi": 46, "vel": 100, "start_sample": i * SIX,
                          "dur_samples": SIX, "gain_db": 0, "seed": 1, "track_id": "hats", "params": {}})
        else:
            notes.append({"inst": "tr909", "midi": 42, "vel": 80 if i % 2 else 100, "start_sample": i * SIX,
                          "dur_samples": SIX, "gain_db": 0, "seed": 1, "track_id": "hats", "params": {}})
    notes.append({"inst": "tr909", "midi": 49, "vel": 110, "start_sample": 0, "dur_samples": SIX,
                  "gain_db": 0, "seed": 1, "track_id": "crash", "params": {}})
    sc = {"sidechain": "kick", "threshold_db": -20, "ratio": 20, "attack_ms": 0.5, "release_ms": 234.375}
    mx = {"tracks": {
            "kick": {"inserts": [{"id": "k1", "type": "eq", "enabled": True,
                                  "params": {"b2_hz": 173, "b2_gain_db": -9, "b2_q": 1.33}}],
                     "fader": 0, "pan": 0, "sends": []},
            "sub": {"inserts": [{"id": "s1", "type": "compressor", "enabled": True, "params": sc}],
                    "fader": -3, "pan": 0, "sends": []},
            "lead": {"inserts": [{"id": "l1", "type": "eq", "enabled": True,
                                  "params": {"hp_on": True, "hp_hz": 150}},
                                 {"id": "l2", "type": "compressor", "enabled": True, "params": sc}],
                     "fader": -6, "pan": 0, "sends": []},
            "hats": {"inserts": [{"id": "h1", "type": "eq", "enabled": True,
                                  "params": {"hp_on": True, "hp_hz": 150}}],
                     "fader": -8, "pan": 0, "sends": []},
            "crash": {"inserts": [{"id": "c1", "type": "eq", "enabled": True,
                                   "params": {"hp_on": True, "hp_hz": 300}}],
                      "fader": -9, "pan": 0, "sends": []}},
          "returns": [],
          "master": {"inserts": [{"id": "m1", "type": "limiter", "enabled": True,
                                  "params": {"ceiling_db": -1, "release_ms": 80, "lookahead_ms": 5}}],
                     "fader": 0},
          "spq": [[0.0, 60 / 128]]}
    if stereo:
        mx["stereo"] = True
    return {"sr": SR, "start_sample": 0, "n_samples": SIX * 32, "notes": notes, "mixer": mx}


_rf = RK.render_with_chain(machine_job(False), _eng.SYNTHS, _eng.TAILS)
ok(f"the 2-bar machine job under the FOLD renders its pinned sha1 ({PIN_JOB_FOLD[:12]}, peak {_rf['peak']:.4f})",
   _rf["sha1"] == PIN_JOB_FOLD and _rf["stereo"] is False, _rf["sha1"])
_rs = RK.render_with_chain(machine_job(True), _eng.SYNTHS, _eng.TAILS)
ok(f"...and under mixer.stereo its pinned sha1 ({PIN_JOB_STEREO[:12]}, peak {_rs['peak']:.4f})",
   _rs["sha1"] == PIN_JOB_STEREO and _rs["stereo"] is True, _rs["sha1"])
cold()
# ═══ end THE LAYERS ════════════════════════════════════════════════════



# === NEW SAMPLED PACKS (2026-08-27) ===================================
#
# Guitar, bass, keys, a third drum kit and a harp. Each section SKIPS when its
# pack is not installed, like every other pack section here. What it proves
# beyond "it rendered": the mapping is pitched where the key says it is (a
# wrong pitch_keycenter is silent to every other check), the round robins the
# packs ship actually VARY per note, and MuldjordKit's own 48-66 layout is
# reachable from the GM keys a beat is written on.

NEW_PITCHED = [
    ("eguitar_clean", [40, 47, 52, 59, 64]),      # E2 B2 E3 B3 E4 -- guitar strings
    ("eguitar_jazz", [40, 52, 64]),
    # 59 and 61 are the NEIGHBOURS of 60 inside growlybass_clean's one
    # keycenter-less group (lokey=59 hikey=61, sample sustain/c4_*.wav).
    # Probing only 60 was probing the one key the old fallback got right:
    # on the pre-change tree 59 and 61 score a comb ratio of 0.00 against the
    # 3.0 this demands, while 60 scores 11404. A check that cannot fail.
    ("growlybass", [33, 40, 45, 52, 59, 60, 61, 72]),  # A1 up: the mapped range
    ("epiano_wurlitzer", [48, 60, 72]),
    ("epiano_pianet", [48, 60, 72]),
    ("epiano_cp80", [36, 60, 84]),
    ("organ_drawbar", [48, 60, 72]),
    ("organ_percussive", [48, 60, 72]),
    ("organ_rock", [48, 60, 72]),
    ("harp", [40, 52, 64, 76]),
]

def m_comb(m, f0, ks=(1, 2, 3, 4, 5, 6)):
    """Energy summed over a harmonic COMB at f0. Comparing that against the
    same comb a semitone up and down is how a mapping's tuning gets tested
    without a pitch tracker -- and it HAS to be done that way, because a DI
    bass low note has a second harmonic louder than its fundamental and a
    drawbar organ registration is loudest an octave BELOW the key pressed.
    Both of those measured here; both are correct instruments, and a peak
    picker calls both of them out of tune. A wrong pitch_keycenter, by
    contrast, puts nothing on the comb at all."""
    seg = m[int(0.04 * SR):int(0.44 * SR)]
    n = 1 << 19
    mag = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), n=n)) ** 2
    f = np.fft.rfftfreq(n, 1 / SR)
    tot = 0.0
    for k in ks:
        hz = f0 * k
        if hz > SR * 0.45:
            break
        s = (f > hz * 0.995 - 2) & (f < hz * 1.005 + 2)
        if s.any():
            tot += float(mag[s].max())
    return tot


print("\n  -- the new packs are IN TUNE at the key you press (a wrong "
      "pitch_keycenter is silent to every other check) --")

for pid, keys in NEW_PITCHED:
    if not have(pid):
        skip(f"{pid}: pitch", "not installed")
        continue
    ratios, errs = [], []
    for midi in keys:
        m = m_mono(pid, midi, vel=100, dur=SR // 2)
        want = 440.0 * 2 ** ((midi - 69) / 12)
        r = m_comb(m, want) / max(m_comb(m, want * 2 ** (1 / 12)),
                                  m_comb(m, want * 2 ** (-1 / 12)), 1e-30)
        ratios.append(r)
        if r < 3.0:
            errs.append(f"midi {midi}: comb ratio {r:.1f}")
    ok(f"{pid}: every probed key's harmonic comb beats a semitone either side "
       f"(worst {min(ratios):.1f}x)", not errs, "; ".join(errs))
    y = I.note_voice(pid, keys[len(keys) // 2], SR // 2, 100, SR, 3)
    ok(f"{pid}: ...and it is stereo, non-silent and float32-exact",
       y.shape[0] == 2 and float(np.max(np.abs(y))) > 1e-3
       and np.array_equal(y, np.asarray(y, dtype=np.float32).astype(np.float64)))


# === THE KEYCENTER A REGION DOES NOT DECLARE (2026-09-21) =================
#
# instruments.py used to fall back to the note being PLAYED, so a region with
# no pitch_keycenter sounded its sample UNTRANSPOSED at every key it covers.
# The sfz format's default is 60; ours was not the format's, and it was wrong
# in a way nothing here could see -- the section above probes growlybass at
# 60, which IS that region's keycenter, so the one key it looked at was the
# one key that was right.
#
# Measured on the pre-change tree over all twenty installed mappings: 302 of
# 9,248 regions declare no keycenter and every one spans more than one key.
# They are NOT one mistake. meatbass and growlybass (286 of them) all point
# at a sample named c4_* and mean the format's 60; epianos/Pianet T (16) name
# their samples 29_F1_release, 33_A1_release ... and mean THOSE, so a blanket
# 60 would pitch an F1 sample down 31 semitones. Both cases are proven below.

print("\n  -- a region that declares NO keycenter is tuned from its SAMPLE'S "
      "NAME, not from the key you pressed --")

# What the packs on this box actually ship, plus the names that must be
# REFUSED: two note tokens is ambiguous, and a drum name is not a pitch.
for _name, _want in [
        (r"sustain\c4_pp_rr1.wav", 60),            # growlybass
        (r"..\Samples\arco\c4_vl3_up.wav", 60),    # meatbass, a relative path
        ("a0_vl1_down.wav", 21), ("eb1_vl1_down.wav", 27),
        ("gb2_vl1_up.wav", 42),                    # the pack declares 42 for it
        ("29_F1_release.flac", 29), ("37_C#2_release.flac", 37),
        ("52_E3_P.flac", 52), ("bb2.wav", 46), ("B2.WAV", 47),
        ("cs2_x.wav", 37), ("c-1.wav", 0),
        ("kick_1.wav", None), ("snare.wav", None), ("Tom1_4.wav", None),
        ("hat_closed_3.wav", None),
        ("e2_f2.wav", None),                       # two notes: ambiguous
        ("abc4.wav", None)]:                       # not a note name at all
    _got = I._sample_note(_name)
    ok(f"a sample called {_name!r} names midi {_want}", _got == _want, f"got {_got}")

print("\n  -- ...and the OCTAVE that name is in is measured against the file's "
      "own declared regions, never assumed --")

for _pid, _want in (("growlybass", 0), ("meatbass_pizz", 0), ("meatbass_arco", 0),
                    ("epiano_pianet", 0), ("eguitar_clean", 0), ("harp", 0),
                    ("vsco2_strings", 12), ("vsco2_marimba", 12),
                    ("vsco2_strings_pizz", 12)):
    if not have(_pid):
        skip(f"{_pid}: octave convention", "not installed")
        continue
    _path = os.path.join(I.default_instruments_dir(),
                         *MAN["patches"][_pid]["file"].split("/"))
    _off, _votes, _agree, _cal = I._sfz_name_offset(_path)
    ok(f"{_pid}: its sample names sit {_off:+d} semitones from the sfz note "
       f"convention, on {_agree} of {_votes} unanimous votes",
       _off == _want and _cal and _agree == _votes and _votes >= 8,
       f"offset {_off} {_agree}/{_votes} calibrated={_cal}")
ok("...so the VSCO2 packs are NOT read on c4 = 60 like the other sixteen, "
   "which is the whole reason the convention is measured per file",
   all(I._sfz_name_offset(os.path.join(I.default_instruments_dir(),
                                       *MAN["patches"][p]["file"].split("/")))[0] == 12
       for p in ("vsco2_strings", "vsco2_marimba", "vsco2_strings_pizz") if have(p)))

print("\n  -- a file name is only believed when something CORROBORATES it --")


def _write_fixture(td, declared, cases):
    """A .sfz plus the one-cycle wavs it names. `declared` are (name, keycenter)
    regions on their own single key -- what the octave calibration votes on --
    and `cases` are (name, lokey, hikey) regions that declare nothing."""
    import soundfile as _sf
    lines = [f"<region> sample={_n} lokey={_kc} hikey={_kc} pitch_keycenter={_kc}"
             for _n, _kc in declared]
    lines += [f"<region> sample={_n} lokey={_lo} hikey={_hi}" for _n, _lo, _hi in cases]
    path = os.path.join(td, "fixture.sfz")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    t = np.arange(SR) / SR
    for _n in sorted({n for n, _ in declared} | {n for n, _, _ in cases}):
        _sf.write(os.path.join(td, _n), np.sin(2 * np.pi * 220.0 * t), SR, subtype="FLOAT")
    return path


# Eight declared regions down at C1-C2, so they calibrate the octave without
# overlapping any of the cases; the four undeclared ones are the branches.
_DECL = [("c1.wav", 24), ("d1.wav", 26), ("e1.wav", 28), ("f1.wav", 29),
         ("g1.wav", 31), ("a1.wav", 33), ("b1.wav", 35), ("c2.wav", 36)]

with tempfile.TemporaryDirectory() as _td:
    _cases = [("e4.wav", 62, 66),      # 64 is INSIDE  -> filename
              ("c4.wav", 51, 53),      # 60 is outside -> filename+default
              ("kick.wav", 55, 65),    # no note name  -> default (60 inside)
              ("a4.wav", 47, 50)]      # 69 outside, 60 outside -> unresolved
    _fx = _write_fixture(_td, _DECL, _cases)
    _got = {}
    for _r in I.parse_sfz(_fx)[0]:
        if I._declared_keycenter(_r) is not None:
            continue
        _got[_r["sample"]] = I._sfz_keycenter(_r, I._sfz_key(_r["lokey"]),
                                              I._sfz_key(_r["hikey"]), _fx)
    ok("a name whose note lands INSIDE the region's own range is the keycenter "
       "(e4 over 62-66 -> 64)", _got.get("e4.wav") == (64, "filename"),
       str(_got.get("e4.wav")))
    ok("a name that agrees with the format's default is the keycenter even when "
       "the region is stretched away from it (c4 over 51-53 -> 60: the meatbass "
       "case, two independent sources naming one number)",
       _got.get("c4.wav") == (60, "filename+default"), str(_got.get("c4.wav")))
    ok("no name at all, but 60 inside the range, is the format's default "
       "(kick over 55-65 -> 60)", _got.get("kick.wav") == (60, "default"),
       str(_got.get("kick.wav")))
    ok("A NAME NOTHING CORROBORATES IS REFUSED: a4 over 47-50 names 69, outside "
       "that range, and 60 is outside it too -- so the answer is None and the "
       "old behaviour stands", _got.get("a4.wav") == (None, "unresolved"),
       str(_got.get("a4.wav")))

    # ...and an unresolved region really does render the OLD bytes, and says so.
    # 47-50 is the one region covering keys 47 and 49, so the two renders are
    # the same sample and nothing else.
    _row = {"id": "fixture", "kind": "sfz", "file": "fixture.sfz", "tail": 0.2}
    I._keycenter_unresolved.clear()
    _u1 = I._sfz_voice(_row, 47, 100, SR // 4, SR, {}, _td, np.random.default_rng(1))
    _u2 = I._sfz_voice(_row, 49, 100, SR // 4, SR, {}, _td, np.random.default_rng(1))
    ok("an UNRESOLVED region still plays untransposed at every key it covers -- "
       "byte-identical at 47 and 49, exactly what it did before this fix",
       np.array_equal(_u1, _u2) and float(np.max(np.abs(_u1))) > 1e-3)
    _warned = list(I._keycenter_unresolved.values())
    ok("...but it is no longer SILENT about it: the region is named once, with "
       "its range and its sample",
       len(_warned) == 1 and "a4.wav" in _warned[0]
       and "lokey=47 hikey=50" in _warned[0], str(_warned)[:220])
    # and a CORROBORATED region in the same file steps properly
    _c1 = I._sfz_voice(_row, 62, 100, SR // 4, SR, {}, _td, np.random.default_rng(1))
    _c2 = I._sfz_voice(_row, 64, 100, SR // 4, SR, {}, _td, np.random.default_rng(1))
    ok("...while the corroborated region next to it does NOT play untransposed: "
       "62 and 64 differ, and 64 (its keycenter) is the sample at rate",
       not np.array_equal(_c1, _c2))

_HI_DECL = [(_n, _kc + 12) for _n, _kc in _DECL]
with tempfile.TemporaryDirectory() as _td2:
    _fx2 = _write_fixture(_td2, _HI_DECL, [("c4.wav", 70, 74)])
    ok("a mapping whose sample names sit an octave BELOW its keycenters "
       "calibrates to +12 off its own regions, so its undeclared c4 region "
       "resolves to 72 and not to 60",
       I._sfz_name_offset(_fx2)[0] == 12 and I._sfz_name_offset(_fx2)[3] is True
       and I._sfz_keycenter({"sample": "c4.wav"}, 70, 74, _fx2) == (72, "filename"),
       str(I._sfz_name_offset(_fx2)))
with tempfile.TemporaryDirectory() as _td3:
    _fx3 = _write_fixture(_td3, _HI_DECL[:4], [("c4.wav", 70, 74)])
    ok("...but FOUR votes is not a measurement: the offset falls back to 0, and "
       "because the octave is then unmeasured the c4 name is NOT allowed to "
       "borrow the format's default either -- 'the name says 60' and 'the "
       "format says 60' would be one opinion counted twice",
       I._sfz_name_offset(_fx3)[0] == 0 and I._sfz_name_offset(_fx3)[3] is False
       and I._sfz_keycenter({"sample": "c4.wav"}, 70, 74, _fx3)[1] == "unresolved",
       str(I._sfz_name_offset(_fx3)) + " " +
       str(I._sfz_keycenter({"sample": "c4.wav"}, 70, 74, _fx3)))

print("\n  -- the AUDIT counts every region, and probe_extra carries it --")

_audit = I.keycenter_audit()
_tot = _audit["totals"]
ok(f"all {sum(_tot.values())} regions across the installed mappings are "
   f"accounted for and NONE is unresolved (declared {_tot['declared']}, "
   f"filename {_tot['filename']}, filename+default {_tot['filename+default']}, "
   f"default {_tot['default']})",
   _tot["unresolved"] == 0 and sum(_tot.values()) > 0, json.dumps(_tot))
ok("a mapping whose regions ALL declare is left out entirely, so an entry "
   "appearing here IS the finding",
   all(sum(e["sources"].values()) != e["sources"]["declared"]
       for e in _audit["patches"].values() if "sources" in e),
   str(sorted(_audit["patches"])))
ok("probe_extra reports it, so the fact reaches a caller without anybody "
   "remembering to ask", I.probe_extra().get("sfz_keycenters") == _audit)

if have("epiano_pianet"):
    _pp = os.path.join(I.default_instruments_dir(),
                       *MAN["patches"]["epiano_pianet"]["file"].split("/"))
    _res = [I._sfz_keycenter(_r, I._sfz_key(_r["lokey"]), I._sfz_key(_r["hikey"]), _pp)
            for _r in I.parse_sfz(_pp)[0] if I._declared_keycenter(_r) is None]
    ok(f"Pianet T's {len(_res)} keycenter-less regions resolve to their OWN "
       f"sample's pitch ({', '.join(str(k) for k, _ in _res[:5])} ...) and "
       f"never to 60 -- a blanket default would have pitched its F1 release "
       f"sample down 31 semitones",
       len(_res) == 16 and all(s == "filename" for _, s in _res)
       and [k for k, _ in _res][:5] == [29, 33, 37, 41, 45]
       and not any(k == 60 for k, _ in _res), str(_res[:6]))

print("\n  -- AND IN AUDIO: inside one region every key is the same sample "
      "resampled, so the pitches must step exactly --")


def _logshift(y_ref, y, lo_hz=50.0, hi_hz=8000.0, per_semi=20):
    """How far `y` sits above `y_ref` on a LOG-FREQUENCY axis, in semitones.

    Two renders from one region are the same sample read at different rates,
    so their spectra are translates of one another on a log axis and the
    translation IS the answer -- no pitch tracker, no assumption about which
    partial is the fundamental. That matters here: the meatbass pizz sample
    has a body thump under 80 Hz that sends an autocorrelation tracker to
    1627 Hz, and growlybass sounds an octave below the key you press (it is a
    bass). Neither can confuse a translation."""
    def _grid(y_):
        m = (y_[0] + y_[1]) * 0.5
        seg = m[int(0.05 * SR):int(0.45 * SR)]
        seg = seg - seg.mean()
        sp = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), 1 << 17))
        fr = np.fft.rfftfreq(1 << 17, 1.0 / SR)
        g = lo_hz * 2 ** (np.arange(int(12 * np.log2(hi_hz / lo_hz) * per_semi))
                          / (12.0 * per_semi))
        v = np.log10(np.interp(g, fr, sp) + 1e-9)
        return v - v.mean()
    a, b = _grid(y_ref), _grid(y)
    ca = np.correlate(b, a, mode="full")
    lags = np.arange(-len(a) + 1, len(a))
    sel = np.abs(lags) <= 14 * per_semi
    seg, lseg = ca[sel], lags[sel]
    k = int(np.argmax(seg))
    d = 0.0
    if 0 < k < len(seg) - 1:
        den = seg[k - 1] - 2 * seg[k] + seg[k + 1]
        if den:
            d = max(-0.5, min(0.5, float(0.5 * (seg[k - 1] - seg[k + 1]) / den)))
    return (lseg[k] + d) / per_semi


# Each run is ONE keycenter-less region and the keys it covers:
#   growlybass_clean.sfz  lokey=59 hikey=61  sustain/c4_*.wav
#   04_pizz.sfz           lokey=59 hikey=65  ../Samples/pizz/c4_*.wav
#   02_arco_3vel.sfz      lokey=59 hikey=61  ../Samples/arco_looped/c4_*.wav
for _pid, _keys, _dur in (("growlybass", [59, 60, 61], SR),
                          ("meatbass_pizz", [59, 60, 61, 62, 63, 64, 65], int(0.8 * SR)),
                          ("meatbass_arco", [59, 60, 61], SR)):
    if not have(_pid):
        skip(f"{_pid}: region step", "not installed")
        continue
    _ref = I.note_voice(_pid, _keys[0], _dur, 100, SR, 12345)
    _errs, _worst = [], 0.0
    for _k in _keys[1:]:
        _sh = _logshift(_ref, I.note_voice(_pid, _k, _dur, 100, SR, 12345))
        _cents = (_sh - (_k - _keys[0])) * 100.0
        _worst = max(_worst, abs(_cents))
        if abs(_cents) > 12.0:
            _errs.append(f"key {_k}: {_sh:+.3f} semitones, wanted {_k - _keys[0]:+d}")
    ok(f"{_pid}: keys {_keys[0]}-{_keys[-1]} are one region and one sample, and "
       f"they step by exactly a semitone each (worst {_worst:.1f} cents). Before "
       f"this fix every one of them read 0.000 -- "
       f"{(_keys[-1] - _keys[0]) * 100} cents out at the top",
       not _errs, "; ".join(_errs))

print("\n  -- ...and NOTHING that was already right has moved --")

# Recorded by rendering this exact battery on the PRE-change tree, with the
# untransposed fallback still in place (instruments_test 504/0). Every third
# key from 24 to 96 on all twenty installed mappings, MINUS the keys the three
# reachable keycenter-less regions cover -- those are the renders that are
# supposed to move, and they are measured a few lines up. Keys outside a
# pack's mapped range render silence and are kept in the hash on purpose: a
# key that stopped sounding flips the line just as loudly as one that changed
# pitch. epiano_pianet is in this list on purpose too: its sixteen
# keycenter-less regions are all trigger=release, which _sfz_voice never
# selects, so the pack's AUDIO is untouched even though the audit above
# resolves every one of them.
#
# WHAT IT CATCHES, measured by breaking things on purpose. An off-by-one
# semitone in _sfz_voice moves all twenty lines (and ten of the harmonic-comb
# checks above), so the battery reaches. Letting a file name OVERRIDE a
# declared keycenter -- which re-resolves 3,742 of the 9,248 regions -- moves
# exactly one, vsco2_glock, and that is not the battery being thin: in
# nineteen of the twenty mappings the file names already agree with the
# keycenters the pack declares, so overriding one with the other is a no-op
# in audio. vsco2_glock is the exception because it has only six declared
# regions with a readable name, which is under _sfz_name_offset's floor of
# eight, so its +12 convention never calibrates and the name reads an octave
# low. The check that catches that break loudly is the AUDIT above (declared
# 8,946 -> 1,120), not these bytes -- which is the point of having both.
PIN_SFZ_UNMOVED = {
    "avl_black_pearl": "1c522b5278d43a5af0726c7e97c500441031a8de",       # 25 keys, 10 of them sound
    "avl_red_zeppelin": "14004f1e9b353688a659641d30a7cd9ca5e46a49",      # 25 keys, 10 of them sound
    "eguitar_clean": "204b98bbeabd880f3e8a768818996cae0d9f485c",         # 25 keys, 17 of them sound
    "eguitar_jazz": "8e1abc10c1a23140c5be07182f2ff7ee14104884",          # 25 keys, 17 of them sound
    "epiano_cp80": "b36c099cb222037751ed73a5b7e04119c7c71298",           # 25 keys, 25 of them sound
    "epiano_pianet": "90ddbf670fa1d468a5b6eac38250dcb5f8549043",         # 25 keys, 20 of them sound
    "epiano_wurlitzer": "56114651759b036e354e88afa50e095dea0abd66",      # 25 keys, 22 of them sound
    "growlybass": "eb021157a92bd964bfa09105abb9f9f8a7bc8804",            # 24 keys, 17 of them sound
    "harp": "80f2e14fb0bc9e75562f3e697ead262aba763898",                  # 25 keys, 23 of them sound
    "meatbass_arco": "9847d0fcf7ed1b5b998ed89696e6b9a3695dd4d2",         # 24 keys, 16 of them sound
    "meatbass_pizz": "0962b9a312502ac49c3bb0dd6bd26bad2f5dbcf5",         # 23 keys, 15 of them sound
    "muldjord": "17681e3b722ae7366c171104deef28ca98a8f8ba",              # 25 keys, 11 of them sound
    "organ_drawbar": "b0506d6da0217b186fd49df0e319e584b7a7c02d",         # 25 keys, 22 of them sound
    "organ_percussive": "872abcfb3be9d18a36f29378f07f44a42e4e5ddb",      # 25 keys, 22 of them sound
    "organ_rock": "b25da952b75728e4e5a0d4a35ac0f6078879eca0",            # 25 keys, 22 of them sound
    "vsco2_flute": "32aa2d0632b4d09a8d05d36ac5f32d0a0d29eaf5",           # 25 keys, 25 of them sound
    "vsco2_glock": "7adec43fe8848bc8bff878a021a0a51058567303",           # 25 keys, 25 of them sound
    "vsco2_marimba": "ee114ea00ade1ea4322a74e6730572a3aba5bcb4",         # 25 keys, 25 of them sound
    "vsco2_strings": "450ec17c63fafdc4b4310fe3986f6c40325b5587",         # 25 keys, 25 of them sound
    "vsco2_strings_pizz": "efd6b1943ce3b51b99b82658101048b7ce275512",    # 25 keys, 25 of them sound
}
PIN_SFZ_SKIP = {"growlybass": set(range(59, 62)),        # lokey=59 hikey=61
                "meatbass_arco": set(range(59, 62)),     # lokey=59 hikey=61
                "meatbass_pizz": set(range(59, 66))}     # lokey=59 hikey=65
for _pid in sorted(PIN_SFZ_UNMOVED):
    if not have(_pid):
        skip(f"{_pid}: pre-change pin", "not installed")
        continue
    _keys = [_k for _k in range(24, 97, 3) if _k not in PIN_SFZ_SKIP.get(_pid, ())]
    _h = _hl.sha1()
    for _k in _keys:
        _h.update(np.ascontiguousarray(
            I.note_voice(_pid, _k, SR // 4, 100, SR, 1), dtype=np.float32).tobytes())
    ok(f"{_pid}: {len(_keys)} keys across its whole range, none of them inside a "
       f"keycenter-less region, still render the pre-change sha1 "
       f"{PIN_SFZ_UNMOVED[_pid][:12]}",
       _h.hexdigest() == PIN_SFZ_UNMOVED[_pid], _h.hexdigest())

# THE CACHE. This change alters rendered audio while every .sfz byte on disk
# stays the same, so the pack fingerprint in _cache_key is unchanged and
# nothing else in that key stands for this module's own source. The manifest
# rev is the only term that does -- bump it or every note already on disk
# replays the untransposed render forever.
ok("patches.json's rev was bumped past the 1 that cached the untransposed "
   "renders", MAN.get("rev") >= 2, str(MAN.get("rev")))
_ik = I.default_instruments_dir()
_k_now = I._cache_key("growlybass", 60, 100, SR, SR, 1, None, _ik)
_saved_rev = I._manifest["rev"]
try:
    I._manifest["rev"] = 1
    _k_old = I._cache_key("growlybass", 60, 100, SR, SR, 1, None, _ik)
finally:
    I._manifest["rev"] = _saved_rev
ok("...and the rev really is in the cache key, so every note cached under "
   "rev 1 is unreachable rather than stale", _k_now != _k_old,
   f"{_k_old[:12]} vs {_k_now[:12]}")

# === end THE KEYCENTER ====================================================

print("\n  -- ROUND ROBINS VARY AGAIN (the note cache used to freeze them) --")

rr_patches = [p for p, r in MAN["patches"].items()
              if r["kind"] == "sfz" and have(p)
              and I._sfz_randomises(os.path.join(I.default_instruments_dir(),
                                                 *r["file"].split("/")))]
flat = [p for p, r in MAN["patches"].items()
        if r["kind"] == "sfz" and have(p) and p not in rr_patches]
if not rr_patches:
    skip("round robin", "no randomising sfz pack is installed")
ok(f"the parser finds the randomising mappings by itself ({len(rr_patches)} of "
   f"{len(rr_patches) + len(flat)} installed sfz patches)", bool(rr_patches))
for pid in rr_patches:
    row = I.patch_row(pid)
    midi = 38 if row["family"] == "drums" else 52
    outs = {I.note_voice(pid, midi, SR // 4, 100, SR, s).tobytes()
            for s in (1, 2, 3, 4, 5, 6, 7, 8)}
    ok(f"{pid}: eight notes at the same pitch and velocity are NOT all the same "
       f"sample ({len(outs)} distinct of 8)", len(outs) > 1)
    ok(f"{pid}: ...and the SAME seed still replays byte-identically",
       np.array_equal(I.note_voice(pid, midi, SR // 4, 100, SR, 5),
                      I.note_voice(pid, midi, SR // 4, 100, SR, 5)))
for pid in flat:
    row = I.patch_row(pid)
    midi = 38 if row["family"] == "drums" else 60
    ok(f"{pid}: has no round robins, so the seed stays OUT of its cache key",
       np.array_equal(I.note_voice(pid, midi, SR // 4, 100, SR, 1),
                      I.note_voice(pid, midi, SR // 4, 100, SR, 2)))
if have("salamander"):
    ok("an SF2 patch keeps the seed out of its key too -- a cache miss there "
       "costs a 0.9 s soundfont load, which is why this is not unconditional",
       np.array_equal(I.note_voice("salamander", 60, SR // 4, 100, SR, 1),
                      I.note_voice("salamander", 60, SR // 4, 100, SR, 2)))

print("\n  -- key_map: a pack on its own keys, played on GM ones --")

if not have("muldjord"):
    skip("muldjord key_map", "not installed")
else:
    km = I.patch_row("muldjord")["key_map"]
    ok("the row declares a key map onto the GM drum keys",
       km.get("36") == 48 and km.get("38") == 50 and km.get("42") == 52
       and km.get("46") == 53 and km.get("49") == 58)
    silent = [g for g in (35, 36, 38, 40, 41, 42, 43, 45, 46, 47, 48, 49, 50,
                          51, 52, 53, 55, 57, 59)
              if float(np.max(np.abs(I.note_voice("muldjord", g, SR // 4, 100, SR, 1)))) < 1e-3]
    ok("every GM drum key the map names makes a sound -- WITHOUT the map they "
       "would all be silent, because this kit starts at key 48", not silent,
       f"silent GM keys: {silent}")
    raw = dict(I.patch_row("muldjord"))
    raw.pop("key_map")
    raw["id"] = "muldjord"
    d = I.default_instruments_dir()
    a = I._sfz_voice(raw, 48, 100, SR // 4, SR, {}, d, np.random.default_rng(11))
    b = I._sfz_voice(dict(I.patch_row("muldjord"), id="muldjord"), 36, 100,
                     SR // 4, SR, {}, d, np.random.default_rng(11))
    ok("GM 36 really is the pack's own key 48, sample for sample",
       np.array_equal(a, b))
    kick = m_mono("muldjord", 36, vel=100)
    snare = m_mono("muldjord", 38, vel=100)
    hat = m_mono("muldjord", 42, vel=100)
    def _cen(m):
        seg = m[:SR // 4]
        mag = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
        f = np.fft.rfftfreq(len(seg), 1 / SR)
        return float((f * mag).sum() / max(mag.sum(), 1e-12))
    ok(f"...and the GM keys land on the right DRUMS: kick {_cen(kick):.0f} Hz < "
       f"snare {_cen(snare):.0f} Hz < hat {_cen(hat):.0f} Hz",
       _cen(kick) < _cen(snare) < _cen(hat))
    ok("a key the map does not name passes through to the pack's own layout",
       float(np.max(np.abs(I.note_voice("muldjord", 61, SR // 4, 100, SR, 1)))) > 1e-3)

print("\n  -- the two consumptions of the contract: stereo is the voice, mono is its mean --")
_st = I.synth_note_stereo("bigroom_lead", 65, SR // 4, 110, SR, 1, {"spread": 0.8})
_vo = I.note_voice("bigroom_lead", 65, SR // 4, 110, SR, 1, {"spread": 0.8})
_mo = I.synth_note_mono("bigroom_lead", 65, SR // 4, 110, SR, 1, {"spread": 0.8})
ok("synth_note_stereo returns the voice's own (2, N) bytes",
   _st.shape == _vo.shape and _st.ndim == 2 and np.array_equal(_st, _vo))
ok("...whose channels differ (the width the rack used to fold away)",
   not np.array_equal(_st[0], _st[1]))
ok("synth_note_mono is exactly (L+R)/2 of it", np.array_equal(_mo, (_st[0] + _st[1]) * 0.5))

print("\n  -- the CC-BY packs carry the credit line their licence asks for --")

for pack_id, who in (("epianos", "Greg Sullivan"), ("muldjord", "Lars Muldjord"),
                     ("salamander", "Alexander Holm"), ("avl_drums", "Glen MacArthur")):
    pk = MAN["packs"].get(pack_id) or {}
    ok(f"{pack_id}: attribution REQUIRED and its text names the author ({who})",
       pk.get("attribution_required") is True and who in (pk.get("attribution") or ""),
       str(pk.get("attribution"))[:120])
cc0_but_credited = [p for p, pk in MAN["packs"].items()
                    if not pk.get("attribution_required") and not pk.get("attribution")
                    and p != "fluidsynth"]
ok("...and every CC0 pack still carries a credit line, because a dedication "
   "waives the requirement and not the courtesy", not cc0_but_credited,
   str(cc0_but_credited))
# === end NEW SAMPLED PACKS ============================================



print(f"\n  {passed} passed, {len(failures)} failed, {len(skipped)} skipped\n")
if skipped:
    print("  skipped:\n   " + "\n   ".join(skipped) + "\n")
if failures:
    print("  failed:\n   " + "\n   ".join(failures) + "\n")
    sys.exit(1)
