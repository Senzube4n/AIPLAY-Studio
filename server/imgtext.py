"""The type tool - IMAGE_SPEC §8, the `text` column.

What shipped before this file was a caption tool: one line, one font, one
colour, an outline and a nine-way anchor. Text is the single most common thing
a person puts on an image and the old tool could not set a paragraph, could not
track a headline, and could not make white text survive a white sky. This is
the replacement.

Everything here is a pure function over float32 (H, W, 4), 0..1, STRAIGHT
alpha - the same currency `vfx/effects.py` and the rest of the image pipeline
trade in. Straight alpha is not a stylistic choice here. An antialiased glyph
edge is semi-transparent by definition, so every letter in every render has a
one-pixel ring of partial coverage around it; premultiplied data mistaken for
straight squares the alpha on that ring and paints a dark halo around all of
it.

Two things get collapsed into one sentence every time this goes wrong, so
here they are separately. Premultiplied is the WRONG OUTPUT: what leaves this
module - `render_text`, `draw_text`, `paint_field` - is always straight, and
`imgtext_test.py` constructs the case that fails under premultiplied output
(white glyph edges over black coming out at a*a instead of a) and asserts it
does not happen. Premultiplied is the RIGHT INTERMEDIATE: `over` is linear
only in premultiplied space, and so is bilinear interpolation across a
coverage edge, so the internal composite stack and the rotate/skew warp both
work premultiplied. `_place` unpremultiplies exactly once, at the boundary -
and a block that never needed a composite never enters that space at all.

The shape of a job (every key optional but `content`):

    {"content": "Hello\\nworld", "font": "arial.ttf", "size": 64,
     "box": [x, y, w, h], "anchor": "topLeft",
     "align": "justify", "valign": "middle", "lineHeight": 1.2,
     "tracking": 2.0, "overflow": "shrink",
     "fill":    {"type": "linear", "color": [255,80,0], "color2": [255,220,0]},
     "outline": {"width": 3, "join": "round"},
     "shadow":  {"enabled": true, "offsetX": 6, "offsetY": 6, "blur": 8},
     "glow":    {"enabled": false},
     "path":    {"kind": "arc", "center": [500,500], "radius": 300}}

`CATALOG` describes all of it - type, default, range, and a sentence of why -
because that catalog generates the UI panel and the MCP schema both. Nothing
in this module reads a parameter the catalog does not declare, and the test
suite asserts the converse: every declared parameter provably changes a render.
A schema that accepts a knob the code ignores is worse than a refusal (§9).

DECISIONS WORTH ARGUING WITH, all of them stated rather than discovered later:

  * Line height 1.0 means `ascent + descent` of the face, not the em size and
    not FreeType's `height` (which folds in the font's own line gap and would
    make "single spacing" mean something different per font).
  * Word wrap is greedy, not Knuth-Plass. A word longer than the box is broken
    at the last character that fits; if not even one character fits, one
    character is placed anyway and that line overflows. Progress is guaranteed,
    so no input can hang the layout.
  * Justification puts the slack in the SPACES, never in the letter spacing,
    and the last line of a paragraph is not justified - it takes `justifyLast`.
    A line with no spaces is not stretched. A line already wider than the box
    (a broken long word) is not compressed; slack clamps at zero rather than
    letting glyphs collide.
  * Overflow of the paragraph box is `overflow` by default: the text is drawn
    past the bottom edge, visibly, because silently losing a customer's last
    sentence is the worse failure. `clip` cuts at the box, `shrink` finds the
    largest quarter-point size that fits.
  * Fonts resolve by BASENAME ONLY, out of `C:\\Windows\\Fonts` and the per-user
    font folder - the rule `imagetools.py` already enforces and the reason it
    exists: ops arrive at this process unvalidated, and the raw string used to
    be handed to FreeType, which will open and parse any path on disk. This
    module goes one step further than `os.path.basename` and REFUSES a name
    carrying a separator, `..`, a drive colon or a NUL rather than quietly
    trimming it, so the attempt is visible in `warnings` instead of silently
    becoming a different font.

WHAT THIS MODULE CANNOT DO, said out loud:

  * Pillow is built without Raqm here (`PIL.features.check_feature("raqm")` is
    False), so there is no HarfBuzz. Kerning from the `kern` table works and is
    used; GPOS-only kerning, ligatures, Arabic/Indic shaping and RTL bidi do
    not. Latin, Greek and Cyrillic are fine. Anything else lays out as
    unshaped codepoints left to right, and no amount of code in this file fixes
    that - it needs `pip install pillow[raqm]` on the rig.
  * Outline joins are metric balls in raster space, because PIL exposes glyph
    BITMAPS and not glyph OUTLINES: `round` is a true Euclidean offset, `miter`
    is a Chebyshev offset (an unlimited miter - exact at a right-angle corner,
    an approximation at an acute one), `bevel` is an octagonal metric, i.e. a
    chamfered miter. A real miter limit is a vector operation on the contour
    and this raster path cannot do it exactly. Stated, not faked.
"""

import math
import os
import sys

import cv2
import numpy as np
from PIL import Image, ImageFont

_EPS = np.float32(1e-6)


# ---------------------------------------------------------------------------
# the catalog vocabulary - the same constructors effects.py uses, so the UI
# generator and the MCP schema builder need no special case for this module
# ---------------------------------------------------------------------------

CATALOG = {}

GROUP_ORDER = ["Type", "Fill", "Decoration", "Path"]

ALIGNS = ["left", "center", "right", "justify"]
VALIGNS = ["top", "middle", "bottom"]
ANCHORS = ["topLeft", "top", "topRight", "left", "center", "right",
           "bottomLeft", "bottom", "bottomRight"]
OVERFLOW = ["overflow", "clip", "shrink"]
JOINS = ["round", "miter", "bevel"]

# A still image has no timeline, so nothing here is animatable. The key is
# carried anyway: the UI builder and the MCP schema builder both read it off
# every effects-shaped catalog and a missing key is a crash, not a default.
def num(default, lo, hi, desc, integer=False, unit=None):
    p = {"type": "number", "default": default, "min": lo, "max": hi,
         "animatable": False, "desc": desc}
    if integer:
        p["integer"] = True
    if unit:
        p["unit"] = unit
    return p


def flag(default, desc):
    return {"type": "bool", "default": bool(default), "animatable": False, "desc": desc}


def pick(options, default, desc):
    return {"type": "enum", "options": list(options), "default": default,
            "animatable": False, "desc": desc}


def col(default, desc):
    """Colours are 0-255 RGB or RGBA. §9: a 0-1 triple is a legal near-black
    colour, so getting this wrong draws perfectly and only the picture is
    wrong. Nothing in this file accepts a 0-1 colour."""
    return {"type": "color", "default": list(default), "min": 0, "max": 255,
            "animatable": False, "desc": desc}


def vec(default, desc, lo=-100000.0, hi=100000.0, unit=None):
    """A single [x, y] pair."""
    p = {"type": "vec2", "default": [float(default[0]), float(default[1])],
         "min": lo, "max": hi, "animatable": False, "desc": desc}
    if unit:
        p["unit"] = unit
    return p


def pts(default, desc):
    """A list of [x, y] points in image pixels - a polyline path."""
    return {"type": "points", "default": [list(p) for p in default],
            "min": -100000.0, "max": 100000.0, "animatable": False, "desc": desc}


def words(default, desc, multiline=False):
    p = {"type": "string", "default": default, "animatable": False, "desc": desc}
    if multiline:
        p["multiline"] = True
    return p


def obj(of, desc):
    """A nested sub-spec, described by CATALOG[of]. The UI draws it as a
    sub-panel; the MCP schema builder nests an object."""
    return {"type": "object", "of": of, "default": {}, "animatable": False, "desc": desc}


def stops(default, desc):
    """Gradient stops: [[position 0..1, r, g, b, a], ...], colours 0-255."""
    return {"type": "stops", "default": [list(s) for s in default],
            "animatable": False, "desc": desc}


def entry(name, label, group, why, params, **extra):
    e = {"label": label, "group": group, "why": why, "params": params}
    e.update(extra)
    CATALOG[name] = e
    return e


