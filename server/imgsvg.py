"""SVG out - the door the vector side of this studio did not have.

server/imgpath.py is a whole pen tool (beziers, booleans, offset, stroke
outlines, two fill rules) and server/vfx/shapes.py calls itself the vector side
of the compositor. Everything either of them makes leaves as PIXELS. A logo
traced in here cannot go to a printer, a title cannot go into a web page, and a
shape cannot be opened in Illustrator or Inkscape. Meanwhile `vectorize` in
imagetools.py turns a PICTURE into vectors, so this app could make vectors out
of anything except its own vectors.

    paths_to_svg(spec)      a figure - the same {paths: ...} draw job
                            imgpath.draw and imgpath.check_figure take, with
                            its fill, stroke, widths, caps, joins, dashes and
                            fill rule - as a standards-valid SVG document
    text_to_outlines(spec)  the same text spec server/imgtext.py lays out, as
                            GLYPH CONTOURS: a figure spec imgpath.draw can fill
                            and paths_to_svg can emit, so a title survives on a
                            machine that does not have the font

The geometry is imgpath's own. This module imports `_paths_of`, `flatten_all`,
`path_area`, `_coerce` and `check_figure` and re-implements NONE of them - two
bezier readers in one tree would drift, and the day they drift the export stops
matching the render with nothing to say so. The catalog below likewise builds
its paint parameters out of `imgpath.CATALOG["draw"]["params"]` by reference, so
a fill rule added there is exportable here on the same commit.

FIVE WAYS TO WRITE A FILE THAT OPENS FINE AND IS WRONG

Every one of these produces a document that parses, renders, and lies. They are
the whole reason this module is longer than a string template.

  1. THE Y AXIS. Image pixels go down and SVG's user space goes down too, so
     the right transform is NONE. That is worth a pin rather than a sentence,
     because a flipped export looks deliberate: the picture is still a picture,
     still the right colour, still the right size, and only upside down - which
     reads as a design decision in a thumbnail. `imgsvg_test.py` emits an
     asymmetric figure, parses the file back through imgpath's OWN `d` reader
     and asserts the y coordinates are equal, then flips one on purpose and
     asserts the comparison fails.

  2. THE FILL RULE, AND THE WINDING UNDER IT. `fill-rule` is written on every
     filled element, `nonzero` included - it is SVG's default, so leaving it
     off would draw the same picture today and a different one the first time
     the document is pasted inside a group that sets it. And the winding of
     every contour survives byte for byte: `check_figure` runs on the way OUT
     and its report is in the reply, because a counter wound the wrong way
     fills solid with no error, and an export that reversed a contour would
     ship that bug into every program that opens the file.

  3. A FIGURE WITH HOLES IS ONE `<path>` WITH SEVERAL SUBPATHS. This is the
     single most important line in the file. Emit the outer contour and its
     counters as separate `<path>` elements and every one of them is its own
     figure under the fill rule, so every hole fills SOLID - in every renderer,
     at every zoom, for ever. One element, one `d`, several `M ... Z` runs.

  4. ESCAPING. A title, a description or an id carrying `&`, `<`, `>` or a
     quote makes a document that does not parse at all, and XML 1.0 forbids
     most control characters even as character references (`&#11;` is not a
     legal escape for a vertical tab, it is a parse error), so those are
     dropped and reported rather than encoded. Every document this module
     builds is parsed with `xml.etree.ElementTree` BEFORE it is returned, and a
     document that does not parse raises instead of being written.

  5. THE SPELLINGS. `stroke-linecap`, `stroke-linejoin`, `stroke-miterlimit`,
     `stroke-dasharray`, `stroke-dashoffset`, `fill-opacity` - a near miss is
     not an error in SVG, it is silently ignored, and the line comes out solid
     black with butt caps looking exactly like a line somebody meant. The
     enums are imgpath's own (`butt/round/square`, `miter/round/bevel`,
     `nonzero/evenodd`), which happen to be SVG's verbatim; the dash pattern is
     normalised through the same `abs()` and trailing-zero trim `_dash_split`
     applies, so the two agree on what a pattern MEANS before either draws it.

WHAT AN EXPORT CANNOT CARRY, SAID OUT LOUD

  * `blend` other than normal. CSS `mix-blend-mode` covers eight of the twenty
    imgpath will paint (soft light respells as `soft-light`); `add`, `subtract`,
    `divide`, `linearBurn` and the rest have no CSS value, so they are REFUSED
    into a note rather than written as something close. And mix-blend-mode is
    CSS compositing: browsers honour it, Illustrator and Inkscape ignore it on
    import. That is in the reply too.
  * `boolean` other than none. SVG has no boolean operator, so the figure is
    resolved with `imgpath.boolean_paths` - which says in its own docstring
    that it costs about 1/8 px through a raster round trip - and the note is
    carried. The STROKE in that case follows the original contours, because
    that is what `imgpath._draw` strokes, so the document gets two elements and
    says which is which.
  * imgtext's `outline`, `shadow` and `glow` on a text spec. Those are raster
    metrics (a Euclidean, Chebyshev or octagonal ball, not a vector offset with
    a miter limit), and an SVG `stroke` around the outlines is a DIFFERENT
    picture, not the same one in another format. They are dropped and named.
  * A gradient or image fill on a text spec: only `type: solid` is carried.

TYPE, AND THE WINDING TRAP THAT ACTUALLY BITES

The em-to-pixel transform is `x*s + ox, oy - y*s`, which FLIPS Y, and a flip
reverses the winding of every contour it touches. Nonzero only cares about the
OPPOSITION of an outer contour and its counter, so flipping the WHOLE figure at
once is harmless and flipping ONE contour is fatal - the counter of an 'o', 'a',
'e' or 'B' stops being a hole and the letter fills solid. Those two cases look
identical in a signed area printed on its own, which is why `imgsvg_test.py`
pins all three states of a real 'B' and a real 'o' from C:/Windows/Fonts: as
extracted (holes), whole figure reversed (still holes, `ok` still true) and one
counter reversed (`solid`, and `ok` false).

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/imgsvg.py catalog
    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/imgsvg.py paths job.json
    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/imgsvg.py text job.json

MEASURED, on this rig on 2026-09-21 (`imgsvg_test.py` takes every number again
on every run and prints them under `-- measured --`):

    ring with a hole      emitted -> reparsed -> rasterised   IoU 1.000000
    same ring, split      the hole fills solid instead        IoU 0.750
    y-flipped on purpose  still 0.478 IoU - a thumbnail passes it
    'B' arial 200px       area vs fontTools' AreaPen          rel 3.1e-15
    'A' arial 200px       outlines vs an 8x unhinted raster   IoU 0.9969,
                          where Pillow's own hinted raster scores 0.9928
    'Bongo' 200px         outlines vs imgtext's raster        IoU 0.9868
    round trip, prec 3    worst vertex move                   0.0002 px
    round trip, prec 0    worst vertex move                   0.4143 px

⚠ THERE IS NO SVG RASTERISER IN THIS VENV (no cairosvg, cairocffi, svglib,
skia or resvg; Pillow does not read SVG), so every number above is imgpath
reading back imgpath's own output: the document parsed with
`xml.etree.ElementTree`, its `d` strings read by imgpath's own SVG parser and
rasterised by imgpath. That proves the geometry, the winding, the subpath
grouping and the fill rule survive the file. It CANNOT prove that an attribute
is spelt the way a renderer reads it, because imgpath never looks at one.

So the spellings are pinned twice more. `imgsvg_test.py` audits every attribute
of every document it emits against a written-down list of SVG 1.1 property
names (and breaks that on purpose), and it WRITES OUT a page - each document
beside imgpath's own raster of it - that a browser can open to do the
comparison this venv cannot. Run in Chrome on 2026-09-21, at a 20x20 block
resolution on a 400x400 canvas:

    asymmetric flag (the y-flip case)       IoU 1.0000, ink ratio 1.0000
    ring with a hole                        IoU 0.9974, centre empty in both
    pentagram nonzero / evenodd             IoU 0.9981 / 0.9968, and the centre
                                            reads ink / empty in both
    an OPEN contour, filled                 IoU 1.0000 - the implicit close
                                            this module relies on is real
    dashed, round caps, open polyline       IoU 0.9946
    miter limit 10 / 1.2                    IoU 0.9986 / 0.9980 - two different
                                            pictures, both matched, which is
                                            what proves stroke-miterlimit
                                            travelled rather than being ignored
    square caps over a translucent fill     IoU 0.9999
    'Bongo' as outlines, no font installed  IoU 0.9946
    the ring split across <path> elements   IoU 0.7494, and its CENTRE READS 1
                                            IN CHROME against 0 here - the hole
                                            trap, confirmed in a renderer that
                                            is not ours

numpy, and imgpath for every piece of geometry. fontTools and Pillow are needed
only by the text half and are imported there, lazily, so `catalog` costs
neither.
"""
# -- WIRING - what server/index.js and server/mcp.js have to do ---------------
#
#   1. Two routes, both pure JSON in, spawned the same way `imgpath.py check`
#      already is - `spawn(config.python, [".../imgsvg.py", <mode>, jobPath])`:
#
#          POST /api/image/svg/paths   { figure|paths|items, out?, width?,
#                                        height?, margin?, title?, desc?, id?,
#                                        background?, precision?, ...paint }
#              -> { ok, svg?, out?, bytes, elements, subpaths, reports,
#                   figureOk, notes }
#
#          POST /api/image/svg/text    { text: <imgtext spec>, out?, ...paint }
#              -> { ok, figure, glyphs, contours, missing, svg?, out?, reports,
#                   figureOk, warnings, notes }
#
#      `out` is a path the ROUTE picks, not the caller: the same
#      `path.join(IMAGE_DIR, name)` + extension guard `/api/images/vectorize`
#      already applies, and `.svg` is already in the set the library serves and
#      trashes (index.js:8481). Omit `out` and the document comes back in the
#      reply as a string instead, which is what the MCP tool wants.
#
#   2. ⚠ `ok` IS THE ENVELOPE AND `figureOk` IS THE VERDICT, and collapsing
#      them was a real bug in this tree this week. A figure whose counter is
#      wound the wrong way EXPORTED FINE - the call worked, the file is on
#      disk, every byte of it is what was asked for - and the figure is still
#      wrong. Return `ok: true` with `figureOk: false` and the sentences out of
#      `reports[i].problems`; a route that maps a bad figure to a 400 teaches a
#      caller to retry a call that will never succeed.
#
#   3. Two MCP tools, beside `image_path_check`:
#
#          image_svg_paths  { name, figure, fill?, stroke?, strokeWidth?,
#                             fillRule?, cap?, join?, dash?, title? }
#          image_svg_text   { name, text, fill?, stroke?, strokeWidth? }
#
#      `name` is the library file name (`*.svg`), everything else is the job.
#      Put `catalog()["traps"]` in both descriptions - an agent that knows a
#      figure with holes is ONE path with several subpaths will write the right
#      figure the first time.
#
#   4. The image store. A document written by either route is a new library
#      file with a parent, exactly as vectorize does it:
#      `imageMeta.set(outName, { ...parent, vectorFrom: srcName, at: ... })`.
#      For a text export there is no parent image, so `vectorFrom` is absent
#      and the row is an original - which is also what the provenance ledger
#      needs it to say, because a title's outlines came out of a FONT FILE and
#      not out of a render.
#
#   5. Errors. `SvgError` is a request that cannot be honoured as written - a
#      figure with no usable contour, a document that would not parse, a
#      precision outside the catalog. Let it reach the caller as
#      `{ ok: false, error }`, the way PathError and ShapeError already do.
# ---------------------------------------------------------------------------
import json
import math
import os
import sys
import xml.etree.ElementTree as ET

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import imgpath                                              # noqa: E402
from imgpath import num, flag, pick, col, arr, geom         # noqa: E402


SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"

# The blend modes CSS can express, hand-written and hand-checked against the
# mix-blend-mode keyword list.
#
# `plus-lighter` is deliberately NOT used for `add`: it exists in CSS
# Compositing 2 and it is not the same arithmetic (it composites premultiplied
# source and backdrop, which differs everywhere alpha is under 1), and the whole
# point of this table is that a near-miss is worse than an absence.
BLEND_CSS = {"normal": None, "multiply": "multiply", "screen": "screen",
             "overlay": "overlay", "softlight": "soft-light",
             "difference": "difference", "darken": "darken",
             "lighten": "lighten", "exclusion": "exclusion"}

_XML_OK = set(range(0x20, 0xD7FF + 1)) | {0x9, 0xA, 0xD} \
    | set(range(0xE000, 0xFFFD + 1)) | set(range(0x10000, 0x10FFFF + 1))

_MAX_COORD = 1e7          # a coordinate past this is a runaway, not a drawing
_MAX_ELEMENTS = 20000     # a document nothing can open is not an export


def _note(msg, notes=None):
    """One honest line about something dropped, sanitised or approximated.

    imgpath's own `_note` with the same contract, except for the tag it puts on
    stderr when no list is passed: a line from this module saying `[imgpath]`
    sends a reader to the wrong file, and the whole value of these lines is that
    somebody can find the code that wrote one."""
    if notes is None:
        print(f"[imgsvg] {msg}", file=sys.stderr)
    else:
        notes.append(msg)


class SvgError(ValueError):
    """A request that cannot be honoured as written: no usable contour, a
    document that would not parse, a font that has no outlines to read.

    Raised rather than half-written. An SVG with one contour missing opens
    perfectly and is wrong in a way nobody sees until it is on a shirt."""


# ---------------------------------------------------------------------------
# the catalog - MCP and the UI are both generated from this
# ---------------------------------------------------------------------------

CATALOG = {}
GROUP_ORDER = ["Export", "Type"]

ALIASES = {
    "export": "paths", "save": "paths", "toSvg": "paths", "tosvg": "paths",
    "svg": "paths", "figure": "paths", "vector": "paths",
    "outlines": "text", "textToPaths": "text", "typeToPaths": "text",
    "glyphs": "text", "convertToOutlines": "text",
}


def words(default, desc, multiline=False):
    p = {"type": "string", "default": default, "animatable": False, "desc": desc}
    if multiline:
        p["multiline"] = True
    return p


def op(name, label, group, why, params, where, **extra):
    entry = {"label": label, "group": group, "why": why, "where": where,
             "params": params}
    entry.update(extra)
    CATALOG[name] = entry
    return entry


# ⚠ BY REFERENCE, NOT BY COPY. Every paint parameter below IS the dict
# imgpath's `draw` op advertises - same default, same range, same sentence - so
# the job that DRAWS a figure and the job that EXPORTS it are one JSON object
# and there is no second place for a default to drift to. `tolerance` comes
# with them because flattening decides the check's polygon and, for a boolean,
# the exported geometry itself.
_DRAW = imgpath.CATALOG["draw"]["params"]
PAINT_KEYS = ("fill", "fillRule", "boolean", "stroke", "strokeWidth", "cap",
              "join", "miterLimit", "dash", "dashOffset", "blend", "tolerance")
PAINT_PARAMS = {k: _DRAW[k] for k in PAINT_KEYS}
# `paths` is one op whose parameters live at TWO levels - the paint belongs to a
# figure and the viewport belongs to the document - and the single-figure job
# writes both in one flat object. So each coercion is told which keys the OTHER
# level owns, and reports everything else. Without that, every export printed
# "ignoring parameter(s) not in the catalog: fill, stroke, ..." about parameters
# it had just honoured, which is the worst kind of note: a true warning channel
# that a reader learns to skip.

DOC_PARAMS = {
    "width": num(0, 0, 100000, "document width in px. 0 measures the figure "
                               "and gives the viewBox the figure's own origin, "
                               "so a shape drawn at x=4000 still opens in "
                               "view", unit="px"),
    "height": num(0, 0, 100000, "document height in px; 0 measures the figure",
                  unit="px"),
    "margin": num(8, 0, 4000, "clear space around an auto-measured document. "
                              "The stroke's own half width is added on top of "
                              "this, because a 40px stroke centred on the "
                              "outline hangs 20px outside the fill's bbox",
                  unit="px"),
    "title": words("", "the <title> element - what a screen reader says and "
                       "what a browser tab shows. Escaped; characters XML 1.0 "
                       "does not allow at all are dropped and reported"),
    "desc": words("", "the <desc> element, for the long version"),
    "id": words("", "the id on the figure's <path>, so a page can style or "
                    "animate it. Sanitised to an XML Name - SVG 1.1 ids are "
                    "NCNames, and a browser will tolerate 'my logo' where a "
                    "validator will not"),
    "background": col("RGBA 0-255 painted as a full-viewport <rect> under "
                      "everything, or null for a transparent document. A "
                      "transparent SVG shown on a white page and on a black "
                      "one is two different pictures, which is the argument "
                      "for setting it"),
    "precision": num(3, 0, 9, "decimals kept on every coordinate. 3 is a "
                              "thousandth of a pixel, which is 200x finer than "
                              "anything this rasterises at and roughly halves "
                              "the file against the 17 digits a float prints",
                     integer=True),
    "out": words("", "absolute path of the .svg to write. Empty returns the "
                     "document in the reply as a string instead, which is what "
                     "an MCP tool wants and what a route without a library "
                     "file name should use"),
    "svg": flag(False, "on the `text` door only: build the document as well as "
                       "the contours. `out` implies it. Left off, `text` hands "
                       "back the figure alone - which is what a caller wants "
                       "when the outlines are going to imgpath.draw, a mask or "
                       "a boolean rather than to a file"),
}

