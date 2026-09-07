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


def _read_stereo(path):
    """The inverse of rack.write_wav_f32_stereo: its fixed 44-byte header, then
    interleaved float32. Local on purpose -- that writer IS the contract, and a
    chunk-walking reader would absorb a header change instead of failing on it."""
    with open(path, "rb") as fh:
        raw = fh.read()
    y = np.frombuffer(raw[44:], dtype="<f4")
    return np.vstack([y[0::2], y[1::2]])


print("\n  -- THE CHAINED PATH MIXES THE CLIP TOO (P0 is not the only lane) --")
#
# THE DEFECT THIS PINS SHUT. engine.render returned rack.render_with_chain the
# moment a job carried `mixer`, and rack.chain_graph built its dry buffers from
# job["notes"] and nothing else -- the word "audio" appeared nowhere in
# rack.py. store.js gives every NEW project master.stereo and stereo_on forces
# the chain path on it, so this was every new project with a recorded or
# imported take: the clip was hashed into the region identity, handed to the
# engine, and dropped. Measured here before the fix: the same one-second clip,
# peak 0.206966 through the P0 mono path and peak 0.0 through a NO-OP mixer,
# the chained render carrying the sha1 of the same job with no clip at all
# (ac92d2fd28154df1cb706af1c64c3908ce1e768b, both).
with tempfile.TemporaryDirectory() as td:
    import rack                                   # noqa: E402 -- the chain stage
    rng = np.random.default_rng(23)
    src = (rng.uniform(-0.3, 0.3, SR)).astype(np.float32)
    src_path = os.path.join(td, "clip.wav")
    engine.write_wav_f32(src_path, src, SR)
    CLIP = {"path": src_path, "start_sample": SR // 4, "offset_samples": 0,
            "dur_samples": SR, "gain_db": -3.0, "track_id": "t_a"}
    NOTES = [{"inst": "pluck", "midi": 60, "vel": 100, "start_sample": 0,
              "dur_samples": SR // 2, "gain_db": 0, "seed": 1, "track_id": "t_b"},
             {"inst": "drums", "midi": 36, "vel": 110, "start_sample": SR,
              "dur_samples": 100, "gain_db": 0, "seed": 2, "track_id": "t_b"}]
    MIX = {"stereo": True, "tracks": {"t_a": {}, "t_b": {}}, "returns": [],
           "master": {}, "spq": [[0.0, 0.5]]}
    BASE = {"sr": SR, "start_sample": 0, "n_samples": SR * 2}

    def _render(name, **kw):
        return engine.render(dict(BASE, out=os.path.join(td, name + ".wav"), **kw))

    chained = _render("chain_clip", notes=[], audio=[CLIP], mixer=MIX)
    bare = _render("chain_bare", notes=[], mixer=MIX)
    ok(f"a clip through a NO-OP mixer is AUDIBLE: peak {chained['peak']} (was 0.0)",
       chained["peak"] > 0.1 and chained["sha1"] != bare["sha1"])
    ok("...and the same job with no clip is still exactly silence, on the pinned sha1",
       bare["peak"] == 0.0
       and bare["sha1"] == "24fe969555a0783cba97f1f86fb1d604e9c7fc99")
    ok("both lanes count the clips they carried, in the same key",
       chained["clips"] == 1 and _render("p0_count", notes=[], audio=[CLIP])["clips"] == 1)

    # THE SEMANTICS ARE THE P0 PATH'S, TO THE BIT. A no-op chain is unity and
    # the pan law is centre-unity, so each channel of the chained render must
    # equal the mono render sample for sample. This is what "one implementation
    # of a clip into a buffer" means, measured rather than asserted:
    # rack._mix_audio calls engine.mix_clips, which is the code the line above
    # runs.
    p0 = _render("p0_clip", notes=[], audio=[CLIP])
    y_mono, _ = engine.read_wav_f32(os.path.join(td, "p0_clip.wav"))
    y_st = _read_stereo(os.path.join(td, "chain_clip.wav"))
    ok("chained L == the P0 mono render of the same clip, sample for sample",
       np.array_equal(y_st[0], y_mono))
    ok("...and L == R: a mono file lands in both channels, as a mono voice does",
       np.array_equal(y_st[0], y_st[1]))

    # THE SEAM PROOF, CARRIED THROUGH THE RACK. Same argument as the section
    # above: per-sample addition into a buffer that starts at absolute sample
    # 0, then a memoryless master, so a window IS a slice.
    parts = []
    for w0 in (0, SR):
        engine.render({"sr": SR, "start_sample": w0, "n_samples": SR, "notes": [],
                       "audio": [CLIP], "mixer": MIX,
                       "out": os.path.join(td, f"cw{w0}.wav")})
        parts.append(_read_stereo(os.path.join(td, f"cw{w0}.wav")))
    ok("region renders through the CHAIN stitch bit-identically to the whole "
       "render, with a clip in the mix",
       np.array_equal(np.hstack(parts), y_st))

    # BIT TRANSPARENCY, and it is the whole reason the placement was shared
    # rather than re-written. These sha1s were measured on the tree BEFORE the
    # chain lane could see a clip at all: every region cache on disk and the
    # region-seam proof are statements about exactly these bytes.
    ok("a job with NO clips renders byte-identically to before the fix, in every lane",
       _render("t_p0_notes", notes=NOTES)["sha1"]
       == "4e8f92db6aeece6aa42683e8f9555161a7d63761"
       and _render("t_ch_notes", notes=NOTES, mixer=MIX)["sha1"]
       == "7ab97c644ecd91e2b5813b47018109fb3c64eae1"
       and _render("t_ch_mono", notes=NOTES, mixer=dict(MIX, stereo=False))["sha1"]
       == "7ab97c644ecd91e2b5813b47018109fb3c64eae1")
    ok("...and the P0 lane's own clip renders did not move either (both pinned)",
       p0["sha1"] == "0d92a79a1e0dd6498be7f6d1d11071ffbf4127f5"
       and _render("t_p0_both", notes=NOTES, audio=[CLIP])["sha1"]
       == "6a45aa56a416a2c226800d0a633114a3ef839e3e")

    # A CLIP WITH NO track_id lands in the unnamed bus and is heard -- the same
    # rule _synth_notes reads a note's track by. Silence would be the one
    # answer this whole section exists to refuse.
    anon = dict(CLIP)
    anon.pop("track_id")
    ok("a clip with no track_id is still AUDIBLE (the unnamed bus, at unity)",
       _render("anon", notes=[], audio=[anon], mixer=MIX)["sha1"] == chained["sha1"])

    # THE STEMS. buses["tracks"] comes out of the same dry buffers, so a track
    # whose only content is a clip now has a lane -- and `silent_tracks` must
    # stop naming it, because voicelab.js's cache hit test is compared against
    # exactly that list on every render.
    st = rack.render_stems(dict(BASE, notes=NOTES, audio=[CLIP], mixer=MIX,
                                out_dir=os.path.join(td, "stems"), prefix="cp_"),
                           engine.SYNTHS, engine.TAILS)
    lanes = {s["track_id"]: s for s in st["stems"]}
    ok("render_stems writes a lane for the CLIP's track, not just the notes'",
       sorted(lanes) == ["t_a", "t_b"] and lanes["t_a"]["peak"] > 0.1,
       f"{sorted(lanes)}  silent={st['silent_tracks']}")
    ok("...and that track is no longer named silent", st["silent_tracks"] == [])
    ok("...and the lanes still sum to the pre-master mix, bit for bit",
       st["sums_to_mix"] is True and st["residual_db"] is None)

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
