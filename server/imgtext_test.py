"""Unit tests for the type tool in server/imgtext.py.

Text is the one part of an image editor where "it looks right" is the easiest
lie to tell yourself, because a paragraph that is subtly wrong still reads as a
paragraph. Everything here is therefore arithmetic: the gap between two
rendered baselines against `(ascent + descent) * lineHeight`, the width of a
tracked line against `(n-1) * tracking`, the pen ends of a justified line
against the box edges, a hard shadow against `a + b - a*b` of the glyph
coverage and its own shifted copy.

Four kinds of case:

  * SWEEPS over the CATALOG - every entry carries a label, a group and a why,
    every parameter is described and defaults inside its own range, every
    nested sub-spec points at something real. These fail as one line naming
    the offenders.
  * THE §9 LOCK - a perturbation table that must name every parameter in the
    catalog, and every one of them must provably change a render. A schema
    that accepts a knob the code ignores is the failure IMAGE_SPEC calls worse
    than a refusal, and this is the only test that can catch it. Adding a
    catalog entry without adding its perturbation fails the suite.
  * ONE MEANINGFUL ASSERTION PER FEATURE - not "it ran" but "line height 2.0
    doubles the measured baseline gap", "a 200-character word wraps and no
    line exceeds the box", "a justified line's pen ends are 0 and boxW to a
    hundredth of a pixel while the last line's is 219", "white glyph edges
    over black are grey and not a*a".
  * HOSTILE INPUT - empty, zero, negative, NaN, a box narrower than a glyph, a
    font that does not exist, and a font name reaching out of the font folder.

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/imgtext_test.py

The font-security case is asserted against imagetools.py's SOURCE rather than
against a remembered rule, and the legacy-adapter case reads the key list out
of imagetools.py's text stage the same way, because §9's last line says a test
that only locks in what its author already believed is worth nothing.
"""
import math
import os
import re
import sys
import tempfile
import time

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import imgtext as T                                        # noqa: E402

PASS = FAIL = 0
HERE = os.path.dirname(os.path.abspath(__file__))
NOTES = []


def eq(name, got, want):
    global PASS, FAIL
    if got == want:
        PASS += 1
        print(f"  ok    {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}\n          got {got!r}, wanted {want!r}")


def near(name, got, want, tol):
    ok = abs(float(got) - float(want)) <= tol
    if not ok:
        print(f"  ..    {name}: {float(got):.4f} vs {float(want):.4f} (tol {tol})")
    eq(name, ok, True)


def R(spec, w=400, h=300, mask=None):
    return T.render_text(spec, w, h, mask)


def ink(img):
    return float(img[..., 3].sum() if img.ndim == 3 else img.sum())


def alpha(img):
    return img[..., 3] if img.ndim == 3 else img


def bands(a, thresh=0.02):
    """Contiguous runs of rows carrying ink - one per rendered text line, as
    long as the line spacing leaves a gap, which every case here arranges."""
    on = np.any(a > thresh, axis=1)
    out, start = [], None
    for y, v in enumerate(on):
        if v and start is None:
            start = y
        elif not v and start is not None:
            out.append((start, y))
            start = None
    if start is not None:
        out.append((start, len(on)))
    return out


def extents(a, rows=None, thresh=0.02):
    """(x0, x1) of the ink, x1 exclusive. Over a row slice when given."""
    sub = a if rows is None else a[rows[0]:rows[1]]
    cols = np.any(sub > thresh, axis=0)
    if not cols.any():
        return None
    return int(np.argmax(cols)), int(len(cols) - np.argmax(cols[::-1]))


def row_center(a, band):
    """Alpha-weighted centre of a band - a sub-pixel row position, so a
    baseline gap can be checked to better than the pixel grid."""
    seg = a[band[0]:band[1]]
    w = seg.sum(axis=1)
    ys = np.arange(band[0], band[1], dtype=np.float64)
    return float((w * ys).sum() / max(w.sum(), 1e-9))


def shift_ref(a, dx, dy):
    """A whole-pixel shift written HERE, not imported. Comparing the module's
    shadow against the module's own _shift would pass just as happily if _shift
    were the broken part."""
    out = np.zeros_like(a)
    h, w = a.shape
    sx, sy = max(0, -dx), max(0, -dy)
    tx, ty = max(0, dx), max(0, dy)
    ww, hh = min(w - sx, w - tx), min(h - sy, h - ty)
    if ww > 0 and hh > 0:
        out[ty:ty + hh, tx:tx + ww] = a[sy:sy + hh, sx:sx + ww]
    return out


def orientation(a, thresh=0.05):
    """Major-axis angle of the ink in degrees, from the second moments. The
    only honest way to ask "was this glyph actually rotated"."""
    m = cv2.moments((a > thresh).astype(np.float32), binaryImage=False)
    if m["m00"] <= 0:
        return None
    return math.degrees(0.5 * math.atan2(2 * m["mu11"], m["mu20"] - m["mu02"]))


TMP = tempfile.TemporaryDirectory(prefix="imgtext_test_")
TEX_A = os.path.join(TMP.name, "tex_a.png")
TEX_B = os.path.join(TMP.name, "tex_b.png")
Image.fromarray(np.tile(np.linspace(0, 255, 64, dtype=np.uint8)[None, :, None], (64, 1, 3))
                ).save(TEX_A)
Image.fromarray(np.tile(np.linspace(255, 0, 64, dtype=np.uint8)[:, None, None], (1, 64, 3))
                ).save(TEX_B)

ALT_FONT = next((f for f in ("times.ttf", "cour.ttf", "verdana.ttf", "georgia.ttf",
                             "tahoma.ttf", "segoeui.ttf")
                 if T.resolve_font_path(f)), None)


print("\nimgtext\n")
print("  -- the catalog contract --")

bad = [k for k, e in T.CATALOG.items()
       if not (e.get("label") and e.get("why") and e.get("group") in T.GROUP_ORDER)]
eq("every entry has a label, a group and a why", bad, [])

bad = []
for k, e in T.CATALOG.items():
    for pk, p in e["params"].items():
        if "desc" not in p or "animatable" not in p or "type" not in p:
            bad.append(f"{k}.{pk}")
        if p["type"] == "number" and not (p["min"] <= p["default"] <= p["max"]):
            bad.append(f"{k}.{pk}")
        if p["type"] == "enum" and p["default"] not in p["options"]:
            bad.append(f"{k}.{pk}")
        if p["type"] == "color" and not (3 <= len(p["default"]) <= 4):
            bad.append(f"{k}.{pk}")
eq("every parameter is described and defaults inside its own range", bad, [])

eq("every nested sub-spec points at a real catalog entry",
   sorted({p["of"] for e in T.CATALOG.values() for p in e["params"].values()
           if p["type"] == "object"} - set(T.CATALOG)), [])

cat = T.catalog()
eq("catalog() serves the whole vocabulary and its notes",
   sorted(cat["names"]) == sorted(T.CATALOG) and bool(cat["notes"])
   and cat["groups"] == T.GROUP_ORDER, True)

eq("coerce_spec fills in every declared key and nothing else",
   sorted(T.coerce_spec({"content": "x"})), sorted(T.CATALOG["text"]["params"]))


print("\n  -- §9: every declared parameter provably changes a render --")

# (base patch, perturbed value). The base patch exists so a parameter is tested
# where it can matter: `fit` cannot be shown to do anything on a gradient fill,
# and `points` cannot be shown to do anything on an arc.
LINE = [[20.0, 150.0], [380.0, 150.0]]
TEXT_BASE = {"content": "Wave that\nRuns long here and wraps", "font": "arial.ttf",
             "size": 40, "box": [10, 10, 260, 200], "align": "justify"}