# `id` rides with the FIGURE (it lands on that figure's <path>) and with the
# document when there is only one of them, so it is declared once and appears in
# both sets.
FIGURE_PARAMS = dict(PAINT_PARAMS, id=DOC_PARAMS["id"])

# ⚠ DERIVED FROM THE ENUM A FIGURE'S BLEND IS ACTUALLY COERCED TO, WHICH IS NOT
# imagetools.BLEND_MODES. Two attempts at this list were wrong before it was
# derived: imagetools grew from ten blend modes to twenty-one WHILE THIS FILE
# WAS BEING WRITTEN (a hand-typed list went stale the same afternoon and started
# dropping `exclusion` in silence), and imgpath then turns out to advertise
# TWENTY of those - it drops `dissolve`, because dissolve is a coin toss against
# alpha rather than colour maths and its own docstring says so. So the one list
# that can be right is the one on the parameter itself, and anything not in the
# map above gets the honest note instead of a near-miss.
BLEND_UNMAPPED = tuple(m for m in PAINT_PARAMS["blend"]["options"]
                       if m not in BLEND_CSS)

op("paths", "Figure to SVG", "Export",
   "A pen figure as a file a printer, a browser or Illustrator can open. Takes "
   "the SAME job imgpath.draw takes - paths, fill, fillRule, stroke, width, "
   "cap, join, miterLimit, dash - so exporting a figure is the drawing call "
   "with the mode changed, not a second description of it. A figure with holes "
   "leaves as ONE <path> with several subpaths, which is the only shape of "
   "document in which a counter is a hole.",
   dict(PAINT_PARAMS, **DOC_PARAMS,
        **{"items": {"type": "array", "default": [], "animatable": False,
                     "desc": "several figures in one document, each one a "
                             "whole draw job with its own paint, painted in "
                             "order. Omit it and the job ITSELF is the one "
                             "figure, which is the common case"}}),
   "imgsvg.paths_to_svg(spec) -> {svg, elements, subpaths, reports, figureOk} "
   "- a call, not a field of the job, and it needs no image")

op("text", "Type to Outlines", "Type",
   "A title that survives without the font. Takes the same spec "
   "server/imgtext.py lays out - content, font, size, box, align, tracking, "
   "lineHeight, rotate, skew, text on a path - and returns the GLYPH CONTOURS "
   "as a figure spec, which imgpath.draw can fill, imgpath.check_figure can "
   "check and `paths` can emit. The counters come back as holes wound against "
   "their letters, which is the whole difficulty.",
   dict({"text": {"type": "object", "default": None, "animatable": False,
                  "desc": "the imgtext spec (see imgtext.catalog()['ops']"
                          "['text']). Every LAYOUT key is honoured - the glyph "
                          "positions come from imgtext.layout_text itself, "
                          "kerning and shrink-to-fit included. The DECORATION "
                          "keys (outline, shadow, glow) and any fill that is "
                          "not a solid colour are not carried, and each one is "
                          "named in `notes` rather than silently lost"}},
        **PAINT_PARAMS, **DOC_PARAMS),
   "imgsvg.text_to_outlines(spec) -> {figure, glyphs, contours, missing, "
   "reports, figureOk, warnings}; pass `out` or ask for `svg` and it goes "
   "straight through paths_to_svg")

TRAPS = [
    "A figure with holes is ONE <path> element with several subpaths in its "
    "`d` - 'M..Z M..Z' - and never several <path> elements. Several elements "
    "are several figures under the fill rule, so every hole fills SOLID in "
    "every renderer. Hand the whole list of contours to one call.",

    "A hole is wound AGAINST the contour that encloses it, and nothing in the "
    "file says so - `fill-rule: nonzero` just counts. This module runs "
    "imgpath.check_figure on the way out and puts the report in the reply; "
    "read `figureOk` and `reports[i].problems` rather than assuming a document "
    "that wrote is a document that draws.",

    "Image pixels and SVG user units both run y DOWNWARD, so an export applies "
    "no flip at all. A file that looks upside down was flipped by its author, "
    "not by the format.",

    "fill-rule is written even when it is `nonzero`, which is SVG's default: "
    "the default only holds until the document is pasted into a group that "
    "sets the other one.",

    "Colours are rgb() plus a separate fill-opacity / stroke-opacity, because "
    "SVG 1.1's `fill` has no alpha channel. An exporter that writes rgba() "
    "into `fill` produces a file browsers draw and validators and older "
    "editors do not.",

    "`blend` cannot leave as anything but CSS mix-blend-mode, which Illustrator "
    "and Inkscape ignore on import; `add` and `subtract` have no CSS value at "
    "all and are refused rather than approximated. `boolean` has no SVG "
    "operator and is resolved through imgpath.boolean_paths, which costs about "
    "1/8 px and says so.",

    "Text converted to outlines is GEOMETRY: it no longer has a font, a size "
    "or a string in it, and nothing downstream can re-flow, re-kern or "
    "spell-check it. Export the outlines for the picture and keep the spec for "
    "the edit.",
]
CATALOG["paths"]["traps"] = list(TRAPS)

# A caveat on a parameter whose sentence is imgpath's and therefore cannot say
# this. ⚠ `tolerance` IS THE ONE PARAMETER THAT USUALLY CHANGES NOTHING HERE,
# and a caller who reads only its imgpath sentence ("chord error allowed when a
# curve is flattened") will reasonably expect to be able to turn the smoothness
# of an export up. There is no smoothness to turn up: an export writes the
# CUBICS. Found by the catalog sweep in imgsvg_test.py, which turns every
# advertised knob and demands the document change - and was right to.
CATALOG["paths"]["paramNotes"] = {
    "tolerance": "an export writes the CURVES, so nothing is flattened and this "
                 "changes no byte of an ordinary document - which is the point: "
                 "an export is not a raster and has no resolution. It bites in "
                 "exactly two places. `boolean` other than none has to resolve "
                 "the figure through imgpath.boolean_paths, which flattens; and "
                 "width/height of 0 measure the viewport off the flattened "
                 "figure, where it can move the viewBox by a hundredth of a "
                 "pixel.",
    "boolean": "SVG has no boolean operator. The fill becomes traced geometry "
               "(about 1/8 px, imgpath.boolean_paths' own number) and the "
               "stroke stays on the original contours in a second element, "
               "because that is what imgpath.draw paints.",
    "blend": "leaves as CSS mix-blend-mode, which browsers honour and "
             "Illustrator and Inkscape ignore on import; the modes with no CSS "
             "value are left out and named in `notes`.",
}


