"""Unit tests for the editing engine in server/imagetools.py.

apply_edit is the single implementation behind the Images screen AND the MCP
tools — the browser only previews with CSS approximations, so these pixels are
the product. The invariants tested here are the ones a plausible refactor
would break silently: enhancers that flatten transparency, a rotate that
resamples, a chroma key that eats colors far from the key.

apply_edit speaks files, so each case round-trips a tiny synthetic RGBA image
through PNG (lossless — RGBA survives exactly) in a temp directory. Its JSON
status line is swallowed so the output here stays readable.

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/imagetools_test.py

PIL/numpy/scipy only, same as imagetools.py itself.
"""
import contextlib
import io
import json
import os
import sys
import tempfile

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import imagetools  # noqa: E402

PASS = FAIL = 0


def eq(name, got, want):
    global PASS, FAIL
    if got == want:
        PASS += 1
        print(f"  ok    {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}\n          got {got!r}, wanted {want!r}")


def run(im, ops, tmp):
    """Round-trip an in-memory RGBA image through apply_edit."""
    src = os.path.join(tmp, "in.png")
    dst = os.path.join(tmp, "out.png")
    im.save(src)
    with contextlib.redirect_stdout(io.StringIO()):
        imagetools.apply_edit({"in": src, "out": dst, "ops": ops})
    return Image.open(dst).convert("RGBA")


def gradient_rgba(w=32, h=24):
    """Every channel varied, alpha included — a flat test image proves nothing."""
    a = np.zeros((h, w, 4), dtype=np.uint8)
    a[..., 0] = np.linspace(0, 255, w, dtype=np.uint8)[None, :]
    a[..., 1] = np.linspace(255, 0, h, dtype=np.uint8)[:, None]
    a[..., 2] = 128
    a[..., 3] = np.linspace(10, 245, w, dtype=np.uint8)[None, :]
    return Image.fromarray(a, "RGBA")


print("\nimagetools\n")

