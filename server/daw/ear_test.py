"""THE EAR — the objective critic against SYNTHESISED GROUND TRUTH.

Every assertion here is arithmetic. The signals are built to have a known
answer — a track that is exactly 6 dB quieter than its twin, a pad that is
exactly 12 dB over the vocal in exactly one band for exactly eight bars, a
bounce with a known number of pinned samples, a mono-summed stereo file whose
side energy is exactly zero — so a critic that drifts fails here rather than
in someone's ears six weeks later.

Why ground truth and not fixtures: a mix critic that is merely SELF-CONSISTENT
is worthless. "The pad masks the vocal at 200-400 Hz in bars 9-16" has to be
TRUE, and the only way to know is to build the mix where it is true and where
the bars and the band are known before the critic looks.

  <rig-python> server/daw/ear_test.py
"""
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ear  # noqa: E402

SR = 48000
PASS = 0
FAILS = []


def ok(label, cond, detail=""):
    global PASS
    if cond:
        PASS += 1
        print(f"  ok    {label}")
    else:
        FAILS.append(label)
        print(f"  FAIL  {label}" + (f"\n          {detail}" if detail else ""))


def near(a, b, eps):
    return a is not None and b is not None and abs(a - b) <= eps


# ───────────────────────────────────────────────────────── signal builders

def band_noise(n, lo, hi, sr=SR, seed=1, amp=1.0):
    """White noise with everything outside [lo, hi) removed. Deterministic."""
    rng = np.random.default_rng(seed)
    x = rng.standard_normal(n)
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(n, 1.0 / sr)
    X[(f < lo) | (f >= hi)] = 0.0
    y = np.fft.irfft(X, n=n)
    p = float(np.sqrt(np.mean(y ** 2)))
    return (y / p * amp) if p > 0 else y


def pink_noise(n, sr=SR, seed=7, amp=0.1):
    rng = np.random.default_rng(seed)
    X = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1.0 / sr)
    shape = np.zeros_like(f)
    nz = f > 0
    shape[nz] = 1.0 / np.sqrt(f[nz])
    y = np.fft.irfft(X * shape, n=n)
    p = float(np.sqrt(np.mean(y ** 2)))
    return y / p * amp


def sine(n, hz, amp=0.1, sr=SR):
    t = np.arange(n) / sr
    return amp * np.sin(2 * np.pi * hz * t)


def stereo(mono):
    return np.vstack([mono, mono])


def bars_map(n_bars, sec_per_bar=1.0):
    return [{"bar": i + 1, "t0": i * sec_per_bar, "t1": (i + 1) * sec_per_bar}
            for i in range(n_bars)]


# ══════════════════════════════════════════════════════════════════════════
print("\n  -- loudness reuses rack.py's BS.1770-4, and reads the right number --")

N = SR * 6
s = stereo(sine(N, 1000.0, amp=0.1))
L = ear.loudness(s, SR)
# A 1 kHz sine at -20 dBFS in BOTH channels: the K-weighting is ~unity at
# 1 kHz and the channel sum is 2x, so the standard's answer is about -20 LUFS.
ok("a -20 dBFS 1 kHz stereo sine reads about -20 LUFS",
   near(L["lufs"], -20.0, 1.5), f"got {L['lufs']}")
ok("peak of that sine is -20 dBFS", near(L["peak_db"], -20.0, 0.2), f"got {L['peak_db']}")
ok("crest of a sine is ~3 dB", near(L["crest_db"], 3.01, 0.3), f"got {L['crest_db']}")
ok("true peak of a sine is at or above its sample peak",
   L["true_peak_db"] >= L["peak_db"] - 0.05, f"{L['true_peak_db']} vs {L['peak_db']}")

# ── THE -6 dB TRACK ───────────────────────────────────────────────────────
loud = stereo(band_noise(N, 200, 2000, seed=3, amp=0.1))
quiet = loud * (10.0 ** (-6.0 / 20.0))
dl = ear.loudness(loud, SR, short=False)["lufs"]
dq = ear.loudness(quiet, SR, short=False)["lufs"]
ok("a track rendered 6 dB down measures exactly 6.0 dB down",
   near(dl - dq, 6.0, 0.15), f"{dl} vs {dq} -> {round(dl - dq, 3)} dB")

