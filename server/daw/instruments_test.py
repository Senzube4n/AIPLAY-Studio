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
for name in MACHINES:
    spec = MAN["patches"][name]["params"]
    dead = []
    for knob, s in spec.items():
        lo, hi, d = float(s["min"]), float(s["max"]), float(s["default"])
        alt = hi if abs(hi - d) > abs(lo - d) else lo
        moved = False
        for midi in PROBE_KEYS[name]:
            a = I.note_voice(name, midi, SR // 4, 110, SR, 1)
            b = I.note_voice(name, midi, SR // 4, 110, SR, 1, {knob: alt})
            if not np.array_equal(a, b):
                moved = True
                break
        if not moved:
            dead.append(knob)
    ok(f"{name}: all {len(spec)} declared knobs reach the circuit", not dead,
       f"declared but inert: {dead}")
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
    ("growlybass", [33, 40, 45, 52, 60, 72]),     # A1 up: the mapped range
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
