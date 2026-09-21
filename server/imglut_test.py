"""Unit tests for the lookup-table reader in server/imglut.py.

⚠ EVERY FAILURE THIS MODULE CAN HAVE DRAWS A PICTURE, so "it ran and the output
looked like a grade" is not a test - it is the symptom. A LUT read with its
axes transposed still applies. A LUT whose domain was ignored still applies.
Both come back looking deliberate. That is what the assertions below are shaped
around: almost every one of them has a CLOSED FORM, and the ones that do not
are measured against the analytic function the table was baked from.

FIXTURES ARE WRITTEN HERE, AS REAL FILES, BY THIS FILE. Nothing below depends
on a .cube existing on this machine - there is no LUT pack in this repository
and there will not be one - so the suite writes its own into a temp directory,
through the real `read_lut` door, with real CRLF line endings, real comments
and a real BOM. A parser tested against a string it was handed in memory has
not been tested against a file.

FOUR KINDS OF TEST.

  * THE IDENTITY PIN, and it is the strongest thing in this file. A LUT that
    maps every colour to itself must return the picture BIT-IDENTICALLY. Get
    ANYTHING wrong - the row order, the domain, the interpolation weights, the
    clamp, the strength blend - and identity stops being identity. It is one
    assertion that stands in front of all of them.

  * THE ROW-ORDER PIN, which needs an ASYMMETRIC fixture and is the reason this
    trap ships broken so often. A .cube varies RED FASTEST. A test LUT that is
    symmetric in its three axes agrees with the transposed reading exactly, so
    a suite built on one passes while the module is wrong. The fixtures here
    put eight distinct colours on the eight corners of a 2-point cube, and the
    assertions name both the right answer AND the specific wrong answer a
    blue-fastest reader would give.

  * REFUSALS, one per way a file arrives broken, and each one is asserted to be
    a SENTENCE that names the numbers - not that an exception was raised. A
    refusal reading "invalid LUT" is a refusal nobody can act on, and this file
    is the only thing standing between that and a user.

  * COUNTERFACTUALS. Several pins below assert the WRONG answer as well as the
    right one - the value a transposed reader, a domain-ignoring reader or a
    nearest-neighbour interpolator would produce - so that the test would
    notice if the implementation changed into one of those. A check that
    cannot fail is not a check.

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/imglut_test.py

numpy, and Pillow for the two CLI cases, which go through subprocess and the
real {mode, jobPath} door rather than calling the functions again.
"""
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import imglut as G                                         # noqa: E402

PASS = FAIL = 0


def eq(name, got, want):
    global PASS, FAIL
    if got == want:
        PASS += 1
        print(f"  ok    {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}\n          got {got!r}, wanted {want!r}")


def near(name, got, want, tol):
    if abs(float(got) - float(want)) <= tol:
        eq(name, True, True)
    else:
        eq(name, f"{float(got):.8g} (wanted {float(want):.8g} +-{tol:g})",
           "within tolerance")


def refuses(name, fn, *must_contain):
    """A refusal is only useful if it is a SENTENCE somebody can act on, so this
    asserts the WORDS and not merely that something was raised. Every `must`
    below is a number or a term the person holding the broken file needs to see
    in order to know what to do next."""
    global PASS, FAIL
    try:
        fn()
    except G.LutError as exc:
        msg = str(exc)
        missing = [m for m in must_contain if m.lower() not in msg.lower()]
        if missing:
            FAIL += 1
            print(f"  FAIL  {name}\n          refused, but the sentence is "
                  f"missing {missing!r}:\n          {msg}")
        else:
            PASS += 1
            print(f"  ok    {name}")
            print(f"          -> {msg[:150]}")
        return
    except Exception as exc:                               # noqa: BLE001
        FAIL += 1
        print(f"  FAIL  {name}\n          raised {type(exc).__name__} rather "
              f"than a LutError with a sentence in it: {exc}")
        return
    FAIL += 1
    print(f"  FAIL  {name}\n          it was ACCEPTED. A file this broken has "
          f"to be refused, because what it produces is a picture.")


TMP = tempfile.mkdtemp(prefix="imglut_test_")


def write(name, body, crlf=False, bom=False):
    """A fixture, as bytes on disk. `newline=""` so python does not translate
    the line endings out from under a test whose whole point is that both are
    read."""
    path = os.path.join(TMP, name)
    if crlf:
        body = body.replace("\n", "\r\n")
    with open(path, "w", encoding="utf-8", newline="") as fh:
        if bom:
            fh.write("\ufeff")
        fh.write(body)
    return path


def grid(n):
    """The input colour at every grid point of an n-point cube, in .cube ROW
    ORDER - red fastest. Written out here rather than imported from imglut, so
    that the fixtures and the module cannot agree on a wrong convention."""
    ramp = np.arange(n, dtype=np.float64) / (n - 1.0)
    r = np.tile(ramp, n * n)
    g = np.tile(np.repeat(ramp, n), n)
    b = np.repeat(ramp, n * n)
    return np.stack([r, g, b], 1)


def cube(name, n, fn, title=None, dmin=None, dmax=None, crlf=False, bom=False,
         header_extra=(), rows=None):
    """Bake a function into a .cube file the way an exporter would write one."""
    out = np.asarray(fn(grid(n)), np.float64).reshape(-1, 3) if rows is None \
        else np.asarray(rows, np.float64).reshape(-1, 3)
    lines = ["# written by imglut_test, which is the point"]
    if title is not None:
        lines.append(f'TITLE "{title}"')
    lines.append(f"LUT_3D_SIZE {n}")
    if dmin is not None:
        lines.append("DOMAIN_MIN " + " ".join(f"{v:g}" for v in dmin))
    if dmax is not None:
        lines.append("DOMAIN_MAX " + " ".join(f"{v:g}" for v in dmax))
    lines.extend(header_extra)
    lines.append("")
    lines.extend(" ".join(f"{v:.10f}" for v in row) for row in out)
    return write(name, "\n".join(lines) + "\n", crlf=crlf, bom=bom)


def cube1d(name, n, fn, title=None, dmin=None, dmax=None, one_column=False):
    ramp = np.arange(n, dtype=np.float64) / (n - 1.0)
    out = np.asarray(fn(np.stack([ramp, ramp, ramp], 1)), np.float64)
    lines = [f'TITLE "{title}"'] if title else []
    lines.append(f"LUT_1D_SIZE {n}")
    if dmin is not None:
        lines.append("DOMAIN_MIN " + " ".join(f"{v:g}" for v in dmin))
    if dmax is not None:
        lines.append("DOMAIN_MAX " + " ".join(f"{v:g}" for v in dmax))
    lines.append("")
    for row in out:
        lines.append(f"{row[0]:.10f}" if one_column
                     else " ".join(f"{v:.10f}" for v in row))
    return write(name, "\n".join(lines) + "\n")