entry("text", "Type", "Type",
      "The type tool. A paragraph, not a caption: explicit newlines and word "
      "wrap into a box, line height, tracking, four alignments and three "
      "vertical alignments, laid out with the face's real kerning.",
      {
          "content": words("", "the text; \\n starts a new paragraph, \\t is four spaces",
                           multiline=True),
          "font": words("arial.ttf", "a file name from /api/fonts. BASENAME ONLY - a "
                                     "name with a separator or .. is refused, not trimmed"),
          "size": num(64, 1, 2000, "em size in pixels", unit="px"),
          "box": {"type": "rect", "default": [0, 0, 0, 0], "animatable": False,
                  "desc": "[x, y, w, h] in image pixels. w=0 means no wrap (one line per "
                          "paragraph); h=0 means the block is its own height, so valign "
                          "and overflow have nothing to work against"},
          "anchor": pick(ANCHORS, "topLeft",
                         "which point of the box lands on box[x], box[y] - so a centred "
                         "caption is box [cx, cy, 0, 0] with anchor center"),
          "align": pick(ALIGNS, "left",
                        "horizontal alignment inside the box; justify stretches the "
                        "spaces and leaves the last line of each paragraph alone"),
          "justifyLast": pick(["left", "center", "right"], "left",
                              "what the last line of a justified paragraph does instead"),
          "valign": pick(VALIGNS, "top", "vertical placement of the block inside box h"),
          "lineHeight": num(1.2, 0.05, 20.0,
                            "baseline-to-baseline as a multiple of ascent+descent; "
                            "1.0 is single spacing"),
          "tracking": num(0.0, -500.0, 500.0,
                          "letter spacing in pixels, added after every glyph but the "
                          "last, so a line of n glyphs grows by (n-1)*tracking",
                          unit="px"),
          "wordSpacing": num(0.0, -500.0, 500.0,
                             "extra pixels on every space character, on top of tracking",
                             unit="px"),
          "overflow": pick(OVERFLOW, "overflow",
                           "what a block taller than box h does: overflow draws past the "
                           "edge, clip cuts at it, shrink refits at a smaller size"),
          "minSize": num(8, 1, 2000, "the floor shrink-to-fit will not go below", unit="px"),
          "smartPunctuation": flag(False,
                                   "straight quotes to curly, -- to en dash, --- to em "
                                   "dash, ... to ellipsis - and only where the face "
                                   "actually has the glyph"),
          "rotate": num(0.0, -3600.0, 3600.0,
                        "degrees clockwise, about the anchor point", unit="deg"),
          "skewX": num(0.0, -85.0, 85.0, "horizontal shear in degrees - a fake italic",
                       unit="deg"),
          "skewY": num(0.0, -85.0, 85.0, "vertical shear in degrees", unit="deg"),
          "fill": obj("fill", "how the glyph interiors are painted"),
          "outline": obj("outline", "the stroke around the glyphs"),
          "shadow": obj("shadow", "drop shadow, under everything"),
          "glow": obj("glow", "outer glow, over the shadow and under the fill"),
          "path": obj("path", "lay the text along a line, an arc or a polyline instead"),
      })

entry("fill", "Fill", "Fill",
      "What goes inside the letters. A gradient or a photograph inside display "
      "type is the difference between a title card and a screenshot of one.",
      {
          "type": pick(["solid", "linear", "radial", "image"], "solid",
                       "solid colour, a two-point linear ramp, a radial ramp, or an "
                       "image used as a texture"),
          "color": col([255, 255, 255], "the solid colour, and the first gradient stop"),
          "color2": col([0, 0, 0], "the last gradient stop, when stops is empty"),
          "stops": stops([], "[[t 0..1, r, g, b, a], ...]; empty means color -> color2"),
          "space": pick(["block", "canvas"], "block",
                        "block puts start/end in 0..1 across the text's own bounding "
                        "box, so the ramp fits the words; canvas puts them in pixels"),
          "start": vec([0.0, 0.0], "linear: the first endpoint. radial: the centre"),
          "end": vec([0.0, 1.0], "linear: the second endpoint. radial: a point on the "
                                 "outer radius"),
          "opacity": num(100.0, 0.0, 100.0, "multiplies the whole fill's alpha", unit="%"),
          "image": words("", "image fill: an absolute path to a png/jpg/webp. Unlike a "
                             "font this is a caller-owned path, the same trust the job's "
                             "own in/out paths already carry"),
          "fit": pick(["cover", "contain", "stretch", "tile"], "cover",
                      "how the texture is mapped onto the text's bounding box"),
      })

entry("outline", "Outline", "Decoration",
      "A stroke. Over a photograph this is what stops the counters of the "
      "letters dissolving into whatever is behind them.",
      {
          "width": num(0.0, 0.0, 200.0, "stroke width in pixels; 0 is off", unit="px"),
          "color": col([0, 0, 0], "stroke colour"),
          "opacity": num(100.0, 0.0, 100.0, "stroke alpha", unit="%"),
          "join": pick(JOINS, "round",
                       "raster metric for the offset: round is a true Euclidean "
                       "offset, miter a Chebyshev one (square corners), bevel an "
                       "octagonal one. A real miter LIMIT needs the glyph contour, "
                       "which PIL does not expose"),
          "position": pick(["outside", "center", "inside"], "outside",
                           "where the stroke sits relative to the glyph edge"),
      })

entry("shadow", "Drop shadow", "Decoration",
      "Offset, blurred, behind. The cheapest way to lift type off a busy "
      "background without an outline's hard edge.",
      {
          "enabled": flag(False, "off by default; an unasked-for shadow is a bug"),
          "offsetX": num(6.0, -2000.0, 2000.0, "pixels right", unit="px"),
          "offsetY": num(6.0, -2000.0, 2000.0, "pixels down", unit="px"),
          "blur": num(6.0, 0.0, 400.0,
                      "gaussian sigma; 0 is a hard copy of the glyphs, bit for bit at "
                      "a whole-pixel offset", unit="px"),
          "spread": num(0.0, 0.0, 200.0, "grow the shadow before blurring", unit="px"),
          "color": col([0, 0, 0], "shadow colour"),
          "opacity": num(75.0, 0.0, 100.0, "shadow alpha", unit="%"),
      })

entry("glow", "Outer glow", "Decoration",
      "A soft halo in the type's own colour family. Over video stills it reads "
      "as light rather than as a border.",
      {
          "enabled": flag(False, "off by default"),
          "radius": num(12.0, 0.0, 400.0, "gaussian sigma of the halo", unit="px"),
          "spread": num(0.0, 0.0, 200.0, "solid growth before the blur", unit="px"),
          "color": col([255, 220, 120], "glow colour"),
          "opacity": num(100.0, 0.0, 100.0, "glow alpha", unit="%"),
          "intensity": num(1.0, 0.1, 8.0,
                           "multiplies the blurred halo before clipping - past 1 the "
                           "core saturates and the falloff tightens"),
      })

entry("path", "Text on a path", "Path",
      "Glyphs walked along a line, an arc or an arbitrary polyline, each one "
      "rotated to the tangent. Wrapping and box alignment do not apply - a "
      "path takes one run, so newlines become spaces.",
      {
          "kind": pick(["none", "line", "arc", "polyline"], "none", "off by default"),
          "points": pts([], "line: two points. polyline: as many as you like, in "
                            "image pixels"),
          "center": vec([0.0, 0.0], "arc: centre in image pixels"),
          "radius": num(200.0, 1.0, 20000.0, "arc: radius in pixels", unit="px"),
          "startAngle": num(180.0, -3600.0, 3600.0,
                            "arc: degrees clockwise from +x (image y points down), so "
                            "180 -> 360 is the top half read left to right", unit="deg"),
          "endAngle": num(360.0, -3600.0, 3600.0, "arc: where the sweep ends", unit="deg"),
          "align": pick(["start", "center", "end"], "start",
                        "where the run sits along the path's length"),
          "offset": num(0.0, -20000.0, 20000.0,
                        "extra arc length before the first glyph", unit="px"),
          "side": num(0.0, -2000.0, 2000.0,
                      "shift the baseline perpendicular to the path; positive is to the "
                      "right of travel, so on a left-to-right arc it pushes the text "
                      "down", unit="px"),
          "flip": flag(False, "walk the path backwards and turn the glyphs over - what "
                              "you want on the bottom half of a badge"),
      })


# ---------------------------------------------------------------------------
# validation. Everything the renderer sees has been through here, so the
# rendering code below reads as geometry instead of as defensive checks.
# ---------------------------------------------------------------------------

def _f(v, fallback):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return float(fallback)
    return float(fallback) if not math.isfinite(x) else x