PERTURB = {
    "text": (TEXT_BASE, {
        "content": ({}, "Something else entirely to draw"),
        "font": ({}, ALT_FONT),
        "size": ({}, 56),
        "box": ({}, [30, 30, 200, 150]),
        "anchor": ({}, "center"),
        "align": ({}, "right"),
        "justifyLast": ({}, "right"),
        "valign": ({}, "bottom"),
        "lineHeight": ({}, 2.0),
        "tracking": ({}, 5.0),
        "wordSpacing": ({}, 9.0),
        "overflow": ({"box": [10, 10, 260, 46]}, "clip"),
        "minSize": ({"box": [10, 10, 260, 52], "overflow": "shrink", "size": 60}, 55),
        "smartPunctuation": ({"content": "don't say \"no\""}, True),
        "rotate": ({}, 15.0),
        "skewX": ({}, 22.0),
        "skewY": ({}, 14.0),
        "fill": ({}, {"type": "linear"}),
        "outline": ({}, {"width": 4}),
        "shadow": ({}, {"enabled": True}),
        "glow": ({}, {"enabled": True}),
        "path": ({}, {"kind": "line", "points": LINE}),
    }),
    "fill": ({"content": "FILL", "size": 90, "box": [10, 10, 0, 0],
              "fill": {"type": "linear", "space": "canvas", "start": [0, 0],
                       "end": [200, 0], "color": [255, 0, 0], "color2": [0, 0, 255],
                       "opacity": 100}}, {
        "type": ({}, "radial"),
        "color": ({}, [0, 255, 0]),
        "color2": ({}, [0, 255, 0]),
        "stops": ({}, [[0, 255, 255, 0, 255], [1, 0, 255, 255, 255]]),
        "space": ({}, "block"),
        "start": ({}, [140, 0]),
        "end": ({}, [60, 120]),
        "opacity": ({}, 35.0),
        "image": ({"fill": {"type": "image", "image": TEX_A}}, TEX_B),
        "fit": ({"fill": {"type": "image", "image": TEX_A}}, "tile"),
    }),
    "outline": ({"content": "O", "size": 130, "box": [40, 20, 0, 0],
                 "outline": {"width": 8, "color": [255, 0, 0], "join": "round",
                             "position": "outside", "opacity": 100}}, {
        "width": ({}, 18.0),
        "color": ({}, [0, 255, 0]),
        "opacity": ({}, 35.0),
        "join": ({}, "miter"),
        "position": ({}, "inside"),
    }),
    "shadow": ({"content": "S", "size": 130, "box": [90, 40, 0, 0],
                "shadow": {"enabled": True, "offsetX": 12, "offsetY": 12, "blur": 4,
                           "spread": 0, "color": [255, 0, 0], "opacity": 80}}, {
        "enabled": ({}, False),
        "offsetX": ({}, -12.0),
        "offsetY": ({}, -12.0),
        "blur": ({}, 22.0),
        "spread": ({}, 7.0),
        "color": ({}, [0, 255, 0]),
        "opacity": ({}, 20.0),
    }),
    "glow": ({"content": "G", "size": 130, "box": [90, 40, 0, 0],
              "glow": {"enabled": True, "radius": 10, "spread": 2, "color": [255, 0, 0],
                       "opacity": 90, "intensity": 1.0}}, {
        "enabled": ({}, False),
        "radius": ({}, 34.0),
        "spread": ({}, 12.0),
        "color": ({}, [0, 0, 255]),
        "opacity": ({}, 25.0),
        "intensity": ({}, 5.0),
    }),
    "path": ({"content": "PATHTEXT", "size": 34,
              "path": {"kind": "arc", "center": [190, 150], "radius": 110,
                       "startAngle": 180, "endAngle": 360, "align": "start"}}, {
        "kind": ({}, "line"),
        "points": ({"path": {"kind": "polyline", "points": [[20, 60], [380, 60]]}},
                   [[20, 60], [200, 240], [380, 60]]),
        "center": ({}, [230, 150]),
        "radius": ({}, 135.0),
        "startAngle": ({}, 205.0),
        # endAngle reaches the picture through the path LENGTH, so it is
        # tested where a length matters. With align "start" it genuinely
        # does nothing, the same way blur does nothing on a disabled shadow.
        "endAngle": ({"path": {"align": "center"}}, 335.0),
        "align": ({}, "center"),
        "offset": ({}, 70.0),
        "side": ({}, 26.0),
        "flip": ({}, True),
    }),
}

missing = []
for k, e in T.CATALOG.items():
    named = set(PERTURB[k][1]) if k in PERTURB else set()
    missing += [f"{k}.{p}" for p in e["params"] if p not in named]
eq("the perturbation table names every parameter in the catalog", sorted(missing), [])


def _merge(base, patch, key=None, value=None):
    out = {k: (dict(v) if isinstance(v, dict) else v) for k, v in base.items()}
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = {**out[k], **v}
        else:
            out[k] = v
    if key is not None:
        out[key] = value
    return out


dead = []
for entry_key, (base, table) in PERTURB.items():
    for pname, (patch, value) in table.items():
        if entry_key == "text":
            a = _merge(base, patch)
            b = _merge(base, patch, pname, value)
        else:
            a = _merge(base, patch)
            sub = dict(a.get(entry_key, {}))
            sub[pname] = value
            b = _merge(base, patch, entry_key, sub)
        if float(np.abs(R(a) - R(b)).max()) <= 0.002:
            dead.append(f"{entry_key}.{pname}")
eq("every catalog parameter changes the picture when it changes", dead, [])


print("\n  -- fonts: the basename-only rule, preserved and proven --")

src = open(os.path.join(HERE, "imagetools.py"), encoding="utf-8", errors="replace").read()
# The rule MOVED here rather than going away. imagetools used to take
# os.path.basename of the font name, which quietly accepted an absolute path
# and loaded whatever was at it; its type stage is now a call into this module,
# whose rule refuses a path outright. So the assertion follows the rule instead
# of the file, and what it pins is stronger than what it replaced.
eq("imagetools delegates the type stage here rather than resolving fonts itself",
   "imgtext" in src and "os.path.basename(str(txt.get(\"font\")" not in src, True)

eq("a plain shelf name resolves", bool(T.resolve_font_path("arial.ttf")), True)
for hostile in ("../arial.ttf", "..\\arial.ttf", "../../Windows/Fonts/arial.ttf",
                "C:/Windows/Fonts/arial.ttf", "C:\\Windows\\Fonts\\arial.ttf",
                "sub/arial.ttf", "sub\\arial.ttf", "fonts/../arial.ttf",
                "arial.ttf\x00.png", "/arial.ttf", "\\\\server\\share\\arial.ttf"):
    eq(f"refused: {hostile!r}", T.resolve_font_path(hostile), None)
eq("a non-font extension is refused too", T.resolve_font_path("arial.exe"), None)
eq("an empty name is refused", T.resolve_font_path(""), None)

# The attack end to end: a REAL font file, reachable by an absolute path, is
# still not loaded - the run falls back to the default face and says so.
warn = []
face = T.load_face("C:/Windows/Fonts/arial.ttf", 40, warn)
eq("a path-shaped font name never reaches FreeType", face.path, None)
eq("...and the refusal is reported, not swallowed",
   any("refused" in w for w in warn), True)
lay = T.layout_text({"content": "still draws", "font": "../../evil.ttf", "size": 32})
eq("a refused font still renders something rather than losing the text",
   ink(R({"content": "still draws", "font": "../../evil.ttf", "size": 32})) > 0, True)
eq("...with the warning on the layout", any("refused" in w for w in lay["warnings"]), True)
eq("a font that simply does not exist warns and falls back",
   any("refused" in w for w in T.layout_text({"content": "x",
                                              "font": "definitely-not-here.ttf"})["warnings"]),
   True)


print("\n  -- line height: the measured baseline gap, not just a taller image --")

ASC, DESC = T.load_face("arial.ttf", 64).ascent, T.load_face("arial.ttf", 64).descent
BOXLESS = {"content": "H\nH\nH", "font": "arial.ttf", "size": 64, "box": [20, 20, 0, 0]}
for lh in (1.0, 1.5, 2.0, 3.0):
    a = alpha(R({**BOXLESS, "lineHeight": lh}, 300, 700))
    bs = bands(a)
    eq(f"lineHeight {lh}: three rows render as three bands", len(bs), 3)
    if len(bs) == 3:
        g1 = row_center(a, bs[1]) - row_center(a, bs[0])
        g2 = row_center(a, bs[2]) - row_center(a, bs[1])
        near(f"lineHeight {lh}: gap is (ascent+descent)*{lh}", g1, (ASC + DESC) * lh, 0.25)
        near(f"lineHeight {lh}: both gaps agree", g2, g1, 0.05)

