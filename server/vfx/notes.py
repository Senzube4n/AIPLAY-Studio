"""Audio → notes. Automatic music transcription for the instrument rigs.

WHAT A CALLER MUST PASS
=======================
    python server/vfx/notes.py <job.json>          one JSON line to stdout

Two modes, chosen by `mode` (default "transcribe"):

    { "mode":   "transcribe",
      "audio":  "C:/…/other.flac",  ABSOLUTE path. Library names are resolved
                                    by the route, never here — this process
                                    picks no files (audiokeys.py's rule).
      "profile":"guitar",           "guitar" | "bass" — see THE PROFILES below
      "fingering": false,           true also runs the string/fret assigner on
                                    the transcription, in the same call
      "tuning": [40,45,50,55,59,64],  fingering only: open-string MIDI, low
                                    string first (default = standard EADGBE)
      "frets":  15 }                fingering only: highest playable fret

    { "mode":  "fingering",
      "notes": [{t,dur,midi,vel}…], notes from a previous transcribe (or from
                                    anywhere — the assigner only reads t/midi)
      "tuning": …, "frets": … }

Results:

    transcribe → { "ok": true,
                   "notes": [{"t":0.0,"dur":0.61,"midi":40,"vel":0.75,
                              "bend":2,"bendTime":0.197}, …],   (bend* only on
                                                                 collapsed bends)
                   "profile": "guitar", "count": …, "bends": …,
                   "filtered": {"raw": …, "gated": …, "deduped": …,
                                "collapsed": …},
                   "seconds": …, "ms": …, "importMs": … }
                 plus, with fingering:true:
                   "fingering": { "notes": [{…,"string":0-5,"fret":0-15,
                                             "finger":0-4}, …],
                                  "unplayable": …, "assigned": …,
                                  "meanPos": …, "maxPos": …, "maxJump": … }

    fingering  → { "ok": true, "notes": [annotated…], "unplayable": …, … }

    { "ok": false, "error": "…" } and exit 1 on any failure — including the
    one this file exists to make graceful: basic-pitch not being installed.
    That refusal NAMES the pip install for the exact python that refused, so
    the fix is a copy-paste, not a hunt.

THE RECIPE, AND WHY EVERY NUMBER IS LOAD-BEARING
================================================
Measured against four synthetic ground-truth pieces (Karplus-Strong guitar,
truth by construction) in the 2026-08-26 AMT eval. None of these numbers is a
style choice; each one was the difference between a working rig and a broken
one, so none is a caller-settable knob:

  · Basic Pitch (Spotify, Apache-2.0, the ONNX model inside the pip wheel),
    CPU. onset_threshold 0.4, frame_threshold 0.3.
  · minimum_note_length 40 ms for the guitar profile. The 127.7 ms DEFAULT
    silently deletes 16th-notes at 140 BPM (107 ms): recall 0.468 → 1.0 on the
    16ths piece. The single biggest win in the whole eval.
  · Post-filter, two rules: drop notes with confidence (velocity) < 0.40, then
    same-pitch re-onsets within 90 ms are one pluck (keep the louder). Basic
    Pitch's false positives have a clean signature — harmonic ghosts +12/+19/
    +24 semitones at LOW confidence plus sub-80 ms duplicate fragments — and
    the gate is also what keeps the FINGERING sane: without it the ghosts drag
    the DP's mean hand position from 1.6 to 2.9, force position-7 excursions,
    and create unplayables (83.3% assigned vs 100% filtered).
  · Semitone-staircase → bend collapse. A string bend comes out of Basic Pitch
    as a chromatic staircase: the start pitch on time, +1 semitone ~130 ms in
    (a sub-80 ms low-confidence fragment), the target ~190 ms in. Collapsed
    into ONE note with a `bend` attribute so the rig can slide a finger dot
    instead of drawing three phantom notes. Only ≥2-semitone staircases
    collapse: a 1-semitone chain is structurally identical to two honestly
    picked notes (the eval validated full-tone bends only).
  · Per-stem profiles. guitar: 60–2000 Hz, 40 ms. bass: 30–400 Hz, 60 ms, NO
    0.40 gate (bass stems run quieter; the gate starves them) — the frequency
    cap is what stops a bass stem reading an octave high. No octave folding
    after filtering: it was not needed on filtered output, and folding real
    12th/19th partials makes them worse, not better.

Measured with this exact recipe: note-level F1 0.933 / 0.914 / 0.807 / 0.889
on the four pieces (onset ±50 ms, pitch exact), 12/12 and 3/3 chord shapes,
0.03–0.09× realtime on CPU, ~280 MB peak. CAVEAT that must travel with those
numbers: the thresholds were tuned on clean synthetic tones. Real recorded
guitar (fret noise, palm mutes, distortion) is unvalidated — re-sweep before
any accuracy claim leaves engineering.

THE FINGERING ASSIGNER
======================
Dynamic programming over chord events (notes within 40 ms are one event).
Standard tuning EADGBE by default, frets 0–15. Cost = fret-hand travel +
string change − open-string bonus; a chord's fretted span ≤ 4 frets, distinct
strings only. `finger` is derived from the DP's own hand position (0 = open,
else 1–4 = fret − position + 1, clamped) — a drawing hint, not gospel.

Runs in whatever python the routes spawn for the other vfx tools. Imports of
basic-pitch (and its librosa/onnxruntime train) happen INSIDE the transcribe
path, so `fingering` mode and the refusal path never pay for them — and never
crash on their absence.
"""
from __future__ import annotations