def _coerce(spec_name, src):
    """One catalog entry's worth. Unknown keys are dropped, missing ones take
    the default, numbers are clamped to their advertised range and NaN falls
    back rather than propagating into a canvas full of nothing."""
    out = {}
    src = src if isinstance(src, dict) else {}
    for key, p in CATALOG[spec_name]["params"].items():
        v = src.get(key, p["default"])
        kind = p["type"]
        if kind == "number":
            v = min(max(_f(v, p["default"]), float(p["min"])), float(p["max"]))
            if p.get("integer"):
                v = int(round(v))
        elif kind == "bool":
            v = bool(v)
        elif kind == "enum":
            if v not in p["options"]:
                v = p["default"]
        elif kind == "string":
            v = "" if v is None else str(v)
        elif kind == "color":
            try:
                chan = [min(255.0, max(0.0, _f(c, 0))) for c in list(v)[:4]]
            except TypeError:
                chan = []
            v = chan if len(chan) >= 3 else list(p["default"])
        elif kind == "vec2":
            try:
                pair = [_f(c, 0.0) for c in list(v)[:2]]
            except TypeError:
                pair = []
            v = pair if len(pair) == 2 else list(p["default"])
        elif kind == "rect":
            try:
                r = [_f(c, 0.0) for c in list(v)[:4]]
            except TypeError:
                r = []
            v = r if len(r) == 4 else list(p["default"])
        elif kind == "points":
            clean = []
            for q in (v if isinstance(v, (list, tuple)) else []):
                try:
                    if len(q) >= 2:
                        clean.append([_f(q[0], 0.0), _f(q[1], 0.0)])
                except TypeError:
                    continue
            v = clean
        elif kind == "stops":
            clean = []
            for s in (v if isinstance(v, (list, tuple)) else []):
                try:
                    if len(s) >= 4:
                        clean.append([min(1.0, max(0.0, _f(s[0], 0.0))),
                                      min(255.0, max(0.0, _f(s[1], 0))),
                                      min(255.0, max(0.0, _f(s[2], 0))),
                                      min(255.0, max(0.0, _f(s[3], 0))),
                                      min(255.0, max(0.0, _f(s[4], 255))) if len(s) > 4 else 255.0])
                except TypeError:
                    continue
            v = sorted(clean, key=lambda s: s[0])
        elif kind == "object":
            v = _coerce(p["of"], v)
        out[key] = v
    return out


def coerce_spec(spec):
    """The public front door for validation - MCP and the UI can call it to
    show a caller what their job actually resolved to."""
    return _coerce("text", spec)


# ---------------------------------------------------------------------------
# fonts. §8 puts the type tool in this column, but the SECURITY rule lives in
# imagetools.py and is quoted here rather than re-derived.
# ---------------------------------------------------------------------------

FONT_DIRS = [r"C:\Windows\Fonts",
             os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "Windows", "Fonts")]

FONT_EXT = (".ttf", ".otf", ".ttc", ".otc", ".pfb")

_BAD_IN_NAME = ("/", "\\", "..", ":", "\x00")


def resolve_font_path(name):
    """A font name to an absolute path, or None.

    BASENAME ONLY, from the font folders. `imagetools.py` reaches the same
    place with `os.path.basename`; this refuses instead, because trimming
    `../../../evil.ttf` down to `evil.ttf` and then quietly rendering in Arial
    is indistinguishable from success at the call site. The reason the rule
    exists at all: ops arrive at this process unvalidated and FreeType will
    open and parse whatever path it is handed."""
    n = str(name or "").strip()
    if not n or any(b in n for b in _BAD_IN_NAME):
        return None
    if not n.lower().endswith(FONT_EXT):
        return None
    for d in FONT_DIRS:
        if not d:
            continue
        cand = os.path.join(d, n)
        if os.path.isfile(cand):
            return cand
    return None


class _Face:
    """A loaded font plus the metrics every layout question needs, and a stable
    cache key - `id(font)` is not one, because CPython reuses addresses."""

    __slots__ = ("font", "key", "ascent", "descent", "path", "size", "_len")

    def __init__(self, font, key, path, size):
        self.font = font
        self.key = key
        self.path = path
        self.size = size
        self.ascent, self.descent = font.getmetrics()
        self._len = {}

    def length(self, s):
        v = self._len.get(s)
        if v is None:
            v = float(self.font.getlength(s))
            if len(self._len) > 20000:
                self._len.clear()
            self._len[s] = v
        return v

    @property
    def line_box(self):
        """Single spacing. See the module docstring for why this is
        ascent+descent and not FreeType's `height`."""
        return float(self.ascent + self.descent)


_FACES = {}


def load_face(name, size, warnings=None):
    """A `_Face` for (name, size). A refused or missing font falls back to
    Pillow's bundled default at the same size and says so in `warnings` - a
    render that loses a headline because a font was misspelt is worse than one
    in the wrong face, and the caller gets told either way."""
    size = max(1.0, float(size))
    key = (str(name), round(size, 3))
    face = _FACES.get(key)
    if face is not None:
        return face
    path = resolve_font_path(name)
    font = None
    if path:
        try:
            font = ImageFont.truetype(path, size)
        except OSError as exc:
            if warnings is not None:
                warnings.append(f"font {name!r} failed to load: {exc}")
            font = None
    elif warnings is not None:
        warnings.append(f"font {name!r} refused or not on the font shelf; "
                        f"falling back to the default face")
    if font is None:
        try:
            font = ImageFont.load_default(size)
        except TypeError:                       # Pillow < 10.1 has no sized default
            font = ImageFont.load_default()
        path = None
    face = _Face(font, key, path, size)
    if len(_FACES) > 256:
        _FACES.clear()
    _FACES[key] = face
    return face


_CMAP = {}


def _covered(face, ch):
    """Does this face actually have this codepoint? Only asked for smart
    punctuation, where guessing wrong swaps a working apostrophe for a .notdef
    box. fontTools is on the rig; when it cannot answer (a .ttc collection, a
    bitmap face, the fallback default) the answer is "assume not" and the
    substitution is skipped - the conservative direction."""
    if face.path is None:
        return False
    cov = _CMAP.get(face.path)
    if cov is None:
        try:
            from fontTools.ttLib import TTFont
            cov = frozenset(TTFont(face.path, lazy=True, fontNumber=0).getBestCmap().keys())
        except Exception:
            cov = frozenset()
        _CMAP[face.path] = cov
    return ord(ch) in cov


_SMART_PAIRS = (("---", "\u2014"), ("--", "\u2013"), ("...", "\u2026"))


def smarten(text, face):
    """Curly quotes and the three dashes people actually type. Cheap enough to
    include: one pass, no tables. A quote opens at the start of the string or
    after whitespace or an opening bracket, and closes otherwise - which is the
    rule every word processor uses and is wrong for `'tis` and `rock 'n' roll`,
    a known and acceptable limit."""
    for src, dst in _SMART_PAIRS:
        if src in text and _covered(face, dst):
            text = text.replace(src, dst)
    out = []
    openers = " \t\n([{\u2014\u2013\u201c\u2018"
    for i, ch in enumerate(text):
        if ch in ("'", '"'):
            prev = text[i - 1] if i else " "
            opening = prev in openers
            want = {("'", True): "\u2018", ("'", False): "\u2019",
                    ('"', True): "\u201c", ('"', False): "\u201d"}[(ch, opening)]
            out.append(want if _covered(face, want) else ch)
        else:
            out.append(ch)
    return "".join(out)


# ---------------------------------------------------------------------------
# shaping: pen advances, kerning included
# ---------------------------------------------------------------------------

def advances(face, text):
    """Per-character pen advance, with the `kern` pair applied.

    `getlength(a + b) - getlength(b)` is the advance of `a` when `b` follows
    it: the pair length is adv(a) + kern(a, b) + adv(b), and Pillow's basic
    layout gives no left-side kerning, so subtracting adv(b) leaves exactly the
    pen step. Two cached calls per character instead of the O(n^2) prefix
    measurement that reads more obviously correct."""
    n = len(text)
    if n == 0:
        return []
    out = [0.0] * n
    for i in range(n):
        if i + 1 < n:
            out[i] = face.length(text[i:i + 2]) - face.length(text[i + 1])
        else:
            out[i] = face.length(text[i])
    return out


# ---------------------------------------------------------------------------
# layout
# ---------------------------------------------------------------------------

_ANCHOR_XY = {"topLeft": (0.0, 0.0), "top": (0.5, 0.0), "topRight": (1.0, 0.0),
              "left": (0.0, 0.5), "center": (0.5, 0.5), "right": (1.0, 0.5),
              "bottomLeft": (0.0, 1.0), "bottom": (0.5, 1.0), "bottomRight": (1.0, 1.0)}


def _normalise(content):
    return str(content or "").replace("\r\n", "\n").replace("\r", "\n").replace("\t", "    ")


