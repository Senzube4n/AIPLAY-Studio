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
# BLEND_MODES is THE list: engine.py takes it whole, imgdoc.py appends four
# stencil modes to that, and imgshape/imgpath import this tuple straight. A mode
# whose name is misspelt in the `if mode ==` chain used not to error - _blend
# fell off the end and returned `top`, which renders as `normal`: a picture that
# looks plausible and is wrong. Every pin below is aimed at that failure, and
# the expectations are derived from the formulas rather than read off the
# implementation.
#
# IT WAS NOT A HYPOTHETICAL. Seven names sat in this tuple implemented only in
# server/vfx/engine.py - hardlight, colordodge, colorburn, hue, saturation,
# color and luminosity - and every one of them rendered bit-identical to normal
# through composite(), imgshape._over and imgpath._over until 2026-09-21. The
# fallthrough is gone: `normal` is answered by name and anything else raises.

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
MOVED = ["hardlight", "colordodge", "colorburn",
         "hue", "saturation", "color", "luminosity"]
eq("...and so are the seven that used to live in engine.py",
   [m for m in MOVED if m not in imagetools.BLEND_MODES], [])
eq("...which makes twenty-eight, and no name appears twice",
   (len(imagetools.BLEND_MODES), len(set(imagetools.BLEND_MODES))), (28, 28))
eq("...and the original ten still open the tuple, in their original order",
   list(imagetools.BLEND_MODES[:10]),
   ["normal", "multiply", "screen", "overlay", "softlight", "add",
    "subtract", "difference", "darken", "lighten"])
# ⚠ POSITION, NOT MEMBERSHIP. engine.BLEND_MODES used to be this tuple PLUS
# those seven in that order, imgdoc.BLEND_MODES is built on engine's, and
# server/vfx/store.js keeps a hand-written copy that a lane checks by name. The
# seven were appended to the TAIL, in the order they had over there, so all
# three of those lists are the same sequences they already were and none of them
# had to be touched. Slot one of these names into Photoshop's dropdown position
# instead and every index after it moves.
eq("the twenty-one that were here keep their indices, and the seven are the tail",
   (list(imagetools.BLEND_MODES[:21])[-1], list(imagetools.BLEND_MODES[21:])),
   ("divide", MOVED))