import itertools
import json
import math
import os
import sys
import time

_IMPORT_BEGAN = time.time()

# CPU on purpose: the GPU serves production renders, and the model is 230 KB —
# transcription measured 0.03-0.09x realtime on CPU alone.
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")

STANDARD_TUNING = (40, 45, 50, 55, 59, 64)   # EADGBE, low string first
MAX_FRET = 15
CLUSTER_GAP = 0.04       # notes closer than this are one chord event
DEDUPE_MS = 90.0         # same-pitch re-onsets inside this are one pluck

# Bend staircase geometry, measured (see the module docstring).
BEND_SPAN = 0.25         # whole staircase fits inside this after the start onset
BEND_GAP = 0.06          # each step begins where the previous ends, ± this
BEND_FIRST_MAX = 0.18    # the start fragment (measured 139-151 ms)
BEND_STEP_MAX = 0.09     # intermediate fragments (measured 46-70 ms)

PROFILES = {
    # onset/frame thresholds are shared; the three that differ are the ones the
    # eval measured a reason for.
    "guitar": dict(min_note_ms=40.0, fmin=60.0, fmax=2000.0, vel_gate=0.40),
    "bass":   dict(min_note_ms=60.0, fmin=30.0, fmax=400.0, vel_gate=0.0),
}


def _f(v, fallback=0.0):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return fallback
    return f if math.isfinite(f) else fallback


# ---------------------------------------------------------------------------
# the post-filter (two rules) and the bend collapse
# ---------------------------------------------------------------------------

def filter_notes(notes, vel_gate=0.40, dedupe_ms=DEDUPE_MS):
    """Confidence gate, then same-pitch re-onset dedupe (keep the louder).

    Returns (kept, gated_count, deduped_count) so the caller can report what
    the filter cost — a filter whose work is invisible is a filter nobody can
    re-tune when real-world material needs it.
    """
    gated = [n for n in notes if n["vel"] >= vel_gate]
    n_gated = len(notes) - len(gated)
    gated.sort(key=lambda n: (n["t"], n["midi"]))
    out = []
    for n in gated:
        dup = None
        for m in reversed(out):
            if n["t"] - m["t"] > dedupe_ms / 1000.0:
                break
            if m["midi"] == n["midi"]:
                dup = m
                break
        if dup is None:
            out.append(n)
        elif n["vel"] > dup["vel"]:
            out.remove(dup)
            out.append(n)
    out.sort(key=lambda n: (n["t"], n["midi"]))
    return out, n_gated, len(gated) - len(out)