def _wrap(text, adv, tracking, word_spacing, box_w):
    """Greedy wrap of ONE paragraph into [start, end) character ranges.

    `eff[i]` is the pen step after glyph i including tracking and word spacing;
    a line's advance is the sum of its steps minus the trailing tracking, and
    trailing spaces are stripped before measuring so they hang outside the box
    the way every typesetter expects.

    The loop is written so `end > start` always holds: a single glyph wider
    than the box gets its own line and overflows, which is the stated rule and
    also the only thing standing between a 1-pixel box and an infinite loop."""
    n = len(text)
    if n == 0:
        return [(0, 0)]
    eff = [adv[i] + tracking + (word_spacing if text[i] == " " else 0.0) for i in range(n)]
    pre = [0.0] * (n + 1)
    for i in range(n):
        pre[i + 1] = pre[i] + eff[i]

    def width(a, b):
        while b > a and text[b - 1] == " ":
            b -= 1
        if b <= a:
            return 0.0
        return pre[b] - pre[a] - tracking

    if box_w <= 0:
        return [(0, n)]

    lines = []
    i = 0
    while i < n:
        j = i
        last_space = -1
        while j < n:
            if j > i and width(i, j + 1) > box_w:
                break
            if text[j] == " ":
                last_space = j
            j += 1
        if j >= n:
            lines.append((i, n))
            break
        if last_space > i:
            end = last_space
            nxt = last_space
            while nxt < n and text[nxt] == " ":
                nxt += 1
        else:
            # No break opportunity in the line so far: this is the long-word
            # case. Break mid-word at the last character that fit rather than
            # letting a 200-character token run off the canvas.
            end = max(j, i + 1)
            nxt = end
        lines.append((i, end))
        i = nxt
    return lines or [(0, 0)]


def _layout_at(p, size, warnings):
    """The whole layout at one font size. Split out from `layout_text` because
    shrink-to-fit runs it a dozen times."""
    face = load_face(p["font"], size, warnings)
    content = _normalise(p["content"])
    if p["smartPunctuation"] and content:
        content = smarten(content, face)

    if p["path"]["kind"] != "none":
        # A path takes one run - the catalog says so. Collapsing the newlines
        # here rather than in the renderer means the measured advance the
        # glyphs are walked with is the advance that was actually laid out.
        content = content.replace(chr(10), " ")

    bx, by, bw, bh = [float(v) for v in p["box"]]
    if p["path"]["kind"] != "none":
        bw = 0.0
    tracking, word_spacing = p["tracking"], p["wordSpacing"]
    line_step = face.line_box * p["lineHeight"]

    rows = []
    for para in content.split("\n"):
        adv = advances(face, para)
        ranges = _wrap(para, adv, tracking, word_spacing, bw)
        for k, (a, b) in enumerate(ranges):
            while b > a and para[b - 1] == " ":
                b -= 1
            rows.append({"text": para[a:b], "adv": adv[a:b],
                         "lastOfPara": k == len(ranges) - 1})

    for r in rows:
        t, a = r["text"], r["adv"]
        r["advance"] = (sum(a) + max(0, len(t) - 1) * tracking
                        + word_spacing * t.count(" ")) if t else 0.0

    block_w = max([r["advance"] for r in rows] + [0.0])
    block_h = (len(rows) - 1) * line_step + face.line_box if rows else 0.0

    # The box resolves only now, because an auto width or height IS the block's
    # own measurement and the anchor cannot be applied before it is known.
    use_w = bw if bw > 0 else block_w
    use_h = bh if bh > 0 else block_h
    ax, ay = _ANCHOR_XY[p["anchor"]]
    ox = bx - ax * use_w
    oy = by - ay * use_h
    top = oy + {"top": 0.0, "middle": (use_h - block_h) / 2.0,
                "bottom": use_h - block_h}[p["valign"]]

    align, jlast = p["align"], p["justifyLast"]
    for k, r in enumerate(rows):
        t = r["text"]
        eff_align = align
        extra = 0.0
        if align == "justify":
            gaps = t.count(" ")
            if r["lastOfPara"] or gaps == 0:
                # The last line of a paragraph is NOT justified. This is the
                # single most-often-wrong thing about justified text.
                eff_align = jlast
            else:
                # Slack goes in the SPACES, never into the letter spacing, and
                # never negative: an over-long line (a broken word) is left
                # over-long rather than having its glyphs pushed into each other.
                extra = max(0.0, (use_w - r["advance"]) / gaps)
                eff_align = "left"
        pen = ox + {"left": 0.0, "center": (use_w - r["advance"]) / 2.0,
                    "right": use_w - r["advance"]}[eff_align]
        glyphs = []
        x = pen
        for i, ch in enumerate(t):
            glyphs.append((ch, x))
            x += r["adv"][i] + tracking
            if ch == " ":
                x += word_spacing + extra
        r["glyphs"] = glyphs
        r["penStart"] = pen
        r["penEnd"] = (x - tracking) if t else pen
        r["justified"] = extra > 0.0
        r["baseline"] = top + face.ascent + k * line_step
        r.pop("adv", None)

    x0 = min([r["penStart"] for r in rows] + [ox])
    x1 = max([r["penEnd"] for r in rows] + [ox])
    y0 = (rows[0]["baseline"] - face.ascent) if rows else top
    y1 = (rows[-1]["baseline"] + face.descent) if rows else top

    return {"face": face, "size": size, "ascent": face.ascent, "descent": face.descent,
            "lineStep": line_step, "lines": rows, "blockW": block_w, "blockH": block_h,
            "box": (ox, oy, use_w, use_h), "ink": (x0, y0, x1, y1),
            "content": content}


def layout_text(spec, warnings=None):
    """Measure and place, with no pixels touched. Public because it is the
    honest way to test the arithmetic and the only way the UI can draw a
    selection box around type it has not rendered yet."""
    warnings = warnings if warnings is not None else []
    p = coerce_spec(spec)
    lay = _layout_at(p, p["size"], warnings)
    bh = float(p["box"][3])
    if p["overflow"] == "shrink" and bh > 0 and lay["blockH"] > bh:
        # Bisect on the em size, quantised to a quarter pixel: the result is the
        # largest quarter-point size whose block fits. Quantised because the
        # face cache is keyed on size and an unbounded float would miss it every
        # single time, and because "63.9997px" is not a useful answer.
        # minSize above size would GROW the text to escape a box it is
        # already too big for, which is nobody's idea of shrink-to-fit.
        lo, hi = min(float(p["minSize"]), float(p["size"])), float(p["size"])
        best = lo
        for _ in range(14):
            mid = round(((lo + hi) / 2.0) * 4.0) / 4.0
            if mid <= lo or mid >= hi:
                break
            if _layout_at(p, mid, warnings)["blockH"] <= bh:
                best, lo = mid, mid
            else:
                hi = mid
        lay = _layout_at(p, best, warnings)
        lay["shrunk"] = True
    lay["spec"] = p
    lay["warnings"] = warnings
    return lay


# ---------------------------------------------------------------------------
# rasterising glyphs
# ---------------------------------------------------------------------------

_GLYPHS = {}
_SUBPX = 4                     # quarter-pixel horizontal positioning


def _glyph(face, ch, sub):
    """One glyph as a float32 coverage tile plus the offset of that tile from
    the pen point on the baseline.

    `getmask2(..., anchor="ls", start=(fx, 0))` is Pillow's own subpixel path -
    the same one `ImageDraw.text` uses for fractional coordinates - so a glyph
    placed at x=10.25 is rendered a quarter pixel over rather than snapped.
    Without it, tracking of 0.3px would round to nothing for three glyphs out
    of four and the width test below would be off by a pixel per letter."""
    key = (face.key, ch, sub)
    hit = _GLYPHS.get(key)
    if hit is not None:
        return hit
    try:
        mask, off = face.font.getmask2(ch, mode="L", anchor="ls",
                                       start=(sub / float(_SUBPX), 0.0))
    except Exception:
        # A face with no such glyph, or a bitmap-only face at a size it cannot
        # do. An empty tile, not an exception - one bad codepoint must not lose
        # the paragraph.
        hit = (np.zeros((0, 0), np.float32), (0, 0))
        _GLYPHS[key] = hit
        return hit
    w, h = mask.size
    if w <= 0 or h <= 0:
        tile = np.zeros((0, 0), np.float32)
    else:
        tile = np.asarray(mask, dtype=np.uint8).reshape(h, w).astype(np.float32) / 255.0
    hit = (tile, (int(off[0]), int(off[1])))
    if len(_GLYPHS) > 6000:
        _GLYPHS.clear()
    _GLYPHS[key] = hit
    return hit


def _blit_max(dst, src, x0, y0):
    """Union of coverage, not a sum. Two glyphs that overlap - negative
    tracking, a script face with swashes - must not double up into a darker
    seam where they cross; a rasteriser drawing them as one string would not."""
    if src.size == 0:
        return
    h, w = src.shape
    H, W = dst.shape
    sx, sy = max(0, -x0), max(0, -y0)
    dx, dy = max(0, x0), max(0, y0)
    ww, hh = min(w - sx, W - dx), min(h - sy, H - dy)
    if ww <= 0 or hh <= 0:
        return
    view = dst[dy:dy + hh, dx:dx + ww]
    np.maximum(view, src[sy:sy + hh, sx:sx + ww], out=view)


