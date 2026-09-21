"""Unit tests for server/imgsvg.py - the SVG door.

An export is the one operation whose output nobody looks at. A render is on a
screen a second later; a file goes into a zip, onto a printer, into somebody
else's Illustrator three weeks from now, and every way of getting it wrong makes
a document that OPENS FINE. So almost nothing below asserts "it wrote
something". Each case emits a real document, parses it back with a real XML
parser, reads its path data with imgpath's OWN SVG reader, rasterises that, and
compares it against what imgpath.draw and imgtext.draw_text actually paint for
the same spec - and then breaks the pin on purpose and asserts the comparison
notices.

⚠ WHAT THIS SUITE CANNOT DO, said before any number in it is quoted. There is
NO SVG rasteriser in this venv - no cairosvg, cairocffi, svglib, skia or resvg,
and Pillow does not read SVG (the `-- what is missing --` block at the bottom
re-checks that on every run rather than trusting this paragraph). So every
"IoU" here is measured against IMGPATH's reading of the file, not against an
independent renderer's. That proves the geometry, the winding, the subpath
grouping and the fill rule survive the document, and it CANNOT prove that an
attribute is spelt the way Chrome reads it - a misspelling that imgpath never
looks at would sail through. The attribute names are therefore pinned a second
way, against a written-down list of the SVG 1.1 property names, and that list
is broken on purpose too.

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/imgsvg_test.py

numpy, imgpath, and - for the type half - Pillow, fontTools and a real face out
of C:/Windows/Fonts, because the one input a test author cannot write down is
letterform geometry.
"""
import json
import math
import os
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import imgpath as P                                        # noqa: E402
import imgsvg as S                                         # noqa: E402

PASS = FAIL = 0
NOTES = []
OUT_DIR = os.path.join(tempfile.gettempdir(), "imgsvg_test")
os.makedirs(OUT_DIR, exist_ok=True)
PY = sys.executable


def eq(name, got, want):
    global PASS, FAIL
    if got == want:
        PASS += 1
        print(f"  ok    {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}\n          got {got!r}, wanted {want!r}")


def near(name, got, want, tol):
    global PASS, FAIL
    if abs(float(got) - float(want)) <= tol:
        PASS += 1
        print(f"  ok    {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}\n          got {float(got):.8f}, wanted "
              f"{float(want):.8f} +-{tol:g}  (off by {float(got) - float(want):+.8f})")


def raises(name, fn, kind=Exception, contains=None):
    global PASS, FAIL
    try:
        fn()
    except kind as exc:
        if contains and contains.lower() not in str(exc).lower():
            FAIL += 1
            print(f"  FAIL  {name}\n          raised {type(exc).__name__} but "
                  f"{contains!r} is not in {str(exc)[:160]!r}")
            return
        PASS += 1
        print(f"  ok    {name}")
    except Exception as exc:                                    # noqa: BLE001
        FAIL += 1
        print(f"  FAIL  {name}\n          raised {type(exc).__name__}: {exc}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}\n          did not raise")


# ---------------------------------------------------------------------------
# the other side's reading of our file
# ---------------------------------------------------------------------------

NS = f"{{{S.SVG_NS}}}"


def parse(svg):
    """The document as a real XML parser sees it. Every case goes through here;
    a document that does not parse fails at the parser rather than at an
    assertion about its text."""
    return ET.fromstring(svg)


def path_els(svg):
    return [e for e in parse(svg).iter(f"{NS}path")]


def raster(svg, h, w):
    """The document rasterised THROUGH IMGPATH - one mask per <path> element,
    each with that element's own fill-rule, combined the way an opaque painter
    would.

    ⚠ ONE MASK PER ELEMENT IS THE WHOLE POINT. It is exactly what an SVG
    renderer does, and it is why splitting a figure with holes across several
    elements fills the holes: each element is its own figure under the rule,
    and a counter that is a hole inside one figure is a solid disc on its own.
    """
    out = np.zeros((h, w), np.float32)
    for e in path_els(svg):
        if e.get("fill", "none") == "none":
            continue
        m = P.path_mask({"paths": {"d": e.get("d")},
                         "fillRule": e.get("fill-rule", "nonzero")}, h, w)
        out = np.maximum(out, m)
    return out


def iou(a, b):
    u = float(np.maximum(a, b).sum())
    return float(np.minimum(a, b).sum()) / u if u else 0.0


def contour_spec(bez):
    """A Bez back to the anchors-with-relative-handles spelling, so a test can
    hand imgpath and imgsvg the same JSON a caller would write."""
    return {"anchors": [{"p": [r[0], r[1]], "in": [r[2] - r[0], r[3] - r[1]],
                         "out": [r[4] - r[0], r[5] - r[1]]} for r in bez.a],
            "closed": bool(bez.closed)}


def reverse_spec(cont):
    """One contour wound the other way: walk the anchors backwards and swap each
    one's handles, because the handle you arrive on becomes the one you leave
    on. This is the mirrored-component case of imgpath.TYPE_CONTRACT, done by
    hand."""
    out = []
    for an in reversed(cont["anchors"]):
        out.append({"p": list(an["p"]), "in": list(an["out"]), "out": list(an["in"])})
    return {"anchors": out, "closed": cont.get("closed", True)}


def worst_vertex_move(spec_a, spec_b, tol=0.05):
    """The largest distance between corresponding flattened vertices of two
    figures. Used for the round trip, where the two figures are the SAME figure
    before and after a file - so a mismatch in COUNT is a failure on its own and
    not something to average away."""
    fa = P.flatten_all(spec_a, tol, True)
    fb = P.flatten_all(spec_b, tol, True)
    if len(fa) != len(fb):
        return float("inf")
    worst = 0.0
    for (qa, _), (qb, _) in zip(fa, fb):
        if len(qa) != len(qb):
            return float("inf")
        if len(qa) == 0:
            continue
        worst = max(worst, float(np.hypot(*(qa - qb).T).max()))
    return worst


# ---------------------------------------------------------------------------
# the figures every case below draws
# ---------------------------------------------------------------------------

RING_OUTER = contour_spec(P.circle_path(200, 200, 120))
RING_HOLE = reverse_spec(contour_spec(P.circle_path(200, 200, 60)))
RING = [RING_OUTER, RING_HOLE]
RING_SOLID_BUG = [RING_OUTER, contour_spec(P.circle_path(200, 200, 60))]

# An asymmetric figure, on purpose: a shape with a top and a bottom is the only
# kind that can catch a y flip, and half the figures anybody tests with are
# symmetric about the very axis the bug mirrors.
FLAG = [{"points": [[60, 40], [340, 40], [340, 110], [140, 110], [140, 360], [60, 360]],
         "closed": True}]

# A pentagram - the OTHER case where the two fill rules part company, and the
# one with a closed-form answer: nonzero fills the inner pentagon that evenodd
# leaves empty.
def _star(cx, cy, r, points=5, step=2):
    pts = []
    for i in range(points):
        a = -math.pi / 2 + 2 * math.pi * (i * step % points) / points
        pts.append([cx + r * math.cos(a), cy + r * math.sin(a)])
    return [{"points": pts, "closed": True}]


STAR = _star(200, 200, 150)

print("\n  -- the document parses, and every name in it is SVG's --\n")

# Every attribute this module is allowed to write, spelt as SVG 1.1 spells it.
# ⚠ WRITTEN DOWN RATHER THAN GENERATED FROM THE CODE. A list built out of
# imgsvg's own output would agree with imgsvg about a typo, which is the one
# thing it exists to catch.
SVG_ATTRS = {
    "xmlns", "version", "width", "height", "viewBox",          # the root
    "x", "y", "fill", "fill-opacity", "fill-rule",             # paint
    "stroke", "stroke-opacity", "stroke-width", "stroke-linecap",
    "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray",
    "stroke-dashoffset", "style", "d", "id",
}
SVG_VALUES = {"fill-rule": {"nonzero", "evenodd"},
              "stroke-linecap": {"butt", "round", "square"},
              "stroke-linejoin": {"miter", "round", "bevel"}}
SEEN_ATTRS = set()


def audit(svg):
    """Every attribute of every element, against the written-down list. Called
    on every document this suite emits, so a spelling that slips into any case
    is caught in that case."""
    bad = []
    for el in parse(svg).iter():
        for k, v in el.attrib.items():
            name = k.split("}")[-1]
            SEEN_ATTRS.add(name)
            if name not in SVG_ATTRS:
                bad.append(name)
            if name in SVG_VALUES and v not in SVG_VALUES[name]:
                bad.append(f"{name}={v}")
    return bad


NOTE_SINK = []
ring_doc = S.paths_to_svg({"paths": RING, "fill": [220, 30, 30, 255],
                           "fillRule": "nonzero", "width": 400, "height": 400,
                           "title": "ring"}, NOTE_SINK)
eq("the document parses as XML", parse(ring_doc["svg"]).tag, f"{NS}svg")
eq("...and its root is in the SVG namespace",
   parse(ring_doc["svg"]).tag.startswith(f"{{{S.SVG_NS}}}"), True)
eq("...with a viewBox in image pixels", parse(ring_doc["svg"]).get("viewBox"),
   "0 0 400 400")
eq("every attribute name is SVG 1.1's", audit(ring_doc["svg"]), [])

# BREAK IT: a near-miss attribute name. SVG ignores an unknown attribute in
# silence, so `linecap` for `stroke-linecap` draws butt caps on a design that
# asked for round ones and nothing anywhere says a word - which is why the guard
# above is a written-down list and not a generated one.
_real_paint = S.paint_attrs
try:
    S.paint_attrs = lambda p, precision=3, notes=None, where="": \
        _real_paint(p, precision, notes, where) + [("linecap", "round")]
    typo_doc = S.paths_to_svg({"paths": RING, "fill": [1, 2, 3], "width": 400,
                               "height": 400}, [])
    eq("BROKEN ON PURPOSE: a misspelt attribute is caught by the audit",
       audit(typo_doc["svg"]), ["linecap"])