a1 = alpha(R({**BOXLESS, "lineHeight": 1.0}, 300, 700))
a2 = alpha(R({**BOXLESS, "lineHeight": 2.0}, 300, 700))
b1, b2 = bands(a1), bands(a2)
near("doubling lineHeight doubles the gap exactly",
     (row_center(a2, b2[1]) - row_center(a2, b2[0]))
     / (row_center(a1, b1[1]) - row_center(a1, b1[0])), 2.0, 0.005)
eq("...and does NOT change the ink", abs(ink(a1) - ink(a2)) < 0.5, True)


print("\n  -- letter spacing: (n-1) x tracking, in the render --")

WORD = "HHHHHHHH"
N = len(WORD)
base = {"content": WORD, "font": "arial.ttf", "size": 60, "box": [20, 20, 0, 0]}
w0 = T.layout_text(base)["lines"][0]["advance"]
for tr in (-3.0, 0.0, 2.5, 6.0, 14.0):
    lay = T.layout_text({**base, "tracking": tr})
    near(f"layout advance grows by (n-1)*{tr}", lay["lines"][0]["advance"] - w0,
         (N - 1) * tr, 1e-6)
    e0 = extents(alpha(R(base, 900, 200)))
    et = extents(alpha(R({**base, "tracking": tr}, 900, 200)))
    near(f"rendered width grows by (n-1)*{tr}", (et[1] - et[0]) - (e0[1] - e0[0]),
         (N - 1) * tr, 1.0)
eq("tracking is not folded into the trailing edge (pen ends match the advance)",
   abs((T.layout_text({**base, "tracking": 6.0})["lines"][0]["penEnd"]
        - T.layout_text({**base, "tracking": 6.0})["lines"][0]["penStart"])
       - (w0 + (N - 1) * 6.0)) < 1e-6, True)

near("word spacing adds exactly once per space",
     T.layout_text({"content": "a b c", "size": 40, "wordSpacing": 11.0})["lines"][0]["advance"]
     - T.layout_text({"content": "a b c", "size": 40})["lines"][0]["advance"], 22.0, 1e-6)


print("\n  -- word wrap --")

PROSE = ("The quick brown fox jumps over the lazy dog while a second sentence "
         "runs on for long enough to need four or five separate lines of wrapping.")
for boxw in (120, 200, 320, 640):
    lay = T.layout_text({"content": PROSE, "size": 28, "box": [10, 10, boxw, 0]})
    over = [round(r["advance"] - boxw, 3) for r in lay["lines"] if r["advance"] > boxw + 1e-6]
    eq(f"wrap at {boxw}px: no line exceeds the box", over, [])
    eq(f"wrap at {boxw}px: it actually wrapped", len(lay["lines"]) > 1, True)

LONG = "z" * 200
lay = T.layout_text({"content": LONG, "size": 28, "box": [10, 10, 200, 0]})
eq("a 200-character word is broken mid-word, not overflowed",
   [round(r["advance"], 3) for r in lay["lines"] if r["advance"] > 200 + 1e-6], [])
eq("...and every character survives the break",
   "".join(r["text"] for r in lay["lines"]), LONG)
eq("...over several lines", len(lay["lines"]) > 5, True)
a = alpha(R({"content": LONG, "size": 28, "box": [10, 10, 200, 0]}, 400, 900))
eq("...and the rendered ink stays inside the box too", extents(a)[1] <= 10 + 200 + 2, True)

lay = T.layout_text({"content": "aaa bbb " + LONG + " ccc", "size": 28,
                     "box": [10, 10, 200, 0]})
eq("a long word mixed into prose still never overflows",
   [round(r["advance"], 3) for r in lay["lines"] if r["advance"] > 200 + 1e-6], [])

# THE STATED RULE: a single glyph wider than the box gets its own line and
# overflows. Anything else is an empty line, i.e. a hang.
lay = T.layout_text({"content": "WWWW", "size": 90, "box": [0, 0, 6, 0]})
eq("a box narrower than one glyph gives one glyph per line", len(lay["lines"]), 4)
eq("...each line holding exactly one character",
   sorted({len(r["text"]) for r in lay["lines"]}), [1])
eq("...and that line overflows the box, as documented",
   lay["lines"][0]["advance"] > 6, True)

eq("explicit newlines are paragraph breaks even with no box",
   len(T.layout_text({"content": "one\ntwo\nthree", "size": 30})["lines"]), 3)
eq("CRLF is normalised",
   len(T.layout_text({"content": "one\r\ntwo", "size": 30})["lines"]), 2)
eq("trailing spaces hang outside the measured line",
   T.layout_text({"content": "ab   ", "size": 40})["lines"][0]["advance"],
   T.layout_text({"content": "ab", "size": 40})["lines"][0]["advance"])


print("\n  -- alignment --")

# Same-glyph words so both ends of every line are the same stem: side bearings
# then cancel and an ink measurement is a measurement of the ALIGNMENT and not
# of the typeface.
IBARS = ("III II IIII I III IIIII II IIII III I IIII II III IIIII I II "
         "IIII I III II IIIII IIII II I III IIII II IIIII I II III IIII")
BOX = [40.0, 30.0, 300.0, 0.0]
SPEC = {"content": IBARS, "font": "arial.ttf", "size": 30, "box": BOX, "lineHeight": 1.6}

a = alpha(R({**SPEC, "align": "left"}, 500, 400))
bs = bands(a)
eq("left: several lines", len(bs) >= 3, True)
lefts = [extents(a, b)[0] for b in bs]
eq("left: every line's ink starts at the same x", max(lefts) - min(lefts) <= 1, True)

a = alpha(R({**SPEC, "align": "right"}, 500, 400))
bs = bands(a)
rights = [extents(a, b)[1] for b in bs]
eq("right: every line's ink ends at the same x", max(rights) - min(rights) <= 1, True)

a = alpha(R({**SPEC, "align": "center"}, 500, 400))
bs = bands(a)
cx = BOX[0] + BOX[2] / 2.0
mids = [(extents(a, b)[0] + extents(a, b)[1]) / 2.0 for b in bs]
eq("center: every line is symmetric about the box centre to within a pixel",
   max(abs(m - cx) for m in mids) <= 1.0, True)
eq("...and the lines are not all the same length (so that meant something)",
   len({extents(a, b)[1] - extents(a, b)[0] for b in bs}) > 1, True)

# Justified: the pen contract is exact, so assert it exactly.
lay = T.layout_text({**SPEC, "align": "justify"})
body = lay["lines"][:-1]
eq("justify: more than one line to justify", len(body) >= 2, True)
eq("justify: every line but the last starts at the box's left edge",
   [round(r["penStart"] - BOX[0], 6) for r in body], [0.0] * len(body))
eq("justify: every line but the last ends at the box's right edge",
   [round(r["penEnd"] - (BOX[0] + BOX[2]), 6) for r in body], [0.0] * len(body))
eq("justify: the LAST line is not justified",
   lay["lines"][-1]["penEnd"] < BOX[0] + BOX[2] - 1, True)
eq("...and it is flagged as such", [r["justified"] for r in lay["lines"]][-1], False)

# ...and the ink agrees with the pen.
a = alpha(R({**SPEC, "align": "justify"}, 500, 400))
bs = bands(a)
ex = [extents(a, b) for b in bs]
eq("justify: rendered ink is flush left on every line",
   max(e[0] for e in ex) - min(e[0] for e in ex) <= 1, True)
eq("justify: rendered ink is flush right on every line but the last",
   max(e[1] for e in ex[:-1]) - min(e[1] for e in ex[:-1]) <= 1, True)
eq("justify: the last line's ink stops well short of the right edge",
   ex[-1][1] < min(e[1] for e in ex[:-1]) - 8, True)

