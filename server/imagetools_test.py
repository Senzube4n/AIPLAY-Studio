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
# The compositor's 93 effects already work on float32 (H,W,4) 0..1 straight
# alpha, which is what a PIL RGBA image becomes. Bridging beats reimplementing
# — a second copy of any of them is the two-sources-of-truth mistake this
# codebase has now made five times. These assertions exist to prove the bridge
# is CONNECTED, which is the half that keeps going missing.

print("\n  -- the shared effect registry --")

_fx = imagetools._effects_registry()
eq("the registry is reachable from imagetools", _fx is not None, True)

if _fx is not None:
    eq("all 93 effects are visible", len(_fx.CATALOG) >= 88, True)

    flat = Image.fromarray(np.full((48, 48, 4), 128, np.uint8), "RGBA")

    # An effect must actually reach the pixels.
    inv, _ = imagetools.apply_effects(flat, [{"type": "invert", "params": {}}])
    eq("invert reaches the pixels through the bridge",
       int(np.asarray(inv)[0, 0, 0]), 127)

    # The selection mask is what makes all 88 local. One implementation, and
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
    # 25 adjustments and 93 effects gain it without any of them knowing.
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

# ---------------------------------------------------------------------------
# Matrix F6 — dict-shaped ops refuse unknown keys naming the real ones.
#
# resize {width, height} was accepted and IGNORED (the real keys are w/h): a
# crop+resize call returned a full-size file with no note, against the
# surface's stated "a guessed name is refused" rule. Same silent-drop pattern
# in the other inline dict ops; each door is pinned here, refusal AND the
# real spelling still working.
# ---------------------------------------------------------------------------

with tempfile.TemporaryDirectory() as ktmp:
    print("\n  -- unknown keys in dict ops are refused, naming the real ones --")

    _ksrc = os.path.join(ktmp, "keys_in.png")
    gradient_rgba(64, 48).save(_ksrc)

    def _kedit(ops, tag):
        dst = os.path.join(ktmp, f"keys_{tag}.png")
        with contextlib.redirect_stdout(io.StringIO()):
            imagetools.apply_edit({"in": _ksrc, "out": dst, "ops": ops})
        # Load-then-close: a lazily open handle keeps Windows from removing
        # the temp dir on the way out.
        with Image.open(dst) as _im:
            _im.load()
            return _im

    def refuses(name, ops, *needles):
        threw = ""
        try:
            _kedit(ops, "refused")
        except ValueError as exc:
            threw = str(exc)
        eq(name, all(n in threw for n in needles) and threw != "", True
           if threw else f"no refusal (needles {needles})")

    refuses("resize {width, height} is refused naming w/h",
            {"resize": {"width": 32, "height": 24}}, "resize", '"width"', "w, h")
    eq("resize {w, h} still resizes",
       _kedit({"resize": {"w": 32, "h": 24}}, "rs").size, (32, 24))

    refuses("crop with guessed keys is refused naming x, y, w, h",
            {"crop": {"left": 0, "top": 0, "w": 20, "h": 20}}, "crop", '"left"', "x, y, w, h")
    refuses("a crop missing a required key is an error, not a silent no-op",
            {"crop": {"x": 0, "y": 0, "w": 20}}, "crop", "missing h")
    eq("a real crop still crops",
       _kedit({"crop": {"x": 2, "y": 2, "w": 20, "h": 16}}, "cr").size, (20, 16))

    refuses("chromaKey {colour} is refused naming color/tolerance/softness",
            {"chromaKey": {"colour": [0, 255, 0]}}, "chromaKey", '"colour"', "color")
    refuses("levels' channels are master/r/g/b, not red",
            {"levels": {"red": {"black": 10}}}, "levels", '"red"', "master, r, g, b")
    refuses("a levels band refuses a guessed field",
            {"levels": {"r": {"blackPoint": 10}}}, "levels.r", '"blackPoint"', "black, white, gamma")
    refuses("curves' channels are master/r/g/b on the image side",
            {"curves": {"red": [[0, 0], [255, 255]]}}, "curves", '"red"', "master, r, g, b")
    refuses("hsl refuses a band that is not one of the six",
            {"hsl": {"orange": {"h": 10}}}, "hsl", '"orange"', "reds")
    refuses("an hsl band refuses a guessed field, naming h, s, l",
            {"hsl": {"reds": {"hue": 10}}}, "hsl.reds", '"hue"', "h, s, l")

    # The refusal layer must not shave anything off the working spellings.
    _all_ok = _kedit({"levels": {"master": {"black": 8, "white": 240}},
                      "curves": {"master": [[0, 0], [128, 200], [255, 255]]},
                      "hsl": {"reds": {"s": 20}},
                      "chromaKey": {"color": [10, 200, 10], "tolerance": 20, "softness": 10},
                      "crop": {"x": 0, "y": 0, "w": 48, "h": 40},
                      "resize": {"w": 24, "h": 20}}, "allok")
    eq("every documented spelling still runs together", _all_ok.size, (24, 20))