def img(h=48, w=64, seed=7, alpha=True):
    rng = np.random.default_rng(seed)
    a = np.empty((h, w, 4 if alpha else 3), np.float32)
    a[..., :3] = rng.random((h, w, 3), dtype=np.float32)
    if alpha:
        a[..., 3] = rng.random((h, w), dtype=np.float32)
    return a


def px(rgb):
    """One colour as a 1x1x3 picture, for an assertion with a closed form."""
    return np.asarray([[rgb]], np.float32)


def out1(rgb, lut, strength=100, interp="tetrahedral"):
    return [round(float(v), 6)
            for v in G.apply_lut(px(rgb), lut, strength, interp)[0, 0, :3]]


print("\nimglut\n")

# ---------------------------------------------------------------------------
print("  -- the catalog contract --")

bad = [k for k, e in G.CATALOG.items()
       if not (e.get("label") and e.get("why") and e.get("where")
               and e.get("group") in G.GROUP_ORDER)]
eq("every entry has a label, a group, a why and a where", bad, [])

bad = []
for k, e in G.CATALOG.items():
    for pk, p in e["params"].items():
        if p["type"] == "number" and not (p["min"] <= p["default"] <= p["max"]):
            bad.append(f"{k}.{pk}")
        if p["type"] == "enum" and p["default"] not in p["options"]:
            bad.append(f"{k}.{pk}")
        if "desc" not in p or "animatable" not in p:
            bad.append(f"{k}.{pk}")
eq("every parameter is described and defaults inside its own range", bad, [])

eq("catalog() serialises to JSON, which is the only way it reaches MCP",
   isinstance(json.loads(json.dumps(G.catalog())), dict), True)
eq("every alias points at a real op",
   sorted({v for v in G.ALIASES.values()} - set(G.CATALOG)), [])

# ⚠ IMAGE_SPEC §9: a schema that accepts a parameter the code then ignores is
# worse than a refusal, because a schema is exactly what a caller trusts. The
# probe table has to name EVERY catalogued parameter, so a new one cannot be
# added without proving it does something.
IDENT33 = cube("identity33.cube", 33, lambda g: g, title="Identity 33")
WARM = cube("warm.cube", 17,
            lambda g: np.clip(g * np.asarray([1.12, 1.0, 0.86]) + 0.02, 0, 1),
            title="Warm")
# Each entry is (what the reference below uses, something that must differ).
PROBE = {
    "lut": (WARM, IDENT33),
    "strength": (100, 35),
    "interpolation": ("tetrahedral", "nearest"),
}
eq("the probe table names every catalogued parameter",
   sorted(set(G.CATALOG["lut"]["params"]) - set(PROBE)), [])
_base = img(32, 32, seed=1)
_REF_SPEC = {k: v[0] for k, v in PROBE.items()}
_ref = G.apply(_base, _REF_SPEC)
moved = []
for key, (_, other) in PROBE.items():
    spec = dict(_REF_SPEC)
    spec[key] = other
    if np.array_equal(G.apply(_base, spec), _ref):
        moved.append(key)
eq("every advertised parameter demonstrably changes the picture", moved, [])

# ---------------------------------------------------------------------------
print("\n  -- reading a .cube --")

lut = G.read_lut(IDENT33)
eq("LUT_3D_SIZE is read", (lut.kind, lut.size, lut.entries), ("3D", 33, 35937))
eq("TITLE is carried through - it is the only evidence of what a LUT is for",
   lut.title, "Identity 33")
eq("the default domain is 0..1", (list(lut.domain_min), list(lut.domain_max)),
   ([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]))

crlf = cube("crlf.cube", 5, lambda g: g[:, [1, 2, 0]], title="CRLF # inside",
            crlf=True, bom=True)
lut_crlf = G.read_lut(crlf)
eq("CRLF line endings and a BOM are read, not refused",
   (lut_crlf.size, lut_crlf.entries), (5, 125))
eq("...and a # inside a quoted TITLE is part of the title, not a comment",
   lut_crlf.title, "CRLF # inside")

trail = write("trailing.cube",
              "LUT_3D_SIZE 2\n"
              "# a whole-line comment\n"
              + "\n".join(f"{r} {g} {b}   # a trailing comment"
                          for b in (0, 1) for g in (0, 1) for r in (0, 1))
              + "\n")
eq("comments are stripped from anywhere on the line, not only the start",
   G.read_lut(trail).entries, 8)

bare = write("baretitle.cube", 'TITLE Unquoted Look\nLUT_1D_SIZE 2\n'
                               '0 0 0\n1 1 1\n')
eq("an unquoted TITLE is taken rather than dropped - losing it loses the only "
   "clue to what space the LUT wants", G.read_lut(bare).title, "Unquoted Look")

notes = []
odd = cube("oddkey.cube", 2, lambda g: g, title="Odd",
           header_extra=["LUT_IN_VIDEO_RANGE 1"])
lut_odd = G.read_lut(odd, notes)
eq("an unknown keyword is REPORTED, never silently dropped - it may be the one "
   "line that says what space the table is in",
   any("LUT_IN_VIDEO_RANGE" in w for w in lut_odd.warnings), True)
eq("...and the note reaches the caller's list", any("LUT_IN_VIDEO_RANGE" in n
                                                    for n in notes), True)

curve = cube1d("curve1d.cube", 9, lambda g: np.clip(g ** 2.0, 0, 1),
               title="Gamma 2")
l1 = G.read_lut(curve)
eq("a 1D LUT reads as three curves", (l1.kind, l1.size, l1.entries),
   ("1D", 9, 9))
near("...and a 1D LUT is exact at its own grid points",
     out1((0.5, 0.5, 0.5), l1)[0], 0.25, 1e-6)

single = cube1d("single1d.cube", 5, lambda g: np.clip(g ** 2.0, 0, 1),
                title="One column", one_column=True)
l1s = G.read_lut(single)
eq("a one-number-per-row 1D LUT is forgiven, and SAID so rather than forgiven "
   "quietly", (l1s.entries, any("one number per row" in w
                                for w in l1s.warnings)), (5, True))

