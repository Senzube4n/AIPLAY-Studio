"""Unit tests for server/vfx/expressions.py and the additions to interp.py.

An expression is untrusted text that runs inside the render process, and a
motion path is the difference between a move that reads as animation and one
that reads as a slide. So the invariants here are of two kinds:

  SAFETY — every one of these must be a refusal, not a value: __import__, open,
  a dunder on a number, a lambda, a comprehension, an import, a string bomb, a
  huge power, a loop. And a cycle (A reads B reads A) must return in
  microseconds with a message rather than recursing until the stack gives out.

  BEHAVIOUR — wiggle that reproduces exactly on a re-render and never leaves
  its amplitude; loops that actually repeat and actually mirror; ramps that
  clamp and stay monotone; a spatial bezier that leaves the straight line by a
  measured amount while its no-tangent neighbour stays bit-identical; roving
  keys that equalise speed.

The last section measures what an expression costs per property per frame
against a single trivial 1080p pixel pass, because "expressions are supported"
is only true if you can afford to use one.

    D:/AI/aiplay-studio-bench/venv/Scripts/python.exe server/vfx/expressions_test.py

numpy only, and only for the cost comparison — nothing here needs a decoder.
"""
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from vfx import expressions, interp  # noqa: E402

PASS = FAIL = 0


def eq(name, got, want):
    global PASS, FAIL
    if got == want:
        PASS += 1
        print(f"  ok    {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}\n          got {got!r}, wanted {want!r}")


def comp(layers=None, fps=30.0, **extra):
    doc = {"v": 1, "id": "cmp_x", "slug": "x", "name": "Expressions",
           "width": 1920, "height": 1080, "fps": fps, "duration": 8.0,
           "layers": layers if layers is not None else []}
    doc.update(extra)
    return doc


def layer(lid, name=None, **over):
    lay = {"id": lid, "name": name or lid, "type": "solid", "start": 0.0, "end": 8.0,
           "transform": {"anchor": [0, 0], "position": [0, 0], "scale": [100, 100],
                         "rotation": 0, "opacity": 100}}
    lay.update(over)
    return lay


RAMP = [{"t": 0.0, "v": 0.0}, {"t": 1.0, "v": 10.0}]


class Fixture:
    """One comp, one env, and a shorthand for 'evaluate this expression'."""

    def __init__(self, layers=None, fps=30.0):
        self.comp = comp(layers if layers is not None else [layer("ly_a", "solo")], fps=fps)
        self.env = expressions.ExprEnv(self.comp)
        self.layer = self.comp["layers"][0]

    def ev(self, src, t=0.0, keys=None, value=None, path="transform.rotation"):
        prop = {"expr": src}
        if keys is not None:
            prop["keys"] = keys
        if value is not None:
            prop["value"] = value
        return interp.eval_prop(prop, t, None, self.env.bind(self.layer, path))

    def errors(self):
        return self.env.take_errors()


print("\nexpressions — the sandbox\n")

fx = Fixture()

# Each of these has to come back as the FALLBACK value, never as a result. The
# fallback is 7 so a leak would be visibly not-7.
REFUSED = [
    ("__import__", '__import__("os")'),
    ("open", 'open("secrets.txt")'),
    ("a dunder on a number", "(1).__class__"),
    ("a dunder on a list", "[].__class__"),
    ("the subclasses walk", "().__class__.__base__.__subclasses__()"),
    ("a dunder on the property's own value", "value.__class__"),
    ("a leading-underscore name", "_x + 1"),
    ("an import statement", "import os"),
    ("a lambda", "(lambda x: x)(1)"),
    ("a comprehension", "[i for i in [1,2]]"),
    ("a while loop", "while 1:\n    x = 1"),
    ("a for loop", "for i in [1]:\n    x = 1"),
    ("a function definition", "def f():\n    return 1"),
    ("eval by name", 'eval("1+1")'),
    ("exec by name", 'exec("x=1")'),
    ("getattr by name", 'getattr(value, "real")'),
    ("globals by name", "globals()"),
    ("a string bomb", '"a" * 999999999'),
    ("a power bomb", "9 ** 9999"),
    ("a dict literal", "{1: 2}"),
    ("an f-string", 'f"{value}"'),
    ("the walrus operator", "(x := 3)"),
    ("argument unpacking", "max(*[1, 2])"),
    ("an attribute on a function", "wiggle.func_globals"),
]
reported = 0
for label, src in REFUSED:
    solo = Fixture()                                 # its own log, so the
    eq(f"refused: {label}", solo.ev(src, value=7.0), 7.0)   # dedupe cannot hide one
    reported += len(solo.errors())
eq("every refusal reported exactly one message", reported, len(REFUSED))

# Deduping is not cosmetic: one broken expression on a 240-frame render would
# otherwise write 240 identical lines to stderr.
flood = Fixture()
for _ in range(240):
    flood.ev("open(1)", t=_ / 30.0, value=7.0)
eq("240 frames of the same fault report once", len(flood.errors()), 1)

# The two size budgets, which nothing legible ever reaches.
eq("an over-long source is refused", fx.ev("1 + " * 3000 + "1", value=7.0), 7.0)
eq("too many nodes is refused", fx.ev("1 + " * 300 + "1", value=7.0), 7.0)
msgs = fx.errors()
eq("the size refusals say which limit", len(msgs), 2)

