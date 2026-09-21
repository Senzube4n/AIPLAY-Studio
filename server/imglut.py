"""3D colour lookup tables - the door a look travels through, and this studio
did not have one.

A `.cube` file is how a grade LEAVES the room it was made in. Every colourist's
tool exports them, every film-emulation pack ships them, and a look somebody
paid for or spent an evening building arrives as one file with a thousand
numbers in it. Until this module there was no way to take that file, so a look
could be described to the image editor in words and never handed to it.

    read_lut(path)                         -> Lut, or a REFUSAL SENTENCE
    apply_lut(rgba, lut, strength, interp) -> the same array shape, alpha kept
    describe(lut)                          -> title, size, domain, what it does
    catalog()                              -> the vocabulary, for MCP and the panel

`rgba` is float32 (H, W, 3) or (H, W, 4), 0..1, STRAIGHT alpha - the buffer
every other column in docs/IMAGE_SPEC.md passes around. Alpha comes back
untouched, bit for bit.

A LUT is a POINTWISE function, which is the one thing that makes it simpler
than everything else in this directory. imgpath has to premultiply before it
warps and imgphoto has to premultiply before it blurs, because filtering mixes
neighbouring pixels and the RGB under a transparent one is garbage. Nothing
here reads a neighbour, so straight alpha is exactly the right input and
premultiplying first would GRADE the invisible colour into the visible one.

⚠ EVERY FAILURE THIS MODULE CAN HAVE DRAWS A PICTURE. That is the whole reason
it is written this carefully. A LUT applied with the axes transposed still
looks like a grade. A LUT whose domain was ignored still looks like a grade.
A film LUT built for log footage, dropped on an sRGB still, looks like a grade
somebody chose. There is no exception thrown, no pixel out of range, nothing
for a test that counts pixels to notice - which is exactly how a colour tool
ships broken and stays broken. The five traps, each with its own ⚠ at the code
that handles it:

  1. ROW ORDER. A `.cube` 3D table varies RED FASTEST: the row at index
     r + g*N + b*N*N holds the output for grid point (r, g, b). Read it the
     other way round and the LUT still applies, still looks graded, and is
     wrong in a way nobody can point at. A SYMMETRIC test LUT cannot catch
     this - which is precisely how it ships - so imglut_test pins it with an
     asymmetric one whose three axes are told apart by construction.

  2. DOMAIN. `DOMAIN_MIN`/`DOMAIN_MAX` are not always 0..1; a LUT built for
     log or for extended-range footage says so in its header, and ignoring
     those two lines silently squashes or clips the whole picture. Input
     outside the domain is CLAMPED, deliberately and on purpose - see
     `_positions`, where the alternative is an index out of bounds or a
     negative index that wraps to the far end of the table and reads a colour
     from the opposite corner of the cube.

  3. INTERPOLATION. Nearest-neighbour is visibly banded on a 17- or 33-point
     LUT and is in the catalog only so the banding can be MEASURED rather than
     asserted. Trilinear is the floor. Tetrahedral is the default, and what it
     buys is measured below rather than claimed.

  4. SIZE. A 65-point cube is 274,625 entries; the header is one integer and a
     hostile or corrupt file can claim any integer at all. The cap is
     LIMITS["max3dSize"] and the refusal NAMES IT, the way imgdoc refuses an
     oversized shelf. The refusal happens while reading the HEADER - before
     anything is allocated - because a module that refuses after the
     allocation has already lost.

  5. WHAT SPACE THE LUT EXPECTS, and this one cannot be fixed, only said.
     A LUT built for log footage applied to an sRGB picture produces a milky,
     low-contrast, plausible-looking result that reads as a deliberate choice.
     There is nothing in the file that says which it wants - the format has no
     field for it, and no measurement of the table can recover it. So this
     module does not guess: `describe()` carries the LUT's own TITLE through
     verbatim (that string is usually the only evidence there is), reports what
     the LUT does to black, 18% grey and white as NUMBERS, and states in
     `cannotKnow` that it does not know. Honesty in the reply beats a guess
     that is right most of the time and silently disastrous the rest.

INTERPOLATION, MEASURED RATHER THAN ASSERTED

Tetrahedral's usual claim is that it is "more accurate". That is worth a number
and not a sentence, so here is the measurement `_measure_interp()` takes on
every `imglut.py bench` and every run of imglut_test: a smooth analytic grade
(a per-channel gamma with real cross-channel mixing, so the three axes are not
separable and a 1D curve could not do it) is baked into a 33-point cube, and
the cube is then run over a dense 0..1 gradient and compared against the exact
function evaluated on the same gradient.

    33-point cube, 160,000 samples       sweep max   sweep RMS    grey hue
    ------------------------------------------------------------------------
    tetrahedral  (the default)            0.00381    0.000172    1.2e-07
    trilinear                             0.00306    0.000148    4.2e-04
    nearest                               0.03565    0.007630    0.0

⚠ READ THE FIRST TWO COLUMNS BEFORE BELIEVING THE USUAL CLAIM. Tetrahedral is
NOT more accurate here - trilinear beats it on both, by about 20%, over a dense
random walk of the colour cube. That is measured on this rig, it is repeatable,
and it is the opposite of what "tetrahedral is the better interpolator" leads a
person to expect. Anyone about to write that sentence in a commit message
should look at this table first.

What tetrahedral buys is the LAST column, and the last column is the one a
viewer sees. `grey hue` is the spread between the three output channels on a
grey ramp through a LUT that is exactly neutral-preserving - so every bit of it
was invented by the interpolator. Tetrahedral's cell decomposition puts the
cell's main diagonal along a tetrahedron EDGE, so r == g == b interpolates
exactly linearly between the two grey corners and grey stays grey: 1.2e-07 is
float32 noise. Trilinear's eight weights do not reduce to that line, so a
neutral ramp picks up 4.2e-04 of chroma that changes sign at every cell
boundary - about a tenth of an 8-bit code, which sounds like nothing and is a
faint alternating colour ripple across a sky, a wall, or a face in soft light.
A banded numeric error hides in the noise of a photograph; a periodic one on a
smooth gradient does not.

So the default is tetrahedral in exchange for 20% more numeric error on
arbitrary colours, and the trade is written down here rather than assumed.
`nearest`'s own zero in that column is not a virtue: it snaps to grid points,
which ARE neutral, and pays for it with ten times the error of either - 0.0357
is nine 8-bit codes, which is the banding it is in the catalog to demonstrate.

THE PIN THAT STANDS IN FRONT OF ALL FIVE

An IDENTITY LUT - one that maps every colour to itself - must return the
picture BIT-IDENTICALLY, and imglut_test asserts exactly that, not a tolerance.
It is one line that catches all five traps at once: transpose the axes and it
returns the picture with red and blue swapped, ignore the domain and it
squashes, interpolate wrong and it rounds, drop the clamp and the edges move.
Nothing survives it.

Measured: bit-identical at sizes 2, 5, 17, 33 and 65, on both interpolators,
over a random float32 picture. Those are the sizes where N-1 is a power of two,
so the grid values i/(N-1) are exactly representable in float32 - and they are
every size anyone ships. At N = 32, where the grid values are i/31 and are not,
identity comes back ONE FLOAT32 ULP out: 5.96e-08, which is a 65,000th of an
8-bit code. So the claim is "bit-identical at every real LUT size, one ulp at
the others", and the test asserts BOTH halves, including that 32 is not exact -
because an implementation that had somehow made 32 exact would have got there
by rounding, and rounding is what the pin is watching for.

WHAT IT COSTS

Measured by `imglut.py bench` on this rig, a 33-point cube over a megapixel of
random colour. FOUR RUNS of best-of-five rather than one number, because the
spread is not small and a single figure here would be a lie by rounding:

    tetrahedral (the default)   177 - 189 ms per megapixel
    trilinear                   234 - 248
    nearest                      44 -  50
    tetrahedral at 40%          186 - 193   (the blend is ~10 ms, not a 2nd pass)
    tetrahedral, (H, W, 3)      168 - 174

A 1344x768 H3 video frame is 1.03 megapixels, so a LUT on a rendered clip costs
about 0.19 s a frame - which is why `apply_lut` takes a Lut rather than a path,
and why a renderer must read the file ONCE outside its loop. Reading a 65-point
cube is 274,625 rows of text; doing that per frame would cost more than the
grading does and would hide behind a per-frame timing that looks reasonable.

Do not read a number off a run of imglut_test against this table: the suite
prints the same bench at best-of-TWO, after five hundred of its own
allocations, and has been seen anywhere from 176 to 231 for the same call.
Compare a bench to a bench.

Three things got it from 290 ms to 180, each measured rather than assumed, and
each is commented where it lives: np.take instead of fancy indexing (6.3 ms per
gather against 16.2), three comparison lines instead of np.argsort on three
elements a million times over (6 ms against 42), and in-place arithmetic on the
gathered corners, which nobody else holds a reference to.

BLENDING AT LESS THAN 100%, AND WHY IN THAT SPACE

A look at full strength is the exception; 40% of a film LUT over a base grade
is how one is actually used. The blend is a plain lerp between the LUT's
OUTPUT and the ORIGINAL INPUT, in the code values the LUT handed back:

    out = lut(x) * s + x * (1 - s)

The alternative - linearise both sides, blend there, re-encode - is the one
that sounds more correct and is not available: linearising requires knowing the
transfer function of the space the LUT outputs in, and trap 5 above is that
this module does not know it and will not pretend to. A blend through a GUESSED
gamma is a guess wearing the clothes of rigour. The plain lerp is also what the
mix slider does in every grading tool that has one, so 40% here is 40% there,
and it has two properties the round trip would lose: strength 0 returns the
input BIT-IDENTICALLY, and strength 100 returns the LUT's own output bit for
bit. Both are pinned in imglut_test.

.3dl IS REFUSED, AND THE REASON IS THE POINT

Parsing `.3dl` is cheap - a mesh line and integer triples. Being RIGHT about it
is not, and this is the one module where being nearly right is the failure.
There are two incompatible `.3dl` conventions in the wild (Lustre's and
Flame/Nuke's), they disagree about which component varies fastest, and the bit
depth of the integers is IMPLIED by the largest value rather than stated. Both
of those are exactly trap 1 and trap 2 with different names, and neither can be
settled by reading the numbers in the file. There is no `.3dl` on this machine
to check an implementation against, so there would be no way to know the
implementation was wrong except by looking at a picture and not liking it.
`read_lut` therefore refuses `.3dl` with a sentence that says this and says
what would settle it. When a real `.3dl` with a known-correct reference render
turns up, that sentence is the thing to delete.

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/imglut.py catalog
    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/imglut.py bench
    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/imglut.py info  <job>
    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/imglut.py apply <job>

numpy, and Pillow for the CLI's two file ends only - the library functions take
and return arrays, so a video renderer applying one LUT to a thousand frames
reads the file ONCE and never touches a decoder.
"""
# ── WIRING - what the engine owner has to do, and it is all of it ────────────
#
#   1. server/imagetools.py, with the other imports:
#
#          import imglut
#
#   2. Stage 5, with the adjustments - a LUT IS an adjustment, and it belongs
#      after the tone controls for the same reason it sits at the bottom of a
#      grading stack: a look is applied TO a balanced picture, not instead of
#      one. On the float32 (H, W, 4) 0..1 straight-alpha array:
#
#          if ops.get("lut"):
#              arr = imglut.apply(arr, ops["lut"], mask, notes)
#
#      `mask` is the stage-4 selection, float32 (H, W) 0..1, or None. It scales
#      the STRENGTH per pixel, which is the same arithmetic imgselect.blend
#      does and not a second one.
#
#   3. server/index.js - two routes, and they are different animals:
#
#          POST /api/images/lut-info   { lut }                  -> a REPORT
#          POST /api/images/lut        { name, lut, strength }  -> a new image
#
#      the first spawning `python server/imglut.py info <jobPath>` and the
#      second either going through imagetools' edit job as ops.lut or spawning
#      `python server/imglut.py apply <jobPath>` directly. Both are the
#      {mode, jobPath} shape every other module here is reached with, so there
#      is no new way to reach python.
#
#      ⚠ THE REPORT'S VERDICT AND THE CALL'S SUCCESS NEED TWO DIFFERENT WORDS,
#      and imgpath.check_figure taught this the hard way (see the comment at
#      server/index.js's /api/images/check-figure). `describe()` returns its
#      own `ok`, meaning "there is nothing odd about this LUT". The envelope
#      needs a separate one meaning "the call worked". Spread the report over
#      the envelope and "this LUT has an unusual domain" reaches a caller as
#      "your request failed" - which is a refusal of exactly the case the
#      route exists to explain.
#
#   4. server/mcp.js: one tool beside the catalog ones -
#
#          image_lut { name?, lut, strength?, interpolation?, info? }
#
#      with `info: true` returning the report and changing nothing. An agent
#      handed a `.cube` off the internet should be able to ASK what it is
#      before spending a render on it, and `describe()` is the only thing that
#      can answer - including the part of the answer that is "I cannot know
#      what space this expects, here is its title and what it does to grey".
#
#   5. `python server/imglut.py catalog` beside the other catalogs, so the MCP
#      schema and the UI panel are generated rather than typed.
#
#   6. .githooks/pre-commit: `"$PY" server/imglut_test.py || exit 1` beside the
#      imgselect / imgpath lines. scripts/suites_test.mjs is a census of every
#      suite on disk against that hook, so an unregistered suite FAILS the gate
#      rather than quietly not running - which means this line is not optional.
#
# Nothing else. This module owns no files, no job envelope and no pipeline; it
# takes a path and an array and hands back an array.
# ---------------------------------------------------------------------------
import json
import math
import os
import sys
import time