def collapse_bends(notes, span=BEND_SPAN, gap=BEND_GAP,
                   first_max=BEND_FIRST_MAX, step_max=BEND_STEP_MAX):
    """Chromatic staircases → one note with a bend attribute.

    A chain collapses when: each link is +1 semitone; each link starts where
    the previous note ENDS (± `gap` — the frame-level pitch track hands off,
    it does not overlap); the whole run fits in `span` after the start onset;
    the start fragment is short (≤ `first_max`) and every intermediate one
    shorter still (≤ `step_max`). Chains of 3+ only (bend ≥ 2 semitones):
    a 2-chain is structurally identical to two honestly picked notes, and the
    eval only validated full-tone bends. Long overlapping chord notes can
    never trip this — their ends are seconds away from the next onset.
    """
    notes = sorted(notes, key=lambda n: (n["t"], n["midi"]))
    used = [False] * len(notes)
    out = []
    for i, first in enumerate(notes):
        if used[i]:
            continue
        chain = [i]
        last = first
        while True:
            limit = first_max if len(chain) == 1 else step_max
            if last["dur"] > limit:
                break
            nxt = None
            for j in range(i + 1, len(notes)):
                if used[j]:
                    continue
                cand = notes[j]
                if cand["t"] - first["t"] > span:
                    break
                if (cand["midi"] == last["midi"] + 1
                        and abs(cand["t"] - (last["t"] + last["dur"])) <= gap):
                    nxt = j
                    break
            if nxt is None:
                break
            chain.append(nxt)
            last = notes[nxt]
        if len(chain) >= 3:
            for j in chain:
                used[j] = True
            final = notes[chain[-1]]
            merged = dict(first)
            merged["dur"] = round(final["t"] + final["dur"] - first["t"], 6)
            merged["bend"] = final["midi"] - first["midi"]
            merged["bendTime"] = round(final["t"] - first["t"], 6)
            out.append(merged)
        else:
            used[i] = True
            out.append(dict(first))
    out.sort(key=lambda n: (n["t"], n["midi"]))
    return out


# ---------------------------------------------------------------------------
# the DP fingering assigner
# ---------------------------------------------------------------------------

def _candidates(midi, tuning, max_fret):
    return [(s, midi - o) for s, o in enumerate(tuning) if 0 <= midi - o <= max_fret]


def _group_events(notes):
    """Indices sorted by onset, split into chord events on gaps > CLUSTER_GAP."""
    srt = sorted(range(len(notes)), key=lambda i: notes[i]["t"])
    events, cur = [], [srt[0]]
    for i in srt[1:]:
        if notes[i]["t"] - notes[cur[-1]]["t"] <= CLUSTER_GAP:
            cur.append(i)
        else:
            events.append(cur)
            cur = [i]
    events.append(cur)
    return events


def _event_shapes(notes, idxs, tuning, max_fret):
    """Every playable (string, fret) assignment of one event, with its cost."""
    cands, playable = [], []
    for i in idxs:
        c = _candidates(notes[i]["midi"], tuning, max_fret)
        if c:
            cands.append(c)
            playable.append(i)
    unplayable = [i for i in idxs if not _candidates(notes[i]["midi"], tuning, max_fret)]
    if not cands:
        return [], unplayable
    shapes = []
    for combo in itertools.product(*cands):
        strings = [s for s, _ in combo]
        if len(set(strings)) != len(strings):
            continue
        fretted = [f for _, f in combo if f > 0]
        if fretted and max(fretted) - min(fretted) > 4:
            continue
        pos = min(fretted) if fretted else 0
        intrinsic = (0.3 * (sum(fretted) / max(len(fretted), 1))
                     - 0.5 * (len(combo) - len(fretted)))
        shapes.append(dict(assign=tuple(zip(playable, strings, [f for _, f in combo])),
                           pos=pos, intrinsic=intrinsic))
    return shapes, unplayable