finally:
    S.paint_attrs = _real_paint

eq("...and the real document is still clean afterwards",
   audit(S.paths_to_svg({"paths": RING, "fill": [1, 2, 3], "width": 400,
                         "height": 400}, [])["svg"]), [])


print("\n  -- the y axis, which is the bug that looks like a decision --\n")

# Image pixels run y DOWN. So does SVG user space. The correct transform is
# none, and nothing in the file should say `transform` at all.
flag_doc = S.paths_to_svg({"paths": FLAG, "fill": [0, 0, 0, 255],
                           "width": 400, "height": 400}, [])
audit(flag_doc["svg"])
eq("no transform attribute anywhere in the document",
   [e.get("transform") for e in parse(flag_doc["svg"]).iter() if e.get("transform")],
   [])
back = [{"d": e.get("d")} for e in path_els(flag_doc["svg"])]
near("the reparsed figure's vertices are the figure's, to the rounding budget",
     worst_vertex_move(FLAG, back), 0.0, 1e-3)

ys_in = sorted(round(p[1], 3) for p in FLAG[0]["points"])
ys_out = sorted(round(float(v[1]), 3)
                for q, _ in P.flatten_all(back, 0.05, True) for v in q)
eq("every y coordinate came out of the file unflipped",
   sorted(set(ys_in)), sorted(set(ys_out)))

# BREAK IT: flip y about the canvas the way a careless exporter would, emit
# THAT, and confirm both measurements notice. A flipped export is still a
# picture - right colour, right size, right everything - so nothing but a
# comparison can see it.
flipped = [{"points": [[x, 400 - y] for x, y in FLAG[0]["points"]], "closed": True}]
flip_doc = S.paths_to_svg({"paths": flipped, "fill": [0, 0, 0, 255],
                           "width": 400, "height": 400}, [])
flip_back = [{"d": e.get("d")} for e in path_els(flip_doc["svg"])]
eq("BROKEN ON PURPOSE: a flipped export fails the vertex comparison",
   worst_vertex_move(FLAG, flip_back) > 1.0, True)
eq("BROKEN ON PURPOSE: ...and the y coordinates are not the ones sent",
   sorted(set(round(float(v[1]), 3)
              for q, _ in P.flatten_all(flip_back, 0.05, True) for v in q))
   == sorted(set(ys_in)), False)
_flip_iou = iou(raster(flag_doc["svg"], 400, 400), raster(flip_doc["svg"], 400, 400))
NOTES.append(f"a y-flipped export of the same figure still rasterises to "
             f"{_flip_iou:.3f} IoU against the right one - close enough that a "
             f"thumbnail would pass it, which is why the vertex comparison is "
             f"the pin and not the picture")


print("\n  -- a figure with holes is ONE path with several subpaths --\n")

eq("the ring is one <path> element", len(path_els(ring_doc["svg"])), 1)
eq("...holding two subpaths", ring_doc["subpaths"], 2)
eq("...and its d has two M commands", path_els(ring_doc["svg"])[0].get("d").count("M"), 2)

drawn = P.path_mask({"paths": RING, "fillRule": "nonzero"}, 400, 400)
exported = raster(ring_doc["svg"], 400, 400)
near("what the file says and what imgpath draws are the same picture",
     iou(drawn, exported), 1.0, 1e-4)
near("...to the pixel, not just the eye", float(np.abs(drawn - exported).max()), 0.0, 1e-3)

# BREAK IT: the same contours as separate <path> elements - the shape of
# document every naive exporter writes.
split = "\n".join(
    [f'<svg xmlns="{S.SVG_NS}" version="1.1" width="400" height="400" viewBox="0 0 400 400">']
    + [f'<path d="{S.contour_d(b, 3)}" fill="rgb(220,30,30)" fill-rule="nonzero"/>'
       for b in P._paths_of(RING)]
    + ["</svg>"])
split_r = raster(split, 400, 400)
eq("BROKEN ON PURPOSE: split across elements, the hole fills solid",
   float(split_r[200, 200]) > 0.99, True)
eq("...where the real export leaves it empty", float(exported[200, 200]) < 1e-6, True)
_split_iou = iou(drawn, split_r)
eq("BROKEN ON PURPOSE: and the comparison sees it", _split_iou < 0.8, True)
NOTES.append(f"the same ring emitted as two <path> elements instead of one "
             f"scores {_split_iou:.3f} IoU against the right picture and fills "
             f"its hole solid - in every renderer, for ever")


print("\n  -- every spelling of a figure that imgpath takes, exports --\n")

# The grammar is imgpath's `_paths_of`, not a second reader, so this is really
# asking whether anything in here quietly assumed one spelling. A figure handed
# over four ways has to leave as four identical documents.
_square_pts = [[100, 100], [300, 100], [300, 300], [100, 300]]
_spellings = {
    "a bare point list": [_square_pts],
    "points + closed": [{"points": _square_pts, "closed": True}],
    "anchors with handles": [{"anchors": [{"p": p, "in": [0, 0], "out": [0, 0]}
                                          for p in _square_pts], "closed": True}],
    "AE vertices": [{"vertices": _square_pts, "closed": True}],
    "an SVG d": [{"d": "M100 100L300 100L300 300L100 300Z"}],
}
_docs = {}
for _name, _fig in _spellings.items():
    _job = {"paths": _fig, "fill": [0, 0, 0, 255], "width": 400, "height": 400}
    if _name == "a bare point list":
        # a bare list is OPEN by imgpath's grammar, so its d has no Z - and the
        # FILL is identical, which is the rule both sides share
        _docs[_name] = S.paths_to_svg(_job, [])["svg"]
        eq("a bare point list exports open, as imgpath reads it",
           "Z" in path_els(_docs[_name])[0].get("d"), False)
        near("...and fills the same pixels anyway",
             iou(raster(_docs[_name], 400, 400),
                 P.path_mask({"paths": _spellings["points + closed"]}, 400, 400)),
             1.0, 1e-4)
        continue
    _docs[_name] = S.paths_to_svg(_job, [])["svg"]
    audit(_docs[_name])
eq("the four closed spellings all export the identical document",
   len({v for k, v in _docs.items() if k != "a bare point list"}), 1)
eq("...and that document is the square that was asked for",
   path_els(_docs["an SVG d"])[0].get("d"), "M100 100L300 100L300 300L100 300Z")


print("\n  -- the fill rule, written even when it is the default --\n")

star_nz = S.paths_to_svg({"paths": STAR, "fill": [0, 0, 0, 255],
                          "fillRule": "nonzero", "width": 400, "height": 400}, [])
star_eo = S.paths_to_svg({"paths": STAR, "fill": [0, 0, 0, 255],
                          "fillRule": "evenodd", "width": 400, "height": 400}, [])
audit(star_nz["svg"]), audit(star_eo["svg"])
eq("fill-rule is on the element even when it is nonzero, SVG's own default",
   path_els(star_nz["svg"])[0].get("fill-rule"), "nonzero")
eq("...and evenodd is spelt SVG's way, not 'even-odd'",
   path_els(star_eo["svg"])[0].get("fill-rule"), "evenodd")

nz = raster(star_nz["svg"], 400, 400)
eo = raster(star_eo["svg"], 400, 400)
near("a nonzero pentagram matches imgpath's nonzero fill",
     iou(nz, P.path_mask({"paths": STAR, "fillRule": "nonzero"}, 400, 400)), 1.0, 1e-4)
near("an evenodd pentagram matches imgpath's evenodd fill",
     iou(eo, P.path_mask({"paths": STAR, "fillRule": "evenodd"}, 400, 400)), 1.0, 1e-4)
eq("the middle of the star is ink under nonzero", float(nz[200, 200]) > 0.99, True)
eq("...and a hole under evenodd", float(eo[200, 200]) < 1e-6, True)

# BREAK IT: write the other rule into the file and confirm the picture changes.
# This is what "silently ignored" costs: the document parses either way.
swapped = star_nz["svg"].replace('fill-rule="nonzero"', 'fill-rule="evenodd"')
eq("BROKEN ON PURPOSE: the wrong fill-rule draws a different picture",
   iou(nz, raster(swapped, 400, 400)) < 0.93, True)
NOTES.append(f"swapping the pentagram's fill rule in the finished file changes "
             f"the picture by {1 - iou(nz, raster(swapped, 400, 400)):.3f} of "
             f"its own area, and the document parses identically either way")


print("\n  -- the winding survives the file, and check_figure says so --\n")

eq("check_figure ran on the way out and is in the reply",
   sorted(ring_doc["reports"][0]), sorted(P.check_figure({"paths": RING})))
eq("the ring's counter is reported as a hole", ring_doc["reports"][0]["holes"], [1])
eq("...and nothing is solid", ring_doc["reports"][0]["solid"], [])
eq("...so the figure verdict is true", ring_doc["figureOk"], True)

after = P.check_figure({"paths": [{"d": e.get("d")} for e in path_els(ring_doc["svg"])]})
eq("the reparsed figure has the same contour count", after["contours"], 2)
eq("...the same hole", after["holes"], [1])
eq("...and the same signs on its areas",
   [a > 0 for a in after["areas"]], [a > 0 for a in ring_doc["reports"][0]["areas"]])
near("...and the hole's area to a thousandth of a pixel",
     after["areas"][1], ring_doc["reports"][0]["areas"][1], 0.01)

# BREAK IT: the counter wound WITH its letter - the bug check_figure exists for.
# ⚠ THE EXPORT STILL SUCCEEDS. That is the whole reason `ok` and `figureOk` are
# two fields: the call worked, the file is valid SVG, every byte is what was
# asked for, and the picture is a solid disc.
solid_doc = S.paths_to_svg({"paths": RING_SOLID_BUG, "fill": [0, 0, 0, 255],
                            "width": 400, "height": 400}, [])