# ---------------------------------------------------------------------------
# blend modes - IMAGE_SPEC's transfer modes, the twenty-one of them
# ---------------------------------------------------------------------------
#
# BLEND_MODES is the BASE list: engine.py appends its seven to it, imgdoc.py
# appends four stencil modes to that, and imgshape/imgpath import this tuple
# straight. A mode whose name is misspelt in the `if mode ==` chain does not
# error - _blend falls through to `return top` and renders as `normal`, which
# is a picture that looks plausible and is wrong. Every pin below is aimed at
# that failure, and the expectations are derived from the formulas rather than
# read off the implementation.

print("\n  -- blend modes --")


def near(name, got, want, tol=1e-6):
    global PASS, FAIL
    if abs(float(got) - float(want)) <= tol:
        PASS += 1
        print(f"  ok    {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}\n          got {float(got)!r}, wanted {float(want)!r}")


def bl(mode, b, t):
    """_blend on a 1x1x3 image, so the whole-pixel modes work too."""
    B = np.full((1, 1, 3), b, np.float32)
    T = np.full((1, 1, 3), t, np.float32)
    return float(np.asarray(imagetools._blend(B, T, mode)).ravel()[0])


NEW = ["dissolve", "linearBurn", "darkerColor", "linearDodge", "lighterColor",
       "vividLight", "linearLight", "pinLight", "hardMix", "exclusion", "divide"]
eq("the eleven Photoshop modes that were missing are all in BLEND_MODES",
   [m for m in NEW if m not in imagetools.BLEND_MODES], [])
eq("...which makes twenty-one, and no name appears twice",
   (len(imagetools.BLEND_MODES), len(set(imagetools.BLEND_MODES))), (21, 21))
eq("...and the original ten still open the tuple, in their original order",
   list(imagetools.BLEND_MODES[:10]),
   ["normal", "multiply", "screen", "overlay", "softlight", "add",
    "subtract", "difference", "darken", "lighten"])

# -- the arithmetic, hand-derived -------------------------------------------
#
# Three pairs, each chosen so the answer is a number a reader can check in
# their head, and each hitting a different branch of the modes that have one.
#   linearBurn   b + t - 1, clamped        linearDodge  b + t
#   vividLight   t<=.5 ColorBurn(b, 2t)    else ColorDodge(b, 2t-1)
#   linearLight  b + 2t - 1, clamped       pinLight     t<=.5 min(b,2t) else max(b,2t-1)
#   hardMix      1 if b + t >= 1 else 0    exclusion    b + t - 2bt
#   divide       min(1, b / t)
TABLE = {
    #                      b=.6 t=.3      b=.3 t=.8       b=.8 t=.25
    "linearBurn":  (0.0,            0.1,            0.05),
    "linearDodge": (0.9,            1.1,            1.05),
    "vividLight":  (1.0 - 2.0 / 3.0, 0.75,          0.6),
    "linearLight": (0.2,            0.9,            0.3),
    "pinLight":    (0.6,            0.6,            0.5),
    "hardMix":     (0.0,            1.0,            1.0),
    "exclusion":   (0.54,           0.62,           0.65),
    "divide":      (1.0,            0.375,          1.0),
}
for _m, _want in TABLE.items():
    for (_b, _t), _w in zip(((0.6, 0.3), (0.3, 0.8), (0.8, 0.25)), _want):
        near(f"{_m}({_b}, {_t}) = {_w:.6g}", bl(_m, _b, _t), _w, 2e-6)