# and the FINDING says so, when the role is known
meas, finds = ear.analyse_buses(
    loud + quiet, {"t_loud": loud, "t_quiet": quiet}, SR,
    {"bars": bars_map(6), "tracks": {
        "t_loud": {"name": "gtr", "role": "guitar"},
        "t_quiet": {"name": "vox", "role": "lead",
                    "target_lufs": round(dq + 6.0, 2)}}})
lvl = [f for f in finds if f["metric"] == "level" and f["target"] == "t_quiet"]
ok("the too-quiet track produces a `level` finding naming the track",
   len(lvl) == 1 and lvl[0]["track_name"] == "vox", str([f["id"] for f in finds]))
ok("the level finding measures the gap as ~6 dB and asks for ~+6 dB",
   lvl and near(lvl[0]["delta_db"], 6.0, 0.4), str(lvl[:1]))
ok("a track with NO role and no target gets measured but NOT judged",
   not [f for f in ear.analyse_buses(loud, {"t_x": loud}, SR,
                                     {"bars": bars_map(6),
                                      "tracks": {"t_x": {"name": "x"}}})[1]
        if f["metric"] == "level"])

# ══════════════════════════════════════════════════════════════════════════
print("\n  -- a deliberately masked mix is caught in the RIGHT band and bars --")

BARS = 16
SEC = 1.0
n = int(SR * BARS * SEC)
# The vocal: half its energy at 300 Hz (the 250-500 band), half at 1.5 kHz,
# present the whole song.
voc = (band_noise(n, 260, 480, seed=11, amp=0.05)
       + band_noise(n, 1100, 1900, seed=12, amp=0.05))
# The pad: the SAME 250-500 band, 12 dB louder, and ONLY in bars 9-16.
pad = band_noise(n, 260, 480, seed=13, amp=0.05 * 10 ** (12 / 20))
gate = np.zeros(n)
gate[int(8 * SEC * SR):] = 1.0
pad = pad * gate

bars = bars_map(BARS, SEC)
mix = stereo(voc + pad)
meas, finds = ear.analyse_buses(
    mix, {"voc": stereo(voc), "pad": stereo(pad)}, SR,
    {"bars": bars, "tracks": {"voc": {"name": "vocal"}, "pad": {"name": "pad"}}})

mk = [e for e in meas["masking"] if e["masker"] == "pad" and e["maskee"] == "voc"]
ok("masking is detected at all", len(mk) >= 1, str(meas["masking"][:2]))
b3 = [e for e in mk if e["band_index"] == 3]
ok("it names the 250-500 Hz band (where the collision actually is)",
   len(b3) == 1, str([(e['band'], e['from_bar'], e['to_bar']) for e in mk]))
if b3:
    e = b3[0]
    ok("it names bars 9-16", e["from_bar"] == 9 and e["to_bar"] == 16,
       f"{e['from_bar']}-{e['to_bar']}")
    ok("it measures the collision as ~12 dB", near(e["margin_db"], 12.0, 1.5),
       str(e["margin_db"]))
ok("it does NOT claim masking in the 1-2 kHz band, where the pad is silent",
   not [e for e in mk if e["band_index"] in (5,)],
   str([e["band"] for e in mk]))
# The activity gate, tested where it actually bites: the pad ENTERS at bar 9,
# so the analysis window straddling the boundary leaves a sliver of pad in bar
# 8, ~16 dB under its own playing level. Without the gate the critic reports
# "the vocal masks the pad in bar 8", which is nonsense — the pad is not
# playing yet. This assertion is the regression pin for that class.
ok("it does NOT claim the vocal masks the pad in the bar before the pad enters",
   not [e for e in meas["masking"] if e["masker"] == "voc" and e["maskee"] == "pad"],
   str([(e["masker"], e["maskee"], e["from_bar"], e["to_bar"], e["margin_db"])
        for e in meas["masking"]]))
ok("the activity gate is what does it (turning it off restores the false positive)",
   [e for e in ear.masking_events(
       {"voc": ear.bar_band_levels(stereo(voc), SR, bars),
        "pad": ear.bar_band_levels(stereo(pad), SR, bars)},
       bars, activity_db=200.0)
    if e["masker"] == "voc" and e["maskee"] == "pad"])

mf = [f for f in finds if f["metric"] == "masking"]
ok("the masking FINDING carries what/where/how-much/severity",
   mf and all(k in mf[0] and mf[0][k] for k in ("what", "where", "how_much", "severity")),
   str(mf[:1]))
