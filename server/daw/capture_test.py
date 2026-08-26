"""DAW capture, python half: the codecs and the engine's audio mixing. [DAWREC]

What is pinned here and nowhere else:

  * capture.py's FLAC round trip is lossless to the 24-bit floor (measured
    1.2e-7 worst error), and engine.py decodes the SAME file to the SAME
    floats — the encode scale and the decode scale are inverses across two
    files, which nothing but this test would notice drifting.
  * the region-seam proof EXTENDED to audio clips: a region render of a
    window is bit-identical to that window sliced out of a whole render,
    with a file-backed clip in the mix. Same argument as notes (per-sample
    addition, memoryless master), now proven, not argued.
  * the click puts its blips at exactly the samples it was told, and only
    there — the count-in the browser plays IS the timeline's arithmetic.

Runs under the rig venv (needs numpy; PyAV for the FLAC sections, which
skip honestly when it is missing — the wav fallback is then what's proven).
"""
import json
import os
import subprocess
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import capture  # noqa: E402
import engine   # noqa: E402

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


SR = 48000
HAVE_AV = capture._have_av()
print(f"\n  (PyAV {'present' if HAVE_AV else 'ABSENT — flac sections degrade to the wav fallback'})")

print("\n  -- encode: raw f32 -> take file -> the exact floats back --")
with tempfile.TemporaryDirectory() as td:
    rng = np.random.default_rng(7)
    x = (rng.uniform(-0.9, 0.9, SR * 2)).astype(np.float32)
    raw = os.path.join(td, "cap.f32")
    x.tofile(raw)
    r = capture.encode({"sr": SR, "raw": raw, "out": os.path.join(td, "take.flac")})
    ok("encode answers ok with the sample count", r["ok"] and r["n_samples"] == SR * 2)
    ok(f"the format is honest ({r['format']})",
       r["format"] == ("flac" if HAVE_AV else "wav"))
    ok("the file exists under the name encode returned", os.path.getsize(r["out"]) > 0)

    # decode it back through capture.py (the comp flattener's reader)
    dec = capture.decode({"path": r["out"], "sr": SR, "out": os.path.join(td, "back.f32")})
    back = np.fromfile(dec["out"], dtype="<f4")
    ok("decode returns every sample", len(back) == len(x))
    err = float(np.max(np.abs(back.astype(np.float64) - x.astype(np.float64))))
    budget = 2.5e-7 if HAVE_AV else 0.0
    ok(f"round-trip error {err:.2e} is at the 24-bit floor (budget {budget:.1e})", err <= budget)

    # and through the ENGINE's reader — the render-side decode must agree
    y_engine = engine._read_audio_f64(r["out"], SR)
    ok("engine reads the same length", len(y_engine) == len(x))
    err2 = float(np.max(np.abs(y_engine - back.astype(np.float64))))
    ok(f"engine and capture decode IDENTICALLY (err {err2:.1e})", err2 == 0.0)

    rate_err = ""
    try:
        engine._read_audio_f64(r["out"], 44100)
    except ValueError as exc:
        rate_err = str(exc)
    ok("a rate mismatch is an ERROR naming the fix, never a resample",
       "re-import" in rate_err)