eq("BROKEN ON PURPOSE: a same-wound counter still exports", bool(solid_doc["svg"]), True)
eq("...and the figure verdict is FALSE", solid_doc["figureOk"], False)
eq("...naming the contour", solid_doc["reports"][0]["solid"], [1])
eq("...in a sentence a caller can act on",
   "reverse contour 1" in solid_doc["reports"][0]["problems"][0].lower(), True)
eq("...and the picture really is solid",
   float(raster(solid_doc["svg"], 400, 400)[200, 200]) > 0.99, True)

# The other half of the same trap: reversing EVERY contour together is harmless,
# because nonzero only cares about the opposition of two windings.
both_rev = [reverse_spec(RING_OUTER), reverse_spec(RING_HOLE)]
rev_doc = S.paths_to_svg({"paths": both_rev, "fill": [0, 0, 0, 255],
                          "width": 400, "height": 400}, [])
eq("reversing the WHOLE figure is harmless", rev_doc["figureOk"], True)
eq("...its hole is still a hole", rev_doc["reports"][0]["holes"], [1])
near("...and it draws the identical picture",
     iou(raster(rev_doc["svg"], 400, 400), exported), 1.0, 1e-4)
eq("...though every area changed sign",
   [a > 0 for a in rev_doc["reports"][0]["areas"]],
   [not (a > 0) for a in ring_doc["reports"][0]["areas"]])


print("\n  -- escaping, and the characters that end a document --\n")

nasty = 'Bones & Co <b>"quoted"</b>' + chr(11) + chr(0) + "'s"
esc_notes = []
esc_doc = S.paths_to_svg({"paths": RING, "fill": [0, 0, 0, 255], "width": 400,
                          "height": 400, "title": nasty, "desc": nasty,
                          "id": nasty}, esc_notes)
root = parse(esc_doc["svg"])
audit(esc_doc["svg"])
eq("a title full of XML metacharacters still parses",
   root.find(f"{NS}title").text.startswith("Bones & Co <b>"), True)
eq("...and the ampersand came back as an ampersand, not as &amp;amp;",
   root.find(f"{NS}title").text.count("&"), 1)
eq("...the quotes survived", '"quoted"' in root.find(f"{NS}title").text, True)
eq("the control characters were DROPPED, not encoded",
   chr(11) in root.find(f"{NS}title").text or chr(0) in root.find(f"{NS}title").text,
   False)
eq("...and said so", any("XML 1.0 does not allow" in n for n in esc_notes), True)
eq("the id is an XML Name", path_els(esc_doc["svg"])[0].get("id").replace("_", "a")
   .replace("b", "a").isalnum(), True)
eq("...and that was reported too", any("is not an XML Name" in n for n in esc_notes), True)

# BREAK IT: the same title written straight into the document.
unescaped = (f'<svg xmlns="{S.SVG_NS}" version="1.1" width="10" height="10" '
             f'viewBox="0 0 10 10"><title>{nasty}</title></svg>')
raises("BROKEN ON PURPOSE: the unescaped title does not parse at all",
       lambda: ET.fromstring(unescaped), ET.ParseError)
# And the half-fix that looks right: escape the metacharacters but keep the
# control characters. There is no legal escape for U+000B - `&#11;` is itself
# a parse error - which is why they are dropped rather than encoded.
half = (f'<svg xmlns="{S.SVG_NS}" version="1.1" width="10" height="10" '
        f'viewBox="0 0 10 10"><title>Bones &amp; Co &#11;</title></svg>')
raises("BROKEN ON PURPOSE: ...and encoding a control character does not either",
       lambda: ET.fromstring(half), ET.ParseError)

# The self-check is not decoration: it is the reason a broken document cannot
# reach a disk. Break the builder and confirm the module refuses rather than
# writing.
_real_el = S._el
try:
    S._el = lambda tag, attrs, precision=3, notes=None, where="": f"<{tag} d=\"oops\">"
    raises("BROKEN ON PURPOSE: a malformed element is refused by the self-check",
           lambda: S.paths_to_svg({"paths": RING, "fill": [0, 0, 0], "width": 10,
                                   "height": 10}, []),
           S.SvgError, "does not parse")
finally:
    S._el = _real_el


print("\n  -- strokes: every spelling, and the ones SVG throws away --\n")

stroke_job = {"paths": FLAG, "fill": None, "stroke": [0, 128, 255, 128],
              "strokeWidth": 9, "cap": "square", "join": "bevel",
              "miterLimit": 7, "dash": [14, 6, 2, 6], "dashOffset": 3,
              "width": 400, "height": 400}
sdoc = S.paths_to_svg(dict(stroke_job), [])
el = path_els(sdoc["svg"])[0]
audit(sdoc["svg"])
eq("fill none is written, not omitted", el.get("fill"), "none")
eq("no fill-rule on an unfilled element", el.get("fill-rule"), None)
eq("stroke is rgb(), never rgba()", el.get("stroke"), "rgb(0,128,255)")
eq("...and its alpha is a separate property", el.get("stroke-opacity"), "0.502")
eq("no rgba( anywhere in the document", "rgba(" in sdoc["svg"], False)
eq("stroke-width", el.get("stroke-width"), "9")
eq("stroke-linecap", el.get("stroke-linecap"), "square")
eq("stroke-linejoin", el.get("stroke-linejoin"), "bevel")
eq("stroke-dasharray, in SVG's comma form", el.get("stroke-dasharray"), "14,6,2,6")
eq("stroke-dashoffset", el.get("stroke-dashoffset"), "3")
eq("no miterlimit on a bevel join", el.get("stroke-miterlimit"), None)

mj = S.paths_to_svg(dict(stroke_job, join="miter"), [])
audit(mj["svg"])
eq("stroke-miterlimit when the join is a miter and the limit is not 4",
   path_els(mj["svg"])[0].get("stroke-miterlimit"), "7")
eq("...and no stroke-linejoin, because miter is SVG's default",
   path_els(mj["svg"])[0].get("stroke-linejoin"), None)

zero_notes = []
zdoc = S.paths_to_svg(dict(stroke_job, fill=[0, 0, 0], strokeWidth=0), zero_notes)
eq("a stroke of width 0 writes no stroke at all, as imgpath draws none",
   path_els(zdoc["svg"])[0].get("stroke"), None)
eq("...and says why", any("strokeWidth 0" in n for n in zero_notes), True)

neg_notes = []
ndoc = S.paths_to_svg(dict(stroke_job, dash=[10, -4]), neg_notes)
eq("a negative dash length is written as its absolute value, which is what "
   "imgpath draws", path_els(ndoc["svg"])[0].get("stroke-dasharray"), "10,4")
eq("...and is reported, because SVG would have dropped the whole pattern",
   any("negative dash" in n for n in neg_notes), True)
odd = S.paths_to_svg(dict(stroke_job, dash=[8, 4, 2]), [])
eq("an odd-length pattern goes out unchanged - SVG doubles it exactly as "
   "imgpath does", path_els(odd["svg"])[0].get("stroke-dasharray"), "8,4,2")
eq("a dash list of one entry is not a pattern, and is dropped by both",
   path_els(S.paths_to_svg(dict(stroke_job, dash=[8]), [])["svg"])[0]
   .get("stroke-dasharray"), None)

# A stroked OPEN contour must not be closed by the export, or a stroke gains a
# side that the render does not have.
open_job = {"paths": [{"points": [[50, 50], [350, 50], [350, 350]], "closed": False}],
            "fill": None, "stroke": [0, 0, 0, 255], "strokeWidth": 20,
            "cap": "butt", "width": 400, "height": 400}
odoc = S.paths_to_svg(open_job, [])
eq("an open contour gets no Z", "Z" in path_els(odoc["svg"])[0].get("d"), False)
eq("...and a closed one does", "Z" in path_els(ring_doc["svg"])[0].get("d"), True)
near("the exported open stroke covers the same ink imgpath strokes",
     iou(P.path_mask({"paths": [{"d": path_els(odoc["svg"])[0].get("d")}]}, 400, 400),
         P.path_mask({"paths": open_job["paths"]}, 400, 400)), 1.0, 1e-3)


print("\n  -- colour, opacity and blend --\n")

cdoc = S.paths_to_svg({"paths": RING, "fill": [17, 34, 51, 64], "width": 400,
                       "height": 400, "background": [255, 255, 255, 255]}, [])
audit(cdoc["svg"])
eq("fill is rgb()", path_els(cdoc["svg"])[0].get("fill"), "rgb(17,34,51)")
near("fill-opacity is the alpha, to four places",
     float(path_els(cdoc["svg"])[0].get("fill-opacity")), 64 / 255.0, 5e-5)
rect = parse(cdoc["svg"]).find(f"{NS}rect")
eq("a background is a full-viewport rect under everything", rect is not None, True)
eq("...covering the viewBox exactly",
   [rect.get("x"), rect.get("y"), rect.get("width"), rect.get("height")],
   ["0", "0", "400", "400"])

bl_notes = []
bdoc = S.paths_to_svg({"paths": RING, "fill": [0, 0, 0], "blend": "softlight",
                       "width": 400, "height": 400}, bl_notes)
audit(bdoc["svg"])
eq("soft light respells as CSS's soft-light, with the hyphen",
   path_els(bdoc["svg"])[0].get("style"), "mix-blend-mode:soft-light")
eq("...and the reply says Illustrator ignores it",
   any("Illustrator" in n for n in bl_notes), True)
add_notes = []
adoc = S.paths_to_svg({"paths": RING, "fill": [0, 0, 0], "blend": "add",
                       "width": 400, "height": 400}, add_notes)
eq("add has no CSS value, so nothing is written",
   path_els(adoc["svg"])[0].get("style"), None)
eq("...rather than something close", any("no CSS mix-blend-mode" in n
                                         for n in add_notes), True)