# The list-repetition bomb is closed by arithmetic rather than by refusal: * on
# a vector is componentwise here, so [0] * 999999999 allocates one float.
eq("array times a number is componentwise, never repetition",
   fx.ev("[1, 2] * 999999999"), [999999999.0, 1999999998.0])
eq("that produced no error", fx.errors(), [])

# Refusal must not depend on the fallback existing.
eq("a refusal with no fallback is the default", fx.ev("open(1)", value=None), None)
fx.errors()

# A property with an expression but no ctx is EXACTLY today's behaviour.
eq("no ctx means the expression is ignored",
   interp.eval_prop({"expr": "9999", "keys": RAMP}, 0.5), 5.0)
eq("no ctx on an expression-only property returns its value",
   interp.eval_prop({"expr": "9999", "value": 3}, 0.5), 3.0)
eq("the three-argument call is untouched",
   interp.eval_prop({"keys": RAMP}, 0.5, 99), 5.0)

# Legal syntax, illegal semantics: still a fallback, still a message.
eq("an unknown name falls back", fx.ev("frobnicate(1)", value=7.0), 7.0)
eq("a malformed expression falls back", fx.ev("value +", value=7.0), 7.0)
eq("an empty expression falls back", fx.ev("   ", value=7.0), 7.0)
eq("a statement-only expression falls back", fx.ev("x = 1", value=7.0), 7.0)
eq("division by zero falls back", fx.ev("value / 0", value=7.0), 7.0)
eq("an out-of-range index falls back", fx.ev("value[5]", value=7.0), 7.0)
msgs = fx.errors()
eq("a syntax error says so", any("syntax error" in m for m in msgs), True)
eq("an unknown name is named", any("frobnicate" in m for m in msgs), True)


print("\nexpressions — the vocabulary\n")

fx = Fixture()
eq("time is comp time in seconds", fx.ev("time", t=2.5), 2.5)
eq("value is the keyframed value at that time", fx.ev("value", t=0.5, keys=RAMP), 5.0)
eq("value is the constant when there are no keys", fx.ev("value", value=42), 42.0)
eq("index is AE's 1-based layer index", fx.ev("index"), 1.0)
eq("value plus an offset composes", fx.ev("value + 3", t=0.5, keys=RAMP), 8.0)
eq("arrays add componentwise", fx.ev("value + [1, 2]", t=0.0, value=[10, 20]), [11.0, 22.0])
eq("arrays scale", fx.ev("value * 2", t=0.0, value=[10, 20]), [20.0, 40.0])
eq("a multi-line expression is its last value", fx.ev("a = 3\nb = 4\na * b"), 12.0)
eq("an if statement picks a branch",
   fx.ev("if time > 1:\n    100\nelse:\n    5", t=2.0), 100.0)
eq("JS comments and semicolons survive a paste",
   fx.ev("// drift\nvalue + 1; /* and back */", value=4), 5.0)
eq("JS true is a name here", fx.ev("1 if true else 2"), 1.0)

eq("degreesToRadians", round(fx.ev("degreesToRadians(180)"), 6), round(3.141592653589793, 6))
eq("radiansToDegrees", round(fx.ev("radiansToDegrees(3.141592653589793)"), 6), 180.0)
eq("timeToFrames uses the comp fps", fx.ev("timeToFrames(1.0)"), 30.0)
eq("framesToTime is its inverse", round(fx.ev("framesToTime(15)"), 6), 0.5)
eq("posterizeTime quantises time", fx.ev("posterizeTime(2)\ntime", t=1.7), 1.5)
eq("posterizeTime quantises value too",
   fx.ev("posterizeTime(2)\nvalue", t=0.7, keys=[{"t": 0.0, "v": 0.0}, {"t": 2.0, "v": 20.0}]),
   5.0)
eq("Math.PI is reachable", round(fx.ev("Math.PI"), 6), 3.141593)
eq("Math.sin is reachable", round(fx.ev("Math.sin(0)"), 6), 0.0)

# vector maths — argument order matters, so each one is pinned to a number
eq("add", fx.ev("add([1,2],[3,4])"), [4.0, 6.0])
eq("sub", fx.ev("sub([5,7],[1,2])"), [4.0, 5.0])
eq("mul", fx.ev("mul([2,3], 4)"), [8.0, 12.0])
eq("div", fx.ev("div([8,12], 4)"), [2.0, 3.0])
eq("length of a vector", fx.ev("length([3,4])"), 5.0)
eq("length of two points is the distance", fx.ev("length([1,1],[4,5])"), 5.0)
eq("normalize", fx.ev("normalize([0,5])"), [0.0, 1.0])
eq("dot", fx.ev("dot([1,2],[3,4])"), 11.0)
eq("cross of two 2-D vectors is the z", fx.ev("cross([1,0],[0,1])"), 1.0)
eq("cross of two 3-D vectors", fx.ev("cross([1,0,0],[0,1,0])"), [0.0, 0.0, 1.0])
eq("clamp inside the range", fx.ev("clamp(5, 0, 10)"), 5.0)
eq("clamp below", fx.ev("clamp(-5, 0, 10)"), 0.0)
eq("clamp above", fx.ev("clamp(50, 0, 10)"), 10.0)
eq("clamp works componentwise", fx.ev("clamp([-1, 50], 0, 10)"), [0.0, 10.0])
eq("the vocabulary raised nothing", fx.errors(), [])