def _coverage(lay, size_wh, origin):
    """The glyph coverage of a straight (non-path) layout, in a buffer whose
    top-left is `origin` in image pixels."""
    w, h = size_wh
    cov = np.zeros((h, w), np.float32)
    face = lay["face"]
    ox, oy = origin
    for r in lay["lines"]:
        by = r["baseline"] - oy
        iy = int(math.floor(by))
        for ch, gx in r["glyphs"]:
            if ch == " ":
                continue
            lx = gx - ox
            ix = int(math.floor(lx))
            sub = int(round((lx - ix) * _SUBPX)) % _SUBPX
            if sub == 0 and lx - ix > 0.5:
                ix += 1
            tile, off = _glyph(face, ch, sub)
            _blit_max(cov, tile, ix + off[0], iy + off[1])
    return cov


# ---------------------------------------------------------------------------
# paths
# ---------------------------------------------------------------------------

class _Path:
    """Arc length -> (x, y, tangent angle). Beyond either end the path
    EXTRAPOLATES along its end tangent rather than clamping, so a run longer
    than its path runs off straight instead of piling every remaining glyph on
    the last point."""

    def __init__(self, pts_, closed=False):
        p = np.asarray(pts_, np.float64).reshape(-1, 2)
        if len(p) > 1:
            seg = np.linalg.norm(np.diff(p, axis=0), axis=1)
            p = p[np.concatenate(([True], seg > 1e-9))]
        self.p = p
        self.seg = np.linalg.norm(np.diff(p, axis=0), axis=1) if len(p) > 1 else np.zeros(0)
        self.cum = np.concatenate(([0.0], np.cumsum(self.seg)))
        self.length = float(self.cum[-1]) if len(self.cum) else 0.0

    def at(self, s):
        p, seg, cum = self.p, self.seg, self.cum
        if len(p) < 2:
            q = p[0] if len(p) else np.zeros(2)
            return float(q[0]), float(q[1]), 0.0
        i = int(np.searchsorted(cum, s, side="right") - 1)
        i = min(max(i, 0), len(seg) - 1)
        d = p[i + 1] - p[i]
        t = (s - cum[i]) / max(seg[i], 1e-9)
        q = p[i] + d * t
        return float(q[0]), float(q[1]), float(math.atan2(d[1], d[0]))


class _Arc:
    """Analytic, not flattened. A chord's direction is off by half the segment
    angle, and per-glyph rotation is the entire point of text on a path, so the
    tangent here is the real one."""

    def __init__(self, cx, cy, r, a0_deg, a1_deg):
        self.c = (float(cx), float(cy))
        self.r = max(1e-6, float(r))
        self.a0 = math.radians(a0_deg)
        self.a1 = math.radians(a1_deg)
        self.sign = 1.0 if self.a1 >= self.a0 else -1.0
        self.length = abs(self.a1 - self.a0) * self.r

    def at(self, s):
        a = self.a0 + self.sign * (s / self.r)
        x = self.c[0] + self.r * math.cos(a)
        y = self.c[1] + self.r * math.sin(a)
        # d/ds of the point: the tangent, which already carries the direction
        # of travel, so a reversed sweep reads its glyphs the right way up.
        return x, y, math.atan2(self.sign * math.cos(a), -self.sign * math.sin(a))


def _build_path(pp):
    kind = pp["kind"]
    if kind == "line":
        q = pp["points"]
        if len(q) < 2:
            return None
        return _Path([q[0], q[1]])
    if kind == "polyline":
        q = pp["points"]
        if len(q) < 2:
            return None
        return _Path(q)
    if kind == "arc":
        return _Arc(pp["center"][0], pp["center"][1], pp["radius"],
                    pp["startAngle"], pp["endAngle"])
    return None


def _path_coverage(lay, pp, size_wh, origin):
    """Glyphs walked along the path, each warped to its own tangent.

    The anchor for a glyph is taken at the MIDDLE of its advance and then
    stepped back half an advance along the tangent there. Anchoring at the pen
    point instead makes every glyph on a tight curve lean out of the run; this
    is what Illustrator does and it is the reason a badge's lettering sits on
    the circle instead of skidding off it."""
    w, h = size_wh
    cov = np.zeros((h, w), np.float32)
    path = _build_path(pp)
    if path is None or path.length <= 0:
        return cov
    face = lay["face"]
    ox, oy = origin
    flip = bool(pp["flip"])
    side = float(pp["side"])

    run = [(ch, gx) for r in lay["lines"] for ch, gx in r["glyphs"]]
    if not run:
        return cov
    base = run[0][1]
    total = lay["lines"][-1]["penEnd"] - lay["lines"][0]["penStart"]
    start = {"start": 0.0, "center": (path.length - total) / 2.0,
             "end": path.length - total}[pp["align"]] + float(pp["offset"])

    tracking = lay["spec"]["tracking"] if "spec" in lay else 0.0
    for idx, (ch, gx) in enumerate(run):
        if ch == " ":
            continue
        nxt = run[idx + 1][1] if idx + 1 < len(run) else gx + tracking
        adv = max(0.0, nxt - gx)
        s = start + (gx - base) + adv * 0.5
        if flip:
            s = path.length - s
        px, py, ang = path.at(s)
        if flip:
            ang += math.pi
        ca, sa = math.cos(ang), math.sin(ang)
        # back off half an advance along the tangent, then push out along the
        # normal (rotate the tangent +90deg: image y points down, so this is to
        # the right of travel)
        px += -ca * adv * 0.5 - sa * side
        py += -sa * adv * 0.5 + ca * side

        tile, off = _glyph(face, ch, 0)
        if tile.size == 0:
            continue
        th, tw = tile.shape
        # corners of the tile in image space, to size the destination
        cx = [ca * (off[0] + u) - sa * (off[1] + v) + px
              for u, v in ((0, 0), (tw, 0), (0, th), (tw, th))]
        cy = [sa * (off[0] + u) + ca * (off[1] + v) + py
              for u, v in ((0, 0), (tw, 0), (0, th), (tw, th))]
        X0, Y0 = int(math.floor(min(cx))) - 1, int(math.floor(min(cy))) - 1
        X1, Y1 = int(math.ceil(max(cx))) + 1, int(math.ceil(max(cy))) + 1
        dw, dh = X1 - X0, Y1 - Y0
        if dw <= 0 or dh <= 0 or dw > 8192 or dh > 8192:
            continue
        M = np.array([[ca, -sa, ca * off[0] - sa * off[1] + px - X0],
                      [sa, ca, sa * off[0] + ca * off[1] + py - Y0]], np.float32)
        warped = cv2.warpAffine(tile, M, (dw, dh), flags=cv2.INTER_LINEAR,
                                borderMode=cv2.BORDER_CONSTANT, borderValue=0.0)
        _blit_max(cov, warped, X0 - int(ox), Y0 - int(oy))
    return cov


# ---------------------------------------------------------------------------
# paint
# ---------------------------------------------------------------------------

def _c01(c, n=4):
    a = np.zeros(n, np.float32)
    if n == 4:
        a[3] = 1.0
    for i, v in enumerate(list(c)[:n]):
        a[i] = float(v) / 255.0
    return np.clip(a, 0.0, 1.0)


def _stop_list(fill):
    s = fill["stops"]
    if len(s) >= 2:
        return [(float(t), _c01([r, g, b, a])) for t, r, g, b, a in s]
    c0, c1 = list(fill["color"]), list(fill["color2"])
    if len(c0) < 4:
        c0 = c0[:3] + [255.0]
    if len(c1) < 4:
        c1 = c1[:3] + [255.0]
    return [(0.0, _c01(c0)), (1.0, _c01(c1))]


def _ramp(t, sl):
    """Straight-RGBA linear interpolation between stops. Straight, not
    premultiplied: a stop's colour is a colour whatever its alpha, so a ramp
    from opaque red to transparent red stays red the whole way instead of
    sliding through black - the same argument the module docstring makes about
    glyph edges, one level up."""
    pos = np.array([s[0] for s in sl], np.float64)
    cols = np.stack([s[1] for s in sl])
    if len(sl) == 2 and pos[1] > pos[0]:
        # The overwhelmingly common case, and worth its own line: a two-stop
        # ramp is one lerp, where the general path costs a searchsorted and two
        # fancy-indexed gathers of a whole (H, W, 4) - 170ms on a 2048 canvas.
        f = np.clip((t - pos[0]) / (pos[1] - pos[0]), 0.0, 1.0)[..., None].astype(np.float32)
        out = f * (cols[1] - cols[0])
        out += cols[0]
        return out
    flat = np.ascontiguousarray(t, np.float64).ravel()
    out = np.empty((flat.size, 4), np.float32)
    for c in range(4):
        # np.interp clamps to the end values outside the stop range, which is
        # exactly the gradient's own edge behaviour, and lands EXACTLY on a
        # stop's colour at that stop's position.
        out[:, c] = np.interp(flat, pos, cols[:, c])
    return out.reshape(t.shape + (4,))


