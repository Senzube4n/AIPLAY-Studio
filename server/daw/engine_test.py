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

print(f"\n  {passed} passed, {len(failures)} failed\n")
if failures:
    print("  failed:\n   " + "\n   ".join(failures) + "\n")
    sys.exit(1)