# ---------------------------------------------------------------------------
print("\n  -- TRAP 1: the row order, pinned with an ASYMMETRIC fixture --")

# Eight distinct colours on the eight corners of a 2-point cube. This is the
# fixture a symmetric test LUT cannot be: under the correct RED-FASTEST reading
# the row at index 1 is grid point (1, 0, 0), so pure red in must give CORNERS
# [1] out. Under a blue-fastest misreading the same row would be grid point
# (0, 0, 1), and pure red would give CORNERS[4] instead. Both are asserted.
CORNERS = [(0.10, 0.20, 0.30),      # index 0 = (r0, g0, b0)
           (0.90, 0.05, 0.05),      # index 1 = (r1, g0, b0)   <- red axis
           (0.05, 0.90, 0.05),      # index 2 = (r0, g1, b0)   <- green axis
           (0.80, 0.80, 0.10),      # index 3 = (r1, g1, b0)
           (0.05, 0.05, 0.90),      # index 4 = (r0, g0, b1)   <- blue axis
           (0.70, 0.15, 0.70),      # index 5 = (r1, g0, b1)
           (0.15, 0.70, 0.70),      # index 6 = (r0, g1, b1)
           (0.95, 0.95, 0.95)]      # index 7 = (r1, g1, b1)
CORNER_LUT = G.read_lut(cube("corners.cube", 2, None, title="Eight corners",
                             rows=CORNERS))


def r6(t):
    return [round(float(v), 6) for v in t]


eq("pure RED reads the row at index 1 (r + g*N + b*N*N, red fastest)",
   out1((1.0, 0.0, 0.0), CORNER_LUT), r6(CORNERS[1]))
eq("...and NOT the row at index 4, which is what a blue-fastest reader gives",
   out1((1.0, 0.0, 0.0), CORNER_LUT) == r6(CORNERS[4]), False)
eq("pure GREEN reads the row at index 2",
   out1((0.0, 1.0, 0.0), CORNER_LUT), r6(CORNERS[2]))
eq("pure BLUE reads the row at index 4",
   out1((0.0, 0.0, 1.0), CORNER_LUT), r6(CORNERS[4]))
eq("...and NOT index 1, the other half of the same transposition",
   out1((0.0, 0.0, 1.0), CORNER_LUT) == r6(CORNERS[1]), False)
eq("red+green reads index 3", out1((1.0, 1.0, 0.0), CORNER_LUT), r6(CORNERS[3]))
eq("red+blue reads index 5", out1((1.0, 0.0, 1.0), CORNER_LUT), r6(CORNERS[5]))
eq("green+blue reads index 6", out1((0.0, 1.0, 1.0), CORNER_LUT), r6(CORNERS[6]))
eq("black and white read index 0 and index 7",
   (out1((0.0, 0.0, 0.0), CORNER_LUT), out1((1.0, 1.0, 1.0), CORNER_LUT)),
   (r6(CORNERS[0]), r6(CORNERS[7])))

# The same trap at a size where interpolation is involved rather than only the
# corners: a LUT that SWAPS green and blue. Applying it twice is the identity,
# which is a property no transposed reading has.
SWAP = G.read_lut(cube("swapgb.cube", 33, lambda g: g[:, [0, 2, 1]],
                       title="Swap G and B"))
eq("a green/blue swap swaps green and blue", out1((0.8, 0.3, 0.1), SWAP),
   [0.8, 0.1, 0.3])
twice = G.apply_lut(G.apply_lut(px((0.8, 0.3, 0.1)), SWAP), SWAP)
near("...and applying it twice is the identity, which no transposed reading is",
     float(np.abs(twice - px((0.8, 0.3, 0.1))).max()), 0.0, 1e-6)
eq("a channel swap moves NO grey, which is exactly why the landmark report "
   "cannot catch a transposed reader and this fixture has to",
   out1((0.42, 0.42, 0.42), SWAP), [0.42, 0.42, 0.42])

# The counterfactual, run rather than described: rebuild the same file's rows
# under the blue-fastest reading and confirm it is a DIFFERENT picture. If this
# ever comes back True, the two conventions have collapsed into one and every
# assertion above has quietly stopped meaning anything.
_t = CORNER_LUT.table.reshape(2, 2, 2, 3)          # [b][g][r] in row order
_transposed = G.Lut("3D", 2, _t.transpose(2, 1, 0, 3).reshape(-1, 3),
                    [0, 0, 0], [1, 1, 1], title="transposed")
eq("the transposed reading is a genuinely different picture (the fixture is "
   "asymmetric, so this pin can actually fail)",
   out1((1.0, 0.0, 0.0), CORNER_LUT) == out1((1.0, 0.0, 0.0), _transposed),
   False)

# ---------------------------------------------------------------------------
print("\n  -- THE IDENTITY PIN: get anything wrong and this stops holding --")

PIC = img(40, 56, seed=3)
for n in (2, 5, 17, 33, 65):
    lut_i = G.read_lut(cube(f"id{n}.cube", n, lambda g: g, title=f"id {n}"))
    for mode in ("tetrahedral", "trilinear"):
        got = G.apply_lut(PIC, lut_i, 100, mode)
        eq(f"identity {n}^3, {mode}: BIT-identical, every bit of every pixel",
           np.array_equal(got, PIC), True)

# ⚠ 32 IS IN HERE ON PURPOSE AND IT IS NOT BIT-IDENTICAL. The exactness above
# is not luck: it needs the grid values i/(N-1) to be exactly representable, and
# they are exactly when N-1 is a power of two - 2, 5 (4), 17 (16), 33 (32), 65
# (64), which is every size anyone actually ships. N=32 makes them i/31, which
# is not, so identity comes back one float32 ulp out. 5.96e-08 is 1/16,777,216:
# a millionth of the way to the next 8-bit code, and four orders of magnitude
# inside "within one code". The claim in the module docstring is therefore
# "bit-identical at every real LUT size, and one ulp at the others", and this is
# the line that keeps it honest.
lut32 = G.read_lut(cube("id32.cube", 32, lambda g: g, title="id 32"))
err32 = float(np.abs(G.apply_lut(PIC, lut32, 100, "tetrahedral") - PIC).max())
eq("identity 32^3 is NOT bit-identical, because 31 is not a power of two",
   err32 > 0.0, True)
eq(f"...and it is one float32 ulp ({err32:.3g}), which is 1/65000 of an 8-bit "
   f"code", err32 < 1.0 / 255.0 / 1000.0, True)