def catalog():
    """What MCP and /api/image/catalog serve for the SVG door."""
    out = {
        "ops": CATALOG,
        "groups": GROUP_ORDER,
        "names": sorted(CATALOG),
        "aliases": ALIASES,
        "traps": list(TRAPS),
        "blendCss": {k: v for k, v in BLEND_CSS.items()},
        "blendUnmapped": list(BLEND_UNMAPPED),
        "fillRules": list(imgpath.FILL_RULES),
        "lineCaps": list(imgpath.LINE_CAPS),
        "lineJoins": list(imgpath.LINE_JOINS),
        "typeContract": list(imgpath.TYPE_CONTRACT),
        "notes": [
            "The paint parameters here ARE imgpath's `draw` parameters, taken "
            "from its catalog by reference: the job that draws a figure and "
            "the job that exports it are the same JSON object.",
            "Coordinates are image pixels, y DOWN, and so is SVG user space - "
            "no flip is applied anywhere in this module.",
            "A figure with holes is one <path> with several subpaths. This is "
            "the single correctness rule of the whole file.",
            "Every document is parsed with xml.etree.ElementTree before it is "
            "returned or written; one that does not parse raises SvgError "
            "instead of reaching a disk.",
            "`ok` says the call worked. `figureOk` says the figure has no "
            "problems. A figure whose counter is wound the wrong way exports "
            "perfectly and is still wrong, so those are two fields.",
            "imgpath.check_figure runs on the way out and its report is in the "
            "reply, contour by contour, in full sentences.",
            "There is no SVG rasteriser in this venv, so this module's own "
            "tests measure the file by parsing it back through imgpath's SVG "
            "reader - which proves the geometry and cannot prove a spelling. "
            "imgsvg_test.py also writes out a page that a BROWSER can open to "
            "do the real comparison, and the module docstring carries what "
            "Chrome measured on 2026-09-21 for ten documents including the "
            "hole trap.",
        ],
    }
    try:
        import imgtext
        out["textSpec"] = imgtext.CATALOG["text"]["params"]
    except Exception as exc:                                   # noqa: BLE001
        # A catalog that silently loses half its schema is the §9 failure. Say
        # which import died and let the caller decide whether that matters.
        out["textSpec"] = None
        out["notes"].append(f"the text spec's own parameters are not in this "
                            f"catalog because server/imgtext.py did not import "
                            f"({type(exc).__name__}: {exc}); `text` still "
                            f"works if that import is fixed")
    return out


# ---------------------------------------------------------------------------
# XML, and the characters that end a document
# ---------------------------------------------------------------------------

def escape(text, attr=False, notes=None, where=""):
    """One string, safe in XML content or in an attribute value.

    Two separate jobs, and skipping either writes a file nothing parses:

      * `&`, `<` and `>` become entities (`>` only has to be escaped inside
        `]]>`, but a renderer never minds and a reader never has to check);
        inside an attribute the quotes go too, because the value is delimited
        by one of them.
      * A character XML 1.0 does not ALLOW is dropped, not encoded. There is no
        escape for U+000B: `&#11;` is itself a parse error, and a NUL in a
        title is a document no parser on earth will open. So they are removed
        and the removal is reported - a title that quietly lost a character is
        better than a file that quietly lost everything, and neither should be
        silent.
    """
    s = "" if text is None else str(text)
    kept, dropped = [], 0
    for ch in s:
        if ord(ch) in _XML_OK:
            kept.append(ch)
        else:
            dropped += 1
    if dropped:
        _note(f"{where}dropped {dropped} character(s) XML 1.0 does not "
                      f"allow in a document (a control character has no legal "
                      f"escape, so it cannot be encoded either)", notes)
    out = "".join(kept).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    if attr:
        out = out.replace('"', "&quot;").replace("'", "&apos;")
    return out


_NAME_START = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_")
_NAME_REST = _NAME_START | set("0123456789-.")


def safe_id(raw, notes=None, where=""):
    """An SVG id that a validator accepts, or "" for none.

    SVG 1.1 ids are XML Names: they may not start with a digit and may not
    contain a space, a colon-free rule every browser ignores and every
    validator does not. Sanitising rather than refusing, because an id is a
    convenience and losing the export over one is not a trade anybody wants -
    but the change is reported, since `getElementById('my logo')` in somebody's
    page is going to come back null."""
    s = "" if raw is None else str(raw).strip()
    if not s:
        return ""
    out = []
    for i, ch in enumerate(s):
        ok = (ch in _NAME_START) if not out else (ch in _NAME_REST)
        out.append(ch if ok else "_")
    fixed = "".join(out)
    if fixed != s:
        _note(f"{where}id {s!r} is not an XML Name, so it was written "
                      f"as {fixed!r}; SVG 1.1 ids may not start with a digit "
                      f"or contain a space", notes)
    return fixed


def fmt(v, precision=3):
    """A number as SVG path data wants it: no exponent surprises, no `-0`, and
    no seventeen digits of a float's opinion about 0.1.

    ⚠ ROUNDING IS AN ERROR BUDGET, NOT A TIDY-UP. At precision 3 a coordinate
    can move by half a thousandth of a pixel, and imgsvg_test measures the
    worst vertex move over a real figure rather than asserting it is zero."""
    f = float(v)
    if not math.isfinite(f):
        raise SvgError(f"a coordinate came out {v!r}; an SVG cannot hold a NaN "
                       f"or an infinity, and a renderer that meets one drops "
                       f"the whole path")
    if abs(f) > _MAX_COORD:
        raise SvgError(f"coordinate {f:g} is past {_MAX_COORD:g} px, which is a "
                       f"runaway path rather than a drawing")
    s = f"{f:.{int(precision)}f}"
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return "0" if s in ("", "-", "-0") else s


def _num_attr(v, precision=3):
    return fmt(v, precision)


# ---------------------------------------------------------------------------
# a figure as path data
# ---------------------------------------------------------------------------

_STRAIGHT = 1e-9


def contour_d(bez, precision=3):
    """ONE contour of a figure as one `M ... Z` run of SVG path data.

    A segment whose handles sit on their own anchors IS a straight line, so it
    writes as `L` rather than as a cubic with six numbers - imgpath's own
    `_bez_from_points` builds lines exactly that way, and a traced logo is
    mostly lines. The closing segment of a CLOSED contour is not written at
    all when it is straight: `Z` draws that line itself, and it draws it as a
    JOIN rather than as two caps, which is the difference between a stroked
    rectangle with four corners and one with three corners and a notch.

    An OPEN contour gets no `Z`. SVG closes an open subpath implicitly for
    FILLING and leaves it open for STROKING, which is imgpath's rule verbatim
    ("filling closes a contour whatever the flag says, so it only decides what
    a stroke draws") - so the same flag means the same thing on both sides
    with nothing to translate.
    """
    segs = bez.segments()
    if not segs:
        return ""
    p = fmt
    x0, y0 = float(bez.a[0, 0]), float(bez.a[0, 1])
    parts = [f"M{p(x0, precision)} {p(y0, precision)}"]
    n = len(segs)
    for i, (a0, c1, c2, a1) in enumerate(segs):
        straight = (abs(c1[0] - a0[0]) <= _STRAIGHT and abs(c1[1] - a0[1]) <= _STRAIGHT
                    and abs(c2[0] - a1[0]) <= _STRAIGHT and abs(c2[1] - a1[1]) <= _STRAIGHT)
        if bez.closed and i == n - 1 and straight:
            break                       # Z draws it, and draws it better
        if straight:
            parts.append(f"L{p(a1[0], precision)} {p(a1[1], precision)}")
        else:
            parts.append(f"C{p(c1[0], precision)} {p(c1[1], precision)} "
                         f"{p(c2[0], precision)} {p(c2[1], precision)} "
                         f"{p(a1[0], precision)} {p(a1[1], precision)}")
    if bez.closed:
        parts.append("Z")
    return "".join(parts)


def figure_d(paths, precision=3, notes=None, where=""):
    """A whole figure - every contour of it - as ONE `d` string.

    ⚠ THIS FUNCTION IS THE CORRECTNESS RULE OF THE MODULE. Its return value is
    one attribute of one element, and that is why a counter is a hole. Splitting
    a figure across elements is not a formatting choice, it is a different
    picture: each element is its own figure under the fill rule, so every
    counter fills solid. `imgsvg_test.py` emits the split version on purpose and
    measures the damage.
    """
    runs = []
    empty = 0
    for b in paths:
        d = contour_d(b, precision)
        if d:
            runs.append(d)
        else:
            empty += 1
    if empty:
        _note(f"{where}{empty} contour(s) had fewer than two anchors "
                      f"and wrote nothing", notes)
    return "".join(runs), len(runs)


# ---------------------------------------------------------------------------
# paint
# ---------------------------------------------------------------------------

def _rgb(c):
    """imgpath's RGBA 0..1 float back to `rgb(r, g, b)` and a separate alpha.

    SVG 1.1's `fill` property takes a <color>, which has no alpha in it. The
    alpha is a SEPARATE property, `fill-opacity`, and writing `rgba(...)` into
    `fill` instead gets a file that Chrome draws and that a validator, an older
    Illustrator and half the print RIPs on earth reject or read as black."""
    r, g, b = (int(round(float(v) * 255.0)) for v in c[:3])
    a = float(c[3]) if len(c) > 3 else 1.0
    return f"rgb({max(0, min(255, r))},{max(0, min(255, g))},{max(0, min(255, b))})", a