ok("the masking finding names the masker as its edit target and the maskee as `against`",
   mf and mf[0]["target"] == "pad" and mf[0]["against"] == "voc", str(mf[:1]))

# the control: the same two tracks with the pad OFF everywhere
_, clean = ear.analyse_buses(
    stereo(voc), {"voc": stereo(voc), "pad": stereo(np.zeros(n))}, SR,
    {"bars": bars, "tracks": {"voc": {"name": "vocal"}, "pad": {"name": "pad"}}})
ok("a silent pad produces NO masking finding",
   not [f for f in clean if f["metric"] == "masking"],
   str([f["id"] for f in clean if f["metric"] == "masking"]))

# ══════════════════════════════════════════════════════════════════════════
print("\n  -- a clipped bounce is caught --")

hot = stereo(np.clip(sine(SR * 3, 220.0, amp=1.4), -1.0, 1.0))
c = ear.dc_and_clipping(hot, SR)
ok("clipped samples are counted", c["clipped_samples"] > 1000, str(c["clipped_samples"]))
ok("the flat top is measured as a long run", c["longest_run"] > 50, str(c["longest_run"]))
ok("the first clip is time-stamped", c["first_clip_sec"] is not None)
_, hf = ear.analyse_buses(hot, {}, SR, {"bars": bars_map(3)})
ok("a `clipping` finding is raised at high severity",
   [f for f in hf if f["metric"] == "clipping" and f["severity"] == "high"],
   str([f["id"] for f in hf]))
ok("the same signal at -6 dB raises NO clipping finding",
   not [f for f in ear.analyse_buses(hot * 0.5, {}, SR, {"bars": bars_map(3)})[1]
        if f["metric"] == "clipping"])

quietsig = stereo(sine(SR * 2, 220.0, amp=0.2))
ok("a clean signal reports zero clipped samples",
   ear.dc_and_clipping(quietsig, SR)["clipped_samples"] == 0)

# true peak over the ceiling
tp = stereo(sine(SR * 2, 5000.0, amp=0.999))
_, tf = ear.analyse_buses(tp, {}, SR, {"bars": bars_map(2)})
ok("a full-scale master raises a `true_peak` finding",
   [f for f in tf if f["metric"] == "true_peak"], str([f["id"] for f in tf]))

# ══════════════════════════════════════════════════════════════════════════
print("\n  -- stereo width: a mono-summed track reads exactly zero --")

m = band_noise(SR * 4, 100, 8000, seed=21, amp=0.1)
st = ear.stereo_stats(np.vstack([m, m]))
ok("identical channels -> width exactly 0.0", st["width"] == 0.0, str(st["width"]))
ok("identical channels -> correlation exactly 1.0", near(st["correlation"], 1.0, 1e-6),
   str(st["correlation"]))
ok("identical channels are mono compatible", st["mono_compatible"] is True)

wide = np.vstack([band_noise(SR * 4, 100, 8000, seed=22, amp=0.1),
                  band_noise(SR * 4, 100, 8000, seed=23, amp=0.1)])
sw = ear.stereo_stats(wide)
ok("uncorrelated channels -> width near 1.0", near(sw["width"], 1.0, 0.15), str(sw["width"]))
ok("uncorrelated channels -> correlation near 0", abs(sw["correlation"]) < 0.1,
   str(sw["correlation"]))

flipped = np.vstack([m, -m])
sf = ear.stereo_stats(flipped)
ok("an inverted channel -> correlation -1", near(sf["correlation"], -1.0, 1e-6),
   str(sf["correlation"]))
_, ff = ear.analyse_buses(flipped, {}, SR, {"bars": bars_map(4)})
ok("an inverted channel raises an out-of-phase `width` finding at high severity",
   [f for f in ff if f["metric"] == "width" and f.get("direction") == "out_of_phase"
    and f["severity"] == "high"], str([f["id"] for f in ff]))

_, mf2 = ear.analyse_buses(np.vstack([m, m]), {}, SR, {"bars": bars_map(4)})
ok("a mono master raises a `too_narrow` width finding",
   [f for f in mf2 if f["metric"] == "width" and f.get("direction") == "too_narrow"],
   str([f["id"] for f in mf2]))

# ══════════════════════════════════════════════════════════════════════════
print("\n  -- the spectral reference is pink, and pink noise sits on it --")

ref = ear.pink_reference_db()
ok("the reference is a normalised share (sums to 1.0 in power)",
   near(float(np.sum(10 ** (ref / 10.0))), 1.0, 1e-9))