print("\nexpressions — wiggle\n")

fx = Fixture()
a = fx.ev("wiggle(2, 30)", t=1.0, value=100.0)
b = fx.ev("wiggle(2, 30)", t=1.0, value=100.0)
eq("wiggle is deterministic within a render", a, b)
# A fresh env is a fresh render of the same document — it must agree.
eq("wiggle reproduces across renders", Fixture().ev("wiggle(2, 30)", t=1.0, value=100.0), a)
eq("wiggle actually moves", a != 100.0, True)
# AE's biggest gotcha: wiggle RETURNS the value wiggled, it does not return an
# offset to add. `value + wiggle(...)` doubles the value, which is why the
# idiom is a bare wiggle().
eq("wiggle returns the value wiggled, not an offset to add",
   abs(fx.ev("wiggle(2, 5)", t=1.0, value=100.0) - 100.0) <= 5.0 + 1e-9, True)

samples = [fx.ev("wiggle(2, 30)", t=i / 60.0, value=100.0) for i in range(240)]
eq("wiggle stays inside its amplitude",
   max(abs(s - 100.0) for s in samples) <= 30.0 + 1e-9, True)
eq("wiggle reaches most of its amplitude",
   max(abs(s - 100.0) for s in samples) > 15.0, True)
# The C1 lattice is the point: consecutive frames must not jump like noise.
steps = [abs(samples[i + 1] - samples[i]) for i in range(len(samples) - 1)]
eq("wiggle is smooth frame to frame", max(steps) < 30.0 * 0.25, True)

# Octaves add detail, and the bound grows by exactly the geometric series.
oct2 = [fx.ev("wiggle(2, 30, 2, 0.5)", t=i / 60.0, value=100.0) for i in range(240)]
eq("two octaves stay inside amp * (1 + amp_mult)",
   max(abs(s - 100.0) for s in oct2) <= 30.0 * 1.5 + 1e-9, True)

# Different properties on the same layer must not wiggle in lockstep.
rot = fx.ev("wiggle(2, 30)", t=1.0, value=100.0, path="transform.rotation")
opa = fx.ev("wiggle(2, 30)", t=1.0, value=100.0, path="transform.opacity")
eq("two properties wiggle independently", rot != opa, True)

two = Fixture([layer("ly_a", "a"), layer("ly_b", "b")])
va = interp.eval_prop({"expr": "wiggle(2, 30)", "value": 100.0}, 1.0, None,
                      two.env.bind(two.comp["layers"][0], "transform.position"))
vb = interp.eval_prop({"expr": "wiggle(2, 30)", "value": 100.0}, 1.0, None,
                      two.env.bind(two.comp["layers"][1], "transform.position"))
eq("two layers wiggle independently", va != vb, True)

vec = fx.ev("wiggle(2, 30)", t=1.0, value=[100.0, 200.0])
eq("a vector property wiggles per component", len(vec), 2)
eq("each component keeps its own base",
   abs(vec[0] - 100.0) <= 30.0 and abs(vec[1] - 200.0) <= 30.0, True)
eq("the components are not the same offset",
   abs((vec[0] - 100.0) - (vec[1] - 200.0)) > 1e-9, True)
eq("wiggle raised nothing", fx.errors(), [])


print("\nexpressions — random\n")

fx = Fixture()
draws = [fx.ev("random()", t=i / 30.0) for i in range(60)]
eq("random stays in 0..1", all(0.0 <= d < 1.0 for d in draws), True)
eq("random changes over time", len(set(draws)) > 50, True)
eq("random reproduces", Fixture().ev("random()", t=0.5), fx.ev("random()", t=0.5))
eq("random(max) scales", all(0.0 <= fx.ev("random(50)", t=i / 30.0) < 50.0 for i in range(20)),
   True)
eq("random(min, max) spans",
   all(10.0 <= fx.ev("random(10, 20)", t=i / 30.0) < 20.0 for i in range(20)), True)
eq("two draws in one expression differ", fx.ev("random() - random()") != 0.0, True)

timeless = [fx.ev("seedRandom(4, true)\nrandom(100)", t=i / 30.0) for i in range(20)]
eq("seedRandom timeless holds still over time", len(set(timeless)), 1)
seeded = [fx.ev(f"seedRandom({s}, true)\nrandom(100)") for s in (1, 2, 3)]
eq("a different seed is a different number", len(set(seeded)), 3)
moving = [fx.ev("seedRandom(4)\nrandom(100)", t=i / 30.0) for i in range(20)]
eq("seedRandom without timeless still moves", len(set(moving)) > 15, True)

g = [fx.ev("gaussRandom()", t=i / 30.0) for i in range(400)]
mean = sum(g) / len(g)
eq("gaussRandom centres on 0.5", abs(mean - 0.5) < 0.05, True)
eq("gaussRandom mostly lands in 0..1",
   0.80 < sum(1 for x in g if 0.0 <= x <= 1.0) / len(g) <= 1.0, True)
eq("random raised nothing", fx.errors(), [])


print("\nexpressions — interpolation helpers\n")

