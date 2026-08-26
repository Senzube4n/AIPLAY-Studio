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

print(f"\n  {passed} passed, {len(failures)} failed, {len(skipped)} skipped\n")
if skipped:
    print("  skipped:\n   " + "\n   ".join(skipped) + "\n")
if failures:
    print("  failed:\n   " + "\n   ".join(failures) + "\n")
    sys.exit(1)