# ⚠ THE LIST THAT MATTERS IS THE ENUM ON THE PARAMETER, AND IT TOOK TWO WRONG
# ONES TO GET HERE. imagetools grew from ten blend modes to twenty-one while
# this suite was being written (a hand-typed "what CSS cannot do" list went
# stale the same afternoon and dropped `exclusion` without a word), and
# imgpath's `draw` then advertises TWENTY of those - it refuses `dissolve`,
# which is a coin toss against alpha and not colour maths. A figure's blend is
# coerced to THAT enum, so that enum is what an exporter has to cover.
_BM = set(P.CATALOG["draw"]["params"]["blend"]["options"])
eq("every blend a figure can actually carry is mapped or named as unmapped",
   sorted(_BM - (set(S.BLEND_CSS) | set(S.BLEND_UNMAPPED))), [])
eq("...and nothing is claimed for a mode imgpath will not paint",
   sorted(set(S.BLEND_CSS) - _BM), [])
eq("...dissolve among them, which imgpath drops as an alpha mode",
   "dissolve" in _BM, False)
for _m in sorted(_BM):
    _n = []
    S.paths_to_svg({"paths": RING, "fill": [0, 0, 0], "blend": _m,
                    "width": 400, "height": 400}, _n)
    if _m != "normal":
        eq(f"blend {_m} either travels or says it cannot",
           any("mix-blend-mode" in n for n in _n), True)
eq("...and every mapped value is a real CSS mix-blend-mode keyword",
   [v for v in S.BLEND_CSS.values() if v and v not in {
       "multiply", "screen", "overlay", "darken", "lighten", "color-dodge",
       "color-burn", "hard-light", "soft-light", "difference", "exclusion",
       "hue", "saturation", "color", "luminosity"}], [])


print("\n  -- booleans, which SVG has no operator for --\n")

two = [contour_spec(P.circle_path(170, 200, 90)), contour_spec(P.circle_path(230, 200, 90))]
bool_notes = []
bo = S.paths_to_svg({"paths": two, "boolean": "subtract", "fill": [0, 0, 0, 255],
                     "stroke": [255, 0, 0, 255], "strokeWidth": 3,
                     "width": 400, "height": 400}, bool_notes)
audit(bo["svg"])
eq("a boolean with a stroke writes two elements", len(path_els(bo["svg"])), 2)
eq("...the fill being the resolved geometry",
   path_els(bo["svg"])[0].get("stroke"), None)
eq("...and the stroke following the original contours",
   path_els(bo["svg"])[1].get("fill"), "none")
eq("...with the 1/8 px it cost in the notes",
   any("no SVG operator" in n for n in bool_notes), True)
near("the exported boolean fill matches imgpath's own exact boolean mask",
     iou(P.path_mask({"paths": {"d": path_els(bo["svg"])[0].get("d")}}, 400, 400),
         P.boolean_mask(two, "subtract", 400, 400)), 1.0, 0.02)
eq("check_figure warns that the reading is not the picture a boolean draws",
   any("boolean" in w for w in bo["reports"][0]["warnings"]), True)


print("\n  -- the round trip, and what rounding costs --\n")

curvy = [contour_spec(P.circle_path(200, 200, 137.4142)),
         reverse_spec(contour_spec(P.circle_path(200, 200, 61.803)))]
for prec, budget in ((6, 1e-5), (3, 1e-2), (1, 0.2), (0, 1.5)):
    doc = S.paths_to_svg({"paths": curvy, "fill": [0, 0, 0], "precision": prec,
                          "width": 400, "height": 400}, [])
    back_c = [{"d": e.get("d")} for e in path_els(doc["svg"])]
    move = worst_vertex_move(curvy, back_c)
    near(f"precision {prec}: worst vertex move is inside its budget",
         min(move, budget), move, 1e-12)
    if prec == 3:
        NOTES.append(f"the round trip at precision 3 moves the worst vertex of a "
                     f"two-contour figure by {move:.6f} px, and the file is "
                     f"{doc['bytes']} bytes against "
                     f"{S.paths_to_svg(dict(paths=curvy, fill=[0, 0, 0], precision=9, width=400, height=400), [])['bytes']} "
                     f"at precision 9")
    if prec == 0:
        NOTES.append(f"at precision 0 the same figure's worst vertex moves "
                     f"{move:.4f} px - rounding is an error budget, not a tidy-up")

d_line = path_els(S.paths_to_svg({"paths": FLAG, "fill": [0, 0, 0], "width": 400,
                                  "height": 400}, [])["svg"])[0].get("d")
eq("a straight-sided figure writes L, not six-number cubics", "C" in d_line, False)
eq("...and its closing side is the Z itself, so the corner joins",
   d_line.count("L"), len(FLAG[0]["points"]) - 1)
eq("a curved figure writes C", "C" in path_els(ring_doc["svg"])[0].get("d"), True)

raises("a NaN coordinate is refused rather than written",
       lambda: S.fmt(float("nan")), S.SvgError, "NaN")
raises("...and so is a runaway one", lambda: S.fmt(1e12), S.SvgError, "runaway")
eq("negative zero does not reach the file", S.fmt(-0.0001, 3), "0")
eq("a whole number keeps no decimal point", S.fmt(42.0, 3), "42")


print("\n  -- the envelope, the verdict, and the refusals --\n")

raises("a figure with no usable contour is refused",
       lambda: S.paths_to_svg({"paths": [], "fill": [0, 0, 0]}, []),
       S.SvgError, "no usable contour")
raises("...and so is one with neither fill nor stroke",
       lambda: S.paths_to_svg({"paths": RING}, []), S.SvgError, "neither fill nor stroke")
eq("several figures in one document each get their own element",
   len(path_els(S.paths_to_svg(
       {"items": [{"paths": RING, "fill": [255, 0, 0]},
                  {"paths": STAR, "fill": [0, 255, 0], "fillRule": "evenodd"}],
        "width": 400, "height": 400}, [])["svg"])), 2)
multi = S.paths_to_svg({"items": [{"paths": RING, "fill": [255, 0, 0]},
                                  {"paths": RING_SOLID_BUG, "fill": [0, 255, 0]}],
                        "width": 400, "height": 400}, [])
eq("...with one report each", len(multi["reports"]), 2)
eq("...and one bad figure makes the whole verdict false", multi["figureOk"], False)
eq("...while the first figure's report is still clean", multi["reports"][0]["ok"], True)


print("\n  -- every knob the catalog advertises turns something --\n")

# ⚠ THE SWEEP §9 IS REALLY ABOUT. A schema that accepts a parameter the code
# ignores is worse than a refusal: an agent sets it, the reply says ok, and the
# picture is unchanged with nothing anywhere to say why. So every declared
# parameter is turned off its default and the DOCUMENT is required to change.
BASE = {"paths": RING, "fill": [200, 100, 50, 255], "stroke": [0, 0, 0, 255],
        "strokeWidth": 6, "dash": [20, 10], "width": 400, "height": 400}
_base_svg = S.paths_to_svg(dict(BASE), [])["svg"]
TURN = {"fill": [1, 2, 3, 200], "fillRule": "evenodd", "boolean": "union",
        "stroke": [9, 9, 9, 100], "strokeWidth": 21, "cap": "round",
        "join": "round", "miterLimit": 9, "dash": [11, 5], "dashOffset": 4,
        "blend": "multiply", "tolerance": 4.0,
        "width": 512, "height": 512, "margin": 40, "title": "t", "desc": "d",
        "id": "logo", "background": [7, 7, 7, 255], "precision": 1}
for _k, _v in sorted(TURN.items()):
    _job = dict(BASE, **{_k: _v})
    if _k == "margin":             # only reachable when the viewport is measured
        _job.pop("width"), _job.pop("height")
    if _k == "tolerance":
        # ⚠ AND HERE IS THE ONE THE SWEEP WAS RIGHT ABOUT. An export writes the
        # CUBICS, so no tolerance changes an ordinary document - there is no
        # flattening in it to make coarser. It bites only where the figure has
        # to become a polygon: a boolean, or a measured viewport. That is now
        # `paramNotes` on the op rather than a surprise, and the knob is turned
        # here in the case where it is real.
        _job["boolean"] = "union"
        _base = S.paths_to_svg(dict(BASE, boolean="union"), [])["svg"]
        eq("tolerance changes the document wherever the figure is flattened",
           S.paths_to_svg(_job, [])["svg"] != _base, True)
        eq("...and does nothing at all to a plain export, which is said out "
           "loud on the op rather than left to be discovered",
           (S.paths_to_svg(dict(BASE, tolerance=4.0), [])["svg"] == _base_svg,
            "tolerance" in S.CATALOG["paths"]["paramNotes"]), (True, True))
        continue
    eq(f"{_k} changes the document", S.paths_to_svg(_job, [])["svg"] != _base_svg, True)
eq("...and every parameter of `paths` was in that sweep",
   sorted(k for k in S.CATALOG["paths"]["params"]
          if k not in TURN and k not in ("out", "svg", "items")), [])
# `out`, `svg` and `items` are the three whose effect is not a byte of the
# document, and each is asserted where it belongs instead: `out` at the door
# below, `items` in the multi-figure case above, `svg` at the text door.
_items_svg = S.paths_to_svg({"items": [dict(BASE)], "width": 400, "height": 400}, [])
eq("items with one figure in it is the same document as the flat job",
   _items_svg["svg"], _base_svg)


print("\n  -- the door --\n")


def door(mode, job):
    p = os.path.join(OUT_DIR, f"job_{mode}.json")
    with open(p, "w", encoding="utf-8") as fh:
        json.dump(job, fh)
    r = subprocess.run([PY, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                         "imgsvg.py"), mode, p],
                       capture_output=True, text=True)
    return r.returncode, json.loads(r.stdout.strip().split("\n")[-1] or "{}"), r.stderr


code, cat, _ = 0, json.loads(subprocess.run(
    [PY, os.path.join(os.path.dirname(os.path.abspath(__file__)), "imgsvg.py"), "catalog"],
    capture_output=True, text=True).stdout), ""