eq("identity through a MASK is bit-identical too (the blend has to be exact "
   "where the mask is 1 and where it is 0 alike)",
   np.array_equal(G.apply_lut(PIC, G.read_lut(IDENT33), 100, "tetrahedral",
                              mask=np.linspace(0, 1, 40 * 56, dtype=np.float32)
                              .reshape(40, 56)), PIC), True)

# ---------------------------------------------------------------------------
print("\n  -- TRAP 2: the domain --")

# A LUT built over 0..2. Its entry at grid point i holds the output for INPUT
# 2*i/(N-1), so reading the two header lines is the difference between the
# picture being right and being squashed by a factor of two.
DOM = G.read_lut(cube("domain02.cube", 33,
                      lambda g: np.clip(g * 2.0 * 0.25, 0, 1),
                      title="Quarter over 0..2", dmin=(0, 0, 0),
                      dmax=(2, 2, 2)))
eq("DOMAIN_MIN/DOMAIN_MAX are read", (list(DOM.domain_min), list(DOM.domain_max)),
   ([0.0, 0.0, 0.0], [2.0, 2.0, 2.0]))
near("a 0..2 LUT that quarters its input turns 0.8 into 0.2 - the domain is "
     "honoured", out1((0.8, 0.8, 0.8), DOM)[0], 0.2, 1e-5)
# The counterfactual. A reader that ignored the header would normalise 0.8 to
# position 0.8 of the table instead of 0.4, and hand back 0.4 - twice the right
# answer, and a picture that simply looks like a stronger grade.
eq("...and a reader that ignored the header would give 0.4, which is a picture "
   "and not an error", abs(out1((0.8, 0.8, 0.8), DOM)[0] - 0.4) > 0.19, True)

ASYM = G.read_lut(cube("domainasym.cube", 17, lambda g: g,
                       title="Per-channel domain", dmin=(0, 0.1, 0.2),
                       dmax=(1, 0.9, 0.8)))
eq("the domain is PER CHANNEL, not one number for all three",
   (list(ASYM.domain_min), list(ASYM.domain_max)),
   ([0.0, 0.1, 0.2], [1.0, 0.9, 0.8]))
near("...and the green axis is rescaled by its own span: 0.5 in lands at "
     "(0.5-0.1)/0.8 = 0.5 of the table, which this identity table maps to 0.5",
     out1((0.5, 0.5, 0.5), ASYM)[1], 0.5, 1e-5)
near("...while a green of 0.1 lands on the table's floor",
     out1((0.5, 0.1, 0.5), ASYM)[1], 0.0, 1e-5)

iri = write("iridas.cube",
            "LUT_3D_INPUT_RANGE 0.0 4.0\nLUT_3D_SIZE 2\n"
            + "\n".join("0 0 0" if i < 7 else "1 1 1" for i in range(8)) + "\n")
lut_iri = G.read_lut(iri)
eq("the older IRIDAS LUT_3D_INPUT_RANGE spelling is read as a domain, not "
   "dropped", (list(lut_iri.domain_min), list(lut_iri.domain_max)),
   ([0.0, 0.0, 0.0], [4.0, 4.0, 4.0]))
eq("...and it says where the domain came from",
   any("INPUT_RANGE" in w for w in lut_iri.warnings), True)

# Outside the domain is CLAMPED, deliberately. An unclamped position would be
# negative, and a negative index in numpy does not raise - it wraps, and reads
# a colour from the far corner of the cube.
#
# ⚠ THE FIXTURE HAS TO DESCEND, AND THE FIRST VERSION DID NOT. With an
# ASCENDING table over a narrow domain, deleting the clamp is invisible: the
# interpolators clip their own integer index, so the fraction goes negative
# instead and the answer EXTRAPOLATES past the end of the table - straight
# through 0 or 1, where the output clip catches it and hands back the same
# number the clamp would have. The defect was run with the clamp removed and
# the whole suite passed. A DESCENDING table over a narrow domain extrapolates
# AWAY from the edge instead, into the middle of 0..1 where nothing rescues it,
# and the numbers below are the two answers apart.
clampy = G.read_lut(cube("clamp.cube", 5, lambda g: 0.7 - 0.4 * g,
                         title="Descending over 0.2..0.8",
                         dmin=(0.2, 0.2, 0.2), dmax=(0.8, 0.8, 0.8)))
eq("input BELOW the domain clamps to the table's first entry (0.7)",
   out1((0.0, 0.0, 0.0), clampy), [0.7, 0.7, 0.7])
eq("...and NOT 0.833, which is what extrapolating past the end would give - "
   "a number squarely inside 0..1, so nothing downstream would catch it",
   abs(out1((0.0, 0.0, 0.0), clampy)[0] - 0.8333) > 0.1, True)
eq("input ABOVE the domain clamps to the last entry (0.3)",
   out1((1.0, 1.0, 1.0), clampy), [0.3, 0.3, 0.3])
eq("...and NOT 0.167, the extrapolation",
   abs(out1((1.0, 1.0, 1.0), clampy)[0] - 0.1667) > 0.1, True)
wild = np.asarray([[[-4.0, 9.0, 0.5]]], np.float32)
got = G.apply_lut(wild, clampy)
eq("a wildly out-of-range pixel is clamped and finite, in range",
   (bool(np.isfinite(got).all()), bool((got >= 0).all() and (got <= 1).all())),
   (True, True))
# And the clamp asserted DIRECTLY, on the function that owns it, so no
# downstream clip can stand in for it the way one did above.
_far = np.asarray([[-9.0, 0.5, 40.0], [1e9, -1e9, 0.0]], np.float32)
_p = G._positions(_far, clampy)
eq("_positions never returns a position outside 0..size-1, whatever it is fed",
   (float(_p.min()) >= 0.0, float(_p.max()) <= clampy.size - 1.0), (True, True))

eq("a unit domain written out explicitly and a unit domain omitted give the "
   "same picture, bit for bit - the short-circuit in _positions is a speed "
   "path and not a second implementation",
   np.array_equal(
       G.apply_lut(PIC, G.read_lut(cube("unit.cube", 17, lambda g: g ** 1.3,
                                        dmin=(0, 0, 0), dmax=(1, 1, 1)))),
       G.apply_lut(PIC, G.read_lut(cube("nounit.cube", 17,
                                        lambda g: g ** 1.3)))), True)

# ---------------------------------------------------------------------------
print("\n  -- TRAP 3: interpolation, measured on a real gradient --")