eq("justify puts the slack in the spaces, NOT in the letter spacing",
   # inside a word the pen steps are unchanged; only the gaps grew
   [round(b - a_, 4) for a_, b in zip(
       [g[1] for g in T.layout_text({**SPEC, "align": "justify"})["lines"][0]["glyphs"]][:3],
       [g[1] for g in T.layout_text({**SPEC, "align": "justify"})["lines"][0]["glyphs"]][1:4])]
   == [round(b - a_, 4) for a_, b in zip(
       [g[1] for g in T.layout_text({**SPEC, "align": "left"})["lines"][0]["glyphs"]][:3],
       [g[1] for g in T.layout_text({**SPEC, "align": "left"})["lines"][0]["glyphs"]][1:4])],
   True)

lay = T.layout_text({"content": "solo", "size": 30, "box": [0, 0, 400, 0], "align": "justify"})
near("a single-word line is not stretched to the box", lay["lines"][0]["penEnd"],
     T.layout_text({"content": "solo", "size": 30})["lines"][0]["advance"], 1e-6)
lay = T.layout_text({"content": "para one is long enough to wrap twice over here\nx",
                     "size": 30, "box": [0, 0, 200, 0], "align": "justify",
                     "justifyLast": "right"})
eq("justifyLast steers the unjustified last line",
   round(lay["lines"][-1]["penEnd"] - 200, 6), 0.0)


print("\n  -- the paragraph box: vertical alignment and overflow --")

VBOX = {"content": "one\ntwo", "font": "arial.ttf", "size": 30,
        "box": [20, 20, 300, 260]}
tops = {}
for va in ("top", "middle", "bottom"):
    a = alpha(R({**VBOX, "valign": va}, 400, 320))
    tops[va] = bands(a)[0][0]
eq("valign top/middle/bottom put the block in three different places",
   tops["top"] < tops["middle"] < tops["bottom"], True)
lay = T.layout_text({**VBOX, "valign": "middle"})
near("middle centres the block in the box",
     (lay["box"][1] + lay["box"][3] / 2.0) - (lay["ink"][1] + lay["ink"][3]) / 2.0, 0.0, 0.51)

TALL = {"content": "\n".join(["line %d" % i for i in range(8)]), "size": 30,
        "box": [20, 20, 300, 100]}
a_of = alpha(R({**TALL, "overflow": "overflow"}, 400, 500))
a_cl = alpha(R({**TALL, "overflow": "clip"}, 400, 500))
sp_sh = T.layout_text({**TALL, "overflow": "shrink"})
eq("overflow (the default) really does draw past the box, visibly",
   bands(a_of)[-1][1] > 20 + 100 + 4, True)
eq("clip cuts at the box edge and nothing survives below it",
   int(np.max(np.nonzero(np.any(a_cl > 0.02, axis=1))[0])) <= 20 + 100, True)
eq("clip keeps what IS inside the box", ink(a_cl) > 0, True)
eq("shrink refits: the block fits the box", sp_sh["blockH"] <= 100 + 1e-6, True)
eq("...at a smaller size than asked for", sp_sh["size"] < 30, True)
eq("...and not below minSize",
   T.layout_text({**TALL, "overflow": "shrink", "minSize": 12})["size"] >= 12, True)
eq("shrink leaves a block that already fits alone",
   T.layout_text({"content": "x", "size": 30, "box": [0, 0, 300, 300],
                  "overflow": "shrink"})["size"], 30)

for anc, want in (("topLeft", (100.0, 100.0)), ("center", (100.0 - 0, 100.0)),
                  ("bottomRight", (100.0, 100.0))):
    lay = T.layout_text({"content": "anchor", "size": 40, "box": [100, 100, 0, 0],
                         "anchor": anc})
    bx, by, bw, bh = lay["box"]
    ax, ay = T._ANCHOR_XY[anc]
    near(f"anchor {anc} puts its own point on (100, 100) - x", bx + ax * bw, 100.0, 1e-6)
    near(f"anchor {anc} puts its own point on (100, 100) - y", by + ay * bh, 100.0, 1e-6)


print("\n  -- fill --")

near("a solid fill is EXACTLY the 0-255 colour it was given (§9: colours are 0-255)",
     float(np.abs(T.paint_field({"type": "solid", "color": [255, 128, 64]}, 8, 8)[..., :3]
                  - np.array([255, 128, 64], np.float32) / 255.0).max()), 0.0, 1e-7)
eq("a 0-1 triple is treated as the near-black colour it is, not as 0-1 floats",
   float(T.paint_field({"type": "solid", "color": [1, 0, 0]}, 4, 4)[0, 0, 0]) < 0.005, True)

# paint_field samples at PIXEL CENTRES, so an endpoint at x=0.5 is the centre of
# pixel 0 and lands on that pixel exactly. 101 wide so the midpoint is a centre.
G = {"type": "linear", "space": "canvas", "start": [0.5, 0.5], "end": [100.5, 0.5],
     "color": [255, 40, 0], "color2": [0, 60, 255]}
pf = T.paint_field(G, 101, 1)
near("gradient: the start endpoint is exactly colour 1",
     float(np.abs(pf[0, 0, :3] * 255.0 - np.array([255, 40, 0])).max()), 0.0, 1e-3)
near("gradient: the end endpoint is exactly colour 2",
     float(np.abs(pf[0, 100, :3] * 255.0 - np.array([0, 60, 255])).max()), 0.0, 1e-3)
near("gradient: the midpoint is the midpoint",
     float(np.abs(pf[0, 50, :3] * 255.0
                  - (np.array([255, 40, 0]) + np.array([0, 60, 255])) / 2.0).max()), 0.0, 1e-3)
d = np.diff(pf[0, :, 2])
eq("gradient: the ramp is monotone and evenly stepped",
   bool(np.all(d > 0)) and float(d.max() - d.min()) < 1e-5, True)

pf = T.paint_field({"type": "linear", "space": "canvas", "start": [0.5, 0.5],
                    "end": [100.5, 0.5],
                    "stops": [[0.0, 255, 0, 0, 255], [0.5, 0, 255, 0, 255],
                              [1.0, 0, 0, 255, 255]]}, 101, 1)
near("gradient stops: the middle stop lands on its own position",
     float(np.abs(pf[0, 50, :3] * 255.0 - np.array([0, 255, 0])).max()), 0.0, 1e-3)

pf = T.paint_field({"type": "radial", "space": "canvas", "start": [50.5, 0.5],
                    "end": [100.5, 0.5], "color": [255, 0, 0], "color2": [0, 0, 255]}, 101, 1)
near("radial: the centre is colour 1", float(pf[0, 50, 0] * 255.0), 255.0, 1e-3)
near("radial: the rim is colour 2", float(pf[0, 100, 2] * 255.0), 255.0, 1e-3)
near("radial: it is symmetric about the centre",
     float(np.abs(pf[0, 30, :3] - pf[0, 70, :3]).max()), 0.0, 1e-6)

near("fill opacity scales the alpha, not the colour",
     float(T.paint_field({"type": "solid", "color": [255, 0, 0], "opacity": 40}, 4, 4)[0, 0, 3]),
     0.4, 1e-6)
eq("...and leaves the colour straight",
   float(T.paint_field({"type": "solid", "color": [255, 0, 0], "opacity": 40},
                       4, 4)[0, 0, 0]), 1.0)

img = R({"content": "TEXTURE", "size": 90, "box": [10, 10, 0, 0],
         "fill": {"type": "image", "image": TEX_A, "fit": "stretch"}}, 500, 200)
lit = img[..., 3] > 0.9
eq("an image fill paints the glyphs with the texture, left to right",
   float(img[..., 0][lit].std()) > 0.15, True)
eq("a missing texture path falls back to the solid colour rather than vanishing",
   ink(R({"content": "T", "size": 90, "fill": {"type": "image",
                                               "image": "Z:/nope/not-here.png"}}, 300, 200)) > 0,
   True)
eq("a texture path that is not an image is refused",
   T._load_texture(os.path.join(HERE, "imgtext.py")), None)


print("\n  -- decoration --")