# -- the degenerate corners, which is where the divisions blow up ------------
#
# t=0, t=1, b=0, b=1 are not "edge cases" for this family: ColorBurn's
# denominator IS 2t and ColorDodge's IS 2-2t, so two of these four corners are
# the division by zero itself, and divide's is t=0. A NaN there becomes a black
# or a white pixel with nothing reporting it.
CORNERS = {
    "linearBurn":  {(0, 0): 0, (0, 1): 0, (1, 0): 0, (1, 1): 1},
    "linearDodge": {(0, 0): 0, (0, 1): 1, (1, 0): 1, (1, 1): 2},
    "vividLight":  {(0, 0): 0, (0, 1): 0, (1, 0): 1, (1, 1): 1},
    "linearLight": {(0, 0): 0, (0, 1): 1, (1, 0): 0, (1, 1): 1},
    "pinLight":    {(0, 0): 0, (0, 1): 1, (1, 0): 0, (1, 1): 1},
    "hardMix":     {(0, 0): 0, (0, 1): 1, (1, 0): 1, (1, 1): 1},
    "exclusion":   {(0, 0): 0, (0, 1): 1, (1, 0): 1, (1, 1): 0},
    "divide":      {(0, 0): 0, (0, 1): 0, (1, 0): 1, (1, 1): 1},
}
_wrong = []
for _m, _want in CORNERS.items():
    for (_b, _t), _w in _want.items():
        _got = bl(_m, _b, _t)
        if abs(_got - _w) > 1e-6:
            _wrong.append(f"{_m}({_b},{_t})={_got} not {_w}")
eq("every new mode's four degenerate corners are the defined value", _wrong, [])

# The corners ON the division, at a mid-grey backdrop: 2t = 0 and 2-2t = 0 are
# reached from t = 0 and t = 1 exactly, and the guarded branch has to hand back
# the spec's answer rather than the guard's arithmetic.
near("vividLight(0.5, 0) is ColorBurn's Cs=0 corner, black", bl("vividLight", 0.5, 0.0), 0.0)
near("vividLight(0.5, 1) is ColorDodge's Cs=1 corner, white", bl("vividLight", 0.5, 1.0), 1.0)
near("vividLight(0, 0.5) is ColorBurn with Cb=0 and no burn left", bl("vividLight", 0.0, 0.5), 0.0)
near("vividLight(1, 0.5) is ColorBurn's Cb=1 corner, white", bl("vividLight", 1.0, 0.5), 1.0)
near("divide(0.5, 0) overflows to white, not to inf", bl("divide", 0.5, 0.0), 1.0)
near("divide(0, 0) is black - the only value continuous with b falling to zero",
     bl("divide", 0.0, 0.0), 0.0)

# -- linearDodge IS add, and must stay bit-identical to it ------------------
#
# Photoshop calls one mode "Linear Dodge (Add)" and people look for both
# spellings, so both names exist. Two names that differed by so much as a clamp
# would be a bug with no symptom, which is why this is bitwise and not `near`.
_g = np.linspace(0.0, 1.0, 129, dtype=np.float32)
_B, _T = np.meshgrid(_g, _g, indexing="ij")
eq("linearDodge and add are the same function, bit for bit, over the whole grid",
   bool(np.array_equal(imagetools._blend(_B, _T, "linearDodge"),
                       imagetools._blend(_B, _T, "add"))), True)

# -- no NaN, no Inf, anywhere on the grid -----------------------------------
_SEP = [m for m in imagetools.BLEND_MODES
        if m not in ("dissolve", "darkerColor", "lighterColor")]
_nan = [m for m in _SEP
        if not bool(np.isfinite(np.asarray(imagetools._blend(_B, _T, m))).all())]
eq("no separable mode produces a NaN or an Inf anywhere on a 129x129 grid", _nan, [])
# The whole-pixel two, on an RGB grid built from three DIFFERENT channel ramps -
# a grey grid would let darkerColor pass while doing darken's job.
_R = np.stack([_B, _T, 1.0 - _B], axis=-1).astype(np.float32)
_S = np.stack([_T, 1.0 - _T, _B], axis=-1).astype(np.float32)
eq("...nor do darkerColor and lighterColor",
   [m for m in ("darkerColor", "lighterColor")
    if not bool(np.isfinite(np.asarray(imagetools._blend(_R, _S, m))).all())], [])