def _load_texture(path):
    if not path:
        return None
    if not os.path.isfile(path):
        return None
    if not str(path).lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff")):
        return None
    try:
        with Image.open(path) as im:
            return np.asarray(im.convert("RGBA"), np.float32) / 255.0
    except Exception:
        return None


def paint_field(fill, width, height, box=None):
    """The colour every covered pixel takes, as float32 (H, W, 4) straight
    RGBA - rgb is the colour, a is a multiplier on coverage. Public because
    "the endpoints are exactly the two colours" is a claim about this function
    and testing it through a glyph would only prove that a glyph happened to
    cover the endpoint."""
    # Always coerced, never sniffed: "it already has a type key" is exactly the
    # half-built object that ships a fill with no stops list and a KeyError.
    # _coerce is idempotent, so the internal caller pays nothing for it.
    fill = _coerce("fill", fill)
    h, w = int(height), int(width)
    out = np.empty((h, w, 4), np.float32)
    bx, by, bw, bh = box if box else (0.0, 0.0, float(w), float(h))
    bw = bw if abs(bw) > 1e-6 else 1.0
    bh = bh if abs(bh) > 1e-6 else 1.0
    kind = fill["type"]

    if kind == "image":
        tex = _load_texture(fill["image"])
        if tex is None:
            kind = "solid"                     # named a texture, gave us nothing
        else:
            th, tw = tex.shape[:2]
            xs = (np.arange(w, dtype=np.float32) + 0.5 - bx) / bw
            ys = (np.arange(h, dtype=np.float32) + 0.5 - by) / bh
            fitm = fill["fit"]
            if fitm == "tile":
                u = np.mod(xs * bw, tw)
                v = np.mod(ys * bh, th)
            else:
                if fitm == "stretch":
                    sx = sy = None
                else:
                    ar_box, ar_tex = bw / bh, tw / float(th)
                    # cover fills the box and crops; contain fits inside and the
                    # uncovered strip takes the edge pixel, not transparency -
                    # a hole in a letter reads as a bug.
                    grow = (ar_box > ar_tex) if fitm == "cover" else (ar_box < ar_tex)
                    sx, sy = (1.0, ar_tex / ar_box) if grow else (ar_box / ar_tex, 1.0)
                if fitm == "stretch":
                    u, v = xs * tw, ys * th
                else:
                    u = ((xs - 0.5) * sx + 0.5) * tw
                    v = ((ys - 0.5) * sy + 0.5) * th
            uu = np.clip(u, 0, tw - 1).astype(np.int32)
            vv = np.clip(v, 0, th - 1).astype(np.int32)
            out[:] = tex[vv[:, None], uu[None, :]]

    if kind in ("linear", "radial"):
        sl = _stop_list(fill)
        sx, sy = fill["start"]
        ex, ey = fill["end"]
        if fill["space"] == "block":
            sx, sy = bx + sx * bw, by + sy * bh
            ex, ey = bx + ex * bw, by + ey * bh
        X = np.arange(w, dtype=np.float32)[None, :] + 0.5
        Y = np.arange(h, dtype=np.float32)[:, None] + 0.5
        if kind == "linear":
            dx, dy = ex - sx, ey - sy
            den = dx * dx + dy * dy
            if den < 1e-9:
                t = np.zeros((h, w), np.float32)
            else:
                t = (((X - sx) * dx + (Y - sy) * dy) / den).astype(np.float32)
        else:
            r = math.hypot(ex - sx, ey - sy)
            t = (np.hypot(X - sx, Y - sy) / max(r, 1e-9)).astype(np.float32)
        out[:] = _ramp(np.clip(t, 0.0, 1.0), sl)

    if kind == "solid":
        c = list(fill["color"])
        if len(c) < 4:
            c = c[:3] + [255.0]
        out[:] = _c01(c)

    out[..., 3] *= float(fill["opacity"]) / 100.0
    return out


# ---------------------------------------------------------------------------
# decoration
# ---------------------------------------------------------------------------

_DIST = {"round": (cv2.DIST_L2, cv2.DIST_MASK_PRECISE),
         "miter": (cv2.DIST_C, 3),
         "bevel": (cv2.DIST_L1, 3)}


def _outset(cov, r, join="round"):
    """Grow coverage by r pixels under the join's metric. `w + 0.5 - d` is the
    signed-distance ramp every SDF text renderer uses: the half-pixel is what
    makes the new edge land on the pixel centre and antialias instead of
    stair-stepping."""
    if r <= 0.0:
        return cov
    mode, msk = _DIST[join]
    outside = (cov < 0.5).astype(np.uint8)
    d = cv2.distanceTransform(outside, mode, msk)
    if join == "bevel":
        # An octagonal ball: a Chebyshev square with its corners chamfered by
        # the L1 metric. That IS a bevel, and it is the closest a raster offset
        # gets to one without the glyph contour.
        d = np.maximum(cv2.distanceTransform(outside, cv2.DIST_C, 3), d * 0.70710678)
    grown = np.clip(r + 0.5 - d, 0.0, 1.0).astype(np.float32)
    return np.maximum(cov, grown)


def _inset(cov, r, join="round"):
    if r <= 0.0:
        return cov
    mode, msk = _DIST[join]
    inside = (cov >= 0.5).astype(np.uint8)
    d = cv2.distanceTransform(inside, mode, msk)
    if join == "bevel":
        d = np.maximum(cv2.distanceTransform(inside, cv2.DIST_C, 3), d * 0.70710678)
    return np.minimum(cov, np.clip(d - r + 0.5, 0.0, 1.0).astype(np.float32))


def _shift(a, dx, dy):
    """Whole-pixel offsets are a slice - bit for bit, no resampling - because
    "a hard shadow is a hard copy" is a promise a bilinear warp would quietly
    break by softening every edge by half a pixel."""
    if abs(dx - round(dx)) < 1e-9 and abs(dy - round(dy)) < 1e-9:
        out = np.zeros_like(a)
        dx, dy = int(round(dx)), int(round(dy))
        h, w = a.shape
        sx, sy = max(0, -dx), max(0, -dy)
        tx, ty = max(0, dx), max(0, dy)
        ww, hh = min(w - sx, w - tx), min(h - sy, h - ty)
        if ww > 0 and hh > 0:
            out[ty:ty + hh, tx:tx + ww] = a[sy:sy + hh, sx:sx + ww]
        return out
    M = np.array([[1.0, 0.0, dx], [0.0, 1.0, dy]], np.float32)
    return cv2.warpAffine(a, M, (a.shape[1], a.shape[0]), flags=cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_CONSTANT, borderValue=0.0)


def _blur(a, sigma):
    if sigma <= 0.0:
        return a
    return cv2.GaussianBlur(a, (0, 0), float(sigma), borderType=cv2.BORDER_CONSTANT)


def _pm_flat(a, colour):
    """A single-colour layer: one colour, one coverage field. PREMULTIPLIED,
    like everything else on the composite stack - see _over_pm."""
    c = _c01(list(colour)[:3] + [255.0])
    return a[..., None] * np.array([c[0], c[1], c[2], 1.0], np.float32)


def _premul(straight):
    out = straight * straight[..., 3:4]
    out[..., 3] = straight[..., 3]
    return out


def _unpremul(pm):
    """Premultiplied back to straight - the step that, skipped, is the dark
    halo this whole module is written around. It happens exactly once, at the
    boundary, and imgtext_test.py asserts on the result rather than trusting
    the comment."""
    a = np.clip(pm[..., 3], 0.0, 1.0)
    # No branch on a == 0: the numerator there is zero too, so 0 * 1e6 is 0 and
    # the clip mops up anything the reciprocal exaggerated. A np.where here
    # costs a whole extra (H, W) mask and buys nothing.
    out = pm * np.reciprocal(np.maximum(a, _EPS))[..., None]
    np.clip(out, 0.0, 1.0, out=out)
    out[..., 3] = a
    return out


def _over_pm(dst, src):
    """Porter-Duff over, in place, on PREMULTIPLIED buffers.

    `over` is linear only in premultiplied space, which is why it collapses to
    `dst*(1-srcA) + src` on all four channels at once: two contiguous passes
    over one (H, W, 4). The straight-alpha version of the same maths needs the
    colour planes divided back out at every step, and a `[..., :3]` view of an
    interleaved RGBA buffer is strided - on a 2048 canvas that was 188ms per
    composite against 11ms for this.

    Nothing leaves the module in this form. `_place` unpremultiplies once, at
    the end, and that is also exactly the buffer `warpAffine` needs to
    interpolate correctly, so the transform costs nothing extra."""
    dst *= 1.0 - src[..., 3:4]
    dst += src
    return dst