SH = {"content": "Hg", "font": "arial.ttf", "size": 90, "box": [40, 40, 0, 0]}
plain = R(SH, 400, 300)
for dx, dy in ((24, 14), (-18, 22), (0, 30), (31, -9)):
    got = R({**SH, "shadow": {"enabled": True, "offsetX": dx, "offsetY": dy, "blur": 0,
                              "spread": 0, "opacity": 100, "color": [255, 0, 0]}}, 400, 300)
    fa = alpha(plain)
    sa = shift_ref(fa, dx, dy)
    near(f"shadow at ({dx}, {dy}), blur 0: a hard copy at that offset and nowhere else",
         float(np.abs(alpha(got) - (fa + sa - fa * sa)).max()), 0.0, 2e-3)

got = R({**SH, "shadow": {"enabled": True, "offsetX": 24, "offsetY": 14, "blur": 0,
                          "spread": 0, "opacity": 100, "color": [255, 0, 0]}}, 400, 300)
only = (alpha(got) > 0.9) & (alpha(plain) <= 0.0)
eq("...and the shadow-only pixels carry the shadow COLOUR",
   float(np.abs(got[..., :3][only] - np.array([1.0, 0.0, 0.0], np.float32)).max()) < 2e-3, True)

hard = R({**SH, "shadow": {"enabled": True, "offsetX": 20, "offsetY": 20, "blur": 0,
                           "opacity": 100}}, 400, 300)
soft = R({**SH, "shadow": {"enabled": True, "offsetX": 20, "offsetY": 20, "blur": 12,
                           "opacity": 100}}, 400, 300)
eq("a blurred shadow reaches further than a hard one",
   extents(alpha(soft))[1] > extents(alpha(hard))[1], True)
eq("...and softens rather than adding ink at full strength",
   float((alpha(soft) > 0.98).sum()) < float((alpha(hard) > 0.98).sum()), True)
eq("spread grows a hard shadow before it blurs",
   ink(R({**SH, "shadow": {"enabled": True, "offsetX": 0, "offsetY": 0, "blur": 0,
                           "spread": 6, "opacity": 100}}, 400, 300))
   > ink(R({**SH, "shadow": {"enabled": True, "offsetX": 0, "offsetY": 0, "blur": 0,
                             "spread": 0, "opacity": 100}}, 400, 300)) * 1.5, True)
eq("a shadow that is not enabled is not drawn",
   float(np.abs(R({**SH, "shadow": {"enabled": False, "offsetX": 40}}, 400, 300)
                - plain).max()), 0.0)

O = {"content": "O", "font": "arial.ttf", "size": 140, "box": [60, 20, 0, 0]}
areas = {}
for jn in ("round", "bevel", "miter"):
    areas[jn] = ink(alpha(R({**O, "outline": {"width": 14, "join": jn, "opacity": 100,
                                              "color": [255, 0, 0]}}, 400, 300)))
eq("the three joins are three different offsets: miter > bevel > round",
   areas["miter"] > areas["bevel"] > areas["round"], True)
eq("...and a Chebyshev ball is close to (2w)^2/(pi w^2) bigger than a Euclidean one",
   1.05 < (areas["miter"] - ink(alpha(R(O, 400, 300))))
   / max(areas["round"] - ink(alpha(R(O, 400, 300))), 1e-6) < 1.45, True)

widths = [ink(alpha(R({**O, "outline": {"width": w, "opacity": 100}}, 400, 300)))
          for w in (0, 4, 10, 20)]
eq("outline width grows the ink monotonically",
   all(b > a for a, b in zip(widths, widths[1:])), True)
e_out = extents(alpha(R({**O, "outline": {"width": 12, "position": "outside",
                                          "opacity": 100}}, 400, 300)))
e_in = extents(alpha(R({**O, "outline": {"width": 12, "position": "inside",
                                         "opacity": 100}}, 400, 300)))
e_none = extents(alpha(R(O, 400, 300)))
eq("an outside stroke grows the silhouette", e_out[1] - e_out[0] > e_none[1] - e_none[0], True)
eq("an inside stroke does not", e_in[1] - e_in[0] == e_none[1] - e_none[0], True)
got = R({**O, "outline": {"width": 12, "position": "inside", "opacity": 100,
                          "color": [255, 0, 0]}}, 400, 300)
eq("...it paints over the glyph edge instead",
   float(got[..., 0][alpha(got) > 0.99].min()) > 0.99
   and float(got[..., 2][alpha(got) > 0.99].min()) < 0.01, True)

g_off = R(O, 400, 300)
g_on = R({**O, "glow": {"enabled": True, "radius": 18, "opacity": 100,
                        "color": [0, 255, 0]}}, 400, 300)
eq("a glow reaches outside the glyph", extents(alpha(g_on))[0] < extents(alpha(g_off))[0], True)
eq("...in its own colour",
   float(g_on[..., 1][(alpha(g_on) > 0.05) & (alpha(g_off) < 0.001)].mean()) > 0.9, True)
eq("a glow that is not enabled is not drawn",
   float(np.abs(R({**O, "glow": {"enabled": False, "radius": 40}}, 400, 300)
                - g_off).max()), 0.0)


print("\n  -- STRAIGHT ALPHA: the case that fails under premultiplied maths --")

lay = R({"content": "Hamburgefonstiv", "font": "arial.ttf", "size": 72,
         "box": [10, 40, 0, 0], "fill": {"color": [255, 255, 255]}}, 700, 160)
a = alpha(lay)
rgb = lay[..., :3]
edge = (a > 0.2) & (a < 0.8)
eq("there ARE antialiased glyph edges to argue about", int(edge.sum()) > 400, True)

# 1. The stored colour is the colour. If this file returned premultiplied data
#    dressed as straight, rgb here would equal alpha.
near("white text stores white at half-covered edges, not half-white",
     float(rgb[edge].min()), 1.0, 2e-3)

# 2. Composite over black by the straight rule. Straight gives `a`;
#    premultiplied-mistaken-for-straight would give `a*a`, which at a=0.5 is a
#    quarter instead of a half - the dark fringe, in one number.
over_black = rgb * a[..., None]
near("...so over black the edge is exactly its coverage (grey, not fringed)",
     float(np.abs(over_black[edge][..., 0] - a[edge]).max()), 0.0, 2e-3)
mid = (a > 0.45) & (a < 0.55)
eq("...and there are genuine half-covered pixels in that set", int(mid.sum()) > 20, True)
premul_would_be = float((a[mid] ** 2).mean())
observed = float(over_black[mid][..., 0].mean())
eq("the premultiplied answer is measurably darker, and is NOT what we got",
   observed - premul_would_be > 0.2, True)
NOTES.append(f"half-covered glyph edge over black: straight={observed:.3f}, "
             f"premultiplied-bug would be {premul_would_be:.3f}")

# 3. Through draw_text, onto a coloured buffer, where the bug shows in a
#    channel that should have been untouched.
red = np.zeros((160, 700, 4), np.float32)
red[..., 0] = 1.0
red[..., 3] = 1.0
out = T.draw_text(red, {"content": "Hamburgefonstiv", "font": "arial.ttf", "size": 72,
                        "box": [10, 40, 0, 0], "fill": {"color": [255, 255, 255]}})
near("white over red: the green channel is exactly the coverage",
     float(np.abs(out[..., 1][edge] - a[edge]).max()), 0.0, 3e-3)
near("...the red channel stays at 1 everywhere", float(out[..., 0].min()), 1.0, 1e-4)
near("...and the buffer stays opaque", float(out[..., 3].min()), 1.0, 1e-6)
eq("black text over white does not brighten its own edges",
   float(T.draw_text(np.ones((160, 700, 4), np.float32),
                     {"content": "Hamburgefonstiv", "size": 72, "box": [10, 40, 0, 0],
                      "fill": {"color": [0, 0, 0]}})[..., 0][edge].max())
   <= float((1.0 - a[edge]).max()) + 3e-3, True)

# 4. Rotation is the one place this module premultiplies. Prove it comes back.
rot = R({"content": "Hamburg", "font": "arial.ttf", "size": 72, "box": [200, 150, 0, 0],
         "anchor": "center", "rotate": 23.0,
         "fill": {"color": [255, 255, 255]}}, 400, 300)
ra = alpha(rot)
redge = (ra > 0.2) & (ra < 0.8)
eq("a rotated block still has antialiased edges", int(redge.sum()) > 200, True)
near("...and they are still straight alpha after the warp",
     float(rot[..., :3][redge].min()), 1.0, 6e-3)