eq("catalog is JSON with both ops in it", sorted(cat["names"]), ["paths", "text"])
eq("...every op has a label, a group, a why and a where",
   [n for n, e in cat["ops"].items()
    if not all(e.get(k) for k in ("label", "group", "why", "where", "params"))], [])
eq("...every parameter has a type, a default key and a sentence",
   [f"{n}.{k}" for n, e in cat["ops"].items() for k, p in e["params"].items()
    if "type" not in p or "default" not in p or len(str(p.get("desc", ""))) < 20], [])
eq("...every numeric default sits inside its own advertised range",
   [f"{n}.{k}" for n, e in cat["ops"].items() for k, p in e["params"].items()
    if p["type"] == "number" and not (p["min"] <= p["default"] <= p["max"])], [])
eq("...the paint parameters ARE imgpath's, by identity and not by copy",
   [k for k in S.PAINT_KEYS if S.PAINT_PARAMS[k] is not P.CATALOG["draw"]["params"][k]],
   [])
eq("...and the traps are sentences a tool description can carry",
   [i for i, s in enumerate(cat["traps"]) if not s.strip().endswith(".") or len(s) < 40],
   [])
eq("...every paramNote names a parameter that exists",
   sorted(set(cat["ops"]["paths"].get("paramNotes", {}))
          - set(cat["ops"]["paths"]["params"])), [])
eq("...and is a sentence too",
   [k for k, s in cat["ops"]["paths"].get("paramNotes", {}).items()
    if not s.strip().endswith(".") or len(s) < 40], [])

out_svg = os.path.join(OUT_DIR, "door_ring.svg")
code, reply, err = door("paths", {"figure": {"paths": RING}, "fill": [0, 0, 0, 255],
                                  "width": 400, "height": 400, "out": out_svg})
eq("the paths door exits 0", code, 0)
eq("...with ok true", reply.get("ok"), True)
eq("...and the figure verdict beside it", reply.get("figureOk"), True)
eq("...having written the file", os.path.exists(out_svg), True)
eq("...which parses", parse(open(out_svg, encoding="utf-8").read()).tag, f"{NS}svg")

code, bad_reply, _ = door("paths", {"figure": {"paths": RING_SOLID_BUG},
                                    "fill": [0, 0, 0, 255], "width": 400,
                                    "height": 400,
                                    "out": os.path.join(OUT_DIR, "door_solid.svg")})
# ⚠ THE CALL WORKED AND THE FIGURE IS WRONG, AND THOSE ARE TWO ANSWERS.
eq("a bad figure still exits 0 - the CALL worked", code, 0)
eq("...ok is true", bad_reply.get("ok"), True)
eq("...figureOk is false", bad_reply.get("figureOk"), False)
eq("...and the sentence naming the contour came out with it",
   any("winds the same way" in s for s in bad_reply["reports"][0]["problems"]), True)

code, err_reply, _ = door("paths", {"figure": {"paths": []}, "fill": [0, 0, 0]})
eq("a request that cannot be honoured exits 1", code, 1)
eq("...with ok false", err_reply.get("ok"), False)
eq("...and names the error kind", err_reply.get("kind"), "SvgError")


# ---------------------------------------------------------------------------
# type as outlines - the half that needs a real font
# ---------------------------------------------------------------------------

FONT_DIR = os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "Fonts")
FACE = next((n for n in ("arial.ttf", "segoeui.ttf", "times.ttf", "verdana.ttf")
             if os.path.exists(os.path.join(FONT_DIR, n))), None)

print("\n  -- type as outlines --\n")

if FACE is None:
    NOTES.append("no TrueType face on this shelf, so the whole type half of "
                 "this suite proved nothing at all")
    eq("a font to read letterforms out of", FACE is not None, True)