M = G._measure_interp(33, 260)
for mode in G.INTERPOLATIONS:
    row = M[mode]
    print(f"  {mode:<13} sweep max {row['sweepMax']:.5f}  rms "
          f"{row['sweepRms']:.6f}  neutral max {row['neutralMax']:.6f}  "
          f"grey hue {row['hueSpread']:.2e}")

eq("nearest is an order of magnitude worse than either real interpolator - "
   "that is the banding, counted rather than described",
   M["nearest"]["sweepMax"] > 8 * max(M["tetrahedral"]["sweepMax"],
                                      M["trilinear"]["sweepMax"]), True)
eq("and trilinear is MORE accurate than tetrahedral on arbitrary colours, "
   "which is the opposite of the usual claim",
   M["trilinear"]["sweepMax"] < M["tetrahedral"]["sweepMax"], True)
eq("...so what tetrahedral buys is the grey axis: it invents no chroma on a "
   "neutral ramp",
   M["tetrahedral"]["hueSpread"] < 1e-6, True)
eq("...where trilinear invents a hue ripple two orders of magnitude bigger",
   M["trilinear"]["hueSpread"] > 100 * M["tetrahedral"]["hueSpread"], True)

# The banding, as a count rather than as an adjective. A 33-point LUT run
# nearest-neighbour can produce at most 33 distinct output levels on a ramp,
# and that is what a viewer sees as banding.
ramp = np.linspace(0, 1, 2048, dtype=np.float32)
ramp_img = np.stack([ramp, ramp, ramp], 1).reshape(1, -1, 3)
smooth = G.read_lut(cube("smooth.cube", 33, lambda g: np.clip(g ** 0.75, 0, 1),
                         title="Gamma 0.75"))
levels = {m: len(np.unique(G.apply_lut(ramp_img, smooth, 100, m)[..., 0]))
          for m in G.INTERPOLATIONS}
print(f"  distinct levels on a 2048-step ramp: " +
      ", ".join(f"{k} {v}" for k, v in levels.items()))
eq("nearest collapses a 2048-step ramp onto the LUT's 33 grid points",
   levels["nearest"] <= 33, True)
eq("...where both real interpolators keep the ramp smooth",
   min(levels["tetrahedral"], levels["trilinear"]) > 1000, True)

# Every tetrahedron the decomposition can pick has to be a real one: the rank
# vector must be a PERMUTATION of (0, 1, 2) at every pixel, TIES INCLUDED. One
# that is not steps twice along one axis and never along another, so the four
# "corners" it blends are not the corners of any tetrahedron - a picture, not a
# crash, and only on the surfaces where two fractions are exactly equal.
#
# ⚠ THIS CALLS imglut's OWN `_ranks`, AND THE FIRST DRAFT DID NOT. It repeated
# the three comparison lines here and asserted those, which is a test checking
# that the test agrees with itself: the tie-break was broken on purpose (`>`
# for `>=` on one line) and this assertion passed. §9's rule about asserting
# against the other side's SOURCE, learned again.
q = np.linspace(0.0, 1.0, 21, dtype=np.float32)
ff = np.stack(np.meshgrid(q, q, q, indexing="ij"), -1).reshape(-1, 3)
ranks = np.sort(np.stack(G._ranks(ff[:, 0], ff[:, 1], ff[:, 2]), 1), axis=1)
eq(f"imglut._ranks is a permutation at every one of {len(ff)} cases, ties "
   f"included", bool((ranks == np.arange(3)).all()), True)
# The ties are the whole point, so count them rather than hope the grid has any.
_ties = int(((ff[:, 0] == ff[:, 1]) | (ff[:, 1] == ff[:, 2])
             | (ff[:, 0] == ff[:, 2])).sum())
eq("...and that sweep really does contain ties, rather than testing the easy "
   "case exhaustively", _ties > 1000, True)

# ---------------------------------------------------------------------------
print("\n  -- strength, and the space the blend happens in --")

LOOK = G.read_lut(cube("look.cube", 33,
                       lambda g: np.clip(g ** np.asarray([0.8, 1.0, 1.25])
                                         * np.asarray([1.05, 1.0, 0.92]), 0, 1),
                       title="A look"))
full = G.apply_lut(PIC, LOOK, 100)
eq("strength 0 returns the picture BIT-identically",
   np.array_equal(G.apply_lut(PIC, LOOK, 0), PIC), True)
eq("strength 100 returns the LUT's own output bit for bit",
   np.array_equal(G.apply_lut(PIC, LOOK, 100), full), True)
half = G.apply_lut(PIC, LOOK, 50)
near("strength 50 lands exactly halfway between them, in the values the LUT "
     "handed back - which is what makes 50% here 50% in a grading tool",
     float(np.abs(half[..., :3] - (PIC[..., :3] + full[..., :3]) * 0.5).max()),
     0.0, 1e-7)
eq("strength is monotone: 25 is nearer the original than 75 is",
   float(np.abs(G.apply_lut(PIC, LOOK, 25)[..., :3] - PIC[..., :3]).mean())
   < float(np.abs(G.apply_lut(PIC, LOOK, 75)[..., :3] - PIC[..., :3]).mean()),
   True)

# ⚠ THE PERCENT TRAP, ASSERTED RATHER THAN DOCUMENTED. `strength: 0.5` is half
# of ONE PERCENT. A caller who meant half the look gets a picture that looks
# untouched and no error anywhere, so the catalog says 0-100 in capitals and
# this is the line that proves the code agrees with the catalog.
tiny = G.apply_lut(PIC, LOOK, 0.5)
eq("strength 0.5 is half of one percent, NOT half - it moves the picture by "
   "under a thousandth",
   float(np.abs(tiny[..., :3] - PIC[..., :3]).max()) < 0.001, True)
eq("...where strength 50 moves it by far more, which is the confusion the "
   "catalog shouts about",
   float(np.abs(half[..., :3] - PIC[..., :3]).max()) > 0.02, True)

eq("strength above 100 is clamped rather than extrapolated - a look at 150% is "
   "not a thing a LUT can answer",
   np.array_equal(G.apply_lut(PIC, LOOK, 400), full), True)
eq("a NaN strength falls back to 100 rather than poisoning every pixel",
   np.array_equal(G.apply_lut(PIC, LOOK, float("nan")), full), True)

# ---------------------------------------------------------------------------
print("\n  -- shape, alpha and the selection mask --")

eq("alpha comes back bit-identical", np.array_equal(full[..., 3], PIC[..., 3]),
   True)