eq("nothing anywhere in the layer is premultiplied-dark",
   float(rot[..., :3][ra > 0.02].min()) > 0.97, True)


print("\n  -- rotation and skew --")

ROT = {"content": "L", "font": "arial.ttf", "size": 120, "box": [150.0, 150.0, 0, 0],
       "anchor": "topLeft"}


def centroid(a):
    ys, xs = np.nonzero(a > 0.02)
    ws = a[ys, xs]
    return (float((xs * ws).sum() / ws.sum()), float((ys * ws).sum() / ws.sum()))


up = R(ROT, 300, 300)
rot90 = R({**ROT, "rotate": 90.0}, 300, 300)
e0, e9 = extents(alpha(up)), extents(alpha(rot90))
b0, b9 = bands(alpha(up))[0], bands(alpha(rot90))[0]
near("rotate 90 turns the block's width into its height",
     (b9[1] - b9[0]) - (e0[1] - e0[0]), 0.0, 2.0)
near("rotate 90 turns the block's height into its width",
     (e9[1] - e9[0]) - (b0[1] - b0[0]), 0.0, 2.0)

# The exact claim: rotate is CLOCKWISE about the anchor, so (dx, dy) -> (-dy, dx).
cx0, cy0 = centroid(alpha(up))
cx9, cy9 = centroid(alpha(rot90))
eq("the unrotated block sits down and to the right of its topLeft anchor",
   cx0 > 152 and cy0 > 152, True)
near("rotate 90 clockwise maps the ink's dy to -dx", cx9 - 150.0, -(cy0 - 150.0), 2.0)
near("rotate 90 clockwise maps the ink's dx to +dy", cy9 - 150.0, cx0 - 150.0, 2.0)
for deg in (30.0, 57.0, 120.0):
    cx, cy = centroid(alpha(R({**ROT, "rotate": deg}, 500, 500)))
    c, sn = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    dx, dy = cx0 - 150.0, cy0 - 150.0
    near(f"rotate {deg} lands the ink centroid where the matrix says - x",
         cx - 150.0, c * dx - sn * dy, 2.5)
    near(f"rotate {deg} lands the ink centroid where the matrix says - y",
         cy - 150.0, sn * dx + c * dy, 2.5)
near("rotate 360 is the identity to within resampling",
     float(np.abs(alpha(R({**ROT, "rotate": 360.0}, 300, 300)) - alpha(up)).max()),
     0.0, 0.06)
eq("rotate 0 does not resample at all",
   float(np.abs(R({**ROT, "rotate": 0.0}, 300, 300) - up).max()), 0.0)

sk = R({"content": "H", "font": "arial.ttf", "size": 120, "box": [150, 240, 0, 0],
        "anchor": "bottomLeft", "skewX": 30.0}, 400, 300)
no = R({"content": "H", "font": "arial.ttf", "size": 120, "box": [150, 240, 0, 0],
        "anchor": "bottomLeft"}, 400, 300)
esk, eno = extents(alpha(sk)), extents(alpha(no))
bsk = bands(alpha(sk))[0]
near("skewX 30 leans the block by height*tan(30) at the top",
     (esk[1] - esk[0]) - (eno[1] - eno[0]),
     (bsk[1] - bsk[0]) * math.tan(math.radians(30.0)), 4.0)
eq("skewY shears the other way",
   bands(alpha(R({"content": "HHHH", "size": 90, "box": [40, 150, 0, 0],
                  "skewY": 25.0}, 400, 300)))[0][1]
   - bands(alpha(R({"content": "HHHH", "size": 90, "box": [40, 150, 0, 0],
                    "skewY": 25.0}, 400, 300)))[0][0]
   > bands(alpha(R({"content": "HHHH", "size": 90, "box": [40, 150, 0, 0]},
                   400, 300)))[0][1]
   - bands(alpha(R({"content": "HHHH", "size": 90, "box": [40, 150, 0, 0]},
                   400, 300)))[0][0] + 20, True)


print("\n  -- text on a path: per-glyph rotation, measured --")

# A single tall glyph on a straight path at a known angle. Its major axis has
# to turn with the path or the "per-glyph rotation" claim is a lie.
def bar_on_line(deg, size=110):
    r = 150.0
    th = math.radians(deg)
    p0 = [200.0 - r * math.cos(th), 200.0 - r * math.sin(th)]
    p1 = [200.0 + r * math.cos(th), 200.0 + r * math.sin(th)]
    return alpha(R({"content": "I", "font": "arial.ttf", "size": size,
                    "path": {"kind": "line", "points": [p0, p1], "align": "center"}},
                   400, 400))


o0 = orientation(bar_on_line(0.0))
for deg in (15.0, 30.0, 45.0, 60.0):
    o = orientation(bar_on_line(deg))
    d = (o - o0 + 90.0) % 180.0 - 90.0
    near(f"a glyph on a line at {deg} deg is rotated by {deg} deg", d, deg, 3.5)

flat = bar_on_line(0.0)
vert = bar_on_line(90.0)
ef, ev = extents(flat), extents(vert)
bf, bv = bands(flat)[0], bands(vert)[0]
eq("a vertical path lays the same glyph on its side",
   (ef[1] - ef[0]) < (bf[1] - bf[0]) and (ev[1] - ev[0]) > (bv[1] - bv[0]), True)

arc = alpha(R({"content": "CIRCULAR", "font": "arial.ttf", "size": 40,
               "path": {"kind": "arc", "center": [200, 200], "radius": 140,
                        "startAngle": 180, "endAngle": 360, "align": "center"}}, 400, 400))
eq("an arc renders ink", ink(arc) > 0, True)
ys, xs = np.nonzero(arc > 0.3)
eq("...on the top half of the circle, not in a straight line",
   float(ys.max()) < 200 and float(np.hypot(xs - 200, ys - 200).std()) < 30, True)
near("...at the arc's radius",
     float(np.hypot(xs - 200.0, ys - 200.0).mean()), 140.0, 26.0)

side = alpha(R({"content": "CIRCULAR", "font": "arial.ttf", "size": 40,
                "path": {"kind": "arc", "center": [200, 200], "radius": 140,
                         "startAngle": 180, "endAngle": 360, "align": "center",
                         "side": 40}}, 400, 400))
ys2, xs2 = np.nonzero(side > 0.3)
eq("path side pushes the baseline off the curve, to the right of travel",
   float(np.hypot(xs2 - 200.0, ys2 - 200.0).mean())
   < float(np.hypot(xs - 200.0, ys - 200.0).mean()) - 30, True)

flipped = alpha(R({"content": "CIRCULAR", "font": "arial.ttf", "size": 40,
                   "path": {"kind": "arc", "center": [200, 200], "radius": 140,
                            "startAngle": 180, "endAngle": 360, "align": "center",
                            "flip": True}}, 400, 400))
eq("flip walks the path the other way", float(np.abs(flipped - arc).max()) > 0.4, True)

poly = alpha(R({"content": "ZIGZAG TEXT ALONG", "font": "arial.ttf", "size": 30,
                "path": {"kind": "polyline",
                         "points": [[30, 300], [150, 120], [270, 300], [380, 150]],
                         "align": "start"}}, 400, 400))
eq("a polyline path renders along all of its segments", ink(poly) > 0, True)
eq("...spanning more than one leg",
   len(bands(poly)) >= 1 and extents(poly)[1] - extents(poly)[0] > 200, True)

c_start = alpha(R({"content": "ABC", "size": 40,
                   "path": {"kind": "line", "points": [[20, 200], [380, 200]],
                            "align": "start"}}, 400, 400))
c_end = alpha(R({"content": "ABC", "size": 40,
                 "path": {"kind": "line", "points": [[20, 200], [380, 200]],
                          "align": "end"}}, 400, 400))
c_mid = alpha(R({"content": "ABC", "size": 40,
                 "path": {"kind": "line", "points": [[20, 200], [380, 200]],
                          "align": "center"}}, 400, 400))
eq("path align start/center/end walk the run along the path",
   extents(c_start)[0] < extents(c_mid)[0] < extents(c_end)[0], True)