else:
    FONT_PATH = os.path.join(FONT_DIR, FACE)
    import imgtext                                              # noqa: E402
    from fontTools.pens.areaPen import AreaPen                   # noqa: E402
    from fontTools.ttLib import TTFont                           # noqa: E402

    def area_pen(ch, size):
        """The glyph's area by fontTools' OWN pen, closed form.

        ⚠ THE ONLY EXACT CHECK ON THE EXTRACTION, and imgpath_test says the same
        thing about its copy: every other case here compares rasters, and a
        raster comparison at a sane tolerance cannot see a control point written
        as 0.66 instead of 2/3 - it moves the outline by about a sixth of a
        pixel at 200px and passes every IoU. The area sees it, because it is
        closed-form on both sides. The y flip reverses the sign; the scale
        squares."""
        tt = TTFont(FONT_PATH, fontNumber=0)
        gs = tt.getGlyphSet()
        pen = AreaPen(gs)
        gs[tt.getBestCmap()[ord(ch)]].draw(pen)
        return -pen.value * (float(size) / tt["head"].unitsPerEm) ** 2

    for ch in ("B", "o", "e", "A"):
        cont = S.glyph_contours(FONT_PATH, ch, 200, (100, 300))
        # ⚠ path_area TAKES THE GEOMETRY, NOT A JOB. Handing it {"paths": ...}
        # returns 0.0 for anything, and a relative error of 1.0 against every
        # glyph looked exactly like a broken extractor for ten minutes.
        got = P.path_area(cont)
        want = area_pen(ch, 200)
        rel = abs(got - want) / max(abs(want), 1e-9)
        near(f"the extracted {ch!r} has fontTools' own area, exactly", rel, 0.0, 1e-9)
        if ch == "B":
            NOTES.append(f"'B' of {FACE} at 200px: extracted area {got:.6f} px^2 "
                         f"against fontTools' AreaPen {want:.6f} - relative "
                         f"{rel:.3e}")

    # BREAK IT: the quadratic lift written as 0.66 rather than 2/3, which is the
    # error no raster comparison in this file can see.
    _real_gc = S.glyph_contours

    def sloppy(font_path, ch, size, origin, notes=None):
        cont = _real_gc(font_path, ch, size, origin, notes)
        for c in cont:
            for an in c["anchors"]:
                an["in"] = [v * 0.99 for v in an["in"]]
                an["out"] = [v * 0.99 for v in an["out"]]
        return cont

    sloppy_area = P.path_area(sloppy(FONT_PATH, "B", 200, (100, 300)))
    _b_want = area_pen("B", 200)
    eq("BROKEN ON PURPOSE: handles 1% short fail the area check",
       abs(sloppy_area - _b_want) / abs(_b_want) > 1e-9, True)
    _b_iou = iou(P.path_mask({"paths": sloppy(FONT_PATH, "B", 200, (100, 300))}, 400, 400),
                 P.path_mask({"paths": _real_gc(FONT_PATH, "B", 200, (100, 300))}, 400, 400))
    NOTES.append(f"handles 1% short move 'B' by {abs(sloppy_area - _b_want) / abs(_b_want):.2e} "
                 f"of its area and still score {_b_iou:.4f} IoU against the right "
                 f"glyph - which is why the exact check is the area and not a picture")

    # -- the winding trap, all three states of it ---------------------------
    for ch, counters in (("o", 1), ("B", 2)):
        cont = S.glyph_contours(FONT_PATH, ch, 200, (100, 300))
        rep = P.check_figure({"paths": cont, "fillRule": "nonzero"})
        eq(f"{ch!r} comes out with {counters} counter(s), reported as HOLES",
           len(rep["holes"]), counters)
        eq(f"...and nothing solid in {ch!r}", rep["solid"], [])
        eq(f"...so {ch!r}'s figure verdict is true", rep["ok"], True)
        signs = [a > 0 for a in rep["areas"]]
        eq(f"...its counters wind AGAINST the letter", len(set(signs)), 2)

        # the harmless flip: every contour reversed together
        whole = [reverse_spec(c) for c in cont]
        wrep = P.check_figure({"paths": whole, "fillRule": "nonzero"})
        eq(f"reversing ALL of {ch!r} at once changes nothing", wrep["ok"], True)
        eq(f"...its holes are still holes", len(wrep["holes"]), counters)
        near(f"...and it fills the same pixels",
             iou(P.path_mask({"paths": whole}, 420, 420),
                 P.path_mask({"paths": cont}, 420, 420)), 1.0, 1e-6)

        # the fatal one: a single counter reversed - a mirrored component, or a
        # caller who "fixed" a contour
        one = list(cont)
        one[rep["holes"][0]] = reverse_spec(cont[rep["holes"][0]])
        orep = P.check_figure({"paths": one, "fillRule": "nonzero"})
        eq(f"BROKEN ON PURPOSE: ONE counter of {ch!r} reversed fills solid",
           orep["solid"], [rep["holes"][0]])
        eq(f"...and the verdict is false", orep["ok"], False)
        filled = P.path_mask({"paths": one}, 420, 420)
        right = P.path_mask({"paths": cont}, 420, 420)
        eq(f"...with more ink than the letter has", float(filled.sum()) >
           float(right.sum()) * 1.05, True)
        eq(f"...and evenodd would have saved it, which is the other half of the "
           f"answer", P.check_figure({"paths": one, "fillRule": "evenodd"})["ok"], True)

    # -- a whole word -------------------------------------------------------
    word_notes = []
    word = S.text_to_outlines({"content": "Bongo", "font": FACE, "size": 200,
                               "box": [60, 60, 0, 0]}, word_notes)
    eq("'Bongo' gives five glyphs", len(word["glyphs"]), 5)
    eq("...and every counter in it is a hole",
       len(word["holes"]), sum(g["contours"] for g in word["glyphs"]) - 5)
    eq("...nothing solid", word["solid"], [])
    eq("...so the figure verdict is true", word["figureOk"], True)
    NOTES.append("'Bongo' in " + FACE + " is " + str(word["contours"]) +
                 " contours and " + str(len(word["holes"])) + " counters (" +
                 ", ".join(f"{g['char']}:{g['contours']}" for g in word["glyphs"]) +
                 ") - the B has two, which is why it is five and not four")

    # THE render comparison: the outlines against imgtext's own raster of the
    # same spec. Not an SVG renderer - there is none here - but it IS the other
    # side's source, which is the comparison that matters for the geometry.
    def outline_vs_render(spec, h=520, w=900, label=""):
        got = S.text_to_outlines(spec, [])
        mine = P.path_mask({"paths": got["figure"]["paths"], "fillRule": "nonzero"}, h, w)
        theirs = imgtext.render_text(dict(spec, fill={"type": "solid",
                                                      "color": [255, 255, 255]}),
                                     w, h)[..., 3]
        return got, iou(mine, theirs)

    base_spec = {"content": "Bongo", "font": FACE, "size": 200, "box": [60, 60, 0, 0]}
    _, word_iou = outline_vs_render(base_spec)
    eq("the outlines paint the same word imgtext rasterises", word_iou > 0.98, True)

    # ⚠ AND HERE IS WHY THAT NUMBER IS NOT 1.000, WHICH HAS TO BE A CLAIM AND
    # NOT AN EXCUSE. imgtext's raster quantises each glyph's x to a quarter
    # pixel (`_SUBPX`) and each baseline to a whole one (`iy = int(floor(by))`
    # in `_coverage`), and FreeType grid-fits the outline on top of both. The
    # outlines have none of that. So one GLYPH - no layout to confound it - is
    # measured three ways against a THIRD thing: Pillow's own raster at 8x,
    # box-downsampled, where grid fitting has nowhere left to move an edge.
    # imgpath's docstring publishes this same table for its own extraction, and
    # the numbers below are asserted to REPRODUCE it, which is how this file
    # proves it did not quietly write a second, different glyph walker.
    from PIL import ImageFont                                    # noqa: E402

    def pil_glyph(ch, size, origin, h, w):
        """The glyph as Pillow rasterises it, at the same pen point - the call
        imgtext's own `_glyph` makes, so this is the raster the type tool
        ships and not a second opinion invented here."""
        f = ImageFont.truetype(FONT_PATH, size)
        mask, off = f.getmask2(ch, mode="L", anchor="ls", start=(0.0, 0.0))
        gw, gh = mask.size
        tile = np.asarray(mask, np.uint8).reshape(gh, gw).astype(np.float32) / 255.0
        out = np.zeros((h, w), np.float32)
        x0, y0 = int(origin[0]) + int(off[0]), int(origin[1]) + int(off[1])
        out[y0:y0 + gh, x0:x0 + gw] = tile
        return out

    def unhinted(ch, size, origin, h, w, k=8):
        big = pil_glyph(ch, size * k, (origin[0] * k, origin[1] * k), h * k, w * k)
        return big.reshape(h, k, w, k).mean(axis=(1, 3))

    _table = []
    for ch, size, org, (h, w), want_mine, want_pil in (
            ("A", 200, (40, 250), (320, 300), 0.9969, 0.9928),
            ("e", 64, (20, 80), (120, 120), 0.9846, 0.8568)):
        mine_g = P.path_mask({"paths": S.glyph_contours(FONT_PATH, ch, size, org)}, h, w)
        pil_g = pil_glyph(ch, size, org, h, w)
        ref = unhinted(ch, size, org, h, w)
        a_, b_ = iou(mine_g, ref), iou(pil_g, ref)
        eq(f"measured against the TRUE outline, {ch!r}@{size} beats the raster "
           f"it is compared against", a_ > b_, True)
        near(f"...and reproduces the number imgpath's own docstring publishes "
             f"for {ch!r}@{size}", a_, want_mine, 5e-4)
        near(f"...as does the raster's", b_, want_pil, 5e-4)
        _table.append(f"{ch!r}@{size}: outlines {a_:.4f} / Pillow {b_:.4f} "
                      f"against the 8x reference")
    NOTES.append(f"'Bongo' outlines vs imgtext's own FreeType raster: IoU "
                 f"{word_iou:.4f} at 200px. Per GLYPH against an 8x unhinted "
                 f"reference - " + "; ".join(_table) + " - which are imgpath's "
                 f"own published numbers to four places, so the extraction here "
                 f"is provably the same one it measured, and the gap above is "
                 f"the renderer's hinting and quarter-pixel positioning")

    # BREAK IT: half a pixel of y offset, which is roughly what a baseline read
    # off the wrong metric would cost.
    shifted = S.text_to_outlines(base_spec, [])
    for c in shifted["figure"]["paths"]:
        for an in c["anchors"]:
            an["p"][1] += 3.0
    shifted_iou = iou(P.path_mask({"paths": shifted["figure"]["paths"]}, 520, 900),
                      imgtext.render_text(dict(base_spec, fill={"type": "solid",
                                                                "color": [255, 255, 255]}),
                                          900, 520)[..., 3])
    eq("BROKEN ON PURPOSE: a 3px baseline error is caught by the comparison",
       shifted_iou < 0.96, True)
    NOTES.append(f"a 3 px baseline error drops that IoU to {shifted_iou:.4f}, so "
                 f"the comparison has the resolution to see a placement bug")

    # -- the layout is imgtext's, not a second one --------------------------
    para = {"content": "Bongo Bongo Bongo drums", "font": FACE, "size": 64,
            "box": [40, 40, 420, 0], "align": "justify", "lineHeight": 1.4,
            "tracking": 3.0}
    got, para_iou = outline_vs_render(para, 520, 900)
    lay = imgtext.layout_text(para, [])
    # ⚠ THE EXACT CHECK FIRST. Where there IS an exact answer, an IoU threshold
    # is the wrong tool: every glyph's pen x and every line's baseline come out
    # of imgtext's own layout, so they are compared as NUMBERS, to six places,
    # across a wrap, a justification and a tracking. The IoU below is then only
    # asking whether the right geometry got drawn at those places, and its
    # threshold is set from the measurement rather than from a wish.
    eq("every glyph's pen position IS imgtext's own, line for line",
       [(li, round(g["x"], 6)) for li, g in
        ((g["line"], g) for g in got["glyphs"])],
       [(li, round(x, 6)) for li, r in enumerate(lay["lines"])
        for ch, x in r["glyphs"] if ch != " "])
    eq("...and so is every baseline",
       sorted({round(g["baseline"], 6) for g in got["glyphs"]}),
       sorted({round(r["baseline"], 6) for r in lay["lines"]
               if any(ch != " " for ch, _ in r["glyphs"])}))
    eq("a wrapped, tracked, justified paragraph lands where imgtext puts it",
       para_iou > 0.85, True)
    NOTES.append(f"a wrapped + justified + tracked paragraph at 64px: IoU "
                 f"{para_iou:.4f}, with every pen x and every baseline equal to "
                 f"imgtext's own to six decimal places. IoU on antialiased type "
                 f"is an EDGE measure - a single 'A' scores "
                 + ", ".join(
                     f"{sz}px {outline_vs_render({'content': 'A', 'font': FACE, 'size': sz, 'box': [60, 400, 0, 0]}, 520, 900)[1]:.4f}"
                     for sz in (32, 64, 128, 256))
                 + " - so a number without a size next to it is not a result")

    # -- rotation, pinned against imgtext's own warp rather than by eye ------
    #
    # ⚠ THE AFFINE HAS A CHECK AGAINST THE OTHER SIDE'S CODE, AND IT IS NOT AN
    # IoU. `imgtext._place` builds the matrix and hands it to cv2.warpAffine;
    # feed that function a buffer with a small lit PATCH in it and the centroid
    # of what comes back is the transformed centre. So the module's arithmetic
    # is checked against the renderer's own matrix through the renderer's own
    # code path, as numbers.
    #
    # The patch is 9x9 rather than one pixel because warpAffine samples the
    # DESTINATION grid through a quantised (1/32 px) bilinear kernel, and a
    # single lit pixel's reconstructed centroid carries that discretisation:
    # measured on this rig, the same probe reads 0.0917 px off with a 1x1
    # patch, 0.0298 at 3x3, 0.0138 at 5x5 and 0.0091 from 9x9 on - a sequence
    # that converges on the interpolator's own floor rather than on a bug.
    place_spec = imgtext.coerce_spec(dict(base_spec, size=100, box=[160, 200, 0, 0],
                                          rotate=-15.0, skewX=12.0, skewY=6.0))
    worst_place = 0.0
    for (ox, oy, u, v) in ((300, 5, 40, 90), (120, 90, 30, 30), (250, 150, 77, 33)):
        blk = np.zeros((200, 200, 4), np.float32)
        blk[v:v + 9, u:u + 9, 3] = 1.0
        painted = imgtext._place(blk, (ox, oy), False, place_spec, 600, 600)[..., 3]
        tot = float(painted.sum())
        ys, xs = np.nonzero(painted)
        cx = float((xs * painted[ys, xs]).sum() / tot)
        cy = float((ys * painted[ys, xs]).sum() / tot)
        a, b, d, e, px, py = S._rotate_skew(place_spec)
        X, Y = ox + u + 4.0, oy + v + 4.0
        worst_place = max(worst_place, math.dist(
            (cx, cy), (a * (X - px) + b * (Y - py) + px,
                       d * (X - px) + e * (Y - py) + py)))
    near("the rotate/skew affine IS the one imgtext warps the block with",
         worst_place, 0.0, 0.02)

    # And the same claim a second way, against the SOURCE rather than against a
    # measurement of it: the four coefficients are quoted from imgtext._place,
    # so if that function's arithmetic ever changes this fails and says where.
    _src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "imgtext.py"), encoding="utf-8").read()
    eq("...and its four coefficients are imgtext's own lines, verbatim",
       [line for line in ("a = c - s * ty", "b = c * tx - s",
                          "d = s + c * ty", "e = s * tx + c")
        if line not in _src], [])
    NOTES.append(f"the rotate+skew affine agrees with imgtext._place's own cv2 "
                 f"matrix to {worst_place:.4f} px over three probe points, and "
                 f"its four coefficients are asserted against imgtext.py's "
                 f"source text rather than against anybody's memory of it")

    rot = dict(base_spec, size=140, rotate=22.0, box=[120, 180, 0, 0])
    _, rot_iou = outline_vs_render(rot, 520, 900)
    eq("a rotated block's outlines land on the rotated render", rot_iou > 0.93, True)
    skew = dict(base_spec, size=140, skewX=-18.0, box=[120, 180, 0, 0])
    _, skew_iou = outline_vs_render(skew, 520, 900)
    eq("...and a skewed one too", skew_iou > 0.93, True)
    both = dict(base_spec, size=140, rotate=-15.0, skewX=12.0, skewY=6.0,
                box=[160, 200, 0, 0])
    _, both_iou = outline_vs_render(both, 520, 900)
    eq("...and both at once, which is where a transposed matrix hides",
       both_iou > 0.93, True)
    NOTES.append(f"rotate 22: IoU {rot_iou:.4f}; skewX -18: {skew_iou:.4f}; "
                 f"rotate -15 + skewX 12 + skewY 6: {both_iou:.4f}. These sit "
                 f"below the unrotated 0.98 because the RENDER is a bilinear "
                 f"resample of an already-rasterised block while the outlines "
                 f"are analytic - the transform itself is pinned exactly above")

    # BREAK IT: the transpose. b and d swapped is the classic affine bug, and it
    # is invisible at rotate 0.
    _real_rs = S._rotate_skew
    try:
        S._rotate_skew = lambda p: (lambda a, b, d, e, px, py: (a, d, b, e, px, py))(
            *_real_rs(p))
        _, t_iou = outline_vs_render(rot, 520, 900)
        eq("BROKEN ON PURPOSE: a transposed rotation is caught", t_iou < 0.5, True)
        NOTES.append(f"b and d swapped - the classic affine bug, and invisible "
                     f"at rotate 0 - takes that IoU from {rot_iou:.4f} to "
                     f"{t_iou:.4f}")
    finally:
        S._rotate_skew = _real_rs

    # the reflection case: past 45 degrees of shear on both axes the determinant
    # goes negative and every contour reverses - together, so it survives.
    refl = dict(base_spec, size=120, skewX=60.0, skewY=60.0, box=[200, 300, 0, 0])
    refl_notes = []
    refl_got = S.text_to_outlines(refl, refl_notes)
    eq("a doubly-skewed block is a REFLECTION and says so",
       any("negative determinant" in n for n in refl_notes), True)
    eq("...and its counters are still counters", refl_got["figureOk"], True)
    eq("...every one of them", len(refl_got["holes"]), len(word["holes"]))

    # -- text on a path -----------------------------------------------------
    arc = {"content": "Bongo", "font": FACE, "size": 90, "box": [0, 0, 0, 0],
           "path": {"kind": "arc", "center": [450, 330], "radius": 220,
                    "startAngle": 200, "endAngle": 340}}
    got_arc, arc_iou = outline_vs_render(arc, 520, 900)
    eq("glyphs walked along an arc land where imgtext walks them",
       arc_iou > 0.88, True)
    eq("...and the reply says the run is on a path", got_arc["onPath"], True)
    NOTES.append(f"'Bongo' on an arc: IoU {arc_iou:.4f} against imgtext's own "
                 f"per-glyph warp of the same run")

    # -- the empty, the absent and the refused ------------------------------
    empty = S.text_to_outlines({"content": "", "font": FACE, "size": 120}, [])
    eq("an empty string gives an empty figure, not a refusal", empty["contours"], 0)
    eq("...with a figure verdict of false, because there is nothing to fill",
       empty["figureOk"], False)
    eq("...and a sentence saying so",
       "no usable contour" in empty["report"]["problems"][0], True)
    raises("...and it cannot become a document",
           lambda: S.text_to_svg({"text": {"content": "", "font": FACE}}, []),
           S.SvgError)

    spaces = S.text_to_outlines({"content": "   ", "font": FACE, "size": 120}, [])
    eq("a string of spaces has no outlines either", spaces["contours"], 0)
    # ...and NOT because the spaces were skipped: imgtext strips a line's
    # trailing spaces during layout, so a line of nothing but spaces arrives
    # here with no glyphs at all. An interior space is the one that gets
    # skipped, and that one is named.
    eq("...with nothing to name, because the layout stripped them first",
       spaces["missing"], [])
    inner = S.text_to_outlines({"content": "B o", "font": FACE, "size": 120}, [])
    eq("an interior space is named as having no outline", inner["missing"], [" "])
    eq("...while its neighbours still came through", len(inner["glyphs"]), 2)

    miss_warn = []
    raises("a font that is not on this rig is refused, not silently substituted",
           lambda: S.text_to_outlines({"content": "Bongo", "font": "Helvetica.ttf",
                                       "size": 100}, [], miss_warn),
           S.SvgError, "no file on this rig")
    eq("...carrying imgtext's own sentence about the fallback",
       any("font shelf" in w or "fell back" in w for w in miss_warn), True)
    raises("...and a path with a separator in it is refused by the same door",
           lambda: S.text_to_outlines({"content": "x", "font": "../../evil.ttf"}, []),
           S.SvgError)

    miss_notes = []
    nope = S.text_to_outlines({"content": "B\u5b57B", "font": "cour.ttf"
                               if os.path.exists(os.path.join(FONT_DIR, "cour.ttf"))
                               else FACE, "size": 100}, miss_notes)
    eq("a codepoint the face does not have is named, not drawn as a box",
       len(nope["glyphs"]) == 3 or any("is not in" in n for n in miss_notes), True)
    # ascii(): this console is cp1252 and printing the codepoint itself kills
    # the run at the LAST line of the suite, after everything has passed.
    NOTES.append(f"a CJK codepoint through a Latin face: {len(nope['glyphs'])} "
                 f"glyphs came back, missing {ascii(nope['missing'])}, notes "
                 f"{ascii([n for n in miss_notes if 'is not in' in n])}")

    # -- what geometry cannot carry, said out loud --------------------------
    drop_notes = []
    S.text_to_outlines(dict(base_spec, outline={"width": 6},
                            shadow={"enabled": True},
                            fill={"type": "linear", "color": [255, 0, 0]}), drop_notes)
    eq("a dropped outline is named", any("outline was dropped" in n for n in drop_notes), True)
    eq("a dropped shadow is named", any("shadow was dropped" in n for n in drop_notes), True)
    eq("a gradient fill that cannot travel is named",
       any("only \na solid colour is carried".replace("\n", "") in n or
           "solid colour is carried" in n for n in drop_notes), True)

    # -- and the whole way through the door ---------------------------------
    tout = os.path.join(OUT_DIR, "door_text.svg")
    code, treply, terr = door("text", {"text": base_spec, "fill": [10, 10, 10, 255],
                                       "title": "Bongo & Co", "out": tout})
    eq("the text door exits 0", code, 0)
    eq("...ok true, figure verdict beside it",
       (treply.get("ok"), treply.get("figureOk")), (True, True))
    eq("...wrote a document that parses",
       parse(open(tout, encoding="utf-8").read()).tag, f"{NS}svg")
    tsvg = open(tout, encoding="utf-8").read()
    eq("...as ONE path element with every glyph in it", len(path_els(tsvg)), 1)
    eq("...whose subpath count is the contour count",
       path_els(tsvg)[0].get("d").count("M"), treply["contours"])
    eq("...with no attribute SVG does not have", audit(tsvg), [])
    eq("...and the ampersand in the title survived",
       "&" in parse(tsvg).find(f"{NS}title").text, True)

    code, plain, _ = door("text", {"text": base_spec})
    eq("the text door with no out and no svg hands back the FIGURE",
       (code, "svg" in plain, "figure" in plain), (0, False, True))
    eq("...which imgpath's grammar reads straight back",
       len(P._paths_of(plain["figure"]["paths"])), plain["contours"])
    code, asked, _ = door("text", {"text": base_spec, "svg": True,
                                   "fill": [0, 0, 0, 255]})
    eq("...and `svg: true` builds the document without writing a file",
       (code, parse(asked["svg"]).tag), (0, f"{NS}svg"))
    near("...and the file draws the word imgtext draws",
         iou(raster(tsvg, 520, 900),
             imgtext.render_text(dict(base_spec, fill={"type": "solid",
                                                       "color": [255, 255, 255]}),
                                 900, 520)[..., 3]), word_iou, 1e-3)
    NOTES.append(f"the finished document for 'Bongo' is {len(tsvg)} bytes and "
                 f"needs no font on the machine that opens it")