fx = Fixture()
eq("linear at the midpoint", fx.ev("linear(0.5, 0, 1, 0, 100)"), 50.0)
eq("linear clamps below tMin", fx.ev("linear(-5, 0, 1, 0, 100)"), 0.0)
eq("linear clamps above tMax", fx.ev("linear(5, 0, 1, 0, 100)"), 100.0)
eq("the three-argument form defaults tMin/tMax to 0/1",
   fx.ev("linear(0.25, 0, 100)"), 25.0)
eq("linear works on vectors", fx.ev("linear(0.5, 0, 1, [0,0], [10,20])"), [5.0, 10.0])
eq("a reversed range still ramps", fx.ev("linear(0.25, 1, 0, 0, 100)"), 75.0)
eq("a zero-width range below tMin is v1", fx.ev("linear(0.5, 1, 1, 0, 100)"), 0.0)
eq("a zero-width range at or past it is v2", fx.ev("linear(1.5, 1, 1, 0, 100)"), 100.0)

for name in ("ease", "easeIn", "easeOut"):
    eq(f"{name} clamps below", fx.ev(f"{name}(-1, 0, 1, 0, 100)"), 0.0)
    eq(f"{name} clamps above", fx.ev(f"{name}(9, 0, 1, 0, 100)"), 100.0)
    curve = [fx.ev(f"{name}({i / 40.0}, 0, 1, 0, 100)") for i in range(41)]
    eq(f"{name} hits both endpoints", (curve[0], curve[-1]), (0.0, 100.0))
    eq(f"{name} is monotone",
       all(curve[i + 1] >= curve[i] - 1e-9 for i in range(len(curve) - 1)), True)

# The three differ in WHERE they are flat, which is the whole point of having
# three of them.
eq("ease is flat at both ends",
   fx.ev("ease(0.02, 0, 1, 0, 100)") < 0.2 and fx.ev("ease(0.98, 0, 1, 0, 100)") > 99.8, True)
eq("easeIn is flat leaving tMin", fx.ev("easeIn(0.02, 0, 1, 0, 100)") < 0.2, True)
eq("easeIn is still moving at tMax", fx.ev("easeIn(0.98, 0, 1, 0, 100)") < 99.8, True)
eq("easeOut is flat arriving at tMax", fx.ev("easeOut(0.98, 0, 1, 0, 100)") > 99.8, True)
eq("easeOut is already moving at tMin", fx.ev("easeOut(0.02, 0, 1, 0, 100)") > 0.2, True)
eq("ease sits at the halfway value at the midpoint",
   round(fx.ev("ease(0.5, 0, 1, 0, 100)"), 6), 50.0)
eq("interpolation helpers raised nothing", fx.errors(), [])


print("\nexpressions — loops\n")

fx = Fixture()
SAW = [{"t": 0.0, "v": 0.0}, {"t": 1.0, "v": 10.0}]

eq("inside the keyed range loopOut is the keyed value",
   fx.ev('loopOut("cycle")', t=0.5, keys=SAW), 5.0)
eq("cycle repeats one span later", fx.ev('loopOut("cycle")', t=1.5, keys=SAW), 5.0)
eq("cycle repeats five spans later", fx.ev('loopOut("cycle")', t=5.5, keys=SAW), 5.0)
eq("cycle snaps back at the seam", fx.ev('loopOut("cycle")', t=2.0, keys=SAW), 0.0)

eq("pingpong mirrors on the odd cycle", fx.ev('loopOut("pingpong")', t=1.25, keys=SAW), 7.5)
eq("pingpong runs forward again on the even cycle",
   fx.ev('loopOut("pingpong")', t=2.25, keys=SAW), 2.5)
eq("pingpong is continuous at the turn",
   abs(fx.ev('loopOut("pingpong")', t=0.999, keys=SAW)
       - fx.ev('loopOut("pingpong")', t=1.001, keys=SAW)) < 0.05, True)

eq("offset accumulates one span", fx.ev('loopOut("offset")', t=1.5, keys=SAW), 15.0)
eq("offset accumulates two spans", fx.ev('loopOut("offset")', t=2.5, keys=SAW), 25.0)
eq("offset is continuous at the seam",
   round(fx.ev('loopOut("offset")', t=1.0, keys=SAW), 6), 10.0)

eq("continue keeps going at the outgoing speed",
   round(fx.ev('loopOut("continue")', t=2.0, keys=SAW), 4), 20.0)
eq("continue is flat after a flat exit",
   round(fx.ev('loopOut("continue")', t=5.0,
               keys=[{"t": 0.0, "v": 0.0}, {"t": 1.0, "v": 10.0, "ease": "hold"},
                     {"t": 2.0, "v": 10.0}]), 4), 10.0)

eq("loopIn cycles before the first key", fx.ev('loopIn("cycle")', t=-0.5, keys=SAW), 5.0)
# Reflected about the first key, so t=-0.25 is the mirror of t=+0.25.
eq("loopIn pingpongs before the first key",
   fx.ev('loopIn("pingpong")', t=-0.25, keys=SAW), 2.5)
eq("loopIn pingpong runs the segment backwards one span out",
   fx.ev('loopIn("pingpong")', t=-0.75, keys=SAW), 7.5)
eq("loopIn offsets downwards", fx.ev('loopIn("offset")', t=-0.5, keys=SAW), -5.0)
eq("loopIn continue extends backwards",
   round(fx.ev('loopIn("continue")', t=-1.0, keys=SAW), 4), -10.0)