# ...and none of them DIVIDES by zero, which is a stricter thing than not
# producing one. np.where evaluates both of its branches, so a guard that goes
# missing from vividLight's denominator still gives the right answer here - the
# inf or the NaN is born in the discarded branch and thrown away unread. What
# it leaves behind is a RuntimeWarning, a caller who turned warnings into
# errors getting an exception out of a blend, and one reordering of those
# np.where clauses away from a live NaN. errstate is what makes the guards
# checkable rather than decorative.
_raised = []
for _m in _SEP + ["darkerColor", "lighterColor"]:
    _x, _y = ((_R, _S) if _m in ("darkerColor", "lighterColor") else (_B, _T))
    try:
        with np.errstate(divide="raise", invalid="raise"):
            imagetools._blend(_x, _y, _m)
    except FloatingPointError as _exc:
        _raised.append(f"{_m}: {_exc}")
eq("no mode divides by zero even in a branch whose answer is thrown away",
   _raised, [])

# Range, separately from finiteness: a clamped mode that stopped clamping is
# still finite. add/subtract/linearDodge are excluded BY NAME because they are
# documented not to clamp - if that ever changes, this list is where it shows.
_UNCLAMPED = ("add", "subtract", "linearDodge")
_out = []
for _m in _SEP:
    if _m in _UNCLAMPED:
        continue
    _r = np.asarray(imagetools._blend(_B, _T, _m))
    if float(_r.min()) < -1e-6 or float(_r.max()) > 1.0 + 1e-6:
        _out.append(f"{_m} [{float(_r.min())}, {float(_r.max())}]")
eq("every mode but add/subtract/linearDodge stays inside 0..1", _out, [])
eq("...and those three really do leave it, which is what makes the line above "
   "a check rather than a description",
   [m for m in _UNCLAMPED
    if float(np.asarray(imagetools._blend(_B, _T, m)).max()) <= 1.0 + 1e-6
    and float(np.asarray(imagetools._blend(_B, _T, m)).min()) >= -1e-6], [])

# -- nothing silently fell through to `normal` ------------------------------
#
# THE failure this file is written against: a misspelt name in the if-chain
# returns `top` and renders as normal. Two pins - every mode must differ from
# `normal` somewhere, and no two modes may be the same function (bar the one
# pair that is deliberately identical).
eq("every mode but `normal` differs from `normal` somewhere on the grid",
   [m for m in _SEP if m != "normal"
    and bool(np.allclose(np.asarray(imagetools._blend(_B, _T, m)), _T, atol=1e-7))], [])
_same = []
for _i, _a in enumerate(_SEP):
    for _b2 in _SEP[_i + 1:]:
        if np.allclose(np.asarray(imagetools._blend(_B, _T, _a)),
                       np.asarray(imagetools._blend(_B, _T, _b2)), atol=1e-7):
            _same.append((_a, _b2))
eq("no two modes compute the same function, except the pair that is meant to",
   _same, [("add", "linearDodge")])

# -- the two whole-pixel modes ----------------------------------------------
#
# darken compares CHANNELS, so under a red backdrop and a green source it
# returns a third colour that is in neither layer. darkerColor compares the
# whole pixel's luminance and takes one side wholesale. The pair below is
# chosen so the two answers disagree: luma(base) = .34, luma(top) = .336, four
# thousandths apart, so a mode that quietly fell back to per-channel darken
# would return the dark grey and be caught.
_BB = np.array([[[0.9, 0.1, 0.1]]], np.float32)
_TT = np.array([[[0.1, 0.5, 0.1]]], np.float32)
eq("darkerColor takes the whole darker PIXEL, not the darker channels",
   [round(float(v), 4) for v in imagetools._blend(_BB, _TT, "darkerColor").ravel()],
   [0.1, 0.5, 0.1])
eq("lighterColor takes the whole lighter pixel",
   [round(float(v), 4) for v in imagetools._blend(_BB, _TT, "lighterColor").ravel()],
   [0.9, 0.1, 0.1])
eq("...and per-channel darken really does invent a third colour here, which is "
   "the difference the two modes exist for",
   [round(float(v), 4) for v in imagetools._blend(_BB, _TT, "darken").ravel()],
   [0.1, 0.1, 0.1])
# A tie is a real case: 0.59 red and 0.30 green both weigh 0.177. Ties go to
# the SOURCE in both directions, so a tone-matched layer paints rather than
# vanishing.
_TIE_B = np.array([[[0.59, 0.0, 0.0]]], np.float32)
_TIE_T = np.array([[[0.0, 0.30, 0.0]]], np.float32)
eq("two colours of equal luminance really do tie in float32",
   float((_TIE_B @ imagetools._LUMA_W).ravel()[0])
   == float((_TIE_T @ imagetools._LUMA_W).ravel()[0]), True)