def _over(dst, src):
    """The straight-alpha composite, for callers outside the stack: straight
    in, straight out, premultiplied only in the middle where the arithmetic
    lives."""
    return _unpremul(_over_pm(_premul(np.asarray(dst, np.float32)),
                              _premul(np.asarray(src, np.float32))))


# ---------------------------------------------------------------------------
# the render
# ---------------------------------------------------------------------------

def _bounds(lay, p, canvas_w, canvas_h):
    """The local buffer the block is drawn into: image-pixel rect, top-left
    inclusive. Big enough for the decoration; intersected with the canvas only
    when there is no transform, because a rotation can bring off-canvas ink
    back into view and cropping first would lose it."""
    sh, gl, ol = p["shadow"], p["glow"], p["outline"]
    pad = ol["width"] + 4.0
    if sh["enabled"]:
        pad = max(pad, sh["spread"] + 3.0 * sh["blur"]
                  + max(abs(sh["offsetX"]), abs(sh["offsetY"])) + 2.0)
    if gl["enabled"]:
        pad = max(pad, gl["spread"] + 3.0 * gl["radius"] + 2.0)
    pp = p["path"]
    if pp["kind"] != "none":
        path = _build_path(pp)
        if path is not None:
            if isinstance(path, _Arc):
                cx, cy, r = path.c[0], path.c[1], path.r
                x0, y0, x1, y1 = cx - r, cy - r, cx + r, cy + r
            else:
                x0, y0 = float(path.p[:, 0].min()), float(path.p[:, 1].min())
                x1, y1 = float(path.p[:, 0].max()), float(path.p[:, 1].max())
            # The run can be LONGER than its path, in which case it runs off
            # the end along the end tangent - so the buffer has to cover the
            # overrun in every direction, not just the path's own box. Cheap:
            # with no transform this is intersected with the canvas below.
            over = max(0.0, lay["blockW"] - path.length) + abs(pp["offset"])
            reach = lay["size"] * 1.6 + abs(pp["side"]) + over
            x0, y0, x1, y1 = x0 - reach, y0 - reach, x1 + reach, y1 + reach
        else:
            x0, y0, x1, y1 = lay["ink"]
    else:
        x0, y0, x1, y1 = lay["ink"]
        # a full em of slack: overhanging italics, swashes and the odd face
        # whose glyphs draw outside their advance
        em = lay["size"]
        x0, y0, x1, y1 = x0 - em, y0 - em * 0.4, x1 + em, y1 + em * 0.4

    x0, y0, x1, y1 = x0 - pad, y0 - pad, x1 + pad, y1 + pad
    transformed = abs(p["rotate"]) > 1e-9 or abs(p["skewX"]) > 1e-9 or abs(p["skewY"]) > 1e-9
    if not transformed:
        x0, y0 = max(x0, 0.0), max(y0, 0.0)
        x1, y1 = min(x1, float(canvas_w)), min(y1, float(canvas_h))
    ix0, iy0 = int(math.floor(x0)), int(math.floor(y0))
    ix1, iy1 = int(math.ceil(x1)), int(math.ceil(y1))
    w = min(max(ix1 - ix0, 0), 16384)
    h = min(max(iy1 - iy0, 0), 16384)
    return ix0, iy0, w, h


def _ink_box(cov, lay, ox, oy):
    """The tight bounding box of actual ink, in local buffer coordinates - what
    a "fit the gradient to the words" fill has to be measured against."""
    rows = np.any(cov > 0.004, axis=1)
    cols = np.any(cov > 0.004, axis=0)
    if not rows.any() or not cols.any():
        return (lay["ink"][0] - ox, lay["ink"][1] - oy,
                lay["ink"][2] - lay["ink"][0], lay["ink"][3] - lay["ink"][1])
    y0, y1 = int(np.argmax(rows)), int(len(rows) - np.argmax(rows[::-1]))
    x0, x1 = int(np.argmax(cols)), int(len(cols) - np.argmax(cols[::-1]))
    return (float(x0), float(y0), float(x1 - x0), float(y1 - y0))


def _block(lay, p):
    """The finished type in its own local buffer, plus that buffer's origin in
    image pixels. Composite order bottom-up: shadow, glow, the outside half of
    the stroke, the fill, the inside half of the stroke.

    Returns (buffer, origin, is_premultiplied). Premultiplied is the internal
    currency of the composite stack and the form `_place` both blits and warps,
    but a block with only ONE layer - plain text, which is most text - never
    enters that space at all. So the third element is the truth rather than a
    convention, and `_place` unpremultiplies once or not at all."""
    ox, oy, w, h = lay["_bounds"]
    if w <= 0 or h <= 0:
        return np.zeros((1, 1, 4), np.float32), (ox, oy), False

    pp = p["path"]
    if pp["kind"] != "none" and _build_path(pp) is not None:
        cov = _path_coverage(lay, pp, (w, h), (ox, oy))
    else:
        cov = _coverage(lay, (w, h), (ox, oy))

    if p["overflow"] == "clip":
        bx, by, bw, bh = lay["box"]
        keep = np.zeros_like(cov)
        cx0, cy0 = max(0, int(math.floor(bx - ox))), max(0, int(math.floor(by - oy)))
        cx1, cy1 = min(w, int(math.ceil(bx + bw - ox))), min(h, int(math.ceil(by + bh - oy)))
        if cx1 > cx0 and cy1 > cy0:
            keep[cy0:cy1, cx0:cx1] = 1.0
        cov = cov * keep

    # [buffer, is_premultiplied]. The bottom layer IS the buffer - compositing
    # it over a known-empty one is a full-canvas no-op that costs more than the
    # layer did - and if it is also the ONLY layer it never gets premultiplied
    # at all, which is the plain-text case and therefore the common one.
    st = [None, False]

    def put(layer, premultiplied=True):
        if st[0] is None:
            st[0], st[1] = layer, premultiplied
            return
        if not st[1]:
            st[0], st[1] = _premul(st[0]), True
        _over_pm(st[0], layer if premultiplied else _premul(layer))

    sh = p["shadow"]
    if sh["enabled"] and sh["opacity"] > 0:
        a = _outset(cov, sh["spread"], "round")
        a = _shift(a, sh["offsetX"], sh["offsetY"])
        a = _blur(a, sh["blur"]) * (sh["opacity"] / 100.0)
        put(_pm_flat(np.clip(a, 0.0, 1.0), sh["color"]))

    gl = p["glow"]
    if gl["enabled"] and gl["opacity"] > 0:
        a = _outset(cov, gl["spread"], "round")
        a = np.clip(_blur(a, gl["radius"]) * gl["intensity"], 0.0, 1.0) * (gl["opacity"] / 100.0)
        put(_pm_flat(a, gl["color"]))

    ol = p["outline"]
    ring_over = None
    if ol["width"] > 0 and ol["opacity"] > 0:
        pos, wdt, jn = ol["position"], ol["width"], ol["join"]
        under = None
        if pos == "outside":
            under = _outset(cov, wdt, jn)
        elif pos == "center":
            under = _outset(cov, wdt / 2.0, jn)
            ring_over = np.clip(cov - _inset(cov, wdt / 2.0, jn), 0.0, 1.0)
        else:
            ring_over = np.clip(cov - _inset(cov, wdt, jn), 0.0, 1.0)
        if under is not None:
            put(_pm_flat(under * (ol["opacity"] / 100.0), ol["color"]))

    # "block" gradient space is the RENDERED ink box, not the measured one: on
    # a path the measured box is a straight run that exists nowhere on screen,
    # and even for straight text the measured box carries a font's slack.
    paint = paint_field(p["fill"], w, h, _ink_box(cov, lay, ox, oy))
    pa = paint[..., 3] * cov
    if st[0] is None:
        # Nothing under the fill, so hand the straight paint straight through.
        paint[..., 3] = pa
        put(paint, premultiplied=False)
    else:
        paint *= pa[..., None]        # all four channels, then alpha put back
        paint[..., 3] = pa
        put(paint)

    if ring_over is not None:
        put(_pm_flat(ring_over * (ol["opacity"] / 100.0), ol["color"]))
    if st[0] is None:
        return np.zeros((h, w, 4), np.float32), (ox, oy), False
    return st[0], (ox, oy), st[1]