eq("inside the range loopIn is the keyed value",
   fx.ev('loopIn("cycle")', t=0.5, keys=SAW), 5.0)

THREE = [{"t": 0.0, "v": 0.0}, {"t": 1.0, "v": 10.0}, {"t": 2.0, "v": 30.0}]
eq("numKeyframes limits cycle to the last segment",
   fx.ev('loopOut("cycle", 1)', t=2.5, keys=THREE), 20.0)
eq("numKeyframes 0 uses every key", fx.ev('loopOut("cycle", 0)', t=2.5, keys=THREE), 5.0)
eq("a single key cannot loop", fx.ev('loopOut("cycle")', t=5.0, keys=[{"t": 0.0, "v": 4.0}]),
   4.0)
eq("loops on vectors work",
   fx.ev('loopOut("cycle")', t=1.5,
         keys=[{"t": 0.0, "v": [0, 0]}, {"t": 1.0, "v": [10, 20]}]), [5.0, 10.0])
eq("loops raised nothing", fx.errors(), [])


print("\nexpressions — reading time and other properties\n")

fx = Fixture()
eq("valueAtTime reads the keyframed value", fx.ev("valueAtTime(0.25)", t=9.0, keys=SAW), 2.5)
eq("valueAtTime is independent of the sampling time",
   fx.ev("valueAtTime(0.25)", t=0.0, keys=SAW), fx.ev("valueAtTime(0.25)", t=7.0, keys=SAW))
eq("velocity of a ramp is its slope", round(fx.ev("velocity", t=0.5, keys=SAW), 4), 10.0)
eq("velocityAtTime agrees", round(fx.ev("velocityAtTime(0.5)", t=9.0, keys=SAW), 4), 10.0)
eq("speed is the magnitude", round(fx.ev("speed", t=0.5, keys=SAW), 4), 10.0)
eq("velocity outside the keys is zero", round(fx.ev("velocity", t=5.0, keys=SAW), 6), 0.0)
eq("velocity of a vector is a vector",
   [round(x, 4) for x in fx.ev("velocity", t=0.5,
                               keys=[{"t": 0.0, "v": [0, 0]}, {"t": 1.0, "v": [3, 4]}])],
   [3.0, 4.0])
eq("speed of that vector is its length",
   round(fx.ev("speed", t=0.5, keys=[{"t": 0.0, "v": [0, 0]}, {"t": 1.0, "v": [3, 4]}]), 4),
   5.0)
eq("numKeys counts the keyframes", fx.ev("numKeys", keys=THREE), 3.0)
eq("time helpers raised nothing", fx.errors(), [])


print("\nexpressions — property linking\n")

hero = layer("ly_hero", "hero", transform={"position": [640.0, 360.0], "rotation": 45.0,
                                           "opacity": 80.0, "scale": [50, 50],
                                           "anchor": [0, 0]},
             effects=[{"id": "fx_blur", "type": "gaussianBlur", "enabled": True,
                       "params": {"radius": 12.0}}])
shadow = layer("ly_shadow", "shadow")
link = Fixture([hero, shadow])
link.layer = shadow                                  # read FROM the shadow

eq("a linked position returns the other layer's value",
   link.ev('thisComp.layer("hero").transform.position'), [640.0, 360.0])
eq("AE's shorthand skips .transform",
   link.ev('thisComp.layer("hero").position'), [640.0, 360.0])
eq("a linked component indexes",
   link.ev('thisComp.layer("hero").position[0] + 10'), 650.0)
eq("a linked rotation is a number", link.ev('thisComp.layer("hero").rotation'), 45.0)
eq("a layer can be reached by index", link.ev("thisComp.layer(1).rotation"), 45.0)
eq("an effect parameter links",
   link.ev('thisComp.layer("hero").effect("fx_blur")("radius")'), 12.0)
eq("an effect can be named by its type",
   link.ev('thisComp.layer("hero").effect("gaussianBlur")("radius")'), 12.0)
eq("thisLayer names this layer", link.ev("thisLayer.name"), "shadow")
eq("a linked layer knows its index", link.ev('thisComp.layer("hero").index'), 1.0)
eq("thisComp exposes its size", link.ev("thisComp.width"), 1920.0)
eq("thisComp exposes frameDuration",
   round(link.ev("thisComp.frameDuration"), 6), round(1 / 30.0, 6))
eq("thisComp counts its layers", link.ev("thisComp.numLayers"), 2.0)
eq("linking raised nothing", link.errors(), [])

# A link reads the other property's OWN expression, evaluated at the same time.
chained = Fixture([
    layer("ly_1", "one", transform={"position": {"expr": "[100, 200]", "value": [0, 0]}}),
    layer("ly_2", "two"),
])
chained.layer = chained.comp["layers"][1]
eq("a link sees the other property's expression result",
   chained.ev('thisComp.layer("one").position'), [100.0, 200.0])

# A linked keyframed property is read AT THE SAME TIME as the reader.
timed = Fixture([
    layer("ly_1", "one", transform={"position": {"keys": [{"t": 0.0, "v": [0, 0]},
                                                          {"t": 2.0, "v": [200, 0]}]}}),
    layer("ly_2", "two"),
])
timed.layer = timed.comp["layers"][1]
eq("a linked keyframed property is read at the reader's time",
   timed.ev('thisComp.layer("one").position', t=1.0), [100.0, 0.0])