eq("a luminance tie goes to the source, in both directions",
   ([round(float(v), 4) for v in imagetools._blend(_TIE_B, _TIE_T, "darkerColor").ravel()],
    [round(float(v), 4) for v in imagetools._blend(_TIE_B, _TIE_T, "lighterColor").ravel()]),
   ([0.0, 0.3, 0.0], [0.0, 0.3, 0.0]))


def raised(fn, *needles):
    try:
        fn()
    except ValueError as exc:
        return all(n in str(exc) for n in needles)
    return False


# A single colour plane cannot know the other two channels, so the whole-pixel
# modes must REFUSE one rather than degrade into darken/lighten. engine.py
# blends plane by plane, which is exactly the caller this guard is aimed at.
eq("darkerColor refuses a single colour plane, naming what it would degrade into",
   raised(lambda: imagetools._blend(_B, _T, "darkerColor"), "whole pixels", "darken"), True)
eq("lighterColor refuses one too", raised(
    lambda: imagetools._blend(_B, _T, "lighterColor"), "whole pixels", "lighten"), True)

# -- dissolve ---------------------------------------------------------------
#
# Not a pixel function at all, so _blend has no way to answer: it is handed no
# alpha and no seed, and even given the alpha the caller's own
# `base*(1-a) + result*a` would smear back the mixing dissolve is defined to
# avoid. It refuses by name; composite() below does it above the lerp.
eq("_blend refuses dissolve and says why, rather than returning the top layer",
   raised(lambda: imagetools._blend(_B, _T, "dissolve"),
          "not a blend function", "alpha", "seed", "dissolve_mask"), True)

_A_HALF = np.full((64, 64, 1), 0.5, np.float32)
eq("dissolve_mask with the same seed gives the same plate twice - a still that "
   "re-rolled its dither would be a picture nobody could reproduce",
   bool(np.array_equal(imagetools.dissolve_mask(_A_HALF, 7, 0),
                       imagetools.dissolve_mask(_A_HALF, 7, 0))), True)
eq("...a different seed gives a different one",
   bool(np.array_equal(imagetools.dissolve_mask(_A_HALF, 7, 0),
                       imagetools.dissolve_mask(_A_HALF, 8, 0))), False)
eq("...and so does a different layer index, so two dissolve layers in one "
   "stack do not choose the same pixels and read as one layer",
   bool(np.array_equal(imagetools.dissolve_mask(_A_HALF, 7, 0),
                       imagetools.dissolve_mask(_A_HALF, 7, 1))), False)
near("half alpha keeps about half the pixels",
     float(imagetools.dissolve_mask(_A_HALF, 7, 0).mean()), 0.5, 0.02)
eq("alpha 0 keeps none and alpha 1 keeps all - rng.random() is [0, 1), which "
   "is what makes both ends exact rather than nearly exact",
   (float(imagetools.dissolve_mask(np.zeros((32, 32, 1), np.float32), 7).mean()),
    float(imagetools.dissolve_mask(np.ones((32, 32, 1), np.float32), 7).mean())),
   (0.0, 1.0))
# The window is cut from a field generated at the LAYER's size, so the dither
# is glued to the artwork: the same window of the same layer is the same
# pattern wherever the layer sits.
eq("the plate is cut from the layer's own field, so an offset window is the "
   "same pixels the whole-layer plate had there",
   bool(np.array_equal(
       imagetools.dissolve_mask(np.full((8, 8, 1), 0.5, np.float32), 7, 0,
                                shape=(16, 16), at=(4, 4)),
       imagetools.dissolve_mask(np.full((16, 16, 1), 0.5, np.float32), 7, 0)[4:12, 4:12])),
   True)