pn = stereo(pink_noise(SR * 8, seed=31, amp=0.08))
sb = ear.spectral_balance(pn, SR, "neutral")
worst = max(abs(r["deviation_db"]) for r in sb["bands"][:8])   # top band is edge-limited
ok("pink noise deviates from the pink reference by under 2 dB in every band",
   worst < 2.0, str([(r["band"], r["deviation_db"]) for r in sb["bands"]]))
ok("pink noise therefore raises NO balance findings",
   not [f for f in ear.analyse_buses(pn, {}, SR, {"bars": bars_map(8)})[1]
        if f["metric"] == "balance"],
   str([f["id"] for f in ear.analyse_buses(pn, {}, SR, {"bars": bars_map(8)})[1]]))

# now bend it: +9 dB into 2-4 kHz
bent = pink_noise(SR * 8, seed=31, amp=0.08) + band_noise(SR * 8, 2000, 4000, seed=32, amp=0.09)
_, bf = ear.analyse_buses(stereo(bent), {}, SR, {"bars": bars_map(8)})
bal = [f for f in bf if f["metric"] == "balance"]
ok("a 2-4 kHz boost is caught as a balance finding in band 6",
   any(f["band_index"] == 6 and f["observed"] > 0 for f in bal),
   str([(f["band"], f["observed"]) for f in bal]))
ok("the balance finding asks for a CUT (negative delta) on a boosted band",
   all(f["delta_db"] < 0 for f in bal if f["band_index"] == 6))

# --------------------------------------------------------------------------
print("\n  -- an EMPTY band is an arrangement note, not an EQ error --")

# Content only from 250 Hz up: 20-60 and 60-120 hold nothing at all. The
# critic must not report that as "boost the sub by 23 dB" -- the A/B guard
# caught exactly that advice making a real mix measurably worse, which is how
# this rule got written.
# A hair of LF so the band is not DIGITALLY silent (a mathematically empty
# band is skipped by the -70 dB floor before this rule is even reached);
# 40 dB under the body of the mix is what "nothing is playing there"
# looks like in a real render.
midonly = stereo(band_noise(SR * 8, 250, 6000, seed=71, amp=0.1)
                 + band_noise(SR * 8, 20, 120, seed=72, amp=0.002))
sbm = ear.spectral_balance(midonly, SR, "neutral")
ok("a band 30+ dB under the loudest band is flagged ABSENT",
   sbm["bands"][0]["absent"] is True and sbm["bands"][4]["absent"] is False,
   str([(r["band"], r["level_db"], r["absent"]) for r in sbm["bands"]]))
mm, mf3 = ear.analyse_buses(midonly, {}, SR, {"bars": bars_map(8)})
absent = [f for f in mf3 if f["metric"] == "balance" and f.get("direction") == "absent"]
ok("the empty band still gets REPORTED -- the human may want to know", len(absent) >= 1)
ok("...at low severity, and marked unboostable",
   all(f["severity"] == "low" and f["boostable"] is False for f in absent))
ok("...and its wording blames the arrangement, not the mix",
   all("no part is playing" in f["what"] for f in absent), str(absent[:1]))
ok("a REAL curve error is still reported as one, and is boostable",
   all(f.get("boostable") is True for f in mf3
       if f["metric"] == "balance" and f.get("direction") != "absent"))
ok("the objective penalty EXCLUDES absent bands -- otherwise no edit can move it",
   ear.objective_score(mm, {})["parts"]["balance"]
   < sum(max(0.0, abs(r["deviation_db"]) - 3.0) for r in mm["spectral"]["bands"]),
   str(ear.objective_score(mm, {})["parts"]["balance"]))
ok("an under-reference band that HAS content names the most-over band to cut instead",
   any(f.get("most_over_band") is not None for f in mf3
       if f["metric"] == "balance" and f.get("direction") == "under"),
   str([(f["band"], f.get("direction"), f.get("most_over_band")) for f in mf3
        if f["metric"] == "balance"]))


# ══════════════════════════════════════════════════════════════════════════
print("\n  -- dynamics and DC --")

squashed = stereo(np.tanh(12.0 * pink_noise(SR * 6, seed=41, amp=0.3)) * 0.9)
_, sq = ear.analyse_buses(squashed, {}, SR, {"bars": bars_map(6)})
ok("a squashed master is caught by crest factor",
   [f for f in sq if f["metric"] == "dynamics" and f.get("direction") == "too_compressed"],
   str(ear.loudness(squashed, SR)["crest_db"]))