eq("(H, W, 3) goes in and (H, W, 3) comes out",
   G.apply_lut(img(8, 9, alpha=False), LOOK).shape, (8, 9, 3))
eq("...and the RGB it produces is identical to the RGBA path's, so alpha is "
   "genuinely not in the arithmetic",
   np.array_equal(G.apply_lut(PIC[..., :3], LOOK)[..., :3], full[..., :3]),
   True)
eq("a straight-alpha picture is NOT premultiplied first: a fully transparent "
   "pixel's colour is graded like any other, because a LUT reads no neighbour",
   np.array_equal(G.apply_lut(np.asarray([[[0.9, 0.2, 0.1, 0.0]]], np.float32),
                              LOOK)[0, 0, :3],
                  G.apply_lut(np.asarray([[[0.9, 0.2, 0.1, 1.0]]], np.float32),
                              LOOK)[0, 0, :3]), True)

m = np.zeros((40, 56), np.float32)
m[:, 28:] = 1.0
masked = G.apply_lut(PIC, LOOK, 100, mask=m)
eq("where the mask is 0 the picture is bit-identical",
   np.array_equal(masked[:, :28], PIC[:, :28]), True)
eq("where the mask is 1 it is the LUT's own output, bit for bit",
   np.array_equal(masked[:, 28:], full[:, 28:]), True)
eq("a half mask is the same arithmetic as half strength",
   np.allclose(G.apply_lut(PIC, LOOK, 100,
                           mask=np.full((40, 56), 0.5, np.float32)), half,
               atol=1e-7), True)
refuses("a mask of the wrong size is refused with both shapes in the sentence",
        lambda: G.apply_lut(PIC, LOOK, 100, mask=np.ones((5, 5), np.float32)),
        "40", "56")

# ---------------------------------------------------------------------------
print("\n  -- NaN, infinity, and the output contract --")

poison = np.asarray([[[float("nan"), 0.5, 0.5, 1.0],
                      [float("inf"), 0.5, 0.5, 1.0],
                      [float("-inf"), 0.5, 0.5, 1.0],
                      [0.5, 0.5, 0.5, 1.0]]], np.float32)
got = G.apply_lut(poison, LOOK)
eq("a NaN pixel does not reach floor().astype(int32), where it would become "
   "INT_MIN and gather from nowhere - the output is finite",
   bool(np.isfinite(got[..., :3]).all()), True)
eq("...and +inf clamps to the top of the table while -inf clamps to the floor",
   (float(got[0, 1, 0]) > float(got[0, 2, 0]),
    float(got[0, 2, 0]) <= 1e-6), (True, True))
for mode in G.INTERPOLATIONS:
    o = G.apply_lut(img(24, 24, seed=9), LOOK, 60, mode)
    eq(f"{mode}: the output is finite and inside 0..1 everywhere",
       (bool(np.isfinite(o).all()), float(o.min()) >= 0.0,
        float(o.max()) <= 1.0), (True, True, True))

hdr = G.read_lut(cube("hdr.cube", 5, lambda g: g * 1.6, title="Headroom"))
rep = G.describe(hdr)
eq("a table that reaches past 1.0 is legal, is reported, and its output is "
   "clamped rather than left to break every op downstream",
   (rep["range"]["outsideUnit"],
    float(G.apply_lut(px((1.0, 1.0, 1.0)), hdr).max())), (True, 1.0))

# ---------------------------------------------------------------------------
print("\n  -- banding is an implementation detail, not a seam --")

big = img(300, 700, seed=11)
whole = G.apply_lut(big, LOOK, 70, "tetrahedral")
_saved = G._BAND_PIXELS
try:
    G._BAND_PIXELS = 900
    chopped = G.apply_lut(big, LOOK, 70, "tetrahedral")
finally:
    G._BAND_PIXELS = _saved
eq("a picture cut into 234 bands is BIT-identical to one slab",
   np.array_equal(whole, chopped), True)

# ---------------------------------------------------------------------------
print("\n  -- TRAP 4 and every other way a file arrives broken --")

refuses("a size the machine cannot hold is refused off the HEADER, naming the "
        "number and the cap",
        lambda: G.read_lut(write("huge.cube",
                                 "LUT_3D_SIZE 1000\n0 0 0\n1 1 1\n")),
        "1000", "1,000,000,000", str(G.LIMITS["max3dSize"]))
refuses("a 1D size past the cap is refused, naming the cap",
        lambda: G.read_lut(write("huge1d.cube",
                                 "LUT_1D_SIZE 99999999\n0 0 0\n")),
        "99999999", "65,536")
refuses("LUT_3D_SIZE 1 is refused: one point has nothing to interpolate "
        "between and would flatten the picture to one colour",
        lambda: G.read_lut(write("one.cube", "LUT_3D_SIZE 1\n0.2 0.3 0.4\n")),
        "at least 2")

# The byte cap cannot be tested with a real 2 GB file on this machine, and
# writing one to prove a `>` works would be dishonest about what it costs. The
# constant is lowered instead, which exercises the same branch and the same
# sentence; the number in the sentence is read from LIMITS, so it cannot drift
# away from the constant it is quoting.
_savedb = G.LIMITS["maxBytes"]
try:
    G.LIMITS["maxBytes"] = 64
    refuses("a file past the byte cap is refused BEFORE it is read into memory, "
            "and the sentence names both sizes",
            lambda: G.read_lut(IDENT33), "past the", "64 bytes", "not a LUT")
finally:
    G.LIMITS["maxBytes"] = _savedb

body = open(IDENT33, encoding="utf-8").read().splitlines()
refuses("a TRUNCATED download - the header is right and the rows stop - is "
        "refused with both counts and the shortfall",
        lambda: G.read_lut(write("trunc.cube",
                                 "\n".join(body[:5000]) + "\n")),
        "35,937", "truncated")
refuses("a file with MORE rows than the header declares is refused too, and "
        "says by how many",
        lambda: G.read_lut(write("over.cube",
                                 "LUT_3D_SIZE 2\n" +
                                 "\n".join(["0.5 0.5 0.5"] * 9) + "\n")),
        "8", "9", "over by 1")
refuses("a file with no size line at all is refused, and says which line is "
        "the one it cannot do without",
        lambda: G.read_lut(write("nosize.cube",
                                 "TITLE \"Nameless\"\n0 0 0\n1 1 1\n")),
        "LUT_3D_SIZE", "LUT_1D_SIZE")