eq("valueAtTime on a link reads elsewhere in time",
   timed.ev('thisComp.layer("one").position.valueAtTime(0.5)', t=1.0), [50.0, 0.0])

# Missing things are refusals with names in them, not tracebacks.
eq("an unknown layer falls back", link.ev('thisComp.layer("ghost").position', value=7.0), 7.0)
eq("an unknown effect falls back",
   link.ev('thisComp.layer("hero").effect("nope")("radius")', value=7.0), 7.0)
eq("an unknown parameter falls back",
   link.ev('thisComp.layer("hero").effect("fx_blur")("wat")', value=7.0), 7.0)
msgs = link.errors()
eq("the missing layer is named", any("ghost" in m for m in msgs), True)

# THE cycle: A reads B, B reads A. Must answer in microseconds with a message.
cyc = Fixture([
    layer("ly_a", "a", transform={"position": {"expr": 'thisComp.layer("b").position',
                                               "value": [1, 1]}}),
    layer("ly_b", "b", transform={"position": {"expr": 'thisComp.layer("a").position',
                                               "value": [2, 2]}}),
])
started = time.perf_counter()
got = interp.eval_prop(cyc.comp["layers"][0]["transform"]["position"], 0.0, None,
                       cyc.env.bind(cyc.comp["layers"][0], "transform.position"))
elapsed = time.perf_counter() - started
eq("a cycle returns a value rather than hanging", isinstance(got, list), True)
eq("a cycle returns immediately", elapsed < 0.25, True)
msgs = cyc.errors()
eq("a cycle is reported as a cycle", any("cycle" in m for m in msgs), True)
eq("the cycle message names the property",
   any("transform.position" in m for m in msgs), True)

selfref = Fixture([layer("ly_a", "a", transform={
    "rotation": {"expr": "thisLayer.transform.rotation + 1", "value": 5.0}})])
started = time.perf_counter()
got = interp.eval_prop(selfref.comp["layers"][0]["transform"]["rotation"], 0.0, None,
                       selfref.env.bind(selfref.comp["layers"][0], "transform.rotation"))
eq("a self-reference is a cycle too", time.perf_counter() - started < 0.25, True)
eq("a self-reference is reported", any("cycle" in m for m in selfref.errors()), True)

# A chain that is long but not circular hits the depth cap, not the stack.
chain_layers = [layer(f"ly_{i}", f"L{i}", transform={
    "rotation": {"expr": f'thisComp.layer("L{i + 1}").rotation', "value": float(i)}})
    for i in range(24)]
chain_layers.append(layer("ly_24", "L24", transform={"rotation": 99.0}))
deep = Fixture(chain_layers)
started = time.perf_counter()
got = interp.eval_prop(chain_layers[0]["transform"]["rotation"], 0.0, None,
                       deep.env.bind(chain_layers[0], "transform.rotation"))
eq("a deep chain returns", isinstance(got, float), True)
eq("a deep chain returns quickly", time.perf_counter() - started < 0.5, True)
eq("the depth cap is reported", any("nests deeper" in m for m in deep.errors()), True)


# Fan-out, not depth: each layer reads the next one EIGHT times, so the depth
# cap alone would still let 8^8 evaluations through. The work budget is what
# turns this into a refusal instead of a hung render.
fan = [layer(f"ly_f{i}", f"F{i}", transform={"rotation": {
    "expr": " + ".join([f'thisComp.layer("F{i + 1}").rotation'] * 8), "value": 1.0}})
    for i in range(8)]
fan.append(layer("ly_f8", "F8", transform={"rotation": 1.0}))
bomb = Fixture(fan)
started = time.perf_counter()
got = interp.eval_prop(fan[0]["transform"]["rotation"], 0.0, None,
                       bomb.env.bind(fan[0], "transform.rotation"))
took = time.perf_counter() - started
eq("a fan-out bomb returns a number", isinstance(got, float), True)
eq("a fan-out bomb is refused in well under a second", took < 1.0, True)
eq("the work budget is what stopped it",
   any("nest of expressions" in m or "nests deeper" in m for m in bomb.errors()), True)


print("\ninterp — spatial motion paths\n")

STRAIGHT = {"keys": [{"t": 0.0, "v": [0, 0]}, {"t": 2.0, "v": [200, 0]}]}
CURVED = {"keys": [{"t": 0.0, "v": [0, 0], "to": [60, -80]},
                   {"t": 2.0, "v": [200, 0], "ti": [-60, -80]}]}

eq("a key with no tangents is bit-identical to the old lerp",
   interp.eval_prop(STRAIGHT, 1.0), [100.0, 0.0])
# Bit-identical, not close: the same floats the old lerp produced, which is
# what "purely additive" has to mean for a document written last week.
eq("every sample of an untangented track is the straight line",
   all(interp.eval_prop(STRAIGHT, 2 * i / 20.0)
       == [0.0 + (200.0 - 0.0) * ((2 * i / 20.0) / 2.0), 0.0] for i in range(21)), True)

curve = [interp.eval_prop(CURVED, 2 * i / 40.0) for i in range(41)]
deviation = max(abs(p[1]) for p in curve)
eq("a spatial bezier leaves the straight line", deviation > 40.0, True)
eq("and by no more than its handles allow", deviation < 80.0, True)
eq("the curve still starts on its first key", curve[0], [0.0, 0.0])
eq("the curve still ends on its last key",
   [round(v, 6) for v in curve[-1]], [200.0, 0.0])