with tempfile.TemporaryDirectory() as tmp:

    # -- crop ---------------------------------------------------------------
    out = run(gradient_rgba(), {"crop": {"x": 2, "y": 3, "w": 10, "h": 8}}, tmp)
    eq("crop yields the asked-for width", out.width, 10)
    eq("crop yields the asked-for height", out.height, 8)
    # The guard: a degenerate crop is ignored rather than producing a sliver.
    out = run(gradient_rgba(), {"crop": {"x": 0, "y": 0, "w": 4, "h": 4}}, tmp)
    eq("a crop 4px or under is ignored", (out.width, out.height), (32, 24))
    # A crop past the edge clamps to the image rather than erroring.
    out = run(gradient_rgba(), {"crop": {"x": 26, "y": 0, "w": 10, "h": 10}}, tmp)
    eq("an overhanging crop clamps to the edge", (out.width, out.height), (6, 10))

    # -- rotate -------------------------------------------------------------
    out = run(gradient_rgba(), {"rotate": 90}, tmp)
    eq("rotate 90 swaps width and height", (out.width, out.height), (24, 32))
    src = gradient_rgba()
    out = run(src, {"rotate": 180}, tmp)
    eq("rotate 180 keeps the size", (out.width, out.height), (32, 24))
    eq("two half-turns of the corner pixel land where expected",
       out.getpixel((31, 23)), src.getpixel((0, 0)))
    out = run(src, {"rotate": 360}, tmp)
    eq("rotate 360 is a no-op", np.array_equal(np.asarray(out), np.asarray(src)), True)

    # -- enhancers must not touch transparency ------------------------------
    # The RGBA convert / split / merge dance in apply_edit exists exactly so
    # that Brightness cannot scale alpha along with the pixels. A refactor to
    # "just enhance the RGBA image" passes every opaque test and flattens
    # every cutout.
    src = gradient_rgba()
    out = run(src, {"brightness": 150}, tmp)
    eq("brightness changes the pixels",
       np.array_equal(np.asarray(out)[..., :3], np.asarray(src)[..., :3]), False)
    eq("brightness leaves alpha untouched",
       np.array_equal(np.asarray(out)[..., 3], np.asarray(src)[..., 3]), True)

    # -- chroma key ---------------------------------------------------------
    # Half pure key green, half red: the key half must go transparent, the
    # red half — far outside tolerance plus softness — must stay fully opaque.
    a = np.zeros((8, 8, 4), dtype=np.uint8)
    a[..., 3] = 255
    a[:, :4] = [0, 255, 0, 255]
    a[:, 4:] = [255, 0, 0, 255]
    out = run(Image.fromarray(a, "RGBA"),
              {"chromaKey": {"color": [0, 255, 0], "tolerance": 25, "softness": 10}}, tmp)
    res = np.asarray(out)
    eq("an exact-key pixel goes fully transparent", int(res[4, 1, 3]), 0)
    eq("a distant color stays fully opaque", int(res[4, 6, 3]), 255)
    eq("the distant color's pixels are not despilled", tuple(res[4, 6, :3]), (255, 0, 0))

    # -- curves -------------------------------------------------------------
    # An identity master curve must be exactly a no-op: PCHIP through (0,0)
    # and (255,255) is the straight line, and the LUT it bakes maps i -> i.
    # Anything else means the interpolation or the uint8 cast is drifting
    # pixels on every "untouched" save.
    src = gradient_rgba()
    out = run(src, {"curves": {"master": [[0, 0], [255, 255]]}}, tmp)
    eq("an identity master curve changes nothing",
       np.array_equal(np.asarray(out), np.asarray(src)), True)
    out = run(src, {"curves": {"r": [[0, 0], [255, 255]], "g": [[0, 0], [255, 255]],
                               "b": [[0, 0], [255, 255]]}}, tmp)
    eq("identity per-channel curves change nothing",
       np.array_equal(np.asarray(out), np.asarray(src)), True)
    # And a non-identity curve proves the LUT is actually applied.
    out = run(src, {"curves": {"master": [[0, 255], [255, 0]]}}, tmp)
    inv = np.asarray(out)[..., :3].astype(int)
    orig = np.asarray(src)[..., :3].astype(int)
    eq("an inverting curve inverts (within LUT rounding)",
       bool(np.abs((255 - orig) - inv).max() <= 1), True)

    # -- posterize ----------------------------------------------------------
    # A 256-level ramp in, few levels out. The count is per-channel distinct
    # VALUES: posterize keeps the top bits, so levels can only shrink.
    ramp = np.zeros((16, 256, 4), dtype=np.uint8)
    ramp[..., 0] = np.arange(256, dtype=np.uint8)[None, :]
    ramp[..., 1] = ramp[..., 0]
    ramp[..., 2] = ramp[..., 0]
    ramp[..., 3] = 255
    src = Image.fromarray(ramp, "RGBA")

    def levels_of(pz):
        return len(set(np.asarray(run(src, {"posterize": pz}, tmp))[..., 0].flatten().tolist()))

    # EXACT counts, not upper bounds. The loose "<= 8" version of this test
    # passed while the code shipped BITS where the schema promised LEVELS —
    # every setting rendered roughly double, and 4 and 6 were byte-identical.
    eq("posterize 2 gives two levels", levels_of(2), 2)
    eq("posterize 4 gives four levels", levels_of(4), 4)
    eq("posterize 8 gives eight levels", levels_of(8), 8)
    # 5..8 share three bits, so they legitimately collapse together; 4 and 6
    # must NOT — that pair is the symptom the bug showed in the UI.
    eq("4 and 6 are not the same operation", levels_of(4) != levels_of(6), True)
    out = run(src, {"posterize": 2}, tmp)
    eq("posterize keeps alpha opaque",
       bool((np.asarray(out)[..., 3] == 255).all()), True)

