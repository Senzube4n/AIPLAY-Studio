"""Render a Studio timeline EXACTLY, offline, instead of recording it in real time.

WHY THIS EXISTS, and why it does not replace the other path.

Studio exports by playing the timeline into a canvas and capturing it with
MediaRecorder. That was a deliberate choice — it needs nothing installed — and
it is documented at length in studio.js. But it is a REAL-TIME capture, and
real time is a hard ceiling:

  - Measured on this machine at 1920x1088: the render sustains 17 fps against a
    requested 24. Caching the vignette bought 2.7%; switching VP9 to VP8 bought
    2%. Neither is the bottleneck — the whole draw-and-capture path is. Every
    export is therefore judder, and no setting fixes it.
  - A cut lands black whenever the incoming clip has not decoded yet, because
    the frame starts with a black fill and a clip with readyState < 2 is skipped.
    studio.js now holds the previous frame to cover that, which is a patch over
    a symptom that only exists because frames are captured as they are painted.
  - An 8-second clip costs 8 seconds. Five videos is nine minutes of sitting
    still, and any mistake costs the whole nine again.

None of that is true offline. ffmpeg composes from the source files at their own
frame rate, so the output is exactly `fps`, cuts are exact, and a 148-second
video takes far less than 148 seconds to make.

⚠ THIS IS AN ADDITION, NOT A REPLACEMENT. The MediaRecorder path stays as the
one that works with nothing installed. This one is offered when ffmpeg is
present, which is the only reason it is allowed to depend on it.

THE GRAPH. A black base of the full length, then every clip overlaid into its
own time window:

    color=black:WxH  ─┐
    clip 0 ──scale/crop/setpts──┤overlay enable='between(t,s,e)'──┐
    clip 1 ──────────────────────────────────────────────────────┤overlay──▶
    ...

Overlay rather than concat because the timeline has GAPS — coverage is 0.96 on
sub-rosa — and concat would silently close them, shifting every later cut off
the beat it was built for. A gap has to stay a gap.
"""
import json
import os
import shlex
import subprocess
import sys
import urllib.parse


def _name_from_src(src):
    """`/api/clip/mv_x.mp4` -> `mv_x.mp4`. The doc stores URLs, not paths."""
    if not src:
        return None
    tail = src.rstrip("/").split("/")[-1]
    return urllib.parse.unquote(tail.split("#")[0].split("?")[0])


def beat_strengths(beats_json):
    """Per-beat BASS energy, normalised 0..1.

    ⚠ WHY THIS REPLACED A CONSTANT PULSE. The first version pulsed on every beat
    of a constant tempo for the whole song, and Senzu's note was exact: it is
    fine on the bass, wrong where there is no bass to hear. A pulse with nothing
    under it does not read as an edit, it reads as an encode fault — which is
    the same reason the whole effect is gated on beat confidence.

    beats.py already publishes everything needed and nobody was reading it: the
    beat times, the BASS band envelope (20-160 Hz, kick and sub), and the frame
    rate that envelope is sampled at. This takes the bass peak in a short window
    around each beat and normalises against the loudest beat in the song, so a
    quiet verse pulses faintly or not at all and a drop pulses fully.
    """
    beats = beats_json.get("beats") or []
    bands = beats_json.get("bands") or {}
    bass = bands.get("bass") or []
    fps = float(beats_json.get("envFps") or 0)
    if not beats or not bass or fps <= 0:
        return []
    half = 0.06                      # the window a kick actually occupies
    out = []
    for t in beats:
        i0 = max(0, int((t - half) * fps))
        i1 = min(len(bass), int((t + half) * fps) + 1)
        out.append((float(t), max(bass[i0:i1]) if i1 > i0 else 0.0))
    peak = max((v for _, v in out), default=0.0)
    if peak <= 0:
        return []
    # ⚠ SQUARED, and the reason is in the data. On Bone Waffle 83% of beats sit
    # above a 0.35 floor — the track simply has bass nearly everywhere — so a
    # LINEAR response pulses on almost every beat and reads as a metronome,
    # which is the complaint the gate was meant to answer. Squaring pushes the
    # middle down hard (0.6 becomes 0.36) while leaving real hits alone, so the
    # effect follows the loud ones and lets the rest pass.
    return [(t, (v / peak) ** 2) for t, v in out]