import numpy as np


# ---------------------------------------------------------------------------
# the limits, and every one of them is a REFUSAL THAT NAMES ITS NUMBER
# ---------------------------------------------------------------------------

# ⚠ TRAP 4. These are read off the HEADER, before a single entry is allocated.
# A `.cube` declares its size in one integer on one line, and `LUT_3D_SIZE
# 1000` is nine characters that ask for a billion entries - 12 GB as float32 -
# from a file that is four lines long. A module that discovers that while
# allocating has already handed the machine over.
LIMITS = {
    # 128^3 is 2,097,152 entries, 25 MB as float32. Real LUTs are 16, 17, 25,
    # 32, 33, 64 or 65; the Adobe spec's own ceiling is 256, which is 50 million
    # entries and 600 MB, so this sits deliberately under it. Nothing that has
    # ever been graded with needs more than 65.
    "max3dSize": 128,
    # The Adobe ceiling for 1D, taken rather than invented: a 1D table is three
    # curves and 65536 points is one per 16-bit code, past which there is
    # nothing left to resolve.
    "max1dSize": 65536,
    # A REFUSAL TO READ, not a cap on what may exist - imgdoc's shelf makes the
    # same distinction in the same words. A 128-point cube written out with
    # full precision is about 50 MB of text, so this clears the largest file
    # the size cap admits and refuses anything that cannot be one.
    "maxBytes": 128 * 1024 * 1024,
}

INTERPOLATIONS = ["tetrahedral", "trilinear", "nearest"]

# How many pixels go through the corner gather at once, before the picture is
# cut into row bands. Measured with tracemalloc on a megapixel of positions:
# 134 bytes of peak per pixel for tetrahedral (four gathered corners, the three
# fractions, the ranks and two index planes), 148 for trilinear's eight
# corners, 36 for nearest. So a 2M-pixel band peaks near 300 MB, and a
# 1344x768 video frame - 1.03 MP - is ONE band with room to spare.
#
# Banding is BIT-IDENTICAL rather than merely close, and imglut_test asserts
# that by shrinking this constant and comparing arrays: a LUT is a pointwise
# function, so a band boundary cannot be a seam the way it would be for a blur
# or a guided filter.
_BAND_PIXELS = 2_000_000

# The four values `describe()` reports the LUT's effect on. Black and white are
# where a wrong-space LUT gives itself away (a log LUT lifts 0.0 well off the
# floor, because log black is not zero), 0.18 is the grey every exposure
# decision is made against, and 0.5 is the middle of the code range.
_LANDMARKS = ((0.0, "black"), (0.18, "18% grey"), (0.5, "mid code"), (1.0, "white"))


class LutError(ValueError):
    """A LUT that cannot be read AS WRITTEN, or a request that cannot be
    honoured. Always carries a full sentence, because this file came off the
    internet or out of somebody else's software and the person holding it
    cannot read a traceback. Raised rather than swallowed: imgpath.PathError's
    argument verbatim - a caller handed a silent no-op has no way to learn what
    it did wrong."""


# ---------------------------------------------------------------------------
# the catalog - MCP and the UI are both generated from this
# ---------------------------------------------------------------------------

CATALOG = {}
GROUP_ORDER = ["Colour"]

# An agent will guess these, and a guess that works is a round trip saved.
ALIASES = {
    "cube": "lut", "colorLut": "lut", "colourLut": "lut", "lut3d": "lut",
    "3dlut": "lut", "lookup": "lut", "grade": "lut", "look": "lut",
    "filmLut": "lut", "applyLut": "lut",
    "lutInfo": "info", "readLut": "info", "inspect": "info",
    "identify": "info", "describeLut": "info",
}


def num(default, lo, hi, desc, integer=False, unit=None):
    p = {"type": "number", "default": default, "min": lo, "max": hi,
         "animatable": False, "desc": desc}
    if integer:
        p["integer"] = True
    if unit:
        p["unit"] = unit
    return p


def pick(options, default, desc):
    return {"type": "enum", "options": list(options), "default": default,
            "animatable": False, "desc": desc}


def text(default, desc):
    return {"type": "string", "default": default, "animatable": False,
            "desc": desc}


def op(name, label, group, why, params, where, **extra):
    """`where` is imgpath's convention and it is not decoration: half a catalog
    is fields of the job and half is calls the engine makes, and an agent
    reading a schema with no address on it posts the second kind into the first
    and gets a refusal it cannot learn from."""
    entry = {"label": label, "group": group, "why": why, "where": where,
             "params": params}
    entry.update(extra)
    CATALOG[name] = entry
    return entry


_LUT_PARAM = text(None,
                  "path to a .cube file (Adobe/IRIDAS), 3D or 1D. `.3dl` is "
                  "REFUSED with a sentence explaining why rather than guessed "
                  "at - see the module docstring. The file's own TITLE is "
                  "carried through to the reply, because it is usually the "
                  "only evidence of what the LUT was built for")

# ⚠ TRAP 3, IN THE SCHEMA. `nearest` is advertised so that the banding it
# produces can be MEASURED against the other two rather than asserted about,
# and its desc says so - a catalogued option nobody should pick has to explain
# itself or it reads as a supported choice.
_INTERP_PARAM = pick(
    INTERPOLATIONS, "tetrahedral",
    "how a colour between the LUT's grid points is found. `tetrahedral` splits "
    "each cell into six tetrahedra and interpolates in the one the colour "
    "falls in; the cell's grey diagonal is a tetrahedron EDGE, so a grey ramp "
    "comes back grey. `trilinear` is the floor - correct, standard, and "
    "MEASURABLY MORE ACCURATE than tetrahedral on arbitrary colours (0.00306 "
    "against 0.00381 max error on a 33-point cube over 160,000 samples), which "
    "is the opposite of the usual claim; what it cannot do is hold the grey "
    "axis, so it lays a faint hue ripple over a smooth neutral gradient that "
    "alternates sign at every cell boundary. Tetrahedral is the default "
    "because that ripple is visible on a sky and 20% more numeric error is "
    "not. `nearest` snaps to the closest grid point, is VISIBLY BANDED on a "
    "17- or 33-point LUT (0.0357 max error, nine 8-bit codes), and is here to "
    "be measured against rather than used. On a 1D LUT the first two are the "
    "same plain linear interpolation, which is all one dimension has")

op("lut", "Apply a LUT", "Colour",
   "Take a .cube file and put its look on the picture. This is how a grade "
   "travels: the LUT somebody built in a colourist's tool, or the film "
   "emulation out of a pack, lands here unchanged. ⚠ IT CANNOT KNOW WHAT SPACE "
   "THE FILE EXPECTS - a LUT built for log footage on an sRGB still looks "
   "milky and low-contrast and looks DELIBERATE, which is the single most "
   "common way this disappoints. Read the file with `info` first: it carries "
   "the LUT's own title through and reports what the LUT does to black, 18% "
   "grey and white, which is the evidence a person judges that on.",
   {"lut": _LUT_PARAM,
    # ⚠ PERCENT, NOT A FRACTION, AND THE TRAP IS THAT BOTH ARE LEGAL NUMBERS.
    # 0.5 here is half of one percent - very nearly a no-op - and a caller who
    # meant half the look gets a picture that looks untouched and no error.
    # It is a percentage because that is the number written on a grading panel
    # and on every LUT node with a mix on it, and because accepting both would
    # mean guessing which one 0.5 was.
    "strength": num(100, 0, 100,
                    "how much of the look, as a PERCENTAGE. 100 is the LUT "
                    "applied in full; 40 is 40% of it over the original, which "
                    "is how a film look is actually used. ⚠ THIS IS 0-100, NOT "
                    "0-1: `strength: 0.5` is half of one percent and will look "
                    "like nothing happened. 0 returns the picture bit-"
                    "identically and 100 returns the LUT's own output bit for "
                    "bit; in between it is a straight lerp in the values the "
                    "LUT handed back, not through any linearisation, because "
                    "linearising means knowing a transfer function this module "
                    "has already said it does not know", unit="%"),
    "interpolation": _INTERP_PARAM},
   "ops.lut (stage 5, with the adjustments), applied by "
   "imglut.apply(rgba, ops['lut'], mask, notes)",
   touchesAlpha=False)