refuses("a file declaring BOTH a 3D and a 1D size is refused, because nothing "
        "says which rows belong to which",
        lambda: G.read_lut(write("both.cube",
                                 "LUT_3D_SIZE 2\nLUT_1D_SIZE 8\n" +
                                 "\n".join(["0 0 0"] * 8) + "\n")),
        "LUT_1D_SIZE", "LUT_3D_SIZE")
refuses("a header and no table is refused as the truncated download it is",
        lambda: G.read_lut(write("headeronly.cube", "LUT_3D_SIZE 17\n")),
        "not one row", "truncated")
refuses("a row that is not three numbers is refused BY LINE NUMBER",
        lambda: G.read_lut(write("shortrow.cube",
                                 "LUT_3D_SIZE 2\n0 0 0\n0 0\n" +
                                 "\n".join(["1 1 1"] * 6) + "\n")),
        "line 3", "2 number")
# ⚠ A LINE OF WORDS IN THE MIDDLE OF A TABLE IS TWO FAULTS AT ONCE, and the
# first draft only reported the second. It is not a data row, so it is skipped
# as an unrecognised header; the table then comes up one row short and the
# refusal said "truncated download, short by 1" - true, and pointing at the
# wrong end of the file, with 35,936 good rows for somebody to search. The
# sentence now names the skipped line as well, which is the one a person has to
# go and look at.
refuses("a row of words rather than numbers is refused NAMING THAT LINE, not "
        "just the row count it threw off",
        lambda: G.read_lut(write("words.cube",
                                 "LUT_3D_SIZE 2\n0 0 0\nred green blue\n" +
                                 "\n".join(["1 1 1"] * 6) + "\n")),
        "line 3", "red green blue", "short by 1")
refuses("a MANGLED data row - it starts with a number, so it is a row, and "
        "then stops being numbers - is refused by line number",
        lambda: G.read_lut(write("mangled.cube",
                                 "LUT_3D_SIZE 2\n0 0 0\n0.5 0.5 abc\n" +
                                 "\n".join(["1 1 1"] * 6) + "\n")),
        "line 3", "0.5 0.5 abc")
refuses("a NaN in the table is refused, because interpolating through one "
        "poisons every pixel that reaches that corner",
        lambda: G.read_lut(write("nan.cube",
                                 "LUT_3D_SIZE 2\n0 0 0\n0 nan 0\n" +
                                 "\n".join(["1 1 1"] * 6) + "\n")),
        "line 3", "finite")
refuses("an EMPTY domain is refused - it is a division by zero dressed as a "
        "header line",
        lambda: G.read_lut(write("flatdom.cube",
                                 "LUT_3D_SIZE 2\nDOMAIN_MIN 0.5 0 0\n"
                                 "DOMAIN_MAX 0.5 1 1\n" +
                                 "\n".join(["0 0 0"] * 8) + "\n")),
        "R domain", "empty or inverted")
refuses("an INVERTED domain is refused, and the sentence says why that is "
        "worse than a crash",
        lambda: G.read_lut(write("invdom.cube",
                                 "LUT_3D_SIZE 2\nDOMAIN_MIN 1 1 1\n"
                                 "DOMAIN_MAX 0 0 0\n" +
                                 "\n".join(["0 0 0"] * 8) + "\n")),
        "inverted", "backwards")
refuses("a DOMAIN_MAX that is not numbers is refused",
        lambda: G.read_lut(write("baddom.cube",
                                 "LUT_3D_SIZE 2\nDOMAIN_MAX one two three\n" +
                                 "\n".join(["0 0 0"] * 8) + "\n")),
        "DOMAIN_MAX", "not made of numbers")
refuses("an empty file is refused as the unfinished download it is",
        lambda: G.read_lut(write("empty.cube", "")), "0 bytes")
refuses("a file that is not there is refused without a traceback",
        lambda: G.read_lut(os.path.join(TMP, "nope.cube")), "no file at")
refuses("no path at all is refused", lambda: G.read_lut(None), "no LUT file")

# ⚠ .3dl. Refused rather than guessed at, and the refusal has to carry the
# REASON - "unsupported format" would read as laziness where the actual answer
# is that two conventions disagree about the row order and there is nothing on
# this machine to settle it against.
open(os.path.join(TMP, "look.3dl"), "w").write("0 0 0\n")
refuses("a .3dl is refused with the reason, not with 'unsupported'",
        lambda: G.read_lut(os.path.join(TMP, "look.3dl")),
        "varies fastest", "bit depth", "convert it to .cube")
eq("...and the same sentence is in the catalog, so an agent reads it before "
   "trying rather than after",
   G.catalog()["formats"]["refused"][".3dl"] == G._THREEDL_REFUSAL, True)

refuses("an integer image is refused rather than grading 0-255 as if it were "
        "0-1, which would land every pixel on the white corner",
        lambda: G.apply_lut(np.zeros((4, 4, 4), np.uint8), LOOK), "FLOAT")
refuses("a picture of the wrong shape is refused with its shape in the sentence",
        lambda: G.apply_lut(np.zeros((4, 4), np.float32), LOOK), "(4, 4)")
refuses("ops.lut with no lut in it is refused", lambda: G.apply(PIC, {}), "lut")

# ---------------------------------------------------------------------------
print("\n  -- TRAP 5: what it says about what it cannot know --")

rep = G.describe(G.read_lut(WARM))
eq("the report always carries the sentence about colour space - it is not a "
   "warning that appears when something is suspected, because nothing ever is",
   ("log" in rep["cannotKnow"] and "sRGB" in rep["cannotKnow"]
    and "reading, not a detection" in rep["cannotKnow"]), True)
eq("the LUT's own TITLE is in the report", rep["title"], "Warm")
eq("the landmarks report what the LUT does to black, 18% grey, mid and white",
   [m["name"] for m in rep["landmarks"]],
   ["black", "18% grey", "mid code", "white"])
eq("the landmarks are what a picture would actually get, not a second "
   "implementation of the lookup",
   rep["landmarks"][2]["out"],
   [round(v, 4) for v in out1((0.5, 0.5, 0.5), G.read_lut(WARM))])

# A log-style LUT lifts black well off the floor. That is EVIDENCE, and the
# report hands the number over; it is not a detection, and nothing in the
# module claims it is.
loggy = G.read_lut(cube("loggy.cube", 17,
                        lambda g: np.clip(0.09 + g * 0.82, 0, 1),
                        title="Log-ish"))
lrep = G.describe(loggy)
eq("a LUT that lifts black off the floor shows it in the landmarks, which is "
   "the evidence a person reads it by",
   lrep["landmarks"][0]["out"][0] > 0.05, True)
