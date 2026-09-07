# -*- coding: utf-8 -*-
"""DAW engine -- determinism, the seam proof, tails, and the P0-4 estimator.

Every section is arithmetic against a closed form or byte-equality against a
re-computation; nothing is judged by ear here. The two assertions this file
exists for:

  SEAM   a project rendered as one window equals the same project rendered as
         abutting regions, BIT FOR BIT, with notes deliberately ringing across
         every boundary -- the no-click guarantee is equality, not a crossfade.
  P0-4   the loopback offset estimator recovers known offsets 3..250 ms to
         within +-1 ms through noise and a speaker-ish lowpass.

Run:  python server/daw/engine_test.py       (rig venv: numpy + scipy)
"""
import io
import json
import os
import subprocess
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import engine  # noqa: E402

SR = engine.DEFAULT_SR

passed = 0
failures = []


def ok(label, cond, detail=""):
    global passed
    if cond:
        passed += 1
        print(f"  ok    {label}")
    else:
        failures.append(label)
        print(f"  FAIL  {label}" + (f"\n          {detail}" if detail else ""))


def note(inst, midi, start_sample, dur_samples, vel=100, gain_db=0.0, seed=1234):
    return {"inst": inst, "midi": midi, "vel": vel, "gain_db": gain_db,
            "start_sample": start_sample, "dur_samples": dur_samples, "seed": seed}


def render_to_array(job):
    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, "r.wav")
        r = engine.render(dict(job, out=out))
        y, sr = engine.read_wav_f32(out)
        return y, r


print("\n  -- every voice honours its declared tail, exactly --")
for inst, tail in engine.TAILS.items():
    dur = SR // 2
    rng = np.random.default_rng(7)
    y = engine.SYNTHS[inst](60, dur, 0.8, SR, rng)
    want = dur + int(round(tail * SR))
    ok(f"{inst}: buffer is exactly dur + {tail}s", len(y) == want, f"got {len(y)} want {want}")
    ok(f"{inst}: the final sample is exactly zero", y[-1] == 0.0, f"got {y[-1]}")
    ok(f"{inst}: it actually makes sound", float(np.max(np.abs(y))) > 1e-3)