def zoom_filter(W, H, fps, clip_start, clip_dur, amp=0.0, strengths=None, floor=0.30, k=7.0):
    """A zoom impulse on each STRONG beat inside this clip, and nothing between.

    Only beats above `floor` of the song's loudest get a pulse at all, and each
    one is scaled by its own bass energy — so the effect follows the arrangement
    instead of running like a metronome over the quiet parts.

    Terms are emitted per CLIP, in clip-local time, so an eleven-beat clip
    carries at most eleven short terms rather than the whole song's worth.

    ⚠ `d=1` is what makes zoompan work on video at all: it is written for stills
    and holds each input frame for `d` output frames, so the default turns a
    five-second clip into a slideshow of its own first frame.
    """
    if amp <= 0 or not strengths:
        return ""
    terms = []
    for t, sv in strengths:
        if sv < floor:
            continue
        local = t - clip_start
        if local < -0.05 or local > clip_dur:
            continue
        local = max(0.0, local)
        terms.append(f"{sv:.3f}*if(gte(on/{fps:.4f},{local:.3f}),exp(-{k}*(on/{fps:.4f}-{local:.3f})),0)")
    if not terms:
        return ""
    z = f"1+{amp:.4f}*({'+'.join(terms)})"
    return f"zoompan=z='{z}':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={W}x{H}:fps={fps},"


