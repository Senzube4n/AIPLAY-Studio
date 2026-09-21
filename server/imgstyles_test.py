"""THE FOUR LAYER STYLES ADDED 2026-09-21, AND THE PROPERTY THEY ALL SHARE.

The document model carried six of Photoshop's ten. These are the four that make
a layer read as an OBJECT rather than a flat fill: a bevel, a satin sheen, and
the two overlays that are not one flat colour.

⚠ THE PIN THAT CAUGHT A REAL BUG. Every style here paints INSIDE the matte and
leaves alpha alone — that is the contract `_tint_inside` is built on. The first
version of the two overlays set coverage to a constant across the whole buffer,
so they painted colour OUTSIDE the shape. With straight alpha that is invisible
when it composites, which is exactly why it would have survived: the render
looked right and the buffer was wrong, and anything premultiplying later would
have found colour sitting outside the letterform. Found by rendering a square
and measuring outside it, not by reading the code.
"""
import os
import sys

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "vfx"))
sys.path.insert(0, _HERE)

import engine            # noqa: E402
import imgdoc            # noqa: E402

PASS = FAIL = 0


def ok(what, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok    {what}")
    else:
        FAIL += 1
        print(f"  FAIL  {what}" + (f"\n        {extra}" if extra else ""))


NEW = ("bevelEmboss", "satin", "gradientOverlay", "patternOverlay")

print("\nLAYER STYLES — THE FOUR PHOTOSHOP HAS AND THIS DID NOT")

# ── declared everywhere one list is read ───────────────────────────────────
ok("all four are in the catalogue the validator and the tools read",
   all(n in imgdoc.STYLE_CATALOG for n in NEW),
   str([n for n in NEW if n not in imgdoc.STYLE_CATALOG]))
ok("...and the renderer can draw every one the catalogue declares",
   all(n in engine.STYLES for n in imgdoc.STYLE_CATALOG),
   str([n for n in imgdoc.STYLE_CATALOG if n not in engine.STYLES]))
ok("...and every one has a place in the painting order",
   all(n in imgdoc.STYLE_ORDER for n in imgdoc.STYLE_CATALOG))
ok("the set is Photoshop's ten", len(imgdoc.STYLE_CATALOG) == 10,
   f"{len(imgdoc.STYLE_CATALOG)}: {sorted(imgdoc.STYLE_CATALOG)}")
# The bevel reads as the surface the rest sit on, so it paints last.
ok("...and the bevel paints last, being the surface the others sit on",
   imgdoc.STYLE_ORDER[-1] == "bevelEmboss", str(imgdoc.STYLE_ORDER))

# ── the shared contract, measured on a real matte ──────────────────────────
H = W = 128
base = np.zeros((H, W, 4), np.float32)
base[32:96, 32:96] = [0.4, 0.45, 0.55, 1.0]

PARAMS = {
    "bevelEmboss": {"size": 8, "depth": 140, "angle": 120, "opacity": 95},
    "satin": {"distance": 18, "size": 8, "opacity": 85},
    "gradientOverlay": {"startColor": [255, 0, 0], "endColor": [0, 0, 255]},
    "patternOverlay": {"pattern": "dots", "size": 12, "opacity": 95},
}
for name in NEW:
    out = engine.STYLES[name](base.copy(), PARAMS[name], 1.0, False)
    d = np.abs(out[..., :3] - base[..., :3])
    inside = float(d[32:96, 32:96].mean())
    outside = float(max(d[:32].max(), d[96:].max()))
    ok(f"{name}: changes the layer where the matte is (mean {inside:.3f})", inside > 0.01,
       "a style that changes nothing is a style nobody can see")
    # ⚠ THE ONE THAT CAUGHT THE BUG.
    ok(f"...and NOTHING outside it (max {outside:.5f})", outside < 1e-6,
       "straight alpha hides this on composite, which is why it has to be measured here")
    ok("...and leaves alpha exactly as it found it",
       np.allclose(out[..., 3], base[..., 3]))

# ── a style at zero does nothing at all ────────────────────────────────────
for name in NEW:
    out = engine.STYLES[name](base.copy(), {**PARAMS[name], "opacity": 0}, 1.0, False)
    ok(f"{name} at zero opacity is a bypass, not a faint version of itself",
       np.allclose(out, base))


# ═══════════════════════════════════════════════════════════════════════════
# THE STILL DOOR, ADDED 2026-09-21 — server/imgstyles.py
#
# Everything above tests the RENDERER, which has always been reachable from a
# layer document. These test the DOOR onto a photograph, where the interesting
# failure is not the arithmetic: it is that a flat picture has alpha 1
# everywhere, so a style either does nothing or repaints the frame. Measured on
# a 128x128 opaque plate at default parameters, before any of this was written:
#
#   stroke, outerGlow, dropShadow     max change 0.0000  — silent no-op
#   the other seven                   max change 0.15..0.60 — the whole frame
#
# Both are controls that look wired and are not, so the door refuses instead,
# and most of what follows is about pinning that the refusals CAN fire.
# ═══════════════════════════════════════════════════════════════════════════
import math                                                       # noqa: E402

import effects                                                    # noqa: E402
import imgstyles                                                  # noqa: E402

print("\nLAYER STYLES ON A STILL — THE DOOR THE PICTURE EDITOR NEVER HAD")

ALL10 = tuple(imgstyles.style_order())
# Three of the ten paint outside the shape; seven never leave it. Measured, not
# asserted from the names: on a 128x128 plate at defaults only these three grew
# the layer's alpha.
GROWS = tuple(imgstyles.GROWS_ALPHA)
INSIDE_ONLY = tuple(n for n in ALL10 if n not in GROWS)

ok("the door serves engine's own painting order, not a sorted copy",
   ALL10 == tuple(engine.STYLE_ORDER), f"{ALL10} vs {engine.STYLE_ORDER}")
ok("...and the literal fallback in imgstyles has not drifted from it",
   imgstyles.STYLE_ORDER == tuple(engine.STYLE_ORDER))
ok("...and it is not alphabetical, which is the whole reason it is declared",
   list(ALL10) != sorted(ALL10))
_cat = imgstyles.catalog()
ok("the catalog names every style the renderer can draw",
   set(_cat["styles"]) == set(engine.STYLES), str(set(_cat["styles"]) ^ set(engine.STYLES)))
ok("...and declares the door's own parameters beside them",
   all(k in _cat["params"] for k in
       ("styles", "selection", "useAlpha", "globalLight")))
ok("...and says out loud that three styles paint outside the shape",
   set(_cat["growsAlpha"]) == set(GROWS))

# ── the docstring's count of what was already reachable, made testable ─────
#
# The brief that commissioned this said six of the ten had no equivalent in the
# 88-effect registry. Measured, it is THREE: fill/stencil is colorOverlay,
# ramp/stencil is gradientOverlay and checkerboard/stencil is a partial
# patternOverlay. If somebody adds one of the remaining three to effects.py,
# this fails and the module docstring gets corrected rather than going stale.
ok("the seven styles the docstring calls 'already rough-reachable' are in the registry",
   all(n in effects.CATALOG for n in
       ("dropShadow", "stroke", "fill", "ramp", "checkerboard", "bevelAlpha", "glow")))
ok("...and the three it calls genuinely absent still are",
   not any(n in effects.CATALOG for n in ("innerShadow", "innerGlow", "satin")),
   "if one landed, the imgstyles docstring's count is now wrong")

# ── the fixtures ───────────────────────────────────────────────────────────
FH = FW = 128
PHOTO = np.zeros((FH, FW, 4), np.float32)              # an opaque photograph
PHOTO[...] = [0.42, 0.47, 0.56, 1.0]
PHOTO[:, ::9, 0] = 0.8                                 # some texture to disturb
SEL = {"shapes": [{"kind": "rect", "x": 32, "y": 32, "w": 64, "h": 64}]}
IN, OUTB = np.s_[34:94, 34:94], np.s_[0:28, 0:28]      # well inside / well outside
# The same two regions as boolean planes, holding a 2px cordon off the edge so
# that antialiasing on the selection boundary cannot decide a pin either way.
# ⚠ OUT_M IS THE WHOLE OUTSIDE, not a corner. A corner probe passed the seven
# inside-only styles and failed stroke and dropShadow for the wrong reason: a
# 5px stroke never reaches a far corner and a shadow thrown down-right never
# reaches the top-left one. A pin that measures the wrong place is worse than
# no pin, because it reads as a bug in the code under test.
IN_M = np.zeros((FH, FW), bool)
IN_M[34:94, 34:94] = True
OUT_M = np.ones((FH, FW), bool)
OUT_M[30:98, 30:98] = False

CUTOUT = np.zeros((FH, FW, 4), np.float32)             # a cutout, alpha is the shape
CUTOUT[32:96, 32:96] = [0.42, 0.47, 0.56, 1.0]

# ⚠ A HARD-EDGED CUTOUT CANNOT TEST THE SQUARING TRAP: its alpha is 0 or 1 and
# 0² = 0, 1² = 1, so the wrong arithmetic gives the right answer. Caught by
# deliberately squaring the matte and watching the pin pass anyway. A soft edge
# is the only fixture that can tell the two apart, so the cutout pins use this.
_yy, _xx = np.mgrid[0:FH, 0:FW].astype(np.float32)
SOFTCUT = np.zeros((FH, FW, 4), np.float32)
SOFTCUT[..., :3] = [0.42, 0.47, 0.56]
SOFTCUT[..., 3] = np.clip(
    (40.0 - np.sqrt((_xx - 63.5) ** 2 + (_yy - 63.5) ** 2)) / 12.0, 0.0, 1.0)

# Parameters chosen so every style has something visible to do on a 64px
# square. A style tested at a size the fixture cannot show is a pin that passes
# for the wrong reason.
P10 = {
    "patternOverlay": {"pattern": "dots", "size": 12, "opacity": 95},
    "gradientOverlay": {"startColor": [255, 0, 0], "endColor": [0, 0, 255]},
    "colorOverlay": {"color": [255, 0, 0], "opacity": 90},
    "satin": {"distance": 18, "size": 8, "opacity": 85},
    "innerGlow": {"color": [255, 255, 0], "size": 14, "opacity": 90},
    "innerShadow": {"distance": 8, "size": 8, "opacity": 90},
    "stroke": {"color": [255, 0, 255], "size": 5, "opacity": 100},
    "outerGlow": {"color": [0, 255, 255], "size": 14, "opacity": 100},
    "dropShadow": {"distance": 10, "size": 6, "opacity": 90},
    "bevelEmboss": {"size": 8, "depth": 140, "angle": 120, "opacity": 95},
}

# ── every one of the ten does something MEASURABLE through the door ────────
#
# A style that silently does nothing is the failure this module exists to
# prevent, so each of the ten is rendered alone against a real selection and
# the difference is measured where it belongs.
for name in ALL10:
    notes = []
    out = imgstyles.apply_style_op(
        PHOTO, {"styles": {name: P10[name]}, "selection": SEL}, notes)
    # ⚠ THE FRAME CHECK COMES FIRST, and the rest is skipped when it fails.
    # Measuring `out - PHOTO` on a buffer that grew raises a broadcast error
    # before any pin can name the damage, so a style that started padding the
    # canvas would crash the suite rather than fail one line of it. Found by
    # making apply_styles pad by 8px and watching the run die.
    if out.shape != PHOTO.shape:
        ok(f"{name}: keeps the frame it was given", False,
           f"came back {out.shape} from {PHOTO.shape} — styles are clipped at "
           f"the frame, they never grow it")
        continue
    ok(f"{name}: keeps the frame it was given "
       f"({out.shape[1]}x{out.shape[0]})", True)
    d = np.abs(out - PHOTO)
    inside = float(d[IN_M].max())
    outside = float(d[OUT_M].max())
    if name in INSIDE_ONLY:
        ok(f"{name}: changes the picture inside the shape (max {inside:.3f})",
           inside > 0.01, "a style nobody can see is a control that is not wired")
        # ⚠ THE PIN THE ORIGINAL BUG NEEDED, now at the door as well as the
        # renderer. Seven of the ten must not touch a pixel outside the shape —
        # and this is measured on the COMPOSITED result, where a style that
        # leaked would be visible rather than hidden by straight alpha.
        ok(f"...and NOTHING outside it (max {outside:.6f})", outside < 1e-6,
           "the selection is the layer; paint outside it and it is not a style")
    else:
        ok(f"{name}: paints OUTSIDE the shape, which is what it is for "
           f"(max {outside:.3f})", outside > 0.01,
           "a drop shadow that stops at the layer edge is not a drop shadow")
        # NOT "and inside too". A drop shadow under an OPAQUE layer changes
        # nothing inside the shape, and that is correct: the shadow is behind
        # the layer and the layer covers it. Asserting otherwise was a pin
        # measuring the wrong thing, and it failed a working renderer.
        ok(f"...and changes the picture somewhere (max {float(d.max()):.3f})",
           float(d.max()) > 0.01)
    ok("...and comes back finite and in range", bool(np.isfinite(out).all())
       and float(out.min()) >= 0.0 and float(out.max()) <= 1.0)

# ── the order is engine's, not the caller's ────────────────────────────────
_three = {"dropShadow": P10["dropShadow"], "stroke": P10["stroke"],
          "colorOverlay": P10["colorOverlay"]}
_fwd = imgstyles.apply_style_op(PHOTO, {"styles": dict(_three), "selection": SEL})
_rev = imgstyles.apply_style_op(
    PHOTO, {"styles": {k: _three[k] for k in reversed(list(_three))},
            "selection": SEL})
ok("two callers writing the same styles in different orders get the SAME pixels",
   np.array_equal(_fwd, _rev), f"max {float(np.abs(_fwd - _rev).max()):.5f}")
ok("...as a LIST in a third order too",
   np.array_equal(_fwd, imgstyles.apply_style_op(
       PHOTO, {"styles": [{"style": k, **_three[k]} for k in
                          ("stroke", "colorOverlay", "dropShadow")],
               "selection": SEL})))
# ...and the pin above is not vacuous, because the order genuinely changes the
# picture. Painted in the reverse of engine's order by hand, the same three
# styles differ by the whole range.
_layer = PHOTO.copy()
_layer[..., 3] = imgstyles.resolve_matte(PHOTO, selection=SEL)[0]
_a, _b = _layer.copy(), _layer.copy()
_ord = [n for n in ALL10 if n in _three]
for n in _ord:
    _a = engine.STYLES[n](_a, _three[n], 1.0, False)
for n in reversed(_ord):
    _b = engine.STYLES[n](_b, _three[n], 1.0, False)
ok("...and that matters: the same three in the reverse order are a different "
   f"picture (max {float(np.abs(_a - _b).max()):.3f})",
   float(np.abs(_a - _b).max()) > 0.01,
   "if this ever passes trivially the order-independence pin above means nothing")
ok("an alias resolves to the style it names",
   np.array_equal(imgstyles.apply_style_op(
       PHOTO, {"styles": {"shadow": P10["dropShadow"]}, "selection": SEL}),
       imgstyles.apply_style_op(
           PHOTO, {"styles": {"dropShadow": P10["dropShadow"]}, "selection": SEL})))


def refuses(what, fn, must_say):
    """A refusal is only a refusal if it fires AND says something actionable."""
    try:
        fn()
    except imgstyles.StyleError as exc:
        said = must_say.lower() in str(exc).lower()
        ok(what + (f' — says "{must_say}"' if said else ""), said,
           f"refused, but the sentence does not mention {must_say!r}: {exc}")
        return
    except Exception as exc:                            # noqa: BLE001
        ok(what, False, f"raised {type(exc).__name__} instead of StyleError: {exc}")
        return
    ok(what, False, "it went through, which is the silent no-op this module exists to stop")


# ── the refusals ───────────────────────────────────────────────────────────
print("\n  the refusals — every one of these would otherwise be a silent no-op")
refuses("styles on an opaque photograph with no shape are refused",
        lambda: imgstyles.apply_style_op(PHOTO, {"styles": {"bevelEmboss": {}}}),
        "selection")
refuses("...and the sentence names the other way in too",
        lambda: imgstyles.apply_style_op(PHOTO, {"styles": {"bevelEmboss": {}}}),
        "usealpha")
refuses("useAlpha on an OPAQUE picture is refused, not honoured as 'everything'",
        lambda: imgstyles.apply_style_op(
            PHOTO, {"styles": {"dropShadow": {}}, "useAlpha": True}),
        "opaque edge to edge")
refuses("a selection that caught nothing is refused, not reported as success",
        lambda: imgstyles.apply_style_op(
            PHOTO, {"styles": {"dropShadow": {}},
                    "selection": {"shapes": [{"kind": "rect", "x": 900, "y": 900,
                                              "w": 10, "h": 10}]}}),
        "caught nothing")
refuses("...and so is a selection whose shape list is empty",
        lambda: imgstyles.apply_style_op(
            PHOTO, {"styles": {"dropShadow": {}}, "selection": {"shapes": []}}),
        "caught nothing")
refuses("a style name that does not exist is refused, and the ten are named",
        lambda: imgstyles.apply_style_op(
            PHOTO, {"styles": {"softLight": {}}, "selection": SEL}),
        "bevelemboss")
refuses("a style given twice under two spellings is refused rather than one lost",
        lambda: imgstyles.apply_style_op(
            PHOTO, {"styles": {"dropShadow": {}, "shadow": {"size": 40}},
                    "selection": SEL}),
        "twice")
refuses("selection AND useAlpha together is refused — a style has one shape",
        lambda: imgstyles.apply_style_op(
            PHOTO, {"styles": {"dropShadow": {}}, "selection": SEL,
                    "useAlpha": True}),
        "one shape")
refuses("a selection with no styles is refused rather than returning the input",
        lambda: imgstyles.apply_style_op(PHOTO, {"selection": SEL}),
        "nothing would be painted")
refuses("an unknown envelope key is refused, naming the real ones",
        lambda: imgstyles.apply_style_op(
            PHOTO, {"styles": {"dropShadow": {}}, "selction": SEL}),
        "globallight")
refuses("a matte in another frame's coordinates is refused, not resized",
        lambda: imgstyles.apply_styles(
            PHOTO, {"dropShadow": {}}, matte=np.ones((64, 64), np.float32)),
        "does not register")
# `describe` answers the same question WITHOUT raising, because "this picture
# has no shape" is a legitimate answer for a UI to grey a control out on.
_d = imgstyles.describe(PHOTO, {})
ok("describe() reports the same picture as unshaped instead of raising",
   _d["shaped"] is False and "opaque" in _d["why"])
ok("...and reports a real selection as shaped, with its coverage",
   imgstyles.describe(PHOTO, {"selection": SEL})["shaped"] is True
   and abs(imgstyles.describe(PHOTO, {"selection": SEL})["coverage"] - 0.25) < 0.01)

# ── the cutout path: the picture's own alpha IS the layer ──────────────────
print("\n  the cutout, where the picture's own alpha is the shape")
_cut = imgstyles.apply_style_op(
    CUTOUT, {"styles": {"bevelEmboss": P10["bevelEmboss"]}, "useAlpha": True})
ok("a bevel on a cutout changes it where the cutout is",
   float(np.abs(_cut[IN] - CUTOUT[IN]).max()) > 0.01)
ok("...and leaves the transparent surround alone",
   float(np.abs(_cut[OUTB] - CUTOUT[OUTB]).max()) < 1e-6)
ok("...and does not move the matte a bevel is not allowed to move",
   np.allclose(_cut[..., 3], CUTOUT[..., 3]))
# ⚠ THE SQUARING TRAP. The cutout path must NOT multiply the matte by the
# picture's alpha again — alpha*alpha is a thinner, softer shape and nothing
# would say so. The layer's alpha has to come back exactly as it went in, and
# it is measured on the SOFT cutout because a hard one cannot tell 0² from 0.
_partial = float(((SOFTCUT[..., 3] > 0.01) & (SOFTCUT[..., 3] < 0.99)).sum())
ok(f"the soft cutout really has a partial edge ({_partial:.0f} px), or the pin "
   f"below is vacuous", _partial > 500)
_m, _src = imgstyles.resolve_matte(SOFTCUT, use_alpha=True)
ok("the cutout's matte is its alpha, not its alpha squared",
   np.array_equal(_m, SOFTCUT[..., 3]),
   f"max {float(np.abs(_m - SOFTCUT[..., 3]).max()):.5f} — a squared matte is a "
   f"thinner, softer edge and nothing else here would say so")
ok("...and styling a soft cutout leaves that edge exactly where it was",
   np.allclose(imgstyles.apply_style_op(
       SOFTCUT, {"styles": {"colorOverlay": P10["colorOverlay"]},
                 "useAlpha": True})[..., 3], SOFTCUT[..., 3]))
_shadow = imgstyles.apply_style_op(
    CUTOUT, {"styles": {"dropShadow": P10["dropShadow"]}, "useAlpha": True})
ok("...and a drop shadow on a cutout grows the alpha, as a shadow must",
   float(_shadow[..., 3].sum()) > float(CUTOUT[..., 3].sum()) + 100.0)

# ── the composite, where the destination is NOT opaque ─────────────────────
#
# ⚠ THE DIVIDE IN `_over` IS ONLY EXERCISED BY PARTIAL ALPHA. Against an opaque
# photograph the destination alpha is 1 everywhere, so premultiplied arithmetic
# with no divide gives bit-identical answers and every pin above passes with the
# divide deleted. The fixture has to have a soft alpha for the pin to mean
# anything: this one ramps from 0.3 to 0.7 across the frame, so there is no
# pixel where the two agree by accident.
print("\n  the composite, on a picture that is not opaque")
SOFT = np.zeros((FH, FW, 4), np.float32)
SOFT[..., :3] = [0.42, 0.47, 0.56]
SOFT[..., 3] = 0.3 + 0.4 * (np.arange(FW, dtype=np.float32) / (FW - 1))[None, :]
_soft = imgstyles.apply_style_op(
    SOFT, {"styles": {"colorOverlay": P10["colorOverlay"]}, "selection": SEL})
ok("outside the shape a half-transparent picture comes back BIT-IDENTICAL",
   float(np.abs(_soft - SOFT)[OUT_M].max()) < 1e-6,
   f"max {float(np.abs(_soft - SOFT)[OUT_M].max()):.4f} — compositing the layer "
   f"back without the divide darkens every partial-alpha pixel it lands on")
ok("...and its alpha is untouched, because an overlay does not move a matte",
   np.allclose(_soft[..., 3], SOFT[..., 3]))
ok("...while inside the shape the overlay landed",
   float(np.abs(_soft - SOFT)[IN_M].max()) > 0.01)

# ⚠ THE PIN THAT CAUGHT THE COMPOSITE BUG. A selection PARTITIONS the picture;
# it does not put a second surface in front of it. So lifting a layer out and
# putting it back with the styles doing NOTHING has to be the identity — at the
# feathered edge as much as anywhere. Reassembled with a plain `over` it is not:
# a 50% edge on an opaque photograph came back at alpha 0.75, a soft seam around
# every feathered selection that nothing else in the suite could see.
FEATHER = {"shapes": [{"kind": "rect", "x": 32, "y": 32, "w": 64, "h": 64}],
           "feather": 9}
_fm, _ = imgstyles.resolve_matte(PHOTO, selection=FEATHER)
ok("the feathered fixture really is partial, or the pin below is vacuous",
   0.01 < float(_fm[(_fm > 0.01) & (_fm < 0.99)].size) / _fm.size,
   "no partial-coverage pixels means `over` and `add` agree by accident")
for _name, _pic in (("an opaque photograph", PHOTO), ("a soft-alpha picture", SOFT)):
    _id = imgstyles.apply_style_op(
        _pic, {"styles": {"colorOverlay": {"opacity": 0}}, "selection": FEATHER})
    ok(f"lifting a layer out of {_name} through a FEATHERED selection and "
       f"putting it back unchanged is the identity",
       float(np.abs(_id - _pic).max()) < 1e-6,
       f"max {float(np.abs(_id - _pic).max()):.4f} (alpha "
       f"{float(np.abs(_id[..., 3] - _pic[..., 3]).max()):.4f}) — a partition "
       f"reassembled with `over` inflates alpha wherever the mask is partial")

# ── trap 4: a style that grows outside the frame is CLIPPED ────────────────
print("\n  the light that goes over the edge")
_edge = np.zeros((FH, FW, 4), np.float32)
_edge[40:88, 0:40] = [0.42, 0.47, 0.56, 1.0]           # flush to the left edge
_notes = []
_g = imgstyles.apply_style_op(
    _edge, {"styles": {"outerGlow": {"size": 40, "opacity": 100}},
            "useAlpha": True}, _notes)
ok("the buffer never grows, whatever the style reaches for",
   _g.shape == _edge.shape, f"{_g.shape} vs {_edge.shape}")
ok("...and a note says the glow is being clipped and names the fix",
   any("clipped" in n and "canvas" in n for n in _notes), str(_notes))
# The clipping is real loss, not an empty warning: the same shape rendered with
# room to its left carries light in those columns, and the frame above has
# nowhere to put it.
_pad = np.zeros((FH, FW + 64, 4), np.float32)
_pad[40:88, 64:104] = [0.42, 0.47, 0.56, 1.0]
_pg = imgstyles.apply_style_op(
    _pad, {"styles": {"outerGlow": {"size": 40, "opacity": 100}},
           "useAlpha": True})
_lost = float(_pg[:, :64, 3].max())
ok(f"...and there really was light out there to lose (alpha {_lost:.3f} in the "
   f"64 columns the small frame does not have)", _lost > 0.05,
   "if this is 0 the warning above is noise")
_notes2 = []
imgstyles.apply_style_op(
    CUTOUT, {"styles": {"outerGlow": {"size": 40}}, "useAlpha": True}, _notes2)
ok("...and a shape that does NOT touch the edge gets no such warning",
   not any("clipped" in n for n in _notes2), str(_notes2))
_notes3 = []
imgstyles.apply_styles(_edge, {"dropShadow": {"size": 0, "spread": 0,
                                              "distance": 0}}, notes=_notes3)
ok("...and neither does a shadow explicitly told to reach nowhere",
   not any("clipped" in n for n in _notes3), str(_notes3))

# ── trap 3: there is no global light, so this door supplies one ────────────
print("\n  where the sun is")


def _light(name, params, key):
    """The direction a lit style puts its business, in screen degrees."""
    lay = CUTOUT.copy()
    out = engine.STYLES[name](lay, params, 1.0, False)
    if key == "grow":
        m = np.clip(out[..., 3] - CUTOUT[..., 3], 0, 1)
    elif key == "dark":
        m = np.clip(CUTOUT[..., :3].mean(2) - out[..., :3].mean(2), 0, 1) * CUTOUT[..., 3]
    else:
        m = np.clip(out[..., :3].mean(2) - CUTOUT[..., :3].mean(2), 0, 1) * CUTOUT[..., 3]
    s = m.sum()
    if s < 1e-6:
        return None
    ys, xs = np.mgrid[0:FH, 0:FW]
    cx = float((xs * m).sum() / s) - (FW - 1) / 2.0
    cy = float((ys * m).sum() / s) - (FH - 1) / 2.0
    return math.degrees(math.atan2(-cy, cx)) % 360.0


def _apart(a, b):
    return min(abs(a - b), 360.0 - abs(a - b))


A = 90.0
_band = _light("innerShadow", {"angle": A, "distance": 16, "size": 2, "opacity": 100}, "dark")
_hi = _light("bevelEmboss", {"angle": A, "size": 6, "depth": 200, "opacity": 100}, "light")
_throw = _light("dropShadow", {"angle": A, "distance": 24, "size": 2, "opacity": 100}, "grow")
ok(f"WITHOUT a global light the renderer's three lit styles disagree: at angle "
   f"{A:g} the inner shadow bands at {_band:.0f}deg and the bevel lights from "
   f"{_hi:.0f}deg, {_apart(_band, _hi):.0f}deg apart",
   _apart(_band, _hi) > 45.0,
   "if they now agree, engine gained a global light and imgstyles' trap 3 is stale")
_hi_fixed = _light("bevelEmboss",
                   {"angle": -A, "size": 6, "depth": 200, "opacity": 100}, "light")
ok(f"...and negating the bevel's angle is the fix ({_apart(_band, _hi_fixed):.0f}deg apart)",
   _apart(_band, _hi_fixed) < 15.0)
ok("...which is exactly what globalLight does, and only for the bevel",
   imgstyles.GLOBAL_LIGHT_STYLES == {"dropShadow": 1.0, "innerShadow": 1.0,
                                     "bevelEmboss": -1.0})
_gl = imgstyles._with_global_light(
    [("dropShadow", {}), ("innerShadow", {}), ("bevelEmboss", {}), ("satin", {})],
    A, [])
_gl = dict(_gl)
ok("globalLight sets one angle for the three lit styles",
   _gl["dropShadow"]["angle"] == A and _gl["innerShadow"]["angle"] == A
   and _gl["bevelEmboss"]["angle"] == -A, str(_gl))
ok("...and leaves satin out, because its angle is a fold and not a light",
   "angle" not in _gl["satin"])
ok("...and a style that set its OWN angle keeps it, as Photoshop's per-style "
   "'use global light' checkbox allows",
   dict(imgstyles._with_global_light([("dropShadow", {"angle": 12})], A, []))
   ["dropShadow"]["angle"] == 12)
_n = []
imgstyles.apply_style_op(
    PHOTO, {"styles": {"dropShadow": {}, "bevelEmboss": {}}, "selection": SEL,
            "globalLight": 120}, _n)
ok("...and it says so in the notes rather than changing the picture quietly",
   any("globalLight" in x and "negated" in x for x in _n), str(_n))

# ── trap 7: a style the renderer cannot draw is REPORTED, not printed ──────
#
# engine's _apply_styles prints the failure to stderr and carries on, which is
# right for frame 4000 of a render and wrong for a person who clicked a button.
# The renderer is monkeypatched rather than fed a parameter that happens to
# raise today: a pin that depends on which number crashes cv2 is a pin that
# stops testing anything the moment cv2 is upgraded.
print("\n  a style the renderer cannot draw")
_real = engine.STYLES["satin"]
try:
    def _explode(*_a, **_k):
        raise RuntimeError("the fold went nowhere")

    engine.STYLES["satin"] = _explode
    _n, _sk = [], []
    _out = imgstyles.apply_style_op(
        PHOTO, {"styles": {"satin": P10["satin"],
                           "colorOverlay": P10["colorOverlay"]},
                "selection": SEL}, _n, _sk)
    ok("the failing style lands in `skipped` with its reason",
       [s["style"] for s in _sk] == ["satin"]
       and "went nowhere" in _sk[0]["reason"], str(_sk))
    ok("...and in the notes the caller already surfaces",
       any("satin was skipped" in x for x in _n), str(_n))
    ok("...and the styles that CAN be drawn still are",
       float(np.abs(_out - PHOTO)[IN_M].max()) > 0.01,
       "one bad style must not cost the other nine")

    def _wrong_shape(*_a, **_k):
        return np.zeros((4, 4, 4), np.float32)

    engine.STYLES["satin"] = _wrong_shape
    _n2, _sk2 = [], []
    imgstyles.apply_style_op(PHOTO, {"styles": {"satin": P10["satin"]},
                                     "selection": SEL}, _n2, _sk2)
    ok("...and a renderer that hands back the wrong size is skipped, not pasted",
       [s["style"] for s in _sk2] == ["satin"], str(_sk2))
finally:
    engine.STYLES["satin"] = _real

# ── trap 6: NaN and Inf, on every one of the ten ───────────────────────────
print("\n  NaN and Inf, which seven of the ten carry straight through")
_dirty = PHOTO.copy()
_dirty[50, 50, 0] = np.nan
_dirty[60, 60, 1] = np.inf
_dirty[70, 70, 2] = -np.inf
_dirty[45, 45, 3] = np.nan
for name in ALL10:
    out = imgstyles.apply_style_op(
        _dirty, {"styles": {name: P10[name]}, "selection": SEL})
    ok(f"{name}: NaN and Inf in, finite and in range out",
       bool(np.isfinite(out).all()) and float(out.min()) >= 0.0
       and float(out.max()) <= 1.0,
       f"{int(np.isnan(out).sum())} NaN, {int(np.isinf(out).sum())} Inf, "
       f"range {float(np.nanmin(out)):.2f}..{float(np.nanmax(out)):.2f}")
# ...and the renderer really does carry them, so the scrub above is load-bearing.
_raw = np.zeros((FH, FW, 4), np.float32)
_raw[32:96, 32:96] = [0.4, 0.45, 0.55, 1.0]
_raw[50, 50, 0] = np.nan
_carried = [n for n in ALL10
            if np.isnan(engine.STYLES[n](_raw.copy(), P10[n], 1.0, False)).any()]
ok(f"...and that is not free: {len(_carried)} of the ten propagate a NaN "
   f"({', '.join(_carried)})", len(_carried) > 0,
   "if none do any more, the scrub is still right but the docstring's count is stale")

# ── the door: {mode, jobPath}, and `ok` is not a verdict ───────────────────
print("\n  the {mode, jobPath} door")
import json as _json                                              # noqa: E402
import subprocess                                                 # noqa: E402
import tempfile                                                   # noqa: E402
from PIL import Image                                             # noqa: E402

_tmp = tempfile.mkdtemp(prefix="imgstyles_")
_src = os.path.join(_tmp, "in.png")
Image.fromarray((PHOTO * 255).astype(np.uint8), "RGBA").save(_src)


def _door(mode, job):
    p = os.path.join(_tmp, "job.json")
    with open(p, "w", encoding="utf-8") as f:
        f.write(_json.dumps(job))
    r = subprocess.run([sys.executable, os.path.join(_HERE, "imgstyles.py"), mode, p],
                       capture_output=True, text=True)
    try:
        return _json.loads(r.stdout.strip().splitlines()[-1]), r.returncode
    except Exception:                                   # noqa: BLE001
        return {"ok": False, "error": f"unparseable: {r.stdout!r} {r.stderr!r}"}, r.returncode


_c = subprocess.run([sys.executable, os.path.join(_HERE, "imgstyles.py"), "catalog"],
                    capture_output=True, text=True)
ok("catalog mode prints one JSON line naming the ten in PAINTING order",
   _json.loads(_c.stdout)["order"] == list(engine.STYLE_ORDER),
   "a UI generated from a sorted copy of this paints in the wrong order")
_dst = os.path.join(_tmp, "out.png")
_mdst = os.path.join(_tmp, "matte.png")
_rep, _rc = _door("apply", {"in": _src, "out": _dst, "selection": SEL,
                            "styles": {"dropShadow": P10["dropShadow"],
                                       "stroke": P10["stroke"]},
                            "matteOut": _mdst})
ok("apply mode renders and reports ok", _rep.get("ok") is True and _rc == 0, str(_rep))
ok("...and writes the file it says it wrote", os.path.exists(_dst))
ok("...and names what it applied, in painting order",
   _rep.get("applied") == ["stroke", "dropShadow"], str(_rep.get("applied")))
ok("...and hands back the matte as a plate, with its source and coverage",
   os.path.exists(_mdst) and _rep["matte"]["source"] == "selection"
   and abs(_rep["matte"]["coverage"] - 0.25) < 0.01, str(_rep.get("matte")))
ok("...and surfaces the notes rather than swallowing them",
   any("shape came from" in n for n in _rep.get("notes") or []))
_bad, _brc = _door("apply", {"in": _src, "out": _dst, "styles": {"dropShadow": {}}})
ok("a refusal comes back ok:false with the sentence, and a non-zero exit",
   _bad.get("ok") is False and "selection" in _bad.get("error", "") and _brc != 0,
   str(_bad))
# ⚠ THE TWO WORDS. `ok` says the call worked; the verdict about the picture has
# its own key. Collapsing them was a real bug in this repo this week.
_desc, _drc = _door("describe", {"in": _src})
ok("describe says ok:true (the call worked) and report.shaped:false (the answer "
   "is no) — two words for two things",
   _desc.get("ok") is True and _desc["report"]["shaped"] is False and _drc == 0,
   str(_desc))
_desc2, _ = _door("describe", {"in": _src, "selection": SEL})
ok("...and ok:true with shaped:true when there is a shape",
   _desc2.get("ok") is True and _desc2["report"]["shaped"] is True)
_unk, _urc = _door("wobble", {})
ok("an unknown mode is refused, not treated as catalog",
   _unk.get("ok") is False and _urc != 0)

print(f"\n  {PASS} passed, {FAIL} failed")
if FAIL:
    raise SystemExit(1)