near("...and center really is centred on the path",
     (extents(c_mid)[0] + extents(c_mid)[1]) / 2.0, 200.0, 4.0)
eq("path offset shifts the run further along",
   extents(alpha(R({"content": "ABC", "size": 40,
                    "path": {"kind": "line", "points": [[20, 200], [380, 200]],
                             "align": "start", "offset": 90}}, 400, 400)))[0]
   - extents(c_start)[0] > 80, True)
eq("a path with too few points falls back to straight text rather than vanishing",
   ink(R({"content": "ABC", "size": 40,
          "path": {"kind": "polyline", "points": [[10, 10]]}}, 400, 400)) > 0, True)
eq("a run longer than its path extrapolates instead of piling up",
   extents(alpha(R({"content": "A" * 30, "size": 40,
                    "path": {"kind": "line", "points": [[100, 200], [180, 200]],
                             "align": "start"}}, 400, 400)))[1] > 300, True)


print("\n  -- the selection mask (§3), taken but not reimplemented --")

full = R({"content": "MASKED", "size": 70, "box": [10, 60, 0, 0]}, 400, 200)
m = np.zeros((200, 400), np.float32)
m[:, :200] = 1.0
half = R({"content": "MASKED", "size": 70, "box": [10, 60, 0, 0]}, 400, 200, mask=m)
eq("a mask of ones is the unmasked render",
   float(np.abs(R({"content": "MASKED", "size": 70, "box": [10, 60, 0, 0]}, 400, 200,
                  mask=np.ones((200, 400), np.float32)) - full).max()), 0.0)
eq("a mask of zeros leaves nothing", ink(R({"content": "MASKED", "size": 70},
                                           400, 200, mask=np.zeros((200, 400), np.float32))), 0.0)
eq("a half mask keeps the left half exactly",
   float(np.abs(alpha(half)[:, :200] - alpha(full)[:, :200]).max()), 0.0)
eq("...and drops the right half entirely", float(alpha(half)[:, 200:].max()), 0.0)
eq("the mask multiplies alpha, it does not dim the colour",
   float(np.abs(half[..., :3][alpha(half) > 0.5]
                - full[..., :3][alpha(half) > 0.5]).max()) < 1e-6, True)

base = np.zeros((200, 400, 4), np.float32)
base[..., 2] = 1.0
base[..., 3] = 1.0
out = T.draw_text(base, {"content": "MASKED", "size": 70, "box": [10, 60, 0, 0]}, mask=m)
eq("draw_text blends result*m + original*(1-m), the §3 rule verbatim",
   float(np.abs(out[:, 200:] - base[:, 200:]).max()), 0.0)
eq("...and composites for real on the masked side",
   float(np.abs(out[:, :200] - base[:, :200]).max()) > 0.5, True)
for fn, args in (("render_text", (400, 200)), ("draw_text", ())):
    try:
        if fn == "render_text":
            T.render_text({"content": "x"}, 400, 200, mask=np.ones((7, 7), np.float32))
        else:
            T.draw_text(np.zeros((8, 8, 4), np.float32), {"content": "x"},
                        mask=np.ones((7, 7), np.float32))
        ok = "accepted a mask of the wrong shape"
    except ValueError:
        ok = True
    eq(f"{fn} REFUSES a mask that does not fit rather than ignoring it", ok, True)

eq("imgtext does not import imgselect",
   re.search(r"^\s*(import|from)\s+imgselect",
             open(os.path.join(HERE, "imgtext.py"), encoding="utf-8").read(),
             re.M), None)
eq("...and does not build its own selection shapes",
   not re.search(r'"(wand|colorRange|lasso)"',
                 open(os.path.join(HERE, "imgtext.py"), encoding="utf-8").read()), True)


print("\n  -- render_debug: the layout and the raw coverage, for the UI --")

dbg = T.render_debug({"content": "Coverage", "font": "arial.ttf", "size": 70,
                      "box": [20, 20, 0, 0], "fill": {"color": [255, 255, 255]}}, 400, 200)
eq("render_debug hands back the layout, the coverage and the picture",
   sorted(dbg), ["coverage", "layout", "origin", "rgba", "spec", "warnings"])
ox_, oy_ = dbg["origin"]
ch_, cw_ = dbg["coverage"].shape
sub = alpha(dbg["rgba"])[oy_:oy_ + ch_, ox_:ox_ + cw_]
near("the raw coverage IS the rendered alpha of an opaque fill, pixel for pixel",
     float(np.abs(dbg["coverage"] - sub).max()), 0.0, 1e-6)
eq("...and the layout it reports is the layout that was drawn",
   len(dbg["layout"]["lines"]), 1)
eq("render_debug on an empty string is still well-formed",
   T.render_debug({"content": ""}, 40, 20)["rgba"].shape, (20, 40, 4))


print("\n  -- hostile input --")

for what, spec in (("an empty string", {"content": ""}),
                   ("whitespace only", {"content": "   "}),
                   ("newlines only", {"content": "\n\n\n"}),
                   ("None content", {"content": None}),
                   ("no content key at all", {})):
    got = R(spec, 200, 100)
    eq(f"{what} gives a valid, empty layer",
       got.shape == (100, 200, 4) and got.dtype == np.float32 and ink(got) == 0.0, True)

for what, spec in (("size 0", {"content": "x", "size": 0}),
                   ("size -50", {"content": "x", "size": -50}),
                   ("size NaN", {"content": "x", "size": float("nan")}),
                   ("size inf", {"content": "x", "size": float("inf")}),
                   ("size 'big'", {"content": "x", "size": "big"}),
                   ("tracking -1e9", {"content": "abc", "tracking": -1e9}),
                   ("tracking NaN", {"content": "abc", "tracking": float("nan")}),
                   ("lineHeight 0", {"content": "a\nb", "lineHeight": 0}),
                   ("lineHeight NaN", {"content": "a\nb", "lineHeight": float("nan")}),
                   ("a NaN box", {"content": "abc", "box": [float("nan")] * 4}),
                   ("a box of the wrong length", {"content": "abc", "box": [1, 2]}),
                   ("a box 1px wide", {"content": "abcdef", "size": 40, "box": [0, 0, 1, 0]}),
                   ("a box 1px tall, clipped", {"content": "abcdef", "size": 40,
                                                "box": [0, 0, 90, 1], "overflow": "clip"}),
                   ("a box 1px tall, shrunk", {"content": "abcdef", "size": 40,
                                               "box": [0, 0, 90, 1], "overflow": "shrink"}),
                   ("a missing font", {"content": "x", "font": "no-such-font.ttf"}),
                   ("a garbage font type", {"content": "x", "font": 12345}),
                   ("garbage stops", {"content": "x", "fill": {"type": "linear",
                                                               "stops": "nope"}}),
                   ("a colour of the wrong shape", {"content": "x",
                                                    "fill": {"color": ["a", None]}}),
                   ("a NaN rotation", {"content": "x", "rotate": float("nan")}),
                   ("an enum that is not one", {"content": "x", "align": "sideways"}),
                   ("a sub-spec that is a string", {"content": "x", "shadow": "yes"}),
                   ("negative outline width", {"content": "x", "outline": {"width": -9}}),
                   ("a NaN path radius", {"content": "x", "path": {"kind": "arc",
                                                                   "radius": float("nan")}}),
                   ("a path with no points", {"content": "x", "path": {"kind": "polyline"}}),
                   ("a 20k-character run", {"content": "lorem ipsum " * 1700, "size": 14,
                                            "box": [0, 0, 190, 0]})):
    t0 = time.perf_counter()
    try:
        got = R(spec, 200, 100)
        ok = (got.shape == (100, 200, 4) and got.dtype == np.float32
              and np.isfinite(got).all() and 0.0 <= got.min() and got.max() <= 1.0)
    except Exception as exc:                                    # noqa: BLE001
        ok = f"raised {type(exc).__name__}: {exc}"
    dt = time.perf_counter() - t0
    eq(f"{what} renders a sane layer", ok, True)
    if dt > 5.0:
        eq(f"{what} finishes in reasonable time ({dt:.1f}s)", False, True)