eq("the curve is monotone in x",
   all(curve[i + 1][0] >= curve[i][0] - 1e-9 for i in range(len(curve) - 1)), True)

# Arc-length parameterisation is what makes the ease mean SPEED. An asymmetric
# pair of handles would otherwise sprint through the long half of the curve.
lopsided = {"keys": [{"t": 0.0, "v": [0, 0], "to": [150, 0]},
                     {"t": 2.0, "v": [200, 200], "ti": [0, -10]}]}
sp = interp.speed_graph(lopsided, samples=40)
eq("an even ease over a lopsided curve keeps speed even",
   (sp["max"] - min(sp["speed"][1:-1])) / max(1e-9, sp["mean"]) < 0.35, True)

eq("a one-sided tangent still curves",
   abs(interp.eval_prop({"keys": [{"t": 0.0, "v": [0, 0], "to": [0, -100]},
                                  {"t": 2.0, "v": [200, 0]}]}, 1.0)[1]) > 10.0, True)
eq("a zero tangent is the same as no tangent",
   interp.eval_prop({"keys": [{"t": 0.0, "v": [0, 0], "to": [0, 0]},
                              {"t": 2.0, "v": [200, 0], "ti": [0, 0]}]}, 1.0),
   [100.0, 0.0])
eq("a scalar track ignores tangents",
   interp.eval_prop({"keys": [{"t": 0.0, "v": 0, "to": [50, 50]},
                              {"t": 2.0, "v": 100}]}, 1.0), 50.0)
eq("easing still shapes the curve",
   interp.eval_prop({"keys": [{"t": 0.0, "v": [0, 0], "to": [60, -80], "ease": "hold"},
                              {"t": 2.0, "v": [200, 0], "ti": [-60, -80]}]}, 1.0),
   [0.0, 0.0])
eq("motion_path samples the whole track", len(interp.motion_path(CURVED, samples=16)), 17)
eq("motion_path on a scalar track is empty", interp.motion_path({"keys": SAW}), [])


print("\ninterp — roving keyframes and the speed graph\n")

ANCHORED = {"keys": [{"t": 0.0, "v": [0, 0]}, {"t": 1.0, "v": [10, 0]},
                     {"t": 2.0, "v": [100, 0]}]}
ROVING = {"keys": [{"t": 0.0, "v": [0, 0]}, {"t": 1.0, "v": [10, 0], "roving": True},
                   {"t": 2.0, "v": [100, 0]}]}

roved = interp.sorted_keys(ROVING)
eq("roving moves the interior key's time", round(roved[1]["t"], 6), 0.2)
eq("roving leaves the anchors alone", (roved[0]["t"], roved[2]["t"]), (0.0, 2.0))
eq("roving does not rewrite the document", ROVING["keys"][1]["t"], 1.0)

before = interp.speed_graph(ANCHORED, samples=40)["speed"][1:-1]
after = interp.speed_graph(ROVING, samples=40)["speed"][1:-1]
eq("an anchored key makes the speed lurch", (max(before) - min(before)) > 50.0, True)
eq("a roving key equalises the speed", (max(after) - min(after)) < 1e-6, True)
eq("the roved speed is the whole distance over the whole time",
   round(sum(after) / len(after), 4), 50.0)

eq("the first key can never rove",
   interp.sorted_keys({"keys": [{"t": 0.5, "v": [0, 0], "roving": True},
                                {"t": 1.0, "v": [10, 0]}]})[0]["t"], 0.5)
eq("two roving keys in a row both move",
   [round(k["t"], 4) for k in interp.sorted_keys(
       {"keys": [{"t": 0.0, "v": [0, 0]},
                 {"t": 0.1, "v": [10, 0], "roving": True},
                 {"t": 0.2, "v": [20, 0], "roving": True},
                 {"t": 3.0, "v": [30, 0]}]})],
   [0.0, 1.0, 2.0, 3.0])
eq("roving keys that share a value space out evenly",
   [round(k["t"], 4) for k in interp.sorted_keys(
       {"keys": [{"t": 0.0, "v": [0, 0]}, {"t": 0.1, "v": [0, 0], "roving": True},
                 {"t": 2.0, "v": [0, 0]}]})],
   [0.0, 1.0, 2.0])

graph = interp.speed_graph(ANCHORED, samples=8)
eq("the speed graph samples what it was asked for", len(graph["t"]), 9)
eq("the speed graph defaults to the keyed range", (graph["t"][0], graph["t"][-1]), (0.0, 2.0))
eq("the speed graph reports its peak", round(graph["max"], 4), 90.0)
eq("the speed graph marks the keyframes", graph["keys"], [0.0, 1.0, 2.0])
eq("speed_at agrees with the graph",
   round(interp.speed_at(ANCHORED, 1.5), 4), 90.0)
eq("velocity_at is componentwise",
   [round(x, 4) for x in interp.velocity_at(ANCHORED, 1.5)], [90.0, 0.0])
eq("a constant property has no speed", interp.speed_at({"keys": [{"t": 0.0, "v": 5}]}, 1.0), 0.0)


print("\ninterp — time remapping\n")