def build(doc, clips_dir, audio_dir, out_path, fps=None, crf=18, encoder="h264_nvenc", fade=0.0,
          beat_zoom=0.0, strengths=None, grade=(1.09, 1.15, 1.015)):
    out = doc.get("out") or {}
    W = int(out.get("w") or 1920)
    H = int(out.get("h") or 1080)
    FPS = int(fps or out.get("fps") or 24)

    vitems, aitem = [], None
    for tr in doc.get("tracks") or []:
        if tr.get("muted"):
            continue
        for it in tr.get("items") or []:
            if tr.get("kind") == "video":
                vitems.append(it)
            elif aitem is None:
                aitem = it
    vitems.sort(key=lambda i: float(i.get("start") or 0))

    total = 0.0
    for it in vitems + ([aitem] if aitem else []):
        total = max(total, float(it.get("start") or 0) + float(it.get("dur") or 0))
    if total <= 0:
        return {"error": "empty timeline"}

    args = ["ffmpeg", "-hide_banner", "-v", "error", "-y"]
    # The base is a real input so its duration, size and rate are unambiguous.
    args += ["-f", "lavfi", "-t", f"{total:.3f}", "-i", f"color=c=black:s={W}x{H}:r={FPS}"]

    used, missing = [], []
    for it in vitems:
        name = _name_from_src(it.get("src"))
        p = os.path.join(clips_dir, name) if name else None
        if not p or not os.path.exists(p):
            missing.append(name)
            continue
        # Decode only the slice this item shows: -ss before -i seeks, -t bounds.
        args += ["-ss", f"{float(it.get('inPoint') or 0):.3f}",
                 "-t", f"{float(it.get('dur') or 0):.3f}", "-i", p]
        used.append(it)

    song = None
    if aitem:
        nm = _name_from_src(aitem.get("src"))
        cand = os.path.join(audio_dir, nm) if nm else None
        if cand and os.path.exists(cand):
            song = cand
            args += ["-ss", f"{float(aitem.get('inPoint') or 0):.3f}",
                     "-t", f"{float(aitem.get('dur') or total):.3f}", "-i", cand]

    # HOLD THE LAST FRAME to the end of the slot.
    #
    # Every clip is SHORTER than the slot it was built for. LTX quantises length
    # to 8n+1 frames and rounds DOWN, so a 5.5 s scene comes back as 129 frames
    # (5.375 s) and the slot's last 3 frames have no picture at all. Measured on
    # the finished The Long Ascent: eight black runs, three frames each, one
    # immediately before every cut at -0.12 s. The source clips are clean --
    # zero black frames at either edge -- so this is entirely a slot-versus-
    # material mismatch, and it fires once per cut on every video made so far.
    #
    # `stop_mode=clone` repeats the final frame; the overlay's `enable` window
    # bounds it to the slot, so this fills exactly the shortfall and no more.
    # A held frame for 3 frames is invisible. Black is not.
    #
    # One second is simply more than any observed shortfall (0.125 s), not a
    # guess at the right amount -- `enable` decides where it actually ends.
    HOLD = 1.0

    # BRIDGE a short hole, leave a long one visible.
    #
    # What is left after the hold above is genuine: stretches of timeline with no
    # clip on them at all (coverage is 0.96 on sub-rosa). Holding the outgoing
    # frame across a few of those frames reads as a held shot; holding it across
    # two seconds reads as a freeze, and hiding a hole that size would disguise
    # missing footage as a directing choice. So bridge up to BRIDGE_MAX and let
    # anything longer stay black, where it is obvious and gets fixed by
    # rendering more coverage rather than by the exporter.
    BRIDGE_MAX = 0.6

    starts = [float(i.get("start") or 0) for i in used]
    chains, prev = [], "[0:v]"
    for n, it in enumerate(used, start=1):
        s = float(it.get("start") or 0)
        e = s + float(it.get("dur") or 0)
        nxt = next((x for x in starts if x > s + 1e-6), None)
        if nxt is not None and 0 < nxt - e <= BRIDGE_MAX:
            e = nxt
        # CROSS-DISSOLVE. The outgoing clip stays up while the incoming one
        # fades in over it, so the cut is a dissolve rather than a hard switch.
        # Only possible because alignFrames now rounds UP: every clip overshoots
        # its slot by a few frames, and that overshoot IS the handle. Extending
        # the outgoing window past its own end is therefore showing real frames,
        # not a frozen one -- as long as the fade is no longer than the handle.
        if fade > 0 and nxt is not None:
            e = max(e, min(nxt + fade, s + float(it.get("srcDur") or it.get("dur") or 0)))
        # cover-crop to the output frame, then place this clip at its start time
        chains.append(
            # COLOUR, STATED. Every clip ComfyUI writes is BT.601-matrix,
            # limited-range and UNTAGGED (PyAV 17: RGB -> yuv420p with no
            # colourspace set; probed 2026-09-12, pure red encodes 81/90/240).
            # Players assume BT.709 for an HD frame, so untouched those clips
            # play with reds pushed to orange and greens dimmed. ffmpeg reads
            # an untagged input as 601 (in=auto), converts to 709 here, and
            # the output is tagged below so nothing downstream has to guess.
            # The 1.098x-11 luma remap measured cut-vs-clip was NOT a range
            # error: it is contrast=1.09 in the grade, by arithmetic
            # (1.09*(Y-128)+128 = 1.09*Y - 11.5).
            f"[{n}:v]scale={W}:{H}:force_original_aspect_ratio=increase"
            f":in_color_matrix=auto:out_color_matrix=bt709:in_range=auto:out_range=tv,"
            f"crop={W}:{H},fps={FPS},"
            + zoom_filter(W, H, FPS, s, float(it.get("dur") or 0), beat_zoom, strengths)
            + f"tpad=stop_mode=clone:stop_duration={HOLD},"
            + (f"format=yuva420p,fade=t=in:st=0:d={fade:.3f}:alpha=1," if (fade > 0 and n > 1) else "")
            + f"setpts=PTS-STARTPTS+{s:.3f}/TB[v{n}]"
        )
        tag = f"[o{n}]" if n < len(used) else "[vout]"
        chains.append(f"{prev}[v{n}]overlay=eof_action=pass:enable='between(t,{s:.3f},{e:.3f})'{tag}")
        prev = tag
    if not used:
        return {"error": "no clip files found on disk", "missing": missing}
    if prev != "[vout]":
        chains.append(f"{prev}null[vout]")

    # A FINAL GRADE — a little more contrast, a little more colour.
    #
    # Applied ONCE to the assembled picture rather than per clip: it is the same
    # adjustment for every shot, nineteen copies of one filter is nineteen
    # chances for them to drift apart, and the eye reads a film's grade as one
    # decision.
    #
    # ⚠ GAMMA LIFTS WHILE CONTRAST PUSHES. These videos are candle-lit night
    # interiors — most of the frame is shadow — and contrast alone would crush
    # that shadow to black and lose the set. A touch of gamma above 1 opens the
    # low end back up so the extra contrast lands on the midtones where the
    # subject is, rather than eating the background.
    #
    # Deliberately small. Senzu asked for "not too much", and the difference
    # between enriching a picture and cooking it is roughly 6% and 20%.
    # ⚠ THE PUSH IS A CURVE WITH PINNED ENDS, NOT eq's contrast, AND THAT IS THE
    # WHOLE OF THIS FIX. `eq=contrast=c` is 1.09*(Y-128)+128 = 1.09*Y - 11.5,
    # which hits zero at code 10.5: measured on a 256-step ramp, inputs 0..12 all
    # came out as exactly 0 and legal black (16) came out as 5. On a candle-lit
    # clip that turned 0.03% pure-black pixels into 19.31% — flat black patches
    # with hard edges, in 45 of 52 frames sampled across a finished film.
    #
    # The comment above already predicted it ("contrast alone would crush that
    # shadow to black and lose the set") and answered with gamma 1.015, which at
    # the bottom of the range recovers almost nothing. The remedy was too small
    # to test its own warning.
    #
    # A curve does the same job with somewhere to put the shadows: identical
    # midtone slope (1.042) and midtones (128 -> 128), highlights within a code
    # (200 -> 205 against 206), and 0.16% crushed instead of 19.31%.
    if grade:
        c, sat, gam = grade
        # The control points are derived from `c` so --grade keeps meaning what
        # it meant; at c=1.09 they are the pair measured above.
        toe_in, sh_in = 0.12, 0.88
        toe_out = max(0.0, toe_in - (c - 1.0) * 0.0556)
        sh_out = min(1.0, sh_in + (c - 1.0) * 0.222)
        mid_out = 0.5 + (c - 1.0) * 0.0556
        curve = (f"0/0 {toe_in:.3f}/{toe_out:.4f} 0.5/{mid_out:.4f} "
                 f"{sh_in:.3f}/{sh_out:.4f} 1/1")
        # ⚠ AND IT RUNS AT SIXTEEN BITS, WHICH IS THE OTHER HALF OF THIS FIX.
        # `curves` is a 256-entry LUT and `eq` is a gamma pass; handed 8-bit
        # frames they merge neighbouring codes, and in a candle-lit shadow the
        # whole signal IS a handful of neighbouring codes. The result is not
        # clipped, it is flattened — which looks the same on screen and is
        # invisible to a test that counts zeros, so the previous repair passed.
        #
        # Measured across five flagged clips at three moments each: NINE curve
        # shapes (toe slopes 0.96 through 1.20, plus two pinned to the identity
        # in the shadows) all scored 3.67% dead. A curve that is the identity
        # function below 0.25 cannot flatten a shadow, so the shape was never
        # the mechanism. The same grade at 16-bit scores 0.62% — better than
        # not grading at all.
        #
        # It costs nothing downstream: `-pix_fmt yuv420p` still tells the
        # encoder what to write, so the depth lives only inside the graph. And
        # it sits HERE rather than at the top, so decode, scale and concat stay
        # 8-bit — they are 8-bit sources and no arithmetic there needs the room.
        chains.append(f"[vout]format=yuv444p16le,curves=all='{curve}',"
                      f"eq=saturation={sat}:gamma={gam}[vgraded]")
        vmap = "[vgraded]"
    else:
        vmap = "[vout]"

    # THE TAGS RIDE ON THE FRAMES. `-color_primaries` / `-color_trc` on the
    # command line do NOT reach libx264's VUI when the filter graph's frames
    # still say "unspecified" for them (measured 2026-09-12: matrix and range
    # landed, primaries and transfer did not); stamped onto the frames here,
    # all four land, with or without the flags below. The flags stay for the
    # encoders that read the context rather than the frame.
    chains.append(f"{vmap}setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[vtagged]")
    vmap = "[vtagged]"

    args += ["-filter_complex", ";".join(chains), "-map", vmap]
    if song:
        args += ["-map", f"{len(used) + 1}:a", "-c:a", "aac", "-b:a", "192k"]
    args += ["-t", f"{total:.3f}", "-r", str(FPS)]

    if encoder == "h264_nvenc":
        args += ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", str(crf), "-b:v", "0"]
    else:
        args += ["-c:v", "libx264", "-preset", "medium", "-crf", str(crf)]
    args += ["-pix_fmt", "yuv420p",
             # The tags the scale filter above made true. Without them the cut
             # is as untagged as its sources, and the 601->709 conversion buys
             # nothing in a player that guesses.
             "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
             "-color_range", "tv",
             "-movflags", "+faststart", out_path]

    return {"args": args, "clips": len(used), "missing": missing,
            "total": round(total, 3), "w": W, "h": H, "fps": FPS, "song": bool(song)}