# ---------------------------------------------------------------------------
# The shared effect registry, IMAGE_SPEC §4
# ---------------------------------------------------------------------------
#
# The compositor's 81 effects already work on float32 (H,W,4) 0..1 straight
# alpha, which is what a PIL RGBA image becomes. Bridging beats reimplementing
# — a second copy of any of them is the two-sources-of-truth mistake this
# codebase has now made five times. These assertions exist to prove the bridge
# is CONNECTED, which is the half that keeps going missing.

print("\n  -- the shared effect registry --")

_fx = imagetools._effects_registry()
eq("the registry is reachable from imagetools", _fx is not None, True)

if _fx is not None:
    eq("all 81 effects are visible", len(_fx.CATALOG) >= 81, True)

    flat = Image.fromarray(np.full((48, 48, 4), 128, np.uint8), "RGBA")

    # An effect must actually reach the pixels.
    inv, _ = imagetools.apply_effects(flat, [{"type": "invert", "params": {}}])
    eq("invert reaches the pixels through the bridge",
       int(np.asarray(inv)[0, 0, 0]), 127)

    # The selection mask is what makes all 75 local. One implementation, and
    # no effect knows selections exist.
    m = np.zeros((48, 48), np.float32)
    m[:, :24] = 1.0
    half, _ = imagetools.apply_effects(flat, [{"type": "invert", "params": {}}], m)
    h = np.asarray(half)
    eq("a masked effect inverts only inside the selection", int(h[0, 0, 0]), 127)
    eq("...and leaves the outside bit-identical", int(h[0, 40, 0]), 128)

    # A mask that does not match the frame is a bug in the caller, and silently
    # broadcasting it would put the edit in the wrong place.
    threw = ""
    try:
        imagetools.apply_effects(flat, [{"type": "invert"}], np.zeros((8, 8), np.float32))
    except ValueError as exc:
        threw = str(exc)
    eq("a mismatched mask is refused, not broadcast", "selection is" in threw, True)

    # A still has no previous frames. These are answered honestly rather than
    # hidden from the catalog, because a caller who asks for echo on a
    # photograph should learn why, not think the name was wrong.
    for name in imagetools.TIMELINE_EFFECTS:
        out, skipped = imagetools.apply_effects(flat, [{"type": name, "params": {}}])
        eq(f"{name} leaves a still untouched",
           bool(np.array_equal(np.asarray(out), np.asarray(flat))), True)
        eq(f"...and says it skipped {name}", skipped, [name])
        eq(f"...while still being listed in the catalog", name in _fx.CATALOG, True)

    # The skip list is DERIVED from the catalog's own flags now. The audit
    # case: particleSystem reads the clock, not history, so the hardcoded
    # trio missed it and a still got identity pixels with no note.
    eq("particleSystem declares needsTimeline in the catalog",
       bool(_fx.CATALOG.get("particleSystem", {}).get("needsTimeline")), True)
    derived = imagetools.timeline_effects(_fx)
    for name in imagetools.TIMELINE_EFFECTS:
        eq(f"timeline_effects() derives {name} from the flags", name in derived, True)

    # ctx plumbing: effects report compromises through ctx["notes"], and the
    # flat pipeline used to hand them nowhere to land. displacementMap with an
    # unresolvable map layer says so — the note must reach the caller's list.
    nts = []
    imagetools.apply_effects(
        flat, [{"type": "displacementMap", "params": {"mapLayer": "nosuch"}}],
        notes=nts)
    eq("an effect-level note surfaces through apply_effects",
       any("displacementMap" in n and "nosuch" in n for n in nts), True)

    # A guessed name must fail loudly. A guessed RANGE is the dangerous one and
    # is why the catalog carries min/max.
    threw = ""
    try:
        imagetools.apply_effects(flat, [{"type": "definitelyNotAnEffect"}])
    except ValueError as exc:
        threw = str(exc)
    eq("an unknown effect is refused by name", "No effect called" in threw, True)

    # Order is the caller's, and it matters. The pair has to be chosen with
    # care: a flat field commutes under almost everything, and blur composed
    # with invert commutes for real because blur is linear. Blur then posterize
    # on TEXTURE does not — quantising a smoothed image is not smoothing a
    # quantised one.
    rng = np.random.default_rng(3)
    tex = Image.fromarray(rng.integers(0, 255, (48, 48, 4)).astype(np.uint8), "RGBA")
    a1, _ = imagetools.apply_effects(tex, [{"type": "gaussianBlur"}, {"type": "posterize"}])
    a2, _ = imagetools.apply_effects(tex, [{"type": "posterize"}, {"type": "gaussianBlur"}])
    eq("effects apply in the order given",
       not np.array_equal(np.asarray(a1), np.asarray(a2)), True)