print("\n  -- determinism: same seed, same bytes; different seed, different sound --")
{
}
a1 = engine.SYNTHS["pluck"](64, SR // 4, 0.9, SR, np.random.default_rng(42))
a2 = engine.SYNTHS["pluck"](64, SR // 4, 0.9, SR, np.random.default_rng(42))
b = engine.SYNTHS["pluck"](64, SR // 4, 0.9, SR, np.random.default_rng(43))
ok("a re-render is bit-identical", np.array_equal(a1, a2))
ok("a different seed detunes differently", not np.array_equal(a1, b))

job = {"sr": SR, "start_sample": 0, "n_samples": SR * 2,
       "notes": [note("pluck", 60, 0, SR // 2, seed=9),
                 note("pad", 67, SR // 2, SR // 2, seed=10),
                 note("drums", 36, SR, SR // 8, seed=11)]}
y1, r1 = render_to_array(job)
y2, r2 = render_to_array(json.loads(json.dumps(job)))
ok("a full render job is deterministic (sha1 match)", r1["sha1"] == r2["sha1"], f"{r1['sha1']} vs {r2['sha1']}")
ok("the wav rendered non-silence", float(np.max(np.abs(y1))) > 0.01)
ok("the master stays inside +-1 (tanh)", float(np.max(np.abs(y1))) <= 1.0)

print("\n  -- THE SEAM PROOF: regions stitch bit-identically to the whole --")
# Four 2-second "bars", one region per bar, with notes placed so that a tail
# CROSSES every region boundary -- if the proof were vacuous (nothing ringing
# over), it would pass with broken tail handling too, so first prove the
# boundaries carry energy from earlier notes.
bar = SR * 2
notes = [
    note("pluck", 52, int(bar * 0.75), SR // 2, seed=21),   # rings across 2s edge
    note("pad", 60, int(bar * 1.8), SR, seed=22),           # sounds across 4s edge
    note("pluck", 67, int(bar * 2.9), SR // 4, seed=23),    # rings across 6s edge
    note("drums", 49, int(bar * 1.95), SR // 8, seed=24),   # crash across 4s edge
]
whole_job = {"sr": SR, "start_sample": 0, "n_samples": bar * 4, "notes": notes}
whole, _ = render_to_array(whole_job)

pieces = []
for i in range(4):
    w0, n = bar * i, bar
    # the subset the store's hasher would pick: anything whose sound interval
    # [start, start+dur+tail] intersects the window
    sub = [nt for nt in notes
           if nt["start_sample"] < w0 + n
           and nt["start_sample"] + nt["dur_samples"] + int(engine.TAILS[nt["inst"]] * SR) > w0]
    y, _ = render_to_array({"sr": SR, "start_sample": w0, "n_samples": n, "notes": sub})
    pieces.append(y)
stitched = np.concatenate(pieces)

for i, edge in enumerate((bar, bar * 2, bar * 3)):
    ok(f"boundary {i + 1} carries ring-over energy (the test is not vacuous)",
       float(np.max(np.abs(whole[edge:edge + SR // 10]))) > 1e-4)
ok("stitched regions == whole render, BIT FOR BIT",
   np.array_equal(stitched, whole),
   f"max diff {float(np.max(np.abs(stitched - whole)))}")
ok("...so the seam discontinuity is exactly the signal's own step",
   np.array_equal(stitched[bar - 1:bar + 1], whole[bar - 1:bar + 1]))

print("\n  -- a region window sees only what can reach it --")
lone = [note("pluck", 60, int(bar * 0.5), SR // 2, seed=31)]
far, _ = render_to_array({"sr": SR, "start_sample": bar * 3, "n_samples": bar, "notes": []})
ok("an empty region renders exact silence", float(np.max(np.abs(far))) == 0.0)
sliced, _ = render_to_array({"sr": SR, "start_sample": bar * 3, "n_samples": bar, "notes": lone})
ok("a note whose tail cannot reach the window adds nothing",
   float(np.max(np.abs(sliced))) == 0.0)

print("\n  -- render speed: a 4-bar region with a real note load --")
busy = []
rngseed = 100
for k in range(16):
    busy.append(note("pluck", 48 + (k * 5) % 24, int(k * bar / 4), SR // 3, seed=rngseed + k))
for k in range(8):
    busy.append(note("drums", (36, 38, 42, 46)[k % 4], int(k * bar / 2), SR // 16, seed=200 + k))
for k in range(4):
    busy.append(note("pad", 55 + k * 4, k * bar, bar, seed=300 + k))
_, rb = render_to_array({"sr": SR, "start_sample": 0, "n_samples": bar * 4, "notes": busy})
ok(f"28 notes over 8 s rendered in {rb['ms']} ms (budget 1500)", rb["ms"] < 1500, f"{rb['ms']} ms")

print("\n  -- P0-4: the loopback estimator, synthetic but honest --")
ref = engine.make_chirp(SR)
rng = np.random.default_rng(20260826)
from scipy.signal import lfilter  # noqa: E402
worst = 0.0
for true_ms in (3.0, 7.7, 25.0, 60.3, 120.0, 250.0):
    delay = int(round(true_ms / 1000 * SR))
    cap = np.zeros(delay + len(ref) + SR // 2)
    cap[delay:delay + len(ref)] += ref * 0.3              # quiet mic
    # a speaker-ish one-pole lowpass, then noise at ~10 dB SNR
    k = np.exp(-2 * np.pi * 6000 / SR)
    cap = lfilter([1 - k], [1, -k], cap)
    sig = float(np.sqrt(np.mean(cap[delay:delay + len(ref)] ** 2)))
    cap = cap + rng.normal(0, sig / 3.16, len(cap))
    est_ms, ratio = engine.estimate_offset(ref, cap, SR)
    err = abs(est_ms - true_ms)
    worst = max(worst, err)
    ok(f"offset {true_ms} ms recovered to {est_ms:.3f} ms (err {err * 1000:.0f} us, ratio {ratio:.1f})",
       err <= 1.0 and ratio >= 2.0)
ok(f"worst error across the sweep is {worst * 1000:.0f} us (budget 1 ms)", worst <= 1.0)

# an honest failure: pure noise must not come back confident
junk_ms, junk_ratio = engine.estimate_offset(ref, rng.normal(0, 1, SR), SR)
ok("pure noise is not confidently 'calibrated'", junk_ratio < 2.0, f"ratio {junk_ratio}")

print("\n  -- the chain-stage dispatch: mixer.stereo is read by the rack, not here --")
with tempfile.TemporaryDirectory() as td:
    _mx = {"tracks": {}, "returns": [], "master": {"inserts": [], "fader": 0}, "spq": [[0.0, 0.5]]}
    _nt = [dict(note("pad", 60, 0, SR // 2), track_id="A")]
    _r0 = engine.render({"sr": SR, "start_sample": 0, "n_samples": SR, "notes": _nt,
                         "mixer": _mx, "out": os.path.join(td, "m.wav")})
    _r1 = engine.render({"sr": SR, "start_sample": 0, "n_samples": SR, "notes": _nt,
                         "mixer": dict(_mx, stereo=True), "out": os.path.join(td, "s.wav")})
    ok("a mixer job answers chained, stereo:false by default and channels 2",
       _r0.get("chained") is True and _r0.get("stereo") is False and _r0.get("channels") == 2)
    ok("...and stereo:true is echoed back (the reply names the path)", _r1.get("stereo") is True)
    _p0 = engine.render({"sr": SR, "start_sample": 0, "n_samples": SR, "notes": _nt,
                         "out": os.path.join(td, "p.wav")})
    ok("a job without a mixer still takes the P0 mono path (no chained/stereo keys)",
       "chained" not in _p0 and "stereo" not in _p0 and _p0["ok"])

print("\n  -- the calibrate mode end-to-end (raw f32 capture file) --")
with tempfile.TemporaryDirectory() as td:
    cap_path = os.path.join(td, "cap.f32")
    delay = int(round(0.0873 * SR))
    cap = np.zeros(delay + len(ref) + SR // 4)
    cap[delay:delay + len(ref)] += ref * 0.4
    cap = cap + np.random.default_rng(5).normal(0, 0.01, len(cap))
    cap.astype("<f4").tofile(cap_path)
    r = engine.calibrate({"sr": SR, "capture": cap_path})
    ok("calibrate answers ok with a confident offset", r["ok"] and r["confident"])
    ok(f"...of 87.3 ms (got {r['offset_ms']} ms)", abs(r["offset_ms"] - 87.3) <= 1.0)

    chirp_path = os.path.join(td, "chirp.wav")
    engine.chirp({"sr": SR, "out": chirp_path})
    y, sr = engine.read_wav_f32(chirp_path)
    ok("chirp mode writes a readable half-second float32 wav",
       sr == SR and abs(len(y) - SR // 2) < 8)

print("\n  -- serve mode speaks the vfx protocol --")
proc = subprocess.Popen([sys.executable, os.path.join(HERE, "engine.py"), "serve"],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE, text=True)
try:
    ready = json.loads(proc.stdout.readline())
    ok("serve announces ready", ready.get("ready") is True)
    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, "s.wav")
        req = {"id": 1, "cmd": "render",
               "job": dict(whole_job, out=out, notes=whole_job["notes"][:2])}
        proc.stdin.write(json.dumps(req) + "\n")
        proc.stdin.flush()
        r = json.loads(proc.stdout.readline())
        ok("a render over serve answers with its id", r.get("id") == 1 and r.get("ok"))
        y_serve, _ = engine.read_wav_f32(out)
        # the same job through the file lane
        y_file, rf = render_to_array({"sr": SR, "start_sample": 0,
                                      "n_samples": bar * 4, "notes": notes[:2]})
        ok("serve and per-call lanes render identical bytes", r.get("sha1") == rf["sha1"])
    proc.stdin.write(json.dumps({"id": 2, "cmd": "probe", "job": {}}) + "\n")
    proc.stdin.flush()
    p = json.loads(proc.stdout.readline())
    ok("probe over serve names the instruments and tails",
       p.get("instruments") == sorted(engine.SYNTHS) and p.get("tails") == engine.TAILS)
    proc.stdin.write(json.dumps({"id": 3, "cmd": "shutdown"}) + "\n")
    proc.stdin.flush()
    bye = json.loads(proc.stdout.readline())
    ok("shutdown answers bye and exits 0", bye.get("bye") is True and proc.wait(timeout=10) == 0)
finally:
    if proc.poll() is None:
        proc.kill()


# ═══════════════ [VOICELAB] the new modes are ADDITIONS, and only that ══════
#
# THE NON-NEGOTIABLE CONSTRAINT, in executable form. Every region hash in
# every cache on disk is the hash of what `render` produced, and the seam
# proof above is a statement about its bytes. `render_stems`, `peaks_mip` and
# `voice_analyse` were added so the per-track lanes and the Voice Lab could
# exist WITHOUT that being true of anything else.

print("\n  -- [VOICELAB] the three new modes are registered, and render is untouched --")
ok("MODES gained render_stems, peaks_mip and voice_analyse",
   {"render_stems", "peaks_mip", "voice_analyse"} <= set(engine.MODES))
ok("`render` is still engine.render itself -- not wrapped, not decorated, not "
   "replaced by anything the additions did",
   engine.MODES["render"] is engine.render)
ok("the four modes that were here before still map to the same four functions",
   engine.MODES["chirp"] is engine.chirp and engine.MODES["calibrate"] is engine.calibrate
   and engine.MODES["probe"] is engine.probe and engine.MODES["click"] is engine.click)
ok("serve dispatches the new modes over the same one-JSON-line protocol",
   engine.SERVE_MODES is engine.MODES)

# The determinism claim, re-made with the new modules imported: importing
# peaks.py pulls numpy state and (lazily) ear.py into the same process, and a
# render after that must be the render before it.
_det_job = {"sr": SR, "start_sample": 0, "n_samples": SR // 2,
            "notes": [note("pluck", 60, 0, SR // 4), note("drums", 36, 0, SR // 8)]}
_a, _ra = render_to_array(_det_job)
import peaks as _pk  # noqa: E402
_pk.probe()
_b, _rb = render_to_array(_det_job)
ok("a render before and after `import peaks` is bit-identical",
   _ra["sha1"] == _rb["sha1"] and np.array_equal(_a, _b), f"{_ra['sha1']} vs {_rb['sha1']}")

print("\n  -- render_stems refuses the mono job rather than inventing a stem --")
try:
    engine.MODES["render_stems"]({"sr": SR, "start_sample": 0, "n_samples": SR,
                                  "notes": [note("pluck", 60, 0, SR // 4)],
                                  "out_dir": "."})
    ok("the P0 mono job is refused", False, "it produced stems")
except ValueError as exc:
    ok("the P0 mono job is REFUSED by name: a note without track_id has no bus",
       "track_id" in str(exc), str(exc))

print("\n  -- voice_analyse reads what render wrote, and measures per CHANNEL --")
with tempfile.TemporaryDirectory() as _td:
    _wav = os.path.join(_td, "one.wav")
    engine.render({"sr": SR, "start_sample": 0, "n_samples": SR,
                   "notes": [note("pluck", 60, 0, SR // 4)], "out": _wav})
    _an = engine.MODES["voice_analyse"]({"file": _wav, "columns": 200})
    ok("it reads engine.py's own float32 RIFF without PyAV",
       _an["ok"] and _an["rate"] == SR and _an["samples"] == SR)
    ok("the mono render is reported as mono rather than as two channels of luck",
       _an["channels"] == 1 and _an["mono"] is True)
    ok("peaks come back as min AND max, per channel, ~200 columns",
       len(_an["peaks"]["channels"]["L"]["min"]) == len(_an["peaks"]["channels"]["L"]["max"])
       and 150 <= _an["peaks"]["columns"] <= 210)
    import ear as _ear  # noqa: E402
    ok("the nine bands are ear.py's OWN constant, not a copy: the labels match "
       "and the band edges are ear.BANDS",
       _an["spectrum"]["band_labels"] == list(_ear.BAND_LABELS)
       and len(_an["spectrum"]["band_labels"]) == len(_ear.BANDS) == 9)
    ok("L, R and mid are all reported -- and `mid` IS ear.py's own mono fold",
       set(_an["spectrum"]["per_channel"]) == {"L", "R", "mid"})
    _mine = _an["spectrum"]["per_channel"]["mid"]["bands"]
    _theirs = _ear.spectral_balance(engine.read_wav_f32(_wav)[0], SR)["bands"]
    ok("...to the decibel: mid's nine deviations equal ear.spectral_balance's "
       "on the same file",
       [r["deviation_db"] for r in _mine] == [r["deviation_db"] for r in _theirs])
    ok("a dual-mono file reads L-R as exactly zero in every band",
       all(v == 0 for v in _an["spectrum"]["l_minus_r_db"]))
    ok("the mono short-circuit is an OPTIMISATION, not a different answer: "
       "measuring L, R and mid the long way round gives the same numbers",
       engine.MODES["voice_analyse"]({"file": _wav, "columns": 200,
                                      "force_per_channel": True})["spectrum"]
       == _an["spectrum"])
    ok("...and it is declared in the payload rather than hidden",
       _an["measured_once"] is True)
    _env = _an["envelope"]["mid"]
    ok(f"the envelope carries t10/t30/t60 from its own peak "
       f"(t10={_env['t10_ms']}, t30={_env['t30_ms']}, t60={_env['t60_ms']} ms)",
       _env["t10_ms"] is not None and _env["attack_ms"] is not None
       and (_env["t30_ms"] is None or _env["t30_ms"] >= _env["t10_ms"]))
    ok("a t60 the window is too short to reach is None, never a guess",
       _env["t60_ms"] is None or _env["t60_ms"] <= _env["measured_over_ms"])
    ok("the 1/3-octave curve is a dB SHARE, so it sums to 0 dB of total power",
       abs(sum(10 ** (r["share_db"] / 10.0)
               for r in _an["third_octave"]["mid"]["bands"]) - 1.0) < 0.02)
    # Gain invariance is the property the whole reference comparison rests on.
    _loud = os.path.join(_td, "loud.wav")
    _y, _sr = engine.read_wav_f32(_wav)
    engine.write_wav_f32(_loud, _y * 0.25, _sr)
    _an2 = engine.MODES["voice_analyse"]({"file": _loud, "columns": 200})
    _d = max(abs(a["share_db"] - b["share_db"]) for a, b in
             zip(_an["third_octave"]["mid"]["bands"], _an2["third_octave"]["mid"]["bands"]))
    ok(f"...and it does not move when the gain does: -12 dB shifts every band "
       f"by at most {_d:.3f} dB", _d < 0.01, f"{_d}")


print(f"\n  {passed} passed, {len(failures)} failed\n")
if failures:
    print("  failed:\n   " + "\n   ".join(failures) + "\n")
    sys.exit(1)