def assign_fingering(notes, tuning=STANDARD_TUNING, max_fret=MAX_FRET):
    """DP over chord events. Returns (assign, unplayable, positions).

    `assign` maps note index → (string, fret); `positions` is the hand
    position per event, the number the eval's stability claim is about.
    """
    if not notes:
        return {}, [], []
    tuning = list(tuning)
    events = _group_events(notes)
    all_unplayable, per_event = [], []
    for idxs in events:
        shapes, unpl = _event_shapes(notes, idxs, tuning, max_fret)
        all_unplayable += unpl
        if not shapes:
            # The whole event is impossible as one shape (span) — its playable
            # notes are unassigned too, and honestly reported as such.
            all_unplayable += [i for i in idxs if i not in unpl]
            continue
        shapes.sort(key=lambda s: s["intrinsic"])
        per_event.append(shapes[:24])          # bound the DP

    if not per_event:
        return {}, all_unplayable, []
    prev = [(s["intrinsic"], s, None) for s in per_event[0]]
    layers = [prev]
    for shapes in per_event[1:]:
        cur = []
        for s in shapes:
            best = None
            for k, (pc, ps, _) in enumerate(prev):
                travel = abs(s["pos"] - ps["pos"])
                schg = 0.2 * abs(
                    (sum(a[1] for a in s["assign"]) / len(s["assign"]))
                    - (sum(a[1] for a in ps["assign"]) / len(ps["assign"])))
                c = pc + travel + schg + s["intrinsic"]
                if best is None or c < best[0]:
                    best = (c, s, k)
            cur.append(best)
        layers.append(cur)
        prev = cur

    k = min(range(len(prev)), key=lambda i: prev[i][0])
    chosen = []
    for layer in reversed(layers):
        _cost, shape, back = layer[k]
        chosen.append(shape)
        if back is None:
            break
        k = back
    chosen.reverse()

    assign = {}
    positions = []
    for shape in chosen:
        positions.append(shape["pos"])
        for i, s, f in shape["assign"]:
            assign[i] = (s, f, shape["pos"])
    return assign, all_unplayable, positions


def annotate_fingering(notes, tuning=STANDARD_TUNING, max_fret=MAX_FRET):
    """The result shape a caller wants: every note carrying string/fret/finger.

    Unplayable notes (outside the instrument's range, or an impossible chord
    span) come back WITHOUT string/fret and are named by index — dropping them
    silently is how a rig draws a hand that skips notes and nobody knows why.
    """
    assign, unplayable, positions = assign_fingering(notes, tuning, max_fret)
    out = []
    for i, n in enumerate(notes):
        m = dict(n)
        got = assign.get(i)
        if got is not None:
            s, f, pos = got
            m["string"] = s
            m["fret"] = f
            m["finger"] = 0 if f == 0 else max(1, min(4, f - pos + 1))
        out.append(m)
    jumps = [abs(b - a) for a, b in zip(positions, positions[1:])]
    stats = {
        "assigned": len(assign),
        "unplayable": sorted(unplayable),
        "meanPos": round(sum(positions) / len(positions), 2) if positions else 0,
        "maxPos": max(positions) if positions else 0,
        "maxJump": max(jumps) if jumps else 0,
    }
    return out, stats


# ---------------------------------------------------------------------------
# transcription
# ---------------------------------------------------------------------------

def _predict(path, profile):
    """Basic Pitch over one file. Imported HERE so its absence is a refusal
    with a fix in it, not a crash — and so `fingering` mode never pays the
    librosa/onnxruntime import bill."""
    if os.environ.get("AIPLAY_NOTES_NO_BASIC_PITCH") == "1":
        raise RuntimeError(_missing_msg("disabled by AIPLAY_NOTES_NO_BASIC_PITCH=1 (test override)"))
    try:
        import contextlib
        # basic_pitch prints progress to stdout; this process's stdout is a
        # one-JSON-line contract, so everything it says goes to stderr.
        with contextlib.redirect_stdout(sys.stderr):
            from basic_pitch.inference import predict
    except ImportError as exc:
        raise RuntimeError(_missing_msg(str(exc))) from exc
    p = PROFILES[profile]
    with contextlib.redirect_stdout(sys.stderr):
        _model_output, _midi, events = predict(
            path,
            onset_threshold=0.4, frame_threshold=0.3,
            minimum_note_length=p["min_note_ms"],
            minimum_frequency=p["fmin"], maximum_frequency=p["fmax"],
        )
    return [
        dict(t=round(float(s), 6), dur=round(float(e - s), 6),
             midi=int(m), vel=round(float(a), 4))
        for (s, e, m, a, _bends) in events
    ]