eq("NaN falls back to the catalog default, it does not propagate",
   T.coerce_spec({"content": "x", "size": float("nan")})["size"], 64)
eq("out-of-range clamps to the advertised range",
   T.coerce_spec({"content": "x", "tracking": -1e9})["tracking"], -500.0)
eq("an unknown key is dropped, not carried",
   "sneaky" in T.coerce_spec({"content": "x", "sneaky": 1}), False)
try:
    T.draw_text(np.zeros((4, 4, 3), np.float32), {"content": "x"})
    ok = "accepted a 3-channel buffer"
except ValueError:
    ok = True
eq("draw_text refuses anything that is not (H, W, 4)", ok, True)


print("\n  -- smart punctuation --")

lay = T.layout_text({"content": "don't \"quote\" me -- ok... yes", "size": 40,
                     "smartPunctuation": True})
c = lay["content"]
eq("apostrophes and quotes curl", ("\u2019" in c) and ("\u201c" in c) and ("\u201d" in c), True)
eq("-- becomes an en dash, ... an ellipsis", ("\u2013" in c) and ("\u2026" in c), True)
eq("--- becomes an em dash",
   "\u2014" in T.layout_text({"content": "a --- b", "size": 40,
                              "smartPunctuation": True})["content"], True)
eq("off by default",
   T.layout_text({"content": "don't", "size": 40})["content"], "don't")
eq("a quote after an opening bracket opens",
   T.layout_text({"content": '("hi")', "size": 40,
                  "smartPunctuation": True})["content"][1], "\u201c")
eq("nothing is substituted into a face that has no such glyph",
   T.smarten("don't", T.load_face("no-such-font.ttf", 30)), "don't")


print("\n  -- the legacy text op, so the integrator has a seam to wire --")

# The old stage USED to live in imagetools.py and this read its keys from
# there. It has been replaced by a call into this module, so that anchor is
# gone — but the legacy shape has not: it is what a client still sends, and
# mcp.js declares all nine keys in image_adjust's `text` property. Scraping the
# published SCHEMA is the better anchor anyway, because it pins this adapter
# against what callers are actually promised rather than against how the
# server happened to implement it.
_mcp = open(os.path.join(HERE, "mcp.js"), encoding="utf-8").read()
_decl = _mcp[_mcp.index('text: { type: "object", description: "The type tool'):]
_decl = _decl[:_decl.index("resize:")]
legacy_keys = set(re.findall(r"\b([a-zA-Z]+): \{ type:", _decl)) - {"text"}
eq("read the old op's keys out of the published schema, not out of memory",
   len(legacy_keys) >= 7, True)
eq("...and it is the nine the schema actually declares", len(legacy_keys), 9)
handled = set(T.LEGACY_KEYS)
eq("from_legacy handles every key the old text stage reads",
   sorted(legacy_keys - handled), [])
old = {"content": "Legacy", "font": "arial.ttf", "size": 48, "color": [255, 0, 0],
       "x": 200, "y": 150, "align": "center", "stroke": 3, "strokeColor": [0, 0, 255]}
new = T.from_legacy(old)
eq("...and maps them onto the new spec", (new["content"], new["size"], new["box"][:2],
                                          new["anchor"], new["fill"]["color"],
                                          new["outline"]["width"], new["outline"]["color"]),
   ("Legacy", 48, [200.0, 150.0], "center", [255, 0, 0], 3.0, [0, 0, 255]))
a = alpha(R(new, 400, 300))
e, b = extents(a), bands(a)
near("a legacy centre-aligned caption still centres on its x", (e[0] + e[1]) / 2.0, 200.0, 2.0)
near("...and still sits mid-height on its y", (b[0][0] + b[-1][1]) / 2.0, 150.0, 6.0)
eq("a legacy left caption anchors on its left edge",
   abs(extents(alpha(R(T.from_legacy({**old, "align": "left"}), 400, 300)))[0] - 200) <= 4,
   True)


print("\n  -- performance --")

PARA = "\n".join(
    "Line %02d of a paragraph that is long enough to be worth measuring here." % i
    for i in range(40))
PERF = {"content": PARA, "font": "arial.ttf", "size": 32, "box": [64, 64, 1900, 0]}
for label, spec in (("plain", PERF),
                    ("gradient + outline + shadow",
                     {**PERF, "fill": {"type": "linear", "color": [255, 200, 0],
                                       "color2": [255, 0, 90]},
                      "outline": {"width": 3, "opacity": 100},
                      "shadow": {"enabled": True, "blur": 8, "opacity": 80}}),
                    ("rotated 12 deg", {**PERF, "rotate": 12.0}),
                    ("on an arc", {"content": "TEXT ON A PATH " * 3, "size": 32,
                                   "path": {"kind": "arc", "center": [1024, 1024],
                                            "radius": 800, "startAngle": 180,
                                            "endAngle": 360}})):
    R(spec, 2048, 2048)                                  # warm the glyph cache
    runs = []
    for _ in range(3):
        t0 = time.perf_counter()
        out = R(spec, 2048, 2048)
        runs.append((time.perf_counter() - t0) * 1000.0)
    eq(f"2048x2048, 40 lines @32px, {label}: {min(runs):6.1f} ms", ink(out) > 0, True)
    NOTES.append(f"2048x2048 40 lines @32px, {label}: {min(runs):.1f} ms "
                 f"(median {sorted(runs)[1]:.1f})")

t0 = time.perf_counter()
T.layout_text(PERF)
NOTES.append(f"layout alone (40 lines, wrapped to 1900px): "
             f"{(time.perf_counter() - t0) * 1000.0:.1f} ms")


print("\n  -- the output contract, on everything --")

bad = []
for label, spec in (("plain", {"content": "Ag", "size": 60, "box": [10, 10, 0, 0]}),
                    ("gradient", {"content": "Ag", "size": 60,
                                  "fill": {"type": "linear"}}),
                    ("radial", {"content": "Ag", "size": 60, "fill": {"type": "radial"}}),
                    ("texture", {"content": "Ag", "size": 60,
                                 "fill": {"type": "image", "image": TEX_A}}),
                    ("outline", {"content": "Ag", "size": 60,
                                 "outline": {"width": 6, "opacity": 100}}),
                    ("shadow", {"content": "Ag", "size": 60,
                                "shadow": {"enabled": True}}),
                    ("glow", {"content": "Ag", "size": 60, "glow": {"enabled": True}}),
                    ("rotated", {"content": "Ag", "size": 60, "rotate": 33.0}),
                    ("skewed", {"content": "Ag", "size": 60, "skewX": 20.0}),
                    ("justified", {"content": PROSE, "size": 24, "box": [5, 5, 300, 0],
                                   "align": "justify"}),
                    ("clipped", {"content": PROSE, "size": 24, "box": [5, 5, 300, 40],
                                 "overflow": "clip"}),
                    ("on a path", {"content": "Ag path", "size": 40,
                                   "path": {"kind": "arc", "center": [200, 150],
                                            "radius": 100}}),
                    ("everything at once", {"content": "Ag", "size": 60,
                                            "fill": {"type": "linear"}, "rotate": 12.0,
                                            "outline": {"width": 4, "opacity": 100},
                                            "shadow": {"enabled": True},
                                            "glow": {"enabled": True}})):
    got = R(spec, 400, 300)
    if got.dtype != np.float32 or got.shape != (300, 400, 4):
        bad.append(f"{label}: shape/dtype")
    elif not np.isfinite(got).all():
        bad.append(f"{label}: non-finite")
    elif got.min() < 0.0 or got.max() > 1.0:
        bad.append(f"{label}: outside 0..1")
    elif float(got[..., :3][got[..., 3] > 0.02].min()) < -1e-6:
        bad.append(f"{label}: negative colour")
eq("every path through the module returns float32 (H, W, 4) 0..1", bad, [])
eq("render_text never mutates the spec it was handed",
   (lambda s: (R(s, 100, 100), s == {"content": "x", "size": 40})[1])(
       {"content": "x", "size": 40}), True)


if NOTES:
    print("\n  -- measured --")
    for n in NOTES:
        print(f"     {n}")

print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