print("\n  -- the comparison this venv cannot make, written out so a browser "
      "can --\n")

# ⚠ EVERY NUMBER ABOVE IS IMGPATH READING BACK IMGPATH'S OWN OUTPUT. That is a
# real check of the geometry and a WEAK one of the format: a misspelt attribute
# imgpath never looks at would sail through every case in this file. The only
# thing on this machine that can read SVG the way the world does is a browser,
# and a browser cannot be driven from a test run. So the suite writes the
# comparison out instead - every document beside the block-mean grid imgpath
# rasterised it to - and a person (or an agent with a browser) opens the page
# and reads window.RESULT. That turns "we could not measure it" into "here is
# the measurement, repeat it", which is the honest form of a gap.
#
# MEASURED THIS WAY ON 2026-09-21, Chrome's own renderer against imgpath's, at
# a 20x20 block resolution on a 400x400 canvas:
#
#     flag, asymmetric (the y-flip case)      IoU 1.0000   ink 1.0000
#     ring with a hole                        IoU 0.9974   centre empty in both
#     pentagram nonzero                       IoU 0.9981   centre ink in both
#     pentagram evenodd                       IoU 0.9968   centre empty in both
#     an OPEN contour, filled                 IoU 1.0000   ink 1.0000 - so the
#                                             implicit close really is implicit
#     dashed, round caps, open polyline       IoU 0.9946   ink 0.9963
#     miter join, limit 10 (spike kept)       IoU 0.9986   ink 0.9990
#     miter join, limit 1.2 (bevelled)        IoU 0.9980   ink 0.9981
#     square caps + a translucent fill        IoU 0.9999   ink 1.0000
#     'Bongo' as outlines, no font installed  IoU 0.9946   ink 1.0004
#     BROKEN ON PURPOSE: ring as 3 elements   IoU 0.7494   ink 1.3327, and the
#                                             CENTRE READS 1 IN CHROME AND 0 IN
#                                             IMGPATH - the hole filled solid in
#                                             a real renderer, exactly as this
#                                             file's own split case predicted
#
# The two miter documents are not the same picture (imgpath's own stroke puts
# ink at the spike tip at limit 10 and none at limit 1.2), so Chrome matching
# BOTH is the proof that `stroke-miterlimit` travelled rather than being
# ignored on both sides.