def _dash_attr(pattern, notes=None, where=""):
    """The dash pattern, normalised the way `imgpath._dash_split` normalises it.

    Same `abs()`, same trailing-zero trim, same "fewer than two entries means
    no dashing" - taken from that function rather than re-decided, because a
    pattern the renderer ignores and the exporter writes (or the other way
    round) is a dashed line in one picture and a solid one in the other. SVG
    repeats an odd-length pattern itself, exactly as imgpath does, so the odd
    list goes out unchanged."""
    pat = [abs(float(x)) for x in (pattern or []) if math.isfinite(float(x))]
    while pat and pat[-1] == 0:
        pat.pop()
    if len(pat) < 2 or sum(pat) <= 1e-6:
        return None
    if any(float(x) < 0 for x in (pattern or [])):
        _note(f"{where}a negative dash length was written out as its "
                      f"absolute value, which is what imgpath draws; SVG would "
                      f"have thrown the whole pattern away and drawn a solid "
                      f"line", notes)
    return pat


def paint_attrs(p, precision=3, notes=None, where=""):
    """The paint half of a `<path>`'s attributes, in a stable order.

    Every name here is an SVG 1.1 property spelt in full. A near miss is not an
    error in SVG - an unknown attribute is ignored in silence - so `linecap`
    for `stroke-linecap` draws butt caps on a design that asked for round ones
    and nothing anywhere says a word."""
    out = []
    if p["fill"] is None:
        out.append(("fill", "none"))
    else:
        colour, alpha = _rgb(p["fill"])
        out.append(("fill", colour))
        if alpha < 1.0:
            out.append(("fill-opacity", fmt(alpha, 4)))
        # ⚠ WRITTEN EVEN WHEN IT IS THE DEFAULT. `nonzero` is SVG's default
        # only until this document is pasted inside a <g fill-rule="evenodd">,
        # and the figure that changes is a logo with a counter in it.
        out.append(("fill-rule", p["fillRule"]))
    if p["stroke"] is not None and p["strokeWidth"] > 0:
        colour, alpha = _rgb(p["stroke"])
        out.append(("stroke", colour))
        if alpha < 1.0:
            out.append(("stroke-opacity", fmt(alpha, 4)))
        out.append(("stroke-width", fmt(p["strokeWidth"], precision)))
        if p["cap"] != "butt":
            out.append(("stroke-linecap", p["cap"]))
        if p["join"] != "miter":
            out.append(("stroke-linejoin", p["join"]))
        if p["join"] == "miter" and abs(p["miterLimit"] - 4.0) > 1e-9:
            # SVG's initial value is 4 and its minimum is 1; imgpath clamps to
            # the same 1, so anything that reaches here is legal.
            out.append(("stroke-miterlimit", fmt(p["miterLimit"], 4)))
        pat = _dash_attr(p["dash"], notes, where)
        if pat:
            out.append(("stroke-dasharray", ",".join(fmt(v, precision) for v in pat)))
            if abs(p["dashOffset"]) > 1e-9:
                out.append(("stroke-dashoffset", fmt(p["dashOffset"], precision)))
    elif p["stroke"] is not None:
        _note(f"{where}a stroke colour was given with strokeWidth 0, so "
                      f"nothing was written - which is what imgpath draws too",
                      notes)
    blend = p.get("blend", "normal")
    if blend != "normal":
        # Written as a lookup with no list of exceptions, so a blend mode added
        # to imagetools tomorrow gets the note rather than the silence.
        css = BLEND_CSS.get(blend)
        if css:
            out.append(("style", f"mix-blend-mode:{css}"))
            _note(f"{where}blend {blend!r} was written as CSS "
                          f"mix-blend-mode, which browsers honour and "
                          f"Illustrator and Inkscape ignore on import", notes)
        else:
            _note(f"{where}blend {blend!r} has no CSS mix-blend-mode "
                          f"value, so it was left out rather than written as "
                          f"something close; the exported figure composites "
                          f"normally", notes)
    return out


def _el(tag, attrs, precision=3, notes=None, where=""):
    bits = [f"<{tag}"]
    for k, v in attrs:
        bits.append(f' {k}="{escape(v, attr=True, notes=notes, where=where)}"')
    bits.append("/>")
    return "".join(bits)


# ---------------------------------------------------------------------------
# the export
# ---------------------------------------------------------------------------

def _bbox_of(groups, tol):
    """The tight bbox of every contour in every group, flattened. None when
    there is nothing with area in any of them."""
    lo = np.array([np.inf, np.inf])
    hi = np.array([-np.inf, -np.inf])
    seen = False
    for paths in groups:
        for q, _ in imgpath.flatten_all(paths, tol, True):
            if len(q) == 0:
                continue
            lo = np.minimum(lo, q.min(axis=0))
            hi = np.maximum(hi, q.max(axis=0))
            seen = True
    return (float(lo[0]), float(lo[1]), float(hi[0]), float(hi[1])) if seen else None


def _selfcheck(svg, notes=None):
    """Parse the document we just built, before anybody else has to.

    ⚠ THE ONE FAILURE THIS MODULE MUST NOT SHIP IS A FILE THAT DOES NOT PARSE.
    Escaping is the usual cause and it is input-driven, so it cannot be pinned
    once and forgotten - a title with an ampersand in it arrives from a user,
    not from a test. So every document goes through a real XML parser on the
    way out, and a failure raises here rather than reaching a disk, a browser
    or a printer."""
    try:
        root = ET.fromstring(svg)
    except ET.ParseError as exc:
        raise SvgError(f"the document this built does not parse as XML "
                       f"({exc}); nothing was written") from exc
    if root.tag != f"{{{SVG_NS}}}svg":
        raise SvgError(f"the root element is {root.tag!r} rather than an SVG "
                       f"svg element")
    els = list(root.iter())
    if len(els) > _MAX_ELEMENTS:
        raise SvgError(f"{len(els)} elements is past the {_MAX_ELEMENTS} this "
                       f"will write; split the figure")
    return {"elements": len(els) - 1,
            "paths": sum(1 for e in els if e.tag == f"{{{SVG_NS}}}path")}


def _one_figure(src, precision, notes, index, ignore=()):
    """One draw job -> (elements, report, subpath count).

    Returns a LIST of elements because one case needs two: a `boolean` that is
    not `none` has no SVG operator, so the FILL is the resolved geometry while
    the STROKE still follows the original contours - which is exactly what
    `imgpath._draw` paints, and painting it any other way here would make the
    export disagree with the render on a figure that draws fine.
    """
    where = f"figure {index}: "
    seen = {k: v for k, v in src.items() if k not in ignore}
    p = imgpath._coerce(FIGURE_PARAMS, seen, where, notes)
    geometry = imgpath._geometry_of(src)
    paths = imgpath._paths_of(geometry, notes, where)
    if not paths:
        raise SvgError(f"figure {index} has no usable contour: a figure is one "
                       f"path or a list of them, and each one needs at least "
                       f"two anchors, points or vertices, or a d string")
    if p["fill"] is None and p["stroke"] is None:
        # imgpath.draw refuses this (spec §6) and so does this: an element with
        # neither fill nor stroke is an invisible path, which is a legal SVG
        # and never what anybody meant to export.
        raise SvgError(f"figure {index} has neither fill nor stroke, so the "
                       f"document would hold an invisible path")

    report = imgpath.check_figure({"paths": geometry, "fillRule": p["fillRule"],
                                   "boolean": p["boolean"]}, None, notes)

    attrs_id = src.get("id")
    els, subpaths = [], 0
    if p["boolean"] != "none":
        polys = imgpath.boolean_paths({"paths": geometry, "mode": p["boolean"],
                                       "tolerance": p["tolerance"]}, notes)
        fill_paths = imgpath._paths_of([{"points": q.tolist(), "closed": True}
                                        for q in polys], notes, where)
        _note(f"{where}boolean {p['boolean']!r} has no SVG operator, so "
                      f"the FILL is the resolved geometry (through imgpath's "
                      f"raster round trip, about 1/8 px) and the STROKE is a "
                      f"second element following the original contours, which "
                      f"is what imgpath.draw paints", notes)
        if p["fill"] is not None:
            d, n = figure_d(fill_paths, precision, notes, where)
            subpaths += n
            fill_only = dict(p, stroke=None)
            a = [("d", d)] + paint_attrs(fill_only, precision, notes, where)
            els.append(("path", a))
        if p["stroke"] is not None and p["strokeWidth"] > 0:
            d, n = figure_d(paths, precision, notes, where)
            subpaths += n
            stroke_only = dict(p, fill=None)
            a = [("d", d)] + paint_attrs(stroke_only, precision, notes, where)
            els.append(("path", a))
    else:
        d, subpaths = figure_d(paths, precision, notes, where)
        if not d:
            raise SvgError(f"figure {index} flattened to no path data at all")
        a = [("d", d)] + paint_attrs(p, precision, notes, where)
        els.append(("path", a))

    if attrs_id and els:
        ident = safe_id(attrs_id, notes, where)
        if ident:
            els[0] = (els[0][0], [("id", ident)] + els[0][1])
    return els, report, subpaths, paths, p