op("info", "Read a LUT", "Colour",
   "Open a .cube and say what it is, WITHOUT applying it to anything: its "
   "title, whether it is 3D or 1D, how many points, its domain, how far it "
   "actually moves colour, and what it does to black, 18% grey and white. It "
   "also says plainly what it cannot tell you - nothing in the format records "
   "which colour space the LUT expects its input in, and no measurement of the "
   "table recovers it, so a guess there would be a guess that is right most of "
   "the time and silently disastrous the rest. Reports rather than refuses: an "
   "unusual domain is a finding, not a failed call.",
   {"lut": _LUT_PARAM},
   "imglut.describe(imglut.read_lut(path)) -> {kind, size, title, domain, "
   "identity, range, neutral, landmarks, cannotKnow, ok, problems, warnings} "
   "- a call, not a field of the job, and it needs no image")


def catalog():
    """What MCP and /api/image/catalog serve for lookup tables."""
    return {
        "ops": CATALOG,
        "groups": GROUP_ORDER,
        "names": sorted(CATALOG),
        "interpolations": list(INTERPOLATIONS),
        "limits": dict(LIMITS),
        "formats": {
            "read": [".cube"],
            "refused": {
                ".3dl": _THREEDL_REFUSAL,
            },
        },
        "aliases": ALIASES,
        "notes": [
            "A .cube is the Adobe/IRIDAS format and the one that matters: "
            "every grading tool exports it and every LUT pack ships it. "
            "LUT_3D_SIZE and LUT_1D_SIZE, DOMAIN_MIN/DOMAIN_MAX, TITLE, "
            "comments and both LF and CRLF line endings are all read.",
            "⚠ THE ONE THING THIS CANNOT KNOW IS WHAT COLOUR SPACE THE LUT "
            "EXPECTS. The format has no field for it. A film LUT built for log "
            "footage, applied to an sRGB picture, produces a washed-out "
            "low-contrast result that looks like a deliberate choice rather "
            "than a mistake - it is the single most common way this tool "
            "disappoints. `info` carries the LUT's own TITLE through (usually "
            "the only evidence there is) and reports what it does to black, "
            "18% grey and white; that is a reading for a person to judge, not "
            "a detection, and nothing here will claim otherwise.",
            "strength is 0-100, a PERCENTAGE. 0.5 is half of one percent, not "
            "half the look.",
            "Input outside the LUT's domain is CLAMPED to the edge of the "
            "table. That is deliberate: the alternatives are an index out of "
            "bounds, or a negative index that wraps round and reads a colour "
            "out of the opposite corner of the cube.",
            "Output values are clamped to 0..1 on the way out, because that is "
            "the range every other column in IMAGE_SPEC promises. A LUT whose "
            "table reaches past it says so in `info`'s `range`, so a clip is "
            "something you were told about rather than something that happened.",
            "Alpha is never touched. A LUT is a pointwise function, so unlike "
            "a blur or a warp it takes STRAIGHT alpha directly and must not be "
            "premultiplied first - that would grade the invisible colour under "
            "a transparent pixel into the visible one.",
            ".3dl is refused rather than guessed at. " + _THREEDL_REFUSAL,
        ],
    }


# ---------------------------------------------------------------------------
# reading a file that came from somebody else's software
# ---------------------------------------------------------------------------

def _note(msg, notes=None):
    """One honest line about something forgiven or clamped. A caller that
    passes a list gets it in the job result; everyone else gets it on stderr,
    because the failure this module must never have is the quiet one."""
    if notes is None:
        print(f"[imglut] {msg}", file=sys.stderr)
    else:
        notes.append(str(msg))


class Lut:
    """One lookup table, read and ready to apply.

    `table` is float32 and its layout is THE trap this module is about, so it
    is stated here rather than left to be inferred:

      * a 3D LUT is (size**3, 3) in the file's OWN row order - RED FASTEST.
        The entry for grid point (r, g, b) is at row r + g*size + b*size*size.
        It is kept in that order rather than reshaped into (r, g, b) axes
        precisely so that the index arithmetic is written out in one place and
        can be read against the spec; a reshape hides the convention inside an
        axis order nobody checks.
      * a 1D LUT is (size, 3): three independent curves that happen to share a
        file. Channel c reads column c at its own position, which is why a 1D
        LUT can never move a hue - it can only bend each axis.

    `domain_min` / `domain_max` are float32 (3,) and are NOT assumed to be
    0..1. See `_positions`.
    """
    __slots__ = ("kind", "size", "table", "domain_min", "domain_max", "title",
                 "path", "bytes", "lines", "warnings")

    def __init__(self, kind, size, table, domain_min, domain_max, title="",
                 path="", nbytes=0, lines=0, warnings=None):
        self.kind = kind                              # "3D" or "1D"
        self.size = int(size)
        self.table = np.ascontiguousarray(table, dtype=np.float32)
        self.domain_min = np.asarray(domain_min, np.float32).reshape(3)
        self.domain_max = np.asarray(domain_max, np.float32).reshape(3)
        self.title = str(title or "")
        self.path = str(path or "")
        self.bytes = int(nbytes)
        self.lines = int(lines)
        self.warnings = list(warnings or [])

    @property
    def entries(self):
        return int(self.table.shape[0])

    @property
    def unit_domain(self):
        return bool(np.all(self.domain_min == 0.0) and np.all(self.domain_max == 1.0))

    def __repr__(self):
        return (f"<Lut {self.kind} size={self.size} entries={self.entries} "
                f"title={self.title!r}>")


# The sentence, written once so the catalog, the refusal and the tests are the
# same words. The module docstring carries the argument at length.
_THREEDL_REFUSAL = (
    "This module reads .cube and refuses .3dl on purpose. Parsing a .3dl is "
    "easy; being right about it is not. Two incompatible conventions are in "
    "circulation (Lustre's and Flame/Nuke's), they disagree about which colour "
    "component varies fastest down the rows, and the bit depth of the integers "
    "is implied by the largest value in the file rather than stated. Both of "
    "those produce a picture that still looks like a grade when they are "
    "wrong, and there is no .3dl on this machine with a known-correct "
    "reference render to check an implementation against - so a .3dl reader "
    "here would be untested code whose only failure mode is a picture somebody "
    "does not like. Convert it to .cube in whatever wrote it, or in ociobakelut, "
    "and pass that."
)


def _clean(line):
    """A data or header line with its comment removed.

    `#` begins a comment in a .cube. It is stripped from anywhere in the line
    rather than only at the start, because trailing comments are common in
    files that real tools write even though the spec only describes whole-line
    ones. TITLE is handled before this is reached, so a `#` inside a quoted
    title is safe."""
    cut = line.find("#")
    return (line if cut < 0 else line[:cut]).strip()


def _title_of(line):
    """TITLE "Some Look". The quoted form is the spec's; the bare form turns up
    in hand-written files and is taken rather than dropped, because the title
    is the ONLY evidence this module has about what the LUT was built for and
    losing it to a missing pair of quotes would be a real loss."""
    rest = line[len("TITLE"):].strip()
    if len(rest) >= 2 and rest[0] == rest[-1] and rest[0] in "\"'":
        return rest[1:-1]
    return _clean(rest)


def _three(words, keyword, where):
    """DOMAIN_MIN/DOMAIN_MAX take three numbers. One number is accepted and
    broadcast, because IRIDAS's own LUT_3D_INPUT_RANGE is two numbers for all
    three channels and the two spellings meet here."""
    try:
        vals = [float(w) for w in words]
    except (TypeError, ValueError):
        raise LutError(f"{where}: {keyword} is not made of numbers "
                       f"({' '.join(words)!r}).") from None
    if len(vals) == 1:
        vals = vals * 3
    if len(vals) != 3:
        raise LutError(f"{where}: {keyword} wants three numbers, one per "
                       f"channel, and has {len(vals)}.")
    if not all(math.isfinite(v) for v in vals):
        raise LutError(f"{where}: {keyword} holds a value that is not a finite "
                       f"number ({' '.join(words)!r}).")
    return vals