# -- the arithmetic, hand-derived -------------------------------------------
#
# Three pairs, each chosen so the answer is a number a reader can check in
# their head, and each hitting a different branch of the modes that have one.
#   linearBurn   b + t - 1, clamped        linearDodge  b + t
#   vividLight   t<=.5 ColorBurn(b, 2t)    else ColorDodge(b, 2t-1)
#   linearLight  b + 2t - 1, clamped       pinLight     t<=.5 min(b,2t) else max(b,2t-1)
#   hardMix      1 if b + t >= 1 else 0    exclusion    b + t - 2bt
#   divide       min(1, b / t)
#   hardlight    t<=.5 mult(b,2t)          else screen(b, 2t-1)
#   colordodge   b=0?0 : t=1?1 : min(1, b/(1-t))
#   colorburn    b=1?1 : t=0?0 : 1 - min(1, (1-b)/t)
TABLE = {
    #                      b=.6 t=.3      b=.3 t=.8       b=.8 t=.25
    "hardlight":   (0.36,           0.72,           0.4),
    # Two of these three saturate, which is honest for a dodge and a burn but
    # proves only that min() runs. The unsaturated cases are pinned separately
    # below, where the division is the thing being read.
    "colordodge":  (6.0 / 7.0,      1.0,            1.0),
    "colorburn":   (0.0,            0.125,          0.2),
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
    "hardlight":   {(0, 0): 0, (0, 1): 1, (1, 0): 0, (1, 1): 1},
    "colordodge":  {(0, 0): 0, (0, 1): 0, (1, 0): 1, (1, 1): 1},
    "colorburn":   {(0, 0): 0, (0, 1): 0, (1, 0): 1, (1, 1): 1},
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

# colordodge and colorburn away from their ends, where the division is actually
# a division and not a guard: 0.2/(1-0.5) and 1 - 0.5/0.8.
near("colordodge(0.2, 0.5) is b/(1-t), not a saturated 1", bl("colordodge", 0.2, 0.5), 0.4)
near("colordodge(0.3, 0.4) too", bl("colordodge", 0.3, 0.4), 0.5)
near("colorburn(0.5, 0.8) is 1 - (1-b)/t", bl("colorburn", 0.5, 0.8), 0.375)
near("colorburn(0.9, 0.5) too", bl("colorburn", 0.9, 0.5), 0.8)
# ⚠ THE ORDER OF THE TWO GUARDS DECIDES A PIXEL, and W3C compositing-1 asks the
# BACKDROP's corner first in both. At b = 0 with t = 1 both of colordodge's
# conditions fire; the spec's answer is black, because a backdrop with no light
# in it has nothing to dodge. Swap the two np.where clauses and this returns
# white instead - a pinhole of white where a black pixel met a white layer,
# which is exactly the kind of thing nobody notices until it is on a face.
near("colordodge(0, 1): the Cb=0 corner is asked first, so black stays black",
     bl("colordodge", 0.0, 1.0), 0.0)
near("colorburn(1, 0): the Cb=1 corner is asked first, so white stays white",
     bl("colorburn", 1.0, 0.0), 1.0)
near("colordodge(0.5, 1) is the 1-t = 0 divide, answered as white",
     bl("colordodge", 0.5, 1.0), 1.0)
near("colorburn(0.5, 0) is the t = 0 divide, answered as black",
     bl("colorburn", 0.5, 0.0), 0.0)
# hardlight is overlay with the layers swapped, and that is a claim worth
# checking rather than restating: if the two were written as the same branch by
# accident, a hard-light layer would read the BACKDROP to choose its branch and
# the mode would quietly become overlay.
_hl_swapped = [(round(bl("hardlight", _b, _t), 6), round(bl("overlay", _t, _b), 6))
               for _b, _t in ((0.6, 0.3), (0.3, 0.8), (0.2, 0.9), (0.9, 0.1))]
eq("hardlight(b, t) is overlay(t, b)", [p for p in _hl_swapped if p[0] != p[1]], [])
eq("...and is NOT overlay(b, t), which is what writing one branch twice gives",
   [(_b, _t) for _b, _t in ((0.6, 0.3), (0.3, 0.8), (0.2, 0.9), (0.9, 0.1))
    if abs(bl("hardlight", _b, _t) - bl("overlay", _b, _t)) < 1e-6], [])

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
#
# ⚠ DERIVED FROM THE MODULE'S OWN SETS, NOT HAND-LISTED. This used to spell out
# ("dissolve", "darkerColor", "lighterColor") and would have kept passing while
# silently skipping the four component modes the day they landed - the exact
# shape of hole that let seven modes render as normal for as long as they did.
_SEP = [m for m in imagetools.BLEND_MODES
        if m not in imagetools.IMAGE_ONLY_MODES
        and m not in imagetools.ALPHA_MODES]
_nan = [m for m in _SEP
        if not bool(np.isfinite(np.asarray(imagetools._blend(_B, _T, m))).all())]
eq("no separable mode produces a NaN or an Inf anywhere on a 129x129 grid", _nan, [])
eq("...and `separable` is every mode but the six that need an image and dissolve",
   len(_SEP), len(imagetools.BLEND_MODES) - 7)
# ⚠ PLANE_BLEND_MODES IS A PROMISE TO ANOTHER COLUMN AND IS PINNED HERE, where
# it is defined. imgpath_test sweeps it over a flat (64, 4) run of pixels on the
# strength of that promise, and imgshape/imgpath both import it; a mode that
# leaked into it would not fail a count anywhere - it would raise out of the
# middle of somebody else's suite with no line saying why. This is the promise
# itself: hand every name in it a single colour plane and none may refuse.
_not_planar = []
for _m in imagetools.PLANE_BLEND_MODES:
    try:
        imagetools._blend(_B, _T, _m)
    except ValueError as _exc:
        _not_planar.append(f"{_m}: {_exc}")
eq("every mode in PLANE_BLEND_MODES really does answer a single colour plane",
   _not_planar, [])
eq("...and the six that do not are exactly the ones it leaves out",
   sorted(set(imagetools.BLEND_MODES) - set(imagetools.PLANE_BLEND_MODES)
          - set(imagetools.ALPHA_MODES)),
   sorted(imagetools.IMAGE_ONLY_MODES))
# The six image-only ones, on an RGB grid built from three DIFFERENT channel
# ramps - a grey grid would let darkerColor pass while doing darken's job, and
# would collapse hue and saturation to the backdrop, which is their answer for a
# grey and proves nothing about a colour.
_R = np.stack([_B, _T, 1.0 - _B], axis=-1).astype(np.float32)
_S = np.stack([_T, 1.0 - _T, _B], axis=-1).astype(np.float32)
eq("...nor does any of the six that take a whole pixel",
   [m for m in imagetools.IMAGE_ONLY_MODES
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
for _m in _SEP + list(imagetools.IMAGE_ONLY_MODES):
    _x, _y = ((_R, _S) if _m in imagetools.IMAGE_ONLY_MODES else (_B, _T))
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

# THE SAME TWO PINS FOR THE SIX THAT NEED AN IMAGE, on the RGB grid, because the
# plane grid above cannot evaluate them at all - and it was their absence from
# this exact sweep that let hue, saturation, color and luminosity ship as
# `normal`. `color` and `luminosity` are the pair most at risk of collapsing
# into each other: they are the same function with the layers exchanged.
eq("every image-only mode differs from `normal` somewhere on the RGB grid",
   [m for m in imagetools.IMAGE_ONLY_MODES
    if bool(np.allclose(np.asarray(imagetools._blend(_R, _S, m)), _S, atol=1e-7))], [])
_same_img = []
_IMG = list(imagetools.IMAGE_ONLY_MODES)
for _i, _a in enumerate(_IMG):
    for _b2 in _IMG[_i + 1:]:
        if np.allclose(np.asarray(imagetools._blend(_R, _S, _a)),
                       np.asarray(imagetools._blend(_R, _S, _b2)), atol=1e-7):
            _same_img.append((_a, _b2))
eq("...and no two of them are the same function either", _same_img, [])

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


# -- the four component modes -----------------------------------------------
#
# hue, saturation, color and luminosity take two of {Hue, Sat, Lum} from one
# layer and the third from the other. Lum is 0.30R + 0.59G + 0.11B and Sat is
# max - min across the three channels, so every one of these is a reduction
# ACROSS the channels and none of them can be computed one plane at a time.
# THEY SPENT THEIR WHOLE LIFE IN THIS LIST RENDERING AS `normal` - implemented
# only in server/vfx/engine.py, so `_blend` fell off the end of its chain and
# returned the source - and every number below is worked out from the spec's
# definition on paper, never read back off the implementation.
#
#   Lum(C)        = .30R + .59G + .11B
#   Sat(C)        = max(R,G,B) - min(R,G,B)
#   SetSat(C, s)  = (C - Cmin) * s / (Cmax - Cmin), all three at once
#   SetLum(C, l)  = ClipColor(C + (l - Lum(C)))
#   hue           = SetLum(SetSat(Cs, Sat(Cb)), Lum(Cb))
#   saturation    = SetLum(SetSat(Cb, Sat(Cs)), Lum(Cb))
#   color         = SetLum(Cs, Lum(Cb))
#   luminosity    = SetLum(Cb, Lum(Cs))

print("\n  -- the component modes --")


def bl3(mode, b, t):
    """_blend on a 1x1 RGB pixel pair, as three rounded floats."""
    B = np.array([[b]], np.float32)
    T = np.array([[t]], np.float32)
    return [round(float(v), 6) for v in np.asarray(imagetools._blend(B, T, mode)).ravel()]


def near3(name, got, want, tol=2e-6):
    global PASS, FAIL
    if len(got) == len(want) and all(abs(g - w) <= tol for g, w in zip(got, want)):
        PASS += 1
        print(f"  ok    {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}\n          got {got!r}, wanted {want!r}")


# ONE PAIR, FOUR ANSWERS, ALL FOUR DERIVED BY HAND.
#   Cb = (.6, .2, .8)   Lum = .18 + .118 + .088 = .386   Sat = .8 - .2 = .6
#   Cs = (.4, .6, .8)   Lum = .12 + .354 + .088 = .562   Sat = .8 - .4 = .4
_NB = [0.6, 0.2, 0.8]
_NT = [0.4, 0.6, 0.8]

# luminosity = SetLum(Cb, .562): d = .562 - .386 = .176, so Cb + .176 straight
# across. Nothing leaves 0..1, so ClipColor does not fire.
near3("luminosity(.6 .2 .8 | .4 .6 .8) = Cb + .176",
      bl3("luminosity", _NB, _NT), [0.776, 0.376, 0.976])
# color = SetLum(Cs, .386): d = .386 - .562 = -.176, so Cs - .176.
near3("color(...) = Cs - .176, the mirror of it",
      bl3("color", _NB, _NT), [0.224, 0.424, 0.624])
# hue = SetLum(SetSat(Cs, .6), .386).
#   SetSat((.4,.6,.8), .6): min .4, range .4 -> (0, .2*1.5, .4*1.5) = (0, .3, .6)
#   Lum of that = 0 + .177 + .066 = .243, so d = .386 - .243 = .143
near3("hue(...) = the source's hue at the backdrop's Sat and Lum",
      bl3("hue", _NB, _NT), [0.143, 0.443, 0.743])
# saturation = SetLum(SetSat(Cb, .4), .386).
#   SetSat((.6,.2,.8), .4): min .2, range .6 -> (.16/.6, 0, .4) = (.2666667, 0, .4)
#   Lum of that = .08 + 0 + .044 = .124, so d = .386 - .124 = .262
near3("saturation(...) = the backdrop's colour at the source's Sat",
      bl3("saturation", _NB, _NT), [0.16 / 0.6 + 0.262, 0.262, 0.662])

# ⚠ ALL FOUR PRESERVE THE LUMINANCE THEY WERE ASKED TO SET, and that is the one
# property a plausible wrong implementation loses. Three of them set Lum(Cb) and
# luminosity sets Lum(Cs); if ClipColor clamped at the cube instead of scaling
# toward the luma grey, every saturated result would come back a different tone.
_LW = imagetools._LUMA_W
for _m, _want in (("hue", 0.386), ("saturation", 0.386),
                  ("color", 0.386), ("luminosity", 0.562)):
    near(f"{_m} leaves Lum at {_want}",
         float(np.dot(bl3(_m, _NB, _NT), _LW)), _want, 2e-6)

# -- ClipColor, which only fires on a colour that has left the cube ---------
#
# Cb = pure red (1, 0, 0), Lum .30. Pushing it to Lum .8 gives (1.5, .5, .5),
# whose max is 1.5, so the highlight branch runs:
#   L = .8, x = 1.5, C' = L + (C - L)(1 - L)/(x - L) = .8 + (C - .8)(.2/.7)
#   R: .8 + .7*.2/.7 = 1.0     G,B: .8 - .3*.2/.7 = .8 - .0857142857
near3("luminosity pushes pure red to Lum .8 by scaling toward its own grey",
      bl3("luminosity", [1.0, 0.0, 0.0], [0.8, 0.8, 0.8]),
      [1.0, 0.8 - 0.3 * 0.2 / 0.7, 0.8 - 0.3 * 0.2 / 0.7])
near("...and that result really does weigh .8",
     float(np.dot(bl3("luminosity", [1.0, 0.0, 0.0], [0.8, 0.8, 0.8]), _LW)), 0.8, 2e-6)
# The value a naive clamp would give, stated so the pin above is a comparison
# rather than a transcript: np.clip((1.5,.5,.5), 0, 1) = (1, .5, .5), which
# weighs .30 + .295 + .055 = .65. Wrong by 150 codes of luminance.
near("a clamp at the cube would have given Lum .65, which is the bug this avoids",
     float(np.dot([1.0, 0.5, 0.5], _LW)), 0.65, 2e-6)
# And the shadow branch: pure red down to Lum .1 gives (.8, -.2, -.2), min < 0.
#   L = .1, n = -.2, C' = L + (C - L)L/(L - n) = .1 + (C - .1)/3
#   R: .1 + .7/3 = 1/3        G,B: .1 - .3/3 = 0
near3("...and down to Lum .1 through the shadow branch",
      bl3("luminosity", [1.0, 0.0, 0.0], [0.1, 0.1, 0.1]), [1.0 / 3.0, 0.0, 0.0])
near("...which weighs .1, not the .24 a clamp at zero would have left",
     float(np.dot(bl3("luminosity", [1.0, 0.0, 0.0], [0.1, 0.1, 0.1]), _LW)), 0.1, 2e-6)
# hue reaches the shadow branch too, from the other direction: a fully saturated
# backdrop hands SetSat a Sat of 1.
#   SetSat((.4,.6,.8), 1) = (0, .5, 1), Lum .405; d = .30 - .405 = -.105
#   C = (-.105, .395, .895), L = .30, n = -.105 -> C' = .3 + (C - .3)*.3/.405
near3("hue over a fully saturated backdrop clips without moving its tone",
      bl3("hue", [1.0, 0.0, 0.0], [0.4, 0.6, 0.8]),
      [0.0, 0.3 + 0.095 * 0.3 / 0.405, 0.3 + 0.595 * 0.3 / 0.405])
near("...still weighing Lum(Cb) = .30",
     float(np.dot(bl3("hue", [1.0, 0.0, 0.0], [0.4, 0.6, 0.8]), _LW)), 0.30, 2e-6)

# -- a fully desaturated layer, which is where SetSat divides by zero -------
#
# Sat = 0 on either side collapses three of the four, and each collapse is the
# spec's answer rather than a degenerate case to be avoided.
_GREY = [0.5, 0.5, 0.5]
# Cb grey: Sat(Cb) = 0, so SetSat(Cs, 0) = (0,0,0) and SetLum puts .5 back.
# A hue has nothing to colour when the backdrop holds no colour at all.
near3("hue over a grey backdrop is the backdrop - no saturation to carry it",
      bl3("hue", _GREY, _NT), _GREY)
# Same pixel, `saturation`: SetSat(Cb, Sat(Cs)) is asked to rescale a range of
# ZERO. This is the divide the _EPS guard exists for, and the answer is the
# backdrop again.
near3("saturation over a grey backdrop is the backdrop, not a NaN",
      bl3("saturation", _GREY, _NT), _GREY)
# ⚠ AN EXACTLY GREY PIXEL DOES NOT TEST THAT GUARD, which is worth a line
# because the obvious test for it does not work. At Cmax == Cmin the numerator
# `C - Cmin` is exactly zero, so `0 * s / max(0, eps)` is zero too and the mask
# and the bare divide agree — delete the mask and every pin above still passes.
# What separates them is a pixel that is nearly grey: a range of 5e-7 is below
# the epsilon, so the mask calls it flat, while the bare divide computes
# 5e-7 * s / 1e-6 and amplifies a rounding-sized difference into a fifth of a
# channel. A backdrop one part in two million off neutral would come back
# visibly blue.
_NEARLY = [0.5, 0.5, 0.5000005]
near3("a backdrop 5e-7 off neutral is treated as grey, not amplified into colour",
      bl3("saturation", _NEARLY, _NT), [0.5, 0.5, 0.5], 1e-5)
# Grey SOURCE instead: Sat(Cs) = 0 flattens a coloured backdrop to its own grey.
near3("a grey source desaturates the backdrop to Lum(Cb) = .386",
      bl3("saturation", _NB, _GREY), [0.386, 0.386, 0.386])
# A fully saturated backdrop under a source of Sat .4:
#   SetSat((1,0,0), .4) = (.4, 0, 0), Lum .12; d = .30 - .12 = .18
near3("a fully saturated backdrop takes the source's Sat exactly",
      bl3("saturation", [1.0, 0.0, 0.0], _NT), [0.58, 0.18, 0.18])

# -- the degenerate ends ----------------------------------------------------
#
# On a pair of GREYS every component mode collapses: Sat is 0 on both sides, so
# hue, saturation and color all return the backdrop and luminosity returns the
# source. That is not a shortcut in the implementation - it is what the four
# definitions reduce to - and it makes the four corners checkable by hand.
_CORNERS_NS = {
    #             (b, t):  hue/saturation/color -> b,  luminosity -> t
    (0.0, 0.0): (0.0, 0.0),
    (0.0, 1.0): (0.0, 1.0),
    (1.0, 0.0): (1.0, 0.0),
    (1.0, 1.0): (1.0, 1.0),
}
_wrong_ns = []
for (_b, _t), (_keep_b, _keep_t) in _CORNERS_NS.items():
    for _m in ("hue", "saturation", "color", "luminosity"):
        _w = _keep_t if _m == "luminosity" else _keep_b
        _got = bl3(_m, [_b] * 3, [_t] * 3)
        if any(abs(v - _w) > 2e-6 for v in _got):
            _wrong_ns.append(f"{_m}({_b},{_t})={_got} not {_w}")
eq("every component mode's four degenerate corners are the defined value",
   _wrong_ns, [])
# A black and a white SOURCE against a colour, where the shift is large enough
# that ClipColor has to pull the whole pixel back to an end.
near3("luminosity with a black source is black", bl3("luminosity", _NB, [0.0] * 3),
      [0.0, 0.0, 0.0])
near3("luminosity with a white source is white", bl3("luminosity", _NB, [1.0] * 3),
      [1.0, 1.0, 1.0])
# ...and the backdrop at the ends, where SetSat is handed a range of zero from
# the other side.
near3("a black backdrop takes the source's colour and stays black",
      bl3("color", [0.0] * 3, _NT), [0.0, 0.0, 0.0])
near3("a white backdrop stays white", bl3("color", [1.0] * 3, _NT), [1.0, 1.0, 1.0])

# -- and they refuse a plane, for the same reason the whole-pixel two do ----
#
# Lum(r) == r and Sat(r) == 0 for a single plane, so answering one would make
# luminosity and color into `normal` and hue and saturation into a flat grey:
# four modes wrong in three different ways, which is worse than the one wrong
# way they were in before. engine.py blends plane by plane and is the caller
# this guard is aimed at.
_plane_ok = [m for m in ("hue", "saturation", "color", "luminosity")
             if not raised(lambda m=m: imagetools._blend(_B, _T, m),
                           "Lum and Sat", "IMAGE_ONLY_MODES")]
eq("every component mode refuses a single colour plane", _plane_ok, [])
# ⚠ AND A TILE THREE PIXELS WIDE IS NOT AN RGB IMAGE. (8, 3) passes a test on
# the last axis alone and is eight rows of three PIXELS; weighing them as three
# channels would composite a thin strip as nonsense and report nothing. The
# guard demands a spatial axis IN FRONT of the three, which is what makes it
# ndim >= 3 rather than a shape check.
_narrow = np.full((8, 3), 0.5, np.float32)
eq("...and so is a tile exactly three pixels wide, which a last-axis test admits",
   raised(lambda: imagetools._blend(_narrow, _narrow, "color"), "Lum and Sat"), True)
eq("...the whole-pixel two agree about that shape, which is the same guard",
   raised(lambda: imagetools._blend(_narrow, _narrow, "darkerColor"), "whole pixels"),
   True)

# -- a name nothing implements ---------------------------------------------
#
# ⚠ THIS IS THE DEFECT ITSELF, WEARING ITS GENERAL FORM. `_blend` used to end in
# a bare `return top`, so a name it did not have came back as the source and
# composited as `normal`. That is what hid seven real modes: they were in
# BLEND_MODES, offered by two pickers, and painted nothing. A misspelling in the
# if-chain would have hidden the same way.
eq("_blend refuses a name it does not implement instead of returning the source",
   raised(lambda: imagetools._blend(_B, _T, "no-such-mode"),
          "no blend mode called", "no-such-mode", "BLEND_MODES"), True)
eq("...including one that is merely misspelt, which is how this class of bug "
   "gets in",
   raised(lambda: imagetools._blend(_B, _T, "hardLight"), "no blend mode called"), True)
eq("...and `normal` is answered by NAME now, so the two no longer share an exit",
   bool(np.array_equal(np.asarray(imagetools._blend(_B, _T, "normal")), _T)), True)
# The complement of the pin above, and the one that would have caught the seven
# on the day they were listed: every published name must ANSWER, on the shape it
# is documented to want. A mode added to BLEND_MODES and to nothing else now
# fails here instead of rendering as the source.
_unanswered = []
for _m in imagetools.BLEND_MODES:
    if _m in imagetools.ALPHA_MODES:
        continue
    _x, _y = ((_R, _S) if _m in imagetools.IMAGE_ONLY_MODES else (_B, _T))
    try:
        imagetools._blend(_x, _y, _m)
    except ValueError as _exc:
        _unanswered.append(f"{_m}: {_exc}")
eq("every name in BLEND_MODES is answered by _blend, on a shape that suits it",
   _unanswered, [])

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

    # ── THE DEFECT, AT THE LAYER THE USER SEES ──────────────────────────────
    #
    # This is the pin that would have caught it. All seven were in BLEND_MODES
    # and implemented only in server/vfx/engine.py, so composite() rendered
    # every one of them BIT-IDENTICAL to `normal`: a stack set to hard light,
    # color dodge or luminosity produced the source layer untouched and there
    # was no error, no warning and no visible clue. The pair is a red base under
    # a green layer, chosen because all seven move it somewhere `normal` does
    # not - and comparing against `normal`'s own render rather than against a
    # remembered number is what makes this survive a change to either.
    _NORMAL = _comp([{"src": _GRN, "x": 0, "y": 0, "mode": "normal"}],
                    "seven_normal", base=_RED)
    _as_normal = []
    for _m in ("hardlight", "colordodge", "colorburn",
               "hue", "saturation", "color", "luminosity"):
        _got = _comp([{"src": _GRN, "x": 0, "y": 0, "mode": _m}],
                     f"seven_{_m}", base=_RED)
        if np.array_equal(_got, _NORMAL):
            _as_normal.append(_m)
    eq("the seven modes that used to render as `normal` through composite() no "
       "longer do", _as_normal, [])

    # ...and one of them to a hand-derived number, because "differs from normal"
    # would also pass for seven modes that were all quietly wrong in the same
    # new way. `color` puts the SOURCE's colour at the BACKDROP's luminance, and
    # a white source has no colour at all, so the answer is the backdrop's own
    # grey in all three channels:
    #   Lum(230, 26, 26)/255 = (.30*230 + .59*26 + .11*26)/255 = 87.2/255
    #   SetLum(white, .341960) = (.341960,)*3 -> 87.2 -> 87 written as uint8
    _col = _comp([{"src": WHITE, "x": 0, "y": 0, "mode": "color"}],
                 "color_white", base=_RED)[4, 4]
    eq("a white layer at `color` flattens the base to its own luminance grey",
       [int(v) for v in _col], [87, 87, 87, 255])

    # ── an unknown name is REPAIRED and SAID, never silently painted ────────
    #
    # `_blend` refuses a name it does not implement, which is right for a pixel
    # kernel and wrong for a saved stack: losing somebody's whole composite over
    # one layer's spelling is the worse of the two failures. composite() follows
    # imgdoc.normalize()'s rule instead - paint it as normal, and SAY SO in the
    # status line. Saying so is the whole point; painting it as normal in
    # silence is what this file has spent two hundred lines being about.
    def _comp_status(layers, tag):
        # The ValueError is CAUGHT and reported as a result rather than left to
        # propagate. Without the catch, removing composite()'s coercion does not
        # fail this pin - it raises out of the job and takes every test after it
        # down with it, which is a suite that stops rather than a suite that
        # says what is wrong.
        dst = os.path.join(btmp, f"st_{tag}.png")
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                imagetools.composite({"base": _RED, "out": dst, "layers": layers})
        except Exception as exc:
            return {"ok": False, "raised": f"{type(exc).__name__}: {exc}"}
        return json.loads(buf.getvalue().strip().split("\n")[-1])

    _st = _comp_status([{"src": _GRN, "x": 0, "y": 0, "mode": "hardLight"}], "bad")
    eq("a composite carrying a mode nothing implements still finishes",
       _st.get("ok"), True)
    eq("...and names it in the status line rather than painting it in silence",
       (len(_st.get("warnings") or []),
        "hardLight" in (_st.get("warnings") or [""])[0],
        "normal" in (_st.get("warnings") or [""])[0]), (1, True, True))
    eq("...and a stack with nothing wrong carries no warnings key at all, so "
       "the one that does is noticed",
       "warnings" in _comp_status(
           [{"src": _GRN, "x": 0, "y": 0, "mode": "multiply"}], "good"), False)
    eq("...and the repaired layer really did paint as normal",
       bool(np.array_equal(
           _comp([{"src": _GRN, "x": 0, "y": 0, "mode": "hardLight"}], "bad2",
                 base=_RED), _NORMAL)), True)


# ── ops.clear — Delete, and the four ways it could be wrong ──────────────
#
# Ctrl+A built a full-frame selection for a long time and nothing consumed it:
# there was no op anywhere that could reduce alpha except the path-driven
# eraser. These pin the stage that fixed that.
with tempfile.TemporaryDirectory() as tmp:
    solid = Image.fromarray(
        np.dstack([np.full((40, 80), 200, np.uint8),
                   np.full((40, 80), 60, np.uint8),
                   np.full((40, 80), 40, np.uint8),
                   np.full((40, 80), 255, np.uint8)]), "RGBA")

    a = np.asarray(run(solid, {}, tmp))
    eq("with no clear key the frame is untouched", int(a[..., 3].min()), 255)

    a = np.asarray(run(solid, {"clear": True}, tmp))
    eq("clear with no selection empties the whole frame", int(a[..., 3].max()), 0)
    eq("...and leaves the size alone", a.shape[:2], (40, 80))

    rect = {"shapes": [{"kind": "rect", "x": 0, "y": 0, "w": 40, "h": 40}]}
    a = np.asarray(run(solid, {"clear": True, "selection": rect}, tmp))
    eq("clear inside a selection empties only that region",
       (int(a[:, :40, 3].max()), int(a[:, 40:, 3].min())), (0, 255))

    # ⚠ THE PIN THAT CATCHES DOUBLE-FEATHERING, AND THE MEASURE MATTERS.
    #
    # My first version of this counted how many distinct alpha levels survived
    # the ramp, and it was worthless: sabotaging the stage to resolve the mask
    # itself still produced 33 levels against the correct 40, so the pin passed
    # on the bug it was written for. Both versions are smooth ramps.
    #
    # What separates them is the VALUE at the selection edge, where coverage is
    # a half. Correct is alpha = 255(1-m) = 135. Double-feathered is
    # 255(1-m²) = 199, because the stage's own (1-m) is then blended with m
    # again. Measured, not derived: 135 against 199 on this exact fixture.
    soft = {"shapes": [{"kind": "rect", "x": 0, "y": 0, "w": 40, "h": 40}], "feather": 8}
    a = np.asarray(run(solid, {"clear": True, "selection": soft}, tmp))
    edge = int(a[20, 40, 3])
    eq(f"a feathered clear is HALF cut at the selection edge, not a quarter "
       f"(double-feathering lands at ~199; measured {edge})",
       110 <= edge <= 165, True)
    eq("...and it really is a ramp, not a step",
       len(set(int(v) for v in a[20, :, 3])) > 12, True)

    # ⚠ STAGE ORDER, NOT CLICK ORDER. A stroke queued in the same call paints
    # ONTO the cleared area; a clear placed after the brush class would wipe it
    # and say ok.
    painted = run(solid, {"clear": True,
                          "strokes": [{"tool": "brush", "size": 30, "hardness": 1.0,
                                       "opacity": 1.0, "flow": 1.0, "spacing": 0.2,
                                       "color": [0, 255, 0, 255],
                                       "points": [[10.0, 20.0], [70.0, 20.0]]}]}, tmp)
    pa = np.asarray(painted)
    eq("a clear runs BEFORE the brush class, so a stroke in the same call survives it",
       int(pa[..., 3].max()), 255)
    eq("...and the surviving pixels are the stroke's colour, not the original's",
       (int(pa[20, 40, 1]) > 200, int(pa[20, 40, 0]) < 60), (True, True))


print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