eq("...and the module still does not claim to have detected anything",
   "cannot tell you" in lrep["cannotKnow"], True)

idrep = G.describe(G.read_lut(IDENT33))
eq("an identity LUT is reported as a PROBLEM - it is a real file that will "
   "change nothing, which is the one thing a caller will not work out alone",
   (idrep["ok"], idrep["identity"]["isIdentity"],
    any("identity" in p for p in idrep["problems"])), (False, True, True))

flatlut = G.read_lut(cube("flat.cube", 5,
                          lambda g: np.full_like(g, 0.4), title="Flat"))
frep = G.describe(flatlut)
eq("a constant table is a PROBLEM: it would flatten the whole picture to one "
   "colour", any("one colour" in p for p in frep["problems"]), True)

domrep = G.describe(DOM)
eq("an unusual domain is a WARNING and not a problem - it is legal, it is "
   "handled, and calling it a failure would refuse the case the route exists "
   "to explain",
   (domrep["ok"], any("domain is not 0..1" in w for w in domrep["warnings"])),
   (True, True))

tint = G.read_lut(cube("tint.cube", 9,
                       lambda g: np.clip(g * np.asarray([1.0, 0.94, 0.8]), 0, 1),
                       title="Tinted greys"))
eq("a LUT that pushes grey off neutral says so, with the number in 8-bit codes",
   any("neutral grey" in w for w in G.describe(tint)["warnings"]), True)
eq("a LUT with no TITLE says that too, because the title is the only evidence "
   "of what it was built for",
   any("no TITLE" in w for w in
       G.describe(G.read_lut(cube("untitled.cube", 5, lambda g: g * 0.5)))
       ["warnings"]), True)
refuses("describe() refuses something that is not a Lut rather than reporting "
        "on it", lambda: G.describe({"size": 33}), "read_lut")

# ---------------------------------------------------------------------------
print("\n  -- the door: {mode, jobPath}, through a real subprocess --")

HERE = os.path.dirname(os.path.abspath(__file__))
MOD = os.path.join(HERE, "imglut.py")


def cli(mode, job=None):
    args = [sys.executable, MOD, mode]
    if job is not None:
        p = os.path.join(TMP, f"job_{mode}_{abs(hash(json.dumps(job, sort_keys=True))):x}.json")
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(job, fh)
        args.append(p)
    r = subprocess.run(args, capture_output=True, text=True)
    try:
        return json.loads(r.stdout), r.returncode
    except json.JSONDecodeError:
        return {"ok": False, "error": f"not JSON: {r.stdout[:200]} {r.stderr[:200]}"}, r.returncode


cat, code = cli("catalog")
eq("catalog mode prints one JSON line and exits 0",
   (code, sorted(cat["ops"])), (0, ["info", "lut"]))

rep, code = cli("info", {"lut": DOM.path})
# ⚠ THE LESSON imgpath.check_figure PAID FOR. The report's `ok` means "there is
# nothing odd about this LUT" and the envelope's means "the call worked". A LUT
# with an unusual domain is a SUCCESSFUL reading of an unusual file; collapse
# the two and a route answers ok:false and every caller reads a failed request.
eq("info: the envelope's ok and the report's ok are two different words",
   (code, rep["ok"], rep["report"]["ok"],
    len(rep["report"]["warnings"]) > 0), (0, True, True, True))
bad_rep, code = cli("info", {"lut": IDENT33})
eq("...and a LUT with a real PROBLEM still returns a successful call carrying "
   "an unhappy report", (code, bad_rep["ok"], bad_rep["report"]["ok"]),
   (0, True, False))

err, code = cli("info", {"lut": os.path.join(TMP, "huge.cube")})
eq("info: a broken file is ok:false, exit 1, and the error is the SENTENCE, "
   "not a traceback",
   (code, err["ok"], "1,000,000,000" in err["error"],
    "Traceback" in err["error"]), (1, False, True, False))

try:
    from PIL import Image
    src = np.zeros((32, 48, 4), np.uint8)
    src[..., 0] = np.arange(48)[None, :] * 5
    src[..., 1] = np.arange(32)[:, None] * 8
    src[..., 2] = 40
    src[..., 3] = 255
    inp = os.path.join(TMP, "in.png")
    outp = os.path.join(TMP, "out.png")
    Image.fromarray(src, "RGBA").save(inp)
    res, code = cli("apply", {"in": inp, "out": outp, "lut": SWAP.path,
                              "strength": 100})
    made = np.asarray(Image.open(outp).convert("RGBA"))
    eq("apply: the file is written, the size is reported, and the LUT's title "
       "rides back with it",
       (code, res["ok"], os.path.exists(outp), res["lut"]["title"],
        (res["width"], res["height"])),
       (0, True, True, "Swap G and B", (48, 32)))
    eq("...and the picture really is the green/blue swap, through the file, "
       "through PNG, at 8 bits",
       (int(made[10, 20, 0]), int(made[10, 20, 1]), int(made[10, 20, 2])),
       (int(src[10, 20, 0]), int(src[10, 20, 2]), int(src[10, 20, 1])))
    eq("...and the reply says, on every single apply, what it cannot know",
       "cannot tell you" in res["cannotKnow"], True)
    res, code = cli("apply", {"in": inp, "out": outp, "lut": IDENT33})
    made = np.asarray(Image.open(outp).convert("RGBA"))
    eq("an identity LUT through the whole door - PNG in, PNG out, 8 bits both "
       "ways - returns the file unchanged, every byte",
       (code, np.array_equal(made, src)), (0, True))
    res, code = cli("apply", {"in": inp, "lut": IDENT33})
    eq("apply with no `out` is refused with a sentence, exit 1",
       (code, res["ok"], "`in` and `out`" in res["error"]), (1, False, True))
except ImportError:
    print("  skip  the two apply cases need Pillow, which is not on this python")

res, code = cli("nonsense")
eq("an unknown mode is refused rather than doing something",
   (code, res["ok"]), (1, False))

# ---------------------------------------------------------------------------
print("\n  -- cost, per megapixel, on a 33-point cube --")

for name, ms in G._bench(33, 1.0, 2).items():
    if isinstance(ms, (int, float)) and name not in ("megapixels", "lutSize"):
        print(f"  {name:<24} {ms:8.1f} ms/MP")
print(f"  a 1344x768 H3 frame is 1.03 MP, so a clip costs about that per frame")

shutil.rmtree(TMP, ignore_errors=True)
print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