def paths_to_svg(spec, notes=None):
    """A figure - or several - as a standards-valid SVG document.

    Takes the job `imgpath.draw` takes, plus the document keys in `DOC_PARAMS`.
    Returns:

        svg        the document, as a string
        elements   how many elements are in it, the root not counted
        subpaths   how many `M ... Z` runs were written, across all of them
        reports    imgpath.check_figure's report per figure, in order
        figureOk   every report's own `ok`, and-ed
        viewBox    what was written, as [minx, miny, w, h]
        width/height  the document's px size

    ⚠ `figureOk` IS NOT THE CALL'S SUCCESS. A figure with a counter wound the
    wrong way exports perfectly: the call worked, the file is correct SVG, and
    the picture is a solid blob. The two answers are two fields and a caller
    that collapses them either refuses good exports or ships bad figures.
    """
    src = spec if isinstance(spec, dict) else {"paths": spec}
    items = src.get("items")
    many = isinstance(items, (list, tuple)) and bool(items)

    # With `items`, the two levels are separate objects and a paint key left at
    # the top is genuinely unused - so it IS reported. Without it, the one job
    # carries both and neither half may complain about the other's keys.
    body = {k: v for k, v in src.items()
            if k not in ("items", "figure") and (many or k not in FIGURE_PARAMS)}
    doc = imgpath._coerce(DOC_PARAMS, body, "svg: ", notes)
    precision = int(doc["precision"])

    if many:
        jobs, ignore = list(items), ()
    else:
        # ⚠ `figure` IS THE GEOMETRY, NOT THE WHOLE JOB. imgpath's own check
        # door takes {"figure": <spec>}, so a caller writes the paint beside it
        # at the top level - and reading the figure alone threw all of it away
        # and refused the export for having neither fill nor stroke, on a job
        # that plainly had both. Measured: the very first call through the CLI.
        one = {k: v for k, v in src.items() if k != "figure"}
        fig = src.get("figure")
        if isinstance(fig, dict):
            one.update(fig)              # a figure may be a whole draw job
        elif fig is not None:
            one["paths"] = fig
        jobs = [one]
        ignore = tuple(k for k in DOC_PARAMS if k not in FIGURE_PARAMS)

    elements, reports, subpaths, geoms, paints = [], [], 0, [], []
    for i, job in enumerate(jobs):
        job = job if isinstance(job, dict) else {"paths": job}
        els, report, n, paths, p = _one_figure(job, precision, notes, i, ignore)
        elements.extend(els)
        reports.append(report)
        subpaths += n
        geoms.append(paths)
        paints.append(p)

    # -- the viewport. No flip anywhere: image pixels run y down and so does
    # SVG user space, so the identity transform is the correct one and the
    # absence of a transform attribute is the pin.
    w, h = float(doc["width"]), float(doc["height"])
    tol = max(p["tolerance"] for p in paints)
    if w > 0 and h > 0:
        vb = (0.0, 0.0, w, h)
    else:
        box = _bbox_of(geoms, tol)
        if box is None:
            raise SvgError("the figure encloses no area and no width/height was "
                           "given, so there is no viewport to write")
        pad = float(doc["margin"]) + max(
            [0.0] + [p["strokeWidth"] / 2.0 + (p["strokeWidth"] * p["miterLimit"] / 2.0
                                               if p["join"] == "miter" else 0.0)
                     for p in paints if p["stroke"] is not None])
        x0 = math.floor(box[0] - pad)
        y0 = math.floor(box[1] - pad)
        x1 = math.ceil(box[2] + pad)
        y1 = math.ceil(box[3] + pad)
        vb = (x0, y0, max(1.0, x1 - x0), max(1.0, y1 - y0))
        w, h = vb[2], vb[3]
        _note(f"svg: no usable width AND height, so the viewport was "
                      f"measured off the figure: viewBox "
                      f"{fmt(vb[0], 3)} {fmt(vb[1], 3)} {fmt(vb[2], 3)} "
                      f"{fmt(vb[3], 3)} - the figure keeps its own image-pixel "
                      f"coordinates and the viewBox carries the offset", notes)

    head = [f'<svg xmlns="{SVG_NS}" version="1.1"',
            f' width="{fmt(w, precision)}" height="{fmt(h, precision)}"',
            f' viewBox="{fmt(vb[0], precision)} {fmt(vb[1], precision)} '
            f'{fmt(vb[2], precision)} {fmt(vb[3], precision)}">']
    parts = ["".join(head)]
    if doc["title"]:
        parts.append(f"<title>{escape(doc['title'], False, notes, 'svg: title ')}</title>")
    if doc["desc"]:
        parts.append(f"<desc>{escape(doc['desc'], False, notes, 'svg: desc ')}</desc>")
    if doc["background"] is not None:
        colour, alpha = _rgb(doc["background"])
        a = [("x", fmt(vb[0], precision)), ("y", fmt(vb[1], precision)),
             ("width", fmt(vb[2], precision)), ("height", fmt(vb[3], precision)),
             ("fill", colour)]
        if alpha < 1.0:
            a.append(("fill-opacity", fmt(alpha, 4)))
        parts.append(_el("rect", a, precision, notes, "svg: background "))
    for tag, attrs in elements:
        parts.append(_el(tag, attrs, precision, notes, "svg: "))
    parts.append("</svg>")
    svg = "\n".join(parts) + "\n"

    counts = _selfcheck(svg, notes)
    return {"svg": svg, "elements": counts["elements"], "pathElements": counts["paths"],
            "subpaths": subpaths, "reports": reports,
            "figureOk": all(bool(r.get("ok")) for r in reports),
            "viewBox": [vb[0], vb[1], vb[2], vb[3]],
            "width": w, "height": h, "bytes": len(svg.encode("utf-8"))}


# ---------------------------------------------------------------------------
# type as outlines
# ---------------------------------------------------------------------------
#
# ⚠ WHERE THIS CODE SHOULD LIVE, AND WHY IT IS HERE. server/imgtext.py owns the
# font reader and says in its own docstring that "PIL exposes glyph BITMAPS and
# not glyph OUTLINES" - which is still true of that module today: it has
# `_glyph` (a Pillow getmask2 tile) and no pen anywhere. The only glyph walker
# in this tree is `glyph_contours` in server/imgpath_test.py, and that file is a
# SCRIPT - it runs its whole suite at import and calls sys.exit at the end - so
# it cannot be imported by anything. The walk below is that function's algorithm
# and it is pinned against the same exact check that file uses (fontTools'
# AreaPen, closed form on both sides, which is the only test that can see a
# control point written as 0.66 instead of 2/3). If imgtext ever grows a pen,
# delete this and import it; until then there are two copies and this comment is
# the reason, rather than an accident nobody documented.