dc = stereo(pink_noise(SR * 4, seed=51, amp=0.05) + 0.02)
_, dcf = ear.analyse_buses(dc, {}, SR, {"bars": bars_map(4)})
ok("a 0.02 DC offset is caught", [f for f in dcf if f["metric"] == "dc"],
   str(ear.dc_and_clipping(dc, SR)["dc"]))
ok("a DC-free signal raises no dc finding",
   not [f for f in ear.analyse_buses(stereo(pink_noise(SR * 4, seed=52, amp=0.05)),
                                     {}, SR, {"bars": bars_map(4)})[1]
        if f["metric"] == "dc"])

# ══════════════════════════════════════════════════════════════════════════
print("\n  -- the objective score is the A/B guard's yardstick --")

bad = stereo(np.clip(pink_noise(SR * 6, seed=61, amp=0.9) * 3, -1, 1))
good = stereo(pink_noise(SR * 6, seed=61, amp=0.13))
mb, _ = ear.analyse_buses(bad, {}, SR, {"bars": bars_map(6)})
mg, _ = ear.analyse_buses(good, {}, SR, {"bars": bars_map(6)})
sb2 = ear.objective_score(mb, {})
sg2 = ear.objective_score(mg, {})
ok("a clipped, over-loud master scores WORSE than a clean one",
   sb2["penalty_db"] > sg2["penalty_db"],
   f"bad {sb2['penalty_db']} vs good {sg2['penalty_db']}")
ok("lower is better is declared, not assumed", sg2["lower_is_better"] is True)
ok("the score breaks down by part", set(sb2["parts"]) >= {"lufs", "true_peak", "masking"})

# ══════════════════════════════════════════════════════════════════════════
print("\n  -- findings are well formed and ordered --")

_, allf = ear.analyse_buses(
    stereo(voc + pad), {"voc": stereo(voc), "pad": stereo(pad)}, SR,
    {"bars": bars, "tracks": {"voc": {"name": "vocal"}, "pad": {"name": "pad"}}})
ok("every finding carries id/metric/what/where/how_much/severity/confidence",
   all(all(k in f for k in ("id", "metric", "what", "where", "how_much",
                            "severity", "confidence")) for f in allf))
ok("severity is one of low/medium/high",
   all(f["severity"] in ("low", "medium", "high") for f in allf))
ok("findings are sorted worst-first",
   [{"high": 0, "medium": 1, "low": 2}[f["severity"]] for f in allf]
   == sorted([{"high": 0, "medium": 1, "low": 2}[f["severity"]] for f in allf]))
ok("ids are stable across two identical analyses",
   [f["id"] for f in allf] == [f["id"] for f in ear.analyse_buses(
       stereo(voc + pad), {"voc": stereo(voc), "pad": stereo(pad)}, SR,
       {"bars": bars, "tracks": {"voc": {"name": "vocal"}, "pad": {"name": "pad"}}})[1]])

# --------------------------------------------------------------------------
print("\n  -- reading a real file back: the de-interleaving seam --")

# The bug this pins, found by comparing a bounce against the region renders it
# was assembled from: PyAV hands PLANAR formats back as (channels, N) and
# PACKED ones as (1, N*channels), and FLAC decodes packed. Taking row 0 as
# "left" gives the INTERLEAVED stream read as mono - twice as long, every
# sample duplicated - and peak and RMS come out UNCHANGED, so nothing looks
# wrong while LUFS, true peak and every band level are quietly false. The
# assertion that catches it is a file whose two channels genuinely differ.
try:
    import av  # noqa: PLC0415
    HAVE_AV = True
except ImportError:
    HAVE_AV = False

