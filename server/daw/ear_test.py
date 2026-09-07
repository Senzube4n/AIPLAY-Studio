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

THE PER-CHANNEL SECTION is built the same way. spectral_balance measures L, R
and the mono fold now, and the two cases it exists for both have a known
answer before it looks: a magnitude-flat decorrelation (a pure delay) must
leave every band's energy in each channel untouched and comb the SUM, and a
boost on one channel only must show up on that channel and half-show in the
fold. Both are asserted against the arithmetic, and so is the thing that
makes the change safe — that `observed_db` is still the fold, band for band,
in every case, so no threshold or penalty written before it has moved.

  <rig-python> server/daw/ear_test.py
"""
import math
import os
import sys
import tempfile

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
ok("a mono master raises a `dual_mono` width finding (correlation >= 0.99)",
   [f for f in mf2 if f["metric"] == "width" and f.get("direction") == "dual_mono"],
   str([(f["id"], f.get("direction")) for f in mf2]))
ok("...and not the old `too_narrow` one beside it — one defect, one finding",
   not [f for f in mf2 if f["metric"] == "width" and f.get("direction") == "too_narrow"])

# ══════════════════════════════════════════════════════════════════════════
print("\n  -- dual mono: the defect the first 4:00 bounce shipped with --")

# The shape of that bounce: every stem L==R to the byte, the master too. Two
# stems that DIFFER from each other but are each identical left-to-right.
sA = stereo(band_noise(SR * 4, 100, 3000, seed=81, amp=0.1))
sB = stereo(band_noise(SR * 4, 2000, 9000, seed=82, amp=0.05))
dm_master = sA + sB
BARS4 = bars_map(4)
TR = {"a": {"name": "lead", "role": "lead"}, "b": {"name": "hat", "role": "drums"}}
_, dm = ear.analyse_buses(dm_master, {"a": sA, "b": sB}, SR,
                          {"bars": BARS4, "tracks": TR, "rack_stereo": False})
w = [f for f in dm if f["metric"] == "width" and f.get("direction") == "dual_mono"]
ok("a byte-identical L/R master raises the dual-mono finding", len(w) == 1,
   str([(f["metric"], f.get("direction")) for f in dm]))
if w:
    ok("...at HIGH severity when the correlation is 1.000",
       w[0]["severity"] == "high" and w[0]["observed"] >= 0.999, str(w[0]["observed"]))
    ok("...naming the RACK FOLD as the cause when the job says the switch is off",
       w[0]["cause"] == "rack_fold", w[0]["cause"])
    ok("...with both stems counted as dual mono too",
       sorted(w[0]["stems_dual_mono"]) == ["a", "b"] and w[0]["stems_measured"] == 2,
       str(w[0]["stems_dual_mono"]))
    ok("...and naming the switch the route must flip (master.stereo)",
       w[0].get("switch") == "master.stereo" and "stereo switch" in w[0]["what"],
       w[0]["what"])
# The same master with the switch ON is an ARRANGEMENT note (the parts are
# simply mono), never a claim about the rack.
_, dm_on = ear.analyse_buses(dm_master, {"a": sA, "b": sB}, SR,
                             {"bars": BARS4, "tracks": TR, "rack_stereo": True})
w_on = [f for f in dm_on if f.get("direction") == "dual_mono"]
ok("with the switch ON the cause is the arrangement, not the rack",
   w_on and w_on[0]["cause"] == "arrangement", str([f.get("cause") for f in w_on]))
# No job at all (a bounce file): every stem dual mono -> the rack fold is the
# first thing to check; nothing known -> "unknown", never a guess dressed up.
_, dm_file = ear.analyse_buses(dm_master, {}, SR, {"bars": BARS4})
w_f = [f for f in dm_file if f.get("direction") == "dual_mono"]
ok("a file with no stems and no job reports the cause as unknown",
   w_f and w_f[0]["cause"] == "unknown", str([f.get("cause") for f in w_f]))
# A genuinely stereo master does NOT fire it: two decorrelated channels.
wide2 = np.vstack([band_noise(SR * 4, 100, 8000, seed=91, amp=0.1),
                   band_noise(SR * 4, 100, 8000, seed=92, amp=0.1)])
ok("a wide master raises no dual-mono finding",
   not [f for f in ear.analyse_buses(wide2, {}, SR, {"bars": BARS4})[1]
        if f.get("direction") == "dual_mono"])
# The 0.70 the provers measured at the spread lead's voice is comfortably
# under the threshold: mostly-shared with a real side component.
shared = band_noise(SR * 4, 100, 8000, seed=93, amp=0.1)
side = band_noise(SR * 4, 100, 8000, seed=94, amp=0.04)     # (1-s²)/(1+s²) with s=0.4 -> 0.72
spread = np.vstack([shared + side, shared - side])
c_spread = ear.stereo_stats(spread)["correlation"]
ok("a spread lead (correlation ~0.7) is not dual mono",
   0.55 < c_spread < 0.85 and not [f for f in ear.analyse_buses(spread, {}, SR, {"bars": BARS4})[1]
                                   if f.get("direction") == "dual_mono"],
   str(c_spread))

# ══════════════════════════════════════════════════════════════════════════
print("\n  -- the loudness target: the project's, else the genre's, else streaming --")

ok("edm resolves to -8 LUFS club by default",
   ear.resolve_loudness_target({"genre": "edm"}) == (-8.0, "genre:edm", "club"),
   str(ear.resolve_loudness_target({"genre": "edm"})))
ok("edm told 'streaming' resolves to -14",
   ear.resolve_loudness_target({"genre": "edm", "delivery": "streaming"})[0] == -14.0)
ok("a project target beats the genre",
   ear.resolve_loudness_target({"genre": "edm", "target_lufs": -9.5}) == (-9.5, "project", None))
ok("an unknown genre falls back to the streaming default, and says so",
   ear.resolve_loudness_target({"genre": "acoustic"}) == (-14.0, "default", "streaming"))
ok("the default target still honours a per-job `targets.lufs` override",
   ear.resolve_loudness_target({"genre": "rock"}, {**ear.DEFAULT_TARGETS, "lufs": -16.0})[0] == -16.0)

# The shipped drop: -21.5 LUFS integrated. Build a master at about that level.
quiet_mix = stereo(pink_noise(SR * 6, seed=101, amp=0.06))
lq = ear.loudness(quiet_mix, SR, short=False)["lufs"]
_, lt = ear.analyse_buses(quiet_mix, {}, SR, {"bars": bars_map(6), "genre": "edm"})
ltf = [f for f in lt if f["metric"] == "loudness_target"]
ok("an edm mix well under -8 raises a `loudness_target` finding", len(ltf) == 1,
   str([f["metric"] for f in lt]))
if ltf:
    f = ltf[0]
    ok("...against -8 LUFS, sourced to the genre", f["target_value"] == -8.0 and f["source"] == "genre:edm",
       str((f["target_value"], f["source"])))
    ok("...with the shortfall in dB, exactly target minus measured",
       near(f["shortfall_db"], -8.0 - lq, 0.05), f"{f['shortfall_db']} vs {-8.0 - lq:.2f}")
    ok("...and the headroom the master has before the -1 dBTP ceiling",
       near(f["headroom_db"], -1.0 - ear.loudness(quiet_mix, SR)["true_peak_db"], 0.05),
       str(f["headroom_db"]))
    ok("...quoting the true peak and crest a master stage needs",
       "true_peak_db" in f and "crest_db" in f)
ok("the plain `lufs` finding does not fire beside it — one number, one card",
   not [f for f in lt if f["metric"] == "lufs"])
ok("the objective penalty measures toward the SAME target the card quotes",
   near(ear.objective_score(ear.analyse_buses(quiet_mix, {}, SR, {"bars": bars_map(6), "genre": "edm"})[0],
                            {"genre": "edm"})["parts"]["lufs"], abs(lq + 8.0) - 1.0, 0.05))
_, lt_def = ear.analyse_buses(quiet_mix, {}, SR, {"bars": bars_map(6), "genre": "neutral"})
ok("with no genre target the finding is the plain `lufs` note, as before",
   [f for f in lt_def if f["metric"] == "lufs"] and not [f for f in lt_def if f["metric"] == "loudness_target"])
_, lt_proj = ear.analyse_buses(quiet_mix, {}, SR,
                               {"bars": bars_map(6), "genre": "edm", "target_lufs": round(lq, 2)})
ok("a project target the master already meets raises nothing",
   not [f for f in lt_proj if f["metric"] in ("lufs", "loudness_target")],
   str([f["metric"] for f in lt_proj]))
ok("the measurement carries the resolved target for the panel",
   ear.analyse_buses(quiet_mix, {}, SR, {"bars": bars_map(6), "genre": "edm"})[0]["loudness_target"]
   == {"lufs": -8.0, "source": "genre:edm", "delivery": "club"})

# ══════════════════════════════════════════════════════════════════════════
print("\n  -- tuning: the kick's fundamental against the song's root --")

ok("parse_root reads note names, MIDI numbers and pitch classes",
   [ear.parse_root(v) for v in ("F", "f minor", "Db", "C#", "Eb", 41, 5, "", None, "x")]
   == [5, 5, 1, 1, 3, 5, 5, None, None, None],
   str([ear.parse_root(v) for v in ("F", "f minor", "Db", "C#", "Eb", 41, 5, "", None, "x")]))

# A big-room sub line in F minor over i-VI-III-VII: by duration every root
# has a quarter, so a histogram alone would pick whichever came out ahead;
# the register cue (the line's FLOOR is the tonic) breaks the tie.
sub_notes = []
for bar, off in enumerate([0, 8, 3, 10] * 4):          # F, Db, Ab, Eb ... from F1
    for k in range(4):
        sub_notes.append({"inst": "sub_bass", "track_id": "sub", "midi": 29 + off,
                          "dur_samples": 6000, "start_sample": bar * 90000 + k * 22500})
ok("the root of an F-minor sub line over i-VI-III-VII is inferred as F",
   ear.infer_root_pc(sub_notes, ["sub"]) == 5, str(ear.infer_root_pc(sub_notes, ["sub"])))
ok("kits are never read as pitch when inferring the root",
   ear.infer_root_pc([{"inst": "tr909", "track_id": "k", "midi": 36, "dur_samples": 1}]) is None)

# cents: the shipped kick (48.04 Hz) against F1 (43.65 Hz) is +166 c, beating at 4.4 Hz
kt = ear.kick_tuning(48.039, 5)
ok("48.04 Hz against F reads +166 cents on F1 (43.65 Hz)",
   kt["root_midi"] == 29 and near(kt["cents"], 165.7, 1.0) and near(kt["root_hz"], 43.654, 0.01),
   str(kt))
ok("...and names the beat rate against a sub on the root (4.4 Hz)",
   near(kt["beat_hz"], 4.39, 0.05), str(kt["beat_hz"]))
ok("the octave is the nearest one: 96 Hz against F reads against F2, not F1",
   ear.kick_tuning(96.0, 5)["root_midi"] == 41)
ok("a kick ON the root reads 0 cents",
   near(ear.kick_tuning(43.654, 5)["cents"], 0.0, 0.5))
ok("no root -> only the f0 is reported, no cents invented",
   ear.kick_tuning(48.0, None) == {"f0_hz": 48.0})

# f0 from a synthetic kick: a pitch snap from 4x down to f0 in ~14 ms, then a
# decaying sine (hybrid_kick's shape), sixteen hits a beat apart at 128 BPM.
def fake_kick(f0, n_hits=16, bpm=128.0, tau=0.067, snap=0.014):
    beat = int(SR * 60.0 / bpm)
    y = np.zeros(beat * n_hits)
    t = np.arange(int(SR * 0.4)) / SR
    inst = f0 * (1.0 + 3.0 * np.exp(-t / snap))            # instantaneous frequency
    ph = 2 * np.pi * np.cumsum(inst) / SR
    hit = np.sin(ph) * np.exp(-t / tau) * 0.5
    onsets = [k * beat for k in range(n_hits)]
    for s0 in onsets:
        y[s0:s0 + len(hit)] += hit[: len(y) - s0]
    return y, onsets

fk, fo = fake_kick(48.0)
f0_est, used = ear.kick_f0(fk, SR, fo)
ok("kick_f0 reads a 48 Hz kick as 48.0 Hz (within 0.2 Hz) past its pitch snap",
   f0_est is not None and near(f0_est, 48.0, 0.2) and used == 16, f"{f0_est} from {used} hits")
fk2, fo2 = fake_kick(43.654)
f0_2, _ = ear.kick_f0(fk2, SR, fo2)
ok("...and a kick on F1 as 43.65 Hz", f0_2 is not None and near(f0_2, 43.654, 0.2), str(f0_2))
ok("silence yields no f0, not a number", ear.kick_f0(np.zeros(SR), SR, [0, SR // 2]) == (None, 0))

# The finding, through the seam: a tuning block on the measure.
tune_blk = {**ear.kick_tuning(48.039, 5), "track_id": "kick", "patch": "hybrid_kick",
            "knob": "tune", "current_knob": 0.0, "hits": 16, "root_inferred": False}
_, tf = ear.analyse_buses(quiet_mix, {}, SR,
                          {"bars": bars_map(6), "tracks": {"kick": {"name": "kick", "role": "drums"}}},
                          tuning=tune_blk)
tun = [f for f in tf if f["metric"] == "tuning"]
ok("a kick 166 c off the root raises a `tuning` finding", len(tun) == 1, str([f["metric"] for f in tf]))
if tun:
    f = tun[0]
    ok("...targeting the kick track and naming the knob (hybrid_kick.tune)",
       f["target"] == "kick" and f["patch"] == "hybrid_kick" and f["knob"] == "tune", str(f))
    ok("...with the correction in semitones (-1.66) for the route to send",
       near(f["semitones"], -1.657, 0.02), str(f["semitones"]))
    ok("...at confidence 1.0 when the root was TOLD", f["confidence"] == 1.0)
    ok("...and its text names the beat the sub will hear",
       "4.4 Hz" in f["what"], f["what"])
_, tf_inf = ear.analyse_buses(quiet_mix, {}, SR, {"bars": bars_map(6)},
                              tuning={**tune_blk, "root_inferred": True})
ok("an INFERRED root drops the finding to confidence 0.5 and says so",
   [f for f in tf_inf if f["metric"] == "tuning" and f["confidence"] == 0.5
    and "inferred" in f["what"]])
_, tf_ok = ear.analyse_buses(quiet_mix, {}, SR, {"bars": bars_map(6)},
                             tuning={**ear.kick_tuning(43.9, 5), "track_id": "kick",
                                     "patch": "hybrid_kick", "knob": "tune"})
ok("a kick within 30 c of the root raises nothing",
   not [f for f in tf_ok if f["metric"] == "tuning"])

# THE REAL KICK, through the real seam: hybrid_kick at key 36 through
# rack._synth_notes, exactly the dry bus analyse() measures. 48 Hz by design
# ("48 Hz at GM key 36" in patches.json) — +166 c from F, the shipped defect.
try:
    import engine  # noqa: F401
    HAVE_ENGINE = True
except Exception as exc:  # noqa: BLE001
    HAVE_ENGINE = False
    print(f"  (engine not importable here: {exc} — the real-kick section is skipped)")
if HAVE_ENGINE:
    import engine
    beat = int(SR * 60 / 128)
    kicks = [{"inst": "hybrid_kick", "params": {"decay": 0.06, "snap": 0.2, "pitch_amount": 0.6,
                                                "punch": 1.0},
              "midi": 36, "vel": 112, "start_sample": k * beat, "dur_samples": beat // 4,
              "gain_db": 0, "seed": 1000 + k, "track_id": "trk_kick"} for k in range(8)]
    subs = [{"inst": "sub_bass", "params": {}, "midi": 29 + off, "vel": 100,
             "start_sample": k * beat + beat // 2, "dur_samples": beat // 2,
             "gain_db": 0, "seed": 2000 + k, "track_id": "trk_sub"}
            for k, off in enumerate([0, 0, 8, 8, 3, 3, 10, 10])]
    job = {"sr": SR, "start_sample": 0, "n_samples": beat * 8, "notes": kicks + subs,
           "mixer": {"tracks": {}, "returns": [], "master": {"inserts": [], "fader": 0},
                     "spq": [[0.0, 60 / 128]]},
           "ear": {"bars": [{"bar": 1, "t0": 0.0, "t1": beat * 8 / SR}],
                   "tracks": {"trk_kick": {"name": "kick", "role": "drums"},
                              "trk_sub": {"name": "sub", "role": "bass"}},
                   "genre": "edm"}}
    t = ear.kick_tuning_from_job(job, engine.SYNTHS, SR, 0, beat * 8, job["ear"])
    ok("the real hybrid_kick's dry bus reads 48.0 Hz at key 36",
       t is not None and near(t["f0_hz"], 48.0, 0.15), str(t))
    ok("...the root is inferred F from the sub line (the tonic at its floor), marked inferred",
       t is not None and t["root"] == "F" and t["root_inferred"] is True, str(t))
    ok("...and the knob named is hybrid_kick.tune, currently 0",
       t is not None and t["knob"] == "tune" and t["current_knob"] == 0.0)
    r = ear.analyse(job)
    tune_f = [f for f in r["findings"] if f["metric"] == "tuning"]
    ok("analyse() carries the tuning measurement and raises the finding",
       r["measure"].get("tuning", {}).get("cents") is not None and len(tune_f) == 1,
       str(r["measure"].get("tuning")))
    ok("...at +166 c, asking for tune -1.66 st on the kick track",
       tune_f and near(tune_f[0]["observed"], 165.7, 3.0) and tune_f[0]["target"] == "trk_kick"
       and near(tune_f[0]["semitones"], -1.66, 0.05), str(tune_f[:1]))
    told = dict(job); told["ear"] = {**job["ear"], "root": "F"}
    r2 = ear.analyse(told)
    ok("told the key, the same finding rides at confidence 1.0",
       [f for f in r2["findings"] if f["metric"] == "tuning" and f["confidence"] == 1.0])
    tuned = dict(told); tuned["notes"] = [{**k, "params": {**k["params"], "tune": -1.66}} for k in kicks] + subs
    r3 = ear.analyse(tuned)
    ok("with tune -1.66 st the kick lands on F1 and the finding is gone",
       near(r3["measure"]["tuning"]["f0_hz"], 43.654, 0.15)
       and not [f for f in r3["findings"] if f["metric"] == "tuning"],
       str(r3["measure"].get("tuning")))
    ok("analyse() reports the rack's stereo switch as the job carried it (off here)",
       r["rack_stereo"] is False)
    dm_real = [f for f in r["findings"] if f.get("direction") == "dual_mono"]
    ok("...and the fold shows up as a dual-mono finding blaming the rack",
       dm_real and dm_real[0]["cause"] == "rack_fold", str([f.get("cause") for f in dm_real]))
    ok("...with the edm club target quoted as the loudness target",
       r["measure"]["loudness_target"] == {"lufs": -8.0, "source": "genre:edm", "delivery": "club"})

    # ── [DAWREC] THE TAKES ARE IN THE MIX THE EAR MEASURES, AND SAID SO ───
    # The hole: the Ear's job carried `notes` and nothing else, so
    # rack.chain_graph rendered every file-backed clip as silence -- the
    # master AND the per-track stems, because _mix_audio sits above `keys` --
    # and the reply then said "audio_clips_excluded": 0 about that mix.
    # Vacuously true: the job it counted carried none. Proved here through
    # the real graph with a real wav, both halves: the samples arrive on the
    # clip's own bus, and the two coverage fields name what was IN the mix
    # rather than what was left out of it.
    ok("a clip-less job says its stems cover the NOTES, and counts no clips",
       r["stems_cover"] == "notes" and r["audio_clips"] == 0,
       f'{r["stems_cover"]} / {r["audio_clips"]}')
    with tempfile.TemporaryDirectory() as td:
        take_path = os.path.join(td, "take_1.wav")
        take_rng = np.random.default_rng(23)
        engine.write_wav_f32(
            take_path, take_rng.uniform(-0.3, 0.3, SR // 2).astype(np.float32), SR)
        clip_job = dict(job)
        clip_job["audio"] = [{"path": take_path, "start_sample": beat,
                              "offset_samples": 0, "dur_samples": SR // 2,
                              "gain_db": -3.0, "track_id": "trk_take"}]
        clip_job["ear"] = {**job["ear"],
                           "tracks": {**job["ear"]["tracks"],
                                      "trk_take": {"name": "take", "role": "vocal"}}}
        rc = ear.analyse(clip_job)
        ok("a job carrying one file-backed clip is measured WITH it, and the reply says so",
           rc["stems_cover"] == "notes+clips" and rc["audio_clips"] == 1,
           f'{rc["stems_cover"]} / {rc["audio_clips"]}')
        ok("...the clip's own track has a stem, which not one note in this job creates",
           "trk_take" in rc["stems"] and "trk_take" not in r["stems"], str(rc["stems"]))
        ok("...and that stem is NOT silence: the take really is on the bus the Ear reads",
           rc["measure"]["tracks"]["trk_take"]["peak_db"] > -20.0,
           str(rc["measure"]["tracks"]["trk_take"]["peak_db"]))
        ok("...and the master moved with it, because the clip is summed into that too",
           rc["measure"]["master"]["rms_db"] > r["measure"]["master"]["rms_db"],
           f'{rc["measure"]["master"]["rms_db"]} vs {r["measure"]["master"]["rms_db"]}')

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
print("\n  -- ...and it is measured PER CHANNEL: L, R and the fold, which is the third number --")


def decorrelate(x, samples=48):
    """The simplest magnitude-FLAT decorrelation there is: a pure delay. Its
    transfer function is z^-k, |H| = 1 at every frequency, so the delayed
    channel keeps every band's energy to the sample and loses its phase
    relationship with the other channel. tr909's `hat_width` allpass is the
    same idea with a frequency-dependent phase; a delay is used here because
    its comb is closed-form (notches at (2m+1)/2k Hz — 500, 1500, 2500 … for
    k = 48 at 48 kHz) and it does not come from the code under test."""
    y = np.zeros_like(x)
    y[samples:] = x[:-samples]
    return y


# 1. THE FOLD IS STILL THE FOLD. Every legacy key keeps its old meaning.
mono8 = pink_noise(SR * 4, seed=51, amp=0.08)
sb_dual = ear.spectral_balance(stereo(mono8), SR, "neutral")
sb_1d = ear.spectral_balance(mono8, SR, "neutral")
ok("a dual-mono input: left, right and mid are the SAME number in every band, and "
   "`observed_db` is that number",
   all(r["left_db"] == r["right_db"] == r["mid_db"] == r["observed_db"] for r in sb_dual["bands"])
   and all(r["channel_spread_db"] == 0.0 and r["fold_cost_db"] == 0.0 for r in sb_dual["bands"]))
ok("...and it is DECLARED dual mono, so the second spectrogram is skipped rather than repeated",
   sb_dual["dual_mono"] is True and sb_dual["fold"] == "mid ((L+R)/2)"
   and sb_dual["measured"] == ["left", "right", "mid"])
ok("a 1-D (mono) input measures identically to the same signal in two channels",
   [r["observed_db"] for r in sb_1d["bands"]] == [r["observed_db"] for r in sb_dual["bands"]])

# 2. WHAT THE FOLD INVENTS. A magnitude-flat decorrelation on the right
#    channel changes NO band's energy in either channel and comb-filters the
#    sum. This is what tr909's hat_width does, and reading it mono says the
#    knob costs top end.
right = decorrelate(mono8, 48)
wide = np.vstack([mono8, right])
sb_w = ear.spectral_balance(wide, SR, "neutral")
ok("a decorrelated right channel: every band's share is the same on L and R to 0.05 dB "
   "(a delay is flat in magnitude)",
   max(abs(r["left_db"] - r["right_db"]) for r in sb_w["bands"]) <= 0.05,
   str([(r["name"], r["left_db"], r["right_db"]) for r in sb_w["bands"]]))
ok("...but the LEVEL the fold reports is under both channels in at least four bands: "
   "the sum combs where the channels do not",
   sum(1 for r in sb_w["bands"] if r["fold_cost_db"] < -0.2) >= 4,
   str([(r["name"], r["fold_cost_db"]) for r in sb_w["bands"]]))
ok("...and `fold_hides` names the band that loses the most, with the number",
   sb_w["fold_hides"]["band_index"] is not None and sb_w["fold_hides"]["db"] < -0.2
   and sb_w["fold_hides"]["db"] == min(r["fold_cost_db"] for r in sb_w["bands"]
                                       if not r["absent"]),
   str(sb_w["fold_hides"]))
ok("...while the two channels themselves lose NOTHING: the widened signal's per-channel "
   "levels equal the un-widened signal's, band for band",
   max(abs(r["level_left_db"] - q["level_db"])
       for r, q in zip(sb_w["bands"], sb_dual["bands"])) <= 0.01
   and max(abs(r["level_right_db"] - q["level_db"])
           for r, q in zip(sb_w["bands"], sb_dual["bands"])) <= 0.05,
   str([(r["name"], r["level_left_db"], r["level_right_db"], q["level_db"])
        for r, q in zip(sb_w["bands"], sb_dual["bands"])][:3]))

# 3. WHAT THE FOLD HIDES. 9 dB of 2-4 kHz on the LEFT only: the fold reports
#    about half of it and says nothing about which side it is on.
lop_l = pink_noise(SR * 4, seed=52, amp=0.08) + band_noise(SR * 4, 2000, 4000, seed=53, amp=0.09)
lop_r = pink_noise(SR * 4, seed=52, amp=0.08)
sb_lop = ear.spectral_balance(np.vstack([lop_l, lop_r]), SR, "neutral")
b6 = sb_lop["bands"][6]
ok(f"a boost on the LEFT only: left {b6['deviation_left_db']:+.2f} dB, right "
   f"{b6['deviation_right_db']:+.2f} dB, fold {b6['deviation_db']:+.2f} dB -- the fold sits "
   "between the two and names neither",
   b6["deviation_left_db"] > b6["deviation_db"] > b6["deviation_right_db"]
   and b6["channel_spread_db"] > 3.0)
ok("...and `channel_spread` names 2-4 kHz as the worst-spread band, with its dB",
   sb_lop["channel_spread"]["band_index"] == 6
   and near(sb_lop["channel_spread"]["db"], b6["channel_spread_db"], 1e-9),
   str(sb_lop["channel_spread"]))
ok("...and `dual_mono` is false for it", sb_lop["dual_mono"] is False)
_, lopf = ear.analyse_buses(np.vstack([lop_l, lop_r]), {}, SR, {"bars": bars_map(4)})
lopb = [f for f in lopf if f["metric"] == "balance" and f["band_index"] == 6]
ok("the balance FINDING carries the per-channel numbers, so an EQ move made from it knows "
   "whether the two sides agree",
   lopb and lopb[0]["channel_spread_db"] == b6["channel_spread_db"]
   and lopb[0]["deviation_left_db"] == b6["deviation_left_db"]
   and lopb[0]["observed"] == b6["deviation_db"],
   str(lopb[:1]))
ok("...and it SAYS so where a human reads it: the how_much line names both channels once the "
   "two sides are further apart than the tolerance itself",
   lopb and "L +" in lopb[0]["how_much"] and "apart here" in lopb[0]["how_much"],
   str(lopb[0]["how_much"]) if lopb else "")
ok("...and stays quiet when they agree: a centred boost's how_much is the fold's number alone",
   all("apart here" not in f["how_much"] for f in bf if f["metric"] == "balance"),
   str([f["how_much"] for f in bf if f["metric"] == "balance"]))

# 4. THE THRESHOLDS DID NOT MOVE. Every number the penalty and the cards read
#    is still the fold, so this change is additive by construction.
ok("the objective penalty still reads the FOLD: `observed_db` IS `mid_db`, and "
   "`deviation_db` is that number against the reference, in every band of every case above",
   all(r["observed_db"] == r["mid_db"]
       and abs(r["deviation_db"] - (r["mid_db"] - r["reference_db"])) <= 0.011
       for sb in (sb_lop, sb_w, sb_dual, sb_1d) for r in sb["bands"]))

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
       "width", "level", "loudness_target", "tuning"})
ok("probe publishes the genre loudness table and the kick patches it can tune",
   p["genre_loudness"]["edm"] == {"club": -8.0, "streaming": -14.0}
   and "hybrid_kick" in p["kick_patches"])
ok("probe's targets carry the dual-mono and tuning thresholds",
   p["targets"]["dual_mono_correlation"] == 0.99 and p["targets"]["tuning_cents"] == 30.0)
ok("probe reports the bands it uses", len(p["bands"]) == len(ear.BANDS))
ok("probe carries the judge's availability verdict", "judge" in p)

print(f"\n  {PASS} passed, {len(FAILS)} failed\n")
if FAILS:
    print("  failed:\n   " + "\n   ".join(FAILS) + "\n")
    raise SystemExit(1)