# ---------------------------------------------------------------------------
# The wiring — IMAGE_SPEC §2, stages 4 through 8
# ---------------------------------------------------------------------------
#
# imgselect and imgstroke each pass their own suite. So did shapes.py, and
# expressions.py, and audiokeys.py, while nothing called any of them. These go
# through apply_edit, which is the path the route and MCP take.

with tempfile.TemporaryDirectory() as wtmp:
    print("\n  -- the pipeline actually calls them --")

    _flat = os.path.join(wtmp, "wired_in.png")
    Image.fromarray(np.full((64, 64, 4), 160, np.uint8), "RGBA").save(_flat)


    def _edit(ops, tag):
        dst = os.path.join(wtmp, f"wired_{tag}.png")
        imagetools.apply_edit({"in": _flat, "out": dst, "thumbOut": None,
                               "thumbSize": 64, "ops": ops})
        return np.asarray(Image.open(dst))


    LEFT_HALF = {"shapes": [{"kind": "rect", "x": 0, "y": 0, "w": 32, "h": 64}]}

    # A global adjustment becomes local. This is the whole argument for selections:
    # 25 adjustments and 81 effects gain it without any of them knowing.
    a = _edit({"brightness": 40, "selection": LEFT_HALF}, "adj")
    eq("a selection makes a global adjustment local", int(a[0, 5, 0]) != 160, True)
    eq("...and leaves the unselected half bit-identical", int(a[0, 50, 0]), 160)

    # The same mask, applied to the effect registry.
    b = _edit({"effects": [{"type": "invert"}], "selection": LEFT_HALF}, "fx")
    eq("a selection clips an effect too", int(b[0, 5, 0]), 95)
    eq("...and the unselected half is untouched", int(b[0, 50, 0]), 160)

    # And to a brush stroke painted right across the frame.
    c = _edit({"strokes": [{"tool": "brush", "points": [[2, 32], [62, 32]], "size": 12,
                            "hardness": 1.0, "opacity": 1.0, "color": [255, 0, 0, 255]}],
               "selection": LEFT_HALF}, "stroke")
    eq("a stroke paints inside the selection", int(c[32, 10, 0]) > 200, True)
    eq("...and is clipped outside it", int(c[32, 50, 0]), 160)

    # Without a selection the same stroke crosses the whole frame — the control
    # that proves the clipping above was the selection and not the brush.
    d = _edit({"strokes": [{"tool": "brush", "points": [[2, 32], [62, 32]], "size": 12,
                            "hardness": 1.0, "opacity": 1.0, "color": [255, 0, 0, 255]}]}, "nosel")
    eq("with no selection the stroke crosses the whole frame", int(d[32, 50, 0]) > 200, True)

    # §3: no selection means the whole frame, and it must be the SAME path, so an
    # edit with no selection is bit-identical to one with a full-frame selection.
    e = _edit({"brightness": 40}, "plain")
    f = _edit({"brightness": 40,
               "selection": {"shapes": [{"kind": "rect", "x": 0, "y": 0, "w": 64, "h": 64}]}}, "fullsel")
    eq("a full-frame selection equals no selection", bool(np.array_equal(e, f)), True)

    # §3 requires a wand seed outside the frame to be an ERROR. imgselect collects
    # warnings rather than raising, so converting it is the pipeline's job — and
    # without that conversion the requirement is silently unmet.
    threw = ""
    try:
        _edit({"brightness": 40,
               "selection": {"shapes": [{"kind": "wand", "x": 9999, "y": 9999}]}}, "badwand")
    except ValueError as exc:
        threw = str(exc)
    eq("a wand seed outside the image is an error, not a silent empty selection",
       threw != "", True)

    print("\n  -- the reply's honesty channels, and the _mask injection --")

    # apply_edit's one JSON line is what the route forwards. fxSkipped names
    # the timeline effects that did nothing on this still; notes carries the
    # compromises the stages reported. Both used to stop at the engine.
    def _edit_reply(ops, tag):
        dst = os.path.join(wtmp, f"reply_{tag}.png")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            imagetools.apply_edit({"in": _flat, "out": dst, "thumbOut": None,
                                   "thumbSize": 64, "ops": ops})
        reply = json.loads(buf.getvalue().strip().split("\n")[-1])
        return reply, np.asarray(Image.open(dst))

    r, px = _edit_reply({"effects": [{"type": "particleSystem"}, {"type": "echo"}]},
                        "still_fx")
    eq("a still's reply names the effects that needed a timeline",
       r.get("fxSkipped"), ["particleSystem", "echo"])
    eq("...and the pixels are untouched", bool((px == 160).all()), True)

    r, _px = _edit_reply({"effects": [{"type": "displacementMap",
                                       "params": {"mapLayer": "nosuch"}}]}, "note_fx")
    eq("an effect's note reaches the job reply",
       any("displacementMap" in n for n in r.get("notes", [])), True)

    # ops._mask was an undocumented injectable: no legitimate caller wrote it,
    # but an HTTP body could, and apply_effects would blend through it — a
    # second mask on top of `selection`. It must be inert now: an injected
    # half-frame mask changes nothing, both halves invert.
    inj = [[0.0] * 64] * 32 + [[1.0] * 64] * 32
    r, px = _edit_reply({"effects": [{"type": "invert"}], "_mask": inj}, "inj")
    eq("an injected ops._mask is ignored — the whole frame inverts",
       [int(px[5, 5, 0]), int(px[60, 5, 0])], [95, 95])

    # A plate with distinct planes, so extracting the wrong one cannot pass.
    _chan_src = os.path.join(wtmp, "chan_in.png")
    _ca = np.zeros((32, 32, 4), np.uint8)
    _ca[..., 0], _ca[..., 1], _ca[..., 2], _ca[..., 3] = 200, 100, 50, 220
    Image.fromarray(_ca, "RGBA").save(_chan_src)


    def _chan(ops, tag):
        dst = os.path.join(wtmp, f"chan_{tag}.png")
        imagetools.apply_edit({"in": _chan_src, "out": dst, "thumbOut": None,
                               "thumbSize": 64, "ops": ops})
        return np.asarray(Image.open(dst).convert("RGBA"))

    g = _chan({"channel": "r"}, "r")
    eq("channel r is the red plane on all three channels, alpha opaque",
       [int(g[5, 5, 0]), int(g[5, 5, 1]), int(g[5, 5, 2]), int(g[5, 5, 3])],
       [200, 200, 200, 255])
    eq("channel a reads the alpha plane", int(_chan({"channel": "a"}, "a")[5, 5, 0]), 220)
    # 0.299*200 + 0.587*100 + 0.114*50 = 124.2 -> 124
    eq("luminosity is Rec.601 of the result",
       int(_chan({"channel": "luminosity"}, "l")[5, 5, 0]), 124)
    # After the pipeline, not before it: invert first, then extract. The
    # inverted red plane is 255-200=55, and reading 200 here would mean the
    # channel was taken from the input rather than the result.
    eq("the channel is read from the RESULT of the edit",
       int(_chan({"invert": True, "channel": "r"}, "post")[5, 5, 0]), 55)
    threw = ""
    try:
        _chan({"channel": "chartreuse"}, "bad")
    except ValueError as exc:
        threw = str(exc)
    eq("an unknown channel is an error that names the real ones",
       "luminosity" in threw, True)

print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