def main():
    if len([a for a in sys.argv[1:] if not a.startswith("--")]) < 3:
        print(json.dumps({"error": "usage: timeline_render.py <project.json> <clips_dir> <audio_dir> "
                                   "[out.mp4] [--fade=0.25] [--beatzoom=0.015 --beats=<beats.json>] "
                                   "[--grade=1.09:1.15:1.015 | --nograde]"}))
        return 1
    argv = [a for a in sys.argv[1:] if not a.startswith("--")]
    fade = 0.0
    beat_zoom = 0.0
    beats_src = None
    grade = (1.09, 1.15, 1.015)         # contrast, saturation, gamma
    for a in sys.argv[1:]:
        if a.startswith("--fade="):
            fade = float(a.split("=", 1)[1])
        elif a.startswith("--beatzoom="):
            beat_zoom = float(a.split("=", 1)[1])
        elif a.startswith("--beats="):
            beats_src = a.split("=", 1)[1]
        elif a == "--nograde":
            grade = None
        elif a.startswith("--grade="):
            # contrast:saturation:gamma
            grade = tuple(float(x) for x in a.split("=", 1)[1].split(":"))
    proj, clips_dir, audio_dir = argv[0], argv[1], argv[2]
    out_path = argv[3] if len(argv) > 3 else os.path.splitext(proj)[0] + ".mp4"
    try:
        doc = json.load(open(proj, encoding="utf-8"))
    except Exception as e:                                   # noqa: BLE001
        print(json.dumps({"error": f"could not read the project: {e}"}))
        return 1

    strengths = None
    if beat_zoom > 0 and beats_src:
        try:
            strengths = beat_strengths(json.load(open(beats_src, encoding="utf-8")))
        except Exception:
            strengths = None      # no analysis is a flat video, never a crash
    plan = build(doc, clips_dir, audio_dir, out_path, fade=fade,
                 beat_zoom=beat_zoom, strengths=strengths, grade=grade)
    if "error" in plan:
        print(json.dumps(plan))
        return 1

    r = subprocess.run(plan["args"], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        # NVENC can be unavailable even when the encoder is listed (driver, or
        # every session already holding an encode). Fall back rather than fail.
        plan2 = build(doc, clips_dir, audio_dir, out_path, encoder="libx264", fade=fade,
                      beat_zoom=beat_zoom, strengths=strengths, grade=grade)
        r = subprocess.run(plan2["args"], capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode != 0:
            print(json.dumps({"error": (r.stderr or "ffmpeg failed")[-600:],
                              "cmd": " ".join(shlex.quote(a) for a in plan2["args"])[:900]}))
            return 1
        plan["encoder"] = "libx264 (nvenc refused)"
    else:
        plan["encoder"] = "h264_nvenc"

    plan.pop("args", None)
    plan["out"] = out_path
    plan["bytes"] = os.path.getsize(out_path) if os.path.exists(out_path) else 0
    print(json.dumps(plan))
    return 0


if __name__ == "__main__":
    sys.exit(main())