def parse_cube(src, where="<string>", nbytes=0):
    """A .cube's text -> a Lut, or a LutError with a SENTENCE in it.

    Defensive on purpose. This file came from the internet or from somebody
    else's exporter, and the three ways it goes wrong - a truncated download, a
    size that does not match the rows, a header that claims a number no machine
    can hold - all arrive looking like ordinary text.
    """
    # A BOM is what a Windows text editor leaves behind, and it turns the first
    # keyword into something that matches nothing. Strip it rather than refusing
    # a file whose only sin is having been opened once in Notepad.
    if src.startswith("\ufeff"):
        src = src[1:]
    # splitlines() takes LF, CRLF and a bare CR, which is three line endings for
    # free; a manual split("\n") leaves a trailing "\r" on every CRLF line and
    # float("0.5\r") happens to work, so that bug would survive every test that
    # only reads numbers and would break only on the keyword lines.
    lines = src.splitlines()

    kind = None
    size = 0
    title = ""
    dmin = [0.0, 0.0, 0.0]
    dmax = [1.0, 1.0, 1.0]
    rows = []
    row_lines = []
    skipped = []
    warnings = []
    saw_size_line = None

    for n, raw in enumerate(lines, 1):
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        upper = stripped.upper()
        if upper.startswith("TITLE"):
            title = _title_of(stripped)
            continue
        body = _clean(stripped)
        if not body:
            continue
        words = body.split()
        key = words[0].upper()
        if key in ("LUT_3D_SIZE", "LUT_1D_SIZE"):
            want = "3D" if key == "LUT_3D_SIZE" else "1D"
            if kind is not None:
                raise LutError(
                    f"{where}: line {n} declares {key} but line {saw_size_line} "
                    f"already declared LUT_{kind}_SIZE. A .cube is one table or "
                    f"the other, and a file claiming both does not say which of "
                    f"its rows belong to which.")
            if len(words) < 2:
                raise LutError(f"{where}: line {n} says {key} with no number "
                               f"after it.")
            try:
                size = int(str(words[1]).strip())
            except (TypeError, ValueError):
                raise LutError(f"{where}: line {n} says {key} {words[1]!r}, "
                               f"which is not a whole number.") from None
            # ⚠ TRAP 4, AND IT IS CHECKED HERE - off the header, before a single
            # entry has been allocated. `size ** 3` is computed as a python int
            # so an absurd claim is compared rather than attempted; asking numpy
            # for the array first is how a four-line file takes the machine down.
            if want == "3D":
                cap = LIMITS["max3dSize"]
                if size < 2:
                    raise LutError(
                        f"{where}: LUT_3D_SIZE is {size}, and a 3D table needs "
                        f"at least 2 points per axis - one point has nothing to "
                        f"interpolate between and would flatten the whole "
                        f"picture to a single colour.")
                if size > cap:
                    raise LutError(
                        f"{where}: LUT_3D_SIZE is {size}, which is "
                        f"{size ** 3:,} entries. This reads up to {cap} "
                        f"({cap ** 3:,} entries, {cap ** 3 * 12 / (1024 ** 2):.0f} "
                        f"MB) and no LUT anyone grades with is past 65. Nothing "
                        f"was read.")
            else:
                cap = LIMITS["max1dSize"]
                if size < 2:
                    raise LutError(
                        f"{where}: LUT_1D_SIZE is {size}, and a curve needs at "
                        f"least 2 points to be a curve.")
                if size > cap:
                    raise LutError(
                        f"{where}: LUT_1D_SIZE is {size}, past the {cap:,} this "
                        f"reads - which is already one point per 16-bit code, so "
                        f"there is nothing left to resolve above it. Nothing was "
                        f"read.")
            kind, saw_size_line = want, n
            continue
        if key in ("DOMAIN_MIN", "DOMAIN_MAX"):
            vals = _three(words[1:], key, f"{where}: line {n}")
            if key == "DOMAIN_MIN":
                dmin = vals
            else:
                dmax = vals
            continue
        if key in ("LUT_3D_INPUT_RANGE", "LUT_1D_INPUT_RANGE"):
            # IRIDAS's older spelling of the same two lines, and it is TWO
            # numbers - a min and a max for all three channels - not three, so
            # it cannot go through `_three`. Read rather than ignored: a file
            # using this spelling still has a domain, and dropping it silently
            # is trap 2 arriving through the back door.
            try:
                pair = [float(w) for w in words[1:]]
            except (TypeError, ValueError):
                raise LutError(f"{where}: line {n}: {key} is not made of "
                               f"numbers ({body!r}).") from None
            if len(pair) != 2 or not all(math.isfinite(v) for v in pair):
                raise LutError(
                    f"{where}: line {n}: {key} wants two finite numbers - the "
                    f"low and high end of the input range - and has "
                    f"{len(pair)} ({body!r}).")
            dmin = [pair[0]] * 3
            dmax = [pair[1]] * 3
            warnings.append(
                f"the domain came from {key} (the older IRIDAS spelling) rather "
                f"than DOMAIN_MIN/DOMAIN_MAX; it is read as "
                f"{dmin[0]:g}..{dmax[0]:g} on all three channels")
            continue
        # ⚠ A LINE IS TABLE DATA IF AND ONLY IF IT STARTS WITH A NUMBER, and
        # that test is the whole classifier. The first draft asked whether the
        # first token was alphabetic, which reads a mangled row like
        # "red green blue" as an unrecognised HEADER and quietly drops it - the
        # file then comes up one row short and gets refused as a truncated
        # download, which is a true sentence pointing at the wrong line.
        try:
            float(words[0])
        except ValueError:
            # An unknown keyword is REPORTED, never dropped: IMAGE_SPEC §9's
            # rule, and here it matters more than usual, because a header this
            # does not understand may be the one that says what space the table
            # is in - the exact thing the module admits it cannot otherwise
            # know. `skipped` carries it into the row-count refusal below, so a
            # line dropped here can still be named as the reason the count is
            # wrong.
            warnings.append(f"line {n}: unknown keyword {words[0]!r}, ignored "
                            f"(the rest of the line was {body!r})")
            skipped.append((n, body))
            continue
        rows.append(body)
        row_lines.append(n)

    if kind is None:
        raise LutError(
            f"{where}: this file names neither LUT_3D_SIZE nor LUT_1D_SIZE, so "
            f"there is no way to know how its "
            f"{len(rows):,} row(s) are shaped. Either it is not a .cube, or the "
            f"header was lost - the size line is the one line a .cube cannot do "
            f"without.")
    if not rows:
        raise LutError(
            f"{where}: the header declares LUT_{kind}_SIZE {size} but there is "
            f"not one row of numbers after it. A .cube with a header and no "
            f"table is a truncated download.")

    want_rows = size ** 3 if kind == "3D" else size
    # The fast path and the precise path, and both are needed. Joining and
    # converting in one numpy call reads a 65-point cube (274,625 rows) in a
    # fraction of the time a per-line python loop takes; but when it fails it
    # fails with "could not convert string to float", which names nothing. So
    # the slow walk exists only to find the line and say which one it was.
    flat = None
    try:
        flat = np.array(" ".join(rows).split(), dtype=np.float32)
    except (TypeError, ValueError):
        flat = None
    if flat is not None and kind == "1D" and flat.size == len(rows):
        # A 1D .cube is three columns in the spec, but single-column files are
        # written by hand and by a couple of exporters, and one number per line
        # is unambiguous: the same curve on all three channels. Forgiven, and
        # said out loud rather than forgiven silently.
        #
        # ⚠ AND THIS HAS TO BE TESTED BEFORE `_diagnose_rows`, not after. The
        # first draft put it after, so a perfectly readable one-column file was
        # handed to the line-by-line walk, which counted one number where it
        # wanted three and refused it by line number. There is no ambiguity to
        # resolve here - len(rows)*3 equals len(rows) only for an empty file -
        # so the order is purely about which branch gets asked first.
        flat = np.repeat(flat, 3)
        warnings.append("this 1D LUT has one number per row rather than three; "
                        "it is read as the same curve on all three channels")
    elif flat is None or flat.size != len(rows) * 3:
        flat = _diagnose_rows(rows, row_lines, where)
        if flat is None:
            raise LutError(f"{where}: the table could not be read as numbers, "
                           f"and no single line explains why. The file is "
                           f"probably not a .cube.")

    if not np.all(np.isfinite(flat)):
        bad = int(np.argmax(~np.isfinite(flat)))
        line_no = row_lines[min(bad // 3, len(row_lines) - 1)]
        raise LutError(
            f"{where}: line {line_no} holds a value that is not a finite number "
            f"({rows[min(bad // 3, len(rows) - 1)]!r}). A NaN or an infinity in "
            f"a lookup table is not a colour, and interpolating through one "
            f"poisons every pixel that reaches that corner of the cube.")

    got_rows = flat.size // 3
    if got_rows != want_rows:
        what = (f"LUT_3D_SIZE {size}, which wants {want_rows:,} rows "
                f"({size}x{size}x{size})" if kind == "3D"
                else f"LUT_1D_SIZE {size}, which wants {want_rows:,} rows")
        short = "short by" if got_rows < want_rows else "over by"
        # If lines were skipped as unrecognised headers, SAY SO HERE. The count
        # being wrong and a line being unreadable are usually the same event,
        # and "short by 1" without naming the line the reader threw away sends
        # somebody hunting through 35,937 rows for a missing one that is
        # actually sitting there being unreadable.
        also = ""
        if skipped:
            n0, b0 = skipped[0]
            also = (f" {len(skipped)} line(s) were skipped as unknown headers, "
                    f"the first at line {n0} ({b0!r}) - if that was meant to be "
                    f"table data, that is where this stops being a .cube.")
        raise LutError(
            f"{where}: the header declares {what}, and the file holds "
            f"{got_rows:,} - {short} {abs(want_rows - got_rows):,}. "
            f"A truncated download looks exactly like this. Nothing was read, "
            f"because a table read at the wrong length is not a shorter grade, "
            f"it is a different one.{also}")

    table = flat.reshape(-1, 3)

    # ⚠ TRAP 2. A domain whose max is not above its min is not an unusual
    # domain, it is a division by zero: every input would map to +/-inf or NaN,
    # floor() of that is an undefined integer, and the gather would read
    # whatever is at index INT_MIN. An INVERTED domain (max below min) is worse
    # than a crash, because it silently runs the whole table backwards and the
    # picture still looks like a grade.
    for c, ch in enumerate("RGB"):
        if not (dmax[c] > dmin[c]):
            raise LutError(
                f"{where}: the {ch} domain is {dmin[c]:g}..{dmax[c]:g}, which is "
                f"empty or inverted. DOMAIN_MAX has to be above DOMAIN_MIN on "
                f"every channel - equal means every input maps to one entry, and "
                f"reversed means the table runs backwards and the picture still "
                f"looks like a grade.")
    if dmin != [0.0, 0.0, 0.0] or dmax != [1.0, 1.0, 1.0]:
        warnings.append(
            f"the domain is not 0..1: DOMAIN_MIN {', '.join(f'{v:g}' for v in dmin)} "
            f"/ DOMAIN_MAX {', '.join(f'{v:g}' for v in dmax)}. Input is scaled "
            f"into it before lookup and anything outside is clamped to the edge "
            f"of the table.")

    return Lut(kind, size, table, dmin, dmax, title=title, path=where,
               nbytes=nbytes, lines=len(lines), warnings=warnings)


def _diagnose_rows(rows, row_lines, where):
    """The slow walk, run only once the fast parse has already failed. Its job
    is to NAME THE LINE - "the table is malformed" is true and useless, and the
    person holding the file is looking at a text editor with line numbers in
    the margin."""
    out = np.empty((len(rows), 3), np.float32)
    for i, body in enumerate(rows):
        words = body.split()
        if len(words) != 3:
            raise LutError(
                f"{where}: line {row_lines[i]} has {len(words)} number(s) on it "
                f"({body!r}); every row of a .cube table is three - red, green, "
                f"blue. A row with a different count means the file is not what "
                f"its header says it is.")
        try:
            out[i] = [float(w) for w in words]
        except (TypeError, ValueError):
            raise LutError(
                f"{where}: line {row_lines[i]} is not three numbers ({body!r}). "
                f"That is where the table stops being readable.") from None
    return out.reshape(-1)


def read_lut(path, notes=None):
    """Open a LUT file. The door, and every refusal through it is a sentence.

    ⚠ THE SIZE CAP IS CHECKED TWICE AND BOTH ARE NEEDED. Here, against the file
    on disk, because reading 2 GB of text into a python string costs the RAM
    before anything can have an opinion about it; and again in `parse_cube`
    against the declared size, because a four-line file can claim a billion
    entries and would sail past a byte cap.
    """
    p = str(path or "")
    if not p:
        raise LutError("no LUT file was named. Pass the path of a .cube.")
    ext = os.path.splitext(p)[1].lower()
    if ext == ".3dl":
        raise LutError(f"{p}: {_THREEDL_REFUSAL}")
    if not os.path.isfile(p):
        raise LutError(f"there is no file at {p}. A LUT is a file on disk; "
                       f"nothing here downloads one.")
    size = os.path.getsize(p)
    if size > LIMITS["maxBytes"]:
        # Both numbers are spelled in whichever unit reads as a number rather
        # than as a rounded zero. The cap is 128 MB in production, but the test
        # lowers it to exercise this branch, and "past the 0 MB this will read"
        # is a sentence that makes the reader doubt the tool rather than the
        # file.
        def _sz(v):
            return (f"{v / (1024 ** 2):.0f} MB" if v >= 1024 ** 2
                    else f"{v:,} bytes")
        raise LutError(
            f"{p} is {_sz(size)}, past the {_sz(LIMITS['maxBytes'])} this will "
            f"read in one bite. The largest table it accepts - "
            f"{LIMITS['max3dSize']} points a side - writes out well under that, "
            f"so a file this big is not a LUT. Nothing was read.")
    if size == 0:
        raise LutError(f"{p} is empty (0 bytes). That is a download that did "
                       f"not finish, not a LUT.")
    if ext not in (".cube", ""):
        _note(f"{p} does not end in .cube; reading it as one anyway", notes)
    # errors="replace" rather than a refusal: a stray byte in a comment or a
    # title is not a reason to reject a table that is otherwise perfect, and the
    # numbers are ASCII whatever the header did.
    with open(p, "r", encoding="utf-8", errors="replace") as fh:
        src = fh.read()
    lut = parse_cube(src, where=p, nbytes=size)
    for w in lut.warnings:
        _note(f"{os.path.basename(p)}: {w}", notes)
    return lut


# ---------------------------------------------------------------------------
# applying it
# ---------------------------------------------------------------------------

def _positions(rgb, lut):
    """Input colour -> position in the table, 0..size-1 per axis.

    ⚠ TRAP 2 LIVES HERE. DOMAIN_MIN/DOMAIN_MAX are the input range the table
    was built over and they are NOT always 0..1 - a LUT for log footage
    routinely says 0..1 anyway while a LUT for extended-range linear says
    0..16. Ignoring those two header lines does not fail; it squashes or
    stretches the whole picture along every axis at once, which looks like a
    stronger or weaker grade rather than like a bug.

    ⚠ AND THE CLAMP IS DELIBERATE, NOT DEFENSIVE TIDYING. A value outside the
    domain has no answer in the table. Clamping gives it the nearest edge,
    which is what every applier does and is at least continuous with its
    neighbour. The two alternatives are worse in ways that do not announce
    themselves: leaving it alone indexes outside the array, and in numpy a
    NEGATIVE index does not raise - it wraps, and reads a colour out of the
    far corner of the cube.

    ⚠ NaN GETS ITS OWN LINE, because np.clip(nan) is nan. A NaN that reaches
    floor().astype(int32) becomes INT_MIN, which is a valid python index into
    nothing and gathers garbage or raises depending on the size of the table -
    a failure whose appearance depends on the LUT rather than on the bug.
    """
    if lut.unit_domain:
        # The common case, and it is short-circuited for SPEED, not for
        # correctness: (x - 0) / 1 is already exactly x in float32, so this
        # path and the general one agree bit for bit. imglut_test asserts that
        # rather than trusting the paragraph - a LUT whose header spells out
        # DOMAIN_MIN 0 / DOMAIN_MAX 1 takes the branch below and must come out
        # identical to one that omits both lines.
        t = np.nan_to_num(rgb, nan=0.0, posinf=1.0, neginf=0.0)
    else:
        t = (rgb - lut.domain_min) / (lut.domain_max - lut.domain_min)
        np.nan_to_num(t, nan=0.0, posinf=1.0, neginf=0.0, copy=False)
    np.clip(t, 0.0, 1.0, out=t)
    t *= np.float32(lut.size - 1)
    return t


def _lerp_into(a, b, f):
    """a <- a + f * (b - a), in place, and B IS CLOBBERED.

    The arithmetic is exactly the expression `a + f * (b - a)` in exactly that
    order, so every exactness argument in this file survives the rewrite; all
    that changes is that no new array is allocated. Only ever called on buffers
    np.take just produced, which nobody else holds a reference to - call it on a
    caller's array and you have silently rewritten their pixels, which is
    imgphoto's `np.may_share_memory` warning in a different key.
    """
    np.subtract(b, a, out=b)
    b *= f
    a += b


def _trilinear(lut, pos):
    """The floor, and it is a STAGED lerp - r, then g, then b - rather than a
    weighted sum of eight corners.

    That is not a stylistic choice. An IDENTITY LUT is the strongest pin this
    module has, and it only bites if identity comes back BIT-IDENTICAL. Staged,
    it does: each stage interpolates between two values that are equal on the
    two axes it is not moving along, so `a + f*(a - a)` is exactly `a`, and the
    one stage that does move is `i/(N-1) + f/(N-1)`, which is exact whenever
    N-1 is a power of two - 2, 5, 17, 33, 65, which is every LUT size anyone
    ships.

    The eight-corner weighted sum reaches the same number through eight
    roundings and does NOT, and that was run rather than reasoned: on a 33-point
    identity cube over two million random colours it is off on 26.8% of them, by
    up to 3 ulps (1.8e-07). Nothing a viewer could see - but the pin would have
    to be loosened from "bit-identical" to a tolerance, and a tolerance wide
    enough to admit that is wide enough to admit a real mistake.
    """
    n = lut.size
    i0 = np.floor(pos).astype(np.int32)
    np.clip(i0, 0, n - 2, out=i0)
    f = pos - i0
    # ⚠ TRAP 1, AND THIS IS THE LINE. A .cube 3D table varies RED FASTEST, so
    # the row for grid point (r, g, b) is at r + g*N + b*N*N. Swap the r and b
    # strides here and every LUT in the world still applies, still looks like a
    # grade, and is wrong. A symmetric test LUT agrees with both versions, which
    # is exactly why imglut_test pins this with an asymmetric one.
    base = i0[:, 0] + i0[:, 1] * n + i0[:, 2] * (n * n)
    t = lut.table
    dg, db = n, n * n
    fr = f[:, 0:1]
    fg = f[:, 1:2]
    fb = f[:, 2:3]
    # np.take rather than t[base]: the same answer, measured at 6.3 ms per
    # megapixel against 16.2 for fancy indexing on this rig, and eight of those
    # is 80 ms of this path.
    #
    # ⚠ AND ITS BOUNDS CHECK IS ONE-SIDED, WHICH IS WORTH KNOWING RATHER THAN
    # RELYING ON. np.take defaults to mode="raise", which does stop on an index
    # past the end of the table - measured: take(t, [99]) on a 4-row table
    # raises IndexError. It does NOT stop on a negative one; take(t, [-1])
    # returns the LAST row, exactly as ordinary indexing would. So a sign error
    # in the index arithmetic would read a colour out of the far corner of the
    # cube and say nothing. The clamp in `_positions` is what actually makes a
    # negative index impossible; this is a second net under it, on one side.
    c000 = np.take(t, base, axis=0)
    c100 = np.take(t, base + 1, axis=0)
    c010 = np.take(t, base + dg, axis=0)
    c110 = np.take(t, base + dg + 1, axis=0)
    c001 = np.take(t, base + db, axis=0)
    c101 = np.take(t, base + db + 1, axis=0)
    c011 = np.take(t, base + db + dg, axis=0)
    c111 = np.take(t, base + db + dg + 1, axis=0)
    # Written as in-place `lerp(a, b, f) -> a` on the gathered buffers rather
    # than as seven fresh expressions. np.take already handed us eight arrays
    # nobody else holds, so each lerp costs no allocation at all; the readable
    # spelling allocates a megapixel-sized (M, 3) temporary per operation,
    # which at 1344x768 is fourteen 12 MB round trips through memory that buy
    # nothing. The ORDER of operations is untouched, so the bit-exact identity
    # argument above still holds line for line.
    _lerp_into(c000, c100, fr)
    _lerp_into(c010, c110, fr)
    _lerp_into(c001, c101, fr)
    _lerp_into(c011, c111, fr)
    _lerp_into(c000, c010, fg)
    _lerp_into(c001, c011, fg)
    _lerp_into(c000, c001, fb)
    return c000


def _ranks(fr, fg, fb):
    """Which of the three fractions is largest, middle and smallest - 0, 1, 2 -
    with a tie-break that is consistent across all three.

    ⚠ THE RESULT MUST BE A PERMUTATION AT EVERY PIXEL, TIES INCLUDED, and that
    is what the mixed `>` and `>=` are for: the comparison against a lower-
    numbered channel is inclusive and the one against a higher-numbered channel
    is strict, so two equal fractions take the earlier channel's side every
    time. Get that wrong and a rank vector like (0, 0, 2) comes out, the
    selection below steps along the same axis twice and never along the third,
    and the four "corners" it interpolates between are not the corners of any
    tetrahedron - a picture, not a crash, and only on the tie surfaces where
    two fractions happen to be equal.

    ⚠ IT IS A FUNCTION RATHER THAN FOUR LINES INSIDE `_tetrahedral` FOR ONE
    REASON: so imglut_test can assert THIS code exhaustively instead of
    asserting its own copy of the same formula. It did the second thing first,
    and the deliberately-broken tie-break sailed straight past it - the test
    was checking that the test agreed with itself.

    Returns all three ranks. `_tetrahedral` needs only the first two, because
    if neither r nor g holds a rank then b does, which is what makes its nested
    selects exhaustive - but a caller checking the permutation needs the third.

    np.argsort on an (M, 3) array is the obvious spelling of this, and it costs
    42 ms per megapixel on this rig against 6 for these three lines: a sort of
    three elements, performed by a general-purpose sorter, a million times over.
    """
    rank_r = (fg > fr).astype(np.int8) + (fb > fr)
    rank_g = (fr >= fg).astype(np.int8) + (fb > fg)
    rank_b = (fr >= fb).astype(np.int8) + (fg >= fb)
    return rank_r, rank_g, rank_b


def _tetrahedral(lut, pos):
    """The default. Each cell is cut into six tetrahedra by the order of the
    three fractions, and the colour is the barycentric combination of the four
    corners of the one it falls in:

        out = c0 + d1*(cA - c0) + d2*(cB - cA) + d3*(c1 - cB)

    where d1 >= d2 >= d3 are the fractions sorted descending, c0 is the low
    corner, c1 the high one, cA is c0 stepped along the LARGEST fraction's axis
    and cB is cA stepped along the second largest. All six classical cases are
    that one expression with the axes permuted, which is why this is a sort and
    six numpy lines rather than a six-branch cascade.

    WHAT IT BUYS, and the module docstring has the measurement: at d1 = d2 = d3
    the expression collapses to c0 + t*(c1 - c0) - the cell's grey diagonal is
    a tetrahedron EDGE, so a neutral input interpolates exactly along the line
    between the two grey corners. Trilinear's eight weights do not reduce to
    that, so a grey ramp through a neutral LUT picks up a faint hue ripple that
    changes sign at every cell boundary. That is the one error in this file
    that shows up on a picture instead of only in a number.

    Ties do not need a rule. Where two fractions are equal the tetrahedra
    concerned share the face the colour is on, so all the candidate expressions
    give the same answer; which one the tie-break below picks decides nothing
    visible. It still has to be CONSISTENT - a rank vector that is not a
    permutation would step twice along one axis and never along another, and
    that is a picture, not a crash - which is why the three lines use `>` on
    one side of the diagonal and `>=` on the other.

    The three fractions are SELECTED rather than derived. The tempting shortcut
    for the middle one is `fr + fg + fb - max - min`, the standard trick, and
    it is not exact in float32 - measured, it disagrees with the selected
    median on 51% of a four-million-sample sweep, by up to 2.4e-07.

    ⚠ AND THAT SHORTCUT WAS RUN, AND NOTHING HERE CAN TELL THE DIFFERENCE, so
    the claim this comment used to make is withdrawn rather than left standing.
    It said the subtraction would cost the identity pin; it does not. The error
    lands on the coefficient of a difference between two adjacent table
    entries, which for an identity LUT is 1/(N-1), so 2.4e-07 arrives at the
    output divided by 32 - a quarter of a float32 ulp, which rounds away. The
    whole suite passes with the shortcut in place. The selection is kept
    because it IS the median by construction rather than by a bound that
    happens to hold, and because it costs the same three np.where calls the
    other two fractions already pay for - not because a test is watching it.
    """
    n = lut.size
    i0 = np.floor(pos).astype(np.int32)
    np.clip(i0, 0, n - 2, out=i0)
    f = pos - i0
    # ⚠ TRAP 1 AGAIN, and it has to be written out here too rather than shared,
    # because the two interpolators are the two places the convention can drift
    # apart from each other. Red fastest: r + g*N + b*N*N.
    n2 = n * n
    base = i0[:, 0] + i0[:, 1] * n + i0[:, 2] * n2
    fr, fg, fb = f[:, 0], f[:, 1], f[:, 2]
    rank_r, rank_g, _ = _ranks(fr, fg, fb)
    d1 = np.where(rank_r == 0, fr, np.where(rank_g == 0, fg, fb))
    d2 = np.where(rank_r == 1, fr, np.where(rank_g == 1, fg, fb))
    d3 = np.where(rank_r == 2, fr, np.where(rank_g == 2, fg, fb))
    s1 = np.where(rank_r == 0, 1, np.where(rank_g == 0, n, n2)).astype(np.int32)
    s2 = s1 + np.where(rank_r == 1, 1,
                       np.where(rank_g == 1, n, n2)).astype(np.int32)
    t = lut.table
    c0 = np.take(t, base, axis=0)                      # np.take: see _trilinear
    ca = np.take(t, base + s1, axis=0)
    cb = np.take(t, base + s2, axis=0)
    c1 = np.take(t, base + (n2 + n + 1), axis=0)
    # out = c0 + d1*(cA - c0) + d2*(cB - cA) + d3*(c1 - cB), accumulated left to
    # right and in place. The differences are taken from the TOP down so that
    # each one still sees the corner it needs before that corner is clobbered.
    np.subtract(c1, cb, out=c1)
    c1 *= d3[:, None]
    np.subtract(cb, ca, out=cb)
    cb *= d2[:, None]
    np.subtract(ca, c0, out=ca)
    ca *= d1[:, None]
    c0 += ca
    c0 += cb
    c0 += c1
    return c0


def _nearest(lut, pos):
    """Snap to the closest grid point. Advertised so the banding can be counted
    rather than described: on a 33-point LUT this quantises every channel to 33
    levels, which is plainly visible on any gradient and is what a LUT
    implementation that forgot to interpolate looks like."""
    n = lut.size
    i = np.rint(pos).astype(np.int32)
    np.clip(i, 0, n - 1, out=i)
    return np.take(lut.table, i[:, 0] + i[:, 1] * n + i[:, 2] * (n * n), axis=0)


def _apply_1d(lut, pos, mode):
    """Three independent curves. A 1D LUT cannot move a hue - it can only bend
    each axis - so the interpolation choice collapses: trilinear and
    tetrahedral are both plain linear interpolation in one dimension, and only
    `nearest` is a different answer."""
    n = lut.size
    if mode == "nearest":
        i = np.rint(pos).astype(np.int32)
        np.clip(i, 0, n - 1, out=i)
        cols = np.arange(3)
        return lut.table[i, cols[None, :]]
    i0 = np.floor(pos).astype(np.int32)
    np.clip(i0, 0, n - 2, out=i0)
    f = pos - i0
    cols = np.arange(3)
    lo = lut.table[i0, cols[None, :]]
    hi = lut.table[i0 + 1, cols[None, :]]
    return lo + f * (hi - lo)


_INTERP = {"trilinear": _trilinear, "tetrahedral": _tetrahedral,
           "nearest": _nearest}


def lookup(rgb, lut, interpolation="tetrahedral"):
    """The raw table lookup on an (M, 3) float32 array, no strength and no
    clamp. Exposed because a test that wants to measure the interpolator's
    error has no business going through the blend and the clip as well."""
    arr = np.asarray(rgb, np.float32).reshape(-1, 3)
    mode = interpolation if interpolation in _INTERP else "tetrahedral"
    pos = _positions(arr, lut)
    if lut.kind == "1D":
        return _apply_1d(lut, pos, mode)
    return _INTERP[mode](lut, pos)


def apply_lut(rgba, lut, strength=100.0, interpolation="tetrahedral",
              mask=None, notes=None):
    """Put the LUT on the picture.

    `rgba` is float32 (H, W, 3) or (H, W, 4), 0..1, straight alpha. The same
    shape comes back and ALPHA IS UNTOUCHED - copied through, not recomputed.

    `lut` is a Lut, or a path, which is read here. A video render applying one
    LUT to a thousand frames should call `read_lut` once and pass the Lut: the
    file is the same file every frame and re-parsing 274,625 rows per frame is
    the kind of waste that hides behind a per-frame timing that looks fine.

    `strength` is 0-100, a PERCENTAGE. `mask` is imgselect's float32 (H, W)
    0..1 selection, and it scales the strength per pixel rather than
    cross-fading two finished pictures - the same distinction imgpath's liquify
    makes, and for the same reason.
    """
    if isinstance(lut, (str, bytes, os.PathLike)):
        lut = read_lut(lut, notes)
    if not isinstance(lut, Lut):
        raise LutError("apply_lut needs a Lut from read_lut(), or the path of "
                       "a .cube to read.")
    arr = np.asarray(rgba)
    if arr.ndim != 3 or arr.shape[2] not in (3, 4):
        raise LutError(f"a LUT applies to float32 (H, W, 3) or (H, W, 4) 0..1 "
                       f"RGB(A); this is {arr.shape}.")
    if not np.issubdtype(arr.dtype, np.floating):
        raise LutError("a LUT applies to a FLOAT image 0..1. An integer array "
                       "is 0..255 and would land entirely on the white corner "
                       "of the table.")
    mode = interpolation if interpolation in _INTERP else "tetrahedral"
    if interpolation not in _INTERP and interpolation is not None:
        _note(f"interpolation={interpolation!r} is not one of "
              f"{INTERPOLATIONS}; using {mode!r}", notes)
    s = float(strength) if strength is not None else 100.0
    if not math.isfinite(s):
        s = 100.0
    s = min(max(s, 0.0), 100.0) / 100.0

    src = arr.astype(np.float32, copy=False)
    h, w = src.shape[:2]

    m = None
    if mask is not None:
        m = np.asarray(mask, np.float32)
        if m.shape[:2] != (h, w):
            raise LutError(f"the selection mask is {m.shape}, and the picture "
                           f"is {(h, w)}.")
        m = np.clip(m.reshape(h, w), 0.0, 1.0)

    # Strength 0 with no mask is the input, bit for bit, and it costs one
    # branch rather than a full table walk that would have to be exactly
    # cancelled afterwards. A mask cannot rescue a global zero, so this is safe
    # to take before the mask is considered.
    if s <= 0.0:
        _note("strength is 0, so the LUT changed nothing. Remember strength is "
              "a PERCENTAGE: 0.5 is half of one percent", notes)
        return np.array(src, dtype=np.float32, copy=True)

    out = np.empty_like(src)
    if src.shape[2] == 4:
        # ALPHA IS COPIED, NOT COMPUTED. A LUT has no opinion about coverage,
        # and this is the line that makes "alpha untouched" a property of the
        # code rather than of an arithmetic identity that might not hold.
        out[..., 3] = src[..., 3]

    # Banded BY ROWS, because the gather holds several band-sized planes at
    # once - see _BAND_PIXELS. The bands are bit-identical to one slab, since
    # a LUT is pointwise and a band boundary cannot be a seam; and banding on
    # rows rather than on flat pixels keeps every slice a strided VIEW of the
    # caller's picture, so a frame is never copied whole just to be indexed.
    rows = max(1, _BAND_PIXELS // max(1, w))
    kind1d = lut.kind == "1D"
    fn = _INTERP[mode]
    # Decided once, not per band: the fully-selected-at-full-strength restore
    # below is only meaningful when a mask exists, is at full strength, and
    # actually reaches 1 somewhere. A feathered rim that never touches 1 pays
    # nothing for it.
    restore_ones = m is not None and s >= 1.0 and float(m.max()) >= 1.0
    for y0 in range(0, h, rows):
        y1 = min(y0 + rows, h)
        sub = src[y0:y1, :, :3]
        # `_positions` allocates its own contiguous result from this strided
        # view, so reshaping it to (M, 3) below is free.
        pos = _positions(sub, lut).reshape(-1, 3)
        graded = _apply_1d(lut, pos, mode) if kind1d else fn(lut, pos)
        graded = graded.reshape(y1 - y0, w, 3)
        # The 0..1 promise, enforced here rather than trusted from the table. A
        # LUT whose entries reach past 1.0 is legal and not rare (they carry
        # highlight headroom for a float pipeline), and `describe()` reports it
        # under `range`, so this clip is something a caller was told about
        # rather than something that happened to their highlights.
        np.clip(graded, 0.0, 1.0, out=graded)
        if m is None and s >= 1.0:
            out[y0:y1, :, :3] = graded             # the LUT's own output, exact
            continue
        # ⚠ THE BLEND IS A PLAIN LERP IN THE SPACE THE LUT OUTPUT LANDED IN,
        # and the module docstring argues it at length. The short version: the
        # respectable-sounding alternative is to linearise both sides, mix
        # there and re-encode - which needs the transfer function of the LUT's
        # output space, which is the exact thing this module has already said
        # it cannot know. Blending through a GUESSED gamma is a guess wearing
        # the clothes of rigour, and it would cost the two properties that make
        # this testable: strength 0 bit-identical in, strength 100 bit-
        # identical out.
        #
        # ⚠ NEITHER SPELLING OF A LERP IS EXACT AT BOTH ENDS, SO THE ENDS ARE
        # RESTORED BY COPY - which is imgselect.blend's answer to the same
        # problem, in the same words ("the two extremes are then restored by
        # copy rather than left to arithmetic").
        #
        # `s + k*(g - s)` is exact at k == 0, and exact WHENEVER g == s, which
        # is the identity LUT at every strength and under every mask - the
        # strongest pin in imglut_test and the one that stands in front of
        # every other error in this file. It is not exact at k == 1.
        # `g*k + s*(1 - k)` is exact at both k == 0 and k == 1, and is NOT
        # exact when g == s. It was tried, and it cost the identity pin.
        #
        # So: the first form, plus a copy where the mask is fully 1 at full
        # strength - narrow enough that the extra buffer is only allocated on
        # that path, and it is what makes "inside the selection you get the
        # LUT's own output, bit for bit" a true sentence rather than a true-to-
        # a-rounding-error one.
        k = np.float32(s) if m is None else (m[y0:y1, :, None] * np.float32(s))
        raw = graded.copy() if restore_ones else None
        graded -= sub
        graded *= k
        graded += sub
        if restore_ones:
            np.copyto(graded, raw, where=(k >= np.float32(1.0)))
        out[y0:y1, :, :3] = graded
    return out


def _coerce(spec, src, where="", notes=None):
    """Catalog defaults, clamped ranges, and unknown keys REPORTED rather than
    dropped - imgpath's `_coerce` with the two types this module has."""
    src = src if isinstance(src, dict) else {}
    extra = sorted(set(src) - set(spec))
    if extra:
        _note(f"{where}ignoring parameter(s) not in the catalog: "
              f"{', '.join(extra)}", notes)
    out = {}
    for key, p in spec.items():
        v = src.get(key, p["default"])
        kind = p["type"]
        if kind == "number":
            try:
                v = float(v)
            except (TypeError, ValueError):
                v = float(p["default"])
            if not math.isfinite(v):
                v = float(p["default"])
            v = min(max(v, float(p["min"])), float(p["max"]))
            if p.get("integer"):
                v = int(round(v))
        elif kind == "bool":
            v = bool(v)
        elif kind == "enum":
            if v is None:
                v = p["default"]
            elif v not in p["options"]:
                _note(f"{where}{key}={v!r} is not one of {p['options']}; using "
                      f"{p['default']!r}", notes)
                v = p["default"]
        elif kind == "string":
            v = None if v is None else str(v)
        out[key] = v
    return out


def apply(rgba, spec, mask=None, notes=None):
    """ops.lut, coerced against the catalog and applied. The engine's entry
    point; `apply_lut` is the one to call from python when the Lut is already
    in hand."""
    if isinstance(spec, (str, bytes, os.PathLike)):
        spec = {"lut": str(spec)}
    p = _coerce(CATALOG["lut"]["params"], spec, "lut: ", notes)
    if not p["lut"]:
        raise LutError("ops.lut needs a `lut`: the path of a .cube file.")
    return apply_lut(rgba, p["lut"], p["strength"], p["interpolation"],
                     mask=mask, notes=notes)


# ---------------------------------------------------------------------------
# saying what a LUT is, including the part that cannot be said
# ---------------------------------------------------------------------------

# ⚠ THE SENTENCE THAT IS THE HONEST ANSWER TO TRAP 5. It rides on every report,
# always, rather than being a warning that only appears when something is
# suspected - because nothing is ever suspected. There is no measurement of a
# table that recovers the space it was built for.
_CANNOT_KNOW = (
    "Nothing in a .cube records which colour space the LUT expects its input "
    "in, and no measurement of the table recovers it - so this cannot tell you "
    "whether it wants log footage, sRGB, Rec.709 or something else. That "
    "matters more than any number here: a film LUT built for log, applied to "
    "an sRGB picture, comes back milky and low-contrast and looks like a "
    "choice somebody made rather than like a mistake. The title and the "
    "landmarks below are the evidence a person judges that on - a LUT that "
    "lifts black well off the floor was probably built for log, because log "
    "black is not zero - but they are a reading, not a detection."
)


def _identity_grid(lut):
    """The table an identity LUT of this size and domain would hold: the input
    value at each grid point. Against the DOMAIN, not against 0..1, because a
    LUT over a 0..4 domain is the identity when its entries run 0..4."""
    n, span = lut.size, (lut.domain_max - lut.domain_min)
    ramp = (np.arange(n, dtype=np.float32) / np.float32(n - 1))
    if lut.kind == "1D":
        return lut.domain_min[None, :] + ramp[:, None] * span[None, :]
    # Red fastest - the same convention as the lookup, written the same way.
    r = np.tile(ramp, n * n)
    g = np.tile(np.repeat(ramp, n), n)
    b = np.repeat(ramp, n * n)
    return lut.domain_min[None, :] + np.stack([r, g, b], 1) * span[None, :]


def describe(lut, notes=None):
    """What the LUT is, what it does, and what this cannot tell you.

    ⚠ `ok` HERE MEANS "there is nothing odd about this LUT", NOT "the call
    worked". The two need different words and imgpath.check_figure paid for
    that lesson: a route that spreads this report over its envelope answers
    `ok: false` for a LUT with an unusual domain, and every caller reads a
    top-level false as a failed request - a refusal of exactly the case the
    route exists to explain. The CLI below keeps them apart and so must the
    route.
    """
    if not isinstance(lut, Lut):
        raise LutError("describe() needs a Lut from read_lut().")
    problems, warnings = [], list(lut.warnings)

    ident = _identity_grid(lut)
    ident_err = float(np.abs(lut.table - ident).max())
    lo = [float(v) for v in lut.table.min(axis=0)]
    hi = [float(v) for v in lut.table.max(axis=0)]
    outside = bool(min(lo) < -1e-6 or max(hi) > 1.0 + 1e-6)

    # How far the LUT pushes a NEUTRAL input off neutral. Not a fault - plenty
    # of looks tint the greys on purpose, which is half of what a look IS - but
    # it is the number a person wants when a picture has come back with a cast
    # they did not ask for.
    if lut.kind == "3D":
        n = lut.size
        diag = np.arange(n, dtype=np.int64) * (1 + n + n * n)
        greys = lut.table[diag]
    else:
        greys = lut.table
    drift = float(np.abs(greys - greys.mean(axis=1, keepdims=True)).max())

    probe = np.asarray([[v, v, v] for v, _ in _LANDMARKS], np.float32)
    # Through the REAL path, tetrahedral and full strength, so the numbers
    # reported are the numbers a picture would get and not a second
    # implementation that could drift from it.
    got = np.clip(lookup(probe, lut, "tetrahedral"), 0.0, 1.0)
    landmarks = [{"name": name, "in": round(float(v), 4),
                  "out": [round(float(c), 4) for c in got[i]]}
                 for i, (v, name) in enumerate(_LANDMARKS)]

    if ident_err <= 1e-6:
        problems.append(
            f"this LUT is the identity to {ident_err:.1e} - it maps every "
            f"colour to itself, so applying it will change nothing. That is "
            f"usually a LUT that was exported from a session with the grade "
            f"switched off.")
    if float(np.abs(lut.table - lut.table[0]).max()) <= 1e-6:
        problems.append(
            "every entry in this LUT is the same colour, so applying it would "
            "flatten the whole picture to that one colour. The file is "
            "corrupt or was exported from an empty session.")
    if outside:
        warnings.append(
            f"the table reaches outside 0..1 (red {lo[0]:.3f}..{hi[0]:.3f}, "
            f"green {lo[1]:.3f}..{hi[1]:.3f}, blue {lo[2]:.3f}..{hi[2]:.3f}). "
            f"That is legal - it is highlight headroom for a float pipeline - "
            f"but this editor's buffers are 0..1, so the output is clamped and "
            f"whatever was above white comes back as white.")
    if drift > 0.02:
        warnings.append(
            f"this LUT moves neutral grey off neutral by up to {drift:.3f} "
            f"(about {drift * 255:.0f} of 255), so greys will pick up a cast. "
            f"Plenty of looks do that deliberately; it is here because it is "
            f"the first thing a person notices and the last thing they think "
            f"to check.")
    if not lut.title:
        warnings.append(
            "this file carries no TITLE. That string is usually the only "
            "evidence of what the LUT was built for - what it expects at its "
            "input, and what it hands back - so without it there is nothing to "
            "read but the numbers below.")

    return {
        "ok": not problems,
        "kind": lut.kind,
        "size": lut.size,
        "entries": lut.entries,
        "title": lut.title,
        "path": lut.path,
        "bytes": lut.bytes,
        "lines": lut.lines,
        "domain": {"min": [float(v) for v in lut.domain_min],
                   "max": [float(v) for v in lut.domain_max],
                   "unit": lut.unit_domain},
        "identity": {"maxError": round(ident_err, 6),
                     "isIdentity": bool(ident_err <= 1e-6)},
        "range": {"min": [round(v, 4) for v in lo],
                  "max": [round(v, 4) for v in hi],
                  "outsideUnit": outside},
        "neutral": {"maxDrift": round(drift, 6)},
        "landmarks": landmarks,
        "cannotKnow": _CANNOT_KNOW,
        "problems": problems,
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# the measurements - run by the CLI's bench and by imglut_test
# ---------------------------------------------------------------------------

def _reference_grade(rgb):
    """A smooth analytic grade with real cross-channel mixing in it, used as
    the ground truth the interpolators are scored against.

    Cross-channel on purpose: a per-channel curve is separable, and a separable
    function is reproduced EXACTLY by trilinear interpolation of its own table,
    so scoring against one would report zero error for both interpolators and
    prove nothing. The mix is what makes the cell interiors actually curve.
    """
    x = np.clip(np.asarray(rgb, np.float32).reshape(-1, 3), 0.0, 1.0)
    mix = np.asarray([[0.86, 0.10, 0.04],
                      [0.06, 0.88, 0.06],
                      [0.03, 0.12, 0.85]], np.float32)
    y = x @ mix.T
    y = np.clip(y, 0.0, 1.0)
    out = np.empty_like(y)
    for c, gamma in enumerate((0.82, 1.00, 1.24)):
        out[:, c] = np.power(y[:, c], gamma)
    # A gentle S on top, so the function is not monotone-simple in any axis.
    return np.clip(out + 0.06 * np.sin(out * math.pi * 2.0), 0.0, 1.0)


def bake(fn, size=33, title="baked"):
    """Turn a function into a Lut of the given size - the LUT an exporter would
    have written for that grade. Used by the measurement below and by the test
    fixtures, so the thing being measured is a real table and not a special
    code path."""
    n = size
    ramp = np.arange(n, dtype=np.float32) / np.float32(n - 1)
    r = np.tile(ramp, n * n)
    g = np.tile(np.repeat(ramp, n), n)
    b = np.repeat(ramp, n * n)
    grid = np.stack([r, g, b], 1)
    return Lut("3D", n, np.asarray(fn(grid), np.float32).reshape(-1, 3),
               [0, 0, 0], [1, 1, 1], title=title, path="<baked>")


def _neutral_grade(rgb):
    """A NON-SEPARABLE grade that is exactly neutral-preserving: r == g == b
    goes in, r == g == b comes out, and nothing else about it is separable.

    This one exists to isolate the property tetrahedral is chosen FOR, and
    THREE things about it are load-bearing - the third was discovered by the
    measurement coming back zero for both interpolators, which is the whole
    reason this is measured rather than asserted.

      * Neutral-preserving, so that any chroma on the output ramp is the
        interpolator's invention and not the grade's.
      * Non-separable, because a per-channel curve is reproduced identically by
        BOTH schemes (each output channel then depends on one input axis, and
        both are linear along a single axis), so a separable test LUT reports
        them equal and proves nothing. The exponent is driven by the mean,
        which is what couples the axes; on the grey diagonal the mean equals
        the channel and every exponent is exactly 1.
      * ⚠ AND NOT SYMMETRIC UNDER A CHANNEL SWAP. The first version of this
        used one coupling constant for all three channels, which makes the
        grade invariant under permuting r, g and b - and on the grey diagonal
        trilinear's eight weights are themselves permutation-symmetric, so the
        off-diagonal corners cancel exactly and TRILINEAR ALSO CAME BACK
        PERFECTLY NEUTRAL. A measurement that reports no difference because the
        test case was accidentally symmetric is the same class of mistake as a
        symmetric LUT missing a transposed axis, two hundred lines up. The
        three constants below differ, including in sign.
    """
    x = np.clip(np.asarray(rgb, np.float32).reshape(-1, 3), 0.0, 1.0)
    lum = x.mean(axis=1, keepdims=True)
    k = np.asarray([0.90, 0.25, -0.55], np.float32)
    return np.clip(np.power(x, 1.0 + k * (lum - x)), 0.0, 1.0)


def _measure_interp(size=33, samples=400):
    """Tetrahedral against trilinear against nearest, on real gradients.

    TWO MEASUREMENTS, because they answer different questions.

    `sweep` is a dense random walk of the whole colour cube through
    `_reference_grade`, scored against the exact function. It says what error
    an arbitrary colour sees, and it is where the two good interpolators are
    close.

    `neutral` is a grey ramp through `_neutral_grade`, whose output on that
    ramp is exactly neutral by construction - so `hueSpread` is entirely the
    interpolator's invention, and it is the number a VIEWER sees. A hue spread
    on a grey ramp is a faint colour ripple in a sky, a wall or a face in soft
    light, alternating sign at every cell boundary. It is the one error in this
    file that shows up on a picture rather than only in a table.
    """
    out = {"size": size, "samples": int(samples * samples)}
    lut = bake(_reference_grade, size)
    rng = np.random.default_rng(11)
    sweep = rng.random((samples * samples, 3), dtype=np.float32)
    truth_sweep = _reference_grade(sweep)

    neutral_lut = bake(_neutral_grade, size)
    ramp = np.linspace(0.0, 1.0, samples * samples, dtype=np.float32)
    grey = np.stack([ramp, ramp, ramp], 1)
    truth_grey = _neutral_grade(grey)

    for mode in INTERPOLATIONS:
        gs = lookup(sweep, lut, mode)
        gg = lookup(grey, neutral_lut, mode)
        out[mode] = {
            "sweepMax": round(float(np.abs(gs - truth_sweep).max()), 6),
            "sweepRms": round(float(np.sqrt(((gs - truth_sweep) ** 2).mean())), 6),
            "neutralMax": round(float(np.abs(gg - truth_grey).max()), 6),
            # The whole point: the truth is neutral everywhere on this ramp, so
            # any spread between the three output channels was invented here.
            "hueSpread": round(float(
                np.abs(gg - gg.mean(axis=1, keepdims=True)).max()), 8),
        }
    return out


def _bench(size=33, mp=1.0, reps=3):
    """Milliseconds per megapixel, which is the number that decides whether
    this can sit in a video render at all. A 1344x768 H3 frame is 1.03 MP."""
    lut = bake(_reference_grade, size)
    n = int(mp * 1_000_000)
    side = int(math.sqrt(n))
    rng = np.random.default_rng(3)
    img = np.empty((side, side, 4), np.float32)
    img[..., :3] = rng.random((side, side, 3), dtype=np.float32)
    img[..., 3] = 1.0
    megapixels = side * side / 1_000_000.0
    out = {}

    def timed(name, fn):
        fn()
        best = math.inf
        for _ in range(reps):
            t = time.perf_counter()
            fn()
            best = min(best, time.perf_counter() - t)
        out[name] = round(best * 1000.0 / megapixels, 1)

    for mode in INTERPOLATIONS:
        timed(f"{mode}", lambda m=mode: apply_lut(img, lut, 100, m))
    timed("tetrahedral @ 40%", lambda: apply_lut(img, lut, 40, "tetrahedral"))
    timed("tetrahedral, rgb only",
          lambda: apply_lut(img[..., :3], lut, 100, "tetrahedral"))
    out["megapixels"] = round(megapixels, 3)
    out["lutSize"] = size
    return out


# ---------------------------------------------------------------------------
# the CLI - the {mode, jobPath} shape every module here is spawned with
# ---------------------------------------------------------------------------

def _read_job(argv, mode):
    if len(argv) < 3:
        raise LutError(f"{mode} needs the path of a job file holding "
                       f"{{\"lut\": \"<path to .cube>\"}}.")
    with open(argv[2], encoding="utf-8") as fh:
        return json.loads(fh.read())


def _cli_info(argv):
    job = _read_job(argv, "info")
    path = job.get("lut") or job.get("path") or job.get("file") \
        if isinstance(job, dict) else job
    notes = []
    lut = read_lut(path, notes)
    # ⚠ TWO WORDS FOR TWO THINGS. `ok` on the envelope is "the call worked";
    # `ok` inside `report` is "there is nothing odd about this LUT". A LUT with
    # an unusual domain is a successful reading, not a failed request, and
    # collapsing them makes the route refuse the case it exists for.
    return {"ok": True, "report": describe(lut, notes), "notes": notes or None}


def _cli_apply(argv):
    # Lazy AND guarded, the way imgselect reaches imgpath. Pillow is only
    # needed to turn a file into pixels and back; every library function above
    # takes an array, so a machine without it keeps the whole module and loses
    # only this one door - and it is told so in a sentence rather than through
    # an ImportError a route would surface as "apply failed".
    try:
        from PIL import Image                            # noqa: PLC0415
    except ImportError as exc:                           # noqa: BLE001
        raise LutError(f"the apply door needs Pillow to read and write the "
                       f"image, and it is not on this python ({exc}). "
                       f"imglut.apply_lut(array, lut) itself needs only numpy, "
                       f"so a caller that already holds pixels is unaffected.") \
            from None
    job = _read_job(argv, "apply")
    if not isinstance(job, dict):
        raise LutError("the apply job must be an object with `in`, `out` and "
                       "`lut` in it.")
    src, dst = job.get("in"), job.get("out")
    if not src or not dst:
        raise LutError("apply needs `in` and `out`: the image to read and the "
                       "path to write the graded one to.")
    notes = []
    lut = read_lut(job.get("lut"), notes)
    im = Image.open(src).convert("RGBA")
    rgba = np.asarray(im).astype(np.float32) / np.float32(255.0)
    t = time.perf_counter()
    out = apply_lut(rgba, lut, job.get("strength", 100),
                    job.get("interpolation", "tetrahedral"), notes=notes)
    ms = (time.perf_counter() - t) * 1000.0
    Image.fromarray((np.clip(out, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8),
                    "RGBA").save(dst)
    return {"ok": True, "out": dst, "width": im.width, "height": im.height,
            "ms": round(ms, 1),
            "msPerMegapixel": round(ms / max(1e-9, im.width * im.height / 1e6), 1),
            "lut": {"title": lut.title, "kind": lut.kind, "size": lut.size,
                    "domain": {"min": [float(v) for v in lut.domain_min],
                               "max": [float(v) for v in lut.domain_max]}},
            "cannotKnow": _CANNOT_KNOW,
            "notes": notes or None}


if __name__ == "__main__":
    _mode = sys.argv[1] if len(sys.argv) > 1 else "catalog"
    if _mode == "catalog":
        print(json.dumps(catalog()))
    elif _mode in ("info", "apply"):
        try:
            print(json.dumps(_cli_info(sys.argv) if _mode == "info"
                             else _cli_apply(sys.argv)))
        except LutError as _exc:
            # The whole point of LutError is that its message is a sentence a
            # person can act on, so it goes through verbatim rather than being
            # wrapped in "an error occurred".
            print(json.dumps({"ok": False, "error": str(_exc)}))
            sys.exit(1)
        except Exception as _exc:                        # noqa: BLE001
            print(json.dumps({"ok": False,
                              "error": f"{_mode} failed: {_exc}"}))
            sys.exit(1)
    elif _mode == "bench":
        print(json.dumps({"ok": True, "msPerMegapixel": _bench(),
                          "interpolation": _measure_interp()}, indent=2))
    else:
        print(json.dumps({"ok": False, "error": f"unknown mode {_mode}"}))
        sys.exit(1)