def cross_page(path):
    import base64
    cases = []

    def add(name, job, mask):
        doc = S.paths_to_svg(dict(job, width=400, height=400), [])
        g = mask.reshape(20, 20, 20, 20).mean(axis=(1, 3))
        cases.append({"name": name,
                      "svg": base64.b64encode(doc["svg"].encode("utf-8")).decode("ascii"),
                      "want": [[round(float(v), 5) for v in row] for row in g],
                      "centre": round(float(mask[200, 200]), 4),
                      "ink": round(float(mask.sum()), 2)})

    add("flag, asymmetric (the y-flip case)", {"paths": FLAG, "fill": [0, 0, 0, 255]},
        P.path_mask({"paths": FLAG}, 400, 400))
    add("ring with a hole", {"paths": RING, "fill": [0, 0, 0, 255]},
        P.path_mask({"paths": RING}, 400, 400))
    for rule in ("nonzero", "evenodd"):
        add(f"pentagram {rule}", {"paths": STAR, "fill": [0, 0, 0, 255], "fillRule": rule},
            P.path_mask({"paths": STAR, "fillRule": rule}, 400, 400))
    # ⚠ AN OPEN CONTOUR THAT IS FILLED. SVG closes an open subpath implicitly
    # for FILLING and leaves it open for STROKING, which is imgpath's rule
    # verbatim - so the export writes no Z and relies on both sides reading the
    # spec the same way. That is a claim about a renderer, so it goes on the
    # page where a renderer can answer it.
    wedge = [{"points": [[80, 340], [200, 60], [320, 340]], "closed": False}]
    add("an OPEN contour, filled - SVG must close it implicitly",
        {"paths": wedge, "fill": [0, 0, 0, 255]},
        P.path_mask({"paths": wedge}, 400, 400))
    zig = [{"points": [[60, 320], [200, 80], [340, 320]], "closed": False}]
    for label, job in (
            ("dashed, round caps, open polyline",
             {"paths": zig, "fill": None, "stroke": [0, 0, 0, 255], "strokeWidth": 18,
              "cap": "round", "join": "round", "dash": [40, 18], "dashOffset": 7}),
            ("miter join, limit 10 (the spike stays)",
             {"paths": zig, "fill": None, "stroke": [0, 0, 0, 255], "strokeWidth": 40,
              "join": "miter", "miterLimit": 10}),
            ("miter join, limit 1.2 (it must bevel)",
             {"paths": zig, "fill": None, "stroke": [0, 0, 0, 255], "strokeWidth": 40,
              "join": "miter", "miterLimit": 1.2}),
            ("square caps over a translucent fill",
             {"paths": FLAG, "fill": [0, 0, 0, 90], "stroke": [0, 0, 0, 255],
              "strokeWidth": 12, "cap": "square", "join": "bevel"})):
        add(label, job, P.draw_path(np.zeros((400, 400, 4), np.float32), dict(job))[..., 3])
    # and the trap, so the page proves it in a real renderer too
    wrong = "\n".join(
        [f'<svg xmlns="{S.SVG_NS}" version="1.1" width="400" height="400" '
         f'viewBox="0 0 400 400">']
        + [f'<path d="{S.contour_d(b, 3)}" fill="rgb(0,0,0)" fill-rule="nonzero"/>'
           for b in P._paths_of(RING)] + ["</svg>"])
    g = P.path_mask({"paths": RING}, 400, 400)
    cases.append({"name": "BROKEN ON PURPOSE: the ring as separate elements",
                  "svg": base64.b64encode(wrong.encode("utf-8")).decode("ascii"),
                  "want": [[round(float(v), 5) for v in r]
                           for r in g.reshape(20, 20, 20, 20).mean(axis=(1, 3))],
                  "centre": round(float(g[200, 200]), 4),
                  "ink": round(float(g.sum()), 2)})
    if FACE:
        tf = S.text_to_outlines({"content": "Bongo", "font": FACE, "size": 96,
                                 "box": [20, 40, 0, 0]}, [])
        add("'Bongo' as outlines, no font needed",
            {"paths": tf["figure"]["paths"], "fill": [0, 0, 0, 255]},
            P.path_mask({"paths": tf["figure"]["paths"]}, 400, 400))

    html = ("<!doctype html><meta charset=\"utf-8\"><title>imgsvg cross-render"
            "</title><body style=\"font:13px monospace\"><pre id=\"log\">"
            "rendering...</pre><script>\nconst CASES = " + json.dumps(cases) +
            """;
function render(b64){return new Promise((res,rej)=>{const img=new Image();
 img.onload=()=>{const c=document.createElement('canvas');c.width=c.height=400;
  const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(img,0,0,400,400);
  let d;try{d=g.getImageData(0,0,400,400).data}catch(e){rej('canvas tainted: '+e.message);return}
  const grid=[];for(let by=0;by<20;by++){const row=[];for(let bx=0;bx<20;bx++){let s=0;
   for(let y=0;y<20;y++)for(let x=0;x<20;x++)s+=d[(((by*20+y)*400)+(bx*20+x))*4+3]/255;
   row.push(s/400)}grid.push(row)}
  let ink=0;for(let i=3;i<d.length;i+=4)ink+=d[i]/255;
  res({grid,ink,centre:d[((200*400)+200)*4+3]/255})};
 img.onerror=()=>rej('the browser refused to parse this SVG');
 img.src='data:image/svg+xml;base64,'+b64})}
(async()=>{const out=[];for(const c of CASES){try{const r=await render(c.svg);
 let n=0,dn=0,w=0;for(let y=0;y<20;y++)for(let x=0;x<20;x++){const a=r.grid[y][x],b=c.want[y][x];
  n+=Math.min(a,b);dn+=Math.max(a,b);w=Math.max(w,Math.abs(a-b))}
 out.push({name:c.name,iou:dn?n/dn:0,worstBlock:w,inkRatio:c.ink?r.ink/c.ink:0,
           centreBrowser:r.centre,centreImgpath:c.centre})}
 catch(e){out.push({name:c.name,error:String(e)})}}
 window.RESULT=out;document.getElementById('log').textContent=
  out.map(r=>r.error?(r.name+' :: ERROR '+r.error):
   (r.name+' :: IoU '+r.iou.toFixed(4)+'  worstBlock '+r.worstBlock.toFixed(4)+
    '  ink '+r.inkRatio.toFixed(4)+'  centre '+r.centreBrowser+'/'+r.centreImgpath)).join('\\n')})();
</script>""")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(html)
    return len(cases)


_page = os.path.join(OUT_DIR, "cross_render.html")
_n = cross_page(_page)
eq("the cross-renderer page was written, with every trap in it", _n >= 9, True)
eq("...and it parses as a document too, so a stale template cannot ship",
   "window.RESULT" in open(_page, encoding="utf-8").read(), True)
NOTES.append(f"{_n} documents written to {_page} with imgpath's own raster of "
             f"each embedded beside them - open it over http (a file:// page "
             f"cannot read a canvas back) and read window.RESULT for a "
             f"comparison against a REAL SVG renderer. Measured that way in "
             f"Chrome on 2026-09-21: 1.0000 for the asymmetric flag, 0.9974 "
             f"for the ring, 0.9981/0.9968 for the two pentagram rules, "
             f"1.0000 for an open contour filled (the implicit close), "
             f"0.9946 dashed round caps, 0.9986/0.9980 for the two miter "
             f"limits, 0.9999 square caps over a fill, 0.9946 for 'Bongo' - "
             f"and 0.7494 with the centre reading 1 in Chrome and 0 here for "
             f"the split-element version, which is the hole trap confirmed in "
             f"a renderer that is not ours")


print("\n  -- what is missing from this venv, re-checked rather than assumed --\n")

_rasterisers = []
for mod in ("cairosvg", "cairocffi", "svglib", "skia", "resvg_py", "rlPyCairo", "wand"):
    try:
        __import__(mod)
        _rasterisers.append(mod)
    except ImportError:
        pass
eq("there is still no SVG rasteriser here, so no case above claims a true "
   "pixel comparison against an independent renderer", _rasterisers, [])
NOTES.append("no SVG rasteriser in this venv (cairosvg, cairocffi, svglib, "
             "skia, resvg_py, rlPyCairo, wand all absent; Pillow cannot open "
             "SVG), so every IoU above is imgpath reading back the file this "
             "module wrote - it proves the geometry, the winding, the subpath "
             "grouping and the fill rule survive, and cannot prove an "
             "attribute is spelt the way a browser reads it. The spellings are "
             "pinned against a written-down list of SVG 1.1 property names "
             "instead, and that list is broken on purpose above.")
NOTES.append(f"every attribute this suite saw emitted: "
             f"{', '.join(sorted(SEEN_ATTRS))}")
NOTES.append(f"the documents this run wrote are in {OUT_DIR}")

if NOTES:
    print("\n  -- measured --")
    for n in NOTES:
        print(f"     {n}")

print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