def glyph_contours(font_path, ch, size, origin, notes=None):
    """One character -> the list of contours imgpath's grammar takes.

    `imgpath.TYPE_CONTRACT`, executed: a DecomposingRecordingPen so a composite
    (an accented letter) arrives as outlines with its component transforms
    applied, TrueType quadratics lifted to cubics EXACTLY (c1 = p0 + 2/3(q-p0),
    which is an identity and not an approximation), implied on-curve points
    restored at the midpoints of consecutive control points, every contour
    closed, and the whole figure scaled and flipped ONCE.

    ⚠ THE FLIP IS THE WHOLE TRAP, AND IT IS THE HARMLESS HALF OF IT. Font units
    are y UP and image pixels are y DOWN, so this applies `x*s + ox, oy - y*s`,
    whose determinant is negative - a reflection, which REVERSES the winding of
    every contour it touches. Nonzero only cares whether a counter is wound
    AGAINST the letter around it, so reversing them all together changes
    nothing: the opposition survives. Reversing ONE - a mirrored component, a
    contour "fixed" by hand, a caller that reordered points - makes that counter
    fill SOLID with no error anywhere. Those two cases are indistinguishable in
    a signed area printed on its own, so `imgsvg_test.py` pins all three states
    of a real 'B' and a real 'o' from this machine's font folder.
    """
    try:
        from fontTools.pens.basePen import decomposeQuadraticSegment
        from fontTools.pens.recordingPen import DecomposingRecordingPen
        from fontTools.ttLib import TTFont
    except ImportError as exc:                                  # noqa: BLE001
        raise SvgError(f"reading letterform geometry needs fontTools, which did "
                       f"not import ({exc}); the raster type tool still works, "
                       f"but there are no outlines without it") from exc

    tt = TTFont(font_path, fontNumber=0)
    cmap = tt.getBestCmap()
    if ord(ch) not in cmap:
        # Not an error: a face without a glyph draws .notdef, and a missing
        # letter that says so beats a box nobody can explain.
        _note(f"glyph {ch!r} (U+{ord(ch):04X}) is not in "
                      f"{os.path.basename(font_path)}, so it has no outline "
                      f"here", notes)
        return []
    upem = float(tt["head"].unitsPerEm)
    gs = tt.getGlyphSet()
    pen = DecomposingRecordingPen(gs)
    gs[cmap[ord(ch)]].draw(pen)
    s = float(size) / upem
    ox, oy = float(origin[0]), float(origin[1])

    def T(pt):
        return (ox + pt[0] * s, oy - pt[1] * s)

    figure, segs, cur, start = [], [], None, None
    for op_, args in pen.value:
        if op_ == "moveTo":
            if segs:
                figure.append(segs)
            segs = []
            cur = start = T(args[0])
        elif op_ == "lineTo":
            p = T(args[0])
            segs.append((cur, cur, p, p))              # a line IS a cubic, exactly
            cur = p
        elif op_ == "curveTo":
            pp = [T(a) for a in args]
            for i in range(0, len(pp) - 2, 2):
                segs.append((cur, pp[i], pp[i + 1], pp[i + 2]))
                cur = pp[i + 2]
        elif op_ == "qCurveTo":
            raw = list(args)
            if raw[-1] is None:
                # A contour of nothing but control points - a TrueType circle is
                # drawn this way - starts at the midpoint of the last and the
                # first, the on-curve point the format leaves implied.
                off = [T(a) for a in raw[:-1]]
                cur = start = ((off[-1][0] + off[0][0]) / 2.0,
                               (off[-1][1] + off[0][1]) / 2.0)
                pp = off + [cur]
            else:
                pp = [T(a) for a in raw]
            for q, on in decomposeQuadraticSegment(tuple(pp)):
                segs.append((cur,
                             (cur[0] + 2.0 / 3.0 * (q[0] - cur[0]),
                              cur[1] + 2.0 / 3.0 * (q[1] - cur[1])),
                             (on[0] + 2.0 / 3.0 * (q[0] - on[0]),
                              on[1] + 2.0 / 3.0 * (q[1] - on[1])), on))
                cur = on
        elif op_ in ("closePath", "endPath"):
            if segs and math.dist(cur, start) > 1e-9:
                segs.append((cur, cur, start, start))
            if segs:
                figure.append(segs)
            segs = []
    if segs:
        figure.append(segs)

    out = []
    for segs in figure:
        anchors = [{"p": [p0[0], p0[1]],
                    "in": [segs[i - 1][2][0] - p0[0], segs[i - 1][2][1] - p0[1]],
                    "out": [c1[0] - p0[0], c1[1] - p0[1]]}
                   for i, (p0, c1, _, _) in enumerate(segs)]
        if len(anchors) < 2:
            # imgpath's grammar drops these and now says so; a real face ships
            # them (glyph u1FAA2 of seguiemj.ttf has one), so they are dropped
            # HERE, where the glyph's name is still in hand.
            _note(f"a contour of {ch!r} has fewer than two anchors and "
                          f"was dropped; it encloses nothing", notes)
            continue
        out.append({"anchors": anchors, "closed": True})
    return out


def _rotate_skew(p):
    """The affine `imgtext._place` applies to a finished block, as arithmetic on
    a POINT instead of on a buffer.

    Derived from that function's own matrix rather than re-invented: it builds
    M for the buffer-local coordinates (u, v) = (X - ox, Y - oy), and expanding
    it collapses the origin terms exactly, leaving a rotate-and-shear about the
    anchor point (box x, box y). imgsvg_test asserts the two agree by comparing
    an outline render against `imgtext.render_text`'s own raster of the same
    rotated spec.

    ⚠ ITS DETERMINANT IS 1 - tan(skewX)tan(skewY), WHICH CAN BE NEGATIVE. Past
    45 degrees of shear in both axes at once the transform is a REFLECTION and
    every contour's winding reverses - together, so the figure survives, for the
    same reason the em-to-pixel flip does. The catalog allows 85 degrees on each
    axis, so this is reachable rather than theoretical, and it is pinned.
    """
    th = math.radians(float(p["rotate"]))
    c, s = math.cos(th), math.sin(th)
    tx = math.tan(math.radians(float(p["skewX"])))
    ty = math.tan(math.radians(float(p["skewY"])))
    a = c - s * ty
    b = c * tx - s
    d = s + c * ty
    e = s * tx + c
    px, py = float(p["box"][0]), float(p["box"][1])
    return a, b, d, e, px, py


def _apply_affine(contours, a, b, d, e, px, py):
    for cont in contours:
        for an in cont["anchors"]:
            x, y = an["p"][0] - px, an["p"][1] - py
            # The handles are RELATIVE, so they take the linear part only - the
            # translation would move each one twice and open every curve.
            for key in ("in", "out"):
                hx, hy = an[key]
                an[key] = [a * hx + b * hy, d * hx + e * hy]
            an["p"] = [a * x + b * y + px, d * x + e * y + py]
    return contours


def _place_on_path(contours, cx, cy, ang):
    """One glyph's contours rotated to a path tangent and dropped at its pen
    point - the same arithmetic `imgtext._path_coverage` warps a glyph TILE
    with, applied to the outline instead. Its M maps tile coordinates offset
    from the pen point; an outline's coordinates already are that offset, so
    the rotation is the whole of it."""
    ca, sa = math.cos(ang), math.sin(ang)
    for cont in contours:
        for an in cont["anchors"]:
            x, y = an["p"]
            for key in ("in", "out"):
                hx, hy = an[key]
                an[key] = [ca * hx - sa * hy, sa * hx + ca * hy]
            an["p"] = [ca * x - sa * y + cx, sa * x + ca * y + cy]
    return contours


