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
# The compositor's 75 effects already work on float32 (H,W,4) 0..1 straight
# alpha, which is what a PIL RGBA image becomes. Bridging beats reimplementing
# — a second copy of any of them is the two-sources-of-truth mistake this
# codebase has now made five times. These assertions exist to prove the bridge
# is CONNECTED, which is the half that keeps going missing.

print("\n  -- the shared effect registry --")

_fx = imagetools._effects_registry()
eq("the registry is reachable from imagetools", _fx is not None, True)

if _fx is not None:
    eq("all 75 effects are visible", len(_fx.CATALOG) >= 75, True)

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

print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