if HAVE_AV:
    import tempfile
    L = sine(SR * 2, 220.0, amp=0.5)
    R = sine(SR * 2, 660.0, amp=0.25)          # deliberately DIFFERENT channels
    src = np.vstack([L, R])
    tmpd = tempfile.mkdtemp(prefix="ear-io-")
    for ext, codec in (("flac", "flac"), ("wav", None)):
        out = os.path.join(tmpd, f"probe.{ext}")
        if codec:
            with av.open(out, "w") as cont:
                stream = cont.add_stream(codec, rate=SR)
                stream.layout = "stereo"
                inter = np.empty(src.shape[1] * 2, dtype=np.int32)
                inter[0::2] = (src[0] * 2147483647).astype(np.int32)
                inter[1::2] = (src[1] * 2147483647).astype(np.int32)
                frame = av.AudioFrame.from_ndarray(inter.reshape(1, -1), format="s32",
                                                   layout="stereo")
                frame.rate = SR
                for pkt in stream.encode(frame):
                    cont.mux(pkt)
                for pkt in stream.encode(None):
                    cont.mux(pkt)
        else:
            import struct
            data = np.empty(src.shape[1] * 2, dtype="<f4")
            data[0::2] = src[0]
            data[1::2] = src[1]
            raw = data.tobytes()
            with open(out, "wb") as f:
                f.write(b"RIFF" + struct.pack("<I", 36 + len(raw)) + b"WAVEfmt ")
                f.write(struct.pack("<IHHIIHH", 16, 3, 2, SR, SR * 8, 8, 32))
                f.write(b"data" + struct.pack("<I", len(raw)) + raw)
        y, sr2 = ear.read_audio_stereo(out, SR)
        ok(f"{ext}: the sample COUNT survives the round trip (not doubled)",
           y.shape[1] == src.shape[1], f"{y.shape[1]} vs {src.shape[1]}")
        ok(f"{ext}: the two channels stay DIFFERENT",
           not np.allclose(y[0], y[1], atol=1e-3),
           f"L rms {float(np.sqrt(np.mean(y[0]**2))):.4f} R rms {float(np.sqrt(np.mean(y[1]**2))):.4f}")
        ok(f"{ext}: the samples match the source",
           float(np.max(np.abs(y[:, :src.shape[1]] - src))) < 1e-3,
           str(float(np.max(np.abs(y[:, :src.shape[1]] - src)))))
        ok(f"{ext}: and so does the loudness the critics will read",
           near(ear.loudness(y, SR, short=False)["lufs"],
                ear.loudness(src, SR, short=False)["lufs"], 0.05))
    rate_err = None
    try:
        ear.read_audio_stereo(os.path.join(tmpd, "probe.wav"), 44100)
    except Exception as exc:                              # noqa: BLE001
        rate_err = str(exc)
    ok("a rate mismatch is an ERROR, never a silent resample",
       rate_err is not None and "resample" in rate_err, str(rate_err))
    import shutil
    shutil.rmtree(tmpd, ignore_errors=True)
else:
    print("  (PyAV absent - the non-wav decode path is not exercised here)")


# ══════════════════════════════════════════════════════════════════════════
print("\n  -- the subjective stage is honest about being absent --")

js = ear.judge_status({})
ok("judge_status names every judge, its licence and its install line",
   set(js["judges"]) == {"audiobox_aesthetics", "laion_clap"}
   and all(j["licence"] and j["install"] for j in js["judges"].values()))
ok("judge_status states what the loop degrades to", bool(js["degrades_to"]))
ok("MERT and essentia are named as REFUSED, with the reason",
   "MERT-v1-330M" in js["refused"] and "essentia" in js["refused"])
ok("essentia is never imported anywhere in ear.py",
   "import essentia" not in open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                              "ear.py"), encoding="utf-8").read())
jv = ear.judge({"path": "nonexistent.wav"})
if not js["available"]:
    ok("with no judge installed, judge() returns available:false and NO scores",
       jv["available"] is False and jv["scores"] == {}, str(jv)[:200])
else:
    ok("with a judge installed, judge() names what ran", "ran" in jv)
ok("an installer path with a SEPARATE venv is documented",
   "AIPLAY_EAR_PY" in js["installer"]["env"] and len(js["installer"]["steps"]) >= 3)

# ══════════════════════════════════════════════════════════════════════════
print("\n  -- the probe tells the truth about the critic list --")
p = ear.probe({})
ok("probe lists every critic with what it measures",
   {c["metric"] for c in p["critics"]}
   >= {"lufs", "true_peak", "clipping", "dc", "balance", "masking", "dynamics",
       "width", "level"})
ok("probe reports the bands it uses", len(p["bands"]) == len(ear.BANDS))
ok("probe carries the judge's availability verdict", "judge" in p)

print(f"\n  {PASS} passed, {len(FAILS)} failed\n")
if FAILS:
    print("  failed:\n   " + "\n   ".join(FAILS) + "\n")
    raise SystemExit(1)