def text_to_outlines(spec, notes=None, warnings=None):
    """A text spec -> its glyph contours, as a figure `imgpath.draw` can fill.

    The LAYOUT is imgtext's own: `layout_text` runs, so wrapping, kerning out of
    GPOS, tracking, word spacing, justification, the nine anchors, shrink-to-fit
    and text-on-a-path all behave exactly as they do in a render, and there is
    no second opinion about where a glyph goes. Only the glyph's own geometry is
    read here, out of the font file, because Pillow hands out bitmaps.

    Returns:

        figure     {"paths": [ ...contours... ]} - every glyph of every line in
                   ONE figure, which is what makes the counters holes
        glyphs     [{char, x, baseline, contours, line}], in reading order
        contours   how many contours came out
        missing    characters with no outline (a space, a glyph the face does
                   not have, a control character)
        report     imgpath.check_figure on the whole figure
        holes      the report's hole list, and `solid` its problems
        warnings   imgtext's own - the font that fell back, the axis that was
                   not there

    ⚠ A FACE THAT FELL BACK HAS NO OUTLINES. `imgtext.load_face` answers a
    missing font with Pillow's bundled default and a warning, which is right for
    a render (a headline in the wrong face beats no headline) and impossible
    here: there is no file on disk to read a curve out of. So this raises, with
    imgtext's own sentence about the font attached, rather than handing back an
    empty figure that a caller would write to a file as a blank document.
    """
    try:
        import imgtext
    except ImportError as exc:                                  # noqa: BLE001
        raise SvgError(f"type as outlines needs server/imgtext.py, which did "
                       f"not import ({exc})") from exc

    warnings = warnings if warnings is not None else []
    lay = imgtext.layout_text(spec, warnings)
    p = lay["spec"]
    face = lay["face"]
    if face.path is None:
        raise SvgError(
            f"font {p['font']!r} has no file on this rig to read outlines out "
            f"of, so there is no geometry to export. imgtext says: "
            f"{'; '.join(face.notes) or 'no face was resolved'}")

    size = float(lay["size"])
    on_path = None
    if p["path"]["kind"] != "none":
        on_path = imgtext._build_path(p["path"])
        if on_path is None or on_path.length <= 0:
            _note("text: path.kind is set but the path has no length, "
                          "so the run was laid out straight", notes)
            on_path = None

    glyphs, figure, missing = [], [], []
    if on_path is not None:
        run = [(ch, gx, r["baseline"]) for r in lay["lines"] for ch, gx in r["glyphs"]]
        base = run[0][1] if run else 0.0
        total = (lay["lines"][-1]["penEnd"] - lay["lines"][0]["penStart"]) if run else 0.0
        pp = p["path"]
        start = {"start": 0.0, "center": (on_path.length - total) / 2.0,
                 "end": on_path.length - total}[pp["align"]] + float(pp["offset"])
        flip, side = bool(pp["flip"]), float(pp["side"])
        tracking = float(p["tracking"])
        for idx, (ch, gx, _bl) in enumerate(run):
            if ch == " ":
                missing.append(ch)
                continue
            nxt = run[idx + 1][1] if idx + 1 < len(run) else gx + tracking
            adv = max(0.0, nxt - gx)
            s = start + (gx - base) + adv * 0.5
            if flip:
                s = on_path.length - s
            cx, cy, ang = on_path.at(s)
            if flip:
                ang += math.pi
            ca, sa = math.cos(ang), math.sin(ang)
            cx += -ca * adv * 0.5 - sa * side
            cy += -sa * adv * 0.5 + ca * side
            cont = glyph_contours(face.path, ch, size, (0.0, 0.0), notes)
            if not cont:
                missing.append(ch)
                continue
            cont = _place_on_path(cont, cx, cy, ang)
            glyphs.append({"char": ch, "x": cx, "baseline": cy,
                           "angle": math.degrees(ang), "contours": len(cont),
                           "line": 0})
            figure.extend(cont)
    else:
        for li, row in enumerate(lay["lines"]):
            for ch, gx in row["glyphs"]:
                if ch == " ":
                    missing.append(ch)
                    continue
                cont = glyph_contours(face.path, ch, size, (gx, row["baseline"]), notes)
                if not cont:
                    missing.append(ch)
                    continue
                glyphs.append({"char": ch, "x": gx, "baseline": row["baseline"],
                               "contours": len(cont), "line": li})
                figure.extend(cont)

    moved = imgtext._transformed(p)
    if moved and figure:
        a, b, d, e, px, py = _rotate_skew(p)
        det = a * e - b * d
        _apply_affine(figure, a, b, d, e, px, py)
        if det < 0:
            _note(f"text: rotate/skew has a negative determinant "
                          f"({det:.4f}), so the block is REFLECTED and every "
                          f"contour's winding reversed - together, which is why "
                          f"the counters are still counters", notes)

    # Everything imgtext would have painted that geometry cannot carry, named
    # rather than lost. A caller who asked for a drop shadow and got outlines
    # with no shadow has to be told which of the two happened.
    for key, what in (("outline", "the outline around the glyphs is a raster "
                                  "metric offset in imgtext (a Euclidean, "
                                  "Chebyshev or octagonal ball), and an SVG "
                                  "stroke is a different picture rather than "
                                  "the same one in another format"),
                      ("shadow", "a drop shadow is a blurred raster"),
                      ("glow", "an outer glow is a blurred raster")):
        blk = p.get(key) or {}
        live = blk.get("enabled") if key != "outline" else (blk.get("width", 0) > 0)
        if live:
            _note(f"text: {key} was dropped - {what}. Render it with "
                          f"imgtext.draw_text if you need it, or stroke the "
                          f"exported outlines yourself and accept that it is "
                          f"not the same edge", notes)
    if (p.get("fill") or {}).get("type", "solid") != "solid":
        _note(f"text: fill type {p['fill']['type']!r} was dropped; only "
                      f"a solid colour is carried onto the outlines, a gradient "
                      f"or an image fill would need <linearGradient> or a "
                      f"<pattern> this does not write", notes)

    report = imgpath.check_figure({"paths": figure, "fillRule": "nonzero"},
                                  None, notes)
    return {"figure": {"paths": figure}, "glyphs": glyphs, "contours": len(figure),
            "missing": sorted(set(missing)), "report": report,
            "holes": list(report["holes"]), "solid": list(report["solid"]),
            "figureOk": bool(report["ok"]),
            "size": size, "sizeAsked": float(p["size"]),
            "font": {"asked": p["font"], "path": face.path},
            "onPath": on_path is not None, "transformed": bool(moved),
            "warnings": list(warnings)}


def text_to_svg(spec, notes=None, warnings=None):
    """`text_to_outlines` and then `paths_to_svg`, with the text spec's own
    solid fill carried across when the job does not name one - so the shortest
    possible call ({"text": {...}}) makes a document that looks like the render
    rather than a black figure on nothing."""
    got = text_to_outlines(spec.get("text", spec), notes, warnings)
    job = {k: v for k, v in spec.items() if k != "text"}
    job["paths"] = got["figure"]["paths"]
    if "fill" not in job and "stroke" not in job:
        src = spec.get("text") if isinstance(spec.get("text"), dict) else {}
        fill = (src.get("fill") or {})
        colour = fill.get("color") if isinstance(fill, dict) else None
        if isinstance(colour, (list, tuple)) and len(colour) >= 3:
            # imgtext's fill has its own `opacity`, 0-100, which MULTIPLIES the
            # colour's alpha. Carrying the colour and dropping that would export
            # a 20%-opacity title at full strength - a different picture that
            # looks like a correct one.
            chan = [float(c) for c in list(colour)[:4]]
            if len(chan) == 3:
                chan.append(255.0)
            try:
                chan[3] *= max(0.0, min(100.0, float(fill.get("opacity", 100.0)))) / 100.0
            except (TypeError, ValueError):
                pass
            job["fill"] = chan
        else:
            job["fill"] = [255, 255, 255, 255]
            _note("text: no fill was given on the job or the text spec, "
                          "so the outlines were filled white - which is invisible "
                          "on a white page, and is the default the type tool uses",
                          notes)
    doc = paths_to_svg(job, notes)
    got.update({k: v for k, v in doc.items() if k != "reports"})
    got["reports"] = doc["reports"]
    got["figureOk"] = got["figureOk"] and doc["figureOk"]
    return got


# ---------------------------------------------------------------------------
# the door
# ---------------------------------------------------------------------------

def _write(svg, out):
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(svg)
    return {"out": out, "bytes": len(svg.encode("utf-8"))}


def _reply(payload, notes):
    payload = dict(payload)
    payload["notes"] = notes or None
    return payload


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "catalog"
    if mode == "catalog":
        print(json.dumps(catalog()))
        sys.exit(0)

    mode = ALIASES.get(mode, mode)
    if mode not in ("paths", "text"):
        print(json.dumps({"ok": False, "error": f"unknown mode {mode}"}))
        sys.exit(1)
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error":
                          f"{mode} needs the path of a job file holding "
                          f"{{\"figure\": <spec>}}" if mode == "paths" else
                          f"{mode} needs the path of a job file holding "
                          f"{{\"text\": <spec>}}"}))
        sys.exit(1)

    _notes = []
    try:
        _job = json.loads(open(sys.argv[2], encoding="utf-8").read())
        if not isinstance(_job, dict):
            _job = {"paths": _job}
        _out = _job.get("out") or ""
        if mode == "paths":
            _res = paths_to_svg(_job, _notes)
        else:
            _res = text_to_svg(_job, _notes) if (_out or _job.get("svg")) \
                else text_to_outlines(_job.get("text", _job), _notes)
        _svg = _res.pop("svg", None)
        if _out and _svg:
            _res.update(_write(_svg, _out))
        elif _svg:
            _res["svg"] = _svg
    except Exception as _exc:                                   # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(_exc),
                          "kind": type(_exc).__name__, "notes": _notes or None}))
        sys.exit(1)

    # ⚠ `ok` IS THE ENVELOPE. It says the call worked and the document is
    # written. Whether the FIGURE is what its author meant is `figureOk`, out of
    # check_figure, and a figure with a backwards counter exports perfectly -
    # collapsing the two makes a route refuse a call that succeeded.
    print(json.dumps(_reply(dict({"ok": True}, **_res), _notes)))