def _missing_msg(detail):
    return (
        "Automatic transcription needs the basic-pitch package, which is not "
        f"available in this python ({sys.executable}). Install it with:\n"
        f'  "{sys.executable}" -m pip install basic-pitch\n'
        "(Apache-2.0, ~2 MB plus its audio deps; the ONNX model ships inside "
        f"the wheel. Everything else in the VFX tab works without it.) [{detail}]"
    )


def transcribe(job):
    began = time.time()
    path = job.get("audio") or job.get("path") or job.get("in")
    if not path:
        raise ValueError("job needs an 'audio' path")
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    profile = str(job.get("profile") or "guitar").lower()
    if profile not in PROFILES:
        raise ValueError(f"No profile \"{profile}\". Profiles: {', '.join(PROFILES)}.")

    raw = _predict(path, profile)
    kept, n_gated, n_deduped = filter_notes(raw, vel_gate=PROFILES[profile]["vel_gate"])
    notes = collapse_bends(kept)
    n_collapsed = len(kept) - len(notes)

    result = {
        "ok": True,
        "profile": profile,
        "notes": notes,
        "count": len(notes),
        "bends": sum(1 for n in notes if n.get("bend")),
        "filtered": {"raw": len(raw), "gated": n_gated,
                     "deduped": n_deduped, "collapsed": n_collapsed},
        "seconds": round(max((n["t"] + n["dur"]) for n in notes), 3) if notes else 0.0,
        "importMs": _IMPORT_MS,
        "ms": int((time.time() - began) * 1000),
    }
    if job.get("fingering"):
        annotated, stats = annotate_fingering(
            notes, tuning=_tuning_of(job), max_fret=_frets_of(job))
        result["fingering"] = {"notes": annotated, **stats}
    return result


def _tuning_of(job):
    t = job.get("tuning")
    if t is None:
        return STANDARD_TUNING
    if (not isinstance(t, list) or not (1 <= len(t) <= 12)
            or not all(isinstance(v, (int, float)) and 0 <= int(v) <= 127 for v in t)):
        raise ValueError("tuning must be a list of 1-12 MIDI numbers, low string first.")
    return [int(v) for v in t]


def _frets_of(job):
    n = int(_f(job.get("frets"), MAX_FRET))
    if not (3 <= n <= 30):
        raise ValueError(f"frets must be 3-30 — got {n}.")
    return n


def fingering_mode(job):
    began = time.time()
    notes = job.get("notes")
    if not isinstance(notes, list) or not notes:
        raise ValueError("fingering mode needs a non-empty 'notes' list.")
    clean = []
    for i, n in enumerate(notes):
        if not isinstance(n, dict) or not isinstance(n.get("midi"), (int, float)):
            raise ValueError(f"notes[{i}] needs at least t and midi.")
        m = dict(n)
        m["t"] = _f(n.get("t"), 0.0)
        m["dur"] = max(0.0, _f(n.get("dur"), 0.0))
        m["midi"] = int(n["midi"])
        m["vel"] = _f(n.get("vel"), 1.0)
        clean.append(m)
    annotated, stats = annotate_fingering(
        clean, tuning=_tuning_of(job), max_fret=_frets_of(job))
    return {"ok": True, "notes": annotated, **stats,
            "importMs": _IMPORT_MS, "ms": int((time.time() - began) * 1000)}


_IMPORT_MS = int((time.time() - _IMPORT_BEGAN) * 1000)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        if not argv:
            raise ValueError("usage: notes.py <job.json>")
        with open(argv[0], encoding="utf-8") as fh:
            job = json.load(fh)
        mode = str(job.get("mode") or "transcribe")
        if mode == "transcribe":
            result = transcribe(job)
        elif mode == "fingering":
            result = fingering_mode(job)
        else:
            raise ValueError(f"No mode \"{mode}\". Modes: transcribe, fingering.")
    except Exception as exc:                            # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), flush=True)
        return 1
    print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