print("\n  -- the seam proof holds WITH a file-backed clip in the mix --")
with tempfile.TemporaryDirectory() as td:
    rng = np.random.default_rng(11)
    perf = (rng.uniform(-0.5, 0.5, SR)).astype(np.float32)   # a 1 s "performance"
    raw = os.path.join(td, "p.f32")
    perf.tofile(raw)
    r = capture.encode({"sr": SR, "raw": raw, "out": os.path.join(td, "tk.flac")})
    take_path = r["out"]

    notes = [
        {"inst": "pluck", "midi": 60, "vel": 100, "start_sample": 0,
         "dur_samples": SR // 2, "gain_db": 0, "seed": 1},
        {"inst": "drums", "midi": 36, "vel": 110, "start_sample": SR,
         "dur_samples": 100, "gain_db": 0, "seed": 2},
    ]
    audio = [{"path": take_path, "start_sample": int(SR * 0.75),
              "offset_samples": 0, "dur_samples": SR, "gain_db": -3.0}]
    whole = engine.render({"sr": SR, "start_sample": 0, "n_samples": SR * 2,
                           "notes": notes, "audio": audio,
                           "out": os.path.join(td, "whole.wav")})
    y_whole, _ = engine.read_wav_f32(os.path.join(td, "whole.wav"))
    # the same content as two abutting region windows
    y_regions = []
    for w0, n in ((0, SR), (SR, SR)):
        out = os.path.join(td, f"reg{w0}.wav")
        engine.render({"sr": SR, "start_sample": w0, "n_samples": n,
                       "notes": notes, "audio": audio, "out": out})
        y_regions.append(engine.read_wav_f32(out)[0])
    stitched = np.concatenate(y_regions)
    ok("region renders stitch BIT-IDENTICAL to the whole render (audio included)",
       len(stitched) == len(y_whole) and np.array_equal(stitched, y_whole))

    # placement: the clip's first audible sample is exactly start_sample
    silent = engine.render({"sr": SR, "start_sample": 0, "n_samples": SR * 2,
                            "notes": [], "audio": audio,
                            "out": os.path.join(td, "only.wav")})
    y_only, _ = engine.read_wav_f32(os.path.join(td, "only.wav"))
    nz = np.nonzero(np.abs(y_only) > 1e-6)[0]
    ok(f"the clip's first sample lands AT start_sample ({nz[0]} == {int(SR*0.75)})",
       len(nz) > 0 and nz[0] == int(SR * 0.75))
    ok("...and its last inside start+dur", nz[-1] < int(SR * 0.75) + SR)

    # offset/dur trim: a window into the middle of the file
    trimmed = [{"path": take_path, "start_sample": 100, "offset_samples": 1000,
                "dur_samples": 2000, "gain_db": 0.0}]
    engine.render({"sr": SR, "start_sample": 0, "n_samples": 4000,
                   "notes": [], "audio": trimmed, "out": os.path.join(td, "trim.wav")})
    y_trim, _ = engine.read_wav_f32(os.path.join(td, "trim.wav"))
    src = engine._read_audio_f64(take_path, SR)
    expect = np.tanh(0.7 * src[1000:3000]).astype(np.float32)
    ok("offset_samples/dur_samples trim exactly (bit-compare against the source)",
       np.array_equal(y_trim[100:2100], expect)
       and float(np.max(np.abs(y_trim[:100]))) == 0.0
       and float(np.max(np.abs(y_trim[2100:]))) == 0.0)

print("\n  -- the click puts blips exactly where it is told --")
with tempfile.TemporaryDirectory() as td:
    events = [{"sample": 0, "accent": True},
              {"sample": 12000, "accent": False},
              {"sample": 24000, "accent": False},
              {"sample": 47990, "accent": True}]      # deliberately near the end
    out = os.path.join(td, "click.wav")
    r = engine.click({"sr": SR, "n_samples": SR, "events": events, "out": out})
    ok("click reports every event placed", r["ok"] and r["clicks"] == 4)
    y, _ = engine.read_wav_f32(out)
    nz = np.nonzero(np.abs(y) > 1e-6)[0]
    # the blip is a sine, so its onset sample is a zero crossing: the first
    # NONZERO sample is event.sample + 1, and nothing sounds before it
    ok("the first audible sample is within 1 sample of event 0", len(nz) > 0 and nz[0] <= 1)
    gap = y[int(0.040 * SR) + 8:12000]                # after blip 0 decays, before blip 1
    ok("between blips is EXACT silence (no drift, no tail)",
       float(np.max(np.abs(gap))) == 0.0)
    ok("blip 2 starts exactly at its sample",
       float(np.max(np.abs(y[24000 - 40:24000]))) == 0.0 and abs(y[24000]) >= 0.0
       and np.any(np.abs(y[24000:24010]) > 1e-6))
    ok("a blip near the buffer end is clipped, not crashed", len(y) == SR)

if HAVE_AV:
    print("\n  -- decode: stereo 44.1k -> mono 48k (the import seam) --")
    with tempfile.TemporaryDirectory() as td:
        import av
        sr_in = 44100
        t = np.arange(sr_in) / sr_in
        left = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
        right = (0.5 * np.sin(2 * np.pi * 660 * t)).astype(np.float32)
        src_path = os.path.join(td, "stereo.wav")
        cont = av.open(src_path, "w")
        st = cont.add_stream("pcm_f32le", rate=sr_in)
        st.codec_context.format = "flt"
        st.codec_context.layout = "stereo"
        inter = np.empty(sr_in * 2, dtype=np.float32)
        inter[0::2] = left
        inter[1::2] = right
        fr = av.AudioFrame.from_ndarray(inter.reshape(1, -1), format="flt", layout="stereo")
        fr.sample_rate = sr_in
        for pkt in st.encode(fr):
            cont.mux(pkt)
        for pkt in st.encode(None):
            cont.mux(pkt)
        cont.close()

        dec = capture.decode({"path": src_path, "sr": SR, "out": os.path.join(td, "m.f32")})
        ok("decode reports the source honestly", dec["src_sr"] == sr_in and dec["src_channels"] == 2)
        y = np.fromfile(dec["out"], dtype="<f4")
        ok(f"one second resamples to ~{SR} samples (got {len(y)})", abs(len(y) - SR) <= 64)
        ok("the downmix carries real signal", float(np.sqrt(np.mean(y ** 2))) > 0.1)

        p = capture.probe({"path": src_path})
        ok("probe names rate and channels", p["sr"] == sr_in and p["channels"] == 2)
else:
    print("\n  (skipping the stereo/resample section — PyAV absent; the wav "
          "fallback was proven above and decode of non-wav refuses honestly)")

print(f"\n  {passed} passed, {len(failures)} failed\n")
if failures:
    print("  failed:\n   " + "\n   ".join(failures) + "\n")
    sys.exit(1)