REMAP = {"id": "ly_v", "timeRemap": {"keys": [{"t": 0.0, "v": 0.0}, {"t": 2.0, "v": 4.0}]}}
eq("a layer without timeRemap remaps nothing", interp.time_remap({"id": "x"}, 1.0), None)
eq("has_time_remap says so", interp.has_time_remap({"id": "x"}), False)
eq("has_time_remap finds a track", interp.has_time_remap(REMAP), True)
eq("comp time maps to source time", interp.time_remap(REMAP, 1.0), 2.0)
eq("remapping runs at double speed here", interp.time_remap(REMAP, 0.5), 1.0)
eq("before the first key it holds", interp.time_remap(REMAP, -5.0), 0.0)
eq("after the last key it holds", interp.time_remap(REMAP, 99.0), 4.0)
eq("a negative source time is clamped to zero",
   interp.time_remap({"timeRemap": {"keys": [{"t": 0.0, "v": -3.0}, {"t": 1.0, "v": 1.0}]}}, 0.0),
   0.0)
eq("the source duration caps it", interp.time_remap(REMAP, 99.0, duration=2.5), 2.5)
eq("a remap can freeze on a frame",
   interp.time_remap({"timeRemap": {"keys": [{"t": 0.0, "v": 1.5, "ease": "hold"},
                                             {"t": 5.0, "v": 9.0}]}}, 2.0), 1.5)
eq("a remap can run backwards",
   interp.time_remap({"timeRemap": {"keys": [{"t": 0.0, "v": 4.0}, {"t": 2.0, "v": 0.0}]}}, 0.5),
   3.0)
remap_env = expressions.ExprEnv(comp([REMAP]))
eq("a remap takes an expression too",
   interp.time_remap({"id": "ly_v", "timeRemap": {"expr": "time * 2", "value": 0.0}}, 1.5,
                     ctx=remap_env.bind(REMAP, "timeRemap")), 3.0)
eq("remapping raised nothing", remap_env.take_errors(), [])


print("\ncost — an expression against a 1080p pixel pass\n")

# The denominator: ONE trivial full-frame operation on a 1080p RGBA layer. Not
# a whole frame — the cheapest thing the engine can possibly do per layer, so
# the ratio below is the pessimistic one.
frame = np.ones((1080, 1920, 4), dtype=np.float32)
np.multiply(frame, 0.5, out=frame)                    # warm the allocator
REPS_PX = 20
t0 = time.perf_counter()
for _ in range(REPS_PX):
    np.multiply(frame, 0.5, out=frame)
px_ms = (time.perf_counter() - t0) * 1000.0 / REPS_PX

bench = Fixture([layer("ly_a", "a"), layer("ly_b", "b")])
keyed = {"keys": [{"t": 0.0, "v": [0, 0]}, {"t": 2.0, "v": [200, 100]}]}
curved_prop = {"keys": [{"t": 0.0, "v": [0, 0], "to": [60, -80]},
                        {"t": 2.0, "v": [200, 100], "ti": [-60, -80]}]}
wig = {"expr": "wiggle(3, 40)", "keys": keyed["keys"]}
lin = {"expr": 'linear(time, 0, 2, [0,0], [200,100])', "value": [0, 0]}
linked = {"expr": 'thisComp.layer("a").position + [10, 10]', "value": [0, 0]}

binding = bench.env.bind(bench.comp["layers"][1], "transform.position")
bench.comp["layers"][0]["transform"]["position"] = keyed


def per_call_us(fn, reps=2000):
    fn()                                              # compile + cache warm
    t0 = time.perf_counter()
    for i in range(reps):
        fn(i / 30.0)
    return (time.perf_counter() - t0) * 1e6 / reps


plain_us = per_call_us(lambda t=0.0: interp.eval_prop(keyed, t))
curve_us = per_call_us(lambda t=0.0: interp.eval_prop(curved_prop, t))
wig_us = per_call_us(lambda t=0.0: interp.eval_prop(wig, t, None, binding))
lin_us = per_call_us(lambda t=0.0: interp.eval_prop(lin, t, None, binding))
link_us = per_call_us(lambda t=0.0: interp.eval_prop(linked, t, None, binding))

print(f"  MEASURE  one trivial 1080p RGBA pass ......... {px_ms:8.3f} ms")
for label, us in (("plain keyframe", plain_us), ("spatial bezier key", curve_us),
                  ("linear() expression", lin_us), ("wiggle() expression", wig_us),
                  ("linked-property expression", link_us)):
    print(f"  MEASURE  {label:.<30} {us:8.2f} us   "
          f"({us / 1000.0 / px_ms * 100:5.2f}% of that pass, "
          f"{us / max(plain_us, 1e-9):5.1f}x a plain key)")

worst_us = max(wig_us, lin_us, link_us)
# Six animated properties is a busy layer (five transform rows plus an effect
# param). Even with all six carrying expressions, the whole set has to cost less
# than ONE trivial full-frame multiply — and a real 1080p layer is dozens of
# those plus a warp, so this is the pessimistic comparison.
eq("an expression costs well under a millisecond", worst_us < 500.0, True)
eq("six expressions on a layer cost less than one 1080p pixel pass",
   (worst_us * 6) / 1000.0 < px_ms, True)
eq("a spatial key costs no more than twice a plain one",
   curve_us < plain_us * 2.0 + 5.0, True)
eq("the cost measurement did not silently fall back", bench.errors(), [])

print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