def _place(block, origin, is_pm, p, width, height):
    """Local buffer into the canvas, and premultiplied back to straight on the
    way out - the render path's only unpremultiply.

    With no rotate/skew this is an integer blit and not one pixel is resampled.
    With them it is ONE affine, on the premultiplied buffer, because
    interpolating straight RGB across a coverage edge drags the colour of
    fully-transparent pixels into the glyph and fringes it exactly as badly as
    the premultiplied-output bug this module is written to avoid. Premultiplied
    is right for the WARP and wrong for the OUTPUT, and those are two different
    sentences that get collapsed into one every time this goes wrong."""
    ox, oy = origin
    rot, kx, ky = p["rotate"], p["skewX"], p["skewY"]
    if abs(rot) < 1e-9 and abs(kx) < 1e-9 and abs(ky) < 1e-9:
        canvas = np.zeros((height, width, 4), np.float32)
        # the block, not the canvas: it is the smaller of the two
        straight = _unpremul(block) if is_pm else block
        h, w = straight.shape[:2]
        sx, sy = max(0, -ox), max(0, -oy)
        dx, dy = max(0, ox), max(0, oy)
        ww, hh = min(w - sx, width - dx), min(h - sy, height - dy)
        if ww > 0 and hh > 0:
            canvas[dy:dy + hh, dx:dx + ww] = straight[sy:sy + hh, sx:sx + ww]
        return canvas

    th = math.radians(rot)
    c, s = math.cos(th), math.sin(th)
    tx, ty = math.tan(math.radians(kx)), math.tan(math.radians(ky))
    # rotate * shear, then conjugate by the anchor so the block turns about the
    # point the caller pinned it to rather than about the buffer's corner
    a = c - s * ty
    b = c * tx - s
    d = s + c * ty
    e = s * tx + c
    px, py = float(p["box"][0]), float(p["box"][1])
    M = np.array([[a, b, px - a * px - b * py + (a * ox + b * oy)],
                  [d, e, py - d * px - e * py + (d * ox + e * oy)]], np.float32)
    warped = cv2.warpAffine(block if is_pm else _premul(block), M, (width, height),
                            flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT,
                            borderValue=(0, 0, 0, 0))
    return _unpremul(warped)


def render_text(spec, width, height, mask=None):
    """The type tool's whole job: a float32 (height, width, 4) 0..1 STRAIGHT
    alpha layer with nothing in it but the text.

    `mask` is the §3 selection - float32 (H, W) 0..1, from `imgselect.py`,
    which this module deliberately does not import and does not reimplement.
    On a standalone layer the mask multiplies the alpha, which is the same
    arithmetic as `result * m + original * (1 - m)` against an empty original.

    An empty string, a size of zero, a box smaller than a glyph or a font that
    does not exist all return a valid transparent layer - no spec, however
    hostile, raises. A mask whose shape does not match the canvas DOES raise,
    because that is not user data, it is two modules wired together wrong, and
    a selection that quietly does nothing is the worst of the three outcomes."""
    width, height = max(1, int(width)), max(1, int(height))
    lay = layout_text(spec)
    p = lay["spec"]
    if not lay["content"] or not any(r["glyphs"] for r in lay["lines"]):
        return np.zeros((height, width, 4), np.float32)
    lay["_bounds"] = _bounds(lay, p, width, height)
    block, origin, is_pm = _block(lay, p)
    canvas = _place(block, origin, is_pm, p, width, height)
    if mask is not None:
        m = np.asarray(mask, np.float32)
        if m.shape != (height, width):
            # LOUD. A mask that does not fit is a wiring mistake at the seam
            # between two columns, and silently rendering without it is how a
            # selection ends up doing nothing in production with no error.
            raise ValueError(f"mask is {m.shape}, canvas is {(height, width)}")
        canvas[..., 3] *= np.clip(m, 0.0, 1.0)
    return canvas


def draw_text(rgba, spec, mask=None):
    """Render onto a supplied buffer and hand back a new one - straight-alpha
    over, so an antialiased glyph edge at 50% coverage lands as half text and
    half background, not as half text over black.

    The §3 rule is applied to the COMPOSITE, not to the layer: the op computes
    its full result and then blends `result * m + original * (1 - m)`, which is
    the one sentence that makes every op in stages 5-8 local."""
    base = np.asarray(rgba, np.float32)
    if base.ndim != 3 or base.shape[2] != 4:
        raise ValueError("draw_text needs float32 (H, W, 4) straight-alpha RGBA")
    h, w = base.shape[:2]
    layer = render_text(spec, w, h)
    out = _over(base, layer)
    if mask is not None:
        m = np.clip(np.asarray(mask, np.float32), 0.0, 1.0)
        if m.shape != (h, w):
            raise ValueError(f"mask is {m.shape}, buffer is {(h, w)}")
        out = out * m[..., None] + base * (1.0 - m[..., None])
    return out


def render_debug(spec, width, height, mask=None):
    """Same render, plus the layout and the intermediate alphas. The UI can
    show the shadow on its own; the tests can assert on a layer instead of
    inferring it from a composite."""
    width, height = max(1, int(width)), max(1, int(height))
    lay = layout_text(spec)
    p = lay["spec"]
    info = {"layout": lay, "warnings": lay["warnings"], "spec": p}
    if not lay["content"] or not any(r["glyphs"] for r in lay["lines"]):
        info["rgba"] = np.zeros((height, width, 4), np.float32)
        info["coverage"] = np.zeros((height, width), np.float32)
        return info
    lay["_bounds"] = _bounds(lay, p, width, height)
    ox, oy, bw, bh = lay["_bounds"]
    pp = p["path"]
    if pp["kind"] != "none" and _build_path(pp) is not None:
        cov = _path_coverage(lay, pp, (bw, bh), (ox, oy))
    else:
        cov = _coverage(lay, (bw, bh), (ox, oy))
    info["coverage"] = cov
    info["origin"] = (ox, oy)
    info["rgba"] = render_text(spec, width, height, mask)
    return info


# Every key the old one-line text op in imagetools.py reads. The test asserts
# this list against that file's SOURCE rather than against anybody's memory of
# it, because §9's last line is that a test only locks in what its author
# already believed.
LEGACY_KEYS = ("content", "font", "size", "color", "x", "y", "align",
               "stroke", "strokeColor")


def from_legacy(txt):
    """The old `ops.text` object, translated. Stage 9 has one caller and it is
    the pipeline in imagetools.py; handing the integrator an adapter rather
    than a migration means the old op keeps working the day this is wired.

    The old anchor map was lm/mm/rm - LEFT/CENTRE/RIGHT at MID height - so
    `align` there did two jobs: it picked the anchor AND the alignment. Both
    are reproduced; splitting them is the point of the new spec, not a licence
    to move existing captions half a line up."""
    txt = txt if isinstance(txt, dict) else {}
    al = str(txt.get("align") or "center")
    al = al if al in ("left", "center", "right") else "center"
    sw = _f(txt.get("stroke") or 0, 0.0)
    return {
        "content": txt.get("content"),
        "font": txt.get("font") or "arial.ttf",
        "size": txt.get("size") if txt.get("size") is not None else 64,
        "box": [_f(txt.get("x") or 0, 0.0), _f(txt.get("y") or 0, 0.0), 0.0, 0.0],
        "anchor": al,                          # left/center/right sit at mid height
        "align": al,
        "fill": {"type": "solid", "color": list(txt.get("color") or [255, 255, 255])},
        "outline": {"width": sw, "opacity": 100.0,
                    "color": list(txt.get("strokeColor") or [0, 0, 0])},
    }


def catalog():
    """What MCP and the UI are served. Same shape as effects.catalog(): the
    wrapper key names this module's vocabulary, so `cat["text"]["text"]` is the
    type spec itself and `cat["text"]["fill"]` is its fill sub-spec."""
    return {"text": CATALOG, "groups": GROUP_ORDER, "names": sorted(CATALOG),
            "notes": {
                "colors": "0-255, RGB or RGBA - never 0-1",
                "alpha": "float32 (H, W, 4) 0..1 straight alpha in and out",
                "shaping": "no Raqm on this build: kern-table kerning yes, GPOS "
                           "kerning / ligatures / Arabic / Indic / RTL no",
                "joins": "raster metric balls - round is exact Euclidean, miter is "
                         "Chebyshev, bevel is octagonal; no vector miter limit",
                "overflow": "default draws past the box rather than losing text",
                "fonts": "basename only; a name with a separator, .., a colon or a "
                         "NUL is refused and the default face is used",
            }}


if __name__ == "__main__":
    import json
    mode = sys.argv[1] if len(sys.argv) > 1 else "catalog"
    if mode == "catalog":
        print(json.dumps(catalog()))
    elif mode == "fonts":
        seen = []
        for d in FONT_DIRS:
            if d and os.path.isdir(d):
                seen += [f for f in os.listdir(d) if f.lower().endswith(FONT_EXT)]
        print(json.dumps({"fonts": sorted(set(seen))}))
    else:
        print(json.dumps({"ok": False, "error": f"unknown mode {mode}"}))
        sys.exit(1)