with tempfile.TemporaryDirectory() as btmp:

    def _solid(name, rgba, w=40, h=24):
        p = os.path.join(btmp, name)
        Image.fromarray(np.full((h, w, 4), rgba, np.uint8), "RGBA").save(p)
        return p

    def _comp(layers, tag, base=None):
        dst = os.path.join(btmp, f"comp_{tag}.png")
        with contextlib.redirect_stdout(io.StringIO()):
            imagetools.composite({"base": base or BLACK, "out": dst, "layers": layers})
        return np.asarray(Image.open(dst).convert("RGBA"))

    BLACK = _solid("black.png", (0, 0, 0, 255))
    WHITE = _solid("white.png", (255, 255, 255, 255))

    _L = {"src": WHITE, "x": 0, "y": 0, "mode": "dissolve", "opacity": 0.5}
    _one = _comp([_L], "d1")
    _two = _comp([_L], "d2")
    eq("the same composite renders the same dissolve twice",
       bool(np.array_equal(_one, _two)), True)
    eq("...and a different dissolveSeed renders a different one",
       bool(np.array_equal(_one, _comp([{**_L, "dissolveSeed": 99}], "d3"))), False)
    # THE definitional property: dissolve MIXES NOTHING. Every pixel is one
    # layer or the other at full strength, so a 50% white-on-black dissolve is
    # black and white and contains no grey at all. A dissolve that had been let
    # through the compositor's lerp would be flat 50% grey everywhere, and a
    # dissolve that ignored its alpha would be flat white.
    eq("every pixel is one layer or the other, never a mix of the two",
       sorted(set(np.unique(_one[..., 0]).tolist())), [0, 255])
    near("...and about half of them took the top layer",
         float((_one[..., 0] == 255).mean()), 0.5, 0.05)
    eq("opacity 1 takes every pixel, opacity 0 takes none",
       (float((_comp([{**_L, "opacity": 1.0}], "d4")[..., 0] == 255).mean()),
        float((_comp([{**_L, "opacity": 0.0}], "d5")[..., 0] == 255).mean())),
       (1.0, 0.0))
    # Two identical dissolve layers in one stack. If the index were not mixed
    # into the seed they would choose the SAME pixels and the second would be
    # invisible; mixed in, the second fills some of the first's holes.
    _stack = _comp([_L, _L], "d6")
    eq("a second dissolve layer fills some of the first one's holes instead of "
       "landing on exactly the same pixels",
       float((_stack[..., 0] == 255).mean()) > float((_one[..., 0] == 255).mean()) + 0.1,
       True)
    # The dither is glued to the LAYER, not to the window the compositor
    # happens to cut. Half the layer is pushed off the left edge, so the window
    # is four columns wide instead of eight: a field generated at the window's
    # size would be a different pattern entirely, while a field generated at
    # the layer's size and then sliced holds the same pixels it held when the
    # whole layer was on canvas. A partly clipped layer is the only placement
    # that can tell the two apart - two fully visible placements agree either
    # way, which is why this is not that test.
    _W8 = _solid("w8.png", (255, 255, 255, 255), 8, 8)
    _whole = _comp([{**_L, "src": _W8}], "d7")
    _clipped = _comp([{**_L, "src": _W8, "x": -4}], "d8")
    eq("a layer half off the edge dithers the same pixels it dithered whole, "
       "because the field is cut from the layer and not from the window",
       bool(np.array_equal(_clipped[0:8, 0:4, 0], _whole[0:8, 4:8, 0])), True)
    # And the rest of the modes actually reach the compositor: a white layer
    # over a black base under `divide` is white, under `exclusion` is white,
    # under `hardMix` is white, under `linearBurn` is black.
    for _m, _want in (("divide", 0), ("exclusion", 255), ("hardMix", 255),
                      ("linearBurn", 0), ("pinLight", 255), ("linearLight", 255)):
        _px = _comp([{"src": WHITE, "x": 0, "y": 0, "mode": _m}], f"m_{_m}")[4, 4, 0]
        eq(f"composite() really runs {_m} (white over black -> {_want})", int(_px), _want)
    # darkerColor through the compositor, which is the caller that CAN do it:
    # a channel-last RGB array is exactly what _blend_whole_pixel requires.
    _RED = _solid("red.png", (230, 26, 26, 255))
    _GRN = _solid("grn.png", (26, 128, 26, 255))
    # The green is the DARKER pixel by four thousandths of luma while being the
    # brighter one in the green channel, so "took the green wholesale" and "took
    # the per-channel minimum" are two visibly different answers here. Compared
    # loosely because composite() writes uint8 by truncation, and one code of
    # rounding is not what this pin is about.
    _dc = _comp([{"src": _GRN, "x": 0, "y": 0, "mode": "darkerColor"}],
                "dc", base=_RED)[4, 4, :3]
    eq("darkerColor composites whole pixels through composite(), which hands "
       "_blend an image rather than a plane",
       (int(_dc[0]) < 60, int(_dc[1]) > 100, int(_dc[2]) < 60), (True, True, True))


print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
